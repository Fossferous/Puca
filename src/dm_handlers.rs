//! Direct Message Handlers
//!
//! REST API handlers for DM (Direct Message) functionality.

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
use crate::state::AppState;

// --- DTOs ---

#[derive(Deserialize)]
pub struct StartConversationRequest {
    pub user_id: i64,
}

#[derive(Serialize)]
pub struct DMConversationResponse {
    pub id: String,
    pub other_user_id: i64,
    pub other_username: String,
    pub other_display_name: Option<String>,
    pub last_message: Option<String>,
    pub last_message_at: Option<String>,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct DMMessageResponse {
    pub id: String,
    pub conversation_id: String,
    pub sender_id: i64,
    pub sender_username: String,
    pub sender_display_name: Option<String>,
    pub content: String,
    pub created_at: String,
}

#[derive(Deserialize)]
pub struct SendDMMessageRequest {
    pub content: String,
}

#[derive(Deserialize)]
pub struct MessagesQuery {
    #[serde(default = "default_limit")]
    pub limit: i32,
}

fn default_limit() -> i32 {
    50
}

/// May `sender` DM `recipient`?
///
/// The flag is INBOUND-only, matching what Settings promises ("only your
/// friends can message you"): turning it off restricts who may write to YOU,
/// never who you may write to. Three ways through:
///
/// 1. They are accepted friends.
/// 2. The recipient's `allow_dms_from_server_members` is on.
/// 3. The recipient has already sent a message in this conversation — having
///    opened a channel yourself is consent to be answered in it.
///
/// (3) is what stops the flag from being a one-way megaphone. Without it a user
/// could set the flag off, open a conversation with a stranger (their own flag
/// is what gates that, and it is on), send whatever they liked, and the target
/// physically could not reply: the reply consults the SENDER's flag, finds it
/// off, and is refused with no explanation.
///
/// This is the server-side enforcement for the Settings toggle — like the block
/// check below, client-side hiding alone would be trivially bypassed. Fails
/// open on a missing recipient (that case surfaces as its own 404 in the
/// caller).
pub(crate) async fn recipient_accepts_dms(
    state: &Arc<AppState>,
    sender: i64,
    recipient: i64,
) -> bool {
    // You always accept your own messages. Without this, a user with the
    // friends-only flag ON could not message THEMSELVES: `allows` is their own
    // false flag, they are not in `friends` with themselves, and on a fresh
    // self-conversation nobody has "written first" — so all three disjuncts
    // are false and their own device-to-device notes are refused.
    if sender == recipient {
        return true;
    }
    let row: Option<(bool, bool, bool)> = sqlx::query_as(
        "SELECT u.allow_dms_from_server_members, \
                EXISTS(SELECT 1 FROM friends f \
                       WHERE (f.user1_id = $1 AND f.user2_id = $2) \
                          OR (f.user1_id = $2 AND f.user2_id = $1)), \
                EXISTS(SELECT 1 FROM dm_messages m \
                       JOIN dm_conversations c ON c.id = m.conversation_id \
                       WHERE m.sender_id = $2 \
                         AND ((c.user1_id = $1 AND c.user2_id = $2) \
                           OR (c.user1_id = $2 AND c.user2_id = $1))) \
         FROM users u WHERE u.id = $2",
    )
    .bind(sender)
    .bind(recipient)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    match row {
        Some((allows, are_friends, recipient_wrote_first)) => {
            allows || are_friends || recipient_wrote_first
        }
        None => true,
    }
}

const DMS_NOT_ACCEPTED: &str = "This user only accepts direct messages from friends";

// --- Handlers ---

/// List all DM conversations for the current user
pub async fn list_conversations(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Single query: JOIN the other user's info and LATERAL-join the last message
    // per conversation. Previously this ran one SELECT-user round-trip per
    // conversation (an N+1 that scaled with attacker-growable conversations).
    // Capped at 500 so a user who started thousands of conversations can't force
    // an unbounded response.
    let rows: Vec<(
        String,
        i64,
        i64,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
    )> = sqlx::query_as(
        r#"
        SELECT
            c.id,
            c.user1_id,
            c.user2_id,
            (replace(c.created_at::text, ' ', 'T') || 'Z') AS created_at,
            lm.content AS last_message,
            (replace(lm.created_at::text, ' ', 'T') || 'Z') AS last_message_at,
            ou.username,
            ou.display_name
        FROM dm_conversations c
        JOIN users ou ON ou.id = (CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END)
        LEFT JOIN LATERAL (
            SELECT dm.content, dm.created_at
            FROM dm_messages dm
            WHERE dm.conversation_id = c.id
            ORDER BY dm.created_at DESC
            LIMIT 1
        ) lm ON true
        -- Self-conversations are listed like any other. You are a valid DM
        -- recipient, so `user1_id = user2_id = you` is a normal row; the
        -- `other_user_id` computed below resolves to yourself, which is
        -- exactly what the client should render.
        WHERE (c.user1_id = $1 OR c.user2_id = $1)
        ORDER BY COALESCE(lm.created_at, c.created_at) DESC
        LIMIT 500
        "#,
    )
    .bind(claims.sub)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let response: Vec<DMConversationResponse> = rows
        .into_iter()
        .map(
            |(
                id,
                user1_id,
                user2_id,
                created_at,
                last_message,
                last_message_at,
                other_username,
                other_display_name,
            )| {
                let other_user_id = if user1_id == claims.sub {
                    user2_id
                } else {
                    user1_id
                };
                DMConversationResponse {
                    id,
                    other_user_id,
                    other_username,
                    other_display_name,
                    last_message,
                    last_message_at,
                    created_at,
                }
            },
        )
        .collect();

    Json(response)
}

/// Start a new DM conversation or get existing one
pub async fn start_conversation(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<StartConversationRequest>,
) -> impl IntoResponse {
    let current_user_id = claims.sub;
    let other_user_id = payload.user_id;

    // Messaging YOURSELF is allowed. It is not a special "Notes to self"
    // feature — you are simply a valid recipient like anyone else, which is
    // also what lets a large file move between your own PC and phone (the
    // peer-to-peer path only offers inside a DM).
    //
    // The (user1_id, user2_id) ordering below collapses to (me, me), which the
    // UNIQUE(user1_id, user2_id) constraint accepts as one row, so there is
    // exactly one self-conversation per user.

    // Verify the other user exists and get their display_name
    let user_exists: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT username, display_name FROM users WHERE id = $1")
            .bind(other_user_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    let (other_username, other_display_name) = match user_exists {
        Some((username, display_name)) => (username, display_name),
        None => return (StatusCode::NOT_FOUND, "User not found").into_response(),
    };

    // Ensure consistent ordering (lower ID is always user1)
    let (user1_id, user2_id) = if current_user_id < other_user_id {
        (current_user_id, other_user_id)
    } else {
        (other_user_id, current_user_id)
    };

    // Check if conversation already exists
    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT id, (replace(created_at::text, ' ', 'T') || 'Z') AS created_at FROM dm_conversations WHERE user1_id = $1 AND user2_id = $2"
    )
    .bind(user1_id)
    .bind(user2_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if let Some((id, created_at)) = existing {
        // Return existing conversation
        return Json(DMConversationResponse {
            id,
            other_user_id,
            other_username,
            other_display_name,
            last_message: None,
            last_message_at: None,
            created_at,
        })
        .into_response();
    }

    // Gate NEW conversations on the recipient's consent: blocks (either
    // direction) and the friends-only DM privacy flag. An existing
    // conversation above is still returned — history stays viewable; the
    // send path enforces the same rules per message.
    let blocked: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM blocked_users \
         WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)",
    )
    .bind(current_user_id as i32)
    .bind(other_user_id as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    if blocked.is_some() {
        return (StatusCode::FORBIDDEN, "You cannot message this user").into_response();
    }
    if !recipient_accepts_dms(&state, current_user_id, other_user_id).await {
        return (StatusCode::FORBIDDEN, DMS_NOT_ACCEPTED).into_response();
    }

    // Create new conversation. Upsert-returning is race-safe: two concurrent
    // opens of the same pair (double-click / two devices) both get the same id
    // instead of the loser hitting the unique constraint and 500ing. The DO
    // UPDATE (a harmless no-op assignment) makes RETURNING yield the existing
    // row's id on conflict.
    let conversation_id = Uuid::new_v4().to_string();

    let row: Result<(String,), _> = sqlx::query_as(
        "INSERT INTO dm_conversations (id, user1_id, user2_id) VALUES ($1, $2, $3) \
         ON CONFLICT (user1_id, user2_id) DO UPDATE SET user1_id = EXCLUDED.user1_id \
         RETURNING id",
    )
    .bind(&conversation_id)
    .bind(user1_id)
    .bind(user2_id)
    .fetch_one(&state.pool)
    .await;

    let final_id = match row {
        Ok((id,)) => id,
        Err(e) => {
            tracing::error!("Failed to create DM conversation: {:?}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to create conversation",
            )
                .into_response();
        }
    };

    Json(DMConversationResponse {
        id: final_id,
        other_user_id,
        other_username,
        other_display_name,
        last_message: None,
        last_message_at: None,
        created_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
    })
    .into_response()
}

/// Get messages from a DM conversation
pub async fn get_messages(
    State(state): State<Arc<AppState>>,
    Path(conversation_id): Path<String>,
    Query(query): Query<MessagesQuery>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Verify user is part of this conversation
    let is_participant: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM dm_conversations WHERE id = $1 AND (user1_id = $2 OR user2_id = $3)",
    )
    .bind(&conversation_id)
    .bind(claims.sub)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if is_participant.is_none() {
        return (
            StatusCode::FORBIDDEN,
            "Not a participant of this conversation",
        )
            .into_response();
    }

    let messages: Vec<(String, String, i64, String, Option<String>, String, String)> = sqlx::query_as(
        r#"
        SELECT m.id, m.conversation_id, m.sender_id, u.username, u.display_name, m.content, (replace(m.created_at::text, ' ', 'T') || 'Z') AS created_at
        FROM dm_messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.conversation_id = $1
        ORDER BY m.created_at DESC
        LIMIT $2
        "#
    )
    .bind(&conversation_id)
    // Clamp the client-supplied limit (matches message_handlers.rs) so a caller
    // can't request billions of rows and exhaust memory/DB.
    .bind(query.limit.clamp(1, 200))
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    // Reverse to get chronological order
    let response: Vec<DMMessageResponse> = messages
        .into_iter()
        .rev()
        .map(
            |(
                id,
                conversation_id,
                sender_id,
                sender_username,
                sender_display_name,
                content,
                created_at,
            )| {
                DMMessageResponse {
                    id,
                    conversation_id,
                    sender_id,
                    sender_username,
                    sender_display_name,
                    content,
                    created_at,
                }
            },
        )
        .collect();

    Json(response).into_response()
}

/// Send a message in a DM conversation
pub async fn send_message(
    State(state): State<Arc<AppState>>,
    Path(conversation_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<SendDMMessageRequest>,
) -> impl IntoResponse {
    // Validate content: DM sends were previously unvalidated. Empty is a no-op,
    // an oversized body wastes storage, and a NUL byte makes Postgres TEXT 500
    // (error 22021) rather than storing it.
    if payload.content.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "Message content cannot be empty").into_response();
    }
    if payload.content.len() > 8000 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Message too long").into_response();
    }
    if payload.content.contains('\0') {
        return (
            StatusCode::BAD_REQUEST,
            "Message contains invalid characters",
        )
            .into_response();
    }

    // Verify user is part of this conversation
    let is_participant: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM dm_conversations WHERE id = $1 AND (user1_id = $2 OR user2_id = $3)",
    )
    .bind(&conversation_id)
    .bind(claims.sub)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if is_participant.is_none() {
        return (
            StatusCode::FORBIDDEN,
            "Not a participant of this conversation",
        )
            .into_response();
    }

    // Enforce blocks server-side: if either participant has blocked the other,
    // DMs cannot be sent (client-side hiding alone would be trivially bypassed).
    let blocked: Option<(i32,)> = sqlx::query_as(
        r#"
        SELECT 1 FROM blocked_users b
        JOIN dm_conversations c ON c.id = $1
        WHERE (b.blocker_id = c.user1_id AND b.blocked_id = c.user2_id)
           OR (b.blocker_id = c.user2_id AND b.blocked_id = c.user1_id)
        "#,
    )
    .bind(&conversation_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if blocked.is_some() {
        return (StatusCode::FORBIDDEN, "You cannot message this user").into_response();
    }

    // Enforce the recipient's friends-only DM flag per message (not just at
    // conversation creation) so turning it ON takes effect immediately for
    // existing conversations too.
    let other: Option<(i64,)> = sqlx::query_as(
        "SELECT CASE WHEN user1_id = $2 THEN user2_id ELSE user1_id END \
         FROM dm_conversations WHERE id = $1",
    )
    .bind(&conversation_id)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    if let Some((recipient_id,)) = other {
        if !recipient_accepts_dms(&state, claims.sub, recipient_id).await {
            return (StatusCode::FORBIDDEN, DMS_NOT_ACCEPTED).into_response();
        }
    }

    let message_id = Uuid::new_v4().to_string();

    let result = sqlx::query(
        "INSERT INTO dm_messages (id, conversation_id, sender_id, content) VALUES ($1, $2, $3, $4)",
    )
    .bind(&message_id)
    .bind(&conversation_id)
    .bind(claims.sub)
    .bind(&payload.content)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => {
            // Get sender username and display_name
            let sender: Option<(String, Option<String>)> =
                sqlx::query_as("SELECT username, display_name FROM users WHERE id = $1")
                    .bind(claims.sub)
                    .fetch_optional(&state.pool)
                    .await
                    .unwrap_or(None);

            let (sender_username, sender_display_name) = sender
                .map(|(u, d)| (u, d))
                .unwrap_or_else(|| ("Unknown".to_string(), None));

            Json(DMMessageResponse {
                id: message_id,
                conversation_id,
                sender_id: claims.sub,
                sender_username,
                sender_display_name,
                content: payload.content,
                created_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            })
            .into_response()
        }
        Err(e) => {
            tracing::error!("Failed to send DM message: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to send message").into_response()
        }
    }
}
