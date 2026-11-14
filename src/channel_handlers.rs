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
/// The channel type that holds other channels.
const COLLECTION: i32 = 2;

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
    /// The server modes this channel belongs to (docs/SERVER_MODES.md). Empty:
    /// always listed. Otherwise the client lists it only while one of these is
    /// on. Tidiness, not access: an older client ignores this and lists it, and
    /// every permission still applies exactly as it reads.
    pub mode_ids: Vec<i64>,
    /// The modes of this channel's collection. A subchannel goes with its collection,
    /// and a member denied the collection itself has no row of it to read them from.
    pub parent_mode_ids: Vec<i64>,
}

#[derive(Deserialize)]
pub struct UpdateChannelRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    /// Three states, because null MEANS something here: left out leaves the parent
    /// alone, null clears it, a value sets it. A plain `Option<i32>` reads null and
    /// left-out as the same None, so "No parent (top level)" in Edit Channel saved
    /// nothing: the editor's list moved the row, and the next refetch put it back.
    ///
    /// i32, MATCHING CreateChannelRequest and the INT4 column — not i64.
    /// With i64 here, the reparent guard (which binds i32 to share the
    /// statement-cache width of "SELECT server_id FROM channels WHERE id =
    /// $1") could approve a TRUNCATED id while the UPDATE below wrote the
    /// full 64-bit value into the INT4 column — an "integer out of range"
    /// 500 for a request that used to 400 cleanly. Narrowing the field makes
    /// serde reject out-of-range JSON at the door, and the guard and the
    /// write can no longer disagree. (Review finding on the 0.8.110 diff.)
    #[serde(default, deserialize_with = "present_or_null")]
    pub parent_id: Option<Option<i32>>, // Change parent collection
    pub slowmode_seconds: Option<i32>,
    /// Toggle AFK on an existing voice channel.
    pub is_afk: Option<bool>,
    /// Toggle checklist mode on an existing text channel.
    pub has_checklist: Option<bool>,
    /// Toggle SFU mode on an existing voice channel. Read at join time; live
    /// calls keep the transport they started with.
    pub sfu_mode: Option<bool>,
}

/// `Some` for a key that is there, null included: serde calls this only for a present
/// key, and the field's `default` is what a missing one gets. On `Option<Option<i32>>`
/// serde's own handling folds null into the outer None.
fn present_or_null<'de, D: serde::Deserializer<'de>>(de: D) -> Result<Option<Option<i32>>, D::Error> {
    Option::<i32>::deserialize(de).map(Some)
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

    let mode_ids = match crate::mode_handlers::channel_mode_ids(&state.pool, &server_id).await {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("  Failed to read channel modes: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to list channels").into_response();
        }
    };

    // The rows the reader is listed a child of: their own modes are what that child is listed
    // by (list_row_parent).
    let holds_listed: std::collections::HashSet<i32> = channels
        .iter()
        .filter(|c| perms_map.get(&(c.0 as i64)).is_some_and(|p| p.has(Permissions::VIEW_CHANNEL)))
        .filter_map(|c| c.5)
        .collect();

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
                let own_modes = mode_ids.get(&id).cloned().unwrap_or_default();
                let parent_modes = parent_id.and_then(|p| mode_ids.get(&p).cloned()).unwrap_or_default();
                // A channel taken back inside a collection the reader is denied: they have
                // no row of the collection, and its number and its modes are not theirs to
                // read either (list_row_parent).
                let parent_seen = parent_id.filter(|p| {
                    perms_map.get(&(*p as i64)).is_some_and(|pp| pp.has(Permissions::VIEW_CHANNEL))
                });
                let (parent_id, row_modes, row_parent_modes) =
                    list_row_parent(holds_listed.contains(&id), parent_id, parent_seen.is_some(), own_modes, parent_modes);
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
                    mode_ids: row_modes,
                    parent_mode_ids: row_parent_modes,
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

    // A collection has no parent. Dropped, not refused: an installed client's Create
    // Subchannel keeps the parent when Collection is chosen after it, and means a
    // collection of its own (its form hides the field for one).
    let parent_id = if payload.channel_type == COLLECTION { None } else { payload.parent_id };

    // The parent and category come from the BODY, so they must be re-checked
    // against the PATH server — the permission check above only covers the
    // path. update_channel has carried this guard for reparenting since the
    // role-cluster audit; creation was left trusting the client, so a caller
    // with MANAGE_CHANNELS on their own server could create a channel already
    // grafted under another server's collection channel (the FK enforces
    // existence, not same-server) and inject content into that server's feed.
    //
    // A collection hidden from the caller answers as one that is not there: a manager who
    // cannot see it neither learns it exists nor puts a channel in it (update_channel's rule).
    if let Some(parent_id) = parent_id {
        if !parent_is_a_collection_here(&state.pool, parent_id, &server_id).await
            || !sees_channel_in(&state.pool, &server_id, parent_id as i64, claims.sub).await
        {
            return (StatusCode::BAD_REQUEST, PARENT_REFUSED).into_response();
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
    .bind(parent_id)            // parent_id for $6
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
            // Base VIEW is not visibility for a stream-only account: a new
            // channel has no overwrite opening it for their role, so they
            // resolve it to nothing and are not told its name either
            // (docs/STREAM_ONLY.md). Fail closed: no answer, no fan-out.
            let capped = match crate::permissions::stream_only_member_ids(&state.pool, &server_id).await {
                Ok(ids) => Some(ids),
                Err(e) => {
                    tracing::error!("ChannelCreated: stream-only resolve failed for server {}: {}", server_id, e);
                    None
                }
            };
            let members: Vec<(i32,)> = match &capped {
                Some(ids) => members.into_iter().filter(|(m,)| !ids.contains(&(*m as i64))).collect(),
                None => Vec::new(),
            };
            // A channel created inside a collection is NOT decided by base
            // permissions: the collection's overwrites reach it from the first
            // moment (docs/USER_GUIDE.md, Collections and permissions). Told only to those the
            // real resolver lets see it. Fail closed: an Err tells nobody.
            let members: Vec<(i32,)> = if parent_id.is_some() {
                match crate::permissions::get_channel_viewer_ids(&state.pool, channel_id as i64, &server_id).await {
                    Ok(viewers) => members.into_iter().filter(|(m,)| viewers.contains(&(*m as i64))).collect(),
                    Err(e) => {
                        tracing::error!("ChannelCreated: viewer resolve failed for channel {}: {}", channel_id, e);
                        Vec::new()
                    }
                }
            } else {
                members
            };
            let channel_info = crate::protocol::ChannelInfo {
                id: channel_id as i64,
                name: payload.name.clone(),
                channel_type: payload.channel_type,
                server_id: Some(server_id.clone()),
                parent_id: parent_id.map(|p| p as i64),
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
            // server permissions (no overwrites exist yet), unless a collection
            // holds it: then its overwrites already apply to the creator too.
            let my_permissions = if parent_id.is_some() {
                match crate::permissions::get_user_channel_permissions(&state.pool, channel_id as i64, claims.sub).await {
                    crate::permissions::ChannelPermAccess::Allowed { perms, .. } => perms,
                    _ => Permissions::empty(),
                }
            } else {
                get_user_server_permissions(&state.pool, &server_id, claims.sub).await
            };

            Json(ChannelResponse {
                id: channel_id as i64,
                name: payload.name,
                channel_type: payload.channel_type,
                server_id: Some(server_id),
                description: None,
                parent_id: parent_id.map(|p| p as i64),
                slowmode_seconds: 0,
                is_afk,
                has_checklist,
                sfu_mode: false,
                my_permissions: my_permissions.bits() as i64,
                mode_ids: Vec::new(),
                parent_mode_ids: Vec::new(),
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
    // Seen by the caller, and Manage Channels: a channel hidden from them is not found.
    let server_id = match require_manage_visible(&state.pool, channel_id, claims.sub).await {
        Ok(sid) => sid,
        Err(e) => return e.into_response(),
    };

    // What the voice transport is BEFORE the update, so a change to it can be
    // detected afterwards. Read here rather than compared to the payload alone:
    // `sfu_mode: Some(true)` on a channel already true is not a change, and
    // putting a live call out for a no-op edit would be its own bug.
    let before: Option<(i32, bool, Option<i32>)> =
        sqlx::query_as("SELECT type, COALESCE(sfu_mode, false), parent_id FROM channels WHERE id = $1")
            .bind(channel_id as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    // If reparenting, the new parent MUST belong to the same server. The FK only
    // enforces existence, not same-server — without this a caller with
    // MANAGE_CHANNELS on their own server could graft their channel under another
    // server's collection channel and inject content into that server's feed.
    //
    // It must be a collection too, and not the channel itself: nothing else draws a
    // child, so anything else takes the row off the sidebar with no way back in the UI.
    //
    // And one the caller can see: a collection hidden from them answers as one that is not
    // there, and gains no channel from them.
    //
    // Only a parent that CHANGES is judged, and written. An installed client sends the whole
    // form on every save, so a rename of a row already under something else names that parent
    // again, and has to keep working. "Changes" is against the parent the caller SEES: the
    // channel list sends none for a collection hidden from them (list_channels), so a client
    // from before 0.9.855, which sends the parent on every save, sends null for a channel taken
    // back inside a collection it cannot see, and that must not take the channel out of it.
    // Nor does the list name a parent in another server (rows from before the same-server
    // guard), so that is not one the caller sees here either.
    let parent_seen = match before.and_then(|(_, _, parent)| parent) {
        Some(parent) if sees_channel_in(&state.pool, &server_id, parent as i64, claims.sub).await => Some(parent),
        _ => None,
    };
    let parent_change = parent_change(payload.parent_id, parent_seen);
    if let Some(Some(parent_id)) = parent_change {
        if parent_id as i64 == channel_id
            || !parent_is_a_collection_here(&state.pool, parent_id, &server_id).await
            || !sees_channel_in(&state.pool, &server_id, parent_id as i64, claims.sub).await
            || parent_would_loop(&state.pool, &server_id, channel_id, parent_id as i64).await
        {
            return (StatusCode::BAD_REQUEST, PARENT_REFUSED).into_response();
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
    .bind(parent_change.is_some()) // Flag: does the parent change at all?
    .bind(parent_change.flatten()) // The new parent: null takes it out of its collection
    .bind(channel_id)
    .bind(payload.slowmode_seconds)
    .bind(payload.is_afk)
    .bind(payload.has_checklist)
    .bind(payload.sfu_mode)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => {
            // A channel made AFK leaves its modes (docs/SERVER_MODES.md).
            if payload.is_afk == Some(true) {
                crate::mode_handlers::release_afk_channel(&state, &server_id, channel_id as i32).await;
            }

            // A channel that changes collection changes who may see it: the
            // collections' overwrites travel with it (docs/USER_GUIDE.md, Collections and permissions). The
            // same sweep an overwrite edit runs - tell the members, rotate the
            // key for the new viewer set, put out whoever lost the channel from
            // its rooms. Started before anything else is awaited so a request
            // cancelled from here on cannot lose it.
            let moved = match parent_change {
                Some(now) => before.is_none_or(|(_, _, was)| was != now),
                None => false,
            };
            let sweep = moved.then(|| crate::ws::start_perms_change(&state, &server_id));

            // TELL EVERYONE, not just the editor. Every member refetches the
            // channel list, and the refetch applies each reader's own
            // permissions — which is why this carries the server id and not
            // the row.
            let members: Vec<(i32,)> =
                sqlx::query_as("SELECT user_id FROM server_members WHERE server_id = $1")
                    .bind(&server_id)
                    .fetch_all(&state.pool)
                    .await
                    .unwrap_or_default();
            for (member_id,) in &members {
                state.send_to_user(
                    *member_id as i64,
                    crate::protocol::ServerMessage::ChannelUpdated {
                        server_id: server_id.clone(),
                    },
                );
            }

            // A VOICE TRANSPORT CHANGE ENDS THE CALL IN PROGRESS.
            //
            // Mesh and SFU are not interchangeable mid-room: whoever is already
            // connected keeps negotiating the old one, so the room splits into
            // two halves that cannot see or hear each other, and anyone who
            // leaves cannot get back in — a client still holding `sfu_mode:
            // true` asks for a LiveKit token and is refused with 400. Both were
            // observed on 2026-09-08.
            //
            // So the honest move is to put the room out and let everyone
            // rejoin on the transport the channel now has. AFTER the broadcast
            // above, so a client that reconnects immediately reads the new mode
            // rather than the one it just failed with.
            if let Some((channel_type, was_sfu, _)) = before {
                if voice_transport_changed(channel_type, was_sfu, payload.sfu_mode) {
                    let room_id = format!("voice_{channel_id}");
                    // COLLECTED FIRST, deliberately: `rooms` is a DashMap and
                    // the eviction below both awaits and locks the same shard.
                    // Holding the Ref across those awaits is the deadlock this
                    // statement exists to avoid — it ends here, before the loop.
                    let occupants: Vec<i64> = state
                        .rooms
                        .get(&room_id)
                        .map(|r| r.members.iter().copied().collect())
                        .unwrap_or_default();
                    // Who was actually put out (their SFU session cut with it):
                    // one who raced out of the room first returns false.
                    let mut cut = std::collections::BTreeSet::new();
                    for &user_id in &occupants {
                        // cut_sfu: this is an ENFORCED removal — a client that
                        // ignores RoomLeft would otherwise keep publishing into
                        // a LiveKit room the channel no longer has.
                        if crate::ws::evict_user_from_voice_room(
                            &state,
                            &room_id,
                            user_id,
                            true,
                            crate::ws::SelfNotice::Gone,
                        )
                        .await
                        {
                            cut.insert(user_id);
                        }
                    }
                    // LEAVING SFU mode: a LiveKit session whose Púca socket is
                    // not in voice_<id> (it never rejoined after a restart, or
                    // the socket died) is still in a room the channel no longer
                    // has; cut it at the SFU directly. Not on the way INTO SFU
                    // mode: the room then holds the new call's first joiners.
                    // Collected first: no map guard may live across the awaits.
                    let sfu_only = crate::sfu::sfu_only_to_cut(
                        was_sfu,
                        &cut,
                        state.sfu_rooms.get(&crate::sfu::room_name_for_channel(channel_id)).as_deref(),
                    );
                    for user_id in sfu_only {
                        crate::sfu::evict_user_from_channel(&state, channel_id, user_id).await;
                    }
                }
            }
            if let Some(sweep) = sweep {
                sweep.wait().await;
            }
            StatusCode::OK.into_response()
        }
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

/// Does this update change a VOICE channel's transport, so the call in progress
/// has to be put out?
///
/// A free function because every arm of it is a decision somebody could get
/// wrong, and none of them needs a database to check:
///
/// * a TEXT channel has no call to end, whatever `sfu_mode` says about it;
/// * `None` is the ordinary case — the editor sent a rename, or a slowmode
///   change, and said nothing about the transport. Treating a silent field as
///   a change would drop everyone out of a call because someone fixed a typo;
/// * `Some(x)` where x is what it already was is not a change either. The
///   settings modal sends the whole form every time, so this is what an edit
///   that touched something ELSE looks like — the common case, and the one
///   that would hurt most if it ended calls.
///
/// Only a real flip returns true.
pub fn voice_transport_changed(channel_type: i32, before: bool, requested: Option<bool>) -> bool {
    const VOICE: i32 = 1;
    channel_type == VOICE && matches!(requested, Some(after) if after != before)
}

/// What a client is told when a channel it names cannot be a parent.
const PARENT_REFUSED: &str = "Parent channel must be a collection in the same server";

/// What a request's `parent_id` changes: `None` for nothing, `Some(new)` otherwise. Judged
/// against `seen`, the parent the CALLER sees: their channel list says none for a collection
/// hidden from them, so naming none (or naming again the one they see) is not a change.
fn parent_change(requested: Option<Option<i32>>, seen: Option<i32>) -> Option<Option<i32>> {
    requested.filter(|&now| now != seen)
}

/// A mode id no mode has (`server_modes.id` is a SERIAL, so it starts at 1): a `mode_ids` of
/// `[NO_MODE]` is listed under no mode, and with no mode on.
const NO_MODE: i64 = 0;

/// `(parent_id, mode_ids, parent_mode_ids)` of one row of a reader's channel list.
///
/// A channel a reader may see can sit in a collection they are denied: its own allow took the
/// collection's cross back (docs/USER_GUIDE.md, Collections and permissions). Their list has no
/// row of the collection, and until 0.9.863 this row still named it, its number in `parent_id`
/// and its modes in `parent_mode_ids`. Now it names neither: the row has no parent (the client
/// draws a row whose parent it does not hold at the top, so where it is drawn is unchanged), and
/// what the collection's modes do to it is folded into its own `mode_ids`, so it is listed
/// exactly when it was. A channel is listed when its own modes and its collection's each allow
/// the mode that is on (docs/SERVER_MODES.md), so the fold is the modes both allow: the
/// collection's when the channel has none of its own, the ones they share when it has, and
/// [`NO_MODE`] when they share none (listed nowhere, as for everyone). That is what the reader's
/// list shows over time anyway, and nothing more of the collection.
///
/// A row the reader is listed a child of is the exception (`holds_listed`): its `mode_ids` are
/// what that child is listed by (the client takes them from the row, the one level the
/// server's hide reads), so a collection inside one hidden from the reader, or a legacy parent
/// that is no collection, keeps its own modes and only loses its parent.
fn list_row_parent(
    holds_listed: bool,
    parent_id: Option<i32>,
    parent_seen: bool,
    own_modes: Vec<i64>,
    parent_modes: Vec<i64>,
) -> (Option<i32>, Vec<i64>, Vec<i64>) {
    if parent_id.is_none() || parent_seen {
        return (parent_id, own_modes, parent_modes);
    }
    if holds_listed || parent_modes.is_empty() {
        return (None, own_modes, Vec::new());
    }
    if own_modes.is_empty() {
        return (None, parent_modes, Vec::new());
    }
    let shared: Vec<i64> = own_modes.into_iter().filter(|m| parent_modes.contains(m)).collect();
    (None, if shared.is_empty() { vec![NO_MODE] } else { shared }, Vec::new())
}

/// Would making `parent_id` the parent of `channel_id` close a loop - is
/// `channel_id` already one of the collections above `parent_id`? A loop makes
/// no collection reachable and has the permission resolvers read each
/// collection's rows once. A failed read says yes (refuse).
async fn parent_would_loop(pool: &sqlx::PgPool, server_id: &str, channel_id: i64, parent_id: i64) -> bool {
    let rows: Result<Vec<(i64, i64)>, _> =
        sqlx::query_as("SELECT id::bigint, parent_id::bigint FROM channels WHERE server_id = $1 AND parent_id IS NOT NULL")
            .bind(server_id)
            .fetch_all(pool)
            .await;
    match rows {
        Ok(rows) => crate::permissions::ancestor_chain(&rows.into_iter().collect(), parent_id).contains(&channel_id),
        Err(_) => true,
    }
}

/// Is this channel a collection of this server? A failed read says no.
async fn parent_is_a_collection_here(pool: &sqlx::PgPool, parent_id: i32, server_id: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM channels WHERE id = $1 AND server_id = $2 AND type = $3)")
        .bind(parent_id)
        .bind(server_id)
        .bind(COLLECTION)
        .fetch_one(pool)
        .await
        .unwrap_or(false)
}

/// May a delete take these channels along? The foreign key cascades through everything
/// under the channel it names, messages included, with no undo, and the question a client
/// asks first can only name the rows its own list holds. So a channel hidden from the
/// caller would go without their having been told, and they could not have told anyone.
/// Fail closed: a resolver error refuses, and so does a channel it did not answer for. An
/// empty list is a plain delete, of a channel with nothing under it.
fn may_delete_along(
    under: &[i64],
    perms: Result<std::collections::HashMap<i64, Permissions>, sqlx::Error>,
) -> Result<(), (StatusCode, &'static str)> {
    let perms = perms.map_err(|e| {
        tracing::error!("delete_channel: resolving what goes with it failed: {:?}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, "Failed to delete channel")
    })?;
    if under.iter().all(|id| perms.get(id).is_some_and(|p| p.has(Permissions::VIEW_CHANNEL))) {
        return Ok(());
    }
    Err((
        StatusCode::CONFLICT,
        "This collection also holds channels you cannot see, and they would be deleted with it, so nothing was deleted. Your channel list is incomplete: ask someone who can see every channel to delete it.",
    ))
}

/// Delete a channel
pub async fn delete_channel(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Seen by the caller, and Manage Channels: a channel hidden from them is not found.
    let server_id = match require_manage_visible(&state.pool, channel_id, claims.sub).await {
        Ok(sid) => sid,
        Err(e) => return e.into_response(),
    };

    // What the foreign key's cascade is about to take: this channel and everything under
    // it, at any depth (a collection can sit inside a collection). UNION, not UNION ALL, so
    // a loop that raw API calls made ends the walk where it comes back round.
    let doomed: Vec<i32> = match sqlx::query_scalar(
        "WITH RECURSIVE doomed(id) AS ( \
             SELECT id FROM channels WHERE id = $1 \
             UNION \
             SELECT c.id FROM channels c JOIN doomed d ON c.parent_id = d.id \
         ) SELECT id FROM doomed",
    )
    .bind(channel_id as i32)
    .fetch_all(&state.pool)
    .await
    {
        Ok(ids) => ids,
        Err(e) => {
            tracing::error!("delete_channel: reading what goes with {} failed: {:?}", channel_id, e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to delete channel").into_response();
        }
    };

    // Only what goes ALONG is judged: deleting one channel by its id is as it always was.
    let under: Vec<i64> = doomed.iter().map(|&id| id as i64).filter(|&id| id != channel_id).collect();
    let perms = get_user_channels_permissions(&state.pool, &server_id, claims.sub, &under).await;
    if let Err(refusal) = may_delete_along(&under, perms) {
        return refusal.into_response();
    }

    // Deleting the server's PINNED CLIPS CHANNEL turns clips off with it, whether
    // it is the channel named or one the cascade takes.
    // The FK is ON DELETE SET NULL (050_clips.sql), so without this a
    // moderator with MANAGE_CHANNELS — who cannot touch server settings —
    // would leave the server clips-enabled with no pin: the exact state
    // update_server_settings refuses to create (S1), members 409ing on every
    // propose until the owner notices, and the settings guard reading it as
    // "legacy" forever after. Disabling is the honest outcome: the feature
    // cannot work without its one channel, and re-enabling makes the owner
    // pick a new one. In ONE transaction with the DELETE (delete_channel_rows), so
    // a delete that fails leaves the switch as it was.
    let named_by_a_mode = crate::mode_handlers::channel_is_named_by_a_mode(&state.pool, channel_id as i32).await;

    // A DELETE that FAILED is a 500, and nothing follows it: the channel is still there, so
    // nobody's list is told it changed and nobody leaves its rooms. Until 0.9.863 a failure
    // read as "0 rows" and answered 204, so the client took the channel off the list of the
    // person who pressed Delete while it stayed in everyone else's, and every member was told
    // to refetch for nothing. 0 rows that did not fail (somebody else's delete got there
    // first, or its collection's) still runs the tail, which empties nothing for it.
    let deleted_rows = match delete_channel_rows(&state.pool, &server_id, channel_id as i32, &doomed).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("delete_channel: deleting {} failed: {:?}", channel_id, e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to delete channel").into_response();
        }
    };

    // EVERYTHING AFTER THE ROW IS GONE runs detached, started with nothing awaited between it and
    // the commit (delete_server's own rule): a client that drops its connection a few
    // milliseconds after pressing Delete cancels this handler, and a tail that was still to
    // start would never run. The channel would be gone from the database with its people
    // still in its room, and nobody told the list had changed.
    let tail = finish_channel_delete(&state, &server_id, doomed, named_by_a_mode, deleted_rows);
    let _ = tail.await;

    StatusCode::NO_CONTENT.into_response()
}

/// The writes of [`delete_channel`], in one transaction: clips off if the cascade takes the
/// pinned clips channel, then the row itself. Answers how many rows went (0: somebody else's
/// delete got there first). An `Err` changed nothing.
async fn delete_channel_rows(
    pool: &sqlx::PgPool,
    server_id: &str,
    channel_id: i32,
    doomed: &Vec<i32>,
) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE servers SET clips_enabled = false WHERE id = $1 AND clip_channel_id = ANY($2)")
        .bind(server_id)
        // i32, matching the INTEGER column — an i64 bind against INT4 is the
        // intermittent 22P03 the cold-boot fix documents (sqlx caches by SQL text).
        .bind(doomed)
        .execute(&mut *tx)
        .await?;
    // INT4 as well: every other user of this text binds the column's width.
    let rows = sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(channel_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;
    Ok(rows)
}

/// What follows a `DELETE FROM channels`, detached ([`delete_channel`] says why): a mode that
/// named the channel is told, a card table in a voice room ends, everyone's list is told to
/// refetch, and then the rooms of everything the cascade took are emptied on the server.
///
/// A client ends its own call when the channel leaves its list, but that is the client's doing:
/// one that does not (an older build looking at another server, a socket that died with its
/// LiveKit session alive, a stream-only account nobody is watching) stayed in the deleted
/// channel's room, and in LiveKit's, for good. The emptying comes after the frame that tells
/// the lists, which does not wait on a LiveKit round trip, and only for a row that went: a
/// delete that failed leaves the channel, and everyone in it.
pub(crate) fn finish_channel_delete(
    state: &Arc<AppState>,
    server_id: &str,
    doomed: Vec<i32>,
    named_by_a_mode: bool,
    deleted_rows: u64,
) -> tokio::task::JoinHandle<()> {
    let state = Arc::clone(state);
    let server_id = server_id.to_string();
    tokio::spawn(crate::sfu::carry_test_livekit(async move {
        if named_by_a_mode {
            crate::mode_handlers::announce_edit(&state, &server_id).await;
        }

        // A voice channel's card table ends with it (docs/GAMES.md, Teardown).
        for id in &doomed {
            state.games.close_room(
                &state,
                &format!("voice_{id}"),
                crate::games_wire::GameEndReason::ChannelDeleted,
            );
        }

        // TELL EVERYONE, as update_channel does: every member refetches the channel list, and
        // the refetch is what takes the rows off theirs and closes whichever of them was open.
        // Nothing else would until they left the server and came back.
        crate::mode_handlers::push_to_members(
            &state,
            &server_id,
            crate::protocol::ServerMessage::ChannelUpdated { server_id: server_id.clone() },
        )
        .await;

        if deleted_rows > 0 {
            crate::ws::start_channels_deleted(&state, &server_id, doomed).wait().await;
        }
    }))
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

    // Only channels the caller can see move: one hidden from them is not theirs to change, and
    // a client's list never holds one (update_channel's rule). Skipped, not refused, so the
    // answer says nothing about which numbers are channels. Fail closed.
    let seen = match get_user_channels_permissions(&state.pool, &server_id, claims.sub, &payload.channel_ids).await {
        Ok(perms) => perms,
        Err(e) => {
            tracing::error!("reorder_channels: resolving the caller's view failed: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to reorder channels").into_response();
        }
    };
    let visible = |id: &i64| seen.get(id).is_some_and(|p| p.has(Permissions::VIEW_CHANNEL));

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
        if !visible(channel_id) {
            continue;
        }
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

    // The list has one order, everyone's, not the dragger's own.
    crate::mode_handlers::push_to_members(
        &state,
        &server_id,
        crate::protocol::ServerMessage::ChannelUpdated { server_id: server_id.clone() },
    )
    .await;

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
    // so an unbounded child count would be an N+1 round-trip amplifier). Text only:
    // a feed is for reading, and a voice room under the collection has its own row.
    let children: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, name FROM channels WHERE parent_id = $1 AND type = 0 ORDER BY position ASC LIMIT $2",
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
        // A feed entry IS message history, so the same two bits GET /messages
        // needs: a child the caller may see but may not read the history of is
        // left out rather than shown with bodies the message list refuses.
        let visible = child_perms
            .get(&(child_id as i64))
            .map(|p| p.has(Permissions::VIEW_CHANNEL) && p.has(Permissions::READ_MESSAGE_HISTORY))
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

/// The gate of every route that CHANGES a channel (edit, delete, the overwrite routes): the
/// channel's server, if the caller may see the channel and holds Manage Channels there.
///
/// A channel the caller cannot see answers exactly as one that does not exist, 404, whatever
/// rights they hold: the read routes' rule. A manager who cannot see a channel neither learns
/// that it is there nor changes it. Until 0.9.863 these routes checked Manage Channels alone, so
/// a manager denied a channel (on it, or on its collection: docs/USER_GUIDE.md, Collections and
/// permissions) could rename it, read and rewrite its overwrites, or delete it with its messages,
/// by number, and a 403 against a 404 told them which numbers were channels. A non-member is
/// refused 403, as on the read routes. Fail closed: a lookup that fails reads as not found.
async fn require_manage_visible(
    pool: &sqlx::PgPool,
    channel_id: i64,
    user_id: i64,
) -> Result<String, (StatusCode, &'static str)> {
    let server_id = match get_user_channel_permissions(pool, channel_id, user_id).await {
        ChannelPermAccess::Allowed { server_id, perms } if perms.has(Permissions::VIEW_CHANNEL) => server_id,
        ChannelPermAccess::Allowed { .. } | ChannelPermAccess::NotFound => {
            return Err((StatusCode::NOT_FOUND, "Channel not found"))
        }
        ChannelPermAccess::NotMember => return Err((StatusCode::FORBIDDEN, "Not a member of this server")),
    };
    if !user_has_permission(pool, &server_id, user_id, Permissions::MANAGE_CHANNELS).await {
        return Err((StatusCode::FORBIDDEN, "Missing MANAGE_CHANNELS permission"));
    }
    Ok(server_id)
}

/// How long a write that hid a channel from the person making it leaves them to finish the save
/// it belongs to ([`require_manage_overwrites`]).
const OVERWRITE_SAVE_GRACE: std::time::Duration = std::time::Duration::from_secs(60);

/// How the overwrite routes let a caller through.
struct OverwriteGate {
    server_id: String,
    /// They can see the channel. False: let through only to finish their own save.
    sees: bool,
}

/// [`require_manage_visible`] for the overwrite routes, with one allowance: Edit Channel saves
/// one role per request, highest role first, so a save can hide the channel from the person
/// saving it before it is done. "Make #staff public" from a manager who sees it through their
/// own role's allow takes that allow away first, and the @everyone row after it was refused
/// as not found: the channel was left hidden from everyone but the owner. So the WRITE that
/// hides the channel from its writer ([`open_save_window`]) lets them on for
/// [`OVERWRITE_SAVE_GRACE`], if the channel is still there and they still hold Manage Channels.
/// Nothing else opens it: not a read, not a write that leaves them the channel, not a pass
/// inside the window, so a hide by anyone else stays a hide. In memory, per process: a restart
/// in the middle of a save forgets it.
async fn require_manage_overwrites(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
) -> Result<OverwriteGate, (StatusCode, &'static str)> {
    let refused = match require_manage_visible(&state.pool, channel_id, user_id).await {
        Ok(server_id) => return Ok(OverwriteGate { server_id, sees: true }),
        Err(refused) => refused,
    };
    let saving = state
        .overwrite_saves
        .get(&(user_id, channel_id))
        .is_some_and(|until| *until > std::time::Instant::now());
    if !saving || refused.0 != StatusCode::NOT_FOUND {
        return Err(refused);
    }
    let server_id = match get_user_channel_permissions(&state.pool, channel_id, user_id).await {
        ChannelPermAccess::Allowed { server_id, .. } => server_id,
        _ => return Err(refused),
    };
    if !user_has_permission(&state.pool, &server_id, user_id, Permissions::MANAGE_CHANNELS).await {
        return Err(refused);
    }
    Ok(OverwriteGate { server_id, sees: false })
}

/// After an overwrite write that went through: if the writer could see the channel before it
/// and cannot now, this write hid it from them, and the rest of their save may follow
/// ([`require_manage_overwrites`]).
async fn open_save_window(state: &AppState, gate: &OverwriteGate, channel_id: i64, user_id: i64) {
    if !gate.sees || sees_channel_in(&state.pool, &gate.server_id, channel_id, user_id).await {
        return;
    }
    let now = std::time::Instant::now();
    if state.overwrite_saves.len() > 4096 {
        state.overwrite_saves.retain(|_, until| *until > now);
    }
    state.overwrite_saves.insert((user_id, channel_id), now + OVERWRITE_SAVE_GRACE);
}

/// May `user_id` see channel `channel_id`, a channel of `server_id`? A failed lookup says no.
async fn sees_channel_in(pool: &sqlx::PgPool, server_id: &str, channel_id: i64, user_id: i64) -> bool {
    matches!(
        get_user_channel_permissions(pool, channel_id, user_id).await,
        ChannelPermAccess::Allowed { server_id: in_server, perms }
            if in_server == server_id && perms.has(Permissions::VIEW_CHANNEL)
    )
}

/// List a channel's permission overwrites (managers only).
pub async fn list_overwrites(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    if let Err(e) = require_manage_overwrites(&state, channel_id, claims.sub).await {
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
    let gate = match require_manage_overwrites(&state, channel_id, claims.sub).await {
        Ok(gate) => gate,
        Err(e) => return e.into_response(),
    };
    let server_id = gate.server_id.clone();

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
            open_save_window(&state, &gate, channel_id, claims.sub).await;
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
    let gate = match require_manage_overwrites(&state, channel_id, claims.sub).await {
        Ok(gate) => gate,
        Err(e) => return e.into_response(),
    };
    let server_id = gate.server_id.clone();

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
                open_save_window(&state, &gate, channel_id, claims.sub).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_null_parent_is_not_a_left_out_one() {
        let parse = |body: serde_json::Value| {
            serde_json::from_value::<UpdateChannelRequest>(body).map(|r| r.parent_id).map_err(|_| ())
        };
        assert_eq!(parse(serde_json::json!({ "name": "renamed" })), Ok(None), "left out: leave it");
        assert_eq!(parse(serde_json::json!({ "parent_id": null })), Ok(Some(None)), "null: clear it");
        assert_eq!(parse(serde_json::json!({ "parent_id": 7 })), Ok(Some(Some(7))), "a value: set it");
        assert_eq!(parse(serde_json::json!({ "parent_id": "7" })), Err(()), "not a channel id");
        assert_eq!(parse(serde_json::json!({ "parent_id": 5_000_000_000_i64 })), Err(()), "wider than the column");
    }

    #[test]
    fn a_parent_changes_only_against_the_one_the_caller_sees() {
        assert_eq!(parent_change(None, Some(4)), None, "left out");
        assert_eq!(parent_change(Some(Some(4)), Some(4)), None, "named again");
        assert_eq!(parent_change(Some(None), None), None, "none, where the caller sees none (a hidden collection too)");
        assert_eq!(parent_change(Some(None), Some(4)), Some(None), "cleared");
        assert_eq!(parent_change(Some(Some(5)), Some(4)), Some(Some(5)), "moved");
        assert_eq!(parent_change(Some(Some(5)), None), Some(Some(5)), "put in one");
    }

    #[test]
    fn a_row_names_a_parent_only_its_reader_sees() {
        let row = |holds: bool, p: Option<i32>, seen: bool, own: &[i64], parent: &[i64]| {
            list_row_parent(holds, p, seen, own.to_vec(), parent.to_vec())
        };
        assert_eq!(row(false, Some(9), true, &[1], &[2]), (Some(9), vec![1], vec![2]), "seen: as stored");
        assert_eq!(row(false, None, false, &[1], &[]), (None, vec![1], vec![]), "no parent: as stored");
        assert_eq!(row(false, Some(9), false, &[], &[]), (None, vec![], vec![]), "hidden: no parent, nothing to fold");
        assert_eq!(row(false, Some(9), false, &[1, 3], &[]), (None, vec![1, 3], vec![]));
        assert_eq!(row(false, Some(9), false, &[], &[2, 5]), (None, vec![2, 5], vec![]), "the collection's modes");
        assert_eq!(row(false, Some(9), false, &[1, 2, 3], &[2, 3, 4]), (None, vec![2, 3], vec![]), "the ones both allow");
        assert_eq!(row(false, Some(9), false, &[1], &[2]), (None, vec![NO_MODE], vec![]), "none both allow");
        assert_eq!(row(true, Some(9), false, &[1], &[2]), (None, vec![1], vec![]), "a row holding a listed one keeps its own");
    }

    /// The fold lists a row exactly as before, under every mode and under none, by the client's
    /// own rule (api/serverModes.ts, shownByMode / shownWithParent: a row with no parent is
    /// listed by its own modes alone), for every pair of mode sets over three modes.
    #[test]
    fn a_folded_row_is_listed_exactly_when_it_was() {
        let shown = |ids: &[i64], active: Option<i64>| ids.is_empty() || active.is_some_and(|a| ids.contains(&a));
        let sets: Vec<Vec<i64>> = (0u8..8).map(|bits| (1..=3).filter(|m| bits & (1 << (m - 1)) != 0).collect()).collect();
        for own in &sets {
            for parent in &sets {
                let (folded_parent, folded, folded_parent_modes) = list_row_parent(false, Some(9), false, own.clone(), parent.clone());
                assert_eq!((folded_parent, folded_parent_modes.len()), (None, 0));
                for active in [None, Some(1), Some(2), Some(3), Some(4)] {
                    assert_eq!(
                        shown(&folded, active),
                        shown(own, active) && shown(parent, active),
                        "own {own:?}, collection {parent:?}, mode {active:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_delete_takes_along_only_what_the_caller_can_see() {
        use std::collections::HashMap;
        let answered = |rows: &[(i64, Permissions)]| Ok(rows.iter().copied().collect::<HashMap<_, _>>());
        let status = |under: &[i64], perms| may_delete_along(under, perms).map_err(|(s, _)| s);

        assert_eq!(status(&[], answered(&[])), Ok(()), "nothing under it: a plain delete");
        assert_eq!(status(&[1, 2], answered(&[(1, Permissions::VIEW_CHANNEL), (2, Permissions::VIEW_CHANNEL)])), Ok(()));
        assert_eq!(status(&[1], answered(&[(1, Permissions::ADMINISTRATOR)])), Ok(()), "an admin sees everything");

        assert_eq!(status(&[1, 2], answered(&[(1, Permissions::VIEW_CHANNEL), (2, Permissions::empty())])), Err(StatusCode::CONFLICT));
        assert_eq!(status(&[1, 2], answered(&[(1, Permissions::VIEW_CHANNEL)])), Err(StatusCode::CONFLICT), "no answer is no");
        assert_eq!(status(&[1], Err(sqlx::Error::PoolTimedOut)), Err(StatusCode::INTERNAL_SERVER_ERROR), "a resolver error refuses");

        let (_, sentence) = may_delete_along(&[1], answered(&[])).unwrap_err();
        assert!(sentence.contains("nothing was deleted") && sentence.contains("ask someone who can see every channel"), "{sentence}");
    }

    #[test]
    fn only_a_real_voice_transport_flip_ends_the_call() {
        // The dangerous direction is a FALSE positive: the settings modal sends
        // the whole form on every save, so most updates carry `sfu_mode` set to
        // what it already was. Reading that as a change would empty a voice
        // channel every time somebody renamed it.
        assert!(!voice_transport_changed(1, false, None), "a rename says nothing about transport");
        assert!(!voice_transport_changed(1, true, None));
        assert!(!voice_transport_changed(1, false, Some(false)), "unchanged is not changed");
        assert!(!voice_transport_changed(1, true, Some(true)));

        // A text channel has no call to end, whatever it says.
        assert!(!voice_transport_changed(0, false, Some(true)));
        assert!(!voice_transport_changed(0, true, Some(false)));

        // POSITIVE CONTROL, both directions: a real flip on a voice channel.
        assert!(voice_transport_changed(1, false, Some(true)), "mesh -> SFU");
        assert!(voice_transport_changed(1, true, Some(false)), "SFU -> mesh");
    }
}
