use axum::{
    extract::{Json, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::Claims;
use crate::permissions::{user_has_permission, Permissions};
use crate::protocol::ServerMessage;
use crate::state::AppState;

// --- DTOs ---

/// Max chars for a moderation reason. kick/ban/timeout reasons are written to
/// `audit_log.details` (TEXT, uncapped in the schema) and shown to every admin
/// reading the log — an unbounded reason is a storage/UI amplification lever.
pub(crate) const MAX_REASON_LEN: usize = 1000;

/// True if an optional moderation reason is within the length cap (None is fine).
pub(crate) fn reason_within_cap(reason: &Option<String>) -> bool {
    reason.as_ref().map_or(true, |r| r.chars().count() <= MAX_REASON_LEN)
}

#[derive(Deserialize)]
pub struct KickBanRequest {
    pub reason: Option<String>,
}

#[derive(Serialize)]
pub struct BanResponse {
    pub user_id: i64,
    pub username: String,
    pub reason: Option<String>,
    pub banned_at: String,
}

#[derive(Deserialize)]
pub struct TimeoutRequest {
    pub duration_seconds: i64,
    pub reason: Option<String>,
}

#[derive(Serialize)]
pub struct BlockedUserResponse {
    pub user_id: i64,
    pub username: String,
    pub blocked_at: String,
}

#[derive(Serialize)]
pub struct AuditLogEntry {
    pub id: i64,
    pub action_type: String,
    pub actor_id: i64,
    pub actor_username: Option<String>,
    pub target_id: Option<i64>,
    pub target_type: Option<String>,
    pub details: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize)]
pub struct AuditQuery {
    #[serde(default)]
    pub limit: Option<i32>,
    #[serde(default)]
    pub action_type: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateReportRequest {
    pub reported_user_id: Option<i64>,
    pub reported_message_id: Option<String>,
    pub report_type: String, // 'spam', 'harassment', 'inappropriate', 'other'
    pub reason: String,
}

#[derive(Deserialize)]
pub struct ResolveReportRequest {
    pub status: String, // 'resolved', 'dismissed'
    pub notes: Option<String>,
}

#[derive(Serialize)]
pub struct ReportResponse {
    pub id: i64,
    pub reporter_id: i64,
    pub reporter_username: Option<String>,
    pub reported_user_id: Option<i64>,
    pub reported_username: Option<String>,
    pub reported_message_id: Option<String>,
    pub report_type: String,
    pub reason: String,
    pub status: String,
    pub resolved_by: Option<i64>,
    pub resolution_notes: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Deserialize)]
pub struct ReportsQuery {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub limit: Option<i32>,
}

// --- Kick/Ban Handlers ---

/// Kick a member from a server
pub async fn kick_member(
    State(state): State<Arc<AppState>>,
    Path((server_id, user_id)): Path<(String, i64)>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<KickBanRequest>,
) -> impl IntoResponse {
    // Check permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::KICK_MEMBERS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing KICK_MEMBERS permission").into_response();
    }

    if !reason_within_cap(&payload.reason) {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Reason too long").into_response();
    }

    // Prevent kicking self or server owner
    let owner: Option<(i32,)> = sqlx::query_as("SELECT owner_id FROM servers WHERE id = $1")
        .bind(&server_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);

    if let Some((owner_id,)) = owner {
        if user_id == owner_id as i64 {
            return (StatusCode::FORBIDDEN, "Cannot kick server owner").into_response();
        }
    }

    if user_id == claims.sub {
        return (StatusCode::BAD_REQUEST, "Cannot kick yourself").into_response();
    }

    // Role hierarchy: a KICK_MEMBERS holder may only kick members ranked below
    // them, never an administrator or an equal-ranked moderator. (Owner is
    // already handled above; can_moderate re-covers it defensively.)
    if !crate::permissions::can_moderate(&state.pool, &server_id, claims.sub, user_id).await {
        return (
            StatusCode::FORBIDDEN,
            "Cannot kick a member ranked at or above you",
        )
            .into_response();
    }

    // Purge role assignments first so no permissions linger after removal
    // (matches leave_server; defense in depth on top of the membership gate in
    // get_user_server_permissions).
    //
    // `user_id::bigint = $2`, NOT `user_id = $2`. Two reasons, both load-bearing:
    //
    // 1. The bind stays i64 deliberately — casting the id to i32 in Rust makes
    //    the owner guard above bypassable (`owner_id + 2^32` compares unequal as
    //    an i64 so the guard passes, then wraps back to owner_id in the query).
    //    See the same note on set_member_custom_sounds.
    // 2. leave_server (server_handlers.rs) runs the BYTE-IDENTICAL SQL text but
    //    binds i32. sqlx caches prepared statements per connection keyed by that
    //    text, so whichever ran first pinned the parameter type and the other
    //    then failed with 22P03 "incorrect binary data format in bind parameter
    //    2" — an intermittent 500 on kick/ban depending only on which pooled
    //    connection served the request (and on whether anyone had left a server
    //    on it recently). The cast fixes the comparison to int8 = int8 AND makes
    //    the statement text distinct, so the two can no longer collide.
    let _ = sqlx::query("DELETE FROM member_roles WHERE server_id = $1 AND user_id::bigint = $2")
        .bind(&server_id)
        .bind(user_id)
        .execute(&state.pool)
        .await;

    // Remove from server_members
    let result = sqlx::query("DELETE FROM server_members WHERE server_id = $1 AND user_id::bigint = $2")
        .bind(&server_id)
        .bind(user_id)
        .execute(&state.pool)
        .await;

    match result {
        Ok(r) if r.rows_affected() > 0 => {
            tracing::info!(
                "User {} kicked from server {} by {} (reason: {:?})",
                user_id,
                server_id,
                claims.sub,
                payload.reason
            );
            log_audit_action(
                &state.pool,
                &server_id,
                "kick",
                claims.sub,
                Some(user_id),
                Some("user"),
                payload.reason.as_deref(),
            )
            .await;
            // Boot the kicked user's client out of the server in real time.
            state.send_to_user(
                user_id,
                ServerMessage::RemovedFromServer {
                    server_id: server_id.clone(),
                },
            );
            // Server-side force-evict from any live voice room (mesh AND SFU) —
            // the now-non-member fails VIEW everywhere, so this cuts off their
            // media immediately rather than trusting the client to disconnect.
            crate::ws::broadcast_perms_changed_and_evict(&state, &server_id).await;
            StatusCode::OK.into_response()
        }
        Ok(_) => (StatusCode::NOT_FOUND, "User not found in server").into_response(),
        Err(e) => {
            tracing::error!("Failed to kick member: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to kick member").into_response()
        }
    }
}

/// Ban a member from a server
pub async fn ban_member(
    State(state): State<Arc<AppState>>,
    Path((server_id, user_id)): Path<(String, i64)>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<KickBanRequest>,
) -> impl IntoResponse {
    // Check permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::BAN_MEMBERS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing BAN_MEMBERS permission").into_response();
    }

    if !reason_within_cap(&payload.reason) {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Reason too long").into_response();
    }

    // Prevent banning self or server owner
    let owner: Option<(i32,)> = sqlx::query_as("SELECT owner_id FROM servers WHERE id = $1")
        .bind(&server_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);

    if let Some((owner_id,)) = owner {
        if user_id == owner_id as i64 {
            return (StatusCode::FORBIDDEN, "Cannot ban server owner").into_response();
        }
    }

    if user_id == claims.sub {
        return (StatusCode::BAD_REQUEST, "Cannot ban yourself").into_response();
    }

    // Role hierarchy: a BAN_MEMBERS holder may only ban members ranked below
    // them, never an administrator or an equal-ranked moderator.
    if !crate::permissions::can_moderate(&state.pool, &server_id, claims.sub, user_id).await {
        return (
            StatusCode::FORBIDDEN,
            "Cannot ban a member ranked at or above you",
        )
            .into_response();
    }

    // Add to bans
    let ban_result = sqlx::query(
        "INSERT INTO bans (server_id, user_id, banned_by, reason) VALUES ($1, $2, $3, $4) ON CONFLICT (server_id, user_id) DO UPDATE SET banned_by = EXCLUDED.banned_by, reason = EXCLUDED.reason"
    )
        .bind(&server_id)
        .bind(user_id)
        .bind(claims.sub as i32)
        .bind(&payload.reason)
        .execute(&state.pool)
        .await;

    if ban_result.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create ban").into_response();
    }

    // Purge role assignments so no permissions linger after removal.
    let _ = sqlx::query("DELETE FROM member_roles WHERE server_id = $1 AND user_id::bigint = $2")
        .bind(&server_id)
        .bind(user_id)
        .execute(&state.pool)
        .await;

    // Remove from server_members
    let _ = sqlx::query("DELETE FROM server_members WHERE server_id = $1 AND user_id::bigint = $2")
        .bind(&server_id)
        .bind(user_id)
        .execute(&state.pool)
        .await;

    tracing::info!(
        "User {} banned from server {} by {} (reason: {:?})",
        user_id,
        server_id,
        claims.sub,
        payload.reason
    );
    log_audit_action(
        &state.pool,
        &server_id,
        "ban",
        claims.sub,
        Some(user_id),
        Some("user"),
        payload.reason.as_deref(),
    )
    .await;
    // Boot the banned user's client out of the server in real time.
    state.send_to_user(
        user_id,
        ServerMessage::RemovedFromServer {
            server_id: server_id.clone(),
        },
    );
    // Force-evict from any live voice room (mesh AND SFU) server-side.
    crate::ws::broadcast_perms_changed_and_evict(&state, &server_id).await;
    StatusCode::OK.into_response()
}

/// Unban a member
pub async fn unban_member(
    State(state): State<Arc<AppState>>,
    Path((server_id, user_id)): Path<(String, i64)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Check permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::BAN_MEMBERS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing BAN_MEMBERS permission").into_response();
    }

    let result = sqlx::query("DELETE FROM bans WHERE server_id = $1 AND user_id = $2")
        .bind(&server_id)
        .bind(user_id)
        .execute(&state.pool)
        .await;

    match result {
        Ok(r) if r.rows_affected() > 0 => StatusCode::OK.into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, "Ban not found").into_response(),
        Err(e) => {
            tracing::error!("Failed to unban: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to unban").into_response()
        }
    }
}

/// List bans for a server
pub async fn list_bans(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Check permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::BAN_MEMBERS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing BAN_MEMBERS permission").into_response();
    }

    // bans.user_id is INT4 — decode as i32 (i64 would make query_as error, which
    // .unwrap_or_default() silently turns into an empty ban list).
    let bans: Vec<(i32, String, Option<String>, String)> = sqlx::query_as(
        r#"
        SELECT b.user_id, u.username, b.reason, (replace(b.created_at::text, ' ', 'T') || 'Z') AS created_at
        FROM bans b
        JOIN users u ON b.user_id = u.id
        WHERE b.server_id = $1
        ORDER BY b.created_at DESC
        "#
    )
        .bind(&server_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

    let response: Vec<BanResponse> = bans
        .into_iter()
        .map(|(user_id, username, reason, banned_at)| BanResponse {
            user_id: user_id as i64,
            username,
            reason,
            banned_at,
        })
        .collect();

    Json(response).into_response()
}

// --- Member Timeout ---

/// Max member-timeout duration (28 days). Bounds the value that reaches
/// chrono::Duration, which panics on enormous inputs.
const MAX_TIMEOUT_SECONDS: i64 = 28 * 24 * 60 * 60;

/// Whether a timeout duration is in the accepted range. Anything outside
/// 1..=28d is rejected before it can panic chrono's Duration/DateTime math.
pub(crate) fn valid_timeout_seconds(seconds: i64) -> bool {
    (1..=MAX_TIMEOUT_SECONDS).contains(&seconds)
}

/// Timeout a member (prevent sending messages temporarily)
pub async fn timeout_member(
    State(state): State<Arc<AppState>>,
    Path((server_id, user_id)): Path<(String, i64)>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<TimeoutRequest>,
) -> impl IntoResponse {
    // Check permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::KICK_MEMBERS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing moderation permission").into_response();
    }

    if !reason_within_cap(&payload.reason) {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Reason too long").into_response();
    }

    // Role hierarchy (this handler had NONE — not even an owner check, so a bare
    // KICK_MEMBERS holder could time out, and thereby silence, the server owner
    // or any administrator). can_moderate refuses acting on the owner, on a
    // higher-or-equal-ranked member, and on yourself.
    if !crate::permissions::can_moderate(&state.pool, &server_id, claims.sub, user_id).await {
        return (
            StatusCode::FORBIDDEN,
            "Cannot time out a member ranked at or above you",
        )
            .into_response();
    }

    // Bound the duration to a sane range BEFORE building the Duration.
    // chrono::Duration::seconds panics for enormous values, and adding an
    // over-large Duration to `now` overflows chrono's DateTime (year > 262143)
    // and also panics — so `duration_seconds: i64::MAX` in the body crashed the
    // request task. 1 second .. 28 days covers every real timeout.
    if !valid_timeout_seconds(payload.duration_seconds) {
        return (
            StatusCode::BAD_REQUEST,
            "duration_seconds out of range (1..=2419200)",
        )
            .into_response();
    }
    let expires_at = match chrono::Utc::now()
        .checked_add_signed(chrono::Duration::seconds(payload.duration_seconds))
    {
        Some(t) => t,
        None => return (StatusCode::BAD_REQUEST, "duration_seconds out of range").into_response(),
    };

    // expires_at is bound as an RFC3339 string — cast it to timestamptz in SQL
    // (binding text into the timestamp column raises 42804 and made every
    // timeout attempt 500, so the feature never worked).
    let result = sqlx::query(
        "INSERT INTO member_timeouts (server_id, user_id, expires_at, reason, timed_out_by) VALUES ($1, $2, $3::timestamptz, $4, $5) ON CONFLICT (server_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason, timed_out_by = EXCLUDED.timed_out_by"
    )
    .bind(&server_id)
    .bind(user_id)
    .bind(expires_at.to_rfc3339())
    .bind(&payload.reason)
    .bind(claims.sub as i32)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to timeout member: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to timeout member",
            )
                .into_response()
        }
    }
}

/// Enable/disable a member's custom join/leave sounds in THIS server.
/// Gated on MUTE_MEMBERS — the existing "silence this person in voice" bit.
/// Suppression is enforced where the sound ids are SERVED (members-with-roles
/// nulls them for a disabled member), so clients never learn the ids at all.
pub async fn set_member_custom_sounds(
    State(state): State<Arc<AppState>>,
    Path((server_id, user_id)): Path<(String, i64)>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<SetCustomSoundsRequest>,
) -> impl IntoResponse {
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MUTE_MEMBERS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing moderation permission").into_response();
    }
    // The owner is not moderatable, mirroring kick/ban.
    let owner: Option<(i32,)> = sqlx::query_as("SELECT owner_id FROM servers WHERE id = $1")
        .bind(&server_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
    if owner.map(|(o,)| o as i64) == Some(user_id) {
        return (StatusCode::FORBIDDEN, "Cannot moderate the server owner").into_response();
    }
    let result = sqlx::query(
        "UPDATE server_members SET custom_sounds_disabled = $1 WHERE server_id = $2 AND user_id = $3"
    )
    .bind(payload.disabled)
    .bind(&server_id)
    // Bind as i64, NOT `as i32`. Truncation made the owner guard above
    // bypassable: `owner_id + 2^32` compares unequal to owner_id as an i64,
    // so the guard passed, but the cast wrapped it back to the owner's id and
    // the UPDATE hit their row. kick_member/ban_member bind i64 for exactly
    // this reason — an out-of-range id then matches nothing (404).
    .bind(user_id)
    .execute(&state.pool)
    .await;
    match result {
        Ok(r) if r.rows_affected() > 0 => StatusCode::OK.into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, "Not a member of this server").into_response(),
        Err(e) => {
            tracing::error!("Failed to set custom_sounds_disabled: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to update member").into_response()
        }
    }
}

#[derive(serde::Deserialize)]
pub struct SetCustomSoundsRequest {
    pub disabled: bool,
}

/// Remove timeout from a member
pub async fn remove_timeout(
    State(state): State<Arc<AppState>>,
    Path((server_id, user_id)): Path<(String, i64)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::KICK_MEMBERS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing moderation permission").into_response();
    }

    let result = sqlx::query("DELETE FROM member_timeouts WHERE server_id = $1 AND user_id = $2")
        .bind(&server_id)
        .bind(user_id)
        .execute(&state.pool)
        .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to remove timeout: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to remove timeout",
            )
                .into_response()
        }
    }
}

// --- Blocked Users ---

/// Block a user
pub async fn block_user(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    if user_id == claims.sub {
        return (StatusCode::BAD_REQUEST, "Cannot block yourself").into_response();
    }

    let result = sqlx::query(
        "INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(claims.sub as i32)
    .bind(user_id)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => {
            // Blocking must cut off any device share between the two — a share
            // outliving a block is exactly the harassment vector the block is
            // for. Both directions, live sessions ended. (The connect gate
            // also refuses a blocked pair, so this need not be transactional.)
            crate::device_handlers::revoke_shares_between(&state, claims.sub, user_id).await;
            StatusCode::OK.into_response()
        }
        Err(e) => {
            tracing::error!("Failed to block user: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to block user").into_response()
        }
    }
}

/// Unblock a user
pub async fn unblock_user(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let result = sqlx::query("DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2")
        .bind(claims.sub as i32)
        .bind(user_id)
        .execute(&state.pool)
        .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to unblock user: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to unblock user").into_response()
        }
    }
}

/// List blocked users
pub async fn list_blocked_users(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // blocked_id is INT4 (decode as i32) and created_at is a timestamp (cast ::text).
    // A DB error must be a 500, NOT an empty list: this list is the ONLY
    // unblock affordance in the UI, so an error masquerading as "you haven't
    // blocked anyone" makes a live block unremovable while DMs stay refused.
    let blocked: Vec<(i32, String, String)> = match sqlx::query_as(
        r#"
        SELECT b.blocked_id, u.username, (replace(b.created_at::text, ' ', 'T') || 'Z') AS created_at
        FROM blocked_users b
        JOIN users u ON b.blocked_id = u.id
        WHERE b.blocker_id = $1
        "#
    )
    .bind(claims.sub as i32)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("list_blocked_users query failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to load blocked users").into_response();
        }
    };

    let response: Vec<BlockedUserResponse> = blocked
        .into_iter()
        .map(|(user_id, username, blocked_at)| {
            let user_id = user_id as i64;
            BlockedUserResponse {
                user_id,
                username,
                blocked_at,
            }
        })
        .collect();

    Json(response).into_response()
}

// --- Voice moderation ---

#[derive(Deserialize)]
pub struct VoiceMoveRequest {
    /// Destination voice channel, or `null` to disconnect them from voice
    /// entirely. Mirrors the way the client models it: a disconnect is a move
    /// to nowhere, so one route and one permission govern both.
    pub channel_id: Option<i64>,
}

/// Move a member to another voice channel, or (`channel_id: null`) disconnect
/// them from voice.
///
/// Touches NO database rows. That is the whole point of the disconnect half:
/// the member keeps their server membership, their roles and their access, so
/// they can rejoin the instant they like. A kick from the SERVER is a
/// different, much heavier action and lives at `kick_member`.
pub async fn move_member_voice(
    State(state): State<Arc<AppState>>,
    Path((server_id, user_id)): Path<(String, i64)>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<VoiceMoveRequest>,
) -> impl IntoResponse {
    // MOVE_MEMBERS governs both halves, following the usual voice-moderation convention. Owners and
    // administrators pass automatically (get_user_server_permissions resolves
    // an owner to ADMINISTRATOR, and Permissions::has bypasses on it).
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MOVE_MEMBERS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MOVE_MEMBERS permission").into_response();
    }

    if user_id == claims.sub {
        // Not a permission failure — there is simply a better way to do it.
        return (
            StatusCode::BAD_REQUEST,
            "Use the channel list to move yourself",
        )
            .into_response();
    }

    // Rank hierarchy, exactly as kick/ban: never act on the owner, an
    // administrator, or an equal-ranked moderator.
    if !crate::permissions::can_moderate(&state.pool, &server_id, claims.sub, user_id).await {
        return (
            StatusCode::FORBIDDEN,
            "Cannot move a member ranked at or above you",
        )
            .into_response();
    }

    // Where are they now? Voice exclusivity guarantees at most one room.
    let Some((from_room, from_channel_id)) = crate::ws::current_voice_room(&state, user_id) else {
        return (StatusCode::CONFLICT, "That member is not in a voice channel").into_response();
    };

    // The room they occupy must belong to the server this request is scoped to.
    // Without this check a moderator of server A could reach into a call on
    // server B — their MOVE_MEMBERS on A says nothing about B, and the
    // `from_room` we found is global across every server.
    //
    // NOT `.unwrap_or(None)`. Collapsing a query ERROR into "no such channel"
    // makes a broken query indistinguishable from a real miss — which is
    // precisely how a misnamed column in the destination lookup below turned
    // every move into a 404 instead of failing loudly. A DB error is a 500.
    let source = match sqlx::query_as::<_, (Option<String>, bool)>(
        "SELECT server_id, COALESCE(is_afk, false) FROM channels WHERE id = $1",
    )
    .bind(from_channel_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            tracing::error!(
                "voice move: source channel {} lookup failed: {:?}",
                from_channel_id,
                e
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not resolve the source channel",
            )
                .into_response();
        }
    };
    let Some((Some(source_server), source_is_afk)) = source else {
        return (StatusCode::CONFLICT, "That member is not in a voice channel").into_response();
    };
    if source_server != server_id {
        return (
            StatusCode::FORBIDDEN,
            "That member is in a voice channel on another server",
        )
            .into_response();
    }

    let Some(to_channel_id) = payload.channel_id else {
        // --- Disconnect ---------------------------------------------------
        // Allowed out of AFK: this drops them OUT of voice rather than pulling
        // them into a live channel, so the rule below does not apply.
        let dropped = crate::ws::evict_user_from_voice_room(
            &state,
            &from_room,
            user_id,
            true, // enforce: cut the SFU publication, don't just ask
            crate::ws::SelfNotice::Gone,
        )
        .await;
        if !dropped {
            // They left between the room lookup and here — same outcome the
            // caller wanted, but nothing was done, so say so rather than
            // logging a disconnect that never happened.
            return (StatusCode::CONFLICT, "That member is not in a voice channel").into_response();
        }
        tracing::info!(
            "Voice disconnect: user {} removed from {} by {}",
            user_id,
            from_room,
            claims.sub
        );
        log_audit_action(
            &state.pool,
            &server_id,
            "voice_disconnect",
            claims.sub,
            Some(user_id),
            Some("user"),
            None,
        )
        .await;
        return StatusCode::OK.into_response();
    };

    // --- Move ---------------------------------------------------------------
    if to_channel_id == from_channel_id {
        return (
            StatusCode::BAD_REQUEST,
            "That member is already in that channel",
        )
            .into_response();
    }

    // Nobody is dragged OUT of AFK. AFK is a holding pen you leave under your
    // own steam — anyone parked there can click any channel and walk out — so
    // this is deliberate policy about the moderator's gesture, not a lock.
    // Enforced here rather than only in the drag UI because the context menu is
    // a second entry point and the two must not be able to disagree.
    // Disconnecting someone FROM AFK stays allowed (handled above).
    if source_is_afk {
        return (
            StatusCode::FORBIDDEN,
            "Members can't be moved out of the AFK channel",
        )
            .into_response();
    }

    // Destination must be a voice channel on this same server.
    //
    // The column is `type`, NOT `channel_type` — that is the API's field name,
    // not the schema's (migrations/001_init.sql:72). Naming it wrong here made
    // the query fail, `.unwrap_or(None)` turned the failure into None, and
    // every single move answered "Destination channel not found" while the
    // disconnect half worked perfectly. Hence the explicit error arm.
    let dest = match sqlx::query_as::<_, (Option<String>, i32)>(
        "SELECT server_id, type FROM channels WHERE id = $1",
    )
    .bind(to_channel_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            tracing::error!(
                "voice move: destination channel {} lookup failed: {:?}",
                to_channel_id,
                e
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not resolve the destination channel",
            )
                .into_response();
        }
    };
    let Some((Some(dest_server), dest_type)) = dest else {
        return (StatusCode::NOT_FOUND, "Destination channel not found").into_response();
    };
    if dest_server != server_id || dest_type != 1 {
        return (
            StatusCode::BAD_REQUEST,
            "Destination is not a voice channel on this server",
        )
            .into_response();
    }

    // The TARGET's own access decides where they may be put — VIEW_CHANNEL and
    // CONNECT, the same pair JoinRoom enforces. Skipping this would let a
    // moderator shove someone into a channel whose JoinRoom then rejects them,
    // which reads to everyone as "the move silently did nothing" while actually
    // having dropped them out of voice.
    let target_allowed = matches!(
        crate::permissions::get_user_channel_permissions(&state.pool, to_channel_id, user_id).await,
        crate::permissions::ChannelPermAccess::Allowed { perms, .. }
            if perms.has(Permissions::VIEW_CHANNEL) && perms.has(Permissions::CONNECT)
    );
    if !target_allowed {
        return (
            StatusCode::FORBIDDEN,
            "That member can't join the destination channel",
        )
            .into_response();
    }

    // From the DATABASE, not `state.get_username`: that reads the live WS
    // session map, so a moderator acting without an open socket became the
    // literal string "A moderator" in the moved user's toast. Falls back to the
    // session map, then to a generic label, so the notice always says something.
    let moved_by = sqlx::query_as::<_, (Option<String>, String)>(
        "SELECT display_name, username FROM users WHERE id = $1",
    )
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
    .map(|(display, username)| display.unwrap_or(username))
    .or_else(|| state.get_username(claims.sub))
    .unwrap_or_else(|| "A moderator".to_string());

    // Remove them from the old room authoritatively FIRST, then direct them to
    // the new one. A client that ignores the directive is left disconnected,
    // never still talking in the channel a moderator just moved them out of.
    //
    // The return value matters: they can have left voice between the room
    // lookup above and here, in which case nothing was evicted and nothing was
    // sent. Reporting 200 and writing an audit row for that would record a move
    // that never happened.
    let moved = crate::ws::evict_user_from_voice_room(
        &state,
        &from_room,
        user_id,
        true, // enforce: cut the SFU publication in the room they are leaving
        crate::ws::SelfNotice::MoveTo {
            server_id: server_id.clone(),
            channel_id: to_channel_id,
            from_channel_id,
            moved_by,
        },
    )
    .await;
    if !moved {
        return (
            StatusCode::CONFLICT,
            "That member left the voice channel before the move",
        )
            .into_response();
    }

    tracing::info!(
        "Voice move: user {} moved from channel {} to {} by {}",
        user_id,
        from_channel_id,
        to_channel_id,
        claims.sub
    );
    log_audit_action(
        &state.pool,
        &server_id,
        "voice_move",
        claims.sub,
        Some(user_id),
        Some("user"),
        Some(&format!("{from_channel_id} -> {to_channel_id}")),
    )
    .await;
    StatusCode::OK.into_response()
}

// --- Audit Log ---

/// Log an action to the audit log
#[allow(dead_code)]
pub async fn log_audit_action(
    pool: &sqlx::PgPool,
    server_id: &str,
    action_type: &str,
    actor_id: i64,
    target_id: Option<i64>,
    target_type: Option<&str>,
    details: Option<&str>,
) {
    let _ = sqlx::query(
        "INSERT INTO audit_log (server_id, action_type, actor_id, target_id, target_type, details) VALUES ($1, $2, $3, $4, $5, $6)"
    )
    .bind(server_id)
    .bind(action_type)
    .bind(actor_id)
    .bind(target_id)
    .bind(target_type)
    .bind(details)
    .execute(pool)
    .await;
}

/// Get audit log for a server
pub async fn list_audit_log(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Query(query): Query<AuditQuery>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Check if user has permission to view audit log (admin only)
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::ADMINISTRATOR,
    )
    .await
    {
        return (
            StatusCode::FORBIDDEN,
            "Only administrators can view audit log",
        )
            .into_response();
    }

    // clamp(1, 100), not .min(100): a NEGATIVE limit (?limit=-5) is < 100 so
    // .min let it through as `LIMIT -5`, which Postgres rejects — and the
    // .unwrap_or_default() below then hid that error as an EMPTY audit log
    // (indistinguishable from "no entries"). The lower bound also stops a
    // caller asking Postgres for `LIMIT 0`.
    let limit = query.limit.unwrap_or(50).clamp(1, 100);

    // ids are INT4 (decode as i32, cast to i64 in the response) and created_at is a
    // timestamp (cast ::text) — see [puca-sqlx-decode-gotcha]. Otherwise query_as
    // errors and .unwrap_or_default() silently yields an empty audit log.
    let entries: Vec<(
        i32,
        String,
        i32,
        Option<String>,
        Option<i32>,
        Option<String>,
        Option<String>,
        String,
    )> = if let Some(action) = &query.action_type {
        sqlx::query_as(
            "SELECT a.id, a.action_type, a.actor_id, u.username, a.target_id, a.target_type, a.details, (replace(a.created_at::text, ' ', 'T') || 'Z') AS created_at
             FROM audit_log a
             LEFT JOIN users u ON a.actor_id = u.id
             WHERE a.server_id = $1 AND a.action_type = $2
             ORDER BY a.created_at DESC
             LIMIT $3"
        )
        .bind(&server_id)
        .bind(action)
        .bind(limit)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default()
    } else {
        sqlx::query_as(
            "SELECT a.id, a.action_type, a.actor_id, u.username, a.target_id, a.target_type, a.details, (replace(a.created_at::text, ' ', 'T') || 'Z') AS created_at
             FROM audit_log a
             LEFT JOIN users u ON a.actor_id = u.id
             WHERE a.server_id = $1
             ORDER BY a.created_at DESC
             LIMIT $2"
        )
        .bind(&server_id)
        .bind(limit)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default()
    };

    let response: Vec<AuditLogEntry> = entries
        .into_iter()
        .map(
            |(
                id,
                action_type,
                actor_id,
                actor_username,
                target_id,
                target_type,
                details,
                created_at,
            )| {
                AuditLogEntry {
                    id: id as i64,
                    action_type,
                    actor_id: actor_id as i64,
                    actor_username,
                    target_id: target_id.map(|v| v as i64),
                    target_type,
                    details,
                    created_at,
                }
            },
        )
        .collect();

    Json(response).into_response()
}

// --- Report System ---

/// Create a new report
pub async fn create_report(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateReportRequest>,
) -> impl IntoResponse {
    // Verify user is member of server
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

    // Validate report type
    let valid_types = ["spam", "harassment", "inappropriate", "other"];
    if !valid_types.contains(&payload.report_type.as_str()) {
        return (StatusCode::BAD_REQUEST, "Invalid report type").into_response();
    }

    // Bound the stored free-text. `reason` is TEXT (migration 001) with no cap,
    // and every mod who opens the queue downloads it — an unbounded reason is a
    // storage-amplification + queue-DoS lever. A message id is a UUID/string;
    // 128 chars is generous slack.
    if payload.reason.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "Report reason cannot be empty").into_response();
    }
    if payload.reason.chars().count() > 1000 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "Report reason must be at most 1000 characters",
        )
            .into_response();
    }
    if payload
        .reported_message_id
        .as_ref()
        .is_some_and(|m| m.len() > 128)
    {
        return (StatusCode::BAD_REQUEST, "Invalid reported_message_id").into_response();
    }

    // Rate-limit report creation per reporter per server: reports are unbounded
    // rows any member can write, so without a ceiling one member can flood the
    // mod queue (and the reports table) at will. Mirrors the mail-bomb throttle
    // from batch 4 — count this reporter's reports in this server in the last
    // hour and refuse past the cap. Legitimate reporting stays well under it.
    const MAX_REPORTS_PER_HOUR: i64 = 15;
    let recent: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM reports \
         WHERE server_id = $1 AND reporter_id = $2 AND created_at > NOW() - INTERVAL '1 hour'",
    )
    .bind(&server_id)
    .bind(claims.sub as i32)
    .fetch_one(&state.pool)
    .await
    .unwrap_or((0,));
    if recent.0 >= MAX_REPORTS_PER_HOUR {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "Too many reports; please try again later",
        )
            .into_response();
    }

    // Insert report
    let result: Result<(i32,), _> = sqlx::query_as(
        "INSERT INTO reports (server_id, reporter_id, reported_user_id, reported_message_id, report_type, reason) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id"
    )
    .bind(&server_id)
    .bind(claims.sub as i32)
    .bind(payload.reported_user_id)
    .bind(&payload.reported_message_id)
    .bind(&payload.report_type)
    .bind(&payload.reason)
    .fetch_one(&state.pool)
    .await;

    match result {
        Ok((id,)) => Json(serde_json::json!({ "id": id })).into_response(),
        Err(e) => {
            tracing::error!("Failed to create report: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create report").into_response()
        }
    }
}

/// List reports for a server (mods only)
pub async fn list_reports(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Query(query): Query<ReportsQuery>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Check if user has moderation permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_MESSAGES,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Only moderators can view reports").into_response();
    }

    // clamp(1, 100), not .min(100): a negative limit made `LIMIT -5` error and
    // .unwrap_or_default() hid it as an empty report list. See list_audit_log.
    let limit = query.limit.unwrap_or(50).clamp(1, 100);

    // INT4 ids decode as i32 (cast to i64 in the response) and the two timestamps
    // (created_at, resolved_at) are cast ::text — otherwise query_as errors and
    // .unwrap_or_default() silently returns an empty report list.
    let reports: Vec<(
        i32,
        i32,
        Option<String>,
        Option<i32>,
        Option<String>,
        Option<String>,
        String,
        String,
        String,
        Option<i32>,
        Option<String>,
        String,
        Option<String>,
    )> = if let Some(status) = &query.status {
        sqlx::query_as(
                "SELECT r.id, r.reporter_id, u1.username, r.reported_user_id, u2.username, r.reported_message_id, 
                        r.report_type, r.reason, r.status, r.resolved_by, r.resolution_notes, (replace(r.created_at::text, ' ', 'T') || 'Z') AS created_at, (replace(r.resolved_at::text, ' ', 'T') || 'Z') AS resolved_at
                 FROM reports r
                 LEFT JOIN users u1 ON r.reporter_id = u1.id
                 LEFT JOIN users u2 ON r.reported_user_id = u2.id
                 WHERE r.server_id = $1 AND r.status = $2
                 ORDER BY r.created_at DESC
                 LIMIT $3"
            )
            .bind(&server_id)
            .bind(status)
            .bind(limit)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default()
    } else {
        sqlx::query_as(
                "SELECT r.id, r.reporter_id, u1.username, r.reported_user_id, u2.username, r.reported_message_id, 
                        r.report_type, r.reason, r.status, r.resolved_by, r.resolution_notes, (replace(r.created_at::text, ' ', 'T') || 'Z') AS created_at, (replace(r.resolved_at::text, ' ', 'T') || 'Z') AS resolved_at
                 FROM reports r
                 LEFT JOIN users u1 ON r.reporter_id = u1.id
                 LEFT JOIN users u2 ON r.reported_user_id = u2.id
                 WHERE r.server_id = $1
                 ORDER BY r.created_at DESC
                 LIMIT $2"
            )
            .bind(&server_id)
            .bind(limit)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default()
    };

    let response: Vec<ReportResponse> = reports
        .into_iter()
        .map(
            |(
                id,
                reporter_id,
                reporter_username,
                reported_user_id,
                reported_username,
                reported_message_id,
                report_type,
                reason,
                status,
                resolved_by,
                resolution_notes,
                created_at,
                resolved_at,
            )| {
                ReportResponse {
                    id: id as i64,
                    reporter_id: reporter_id as i64,
                    reporter_username,
                    reported_user_id: reported_user_id.map(|v| v as i64),
                    reported_username,
                    reported_message_id,
                    report_type,
                    reason,
                    status,
                    resolved_by: resolved_by.map(|v| v as i64),
                    resolution_notes,
                    created_at,
                    resolved_at,
                }
            },
        )
        .collect();

    Json(response).into_response()
}

/// Resolve a report (mods only)
pub async fn resolve_report(
    State(state): State<Arc<AppState>>,
    Path((server_id, report_id)): Path<(String, i64)>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<ResolveReportRequest>,
) -> impl IntoResponse {
    // Check if user has moderation permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_MESSAGES,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Only moderators can resolve reports").into_response();
    }

    // Validate status
    if payload.status != "resolved" && payload.status != "dismissed" {
        return (StatusCode::BAD_REQUEST, "Invalid status").into_response();
    }

    // Cap resolution notes (same uncapped-TEXT class as the report reason).
    if !reason_within_cap(&payload.notes) {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Notes too long").into_response();
    }

    // Update report
    let result = sqlx::query(
        "UPDATE reports SET status = $1, resolved_by = $2, resolution_notes = $3, resolved_at = CURRENT_TIMESTAMP WHERE id = $4 AND server_id = $5"
    )
    .bind(&payload.status)
    .bind(claims.sub as i32)
    .bind(&payload.notes)
    .bind(report_id)
    .bind(&server_id)
    .execute(&state.pool)
    .await;

    match result {
        Ok(r) if r.rows_affected() > 0 => StatusCode::OK.into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, "Report not found").into_response(),
        Err(e) => {
            tracing::error!("Failed to resolve report: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to resolve report",
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod crash_resistance_tests {
    use super::*;

    #[test]
    fn timeout_seconds_rejects_out_of_range_without_panicking() {
        // The values that used to panic chrono's Duration/DateTime math.
        assert!(!valid_timeout_seconds(i64::MAX));
        assert!(!valid_timeout_seconds(i64::MIN));
        assert!(!valid_timeout_seconds(0));
        assert!(!valid_timeout_seconds(-5));
        assert!(!valid_timeout_seconds(MAX_TIMEOUT_SECONDS + 1));
        // Accepted range.
        assert!(valid_timeout_seconds(1));
        assert!(valid_timeout_seconds(3600));
        assert!(valid_timeout_seconds(MAX_TIMEOUT_SECONDS));
        // The guard makes the subsequent chrono add always succeed.
        for s in [1, 3600, MAX_TIMEOUT_SECONDS] {
            assert!(chrono::Utc::now()
                .checked_add_signed(chrono::Duration::seconds(s))
                .is_some());
        }
    }

    #[test]
    fn reason_cap_accepts_within_and_rejects_over() {
        assert!(reason_within_cap(&None));
        assert!(reason_within_cap(&Some(String::new())));
        assert!(reason_within_cap(&Some("x".repeat(MAX_REASON_LEN))));
        assert!(!reason_within_cap(&Some("x".repeat(MAX_REASON_LEN + 1))));
        // A megabyte reason (the amplification lever) is rejected.
        assert!(!reason_within_cap(&Some("a".repeat(1_000_000))));
        // Counted in CHARS, not bytes: MAX_REASON_LEN multi-byte chars is fine,
        // MAX_REASON_LEN+1 is not — a byte cap would have wrongly rejected the
        // former (each char is 4 bytes here).
        assert!(reason_within_cap(&Some("😀".repeat(MAX_REASON_LEN))));
        assert!(!reason_within_cap(&Some("😀".repeat(MAX_REASON_LEN + 1))));
    }

    #[test]
    fn pagination_clamp_never_yields_an_invalid_limit() {
        // The exact expression the list handlers use. A negative or zero limit
        // must clamp into [1, 100] so Postgres never sees `LIMIT -5` (which
        // errored and was hidden as an empty result by unwrap_or_default).
        let clamp = |v: Option<i32>| v.unwrap_or(50).clamp(1, 100);
        assert_eq!(clamp(Some(-5)), 1);
        assert_eq!(clamp(Some(0)), 1);
        assert_eq!(clamp(Some(10)), 10);
        assert_eq!(clamp(Some(1000)), 100);
        assert_eq!(clamp(None), 50);
        assert_eq!(clamp(Some(i32::MIN)), 1);
    }
}
