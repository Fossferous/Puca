//! File Upload Handlers
//!
//! REST API handlers for file uploads and downloads.

use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Extension,
};
use serde::Serialize;
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use uuid::Uuid;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::auth::Claims;
use crate::state::AppState;

/// Per-user upload quota (M15). Coarse abuse ceilings, not exact accounting.
const MAX_USER_STORAGE_BYTES: i64 = 512 * 1024 * 1024; // 512 MB per user (attachments bucket)
const MAX_USER_FILES: i64 = 5000; // attachments bucket

/// Clip parts (docs/CLIPS.md) count against their OWN per-user budget, so a
/// couple of 300 MB clips do not lock a user out of avatars and attachments.
/// Env-overridable for operators; default 2 GiB.
fn clip_quota_bytes() -> i64 {
    std::env::var("CLIP_MAX_USER_BYTES").ok().and_then(|v| v.parse::<i64>().ok()).unwrap_or(2 * 1024 * 1024 * 1024)
}
/// How long posted clips live, in days; 0 = until someone deletes them.
/// One reader for the sweep AND for `GET /clips/usage`, so what the server
/// tells users (Settings › Clips) is the number it actually enforces — a
/// clip vanishing on day 31 with no warning anywhere was the Phase-3 gap.
fn clip_retention_days() -> i64 {
    parse_retention_days(std::env::var("CLIP_RETENTION_DAYS").ok())
}
/// Unset, unparsable or negative all mean "keep forever"; nothing here may
/// turn a typo into a deletion schedule.
fn parse_retention_days(raw: Option<String>) -> i64 {
    raw.and_then(|v| v.trim().parse::<i64>().ok()).filter(|d| *d > 0).unwrap_or(0)
}
/// A clip is at most MAX_CLIP_PARTS (clipRef.ts) parts; the server bounds
/// "approve once, upload forever" the same way.
const MAX_PARTS_PER_CLIP: i64 = 64;

/// Delete every part uploaded under `clip_id` (rows + blobs). Owner-scoped
/// when `owner` is given. Used when a clip post fails after upload, when a clip
/// message is deleted, and by the orphan sweeper. Unlike ordinary attachments,
/// clip parts ARE known to be unreferenced once their proposal is gone — the
/// server can reclaim them without ever seeing what they were.
pub async fn delete_clip_parts(state: &AppState, clip_id: &str, owner: Option<i64>) -> usize {
    let rows: Vec<(String,)> = match owner {
        Some(o) => sqlx::query_as("DELETE FROM uploaded_files WHERE clip_id = $1::uuid AND uploader_id = $2 RETURNING stored_name")
            .bind(clip_id).bind(o as i32).fetch_all(&state.pool).await.unwrap_or_default(),
        None => sqlx::query_as("DELETE FROM uploaded_files WHERE clip_id = $1::uuid RETURNING stored_name")
            .bind(clip_id).fetch_all(&state.pool).await.unwrap_or_default(),
    };
    for (stored,) in &rows {
        let _ = tokio::fs::remove_file(format!("uploads/{stored}")).await;
    }
    rows.len()
}

/// Hourly sweeps (main.rs):
///  (a) ORPHAN clip parts — rows whose proposal is not live and that no message
///      references (a live proposal's id, or a stamped `clip_consent`), older
///      than the proposal TTL + upload grace. Unconditional: orphaned clip
///      ciphertext must never be retained by default.
///  (b) optional RETENTION of posted clips: `CLIP_RETENTION_DAYS` (0 = keep,
///      the default). The ONLY timer in this codebase that deletes user data,
///      which is why the `kind = 'clip'` predicate is pinned by the live e2e
///      (an attachment row must survive it).
pub async fn sweep_clip_parts(state: &Arc<AppState>) {
    let live: Vec<String> = state.clip_proposals.iter().map(|p| p.clip_id.clone()).collect();
    let orphans: Vec<(String,)> = sqlx::query_as(
        r#"SELECT DISTINCT clip_id::text FROM uploaded_files f
           WHERE f.kind = 'clip' AND f.clip_id IS NOT NULL
             AND f.created_at < NOW() - INTERVAL '2 hours'
             AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.clip_consent->>'proposal_id' = f.clip_id::text)"#,
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    for (cid,) in orphans {
        if live.iter().any(|l| l == &cid) { continue; }
        let n = delete_clip_parts(state, &cid, None).await;
        if n > 0 { tracing::info!("clip sweep: removed {n} orphaned part(s) of {cid}"); }
    }
    let days: i64 = clip_retention_days();
    if days > 0 {
        let rows: Vec<(String,)> = sqlx::query_as(
            "DELETE FROM uploaded_files WHERE kind = 'clip' AND created_at < NOW() - make_interval(days => $1::int) RETURNING stored_name",
        )
        .bind(days as i32)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();
        for (stored,) in &rows { let _ = tokio::fs::remove_file(format!("uploads/{stored}")).await; }
        if !rows.is_empty() { tracing::info!("clip retention: removed {} part(s) older than {days} days", rows.len()); }
    }
}

/// Delete an uploaded file (DB row + on-disk blob), scoped to its uploader so a
/// caller can only remove files they own. Best-effort: it logs but never fails
/// the caller if the on-disk unlink races. Used by deletion hooks (e.g. avatar
/// replacement) to bound orphaned-file growth.
///
/// TODO(orphan-gc): a periodic sweep should reconcile uploaded_files against all
/// live references (avatars, server icons, custom emojis) plus the E2EE
/// attachment sidecars to reclaim blobs whose referencing row was deleted
/// without going through a hook. This helper + the quota are the interim bound.
/// Returns true if a row was actually removed (i.e. it existed AND belonged to
/// `owner_id`), so a caller answering an HTTP request can tell 204 from 404.
pub async fn remove_file(pool: &sqlx::PgPool, file_id: &str, owner_id: i64) -> bool {
    // An invalid uuid string errors on the ::uuid cast -> None -> no-op.
    let row: Option<(String,)> = sqlx::query_as(
        "DELETE FROM uploaded_files WHERE id = $1::uuid AND uploader_id = $2 RETURNING stored_name",
    )
    .bind(file_id)
    .bind(owner_id as i32)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);
    match row {
        Some((stored_name,)) => {
            let path = format!("uploads/{}", stored_name);
            if let Err(e) = tokio::fs::remove_file(&path).await {
                // The row is already gone, so the quota is freed either way;
                // a failed unlink leaks a blob but must not fail the caller.
                tracing::warn!("remove_file: failed to unlink {}: {:?}", path, e);
            }
            true
        }
        None => false,
    }
}

/// `GET /clips/usage` — how much of this account's clip storage is used.
///
/// Wire shape `{used_bytes, quota_bytes}` — snake_case, PINNED by the client
/// (frontend/src/api/clips/clipUpload.ts `getClipUsage`, which renders
/// nothing on any non-2xx so it shipped a release before this route). The
/// SUM matches the quota gate in `upload_file` byte-for-byte: same
/// `kind = 'clip'` filter over the same table, so the readout can never
/// disagree with what the gate will actually refuse.
///
/// Registered beside `/clips/pending`, before `/clips/:clip_id`. With this
/// axum (0.7/matchit) a static segment outranks `:param` regardless of
/// registration order — the placement is convention for the reader, not a
/// correctness requirement.
pub async fn clip_usage(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let used: (i64,) = match sqlx::query_as(
        "SELECT COALESCE(SUM(size_bytes) FILTER (WHERE kind = 'clip'), 0)::bigint \
         FROM uploaded_files WHERE uploader_id = $1",
    )
    .bind(claims.sub as i32)
    .fetch_one(&state.pool)
    .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("clip_usage: sum failed: {e:?}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "Could not read clip usage").into_response();
        }
    };
    axum::Json(serde_json::json!({
        "used_bytes": used.0,
        "quota_bytes": clip_quota_bytes(),
        // Surfaced since Phase 3 (2026-09-02); older clients ignore the key.
        "retention_days": clip_retention_days(),
    }))
    .into_response()
}

/// `DELETE /files/:file_id` — let a user reclaim their own upload quota.
///
/// The quota (`MAX_USER_STORAGE_BYTES`) is computed by summing `uploaded_files`
/// for the uploader, and until this route existed NOTHING could remove a row
/// except avatar replacement. So the quota was a one-way ratchet: ~21 max-size
/// attachments and every upload path for that account — attachment, avatar,
/// emoji, server icon — failed permanently with a message telling the user to
/// try again, which could never succeed. Deleting the messages did not help.
///
/// This has to be client-driven rather than a server-side sweep: an attachment's
/// file id lives INSIDE the E2EE ciphertext (`sovereign-enc:<id>?k=…`), so the
/// server cannot tell which blobs are still referenced. Only the client can.
pub async fn delete_file(
    State(state): State<Arc<AppState>>,
    Path(file_id): Path<String>,
    Extension(claims): Extension<crate::auth::Claims>,
) -> impl IntoResponse {
    // Refuse while something still points at it. `users.avatar_file_id` and
    // `servers.icon_file_id` are plain TEXT with NO foreign key (001_init.sql,
    // 002_add_display_name.sql), so nothing at the database level stops this
    // from turning a live avatar or server icon into a broken image for
    // everyone who can see it. `server_emojis.file_id` DOES have an FK, so that
    // one would fail the delete anyway — but it fails as a swallowed query
    // error reported as 404, which reads like "no such file" rather than "still
    // in use". Check all three here so the answer is honest.
    //
    // Deliberately only on this HTTP path. The reclaim hooks (avatar/icon
    // replacement, emoji deletion) each clear their reference BEFORE calling
    // remove_file, so they must stay able to remove a blob this check would
    // have blocked a moment earlier.
    let referenced: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT 1 WHERE EXISTS (SELECT 1 FROM users WHERE avatar_file_id = $1)
                    OR EXISTS (SELECT 1 FROM users WHERE join_sound_file_id = $1)
                    OR EXISTS (SELECT 1 FROM users WHERE leave_sound_file_id = $1)
                    OR EXISTS (SELECT 1 FROM servers WHERE icon_file_id = $1)
                    OR EXISTS (SELECT 1 FROM server_emojis WHERE file_id = $1)
        "#,
    )
    .bind(&file_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    if referenced.is_some() {
        return (
            StatusCode::CONFLICT,
            "That file is still in use as an avatar, join/leave sound, server icon or emoji. Replace or remove it there first.",
        )
            .into_response();
    }

    // Ownership is enforced inside remove_file's WHERE clause, so a file
    // belonging to someone else is indistinguishable from one that does not
    // exist — no existence oracle over other people's uploads.
    if remove_file(&state.pool, &file_id, claims.sub).await {
        StatusCode::NO_CONTENT.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

// --- DTOs ---

#[derive(Serialize)]
pub struct UploadedFileResponse {
    pub id: String,
    pub original_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub url: String,
    /// The per-file capability (base64url, 32 random bytes), returned ONCE
    /// and only when the upload asked for one (`X-Puca-Want-Cap: 1`). The
    /// server keeps its SHA-256 — see migrations/054_file_capabilities.sql.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cap: Option<String>,
}

/// FILES_ENFORCE_CAP=1 turns on phase 2: a row that carries a capability
/// hash is served only to a caller who presents the capability. Off by
/// default — phase 1 stores it, CHECKS one when presented, and does not yet
/// require it, so clients that predate the feature keep working until every
/// client in the field sends the capability it holds. NULL rows (older
/// uploads, avatars, icons, sounds, emoji, clip parts) are never gated.
fn files_enforce_cap() -> bool {
    std::env::var("FILES_ENFORCE_CAP").map(|v| v == "1").unwrap_or(false)
}

/// The GET /files decision, kept pure for its tests. `stored` is the SHA-256
/// of the minted capability (None = the row has none); `presented` is the
/// caller's base64url capability, if any. A wrong capability is refused in
/// BOTH phases: nothing legitimate presents one that does not match.
fn file_cap_allows(stored: Option<&[u8]>, presented: Option<&str>, enforce: bool) -> bool {
    let Some(hash) = stored else { return true };
    match presented {
        Some(p) => {
            let Ok(raw) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p) else { return false };
            let digest = Sha256::digest(&raw);
            // Constant-time: a mismatch must not say how many leading bytes matched.
            digest.len() == hash.len() && digest.iter().zip(hash).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
        }
        None => !enforce,
    }
}

// --- Handlers ---

/// The clip-part consent gate (docs/CLIPS.md, plan A5/F3): `kind=clip` bytes are
/// accepted ONLY for a live, APPROVED proposal owned by the caller, and only up
/// to MAX_PARTS_PER_CLIP parts. Returns the refusal response, or None to proceed.
async fn clip_upload_gate(state: &AppState, claims: &Claims, clip_id: Option<&str>, part_index: Option<i32>) -> Option<axum::response::Response> {
    let Some(cid) = clip_id else { return Some((StatusCode::BAD_REQUEST, "clip_id is required for kind=clip").into_response()); };
    let Some(idx) = part_index else { return Some((StatusCode::BAD_REQUEST, "part_index is required for kind=clip").into_response()); };
    if idx < 0 || idx as i64 >= MAX_PARTS_PER_CLIP { return Some((StatusCode::PAYLOAD_TOO_LARGE, "Too many clip parts").into_response()); }
    {
        let Some(p) = crate::clip_handlers::live_proposal(state, cid) else {
            return Some((StatusCode::FORBIDDEN, "That clip approval is not valid").into_response());
        };
        if p.proposer != claims.sub { return Some((StatusCode::FORBIDDEN, "That clip is not yours").into_response()); }
        if p.approved_at.is_none() { return Some((StatusCode::FORBIDDEN, "That clip has not been approved yet").into_response()); }
    }
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM uploaded_files WHERE clip_id = $1::uuid")
        .bind(cid).fetch_one(&state.pool).await.unwrap_or(0);
    if n >= MAX_PARTS_PER_CLIP { return Some((StatusCode::PAYLOAD_TOO_LARGE, "Too many clip parts").into_response()); }
    None
}

/// The ATTACH_FILES door.
///
/// Message content is end-to-end encrypted, so the server never sees which
/// message (or channel) an uploaded blob is attached to; the honest place to
/// honour the role bit is the upload itself, keyed by the channel the client
/// SAYS it is attaching to — the `X-Puca-Channel` header the stock client sends
/// for chat and task attachments. A header, not a multipart field, so an older
/// server (whose field loop takes any unknown field as the file body) ignores
/// it. A modified client can omit it, so this honours the setting for stock
/// clients rather than being a security boundary — and the role editor's
/// wording says so. Uploads that name no channel (avatars, emoji, sounds, DM
/// attachments) are not gated here.
pub(crate) fn attach_gate(
    access: Option<&crate::permissions::ChannelPermAccess>,
) -> Result<(), (StatusCode, &'static str)> {
    use crate::permissions::{ChannelPermAccess, Permissions};
    match access {
        None => Ok(()),
        Some(ChannelPermAccess::Allowed { perms, .. }) if perms.has(Permissions::ATTACH_FILES) => Ok(()),
        Some(ChannelPermAccess::Allowed { .. }) => Err((
            StatusCode::FORBIDDEN,
            "You don't have permission to attach files in this channel",
        )),
        Some(ChannelPermAccess::NotMember) | Some(ChannelPermAccess::NotFound) => Err((
            StatusCode::FORBIDDEN,
            "You can't attach files in that channel",
        )),
    }
}

/// Upload a file.
///
/// Multipart is read FIELD BY FIELD, in the order sent. Ordinary clients send a
/// single `file` field and land in the legacy path unchanged. Clip parts
/// (docs/CLIPS.md) send `kind=clip`, `clip_id`, `part_index` and THEN the file:
/// the consent gate ("is this proposal approved, and yours?") runs the moment
/// the scalars are in and BEFORE a single body byte is read — a modified client
/// must not be able to stream 24 MiB into server RAM per request just to be
/// refused. `kind=clip` arriving AFTER a file body was already read is a 400.
pub async fn upload_file(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    headers: axum::http::HeaderMap,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    // Per-IP ceiling on CONCURRENT uploads. `field.bytes()` below materialises
    // the whole part in RAM and this route raises the body limit to 28 MiB, so
    // N simultaneous uploads pin roughly N x 28 MiB. GET /files has had such a
    // ceiling since the slow-drip download work; the write side never got one.
    // Held for the whole handler and released on every exit path by Drop.
    let ip = crate::state::real_client_ip(&headers, peer);
    let cap = std::env::var("UPLOAD_MAX_CONCURRENT_PER_IP")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        // 8, not 4: dragging five images onto the chat is ordinary use, and the
        // client has no upload queue, so a lower cap turned a normal action into
        // 503s on the extras. Still far below what a memory-exhaustion attempt
        // needs, and the per-request 28 MiB body limit still applies.
        .unwrap_or(8)
        .max(1);
    let _upload_guard = match state.try_acquire_ip_slot(ip, crate::state::IpSlotKind::Upload, cap) {
        Some(g) => g,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                [(axum::http::header::RETRY_AFTER, "2")],
                "Too many concurrent uploads",
            )
                .into_response()
        }
    };

    // ATTACH_FILES, before a single body byte is read (same reasoning as the
    // clip gate below: a refusal must not cost 25 MiB of server RAM first).
    let attach_channel = headers
        .get("x-puca-channel")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<i64>().ok());
    let attach_access = match attach_channel {
        Some(cid) => Some(crate::permissions::get_user_channel_permissions(&state.pool, cid, claims.sub).await),
        None => None,
    };
    if let Err((code, msg)) = attach_gate(attach_access.as_ref()) {
        return (code, msg).into_response();
    }

    let mut kind = String::from("attachment");
    let mut clip_id: Option<String> = None;
    let mut part_index: Option<i32> = None;
    let mut file: Option<(String, String, axum::body::Bytes)> = None;
    let mut clip_gate_passed = false;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                tracing::error!("Failed to read multipart: {:?}", e);
                return (StatusCode::BAD_REQUEST, "Invalid multipart data").into_response();
            }
        };
        match field.name() {
            Some("kind") => {
                let v = field.text().await.unwrap_or_default();
                if v == "clip" && file.is_some() {
                    return (StatusCode::BAD_REQUEST, "kind must precede the file field").into_response();
                }
                if v == "clip" { kind = v; }
            }
            Some("clip_id") => { clip_id = field.text().await.ok().filter(|s| !s.is_empty()); }
            Some("part_index") => { part_index = field.text().await.ok().and_then(|s| s.trim().parse::<i32>().ok()); }
            _ => {
                if file.is_some() { continue; } // extras ignored
                // For a clip part, the gate runs NOW — before field.bytes().
                if kind == "clip" && !clip_gate_passed {
                    if let Some(resp) = clip_upload_gate(&state, &claims, clip_id.as_deref(), part_index).await {
                        return resp;
                    }
                    clip_gate_passed = true;
                }
                let name = field.file_name().unwrap_or("unknown").to_string();
                let mime = field.content_type().unwrap_or("application/octet-stream").to_string();
                match field.bytes().await {
                    Ok(b) => file = Some((name, mime, b)),
                    Err(e) => {
                        tracing::error!("Failed to read file data: {:?}", e);
                        return (StatusCode::BAD_REQUEST, "Failed to read file").into_response();
                    }
                }
            }
        }
    }
    let Some((original_name, mime_type, data)) = file else {
        return (StatusCode::BAD_REQUEST, "No file provided").into_response();
    };
    if kind == "clip" && !clip_gate_passed {
        // kind=clip declared but the file field never came, or came before kind
        return (StatusCode::BAD_REQUEST, "kind must precede the file field").into_response();
    }
    let is_clip = kind == "clip";

    let size_bytes = data.len() as i64;

    // Limit file size to 25MB (a clip part is ≤ 24 MiB + 35 B by construction).
    if size_bytes > 25 * 1024 * 1024 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "File too large (max 25MB)").into_response();
    }

    // Idempotent clip parts: a retry after a lost response returns the SAME row.
    if is_clip {
        if let (Some(cid), Some(idx)) = (clip_id.as_deref(), part_index) {
            let existing: Option<(String, String, String, i64)> = sqlx::query_as(
                "SELECT id::text, original_name, mime_type, size_bytes FROM uploaded_files WHERE clip_id = $1::uuid AND clip_part_index = $2 AND uploader_id = $3",
            )
            .bind(cid).bind(idx).bind(claims.sub as i32)
            .fetch_optional(&state.pool).await.unwrap_or(None);
            if let Some((id, original_name, mime_type, size_bytes)) = existing {
                // An idempotent retry returns the row that already exists; a capability
                // is returned exactly once at mint time, and clip parts never mint one.
                return axum::Json(UploadedFileResponse { url: format!("/files/{}", id), id, original_name, mime_type, size_bytes, cap: None }).into_response();
            }
        }
    }

    // M15: per-user storage quota. The endpoint is authenticated but had no
    // per-account ceiling, so one user could exhaust disk (or abuse it as free
    // hosting) up to the global limits. Reject once the account is at/over its
    // byte or file-count budget. A small overshoot under concurrent uploads is
    // fine — this is a coarse abuse ceiling, not exact accounting. SUM(bigint)
    // is NUMERIC in Postgres, so cast back to bigint for the i64 decode.
    // Two buckets: attachments (unchanged 512 MB / 5000 files) and clip parts
    // (their own byte budget). `kind` is NOT NULL DEFAULT 'attachment' (050), so
    // the FILTERs are safe on every pre-existing row.
    let usage: (i64, i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(size_bytes) FILTER (WHERE kind <> 'clip'), 0)::bigint, \
                COUNT(*) FILTER (WHERE kind <> 'clip'), \
                COALESCE(SUM(size_bytes) FILTER (WHERE kind = 'clip'), 0)::bigint \
         FROM uploaded_files WHERE uploader_id = $1",
    )
    .bind(claims.sub as i32)
    .fetch_one(&state.pool)
    .await
    .unwrap_or((0, 0, 0));
    if is_clip {
        if usage.2 + size_bytes > clip_quota_bytes() {
            tracing::warn!("clip quota exceeded for user {} ({} bytes)", claims.sub, usage.2);
            return (StatusCode::INSUFFICIENT_STORAGE, "Clip storage quota exceeded — delete older clips").into_response();
        }
    } else if usage.1 >= MAX_USER_FILES || usage.0 + size_bytes > MAX_USER_STORAGE_BYTES {
        tracing::warn!(
            "upload quota exceeded for user {} ({} bytes / {} files)",
            claims.sub,
            usage.0,
            usage.1
        );
        return (StatusCode::INSUFFICIENT_STORAGE, "Storage quota exceeded").into_response();
    }

    // Generate unique file ID and storage name
    let file_id = Uuid::new_v4().to_string();
    // A per-file capability, minted only when the client asks: attachments
    // do (the capability rides inside the encrypted message beside the file
    // key); avatars, icons, sounds, emoji and clip parts do not (their
    // consumers hold no secret). Stored hashed, returned once, never logged.
    let want_cap = headers.get("x-puca-want-cap").and_then(|v| v.to_str().ok()) == Some("1");
    let (cap_b64, cap_hash): (Option<String>, Option<Vec<u8>>) = if want_cap {
        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        (
            Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)),
            Some(Sha256::digest(raw).to_vec()),
        )
    } else {
        (None, None)
    };
    let extension = original_name
        .rsplit('.')
        .next()
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    let stored_name = format!("{}{}", file_id, extension);

    // Save file to disk
    let file_path = format!("uploads/{}", stored_name);
    let mut file = match File::create(&file_path).await {
        Ok(f) => f,
        Err(e) => {
            tracing::error!("Failed to create file: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save file").into_response();
        }
    };

    if let Err(e) = file.write_all(&data).await {
        tracing::error!("Failed to write file: {:?}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save file").into_response();
    }

    // Save metadata to database
    // uploader_id is INTEGER (i32) in PostgreSQL
    let result = sqlx::query(
        // id column is uuid — cast the text binding or Postgres rejects with 42804.
        "INSERT INTO uploaded_files (id, uploader_id, original_name, stored_name, mime_type, size_bytes, kind, clip_id, clip_part_index, cap_hash) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10)",
    )
    .bind(&file_id)
    .bind(claims.sub as i32)
    .bind(&original_name)
    .bind(&stored_name)
    .bind(&mime_type)
    .bind(size_bytes)
    .bind(if is_clip { "clip" } else { "attachment" })
    .bind(if is_clip { clip_id.clone() } else { None })
    .bind(if is_clip { part_index } else { None })
    .bind(cap_hash)
    .execute(&state.pool)
    .await;

    if let Err(e) = result {
        tracing::error!("Failed to save file metadata: {:?}", e);
        // Clean up the file
        let _ = tokio::fs::remove_file(&file_path).await;
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to save file metadata",
        )
            .into_response();
    }

    axum::Json(UploadedFileResponse {
        id: file_id.clone(),
        original_name,
        mime_type,
        size_bytes,
        url: format!("/files/{}", file_id),
        cap: cap_b64,
    })
    .into_response()
}

/// Get/download a file
pub async fn get_file(
    State(state): State<Arc<AppState>>,
    Path(file_id): Path<String>,
    headers: axum::http::HeaderMap,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> impl IntoResponse {
    // Per-real-IP concurrent-download ceiling: the 50/s API limiter meters request
    // rate but not concurrent long-lived (slow-drip) streams, each holding an fd +
    // up to 10 MB of egress on a residential uplink. Held for the stream's whole
    // life (moved into the body stream below); released on early-return too.
    let ip = crate::state::real_client_ip(&headers, peer);
    let cap = std::env::var("FILE_MAX_CONCURRENT_PER_IP")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(32)
        .max(1); // never 0 (a 0 cap would refuse all + leak an unreaped entry per IP)
    let stream_guard = match state.try_acquire_ip_slot(ip, crate::state::IpSlotKind::File, cap) {
        Some(g) => g,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::RETRY_AFTER, "2")],
                "Too many concurrent downloads",
            )
                .into_response()
        }
    };

    // Get file metadata
    let file_info: Option<(String, String, String, Option<Vec<u8>>)> = sqlx::query_as(
        // id is uuid; cast the binding (an invalid uuid string errors -> None -> 404).
        "SELECT stored_name, original_name, mime_type, cap_hash FROM uploaded_files WHERE id = $1::uuid",
    )
    .bind(&file_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    let (stored_name, original_name, mime_type, cap_hash) = match file_info {
        Some(info) => info,
        None => return (StatusCode::NOT_FOUND, "File not found").into_response(),
    };
    // Per-object capability (migrations/054). 404, never 403: a file this
    // caller may not fetch must look like one that does not exist, the
    // same existence oracle delete_file deliberately withholds.
    let presented = headers.get("x-puca-file-cap").and_then(|v| v.to_str().ok());
    if !file_cap_allows(cap_hash.as_deref(), presented, files_enforce_cap()) {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    }

    // Open the file
    let file_path = format!("uploads/{}", stored_name);
    let file = match File::open(&file_path).await {
        Ok(f) => f,
        Err(_) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
    };

    // Stream the file. Move stream_guard into the stream (UFCS map) so the per-IP
    // slot is released only when the stream finishes or the client disconnects,
    // not when this handler returns (which is immediately).
    let stream = futures::StreamExt::map(ReaderStream::new(file), move |res| {
        let _ = &stream_guard;
        res
    });
    let body = Body::from_stream(stream);

    // Security: files are served from the same origin as the API, so an
    // attacker-uploaded HTML/SVG/JS file served `inline` with an
    // attacker-controlled Content-Type would execute as stored XSS. Only allow
    // inline rendering for a safe allowlist of media types; everything else is
    // forced to download. `nosniff` prevents the browser from ignoring the
    // declared type and sniffing e.g. HTML out of an "image".
    let is_inline_safe = matches!(
        mime_type.as_str(),
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/bmp"
            | "video/mp4"
            | "video/webm"
            | "audio/mpeg"
            | "audio/ogg"
            | "audio/wav"
            | "application/pdf"
    );

    // Sanitize the filename for the header (strip quotes/control chars/newlines).
    let safe_name: String = original_name
        .chars()
        .filter(|c| !c.is_control() && *c != '"' && *c != '\\')
        .take(255)
        .collect();

    let disposition = if is_inline_safe {
        format!("inline; filename=\"{}\"", safe_name)
    } else {
        format!("attachment; filename=\"{}\"", safe_name)
    };

    (
        [
            (header::CONTENT_TYPE, mime_type),
            (header::CONTENT_DISPOSITION, disposition),
            (
                header::HeaderName::from_static("x-content-type-options"),
                "nosniff".to_string(),
            ),
            // MUST stay `private`. This route is authenticated now, and
            // chat.example.com is proxied through Cloudflare — without an
            // explicit private/no-store directive a zone cache rule matching
            // /files/* (by path, by content-type, or a blanket "cache
            // everything") lets an edge node keep one authorised response and
            // hand it to anonymous requests. That would silently restore the
            // exact hole the auth was added to close, at the edge, invisible
            // to the origin and to any test that only talks to the origin.
            (header::CACHE_CONTROL, "private, no-store".to_string()),
        ],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod retention_tests {
    use super::parse_retention_days;

    #[test]
    fn unset_unparsable_or_negative_means_keep_forever() {
        assert_eq!(parse_retention_days(None), 0);
        assert_eq!(parse_retention_days(Some("thirty".into())), 0);
        assert_eq!(parse_retention_days(Some("-5".into())), 0);
        assert_eq!(parse_retention_days(Some("0".into())), 0);
    }

    #[test]
    fn a_positive_number_is_the_schedule() {
        assert_eq!(parse_retention_days(Some("30".into())), 30);
        assert_eq!(parse_retention_days(Some(" 7 ".into())), 7);
    }
}

#[cfg(test)]
mod file_cap_tests {
    use super::file_cap_allows;
    use base64::Engine;
    use sha2::{Digest, Sha256};

    fn minted() -> (String, Vec<u8>) {
        let raw = [7u8; 32];
        (base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw), Sha256::digest(raw).to_vec())
    }

    #[test]
    fn a_row_without_a_capability_is_never_gated() {
        for enforce in [false, true] {
            assert!(file_cap_allows(None, None, enforce));
            assert!(file_cap_allows(None, Some("anything"), enforce));
        }
    }

    #[test]
    fn the_right_capability_is_accepted_in_both_phases() {
        let (cap, hash) = minted();
        assert!(file_cap_allows(Some(&hash), Some(&cap), false));
        assert!(file_cap_allows(Some(&hash), Some(&cap), true));
    }

    #[test]
    fn a_wrong_or_malformed_capability_is_refused_in_both_phases() {
        let (_, hash) = minted();
        let other = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([9u8; 32]);
        for enforce in [false, true] {
            assert!(!file_cap_allows(Some(&hash), Some(&other), enforce));
            assert!(!file_cap_allows(Some(&hash), Some("not base64!!"), enforce));
            assert!(!file_cap_allows(Some(&hash), Some(""), enforce));
        }
    }

    #[test]
    fn a_missing_capability_is_the_phase_switch() {
        let (_, hash) = minted();
        assert!(file_cap_allows(Some(&hash), None, false), "phase 1: old clients still fetch");
        assert!(!file_cap_allows(Some(&hash), None, true), "phase 2: the capability is required");
    }
}

#[cfg(test)]
mod attach_gate_tests {
    use super::attach_gate;
    use crate::permissions::{ChannelPermAccess, Permissions};
    use axum::http::StatusCode;

    fn allowed(perms: Permissions) -> ChannelPermAccess {
        ChannelPermAccess::Allowed { server_id: "srv".to_string(), perms }
    }

    #[test]
    fn an_upload_naming_no_channel_is_not_gated() {
        assert!(attach_gate(None).is_ok());
    }

    #[test]
    fn the_bit_admits_and_its_absence_refuses() {
        assert!(attach_gate(Some(&allowed(Permissions::ATTACH_FILES | Permissions::VIEW_CHANNEL))).is_ok());
        let refused = attach_gate(Some(&allowed(Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES))).unwrap_err();
        assert_eq!(refused.0, StatusCode::FORBIDDEN);
        assert!(refused.1.contains("attach files"));
    }

    #[test]
    fn an_administrator_passes_without_the_literal_bit() {
        assert!(attach_gate(Some(&allowed(Permissions::ADMINISTRATOR))).is_ok());
    }

    #[test]
    fn a_stranger_or_a_missing_channel_is_refused_not_admitted() {
        assert_eq!(attach_gate(Some(&ChannelPermAccess::NotMember)).unwrap_err().0, StatusCode::FORBIDDEN);
        assert_eq!(attach_gate(Some(&ChannelPermAccess::NotFound)).unwrap_err().0, StatusCode::FORBIDDEN);
    }
}
