//! E2EE account-recovery endpoints (v3 key custody).
//!
//! Lets a user who forgot their password reset it *without* losing their
//! identity keypair (and therefore their encrypted history), by proving
//! possession of the identity seed they recovered with their recovery code.
//! See docs/E2EE_RECOVERY.md.
//!
//! Cryptography here MUST match `frontend/src/api/e2ee.ts` byte-for-byte:
//!   dh       = X25519(server_ephemeral, account_public_key)   (== X25519(seed, E))
//!   proofKey = HKDF-SHA256(salt = none, ikm = dh, info = "sovereign-recovery-proof-v1", 32)
//!   proof    = HMAC-SHA256(proofKey, challenge || lower(username))

use axum::{extract::State, http::StatusCode, response::IntoResponse, Extension, Json};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::sync::Arc;
use std::time::{Duration, Instant};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

use crate::auth::Claims;
use crate::state::{AppState, RecoveryChallenge};

type HmacSha256 = Hmac<Sha256>;

const RECOVERY_PROOF_INFO: &[u8] = b"sovereign-recovery-proof-v1";
const CHALLENGE_TTL: Duration = Duration::from_secs(120);

// --- DTOs ---

#[derive(Deserialize)]
pub struct WrapMaterial {
    pub wrap_salt: String,
    pub recovery_salt: String,
    pub seed_wrapped_pw: String,
    pub seed_wrapped_rc: String,
    pub pw_kdf_iterations: Option<i32>,
    pub pw_kdf: Option<String>,
    /// DM v4 history key, re-wrapped under the NEW recovery code (migration
    /// 060). Required whenever the account already has one: a new code that
    /// cannot open the history key would lock every v4 message for good.
    #[serde(default)]
    pub history_pubkey: Option<String>,
    #[serde(default)]
    pub history_wrapped_rc: Option<String>,
    /// Signature over dmKeyRecord('history', user, history_pubkey) by the
    /// account signing key; required with history_pubkey.
    #[serde(default)]
    pub history_pubkey_sig: Option<String>,
}

/// Body for POST /keys/rewrap-pw — a password-only wrap refresh (used to raise
/// the KDF strength on login without touching the recovery blob).
#[derive(Deserialize)]
pub struct PasswordRewrap {
    pub wrap_salt: String,
    pub seed_wrapped_pw: String,
    pub pw_kdf_iterations: i32,
    /// Password-wrap KDF: "argon2id" (current) or NULL/"pbkdf2" (legacy).
    pub pw_kdf: Option<String>,
}

#[derive(Serialize)]
pub struct WrapResponse {
    pub key_version: i32,
    pub wrap_salt: Option<String>,
    pub seed_wrapped_pw: Option<String>,
    pub pw_kdf_iterations: Option<i32>,
    pub pw_kdf: Option<String>,
    /// For unlocking DM history on a device with the recovery code: the salt
    /// the code is stretched with, and the history key wrapped under it. The
    /// seed's own recovery wrap is deliberately NOT here — a device that can
    /// open the history key must not thereby get the identity seed too; that
    /// stays behind the recovery-reset challenge.
    pub recovery_salt: Option<String>,
    pub history_pubkey: Option<String>,
    pub history_wrapped_rc: Option<String>,
}

#[derive(Deserialize)]
pub struct ChallengeRequest {
    pub username: String,
}

#[derive(Serialize)]
pub struct ChallengeResponse {
    /// Server ephemeral X25519 public key, "x25519:"-prefixed base64.
    pub server_ephemeral: String,
    /// base64(32-byte challenge).
    pub challenge: String,
    pub recovery_salt: String,
    pub seed_wrapped_rc: String,
    pub key_version: i32,
}

#[derive(Deserialize)]
pub struct RecoveryResetRequest {
    pub username: String,
    /// base64(HMAC proof).
    pub proof: String,
    pub new_salt_hex: String,
    pub new_verifier_hex: String,
    pub new_wrap_salt: String,
    pub new_seed_wrapped_pw: String,
    /// PBKDF2 iterations for the new password wrap (versioned KDF).
    pub new_pw_kdf_iterations: Option<i32>,
    /// KDF for the new password wrap: "argon2id" (current) or NULL/"pbkdf2".
    pub new_pw_kdf: Option<String>,
    /// Which derivation produced new_verifier_hex (migration 059): 1 = SHA-256
    /// — what a client predating 0.9.3 means by omitting this — 2 = Argon2id.
    #[serde(default)]
    pub new_srp_version: Option<crate::handlers::SrpVersion>,
    /// Optional: rotate the recovery code at the same time.
    pub new_recovery_salt: Option<String>,
    /// With a rotation, the history key re-wrapped under the new code
    /// (migration 060); refused without it when the account has one.
    #[serde(default)]
    pub new_history_pubkey: Option<String>,
    #[serde(default)]
    pub new_history_wrapped_rc: Option<String>,
    #[serde(default)]
    pub new_history_pubkey_sig: Option<String>,
    pub new_seed_wrapped_rc: Option<String>,
}

// --- Helpers ---

/// Accepted range for a stored password-wrap PBKDF2 iteration count. The floor
/// is the legacy strength (nothing weaker than what already shipped); the
/// ceiling bounds how long a client will spin deriving the KEK, so a poisoned
/// value can't turn login into a minutes-long hang (DoS). The server never
/// derives keys itself — it just refuses to store an out-of-range count that it
/// would later hand back to clients.
const PW_KDF_ITERATIONS_MIN: i32 = 210_000;
const PW_KDF_ITERATIONS_MAX: i32 = 10_000_000;

/// Validate an optional iteration count. `None` is allowed (legacy ⇒ 210k).
/// Returns Err with a message if a present value is outside the sane range.
pub(crate) fn validate_pw_kdf_iterations(iters: Option<i32>) -> Result<(), &'static str> {
    match iters {
        None => Ok(()),
        Some(n) if (PW_KDF_ITERATIONS_MIN..=PW_KDF_ITERATIONS_MAX).contains(&n) => Ok(()),
        Some(_) => Err("pw_kdf_iterations out of range"),
    }
}

/// Decode a "x25519:base64" public key into 32 raw bytes.
pub(crate) fn decode_public_key(encoded: &str) -> Option<[u8; 32]> {
    let b64 = encoded.strip_prefix("x25519:")?;
    let bytes = B64.decode(b64).ok()?;
    bytes.try_into().ok()
}

/// Gate for the endpoints that rewrite credentials or key custody.
///
/// A valid JWT proves "this session was authenticated at some point", which is
/// NOT the same as "the person here knows the password". Without this, anyone
/// holding a stolen bearer token could set their own SRP verifier (a complete
/// account takeover — `change_password` then bumps token_version and evicts the
/// real owner) or overwrite the password/recovery-wrapped seed blobs, leaving
/// the owner permanently unable to unwrap their own identity.
///
/// The proof is recorded only by `login_step_2` and expires after
/// `PASSWORD_PROOF_TTL`. Fails CLOSED: the client's remedy is to re-run SRP
/// with the password it already has in hand, which is exactly what
/// `changePassword` does before calling here.
pub(crate) fn require_password_proof(
    state: &Arc<AppState>,
    user_id: i64,
    session_start: i64,
) -> Result<(), axum::response::Response> {
    if state.password_recently_proven(user_id, session_start) {
        return Ok(());
    }
    tracing::warn!(
        "key-custody write refused for user {}: no recent password proof",
        user_id
    );
    Err((
        StatusCode::UNAUTHORIZED,
        "Confirm your password before making this change",
    )
        .into_response())
}

// --- Authenticated: login unwrap + migration/rewrap ---

/// GET /keys/wrap — the caller's own wrap material for login-time seed unwrap.
pub async fn get_wrap_material(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let row: Option<(i32, Option<String>, Option<String>, Option<i32>, Option<String>, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT key_version, wrap_salt, seed_wrapped_pw, pw_kdf_iterations, pw_kdf, recovery_salt, history_pubkey, history_wrapped_rc FROM users WHERE id = $1",
    )
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    match row {
        Some((key_version, wrap_salt, seed_wrapped_pw, pw_kdf_iterations, pw_kdf, recovery_salt, history_pubkey, history_wrapped_rc)) => {
            Json(WrapResponse {
                key_version,
                wrap_salt,
                seed_wrapped_pw,
                pw_kdf_iterations,
                pw_kdf,
                recovery_salt,
                history_pubkey,
                history_wrapped_rc,
            })
            .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// POST /keys/migrate-v3 — one-time upgrade of a legacy v2 account, or
/// POST /keys/rewrap — update wrap material while logged in (both share logic).
/// The identity seed itself never reaches the server; only wrapped blobs do.
pub async fn set_wrap_material(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(m): Json<WrapMaterial>,
) -> impl IntoResponse {
    // Key custody may only be rewritten by someone who has just PROVED the
    // password, not merely by a bearer token — this overwrites seed_wrapped_pw
    // and seed_wrapped_rc, i.e. it can destroy the owner's only route back to
    // their own identity seed. Both callers (the login-time v2->v3 migration
    // and the KDF rewrap) run immediately after login_step_2, so the proof is
    // always fresh for them.
    if let Err(r) = require_password_proof(&state, claims.sub, claims.sst) {
        return r;
    }
    if let Err(msg) = validate_pw_kdf_iterations(m.pw_kdf_iterations) {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }
    if let Err(msg) = crate::handlers::validate_history_key_pair(&m.history_pubkey, &m.history_wrapped_rc, &m.history_pubkey_sig) {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }
    // A new recovery code replaces the ONLY wrap of the history key. A client
    // that does not send a re-wrap (one from before 0.9.3) must not be allowed
    // to strand every v4 message behind a code that no longer opens the key.
    if m.history_wrapped_rc.is_none() {
        let has: Option<(bool,)> = sqlx::query_as("SELECT history_pubkey IS NOT NULL FROM users WHERE id = $1")
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
        if matches!(has, Some((true,))) {
            return (
                StatusCode::BAD_REQUEST,
                "This account has a message-history key that a new recovery code must re-wrap. Update this app, then generate the code again.",
            )
                .into_response();
        }
    }
    let result = sqlx::query(
        "UPDATE users SET key_version = 3, wrap_salt = $1, recovery_salt = $2, \
         seed_wrapped_pw = $3, seed_wrapped_rc = $4, pw_kdf_iterations = $5, pw_kdf = $6, \
         history_pubkey = COALESCE($8, history_pubkey), history_wrapped_rc = COALESCE($9, history_wrapped_rc), \
         history_pubkey_sig = COALESCE($10, history_pubkey_sig) \
         WHERE id = $7",
    )
    .bind(&m.wrap_salt)
    .bind(&m.recovery_salt)
    .bind(&m.seed_wrapped_pw)
    .bind(&m.seed_wrapped_rc)
    .bind(m.pw_kdf_iterations)
    .bind(&m.pw_kdf)
    .bind(claims.sub as i32)
    .bind(&m.history_pubkey)
    .bind(&m.history_wrapped_rc)
    .bind(&m.history_pubkey_sig)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to set wrap material: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to store key material",
            )
                .into_response()
        }
    }
}

/// POST /keys/rewrap-pw — replace ONLY the password-wrapped seed blob (and its
/// KDF iteration count), leaving the recovery blob and key_version intact. Used
/// to transparently raise the password-wrap KDF strength on login. The seed
/// never reaches the server; a bad blob would only lock out the caller, who is
/// already authenticated as the account owner.
pub async fn rewrap_password(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(m): Json<PasswordRewrap>,
) -> impl IntoResponse {
    // Same rule as set_wrap_material: this replaces the password-wrapped seed.
    // Its only caller is the login-time KDF upgrade, so the proof is fresh.
    if let Err(r) = require_password_proof(&state, claims.sub, claims.sst) {
        return r;
    }
    if let Err(msg) = validate_pw_kdf_iterations(Some(m.pw_kdf_iterations)) {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }
    // Only meaningful for v3 accounts (those with a wrapped seed to refresh).
    let result = sqlx::query(
        "UPDATE users SET wrap_salt = $1, seed_wrapped_pw = $2, pw_kdf_iterations = $3, pw_kdf = $4 \
         WHERE id = $5 AND key_version >= 3",
    )
    .bind(&m.wrap_salt)
    .bind(&m.seed_wrapped_pw)
    .bind(m.pw_kdf_iterations)
    .bind(&m.pw_kdf)
    .bind(claims.sub as i32)
    .execute(&state.pool)
    .await;

    match result {
        // 0 rows ⇒ the account isn't v3, so there was nothing to upgrade. Tell the
        // caller (409) instead of a misleading 200 that hides a silent no-op.
        Ok(r) if r.rows_affected() == 0 => {
            (StatusCode::CONFLICT, "No v3 wrap material to rewrap").into_response()
        }
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to rewrap password blob: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to store key material",
            )
                .into_response()
        }
    }
}

/// Body for POST /keys/change-password — an authenticated in-app password change.
#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub new_salt_hex: String,
    pub new_verifier_hex: String,
    pub new_wrap_salt: String,
    pub new_seed_wrapped_pw: String,
    pub new_pw_kdf_iterations: Option<i32>,
    pub new_pw_kdf: Option<String>,
    /// Which derivation produced new_verifier_hex (migration 059): 1 = SHA-256
    /// — what a client predating 0.9.3 means by omitting this — 2 = Argon2id.
    #[serde(default)]
    pub new_srp_version: Option<crate::handlers::SrpVersion>,
}

/// POST /keys/change-password — authenticated password change. The client has
/// already proven the CURRENT password (by unwrapping the seed with it) and
/// re-wrapped the SAME seed under the new password; here we just rewrite the SRP
/// verifier + password wrap for the authenticated account. Identity seed is
/// unchanged (encrypted history preserved); the recovery blob is untouched, so
/// the existing recovery code still works. Only meaningful for v3 accounts.
pub async fn change_password(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<ChangePasswordRequest>,
) -> impl IntoResponse {
    // THE takeover path: this writes a new SRP verifier. The doc comment above
    // says the client "has already proven the CURRENT password" — but that was
    // a client-side claim the server never checked, so a stolen bearer token
    // was enough to set an attacker-chosen password and (via the token_version
    // bump below) evict the real owner. Require the server's OWN proof. The
    // client re-runs SRP with the current password it already collected for the
    // form, so this costs one round-trip and no extra UI.
    if let Err(r) = require_password_proof(&state, claims.sub, claims.sst) {
        return r;
    }
    if let Err(msg) = validate_pw_kdf_iterations(req.new_pw_kdf_iterations) {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }
    let salt = match hex::decode(&req.new_salt_hex) {
        Ok(s) => s,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid salt hex").into_response(),
    };
    let verifier = match hex::decode(&req.new_verifier_hex) {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid verifier hex").into_response(),
    };
    // token_version bump (M1): a password change evicts every outstanding JWT
    // for this account, so a stolen bearer token can't survive the change.
    let result = sqlx::query(
        "UPDATE users SET salt = $1, verifier = $2, wrap_salt = $3, seed_wrapped_pw = $4, \
         pw_kdf_iterations = $5, pw_kdf = $6, srp_version = $7, token_version = token_version + 1 \
         WHERE id = $8 AND key_version >= 3",
    )
    .bind(&salt)
    .bind(&verifier)
    .bind(&req.new_wrap_salt)
    .bind(&req.new_seed_wrapped_pw)
    .bind(req.new_pw_kdf_iterations)
    .bind(&req.new_pw_kdf)
    .bind(req.new_srp_version.map(crate::handlers::SrpVersion::get).unwrap_or(1))
    .bind(claims.sub as i32)
    .execute(&state.pool)
    .await;

    match result {
        Ok(r) if r.rows_affected() == 1 => {
            // Make the token_version bump above bite on connections that are
            // ALREADY open: the receive loop re-checks the JWT's expiry per
            // frame but not its version, so a stolen bearer token otherwise
            // survived the password change on any socket it had already
            // established. This also drops the caller's own socket, which is
            // correct — the bump invalidated their token too, so they must
            // sign in again with the new password either way.
            state.disconnect_user(claims.sub);
            // Consume the proof: it was for the OLD password, and leaving it
            // live would let the rest of the window authorise another rewrite
            // that the person who just changed the password never asked for.
            state.clear_password_proof(claims.sub);
            StatusCode::OK.into_response()
        }
        Ok(_) => (
            StatusCode::CONFLICT,
            "Account not eligible for in-app password change",
        )
            .into_response(),
        Err(e) => {
            tracing::error!("change_password failed: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to change password",
            )
                .into_response()
        }
    }
}

// --- Unauthenticated: recovery reset (proof-gated) ---

/// POST /auth/recovery/challenge — issue a proof-of-possession challenge.
pub async fn recovery_challenge(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChallengeRequest>,
) -> impl IntoResponse {
    // Unauthenticated route: bound the caller-supplied name before it is
    // lowercased and fed through the constant-work pseudo-material path.
    if crate::handlers::reject_oversized_username(&req.username).is_err() {
        return (StatusCode::BAD_REQUEST, "Invalid username").into_response();
    }
    let username_lower = req.username.to_lowercase();

    // The account must be on v3 with a recovery blob to be recoverable.
    let row: Option<(i32, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT key_version, recovery_salt, seed_wrapped_rc FROM users WHERE LOWER(username) = $1",
    )
    .bind(&username_lower)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    // For an unknown or non-v3 username, synthesise deterministic pseudo material
    // so the response is byte-for-byte shaped like a real recoverable account —
    // closing the account-existence oracle (previously 404 for unknown/pre-v3,
    // 200 for recoverable). Lengths match the client exactly: recovery_salt =
    // base64(16B); seed_wrapped_rc = base64(72B) = AES-GCM nonce(12) + ciphertext
    // (base64(32B seed) = 44B plaintext + 16B tag). A synthesised account can
    // never produce a valid proof, so a follow-up /recovery/reset fails just like
    // a wrong recovery code (the frontend already surfaces that as "wrong code").
    let (recovery_salt, seed_wrapped_rc, real_account) = match row {
        Some((3, Some(rs), Some(rc))) => (rs, rc, true),
        _ => (
            B64.encode(crate::handlers::pseudo_material(
                &state.jwt_secret,
                "sovereign-recovery-salt-v1",
                &username_lower,
                16,
            )),
            B64.encode(crate::handlers::pseudo_material(
                &state.jwt_secret,
                "sovereign-recovery-wrap-v1",
                &username_lower,
                72,
            )),
            false,
        ),
    };

    // Server ephemeral keypair + random challenge (identical work either path).
    let mut e_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut e_bytes);
    let e_secret = StaticSecret::from(e_bytes);
    let e_public = X25519PublicKey::from(&e_secret);

    let mut challenge = [0u8; 32];
    OsRng.fill_bytes(&mut challenge);

    // Store the pending challenge only for real accounts. A synthesised username
    // can never complete a reset, and not storing avoids unbounded growth of the
    // in-memory challenge map from enumeration probes.
    if real_account {
        // Opportunistically evict expired challenges. Nothing else sweeps this
        // map, so abandoned challenges (requested, never reset) would otherwise
        // linger for the process lifetime. Cheap: bounded by usernames poked.
        let now = Instant::now();
        state.recovery_challenges.retain(|_, c| c.expires_at > now);

        state.recovery_challenges.insert(
            username_lower,
            RecoveryChallenge {
                server_ephemeral_secret: e_bytes,
                challenge,
                expires_at: Instant::now() + CHALLENGE_TTL,
            },
        );
    }

    Json(ChallengeResponse {
        server_ephemeral: format!("x25519:{}", B64.encode(e_public.as_bytes())),
        challenge: B64.encode(challenge),
        recovery_salt,
        seed_wrapped_rc,
        key_version: 3,
    })
    .into_response()
}

/// POST /auth/recovery/reset — verify the proof, then rewrite SRP + wrap
/// material. The identity seed/public key are untouched, so history survives.
pub async fn recovery_reset(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RecoveryResetRequest>,
) -> impl IntoResponse {
    // Unauthenticated route: bound the caller-supplied fields before any of them
    // is lowercased, hashed, or used to key a lookup.
    if crate::handlers::reject_oversized_username(&req.username).is_err()
        || crate::handlers::reject_oversized_hex(&req.proof).is_err()
        || crate::handlers::reject_oversized_hex(&req.new_salt_hex).is_err()
        || crate::handlers::reject_oversized_hex(&req.new_verifier_hex).is_err()
    {
        return (StatusCode::BAD_REQUEST, "Invalid request").into_response();
    }
    if let Err(msg) = validate_pw_kdf_iterations(req.new_pw_kdf_iterations) {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }
    let username_lower = req.username.to_lowercase();

    // M4: every failure below (no/expired challenge, unknown or keyless account,
    // bad proof) must be INDISTINGUISHABLE — one identical 401 body AND identical
    // work. Where real material is missing we substitute deterministic pseudo
    // material and run the SAME X25519 + HKDF + HMAC, mirroring login_step_2's
    // dummy-modexp. A synthesized attempt can never produce a valid proof.
    const RECOVERY_FAIL_MSG: &str =
        "Recovery failed. Request a new challenge and double-check your recovery code.";

    // Consume any pending challenge (one-shot). If absent/expired, synthesize a
    // deterministic one so the crypto below still runs.
    let real_challenge = match state.recovery_challenges.remove(&username_lower) {
        Some((_, c)) if c.expires_at > Instant::now() => Some(c),
        _ => None,
    };
    let challenge = real_challenge.clone().unwrap_or_else(|| {
        let eph = crate::handlers::pseudo_material(
            &state.jwt_secret,
            "sovereign-recovery-eph-v1",
            &username_lower,
            32,
        );
        let chal = crate::handlers::pseudo_material(
            &state.jwt_secret,
            "sovereign-recovery-chal-v1",
            &username_lower,
            32,
        );
        let mut eph_arr = [0u8; 32];
        eph_arr.copy_from_slice(&eph);
        let mut chal_arr = [0u8; 32];
        chal_arr.copy_from_slice(&chal);
        RecoveryChallenge {
            server_ephemeral_secret: eph_arr,
            challenge: chal_arr,
            expires_at: Instant::now() + CHALLENGE_TTL,
        }
    });

    // Account public key P, or a deterministic pseudo key when the account is
    // unknown / has no identity key — so the DH runs identically either way.
    // `id` comes back with the key so the credential rewrite below can be scoped
    // to the EXACT row whose key authorised it. Scoping the UPDATE by
    // `LOWER(username)` instead meant that if two rows ever case-folded to the
    // same name (users.username is only case-SENSITIVE unique), one account's
    // proof rewrote both. ORDER BY id makes the row chosen here deterministic
    // and identical to the one the challenge step read.
    let pubkey_row: Option<(i32, Option<String>)> = sqlx::query_as(
        "SELECT id, public_key FROM users WHERE LOWER(username) = $1 ORDER BY id LIMIT 1",
    )
    .bind(&username_lower)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let account_id: Option<i32> = pubkey_row.as_ref().map(|(id, _)| *id);
    let real_key = pubkey_row
        .and_then(|(_, pk)| pk)
        .as_deref()
        .and_then(decode_public_key);
    let account_pub: [u8; 32] = match real_key {
        Some(p) => p,
        None => {
            let pk = crate::handlers::pseudo_material(
                &state.jwt_secret,
                "sovereign-recovery-pub-v1",
                &username_lower,
                32,
            );
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&pk);
            arr
        }
    };

    // dh = X25519(server_ephemeral, P)  ==  X25519(seed, E) computed by the client.
    let e_secret = StaticSecret::from(challenge.server_ephemeral_secret);
    let dh = e_secret.diffie_hellman(&X25519PublicKey::from(account_pub));

    // proofKey = HKDF-SHA256(no salt, dh, info)
    let hk = Hkdf::<Sha256>::new(None, dh.as_bytes());
    let mut proof_key = [0u8; 32];
    if hk.expand(RECOVERY_PROOF_INFO, &mut proof_key).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "kdf error").into_response();
    }

    // Verify HMAC(proofKey, challenge || lower(username)) in constant time. A
    // malformed base64 proof folds into the same failure (empty bytes fail the
    // verify) rather than getting its own distinguishable response.
    let submitted = B64.decode(req.proof.as_bytes()).unwrap_or_default();
    let mut mac = match HmacSha256::new_from_slice(&proof_key) {
        Ok(m) => m,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "mac error").into_response(),
    };
    mac.update(&challenge.challenge);
    mac.update(username_lower.as_bytes());
    let mac_ok = mac.verify_slice(&submitted).is_ok();

    // Success requires a REAL challenge, a REAL identity key, AND a valid proof.
    // Any shortfall yields the single uniform failure (indistinguishable body).
    if !(real_challenge.is_some() && real_key.is_some() && mac_ok) {
        return (StatusCode::UNAUTHORIZED, RECOVERY_FAIL_MSG).into_response();
    }

    // Proof valid → apply the new SRP verifier + password-wrapped seed.
    let salt = match hex::decode(&req.new_salt_hex) {
        Ok(s) => s,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid salt hex").into_response(),
    };
    let verifier = match hex::decode(&req.new_verifier_hex) {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid verifier hex").into_response(),
    };

    // Rotate the recovery blob too if the client sent one; else keep existing.
    // RETURNING id: the socket eviction below needs the user id, and deriving
    // it from the UPDATE itself cannot fail independently — a separate lookup
    // could error after a successful reset and silently skip the eviction.
    // users.id is SERIAL, so the decode is i32.
    if let Err(msg) = crate::handlers::validate_history_key_pair(&req.new_history_pubkey, &req.new_history_wrapped_rc, &req.new_history_pubkey_sig) {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }
    if req.new_recovery_salt.is_some() && req.new_history_wrapped_rc.is_none() {
        // Rotating the code without re-wrapping the history key would strand
        // every v4 message; see set_wrap_material.
        let has: Option<(bool,)> = sqlx::query_as("SELECT history_pubkey IS NOT NULL FROM users WHERE id = $1")
            .bind(account_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
        if matches!(has, Some((true,))) {
            return (
                StatusCode::BAD_REQUEST,
                "This account has a message-history key that a new recovery code must re-wrap. Update this app, then try again.",
            )
                .into_response();
        }
    }
    let result: Result<Option<(i32,)>, sqlx::Error> =
        if let (Some(rs), Some(rc)) = (&req.new_recovery_salt, &req.new_seed_wrapped_rc) {
            sqlx::query_as(
                // token_version bump (M1): a recovery reset evicts all outstanding JWTs.
                "UPDATE users SET salt = $1, verifier = $2, wrap_salt = $3, seed_wrapped_pw = $4, \
             recovery_salt = $5, seed_wrapped_rc = $6, pw_kdf_iterations = $7, pw_kdf = $8, srp_version = $9, \
             history_pubkey = COALESCE($11, history_pubkey), history_wrapped_rc = COALESCE($12, history_wrapped_rc), \
             history_pubkey_sig = COALESCE($13, history_pubkey_sig), \
             force_password_reset = FALSE, token_version = token_version + 1 \
             WHERE id = $10 RETURNING id",
            )
            .bind(&salt)
            .bind(&verifier)
            .bind(&req.new_wrap_salt)
            .bind(&req.new_seed_wrapped_pw)
            .bind(rs)
            .bind(rc)
            .bind(req.new_pw_kdf_iterations)
            .bind(&req.new_pw_kdf)
            .bind(req.new_srp_version.map(crate::handlers::SrpVersion::get).unwrap_or(1))
            .bind(account_id)
            .bind(&req.new_history_pubkey)
            .bind(&req.new_history_wrapped_rc)
            .bind(&req.new_history_pubkey_sig)
            .fetch_optional(&state.pool)
            .await
        } else {
            sqlx::query_as(
                // token_version bump (M1): a recovery reset evicts all outstanding JWTs.
                "UPDATE users SET salt = $1, verifier = $2, wrap_salt = $3, seed_wrapped_pw = $4, \
             pw_kdf_iterations = $5, pw_kdf = $6, srp_version = $7, force_password_reset = FALSE, \
             token_version = token_version + 1 WHERE id = $8 RETURNING id",
            )
            .bind(&salt)
            .bind(&verifier)
            .bind(&req.new_wrap_salt)
            .bind(&req.new_seed_wrapped_pw)
            .bind(req.new_pw_kdf_iterations)
            .bind(&req.new_pw_kdf)
            .bind(req.new_srp_version.map(crate::handlers::SrpVersion::get).unwrap_or(1))
            .bind(account_id)
            .fetch_optional(&state.pool)
            .await
        };

    match result {
        Ok(uid) => {
            // Close live sockets for the same reason the token_version bump
            // exists: this is the "someone else has my account" path, and an
            // attacker holding a stolen bearer token would otherwise keep an
            // established WebSocket — reading channel traffic and sending DMs —
            // right through the reset, until their JWT expired on its own.
            // None = no such user; same 200 as ever (M4: no enumeration oracle).
            if let Some((id,)) = uid {
                state.disconnect_user(id as i64);
            }
            // Enrolled devices are deliberately NOT revoked here.
            //
            // A first cut did revoke them, reasoning that this is the "someone
            // else has my account" path. But it is overwhelmingly the "I forgot
            // my password" path, and revoking is not symmetric with re-enrolling:
            // an unattended remote-desktop host has no way to enrol itself, so a
            // user who reset their password while away from home would lose
            // access to that machine until they were physically in front of it.
            // Stranding a powered-off desktop is the wrong default for the
            // common case.
            //
            // The compromise case has its own remedy that DOES revoke devices —
            // Settings > Account > Sessions > "Sign out on all devices" — and
            // the response below points at it.
            tracing::info!("Recovery reset succeeded (account {})", crate::logtag::user_tag(&username_lower));
            (
                StatusCode::OK,
                "Password reset. Your history is intact — log in with your new password. \
                 If you think someone else had access to your account, open Settings > Account \
                 and use \"Sign out on all devices\" once you are signed in.",
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!("Recovery reset DB error for {}: {:?}", username_lower, e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to apply reset").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-language proof: the Rust DH + HKDF + HMAC must byte-match the
    /// frontend @noble output. Vector generated by e2ee.ts `computeRecoveryProof`
    /// with seed=0x01..0x20, e=0x21..0x40, challenge=0x41..0x60, username="mick".
    #[test]
    fn dh_proof_matches_frontend_vector() {
        let e: [u8; 32] = std::array::from_fn(|i| (i as u8) + 33); // 0x21..0x40
        let challenge: [u8; 32] = std::array::from_fn(|i| (i as u8) + 65); // 0x41..0x60
        let p_hex = "07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c";
        let e_pub_expected = "5869aff450549732cbaaed5e5df9b30a6da31cb0e5742bad5ad4a1a768f1a67b";
        let proof_expected = "WE6Wn4T3gjS4Hfdv90nVJVMvDAYjTF5psQ0xe6jgvFA=";

        let e_secret = StaticSecret::from(e);
        // x25519-dalek public-key derivation must match @noble's.
        assert_eq!(
            hex::encode(X25519PublicKey::from(&e_secret).as_bytes()),
            e_pub_expected
        );

        let p: [u8; 32] = hex::decode(p_hex).unwrap().try_into().unwrap();
        let dh = e_secret.diffie_hellman(&X25519PublicKey::from(p));

        let hk = Hkdf::<Sha256>::new(None, dh.as_bytes());
        let mut proof_key = [0u8; 32];
        hk.expand(RECOVERY_PROOF_INFO, &mut proof_key).unwrap();

        let mut mac = HmacSha256::new_from_slice(&proof_key).unwrap();
        mac.update(&challenge);
        mac.update(b"mick");
        let proof = mac.finalize().into_bytes();

        assert_eq!(
            B64.encode(proof),
            proof_expected,
            "Rust proof must match the frontend vector"
        );
    }
}
