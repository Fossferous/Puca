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

/// The epoch-squat regression (see `get_channel_keys`).
///
/// A member with nothing but VIEW_CHANNEL may create MAX(epoch)+1 wrapped only
/// for themselves. Under the old unfiltered `SELECT MAX(epoch)`, every OTHER
/// member was then told that squatted epoch was current — an epoch they hold no
/// key for — and `ensureChannelKey` gates rotation on holding the current key,
/// so they fell through to "cannot send", permanently, with no client-side
/// recovery.
///
/// This pins the query that fixes it: the caller's current epoch is the newest
/// one addressed to THEM, while the channel-wide max is reported separately so a
/// rotation can target a free epoch instead of colliding with the squatted one.
#[tokio::test]
async fn a_squatted_epoch_is_not_the_victims_current_epoch() {
    dotenv::dotenv().ok();
    let pool = match create_test_pool().await {
        Some(p) => p,
        None => {
            println!("Skipping: no database connection");
            return;
        }
    };

    let owner = make_user(&pool, "squat_owner").await;
    let victim = make_user(&pool, "squat_victim").await;
    let (_server_id, channel_id) = make_server_channel(&pool, owner).await;

    // Epochs 1 and 2 are wrapped for both members — the healthy state.
    for epoch in 1..=2 {
        for uid in [owner, victim] {
            sqlx::query(
                "INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, sender_public_key, member_generation) \
                 VALUES ($1, $2, $3, 'w', 'x25519:pk', 0)",
            )
            .bind(channel_id)
            .bind(epoch)
            .bind(uid)
            .execute(&pool)
            .await
            .expect("insert shared epoch");
        }
    }

    // The squat: epoch 3, wrapped for the owner alone.
    sqlx::query(
        "INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, sender_public_key, member_generation) \
         VALUES ($1, 3, $2, 'w', 'x25519:pk', 0)",
    )
    .bind(channel_id)
    .bind(owner)
    .execute(&pool)
    .await
    .expect("insert squatted epoch");

    let epochs_for = |uid: i32| {
        let pool = pool.clone();
        async move {
            let row: (Option<i32>, Option<i32>) = sqlx::query_as(
                "SELECT MAX(epoch) FILTER (WHERE recipient_id = $2), MAX(epoch) \
                 FROM channel_keys WHERE channel_id = $1",
            )
            .bind(channel_id)
            .bind(uid)
            .fetch_one(&pool)
            .await
            .expect("select epochs");
            row
        }
    };

    let (victim_mine, victim_max) = epochs_for(victim).await;
    assert_eq!(
        victim_mine,
        Some(2),
        "victim's current epoch must be the newest wrapped FOR THEM (2), not the squatted 3"
    );
    assert_eq!(
        victim_max,
        Some(3),
        "victim must still learn epoch 3 exists so a rotation can target 4"
    );

    let (owner_mine, owner_max) = epochs_for(owner).await;
    assert_eq!(owner_mine, Some(3), "the squatter does hold epoch 3");
    assert_eq!(owner_max, Some(3));

    // A member nobody has wrapped for at all: holds nothing, so the handler
    // falls back to the channel max rather than reporting 0 (which would send
    // the client down its bootstrap branch and mint a low, unused epoch).
    let newcomer = make_user(&pool, "squat_newcomer").await;
    let (new_mine, new_max) = epochs_for(newcomer).await;
    assert_eq!(new_mine, None, "newcomer holds no epoch");
    assert_eq!(new_max, Some(3));

    sqlx::query("DELETE FROM channel_keys WHERE channel_id = $1")
        .bind(channel_id)
        .execute(&pool)
        .await
        .ok();
}
