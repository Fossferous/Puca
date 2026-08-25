use crate::state::{AppState, UserId};
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use chrono::Utc;
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use srp::groups::G_2048;
use std::sync::Arc;

// Re-export for use in handlers
#[allow(dead_code)]
pub type SrpGroup = G_2048;

/// JWT claims structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: UserId, // User ID
    pub username: String,
    pub exp: i64, // Expiration timestamp
    /// Token version (M1 revocation). Compared against users.token_version on
    /// every authenticated request; a mismatch rejects the token. `#[serde(default)]`
    /// so pre-migration tokens (no `tv`) decode as 0 and keep working until a
    /// revocation event bumps the user's counter.
    #[serde(default)]
    pub tv: i32,
    /// Session start (unix seconds) — when the user last actually
    /// authenticated. Preserved across sliding renewals so a session can only
    /// slide for `MAX_SESSION_DAYS` before real re-authentication is required.
    /// `#[serde(default)]`: tokens minted before this claim existed decode as
    /// 0 and start their clock at first renewal rather than being refused.
    #[serde(default)]
    pub sst: i64,
}

/// Lifetime of a freshly minted token.
pub const TOKEN_TTL_HOURS: i64 = 24;
/// Renew once the token is past halfway through its life. Any authenticated
/// request in that window silently extends the session.
const RENEW_WHEN_REMAINING_HOURS: i64 = 12;
/// A sliding session still ends: after this long since the user actually
/// signed in, renewal stops and they must authenticate again.
const MAX_SESSION_DAYS: i64 = 30;
/// Response header carrying a renewed token. Must be in the CORS
/// `expose_headers` list or browsers can't read it cross-origin.
pub const RENEWED_TOKEN_HEADER: &str = "x-renewed-token";

/// Mint a replacement token when the current one is running out, so users stop
/// being dumped at the login screen every 24 h.
///
/// Safe against the obvious abuse: this runs only AFTER the caller's token has
/// been validated and its `tv` matched against the live `users.token_version`,
/// and the new token carries that same `tv` — so anything that bumps that
/// counter kills every renewed token instantly. NOTE that in-app "Sign out" is
/// deliberately local-only: `token_version` is per-USER with no per-session
/// claim, so revoking there would sign the user out on every other device too.
/// Account-wide revocation is therefore a password change or recovery reset
/// (both bump it). `sst` bounds how long a stolen-but-unrevoked token can keep
/// renewing itself in the meantime.
pub fn renew_if_stale(claims: &Claims, secret: &str) -> Option<String> {
    let now = Utc::now().timestamp();
    if claims.exp - now > RENEW_WHEN_REMAINING_HOURS * 3600 {
        return None; // plenty of life left
    }
    let started = if claims.sst > 0 { claims.sst } else { now };
    if now - started > MAX_SESSION_DAYS * 86_400 {
        return None; // session too old to slide — require a real sign-in
    }
    crate::ws::create_token_with_start(claims.sub, &claims.username, claims.tv, started, secret)
        .ok()
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub salt: String,     // Hex encoded
    pub verifier: String, // Hex encoded
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct LoginStartRequest {
    pub username: String,
    pub a_pub: String, // Hex encoded
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct LoginStartResponse {
    pub salt: String,  // Hex encoded
    pub b_pub: String, // Hex encoded
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct LoginFinishRequest {
    pub username: String,
    pub m1: String, // Hex encoded
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct LoginFinishResponse {
    pub m2: String, // Hex encoded
    pub session_token: String,
}

// Helper to decode hex
#[allow(dead_code)]
pub fn decode_hex(s: &str) -> anyhow::Result<Vec<u8>> {
    hex::decode(s).map_err(|e| anyhow::anyhow!("Hex decode error: {}", e))
}

// Helper to encode hex
#[allow(dead_code)]
pub fn encode_hex(b: &[u8]) -> String {
    hex::encode(b)
}

/// Validate JWT token and extract claims
pub fn validate_token(token: &str, secret: &str) -> Result<Claims, String> {
    let key = DecodingKey::from_secret(secret.as_bytes());
    let validation = Validation::default();

    decode::<Claims>(token, &key, &validation)
        .map(|data| data.claims)
        .map_err(|e| format!("Token validation failed: {}", e))
}

/// JWT Auth middleware - extracts claims from Authorization header and adds to request extensions
pub async fn jwt_auth_middleware(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // Get Authorization header
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok());

    let token = match auth_header {
        Some(header) if header.starts_with("Bearer ") => &header[7..],
        _ => return Err(StatusCode::UNAUTHORIZED),
    };

    // Validate token
    let claims = validate_token(token, &state.jwt_secret).map_err(|_| StatusCode::UNAUTHORIZED)?;

    // M1 revocation: reject a token whose `tv` no longer matches the user's
    // current token_version (bumped on logout / password change / recovery
    // reset), and reject tokens for a user that no longer exists.
    let current_tv: Option<(i32,)> =
        sqlx::query_as("SELECT token_version FROM users WHERE id = $1")
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    match current_tv {
        Some((tv,)) if tv == claims.tv => {}
        _ => return Err(StatusCode::UNAUTHORIZED),
    }

    // Sliding session: hand back a fresh token once this one is past halfway.
    // Computed before `claims` moves into the extensions.
    let renewed = renew_if_stale(&claims, &state.jwt_secret);
    let user_id = claims.sub;

    // Add claims to request extensions
    request.extensions_mut().insert(claims);

    let mut response = next.run(request).await;
    if let Some(token) = renewed {
        if let Ok(value) = header::HeaderValue::from_str(&token) {
            response.headers_mut().insert(RENEWED_TOKEN_HEADER, value);
            // This response now carries a bearer credential. Forbid ANY shared
            // cache (CDN, proxy, browser) from storing it — a cached copy would
            // hand one user's session token to whoever got the cache hit.
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("no-store, private"),
            );
            // Operationally important: this is what stops sessions dying at
            // 24 h. No token material is logged — just that it happened.
            tracing::info!("issued a renewed session token for user {}", user_id);
        }
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret-for-renewal-rules";

    fn claims_with(exp_offset_secs: i64, sst: i64) -> Claims {
        Claims {
            sub: 7,
            username: "tester".to_string(),
            exp: Utc::now().timestamp() + exp_offset_secs,
            tv: 3,
            sst,
        }
    }

    #[test]
    fn does_not_renew_while_plenty_of_life_remains() {
        // Freshly issued (24h left) — renewing on every request would mint a
        // JWT per call for no benefit.
        let c = claims_with(TOKEN_TTL_HOURS * 3600, Utc::now().timestamp());
        assert!(renew_if_stale(&c, SECRET).is_none());
    }

    #[test]
    fn renews_once_past_halfway() {
        // 1h left: without this the session dies and the user is dumped at the
        // login screen — the whole bug this fixes.
        let now = Utc::now().timestamp();
        let c = claims_with(3600, now);
        let renewed = renew_if_stale(&c, SECRET).expect("should renew");
        let out = validate_token(&renewed, SECRET).expect("renewed token must verify");
        assert_eq!(out.sub, c.sub);
        assert_eq!(out.tv, c.tv, "revocation counter must carry over");
        assert_eq!(
            out.sst, now,
            "session start must NOT reset, or the cap never bites"
        );
        assert!(out.exp > c.exp, "renewal must actually extend expiry");
    }

    #[test]
    fn stops_renewing_past_the_absolute_session_cap() {
        // Slid for longer than MAX_SESSION_DAYS: require a real sign-in, so a
        // stolen-but-unrevoked token can't renew itself forever.
        let old_start = Utc::now().timestamp() - (MAX_SESSION_DAYS * 86_400 + 60);
        let c = claims_with(3600, old_start);
        assert!(renew_if_stale(&c, SECRET).is_none());
    }

    #[test]
    fn legacy_token_without_sst_starts_its_clock_now() {
        // Tokens minted before the `sst` claim existed decode as 0. They must
        // renew (not be locked out) AND come back stamped, so the cap applies
        // from here rather than never.
        let c = claims_with(3600, 0);
        let renewed = renew_if_stale(&c, SECRET).expect("legacy token should renew");
        let out = validate_token(&renewed, SECRET).unwrap();
        assert!(out.sst > 0, "renewal must stamp a session start");
    }

    #[test]
    fn expired_tokens_are_rejected_before_renewal_is_ever_considered() {
        // Defence in depth: renew_if_stale is only reached AFTER validate_token
        // in the middleware, so an already-expired token can never be slid
        // forward — it must fail validation outright. (Well past the 60 s
        // clock-skew leeway jsonwebtoken's Validation::default() allows.)
        let c = claims_with(-3600, Utc::now().timestamp() - 7200);
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &c,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        assert!(
            validate_token(&token, SECRET).is_err(),
            "expired token must not validate"
        );
    }
}
