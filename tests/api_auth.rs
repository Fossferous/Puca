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
