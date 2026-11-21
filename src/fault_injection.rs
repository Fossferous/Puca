//! Test helpers for "a lookup that failed is not an answer" (src/try_again.rs).
//!
//! A fault on ONE lookup of a request, after the ones before it answered,
//! comes from [`faulty_pool`]: its connections resolve the named tables to
//! views that raise (as a statement cancelled under load does) and every other
//! name to the real table. Only that pool sees the fault, through a schema of
//! its own on its search_path; nothing global (no trigger on a real table)
//! is ever installed, so tests running beside it are untouched. Drop it with
//! [`drop_faults`].

use crate::auth::Claims;
use crate::state::AppState;
use axum::http::{header, StatusCode};
use axum::response::Response;
use chrono::Utc;
use std::sync::Arc;

pub(crate) fn claims(sub: i64) -> Claims {
    Claims {
        sub,
        username: format!("u{sub}"),
        exp: Utc::now().timestamp() + 3600,
        tv: 0,
        sst: 0,
        sid: String::new(),
        ls: false,
    }
}

pub(crate) fn app(pool: &sqlx::PgPool) -> Arc<AppState> {
    AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake))
}

#[track_caller]
pub(crate) fn assert_retry(resp: &Response, why: &str) {
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE, "{why}");
    assert_eq!(
        resp.headers().get(header::RETRY_AFTER).and_then(|v| v.to_str().ok()),
        Some("2"),
        "{why}: Retry-After"
    );
}

#[track_caller]
pub(crate) fn assert_not_found(resp: &Response, why: &str) {
    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{why}");
    assert!(resp.headers().get(header::RETRY_AFTER).is_none(), "{why}: a 404 is final, no Retry-After");
}

/// Every check of a test, collected rather than stopping at the first, so a
/// revert-to-red run names EACH check that a fix holds up, not just the
/// first one to fail. `done` fails the test with the whole list.
#[derive(Default)]
pub(crate) struct Checks(Vec<String>);

impl Checks {
    /// The 503 + `Retry-After: 2` of a refusal to retry.
    #[track_caller]
    pub(crate) fn retry(&mut self, resp: &Response, why: &str) {
        let after = resp.headers().get(header::RETRY_AFTER).and_then(|v| v.to_str().ok());
        if resp.status() != StatusCode::SERVICE_UNAVAILABLE || after != Some("2") {
            self.0.push(format!("{why}: expected 503 + Retry-After: 2, got {} (Retry-After {after:?})", resp.status()));
        }
    }

    #[track_caller]
    pub(crate) fn eq<T: PartialEq + std::fmt::Debug>(&mut self, got: &T, want: &T, why: String) {
        if got != want {
            self.0.push(format!("{why}: got {got:?}, expected {want:?}"));
        }
    }

    #[track_caller]
    pub(crate) fn that(&mut self, ok: bool, why: String) {
        if !ok {
            self.0.push(why);
        }
    }

    #[track_caller]
    pub(crate) fn done(self) {
        assert!(self.0.is_empty(), "{} check(s) failed:\n  - {}", self.0.len(), self.0.join("\n  - "));
    }
}

/// See the module comment. `tables` are names in `public`.
pub(crate) async fn faulty_pool(admin: &sqlx::PgPool, url: &str, tables: &[&str]) -> (sqlx::PgPool, String) {
    let schema = format!("f503_{}", uuid::Uuid::new_v4().simple());
    crate::migrator::test_ddl(admin, &format!("CREATE SCHEMA {schema}")).await;
    for t in tables {
        crate::migrator::test_ddl(
            admin,
            &format!(
                "CREATE FUNCTION {schema}.fault_{t}() RETURNS SETOF public.{t} LANGUAGE plpgsql AS \
                 $$ BEGIN RAISE EXCEPTION 'injected fault on {t}' USING ERRCODE = 'query_canceled'; END $$"
            ),
        )
        .await;
        crate::migrator::test_ddl(admin, &format!("CREATE VIEW {schema}.{t} AS SELECT * FROM {schema}.fault_{t}()")).await;
    }
    let opts = url
        .parse::<sqlx::postgres::PgConnectOptions>()
        .expect("TEST_DATABASE_URL parses")
        .options([("search_path", format!("{schema},public"))]);
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect_with(opts)
        .await
        .expect("connect the faulty pool");
    (pool, schema)
}

/// Like [`faulty_pool`], but `table` READS normally (a plain view over the
/// real one) and only a DELETE through it fails.
pub(crate) async fn faulty_delete_pool(admin: &sqlx::PgPool, url: &str, table: &str) -> (sqlx::PgPool, String) {
    let (pool, schema) = faulty_pool(admin, url, &[]).await;
    crate::migrator::test_ddl(admin, &format!("CREATE VIEW {schema}.{table} AS SELECT * FROM public.{table}")).await;
    crate::migrator::test_ddl(
        admin,
        &format!(
            "CREATE FUNCTION {schema}.refuse_delete() RETURNS trigger LANGUAGE plpgsql AS \
             $$ BEGIN RAISE EXCEPTION 'injected fault on DELETE' USING ERRCODE = 'query_canceled'; END $$"
        ),
    )
    .await;
    crate::migrator::test_ddl(
        admin,
        &format!("CREATE TRIGGER refuse_delete INSTEAD OF DELETE ON {schema}.{table} FOR EACH ROW EXECUTE FUNCTION {schema}.refuse_delete()"),
    )
    .await;
    (pool, schema)
}

/// Like [`faulty_pool`] for ONE table, but its first `ok` reads (statements
/// that scan it) answer and every one after fails: the database going busy
/// between two lookups of the same request, which no whole-table fault can
/// stage when both lookups read the same table.
pub(crate) async fn faulty_after_pool(admin: &sqlx::PgPool, url: &str, table: &str, ok: u32) -> (sqlx::PgPool, String) {
    let (pool, schema) = faulty_pool(admin, url, &[]).await;
    crate::migrator::test_ddl(admin, &format!("CREATE SEQUENCE {schema}.reads")).await;
    crate::migrator::test_ddl(
        admin,
        &format!(
            "CREATE FUNCTION {schema}.fault_{table}() RETURNS SETOF public.{table} LANGUAGE plpgsql AS \
             $$ BEGIN \
                  IF nextval('{schema}.reads') > {ok} THEN \
                    RAISE EXCEPTION 'injected fault on {table}' USING ERRCODE = 'query_canceled'; \
                  END IF; \
                  RETURN QUERY SELECT * FROM public.{table}; \
                END $$"
        ),
    )
    .await;
    crate::migrator::test_ddl(admin, &format!("CREATE VIEW {schema}.{table} AS SELECT * FROM {schema}.fault_{table}()")).await;
    (pool, schema)
}

/// Like [`faulty_pool`] for ONE table whose READS fail while an INSERT into
/// it still goes through (an INSTEAD OF trigger hands the row to the real
/// table, with the real table's defaults). This is the shape of a guard that
/// fails open: the count before a write fails, and the write then lands. A
/// test can therefore show the write did NOT land when the guard holds.
pub(crate) async fn faulty_read_pool(admin: &sqlx::PgPool, url: &str, table: &str) -> (sqlx::PgPool, String) {
    let (pool, schema) = faulty_pool(admin, url, &[table]).await;
    let defaults: Vec<(String, String)> = sqlx::query_as(
        "SELECT a.attname::text, pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d \
         JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum \
         WHERE d.adrelid = $1::regclass",
    )
    .bind(format!("public.{table}"))
    .fetch_all(admin)
    .await
    .expect("read the table's defaults");
    for (col, expr) in defaults {
        crate::migrator::test_ddl(admin, &format!("ALTER VIEW {schema}.{table} ALTER COLUMN \"{col}\" SET DEFAULT {expr}")).await;
    }
    crate::migrator::test_ddl(
        admin,
        &format!(
            "CREATE FUNCTION {schema}.pass_insert() RETURNS trigger LANGUAGE plpgsql AS \
             $$ BEGIN INSERT INTO public.{table} SELECT (NEW).*; RETURN NEW; END $$"
        ),
    )
    .await;
    crate::migrator::test_ddl(
        admin,
        &format!("CREATE TRIGGER pass_insert INSTEAD OF INSERT ON {schema}.{table} FOR EACH ROW EXECUTE FUNCTION {schema}.pass_insert()"),
    )
    .await;
    (pool, schema)
}

/// Like [`faulty_pool`], but only reading `column` of `table` fails: every
/// other column reads, and an UPDATE or INSERT that does not name `column`
/// goes through (the view stays auto-updatable for the rest). For a lookup
/// that shares its table with a check before it, or with the write after it.
pub(crate) async fn faulty_column_pool(admin: &sqlx::PgPool, url: &str, table: &str, column: &str) -> (sqlx::PgPool, String) {
    let (pool, schema) = faulty_pool(admin, url, &[]).await;
    let cols: Vec<(String, String)> = sqlx::query_as(
        "SELECT attname::text, format_type(atttypid, atttypmod) FROM pg_attribute \
         WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
    )
    .bind(format!("public.{table}"))
    .fetch_all(admin)
    .await
    .expect("read the table's columns");
    let ty = &cols.iter().find(|(c, _)| c == column).expect("the faulted column exists").1;
    // STABLE and fed the row's value: evaluated only where the column is
    // read (a VOLATILE one would stop the view being flattened, and every
    // query on it would raise).
    crate::migrator::test_ddl(
        admin,
        &format!(
            "CREATE FUNCTION {schema}.fault_col(v {ty}) RETURNS {ty} LANGUAGE plpgsql STABLE AS \
             $$ BEGIN RAISE EXCEPTION 'injected fault on {table}.{column}' USING ERRCODE = 'query_canceled'; END $$"
        ),
    )
    .await;
    let list: Vec<String> = cols
        .iter()
        .map(|(c, _)| if c == column { format!("{schema}.fault_col(\"{c}\") AS \"{c}\"") } else { format!("\"{c}\"") })
        .collect();
    crate::migrator::test_ddl(admin, &format!("CREATE VIEW {schema}.{table} AS SELECT {} FROM public.{table}", list.join(", "))).await;
    (pool, schema)
}

pub(crate) async fn drop_faults(admin: &sqlx::PgPool, faulty: sqlx::PgPool, schema: &str) {
    faulty.close().await;
    crate::migrator::test_ddl(admin, &format!("DROP SCHEMA IF EXISTS {schema} CASCADE")).await;
}

pub(crate) async fn user(pool: &sqlx::PgPool, role: &str) -> i64 {
    let name = format!("f503_{role}_{}", uuid::Uuid::new_v4().simple());
    let (id,): (i32,) = sqlx::query_as(
        "INSERT INTO users (username, email, salt, verifier, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id",
    )
    .bind(&name)
    .bind(format!("{name}@test.invalid"))
    .bind(b"s".as_ref())
    .bind(b"v".as_ref())
    .fetch_one(pool)
    .await
    .expect("insert user");
    id as i64
}
