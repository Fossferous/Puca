//! Server modes (docs/SERVER_MODES.md): a named set of channels the client lists
//! only while the mode is on, with an optional background and accent colour.
//!
//! Hiding is tidiness, not access. Nothing here changes a permission or touches
//! a channel key: a channel a mode hides is still reachable by anyone it was
//! reachable by, and an older client simply lists it. The one thing the server
//! itself does to a hidden channel is end its call at the moment of the switch
//! (the owner's decision), and that is a disconnect, not a lock: nothing refuses
//! a later join.

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::auth::Claims;
use crate::moderation_handlers::{log_audit_action, log_audit_row, perform_voice_move, VoiceMoveRequest};
use crate::permissions::{
    get_user_channel_permissions, get_user_channels_permissions, get_user_server_permissions, user_has_permission,
    ChannelPermAccess, Permissions,
};
use crate::protocol::ServerMessage;
use crate::state::{AppState, UserId};

/// Bytes, like a channel name's cap; the column's CHECK counts characters and
/// is the backstop.
const MAX_MODE_NAME_LEN: usize = 64;
/// A selector, not a catalogue.
const MAX_MODES_PER_SERVER: i64 = 32;
/// Every member downloads the picture, phones included. The client re-encodes
/// to well under this; the cap is for a request that skipped the client.
const MAX_BACKGROUND_BYTES: i64 = 4 * 1024 * 1024;
const BACKGROUND_TYPES: [&str; 3] = ["image/jpeg", "image/png", "image/webp"];
/// How long a mode's voice channels stay empty before it turns itself off.
const AUTO_OFF_EMPTY_MINUTES: i32 = 30;
/// How long a switch's request waits for the disconnects before answering (they
/// carry on detached): LiveKit may be slow, and a proxy's timeout is not.
const SWITCH_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

// --- DTOs ---

#[derive(Serialize, Debug)]
pub struct ModeResponse {
    pub id: i64,
    pub name: String,
    pub background_file_id: Option<String>,
    pub accent_color: Option<String>,
    /// The main voice channel, when the reader can see it.
    pub home_channel_id: Option<i64>,
    pub auto_off: bool,
    /// Only the channels the reader can see: naming the others would tell them
    /// a hidden channel exists.
    pub channel_ids: Vec<i64>,
}

#[derive(Serialize, Debug)]
pub struct ModesResponse {
    pub active_mode_id: Option<i64>,
    /// SWITCH_MODES.
    pub can_switch: bool,
    /// MANAGE_CHANNELS.
    pub can_edit: bool,
    /// MOVE_MEMBERS: Call everyone back.
    pub can_call_back: bool,
    pub modes: Vec<ModeResponse>,
}

/// One body for create and edit. A field left out is left alone (on create: the
/// default), so a client that edits a name cannot clobber a background another
/// manager just set.
#[derive(Deserialize, Default)]
pub struct ModeEdit {
    pub name: Option<String>,
    /// i32s, MATCHING the INT4 columns: see `UpdateChannelRequest::parent_id`.
    /// Replaces the channels the CALLER can see; channels hidden from them stay
    /// in the mode, or a manager's save would quietly drop what they can't see.
    pub channel_ids: Option<Vec<i32>>,
    /// A file the caller uploaded. Empty clears it.
    pub background_file_id: Option<String>,
    /// `#rrggbb`. Empty clears it.
    pub accent_color: Option<String>,
    /// Zero or below clears it, like `clip_channel_id`.
    pub home_channel_id: Option<i32>,
    pub auto_off: Option<bool>,
}

#[derive(Deserialize)]
pub struct SetActiveRequest {
    /// The mode to turn on, or null to turn the current one off.
    pub mode_id: Option<i32>,
}

#[derive(Serialize)]
pub struct SwitchResponse {
    pub active_mode_id: Option<i64>,
    /// People taken out of the channels this switch hid. None: still going when
    /// the request stopped waiting.
    pub disconnected: Option<usize>,
}

#[derive(Serialize)]
pub struct CallBackResponse {
    pub moved: usize,
    /// In the mode's channels but not movable by this caller: ranked at or
    /// above them, or unable to join the main channel.
    pub skipped: usize,
}

// --- Pure rules ---

/// The name a mode is stored under, or the refusal.
fn clean_name(raw: &str) -> Result<String, (StatusCode, &'static str)> {
    let name = raw.trim();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "A mode needs a name"));
    }
    if name.len() > MAX_MODE_NAME_LEN {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "That name is too long"));
    }
    Ok(name.to_string())
}

/// `#rrggbb` in lower case, for the column's CHECK and for one spelling on the
/// wire. `None` for anything else.
fn clean_accent(raw: &str) -> Option<String> {
    let hex = raw.strip_prefix('#')?;
    (hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("#{}", hex.to_ascii_lowercase()))
}

/// What one tick of the auto-off does to a server whose active mode opted in.
#[derive(Debug, PartialEq, Eq)]
enum AutoOff {
    /// Nothing changes.
    Keep,
    /// Someone is in its channels: remember when.
    Touch,
    /// Empty for long enough, after someone had been there.
    TurnOff,
}

/// `seen`: someone has been in its voice channels since it was turned on.
/// `stale`: they were last seen longer ago than the window. A mode nobody has
/// joined yet stays on: turning it on is often the first thing that happens.
fn auto_off_verdict(occupied: bool, seen: bool, stale: bool) -> AutoOff {
    if occupied {
        AutoOff::Touch
    } else if seen && stale {
        AutoOff::TurnOff
    } else {
        AutoOff::Keep
    }
}

// --- Reads ---

/// Every channel of `server_id` that belongs to a mode, with those modes.
pub async fn channel_mode_ids(pool: &sqlx::PgPool, server_id: &str) -> Result<HashMap<i32, Vec<i64>>, sqlx::Error> {
    let rows: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT mc.channel_id, mc.mode_id FROM server_mode_channels mc \
         JOIN server_modes m ON m.id = mc.mode_id WHERE m.server_id = $1 ORDER BY mc.mode_id",
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?;
    let mut map: HashMap<i32, Vec<i64>> = HashMap::new();
    for (channel, mode) in rows {
        map.entry(channel).or_default().push(mode as i64);
    }
    Ok(map)
}

/// Every channel, on any of this member's servers, that the mode on there hides:
/// in a mode that is off, or under a collection that is.
pub async fn channels_hidden_from(pool: &sqlx::PgPool, user_id: i64) -> Result<std::collections::HashSet<i64>, sqlx::Error> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT c.id::bigint FROM channels c \
         JOIN servers s ON s.id = c.server_id \
         JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1 \
         WHERE EXISTS (SELECT 1 FROM unnest(ARRAY[c.id, c.parent_id]) AS self_or_parent(id) \
                        WHERE EXISTS (SELECT 1 FROM server_mode_channels mc WHERE mc.channel_id = self_or_parent.id) \
                          AND NOT EXISTS (SELECT 1 FROM server_mode_channels listed \
                                           WHERE listed.channel_id = self_or_parent.id AND listed.mode_id = s.active_mode_id))",
    )
    .bind(user_id as i32)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}

/// The voice channels of `mode_id`.
async fn mode_voice_channels(pool: &sqlx::PgPool, mode_id: i32) -> Result<Vec<i32>, sqlx::Error> {
    let rows: Vec<(i32,)> = sqlx::query_as(
        "SELECT mc.channel_id FROM server_mode_channels mc JOIN channels c ON c.id = mc.channel_id \
         WHERE mc.mode_id = $1 AND c.type = 1",
    )
    .bind(mode_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}

/// Who is in the voice room of `channel_id` right now.
fn occupants(state: &AppState, channel_id: i32) -> Vec<UserId> {
    state
        .rooms
        .get(&format!("voice_{channel_id}"))
        .map(|room| room.members.clone())
        .unwrap_or_default()
}

async fn is_member(pool: &sqlx::PgPool, server_id: &str, user_id: i64) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2")
        .bind(server_id)
        .bind(user_id as i32)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

/// Tell every member of `server_id`. Reaches every connection, as
/// `MediaE2eeRequired` does: an older client and a delivery socket drop a frame
/// they do not know. A failed read pushes nothing: members then see the change
/// on their next fetch.
async fn push_to_members(state: &AppState, server_id: &str, msg: ServerMessage) -> usize {
    let members = match sqlx::query_as::<_, (i32,)>("SELECT user_id FROM server_members WHERE server_id = $1")
        .bind(server_id)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("modes: member fetch for server {} failed: {}", server_id, e);
            return 0;
        }
    };
    let mut reached = 0;
    for (user,) in members {
        if state.send_to_user(user as i64, msg.clone()) {
            reached += 1;
        }
    }
    reached
}

// --- Handlers ---

/// The server's modes, as this member may read them.
pub async fn list_modes(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> Response {
    match is_member(&state.pool, &server_id, claims.sub).await {
        Ok(true) => {}
        Ok(false) => return (StatusCode::FORBIDDEN, "Not a member of this server").into_response(),
        Err(e) => {
            tracing::error!("list_modes: membership check failed: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to list modes").into_response();
        }
    }
    match read_modes(&state, &server_id, claims.sub).await {
        Ok(body) => Json(body).into_response(),
        Err(e) => {
            tracing::error!("list_modes: read for server {} failed: {:?}", server_id, e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to list modes").into_response()
        }
    }
}

async fn read_modes(state: &AppState, server_id: &str, user_id: i64) -> Result<ModesResponse, sqlx::Error> {
    let active: Option<i32> = sqlx::query_scalar("SELECT active_mode_id FROM servers WHERE id = $1")
        .bind(server_id)
        .fetch_one(&state.pool)
        .await?;
    let rows: Vec<(i32, String, Option<String>, Option<String>, Option<i32>, bool)> = sqlx::query_as(
        "SELECT id, name, background_file_id, accent_color, home_channel_id, auto_off \
         FROM server_modes WHERE server_id = $1 ORDER BY id",
    )
    .bind(server_id)
    .fetch_all(&state.pool)
    .await?;
    let pairs: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT mc.mode_id, mc.channel_id FROM server_mode_channels mc \
         JOIN server_modes m ON m.id = mc.mode_id WHERE m.server_id = $1 ORDER BY mc.channel_id",
    )
    .bind(server_id)
    .fetch_all(&state.pool)
    .await?;

    // Resolved in one pass, like list_channels. Failing closed: a resolver
    // error refuses the request rather than naming a hidden channel.
    let mut named: Vec<i64> = pairs.iter().map(|&(_, c)| c as i64).collect();
    named.extend(rows.iter().filter_map(|r| r.4).map(|c| c as i64));
    named.sort_unstable();
    named.dedup();
    let perms = get_user_channels_permissions(&state.pool, server_id, user_id, &named).await?;
    let sees = |channel: i32| perms.get(&(channel as i64)).is_some_and(|p| p.has(Permissions::VIEW_CHANNEL));

    let mut channels_of: HashMap<i32, Vec<i64>> = HashMap::new();
    for &(mode, channel) in &pairs {
        if sees(channel) {
            channels_of.entry(mode).or_default().push(channel as i64);
        }
    }
    let modes = rows
        .into_iter()
        .map(|(id, name, background_file_id, accent_color, home, auto_off)| ModeResponse {
            id: id as i64,
            name,
            background_file_id,
            accent_color,
            home_channel_id: home.filter(|&c| sees(c)).map(|c| c as i64),
            auto_off,
            channel_ids: channels_of.remove(&id).unwrap_or_default(),
        })
        .collect();

    let server_perms = get_user_server_permissions(&state.pool, server_id, user_id).await;
    Ok(ModesResponse {
        active_mode_id: active.map(|m| m as i64),
        can_switch: server_perms.has(Permissions::SWITCH_MODES),
        can_edit: server_perms.has(Permissions::MANAGE_CHANNELS),
        can_call_back: server_perms.has(Permissions::MOVE_MEMBERS),
        modes,
    })
}

/// What an edit's fields were checked into. `None` leaves the column alone.
struct CheckedEdit {
    name: Option<String>,
    channel_ids: Option<Vec<i32>>,
    /// Some(None) clears.
    background: Option<Option<String>>,
    accent: Option<Option<String>>,
    home: Option<Option<i32>>,
    auto_off: Option<bool>,
    /// The channels the caller can see: what `channel_ids` replaces.
    visible: Vec<i32>,
}

/// Every check that needs the database, before any transaction opens: the
/// permission resolver takes the pool, and a second connection checked out
/// under an open transaction is how a pool deadlocks.
async fn check_edit(state: &AppState, server_id: &str, caller: i64, edit: ModeEdit) -> Result<CheckedEdit, Response> {
    let refuse = |status: StatusCode, msg: &'static str| (status, msg).into_response();
    let name = match edit.name.as_deref().map(clean_name).transpose() {
        Ok(n) => n,
        Err((status, msg)) => return Err(refuse(status, msg)),
    };
    let accent = match edit.accent_color.as_deref() {
        None => None,
        Some("") => Some(None),
        Some(raw) => match clean_accent(raw) {
            Some(c) => Some(Some(c)),
            None => return Err(refuse(StatusCode::BAD_REQUEST, "An accent colour looks like #7a1f3d")),
        },
    };

    // Mass-assignment guard, the server icon's: a background may only be a file
    // the CALLER uploaded (see update_server_settings), or setting and then
    // replacing it would delete someone else's file. An invalid uuid fails the
    // cast and reads as no such file.
    let background = match edit.background_file_id.as_deref() {
        None => None,
        Some("") => Some(None),
        Some(id) => {
            let file: Option<(String, i64)> = sqlx::query_as(
                "SELECT mime_type, size_bytes FROM uploaded_files WHERE id = $1::uuid AND uploader_id = $2",
            )
            .bind(id)
            .bind(caller as i32)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
            match file {
                None => return Err(refuse(StatusCode::FORBIDDEN, "A background must be a file you uploaded")),
                Some((mime, _)) if !BACKGROUND_TYPES.contains(&mime.as_str()) => {
                    return Err(refuse(StatusCode::BAD_REQUEST, "A background must be a JPEG, PNG or WebP picture"))
                }
                Some((_, size)) if size > MAX_BACKGROUND_BYTES => {
                    return Err(refuse(StatusCode::PAYLOAD_TOO_LARGE, "That picture is too large for a background"))
                }
                Some(_) => Some(Some(id.to_string())),
            }
        }
    };

    // Channels: this server's, and only ones the caller can see.
    let rows: Vec<(i32, i32, bool)> =
        sqlx::query_as("SELECT id, type, COALESCE(is_afk, false) FROM channels WHERE server_id = $1")
            .bind(server_id)
            .fetch_all(&state.pool)
            .await
            .map_err(|e| {
                tracing::error!("modes: channel read for server {} failed: {:?}", server_id, e);
                refuse(StatusCode::INTERNAL_SERVER_ERROR, "Could not verify the channels")
            })?;
    let ids: Vec<i64> = rows.iter().map(|r| r.0 as i64).collect();
    let perms = get_user_channels_permissions(&state.pool, server_id, caller, &ids).await.map_err(|e| {
        tracing::error!("modes: permission resolve for server {} failed: {:?}", server_id, e);
        refuse(StatusCode::INTERNAL_SERVER_ERROR, "Could not verify the channels")
    })?;
    let visible: HashMap<i32, (i32, bool)> = rows
        .into_iter()
        .filter(|r| perms.get(&(r.0 as i64)).is_some_and(|p| p.has(Permissions::VIEW_CHANNEL)))
        .map(|(id, kind, afk)| (id, (kind, afk)))
        .collect();

    if let Some(channels) = &edit.channel_ids {
        for id in channels {
            match visible.get(id) {
                None => return Err(refuse(StatusCode::BAD_REQUEST, "One of those channels is not on this server")),
                // An idle member is moved into the AFK channel: hiding it would
                // put them somewhere nobody can see.
                Some((_, true)) => return Err(refuse(StatusCode::BAD_REQUEST, "The AFK channel can't belong to a mode")),
                Some(_) => {}
            }
        }
    }
    let home = match edit.home_channel_id {
        None => None,
        Some(id) if id <= 0 => Some(None),
        Some(id) => match visible.get(&id) {
            Some((1, false)) => Some(Some(id)),
            _ => return Err(refuse(StatusCode::BAD_REQUEST, "The main channel must be a voice channel on this server")),
        },
    };

    Ok(CheckedEdit {
        name,
        channel_ids: edit.channel_ids,
        background,
        accent,
        home,
        auto_off: edit.auto_off,
        visible: visible.into_keys().collect(),
    })
}

async fn require_manage_channels(state: &AppState, server_id: &str, user_id: i64) -> Option<Response> {
    if user_has_permission(&state.pool, server_id, user_id, Permissions::MANAGE_CHANNELS).await {
        None
    } else {
        Some((StatusCode::FORBIDDEN, "Missing MANAGE_CHANNELS permission").into_response())
    }
}

/// Replace the channels of `mode_id` the caller can see with `wanted`.
async fn write_channels(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    mode_id: i32,
    visible: &[i32],
    wanted: &[i32],
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM server_mode_channels WHERE mode_id = $1 AND channel_id = ANY($2)")
        .bind(mode_id)
        .bind(visible)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT INTO server_mode_channels (mode_id, channel_id) SELECT $1::int4, unnest($2::int4[]) ON CONFLICT DO NOTHING",
    )
    .bind(mode_id)
    .bind(wanted)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Commit `tx`, then run `then`, as one DETACHED task: axum drops a handler whose
/// client went away, and a request dropped after the commit must still tell every
/// member and still end the calls (the games switch's shape). Answers once the
/// commit is known; the handle then resolves when `then` is done.
async fn commit_then<T, F>(
    tx: sqlx::Transaction<'static, sqlx::Postgres>,
    then: F,
) -> Result<tokio::task::JoinHandle<Option<T>>, sqlx::Error>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let (committed_tx, committed) = tokio::sync::oneshot::channel();
    let work = tokio::spawn(crate::sfu::carry_test_livekit(async move {
        let result = tx.commit().await;
        let ok = result.is_ok();
        let _ = committed_tx.send(result);
        if ok {
            Some(then.await)
        } else {
            None
        }
    }));
    match committed.await {
        Ok(Ok(())) => Ok(work),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(sqlx::Error::Protocol("the modes commit task ended before its commit".into())),
    }
}

/// A server's modes changed by some other road than these handlers.
pub async fn announce_edit(state: &AppState, server_id: &str) {
    push_to_members(state, server_id, ServerMessage::ServerModesEdited { server_id: server_id.to_string() }).await;
}

/// [`commit_then`] for an edit: tell every member, then reclaim a replaced picture.
/// Waits for it all: nothing here depends on LiveKit.
async fn commit_edit(
    state: &Arc<AppState>,
    server_id: &str,
    tx: sqlx::Transaction<'static, sqlx::Postgres>,
    reclaim: Option<(String, i64)>,
) -> Result<(), sqlx::Error> {
    let state = Arc::clone(state);
    let server_id = server_id.to_string();
    let work = commit_then(tx, async move {
        push_to_members(&state, &server_id, ServerMessage::ServerModesEdited { server_id: server_id.clone() }).await;
        if let Some((file, caller)) = reclaim {
            reclaim_background(&state.pool, &file, caller).await;
        }
    })
    .await?;
    let _ = work.await;
    Ok(())
}

/// Delete a replaced background's file, CALLER-scoped like the server icon's
/// reclaim (so an edit can only ever delete the caller's own upload), and only
/// when nothing else points at it: a file can back two modes, or a mode and an
/// icon. A failed check keeps the file: an orphan is harmless, a broken picture
/// is not.
async fn reclaim_background(pool: &sqlx::PgPool, file_id: &str, caller: i64) {
    if matches!(crate::upload_handlers::file_is_referenced(pool, file_id).await, Ok(false)) {
        crate::upload_handlers::remove_file(pool, file_id, caller).await;
    }
}

/// Create a mode.
pub async fn create_mode(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(edit): Json<ModeEdit>,
) -> Response {
    if let Some(refused) = require_manage_channels(&state, &server_id, claims.sub).await {
        return refused;
    }
    if edit.name.is_none() {
        return (StatusCode::BAD_REQUEST, "A mode needs a name").into_response();
    }
    let checked = match check_edit(&state, &server_id, claims.sub, edit).await {
        Ok(c) => c,
        Err(refused) => return refused,
    };
    let failed = |e: sqlx::Error| {
        tracing::error!("create_mode: {:?}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create the mode").into_response()
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => return failed(e),
    };
    // The row lock makes the count below exact across concurrent creates.
    if let Err(e) = sqlx::query("SELECT 1 FROM servers WHERE id = $1 FOR UPDATE")
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        return failed(e);
    }
    let count: i64 = match sqlx::query_scalar("SELECT COUNT(*) FROM server_modes WHERE server_id = $1")
        .bind(&server_id)
        .fetch_one(&mut *tx)
        .await
    {
        Ok(n) => n,
        Err(e) => return failed(e),
    };
    if count >= MAX_MODES_PER_SERVER {
        return (StatusCode::CONFLICT, "This server has as many modes as it can hold").into_response();
    }
    let mode_id: i32 = match sqlx::query_scalar(
        "INSERT INTO server_modes (server_id, name, background_file_id, accent_color, home_channel_id, auto_off) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(&server_id)
    .bind(checked.name.as_deref().unwrap_or_default())
    .bind(checked.background.flatten())
    .bind(checked.accent.flatten())
    .bind(checked.home.flatten())
    .bind(checked.auto_off.unwrap_or(true))
    .fetch_one(&mut *tx)
    .await
    {
        Ok(id) => id,
        Err(e) => return failed(e),
    };
    if let Some(channels) = &checked.channel_ids {
        if let Err(e) = write_channels(&mut tx, mode_id, &checked.visible, channels).await {
            return failed(e);
        }
    }
    if let Err(e) = commit_edit(&state, &server_id, tx, None).await {
        return failed(e);
    }
    (StatusCode::CREATED, Json(serde_json::json!({ "id": mode_id as i64 }))).into_response()
}

/// Edit a mode. An edit never disconnects anyone: only the switch does.
pub async fn update_mode(
    State(state): State<Arc<AppState>>,
    Path((server_id, mode_id)): Path<(String, i32)>,
    Extension(claims): Extension<Claims>,
    Json(edit): Json<ModeEdit>,
) -> Response {
    if let Some(refused) = require_manage_channels(&state, &server_id, claims.sub).await {
        return refused;
    }
    let checked = match check_edit(&state, &server_id, claims.sub, edit).await {
        Ok(c) => c,
        Err(refused) => return refused,
    };
    let failed = |e: sqlx::Error| {
        tracing::error!("update_mode: {:?}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save the mode").into_response()
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => return failed(e),
    };
    let current: Option<(String, Option<String>, Option<String>, Option<i32>, bool)> = match sqlx::query_as(
        "SELECT name, background_file_id, accent_color, home_channel_id, auto_off \
         FROM server_modes WHERE id = $1 AND server_id = $2 FOR UPDATE",
    )
    .bind(mode_id)
    .bind(&server_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(row) => row,
        Err(e) => return failed(e),
    };
    let Some((name, old_background, accent, home, auto_off)) = current else {
        return (StatusCode::NOT_FOUND, "No such mode").into_response();
    };
    let background = checked.background.clone().unwrap_or_else(|| old_background.clone());
    if let Err(e) = sqlx::query(
        "UPDATE server_modes SET name = $1, background_file_id = $2, accent_color = $3, \
         home_channel_id = $4, auto_off = $5 WHERE id = $6",
    )
    .bind(checked.name.as_deref().unwrap_or(&name))
    .bind(background.as_deref())
    .bind(checked.accent.clone().unwrap_or(accent))
    .bind(checked.home.unwrap_or(home))
    .bind(checked.auto_off.unwrap_or(auto_off))
    .bind(mode_id)
    .execute(&mut *tx)
    .await
    {
        return failed(e);
    }
    if let Some(channels) = &checked.channel_ids {
        if let Err(e) = write_channels(&mut tx, mode_id, &checked.visible, channels).await {
            return failed(e);
        }
    }
    let replaced = old_background.filter(|old| background.as_ref() != Some(old)).map(|old| (old, claims.sub));
    if let Err(e) = commit_edit(&state, &server_id, tx, replaced).await {
        return failed(e);
    }
    StatusCode::OK.into_response()
}

/// Delete a mode. Deleting the mode that is on turns it off first, with
/// everything turning it off means.
pub async fn delete_mode(
    State(state): State<Arc<AppState>>,
    Path((server_id, mode_id)): Path<(String, i32)>,
    Extension(claims): Extension<Claims>,
) -> Response {
    if let Some(refused) = require_manage_channels(&state, &server_id, claims.sub).await {
        return refused;
    }
    let failed = |e: sqlx::Error| {
        tracing::error!("delete_mode: {:?}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, "Failed to delete the mode").into_response()
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => return failed(e),
    };
    // Locked in the order the switch takes them, server first.
    let active: Option<i32> = match sqlx::query_scalar("SELECT active_mode_id FROM servers WHERE id = $1 FOR UPDATE")
        .bind(&server_id)
        .fetch_one(&mut *tx)
        .await
    {
        Ok(a) => a,
        Err(e) => return failed(e),
    };
    let row: Option<(String, Option<String>)> =
        match sqlx::query_as("SELECT name, background_file_id FROM server_modes WHERE id = $1 AND server_id = $2")
            .bind(mode_id)
            .bind(&server_id)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(r) => r,
            Err(e) => return failed(e),
        };
    let Some((name, background)) = row else {
        return (StatusCode::NOT_FOUND, "No such mode").into_response();
    };
    let was_on = active == Some(mode_id);
    let hidden = if was_on {
        match channels_hidden_by(&mut tx, mode_id, None).await {
            Ok(h) => h,
            Err(e) => return failed(e),
        }
    } else {
        Vec::new()
    };
    if let Err(e) = sqlx::query("DELETE FROM server_modes WHERE id = $1").bind(mode_id).execute(&mut *tx).await {
        return failed(e);
    }
    let switch = was_on.then(|| Switch {
        server_id: server_id.clone(),
        previous: Some(mode_id),
        next: None,
        by: Some(claims.sub),
        hidden,
        details: format!("{name} off (deleted)"),
    });
    let tail = {
        let (state, server_id, caller) = (Arc::clone(&state), server_id.clone(), claims.sub);
        async move {
            if let Some(switch) = switch {
                settle(&state, switch).await;
            }
            push_to_members(&state, &server_id, ServerMessage::ServerModesEdited { server_id: server_id.clone() }).await;
            log_audit_action(&state.pool, &server_id, "mode_delete", caller, None, Some("mode"), Some(&name)).await;
            if let Some(old) = background {
                reclaim_background(&state.pool, &old, caller).await;
            }
        }
    };
    match commit_then(tx, tail).await {
        // Dropping the handle on timeout detaches the task; it carries on.
        Ok(work) => drop(tokio::time::timeout(SWITCH_WAIT, work).await),
        Err(e) => return failed(e),
    }
    StatusCode::OK.into_response()
}

/// The voice channels a switch from `previous` to `next` hides: in the mode that
/// was on and not in the one coming on. A channel both share keeps its call.
async fn channels_hidden_by(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    previous: i32,
    next: Option<i32>,
) -> Result<Vec<i32>, sqlx::Error> {
    let rows: Vec<(i32,)> = sqlx::query_as(
        "SELECT mc.channel_id FROM server_mode_channels mc JOIN channels c ON c.id = mc.channel_id \
         WHERE mc.mode_id = $1 AND c.type = 1 \
           AND mc.channel_id NOT IN (SELECT channel_id FROM server_mode_channels WHERE mode_id = $2)",
    )
    .bind(previous)
    .bind(next)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}

/// A switch that has been written and not yet told to anyone.
struct Switch {
    server_id: String,
    previous: Option<i32>,
    next: Option<i32>,
    by: Option<i64>,
    /// `channels_hidden_by`, read in the switch's transaction.
    hidden: Vec<i32>,
    /// The audit row's words.
    details: String,
}

/// Everything after the commit: tell every member, end the calls in the channels
/// the switch hid, write the audit row. Answers how many people were taken out of
/// each channel.
async fn settle(state: &Arc<AppState>, switch: Switch) -> HashMap<i32, usize> {
    // First, so a client knows why the RoomLeft that follows arrived.
    push_to_members(
        state,
        &switch.server_id,
        ServerMessage::ServerModeChanged {
            server_id: switch.server_id.clone(),
            active_mode_id: switch.next.map(|m| m as i64),
            previous_mode_id: switch.previous.map(|m| m as i64),
            by: switch.by,
        },
    )
    .await;
    // At once rather than one after another: each waits on LiveKit for its SFU cut,
    // and the last person should not hear the game for several seconds longer than
    // the first.
    let evictions = switch
        .hidden
        .iter()
        .flat_map(|&channel| occupants(state, channel).into_iter().map(move |user| (channel, user)))
        .map(|(channel, user)| async move {
            let room = format!("voice_{channel}");
            let out = crate::ws::evict_user_from_voice_room(state, &room, user, true, crate::ws::SelfNotice::Gone).await;
            (channel, out)
        });
    let mut gone: HashMap<i32, usize> = HashMap::new();
    for (channel, out) in futures::future::join_all(evictions).await {
        if out {
            *gone.entry(channel).or_default() += 1;
        }
    }
    let total: usize = gone.values().sum();
    let details = if total > 0 { format!("{}, {} disconnected", switch.details, total) } else { switch.details };
    let action = if switch.by.is_some() { "mode_switch" } else { "mode_auto_off" };
    log_audit_row(&state.pool, &switch.server_id, action, switch.by, None, Some("mode"), Some(&details)).await;
    gone
}

/// [`commit_then`] for a switch: its tail is [`settle`].
async fn commit_and_settle(
    state: &Arc<AppState>,
    tx: sqlx::Transaction<'static, sqlx::Postgres>,
    switch: Switch,
) -> Result<tokio::task::JoinHandle<Option<HashMap<i32, usize>>>, sqlx::Error> {
    let state = Arc::clone(state);
    commit_then(tx, async move { settle(&state, switch).await }).await
}

/// The name of `mode_id` if it is a mode of `server_id`. `None` in, `None` out.
async fn mode_name(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    mode_id: Option<i32>,
    server_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let Some(mode_id) = mode_id else { return Ok(None) };
    sqlx::query_scalar("SELECT name FROM server_modes WHERE id = $1 AND server_id = $2")
        .bind(mode_id)
        .bind(server_id)
        .fetch_optional(&mut **tx)
        .await
}

/// Turn a mode on (replacing the current one) or off. A mode has one effect on
/// the server's own state beyond this column: anyone in a voice channel the
/// switch hid is disconnected.
pub async fn set_active_mode(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(request): Json<SetActiveRequest>,
) -> Response {
    if !user_has_permission(&state.pool, &server_id, claims.sub, Permissions::SWITCH_MODES).await {
        return (StatusCode::FORBIDDEN, "Missing the Switch Modes permission").into_response();
    }
    let failed = |e: sqlx::Error| {
        tracing::error!("set_active_mode: {:?}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, "Failed to switch the mode").into_response()
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => return failed(e),
    };
    // The row lock serialises two switches, so each reads the other's result as
    // its `previous` and neither one's hidden channels are missed.
    let previous: Option<i32> = match sqlx::query_scalar("SELECT active_mode_id FROM servers WHERE id = $1 FOR UPDATE")
        .bind(&server_id)
        .fetch_one(&mut *tx)
        .await
    {
        Ok(p) => p,
        Err(e) => return failed(e),
    };
    let next_name = match mode_name(&mut tx, request.mode_id, &server_id).await {
        Ok(n) => n,
        Err(e) => return failed(e),
    };
    if request.mode_id.is_some() && next_name.is_none() {
        return (StatusCode::NOT_FOUND, "No such mode").into_response();
    }
    if previous == request.mode_id {
        return Json(SwitchResponse { active_mode_id: previous.map(|m| m as i64), disconnected: Some(0) }).into_response();
    }
    let previous_name = match mode_name(&mut tx, previous, &server_id).await {
        Ok(n) => n,
        Err(e) => return failed(e),
    };
    let hidden = match previous {
        Some(p) => match channels_hidden_by(&mut tx, p, request.mode_id).await {
            Ok(h) => h,
            Err(e) => return failed(e),
        },
        None => Vec::new(),
    };
    if let Err(e) = sqlx::query("UPDATE servers SET active_mode_id = $1, active_mode_occupied_at = NULL WHERE id = $2")
        .bind(request.mode_id)
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        return failed(e);
    }
    let details = match (&previous_name, &next_name) {
        (Some(off), Some(on)) => format!("{off} off, {on} on"),
        (Some(off), None) => format!("{off} off"),
        (None, Some(on)) => format!("{on} on"),
        (None, None) => String::new(),
    };
    let switch = Switch {
        server_id: server_id.clone(),
        previous,
        next: request.mode_id,
        by: Some(claims.sub),
        hidden,
        details,
    };
    let work = match commit_and_settle(&state, tx, switch).await {
        Ok(work) => work,
        Err(e) => return failed(e),
    };
    // Dropping the handle on timeout detaches the task; it carries on.
    let gone = tokio::time::timeout(SWITCH_WAIT, work).await.ok().and_then(Result::ok).flatten();
    let disconnected = match gone {
        Some(gone) => counted_for(&state, &server_id, claims.sub, &gone).await,
        None => None,
    };
    Json(SwitchResponse { active_mode_id: request.mode_id.map(|m| m as i64), disconnected }).into_response()
}

/// How many of those a caller may be told about: the people in channels they can
/// see. A room hidden from them must read like no call at all (as a voice move's
/// answer does). The audit log, which only administrators read, has the whole count.
async fn counted_for(state: &AppState, server_id: &str, caller: i64, gone: &HashMap<i32, usize>) -> Option<usize> {
    let ids: Vec<i64> = gone.keys().map(|&c| c as i64).collect();
    let perms = get_user_channels_permissions(&state.pool, server_id, caller, &ids).await.ok()?;
    Some(
        gone.iter()
            .filter(|(&channel, _)| perms.get(&(channel as i64)).is_some_and(|p| p.has(Permissions::VIEW_CHANNEL)))
            .map(|(_, &count)| count)
            .sum(),
    )
}

/// Call everyone back: pull everyone in the active mode's voice channels into its
/// main channel. Each person goes through the same checks as a drag in the member
/// list, so nobody ranked at or above the caller moves; they are counted instead.
/// The caller moves themselves: the voice-move route refuses a move of yourself,
/// and their client takes the same path as tapping the channel.
pub async fn call_everyone_back(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> Response {
    if !user_has_permission(&state.pool, &server_id, claims.sub, Permissions::MOVE_MEMBERS).await {
        return (StatusCode::FORBIDDEN, "Missing MOVE_MEMBERS permission").into_response();
    }
    let failed = |e: sqlx::Error| {
        tracing::error!("call_everyone_back: {:?}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, "Failed to call everyone back").into_response()
    };
    let active: Option<(i32, Option<i32>)> = match sqlx::query_as(
        "SELECT m.id, m.home_channel_id FROM servers s JOIN server_modes m ON m.id = s.active_mode_id WHERE s.id = $1",
    )
    .bind(&server_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(a) => a,
        Err(e) => return failed(e),
    };
    let Some((mode_id, home)) = active else {
        return (StatusCode::CONFLICT, "No mode is on").into_response();
    };
    let Some(home) = home else {
        return (StatusCode::CONFLICT, "This mode has no main voice channel").into_response();
    };
    // Listed right now: in this mode, or in none. A main channel hidden since
    // (another mode took it over) is nowhere anyone could follow.
    let elsewhere: bool = match sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM server_mode_channels WHERE channel_id = $1) \
            AND NOT EXISTS (SELECT 1 FROM server_mode_channels WHERE channel_id = $1 AND mode_id = $2)",
    )
    .bind(home)
    .bind(mode_id)
    .fetch_one(&state.pool)
    .await
    {
        Ok(b) => b,
        Err(e) => return failed(e),
    };
    let caller_sees_home = matches!(
        get_user_channel_permissions(&state.pool, home as i64, claims.sub).await,
        ChannelPermAccess::Allowed { perms, .. } if perms.has(Permissions::VIEW_CHANNEL)
    );
    if elsewhere || !caller_sees_home {
        return (StatusCode::CONFLICT, "This mode has no main voice channel").into_response();
    }
    let sources = match mode_voice_channels(&state.pool, mode_id).await {
        Ok(s) => s,
        Err(e) => return failed(e),
    };
    // Only rooms the caller can see. A voice move answers 409 for anyone in a room
    // hidden from the mover, so that it reads like no call at all, and counting
    // those as `skipped` would have told them someone was in there.
    let source_ids: Vec<i64> = sources.iter().map(|&c| c as i64).collect();
    let source_perms = match get_user_channels_permissions(&state.pool, &server_id, claims.sub, &source_ids).await {
        Ok(p) => p,
        Err(e) => return failed(e),
    };
    let mut targets: Vec<UserId> = sources
        .into_iter()
        .filter(|&channel| channel != home)
        .filter(|&channel| source_perms.get(&(channel as i64)).is_some_and(|p| p.has(Permissions::VIEW_CHANNEL)))
        .flat_map(|channel| occupants(&state, channel))
        .filter(|&user| user != claims.sub)
        .collect();
    targets.sort_unstable();
    targets.dedup();
    let moves = targets.into_iter().map(|user| {
        perform_voice_move(
            Arc::clone(&state),
            server_id.clone(),
            &claims,
            user,
            VoiceMoveRequest { channel_id: Some(home as i64) },
        )
    });
    let outcomes = futures::future::join_all(moves).await;
    let moved = outcomes.iter().filter(|r| r.status().is_success()).count();
    Json(CallBackResponse { moved, skipped: outcomes.len() - moved }).into_response()
}

/// Called once at boot, before the first tick. Voice rooms live in memory, so after
/// a restart every room reads empty though nobody chose to leave, and a mode whose
/// last sighting predates an outage would turn off before anyone had reconnected.
/// A restart starts the window again. A mode nobody had joined stays unjoined.
pub async fn auto_off_after_restart(state: &AppState) {
    if let Err(e) = sqlx::query("UPDATE servers SET active_mode_occupied_at = NOW() WHERE active_mode_occupied_at IS NOT NULL")
        .execute(&state.pool)
        .await
    {
        tracing::error!("modes: auto-off restart grace failed: {:?}", e);
    }
}

/// One pass of the auto-off (a once-a-minute task in main.rs). A failed read
/// waits for the next tick: nothing here is urgent, and a mode left on is
/// harmless.
pub async fn auto_off_tick(state: &Arc<AppState>) {
    let rows: Vec<(String, i32, Option<i32>, String, bool, bool)> = match sqlx::query_as(
        "SELECT s.id, m.id, m.home_channel_id, m.name, s.active_mode_occupied_at IS NOT NULL, \
                COALESCE(s.active_mode_occupied_at < NOW() - make_interval(mins => $1), false) \
         FROM servers s JOIN server_modes m ON m.id = s.active_mode_id WHERE m.auto_off",
    )
    .bind(AUTO_OFF_EMPTY_MINUTES)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("modes: auto-off read failed: {:?}", e);
            return;
        }
    };
    for (server_id, mode_id, home, name, seen, stale) in rows {
        let mut voice = match mode_voice_channels(&state.pool, mode_id).await {
            Ok(v) => v,
            Err(e) => {
                tracing::error!("modes: auto-off channels of mode {} failed: {:?}", mode_id, e);
                continue;
            }
        };
        // The main channel may be an always-listed one, in no mode. People gathered
        // there are still playing.
        voice.extend(home);
        let occupied = voice.iter().any(|&channel| !occupants(state, channel).is_empty());
        match auto_off_verdict(occupied, seen, stale) {
            AutoOff::Keep => {}
            AutoOff::Touch => {
                if let Err(e) = sqlx::query(
                    "UPDATE servers SET active_mode_occupied_at = NOW() WHERE id = $1 AND active_mode_id = $2",
                )
                .bind(&server_id)
                .bind(mode_id)
                .execute(&state.pool)
                .await
                {
                    tracing::error!("modes: auto-off touch of server {} failed: {:?}", server_id, e);
                }
            }
            AutoOff::TurnOff => turn_off_empty(state, &server_id, mode_id, &name).await,
        }
    }
}

/// [`AutoOff::TurnOff`]. Re-checks in the UPDATE, so a switch that landed since
/// the read stands. Someone who joined in the instant between goes with it, like
/// anyone else in the channels when a mode ends.
async fn turn_off_empty(state: &Arc<AppState>, server_id: &str, mode_id: i32, name: &str) {
    let failed = |e: sqlx::Error| tracing::error!("modes: auto-off of server {} failed: {:?}", server_id, e);
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => return failed(e),
    };
    let done = sqlx::query(
        "UPDATE servers SET active_mode_id = NULL, active_mode_occupied_at = NULL \
         WHERE id = $1 AND active_mode_id = $2 AND active_mode_occupied_at < NOW() - make_interval(mins => $3)",
    )
    .bind(server_id)
    .bind(mode_id)
    .bind(AUTO_OFF_EMPTY_MINUTES)
    .execute(&mut *tx)
    .await;
    match done {
        Ok(r) if r.rows_affected() == 1 => {}
        Ok(_) => return,
        Err(e) => return failed(e),
    }
    let hidden = match channels_hidden_by(&mut tx, mode_id, None).await {
        Ok(h) => h,
        Err(e) => return failed(e),
    };
    let switch = Switch {
        server_id: server_id.to_string(),
        previous: Some(mode_id),
        next: None,
        by: None,
        hidden,
        details: format!("{name} off"),
    };
    match commit_and_settle(state, tx, switch).await {
        // Waited for, boundedly, so the next server's turn comes after this one's
        // disconnects unless LiveKit is slow; the handle detaches on a timeout.
        Ok(work) => drop(tokio::time::timeout(SWITCH_WAIT, work).await),
        Err(e) => failed(e),
    }
}

#[cfg(test)]
#[path = "mode_handlers_tests.rs"]
mod tests;
