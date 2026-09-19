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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_startup_migrator_tolerates_newer_databases_and_embeds_everything() {
        let m = app_migrator();
        assert!(m.ignore_missing, "an older binary must boot against a database a newer one migrated");
        // Still the full embedded set: the flag must not come with a
        // different (empty, partial) source.
        let plain = sqlx::migrate!("./migrations");
        assert_eq!(m.iter().count(), plain.iter().count());
        assert!(m.iter().count() > 0);
    }

    /// Against a real database: a version this binary does not embed is
    /// recorded as applied (what a NEWER release leaves behind), and the
    /// startup migrator still runs to completion — while the sqlx default
    /// refuses, which is the positive control proving the fixture is the
    /// situation a rollback meets. Uses a database of its own, created and
    /// dropped here, because a foreign version in a shared test database
    /// would make every OTHER test's default migrator refuse. Skips (prints)
    /// without TEST_DATABASE_URL / DATABASE_URL, like auth::session_tests.
    #[tokio::test]
    async fn a_database_migrated_by_a_newer_release_still_boots_this_one() {
        dotenv::dotenv().ok();
        let url = match std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL")) {
            Ok(u) => u,
            Err(_) => { println!("skipping: no database"); return; }
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
