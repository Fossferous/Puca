//! Invite Handlers
//!
//! REST API handlers for server invites.

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::Claims;
use crate::permissions::{user_has_permission, Permissions};
use crate::server_handlers::ServerResponse;
use crate::state::AppState;

// --- DTOs ---

#[derive(Deserialize)]
pub struct CreateInviteRequest {
    pub max_uses: Option<i32>,
    pub expires_in_hours: Option<i32>,
}

#[derive(Serialize)]
pub struct InviteResponse {
    pub code: String,
    pub server_id: String,
    pub server_name: String,
    pub uses: i32,
    pub max_uses: Option<i32>,
    pub expires_at: Option<String>,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct InviteInfoResponse {
    pub code: String,
    pub server_id: String,
    pub server_name: String,
    pub member_count: i32,
}

// --- Helpers ---

/// Generate a short random invite code
fn generate_invite_code() -> String {
    use rand::Rng;
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

// --- Handlers ---

/// Create an invite for a server
pub async fn create_invite(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateInviteRequest>,
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

    let code = generate_invite_code();

    // Normalize max_uses: 0 (or any non-positive value) means "unlimited" here,
    // so store it as NULL. Otherwise the lookup/join guard `uses < max_uses`
    // evaluates `0 < 0` = false and the invite is born unusable.
    let max_uses = payload.max_uses.filter(|&n| n > 0);

    let expires_at = payload
        .expires_in_hours
        .map(|hours| chrono::Utc::now() + chrono::Duration::hours(hours as i64));

    let created_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let result = sqlx::query(
        "INSERT INTO server_invites (code, server_id, creator_id, max_uses, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)"
    )
    .bind(&code)
    .bind(&server_id)
    .bind(claims.sub as i32)
    .bind(max_uses)
    .bind(expires_at.map(|t| t.format("%Y-%m-%dT%H:%M:%SZ").to_string()))
    .bind(&created_at)
    .execute(&state.pool)
    .await;

    if let Err(e) = result {
        // Log detail; return generic so DB internals aren't leaked to the client.
        tracing::error!("create_invite failed: {:?}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create invite").into_response();
    }

    let server: (String,) = sqlx::query_as("SELECT name FROM servers WHERE id = $1")
        .bind(&server_id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(("Unknown".to_string(),));

    Json(InviteResponse {
        code,
        server_id,
        server_name: server.0,
        uses: 0,
        max_uses,
        expires_at: expires_at.map(|t| t.format("%Y-%m-%dT%H:%M:%SZ").to_string()),
        created_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
    })
    .into_response()
}

/// Get invite info (public - for previewing before joining)
pub async fn get_invite_info(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
) -> impl IntoResponse {
    let invite: Option<(String, String)> = sqlx::query_as(
        "SELECT i.server_id, s.name FROM server_invites i 
         JOIN servers s ON i.server_id = s.id 
         WHERE i.code = $1 AND (i.expires_at IS NULL OR i.expires_at::timestamp > NOW())
         AND (i.max_uses IS NULL OR i.max_uses <= 0 OR i.uses < i.max_uses)",
    )
    .bind(&code)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    match invite {
        Some((server_id, server_name)) => {
            // COUNT(*) is BIGINT/INT8; decoding into i32 failed and was swallowed,
            // so member_count was always 0. Decode as i64 and cast for the response.
            let count: (i64,) =
                sqlx::query_as("SELECT COUNT(*) FROM server_members WHERE server_id = $1")
                    .bind(&server_id)
                    .fetch_one(&state.pool)
                    .await
                    .unwrap_or((0,));

            Json(InviteInfoResponse {
                code,
                server_id,
                server_name,
                member_count: count.0 as i32,
            })
            .into_response()
        }
        None => (StatusCode::NOT_FOUND, "Invite not found or expired").into_response(),
    }
}

/// Join a server via invite code
pub async fn join_via_invite(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Resolve which server the invite points at (existence only). Validity
    // (expiry / max_uses) is enforced atomically at consume time below.
    let server_id: Option<(String,)> =
        sqlx::query_as("SELECT server_id FROM server_invites WHERE code = $1")
            .bind(&code)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    let server_id = match server_id {
        Some((sid,)) => sid,
        None => return (StatusCode::NOT_FOUND, "Invite not found or expired").into_response(),
    };

    // Check if already a member — return OK without consuming a use.
    let is_member: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2")
            .bind(&server_id)
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    if is_member.is_some() {
        return (StatusCode::OK, "Already a member").into_response();
    }

    // Check if user is banned — don't consume a use.
    let is_banned: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM bans WHERE server_id = $1 AND user_id = $2")
            .bind(&server_id)
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    if is_banned.is_some() {
        return (StatusCode::FORBIDDEN, "You are banned from this server").into_response();
    }

    // Atomically consume one use IFF the invite is still valid. Folding the
    // `uses < max_uses` check and the increment into a single conditional UPDATE
    // closes the TOCTOU where concurrent joins each passed a separate read of
    // `uses` and overshot max_uses.
    let consumed: Option<(String,)> = sqlx::query_as(
        "UPDATE server_invites SET uses = uses + 1 \
         WHERE code = $1 AND (expires_at IS NULL OR expires_at::timestamp > NOW()) \
         AND (max_uses IS NULL OR max_uses <= 0 OR uses < max_uses) \
         RETURNING server_id",
    )
    .bind(&code)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if consumed.is_none() {
        return (StatusCode::NOT_FOUND, "Invite not found or expired").into_response();
    }

    // Add user as member (ON CONFLICT: a same-user double-submit shouldn't error)
    let _ = sqlx::query(
        "INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(&server_id)
    .bind(claims.sub as i32)
    .execute(&state.pool)
    .await;

    // Assign @everyone role
    let everyone_role: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM server_roles WHERE server_id = $1 AND is_default = true")
            .bind(&server_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    if let Some((role_id,)) = everyone_role {
        let _ = sqlx::query(
            "INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING"
        )
        .bind(&server_id)
        .bind(claims.sub as i32)
        .bind(role_id)
        .execute(&state.pool)
        .await;
    }

    // Tell the people already in the server that someone arrived.
    //
    // Fan-out is modelled on broadcast_perms_changed_and_evict (ws.rs): read
    // the member ids, then one send_to_user each. The JOINER is excluded —
    // their own client learns it from the response below, and telling them
    // would notify a person about themselves.
    //
    // Best-effort by construction: a failed query or an offline member must
    // never fail the join that already committed above.
    let members: Vec<(i32,)> =
        sqlx::query_as("SELECT user_id FROM server_members WHERE server_id = $1")
            .bind(&server_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();
    for (member_id,) in members {
        if member_id as i64 == claims.sub {
            continue;
        }
        state.send_to_user(
            member_id as i64,
            crate::protocol::ServerMessage::MemberJoined {
                server_id: server_id.clone(),
                user: crate::protocol::UserInfo::new(claims.sub, claims.username.clone()),
            },
        );
    }

    // Return server info
    let server: Option<(String, String, i32, String, Option<String>, Option<String>, bool, bool, i32, Option<i32>, bool)> = sqlx::query_as(
        "SELECT id, name, owner_id, (replace(created_at::text, ' ', 'T') || 'Z') AS created_at, icon_file_id, description, require_media_e2ee, clips_enabled, clip_max_seconds, clip_channel_id, COALESCE(is_public, false) FROM servers WHERE id = $1"
    )
    .bind(&server_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    match server {
        Some((id, name, owner_id, created_at, icon_file_id, description, require_media_e2ee, clips_enabled, clip_max_seconds, clip_channel_id, is_public)) => {
            Json(ServerResponse {
                id,
                name,
                owner_id: owner_id as i64,
                created_at,
                icon_file_id,
                description,
                require_media_e2ee,
                clips_enabled,
                clip_max_seconds,
                clip_channel_id: clip_channel_id.map(|c| c as i64),
                is_public,
            })
            .into_response()
        }
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to get server info",
        )
            .into_response(),
    }
}

/// List invites for a server
pub async fn list_invites(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
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

    // Listing every invite code is a server-management action — otherwise any
    // member could enumerate all active invite links for the server.
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_SERVER,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MANAGE_SERVER permission").into_response();
    }

    let invites: Vec<(String, String, i32, Option<i32>, Option<String>, String)> = sqlx::query_as(
        "SELECT i.code, s.name, i.uses, i.max_uses, i.expires_at, i.created_at 
         FROM server_invites i 
         JOIN servers s ON i.server_id = s.id
         WHERE i.server_id = $1
         ORDER BY i.created_at DESC",
    )
    .bind(&server_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let response: Vec<InviteResponse> = invites
        .into_iter()
        .map(
            |(code, server_name, uses, max_uses, expires_at, created_at)| InviteResponse {
                code,
                server_id: server_id.clone(),
                server_name,
                uses,
                max_uses,
                expires_at,
                created_at,
            },
        )
        .collect();

    Json(response).into_response()
}

/// Delete an invite
pub async fn delete_invite(
    State(state): State<Arc<AppState>>,
    Path((server_id, code)): Path<(String, String)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
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

    // Deleting invites is a server-management action — otherwise any member could
    // revoke another member's (or the owner's) invite links.
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_SERVER,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MANAGE_SERVER permission").into_response();
    }

    let _ = sqlx::query("DELETE FROM server_invites WHERE code = $1 AND server_id = $2")
        .bind(&code)
        .bind(&server_id)
        .execute(&state.pool)
        .await;

    StatusCode::OK.into_response()
}
