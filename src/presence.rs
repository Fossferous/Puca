//! Idle and away presence: the green dot turns the idle colour after ten
//! minutes with no input, and shows a zzz after an hour.
//!
//! WHO DECIDES WHAT. A device reports only TRANSITIONS of its own local state —
//! "active", or "inactive, and has been for N seconds" (`SetActivity`). The
//! SERVER owns both clocks: a sweep promotes a user to idle at
//! [`Thresholds::idle`] and to away at [`Thresholds::away`] of COMBINED
//! inactivity, and any activity report brings them straight back. Clients do
//! not pulse: a phone's timers freeze the moment it is backgrounded, so it
//! could never report the second step itself, and a per-minute heartbeat from
//! every client would be traffic for nothing.
//!
//! COMBINED means the most active of the user's sessions wins — at the PC,
//! nobody is idle because their phone is in a drawer.
//!
//! WHICH SESSIONS COUNT ([`SessionActivity`]):
//! - a reporting UI client: what it last reported;
//! - an OLD UI client that cannot report (no `presence` capability): ACTIVE,
//!   or every user still on an older client would flip to idle;
//! - a delivery socket (the phone's notification socket) and a HEADLESS device
//!   session (the LAN waker, the sign-in-screen service — their sessions are
//!   minted by `/devices/token`, `token_sessions.headless`): NOT AT ALL. They
//!   hold a socket 24/7 with nobody at them, so counting them as active would
//!   pin their owner green forever.
//!
//! When the last counting session goes but the user is still online through
//! a headless one, its last-known activity is kept as the `tail`, so they
//! still go idle and away on the same clocks instead of reading online.
//!
//! WHO HEARS IT. `UserStatus` goes ONLY to connections that announced the
//! `presence` capability (`/ws?caps=presence`), latched per socket at
//! connect: an older client never receives a frame it does not know. A
//! client learns the server can take its reports from `ServerFeatures`, sent
//! to the announcing connection only — an older server sends nothing, and the
//! client never sends `SetActivity` to it (an unknown variant there is an
//! Error frame, which the stock client shows as a modal alert).
//!
//! PRIVACY. Status rides `presence_audience` (shared servers + friends, blocks
//! removed) like UserOnline, and nothing at all is sent for a user with "Show
//! online status" off. "Show when I'm idle or away" (`users.show_idle_status`,
//! default on) off makes the user read plain online while connected. Nothing
//! is stored: the state lives in memory and dies with the socket.

use crate::protocol::ServerMessage;
use crate::state::{AppState, UserId};
use dashmap::DashMap;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The capability a client announces in `/ws?caps=` to take part.
pub const CAP_PRESENCE: &str = "presence";

/// The longest inactivity a client may claim in one report. Anything longer is
/// "away" anyway; the clamp keeps an absurd value from meaning anything.
pub const MAX_REPORTED_INACTIVE_SECS: u32 = 24 * 3600;

/// What a user looks like to others while they are online.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceStatus {
    Online,
    Idle,
    Away,
}

/// "Inactive since": `before` of inactivity had already passed at `at`.
///
/// Kept as an offset from a reading rather than as `at - before`, because an
/// `Instant` cannot go below the process's own clock origin: a client that
/// reports an hour of inactivity to a server that booted ten minutes ago would
/// underflow, and `Instant - Duration` PANICS on underflow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Since {
    pub at: Instant,
    pub before: Duration,
}

impl Since {
    pub fn now_minus(now: Instant, secs: u32) -> Self {
        Since { at: now, before: Duration::from_secs(u64::from(secs.min(MAX_REPORTED_INACTIVE_SECS))) }
    }

    /// How long this has been inactive, as of `now`.
    pub fn idle_for(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.at) + self.before
    }
}

/// How one session takes part in its user's presence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionActivity {
    /// A delivery socket or a headless device session: not a person at a
    /// screen, and never counted.
    Uncounted,
    /// A UI client that predates the capability. Counts as active.
    Legacy,
    /// A UI client that reports: `None` = active, `Some` = inactive since.
    Reporting(Option<Since>),
}

/// The two clocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Thresholds {
    pub idle: Duration,
    pub away: Duration,
}

impl Thresholds {
    /// The owner's numbers: idle at 10 minutes, away at an hour.
    pub const DEFAULT: Thresholds = Thresholds { idle: Duration::from_secs(600), away: Duration::from_secs(3600) };

    /// The defaults, unless a NON-production server sets the test-only
    /// overrides (`PRESENCE_TEST_IDLE_SECS` / `PRESENCE_TEST_AWAY_SECS`) — the
    /// live e2e cannot wait ten minutes. Ignored with `APP_ENV=production`,
    /// and ignored unless both parse and idle < away.
    pub fn from_env() -> Self {
        let app_env = std::env::var("APP_ENV").unwrap_or_default();
        Self::from_values(
            &app_env,
            std::env::var("PRESENCE_TEST_IDLE_SECS").ok().as_deref(),
            std::env::var("PRESENCE_TEST_AWAY_SECS").ok().as_deref(),
        )
    }

    fn from_values(app_env: &str, idle: Option<&str>, away: Option<&str>) -> Self {
        let production = matches!(app_env.trim().to_ascii_lowercase().as_str(), "production" | "prod");
        if production {
            return Self::DEFAULT;
        }
        let parse = |v: Option<&str>| v.and_then(|s| s.trim().parse::<u64>().ok()).filter(|n| *n > 0);
        match (parse(idle), parse(away)) {
            (Some(i), Some(a)) if i < a => {
                tracing::warn!("presence: TEST thresholds in use (idle {i}s, away {a}s) — never set these on a real server");
                Thresholds { idle: Duration::from_secs(i), away: Duration::from_secs(a) }
            }
            _ => Self::DEFAULT,
        }
    }

    /// How often the sweep looks: a quarter of the idle clock, 1–15 s.
    pub fn sweep_every(&self) -> Duration {
        (self.idle / 4).clamp(Duration::from_secs(1), Duration::from_secs(15))
    }

    /// The least time between two broadcasts of one user's status, so a
    /// client flapping its reports cannot turn each one into a fan-out to
    /// every member of every shared server. A change held back is not lost:
    /// the sweep sends it once the gap has passed (trailing edge).
    pub fn min_broadcast_gap(&self) -> Duration {
        (self.idle / 2).min(Duration::from_secs(10))
    }
}

/// The rule. Pure, so it is tested with a fake clock.
///
/// Any active counting session (a reporting one that last said "active", or
/// an old client that cannot say anything) makes the user online. Otherwise
/// the LEAST inactive of the reporting sessions and the tail decides, against
/// the two thresholds. With nothing counted at all — only headless sessions
/// keep the user online, and nothing is known about the person — they are
/// away: there is nobody at a screen.
pub fn combine(now: Instant, sessions: &[SessionActivity], tail: Option<Since>, t: Thresholds) -> PresenceStatus {
    let mut least: Option<Duration> = tail.map(|s| s.idle_for(now));
    for s in sessions {
        match s {
            SessionActivity::Uncounted => {}
            SessionActivity::Legacy | SessionActivity::Reporting(None) => return PresenceStatus::Online,
            SessionActivity::Reporting(Some(since)) => {
                let d = since.idle_for(now);
                least = Some(least.map_or(d, |l| l.min(d)));
            }
        }
    }
    match least {
        None => PresenceStatus::Away,
        Some(d) if d >= t.away => PresenceStatus::Away,
        Some(d) if d >= t.idle => PresenceStatus::Idle,
        Some(_) => PresenceStatus::Online,
    }
}

/// What a NEW reporting session starts as, until its own first report.
///
/// Connecting is not evidence that a person is there: a network blip
/// reconnects the desktop while its old socket lingers until the liveness
/// reaper takes it, and a LAN waker or an open phone keeps the user's record
/// (and the PC's tail) alive. Counting the arrival as "active" flashed an
/// away user online for 10–25 s (the client's "still away" report a round
/// trip later fell inside the broadcast gap) and cost two fan-outs per blip.
/// So it carries the user's current LEAST inactivity — or active when
/// nothing at all is known (the first device of the day: someone opened the
/// app). Its first report, a round trip later, then decides; a real return
/// is a move up and goes out at once.
pub fn arrival(others: impl Iterator<Item = SessionActivity>, tail: Option<Since>, now: Instant) -> SessionActivity {
    let mut least: Option<Since> = tail;
    for s in others {
        match s {
            SessionActivity::Uncounted => {}
            SessionActivity::Legacy | SessionActivity::Reporting(None) => return SessionActivity::Reporting(None),
            SessionActivity::Reporting(Some(since)) => {
                if least.is_none_or(|l| since.idle_for(now) < l.idle_for(now)) {
                    least = Some(since);
                }
            }
        }
    }
    SessionActivity::Reporting(least)
}

impl PresenceStatus {
    /// Online > Idle > Away. A move UP is shown at once; only a move down
    /// waits out the broadcast gap.
    fn rank(self) -> u8 {
        match self {
            PresenceStatus::Online => 2,
            PresenceStatus::Idle => 1,
            PresenceStatus::Away => 0,
        }
    }
}

/// What a client announced in `/ws?caps=`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ClientCaps {
    pub presence: bool,
}

impl ClientCaps {
    /// Comma-separated, case-insensitive, unknown names ignored (a newer
    /// client may announce things this server has never heard of).
    pub fn parse(raw: Option<&str>) -> Self {
        let mut caps = ClientCaps::default();
        for name in raw.unwrap_or("").split(',').map(|s| s.trim().to_ascii_lowercase()) {
            if name == CAP_PRESENCE {
                caps.presence = true;
            }
        }
        caps
    }

    /// The features to confirm back: what was announced AND is supported.
    pub fn features(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.presence {
            out.push(CAP_PRESENCE.to_string());
        }
        out
    }
}

/// How a visible (non-delivery) connection takes part, from what is known at
/// connect: a headless device session not at all, a client that announced the
/// capability by its reports (and it alone is sent `UserStatus`), anything
/// else as an old, always-active UI client.
pub fn classify(headless: bool, caps: ClientCaps) -> (SessionActivity, bool) {
    let activity = if headless {
        SessionActivity::Uncounted
    } else if caps.presence {
        SessionActivity::Reporting(None)
    } else {
        SessionActivity::Legacy
    };
    (activity, caps.presence)
}

/// Per-user bookkeeping, held while the user is visibly online.
#[derive(Debug, Clone)]
pub struct PresenceRecord {
    /// `users.show_online_status`, cached at connect and on every change.
    pub show_online: bool,
    /// `users.show_idle_status`.
    pub show_idle: bool,
    /// The last status broadcast (or, with "Show online status" off, the one
    /// that would have been): what REST listings report too, so a poll never
    /// announces a change the sockets have not been told.
    pub sent: PresenceStatus,
    pub sent_at: Option<Instant>,
    /// Activity of counting sessions that have gone (see the module header).
    pub tail: Option<Since>,
    /// Changes with every write of the flags (and differs between a record
    /// and the one that replaces it), so a database READ of the flags can be
    /// refused if anything wrote them after the read began
    /// ([`PresenceRegistry::set_flags_read`]).
    pub flags_gen: u64,
}

pub struct PresenceRegistry {
    pub records: DashMap<UserId, PresenceRecord>,
    pub thresholds: Thresholds,
    next_gen: AtomicU64,
}

impl PresenceRegistry {
    pub fn new(thresholds: Thresholds) -> Self {
        Self { records: DashMap::new(), thresholds, next_gen: AtomicU64::new(1) }
    }

    fn gen(&self) -> u64 {
        self.next_gen.fetch_add(1, Ordering::Relaxed)
    }

    /// The status the user was last announced with, if they have a record.
    pub fn sent(&self, user: UserId) -> Option<PresenceStatus> {
        self.records.get(&user).map(|r| r.sent)
    }

    /// A counting session left: keep its activity, the most recent wins.
    /// Called under the `sessions` shard lock (lock order: sessions, then
    /// presence — nothing here may touch `sessions`).
    pub(crate) fn note_departure(&self, user: UserId, since: Since, now: Instant) {
        if let Some(mut rec) = self.records.get_mut(&user) {
            let keep = match rec.tail {
                Some(t) => t.idle_for(now) <= since.idle_for(now),
                None => false,
            };
            if !keep {
                rec.tail = Some(since);
            }
        }
    }

    /// Activity kept from counting sessions that have gone.
    pub(crate) fn tail(&self, user: UserId) -> Option<Since> {
        self.records.get(&user).and_then(|r| r.tail)
    }

    /// The user's last visible session went: nothing to remember.
    pub(crate) fn forget(&self, user: UserId) {
        self.records.remove(&user);
    }

    /// A visible session exists: make sure there is a record. Called ONLY
    /// under the `sessions` shard lock (from `register_session_classified`), as
    /// `forget` is (from `unregister_session`), so the two are serialised and
    /// a record exists exactly while the user has a visible session — a
    /// record created after an await could outlive its user, and one deleted
    /// by a racing cleanup would leave a live user the sweep never visits.
    ///
    /// A NEW record shares nothing until the user's real flags are read
    /// (`set_flags`, right after): fail closed for the moment in between.
    pub(crate) fn ensure(&self, user: UserId) {
        if self.records.contains_key(&user) {
            return;
        }
        let flags_gen = self.gen();
        self.records.entry(user).or_insert(PresenceRecord {
            show_online: false,
            show_idle: false,
            sent: PresenceStatus::Online,
            sent_at: None,
            tail: None,
            flags_gen,
        });
    }

    /// Store a CHANGE of the privacy flags (no-op for a user with no
    /// record). Always wins: it is what the user just did.
    pub(crate) fn set_flags(&self, user: UserId, show_online: Option<bool>, show_idle: Option<bool>) {
        let flags_gen = self.gen();
        if let Some(mut rec) = self.records.get_mut(&user) {
            if let Some(v) = show_online {
                rec.show_online = v;
            }
            if let Some(v) = show_idle {
                rec.show_idle = v;
            }
            rec.flags_gen = flags_gen;
        }
    }

    /// Taken BEFORE reading the flags from the database; hand it back to
    /// [`Self::set_flags_read`]. None when the user has no record.
    pub(crate) fn flags_token(&self, user: UserId) -> Option<u64> {
        self.records.get(&user).map(|r| r.flags_gen)
    }

    /// Store flags READ from the database, unless anything wrote them since
    /// `token` was taken — returns false then, and the caller reads again.
    ///
    /// on_connect reads with an await in between. If the user turns "Show
    /// online status" OFF on another device meanwhile, update_profile's
    /// flags_changed writes the cache AFTER its UPDATE commits — and a read
    /// that began before that commit would otherwise put the old `true` back
    /// for the life of the record (days, for a desktop), sending the hidden
    /// user's status to their whole audience.
    pub(crate) fn set_flags_read(&self, user: UserId, token: u64, show_online: bool, show_idle: bool) -> bool {
        let flags_gen = self.gen();
        let Some(mut rec) = self.records.get_mut(&user) else { return false };
        if rec.flags_gen != token {
            return false;
        }
        rec.show_online = show_online;
        rec.show_idle = show_idle;
        rec.flags_gen = flags_gen;
        true
    }

    /// Decide the user's status as of `now` from a snapshot of their
    /// sessions. When it changed AND may go out now, records it as sent and
    /// returns whether the audience may hear it (`show_online`).
    ///
    /// A move up (back to online, away to idle) goes out at once; a move
    /// down waits until `min_broadcast_gap` has passed since the last one
    /// (unless `force`d by a settings change), and the sweep sends it then.
    /// So a client flapping between active and inactive costs at most two
    /// fan-outs per gap, while someone coming back is never shown late.
    pub(crate) fn decide(&self, user: UserId, sessions: &[SessionActivity], now: Instant, force: bool) -> Option<bool> {
        let mut rec = self.records.get_mut(&user)?;
        let computed = combine(now, sessions, rec.tail, self.thresholds);
        let public = if rec.show_idle { computed } else { PresenceStatus::Online };
        if public == rec.sent {
            return None;
        }
        if !force && public.rank() < rec.sent.rank() {
            if let Some(at) = rec.sent_at {
                if now.saturating_duration_since(at) < self.thresholds.min_broadcast_gap() {
                    return None;
                }
            }
        }
        rec.sent = public;
        rec.sent_at = Some(now);
        Some(rec.show_online)
    }
}

impl SessionActivity {
    /// What a departing session leaves behind as `tail`, if it counted.
    pub fn departure(&self, now: Instant) -> Option<Since> {
        match self {
            SessionActivity::Uncounted => None,
            SessionActivity::Legacy | SessionActivity::Reporting(None) => Some(Since { at: now, before: Duration::ZERO }),
            SessionActivity::Reporting(Some(s)) => Some(*s),
        }
    }
}

// ---- Session-level state (lives on crate::state::Session) -------------------

impl AppState {
    /// Record a `SetActivity` from `conn`. Only a REPORTING session's state
    /// moves; a frame from any other kind (a crafted one from an old client,
    /// say) is ignored. Returns whether it was taken.
    pub fn report_session_activity(&self, user: UserId, conn: u64, since: Option<Since>) -> bool {
        let Some(mut sessions) = self.sessions.get_mut(&user) else { return false };
        match sessions.iter_mut().find(|s| s.conn_id == conn) {
            Some(s) if matches!(s.activity, SessionActivity::Reporting(_)) => {
                s.activity = SessionActivity::Reporting(since);
                true
            }
            _ => false,
        }
    }

    /// Every visible session's activity, or None when the user is not
    /// visibly online. The guard is dropped before returning.
    pub fn presence_snapshot(&self, user: UserId) -> Option<Vec<SessionActivity>> {
        let sessions = self.sessions.get(&user)?;
        if !sessions.iter().any(|s| !s.delivery) {
            return None;
        }
        Some(sessions.iter().filter(|s| !s.delivery).map(|s| s.activity).collect())
    }

    /// Send to the user's connections that announced the capability, and to
    /// no other: an older client never sees a frame it does not know.
    pub fn send_presence_frame(&self, user: UserId, msg: ServerMessage) -> usize {
        let Some(sessions) = self.sessions.get(&user) else { return 0 };
        let mut n = 0;
        for s in sessions.iter().filter(|s| s.presence_frames && !s.delivery) {
            if s.tx.try_send(msg.clone()).is_ok() {
                n += 1;
            }
        }
        n
    }

    /// The status a REST listing reports for a user it already shows online.
    pub fn listing_status(&self, user: UserId) -> PresenceStatus {
        self.presence.sent(user).unwrap_or(PresenceStatus::Online)
    }
}

// ---- Deciding and broadcasting ---------------------------------------------

/// `users.show_online_status` and `users.show_idle_status`. Fails OPEN to the
/// column defaults, like `ws::user_shows_online`: presence is not worth
/// breaking a connect over, and the announce side already fails open.
pub(crate) async fn presence_flags(state: &Arc<AppState>, user: UserId) -> (bool, bool) {
    match sqlx::query_as::<_, (bool, bool)>("SELECT show_online_status, show_idle_status FROM users WHERE id = $1")
        .bind(user as i32)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(flags)) => flags,
        Ok(None) => (true, true),
        Err(e) => {
            tracing::warn!("presence flags lookup failed for user {user}: {e:?}");
            (true, true)
        }
    }
}

/// Was this socket's JWT minted for a headless device (`/devices/token`)?
/// Fails to "no": a UI session misread as headless would never count.
pub(crate) async fn session_is_headless(state: &Arc<AppState>, user: UserId, sid: &str) -> bool {
    if sid.is_empty() {
        return false;
    }
    sqlx::query_as::<_, (bool,)>("SELECT headless FROM token_sessions WHERE sid = $1 AND user_id = $2")
        .bind(sid)
        .bind(user as i32)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
        .is_some_and(|(h,)| h)
}

/// A visible connection has registered (the caller has already announced
/// UserOnline when it was the first). Confirms the capability to the
/// connection, creates or refreshes the user's record, and decides.
pub async fn on_connect(state: &Arc<AppState>, user: UserId, conn: u64, caps: ClientCaps, _is_first: bool) {
    // Only to a connection that asked: an older client must never receive a
    // frame it does not know, and this tells a new one, for THIS socket, that
    // SetActivity will be understood.
    let features = caps.features();
    if !features.is_empty() {
        state.send_to_conn(user, conn, ServerMessage::ServerFeatures { features });
    }
    // The record exists already (register_session_classified made it); fill in the
    // user's real privacy flags, then decide — a second device arriving at an
    // idle desk, or a headless one connecting alone, can change the status.
    // A read that raced a settings change is refused and read again; one
    // that keeps losing (a user flipping the switch in a loop) leaves the
    // flags the CHANGES wrote, which are newer than any read anyway.
    for _ in 0..4 {
        let Some(token) = state.presence.flags_token(user) else { break };
        let (show_online, show_idle) = presence_flags(state, user).await;
        if state.presence.set_flags_read(user, token, show_online, show_idle) {
            break;
        }
    }
    refresh(state, user, Instant::now()).await;
}

/// Decide the user's status as of `now` and broadcast it if it changed.
pub async fn refresh(state: &Arc<AppState>, user: UserId, now: Instant) {
    refresh_inner(state, user, now, false).await;
}

/// Returns whether a status went out.
async fn refresh_inner(state: &Arc<AppState>, user: UserId, now: Instant, force: bool) -> bool {
    // The sessions guard is dropped inside presence_snapshot before the
    // presence lock is taken: never hold presence while touching sessions.
    let Some(sessions) = state.presence_snapshot(user) else { return false };
    let Some(to_audience) = state.presence.decide(user, &sessions, now, force) else { return false };
    broadcast(state, user, to_audience).await;
    true
}

/// Send the user's CURRENT status to their own capable devices and, when
/// they show online, to their capable audience.
async fn broadcast(state: &Arc<AppState>, user: UserId, to_audience: bool) {
    let audience = if to_audience { crate::ws::presence_audience(state, user).await } else { Vec::new() };
    // Re-read after the await, as the UserOnline/UserOffline paths do: two
    // decisions racing each other both send the NEWEST value, so the last
    // frame anyone sees is right; a user who went offline, or hid their
    // status, meanwhile is not announced at all.
    let Some((status, shows_online)) = state.presence.records.get(&user).map(|r| (r.sent, r.show_online)) else {
        return;
    };
    let msg = ServerMessage::UserStatus { user_id: user, status };
    state.send_presence_frame(user, msg.clone());
    if shows_online {
        for id in audience {
            state.send_presence_frame(id, msg.clone());
        }
    }
}

/// The privacy flags changed (profile PATCH): update the cache and correct
/// everyone's picture. `online_shown_now` is true when "Show online status"
/// was just turned ON — the caller has sent UserOnline, which every client
/// reads as plain online, so the real status follows it.
pub async fn flags_changed(state: &Arc<AppState>, user: UserId, show_online: Option<bool>, show_idle: Option<bool>, online_shown_now: bool) {
    if !state.presence.records.contains_key(&user) {
        return; // not online: the next connect reads the flags afresh
    }
    state.presence.set_flags(user, show_online, show_idle);
    let sent_now = refresh_inner(state, user, Instant::now(), true).await;
    if online_shown_now && !sent_now && state.presence.sent(user).is_some_and(|s| s != PresenceStatus::Online) {
        broadcast(state, user, true).await;
    }
}

/// The sweep: promotes idle and away on the server's clock, and delivers any
/// change the broadcast gap held back.
pub fn spawn_sweeper(state: Arc<AppState>) {
    let every = state.presence.thresholds.sweep_every();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            sweep(&state, Instant::now()).await;
        }
    });
}

pub async fn sweep(state: &Arc<AppState>, now: Instant) {
    let users: Vec<UserId> = state.presence.records.iter().map(|r| *r.key()).collect();
    for user in users {
        refresh(state, user, now).await;
    }
}

#[cfg(test)]
mod rule_tests {
    use super::*;

    const T: Thresholds = Thresholds::DEFAULT;
    fn mins(m: u64) -> Duration {
        Duration::from_secs(m * 60)
    }
    /// A session inactive for `m` minutes as of `now`.
    fn inactive(now: Instant, m: u64) -> SessionActivity {
        SessionActivity::Reporting(Some(Since { at: now, before: mins(m) }))
    }

    #[test]
    fn the_most_active_session_wins() {
        let now = Instant::now();
        use PresenceStatus::*;
        // Desktop idle 30 min, phone active -> online.
        assert_eq!(combine(now, &[inactive(now, 30), SessionActivity::Reporting(None)], None, T), Online);
        // Idle 2 min and 40 min -> the 2-minute one decides: online.
        assert_eq!(combine(now, &[inactive(now, 2), inactive(now, 40)], None, T), Online);
        // 12 and 40 minutes -> idle (not away: the most active is 12).
        assert_eq!(combine(now, &[inactive(now, 12), inactive(now, 40)], None, T), Idle);
        // One session, 70 minutes -> away.
        assert_eq!(combine(now, &[inactive(now, 70)], None, T), Away);
    }

    #[test]
    fn the_thresholds_are_the_owners_ten_minutes_and_one_hour() {
        let now = Instant::now();
        use PresenceStatus::*;
        let at = |secs: u64| combine(now, &[SessionActivity::Reporting(Some(Since { at: now, before: Duration::from_secs(secs) }))], None, T);
        assert_eq!(at(599), Online);
        assert_eq!(at(600), Idle);
        assert_eq!(at(3599), Idle);
        assert_eq!(at(3600), Away);
    }

    #[test]
    fn the_server_clock_promotes_without_any_new_report() {
        // One report ("inactive for 9 minutes"), then only time passes: the
        // phone that sent it is asleep and will never report again.
        let t0 = Instant::now();
        let s = [SessionActivity::Reporting(Some(Since::now_minus(t0, 9 * 60)))];
        assert_eq!(combine(t0, &s, None, T), PresenceStatus::Online);
        assert_eq!(combine(t0 + mins(1), &s, None, T), PresenceStatus::Idle);
        assert_eq!(combine(t0 + mins(51), &s, None, T), PresenceStatus::Away);
    }

    #[test]
    fn an_old_client_counts_as_active_and_a_headless_one_not_at_all() {
        let now = Instant::now();
        use PresenceStatus::*;
        // An old UI client cannot report: it must not flip its user to idle.
        assert_eq!(combine(now, &[SessionActivity::Legacy, inactive(now, 70)], None, T), Online);
        // A headless session (waker / service) beside an idle PC does NOT pin
        // the user active...
        assert_eq!(combine(now, &[SessionActivity::Uncounted, inactive(now, 70)], None, T), Away);
        assert_eq!(combine(now, &[SessionActivity::Uncounted, inactive(now, 12)], None, T), Idle);
        // ...and alone, with nothing known about the person, reads away.
        assert_eq!(combine(now, &[SessionActivity::Uncounted], None, T), Away);
    }

    #[test]
    fn the_tail_keeps_a_departed_sessions_activity() {
        let t0 = Instant::now();
        use PresenceStatus::*;
        // The PC (active) closed at t0; only the waker is left.
        let tail = SessionActivity::Legacy.departure(t0);
        assert_eq!(combine(t0 + mins(5), &[SessionActivity::Uncounted], tail, T), Online);
        assert_eq!(combine(t0 + mins(11), &[SessionActivity::Uncounted], tail, T), Idle);
        assert_eq!(combine(t0 + mins(61), &[SessionActivity::Uncounted], tail, T), Away);
        // A live active session still beats an old tail.
        assert_eq!(combine(t0 + mins(61), &[SessionActivity::Reporting(None)], tail, T), Online);
        // A delivery/headless departure leaves nothing behind.
        assert_eq!(SessionActivity::Uncounted.departure(t0), None);
    }

    #[test]
    fn an_arriving_session_carries_what_the_others_say_until_it_reports() {
        let now = Instant::now();
        let away = Since { at: now, before: mins(70) };
        let idle = Since { at: now, before: mins(12) };
        use SessionActivity::*;
        // Beside an away socket that has not been reaped yet: away, not online.
        assert_eq!(arrival([Reporting(Some(away))].into_iter(), None, now), Reporting(Some(away)));
        // The least inactive of the others and the tail wins.
        assert_eq!(arrival([Reporting(Some(away)), Uncounted].into_iter(), Some(idle), now), Reporting(Some(idle)));
        assert_eq!(arrival([Reporting(Some(idle))].into_iter(), Some(away), now), Reporting(Some(idle)));
        // Beside anything active, active (it changes nothing).
        assert_eq!(arrival([Reporting(Some(away)), Legacy].into_iter(), None, now), Reporting(None));
        assert_eq!(arrival([Reporting(None)].into_iter(), Some(away), now), Reporting(None));
        // Nothing known (first device, or only a waker and no tail): active.
        assert_eq!(arrival(std::iter::empty(), None, now), Reporting(None));
        assert_eq!(arrival([Uncounted].into_iter(), None, now), Reporting(None));
        // And the status it yields is the one already shown: no flash.
        assert_eq!(
            combine(now, &[Reporting(Some(away)), arrival([Reporting(Some(away))].into_iter(), None, now)], None, T),
            PresenceStatus::Away
        );
    }

    #[test]
    fn note_departure_keeps_the_most_recent_activity() {
        let reg = PresenceRegistry::new(T);
        let now = Instant::now();
        reg.records.insert(
            1,
            PresenceRecord { show_online: true, show_idle: true, sent: PresenceStatus::Online, sent_at: None, tail: None, flags_gen: 0 },
        );
        reg.note_departure(1, Since::now_minus(now, 300), now);
        reg.note_departure(1, Since::now_minus(now, 900), now); // older activity: ignored
        assert_eq!(reg.records.get(&1).unwrap().tail.unwrap().idle_for(now), Duration::from_secs(300));
        reg.note_departure(1, Since::now_minus(now, 10), now); // newer: kept
        assert_eq!(reg.records.get(&1).unwrap().tail.unwrap().idle_for(now), Duration::from_secs(10));
    }

    /// on_connect reads the flags with an await in between; "Show online
    /// status" turned OFF on another device during that read must win.
    #[test]
    fn a_stale_flags_read_never_overwrites_a_newer_change() {
        let reg = PresenceRegistry::new(T);
        reg.ensure(1);
        // on_connect takes its token and starts its SELECT...
        let token = reg.flags_token(1).expect("record");
        // ...the user hides their status meanwhile (update_profile commits,
        // then flags_changed writes the cache)...
        reg.set_flags(1, Some(false), None);
        // ...and the SELECT, begun before the UPDATE, returns the old value.
        assert!(!reg.set_flags_read(1, token, true, true), "a read older than a change is refused");
        assert!(!reg.records.get(&1).unwrap().show_online, "hidden stays hidden");
        // A read begun after the change is taken (positive control).
        let token = reg.flags_token(1).expect("record");
        assert!(reg.set_flags_read(1, token, false, true));
        assert!(reg.records.get(&1).unwrap().show_idle);
        // A token from a record that was forgotten and made again is stale too.
        let token = reg.flags_token(1).expect("record");
        reg.forget(1);
        reg.ensure(1);
        assert!(!reg.set_flags_read(1, token, true, true));
        assert!(!reg.records.get(&1).unwrap().show_online, "a new record still fails closed");
    }

    #[test]
    fn a_huge_report_is_clamped_and_never_panics() {
        // Instant::now() - 49710 days would panic; Since never subtracts.
        let now = Instant::now();
        let s = Since::now_minus(now, u32::MAX);
        assert_eq!(s.idle_for(now), Duration::from_secs(u64::from(MAX_REPORTED_INACTIVE_SECS)));
        assert_eq!(combine(now, &[SessionActivity::Reporting(Some(s))], None, T), PresenceStatus::Away);
        // A reading from the "future" (clock skew between two Instants) saturates.
        let later = Since { at: now + Duration::from_secs(5), before: Duration::ZERO };
        assert_eq!(later.idle_for(now), Duration::ZERO);
    }

    #[test]
    fn caps_parse_tolerates_noise_and_unknown_names() {
        assert!(ClientCaps::parse(Some("presence")).presence);
        assert!(ClientCaps::parse(Some(" games , PRESENCE ")).presence);
        assert!(!ClientCaps::parse(Some("presences")).presence);
        assert!(!ClientCaps::parse(None).presence);
        assert_eq!(ClientCaps::parse(Some("x,presence")).features(), vec!["presence".to_string()]);
        assert!(ClientCaps::parse(Some("x")).features().is_empty());
    }

    #[test]
    fn test_thresholds_are_ignored_in_production_and_when_malformed() {
        let d = Thresholds::DEFAULT;
        assert_eq!(Thresholds::from_values("production", Some("5"), Some("20")), d);
        assert_eq!(Thresholds::from_values("PROD", Some("5"), Some("20")), d);
        assert_eq!(Thresholds::from_values("development", Some("20"), Some("5")), d, "idle must be below away");
        assert_eq!(Thresholds::from_values("development", Some("0"), Some("5")), d);
        assert_eq!(Thresholds::from_values("development", Some("x"), Some("5")), d);
        assert_eq!(Thresholds::from_values("development", None, None), d);
        let t = Thresholds::from_values("development", Some("6"), Some("20"));
        assert_eq!((t.idle, t.away), (Duration::from_secs(6), Duration::from_secs(20)));
        assert_eq!(d.sweep_every(), Duration::from_secs(15));
        assert_eq!(t.sweep_every(), Duration::from_millis(1500));
    }
}
