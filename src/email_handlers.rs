//! Email-related API handlers for verification and password reset

use axum::{
    extract::{Json, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::sync::Arc;

use crate::email::generate_token;
use crate::state::AppState;

// --- DTOs ---

#[derive(Deserialize)]
pub struct SendVerificationRequest {
    pub email: String,
}

#[derive(Deserialize)]
pub struct ForgotPasswordRequest {
    pub email: String,
}

#[derive(Deserialize)]
pub struct ResetPasswordRequest {
    pub token: String,
    pub username: String,
    pub salt: String,
    pub verifier: String,
}

#[derive(Serialize)]
pub struct MessageResponse {
    pub message: String,
}

#[derive(Deserialize)]
pub struct VerifyTokenQuery {
    pub token: String,
}

// --- Handlers ---

/// Send email verification (for logged-in users adding email)
pub async fn send_verification_email(
    State(state): State<Arc<AppState>>,
    axum::Extension(claims): axum::Extension<crate::auth::Claims>,
    Json(payload): Json<SendVerificationRequest>,
) -> impl IntoResponse {
    let email_service = match &state.email_service {
        Some(svc) => svc,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(MessageResponse {
                    message: "Email service not configured".to_string(),
                }),
            )
        }
    };

    // Get user info
    let user = match sqlx::query("SELECT id, username FROM users WHERE id = $1")
        .bind(claims.sub as i32)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(u)) => u,
        _ => {
            return (
                StatusCode::NOT_FOUND,
                Json(MessageResponse {
                    message: "User not found".to_string(),
                }),
            )
        }
    };

    let username: String = user.get("username");

    // Minimal shape check before anything is stored or sent. Not full RFC 5322
    // — just enough to refuse the obvious typo ('b@', empty, no '@') instead of
    // handing it to the mailer.
    let email = payload.email.trim();
    let valid_shape = matches!(email.split_once('@'),
        Some((local, domain)) if !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.'))
        && email.len() <= 254
        && !email.contains(char::is_whitespace);
    if !valid_shape {
        return (
            StatusCode::BAD_REQUEST,
            Json(MessageResponse {
                message: "That doesn't look like an email address".to_string(),
            }),
        );
    }

    // Rate limit outbound verification mail, per SENDER and per TARGET address.
    // The route is authenticated but the destination is caller-chosen, so
    // without this an account could mail-bomb any victim's inbox (or use the
    // relay as a spam cannon) — the per-IP API limiter does not bound per-target
    // volume. There is no created_at column, but expires_at is set to now+24h at
    // insert, so `expires_at > NOW() + INTERVAL '23 hours'` counts tokens minted
    // in the last hour. Best-effort (a failed count opens the gate rather than
    // blocking a legitimate user).
    const MAX_PER_USER_PER_HOUR: i64 = 5;
    const MAX_PER_ADDRESS_PER_HOUR: i64 = 3;
    let recent_user: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM email_verification_tokens \
         WHERE user_id = $1 AND expires_at > NOW() + INTERVAL '23 hours'",
    )
    .bind(claims.sub as i32)
    .fetch_one(&state.pool)
    .await
    .unwrap_or((0,));
    let recent_addr: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM email_verification_tokens \
         WHERE pending_email = $1 AND expires_at > NOW() + INTERVAL '23 hours'",
    )
    .bind(email)
    .fetch_one(&state.pool)
    .await
    .unwrap_or((0,));
    if recent_user.0 >= MAX_PER_USER_PER_HOUR || recent_addr.0 >= MAX_PER_ADDRESS_PER_HOUR {
        tracing::warn!(
            "verification-email throttle hit: user {} (recent {}), addr recent {}",
            claims.sub,
            recent_user.0,
            recent_addr.0
        );
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(MessageResponse {
                message: "Too many verification emails were just requested. Please wait a while and try again.".to_string(),
            }),
        );
    }

    // The address rides on the TOKEN, not on users.email. The old flow wrote
    // users.email (and cleared email_verified) before attempting the send, so a
    // typo'd address or a down SMTP relay destroyed the previous verified email
    // while the error message implied nothing had changed. users.email is now
    // only rewritten in verify_email, when the new address has proven it can
    // receive mail.
    let token = generate_token();
    let expires_at = Utc::now() + Duration::hours(24);

    if let Err(e) = sqlx::query(
        // Digest at rest, like password_reset_tokens: the mail carries the token.
        "INSERT INTO email_verification_tokens (user_id, token, expires_at, pending_email) VALUES ($1, $2, $3, $4)"
    )
        .bind(claims.sub as i32)
        .bind(reset_token_digest(&token))
        .bind(expires_at.naive_utc())
        .bind(email)
        .execute(&state.pool)
        .await
    {
        tracing::error!("Failed to create verification token: {:?}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(MessageResponse {
                message: "Failed to create verification token".to_string(),
            }),
        );
    }

    // Send email
    if let Err(e) = email_service
        .send_verification_email(email, &username, &token)
        .await
    {
        tracing::error!("Failed to send verification email: {}", e);
        // The token is useless if its mail never went out; reap it so a failed
        // attempt leaves no live credential lying around.
        let _ = sqlx::query("DELETE FROM email_verification_tokens WHERE token = $1")
            .bind(reset_token_digest(&token))
            .execute(&state.pool)
            .await;
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(MessageResponse {
                message: "Failed to send verification email".to_string(),
            }),
        );
    }

    (
        StatusCode::OK,
        Json(MessageResponse {
            message: "Verification email sent — your current email stays active until you confirm the new one.".to_string(),
        }),
    )
}

/// Verify email with token
pub async fn verify_email(
    State(state): State<Arc<AppState>>,
    Query(query): Query<VerifyTokenQuery>,
) -> impl IntoResponse {
    // Find token
    let token_record = match sqlx::query(
        "SELECT user_id, expires_at, pending_email FROM email_verification_tokens WHERE token = $1",
    )
    .bind(reset_token_digest(&query.token))
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(t)) => t,
        Ok(None) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(MessageResponse {
                    message: "Invalid or expired token".to_string(),
                }),
            )
        }
        Err(e) => {
            tracing::error!("Database error: {:?}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(MessageResponse {
                    message: "Database error".to_string(),
                }),
            );
        }
    };

    let user_id: i32 = token_record.get("user_id");
    let expires_at: chrono::NaiveDateTime = token_record.get("expires_at");
    let pending_email: Option<String> = token_record.get("pending_email");

    // Check expiry
    if expires_at < Utc::now().naive_utc() {
        return (
            StatusCode::BAD_REQUEST,
            Json(MessageResponse {
                message: "Token has expired".to_string(),
            }),
        );
    }

    // Mark email as verified — and, for tokens carrying a pending address
    // (every token minted since the change-email fix), install that address
    // NOW. This is the only place users.email changes, so the old verified
    // address survives any number of failed or abandoned change attempts.
    // Legacy tokens (NULL pending_email) predate the column and just flip the
    // verified bit, exactly as before.
    // deleted_at IS NULL: this endpoint is unauthenticated, so the tombstone's
    // token_version bump cannot gate it. Without the guard, a token minted just
    // before account deletion re-installs a live, verified email on the
    // anonymised row (email was set to NULL), making the tombstone reachable
    // again through the forgot-password lookup. delete_account also purges
    // these tokens now; this is the belt to that braces.
    let result = match &pending_email {
        Some(addr) => {
            sqlx::query(
                "UPDATE users SET email = $1, email_verified = true, email_verified_at = $2 WHERE id = $3 AND deleted_at IS NULL"
            )
                .bind(addr)
                .bind(Utc::now().naive_utc())
                .bind(user_id)
                .execute(&state.pool)
                .await
        }
        None => {
            sqlx::query(
                "UPDATE users SET email_verified = true, email_verified_at = $1 WHERE id = $2 AND deleted_at IS NULL"
            )
                .bind(Utc::now().naive_utc())
                .bind(user_id)
                .execute(&state.pool)
                .await
        }
    };
    if let Err(e) = result {
        tracing::error!("Failed to verify email: {:?}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(MessageResponse {
                message: "Failed to verify email".to_string(),
            }),
        );
    }

    // Delete used token
    let _ = sqlx::query("DELETE FROM email_verification_tokens WHERE token = $1")
        .bind(reset_token_digest(&query.token))
        .execute(&state.pool)
        .await;

    (
        StatusCode::OK,
        Json(MessageResponse {
            message: "Email verified successfully".to_string(),
        }),
    )
}

/// Request password reset
pub async fn forgot_password(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ForgotPasswordRequest>,
) -> impl IntoResponse {
    let email_service = match &state.email_service {
        Some(svc) => svc,
        None => {
            // Still return success to prevent email enumeration
            return (
                StatusCode::OK,
                Json(MessageResponse {
                    message: "If an account exists with that email, a reset link has been sent"
                        .to_string(),
                }),
            );
        }
    };

    // Find user by email (don't reveal if email exists)
    let user =
        sqlx::query("SELECT id, username FROM users WHERE email = $1 AND email_verified = true")
            .bind(&payload.email)
            .fetch_optional(&state.pool)
            .await;

    if let Ok(Some(user)) = user {
        let user_id: i32 = user.get("id");
        let username: String = user.get("username");

        // Per-account throttle so this UNAUTHENTICATED endpoint can't be used to
        // mail-bomb a registered victim (the per-IP limiter doesn't bound
        // per-target volume). The token TTL is 1h, so any not-yet-time-expired
        // row (used or not) was minted within the hour — count them as the
        // recent-send tally. We still return the same generic success below
        // either way, preserving email-enumeration resistance.
        const MAX_RESETS_PER_HOUR: i64 = 3;
        let recent: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM password_reset_tokens WHERE user_id = $1 AND expires_at > NOW()",
        )
        .bind(user_id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or((0,));

        if recent.0 < MAX_RESETS_PER_HOUR {
            // Invalidate any prior UNUSED token first, so reissuing never leaves
            // several live reset credentials for one account (finding: tokens
            // were not invalidated on reissue).
            let _ = sqlx::query(
                "UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false",
            )
            .bind(user_id)
            .execute(&state.pool)
            .await;

            // Generate and store the new reset token.
            let token = generate_token();
            let expires_at = Utc::now() + Duration::hours(1);

            // Stored as a digest: a database dump must not be a password-reset
            // kit. The email carries the token; the row can only recognise it.
            if let Ok(_) = sqlx::query(
                "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
            )
            .bind(user_id)
            .bind(reset_token_digest(&token))
            .bind(expires_at.naive_utc())
            .execute(&state.pool)
            .await
            {
                // Send email (ignore errors to prevent enumeration)
                let _ = email_service
                    .send_password_reset_email(&payload.email, &username, &token)
                    .await;
            }
        } else {
            tracing::warn!("password-reset throttle hit for user {}", user_id);
        }
    }

    // Always return success to prevent email enumeration
    (
        StatusCode::OK,
        Json(MessageResponse {
            message: "If an account exists with that email, a reset link has been sent".to_string(),
        }),
    )
}

/// Reset password with token
pub async fn reset_password(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ResetPasswordRequest>,
) -> impl IntoResponse {
    // Find token
    let token_record = match sqlx::query(
        "SELECT user_id, expires_at, used FROM password_reset_tokens WHERE token = $1",
    )
    .bind(reset_token_digest(&payload.token))
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(t)) => t,
        Ok(None) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(MessageResponse {
                    message: "Invalid or expired token".to_string(),
                }),
            )
        }
        Err(e) => {
            tracing::error!("Database error: {:?}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(MessageResponse {
                    message: "Database error".to_string(),
                }),
            );
        }
    };

    let user_id: i32 = token_record.get("user_id");
    let expires_at: chrono::NaiveDateTime = token_record.get("expires_at");
    let used: bool = token_record.try_get("used").unwrap_or(false);

    // Check if used
    if used {
        return (
            StatusCode::BAD_REQUEST,
            Json(MessageResponse {
                message: "Token has already been used".to_string(),
            }),
        );
    }

    // Check expiry
    if expires_at < Utc::now().naive_utc() {
        return (
            StatusCode::BAD_REQUEST,
            Json(MessageResponse {
                message: "Token has expired".to_string(),
            }),
        );
    }

    // Verify username matches the token's user
    let user = match sqlx::query("SELECT username, key_version FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(u)) => u,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(MessageResponse {
                    message: "Invalid request".to_string(),
                }),
            )
        }
    };

    let db_username: String = user.get("username");
    if db_username != payload.username {
        return (
            StatusCode::BAD_REQUEST,
            Json(MessageResponse {
                message: "Invalid request".to_string(),
            }),
        );
    }

    // H5: this handler only rewrites salt+verifier — it never rewraps
    // seed_wrapped_pw. For a v3 (E2EE) account the identity seed stays wrapped
    // under the OLD password, so after the reset the next login's seed-unwrap
    // fails, the identity is never restored, and all encrypted history becomes
    // permanently unreadable. Refuse and direct the user to the recovery-code
    // flow (/auth/recovery/*), which DOES rewrap the seed. Mirrors the
    // deliberately disabled migration reset in handlers.rs::reset_password.
    let key_version: i32 = user.try_get("key_version").unwrap_or(2);
    if key_version >= 3 {
        tracing::warn!(
            "Blocked email password reset for v3 account {} (would brick E2EE identity); directing to recovery-code flow",
            db_username
        );
        return (
            StatusCode::BAD_REQUEST,
            Json(MessageResponse {
                message: "This account uses end-to-end encryption, so an email password reset would make your existing messages permanently unreadable. Use your 12-word recovery code to reset instead.".to_string(),
            }),
        );
    }

    // Decode new SRP credentials
    let salt = match hex::decode(&payload.salt) {
        Ok(s) => s,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(MessageResponse {
                    message: "Invalid salt format".to_string(),
                }),
            )
        }
    };

    let verifier = match hex::decode(&payload.verifier) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(MessageResponse {
                    message: "Invalid verifier format".to_string(),
                }),
            )
        }
    };

    // Update password (salt + verifier), and REVOKE outstanding sessions.
    // A password reset is the "someone else is in my account" action, so it
    // must invalidate their tokens: without the token_version bump an
    // attacker's JWT kept working, and sliding renewal let it renew itself
    // well past its 24h TTL. Every other credential-rewriting path
    // (change_password, recovery_reset) already does both halves.
    if let Err(e) = sqlx::query(
        "UPDATE users SET salt = $1, verifier = $2, token_version = token_version + 1 WHERE id = $3"
    )
        .bind(&salt)
        .bind(&verifier)
        .bind(user_id)
        .execute(&state.pool)
        .await
    {
        tracing::error!("Failed to update password: {:?}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(MessageResponse {
                message: "Failed to reset password".to_string(),
            }),
        );
    }

    // Mark token as used
    let _ = sqlx::query("UPDATE password_reset_tokens SET used = true WHERE token = $1")
        .bind(reset_token_digest(&payload.token))
        .execute(&state.pool)
        .await;

    // The token_version bump stops NEW requests; this hangs up sockets that are
    // already established (they are only re-checked at upgrade time).
    state.disconnect_user(user_id as i64);

    tracing::info!("Password reset successful for user {}", db_username);

    (
        StatusCode::OK,
        Json(MessageResponse {
            message: "Password reset successfully".to_string(),
        }),
    )
}

/// What the database keeps of a reset token: SHA-256, hex. Rows written
/// before 0.9.1 held the token itself; they never match a digest lookup and
/// expire within the hour on their own.
pub(crate) fn reset_token_digest(token: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(token.trim().as_bytes()))
}

#[cfg(test)]
mod reset_token_digest_tests {
    use super::reset_token_digest;

    #[test]
    fn the_row_never_holds_the_token_and_the_digest_is_what_a_lookup_needs() {
        let token = "3f9a1c7e5b2d8046a9e1f3c5d7b9a0e2";
        let d = reset_token_digest(&token);
        assert_ne!(d, token);
        assert_eq!(d.len(), 64);
        assert_eq!(d, reset_token_digest(&token), "deterministic, so the lookup finds the row");
        assert_ne!(d, reset_token_digest("3f9a1c7e5b2d8046a9e1f3c5d7b9a0e3"));
    }
}

/// Check if a reset token is valid (for frontend validation)
pub async fn validate_reset_token(
    State(state): State<Arc<AppState>>,
    Query(query): Query<VerifyTokenQuery>,
) -> impl IntoResponse {
    let token_record = match sqlx::query(
        r#"SELECT t.user_id, t.expires_at, t.used, u.username
           FROM password_reset_tokens t 
           JOIN users u ON u.id = t.user_id
           WHERE t.token = $1"#,
    )
    .bind(reset_token_digest(&query.token))
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(t)) => t,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "valid": false, "message": "Invalid token" })),
            )
        }
    };

    let used: bool = token_record.try_get("used").unwrap_or(false);
    let expires_at: chrono::NaiveDateTime = token_record.get("expires_at");
    let username: String = token_record.get("username");

    if used {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "valid": false, "message": "Token already used" })),
        );
    }

    if expires_at < Utc::now().naive_utc() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "valid": false, "message": "Token expired" })),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "valid": true,
            "username": username
        })),
    )
}
