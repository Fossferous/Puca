//! Integration tests for authentication endpoints
//!
//! These tests use a real test database to verify the full auth flow.
//! Run with: cargo test --test api_auth
//!
//! Note: Requires DATABASE_URL environment variable pointing to a test database.
//! The test database should be separate from production!

use axum::{
    body::Body,
    http::{Request, StatusCode},
    routing::get,
    Router,
};
use sqlx::{postgres::PgPoolOptions, PgPool};
use tower::ServiceExt;

/// Create a test database pool
/// Uses TEST_DATABASE_URL env var to avoid touching production
async fn create_test_pool() -> Option<PgPool> {
    let db_url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;

    PgPoolOptions::new()
        .max_connections(2)
        .connect(&db_url)
        .await
        .ok()
}

/// Clean up test user by username
async fn cleanup_test_user(pool: &PgPool, username: &str) {
    let _ = sqlx::query("DELETE FROM users WHERE username = $1")
        .bind(username)
        .execute(pool)
        .await;
}

/// Test that we can connect to the database
#[tokio::test]
async fn test_database_connection() {
    dotenv::dotenv().ok();

    let pool = match create_test_pool().await {
        Some(p) => p,
        None => {
            println!("Skipping test: no database connection");
            return;
        }
    };

    // Simple query to verify connection (cast so the type matches i64/INT8).
    let result: (i64,) = sqlx::query_as("SELECT 1::bigint")
        .fetch_one(&pool)
        .await
        .expect("Failed to execute test query");

    assert_eq!(result.0, 1);
}

/// Test that the users table exists
#[tokio::test]
async fn test_users_table_exists() {
    dotenv::dotenv().ok();

    let pool = match create_test_pool().await {
        Some(p) => p,
        None => {
            println!("Skipping test: no database connection");
            return;
        }
    };

    // Check if users table exists
    let result: (bool,) = sqlx::query_as(
        "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'users')",
    )
    .fetch_one(&pool)
    .await
    .expect("Failed to check for users table");

    assert!(result.0, "users table does not exist");
}

/// Test user creation and verification in database
#[tokio::test]
async fn test_create_and_query_user() {
    dotenv::dotenv().ok();

    let pool = match create_test_pool().await {
        Some(p) => p,
        None => {
            println!("Skipping test: no database connection");
            return;
        }
    };

    let test_username = format!("test_user_{}", uuid::Uuid::new_v4());
    let test_email = format!("{}@test.com", test_username);

    // Clean up any existing test user first
    cleanup_test_user(&pool, &test_username).await;

    // Insert a test user directly
    let insert_result = sqlx::query(
        r#"
        INSERT INTO users (username, email, salt, verifier, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING id
        "#,
    )
    .bind(&test_username)
    .bind(&test_email)
    .bind(b"test_salt".as_ref()) // salt/verifier are BYTEA, not text
    .bind(b"test_verifier".as_ref())
    .fetch_one(&pool)
    .await;

    assert!(
        insert_result.is_ok(),
        "Failed to insert test user: {:?}",
        insert_result.err()
    );

    // Query the user back
    let user: (String, String) =
        sqlx::query_as("SELECT username, email FROM users WHERE username = $1")
            .bind(&test_username)
            .fetch_one(&pool)
            .await
            .expect("Failed to query test user");

    assert_eq!(user.0, test_username);
    assert_eq!(user.1, test_email);

    // Clean up
    cleanup_test_user(&pool, &test_username).await;
}

/// Test that duplicate usernames are rejected
#[tokio::test]
async fn test_duplicate_username_rejected() {
    dotenv::dotenv().ok();

    let pool = match create_test_pool().await {
        Some(p) => p,
        None => {
            println!("Skipping test: no database connection");
            return;
        }
    };

    let test_username = format!("dup_test_{}", uuid::Uuid::new_v4());

    // Clean up first
    cleanup_test_user(&pool, &test_username).await;

    // Insert first user
    let _ = sqlx::query(
        "INSERT INTO users (username, email, salt, verifier, created_at) VALUES ($1, $2, 'salt1', 'verifier1', NOW())"
    )
    .bind(&test_username)
    .bind(format!("{}@test.com", test_username))
    .execute(&pool)
    .await
    .expect("First insert should succeed");

    // Try to insert duplicate
    let duplicate_result = sqlx::query(
        "INSERT INTO users (username, email, salt, verifier, created_at) VALUES ($1, $2, 'salt2', 'verifier2', NOW())"
    )
    .bind(&test_username)
    .bind("different_email@test.com")
    .execute(&pool)
    .await;

    assert!(
        duplicate_result.is_err(),
        "Duplicate username should be rejected"
    );

    // Clean up
    cleanup_test_user(&pool, &test_username).await;
}

/// Integration test template for full API testing
/// This demonstrates how to set up a complete test with router
#[tokio::test]
async fn test_api_integration_template() {
    dotenv::dotenv().ok();

    // This is a placeholder showing how to set up full API tests
    // In a real test, you would:
    // 1. Create a test database
    // 2. Run migrations
    // 3. Create the full app router
    // 4. Make HTTP requests
    // 5. Verify database state

    let app = Router::new().route("/test", get(|| async { "test" }));

    let response = app
        .oneshot(Request::builder().uri("/test").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

/// L8-AUTHZ-6. The route table must not carry `/servers/default`.
///
/// `main.rs` is a BINARY, so its router cannot be imported and asserted against
/// directly. This reads the routing source instead — from a different file than
/// the one the assertion lives in, so it is not the tautology a same-file
/// `include_str!` grep would be — and pins the absence of the route string.
///
/// What was removed and why: `GET /servers/default` auto-joined any valid JWT
/// to a hardcoded well-known server with no invite and NO BAN CHECK, while both
/// legitimate join paths check bans; and its create branch produced a server
/// with no roles at all, so every non-owner member of it resolved to no
/// VIEW_CHANNEL. No shipped client calls it.
#[test]
fn there_is_no_default_server_route() {
    let main_rs = include_str!("../src/main.rs");
    assert!(
        !main_rs.contains("/servers/default"),
        "the ban-bypassing default-server auto-join route is back in main.rs"
    );
    assert!(
        !main_rs.contains("get_or_create_default_server"),
        "the default-server handler is wired into the router again"
    );

    // Positive control for the reading itself: the file really is main.rs and
    // really does contain the sibling routes, so a bad path (or an empty read)
    // cannot make the two assertions above pass vacuously.
    assert!(
        main_rs.contains("/servers/reorder"),
        "include_str! did not read the real route table"
    );
    assert!(main_rs.contains("server_handlers::list_servers"));
}

/// And the handler itself is gone, not merely unrouted — an unrouted handler is
/// a re-wiring away from being live again.
#[test]
fn the_default_server_handler_is_deleted() {
    let handlers = include_str!("../src/server_handlers.rs");
    assert!(
        !handlers.contains("pub async fn get_or_create_default_server"),
        "the default-server handler still exists in server_handlers.rs"
    );
    assert!(
        !handlers.contains("00000000-0000-0000-0000-000000000001"),
        "the hardcoded default server id is still in server_handlers.rs"
    );
    // Positive control: the file is the real one.
    assert!(handlers.contains("pub async fn create_server"));
}

/// L8-DATA-2. The `sessions` table must have NO writer and NO reader.
///
/// It stored the raw SRP session key — one live cryptographic secret per
/// successful login — in a BYTEA column, forever, justified by a comment reading
/// "Also store session in DB for reference". Nothing read it: authentication is
/// JWT-based, the `session_id` never left the login handler, and `expires_at`
/// was written but never consulted. It also survived account deletion, since the
/// tombstone is an UPDATE and the table's ON DELETE CASCADE never fires.
///
/// This is a source sweep rather than a DB assertion because the claim being
/// pinned is "no code touches this table", which is a property of the tree. The
/// files read are all DIFFERENT from the file this assertion lives in.
#[test]
fn nothing_reads_or_writes_the_sessions_table() {
    // Every module that ever mentioned it, plus the login path itself.
    let sources: [(&str, &str); 4] = [
        ("src/handlers.rs", include_str!("../src/handlers.rs")),
        ("src/auth.rs", include_str!("../src/auth.rs")),
        ("src/ws.rs", include_str!("../src/ws.rs")),
        ("src/device_token.rs", include_str!("../src/device_token.rs")),
    ];
    // Strip comments first: this very finding is DESCRIBED in a comment in
    // handlers.rs, quoting the SQL it removed, and a sweep that cannot tell code
    // from prose would fire on the explanation of its own fix. Rust SQL literals
    // never contain `//`.
    let code_only = |src: &str| -> String {
        src.lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("
")
    };
    for (name, src) in sources {
        let src = code_only(src);
        for forbidden in [
            "INSERT INTO sessions",
            "FROM sessions",
            "UPDATE sessions",
            "DELETE FROM sessions",
        ] {
            assert!(
                !src.contains(forbidden),
                "{name} still runs `{forbidden}` — the table is meant to have no consumer"
            );
        }
    }

    // Positive control: the reads really are the login path, so an empty or
    // wrong include cannot make the loop above pass vacuously.
    let handlers = sources[0].1;
    assert!(
        handlers.contains("LoginStep2Response"),
        "include_str! did not read the real login handler"
    );
    assert!(
        handlers.contains("INSERT INTO login_attempts")
            || handlers.contains("DELETE FROM login_attempts"),
        "the login path should still be touching login_attempts"
    );
}

/// INFO-11, against a real database. `audit_log.actor_id` and
/// `reports.reporter_id` were declared NOT NULL while their foreign keys were
/// `ON DELETE SET NULL`, so a hard `DELETE FROM users` ABORTED on the NOT NULL
/// violation instead of anonymising the row — the declared semantics were
/// unreachable. Migration 056 drops the NOT NULL.
///
/// The delete must now succeed AND both moderation rows must survive with a
/// null actor: erasing them is what `ON DELETE CASCADE` would have done, and
/// that would let an account delete the record of what it did.
///
/// Self-skips without a test database (the api_auth.rs / e2ee_keys.rs pattern);
/// CI sets TEST_DATABASE_URL and boots the server first, which applies 056.
/// Run BEFORE the migration, this fails with a NOT NULL violation on the delete
/// — that is its positive control, and it is why the assertion is on the delete
/// succeeding rather than only on the rows' contents.
#[tokio::test]
async fn a_hard_user_delete_anonymises_moderation_rows_instead_of_aborting() {
    dotenv::dotenv().ok();
    let pool = match create_test_pool().await {
        Some(p) => p,
        None => {
            println!("Skipping test: no database connection");
            return;
        }
    };

    let tag = uuid::Uuid::new_v4().to_string();
    let mk_user = |name: String| {
        let pool = pool.clone();
        async move {
            let row: (i32,) = sqlx::query_as(
                "INSERT INTO users (username, salt, verifier) VALUES ($1, '00', '00') RETURNING id",
            )
            .bind(name)
            .fetch_one(&pool)
            .await
            .expect("insert user");
            row.0
        }
    };
    // The server OWNER is a different account: servers.owner_id is ON DELETE
    // CASCADE, so deleting the owner would take the server — and its audit rows
    // — with it, and the test would pass for the wrong reason.
    let owner = mk_user(format!("info11_own_{}", &tag[..8])).await;
    let actor = mk_user(format!("info11_act_{}", &tag[..8])).await;

    let server_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'info11', $2)")
        .bind(&server_id)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("insert server");

    let audit: (i32,) = sqlx::query_as(
        "INSERT INTO audit_log (server_id, action_type, actor_id, target_id, target_type)          VALUES ($1, 'kick', $2, $2, 'user') RETURNING id",
    )
    .bind(&server_id)
    .bind(actor)
    .fetch_one(&pool)
    .await
    .expect("insert audit row");
    let report: (i32,) = sqlx::query_as(
        "INSERT INTO reports (server_id, reporter_id, report_type, reason)          VALUES ($1, $2, 'spam', 'because') RETURNING id",
    )
    .bind(&server_id)
    .bind(actor)
    .fetch_one(&pool)
    .await
    .expect("insert report row");

    // THE ASSERTION. Not `let _ =`: every DELETE FROM users in this tree
    // swallows its error, which is exactly how this stayed invisible.
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(actor)
        .execute(&pool)
        .await
        .expect("a hard user delete must succeed — migration 056 not applied?");

    let a: (Option<i32>,) = sqlx::query_as("SELECT actor_id FROM audit_log WHERE id = $1")
        .bind(audit.0)
        .fetch_one(&pool)
        .await
        .expect("the audit row must SURVIVE the delete, with a null actor");
    assert_eq!(a.0, None, "the actor must be anonymised, not left dangling");

    let r: (Option<i32>,) = sqlx::query_as("SELECT reporter_id FROM reports WHERE id = $1")
        .bind(report.0)
        .fetch_one(&pool)
        .await
        .expect("the report row must SURVIVE the delete, with a null reporter");
    assert_eq!(r.0, None);

    // Cleanup: the server cascades its audit/report rows, then the owner.
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(&server_id)
        .execute(&pool)
        .await;
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(owner)
        .execute(&pool)
        .await;
}
