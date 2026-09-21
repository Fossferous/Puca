//! Púca Notes' list content: a personal list's free-text body, its own
//! attachments (photos and drawings), and the trash.
//!
//! A Notes "note" is a personal task list (task_handlers.rs). Migration 065
//! gives the list three nullable columns:
//!
//! - `body` — the note's paragraph text, sealed to the owner (an
//!   encrypt-to-self envelope, like the title). The server stores the
//!   envelope and never anything else: `check_sealed_field` refuses a
//!   non-envelope value, so a client bug cannot put plaintext here either.
//! - `attachments` — the same sealed sidecar a task carries (032), for the
//!   note itself rather than one item.
//! - `trashed_at` — set by `POST /task-lists/:id/trash`, cleared by
//!   `/restore`. A trashed list is hidden from the default listing and the
//!   reminder feed, refuses every write with 409 (`TRASHED_MESSAGE`) until it
//!   is restored, and is deleted for good by the six-hourly sweep once it has
//!   been in the trash longer than `NOTES_TRASH_RETENTION_DAYS` (default 30;
//!   0 keeps it forever). `DELETE /task-lists/:id` stays the immediate,
//!   permanent delete — which is also what every client older than the trash
//!   still calls, so nothing an old client does changes meaning.
//!
//! WHAT THE PURGE CANNOT DO. The files behind a note's photos, drawings and
//! item attachments are named only inside sealed sidecars, so the server
//! cannot tell which uploads a purged list referenced. Clients delete them
//! (`DELETE /files/:id`) when the user empties the trash, and Púca Notes also
//! purges its own expired trash, files first, during the last day of the
//! window whenever it is open. A note whose window runs out while no client
//! is open loses its rows here and leaves its uploads behind, counted against
//! the owner's quota as every hard delete always has (docs/NOTES.md).
//!
//! `GET /task-lists/features` is how a client knows any of this exists. It
//! does not depend on the account having lists, and an older server answers
//! it with an error (the path falls through to `/task-lists/:list_id`, which
//! has no GET), which a client reads as "none of it".

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use serde::Serialize;
use sqlx::PgPool;
use std::sync::Arc;

use crate::auth::Claims;
use crate::state::AppState;

/// Ceiling on a sealed body, in bytes of envelope (so a little under 48 KiB
/// of text after base64 and the envelope's own fields). The listing returns
/// every body, so this is also the per-list share of that response.
pub const MAX_LIST_BODY_LEN: usize = 65536;
/// Same ceiling as a task's sidecar (task_handlers::MAX_ATTACHMENTS_LEN).
pub const MAX_LIST_ATTACHMENTS_LEN: usize = 16384;
pub const NOTES_TRASH_RETENTION_DAYS_DEFAULT: i64 = 30;
/// The 409 every write into a trashed list gets.
pub const TRASHED_MESSAGE: &str = "This note is in the trash — restore it to change it";

/// The trash window in days, or None when the operator keeps trash forever.
pub fn trash_retention_days() -> Option<i64> {
    crate::retention::retention_days("NOTES_TRASH_RETENTION_DAYS", NOTES_TRASH_RETENTION_DAYS_DEFAULT)
}

/// Validate one sealed list field from a request. `None` (absent) and
/// `Some("")` (clear) always pass; anything else must be within `max`, free of
/// NUL, and an envelope — this column never held plaintext, so there is no
/// legacy value to be compatible with, and refusing here keeps it that way.
pub fn check_sealed_field(
    value: Option<&str>,
    max: usize,
    too_large: (StatusCode, &'static str),
) -> Result<(), (StatusCode, &'static str)> {
    let Some(v) = value else { return Ok(()) };
    if v.is_empty() {
        return Ok(());
    }
    if v.len() > max {
        return Err(too_large);
    }
    if v.contains('\0') {
        return Err((StatusCode::BAD_REQUEST, "Note content contains invalid characters"));
    }
    if crate::envelope_version::envelope_version(v).is_none() {
        return Err((StatusCode::BAD_REQUEST, "Note content must be end-to-end encrypted"));
    }
    Ok(())
}

pub fn check_body(value: Option<&str>) -> Result<(), (StatusCode, &'static str)> {
    check_sealed_field(value, MAX_LIST_BODY_LEN, (StatusCode::PAYLOAD_TOO_LARGE, "Note text too long"))
}

pub fn check_attachments(value: Option<&str>) -> Result<(), (StatusCode, &'static str)> {
    check_sealed_field(value, MAX_LIST_ATTACHMENTS_LEN, (StatusCode::BAD_REQUEST, "Attachments too large"))
}

#[derive(Serialize)]
pub struct ListFeatures {
    /// `body` is accepted on create/PATCH and returned by the listing.
    pub body: bool,
    /// `attachments` likewise.
    pub attachments: bool,
    /// `/trash`, `/restore` and `?trashed=true` exist.
    pub trash: bool,
    /// The purge window; 0 = the operator keeps trash forever.
    pub trash_retention_days: i64,
    pub max_body_len: usize,
    /// The server's clock (Unix ms) when it answered. A client that purges its
    /// own expired trash measures "expired" against THIS, never its own clock:
    /// a phone whose clock runs days ahead would otherwise delete the owner's
    /// trash early, with no undo. A client that cannot read it does not purge.
    pub server_now_ms: i64,
    /// Migration 069: every list row carries `content_rev`, and PATCH
    /// /task-lists/:id honours `expect_rev` — so a save that lost a race with
    /// another device is refused with the current copy instead of quietly
    /// overwriting it. An older server omits the key, which the client reads
    /// as false and keeps today's last-write-wins behaviour.
    pub content_rev: bool,
    /// Migration 070: POST /task-lists and the task create routes accept a
    /// random `op_key`, so a create whose answer was lost is not made twice.
    pub idempotent_creates: bool,
}

/// What the features route says, for a given trash window (None = forever)
/// and server time — pure, so a test can pin every field.
pub fn features_for(retention_days: Option<i64>, now_ms: i64) -> ListFeatures {
    ListFeatures {
        body: true,
        attachments: true,
        trash: true,
        trash_retention_days: retention_days.unwrap_or(0),
        max_body_len: MAX_LIST_BODY_LEN,
        server_now_ms: now_ms,
        content_rev: true,
        idempotent_creates: true,
    }
}

/// GET /task-lists/features
pub async fn list_features(Extension(_claims): Extension<Claims>) -> impl IntoResponse {
    Json(features_for(trash_retention_days(), chrono::Utc::now().timestamp_millis()))
}

#[derive(Serialize)]
pub struct TrashedResponse {
    pub trashed_at: Option<String>,
}

/// POST /task-lists/:id/trash — move one of the caller's lists to the trash.
/// Idempotent: trashing a trashed list keeps the ORIGINAL time, so repeating
/// the request can never extend (or restart) the purge window. The "Notes to
/// self" list is refused: get_self_checklist would hand a trashed list back to
/// the self-DM, where it could not be written.
pub async fn trash_list(
    State(state): State<Arc<AppState>>,
    Path(list_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let row: Result<Option<(i64, bool)>, _> =
        sqlx::query_as("SELECT owner_id, is_self FROM task_lists WHERE id = $1")
            .bind(list_id)
            .fetch_optional(&state.pool)
            .await;
    match row {
        Ok(Some((owner, _))) if owner != claims.sub => {
            return (StatusCode::NOT_FOUND, "List not found").into_response()
        }
        Ok(Some((_, true))) => {
            return (StatusCode::BAD_REQUEST, "Notes to self can't be moved to the trash").into_response()
        }
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::NOT_FOUND, "List not found").into_response(),
        Err(e) => {
            tracing::error!("trash_list: lookup failed: {e:?}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move to the trash").into_response();
        }
    }
    let at: Result<Option<(String,)>, _> = sqlx::query_as(
        "UPDATE task_lists SET trashed_at = COALESCE(trashed_at, NOW()) \
         WHERE id = $1 AND owner_id = $2 AND NOT is_self \
         RETURNING (replace((trashed_at AT TIME ZONE 'UTC')::text, ' ', 'T') || 'Z')",
    )
    .bind(list_id)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await;
    match at {
        Ok(Some((t,))) => Json(TrashedResponse { trashed_at: Some(t) }).into_response(),
        // Deleted between the two statements.
        Ok(None) => (StatusCode::NOT_FOUND, "List not found").into_response(),
        Err(e) => {
            tracing::error!("trash_list: update failed: {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to move to the trash").into_response()
        }
    }
}

/// POST /task-lists/:id/restore — take one of the caller's lists out of the
/// trash. Restoring a live list is a no-op 200 (a second device's Undo).
pub async fn restore_list(
    State(state): State<Arc<AppState>>,
    Path(list_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    let done = sqlx::query("UPDATE task_lists SET trashed_at = NULL WHERE id = $1 AND owner_id = $2")
        .bind(list_id)
        .bind(claims.sub)
        .execute(&state.pool)
        .await;
    match done {
        Ok(r) if r.rows_affected() == 1 => Json(TrashedResponse { trashed_at: None }).into_response(),
        // Someone else's list and a missing one answer alike (check_list_owner).
        Ok(_) => (StatusCode::NOT_FOUND, "List not found").into_response(),
        Err(e) => {
            tracing::error!("restore_list: update failed: {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to restore").into_response()
        }
    }
}

/// Delete every list trashed more than `days` ago (its tasks cascade), and
/// the owners' tab-pref rows that named it — Púca's tab bar ignores a stale
/// row, but there is no reason to keep one for a list that cannot return.
/// Returns (lists, pref rows) deleted. Errors are logged, never raised: the
/// sweep runs again in six hours.
pub async fn purge_expired_trash(pool: &PgPool, days: i64) -> (i64, i64) {
    let r: Result<(i64, i64), _> = sqlx::query_as(
        "WITH gone AS ( \
             DELETE FROM task_lists \
             WHERE trashed_at IS NOT NULL AND trashed_at < NOW() - make_interval(days => $1::int) \
             RETURNING id, owner_id \
         ), prefs AS ( \
             DELETE FROM task_tab_prefs p USING gone \
             WHERE p.kind = 'list' AND p.ref_id = gone.id AND p.user_id = gone.owner_id \
             RETURNING 1 \
         ) \
         SELECT (SELECT COUNT(*) FROM gone), (SELECT COUNT(*) FROM prefs)",
    )
    .bind(days as i32)
    .fetch_one(pool)
    .await;
    match r {
        Ok((lists, prefs)) => {
            if lists > 0 {
                tracing::info!("notes trash: purged {lists} list(s) older than {days} days");
            }
            (lists, prefs)
        }
        Err(e) => {
            tracing::error!("notes trash purge failed: {e:?}");
            (0, 0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENV: &str = r#"{"v":2,"t":"self","ct":"AAAA","n":"BBBB"}"#;

    #[test]
    fn sealed_fields_must_be_envelopes_within_the_cap() {
        assert!(check_body(None).is_ok(), "absent: leave alone");
        assert!(check_body(Some("")).is_ok(), "empty: clear");
        assert!(check_body(Some(ENV)).is_ok());
        assert_eq!(check_body(Some("my shopping list")).unwrap_err().0, StatusCode::BAD_REQUEST, "plaintext is refused");
        assert_eq!(check_body(Some("{\"v\":2,\"t\":\"self\"}")).unwrap_err().0, StatusCode::BAD_REQUEST, "no ct: not an envelope");
        let nul = ENV.replace("AAAA", "AA\0A");
        assert_eq!(check_body(Some(&nul)).unwrap_err().0, StatusCode::BAD_REQUEST);
        let big = format!(r#"{{"v":2,"t":"self","ct":"{}"}}"#, "A".repeat(MAX_LIST_BODY_LEN));
        assert_eq!(check_body(Some(&big)).unwrap_err().0, StatusCode::PAYLOAD_TOO_LARGE);
        let fits = format!(r#"{{"v":2,"t":"self","ct":"{}"}}"#, "A".repeat(MAX_LIST_BODY_LEN - 30));
        assert!(fits.len() <= MAX_LIST_BODY_LEN && check_body(Some(&fits)).is_ok(), "positive control: just under the cap passes");
        let big_att = format!(r#"{{"v":2,"t":"self","ct":"{}"}}"#, "A".repeat(MAX_LIST_ATTACHMENTS_LEN));
        assert_eq!(check_attachments(Some(&big_att)).unwrap_err().0, StatusCode::BAD_REQUEST);
        assert!(check_attachments(Some(ENV)).is_ok());
    }

    #[test]
    fn the_trash_window_defaults_to_thirty_days_and_zero_keeps_forever() {
        // One test owns the variable (tests run in parallel in one process).
        std::env::remove_var("NOTES_TRASH_RETENTION_DAYS");
        assert_eq!(trash_retention_days(), Some(30));
        std::env::set_var("NOTES_TRASH_RETENTION_DAYS", "0");
        assert_eq!(trash_retention_days(), None);
        std::env::set_var("NOTES_TRASH_RETENTION_DAYS", "7");
        assert_eq!(trash_retention_days(), Some(7));
        std::env::set_var("NOTES_TRASH_RETENTION_DAYS", "-1");
        assert_eq!(trash_retention_days(), Some(30), "garbage is the default, never prune-all");
        std::env::remove_var("NOTES_TRASH_RETENTION_DAYS");
    }
}

/// The handlers against a real database: TEST_DATABASE_URL ONLY (skipped,
/// with a printed line, without it). Never DATABASE_URL: these tests migrate
/// the database, run the trash sweep (which purges expired trash for EVERY
/// account in it) and create scratch rows, so a plain `cargo test` in a
/// checkout configured for a dev database must not reach it
/// (migrator::test_database_url).
#[cfg(test)]
mod db_tests {
    use super::*;
    use crate::state::UserId;
    use crate::task_handlers::{self as th, TaskListRequest, TaskListsQuery};
    use axum::extract::Query;
    use axum::response::Response;
    use serde_json::Value;

    const V2: &str = r#"{"v":2,"t":"self","ct":"AAAA","n":"BBBB"}"#;
    const V2B: &str = r#"{"v":2,"t":"self","ct":"CCCC","n":"DDDD"}"#;
    const V3: &str = r#"{"v":3,"t":"self","ct":"EEEE","n":"FFFF"}"#;

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
        let name = format!("lc_{tag}_{}", uuid::Uuid::new_v4().simple());
        let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(&name).bind(b"s".as_ref()).bind(b"v".as_ref())
            .fetch_one(pool).await.expect("insert user");
        Claims { sub: id as UserId, username: name, exp: 0, tv: 0, sst: 1_700_000_000, sid: String::new() }
    }

    async fn json_of(r: Response) -> Value {
        let b = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&b).unwrap_or(Value::Null)
    }

    fn req(title: Option<&str>, body: Option<&str>, attachments: Option<&str>, reads_up_to: Option<u64>) -> TaskListRequest {
        TaskListRequest {
            title: title.map(String::from),
            body: body.map(String::from),
            attachments: attachments.map(String::from),
            reads_up_to,
            expect_rev: None,
            op_key: None,
        }
    }

    /// The same, naming the content revision this edit is based on
    /// (migration 069).
    fn req_at(rev: i64, title: Option<&str>, body: Option<&str>, attachments: Option<&str>) -> TaskListRequest {
        TaskListRequest { expect_rev: Some(rev), ..req(title, body, attachments, None) }
    }

    /// A PATCH with its response body, so a test can read the new revision
    /// (or the 409's copy of the current one).
    async fn patch_json(state: &Arc<AppState>, c: &Claims, id: i64, r: TaskListRequest) -> (StatusCode, Value) {
        let resp = th::rename_task_list(State(state.clone()), Path(id), Extension(c.clone()), Json(r)).await.into_response();
        let status = resp.status();
        (status, json_of(resp).await)
    }

    /// One list row's content revision, as the listing serves it.
    async fn rev_of(state: &Arc<AppState>, c: &Claims, id: i64) -> i64 {
        listing(state, c, false).await.iter()
            .find(|r| r["id"] == id)
            .and_then(|r| r["content_rev"].as_i64())
            .expect("content_rev on every listed row")
    }

    /// content_rev straight from the row, for a list the listing hides
    /// (one in the trash).
    async fn rev_row(pool: &PgPool, id: i64) -> i64 {
        let (rev,): (i64,) = sqlx::query_as("SELECT content_rev FROM task_lists WHERE id = $1").bind(id).fetch_one(pool).await.unwrap();
        rev
    }

    async fn create(state: &Arc<AppState>, c: &Claims, title: &str, body: Option<&str>) -> i64 {
        let r = th::create_task_list(State(state.clone()), Extension(c.clone()), Json(req(Some(title), body, None, None))).await.into_response();
        assert_eq!(r.status(), StatusCode::OK, "create list");
        json_of(r).await["id"].as_i64().unwrap()
    }

    async fn listing(state: &Arc<AppState>, c: &Claims, trashed: bool) -> Vec<Value> {
        let r = th::list_task_lists(State(state.clone()), Extension(c.clone()), Query(TaskListsQuery { trashed: Some(trashed) })).await.into_response();
        assert_eq!(r.status(), StatusCode::OK);
        json_of(r).await.as_array().cloned().unwrap_or_default()
    }

    async fn patch(state: &Arc<AppState>, c: &Claims, id: i64, r: TaskListRequest) -> StatusCode {
        th::rename_task_list(State(state.clone()), Path(id), Extension(c.clone()), Json(r)).await.into_response().status()
    }

    async fn stored(pool: &PgPool, id: i64) -> (String, Option<String>, Option<String>) {
        sqlx::query_as("SELECT title, body, attachments FROM task_lists WHERE id = $1").bind(id).fetch_one(pool).await.unwrap()
    }

    #[tokio::test]
    async fn bodies_and_sidecars_are_sealed_capped_and_three_state() {
        let Some((state, pool)) = setup().await else { return };
        let alice = user(&pool, "body").await;

        // Create with a sealed body; the response and the listing carry it.
        let id = create(&state, &alice, V2, Some(V2)).await;
        let rows = listing(&state, &alice, false).await;
        let row = rows.iter().find(|r| r["id"] == id).expect("listed");
        assert_eq!(row["body"], V2);
        assert!(row["attachments"].is_null() && row["trashed_at"].is_null());

        // Plaintext is refused on create and on PATCH; the stored body is untouched.
        let r = th::create_task_list(State(state.clone()), Extension(alice.clone()), Json(req(Some(V2), Some("plain words"), None, None))).await.into_response();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        assert_eq!(patch(&state, &alice, id, req(None, Some("plain words"), None, None)).await, StatusCode::BAD_REQUEST);
        assert_eq!(patch(&state, &alice, id, req(None, None, Some("[{\"href\":\"x\"}]"), None)).await, StatusCode::BAD_REQUEST);
        // Over the cap: 413. NUL: 400.
        let big = format!(r#"{{"v":2,"t":"self","ct":"{}"}}"#, "A".repeat(MAX_LIST_BODY_LEN));
        assert_eq!(patch(&state, &alice, id, req(None, Some(&big), None, None)).await, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(patch(&state, &alice, id, req(None, Some(&V2B.replace("CCCC", "C\0C")), None, None)).await, StatusCode::BAD_REQUEST);
        assert_eq!(stored(&pool, id).await.1.as_deref(), Some(V2), "no refused write changed the row");

        // A body-only PATCH (no title) replaces the body and keeps the title.
        assert_eq!(patch(&state, &alice, id, req(None, Some(V2B), Some(V2), None)).await, StatusCode::OK);
        assert_eq!(stored(&pool, id).await, (V2.to_string(), Some(V2B.to_string()), Some(V2.to_string())));
        // A title-only PATCH — what every older client sends — keeps both.
        assert_eq!(patch(&state, &alice, id, req(Some(V2B), None, None, None)).await, StatusCode::OK);
        assert_eq!(stored(&pool, id).await, (V2B.to_string(), Some(V2B.to_string()), Some(V2.to_string())));
        // "" clears to NULL.
        assert_eq!(patch(&state, &alice, id, req(None, Some(""), Some(""), None)).await, StatusCode::OK);
        assert_eq!(stored(&pool, id).await, (V2B.to_string(), None, None));
        // An empty PATCH is a 400, not a silent no-op.
        assert_eq!(patch(&state, &alice, id, req(None, None, None, None)).await, StatusCode::BAD_REQUEST);

        // Downgrade: a v3 body, rewritten as v2 by a client that cannot read v3.
        sqlx::query("UPDATE task_lists SET body = $1 WHERE id = $2").bind(V3).bind(id).execute(&pool).await.unwrap();
        assert_eq!(patch(&state, &alice, id, req(None, Some(V2), None, None)).await, StatusCode::CONFLICT);
        assert_eq!(stored(&pool, id).await.1.as_deref(), Some(V3));
        // Positive control: the same write from a client that reads v3 goes through.
        assert_eq!(patch(&state, &alice, id, req(None, Some(V2), None, Some(3))).await, StatusCode::OK);

        // Somebody else's list: 404, and nothing written.
        let mallory = user(&pool, "mal").await;
        assert_eq!(patch(&state, &mallory, id, req(None, Some(V2B), None, None)).await, StatusCode::NOT_FOUND);
        assert_eq!(stored(&pool, id).await.1.as_deref(), Some(V2));

        let _ = sqlx::query("DELETE FROM task_lists WHERE owner_id = $1 OR owner_id = $2").bind(alice.sub).bind(mallory.sub).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1 OR id = $2").bind(alice.sub as i32).bind(mallory.sub as i32).execute(&pool).await;
    }

    /// Migration 069: a note's TEXT, TITLE and PICTURES carry a revision, and
    /// a save that names a stale one is refused with the current copy. What
    /// is NOT the note's own content leaves the revision alone — which is
    /// what keeps a ticked item from refusing a text save in the same note.
    #[tokio::test]
    async fn content_rev_guards_a_concurrent_edit_of_a_note() {
        let Some((state, pool)) = setup().await else { return };
        let alice = user(&pool, "rev").await;
        let id = create(&state, &alice, V2, Some(V2)).await;
        let rev0 = rev_of(&state, &alice, id).await;

        // A save that names the current revision goes through, and the answer
        // carries the new one (so a run of saves needs no refetch between).
        let (status, answer) = patch_json(&state, &alice, id, req_at(rev0, None, Some(V2B), None)).await;
        assert_eq!(status, StatusCode::OK);
        let rev1 = answer["content_rev"].as_i64().expect("the new revision comes back");
        assert_eq!(rev1, rev0 + 1);
        assert_eq!(rev_of(&state, &alice, id).await, rev1);

        // The other device still holds rev0: refused, with the current copy,
        // and NOTHING written.
        let (status, conflict) = patch_json(&state, &alice, id, req_at(rev0, None, Some(V3), None)).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(conflict["conflict"], "stale");
        assert_eq!(conflict["content_rev"].as_i64(), Some(rev1));
        assert_eq!(conflict["body"], V2B, "the 409 hands back the sealed body, so the loser can show both");
        assert_eq!(conflict["title"], V2);
        assert_eq!(stored(&pool, id).await.1.as_deref(), Some(V2B), "the loser wrote nothing");
        assert_eq!(rev_of(&state, &alice, id).await, rev1, "and did not move the revision");

        // Told the truth, the same save lands — the positive control for the
        // refusal above: it was the base that was wrong, not the write.
        assert_eq!(patch_json(&state, &alice, id, req_at(rev1, None, Some(V3), None)).await.0, StatusCode::OK);
        let rev2 = rev_of(&state, &alice, id).await;
        assert_eq!(rev2, rev1 + 1);

        // NO expect_rev = no check: every client older than 069, and every op
        // queued before it, keeps working exactly as it did.
        assert_eq!(patch(&state, &alice, id, req(None, Some(V2), None, Some(3))).await, StatusCode::OK);
        let rev3 = rev_of(&state, &alice, id).await;
        assert_eq!(rev3, rev2 + 1);

        // THE FALSE-POSITIVE TRAP, and the reason this is not expect_updated_at:
        // an ITEM added, ticked and deleted moves the list's updated_at (066's
        // puca_task_touch_list) but must NOT move content_rev — a note is one
        // card holding both its text and its items.
        let before_updated = list_updated_at(&pool, id).await;
        let item = th::create_list_task(
            State(state.clone()), Path(id), Extension(alice.clone()),
            Json(serde_json::from_value(serde_json::json!({"description": V2})).unwrap()),
        ).await.into_response();
        assert_eq!(item.status(), StatusCode::OK);
        let task_id = json_of(item).await["id"].as_i64().unwrap();
        assert_eq!(rev_of(&state, &alice, id).await, rev3, "adding an item is not editing the note's text");
        let upd = th::update_task(State(state.clone()), Path(task_id), Extension(alice.clone()),
            Json(serde_json::from_value(serde_json::json!({"is_completed": true})).unwrap())).await.into_response();
        assert_eq!(upd.status(), StatusCode::OK);
        assert_eq!(rev_of(&state, &alice, id).await, rev3, "ticking an item is not editing the note's text");
        let del = th::delete_task(State(state.clone()), Path(task_id), Extension(alice.clone())).await.into_response();
        assert_eq!(del.status(), StatusCode::NO_CONTENT);
        assert_eq!(rev_of(&state, &alice, id).await, rev3, "deleting an item is not editing the note's text");
        assert!(list_updated_at(&pool, id).await > before_updated, "updated_at DID move — which is why it cannot be the base");

        // Trash and restore are not content either: a restore must not
        // invalidate the base every other device is holding.
        let r = trash_list(State(state.clone()), Path(id), Extension(alice.clone())).await.into_response();
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(rev_row(&pool, id).await, rev3, "trashing is not an edit");
        let r = restore_list(State(state.clone()), Path(id), Extension(alice.clone())).await.into_response();
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(rev_of(&state, &alice, id).await, rev3, "restoring is not an edit");

        // The features route is how a client knows any of this is here.
        let f = features_for(None, 0);
        assert!(f.content_rev && f.idempotent_creates);

        let _ = sqlx::query("DELETE FROM task_lists WHERE owner_id = $1").bind(alice.sub).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(alice.sub as i32).execute(&pool).await;
    }

    async fn list_updated_at(pool: &PgPool, id: i64) -> Option<chrono::DateTime<chrono::Utc>> {
        let (u,): (Option<chrono::DateTime<chrono::Utc>>,) =
            sqlx::query_as("SELECT updated_at FROM task_lists WHERE id = $1").bind(id).fetch_one(pool).await.unwrap();
        u
    }

    #[tokio::test]
    async fn the_trash_hides_freezes_and_restores_a_list() {
        let Some((state, pool)) = setup().await else { return };
        let alice = user(&pool, "trash").await;
        let bob = user(&pool, "bob").await;
        let id = create(&state, &alice, V2, None).await;
        let keep = create(&state, &alice, V2B, None).await;
        // An item with a due time, so the reminder feed has something to lose.
        let item = th::create_list_task(
            State(state.clone()), Path(id), Extension(alice.clone()),
            Json(serde_json::from_value(serde_json::json!({"description": V2, "due_at": "2030-01-01T09:00:00Z"})).unwrap()),
        ).await.into_response();
        assert_eq!(item.status(), StatusCode::OK);
        let task_id = json_of(item).await["id"].as_i64().unwrap();
        let reminder_ids = |v: Value| v.as_array().unwrap().iter().map(|r| r["id"].as_i64().unwrap()).collect::<Vec<_>>();
        let reminders = th::list_task_reminders(State(state.clone()), Extension(alice.clone())).await.into_response();
        assert!(reminder_ids(json_of(reminders).await).contains(&task_id), "positive control: live list's item reminds");

        // Another account cannot trash it (and learns nothing: 404).
        let r = trash_list(State(state.clone()), Path(id), Extension(bob.clone())).await.into_response();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);

        // Trash it: gone from the listing and the feed, present in ?trashed=true.
        let r = trash_list(State(state.clone()), Path(id), Extension(alice.clone())).await.into_response();
        assert_eq!(r.status(), StatusCode::OK);
        let first = json_of(r).await["trashed_at"].as_str().unwrap().to_string();
        let live: Vec<i64> = listing(&state, &alice, false).await.iter().map(|r| r["id"].as_i64().unwrap()).collect();
        assert!(!live.contains(&id) && live.contains(&keep), "trashed hidden, the other list still listed");
        let trash = listing(&state, &alice, true).await;
        assert_eq!(trash.iter().map(|r| r["id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![id]);
        assert!(trash[0]["trashed_at"].is_string());
        let reminders = th::list_task_reminders(State(state.clone()), Extension(alice.clone())).await.into_response();
        assert!(!reminder_ids(json_of(reminders).await).contains(&task_id), "a trashed note must not remind");
        // Trashing again keeps the original time (the purge window cannot be restarted).
        let r = trash_list(State(state.clone()), Path(id), Extension(alice.clone())).await.into_response();
        assert_eq!(json_of(r).await["trashed_at"].as_str().unwrap(), first);

        // Every write into it is 409; reading it is fine.
        assert_eq!(patch(&state, &alice, id, req(Some(V2B), None, None, None)).await, StatusCode::CONFLICT);
        assert_eq!(patch(&state, &alice, id, req(None, Some(V2), None, None)).await, StatusCode::CONFLICT);
        let add = th::create_list_task(State(state.clone()), Path(id), Extension(alice.clone()),
            Json(serde_json::from_value(serde_json::json!({"description": V2})).unwrap())).await.into_response();
        assert_eq!(add.status(), StatusCode::CONFLICT);
        let upd = th::update_task(State(state.clone()), Path(task_id), Extension(alice.clone()),
            Json(serde_json::from_value(serde_json::json!({"is_completed": true})).unwrap())).await.into_response();
        assert_eq!(upd.status(), StatusCode::CONFLICT);
        let del = th::delete_task(State(state.clone()), Path(task_id), Extension(alice.clone())).await.into_response();
        assert_eq!(del.status(), StatusCode::CONFLICT);
        let read = th::list_list_tasks(State(state.clone()), Path(id), Extension(alice.clone())).await.into_response();
        assert_eq!(read.status(), StatusCode::OK, "the Trash view can still preview it");
        // Positive control: the same writes into the live list succeed.
        assert_eq!(patch(&state, &alice, keep, req(None, Some(V2), None, None)).await, StatusCode::OK);

        // Restore: back in the listing and the feed, and writable again.
        let r = restore_list(State(state.clone()), Path(id), Extension(bob.clone())).await.into_response();
        assert_eq!(r.status(), StatusCode::NOT_FOUND, "nobody else can restore it");
        let r = restore_list(State(state.clone()), Path(id), Extension(alice.clone())).await.into_response();
        assert_eq!(r.status(), StatusCode::OK);
        assert!(listing(&state, &alice, false).await.iter().any(|r| r["id"] == id));
        let reminders = th::list_task_reminders(State(state.clone()), Extension(alice.clone())).await.into_response();
        assert!(reminder_ids(json_of(reminders).await).contains(&task_id));
        assert_eq!(patch(&state, &alice, id, req(Some(V2B), None, None, None)).await, StatusCode::OK);

        // Notes to self cannot be trashed.
        let s = th::get_self_checklist(State(state.clone()), Extension(alice.clone())).await.into_response();
        let self_id = json_of(s).await["id"].as_i64().unwrap();
        let r = trash_list(State(state.clone()), Path(self_id), Extension(alice.clone())).await.into_response();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        // ...and the listing says which list that is, so a client can hide
        // "Move to trash" for it instead of offering a button that fails.
        let rows = listing(&state, &alice, false).await;
        let flag = |id: i64| rows.iter().find(|r| r["id"] == id).map(|r| r["is_self"].clone());
        assert_eq!(flag(self_id), Some(Value::Bool(true)), "the self list is flagged");
        assert_eq!(flag(keep), Some(Value::Bool(false)), "positive control: an ordinary list is not");

        // DELETE (Delete forever) still works on a trashed list.
        let _ = trash_list(State(state.clone()), Path(id), Extension(alice.clone())).await.into_response();
        let r = th::delete_task_list(State(state.clone()), Path(id), Extension(alice.clone())).await.into_response();
        assert_eq!(r.status(), StatusCode::NO_CONTENT);
        assert!(listing(&state, &alice, true).await.is_empty());

        let _ = sqlx::query("DELETE FROM task_lists WHERE owner_id = $1 OR owner_id = $2").bind(alice.sub).bind(bob.sub).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1 OR id = $2").bind(alice.sub as i32).bind(bob.sub as i32).execute(&pool).await;
    }

    #[tokio::test]
    async fn the_sweep_purges_only_lists_past_the_window() {
        let Some((state, pool)) = setup().await else { return };
        let alice = user(&pool, "sweep").await;
        let old = create(&state, &alice, V2, None).await;
        let young = create(&state, &alice, V2, None).await;
        let live = create(&state, &alice, V2, None).await;
        sqlx::query("UPDATE task_lists SET trashed_at = NOW() - make_interval(days => 31) WHERE id = $1").bind(old).execute(&pool).await.unwrap();
        sqlx::query("UPDATE task_lists SET trashed_at = NOW() - make_interval(days => 29) WHERE id = $1").bind(young).execute(&pool).await.unwrap();
        for id in [old, young, live] {
            sqlx::query("INSERT INTO task_tab_prefs (user_id, kind, ref_id, position, is_favorite) VALUES ($1, 'list', $2, $2, FALSE)")
                .bind(alice.sub).bind(id).execute(&pool).await.unwrap();
        }
        // Other accounts' expired trash may exist in a shared test database,
        // so assert on THIS account's rows, not on the returned counts.
        let (lists, _) = purge_expired_trash(&pool, 30).await;
        assert!(lists >= 1);
        let left: Vec<(i64,)> = sqlx::query_as("SELECT id FROM task_lists WHERE owner_id = $1 ORDER BY id").bind(alice.sub).fetch_all(&pool).await.unwrap();
        assert_eq!(left.into_iter().map(|r| r.0).collect::<Vec<_>>(), vec![young, live], "only the list past the window goes");
        let prefs: Vec<(i64,)> = sqlx::query_as("SELECT ref_id FROM task_tab_prefs WHERE user_id = $1 ORDER BY ref_id").bind(alice.sub).fetch_all(&pool).await.unwrap();
        assert_eq!(prefs.into_iter().map(|r| r.0).collect::<Vec<_>>(), vec![young, live], "its tab-pref row goes with it; the others stay");

        let _ = sqlx::query("DELETE FROM task_lists WHERE owner_id = $1").bind(alice.sub).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(alice.sub as i32).execute(&pool).await;
    }

    #[tokio::test]
    async fn the_features_route_announces_the_trash_window_and_the_server_clock() {
        // Every field, pinned, through the same serializer the route uses —
        // these names are the wire contract api/listContent.ts parses.
        let seven = serde_json::to_value(features_for(Some(7), 1_700_000_000_123)).unwrap();
        assert_eq!(
            seven,
            serde_json::json!({
                "body": true, "attachments": true, "trash": true,
                "trash_retention_days": 7, "max_body_len": MAX_LIST_BODY_LEN,
                "server_now_ms": 1_700_000_000_123_i64,
                "content_rev": true, "idempotent_creates": true,
            })
        );
        let forever = serde_json::to_value(features_for(None, 5)).unwrap();
        assert_eq!(forever["trash_retention_days"], 0, "None (keep forever) is announced as 0");

        // The route itself answers with the server's CURRENT clock, not a
        // constant: a client purges against it.
        let c = Claims { sub: 1, username: String::new(), exp: 0, tv: 0, sst: 0, sid: String::new() };
        let before = chrono::Utc::now().timestamp_millis();
        let r = list_features(Extension(c)).await.into_response();
        let after = chrono::Utc::now().timestamp_millis();
        assert_eq!(r.status(), StatusCode::OK);
        let v = json_of(r).await;
        let now = v["server_now_ms"].as_i64().expect("server_now_ms is an integer");
        assert!(before <= now && now <= after, "server_now_ms {now} not within [{before}, {after}]");
        assert_eq!(v["trash"], true);
        assert!(v["trash_retention_days"].as_i64().is_some_and(|d| d >= 0));
    }

    #[tokio::test]
    async fn the_export_carries_the_body_the_sidecar_and_the_trash_time() {
        let Some((state, pool)) = setup().await else { return };
        let alice = user(&pool, "exp").await;
        let id = create(&state, &alice, V2, Some(V2B)).await;
        assert_eq!(patch(&state, &alice, id, req(None, None, Some(V2), None)).await, StatusCode::OK);
        let _ = trash_list(State(state.clone()), Path(id), Extension(alice.clone())).await;
        let doc = crate::export_handlers::build_export(&pool, &alice).await.expect("export");
        let row = doc["task_lists"].as_array().unwrap().iter().find(|r| r["id"] == id).cloned().expect("the list is exported, trashed or not");
        assert_eq!(row["body"], V2B);
        assert_eq!(row["attachments"], V2);
        assert!(row["trashed_at"].is_string());

        let _ = sqlx::query("DELETE FROM task_lists WHERE owner_id = $1").bind(alice.sub).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(alice.sub as i32).execute(&pool).await;
    }
}
