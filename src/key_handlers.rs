//! E2EE Channel Key Handlers
//!
//! Distributes wrapped per-channel group keys between members. The server only
//! ever stores/relays opaque wrapped-key blobs — it cannot read the channel key
//! or any message content.

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::Claims;
use crate::permissions::{get_user_channel_permissions, ChannelPermAccess, Permissions};
use crate::state::AppState;

// --- DTOs ---

#[derive(Deserialize)]
pub struct WrappedKeyInput {
    pub recipient_id: i64,
    pub wrapped_key: String,
    pub sender_public_key: String,
}

#[derive(Deserialize)]
pub struct PublishKeysRequest {
    pub epoch: i32,
    /// Server member generation this key set was minted for (from the last
    /// get_channel_keys response). Defaults to 0 for older clients.
    #[serde(default)]
    pub member_generation: i32,
    pub keys: Vec<WrappedKeyInput>,
}

#[derive(Serialize)]
pub struct WrappedKeyOutput {
    pub epoch: i32,
    pub wrapped_key: String,
    pub sender_public_key: String,
    /// Which user wrapped this key. The recipient pins `sender_public_key`
    /// against this user's pinned identity key rather than trusting it as
    /// served. NULL for rows predating migration 037.
    pub sender_user_id: Option<i64>,
}

/// The epoch `get_channel_keys` reports to a caller: the newest epoch that
/// caller actually HOLDS, falling back to the channel's newest when they hold
/// nothing.
///
/// PUBLIC, AND USED BY THE HANDLER, so that `tests/e2ee_keys.rs` exercises the
/// very string the server runs. A regression test that pastes its own copy of
/// a query proves the query is right and nothing about the code path — revert
/// the handler and such a test stays green. Binding both to this constant is
/// what makes the test fail if anyone puts the unfiltered `MAX(epoch)` back.
///
/// $1 = channel id, $2 = calling user id.
pub const CURRENT_EPOCH_FOR_CALLER_SQL: &str = r#"
    SELECT COALESCE(
        MAX(epoch) FILTER (WHERE recipient_id = $2),
        MAX(epoch)
    )
    FROM channel_keys WHERE channel_id = $1
"#;

#[derive(Serialize)]
pub struct ChannelKeysResponse {
    /// Highest epoch that exists for this channel (0 if none yet).
    pub current_epoch: i32,
    /// The server's current member generation.
    pub current_generation: i32,
    /// The member generation the current epoch was minted for. If this differs
    /// from `current_generation`, membership changed and a holder should rotate.
    pub epoch_generation: i32,
    /// Wrapped keys addressed to the calling user, one per epoch they can access.
    pub keys: Vec<WrappedKeyOutput>,
}

#[derive(Serialize)]
pub struct MemberKey {
    pub user_id: i64,
    pub public_key: Option<String>,
}

// --- Handlers ---

/// Publish wrapped channel keys for a new (or rotated) epoch.
///
/// The caller must be a member of the channel's server. They generate a channel
/// key client-side, wrap it for every member, and POST the wrapped copies here.
pub async fn publish_channel_keys(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<PublishKeysRequest>,
) -> impl IntoResponse {
    // Key custody follows visibility: a member VIEW-denied on the channel can
    // neither publish nor fetch its keys, and sees the same 404 as a missing
    // channel (hide its existence).
    match get_user_channel_permissions(&state.pool, channel_id, claims.sub).await {
        ChannelPermAccess::Allowed { perms, .. } if perms.has(Permissions::VIEW_CHANNEL) => {}
        ChannelPermAccess::Allowed { .. } | ChannelPermAccess::NotFound => {
            return (StatusCode::NOT_FOUND, "Channel not found").into_response()
        }
        ChannelPermAccess::NotMember => {
            return (StatusCode::FORBIDDEN, "Not a member of this server").into_response()
        }
    }

    if payload.keys.is_empty() {
        return (StatusCode::BAD_REQUEST, "No keys provided").into_response();
    }
    if payload.keys.len() > 1000 {
        return (StatusCode::BAD_REQUEST, "Too many keys in one request").into_response();
    }

    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("Failed to begin key tx: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to store keys").into_response();
        }
    };

    // Server-serialized epoch ownership. Two members rotating at the same instant
    // with slightly different membership views would otherwise write a MIXED
    // epoch (some recipients get key A, others key B) → those members can't
    // decrypt each other. Serialize all publishers of the same (channel, epoch)
    // with a transaction advisory lock, then let only ONE sender establish the
    // epoch; a rival sender is told (409) to adopt the winner's key instead.
    // (channel ids are SERIAL/i32, so the i32 cast is lossless.)
    if let Err(e) = sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(channel_id as i32)
        .bind(payload.epoch)
        .execute(&mut *tx)
        .await
    {
        tracing::error!("Failed to take epoch advisory lock: {:?}", e);
        let _ = tx.rollback().await;
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to store keys").into_response();
    }

    // M5: bound the epoch. Clients number epochs 1,2,3,… (bootstrap epoch 1, then
    // currentEpoch+1 per rotation), so a publish may only (a) re-establish an
    // existing epoch (adopt/re-wrap, governed by the sender check below) or (b)
    // create exactly MAX(epoch)+1. Without this a member could publish
    // epoch = i32::MAX wrapped only for themselves; every other member's rotation
    // target (max+1) would then overflow/be unreachable — a permanent channel-key
    // DoS. Read MAX under the advisory lock so it reflects the latest commit.
    let max_epoch: (Option<i32>,) =
        sqlx::query_as("SELECT MAX(epoch) FROM channel_keys WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap_or((None,));
    let max_epoch_val = max_epoch.0.unwrap_or(0);
    if payload.epoch < 1 || payload.epoch > max_epoch_val.saturating_add(1) {
        let _ = tx.rollback().await;
        return (StatusCode::BAD_REQUEST, "Invalid epoch").into_response();
    }

    // All keys in one publish carry the minter's own public key; use the first as
    // this publish's claiming sender. Every OTHER element must equal it — the
    // INSERT below binds each element's own `sender_public_key`, so checking
    // only the first let a member pass the identity check with keys[0] while
    // writing an attacker-chosen wrapper key into a targeted recipient's row.
    let this_sender = payload
        .keys
        .first()
        .map(|k| k.sender_public_key.as_str())
        .unwrap_or("");
    if payload
        .keys
        .iter()
        .any(|k| k.sender_public_key != this_sender)
    {
        let _ = tx.rollback().await;
        return (
            StatusCode::BAD_REQUEST,
            "every key in a publish must carry the same sender_public_key",
        )
            .into_response();
    }

    // The wrapper must present THEIR OWN identity key. `sender_public_key` is
    // what recipients unwrap against and now what they pin, so a client that
    // published someone else's key — or a key belonging to nobody — would either
    // frame that member or install an unpinnable one. This cannot stop a
    // malicious SERVER (it owns the response either way); it stops a malicious
    // CLIENT, and it keeps the stored provenance honest for everyone else.
    let my_pubkey: Option<(Option<String>,)> =
        sqlx::query_as("SELECT public_key FROM users WHERE id = $1")
            .bind(claims.sub as i32)
            .fetch_optional(&mut *tx)
            .await
            .unwrap_or(None);
    match my_pubkey.and_then(|(k,)| k) {
        Some(k) if k == this_sender => {}
        _ => {
            let _ = tx.rollback().await;
            return (
                StatusCode::BAD_REQUEST,
                "sender_public_key must be your own identity key",
            )
                .into_response();
        }
    }
    let existing_sender: Option<(String,)> = sqlx::query_as(
        "SELECT sender_public_key FROM channel_keys WHERE channel_id = $1 AND epoch = $2 LIMIT 1",
    )
    .bind(channel_id)
    .bind(payload.epoch)
    .fetch_optional(&mut *tx)
    .await
    .unwrap_or(None);
    if let Some((owner,)) = existing_sender {
        if owner != this_sender {
            // Epoch already established by another member — don't write a rival key.
            let _ = tx.rollback().await;
            return (
                StatusCode::CONFLICT,
                "Epoch already published by another member",
            )
                .into_response();
        }
    }

    for k in &payload.keys {
        let res = sqlx::query(
            r#"
            INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, sender_public_key, member_generation, sender_user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (channel_id, epoch, recipient_id)
            DO NOTHING
            "#,
        )
        .bind(channel_id)
        .bind(payload.epoch)
        .bind(k.recipient_id as i32)
        .bind(&k.wrapped_key)
        .bind(&k.sender_public_key)
        .bind(payload.member_generation)
        // Who wrapped it — the recipient pins `sender_public_key` against this
        // user's pinned identity key instead of trusting it blind (migration 037).
        .bind(claims.sub as i32)
        .execute(&mut *tx)
        .await;

        if let Err(e) = res {
            tracing::error!("Failed to insert channel key: {:?}", e);
            let _ = tx.rollback().await;
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to store keys").into_response();
        }
    }

    if let Err(e) = tx.commit().await {
        tracing::error!("Failed to commit channel keys: {:?}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to store keys").into_response();
    }

    StatusCode::OK.into_response()
}

/// Fetch the wrapped channel keys addressed to the calling user, plus the
/// current epoch so the client knows which key to encrypt new messages with.
pub async fn get_channel_keys(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // VIEW-gated: a member who cannot see the channel must not receive its
    // wrapped keys (404, hiding the channel's existence).
    let server_id = match get_user_channel_permissions(&state.pool, channel_id, claims.sub).await {
        ChannelPermAccess::Allowed { server_id, perms } if perms.has(Permissions::VIEW_CHANNEL) => {
            server_id
        }
        ChannelPermAccess::Allowed { .. } | ChannelPermAccess::NotFound => {
            return (StatusCode::NOT_FOUND, "Channel not found").into_response()
        }
        ChannelPermAccess::NotMember => {
            return (StatusCode::FORBIDDEN, "Not a member of this server").into_response()
        }
    };

    // THE EPOCH THIS CALLER CAN ACTUALLY USE, not the highest that exists.
    //
    // This was a bare `MAX(epoch)` over the whole channel, and that is a
    // permanent, member-triggerable send freeze for everyone else. The publish
    // bound above deliberately allows any member to create MAX+1, and nothing
    // requires them to wrap it for anybody but themselves. Every other member
    // is then told `current_epoch = N`, holds no key for N, and
    // `ensureChannelKey` falls to its last branch — "a key exists but wasn't
    // wrapped for us, we can't send securely" — returning null. It re-reads
    // this value on every send and gets the same answer, so there is no
    // client-side recovery and no error the user can act on: the channel just
    // stops accepting their messages, silently and for good.
    //
    // It does not take an attacker. A member whose public key was not yet
    // published when someone else rotated reaches the identical state through
    // ordinary use.
    //
    // Answering with the highest epoch THIS caller holds makes the client's
    // rotation arithmetic work again: it holds that key, so it is allowed to
    // rotate from it, and publish accepts channel-MAX+1. A caller holding
    // nothing (a genuinely new member) still needs the channel-wide value, or
    // it would try to bootstrap epoch 1 over an established channel and be
    // refused by the same bound.
    let current_epoch: (Option<i32>,) = sqlx::query_as(CURRENT_EPOCH_FOR_CALLER_SQL)
        .bind(channel_id)
        .bind(claims.sub as i32)
        .fetch_one(&state.pool)
        .await
        .unwrap_or((None,));
    let current_epoch_val = current_epoch.0.unwrap_or(0);

    let current_generation: (i32,) =
        sqlx::query_as("SELECT member_generation FROM servers WHERE id = $1")
            .bind(&server_id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or((0,));

    // Generation the current epoch was minted for (any row of that epoch).
    let epoch_generation: (Option<i32>,) = sqlx::query_as(
        "SELECT member_generation FROM channel_keys WHERE channel_id = $1 AND epoch = $2 LIMIT 1",
    )
    .bind(channel_id)
    .bind(current_epoch_val)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None)
    .unwrap_or((None,));

    // `sender_user_id` is Option: rows written before migration 037 have no
    // wrapper identity and cannot gain one. The client treats NULL as "legacy,
    // unverifiable" and still unwraps it, so old epochs stay readable.
    let rows: Vec<(i32, String, String, Option<i32>)> = sqlx::query_as(
        r#"
        SELECT epoch, wrapped_key, sender_public_key, sender_user_id
        FROM channel_keys
        WHERE channel_id = $1 AND recipient_id = $2
        ORDER BY epoch ASC
        "#,
    )
    .bind(channel_id)
    .bind(claims.sub as i32)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let keys = rows
        .into_iter()
        .map(
            |(epoch, wrapped_key, sender_public_key, sender_user_id)| WrappedKeyOutput {
                epoch,
                wrapped_key,
                sender_public_key,
                sender_user_id: sender_user_id.map(|v| v as i64),
            },
        )
        .collect();

    Json(ChannelKeysResponse {
        current_epoch: current_epoch_val,
        current_generation: current_generation.0,
        epoch_generation: epoch_generation.0.unwrap_or(0),
        keys,
    })
    .into_response()
}

/// List the public keys of every member of the channel's server, so a
/// distributor can wrap a new channel key for all of them.
pub async fn get_member_keys(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<i64>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Same VIEW gate as get_channel_keys: member public keys for wrapping are
    // only served to users who can see the channel.
    let server_id = match get_user_channel_permissions(&state.pool, channel_id, claims.sub).await {
        ChannelPermAccess::Allowed { server_id, perms } if perms.has(Permissions::VIEW_CHANNEL) => {
            server_id
        }
        ChannelPermAccess::Allowed { .. } | ChannelPermAccess::NotFound => {
            return (StatusCode::NOT_FOUND, "Channel not found").into_response()
        }
        ChannelPermAccess::NotMember => {
            return (StatusCode::FORBIDDEN, "Not a member of this server").into_response()
        }
    };

    let rows: Vec<(i32, Option<String>)> = sqlx::query_as(
        r#"
        SELECT u.id, u.public_key
        FROM server_members sm
        JOIN users u ON sm.user_id = u.id
        WHERE sm.server_id = $1
        "#,
    )
    .bind(&server_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    // Only hand out keys for members who can VIEW this channel — otherwise
    // every future epoch key gets wrapped for VIEW-denied members too, making
    // the deny transport-only instead of cryptographic. Fail closed.
    let viewers =
        match crate::permissions::get_channel_viewer_ids(&state.pool, channel_id, &server_id).await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(
                    "get_member_keys: viewer resolve failed for channel {}: {:?}",
                    channel_id,
                    e
                );
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to resolve channel members",
                )
                    .into_response();
            }
        };

    let members: Vec<MemberKey> = rows
        .into_iter()
        .filter(|(user_id, _)| viewers.contains(&(*user_id as i64)))
        .map(|(user_id, public_key)| MemberKey {
            user_id: user_id as i64,
            public_key,
        })
        .collect();

    Json(members).into_response()
}

#[cfg(test)]
mod current_epoch_tests {
    use super::CURRENT_EPOCH_FOR_CALLER_SQL;
    use sqlx::{postgres::PgPoolOptions, PgPool};

    /// Self-skips when no throwaway database is configured, like the harnesses
    /// in `tests/`. NEVER point this at a real database: it inserts users,
    /// a server, a channel and channel keys, then deletes them.
    ///
    ///   TEST_DATABASE_URL=postgres://postgres@localhost:5434/db cargo test
    async fn pool() -> Option<PgPool> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        PgPoolOptions::new().max_connections(2).connect(&url).await.ok()
    }

    async fn make_user(pool: &PgPool, tag: &str) -> i32 {
        let username = format!("epoch_{tag}_{}", uuid::Uuid::new_v4());
        let row: (i32,) = sqlx::query_as(
            "INSERT INTO users (username, salt, verifier) VALUES ($1, '00', '00') RETURNING id",
        )
        .bind(&username)
        .fetch_one(pool)
        .await
        .expect("insert user");
        row.0
    }

    async fn epoch_reported_to(pool: &PgPool, channel_id: i32, user_id: i32) -> i32 {
        let r: (Option<i32>,) = sqlx::query_as(CURRENT_EPOCH_FOR_CALLER_SQL)
            .bind(channel_id)
            .bind(user_id)
            .fetch_one(pool)
            .await
            .expect("current-epoch query");
        r.0.unwrap_or(0)
    }

    /// A member who mints an epoch only for themselves must not freeze the
    /// channel for everybody else.
    ///
    /// THE BUG THIS PINS. `get_channel_keys` answered `current_epoch` with a
    /// bare `MAX(epoch)` across the whole channel, while `publish_channel_keys`
    /// deliberately permits any member to create MAX+1 and never requires them
    /// to wrap it for anyone else. One member publishing epoch 2 for themselves
    /// alone therefore left every other member told "the current epoch is 2"
    /// holding no key for it — and `ensureChannelKey` ends at its final branch,
    /// "a key exists but wasn't wrapped for us", returning null on every send
    /// from then on. Re-fetching cannot change the answer, so there is no
    /// client-side recovery and no error the user can act on.
    ///
    /// It needs no attacker: a member whose public key had not been published
    /// when somebody else rotated arrives in the same state.
    ///
    /// IN THIS MODULE, not `tests/`, deliberately — this crate has no lib
    /// target, so an integration test could only paste its own copy of the
    /// query and would stay green after someone reverted the handler. Here it
    /// runs `CURRENT_EPOCH_FOR_CALLER_SQL` itself, the same constant the
    /// handler binds.
    #[tokio::test]
    async fn an_epoch_minted_for_one_member_does_not_freeze_the_others() {
        let Some(pool) = pool().await else {
            eprintln!("skipping: TEST_DATABASE_URL not set");
            return;
        };
        let squatter = make_user(&pool, "squat").await;
        let victim = make_user(&pool, "victim").await;
        let newcomer = make_user(&pool, "new").await;

        let server_id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'epoch-test', $2)")
            .bind(&server_id)
            .bind(squatter)
            .execute(&pool)
            .await
            .expect("insert server");
        let ch: (i32,) = sqlx::query_as(
            "INSERT INTO channels (server_id, name, type) VALUES ($1, 'general', 0) RETURNING id",
        )
        .bind(&server_id)
        .fetch_one(&pool)
        .await
        .expect("insert channel");
        let channel_id = ch.0;

        // Epoch 1 wrapped for BOTH: the ordinary, healthy state.
        for uid in [squatter, victim] {
            sqlx::query(
                "INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, \
                 sender_public_key, member_generation) VALUES ($1, 1, $2, 'w', 'x25519:pk', 0)",
            )
            .bind(channel_id)
            .bind(uid)
            .execute(&pool)
            .await
            .expect("insert epoch 1");
        }
        // Epoch 2 wrapped for the squatter ONLY — which the publish bound allows.
        sqlx::query(
            "INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, \
             sender_public_key, member_generation) VALUES ($1, 2, $2, 'w', 'x25519:pk', 0)",
        )
        .bind(channel_id)
        .bind(squatter)
        .execute(&pool)
        .await
        .expect("insert epoch 2");

        // The victim is told 1 — an epoch they HOLD, so they can still send and
        // can rotate to 3 from it. This is the whole fix.
        assert_eq!(
            epoch_reported_to(&pool, channel_id, victim).await,
            1,
            "the victim must be told the newest epoch they actually hold, or they can never send again",
        );
        assert_eq!(
            epoch_reported_to(&pool, channel_id, squatter).await,
            2,
            "a member who holds epoch 2 should be told 2",
        );
        // Holding nothing, a new member still needs the channel-wide value: told
        // 0 they would try to bootstrap epoch 1 over an established channel, and
        // the publish bound would refuse it.
        assert_eq!(
            epoch_reported_to(&pool, channel_id, newcomer).await,
            2,
            "a member holding no key must fall back to the channel-wide max, not 0",
        );

        // POSITIVE CONTROL. The OLD query against the SAME rows must hand the
        // victim an epoch they do not hold — otherwise the fixture never
        // reproduced the bug and the assertions above prove nothing.
        let old: (Option<i32>,) =
            sqlx::query_as("SELECT MAX(epoch) FROM channel_keys WHERE channel_id = $1")
                .bind(channel_id)
                .fetch_one(&pool)
                .await
                .expect("old query");
        assert_eq!(
            old.0.unwrap_or(0),
            2,
            "control: the old unfiltered query must report an epoch the victim cannot use",
        );

        let _ = sqlx::query("DELETE FROM servers WHERE id = $1")
            .bind(&server_id)
            .execute(&pool)
            .await;
        for uid in [squatter, victim, newcomer] {
            let _ = sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(uid)
                .execute(&pool)
                .await;
        }
    }
}
