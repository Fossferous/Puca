use axum::{
    extract::{Extension, Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use srp::groups::G_2048;
use srp::server::SrpServer;
use std::sync::Arc;
use tracing;
use uuid::Uuid;

use crate::state::AppState;

/// Cap on users.display_name. It rides on every message row the client renders,
/// so it is fanned out far more than it is written; 64 matches the server
/// nickname/emoji-name class of limit rather than the 8000 body limits.
const MAX_DISPLAY_NAME_LEN: usize = 64;

// --- DTOs ---

/// Which key-derivation produced an SRP verifier a client is sending us
/// (migration 059): 1 = SHA-256, 2 = Argon2id. See `SRP_VERSION_CURRENT` in
/// the client's auth.ts for the derivations themselves.
///
/// Validated at the TYPE level so a body carrying any other value is rejected
/// by the JSON extractor before a handler runs. The alternative — storing
/// whatever arrived — strands the account: login step 1 would announce a
/// version no client can derive, and nothing could ever open it again.
///
/// A client predating 0.9.3 omits the field entirely. Every handler that
/// accepts one defaults that to 1, and that is the ONLY safe default: such a
/// client derived SHA-256, and recording 2 would make the account unopenable
/// by every current client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SrpVersion(i16);

impl SrpVersion {
    pub fn get(self) -> i16 {
        self.0
    }
}

impl TryFrom<i16> for SrpVersion {
    type Error = String;
    fn try_from(v: i16) -> Result<Self, String> {
        match v {
            1 | 2 => Ok(SrpVersion(v)),
            other => Err(format!("unknown srp_version {other}")),
        }
    }
}

impl<'de> serde::Deserialize<'de> for SrpVersion {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = i16::deserialize(d)?;
        SrpVersion::try_from(v).map_err(<D::Error as serde::de::Error>::custom)
    }
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub salt_hex: String,
    pub verifier_hex: String,
    pub public_key: Option<String>, // E2EE public key (base64)
    // v3 recoverable key custody (all-or-nothing; absent ⇒ legacy v2 account).
    pub wrap_salt: Option<String>,
    pub recovery_salt: Option<String>,
    pub seed_wrapped_pw: Option<String>,
    pub seed_wrapped_rc: Option<String>,
    /// PBKDF2 iterations for the password wrap (versioned KDF; NULL ⇒ legacy).
    pub pw_kdf_iterations: Option<i32>,
    /// Password-wrap KDF algorithm: "argon2id" (current) or NULL/"pbkdf2" (legacy).
    pub pw_kdf: Option<String>,
    /// Shared registration invite code — required only when the server has
    /// REGISTRATION_INVITE_CODE set (closed registration). Absent otherwise.
    pub invite_code: Option<String>,
    /// Which derivation produced verifier_hex (migration 059). Absent from a
    /// client predating 0.9.3, which derived SHA-256 — so `None` means 1.
    #[serde(default)]
    pub srp_version: Option<SrpVersion>,
    /// DM v4 history key (migration 060): the public half, and the private
    /// half wrapped under the recovery code. Absent from clients before 0.9.3;
    /// such an account stays on v3 DMs until it regenerates its recovery code
    /// from a current client.
    #[serde(default)]
    pub history_pubkey: Option<String>,
    #[serde(default)]
    pub history_wrapped_rc: Option<String>,
    /// Signature over dmKeyRecord('history', history_pubkey) by the account
    /// signing key; required with history_pubkey (see dmKeys.ts).
    #[serde(default)]
    pub history_pubkey_sig: Option<String>,
    /// The account's Ed25519 signing key (`ed25519:` + base64), published at
    /// registration so the first DM to this account can already verify its
    /// session keys. Also published by PATCH /keys/signing and /keys/session-dm.
    #[serde(default)]
    pub account_sign_pub: Option<String>,
}

/// Constant-time byte-slice equality, so the registration code isn't matched
/// with a short-circuiting `==` (avoids leaking it via response timing).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

type HmacSha256 = Hmac<Sha256>;

/// Deterministic per-username pseudo-material for usernames that don't exist, so
/// login step-1 responds identically whether or not the account is real (closes
/// the user-enumeration oracle: previously unknown → 401, real → 200 + salt).
///
/// Keyed by the server's JWT secret, so an attacker can't reproduce it offline,
/// and the same username always yields the same bytes — exactly like a real row
/// would. `out_len` lets callers request a 32-byte salt (matching the client) or
/// a 256-byte value for a 2048-bit verifier.
pub(crate) fn pseudo_material(
    secret: &str,
    label: &str,
    username: &str,
    out_len: usize,
) -> Vec<u8> {
    let uname = username.to_lowercase();
    let mut out = Vec::with_capacity(out_len);
    let mut counter: u32 = 0;
    while out.len() < out_len {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
            .expect("HMAC accepts a key of any length");
        mac.update(label.as_bytes());
        mac.update(&[0u8]);
        mac.update(uname.as_bytes());
        mac.update(&counter.to_be_bytes());
        out.extend_from_slice(&mac.finalize().into_bytes());
        counter += 1;
    }
    out.truncate(out_len);
    out
}

#[derive(Deserialize)]
pub struct LoginStep1Request {
    pub username: String,
    pub a_pub_hex: String,
}

#[derive(Serialize)]
pub struct LoginStep1Response {
    pub salt_hex: String,
    pub b_pub_hex: String,
    /// Opaque id for THIS attempt; the client echoes it in step-2 so concurrent
    /// logins for the same username don't clobber each other.
    pub attempt_id: String,
    /// The derivation this account's verifier was made with (migration 059),
    /// so the client computes the matching x. A real v1 account and an unknown
    /// name both answer 1 — see the fake branch in login_step_1.
    pub srp_version: i16,
}

#[derive(Deserialize)]
pub struct LoginStep2Request {
    pub username: String,
    pub m_hex: String,
    /// From step-1. Absent for old clients (server falls back to the newest row).
    #[serde(default)]
    pub attempt_id: Option<String>,
    /// Replacement credentials for an srp_version-1 account, derived under the
    /// current KDF (migration 059). Applied ONLY after this proof verifies —
    /// see login_step_2. Absent from v2 accounts and from clients before 0.9.3.
    #[serde(default)]
    pub new_salt_hex: Option<String>,
    #[serde(default)]
    pub new_verifier_hex: Option<String>,
}

#[derive(Serialize)]
pub struct LoginStep2Response {
    pub hamk_hex: String,
    pub token: String,
}

#[derive(Deserialize)]
pub struct ResetPasswordRequest {
    /// Which derivation produced verifier_hex (migration 059); omitted by a
    /// client predating 0.9.3, which derived SHA-256 — so `None` means 1.
    #[serde(default)]
    pub srp_version: Option<SrpVersion>,
    pub username: String,
    pub salt_hex: String,
    pub verifier_hex: String,
}

// --- Handlers ---

/// Allowed username charset: letters, digits, `_`, `-`, `.`, 3–32 chars.
///
/// Deliberately EXCLUDES `#`, which the account tombstone (`deleted#<id>`)
/// relies on being unregisterable — without this, squatting a tombstone name
/// wedges that user's deletion forever.
/// Longest username `validate_username` will ever accept.
pub const MAX_USERNAME_LEN: usize = 32;

/// Ceiling applied to a username on the LOGIN and RECOVERY paths.
///
/// Deliberately far above `MAX_USERNAME_LEN`: those routes must still accept any
/// name that could name a real account, including one created before
/// registration enforced a length. This bounds work and memory, nothing else.
pub const MAX_CREDENTIAL_NAME_BYTES: usize = 1024;

/// A 2048-bit SRP group element is 256 bytes (512 hex chars) and the proof is 32
/// bytes (64). Both ceilings are generous; the point is that they exist at all.
pub const MAX_SRP_HEX_LEN: usize = 1024;

/// Reject a username too long to name any account, before anything expensive
/// touches it.
///
/// `validate_username` bounds the value at REGISTRATION, but it was never called
/// on the login or recovery routes — so those accepted a username up to the
/// 2 MiB body limit, lowercased it, drove it through a multi-pass HMAC, and
/// stored it as a permanent key in the login-backoff map. Length is the ONLY
/// thing checked here: the charset rule belongs to registration, and applying it
/// at login could lock out an account created under an older rule — which is
/// also why the ceiling here is a RESOURCE bound well above the registration
/// limit rather than the registration limit itself. Refusing a name longer than
/// any plausible account reveals nothing about which accounts exist.
pub fn reject_oversized_username(username: &str) -> Result<(), StatusCode> {
    // Bound RESOURCE consumption, not the registration business rule.
    //
    // A first cut reused MAX_USERNAME_LEN (32). That is the rule new accounts
    // must satisfy, but it is not a rule every EXISTING account satisfies:
    // `validate_username` only became a registration gate later, so an account
    // created on an earlier build can carry a longer name — and capping login at
    // 32 locked such an account out of every credential path, including recovery,
    // with no remedy inside the product. The guard exists to stop a 2 MiB
    // username driving a multi-pass HMAC and keying the backoff map; a ceiling
    // two orders of magnitude above any real name does that just as well.
    if username.len() > MAX_CREDENTIAL_NAME_BYTES {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(())
}

/// Reject an over-long hex field before it is decoded, hashed, or stored.
pub fn reject_oversized_hex(value: &str) -> Result<(), StatusCode> {
    if value.len() > MAX_SRP_HEX_LEN {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(())
}

pub fn validate_username(username: &str) -> Result<(), &'static str> {
    let n = username.chars().count();
    if n < 3 || n > MAX_USERNAME_LEN {
        return Err("Username must be between 3 and 32 characters");
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err("Username may only contain letters, numbers, and _ - .");
    }
    Ok(())
}

pub async fn register(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RegisterRequest>,
) -> impl IntoResponse {
    // Registration gate: when REGISTRATION_INVITE_CODE is set, require a matching
    // code before doing any work. Unset/empty ⇒ open registration (unchanged).
    // Applies to every client (web/desktop/mobile all POST here).
    if let Some(required) = std::env::var("REGISTRATION_INVITE_CODE")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        let provided = payload.invite_code.as_deref().unwrap_or("").trim();
        if !ct_eq(provided.as_bytes(), required.trim().as_bytes()) {
            return (
                StatusCode::FORBIDDEN,
                "A valid invite code is required to register on this server.",
            )
                .into_response();
        }
    }

    // Usernames were previously unvalidated server-side, so anything the
    // client sent became a row. That let an attacker pre-register the exact
    // tombstone name `deleted#<id>` and permanently block that user's account
    // deletion on the UNIQUE index (there is no rename endpoint). Enforce the
    // charset the UI already implies — and which the tombstone scheme depends
    // on for being uncollidable.
    if let Err(msg) = validate_username(&payload.username) {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }

    // Bound every stored field. These are all small in practice — a public key
    // is ~44 chars, the SRP salt/verifier a few hundred hex chars, each wrapped
    // blob a short base64 string — but nothing capped them, so a client could
    // register rows carrying multi-MB blobs (storage amplification, and the
    // wrap fields are handed back verbatim at every login). 8 KiB is generous
    // for all of them. The auth rate limiter already bounds registration
    // frequency per IP.
    const MAX_REGISTER_FIELD: usize = 8192;
    for (label, value) in [
        ("salt_hex", Some(&payload.salt_hex)),
        ("verifier_hex", Some(&payload.verifier_hex)),
        ("public_key", payload.public_key.as_ref()),
        ("wrap_salt", payload.wrap_salt.as_ref()),
        ("recovery_salt", payload.recovery_salt.as_ref()),
        ("seed_wrapped_pw", payload.seed_wrapped_pw.as_ref()),
        ("seed_wrapped_rc", payload.seed_wrapped_rc.as_ref()),
        ("pw_kdf", payload.pw_kdf.as_ref()),
        ("invite_code", payload.invite_code.as_ref()),
    ] {
        if value.is_some_and(|v| v.len() > MAX_REGISTER_FIELD) {
            return (StatusCode::PAYLOAD_TOO_LARGE, format!("{label} is too long")).into_response();
        }
    }

    // Decode hex values
    let salt = match hex::decode(&payload.salt_hex) {
        Ok(s) => s,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid salt hex").into_response(),
    };
    let verifier = match hex::decode(&payload.verifier_hex) {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid verifier hex").into_response(),
    };

    // Check if username already exists (case-insensitive)
    let existing: Option<(i32,)> =
        sqlx::query_as("SELECT id FROM users WHERE LOWER(username) = LOWER($1)")
            .bind(&payload.username)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    if existing.is_some() {
        return (StatusCode::CONFLICT, "Username already exists").into_response();
    }

    if let Err(msg) =
        crate::recovery_handlers::validate_pw_kdf_iterations(payload.pw_kdf_iterations)
    {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }

    // v3 accounts arrive with wrap material; legacy clients omit it (key_version
    // stays 2 and the account migrates on next login).
    let is_v3 = payload.wrap_salt.is_some()
        && payload.recovery_salt.is_some()
        && payload.seed_wrapped_pw.is_some()
        && payload.seed_wrapped_rc.is_some();
    let key_version = if is_v3 { 3 } else { 2 };
    let srp_version: i16 = payload.srp_version.map(SrpVersion::get).unwrap_or(1);
    if let Err(msg) = validate_history_key_pair(&payload.history_pubkey, &payload.history_wrapped_rc, &payload.history_pubkey_sig) {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }
    if let Some(k) = &payload.account_sign_pub {
        if let Err(msg) = validate_account_sign_pub(k) {
            return (StatusCode::BAD_REQUEST, msg).into_response();
        }
    }

    // Insert into database with public key + optional wrap material
    let result = sqlx::query(
        "INSERT INTO users (username, salt, verifier, public_key, key_version, \
         wrap_salt, recovery_salt, seed_wrapped_pw, seed_wrapped_rc, pw_kdf_iterations, pw_kdf, srp_version, \
         history_pubkey, history_wrapped_rc, history_pubkey_sig, account_sign_pub) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
    )
    .bind(&payload.username)
    .bind(&salt)
    .bind(&verifier)
    .bind(&payload.public_key)
    .bind(key_version)
    .bind(&payload.wrap_salt)
    .bind(&payload.recovery_salt)
    .bind(&payload.seed_wrapped_pw)
    .bind(&payload.seed_wrapped_rc)
    .bind(payload.pw_kdf_iterations)
    .bind(&payload.pw_kdf)
    .bind(srp_version)
    .bind(&payload.history_pubkey)
    .bind(&payload.history_wrapped_rc)
    .bind(&payload.history_pubkey_sig)
    .bind(&payload.account_sign_pub)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => (StatusCode::CREATED, "User registered").into_response(),
        Err(e) => {
            tracing::error!("Registration error: {:?}", e);
            (StatusCode::CONFLICT, "Username already exists").into_response()
        }
    }
}

pub async fn login_step_1(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LoginStep1Request>,
) -> Result<Json<LoginStep1Response>, StatusCode> {
    // 0. Bound the caller-supplied fields before anything hashes, stores or
    //    keys on them. `a_pub_hex` was persisted verbatim into login_attempts
    //    for ten minutes at whatever size the body limit allowed.
    reject_oversized_username(&payload.username)?;
    reject_oversized_hex(&payload.a_pub_hex)?;

    // 1. Fetch user from database (case-insensitive). A DELETED account is
    //    treated exactly like an unknown username — it takes the synthesised
    //    path below, so a tombstone is unauthenticatable AND indistinguishable
    //    from a name that never existed.
    let user: Option<(Vec<u8>, Vec<u8>, i16)> = sqlx::query_as(
        "SELECT salt, verifier, srp_version FROM users WHERE LOWER(username) = LOWER($1) AND deleted_at IS NULL",
    )
    .bind(&payload.username)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("DB error: {:?}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    // For an unknown username, synthesise a deterministic salt (32 bytes, matching
    // the client) and verifier (256 bytes = one 2048-bit group element) so the
    // step-1 response is indistinguishable from a real account. `real_user`
    // gates the DB write below — no login_attempt is stored for the fake path, so
    // step-2 returns the same 401 a wrong password produces.
    // Only an unknown name needs the population's answer; the count is cached.
    let unknown_version = if user.is_none() { unknown_name_srp_version(&state.pool).await } else { 1 };
    let (salt, verifier, real_user, srp_version) = match user {
        Some((s, v, ver)) => (s, v, true, ver),
        None => (
            pseudo_material(
                &state.jwt_secret,
                "sovereign-enum-salt-v1",
                &payload.username,
                32,
            ),
            pseudo_material(
                &state.jwt_secret,
                "sovereign-enum-verifier-v1",
                &payload.username,
                256,
            ),
            false,
            // An unknown name answers with whatever srp_version MOST real
            // accounts have right now (unknown_name_srp_version): every real
            // account is 1 when migration 059 lands, and each becomes 2 as
            // its owner signs in from a current client, so a fixed answer
            // would at some point single out either the migrated or the
            // unmigrated. Tracking the majority keeps an unknown name inside
            // the largest set at every stage; what a caller can still learn
            // is only "this name is unknown OR in the majority".
            unknown_version,
        ),
    };

    // 2. Decode client's A value (before the real/unknown branch below so a
    // malformed A fails identically whether or not the account exists)
    let a_pub = hex::decode(&payload.a_pub_hex).map_err(|_| StatusCode::BAD_REQUEST)?;

    // 3. Initialize SRP Server
    let server = SrpServer::<Sha256>::new(&G_2048);

    // 4. Generate server's ephemeral secret 'b'
    let mut b = [0u8; 64];
    OsRng.fill_bytes(&mut b);

    // 5. Compute 'B' (public ephemeral) — same modexp cost for real and fake users
    let b_pub = server.compute_public_ephemeral(&b, &verifier);

    // 6. Store login attempt (b_secret, a_pub) for step 2 — only for real users
    // (storing for synthesised usernames would let an attacker flood the table).
    // Each attempt carries an opaque attempt_id the client echoes in step-2, so
    // concurrent logins for one username (phone + desktop) don't clobber each
    // other. A synthesised username still returns a throwaway attempt_id so the
    // response is indistinguishable; step-2 then finds no row and does the dummy
    // modexp. The resulting step-2 timing gap is equalised there.
    let attempt_id = Uuid::new_v4().to_string();
    if real_user {
        // Prune this username's stale attempts so abandoned rows don't accumulate
        // (the table is no longer self-collapsing to one row per username).
        let _ = sqlx::query(
            "DELETE FROM login_attempts WHERE username = LOWER($1) AND created_at < NOW() - INTERVAL '10 minutes'"
        )
        .bind(&payload.username)
        .execute(&state.pool)
        .await;
        sqlx::query(
            "INSERT INTO login_attempts (username, b_secret, a_pub, attempt_id) VALUES (LOWER($1), $2, $3, $4)"
        )
        .bind(&payload.username)
        .bind(&b[..])
        .bind(&a_pub)
        .bind(&attempt_id)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            tracing::error!("DB error storing login attempt: {:?}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    }

    Ok(Json(LoginStep1Response {
        salt_hex: hex::encode(&salt),
        b_pub_hex: hex::encode(&b_pub),
        attempt_id,
        srp_version,
    }))
}

/// The claims of a still-valid bearer token on a request that does not run
/// behind the auth middleware (login step 2). Signature and expiry only: the
/// caller decides what a matching bearer is allowed to mean.
fn bearer_claims(headers: &axum::http::HeaderMap, secret: &str) -> Option<(crate::auth::Claims, String)> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")?
        .trim();
    let claims = crate::auth::validate_token(raw, secret).ok()?;
    Some((claims, raw.to_string()))
}

pub async fn login_step_2(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<LoginStep2Request>,
) -> Result<Json<LoginStep2Response>, StatusCode> {
    // Bound the caller-supplied fields FIRST. Everything below — the lowercase
    // for the backoff key, the multi-pass HMAC in `pseudo_material`, and the
    // permanent entry in the login-failure map — scales with these, and none of
    // them was bounded.
    reject_oversized_username(&payload.username)?;
    reject_oversized_hex(&payload.m_hex)?;
    if let Some(aid) = payload.attempt_id.as_deref() {
        reject_oversized_hex(aid)?;
    }

    tracing::info!("login_step_2 called (account {})", crate::logtag::user_tag(&payload.username));

    // M3: per-username exponential backoff. Apply the delay owed from prior
    // consecutive failures BEFORE doing any work, throttling online guessing
    // against the SRP verifier (the per-IP governor is useless behind
    // Cloudflare's shared/rotating IPs). This is added latency, never a hard
    // denial, so it can't be weaponized to lock a victim out.
    let backoff = state.login_backoff_delay(&payload.username);
    if !backoff.is_zero() {
        tokio::time::sleep(backoff).await;
    }

    // 1. Fetch the pending attempt. Prefer the client's own opaque attempt_id
    // (migration 029 allows multiple concurrent attempts per username, so a
    // phone+desktop don't clobber each other); old clients that don't echo one
    // fall back to the most-recent row.
    let attempt: Option<(Vec<u8>, Vec<u8>, i64)> = if let Some(aid) = payload.attempt_id.as_deref() {
        sqlx::query_as(
            "SELECT b_secret, a_pub, id FROM login_attempts WHERE username = LOWER($1) AND attempt_id = $2"
        )
        .bind(&payload.username)
        .bind(aid)
        .fetch_optional(&state.pool)
        .await
    } else {
        sqlx::query_as(
            "SELECT b_secret, a_pub, id FROM login_attempts WHERE username = LOWER($1) ORDER BY created_at DESC, id DESC LIMIT 1"
        )
        .bind(&payload.username)
        .fetch_optional(&state.pool)
        .await
    }
    .map_err(|e| {
        tracing::error!("DB error fetching login_attempt: {:?}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let (b_secret, a_pub, consumed_id) = match attempt {
        Some((b, a, id)) => {
            tracing::info!(
                "  Step2: Found login_attempt id={}, b_secret len={}, a_pub len={}",
                id,
                b.len(),
                a.len()
            );
            (b, a, id)
        }
        None => {
            tracing::error!(
                "  Step2: No login_attempt found for user: {}",
                payload.username
            );
            // This is the path an unknown username reaches (login_step_1 stored
            // nothing for it), and also a stale/duplicate step-2. Burn an
            // equivalent SRP modexp against synthesised material before failing,
            // so the response time matches a real username + wrong password
            // (which pays process_reply below). Without this, a fast 401 here vs
            // a slow 401 for a real account is a user-enumeration timing oracle.
            // (Minor residual: the real path also does one extra users lookup.)
            let dummy_server = SrpServer::<Sha256>::new(&G_2048);
            let dummy_v = pseudo_material(
                &state.jwt_secret,
                "sovereign-enum-verifier-v1",
                &payload.username,
                256,
            );
            let dummy_b = pseudo_material(
                &state.jwt_secret,
                "sovereign-enum-bsecret-v1",
                &payload.username,
                64,
            );
            let dummy_a = pseudo_material(
                &state.jwt_secret,
                "sovereign-enum-apub-v1",
                &payload.username,
                256,
            );
            if let Ok(inst) = dummy_server.process_reply(&dummy_b, &dummy_v, &dummy_a) {
                let _ = inst.verify_client(&[0u8; 32]);
            }
            // Record so the backoff grows symmetrically for real vs. unknown
            // usernames (else repeated failures on a real account would get
            // progressively slower while a fake one stayed fast — a timing oracle).
            state.record_login_failure(&payload.username);
            return Err(StatusCode::UNAUTHORIZED);
        }
    };

    // 2. Fetch user verifier (id is INT4/i32 in PostgreSQL, case-insensitive)
    // Also fetch force_password_reset flag for case-insensitive login migration
    // and token_version so the minted JWT is stamped with the current version.
    let user: Option<(i32, String, Vec<u8>, bool, i32)> = sqlx::query_as(
        "SELECT id, username, verifier, COALESCE(force_password_reset, FALSE), token_version FROM users WHERE LOWER(username) = LOWER($1)"
    )
    .bind(&payload.username)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!("DB error fetching user: {:?}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let (user_id, username, verifier, force_reset, token_version) = match user {
        Some((id, name, v, reset, tv)) => {
            tracing::info!(
                "  Step2: Found user id={}, verifier len={}, force_reset={}",
                id,
                v.len(),
                reset
            );
            (id as i64, name, v, reset, tv) // Cast i32 to i64 for later use
        }
        None => {
            tracing::error!("  Step2: No user found for: {}", payload.username);
            state.record_login_failure(&payload.username);
            return Err(StatusCode::UNAUTHORIZED);
        }
    };

    // Check if user needs to reset password (for case-insensitive login migration)
    if force_reset {
        tracing::info!(
            "  Step2: User {} needs password reset for case-insensitive migration",
            username
        );
        // Clean up THIS attempt row (row-scoped: a username-scoped delete would
        // nuke a concurrent device's still-in-flight attempt).
        let _ = sqlx::query("DELETE FROM login_attempts WHERE id = $1")
            .bind(consumed_id)
            .execute(&state.pool)
            .await;
        // Return 403 Forbidden with specific message
        return Err(StatusCode::FORBIDDEN);
    }

    // 3. Decode client's proof
    let m_proof = hex::decode(&payload.m_hex).map_err(|_| StatusCode::BAD_REQUEST)?;
    tracing::info!("  Step2: Decoded M1 proof, len={}", m_proof.len());

    // 4. Re-initialize Server and verify
    let server = SrpServer::<Sha256>::new(&G_2048);

    let verifier_instance = server
        .process_reply(&b_secret, &verifier, &a_pub)
        .map_err(|e| {
            tracing::error!("SRP process_reply failed for {}: {:?}", payload.username, e);
            state.record_login_failure(&payload.username);
            StatusCode::UNAUTHORIZED
        })?;
    // Attempt verification. Note: never log the derived session key, verifier,
    // or client proof — that is secret cryptographic material.
    if let Err(e) = verifier_instance.verify_client(&m_proof) {
        tracing::warn!("SRP verify_client failed (account {}): {:?}", crate::logtag::user_tag(&payload.username), e);
        state.record_login_failure(&payload.username);
        return Err(StatusCode::UNAUTHORIZED);
    }

    let hamk = verifier_instance.proof();
    // The SRP session key is deliberately NOT bound to anything: it used to be
    // INSERTed into `sessions` and read by nothing (see step 6 below).
    let _session_key = verifier_instance.key();

    // Successful auth — clear this username's failure streak (M3).
    state.clear_login_failures(&payload.username);

    // A legacy (srp_version 1) account sends replacement credentials with its
    // proof — see srpExchange in the client. They are applied HERE and nowhere
    // else: after M1 has verified, so only a login with the real password can
    // rewrite the verifier, and never through an endpoint a bearer token alone
    // could reach. An earlier draft of this feature had exactly that endpoint,
    // and it was a password change without the password.
    //
    // Best effort: a failed upgrade must not fail a correct login; the account
    // stays on v1 and the next login tries again. `AND srp_version = 1` makes
    // a stale attempt (two logins racing) a no-op rather than a downgrade or a
    // second rewrite under a different salt.
    if let (Some(ns), Some(nv)) = (payload.new_salt_hex.as_deref(), payload.new_verifier_hex.as_deref()) {
        let decoded = if ns.len() == 64 && nv.len() == 512 {
            hex::decode(ns).ok().zip(hex::decode(nv).ok())
        } else {
            None
        };
        match decoded {
            Some((new_salt, new_verifier)) => {
                match sqlx::query(
                    "UPDATE users SET salt = $1, verifier = $2, srp_version = 2 WHERE id = $3 AND srp_version = 1",
                )
                .bind(&new_salt)
                .bind(&new_verifier)
                .bind(user_id as i32)
                .execute(&state.pool)
                .await
                {
                    Ok(r) if r.rows_affected() > 0 => tracing::info!(
                        "SRP verifier upgraded to Argon2id (account {})",
                        crate::logtag::user_tag(&payload.username)
                    ),
                    Ok(_) => {}
                    Err(e) => tracing::error!("SRP verifier upgrade failed; account stays on v1: {:?}", e),
                }
            }
            None => tracing::warn!(
                "malformed SRP upgrade material ignored (account {})",
                crate::logtag::user_tag(&payload.username)
            ),
        }
    }

    // This is the ONE place the server verifies knowledge of the password, so
    // it is the only place a password proof may be recorded. Endpoints that
    // rewrite credentials or key custody require a recent one, which is what
    // stops a stolen bearer token from setting a new SRP verifier or clobbering
    // the wrapped identity seed.
    //
    // The proof is bound to ONE session (`sst`), and only a token carrying that
    // session start can spend it. A caller that is ALREADY signed in re-proves
    // the password for a key-custody write (change password, regenerate the
    // recovery code, delete the account) from the session it will spend the
    // proof in — so when a valid bearer for this same user accompanies the
    // exchange, the proof binds to THAT session and the caller gets its own
    // token back. Minting a fresh session here instead (what 0.8.136 did)
    // bound the proof to a token the client threw away, so every in-app
    // password change was refused with "confirm your password" — and it would
    // now also leave an unheld, unrevokable session row behind.
    let reproving = bearer_claims(&headers, &state.jwt_secret).filter(|(c, _)| c.sub == user_id);
    let token = if let Some((claims, raw)) = reproving {
        state.record_password_proof(user_id, claims.sst);
        raw
    } else {
        let session_start = chrono::Utc::now().timestamp();
        state.record_password_proof(user_id, session_start);

        // 5. Create JWT token instead of session, stamped with the current
        // token_version (M1) so a later logout/reset can revoke it, and with a
        // fresh session id so THIS sign-in can be revoked on its own.
        let sid = Uuid::new_v4().to_string();
        let token = crate::ws::create_token_with_start(user_id, &username, token_version, session_start, &sid, &state.jwt_secret)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if let Err(e) = sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2)")
            .bind(&sid)
            .bind(user_id as i32)
            .execute(&state.pool)
            .await
        {
            // The token still works (no row = nothing to revoke); it just cannot be
            // signed out on its own until a renewal records it.
            tracing::warn!("login: could not record session for user {}: {:?}", user_id, e);
        }

        // 6. NOTHING is written to the `sessions` table (L8-DATA-2).
        //
        // This used to INSERT the raw SRP session key — `session_key.as_ref()` into
        // a `BYTEA NOT NULL` column — on every successful login, justified by a
        // comment reading "Also store session in DB for reference". Nothing ever
        // read it: a grep for `FROM sessions`, `DELETE FROM sessions` and
        // `UPDATE sessions` across src/ returns nothing, the `session_id` local
        // never left this function (LoginStep2Response is `{hamk_hex, token}`), and
        // `expires_at` was written but never consulted. Authentication is JWT-based,
        // right above. So the table was a monotonically growing store of one live
        // cryptographic secret per successful login, for the life of the
        // deployment, with no consumer — and it survived account deletion, since
        // the tombstone is an UPDATE and the table's ON DELETE CASCADE never fires.
        //
        // Removing the write also removes a failure mode: the `?` on that query was
        // the only way a healthy login could 500 on a database hiccup.
        //
        // DROPPING THE TABLE IS A SEPARATE, LATER RELEASE. It must land only after
        // a release in which nothing writes it, or a rollback to the previous
        // binary hits a missing relation on every login. The existing rows are
        // historical secrets, and that migration is the point at which they stop
        // existing — which is the entire benefit. A login audit trail, if wanted, is
        // a different table with a different shape (user_id, timestamp, IP hash) and
        // explicitly no key material; do not repurpose this one.
        token
    };

    // 7. Clean up THIS attempt row (row-scoped, so a concurrent device's live
    // attempt survives).
    let _ = sqlx::query("DELETE FROM login_attempts WHERE id = $1")
        .bind(consumed_id)
        .execute(&state.pool)
        .await;

    Ok(Json(LoginStep2Response {
        hamk_hex: hex::encode(hamk),
        token,
    }))
}

/// POST /auth/logout — bump the caller's token_version, invalidating every
/// outstanding JWT for this account (M1). The client should also discard its
/// local token. Idempotent; a 24h bearer token that leaked can now be revoked.
/// Sign out THIS session only: revoke the caller's session id and hang up its
/// sockets. Other devices stay signed in — the per-session half of "sign out"
/// that token_version (per user) could never express. A legacy token has no
/// session id; the client drops it locally and that is all there is to do.
pub async fn logout_session(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<crate::auth::Claims>,
) -> impl IntoResponse {
    // A token minted before the sid claim existed cannot be revoked on its
    // own (there is no row to mark); the client still clears its local state,
    // exactly as sign-out worked before 0.9.0, and the token dies on its own
    // clock — or at its next renewal, which mints a sid. Say so in the body
    // rather than pretending: `revoked: false`.
    if claims.sid.is_empty() {
        tracing::info!("logout-session: user {} holds a pre-sid token; nothing to revoke", claims.sub);
        return Json(serde_json::json!({ "revoked": false, "reason": "legacy-token" })).into_response();
    }
    match sqlx::query("UPDATE token_sessions SET revoked_at = NOW() WHERE sid = $1 AND user_id = $2 AND revoked_at IS NULL")
        .bind(&claims.sid)
        .bind(claims.sub as i32)
        .execute(&state.pool)
        .await
    {
        Ok(done) => {
            state.kill_sid_sessions(claims.sub, &claims.sid);
            Json(serde_json::json!({ "revoked": done.rows_affected() > 0 })).into_response()
        }
        Err(e) => {
            tracing::error!("logout-session: revocation failed for user {}: {:?}", claims.sub, e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to sign out this session").into_response()
        }
    }
}

pub async fn logout(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<crate::auth::Claims>,
) -> impl IntoResponse {
    // ONE transaction. The token bump and the device revocation are the two
    // halves of a single promise ("nothing that was signed in still is"), and
    // running them as separate autocommit statements left a window where the
    // bump had landed and the revocation had not — enrolled devices still able
    // to mint fresh account tokens, with the caller told it had failed and no
    // way to know which half applied. Either both land or neither does.
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("logout: could not begin transaction for user {}: {:?}", claims.sub, e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to log out").into_response();
        }
    };
    if let Err(e) = sqlx::query("UPDATE users SET token_version = token_version + 1 WHERE id = $1")
        .bind(claims.sub as i32)
        .execute(&mut *tx)
        .await
    {
        tracing::error!(
            "logout: failed to bump token_version for user {}: {:?}",
            claims.sub,
            e
        );
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to log out").into_response();
    }
    // Enrolled devices too, or this endpoint does not do what it says.
    //
    // /devices/token is UNAUTHENTICATED by necessity (a machine at its own
    // sign-in screen has no credential yet) and re-reads token_version at mint
    // time, so the bump above is absorbed: a device still holding its Ed25519
    // key mints a fresh full-account JWT immediately afterwards, and the first
    // request renews it into a new sliding session. Revoking the account's
    // tokens while leaving its devices able to mint more is not revocation.
    if let Err(e) = sqlx::query(
        "UPDATE token_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(claims.sub as i32)
    .execute(&mut *tx)
    .await
    {
        tracing::error!("logout: session revocation failed for user {}, rolling back: {:?}", claims.sub, e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Could not sign out everywhere. Nothing was changed — try again.").into_response();
    }
    if let Err(e) = sqlx::query(
        "UPDATE devices SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(claims.sub as i32)
    .execute(&mut *tx)
    .await
    {
        // Dropping `tx` without commit rolls the bump back too, so the account
        // is left exactly as it was and "Try again" is honest advice.
        tracing::error!(
            "logout: device revocation failed for user {}, rolling back: {:?}",
            claims.sub,
            e
        );
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not sign out everywhere. Nothing was changed — try again.",
        )
            .into_response();
    }
    if let Err(e) = tx.commit().await {
        tracing::error!("logout: commit failed for user {}: {:?}", claims.sub, e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not sign out everywhere. Nothing was changed — try again.",
        )
            .into_response();
    }
    // The bump only refuses the next REST call or WS upgrade — an already-open
    // socket re-checks the JWT's expiry per frame but never its version, so
    // without this a revoked token kept a live, fully privileged connection for
    // the rest of its 24h lifetime. (The app's own sign-out is deliberately
    // local-only and never reaches here; this endpoint exists precisely for
    // account-wide revocation of a leaked token, which has to include sockets.)
    state.disconnect_user(claims.sub);
    StatusCode::OK.into_response()
}

/// Reset password for users with force_password_reset=true
/// This allows migrated users to set a new password without email verification
pub async fn reset_password(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ResetPasswordRequest>,
) -> impl IntoResponse {
    // Bounds FIRST, above the disabled-by-default gate below. The gate's own
    // branch formats the username into a warning log, so a guard placed after it
    // still let a megabyte of caller-supplied text through on a stock server —
    // the one configuration nearly every deployment runs.
    if reject_oversized_username(&payload.username).is_err()
        || reject_oversized_hex(&payload.salt_hex).is_err()
        || reject_oversized_hex(&payload.verifier_hex).is_err()
    {
        return (StatusCode::BAD_REQUEST, "Invalid request").into_response();
    }

    // SECURITY: this endpoint overwrites an account's SRP salt+verifier with NO
    // proof of identity — it treats force_password_reset=TRUE as authorization.
    // That makes any such account (the case-insensitive-login migration flagged
    // every mixed-case username) takeover-able by anyone who knows the username.
    // It is a one-time legacy migration tool, superseded by the proof-gated E2EE
    // recovery flow (/auth/recovery/*) and email reset (/auth/reset-password), so
    // it is DISABLED unless an operator explicitly opts in for a migration window.
    if std::env::var("ALLOW_MIGRATION_PASSWORD_RESET")
        .ok()
        .as_deref()
        != Some("true")
    {
        tracing::warn!(
            "Blocked disabled reset-password-migration for {} (set ALLOW_MIGRATION_PASSWORD_RESET=true to enable)",
            payload.username
        );
        return (
            StatusCode::FORBIDDEN,
            "This recovery method is disabled. Use account recovery or email password reset instead.",
        )
            .into_response();
    }


    tracing::info!("reset_password called (account {})", crate::logtag::user_tag(&payload.username));

    // Decode hex values
    let salt = match hex::decode(&payload.salt_hex) {
        Ok(s) => s,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid salt hex").into_response(),
    };
    let verifier = match hex::decode(&payload.verifier_hex) {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid verifier hex").into_response(),
    };

    // Check if user exists and has force_password_reset=true
    let user: Option<(i32, bool)> = sqlx::query_as(
        "SELECT id, COALESCE(force_password_reset, FALSE) FROM users WHERE LOWER(username) = LOWER($1)"
    )
    .bind(&payload.username)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    match user {
        Some((user_id, force_reset)) => {
            if !force_reset {
                // User doesn't need password reset - this endpoint is only for migrated users
                tracing::warn!(
                    "User {} tried to reset password but force_password_reset is false",
                    payload.username
                );
                return (
                    StatusCode::FORBIDDEN,
                    "Password reset not required for this account",
                )
                    .into_response();
            }

            // Update salt and verifier, clear force_password_reset flag
            let result = sqlx::query(
                "UPDATE users SET salt = $1, verifier = $2, srp_version = $3, force_password_reset = FALSE WHERE id = $4"
            )
            .bind(&salt)
            .bind(&verifier)
            .bind(payload.srp_version.map(SrpVersion::get).unwrap_or(1))
            .bind(user_id)
            .execute(&state.pool)
            .await;

            match result {
                Ok(_) => {
                    tracing::info!("Password reset successful (account {})", crate::logtag::user_tag(&payload.username));
                    (
                        StatusCode::OK,
                        "Password reset successful. You can now login.",
                    )
                        .into_response()
                }
                Err(e) => {
                    tracing::error!(
                        "Failed to update password for {}: {:?}",
                        payload.username,
                        e
                    );
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Failed to reset password",
                    )
                        .into_response()
                }
            }
        }
        None => {
            tracing::warn!(
                "Password reset attempted for non-existent user: {}",
                payload.username
            );
            (StatusCode::NOT_FOUND, "User not found").into_response()
        }
    }
}

// --- Profile DTOs ---

#[derive(Deserialize)]
pub struct UpdateProfileRequest {
    pub avatar_file_id: Option<String>,
    pub display_name: Option<String>,
    /// Privacy: when false, only accepted friends can DM this user.
    pub allow_dms_from_server_members: Option<bool>,
    /// Privacy: when false, presence reports this user as offline to others.
    pub show_online_status: Option<bool>,
    /// Custom voice join/leave clips OTHERS hear (empty string clears).
    pub join_sound_file_id: Option<String>,
    pub leave_sound_file_id: Option<String>,
}

#[derive(Serialize)]
pub struct ProfileResponse {
    pub id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub allow_dms_from_server_members: bool,
    pub show_online_status: bool,
    pub join_sound_file_id: Option<String>,
    pub leave_sound_file_id: Option<String>,
}

// --- Profile Handlers ---

/// Get current user's profile
pub async fn get_profile(
    State(state): State<Arc<AppState>>,
    axum::Extension(claims): axum::Extension<crate::auth::Claims>,
) -> impl IntoResponse {
    tracing::info!(">>> get_profile called for user_id={}", claims.sub);

    // users.id is INTEGER (i32) in PostgreSQL
    let user: Option<(i32, String, Option<String>, Option<String>, bool, bool, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, username, display_name, avatar_file_id, allow_dms_from_server_members, show_online_status, \
                join_sound_file_id, leave_sound_file_id \
         FROM users WHERE id = $1"
    )
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    match user {
        Some((
            id,
            username,
            display_name,
            avatar_file_id,
            allow_dms,
            show_online,
            join_sound,
            leave_sound,
        )) => {
            tracing::info!(
                "get_profile: user={}, display_name={:?}, avatar_file_id={:?}",
                username,
                display_name,
                avatar_file_id
            );
            let avatar_url = avatar_file_id.map(|f| format!("/files/{}", f));
            Json(ProfileResponse {
                id: id as i64,
                username,
                display_name,
                avatar_url,
                allow_dms_from_server_members: allow_dms,
                show_online_status: show_online,
                join_sound_file_id: join_sound,
                leave_sound_file_id: leave_sound,
            })
            .into_response()
        }
        None => (StatusCode::NOT_FOUND, "User not found").into_response(),
    }
}

/// Update current user's profile (avatar or display name)
pub async fn update_profile(
    State(state): State<Arc<AppState>>,
    axum::Extension(claims): axum::Extension<crate::auth::Claims>,
    Json(payload): Json<UpdateProfileRequest>,
) -> impl IntoResponse {
    tracing::info!(
        ">>> update_profile called for user_id={}, avatar_file_id={:?}, display_name={:?}",
        claims.sub,
        payload.avatar_file_id,
        payload.display_name
    );

    // M15 deletion hook: when replacing the avatar, remember the old file so we
    // can reclaim its blob after a successful update (avatars are per-user and
    // not shared, so the old one is safe to remove).
    let old_avatar: Option<String> = if payload.avatar_file_id.is_some() {
        sqlx::query_as::<_, (Option<String>,)>("SELECT avatar_file_id FROM users WHERE id = $1")
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
            .and_then(|(a,)| a)
    } else {
        None
    };

    // Same reclaim hook for the custom join/leave clips. Without it, every
    // Replace/Remove in the sound UI left the previous blob referenced by
    // nothing but still counted against the uploader's storage quota — a
    // one-way ratchet with no way to free it (delete_file is guarded while
    // referenced, and after the swap the id is no longer in the UI at all).
    let (old_join_sound, old_leave_sound): (Option<String>, Option<String>) =
        if payload.join_sound_file_id.is_some() || payload.leave_sound_file_id.is_some() {
            sqlx::query_as::<_, (Option<String>, Option<String>)>(
                "SELECT join_sound_file_id, leave_sound_file_id FROM users WHERE id = $1",
            )
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
            .unwrap_or((None, None))
        } else {
            (None, None)
        };

    // Presence is only re-broadcast when the flag actually FLIPS. The client
    // sends the whole privacy block on every toggle in that card, so without
    // this an unrelated change (or a client re-sending the same value) fanned a
    // UserOnline/UserOffline out to the user's entire presence audience, with
    // nothing but the global per-IP limiter in front of it.
    let prev_show_online: Option<bool> = if payload.show_online_status.is_some() {
        sqlx::query_as::<_, (bool,)>("SELECT show_online_status FROM users WHERE id = $1")
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
            .map(|(b,)| b)
    } else {
        None
    };

    // Cap display_name like every other user-supplied string here (message
    // 8000, nickname 32, emoji name 64…). users.display_name is plain TEXT and
    // is fanned out on every message row, so an unbounded value is echoed to
    // the whole channel repeatedly.
    if let Some(ref display_name) = payload.display_name {
        if display_name.chars().count() > MAX_DISPLAY_NAME_LEN {
            return (StatusCode::PAYLOAD_TOO_LARGE, "Display name too long").into_response();
        }
    }

    // The avatar must be a file THIS user uploaded. delete_file refuses with 409
    // while any user's avatar references a blob, so pointing your avatar at
    // someone else's file id pinned their storage quota permanently — they
    // could never reclaim it.
    if let Some(ref avatar_id) = payload.avatar_file_id {
        if !avatar_id.trim().is_empty() {
            let owned: Option<(i32,)> =
                sqlx::query_as("SELECT uploader_id FROM uploaded_files WHERE id = $1::uuid")
                    .bind(avatar_id)
                    .fetch_optional(&state.pool)
                    .await
                    .unwrap_or(None);
            match owned {
                Some((uid,)) if uid == claims.sub as i32 => {}
                _ => {
                    return (StatusCode::FORBIDDEN, "Avatar must be a file you uploaded")
                        .into_response()
                }
            }
        }
    }

    // Join/leave sounds: same ownership rule as the avatar (a foreign file id
    // would pin someone else's quota), PLUS the file must actually be a small
    // audio clip — every member of every shared voice room downloads it, and
    // the declared mime is the only type signal the upload path records.
    const MAX_SOUND_BYTES: i64 = 1024 * 1024;
    for (label, field) in [
        ("Join sound", &payload.join_sound_file_id),
        ("Leave sound", &payload.leave_sound_file_id),
    ] {
        if let Some(ref file_id) = field {
            if !file_id.trim().is_empty() {
                let row: Option<(i32, String, i64)> = sqlx::query_as(
                    "SELECT uploader_id, mime_type, size_bytes FROM uploaded_files WHERE id = $1::uuid"
                )
                .bind(file_id)
                .fetch_optional(&state.pool)
                .await
                .unwrap_or(None);
                match row {
                    Some((uid, ref mime, size))
                        if uid == claims.sub as i32
                            && mime.starts_with("audio/")
                            && size <= MAX_SOUND_BYTES => {}
                    Some((uid, _, _)) if uid != claims.sub as i32 => {
                        return (
                            StatusCode::FORBIDDEN,
                            format!("{} must be a file you uploaded", label),
                        )
                            .into_response();
                    }
                    _ => {
                        return (
                            StatusCode::BAD_REQUEST,
                            format!("{} must be an audio file under 1 MB", label),
                        )
                            .into_response();
                    }
                }
            }
        }
    }

    // Build dynamic update query based on what's provided
    let mut updates = Vec::new();
    let mut param_idx = 1;

    if payload.avatar_file_id.is_some() {
        updates.push(format!("avatar_file_id = ${}", param_idx));
        param_idx += 1;
    }

    if payload.display_name.is_some() {
        updates.push(format!("display_name = ${}", param_idx));
        param_idx += 1;
    }

    if payload.allow_dms_from_server_members.is_some() {
        updates.push(format!("allow_dms_from_server_members = ${}", param_idx));
        param_idx += 1;
    }

    if payload.show_online_status.is_some() {
        updates.push(format!("show_online_status = ${}", param_idx));
        param_idx += 1;
    }

    if payload.join_sound_file_id.is_some() {
        updates.push(format!("join_sound_file_id = ${}", param_idx));
        param_idx += 1;
    }

    if payload.leave_sound_file_id.is_some() {
        updates.push(format!("leave_sound_file_id = ${}", param_idx));
        param_idx += 1;
    }

    if updates.is_empty() {
        return StatusCode::OK.into_response();
    }

    let query = format!(
        "UPDATE users SET {} WHERE id = ${}",
        updates.join(", "),
        param_idx
    );

    let mut query_builder = sqlx::query(&query);

    if let Some(ref avatar_id) = payload.avatar_file_id {
        query_builder = query_builder.bind(avatar_id);
    }
    if let Some(ref display_name) = payload.display_name {
        // Allow empty string to clear display name (set to null)
        let name = if display_name.trim().is_empty() {
            None
        } else {
            Some(display_name.clone())
        };
        query_builder = query_builder.bind(name);
    }
    if let Some(allow_dms) = payload.allow_dms_from_server_members {
        query_builder = query_builder.bind(allow_dms);
    }
    if let Some(show_online) = payload.show_online_status {
        query_builder = query_builder.bind(show_online);
    }
    if let Some(ref join_sound) = payload.join_sound_file_id {
        // Empty string clears (same convention as display_name).
        let v = if join_sound.trim().is_empty() {
            None
        } else {
            Some(join_sound.clone())
        };
        query_builder = query_builder.bind(v);
    }
    if let Some(ref leave_sound) = payload.leave_sound_file_id {
        let v = if leave_sound.trim().is_empty() {
            None
        } else {
            Some(leave_sound.clone())
        };
        query_builder = query_builder.bind(v);
    }
    query_builder = query_builder.bind(claims.sub as i32);

    match query_builder.execute(&state.pool).await {
        Ok(r) => {
            tracing::info!("update_profile: rows_affected={}", r.rows_affected());
            // Reclaim the replaced avatar blob if it actually changed.
            if let (Some(old), Some(new)) = (&old_avatar, &payload.avatar_file_id) {
                if old != new {
                    crate::upload_handlers::remove_file(&state.pool, old, claims.sub).await;
                }
            }
            // Same for the join/leave clips. An empty string is the documented
            // "clear it" value, so a clear reclaims too — `old != new` covers
            // both replace ("" != new id) and clear (old id != "").
            for (old, new) in [
                (&old_join_sound, &payload.join_sound_file_id),
                (&old_leave_sound, &payload.leave_sound_file_id),
            ] {
                if let (Some(old), Some(new)) = (old, new) {
                    if old != new && !old.is_empty() {
                        crate::upload_handlers::remove_file(&state.pool, old, claims.sub).await;
                    }
                }
            }
            // Flipping "show online status" while connected takes effect NOW:
            // tell everyone who can see this user's presence the new apparent
            // state, instead of waiting for the next disconnect/reconnect.
            //
            // Only on a real flip. The synthetic `UserOffline` is additionally
            // never sent to someone sharing a live voice room — see
            // `voice_room_peers`: it is indistinguishable from a genuine
            // disconnect on the wire, so an unfiltered broadcast ended
            // remote-control sessions and emptied voice rosters for a user who
            // had not gone anywhere. `UserOnline` carries no such hazard and
            // goes to everyone — skipping voice peers on the visible flip left
            // them showing the user offline until the next real reconnect.
            if let (Some(show), Some(prev)) = (payload.show_online_status, prev_show_online) {
                // Visibly online: flipping the setting while only the phone's
                // delivery socket lives must not paint a green dot for a user
                // who is not actually at any client.
                if show != prev && state.is_user_visibly_online(claims.sub) {
                    let msg = if show {
                        crate::protocol::ServerMessage::UserOnline {
                            user: crate::protocol::UserInfo::new(
                                claims.sub,
                                claims.username.clone(),
                            ),
                        }
                    } else {
                        crate::protocol::ServerMessage::UserOffline {
                            user_id: claims.sub,
                        }
                    };
                    let in_voice_with_me = crate::ws::voice_room_peers(&state, claims.sub);
                    for audience_id in crate::ws::presence_audience(&state, claims.sub).await {
                        if !show && in_voice_with_me.contains(&audience_id) {
                            continue;
                        }
                        state.send_to_user(audience_id, msg.clone());
                    }
                }
            }
            StatusCode::OK.into_response()
        }
        Err(e) => {
            tracing::error!("Failed to update profile: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to update profile",
            )
                .into_response()
        }
    }
}

// --- E2EE Endpoints ---

#[derive(Serialize)]
pub struct PublicKeyResponse {
    pub user_id: i64,
    pub public_key: Option<String>,
}

/// Get a user's public key for E2EE
pub async fn get_user_public_key(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i64>,
    Extension(_claims): Extension<crate::auth::Claims>,
) -> impl IntoResponse {
    let result: Option<(Option<String>,)> =
        sqlx::query_as("SELECT public_key FROM users WHERE id = $1")
            .bind(user_id as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    match result {
        Some((public_key,)) => Json(PublicKeyResponse {
            user_id,
            public_key,
        })
        .into_response(),
        None => (StatusCode::NOT_FOUND, "User not found").into_response(),
    }
}

/// A history-key pair as a client submits it: both halves or neither, each of
/// a size an honest client produces. The server stores them opaquely.
pub fn validate_history_key_pair(
    pubkey: &Option<String>,
    wrapped: &Option<String>,
    sig: &Option<String>,
) -> Result<(), &'static str> {
    match (pubkey, wrapped, sig) {
        (None, None, None) => Ok(()),
        (Some(p), Some(w), Some(g)) => {
            if p.len() < 8 || p.len() > 128 || p.chars().any(|c| c.is_control()) {
                return Err("history_pubkey is malformed");
            }
            if w.len() < 16 || w.len() > 512 || w.chars().any(|c| c.is_control()) {
                return Err("history_wrapped_rc is malformed");
            }
            validate_key_sig(g).map_err(|_| "history_pubkey_sig is malformed")
        }
        _ => Err("history_pubkey, history_wrapped_rc and history_pubkey_sig must be sent together"),
    }
}

fn base64_len(s: &str) -> Option<usize> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok().map(|b| b.len())
}

/// An Ed25519 signature as the client encodes it: base64 of exactly 64 bytes.
pub fn validate_key_sig(sig: &str) -> Result<(), &'static str> {
    if sig.len() > 128 || base64_len(sig) != Some(64) {
        return Err("signature is malformed");
    }
    Ok(())
}

/// `ed25519:` + base64 of exactly 32 bytes, the form dmKeys.ts and the device
/// enrolment code both publish. Strict on purpose: this column is write-once
/// below, so junk must not be storable at all.
pub fn validate_account_sign_pub(key: &str) -> Result<(), &'static str> {
    let Some(body) = key.strip_prefix("ed25519:") else {
        return Err("account_sign_pub is malformed");
    };
    if key.len() > 128 || base64_len(body) != Some(32) {
        return Err("account_sign_pub is malformed");
    }
    Ok(())
}

/// Record the account signing key an account publishes. WRITE-ONCE for a
/// bare bearer token: a key already on the row must be the same one, so a
/// stolen token cannot swap in a key of its own. A session that has just
/// PROVED THE PASSWORD (`may_replace`, from password_recently_proven — every
/// fresh sign-in records one) may replace it: the key derives from the
/// identity seed, so the owner's devices all agree on it, and this is how
/// an owner recovers if a first write was not theirs. Ok(true) = recorded,
/// replaced, or already equal; Ok(false) = a different key is on the row
/// and the caller may not replace it.
pub async fn record_account_sign_pub(pool: &sqlx::PgPool, user_id: i32, key: &str, may_replace: bool) -> Result<bool, sqlx::Error> {
    let r = if may_replace {
        sqlx::query("UPDATE users SET account_sign_pub = $1 WHERE id = $2")
            .bind(key)
            .bind(user_id)
            .execute(pool)
            .await?
    } else {
        sqlx::query(
            "UPDATE users SET account_sign_pub = $1 WHERE id = $2 AND (account_sign_pub IS NULL OR account_sign_pub = $1)",
        )
        .bind(key)
        .bind(user_id)
        .execute(pool)
        .await?
    };
    Ok(r.rows_affected() > 0)
}

/// The srp_version an UNKNOWN username answers with in login step 1: the one
/// MOST real accounts have, re-counted at most every five minutes. See the
/// comment at the call site for why a constant cannot do this job.
static UNKNOWN_SRP_VERSION: std::sync::Mutex<Option<(std::time::Instant, i16)>> = std::sync::Mutex::new(None);
const UNKNOWN_SRP_VERSION_TTL: std::time::Duration = std::time::Duration::from_secs(300);

pub(crate) async fn unknown_name_srp_version(pool: &sqlx::PgPool) -> i16 {
    if let Ok(g) = UNKNOWN_SRP_VERSION.lock() {
        if let Some((at, v)) = *g {
            if at.elapsed() < UNKNOWN_SRP_VERSION_TTL {
                return v;
            }
        }
    }
    let v: i16 = sqlx::query_scalar::<_, i16>(
        "SELECT srp_version FROM users WHERE deleted_at IS NULL GROUP BY srp_version ORDER BY count(*) DESC, srp_version DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .unwrap_or(1);
    if let Ok(mut g) = UNKNOWN_SRP_VERSION.lock() {
        *g = Some((std::time::Instant::now(), v));
    }
    v
}

/// Sessions the server counts when deciding whether every client of an
/// account can open a v4 envelope. A session not seen for longer than this
/// is ignored — its owner, coming back, may find v4 messages it must update
/// (or unlock with the recovery code) to read; the FAQ says so. Mirrored by
/// RECENT_SESSION_DAYS in the client.
const DM_RECENT_SESSION_DAYS: i32 = 14;

/// A published DM key together with the account's signature over it — the
/// client verifies the signature against the TOFU-pinned account signing key
/// and wraps to NOTHING that fails (dmKeys.ts verifyDmKeyInfo).
#[derive(Serialize)]
pub struct SignedDmKey {
    pub key: String,
    pub sig: String,
}

#[derive(Serialize)]
pub struct DmKeysResponse {
    pub user_id: i64,
    /// The account's Ed25519 signing key. Not trusted on sight: the client
    /// checks `attestation` (below) before it verifies anything under it.
    pub account_sign_pub: Option<String>,
    /// The target's attestation of that signing key TO THE CALLER — an HMAC
    /// under the pairwise identity secret, stored on the shared conversation
    /// row by the target's own client (set_dm_sign_attestation). None for
    /// oneself, or until the target's client has opened the conversation.
    pub attestation: Option<String>,
    /// The account's history key, or None for an account that has not set one up.
    pub history: Option<SignedDmKey>,
    /// Session keys of every recently-seen, unrevoked, human session that
    /// published one. Device-token sessions (the headless host service) are
    /// not DM readers and are not listed — nor counted below.
    pub sessions: Vec<SignedDmKey>,
    /// Every recently-seen human session published a signed key and reads v4.
    pub all_sessions_v4: bool,
}

/// GET /users/:user_id/dm-keys — what a v4 direct message to (or from) this
/// user must be wrapped to, and whether every client they use can open one.
/// The user themself, or someone who already shares a DM conversation with
/// them: the identity key is public to any member, but a list of session
/// keys says how many devices someone uses, which a stranger has no claim on.
pub async fn get_user_dm_keys(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i64>,
    Extension(claims): Extension<crate::auth::Claims>,
) -> impl IntoResponse {
    let me = claims.sub as i32;
    let target = user_id as i32;
    let mut attestation: Option<String> = None;
    if me != target {
        // user1_id/user2_id are BIGINT since migration 019: decode as i64, or
        // the row silently reads as "no conversation" (unwrap_or below).
        let shares: Option<(i64, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT user1_id, user1_sign_attest, user2_sign_attest FROM dm_conversations \
             WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1) LIMIT 1",
        )
        .bind(me)
        .bind(target)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
        let Some((user1, a1, a2)) = shares else {
            return (StatusCode::NOT_FOUND, "No conversation with this user").into_response();
        };
        attestation = if user1 == i64::from(target) { a1 } else { a2 };
    }
    let account: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT history_pubkey, history_pubkey_sig, account_sign_pub FROM users WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(target)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    let Some((history_pubkey, history_pubkey_sig, account_sign_pub)) = account else {
        return (StatusCode::NOT_FOUND, "User not found").into_response();
    };
    let history = match (history_pubkey, history_pubkey_sig) {
        (Some(key), Some(sig)) => Some(SignedDmKey { key, sig }),
        _ => None,
    };
    // Client sessions only (NOT headless): the host service mints device-token
    // sessions that never publish a key and never read a DM, and counting them
    // would hold every enrolled account on v3 for good. (device_id is NOT the
    // discriminator — every attested app session carries one.)
    let rows: Vec<(Option<String>, Option<String>, Option<i16>)> = sqlx::query_as(
        "SELECT dm_pubkey, dm_pubkey_sig, reads_up_to FROM token_sessions \
         WHERE user_id = $1 AND revoked_at IS NULL AND NOT headless \
           AND last_seen_at > NOW() - make_interval(days => $2)",
    )
    .bind(target)
    .bind(DM_RECENT_SESSION_DAYS)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    let mut sessions: Vec<SignedDmKey> = rows
        .iter()
        .filter_map(|(p, g, _)| match (p, g) {
            (Some(key), Some(sig)) => Some(SignedDmKey { key: key.clone(), sig: sig.clone() }),
            _ => None,
        })
        .collect();
    sessions.sort_by(|a, b| a.key.cmp(&b.key));
    sessions.dedup_by(|a, b| a.key == b.key);
    let all_sessions_v4 = !rows.is_empty()
        && rows.iter().all(|(p, g, r)| p.is_some() && g.is_some() && r.map_or(false, |r| r >= 4));
    Json(DmKeysResponse { user_id, account_sign_pub, attestation, history, sessions, all_sessions_v4 }).into_response()
}

#[derive(Deserialize)]
pub struct DmSignAttestRequest {
    /// base64 HMAC-SHA256 over dmSignAttestRecord(me, peer, my account_sign_pub)
    /// under HKDF(X25519(my identity, peer identity), 'puca-dm-sign-attest-v1').
    pub mac: String,
}

/// PATCH /dms/:conversation_id/sign-attest — the caller vouches, to the other
/// participant, for its own account signing key. The server stores the MAC on
/// the caller's side of the conversation row and serves it back through
/// /users/:id/dm-keys; it cannot compute or forge one (it never holds an
/// identity private key), and the peer's client checks it before trusting
/// any signature under that signing key. Overwriting is fine: the peer only
/// ever accepts a MAC that matches what it computes itself.
pub async fn set_dm_sign_attestation(
    State(state): State<Arc<AppState>>,
    Path(conversation_id): Path<String>,
    Extension(claims): Extension<crate::auth::Claims>,
    Json(payload): Json<DmSignAttestRequest>,
) -> impl IntoResponse {
    if payload.mac.len() < 40 || payload.mac.len() > 128 || payload.mac.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return (StatusCode::BAD_REQUEST, "mac is malformed").into_response();
    }
    if conversation_id.len() > 64 || conversation_id.chars().any(|c| c.is_control()) {
        return (StatusCode::BAD_REQUEST, "bad conversation id").into_response();
    }
    let me = claims.sub as i32;
    match sqlx::query(
        "UPDATE dm_conversations SET \
            user1_sign_attest = CASE WHEN user1_id = $2 THEN $1 ELSE user1_sign_attest END, \
            user2_sign_attest = CASE WHEN user2_id = $2 THEN $1 ELSE user2_sign_attest END \
         WHERE id = $3 AND (user1_id = $2 OR user2_id = $2)",
    )
    .bind(&payload.mac)
    .bind(me)
    .bind(&conversation_id)
    .execute(&state.pool)
    .await
    {
        Ok(r) if r.rows_affected() > 0 => StatusCode::OK.into_response(),
        Ok(_) => (StatusCode::FORBIDDEN, "Not a participant of this conversation").into_response(),
        Err(e) => {
            tracing::error!("Failed to store DM signing-key attestation: {:?}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct SessionDmKeyRequest {
    pub dm_pubkey: String,
    /// Signature over dmKeyRecord('session', dm_pubkey) by the account signing
    /// key below.
    pub dm_pubkey_sig: String,
    /// The account signing key that made the signature (`ed25519:` + base64);
    /// recorded write-once on the account (record_account_sign_pub).
    pub account_sign_pub: String,
    /// The highest envelope version this client can open.
    pub reads_up_to: i16,
}

/// PATCH /keys/session-dm — this session's DM key and readable version.
///
/// Bound to the caller's own session id, so one device cannot publish a key
/// for another; revoking the session retires the key with it. WRITE-ONCE per
/// session: a key already on the row must be the same one (reads_up_to may
/// still rise). A stolen bearer token therefore cannot swap in a key of its
/// own — and even a fresh session it opens cannot make a signature the
/// account's peers will accept, because the signing key derives from the
/// identity seed the thief does not hold. The client publishes once per
/// session and keeps the private half beside the token, so it never needs a
/// second, different publish.
pub async fn set_session_dm_key(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<crate::auth::Claims>,
    Json(payload): Json<SessionDmKeyRequest>,
) -> impl IntoResponse {
    if claims.sid.is_empty() {
        // A token from before per-session ids; its next renewal mints one.
        return (StatusCode::BAD_REQUEST, "this session has no id yet; it will after the next token renewal").into_response();
    }
    if payload.dm_pubkey.len() < 8 || payload.dm_pubkey.len() > 128 || payload.dm_pubkey.chars().any(|c| c.is_control()) {
        return (StatusCode::BAD_REQUEST, "dm_pubkey is malformed").into_response();
    }
    if validate_key_sig(&payload.dm_pubkey_sig).is_err() {
        return (StatusCode::BAD_REQUEST, "dm_pubkey_sig is malformed").into_response();
    }
    if let Err(msg) = validate_account_sign_pub(&payload.account_sign_pub) {
        return (StatusCode::BAD_REQUEST, msg).into_response();
    }
    if !(2..=32).contains(&payload.reads_up_to) {
        return (StatusCode::BAD_REQUEST, "reads_up_to is out of range").into_response();
    }
    let uid = claims.sub as i32;
    let may_replace = state.password_recently_proven(claims.sub, claims.sst);
    match record_account_sign_pub(&state.pool, uid, &payload.account_sign_pub, may_replace).await {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::CONFLICT,
                "this account already published a different signing key; sign out and in again on this device",
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("Failed to record account signing key: {:?}", e);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    match sqlx::query(
        "UPDATE token_sessions SET dm_pubkey = $1, dm_pubkey_sig = $2, reads_up_to = $3 \
         WHERE sid = $4 AND user_id = $5 AND revoked_at IS NULL AND NOT headless \
           AND (dm_pubkey IS NULL OR dm_pubkey = $1)",
    )
    .bind(&payload.dm_pubkey)
    .bind(&payload.dm_pubkey_sig)
    .bind(payload.reads_up_to)
    .bind(&claims.sid)
    .bind(uid)
    .execute(&state.pool)
    .await
    {
        Ok(r) if r.rows_affected() > 0 => StatusCode::OK.into_response(),
        Ok(_) => {
            // Distinguish "no such live session" from "it already holds
            // another key" — the second is what the write-once rule refuses.
            let taken: Option<(bool,)> = sqlx::query_as(
                "SELECT dm_pubkey IS NOT NULL FROM token_sessions WHERE sid = $1 AND user_id = $2 AND revoked_at IS NULL AND NOT headless",
            )
            .bind(&claims.sid)
            .bind(uid)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
            match taken {
                Some((true,)) => (StatusCode::CONFLICT, "this session already published a different key").into_response(),
                _ => (StatusCode::NOT_FOUND, "session not found").into_response(),
            }
        }
        Err(e) => {
            tracing::error!("Failed to set session DM key: {:?}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct UpdatePublicKeyRequest {
    pub public_key: String,
}

/// Update the current user's public key.
///
/// Write-once for v3 accounts. The unauthenticated recovery reset authorizes
/// purely on possession of the private key matching `users.public_key`, so an
/// overwritable key turns a stolen bearer token into permanent ownership:
/// install your own keypair, then reset the SRP verifier through recovery and
/// lock the real owner out — and because the stored key no longer matches the
/// owner's seed, it also destroys THEIR recovery path. The only legitimate
/// caller is the legacy v2 -> v3 migration in frontend/src/api/auth.ts, which
/// runs while the account is still key_version 2; v3 accounts set public_key at
/// registration and never re-upload it.
pub async fn update_public_key(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<crate::auth::Claims>,
    Json(payload): Json<UpdatePublicKeyRequest>,
) -> impl IntoResponse {
    // A bare bearer token must not be enough for this: it is a key-custody
    // write like every other, and a stolen token is the threat model.
    if let Err(r) = crate::recovery_handlers::require_password_proof(&state, claims.sub, claims.sst) {
        return r;
    }
    // Reject anything that isn't a well-formed identity key: a garbage value
    // permanently disables recovery (the decoder returns None -> uniform 401)
    // and breaks DM addressing.
    if crate::recovery_handlers::decode_public_key(&payload.public_key).is_none() {
        return (StatusCode::BAD_REQUEST, "Malformed public key").into_response();
    }

    let existing: Option<(Option<String>, Option<i32>)> =
        sqlx::query_as("SELECT public_key, key_version FROM users WHERE id = $1")
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    if let Some((Some(current), key_version)) = existing {
        // Idempotent re-upload of the SAME key is fine; a CHANGE on a v3
        // account is the takeover path and is refused.
        if current != payload.public_key && key_version.unwrap_or(2) >= 3 {
            tracing::warn!(
                "update_public_key refused: user {} tried to replace an established v3 identity key",
                claims.sub
            );
            return (
                StatusCode::CONFLICT,
                "Identity key is already established for this account",
            )
                .into_response();
        }
    }

    // A new identity key means a new seed, and the account signing key derives
    // from the seed: clear the published one so the next publish (which is
    // write-once, record_account_sign_pub) can set the new value.
    let result = sqlx::query("UPDATE users SET public_key = $1, account_sign_pub = NULL WHERE id = $2")
        .bind(&payload.public_key)
        .bind(claims.sub as i32)
        .execute(&state.pool)
        .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to update public key: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to update public key",
            )
                .into_response()
        }
    }
}

// --- Account deletion ---

#[derive(Deserialize)]
pub struct DeleteAccountRequest {
    /// The exact username, retyped — the deliberate-action check. The PASSWORD
    /// proof happens client-side the same way change-password does: the client
    /// must first unwrap the E2EE seed with the current password, so a stolen
    /// session token alone cannot reach this call through the UI flow.
    pub confirm_username: String,
}

/// Every row an account deletion removes outright, in the order the transaction
/// runs them. `$1` is the user id in every statement.
///
/// A NAMED ARRAY, ITERATED BY `delete_account`, so the tombstone's residue is a
/// reviewable list rather than a shape you have to read a loop to discover —
/// and so a test can hold it, which is what turns "we decided" into something
/// that stays decided.
///
/// member_roles is in this list because leaving it behind survives the
/// membership deletion: get_user_channel_permissions ORs every member_roles row
/// for the server, so re-joining later (a public server, or any shared invite)
/// would silently restore the old grants — an Admin role included. Both other
/// paths that end a membership, kick_member and leave_server, already delete it
/// first.
///
/// What is deliberately NOT here — messages and tasks (other people's
/// conversations, and the server cannot read them to decide otherwise), the
/// device ROWS themselves (revoked rather than deleted, because device_shares
/// reference them and "a REVOKED device stays revoked" is enrol_device's
/// invariant), moderation records (anonymised, not erased — INFO-11) and
/// uploaded files (the id lives inside E2EE content, so the server cannot tell
/// which blobs other people can still read) — is documented in
/// docs/SECURITY_MODEL.md §11.
/// Uploaded blobs of the deleted account (attachments, avatar, sounds, clip
/// parts) are stamped for purge `$2` days out, then removed by the retention
/// sweep in main.rs. Their ids live inside other people's E2EE content, so the
/// server cannot warn the channels they were shared in — the grace period IS
/// the warning, and the confirmation copy says so. Stamped, not deleted, so a
/// mistaken deletion is recoverable by an operator within the window.
///
/// Server assets are excluded: a server icon or a custom emoji the account
/// uploaded belongs to the SERVER now (its members still see it), so it is
/// not the account's to take away.
/// `id::text` on BOTH sides of every comparison: `uploaded_files.id` is a uuid
/// and every column that references it (`servers.icon_file_id`,
/// `custom_emojis.file_id`, `server_emojis.file_id`) is TEXT, so an
/// unqualified `id NOT IN (...)` is `uuid = text` — which Postgres refuses at
/// parse time, failing the whole deletion with a 500. Caught by
/// frontend/e2e/deleted-account-login.mjs.
const UPLOAD_GRACE_STAMP_SQL: &str = "UPDATE uploaded_files SET purge_after = NOW() + make_interval(days => $2)      WHERE uploader_id = $1 AND purge_after IS NULL        AND id::text NOT IN (SELECT icon_file_id FROM servers WHERE icon_file_id IS NOT NULL)        AND id::text NOT IN (SELECT file_id FROM custom_emojis WHERE file_id IS NOT NULL)        AND id::text NOT IN (SELECT file_id FROM server_emojis WHERE file_id IS NOT NULL)";

/// DELETED_ACCOUNT_FILE_GRACE_DAYS: how long a deleted account's uploads stay
/// before the sweep removes them. Default 30; 0 purges at the next sweep.
pub(crate) fn upload_grace_days() -> i32 {
    std::env::var("DELETED_ACCOUNT_FILE_GRACE_DAYS")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|d| (0..=3650).contains(d))
        .unwrap_or(30) as i32
}

const ACCOUNT_DELETE_CLEANUP: &[&str] = &[
    "DELETE FROM device_tokens WHERE user_id = $1",
    // Enrolled MACHINES, as distinct from the push tokens above. The tombstone
    // is an UPDATE so the devices FK cascade never fires, and /devices/token
    // re-reads token_version at mint time — so the bump in the anonymising
    // UPDATE is absorbed and a device holding its Ed25519 key could keep
    // minting full account JWTs indefinitely after the account was deleted.
    // Revoked rather than deleted: device_shares reference these rows.
    "UPDATE devices SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    "DELETE FROM notification_preferences WHERE user_id = $1",
    "DELETE FROM friends WHERE user1_id = $1 OR user2_id = $1",
    "DELETE FROM friend_requests WHERE sender_id = $1 OR receiver_id = $1",
    "DELETE FROM blocked_users WHERE blocker_id = $1 OR blocked_id = $1",
    "DELETE FROM member_roles WHERE user_id = $1",
    "DELETE FROM server_members WHERE user_id = $1",
    "DELETE FROM server_nicknames WHERE user_id = $1",
    // The tombstone is an UPDATE, so the ON DELETE CASCADE on these token
    // tables never fires. A surviving change-email token would let verify_email
    // re-install a live, verified address on the anonymised row for up to 24h
    // after deletion (and password_reset_tokens is the same shape, purged for
    // the same reason).
    "DELETE FROM email_verification_tokens WHERE user_id = $1",
    "DELETE FROM password_reset_tokens WHERE user_id = $1",
    // Cross-user device shares, BOTH directions: shares this account granted on
    // its own machines and shares other people granted to it. Their
    // owner_user/grantee_user FKs are ON DELETE CASCADE (migration 049) and the
    // tombstone is an UPDATE, so the cascade never fires and an accepted share
    // row — naming the deleted account as a party, with its capability list —
    // outlives the account indefinitely.
    "DELETE FROM device_share_invites WHERE owner_user = $1 OR grantee_user = $1",
    // Wrapped channel keys addressed to a user who can never unwrap them again:
    // the identity key is nulled and both wrapped seeds are gone, so these are
    // permanently opaque ciphertext.
    //
    // Mostly already handled, which the finding did not say: migration 015's
    // trg_server_members_generation deletes the departed member's channel_keys
    // on every server_members DELETE, which the statement above performs. This
    // is the sweep for rows whose channel is not in a server this account was a
    // member of. Deliberately the SAME unconditional shape as that trigger
    // rather than a cleverer guarded one — a second, different rule for the
    // same table is how a pair drifts. Only this user's own wrapped copies go;
    // every other member's row for the same epoch is untouched, so nobody
    // else's history becomes unreadable.
    "DELETE FROM channel_keys WHERE recipient_id = $1",
    // Devices are revoked, not deleted, so the rows survive — along with a
    // user-chosen machine NAME, which is personal data with no purpose once the
    // account is gone, and lan_info, a client-encrypted map of the machine's
    // MAC and internal IPs that nothing can ever decrypt again. `name` is NOT
    // NULL, so it is replaced rather than nulled.
    "UPDATE devices SET name = 'removed', lan_info = NULL WHERE user_id = $1",
    // Sessions carry the DM session keys (migration 060): a tombstone must not
    // keep advertising keys nobody will ever open, and the token_version bump
    // above already made every token dead.
    "UPDATE token_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
];

/// DELETE /account — tombstone the account.
///
/// Tombstone, not hard-delete: the users row is anonymised (username becomes
/// `deleted#<id>`; '#' is rejected by `validate_username`, so no live account
/// can collide or squat the name) and every credential is destroyed:
/// `deleted_at` is set — the login path refuses tombstones outright — the SRP
/// salt/verifier are overwritten with RANDOM bytes, the wrapped seeds are
/// dropped (message history becomes unrecoverable ciphertext, which E2EE makes
/// true regardless), and the token_version bump evicts every outstanding JWT
/// on every device. The bump alone only refuses the NEXT request or WS upgrade,
/// so the handler also hangs up the account's live sockets — otherwise a second
/// signed-in device kept a fully privileged connection (room fan-out is by
/// in-memory membership, not DB membership) until its socket happened to drop.
///
/// The random verifier matters: an EMPTY verifier is NOT unauthenticatable.
/// With v = 0 the SRP-6a premaster secret degenerates to 0 for any A the
/// client picks, and srp 0.6 derives M1 = H(A ‖ B ‖ K) from public values
/// only — so anyone who could guess the tombstone username could forge a
/// proof and log in. (Verified empirically against srp 0.6.) `deleted_at` is
/// the primary defence; random material is the backstop.
/// Messages/tasks stay as FK-intact ciphertext rows attributed to the
/// tombstone. Owned servers block deletion — transfer or disband first,
/// otherwise every member would be stranded in an ownerless server.
pub async fn delete_account(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<crate::auth::Claims>,
    Json(payload): Json<DeleteAccountRequest>,
) -> impl IntoResponse {
    // A bare bearer token must not be enough for this: it is as irreversible as a
    // credential rewrite, and a stolen token is the threat model.
    if let Err(r) = crate::recovery_handlers::require_password_proof(&state, claims.sub, claims.sst) {
        return r;
    }
    let row: Option<(String,)> = sqlx::query_as("SELECT username FROM users WHERE id = $1")
        .bind(claims.sub as i32)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
    let Some((username,)) = row else {
        return (StatusCode::NOT_FOUND, "Account not found").into_response();
    };
    if !username.eq_ignore_ascii_case(payload.confirm_username.trim()) {
        return (StatusCode::BAD_REQUEST, "Username does not match").into_response();
    }

    let owned: Option<(i64,)> = sqlx::query_as("SELECT COUNT(*) FROM servers WHERE owner_id = $1")
        .bind(claims.sub as i32)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
    if owned.map(|(n,)| n).unwrap_or(0) > 0 {
        return (
            StatusCode::CONFLICT,
            "You still own servers. Disband them (or transfer ownership) first.",
        )
            .into_response();
    }

    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("delete_account: begin failed: {:?}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to delete account",
            )
                .into_response();
        }
    };

    let uid = claims.sub as i32;
    // RANDOM, not empty — see the doc comment: a zero verifier is forgeable.
    let mut dead_salt = vec![0u8; 32];
    let mut dead_verifier = vec![0u8; 256];
    OsRng.fill_bytes(&mut dead_salt);
    OsRng.fill_bytes(&mut dead_verifier);
    let anonymised = sqlx::query(
        "UPDATE users SET \
            username = 'deleted#' || id, \
            display_name = NULL, \
            avatar_file_id = NULL, \
            join_sound_file_id = NULL, \
            leave_sound_file_id = NULL, \
            email = NULL, \
            email_verified = FALSE, \
            public_key = NULL, \
            salt = $2, \
            verifier = $3, \
            wrap_salt = NULL, \
            recovery_salt = NULL, \
            seed_wrapped_pw = NULL, \
            seed_wrapped_rc = NULL, \
            history_pubkey = NULL, \
            history_wrapped_rc = NULL, \
            history_pubkey_sig = NULL, \
            account_sign_pub = NULL, \
            deleted_at = NOW(), \
            token_version = token_version + 1 \
         WHERE id = $1",
    )
    .bind(uid)
    .bind(&dead_salt)
    .bind(&dead_verifier)
    .execute(&mut *tx)
    .await;
    if let Err(e) = anonymised {
        tracing::error!("delete_account: anonymise failed: {:?}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to delete account",
        )
            .into_response();
    }

    // Relationship + device rows go outright; content rows (messages, tasks)
    // stay attributed to the tombstone for FK integrity. The list itself, and
    // the reasoning for every entry AND every deliberate omission, is on
    // ACCOUNT_DELETE_CLEANUP above.
    for q in ACCOUNT_DELETE_CLEANUP {
        if let Err(e) = sqlx::query(*q).bind(uid).execute(&mut *tx).await {
            tracing::error!("delete_account: cleanup `{}` failed: {:?}", q, e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to delete account",
            )
                .into_response();
        }
    }
    if let Err(e) = sqlx::query(UPLOAD_GRACE_STAMP_SQL)
        .bind(claims.sub as i32)
        .bind(upload_grace_days())
        .execute(&mut *tx)
        .await
    {
        tracing::error!("delete_account: could not stamp uploads for purge: {:?}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to delete account").into_response();
    }

    // Re-check inside the transaction, after the anonymising UPDATE has taken
    // its row lock on users. The pre-flight COUNT above runs on its own
    // connection, so a POST /servers racing this request could commit an
    // ownership row between the count and the tombstone — leaving a server
    // owned by an account that can never authenticate again, which is exactly
    // the stranded-members state the check exists to prevent. create_server
    // takes a FOR SHARE lock on the same users row, so by the time this reads,
    // any concurrent create has either committed (and is visible here) or is
    // still blocked behind our lock (and will see deleted_at once we commit).
    // Propagate a failed re-check as 500: a statement error here aborts the
    // Postgres transaction, after which COMMIT completes as ROLLBACK while
    // still reporting success — swallowing the error would return 200 and log
    // "deleted" for an account that was not touched.
    let owned_now: (i64,) = match sqlx::query_as("SELECT COUNT(*) FROM servers WHERE owner_id = $1")
        .bind(uid)
        .fetch_one(&mut *tx)
        .await
    {
        Ok(row) => row,
        Err(e) => {
            tracing::error!("delete_account: in-tx ownership re-check failed: {:?}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to delete account",
            )
                .into_response();
        }
    };
    if owned_now.0 > 0 {
        tracing::warn!(
            "delete_account: aborting, user {} acquired a server mid-delete",
            uid
        );
        return (
            StatusCode::CONFLICT,
            "You still own servers. Disband them (or transfer ownership) first.",
        )
            .into_response();
    }

    if let Err(e) = tx.commit().await {
        tracing::error!("delete_account: commit failed: {:?}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to delete account",
        )
            .into_response();
    }

    // Hang up every live socket for this account. Only meaningful AFTER the
    // commit: each socket's cleanup path re-reads the DB (presence audience,
    // room membership), and the rows it needs to see gone must actually be
    // gone. Sockets on other devices would otherwise stay privileged for the
    // remaining lifetime of their JWT — room broadcasts fan out by in-memory
    // membership, so the tombstone kept receiving live channel traffic.
    let dropped = state.disconnect_user(claims.sub);

    tracing::info!(
        "Account {} ({}) deleted (tombstoned); {} live socket(s) closed",
        claims.sub,
        username,
        dropped
    );
    StatusCode::OK.into_response()
}

// --- User Search ---

#[derive(Deserialize)]
pub struct SearchUsersQuery {
    pub q: String,
}

#[derive(Serialize)]
pub struct SearchUserResponse {
    pub id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub is_online: bool,
}

/// Search users by username (for DM creation)
pub async fn search_users(
    State(state): State<Arc<AppState>>,
    // Deliberately unused, and NOT a missing authorization check: this route
    // lives on the authenticated router, so being signed in is the gate, and
    // the query no longer filters by caller now that you can find (and
    // message) yourself. Named `_claims` so the next reader does not have to
    // re-derive that — an unused `claims` is normally the signature of a
    // forgotten membership check in this codebase.
    Extension(_claims): Extension<crate::auth::Claims>,
    axum::extract::Query(query): axum::extract::Query<SearchUsersQuery>,
) -> impl IntoResponse {
    // Require >=2 chars: a 1-char '%x%' is the broadest possible scan for almost
    // no selectivity.
    if query.q.trim().len() < 2 {
        return Json(Vec::<SearchUserResponse>::new()).into_response();
    }

    // `LOWER(username) LIKE '%q%'` is a leading-wildcard scan no btree index can
    // serve (a pg_trgm GIN index is the real fix, but that needs the extension).
    // Until then, run it under a short per-statement timeout so one scan can't
    // pin a pool connection for the full acquire budget as the table grows.
    //
    // Escape the LIKE metacharacters first. This is NOT SQL injection — the
    // pattern is still bound — but `%` and `_` are live wildcards inside the
    // value, so a query of "%" satisfied the 2-char minimum while matching every
    // row, turning the selectivity floor and the LIMIT into a directory dump of
    // the 20 alphabetically-first accounts. `\` is escaped first or it would
    // corrupt the escapes added after it.
    let escaped = query
        .q
        .to_lowercase()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let search_pattern = format!("%{}%", escaped);

    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("search_users: begin failed: {:?}", e);
            return Json(Vec::<SearchUserResponse>::new()).into_response();
        }
    };
    let _ = sqlx::query("SET LOCAL statement_timeout = '2000ms'")
        .execute(&mut *tx)
        .await;
    let users: Vec<(i32, String, Option<String>, bool)> = sqlx::query_as(
        r#"
        -- Yourself is INCLUDED. You are a valid DM recipient (messaging your
        -- own other device is the point), and search is the only way to start
        -- that conversation — excluding yourself made it unreachable.
        -- A deleted account is a tombstone (deleted_at set, name rewritten to
        -- deleted#<id>); it must not be findable or DM-able.
        -- ESCAPE '\' pairs with the metacharacter escaping done on the pattern.
        SELECT id, username, display_name, show_online_status FROM users
        WHERE LOWER(username) LIKE $1 ESCAPE '\'
          AND deleted_at IS NULL
        ORDER BY username ASC
        LIMIT 20
        "#,
    )
    .bind(&search_pattern)
    .fetch_all(&mut *tx)
    .await
    .unwrap_or_default();
    let _ = tx.commit().await;

    let response: Vec<SearchUserResponse> = users
        .into_iter()
        .map(|(id, username, display_name, shows_online)| {
            // Hidden status reads as offline in search results too.
            let is_online = shows_online && state.is_user_visibly_online(id as i64);
            SearchUserResponse {
                id: id as i64,
                username,
                display_name,
                is_online,
            }
        })
        .collect();

    Json(response).into_response()
}

#[cfg(test)]
mod tests {
    use super::ct_eq;

    #[test]
    fn ct_eq_matches_identical() {
        assert!(ct_eq(b"s3cret-code", b"s3cret-code"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn ct_eq_rejects_different() {
        assert!(!ct_eq(b"s3cret-code", b"s3cret-cod3"));
        assert!(!ct_eq(b"abc", b"abd"));
    }

    #[test]
    fn ct_eq_rejects_length_mismatch() {
        assert!(!ct_eq(b"code", b"code-longer"));
        assert!(!ct_eq(b"code", b"cod"));
        assert!(!ct_eq(b"", b"x"));
    }
}

#[cfg(test)]
mod account_deletion_residue_tests {
    use super::ACCOUNT_DELETE_CLEANUP;

    /// THIS TEST IS THE SPECIFICATION for what a deletion removes. It holds the
    /// array the handler iterates — not a copy of it — so removing a statement,
    /// or widening one, goes red here and has to be argued for rather than
    /// happening quietly.
    ///
    /// The three additions in this release (L8-DATA-1) are the last three:
    /// cross-user device shares in both directions, the user's own wrapped
    /// channel keys, and the personal fields left on the revoked device rows.
    /// 0.9.1: uploads are STAMPED for the grace purge by UPLOAD_GRACE_STAMP_SQL
    /// (a separate statement, because it binds the operator's grace period),
    /// and purged by the retention sweep in main.rs once it passes.
    #[test]
    fn dm_key_validators_accept_the_client_shape_and_nothing_looser() {
        use base64::Engine;
        let b64 = |n: usize| base64::engine::general_purpose::STANDARD.encode(vec![7u8; n]);
        assert!(super::validate_key_sig(&b64(64)).is_ok());
        assert!(super::validate_key_sig(&b64(63)).is_err());
        assert!(super::validate_key_sig(&b64(65)).is_err());
        assert!(super::validate_key_sig("not base64!!").is_err());
        assert!(super::validate_account_sign_pub(&format!("ed25519:{}", b64(32))).is_ok());
        assert!(super::validate_account_sign_pub(&format!("ed25519:{}", b64(31))).is_err());
        assert!(super::validate_account_sign_pub(&format!("x25519:{}", b64(32))).is_err());
        assert!(super::validate_account_sign_pub("ed25519:junkjunkjunkjunkjunkjunkjunkjunkjunkjunkjunk").is_err());
        assert!(super::validate_history_key_pair(&None, &None, &None).is_ok());
        assert!(super::validate_history_key_pair(&Some("x25519:abcdefgh".into()), &Some("w".repeat(20)), &None).is_err(), "sig required with the key");
        assert!(super::validate_history_key_pair(&Some("x25519:abcdefgh".into()), &Some("w".repeat(20)), &Some(b64(64))).is_ok());
    }

    #[test]
    fn the_cleanup_list_is_exactly_what_we_decided() {
        let expected: &[&str] = &[
            "DELETE FROM device_tokens WHERE user_id = $1",
            "UPDATE devices SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
            "DELETE FROM notification_preferences WHERE user_id = $1",
            "DELETE FROM friends WHERE user1_id = $1 OR user2_id = $1",
            "DELETE FROM friend_requests WHERE sender_id = $1 OR receiver_id = $1",
            "DELETE FROM blocked_users WHERE blocker_id = $1 OR blocked_id = $1",
            "DELETE FROM member_roles WHERE user_id = $1",
            "DELETE FROM server_members WHERE user_id = $1",
            "DELETE FROM server_nicknames WHERE user_id = $1",
            "DELETE FROM email_verification_tokens WHERE user_id = $1",
            "DELETE FROM password_reset_tokens WHERE user_id = $1",
            "DELETE FROM device_share_invites WHERE owner_user = $1 OR grantee_user = $1",
            "DELETE FROM channel_keys WHERE recipient_id = $1",
            "UPDATE devices SET name = 'removed', lan_info = NULL WHERE user_id = $1",
            "UPDATE token_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
        ];
        assert_eq!(
            ACCOUNT_DELETE_CLEANUP, expected,
            "the account-deletion residue changed — update docs/SECURITY_MODEL.md §11 in the same commit"
        );
    }

    /// The tables that must NOT appear, each for a stated reason. A future edit
    /// that "tidies up" by adding one of these destroys other people's data,
    /// not just this account's.
    #[test]
    fn deletion_does_not_touch_other_peoples_content() {
        for forbidden in [
            // Other people's conversations; the server cannot read them to
            // decide which parts are only yours.
            "FROM messages",
            "FROM dm_messages",
            "FROM tasks",
            // The id lives inside E2EE ciphertext, so the server cannot tell
            // which blobs other people can still read — SECURITY_MODEL.md §11.
            "FROM uploaded_files",
            // Erasing these would let an account delete the record of what it
            // did; the actor is anonymised instead (INFO-11).
            "FROM audit_log",
            "FROM reports",
            // The device ROWS stay, revoked: device_shares reference them, and
            // a deleted row would let the same machine simply re-enrol.
            "DELETE FROM devices",
            // A hard user delete is the thing the tombstone exists to avoid.
            "DELETE FROM users",
        ] {
            assert!(
                !ACCOUNT_DELETE_CLEANUP.iter().any(|q| q.contains(forbidden)),
                "account deletion must not run `{forbidden}` — see docs/SECURITY_MODEL.md §11"
            );
        }
    }

    /// Every statement is scoped to ONE user. An unscoped statement in this list
    /// would empty the table for everybody on the first deletion.
    #[test]
    fn every_statement_is_scoped_to_the_deleted_user() {
        for q in ACCOUNT_DELETE_CLEANUP {
            assert!(q.contains("$1"), "unscoped statement in the cleanup list: {q}");
            assert!(
                q.contains("WHERE"),
                "a statement with no WHERE clause would hit every row: {q}"
            );
        }
    }
}

#[cfg(test)]
mod srp_version_tests {
    use super::SrpVersion;

    #[derive(serde::Deserialize)]
    struct Body {
        #[serde(default)]
        srp_version: Option<SrpVersion>,
    }

    #[test]
    fn omitted_is_none_and_every_caller_defaults_that_to_legacy() {
        let b: Body = serde_json::from_str("{}").unwrap();
        assert_eq!(b.srp_version, None);
        assert_eq!(b.srp_version.map(SrpVersion::get).unwrap_or(1), 1);
    }

    #[test]
    fn the_two_known_versions_deserialize() {
        for (json, want) in [("{\"srp_version\":1}", 1), ("{\"srp_version\":2}", 2)] {
            let b: Body = serde_json::from_str(json).unwrap();
            assert_eq!(b.srp_version.map(SrpVersion::get), Some(want));
        }
    }

    #[test]
    fn anything_else_is_a_body_error_not_a_default() {
        // Storing an unknown version would strand the account: login step 1
        // would announce it and no client could derive x.
        for json in ["{\"srp_version\":0}", "{\"srp_version\":3}", "{\"srp_version\":-1}"] {
            assert!(serde_json::from_str::<Body>(json).is_err(), "{json}");
        }
    }
}
