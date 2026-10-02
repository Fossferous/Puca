//! No-Limit Texas Hold'em, cash-table style: free chips, everyone sits down
//! with the same stack, players come and go between hands.
//!
//! RULES, as implemented (docs/GAMES.md lists which are owner-changeable):
//!
//! * **Button and blinds.** The first hand's button is the lowest occupied,
//!   dealable seat; after that it moves to the next dealable seat clockwise
//!   (a "moving button": no dead button or dead small blind). With three or
//!   more players the small blind is left of the button and the big blind
//!   left of that. **Heads-up the button posts the small blind**, acts first
//!   before the flop and last after it. A player who cannot cover a blind
//!   posts what they have and is all-in; the others still owe the FULL big
//!   blind to continue.
//! * **Order of action.** Preflop from the seat left of the big blind;
//!   postflop from the first live seat left of the button.
//! * **Bet sizing.** The minimum opening bet on any street is the big blind.
//!   A raise must raise by at least the largest full bet or raise of the
//!   street so far. An all-in for less is always allowed but is an
//!   *incomplete* raise: it does not change the minimum, and it does **not
//!   reopen the betting** to a player who has already acted — such a player
//!   may only call or fold unless the bet they now face has grown by at least
//!   one full raise since they last acted (several short all-ins can add up
//!   to that, and then it does reopen).
//! * **Pots.** Uncalled chips go back to the bettor first. The rest splits
//!   into a main pot and side pots by contribution level; a player is
//!   eligible for every level they matched. Chips from players who folded
//!   stay in whatever level they reached.
//! * **Showdown.** The last player to bet or raise on the river shows first;
//!   with no river bet, the first live player left of the button. Each
//!   player after that shows only a hand that beats or ties the best shown so
//!   far, and otherwise mucks — and a mucked hand is never revealed to
//!   anyone. When any live player is all-in, every live hand is tabled.
//!   After the hand anyone who was dealt in may still show voluntarily.
//! * **Split pots.** Equal shares; odd chips one at a time to the winners in
//!   seat order starting left of the button.
//! * **Turn clock.** The server times each decision; on expiry the player
//!   checks if that is free and otherwise folds. `timeouts_before_sit_out`
//!   expiries in a row sit the player out from the next hand.
//! * **Leaving.** Leaving mid-hand folds the player at once (their chips in
//!   the pot stay there) and frees the seat when the hand ends. A player who
//!   comes back gets the stack they left with, not a fresh one, so leaving is
//!   never a refill; a busted player gets a fresh stack only if
//!   `allow_rebuy`.
//!
//! The deck is dealt without burn cards: with a uniformly shuffled deck they
//! change nothing about the odds and only add a way to get dealing wrong.

use std::collections::HashMap;
use std::fmt;

use crate::cards::{full_deck, Card};
use crate::eval::{evaluate, HandValue};
use crate::rng::{shuffle, GameRng};
use crate::{PlayerId, TurnRef};

#[cfg(test)]
mod tests;

/// Seats a table may be configured with. Six is the default because six is
/// what fits a phone (docs/GAMES.md, *Mobile*).
pub const MAX_SEATS_LIMIT: usize = 9;
/// Stacks are capped so no sum of stacks and pots can approach `u64::MAX`.
pub const MAX_STARTING_STACK: u64 = 1_000_000_000;
pub const MIN_TURN_CLOCK_SECS: u32 = 5;
pub const MAX_TURN_CLOCK_SECS: u32 = 300;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldemConfig {
    /// 2..=9.
    pub max_seats: usize,
    pub starting_stack: u64,
    pub small_blind: u64,
    pub big_blind: u64,
    /// The decision clock the SERVER runs; the engine only reports it.
    pub turn_clock_secs: u32,
    /// Clock expiries in a row before a player is sat out.
    pub timeouts_before_sit_out: u8,
    /// Whether a busted player may take a fresh starting stack.
    pub allow_rebuy: bool,
}

impl Default for HoldemConfig {
    fn default() -> Self {
        HoldemConfig {
            max_seats: 6,
            starting_stack: 1_000,
            small_blind: 5,
            big_blind: 10,
            turn_clock_secs: 30,
            timeouts_before_sit_out: 2,
            allow_rebuy: true,
        }
    }
}

impl HoldemConfig {
    pub fn validate(&self) -> Result<(), HoldemError> {
        use HoldemError::InvalidConfig as E;
        if !(2..=MAX_SEATS_LIMIT).contains(&self.max_seats) {
            return Err(E("max_seats must be between 2 and 9"));
        }
        if self.small_blind == 0 {
            return Err(E("the small blind must be at least 1"));
        }
        if self.big_blind < self.small_blind {
            return Err(E("the big blind must be at least the small blind"));
        }
        if self.starting_stack < self.big_blind {
            return Err(E("the starting stack must cover the big blind"));
        }
        if self.starting_stack > MAX_STARTING_STACK {
            return Err(E("the starting stack is too large"));
        }
        if !(MIN_TURN_CLOCK_SECS..=MAX_TURN_CLOCK_SECS).contains(&self.turn_clock_secs) {
            return Err(E("the turn clock must be between 5 and 300 seconds"));
        }
        if self.timeouts_before_sit_out == 0 {
            return Err(E("timeouts_before_sit_out must be at least 1"));
        }
        Ok(())
    }
}

/// What a player asks to do. Amounts are TOTALS for the street ("raise to
/// 60"), never increments, so a retransmitted action cannot double-count.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Fold,
    Check,
    Call,
    /// Bet (nothing to call yet) or raise, to this street total.
    BetOrRaiseTo(u64),
    /// Everything: a call if the stack does not exceed the call, else a raise
    /// (allowed below the minimum, as an incomplete raise).
    AllIn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Street {
    Preflop,
    Flop,
    Turn,
    River,
    Showdown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActedKind {
    Fold,
    Check,
    Call,
    Bet,
    Raise,
}

/// Why an action happened — the UI says "timed out" or "left" rather than
/// pretending the player chose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActReason {
    Player,
    Timeout,
    Left,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SitOutReason {
    Requested,
    Timeouts,
    Busted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeatStatus {
    /// Seated, not in the current hand (joined mid-hand, or between hands).
    Waiting,
    SittingOut,
    InHand,
    Folded,
    AllIn,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShownHand {
    pub seat: usize,
    pub cards: [Card; 2],
    pub value: HandValue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PotShare {
    pub seat: usize,
    pub amount: u64,
}

/// Something that happened. Every event is PUBLIC: it may be sent to every
/// connection at the table. No event carries a hole card except `Showdown`
/// and `Shown`, which reveal exactly the hands that were shown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    PlayerSat { seat: usize, player: PlayerId, stack: u64 },
    /// The seat is now empty and `stack` left the table with the player.
    PlayerLeft { seat: usize, player: PlayerId, stack: u64 },
    SatOut { seat: usize, reason: SitOutReason },
    SatIn { seat: usize },
    Rebought { seat: usize, stack: u64 },
    HandStarted { hand_no: u64, button: usize, small_blind: Option<usize>, big_blind: usize, dealt: Vec<usize> },
    BlindPosted { seat: usize, amount: u64, all_in: bool },
    Acted { seat: usize, kind: ActedKind, added: u64, street_commit: u64, all_in: bool, reason: ActReason },
    BoardDealt { street: Street, cards: Vec<Card> },
    UncalledReturned { seat: usize, amount: u64 },
    /// `shown` in showdown order; `mucked` seats are never revealed.
    Showdown { shown: Vec<ShownHand>, mucked: Vec<usize> },
    /// Pot 0 is the main pot. `eligible` in seat order; `shares` in odd-chip
    /// order (clockwise from the button).
    PotAwarded { pot: usize, amount: u64, eligible: Vec<usize>, shares: Vec<PotShare> },
    Shown { seat: usize, cards: [Card; 2] },
    HandEnded { hand_no: u64 },
}

/// What the player to act may do right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LegalActions {
    pub to_call: u64,
    pub can_check: bool,
    /// What a Call actually puts in (less than `to_call` when it is all-in).
    pub call_amount: u64,
    /// False when the stack only covers a call, or when an incomplete raise
    /// did not reopen the betting for this player.
    pub can_raise: bool,
    /// Smallest legal `BetOrRaiseTo` (the all-in total when that is less).
    pub min_raise_to: u64,
    /// The all-in total.
    pub max_raise_to: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeatView {
    pub seat: usize,
    pub player: PlayerId,
    pub stack: u64,
    pub status: SeatStatus,
    pub street_commit: u64,
    pub hand_commit: u64,
    /// Hole cards — only when this hand was shown.
    pub shown: Option<[Card; 2]>,
    pub sitting_out: bool,
    pub leaving: bool,
}

/// The table as one viewer may see it. Build it per connection with
/// [`HoldemTable::view_for`]; `viewer: None` is a spectator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoldemView {
    pub viewer: Option<usize>,
    pub config: HoldemConfig,
    /// 0 before the first hand.
    pub hand_no: u64,
    pub in_hand: bool,
    pub street: Option<Street>,
    pub button: Option<usize>,
    pub small_blind_seat: Option<usize>,
    pub big_blind_seat: Option<usize>,
    pub seats: Vec<Option<SeatView>>,
    pub board: Vec<Card>,
    pub pot_total: u64,
    pub current_bet: u64,
    pub to_act: Option<usize>,
    pub turn: Option<TurnRef>,
    /// The viewer's own hole cards, and nobody else's.
    pub my_cards: Option<[Card; 2]>,
    pub legal: Option<LegalActions>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HoldemError {
    InvalidConfig(&'static str),
    /// The configuration is fixed once the first hand is dealt.
    ConfigLocked,
    SeatOutOfRange,
    SeatTaken,
    SeatEmpty,
    AlreadySeated,
    HandInProgress,
    NoHandInProgress,
    NotEnoughPlayers,
    NotYourTurn,
    /// The `TurnRef` names a decision that is no longer current.
    StaleTurn,
    CannotCheck { to_call: u64 },
    NothingToCall,
    BetBelowMinimum { min_to: u64 },
    BetAboveStack { max_to: u64 },
    /// Facing only an incomplete raise after having acted: call or fold.
    RaiseNotReopened,
    NoChips,
    NotBusted,
    RebuyNotAllowed,
    NotShowable,
}

impl fmt::Display for HoldemError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HoldemError::InvalidConfig(why) => write!(f, "invalid table settings: {why}"),
            HoldemError::ConfigLocked => write!(f, "the table settings cannot change after the first hand"),
            HoldemError::SeatOutOfRange => write!(f, "no such seat"),
            HoldemError::SeatTaken => write!(f, "that seat is taken"),
            HoldemError::SeatEmpty => write!(f, "that seat is empty"),
            HoldemError::AlreadySeated => write!(f, "already seated at this table"),
            HoldemError::HandInProgress => write!(f, "a hand is in progress"),
            HoldemError::NoHandInProgress => write!(f, "no hand is in progress"),
            HoldemError::NotEnoughPlayers => write!(f, "at least two players with chips are needed"),
            HoldemError::NotYourTurn => write!(f, "it is not your turn"),
            HoldemError::StaleTurn => write!(f, "that turn has already passed"),
            HoldemError::CannotCheck { to_call } => write!(f, "cannot check: {to_call} to call"),
            HoldemError::NothingToCall => write!(f, "there is nothing to call"),
            HoldemError::BetBelowMinimum { min_to } => write!(f, "the minimum is {min_to}"),
            HoldemError::BetAboveStack { max_to } => write!(f, "the most you can bet is {max_to}"),
            HoldemError::RaiseNotReopened => write!(f, "the betting was not reopened: call or fold"),
            HoldemError::NoChips => write!(f, "no chips"),
            HoldemError::NotBusted => write!(f, "only a player with no chips can rebuy"),
            HoldemError::RebuyNotAllowed => write!(f, "this table does not allow rebuys"),
            HoldemError::NotShowable => write!(f, "there is no hand to show"),
        }
    }
}

impl std::error::Error for HoldemError {}

// ---------------------------------------------------------------------------
// Internal state

#[derive(Clone)]
struct SeatState {
    player: PlayerId,
    stack: u64,
    sitting_out: bool,
    /// Left mid-hand: folded, and the seat goes when the hand ends.
    leaving: bool,
    timeouts: u8,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PStatus {
    Active,
    Folded,
    AllIn,
}

#[derive(Clone)]
struct HandSeat {
    /// Who was dealt this hand — a later occupant of the seat is NOT them.
    player: PlayerId,
    hole: [Card; 2],
    status: PStatus,
    street_commit: u64,
    hand_commit: u64,
    acted: bool,
    /// The current bet when this player last acted (the reopen rule).
    faced: u64,
    shown: bool,
}

#[derive(Clone)]
struct Hand {
    hand_no: u64,
    button: usize,
    sb: usize,
    bb: usize,
    deck: Vec<Card>,
    next_card: usize,
    board: Vec<Card>,
    street: Street,
    players: Vec<Option<HandSeat>>,
    current_bet: u64,
    /// The size of the largest full bet/raise this street: the min-raise.
    last_full_raise: u64,
    to_act: Option<usize>,
    turn_seq: u64,
    /// Last seat to bet or raise on the current street.
    aggressor: Option<usize>,
    complete: bool,
}

impl Hand {
    fn live(&self) -> Vec<usize> {
        (0..self.players.len())
            .filter(|&i| matches!(&self.players[i], Some(h) if h.status != PStatus::Folded))
            .collect()
    }

    fn next_to_act(&self, after: usize) -> Option<usize> {
        let n = self.players.len();
        let actionable: Vec<usize> = (0..n)
            .filter(|&i| matches!(&self.players[i], Some(h) if h.status == PStatus::Active))
            .collect();
        match actionable.as_slice() {
            [] => return None,
            // One player with chips and nothing to call: nobody can respond to
            // a bet, so there is no betting — run the board out.
            [only] if self.players[*only].as_ref().unwrap().street_commit >= self.current_bet => return None,
            _ => {}
        }
        (1..=n).map(|k| (after + k) % n).find(|&i| {
            matches!(&self.players[i], Some(h)
                if h.status == PStatus::Active && (!h.acted || h.street_commit < self.current_bet))
        })
    }

    /// Seats in clockwise order starting at `from` (inclusive).
    fn clockwise_from(&self, from: usize, seats: &[usize]) -> Vec<usize> {
        let n = self.players.len();
        let mut v = seats.to_vec();
        v.sort_by_key(|&s| (s + n - from) % n);
        v
    }
}

struct Pot {
    amount: u64,
    eligible: Vec<usize>,
}

/// Main pot and side pots from each seat's total contribution.
/// `contrib` is (seat, amount, folded).
fn build_pots(contrib: &[(usize, u64, bool)]) -> Vec<Pot> {
    let mut levels: Vec<u64> = contrib.iter().filter(|c| !c.2 && c.1 > 0).map(|c| c.1).collect();
    levels.sort_unstable();
    levels.dedup();
    let mut pots: Vec<Pot> = Vec::new();
    let mut prev = 0;
    for level in levels {
        let amount: u64 = contrib.iter().map(|c| c.1.min(level) - c.1.min(prev)).sum();
        let eligible: Vec<usize> = contrib.iter().filter(|c| !c.2 && c.1 >= level).map(|c| c.0).collect();
        if amount > 0 {
            pots.push(Pot { amount, eligible });
        }
        prev = level;
    }
    // Chips above the highest live level can only come from a player who
    // folded after putting them in (one who left mid-hand). Dead money: it
    // joins the top pot rather than vanishing.
    let rest: u64 = contrib.iter().map(|c| c.1 - c.1.min(prev)).sum();
    if rest > 0 {
        match pots.last_mut() {
            Some(top) => top.amount += rest,
            None => pots.push(Pot { amount: rest, eligible: contrib.iter().filter(|c| !c.2).map(|c| c.0).collect() }),
        }
    }
    pots
}

/// A No-Limit Hold'em table. All state is in memory; every method is
/// synchronous and pure apart from `&mut self`.
pub struct HoldemTable {
    config: HoldemConfig,
    seats: Vec<Option<SeatState>>,
    /// The current hand, or the last completed one (kept so its board and
    /// shown cards stay visible until the next deal).
    hand: Option<Hand>,
    hands_dealt: u64,
    button: Option<usize>,
    /// Stacks of players who left, for when they sit back down.
    departed: HashMap<PlayerId, u64>,
}

/// Redacted: a table's Debug output never contains a card, so logging a
/// table cannot leak the deck or anyone's hand.
impl fmt::Debug for HoldemTable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HoldemTable")
            .field("hand_no", &self.hand.as_ref().map_or(0, |h| h.hand_no))
            .field("in_hand", &self.hand_in_progress())
            .field("seated", &self.seats.iter().flatten().count())
            .finish_non_exhaustive()
    }
}

impl HoldemTable {
    pub fn new(config: HoldemConfig) -> Result<Self, HoldemError> {
        config.validate()?;
        Ok(HoldemTable {
            seats: vec![None; config.max_seats],
            config,
            hand: None,
            hands_dealt: 0,
            button: None,
            departed: HashMap::new(),
        })
    }

    pub fn config(&self) -> &HoldemConfig {
        &self.config
    }

    /// Change the settings — only before the first hand (the opener sets the
    /// stack and blinds, then play starts). Seated players get the new stack.
    pub fn configure(&mut self, config: HoldemConfig) -> Result<Vec<Event>, HoldemError> {
        if self.hands_dealt > 0 {
            return Err(HoldemError::ConfigLocked);
        }
        config.validate()?;
        if self.seats.iter().enumerate().any(|(i, s)| s.is_some() && i >= config.max_seats) {
            return Err(HoldemError::InvalidConfig("an occupied seat is beyond the new seat count"));
        }
        self.seats.resize(config.max_seats, None);
        for s in self.seats.iter_mut().flatten() {
            s.stack = config.starting_stack;
        }
        self.departed.clear();
        self.config = config;
        Ok(Vec::new())
    }

    fn occupant(&self, seat: usize) -> Result<&SeatState, HoldemError> {
        self.seats.get(seat).ok_or(HoldemError::SeatOutOfRange)?.as_ref().ok_or(HoldemError::SeatEmpty)
    }

    /// The seat's entry in the LIVE hand, if the current occupant was dealt in.
    fn live_hand_seat(&self, seat: usize) -> Option<&HandSeat> {
        let occ = self.seats.get(seat)?.as_ref()?;
        let hand = self.hand.as_ref().filter(|h| !h.complete)?;
        hand.players.get(seat)?.as_ref().filter(|hs| hs.player == occ.player)
    }

    /// The seat's entry in the current or last hand, if the CURRENT occupant
    /// is the player who was dealt it.
    fn own_hand_seat(&self, seat: usize) -> Option<&HandSeat> {
        let occ = self.seats.get(seat)?.as_ref()?;
        self.hand.as_ref()?.players.get(seat)?.as_ref().filter(|hs| hs.player == occ.player)
    }

    pub fn sit(&mut self, seat: usize, player: PlayerId) -> Result<Vec<Event>, HoldemError> {
        if seat >= self.config.max_seats {
            return Err(HoldemError::SeatOutOfRange);
        }
        if self.seats[seat].is_some() {
            return Err(HoldemError::SeatTaken);
        }
        if self.seat_of(player).is_some() {
            return Err(HoldemError::AlreadySeated);
        }
        let stack = match self.departed.get(&player) {
            Some(0) if self.config.allow_rebuy => self.config.starting_stack,
            Some(0) => return Err(HoldemError::NoChips),
            Some(&s) => s,
            None => self.config.starting_stack,
        };
        self.departed.remove(&player);
        self.seats[seat] = Some(SeatState { player, stack, sitting_out: false, leaving: false, timeouts: 0 });
        Ok(vec![Event::PlayerSat { seat, player, stack }])
    }

    /// Stand up. Mid-hand this folds the player now and frees the seat when
    /// the hand ends; otherwise the seat is freed at once.
    pub fn leave(&mut self, seat: usize) -> Result<Vec<Event>, HoldemError> {
        let occ = self.occupant(seat)?.clone();
        let mut ev = Vec::new();
        if let Some(hs) = self.live_hand_seat(seat) {
            let still_live = hs.status != PStatus::Folded;
            self.seats[seat].as_mut().unwrap().leaving = true;
            if still_live {
                let hand = self.hand.as_mut().unwrap();
                let was_turn = hand.to_act == Some(seat);
                let hs = hand.players[seat].as_mut().unwrap();
                hs.status = PStatus::Folded;
                hs.acted = true;
                ev.push(Event::Acted {
                    seat,
                    kind: ActedKind::Fold,
                    added: 0,
                    street_commit: hs.street_commit,
                    all_in: false,
                    reason: ActReason::Left,
                });
                if was_turn {
                    self.progress(&mut ev, seat);
                } else if hand.live().len() == 1 {
                    self.finish_uncontested(&mut ev);
                }
            }
            return Ok(ev);
        }
        self.seats[seat] = None;
        self.departed.insert(occ.player, occ.stack);
        ev.push(Event::PlayerLeft { seat, player: occ.player, stack: occ.stack });
        Ok(ev)
    }

    /// Sit out from the next hand on (the current hand plays on).
    pub fn sit_out(&mut self, seat: usize) -> Result<Vec<Event>, HoldemError> {
        self.occupant(seat)?;
        let s = self.seats[seat].as_mut().unwrap();
        if s.sitting_out {
            return Ok(Vec::new());
        }
        s.sitting_out = true;
        Ok(vec![Event::SatOut { seat, reason: SitOutReason::Requested }])
    }

    pub fn sit_in(&mut self, seat: usize) -> Result<Vec<Event>, HoldemError> {
        if self.occupant(seat)?.stack == 0 {
            return Err(HoldemError::NoChips);
        }
        let s = self.seats[seat].as_mut().unwrap();
        s.timeouts = 0;
        if !s.sitting_out {
            return Ok(Vec::new());
        }
        s.sitting_out = false;
        Ok(vec![Event::SatIn { seat }])
    }

    /// A fresh starting stack for a player with none (if the table allows).
    pub fn rebuy(&mut self, seat: usize) -> Result<Vec<Event>, HoldemError> {
        if self.occupant(seat)?.stack > 0 {
            return Err(HoldemError::NotBusted);
        }
        if !self.config.allow_rebuy {
            return Err(HoldemError::RebuyNotAllowed);
        }
        if self.live_hand_seat(seat).is_some_and(|hs| hs.status != PStatus::Folded) {
            // All-in in the live hand: wait for it to settle.
            return Err(HoldemError::HandInProgress);
        }
        let stack = self.config.starting_stack;
        let s = self.seats[seat].as_mut().unwrap();
        s.stack = stack;
        s.sitting_out = false;
        s.timeouts = 0;
        Ok(vec![Event::Rebought { seat, stack }])
    }

    fn dealable(&self, seat: usize) -> bool {
        matches!(&self.seats[seat], Some(s) if !s.sitting_out && !s.leaving && s.stack > 0)
    }

    fn check_can_start(&self) -> Result<Vec<usize>, HoldemError> {
        if self.hand_in_progress() {
            return Err(HoldemError::HandInProgress);
        }
        let eligible: Vec<usize> = (0..self.config.max_seats).filter(|&i| self.dealable(i)).collect();
        if eligible.len() < 2 {
            return Err(HoldemError::NotEnoughPlayers);
        }
        Ok(eligible)
    }

    /// Shuffle with `rng` and deal the next hand.
    pub fn start_hand<R: GameRng + ?Sized>(&mut self, rng: &mut R) -> Result<Vec<Event>, HoldemError> {
        self.check_can_start()?;
        let mut deck = full_deck();
        shuffle(&mut deck, rng);
        self.begin_hand(deck)
    }

    /// Deals from `deck` in a fixed order: two hole cards to each dealt seat
    /// in ascending seat order, then the five board cards. With a shuffled
    /// deck the order is irrelevant; it is fixed so tests can stack a deck.
    fn begin_hand(&mut self, deck: Vec<Card>) -> Result<Vec<Event>, HoldemError> {
        let eligible = self.check_can_start()?;
        debug_assert_eq!(deck.len(), 52);
        let next_after = |from: usize| *eligible.iter().find(|&&s| s > from).unwrap_or(&eligible[0]);
        let button = match self.button {
            None => eligible[0],
            Some(b) => next_after(b),
        };
        let (sb, bb) = if eligible.len() == 2 {
            (button, next_after(button))
        } else {
            let sb = next_after(button);
            (sb, next_after(sb))
        };
        self.button = Some(button);
        self.hands_dealt += 1;
        let hand_no = self.hands_dealt;
        let mut players = vec![None; self.config.max_seats];
        let mut k = 0;
        for &i in &eligible {
            players[i] = Some(HandSeat {
                player: self.seats[i].as_ref().unwrap().player,
                hole: [deck[k], deck[k + 1]],
                status: PStatus::Active,
                street_commit: 0,
                hand_commit: 0,
                acted: false,
                faced: 0,
                shown: false,
            });
            k += 2;
        }
        self.hand = Some(Hand {
            hand_no,
            button,
            sb,
            bb,
            deck,
            next_card: k,
            board: Vec::new(),
            street: Street::Preflop,
            players,
            current_bet: 0,
            last_full_raise: self.config.big_blind,
            to_act: None,
            turn_seq: 0,
            aggressor: None,
            complete: false,
        });
        let mut ev = vec![Event::HandStarted { hand_no, button, small_blind: Some(sb), big_blind: bb, dealt: eligible }];
        self.post_blind(sb, self.config.small_blind, &mut ev);
        self.post_blind(bb, self.config.big_blind, &mut ev);
        // Everyone owes the FULL big blind even if the big blind is short.
        self.hand.as_mut().unwrap().current_bet = self.config.big_blind;
        self.progress(&mut ev, bb);
        Ok(ev)
    }

    fn post_blind(&mut self, seat: usize, amount: u64, ev: &mut Vec<Event>) {
        let s = self.seats[seat].as_mut().unwrap();
        let hs = self.hand.as_mut().unwrap().players[seat].as_mut().unwrap();
        let pay = amount.min(s.stack);
        s.stack -= pay;
        hs.street_commit += pay;
        hs.hand_commit += pay;
        let all_in = s.stack == 0;
        if all_in {
            hs.status = PStatus::AllIn;
        }
        ev.push(Event::BlindPosted { seat, amount: pay, all_in });
    }

    /// After an action by `last`: hand the turn on, or close the street and
    /// deal the next, or settle.
    fn progress(&mut self, ev: &mut Vec<Event>, mut last: usize) {
        loop {
            let hand = self.hand.as_mut().unwrap();
            if hand.live().len() == 1 {
                self.finish_uncontested(ev);
                return;
            }
            if let Some(next) = hand.next_to_act(last) {
                hand.to_act = Some(next);
                hand.turn_seq += 1;
                return;
            }
            let (street, count) = match hand.street {
                Street::Preflop => (Street::Flop, 3),
                Street::Flop => (Street::Turn, 1),
                Street::Turn => (Street::River, 1),
                Street::River | Street::Showdown => {
                    self.showdown(ev);
                    return;
                }
            };
            for hs in hand.players.iter_mut().flatten() {
                hs.street_commit = 0;
                hs.acted = false;
                hs.faced = 0;
            }
            hand.current_bet = 0;
            hand.last_full_raise = self.config.big_blind;
            hand.aggressor = None;
            hand.to_act = None;
            hand.street = street;
            let cards = hand.deck[hand.next_card..hand.next_card + count].to_vec();
            hand.next_card += count;
            hand.board.extend_from_slice(&cards);
            ev.push(Event::BoardDealt { street, cards });
            last = hand.button;
        }
    }

    /// The highest live contributor gets back whatever nobody matched.
    fn return_uncalled(&mut self, ev: &mut Vec<Event>) {
        let hand = self.hand.as_mut().unwrap();
        let live = hand.live();
        let Some(&top) = live.iter().max_by_key(|&&s| hand.players[s].as_ref().unwrap().hand_commit) else {
            return;
        };
        let top_amount = hand.players[top].as_ref().unwrap().hand_commit;
        let second = (0..hand.players.len())
            .filter(|&s| s != top)
            .filter_map(|s| hand.players[s].as_ref().map(|h| h.hand_commit))
            .max()
            .unwrap_or(0);
        if top_amount > second {
            let amount = top_amount - second;
            let hs = hand.players[top].as_mut().unwrap();
            hs.hand_commit -= amount;
            hs.street_commit = hs.street_commit.saturating_sub(amount);
            self.seats[top].as_mut().unwrap().stack += amount;
            ev.push(Event::UncalledReturned { seat: top, amount });
        }
    }

    fn finish_uncontested(&mut self, ev: &mut Vec<Event>) {
        self.return_uncalled(ev);
        let hand = self.hand.as_mut().unwrap();
        let winner = hand.live()[0];
        let amount: u64 = hand.players.iter().flatten().map(|h| h.hand_commit).sum();
        self.seats[winner].as_mut().unwrap().stack += amount;
        ev.push(Event::PotAwarded {
            pot: 0,
            amount,
            eligible: vec![winner],
            shares: vec![PotShare { seat: winner, amount }],
        });
        self.end_hand(ev);
    }

    fn showdown(&mut self, ev: &mut Vec<Event>) {
        self.return_uncalled(ev);
        let hand = self.hand.as_mut().unwrap();
        hand.street = Street::Showdown;
        hand.to_act = None;
        let n = hand.players.len();
        let live = hand.live();
        let mut values: Vec<Option<HandValue>> = vec![None; n];
        for &s in &live {
            let hs = hand.players[s].as_ref().unwrap();
            let mut seven = hand.board.clone();
            seven.extend_from_slice(&hs.hole);
            values[s] = Some(evaluate(&seven));
        }
        let all_in = live.iter().any(|&s| hand.players[s].as_ref().unwrap().status == PStatus::AllIn);
        let first_left_of_button = hand.clockwise_from((hand.button + 1) % n, &live)[0];
        let start = hand.aggressor.filter(|a| live.contains(a)).unwrap_or(first_left_of_button);
        let order = hand.clockwise_from(start, &live);
        let mut shown = Vec::new();
        let mut mucked = Vec::new();
        let mut best: Option<HandValue> = None;
        for &s in &order {
            let v = values[s].unwrap();
            if all_in || best.is_none_or(|b| v >= b) {
                best = Some(best.map_or(v, |b| b.max(v)));
                hand.players[s].as_mut().unwrap().shown = true;
                shown.push(ShownHand { seat: s, cards: hand.players[s].as_ref().unwrap().hole, value: v });
            } else {
                mucked.push(s);
            }
        }
        let shown_seats: Vec<usize> = shown.iter().map(|h| h.seat).collect();
        ev.push(Event::Showdown { shown, mucked });

        let contrib: Vec<(usize, u64, bool)> = (0..n)
            .filter_map(|s| hand.players[s].as_ref().map(|h| (s, h.hand_commit, h.status == PStatus::Folded)))
            .collect();
        for (idx, pot) in build_pots(&contrib).into_iter().enumerate() {
            let mut contenders: Vec<usize> = pot.eligible.iter().copied().filter(|s| shown_seats.contains(s)).collect();
            if contenders.is_empty() {
                // Cannot happen (the best shown hand is eligible for every
                // pot it matched), but chips must never be stranded.
                contenders = shown_seats.clone();
            }
            let top = contenders.iter().map(|&s| values[s].unwrap()).max().unwrap();
            let winners = hand.clockwise_from(
                (hand.button + 1) % n,
                &contenders.iter().copied().filter(|&s| values[s] == Some(top)).collect::<Vec<_>>(),
            );
            let k = winners.len() as u64;
            let (share, mut odd) = (pot.amount / k, pot.amount % k);
            let mut shares = Vec::with_capacity(winners.len());
            for w in winners {
                let extra = u64::from(odd > 0);
                odd -= extra;
                let amount = share + extra;
                self.seats[w].as_mut().unwrap().stack += amount;
                shares.push(PotShare { seat: w, amount });
            }
            ev.push(Event::PotAwarded { pot: idx, amount: pot.amount, eligible: pot.eligible, shares });
        }
        self.end_hand(ev);
    }

    fn end_hand(&mut self, ev: &mut Vec<Event>) {
        let hand = self.hand.as_mut().unwrap();
        hand.complete = true;
        hand.to_act = None;
        ev.push(Event::HandEnded { hand_no: hand.hand_no });
        for seat in 0..self.seats.len() {
            let Some(s) = self.seats[seat].as_mut() else { continue };
            if s.leaving {
                let s = self.seats[seat].take().unwrap();
                self.departed.insert(s.player, s.stack);
                ev.push(Event::PlayerLeft { seat, player: s.player, stack: s.stack });
            } else if s.stack == 0 && !s.sitting_out {
                s.sitting_out = true;
                ev.push(Event::SatOut { seat, reason: SitOutReason::Busted });
            }
        }
    }

    /// Validates `action` for the seat to act and applies it. Refuses without
    /// changing anything.
    fn apply(&mut self, seat: usize, action: Action, reason: ActReason, ev: &mut Vec<Event>) -> Result<(), HoldemError> {
        let big_blind = self.config.big_blind;
        let st = self.seats[seat].as_mut().unwrap();
        let hand = self.hand.as_mut().unwrap();
        let current = hand.current_bet;
        let full_raise = hand.last_full_raise;
        let hs = hand.players[seat].as_mut().unwrap();
        let to_call = current.saturating_sub(hs.street_commit);
        let max_to = hs.street_commit + st.stack;
        let reopened = !hs.acted || current.saturating_sub(hs.faced) >= full_raise;

        enum Resolved {
            Fold,
            Check,
            Call,
            RaiseTo(u64),
        }
        let check_raise = |to: u64| -> Result<Resolved, HoldemError> {
            if !reopened {
                return Err(HoldemError::RaiseNotReopened);
            }
            if max_to <= current || to > max_to {
                return Err(HoldemError::BetAboveStack { max_to });
            }
            let min_to = if current == 0 { big_blind } else { current + full_raise };
            if to <= current || (to < min_to && to != max_to) {
                return Err(HoldemError::BetBelowMinimum { min_to: min_to.min(max_to) });
            }
            Ok(Resolved::RaiseTo(to))
        };
        let resolved = match action {
            Action::Fold => Resolved::Fold,
            Action::Check if to_call > 0 => return Err(HoldemError::CannotCheck { to_call }),
            Action::Check => Resolved::Check,
            Action::Call if to_call == 0 => return Err(HoldemError::NothingToCall),
            Action::Call => Resolved::Call,
            Action::AllIn if max_to <= current => Resolved::Call,
            Action::AllIn => check_raise(max_to)?,
            Action::BetOrRaiseTo(to) => check_raise(to)?,
        };

        // Validated: from here on nothing can fail.
        let (kind, pay) = match resolved {
            Resolved::Fold => {
                hs.status = PStatus::Folded;
                (ActedKind::Fold, 0)
            }
            Resolved::Check => (ActedKind::Check, 0),
            Resolved::Call => (ActedKind::Call, to_call.min(st.stack)),
            Resolved::RaiseTo(to) => {
                let kind = if current == 0 { ActedKind::Bet } else { ActedKind::Raise };
                if to - current >= full_raise {
                    hand.last_full_raise = to - current;
                }
                hand.current_bet = to;
                hand.aggressor = Some(seat);
                (kind, to - hs.street_commit)
            }
        };
        st.stack -= pay;
        hs.street_commit += pay;
        hs.hand_commit += pay;
        let all_in = st.stack == 0 && hs.status != PStatus::Folded;
        if all_in {
            hs.status = PStatus::AllIn;
        }
        hs.acted = true;
        hs.faced = hand.current_bet;
        ev.push(Event::Acted { seat, kind, added: pay, street_commit: hs.street_commit, all_in, reason });
        Ok(())
    }

    /// The player to act acts. `turn` must be the current [`Self::turn`].
    pub fn act(&mut self, seat: usize, turn: TurnRef, action: Action) -> Result<Vec<Event>, HoldemError> {
        let hand = self.hand.as_ref().filter(|h| !h.complete).ok_or(HoldemError::NoHandInProgress)?;
        if hand.to_act != Some(seat) {
            return Err(HoldemError::NotYourTurn);
        }
        if hand.hand_no != turn.hand_no || hand.turn_seq != turn.turn_seq {
            return Err(HoldemError::StaleTurn);
        }
        let mut ev = Vec::new();
        self.apply(seat, action, ActReason::Player, &mut ev)?;
        self.seats[seat].as_mut().unwrap().timeouts = 0;
        self.progress(&mut ev, seat);
        Ok(ev)
    }

    /// The turn clock for `turn` expired: check if free, else fold. A timer
    /// for any turn but the current one is refused (`StaleTurn`) and changes
    /// nothing, so the server never has to cancel timers precisely.
    pub fn timeout(&mut self, turn: TurnRef) -> Result<Vec<Event>, HoldemError> {
        if self.turn() != Some(turn) {
            return Err(HoldemError::StaleTurn);
        }
        let hand = self.hand.as_ref().unwrap();
        let seat = hand.to_act.unwrap();
        let hs = hand.players[seat].as_ref().unwrap();
        let action = if hs.street_commit >= hand.current_bet { Action::Check } else { Action::Fold };
        let mut ev = Vec::new();
        self.apply(seat, action, ActReason::Timeout, &mut ev)?;
        let limit = self.config.timeouts_before_sit_out;
        let s = self.seats[seat].as_mut().unwrap();
        s.timeouts = s.timeouts.saturating_add(1);
        if s.timeouts >= limit && !s.sitting_out {
            s.sitting_out = true;
            ev.push(Event::SatOut { seat, reason: SitOutReason::Timeouts });
        }
        self.progress(&mut ev, seat);
        Ok(ev)
    }

    /// After a hand, a player who was dealt in may table their cards.
    pub fn show_cards(&mut self, seat: usize) -> Result<Vec<Event>, HoldemError> {
        if self.hand_in_progress() || self.own_hand_seat(seat).is_none_or(|hs| hs.shown) {
            return Err(HoldemError::NotShowable);
        }
        let hs = self.hand.as_mut().unwrap().players[seat].as_mut().unwrap();
        hs.shown = true;
        Ok(vec![Event::Shown { seat, cards: hs.hole }])
    }

    pub fn hand_in_progress(&self) -> bool {
        self.hand.as_ref().is_some_and(|h| !h.complete)
    }

    /// The decision currently awaited, for the server's turn clock.
    pub fn turn(&self) -> Option<TurnRef> {
        let h = self.hand.as_ref().filter(|h| !h.complete)?;
        h.to_act.map(|_| TurnRef { hand_no: h.hand_no, turn_seq: h.turn_seq })
    }

    pub fn to_act(&self) -> Option<usize> {
        self.hand.as_ref().filter(|h| !h.complete)?.to_act
    }

    pub fn seat_of(&self, player: PlayerId) -> Option<usize> {
        self.seats.iter().position(|s| s.as_ref().is_some_and(|s| s.player == player))
    }

    /// What `seat` may do — `None` unless it is that seat's turn.
    pub fn legal_actions(&self, seat: usize) -> Option<LegalActions> {
        let hand = self.hand.as_ref().filter(|h| !h.complete && h.to_act == Some(seat))?;
        let hs = hand.players[seat].as_ref()?;
        let stack = self.seats[seat].as_ref()?.stack;
        let to_call = hand.current_bet.saturating_sub(hs.street_commit);
        let max_to = hs.street_commit + stack;
        let reopened = !hs.acted || hand.current_bet.saturating_sub(hs.faced) >= hand.last_full_raise;
        let min_to = if hand.current_bet == 0 {
            self.config.big_blind
        } else {
            hand.current_bet + hand.last_full_raise
        };
        Some(LegalActions {
            to_call,
            can_check: to_call == 0,
            call_amount: to_call.min(stack),
            can_raise: reopened && max_to > hand.current_bet,
            min_raise_to: min_to.min(max_to),
            max_raise_to: max_to,
        })
    }

    /// The table as `viewer` may see it (`None`: a spectator). This is the
    /// ONLY way hidden cards leave the engine: the viewer's own hole cards,
    /// plus hands that were shown.
    pub fn view_for(&self, viewer: Option<usize>) -> HoldemView {
        let live = self.hand_in_progress();
        let hand = self.hand.as_ref();
        let seats = (0..self.seats.len())
            .map(|i| {
                let s = self.seats[i].as_ref()?;
                let hs = self.own_hand_seat(i);
                let status = match hs {
                    Some(hs) if live => match hs.status {
                        PStatus::Active => SeatStatus::InHand,
                        PStatus::Folded => SeatStatus::Folded,
                        PStatus::AllIn => SeatStatus::AllIn,
                    },
                    _ if s.sitting_out => SeatStatus::SittingOut,
                    _ => SeatStatus::Waiting,
                };
                Some(SeatView {
                    seat: i,
                    player: s.player,
                    stack: s.stack,
                    status,
                    street_commit: hs.filter(|_| live).map_or(0, |h| h.street_commit),
                    hand_commit: hs.filter(|_| live).map_or(0, |h| h.hand_commit),
                    shown: hs.filter(|h| h.shown).map(|h| h.hole),
                    sitting_out: s.sitting_out,
                    leaving: s.leaving,
                })
            })
            .collect();
        HoldemView {
            viewer,
            config: self.config.clone(),
            hand_no: hand.map_or(0, |h| h.hand_no),
            in_hand: live,
            street: hand.map(|h| h.street),
            button: hand.map(|h| h.button).or(self.button),
            small_blind_seat: hand.map(|h| h.sb),
            big_blind_seat: hand.map(|h| h.bb),
            seats,
            board: hand.map_or_else(Vec::new, |h| h.board.clone()),
            pot_total: if live { hand.unwrap().players.iter().flatten().map(|h| h.hand_commit).sum() } else { 0 },
            current_bet: if live { hand.unwrap().current_bet } else { 0 },
            to_act: self.to_act(),
            turn: self.turn(),
            my_cards: viewer.and_then(|v| self.own_hand_seat(v)).map(|h| h.hole),
            legal: viewer.and_then(|v| self.legal_actions(v)),
        }
    }

    #[cfg(test)]
    fn set_stack(&mut self, seat: usize, stack: u64) {
        self.seats[seat].as_mut().unwrap().stack = stack;
    }

    /// Deals the named hole cards (`(seat, "Ah Kd")`) and board; anything not
    /// named comes from the rest of the deck in index order.
    #[cfg(test)]
    fn start_hand_stacked(&mut self, holes: &[(usize, &str)], board: &str) -> Result<Vec<Event>, HoldemError> {
        use crate::cards::cards;
        let eligible = self.check_can_start()?;
        let named: Vec<Card> = holes.iter().flat_map(|(_, h)| cards(h)).chain(cards(board)).collect();
        let mut rest: Vec<Card> = full_deck().into_iter().filter(|c| !named.contains(c)).collect();
        let mut take = || rest.remove(0);
        let mut deck = Vec::with_capacity(52);
        for &i in &eligible {
            match holes.iter().find(|(s, _)| *s == i) {
                Some((_, h)) => deck.extend(cards(h)),
                None => deck.extend([take(), take()]),
            }
        }
        let b = cards(board);
        deck.extend(&b);
        for _ in b.len()..5 {
            deck.push(take());
        }
        deck.extend(rest);
        assert_eq!(deck.len(), 52, "stacked deck must be a full deck");
        self.begin_hand(deck)
    }
}
