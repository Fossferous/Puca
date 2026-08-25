//! When to ring the doorbell, and for whom.
//!
//! Called from the two notification fan-outs (channel messages, DMs) for each
//! recipient whose `send_to_user` returned false — no live session at all, the
//! phone's delivery socket included. A healthy socket means this module never
//! runs.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::state::AppState;

/// One wake covers a burst: a device that has not answered the first ring will
/// not answer the fifth, and each extra signal is an extra Google-visible
/// event for zero delivery value.
const MIN_WAKE_INTERVAL: Duration = Duration::from_secs(30);

/// Server-side wake gates from `notification_preferences` — the table's only
/// readers live in this module and its removed FCM predecessor. `push_enabled`
/// off means the user asked for silence: waking their phone anyway would spend
/// battery and emit a Google-visible event for a notification the device
/// would then refuse to show. Quiet hours likewise: the DEVICE cannot honour
/// them (its mirror holds mutes, not schedules), so the server must.
async fn prefs_allow_wake(state: &Arc<AppState>, user_id: i64) -> bool {
    let row: Option<(bool, Option<chrono::NaiveTime>, Option<chrono::NaiveTime>)> =
        sqlx::query_as(
            "SELECT COALESCE(push_enabled, true), quiet_hours_start, quiet_hours_end \
             FROM notification_preferences WHERE user_id = $1",
        )
        .bind(user_id as i32)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
    let (enabled, qs, qe) = match row {
        Some(r) => r,
        None => return true, // no row = defaults on, the overwhelmingly common case
    };
    if !enabled {
        return false;
    }
    if let (Some(start), Some(end)) = (qs, qe) {
        // HONEST LIMIT: compared in UTC — the schema stores no timezone, so a
        // non-UTC user's window is shifted by their offset. Currently inert
        // (no shipped client writes these prefs); whoever builds that UI must
        // add a timezone column or store the window in UTC explicitly.
        let now = chrono::Utc::now().time();
        let quiet = if start <= end {
            now >= start && now < end
        } else {
            // The wrap-past-midnight shape people actually configure.
            now >= start || now < end
        };
        if quiet {
            return false;
        }
    }
    true
}

/// Ring `user_id`'s registered Android devices. Fire-and-forget: message-send
/// paths must never wait on Google. Dead tokens are pruned from the response —
/// FCM's answer is the only staleness signal that exists.
pub fn wake_user(state: &Arc<AppState>, user_id: i64) {
    if !state.wake.enabled() {
        return;
    }
    // Rate limit BEFORE spawning: a message burst to an offline user must cost
    // one task, not one per message.
    {
        // Opportunistic prune: entries older than an hour say nothing about
        // rate any more, and without SOME removal path this map only grows.
        if state.wake_recent.len() > 1024 {
            state
                .wake_recent
                .retain(|_, at| at.elapsed() < Duration::from_secs(3600));
        }
        let now = Instant::now();
        let mut entry = state.wake_recent.entry(user_id).or_insert(now - MIN_WAKE_INTERVAL * 2);
        if now.duration_since(*entry) < MIN_WAKE_INTERVAL {
            return;
        }
        *entry = now;
    }
    let state = Arc::clone(state);
    tokio::spawn(async move {
        if !prefs_allow_wake(&state, user_id).await {
            return;
        }
        let tokens: Vec<(i32, String)> = sqlx::query_as(
            "SELECT id, token FROM device_tokens WHERE user_id = $1 AND platform = 'android'",
        )
        .bind(user_id as i32)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();
        for (row_id, token) in tokens {
            match state.wake.wake(&token).await {
                Ok(()) => {}
                Err(e) if e.is_token_dead() => {
                    let _ = sqlx::query("DELETE FROM device_tokens WHERE id = $1")
                        .bind(row_id)
                        .execute(&state.pool)
                        .await;
                    tracing::info!("wake: pruned dead device token {row_id} for user {user_id} ({e})");
                }
                Err(e) => {
                    // Never retried, never queued: the undelivered-frame queue
                    // preserves the notification; a late doorbell helps nobody.
                    tracing::warn!("wake: signal failed for user {user_id}: {e}");
                }
            }
        }
    });
}

/// The `/notifications/test` probe: ring the caller's own devices, awaited so
/// the human clicking the button gets a real answer. Returns rings attempted.
pub async fn wake_probe(state: &Arc<AppState>, user_id: i64) -> Result<usize, super::WakeError> {
    let tokens: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, token FROM device_tokens WHERE user_id = $1 AND platform = 'android'",
    )
    .bind(user_id as i32)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    let mut sent = 0usize;
    let mut last_err = None;
    for (row_id, token) in tokens {
        match state.wake.wake(&token).await {
            Ok(()) => sent += 1,
            Err(e) => {
                if e.is_token_dead() {
                    let _ = sqlx::query("DELETE FROM device_tokens WHERE id = $1")
                        .bind(row_id)
                        .execute(&state.pool)
                        .await;
                }
                last_err = Some(e);
            }
        }
    }
    match last_err {
        Some(e) if sent == 0 => Err(e),
        _ => Ok(sent),
    }
}
