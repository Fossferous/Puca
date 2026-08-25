//! Message Handlers
//!
//! REST API handlers for message operations.

use axum::{
    extract::{Json, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use crate::auth::Claims;
use crate::permissions::Permissions;
use crate::permissions::{get_user_channel_permissions, ChannelPermAccess};
use crate::protocol::{ServerMessage, UserInfo};
use crate::state::AppState;

/// Maximum allowed length of a single message's content, in bytes.
const MAX_MESSAGE_LEN: usize = 8000;

/// Resolve channel access and require VIEW_CHANNEL, converting the result into
/// an early HTTP response on failure. A member who is VIEW-denied gets the same
/// 404 as a missing channel (hide its existence); non-members keep 403. Returns
/// (owning server id, resolved effective permissions) on success so callers can
/// check further bits without a second resolution.
macro_rules! require_channel_view {
    ($state:expr, $channel_id:expr, $user_id:expr) => {
        match get_user_channel_permissions(&$state.pool, $channel_id, $user_id).await {
            ChannelPermAccess::Allowed { server_id, perms } => {
                if !perms.has(Permissions::VIEW_CHANNEL) {
                    return (StatusCode::NOT_FOUND, "Channel not found").into_response();
                }
                (server_id, perms)
            }
            ChannelPermAccess::NotFound => {
                return (StatusCode::NOT_FOUND, "Channel not found").into_response()
            }
            ChannelPermAccess::NotMember => {
                return (StatusCode::FORBIDDEN, "Not a member of this server").into_response()
            }
        }
    };
}

// --- DTOs ---

#[derive(Deserialize)]
pub struct SendMessageRequest {
    pub content: String,
    pub reply_to_id: Option<String>,
    #[serde(default)]
    pub is_task: bool, // If true, this message is a task item
    /// E2EE channel-key epoch used to encrypt `content` (None = plaintext).
    pub key_epoch: Option<i32>,
    /// Present only for a CLIP post (docs/CLIPS.md). The server verifies the
    /// named proposal is APPROVED, was made by this user, for THIS channel,
    /// then stamps `clip_consent` from its OWN record and consumes the
    /// proposal. `#[serde(default)]` — absent in every request an existing
    /// client makes, so the whole branch is dead code for them.
    #[serde(default)]
    pub clip_id: Option<String>,
}

#[derive(Serialize)]
pub struct MessageResponse {
    pub id: String,
    pub channel_id: i64,
    pub user_id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub content: String,
    pub created_at: String,
    pub reply_to_id: Option<String>,
    // Task fields
    #[serde(default)]
    pub is_task: bool,
    #[serde(default)]
    pub is_completed: bool,
    pub parent_message_id: Option<String>, // For sub-tasks
    pub key_epoch: Option<i32>,            // E2EE epoch (None = plaintext)
    /// Server-stamped clip consent record, or absent. `skip_serializing_if` so a
    /// non-clip message serialises BYTE-IDENTICALLY to today's — the inertness
    /// the backend-first deploy of Clips rests on (pinned by a test).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_consent: Option<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct EditMessageRequest {
    pub content: String,
}

#[derive(Deserialize)]
pub struct MessagesQuery {
    #[serde(default = "default_limit")]
    pub limit: i32,
    /// Return only messages created strictly before this timestamp
    /// (`created_at` text of the oldest message currently loaded). Enables
    /// "load older" pagination.
    #[serde(default)]
    pub before: Option<String>,
}

fn default_limit() -> i32 {
    50
}

#[derive(Serialize)]
pub struct EditHistoryResponse {
    pub old_content: String,
    pub edited_at: String,
}

#[derive(Serialize)]
pub struct PinnedMessageResponse {
    pub id: String,
    pub channel_id: i64,
    pub user_id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub content: String,
    pub created_at: String,
    pub pinned_at: String,
}

// --- Handlers ---

/// Send a message to a channel
pub async fn send_message(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<SendMessageRequest>,
) -> impl IntoResponse {
    let (server_id, perms) = require_channel_view!(state, channel_id, claims.sub);
    if !perms.has(Permissions::SEND_MESSAGES) {
        return (StatusCode::FORBIDDEN, "Missing Send Messages permission").into_response();
    }

    let content = payload.content.trim();
    if content.is_empty() {
        return (StatusCode::BAD_REQUEST, "Message content cannot be empty").into_response();
    }
    if payload.content.len() > MAX_MESSAGE_LEN {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Message too long").into_response();
    }
    // Postgres TEXT can't store a NUL byte (error 22021) — reject rather than 500.
    if payload.content.contains('\0') {
        return (
            StatusCode::BAD_REQUEST,
            "Message contains invalid characters",
        )
            .into_response();
    }

    // Timeout enforcement: a timed-out member cannot send until it expires.
    // (Without this check the timeout feature was advisory only.)
    let timed_out: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM member_timeouts WHERE server_id = $1 AND user_id = $2 AND expires_at > NOW() LIMIT 1",
    )
    .bind(&server_id)
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if timed_out.is_some() {
        return (StatusCode::FORBIDDEN, "You are timed out in this server").into_response();
    }

    // Slowmode: enforce a minimum gap between a user's messages in this channel.
    // Moderators (Manage Messages) are exempt, the common convention for slowmode.
    let slowmode: Option<(i32,)> =
        sqlx::query_as("SELECT slowmode_seconds FROM channels WHERE id = $1")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    if let Some((secs,)) = slowmode {
        if secs > 0 && !perms.has(Permissions::MANAGE_MESSAGES) {
            let recent: Option<(i64,)> = sqlx::query_as(
                "SELECT EXTRACT(EPOCH FROM (NOW() - created_at))::bigint \
                 FROM messages WHERE channel_id = $1 AND user_id = $2 \
                 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(channel_id)
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

            if let Some((elapsed,)) = recent {
                if elapsed < secs as i64 {
                    let wait = secs as i64 - elapsed;
                    return (
                        StatusCode::TOO_MANY_REQUESTS,
                        format!("Slowmode is on. Wait {}s before sending again.", wait),
                    )
                        .into_response();
                }
            }
        }
    }

    // Clip post: every check runs BEFORE the proposal is consumed, so a refusal
    // does not burn an approval; then `remove()` hands the entry to exactly ONE
    // caller — two concurrent sends cannot both post (docs/CLIPS.md).
    let mut clip_consent: Option<serde_json::Value> = None;
    let mut consumed_clip_id: Option<String> = None;
    if let Some(clip_id) = payload.clip_id.as_deref() {
        {
            let Some(p) = crate::clip_handlers::live_proposal(&state, clip_id) else {
                return (StatusCode::CONFLICT, "That clip approval is no longer valid").into_response();
            };
            if p.proposer != claims.sub {
                return (StatusCode::FORBIDDEN, "That clip is not yours to post").into_response();
            }
            if p.target_channel_id != channel_id {
                return (StatusCode::FORBIDDEN, "That clip was approved for a different channel").into_response();
            }
            if p.approved_at.is_none() {
                return (StatusCode::FORBIDDEN, "Not everyone has approved that clip yet").into_response();
            }
        }
        // Policy re-check: a role or server change between approval and post must take effect.
        if !perms.has(Permissions::CREATE_CLIPS) {
            return (StatusCode::FORBIDDEN, "Missing Create Clips permission").into_response();
        }
        let enabled: Option<bool> = sqlx::query_scalar("SELECT clips_enabled FROM servers WHERE id = $1")
            .bind(&server_id).fetch_optional(&state.pool).await.unwrap_or(None);
        if enabled != Some(true) {
            return (StatusCode::CONFLICT, "Clips are turned off in this server").into_response();
        }
        let Some((_, p)) = state.clip_proposals.remove(clip_id) else {
            return (StatusCode::CONFLICT, "That clip approval is no longer valid").into_response();
        };
        // The parts THIS user uploaded under the proposal — the badge renders
        // only if the message's manifest is a subset of these.
        let part_ids: Vec<String> = sqlx::query_scalar("SELECT id::text FROM uploaded_files WHERE clip_id = $1::uuid AND uploader_id = $2 ORDER BY clip_part_index")
            .bind(&p.clip_id).bind(claims.sub as i32).fetch_all(&state.pool).await.unwrap_or_default();
        clip_consent = Some(serde_json::json!({
            "proposal_id": p.clip_id,
            "approver_count": p.votes.len(),
            "part_file_ids": part_ids,
            "solo": p.solo,
        }));
        consumed_clip_id = Some(p.clip_id.clone());
    }

    let message_id = Uuid::new_v4().to_string();

    let result = sqlx::query(
        "INSERT INTO messages (id, channel_id, user_id, content, reply_to_id, is_task, key_epoch, clip_consent) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"
    )
    .bind(&message_id)
    .bind(channel_id)
    .bind(claims.sub as i32)
    .bind(&payload.content)
    .bind(&payload.reply_to_id)
    .bind(payload.is_task)
    .bind(payload.key_epoch)
    .bind(clip_consent.clone().map(sqlx::types::Json))
    .execute(&state.pool)
    .await;

    if result.is_err() {
        if let Some(cid) = consumed_clip_id.as_deref() {
            // The approvals are spent and the parts are unreferenced ciphertext:
            // delete them server-side (we KNOW the clip_id; the usual "the server
            // cannot tell what is referenced" argument does not apply to clips).
            crate::upload_handlers::delete_clip_parts(&state, cid, Some(claims.sub)).await;
        }
    }

    match result {
        Ok(_) => {
            // Broadcast to everyone viewing the channel so messages created via
            // REST (the app, bots, API clients) appear in real time. The content
            // is relayed exactly as stored (encrypted wire bytes for E2EE
            // channels); receivers decrypt client-side. The sender is NOT
            // excluded: with multi-device sessions a user-level exclusion would
            // starve the sender's other devices of the live message, and the
            // sending client dedups its own optimistic render by message_id.
            let room_id = format!("channel_{}", channel_id);
            state.broadcast_to_room(
                &room_id,
                ServerMessage::ChatMessage {
                    room_id: room_id.clone(),
                    sender: UserInfo::new(claims.sub, claims.username.clone()),
                    content: payload.content.clone(),
                    timestamp: chrono::Utc::now().timestamp(),
                    message_id: Some(message_id.clone()),
                    clip_consent: clip_consent.clone(),
                },
                None,
            );

            // Cross-channel notification: tell every online member WHO CAN VIEW
            // this channel (except the author) that a message landed, so their
            // client can ping / bump unread for a channel they aren't currently
            // viewing. Content-free — the client decides whether to sound based on
            // its own mute settings. send_to_user no-ops for offline members.
            //
            // Scoped to VIEW_CHANNEL holders (get_channel_viewer_ids), NOT all
            // server members: a bare server_members fan-out leaked the existence,
            // timing and authorship of every message in a restricted/hidden channel
            // to members walled out of it via channel permission overwrites. Fail
            // closed — on a resolve error, skip the ping rather than over-notify.
            let viewers = match crate::permissions::get_channel_viewer_ids(
                &state.pool,
                channel_id,
                &server_id,
            )
            .await
            {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!(
                        "MessageNotification: viewer resolve failed for channel {}: {}",
                        channel_id,
                        e
                    );
                    std::collections::HashSet::new()
                }
            };
            let notif = ServerMessage::MessageNotification {
                server_id: server_id.clone(),
                channel_id,
                message_id: message_id.clone(),
                author: UserInfo::new(claims.sub, claims.username.clone()),
            };
            // send_to_user no-ops for offline members. An offline member's
            // phone hears about this through its NATIVE delivery socket — a
            // second authenticated session of the same user, which receives
            // this very fan-out. Data rides no relay — frames park here and
            // built (FCM) and removed on principle — a privacy product must
            // not route who-messaged-whom metadata through Google.
            for member_id in viewers {
                if member_id == claims.sub {
                    continue;
                }
                // Nobody home (no session at all, the phone's delivery socket
                // included): park the content-free frame and ring the doorbell.
                // The wake signal carries a constant; THIS frame — with its
                // author and channel ids — waits server-side for the delivery
                // socket the signal summons. Google never carries it.
                if !state.send_to_user(member_id, notif.clone()) {
                    state.enqueue_undelivered(member_id, notif.clone());
                    crate::wake::sender::wake_user(&state, member_id);
                }
            }

            let mut body = serde_json::json!({
                "id": message_id,
                "channel_id": channel_id,
                "user_id": claims.sub,
                "content": payload.content,
                "reply_to_id": payload.reply_to_id,
                "is_task": payload.is_task,
                "is_completed": false,
                "parent_message_id": null,
                "key_epoch": payload.key_epoch
            });
            if let Some(cc) = clip_consent {
                body["clip_consent"] = cc;
            }
            Json(body).into_response()
        }
        Err(e) => {
            tracing::error!("Failed to save message: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save message").into_response()
        }
    }
}

/// Get message history for a channel
pub async fn get_messages(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Query(query): Query<MessagesQuery>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let (_server_id, perms) = require_channel_view!(state, channel_id, claims.sub);

    // READ_MESSAGE_HISTORY is a real, editable role bit (and part of the
    // @everyone grant), but nothing checked it: a member the role editor had
    // explicitly denied history could still GET the full backlog. The
    // permissions are already resolved a line above, so this mirrors exactly
    // how send_message gates SEND_MESSAGES. 403 (not 404) — VIEW_CHANNEL
    // passed, so the channel's existence is already known to this caller.
    if !perms.has(Permissions::READ_MESSAGE_HISTORY) {
        return (
            StatusCode::FORBIDDEN,
            "You do not have permission to read message history in this channel",
        )
            .into_response();
    }

    let limit = query.limit.clamp(1, 200);
    // `before` is optional; when NULL the predicate passes for all rows. It is
    // a timestamp echoed back from a prior page. Clients send RFC3339
    // ("2026-07-24T12:34:56.789Z", what toISOString and the new created_at
    // serialization both produce) — that is tried FIRST; the two naive
    // space-separated forms stay as fallback for cursors echoed verbatim from
    // pre-RFC3339 pages. NOTE: the validator previously accepted ONLY the
    // naive forms while every client sent toISOString — "load older messages"
    // had been 400ing since the validator shipped. A malformed value used to
    // fail the `$3::timestamp` cast in the DB, and unwrap_or_default turned
    // that into a silently-empty page — validate here and 400 on garbage.
    let before: Option<chrono::NaiveDateTime> = match query
        .before
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(s) => match chrono::DateTime::parse_from_rfc3339(s)
            .map(|dt| dt.naive_utc())
            .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f"))
            .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S"))
        {
            Ok(dt) => Some(dt),
            Err(_) => return (StatusCode::BAD_REQUEST, "Invalid 'before' cursor").into_response(),
        },
        None => None,
    };
    let messages: Vec<(String, i32, i32, String, Option<String>, String, String, Option<String>, bool, bool, Option<String>, Option<i32>, Option<serde_json::Value>)> = sqlx::query_as(
        r#"
        SELECT m.id, m.channel_id, m.user_id, u.username, u.display_name, m.content, (replace(m.created_at::text, ' ', 'T') || 'Z') AS created_at, m.reply_to_id,
               COALESCE(m.is_task, false) as is_task, COALESCE(m.is_completed, false) as is_completed, m.parent_message_id, m.key_epoch, m.clip_consent
        FROM messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.channel_id = $1
          AND ($3::timestamp IS NULL OR m.created_at < $3::timestamp)
        ORDER BY m.created_at DESC
        LIMIT $2
        "#
    )
    .bind(channel_id)
    .bind(limit)
    .bind(before)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let response: Vec<MessageResponse> = messages
        .into_iter()
        .rev()
        .map(
            |(
                id,
                channel_id,
                user_id,
                username,
                display_name,
                content,
                created_at,
                reply_to_id,
                is_task,
                is_completed,
                parent_message_id,
                key_epoch,
                clip_consent,
            )| {
                MessageResponse {
                    id,
                    channel_id: channel_id as i64,
                    user_id: user_id as i64,
                    username,
                    display_name,
                    content,
                    created_at,
                    reply_to_id,
                    is_task,
                    is_completed,
                    parent_message_id,
                    key_epoch,
                    clip_consent,
                }
            },
        )
        .collect();

    Json(response).into_response()
}
pub async fn edit_message(
    State(state): State<Arc<AppState>>,
    Path((channel_id, message_id)): Path<(i64, String)>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<EditMessageRequest>,
) -> impl IntoResponse {
    // Channel-scoped op: hide the channel (404) from VIEW-denied members.
    let (_server_id, _perms) = require_channel_view!(state, channel_id, claims.sub);

    let msg: Option<(i32, String, bool)> =
        sqlx::query_as("SELECT user_id, content, clip_consent IS NOT NULL FROM messages WHERE id = $1 AND channel_id = $2")
            .bind(&message_id)
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    // A clip message cannot be edited: its body IS the clip (key + part ids)
    // and the edit history would keep the old body forever, so a re-pointed
    // message would carry the consent badge for footage nobody approved.
    // Delete and post again instead (docs/CLIPS.md).
    if matches!(msg, Some((_, _, true))) {
        return (StatusCode::BAD_REQUEST, "Clips can't be edited — delete and post again").into_response();
    }
    let msg = msg.map(|(u, c, _)| (u, c));

    // Same content guards as send_message — editing was the one path that could
    // put >8000-byte (or NUL-bearing) content into a message, bypassing the send
    // cap and amplifying get_messages memory.
    if payload.content.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "Message content cannot be empty").into_response();
    }
    if payload.content.len() > MAX_MESSAGE_LEN {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Message too long").into_response();
    }
    if payload.content.contains('\0') {
        return (
            StatusCode::BAD_REQUEST,
            "Message contains invalid characters",
        )
            .into_response();
    }

    match msg {
        Some((user_id, old_content)) if user_id == claims.sub as i32 => {
            // Save old content to edit history
            let _ =
                sqlx::query("INSERT INTO message_edits (message_id, old_content) VALUES ($1, $2)")
                    .bind(&message_id)
                    .bind(&old_content)
                    .execute(&state.pool)
                    .await;

            // Update the message
            let result = sqlx::query("UPDATE messages SET content = $1 WHERE id = $2")
                .bind(&payload.content)
                .bind(&message_id)
                .execute(&state.pool)
                .await;

            match result {
                Ok(_) => StatusCode::OK.into_response(),
                Err(e) => {
                    tracing::error!("Failed to edit message: {:?}", e);
                    (StatusCode::INTERNAL_SERVER_ERROR, "Failed to edit message").into_response()
                }
            }
        }
        Some(_) => (StatusCode::FORBIDDEN, "You can only edit your own messages").into_response(),
        None => (StatusCode::NOT_FOUND, "Message not found").into_response(),
    }
}

/// Delete a message (author or moderator)
pub async fn delete_message(
    State(state): State<Arc<AppState>>,
    Path((channel_id, message_id)): Path<(i64, String)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Channel-scoped op: hide the channel (404) from VIEW-denied members.
    // MANAGE_MESSAGES is the CHANNEL-EFFECTIVE bit so per-channel overwrites
    // (allow or deny) actually apply to moderation, matching the editor UI.
    let (_server_id, perms) = require_channel_view!(state, channel_id, claims.sub);

    let msg: Option<(i32, Option<String>, Option<serde_json::Value>)> = sqlx::query_as(
        "SELECT m.user_id, c.server_id, m.clip_consent FROM messages m
         JOIN channels c ON m.channel_id = c.id
         WHERE m.id = $1 AND m.channel_id = $2",
    )
    .bind(&message_id)
    .bind(channel_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    match msg {
        Some((user_id, server_id, clip_consent)) => {
            let can_delete = user_id as i64 == claims.sub
                || (server_id.is_some() && perms.has(Permissions::MANAGE_MESSAGES));

            if !can_delete {
                return (
                    StatusCode::FORBIDDEN,
                    "You can only delete your own messages or need Manage Messages permission",
                )
                    .into_response();
            }

            let result = sqlx::query("DELETE FROM messages WHERE id = $1")
                .bind(&message_id)
                .execute(&state.pool)
                .await;

            match result {
                Ok(_) => {
                    // message_reactions has no FK to messages (unlike pins and
                    // edit history, which cascade) — sweep its rows or they
                    // orphan forever. Best-effort: the message is already gone.
                    let _ = sqlx::query("DELETE FROM message_reactions WHERE message_id = $1")
                        .bind(&message_id)
                        .execute(&state.pool)
                        .await;
                    // A clip message takes its parts with it — the ONE revocation
                    // the server can actually perform (docs/CLIPS.md). Keyed by
                    // the proposal id in the consent stamp; owner-scoped rows.
                    if let Some(pid) = clip_consent.as_ref().and_then(|c| c.get("proposal_id")).and_then(|v| v.as_str()) {
                        crate::upload_handlers::delete_clip_parts(&state, pid, Some(user_id as i64)).await;
                    }

                    // Every open viewer drops the row live. Same audience as
                    // the ChatMessage that delivered it.
                    state.broadcast_to_room(
                        &format!("channel_{channel_id}"),
                        crate::protocol::ServerMessage::MessageDeleted {
                            channel_id,
                            message_id: message_id.clone(),
                        },
                        None,
                    );

                    // A moderator removing someone ELSE's message is a
                    // moderation action — record it like kick/ban. The author
                    // goes in target_id (INTEGER user id; message ids are TEXT
                    // so the id rides in details). Own-message deletes are not
                    // moderation and stay unlogged.
                    if user_id as i64 != claims.sub {
                        if let Some(sid) = server_id.as_deref() {
                            crate::moderation_handlers::log_audit_action(
                                &state.pool,
                                sid,
                                "message_delete",
                                claims.sub,
                                Some(user_id as i64),
                                Some("user"),
                                Some(&format!("message {message_id} in channel {channel_id}")),
                            )
                            .await;
                        }
                    }

                    StatusCode::OK.into_response()
                }
                Err(e) => {
                    tracing::error!("Failed to delete message: {:?}", e);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Failed to delete message",
                    )
                        .into_response()
                }
            }
        }
        None => (StatusCode::NOT_FOUND, "Message not found").into_response(),
    }
}

/// Get edit history for a message
pub async fn get_message_edits(
    State(state): State<Arc<AppState>>,
    Path((channel_id, message_id)): Path<(i64, String)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Access control: only members who can VIEW the channel may read edit
    // history. Without this any authenticated user could read any message's
    // prior content by id (broken access control / info disclosure).
    let (_server_id, _perms) = require_channel_view!(state, channel_id, claims.sub);

    // edited_at is a timestamp — cast to ::text so it decodes into String (otherwise
    // query_as errors and .unwrap_or_default() silently drops the whole edit history).
    // Join through `messages` so the history must belong to the channel that was
    // just authorized. Filtering on message_id alone meant any id could be
    // substituted — the VIEW check then guarded a channel the row need not be in.
    let edits: Vec<(String, String)> = sqlx::query_as(
        "SELECT e.old_content, (replace(e.edited_at::text, ' ', 'T') || 'Z') AS edited_at FROM message_edits e \
         JOIN messages m ON m.id = e.message_id \
         WHERE e.message_id = $1 AND m.channel_id = $2 ORDER BY e.edited_at DESC"
    )
    .bind(&message_id)
    // messages.channel_id is INT4 — bind i32 so the comparison decodes cleanly.
    .bind(channel_id as i32)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let response: Vec<EditHistoryResponse> = edits
        .into_iter()
        .map(|(old_content, edited_at)| EditHistoryResponse {
            old_content,
            edited_at,
        })
        .collect();

    Json(response).into_response()
}

// --- Message Pinning ---

/// Pin a message
pub async fn pin_message(
    State(state): State<Arc<AppState>>,
    Path((channel_id, message_id)): Path<(i64, String)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Channel-effective bit so per-channel Manage Messages overwrites apply.
    let (_server_id, perms) = require_channel_view!(state, channel_id, claims.sub);
    if !perms.has(Permissions::MANAGE_MESSAGES) {
        return (StatusCode::FORBIDDEN, "Missing Manage Messages permission").into_response();
    }

    // The message MUST live in the channel we just authorized. The path id was
    // trusted blindly, so MANAGE_MESSAGES anywhere (trivially: a server you
    // created) could pin an arbitrary message id — and list_pinned_messages
    // joins `messages` on the stored id and returns the whole row, turning the
    // pin list into a read primitive for other people's private content.
    // messages.channel_id is INTEGER (INT4) — decode as i32. An i64 here fails
    // with ColumnDecode, and swallowing that into None would 404 every pin.
    let in_channel: Option<(i32,)> =
        match sqlx::query_as("SELECT channel_id FROM messages WHERE id = $1")
            .bind(&message_id)
            .fetch_optional(&state.pool)
            .await
        {
            Ok(row) => row,
            Err(e) => {
                tracing::error!("pin_message: channel lookup failed: {:?}", e);
                return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to pin message")
                    .into_response();
            }
        };
    match in_channel {
        Some((cid,)) if i64::from(cid) == channel_id => {}
        _ => return (StatusCode::NOT_FOUND, "Message not found in this channel").into_response(),
    }

    let result = sqlx::query(
        "INSERT INTO pinned_messages (channel_id, message_id, pinned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING"
    )
    .bind(channel_id)
    .bind(&message_id)
    .bind(claims.sub as i32)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to pin message: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to pin message").into_response()
        }
    }
}

/// Unpin a message
pub async fn unpin_message(
    State(state): State<Arc<AppState>>,
    Path((channel_id, message_id)): Path<(i64, String)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Channel-effective bit so per-channel Manage Messages overwrites apply.
    let (_server_id, perms) = require_channel_view!(state, channel_id, claims.sub);
    if !perms.has(Permissions::MANAGE_MESSAGES) {
        return (StatusCode::FORBIDDEN, "Missing Manage Messages permission").into_response();
    }

    let result =
        sqlx::query("DELETE FROM pinned_messages WHERE channel_id = $1 AND message_id = $2")
            .bind(channel_id)
            .bind(&message_id)
            .execute(&state.pool)
            .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to unpin message: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to unpin message").into_response()
        }
    }
}

/// List pinned messages in a channel
pub async fn list_pinned_messages(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let (_server_id, _perms) = require_channel_view!(state, channel_id, claims.sub);

    // NOTE: channel_id/user_id are INT4 (decode as i32) and created_at/pinned_at
    // are timestamps (cast to ::text) — decoding them as i64/String otherwise makes
    // query_as error, which .unwrap_or_default() would silently turn into an empty
    // list (i.e. pins would never display even though pinning succeeded).
    let pins: Vec<(String, i32, i32, String, Option<String>, String, String, String)> = match sqlx::query_as(
        r#"
        SELECT m.id, m.channel_id, m.user_id, u.username, u.display_name, m.content, (replace(m.created_at::text, ' ', 'T') || 'Z') AS created_at, (replace((p.pinned_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS pinned_at
        FROM pinned_messages p
        JOIN messages m ON p.message_id = m.id
        JOIN users u ON m.user_id = u.id
        WHERE p.channel_id = $1
        ORDER BY p.pinned_at DESC
        "#
    )
    .bind(channel_id)
    .fetch_all(&state.pool)
    .await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("Failed to list pinned messages for channel {}: {:?}", channel_id, e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to list pinned messages").into_response();
        }
    };

    let response: Vec<PinnedMessageResponse> = pins
        .into_iter()
        .map(
            |(id, channel_id, user_id, username, display_name, content, created_at, pinned_at)| {
                PinnedMessageResponse {
                    id,
                    channel_id: channel_id as i64,
                    user_id: user_id as i64,
                    username,
                    display_name,
                    content,
                    created_at,
                    pinned_at,
                }
            },
        )
        .collect();

    Json(response).into_response()
}

// --- Task Messages ---

/// Toggle task completion status
pub async fn toggle_task_completion(
    State(state): State<Arc<AppState>>,
    Path((channel_id, message_id)): Path<(i64, String)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let (_server_id, perms) = require_channel_view!(state, channel_id, claims.sub);
    // Same completion rule as the checklist handlers: COMPLETE_TASKS, which
    // MANAGE_TASKS implies. Without this the legacy message-task toggle was a
    // bypass around the per-channel checklist permissions.
    if !perms.has(Permissions::COMPLETE_TASKS) && !perms.has(Permissions::MANAGE_TASKS) {
        return (StatusCode::FORBIDDEN, "Missing Complete Tasks permission").into_response();
    }

    // Toggle the is_completed field
    let result = sqlx::query(
        "UPDATE messages SET is_completed = NOT COALESCE(is_completed, false) WHERE id = $1 AND channel_id = $2 RETURNING is_completed"
    )
    .bind(&message_id)
    .bind(channel_id)
    .fetch_optional(&state.pool)
    .await;

    match result {
        Ok(Some(row)) => {
            let is_completed: bool = sqlx::Row::get(&row, "is_completed");
            Json(serde_json::json!({
                "id": message_id,
                "is_completed": is_completed
            }))
            .into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "Message not found").into_response(),
        Err(e) => {
            tracing::error!("Failed to toggle task: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to toggle task").into_response()
        }
    }
}

#[cfg(test)]
mod clip_consent_shape_tests {
    use super::MessageResponse;

    /// A NON-clip message must serialise byte-identically to before Clips
    /// existed: `clip_consent` is skipped when None. This is what makes the
    /// backend-first deploy of Clips inert for every existing client.
    #[test]
    fn a_message_without_a_clip_has_no_clip_consent_key() {
        let m = MessageResponse {
            id: "m1".into(), channel_id: 1, user_id: 2, username: "u".into(), display_name: None,
            content: "hi".into(), created_at: "2026-08-18T00:00:00Z".into(), reply_to_id: None,
            is_task: false, is_completed: false, parent_message_id: None, key_epoch: Some(3), clip_consent: None,
        };
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert!(v.get("clip_consent").is_none(), "no clip_consent key on an ordinary message: {v}");
        // and WITH one, it is present verbatim
        let with = MessageResponse { clip_consent: Some(serde_json::json!({"proposal_id":"p","approver_count":2,"part_file_ids":["a"],"solo":false})), ..m };
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&with).unwrap()).unwrap();
        assert_eq!(v["clip_consent"]["approver_count"], 2);
        assert!(v["clip_consent"].get("approvers").is_none(), "the stamp carries a COUNT, never identities");
    }
}
