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
        let admin = match sqlx::postgres::PgPoolOptions::new().max_connections(1).connect(&url).await {
            Ok(p) => p,
            Err(_) => { println!("skipping: database unreachable"); return; }
        };
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
