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
/// 2. The recipient's `allow_dms_from_server_members` is on AND the two share
///    a server — the flag says "server members" and since the 2026-09-05
///    boundary fixes it means exactly that. Before, "on" (the default) let
///    any account on the instance open a conversation with anyone.
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
/// CLOSED: a missing or deleted recipient, and a lookup error, both refuse.
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
    // The flag says "server members", so relying on it requires a shared
    // server. Without that term any account on the instance could open a
    // conversation with anyone whose flag was on (the default) — which also
    // made the "must already share a conversation" gate on GET /users/:id/dm-keys
    // self-satisfiable. Friends and a recipient who wrote first stay exempt.
    let row: Result<Option<(bool, bool, bool, bool)>, sqlx::Error> = sqlx::query_as(
        "SELECT u.allow_dms_from_server_members, \
                EXISTS(SELECT 1 FROM friends f \
                       WHERE (f.user1_id = $1 AND f.user2_id = $2) \
                          OR (f.user1_id = $2 AND f.user2_id = $1)), \
                EXISTS(SELECT 1 FROM dm_messages m \
                       JOIN dm_conversations c ON c.id = m.conversation_id \
                       WHERE m.sender_id = $2 \
                         AND ((c.user1_id = $1 AND c.user2_id = $2) \
                           OR (c.user1_id = $2 AND c.user2_id = $1))), \
                EXISTS(SELECT 1 FROM server_members a \
                       JOIN server_members b ON b.server_id = a.server_id \
                       WHERE a.user_id = $1 AND b.user_id = $2) \
         FROM users u WHERE u.id = $2 AND u.deleted_at IS NULL",
    )
    .bind(sender)
    .bind(recipient)
    .fetch_optional(&state.pool)
    .await;
    match row {
        Ok(Some((allows, are_friends, recipient_wrote_first, share_server))) => {
            are_friends || recipient_wrote_first || (allows && share_server)
        }
        // No live recipient: nothing to accept. (The REST caller has already
        // answered 404 for this case; the WS path has no other existence check.)
        Ok(None) => false,
        // Fail CLOSED — this is a consent gate. `unwrap_or(None)` used to fold
        // a query error into the permissive arm.
        Err(e) => {
            tracing::error!(
                "recipient_accepts_dms: lookup failed for {} -> {}: {:?}",
                sender,
                recipient,
                e
            );
            false
        }
    }
}

/// Everything the read gates below decide on, for one ordered pair, read in
/// ONE statement so the two decisions can never disagree about the facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Relationship {
    /// Either account has blocked the other.
    pub blocked: bool,
    pub friends: bool,
    /// At least one server has both as members.
    pub share_server: bool,
    /// The target's "Allow DMs from server members" flag.
    pub target_allows_server_dms: bool,
    /// The target has already sent a message in the pair conversation.
    pub target_wrote_first: bool,
}

/// Look the pair up. `None` means "no live target" (unallocated, or a
/// tombstone) OR a lookup that could not answer — both are refusals to every
/// caller, and a query error must never read as a relationship.
async fn relationship(pool: &sqlx::PgPool, me: i64, target: i64) -> Option<Relationship> {
    match sqlx::query_as::<_, (bool, bool, bool, bool, bool)>(
        "SELECT EXISTS(SELECT 1 FROM blocked_users bl \
                       WHERE (bl.blocker_id = $1 AND bl.blocked_id = $2) \
                          OR (bl.blocker_id = $2 AND bl.blocked_id = $1)), \
                EXISTS(SELECT 1 FROM friends f \
                       WHERE (f.user1_id = $1 AND f.user2_id = $2) \
                          OR (f.user1_id = $2 AND f.user2_id = $1)), \
                EXISTS(SELECT 1 FROM server_members a \
                       JOIN server_members b ON b.server_id = a.server_id \
                       WHERE a.user_id = $1 AND b.user_id = $2), \
                u.allow_dms_from_server_members, \
                EXISTS(SELECT 1 FROM dm_messages m \
                       JOIN dm_conversations c ON c.id = m.conversation_id \
                       WHERE m.sender_id = $2 \
                         AND ((c.user1_id = $1 AND c.user2_id = $2) \
                           OR (c.user1_id = $2 AND c.user2_id = $1))) \
         FROM users u WHERE u.id = $2 AND u.deleted_at IS NULL",
    )
    .bind(me)
    .bind(target)
    .fetch_optional(pool)
    .await
    {
        Ok(Some((blocked, friends, share_server, target_allows_server_dms, target_wrote_first))) => {
            Some(Relationship { blocked, friends, share_server, target_allows_server_dms, target_wrote_first })
        }
        Ok(None) => None,
        Err(e) => {
            tracing::error!("relationship: lookup failed for {} -> {}: {:?}", me, target, e);
            None
        }
    }
}

/// The dm-keys rule, as a pure decision: friends, a shared server WHILE the
/// target accepts DMs from server members, or a target who already wrote —
/// and never across a block.
///
/// The block term belongs HERE and only here (C07): /dm-keys is a live
/// session census (device count, recency, protocol version) that a blocked
/// ex-contact has no business polling, and nothing the blocker still uses
/// derives from it. Contrast `identity_context_allows`.
pub(crate) fn dm_context_allows(r: &Relationship) -> bool {
    !r.blocked
        && (r.friends || (r.target_allows_server_dms && r.share_server) || r.target_wrote_first)
}

/// The identity/signing-key rule. It differs from `dm_context_allows` in two
/// deliberate ways, both because the key it serves is a DEPENDENCY of things
/// the caller is still entitled to, not a privilege in itself:
///
/// 1. A shared server counts whether or not the target takes DMs from its
///    members. Every server-mate who can see a channel already receives this
///    key through GET /channels/:id/member-keys (it is what channel keys are
///    wrapped to), and voice media E2EE and the DTLS pin derive from it for
///    every peer in a server voice channel — so conditioning it on a DM
///    preference would only downgrade those calls to transport-only, not
///    withhold anything.
/// 2. A block does NOT refuse it. Blocking evicts nobody from a shared server
///    or its voice channels, so a blocked pair routinely ends up in the same
///    call; this route is the SOLE source of the peer identity key the mesh
///    media key and the DTLS pin are derived from, and the client has no
///    other fallback. Refusing here silently stripped media E2EE between
///    exactly those two peers (frames dropped outright under the default
///    require-E2EE setting, shown as an endless "setting up encryption"), and
///    since existing DM history is decrypted under the same key, blocking a
///    DM partner made the thread the server still shows unreadable. The key
///    is public to whoever it is served to; what a block withholds is
///    delivery (every DM/file/friend WRITE path refuses a blocked pair) and
///    the session census above, never the material needed to read what was
///    already exchanged or to seal a call both are still in.
pub(crate) fn identity_context_allows(r: &Relationship) -> bool {
    r.friends || r.share_server || r.target_wrote_first
}

/// May `me` learn `target`'s DM key material (GET /users/:id/dm-keys)?
/// Friends, a shared server (while the target accepts DMs from server
/// members), or a target who has already written to `me` — and never while
/// either has blocked the other. A
/// bare dm_conversations row is NOT evidence of a relationship — the caller can
/// create one unilaterally — so the read gate must not rest on it. Self is
/// always allowed. Fails closed.
pub(crate) async fn users_share_context(pool: &sqlx::PgPool, me: i64, target: i64) -> bool {
    if me == target {
        return true;
    }
    // The SAME rule as recipient_accepts_dms, so the docs can say so: a shared
    // server counts only while the target's "Allow DMs from server members" is
    // on; friends and a target who already wrote to `me` always do.
    //
    // A block (either direction) overrides all three. Blocking deletes no
    // friends row and no message, so without this term the disjuncts outlived
    // the block for good and a blocked ex-contact kept polling the target's
    // live session census (device count, recency, protocol version) — the
    // very thing this gate exists to withhold. Every WRITE path refuses a
    // blocked pair; the read gate has to agree with them.
    relationship(pool, me, target).await.map_or(false, |r| dm_context_allows(&r))
}

/// May `me` read `target`'s identity (X25519) or account signing (Ed25519)
/// public key (GET /users/:id/public-key, /signing-key)? Self, or
/// `identity_context_allows` above — which, unlike `users_share_context`,
/// deliberately ignores blocks (see its doc comment for why). Ungated, those
/// routes were an existence oracle over the dense id space, tombstones
/// included. Fails closed: no live target, or a lookup error, is the 404.
pub(crate) async fn users_share_identity_context(pool: &sqlx::PgPool, me: i64, target: i64) -> bool {
    if me == target {
        return true;
    }
    relationship(pool, me, target).await.map_or(false, |r| identity_context_allows(&r))
}

/// Every account with a block in EITHER direction with `me`, in one query,
/// for the REST presence readers (member lists, /users/search): a blocked
/// pair must read as offline there exactly as `presence_audience` (ws.rs)
/// already withholds the UserOnline/UserOffline frames — otherwise the WS
/// fix bought nothing against a client that polls the member list. Callers
/// fail CLOSED on `Err`: report everyone offline for that request rather
/// than leak a live status they could not check.
///
/// `blocked_users` columns are INT4; the ids are widened in SQL so the caller
/// gets the `i64` it compares presence against, and `me` is bound as INT8
/// (Postgres compares int4 = int8 natively) rather than truncated.
pub(crate) async fn blocked_ids_for(
    pool: &sqlx::PgPool,
    me: i64,
) -> Result<std::collections::HashSet<i64>, sqlx::Error> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT (CASE WHEN b.blocker_id = $1 THEN b.blocked_id ELSE b.blocker_id END)::BIGINT \
         FROM blocked_users b \
         WHERE b.blocker_id = $1 OR b.blocked_id = $1",
    )
    .bind(me)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

#[cfg(test)]
mod relationship_gate_tests {
    use super::{dm_context_allows, identity_context_allows, Relationship};

    const NONE: Relationship = Relationship {
        blocked: false,
        friends: false,
        share_server: false,
        target_allows_server_dms: true,
        target_wrote_first: false,
    };

    /// Positive controls: each disjunct on its own opens both gates.
    #[test]
    fn each_relationship_alone_is_enough() {
        for r in [
            Relationship { friends: true, ..NONE },
            Relationship { share_server: true, ..NONE },
            Relationship { target_wrote_first: true, ..NONE },
        ] {
            assert!(dm_context_allows(&r), "{r:?}");
            assert!(identity_context_allows(&r), "{r:?}");
        }
    }

    #[test]
    fn a_stranger_gets_nothing() {
        assert!(!dm_context_allows(&NONE));
        assert!(!identity_context_allows(&NONE));
    }

    /// C07: a block beats every disjunct for the dm-keys census. Blocking
    /// deletes no friends row and no message, so this term is the only thing
    /// that ends the blocked account's read access to it.
    #[test]
    fn a_block_overrides_every_relationship_for_dm_keys() {
        let all = Relationship { friends: true, share_server: true, target_wrote_first: true, ..NONE };
        assert!(dm_context_allows(&all));
        let blocked = Relationship { blocked: true, ..all };
        assert!(!dm_context_allows(&blocked));
    }

    /// The identity key is NOT withheld across a block: it is what mesh voice
    /// media E2EE, the DTLS pin and existing DM history decrypt under, and a
    /// block evicts nobody from a shared voice channel. Each disjunct still
    /// opens the gate on its own with a block present; a blocked STRANGER is
    /// still refused (the oracle stays closed).
    #[test]
    fn a_block_does_not_withhold_the_identity_key() {
        for r in [
            Relationship { blocked: true, friends: true, ..NONE },
            Relationship { blocked: true, share_server: true, ..NONE },
            Relationship { blocked: true, target_wrote_first: true, ..NONE },
        ] {
            assert!(identity_context_allows(&r), "{r:?}");
            // ...and the same pair is still refused the session census.
            assert!(!dm_context_allows(&r), "{r:?}");
        }
        assert!(!identity_context_allows(&Relationship { blocked: true, ..NONE }));
    }

    /// The other place the two gates differ: a shared server with the target's
    /// "Allow DMs from server members" off still serves the identity key
    /// (member-keys already does) but not the session census.
    #[test]
    fn server_dm_preference_gates_only_the_dm_keys() {
        let r = Relationship { share_server: true, target_allows_server_dms: false, ..NONE };
        assert!(!dm_context_allows(&r));
        assert!(identity_context_allows(&r));
        // The preference is about SERVER members: it never touches a friend
        // or someone who already wrote.
        for r in [
            Relationship { friends: true, target_allows_server_dms: false, ..NONE },
            Relationship { target_wrote_first: true, target_allows_server_dms: false, ..NONE },
        ] {
            assert!(dm_context_allows(&r), "{r:?}");
        }
    }
}

const DMS_NOT_ACCEPTED: &str = "This user only accepts direct messages from friends and people who share a server with them";

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

    // Verify the other user exists (and is not a tombstone — a deleted account's
    // username was otherwise still resolvable by id here) and get their
    // display_name.
    let user_exists: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT username, display_name FROM users WHERE id = $1 AND deleted_at IS NULL",
    )
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
    // Fail CLOSED on a query error — a block is a deny list.
    //
    // A block answers with the SAME status and body as the consent refusal
    // below. A distinct "you cannot message this user" let any account tell
    // "they blocked me" from "they only take DMs from friends/server-mates"
    // in one request — the same one-bit oracle send_friend_request closed
    // (r2-1-L1-03). Nothing is written either way.
    let blocked: Option<(i32,)> = match sqlx::query_as(
        "SELECT 1 FROM blocked_users \
         WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)",
    )
    .bind(current_user_id as i32)
    .bind(other_user_id as i32)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            tracing::error!("start_conversation: block lookup failed: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Could not verify block status").into_response();
        }
    };
    if blocked.is_some() {
        return (StatusCode::FORBIDDEN, DMS_NOT_ACCEPTED).into_response();
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
    // Fail CLOSED on a query error — a block is a deny list.
    //
    // The refusal is the SAME status and body as the consent refusal further
    // down, so a block is indistinguishable from a privacy setting (the
    // block-status oracle, r2-1-L1-03). No row is written, no frame delivered.
    let blocked: Option<(i32,)> = match sqlx::query_as(
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
    {
        Ok(row) => row,
        Err(e) => {
            tracing::error!("send_message (DM): block lookup failed: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Could not verify block status").into_response();
        }
    };

    if blocked.is_some() {
        return (StatusCode::FORBIDDEN, DMS_NOT_ACCEPTED).into_response();
    }

    // Enforce the recipient's friends-only DM flag per message (not just at
    // conversation creation) so turning it ON takes effect immediately for
    // existing conversations too.
    // Fail CLOSED: this lookup feeds the only consent gate on the send path,
    // and `unwrap_or(None)` skipped the gate entirely on a query error.
    let other: Option<(i64,)> = match sqlx::query_as(
        "SELECT CASE WHEN user1_id = $2 THEN user2_id ELSE user1_id END \
         FROM dm_conversations WHERE id = $1",
    )
    .bind(&conversation_id)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            tracing::error!("send_message (DM): recipient lookup failed: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Could not verify recipient settings").into_response();
        }
    };
    let Some((recipient_id,)) = other else {
        // The participant check above found the row; its vanishing since is a
        // deleted conversation, not a licence to skip consent.
        return (StatusCode::FORBIDDEN, "Not a participant of this conversation").into_response();
    };
    if !recipient_accepts_dms(&state, claims.sub, recipient_id).await {
        return (StatusCode::FORBIDDEN, DMS_NOT_ACCEPTED).into_response();
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
