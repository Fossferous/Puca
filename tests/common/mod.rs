//! Shared by the DB-backed integration tests in `tests/*.rs`.
//!
//! The same contract as `src/migrator.rs`'s `test_pool`, copied because an
//! integration test cannot reach it: `puca` is a binary crate with no library
//! target, and that helper is `#[cfg(test)] pub(crate)` anyway.
//!
//! - `TEST_DATABASE_URL` and nothing else. Never `DATABASE_URL`, and no
//!   `.env` loading: that names the maintainer's dev database.
//! - Unset (or blank) is the ONE reason to skip: `None`, after a printed line.
//! - Set but unreachable PANICS with the error. A run that was configured to
//!   exercise the database must not come back green because it was down.
//!
//! These tests do not migrate (the crate's migrations are embedded in the
//! binary, not here): point the variable at a database the backend, or a
//! `cargo test` of the root package, has already migrated. CI boots the
//! server against it first.

use sqlx::{postgres::PgPoolOptions, Connection, PgPool};

pub async fn test_pool(max_connections: u32) -> Option<PgPool> {
    let Some(url) = std::env::var("TEST_DATABASE_URL").ok().filter(|u| !u.trim().is_empty()) else {
        println!("skipping: TEST_DATABASE_URL not set");
        return None;
    };
    let unreachable = |e: sqlx::Error| -> ! {
        panic!(
            "TEST_DATABASE_URL is set but the database is unreachable: {e}. \
             Start that database, or unset TEST_DATABASE_URL to skip the DB-backed tests."
        )
    };
    // One plain connection first: sqlx's pool retries a refused connection
    // for its 30 s acquire timeout before reporting it.
    match sqlx::postgres::PgConnection::connect(&url).await {
        Ok(probe) => {
            let _ = probe.close().await;
        }
        Err(e) => unreachable(e),
    }
    Some(
        PgPoolOptions::new()
            .max_connections(max_connections)
            .connect(&url)
            .await
            .unwrap_or_else(|e| unreachable(e)),
    )
}
