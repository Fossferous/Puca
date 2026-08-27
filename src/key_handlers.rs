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

#[derive(Serialize)]
pub struct ChannelKeysResponse {
    /// Highest epoch WRAPPED FOR THE CALLER (0 if none yet). Falls back to
    /// `max_epoch` when the caller holds nothing at all — i.e. a new member
    /// waiting to be wrapped in. Deliberately not a channel-wide MAX: see the
    /// comment in `get_channel_keys`.
    pub current_epoch: i32,
    /// Highest epoch that exists in the channel for anyone. Additive field —
    /// older clients ignore it; newer ones rotate to `max_epoch + 1` so they
    /// target a free epoch rather than colliding with one already taken.
    pub max_epoch: i32,
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

// --- Pure decisions (unit-testable without a database) ---
//
// The crate is bin-only — no src/lib.rs — so `tests/` cannot import these
// handlers. Keeping the two real decisions as free functions is what makes them
// assertable at all; the surrounding SQL is covered by tests/e2ee_keys.rs.

/// The epoch a caller should treat as current: the newest one wrapped for them,
/// falling back to the channel-wide max when they hold nothing yet (a new member
/// waiting to be wrapped in), and 0 when the channel has no keys at all.
fn effective_epoch(mine: Option<i32>, max: Option<i32>) -> i32 {
    mine.or(max).unwrap_or(0)
}

/// Clamp a client-claimed member generation into [0, server]. Understating only
/// costs an extra rotation; overstating would suppress a required one, so it is
/// made impossible. `server.max(0)` guards the clamp against an out-of-range
/// stored value (clamp panics if min > max).
fn stamp_generation(client: i32, server: i32) -> i32 {
    client.clamp(0, server.max(0))
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

    if payload.keys.is_empty() {
        return (StatusCode::BAD_REQUEST, "No keys provided").into_response();
    }
    if payload.keys.len() > 1000 {
        return (StatusCode::BAD_REQUEST, "Too many keys in one request").into_response();
    }

    // Resolved BEFORE the transaction opens, deliberately. get_channel_viewer_ids
    // takes the pool, so calling it once a tx is open would check out a SECOND
    // connection while this handler already holds one AND holds the epoch
    // advisory lock. With a 20-connection pool and a 10s acquire timeout, 20
    // concurrent publishes would each block waiting for a connection none of them
    // will release — a self-inflicted stall that looks exactly like a database
    // outage.
    let viewers = match crate::permissions::get_channel_viewer_ids(
        &state.pool,
        channel_id,
        &server_id,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(
                "publish_channel_keys: viewer resolve failed for channel {}: {:?}",
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

    // The generation is CLIENT-supplied and was previously stored verbatim, so a
    // publisher could claim the server's current generation and make
    // `epoch_generation == current_generation` for everyone — switching off the
    // signal that forces rotation after a kick. Clamping is what makes it safe
    // without inventing a new error the client cannot handle: understating can
    // only cause an extra rotation (harmless, self-correcting), while
    // overstating — the direction that suppresses a REQUIRED rotation — is now
    // impossible. It also fixes a live bug in the other direction: a client
    // posting 0 (the `#[serde(default)]` above, i.e. any older build) used to
    // stamp 0 verbatim, so every other client saw a permanent generation
    // mismatch and rotated on every single send.
    let server_generation: i32 =
        match sqlx::query_as::<_, (i32,)>("SELECT member_generation FROM servers WHERE id = $1")
            .bind(&server_id)
            .fetch_one(&mut *tx)
            .await
        {
            Ok((g,)) => g,
            Err(e) => {
                tracing::error!("publish_channel_keys: generation read failed: {:?}", e);
                let _ = tx.rollback().await;
                return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to store keys").into_response();
            }
        };
    let stamped_generation = stamp_generation(payload.member_generation, server_generation);

    // Recipients are FILTERED to channel viewers, not rejected. A malicious
    // client could otherwise address rows to anyone at all; but rejecting the
    // whole publish would break an honest one, because there is a benign race —
    // the client fetches /member-keys, a moderator changes an overwrite, then the
    // client posts. Dropping is sufficient and never fails a send:
    // broadcast_perms_changed_and_evict bumps the generation on that same path,
    // so a rotation follows regardless. (get_member_keys already applies this
    // rule when handing out keys to wrap; this is the same rule enforced against
    // a client that ignores it.)
    let mut dropped_non_viewers: Vec<i64> = Vec::new();
    for k in payload.keys.iter() {
        if !viewers.contains(&k.recipient_id) {
            dropped_non_viewers.push(k.recipient_id);
            continue;
        }
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
        .bind(stamped_generation)
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

    if !dropped_non_viewers.is_empty() {
        // Only a sample of the ids: this list is client-controlled and the
        // payload cap allows 1000 of them, so logging it whole would let a
        // caller write an arbitrarily long line into the log on demand.
        tracing::warn!(
            "publish_channel_keys: channel {} epoch {} by user {} named {} non-viewer recipient(s) (first few: {:?}); dropped",
            channel_id, payload.epoch, claims.sub, dropped_non_viewers.len(),
            &dropped_non_viewers[..dropped_non_viewers.len().min(10)]
        );
    }

    if payload.keys.len() == dropped_non_viewers.len() {
        // Nothing was written, so committing would report success for an epoch
        // that does not exist. 409 rather than 400 because it is the one status
        // the client already handles gracefully (mintEpoch treats it as "someone
        // else won this epoch", refetches, and retries on the next send) instead
        // of rethrowing it as a hard send failure.
        let _ = tx.rollback().await;
        return (
            StatusCode::CONFLICT,
            "No recipients in this publish can view the channel",
        )
            .into_response();
    }

    // Coverage telemetry, deliberately NOT an error. An honest client legitimately
    // omits a viewer whose served identity key conflicts with a local pin or a
    // confirmed safety number (pinServedIdentityKey skips them, by design — audit
    // M6). That pin state lives in one browser's localStorage, so the server can
    // neither reconstruct it nor tell it apart from an attack; enforcing coverage
    // here would reject a legitimate, security-motivated publish and take the
    // whole channel down. Logging keeps the abuse signal, keyed to a real user id,
    // at zero availability cost.
    let covered: std::collections::HashSet<i64> = payload
        .keys
        .iter()
        .map(|k| k.recipient_id)
        .filter(|id| viewers.contains(id))
        .collect();
    let uncovered: Vec<i64> = viewers.difference(&covered).copied().collect();
    if !uncovered.is_empty() {
        tracing::warn!(
            "publish_channel_keys: channel {} epoch {} by user {} covers {}/{} viewers; uncovered (first few): {:?}",
            channel_id, payload.epoch, claims.sub, covered.len(), viewers.len(),
            &uncovered[..uncovered.len().min(10)]
        );
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

    // A caller's CURRENT epoch is the newest one actually ADDRESSED TO THEM, not
    // the newest that exists. An unfiltered MAX(epoch) hands back a pointer the
    // caller may be unable to follow: any member may create MAX+1 (the bound at
    // the top of publish_channel_keys permits exactly that) wrapped only for
    // themselves, and every other member then reads a `current_epoch` they hold
    // no key for. ensureChannelKey gates rotation on HOLDING the current key
    // (channelKeys.ts: "Only a holder of the current key can rotate"), so those
    // members fall straight through to `return null` — unable to send, with no
    // client-side recovery, permanently. An epoch that was never wrapped for you
    // is not your epoch.
    //
    // `max_epoch` is served alongside so a client that CAN rotate targets the
    // true next epoch instead of colliding with the squatted one and taking the
    // 409 forever.
    let epochs: (Option<i32>, Option<i32>) = match sqlx::query_as(
        "SELECT MAX(epoch) FILTER (WHERE recipient_id = $2), MAX(epoch) \
         FROM channel_keys WHERE channel_id = $1",
    )
    .bind(channel_id)
    .bind(claims.sub as i32)
    .fetch_one(&state.pool)
    .await
    {
        Ok(v) => v,
        Err(e) => {
            // Previously swallowed silently. Preserve the old fail-soft shape
            // (report "no keys yet") rather than 500ing, because this endpoint is
            // also on the message READ path — decryptChannelContent does not catch,
            // so a 500 here rejects the whole Promise.all and blanks the channel
            // on a transient pool blip.
            tracing::error!(
                "get_channel_keys: epoch read failed for channel {}: {:?}",
                channel_id,
                e
            );
            (None, None)
        }
    };
    let max_epoch_val = epochs.1.unwrap_or(0);
    // Holding nothing at all falls back to the global max on purpose: that is the
    // legitimate "new member, waiting to be wrapped in" state, and reporting 0
    // instead would send the client down its bootstrap branch to mint a LOW epoch
    // nobody else uses.
    let current_epoch_val = effective_epoch(epochs.0, epochs.1);

    let current_generation: (i32,) =
        match sqlx::query_as::<_, (i32,)>("SELECT member_generation FROM servers WHERE id = $1")
            .bind(&server_id)
            .fetch_one(&state.pool)
            .await
        {
            Ok(g) => g,
            Err(e) => {
                tracing::error!(
                    "get_channel_keys: generation read failed for server {}: {:?}",
                    server_id,
                    e
                );
                // Fail closed TOWARD ROTATION, not toward 500. This used to
                // default to 0, which silently matched a missing/zero
                // epoch_generation and told every client "membership unchanged" —
                // so the rotation a kick should have forced never happened. -1 can
                // never equal a stored generation (always >= 0), so holders rotate
                // instead. Sends fail safe; reads keep working.
                (-1,)
            }
        };

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
        max_epoch: max_epoch_val,
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
mod tests {
    use super::*;

    // The squat: victim holds up to epoch 2, attacker mints 3 for themselves.
    // The victim must stay on 2 (still sendable) and learn that 3 exists so a
    // rotation can target 4 rather than colliding with 3.
    #[test]
    fn caller_keeps_their_own_newest_epoch_when_a_later_one_is_squatted() {
        assert_eq!(effective_epoch(Some(2), Some(3)), 2);
    }

    #[test]
    fn squatter_still_sees_their_own_epoch() {
        assert_eq!(effective_epoch(Some(3), Some(3)), 3);
    }

    // A member nobody has wrapped for yet must NOT be told 0 — that would send
    // the client down its bootstrap branch and mint a low, unused epoch.
    #[test]
    fn holding_nothing_falls_back_to_the_channel_max() {
        assert_eq!(effective_epoch(None, Some(3)), 3);
    }

    #[test]
    fn empty_channel_reports_zero() {
        assert_eq!(effective_epoch(None, None), 0);
    }

    // Older clients send 0 (serde default). They must not be rejected, and must
    // not silently inherit a coverage claim they never made.
    #[test]
    fn legacy_zero_generation_is_preserved_not_promoted() {
        assert_eq!(stamp_generation(0, 7), 0);
    }

    // The attack this closes: claiming the current generation to switch off
    // every other client's rotation signal.
    #[test]
    fn generation_cannot_be_overstated() {
        assert_eq!(stamp_generation(9, 7), 7);
        assert_eq!(stamp_generation(i32::MAX, 7), 7);
    }

    #[test]
    fn honest_generation_passes_through() {
        assert_eq!(stamp_generation(7, 7), 7);
        assert_eq!(stamp_generation(3, 7), 3);
    }

    #[test]
    fn negative_generation_never_reaches_the_column() {
        assert_eq!(stamp_generation(-1, 7), 0);
        assert_eq!(stamp_generation(-1, 0), 0);
    }
}
