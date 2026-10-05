//! Thousands of seeded random Hold'em hands, driven only through the public
//! API, with three invariants checked after EVERY operation:
//!
//! 1. CHIP CONSERVATION. Chips enter a table only when a player sits down or
//!    rebuys and leave only with a departing player's stack. Between those,
//!    the sum of every stack plus the pot is constant — no action, timeout,
//!    side pot, split, odd chip or departure may mint or burn a chip.
//! 2. NO LEAK. The view for seat A — and every event, which goes to everyone —
//!    contains no card other than A's own hole cards, the board, and hands
//!    that were actually shown. In particular never another seat's hole cards
//!    before showdown, never a mucked hand, never the undealt deck.
//! 3. ONE DECK. Hole cards across seats and the board never repeat a card.
//! 4. NO POINTLESS DECISION. A player is given a turn only when there is
//!    something to decide: if nobody else can still act, the player must be
//!    facing more than they have put in (else the clock could fold chips that
//!    already cover every all-in), and may then only call or fold.
//! 5. LIVE POTS ADD UP. While a hand is live, the main pot and side pots the
//!    view shows plus every bet still in front of a player is the pot total;
//!    no pot is empty or names a folded seat; and each side pot's contenders
//!    are a subset of the pot before it (a short stack is never offered a
//!    side pot it did not cover). Between hands there are no live pots.
//!
//! Plus: a refused action (`Err`) leaves every view — each seat's and the
//! spectator's — unchanged. That is what clients can observe; the engine's
//! hidden state (deck order, per-seat bookkeeping) is not compared here, and
//! is kept unchanged by validating before mutating (`HoldemTable::apply`).
//!
//! The run also counts what it exercised (side pots, split pots, timeouts,
//! departures mid-hand, incomplete raises…) and fails if any of those never
//! happened, so it cannot pass by playing nothing but folds.

use puca_games::cards::Card;
use puca_games::holdem::{Action, Event, HoldemConfig, HoldemError, HoldemTable, LegalActions, SeatStatus};
use puca_games::rng::{below, seeded};
use puca_games::{PlayerId, TurnRef};
use std::collections::HashSet;

fn chance(rng: &mut rand::rngs::StdRng, percent: u64) -> bool {
    below(rng, 100) < percent
}

/// Every bracketed card token (`[Ah]`) in a Debug rendering.
fn card_tokens(s: &str) -> HashSet<String> {
    let b = s.as_bytes();
    let mut out = HashSet::new();
    for i in 0..b.len().saturating_sub(3) {
        if b[i] == b'[' && b[i + 3] == b']' {
            let code = &s[i + 1..i + 3];
            if Card::parse(code).is_some() {
                out.insert(code.to_string());
            }
        }
    }
    out
}

#[derive(Default, Debug)]
struct Coverage {
    hands: u64,
    showdowns: u64,
    side_pots: u64,
    split_pots: u64,
    uncalled_returns: u64,
    timeouts: u64,
    left_mid_hand: u64,
    refused_actions: u64,
    not_reopened: u64,
    voluntary_shows: u64,
    rebuys: u64,
    /// Turns given to the only player who can still act (facing a bigger
    /// all-in): the call-or-fold branch of invariant 4.
    lone_decisions: u64,
    /// Views that showed a side pot while the hand was still being played.
    live_side_pots: u64,
}

struct Sim {
    rng: rand::rngs::StdRng,
    table: HoldemTable,
    ledger: u64,
    next_player: u128,
    revealed: HashSet<String>,
    cov: Coverage,
}

impl Sim {
    fn absorb(&mut self, events: &[Event]) {
        for e in events {
            match e {
                Event::PlayerSat { stack, .. } | Event::Rebought { stack, .. } => self.ledger += stack,
                Event::PlayerLeft { stack, .. } => self.ledger -= stack,
                Event::HandStarted { .. } => {
                    self.revealed.clear();
                    self.cov.hands += 1;
                }
                Event::Showdown { shown, .. } => {
                    self.cov.showdowns += 1;
                    for h in shown {
                        for c in h.cards {
                            self.revealed.insert(c.to_string());
                        }
                    }
                }
                Event::Shown { cards, .. } => {
                    for c in cards {
                        self.revealed.insert(c.to_string());
                    }
                }
                Event::PotAwarded { pot, shares, .. } => {
                    if *pot > 0 {
                        self.cov.side_pots += 1;
                    }
                    if shares.len() > 1 {
                        self.cov.split_pots += 1;
                    }
                }
                Event::UncalledReturned { .. } => self.cov.uncalled_returns += 1,
                _ => {}
            }
        }
        // Events go to EVERYONE: they may name the board and shown hands,
        // nothing else.
        let board: HashSet<String> = self.table.view_for(None).board.iter().map(|c| c.to_string()).collect();
        for t in card_tokens(&format!("{events:?}")) {
            assert!(
                board.contains(&t) || self.revealed.contains(&t),
                "event leaked {t}: {events:?}"
            );
        }
    }

    fn check(&mut self) {
        let public = self.table.view_for(None);
        // 1. Conservation.
        let on_table: u64 = public.seats.iter().flatten().map(|s| s.stack).sum::<u64>() + public.pot_total;
        assert_eq!(on_table, self.ledger, "chips minted or burned: {public:?}");
        // 2 + 3. Leak and one-deck.
        let board: HashSet<String> = public.board.iter().map(|c| c.to_string()).collect();
        let mut dealt: Vec<Card> = public.board.clone();
        let allowed_public: HashSet<String> = board.union(&self.revealed).cloned().collect();
        for t in card_tokens(&format!("{public:?}")) {
            assert!(allowed_public.contains(&t), "spectator view leaked {t}: {public:?}");
        }
        for seat in 0..public.seats.len() {
            if public.seats[seat].is_none() {
                continue;
            }
            let view = self.table.view_for(Some(seat));
            let mut allowed = allowed_public.clone();
            if let Some(mine) = view.my_cards {
                dealt.extend(mine);
                for c in mine {
                    allowed.insert(c.to_string());
                }
            }
            for t in card_tokens(&format!("{view:?}")) {
                assert!(allowed.contains(&t), "view for seat {seat} leaked {t}: {view:?}");
            }
        }
        let unique: HashSet<Card> = dealt.iter().copied().collect();
        assert_eq!(unique.len(), dealt.len(), "a card was dealt twice: {dealt:?}");
        // The table's own Debug never shows a card at all.
        assert!(card_tokens(&format!("{:?}", self.table)).is_empty(), "table Debug is not redacted");
        // 5. Live pots add up.
        if public.in_hand {
            let bets: u64 = public.seats.iter().flatten().map(|s| s.street_commit).sum();
            let pots: u64 = public.pots.iter().map(|p| p.amount).sum();
            assert_eq!(pots + bets, public.pot_total, "live pots and bets do not make the total: {public:?}");
            for (k, pot) in public.pots.iter().enumerate() {
                assert!(pot.amount > 0 && !pot.eligible.is_empty(), "an empty pot: {public:?}");
                for &e in &pot.eligible {
                    let st = public.seats[e].as_ref().map(|s| s.status);
                    assert!(matches!(st, Some(SeatStatus::InHand | SeatStatus::AllIn)), "pot {k} offered to seat {e} ({st:?}): {public:?}");
                }
                if k > 0 {
                    let prev = &public.pots[k - 1].eligible;
                    assert!(pot.eligible.iter().all(|e| prev.contains(e)), "side pot {k} names a seat the pot before it does not: {public:?}");
                }
            }
            if public.pots.len() > 1 {
                self.cov.live_side_pots += 1;
            }
        } else {
            assert!(public.pots.is_empty(), "pots between hands: {public:?}");
        }
        // 4. No pointless decision.
        if let Some(s) = public.to_act {
            let me = public.seats[s].as_ref().expect("the seat to act is occupied");
            let others: Vec<_> = public
                .seats
                .iter()
                .flatten()
                .filter(|o| o.seat != s && matches!(o.status, SeatStatus::InHand | SeatStatus::AllIn))
                .collect();
            if !others.iter().any(|o| o.status == SeatStatus::InHand) {
                let top = others.iter().map(|o| o.street_commit).max().unwrap_or(0);
                assert!(
                    me.street_commit < top,
                    "seat {s} was given a turn with nothing to decide (covers every all-in): {public:?}"
                );
                let la = self.table.legal_actions(s).expect("legal actions for the seat to act");
                assert!(!la.can_raise, "seat {s} offered a raise nobody could answer: {la:?}");
                self.cov.lone_decisions += 1;
            }
        }
    }

    /// Runs `op`; on Err asserts nothing changed, on Ok absorbs and checks.
    fn run(&mut self, op: impl FnOnce(&mut HoldemTable) -> Result<Vec<Event>, HoldemError>) -> Result<(), HoldemError> {
        let before: Vec<_> = (0..self.table.config().max_seats)
            .map(|s| format!("{:?}", self.table.view_for(Some(s))))
            .chain(std::iter::once(format!("{:?}", self.table.view_for(None))))
            .collect();
        match op(&mut self.table) {
            Ok(events) => {
                self.absorb(&events);
                self.check();
                Ok(())
            }
            Err(e) => {
                let after: Vec<_> = (0..self.table.config().max_seats)
                    .map(|s| format!("{:?}", self.table.view_for(Some(s))))
                    .chain(std::iter::once(format!("{:?}", self.table.view_for(None))))
                    .collect();
                assert_eq!(before, after, "a refused operation ({e:?}) changed the table");
                Err(e)
            }
        }
    }

    fn new_player(&mut self) -> PlayerId {
        self.next_player += 1;
        PlayerId(self.next_player)
    }

    fn between_hands(&mut self) {
        let n = self.table.config().max_seats;
        for seat in 0..n {
            let occupied = self.table.view_for(None).seats[seat].clone();
            match occupied {
                None => {
                    if chance(&mut self.rng, 30) {
                        let p = self.new_player();
                        self.run(|t| t.sit(seat, p)).unwrap();
                    }
                }
                Some(s) => {
                    if chance(&mut self.rng, 6) {
                        self.run(|t| t.leave(seat)).unwrap();
                    } else if s.stack == 0 {
                        if chance(&mut self.rng, 60) {
                            if self.table.config().allow_rebuy {
                                self.run(|t| t.rebuy(seat)).unwrap();
                                self.cov.rebuys += 1;
                            } else {
                                assert_eq!(self.run(|t| t.rebuy(seat)), Err(HoldemError::RebuyNotAllowed));
                                // Busted with no rebuy: all that is left is to go.
                                self.run(|t| t.leave(seat)).unwrap();
                            }
                        }
                    } else if s.sitting_out {
                        if chance(&mut self.rng, 70) {
                            self.run(|t| t.sit_in(seat)).unwrap();
                        }
                    } else if chance(&mut self.rng, 4) {
                        self.run(|t| t.sit_out(seat)).unwrap();
                    }
                }
            }
        }
    }

    fn random_action(&mut self, la: LegalActions) -> Action {
        let r = below(&mut self.rng, 100);
        if r < 12 {
            Action::Fold
        } else if r < 60 {
            if la.can_check {
                Action::Check
            } else {
                Action::Call
            }
        } else if r < 88 && la.can_raise {
            let span = la.max_raise_to - la.min_raise_to;
            let to = match below(&mut self.rng, 3) {
                0 => la.min_raise_to,
                _ => la.min_raise_to + below(&mut self.rng, span + 1),
            };
            Action::BetOrRaiseTo(to)
        } else if r < 94 {
            Action::AllIn
        } else if la.can_check {
            Action::Check
        } else {
            Action::Call
        }
    }

    /// Something a client might send that must be refused.
    fn try_illegal(&mut self, seat: usize, turn: TurnRef, la: LegalActions) {
        let pick = below(&mut self.rng, 4);
        let (who, t, action) = match pick {
            0 => (seat, TurnRef { hand_no: turn.hand_no, turn_seq: turn.turn_seq.wrapping_sub(1) }, Action::Fold),
            1 => ((seat + 1) % self.table.config().max_seats, turn, Action::Fold),
            2 if !la.can_check => (seat, turn, Action::Check),
            _ if la.can_raise && la.min_raise_to < la.max_raise_to => (seat, turn, Action::BetOrRaiseTo(la.min_raise_to - 1)),
            _ => (seat, turn, Action::BetOrRaiseTo(la.max_raise_to + 1)),
        };
        let r = self.run(|tb| tb.act(who, t, action));
        assert!(r.is_err(), "illegal {action:?} by seat {who} was accepted");
        self.cov.refused_actions += 1;
    }

    fn play_hand(&mut self) {
        let mut tries = 0;
        loop {
            let mut deal_rng = seeded(below(&mut self.rng, u64::MAX));
            match self.run(|t| t.start_hand(&mut deal_rng)) {
                Ok(()) => break,
                Err(HoldemError::NotEnoughPlayers) => {
                    tries += 1;
                    assert!(tries < 200, "could not seat two players");
                    self.between_hands();
                }
                Err(e) => panic!("start_hand: {e:?}"),
            }
        }
        let mut steps = 0;
        while self.table.hand_in_progress() {
            steps += 1;
            assert!(steps < 500, "hand never ends");
            let seat = self.table.to_act().expect("a hand in progress has someone to act");
            let turn = self.table.turn().expect("turn");
            let la = self.table.legal_actions(seat).expect("legal actions for the seat to act");
            if chance(&mut self.rng, 5) {
                self.try_illegal(seat, turn, la);
                continue;
            }
            if chance(&mut self.rng, 4) {
                // A stale timer first: must be a no-op.
                let stale = TurnRef { hand_no: turn.hand_no, turn_seq: turn.turn_seq + 1 };
                assert_eq!(self.run(|t| t.timeout(stale)), Err(HoldemError::StaleTurn));
                self.run(|t| t.timeout(turn)).unwrap();
                self.cov.timeouts += 1;
                continue;
            }
            if chance(&mut self.rng, 2) {
                // Somebody (maybe not the player to act) drops out mid-hand.
                let n = self.table.config().max_seats;
                let victim = below(&mut self.rng, n as u64) as usize;
                if self.table.view_for(None).seats[victim].is_some() {
                    self.run(|t| t.leave(victim)).unwrap();
                    self.cov.left_mid_hand += 1;
                    continue;
                }
            }
            let action = self.random_action(la);
            match self.run(|t| t.act(seat, turn, action)) {
                Ok(()) => {}
                Err(e @ (HoldemError::RaiseNotReopened | HoldemError::NobodyToRaise)) => {
                    // legal_actions said can_raise = false then; a raise or
                    // all-in-for-more is the refused move. Call instead.
                    assert!(!la.can_raise);
                    if e == HoldemError::RaiseNotReopened {
                        self.cov.not_reopened += 1;
                    }
                    self.run(|t| t.act(seat, turn, Action::Call)).unwrap();
                }
                Err(e) => panic!("legal-looking {action:?} refused: {e:?} with {la:?}"),
            }
        }
        // Voluntary show after the hand.
        if chance(&mut self.rng, 10) {
            let n = self.table.config().max_seats;
            let seat = below(&mut self.rng, n as u64) as usize;
            if self.run(|t| t.show_cards(seat)).is_ok() {
                self.cov.voluntary_shows += 1;
            }
        }
    }
}

#[test]
fn chips_are_conserved_and_no_view_leaks_over_thousands_of_random_hands() {
    let mut total = Coverage::default();
    for seed in 0..48u64 {
        let mut rng = seeded(0x9A3E_0000 + seed);
        let big_blind = [2, 10, 20][below(&mut rng, 3) as usize];
        let config = HoldemConfig {
            max_seats: 2 + below(&mut rng, 8) as usize,
            starting_stack: [big_blind * 3, 100, 1_000][below(&mut rng, 3) as usize],
            small_blind: big_blind / 2,
            big_blind,
            allow_rebuy: seed % 5 != 0,
            ..HoldemConfig::default()
        };
        let mut sim = Sim {
            rng,
            table: HoldemTable::new(config).unwrap(),
            ledger: 0,
            next_player: (seed as u128) << 32,
            revealed: HashSet::new(),
            cov: Coverage::default(),
        };
        for seat in 0..sim.table.config().max_seats {
            if seat < 2 || chance(&mut sim.rng, 70) {
                let p = sim.new_player();
                sim.run(|t| t.sit(seat, p)).unwrap();
            }
        }
        for _ in 0..70 {
            sim.play_hand();
            sim.between_hands();
        }
        let c = sim.cov;
        total.hands += c.hands;
        total.showdowns += c.showdowns;
        total.side_pots += c.side_pots;
        total.split_pots += c.split_pots;
        total.uncalled_returns += c.uncalled_returns;
        total.timeouts += c.timeouts;
        total.left_mid_hand += c.left_mid_hand;
        total.refused_actions += c.refused_actions;
        total.not_reopened += c.not_reopened;
        total.voluntary_shows += c.voluntary_shows;
        total.rebuys += c.rebuys;
        total.lone_decisions += c.lone_decisions;
        total.live_side_pots += c.live_side_pots;
    }
    eprintln!("coverage: {total:?}");
    assert!(total.hands >= 3_000, "{total:?}");
    for (name, n) in [
        ("showdowns", total.showdowns),
        ("side pots", total.side_pots),
        ("split pots", total.split_pots),
        ("uncalled returns", total.uncalled_returns),
        ("timeouts", total.timeouts),
        ("departures mid-hand", total.left_mid_hand),
        ("refused actions", total.refused_actions),
        ("incomplete raises that did not reopen", total.not_reopened),
        ("voluntary shows", total.voluntary_shows),
        ("rebuys", total.rebuys),
        ("call-or-fold turns facing a bigger all-in", total.lone_decisions),
        ("side pots shown while the hand was live", total.live_side_pots),
    ] {
        assert!(n > 0, "the random run never exercised {name}: {total:?}");
    }
}
