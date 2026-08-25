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
    let days: i64 = std::env::var("CLIP_RETENTION_DAYS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
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
/// `GET /clips/usage` — how much of this account's clip storage is used.
///
/// Wire shape `{used_bytes, quota_bytes}` — snake_case, PINNED by the client
/// (frontend/src/api/clips/clipUpload.ts `getClipUsage`, which renders
/// nothing on any non-2xx so it shipped a release before this route). The
/// SUM matches the quota gate in `upload_file` byte-for-byte: same
/// `kind = 'clip'` filter over the same table, so the readout can never
/// disagree with what the gate will actually refuse.
///
/// ROUTE ORDER IS LOAD-BEARING: registered BEFORE `/clips/:clip_id` in
/// main.rs (same rule as `/clips/pending`) or axum matches "usage" as a
/// clip id and this handler is shadowed forever.
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
    }))
    .into_response()
}

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
    mut multipart: Multipart,
) -> impl IntoResponse {
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
                return axum::Json(UploadedFileResponse { url: format!("/files/{}", id), id, original_name, mime_type, size_bytes }).into_response();
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
        "INSERT INTO uploaded_files (id, uploader_id, original_name, stored_name, mime_type, size_bytes, kind, clip_id, clip_part_index) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9)",
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
    let file_info: Option<(String, String, String)> = sqlx::query_as(
        // id is uuid; cast the binding (an invalid uuid string errors -> None -> 404).
        "SELECT stored_name, original_name, mime_type FROM uploaded_files WHERE id = $1::uuid",
    )
    .bind(&file_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    let (stored_name, original_name, mime_type) = match file_info {
        Some(info) => info,
        None => return (StatusCode::NOT_FOUND, "File not found").into_response(),
    };

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
