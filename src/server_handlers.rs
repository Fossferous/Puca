//! Server, Channel, and Message Handlers
//!
//! REST API handlers for multi-server architecture.

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
use crate::state::AppState;

// --- DTOs ---

#[derive(Deserialize)]
pub struct CreateServerRequest {
    pub name: String,
}

#[derive(Serialize)]
pub struct ServerResponse {
    pub id: String,
    pub name: String,
    pub owner_id: i64,
    pub created_at: String,
    pub icon_file_id: Option<String>,
    pub description: Option<String>,
    /// Server-admin policy: clients must require media E2EE for calls here.
    pub require_media_e2ee: bool,
    /// Clips (docs/CLIPS.md): owner-enabled replay-buffer posting; longest clip
    /// in seconds; optional pinned target text channel (None = clipper picks).
    pub clips_enabled: bool,
    pub clip_max_seconds: i32,
    pub clip_channel_id: Option<i64>,
    /// Discoverable via /discover. Was NEVER returned by any read endpoint until
    /// 2026-08-19, so the settings modal seeded its toggle from `?? false` and
    /// every Save on a public server silently wrote is_public=false (the PATCH
    /// sends the toggle unconditionally). NULL in legacy rows reads as false.
    pub is_public: bool,
    /// Minutes of inactivity before a voice member is moved to the AFK channel.
    /// Discord's option set (1|5|15|30|60); 15 was the old hardcoded value.
    pub afk_timeout_minutes: i32,
}

// --- ICE Configuration DTOs ---

#[derive(Serialize, Clone)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Serialize)]
pub struct IceConfiguration {
    #[serde(rename = "iceServers")]
    pub ice_servers: Vec<IceServer>,
    #[serde(rename = "iceTransportPolicy")]
    pub ice_transport_policy: String,
}

// --- Server Handlers ---

/// Create a new server
pub async fn create_server(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateServerRequest>,
) -> impl IntoResponse {
    // Cap the name up front: it is served unauthenticated via /discover and
    // stored unbounded otherwise (a storage + amplification lever). Trim, and
    // require 1..=100 characters (unicode-aware).
    let name = payload.name.trim();
    let name_len = name.chars().count();
    if name_len == 0 || name_len > 100 {
        return (
            StatusCode::BAD_REQUEST,
            "Server name must be 1-100 characters",
        )
            .into_response();
    }

    let server_id = Uuid::new_v4().to_string();

    // Create the server.
    //
    // INSERT ... SELECT ... FOR SHARE, not a plain VALUES: this row lock is what
    // serializes against a concurrent DELETE /account. That handler checks
    // "do you still own servers?" and then tombstones the users row inside a
    // transaction; without a shared lock point, a create committing between its
    // check and its commit would leave a server owned by an account that can
    // never authenticate again, stranding every member (no ownership-transfer
    // endpoint exists). Whichever side takes the users row first wins cleanly:
    // if the delete holds it, this SELECT re-evaluates after the commit and
    // sees deleted_at set, inserting nothing; if this holds it, the delete's
    // in-transaction re-check sees the new server and aborts.
    let result = sqlx::query(
        "INSERT INTO servers (id, name, owner_id) \
         SELECT $1, $2, id FROM users WHERE id = $3 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(&server_id)
    .bind(name)
    .bind(claims.sub as i32)
    .execute(&state.pool)
    .await;

    match result {
        Err(e) => {
            tracing::error!("Failed to create server: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create server").into_response();
        }
        Ok(r) if r.rows_affected() == 0 => {
            tracing::warn!(
                "create_server refused: user {} is deleted or missing",
                claims.sub
            );
            return (StatusCode::CONFLICT, "This account is no longer active").into_response();
        }
        Ok(_) => {}
    }

    // Add owner as member
    let _ = sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
        .bind(&server_id)
        .bind(claims.sub as i32)
        .execute(&state.pool)
        .await;

    // Create the default channel set: a text channel and a voice channel (both
    // named "default", editable), plus an AFK voice channel. AFK sorts last.
    let _ = sqlx::query(
        "INSERT INTO channels (name, type, position, is_afk, server_id) VALUES \
            ('default', 0, 0, false, $1), \
            ('default', 1, 1, false, $1), \
            ('AFK', 1, 2, true, $1)",
    )
    .bind(&server_id)
    .execute(&state.pool)
    .await;

    // Create @everyone role (default, assigned to all members).
    //
    // ONE source of truth: Permissions::DEFAULT_MEMBER, plus STREAM. This list
    // used to be spelled out again here and had DRIFTED from DEFAULT_MEMBER —
    // it omitted ATTACH_FILES, ADD_REACTIONS, VIDEO and USE_VOICE_ACTIVITY, so
    // the constant that documents the default and the row actually written
    // disagreed. Nothing enforced those bits, which is why nobody noticed; it
    // also meant anyone reasoning from DEFAULT_MEMBER about what a member holds
    // (including an audit deciding whether enforcing a bit is safe) got the
    // wrong answer. Migration 046 backfills the same bits onto existing
    // @everyone roles so new and old servers agree.
    //
    // STREAM is not in DEFAULT_MEMBER but is granted here for the same reason
    // it is backfilled: screen sharing is unrestricted today, so a default that
    // withheld it would take the feature away the moment it is enforced.
    // MANAGE_TASKS is deliberately NOT granted by default.
    let everyone_perms = (crate::permissions::Permissions::DEFAULT_MEMBER
        | crate::permissions::Permissions::STREAM)
        .bits() as i64;
    let _ = sqlx::query(
        "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, '@everyone', '#99AAB5', $2, 0, true)"
    )
    .bind(&server_id)
    .bind(everyone_perms)
    .execute(&state.pool)
    .await;

    // Create Owner role with ADMINISTRATOR permission (1 << 22 = 4194304).
    // is_default MUST be the boolean literal `false`, not integer `0` — Postgres
    // rejects `0` for a BOOLEAN column, which silently failed this INSERT and left
    // every new server without an Owner role (M13). The decode MUST be i64:
    // server_roles.id is BIGSERIAL, and (i32,) fails with ColumnDecode, which
    // re-broke this same INSERT after M13.
    let owner_role_result: Result<(i64,), _> = sqlx::query_as(
        "INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, 'Owner', '#F1C40F', 4194304, 100, false) RETURNING id"
    )
    .bind(&server_id)
    .fetch_one(&state.pool)
    .await;

    // Assign owner to Owner role
    match owner_role_result {
        Ok((owner_role_id,)) => {
            let _ = sqlx::query(
                "INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)",
            )
            .bind(&server_id)
            .bind(claims.sub as i32)
            .bind(owner_role_id)
            .execute(&state.pool)
            .await;
        }
        Err(e) => {
            // Ownership still works via the servers.owner_id check, but log so a
            // recurring failure here (schema drift, etc.) is visible.
            tracing::error!(
                "Failed to create Owner role for server {}: {:?}",
                server_id,
                e
            );
        }
    }

    // Return the full server shape the client stores as `currentServer` —
    // omitting owner_id made the creator render as a non-owner (no settings,
    // no role management, no moderation tab) until the app was restarted.
    // Every field of ServerResponse, with the new row's defaults: the client
    // seats THIS object as currentServer, and a missing clip_max_seconds reads
    // as "this server predates clips" in Server Settings until a refetch.
    Json(serde_json::json!({
        "id": server_id,
        "name": payload.name,
        "owner_id": claims.sub,
        "is_public": false,
        "description": null,
        "icon_file_id": null,
        "require_media_e2ee": false,
        "clips_enabled": false,
        "clip_max_seconds": 120,
        "clip_channel_id": null
    }))
    .into_response()
}

// Well-known UUID for the default server (same for all users)
const DEFAULT_SERVER_ID: &str = "00000000-0000-0000-0000-000000000001";
const DEFAULT_SERVER_NAME: &str = "Main Server";

/// Get or create the global default server and auto-join the user
pub async fn get_or_create_default_server(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    tracing::info!(
        ">>> get_or_create_default_server called for user_id: {}",
        claims.sub
    );

    // Check if default server exists
    let server_result = sqlx::query_as::<_, (String, String, i32, String, Option<String>, Option<String>, bool, bool, i32, Option<i32>, bool, i32)>(
        "SELECT id, name, owner_id, (replace(created_at::text, ' ', 'T') || 'Z') AS created_at, icon_file_id, description, require_media_e2ee, clips_enabled, clip_max_seconds, clip_channel_id, COALESCE(is_public, false), afk_timeout_minutes FROM servers WHERE id = $1"
    )
    .bind(DEFAULT_SERVER_ID)
    .fetch_optional(&state.pool)
    .await;

    let server = match server_result {
        Ok(s) => {
            tracing::info!("  Server lookup result: {:?}", s.is_some());
            s
        }
        Err(e) => {
            tracing::error!("  Failed to query server: {:?}", e);
            None
        }
    };

    let server_response = if let Some((
        id,
        name,
        owner_id,
        created_at,
        icon_file_id,
        description,
        require_media_e2ee,
        clips_enabled,
        clip_max_seconds,
        clip_channel_id,
        is_public,
        afk_timeout_minutes,
    )) = server
    {
        // Server exists, make sure user is a member
        let _ = sqlx::query(
            "INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING"
        )
        .bind(DEFAULT_SERVER_ID)
        .bind(claims.sub as i32)
        .execute(&state.pool)
        .await;

        ServerResponse {
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
            afk_timeout_minutes,
        }
    } else {
        // Create the default server (first user becomes owner)
        let _ = sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(DEFAULT_SERVER_ID)
            .bind(DEFAULT_SERVER_NAME)
            .bind(claims.sub as i32)
            .execute(&state.pool)
            .await;

        // Add user as member
        let _ = sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
            .bind(DEFAULT_SERVER_ID)
            .bind(claims.sub as i32)
            .execute(&state.pool)
            .await;

        // Default channel set: text + voice (both "default") + an AFK voice channel.
        let _ = sqlx::query(
            "INSERT INTO channels (name, type, position, is_afk, server_id) VALUES \
                ('default', 0, 0, false, $1), \
                ('default', 1, 1, false, $1), \
                ('AFK', 1, 2, true, $1)",
        )
        .bind(DEFAULT_SERVER_ID)
        .execute(&state.pool)
        .await;

        ServerResponse {
            id: DEFAULT_SERVER_ID.to_string(),
            name: DEFAULT_SERVER_NAME.to_string(),
            owner_id: claims.sub,
            created_at: chrono::Utc::now().to_rfc3339(),
            icon_file_id: None,
            description: None,
            require_media_e2ee: false,
            clips_enabled: false,
            clip_max_seconds: 120,
            clip_channel_id: None,
            is_public: false,
            afk_timeout_minutes: 15,
        }
    };

    Json(server_response)
}

/// List servers user is a member of
pub async fn list_servers(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // owner_id is INTEGER (i32), also include icon_file_id, description, and the E2EE policy.
    // Rail order is per-member (server_members.position, migration 036):
    // dragged-into-place servers first, never-ordered ones after by join age.
    let servers: Vec<(String, String, i32, String, Option<String>, Option<String>, bool, bool, i32, Option<i32>, bool, i32)> = sqlx::query_as(
        r#"
        SELECT s.id, s.name, s.owner_id, (replace(s.created_at::text, ' ', 'T') || 'Z') AS created_at, s.icon_file_id, s.description, s.require_media_e2ee, s.clips_enabled, s.clip_max_seconds, s.clip_channel_id, COALESCE(s.is_public, false), s.afk_timeout_minutes
        FROM servers s
        JOIN server_members sm ON s.id = sm.server_id
        WHERE sm.user_id = $1
        ORDER BY sm.position ASC NULLS LAST, s.created_at ASC
        "#
    )
    .bind(claims.sub as i32)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let response: Vec<ServerResponse> = servers
        .into_iter()
        .map(
            |(id, name, owner_id, created_at, icon_file_id, description, require_media_e2ee, clips_enabled, clip_max_seconds, clip_channel_id, is_public, afk_timeout_minutes)| {
                ServerResponse {
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
                    afk_timeout_minutes,
                }
            },
        )
        .collect();

    Json(response)
}

#[derive(serde::Deserialize)]
pub struct ReorderServersRequest {
    /// Every server id the user wants ordered, in rail order.
    pub server_ids: Vec<String>,
}

/// PATCH /servers/reorder — persist the caller's personal server-rail order.
/// Only touches the caller's own membership rows, so no permission checks
/// beyond auth; ids the user isn't a member of simply update nothing.
pub async fn reorder_servers(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<ReorderServersRequest>,
) -> impl IntoResponse {
    // Bound the work (one round-trip per element, same rationale as
    // reorder_channels). Nobody is in this many servers.
    if payload.server_ids.len() > 200 {
        return (
            StatusCode::BAD_REQUEST,
            "Too many servers in one reorder request",
        )
            .into_response();
    }

    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("Failed to begin server reorder transaction: {:?}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to reorder servers",
            )
                .into_response();
        }
    };

    for (position, server_id) in payload.server_ids.iter().enumerate() {
        let result = sqlx::query(
            "UPDATE server_members SET position = $1 WHERE server_id = $2 AND user_id = $3",
        )
        .bind(position as i32)
        .bind(server_id)
        .bind(claims.sub as i32)
        .execute(&mut *tx)
        .await;
        if let Err(e) = result {
            tracing::error!("Failed to update server position: {:?}", e);
            let _ = tx.rollback().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to reorder servers",
            )
                .into_response();
        }
    }

    if let Err(e) = tx.commit().await {
        tracing::error!("Failed to commit server reorder: {:?}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to reorder servers",
        )
            .into_response();
    }

    StatusCode::OK.into_response()
}

/// Member response with online status
#[derive(Serialize)]
pub struct MemberResponse {
    pub id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub is_online: bool,
}

/// List all members of a server with online status
pub async fn list_server_members(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
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

    // Get all members from database. users.id is INT4, so decode as i32 — decoding
    // into i64 makes query_as error, which .unwrap_or_default() would silently turn
    // into an empty member list.
    let members: Vec<(i32, String, Option<String>, bool)> = sqlx::query_as(
        r#"
        SELECT u.id, u.username, u.display_name, u.show_online_status
        FROM users u
        JOIN server_members sm ON u.id = sm.user_id
        WHERE sm.server_id = $1
        ORDER BY u.username ASC
        "#,
    )
    .bind(&server_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    // Check which members are currently online (have active WebSocket session).
    // A member hiding their status reads as offline to everyone but themselves.
    let response: Vec<MemberResponse> = members
        .into_iter()
        .map(|(id, username, display_name, shows_online)| {
            let id = id as i64;
            let is_online = state.is_user_visibly_online(id) && (shows_online || id == claims.sub);
            MemberResponse {
                id,
                username,
                display_name,
                is_online,
            }
        })
        .collect();

    Json(response).into_response()
}

/// Join a server (by invite or ID)
pub async fn join_server(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Check if server exists, and whether it's publicly joinable. COALESCE so a
    // legacy NULL is_public decodes cleanly and is treated as private (the safe
    // default) rather than erroring into a misleading 404.
    let server_row: Option<(bool,)> =
        sqlx::query_as("SELECT COALESCE(is_public, false) FROM servers WHERE id = $1")
            .bind(&server_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    let is_public = match server_row {
        Some((is_public,)) => is_public,
        None => return (StatusCode::NOT_FOUND, "Server not found").into_response(),
    };

    // H2: a server UUID is not a secret (get_invite_info returns it
    // unauthenticated), so a bare /join must be gated. Private servers require an
    // invite — route through join_via_invite, which atomically validates and
    // consumes the invite (respecting max_uses / expiry / kicked-member rejoins).
    if !is_public {
        return (StatusCode::FORBIDDEN, "This server is invite-only").into_response();
    }

    // Check if user is banned
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

    // Add user as member (ignore if already member)
    let _ = sqlx::query(
        "INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(&server_id)
    .bind(claims.sub as i32)
    .execute(&state.pool)
    .await;

    // Assign @everyone role to the new member
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

    StatusCode::OK.into_response()
}

/// Leave a server (remove yourself as a member). The owner cannot leave their
/// own server — they must delete it instead (otherwise it would be ownerless).
pub async fn leave_server(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let owner: Option<(i32,)> = sqlx::query_as("SELECT owner_id FROM servers WHERE id = $1")
        .bind(&server_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);

    match owner {
        None => return (StatusCode::NOT_FOUND, "Server not found").into_response(),
        Some((owner_id,)) if owner_id as i64 == claims.sub => {
            return (
                StatusCode::BAD_REQUEST,
                "The owner cannot leave; delete the server instead",
            )
                .into_response();
        }
        _ => {}
    }

    // Remove membership and any assigned roles.
    let _ = sqlx::query("DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2")
        .bind(&server_id)
        .bind(claims.sub as i32)
        .execute(&state.pool)
        .await;
    let res = sqlx::query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2")
        .bind(&server_id)
        .bind(claims.sub as i32)
        .execute(&state.pool)
        .await;

    match res {
        Ok(r) if r.rows_affected() > 0 => {
            // Server-side force-evict from any live voice/media room, exactly
            // as kick/ban do (moderation_handlers.rs). Without it a member who
            // leaves keeps their live voice/screen-share/remote-control session
            // until the socket happens to drop — they fail VIEW everywhere now,
            // so this cuts media immediately rather than trusting the client to
            // disconnect. Also rotates the channel key (revocation) via the same
            // path. Runs AFTER the membership delete so the viewer resolve sees
            // them as gone.
            crate::ws::broadcast_perms_changed_and_evict(&state, &server_id).await;
            StatusCode::OK.into_response()
        }
        Ok(_) => (StatusCode::NOT_FOUND, "You are not a member of this server").into_response(),
        Err(e) => {
            tracing::error!("Failed to leave server: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to leave server").into_response()
        }
    }
}

/// Delete a server (owner only). All children cascade via ON DELETE CASCADE
/// (channels → messages/reactions/pins, roles, members, invites, bans, ...).
pub async fn delete_server(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let owner: Option<(i32,)> = sqlx::query_as("SELECT owner_id FROM servers WHERE id = $1")
        .bind(&server_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);

    match owner {
        None => return (StatusCode::NOT_FOUND, "Server not found").into_response(),
        Some((owner_id,)) if owner_id as i64 != claims.sub => {
            return (StatusCode::FORBIDDEN, "Only the server owner can delete it").into_response();
        }
        _ => {}
    }

    let res = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(&server_id)
        .execute(&state.pool)
        .await;

    match res {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            tracing::error!("Failed to delete server: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to delete server").into_response()
        }
    }
}

// --- Invite System DTOs ---

#[derive(Serialize)]
pub struct PublicServerResponse {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub member_count: i32,
}

#[derive(Deserialize)]
pub struct UpdateServerRequest {
    pub name: Option<String>,
    pub is_public: Option<bool>,
    pub description: Option<String>,
    pub icon_file_id: Option<String>,
    pub require_media_e2ee: Option<bool>,
    /// Clips policy (docs/CLIPS.md). `clip_channel_id`: Some(0)/Some(-1) clears the pin.
    pub clips_enabled: Option<bool>,
    pub clip_max_seconds: Option<i32>,
    pub clip_channel_id: Option<i64>,
    /// AFK auto-move window, minutes. Discord's option set only — see
    /// afk_timeout_valid; validated for an honest 400, with the DB CHECK
    /// (migration 052) as the backstop.
    pub afk_timeout_minutes: Option<i32>,
}

/// Discord's AFK-timeout options, verbatim: 1, 5, 15, 30 or 60 minutes.
/// One authority shared by the handler validation and mirrored by the DB
/// CHECK in migration 052 — if this set ever changes, both move together.
pub fn afk_timeout_valid(minutes: i32) -> bool {
    matches!(minutes, 1 | 5 | 15 | 30 | 60)
}

// --- Invite Handlers ---

/// List public servers for discovery
pub async fn list_public_servers(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // Single grouped query instead of an N+1 COUNT-per-server loop (each public
    // server used to cost its own round-trip on this unauthenticated route).
    // LEFT JOIN so a server with zero members still appears with count 0.
    // COUNT is BIGINT/INT8 in Postgres, so decode into i64 then cast.
    // Hard cap the row count: this route is UNAUTHENTICATED and returned EVERY
    // public server, so anyone could create many public servers and make each
    // anonymous request fan out an unbounded payload (bandwidth amplification).
    // A fixed ceiling bounds the response; a real ranked/paginated discovery is
    // a separate feature.
    let rows: Vec<(String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT s.id, s.name, s.description, COUNT(sm.server_id) AS member_count \
         FROM servers s \
         LEFT JOIN server_members sm ON sm.server_id = s.id \
         WHERE s.is_public = true \
         GROUP BY s.id, s.name, s.description \
         ORDER BY s.name ASC \
         LIMIT 200",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let response: Vec<PublicServerResponse> = rows
        .into_iter()
        .map(|(id, name, description, count)| PublicServerResponse {
            id,
            name,
            description,
            member_count: count as i32,
        })
        .collect();

    Json(response)
}

/// Update server settings (owner only)
pub async fn update_server_settings(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<UpdateServerRequest>,
) -> impl IntoResponse {
    tracing::info!(">>> update_server_settings: server={}, is_public={:?}, description={:?}, icon_file_id={:?}, require_media_e2ee={:?}",
        server_id, payload.is_public, payload.description, payload.icon_file_id, payload.require_media_e2ee);

    // Verify user is owner (owner_id is INTEGER in PostgreSQL)
    let is_owner: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM servers WHERE id = $1 AND owner_id = $2")
            .bind(&server_id)
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    if is_owner.is_none() {
        tracing::warn!(
            "update_server_settings: user {} is not owner of server {}",
            claims.sub,
            server_id
        );
        return (
            StatusCode::FORBIDDEN,
            "Only the owner can update server settings",
        )
            .into_response();
    }

    // Length caps: name and description are served (name via /discover) and
    // were stored unbounded. Trim-and-cap the same as create_server.
    if let Some(ref name) = payload.name {
        let n = name.trim().chars().count();
        if n == 0 || n > 100 {
            return (
                StatusCode::BAD_REQUEST,
                "Server name must be 1-100 characters",
            )
                .into_response();
        }
    }
    if let Some(ref desc) = payload.description {
        if desc.chars().count() > 1000 {
            return (
                StatusCode::BAD_REQUEST,
                "Server description must be at most 1000 characters",
            )
                .into_response();
        }
    }

    // Mass-assignment guard: an icon_file_id may only reference a file the
    // CALLER uploaded. Without this an owner could point the server icon at ANY
    // user's file by UUID — an IDOR on the blob — and, combined with the reclaim
    // hook below, DELETE that file out from under its owner by then replacing
    // the icon (the reclaim used to resolve the old blob's true uploader and
    // remove it on their behalf). An empty string clears the icon and is
    // allowed; any non-empty id must resolve to an upload owned by claims.sub.
    // An invalid-uuid string fails the ::uuid cast → None → refused.
    if let Some(ref icon_id) = payload.icon_file_id {
        if !icon_id.is_empty() {
            let owns: Option<(i32,)> = sqlx::query_as(
                "SELECT 1 FROM uploaded_files WHERE id = $1::uuid AND uploader_id = $2",
            )
            .bind(icon_id)
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
            if owns.is_none() {
                tracing::warn!(
                    "update_server_settings: user {} tried to set server {} icon to file {} they do not own",
                    claims.sub, server_id, icon_id
                );
                return (
                    StatusCode::FORBIDDEN,
                    "Server icon must be a file you uploaded",
                )
                    .into_response();
            }
        }
    }

    // AFK timeout: Discord's five options only, same honest-400-over-CHECK
    // rationale as the clips validation below.
    if let Some(mins) = payload.afk_timeout_minutes {
        if !afk_timeout_valid(mins) {
            return (
                StatusCode::BAD_REQUEST,
                "AFK timeout must be 1, 5, 15, 30 or 60 minutes",
            )
                .into_response();
        }
    }

    // Clips policy validation. Mirror the CHECK constraint (honest 400 instead
    // of a 23514 surfacing as 500), and pin the target channel to THIS server
    // (same class as the icon_file_id mass-assignment guard above).
    if let Some(secs) = payload.clip_max_seconds {
        if !(60..=600).contains(&secs) {
            return (StatusCode::BAD_REQUEST, "Longest clip must be between 1 and 10 minutes").into_response();
        }
    }
    let mut clip_channel_bind: Option<Option<i32>> = None; // Some(None) clears
    if let Some(cid) = payload.clip_channel_id {
        if cid <= 0 {
            clip_channel_bind = Some(None);
        } else {
            // Column is `type` (schema), not `channel_type` (API name); a query
            // error must not be swallowed into "not a text channel".
            let ok: Option<(i32,)> = match sqlx::query_as(
                "SELECT 1 FROM channels WHERE id = $1 AND server_id = $2 AND type = 0",
            )
            .bind(cid as i32)
            .bind(&server_id)
            .fetch_optional(&state.pool)
            .await
            {
                Ok(v) => v,
                Err(e) => { tracing::error!("update_server_settings: clip channel lookup failed: {e:?}"); return (StatusCode::INTERNAL_SERVER_ERROR, "Could not verify the clip channel").into_response(); }
            };
            if ok.is_none() {
                return (StatusCode::BAD_REQUEST, "Clips can only be pinned to a text channel of this server").into_response();
            }
            clip_channel_bind = Some(Some(cid as i32));
        }
    }

    // REQUIRED PIN (S1): refuse to CREATE the clips-enabled-with-no-channel
    // state — members can only experience it as breakage (the composer's
    // "no clips channel yet" dead end, propose_clip's 409). Judged on the
    // EFFECTIVE state (payload where given, else the current row), and
    // scoped to TRANSITIONS: a server already in the legacy state (configured
    // under the old "let the clipper choose" default) may keep re-saving it,
    // or the rule would hold every unrelated Overview save hostage — the
    // 0.8.118 client always sends all three clip fields, so a legacy owner's
    // rename would 400 here forever. Mirrors the client-side guard exactly.
    // One transaction from the guard's read to the UPDATE, with the row
    // locked: two concurrent owner PATCHes could otherwise each pass the
    // guard against the other's before-state and commit the combination the
    // guard exists to refuse (review finding F2 — A enables while pinned, B
    // clears the pin while disabled, both land).
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            tracing::error!("update_server_settings: begin failed: {e:?}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save settings").into_response();
        }
    };
    if payload.clips_enabled.is_some() || clip_channel_bind.is_some() {
        let current: Option<(bool, Option<i32>)> = match sqlx::query_as(
            "SELECT clips_enabled, clip_channel_id FROM servers WHERE id = $1 FOR UPDATE",
        )
        .bind(&server_id)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::error!("update_server_settings: clips state lookup failed: {e:?}");
                return (StatusCode::INTERNAL_SERVER_ERROR, "Could not verify the clip settings").into_response();
            }
        };
        let (cur_enabled, cur_pin) = current.unwrap_or((false, None));
        let eff_enabled = payload.clips_enabled.unwrap_or(cur_enabled);
        let eff_pin = clip_channel_bind.map_or(cur_pin, |b| b);
        let already_broken = cur_enabled && cur_pin.is_none();
        if eff_enabled && eff_pin.is_none() && !already_broken {
            return (
                StatusCode::BAD_REQUEST,
                "Choose a clips channel before turning clips on — members cannot post clips until one is pinned",
            )
                .into_response();
        }
    }

    // Build a fully parameterized UPDATE — every value is bound, never
    // interpolated into the SQL string (removes the fragile manual quote-doubling
    // that was here and any SQL-injection risk it carried).
    let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new("UPDATE servers SET ");
    let mut any = false;
    if let Some(enabled) = payload.clips_enabled {
        if any { qb.push(", "); }
        qb.push("clips_enabled = ").push_bind(enabled);
        any = true;
    }
    if let Some(secs) = payload.clip_max_seconds {
        if any { qb.push(", "); }
        qb.push("clip_max_seconds = ").push_bind(secs);
        any = true;
    }
    if let Some(bind) = clip_channel_bind {
        if any { qb.push(", "); }
        qb.push("clip_channel_id = ").push_bind(bind);
        any = true;
    }
    if let Some(ref name) = payload.name {
        if any {
            qb.push(", ");
        }
        qb.push("name = ").push_bind(name);
        any = true;
    }
    if let Some(is_public) = payload.is_public {
        if any {
            qb.push(", ");
        }
        qb.push("is_public = ").push_bind(is_public);
        any = true;
    }
    if let Some(require_media_e2ee) = payload.require_media_e2ee {
        if any {
            qb.push(", ");
        }
        qb.push("require_media_e2ee = ")
            .push_bind(require_media_e2ee);
        any = true;
    }
    if let Some(mins) = payload.afk_timeout_minutes {
        if any {
            qb.push(", ");
        }
        qb.push("afk_timeout_minutes = ").push_bind(mins);
        any = true;
    }
    if let Some(ref desc) = payload.description {
        if any {
            qb.push(", ");
        }
        qb.push("description = ").push_bind(desc);
        any = true;
    }
    if let Some(ref icon_id) = payload.icon_file_id {
        if any {
            qb.push(", ");
        }
        qb.push("icon_file_id = ").push_bind(icon_id);
        any = true;
    }

    // M15 deletion hook, mirroring the avatar one: remember the icon we are
    // about to replace so its blob can be reclaimed after a successful update.
    // A server icon has exactly one referent, so unlike a message attachment
    // (which forwarding can duplicate) removing it is unambiguous. Reclaim is
    // CALLER-scoped (see the remove_file call below) — never the old blob's
    // uploader — so replacing an icon can only ever delete the caller's own file.
    let old_icon: Option<(Option<String>,)> = if payload.icon_file_id.is_some() {
        sqlx::query_as("SELECT icon_file_id FROM servers WHERE id = $1")
            .bind(&server_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None)
    } else {
        None
    };

    if !any {
        tracing::info!("update_server_settings: no updates to apply");
        return StatusCode::OK.into_response();
    }

    qb.push(" WHERE id = ").push_bind(&server_id);

    let updated = match qb.build().execute(&mut *tx).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("Failed to update server settings: {:?}", e);
            let _ = tx.rollback().await;
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save settings").into_response();
        }
    };
    match tx.commit().await {
        Ok(()) => {
            tracing::info!(
                "update_server_settings: rows_affected={}",
                updated.rows_affected()
            );
            if let (Some((Some(old),)), Some(new)) = (&old_icon, &payload.icon_file_id) {
                if old != new {
                    // Reclaim scoped to the CALLER, never the old blob's true
                    // uploader. remove_file's WHERE clause is uploader-scoped;
                    // resolving the old file's real uploader and passing it here
                    // (as this used to) let an owner delete ANOTHER user's file:
                    // set the icon to the victim's file UUID, then replace it.
                    // With the new-icon ownership check above, a legitimately set
                    // icon was always uploaded by the caller, so caller-scoped
                    // reclaim still frees it; an icon uploaded by someone else is
                    // left as a (GC-able) orphan rather than deleted.
                    crate::upload_handlers::remove_file(&state.pool, old, claims.sub).await;
                }
            }
            StatusCode::OK.into_response()
        }
        Err(e) => {
            tracing::error!("Failed to update server settings: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save settings").into_response()
        }
    }
}

// --- Server Nickname Handlers ---

#[derive(Deserialize)]
pub struct SetNicknameRequest {
    pub nickname: Option<String>, // None or empty to clear
}

#[derive(Serialize)]
pub struct NicknameResponse {
    pub nickname: Option<String>,
}

/// Set or clear user's nickname for a server
pub async fn set_nickname(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<SetNicknameRequest>,
) -> impl IntoResponse {
    // Verify member
    let is_member: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2")
            .bind(&server_id)
            .bind(claims.sub as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    if is_member.is_none() {
        return (StatusCode::FORBIDDEN, "Not a member").into_response();
    }

    // Clean and validate nickname
    let nickname = payload
        .nickname
        .as_ref()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty() && n.len() <= 32);

    if let Some(nick) = &nickname {
        // Insert or update nickname
        let result = sqlx::query(
            "INSERT INTO server_nicknames (server_id, user_id, nickname, set_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (server_id, user_id) 
             DO UPDATE SET nickname = $3, set_at = NOW()",
        )
        .bind(&server_id)
        .bind(claims.sub as i32)
        .bind(nick)
        .execute(&state.pool)
        .await;

        if result.is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to set nickname").into_response();
        }

        tracing::info!(
            "[set_nickname] User {} set nickname to '{}' in server {}",
            claims.sub,
            nick,
            server_id
        );
    } else {
        // Clear nickname
        let _ = sqlx::query("DELETE FROM server_nicknames WHERE server_id = $1 AND user_id = $2")
            .bind(&server_id)
            .bind(claims.sub as i32)
            .execute(&state.pool)
            .await;

        tracing::info!(
            "[set_nickname] User {} cleared nickname in server {}",
            claims.sub,
            server_id
        );
    }

    Json(NicknameResponse { nickname }).into_response()
}

// --- Edit History ---

// --- User Status/Bio ---

#[allow(dead_code)]
#[derive(Deserialize)]
pub struct UpdateProfileRequest {
    pub status: Option<String>,
    pub custom_status: Option<String>,
    pub bio: Option<String>,
}

#[allow(dead_code)]
#[derive(Serialize)]
pub struct ProfileResponse {
    pub id: i64,
    pub username: String,
    pub status: Option<String>,
    pub custom_status: Option<String>,
    pub bio: Option<String>,
    pub avatar_file_id: Option<String>,
}

/// Update user profile (status, custom_status, bio)
#[allow(dead_code)]
pub async fn update_profile(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<UpdateProfileRequest>,
) -> impl IntoResponse {
    // Build dynamic update query
    let mut updates = Vec::new();
    let mut binds: Vec<String> = Vec::new();

    if let Some(ref status) = payload.status {
        updates.push("status = $1");
        binds.push(status.clone());
    }
    if let Some(ref custom_status) = payload.custom_status {
        updates.push("custom_status = $2");
        binds.push(custom_status.clone());
    }
    if let Some(ref bio) = payload.bio {
        updates.push("bio = $3");
        binds.push(bio.clone());
    }

    if updates.is_empty() {
        return StatusCode::OK.into_response();
    }

    let query = format!("UPDATE users SET {} WHERE id = $4", updates.join(", "));
    let mut q = sqlx::query(&query);
    for b in &binds {
        q = q.bind(b);
    }
    q = q.bind(claims.sub);

    match q.execute(&state.pool).await {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to update profile: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to update profile",
            )
                .into_response()
        }
    }
}

// --- Read Position / Unread Counts ---

#[derive(Serialize)]
pub struct UnreadCountResponse {
    pub channel_id: i64,
    pub unread_count: i64,
}

#[derive(Serialize)]
pub struct ServerUnreadResponse {
    pub channels: Vec<UnreadCountResponse>,
}

#[derive(Serialize)]
pub struct ServerAggregateUnread {
    pub server_id: String,
    pub unread_count: i64,
    /// The VIEW-permitted per-channel rows behind the total. The query has
    /// always computed these and summed them away; surfacing them lets the
    /// client's reconnect catch-up honour per-CHANNEL mutes the way the live
    /// path does (isChannelMuted is client-local state, so the filter cannot
    /// live here). Additive: old clients ignore it.
    pub channels: Vec<UnreadCountResponse>,
}

#[derive(Serialize)]
pub struct AllUnreadResponse {
    pub servers: Vec<ServerAggregateUnread>,
}

/// Mark a channel as read (update read position to current timestamp)
pub async fn mark_channel_read(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Access control: only members of the channel's server may touch read state.
    let is_member: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM channels c JOIN server_members sm ON sm.server_id = c.server_id \
         WHERE c.id = $1 AND sm.user_id = $2",
    )
    .bind(channel_id)
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    if is_member.is_none() {
        return (StatusCode::FORBIDDEN, "Not a member of this server").into_response();
    }

    // Use channel_read_state table which tracks last_read_at timestamp
    let result = sqlx::query(
        "INSERT INTO channel_read_state (user_id, channel_id, last_read_at) 
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_at = CURRENT_TIMESTAMP",
    )
    .bind(claims.sub as i32)
    .bind(channel_id)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to mark channel read: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to mark read").into_response()
        }
    }
}

/// Get unread counts for all channels in a server
pub async fn get_unread_counts(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Access control: only members may read a server's channel/unread structure.
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

    // Get all channels in the server and count unread messages for each.
    // Read the last-read timestamp from channel_read_state — the SAME table
    // mark_channel_read/mark_server_read write to (an earlier version queried a
    // never-created `read_positions` table, so counts always came back empty).
    // c.id is INT4; cast to bigint so it decodes into the i64 response field.
    // Don't count the caller's own messages as unread.
    // Single grouped join instead of a per-channel correlated COUNT subquery:
    // the read-state is joined once per channel and messages counted via one
    // LEFT JOIN the planner can serve from the messages(channel_id, created_at)
    // index — O(channels + matched messages) rather than O(channels × messages).
    let counts: Vec<(i64, i64)> = match sqlx::query_as(
        "SELECT c.id::bigint, COUNT(m.id) AS unread_count
         FROM channels c
         LEFT JOIN channel_read_state rp ON rp.user_id = $1 AND rp.channel_id = c.id
         LEFT JOIN messages m ON m.channel_id = c.id
             AND m.user_id != $1
             AND m.created_at > COALESCE(rp.last_read_at, '1970-01-01 00:00:00')
         WHERE c.server_id = $2
         GROUP BY c.id",
    )
    .bind(claims.sub as i32)
    .bind(&server_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(
                "get_unread_counts query failed for server {}: {:?}",
                server_id,
                e
            );
            Vec::new()
        }
    };

    // Hide VIEW-denied channels: list_channels filters them and the read paths
    // 404 them, so leaking their ids (and live activity) here would undo the
    // hide-existence invariant. Fail closed on resolver errors.
    let ids: Vec<i64> = counts.iter().map(|&(id, _)| id).collect();
    let perms = match crate::permissions::get_user_channels_permissions(
        &state.pool,
        &server_id,
        claims.sub,
        &ids,
    )
    .await
    {
        Ok(map) => map,
        Err(e) => {
            tracing::error!(
                "get_unread_counts: permission resolve failed for server {}: {:?}",
                server_id,
                e
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to resolve permissions",
            )
                .into_response();
        }
    };

    let channels: Vec<UnreadCountResponse> = counts
        .into_iter()
        .filter(|(channel_id, _)| {
            perms.get(channel_id).map_or(false, |p| {
                p.has(crate::permissions::Permissions::VIEW_CHANNEL)
            })
        })
        .map(|(channel_id, unread_count)| UnreadCountResponse {
            channel_id,
            unread_count,
        })
        .collect();

    Json(ServerUnreadResponse { channels }).into_response()
}

/// Cross-server unread totals, one row per server — the rail bubbles.
///
/// Same rules as get_unread_counts: only servers the caller belongs to, own
/// messages never count, and VIEW-denied channels contribute NOTHING (their
/// live activity leaking through an aggregate would undo the hide-existence
/// invariant). The inner join on messages keeps the permission resolve small:
/// only channels that actually have unread rows are resolved, not every
/// channel of every server on every poll.
pub async fn get_all_unread_counts(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let rows: Vec<(String, i64, i64)> = match sqlx::query_as(
        "SELECT c.server_id, c.id::bigint, COUNT(m.id) AS unread_count
         FROM server_members sm
         JOIN channels c ON c.server_id = sm.server_id
         LEFT JOIN channel_read_state rp ON rp.user_id = $1 AND rp.channel_id = c.id
         JOIN messages m ON m.channel_id = c.id
             AND m.user_id != $1
             AND m.created_at > COALESCE(rp.last_read_at, '1970-01-01 00:00:00')
         WHERE sm.user_id = $1
         GROUP BY c.server_id, c.id",
    )
    .bind(claims.sub as i32)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("get_all_unread_counts query failed: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to load unread counts")
                .into_response();
        }
    };

    // Group by server, then permission-filter per server. Fail closed on a
    // resolver error by contributing nothing for that server.
    let mut by_server: std::collections::HashMap<String, Vec<(i64, i64)>> =
        std::collections::HashMap::new();
    for (server_id, channel_id, unread) in rows {
        by_server.entry(server_id).or_default().push((channel_id, unread));
    }
    let mut servers: Vec<ServerAggregateUnread> = Vec::with_capacity(by_server.len());
    for (server_id, channels) in by_server {
        let ids: Vec<i64> = channels.iter().map(|&(id, _)| id).collect();
        let perms = match crate::permissions::get_user_channels_permissions(
            &state.pool,
            &server_id,
            claims.sub,
            &ids,
        )
        .await
        {
            Ok(map) => map,
            Err(e) => {
                tracing::error!(
                    "get_all_unread_counts: permission resolve failed for server {}: {:?}",
                    server_id,
                    e
                );
                continue;
            }
        };
        let permitted: Vec<UnreadCountResponse> = channels
            .into_iter()
            .filter(|(channel_id, _)| {
                perms.get(channel_id).map_or(false, |p| {
                    p.has(crate::permissions::Permissions::VIEW_CHANNEL)
                })
            })
            .map(|(channel_id, unread)| UnreadCountResponse {
                channel_id,
                unread_count: unread,
            })
            .collect();
        let total: i64 = permitted.iter().map(|c| c.unread_count).sum();
        if total > 0 {
            servers.push(ServerAggregateUnread {
                server_id,
                unread_count: total,
                channels: permitted,
            });
        }
    }

    Json(AllUnreadResponse { servers }).into_response()
}

/// Mark all channels in a server as read
pub async fn mark_server_read(
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

    let result = sqlx::query(
        "INSERT INTO channel_read_state (user_id, channel_id, last_read_at)
         SELECT $1, c.id, CURRENT_TIMESTAMP
         FROM channels c
         WHERE c.server_id = $2
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_at = CURRENT_TIMESTAMP",
    )
    .bind(claims.sub as i32)
    .bind(&server_id)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to mark server read: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to mark read").into_response()
        }
    }
}

// --- Voice Users State ---

#[derive(Serialize)]
pub struct VoiceUserInfo {
    pub room_id: String,
    pub user_id: i64,
    pub username: String,
}

#[derive(Serialize)]
pub struct VoiceUsersResponse {
    pub voice_users: Vec<VoiceUserInfo>,
}

/// Get all active voice users in this server's voice channels
/// This is called when a user loads a server to populate the sidebar with current voice users
pub async fn get_voice_users(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Verify user is a member of the server (i32: server_members.user_id is INT4) —
    // otherwise any authenticated user could see who is in voice on any server.
    let is_member = sqlx::query_as::<_, (i32,)>(
        "SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2",
    )
    .bind(&server_id)
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if is_member.is_none() {
        return (StatusCode::FORBIDDEN, "Not a member of this server").into_response();
    }

    // Voice rooms are keyed per-channel. Accept the new namespaced id
    // `voice_<channelId>` AND, for backward-compat while clients roll over, the
    // legacy bare channel name — restricting to this server's channels so we
    // don't leak voice presence from every server.
    // channels.id is SERIAL (INT4) — decode as i32, not i64 (an INT4→i64 decode
    // fails at runtime and unwrap_or_default would silently blank voice presence).
    let channels: Vec<(i32, String)> =
        sqlx::query_as("SELECT id, name FROM channels WHERE server_id = $1")
            .bind(&server_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    // Only surface voice presence for channels the caller can VIEW — a hidden
    // channel's occupants would otherwise leak through the sidebar roster.
    let ids: Vec<i64> = channels.iter().map(|&(id, _)| id as i64).collect();
    let perms = match crate::permissions::get_user_channels_permissions(
        &state.pool,
        &server_id,
        claims.sub,
        &ids,
    )
    .await
    {
        Ok(map) => map,
        Err(e) => {
            tracing::error!(
                "get_voice_users: permission resolve failed for server {}: {:?}",
                server_id,
                e
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to resolve permissions",
            )
                .into_response();
        }
    };
    let accepted_rooms: std::collections::HashSet<String> = channels
        .into_iter()
        .filter(|(id, _)| {
            perms.get(&(*id as i64)).map_or(false, |p| {
                p.has(crate::permissions::Permissions::VIEW_CHANNEL)
            })
        })
        .flat_map(|(id, name)| [format!("voice_{}", id), name])
        .collect();

    let mut voice_users = Vec::new();
    for room in state.rooms.iter() {
        if !accepted_rooms.contains(&room.id) {
            continue;
        }
        // Get streamers (users who are in voice)
        for &streamer_id in &room.streamers {
            if let Some(username) = state.get_username(streamer_id) {
                voice_users.push(VoiceUserInfo {
                    room_id: room.id.clone(),
                    user_id: streamer_id,
                    username,
                });
            }
        }
    }

    tracing::debug!(
        "Returning {} voice users for server {}",
        voice_users.len(),
        server_id
    );

    Json(VoiceUsersResponse { voice_users }).into_response()
}

// --- WebRTC ICE Configuration ---

/// Get ICE configuration for WebRTC peer connections.
///
/// No third-party relay: media only ever traverses a server we control. Every
/// caller gets Google STUN (address discovery only — never carries media);
/// callers presenting a valid JWT additionally get time-limited credentials for
/// our self-hosted TURN relay when TURN_SERVER/TURN_SECRET are configured
/// (standard TURN REST mechanism, gated behind auth so strangers can't farm the
/// relay). Symmetric-NAT peers with no reachable TURN simply won't connect —
/// the correct privacy-preserving default, vs. silently relaying through a
/// stranger's server. (Self-hosted TURN was verified end-to-end 2026-07-21, so
/// the former OpenRelay fallback was removed.)
pub async fn get_ice_config(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    // Address-discovery STUN. Operator-controlled via STUN_SERVERS (comma
    // separated), which REPLACES the list rather than adding to it, and can be
    // set empty to use none at all.
    //
    // The Google servers below were hardcoded in both branches of the match
    // further down, so even a deployment with its own fully-configured coturn
    // still had every participant's client contact Google on every ICE gather —
    // disclosing their IP address and the timing of every call to a third party,
    // on a product whose entire premise is self-hosting. They remain the DEFAULT
    // (STUN is what makes P2P work behind NAT, and most self-hosters have no
    // alternative to hand), but they are now a default an operator can change.
    let stun_urls: Vec<String> = match std::env::var("STUN_SERVERS") {
        Ok(v) => v
            .split(',')
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .collect(),
        Err(_) => vec![
            "stun:stun.l.google.com:19302".to_string(),
            "stun:stun1.l.google.com:19302".to_string(),
            "stun:stun2.l.google.com:19302".to_string(),
            "stun:stun3.l.google.com:19302".to_string(),
        ],
    };
    let google_stun = IceServer {
        urls: stun_urls,
        username: None,
        credential: None,
    };

    // Optional auth: a valid Bearer token unlocks self-hosted TURN credentials.
    // This route sits OUTSIDE jwt_auth_middleware, so the M1 revocation check
    // has to be repeated here — validate_token covers only signature and exp.
    // Without it a token revoked by logout / password change / recovery reset /
    // account deletion kept minting 4-hour relay credentials.
    let claims = match headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|t| crate::auth::validate_token(t, &state.jwt_secret).ok())
    {
        Some(c) => {
            let current_tv: Option<(i32,)> =
                sqlx::query_as("SELECT token_version FROM users WHERE id = $1")
                    .bind(c.sub as i32)
                    .fetch_optional(&state.pool)
                    .await
                    .unwrap_or(None);
            match current_tv {
                Some((tv,)) if tv == c.tv => Some(c),
                // Fail closed: unknown user, revoked token, or a failed lookup
                // falls back to the public STUN-only response below.
                _ => None,
            }
        }
        None => None,
    };

    let self_hosted_turn = claims.as_ref().and_then(|claims| {
        // Reject a set-but-empty/whitespace secret: an empty HMAC key would mint
        // credentials any stranger could forge offline, defeating the auth gate.
        let turn_server = std::env::var("TURN_SERVER")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let turn_secret = std::env::var("TURN_SECRET")
            .ok()
            .filter(|s| !s.trim().is_empty())?;

        // Time-limited credentials (TURN REST API mechanism, RFC-draft):
        // username = "<expiry>:<user id>", credential = base64(HMAC-SHA1(secret, username)).
        // The user id in the username lets relay abuse be traced to an account.
        // 4h validity: long enough to outlast any realistic call (incl. long
        // AFK-gaming/screen-share sessions) and the 2h client cache (TURN-TTL
        // step 2 — step 1 shrunk the client cache 6h->2h), short enough to
        // bound abuse from a leaked credential. A pre-epoch clock yields 0,
        // producing an already-expired username (coturn rejects) rather than a
        // panic — media just stays non-relayed instead of crashing the request.
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let timestamp = now_secs + 14400; // 4h
        let username = format!("{}:{}", timestamp, claims.sub);

        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        use hmac::{Hmac, Mac};
        use sha1::Sha1;
        type HmacSha1 = Hmac<Sha1>;

        let mut mac = HmacSha1::new_from_slice(turn_secret.as_bytes()).ok()?;
        mac.update(username.as_bytes());
        let credential = BASE64.encode(mac.finalize().into_bytes());

        Some(IceServer {
            // TURN_SERVER may hold several comma-separated URLs
            // (e.g. "turn:host:3479?transport=udp,turn:host:3479?transport=tcp").
            urls: turn_server
                .split(',')
                .map(|u| u.trim().to_string())
                .collect(),
            username: Some(username),
            credential: Some(credential),
        })
    });

    // An empty STUN list (STUN_SERVERS="") must not produce an IceServer with no
    // urls — some stacks reject that outright.
    let stun = if google_stun.urls.is_empty() { None } else { Some(google_stun) };
    let ice_servers: Vec<IceServer> = match (self_hosted_turn, stun) {
        // Authenticated + self-hosted TURN configured: list our relay FIRST — it's
        // LAN-local, so ICE prefers its (lower-latency) relay candidate. STUN is
        // address discovery only (never carries media).
        (Some(turn), Some(stun)) => vec![turn, stun],
        (Some(turn), None) => vec![turn],
        // Anonymous, or TURN not configured: STUN-only (address discovery). No
        // third-party relay — media never traverses a server we don't control.
        (None, Some(stun)) => vec![stun],
        (None, None) => vec![],
    };

    let config = IceConfiguration {
        ice_servers,
        ice_transport_policy: "all".to_string(), // Try P2P first, then relay
    };

    Json(config).into_response()
}

#[cfg(test)]
mod afk_timeout_tests {
    use super::afk_timeout_valid;

    /// The five Discord options pass; everything else — including the
    /// plausible-looking neighbours an off-by-one or a "just allow any
    /// minute count" refactor would let through — is refused.
    #[test]
    fn only_discords_five_options_are_valid() {
        for ok in [1, 5, 15, 30, 60] {
            assert!(afk_timeout_valid(ok), "{ok} must be a valid AFK timeout");
        }
        for bad in [0, -1, 2, 10, 14, 16, 20, 45, 59, 61, 120, i32::MAX, i32::MIN] {
            assert!(!afk_timeout_valid(bad), "{bad} must be refused");
        }
    }
}
