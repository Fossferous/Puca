//! Integration tests for E2EE channel-key storage and the member-generation
//! rotation trigger (migration 015).
//!
//! These use a real database and self-skip when none is configured, matching
//! the style of `api_auth.rs`. Run with a test DB:
//!   TEST_DATABASE_URL=postgres://... cargo test --test e2ee_keys

use sqlx::{postgres::PgPoolOptions, PgPool};

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

/// Create a throwaway user and return its id.
async fn make_user(pool: &PgPool, tag: &str) -> i32 {
    let username = format!("e2ee_{}_{}", tag, uuid::Uuid::new_v4());
    let row: (i32,) = sqlx::query_as(
        "INSERT INTO users (username, salt, verifier) VALUES ($1, '00', '00') RETURNING id",
    )
    .bind(&username)
    .fetch_one(pool)
    .await
    .expect("insert user");
    row.0
}

/// Create a server owned by `owner` and a text channel in it; returns (server_id, channel_id).
async fn make_server_channel(pool: &PgPool, owner: i32) -> (String, i32) {
    let server_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'test', $2)")
        .bind(&server_id)
        .bind(owner)
        .execute(pool)
        .await
        .expect("insert server");
    let channel: (i32,) = sqlx::query_as(
        "INSERT INTO channels (name, type, server_id) VALUES ('general', 0, $1) RETURNING id",
    )
    .bind(&server_id)
    .fetch_one(pool)
    .await
    .expect("insert channel");
    (server_id, channel.0)
}

async fn generation(pool: &PgPool, server_id: &str) -> i32 {
    let g: (i32,) = sqlx::query_as("SELECT member_generation FROM servers WHERE id = $1")
        .bind(server_id)
        .fetch_one(pool)
        .await
        .expect("select generation");
    g.0
}

#[tokio::test]
async fn membership_change_bumps_generation_and_purges_keys() {
    dotenv::dotenv().ok();
    let pool = match create_test_pool().await {
        Some(p) => p,
        None => {
            println!("Skipping: no database connection");
            return;
        }
    };

    let owner = make_user(&pool, "owner").await;
    let member = make_user(&pool, "member").await;
    let (server_id, channel_id) = make_server_channel(&pool, owner).await;

    let gen_start = generation(&pool, &server_id).await;

    // Joining bumps the generation (trigger on INSERT).
    sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)")
        .bind(&server_id)
        .bind(member)
        .execute(&pool)
        .await
        .expect("add member");
    let gen_after_join = generation(&pool, &server_id).await;
    assert_eq!(gen_after_join, gen_start + 1, "join should bump generation");

    // Give the member a wrapped channel key.
    sqlx::query(
        "INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, sender_public_key, member_generation) VALUES ($1, 1, $2, 'w', 'x25519:pk', $3)",
    )
    .bind(channel_id)
    .bind(member)
    .bind(gen_after_join)
    .execute(&pool)
    .await
    .expect("insert channel key");

    // Removing the member bumps generation again AND deletes their keys.
    sqlx::query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2")
        .bind(&server_id)
        .bind(member)
        .execute(&pool)
        .await
        .expect("remove member");

    let gen_after_leave = generation(&pool, &server_id).await;
    assert_eq!(
        gen_after_leave,
        gen_after_join + 1,
        "leave should bump generation"
    );

    let remaining: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM channel_keys WHERE channel_id = $1 AND recipient_id = $2",
    )
    .bind(channel_id)
    .bind(member)
    .fetch_one(&pool)
    .await
    .expect("count keys");
    assert_eq!(
        remaining.0, 0,
        "removed member's wrapped keys must be purged"
    );

    // Cleanup (cascades remove server_members/channel_keys/channels).
    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(&server_id)
        .execute(&pool)
        .await;
    let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)")
        .bind(vec![owner, member])
        .execute(&pool)
        .await;
}

#[tokio::test]
async fn channel_key_upsert_round_trips() {
    dotenv::dotenv().ok();
    let pool = match create_test_pool().await {
        Some(p) => p,
        None => {
            println!("Skipping: no database connection");
            return;
        }
    };

    let owner = make_user(&pool, "owner").await;
    let (server_id, channel_id) = make_server_channel(&pool, owner).await;

    // Insert then upsert the same (channel, epoch, recipient) — should update.
    for wrapped in ["first", "second"] {
        sqlx::query(
            r#"INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, sender_public_key, member_generation)
               VALUES ($1, 1, $2, $3, 'x25519:pk', 0)
               ON CONFLICT (channel_id, epoch, recipient_id)
               DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key"#,
        )
        .bind(channel_id)
        .bind(owner)
        .bind(wrapped)
        .execute(&pool)
        .await
        .expect("upsert key");
    }

    let row: (String,) = sqlx::query_as(
        "SELECT wrapped_key FROM channel_keys WHERE channel_id = $1 AND epoch = 1 AND recipient_id = $2",
    )
    .bind(channel_id)
    .bind(owner)
    .fetch_one(&pool)
    .await
    .expect("select key");
    assert_eq!(row.0, "second", "upsert should overwrite the wrapped key");

    let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
        .bind(&server_id)
        .execute(&pool)
        .await;
    let _ = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(owner)
        .execute(&pool)
        .await;
}
