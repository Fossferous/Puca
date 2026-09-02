//! Device enrolment and revocation for the "My Devices" feature.
//!
//! The server is deliberately a REGISTRAR, not an authority. It stores
//! client-signed records and hands them back; it cannot mint one, because it
//! never holds the account signing key (that is derived from the E2EE seed and
//! only ever exists on a logged-in client). Every consumer re-verifies
//! `auth_sig` against the account signing key it derives from its OWN seed, so
//! a row this server invented is refused client-side.
//!
//! What the server DOES enforce is the part clients cannot: that a device id is
//! the honest hash of its own keys (so nobody squats another device's id), that
//! you only ever touch your own rows, and that a revoked device's live sockets
//! actually drop.

use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    Json,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::auth::Claims;
use crate::protocol::ServerMessage;
use crate::state::AppState;

/// Map a database (or other internal) error to a 500 WITHOUT echoing the raw
/// error to the client. A bare `e.to_string()` on a sqlx error leaks column and
/// constraint names, table names and SQL fragments — schema reconnaissance a
/// client should never receive. The detail is logged server-side instead.
fn db_error(e: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("device_handlers db error: {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error".to_string(),
    )
}

/// Mirrors the client's derivation in `frontend/src/api/devices/identity.ts`.
/// Both sides MUST agree byte-for-byte or enrolment fails with a 400 that looks
/// like a client bug — hence the shared label constant spelled out here.
const DEVICE_ID_LABEL: &str = "sovereign-device-v1";
const DEVICE_ID_LEN: usize = 21;

const MAX_FIELD_LEN: usize = 4096;
const MAX_NAME_LEN: usize = 64;
const MAX_DEVICES_PER_USER: i64 = 64;

const PLATFORMS: [&str; 6] = ["windows", "linux", "macos", "android", "ios", "web"];

/// `id = base64url(sha256(LABEL || device_pub || sign_pub))[0..21]`
///
/// Derived rather than chosen so a client cannot claim an id that isn't its
/// own, and so the server can reject a mismatch without trusting the caller.
pub fn derive_device_id(device_pub: &str, sign_pub: &str) -> String {
    let mut h = Sha256::new();
    h.update(DEVICE_ID_LABEL.as_bytes());
    h.update(device_pub.as_bytes());
    h.update(sign_pub.as_bytes());
    let digest = h.finalize();
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    b64.chars().take(DEVICE_ID_LEN).collect()
}

#[derive(Debug, Deserialize)]
pub struct EnrolDeviceRequest {
    pub device_pub: String,
    pub sign_pub: String,
    pub name: String,
    pub platform: String,
    /// Canonical JSON, stored VERBATIM — re-serialising would change the bytes
    /// and break signature verification on every other device.
    pub auth_record: String,
    pub auth_sig: String,
}

#[derive(Debug, Serialize)]
pub struct DeviceResponse {
    pub id: String,
    pub device_pub: String,
    pub sign_pub: String,
    pub name: String,
    pub platform: String,
    pub auth_record: String,
    pub auth_sig: String,
    pub host_enabled: bool,
    pub host_policy: Option<String>,
    pub host_sig: Option<String>,
    pub lan_info: Option<String>,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    /// Whether one of this user's live sockets has attested as this device.
    pub online: bool,
}

#[derive(Debug, Serialize)]
pub struct ListDevicesResponse {
    pub devices: Vec<DeviceResponse>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDeviceRequest {
    pub name: Option<String>,
    pub host_enabled: Option<bool>,
    pub host_policy: Option<String>,
    pub host_sig: Option<String>,
    pub lan_info: Option<String>,
}

type DeviceRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    bool,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

/// Timestamps are selected as ::text throughout. `query_as` tuple decoding is
/// strict about column types in this codebase, and text sidesteps the whole
/// TIMESTAMPTZ-vs-chrono question for a field the client only displays.
const DEVICE_COLUMNS: &str = "id, device_pub, sign_pub, name, platform, auth_record, auth_sig, \
     host_enabled, host_policy, host_sig, lan_info, created_at::text, last_seen_at::text";

fn to_response(r: DeviceRow, online: bool) -> DeviceResponse {
    DeviceResponse {
        id: r.0,
        device_pub: r.1,
        sign_pub: r.2,
        name: r.3,
        platform: r.4,
        auth_record: r.5,
        auth_sig: r.6,
        host_enabled: r.7,
        host_policy: r.8,
        host_sig: r.9,
        lan_info: r.10,
        created_at: r.11,
        last_seen_at: r.12,
        online,
    }
}

fn bad(msg: &str) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, msg.to_string())
}

fn check_len(field: &str, value: &str, max: usize) -> Result<(), (StatusCode, String)> {
    if value.trim().is_empty() {
        return Err(bad(&format!("{field} cannot be empty")));
    }
    if value.len() > max {
        return Err(bad(&format!("{field} is too long")));
    }
    Ok(())
}

/// POST /devices — enrol this device (idempotent on re-enrolment).
pub async fn enrol_device(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<EnrolDeviceRequest>,
) -> Result<Json<DeviceResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    check_len("device_pub", &payload.device_pub, MAX_FIELD_LEN)?;
    check_len("sign_pub", &payload.sign_pub, MAX_FIELD_LEN)?;
    check_len("name", &payload.name, MAX_NAME_LEN)?;
    check_len("auth_record", &payload.auth_record, MAX_FIELD_LEN)?;
    check_len("auth_sig", &payload.auth_sig, MAX_FIELD_LEN)?;

    if !PLATFORMS.contains(&payload.platform.as_str()) {
        return Err(bad("unknown platform"));
    }
    if !payload.device_pub.starts_with("x25519:") {
        return Err(bad("device_pub must be x25519:-prefixed"));
    }
    if !payload.sign_pub.starts_with("ed25519:") {
        return Err(bad("sign_pub must be ed25519:-prefixed"));
    }

    let id = derive_device_id(&payload.device_pub, &payload.sign_pub);

    // Cap enrolments so a stolen JWT cannot fill the table. Counted over LIVE
    // rows only — revoking then re-enrolling a machine is legitimate.
    let live: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM devices WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2",
    )
    .bind(user_id)
    .bind(&id)
    .fetch_one(&state.pool)
    .await
    .map_err(db_error)?;
    if live.0 >= MAX_DEVICES_PER_USER {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many enrolled devices — revoke one first".to_string(),
        ));
    }

    // A REVOKED device stays revoked.
    //
    // This upsert used to set `revoked_at = NULL` on the conflict path, with a
    // comment calling it "a deliberate re-add from the device itself". It was
    // not deliberate on anyone's part: the client auto-enrols on every launch,
    // so revoking a device lasted exactly until that device next opened the app
    // and quietly un-revoked itself. "Sign this device out" signed nothing out,
    // which is the worst possible outcome for the one control a user reaches for
    // after losing a laptop.
    //
    // The account signature proves the enrolment came from someone holding the
    // password. That is precisely the thing a stolen, still-logged-in machine
    // also has, so it cannot be what authorises resurrection.
    //
    // Coming back requires discarding the device identity (forgetDeviceKey), so
    // the machine enrols as a genuinely NEW device the user can see and name —
    // not as the one they thought they had removed.
    let already_revoked: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NOT NULL",
    )
    .bind(&id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(db_error)?;
    if already_revoked.is_some() {
        return Err((
            StatusCode::FORBIDDEN,
            "device_revoked: this device was signed out; add it again as a new device".to_string(),
        ));
    }

    // Re-enrolling the same LIVE device (same keys => same id) refreshes its
    // record: a rename or a platform change, not a resurrection.
    let row: DeviceRow = sqlx::query_as(&format!(
        r#"
        INSERT INTO devices (id, user_id, device_pub, sign_pub, name, platform, auth_record, auth_sig)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
            name        = EXCLUDED.name,
            platform    = EXCLUDED.platform,
            auth_record = EXCLUDED.auth_record,
            auth_sig    = EXCLUDED.auth_sig
        WHERE devices.user_id = $2 AND devices.revoked_at IS NULL
        RETURNING {DEVICE_COLUMNS}
        "#
    ))
    .bind(&id)
    .bind(user_id)
    .bind(&payload.device_pub)
    .bind(&payload.sign_pub)
    .bind(payload.name.trim())
    .bind(&payload.platform)
    .bind(&payload.auth_record)
    .bind(&payload.auth_sig)
    .fetch_optional(&state.pool)
    .await
    .map_err(db_error)?
    // The `WHERE devices.user_id = $2` on the conflict path means 0 rows when
    // the id already belongs to SOMEBODY ELSE. That is only reachable by a
    // sha256 collision on the device keys, but answering 409 beats a confusing
    // 500 — and it must never silently overwrite another user's row.
    .ok_or((StatusCode::CONFLICT, "device id already registered".to_string()))?;

    let online = state.conn_of_device(claims.sub, &id).is_some();
    Ok(Json(to_response(row, online)))
}

/// GET /devices — every live device for this account.
pub async fn list_devices(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<ListDevicesResponse>, (StatusCode, String)> {
    let rows: Vec<DeviceRow> = sqlx::query_as(&format!(
        "SELECT {DEVICE_COLUMNS} FROM devices \
         WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at"
    ))
    .bind(claims.sub as i32)
    .fetch_all(&state.pool)
    .await
    .map_err(db_error)?;

    let devices = rows
        .into_iter()
        .map(|r| {
            let online = state.conn_of_device(claims.sub, &r.0).is_some();
            to_response(r, online)
        })
        .collect();
    Ok(Json(ListDevicesResponse { devices }))
}

/// PATCH /devices/:id — rename, or arm/disarm unattended hosting.
pub async fn update_device(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(device_id): Path<String>,
    Json(payload): Json<UpdateDeviceRequest>,
) -> Result<Json<DeviceResponse>, (StatusCode, String)> {
    if let Some(name) = &payload.name {
        check_len("name", name, MAX_NAME_LEN)?;
    }
    for (field, value) in [
        ("host_policy", &payload.host_policy),
        ("host_sig", &payload.host_sig),
        ("lan_info", &payload.lan_info),
    ] {
        if let Some(v) = value {
            if v.len() > MAX_FIELD_LEN {
                return Err(bad(&format!("{field} is too long")));
            }
        }
    }
    // Arming unattended access without the policy that gates it would produce a
    // host that accepts connections with nothing to verify against.
    if payload.host_enabled == Some(true) && payload.host_policy.is_none() {
        let existing: Option<(Option<String>,)> =
            sqlx::query_as("SELECT host_policy FROM devices WHERE id = $1 AND user_id = $2")
                .bind(&device_id)
                .bind(claims.sub as i32)
                .fetch_optional(&state.pool)
                .await
                .map_err(db_error)?;
        if existing.and_then(|r| r.0).is_none() {
            return Err(bad("host_enabled requires host_policy"));
        }
    }

    let row: DeviceRow = sqlx::query_as(&format!(
        r#"
        UPDATE devices SET
            name         = COALESCE($3, name),
            host_enabled = COALESCE($4, host_enabled),
            host_policy  = COALESCE($5, host_policy),
            host_sig     = COALESCE($6, host_sig),
            lan_info     = COALESCE($7, lan_info)
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING {DEVICE_COLUMNS}
        "#
    ))
    .bind(&device_id)
    .bind(claims.sub as i32)
    .bind(payload.name.as_deref().map(str::trim))
    .bind(payload.host_enabled)
    .bind(&payload.host_policy)
    .bind(&payload.host_sig)
    .bind(&payload.lan_info)
    .fetch_optional(&state.pool)
    .await
    .map_err(db_error)?
    .ok_or((StatusCode::NOT_FOUND, "device not found".to_string()))?;

    let online = state.conn_of_device(claims.sub, &device_id).is_some();
    Ok(Json(to_response(row, online)))
}

#[derive(Debug, Serialize)]
pub struct RevokeResponse {
    pub revoked: bool,
}

/// DELETE /devices/:id — revoke.
///
/// Three things have to happen or revocation is theatre: the row is marked, any
/// live socket attested as that device is HUNG UP (reusing the same
/// `Session.kill` that account deletion and password change use), and the
/// user's other devices are told so their lists update.
///
/// Idempotent: revoking an already-revoked device answers 200, because the
/// caller's intent ("this device must not have access") is already satisfied
/// and a 404 would make retries look like failures.
pub async fn revoke_device(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(device_id): Path<String>,
) -> Result<Json<RevokeResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    let existed: Option<(String,)> =
        sqlx::query_as("SELECT id FROM devices WHERE id = $1 AND user_id = $2")
            .bind(&device_id)
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(db_error)?;
    if existed.is_none() {
        return Err((StatusCode::NOT_FOUND, "device not found".to_string()));
    }

    // The sessions this device PROVED (DeviceAttest / the device-token mint)
    // die with it: their JWTs are refused by the middleware and the WS upgrade
    // from here on, not just their currently open sockets.
    // Reach: sessions the device PROVED (DeviceAttest binds sid -> device). A
    // token minted before 0.9.0 carries no sid and so no row; it is not
    // revoked here, but it either renews (which mints a sid, revocable from
    // then on) or expires on its own clock within a day — a bounded residual
    // that a token_version bump would close only by signing out every OTHER
    // device of the user, which is the wrong trade for a lost phone.
    sqlx::query("UPDATE token_sessions SET revoked_at = NOW() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL")
        .bind(user_id)
        .bind(&device_id)
        .execute(&state.pool)
        .await
        .map_err(db_error)?;
    sqlx::query(
        "UPDATE devices SET revoked_at = NOW() \
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(&device_id)
    .bind(user_id)
    .execute(&state.pool)
    .await
    .map_err(db_error)?;

    // Grants naturally disappear with the row (ON DELETE CASCADE) only on a
    // hard delete, and this is a soft revoke — so drop them explicitly. A host
    // that was offline at revoke time re-reads its allowlist on next connect
    // and is therefore still correct.
    sqlx::query("DELETE FROM device_grants WHERE host_device = $1 OR controller_device = $1")
        .bind(&device_id)
        .execute(&state.pool)
        .await
        .map_err(db_error)?;

    // Cross-user shares die with the device too — the friends who held them
    // are told, and any of their LIVE sessions on this device end now rather
    // than lingering detached until the reaper gets around to them.
    let shares: Vec<(i64, i32)> = sqlx::query_as(
        "UPDATE device_share_invites SET status = 'revoked', revoked_at = NOW() \
         WHERE host_device = $1 AND status IN ('pending', 'accepted') \
         RETURNING id, grantee_user",
    )
    .bind(&device_id)
    .fetch_all(&state.pool)
    .await
    .map_err(db_error)?;
    for (invite_id, grantee) in shares {
        end_share_sessions_notified(
            &state,
            &device_id,
            grantee as i64,
            "that device was signed out",
        );
        state.send_to_user(
            grantee as i64,
            ServerMessage::DeviceShareRevoked {
                invite_id,
                host_device: device_id.clone(),
            },
        );
    }

    state.kill_device_sessions(claims.sub, &device_id);
    // The revoked phone's wake TOKEN is deliberately left in device_tokens:
    // the table carries no per-device linkage, so a targeted delete is not
    // expressible and a blanket one would silence the user's OTHER Android
    // devices. Harmless — the WS upgrade now refuses this device's delivery
    // reconnects, so a stray ring summons a socket the server turns away,
    // and the token dies on its own at uninstall (FCM UNREGISTERED prune).
    state.send_to_user(
        claims.sub,
        ServerMessage::DeviceRevoked {
            device_id: device_id.clone(),
        },
    );

    Ok(Json(RevokeResponse { revoked: true }))
}

// ============================================================================
// Grants — the host-signed controller allowlist
// ============================================================================
//
// This is the half of the trust chain that survives password compromise. The
// account key certifies "device D belongs to user U"; a GRANT certifies
// "controller C may drive host H", and it is signed by the HOST DEVICE's own
// key — which never leaves that machine and is not derivable from the password.
//
// So an attacker who phished the password can enrol a device of their own (they
// hold the account signing key) but cannot produce a grant for any host they are
// not physically at. The server stores both records and can forge neither.

#[derive(Debug, Deserialize)]
pub struct CreateGrantRequest {
    pub controller_device: String,
    /// Canonical JSON, stored VERBATIM.
    pub grant_record: String,
    /// Ed25519 by the HOST DEVICE's signing key.
    pub grant_sig: String,
    /// Optional expiry, RFC3339. Absent = until revoked.
    pub expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GrantResponse {
    pub host_device: String,
    pub controller_device: String,
    pub grant_record: String,
    pub grant_sig: String,
    pub expires_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct ListGrantsResponse {
    pub grants: Vec<GrantResponse>,
}

type GrantRow = (String, String, String, String, Option<String>, String);

const GRANT_COLUMNS: &str = "host_device, controller_device, grant_record, grant_sig, \
     expires_at::text, created_at::text";

fn grant_to_response(r: GrantRow) -> GrantResponse {
    GrantResponse {
        host_device: r.0,
        controller_device: r.1,
        grant_record: r.2,
        grant_sig: r.3,
        expires_at: r.4,
        created_at: r.5,
    }
}

/// Both devices must be live and belong to the caller. Returns Err with the
/// response to send when they do not.
async fn require_own_devices(
    state: &Arc<AppState>,
    user_id: i32,
    a: &str,
    b: &str,
) -> Result<(), (StatusCode, String)> {
    let found: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM devices \
         WHERE id = ANY($1) AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(vec![a.to_string(), b.to_string()])
    .bind(user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(db_error)?;

    // Two DISTINCT rows: `a == b` would otherwise count 1 and look like a miss,
    // but self-granting is meaningless and is refused explicitly below anyway.
    if found.0 < 2 {
        return Err((StatusCode::NOT_FOUND, "device not found".to_string()));
    }
    Ok(())
}

/// POST /devices/:device_id/grants — allow a controller to drive this host.
pub async fn create_grant(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(host_device): Path<String>,
    Json(payload): Json<CreateGrantRequest>,
) -> Result<Json<GrantResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    check_len("grant_record", &payload.grant_record, MAX_FIELD_LEN)?;
    check_len("grant_sig", &payload.grant_sig, MAX_FIELD_LEN)?;
    if host_device == payload.controller_device {
        return Err(bad("a device cannot grant control to itself"));
    }
    require_own_devices(&state, user_id, &host_device, &payload.controller_device).await?;

    let row: GrantRow = sqlx::query_as(&format!(
        r#"
        INSERT INTO device_grants
            (host_device, controller_device, grant_record, grant_sig, expires_at)
        VALUES ($1, $2, $3, $4, $5::timestamptz)
        ON CONFLICT (host_device, controller_device) DO UPDATE SET
            grant_record = EXCLUDED.grant_record,
            grant_sig    = EXCLUDED.grant_sig,
            expires_at   = EXCLUDED.expires_at,
            created_at   = NOW()
        RETURNING {GRANT_COLUMNS}
        "#
    ))
    .bind(&host_device)
    .bind(&payload.controller_device)
    .bind(&payload.grant_record)
    .bind(&payload.grant_sig)
    .bind(&payload.expires_at)
    .fetch_one(&state.pool)
    .await
    .map_err(db_error)?;

    Ok(Json(grant_to_response(row)))
}

/// GET /devices/:device_id/grants — who may drive this host.
///
/// Expired rows are filtered here rather than left to the client: a host reads
/// this to decide whether to accept a connection, and an expiry that only the
/// UI honours is not an expiry.
pub async fn list_grants(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(host_device): Path<String>,
) -> Result<Json<ListGrantsResponse>, (StatusCode, String)> {
    let rows: Vec<GrantRow> = sqlx::query_as(&format!(
        "SELECT {GRANT_COLUMNS} FROM device_grants g \
         WHERE g.host_device = $1 \
           AND (g.expires_at IS NULL OR g.expires_at > NOW()) \
           AND EXISTS (SELECT 1 FROM devices d \
                       WHERE d.id = g.host_device AND d.user_id = $2 AND d.revoked_at IS NULL) \
         ORDER BY g.created_at"
    ))
    .bind(&host_device)
    .bind(claims.sub as i32)
    .fetch_all(&state.pool)
    .await
    .map_err(db_error)?;

    Ok(Json(ListGrantsResponse {
        grants: rows.into_iter().map(grant_to_response).collect(),
    }))
}

/// DELETE /devices/:device_id/grants/:controller_id — withdraw a grant.
pub async fn delete_grant(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((host_device, controller_device)): Path<(String, String)>,
) -> Result<Json<RevokeResponse>, (StatusCode, String)> {
    // The EXISTS clause is what makes this yours: without it, knowing two device
    // ids would be enough to withdraw someone else's grant.
    let done = sqlx::query(
        "DELETE FROM device_grants g \
         WHERE g.host_device = $1 AND g.controller_device = $2 \
           AND EXISTS (SELECT 1 FROM devices d WHERE d.id = g.host_device AND d.user_id = $3)",
    )
    .bind(&host_device)
    .bind(&controller_device)
    .bind(claims.sub as i32)
    .execute(&state.pool)
    .await
    .map_err(db_error)?;

    // Idempotent, like device revocation: the caller's intent ("this controller
    // must not have access") is satisfied either way, and a 404 would make a
    // retry look like a failure.
    let _ = done.rows_affected();
    Ok(Json(RevokeResponse { revoked: true }))
}

// ============================================================================
// Cross-user shares — standing access for a FRIEND ("share a device")
// ============================================================================
//
// A share names a PERSON, not one of their machines: `device_share_invites`
// binds (host_device, grantee_user), so the grantee may connect from any of
// their enrolled devices and enrolling a new phone never needs a re-grant.
// Deliberately a SEPARATE table from `device_grants` — that one's invariant
// ("both devices belong to the caller") stays exactly as documented, and the
// cross-user path is purely additive.
//
// Consent is mutual and the lifecycle mirrors friend_requests: the owner
// invites, the grantee must accept, and either side can kill it afterwards.
// The connectable state needs THREE things at once, re-read fresh on every
// connect (see the DeviceConnect gate in ws.rs): status = 'accepted',
// revoked_at IS NULL, and a grant_record SIGNED BY THE HOST DEVICE's own key
// — the same key discipline as device_grants, so neither the server nor a
// password thief can mint one. The signature is verified here on upload as
// hygiene; the HOST re-verifies it at connect time as the real gate.

/// Capability vocabulary. `control` and `view_only` are mutually exclusive
/// levels of screen access; `files` is orthogonal. Validated here, not in a
/// CHECK constraint, so the rule set cannot silently drift from the handler.
const SHARE_CAPABILITIES: [&str; 3] = ["control", "view_only", "files"];
const MAX_SHARE_CAPS: usize = 3;

fn validate_capabilities(caps: &[String]) -> Result<(), (StatusCode, String)> {
    if caps.is_empty() || caps.len() > MAX_SHARE_CAPS {
        return Err(bad("capabilities must name at least one capability"));
    }
    for c in caps {
        if !SHARE_CAPABILITIES.contains(&c.as_str()) {
            return Err(bad("unknown capability"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    if !caps.iter().all(|c| seen.insert(c.as_str())) {
        return Err(bad("duplicate capability"));
    }
    if caps.iter().any(|c| c == "control") && caps.iter().any(|c| c == "view_only") {
        return Err(bad("control and view_only are mutually exclusive"));
    }
    Ok(())
}

/// Verify an Ed25519 device signature over `message`'s UTF-8 bytes.
/// `sign_pub` is `ed25519:<base64>`, `sig` base64 — the exact conventions of
/// `signWithDeviceKey` client-side. Malformed input answers false, never
/// errors: this runs on attacker-supplied bytes.
pub fn verify_device_signature(sign_pub: &str, message: &str, sig: &str) -> bool {
    use ed25519_dalek::{Signature, VerifyingKey};

    let Some(key_b64) = sign_pub.strip_prefix("ed25519:") else {
        return false;
    };
    let Ok(key_bytes) = base64::engine::general_purpose::STANDARD.decode(key_b64) else {
        return false;
    };
    let Ok(key_arr): Result<[u8; 32], _> = key_bytes.try_into() else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&key_arr) else {
        return false;
    };
    let Ok(sig_bytes) = base64::engine::general_purpose::STANDARD.decode(sig) else {
        return false;
    };
    let Ok(sig_arr): Result<[u8; 64], _> = sig_bytes.try_into() else {
        return false;
    };
    vk.verify_strict(message.as_bytes(), &Signature::from_bytes(&sig_arr))
        .is_ok()
}

#[derive(Debug, Deserialize)]
pub struct CreateShareRequest {
    pub grantee_user: i64,
    pub capabilities: Vec<String>,
    /// Both present when the invite is created ON the host device itself (the
    /// common case — you share the machine you are sitting at); otherwise the
    /// host device signs later via POST /shares/:id/sign.
    pub grant_record: Option<String>,
    pub grant_sig: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ShareResponse {
    pub id: i64,
    pub host_device: String,
    pub owner_user: i64,
    pub grantee_user: i64,
    pub grantee_username: Option<String>,
    pub capabilities: Vec<String>,
    pub status: String,
    /// Whether the host device has produced the signed grant yet. A share is
    /// connectable only when `status == "accepted" && signed`.
    pub signed: bool,
    /// The host-signed grant, echoed back to the OWNER only — the host device
    /// re-verifies it against its own key at connect time, and needs to see
    /// which accepted invites still lack a signature to produce one.
    pub grant_record: Option<String>,
    pub grant_sig: Option<String>,
    pub created_at: String,
    pub responded_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IncomingShareResponse {
    pub id: i64,
    pub host_device: String,
    pub host_device_name: String,
    pub host_platform: String,
    pub owner_user: i64,
    pub owner_username: String,
    pub capabilities: Vec<String>,
    pub status: String,
    /// accepted AND host-signed: the grantee can connect right now.
    pub ready: bool,
    /// Whether the host device currently has an attested live socket.
    pub online: bool,
    pub created_at: String,
}

/// POST /devices/:device_id/shares — invite a FRIEND to standing access.
pub async fn create_share(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(host_device): Path<String>,
    Json(payload): Json<CreateShareRequest>,
) -> Result<Json<ShareResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    validate_capabilities(&payload.capabilities)?;
    if payload.grantee_user == claims.sub {
        return Err(bad("you already have access to your own device"));
    }
    match (&payload.grant_record, &payload.grant_sig) {
        (Some(r), Some(s)) => {
            check_len("grant_record", r, MAX_FIELD_LEN)?;
            check_len("grant_sig", s, MAX_FIELD_LEN)?;
        }
        (None, None) => {}
        _ => return Err(bad("grant_record and grant_sig must be supplied together")),
    }

    // The device must be the caller's, live — and its sign_pub is what any
    // inline grant signature must verify against.
    let device: Option<(String, String)> = sqlx::query_as(
        "SELECT sign_pub, name FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(&host_device)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(db_error)?;
    let Some((host_sign_pub, host_name)) = device else {
        return Err((StatusCode::NOT_FOUND, "device not found".to_string()));
    };

    if let (Some(record), Some(sig)) = (&payload.grant_record, &payload.grant_sig) {
        if !verify_device_signature(&host_sign_pub, record, sig) {
            return Err(bad("grant signature does not verify against this device"));
        }
    }

    // Shares are FRIEND-scoped: an existing mutual relationship is the social
    // anchor for handing someone a path to this machine, and it keeps the
    // invite surface unreachable for strangers. Blocks in either direction
    // also refuse — one message for both, so a block is not disclosed.
    let grantee: Option<(String,)> = sqlx::query_as(
        r#"
        SELECT u.username FROM users u
        WHERE u.id = $1
          AND EXISTS (SELECT 1 FROM friends f
                      WHERE f.user1_id = LEAST($2::bigint, $3::bigint)
                        AND f.user2_id = GREATEST($2::bigint, $3::bigint))
          AND NOT EXISTS (SELECT 1 FROM blocked_users b
                          WHERE (b.blocker_id = $4 AND b.blocked_id = $1)
                             OR (b.blocker_id = $1 AND b.blocked_id = $4))
        "#,
    )
    .bind(payload.grantee_user as i32)
    .bind(claims.sub)
    .bind(payload.grantee_user)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(db_error)?;
    let Some((grantee_username,)) = grantee else {
        return Err((
            StatusCode::FORBIDDEN,
            "devices can only be shared with friends".to_string(),
        ));
    };

    // Re-inviting resets the SAME row to pending: a capability change always
    // re-consents, and a rejected/revoked pair can try again. Any session
    // still running under the superseded grant ends now — its capabilities
    // are no longer the agreed ones.
    let row: (i64, String) = sqlx::query_as(
        r#"
        INSERT INTO device_share_invites
            (host_device, owner_user, grantee_user, capabilities, status,
             grant_record, grant_sig)
        VALUES ($1, $2, $3, $4, 'pending', $5, $6)
        ON CONFLICT (host_device, grantee_user) DO UPDATE SET
            capabilities = EXCLUDED.capabilities,
            status       = 'pending',
            grant_record = EXCLUDED.grant_record,
            grant_sig    = EXCLUDED.grant_sig,
            created_at   = NOW(),
            responded_at = NULL,
            revoked_at   = NULL
        RETURNING id, created_at::text
        "#,
    )
    .bind(&host_device)
    .bind(user_id)
    .bind(payload.grantee_user as i32)
    .bind(&payload.capabilities)
    .bind(&payload.grant_record)
    .bind(&payload.grant_sig)
    .fetch_one(&state.pool)
    .await
    .map_err(db_error)?;

    end_share_sessions_notified(
        &state,
        &host_device,
        payload.grantee_user,
        "the share for this session was replaced",
    );

    state.send_to_user(
        payload.grantee_user,
        ServerMessage::DeviceShareInvited {
            invite_id: row.0,
            from_user: claims.sub,
            from_username: claims.username.clone(),
            host_device: host_device.clone(),
            host_device_name: host_name,
            capabilities: payload.capabilities.clone(),
        },
    );

    Ok(Json(ShareResponse {
        id: row.0,
        host_device,
        owner_user: claims.sub,
        grantee_user: payload.grantee_user,
        grantee_username: Some(grantee_username),
        capabilities: payload.capabilities,
        status: "pending".to_string(),
        signed: payload.grant_sig.is_some(),
        grant_record: payload.grant_record,
        grant_sig: payload.grant_sig,
        created_at: row.1,
        responded_at: None,
    }))
}

type ShareRow = (
    i64,
    String,
    i32,
    i32,
    Option<String>,
    Vec<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

fn share_to_response(r: ShareRow) -> ShareResponse {
    ShareResponse {
        id: r.0,
        host_device: r.1,
        owner_user: r.2 as i64,
        grantee_user: r.3 as i64,
        grantee_username: r.4,
        capabilities: r.5,
        status: r.6,
        signed: r.8.is_some(),
        grant_record: r.7,
        grant_sig: r.8,
        created_at: r.9,
        responded_at: r.10,
    }
}

/// GET /devices/:device_id/shares — the owner's view of who has (or was
/// offered) access to this device. Owner-only, like list_grants: a grantee
/// must never see the device's OTHER grantees.
pub async fn list_device_shares(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(host_device): Path<String>,
) -> Result<Json<Vec<ShareResponse>>, (StatusCode, String)> {
    let rows: Vec<ShareRow> = sqlx::query_as(
        r#"
        SELECT s.id, s.host_device, s.owner_user, s.grantee_user, u.username,
               s.capabilities, s.status, s.grant_record, s.grant_sig,
               s.created_at::text, s.responded_at::text
        FROM device_share_invites s
        LEFT JOIN users u ON u.id = s.grantee_user
        WHERE s.host_device = $1 AND s.owner_user = $2 AND s.status <> 'revoked'
        ORDER BY s.created_at
        "#,
    )
    .bind(&host_device)
    .bind(claims.sub as i32)
    .fetch_all(&state.pool)
    .await
    .map_err(db_error)?;

    Ok(Json(rows.into_iter().map(share_to_response).collect()))
}

/// GET /shares/incoming — every share offered TO me (pending to answer,
/// accepted to use or walk away from). Revoked/rejected rows and rows whose
/// host device is itself revoked are noise and are filtered out.
pub async fn list_incoming_shares(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<IncomingShareResponse>>, (StatusCode, String)> {
    type Row = (
        i64,
        String,
        String,
        String,
        i32,
        String,
        Vec<String>,
        String,
        bool,
        String,
    );
    let rows: Vec<Row> = sqlx::query_as(
        r#"
        SELECT s.id, s.host_device, d.name, d.platform, s.owner_user,
               u.username, s.capabilities, s.status, (s.grant_sig IS NOT NULL),
               s.created_at::text
        FROM device_share_invites s
        JOIN devices d ON d.id = s.host_device AND d.revoked_at IS NULL
        JOIN users u ON u.id = s.owner_user
        WHERE s.grantee_user = $1 AND s.status IN ('pending', 'accepted')
        ORDER BY s.created_at
        "#,
    )
    .bind(claims.sub as i32)
    .fetch_all(&state.pool)
    .await
    .map_err(db_error)?;

    Ok(Json(
        rows.into_iter()
            .map(|r| IncomingShareResponse {
                id: r.0,
                online: state.conn_of_device(r.4 as i64, &r.1).is_some(),
                host_device: r.1,
                host_device_name: r.2,
                host_platform: r.3,
                owner_user: r.4 as i64,
                owner_username: r.5,
                capabilities: r.6,
                ready: r.7 == "accepted" && r.8,
                status: r.7,
                created_at: r.9,
            })
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
pub struct RespondShareRequest {
    pub accept: bool,
}

/// POST /shares/:invite_id/respond — the grantee's answer. Their consent is
/// not optional: their account is taking on reach into someone else's
/// machine, and a grant nobody agreed to hold must never go live.
pub async fn respond_share(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(invite_id): Path<i64>,
    Json(payload): Json<RespondShareRequest>,
) -> Result<Json<ShareResponse>, (StatusCode, String)> {
    let row: Option<(String, i32, Vec<String>, String, bool, String)> = sqlx::query_as(
        r#"
        SELECT s.host_device, s.owner_user, s.capabilities, s.status,
               (s.grant_sig IS NOT NULL), s.created_at::text
        FROM device_share_invites s
        WHERE s.id = $1 AND s.grantee_user = $2
        "#,
    )
    .bind(invite_id)
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await
    .map_err(db_error)?;
    let Some((host_device, owner_user, capabilities, status, signed, created_at)) = row else {
        return Err((StatusCode::NOT_FOUND, "invite not found".to_string()));
    };

    let new_status = if payload.accept { "accepted" } else { "rejected" };
    // Idempotent on the same answer; anything else is a conflict, not an
    // update — un-rejecting requires the owner to re-invite.
    if status != "pending" {
        if status == new_status {
            return Ok(Json(ShareResponse {
                id: invite_id,
                host_device,
                owner_user: owner_user as i64,
                grantee_user: claims.sub,
                grantee_username: Some(claims.username.clone()),
                capabilities,
                status,
                signed,
                // The grantee never needs the grant bytes; the HOST re-reads
                // them from its own list endpoint.
                grant_record: None,
                grant_sig: None,
                created_at,
                responded_at: None,
            }));
        }
        return Err((
            StatusCode::CONFLICT,
            "this invite was already answered".to_string(),
        ));
    }

    let updated: (String,) = sqlx::query_as(
        "UPDATE device_share_invites SET status = $2, responded_at = NOW() \
         WHERE id = $1 RETURNING responded_at::text",
    )
    .bind(invite_id)
    .bind(new_status)
    .fetch_one(&state.pool)
    .await
    .map_err(db_error)?;

    state.send_to_user(
        owner_user as i64,
        ServerMessage::DeviceShareAnswered {
            invite_id,
            host_device: host_device.clone(),
            accepted: payload.accept,
            grantee_user: claims.sub,
            grantee_username: claims.username.clone(),
        },
    );
    // Accept completing an already-signed grant makes it connectable NOW —
    // tell the grantee's other sessions so their lists go live too.
    if payload.accept && signed {
        state.send_to_user(
            claims.sub,
            ServerMessage::DeviceShareReady {
                invite_id,
                host_device: host_device.clone(),
            },
        );
    }

    Ok(Json(ShareResponse {
        id: invite_id,
        host_device,
        owner_user: owner_user as i64,
        grantee_user: claims.sub,
        grantee_username: Some(claims.username.clone()),
        capabilities,
        status: new_status.to_string(),
        signed,
        grant_record: None,
        grant_sig: None,
        created_at,
        responded_at: Some(updated.0),
    }))
}

#[derive(Debug, Deserialize)]
pub struct SignShareRequest {
    pub grant_record: String,
    pub grant_sig: String,
}

/// POST /shares/:invite_id/sign — the HOST DEVICE uploads the signed grant.
///
/// Reachable only with the owner's JWT, but the JWT is not what makes it
/// safe: the signature must verify against the host device's own sign_pub,
/// and only that machine holds the private half. A forged upload fails here;
/// one that somehow landed would still fail the host's own re-verification
/// at connect time.
pub async fn sign_share(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(invite_id): Path<i64>,
    Json(payload): Json<SignShareRequest>,
) -> Result<Json<RevokeResponse>, (StatusCode, String)> {
    check_len("grant_record", &payload.grant_record, MAX_FIELD_LEN)?;
    check_len("grant_sig", &payload.grant_sig, MAX_FIELD_LEN)?;

    let row: Option<(String, i32, String, String)> = sqlx::query_as(
        r#"
        SELECT s.host_device, s.grantee_user, s.status, d.sign_pub
        FROM device_share_invites s
        JOIN devices d ON d.id = s.host_device AND d.revoked_at IS NULL
        WHERE s.id = $1 AND s.owner_user = $2
        "#,
    )
    .bind(invite_id)
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await
    .map_err(db_error)?;
    let Some((host_device, grantee_user, status, host_sign_pub)) = row else {
        return Err((StatusCode::NOT_FOUND, "invite not found".to_string()));
    };
    if status != "pending" && status != "accepted" {
        return Err((
            StatusCode::CONFLICT,
            "this invite is no longer active".to_string(),
        ));
    }
    if !verify_device_signature(&host_sign_pub, &payload.grant_record, &payload.grant_sig) {
        return Err(bad("grant signature does not verify against this device"));
    }

    sqlx::query(
        "UPDATE device_share_invites SET grant_record = $2, grant_sig = $3 WHERE id = $1",
    )
    .bind(invite_id)
    .bind(&payload.grant_record)
    .bind(&payload.grant_sig)
    .execute(&state.pool)
    .await
    .map_err(db_error)?;

    if status == "accepted" {
        state.send_to_user(
            grantee_user as i64,
            ServerMessage::DeviceShareReady {
                invite_id,
                host_device,
            },
        );
    }
    Ok(Json(RevokeResponse { revoked: true }))
}

/// End live sessions under one share and tell BOTH ends why. The narrower
/// counterpart of kill_device_sessions: sockets stay up (the grantee's socket
/// is their whole app connection), the SESSION dies — the host client stops
/// capture and closes the peer connection on DeviceEnded, and the host is the
/// enforcement point for what leaves its machine.
fn end_share_sessions_notified(
    state: &Arc<AppState>,
    host_device: &str,
    grantee_user: i64,
    reason: &str,
) {
    for (session_id, cu, cc, hu, hc) in state.end_share_sessions(host_device, grantee_user) {
        state.send_to_conn(
            cu,
            cc,
            ServerMessage::DeviceEnded {
                session_id: session_id.clone(),
                reason: reason.to_string(),
            },
        );
        state.send_to_conn(
            hu,
            hc,
            ServerMessage::DeviceEnded {
                session_id,
                reason: reason.to_string(),
            },
        );
    }
}

/// Revoke every share between two users, in BOTH directions, and end any live
/// session under them. Called when the social relationship the share depended
/// on is severed — a block or an unfriend — so standing device access cannot
/// outlive the friendship that gated its creation. Idempotent and best-effort:
/// it logs and moves on rather than failing the block/unfriend it rides on,
/// because leaving the two users un-blocked is the worse outcome. The
/// connect-time gate ALSO refuses a blocked pair, so a session cannot slip
/// through a failure here.
pub async fn revoke_shares_between(state: &Arc<AppState>, a: i64, b: i64) {
    let rows: Result<Vec<(i64, String, i32, i32)>, _> = sqlx::query_as(
        "UPDATE device_share_invites SET status = 'revoked', revoked_at = NOW() \
         WHERE status IN ('pending', 'accepted') \
           AND ((owner_user = $1 AND grantee_user = $2) \
             OR (owner_user = $2 AND grantee_user = $1)) \
         RETURNING id, host_device, owner_user, grantee_user",
    )
    .bind(a as i32)
    .bind(b as i32)
    .fetch_all(&state.pool)
    .await;
    let rows = match rows {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("revoke_shares_between({a},{b}) failed: {e}");
            return;
        }
    };
    for (invite_id, host_device, owner_user, grantee_user) in rows {
        end_share_sessions_notified(
            state,
            &host_device,
            grantee_user as i64,
            "access to this device was revoked",
        );
        let msg = ServerMessage::DeviceShareRevoked {
            invite_id,
            host_device,
        };
        state.send_to_user(owner_user as i64, msg.clone());
        state.send_to_user(grantee_user as i64, msg);
    }
}

/// DELETE /shares/:invite_id — withdraw (owner) or walk away from (grantee) a
/// share. Both directions are first-class: an owner must be able to cut a
/// grantee off, and a grantee must be able to stop holding access they no
/// longer want. Any live session under it ends IMMEDIATELY — a revocation
/// that only edits a row while the session keeps streaming is theatre.
pub async fn delete_share(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(invite_id): Path<i64>,
) -> Result<Json<RevokeResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    let row: Option<(String, i32, i32, String)> = sqlx::query_as(
        "SELECT host_device, owner_user, grantee_user, status \
         FROM device_share_invites \
         WHERE id = $1 AND (owner_user = $2 OR grantee_user = $2)",
    )
    .bind(invite_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(db_error)?;
    let Some((host_device, owner_user, grantee_user, status)) = row else {
        return Err((StatusCode::NOT_FOUND, "invite not found".to_string()));
    };

    // Idempotent, like device revocation: the intent is satisfied either way.
    if status != "revoked" {
        sqlx::query(
            "UPDATE device_share_invites SET status = 'revoked', revoked_at = NOW() \
             WHERE id = $1",
        )
        .bind(invite_id)
        .execute(&state.pool)
        .await
        .map_err(db_error)?;
    }

    end_share_sessions_notified(
        &state,
        &host_device,
        grantee_user as i64,
        "access to this device was revoked",
    );

    // Both parties' open UIs update; the message is the same shape whoever
    // pulled the plug.
    let msg = ServerMessage::DeviceShareRevoked {
        invite_id,
        host_device,
    };
    state.send_to_user(owner_user as i64, msg.clone());
    state.send_to_user(grantee_user as i64, msg);

    Ok(Json(RevokeResponse { revoked: true }))
}

#[derive(Debug, Serialize)]
pub struct SharePeerDeviceResponse {
    pub id: String,
    pub device_pub: String,
    pub sign_pub: String,
    pub name: String,
    pub platform: String,
    pub auth_record: String,
    pub auth_sig: String,
    /// Host-view only (grantee asking about the host device): whether the
    /// host is armed for unattended access, and the policy blob the
    /// unattended handshake needs. Never populated for the owner's view of a
    /// grantee device.
    pub host_enabled: Option<bool>,
    pub host_policy: Option<String>,
    pub host_sig: Option<String>,
    pub online: bool,
}

/// GET /shares/:invite_id/device/:device_id — the ONLY cross-account device
/// lookup in the system, and it must stay this narrow. Under an ACCEPTED,
/// un-revoked share:
///   * the GRANTEE may fetch exactly the share's host device (to verify the
///     machine it is connecting to), and
///   * the OWNER may fetch exactly the one grantee device named in the path
///     (to verify an incoming connection's controller record).
/// It never lists, never searches, and never returns lan_info. The
/// enumeration boundary — "a grant must not let anyone browse the other
/// side's devices" — lives here.
pub async fn share_peer_device(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((invite_id, device_id)): Path<(i64, String)>,
) -> Result<Json<SharePeerDeviceResponse>, (StatusCode, String)> {
    let user_id = claims.sub as i32;

    let invite: Option<(String, i32, i32)> = sqlx::query_as(
        "SELECT host_device, owner_user, grantee_user FROM device_share_invites \
         WHERE id = $1 AND status = 'accepted' AND revoked_at IS NULL \
           AND (owner_user = $2 OR grantee_user = $2)",
    )
    .bind(invite_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(db_error)?;
    let Some((host_device, owner_user, grantee_user)) = invite else {
        return Err((StatusCode::NOT_FOUND, "not found".to_string()));
    };

    type PeerRow = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        bool,
        Option<String>,
        Option<String>,
    );
    let (row, owner_view): (Option<PeerRow>, bool) = if user_id == grantee_user {
        // Grantee side: only the share's own host device.
        if device_id != host_device {
            return Err((StatusCode::NOT_FOUND, "not found".to_string()));
        }
        let r = sqlx::query_as(
            "SELECT id, device_pub, sign_pub, name, platform, auth_record, auth_sig, \
                    host_enabled, host_policy, host_sig \
             FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        )
        .bind(&device_id)
        .bind(owner_user)
        .fetch_optional(&state.pool)
        .await
        .map_err(db_error)?;
        (r, false)
    } else {
        // Owner side: only a live device OF THE GRANTEE, named exactly.
        let r = sqlx::query_as(
            "SELECT id, device_pub, sign_pub, name, platform, auth_record, auth_sig, \
                    host_enabled, host_policy, host_sig \
             FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        )
        .bind(&device_id)
        .bind(grantee_user)
        .fetch_optional(&state.pool)
        .await
        .map_err(db_error)?;
        (r, true)
    };
    let Some(r) = row else {
        return Err((StatusCode::NOT_FOUND, "not found".to_string()));
    };

    // The GRANTEE looking up the host needs its online status (to decide
    // whether to offer Wake-on-LAN vs. connect). The OWNER looking up a
    // grantee device does NOT — it only needs the enrolment material to
    // verify the connecting controller's signature — so its online status is
    // withheld, closing an online-probe of the grantee's other devices. The
    // residual (an owner can confirm a grantee device id it ALREADY holds
    // exists) is inherent to a per-device lookup and low-sensitivity: the
    // fields returned are the device's own public, account-signed record.
    let online = if owner_view {
        false
    } else {
        state.conn_of_device(owner_user as i64, &r.0).is_some()
    };
    Ok(Json(SharePeerDeviceResponse {
        id: r.0,
        device_pub: r.1,
        sign_pub: r.2,
        name: r.3,
        platform: r.4,
        auth_record: r.5,
        auth_sig: r.6,
        host_enabled: if owner_view { None } else { Some(r.7) },
        host_policy: if owner_view { None } else { r.8 },
        host_sig: if owner_view { None } else { r.9 },
        online,
    }))
}

// ============================================================================
// Account signing key — published so OTHER users can verify enrolment records
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct SetSigningKeyRequest {
    pub account_sign_pub: String,
}

/// PATCH /keys/signing — publish this account's Ed25519 signing public key.
///
/// Same trust posture as users.public_key (the X25519 DM identity key): the
/// server stores what the client says, peers TOFU-pin it and treat any later
/// change as loud. Overwriting is allowed — an account recovery legitimately
/// rotates the seed — and the pin on every peer is what surfaces a malicious
/// flip, not a server-side freeze this server could bypass anyway.
pub async fn set_signing_key(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<SetSigningKeyRequest>,
) -> Result<Json<RevokeResponse>, (StatusCode, String)> {
    check_len("account_sign_pub", &payload.account_sign_pub, MAX_FIELD_LEN)?;
    if !payload.account_sign_pub.starts_with("ed25519:") {
        return Err(bad("account_sign_pub must be ed25519:-prefixed"));
    }
    sqlx::query("UPDATE users SET account_sign_pub = $1 WHERE id = $2")
        .bind(&payload.account_sign_pub)
        .bind(claims.sub as i32)
        .execute(&state.pool)
        .await
        .map_err(db_error)?;
    Ok(Json(RevokeResponse { revoked: true }))
}

#[derive(Debug, Serialize)]
pub struct SigningKeyResponse {
    pub user_id: i64,
    pub account_sign_pub: Option<String>,
}

/// GET /users/:user_id/signing-key — fetch a user's published signing key.
pub async fn get_signing_key(
    State(state): State<Arc<AppState>>,
    Extension(_claims): Extension<Claims>,
    Path(user_id): Path<i64>,
) -> Result<Json<SigningKeyResponse>, (StatusCode, String)> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT account_sign_pub FROM users WHERE id = $1")
            .bind(user_id as i32)
            .fetch_optional(&state.pool)
            .await
            .map_err(db_error)?;
    let Some((key,)) = row else {
        return Err((StatusCode::NOT_FOUND, "user not found".to_string()));
    };
    Ok(Json(SigningKeyResponse {
        user_id,
        account_sign_pub: key,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_is_stable_and_key_bound() {
        let a = derive_device_id("x25519:AAA", "ed25519:BBB");
        assert_eq!(
            a,
            derive_device_id("x25519:AAA", "ed25519:BBB"),
            "must be deterministic"
        );
        assert_eq!(a.len(), DEVICE_ID_LEN);

        // Both keys are bound: changing either changes the id, so a device
        // cannot keep its id while swapping in a different signing key.
        assert_ne!(a, derive_device_id("x25519:AAA", "ed25519:CCC"));
        assert_ne!(a, derive_device_id("x25519:ZZZ", "ed25519:BBB"));
    }

    #[test]
    fn device_id_is_url_safe() {
        // Ids travel in URL paths (DELETE /devices/:id). Standard base64 would
        // put '/' and '+' in there and silently break routing for some devices.
        for i in 0..256u32 {
            let id = derive_device_id(&format!("x25519:{i}"), &format!("ed25519:{i}"));
            assert!(
                id.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "id {id} is not URL-safe"
            );
        }
    }

    /// CROSS-LANGUAGE CONTRACT. The client derives the id it enrols with and
    /// this server recomputes it; a mismatch rejects enrolment with a 400 that
    /// reads like a client bug. The same literal is asserted by
    /// "matches the Rust derivation for a pinned vector" in
    /// frontend/src/tests/deviceIdentity.test.ts — change one, change both.
    #[test]
    fn js_rust_device_id_agree() {
        assert_eq!(
            derive_device_id("x25519:AAA", "ed25519:BBB"),
            "-AauJskpoV9fK7rszlGnl"
        );
    }

    #[test]
    fn concatenation_is_unambiguous() {
        // A naive `pub || sign` concat would let ("ab","c") and ("a","bc")
        // collide. The prefixes make that unreachable, and this pins it.
        assert_ne!(
            derive_device_id("x25519:ab", "ed25519:c"),
            derive_device_id("x25519:a", "ed25519:bc"),
        );
    }

    fn caps(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn capabilities_accept_the_valid_shapes() {
        assert!(validate_capabilities(&caps(&["control"])).is_ok());
        assert!(validate_capabilities(&caps(&["view_only"])).is_ok());
        assert!(validate_capabilities(&caps(&["files"])).is_ok());
        assert!(validate_capabilities(&caps(&["control", "files"])).is_ok());
        assert!(validate_capabilities(&caps(&["view_only", "files"])).is_ok());
    }

    #[test]
    fn capabilities_reject_the_invalid_shapes() {
        assert!(validate_capabilities(&caps(&[])).is_err(), "empty");
        assert!(
            validate_capabilities(&caps(&["admin"])).is_err(),
            "unknown name"
        );
        assert!(
            validate_capabilities(&caps(&["control", "view_only"])).is_err(),
            "control and view_only are levels of the same thing"
        );
        assert!(
            validate_capabilities(&caps(&["files", "files"])).is_err(),
            "duplicates"
        );
        assert!(
            validate_capabilities(&caps(&["control", "files", "view_only"])).is_err(),
            "exclusivity holds regardless of position"
        );
    }

    /// Round-trip against a real keypair: the positive control that proves the
    /// negative assertions below CAN fail (a rig that rejects everything would
    /// pass them all).
    #[test]
    fn share_signature_verifies_and_binds_to_key_and_message() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};

        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk_b64 =
            base64::engine::general_purpose::STANDARD.encode(sk.verifying_key().to_bytes());
        let sign_pub = format!("ed25519:{pk_b64}");
        let record = r#"{"typ":"sovereign-device-share-v1","v":1}"#;
        let sig =
            base64::engine::general_purpose::STANDARD.encode(sk.sign(record.as_bytes()).to_bytes());

        assert!(
            verify_device_signature(&sign_pub, record, &sig),
            "a genuine signature must verify"
        );
        assert!(
            !verify_device_signature(&sign_pub, "tampered", &sig),
            "message is bound"
        );
        let other = SigningKey::from_bytes(&[8u8; 32]);
        let other_pub = format!(
            "ed25519:{}",
            base64::engine::general_purpose::STANDARD.encode(other.verifying_key().to_bytes())
        );
        assert!(
            !verify_device_signature(&other_pub, record, &sig),
            "key is bound"
        );
        assert!(
            !verify_device_signature("x25519:nope", record, &sig),
            "wrong key type refuses"
        );
        assert!(
            !verify_device_signature(&sign_pub, record, "!!not-base64!!"),
            "garbage sig refuses rather than erroring"
        );
    }
}
