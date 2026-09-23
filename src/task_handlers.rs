//! Task Handlers
//!
//! REST API handlers for checklist tasks. Tasks live in one of two scopes:
//! a channel checklist (any server member may collaborate) or a personal
//! task list (owner only, Google Keep style). Tasks nest under a parent
//! task ("subtasks") up to MAX_TASK_DEPTH levels.

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::Claims;
use crate::permissions::{get_user_channel_permissions, ChannelPermAccess, Permissions};
use crate::protocol::ServerMessage;
use crate::state::AppState;

/// Length caps for user-supplied task/list text (bytes). Without these the
/// only ceiling is the global 2 MB body limit, and list endpoints materialize
/// every row — a memory-amplification lever for any member/owner.
const MAX_TASK_LEN: usize = 8000;
const MAX_LIST_TITLE_LEN: usize = 200;
/// Sealed attachments sidecar (client-side-encrypted JSON of up to 12 refs).
const MAX_ATTACHMENTS_LEN: usize = 16384;
/// Sealed EventSchedule (calendar/recurrence; see task_timing.rs). The client
/// pads the plaintext to a bucket of at most 8 KiB; sealing adds ~35% plus
/// the envelope, so 16 KiB leaves real headroom for both envelope kinds.
const MAX_SCHEDULE_LEN: usize = crate::task_timing::MAX_SCHEDULE_LEN;
/// Sealed snooze ({forDue, until}), padded to 128 bytes by the client.
const MAX_SNOOZE_LEN: usize = crate::task_timing::MAX_SNOOZE_LEN;
/// Ceiling on tasks per checklist scope (one channel checklist or one personal
/// list). Without it a member could post tens of thousands of tasks; every
/// list fetch materializes all of them and each change fans a ChecklistUpdate
/// out to all viewers — a cheap griefing/DoS lever.
const MAX_TASKS_PER_CHECKLIST: i64 = 2000;

/// Tell other viewers of a checklist CHANNEL that its tasks changed, so their
/// UIs refetch live (like reactions do for messages). Personal-list tasks
/// (channel_id is None) are owner-only, so there's no one else to notify.
/// The actor is excluded — their own client already applied the change.
fn broadcast_checklist(state: &AppState, channel_id: Option<i64>, exclude: i64) {
    if let Some(cid) = channel_id {
        state.broadcast_to_room(
            &format!("channel_{}", cid),
            ServerMessage::ChecklistUpdate { channel_id: cid },
            Some(exclude),
        );
    }
}

/// Idempotent creates (migration 070).
///
/// A create may carry `op_key`: a RANDOM id the client made once, when the
/// user acted, and repeats on every retry. The server claims it in the same
/// transaction as the insert; a replay finds the key taken and is answered
/// with the row that create already made, so a lost response can no longer
/// turn one note into two.
///
/// THE KEY IS NEVER DERIVED FROM CONTENT. A digest of a title or an item
/// would be a stable fingerprint the server could correlate across notes and
/// accounts. This shape check CANNOT tell a random id from a hex SHA-256
/// (which is 64 url-safe characters and passes), so the rule lives with the
/// client that mints the key and is pinned by its tests; here we only keep
/// the value a short, indexable identifier. It is never logged.
fn validate_op_key(key: &str) -> Result<(), (StatusCode, &'static str)> {
    let ok = (16..=64).contains(&key.len())
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err((StatusCode::BAD_REQUEST, "Bad create key"))
    }
}

/// Claim `key` for this user inside `tx`, returning the id the create that
/// first used it made, THE SCOPE it was made in, and whether THIS call is
/// that first create.
///
/// `DO UPDATE` rather than `DO NOTHING` on purpose: DO NOTHING returns no row
/// when a CONCURRENT transaction holds the key uncommitted, leaving the loser
/// with neither an insert nor an id. DO UPDATE takes the row lock and waits
/// for the winner, then reads its `created_id`. `xmax = 0` is true only for a
/// row this statement inserted.
///
/// The scope comes back because `created_id` alone does not identify a row:
/// `task_lists.id` and `channel_tasks.id` are independent sequences, so a key
/// first spent on a note and then replayed on an item names an id that CAN
/// exist in the other table. Without comparing the scope, the caller's
/// "wrong scope" refusal would only be an accident of those two id spaces not
/// overlapping on this particular database.
async fn claim_op_key(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: i64,
    key: &str,
    scope: &str,
    created_id: i64,
) -> Result<(i64, String, bool), sqlx::Error> {
    sqlx::query_as(
        "INSERT INTO task_create_keys (user_id, op_key, scope, created_id) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (user_id, op_key) DO UPDATE SET op_key = EXCLUDED.op_key \
         RETURNING created_id, scope, (xmax = 0) AS inserted",
    )
    .bind(user_id)
    .bind(key)
    .bind(scope)
    .bind(created_id)
    .fetch_one(&mut **tx)
    .await
}

/// Is this key already spent, and on what? `Some((created_id, scope))` for a
/// key whose create has COMMITTED; None for one this server has never seen
/// (or one still uncommitted in another transaction, which `claim_op_key`
/// then settles properly).
///
/// Read before the create's own checks so that a REPLAY is answered rather
/// than re-validated: the request it repeats was validated when it landed,
/// and the state it is judged against has moved on since — most sharply the
/// per-checklist cap, which COUNTS the very item the key made. This is a
/// short-circuit only; the transactional claim stays the authority for a key
/// that is new or racing.
async fn find_op_key(
    pool: &sqlx::PgPool,
    user_id: i64,
    key: &str,
) -> Result<Option<(i64, String)>, sqlx::Error> {
    sqlx::query_as("SELECT created_id, scope FROM task_create_keys WHERE user_id = $1 AND op_key = $2")
        .bind(user_id)
        .bind(key)
        .fetch_optional(pool)
        .await
}

/// The item an already-claimed key made, scoped to this caller and this
/// checklist — so a key replayed against a different note is refused rather
/// than answered with a row from somewhere else.
async fn re_serve_task(
    state: &AppState,
    user_id: i64,
    channel_id: Option<i64>,
    list_id: Option<i64>,
    created_id: i64,
    key_scope: &str,
) -> Result<TaskResponse, (StatusCode, &'static str)> {
    // The key was spent on something that is not an item: `created_id` names
    // a row in another table and must never be looked up here.
    if key_scope != "task" {
        return Err((StatusCode::CONFLICT, REPLAY_WRONG_SCOPE_MESSAGE));
    }
    let sql = format!(
        "SELECT {TASK_COLUMNS} FROM channel_tasks \
         WHERE id = $1 AND created_by = $2 \
         AND channel_id IS NOT DISTINCT FROM $3 AND list_id IS NOT DISTINCT FROM $4"
    );
    let existing: Option<TaskRow> = sqlx::query_as(&sql)
        .bind(created_id)
        .bind(user_id)
        .bind(channel_id)
        .bind(list_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| {
            tracing::error!("Failed to re-serve a replayed item: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create task")
        })?;
    match existing {
        Some(r) => Ok(task_row_to_response(r)),
        None => Err((StatusCode::CONFLICT, REPLAY_GONE_MESSAGE)),
    }
}

/// What a replay whose original row is gone gets: the create really did
/// happen, and re-running it would resurrect something the user deleted.
const REPLAY_GONE_MESSAGE: &str = "That was already created, and has since been removed";

/// What a key spent on one kind of thing and replayed on another gets. Never
/// a client doing what it is told to: one key is minted per create, for that
/// create. Answering it with the row from the other scope would hand back
/// something unrelated and throw the typed text away.
const REPLAY_WRONG_SCOPE_MESSAGE: &str = "That create key was already used for something else";

// --- DTOs ---

#[derive(Serialize)]
pub struct TaskResponse {
    pub id: i64,
    pub channel_id: Option<i64>,
    pub list_id: Option<i64>,
    pub parent_id: Option<i64>,
    pub description: String,
    pub is_completed: bool,
    pub position: i64,
    pub created_at: String,
    pub created_by: i64,
    /// Sealed attachments JSON (same key path as the description); None = none.
    pub attachments: Option<String>,
    /// Optional due time (RFC3339). Plaintext metadata like is_completed —
    /// the server learns WHEN, never WHAT (descriptions stay E2EE). For an
    /// item with a schedule it is the NEXT reminder instant.
    pub due_at: Option<String>,
    /// Sealed EventSchedule, or null. ALWAYS serialized (no skip), so every
    /// task a 066+ server returns carries the key.
    pub schedule: Option<String>,
    /// Sealed snooze, or null. Always serialized, like schedule.
    pub snooze: Option<String>,
    /// When the item's content last changed (RFC3339; created_at for rows
    /// that predate migration 066).
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct CreateTaskRequest {
    pub description: String,
    pub parent_id: Option<i64>,
    pub attachments: Option<String>,
    /// RFC3339 due time; absent/null = none.
    pub due_at: Option<String>,
    /// Sealed EventSchedule, so an event is created in ONE request with its
    /// due_at. Absent/null/"" = none. Serde-defaulted: older clients omit it.
    #[serde(default)]
    pub schedule: Option<String>,
    /// Idempotent create (migration 070): see TaskListRequest::op_key.
    #[serde(default)]
    pub op_key: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateTaskRequest {
    pub is_completed: Option<bool>,
    pub description: Option<String>,
    /// None = leave unchanged; Some("") = clear to NULL; Some(s) = replace.
    pub attachments: Option<String>,
    /// Same three-state contract as attachments: None = keep, Some("") =
    /// clear, Some(rfc3339) = set.
    pub due_at: Option<String>,
    /// The highest envelope version the editing client can OPEN — see
    /// envelope_version.rs. Absent from clients that predate it.
    #[serde(default)]
    pub reads_up_to: Option<u64>,
    /// Sealed EventSchedule; the three-state contract of attachments.
    /// Creator or MANAGE_TASKS, like the description.
    #[serde(default)]
    pub schedule: Option<String>,
    /// Sealed snooze; three-state. COMPLETE_TASKS (or MANAGE_TASKS), like
    /// ticking the item: snoozing is what a completer does to a reminder.
    #[serde(default)]
    pub snooze: Option<String>,
    /// Compare-and-swap on due_at: "" = expect NULL, RFC3339 = expect that
    /// instant, absent = no check. A mismatch is 409 and nothing is written —
    /// two devices advancing the same reminder cannot both win.
    #[serde(default)]
    pub expect_due_at: Option<String>,
    /// The client knows about schedules: completing an item (or a parent of
    /// one) that carries a schedule is refused without it, because an older
    /// client would silently end a repeating series (task_timing.rs).
    #[serde(default)]
    pub recurrence_aware: bool,
    /// Reopen every task under this one (a repeating task that advanced to
    /// its next occurrence starts it with its subtasks unticked).
    #[serde(default)]
    pub reopen_subtree: bool,
}

/// Parse a request's due time. "" means "clear" and maps to None; anything
/// else must be RFC3339 (what the client's Date.toISOString produces).
fn parse_due(raw: &str) -> Result<Option<chrono::DateTime<chrono::Utc>>, (StatusCode, &'static str)> {
    if raw.is_empty() {
        return Ok(None);
    }
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|d| Some(d.with_timezone(&chrono::Utc)))
        .map_err(|_| (StatusCode::BAD_REQUEST, "due_at must be an RFC3339 timestamp"))
}

#[derive(Deserialize)]
pub struct MoveTaskRequest {
    pub direction: String, // "up" | "down"
}

#[derive(Deserialize)]
pub struct ReorderTaskRequest {
    /// Sibling to land immediately after; None = first in the sibling group.
    pub after_id: Option<i64>,
    /// S1: also move to a DIFFERENT parent in the same drop (drag-to-nest).
    /// `false` — the serde default, and what every pre-S1 client's absent
    /// field decodes to — keeps the old semantics exactly: parent untouched,
    /// `after_id` judged against the CURRENT parent's siblings.
    #[serde(default)]
    pub reparent: bool,
    /// The new parent when `reparent`; None = move to top level. Ignored
    /// (deliberately, not an error) when `reparent` is false, so an old
    /// server receiving a new client's frame and a new server receiving an
    /// old client's frame both do something sensible.
    #[serde(default)]
    pub parent_id: Option<i64>,
}

#[derive(Serialize)]
pub struct TaskListResponse {
    pub id: i64,
    pub title: String,
    pub created_at: String,
    pub total_tasks: i64,
    pub completed_tasks: i64,
    /// Sealed-to-self body / attachments sidecar, and the trash time
    /// (list_content.rs). Always present (null = none).
    pub body: Option<String>,
    pub attachments: Option<String>,
    pub trashed_at: Option<String>,
    /// The "Notes to self" list (get_self_checklist). It cannot be trashed
    /// (list_content::trash_list), so a client hides "Move to trash" for it.
    pub is_self: bool,
    /// Last edit of the list or any of its items (migration 066 triggers);
    /// created_at for a list untouched since before it.
    pub updated_at: String,
    /// The NOTE's own reminder (migration 068), independent of its items:
    /// the next reminder instant in plaintext, exactly what an item's due_at
    /// costs, and the sealed EventSchedule it was derived from. Always
    /// serialized (null = none), so every list a 068+ server returns carries
    /// both keys and a client can tell them from an older server's silence.
    pub due_at: Option<String>,
    pub schedule: Option<String>,
    /// How many times this note's OWN content — its title, its sealed body,
    /// its sealed attachments sidecar — has been written (migration 069).
    /// Ticking, adding or reordering an ITEM does not move it. A client sends
    /// it back as `expect_rev` so a stale save is refused instead of landing
    /// over a newer one. ALWAYS serialized, so every row a 069+ server
    /// returns carries the key.
    pub content_rev: i64,
}

/// due_at as every task-list query renders it (the same shape as created_at).
const LIST_DUE_AT: &str = "(replace((due_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS due_at";

/// updated_at as every task-list query renders it.
const LIST_UPDATED_AT: &str = "(replace((COALESCE(updated_at, created_at) AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS updated_at";

#[derive(Deserialize)]
pub struct TaskListRequest {
    /// Required on create. On PATCH, absent = leave the title alone, so a
    /// body-only edit needs no title (every older client always sends one).
    #[serde(default)]
    pub title: Option<String>,
    /// Sealed body and attachments sidecar: absent = keep, "" = clear,
    /// an envelope = replace (list_content::check_sealed_field).
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub attachments: Option<String>,
    /// See UpdateTaskRequest::reads_up_to.
    #[serde(default)]
    pub reads_up_to: Option<u64>,
    /// The NOTE's own reminder time (migration 068). The same three-state
    /// contract as everything else here: absent = keep, "" = clear,
    /// RFC3339 = set.
    #[serde(default)]
    pub due_at: Option<String>,
    /// The note's sealed EventSchedule; three-state, sealed to self
    /// (task_timing::validate_sealed — a personal list has no channel to
    /// bind, so NOT validate_sealed_scoped).
    #[serde(default)]
    pub schedule: Option<String>,
    /// Compare-and-swap on the note's due_at, exactly as
    /// UpdateTaskRequest::expect_due_at is for an item: "" = expect NULL,
    /// RFC3339 = expect that instant, absent = no check.
    #[serde(default)]
    pub expect_due_at: Option<String>,
    /// Compare-and-swap on the note's content revision (migration 069): the
    /// `content_rev` this edit is based on. Absent = no check, which is what
    /// every client older than 069 sends and what an op queued before it
    /// replays as. A mismatch is 409 carrying the current copy, and NOTHING
    /// is written.
    #[serde(default)]
    pub expect_rev: Option<i64>,
    /// Idempotent create (migration 070): a RANDOM client id for this one
    /// create, unchanged across retries. Absent = today's unguarded create.
    /// Ignored on PATCH. See `validate_op_key`.
    #[serde(default)]
    pub op_key: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct TaskListsQuery {
    /// `?trashed=true` lists the trash instead of the live lists.
    #[serde(default)]
    pub trashed: Option<bool>,
}

type TaskRow = (
    i64,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    String,
    bool,
    i64,
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

fn task_row_to_response(row: TaskRow) -> TaskResponse {
    let (
        id,
        channel_id,
        list_id,
        parent_id,
        description,
        is_completed,
        position,
        created_at,
        created_by,
        attachments,
        due_at,
        schedule,
        snooze,
        updated_at,
    ) = row;
    TaskResponse {
        id,
        channel_id,
        list_id,
        parent_id,
        description,
        is_completed,
        position,
        created_at,
        created_by,
        attachments,
        due_at,
        schedule,
        snooze,
        updated_at,
    }
}

// NULL due_at stays NULL through the replace/concat (both are strict).
const TASK_COLUMNS: &str =
    "id, channel_id, list_id, parent_id, description, is_completed, position, (replace((created_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS created_at, created_by, attachments, (replace((due_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS due_at, schedule, snooze, (replace((COALESCE(updated_at, created_at) AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS updated_at";

// --- Scope checks ---

/// Resolve a channel's server and the caller's effective permissions there,
/// requiring VIEW_CHANNEL as the baseline. The resolver itself gates on actual
/// server membership first (a non-member never reaches the permission math), a
/// member who is VIEW-denied gets the same 404 as a missing channel (hide its
/// existence), and DB errors fail closed inside the resolver. Callers layer
/// per-operation bits (CREATE_TASKS / COMPLETE_TASKS / MANAGE_TASKS) on top.
async fn check_channel_access(
    state: &AppState,
    channel_id: i64,
    claims: &Claims,
) -> Result<Permissions, (StatusCode, &'static str)> {
    match get_user_channel_permissions(&state.pool, channel_id, claims.sub).await {
        ChannelPermAccess::Allowed { perms, .. } => {
            if perms.has(Permissions::VIEW_CHANNEL) {
                Ok(perms)
            } else {
                Err((StatusCode::NOT_FOUND, "Channel not found"))
            }
        }
        ChannelPermAccess::NotFound => Err((StatusCode::NOT_FOUND, "Channel not found")),
        ChannelPermAccess::NotMember => Err((StatusCode::FORBIDDEN, "Access denied")),
    }
}

/// Confirm the caller owns the given personal list. `Ok(true)` = it is in
/// the trash (readable, not writable — see check_list_writable).
async fn check_list_owner(
    state: &AppState,
    list_id: i64,
    claims: &Claims,
) -> Result<bool, (StatusCode, &'static str)> {
    let owner: Option<(i64, bool)> = sqlx::query_as("SELECT owner_id, trashed_at IS NOT NULL FROM task_lists WHERE id = $1")
        .bind(list_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);

    match owner {
        None => Err((StatusCode::NOT_FOUND, "List not found")),
        Some((owner_id, trashed)) if owner_id == claims.sub => Ok(trashed),
        // Same answer as a missing list: a 403 here told any account which
        // sequential list ids belong to someone (see check_channel_access).
        Some(_) => Err((StatusCode::NOT_FOUND, "List not found")),
    }
}

/// check_list_owner for a WRITE: a trashed list is read-only until restored
/// (409), so an item cannot change under a note the owner has put away — and
/// a stale device cannot keep editing a note another one trashed.
async fn check_list_writable(
    state: &AppState,
    list_id: i64,
    claims: &Claims,
) -> Result<(), (StatusCode, &'static str)> {
    if check_list_owner(state, list_id, claims).await? {
        return Err((StatusCode::CONFLICT, crate::list_content::TRASHED_MESSAGE));
    }
    Ok(())
}

/// Everything a task-scoped handler needs to authorize an operation.
struct TaskAccess {
    /// The task's channel (None for personal-list tasks).
    channel_id: Option<i64>,
    /// The task's creator (channel_tasks.created_by).
    created_by: i64,
    /// The caller's effective channel permissions — Some for channel-scoped
    /// tasks, None for personal-list tasks (owner-only, already authorized).
    perms: Option<Permissions>,
}

impl TaskAccess {
    /// Channel-scope check: the caller created the task or holds MANAGE_TASKS.
    /// Personal-list tasks (no channel perms) are always the owner's own.
    fn can_manage(&self, user_id: i64) -> bool {
        match self.perms {
            Some(perms) => self.created_by == user_id || perms.has(Permissions::MANAGE_TASKS),
            None => true,
        }
    }
}

/// Authorize access to an existing task in either scope. Channel-scoped tasks
/// require VIEW_CHANNEL (per-operation bits are the caller's job); personal
/// lists stay owner-only.
async fn check_task_access(
    state: &AppState,
    task_id: i64,
    claims: &Claims,
) -> Result<TaskAccess, (StatusCode, &'static str)> {
    let scope: Option<(Option<i64>, Option<i64>, i64)> = match sqlx::query_as(
        "SELECT channel_id, list_id, created_by FROM channel_tasks WHERE id = $1",
    )
    .bind(task_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(s) => s,
        Err(e) => {
            // Fail closed, but loudly — a silent unwrap_or(None) would turn a
            // transient DB failure into "task not found" with nothing logged.
            tracing::error!(
                "check_task_access: task lookup failed for {}: {:?}",
                task_id,
                e
            );
            return Err((StatusCode::NOT_FOUND, "Task not found"));
        }
    };

    let (channel_id, list_id, created_by) = match scope {
        Some(s) => s,
        None => return Err((StatusCode::NOT_FOUND, "Task not found")),
    };

    let perms = if let Some(cid) = channel_id {
        Some(check_channel_access(state, cid, claims).await?)
    } else if let Some(lid) = list_id {
        // Every caller of check_task_access is a write (update, move,
        // reorder, delete), so a trashed list refuses here.
        check_list_writable(state, lid, claims).await?;
        None
    } else {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, "Task has no scope"));
    };
    Ok(TaskAccess {
        channel_id,
        created_by,
        perms,
    })
}

/// Deepest allowed nesting level (top-level = 1). Mirrored by MAX_TASK_DEPTH
/// in frontend/src/api/tasks.ts, which hides the add-subtask affordance at
/// the cap; this check is the enforcement.
const MAX_TASK_DEPTH: i64 = 5;

/// Validate a requested parent task: it must exist in the same scope, and
/// nesting under it must not exceed MAX_TASK_DEPTH levels.
async fn validate_parent(
    state: &AppState,
    parent_id: i64,
    channel_id: Option<i64>,
    list_id: Option<i64>,
) -> Result<(), (StatusCode, &'static str)> {
    let parent: Option<(Option<i64>, Option<i64>)> =
        sqlx::query_as("SELECT channel_id, list_id FROM channel_tasks WHERE id = $1")
            .bind(parent_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);

    match parent {
        None => return Err((StatusCode::BAD_REQUEST, "Parent task not found")),
        Some((p_channel, p_list)) => {
            // Same message as a missing parent: a distinct one confirmed that a
            // guessed task id exists in some checklist the caller cannot see.
            if p_channel != channel_id || p_list != list_id {
                return Err((StatusCode::BAD_REQUEST, "Parent task not found"));
            }
        }
    }

    // Depth of the parent = ancestors walked up to the root (cycle-safe via the
    // depth bound). A new child sits at parent depth + 1.
    // NOTE: depth must be bigint end-to-end — `1 AS depth` would be INT4 and
    // the i64 decode fails SILENTLY through unwrap_or(None) (looks like a
    // missing parent).
    let depth: Option<(Option<i64>,)> = sqlx::query_as(
        "WITH RECURSIVE chain AS ( \
             SELECT id, parent_id, 1::bigint AS depth FROM channel_tasks WHERE id = $1 \
             UNION ALL \
             SELECT t.id, t.parent_id, c.depth + 1 FROM channel_tasks t \
             JOIN chain c ON t.id = c.parent_id \
             WHERE c.depth < $2 + 1 \
         ) SELECT MAX(depth) FROM chain",
    )
    .bind(parent_id)
    .bind(MAX_TASK_DEPTH)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    match depth.and_then(|d| d.0) {
        Some(d) if d < MAX_TASK_DEPTH => Ok(()),
        Some(_) => Err((StatusCode::BAD_REQUEST, "Tasks can only nest 5 levels deep")),
        None => Err((StatusCode::BAD_REQUEST, "Parent task not found")),
    }
}

/// Insert one item. `Ok((task, true))` = it was created here; `Ok((task,
/// false))` = this request carried an `op_key` that had already been used, so
/// the item it made is re-served and NOTHING was written (in particular, no
/// live event and no channel broadcast — a retry must not look like a second
/// change to everyone else).
async fn insert_task(
    state: &AppState,
    channel_id: Option<i64>,
    list_id: Option<i64>,
    payload: &CreateTaskRequest,
    claims: &Claims,
) -> Result<(TaskResponse, bool), (StatusCode, &'static str)> {
    if let Some(key) = payload.op_key.as_deref() {
        validate_op_key(key)?;
        // A REPLAY IS ANSWERED, NOT RE-VALIDATED. Everything below judges a
        // NEW item against the checklist as it stands now, and for a retry
        // that state has moved on — the item this key already made is itself
        // one of the rows the cap counts, so a list standing at exactly
        // MAX_TASKS_PER_CHECKLIST answered the retry with 400 "This checklist
        // has reached its task limit". The outbox treats a non-5xx as
        // unrecoverable (notes/model/notesOutbox.ts): it drops the op and
        // tells the user their item could not be saved, while the server has
        // had it all along. The same goes for a parent deleted since.
        if let Some((created_id, scope)) = find_op_key(&state.pool, claims.sub, key)
            .await
            .map_err(|e| {
                tracing::error!("Failed to read a create key: {:?}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create task")
            })?
        {
            let row = re_serve_task(state, claims.sub, channel_id, list_id, created_id, &scope).await?;
            return Ok((row, false));
        }
    }
    if payload.description.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Description cannot be empty"));
    }
    if payload.description.len() > MAX_TASK_LEN {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "Task description too long"));
    }
    if payload.description.contains('\0') {
        return Err((StatusCode::BAD_REQUEST, "Task contains invalid characters"));
    }
    if let Some(att) = payload.attachments.as_deref() {
        if att.len() > MAX_ATTACHMENTS_LEN {
            return Err((StatusCode::BAD_REQUEST, "Attachments too large"));
        }
        if att.contains('\0') {
            return Err((
                StatusCode::BAD_REQUEST,
                "Attachments contain invalid characters",
            ));
        }
    }
    let schedule = match payload.schedule.as_deref() {
        Some(raw) => crate::task_timing::validate_sealed_scoped(raw, MAX_SCHEDULE_LEN, "schedule", channel_id.is_some())?,
        None => None,
    };
    if let Some(pid) = payload.parent_id {
        validate_parent(state, pid, channel_id, list_id).await?;
    }

    // M14: cap tasks per checklist scope. A small overshoot under concurrent
    // inserts is harmless; the point is to keep a single scope from growing
    // without bound. NOT DISTINCT FROM so the NULL channel_id/list_id (the other
    // scope) matches the same way the position subquery below does.
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM channel_tasks \
         WHERE channel_id IS NOT DISTINCT FROM $1 AND list_id IS NOT DISTINCT FROM $2",
    )
    .bind(channel_id)
    .bind(list_id)
    .fetch_one(&state.pool)
    .await
    .unwrap_or((0,));
    if count.0 >= MAX_TASKS_PER_CHECKLIST {
        return Err((
            StatusCode::BAD_REQUEST,
            "This checklist has reached its task limit",
        ));
    }

    // Empty attachments on create means "none" — store NULL, not "".
    let attachments = payload.attachments.as_deref().filter(|a| !a.is_empty());
    let due_at = match payload.due_at.as_deref() {
        Some(raw) => parse_due(raw)?,
        None => None,
    };

    // New tasks append: next position within the whole checklist keeps every
    // sibling group in creation order until the user moves things.
    let sql = format!(
        "INSERT INTO channel_tasks (channel_id, list_id, parent_id, description, created_by, position, attachments, due_at, schedule) \
         VALUES ($1, $2, $3, $4, $5, \
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM channel_tasks \
                  WHERE channel_id IS NOT DISTINCT FROM $1 AND list_id IS NOT DISTINCT FROM $2), $6, $7, $8) \
         RETURNING {TASK_COLUMNS}"
    );
    // The insert and the op-key claim commit together or not at all, so a
    // replay's rolled-back insert raises nothing: Postgres discards a NOTIFY
    // made in a transaction that never commits, which is why this is a
    // rollback and not an insert-then-delete (that would broadcast a
    // create/delete pair to every open device).
    let fail = |e: sqlx::Error| {
        tracing::error!("Failed to create task: {:?}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create task")
    };
    let mut tx = state.pool.begin().await.map_err(fail)?;
    let row: TaskRow = sqlx::query_as(&sql)
        .bind(channel_id)
        .bind(list_id)
        .bind(payload.parent_id)
        .bind(payload.description.trim())
        .bind(claims.sub)
        .bind(attachments)
        .bind(due_at)
        .bind(schedule)
        .fetch_one(&mut *tx)
        .await
        .map_err(fail)?;

    let Some(key) = payload.op_key.as_deref() else {
        // No key: exactly what every client older than migration 070 does.
        tx.commit().await.map_err(fail)?;
        return Ok((task_row_to_response(row), true));
    };
    let (created_id, key_scope, inserted) = claim_op_key(&mut tx, claims.sub, key, "task", row.0)
        .await
        .map_err(fail)?;
    if inserted {
        tx.commit().await.map_err(fail)?;
        return Ok((task_row_to_response(row), true));
    }
    // A REPLAY of a create this server already made. Throw this attempt away
    // and hand back the original — scoped to this caller and this checklist,
    // so a key reused against a different note is refused rather than
    // answered with someone else's row.
    tx.rollback().await.map_err(fail)?;
    // Reached only by a replay that RACED the original (the short-circuit at
    // the top saw the key still uncommitted); the two paths must answer
    // identically, so they share one re-serve.
    let row = re_serve_task(state, claims.sub, channel_id, list_id, created_id, &key_scope).await?;
    Ok((row, false))
}

// --- Channel checklist handlers ---

/// List tasks for a channel
pub async fn list_tasks(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    if let Err(e) = check_channel_access(&state, channel_id, &claims).await {
        return e.into_response();
    }

    let sql = format!(
        "SELECT {TASK_COLUMNS} FROM channel_tasks WHERE channel_id = $1 ORDER BY is_completed ASC, position ASC, id ASC"
    );
    let rows: Result<Vec<TaskRow>, _> = sqlx::query_as(&sql)
        .bind(channel_id)
        .fetch_all(&state.pool)
        .await;

    match rows {
        Ok(rows) => Json(
            rows.into_iter()
                .map(task_row_to_response)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            tracing::error!("Failed to fetch tasks: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch tasks").into_response()
        }
    }
}

/// Create a new task in a channel checklist
pub async fn create_task(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateTaskRequest>,
) -> impl IntoResponse {
    let perms = match check_channel_access(&state, channel_id, &claims).await {
        Ok(p) => p,
        Err(e) => return e.into_response(),
    };
    if !perms.has(Permissions::CREATE_TASKS) {
        return (StatusCode::FORBIDDEN, "Missing Create Tasks permission").into_response();
    }
    match insert_task(&state, Some(channel_id), None, &payload, &claims).await {
        Ok((task, created)) => {
            // A replayed create changed nothing; telling the room otherwise
            // would make every open client refetch for no reason.
            if created {
                broadcast_checklist(&state, Some(channel_id), claims.sub);
            }
            Json(task).into_response()
        }
        Err(e) => e.into_response(),
    }
}

/// Update a task (toggle completion / edit text) in either scope.
///
/// Completion mirrors Google Keep: completing a parent completes its
/// subtasks; re-activating a subtask re-activates its parent.
pub async fn update_task(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<i64>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<UpdateTaskRequest>,
) -> impl IntoResponse {
    let access = match check_task_access(&state, task_id, &claims).await {
        Ok(a) => a,
        Err(e) => return e.into_response(),
    };
    let channel_id = access.channel_id;

    // Channel-scope per-field authorization (a PATCH touching several fields
    // must pass EVERY applicable check). Personal-list tasks are owner-only
    // and already fully authorized above.
    if let Some(perms) = access.perms {
        // MANAGE_TASKS implies completion rights (role editors describe it as
        // "check off anyone's tasks"), so managers don't also need COMPLETE.
        // A snooze and a subtree reopen are what a completer does to an
        // item, so they ride the completion right, not the edit right.
        if (payload.is_completed.is_some() || payload.snooze.is_some() || payload.reopen_subtree)
            && !perms.has(Permissions::COMPLETE_TASKS)
            && !perms.has(Permissions::MANAGE_TASKS)
        {
            return (StatusCode::FORBIDDEN, "Missing Complete Tasks permission").into_response();
        }
        if (payload.description.is_some()
            || payload.attachments.is_some()
            || payload.due_at.is_some()
            || payload.schedule.is_some())
            && !access.can_manage(claims.sub)
        {
            return (
                StatusCode::FORBIDDEN,
                "Only the task's creator or a task manager can edit it",
            )
                .into_response();
        }
    }

    if let Some(desc) = payload.description.as_deref() {
        if desc.len() > MAX_TASK_LEN {
            return (StatusCode::PAYLOAD_TOO_LARGE, "Task description too long").into_response();
        }
        if desc.contains('\0') {
            return (StatusCode::BAD_REQUEST, "Task contains invalid characters").into_response();
        }
    }
    if let Some(att) = payload.attachments.as_deref() {
        if att.len() > MAX_ATTACHMENTS_LEN {
            return (StatusCode::BAD_REQUEST, "Attachments too large").into_response();
        }
        if att.contains('\0') {
            return (
                StatusCode::BAD_REQUEST,
                "Attachments contain invalid characters",
            )
                .into_response();
        }
    }

    // Schedule and snooze: sealed envelopes or "" (clear), nothing else.
    let new_schedule = match payload.schedule.as_deref() {
        Some(raw) => match crate::task_timing::validate_sealed_scoped(raw, MAX_SCHEDULE_LEN, "schedule", channel_id.is_some()) {
            Ok(v) => v,
            Err(e) => return e.into_response(),
        },
        None => None,
    };
    let new_snooze = match payload.snooze.as_deref() {
        Some(raw) => match crate::task_timing::validate_sealed_scoped(raw, MAX_SNOOZE_LEN, "snooze", channel_id.is_some()) {
            Ok(v) => v,
            Err(e) => return e.into_response(),
        },
        None => None,
    };
    // Compare-and-swap target, parsed before anything is locked.
    let expect_due = match payload.expect_due_at.as_deref() {
        Some(raw) => match parse_due(raw) {
            Ok(d) => Some(d),
            Err(e) => return e.into_response(),
        },
        None => None,
    };

    // Attachments and due_at are three-state: absent = keep, "" = clear to
    // NULL, s = set. COALESCE can't express "clear", so gate on explicit
    // update flags.
    let set_attachments = payload.attachments.is_some();
    let new_attachments = payload.attachments.as_deref().filter(|a| !a.is_empty());

    // A stale client that rendered a newer envelope as text and re-sealed it
    // under its older format would destroy the item (there is no task edit
    // history). Refuse the downgrade — see envelope_version.rs. The current
    // row is read UNDER A ROW LOCK in the transaction the UPDATE runs in, so a
    // concurrent upgrade cannot slip between the check and the write, and a
    // read error fails CLOSED: this is a data-loss guard. Clearing the sidecar
    // (empty string) is a deletion and stays allowed.
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("Failed to update task: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to update task").into_response();
        }
    };
    if payload.description.is_some() || new_attachments.is_some() || new_schedule.is_some() || new_snooze.is_some() {
        let current: Option<(String, Option<String>, Option<String>, Option<String>)> = match sqlx::query_as(
            "SELECT description, attachments, schedule, snooze FROM channel_tasks WHERE id = $1 FOR UPDATE",
        )
        .bind(task_id)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("Failed to read task before update: {:?}", e);
                return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to update task").into_response();
            }
        };
        let Some((cur_desc, cur_att, cur_sched, cur_snooze)) = current else {
            return (StatusCode::NOT_FOUND, "Task not found").into_response();
        };
        if let Some(desc) = payload.description.as_deref().map(str::trim) {
            if crate::envelope_version::edit_is_downgrade(&cur_desc, desc, payload.reads_up_to) {
                return (StatusCode::CONFLICT, crate::envelope_version::DOWNGRADE_MESSAGE).into_response();
            }
        }
        if let (Some(cur), Some(new)) = (cur_att.as_deref(), new_attachments) {
            if crate::envelope_version::edit_is_downgrade(cur, new, payload.reads_up_to) {
                return (StatusCode::CONFLICT, crate::envelope_version::DOWNGRADE_MESSAGE).into_response();
            }
        }
        for (cur, new) in [(cur_sched.as_deref(), new_schedule), (cur_snooze.as_deref(), new_snooze)] {
            if let (Some(cur), Some(new)) = (cur, new) {
                if crate::envelope_version::edit_is_downgrade(cur, new, payload.reads_up_to) {
                    return (StatusCode::CONFLICT, crate::envelope_version::DOWNGRADE_MESSAGE).into_response();
                }
            }
        }
    }
    // An older client completing a scheduled item (or a parent whose sweep
    // would reach one) would end a repeating series without knowing it:
    // refuse unless the client says it understands schedules. Read inside
    // the transaction, fail CLOSED (a data-loss guard, like the one above).
    if payload.is_completed == Some(true) && !payload.recurrence_aware {
        match sqlx::query_as::<_, (bool,)>(crate::task_timing::SUBTREE_HAS_SCHEDULE_SQL)
            .bind(task_id)
            .fetch_one(&mut *tx)
            .await
        {
            Ok((false,)) => {}
            Ok((true,)) => {
                return (StatusCode::CONFLICT, crate::task_timing::SCHEDULE_COMPLETE_MESSAGE).into_response();
            }
            Err(e) => {
                tracing::error!("Failed to read schedules before completion: {:?}", e);
                return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to update task").into_response();
            }
        }
    }
    let set_due = payload.due_at.is_some();
    let new_due = match payload.due_at.as_deref() {
        Some(raw) => match parse_due(raw) {
            Ok(d) => d,
            Err(e) => return e.into_response(),
        },
        None => None,
    };

    let result = sqlx::query(
        "UPDATE channel_tasks SET is_completed = COALESCE($1, is_completed), description = COALESCE($2, description), \
         attachments = CASE WHEN $3 THEN $4 ELSE attachments END, \
         due_at = CASE WHEN $5 THEN $6 ELSE due_at END, \
         schedule = CASE WHEN $8 THEN $9 ELSE schedule END, \
         snooze = CASE WHEN $10 THEN $11 ELSE snooze END \
         WHERE id = $7 AND (NOT $12 OR due_at IS NOT DISTINCT FROM $13)"
    )
    .bind(payload.is_completed)
    .bind(payload.description.as_deref().map(str::trim))
    .bind(set_attachments)
    .bind(new_attachments)
    .bind(set_due)
    .bind(new_due)
    .bind(task_id)
    .bind(payload.schedule.is_some())
    .bind(new_schedule)
    .bind(payload.snooze.is_some())
    .bind(new_snooze)
    .bind(expect_due.is_some())
    .bind(expect_due.flatten())
    .execute(&mut *tx)
    .await;

    match result {
        // The compare-and-swap lost: someone moved due_at first. Nothing was
        // written (the transaction rolls back on drop).
        Ok(r) if r.rows_affected() == 0 && expect_due.is_some() => {
            return (StatusCode::CONFLICT, crate::task_timing::DUE_CHANGED_MESSAGE).into_response();
        }
        Ok(_) => {}
        Err(e) => {
            tracing::error!("Failed to update task: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to update task").into_response();
        }
    }
    if payload.reopen_subtree {
        if let Err(e) = sqlx::query(crate::task_timing::REOPEN_SUBTREE_SQL)
            .bind(task_id)
            .execute(&mut *tx)
            .await
        {
            tracing::error!("Failed to reopen subtree: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to update task").into_response();
        }
    }
    if let Err(e) = tx.commit().await {
        tracing::error!("Failed to update task: {:?}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to update task").into_response();
    }

    match payload.is_completed {
        // Completing a task sweeps its ENTIRE subtree along with it (tasks can
        // nest several levels; the bound guards against pathological cycles).
        Some(true) => {
            let _ = sqlx::query(
                "WITH RECURSIVE sub AS ( \
                     SELECT id, 1 AS depth FROM channel_tasks WHERE parent_id = $1 \
                     UNION ALL \
                     SELECT t.id, s.depth + 1 FROM channel_tasks t \
                     JOIN sub s ON t.parent_id = s.id WHERE s.depth < 10 \
                 ) \
                 UPDATE channel_tasks SET is_completed = TRUE WHERE id IN (SELECT id FROM sub)",
            )
            .bind(task_id)
            .execute(&state.pool)
            .await;
        }
        // Re-activating a subtask means every ancestor above it is no longer done.
        Some(false) => {
            let _ = sqlx::query(
                "WITH RECURSIVE anc AS ( \
                     SELECT parent_id, 1 AS depth FROM channel_tasks WHERE id = $1 \
                     UNION ALL \
                     SELECT t.parent_id, a.depth + 1 FROM channel_tasks t \
                     JOIN anc a ON t.id = a.parent_id \
                     WHERE a.parent_id IS NOT NULL AND a.depth < 10 \
                 ) \
                 UPDATE channel_tasks SET is_completed = FALSE \
                 WHERE id IN (SELECT parent_id FROM anc WHERE parent_id IS NOT NULL)",
            )
            .bind(task_id)
            .execute(&state.pool)
            .await;
        }
        None => {}
    }

    broadcast_checklist(&state, channel_id, claims.sub);
    StatusCode::OK.into_response()
}

/// Move a task one slot up or down among its visible siblings (same scope,
/// same parent, same completion state) by swapping positions atomically.
/// Moving past the edge is a no-op.
pub async fn move_task(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<i64>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<MoveTaskRequest>,
) -> impl IntoResponse {
    let up = match payload.direction.as_str() {
        "up" => true,
        "down" => false,
        _ => return (StatusCode::BAD_REQUEST, "direction must be 'up' or 'down'").into_response(),
    };

    let access = match check_task_access(&state, task_id, &claims).await {
        Ok(a) => a,
        Err(e) => return e.into_response(),
    };
    // Reordering a channel checklist is creator-or-manager territory.
    if !access.can_manage(claims.sub) {
        return (
            StatusCode::FORBIDDEN,
            "Only the task's creator or a task manager can move it",
        )
            .into_response();
    }

    // Resolve the scope up front (a task's scope never changes) so we can take a
    // per-checklist advisory lock and do the read+swap as ONE serialized unit.
    // Previously the position reads ran OUTSIDE the swap transaction, so two
    // concurrent moves could read stale positions and corrupt sibling ordering.
    let scope: Option<(Option<i64>, Option<i64>)> =
        sqlx::query_as("SELECT channel_id, list_id FROM channel_tasks WHERE id = $1")
            .bind(task_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    let (channel_id, list_id) = match scope {
        Some(s) => s,
        None => return (StatusCode::NOT_FOUND, "Task not found").into_response(),
    };

    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            tracing::error!("Failed to begin move transaction: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move task").into_response();
        }
    };

    // Serialize every reorder within this checklist scope. classid 0 = channel
    // checklist, 1 = personal list; objid = the scope id (cast to i32; advisory
    // locks are advisory, so a truncation would only over-serialize — safe). A
    // single lock taken first is deadlock-free.
    let (lock_class, lock_obj): (i32, i32) = match (channel_id, list_id) {
        (Some(cid), _) => (0, cid as i32),
        (_, Some(lid)) => (1, lid as i32),
        _ => (0, 0),
    };
    if let Err(e) = sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(lock_class)
        .bind(lock_obj)
        .execute(&mut *tx)
        .await
    {
        tracing::error!("Failed to take move lock: {:?}", e);
        let _ = tx.rollback().await;
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move task").into_response();
    }

    // Read the moving task's current row inside the lock.
    let me: Option<(Option<i64>, bool, i64)> =
        sqlx::query_as("SELECT parent_id, is_completed, position FROM channel_tasks WHERE id = $1")
            .bind(task_id)
            .fetch_optional(&mut *tx)
            .await
            .unwrap_or(None);

    let (parent_id, is_completed, position) = match me {
        Some(m) => m,
        None => {
            let _ = tx.rollback().await;
            return (StatusCode::NOT_FOUND, "Task not found").into_response();
        }
    };

    let neighbor_sql = if up {
        "SELECT id, position FROM channel_tasks \
         WHERE channel_id IS NOT DISTINCT FROM $1 AND list_id IS NOT DISTINCT FROM $2 \
           AND parent_id IS NOT DISTINCT FROM $3 AND is_completed = $4 \
           AND (position, id) < ($5, $6) \
         ORDER BY position DESC, id DESC LIMIT 1"
    } else {
        "SELECT id, position FROM channel_tasks \
         WHERE channel_id IS NOT DISTINCT FROM $1 AND list_id IS NOT DISTINCT FROM $2 \
           AND parent_id IS NOT DISTINCT FROM $3 AND is_completed = $4 \
           AND (position, id) > ($5, $6) \
         ORDER BY position ASC, id ASC LIMIT 1"
    };

    let neighbor: Option<(i64, i64)> = sqlx::query_as(neighbor_sql)
        .bind(channel_id)
        .bind(list_id)
        .bind(parent_id)
        .bind(is_completed)
        .bind(position)
        .bind(task_id)
        .fetch_optional(&mut *tx)
        .await
        .unwrap_or(None);

    let (neighbor_id, neighbor_pos) = match neighbor {
        Some(n) => n,
        None => {
            let _ = tx.rollback().await; // already at the edge — nothing to swap
            return StatusCode::OK.into_response();
        }
    };

    let swap = async {
        sqlx::query("UPDATE channel_tasks SET position = $1 WHERE id = $2")
            .bind(neighbor_pos)
            .bind(task_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE channel_tasks SET position = $1 WHERE id = $2")
            .bind(position)
            .bind(neighbor_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    };

    match swap.await {
        Ok(()) => {
            broadcast_checklist(&state, channel_id, claims.sub);
            StatusCode::OK.into_response()
        }
        Err(e) => {
            tracing::error!("Failed to move task: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move task").into_response()
        }
    }
}

/// Drop a task at an arbitrary slot among its visible siblings — and, since
/// S1, optionally under a DIFFERENT parent in the same drop (`reparent` +
/// `parent_id`, cycle- and depth-checked inside the same transaction). The
/// sibling group is (same scope, the target parent, same completion state):
/// the task lands immediately after `after_id`, or first in the group when
/// `after_id` is null. Backs drag-and-drop reorder; the one-slot `/move`
/// endpoint stays for older clients.
///
/// The whole sibling group is renumbered under the same per-checklist
/// advisory lock `/move` takes, so the two endpoints serialize against each
/// other. The new positions are allocated ABOVE the scope's current MAX —
/// not 1..n — because position values are unique per (channel_id, list_id)
/// scope by construction (create appends at scope MAX+1; move only swaps)
/// and the completion toggle silently relies on that: it moves a task
/// between sibling groups WITHOUT touching its position, which stays
/// collision-free only while no two rows in a scope share a value.
pub async fn reorder_task(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<i64>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<ReorderTaskRequest>,
) -> impl IntoResponse {
    let access = match check_task_access(&state, task_id, &claims).await {
        Ok(a) => a,
        Err(e) => return e.into_response(),
    };
    if !access.can_manage(claims.sub) {
        return (
            StatusCode::FORBIDDEN,
            "Only the task's creator or a task manager can move it",
        )
            .into_response();
    }

    let scope: Option<(Option<i64>, Option<i64>)> =
        sqlx::query_as("SELECT channel_id, list_id FROM channel_tasks WHERE id = $1")
            .bind(task_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    let (channel_id, list_id) = match scope {
        Some(s) => s,
        None => return (StatusCode::NOT_FOUND, "Task not found").into_response(),
    };

    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            tracing::error!("Failed to begin reorder transaction: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move task").into_response();
        }
    };

    // Same lock scheme as move_task — see the comment there.
    let (lock_class, lock_obj): (i32, i32) = match (channel_id, list_id) {
        (Some(cid), _) => (0, cid as i32),
        (_, Some(lid)) => (1, lid as i32),
        _ => (0, 0),
    };
    if let Err(e) = sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(lock_class)
        .bind(lock_obj)
        .execute(&mut *tx)
        .await
    {
        tracing::error!("Failed to take reorder lock: {:?}", e);
        let _ = tx.rollback().await;
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move task").into_response();
    }

    // The moving task's group membership, read inside the lock.
    let me: Option<(Option<i64>, bool)> =
        sqlx::query_as("SELECT parent_id, is_completed FROM channel_tasks WHERE id = $1")
            .bind(task_id)
            .fetch_optional(&mut *tx)
            .await
            .unwrap_or(None);
    let (parent_id, is_completed) = match me {
        Some(m) => m,
        None => {
            let _ = tx.rollback().await;
            return (StatusCode::NOT_FOUND, "Task not found").into_response();
        }
    };

    // S1: the optional reparent, INSIDE the same advisory-locked transaction
    // as the renumber — a nest and its sibling placement are one drop, and a
    // concurrent reorder observing the half-applied pair would renumber a
    // group the task is no longer in. Every check errs explicitly rather
    // than through unwrap_or: swallowing a query error into "no cycle" is a
    // fail-open on the one invariant (acyclic, depth-bounded) the tree has.
    let target_parent: Option<i64> = if payload.reparent { payload.parent_id } else { parent_id };
    if payload.reparent && target_parent != parent_id {
        if let Some(new_pid) = target_parent {
            if new_pid == task_id {
                let _ = tx.rollback().await;
                return (StatusCode::BAD_REQUEST, "A task cannot be its own parent").into_response();
            }
            // Same scope — a parent in another checklist would quietly teleport
            // the subtree across channels.
            let np: Result<Option<(Option<i64>, Option<i64>)>, _> =
                sqlx::query_as("SELECT channel_id, list_id FROM channel_tasks WHERE id = $1")
                    .bind(new_pid)
                    .fetch_optional(&mut *tx)
                    .await;
            match np {
                Ok(Some((pc, pl))) if pc == channel_id && pl == list_id => {}
                Ok(Some(_)) => {
                    // Same message as a missing parent (see validate_parent).
                    let _ = tx.rollback().await;
                    return (StatusCode::BAD_REQUEST, "Parent task not found").into_response();
                }
                Ok(None) => {
                    let _ = tx.rollback().await;
                    return (StatusCode::BAD_REQUEST, "Parent task not found").into_response();
                }
                Err(e) => {
                    tracing::error!("reorder_task: reparent scope lookup failed: {e:?}");
                    let _ = tx.rollback().await;
                    return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move task").into_response();
                }
            }
            // No cycles: the new parent must not be the task or anything under
            // it. The depth bound keeps the recursion finite even against
            // drifted data; a cycle cannot exist yet — this is what prevents
            // creating the first one.
            let cyc: Result<Option<(i64,)>, _> = sqlx::query_as(
                "WITH RECURSIVE sub AS ( \
                     SELECT id, 1::bigint AS depth FROM channel_tasks WHERE id = $1 \
                     UNION ALL \
                     SELECT c.id, s.depth + 1 FROM channel_tasks c \
                     JOIN sub s ON c.parent_id = s.id WHERE s.depth < $2 \
                 ) SELECT 1::bigint FROM sub WHERE id = $3 LIMIT 1",
            )
            .bind(task_id)
            .bind(MAX_TASK_DEPTH)
            .bind(new_pid)
            .fetch_optional(&mut *tx)
            .await;
            match cyc {
                Ok(None) => {}
                Ok(Some(_)) => {
                    let _ = tx.rollback().await;
                    return (StatusCode::BAD_REQUEST, "A task cannot be nested under its own subtask").into_response();
                }
                Err(e) => {
                    tracing::error!("reorder_task: cycle check failed: {e:?}");
                    let _ = tx.rollback().await;
                    return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move task").into_response();
                }
            }
            // Depth: the new parent's ancestor-chain depth plus the MOVING
            // SUBTREE's height must fit — validate_parent's leaf-child rule
            // is not enough, because a drop can carry children with it.
            let chain: Result<Option<(Option<i64>,)>, _> = sqlx::query_as(
                "WITH RECURSIVE chain AS ( \
                     SELECT id, parent_id, 1::bigint AS depth FROM channel_tasks WHERE id = $1 \
                     UNION ALL \
                     SELECT t.id, t.parent_id, c.depth + 1 FROM channel_tasks t \
                     JOIN chain c ON t.id = c.parent_id WHERE c.depth < $2 + 1 \
                 ) SELECT MAX(depth) FROM chain",
            )
            .bind(new_pid)
            .bind(MAX_TASK_DEPTH)
            .fetch_optional(&mut *tx)
            .await;
            let height: Result<Option<(Option<i64>,)>, _> = sqlx::query_as(
                "WITH RECURSIVE sub AS ( \
                     SELECT id, 1::bigint AS depth FROM channel_tasks WHERE id = $1 \
                     UNION ALL \
                     SELECT c.id, s.depth + 1 FROM channel_tasks c \
                     JOIN sub s ON c.parent_id = s.id WHERE s.depth < $2 \
                 ) SELECT MAX(depth) FROM sub",
            )
            .bind(task_id)
            .bind(MAX_TASK_DEPTH)
            .fetch_optional(&mut *tx)
            .await;
            match (chain, height) {
                (Ok(Some((Some(c),))), Ok(Some((Some(h),)))) => {
                    if c + h > MAX_TASK_DEPTH {
                        let _ = tx.rollback().await;
                        return (StatusCode::BAD_REQUEST, "Tasks can only nest 5 levels deep").into_response();
                    }
                }
                (Err(e), _) | (_, Err(e)) => {
                    tracing::error!("reorder_task: depth check failed: {e:?}");
                    let _ = tx.rollback().await;
                    return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move task").into_response();
                }
                _ => {
                    let _ = tx.rollback().await;
                    return (StatusCode::BAD_REQUEST, "Parent task not found").into_response();
                }
            }
        }
        if let Err(e) = sqlx::query("UPDATE channel_tasks SET parent_id = $1 WHERE id = $2")
            .bind(target_parent)
            .bind(task_id)
            .execute(&mut *tx)
            .await
        {
            tracing::error!("reorder_task: reparent update failed: {e:?}");
            let _ = tx.rollback().await;
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move task").into_response();
        }
    }

    // Current group order (includes the moving task itself) — judged against
    // the parent the task now HAS (the new one after a reparent).
    let siblings: Result<Vec<(i64,)>, _> = sqlx::query_as(
        "SELECT id FROM channel_tasks \
         WHERE channel_id IS NOT DISTINCT FROM $1 AND list_id IS NOT DISTINCT FROM $2 \
           AND parent_id IS NOT DISTINCT FROM $3 AND is_completed = $4 \
         ORDER BY position ASC, id ASC",
    )
    .bind(channel_id)
    .bind(list_id)
    .bind(target_parent)
    .bind(is_completed)
    .fetch_all(&mut *tx)
    .await;
    let mut order: Vec<i64> = match siblings {
        Ok(rows) => rows.into_iter().map(|(id,)| id).collect(),
        Err(e) => {
            tracing::error!("Failed to read siblings for reorder: {:?}", e);
            let _ = tx.rollback().await;
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move task").into_response();
        }
    };

    order.retain(|&id| id != task_id);
    let insert_at = match payload.after_id {
        None => 0,
        Some(after) => match order.iter().position(|&id| id == after) {
            Some(i) => i + 1,
            None => {
                // Not a same-group sibling (or it's the task itself / stale).
                let _ = tx.rollback().await;
                return (
                    StatusCode::BAD_REQUEST,
                    "after_id is not a sibling of this task",
                )
                    .into_response();
            }
        },
    };
    order.insert(insert_at, task_id);

    // Fresh values above the scope max keep positions scope-unique (see the
    // doc comment). Growth is bounded: group-size per reorder, i64 range.
    let base: (Option<i64>,) = sqlx::query_as(
        "SELECT MAX(position) FROM channel_tasks \
         WHERE channel_id IS NOT DISTINCT FROM $1 AND list_id IS NOT DISTINCT FROM $2",
    )
    .bind(channel_id)
    .bind(list_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap_or((None,));
    let base = base.0.unwrap_or(0);

    let ids: Vec<i64> = order;
    let positions: Vec<i64> = (1..=ids.len() as i64).map(|i| base + i).collect();
    let renumber = async {
        sqlx::query(
            "UPDATE channel_tasks AS t SET position = u.pos \
             FROM (SELECT UNNEST($1::bigint[]) AS id, UNNEST($2::bigint[]) AS pos) AS u \
             WHERE t.id = u.id",
        )
        .bind(&ids)
        .bind(&positions)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    };

    match renumber.await {
        Ok(()) => {
            broadcast_checklist(&state, channel_id, claims.sub);
            StatusCode::OK.into_response()
        }
        Err(e) => {
            tracing::error!("Failed to reorder task: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move task").into_response()
        }
    }
}

/// Delete a task (subtasks cascade via FK) in either scope.
pub async fn delete_task(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let access = match check_task_access(&state, task_id, &claims).await {
        Ok(a) => a,
        Err(e) => return e.into_response(),
    };
    // Deleting a channel task (and its cascading subtasks) is creator-or-manager.
    if !access.can_manage(claims.sub) {
        return (
            StatusCode::FORBIDDEN,
            "Only the task's creator or a task manager can delete it",
        )
            .into_response();
    }
    let channel_id = access.channel_id;

    let result = sqlx::query("DELETE FROM channel_tasks WHERE id = $1")
        .bind(task_id)
        .execute(&state.pool)
        .await;

    match result {
        Ok(_) => {
            broadcast_checklist(&state, channel_id, claims.sub);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => {
            tracing::error!("Failed to delete task: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to delete task").into_response()
        }
    }
}

// --- Personal task-list handlers ---

/// List the caller's task lists with progress counts. Trashed lists are
/// hidden (every client older than the trash therefore stops showing them
/// with no change); `?trashed=true` lists only those, most recent first.
pub async fn list_task_lists(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    axum::extract::Query(q): axum::extract::Query<TaskListsQuery>,
) -> impl IntoResponse {
    let trashed = q.trashed.unwrap_or(false);
    // Includes the "Notes to self" (is_self) list: since the Tasks view became
    // the single home for personal lists, hiding it would strand those items.
    let order = if trashed { "l.trashed_at DESC, l.id DESC" } else { "l.is_self DESC, l.id ASC" };
    let sql = format!(
        "SELECT l.id, l.title, (replace((l.created_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS created_at, \
                COUNT(t.id) AS total, \
                COUNT(t.id) FILTER (WHERE t.is_completed) AS done, \
                l.body, l.attachments, \
                (replace((l.trashed_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS trashed_at, \
                l.is_self, \
                (replace((COALESCE(l.updated_at, l.created_at) AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS updated_at, \
                (replace((l.due_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS due_at, \
                l.schedule, \
                l.content_rev \
         FROM task_lists l \
         LEFT JOIN channel_tasks t ON t.list_id = l.id \
         WHERE l.owner_id = $1 AND (l.trashed_at IS NOT NULL) = $2 \
         GROUP BY l.id \
         ORDER BY {order}"
    );
    #[allow(clippy::type_complexity)]
    type ListRow = (i64, String, String, i64, i64, Option<String>, Option<String>, Option<String>, bool, String, Option<String>, Option<String>, i64);
    let rows: Result<Vec<ListRow>, _> = sqlx::query_as(&sql)
        .bind(claims.sub)
        .bind(trashed)
        .fetch_all(&state.pool)
        .await;

    match rows {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|(id, title, created_at, total, done, body, attachments, trashed_at, is_self, updated_at, due_at, schedule, content_rev)| TaskListResponse {
                    id,
                    title,
                    created_at,
                    total_tasks: total,
                    completed_tasks: done,
                    body,
                    attachments,
                    trashed_at,
                    is_self,
                    updated_at,
                    due_at,
                    schedule,
                    content_rev,
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            tracing::error!("Failed to fetch task lists: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch task lists",
            )
                .into_response()
        }
    }
}

/// Create a personal task list.
pub async fn create_task_list(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<TaskListRequest>,
) -> impl IntoResponse {
    let title = payload.title.as_deref().unwrap_or("").trim();
    if title.is_empty() {
        return (StatusCode::BAD_REQUEST, "Title cannot be empty").into_response();
    }
    if title.len() > MAX_LIST_TITLE_LEN {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Title too long").into_response();
    }
    if let Err(e) = crate::list_content::check_body(payload.body.as_deref())
        .and_then(|_| crate::list_content::check_attachments(payload.attachments.as_deref()))
    {
        return e.into_response();
    }
    // The note's own reminder, so a composer creates a reminding note in ONE
    // request (a second PATCH could fail and leave a note with no time).
    let due_at = match parse_due(payload.due_at.as_deref().unwrap_or("")) {
        Ok(d) => d,
        Err(e) => return e.into_response(),
    };
    let schedule = match crate::task_timing::validate_sealed(
        payload.schedule.as_deref().unwrap_or(""),
        MAX_SCHEDULE_LEN,
        "schedule",
    ) {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    if let Some(key) = payload.op_key.as_deref() {
        if let Err(e) = validate_op_key(key) {
            return e.into_response();
        }
    }
    // Empty on create means "none" — store NULL, not "".
    let body = payload.body.as_deref().filter(|b| !b.is_empty());
    let attachments = payload.attachments.as_deref().filter(|a| !a.is_empty());

    const LIST_CREATE_COLUMNS: &str = "id, title, (replace((created_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS created_at, body, attachments";
    #[allow(clippy::type_complexity)]
    type CreatedList = (i64, String, String, Option<String>, Option<String>, String, Option<String>, Option<String>, i64);
    let sql = format!(
        "INSERT INTO task_lists (owner_id, title, body, attachments, due_at, schedule) VALUES ($1, $2, $3, $4, $5, $6) RETURNING {LIST_CREATE_COLUMNS}, {LIST_UPDATED_AT}, {LIST_DUE_AT}, schedule, content_rev"
    );
    // The insert and the op-key claim (migration 070) commit together, so a
    // replay's insert is rolled back before it can raise a live event.
    let oops = |e: sqlx::Error| {
        tracing::error!("Failed to create task list: {:?}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create task list",
        )
    };
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(e) => return oops(e).into_response(),
    };
    let row: CreatedList = match sqlx::query_as(&sql)
        .bind(claims.sub)
        .bind(title)
        .bind(body)
        .bind(attachments)
        .bind(due_at)
        .bind(schedule)
        .fetch_one(&mut *tx)
        .await
    {
        Ok(r) => r,
        Err(e) => return oops(e).into_response(),
    };

    // Which row to answer with: the one just inserted (committed), or — when
    // this request replays a create the server already made — the original,
    // after this attempt is rolled back.
    let claim = match payload.op_key.as_deref() {
        // No key: exactly what every client older than migration 070 does.
        None => None,
        Some(key) => match claim_op_key(&mut tx, claims.sub, key, "list", row.0).await {
            Ok(c) => Some(c),
            Err(e) => return oops(e).into_response(),
        },
    };
    let answer: TaskListResponse = match claim {
        None | Some((_, _, true)) => {
            if let Err(e) = tx.commit().await {
                return oops(e).into_response();
            }
            let (id, title, created_at, body, attachments, updated_at, due_at, schedule, content_rev) = row;
            // A row this statement just inserted: empty, live, not the
            // "Notes to self" list. True here, and ONLY here.
            TaskListResponse {
                id,
                title,
                created_at,
                total_tasks: 0,
                completed_tasks: 0,
                body,
                attachments,
                trashed_at: None,
                is_self: false,
                updated_at,
                due_at,
                schedule,
                content_rev,
            }
        }
        Some((created_id, key_scope, false)) => {
            // A REPLAY: throw this attempt away and re-serve the note that
            // create already made, scoped to this owner.
            if let Err(e) = tx.rollback().await {
                return oops(e).into_response();
            }
            // The key was spent on an item: `created_id` names a row in
            // channel_tasks and must never be looked up here.
            if key_scope != "list" {
                return (StatusCode::CONFLICT, REPLAY_WRONG_SCOPE_MESSAGE).into_response();
            }
            // Read the note as the LISTING would: the original may have been
            // trashed or filled with items since the answer this call is
            // replaying was lost, and hard-coding "live, empty" here would
            // put a phantom card back on the grid.
            const RE_SERVE_LIST: &str =
                "SELECT l.id, l.title, (replace((l.created_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS created_at, \
                        COUNT(t.id) AS total, \
                        COUNT(t.id) FILTER (WHERE t.is_completed) AS done, \
                        l.body, l.attachments, \
                        (replace((l.trashed_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS trashed_at, \
                        l.is_self, \
                        (replace((COALESCE(l.updated_at, l.created_at) AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS updated_at, \
                        (replace((l.due_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS due_at, \
                        l.schedule, \
                        l.content_rev \
                 FROM task_lists l \
                 LEFT JOIN channel_tasks t ON t.list_id = l.id \
                 WHERE l.id = $1 AND l.owner_id = $2 \
                 GROUP BY l.id";
            #[allow(clippy::type_complexity)]
            type ReplayedList = (i64, String, String, i64, i64, Option<String>, Option<String>, Option<String>, bool, String, Option<String>, Option<String>, i64);
            let existing: Option<ReplayedList> = match sqlx::query_as(RE_SERVE_LIST)
                .bind(created_id)
                .bind(claims.sub)
                .fetch_optional(&state.pool)
                .await
            {
                Ok(r) => r,
                Err(e) => return oops(e).into_response(),
            };
            let Some((id, title, created_at, total, done, body, attachments, trashed_at, is_self, updated_at, due_at, schedule, content_rev)) = existing else {
                return (StatusCode::CONFLICT, REPLAY_GONE_MESSAGE).into_response();
            };
            TaskListResponse {
                id,
                title,
                created_at,
                total_tasks: total,
                completed_tasks: done,
                body,
                attachments,
                trashed_at,
                is_self,
                updated_at,
                due_at,
                schedule,
                content_rev,
            }
        }
    };
    Json(answer).into_response()
}

/// Get (or lazily create) the caller's single "Notes to self" checklist list —
/// the personal list that backs their self-DM checklist. The title is a plain
/// label (not user content), so it's stored in the clear; items are still
/// encrypt-to-self like any personal list. The partial unique index guarantees
/// at most one per owner.
pub async fn get_self_checklist(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let select_self = format!(
        "SELECT id, title, (replace((created_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS created_at, body, attachments, {LIST_UPDATED_AT}, {LIST_DUE_AT}, schedule, content_rev FROM task_lists WHERE owner_id = $1 AND is_self = TRUE"
    );
    // Try to fetch the existing one first.
    #[allow(clippy::type_complexity)]
    let existing: Option<(i64, String, String, Option<String>, Option<String>, String, Option<String>, Option<String>, i64)> = sqlx::query_as(&select_self)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    let row = if let Some(r) = existing {
        Ok(r)
    } else {
        // Create it. ON CONFLICT DO NOTHING guards a race between two devices;
        // if we lose the race we re-select below.
        // The ON CONFLICT predicate must match the partial unique index
        // (migration 028: ... WHERE is_self = TRUE) exactly.
        let _ = sqlx::query(
            "INSERT INTO task_lists (owner_id, title, is_self) VALUES ($1, 'Notes to self', TRUE) \
             ON CONFLICT (owner_id) WHERE is_self = TRUE DO NOTHING",
        )
        .bind(claims.sub)
        .execute(&state.pool)
        .await;
        sqlx::query_as(&select_self)
            .bind(claims.sub)
            .fetch_one(&state.pool)
            .await
    };

    match row {
        Ok((id, title, created_at, body, attachments, updated_at, due_at, schedule, content_rev)) => {
            let counts: (i64, i64) = sqlx::query_as(
                "SELECT COUNT(*), COUNT(*) FILTER (WHERE is_completed) FROM channel_tasks WHERE list_id = $1",
            )
            .bind(id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or((0, 0));
            Json(TaskListResponse {
                id,
                title,
                created_at,
                total_tasks: counts.0,
                completed_tasks: counts.1,
                body,
                attachments,
                // The self list cannot be trashed (list_content::trash_list).
                trashed_at: None,
                is_self: true,
                updated_at,
                due_at,
                schedule,
                content_rev,
            })
            .into_response()
        }
        Err(e) => {
            tracing::error!("Failed to get/create self checklist: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to get self checklist",
            )
                .into_response()
        }
    }
}

/// Rename a personal task list, replace its sealed body or attachments
/// sidecar (list_content.rs), and/or set the NOTE's own reminder — its
/// plaintext due_at and its sealed schedule (migration 068).
pub async fn rename_task_list(
    State(state): State<Arc<AppState>>,
    Path(list_id): Path<i64>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<TaskListRequest>,
) -> impl IntoResponse {
    if let Err(e) = check_list_writable(&state, list_id, &claims).await {
        return e.into_response();
    }
    // Title, body, attachments and the note's own timing are each optional
    // here (a body-only edit sends no title); an empty PATCH is a client bug,
    // not a no-op to hide. `expect_due_at` alone is NOT an update: a bare
    // compare-and-swap with nothing to write would 200 having done nothing.
    if payload.title.is_none()
        && payload.body.is_none()
        && payload.attachments.is_none()
        && payload.due_at.is_none()
        && payload.schedule.is_none()
    {
        return (StatusCode::BAD_REQUEST, "Nothing to update").into_response();
    }
    let title = payload.title.as_deref().map(str::trim);
    if let Some(t) = title {
        if t.is_empty() {
            return (StatusCode::BAD_REQUEST, "Title cannot be empty").into_response();
        }
        if t.len() > MAX_LIST_TITLE_LEN {
            return (StatusCode::PAYLOAD_TOO_LARGE, "Title too long").into_response();
        }
    }
    if let Err(e) = crate::list_content::check_body(payload.body.as_deref())
        .and_then(|_| crate::list_content::check_attachments(payload.attachments.as_deref()))
    {
        return e.into_response();
    }
    // The note's own timing, validated before the transaction opens.
    let due_at = match payload.due_at.as_deref().map(parse_due).transpose() {
        Ok(d) => d,
        Err(e) => return e.into_response(),
    };
    let expect_due = match payload.expect_due_at.as_deref().map(parse_due).transpose() {
        Ok(d) => d,
        Err(e) => return e.into_response(),
    };
    // A personal list is sealed to self and has no channel to bind, so this
    // is validate_sealed, never validate_sealed_scoped (task_timing.rs).
    let schedule = match payload
        .schedule
        .as_deref()
        .map(|s| crate::task_timing::validate_sealed(s, MAX_SCHEDULE_LEN, "schedule"))
        .transpose()
    {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };

    // Titles, bodies and sidecars are sealed encrypt-to-self values with no
    // history: the same downgrade rule as descriptions (envelope_version.rs),
    // fail-closed, read UNDER A ROW LOCK in the transaction the UPDATE runs
    // in — which also sees a trash that landed after check_list_writable.
    // Clearing a body or sidecar ("") is a deletion and stays allowed.
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("Failed to update task list: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to rename task list").into_response();
        }
    };
    #[allow(clippy::type_complexity)]
    let current: Option<(String, Option<String>, Option<String>, bool, Option<String>, i64)> = match sqlx::query_as(
        "SELECT title, body, attachments, trashed_at IS NOT NULL, schedule, content_rev FROM task_lists WHERE id = $1 FOR UPDATE",
    )
    .bind(list_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Failed to read task list before rename: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to rename task list").into_response();
        }
    };
    let Some((cur_title, cur_body, cur_att, trashed, cur_sched, cur_rev)) = current else {
        return (StatusCode::NOT_FOUND, "List not found").into_response();
    };
    if trashed {
        return (StatusCode::CONFLICT, crate::list_content::TRASHED_MESSAGE).into_response();
    }
    // Compare-and-swap on the note's content (migration 069). A client that
    // names the revision it edited loses the race rather than landing over
    // the winner, and gets the current copy back so it can show both and let
    // the user choose — the same contract as a sealed blob's 409
    // (src/sealed_blob_handlers.rs). Absent = no check: older clients, and
    // ops queued before this existed, behave exactly as they did.
    //
    // The 409 carries the SEALED values, which is what a GET a moment later
    // would have handed the same caller. The server learns nothing new.
    if let Some(expected) = payload.expect_rev {
        if expected != cur_rev {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "conflict": "stale",
                    "content_rev": cur_rev,
                    "title": cur_title,
                    "body": cur_body,
                    "attachments": cur_att,
                })),
            )
                .into_response();
        }
    }
    let downgrade = |cur: Option<&str>, new: Option<&str>| match (cur, new.filter(|n| !n.is_empty())) {
        (Some(c), Some(n)) => crate::envelope_version::edit_is_downgrade(c, n, payload.reads_up_to),
        _ => false,
    };
    if downgrade(Some(&cur_title), title)
        || downgrade(cur_body.as_deref(), payload.body.as_deref())
        || downgrade(cur_att.as_deref(), payload.attachments.as_deref())
        || downgrade(cur_sched.as_deref(), payload.schedule.as_deref())
    {
        return (StatusCode::CONFLICT, crate::envelope_version::DOWNGRADE_MESSAGE).into_response();
    }
    // The compare-and-swap rides the same statement, as it does for an item
    // (update_task): two devices advancing the same note reminder cannot
    // both win, and a loser writes nothing. RETURNING content_rev: the 069
    // trigger decides it, and handing it back lets a run of saves chain
    // without a refetch between them. fetch_OPTIONAL, not fetch_one: the row
    // is locked and known to exist, so the only way to get nothing back is
    // the compare-and-swap losing.
    let result: Result<Option<(i64,)>, _> = sqlx::query_as(
        "UPDATE task_lists SET title = COALESCE($1, title), \
         body = CASE WHEN $2 THEN $3 ELSE body END, \
         attachments = CASE WHEN $4 THEN $5 ELSE attachments END, \
         due_at = CASE WHEN $7 THEN $8 ELSE due_at END, \
         schedule = CASE WHEN $9 THEN $10 ELSE schedule END \
         WHERE id = $6 AND (NOT $11 OR due_at IS NOT DISTINCT FROM $12) \
         RETURNING content_rev",
    )
    .bind(title)
    .bind(payload.body.is_some())
    .bind(payload.body.as_deref().filter(|b| !b.is_empty()))
    .bind(payload.attachments.is_some())
    .bind(payload.attachments.as_deref().filter(|a| !a.is_empty()))
    .bind(list_id)
    .bind(due_at.is_some())
    .bind(due_at.flatten())
    .bind(payload.schedule.is_some())
    .bind(schedule.flatten())
    .bind(expect_due.is_some())
    .bind(expect_due.flatten())
    .fetch_optional(&mut *tx)
    .await;
    let result = match result {
        Ok(None) => {
            return (StatusCode::CONFLICT, crate::task_timing::DUE_CHANGED_MESSAGE).into_response();
        }
        Ok(Some(rev)) => tx.commit().await.map(|()| rev),
        Err(e) => Err(e),
    };

    match result {
        Ok((content_rev,)) => Json(serde_json::json!({ "content_rev": content_rev })).into_response(),
        Err(e) => {
            tracing::error!("Failed to rename task list: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to rename task list",
            )
                .into_response()
        }
    }
}

/// Delete a personal task list (its tasks cascade via FK).
pub async fn delete_task_list(
    State(state): State<Arc<AppState>>,
    Path(list_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    if let Err(e) = check_list_owner(&state, list_id, &claims).await {
        return e.into_response();
    }

    let result = sqlx::query("DELETE FROM task_lists WHERE id = $1")
        .bind(list_id)
        .execute(&state.pool)
        .await;

    match result {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            tracing::error!("Failed to delete task list: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to delete task list",
            )
                .into_response()
        }
    }
}

/// List tasks in a personal list.
pub async fn list_list_tasks(
    State(state): State<Arc<AppState>>,
    Path(list_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    if let Err(e) = check_list_owner(&state, list_id, &claims).await {
        return e.into_response();
    }

    let sql = format!(
        "SELECT {TASK_COLUMNS} FROM channel_tasks WHERE list_id = $1 ORDER BY is_completed ASC, position ASC, id ASC"
    );
    let rows: Result<Vec<TaskRow>, _> = sqlx::query_as(&sql)
        .bind(list_id)
        .fetch_all(&state.pool)
        .await;

    match rows {
        Ok(rows) => Json(
            rows.into_iter()
                .map(task_row_to_response)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            tracing::error!("Failed to fetch tasks: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch tasks").into_response()
        }
    }
}

/// Create a task in a personal list.
pub async fn create_list_task(
    State(state): State<Arc<AppState>>,
    Path(list_id): Path<i64>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateTaskRequest>,
) -> impl IntoResponse {
    if let Err(e) = check_list_writable(&state, list_id, &claims).await {
        return e.into_response();
    }
    match insert_task(&state, None, Some(list_id), &payload, &claims).await {
        Ok((task, _created)) => Json(task).into_response(),
        Err(e) => e.into_response(),
    }
}

// --- Tasks-view tab preferences (order + favourites) ---

/// Ceiling on stored tab prefs per user. A pref row exists per personal list
/// or checklist channel the user has arranged; hundreds is already implausible,
/// and the cap keeps the per-user table growth bounded.
const MAX_TAB_PREFS: usize = 500;

#[derive(Serialize)]
pub struct TabPrefResponse {
    pub kind: String,
    pub ref_id: i64,
    pub is_favorite: bool,
}

#[derive(Deserialize)]
pub struct TabPrefEntry {
    pub kind: String,
    pub ref_id: i64,
    #[serde(default)]
    pub is_favorite: bool,
}

#[derive(Deserialize)]
pub struct PutTabPrefsRequest {
    pub prefs: Vec<TabPrefEntry>,
}

/// GET /task-tab-prefs — the caller's saved Tasks-bar order + favourites, in
/// display order. Rows are private per-user UI state; refs that no longer
/// resolve (deleted list, left server) are ignored by the client merge.
pub async fn list_tab_prefs(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let rows: Result<Vec<(String, i64, bool)>, _> = sqlx::query_as(
        "SELECT kind, ref_id, is_favorite FROM task_tab_prefs \
         WHERE user_id = $1 ORDER BY position ASC, kind ASC, ref_id ASC",
    )
    .bind(claims.sub)
    .fetch_all(&state.pool)
    .await;

    match rows {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|(kind, ref_id, is_favorite)| TabPrefResponse {
                    kind,
                    ref_id,
                    is_favorite,
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => {
            tracing::error!("Failed to fetch tab prefs: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch tab prefs",
            )
                .into_response()
        }
    }
}

/// PUT /task-tab-prefs — replace the caller's whole tab-pref set atomically;
/// the array order IS the bar order. A full replace (rather than per-row
/// PATCHes) makes every drag/favourite commit one atomic write with no
/// partial-order states. ref_ids are NOT cross-checked against list ownership
/// or channel membership: a pref row only ever affects the owner's own view,
/// and the client drops refs it can't resolve.
pub async fn put_tab_prefs(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<PutTabPrefsRequest>,
) -> impl IntoResponse {
    if payload.prefs.len() > MAX_TAB_PREFS {
        return (StatusCode::BAD_REQUEST, "Too many tab preferences").into_response();
    }
    for p in &payload.prefs {
        if p.kind != "list" && p.kind != "channel" {
            return (StatusCode::BAD_REQUEST, "kind must be 'list' or 'channel'").into_response();
        }
    }

    // Dedupe keep-first so a buggy client can't violate the PK mid-insert.
    let mut seen = std::collections::HashSet::new();
    let mut kinds: Vec<String> = Vec::with_capacity(payload.prefs.len());
    let mut refs: Vec<i64> = Vec::with_capacity(payload.prefs.len());
    let mut positions: Vec<i64> = Vec::with_capacity(payload.prefs.len());
    let mut favs: Vec<bool> = Vec::with_capacity(payload.prefs.len());
    for p in &payload.prefs {
        if !seen.insert((p.kind.clone(), p.ref_id)) {
            continue;
        }
        kinds.push(p.kind.clone());
        refs.push(p.ref_id);
        positions.push(kinds.len() as i64); // 1..n in array order
        favs.push(p.is_favorite);
    }

    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => {
            tracing::error!("Failed to begin tab-prefs transaction: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save tab prefs").into_response();
        }
    };

    let replace = async {
        sqlx::query("DELETE FROM task_tab_prefs WHERE user_id = $1")
            .bind(claims.sub)
            .execute(&mut *tx)
            .await?;
        if !kinds.is_empty() {
            sqlx::query(
                "INSERT INTO task_tab_prefs (user_id, kind, ref_id, position, is_favorite) \
                 SELECT $1, u.k, u.r, u.p, u.f \
                 FROM UNNEST($2::text[], $3::bigint[], $4::bigint[], $5::bool[]) AS u(k, r, p, f)",
            )
            .bind(claims.sub)
            .bind(&kinds)
            .bind(&refs)
            .bind(&positions)
            .bind(&favs)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await
    };

    match replace.await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to save tab prefs: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save tab prefs").into_response()
        }
    }
}

// --- Due-time reminders ---

#[derive(Serialize)]
pub struct TaskReminderResponse {
    pub id: i64,
    pub channel_id: Option<i64>,
    pub list_id: Option<i64>,
    pub due_at: String,
    /// The task's creator: a checklist item's sealed snooze/schedule bind it
    /// into their AAD, so the client needs it to open them.
    pub created_by: i64,
    /// Sealed; the reminder loop opens it to find a scheduled item's next
    /// alert after this one fires.
    pub schedule: Option<String>,
    /// Sealed {forDue, until}; the effective reminder time when it matches.
    pub snooze: Option<String>,
    /// This row is the NOTE's own reminder (migration 068), not an item's.
    /// The load-bearing part is the NEGATIVE `id` (see list_task_reminders);
    /// this flag only spares a reader having to know that.
    pub is_list: bool,
}

/// Newest overdue reminders kept in the feed, and upcoming ones. Split so a
/// pile of never-ticked past items cannot starve every future reminder out of
/// one ORDER BY due_at ASC LIMIT (a calendar makes such piles likely).
const REMINDERS_PAST_LIMIT: i64 = 100;
const REMINDERS_FUTURE_LIMIT: i64 = 400;

/// GET /task-reminders — every OPEN task with a due time that this user
/// should be reminded about: tasks in their own personal lists, plus channel
/// tasks THEY created in channels they can still SEE. Access revocation of
/// any kind must stop the reminders — the task is no longer theirs to
/// complete or even know about — so the channel arm is post-filtered through
/// the SAME permission resolver every other channel read uses (server
/// membership alone would ignore per-channel VIEW overwrites, and VIEW-denied
/// means 404 everywhere in this codebase). Deliberately content-free: ids and
/// times only; the notification never includes content anyway (same
/// lock-screen rule as messages).
///
/// A NOTE's own reminder (migration 068) rides the SAME array, with
/// `id = -list_id`. Task ids are always positive, so the two namespaces
/// cannot collide in any engine's per-id map — the web loop's fired markers,
/// Púca Notes' ReminderPlan/ReminderMerge — and one feed means one poll and
/// no new native code for the Android app to fetch it with.
pub async fn list_task_reminders(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Two UNION arms so each side has its own per-caller index path (see
    // migration 048); a single OR would force a scan over everyone's due rows.
    #[allow(clippy::type_complexity)]
    let rows: Result<Vec<(i64, Option<i64>, Option<i64>, String, i64, Option<String>, Option<String>)>, _> = sqlx::query_as(
        "WITH mine AS ( \
             SELECT t.id, t.channel_id, t.list_id, t.due_at, t.created_by, t.schedule, t.snooze \
             FROM channel_tasks t \
             JOIN task_lists l ON l.id = t.list_id AND l.owner_id = $1 AND l.trashed_at IS NULL \
             WHERE t.due_at IS NOT NULL AND t.is_completed = FALSE \
             UNION ALL \
             SELECT t.id, t.channel_id, t.list_id, t.due_at, t.created_by, t.schedule, t.snooze \
             FROM channel_tasks t \
             WHERE t.created_by = $1 AND t.channel_id IS NOT NULL \
               AND t.due_at IS NOT NULL AND t.is_completed = FALSE \
             UNION ALL \
             SELECT -l.id, NULL::BIGINT, l.id, l.due_at, $1::BIGINT, l.schedule, NULL::TEXT \
             FROM task_lists l \
             WHERE l.owner_id = $1 AND l.due_at IS NOT NULL AND l.trashed_at IS NULL \
         ), past AS ( \
             SELECT * FROM mine WHERE due_at <= NOW() ORDER BY due_at DESC, id DESC LIMIT $2 \
         ), future AS ( \
             SELECT * FROM mine WHERE due_at > NOW() ORDER BY due_at ASC, id ASC LIMIT $3 \
         ) \
         SELECT u.id, u.channel_id, u.list_id, \
                (replace((u.due_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS due_at, \
                u.created_by, u.schedule, u.snooze \
         FROM (SELECT * FROM past UNION ALL SELECT * FROM future) u \
         ORDER BY u.due_at ASC, u.id ASC",
    )
    .bind(claims.sub)
    .bind(REMINDERS_PAST_LIMIT)
    .bind(REMINDERS_FUTURE_LIMIT)
    .fetch_all(&state.pool)
    .await;

    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("Failed to fetch task reminders: {:?}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch task reminders",
            )
                .into_response();
        }
    };

    // Resolve each distinct channel ONCE through the real permission math
    // (membership + role bits + per-channel overwrites). Fail closed: a
    // channel that can't be resolved yields no reminders.
    let mut channel_visible: std::collections::HashMap<i64, bool> = std::collections::HashMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for (id, channel_id, list_id, due_at, created_by, schedule, snooze) in rows {
        if let Some(cid) = channel_id {
            let visible = match channel_visible.get(&cid) {
                Some(v) => *v,
                None => {
                    let v = check_channel_access(&state, cid, &claims).await.is_ok();
                    channel_visible.insert(cid, v);
                    v
                }
            };
            if !visible {
                continue;
            }
        }
        out.push(TaskReminderResponse {
            is_list: id < 0,
            id,
            channel_id,
            list_id,
            due_at,
            created_by,
            schedule,
            snooze,
        });
    }
    Json(out).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The op-key shape check (migration 070). It is a SHAPE check and
    /// nothing more: it cannot tell a random id from a digest, which is why
    /// the "never derive it from content" rule lives with the client that
    /// mints the key. What it does guarantee is that the value stays a short
    /// url-safe identifier the table's CHECK will also accept.
    #[test]
    fn op_key_shape_accepts_a_random_id_and_refuses_junk() {
        // POSITIVE CONTROL first: a check that refused everything would pass
        // every negative case below.
        assert!(validate_op_key("m3kd91x-7-q8z4vb2p").is_ok(), "a real client id");
        assert!(validate_op_key(&"a".repeat(16)).is_ok(), "the shortest accepted");
        assert!(validate_op_key(&"a".repeat(64)).is_ok(), "the longest accepted");
        assert!(validate_op_key("AZaz09-_AZaz09-_").is_ok(), "every accepted character");

        assert!(validate_op_key("").is_err(), "empty");
        assert!(validate_op_key(&"a".repeat(15)).is_err(), "too short to be random");
        assert!(validate_op_key(&"a".repeat(65)).is_err(), "past the column's cap");
        for bad in ["abcdefghijklmnop.", "abcdefghijklmnop/", "abcdefghijklmnop+", "abcdefghijklmnop=", "abcdefghij klmnop", "abcdefghijklmno\u{0}"] {
            assert!(validate_op_key(bad).is_err(), "refused: {bad:?}");
        }
        // A byte the PostgreSQL CHECK would also refuse, and which must never
        // reach it as a lone surrogate or a multi-byte char.
        assert!(validate_op_key("abcdefghijklmnopé").is_err(), "non-ascii");
    }

    /// An absent key is not an error: every client older than migration 070
    /// sends none, and must never be answered with a 400.
    #[test]
    fn an_absent_op_key_is_never_checked() {
        let payload: CreateTaskRequest =
            serde_json::from_str(r#"{"description":"x"}"#).expect("a create with no op_key parses");
        assert!(payload.op_key.is_none());
        let list: TaskListRequest =
            serde_json::from_str(r#"{"title":"x"}"#).expect("a list create with no op_key parses");
        assert!(list.op_key.is_none() && list.expect_rev.is_none());
    }
}

/// Idempotent creates and the op-key table, against a real database.
/// Skipped (not failed) when TEST_DATABASE_URL is unset, exactly like
/// list_content.rs's db_tests — never point it at the dev or production one.
#[cfg(test)]
mod db_tests {
    use super::*;
    use crate::state::UserId;
    use axum::response::Response;
    use serde_json::Value;
    use sqlx::PgPool;

    const V2: &str = r#"{"v":2,"t":"self","ct":"AAAA","n":"BBBB"}"#;

    async fn setup() -> Option<(Arc<AppState>, PgPool)> {
        let Some(url) = crate::migrator::test_database_url() else {
            println!("skipping: TEST_DATABASE_URL not set");
            return None;
        };
        let pool = match sqlx::postgres::PgPoolOptions::new().max_connections(4).connect(&url).await {
            Ok(p) => p,
            Err(_) => { println!("skipping: database unreachable"); return None; }
        };
        crate::migrator::app_migrator().run(&pool).await.expect("migrations apply");
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        Some((state, pool))
    }

    async fn user(pool: &PgPool, tag: &str) -> Claims {
        let name = format!("ik_{tag}_{}", uuid::Uuid::new_v4().simple());
        let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(&name).bind(b"s".as_ref()).bind(b"v".as_ref())
            .fetch_one(pool).await.expect("insert user");
        Claims { sub: id as UserId, username: name, exp: 0, tv: 0, sst: 1_700_000_000, sid: String::new(), ls: false }
    }

    async fn json_of(r: Response) -> Value {
        let b = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&b).unwrap_or(Value::Null)
    }

    fn list_req(title: &str, op_key: Option<&str>) -> TaskListRequest {
        TaskListRequest {
            title: Some(title.to_string()),
            body: None,
            attachments: None,
            reads_up_to: None,
            due_at: None,
            schedule: None,
            expect_due_at: None,
            expect_rev: None,
            op_key: op_key.map(String::from),
        }
    }

    async fn post_list(state: &Arc<AppState>, c: &Claims, title: &str, key: Option<&str>) -> (StatusCode, Value) {
        let r = create_task_list(State(state.clone()), Extension(c.clone()), Json(list_req(title, key))).await.into_response();
        let status = r.status();
        (status, json_of(r).await)
    }

    async fn post_item(state: &Arc<AppState>, c: &Claims, list_id: i64, text: &str, key: Option<&str>) -> (StatusCode, Value) {
        let mut body = serde_json::json!({ "description": text });
        if let Some(k) = key { body["op_key"] = Value::String(k.to_string()); }
        let r = create_list_task(
            State(state.clone()), Path(list_id), Extension(c.clone()),
            Json(serde_json::from_value(body).unwrap()),
        ).await.into_response();
        let status = r.status();
        (status, json_of(r).await)
    }

    async fn count_lists(pool: &PgPool, owner: i64) -> i64 {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM task_lists WHERE owner_id = $1")
            .bind(owner).fetch_one(pool).await.unwrap();
        n
    }

    async fn count_items(pool: &PgPool, list_id: i64) -> i64 {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM channel_tasks WHERE list_id = $1")
            .bind(list_id).fetch_one(pool).await.unwrap();
        n
    }

    async fn cleanup(pool: &PgPool, who: &[&Claims]) {
        for c in who {
            let _ = sqlx::query("DELETE FROM task_lists WHERE owner_id = $1").bind(c.sub).execute(pool).await;
            let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(c.sub as i32).execute(pool).await;
        }
    }

    const KEY_A: &str = "aaaaaaaaaaaaaaaa1";
    const KEY_B: &str = "bbbbbbbbbbbbbbbb2";

    /// The whole contract of migration 070 for a NOTE: one key, one note;
    /// the replay gets the original row back; a different key still makes a
    /// second note; no key at all is still the old at-least-once behaviour.
    #[tokio::test]
    async fn the_same_create_key_twice_makes_one_note() {
        let Some((state, pool)) = setup().await else { return };
        let alice = user(&pool, "list").await;

        let (s1, first) = post_list(&state, &alice, V2, Some(KEY_A)).await;
        assert_eq!(s1, StatusCode::OK);
        let (s2, again) = post_list(&state, &alice, V2, Some(KEY_A)).await;
        assert_eq!(s2, StatusCode::OK, "a replay is answered, not refused");
        assert_eq!(again["id"], first["id"], "the SAME note comes back");
        assert_eq!(again["created_at"], first["created_at"], "not a fresh row wearing the same id");
        assert_eq!(count_lists(&pool, alice.sub).await, 1, "one note on disk");

        // POSITIVE CONTROL: a different key is a different intent.
        let (_, other) = post_list(&state, &alice, V2, Some(KEY_B)).await;
        assert_ne!(other["id"], first["id"]);
        assert_eq!(count_lists(&pool, alice.sub).await, 2);

        // No key: the pre-070 behaviour, preserved for older clients — this
        // is what proves the guard is keyed and not a global de-duplicator.
        post_list(&state, &alice, V2, None).await;
        post_list(&state, &alice, V2, None).await;
        assert_eq!(count_lists(&pool, alice.sub).await, 4);

        // A malformed key is a 400 and creates nothing.
        let (bad, _) = post_list(&state, &alice, V2, Some("short")).await;
        assert_eq!(bad, StatusCode::BAD_REQUEST);
        assert_eq!(count_lists(&pool, alice.sub).await, 4);

        cleanup(&pool, &[&alice]).await;
    }

    /// One account's key can never match another's, and a replay whose row
    /// was deleted in the meantime is told so instead of resurrecting it.
    #[tokio::test]
    async fn create_keys_are_per_account_and_a_deleted_row_is_not_resurrected() {
        let Some((state, pool)) = setup().await else { return };
        let alice = user(&pool, "a").await;
        let bob = user(&pool, "b").await;

        let (_, mine) = post_list(&state, &alice, V2, Some(KEY_A)).await;
        let (status, theirs) = post_list(&state, &bob, V2, Some(KEY_A)).await;
        assert_eq!(status, StatusCode::OK);
        assert_ne!(theirs["id"], mine["id"], "the same key string, two accounts, two notes");
        assert_eq!(count_lists(&pool, alice.sub).await, 1);
        assert_eq!(count_lists(&pool, bob.sub).await, 1);

        // Delete the note, then replay its create: the create really did
        // happen, so re-running it would resurrect something deliberately
        // removed. 409, and nothing comes back.
        let id = mine["id"].as_i64().unwrap();
        let r = delete_task_list(State(state.clone()), Path(id), Extension(alice.clone())).await.into_response();
        assert_eq!(r.status(), StatusCode::NO_CONTENT);
        let (status, _) = post_list(&state, &alice, V2, Some(KEY_A)).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(count_lists(&pool, alice.sub).await, 0, "nothing was resurrected, and nothing new made");

        cleanup(&pool, &[&alice, &bob]).await;
    }

    /// The same for an ITEM, including the thing a duplicate would give away:
    /// the position must not advance twice.
    #[tokio::test]
    async fn the_same_create_key_twice_makes_one_item() {
        let Some((state, pool)) = setup().await else { return };
        let alice = user(&pool, "item").await;
        let (_, list) = post_list(&state, &alice, V2, None).await;
        let list_id = list["id"].as_i64().unwrap();

        let (s1, first) = post_item(&state, &alice, list_id, V2, Some(KEY_A)).await;
        assert_eq!(s1, StatusCode::OK);
        let (s2, again) = post_item(&state, &alice, list_id, V2, Some(KEY_A)).await;
        assert_eq!(s2, StatusCode::OK);
        assert_eq!(again["id"], first["id"]);
        assert_eq!(again["position"], first["position"], "a replay did not take a second slot");
        assert_eq!(count_items(&pool, list_id).await, 1);

        // POSITIVE CONTROL.
        let (_, second) = post_item(&state, &alice, list_id, V2, Some(KEY_B)).await;
        assert_ne!(second["id"], first["id"]);
        assert_eq!(count_items(&pool, list_id).await, 2);

        // A key minted for a NOTE cannot be spent on an item, and vice versa.
        //
        // task_lists.id and channel_tasks.id are INDEPENDENT sequences, so
        // "the id it names is not in this table" is not a guard — on a fresh
        // database both start near 1 and a cross-scope replay would be
        // answered with a real, unrelated row. This test therefore MAKES the
        // two ids collide: the note gets an id past every existing item, and
        // an item is then forced to that exact id. Only a server that
        // compares the SCOPE it stored can still refuse.
        let key_c = "cccccccccccccccc3";
        let high = bump_ids_past_both(&pool).await;
        let (_, note) = post_list(&state, &alice, V2, Some(key_c)).await;
        let note_id = note["id"].as_i64().expect("the note was made");
        assert!(note_id > high, "the note's id is past every item id that exists");
        sqlx::query(
            "INSERT INTO channel_tasks (id, list_id, description, created_by, position) \
             OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, 99)",
        )
        .bind(note_id).bind(list_id).bind(V2).bind(alice.sub)
        .execute(&pool).await.expect("an item wearing the note's id");
        // No setval here on purpose: `bump_ids_past_both` already left every
        // future item id a million above this one, and dragging the sequence
        // back down to it would undo exactly that.
        let (status, body) = post_item(&state, &alice, list_id, V2, Some(key_c)).await;
        assert_eq!(status, StatusCode::CONFLICT, "a key spent on a note is refused on an item");
        assert_eq!(body, Value::Null, "and no row of any kind comes back");
        assert_eq!(count_items(&pool, list_id).await, 3, "and made nothing (2 + the planted collision)");

        cleanup(&pool, &[&alice]).await;
    }

    /// Ballast: `n` extra items on `list_id`, straight into the table. The
    /// cap counts rows, and what is in them does not matter.
    ///
    /// The ids are NEGATIVE, below everything in the table, so that filling a
    /// checklist to 2000 never consumes 2000 values of the identity sequence
    /// — which `bump_ids_past_both` below reasons about, on a database these
    /// concurrent tests share. The sequence never hands out a negative, so
    /// nothing can collide with these.
    async fn fill_list(pool: &PgPool, list_id: i64, owner: i64, n: i64) {
        sqlx::query(
            "INSERT INTO channel_tasks (id, list_id, description, created_by, position) \
             OVERRIDING SYSTEM VALUE \
             SELECT (SELECT LEAST(COALESCE(MIN(id), 0), 0) FROM channel_tasks) - g, $1, $2, $3, 1000 + g \
             FROM generate_series(1, $4) g",
        )
        .bind(list_id).bind(V2).bind(owner).bind(n)
        .execute(pool).await.expect("fill the checklist to the cap");
    }

    /// A REPLAY IS ANSWERED EVEN WHEN THE CHECKLIST IS FULL.
    ///
    /// Every check in front of the insert judges a NEW item against the list
    /// as it stands now, and the per-checklist cap counts the very item the
    /// replayed key already made. So a list standing at exactly the cap
    /// refused the retry with 400 "This checklist has reached its task
    /// limit" — and the client's outbox treats a non-5xx as unrecoverable:
    /// it drops the op and names the item in the "changes made offline
    /// couldn't be saved" toast, telling the user it was lost when the
    /// server has had it all along.
    #[tokio::test]
    async fn a_replayed_item_is_re_served_even_when_the_checklist_is_full() {
        let Some((state, pool)) = setup().await else { return };
        let alice = user(&pool, "cap").await;
        let (_, list) = post_list(&state, &alice, V2, None).await;
        let list_id = list["id"].as_i64().unwrap();

        // One real create through the handler, carrying its key...
        let (s1, first) = post_item(&state, &alice, list_id, V2, Some(KEY_A)).await;
        assert_eq!(s1, StatusCode::OK);
        // ...and the list then fills to EXACTLY the cap, that item included.
        fill_list(&pool, list_id, alice.sub, MAX_TASKS_PER_CHECKLIST - 1).await;
        assert_eq!(count_items(&pool, list_id).await, MAX_TASKS_PER_CHECKLIST);

        // The answer to the first attempt never arrived, so it is sent again.
        let (s2, again) = post_item(&state, &alice, list_id, V2, Some(KEY_A)).await;
        assert_eq!(s2, StatusCode::OK, "a replay is answered, not refused for being over the cap");
        assert_eq!(again["id"], first["id"], "and it is the SAME item");
        assert_eq!(again["position"], first["position"]);
        assert_eq!(count_items(&pool, list_id).await, MAX_TASKS_PER_CHECKLIST, "nothing was added");

        // POSITIVE CONTROL: the cap is still a cap. A genuinely new item is
        // refused whether or not it carries a key of its own — the replay
        // path is a way back to a row that exists, not a hole in the limit.
        let (s3, _) = post_item(&state, &alice, list_id, V2, Some(KEY_B)).await;
        assert_eq!(s3, StatusCode::BAD_REQUEST, "a NEW keyed item is still capped");
        let (s4, _) = post_item(&state, &alice, list_id, V2, None).await;
        assert_eq!(s4, StatusCode::BAD_REQUEST, "and so is a keyless one");
        assert_eq!(count_items(&pool, list_id).await, MAX_TASKS_PER_CHECKLIST);

        // And a replay whose row was deleted in the meantime still says so,
        // rather than being answered by the cap.
        sqlx::query("DELETE FROM channel_tasks WHERE id = $1")
            .bind(first["id"].as_i64().unwrap()).execute(&pool).await.unwrap();
        fill_list(&pool, list_id, alice.sub, 1).await;
        let (s5, _) = post_item(&state, &alice, list_id, V2, Some(KEY_A)).await;
        assert_eq!(s5, StatusCode::CONFLICT, "gone, not \"the list is full\"");

        cleanup(&pool, &[&alice]).await;
    }

    /// Clear a band of ids that a `task_lists` row can take and a
    /// `channel_tasks` row cannot, so the next note's id is free to be
    /// duplicated by hand in `channel_tasks`. Returns the watermark below it.
    ///
    /// The note's id has to be UNREACHABLE by items, not merely unused right
    /// now. These tests share one database and cargo runs them at the same
    /// time, so setting both sequences to the same value — which is what this
    /// did — left the next note and the next item racing for the same number,
    /// and the planted row hit a 23505 whenever another test created an item
    /// first. Items are therefore pushed a long way ABOVE the band: every id
    /// that already exists is below `high`, and every item made from here on
    /// is above `high + ITEM_GAP`, so anything in between belongs to notes.
    async fn bump_ids_past_both(pool: &PgPool) -> i64 {
        const ITEM_GAP: i64 = 1_000_000;
        let (high,): (i64,) = sqlx::query_as(
            "SELECT GREATEST((SELECT COALESCE(MAX(id), 0) FROM task_lists), \
                             (SELECT COALESCE(MAX(id), 0) FROM channel_tasks)) + 1000",
        )
        .fetch_one(pool).await.unwrap();
        for (table, to) in [("task_lists", high), ("channel_tasks", high + ITEM_GAP)] {
            sqlx::query("SELECT setval(pg_get_serial_sequence($1, 'id'), $2, true)")
                .bind(table).bind(to)
                .execute(pool).await.unwrap();
        }
        high
    }

    /// A replay answers with the note AS IT STANDS, not as it was the instant
    /// it was made. The original may have been trashed or filled with items
    /// while the lost answer was being retried, and a client that is told
    /// "live, empty" puts a phantom card back on the grid.
    #[tokio::test]
    async fn a_replayed_create_answers_with_the_note_as_it_stands() {
        let Some((state, pool)) = setup().await else { return };
        let alice = user(&pool, "reserve").await;

        let (_, made) = post_list(&state, &alice, V2, Some(KEY_A)).await;
        let id = made["id"].as_i64().unwrap();
        // The fresh insert IS live and empty — that much was never wrong.
        assert_eq!(made["trashed_at"], Value::Null);
        assert_eq!(made["total_tasks"], 0);
        assert_eq!(made["is_self"], false);

        // Everything that happens between the lost answer and the retry.
        assert_eq!(post_item(&state, &alice, id, V2, None).await.0, StatusCode::OK);
        let t = crate::list_content::trash_list(State(state.clone()), Path(id), Extension(alice.clone())).await.into_response();
        assert_eq!(t.status(), StatusCode::OK);

        let (status, again) = post_list(&state, &alice, V2, Some(KEY_A)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(again["id"], made["id"], "still the same note");
        assert!(again["trashed_at"].is_string(), "a trashed note is not answered as live");
        assert_eq!(again["total_tasks"], 1, "nor is a note with an item answered as empty");
        assert_eq!(count_lists(&pool, alice.sub).await, 1, "and the retry made nothing");

        cleanup(&pool, &[&alice]).await;
    }

    /// The sweep forgets the key and keeps the note.
    #[tokio::test]
    async fn the_sweep_forgets_keys_past_the_window() {
        let Some((state, pool)) = setup().await else { return };
        let alice = user(&pool, "sweep").await;
        let (_, made) = post_list(&state, &alice, V2, Some(KEY_A)).await;
        let id = made["id"].as_i64().unwrap();

        // One key inside the window, one backdated past it.
        post_list(&state, &alice, V2, Some(KEY_B)).await;
        sqlx::query("UPDATE task_create_keys SET created_at = NOW() - INTERVAL '48 hours' WHERE user_id = $1 AND op_key = $2")
            .bind(alice.sub).bind(KEY_A).execute(&pool).await.unwrap();

        let swept = sqlx::query("DELETE FROM task_create_keys WHERE created_at < NOW() - make_interval(hours => $1::int)")
            .bind(24_i32).execute(&pool).await.unwrap().rows_affected();
        assert!(swept >= 1);

        let (remembered,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM task_create_keys WHERE user_id = $1")
            .bind(alice.sub).fetch_one(&pool).await.unwrap();
        assert_eq!(remembered, 1, "the fresh key is still remembered — the sweep is not a truncate");
        let (gone,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM task_create_keys WHERE user_id = $1 AND op_key = $2")
            .bind(alice.sub).bind(KEY_A).fetch_one(&pool).await.unwrap();
        assert_eq!(gone, 0);
        // The note the forgotten key made is untouched.
        let (still,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM task_lists WHERE id = $1").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(still, 1, "the sweep forgets the key, never the note");

        cleanup(&pool, &[&alice]).await;
    }
}
