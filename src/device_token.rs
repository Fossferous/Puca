//! A device proving it is itself, in exchange for a short session.
//!
//! WHY THIS ROUTE HAD TO EXIST. Every other token in this system is minted after
//! a human proves a password through SRP. That is right for people and useless
//! for a machine sitting at its own Windows sign-in screen: nobody is there to
//! type anything, and the copy of the owner's token it was given when it was
//! enrolled is not a durable credential. An EXPIRED token can never be renewed
//! (`validate_token` refuses it past jsonwebtoken's 60 s skew leeway, and
//! `renew_if_stale` refuses it inside that minute) — and renewal is bounded
//! anyway by `MAX_SESSION_DAYS` from the original sign-in, which is preserved
//! across every renewal and caps every renewed token's exp.
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
//! WHAT IT DOES NOT PROVE, and what bounds the token instead. This is a key
//! sitting on a disk, not a person. It cannot be revoked by a password change
//! the way a session can, so the token it buys carries the user's CURRENT
//! `token_version` and a session bound to THIS device (`token_sessions.device_id`,
//! written only while the device is live — `INSERT_DEVICE_SESSION`). Revoking
//! the account kills it at the next request; revoking the device refuses it at
//! the next request whatever the timing (`auth::token_session_live` checks the
//! device itself, not only the session row) and stops it being reissued.
//!
//! SHORT ONLY AT MINT. It is minted for `DEVICE_TOKEN_TTL_HOURS`, but it is an
//! ordinary session token (`ls: false`): the first authenticated request renews
//! it into a 24 h token (`TOKEN_TTL_HOURS`) that keeps sliding for up to
//! `MAX_SESSION_DAYS` from this mint, and the host service renews it on
//! purpose. So a copied token is good for that long unless the device is
//! revoked — revocation is what ends it, not the mint's TTL.
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

/// How long a device token lives AS MINTED.
///
/// Shorter than a user's 24 h, so a token nobody uses lapses soon. It is NOT
/// the token's lifetime once used — see the header: any authenticated request
/// renews it into an ordinary 24 h token sliding for up to `MAX_SESSION_DAYS`
/// from the mint, so what ends a stolen one is revoking the device.
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

/// The mint's session row, written only if the device is still live — checked
/// by the same statement that writes it.
///
/// The device was read and found live earlier, but that read is a plain
/// SELECT; by the time the signature has been checked the owner may have
/// revoked the device, and `revoke_device` sweeps only the rows that exist
/// when it sweeps. An unconditional INSERT landing after that sweep wrote a
/// LIVE row bound to a revoked device, and the token that came with it was
/// accepted and renewed for up to 30 days, out of reach of the Devices tab
/// (which hides a revoked device, so there was nothing left to revoke again).
///
/// `FOR SHARE` is what makes the check atomic rather than merely later. A
/// plain `EXISTS` reads a snapshot, so against a revoke that has marked the
/// device but not yet committed it still sees the device live and inserts
/// (measured on PostgreSQL 16: `INSERT 0 1` without the lock clause, `INSERT
/// 0 0` with it, same interleaving). The share lock conflicts with the
/// revoke's row lock, so the two serialise on the device row: either the mint
/// goes first and its row exists before `revoke_device` sweeps (the device is
/// marked, then swept, in one transaction), or it waits for the revoke's
/// commit, re-reads the row and finds it revoked — no row, no token.
///
/// `user_id` is matched too, so the statement stands on its own: it binds a
/// session to a live device OF THIS ACCOUNT without leaning on the earlier read.
pub(crate) const INSERT_DEVICE_SESSION: &str = "INSERT INTO token_sessions (sid, user_id, device_id, headless) \
     SELECT $1, $2, $3, TRUE \
     WHERE EXISTS (SELECT 1 FROM devices WHERE id = $3 AND user_id = $2 AND revoked_at IS NULL FOR SHARE)";

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
    // The row FIRST, and no token without it: the row is what binds this
    // session to the device, so it is what "revoke device" marks. A token whose
    // row failed to insert used to be returned anyway (the failure was only
    // logged) — a session the device's revocation could never reach, which the
    // first request renewed into a 24 h token sliding for 30 days.
    //
    // A fault HERE is a 503, not `db_error`'s refusal. `db_error` answers like a
    // bad signature so an anonymous prober cannot tell a DB fault from an
    // unknown device — but nobody reaches this line without the device's own
    // key, so there is nothing left to hide from the caller. And the refusal is
    // not harmless to the host: puca-service's `is_refusal` reads that 400 as
    // "the server refused this computer", records it in link health and waits
    // 15 minutes, over what may be a one-second pool timeout. A 5xx puts it on
    // its one-minute ladder instead. The body stays generic; the detail is logged.
    // `headless`: this session belongs to the host service, not to a client
    // that reads DMs — the v4 rollout gate leaves it out (migration 060).
    let recorded = sqlx::query(INSERT_DEVICE_SESSION)
        .bind(&sid)
        .bind(user_id as i32)
        .bind(&payload.device_id)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            tracing::error!("device_token: could not record the session row: {e}");
            (StatusCode::SERVICE_UNAVAILABLE, "could not start a session right now; try again".to_string())
        })?;
    // No row means the device was revoked after the read above: refused
    // exactly as if the read had seen it, since to the host that is what it
    // is — this computer was signed out. Not the 503: retrying cannot help.
    if recorded.rows_affected() == 0 {
        tracing::info!("device_token: device of user {user_id} was revoked while its token was being minted — refused");
        return Err(bad("that device could not be verified"));
    }
    // The mint error carries jsonwebtoken's own text, so it goes to the log and
    // the caller gets the endpoint's one refusal. Unlike the row's transient
    // fault above, a signing failure would be a configuration fault that
    // retrying every minute cannot cure, so the host's 15-minute refusal wait
    // is the right pace for it. (A row left behind by a failed mint names no
    // token: harmless.)
    let token = mint_device_token(user_id, &username, token_version, &sid, &state.jwt_secret)
        .map_err(|e| {
            tracing::error!("device_token mint failed: {e}");
            bad("that device could not be verified")
        })?;

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
        // Never a "stay signed in" session: a device token is minted for a
        // MACHINE against its own TTL and its own freshly stamped `sst` (see
        // this function's doc comment), not for a browser someone ticked a box
        // in, so the long-session lifetime and cap must not apply to it.
        ls: false,
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

    /// A user and one enrolled, live device whose signing key the test holds.
    /// TEST_DATABASE_URL only; the caller deletes the user (the device and its
    /// session rows cascade with it).
    async fn enrolled_device(pool: &sqlx::PgPool) -> (i32, ed25519_dalek::SigningKey, String) {
        use base64::Engine;
        use rand::RngCore;
        let b64 = base64::engine::general_purpose::STANDARD;
        let name = format!("devtok_{}", uuid::Uuid::new_v4().simple());
        let (uid,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(&name).bind(b"s".as_ref()).bind(b"v".as_ref())
            .fetch_one(pool).await.expect("insert user");
        let mut seed = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut seed);
        let key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let device_id = format!("dt-{}", uuid::Uuid::new_v4().simple());
        sqlx::query(
            "INSERT INTO devices (id, user_id, device_pub, sign_pub, name, platform, auth_record, auth_sig) \
             VALUES ($1, $2, 'x25519:AA', $3, 'test', 'windows', '{}', 'x')",
        )
        .bind(&device_id).bind(uid).bind(format!("ed25519:{}", b64.encode(key.verifying_key().to_bytes())))
        .execute(pool).await.expect("insert device");
        (uid, key, device_id)
    }

    /// The whole route as the host service drives it: a challenge, the
    /// device's signature over it, the token request.
    async fn redeem(state: &Arc<AppState>, key: &ed25519_dalek::SigningKey, device_id: &str, uid: i32) -> Result<Json<TokenResponse>, (StatusCode, String)> {
        use base64::Engine;
        use ed25519_dalek::Signer;
        use rand::RngCore;
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        let nonce = b64.encode(raw);
        state.device_challenges.issue(device_id, nonce.clone()).expect("issue");
        let sig = key.sign(crate::ws::device_attest_message(&nonce, uid as UserId).as_bytes());
        device_token(
            State(state.clone()),
            Json(TokenRequest { device_id: device_id.to_string(), nonce, sig: b64.encode(sig.to_bytes()) }),
        )
        .await
    }

    /// Finding 3: a device token must never be handed out without its
    /// `token_sessions` row. Without the row, revoking the device (which marks
    /// the rows bound to it) and per-session sign-out both miss the session,
    /// and renewal slides it for 30 days. The INSERT is made to fail with a
    /// trigger scoped to this test's user. TEST_DATABASE_URL only.
    #[tokio::test]
    async fn no_device_token_is_issued_when_its_session_row_cannot_be_written() {
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let (uid, key, device_id) = enrolled_device(&pool).await;

        let fault = crate::auth::refuse_session_rows_for(&pool, uid).await;
        let refused = redeem(&state, &key, &device_id, uid).await;
        crate::auth::allow_session_rows(&pool, &fault).await;
        let (rows_while_down,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM token_sessions WHERE user_id = $1")
            .bind(uid).fetch_one(&pool).await.unwrap();
        let healthy = redeem(&state, &key, &device_id, uid).await;
        let bound: Option<(bool, Option<String>)> = sqlx::query_as("SELECT headless, device_id FROM token_sessions WHERE user_id = $1")
            .bind(uid).fetch_optional(&pool).await.unwrap();
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(uid).execute(&pool).await;

        assert_eq!(rows_while_down, 0, "the fault really did stop the row");
        match refused {
            Ok(r) => panic!("a device token was issued with no session row behind it (expires_in {})", r.0.expires_in),
            Err((status, body)) => {
                // NOT the refusal. The caller just proved it holds the device
                // key, so a fault after that is a server fault: puca-service's
                // `is_refusal` reads the 400 + this body as "the server refused
                // this computer" and waits 15 minutes with a health warning.
                // A 5xx puts it on the one-minute ladder instead.
                assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "a fault after the signature is the server's, not a refusal: {body}");
                assert!(!body.contains("that device could not be verified"), "not the refusal's body: {body}");
                assert!(!body.to_lowercase().contains("token_sessions"), "no DB detail to the caller: {body}");
            }
        }
        // Positive control: the same device, the store healthy, gets its token
        // and the row that binds it to the device.
        assert!(healthy.is_ok(), "a healthy redeem still mints: {:?}", healthy.err());
        assert_eq!(bound, Some((true, Some(device_id.clone()))), "headless and bound to the device that proved itself");
    }

    /// THE RACE. A device revoked while its token is being minted must not
    /// come out of it holding a session. The mint reads the device (live),
    /// verifies the signature, then writes its session row; `revoke_device`
    /// marks the device and sweeps its rows. A mint whose read came before the
    /// revoke and whose INSERT came after the sweep wrote a live row and got a
    /// token no revocation had reached.
    ///
    /// Staged exactly, not hoped for: the revoke's UPDATE of the device row is
    /// made and held UNCOMMITTED, so the handler's read (a plain SELECT) still
    /// sees the device live and the signature verifies — the race's first
    /// half — and the revoke commits only once the mint has reached its INSERT
    /// and is waiting on that row, or has already finished (which is what the
    /// unconditional INSERT did: it never looked at the device again). The
    /// control rolls the same revoke back instead, so a refusal caused by the
    /// waiting rather than by the revocation fails it. TEST_DATABASE_URL only.
    #[tokio::test]
    async fn a_device_revoked_between_the_read_and_the_insert_gets_no_token_and_no_row() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let (uid, key, device_id) = enrolled_device(&pool).await;

        /// One redeem raced against a revocation of the device that is held
        /// open until the mint is parked behind it. Returns the handler's
        /// answer and whether the mint was seen waiting on the revoke.
        async fn raced(
            pool: &sqlx::PgPool,
            state: &Arc<AppState>,
            key: &ed25519_dalek::SigningKey,
            device_id: &str,
            uid: i32,
            revoke_commits: bool,
        ) -> (Result<Json<TokenResponse>, (StatusCode, String)>, bool) {
            let mut revoke = pool.begin().await.expect("begin");
            let (revoker,): (i32,) = sqlx::query_as("SELECT pg_backend_pid()").fetch_one(&mut *revoke).await.unwrap();
            sqlx::query("UPDATE devices SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL")
                .bind(device_id).execute(&mut *revoke).await.expect("mark the device, uncommitted");
            let mint = tokio::spawn({
                let (state, key, device_id) = (state.clone(), key.clone(), device_id.to_string());
                async move { redeem(&state, &key, &device_id, uid).await }
            });
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            let parked = loop {
                let (waiting,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))")
                    .bind(revoker).fetch_one(pool).await.unwrap();
                if waiting > 0 {
                    break true;
                }
                if mint.is_finished() {
                    break false;
                }
                assert!(tokio::time::Instant::now() < deadline, "fixture: the mint neither finished nor waited within 10 s");
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            if revoke_commits {
                revoke.commit().await.expect("commit the revoke");
            } else {
                revoke.rollback().await.expect("roll the revoke back");
            }
            (mint.await.expect("mint task"), parked)
        }

        let (revoked, revoked_parked) = raced(&pool, &state, &key, &device_id, uid, true).await;
        let (rows_after_revoke,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM token_sessions WHERE user_id = $1")
            .bind(uid).fetch_one(&pool).await.unwrap();
        // The control needs the device live again. Nothing in the product ever
        // un-revokes a device; this is only the fixture resetting itself.
        sqlx::query("UPDATE devices SET revoked_at = NULL WHERE id = $1").bind(&device_id).execute(&pool).await.unwrap();
        let (control, control_parked) = raced(&pool, &state, &key, &device_id, uid, false).await;
        let rows: Vec<(Option<String>, bool)> = sqlx::query_as("SELECT device_id, revoked_at IS NULL FROM token_sessions WHERE user_id = $1")
            .bind(uid).fetch_all(&pool).await.unwrap();
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(uid).execute(&pool).await;

        match revoked {
            Ok(r) => panic!(
                "a device token was issued for a device revoked mid-mint (expires_in {}, {rows_after_revoke} session row(s) written)",
                r.0.expires_in,
            ),
            // The answer a device already revoked at the read gets. To the host
            // this IS "the server refused this computer", and its 15-minute
            // wait is the right pace for a machine its owner signed out.
            Err((status, body)) => assert_eq!((status, body.as_str()), (StatusCode::BAD_REQUEST, "that device could not be verified")),
        }
        assert_eq!(rows_after_revoke, 0, "no session row may be written for a device revoked mid-mint");
        // Positive control: the same staging with the revoke abandoned mints,
        // with its row bound to the device — so the refusal above came from
        // the revocation, not from the mint having had to wait.
        assert!(control.is_ok(), "an abandoned revoke must not cost the device its token: {:?}", control.err());
        assert_eq!(rows, vec![(Some(device_id.clone()), true)], "exactly the control's row, live and bound to the device");
        // And the race really was run: both mints reached the INSERT while the
        // revoke was uncommitted, after the read had seen the device live.
        assert!(revoked_parked && control_parked, "fixture: the mint must have waited on the revoke (revoked {revoked_parked}, control {control_parked})");
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
