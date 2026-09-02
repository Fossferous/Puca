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
    /// the server learns WHEN, never WHAT (descriptions stay E2EE).
    pub due_at: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateTaskRequest {
    pub description: String,
    pub parent_id: Option<i64>,
    pub attachments: Option<String>,
    /// RFC3339 due time; absent/null = none.
    pub due_at: Option<String>,
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
}

#[derive(Deserialize)]
pub struct TaskListRequest {
    pub title: String,
    /// See UpdateTaskRequest::reads_up_to.
    #[serde(default)]
    pub reads_up_to: Option<u64>,
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
    }
}

// NULL due_at stays NULL through the replace/concat (both are strict).
const TASK_COLUMNS: &str =
    "id, channel_id, list_id, parent_id, description, is_completed, position, (replace((created_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS created_at, created_by, attachments, (replace((due_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS due_at";

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

/// Confirm the caller owns the given personal list.
async fn check_list_owner(
    state: &AppState,
    list_id: i64,
    claims: &Claims,
) -> Result<(), (StatusCode, &'static str)> {
    let owner: Option<(i64,)> = sqlx::query_as("SELECT owner_id FROM task_lists WHERE id = $1")
        .bind(list_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);

    match owner {
        None => Err((StatusCode::NOT_FOUND, "List not found")),
        Some((owner_id,)) if owner_id == claims.sub => Ok(()),
        Some(_) => Err((StatusCode::FORBIDDEN, "Access denied")),
    }
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
        check_list_owner(state, lid, claims).await?;
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
            if p_channel != channel_id || p_list != list_id {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "Parent task is in a different checklist",
                ));
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

async fn insert_task(
    state: &AppState,
    channel_id: Option<i64>,
    list_id: Option<i64>,
    payload: &CreateTaskRequest,
    claims: &Claims,
) -> Result<TaskResponse, (StatusCode, &'static str)> {
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
        "INSERT INTO channel_tasks (channel_id, list_id, parent_id, description, created_by, position, attachments, due_at) \
         VALUES ($1, $2, $3, $4, $5, \
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM channel_tasks \
                  WHERE channel_id IS NOT DISTINCT FROM $1 AND list_id IS NOT DISTINCT FROM $2), $6, $7) \
         RETURNING {TASK_COLUMNS}"
    );
    let row: Result<TaskRow, _> = sqlx::query_as(&sql)
        .bind(channel_id)
        .bind(list_id)
        .bind(payload.parent_id)
        .bind(payload.description.trim())
        .bind(claims.sub)
        .bind(attachments)
        .bind(due_at)
        .fetch_one(&state.pool)
        .await;

    match row {
        Ok(r) => Ok(task_row_to_response(r)),
        Err(e) => {
            tracing::error!("Failed to create task: {:?}", e);
            Err((StatusCode::INTERNAL_SERVER_ERROR, "Failed to create task"))
        }
    }
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
        Ok(task) => {
            broadcast_checklist(&state, Some(channel_id), claims.sub);
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
        if payload.is_completed.is_some()
            && !perms.has(Permissions::COMPLETE_TASKS)
            && !perms.has(Permissions::MANAGE_TASKS)
        {
            return (StatusCode::FORBIDDEN, "Missing Complete Tasks permission").into_response();
        }
        if (payload.description.is_some()
            || payload.attachments.is_some()
            || payload.due_at.is_some())
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
    if payload.description.is_some() || new_attachments.is_some() {
        let current: Option<(String, Option<String>)> = match sqlx::query_as(
            "SELECT description, attachments FROM channel_tasks WHERE id = $1 FOR UPDATE",
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
        let Some((cur_desc, cur_att)) = current else {
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
         due_at = CASE WHEN $5 THEN $6 ELSE due_at END WHERE id = $7"
    )
    .bind(payload.is_completed)
    .bind(payload.description.as_deref().map(str::trim))
    .bind(set_attachments)
    .bind(new_attachments)
    .bind(set_due)
    .bind(new_due)
    .bind(task_id)
    .execute(&mut *tx)
    .await;

    if let Err(e) = result {
        tracing::error!("Failed to update task: {:?}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to update task").into_response();
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
                    let _ = tx.rollback().await;
                    return (StatusCode::BAD_REQUEST, "Parent task is in a different checklist").into_response();
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

/// List the caller's task lists with progress counts.
pub async fn list_task_lists(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Includes the "Notes to self" (is_self) list: since the Tasks view became
    // the single home for personal lists, hiding it would strand those items.
    let rows: Result<Vec<(i64, String, String, i64, i64)>, _> = sqlx::query_as(
        "SELECT l.id, l.title, (replace((l.created_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS created_at, \
                COUNT(t.id) AS total, \
                COUNT(t.id) FILTER (WHERE t.is_completed) AS done \
         FROM task_lists l \
         LEFT JOIN channel_tasks t ON t.list_id = l.id \
         WHERE l.owner_id = $1 \
         GROUP BY l.id, l.title, l.created_at \
         ORDER BY l.is_self DESC, l.id ASC",
    )
    .bind(claims.sub)
    .fetch_all(&state.pool)
    .await;

    match rows {
        Ok(rows) => Json(
            rows.into_iter()
                .map(|(id, title, created_at, total, done)| TaskListResponse {
                    id,
                    title,
                    created_at,
                    total_tasks: total,
                    completed_tasks: done,
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
    let title = payload.title.trim();
    if title.is_empty() {
        return (StatusCode::BAD_REQUEST, "Title cannot be empty").into_response();
    }
    if title.len() > MAX_LIST_TITLE_LEN {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Title too long").into_response();
    }

    let row: Result<(i64, String, String), _> = sqlx::query_as(
        "INSERT INTO task_lists (owner_id, title) VALUES ($1, $2) RETURNING id, title, (replace((created_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS created_at",
    )
    .bind(claims.sub)
    .bind(title)
    .fetch_one(&state.pool)
    .await;

    match row {
        Ok((id, title, created_at)) => Json(TaskListResponse {
            id,
            title,
            created_at,
            total_tasks: 0,
            completed_tasks: 0,
        })
        .into_response(),
        Err(e) => {
            tracing::error!("Failed to create task list: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to create task list",
            )
                .into_response()
        }
    }
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
    // Try to fetch the existing one first.
    let existing: Option<(i64, String, String)> = sqlx::query_as(
        "SELECT id, title, (replace((created_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS created_at FROM task_lists WHERE owner_id = $1 AND is_self = TRUE",
    )
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
        sqlx::query_as(
            "SELECT id, title, (replace((created_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS created_at FROM task_lists WHERE owner_id = $1 AND is_self = TRUE",
        )
        .bind(claims.sub)
        .fetch_one(&state.pool)
        .await
    };

    match row {
        Ok((id, title, created_at)) => {
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

/// Rename a personal task list.
pub async fn rename_task_list(
    State(state): State<Arc<AppState>>,
    Path(list_id): Path<i64>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<TaskListRequest>,
) -> impl IntoResponse {
    if let Err(e) = check_list_owner(&state, list_id, &claims).await {
        return e.into_response();
    }
    let title = payload.title.trim();
    if title.is_empty() {
        return (StatusCode::BAD_REQUEST, "Title cannot be empty").into_response();
    }
    if title.len() > MAX_LIST_TITLE_LEN {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Title too long").into_response();
    }

    // Titles are sealed encrypt-to-self bodies with no history: the same
    // downgrade rule as descriptions (envelope_version.rs), fail-closed.
    let current: Option<(String,)> = match sqlx::query_as("SELECT title FROM task_lists WHERE id = $1")
        .bind(list_id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Failed to read task list before rename: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to rename task list").into_response();
        }
    };
    if let Some((cur,)) = current {
        if crate::envelope_version::edit_is_downgrade(&cur, title, payload.reads_up_to) {
            return (StatusCode::CONFLICT, crate::envelope_version::DOWNGRADE_MESSAGE).into_response();
        }
    }
    let result = sqlx::query("UPDATE task_lists SET title = $1 WHERE id = $2")
        .bind(title)
        .bind(list_id)
        .execute(&state.pool)
        .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
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
    if let Err(e) = check_list_owner(&state, list_id, &claims).await {
        return e.into_response();
    }
    match insert_task(&state, None, Some(list_id), &payload, &claims).await {
        Ok(task) => Json(task).into_response(),
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
}

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
pub async fn list_task_reminders(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Two UNION arms so each side has its own per-caller index path (see
    // migration 048); a single OR would force a scan over everyone's due rows.
    let rows: Result<Vec<(i64, Option<i64>, Option<i64>, String)>, _> = sqlx::query_as(
        "SELECT u.id, u.channel_id, u.list_id, \
                (replace((u.due_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z') AS due_at \
         FROM ( \
             SELECT t.id, t.channel_id, t.list_id, t.due_at \
             FROM channel_tasks t \
             JOIN task_lists l ON l.id = t.list_id AND l.owner_id = $1 \
             WHERE t.due_at IS NOT NULL AND t.is_completed = FALSE \
             UNION ALL \
             SELECT t.id, t.channel_id, t.list_id, t.due_at \
             FROM channel_tasks t \
             WHERE t.created_by = $1 AND t.channel_id IS NOT NULL \
               AND t.due_at IS NOT NULL AND t.is_completed = FALSE \
         ) u \
         ORDER BY u.due_at ASC LIMIT 500",
    )
    .bind(claims.sub)
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
    for (id, channel_id, list_id, due_at) in rows {
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
            id,
            channel_id,
            list_id,
            due_at,
        });
    }
    Json(out).into_response()
}
