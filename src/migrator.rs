//! The migrator the server runs at startup.
//!
//! `sqlx::migrate!` embeds `./migrations` at compile time, and by default the
//! resulting `Migrator` REFUSES to start against a database that has applied a
//! migration it does not embed (`MigrateError::VersionMissing`). That default
//! makes every backend rollback a database restore: the moment a release that
//! adds migration N has booted once, no binary built before N will boot again,
//! and the only way back is the dump taken before the ship — losing every
//! write made since.
//!
//! `ignore_missing` turns that check off, and nothing else. Checksums of the
//! migrations this binary DOES embed are still compared (an edited applied
//! file still crash-loops, migrations/README.md), and anything unapplied is
//! still applied. What it permits is exactly "the database is newer than me":
//! an older binary boots over columns and tables it does not know about. That
//! is only safe because every migration here is additive (nullable columns,
//! new tables, `IF NOT EXISTS`) — which is the rule migrations/README.md
//! already sets for other reasons. A future migration that is NOT additive
//! (a dropped or renamed column an older binary still reads) breaks rollback
//! to anything before it, and its release notes must say so.
//!
//! This only helps binaries built WITH it. A release that predates this file
//! still runs the default check, so rolling back to one of those still needs
//! the database restore.

use sqlx::migrate::Migrator;

/// The startup migrator: every embedded migration, tolerant of applied
/// versions it does not embed (see the module header for why).
pub fn app_migrator() -> Migrator {
    let mut m = sqlx::migrate!("./migrations");
    m.set_ignore_missing(true);
    m
}

/// The database a DB-backed test may use: `TEST_DATABASE_URL`, and nothing
/// else. Never `DATABASE_URL` (nor a `.env` that sets it): the tests that call
/// this migrate the database, run sweeps that delete rows for every account
/// in it, and create and drop scratch databases on its server — a plain
/// `cargo test` in a checkout configured for a dev database must not do that
/// to it.
#[cfg(test)]
pub(crate) fn test_database_url() -> Option<String> {
    test_database_url_from(|k| std::env::var(k).ok())
}

#[cfg(test)]
fn test_database_url_from(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    get("TEST_DATABASE_URL").filter(|u| !u.trim().is_empty())
}

/// The pool every DB-backed test in this crate runs against: connected to
/// `TEST_DATABASE_URL` and migrated with the startup migrator. `None` (after
/// printing "skipping") ONLY when the variable is unset — that is the one
/// legitimate reason to skip. A variable that is set but names a database
/// that cannot be reached PANICS with the error: a gate run that meant to
/// exercise the database must not come back green because it was down, the
/// password was wrong or the database name was misspelt.
///
/// Migrating here, not in each caller, also closes a first-run race: suites
/// that did not migrate raced the ones that did on a fresh throwaway
/// database and failed with `relation "users" does not exist`.
/// (`tests/*.rs` cannot reach this — the crate is a binary with no library
/// target — so `tests/common/mod.rs` carries a copy of the same contract.)
#[cfg(test)]
pub(crate) async fn test_pool(max_connections: u32) -> Option<sqlx::PgPool> {
    test_database(max_connections).await.map(|(pool, _)| pool)
}

/// `test_pool` plus the URL, for a test that also needs its own connection
/// (a `PgListener`).
#[cfg(test)]
pub(crate) async fn test_database(max_connections: u32) -> Option<(sqlx::PgPool, String)> {
    test_database_from(test_database_url(), max_connections).await
}

#[cfg(test)]
async fn test_database_from(url: Option<String>, max_connections: u32) -> Option<(sqlx::PgPool, String)> {
    let Some(url) = url else {
        println!("skipping: TEST_DATABASE_URL not set");
        return None;
    };
    let pool = connect_test_database(&url, max_connections).await;
    app_migrator().run(&pool).await.expect("migrations apply");
    Some((pool, url))
}

/// Connect to a configured test database or panic saying why. One plain
/// connection goes first because sqlx's POOL retries a refused connection
/// until its 30 s acquire timeout: every test would sit out half a minute
/// before failing. The error text never includes the URL (it carries the
/// password).
#[cfg(test)]
pub(crate) async fn connect_test_database(url: &str, max_connections: u32) -> sqlx::PgPool {
    use sqlx::Connection;
    let unreachable = |e: sqlx::Error| -> ! {
        panic!(
            "TEST_DATABASE_URL is set but the database is unreachable: {e}. \
             Start that database, or unset TEST_DATABASE_URL to skip the DB-backed tests."
        )
    };
    match sqlx::postgres::PgConnection::connect(url).await {
        Ok(probe) => {
            let _ = probe.close().await;
        }
        Err(e) => unreachable(e),
    }
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(max_connections)
        .connect(url)
        .await
        .unwrap_or_else(|e| unreachable(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_startup_migrator_tolerates_newer_databases_and_embeds_everything() {
        let m = app_migrator();
        assert!(m.ignore_missing, "an older binary must boot against a database a newer one migrated");
        // Still the full set: every `<version>_<name>.sql` in migrations/ is
        // embedded, no more and no fewer — read from the directory at test
        // time, not from a second expansion of the same macro.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut on_disk: Vec<i64> = std::fs::read_dir(&dir)
            .expect("migrations/ is readable")
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.ends_with(".sql"))
            .filter_map(|n| n.split_once('_')?.0.parse::<i64>().ok())
            .collect();
        on_disk.sort_unstable();
        let embedded: Vec<i64> = m.iter().map(|mig| mig.version).collect();
        assert!(on_disk.len() >= 65, "positive control: the directory scan found the migrations ({})", on_disk.len());
        assert_eq!(embedded, on_disk, "the startup migrator embeds exactly migrations/*.sql");
    }

    #[test]
    fn db_tests_use_test_database_url_and_never_database_url() {
        let only_dev = |k: &str| (k == "DATABASE_URL").then(|| "postgres://dev/puca".to_string());
        assert_eq!(test_database_url_from(only_dev), None, "a dev DATABASE_URL must never be picked up");
        let both = |k: &str| match k {
            "TEST_DATABASE_URL" => Some("postgres://test/scratch".to_string()),
            "DATABASE_URL" => Some("postgres://dev/puca".to_string()),
            _ => None,
        };
        assert_eq!(test_database_url_from(both).as_deref(), Some("postgres://test/scratch"), "positive control");
        assert_eq!(test_database_url_from(|_| Some("  ".to_string())), None, "blank is unset");
    }

    /// A URL nothing listens on: a port the OS just handed out, released
    /// again. No fixed port, so it cannot collide with anything running.
    fn closed_database_url() -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
        let port = l.local_addr().expect("local addr").port();
        drop(l);
        format!("postgres://nobody:nothing@127.0.0.1:{port}/none")
    }

    /// Configured but unreachable is a FAILURE, never a skip: the old
    /// per-suite setups printed a skip line on a failed connect and returned,
    /// so a gate run against a stopped throwaway cluster came back green.
    #[tokio::test]
    #[should_panic(expected = "TEST_DATABASE_URL is set but the database is unreachable")]
    async fn a_configured_but_unreachable_test_database_fails_instead_of_skipping() {
        let _ = test_database_from(Some(closed_database_url()), 1).await;
    }

    /// Positive control for the panic above: unset is still the one skip,
    /// and it returns before any connection is attempted.
    #[tokio::test]
    async fn an_unset_test_database_is_the_only_skip() {
        assert!(test_database_from(None, 1).await.is_none());
    }

    /// A textual tripwire over every Rust file in src/ and tests/: no test
    /// may read `DATABASE_URL` (the maintainer's dev database), call dotenv
    /// (which loads a `.env` naming it), or copy the old "skip when the
    /// database is unreachable" arm. Only the server's own entry point,
    /// main.rs, may do the first two. The needles are assembled with concat!
    /// so this file does not match itself. A textual scan cannot see the
    /// variable read through an indirection; it is a tripwire, not a proof.
    #[test]
    fn no_test_reads_database_url_loads_dotenv_or_skips_an_unreachable_database() {
        let needles = [
            concat!("var(\"", "DATABASE_URL\")"),
            concat!("dot", "env::"),
            concat!("skipping: database", " unreachable"),
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        let mut dirs = vec![root.join("src"), root.join("tests")];
        while let Some(dir) = dirs.pop() {
            for e in std::fs::read_dir(&dir).expect("readable source dir").flatten() {
                let p = e.path();
                if p.is_dir() {
                    dirs.push(p);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    files.push(p);
                }
            }
        }
        let main = root.join("src").join("main.rs");
        let main_text = std::fs::read_to_string(&main).expect("main.rs");
        assert!(
            needles[..2].iter().all(|n| main_text.contains(n)),
            "positive control: the scan must find main.rs's own DATABASE_URL read and dotenv call"
        );
        assert!(files.len() > 40, "positive control: the walk found the sources ({})", files.len());
        let mut hits = Vec::new();
        for f in files.iter().filter(|f| **f != main) {
            let text = String::from_utf8_lossy(&std::fs::read(f).expect("readable")).into_owned();
            for (i, line) in text.lines().enumerate() {
                if let Some(n) = needles.iter().find(|n| line.contains(**n)) {
                    hits.push(format!("{}:{}: {n}", f.strip_prefix(root).unwrap_or(f).display(), i + 1));
                }
            }
        }
        assert!(
            hits.is_empty(),
            "DB-backed tests must use TEST_DATABASE_URL only, via migrator::test_pool (tests/common for tests/*.rs):\n{}",
            hits.join("\n")
        );
    }

    /// Against a real database: a version this binary does not embed is
    /// recorded as applied (what a NEWER release leaves behind), and the
    /// startup migrator still runs to completion — while the sqlx default
    /// refuses, which is the positive control proving the fixture is the
    /// situation a rollback meets. Uses a database of its own, created and
    /// dropped here, because a foreign version in a shared test database
    /// would make every OTHER test's default migrator refuse. Skips (prints)
    /// without TEST_DATABASE_URL — never DATABASE_URL (test_database_url).
    #[tokio::test]
    async fn a_database_migrated_by_a_newer_release_still_boots_this_one() {
        let Some(url) = test_database_url() else {
            println!("skipping: TEST_DATABASE_URL not set");
            return;
        };
        // Not test_pool: this needs an admin connection only, and must not
        // depend on the shared database's own migration state.
        let admin = connect_test_database(&url, 1).await;
        let name = format!("puca_migtest_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&admin).await.expect("create scratch database");
        // Same server, the scratch database: swap the path of the URL.
        let base = url.rsplit_once('/').map(|(b, _)| b).expect("a database URL has a path");
        let scratch_url = format!("{base}/{name}");
        let result = async {
            let pool = sqlx::postgres::PgPoolOptions::new().max_connections(1).connect(&scratch_url).await.expect("connect scratch");
            app_migrator().run(&pool).await.expect("a fresh database migrates");
            sqlx::query(
                "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
                 VALUES (999999, 'from a newer release', TRUE, '\\x00'::bytea, 0)",
            )
            .execute(&pool)
            .await
            .expect("record a foreign version");

            let default = sqlx::migrate!("./migrations").run(&pool).await;
            let tolerant = app_migrator().run(&pool).await;
            pool.close().await;
            (default, tolerant)
        }
        .await;
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)")).execute(&admin).await;

        let (default, tolerant) = result;
        assert!(
            matches!(default, Err(sqlx::migrate::MigrateError::VersionMissing(999999))),
            "positive control: sqlx's default refuses a database with a version it does not embed, got {default:?}"
        );
        assert!(tolerant.is_ok(), "the startup migrator must boot over it, got {tolerant:?}");
    }
}
