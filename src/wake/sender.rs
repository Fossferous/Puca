//! When to ring the doorbell, and for whom.
//!
//! Called from the notification fan-outs (channel messages, DMs) for each
//! recipient whose `send_to_user` returned false — no live session at all, the
//! phone's delivery socket included. A healthy socket means this module never
//! runs.

use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::NaiveTime;

use crate::state::AppState;

/// One wake covers a burst: a device that has not answered the first ring will
/// not answer the fifth, and each extra signal is an extra Google-visible
/// event for zero delivery value.
const MIN_WAKE_INTERVAL: Duration = Duration::from_secs(30);

/// What is asking to ring the phone. Each kind answers to its own opt-out
/// column in `notification_preferences`; before this existed the four
/// per-category toggles were written by PATCH /notifications/preferences and
/// read by nothing, so a user who switched DM pushes off was still rung — and
/// each ring is an event Google observes against that device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WakeKind {
    /// A channel MessageNotification found the viewer offline (`push_messages`).
    /// `push_mentions` is deliberately NOT consulted: no wake path today knows
    /// whether the frame is a mention, so the column has no honest reader yet.
    ChannelMessage,
    /// A DirectMessage found the recipient offline (`push_dms`).
    DirectMessage,
    /// A friend request for an offline recipient (`push_friend_requests`).
    /// No caller exists yet — the friend handlers emit no frame — but the gate
    /// is wired so the first one cannot forget it.
    #[allow(dead_code)] // no producer yet, by design (see above); the unit tests exercise it
    FriendRequest,
}

/// The user's `notification_preferences` row as the wake decision sees it.
/// The schema's booleans are nullable (`DEFAULT TRUE`), so the query
/// COALESCEs each to on — a NULL means "never set", not "off".
#[derive(Debug, Clone, PartialEq, Eq)]
struct WakePrefs {
    push_enabled: bool,
    push_messages: bool,
    push_dms: bool,
    push_friend_requests: bool,
    quiet_hours_start: Option<NaiveTime>,
    quiet_hours_end: Option<NaiveTime>,
}

/// The whole decision, with no I/O so it can be tested: `None` is "no row",
/// the overwhelmingly common case, and means every default is on. `now` is a
/// UTC wall-clock time (see the HONEST LIMIT below).
fn prefs_permit(prefs: Option<&WakePrefs>, kind: WakeKind, now: NaiveTime) -> bool {
    let p = match prefs {
        Some(p) => p,
        None => return true, // no row = defaults on
    };
    // `push_enabled` off means the user asked for silence: waking their phone
    // anyway would spend battery and emit a Google-visible event for a
    // notification the device would then refuse to show.
    if !p.push_enabled {
        return false;
    }
    let category_on = match kind {
        WakeKind::ChannelMessage => p.push_messages,
        WakeKind::DirectMessage => p.push_dms,
        WakeKind::FriendRequest => p.push_friend_requests,
    };
    if !category_on {
        return false;
    }
    // Quiet hours: the DEVICE cannot honour them (its mirror holds mutes, not
    // schedules), so the server must.
    if let (Some(start), Some(end)) = (p.quiet_hours_start, p.quiet_hours_end) {
        // HONEST LIMIT: compared in UTC — the schema stores no timezone, so a
        // non-UTC user's window is shifted by their offset. Currently inert
        // (no shipped client writes these prefs); whoever builds that UI must
        // add a timezone column or store the window in UTC explicitly.
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

/// Server-side wake gates from `notification_preferences` — the table's only
/// readers live in this module and its removed FCM predecessor.
async fn prefs_allow_wake(state: &Arc<AppState>, user_id: i64, kind: WakeKind) -> bool {
    type Row = (bool, bool, bool, bool, Option<NaiveTime>, Option<NaiveTime>);
    let row: Result<Option<Row>, sqlx::Error> = sqlx::query_as(
        "SELECT COALESCE(push_enabled, true), COALESCE(push_messages, true), \
                COALESCE(push_dms, true), COALESCE(push_friend_requests, true), \
                quiet_hours_start, quiet_hours_end \
         FROM notification_preferences WHERE user_id = $1",
    )
    .bind(user_id as i32)
    .fetch_optional(&state.pool)
    .await;
    let prefs = match row {
        Ok(row) => row.map(|(enabled, messages, dms, friends, qs, qe)| WakePrefs {
            push_enabled: enabled,
            push_messages: messages,
            push_dms: dms,
            push_friend_requests: friends,
            quiet_hours_start: qs,
            quiet_hours_end: qe,
        }),
        Err(e) => {
            // Fail closed: a lookup that failed cannot prove the user consented
            // to this ring, and the ring is the irreversible part — the frame
            // itself is parked and survives a missed doorbell.
            tracing::warn!("wake: preference lookup failed for user {user_id}, not waking: {e}");
            return false;
        }
    };
    prefs_permit(prefs.as_ref(), kind, chrono::Utc::now().time())
}

/// Ring `user_id`'s registered Android devices for a channel message. Kept so
/// the existing fan-outs compile unchanged; new call sites say what they are
/// waking for via `wake_user_kind`.
pub fn wake_user(state: &Arc<AppState>, user_id: i64) {
    wake_user_kind(state, user_id, WakeKind::ChannelMessage)
}

/// Ring `user_id`'s registered Android devices, unless their preferences for
/// `kind` say not to. Fire-and-forget: message-send paths must never wait on
/// Google. Dead tokens are pruned from the response — FCM's answer is the only
/// staleness signal that exists.
pub fn wake_user_kind(state: &Arc<AppState>, user_id: i64, kind: WakeKind) {
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
        if !prefs_allow_wake(&state, user_id, kind).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    const KINDS: [WakeKind; 3] = [
        WakeKind::ChannelMessage,
        WakeKind::DirectMessage,
        WakeKind::FriendRequest,
    ];

    fn t(h: u32, m: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(h, m, 0).unwrap()
    }

    /// Everything on, no quiet hours — the row PATCH writes for a user who
    /// touched a preference and left the rest alone.
    fn all_on() -> WakePrefs {
        WakePrefs {
            push_enabled: true,
            push_messages: true,
            push_dms: true,
            push_friend_requests: true,
            quiet_hours_start: None,
            quiet_hours_end: None,
        }
    }

    #[test]
    fn no_row_means_every_kind_rings() {
        for kind in KINDS {
            assert!(prefs_permit(None, kind, t(12, 0)), "{kind:?}");
        }
    }

    #[test]
    fn push_enabled_off_silences_every_kind() {
        let p = WakePrefs { push_enabled: false, ..all_on() };
        for kind in KINDS {
            assert!(!prefs_permit(Some(&p), kind, t(12, 0)), "{kind:?}");
        }
    }

    #[test]
    fn a_category_opt_out_silences_only_its_own_kind() {
        // The defect this module fixes: push_dms:false used to ring anyway.
        let p = WakePrefs { push_dms: false, ..all_on() };
        assert!(!prefs_permit(Some(&p), WakeKind::DirectMessage, t(12, 0)));
        // The half that matters for the other direction: one opt-out must not
        // silence categories the user left on.
        assert!(prefs_permit(Some(&p), WakeKind::ChannelMessage, t(12, 0)));
        assert!(prefs_permit(Some(&p), WakeKind::FriendRequest, t(12, 0)));

        let p = WakePrefs { push_messages: false, ..all_on() };
        assert!(!prefs_permit(Some(&p), WakeKind::ChannelMessage, t(12, 0)));
        assert!(prefs_permit(Some(&p), WakeKind::DirectMessage, t(12, 0)));
        assert!(prefs_permit(Some(&p), WakeKind::FriendRequest, t(12, 0)));

        let p = WakePrefs { push_friend_requests: false, ..all_on() };
        assert!(!prefs_permit(Some(&p), WakeKind::FriendRequest, t(12, 0)));
        assert!(prefs_permit(Some(&p), WakeKind::ChannelMessage, t(12, 0)));
        assert!(prefs_permit(Some(&p), WakeKind::DirectMessage, t(12, 0)));
    }

    #[test]
    fn the_legacy_entry_point_is_the_channel_message_kind() {
        // wake_user delegates to ChannelMessage, so it must answer to
        // push_messages and nothing else category-wise.
        let p = WakePrefs { push_dms: false, push_friend_requests: false, ..all_on() };
        assert!(prefs_permit(Some(&p), WakeKind::ChannelMessage, t(12, 0)));
        let p = WakePrefs { push_messages: false, ..all_on() };
        assert!(!prefs_permit(Some(&p), WakeKind::ChannelMessage, t(12, 0)));
    }

    #[test]
    fn quiet_hours_apply_to_every_kind_and_only_inside_the_window() {
        let p = WakePrefs {
            quiet_hours_start: Some(t(22, 0)),
            quiet_hours_end: Some(t(23, 0)),
            ..all_on()
        };
        for kind in KINDS {
            assert!(!prefs_permit(Some(&p), kind, t(22, 30)), "{kind:?} inside");
            assert!(!prefs_permit(Some(&p), kind, t(22, 0)), "{kind:?} start is inclusive");
            assert!(prefs_permit(Some(&p), kind, t(23, 0)), "{kind:?} end is exclusive");
            assert!(prefs_permit(Some(&p), kind, t(12, 0)), "{kind:?} outside");
        }
    }

    #[test]
    fn quiet_hours_wrap_past_midnight() {
        let p = WakePrefs {
            quiet_hours_start: Some(t(22, 0)),
            quiet_hours_end: Some(t(7, 0)),
            ..all_on()
        };
        assert!(!prefs_permit(Some(&p), WakeKind::DirectMessage, t(23, 30)));
        assert!(!prefs_permit(Some(&p), WakeKind::DirectMessage, t(3, 0)));
        assert!(prefs_permit(Some(&p), WakeKind::DirectMessage, t(7, 0)));
        assert!(prefs_permit(Some(&p), WakeKind::DirectMessage, t(12, 0)));
    }

    #[test]
    fn a_half_configured_quiet_window_is_no_window() {
        // Only a start (or only an end) cannot describe an interval; treating
        // it as "always quiet" would silence a user who never asked for it.
        let p = WakePrefs { quiet_hours_start: Some(t(22, 0)), ..all_on() };
        assert!(prefs_permit(Some(&p), WakeKind::ChannelMessage, t(22, 30)));
        let p = WakePrefs { quiet_hours_end: Some(t(7, 0)), ..all_on() };
        assert!(prefs_permit(Some(&p), WakeKind::ChannelMessage, t(3, 0)));
    }
}
