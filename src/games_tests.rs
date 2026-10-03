//! Tests for src/games.rs (docs/GAMES.md, *Server design*).
//!
//! The in-memory suites drive the real handler (`handle_frame`) and the real
//! room mutators against an `AppState` whose database is never reached: the
//! permission/switch gate is stood in for by `Games::set_test_gate`. Time is
//! tokio's paused clock, so a 30 s turn clock or a 3 s deal costs nothing.
//! The `db` module at the bottom runs the REAL gate, the REAL permission sweep
//! and the REAL settings handler against `TEST_DATABASE_URL`.

use super::*;
use crate::games_wire::{GameActionWire, GameConfigWire, TurnWire};
use crate::permissions::Permissions as P;
use rand::Rng;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tokio::sync::mpsc;

const ROOM: &str = "voice_42";
const CID: i64 = 42;
const SERVER: &str = "srv-games";

fn new_state() -> Arc<AppState> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://localhost/does_not_connect")
        .expect("lazy pool");
    AppState::new(pool, "test-secret".into(), None, Arc::new(crate::wake::NullWake))
}

/// One connection and everything it was sent.
struct Conn {
    user: UserId,
    conn: u64,
    rx: mpsc::Receiver<ServerMessage>,
    log: Vec<Value>,
}

impl Conn {
    /// Moves what arrived into the log; returns the new frames.
    fn drain(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(m) = self.rx.try_recv() {
            let v = serde_json::to_value(&m).expect("frames serialise");
            out.push(v.clone());
            self.log.push(v);
        }
        out
    }

    fn game_frames(&self) -> Vec<&Value> {
        self.log.iter().filter(|f| f["type"].as_str().is_some_and(|t| t.starts_with("Game"))).collect()
    }

    /// The view of the newest frame that carried one.
    fn view(&self) -> Option<&Value> {
        self.log.iter().rev().find_map(|f| match f["type"].as_str() {
            Some("GameTable") | Some("GameEvents") => Some(&f["payload"]["view"]),
            _ => None,
        })
    }

    /// The owner's games switch, as pushed (`GamesEnabled`).
    fn game_switch_frames(&self) -> Vec<Value> {
        self.log.iter().filter(|f| f["type"] == "GamesEnabled").cloned().collect()
    }

    fn refusals(&self) -> Vec<&Value> {
        self.log.iter().filter(|f| f["type"] == "GameRefused").map(|f| &f["payload"]).collect()
    }
}

struct Rig {
    state: Arc<AppState>,
    gate: HashMap<(i64, UserId), TestGate>,
    next_sid: std::cell::Cell<u32>,
}

impl Rig {
    /// Every listed user is a member who may play (DEFAULT_MEMBER has CONNECT
    /// and PLAY_GAMES); `moderators` also hold MOVE_MEMBERS. Games are on.
    fn new(players: &[UserId], moderators: &[UserId]) -> Rig {
        let state = new_state();
        let mut gate = HashMap::new();
        for &u in players {
            let mut perms = P::DEFAULT_MEMBER;
            if moderators.contains(&u) {
                perms |= P::MOVE_MEMBERS;
            }
            gate.insert((CID, u), TestGate { server_id: SERVER.into(), enabled: true, perms });
        }
        state.games.set_test_gate(Some(gate.clone()));
        state.games.set_timings(Timings { grace: Some(Duration::from_secs(8)), ..Timings::PRODUCTION });
        Rig { state, gate, next_sid: std::cell::Cell::new(0) }
    }

    fn set_perms(&mut self, user: UserId, perms: P, enabled: bool) {
        self.gate.insert((CID, user), TestGate { server_id: SERVER.into(), enabled, perms });
        self.state.games.set_test_gate(Some(self.gate.clone()));
    }

    fn connect_as(&self, user: UserId, games: bool, delivery: bool) -> Conn {
        let (tx, rx) = mpsc::channel::<ServerMessage>(4096);
        self.next_sid.set(self.next_sid.get() + 1);
        let (conn, _, _) =
            self.state.register_session(user, format!("u{user}"), tx, delivery, None, format!("sid-{user}-{}", self.next_sid.get()));
        self.state.set_conn_games(user, conn, games);
        Conn { user, conn, rx, log: Vec::new() }
    }

    fn connect(&self, user: UserId) -> Conn {
        self.connect_as(user, true, false)
    }

    /// What JoinRoom does for a voice room, as far as games are concerned:
    /// its own permission answer says whether this user may still play here.
    fn join(&self, c: &Conn) {
        self.state.join_room(ROOM, c.user, c.conn);
        let may_play = self.gate.get(&(CID, c.user)).is_some_and(|g| g.perms.contains(P::CONNECT | P::PLAY_GAMES));
        self.state.games.on_join(&self.state, ROOM, c.user, c.conn, may_play);
    }

    async fn send(&self, c: &Conn, msg: ClientMessage) {
        handle_frame(&self.state, c.user, c.conn, msg).await;
    }

    async fn create(&self, c: &Conn, kind: GameKindWire) {
        self.send(c, ClientMessage::GameCreate { room_id: ROOM.into(), kind, config: None }).await;
    }

    async fn sit(&self, c: &Conn, seat: usize) {
        let t = self.table();
        self.send(c, ClientMessage::GameSit { room_id: ROOM.into(), table_id: t, seat }).await;
    }

    fn table(&self) -> u64 {
        self.peek().map(|p| p.id).unwrap_or(0)
    }

    fn peek(&self) -> Option<TablePeek> {
        self.state.games.peek(ROOM)
    }
}

fn act(table_id: u64, turn: &Value, action: GameActionWire) -> ClientMessage {
    ClientMessage::GameAct {
        room_id: ROOM.into(),
        table_id,
        turn: TurnWire { hand_no: turn["hand_no"].as_u64().unwrap(), turn_seq: turn["turn_seq"].as_u64().unwrap() },
        action,
    }
}

fn is_card(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 2 && b"23456789TJQKA".contains(&b[0]) && b"cdhs".contains(&b[1])
}

/// Every card code anywhere in a frame.
fn cards_in(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) if is_card(s) => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|x| cards_in(x, out)),
        Value::Object(o) => o.values().for_each(|x| cards_in(x, out)),
        _ => {}
    }
}

fn seat_cards(view: &Value, seat: usize) -> Option<Vec<String>> {
    view["seats"][seat]["cards"].as_array().map(|a| a.iter().map(|c| c.as_str().unwrap().to_string()).collect())
}

// ---------------------------------------------------------------------------
// Privacy

/// THE property: in a long random Hold'em run, no connection is ever sent a
/// card it may not see. Three players (one on two devices), a spectator, a
/// connection that did not announce `games`, a delivery socket and a games
/// connection that is not in the call. Every frame sent to every connection
/// is scanned: a hole card of a player is allowed in a frame only to that
/// player's own connections, or after a showdown / show event revealed it.
/// Each player's hole cards are learned from their OWN frames, so the oracle
/// is independent of what anyone else was sent.
#[tokio::test(start_paused = true)]
async fn no_connection_ever_receives_a_card_it_may_not_see() {
    let rig = Rig::new(&[1, 2, 3, 4, 5, 6, 7], &[]);
    let mut p1 = rig.connect(1);
    let mut p1b = rig.connect(1); // the same player's second device, also in the call
    let mut p2 = rig.connect(2);
    let mut p3 = rig.connect(3);
    let mut spec = rig.connect(4);
    let mut capless = rig.connect_as(5, false, false);
    let mut pocket = rig.connect_as(6, true, true);
    let mut outside = rig.connect(7);
    for c in [&p1, &p1b, &p2, &p3, &spec, &capless, &pocket] {
        rig.join(c);
    }
    rig.create(&p1, GameKindWire::Holdem).await;
    let tid = rig.table();
    assert_ne!(tid, 0, "the table opened");
    rig.sit(&p1, 0).await;
    rig.sit(&p2, 2).await;
    rig.sit(&p3, 4).await;

    let mut r = rng::seeded(0x9a3e5);
    let users: HashMap<usize, UserId> = [(0, 1), (2, 2), (4, 3)].into_iter().collect();
    let mut hands_seen = HashSet::new();
    let mut timeouts = 0;
    let mut steps = 0;
    while hands_seen.len() < 60 {
        steps += 1;
        assert!(steps < 20_000, "the run is not progressing");
        for c in [&mut p1, &mut p1b, &mut p2, &mut p3, &mut spec, &mut capless, &mut pocket, &mut outside] {
            c.drain();
        }
        let peek = rig.peek().expect("table open");
        if let Some(h) = peek.turn.map(|t| t.hand_no) {
            hands_seen.insert(h);
        }
        let Some(seat) = peek.to_act else {
            // Between hands: everyone back in, the broke rebuy, someone shows.
            for (seat, conn) in [(0, &p1), (2, &p2), (4, &p3)] {
                let v = conn.view().unwrap().clone();
                let s = &v["seats"][seat];
                if s.is_null() {
                    continue;
                }
                if s["stack"] == 0 {
                    rig.send(conn, ClientMessage::GameRebuy { room_id: ROOM.into(), table_id: tid }).await;
                } else if s["sitting_out"] == true {
                    rig.send(conn, ClientMessage::GameSitIn { room_id: ROOM.into(), table_id: tid }).await;
                }
                if r.gen_bool(0.15) {
                    rig.send(conn, ClientMessage::GameShowCards { room_id: ROOM.into(), table_id: tid }).await;
                }
            }
            tokio::time::sleep(NEXT_HAND_DELAY + Duration::from_millis(50)).await;
            continue;
        };
        let actor = match users[&seat] {
            1 if r.gen_bool(0.5) => &p1b,
            1 => &p1,
            2 => &p2,
            _ => &p3,
        };
        if r.gen_bool(0.03) {
            // Let the clock decide this one.
            timeouts += 1;
            tokio::time::sleep(Duration::from_secs(31)).await;
            continue;
        }
        let view = actor.view().unwrap().clone();
        let legal = &view["legal"];
        assert!(legal.is_object(), "the seat to act sees its legal actions: {view}");
        let a = if legal["can_raise"] == true && r.gen_bool(0.3) {
            let (lo, hi) = (legal["min_raise_to"].as_u64().unwrap(), legal["max_raise_to"].as_u64().unwrap());
            if r.gen_bool(0.2) {
                GameActionWire::AllIn
            } else {
                GameActionWire::BetOrRaiseTo { amount: r.gen_range(lo..=hi) }
            }
        } else if legal["can_check"] == true {
            GameActionWire::Check
        } else if r.gen_bool(0.2) {
            GameActionWire::Fold
        } else {
            GameActionWire::Call
        };
        rig.send(actor, act(tid, &view["turn"], a)).await;
    }
    for c in [&mut p1, &mut p1b, &mut p2, &mut p3, &mut spec, &mut capless, &mut pocket, &mut outside] {
        c.drain();
    }

    // Nothing at all for the connections that may not have it.
    assert!(capless.game_frames().is_empty(), "no `games` cap: never a game frame");
    assert!(pocket.game_frames().is_empty(), "a delivery socket: never a game frame");
    assert!(outside.game_frames().is_empty(), "not in the call: never a game frame");

    // The oracle: each player's hole cards per hand, from their own frames.
    let mut own: HashMap<(UserId, u64), Vec<String>> = HashMap::new();
    for (conn, seat) in [(&p1, 0), (&p1b, 0), (&p2, 2), (&p3, 4)] {
        for f in conn.game_frames() {
            let v = &f["payload"]["view"];
            if v.is_null() || v["viewer_seat"] != seat {
                continue;
            }
            if let Some(cards) = seat_cards(v, seat).filter(|c| c.iter().all(|x| is_card(x))) {
                let h = v["hand_no"].as_u64().unwrap();
                let prev = own.insert((conn.user, h), cards.clone());
                assert!(prev.is_none_or(|p| p == cards), "a player's own cards changed within hand {h}");
            }
        }
    }
    let dealt_hands = own.keys().map(|(_, h)| *h).collect::<HashSet<_>>().len();
    assert!(dealt_hands >= 55, "the oracle saw too few hands ({dealt_hands}): the run proves little");

    // The scan: every frame to every connection that plays.
    let mut showdowns = 0;
    let mut face_down_seen = 0;
    let mut cards_checked = 0;
    let mut by_version: HashMap<u64, Value> = HashMap::new();
    for conn in [&p1, &p1b, &p2, &p3, &spec] {
        let mut revealed: HashMap<u64, HashSet<String>> = HashMap::new();
        let mut last_version = 0;
        for f in conn.game_frames() {
            let p = &f["payload"];
            let v = &p["view"];
            if v.is_null() {
                continue;
            }
            let version = p["version"].as_u64().unwrap();
            assert!(version > last_version, "versions only go up on one connection");
            last_version = version;
            let h = v["hand_no"].as_u64().unwrap();
            if let Some(events) = p["events"].as_array() {
                // The events are identical for everyone who got that version.
                if let Some(seen) = by_version.insert(version, p["events"].clone()) {
                    assert_eq!(seen, p["events"], "events of v{version} differ between connections");
                }
                for e in events {
                    match e["type"].as_str() {
                        Some("showdown") => {
                            showdowns += 1;
                            for s in e["shown"].as_array().unwrap() {
                                let mut c = Vec::new();
                                cards_in(&s["cards"], &mut c);
                                revealed.entry(h).or_default().extend(c);
                            }
                        }
                        Some("shown") => {
                            let mut c = Vec::new();
                            cards_in(&e["cards"], &mut c);
                            revealed.entry(h).or_default().extend(c);
                        }
                        _ => {}
                    }
                }
            }
            let mut seen = Vec::new();
            cards_in(f, &mut seen);
            for c in &seen {
                cards_checked += 1;
                for ((owner, hand), hole) in &own {
                    if *hand != h || *owner == conn.user || !hole.contains(c) {
                        continue;
                    }
                    assert!(
                        revealed.get(&h).is_some_and(|r| r.contains(c)),
                        "LEAK: user {}'s hole card {c} (hand {h}) reached user {}'s connection before any reveal: {f}",
                        owner,
                        conn.user
                    );
                }
            }
            // Structurally: anyone's seat other than the viewer's own shows
            // face down, nothing, or a revealed hand.
            for (i, s) in v["seats"].as_array().unwrap().iter().enumerate() {
                if s.is_null() || v["viewer_seat"] == i {
                    continue;
                }
                if let Some(cards) = seat_cards(v, i) {
                    if cards == ["??", "??"] {
                        face_down_seen += 1;
                    } else {
                        assert!(
                            cards.iter().all(|c| revealed.get(&h).is_some_and(|r| r.contains(c))),
                            "seat {i}'s cards {cards:?} shown to user {} without a reveal (hand {h})",
                            conn.user
                        );
                    }
                }
            }
        }
    }
    // Positive controls: the run exercised what it claims to.
    assert!(showdowns > 0, "no showdown in the run");
    assert!(face_down_seen > 100, "face-down cards were rarely shown ({face_down_seen})");
    assert!(cards_checked > 1000, "too few cards checked ({cards_checked})");
    assert!(timeouts > 0, "no turn clock ran out in the run");
    // Both devices of player 1 got player 1's own cards.
    let devices: Vec<HashSet<u64>> = [&p1, &p1b]
        .iter()
        .map(|c| {
            c.game_frames()
                .iter()
                .filter_map(|f| {
                    let v = &f["payload"]["view"];
                    seat_cards(v, 0).filter(|cs| cs.iter().all(|x| is_card(x)))?;
                    v["hand_no"].as_u64()
                })
                .collect()
        })
        .collect();
    assert!(devices[0].len() >= 55 && devices[0] == devices[1], "both devices see the player's own hand every hand");
}

/// Blackjack's one hidden card is the dealer's hole card: face down in every
/// view and in its own `card_dealt` until the dealer turns it.
#[tokio::test(start_paused = true)]
async fn the_dealers_hole_card_stays_face_down_until_the_reveal() {
    let rig = Rig::new(&[1, 2, 3], &[]);
    let (mut a, mut b, mut spec) = (rig.connect(1), rig.connect(2), rig.connect(3));
    for c in [&a, &b, &spec] {
        rig.join(c);
    }
    rig.create(&a, GameKindWire::Blackjack).await;
    let tid = rig.table();
    rig.sit(&a, 0).await;
    rig.sit(&b, 1).await;
    let mut r = rng::seeded(77);
    let mut rounds = HashSet::new();
    let mut steps = 0;
    while rounds.len() < 40 {
        steps += 1;
        assert!(steps < 5_000, "the run is not progressing");
        for c in [&mut a, &mut b, &mut spec] {
            c.drain();
        }
        let peek = rig.peek().unwrap();
        let Some(seat) = peek.to_act else {
            // Between rounds: both bet (the deal follows LAST_BET_DELAY
            // later), or only one does and the bet window deals.
            rig.send(&a, ClientMessage::GameBet { room_id: ROOM.into(), table_id: tid, amount: 10 }).await;
            if r.gen_bool(0.7) {
                rig.send(&b, ClientMessage::GameBet { room_id: ROOM.into(), table_id: tid, amount: 20 }).await;
                tokio::time::sleep(LAST_BET_DELAY + Duration::from_millis(50)).await;
            } else {
                tokio::time::sleep(BET_WINDOW + Duration::from_millis(50)).await;
            }
            for c in [&mut a, &mut b] {
                let v = c.drain();
                let _ = v;
            }
            if let Some(t) = rig.peek().unwrap().turn {
                rounds.insert(t.hand_no);
            }
            for (c, s) in [(&a, 0), (&b, 1)] {
                if c.view().unwrap()["seats"][s]["stack"].as_u64().unwrap() < 10 {
                    rig.send(c, ClientMessage::GameRebuy { room_id: ROOM.into(), table_id: tid }).await;
                }
            }
            continue;
        };
        let actor = if seat == 0 { &a } else { &b };
        let v = actor.view().unwrap().clone();
        let legal = &v["legal"];
        let choice = if legal["can_split"] == true && r.gen_bool(0.5) {
            GameActionWire::Split
        } else if legal["can_double"] == true && r.gen_bool(0.2) {
            GameActionWire::Double
        } else if legal["can_hit"] == true && r.gen_bool(0.5) {
            GameActionWire::Hit
        } else {
            GameActionWire::Stand
        };
        rig.send(actor, act(tid, &v["turn"], choice)).await;
    }
    spec.drain();
    let mut reveals = 0;
    let mut hidden_views = 0;
    let mut holes_dealt = 0;
    for f in spec.game_frames() {
        let p = &f["payload"];
        let v = &p["view"];
        if v.is_null() {
            continue;
        }
        let dealer: Vec<&str> = v["dealer"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
        if v["dealer_total"].is_null() && dealer.len() >= 2 {
            hidden_views += 1;
            assert_eq!(dealer[1], "??", "the hole card is face down until the reveal: {v}");
        }
        assert!(dealer.iter().enumerate().all(|(i, c)| i == 1 || is_card(c)), "only the hole card is ever ??");
        // In the deal (the frame that starts a round) the dealer's second
        // card is the hole card. (Later frames deal the dealer more cards,
        // face up, after the reveal.)
        let events: Vec<&Value> = p["events"].as_array().into_iter().flatten().collect();
        let deal = events.iter().any(|e| e["type"] == "round_started");
        let mut to_dealer = 0;
        for e in &events {
            if deal && e["type"] == "card_dealt" && e["seat"].is_null() {
                to_dealer += 1;
                if to_dealer == 2 {
                    holes_dealt += 1;
                    assert_eq!(e["card"], "??", "the hole card is dealt face down");
                }
            }
            if e["type"] == "dealer_revealed" {
                reveals += 1;
            }
        }
    }
    assert!(
        hidden_views > 20 && reveals > 0 && holes_dealt >= 40,
        "the run never exercised the hole card ({hidden_views}, {reveals}, {holes_dealt})"
    );
    // Legal actions only in the view of the seat to act, never the spectator's.
    assert!(spec.game_frames().iter().all(|f| f["payload"]["view"]["legal"].is_null()));
}

// ---------------------------------------------------------------------------
// Membership, capability, refusals

/// A connection evicted from the call (kick, move, the sweep...) keeps its
/// socket and its own `joined_rooms`; the games layer asks the ROOM. Its
/// resync gets no table and no hole cards, it cannot take a seat, and from
/// the eviction on it is sent nothing about the table.
#[tokio::test(start_paused = true)]
async fn a_stale_connection_after_eviction_gets_no_hole_cards_and_no_seat() {
    let rig = Rig::new(&[1, 2], &[]);
    let (mut a, mut b) = (rig.connect(1), rig.connect(2));
    rig.join(&a);
    rig.join(&b);
    rig.create(&a, GameKindWire::Holdem).await;
    let tid = rig.table();
    rig.sit(&a, 0).await;
    rig.sit(&b, 1).await;
    tokio::time::sleep(NEXT_HAND_DELAY + Duration::from_millis(50)).await;
    a.drain();
    b.drain();
    let mine = seat_cards(a.view().unwrap(), 0).unwrap();
    assert!(mine.iter().all(|c| is_card(c)), "positive control: A holds real cards before the eviction");

    crate::ws::evict_user_from_voice_room(&rig.state, ROOM, 1, false, crate::ws::SelfNotice::Gone).await;
    a.drain();
    let before = a.log.len();
    for msg in [
        ClientMessage::GameResync { room_id: ROOM.into(), table_id: tid },
        ClientMessage::GameSit { room_id: ROOM.into(), table_id: tid, seat: 3 },
        ClientMessage::GameStand { room_id: ROOM.into(), table_id: tid },
    ] {
        rig.send(&a, msg).await;
    }
    // B keeps playing; A's stale connection must hear none of it.
    let v = b.view().unwrap().clone();
    if v["to_act"] == 1 {
        rig.send(&b, act(tid, &v["turn"], GameActionWire::Call)).await;
    }
    a.drain();
    let after: Vec<&Value> = a.log[before..].iter().collect();
    assert_eq!(after.len(), 3, "three refusals and nothing else: {after:?}");
    for f in &after {
        assert_eq!(f["type"], "GameRefused");
        assert_eq!(f["payload"]["code"], "not_in_call", "{f}");
        let mut c = Vec::new();
        cards_in(f, &mut c);
        assert!(c.is_empty(), "a refusal carries no card");
    }
    let peek = rig.peek().unwrap();
    assert!(peek.occupants.iter().all(|&(s, u)| u != 1 || s == 0), "no second seat for the stale connection");
    assert_eq!(peek.away, vec![0], "A's seat is in its disconnect grace");
}

/// Connections that did not announce `games`, and delivery sockets, are sent
/// nothing - not a table, not even a refusal of their own frame.
#[tokio::test(start_paused = true)]
async fn delivery_sockets_and_connections_without_the_cap_get_nothing() {
    let rig = Rig::new(&[1, 2, 3], &[]);
    let mut player = rig.connect(1);
    let mut old = rig.connect_as(2, false, false);
    let mut pocket = rig.connect_as(3, true, true);
    for c in [&player, &old, &pocket] {
        rig.join(c);
    }
    // Their own frames: ignored outright, nothing opens.
    rig.create(&old, GameKindWire::Holdem).await;
    rig.create(&pocket, GameKindWire::Holdem).await;
    assert!(rig.peek().is_none(), "a connection without the cap cannot open a table");
    // Positive control: the player can, and is told.
    rig.create(&player, GameKindWire::Holdem).await;
    rig.sit(&player, 0).await;
    for c in [&mut player, &mut old, &mut pocket] {
        c.drain();
    }
    assert!(player.game_frames().len() >= 2, "the player got the table and the sit");
    assert!(old.game_frames().is_empty() && pocket.game_frames().is_empty());
    assert!(!rig.state.conn_plays_games(3, pocket.conn), "set_conn_games refuses a delivery socket");
}

/// One table per call, of either game: the second open is a typed refusal
/// naming the open table, never an Error alert, and changes nothing.
#[tokio::test(start_paused = true)]
async fn a_second_table_in_a_call_is_a_typed_refusal_not_an_alert() {
    let rig = Rig::new(&[1, 2], &[]);
    let (mut a, mut b) = (rig.connect(1), rig.connect(2));
    rig.join(&a);
    rig.join(&b);
    rig.create(&a, GameKindWire::Holdem).await;
    let first = rig.table();
    rig.create(&b, GameKindWire::Blackjack).await;
    rig.create(&b, GameKindWire::Holdem).await;
    a.drain();
    b.drain();
    let refused = b.refusals();
    assert_eq!(refused.len(), 2);
    for r in refused {
        assert_eq!(r["code"], "room_has_table");
        assert_eq!(r["op"], "create");
        assert_eq!(r["open_table_id"], first);
        assert_eq!(r["kind"], "holdem");
        assert!(r["table_id"].is_null());
    }
    assert!(b.log.iter().all(|f| f["type"] != "Error"), "never the generic Error");
    assert_eq!(rig.table(), first, "the first table is untouched");
    assert_eq!(rig.state.games.open_tables(), 1);
    // Everyone in the call learned of the first table (version 1).
    for c in [&a, &b] {
        let t = c.game_frames().into_iter().find(|f| f["type"] == "GameTable").expect("GameTable on open");
        assert_eq!(t["payload"]["version"], 1);
        assert_eq!(t["payload"]["table_id"], first);
    }
}

/// The order of checks: a room that is not a call, then THIS connection in
/// the call - before anything about tables, so a non-member learns nothing.
#[tokio::test(start_paused = true)]
async fn the_order_of_checks_says_nothing_to_a_non_member() {
    let rig = Rig::new(&[1, 2], &[]);
    let (mut a, mut outsider) = (rig.connect(1), rig.connect(2));
    rig.join(&a);
    rig.create(&a, GameKindWire::Holdem).await;
    let tid = rig.table();
    for msg in [
        ClientMessage::GameResync { room_id: "channel_42".into(), table_id: tid },
        ClientMessage::GameResync { room_id: ROOM.into(), table_id: tid },
        ClientMessage::GameResync { room_id: ROOM.into(), table_id: tid + 1 },
        ClientMessage::GameCreate { room_id: ROOM.into(), kind: GameKindWire::Holdem, config: None },
        ClientMessage::GameClose { room_id: ROOM.into(), table_id: tid },
    ] {
        rig.send(&outsider, msg).await;
    }
    outsider.drain();
    let codes: Vec<&str> = outsider.refusals().iter().map(|r| r["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["not_a_voice_room", "not_in_call", "not_in_call", "not_in_call", "not_in_call"]);
    assert_eq!(outsider.refusals()[0]["room_id"], "channel_42", "room_id echoes the refused frame");
    assert!(rig.peek().is_some_and(|p| !p.closed), "a non-member closed nothing");
    // The member asking about a table that is not open hears `gone`.
    rig.send(&a, ClientMessage::GameResync { room_id: ROOM.into(), table_id: tid + 1 }).await;
    a.drain();
    let ended = a.log.iter().rev().find(|f| f["type"] == "GameEnded").unwrap();
    assert_eq!(ended["payload"]["reason"], "gone");
    assert_eq!(ended["payload"]["table_id"], tid + 1);
}

/// PLAY_GAMES (with CONNECT) opens and sits; MOVE_MEMBERS closes and removes;
/// games off is `disabled`, said before any permission.
#[tokio::test(start_paused = true)]
async fn the_gate_play_games_to_open_and_sit_move_members_to_close() {
    let mut rig = Rig::new(&[1, 2, 3], &[3]);
    let (mut a, mut b, mut m) = (rig.connect(1), rig.connect(2), rig.connect(3));
    for c in [&a, &b, &m] {
        rig.join(c);
    }
    rig.set_perms(2, P::DEFAULT_MEMBER - P::PLAY_GAMES, true);
    rig.create(&b, GameKindWire::Holdem).await;
    rig.create(&a, GameKindWire::Holdem).await;
    let tid = rig.table();
    rig.sit(&b, 0).await;
    rig.sit(&a, 0).await;
    rig.send(&a, ClientMessage::GameClose { room_id: ROOM.into(), table_id: tid }).await;
    rig.send(&a, ClientMessage::GameRemovePlayer { room_id: ROOM.into(), table_id: tid, seat: 0 }).await;
    b.drain();
    a.drain();
    let b_codes: Vec<&str> = b.refusals().iter().map(|r| r["code"].as_str().unwrap()).collect();
    assert_eq!(b_codes, ["no_permission", "no_permission"], "no PLAY_GAMES: neither open nor sit");
    let a_codes: Vec<&str> = a.refusals().iter().map(|r| r["code"].as_str().unwrap()).collect();
    assert_eq!(a_codes, ["no_permission", "no_permission"], "a player cannot close or remove");
    assert_eq!(rig.peek().unwrap().occupants, vec![(0, 1)]);
    // A CONNECT deny is as good as no PLAY_GAMES.
    rig.set_perms(2, P::DEFAULT_MEMBER - P::CONNECT, true);
    rig.sit(&b, 1).await;
    b.drain();
    assert_eq!(b.refusals().last().unwrap()["code"], "no_permission");
    // The moderator removes, then closes.
    rig.send(&m, ClientMessage::GameRemovePlayer { room_id: ROOM.into(), table_id: tid, seat: 0 }).await;
    assert!(rig.peek().unwrap().occupants.is_empty());
    rig.send(&m, ClientMessage::GameClose { room_id: ROOM.into(), table_id: tid }).await;
    assert!(rig.peek().is_none());
    a.drain();
    assert_eq!(a.log.last().unwrap()["payload"]["reason"], "closed");
    // Games off: `disabled`, even for someone who also lacks the bit.
    rig.set_perms(1, P::DEFAULT_MEMBER, false);
    rig.set_perms(2, P::DEFAULT_MEMBER - P::PLAY_GAMES, false);
    rig.create(&a, GameKindWire::Holdem).await;
    rig.create(&b, GameKindWire::Holdem).await;
    a.drain();
    b.drain();
    assert_eq!(a.refusals().last().unwrap()["code"], "disabled");
    assert_eq!(b.refusals().last().unwrap()["code"], "disabled");
    m.drain();
}

/// A sit is serialized against the permission sweep: while a sweep of the
/// server holds its lock, a GameSit waits, and then acts on the permissions
/// the sweep left - it cannot slip a seat in between a sweep's answer and its
/// stand-up (the sweep would never look again).
#[tokio::test(start_paused = true)]
async fn a_sit_waits_for_a_running_sweep_and_takes_the_answer_it_left() {
    let mut rig = Rig::new(&[1, 2], &[]);
    let (mut a, b) = (rig.connect(1), rig.connect(2));
    rig.join(&a);
    rig.join(&b);
    rig.create(&b, GameKindWire::Holdem).await;
    let tid = rig.table();
    let held = Arc::clone(&rig.state);
    let sweep = held.lock_server_perms(SERVER).await; // a sweep, running
    let state = Arc::clone(&rig.state);
    let (user, conn) = (a.user, a.conn);
    let sit = tokio::spawn(async move {
        handle_frame(&state, user, conn, ClientMessage::GameSit { room_id: ROOM.into(), table_id: tid, seat: 0 }).await;
    });
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(rig.peek().unwrap().occupants.is_empty(), "the sit waits for the sweep");
    // What the sweep is acting on: A lost PLAY_GAMES.
    rig.set_perms(1, P::DEFAULT_MEMBER - P::PLAY_GAMES, true);
    drop(sweep);
    sit.await.unwrap();
    a.drain();
    assert!(rig.peek().unwrap().occupants.is_empty(), "no seat on a permission the sweep took away");
    assert_eq!(a.refusals().last().unwrap()["code"], "no_permission");
}

/// Opening tables: 5 per 5 minutes per user (a refused open costs nothing);
/// the server-wide cap; resync once a second per connection.
#[tokio::test(start_paused = true)]
async fn rate_limits_and_the_cap() {
    let rig = Rig::new(&[1, 2], &[1]);
    let mut a = rig.connect(1);
    rig.join(&a);
    // A refused open (the room has a table) does not use one up.
    rig.create(&a, GameKindWire::Holdem).await;
    for _ in 0..10 {
        rig.create(&a, GameKindWire::Holdem).await;
    }
    for _ in 0..4 {
        let tid = rig.table();
        rig.send(&a, ClientMessage::GameClose { room_id: ROOM.into(), table_id: tid }).await;
        rig.create(&a, GameKindWire::Holdem).await;
        assert!(rig.peek().is_some(), "opens 2..=5 are allowed");
    }
    let tid = rig.table();
    rig.send(&a, ClientMessage::GameClose { room_id: ROOM.into(), table_id: tid }).await;
    rig.create(&a, GameKindWire::Holdem).await;
    a.drain();
    assert!(rig.peek().is_none(), "the sixth open in the window is refused");
    assert_eq!(a.refusals().last().unwrap()["code"], "rate_limited");
    tokio::time::sleep(CREATE_RATE_WINDOW + Duration::from_secs(1)).await;
    rig.create(&a, GameKindWire::Holdem).await;
    assert!(rig.peek().is_some(), "a new window, a new open");

    // Resync: once a second per connection.
    let tid = rig.table();
    a.drain();
    let n = a.log.len();
    rig.send(&a, ClientMessage::GameResync { room_id: ROOM.into(), table_id: tid }).await;
    rig.send(&a, ClientMessage::GameResync { room_id: ROOM.into(), table_id: tid }).await;
    tokio::time::sleep(RESYNC_MIN_INTERVAL).await;
    rig.send(&a, ClientMessage::GameResync { room_id: ROOM.into(), table_id: tid }).await;
    a.drain();
    let kinds: Vec<&str> = a.log[n..].iter().map(|f| f["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["GameTable", "GameRefused", "GameTable"]);
    assert_eq!(a.log[n + 1]["payload"]["code"], "rate_limited");

    // The cap, on a fresh state.
    let rig = Rig::new(&[1], &[]);
    rig.state.games.set_cap_for_test(2);
    let mut gate = HashMap::new();
    for cid in [1, 2, 3] {
        gate.insert((cid, 1), TestGate { server_id: SERVER.into(), enabled: true, perms: P::DEFAULT_MEMBER });
    }
    rig.state.games.set_test_gate(Some(gate));
    let mut c = rig.connect(1);
    for cid in [1, 2, 3] {
        rig.state.join_room(&format!("voice_{cid}"), 1, c.conn);
        handle_frame(&rig.state, 1, c.conn, ClientMessage::GameCreate {
            room_id: format!("voice_{cid}"),
            kind: GameKindWire::Blackjack,
            config: None,
        })
        .await;
    }
    c.drain();
    assert_eq!(rig.state.games.open_tables(), 2);
    assert_eq!(c.refusals().last().unwrap()["code"], "too_many_tables");
}

/// The opener's config: stakes taken, a field of the other game refused.
#[tokio::test(start_paused = true)]
async fn the_openers_config_is_validated() {
    let rig = Rig::new(&[1], &[]);
    let mut a = rig.connect(1);
    rig.join(&a);
    rig.send(&a, ClientMessage::GameCreate {
        room_id: ROOM.into(),
        kind: GameKindWire::Holdem,
        config: Some(GameConfigWire { min_bet: Some(10), ..Default::default() }),
    })
    .await;
    assert!(rig.peek().is_none());
    rig.send(&a, ClientMessage::GameCreate {
        room_id: ROOM.into(),
        kind: GameKindWire::Holdem,
        config: Some(GameConfigWire { starting_stack: Some(2_000), small_blind: Some(10), big_blind: Some(20), ..Default::default() }),
    })
    .await;
    a.drain();
    assert_eq!(a.refusals()[0]["code"], "invalid_config");
    let cfg = &a.view().unwrap()["config"];
    assert_eq!((cfg["starting_stack"].as_u64(), cfg["big_blind"].as_u64()), (Some(2_000), Some(20)));
}

/// Wrong game, not seated, and engine refusals - each typed, to the sender only.
#[tokio::test(start_paused = true)]
async fn wrong_game_and_not_seated_come_before_the_engine() {
    let rig = Rig::new(&[1, 2], &[]);
    let (mut a, mut b) = (rig.connect(1), rig.connect(2));
    rig.join(&a);
    rig.join(&b);
    rig.create(&a, GameKindWire::Blackjack).await;
    let tid = rig.table();
    let turn = serde_json::json!({"hand_no": 0, "turn_seq": 0});
    rig.send(&b, act(tid, &turn, GameActionWire::Fold)).await; // wrong game first
    rig.send(&b, act(tid, &turn, GameActionWire::Hit)).await; // then the seat
    rig.send(&b, ClientMessage::GameShowCards { room_id: ROOM.into(), table_id: tid }).await;
    rig.sit(&b, 0).await;
    rig.send(&b, ClientMessage::GameBet { room_id: ROOM.into(), table_id: tid, amount: 1 }).await;
    b.drain();
    a.drain();
    let codes: Vec<&str> = b.refusals().iter().map(|r| r["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["wrong_game", "not_seated", "wrong_game", "bet_below_minimum"]);
    assert_eq!(b.refusals()[3]["min"], 10);
    assert!(a.refusals().is_empty(), "a refusal goes to the sender only");
}

// ---------------------------------------------------------------------------
// Grace, timers, teardown

async fn heads_up(rig: &Rig, a: &mut Conn, b: &mut Conn) -> u64 {
    rig.join(a);
    rig.join(b);
    rig.create(a, GameKindWire::Holdem).await;
    let tid = rig.table();
    rig.sit(a, 0).await;
    rig.sit(b, 1).await;
    tokio::time::sleep(NEXT_HAND_DELAY + Duration::from_millis(50)).await;
    a.drain();
    b.drain();
    assert!(rig.peek().unwrap().in_hand, "the first hand was dealt 3 s after the second player sat");
    tid
}

/// A blip keeps the seat, the stack and the hole cards: back within the
/// grace, a new connection is sent the table with the same cards and the
/// seat is no longer away. Nobody folded.
#[tokio::test(start_paused = true)]
async fn the_grace_keeps_seat_and_cards_across_a_reconnect() {
    let rig = Rig::new(&[1, 2], &[]);
    let (mut a, mut b) = (rig.connect(1), rig.connect(2));
    heads_up(&rig, &mut a, &mut b).await;
    let cards = seat_cards(a.view().unwrap(), 0).unwrap();
    let hand = rig.peek().unwrap().turn.unwrap().hand_no;
    rig.state.unregister_session(1, a.conn);
    b.drain();
    assert_eq!(rig.peek().unwrap().away, vec![0], "the seat is away");
    assert_eq!(b.view().unwrap()["seats"][0]["away"], true, "and everyone is told");
    tokio::time::sleep(Duration::from_secs(5)).await;
    let mut a2 = rig.connect(1);
    rig.join(&a2);
    a2.drain();
    b.drain();
    let v = a2.view().expect("the new connection was sent the table");
    assert_eq!(seat_cards(v, 0).unwrap(), cards, "the same hole cards");
    assert_eq!(v["seats"][0]["status"], "in_hand");
    assert!(rig.peek().unwrap().away.is_empty());
    tokio::time::sleep(Duration::from_secs(10)).await; // past the old grace
    let p = rig.peek().unwrap();
    assert_eq!(p.turn.map(|t| t.hand_no), Some(hand), "the hand goes on");
    assert!(p.occupants.contains(&(0, 1)));
    b.drain();
    assert!(
        b.game_frames().iter().all(|f| f["payload"]["events"]
            .as_array()
            .is_none_or(|e| e.iter().all(|e| e["reason"] != "left"))),
        "nobody was folded for leaving"
    );
}

/// ...and gone past the grace, the player gets up: folded now (reason
/// `left`), the seat freed when the hand ends.
#[tokio::test(start_paused = true)]
async fn past_the_grace_the_player_is_folded_and_the_seat_freed() {
    let rig = Rig::new(&[1, 2, 3], &[]);
    let (mut a, mut b, c) = (rig.connect(1), rig.connect(2), rig.connect(3));
    rig.join(&c);
    heads_up(&rig, &mut a, &mut b).await;
    rig.sit(&c, 2).await; // waits for the next hand
    rig.state.unregister_session(1, a.conn);
    tokio::time::sleep(Duration::from_secs(7)).await;
    assert!(rig.peek().unwrap().occupants.contains(&(0, 1)), "still inside the grace");
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    b.drain();
    let left = b.game_frames().iter().any(|f| {
        f["payload"]["events"].as_array().is_some_and(|e| {
            e.iter().any(|e| (e["type"] == "acted" && e["reason"] == "left" && e["seat"] == 0) || e["type"] == "player_left")
        })
    });
    assert!(left, "folded for leaving once the grace ran out");
    assert!(!rig.peek().unwrap().occupants.contains(&(0, 1)), "the seat is free (heads-up: the hand ended)");
}

/// The turn clock: check when free, fold when facing a bet; a clock for a
/// decision that already passed does nothing.
#[tokio::test(start_paused = true)]
async fn the_turn_clock_checks_or_folds_and_a_stale_clock_is_a_no_op() {
    let rig = Rig::new(&[1, 2], &[]);
    let (mut a, mut b) = (rig.connect(1), rig.connect(2));
    let tid = heads_up(&rig, &mut a, &mut b).await;
    // Heads-up preflop: the button (small blind) acts first, facing the big blind.
    let p = rig.peek().unwrap();
    let (first, other) = if p.to_act == Some(0) { (&mut a, &mut b) } else { (&mut b, &mut a) };
    // Acting at 10 s makes the clock that was started for this decision stale.
    let dealt = first.view().unwrap()["clock_ms"].as_u64();
    assert!(dealt.is_some_and(|ms| (29_000..=30_000).contains(&ms)), "the deal frame: a full clock ({dealt:?})");
    tokio::time::sleep(Duration::from_secs(10)).await;
    // Relative milliseconds, as of the frame: a resync now says ~20 s left.
    rig.send(first, ClientMessage::GameResync { room_id: ROOM.into(), table_id: tid }).await;
    first.drain();
    let v = first.view().unwrap().clone();
    assert!(v["clock_ms"].as_u64().is_some_and(|ms| (19_000..=20_100).contains(&ms)), "relative clock: {}", v["clock_ms"]);
    rig.send(first, act(tid, &v["turn"], GameActionWire::Call)).await;
    let after_call = rig.peek().unwrap();
    // 25 s later the first clock (due at 30 s) has passed: it must change nothing.
    tokio::time::sleep(Duration::from_secs(25)).await;
    assert_eq!(rig.peek().unwrap().version, after_call.version, "the stale clock was a no-op");
    // The big blind's own clock (started at 10 s) runs out at 40 s: free to check.
    tokio::time::sleep(Duration::from_secs(6)).await;
    other.drain();
    let checked = other.game_frames().iter().any(|f| {
        f["payload"]["events"]
            .as_array()
            .is_some_and(|e| e.iter().any(|e| e["type"] == "acted" && e["kind"] == "check" && e["reason"] == "timeout"))
    });
    assert!(checked, "a free decision times out as a check");
    // On the flop someone faces a bet and lets the clock run: a fold.
    first.drain();
    let p = rig.peek().unwrap();
    let (bettor, facing) = if p.to_act == Some(seat_of_conn(first)) { (&mut *first, &mut *other) } else { (&mut *other, &mut *first) };
    let v = bettor.view().unwrap().clone();
    rig.send(bettor, act(tid, &v["turn"], GameActionWire::BetOrRaiseTo { amount: 40 })).await;
    tokio::time::sleep(Duration::from_secs(31)).await;
    facing.drain();
    let folded = facing.game_frames().iter().any(|f| {
        f["payload"]["events"]
            .as_array()
            .is_some_and(|e| e.iter().any(|e| e["type"] == "acted" && e["kind"] == "fold" && e["reason"] == "timeout"))
    });
    assert!(folded, "facing a bet, the clock folds");
}

fn seat_of_conn(c: &Conn) -> usize {
    c.view().unwrap()["viewer_seat"].as_u64().unwrap() as usize
}

/// EVERY room mutator hands its departures to the games layer (and leaves
/// none undrained): LeaveRoom (leave_room), a refused join's withdrawal (the
/// same leave_room), disconnect (unregister_session), the eviction helper
/// (kick, move, voice exclusivity, AFK) and the own-account Leave
/// (displace_own_conns). The sweep's eviction is walked in the `db` module.
#[tokio::test(start_paused = true)]
async fn every_room_mutator_drains_its_departures() {
    for path in ["leave_room", "unregister_session", "evict", "displace"] {
        let rig = Rig::new(&[1, 2, 3], &[]);
        // A grace nothing below can outlast: the mutators await database
        // lookups that fail on this state's unreachable pool, and the paused
        // clock jumps through their timeouts.
        rig.state.games.set_timings(Timings { grace: Some(Duration::from_secs(24 * 3600)), ..Timings::PRODUCTION });
        let (mut a, mut b, mut keep) = (rig.connect(1), rig.connect(2), rig.connect(3));
        rig.join(&keep);
        heads_up(&rig, &mut a, &mut b).await;
        lock(&rig.state.games.departures_seen).clear();
        match path {
            "leave_room" => {
                rig.state.leave_room(ROOM, 1, a.conn);
            }
            "unregister_session" => {
                rig.state.unregister_session(1, a.conn);
            }
            "evict" => {
                crate::ws::evict_user_from_voice_room(&rig.state, ROOM, 1, false, crate::ws::SelfNotice::Gone).await;
            }
            "displace" => {
                // The account's other device (not in the call) presses Leave.
                let phone = rig.connect(1);
                crate::ws::displace_own_conns(&rig.state, ROOM, 1, phone.conn, crate::ws::Displace::LeftElsewhere).await;
            }
            _ => unreachable!(),
        }
        let seen = lock(&rig.state.games.departures_seen).clone();
        assert_eq!(seen, vec![(ROOM.to_string(), 1)], "{path}: the departure reached the games layer");
        assert_eq!(rig.state.rooms.get(ROOM).unwrap().pending_game_departures(), 0, "{path}: nothing left undrained");
        assert_eq!(rig.peek().unwrap().away, vec![0], "{path}: the seat is in its grace");
        keep.drain();
    }
}

/// The last member leaving drops the room (drop_room_if_empty), and the
/// table ends one grace later (`call_ended`) - unless someone is back.
#[tokio::test(start_paused = true)]
async fn an_empty_call_ends_its_table_after_one_grace_unless_someone_returns() {
    for comes_back in [true, false] {
        let rig = Rig::new(&[1, 2], &[]);
        let (mut a, mut b) = (rig.connect(1), rig.connect(2));
        heads_up(&rig, &mut a, &mut b).await;
        rig.state.unregister_session(1, a.conn);
        rig.state.leave_room(ROOM, 2, b.conn);
        assert!(rig.state.rooms.get(ROOM).is_none(), "the room was dropped");
        tokio::time::sleep(Duration::from_secs(4)).await;
        if comes_back {
            let mut a2 = rig.connect(1);
            rig.join(&a2);
            a2.drain();
            assert_eq!(seat_cards(a2.view().unwrap(), 0).map(|c| c.len()), Some(2));
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(rig.peek().is_some(), comes_back, "comes_back={comes_back}");
        assert_eq!(rig.state.games.open_tables(), usize::from(comes_back));
    }
}

/// A table nobody sits at gives up the call's one slot after the idle limit.
#[tokio::test(start_paused = true)]
async fn an_empty_table_closes_as_idle() {
    let rig = Rig::new(&[1], &[]);
    let mut a = rig.connect(1);
    rig.join(&a);
    rig.create(&a, GameKindWire::Holdem).await;
    rig.sit(&a, 0).await;
    tokio::time::sleep(IDLE_LIMIT + Duration::from_secs(1)).await;
    assert!(rig.peek().is_some(), "someone is seated: not idle");
    let tid = rig.table();
    rig.send(&a, ClientMessage::GameStand { room_id: ROOM.into(), table_id: tid }).await;
    tokio::time::sleep(IDLE_LIMIT - Duration::from_secs(1)).await;
    assert!(rig.peek().is_some(), "not yet");
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(rig.peek().is_none());
    a.drain();
    assert_eq!(a.log.last().unwrap()["payload"]["reason"], "idle");
}

/// Teardown: games off for the server, the channel deleted - every
/// connection in the call is told, and the table is gone. A restart (a
/// fresh state) knows no table: a resync is answered `gone`.
#[tokio::test(start_paused = true)]
async fn teardown_disabled_channel_deleted_and_restart() {
    let rig = Rig::new(&[1, 2], &[]);
    let (mut a, mut b) = (rig.connect(1), rig.connect(2));
    let tid = heads_up(&rig, &mut a, &mut b).await;
    assert_eq!(rig.state.games.close_server(&rig.state, "another-server", GameEndReason::Disabled), 0);
    assert_eq!(rig.state.games.close_server(&rig.state, SERVER, GameEndReason::Disabled), 1);
    for c in [&mut a, &mut b] {
        c.drain();
        let last = c.log.last().unwrap();
        assert_eq!((last["type"].as_str(), last["payload"]["reason"].as_str()), (Some("GameEnded"), Some("disabled")));
        assert_eq!(last["payload"]["table_id"], tid);
    }
    assert!(rig.peek().is_none());
    rig.send(&a, ClientMessage::GameAct {
        room_id: ROOM.into(),
        table_id: tid,
        turn: TurnWire { hand_no: 1, turn_seq: 0 },
        action: GameActionWire::Fold,
    })
    .await;
    a.drain();
    assert_eq!(a.log.last().unwrap()["payload"]["reason"], "gone", "a frame for the ended table: gone");

    rig.create(&a, GameKindWire::Blackjack).await;
    assert!(rig.state.games.close_room(&rig.state, ROOM, GameEndReason::ChannelDeleted));
    b.drain();
    assert_eq!(b.log.last().unwrap()["payload"]["reason"], "channel_deleted");

    // A restart: the new process has no table, whatever the client holds.
    let restarted = Rig::new(&[1], &[]);
    let mut c = restarted.connect(1);
    restarted.join(&c);
    restarted.send(&c, ClientMessage::GameResync { room_id: ROOM.into(), table_id: tid }).await;
    c.drain();
    assert_eq!(c.log.last().unwrap()["payload"]["reason"], "gone");
}

/// The sweep's stand-up (PLAY_GAMES lost, still in the call): the player is
/// up from the table at once - mid-hand that is a fold - and stays in the call.
#[tokio::test(start_paused = true)]
async fn stand_up_takes_a_player_out_of_the_hand_at_once() {
    let rig = Rig::new(&[1, 2], &[]);
    let (mut a, mut b) = (rig.connect(1), rig.connect(2));
    heads_up(&rig, &mut a, &mut b).await;
    assert!(rig.state.games.stand_up(&rig.state, ROOM, 1));
    b.drain();
    let p = rig.peek().unwrap();
    assert!(!p.occupants.contains(&(0, 1)), "heads-up: the fold ended the hand and freed the seat");
    assert!(rig.state.rooms.get(ROOM).unwrap().members.contains(&1), "still in the call");
    assert!(!rig.state.games.stand_up(&rig.state, ROOM, 1), "nothing to stand up twice");
}

/// PLAY_GAMES denied while a seated player was AWAY (inside the disconnect
/// grace, or off in another channel): the sweep that ran for the deny saw no
/// such member in the call, and every own-seat frame skips the database gate,
/// so before this they came back and simply played on (the w3 server review
/// reproduced it against the real sweep). JoinRoom's own resolution is
/// handed to `on_join`: a returning player who may no longer play gets up.
#[tokio::test(start_paused = true)]
async fn a_player_denied_play_games_while_away_gets_up_on_return() {
    let mut rig = Rig::new(&[1, 2, 3], &[]);
    let (mut a, b, c) = (rig.connect(1), rig.connect(2), rig.connect(3));
    rig.join(&a);
    rig.join(&b);
    rig.join(&c);
    rig.create(&a, GameKindWire::Holdem).await;
    rig.sit(&a, 0).await;
    rig.sit(&b, 1).await;
    rig.sit(&c, 2).await;
    rig.state.unregister_session(2, b.conn);
    rig.state.unregister_session(3, c.conn);
    assert_eq!(rig.peek().unwrap().away, vec![1, 2], "both seats are in their grace");
    rig.set_perms(2, P::DEFAULT_MEMBER - P::PLAY_GAMES, true);
    // B returns inside the grace without PLAY_GAMES; C (still allowed) too.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut b2 = rig.connect(2);
    rig.join(&b2);
    let c2 = rig.connect(3);
    rig.join(&c2);
    a.drain();
    b2.drain();
    let p = rig.peek().unwrap();
    assert_eq!(p.occupants, vec![(0, 1), (2, 3)], "B got up; A and C (positive control) keep their seats");
    assert!(p.away.is_empty(), "nobody is away any more");
    let left = a.game_frames().iter().any(|f| {
        f["payload"]["events"].as_array().is_some_and(|e| e.iter().any(|e| e["type"] == "player_left" && e["seat"] == 1))
    });
    assert!(left, "everyone is told B left the table");
    assert!(b2.view().is_some_and(|v| v["viewer_seat"].is_null()), "B watches now: a spectator view");
    assert!(rig.state.rooms.get(ROOM).unwrap().members.contains(&2), "B is still in the call");
}

/// A room id is its canonical spelling or nothing: `voice_042` names channel
/// 42 but is not its call, so it cannot hold a second table for it (and is
/// refused before anything about tables or membership).
#[tokio::test(start_paused = true)]
async fn a_non_canonical_room_id_is_not_a_voice_room() {
    let rig = Rig::new(&[1], &[]);
    let mut a = rig.connect(1);
    rig.join(&a);
    for alias in ["voice_042", "voice_+42"] {
        rig.state.join_room(alias, 1, a.conn); // whatever JoinRoom would have said
        rig.send(&a, ClientMessage::GameCreate { room_id: alias.into(), kind: GameKindWire::Holdem, config: None }).await;
    }
    a.drain();
    let codes: Vec<&str> = a.refusals().iter().map(|r| r["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["not_a_voice_room", "not_a_voice_room"]);
    assert_eq!(rig.state.games.open_tables(), 0, "no table under an alias");
    // Positive control: the canonical id opens one.
    rig.create(&a, GameKindWire::Holdem).await;
    assert_eq!(rig.state.games.open_tables(), 1);
}

/// `GameCreate` checks membership (3) before its database gate and AGAIN
/// after it: a connection that left (or was moved or kicked) while the gate
/// awaited opens nothing - before this the table opened in a call with
/// nobody in it, and since the room was already dropped no "call ended"
/// timer ever ran for it (it held the slot until the idle close).
#[tokio::test(start_paused = true)]
async fn create_rechecks_the_call_after_the_gate() {
    let rig = Rig::new(&[1], &[]);
    let mut a = rig.connect(1);
    rig.join(&a);
    let conn = a.conn;
    rig.state.games.set_gate_hook(move |state: &AppState| {
        state.leave_room(ROOM, 1, conn);
    });
    rig.create(&a, GameKindWire::Holdem).await;
    a.drain();
    assert_eq!(rig.state.games.open_tables(), 0, "nothing opened for a connection that left during the gate");
    let codes: Vec<&str> = a.refusals().iter().map(|r| r["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["not_in_call"]);
    // Positive control: back in the call, the same create opens a table - and
    // the refused one did not use up one of the 5 opens per window.
    rig.join(&a);
    for _ in 0..5 {
        rig.create(&a, GameKindWire::Holdem).await;
        assert_eq!(rig.state.games.open_tables(), 1);
        assert!(rig.state.games.close_room(&rig.state, ROOM, GameEndReason::Closed));
    }
    a.drain();
    let codes: Vec<&str> = a.refusals().iter().map(|r| r["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["not_in_call"], "five opens after the refused one, none refused");
}

/// `GameClose` / `GameRemovePlayer` check the call AGAIN after their
/// MOVE_MEMBERS gate, as `GameCreate` and `GameSit` do: a moderator whose
/// connection left (or was moved or kicked) while the gate awaited the
/// database closes nothing and removes nobody - "in the call, MOVE_MEMBERS"
/// is not bypassed by timing.
#[tokio::test(start_paused = true)]
async fn close_and_remove_recheck_the_call_after_the_gate() {
    for op in ["close", "remove"] {
        let rig = Rig::new(&[1, 2], &[1]);
        let (mut a, mut b) = (rig.connect(1), rig.connect(2));
        rig.join(&a);
        rig.join(&b);
        rig.create(&b, GameKindWire::Holdem).await;
        rig.sit(&b, 0).await;
        let tid = rig.table();
        let conn = a.conn;
        rig.state.games.set_gate_hook(move |state: &AppState| {
            state.leave_room(ROOM, 1, conn);
        });
        let msg = |tid: u64| {
            if op == "close" {
                ClientMessage::GameClose { room_id: ROOM.into(), table_id: tid }
            } else {
                ClientMessage::GameRemovePlayer { room_id: ROOM.into(), table_id: tid, seat: 0 }
            }
        };
        rig.send(&a, msg(tid)).await;
        a.drain();
        b.drain();
        assert_eq!(rig.state.games.open_tables(), 1, "{op}: the table is still open");
        assert_eq!(rig.peek().map(|p| p.occupants), Some(vec![(0, 2)]), "{op}: B is still seated");
        let codes: Vec<&str> = a.refusals().iter().map(|r| r["code"].as_str().unwrap()).collect();
        assert_eq!(codes, ["not_in_call"], "{op}: refused, not done");
        // Positive control: back in the call, the same frame does it.
        rig.join(&a);
        rig.send(&a, msg(tid)).await;
        if op == "close" {
            assert_eq!(rig.state.games.open_tables(), 0, "close: done once back in the call");
        } else {
            assert_eq!(rig.peek().map(|p| p.occupants), Some(vec![]), "remove: done once back in the call");
        }
    }
}

/// Blackjack: when every player at the table has bet, the round is dealt
/// LAST_BET_DELAY (1.5 s) after the last bet, not at once - the last bettor
/// sees the bets on the table first. The countdown is in the view.
#[tokio::test(start_paused = true)]
async fn blackjack_deals_a_moment_after_the_last_bet() {
    let rig = Rig::new(&[1, 2], &[]);
    let (mut a, mut b) = (rig.connect(1), rig.connect(2));
    rig.join(&a);
    rig.join(&b);
    rig.create(&a, GameKindWire::Blackjack).await;
    let tid = rig.table();
    rig.sit(&a, 0).await;
    rig.sit(&b, 1).await;
    rig.send(&a, ClientMessage::GameBet { room_id: ROOM.into(), table_id: tid, amount: 10 }).await;
    a.drain();
    let first = a.view().unwrap()["next_deal_in_ms"].as_u64();
    assert!(first.is_some_and(|ms| ms > 14_000), "one of two has bet: the 15 s window ({first:?})");
    rig.send(&b, ClientMessage::GameBet { room_id: ROOM.into(), table_id: tid, amount: 20 }).await;
    b.drain();
    // "Dealt" is a `round_started` event, not "a round is in progress": a
    // dealer (or lone player) blackjack settles the round inside the deal.
    let dealt = |c: &mut Conn| {
        c.drain();
        c.game_frames().iter().any(|f| {
            f["payload"]["events"].as_array().is_some_and(|e| e.iter().any(|e| e["type"] == "round_started"))
        })
    };
    assert!(!dealt(&mut b), "not dealt at the last bet");
    let v = b.view().unwrap();
    assert_eq!(v["in_round"], false);
    assert_eq!(v["seats"][1]["pending_bet"], 20, "the last bet is on the table for everyone to see");
    let left = v["next_deal_in_ms"].as_u64();
    assert!(left.is_some_and(|ms| (1_400..=1_500).contains(&ms)), "the countdown says ~1.5 s ({left:?})");
    tokio::time::sleep(Duration::from_millis(1_400)).await;
    assert!(!dealt(&mut b), "still waiting at 1.4 s");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(dealt(&mut b), "dealt by 1.6 s");
    // Alone at the table: the same moment after the only bet.
    let solo = Rig::new(&[5], &[]);
    let mut s = solo.connect(5);
    solo.join(&s);
    solo.create(&s, GameKindWire::Blackjack).await;
    let stid = solo.table();
    solo.sit(&s, 0).await;
    solo.send(&s, ClientMessage::GameBet { room_id: ROOM.into(), table_id: stid, amount: 10 }).await;
    assert!(!dealt(&mut s));
    tokio::time::sleep(LAST_BET_DELAY + Duration::from_millis(50)).await;
    assert!(dealt(&mut s), "a lone bettor is dealt 1.5 s later too");
}

/// Who opened the table rides every `GameTable` (the client says "<name>
/// started Poker"): the frame everyone in the call gets when it opens, and
/// the one a newcomer gets on joining. `GameEvents` do not carry it.
#[tokio::test(start_paused = true)]
async fn every_game_table_names_who_opened_it() {
    let rig = Rig::new(&[1, 2, 3], &[]);
    let (mut a, mut b) = (rig.connect(1), rig.connect(2));
    rig.join(&a);
    rig.join(&b);
    rig.create(&b, GameKindWire::Holdem).await;
    rig.sit(&a, 0).await;
    let mut c = rig.connect(3);
    rig.join(&c);
    for conn in [&mut a, &mut b, &mut c] {
        conn.drain();
        let tables: Vec<&Value> = conn.log.iter().filter(|f| f["type"] == "GameTable").collect();
        assert!(!tables.is_empty(), "user {} got a GameTable", conn.user);
        assert!(tables.iter().all(|f| f["payload"]["opened_by"] == 2), "user {}: {:?}", conn.user, tables);
    }
    assert!(a.log.iter().filter(|f| f["type"] == "GameEvents").all(|f| f["payload"].get("opened_by").is_none()));
}

/// The owner's switch reaches every ONLINE member at once
/// (`ServerMessage::GamesEnabled`) - but only connections that announced
/// `games`: an older client must never be handed a frame it does not know,
/// and a delivery socket is never woken for it. A non-member hears nothing.
#[tokio::test(start_paused = true)]
async fn the_games_switch_reaches_every_member_connection_that_plays_games() {
    let rig = Rig::new(&[1], &[]);
    let mut desk = rig.connect_as(1, true, false); // in no call: the launcher's state is server-wide
    let mut old = rig.connect_as(1, false, false);
    let mut pocket = rig.connect_as(2, true, true);
    let mut other = rig.connect_as(3, true, false);
    let mut stranger = rig.connect_as(9, true, false);
    let sent = announce_enabled(&rig.state, SERVER, false, &[1, 2, 3, 4]);
    for c in [&mut desk, &mut old, &mut pocket, &mut other, &mut stranger] {
        c.drain();
    }
    let frame = serde_json::json!({"type": "GamesEnabled", "payload": {"server_id": SERVER, "games_enabled": false}});
    assert_eq!(desk.game_switch_frames(), vec![frame.clone()]);
    assert_eq!(other.game_switch_frames(), vec![frame]);
    assert!(old.game_switch_frames().is_empty(), "a connection without the cap gets nothing");
    assert!(pocket.game_switch_frames().is_empty(), "a delivery socket gets nothing");
    assert!(stranger.game_switch_frames().is_empty(), "not a member: nothing");
    assert_eq!(sent, 2);
    announce_enabled(&rig.state, SERVER, true, &[1]);
    desk.drain();
    assert_eq!(desk.game_switch_frames().last().unwrap()["payload"]["games_enabled"], true);
}

/// Lock order under load: joins and leaves, disconnects, sweeps' stand-ups,
/// actions, resyncs, closes and reopens on several threads at once. A
/// deadlock (a table lock taken under a rooms guard, or the reverse) hangs
/// a worker; the timeout turns that into a failure.
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn lock_order_holds_under_concurrent_churn() {
    let rig = Rig::new(&(1..=12).collect::<Vec<_>>(), &[1]);
    rig.state.games.set_timings(Timings {
        next_hand: Duration::from_millis(5),
        bet_window: Duration::from_millis(5),
        last_bet: Duration::from_millis(2),
        idle: Duration::from_millis(50),
        grace: Some(Duration::from_millis(20)),
    });
    let state = Arc::clone(&rig.state);
    let opener = rig.connect(1);
    rig.join(&opener);
    rig.create(&opener, GameKindWire::Holdem).await;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let mut tasks = Vec::new();
    for u in 2..=12 {
        let state = Arc::clone(&state);
        tasks.push(tokio::spawn(async move {
            let mut r = rng::seeded(u as u64);
            while std::time::Instant::now() < deadline {
                let (tx, mut rx) = mpsc::channel::<ServerMessage>(64);
                let (conn, _, _) = state.register_session(u, format!("u{u}"), tx, false, None, format!("s{u}"));
                state.set_conn_games(u, conn, true);
                state.join_room(ROOM, u, conn);
                state.games.on_join(&state, ROOM, u, conn, true);
                for _ in 0..r.gen_range(1..20) {
                    let tid = state.games.peek(ROOM).map(|p| p.id).unwrap_or(0);
                    let msg = match r.gen_range(0..8) {
                        0 => ClientMessage::GameSit { room_id: ROOM.into(), table_id: tid, seat: r.gen_range(0..6) },
                        1 => ClientMessage::GameStand { room_id: ROOM.into(), table_id: tid },
                        2 => ClientMessage::GameResync { room_id: ROOM.into(), table_id: tid },
                        3 => ClientMessage::GameCreate { room_id: ROOM.into(), kind: GameKindWire::Holdem, config: None },
                        _ => {
                            let turn = state.games.peek(ROOM).and_then(|p| p.turn).unwrap_or(TurnRef { hand_no: 0, turn_seq: 0 });
                            ClientMessage::GameAct {
                                room_id: ROOM.into(),
                                table_id: tid,
                                turn: turn.into(),
                                action: if r.gen_bool(0.5) { GameActionWire::Call } else { GameActionWire::Check },
                            }
                        }
                    };
                    handle_frame(&state, u, conn, msg).await;
                    while rx.try_recv().is_ok() {}
                    if r.gen_bool(0.1) {
                        state.games.stand_up(&state, ROOM, u);
                    }
                    tokio::task::yield_now().await;
                }
                if r.gen_bool(0.5) {
                    state.leave_room(ROOM, u, conn);
                    state.unregister_session(u, conn);
                } else {
                    state.unregister_session(u, conn);
                }
            }
        }));
    }
    {
        // A moderator closing and reopening, and a sweep standing people up.
        let state = Arc::clone(&state);
        let (u, conn) = (opener.user, opener.conn);
        tasks.push(tokio::spawn(async move {
            while std::time::Instant::now() < deadline {
                if let Some(p) = state.games.peek(ROOM) {
                    handle_frame(&state, u, conn, ClientMessage::GameClose { room_id: ROOM.into(), table_id: p.id }).await;
                }
                handle_frame(&state, u, conn, ClientMessage::GameCreate { room_id: ROOM.into(), kind: GameKindWire::Holdem, config: None }).await;
                for v in 2..=12 {
                    state.games.stand_up(&state, ROOM, v);
                }
                tokio::time::sleep(Duration::from_millis(3)).await;
            }
        }));
    }
    let all = async {
        for t in tasks {
            t.await.expect("no task panicked");
        }
    };
    tokio::time::timeout(Duration::from_secs(30), all).await.expect("no deadlock: every task finished");
    // Still consistent: at most one table, and a frame still gets an answer.
    assert!(state.games.open_tables() <= 1);
}

// ---------------------------------------------------------------------------
// The real database gate, sweep and settings handler (TEST_DATABASE_URL).

mod db {
    use super::*;

    struct Fixture {
        sid: String,
        cid: i64,
        owner: i64,
        a: i64,
        b: i64,
        nogames: i64,
        users: Vec<i32>,
    }

    async fn fixture(pool: &sqlx::PgPool, games_enabled: bool) -> Fixture {
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let mk = |n: &str| format!("gm_{n}_{}", &tag[..12]);
        let mut users = Vec::new();
        for n in ["owner", "a", "b"] {
            let (id,): (i32,) = sqlx::query_as("INSERT INTO users (username, email, salt, verifier, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id")
                .bind(mk(n)).bind(format!("{}@test.invalid", mk(n))).bind(b"s".as_ref()).bind(b"v".as_ref())
                .fetch_one(pool).await.expect("user");
            users.push(id);
        }
        let sid = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)").bind(&sid).bind(mk("srv")).bind(users[0]).execute(pool).await.expect("server");
        sqlx::query("UPDATE servers SET games_enabled = $1 WHERE id = $2").bind(games_enabled).bind(&sid).execute(pool).await.expect("switch");
        sqlx::query("INSERT INTO server_members (server_id, user_id) VALUES ($1, $2), ($1, $3), ($1, $4)")
            .bind(&sid).bind(users[0]).bind(users[1]).bind(users[2]).execute(pool).await.expect("members");
        let everyone = (P::VIEW_CHANNEL | P::CONNECT | P::SPEAK | P::PLAY_GAMES).bits() as i64;
        sqlx::query("INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, '@everyone', '#99AAB5', $2, 0, true)")
            .bind(&sid).bind(everyone).execute(pool).await.expect("@everyone");
        let (cid,): (i32,) = sqlx::query_as("INSERT INTO channels (server_id, name, type) VALUES ($1, 'v', 1) RETURNING id")
            .bind(&sid).fetch_one(pool).await.expect("channel");
        let (nogames,): (i64,) = sqlx::query_as("INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ($1, 'nogames', '#99AAB5', 0, 1, false) RETURNING id")
            .bind(&sid).fetch_one(pool).await.expect("role");
        sqlx::query("INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES ($1, $2, 0, $3)")
            .bind(cid as i64).bind(nogames).bind(P::PLAY_GAMES.bits() as i64).execute(pool).await.expect("deny");
        Fixture { sid, cid: cid as i64, owner: users[0] as i64, a: users[1] as i64, b: users[2] as i64, nogames, users }
    }

    async fn drop_fixture(pool: &sqlx::PgPool, f: &Fixture) {
        let _ = sqlx::query("DELETE FROM channels WHERE id = $1").bind(f.cid as i32).execute(pool).await;
        let _ = sqlx::query("DELETE FROM servers WHERE id = $1").bind(&f.sid).execute(pool).await;
        let _ = sqlx::query("DELETE FROM users WHERE id = ANY($1)").bind(f.users.clone()).execute(pool).await;
    }

    async fn deny_games(pool: &sqlx::PgPool, f: &Fixture, user: i64) {
        sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)")
            .bind(&f.sid).bind(user as i32).bind(f.nogames).execute(pool).await.expect("member role");
    }

    fn conn(state: &Arc<AppState>, user: i64, room: &str) -> Conn {
        let (tx, rx) = mpsc::channel::<ServerMessage>(1024);
        let (c, _, _) = state.register_session(user, format!("u{user}"), tx, false, None, format!("s{user}"));
        state.set_conn_games(user, c, true);
        state.join_room(room, user, c);
        Conn { user, conn: c, rx, log: Vec::new() }
    }

    /// The real gate: `games_enabled` first (`disabled`), then CONNECT +
    /// PLAY_GAMES in THIS channel, a channel overwrite included.
    #[tokio::test]
    async fn the_real_gate_reads_the_switch_and_play_games_with_overwrites() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let f = fixture(&pool, false).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{}", f.cid);
        let (mut a, mut b) = (conn(&state, f.a, &room), conn(&state, f.b, &room));
        let create = |r: &str| ClientMessage::GameCreate { room_id: r.to_string(), kind: GameKindWire::Holdem, config: None };
        handle_frame(&state, f.a, a.conn, create(&room)).await;
        a.drain();
        let off = a.refusals().last().map(|r| r["code"].clone());
        sqlx::query("UPDATE servers SET games_enabled = true WHERE id = $1").bind(&f.sid).execute(&pool).await.unwrap();
        deny_games(&pool, &f, f.b).await;
        handle_frame(&state, f.b, b.conn, create(&room)).await;
        handle_frame(&state, f.a, a.conn, create(&room)).await;
        let tid = state.games.peek(&room).map(|p| p.id);
        if let Some(tid) = tid {
            handle_frame(&state, f.b, b.conn, ClientMessage::GameSit { room_id: room.clone(), table_id: tid, seat: 1 }).await;
            handle_frame(&state, f.a, a.conn, ClientMessage::GameSit { room_id: room.clone(), table_id: tid, seat: 0 }).await;
        }
        let occupants = state.games.peek(&room).map(|p| p.occupants);
        a.drain();
        b.drain();
        drop_fixture(&pool, &f).await;

        assert_eq!(off, Some(Value::from("disabled")), "games off by default: disabled");
        assert!(tid.is_some(), "A (PLAY_GAMES) opened the table");
        let b_codes: Vec<&str> = b.refusals().iter().map(|r| r["code"].as_str().unwrap()).collect();
        assert_eq!(b_codes, ["no_permission", "no_permission"], "the channel overwrite denies B both");
        assert_eq!(occupants, Some(vec![(0, f.a)]));
    }

    /// The permission sweep: B loses PLAY_GAMES in the channel while staying
    /// in the call and is stood up from the table; A plays on. A kick (the
    /// member row gone) takes A out of the call AND off the table at once,
    /// with no grace.
    #[tokio::test]
    async fn the_sweep_stands_up_a_player_who_lost_play_games() {
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let f = fixture(&pool, true).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{}", f.cid);
        let (mut a, mut b) = (conn(&state, f.a, &room), conn(&state, f.b, &room));
        handle_frame(&state, f.a, a.conn, ClientMessage::GameCreate { room_id: room.clone(), kind: GameKindWire::Blackjack, config: None }).await;
        let tid = state.games.peek(&room).map(|p| p.id).unwrap_or(0);
        handle_frame(&state, f.a, a.conn, ClientMessage::GameSit { room_id: room.clone(), table_id: tid, seat: 0 }).await;
        handle_frame(&state, f.b, b.conn, ClientMessage::GameSit { room_id: room.clone(), table_id: tid, seat: 1 }).await;
        let seated = state.games.peek(&room).map(|p| p.occupants);

        deny_games(&pool, &f, f.b).await;
        crate::ws::broadcast_perms_changed_and_evict(&state, &f.sid).await;
        let after_deny = state.games.peek(&room).map(|p| p.occupants);
        let b_in_call = state.rooms.get(&room).is_some_and(|r| r.members.contains(&f.b));

        // Kick A: the member row goes, the sweep evicts A from the call.
        sqlx::query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2").bind(&f.sid).bind(f.a as i32).execute(&pool).await.unwrap();
        crate::ws::broadcast_perms_changed_and_evict(&state, &f.sid).await;
        let after_kick = state.games.peek(&room).map(|p| (p.occupants, p.away));
        let a_in_call = state.rooms.get(&room).is_some_and(|r| r.members.contains(&f.a));
        a.drain();
        b.drain();
        drop_fixture(&pool, &f).await;

        assert_eq!(seated, Some(vec![(0, f.a), (1, f.b)]), "positive control: both seated");
        assert_eq!(after_deny, Some(vec![(0, f.a)]), "B stood up, A untouched");
        assert!(b_in_call, "B stays in the call: only the table is taken away");
        assert!(!a_in_call, "the kick evicted A from the call");
        assert_eq!(after_kick, Some((vec![], vec![])), "A is off the table at once, no grace");
    }

    /// Games are AVAILABLE BY DEFAULT (owner decision 2026-10-03, "work
    /// similarly to Discord's games"): migration 073's column defaults TRUE, so
    /// a server row that never mentions it - every existing server, and every
    /// new one - plays; and `create_server` answers the row's real value, so
    /// the creator's launcher shows without a refetch. The owner can still
    /// switch it off (the test below).
    #[tokio::test]
    async fn games_are_on_by_default_for_new_and_existing_servers() {
        use axum::extract::{Json, State};
        use axum::response::IntoResponse;
        use axum::Extension;
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let f = fixture(&pool, false).await;
        let (default,): (Option<String>,) = sqlx::query_as(
            "SELECT column_default FROM information_schema.columns WHERE table_name = 'servers' AND column_name = 'games_enabled'",
        )
        .fetch_one(&pool)
        .await
        .expect("the column exists");
        // An existing row: inserted without the column, as every pre-073 row was.
        let old_id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO servers (id, name, owner_id) VALUES ($1, $2, $3)").bind(&old_id).bind("gm-old").bind(f.users[0]).execute(&pool).await.unwrap();
        let (old_on,): (bool,) = sqlx::query_as("SELECT games_enabled FROM servers WHERE id = $1").bind(&old_id).fetch_one(&pool).await.unwrap();
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let owner = crate::auth::Claims { sub: f.owner, username: "o".into(), exp: 0, tv: 0, sst: 0, sid: String::new(), ls: false };
        let req: crate::server_handlers::CreateServerRequest = serde_json::from_value(serde_json::json!({"name": "gm-new"})).unwrap();
        let resp = crate::server_handlers::create_server(State(Arc::clone(&state)), Extension(owner), Json(req)).await.into_response();
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap()).unwrap();
        let new_id = body["id"].as_str().unwrap_or_default().to_string();
        let (new_on,): (bool,) = sqlx::query_as("SELECT games_enabled FROM servers WHERE id = $1").bind(&new_id).fetch_one(&pool).await.unwrap();
        let (bit,): (i64,) = sqlx::query_as("SELECT permissions FROM server_roles WHERE server_id = $1 AND is_default = true")
            .bind(&new_id).fetch_one(&pool).await.unwrap();
        let _ = sqlx::query("DELETE FROM servers WHERE id = ANY($1)").bind(vec![old_id, new_id]).execute(&pool).await;
        drop_fixture(&pool, &f).await;

        assert_eq!(default.as_deref(), Some("true"), "the column defaults ON");
        assert!(old_on, "a row that never set it plays games");
        assert!(new_on, "a new server plays games");
        assert_eq!(body["games_enabled"], true, "the creator is told the row's value: {body}");
        assert!(P::from_bits_truncate(bit as u64).contains(P::PLAY_GAMES), "and @everyone may play (DEFAULT_MEMBER)");
    }

    /// Switching games off (the owner's settings PATCH) ends every table of
    /// the server; deleting the voice channel ends its table; `games_enabled`
    /// reads back through the server list.
    #[tokio::test]
    async fn the_switch_and_channel_delete_end_tables_and_the_rest_api_reads_the_switch() {
        use axum::extract::{Json, Path, State};
        use axum::response::IntoResponse;
        use axum::Extension;
        let Some(pool) = crate::migrator::test_pool(4).await else { return };
        let f = fixture(&pool, true).await;
        let state = AppState::new(pool.clone(), "test-secret".into(), None, Arc::new(crate::wake::NullWake));
        let room = format!("voice_{}", f.cid);
        let mut a = conn(&state, f.a, &room);
        // B is a member online in NO call: the launcher's switch reaches them
        // too. B's second connection did not announce `games`.
        let (tx, b_rx) = mpsc::channel::<ServerMessage>(64);
        let (b_conn, _, _) = state.register_session(f.b, "b".into(), tx, false, None, "sb".into());
        state.set_conn_games(f.b, b_conn, true);
        let mut b = Conn { user: f.b, conn: b_conn, rx: b_rx, log: Vec::new() };
        let (tx, old_rx) = mpsc::channel::<ServerMessage>(64);
        let (old_conn, _, _) = state.register_session(f.b, "b".into(), tx, false, None, "sb-old".into());
        let mut b_old = Conn { user: f.b, conn: old_conn, rx: old_rx, log: Vec::new() };
        let owner = crate::auth::Claims { sub: f.owner, username: "o".into(), exp: 0, tv: 0, sst: 0, sid: String::new(), ls: false };
        let listed = |claims: crate::auth::Claims| {
            let state = Arc::clone(&state);
            async move {
                let resp = crate::server_handlers::list_servers(State(state), Extension(claims)).await.into_response();
                let body = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
                serde_json::from_slice::<Value>(&body).unwrap()
            }
        };
        let before = listed(owner.clone()).await;

        handle_frame(&state, f.a, a.conn, ClientMessage::GameCreate { room_id: room.clone(), kind: GameKindWire::Holdem, config: None }).await;
        let opened = state.games.peek(&room).is_some();
        let patch: crate::server_handlers::UpdateServerRequest =
            serde_json::from_value(serde_json::json!({"games_enabled": false})).unwrap();
        let status = crate::server_handlers::update_server_settings(State(Arc::clone(&state)), Path(f.sid.clone()), Extension(owner.clone()), Json(patch))
            .await
            .into_response()
            .status();
        let after_off = state.games.peek(&room).is_some();
        a.drain();
        let ended = a.log.iter().rev().find(|f| f["type"] == "GameEnded").map(|f| f["payload"]["reason"].clone());
        // The push comes AFTER the ending, so a client never sees the
        // launcher go while its table is still up.
        let order: Vec<String> =
            a.log.iter().filter_map(|f| f["type"].as_str()).filter(|t| *t == "GameEnded" || *t == "GamesEnabled").map(String::from).collect();
        let after = listed(owner.clone()).await;
        let on: crate::server_handlers::UpdateServerRequest =
            serde_json::from_value(serde_json::json!({"games_enabled": true})).unwrap();
        let _ = crate::server_handlers::update_server_settings(State(Arc::clone(&state)), Path(f.sid.clone()), Extension(owner.clone()), Json(on))
            .await
            .into_response();
        b.drain();
        b_old.drain();
        let pushed_b: Vec<Value> = b.game_switch_frames();

        handle_frame(&state, f.a, a.conn, ClientMessage::GameCreate { room_id: room.clone(), kind: GameKindWire::Blackjack, config: None }).await;
        let reopened = state.games.peek(&room).is_some();
        let _ = crate::channel_handlers::delete_channel(State(Arc::clone(&state)), Path(f.cid), Extension(owner.clone())).await;
        a.drain();
        let deleted = a.log.last().map(|f| f["payload"]["reason"].clone());
        let gone = state.games.peek(&room).is_none();
        drop_fixture(&pool, &f).await;

        let flag = |v: &Value| v.as_array().unwrap().iter().find(|s| s["id"] == f.sid.as_str()).map(|s| s["games_enabled"].clone());
        assert_eq!(flag(&before), Some(Value::Bool(true)), "the server list carries the switch");
        assert!(opened, "positive control: the table opened");
        assert!(status.is_success(), "{status}");
        assert!(!after_off, "switching games off ended the table");
        assert_eq!(ended, Some(Value::from("disabled")));
        assert_eq!(order, ["GameEnded", "GamesEnabled"], "the ending first, then the switch");
        let sw = |on: bool| serde_json::json!({"type": "GamesEnabled", "payload": {"server_id": f.sid, "games_enabled": on}});
        assert_eq!(pushed_b, vec![sw(false), sw(true)], "a member in no call hears both switches, live");
        assert!(b_old.game_switch_frames().is_empty(), "a connection without `games` never gets the frame");
        assert_eq!(flag(&after), Some(Value::Bool(false)));
        assert!(reopened);
        assert_eq!(deleted, Some(Value::from("channel_deleted")));
        assert!(gone);
    }
}
