//! `GET /events/tasks` — a content-free, per-user stream of "this changed"
//! for the task system, as Server-Sent Events.
//!
//! WHY IT EXISTS. Púca Notes never opens the WebSocket (docs/NOTES.md: a bare
//! socket eats parked file offers, deletes the phone's parked notification
//! frames, announces presence and suppresses wake signals). And even Púca's
//! own socket carries nothing for a personal list, a list create/rename/
//! delete, a pin or an order change. So Notes polled. This is the live path:
//! its own registry, never the WebSocket session table, so none of those side
//! effects can come back through it.
//!
//! WHERE EVENTS COME FROM. Row triggers on the task tables (migration 067)
//! `pg_notify` a compact JSON of IDS — a channel id, a list id and its owner,
//! a user id. Nothing in `src/task_handlers.rs` publishes anything, so no
//! write path can forget to. Postgres folds identical payloads raised inside
//! one transaction into one, which bounds a cascade to one event.
//!
//! WHAT A CLIENT RECEIVES. `{"t":"list","id":N}`, `{"t":"channel","id":N}`,
//! `{"t":"lists"}`, `{"t":"prefs"}`, `{"t":"blob","name":"notes-prefs"}`,
//! `{"t":"resync"}` (something was dropped: re-read everything), and the
//! framing events `hello`, `evicted` and `bye`. Every one is an id the server
//! already holds or a constant; never a title, an item, a label or a time.
//!
//! WHO RECEIVES A CHANNEL EVENT. Only subscribed users who can VIEW that
//! channel at the moment the event is dispatched (`get_channel_viewer_ids`),
//! re-judged per event so a permission change needs no eviction sweep. On a
//! resolver error NOBODY receives it (fail closed, as MessageNotification
//! does). Personal-list, lists, prefs and blob events go to their owner only.
//!
//! THE ONE RULE THAT PROTECTS EVERY TASK WRITE. A listening connection that
//! stops READING lets Postgres' notification queue fill, and a full queue
//! fails NOTIFY at commit — which, with the triggers, is every task write for
//! every client, old ones included. So the pipeline is two tasks:
//!
//!  - `receive_loop` only ever awaits the listener. Each payload is
//!    `try_send`-ed into a bounded queue; a full queue drops it and raises the
//!    overflow flag. It never awaits the database, the hub, or a subscriber.
//!  - `dispatch_loop` does the slow part (the viewer query), and turns an
//!    overflow into one `resync` to every stream.
//!
//! Each stream has its own bounded buffer; a slow reader loses events and is
//! told to resync, it never slows anyone else. A user holds at most
//! `MAX_STREAMS_PER_USER` streams (the oldest is evicted, and told so, so the
//! client backs off instead of fighting for a slot), each IP at most
//! `TASK_EVENTS_MAX_PER_IP`. A stream ends at the token's expiry, and the
//! session is re-checked every `RECHECK` so a revoked device's stream stops
//! within that interval.
//!
//! The hub is per process, like the WebSocket registry: a deployment that
//! served live traffic from two hosts at once would not fan events across
//! them (each host has its own database today, so this cannot arise).

use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Extension,
};
use dashmap::DashMap;
use std::collections::HashSet;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::auth::Claims;
use crate::state::{AppState, IpSlotGuard, IpSlotKind, UserId};

/// The Postgres channel the migration-067 triggers notify on.
pub const EVENT_CHANNEL: &str = "puca_task_events";
/// Streams per user. Several Notes tabs plus a phone fit; a fifth evicts the
/// oldest rather than being refused (a refused newest tab would be the one
/// the person is looking at).
pub const MAX_STREAMS_PER_USER: usize = 4;
/// Events buffered per stream before it is marked lagged (and told to resync).
pub const PER_STREAM_BUFFER: usize = 64;
/// Raw notifications buffered between the receive loop and the dispatcher.
pub const RAW_QUEUE: usize = 4096;
/// SSE comment cadence. Under Cloudflare's 100 s idle limit with room, and
/// frequent enough that a dead TCP path is noticed.
pub const KEEPALIVE: Duration = Duration::from_secs(20);
/// How often a live stream re-checks that its session was not revoked.
pub const RECHECK: Duration = Duration::from_secs(60);

// --- Events -------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskEvent {
    /// First frame of every stream: "this server has live task events".
    Hello,
    /// A personal list's tasks changed.
    List(i64),
    /// A channel checklist's tasks changed.
    Channel(i64),
    /// The set of personal lists changed (create, rename, delete, trash).
    Lists,
    /// Pins / tab order changed.
    Prefs,
    /// A sealed-to-self blob changed (the name is a fixed identifier).
    Blob(String),
    /// Events were dropped; re-read everything.
    Resync,
    /// This stream was closed to make room for a newer one of the same user.
    Evicted,
    /// The stream is ending on the server's side (token expiry, revocation).
    Bye(&'static str),
}

impl TaskEvent {
    pub fn to_json(&self) -> String {
        match self {
            TaskEvent::Hello => r#"{"t":"hello"}"#.to_string(),
            TaskEvent::List(id) => format!(r#"{{"t":"list","id":{id}}}"#),
            TaskEvent::Channel(id) => format!(r#"{{"t":"channel","id":{id}}}"#),
            TaskEvent::Lists => r#"{"t":"lists"}"#.to_string(),
            TaskEvent::Prefs => r#"{"t":"prefs"}"#.to_string(),
            TaskEvent::Blob(name) => serde_json::json!({ "t": "blob", "name": name }).to_string(),
            TaskEvent::Resync => r#"{"t":"resync"}"#.to_string(),
            TaskEvent::Evicted => r#"{"t":"evicted"}"#.to_string(),
            TaskEvent::Bye(why) => serde_json::json!({ "t": "bye", "why": why }).to_string(),
        }
    }
}

/// A trigger payload, understood.
#[derive(Debug, PartialEq, Eq)]
pub enum Notice {
    /// Goes to whoever can view the channel.
    Channel(i64),
    /// Goes to one user.
    ToUser(UserId, TaskEvent),
}

#[derive(serde::Deserialize)]
struct RawNotice {
    c: Option<i64>,
    l: Option<i64>,
    u: Option<i64>,
    #[serde(rename = "L")]
    lists: Option<i64>,
    p: Option<i64>,
    s: Option<String>,
}

/// Parse a migration-067 payload. Anything unexpected is ignored (None) —
/// never guessed at: a mis-addressed event is a leak.
pub fn parse_notice(payload: &str) -> Option<Notice> {
    let r: RawNotice = serde_json::from_str(payload).ok()?;
    if let Some(c) = r.c {
        return Some(Notice::Channel(c));
    }
    let u = r.u?;
    if let Some(l) = r.l {
        return Some(Notice::ToUser(u, TaskEvent::List(l)));
    }
    if r.lists.is_some() {
        return Some(Notice::ToUser(u, TaskEvent::Lists));
    }
    if r.p.is_some() {
        return Some(Notice::ToUser(u, TaskEvent::Prefs));
    }
    if let Some(name) = r.s {
        if crate::sealed_blob_handlers::SEALED_BLOB_NAMES.contains(&name.as_str()) {
            return Some(Notice::ToUser(u, TaskEvent::Blob(name)));
        }
    }
    None
}

// --- The hub -------------------------------------------------------------------

struct Sub {
    id: u64,
    tx: mpsc::Sender<TaskEvent>,
    lagged: Arc<AtomicBool>,
    evicted: Arc<AtomicBool>,
}

/// Live streams per user. Everything here is synchronous and bounded: a
/// publish is a `try_send` per stream, never an await.
pub struct TaskEventHub {
    subs: DashMap<UserId, Vec<Sub>>,
    next_id: AtomicU64,
    streams: AtomicUsize,
}

/// One registered stream. Dropping it unregisters it.
pub struct Subscription {
    hub: Arc<TaskEventHub>,
    user: UserId,
    id: u64,
    pub rx: mpsc::Receiver<TaskEvent>,
    pub lagged: Arc<AtomicBool>,
    pub evicted: Arc<AtomicBool>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.hub.remove(self.user, self.id);
    }
}

impl TaskEventHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { subs: DashMap::new(), next_id: AtomicU64::new(1), streams: AtomicUsize::new(0) })
    }

    /// Register a stream for `user`, evicting that user's OLDEST stream when
    /// they are at the cap.
    pub fn subscribe(self: &Arc<Self>, user: UserId) -> Subscription {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(PER_STREAM_BUFFER);
        let lagged = Arc::new(AtomicBool::new(false));
        let evicted = Arc::new(AtomicBool::new(false));
        {
            let mut v = self.subs.entry(user).or_default();
            while v.len() >= MAX_STREAMS_PER_USER {
                // Oldest = lowest id. Flag it, then drop its sender: its
                // receiver drains what is buffered, sees the close, and the
                // stream says `evicted` before it ends.
                let oldest = v.iter().enumerate().min_by_key(|(_, s)| s.id).map(|(i, _)| i).unwrap_or(0);
                let gone = v.remove(oldest);
                gone.evicted.store(true, Ordering::SeqCst);
                self.streams.fetch_sub(1, Ordering::Relaxed);
            }
            v.push(Sub { id, tx, lagged: lagged.clone(), evicted: evicted.clone() });
            self.streams.fetch_add(1, Ordering::Relaxed);
        }
        Subscription { hub: self.clone(), user, id, rx, lagged, evicted }
    }

    fn remove(&self, user: UserId, id: u64) {
        let mut removed = false;
        if let Some(mut v) = self.subs.get_mut(&user) {
            let before = v.len();
            v.retain(|s| s.id != id);
            removed = v.len() != before;
        }
        if removed {
            self.streams.fetch_sub(1, Ordering::Relaxed);
        }
        // Separate call: holding the get_mut ref across remove_if deadlocks the shard.
        self.subs.remove_if(&user, |_, v| v.is_empty());
    }

    fn offer(s: &Sub, ev: &TaskEvent) {
        if let Err(mpsc::error::TrySendError::Full(_)) = s.tx.try_send(ev.clone()) {
            s.lagged.store(true, Ordering::SeqCst);
        }
    }

    /// Hand `ev` to every stream of `user`. Never blocks.
    pub fn publish_to_user(&self, user: UserId, ev: &TaskEvent) {
        if let Some(v) = self.subs.get(&user) {
            for s in v.iter() {
                Self::offer(s, ev);
            }
        }
    }

    /// Hand `ev` to every stream of every user (used for `resync`).
    pub fn broadcast(&self, ev: &TaskEvent) {
        for entry in self.subs.iter() {
            for s in entry.value().iter() {
                Self::offer(s, ev);
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.streams.load(Ordering::Relaxed) == 0
    }

    #[cfg(test)]
    pub fn stream_count(&self) -> usize {
        self.streams.load(Ordering::Relaxed)
    }

    pub fn subscribed_users(&self) -> Vec<UserId> {
        self.subs.iter().map(|e| *e.key()).collect()
    }
}

// --- Dispatch --------------------------------------------------------------------

/// Who may view a channel right now. A trait so the dispatcher's fail-closed
/// rule and its slowness can be tested without a database.
#[async_trait::async_trait]
pub trait ChannelViewers: Send + Sync {
    async fn viewers(&self, channel_id: i64) -> Result<HashSet<i64>, sqlx::Error>;
}

pub struct DbViewers(pub sqlx::PgPool);

#[async_trait::async_trait]
impl ChannelViewers for DbViewers {
    async fn viewers(&self, channel_id: i64) -> Result<HashSet<i64>, sqlx::Error> {
        let server: Option<(Option<String>,)> = sqlx::query_as("SELECT server_id FROM channels WHERE id = $1")
            .bind(channel_id)
            .fetch_optional(&self.0)
            .await?;
        match server {
            Some((Some(server_id),)) => crate::permissions::get_channel_viewer_ids(&self.0, channel_id, &server_id).await,
            // A deleted channel, or one with no server: nobody.
            _ => Ok(HashSet::new()),
        }
    }
}

/// Deliver one notice. Channel events cost a viewer query, so they are
/// skipped outright while no stream is open.
pub async fn dispatch(hub: &TaskEventHub, viewers: &dyn ChannelViewers, notice: Notice) {
    match notice {
        Notice::ToUser(user, ev) => hub.publish_to_user(user, &ev),
        Notice::Channel(cid) => {
            if hub.is_empty() {
                return;
            }
            let users = hub.subscribed_users();
            if users.is_empty() {
                return;
            }
            match viewers.viewers(cid).await {
                Ok(set) => {
                    let ev = TaskEvent::Channel(cid);
                    for u in users {
                        if set.contains(&u) {
                            hub.publish_to_user(u, &ev);
                        }
                    }
                }
                // FAIL CLOSED: an event nobody receives costs a refetch on
                // focus; one sent to the wrong person leaks that a hidden
                // channel is active.
                Err(e) => tracing::warn!("task events: viewer resolve failed for channel {cid}: {e}"),
            }
        }
    }
}

/// Counters the tests (and a curious operator) read.
#[derive(Default)]
pub struct PipelineStats {
    pub received: AtomicU64,
    pub dropped: AtomicU64,
    pub dispatched: AtomicU64,
    pub listener_errors: AtomicU64,
}

/// Where notification payloads come from. A trait so the receive loop's one
/// rule — only ever await this — is testable against a real listener AND a
/// scripted one.
#[async_trait::async_trait]
pub trait NoticeSource: Send {
    async fn next_payload(&mut self) -> Result<String, sqlx::Error>;
}

#[async_trait::async_trait]
impl NoticeSource for sqlx::postgres::PgListener {
    async fn next_payload(&mut self) -> Result<String, sqlx::Error> {
        self.recv().await.map(|n| n.payload().to_owned())
    }
}

/// Drain the listener forever. The ONLY await in the success path is the
/// listener itself; everything downstream is a `try_send`. See the module
/// header for why this is the rule every task write depends on.
pub async fn receive_loop<S: NoticeSource>(
    mut src: S,
    tx: mpsc::Sender<String>,
    overflow: Arc<AtomicBool>,
    stats: Arc<PipelineStats>,
) {
    let mut backoff = Duration::from_millis(500);
    loop {
        match src.next_payload().await {
            Ok(payload) => {
                stats.received.fetch_add(1, Ordering::Relaxed);
                backoff = Duration::from_millis(500);
                match tx.try_send(payload) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        stats.dropped.fetch_add(1, Ordering::Relaxed);
                        overflow.store(true, Ordering::SeqCst);
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => return,
                }
            }
            Err(e) => {
                // PgListener reconnects and re-LISTENs on the next call;
                // whatever was raised meanwhile is lost, so resync everyone.
                stats.listener_errors.fetch_add(1, Ordering::Relaxed);
                overflow.store(true, Ordering::SeqCst);
                tracing::warn!("task events: listener error ({e}); retrying in {backoff:?}");
                if tx.is_closed() {
                    return;
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}

/// Deliver what the receive loop queued, and turn an overflow into one
/// `resync` to every stream (checked on every item and once a second, so a
/// lost-event window is announced even if nothing else arrives).
pub async fn dispatch_loop(
    mut rx: mpsc::Receiver<String>,
    hub: Arc<TaskEventHub>,
    viewers: Arc<dyn ChannelViewers>,
    overflow: Arc<AtomicBool>,
    stats: Arc<PipelineStats>,
) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            item = rx.recv() => {
                let Some(payload) = item else { return };
                if overflow.swap(false, Ordering::SeqCst) {
                    hub.broadcast(&TaskEvent::Resync);
                }
                if let Some(n) = parse_notice(&payload) {
                    dispatch(&hub, viewers.as_ref(), n).await;
                }
                stats.dispatched.fetch_add(1, Ordering::Relaxed);
            }
            _ = tick.tick() => {
                if overflow.swap(false, Ordering::SeqCst) {
                    hub.broadcast(&TaskEvent::Resync);
                }
            }
        }
    }
}

/// Start the pipeline for this process: a dedicated listening connection
/// (its own one-connection pool, so it never holds a slot of the main pool),
/// the receive loop and the dispatcher.
pub fn spawn_pipeline(db_url: String, hub: Arc<TaskEventHub>, pool: sqlx::PgPool) -> Arc<PipelineStats> {
    let stats = Arc::new(PipelineStats::default());
    let overflow = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<String>(RAW_QUEUE);
    {
        let stats = stats.clone();
        let overflow = overflow.clone();
        tokio::spawn(async move {
            let mut backoff = Duration::from_secs(1);
            let listener = loop {
                match sqlx::postgres::PgListener::connect(&db_url).await {
                    Ok(mut l) => match l.listen(EVENT_CHANNEL).await {
                        Ok(()) => break l,
                        Err(e) => tracing::warn!("task events: LISTEN failed: {e}"),
                    },
                    Err(e) => tracing::warn!("task events: listener connect failed: {e}"),
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(60));
            };
            tracing::info!("task events: listening on {EVENT_CHANNEL}");
            receive_loop(listener, tx, overflow, stats).await;
        });
    }
    tokio::spawn(dispatch_loop(rx, hub, Arc::new(DbViewers(pool)), overflow, stats.clone()));
    stats
}

// --- The route -----------------------------------------------------------------

struct StreamState {
    pool: sqlx::PgPool,
    claims: Claims,
    sub: Subscription,
    _slot: Option<IpSlotGuard>,
    deadline: tokio::time::Instant,
    recheck: tokio::time::Interval,
    hello_sent: bool,
    done: bool,
}

fn frame(ev: &TaskEvent) -> Result<Event, Infallible> {
    Ok(Event::default().data(ev.to_json()))
}

/// The event sequence of one stream: `hello`, then events until the
/// subscription closes (evicted), the token expires, or a re-check finds the
/// session revoked.
pub(crate) fn event_stream(
    pool: sqlx::PgPool,
    claims: Claims,
    sub: Subscription,
    slot: Option<IpSlotGuard>,
    recheck_every: Duration,
) -> impl futures::Stream<Item = Result<Event, Infallible>> + Send {
    let remaining = (claims.exp - chrono::Utc::now().timestamp()).max(0) as u64;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(remaining);
    let mut recheck = tokio::time::interval_at(tokio::time::Instant::now() + recheck_every, recheck_every);
    recheck.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let st = StreamState { pool, claims, sub, _slot: slot, deadline, recheck, hello_sent: false, done: false };
    futures::stream::unfold(st, |mut st| async move {
        if st.done {
            return None;
        }
        if !st.hello_sent {
            st.hello_sent = true;
            return Some((frame(&TaskEvent::Hello), st));
        }
        loop {
            tokio::select! {
                m = st.sub.rx.recv() => {
                    return match m {
                        Some(ev) => {
                            // Something was dropped for this stream: say so
                            // instead (a resync covers the event in hand).
                            let out = if st.sub.lagged.swap(false, Ordering::SeqCst) { TaskEvent::Resync } else { ev };
                            Some((frame(&out), st))
                        }
                        None if st.sub.evicted.load(Ordering::SeqCst) => {
                            st.done = true;
                            Some((frame(&TaskEvent::Evicted), st))
                        }
                        None => None,
                    };
                }
                _ = tokio::time::sleep_until(st.deadline) => {
                    st.done = true;
                    return Some((frame(&TaskEvent::Bye("expired")), st));
                }
                _ = st.recheck.tick() => {
                    match crate::auth::token_session_live(&st.pool, &st.claims).await {
                        Ok(true) => continue,
                        // Revoked, or the check itself failed: end. The client
                        // reconnects, and the middleware decides with a fresh
                        // query (401 = signed out).
                        _ => {
                            st.done = true;
                            return Some((frame(&TaskEvent::Bye("revoked")), st));
                        }
                    }
                }
            }
        }
    })
}

/// `GET /events/tasks`. Inside the protected routes, so the bearer token and
/// its session were checked by the middleware before this runs.
pub async fn stream_task_events(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    headers: HeaderMap,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> Response {
    let ip = crate::state::real_client_ip(&headers, peer);
    let cap = std::env::var("TASK_EVENTS_MAX_PER_IP")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(32)
        .max(1); // never 0 (a 0 cap would refuse all + leak an unreaped entry per IP)
    let slot = match state.try_acquire_ip_slot(ip, IpSlotKind::Events, cap) {
        Some(g) => g,
        None => {
            return (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "30")], "Too many event streams from this address")
                .into_response()
        }
    };
    let sub = state.task_events.subscribe(claims.sub);
    let stream = event_stream(state.pool.clone(), claims, sub, Some(slot), RECHECK);
    let mut resp = Sse::new(stream).keep_alive(KeepAlive::new().interval(KEEPALIVE).text("k")).into_response();
    let h = resp.headers_mut();
    // nginx buffers proxied responses by default, which would hold events
    // until a buffer fills; Caddy flushes text/event-stream on its own.
    h.insert(header::HeaderName::from_static("x-accel-buffering"), HeaderValue::from_static("no"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-store"));
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    #[test]
    fn payloads_parse_to_ids_and_nothing_else() {
        assert_eq!(parse_notice(r#"{"c":7}"#), Some(Notice::Channel(7)));
        assert_eq!(parse_notice(r#"{"l":5,"u":2}"#), Some(Notice::ToUser(2, TaskEvent::List(5))));
        assert_eq!(parse_notice(r#"{"L":1,"u":2}"#), Some(Notice::ToUser(2, TaskEvent::Lists)));
        assert_eq!(parse_notice(r#"{"p":1,"u":2}"#), Some(Notice::ToUser(2, TaskEvent::Prefs)));
        assert_eq!(
            parse_notice(r#"{"s":"notes-prefs","u":2}"#),
            Some(Notice::ToUser(2, TaskEvent::Blob("notes-prefs".into())))
        );
        // No owner, an unknown blob name, junk: dropped, never guessed.
        for bad in [r#"{"l":5}"#, r#"{"s":"x","u":2}"#, "nope", r#"{"u":2}"#] {
            assert_eq!(parse_notice(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_wire_form_carries_ids_only() {
        assert_eq!(TaskEvent::List(5).to_json(), r#"{"t":"list","id":5}"#);
        assert_eq!(TaskEvent::Channel(9).to_json(), r#"{"t":"channel","id":9}"#);
        assert_eq!(TaskEvent::Blob("notes-prefs".into()).to_json(), r#"{"name":"notes-prefs","t":"blob"}"#);
        assert_eq!(TaskEvent::Resync.to_json(), r#"{"t":"resync"}"#);
    }

    struct FixedViewers(Result<HashSet<i64>, ()>, Duration);
    #[async_trait::async_trait]
    impl ChannelViewers for FixedViewers {
        async fn viewers(&self, _cid: i64) -> Result<HashSet<i64>, sqlx::Error> {
            if !self.1.is_zero() {
                tokio::time::sleep(self.1).await;
            }
            self.0.clone().map_err(|_| sqlx::Error::PoolTimedOut)
        }
    }

    fn drain(sub: &mut Subscription) -> Vec<TaskEvent> {
        let mut out = Vec::new();
        while let Ok(ev) = sub.rx.try_recv() {
            out.push(ev);
        }
        out
    }

    #[tokio::test]
    async fn a_channel_event_reaches_viewers_and_nobody_else() {
        let hub = TaskEventHub::new();
        let mut viewer = hub.subscribe(1);
        let mut outsider = hub.subscribe(2);
        let v = FixedViewers(Ok([1].into_iter().collect()), Duration::ZERO);
        dispatch(&hub, &v, Notice::Channel(40)).await;
        assert_eq!(drain(&mut viewer), vec![TaskEvent::Channel(40)], "positive control: the viewer hears it");
        assert!(drain(&mut outsider).is_empty(), "a member without VIEW must hear nothing");
    }

    #[tokio::test]
    async fn a_viewer_query_error_sends_nothing() {
        let hub = TaskEventHub::new();
        let mut a = hub.subscribe(1);
        dispatch(&hub, &FixedViewers(Err(()), Duration::ZERO), Notice::Channel(3)).await;
        assert!(drain(&mut a).is_empty(), "fail closed");
        // Positive control: the same stream does get one when the query works.
        dispatch(&hub, &FixedViewers(Ok([1].into_iter().collect()), Duration::ZERO), Notice::Channel(3)).await;
        assert_eq!(drain(&mut a), vec![TaskEvent::Channel(3)]);
    }

    #[tokio::test]
    async fn personal_events_go_to_their_owner_only() {
        let hub = TaskEventHub::new();
        let mut owner = hub.subscribe(5);
        let mut other = hub.subscribe(6);
        let none = FixedViewers(Ok(HashSet::new()), Duration::ZERO);
        dispatch(&hub, &none, Notice::ToUser(5, TaskEvent::List(11))).await;
        dispatch(&hub, &none, Notice::ToUser(5, TaskEvent::Prefs)).await;
        assert_eq!(drain(&mut owner), vec![TaskEvent::List(11), TaskEvent::Prefs]);
        assert!(drain(&mut other).is_empty());
    }

    #[tokio::test]
    async fn an_overflowing_stream_is_told_to_resync() {
        let hub = TaskEventHub::new();
        let sub = hub.subscribe(1);
        for i in 0..(PER_STREAM_BUFFER as i64 + 10) {
            hub.publish_to_user(1, &TaskEvent::List(i));
        }
        assert!(sub.lagged.load(Ordering::SeqCst), "the dropped events are recorded");
        let claims = Claims { sub: 1, username: "u".into(), exp: chrono::Utc::now().timestamp() + 3600, tv: 0, sst: 0, sid: String::new() };
        let pool = sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://127.0.0.1:1/none").unwrap();
        let s = event_stream(pool, claims, sub, None, Duration::from_secs(3600));
        futures::pin_mut!(s);
        let first = s.next().await.unwrap().unwrap();
        let second = s.next().await.unwrap().unwrap();
        let text = format!("{first:?} {second:?}");
        assert!(text.contains("hello"), "{text}");
        assert!(text.contains("resync"), "the lagged stream's next frame is a resync: {text}");
    }

    #[tokio::test]
    async fn a_fifth_stream_evicts_the_oldest_and_the_oldest_is_told() {
        let hub = TaskEventHub::new();
        let first = hub.subscribe(9);
        let mut rest: Vec<_> = (0..3).map(|_| hub.subscribe(9)).collect();
        assert_eq!(hub.stream_count(), 4);
        rest.push(hub.subscribe(9));
        assert_eq!(hub.stream_count(), 4, "still at the cap");
        assert!(first.evicted.load(Ordering::SeqCst), "the OLDEST went");
        assert!(rest.iter().all(|s| !s.evicted.load(Ordering::SeqCst)));
        let claims = Claims { sub: 9, username: "u".into(), exp: chrono::Utc::now().timestamp() + 3600, tv: 0, sst: 0, sid: String::new() };
        let pool = sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://127.0.0.1:1/none").unwrap();
        let s = event_stream(pool, claims, first, None, Duration::from_secs(3600));
        futures::pin_mut!(s);
        let frames: Vec<String> = s.map(|f| format!("{:?}", f.unwrap())).collect().await;
        assert_eq!(frames.len(), 2, "hello, then evicted, then the end: {frames:?}");
        assert!(frames[1].contains("evicted"), "{frames:?}");
        // Dropping streams unregisters them.
        drop(rest);
        assert!(hub.is_empty());
    }

    // --- Against a real database (skip without one) ------------------------------

    async fn test_pool() -> Option<(sqlx::PgPool, String)> {
        dotenv::dotenv().ok();
        let url = match std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL")) {
            Ok(u) => u,
            Err(_) => {
                println!("skipping: no database");
                return None;
            }
        };
        let pool = match sqlx::postgres::PgPoolOptions::new().max_connections(8).connect(&url).await {
            Ok(p) => p,
            Err(_) => {
                println!("skipping: database unreachable");
                return None;
            }
        };
        sqlx::migrate!("./migrations").run(&pool).await.expect("migrations apply");
        Some((pool, url))
    }

    async fn mk_user(pool: &sqlx::PgPool, tag: &str) -> i64 {
        let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, salt, verifier) VALUES ($1, $2, $3) RETURNING id")
            .bind(format!("te_{tag}_{}", uuid::Uuid::new_v4().simple()))
            .bind(b"s".as_ref())
            .bind(b"v".as_ref())
            .fetch_one(pool)
            .await
            .expect("insert user");
        id as i64
    }

    async fn listener(url: &str) -> sqlx::postgres::PgListener {
        let mut l = sqlx::postgres::PgListener::connect(url).await.expect("listener");
        l.listen(EVENT_CHANNEL).await.expect("listen");
        l
    }

    /// Every payload raised within `window` (other tests share the database,
    /// so callers filter by their own ids).
    async fn collect(l: &mut sqlx::postgres::PgListener, window: Duration) -> Vec<String> {
        let mut out = Vec::new();
        let end = tokio::time::Instant::now() + window;
        while let Ok(Ok(n)) = tokio::time::timeout_at(end, l.recv()).await {
            out.push(n.payload().to_owned());
        }
        out
    }

    /// The triggers raise ids only, fold a cascade into one event, and say
    /// NOTHING for an updated_at-only UPDATE — checked on the real functions,
    /// attached to temp tables shaped like the real ones plus an updated_at
    /// column (which this branch's schema does not have yet; a sibling change
    /// adds it and bumps it on every task write).
    #[tokio::test]
    async fn the_triggers_ignore_updated_at_only_changes_and_carry_ids_only() {
        let Some((pool, url)) = test_pool().await else { return };
        let mut l = listener(&url).await;
        let owner = mk_user(&pool, "trig").await;
        let mut c = pool.acquire().await.unwrap();
        sqlx::query("CREATE TEMP TABLE tl_probe (id BIGINT PRIMARY KEY, owner_id BIGINT, title TEXT, updated_at TIMESTAMPTZ)")
            .execute(&mut *c).await.unwrap();
        sqlx::query("CREATE TRIGGER tl_probe_ev AFTER INSERT OR UPDATE OR DELETE ON tl_probe FOR EACH ROW EXECUTE FUNCTION puca_task_events_list()")
            .execute(&mut *c).await.unwrap();
        sqlx::query("INSERT INTO tl_probe VALUES (1, $1, 'secret title', NOW())").bind(owner).execute(&mut *c).await.unwrap();
        let mine = |v: Vec<String>| v.into_iter().filter(|p| p.contains(&format!("\"u\" : {owner}")) || p.contains(&format!("\"u\":{owner}"))).collect::<Vec<_>>();
        let got = mine(collect(&mut l, Duration::from_millis(800)).await);
        assert_eq!(got.len(), 1, "insert raises one event: {got:?}");
        assert!(!got[0].contains("secret"), "no content in a payload: {}", got[0]);

        sqlx::query("UPDATE tl_probe SET updated_at = NOW() + INTERVAL '1 minute'").execute(&mut *c).await.unwrap();
        let got = mine(collect(&mut l, Duration::from_millis(800)).await);
        assert!(got.is_empty(), "an updated_at-only UPDATE must raise nothing: {got:?}");

        // Positive control: a real change on the same row does.
        sqlx::query("UPDATE tl_probe SET title = 'renamed', updated_at = NOW()").execute(&mut *c).await.unwrap();
        let got = mine(collect(&mut l, Duration::from_millis(800)).await);
        assert_eq!(got.len(), 1, "a rename raises one: {got:?}");
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(owner).execute(&pool).await;
    }

    #[tokio::test]
    async fn a_real_task_write_raises_one_event_per_transaction() {
        let Some((pool, url)) = test_pool().await else { return };
        let mut l = listener(&url).await;
        let owner = mk_user(&pool, "task").await;
        let (list_id,): (i64,) = sqlx::query_as("INSERT INTO task_lists (owner_id, title) VALUES ($1, 't') RETURNING id")
            .bind(owner).fetch_one(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        for i in 0..20 {
            sqlx::query("INSERT INTO channel_tasks (list_id, description, created_by, position) VALUES ($1, $2, $3, $4)")
                .bind(list_id).bind(format!("item {i}")).bind(owner).bind(i as i64)
                .execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        let want = format!("{{\"l\" : {list_id}, \"u\" : {owner}}}");
        let got: Vec<String> = collect(&mut l, Duration::from_millis(800)).await.into_iter().filter(|p| p.contains(&format!("{list_id}")) && p.contains("\"l\"")).collect();
        assert_eq!(got, vec![want.clone()], "twenty inserts in one transaction fold into one event");
        assert_eq!(parse_notice(&want), Some(Notice::ToUser(owner, TaskEvent::List(list_id))));
        let _ = sqlx::query("DELETE FROM task_lists WHERE id = $1").bind(list_id).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(owner).execute(&pool).await;
    }

    /// THE AVAILABILITY TEST. A dispatcher that is slow (a viewer query that
    /// takes 50 ms) must not slow the LISTENER: a burst of separate task
    /// writes all commit promptly, the receive loop reads every one of them
    /// (dropping what the dispatcher cannot take, and flagging the overflow),
    /// and Postgres' notification queue does not grow.
    #[tokio::test]
    async fn a_notify_burst_with_a_slow_hub_never_blocks_task_writes() {
        let Some((pool, url)) = test_pool().await else { return };
        let owner = mk_user(&pool, "burst").await;
        let server_id = format!("srv-burst-{}", uuid::Uuid::new_v4().simple());
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, 'b', $2)").bind(&server_id).bind(owner as i32).execute(&pool).await.unwrap();
        let (cid,): (i32,) = sqlx::query_as("INSERT INTO channels (name, server_id) VALUES ('c', $1) RETURNING id").bind(&server_id).fetch_one(&pool).await.unwrap();

        let hub = TaskEventHub::new();
        let _someone = hub.subscribe(owner); // so channel events are dispatched, slowly
        let stats = Arc::new(PipelineStats::default());
        let overflow = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<String>(16); // a small queue, so the burst overflows it
        let l = listener(&url).await;
        let recv = tokio::spawn(receive_loop(l, tx, overflow.clone(), stats.clone()));
        let slow: Arc<dyn ChannelViewers> = Arc::new(FixedViewers(Ok([owner].into_iter().collect()), Duration::from_millis(50)));
        let disp = tokio::spawn(dispatch_loop(rx, hub.clone(), slow, overflow.clone(), stats.clone()));

        const N: u64 = 400;
        let started = std::time::Instant::now();
        for i in 0..N {
            // One transaction each: identical payloads in DIFFERENT
            // transactions are not folded, so this is N notifications.
            sqlx::query("INSERT INTO channel_tasks (channel_id, description, created_by, position) VALUES ($1, $2, $3, $4)")
                .bind(cid as i64).bind(format!("t{i}")).bind(owner).bind(i as i64)
                .execute(&pool).await.unwrap();
        }
        let wrote_in = started.elapsed();
        // At 50 ms per dispatched event the dispatcher alone would need 20 s.
        assert!(wrote_in < Duration::from_secs(15), "the writes themselves were held up: {wrote_in:?}");

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while stats.received.load(Ordering::Relaxed) < N && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let received = stats.received.load(Ordering::Relaxed);
        assert!(received >= N, "the listener kept draining while the hub was slow: {received}/{N}");
        assert!(stats.dropped.load(Ordering::Relaxed) > 0, "the slow dispatcher really was overrun (else this proves nothing)");
        let (usage,): (f64,) = sqlx::query_as("SELECT pg_notification_queue_usage()").fetch_one(&pool).await.unwrap();
        assert!(usage < 0.001, "the notification queue must not be filling: {usage}");

        recv.abort();
        disp.abort();
        let _ = sqlx::query("DELETE FROM channels WHERE id = $1").bind(cid).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&server_id).execute(&pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(owner).execute(&pool).await;
    }

    /// A stream whose session is revoked ends at the next re-check.
    #[tokio::test]
    async fn a_revoked_sessions_stream_ends_within_the_recheck_interval() {
        let Some((pool, _url)) = test_pool().await else { return };
        let user = mk_user(&pool, "rev").await;
        let sid = format!("sid-{}", uuid::Uuid::new_v4().simple());
        sqlx::query("INSERT INTO token_sessions (sid, user_id) VALUES ($1, $2)").bind(&sid).bind(user as i32).execute(&pool).await.unwrap();
        let (tv,): (i32,) = sqlx::query_as("SELECT token_version FROM users WHERE id = $1").bind(user as i32).fetch_one(&pool).await.unwrap();
        let claims = Claims { sub: user, username: "u".into(), exp: chrono::Utc::now().timestamp() + 3600, tv, sst: 0, sid: sid.clone() };
        let hub = TaskEventHub::new();
        let s = event_stream(pool.clone(), claims, hub.subscribe(user), None, Duration::from_millis(200));
        futures::pin_mut!(s);
        assert!(format!("{:?}", s.next().await.unwrap().unwrap()).contains("hello"));
        // Positive control: while live, a re-check passes and the stream stays open.
        assert!(tokio::time::timeout(Duration::from_millis(600), s.next()).await.is_err(), "a live session's stream stays open");
        sqlx::query("UPDATE token_sessions SET revoked_at = NOW() WHERE sid = $1").bind(&sid).execute(&pool).await.unwrap();
        let bye = tokio::time::timeout(Duration::from_secs(2), s.next()).await.expect("ended within the interval").unwrap().unwrap();
        assert!(format!("{bye:?}").contains("revoked"), "{bye:?}");
        assert!(s.next().await.is_none(), "and then the stream is over");
        let _ = sqlx::query("DELETE FROM users WHERE id = $1").bind(user).execute(&pool).await;
    }
}
