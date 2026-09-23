//! `GET/PUT /sealed-blobs/:name` — one client-encrypted document per account
//! and name, with compare-and-swap on a revision number.
//!
//! WHAT IT IS FOR. Púca Notes keeps a note's colour, labels and archive flag
//! outside the task schema (docs/NOTES.md). Until this route they lived in one
//! browser's localStorage and died with a sign-out; now the client seals them
//! to itself (`frontend/src/api/sealedBlobs.ts`, its own HKDF key and AAD) and
//! parks the ciphertext here, so they follow the account.
//!
//! WHAT THE SERVER LEARNS. The blob is opaque ciphertext. The server sees its
//! size, when it was written and how often — the same class of metadata it has
//! for every other sealed row (docs/SECURITY_MODEL.md). The blob is never
//! logged, not even its length.
//!
//! COMPARE-AND-SWAP. Two devices edit the same document. A PUT names the
//! revision it was built on; the write lands only if that is still the
//! current one, and a mismatch answers 409 WITH the current `{rev, blob}` so
//! the client can re-apply its change to the newer state and retry — a
//! lossless merge without an operation log. `expected_rev: 0` means "there is
//! no document yet" and only ever inserts.
//!
//! CAPABILITY DETECTION. An absent document is `200 {"rev":0,"blob":null}`,
//! never a 404: a 404 is what a backend WITHOUT this route answers, and the
//! client must be able to tell "old server, stay local" from "no blob yet"
//! without depending on a row existing.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

use crate::auth::Claims;
use crate::state::AppState;

/// The names a client may store. A whitelist, so the table cannot become a
/// general-purpose per-user file store by accident.
pub const SEALED_BLOB_NAMES: &[&str] = &["notes-prefs"];

/// Ceiling on the stored ciphertext. A few hundred labelled notes seal to
/// tens of KiB; this leaves room for a big account while keeping one row
/// small. The client checks the same number before it sends
/// (`MAX_SEALED_BLOB_BYTES` in sealedBlobs.ts) and tells the user on a 413.
pub const MAX_SEALED_BLOB_BYTES: usize = 256 * 1024;
/// The request body around the blob (`{"expected_rev":…,"blob":"…"}`).
/// Checked on the RAW body, before any JSON parsing.
pub const MAX_SEALED_BLOB_BODY: usize = MAX_SEALED_BLOB_BYTES + 1024;

#[derive(Debug, Deserialize)]
pub struct PutSealedBlobRequest {
    pub expected_rev: i64,
    pub blob: String,
}

fn name_allowed(name: &str) -> bool {
    SEALED_BLOB_NAMES.contains(&name)
}

/// Why a PUT body is refused, before anything touches the database. Pure, so
/// the order of the checks (size first, then parse) is testable.
pub(crate) fn validate_put(body: &[u8]) -> Result<PutSealedBlobRequest, (StatusCode, &'static str)> {
    if body.len() > MAX_SEALED_BLOB_BODY {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "Sealed blob too large"));
    }
    let req: PutSealedBlobRequest = serde_json::from_slice(body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "Body must be {expected_rev, blob}"))?;
    if req.expected_rev < 0 {
        return Err((StatusCode::BAD_REQUEST, "expected_rev must be >= 0"));
    }
    if req.blob.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "blob must not be empty"));
    }
    if req.blob.len() > MAX_SEALED_BLOB_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "Sealed blob too large"));
    }
    if req.blob.contains('\0') {
        return Err((StatusCode::BAD_REQUEST, "blob must not contain NUL"));
    }
    Ok(req)
}

async fn current(pool: &sqlx::PgPool, user_id: i64, name: &str) -> Result<Option<(i64, String)>, sqlx::Error> {
    sqlx::query_as("SELECT rev, blob FROM user_sealed_blobs WHERE user_id = $1 AND name = $2")
        .bind(user_id)
        .bind(name)
        .fetch_optional(pool)
        .await
}

pub async fn get_sealed_blob(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Extension(claims): Extension<Claims>,
) -> Response {
    if !name_allowed(&name) {
        return (StatusCode::BAD_REQUEST, "Unknown blob name").into_response();
    }
    match current(&state.pool, claims.sub, &name).await {
        Ok(Some((rev, blob))) => Json(json!({ "rev": rev, "blob": blob })).into_response(),
        Ok(None) => Json(json!({ "rev": 0, "blob": null })).into_response(),
        Err(e) => {
            tracing::error!("sealed blob read failed for user {}: {:?}", claims.sub, e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to read").into_response()
        }
    }
}

pub async fn put_sealed_blob(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Extension(claims): Extension<Claims>,
    body: Bytes,
) -> Response {
    if !name_allowed(&name) {
        return (StatusCode::BAD_REQUEST, "Unknown blob name").into_response();
    }
    let req = match validate_put(&body) {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };
    match cas_write(&state.pool, claims.sub, &name, req.expected_rev, &req.blob).await {
        Ok(CasOutcome::Written(rev)) => Json(json!({ "rev": rev })).into_response(),
        Ok(CasOutcome::Conflict(cur)) => {
            let (rev, blob) = match cur {
                Some((r, b)) => (r, Some(b)),
                None => (0, None),
            };
            (StatusCode::CONFLICT, Json(json!({ "rev": rev, "blob": blob }))).into_response()
        }
        Err(e) => {
            tracing::error!("sealed blob write failed for user {}: {:?}", claims.sub, e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save").into_response()
        }
    }
}

#[derive(Debug, PartialEq)]
pub(crate) enum CasOutcome {
    /// The new revision.
    Written(i64),
    /// The revision named was not the current one; this is what is.
    Conflict(Option<(i64, String)>),
}

/// The compare-and-swap itself. `expected_rev == 0` inserts (and conflicts if
/// a row appeared meanwhile); anything else updates only that exact revision.
pub(crate) async fn cas_write(
    pool: &sqlx::PgPool,
    user_id: i64,
    name: &str,
    expected_rev: i64,
    blob: &str,
) -> Result<CasOutcome, sqlx::Error> {
    let written: Option<(i64,)> = if expected_rev == 0 {
        sqlx::query_as(
            "INSERT INTO user_sealed_blobs (user_id, name, rev, blob) VALUES ($1, $2, 1, $3) \
             ON CONFLICT (user_id, name) DO NOTHING RETURNING rev",
        )
        .bind(user_id)
        .bind(name)
        .bind(blob)
        .fetch_optional(pool)
        .await?
    } else {
        sqlx::query_as(
            "UPDATE user_sealed_blobs SET rev = rev + 1, blob = $4, updated_at = NOW() \
             WHERE user_id = $1 AND name = $2 AND rev = $3 RETURNING rev",
        )
        .bind(user_id)
        .bind(name)
        .bind(expected_rev)
        .bind(blob)
        .fetch_optional(pool)
        .await?
    };
    match written {
        Some((rev,)) => Ok(CasOutcome::Written(rev)),
        None => Ok(CasOutcome::Conflict(current(pool, user_id, name).await?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_size_cap_is_checked_before_the_body_is_parsed() {
        // Not JSON at all, and too big: the answer is 413, not 400 — the
        // parser never ran.
        let huge = vec![b'x'; MAX_SEALED_BLOB_BODY + 1];
        assert_eq!(validate_put(&huge).unwrap_err().0, StatusCode::PAYLOAD_TOO_LARGE);
        // Positive control: the same garbage under the cap IS parsed (400).
        let small = vec![b'x'; 10];
        assert_eq!(validate_put(&small).unwrap_err().0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn a_well_formed_body_passes_and_the_bad_ones_do_not() {
        let ok = br#"{"expected_rev":3,"blob":"{\"v\":1,\"ct\":\"abc\"}"}"#;
        let r = validate_put(ok).expect("valid body");
        assert_eq!(r.expected_rev, 3);
        for (body, why) in [
            (&br#"{"expected_rev":-1,"blob":"x"}"#[..], "negative rev"),
            (&br#"{"expected_rev":0,"blob":""}"#[..], "empty blob"),
            (&br#"{"expected_rev":0,"blob":"a b"}"#[..], "NUL"),
            (&br#"{"blob":"x"}"#[..], "missing rev"),
        ] {
            assert_eq!(validate_put(body).unwrap_err().0, StatusCode::BAD_REQUEST, "{why}");
        }
        // A blob over the cap inside a body that is (just) under the body cap
        // is still refused as too large.
        let blob = "y".repeat(MAX_SEALED_BLOB_BYTES + 1);
        let body = format!(r#"{{"expected_rev":0,"blob":"{blob}"}}"#);
        assert!(body.len() <= MAX_SEALED_BLOB_BODY, "the fixture must reach the second check");
        assert_eq!(validate_put(body.as_bytes()).unwrap_err().0, StatusCode::PAYLOAD_TOO_LARGE);
        // ...and exactly at the cap it is accepted.
        let at_cap = format!(r#"{{"expected_rev":0,"blob":"{}"}}"#, "y".repeat(MAX_SEALED_BLOB_BYTES));
        assert!(validate_put(at_cap.as_bytes()).is_ok());
    }

    #[test]
    fn only_whitelisted_names_are_accepted() {
        assert!(name_allowed("notes-prefs"));
        for bad in ["", "notes", "NOTES-PREFS", "../etc", "notes-prefs2", "task-places"] {
            assert!(!name_allowed(bad), "{bad}");
        }
    }

    async fn test_pool() -> Option<sqlx::PgPool> {
        crate::migrator::test_pool(4).await
    }

    async fn mk_user(pool: &sqlx::PgPool, tag: &str) -> i64 {
        let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(format!("sb_{tag}_{}", uuid::Uuid::new_v4().simple()))
            .bind(b"s".as_ref())
            .bind(b"v".as_ref())
            .fetch_one(pool)
            .await
            .expect("insert user");
        id as i64
    }

    /// The compare-and-swap against a real database: insert-once, update only
    /// the named revision, and a conflict hands back what IS current.
    #[tokio::test]
    async fn compare_and_swap_answers_a_stale_revision_with_the_current_value() {
        let Some(pool) = test_pool().await else { return };
        let alice = mk_user(&pool, "a").await;
        let bob = mk_user(&pool, "b").await;

        assert_eq!(cas_write(&pool, alice, "notes-prefs", 0, "one").await.unwrap(), CasOutcome::Written(1));
        // A second "there is nothing yet" loses to the first.
        assert_eq!(
            cas_write(&pool, alice, "notes-prefs", 0, "other").await.unwrap(),
            CasOutcome::Conflict(Some((1, "one".into())))
        );
        assert_eq!(cas_write(&pool, alice, "notes-prefs", 1, "two").await.unwrap(), CasOutcome::Written(2));
        // A device still on revision 1 is refused and told about revision 2.
        assert_eq!(
            cas_write(&pool, alice, "notes-prefs", 1, "stale").await.unwrap(),
            CasOutcome::Conflict(Some((2, "two".into())))
        );
        // A revision from the future is a conflict too, never an insert.
        assert!(matches!(cas_write(&pool, alice, "notes-prefs", 9, "x").await.unwrap(), CasOutcome::Conflict(_)));
        // Per user: Bob has nothing, and a non-zero rev for him conflicts with "none".
        assert_eq!(cas_write(&pool, bob, "notes-prefs", 1, "b").await.unwrap(), CasOutcome::Conflict(None));
        assert_eq!(current(&pool, alice, "notes-prefs").await.unwrap(), Some((2, "two".into())));

        let _ = sqlx::query("DELETE FROM users WHERE id = $1 OR id = $2").bind(alice).bind(bob).execute(&pool).await;
    }

    /// Account deletion is a tombstone UPDATE, so the FK cascade never fires:
    /// the cleanup list has to remove the blob itself.
    #[tokio::test]
    async fn account_deletion_cleanup_removes_the_users_blobs_and_only_theirs() {
        let Some(pool) = test_pool().await else { return };
        let gone = mk_user(&pool, "gone").await;
        let stays = mk_user(&pool, "stays").await;
        cas_write(&pool, gone, "notes-prefs", 0, "g").await.unwrap();
        cas_write(&pool, stays, "notes-prefs", 0, "s").await.unwrap();

        let stmt = crate::handlers::account_delete_cleanup()
            .iter()
            .find(|q| q.contains("user_sealed_blobs"))
            .expect("the cleanup list names user_sealed_blobs");
        sqlx::query(stmt).bind(gone).execute(&pool).await.unwrap();

        assert_eq!(current(&pool, gone, "notes-prefs").await.unwrap(), None, "the deleted account's blob is gone");
        assert_eq!(current(&pool, stays, "notes-prefs").await.unwrap(), Some((1, "s".into())), "nobody else's is touched");
        let _ = sqlx::query("DELETE FROM users WHERE id = $1 OR id = $2").bind(gone).bind(stays).execute(&pool).await;
    }
}
