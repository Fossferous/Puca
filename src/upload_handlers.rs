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
use chrono::{DateTime, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::auth::Claims;
use crate::state::AppState;

/// Per-user upload quota (M15). Coarse abuse ceilings, not exact accounting.
const DEFAULT_MAX_USER_STORAGE_BYTES: i64 = 512 * 1024 * 1024; // 512 MB per user (attachments bucket)

/// UPLOAD_MAX_USER_BYTES: the per-user attachment quota, bytes. Default 512 MiB;
/// bounded below at 1 MiB so a typo cannot lock every upload out.
pub(crate) fn max_user_storage_bytes() -> i64 {
    std::env::var("UPLOAD_MAX_USER_BYTES")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|b| *b >= 1024 * 1024)
        .unwrap_or(DEFAULT_MAX_USER_STORAGE_BYTES)
}
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

/// Uploads of deleted accounts whose grace period has passed. Anything a SERVER
/// asset has picked up since the stamp is skipped.
pub(crate) const UPLOADS_DUE_FOR_PURGE_SQL: &str = "SELECT id::text, stored_name FROM uploaded_files \
     WHERE purge_after IS NOT NULL AND purge_after < NOW() \
       AND id::text NOT IN (SELECT icon_file_id FROM servers WHERE icon_file_id IS NOT NULL) \
       AND id::text NOT IN (SELECT background_file_id FROM server_modes WHERE background_file_id IS NOT NULL) \
       AND id::text NOT IN (SELECT file_id FROM custom_emojis WHERE file_id IS NOT NULL) \
       AND id::text NOT IN (SELECT file_id FROM server_emojis WHERE file_id IS NOT NULL) \
     ORDER BY purge_after LIMIT 200";

/// Does anything still point at this file as an asset: an avatar, a sound, a
/// server icon, a mode background or an emoji?
pub(crate) async fn file_is_referenced(pool: &sqlx::PgPool, file_id: &str) -> Result<bool, sqlx::Error> {
    let referenced: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT 1 WHERE EXISTS (SELECT 1 FROM users WHERE avatar_file_id = $1)
                    OR EXISTS (SELECT 1 FROM users WHERE join_sound_file_id = $1)
                    OR EXISTS (SELECT 1 FROM users WHERE leave_sound_file_id = $1)
                    OR EXISTS (SELECT 1 FROM servers WHERE icon_file_id = $1)
                    OR EXISTS (SELECT 1 FROM server_modes WHERE background_file_id = $1)
                    OR EXISTS (SELECT 1 FROM server_emojis WHERE file_id = $1)
        "#,
    )
    .bind(file_id)
    .fetch_optional(pool)
    .await?;
    Ok(referenced.is_some())
}

/// [`remove_file`] for a reclaim hook, called once the hook has cleared its own
/// reference: only when nothing else still points at the file, since one upload can be
/// an icon, a mode's background and an avatar at once. Scoped like `remove_file`. A
/// failed check keeps the file: an orphan is harmless, a broken picture is not.
pub async fn reclaim_file(pool: &sqlx::PgPool, file_id: &str, owner_id: i64) {
    if matches!(file_is_referenced(pool, file_id).await, Ok(false)) {
        remove_file(pool, file_id, owner_id).await;
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
    match try_remove_file(pool, file_id, owner_id).await {
        Ok(removed) => removed,
        // An invalid uuid string errors on the ::uuid cast -> no-op.
        Err(e) => {
            if !id_was_malformed(&e) {
                tracing::warn!("remove_file: could not remove file {file_id:?}: {e:?}");
            }
            false
        }
    }
}

/// [`remove_file`] with a DELETE the database did not carry out returned as
/// `Err`, for DELETE /files/:id: answering that with the 404 of a file that is
/// gone would have the caller forget a file that is still there.
async fn try_remove_file(pool: &sqlx::PgPool, file_id: &str, owner_id: i64) -> Result<bool, sqlx::Error> {
    let row: Option<(String,)> = sqlx::query_as(
        "DELETE FROM uploaded_files WHERE id = $1::uuid AND uploader_id = $2 RETURNING stored_name",
    )
    .bind(file_id)
    .bind(owner_id as i32)
    .fetch_optional(pool)
    .await?;
    match row {
        Some((stored_name,)) => {
            let path = format!("uploads/{}", stored_name);
            if let Err(e) = tokio::fs::remove_file(&path).await {
                // The row is already gone, so the quota is freed either way;
                // a failed unlink leaks a blob but must not fail the caller.
                tracing::warn!("remove_file: failed to unlink {}: {:?}", path, e);
            }
            Ok(true)
        }
        None => Ok(false),
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
/// The quota (`max_user_storage_bytes()`) is computed by summing `uploaded_files`
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
    // Uploader first, everything else second. The in-use probe below is
    // unscoped, so answering it before the ownership check told any account
    // whether an arbitrary uuid was someone's live avatar, icon, sound or emoji
    // (409) rather than unknown (404). A file the caller does not own must be
    // indistinguishable from one that does not exist. An invalid uuid string
    // errors on the cast -> treated as no row -> 404. Any OTHER error is the
    // database failing, not an answer: 503, so the caller does not take a
    // file that is still there (and still counts against its quota) for gone.
    // It comes before ownership is known, so it says nothing about the id.
    // id::text: the cast accepts other spellings of a uuid, and the in-use check below
    // compares text, so DELETE /files/<upper case> must not read as unreferenced.
    let mine: Option<(String,)> = match sqlx::query_as(
        "SELECT id::text FROM uploaded_files WHERE id = $1::uuid AND uploader_id = $2",
    )
    .bind(&file_id)
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(row) => row,
        Err(e) if id_was_malformed(&e) => None,
        Err(e) => {
            tracing::error!("delete_file: ownership lookup failed for file {file_id:?}: {e:?}");
            return try_again_shortly("Could not delete that file right now");
        }
    };
    let Some((file_id,)) = mine else {
        return StatusCode::NOT_FOUND.into_response();
    };

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
    //
    // A check that FAILS refuses (503). It used to read as "not in use" and go
    // on to delete: a database hiccup at this line removed a live avatar or
    // server icon, the one thing the check is here to prevent.
    match file_is_referenced(&state.pool, &file_id).await {
        Ok(false) => {}
        Ok(true) => {
            return (
                StatusCode::CONFLICT,
                "That file is still in use as an avatar, join/leave sound, server icon, mode background or emoji. Replace or remove it there first.",
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("delete_file: in-use check failed for file {file_id}: {e:?}");
            return try_again_shortly("Could not delete that file right now");
        }
    }

    // Ownership is enforced inside remove_file's WHERE clause, so a file
    // belonging to someone else is indistinguishable from one that does not
    // exist — no existence oracle over other people's uploads. A DELETE that
    // errored is a 503, not the 404 of a file that is gone: usually the row is
    // still there. (If the connection dropped after the commit, it is not,
    // and the retry's 404 says so.)
    match try_remove_file(&state.pool, &file_id, claims.sub).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            tracing::error!("delete_file: the delete of file {file_id} failed: {e:?}");
            try_again_shortly("Could not delete that file right now")
        }
    }
}

/// The answer when the server cannot tell right now: 503 with `Retry-After: 2`,
/// the shape GET /files' per-IP download ceiling already answers with. Still
/// a refusal (nothing is served or deleted), but one a client may retry. A 404
/// for a database fault says "there is no such file", and a client that
/// believes it (one that stops asking for a 404 for the rest of the session)
/// left a picture, icon or emoji blank over one busy moment.
fn try_again_shortly(what: &'static str) -> axum::response::Response {
    (StatusCode::SERVICE_UNAVAILABLE, [(header::RETRY_AFTER, "2")], what).into_response()
}

/// Did this lookup fail because of the id the caller sent? Two codes say so:
/// 22P02 when the id is not a uuid (the `::uuid` cast), and 22021 when it
/// carries a NUL byte (`/files/%00`), which Postgres refuses in any text. Such
/// an id names no file, so it is a 404 like any other unknown id. Exactly
/// those two, not their whole class: 22P03 is class 22 too, and it is OUR bug
/// (a cached statement bound with a second type, CLAUDE.md's sql-bind-types
/// gate), which a believed 404 would hide as "no such file". Everything else
/// (a pool that timed out, a dropped connection, a statement the server
/// cancelled) is the server's trouble.
fn id_was_malformed(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .and_then(|d| d.code())
        .is_some_and(|code| matches!(code.as_ref(), "22P02" | "22021"))
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

/// Phase 2 of per-file capabilities: a row that carries a capability hash is
/// served only to a caller who presents the capability. ON by default since
/// every client has sent the capability it holds since 0.8.134 and production
/// has enforced it since 2026-09-02; the default-off period existed only so
/// older clients kept working while they updated. `FILES_ENFORCE_CAP=0` turns
/// it off (phase 1: store, check when presented, never require). NULL rows
/// (older uploads, avatars, icons, sounds, emoji, clip parts) are never gated
/// in either phase.
fn files_enforce_cap() -> bool {
    match std::env::var("FILES_ENFORCE_CAP") {
        Ok(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no"),
        Err(_) => true,
    }
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

/// The on-disk extension for an upload: the final path component's suffix,
/// and only when it is short and alphanumeric. Anything else — a separator,
/// a dot-only name, an over-long or exotic suffix — stores with none. The
/// stored name is `<uuid><ext>` under `uploads/`, so this is what keeps the
/// uploader's filename from steering the path or the served extension.
pub(crate) fn storage_extension(original_name: &str) -> String {
    let last = original_name.rsplit(['/', '\\']).next().unwrap_or("");
    match last.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() && ext.len() <= 16
            && ext.bytes().all(|b| b.is_ascii_alphanumeric()) => format!(".{}", ext.to_ascii_lowercase()),
        _ => String::new(),
    }
}

#[cfg(test)]
mod storage_extension_tests {
    use super::storage_extension;

    #[test]
    fn only_a_short_alphanumeric_suffix_survives() {
        assert_eq!(storage_extension("photo.PNG"), ".png");
        assert_eq!(storage_extension("dir/sub/clip.mp4"), ".mp4");
        assert_eq!(storage_extension("C:\\Users\\x\\note.txt"), ".txt");
        assert_eq!(storage_extension("archive.tar.gz"), ".gz");
        assert_eq!(storage_extension("noext"), "");
        assert_eq!(storage_extension(".bashrc"), "", "a dot-file has no extension");
        assert_eq!(storage_extension("x."), "");
        assert_eq!(storage_extension("x.ex e"), "");
        assert_eq!(storage_extension("x.a/../../b"), "", "a separator inside the suffix is not a suffix");
        assert_eq!(storage_extension("x.toolongextensionname"), "");
        assert_eq!(storage_extension("x.ph*p"), "");
    }
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
    } else if usage.1 >= MAX_USER_FILES || usage.0 + size_bytes > max_user_storage_bytes() {
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
    let stored_name = format!("{}{}", file_id, storage_extension(&original_name));

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
/// Migration 054's own install time: the moment this server began minting
/// capabilities. An uncapped, unreferenced file created BEFORE it is an
/// attachment posted by a client that predates capabilities; the only thing
/// that knows which channel it belongs to is the encrypted message carrying
/// its id, so the server cannot scope it and it stays fetchable by any
/// signed-in account (the documented "older uploads keep working" guarantee).
/// One created AFTER it has no such excuse. `Ok(None)` when the row is
/// absent (a database that never had capabilities: everything on it is
/// legacy). A lookup ERROR is returned as such so the caller fails closed —
/// a transient fault must not serve a stranger a file, the same posture as
/// the membership probes in permissions.rs.
async fn cap_era_start(pool: &sqlx::PgPool) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar::<_, DateTime<Utc>>(
        "SELECT installed_on FROM _sqlx_migrations WHERE version = 54",
    )
    .fetch_optional(pool)
    .await
}

/// The decision for a file that carries NO capability.
///
/// Such a file used to be served to every signed-in account that learned its
/// id — `file_cap_allows` says "not gated" and nothing else looked. Found on
/// 2026-09-07: an account sharing no server, friendship or conversation with
/// the uploader fetched the bytes. Now it is served only when
/// - the caller uploaded it, or
/// - it is a REFERENCED asset the caller is entitled to see (`visible_as_asset`):
///   an avatar or join/leave sound of an account in the caller's identity
///   context (friends, a shared server, or a conversation that account
///   started — the same rule that lets the caller see that account at all),
///   an icon, mode background or emoji of a server the caller belongs to (or a
///   public one, which `/discover` already shows everyone), or a part of a clip posted
///   in a channel the caller can VIEW, or
/// - it predates capabilities (see `cap_era_start`), or
/// - the operator turned enforcement off (`FILES_ENFORCE_CAP=0`), the same
///   switch that already widens CAPPED files for pre-0.8.134 clients.
///
/// Anything else — a post-capability upload that asked for no capability and
/// is referenced by nothing — is visible to its uploader alone. That shape is
/// an attachment some client forgot to protect, and refusing it here is the
/// safety net the upload side cannot be: an avatar and an attachment are
/// indistinguishable at upload (both `kind = 'attachment'`), so the server
/// cannot demand a capability there without breaking every avatar.
fn uncapped_decision(is_uploader: bool, visible_as_asset: bool, is_legacy: bool, enforce: bool) -> bool {
    is_uploader || visible_as_asset || is_legacy || !enforce
}

/// What [`uncapped_file_visible`] could establish about one caller and one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileVisibility {
    /// A check that the database ANSWERED admits the caller.
    Visible,
    /// Every check answered, and none admits the caller: the 404.
    NotVisible,
    /// No check that answered admits the caller, and at least one failed, so
    /// the answer is not known. Refused like `NotVisible` (nothing is served),
    /// but as a 503 the client retries rather than a 404 it believes.
    CouldNotTell,
}

/// Resolve `uncapped_decision`'s inputs for one file. Fails CLOSED on any
/// database error (logged), like the membership probes in permissions.rs:
/// a failed lookup never admits anyone. It is `CouldNotTell` rather than
/// `NotVisible` unless a check that did answer admits the caller anyway
/// (every grant is enough on its own, so one that answered stands).
/// Checks run cheapest and most common first, so the everyday avatar fetch
/// never reaches the migration-table lookup; a failure asks no more of the
/// database than the same request asked before failures were told apart.
pub(crate) async fn uncapped_file_visible(
    pool: &sqlx::PgPool,
    file_id: &str,
    uploader_id: i64,
    kind: &str,
    clip_id: Option<&str>,
    created_at: Option<DateTime<Utc>>,
    caller: i64,
) -> FileVisibility {
    if uploader_id == caller {
        return FileVisibility::Visible;
    }
    // Set when a lookup below fails: nothing it could have granted is known.
    let mut unsure = false;

    // Which asset roles this file plays, and whether the caller may see them.
    // Avatars and sounds hang off ONE account; icons and emoji off servers.
    // The asset columns are TEXT holding the uuid as text (delete_file's
    // in-use check compares the same way).
    let (asset_owner, server_visible): (Option<i32>, bool) = match sqlx::query_as(
        "SELECT \
           (SELECT u.id FROM users u \
             WHERE (u.avatar_file_id = $1 OR u.join_sound_file_id = $1 OR u.leave_sound_file_id = $1) \
               AND u.deleted_at IS NULL LIMIT 1), \
           EXISTS (SELECT 1 FROM servers s \
                    WHERE (s.icon_file_id = $1 \
                           OR s.id IN (SELECT server_id FROM server_modes WHERE background_file_id = $1) \
                           OR s.id IN (SELECT server_id FROM server_emojis WHERE file_id = $1) \
                           OR s.id IN (SELECT server_id FROM custom_emojis WHERE file_id = $1)) \
                      AND (s.is_public \
                           OR EXISTS (SELECT 1 FROM server_members m \
                                       WHERE m.server_id = s.id AND m.user_id = $2)))",
    )
    .bind(file_id)
    .bind(caller as i32)
    .fetch_one(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            // Without this row nothing below knows whose avatar or which
            // server's icon it is; stop here, as this check always has.
            tracing::error!("uncapped_file_visible: asset lookup failed for file {file_id}: {e:?}");
            return FileVisibility::CouldNotTell;
        }
    };
    if server_visible {
        return FileVisibility::Visible;
    }
    if let Some(owner) = asset_owner {
        // ONE definition of "may see this account" — do not restate it here.
        match crate::dm_handlers::try_users_share_identity_context(pool, caller, owner as i64).await {
            Ok(true) => return FileVisibility::Visible,
            Ok(false) => {}
            Err(e) => {
                tracing::error!("uncapped_file_visible: identity-context lookup failed for file {file_id}: {e:?}");
                unsure = true;
            }
        }
    }

    // A clip part is visible wherever the clip was POSTED: send_message stamps
    // the proposal id into messages.clip_consent. A proposal not yet posted
    // has no message, and its parts belong to the proposer alone (the uploader
    // check above).
    if kind == "clip" {
        if let Some(cid) = clip_id {
            let channel: Option<i32> = match sqlx::query_scalar(
                "SELECT channel_id FROM messages \
                 WHERE clip_consent IS NOT NULL AND clip_consent->>'proposal_id' = $1 LIMIT 1",
            )
            .bind(cid)
            .fetch_optional(pool)
            .await
            {
                Ok(ch) => ch,
                Err(e) => {
                    tracing::error!("uncapped_file_visible: clip lookup failed for {cid}: {e:?}");
                    unsure = true;
                    None
                }
            };
            if let Some(ch) = channel {
                // The resolver logs its own failures.
                match crate::permissions::try_user_channel_permissions(pool, ch as i64, caller).await {
                    Ok(crate::permissions::ChannelPermAccess::Allowed { perms, .. })
                        if perms.has(crate::permissions::Permissions::VIEW_CHANNEL) =>
                    {
                        return FileVisibility::Visible;
                    }
                    Ok(_) => {}
                    Err(crate::permissions::LookupFailed) => unsure = true,
                }
            }
        }
    }

    let is_legacy = match created_at {
        None => true,
        Some(c) => match cap_era_start(pool).await {
            Ok(Some(era)) => c < era,
            Ok(None) => true,
            Err(e) => {
                tracing::error!("uncapped_file_visible: migration-era lookup failed for file {file_id}: {e:?}");
                unsure = true;
                false // fail closed: not known to be legacy
            }
        },
    };
    if uncapped_decision(false, false, is_legacy, files_enforce_cap()) {
        FileVisibility::Visible
    } else if unsure {
        FileVisibility::CouldNotTell
    } else {
        FileVisibility::NotVisible
    }
}

/// The answer when the blob of a file the caller may fetch will not open.
/// `NotFound` is the file being gone (its row outlived the blob): a 404, and a
/// retry cannot help. Anything else (the process out of file descriptors, a
/// permission or I/O fault on the uploads directory) is the server's trouble,
/// not the file's: a 503 to retry. Only callers already allowed this file get
/// here, so the difference tells nobody anything they may not know.
fn open_failure_response(e: &std::io::Error) -> axum::response::Response {
    if e.kind() == std::io::ErrorKind::NotFound {
        (StatusCode::NOT_FOUND, "File not found").into_response()
    } else {
        try_again_shortly("File temporarily unavailable, try again shortly")
    }
}

pub async fn get_file(
    State(state): State<Arc<AppState>>,
    Path(file_id): Path<String>,
    Extension(claims): Extension<Claims>,
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
    #[allow(clippy::type_complexity)]
    let file_info: Option<(String, String, String, Option<Vec<u8>>, i32, String, Option<String>, Option<DateTime<Utc>>)> = match sqlx::query_as(
        // id is uuid; cast the binding (an invalid uuid string errors -> no row -> 404).
        "SELECT stored_name, original_name, mime_type, cap_hash, uploader_id, kind, clip_id::text, created_at \
         FROM uploaded_files WHERE id = $1::uuid",
    )
    .bind(&file_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(row) => row,
        // A malformed id names no file: the same 404 as an unknown one.
        Err(e) if id_was_malformed(&e) => None,
        // The database did not answer (a pool timeout under load, a dropped
        // connection): not "no such file". This comes before the row is known,
        // so it says nothing about whether the id exists.
        Err(e) => {
            tracing::error!("get_file: metadata lookup failed for file {file_id:?}: {e:?}");
            return try_again_shortly("File temporarily unavailable, try again shortly");
        }
    };

    let (stored_name, original_name, mime_type, cap_hash, uploader_id, kind, clip_id, created_at) = match file_info {
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
    // No capability does NOT mean public. Scope the file to the people it is
    // for (see uncapped_decision); a stranger who merely learned the id gets
    // the same 404 as above.
    //
    // A check the database could not answer is a 503, not that 404. That 503
    // comes only once the row was found, so in principle it tells a caller who
    // may not see the file that the id exists. Judged not worth hiding:
    // - ids are random v4 uuids, so the only ids anyone can ask about are ones
    //   they already learned somewhere;
    // - for such an id, the response time already says as much today: a found
    //   uncapped row runs the lookups below, an unknown id runs none;
    // - to see the 503 at all, the database must answer the lookup above and
    //   then fail inside the same request;
    // - answering 404 to anyone but the uploader instead would undo the fix
    //   where it matters: avatars, icons and emoji are fetched by friends and
    //   members, and the uploader never reaches a lookup here (the first check).
    // Capped files (attachments) never get here: the capability gates them,
    // with no database question after the row.
    if cap_hash.is_none() {
        match uncapped_file_visible(
            &state.pool,
            &file_id,
            uploader_id as i64,
            &kind,
            clip_id.as_deref(),
            created_at,
            claims.sub,
        )
        .await
        {
            FileVisibility::Visible => {}
            FileVisibility::NotVisible => return (StatusCode::NOT_FOUND, "File not found").into_response(),
            // Already logged where the lookup failed.
            FileVisibility::CouldNotTell => {
                return try_again_shortly("File temporarily unavailable, try again shortly")
            }
        }
    }

    // Open the file
    let file_path = format!("uploads/{}", stored_name);
    let file = match File::open(&file_path).await {
        Ok(f) => f,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::error!("get_file: could not open the blob of file {file_id}: {e:?}");
            }
            return open_failure_response(&e);
        }
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

#[cfg(test)]
mod uncapped_file_tests {
    //! A file with no capability is scoped to the people it is for. Found
    //! 2026-09-07 by a live probe: a signed-in account sharing nothing with
    //! the uploader fetched an uncapped file's bytes by id. `file_cap_tests`
    //! above still says such a row is "never gated" BY THE CAPABILITY — this
    //! module is the gate that follows it.
    use super::{uncapped_decision, uncapped_file_visible, FileVisibility};

    #[test]
    fn each_grant_alone_admits_and_no_grant_refuses() {
        assert!(uncapped_decision(true, false, false, true), "the uploader");
        assert!(uncapped_decision(false, true, false, true), "an entitled asset viewer");
        assert!(uncapped_decision(false, false, true, true), "a pre-capability upload");
        assert!(uncapped_decision(false, false, false, false), "enforcement switched off");
        // THE FINDING. A post-capability upload nobody references, fetched by
        // an account that did not upload it, under default enforcement.
        assert!(
            !uncapped_decision(false, false, false, true),
            "a stranger must not be served an uncapped file merely for knowing its id"
        );
    }

    /// The real decision against a real database: strangers refused, the
    /// uploader / co-members / friends / public-server browsers / clip
    /// viewers admitted, and access ENDING when the relationship does (the
    /// post-ban case). Skips (prints) only without TEST_DATABASE_URL
    /// (migrator::test_pool).
    #[tokio::test]
    async fn a_stranger_cannot_fetch_an_uncapped_file_but_the_people_it_is_for_can() {
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        // Under FILES_ENFORCE_CAP=0 every branch below admits; the pure test
        // pins that switch, this one needs the default.
        std::env::remove_var("FILES_ENFORCE_CAP");

        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk_user = |n: &str| {
            let name = format!("ucf_{n}_{tag}");
            let pool = pool.clone();
            async move {
                let (id,): (i32,) = sqlx::query_as(
                    "INSERT INTO users (username, email, salt, verifier, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id",
                )
                .bind(&name).bind(format!("{name}@test.invalid")).bind(b"s".as_ref()).bind(b"v".as_ref())
                .fetch_one(&pool).await.expect("insert user");
                id as i64
            }
        };
        let uploader = mk_user("uploader").await;
        let stranger = mk_user("stranger").await;
        let other = mk_user("other").await;

        let mk_file = |kind: &'static str, clip: Option<String>| {
            let pool = pool.clone();
            async move {
                let id = uuid::Uuid::new_v4().to_string();
                sqlx::query(
                    "INSERT INTO uploaded_files (id, uploader_id, original_name, stored_name, mime_type, size_bytes, kind, clip_id) \
                     VALUES ($1::uuid, $2, 'f', 'f', 'text/plain', 1, $3, $4::uuid)",
                )
                .bind(&id).bind(uploader as i32).bind(kind).bind(clip)
                .execute(&pool).await.expect("insert file");
                id
            }
        };
        let vis = |file: &str, who: i64, kind: &'static str, clip: Option<&str>| {
            let pool = pool.clone();
            let file = file.to_string();
            let clip = clip.map(str::to_string);
            async move {
                uncapped_file_visible(&pool, &file, uploader, kind, clip.as_deref(), Some(chrono::Utc::now()), who).await
            }
        };

        // --- an unreferenced, post-capability upload ---
        let plain = mk_file("attachment", None).await;
        assert_eq!(vis(&plain, stranger, "attachment", None).await, FileVisibility::NotVisible, "THE FINDING: a stranger fetched this");
        assert_eq!(vis(&plain, uploader, "attachment", None).await, FileVisibility::Visible, "the uploader always may");

        // --- an avatar: visible inside the owner's identity context only ---
        sqlx::query("UPDATE users SET avatar_file_id = $1 WHERE id = $2").bind(&plain).bind(uploader as i32).execute(&pool).await.unwrap();
        assert_eq!(vis(&plain, stranger, "attachment", None).await, FileVisibility::NotVisible, "being someone's avatar admits nobody by itself");
        sqlx::query("INSERT INTO friends (user1_id, user2_id) VALUES ($1, $2)").bind(uploader).bind(stranger).execute(&pool).await.unwrap();
        assert_eq!(vis(&plain, stranger, "attachment", None).await, FileVisibility::Visible, "a friend sees the avatar");
        sqlx::query("DELETE FROM friends WHERE user1_id = $1 AND user2_id = $2").bind(uploader).bind(stranger).execute(&pool).await.unwrap();
        assert_eq!(vis(&plain, stranger, "attachment", None).await, FileVisibility::NotVisible, "unfriending ends it");

        let shared = format!("srv_shared_{tag}");
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'shared', $2)").bind(&shared).bind(uploader as i32).execute(&pool).await.unwrap();
        for u in [uploader, stranger] {
            sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)").bind(&shared).bind(u as i32).execute(&pool).await.unwrap();
        }
        assert_eq!(vis(&plain, stranger, "attachment", None).await, FileVisibility::Visible, "a co-member sees the avatar");
        sqlx::query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2").bind(&shared).bind(stranger as i32).execute(&pool).await.unwrap();
        assert_eq!(vis(&plain, stranger, "attachment", None).await, FileVisibility::NotVisible, "kicked/banned/left: access ends with the membership");

        // --- a server icon: members, or anyone once the server is public ---
        let icon = mk_file("attachment", None).await;
        let iconed = format!("srv_icon_{tag}");
        sqlx::query("INSERT INTO servers (id, name, owner_id, icon_file_id) VALUES ($1, 'iconed', $2, $3)").bind(&iconed).bind(uploader as i32).bind(&icon).execute(&pool).await.unwrap();
        assert_eq!(vis(&icon, other, "attachment", None).await, FileVisibility::NotVisible, "a private server's icon is not for outsiders");
        sqlx::query("UPDATE servers SET is_public = true WHERE id = $1").bind(&iconed).execute(&pool).await.unwrap();
        assert_eq!(vis(&icon, other, "attachment", None).await, FileVisibility::Visible, "/discover shows public icons to everyone");
        sqlx::query("UPDATE servers SET is_public = false WHERE id = $1").bind(&iconed).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)").bind(&iconed).bind(other as i32).execute(&pool).await.unwrap();
        assert_eq!(vis(&icon, other, "attachment", None).await, FileVisibility::Visible, "a member sees the icon");

        // --- a clip part: wherever the clip was posted, for those who can VIEW it ---
        let clip_id = uuid::Uuid::new_v4().to_string();
        let part = mk_file("clip", Some(clip_id.clone())).await;
        assert_eq!(vis(&part, other, "clip", Some(&clip_id)).await, FileVisibility::NotVisible, "an unposted proposal's parts are the proposer's alone");
        let clip_srv = format!("srv_clip_{tag}");
        // `other` OWNS this server, so the resolver grants VIEW without any role rows.
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'clips', $2)").bind(&clip_srv).bind(other as i32).execute(&pool).await.unwrap();
        let (chan,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name) VALUES ($1, 'general') RETURNING id").bind(&clip_srv).fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO messages (id, channel_id, user_id, content, clip_consent) VALUES ($1, $2, $3, 'clip', $4)")
            .bind(uuid::Uuid::new_v4().to_string()).bind(chan).bind(uploader as i32)
            .bind(sqlx::types::Json(serde_json::json!({ "proposal_id": clip_id })))
            .execute(&pool).await.unwrap();
        assert_eq!(vis(&part, other, "clip", Some(&clip_id)).await, FileVisibility::Visible, "a viewer of the channel the clip was posted in");
        assert_eq!(vis(&part, stranger, "clip", Some(&clip_id)).await, FileVisibility::NotVisible, "not a viewer: not admitted");

        // --- history: an upload older than migration 054 keeps working ---
        let legacy = mk_file("attachment", None).await;
        let era: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT installed_on FROM _sqlx_migrations WHERE version = 54").fetch_one(&pool).await.expect("054 applied");
        let pool2 = pool.clone();
        let before = era - chrono::Duration::days(1);
        assert_eq!(uncapped_file_visible(&pool2, &legacy, uploader, "attachment", None, Some(before), stranger).await, FileVisibility::Visible, "a pre-capability upload is fetchable by any account (no way to scope it)");
        assert_eq!(uncapped_file_visible(&pool2, &legacy, uploader, "attachment", None, Some(era + chrono::Duration::seconds(1)), stranger).await, FileVisibility::NotVisible, "positive control: one second after the era starts, it is not");

        // cleanup, dependents first
        let _ = sqlx::query("DELETE FROM messages WHERE channel_id = $1").bind(chan).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM channels WHERE id = $1").bind(chan).execute(&pool).await;
        for s in [&shared, &iconed, &clip_srv] {
            let _ = sqlx::query("DELETE FROM server_members WHERE server_id = $1").bind(s).execute(&pool).await;
            let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(s).execute(&pool).await;
        }
        let _ = sqlx::query("UPDATE users SET avatar_file_id = NULL WHERE id = $1").bind(uploader as i32).execute(&pool).await;
        for u in [uploader, stranger, other] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(u as i32).execute(&pool).await;
        }
    }
}

#[cfg(test)]
mod transient_fault_tests {
    //! GET /files/:id and DELETE /files/:id answer a database or file-system
    //! fault with 503 + `Retry-After: 2`, never with the 404 that says "no such
    //! file". Field report (0.9.866): a busy database left pictures, server
    //! icons and emoji blank until the app restarted, because a client that is
    //! told 404 stops asking. The 404s that must stay 404 are pinned beside
    //! them: no row, a malformed id, visibility genuinely denied, the blob gone.
    //!
    //! A fault on ONE lookup of a request, after the ones before it answered,
    //! comes from `faulty_pool`: its connections resolve the named tables to
    //! views that raise (as a cancelled statement does under load) and every
    //! other name to the real table. Only that pool sees the fault.
    use super::{delete_file, get_file};
    use crate::auth::Claims;
    use crate::state::AppState;
    use axum::extract::{ConnectInfo, Path, State};
    use axum::http::{header, HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::Extension;
    use chrono::{DateTime, Utc};
    use std::sync::Arc;
    use std::time::Duration;

    fn claims(sub: i64) -> Claims {
        Claims {
            sub,
            username: format!("u{sub}"),
            exp: Utc::now().timestamp() + 3600,
            tv: 0,
            sst: 0,
            sid: String::new(),
            ls: false,
        }
    }

    fn app(pool: &sqlx::PgPool) -> Arc<AppState> {
        AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake))
    }

    async fn fetch(pool: &sqlx::PgPool, id: &str, caller: i64) -> Response {
        get_file(
            State(app(pool)),
            Path(id.to_string()),
            Extension(claims(caller)),
            HeaderMap::new(),
            ConnectInfo("127.0.0.1:40000".parse().expect("addr")),
        )
        .await
        .into_response()
    }

    async fn delete(pool: &sqlx::PgPool, id: &str, caller: i64) -> Response {
        delete_file(State(app(pool)), Path(id.to_string()), Extension(claims(caller))).await.into_response()
    }

    #[track_caller]
    fn assert_retry(resp: &Response, why: &str) {
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE, "{why}");
        assert_eq!(
            resp.headers().get(header::RETRY_AFTER).and_then(|v| v.to_str().ok()),
            Some("2"),
            "{why}: Retry-After"
        );
    }

    #[track_caller]
    fn assert_not_found(resp: &Response, why: &str) {
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{why}");
        assert!(resp.headers().get(header::RETRY_AFTER).is_none(), "{why}: a 404 is final, no Retry-After");
    }

    /// See the module comment. `tables` are names in `public`.
    async fn faulty_pool(admin: &sqlx::PgPool, url: &str, tables: &[&str]) -> (sqlx::PgPool, String) {
        let schema = format!("f503_{}", uuid::Uuid::new_v4().simple());
        crate::migrator::test_ddl(admin, &format!("CREATE SCHEMA {schema}")).await;
        for t in tables {
            crate::migrator::test_ddl(
                admin,
                &format!(
                    "CREATE FUNCTION {schema}.fault_{t}() RETURNS SETOF public.{t} LANGUAGE plpgsql AS \
                     $$ BEGIN RAISE EXCEPTION 'injected fault on {t}' USING ERRCODE = 'query_canceled'; END $$"
                ),
            )
            .await;
            crate::migrator::test_ddl(admin, &format!("CREATE VIEW {schema}.{t} AS SELECT * FROM {schema}.fault_{t}()")).await;
        }
        let opts = url
            .parse::<sqlx::postgres::PgConnectOptions>()
            .expect("TEST_DATABASE_URL parses")
            .options([("search_path", format!("{schema},public"))]);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect_with(opts)
            .await
            .expect("connect the faulty pool");
        (pool, schema)
    }

    /// Like `faulty_pool`, but `table` READS normally (a plain view over the
    /// real one) and only a DELETE through it fails.
    async fn faulty_delete_pool(admin: &sqlx::PgPool, url: &str, table: &str) -> (sqlx::PgPool, String) {
        let (pool, schema) = faulty_pool(admin, url, &[]).await;
        crate::migrator::test_ddl(admin, &format!("CREATE VIEW {schema}.{table} AS SELECT * FROM public.{table}")).await;
        crate::migrator::test_ddl(
            admin,
            &format!(
                "CREATE FUNCTION {schema}.refuse_delete() RETURNS trigger LANGUAGE plpgsql AS \
                 $$ BEGIN RAISE EXCEPTION 'injected fault on DELETE' USING ERRCODE = 'query_canceled'; END $$"
            ),
        )
        .await;
        crate::migrator::test_ddl(
            admin,
            &format!("CREATE TRIGGER refuse_delete INSTEAD OF DELETE ON {schema}.{table} FOR EACH ROW EXECUTE FUNCTION {schema}.refuse_delete()"),
        )
        .await;
        (pool, schema)
    }

    async fn drop_faults(admin: &sqlx::PgPool, faulty: sqlx::PgPool, schema: &str) {
        faulty.close().await;
        crate::migrator::test_ddl(admin, &format!("DROP SCHEMA IF EXISTS {schema} CASCADE")).await;
    }

    async fn user(pool: &sqlx::PgPool, role: &str) -> i64 {
        let name = format!("f503_{role}_{}", uuid::Uuid::new_v4().simple());
        let (id,): (i32,) = sqlx::query_as(
            "INSERT INTO users (username, email, salt, verifier, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id",
        )
        .bind(&name)
        .bind(format!("{name}@test.invalid"))
        .bind(b"s".as_ref())
        .bind(b"v".as_ref())
        .fetch_one(pool)
        .await
        .expect("insert user");
        id as i64
    }

    /// An upload row with NO capability (so the visibility gate decides), and
    /// its blob on disk under `uploads/` so an admitted fetch is a 200: a 404
    /// in these tests is then always a refusal, never a missing blob.
    async fn upload(pool: &sqlx::PgPool, uploader: i64, kind: &str, clip: Option<&str>, created_at: Option<DateTime<Utc>>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let stored = format!("f503-{id}.bin");
        std::fs::create_dir_all("uploads").expect("uploads dir");
        std::fs::write(format!("uploads/{stored}"), b"f503").expect("blob");
        sqlx::query(
            "INSERT INTO uploaded_files (id, uploader_id, original_name, stored_name, mime_type, size_bytes, kind, clip_id, created_at) \
             VALUES ($1::uuid, $2, 'f.png', $3, 'image/png', 4, $4, $5::uuid, COALESCE($6, NOW()))",
        )
        .bind(&id)
        .bind(uploader as i32)
        .bind(&stored)
        .bind(kind)
        .bind(clip)
        .bind(created_at)
        .execute(pool)
        .await
        .expect("insert file");
        id
    }

    async fn cleanup(pool: &sqlx::PgPool, users: &[i64]) {
        let ids: Vec<i32> = users.iter().map(|u| *u as i32).collect();
        let stored: Vec<(String,)> = sqlx::query_as("DELETE FROM uploaded_files WHERE uploader_id = ANY($1) RETURNING stored_name")
            .bind(&ids)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
        for (s,) in stored {
            let _ = std::fs::remove_file(format!("uploads/{s}"));
        }
        let _ = sqlx::query("DELETE FROM friends WHERE user1_id = ANY($1) OR user2_id = ANY($1)").bind(&ids).execute(pool).await;
        let _ = sqlx::query("UPDATE users SET avatar_file_id = NULL WHERE id = ANY($1)").bind(&ids).execute(pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(&ids).execute(pool).await;
    }

    async fn era_start(pool: &sqlx::PgPool) -> DateTime<Utc> {
        sqlx::query_scalar("SELECT installed_on FROM _sqlx_migrations WHERE version = 54")
            .fetch_one(pool)
            .await
            .expect("054 applied")
    }

    /// The field report with no database at all: a pool that never answers.
    /// Needs no TEST_DATABASE_URL, so it runs everywhere.
    #[tokio::test]
    async fn a_database_that_does_not_answer_is_a_503_not_a_404() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(300))
            .connect_lazy("postgres://127.0.0.1:1/does_not_connect")
            .expect("lazy pool");
        let id = uuid::Uuid::new_v4().to_string();
        assert_retry(&fetch(&pool, &id, 1).await, "GET: the metadata lookup did not answer");
        assert_retry(&delete(&pool, &id, 1).await, "DELETE: the ownership lookup did not answer");
    }

    /// The field condition itself: every connection busy, the acquire times
    /// out. The same request is the ordinary 404 once the pool is free again.
    #[tokio::test]
    async fn a_busy_pool_is_a_503_and_the_same_request_a_404_once_it_answers() {
        let Some((_admin, url)) = crate::migrator::test_database(1).await else { return };
        let busy = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_millis(300))
            .connect(&url)
            .await
            .expect("connect the one-connection pool");
        let id = uuid::Uuid::new_v4().to_string();
        let held = busy.acquire().await.expect("hold the only connection");
        assert_retry(&fetch(&busy, &id, 1).await, "GET with every connection busy");
        assert_retry(&delete(&busy, &id, 1).await, "DELETE with every connection busy");
        drop(held);
        assert_not_found(&fetch(&busy, &id, 1).await, "control: an unknown id on a pool that answers");
        assert_not_found(&delete(&busy, &id, 1).await, "control: DELETE of an unknown id on a pool that answers");
        busy.close().await;
    }

    /// CONTROL: a malformed id is refused by the database (a data exception),
    /// and that is still the 404 of an unknown file, not a 503 to retry.
    #[tokio::test]
    async fn a_malformed_id_is_still_a_404() {
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        for id in ["not-a-uuid", "1234", "00000000-0000-0000-0000-00000000000g", "' OR 1=1 --", "nul\0byte"] {
            assert_not_found(&fetch(&pool, id, 1).await, &format!("GET {id:?}"));
            assert_not_found(&delete(&pool, id, 1).await, &format!("DELETE {id:?}"));
        }
        let unknown = uuid::Uuid::new_v4().to_string();
        assert_not_found(&fetch(&pool, &unknown, 1).await, "an unknown well-formed id");
        // What the database really says for the two shapes `id_was_malformed` names.
        for (id, code) in [("not-a-uuid", "22P02"), ("nul\0byte", "22021")] {
            let e = sqlx::query("SELECT 1 FROM uploaded_files WHERE id = $1::uuid").bind(id).execute(&pool).await.unwrap_err();
            assert_eq!(e.as_database_error().and_then(|d| d.code()).as_deref(), Some(code), "{id:?}");
            assert!(super::id_was_malformed(&e));
        }
    }

    /// CONTROL: visibility genuinely denied is the 404 it always was, on a
    /// database that answers, while the uploader is served the same row.
    #[tokio::test]
    async fn a_stranger_is_still_refused_with_a_404() {
        std::env::remove_var("FILES_ENFORCE_CAP");
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        let uploader = user(&pool, "up").await;
        let stranger = user(&pool, "str").await;
        let file = upload(&pool, uploader, "attachment", None, None).await;
        let as_uploader = fetch(&pool, &file, uploader).await.status();
        let as_stranger = fetch(&pool, &file, stranger).await;
        cleanup(&pool, &[uploader, stranger]).await;
        assert_eq!(as_uploader, StatusCode::OK, "positive control: the row and blob are served to the uploader");
        assert_not_found(&as_stranger, "an unreferenced upload, a stranger");
    }

    /// The asset lookup (whose avatar, which server's icon) fails: a friend
    /// asking for an avatar gets a 503 to retry, not the 404 of a stranger.
    #[tokio::test]
    async fn a_failed_asset_lookup_is_a_503() {
        std::env::remove_var("FILES_ENFORCE_CAP");
        let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
        let owner = user(&pool, "own").await;
        let friend = user(&pool, "fr").await;
        let avatar = upload(&pool, owner, "attachment", None, None).await;
        sqlx::query("UPDATE users SET avatar_file_id = $1 WHERE id = $2").bind(&avatar).bind(owner as i32).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO friends (user1_id, user2_id) VALUES ($1, $2)").bind(owner).bind(friend).execute(&pool).await.unwrap();
        let healthy = fetch(&pool, &avatar, friend).await.status();
        let (faulty, schema) = faulty_pool(&pool, &url, &["users"]).await;
        let faulted = fetch(&faulty, &avatar, friend).await;
        let uploader_through_fault = fetch(&faulty, &avatar, owner).await.status();
        drop_faults(&pool, faulty, &schema).await;
        cleanup(&pool, &[owner, friend]).await;
        assert_eq!(healthy, StatusCode::OK, "positive control: a friend sees the avatar");
        assert_eq!(uploader_through_fault, StatusCode::OK, "control: the same pool answers the metadata lookup");
        assert_retry(&faulted, "the asset lookup failed");
    }

    /// The identity check (friends, a shared server, a conversation) fails.
    #[tokio::test]
    async fn a_failed_identity_lookup_is_a_503() {
        std::env::remove_var("FILES_ENFORCE_CAP");
        let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
        let owner = user(&pool, "own").await;
        let friend = user(&pool, "fr").await;
        let avatar = upload(&pool, owner, "attachment", None, None).await;
        sqlx::query("UPDATE users SET avatar_file_id = $1 WHERE id = $2").bind(&avatar).bind(owner as i32).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO friends (user1_id, user2_id) VALUES ($1, $2)").bind(owner).bind(friend).execute(&pool).await.unwrap();
        let healthy = fetch(&pool, &avatar, friend).await.status();
        let (faulty, schema) = faulty_pool(&pool, &url, &["friends"]).await;
        let faulted = fetch(&faulty, &avatar, friend).await;
        let uploader_through_fault = fetch(&faulty, &avatar, owner).await.status();
        let identity = crate::dm_handlers::try_users_share_identity_context(&faulty, friend, owner).await;
        drop_faults(&pool, faulty, &schema).await;
        cleanup(&pool, &[owner, friend]).await;
        assert_eq!(healthy, StatusCode::OK, "positive control: a friend sees the avatar");
        assert_eq!(uploader_through_fault, StatusCode::OK, "control: the same pool answers the metadata lookup");
        assert!(identity.is_err(), "the fault reaches the identity lookup: {identity:?}");
        assert_retry(&faulted, "the identity-context lookup failed");
    }

    /// CONTROL for the one above: a grant from a check that DID answer stands
    /// beside one that failed. A pre-capability avatar is fetchable by any
    /// account, so the failed identity lookup changes nothing.
    #[tokio::test]
    async fn a_grant_that_answered_stands_beside_a_lookup_that_failed() {
        std::env::remove_var("FILES_ENFORCE_CAP");
        let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
        let owner = user(&pool, "own").await;
        let stranger = user(&pool, "str").await;
        let before = era_start(&pool).await - chrono::Duration::days(1);
        let avatar = upload(&pool, owner, "attachment", None, Some(before)).await;
        sqlx::query("UPDATE users SET avatar_file_id = $1 WHERE id = $2").bind(&avatar).bind(owner as i32).execute(&pool).await.unwrap();
        let (faulty, schema) = faulty_pool(&pool, &url, &["friends"]).await;
        let faulted = fetch(&faulty, &avatar, stranger).await.status();
        let identity = crate::dm_handlers::try_users_share_identity_context(&faulty, stranger, owner).await;
        drop_faults(&pool, faulty, &schema).await;
        cleanup(&pool, &[owner, stranger]).await;
        assert!(identity.is_err(), "the identity lookup this request made did fail: {identity:?}");
        assert_eq!(faulted, StatusCode::OK, "a legacy upload is admitted by the era check, whatever the identity lookup did");
    }

    /// The migration-era lookup fails, for an upload only it can admit.
    #[tokio::test]
    async fn a_failed_era_lookup_is_a_503() {
        std::env::remove_var("FILES_ENFORCE_CAP");
        let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
        let uploader = user(&pool, "up").await;
        let stranger = user(&pool, "str").await;
        let before = era_start(&pool).await - chrono::Duration::days(1);
        let legacy = upload(&pool, uploader, "attachment", None, Some(before)).await;
        let healthy = fetch(&pool, &legacy, stranger).await.status();
        let (faulty, schema) = faulty_pool(&pool, &url, &["_sqlx_migrations"]).await;
        let faulted = fetch(&faulty, &legacy, stranger).await;
        let uploader_through_fault = fetch(&faulty, &legacy, uploader).await.status();
        let era = super::cap_era_start(&faulty).await;
        drop_faults(&pool, faulty, &schema).await;
        cleanup(&pool, &[uploader, stranger]).await;
        assert_eq!(uploader_through_fault, StatusCode::OK, "control: the same pool answers the metadata lookup");
        assert!(era.is_err(), "the fault reaches the era lookup: {era:?}");
        assert_eq!(healthy, StatusCode::OK, "positive control: a pre-capability upload is fetchable by any account");
        assert_retry(&faulted, "the migration-era lookup failed");
    }

    /// A clip part: the lookup of where it was posted fails, and so does the
    /// viewer's permission check in that channel.
    #[tokio::test]
    async fn a_failed_clip_or_channel_permission_lookup_is_a_503() {
        std::env::remove_var("FILES_ENFORCE_CAP");
        let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
        let uploader = user(&pool, "up").await;
        let viewer = user(&pool, "view").await;
        let clip_id = uuid::Uuid::new_v4().to_string();
        let part = upload(&pool, uploader, "clip", Some(&clip_id), None).await;
        let srv = format!("srv_f503_{}", uuid::Uuid::new_v4().simple());
        // `viewer` OWNS the server, so the resolver grants VIEW without role rows.
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'f503', $2)").bind(&srv).bind(viewer as i32).execute(&pool).await.unwrap();
        let (chan,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name) VALUES ($1, 'general') RETURNING id").bind(&srv).fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO messages (id, channel_id, user_id, content, clip_consent) VALUES ($1, $2, $3, 'clip', $4)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(chan)
            .bind(uploader as i32)
            .bind(sqlx::types::Json(serde_json::json!({ "proposal_id": clip_id })))
            .execute(&pool)
            .await
            .unwrap();
        let healthy = fetch(&pool, &part, viewer).await.status();
        let (faulty, schema) = faulty_pool(&pool, &url, &["messages"]).await;
        let no_clip_row = fetch(&faulty, &part, viewer).await;
        let uploader_through_messages = fetch(&faulty, &part, uploader).await.status();
        drop_faults(&pool, faulty, &schema).await;
        let (faulty, schema) = faulty_pool(&pool, &url, &["channels"]).await;
        let no_perms = fetch(&faulty, &part, viewer).await;
        let uploader_through_channels = fetch(&faulty, &part, uploader).await.status();
        let perms_failed = matches!(
            crate::permissions::try_user_channel_permissions(&faulty, chan as i64, viewer).await,
            Err(crate::permissions::LookupFailed)
        );
        drop_faults(&pool, faulty, &schema).await;
        let _ = sqlx::query("DELETE FROM messages WHERE channel_id = $1").bind(chan).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM channels WHERE id = $1").bind(chan).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&srv).execute(&pool).await;
        cleanup(&pool, &[uploader, viewer]).await;
        assert_eq!(uploader_through_messages, StatusCode::OK, "control: the messages-faulted pool answers the metadata lookup");
        assert_eq!(uploader_through_channels, StatusCode::OK, "control: the channels-faulted pool answers the metadata lookup");
        assert!(perms_failed, "the fault reaches the channel permission lookup");
        assert_eq!(healthy, StatusCode::OK, "positive control: a viewer of the channel it was posted in");
        assert_retry(&no_clip_row, "the clip's message lookup failed");
        assert_retry(&no_perms, "the channel permission lookup failed");
    }

    /// Which database errors are the caller's malformed id (a final 404) and
    /// which are the server's (a 503). A stand-in error carries each code, so
    /// this needs no database; `a_malformed_id_is_still_a_404` checks that the
    /// database really answers 22P02 and 22021.
    #[test]
    fn only_a_bad_uuid_or_a_nul_byte_is_a_malformed_id() {
        #[derive(Debug)]
        struct Coded(&'static str);
        impl std::fmt::Display for Coded {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "SQLSTATE {}", self.0)
            }
        }
        impl std::error::Error for Coded {}
        impl sqlx::error::DatabaseError for Coded {
            fn message(&self) -> &str {
                self.0
            }
            fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
                Some(self.0.into())
            }
            fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
                self
            }
            fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
                self
            }
            fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
                self
            }
            fn kind(&self) -> sqlx::error::ErrorKind {
                sqlx::error::ErrorKind::Other
            }
        }
        let db = |code: &'static str| sqlx::Error::Database(Box::new(Coded(code)));
        assert!(super::id_was_malformed(&db("22P02")), "not a uuid");
        assert!(super::id_was_malformed(&db("22021")), "a NUL byte");
        // 22P03 is class 22 as well, and it is the server's bug: a cached
        // statement bound with a second type. It must not read as "no such file".
        for code in ["22P03", "22003", "57014", "53300", "08006", "40001"] {
            assert!(!super::id_was_malformed(&db(code)), "{code} is not the caller's id");
        }
        assert!(!super::id_was_malformed(&sqlx::Error::PoolTimedOut));
        assert!(!super::id_was_malformed(&sqlx::Error::PoolClosed));
    }

    /// The blob will not open. NotFound is the file being gone (404, final);
    /// anything else is the server's trouble (503, retry). Pure, so it pins
    /// every platform; the Windows test below drives it through the handler.
    #[test]
    fn a_blob_that_will_not_open_is_a_503_unless_it_is_gone() {
        use std::io::{Error, ErrorKind};
        assert_not_found(&super::open_failure_response(&Error::from(ErrorKind::NotFound)), "the blob is gone");
        for e in [
            Error::from(ErrorKind::PermissionDenied),
            Error::other("Too many open files (os error 24)"),
            Error::from(ErrorKind::Interrupted),
            Error::from(ErrorKind::OutOfMemory),
        ] {
            assert_retry(&super::open_failure_response(&e), &format!("{e:?}"));
        }
    }

    /// The same through the handler: a row whose blob is a DIRECTORY (Windows
    /// refuses to open one as a file, with PermissionDenied) is a 503, and the
    /// row whose blob is missing beside it the 404. Linux opens a directory
    /// read-only, so the pure test above stands for this there.
    #[cfg(windows)]
    #[tokio::test]
    async fn through_the_handler_an_unopenable_blob_is_a_503_and_a_missing_one_a_404() {
        let Some(pool) = crate::migrator::test_pool(2).await else { return };
        let uploader = user(&pool, "up").await;
        let as_dir = upload(&pool, uploader, "attachment", None, None).await;
        let gone = upload(&pool, uploader, "attachment", None, None).await;
        let stored: Vec<(String, String)> = sqlx::query_as("SELECT id::text, stored_name FROM uploaded_files WHERE id = ANY($1::uuid[])")
            .bind(vec![as_dir.clone(), gone.clone()])
            .fetch_all(&pool)
            .await
            .unwrap();
        for (id, s) in &stored {
            std::fs::remove_file(format!("uploads/{s}")).unwrap();
            if *id == as_dir {
                std::fs::create_dir(format!("uploads/{s}")).unwrap();
            }
        }
        let unopenable = fetch(&pool, &as_dir, uploader).await;
        let missing = fetch(&pool, &gone, uploader).await;
        for (id, s) in &stored {
            if *id == as_dir {
                let _ = std::fs::remove_dir(format!("uploads/{s}"));
            }
        }
        cleanup(&pool, &[uploader]).await;
        assert_retry(&unopenable, "a blob that would not open");
        assert_not_found(&missing, "a blob that is gone");
    }

    /// DELETE's ownership lookup fails: a 503, so the caller does not take a
    /// file that is still there (and still counts against its quota) for gone.
    #[tokio::test]
    async fn delete_answers_a_failed_ownership_lookup_with_a_503() {
        let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
        let uploader = user(&pool, "up").await;
        let file = upload(&pool, uploader, "attachment", None, None).await;
        let (faulty, schema) = faulty_pool(&pool, &url, &["uploaded_files"]).await;
        let faulted = delete(&faulty, &file, uploader).await;
        drop_faults(&pool, faulty, &schema).await;
        let still_there: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM uploaded_files WHERE id = $1::uuid)")
            .bind(file.clone())
            .fetch_one(&pool)
            .await
            .unwrap();
        cleanup(&pool, &[uploader]).await;
        assert_retry(&faulted, "the ownership lookup failed");
        assert!(still_there);
    }

    /// The delete itself fails after ownership and the in-use check answered:
    /// a 503 and the file still there, not the 404 of a file that is gone.
    #[tokio::test]
    async fn delete_answers_a_failed_delete_with_a_503() {
        let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
        let uploader = user(&pool, "up").await;
        let file = upload(&pool, uploader, "attachment", None, None).await;
        let (faulty, schema) = faulty_delete_pool(&pool, &url, "uploaded_files").await;
        let faulted = delete(&faulty, &file, uploader).await;
        let reads_through_fault = fetch(&faulty, &file, uploader).await.status();
        drop_faults(&pool, faulty, &schema).await;
        assert_eq!(reads_through_fault, StatusCode::OK, "control: only the DELETE fails, the lookups before it answer");
        let still_there: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM uploaded_files WHERE id = $1::uuid)")
            .bind(file.clone())
            .fetch_one(&pool)
            .await
            .unwrap();
        cleanup(&pool, &[uploader]).await;
        assert_retry(&faulted, "the DELETE failed");
        assert!(still_there);
    }

    /// DELETE's in-use check fails. It used to read as "not in use" and go on
    /// to delete: a database hiccup there removed a live avatar. Now a 503,
    /// and the file is still there.
    #[tokio::test]
    async fn delete_keeps_a_file_whose_in_use_check_failed() {
        let Some((pool, url)) = crate::migrator::test_database(2).await else { return };
        let uploader = user(&pool, "up").await;
        let avatar = upload(&pool, uploader, "attachment", None, None).await;
        let unused = upload(&pool, uploader, "attachment", None, None).await;
        sqlx::query("UPDATE users SET avatar_file_id = $1 WHERE id = $2").bind(&avatar).bind(uploader as i32).execute(&pool).await.unwrap();
        let in_use = delete(&pool, &avatar, uploader).await.status();
        let (faulty, schema) = faulty_pool(&pool, &url, &["users"]).await;
        let faulted = delete(&faulty, &avatar, uploader).await;
        // The ownership lookup reads uploaded_files, which this pool still
        // answers: so the 503 above is the in-use check's.
        let owner_reads_through_fault = fetch(&faulty, &avatar, uploader).await.status();
        let in_use_check = super::file_is_referenced(&faulty, &avatar).await;
        drop_faults(&pool, faulty, &schema).await;
        let exists = |id: String| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM uploaded_files WHERE id = $1::uuid)")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };
        let avatar_kept = exists(avatar.clone()).await;
        let healthy = delete(&pool, &unused, uploader).await.status();
        let unused_gone = !exists(unused.clone()).await;
        cleanup(&pool, &[uploader]).await;
        assert_eq!(in_use, StatusCode::CONFLICT, "control: an avatar in use is refused on a database that answers");
        assert_eq!(owner_reads_through_fault, StatusCode::OK, "control: the users-faulted pool answers lookups of uploaded_files");
        assert!(in_use_check.is_err(), "the fault reaches the in-use check: {in_use_check:?}");
        assert_retry(&faulted, "the in-use check failed");
        assert!(avatar_kept, "a failed in-use check must not delete the file");
        assert_eq!(healthy, StatusCode::NO_CONTENT, "control: an unused file is deleted");
        assert!(unused_gone);
    }
}
