//! Channel Handlers
//!
//! REST API handlers for channel management.

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::Claims;
use crate::permissions::{
    get_user_channel_permissions, get_user_channels_permissions, get_user_server_permissions,
    ChannelPermAccess, Permissions,
};
use crate::state::AppState;

// Re-export permission helpers from server_handlers for now
pub use crate::permissions::user_has_permission;

/// Caps for user-supplied channel text (bytes). Names/descriptions are stored
/// and (for names) fanned out to every online member, so bound them.
const MAX_CHANNEL_NAME_LEN: usize = 100;
const MAX_CHANNEL_DESC_LEN: usize = 1024;
/// Bound the N+1 feed fan-out (one query per child channel).
const MAX_FEED_CHILDREN: usize = 50;

// --- DTOs ---

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(default)]
    pub channel_type: i32, // 0 = Text, 1 = Voice
    pub category_id: Option<i32>,
    pub parent_id: Option<i32>,
    /// AFK voice channel (members can't transmit; idle users get moved here).
    #[serde(default)]
    pub is_afk: bool,
    /// Checklist channel: a text channel whose main view is a Keep-style
    /// checklist instead of a message stream.
    #[serde(default)]
    pub has_checklist: bool,
}

#[derive(Serialize)]
pub struct ChannelResponse {
    pub id: i64,
    pub name: String,
    pub channel_type: i32,
    pub server_id: Option<String>,
    pub description: Option<String>,
    pub parent_id: Option<i64>,
    pub slowmode_seconds: i32,
    pub is_afk: bool,
    pub has_checklist: bool,
    /// Tier-2 SFU voice channel: clients join via LiveKit instead of the mesh.
    pub sfu_mode: bool,
    /// The requester's resolved effective permission bits for this channel
    /// (roles + overwrites). An ADMINISTRATOR bit means the UI treats
    /// everything as granted.
    pub my_permissions: i64,
}

#[derive(Deserialize)]
pub struct UpdateChannelRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    /// i32, MATCHING CreateChannelRequest and the INT4 column — not i64.
    /// With i64 here, the reparent guard (which binds i32 to share the
    /// statement-cache width of "SELECT server_id FROM channels WHERE id =
    /// $1") could approve a TRUNCATED id while the UPDATE below wrote the
    /// full 64-bit value into the INT4 column — an "integer out of range"
    /// 500 for a request that used to 400 cleanly. Narrowing the field makes
    /// serde reject out-of-range JSON at the door, and the guard and the
    /// write can no longer disagree. (Review finding on the 0.8.110 diff.)
    pub parent_id: Option<i32>, // Change parent collection
    pub slowmode_seconds: Option<i32>,
    /// Toggle AFK on an existing voice channel.
    pub is_afk: Option<bool>,
    /// Toggle checklist mode on an existing text channel.
    pub has_checklist: Option<bool>,
    /// Toggle SFU mode on an existing voice channel. Read at join time; live
    /// calls keep the transport they started with.
    pub sfu_mode: Option<bool>,
}

#[derive(Deserialize)]
pub struct ReorderChannelsRequest {
    /// List of channel IDs in the desired order
    pub channel_ids: Vec<i64>,
}

#[derive(Serialize)]
pub struct FeedMessage {
    pub id: String,
    pub channel_id: i64,
    pub user_id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub content: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct ChannelFeedChild {
    pub id: i64,
    pub name: String,
    pub messages: Vec<FeedMessage>,
}

#[derive(Serialize)]
pub struct ChannelFeedResponse {
    pub id: i64,
    pub children: Vec<ChannelFeedChild>,
}

// --- Handlers ---

/// List channels in a server
pub async fn list_channels(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    tracing::info!(
        ">>> list_channels called for server: {} by user: {}",
        server_id,
        claims.sub
    );

    // Verify user is member of server (use i32 for PostgreSQL INT4)
    let is_member_result = sqlx::query_as::<_, (i32,)>(
        "SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2",
    )
    .bind(&server_id)
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await;

    let is_member = match is_member_result {
        Ok(m) => {
            tracing::info!("  Membership check result: {:?}", m.is_some());
            m
        }
        Err(e) => {
            tracing::error!("  Membership check failed: {:?}", e);
            None
        }
    };

    if is_member.is_none() {
        tracing::error!(
            "  User {} is not a member of server {}",
            claims.sub,
            server_id
        );
        return (StatusCode::FORBIDDEN, "Not a member of this server").into_response();
    }

    let channels_result = sqlx::query_as::<_, (i32, String, i32, Option<String>, Option<String>, Option<i32>, i32, bool, bool, bool)>(
        "SELECT id, name, type, server_id, description, parent_id, COALESCE(slowmode_seconds, 0), COALESCE(is_afk, false), COALESCE(has_checklist, false), COALESCE(sfu_mode, false) FROM channels WHERE server_id = $1 ORDER BY position ASC"
    )
    .bind(&server_id)
    .fetch_all(&state.pool)
    .await;

    let channels = match channels_result {
        Ok(c) => {
            tracing::info!("  Found {} channels", c.len());
            c
        }
        Err(e) => {
            tracing::error!("  Failed to fetch channels: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to list channels").into_response();
        }
    };

    // Resolve the requester's effective permissions for EVERY channel in one
    // pass (single overwrites query — no N+1), then hide VIEW-denied channels
    // entirely and attach my_permissions to the rest. Fail closed: a resolver
    // error refuses the request instead of defaulting open.
    let channel_ids: Vec<i64> = channels.iter().map(|c| c.0 as i64).collect();
    let perms_map = match get_user_channels_permissions(
        &state.pool,
        &server_id,
        claims.sub,
        &channel_ids,
    )
    .await
    {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("  Failed to resolve channel permissions: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to list channels").into_response();
        }
    };

    let response: Vec<ChannelResponse> = channels
        .into_iter()
        .filter_map(
            |(
                id,
                name,
                channel_type,
                server_id,
                description,
                parent_id,
                slowmode_seconds,
                is_afk,
                has_checklist,
                sfu_mode,
            )| {
                let perms = perms_map
                    .get(&(id as i64))
                    .copied()
                    .unwrap_or(Permissions::empty());
                if !perms.has(Permissions::VIEW_CHANNEL) {
                    return None;
                }
                Some(ChannelResponse {
                    id: id as i64,
                    name,
                    channel_type,
                    server_id,
                    description,
                    parent_id: parent_id.map(|p| p as i64),
                    slowmode_seconds,
                    is_afk,
                    has_checklist,
                    sfu_mode,
                    my_permissions: perms.bits() as i64,
                })
            },
        )
        .collect();

    Json(response).into_response()
}

/// Create a channel in a server
pub async fn create_channel(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateChannelRequest>,
) -> impl IntoResponse {
    // Check user has MANAGE_CHANNELS permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_CHANNELS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MANAGE_CHANNELS permission").into_response();
    }

    // Cap the name before it is stored and fanned out to every online member
    // via the ChannelCreated broadcast (an N-member echo of the string).
    if payload.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "Channel name cannot be empty").into_response();
    }
    if payload.name.len() > MAX_CHANNEL_NAME_LEN {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Channel name too long").into_response();
    }

    // The parent and category come from the BODY, so they must be re-checked
    // against the PATH server — the permission check above only covers the
    // path. update_channel has carried this guard for reparenting since the
    // role-cluster audit; creation was left trusting the client, so a caller
    // with MANAGE_CHANNELS on their own server could create a channel already
    // grafted under another server's collection channel (the FK enforces
    // existence, not same-server) and inject content into that server's feed.
    if let Some(parent_id) = payload.parent_id {
        // Width matched to this text's siblings (channels.id is INT4; a
        // no-op cast at the create site, the fix at the update site — see
        // the 22P03 note in device_token.rs).
        let parent_server: Option<(Option<String>,)> =
            sqlx::query_as("SELECT server_id FROM channels WHERE id = $1")
                .bind(parent_id as i32)
                .fetch_optional(&state.pool)
                .await
                .unwrap_or(None);
        match parent_server {
            Some((Some(ref psid),)) if *psid == server_id => {}
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "Parent channel must be in the same server",
                )
                    .into_response()
            }
        }
    }
    if let Some(category_id) = payload.category_id {
        let cat_server: Option<(String,)> =
            sqlx::query_as("SELECT server_id FROM channel_categories WHERE id = $1")
                .bind(category_id)
                .fetch_optional(&state.pool)
                .await
                .unwrap_or(None);
        match cat_server {
            Some((csid,)) if csid == server_id => {}
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "Category must be in the same server",
                )
                    .into_response()
            }
        }
    }

    // Get max position
    let max_pos: Option<(i32,)> =
        sqlx::query_as("SELECT COALESCE(MAX(position), 0) FROM channels WHERE server_id = $1")
            .bind(&server_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    let position = max_pos.map(|p| p.0 + 1).unwrap_or(0);

    // AFK only applies to voice channels.
    let is_afk = payload.is_afk && payload.channel_type == 1;
    // Checklist mode only applies to text channels.
    let has_checklist = payload.has_checklist && payload.channel_type == 0;
    let result: Result<(i32,), _> = sqlx::query_as(
        "INSERT INTO channels (name, type, position, server_id, category_id, parent_id, is_afk, has_checklist) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id"
    )
    .bind(&payload.name)
    .bind(payload.channel_type)
    .bind(position)
    .bind(&server_id)
    .bind(payload.category_id)  // category_id for $5
    .bind(payload.parent_id)    // parent_id for $6
    .bind(is_afk)               // is_afk for $7
    .bind(has_checklist)        // has_checklist for $8
    .fetch_one(&state.pool)
    .await;

    match result {
        Ok((channel_id,)) => {
            // Broadcast the new channel to online members of THIS server,
            // authoritatively. Previously the client emitted a ChannelCreated WS
            // message that the server rebroadcast to everyone unvalidated, so any
            // authenticated user could inject a fake channel with an
            // attacker-chosen server_id. Building it here from the trusted insert
            // (and no longer trusting the client event) closes that.
            //
            // Recipients are limited to members whose BASE server permissions
            // hold VIEW_CHANNEL (or ADMINISTRATOR, or ownership) — a brand-new
            // channel has no overwrites yet, so base perms fully determine VIEW,
            // which makes this a single query instead of a per-member resolve.
            let view_or_admin =
                (Permissions::VIEW_CHANNEL | Permissions::ADMINISTRATOR).bits() as i64;
            let members: Vec<(i32,)> = sqlx::query_as(
                "SELECT sm.user_id FROM server_members sm \
                 WHERE sm.server_id = $1 \
                   AND (EXISTS (SELECT 1 FROM servers s \
                                WHERE s.id = sm.server_id AND s.owner_id = sm.user_id) \
                        OR EXISTS (SELECT 1 FROM server_roles sr \
                                   LEFT JOIN member_roles mr \
                                     ON mr.role_id = sr.id AND mr.user_id = sm.user_id \
                                        AND mr.server_id = sr.server_id \
                                   WHERE sr.server_id = sm.server_id \
                                     AND (sr.is_default = true OR mr.user_id IS NOT NULL) \
                                     AND (sr.permissions & $2) <> 0))",
            )
            .bind(&server_id)
            .bind(view_or_admin)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();
            let channel_info = crate::protocol::ChannelInfo {
                id: channel_id as i64,
                name: payload.name.clone(),
                channel_type: payload.channel_type,
                server_id: Some(server_id.clone()),
                parent_id: payload.parent_id.map(|p| p as i64),
                is_afk,
                has_checklist,
            };
            for (member_id,) in members {
                if member_id as i64 != claims.sub {
                    state.send_to_user(
                        member_id as i64,
                        crate::protocol::ServerMessage::ChannelCreated {
                            server_id: server_id.clone(),
                            channel: channel_info.clone(),
                        },
                    );
                }
            }

            // The creator's effective bits on the new channel = their base
            // server permissions (no overwrites exist yet).
            let my_permissions =
                get_user_server_permissions(&state.pool, &server_id, claims.sub).await;

            Json(ChannelResponse {
                id: channel_id as i64,
                name: payload.name,
                channel_type: payload.channel_type,
                server_id: Some(server_id),
                description: None,
                parent_id: payload.parent_id.map(|p| p as i64),
                slowmode_seconds: 0,
                is_afk,
                has_checklist,
                sfu_mode: false,
                my_permissions: my_permissions.bits() as i64,
            })
            .into_response()
        }
        Err(e) => {
            tracing::error!("Failed to create channel: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to create channel",
            )
                .into_response()
        }
    }
}

/// Update a channel's name or description
pub async fn update_channel(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<UpdateChannelRequest>,
) -> impl IntoResponse {
    // Get channel's server_id to check permissions.
    // WIDTH MATCHED TO THE SIBLINGS OF THIS SQL TEXT, deliberately: sqlx
    // caches prepared statements per connection KEYED BY THE TEXT ALONE, so
    // every user of one text must bind the same widths or whoever prepares
    // second inherits the first's parameter types and gets an intermittent
    // 22P03 "incorrect binary data format" — the cold-boot device-token 500
    // of 2026-08-20 (the long version lives in device_token.rs).
    let channel: Option<(Option<String>,)> =
        sqlx::query_as("SELECT server_id FROM channels WHERE id = $1")
            .bind(channel_id as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    let server_id = match channel {
        Some((Some(sid),)) => sid,
        _ => return (StatusCode::NOT_FOUND, "Channel not found").into_response(),
    };

    // Check manage channels permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_CHANNELS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing manage channels permission").into_response();
    }

    // If reparenting, the new parent MUST belong to the same server. The FK only
    // enforces existence, not same-server — without this a caller with
    // MANAGE_CHANNELS on their own server could graft their channel under another
    // server's collection channel and inject content into that server's feed.
    if let Some(parent_id) = payload.parent_id {
        // Width matched to this text's siblings (channels.id is INT4; a
        // no-op cast at the create site, the fix at the update site — see
        // the 22P03 note in device_token.rs).
        let parent_server: Option<(Option<String>,)> =
            sqlx::query_as("SELECT server_id FROM channels WHERE id = $1")
                .bind(parent_id as i32)
                .fetch_optional(&state.pool)
                .await
                .unwrap_or(None);
        match parent_server {
            Some((Some(psid),)) if psid == server_id => {}
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "Parent channel must be in the same server",
                )
                    .into_response()
            }
        }
    }

    // Cap any provided name/description before storing/broadcasting.
    if let Some(name) = payload.name.as_deref() {
        if name.len() > MAX_CHANNEL_NAME_LEN {
            return (StatusCode::PAYLOAD_TOO_LARGE, "Channel name too long").into_response();
        }
    }
    if let Some(desc) = payload.description.as_deref() {
        if desc.len() > MAX_CHANNEL_DESC_LEN {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                "Channel description too long",
            )
                .into_response();
        }
    }

    // Simple COALESCE-based update - if field is provided, use it, otherwise keep existing
    let result = sqlx::query(
        r#"UPDATE channels SET
            name = COALESCE($1, name),
            description = COALESCE($2, description),
            parent_id = CASE WHEN $3::boolean THEN $4::int ELSE parent_id END,
            slowmode_seconds = COALESCE($6, slowmode_seconds),
            is_afk = COALESCE($7, is_afk),
            has_checklist = COALESCE($8, has_checklist),
            sfu_mode = COALESCE($9, sfu_mode)
        WHERE id = $5"#,
    )
    .bind(&payload.name)
    .bind(&payload.description)
    .bind(payload.parent_id.is_some()) // Flag: should we update parent_id?
    .bind(payload.parent_id) // The actual new parent_id value (can be null to remove parent)
    .bind(channel_id)
    .bind(payload.slowmode_seconds)
    .bind(payload.is_afk)
    .bind(payload.has_checklist)
    .bind(payload.sfu_mode)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to update channel: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to update channel",
            )
                .into_response()
        }
    }
}

/// Delete a channel
pub async fn delete_channel(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Get channel's server and verify user is member.
    // Width matched to this text's siblings (see update_channel above).
    let channel: Option<(String,)> = sqlx::query_as("SELECT server_id FROM channels WHERE id = $1")
        .bind(channel_id as i32)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);

    let server_id = match channel {
        Some((sid,)) => sid,
        None => return (StatusCode::NOT_FOUND, "Channel not found").into_response(),
    };

    // Check user has MANAGE_CHANNELS permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_CHANNELS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MANAGE_CHANNELS permission").into_response();
    }

    let _ = sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(channel_id)
        .execute(&state.pool)
        .await;

    StatusCode::NO_CONTENT.into_response()
}

/// Reorder channels in a server
pub async fn reorder_channels(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<ReorderChannelsRequest>,
) -> impl IntoResponse {
    // Check manage channels permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_CHANNELS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing manage channels permission").into_response();
    }

    // Bound the work: this does one DB round-trip per element, so an oversized
    // array would monopolize a pooled connection. No real server has this many
    // channels.
    if payload.channel_ids.len() > 500 {
        return (
            StatusCode::BAD_REQUEST,
            "Too many channels in one reorder request",
        )
            .into_response();
    }

    // Update positions in a REAL transaction — this comment used to lie: each
    // UPDATE ran on the pool independently, so an error mid-loop left a partially
    // reordered channel list. Commit all-or-nothing instead.
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("Failed to begin reorder transaction: {:?}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to reorder channels",
            )
                .into_response();
        }
    };

    for (position, channel_id) in payload.channel_ids.iter().enumerate() {
        let result =
            sqlx::query("UPDATE channels SET position = $1 WHERE id = $2 AND server_id = $3")
                .bind(position as i32)
                .bind(channel_id)
                .bind(&server_id)
                .execute(&mut *tx)
                .await;

        if let Err(e) = result {
            tracing::error!("Failed to update channel position: {:?}", e);
            let _ = tx.rollback().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to reorder channels",
            )
                .into_response();
        }
    }

    if let Err(e) = tx.commit().await {
        tracing::error!("Failed to commit channel reorder: {:?}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to reorder channels",
        )
            .into_response();
    }

    StatusCode::OK.into_response()
}

/// Get aggregated feed for a collection channel
pub async fn get_channel_feed(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // 1. Get channel type and server_id to check permissions
    let channel: Option<(i32, Option<String>)> =
        sqlx::query_as("SELECT type, server_id FROM channels WHERE id = $1")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    let (channel_type, server_id) = match channel {
        Some((t, Some(sid))) => (t, sid),
        _ => return (StatusCode::NOT_FOUND, "Channel not found").into_response(),
    };

    // Reads require VIEW_CHANNEL on the collection: a member who is VIEW-denied
    // gets 404 (hide the channel's existence); non-members keep 403.
    match get_user_channel_permissions(&state.pool, channel_id, claims.sub).await {
        ChannelPermAccess::Allowed { perms, .. } if perms.has(Permissions::VIEW_CHANNEL) => {}
        ChannelPermAccess::Allowed { .. } | ChannelPermAccess::NotFound => {
            return (StatusCode::NOT_FOUND, "Channel not found").into_response()
        }
        ChannelPermAccess::NotMember => {
            return (StatusCode::FORBIDDEN, "Not a member of this server").into_response()
        }
    }

    // 2. If not a collection (type 2), return bad request? Or just empty children?
    // Let's allow it but it will have 0 children if it's not a collection logic-wise,
    // or strictly enforce type 2.
    if channel_type != 2 {
        // return (StatusCode::BAD_REQUEST, "Channel is not a collection").into_response();
        // Actually, maybe better to just return empty children if implementation changes.
        // But user asked "If channel type is 'collection'".
    }

    // 3. Find child channels (capped — the loop below runs one query per child,
    // so an unbounded child count would be an N+1 round-trip amplifier).
    let children: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, name FROM channels WHERE parent_id = $1 ORDER BY position ASC LIMIT $2",
    )
    .bind(channel_id)
    .bind(MAX_FEED_CHILDREN as i64)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    // Children carry their OWN overwrites — a VIEW-denied child must not leak
    // its messages through the parent's feed. One bulk query for all children;
    // fail closed (deny all) on resolver error.
    let child_ids: Vec<i64> = children.iter().map(|(id, _)| *id as i64).collect();
    let child_perms = match get_user_channels_permissions(
        &state.pool,
        &server_id,
        claims.sub,
        &child_ids,
    )
    .await
    {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("Failed to resolve feed child permissions: {:?}", e);
            std::collections::HashMap::new()
        }
    };

    let mut feed_children = Vec::new();

    for (child_id, child_name) in children {
        let visible = child_perms
            .get(&(child_id as i64))
            .map(|p| p.has(Permissions::VIEW_CHANNEL))
            .unwrap_or(false);
        if !visible {
            continue;
        }
        // 4. Fetch last 5 messages for each child
        let messages: Vec<(String, i32, i32, String, Option<String>, String, String)> = sqlx::query_as(
            r#"
            SELECT m.id, m.channel_id, m.user_id, u.username, u.display_name, m.content, (replace(m.created_at::text, ' ', 'T') || 'Z') AS created_at
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.channel_id = $1
            ORDER BY m.created_at DESC
            LIMIT 5
            "#
        )
        .bind(child_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

        let feed_messages: Vec<FeedMessage> = messages
            .into_iter()
            .rev()
            .map(
                |(id, cid, uid, uname, dname, content, created)| FeedMessage {
                    id,
                    channel_id: cid as i64,
                    user_id: uid as i64,
                    username: uname,
                    display_name: dname,
                    content,
                    created_at: created,
                },
            )
            .collect();

        feed_children.push(ChannelFeedChild {
            id: child_id as i64,
            name: child_name,
            messages: feed_messages,
        });
    }

    Json(ChannelFeedResponse {
        id: channel_id,
        children: feed_children,
    })
    .into_response()
}

// --- Channel permission overwrites ---

#[derive(Serialize)]
pub struct OverwriteResponse {
    pub role_id: i64,
    pub allow: i64,
    pub deny: i64,
}

#[derive(Deserialize)]
pub struct PutOverwriteRequest {
    pub allow: i64,
    pub deny: i64,
}

/// Resolve a channel's owning server and require MANAGE_CHANNELS on it.
/// Shared gate for the overwrite CRUD endpoints.
async fn require_manage_channels(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
) -> Result<String, (StatusCode, &'static str)> {
    // Width matched to this text's siblings (see update_channel).
    let channel: Option<(Option<String>,)> =
        match sqlx::query_as("SELECT server_id FROM channels WHERE id = $1")
            .bind(channel_id as i32)
            .fetch_optional(&state.pool)
            .await
        {
            Ok(row) => row,
            Err(e) => {
                tracing::error!(
                    "Overwrite gate: channel lookup failed for {}: {:?}",
                    channel_id,
                    e
                );
                return Err((StatusCode::NOT_FOUND, "Channel not found"));
            }
        };

    let server_id = match channel {
        Some((Some(sid),)) => sid,
        _ => return Err((StatusCode::NOT_FOUND, "Channel not found")),
    };

    if !user_has_permission(
        &state.pool,
        &server_id,
        user_id,
        Permissions::MANAGE_CHANNELS,
    )
    .await
    {
        return Err((StatusCode::FORBIDDEN, "Missing MANAGE_CHANNELS permission"));
    }
    Ok(server_id)
}

/// List a channel's permission overwrites (managers only).
pub async fn list_overwrites(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    if let Err(e) = require_manage_channels(&state, channel_id, claims.sub).await {
        return e.into_response();
    }

    let rows: Vec<(i64, i64, i64)> = match sqlx::query_as(
        "SELECT role_id, allow, deny FROM channel_permission_overwrites \
         WHERE channel_id = $1 ORDER BY role_id ASC",
    )
    .bind(channel_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(
                "Failed to list overwrites for channel {}: {:?}",
                channel_id,
                e
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to list overwrites",
            )
                .into_response();
        }
    };

    let response: Vec<OverwriteResponse> = rows
        .into_iter()
        .map(|(role_id, allow, deny)| OverwriteResponse {
            role_id,
            allow,
            deny,
        })
        .collect();
    Json(response).into_response()
}

/// Create or replace a role's overwrite on a channel (managers only).
pub async fn put_overwrite(
    State(state): State<Arc<AppState>>,
    Path((channel_id, role_id)): Path<(i64, i64)>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<PutOverwriteRequest>,
) -> impl IntoResponse {
    let server_id = match require_manage_channels(&state, channel_id, claims.sub).await {
        Ok(sid) => sid,
        Err(e) => return e.into_response(),
    };

    // A bit cannot be both allowed and denied at once.
    if payload.allow & payload.deny != 0 {
        return (StatusCode::BAD_REQUEST, "allow and deny overlap").into_response();
    }

    // Only channel-scoped bits may be overwritten. Without this mask a
    // MANAGE_CHANNELS holder could put allow=ADMINISTRATOR (or -1) on a role
    // and the resolver would fold it into effective channel permissions.
    let overwritable = Permissions::OVERWRITABLE.bits() as i64;
    if payload.allow < 0 || payload.deny < 0 || (payload.allow | payload.deny) & !overwritable != 0
    {
        return (
            StatusCode::BAD_REQUEST,
            "Unsupported permission bits in overwrite",
        )
            .into_response();
    }

    // The role must belong to the channel's server — otherwise a manager could
    // attach a foreign server's role id and confuse that server's resolution.
    let role_in_server: Option<(i32,)> =
        match sqlx::query_as("SELECT 1 FROM server_roles WHERE id = $1 AND server_id = $2")
            .bind(role_id)
            .bind(&server_id)
            .fetch_optional(&state.pool)
            .await
        {
            Ok(row) => row,
            Err(e) => {
                tracing::error!(
                    "put_overwrite: role lookup failed for role {} server {}: {:?}",
                    role_id,
                    server_id,
                    e
                );
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to save overwrite",
                )
                    .into_response();
            }
        };
    if role_in_server.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            "Role is not in this channel's server",
        )
            .into_response();
    }

    let result = sqlx::query(
        "INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (channel_id, role_id) \
         DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny",
    )
    .bind(channel_id)
    .bind(role_id)
    .bind(payload.allow)
    .bind(payload.deny)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => {
            crate::ws::broadcast_perms_changed_and_evict(&state, &server_id).await;
            StatusCode::OK.into_response()
        }
        Err(e) => {
            tracing::error!(
                "Failed to upsert overwrite for channel {}: {:?}",
                channel_id,
                e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to save overwrite",
            )
                .into_response()
        }
    }
}

/// Delete a role's overwrite on a channel (managers only).
pub async fn delete_overwrite(
    State(state): State<Arc<AppState>>,
    Path((channel_id, role_id)): Path<(i64, i64)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let server_id = match require_manage_channels(&state, channel_id, claims.sub).await {
        Ok(sid) => sid,
        Err(e) => return e.into_response(),
    };

    let result = sqlx::query(
        "DELETE FROM channel_permission_overwrites WHERE channel_id = $1 AND role_id = $2",
    )
    .bind(channel_id)
    .bind(role_id)
    .execute(&state.pool)
    .await;

    match result {
        Ok(res) => {
            // Only a real change needs the broadcast + eviction pass.
            if res.rows_affected() > 0 {
                crate::ws::broadcast_perms_changed_and_evict(&state, &server_id).await;
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            tracing::error!(
                "Failed to delete overwrite for channel {}: {:?}",
                channel_id,
                e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to delete overwrite",
            )
                .into_response()
        }
    }
}
