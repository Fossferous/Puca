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

// --- Handlers ---

/// List all friends for the current user
pub async fn list_friends(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let user_id = claims.sub;

    // Get all friends (user could be user1 or user2)
    let friends: Vec<(i64, String)> = sqlx::query_as(
        r#"
        SELECT
            CASE WHEN f.user1_id = $1 THEN f.user2_id ELSE f.user1_id END as friend_id,
            (replace(f.created_at::text, ' ', 'T') || 'Z') AS created_at
        FROM friends f
        JOIN users u ON u.id = CASE WHEN f.user1_id = $2 THEN f.user2_id ELSE f.user1_id END
        WHERE f.user1_id = $3 OR f.user2_id = $4
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

    // Check if user exists
    let user_exists: Option<(i32,)> = sqlx::query_as("SELECT id FROM users WHERE id = $1")
        .bind(receiver_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);

    if user_exists.is_none() {
        return (StatusCode::NOT_FOUND, "User not found").into_response();
    }

    // A block in either direction refuses the request — same bidirectional rule
    // as every DM path (a blocked user must not be able to reach the blocker
    // through the friend system, and a blocker shouldn't accidentally invite
    // someone they blocked). Deliberately doesn't reveal which direction.
    // Widths matched to this SQL text's other users (dm_handlers, ws — both
    // i32; the columns are INT4). See the 22P03 note in device_token.rs.
    let blocked: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM blocked_users WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)"
    )
    .bind(sender_id as i32)
    .bind(receiver_id as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    if blocked.is_some() {
        return (
            StatusCode::FORBIDDEN,
            "You cannot send a friend request to this user",
        )
            .into_response();
    }

    // Check if already friends
    let (u1, u2) = if sender_id < receiver_id {
        (sender_id, receiver_id)
    } else {
        (receiver_id, sender_id)
    };
    let already_friends: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM friends WHERE user1_id = $1 AND user2_id = $2")
            .bind(u1)
            .bind(u2)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    if already_friends.is_some() {
        return (StatusCode::CONFLICT, "Already friends").into_response();
    }

    // Check if request already exists (either direction)
    let existing_request: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, status FROM friend_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $3 AND receiver_id = $4)"
    )
    .bind(sender_id)
    .bind(receiver_id)
    .bind(receiver_id)
    .bind(sender_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

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
        Ok(_) => StatusCode::CREATED.into_response(),
        Err(e) => {
            tracing::error!("Failed to create friend request: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to send request").into_response()
        }
    }
}

/// List incoming friend requests
pub async fn list_incoming_requests(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let requests: Vec<(i64, i64, String, String)> = sqlx::query_as(
        r#"
        SELECT fr.id, fr.sender_id, u.username, (replace(fr.created_at::text, ' ', 'T') || 'Z') AS created_at
        FROM friend_requests fr
        JOIN users u ON u.id = fr.sender_id
        WHERE fr.receiver_id = $1 AND fr.status = 'pending'
        ORDER BY fr.created_at DESC
        "#
    )
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
    let requests: Vec<(i64, i64, String, String)> = sqlx::query_as(
        r#"
        SELECT fr.id, fr.receiver_id, u.username, (replace(fr.created_at::text, ' ', 'T') || 'Z') AS created_at
        FROM friend_requests fr
        JOIN users u ON u.id = fr.receiver_id
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

    // A PENDING request from before a block would otherwise still be
    // acceptable, silently creating a friendship with a blocked pair — the
    // same bidirectional rule as send_friend_request, enforced at accept time.
    // Widths matched to this SQL text's other users (dm_handlers, ws — both
    // i32; the columns are INT4). See the 22P03 note in device_token.rs.
    let blocked: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM blocked_users WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)"
    )
    .bind(sender_id as i32)
    .bind(receiver_id as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    if blocked.is_some() {
        return (
            StatusCode::FORBIDDEN,
            "You cannot accept this friend request",
        )
            .into_response();
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
    let request: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM friend_requests WHERE id = $1 AND receiver_id = $2 AND status = 'pending'",
    )
    .bind(request_id)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if request.is_none() {
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

    // Check if friends
    let is_friend: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM friends WHERE user1_id = $1 AND user2_id = $2")
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

    // Check for pending request (either direction)
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

    let received_request: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'"
    )
    .bind(other_user_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    Json(FriendshipStatus {
        is_friend: false,
        request_sent: false,
        request_received: received_request.is_some(),
        request_id: received_request.map(|r| r.0 as i64),
    })
    .into_response()
}
