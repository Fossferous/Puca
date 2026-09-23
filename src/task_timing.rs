//! Task timing: the sealed schedule and snooze columns (migration 066), the
//! rules the task handlers enforce on them, and the capability probe clients
//! use to find out whether this server has them.
//!
//! The server never opens either value. `schedule` is a client-sealed
//! EventSchedule (all-day, start/end, time zone, repeat rule, skipped dates,
//! location, alerts, "keep time private"); `snooze` is a client-sealed
//! {forDue, until}. What the server CAN see: whether each is present, its
//! (bucket-padded) size, due_at as before, and edit times. An editor's
//! snooze also moves the plaintext due_at to the snooze instant (the next
//! reminder), so only the pushed-back time stays sealed. That is what
//! docs/SECURITY_MODEL.md states.
//!
//! Because the rule inside `schedule` is invisible here, the guard that stops
//! an OLD client from silently ending a repeating series cannot ask "does
//! this repeat?". It asks the only question the server can answer: does the
//! item, or anything in the subtree a completion would sweep, carry a
//! schedule at all? An old client completing such an item gets a 409 that
//! says to update; a client that sends `recurrence_aware` has taken over the
//! decision (it advances a repeating item instead of completing it). A
//! one-off event ticked from an old client is refused too — the cost of not
//! leaking which schedules repeat.

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;

/// Sealed EventSchedule ceiling. The client pads plaintext to 256 / 1024 /
/// 4096 / 8192 bytes and refuses more than 8192; a v2/v3 envelope of that is
/// ~11 KiB (base64 of nonce+ciphertext+tag, plus the JSON fields).
pub const MAX_SCHEDULE_LEN: usize = 16384;
/// Sealed snooze ceiling: 128 padded bytes seal to ~250.
pub const MAX_SNOOZE_LEN: usize = 1024;

/// The refusal an old client sees when it would end a scheduled item.
pub const SCHEDULE_COMPLETE_MESSAGE: &str =
    "This item has a date or repeats — update the app to complete it";
/// The compare-and-swap loser's answer.
pub const DUE_CHANGED_MESSAGE: &str =
    "This item's time changed on another device — refresh and try again";

/// Validate a sealed sidecar value from a request. `Ok(None)` = clear (the
/// empty string), `Ok(Some(v))` = store `v`. Stricter than descriptions:
/// these fields never had a plaintext era, so no honest writer sends
/// anything but an envelope.
pub fn validate_sealed<'a>(
    raw: &'a str,
    max: usize,
    what: &'static str,
) -> Result<Option<&'a str>, (StatusCode, &'static str)> {
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() > max {
        return Err((StatusCode::BAD_REQUEST, match what {
            "schedule" => "Schedule too large",
            _ => "Snooze too large",
        }));
    }
    if raw.contains('\0') {
        return Err((StatusCode::BAD_REQUEST, match what {
            "schedule" => "Schedule contains invalid characters",
            _ => "Snooze contains invalid characters",
        }));
    }
    if crate::envelope_version::envelope_version(raw).is_none() {
        return Err((StatusCode::BAD_REQUEST, match what {
            "schedule" => "Schedule must be sealed on the device",
            _ => "Snooze must be sealed on the device",
        }));
    }
    Ok(Some(raw))
}

/// `validate_sealed` for a task in a known scope. A CHANNEL task's timing must
/// be a channel envelope of v3 OR NEWER — the same rule the client reads by
/// (tasks.ts openTimingValue; docs/E2EE.md): v3 binds the channel, epoch, creator and the
/// value's kind (chan-taskevt / chan-tasksnz) into the tag, and these two
/// kinds were born v3 — no honest writer ever produced a v2 one. Refusing
/// anything older here keeps an unbound value (which could be lifted from
/// one item onto another and still open) out of the column altogether; the
/// client refuses to open one as well (tasks.ts openTimingValue). Personal
/// items are sealed to self and have no channel to bind.
pub fn validate_sealed_scoped<'a>(
    raw: &'a str,
    max: usize,
    what: &'static str,
    in_channel: bool,
) -> Result<Option<&'a str>, (StatusCode, &'static str)> {
    let v = validate_sealed(raw, max, what)?;
    if let (Some(env), true) = (v, in_channel) {
        let bound = serde_json::from_str::<serde_json::Value>(env)
            .ok()
            .map(|j| j.get("t").and_then(|t| t.as_str()) == Some("ch"))
            .unwrap_or(false)
            && crate::envelope_version::envelope_version(env).is_some_and(|n| n >= 3);
        if !bound {
            return Err((StatusCode::BAD_REQUEST, match what {
                "schedule" => "A shared item's schedule must be sealed to its channel — update the app",
                _ => "A shared item's snooze must be sealed to its channel — update the app",
            }));
        }
    }
    Ok(v)
}

/// Does the task, or any task under it (the rows a completion sweeps), carry
/// a schedule? Same depth bound as the completion sweep in update_task.
pub const SUBTREE_HAS_SCHEDULE_SQL: &str = "WITH RECURSIVE sub AS ( \
         SELECT id, schedule, 0 AS depth FROM channel_tasks WHERE id = $1 \
         UNION ALL \
         SELECT t.id, t.schedule, s.depth + 1 FROM channel_tasks t \
         JOIN sub s ON t.parent_id = s.id WHERE s.depth < 10 \
     ) SELECT EXISTS (SELECT 1 FROM sub WHERE schedule IS NOT NULL)";

/// Reopen everything under a task (not the task itself).
pub const REOPEN_SUBTREE_SQL: &str = "WITH RECURSIVE sub AS ( \
         SELECT id, 1 AS depth FROM channel_tasks WHERE parent_id = $1 \
         UNION ALL \
         SELECT t.id, s.depth + 1 FROM channel_tasks t \
         JOIN sub s ON t.parent_id = s.id WHERE s.depth < 10 \
     ) \
     UPDATE channel_tasks SET is_completed = FALSE WHERE id IN (SELECT id FROM sub) AND is_completed";

/// What GET /task-features names. A client reads this ONCE, so it can tell a
/// 066 server from an older one even for a note with no tasks in it (a task
/// list response that is `[]` carries no keys to detect).
pub const TASK_FEATURES: &[&str] = &[
    "schedule",
    "snooze",
    "updated_at",
    "expect_due_at",
    "recurrence_aware",
    "reopen_subtree",
    "reminder_feed_v2",
    // Migration 070: a create may carry a random `op_key`, and a replay of
    // one the server already made is answered with the row it made instead
    // of a second one. Advertised, not gated on: the client sends the key to
    // every server, because an older one simply drops the field, so there is
    // nothing for a reader to decide. It is here so an operator can see what
    // the server they are on does — see ListFeatures.idempotentCreates in
    // frontend/src/api/listContent.ts.
    "op_key",
];

#[derive(Serialize)]
pub struct TaskFeaturesResponse {
    pub version: u32,
    pub features: &'static [&'static str],
}

/// GET /task-features — static. An older server answers 404, which the client
/// reads as "none of these".
pub async fn task_features() -> impl IntoResponse {
    Json(TaskFeaturesResponse { version: 1, features: TASK_FEATURES })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEALED: &str = r#"{"v":2,"t":"self","ct":"AAAA"}"#;

    #[test]
    fn empty_clears_and_an_envelope_is_stored() {
        assert_eq!(validate_sealed("", MAX_SCHEDULE_LEN, "schedule"), Ok(None));
        assert_eq!(validate_sealed(SEALED, MAX_SCHEDULE_LEN, "schedule"), Ok(Some(SEALED)));
        let ch = r#"{"v":3,"t":"ch","epoch":2,"ct":"QUJD"}"#;
        assert_eq!(validate_sealed(ch, MAX_SNOOZE_LEN, "snooze"), Ok(Some(ch)));
    }

    #[test]
    fn plaintext_is_refused_because_these_fields_never_had_a_plaintext_era() {
        let plain = r#"{"v":1,"kind":"event","start":"2026-10-01T09:00"}"#;
        assert_eq!(
            validate_sealed(plain, MAX_SCHEDULE_LEN, "schedule").unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
        assert!(validate_sealed("tomorrow", MAX_SNOOZE_LEN, "snooze").is_err());
        assert!(validate_sealed("{\"k\":\"snooze/1\"}", MAX_SNOOZE_LEN, "snooze").is_err());
    }

    #[test]
    fn a_channel_item_takes_a_channel_envelope_of_v3_or_newer() {
        let v3 = r#"{"v":3,"t":"ch","epoch":2,"ct":"QUJD"}"#;
        let v2 = r#"{"v":2,"t":"ch","epoch":2,"ct":"QUJD"}"#;
        // Positive control: v3 in a channel, and anything sealed in a personal list.
        assert_eq!(validate_sealed_scoped(v3, MAX_SCHEDULE_LEN, "schedule", true), Ok(Some(v3)));
        // The rule is "v3 or newer", the client's too (tasks.ts openTimingValue):
        // a newer writer's value is stored, and an older reader says "update".
        let v4 = r#"{"v":4,"t":"ch","epoch":2,"ct":"QUJD"}"#;
        assert_eq!(validate_sealed_scoped(v4, MAX_SNOOZE_LEN, "snooze", true), Ok(Some(v4)));
        assert_eq!(validate_sealed_scoped(v2, MAX_SCHEDULE_LEN, "schedule", false), Ok(Some(v2)));
        assert_eq!(validate_sealed_scoped(SEALED, MAX_SNOOZE_LEN, "snooze", false), Ok(Some(SEALED)));
        // Unbound or wrong-kind envelopes in a channel are refused.
        assert_eq!(validate_sealed_scoped(v2, MAX_SCHEDULE_LEN, "schedule", true).unwrap_err().0, StatusCode::BAD_REQUEST);
        assert!(validate_sealed_scoped(v2, MAX_SNOOZE_LEN, "snooze", true).is_err());
        assert!(validate_sealed_scoped(SEALED, MAX_SNOOZE_LEN, "snooze", true).is_err());
        let self_v3 = r#"{"v":3,"t":"self","ct":"QUJD"}"#;
        assert!(validate_sealed_scoped(self_v3, MAX_SCHEDULE_LEN, "schedule", true).is_err());
        // Clearing is still a clear.
        assert_eq!(validate_sealed_scoped("", MAX_SCHEDULE_LEN, "schedule", true), Ok(None));
    }

    #[test]
    fn size_and_nul_caps() {
        let over = format!(r#"{{"v":2,"t":"self","ct":"{}"}}"#, "A".repeat(MAX_SCHEDULE_LEN));
        assert!(validate_sealed(&over, MAX_SCHEDULE_LEN, "schedule").is_err());
        // The largest plaintext bucket (8192) sealed by the client fits.
        let at_cap = format!(r#"{{"v":3,"t":"ch","epoch":9,"ct":"{}"}}"#, "A".repeat((8192 + 28) * 4 / 3 + 4));
        assert!(at_cap.len() < MAX_SCHEDULE_LEN);
        assert!(validate_sealed(&at_cap, MAX_SCHEDULE_LEN, "schedule").is_ok());
        let nul = "{\"v\":2,\"t\":\"self\",\"ct\":\"A\0A\"}";
        assert!(validate_sealed(nul, MAX_SCHEDULE_LEN, "schedule").is_err());
        let over_snooze = format!(r#"{{"v":2,"t":"self","ct":"{}"}}"#, "A".repeat(MAX_SNOOZE_LEN));
        assert!(validate_sealed(&over_snooze, MAX_SNOOZE_LEN, "snooze").is_err());
    }
}

/// The handlers and the migration-066 triggers against a REAL database.
/// Self-skips (prints "skipping") without TEST_DATABASE_URL / DATABASE_URL,
/// like auth::session_tests; the migrator runs first so a fresh database
/// works. Run with TEST_DATABASE_URL pointing at a THROWAWAY cluster.
#[cfg(test)]
mod db_tests {
    use crate::auth::Claims;
    use crate::state::AppState;
    use crate::task_handlers::{
        create_list_task, create_task, list_list_tasks, list_task_lists, list_task_reminders, reorder_task,
        update_task, CreateTaskRequest, ReorderTaskRequest, TaskListsQuery, UpdateTaskRequest,
    };
    use axum::{
        extract::{Json, Path, Query, State},
        http::StatusCode,
        response::{IntoResponse, Response},
        Extension,
    };
    use serde_json::{json, Value};
    use sqlx::PgPool;
    use std::sync::Arc;

    const S1: &str = r#"{"v":2,"t":"self","ct":"c2NoZWR1bGUtb25l"}"#;
    const S2: &str = r#"{"v":2,"t":"self","ct":"c2NoZWR1bGUtdHdv"}"#;
    const SNZ: &str = r#"{"v":2,"t":"self","ct":"c25vb3pl"}"#;

    async fn pool() -> Option<PgPool> {
        dotenv::dotenv().ok();
        let url = match std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL")) {
            Ok(u) => u,
            Err(_) => {
                println!("skipping: no database");
                return None;
            }
        };
        let pool = match sqlx::postgres::PgPoolOptions::new().max_connections(4).connect(&url).await {
            Ok(p) => p,
            Err(_) => {
                println!("skipping: database unreachable");
                return None;
            }
        };
        sqlx::migrate!("./migrations").run(&pool).await.expect("migrations apply");
        Some(pool)
    }

    async fn user(pool: &PgPool, prefix: &str) -> (i64, Claims) {
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let name = format!("{prefix}_{}", &tag[..10]);
        let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(&name)
            .bind(b"s".as_ref())
            .bind(b"v".as_ref())
            .fetch_one(pool)
            .await
            .expect("insert user");
        let claims = Claims { sub: id as i64, username: name, exp: 0, tv: 0, sst: 1_700_000_000, sid: format!("sid-{tag}"), ls: false };
        (id as i64, claims)
    }

    async fn body(r: Response) -> Value {
        let b = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&b).unwrap_or(Value::Null)
    }

    fn upd(v: Value) -> UpdateTaskRequest {
        serde_json::from_value(v).expect("update request")
    }

    fn create(v: Value) -> CreateTaskRequest {
        serde_json::from_value(v).expect("create request")
    }

    async fn patch(state: &Arc<AppState>, claims: &Claims, id: i64, v: Value) -> StatusCode {
        update_task(State(state.clone()), Path(id), Extension(claims.clone()), Json(upd(v)))
            .await
            .into_response()
            .status()
    }

    async fn add_list_task(state: &Arc<AppState>, claims: &Claims, list: i64, v: Value) -> (StatusCode, Value) {
        let r = create_list_task(State(state.clone()), Path(list), Extension(claims.clone()), Json(create(v)))
            .await
            .into_response();
        let st = r.status();
        (st, body(r).await)
    }

    async fn new_list(pool: &PgPool, owner: i64) -> i64 {
        let (id,): (i64,) = sqlx::query_as("INSERT INTO task_lists (owner_id, title) VALUES ($1, 'list') RETURNING id")
            .bind(owner)
            .fetch_one(pool)
            .await
            .expect("insert list");
        id
    }

    async fn row(pool: &PgPool, id: i64) -> (bool, Option<String>, Option<String>, Option<chrono::DateTime<chrono::Utc>>, Option<chrono::DateTime<chrono::Utc>>) {
        sqlx::query_as("SELECT is_completed, schedule, snooze, due_at, updated_at FROM channel_tasks WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("read task")
    }

    async fn list_stamp(pool: &PgPool, id: i64) -> Option<chrono::DateTime<chrono::Utc>> {
        let (u,): (Option<chrono::DateTime<chrono::Utc>>,) = sqlx::query_as("SELECT updated_at FROM task_lists WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("read list");
        u
    }

    /// Age a row's stamps so a later NOW() is distinguishable. The triggers
    /// keep updated_at on a non-edit, so the ageing write goes through a
    /// session that disables user triggers for exactly that statement.
    async fn age(pool: &PgPool, task: Option<i64>, list: Option<i64>) {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL session_replication_role = replica").execute(&mut *tx).await.unwrap();
        if let Some(t) = task {
            sqlx::query("UPDATE channel_tasks SET updated_at = NOW() - INTERVAL '1 day' WHERE id = $1")
                .bind(t)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        if let Some(l) = list {
            sqlx::query("UPDATE task_lists SET updated_at = NOW() - INTERVAL '1 day' WHERE id = $1")
                .bind(l)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
    }

    fn fresh(t: Option<chrono::DateTime<chrono::Utc>>) -> bool {
        t.map(|t| chrono::Utc::now() - t < chrono::Duration::hours(1)).unwrap_or(false)
    }

    #[tokio::test]
    async fn schedule_snooze_cas_guard_and_reopen_on_a_personal_list() {
        let Some(pool) = pool().await else { return };
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let (me, claims) = user(&pool, "tt_a").await;
        let list = new_list(&pool, me).await;

        // Create with a sealed schedule in ONE request; the response carries
        // the three new keys (the client's per-row feature signal).
        let (st, created) = add_list_task(&state, &claims, list, json!({
            "description": "{\"v\":2,\"t\":\"self\",\"ct\":\"ZXZlbnQ=\"}",
            "due_at": "2030-01-01T09:00:00Z",
            "schedule": S1,
        })).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(created["schedule"], S1);
        assert!(created.get("snooze").is_some() && created["snooze"].is_null(), "snooze key always present");
        assert!(created["updated_at"].as_str().is_some_and(|s| s.ends_with('Z')));
        let ev = created["id"].as_i64().unwrap();

        // Plaintext on create is refused, and nothing is inserted.
        let (st, _) = add_list_task(&state, &claims, list, json!({
            "description": "x", "schedule": "{\"v\":1,\"kind\":\"event\"}",
        })).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        // Three-state: absent keeps, value sets, "" clears.
        assert_eq!(patch(&state, &claims, ev, json!({ "is_completed": false })).await, StatusCode::OK);
        assert_eq!(row(&pool, ev).await.1.as_deref(), Some(S1));
        assert_eq!(patch(&state, &claims, ev, json!({ "schedule": S2 })).await, StatusCode::OK);
        assert_eq!(row(&pool, ev).await.1.as_deref(), Some(S2));
        assert_eq!(patch(&state, &claims, ev, json!({ "schedule": "not sealed" })).await, StatusCode::BAD_REQUEST);
        assert_eq!(patch(&state, &claims, ev, json!({ "snooze": "{\"k\":\"snooze/1\"}" })).await, StatusCode::BAD_REQUEST);
        let huge = format!(r#"{{"v":2,"t":"self","ct":"{}"}}"#, "A".repeat(super::MAX_SCHEDULE_LEN));
        assert_eq!(patch(&state, &claims, ev, json!({ "schedule": huge })).await, StatusCode::BAD_REQUEST);
        assert_eq!(row(&pool, ev).await.1.as_deref(), Some(S2), "refused writes leave the value alone");

        // Downgrade guard covers the schedule: v3 stored, v2 written by a
        // client that does not claim to read v3 → 409.
        let v3 = r#"{"v":3,"t":"ch","epoch":1,"ct":"djM="}"#;
        assert_eq!(patch(&state, &claims, ev, json!({ "schedule": v3 })).await, StatusCode::OK);
        assert_eq!(patch(&state, &claims, ev, json!({ "schedule": S1 })).await, StatusCode::CONFLICT);
        assert_eq!(patch(&state, &claims, ev, json!({ "schedule": S1, "reads_up_to": 4 })).await, StatusCode::OK);

        // Snooze sets and clears.
        assert_eq!(patch(&state, &claims, ev, json!({ "snooze": SNZ })).await, StatusCode::OK);
        assert_eq!(row(&pool, ev).await.2.as_deref(), Some(SNZ));

        // expect_due_at compare-and-swap: the loser gets 409 and writes NOTHING.
        assert_eq!(
            patch(&state, &claims, ev, json!({ "due_at": "2030-01-08T09:00:00Z", "expect_due_at": "2029-12-31T09:00:00Z", "snooze": "" })).await,
            StatusCode::CONFLICT
        );
        let r = row(&pool, ev).await;
        assert_eq!(r.3.unwrap().to_rfc3339(), "2030-01-01T09:00:00+00:00", "due_at untouched by the loser");
        assert_eq!(r.2.as_deref(), Some(SNZ), "and the snooze clear in the same PATCH did not land either");
        assert_eq!(
            patch(&state, &claims, ev, json!({ "due_at": "2030-01-08T09:00:00Z", "expect_due_at": "2030-01-01T09:00:00Z", "snooze": "" })).await,
            StatusCode::OK
        );
        let r = row(&pool, ev).await;
        assert_eq!(r.3.unwrap().to_rfc3339(), "2030-01-08T09:00:00+00:00");
        assert!(r.2.is_none());
        // "" = expect NULL.
        assert_eq!(patch(&state, &claims, ev, json!({ "due_at": "", "expect_due_at": "" })).await, StatusCode::CONFLICT);

        // Completing a scheduled item without recurrence_aware: 409, not done.
        assert_eq!(patch(&state, &claims, ev, json!({ "is_completed": true })).await, StatusCode::CONFLICT);
        assert!(!row(&pool, ev).await.0);

        // A NON-scheduled parent whose child is scheduled: the completion
        // sweep would reach the child, so an unaware client is refused too.
        let (_, parent) = add_list_task(&state, &claims, list, json!({ "description": "p" })).await;
        let parent = parent["id"].as_i64().unwrap();
        let (_, child) = add_list_task(&state, &claims, list, json!({ "description": "c", "parent_id": parent, "schedule": S1 })).await;
        let child = child["id"].as_i64().unwrap();
        let (_, plain_kid) = add_list_task(&state, &claims, list, json!({ "description": "k", "parent_id": child })).await;
        let plain_kid = plain_kid["id"].as_i64().unwrap();
        assert_eq!(patch(&state, &claims, parent, json!({ "is_completed": true })).await, StatusCode::CONFLICT);
        assert!(!row(&pool, child).await.0, "the scheduled child survived");
        // Positive control: a parent with NO scheduled descendant completes for
        // an unaware client exactly as before.
        let (_, lone) = add_list_task(&state, &claims, list, json!({ "description": "lone" })).await;
        let lone = lone["id"].as_i64().unwrap();
        let (_, lone_kid) = add_list_task(&state, &claims, list, json!({ "description": "lk", "parent_id": lone })).await;
        let lone_kid = lone_kid["id"].as_i64().unwrap();
        assert_eq!(patch(&state, &claims, lone, json!({ "is_completed": true })).await, StatusCode::OK);
        assert!(row(&pool, lone_kid).await.0, "old behaviour: the sweep completes the subtree");
        // An aware client completes the scheduled parent.
        assert_eq!(patch(&state, &claims, parent, json!({ "is_completed": true, "recurrence_aware": true })).await, StatusCode::OK);
        assert!(row(&pool, child).await.0 && row(&pool, plain_kid).await.0);

        // reopen_subtree: a repeating task advancing reopens what is under it
        // (and only that — the task itself is untouched by the reopen).
        assert_eq!(patch(&state, &claims, child, json!({ "reopen_subtree": true })).await, StatusCode::OK);
        assert!(!row(&pool, plain_kid).await.0, "the subtask is open again");
        assert!(row(&pool, child).await.0, "the reopen does not touch the task itself");

        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(me as i32).execute(&pool).await;
    }

    #[tokio::test]
    async fn updated_at_moves_on_edits_not_on_reorders_snoozes_or_derived_due() {
        let Some(pool) = pool().await else { return };
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let (me, claims) = user(&pool, "tt_b").await;
        let list = new_list(&pool, me).await;
        let (_, a) = add_list_task(&state, &claims, list, json!({ "description": "a" })).await;
        let (_, b) = add_list_task(&state, &claims, list, json!({ "description": "b" })).await;
        let (a, b) = (a["id"].as_i64().unwrap(), b["id"].as_i64().unwrap());
        assert!(fresh(list_stamp(&pool, list).await), "inserting an item touched the list");

        // A pure reorder is not an edit — of the task or of its list.
        age(&pool, Some(a), Some(list)).await;
        let r = reorder_task(State(state.clone()), Path(a), Extension(claims.clone()), Json(ReorderTaskRequest { after_id: Some(b), reparent: false, parent_id: None }))
            .await
            .into_response();
        assert_eq!(r.status(), StatusCode::OK);
        assert!(!fresh(row(&pool, a).await.4), "reorder left the task's updated_at alone");
        assert!(!fresh(list_stamp(&pool, list).await), "reorder left the list's updated_at alone");

        // A snooze is not an edit.
        assert_eq!(patch(&state, &claims, a, json!({ "snooze": SNZ })).await, StatusCode::OK);
        assert!(!fresh(row(&pool, a).await.4));

        // A description edit is — and it touches the list.
        assert_eq!(patch(&state, &claims, a, json!({ "description": "{\"v\":2,\"t\":\"self\",\"ct\":\"ZWRpdA==\"}" })).await, StatusCode::OK);
        assert!(fresh(row(&pool, a).await.4), "description edit stamps the task");
        assert!(fresh(list_stamp(&pool, list).await), "and the list");

        // On a SCHEDULED item, due_at moving alone is the reminder loop's
        // advance, not an edit; a schedule change is.
        assert_eq!(patch(&state, &claims, b, json!({ "schedule": S1, "due_at": "2030-01-01T09:00:00Z" })).await, StatusCode::OK);
        age(&pool, Some(b), Some(list)).await;
        assert_eq!(patch(&state, &claims, b, json!({ "due_at": "2030-01-08T09:00:00Z" })).await, StatusCode::OK);
        assert!(!fresh(row(&pool, b).await.4), "derived due_at advance is not an edit");
        assert!(!fresh(list_stamp(&pool, list).await));
        // Positive control on the same row: a schedule change IS an edit.
        assert_eq!(patch(&state, &claims, b, json!({ "schedule": S2 })).await, StatusCode::OK);
        assert!(fresh(row(&pool, b).await.4));

        // On a PLAIN task a due time is content.
        let (_, c) = add_list_task(&state, &claims, list, json!({ "description": "c" })).await;
        let c = c["id"].as_i64().unwrap();
        age(&pool, Some(c), None).await;
        assert_eq!(patch(&state, &claims, c, json!({ "due_at": "2030-01-01T09:00:00Z" })).await, StatusCode::OK);
        assert!(fresh(row(&pool, c).await.4));
        // … but a SNOOZE that moves a plain task's due_at to the snooze
        // instant (and an unsnooze moving it back) is not an edit.
        age(&pool, Some(c), Some(list)).await;
        assert_eq!(patch(&state, &claims, c, json!({ "snooze": SNZ, "due_at": "2030-01-01T10:00:00Z", "expect_due_at": "2030-01-01T09:00:00Z" })).await, StatusCode::OK);
        assert_eq!(row(&pool, c).await.3.unwrap().to_rfc3339(), "2030-01-01T10:00:00+00:00", "the snooze moved due_at");
        assert!(!fresh(row(&pool, c).await.4), "a snooze moving due_at is not an edit");
        assert!(!fresh(list_stamp(&pool, list).await));
        assert_eq!(patch(&state, &claims, c, json!({ "snooze": "", "due_at": "2030-01-01T09:00:00Z" })).await, StatusCode::OK);
        assert!(!fresh(row(&pool, c).await.4), "nor is the unsnooze moving it back");
        // Positive control on the same row: due_at alone moving is still an edit.
        assert_eq!(patch(&state, &claims, c, json!({ "due_at": "2030-01-02T09:00:00Z" })).await, StatusCode::OK);
        assert!(fresh(row(&pool, c).await.4));

        // Deleting an item touches the list.
        age(&pool, None, Some(list)).await;
        sqlx::query("DELETE FROM channel_tasks WHERE id = $1").bind(c).execute(&pool).await.unwrap();
        assert!(fresh(list_stamp(&pool, list).await), "delete touched the list");

        // The list responses carry updated_at; deleting a whole list with
        // items in it still works with the AFTER DELETE trigger in place.
        let lists = body(list_task_lists(State(state.clone()), Extension(claims.clone()), Query(TaskListsQuery::default())).await.into_response()).await;
        assert!(lists[0]["updated_at"].as_str().is_some_and(|s| s.ends_with('Z')), "{lists}");
        let tasks = body(list_list_tasks(State(state.clone()), Path(list), Extension(claims.clone())).await.into_response()).await;
        assert!(tasks.as_array().unwrap().iter().all(|t| t.get("schedule").is_some() && t.get("updated_at").is_some()));
        sqlx::query("DELETE FROM task_lists WHERE id = $1").bind(list).execute(&pool).await.expect("list delete cascades");

        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(me as i32).execute(&pool).await;
    }

    #[tokio::test]
    async fn channel_edit_rights_for_schedule_and_snooze() {
        let Some(pool) = pool().await else { return };
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let (owner, owner_claims) = user(&pool, "tt_o").await;
        let (member, member_claims) = user(&pool, "tt_m").await;
        let server_id = format!("srv-{}", uuid::Uuid::new_v4().simple());
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'timing', $2)")
            .bind(&server_id).bind(owner as i32).execute(&pool).await.unwrap();
        for u in [owner, member] {
            sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
                .bind(&server_id).bind(u as i32).execute(&pool).await.unwrap();
        }
        let (role,): (i64,) = sqlx::query_as("INSERT INTO server_roles (server_id, name, permissions, is_default) VALUES ($1, '@everyone', $2, TRUE) RETURNING id")
            .bind(&server_id)
            .bind(crate::permissions::Permissions::DEFAULT_MEMBER.bits() as i64)
            .fetch_one(&pool).await.unwrap();
        let (channel,): (i32,) = sqlx::query_as("INSERT INTO channels (name, server_id, has_checklist) VALUES ('todo', $1, TRUE) RETURNING id")
            .bind(&server_id).fetch_one(&pool).await.unwrap();
        let ch = r#"{"v":3,"t":"ch","epoch":1,"ct":"aXRlbQ=="}"#;
        let r = create_task(State(state.clone()), Path(channel as i64), Extension(owner_claims.clone()), Json(create(json!({ "description": ch, "schedule": ch }))))
            .await.into_response();
        assert_eq!(r.status(), StatusCode::OK);
        let task = body(r).await["id"].as_i64().unwrap();

        // A member (COMPLETE, no MANAGE) may snooze someone else's item …
        assert_eq!(patch(&state, &member_claims, task, json!({ "snooze": ch })).await, StatusCode::OK);
        // … but not change its schedule (creator or MANAGE_TASKS).
        assert_eq!(patch(&state, &member_claims, task, json!({ "schedule": "" })).await, StatusCode::FORBIDDEN);
        assert!(row(&pool, task).await.1.is_some());
        // The creator may.
        assert_eq!(patch(&state, &owner_claims, task, json!({ "schedule": ch })).await, StatusCode::OK);
        // … but never with an unbound (v2) or self envelope: a shared item's
        // timing is v3-only, on create and on edit, schedule and snooze alike.
        let v2 = r#"{"v":2,"t":"ch","epoch":1,"ct":"bGlmdGVk"}"#;
        for body_ in [json!({ "schedule": v2 }), json!({ "snooze": v2 }), json!({ "schedule": S1, "reads_up_to": 4 })] {
            assert_eq!(patch(&state, &owner_claims, task, body_).await, StatusCode::BAD_REQUEST);
        }
        assert_eq!(row(&pool, task).await.1.as_deref(), Some(ch), "a refused v2 write leaves the v3 value alone");
        let r = create_task(State(state.clone()), Path(channel as i64), Extension(owner_claims.clone()), Json(create(json!({ "description": ch, "schedule": v2 }))))
            .await.into_response();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        // Without COMPLETE_TASKS a snooze and a reopen are refused.
        sqlx::query("UPDATE server_roles SET permissions = $1 WHERE id = $2")
            .bind(crate::permissions::Permissions::VIEW_CHANNEL.bits() as i64).bind(role)
            .execute(&pool).await.unwrap();
        assert_eq!(patch(&state, &member_claims, task, json!({ "snooze": "" })).await, StatusCode::FORBIDDEN);
        assert_eq!(patch(&state, &member_claims, task, json!({ "reopen_subtree": true })).await, StatusCode::FORBIDDEN);

        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&server_id).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1 OR id = $2").bind(owner as i32).bind(member as i32).execute(&pool).await;
    }

    #[tokio::test]
    async fn the_reminder_feed_carries_sealed_timing_and_future_items_are_never_starved() {
        let Some(pool) = pool().await else { return };
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let (me, claims) = user(&pool, "tt_r").await;
        let list = new_list(&pool, me).await;
        // 450 stale past reminders nobody ticked, then ONE future one.
        sqlx::query(
            "INSERT INTO channel_tasks (list_id, description, created_by, position, due_at) \
             SELECT $1, 'x', $2, g, NOW() - (g || ' hours')::interval FROM generate_series(1, 450) g",
        )
        .bind(list).bind(me).execute(&pool).await.unwrap();
        let (_, fut) = add_list_task(&state, &claims, list, json!({
            "description": "future", "due_at": "2031-01-01T09:00:00Z", "schedule": S1,
        })).await;
        let fut = fut["id"].as_i64().unwrap();
        assert_eq!(patch(&state, &claims, fut, json!({ "snooze": SNZ })).await, StatusCode::OK);

        let feed = body(list_task_reminders(State(state.clone()), Extension(claims.clone())).await.into_response()).await;
        let rows = feed.as_array().unwrap();
        let f = rows.iter().find(|r| r["id"].as_i64() == Some(fut)).expect("the future reminder is in the feed");
        assert_eq!(f["schedule"], S1);
        assert_eq!(f["snooze"], SNZ);
        assert_eq!(f["created_by"].as_i64(), Some(me));
        let past = rows.iter().filter(|r| r["id"].as_i64() != Some(fut)).count();
        assert_eq!(past, 100, "only the newest overdue items are kept");
        // Sorted ascending overall, as before.
        let times: Vec<&str> = rows.iter().map(|r| r["due_at"].as_str().unwrap()).collect();
        let mut sorted = times.clone();
        sorted.sort();
        assert_eq!(times, sorted);

        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(me as i32).execute(&pool).await;
    }
}
