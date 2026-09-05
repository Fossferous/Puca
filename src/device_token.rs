//! A device proving it is itself, in exchange for a short session.
//!
//! WHY THIS ROUTE HAD TO EXIST. Every other token in this system is minted after
//! a human proves a password through SRP. That is right for people and useless
//! for a machine sitting at its own Windows sign-in screen: nobody is there to
//! type anything, and the copy of the owner's token it was given when it was
//! enrolled is not a durable credential. `validate_token` runs BEFORE
//! `renew_if_stale`, so an EXPIRED token can never be renewed — and renewal is
//! bounded anyway by `MAX_SESSION_DAYS` from the original sign-in, which is
//! preserved across every renewal.
//!
//! So a machine switched off for longer than that comes back holding a
//! credential it cannot repair, and is unreachable exactly when someone wanted
//! to reach it. "Even if it's been off for a while" is the whole point of the
//! feature, and it is the one requirement no amount of client work can satisfy.
//!
//! WHAT A DEVICE PROVES HERE. It signs a server-issued nonce with the Ed25519
//! key it enrolled, using the SAME transcript the WebSocket attestation already
//! uses — one signing format for one meaning, rather than a second one that
//! could drift. Possession of that key is what the account already treats as
//! "this is that device".
//!
//! WHAT IT DOES NOT PROVE, and why the token is short. This is a key sitting on
//! a disk, not a person. It cannot be revoked by a password change the way a
//! session can, so the token it buys lives for an hour rather than a day and
//! carries the user's CURRENT `token_version` — revoking the account still kills
//! it at the next request, and deleting the device row stops it being reissued.
//!
//! THE NONCE IS SERVER-ISSUED AND SINGLE-USE. A self-signed timestamp would be
//! replayable by anyone who saw it inside the acceptance window, and that window
//! has to be generous enough to tolerate a machine whose clock has drifted while
//! it was switched off — which is precisely the machine this serves.

use crate::auth::Claims;
use crate::state::UserId;
use crate::state::AppState;
use std::sync::Arc;
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a device token lives.
///
/// SHORTER THAN A USER'S 24h ON PURPOSE — see the header. Long enough that a
/// machine at a sign-in screen is not re-authenticating constantly, short enough
/// that a stolen one is a narrow window rather than a day.
pub const DEVICE_TOKEN_TTL_HOURS: i64 = 1;

/// How long a challenge stays answerable.
const CHALLENGE_TTL: Duration = Duration::from_secs(120);

/// Ceiling on outstanding challenges, so an unauthenticated caller cannot make
/// this map grow without bound. Old entries are swept on every insert, so this
/// is only reached by a burst rather than by ordinary accumulation.
const MAX_PENDING: usize = 4096;

#[derive(Default)]
pub struct DeviceChallenges {
    pending: Mutex<HashMap<String, (String, Instant)>>,
}

impl DeviceChallenges {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a challenge for `device_id` and return the nonce.
    pub fn issue(&self, device_id: &str, nonce: String) -> Result<(), ()> {
        let mut g = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        g.retain(|_, (_, at)| at.elapsed() < CHALLENGE_TTL);
        if g.len() >= MAX_PENDING {
            return Err(());
        }
        g.insert(nonce, (device_id.to_string(), Instant::now()));
        Ok(())
    }

    /// Consume a nonce. Returns the device it was issued for.
    ///
    /// REMOVES WHATEVER THE OUTCOME. One attempt per nonce: leaving a failed one
    /// in place would let an attacker grind signatures against a single
    /// challenge, and removing it only on success is the shape that allows that.
    pub fn take(&self, nonce: &str) -> Option<String> {
        let mut g = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let (device_id, at) = g.remove(nonce)?;
        if at.elapsed() >= CHALLENGE_TTL {
            return None;
        }
        Some(device_id)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

#[derive(Deserialize)]
pub struct ChallengeRequest {
    pub device_id: String,
}

#[derive(Serialize)]
pub struct ChallengeResponse {
    pub nonce: String,
}

#[derive(Deserialize)]
pub struct TokenRequest {
    pub device_id: String,
    pub nonce: String,
    pub sig: String,
}

#[derive(Serialize)]
pub struct TokenResponse {
    pub token: String,
    pub expires_in: i64,
}

fn bad(msg: &str) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, msg.to_string())
}

/// A database fault on this endpoint answers EXACTLY like a bad signature.
///
/// `/devices/token` is UNAUTHENTICATED, and it used to return
/// `format!("database error: {e}")` — raw sqlx text, which carries table and
/// constraint names and, for some error kinds, connection detail, to an
/// anonymous caller. Worse than the leak: a distinguishable answer turns the
/// endpoint into an oracle. Every other failure here is deliberately the same
/// `bad("that device could not be verified")` so a prober cannot measure which
/// device ids exist; a DB fault answering differently undid that. Same body,
/// detail to the log. (Mirrors `db_error` in device_handlers.rs, which returns
/// a 500 — this one keeps the 400 the endpoint's other refusals use, because
/// the indistinguishability is the point.)
fn db_error(e: sqlx::Error) -> (StatusCode, String) {
    tracing::error!("device_token db error: {e}");
    bad("that device could not be verified")
}

/// Step one: ask for something to sign.
///
/// Deliberately answers the same way for a device that exists and one that does
/// not. Telling an anonymous caller which device ids are real turns this into a
/// way to enumerate a stranger's machines.
pub async fn device_challenge(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ChallengeRequest>,
) -> Result<Json<ChallengeResponse>, (StatusCode, String)> {
    if payload.device_id.is_empty() || payload.device_id.len() > 128 {
        return Err(bad("that is not a device id"));
    }
    use rand::RngCore;
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let nonce = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, raw);

    state
        .device_challenges
        .issue(&payload.device_id, nonce.clone())
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "too many challenges".to_string()))?;

    Ok(Json(ChallengeResponse { nonce }))
}

/// Step two: present the signature, receive a short token.
pub async fn device_token(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<TokenRequest>,
) -> Result<Json<TokenResponse>, (StatusCode, String)> {
    // The nonce is consumed here whatever happens next.
    let Some(issued_for) = state.device_challenges.take(&payload.nonce) else {
        return Err(bad("that challenge is unknown or has expired"));
    };
    // The nonce was issued FOR a device id. Answering it as a different device
    // must fail even if that other device's signature is valid, or a device
    // could redeem a challenge intended for another.
    if issued_for != payload.device_id {
        return Err(bad("that challenge was not issued for this device"));
    }

    // user_id is decoded as i32, NOT i64: devices.user_id is INTEGER (INT4)
    // (migrations/044_devices.sql), and sqlx's Postgres decode is strict about
    // width -- i64 expects INT8, so decoding an INT4 column into it fails at
    // RUNTIME with "mismatched types" and this whole handler 500s. The client
    // discards that 500 body and the service reads it as "no longer enrolled",
    // which stranded every enrolled device whose JWT had expired -- the
    // cold-boot recovery path. `as UserId` below widens the i32 to i64.
    // `revoked_at IS NULL` is load-bearing, not decoration. Revoking a device
    // only stamps `devices.revoked_at`; the row — and the `sign_pub` it holds —
    // stays, so a revoked machine can still answer this challenge forever.
    // Without this clause it redeems one and gets a full ACCOUNT token (the
    // same `Claims` shape a login mints), which then passes every ordinary
    // authenticated route. "Revoke device" in the Devices tab would be a button
    // that revokes device-scoped access — every device query in
    // device_handlers.rs filters on this column, and enrol_device carries an
    // explicit "A REVOKED device stays revoked" guard for the mirror half —
    // while leaving general account access intact until the user happens to
    // change their password. This was the one path in the family that forgot.
    let row = sqlx::query_as::<_, (String, i32, String, i32)>(
        // `u.deleted_at IS NULL` matters as much as the device's own revocation:
        // account deletion is a tombstone UPDATE, so without it a device enrolled
        // before the deletion still resolves to a live row here and mints a full
        // account token for an account that no longer exists.
        //
        // token_version comes from the SAME statement as the revocation check,
        // not a second one. Two autocommit reads straddle /auth/logout's own two
        // writes, so a mint that saw `revoked_at IS NULL` before the revocation
        // and `token_version` before the bump would issue a token outliving both
        // — the exact window "sign out on all devices" exists to close. One
        // snapshot cannot be half-stale.
        "SELECT d.sign_pub, d.user_id, u.username, u.token_version \
         FROM devices d JOIN users u ON u.id = d.user_id \
         WHERE d.id = $1 AND d.revoked_at IS NULL AND u.deleted_at IS NULL",
    )
    .bind(&payload.device_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(db_error)?;

    // Same answer as a bad signature: whether a device id exists is not
    // something an unauthenticated caller should be able to measure.
    let Some((sign_pub, user_id, username, token_version)) = row else {
        return Err(bad("that device could not be verified"));
    };
    let user_id = user_id as UserId;

    if !crate::ws::verify_device_attestation(&sign_pub, &payload.nonce, user_id, &payload.sig) {
        return Err(bad("that device could not be verified"));
    }

    // The session is bound to the device at mint: this route just verified the
    // device's signature, so revoking the device revokes this token.
    let sid = uuid::Uuid::new_v4().to_string();
    // The mint error carries jsonwebtoken's own text. Same rule as the DB arm:
    // an unauthenticated caller gets the endpoint's one refusal, the detail goes
    // to the log.
    let token = mint_device_token(user_id, &username, token_version, &sid, &state.jwt_secret)
        .map_err(|e| {
            tracing::error!("device_token mint failed: {e}");
            bad("that device could not be verified")
        })?;
    // `headless`: this session belongs to the host service, not to a client
    // that reads DMs — the v4 rollout gate leaves it out (migration 060).
    if let Err(e) = sqlx::query("INSERT INTO token_sessions (sid, user_id, device_id, headless) VALUES ($1, $2, $3, TRUE)")
        .bind(&sid)
        .bind(user_id as i32)
        .bind(&payload.device_id)
        .execute(&state.pool)
        .await
    {
        tracing::warn!("device token: could not record session for user {}: {:?}", user_id, e);
    }

    Ok(Json(TokenResponse { token, expires_in: DEVICE_TOKEN_TTL_HOURS * 3600 }))
}

/// Mint the short token.
///
/// `sst` is stamped to NOW, which is what makes this a genuinely fresh session
/// rather than an extension of the enrolment token's. That is the entire point:
/// the old session's `MAX_SESSION_DAYS` cap is what stranded the machine, and
/// inheriting it would strand it again on the same date.
pub fn mint_device_token(
    user_id: UserId,
    username: &str,
    token_version: i32,
    sid: &str,
    secret: &str,
) -> Result<String, String> {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        sub: user_id,
        username: username.to_string(),
        exp: now + DEVICE_TOKEN_TTL_HOURS * 3600,
        tv: token_version,
        sst: now,
        sid: sid.to_string(),
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))
        .map_err(|e| format!("token creation failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nonce_works_exactly_once() {
        // ONE ATTEMPT PER CHALLENGE. Consuming only on success would let an
        // attacker grind signatures against a single nonce for its whole
        // lifetime.
        let c = DeviceChallenges::new();
        c.issue("dev-1", "n1".into()).expect("issued");
        assert_eq!(c.take("n1").as_deref(), Some("dev-1"));
        assert_eq!(c.take("n1"), None, "a nonce must not be reusable");
    }

    /// L8-ERR-1. A DB fault and a bad signature must be BYTE-IDENTICAL to an
    /// anonymous caller: this endpoint is unauthenticated, and every other
    /// refusal here is deliberately the same string so a prober cannot measure
    /// which device ids exist. It used to answer `format!("database error:
    /// {e}")` — raw sqlx text (table and constraint names, and connection
    /// detail for some error kinds) AND a distinguishable answer.
    #[test]
    fn a_database_fault_is_indistinguishable_from_a_bad_signature() {
        let bad_sig = bad("that device could not be verified");
        let db = db_error(sqlx::Error::RowNotFound);
        assert_eq!(db, bad_sig, "a DB fault must not be distinguishable");

        // ...for every shape of sqlx error, not just the tidy one.
        let pool = db_error(sqlx::Error::PoolTimedOut);
        assert_eq!(pool, bad_sig);
        let col = db_error(sqlx::Error::ColumnNotFound("sign_pub".into()));
        assert_eq!(col, bad_sig);
    }

    /// And the body carries no SQL vocabulary at all — the leak this closes was
    /// schema reconnaissance, not just an oracle.
    #[test]
    fn the_refusal_body_names_nothing_about_the_database() {
        let (_, body) = db_error(sqlx::Error::ColumnNotFound("devices.sign_pub".into()));
        let lowered = body.to_lowercase();
        for word in [
            "sqlx", "relation", "column", "constraint", "sign_pub", "devices",
            "postgres", "database", "syntax",
        ] {
            assert!(
                !lowered.contains(word),
                "the refusal body leaked {word:?}: {body}"
            );
        }
    }

    #[test]
    fn an_unknown_nonce_is_refused() {
        let c = DeviceChallenges::new();
        assert_eq!(c.take("never-issued"), None);
    }

    #[test]
    fn the_pending_map_cannot_grow_without_bound() {
        // This route is UNAUTHENTICATED — it has to be, since the caller has no
        // credential yet — so an anonymous burst must not be able to exhaust
        // memory.
        let c = DeviceChallenges::new();
        for i in 0..MAX_PENDING {
            c.issue("d", format!("n{i}")).expect("under the cap");
        }
        assert!(c.issue("d", "one-too-many".into()).is_err());
        assert!(c.len() <= MAX_PENDING);
    }

    #[test]
    fn a_device_token_is_short_lived_and_starts_a_fresh_session() {
        // BOTH HALVES MATTER. Short, because this is a key on a disk and not a
        // person. Fresh `sst`, because inheriting the enrolment token's session
        // start would re-apply the very MAX_SESSION_DAYS cap that stranded the
        // machine — it would come back and immediately be unable to renew again.
        const SECRET: &str = "test-secret";
        let before = chrono::Utc::now().timestamp();
        let token = mint_device_token(7, "alice", 3, "sid-test", SECRET).expect("mint");
        let claims = crate::auth::validate_token(&token, SECRET).expect("valid");

        assert_eq!(claims.sub, 7);
        assert_eq!(claims.tv, 3, "must carry the CURRENT token version");
        assert!(claims.sst >= before, "the session clock must start now");
        let life = claims.exp - claims.sst;
        assert_eq!(life, DEVICE_TOKEN_TTL_HOURS * 3600);
        assert!(
            life < crate::auth::TOKEN_TTL_HOURS * 3600,
            "a device token must be shorter than a person's"
        );
    }

    #[test]
    fn the_transcript_is_the_one_the_websocket_already_uses() {
        // One signing format for one meaning. A second transcript here would be
        // a second thing to keep in step with the agent, the waker and the
        // service — and the failure mode of drift is a signature error that
        // looks like a broken device rather than a mismatched string.
        assert_eq!(
            crate::ws::device_attest_message("abc", 42),
            "sovereign-device-attest-v1|abc|42"
        );
    }
}
