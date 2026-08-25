//! The sqlx prepared-statement-cache width collision, pinned against a real
//! Postgres — the mechanism behind the 2026-08-20 cold-boot device-token 500.
//!
//! sqlx caches prepared statements PER CONNECTION, KEYED BY THE SQL TEXT
//! ALONE. Two call sites sharing one text but binding different integer
//! widths therefore share one prepared statement: whichever runs second on a
//! given connection sends its width into the other's declared parameter type,
//! and Postgres answers 22P03 "incorrect binary data format in bind
//! parameter 1". Intermittent by construction — it depends on which pooled
//! connection serves the request and who prepared the text on it first. The
//! auth middleware runs on nearly every request, so in production nearly
//! every connection carries the i32-typed statement; the device-token redeem
//! (which bound i64 until this fix) then failed on ~every cold boot, and a
//! dummy-signature probe could never see it because it exits one statement
//! earlier at the attestation check.
//!
//! The fix is a DISCIPLINE, not a call-site patch: every user of a duplicated
//! SQL text binds the width of the column (i32 for the INT4 ids). This test
//! pins the mechanism both ways:
//!  - POSITIVE CONTROL: i64 after i32 on the same text and connection really
//!    does produce the binary-format error (a rig that cannot see the failure
//!    proves nothing — see memory: test-needs-a-positive-control);
//!  - THE PIN: the matched-width sequence the fixed handlers now perform is
//!    clean on the same connection.
//!
//! Self-skips without DATABASE_URL, like every DB test here (the Windows CI
//! box has no Postgres). Uses a TEMP table on a single-connection pool, so it
//! needs no migrations and cannot touch real data.

use sqlx::postgres::PgPoolOptions;

fn database_url() -> Option<String> {
    std::env::var("DATABASE_URL").ok().filter(|s| !s.is_empty())
}

#[tokio::test]
async fn same_sql_text_with_mismatched_widths_is_the_cold_boot_500() {
    let Some(url) = database_url() else {
        eprintln!("bind_width_cache: skipped (no DATABASE_URL)");
        return;
    };
    // ONE connection: the statement cache is per connection, and the
    // collision needs the second caller to inherit the first's statement.
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect");

    // TEMP tables are per-connection, which the single-connection pool makes
    // stable — and nothing of the real schema is touched.
    sqlx::query("CREATE TEMP TABLE users_bwc (id INT4 PRIMARY KEY, token_version INT4 NOT NULL)")
        .execute(&pool)
        .await
        .expect("create temp table");
    sqlx::query("INSERT INTO users_bwc (id, token_version) VALUES (1, 7)")
        .execute(&pool)
        .await
        .expect("seed");

    const TEXT: &str = "SELECT token_version FROM users_bwc WHERE id = $1";

    // The auth middleware's shape: i32 prepares the statement with an INT4
    // parameter on this connection.
    let v: i32 = sqlx::query_scalar(TEXT)
        .bind(1_i32)
        .fetch_one(&pool)
        .await
        .expect("the i32 caller prepares and succeeds");
    assert_eq!(v, 7);

    // POSITIVE CONTROL — the pre-fix device-token shape. The i64 argument
    // rides the cached INT4-typed statement and the server must refuse it
    // with the binary-format error; anything else and this rig is not seeing
    // the production mechanism at all.
    let err = sqlx::query_scalar::<_, i32>(TEXT)
        .bind(1_i64)
        .fetch_one(&pool)
        .await
        .expect_err("i64 after i32 on one connection must collide");
    let msg = err.to_string();
    assert!(
        msg.contains("incorrect binary data format"),
        "expected the 22P03 binary-format error, got: {msg}"
    );

    // THE PIN — the fixed shape: matched widths reuse the cached statement
    // cleanly, on the very same connection the control just poisoned a call
    // on. (The error above must not have broken the statement for correctly
    // typed callers, and it does not.)
    let v: i32 = sqlx::query_scalar(TEXT)
        .bind(1_i32)
        .fetch_one(&pool)
        .await
        .expect("matched widths stay clean after the collision");
    assert_eq!(v, 7);
}
