//! Reaction and Emoji Handlers
//!
//! REST API handlers for message reactions and custom server emojis.

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

use crate::auth::Claims;
use crate::permissions::{check_message_view, check_message_view_perms, ChannelAccess, Permissions};
use crate::protocol::ServerMessage;
use crate::state::AppState;

/// Notify everyone viewing the message's channel that its reactions changed,
/// so their UIs refetch in real time (the standard chat-app pattern). DM messages notify both
/// conversation participants directly.
async fn broadcast_reaction_update(state: &AppState, message_id: &str) {
    let channel: Option<(i32,)> = sqlx::query_as("SELECT channel_id FROM messages WHERE id = $1")
        .bind(message_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
    if let Some((channel_id,)) = channel {
        state.broadcast_to_room(
            &format!("channel_{}", channel_id),
            ServerMessage::ReactionUpdate {
                room_id: format!("channel_{}", channel_id),
                message_id: message_id.to_string(),
            },
            None,
        );
        return;
    }

    // dm_conversations.user1_id/user2_id are BIGINT (migration 019); decoding
    // them into i32 failed and unwrap_or(None) swallowed it, so DM reaction
    // updates never broadcast. Decode as i64 to match the schema.
    let dm: Option<(String, i64, i64)> = sqlx::query_as(
        "SELECT c.id, c.user1_id, c.user2_id FROM dm_messages m \
         JOIN dm_conversations c ON m.conversation_id = c.id WHERE m.id = $1",
    )
    .bind(message_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    if let Some((conversation_id, user1, user2)) = dm {
        let msg = ServerMessage::ReactionUpdate {
            room_id: format!("dm_{}", conversation_id),
            message_id: message_id.to_string(),
        };
        state.send_to_user(user1, msg.clone());
        state.send_to_user(user2, msg);
    }
}

/// Resolve message access, returning early on failure. Channel messages
/// require VIEW_CHANNEL on their channel (a VIEW-denied member sees 404, same
/// as a missing message); DM messages require being a participant.
macro_rules! require_message_member {
    ($state:expr, $message_id:expr, $user_id:expr) => {
        match check_message_view(&$state.pool, &$message_id, $user_id).await {
            ChannelAccess::Allowed(server_id) => server_id,
            ChannelAccess::NotFound => {
                return (StatusCode::NOT_FOUND, "Message not found").into_response()
            }
            ChannelAccess::Forbidden => {
                return (StatusCode::FORBIDDEN, "Not a member of this server").into_response()
            }
        }
    };
}

/// Same, but also yields the caller's effective channel permissions (None for a
/// DM message, where roles do not apply) so a handler can check a further bit.
macro_rules! require_message_member_perms {
    ($state:expr, $message_id:expr, $user_id:expr) => {
        match check_message_view_perms(&$state.pool, &$message_id, $user_id).await {
            (ChannelAccess::Allowed(server_id), perms) => (server_id, perms),
            (ChannelAccess::NotFound, _) => {
                return (StatusCode::NOT_FOUND, "Message not found").into_response()
            }
            (ChannelAccess::Forbidden, _) => {
                return (StatusCode::FORBIDDEN, "Not a member of this server").into_response()
            }
        }
    };
}

// --- DTOs ---

#[derive(Deserialize)]
pub struct AddReactionRequest {
    pub emoji: String,
    #[serde(default)]
    pub is_custom: bool,
}

#[derive(Serialize)]
pub struct ReactionResponse {
    pub emoji: String,
    pub count: i64,
    pub users: Vec<ReactionUser>,
}

#[derive(Serialize)]
pub struct ReactionUser {
    pub id: i64,
    pub username: String,
}

#[derive(Deserialize)]
pub struct CreateEmojiRequest {
    pub name: String,
    pub file_id: String,
}

#[derive(Serialize)]
pub struct EmojiResponse {
    pub id: String,
    pub name: String,
    pub url: String,
    /// Who uploaded it. The Emoji tab needs this to offer Delete to exactly
    /// the people delete_emoji will accept it from (uploader or owner) —
    /// without it the UI hid delete from uploaders the server permits.
    pub uploader_id: i64,
}

// --- Reaction Handlers ---

/// Max bytes for a reaction "emoji" token (fits any unicode emoji or
/// :custom_name:). Caps distinct-row growth and the get_reactions fan-out.
const MAX_EMOJI_LEN: usize = 64;

/// Whether a reaction token is acceptable: non-empty and within the length cap.
pub(crate) fn valid_emoji(emoji: &str) -> bool {
    !emoji.is_empty() && emoji.len() <= MAX_EMOJI_LEN
}

/// If `message_id` is a DM message and either participant has blocked the
/// other, returns true — reacting is then refused, mirroring the DM *send*
/// path (dm_handlers.rs). Channel messages and non-blocked DMs return false.
/// A DB error fails CLOSED to "blocked" is too aggressive (it would break
/// reactions on every channel message on a transient error), so this fails
/// OPEN to false only for the block lookup itself — the caller has already
/// proven view/participant access via `require_message_member!`, so the worst
/// case here is a blocked user's reaction slipping through on a DB blip, not
/// disclosure.
async fn dm_reaction_blocked(state: &AppState, message_id: &str) -> bool {
    let blocked: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT 1
        FROM dm_messages m
        JOIN dm_conversations c ON m.conversation_id = c.id
        JOIN blocked_users b
          ON (b.blocker_id = c.user1_id AND b.blocked_id = c.user2_id)
          OR (b.blocker_id = c.user2_id AND b.blocked_id = c.user1_id)
        WHERE m.id = $1
        "#,
    )
    .bind(message_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    blocked.is_some()
}

/// Add a reaction to a message
pub async fn add_reaction(
    State(state): State<Arc<AppState>>,
    Path(message_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<AddReactionRequest>,
) -> impl IntoResponse {
    let (_server_id, perms) = require_message_member_perms!(state, message_id, claims.sub);

    // ADD_REACTIONS is an editable role bit ("React to messages with emoji")
    // that nothing checked, so a member explicitly denied it could still react.
    // `perms` is None for a DM message — DMs have no roles, so the bit does not
    // apply there and the block check below is what governs instead.
    if let Some(p) = perms {
        if !p.has(Permissions::ADD_REACTIONS) {
            return (
                StatusCode::FORBIDDEN,
                "You do not have permission to add reactions in this channel",
            )
                .into_response();
        }
    }

    // Blocked users cannot react to each other's DMs, matching the DM send
    // path: a block that stops messages but still lets the blocker be pinged by
    // a reaction is a harassment channel the block is supposed to close.
    if dm_reaction_blocked(&state, &message_id).await {
        return (StatusCode::FORBIDDEN, "You cannot react to this message").into_response();
    }

    // Cap the emoji token: without this a member could store distinct multi-MB
    // "emoji" strings (each a new row, since ON CONFLICT never fires) — unbounded
    // row growth plus a heavy unbounded get_reactions later. 64 bytes fits any
    // real unicode emoji or :custom_name:.
    let emoji = payload.emoji.trim();
    if !valid_emoji(emoji) {
        return (StatusCode::BAD_REQUEST, "Invalid emoji").into_response();
    }

    // Cap the number of DISTINCT reactions on a message. Bounds both row growth
    // and the size of the get_reactions fan-out. Counted before insert; a member
    // re-adding an existing emoji (ON CONFLICT DO NOTHING) is unaffected.
    const MAX_REACTIONS_PER_MESSAGE: i64 = 100;
    let distinct: (i64,) =
        sqlx::query_as("SELECT COUNT(DISTINCT emoji) FROM message_reactions WHERE message_id = $1")
            .bind(&message_id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or((0,));
    let already: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM message_reactions WHERE message_id = $1 AND emoji = $2",
    )
    .bind(&message_id)
    .bind(emoji)
    .fetch_one(&state.pool)
    .await
    .unwrap_or((0,));
    if already.0 == 0 && distinct.0 >= MAX_REACTIONS_PER_MESSAGE {
        return (
            StatusCode::BAD_REQUEST,
            "Too many distinct reactions on this message",
        )
            .into_response();
    }

    // user_id is INTEGER (i32) in PostgreSQL
    let result = sqlx::query(
        "INSERT INTO message_reactions (message_id, user_id, emoji, is_custom) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING"
    )
    .bind(&message_id)
    .bind(claims.sub as i32)
    .bind(emoji)
    .bind(payload.is_custom)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => {
            broadcast_reaction_update(&state, &message_id).await;
            StatusCode::CREATED.into_response()
        }
        Err(e) => {
            tracing::error!("Failed to add reaction: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to add reaction").into_response()
        }
    }
}

/// Remove a reaction from a message
pub async fn remove_reaction(
    State(state): State<Arc<AppState>>,
    Path((message_id, emoji)): Path<(String, String)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let _server_id = require_message_member!(state, message_id, claims.sub);

    // user_id is INTEGER (i32) in PostgreSQL
    let result = sqlx::query(
        "DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
    )
    .bind(&message_id)
    .bind(claims.sub as i32)
    .bind(&emoji)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => {
            broadcast_reaction_update(&state, &message_id).await;
            StatusCode::OK.into_response()
        }
        Err(e) => {
            tracing::error!("Failed to remove reaction: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to remove reaction",
            )
                .into_response()
        }
    }
}

/// Get reactions for a message
pub async fn get_reactions(
    State(state): State<Arc<AppState>>,
    Path(message_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let _server_id = require_message_member!(state, message_id, claims.sub);

    // Get grouped reactions with user info
    // user_id is INTEGER (i32) in PostgreSQL
    // Hard LIMIT so a message with a pathological number of reactions can't pull
    // an unbounded row set into memory. add_reaction caps distinct emoji at 100;
    // 10k rows covers 100 emoji × 100 reactors with margin.
    let reactions: Vec<(String, i32, String)> = sqlx::query_as(
        r#"
        SELECT r.emoji, r.user_id, u.username
        FROM message_reactions r
        JOIN users u ON r.user_id = u.id
        WHERE r.message_id = $1
        ORDER BY r.created_at ASC
        LIMIT 10000
        "#,
    )
    .bind(&message_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    // Group by emoji
    let mut grouped: std::collections::HashMap<String, Vec<ReactionUser>> =
        std::collections::HashMap::new();
    for (emoji, user_id, username) in reactions {
        grouped.entry(emoji).or_default().push(ReactionUser {
            id: user_id as i64,
            username,
        });
    }

    let response: Vec<ReactionResponse> = grouped
        .into_iter()
        .map(|(emoji, users)| ReactionResponse {
            emoji,
            count: users.len() as i64,
            users,
        })
        .collect();

    Json(response).into_response()
}

// --- Custom Emoji Handlers ---

/// Upload a custom emoji to a server
pub async fn create_emoji(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateEmojiRequest>,
) -> impl IntoResponse {
    // Verify user is a member of the server
    let is_member: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2")
            .bind(&server_id)
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    if is_member.is_none() {
        return (StatusCode::FORBIDDEN, "Not a member of this server").into_response();
    }

    // Cap the emoji name (stored + returned to every member via list_emojis).
    if payload.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "Emoji name cannot be empty").into_response();
    }
    if payload.name.len() > 64 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Emoji name too long").into_response();
    }

    // Mass-assignment guard, mirroring the server-icon fix (server_handlers.rs):
    // the file_id must reference a blob the CALLER uploaded. Without the
    // uploader_id check a member could point a new emoji at ANY user's file by
    // UUID (an IDOR on the blob) — and, because delete_emoji reclaims the blob
    // on behalf of its true uploader, could then delete that file out from
    // under its owner by removing the emoji. An invalid-uuid string fails the
    // ::uuid cast → None → refused.
    let owns: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM uploaded_files WHERE id = $1::uuid AND uploader_id = $2",
    )
    .bind(&payload.file_id)
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if owns.is_none() {
        tracing::warn!(
            "create_emoji: user {} tried to use file {} they do not own on server {}",
            claims.sub, payload.file_id, server_id
        );
        return (
            StatusCode::FORBIDDEN,
            "Emoji image must be a file you uploaded",
        )
            .into_response();
    }

    let emoji_id = Uuid::new_v4().to_string();
    let result = sqlx::query(
        "INSERT INTO server_emojis (id, server_id, name, uploader_id, file_id) VALUES ($1, $2, $3, $4, $5)"
    )
    .bind(&emoji_id)
    .bind(&server_id)
    .bind(&payload.name)
    .bind(claims.sub as i32)
    .bind(&payload.file_id)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => Json(EmojiResponse {
            id: emoji_id,
            name: payload.name,
            url: format!("/files/{}", payload.file_id),
            uploader_id: claims.sub,
        })
        .into_response(),
        Err(e) => {
            if e.to_string().contains("UNIQUE") {
                (StatusCode::CONFLICT, "Emoji name already exists").into_response()
            } else {
                tracing::error!("Failed to create emoji: {:?}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create emoji").into_response()
            }
        }
    }
}

/// List all emojis for a server
pub async fn list_emojis(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Server-scoped read: require membership. Without it any authenticated user
    // could enumerate a private server's emoji names and file ids (and those
    // file ids are then fetchable via the public /files/:id route).
    let is_member: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2")
            .bind(&server_id)
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    if is_member.is_none() {
        return (StatusCode::FORBIDDEN, "Not a member of this server").into_response();
    }

    let emojis: Vec<(String, String, String, i32)> = sqlx::query_as(
        "SELECT id, name, file_id, uploader_id FROM server_emojis WHERE server_id = $1 ORDER BY name ASC"
    )
    .bind(&server_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let response: Vec<EmojiResponse> = emojis
        .into_iter()
        .map(|(id, name, file_id, uploader_id)| EmojiResponse {
            id,
            name,
            url: format!("/files/{}", file_id),
            uploader_id: uploader_id as i64,
        })
        .collect();

    Json(response).into_response()
}

/// Delete a custom emoji
pub async fn delete_emoji(
    State(state): State<Arc<AppState>>,
    Path((server_id, emoji_id)): Path<(String, String)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Check if user is server owner or emoji uploader
    let can_delete: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT 1 FROM server_emojis e
        JOIN servers s ON e.server_id = s.id
        WHERE e.id = $1 AND e.server_id = $2 AND (e.uploader_id = $3 OR s.owner_id = $4)
        "#,
    )
    .bind(&emoji_id)
    .bind(&server_id)
    .bind(claims.sub)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if can_delete.is_none() {
        return (StatusCode::FORBIDDEN, "Cannot delete this emoji").into_response();
    }

    // Reclaim the blob too, or the uploader's quota keeps counting an emoji
    // that no longer exists. RETURNING gives both halves atomically: the emoji
    // row is the only referent of this file, so unlike a message attachment
    // (which a forward can duplicate) removing it here is unambiguous.
    let deleted: Option<(String, i32)> =
        sqlx::query_as("DELETE FROM server_emojis WHERE id = $1 RETURNING file_id, uploader_id")
            .bind(&emoji_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    if let Some((ref file_id, uploader_id)) = deleted {
        crate::upload_handlers::remove_file(&state.pool, file_id, uploader_id as i64).await;
    }
    if deleted.is_none() {
        // The permission check above already proved the row existed and that
        // this caller may remove it, so getting here means a concurrent delete
        // won. The emoji is gone either way — stay idempotent and report OK,
        // as this handler did before it also reclaimed the blob.
        tracing::warn!(
            "delete_emoji: {} vanished between the permission check and the delete",
            emoji_id
        );
    }
    StatusCode::OK.into_response()
}

#[cfg(test)]
mod crash_resistance_tests {
    use super::*;

    #[test]
    fn emoji_rejects_empty_and_oversized() {
        assert!(valid_emoji("👍"));
        assert!(valid_emoji(":custom_name:"));
        assert!(valid_emoji(&"x".repeat(MAX_EMOJI_LEN)));
        assert!(!valid_emoji(""));
        assert!(!valid_emoji(&"x".repeat(MAX_EMOJI_LEN + 1)));
        // A megabyte "emoji" (the unbounded-row-growth lever) is rejected.
        assert!(!valid_emoji(&"a".repeat(1_000_000)));
    }
}
