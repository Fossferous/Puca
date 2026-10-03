//! Games, the server half: card tables bound to a voice call
//! (docs/GAMES.md, *Server design*).
//!
//! The rules are `crates/puca-games`; the wire shapes are `crate::games_wire`.
//! This module holds the tables, decides who may do what, runs the clocks,
//! and sends every connection the table as THAT connection may see it.
//!
//! WHO IS IN THE CALL. Every frame is checked against the room's own
//! membership, `state.rooms.get(room).conns_of(user)` containing this
//! connection, read under the room guard - never the socket's
//! `joined_rooms`, which an eviction running on another task cannot update.
//!
//! FAN-OUT. Per connection, over `Room.member_conns`, with `send_to_conn`
//! only, and only to connections that announced `games`
//! (`AppState::conn_plays_games`, never a delivery socket). A seat's own view
//! (its hole cards) goes to that user's connections in the call and nobody
//! else's; everyone else in the call gets the spectator view.
//!
//! LOCKS. The registry sits behind a plain mutex held only to open, close or
//! look up a table; each table behind its own plain mutex held only for an
//! engine call and the sends that report it. Never both at once, and never
//! across an `.await`. Never a `state.rooms` guard while a table is locked,
//! and never a table lock while a `rooms` guard is held: every path reads
//! what it needs from the room (the recipients, a membership answer), drops
//! the guard, THEN locks the table. Sending under a table lock touches only
//! `state.sessions` (`conn_plays_games`, `send_to_conn`), which no path holds
//! while taking a table lock - so frames leave in version order.
//!
//! TIMERS hold a weak reference to their table and the `TurnRef` (or the
//! generation) they were made for. A timer whose decision has passed is a
//! no-op, so none needs exact cancellation; a closed table's timers find it
//! closed (or gone) and do nothing.
//!
//! NOTHING PERSISTS. Every table, stack and seat is in memory and a restart
//! ends them all; a frame for a table the server does not know is answered
//! `GameEnded { gone }`.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

use dashmap::DashMap;
use puca_games::blackjack::BlackjackTable;
use puca_games::holdem::HoldemTable;
use puca_games::registry::{GameKind, RoomTables, TableId, DEFAULT_MAX_OPEN_TABLES, MAX_TABLE_ID};
use puca_games::{rng, TurnRef};
use tokio::time::{Duration, Instant};

use crate::games_wire::{
    blackjack_events, blackjack_view, holdem_events, holdem_view, player_id, user_of, GameEndReason, GameEventsWire,
    GameKindWire, GameOp, GameRefusal, GameView, ViewExtras,
};
use crate::permissions::{get_user_channel_permissions, ChannelPermAccess, Permissions};
use crate::protocol::{ClientMessage, ServerMessage};
use crate::state::{AppState, RoomId, UserId};

/// Tables open at once on this server (docs/GAMES.md; the engine's default).
pub const MAX_OPEN_TABLES: usize = DEFAULT_MAX_OPEN_TABLES;
/// Opening tables: 5 per 5 minutes per user (the clip-rate pattern).
pub const CREATE_RATE_WINDOW: Duration = Duration::from_secs(300);
pub const CREATE_RATE_MAX: u32 = 5;
/// `GameResync`: one a second per connection.
pub const RESYNC_MIN_INTERVAL: Duration = Duration::from_secs(1);
/// Hold'em: the next hand is dealt this long after the last one ended (or
/// after a second player sat down), when two players can be dealt in.
pub const NEXT_HAND_DELAY: Duration = Duration::from_secs(3);
/// Blackjack: the round is dealt when every player at the table has bet, or
/// this long after the first bet.
pub const BET_WINDOW: Duration = Duration::from_secs(15);
/// Blackjack: once every player at the table has bet, the round is dealt this
/// long after the last bet - not at once - so the last bettor (and everyone
/// watching) sees the bets before the cards come (owner decision 2026-10-03,
/// docs/GAMES.md).
pub const LAST_BET_DELAY: Duration = Duration::from_millis(1_500);
/// A table nobody sits at stops holding the call's one slot after this
/// (`GameEnded { idle }`; owner to confirm the value, docs/GAMES.md).
pub const IDLE_LIMIT: Duration = Duration::from_secs(300);
/// Above this many entries a rate map drops what has aged out.
const RATE_MAP_PRUNE_AT: usize = 4096;

/// How long the server waits for each thing it waits for. Production values
/// are the constants above plus the WebSocket rejoin grace
/// (`WS_REJOIN_GRACE_SECS`); tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct Timings {
    pub next_hand: Duration,
    pub bet_window: Duration,
    /// Blackjack: the deal after the last bet (`LAST_BET_DELAY`).
    pub last_bet: Duration,
    pub idle: Duration,
    /// `None`: the rejoin grace the WebSocket layer uses, read when needed.
    pub grace: Option<Duration>,
}

impl Timings {
    pub const PRODUCTION: Timings =
        Timings { next_hand: NEXT_HAND_DELAY, bet_window: BET_WINDOW, last_bet: LAST_BET_DELAY, idle: IDLE_LIMIT, grace: None };

    fn grace(&self) -> Duration {
        self.grace.unwrap_or_else(crate::ws::rejoin_grace)
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// The registry and the tables

/// The open tables: the engine's one-table-per-call registry, plus which
/// server each table's call belongs to (switching games off ends that
/// server's tables).
struct Registry {
    tables: RoomTables<RoomId, Arc<TableCell>>,
    server_of: HashMap<RoomId, String>,
}

/// One open table. `id` is the registry's, set when it opens (under the
/// registry lock, before anyone else can see the cell).
pub struct TableCell {
    room: RoomId,
    /// Who opened it (`GameTable.opened_by`: "<name> started Poker").
    opener: UserId,
    id: OnceLock<u64>,
    inner: Mutex<TableState>,
}

impl TableCell {
    fn id(&self) -> u64 {
        self.id.get().copied().unwrap_or(0)
    }
}

enum Engine {
    Holdem(HoldemTable),
    Blackjack(BlackjackTable),
}

impl Engine {
    fn kind(&self) -> GameKind {
        match self {
            Engine::Holdem(_) => GameKind::Holdem,
            Engine::Blackjack(_) => GameKind::Blackjack,
        }
    }

    /// (seat, user) of every occupied seat.
    fn occupants(&self) -> Vec<(usize, UserId)> {
        match self {
            Engine::Holdem(t) => t.view_for(None).seats.iter().flatten().map(|s| (s.seat, user_of(s.player))).collect(),
            Engine::Blackjack(t) => t.view().seats.iter().flatten().map(|s| (s.seat, user_of(s.player))).collect(),
        }
    }

    fn seat_of(&self, user: UserId) -> Option<usize> {
        match self {
            Engine::Holdem(t) => t.seat_of(player_id(user)),
            Engine::Blackjack(_) => self.occupants().into_iter().find(|&(_, u)| u == user).map(|(s, _)| s),
        }
    }

    fn turn(&self) -> Option<TurnRef> {
        match self {
            Engine::Holdem(t) => t.turn(),
            Engine::Blackjack(t) => t.turn(),
        }
    }

    fn turn_clock(&self) -> Duration {
        Duration::from_secs(u64::from(match self {
            Engine::Holdem(t) => t.config().turn_clock_secs,
            Engine::Blackjack(t) => t.config().turn_clock_secs,
        }))
    }

    /// How long to wait before dealing, when a deal is wanted now: Hold'em
    /// between hands with two players who can be dealt in; Blackjack between
    /// rounds once someone has bet - the bet window, or only `last_bet` once
    /// every player at the table has bet.
    fn deal_wanted(&self, t: &Timings) -> Option<Duration> {
        if self.everyone_has_bet() {
            return Some(t.last_bet);
        }
        match self {
            Engine::Holdem(h) => {
                let v = h.view_for(None);
                let dealable =
                    v.seats.iter().flatten().filter(|s| !s.sitting_out && !s.leaving && s.stack > 0).count();
                (!v.in_hand && dealable >= 2).then_some(t.next_hand)
            }
            Engine::Blackjack(b) => {
                let v = b.view();
                (!v.in_round && v.seats.iter().flatten().any(|s| s.pending_bet > 0)).then_some(t.bet_window)
            }
        }
    }

    /// Blackjack: every player who could play this round has bet.
    fn everyone_has_bet(&self) -> bool {
        let Engine::Blackjack(b) = self else { return false };
        let v = b.view();
        if v.in_round {
            return false;
        }
        let mut active = v.seats.iter().flatten().filter(|s| !s.sitting_out && !s.leaving).peekable();
        active.peek().is_some() && active.all(|s| s.pending_bet > 0)
    }

    /// The deal itself (the next hand / round), with the OS CSPRNG.
    fn deal(&mut self) -> Option<GameEventsWire> {
        match self {
            Engine::Holdem(t) => t.start_hand(&mut rng::os_rng()).ok().map(|e| holdem_events(&e)),
            Engine::Blackjack(t) => t.deal(&mut rng::os_rng()).ok().map(|e| blackjack_events(&e)),
        }
    }

    /// The turn clock for `turn` ran out. `None` when that decision passed.
    fn timeout(&mut self, turn: TurnRef) -> Option<GameEventsWire> {
        match self {
            Engine::Holdem(t) => t.timeout(turn).ok().map(|e| holdem_events(&e)),
            Engine::Blackjack(t) => t.timeout(turn, &mut rng::os_rng()).ok().map(|e| blackjack_events(&e)),
        }
    }

    /// Get up from `seat` (the engine's `leave`).
    fn leave(&mut self, seat: usize) -> Result<GameEventsWire, GameRefusal> {
        match self {
            Engine::Holdem(t) => t.leave(seat).map(|e| holdem_events(&e)).map_err(Into::into),
            Engine::Blackjack(t) => t.leave(seat, &mut rng::os_rng()).map(|e| blackjack_events(&e)).map_err(Into::into),
        }
    }
}

fn events_empty(e: &GameEventsWire) -> bool {
    match e {
        GameEventsWire::Holdem(v) => v.is_empty(),
        GameEventsWire::Blackjack(v) => v.is_empty(),
    }
}

/// Everything about one table that lives behind its lock.
struct TableState {
    engine: Engine,
    /// 1 when it opens, + 1 for every change any view shows.
    version: u64,
    /// Set (under this lock) the moment the table ends; every later lock
    /// holder answers `gone` / does nothing.
    closed: bool,
    /// Seats whose player left the call, with when: the disconnect grace.
    away: BTreeMap<usize, (UserId, Instant)>,
    /// The decision the turn clock runs for, and when it runs out.
    clock: Option<(TurnRef, Instant)>,
    /// (generation, when) of the scheduled deal.
    next_deal: Option<(u64, Instant)>,
    /// (generation, when) of the idle close, while nobody is seated.
    idle: Option<(u64, Instant)>,
    /// Generations for the deal and idle timers: a timer whose generation is
    /// no longer the scheduled one does nothing.
    gen: u64,
    /// When the call emptied (the table ends one grace later, unless someone
    /// came back).
    empty_since: Option<Instant>,
}

impl TableState {
    fn extras(&self, now: Instant) -> ViewExtras {
        let left = |at: Instant| at.saturating_duration_since(now).as_millis() as u64;
        ViewExtras {
            away: self.away.keys().copied().collect(),
            clock_ms: self.clock.filter(|(t, _)| Some(*t) == self.engine.turn()).map(|(_, at)| left(at)),
            next_deal_in_ms: self.next_deal.map(|(_, at)| left(at)),
        }
    }

    /// The table as one connection may see it. `seat`: the viewer's own seat
    /// (their hole cards), `None` for a spectator.
    fn view(&self, seat: Option<usize>, extras: &ViewExtras) -> GameView {
        match &self.engine {
            Engine::Holdem(t) => holdem_view(&t.view_for(seat), extras),
            Engine::Blackjack(t) => blackjack_view(&t.view(), seat, extras),
        }
    }
}

/// What a locked table needs to report a change: who to tell and how to
/// reach the timers.
struct Ctx<'a> {
    games: &'a Games,
    state: &'a AppState,
    cell: &'a Arc<TableCell>,
    /// The call's connections that play games, read BEFORE the table lock.
    recips: &'a [(UserId, u64)],
}

impl Ctx<'_> {
    /// Send every recipient its own frame: the table as that connection may
    /// see it, with `events` (a `GameEvents`) or without (a `GameTable`).
    fn send(&self, ts: &TableState, events: Option<&GameEventsWire>) {
        let extras = ts.extras(Instant::now());
        let mut views: HashMap<Option<usize>, GameView> = HashMap::new();
        let occupants = ts.engine.occupants();
        for &(user, conn) in self.recips {
            let seat = occupants.iter().find(|&&(_, u)| u == user).map(|&(s, _)| s);
            let view = views.entry(seat).or_insert_with(|| ts.view(seat, &extras)).clone();
            let msg = match events {
                Some(ev) => ServerMessage::GameEvents {
                    room_id: self.cell.room.clone(),
                    table_id: self.cell.id(),
                    version: ts.version,
                    events: ev.clone(),
                    view,
                },
                None => ServerMessage::GameTable {
                    room_id: self.cell.room.clone(),
                    table_id: self.cell.id(),
                    version: ts.version,
                    view,
                    opened_by: Some(self.cell.opener),
                },
            };
            self.state.send_to_conn(user, conn, msg);
        }
    }

    /// One engine call returned `events`: the version moves on, the clocks
    /// follow the table (a Blackjack bet that completes the table brings the
    /// deal forward to `last_bet` from now), and everyone hears it.
    fn apply(&self, ts: &mut TableState, events: GameEventsWire) {
        if events_empty(&events) {
            // A no-op (sit_out twice): nothing changed, nothing is sent.
            return;
        }
        ts.version += 1;
        self.schedule(ts);
        self.send(ts, Some(&events));
    }

    /// A change only the server knows about (a seat's `away`, a countdown
    /// that ended without a deal): a new version, as a `GameTable`.
    fn bump(&self, ts: &mut TableState) {
        ts.version += 1;
        self.schedule(ts);
        self.send(ts, None);
    }

    /// Bring the timers in line with the table. Called before every send,
    /// so the view a frame carries shows the clocks as they now run.
    fn schedule(&self, ts: &mut TableState) {
        let now = Instant::now();
        let timings = self.games.timings();
        // A seat that emptied, or changed hands, is nobody's grace any more.
        let occupants = ts.engine.occupants();
        ts.away.retain(|seat, (user, _)| occupants.contains(&(*seat, *user)));

        match ts.engine.turn() {
            Some(turn) if ts.clock.map(|(t, _)| t) != Some(turn) => {
                let after = ts.engine.turn_clock();
                ts.clock = Some((turn, now + after));
                self.games.spawn_turn_clock(self.cell, turn, after);
            }
            Some(_) => {}
            None => ts.clock = None,
        }

        match (ts.engine.deal_wanted(&timings), ts.next_deal) {
            (Some(after), None) => {
                ts.gen += 1;
                ts.next_deal = Some((ts.gen, now + after));
                self.games.spawn_deal(self.cell, ts.gen, after);
            }
            // Wanted SOONER than scheduled: the last Blackjack bet came in
            // inside the bet window. A new generation, so the window's timer
            // does nothing when it fires. (Hold'em's delay is constant, so a
            // deal it scheduled is never sooner than now + the same delay.)
            (Some(after), Some((_, at))) if now + after < at => {
                ts.gen += 1;
                ts.next_deal = Some((ts.gen, now + after));
                self.games.spawn_deal(self.cell, ts.gen, after);
            }
            // No longer wanted (the last bet was taken back, a player left):
            // the timer's generation no longer matches, so it does nothing.
            (None, Some(_)) => ts.next_deal = None,
            _ => {}
        }

        if occupants.is_empty() {
            if ts.idle.is_none() {
                ts.gen += 1;
                ts.idle = Some((ts.gen, now + timings.idle));
                self.games.spawn_idle(self.cell, ts.gen, timings.idle);
            }
        } else {
            ts.idle = None;
        }
    }
}

// ---------------------------------------------------------------------------
// Games: the server-wide state

/// The games layer's share of `AppState` (`AppState::games`).
pub struct Games {
    /// The state this lives in, for the timers (set by `AppState::new`).
    state: Weak<AppState>,
    registry: Mutex<Registry>,
    /// user -> (window start, opens in it).
    create_rate: DashMap<UserId, (Instant, u32)>,
    /// connection -> last answered resync.
    resync_rate: DashMap<u64, Instant>,
    timings: Mutex<Timings>,
    /// Tests: a stand-in for the database gate, keyed (channel, user).
    #[cfg(test)]
    test_gate: Mutex<Option<HashMap<(i64, UserId), TestGate>>>,
    /// Tests: every departure handed to this layer, in order.
    #[cfg(test)]
    pub(crate) departures_seen: Mutex<Vec<(RoomId, UserId)>>,
    /// Tests: runs inside the stand-in gate, while the frame's handler is
    /// "awaiting the database" - what another task did meanwhile.
    #[cfg(test)]
    #[allow(clippy::type_complexity)]
    gate_hook: Mutex<Option<Box<dyn Fn(&AppState) + Send + Sync>>>,
}

/// Tests only: what the database would have said for (channel, user).
#[cfg(test)]
#[derive(Clone, Debug)]
pub(crate) struct TestGate {
    pub server_id: String,
    pub enabled: bool,
    pub perms: Permissions,
}

impl Games {
    pub fn new(state: Weak<AppState>) -> Self {
        Self::with_cap(state, MAX_OPEN_TABLES)
    }

    fn with_cap(state: Weak<AppState>, cap: usize) -> Self {
        // Ids start at a random point (below 2^53) so an id a client kept from
        // before a restart does not name a new table by accident.
        let first_id = 1 + rng::below(&mut rng::os_rng(), MAX_TABLE_ID / 2);
        Games {
            state,
            registry: Mutex::new(Registry { tables: RoomTables::new(cap, first_id), server_of: HashMap::new() }),
            create_rate: DashMap::new(),
            resync_rate: DashMap::new(),
            timings: Mutex::new(Timings::PRODUCTION),
            #[cfg(test)]
            test_gate: Mutex::new(None),
            #[cfg(test)]
            departures_seen: Mutex::new(Vec::new()),
            #[cfg(test)]
            gate_hook: Mutex::new(None),
        }
    }

    fn timings(&self) -> Timings {
        *lock(&self.timings)
    }

    /// How many tables are open.
    #[cfg(test)]
    pub fn open_tables(&self) -> usize {
        lock(&self.registry).tables.len()
    }

    /// The call's table, if one is open (the registry lock is released
    /// before this returns).
    fn lookup(&self, room: &str) -> Option<Arc<TableCell>> {
        lock(&self.registry).tables.get(&room.to_string()).map(|t| Arc::clone(&t.table))
    }

    /// The call's table only if it is still table `id`.
    fn lookup_id(&self, room: &str, id: u64) -> Option<Arc<TableCell>> {
        lock(&self.registry).tables.get_mut(&room.to_string(), TableId(id)).map(|t| Arc::clone(&t.table))
    }

    // --- timers --------------------------------------------------------------

    fn spawn(&self, fut: impl std::future::Future<Output = ()> + Send + 'static) {
        // Only inside a runtime; a synchronous caller (a unit test of a Room
        // mutator) has no table and no timer to run.
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(fut);
        }
    }

    fn spawn_turn_clock(&self, cell: &Arc<TableCell>, turn: TurnRef, after: Duration) {
        let (cell, state) = (Arc::downgrade(cell), self.state.clone());
        self.spawn(async move {
            tokio::time::sleep(after).await;
            if let (Some(cell), Some(state)) = (cell.upgrade(), state.upgrade()) {
                state.games.on_turn_clock(&state, &cell, turn);
            }
        });
    }

    fn spawn_deal(&self, cell: &Arc<TableCell>, gen: u64, after: Duration) {
        let (cell, state) = (Arc::downgrade(cell), self.state.clone());
        self.spawn(async move {
            tokio::time::sleep(after).await;
            if let (Some(cell), Some(state)) = (cell.upgrade(), state.upgrade()) {
                state.games.on_deal_timer(&state, &cell, gen);
            }
        });
    }

    fn spawn_idle(&self, cell: &Arc<TableCell>, gen: u64, after: Duration) {
        let (cell, state) = (Arc::downgrade(cell), self.state.clone());
        self.spawn(async move {
            tokio::time::sleep(after).await;
            if let (Some(cell), Some(state)) = (cell.upgrade(), state.upgrade()) {
                state.games.on_idle(&state, &cell, gen);
            }
        });
    }

    fn spawn_grace(&self, cell: &Arc<TableCell>, seat: usize, user: UserId, since: Instant) {
        let (cell, state) = (Arc::downgrade(cell), self.state.clone());
        let after = self.timings().grace();
        self.spawn(async move {
            tokio::time::sleep(after).await;
            if let (Some(cell), Some(state)) = (cell.upgrade(), state.upgrade()) {
                state.games.on_grace(&state, &cell, seat, user, since);
            }
        });
    }

    fn spawn_empty_check(&self, cell: &Arc<TableCell>, since: Instant) {
        let (cell, state) = (Arc::downgrade(cell), self.state.clone());
        let after = self.timings().grace();
        self.spawn(async move {
            tokio::time::sleep(after).await;
            if let (Some(cell), Some(state)) = (cell.upgrade(), state.upgrade()) {
                state.games.on_empty_check(&state, &cell, since);
            }
        });
    }

    /// The turn clock for `turn` ran out: check if free, else fold (Hold'em),
    /// stand (Blackjack). A decision that already passed is a no-op.
    fn on_turn_clock(&self, state: &AppState, cell: &Arc<TableCell>, turn: TurnRef) {
        let recips = recipients(state, &cell.room);
        let ctx = Ctx { games: self, state, cell, recips: &recips };
        let mut ts = lock(&cell.inner);
        if ts.closed {
            return;
        }
        if let Some(events) = ts.engine.timeout(turn) {
            ctx.apply(&mut ts, events);
        }
    }

    /// The scheduled deal is due.
    fn on_deal_timer(&self, state: &AppState, cell: &Arc<TableCell>, gen: u64) {
        let recips = recipients(state, &cell.room);
        let ctx = Ctx { games: self, state, cell, recips: &recips };
        let mut ts = lock(&cell.inner);
        if ts.closed || ts.next_deal.map(|(g, _)| g) != Some(gen) {
            return;
        }
        ts.next_deal = None;
        match ts.engine.deal() {
            Some(events) => ctx.apply(&mut ts, events),
            // Nobody left to deal to: the countdown everyone saw is over.
            None => ctx.bump(&mut ts),
        }
    }

    /// Nobody sat down for the idle limit: the table gives up the call's slot.
    fn on_idle(&self, state: &AppState, cell: &Arc<TableCell>, gen: u64) {
        let recips = recipients(state, &cell.room);
        {
            let mut ts = lock(&cell.inner);
            if ts.closed || ts.idle.map(|(g, _)| g) != Some(gen) || !ts.engine.occupants().is_empty() {
                return;
            }
            ts.closed = true;
        }
        self.finish_close(state, cell, &recips, GameEndReason::Idle);
    }

    /// A seat's disconnect grace ran out. Back in the call: the seat is
    /// simply theirs again. Still gone: they get up (mid-hand that folds them
    /// now and frees the seat when the hand ends; Blackjack stands every hand).
    fn on_grace(&self, state: &AppState, cell: &Arc<TableCell>, seat: usize, user: UserId, since: Instant) {
        let back = in_room(state, &cell.room, user);
        let recips = recipients(state, &cell.room);
        let ctx = Ctx { games: self, state, cell, recips: &recips };
        let mut ts = lock(&cell.inner);
        if ts.closed || ts.away.get(&seat) != Some(&(user, since)) {
            return; // they came back (or the seat changed hands) meanwhile
        }
        ts.away.remove(&seat);
        if back {
            ctx.bump(&mut ts);
            return;
        }
        match ts.engine.leave(seat) {
            Ok(events) if !events_empty(&events) => ctx.apply(&mut ts, events),
            _ => ctx.bump(&mut ts),
        }
    }

    /// The call emptied one grace ago: if it is still empty, the table ends.
    fn on_empty_check(&self, state: &AppState, cell: &Arc<TableCell>, since: Instant) {
        let occupied = state.rooms.get(&cell.room).is_some_and(|r| !r.members.is_empty());
        {
            let mut ts = lock(&cell.inner);
            if ts.closed || ts.empty_since != Some(since) {
                return;
            }
            if occupied {
                ts.empty_since = None;
                return;
            }
            ts.closed = true;
        }
        self.finish_close(state, cell, &[], GameEndReason::CallEnded);
    }

    // --- closing ---------------------------------------------------------------

    /// The second half of every close: the table was marked closed under its
    /// own lock (which is released); take it out of the registry and tell
    /// whoever was in the call.
    fn finish_close(&self, state: &AppState, cell: &Arc<TableCell>, recips: &[(UserId, u64)], reason: GameEndReason) {
        {
            let mut reg = lock(&self.registry);
            if reg.tables.close(&cell.room, TableId(cell.id())).is_some() {
                reg.server_of.remove(&cell.room);
            }
        }
        for &(user, conn) in recips {
            state.send_to_conn(
                user,
                conn,
                ServerMessage::GameEnded { room_id: cell.room.clone(), table_id: cell.id(), reason },
            );
        }
        tracing::info!("Games: table {} in {} ended ({:?})", cell.id(), cell.room, reason);
    }

    fn close_cell(&self, state: &AppState, cell: &Arc<TableCell>, reason: GameEndReason) -> bool {
        let recips = recipients(state, &cell.room);
        {
            let mut ts = lock(&cell.inner);
            if ts.closed {
                return false;
            }
            ts.closed = true;
        }
        self.finish_close(state, cell, &recips, reason);
        true
    }

    /// Ends whatever table the call has (the voice channel was deleted).
    pub fn close_room(&self, state: &AppState, room: &str, reason: GameEndReason) -> bool {
        match self.lookup(room) {
            Some(cell) => self.close_cell(state, &cell, reason),
            None => false,
        }
    }

    /// Ends every table of a server (games switched off, the server deleted).
    pub fn close_server(&self, state: &AppState, server_id: &str, reason: GameEndReason) -> usize {
        let cells: Vec<Arc<TableCell>> = {
            let reg = lock(&self.registry);
            reg.server_of
                .iter()
                .filter(|(_, s)| s.as_str() == server_id)
                .filter_map(|(room, _)| reg.tables.get(room).map(|t| Arc::clone(&t.table)))
                .collect()
        };
        cells.iter().filter(|c| self.close_cell(state, c, reason)).count()
    }

    // --- the call's comings and goings --------------------------------------

    /// Users who left the call (`Room::remove_member`, drained by every
    /// room mutator after it dropped its guard: `AppState::settle_room`).
    /// A seated player's seat goes `away` and its grace starts; one who is
    /// already back (a rejoin raced the drain) is left alone.
    pub fn on_departures(&self, state: &AppState, room: &str, users: &[UserId]) {
        #[cfg(test)]
        lock(&self.departures_seen).extend(users.iter().map(|&u| (room.to_string(), u)));
        let Some(cell) = self.lookup(room) else { return };
        let gone: Vec<UserId> = {
            let r = state.rooms.get(room);
            users.iter().copied().filter(|&u| r.as_ref().is_none_or(|r| r.conns_of(u).is_none())).collect()
        };
        if gone.is_empty() {
            return;
        }
        let recips = recipients(state, room);
        let ctx = Ctx { games: self, state, cell: &cell, recips: &recips };
        let mut ts = lock(&cell.inner);
        if ts.closed {
            return;
        }
        let now = Instant::now();
        let mut changed = false;
        for user in gone {
            if let Some(seat) = ts.engine.seat_of(user) {
                if !ts.away.contains_key(&seat) {
                    ts.away.insert(seat, (user, now));
                    self.spawn_grace(&cell, seat, user, now);
                    changed = true;
                }
            }
        }
        if changed {
            ctx.bump(&mut ts);
        }
    }

    /// The call's room was dropped (its last member left): the table ends
    /// one grace later unless somebody is back by then.
    pub fn on_room_emptied(&self, room: &str) {
        let Some(cell) = self.lookup(room) else { return };
        let now = Instant::now();
        {
            let mut ts = lock(&cell.inner);
            if ts.closed {
                return;
            }
            ts.empty_since = Some(now);
        }
        self.spawn_empty_check(&cell, now);
    }

    /// A connection joined the call (after its `RoomJoined`). It is sent the
    /// table - a newcomer has no id to resync with - and if its user's seat
    /// was in the disconnect grace, the seat is theirs again.
    ///
    /// `may_play` is JoinRoom's OWN permission answer (`CONNECT` +
    /// `PLAY_GAMES` in this channel). A seated user who may no longer play
    /// gets up here: a deny that landed while they were away (inside the
    /// grace, or in another channel) was never seen by the sweep, which walks
    /// the people IN the call, and every own-seat frame skips the database
    /// gate - so without this they came back and played on.
    pub fn on_join(&self, state: &AppState, room: &str, user: UserId, conn: u64, may_play: bool) {
        let Some(cell) = self.lookup(room) else { return };
        let plays = state.conn_plays_games(user, conn);
        let recips = recipients(state, room);
        let ctx = Ctx { games: self, state, cell: &cell, recips: &recips };
        let mut ts = lock(&cell.inner);
        if ts.closed {
            return;
        }
        ts.empty_since = None;
        if plays {
            let one = [(user, conn)];
            Ctx { recips: &one, ..ctx }.send(&ts, None);
        }
        if let Some(seat) = ts.engine.seat_of(user) {
            let was_away = ts.away.get(&seat).is_some_and(|(u, _)| *u == user);
            if was_away {
                ts.away.remove(&seat);
            }
            if !may_play {
                match ts.engine.leave(seat) {
                    Ok(events) if !events_empty(&events) => {
                        tracing::info!("Games: user {} stood up from the table in {} on rejoining (may not play)", user, room);
                        ctx.apply(&mut ts, events);
                    }
                    _ if was_away => ctx.bump(&mut ts),
                    _ => {}
                }
            } else if was_away {
                ctx.bump(&mut ts);
            }
        }
    }

    /// The permission sweep found `user` still in the call but without
    /// `PLAY_GAMES` (or out of it for good: kicked, banned, VIEW gone): they
    /// get up from the table now, no grace.
    pub fn stand_up(&self, state: &AppState, room: &str, user: UserId) -> bool {
        let Some(cell) = self.lookup(room) else { return false };
        let recips = recipients(state, room);
        let ctx = Ctx { games: self, state, cell: &cell, recips: &recips };
        let mut ts = lock(&cell.inner);
        if ts.closed {
            return false;
        }
        let Some(seat) = ts.engine.seat_of(user) else { return false };
        ts.away.remove(&seat);
        match ts.engine.leave(seat) {
            Ok(events) => {
                ctx.apply(&mut ts, events);
                true
            }
            Err(_) => false,
        }
    }

    // --- rate limits ------------------------------------------------------------

    /// Reserves one of the user's opens; `false` when the window is full.
    fn take_create(&self, user: UserId) -> bool {
        let now = Instant::now();
        if self.create_rate.len() > RATE_MAP_PRUNE_AT {
            self.create_rate.retain(|_, (start, _)| now.duration_since(*start) <= CREATE_RATE_WINDOW);
        }
        let mut e = self.create_rate.entry(user).or_insert((now, 0));
        if now.duration_since(e.0) > CREATE_RATE_WINDOW {
            *e = (now, 0);
        }
        if e.1 >= CREATE_RATE_MAX {
            return false;
        }
        e.1 += 1;
        true
    }

    /// Gives back a reserved open that did not open anything.
    fn refund_create(&self, user: UserId) {
        if let Some(mut e) = self.create_rate.get_mut(&user) {
            e.1 = e.1.saturating_sub(1);
        }
    }

    fn take_resync(&self, conn: u64) -> bool {
        let now = Instant::now();
        if self.resync_rate.len() > RATE_MAP_PRUNE_AT {
            self.resync_rate.retain(|_, at| now.duration_since(*at) < RESYNC_MIN_INTERVAL);
        }
        let mut allowed = true;
        self.resync_rate
            .entry(conn)
            .and_modify(|at| {
                if now.duration_since(*at) < RESYNC_MIN_INTERVAL {
                    allowed = false;
                } else {
                    *at = now;
                }
            })
            .or_insert(now);
        allowed
    }

    // --- the database gate --------------------------------------------------------

    /// Steps (4) and (5) of the order of checks: games on for this channel's
    /// server, then `need` in this channel (overwrites apply). Answers the
    /// server id. A resolver error fails closed (the resolver answers
    /// NotFound, never a default allow; `games_enabled` reads false).
    async fn gate(&self, state: &AppState, cid: i64, user: UserId, need: Permissions) -> Result<String, GameRefusal> {
        #[cfg(test)]
        if let Some(hook) = lock(&self.gate_hook).take() {
            hook(state);
        }
        #[cfg(test)]
        if let Some(map) = lock(&self.test_gate).as_ref() {
            let g = map.get(&(cid, user)).ok_or(GameRefusal::NoPermission)?;
            return if !g.enabled {
                Err(GameRefusal::Disabled)
            } else if !need.iter().all(|p| g.perms.has(p)) {
                Err(GameRefusal::NoPermission)
            } else {
                Ok(g.server_id.clone())
            };
        }
        let ChannelPermAccess::Allowed { server_id, perms } = get_user_channel_permissions(&state.pool, cid, user).await
        else {
            return Err(GameRefusal::NoPermission);
        };
        if !games_enabled(state, &server_id).await {
            return Err(GameRefusal::Disabled);
        }
        if !need.iter().all(|p| perms.has(p)) {
            return Err(GameRefusal::NoPermission);
        }
        Ok(server_id)
    }

    #[cfg(test)]
    pub(crate) fn set_test_gate(&self, gate: Option<HashMap<(i64, UserId), TestGate>>) {
        *lock(&self.test_gate) = gate;
    }

    /// Tests: `hook` runs ONCE, inside the next gate (see `gate_hook`).
    #[cfg(test)]
    pub(crate) fn set_gate_hook(&self, hook: impl Fn(&AppState) + Send + Sync + 'static) {
        *lock(&self.gate_hook) = Some(Box::new(hook));
    }

    #[cfg(test)]
    pub(crate) fn set_timings(&self, t: Timings) {
        *lock(&self.timings) = t;
    }
}

/// The owner switched games on or off for `server_id`: tell every online
/// member at once (`ServerMessage::GamesEnabled`), so the launcher appears or
/// goes without a reload. Called after the change committed (and, for off,
/// after `close_server`). Reads the member list, then [`announce_enabled`].
pub async fn push_enabled(state: &AppState, server_id: &str, enabled: bool) -> usize {
    let members: Vec<UserId> = match sqlx::query_as::<_, (i32,)>("SELECT user_id FROM server_members WHERE server_id = $1")
        .bind(server_id)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => rows.into_iter().map(|(u,)| UserId::from(u)).collect(),
        Err(e) => {
            // The switch itself committed; members who miss the push see it
            // on their next server-list fetch (a reload, a reconnect).
            tracing::error!("games: member fetch for the games switch on server {} failed: {}", server_id, e);
            return 0;
        }
    };
    announce_enabled(state, server_id, enabled, &members)
}

/// [`push_enabled`] once the members are known: every connection of each
/// that announced `games` (never a delivery socket, never a connection that
/// did not announce the capability). Answers how many frames went out.
pub fn announce_enabled(state: &AppState, server_id: &str, enabled: bool, members: &[UserId]) -> usize {
    let mut sent = 0;
    for &user in members {
        for conn in state.games_conns_of(user) {
            let msg = ServerMessage::GamesEnabled { server_id: server_id.to_string(), games_enabled: enabled };
            if state.send_to_conn(user, conn, msg) {
                sent += 1;
            }
        }
    }
    sent
}

/// `servers.games_enabled`, false on any error.
async fn games_enabled(state: &AppState, server_id: &str) -> bool {
    #[cfg(test)]
    if let Some(map) = lock(&state.games.test_gate).as_ref() {
        return map.values().any(|g| g.server_id == server_id && g.enabled);
    }
    match sqlx::query_scalar::<_, bool>("SELECT games_enabled FROM servers WHERE id = $1")
        .bind(server_id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(v) => v.unwrap_or(false),
        Err(e) => {
            tracing::error!("games: games_enabled lookup failed for server {}: {}", server_id, e);
            false
        }
    }
}

/// The call's connections that may be sent game frames. Read under the room
/// guard, which is dropped before this returns - the caller locks a table
/// only afterwards.
fn recipients(state: &AppState, room: &str) -> Vec<(UserId, u64)> {
    let pairs = state.rooms.get(room).map(|r| r.member_conn_pairs()).unwrap_or_default();
    pairs.into_iter().filter(|&(u, c)| state.conn_plays_games(u, c)).collect()
}

/// Whether `user` has any connection in the call.
fn in_room(state: &AppState, room: &str, user: UserId) -> bool {
    state.rooms.get(room).is_some_and(|r| r.conns_of(user).is_some())
}

/// Step (3): THIS connection is in the call - `conns_of` under the room
/// guard, never the socket's own `joined_rooms`.
fn conn_in_call(state: &AppState, room: &str, user: UserId, conn: u64) -> bool {
    state.rooms.get(room).is_some_and(|r| r.conns_of(user).is_some_and(|c| c.contains(&conn)))
}

// ---------------------------------------------------------------------------
// The frames

/// The room, table and op a client game frame names; `None` for any other
/// frame.
fn frame_parts(msg: &ClientMessage) -> Option<(&str, Option<u64>, GameOp)> {
    use ClientMessage as C;
    Some(match msg {
        C::GameCreate { room_id, .. } => (room_id.as_str(), None, GameOp::Create),
        C::GameSit { room_id, table_id, .. } => (room_id.as_str(), Some(*table_id), GameOp::Sit),
        C::GameStand { room_id, table_id } => (room_id.as_str(), Some(*table_id), GameOp::Stand),
        C::GameAct { room_id, table_id, .. } => (room_id.as_str(), Some(*table_id), GameOp::Act),
        C::GameBet { room_id, table_id, .. } => (room_id.as_str(), Some(*table_id), GameOp::Bet),
        C::GameClearBet { room_id, table_id } => (room_id.as_str(), Some(*table_id), GameOp::ClearBet),
        C::GameSitOut { room_id, table_id } => (room_id.as_str(), Some(*table_id), GameOp::SitOut),
        C::GameSitIn { room_id, table_id } => (room_id.as_str(), Some(*table_id), GameOp::SitIn),
        C::GameRebuy { room_id, table_id } => (room_id.as_str(), Some(*table_id), GameOp::Rebuy),
        C::GameShowCards { room_id, table_id } => (room_id.as_str(), Some(*table_id), GameOp::ShowCards),
        C::GameResync { room_id, table_id } => (room_id.as_str(), Some(*table_id), GameOp::Resync),
        C::GameClose { room_id, table_id } => (room_id.as_str(), Some(*table_id), GameOp::Close),
        C::GameRemovePlayer { room_id, table_id, .. } => (room_id.as_str(), Some(*table_id), GameOp::RemovePlayer),
        _ => return None,
    })
}

/// One client game frame, in the order of checks docs/GAMES.md fixes, so a
/// refusal never says more than the caller may know: (2) a voice room, (3)
/// THIS connection in that call, (4) games on, (5) permissions, (6) rate
/// limits, (7) the table, (8) the op against the game and the seat, (9) the
/// engine. Every expected refusal is a `GameRefused` to this connection
/// alone; a frame naming a table that is not open is `GameEnded { gone }`.
///
/// A connection that did not announce `games` is sent nothing at all - not
/// even a refusal (an older client must never get a frame it does not know).
pub async fn handle_frame(state: &Arc<AppState>, user: UserId, conn: u64, msg: ClientMessage) {
    let games = &state.games;
    let Some((room, table_id, op)) = frame_parts(&msg) else { return };
    if !state.conn_plays_games(user, conn) {
        return;
    }
    let room = room.to_string();
    let refuse = |r: GameRefusal| {
        state.send_to_conn(
            user,
            conn,
            ServerMessage::GameRefused { room_id: room.clone(), table_id, op, refusal: r },
        );
    };
    let gone = |id: u64| {
        state.send_to_conn(
            user,
            conn,
            ServerMessage::GameEnded { room_id: room.clone(), table_id: id, reason: GameEndReason::Gone },
        );
    };

    // (2)
    let Some(cid) = crate::ws::parse_voice_room(&room) else {
        return refuse(GameRefusal::NotAVoiceRoom);
    };
    // (3)
    if !conn_in_call(state, &room, user, conn) {
        return refuse(GameRefusal::NotInCall);
    }
    // (4) + (5). Sitting is checked AGAIN under the server's permission lock
    // (below), the one the sweep holds while it resolves and acts: a sit
    // cannot slip in between a sweep's answer and its stand-up.
    let need = match op {
        GameOp::Create | GameOp::Sit => Some(Permissions::CONNECT | Permissions::PLAY_GAMES),
        GameOp::Close | GameOp::RemovePlayer => Some(Permissions::MOVE_MEMBERS),
        _ => None,
    };
    let server_id = match need {
        Some(need) => match games.gate(state, cid, user, need).await {
            Ok(s) => Some(s),
            Err(r) => return refuse(r),
        },
        None => None,
    };

    match msg {
        ClientMessage::GameCreate { kind, config, .. } => {
            let server_id = server_id.unwrap_or_default();
            // (3) again: the gate awaited the database, and this connection
            // may have left (or been moved or kicked) meanwhile. A table
            // opened now would sit in a call with nobody in it.
            if !conn_in_call(state, &room, user, conn) {
                return refuse(GameRefusal::NotInCall);
            }
            // (6)
            if !games.take_create(user) {
                return refuse(GameRefusal::RateLimited);
            }
            let config = config.unwrap_or_default();
            let engine = match kind {
                GameKindWire::Holdem => config.holdem().map(|c| HoldemTable::new(c).map(Engine::Holdem).map_err(Into::into)),
                GameKindWire::Blackjack => {
                    config.blackjack().map(|c| BlackjackTable::new(c).map(Engine::Blackjack).map_err(Into::into))
                }
            };
            let engine = match engine.and_then(|e| e) {
                Ok(e) => e,
                Err(r) => {
                    games.refund_create(user);
                    return refuse(r);
                }
            };
            let recips = recipients(state, &room);
            let kind = engine.kind();
            let cell = Arc::new(TableCell {
                room: room.clone(),
                opener: user,
                id: OnceLock::new(),
                inner: Mutex::new(TableState {
                    engine,
                    version: 1,
                    closed: false,
                    away: BTreeMap::new(),
                    clock: None,
                    next_deal: None,
                    idle: None,
                    gen: 0,
                    empty_since: None,
                }),
            });
            // (7): one table per call, and the server-wide cap.
            {
                let mut reg = lock(&games.registry);
                match reg.tables.open(room.clone(), kind, Arc::clone(&cell)) {
                    Ok(open) => {
                        let _ = cell.id.set(open.id.0);
                        reg.server_of.insert(room.clone(), server_id.clone());
                    }
                    Err(e) => {
                        drop(reg);
                        games.refund_create(user);
                        return refuse(e.into());
                    }
                }
            }
            {
                let ctx = Ctx { games, state, cell: &cell, recips: &recips };
                let mut ts = lock(&cell.inner);
                ctx.schedule(&mut ts);
                ctx.send(&ts, None);
            }
            tracing::info!("Games: user {} opened {:?} table {} in {}", user, kind, cell.id(), room);
            // The call emptied between the re-check and the registry insert:
            // its room is already gone, so nothing else will start the
            // call-ended timer for this table.
            if state.rooms.get(&room).is_none() {
                games.on_room_emptied(&room);
            }
            // Re-read the switch AFTER the table is in the registry: a switch-
            // off that committed after our check closed every table it could
            // see, which did not include this one yet.
            if !games_enabled(state, &server_id).await {
                games.close_cell(state, &cell, GameEndReason::Disabled);
            }
        }

        ClientMessage::GameSit { table_id, seat, .. } => {
            let server_id = server_id.unwrap_or_default();
            let _serial = state.lock_server_perms(&server_id).await;
            if let Err(r) = games.gate(state, cid, user, Permissions::CONNECT | Permissions::PLAY_GAMES).await {
                return refuse(r);
            }
            if !conn_in_call(state, &room, user, conn) {
                return refuse(GameRefusal::NotInCall);
            }
            let Some(cell) = games.lookup_id(&room, table_id) else { return gone(table_id) };
            let recips = recipients(state, &room);
            let ctx = Ctx { games, state, cell: &cell, recips: &recips };
            let mut ts = lock(&cell.inner);
            if ts.closed {
                drop(ts);
                return gone(table_id);
            }
            let result = match &mut ts.engine {
                Engine::Holdem(t) => t.sit(seat, player_id(user)).map(|e| holdem_events(&e)).map_err(GameRefusal::from),
                Engine::Blackjack(t) => t.sit(seat, player_id(user)).map(|e| blackjack_events(&e)).map_err(GameRefusal::from),
            };
            match result {
                Ok(events) => ctx.apply(&mut ts, events),
                Err(r) => {
                    drop(ts);
                    refuse(r);
                }
            }
        }

        ClientMessage::GameResync { table_id, .. } => {
            // (6)
            if !games.take_resync(conn) {
                return refuse(GameRefusal::RateLimited);
            }
            let Some(cell) = games.lookup_id(&room, table_id) else { return gone(table_id) };
            let one = [(user, conn)];
            let ctx = Ctx { games, state, cell: &cell, recips: &one };
            let ts = lock(&cell.inner);
            if ts.closed {
                drop(ts);
                return gone(table_id);
            }
            ctx.send(&ts, None);
        }

        ClientMessage::GameClose { table_id, .. } => {
            let Some(cell) = games.lookup_id(&room, table_id) else { return gone(table_id) };
            if !games.close_cell(state, &cell, GameEndReason::Closed) {
                gone(table_id);
            } else {
                tracing::info!("Games: user {} closed table {} in {}", user, table_id, room);
            }
        }

        ClientMessage::GameRemovePlayer { table_id, seat, .. } => {
            let Some(cell) = games.lookup_id(&room, table_id) else { return gone(table_id) };
            let recips = recipients(state, &room);
            let ctx = Ctx { games, state, cell: &cell, recips: &recips };
            let mut ts = lock(&cell.inner);
            if ts.closed {
                drop(ts);
                return gone(table_id);
            }
            ts.away.remove(&seat);
            match ts.engine.leave(seat) {
                Ok(events) => ctx.apply(&mut ts, events),
                Err(r) => {
                    drop(ts);
                    refuse(r);
                }
            }
        }

        // Everything else acts on the caller's own seat.
        msg => {
            let Some(table_id) = table_id else { return };
            let Some(cell) = games.lookup_id(&room, table_id) else { return gone(table_id) };
            let recips = recipients(state, &room);
            let ctx = Ctx { games, state, cell: &cell, recips: &recips };
            let mut ts = lock(&cell.inner);
            if ts.closed {
                drop(ts);
                return gone(table_id);
            }
            match own_seat_op(&mut ts, user, msg) {
                Ok(events) => ctx.apply(&mut ts, events),
                Err(r) => {
                    drop(ts);
                    refuse(r);
                }
            }
        }
    }
}

/// (8) and (9) for the frames that act on the caller's own seat: the op
/// against the game (`wrong_game`), then the seat (`not_seated`), then the
/// engine.
fn own_seat_op(ts: &mut TableState, user: UserId, msg: ClientMessage) -> Result<GameEventsWire, GameRefusal> {
    use ClientMessage as C;
    let holdem = matches!(ts.engine, Engine::Holdem(_));
    // (8) the op against the game.
    match &msg {
        C::GameAct { action, .. } if (if holdem { action.holdem().is_none() } else { action.blackjack().is_none() }) => {
            return Err(GameRefusal::WrongGame)
        }
        C::GameBet { .. } | C::GameClearBet { .. } if holdem => return Err(GameRefusal::WrongGame),
        C::GameShowCards { .. } if !holdem => return Err(GameRefusal::WrongGame),
        _ => {}
    }
    // (8) the seat.
    let seat = ts.engine.seat_of(user).ok_or(GameRefusal::NotSeated)?;
    // (9) the engine.
    let h = |r: Result<Vec<puca_games::holdem::Event>, puca_games::holdem::HoldemError>| {
        r.map(|e| holdem_events(&e)).map_err(GameRefusal::from)
    };
    let b = |r: Result<Vec<puca_games::blackjack::BjEvent>, puca_games::blackjack::BjError>| {
        r.map(|e| blackjack_events(&e)).map_err(GameRefusal::from)
    };
    if let C::GameStand { .. } = msg {
        ts.away.remove(&seat);
        return ts.engine.leave(seat);
    }
    match (&mut ts.engine, msg) {
        (Engine::Holdem(t), C::GameAct { turn, action, .. }) => {
            h(t.act(seat, turn.into(), action.holdem().ok_or(GameRefusal::WrongGame)?))
        }
        (Engine::Blackjack(t), C::GameAct { turn, action, .. }) => b(t.act(
            seat,
            turn.into(),
            action.blackjack().ok_or(GameRefusal::WrongGame)?,
            &mut rng::os_rng(),
        )),
        (Engine::Blackjack(t), C::GameBet { amount, .. }) => b(t.place_bet(seat, amount)),
        (Engine::Blackjack(t), C::GameClearBet { .. }) => b(t.clear_bet(seat)),
        (Engine::Holdem(t), C::GameSitOut { .. }) => h(t.sit_out(seat)),
        (Engine::Blackjack(t), C::GameSitOut { .. }) => b(t.sit_out(seat)),
        (Engine::Holdem(t), C::GameSitIn { .. }) => h(t.sit_in(seat)),
        (Engine::Blackjack(t), C::GameSitIn { .. }) => b(t.sit_in(seat)),
        (Engine::Holdem(t), C::GameRebuy { .. }) => h(t.rebuy(seat)),
        (Engine::Blackjack(t), C::GameRebuy { .. }) => b(t.rebuy(seat)),
        (Engine::Holdem(t), C::GameShowCards { .. }) => h(t.show_cards(seat)),
        _ => Err(GameRefusal::WrongGame),
    }
}

#[cfg(test)]
impl Games {
    /// Tests: a registry with a smaller cap.
    pub(crate) fn set_cap_for_test(&self, cap: usize) {
        let mut reg = lock(&self.registry);
        assert!(reg.tables.is_empty(), "set the cap before opening tables");
        reg.tables = RoomTables::new(cap, 1);
    }

    /// Tests: (version, away seats, seat of each occupant, closed) of the
    /// call's table.
    pub(crate) fn peek(&self, room: &str) -> Option<TablePeek> {
        let cell = self.lookup(room)?;
        let ts = lock(&cell.inner);
        Some(TablePeek {
            id: cell.id(),
            version: ts.version,
            away: ts.away.keys().copied().collect(),
            occupants: ts.engine.occupants(),
            turn: ts.engine.turn(),
            to_act: match &ts.engine {
                Engine::Holdem(t) => t.to_act(),
                Engine::Blackjack(t) => t.to_act().map(|(s, _)| s),
            },
            closed: ts.closed,
            in_hand: match &ts.engine {
                Engine::Holdem(t) => t.hand_in_progress(),
                Engine::Blackjack(t) => t.round_in_progress(),
            },
        })
    }
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TablePeek {
    pub id: u64,
    pub version: u64,
    pub away: Vec<usize>,
    pub occupants: Vec<(usize, UserId)>,
    pub turn: Option<TurnRef>,
    pub to_act: Option<usize>,
    pub closed: bool,
    pub in_hand: bool,
}

#[cfg(test)]
#[path = "games_tests.rs"]
mod tests;
