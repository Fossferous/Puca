//! Friend System Handlers
//!
//! REST API handlers for friend requests and friend list management.

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::Claims;
use crate::state::AppState;

// --- DTOs ---

#[derive(Deserialize)]
pub struct SendFriendRequestBody {
    pub user_id: i64,
}

#[derive(Serialize)]
pub struct FriendResponse {
    pub id: i64,
    pub username: String,
    pub is_online: bool,
    pub since: String,
}

#[derive(Serialize)]
pub struct FriendRequestResponse {
    pub id: i64,
    pub sender_id: i64,
    pub sender_username: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct OutgoingRequestResponse {
    pub id: i64,
    pub receiver_id: i64,
    pub receiver_username: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct FriendshipStatus {
    pub is_friend: bool,
    pub request_sent: bool,
    pub request_received: bool,
    pub request_id: Option<i64>,
}

// --- Block visibility rule ---
//
// r2-1-L1-03 (0.9.5) and its review finding 11. Until 0.9.5 a friend request
// across a block answered 403, and since every other outcome has its own
// status that 403 meant exactly "a blocked_users row exists between us"; GET
// /blocked shows the caller their own direction, so it decoded to "they
// blocked me". The first fix answered 201 and wrote nothing, which only moved
// the oracle one request later: a real request answers 409 on repeat, shows
// in the outgoing list and reads `request_sent: true`, while the discarded one
// answered 201 again and showed nowhere.
//
// The rule now: a request between a pair with a block in either direction is
// WRITTEN exactly like any other request and is a real request from the
// SENDER's side — 201, then 409 "Friend request already pending" on repeat,
// listed by /friends/requests/outgoing, `request_sent: true` from
// /friends/:id/status. It does not exist from the RECIPIENT's side: absent
// from /friends/requests/incoming, `request_received: false`, and accept /
// reject answer the 404 an unknown id gets. Nothing is broadcast for friend
// requests (no WS frame, no wake), so there is nothing else to suppress; if a
// notification is ever added it must consult `hidden_from_recipient` first.
//
// Observable equivalence: every read the sender can make returns what it
// would return for an unblocked target that simply has not answered yet, and
// every read the recipient can make returns what it would return had the
// request never been sent. block_user and unblock_user (moderation_handlers)
// delete the pair's pending rows inside their transactions, so a hidden row is
// only ever one sent AFTER the block, and lifting the block removes it — to
// the sender that is indistinguishable from a rejection, which also deletes
// the row. (Should unblock stop deleting, the row simply becomes a visible
// pending request; that is a real request either way.)
//
// The rule is applied in SQL (NOT EXISTS over blocked_users, column to
// column) where a list is read, and through `hidden_from_recipient` where a
// single request is judged. Both FAIL CLOSED: a failed lookup hides.

/// Does a block exist between the two accounts, in either direction?
///
/// SQL text and widths shared with dm_handlers and ws (blocked_users columns
/// are INT4; see the 22P03 note in device_token.rs) so the prepared statement
/// is the same one. An id outside INT4 — which a Path<i64> can carry — cannot
/// name a row in blocked_users at all, so it is `Ok(false)` rather than a
/// wrapped alias of some other account (the C08/C27 trap).
async fn pair_blocked(pool: &sqlx::PgPool, a: i64, b: i64) -> Result<bool, sqlx::Error> {
    let (Ok(a), Ok(b)) = (i32::try_from(a), i32::try_from(b)) else {
        return Ok(false);
    };
    let row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM blocked_users WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)"
    )
    .bind(a)
    .bind(b)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// The pure half of `hidden_from_recipient`: given the outcome of the block
/// lookup, must the request be treated as nonexistent for the recipient?
/// A block hides; a failed lookup hides too (fail CLOSED — a block is a deny
/// list, and "could not check" must never render a request the blocker asked
/// not to receive).
fn hidden_on<E: std::fmt::Debug>(block_lookup: Result<bool, E>) -> bool {
    match block_lookup {
        Ok(blocked) => blocked,
        Err(e) => {
            tracing::error!("friend request: block lookup failed, hiding the request: {:?}", e);
            true
        }
    }
}

/// Recipient-side visibility of the request `sender_id -> receiver_id`: true
/// when the recipient must see it as nonexistent (see the rule above).
async fn hidden_from_recipient(pool: &sqlx::PgPool, sender_id: i64, receiver_id: i64) -> bool {
    hidden_on(pair_blocked(pool, sender_id, receiver_id).await)
}

/// The recipient-side rule as SQL, for list reads over `friend_requests fr`.
/// Column-to-column (BIGINT against INT4 compares fine) so the text binds no
/// extra parameters. Kept in one place so the incoming list and the
/// single-request helper cannot drift apart.
const NOT_HIDDEN_FROM_RECIPIENT_SQL: &str = "NOT EXISTS (
            SELECT 1 FROM blocked_users b
            WHERE (b.blocker_id = fr.sender_id AND b.blocked_id = fr.receiver_id)
               OR (b.blocker_id = fr.receiver_id AND b.blocked_id = fr.sender_id)
          )";

// --- Handlers ---

/// List all friends for the current user
pub async fn list_friends(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let user_id = claims.sub;

    // Get all friends (user could be user1 or user2). Tombstoned accounts are
    // filtered (deletion purges the friends row, so this is belt-and-braces),
    // and so is a pair with a block in either direction: block_user now
    // dissolves the friendship, but rows from blocks made before 0.9.5 are
    // still on disk and must not keep rendering the blocker as a friend.
    let friends: Vec<(i64, String)> = sqlx::query_as(
        r#"
        SELECT
            CASE WHEN f.user1_id = $1 THEN f.user2_id ELSE f.user1_id END as friend_id,
            (replace(f.created_at::text, ' ', 'T') || 'Z') AS created_at
        FROM friends f
        JOIN users u ON u.id = CASE WHEN f.user1_id = $2 THEN f.user2_id ELSE f.user1_id END
            AND u.deleted_at IS NULL
        WHERE (f.user1_id = $3 OR f.user2_id = $4)
          AND NOT EXISTS (
            SELECT 1 FROM blocked_users b
            WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
               OR (b.blocker_id = u.id AND b.blocked_id = $1)
          )
        ORDER BY u.username ASC
        "#,
    )
    .bind(user_id)
    .bind(user_id)
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    // Get usernames and online status. Friends with "show online status" off
    // read as offline here too — hidden means hidden from everyone.
    let mut response: Vec<FriendResponse> = Vec::new();
    for (friend_id, created_at) in friends {
        let user: Option<(String, bool)> =
            sqlx::query_as("SELECT username, show_online_status FROM users WHERE id = $1")
                .bind(friend_id)
                .fetch_optional(&state.pool)
                .await
                .unwrap_or(None);

        if let Some((username, shows_online)) = user {
            let is_online = shows_online && state.is_user_visibly_online(friend_id);
            response.push(FriendResponse {
                id: friend_id,
                username,
                is_online,
                since: created_at,
            });
        }
    }

    Json(response)
}

/// Send a friend request
pub async fn send_friend_request(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<SendFriendRequestBody>,
) -> impl IntoResponse {
    let sender_id = claims.sub;
    let receiver_id = payload.user_id;

    // Can't friend yourself
    if sender_id == receiver_id {
        return (
            StatusCode::BAD_REQUEST,
            "Cannot send friend request to yourself",
        )
            .into_response();
    }

    // Check if user exists. A deleted account is a tombstone row (delete_account
    // anonymises rather than deletes), so `deleted_at IS NULL` is what makes it
    // answer exactly like an id that was never issued — the same filter every
    // DM-side helper carries. Without it a tombstone accepted the request and
    // echoed its `deleted#<id>` name back through the outgoing list.
    let user_exists: Option<(i32,)> =
        sqlx::query_as("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL")
            .bind(receiver_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    if user_exists.is_none() {
        return (StatusCode::NOT_FOUND, "User not found").into_response();
    }

    // A block in either direction does NOT refuse the request and does NOT
    // short-circuit it: the row is written by the same INSERT as for any
    // other pair, and every answer this handler gives is the one an unblocked
    // pair in the same state would get (see the visibility rule at the top of
    // this file). The lookup only decides which of the two pre-checks below
    // the caller is entitled to see the result of. Fail CLOSED on a lookup
    // error: write nothing, answer the same 500 every state gets on a DB
    // error. (The blocker sending to someone they blocked gets a hidden
    // request too; they know their own list.)
    let blocked = match pair_blocked(&state.pool, sender_id, receiver_id).await {
        Ok(b) => b,
        Err(e) => {
            tracing::error!("friend request: block lookup failed: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Could not verify block status").into_response();
        }
    };

    // Already friends? Only asked for an unblocked pair: block_user dissolves
    // the friendship, and the friends row a pre-0.9.5 block left behind is
    // hidden from list_friends and get_friendship_status, so a 409 "Already
    // friends" here for a pair the caller cannot see as friends would be the
    // block signal by another route. Fail CLOSED on error — do not write.
    if !blocked {
        let (u1, u2) = if sender_id < receiver_id {
            (sender_id, receiver_id)
        } else {
            (receiver_id, sender_id)
        };
        let already_friends: Option<(i32,)> = match sqlx::query_as(
            "SELECT 1 FROM friends WHERE user1_id = $1 AND user2_id = $2",
        )
        .bind(u1)
        .bind(u2)
        .fetch_optional(&state.pool)
        .await
        {
            Ok(row) => row,
            Err(e) => {
                tracing::error!("friend request: friendship lookup failed: {:?}", e);
                return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to send request").into_response();
            }
        };
        if already_friends.is_some() {
            return (StatusCode::CONFLICT, "Already friends").into_response();
        }
    }

    // A request already pending? The caller's OWN outgoing row always counts,
    // blocked or not — a repeat answers 409 exactly like any pending request,
    // which is the repeat the review used as its oracle. The REVERSE row
    // (them -> caller) counts only when the caller can see it: for a blocked
    // pair it is hidden from them, so it is treated as nonexistent and the
    // caller's own request is written alongside it. Fail CLOSED on error.
    let existing_request: Result<Option<(i64, String)>, sqlx::Error> = if blocked {
        sqlx::query_as(
            "SELECT id, status FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2",
        )
        .bind(sender_id)
        .bind(receiver_id)
        .fetch_optional(&state.pool)
        .await
    } else {
        sqlx::query_as(
            "SELECT id, status FROM friend_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $3 AND receiver_id = $4)"
        )
        .bind(sender_id)
        .bind(receiver_id)
        .bind(receiver_id)
        .bind(sender_id)
        .fetch_optional(&state.pool)
        .await
    };
    let existing_request = match existing_request {
        Ok(row) => row,
        Err(e) => {
            tracing::error!("friend request: pending lookup failed: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to send request").into_response();
        }
    };

    if let Some((_, status)) = existing_request {
        if status == "pending" {
            return (StatusCode::CONFLICT, "Friend request already pending").into_response();
        }
    }

    // Create the request. A prior (now-removed) friendship leaves an "accepted"
    // row here; without ON CONFLICT the insert violated the unique constraint and
    // 500'd, permanently blocking re-friending. Reuse the row and flip it back to
    // pending instead.
    let result = sqlx::query(
        "INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1, $2, 'pending') \
         ON CONFLICT (sender_id, receiver_id) DO UPDATE SET status = 'pending', created_at = NOW()",
    )
    .bind(sender_id)
    .bind(receiver_id)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => friend_request_created(),
        Err(e) => {
            tracing::error!("Failed to create friend request: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to send request").into_response()
        }
    }
}

/// The one answer POST /friends/request gives once it accepts the request:
/// a bare 201, no body. A blocked pair reaches the same INSERT and the same
/// answer as everyone else (there is no separate arm any more), and the
/// client's `sendFriendRequest` reads nothing but the status; this helper
/// keeps the shape pinned so a body can never be added to one path only.
fn friend_request_created() -> axum::response::Response {
    StatusCode::CREATED.into_response()
}

/// List incoming friend requests
pub async fn list_incoming_requests(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Requests across a block are hidden from the recipient (the rule at the
    // top of this file); a query error yields an empty list, which is the
    // fail-CLOSED reading — nothing shown that a blocker asked not to see.
    let sql = format!(
        r#"
        SELECT fr.id, fr.sender_id, u.username, (replace(fr.created_at::text, ' ', 'T') || 'Z') AS created_at
        FROM friend_requests fr
        JOIN users u ON u.id = fr.sender_id AND u.deleted_at IS NULL
        WHERE fr.receiver_id = $1 AND fr.status = 'pending'
          AND {NOT_HIDDEN_FROM_RECIPIENT_SQL}
        ORDER BY fr.created_at DESC
        "#
    );
    let requests: Vec<(i64, i64, String, String)> = sqlx::query_as(&sql)
        .bind(claims.sub)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

    let response: Vec<FriendRequestResponse> = requests
        .into_iter()
        .map(
            |(id, sender_id, sender_username, created_at)| FriendRequestResponse {
                id,
                sender_id,
                sender_username,
                created_at,
            },
        )
        .collect();

    Json(response)
}

/// List outgoing friend requests
pub async fn list_outgoing_requests(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Deliberately NO block filter: from the sender's side a request across a
    // block is a real pending request and must list exactly like one (the
    // rule at the top of this file).
    let requests: Vec<(i64, i64, String, String)> = sqlx::query_as(
        r#"
        SELECT fr.id, fr.receiver_id, u.username, (replace(fr.created_at::text, ' ', 'T') || 'Z') AS created_at
        FROM friend_requests fr
        JOIN users u ON u.id = fr.receiver_id AND u.deleted_at IS NULL
        WHERE fr.sender_id = $1 AND fr.status = 'pending'
        ORDER BY fr.created_at DESC
        "#
    )
    .bind(claims.sub)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let response: Vec<OutgoingRequestResponse> = requests
        .into_iter()
        .map(
            |(id, receiver_id, receiver_username, created_at)| OutgoingRequestResponse {
                id,
                receiver_id,
                receiver_username,
                created_at,
            },
        )
        .collect();

    Json(response)
}

/// Accept a friend request
pub async fn accept_request(
    State(state): State<Arc<AppState>>,
    Path(request_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Verify the request exists and is for this user
    let request: Option<(i64, i64)> = sqlx::query_as(
        "SELECT sender_id, receiver_id FROM friend_requests WHERE id = $1 AND receiver_id = $2 AND status = 'pending'"
    )
    .bind(request_id)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    let (sender_id, receiver_id) = match request {
        Some(r) => r,
        None => return (StatusCode::NOT_FOUND, "Request not found").into_response(),
    };

    // A request across a block does not exist for its recipient (the rule at
    // the top of this file): same 404 as an id that was never issued, so the
    // answer is not a block-status oracle and no friendship can be created
    // with a blocked pair. The ids are guessable (serial), so this must hold
    // for a recipient who probes ids they were never shown. Fails CLOSED.
    if hidden_from_recipient(&state.pool, sender_id, receiver_id).await {
        return (StatusCode::NOT_FOUND, "Request not found").into_response();
    }

    // Create friendship (lower ID = user1)
    let (u1, u2) = if sender_id < receiver_id {
        (sender_id, receiver_id)
    } else {
        (receiver_id, sender_id)
    };

    let friend_result = sqlx::query(
        "INSERT INTO friends (user1_id, user2_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(u1)
    .bind(u2)
    .execute(&state.pool)
    .await;

    if let Err(e) = friend_result {
        tracing::error!("Failed to create friendship: {:?}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to accept request",
        )
            .into_response();
    }

    // Update request status
    let _ = sqlx::query("UPDATE friend_requests SET status = 'accepted' WHERE id = $1")
        .bind(request_id)
        .execute(&state.pool)
        .await;

    StatusCode::OK.into_response()
}

/// Reject a friend request
pub async fn reject_request(
    State(state): State<Arc<AppState>>,
    Path(request_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Verify the request exists and is for this user
    let request: Option<(i64, i64)> = sqlx::query_as(
        "SELECT sender_id, receiver_id FROM friend_requests WHERE id = $1 AND receiver_id = $2 AND status = 'pending'",
    )
    .bind(request_id)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    let Some((sender_id, receiver_id)) = request else {
        return (StatusCode::NOT_FOUND, "Request not found").into_response();
    };

    // Same rule as accept_request: a request hidden from its recipient answers
    // like one that does not exist. A 200 here on a guessed id would tell the
    // recipient a blocked account had written to them.
    if hidden_from_recipient(&state.pool, sender_id, receiver_id).await {
        return (StatusCode::NOT_FOUND, "Request not found").into_response();
    }

    // Update status to rejected (or just delete it)
    let _ = sqlx::query("DELETE FROM friend_requests WHERE id = $1")
        .bind(request_id)
        .execute(&state.pool)
        .await;

    StatusCode::OK.into_response()
}

/// Remove a friend
pub async fn remove_friend(
    State(state): State<Arc<AppState>>,
    Path(friend_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let user_id = claims.sub;
    let (u1, u2) = if user_id < friend_id {
        (user_id, friend_id)
    } else {
        (friend_id, user_id)
    };

    // Also clear the friend_requests row(s) so the relationship fully resets —
    // otherwise a stale "accepted" row lingers and a future re-friend hits the
    // unique constraint.
    let _ = sqlx::query(
        "DELETE FROM friend_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)"
    )
    .bind(user_id)
    .bind(friend_id)
    .execute(&state.pool)
    .await;

    let result = sqlx::query("DELETE FROM friends WHERE user1_id = $1 AND user2_id = $2")
        .bind(u1)
        .bind(u2)
        .execute(&state.pool)
        .await;

    // A device share can only be CREATED between friends; letting one stand
    // after the friendship ends would be standing access with no relationship
    // behind it. Revoke both directions and end any live session.
    crate::device_handlers::revoke_shares_between(&state, user_id, friend_id).await;

    match result {
        Ok(r) if r.rows_affected() > 0 => StatusCode::OK.into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, "Friendship not found").into_response(),
        Err(e) => {
            tracing::error!("Failed to remove friend: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to remove friend").into_response()
        }
    }
}

/// Get friendship status with a specific user
pub async fn get_friendship_status(
    State(state): State<Arc<AppState>>,
    Path(other_user_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let user_id = claims.sub;
    let (u1, u2) = if user_id < other_user_id {
        (user_id, other_user_id)
    } else {
        (other_user_id, user_id)
    };

    // Check if friends. A block in either direction reads as not friends even
    // if a friends row is still on disk (blocks made before 0.9.5 left it) —
    // same rule as list_friends, so the two cannot disagree.
    let is_friend: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM friends WHERE user1_id = $1 AND user2_id = $2 \
         AND NOT EXISTS (SELECT 1 FROM blocked_users b \
             WHERE (b.blocker_id = $1 AND b.blocked_id = $2) \
                OR (b.blocker_id = $2 AND b.blocked_id = $1))",
    )
    .bind(u1)
    .bind(u2)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if is_friend.is_some() {
        return Json(FriendshipStatus {
            is_friend: true,
            request_sent: false,
            request_received: false,
            request_id: None,
        })
        .into_response();
    }

    // Check for a pending request the caller SENT. No block filter: from the
    // sender's side a request across a block is a real pending request (the
    // rule at the top of this file), so `request_sent` reads true for it
    // exactly as for any other.
    let sent_request: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'"
    )
    .bind(user_id)
    .bind(other_user_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if sent_request.is_some() {
        return Json(FriendshipStatus {
            is_friend: false,
            request_sent: true,
            request_received: false,
            request_id: sent_request.map(|r| r.0 as i64),
        })
        .into_response();
    }

    // A pending request the caller RECEIVED: hidden when the pair is blocked,
    // so `request_received` and `request_id` read exactly as if it had never
    // been sent. Fails CLOSED (a failed lookup hides).
    let mut received_request: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'"
    )
    .bind(other_user_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if received_request.is_some() && hidden_from_recipient(&state.pool, other_user_id, user_id).await {
        received_request = None;
    }

    Json(FriendshipStatus {
        is_friend: false,
        request_sent: false,
        request_received: received_request.is_some(),
        request_id: received_request.map(|r| r.0 as i64),
    })
    .into_response()
}

#[cfg(test)]
mod silent_block_tests {
    use super::*;

    /// r2-1-L1-03: the client's `sendFriendRequest` is `Promise<void>` and reads
    /// nothing but the status, so the contract the accepted answer must meet
    /// is "201, empty body". A blocked pair now takes the same INSERT path as
    /// everyone else, so there is no second arm to drift; this pins the shape
    /// against one being reintroduced with a body.
    #[tokio::test]
    async fn accepted_answer_is_a_bare_201() {
        let resp = friend_request_created();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
        assert!(body.is_empty(), "{body:?}");
    }

    /// Positive control for the assertion above: a refusal built the way the
    /// handler's other arms build theirs does carry a body, so the empty-body
    /// check is not vacuous.
    #[tokio::test]
    async fn a_refusal_is_not_a_bare_201() {
        let resp = (StatusCode::NOT_FOUND, "User not found").into_response();
        assert_ne!(resp.status(), StatusCode::CREATED);
        let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
        assert!(!body.is_empty());
    }

    /// Finding 11: the recipient-side decision. Unblocked shows, blocked
    /// hides, and a lookup that could not be made hides too (fail CLOSED).
    #[test]
    fn hidden_on_hides_when_blocked_or_unknown() {
        assert!(!hidden_on::<sqlx::Error>(Ok(false)), "unblocked pair must show");
        assert!(hidden_on::<sqlx::Error>(Ok(true)), "blocked pair must hide");
        assert!(
            hidden_on(Err(sqlx::Error::PoolClosed)),
            "a failed block lookup must hide, never show"
        );
    }

    /// The list-side rule must name both directions of the block, or the
    /// incoming list and the single-request helper (which asks
    /// `(blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`)
    /// would disagree on who a request is hidden from.
    #[test]
    fn list_rule_covers_both_block_directions() {
        let sql = NOT_HIDDEN_FROM_RECIPIENT_SQL;
        assert!(sql.starts_with("NOT EXISTS"));
        assert!(sql.contains("b.blocker_id = fr.sender_id AND b.blocked_id = fr.receiver_id"));
        assert!(sql.contains("b.blocker_id = fr.receiver_id AND b.blocked_id = fr.sender_id"));
    }
}
