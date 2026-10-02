//! Blackjack against the house: every seat plays the server-run dealer.
//!
//! RULES, as implemented (defaults; docs/GAMES.md lists which are
//! owner-changeable through [`BlackjackConfig`]):
//!
//! * A shoe of `decks` (6) decks, reshuffled when a round would START past
//!   the cut card (75% penetration) — never in the middle of a round. If a
//!   round ever empties the shoe, the discard tray (cards from earlier rounds,
//!   none of them in play) is shuffled back in, as a casino does.
//! * Deal: one card to each betting seat in seat order, the dealer's up card,
//!   a second card to each seat, the dealer's hole card face down.
//! * The dealer peeks under an ace or a ten-value up card. A dealer blackjack
//!   ends the round at once: player blackjacks push, everything else loses
//!   only the original bet (nobody has doubled or split yet). No insurance,
//!   no surrender.
//! * A player blackjack (ace + ten-value as the first two cards of an
//!   unsplit hand) is paid `blackjack_pays` (3:2) immediately. Payouts are
//!   whole chips: 3:2 on an odd bet rounds DOWN (15 pays 22).
//! * Hit, stand, double on any first two cards (one card, then done), split
//!   any two cards of equal value (10-J-Q-K count as equal) up to
//!   `max_hands` (4) hands, double after split (DAS) allowed. Split aces get
//!   exactly one card each and cannot be resplit; ace + ten after a split is
//!   21, paid 1:1, not a blackjack.
//! * A hand that reaches 21 is finished without asking; a bust loses at once,
//!   even if the dealer busts later.
//! * The dealer stands on soft 17 (S17); `dealer_hits_soft_17` makes it H17.
//!   When every player hand is already settled the dealer turns the hole
//!   card and draws nothing.
//! * Turn clock: on expiry the hand stands. Leaving mid-round stands every
//!   remaining hand; the bets still settle, and the seat is freed when the
//!   round ends.
//!
//! The only hidden information is the dealer's hole card and the shoe's
//! order. Player cards are dealt face up, so the one [`BlackjackTable::view`]
//! is the same for every viewer and never holds the hole card before the
//! dealer turns it.

use std::collections::HashMap;
use std::fmt;

use crate::cards::{full_deck, Card, Rank};
use crate::rng::{shuffle, GameRng};
use crate::{PlayerId, TurnRef};

#[cfg(test)]
mod tests;

/// Seats a table may be configured with ("spots" at a casino table).
pub const MAX_SEATS_LIMIT: usize = 7;
pub const MAX_STARTING_STACK: u64 = 1_000_000_000;
/// The most hands one seat can split into.
pub const MAX_HANDS_LIMIT: u8 = 4;
/// Largest denominator `blackjack_pays` may use (3:2 is (3, 2), 6:5 is (6, 5)).
pub const MAX_PAYOUT_DENOMINATOR: u64 = 100;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlackjackConfig {
    /// 1..=7.
    pub max_seats: usize,
    pub starting_stack: u64,
    pub min_bet: u64,
    pub max_bet: u64,
    /// 1..=8.
    pub decks: u8,
    /// Where the cut card goes, as a percentage of the shoe: 50..=90.
    pub penetration_percent: u8,
    /// false = S17 (stand on soft 17), true = H17.
    pub dealer_hits_soft_17: bool,
    /// (numerator, denominator): (3, 2) or (6, 5).
    pub blackjack_pays: (u64, u64),
    pub double_after_split: bool,
    /// Hands one seat may split into, 1..=4.
    pub max_hands: u8,
    pub resplit_aces: bool,
    pub turn_clock_secs: u32,
    pub timeouts_before_sit_out: u8,
    /// Whether a player who can no longer cover the minimum bet may take a
    /// fresh starting stack.
    pub allow_rebuy: bool,
}

impl Default for BlackjackConfig {
    fn default() -> Self {
        BlackjackConfig {
            max_seats: 6,
            starting_stack: 1_000,
            min_bet: 10,
            max_bet: 500,
            decks: 6,
            penetration_percent: 75,
            dealer_hits_soft_17: false,
            blackjack_pays: (3, 2),
            double_after_split: true,
            max_hands: 4,
            resplit_aces: false,
            turn_clock_secs: 30,
            timeouts_before_sit_out: 2,
            allow_rebuy: true,
        }
    }
}

impl BlackjackConfig {
    pub fn validate(&self) -> Result<(), BjError> {
        use BjError::InvalidConfig as E;
        if !(1..=MAX_SEATS_LIMIT).contains(&self.max_seats) {
            return Err(E("max_seats must be between 1 and 7"));
        }
        if !(1..=8).contains(&self.decks) {
            return Err(E("the shoe holds 1 to 8 decks"));
        }
        if !(50..=90).contains(&self.penetration_percent) {
            return Err(E("the cut card goes between 50% and 90% of the shoe"));
        }
        if self.min_bet == 0 || self.max_bet < self.min_bet {
            return Err(E("bets need 1 <= min_bet <= max_bet"));
        }
        if self.starting_stack < self.min_bet || self.starting_stack > MAX_STARTING_STACK || self.max_bet > MAX_STARTING_STACK {
            return Err(E("the starting stack must cover the minimum bet and stay within limits"));
        }
        let (num, den) = self.blackjack_pays;
        // The denominator is bounded FIRST, so `2 * den` cannot overflow and
        // `bet * num` stays far inside u64 (bet <= 1e9, num <= 200).
        if den == 0 || den > MAX_PAYOUT_DENOMINATOR {
            return Err(E("the blackjack payout denominator must be between 1 and 100"));
        }
        if num == 0 || num > 2 * den {
            return Err(E("blackjack must pay between 0 and 2 to 1"));
        }
        if !(1..=MAX_HANDS_LIMIT).contains(&self.max_hands) {
            return Err(E("max_hands must be between 1 and 4"));
        }
        if !(5..=300).contains(&self.turn_clock_secs) {
            return Err(E("the turn clock must be between 5 and 300 seconds"));
        }
        if self.timeouts_before_sit_out == 0 {
            return Err(E("timeouts_before_sit_out must be at least 1"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BjAction {
    Hit,
    Stand,
    Double,
    Split,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Blackjack,
    Win,
    Push,
    Lose,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BjActReason {
    Player,
    Timeout,
    Left,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BjSitOutReason {
    Requested,
    Timeouts,
    /// Cannot cover the minimum bet.
    Busted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BjTarget {
    Seat { seat: usize, hand: usize },
    Dealer,
}

/// Something that happened. Every event is public; the dealer's hole card is
/// dealt as `card: None` and appears only in `DealerRevealed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BjEvent {
    PlayerSat { seat: usize, player: PlayerId, stack: u64 },
    /// The seat is now empty and `stack` left with the player.
    PlayerLeft { seat: usize, player: PlayerId, stack: u64 },
    SatOut { seat: usize, reason: BjSitOutReason },
    SatIn { seat: usize },
    Rebought { seat: usize, stack: u64 },
    BetPlaced { seat: usize, amount: u64 },
    BetCleared { seat: usize, amount: u64 },
    ShoeShuffled { cards: usize, mid_round: bool },
    RoundStarted { round_no: u64, seats: Vec<usize> },
    CardDealt { to: BjTarget, card: Option<Card> },
    DealerPeeked { blackjack: bool },
    Acted { seat: usize, hand: usize, action: BjAction, reason: BjActReason },
    DealerRevealed { card: Card },
    /// `returned` is what came back to the stack (bet included).
    HandSettled { seat: usize, hand: usize, outcome: Outcome, bet: u64, returned: u64 },
    RoundEnded { round_no: u64, dealer_total: u8, dealer_bust: bool },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BjHandView {
    pub cards: Vec<Card>,
    pub bet: u64,
    pub doubled: bool,
    pub from_split: bool,
    pub total: u8,
    pub soft: bool,
    pub done: bool,
    pub outcome: Option<Outcome>,
    pub returned: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BjSeatView {
    pub seat: usize,
    pub player: PlayerId,
    pub stack: u64,
    /// The bet placed for the next round (already out of `stack`).
    pub pending_bet: u64,
    /// This round's hands, or the last round's until the next deal.
    pub hands: Vec<BjHandView>,
    pub sitting_out: bool,
    pub leaving: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BjLegal {
    pub can_hit: bool,
    pub can_stand: bool,
    pub can_double: bool,
    pub can_split: bool,
}

/// The table as everyone sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlackjackView {
    pub config: BlackjackConfig,
    pub round_no: u64,
    pub in_round: bool,
    pub seats: Vec<Option<BjSeatView>>,
    /// `None` is the face-down hole card.
    pub dealer: Vec<Option<Card>>,
    /// Known once the hole card is turned.
    pub dealer_total: Option<u8>,
    /// (seat, hand index).
    pub to_act: Option<(usize, usize)>,
    pub turn: Option<TurnRef>,
    pub shoe_remaining: usize,
    pub shoe_size: usize,
    /// The next deal will shuffle first.
    pub reshuffle_due: bool,
    /// What the seat to act may do.
    pub legal: Option<BjLegal>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BjError {
    InvalidConfig(&'static str),
    ConfigLocked,
    SeatOutOfRange,
    SeatTaken,
    SeatEmpty,
    AlreadySeated,
    RoundInProgress,
    NoRoundInProgress,
    NoBets,
    BetBelowMinimum { min: u64 },
    BetAboveMaximum { max: u64 },
    InsufficientChips { stack: u64 },
    SittingOut,
    NotYourTurn,
    StaleTurn,
    CannotHit,
    CannotDouble,
    CannotSplit,
    NoChips,
    NotBusted,
    RebuyNotAllowed,
}

impl fmt::Display for BjError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BjError::InvalidConfig(why) => write!(f, "invalid table settings: {why}"),
            BjError::ConfigLocked => write!(f, "the table settings cannot change after the first round"),
            BjError::SeatOutOfRange => write!(f, "no such seat"),
            BjError::SeatTaken => write!(f, "that seat is taken"),
            BjError::SeatEmpty => write!(f, "that seat is empty"),
            BjError::AlreadySeated => write!(f, "already seated at this table"),
            BjError::RoundInProgress => write!(f, "a round is in progress"),
            BjError::NoRoundInProgress => write!(f, "no round is in progress"),
            BjError::NoBets => write!(f, "nobody has placed a bet"),
            BjError::BetBelowMinimum { min } => write!(f, "the minimum bet is {min}"),
            BjError::BetAboveMaximum { max } => write!(f, "the maximum bet is {max}"),
            BjError::InsufficientChips { stack } => write!(f, "only {stack} chips"),
            BjError::SittingOut => write!(f, "sitting out"),
            BjError::NotYourTurn => write!(f, "it is not your turn"),
            BjError::StaleTurn => write!(f, "that turn has already passed"),
            BjError::CannotHit => write!(f, "this hand cannot take a card"),
            BjError::CannotDouble => write!(f, "this hand cannot double"),
            BjError::CannotSplit => write!(f, "this hand cannot split"),
            BjError::NoChips => write!(f, "not enough chips for the minimum bet"),
            BjError::NotBusted => write!(f, "only a player who cannot cover the minimum bet can rebuy"),
            BjError::RebuyNotAllowed => write!(f, "this table does not allow rebuys"),
        }
    }
}

impl std::error::Error for BjError {}

/// Blackjack value of one card: aces count 1 here ([`hand_total`] makes one
/// of them 11 when it fits).
fn card_value(c: Card) -> u32 {
    match c.rank() {
        Rank::Ace => 1,
        Rank::Ten | Rank::Jack | Rank::Queen | Rank::King => 10,
        r => r.index() as u32 + 2,
    }
}

fn is_ten_value(c: Card) -> bool {
    card_value(c) == 10
}

/// (total, soft): `soft` when an ace is counted as 11.
pub fn hand_total(cards: &[Card]) -> (u8, bool) {
    let hard: u32 = cards.iter().map(|&c| card_value(c)).sum();
    let has_ace = cards.iter().any(|c| c.rank() == Rank::Ace);
    let (total, soft) = if has_ace && hard + 10 <= 21 { (hard + 10, true) } else { (hard, false) };
    (total.min(u8::MAX as u32) as u8, soft)
}

/// A multi-deck shoe with a cut card and a discard tray.
pub struct Shoe {
    decks: u8,
    cut: usize,
    size: usize,
    /// Undealt cards; dealing pops from the end.
    cards: Vec<Card>,
    discards: Vec<Card>,
    dealt_since_shuffle: usize,
    shuffled: bool,
}

impl Shoe {
    pub fn new(decks: u8, penetration_percent: u8) -> Shoe {
        let size = decks as usize * 52;
        Shoe {
            decks,
            cut: size * penetration_percent as usize / 100,
            size,
            cards: Self::composition(decks),
            discards: Vec::new(),
            dealt_since_shuffle: 0,
            shuffled: false,
        }
    }

    fn composition(decks: u8) -> Vec<Card> {
        (0..decks).flat_map(|_| full_deck()).collect()
    }

    /// Cards the shoe owns in total: undealt + discarded + on the table.
    pub fn size(&self) -> usize {
        self.size
    }

    pub fn remaining(&self) -> usize {
        self.cards.len()
    }

    pub fn discarded(&self) -> usize {
        self.discards.len()
    }

    /// True before the first shuffle and once the cut card has come out.
    pub fn needs_shuffle(&self) -> bool {
        !self.shuffled || self.dealt_since_shuffle >= self.cut
    }

    /// A full reshuffle — only between rounds, with no card on the table.
    pub fn shuffle<R: GameRng + ?Sized>(&mut self, rng: &mut R) {
        self.cards = Self::composition(self.decks);
        self.size = self.cards.len();
        self.discards.clear();
        shuffle(&mut self.cards, rng);
        self.dealt_since_shuffle = 0;
        self.shuffled = true;
    }

    /// Next card, and whether the shoe had to be refilled mid-round to give
    /// it. The refill is the discard tray: every card from earlier rounds,
    /// none of them in play.
    pub fn draw<R: GameRng + ?Sized>(&mut self, rng: &mut R) -> (Card, bool) {
        let mut refilled = false;
        if self.cards.is_empty() {
            refilled = true;
            if self.discards.is_empty() {
                // Every card of the shoe is on the table at once. No real
                // sequence of play gets here with more than one deck; if one
                // ever does, a fresh set of decks joins the shoe rather than
                // the engine stopping mid-round. `size` grows to match, so
                // the card census stays exact.
                self.discards = Self::composition(self.decks);
                self.size += self.discards.len();
            }
            self.cards = std::mem::take(&mut self.discards);
            shuffle(&mut self.cards, rng);
        }
        self.dealt_since_shuffle += 1;
        (self.cards.pop().expect("refilled above"), refilled)
    }

    pub fn discard(&mut self, cards: &[Card]) {
        self.discards.extend_from_slice(cards);
    }

    /// A shoe whose next cards are `top`, in order, then the rest of the
    /// composition in index order.
    #[cfg(test)]
    fn stacked(decks: u8, penetration_percent: u8, top: &[Card]) -> Shoe {
        let mut s = Shoe::new(decks, penetration_percent);
        let mut rest = Self::composition(decks);
        for c in top {
            let i = rest.iter().position(|x| x == c).expect("more copies than the shoe holds");
            rest.remove(i);
        }
        rest.extend(top.iter().rev());
        s.cards = rest;
        s.shuffled = true;
        s
    }
}

// ---------------------------------------------------------------------------

#[derive(Clone)]
struct BjHand {
    cards: Vec<Card>,
    bet: u64,
    doubled: bool,
    from_split: bool,
    split_aces: bool,
    done: bool,
    outcome: Option<Outcome>,
    returned: u64,
}

impl BjHand {
    fn new(bet: u64) -> BjHand {
        BjHand { cards: Vec::new(), bet, doubled: false, from_split: false, split_aces: false, done: false, outcome: None, returned: 0 }
    }

    fn is_natural(&self) -> bool {
        !self.from_split && self.cards.len() == 2 && hand_total(&self.cards).0 == 21
    }
}

#[derive(Clone)]
struct BjSeat {
    player: PlayerId,
    stack: u64,
    pending_bet: u64,
    hands: Vec<BjHand>,
    in_round: bool,
    sitting_out: bool,
    leaving: bool,
    timeouts: u8,
}

/// A Blackjack table. All state is in memory; every method is synchronous.
pub struct BlackjackTable {
    config: BlackjackConfig,
    seats: Vec<Option<BjSeat>>,
    shoe: Shoe,
    rounds: u64,
    round_live: bool,
    dealer: Vec<Card>,
    hole_revealed: bool,
    to_act: Option<(usize, usize)>,
    turn_seq: u64,
    /// What the house has won (negative: lost) since the table opened.
    house_net: i64,
    departed: HashMap<PlayerId, u64>,
}

/// Redacted: never prints a card, so logging a table cannot leak the hole
/// card or the shoe.
impl fmt::Debug for BlackjackTable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BlackjackTable")
            .field("round_no", &self.rounds)
            .field("in_round", &self.round_live)
            .field("seated", &self.seats.iter().flatten().count())
            .finish_non_exhaustive()
    }
}

impl BlackjackTable {
    pub fn new(config: BlackjackConfig) -> Result<Self, BjError> {
        config.validate()?;
        Ok(BlackjackTable {
            seats: vec![None; config.max_seats],
            shoe: Shoe::new(config.decks, config.penetration_percent),
            config,
            rounds: 0,
            round_live: false,
            dealer: Vec::new(),
            hole_revealed: false,
            to_act: None,
            turn_seq: 0,
            house_net: 0,
            departed: HashMap::new(),
        })
    }

    pub fn config(&self) -> &BlackjackConfig {
        &self.config
    }

    /// Change the settings — only before the first round. Seated players get
    /// the new starting stack (and any pending bet back).
    pub fn configure(&mut self, config: BlackjackConfig) -> Result<Vec<BjEvent>, BjError> {
        if self.rounds > 0 {
            return Err(BjError::ConfigLocked);
        }
        config.validate()?;
        if self.seats.iter().enumerate().any(|(i, s)| s.is_some() && i >= config.max_seats) {
            return Err(BjError::InvalidConfig("an occupied seat is beyond the new seat count"));
        }
        self.seats.resize(config.max_seats, None);
        for s in self.seats.iter_mut().flatten() {
            s.stack = config.starting_stack;
            s.pending_bet = 0;
        }
        self.shoe = Shoe::new(config.decks, config.penetration_percent);
        self.departed.clear();
        self.config = config;
        Ok(Vec::new())
    }

    fn occupant(&mut self, seat: usize) -> Result<&mut BjSeat, BjError> {
        self.seats.get_mut(seat).ok_or(BjError::SeatOutOfRange)?.as_mut().ok_or(BjError::SeatEmpty)
    }

    fn busted(&self, s: &BjSeat) -> bool {
        s.stack + s.pending_bet < self.config.min_bet
    }

    pub fn sit(&mut self, seat: usize, player: PlayerId) -> Result<Vec<BjEvent>, BjError> {
        if seat >= self.config.max_seats {
            return Err(BjError::SeatOutOfRange);
        }
        if self.seats[seat].is_some() {
            return Err(BjError::SeatTaken);
        }
        if self.seats.iter().flatten().any(|s| s.player == player) {
            return Err(BjError::AlreadySeated);
        }
        let stack = match self.departed.get(&player) {
            Some(&s) if s < self.config.min_bet && self.config.allow_rebuy => self.config.starting_stack,
            Some(&s) if s < self.config.min_bet => return Err(BjError::NoChips),
            Some(&s) => s,
            None => self.config.starting_stack,
        };
        self.departed.remove(&player);
        self.seats[seat] = Some(BjSeat {
            player,
            stack,
            pending_bet: 0,
            hands: Vec::new(),
            in_round: false,
            sitting_out: false,
            leaving: false,
            timeouts: 0,
        });
        Ok(vec![BjEvent::PlayerSat { seat, player, stack }])
    }

    /// Stand up. Mid-round every remaining hand stands, the bets still
    /// settle, and the seat is freed when the round ends.
    pub fn leave<R: GameRng + ?Sized>(&mut self, seat: usize, rng: &mut R) -> Result<Vec<BjEvent>, BjError> {
        let round_live = self.round_live;
        let s = self.occupant(seat)?;
        let mut ev = Vec::new();
        if round_live && s.in_round {
            s.leaving = true;
            for (h, hand) in s.hands.iter_mut().enumerate() {
                if !hand.done {
                    hand.done = true;
                    ev.push(BjEvent::Acted { seat, hand: h, action: BjAction::Stand, reason: BjActReason::Left });
                }
            }
            if self.to_act.is_some_and(|(s, _)| s == seat) {
                self.advance(rng, &mut ev);
            }
            return Ok(ev);
        }
        if s.pending_bet > 0 {
            ev.push(BjEvent::BetCleared { seat, amount: s.pending_bet });
            s.stack += s.pending_bet;
            s.pending_bet = 0;
        }
        let s = self.seats[seat].take().unwrap();
        self.departed.insert(s.player, s.stack);
        ev.push(BjEvent::PlayerLeft { seat, player: s.player, stack: s.stack });
        Ok(ev)
    }

    /// Sit out from the next round on; a pending bet comes back.
    pub fn sit_out(&mut self, seat: usize) -> Result<Vec<BjEvent>, BjError> {
        let s = self.occupant(seat)?;
        let mut ev = Vec::new();
        if s.pending_bet > 0 {
            ev.push(BjEvent::BetCleared { seat, amount: s.pending_bet });
            s.stack += s.pending_bet;
            s.pending_bet = 0;
        }
        if !s.sitting_out {
            s.sitting_out = true;
            ev.push(BjEvent::SatOut { seat, reason: BjSitOutReason::Requested });
        }
        Ok(ev)
    }

    pub fn sit_in(&mut self, seat: usize) -> Result<Vec<BjEvent>, BjError> {
        let min = self.config.min_bet;
        let s = self.occupant(seat)?;
        if s.stack < min {
            return Err(BjError::NoChips);
        }
        s.timeouts = 0;
        if !s.sitting_out {
            return Ok(Vec::new());
        }
        s.sitting_out = false;
        Ok(vec![BjEvent::SatIn { seat }])
    }

    /// A fresh starting stack for a player who cannot cover the minimum bet.
    pub fn rebuy(&mut self, seat: usize) -> Result<Vec<BjEvent>, BjError> {
        let s = self.seats.get(seat).ok_or(BjError::SeatOutOfRange)?.as_ref().ok_or(BjError::SeatEmpty)?;
        if !self.busted(s) {
            return Err(BjError::NotBusted);
        }
        if !self.config.allow_rebuy {
            return Err(BjError::RebuyNotAllowed);
        }
        if self.round_live && s.in_round {
            return Err(BjError::RoundInProgress);
        }
        let stack = self.config.starting_stack;
        let s = self.seats[seat].as_mut().unwrap();
        s.stack = stack;
        s.sitting_out = false;
        s.timeouts = 0;
        Ok(vec![BjEvent::Rebought { seat, stack }])
    }

    /// Bet on the next round. Replaces any bet already placed; the chips
    /// leave the stack now and come back with `clear_bet`.
    pub fn place_bet(&mut self, seat: usize, amount: u64) -> Result<Vec<BjEvent>, BjError> {
        let (min, max, live) = (self.config.min_bet, self.config.max_bet, self.round_live);
        let s = self.occupant(seat)?;
        if live {
            return Err(BjError::RoundInProgress);
        }
        if s.sitting_out {
            return Err(BjError::SittingOut);
        }
        if amount < min {
            return Err(BjError::BetBelowMinimum { min });
        }
        if amount > max {
            return Err(BjError::BetAboveMaximum { max });
        }
        let available = s.stack + s.pending_bet;
        if amount > available {
            return Err(BjError::InsufficientChips { stack: available });
        }
        s.stack = available - amount;
        s.pending_bet = amount;
        Ok(vec![BjEvent::BetPlaced { seat, amount }])
    }

    pub fn clear_bet(&mut self, seat: usize) -> Result<Vec<BjEvent>, BjError> {
        let live = self.round_live;
        let s = self.occupant(seat)?;
        if live {
            return Err(BjError::RoundInProgress);
        }
        if s.pending_bet == 0 {
            return Ok(Vec::new());
        }
        let amount = std::mem::take(&mut s.pending_bet);
        s.stack += amount;
        Ok(vec![BjEvent::BetCleared { seat, amount }])
    }

    fn check_can_deal(&self) -> Result<(), BjError> {
        if self.round_live {
            return Err(BjError::RoundInProgress);
        }
        if !self.seats.iter().flatten().any(|s| s.pending_bet > 0) {
            return Err(BjError::NoBets);
        }
        Ok(())
    }

    /// Start a round for every seat with a bet, shuffling first if the cut
    /// card came out last round.
    pub fn deal<R: GameRng + ?Sized>(&mut self, rng: &mut R) -> Result<Vec<BjEvent>, BjError> {
        self.check_can_deal()?;
        let mut ev = Vec::new();
        if self.shoe.needs_shuffle() {
            self.shoe.shuffle(rng);
            ev.push(BjEvent::ShoeShuffled { cards: self.shoe.size(), mid_round: false });
        }
        self.begin_round(rng, &mut ev);
        Ok(ev)
    }

    fn draw<R: GameRng + ?Sized>(&mut self, rng: &mut R, ev: &mut Vec<BjEvent>) -> Card {
        let (card, refilled) = self.shoe.draw(rng);
        if refilled {
            ev.push(BjEvent::ShoeShuffled { cards: self.shoe.remaining() + 1, mid_round: true });
        }
        card
    }

    fn begin_round<R: GameRng + ?Sized>(&mut self, rng: &mut R, ev: &mut Vec<BjEvent>) {
        self.rounds += 1;
        self.round_live = true;
        self.dealer.clear();
        self.hole_revealed = false;
        self.to_act = None;
        let mut playing = Vec::new();
        for (i, slot) in self.seats.iter_mut().enumerate() {
            let Some(s) = slot else { continue };
            s.hands.clear();
            s.in_round = s.pending_bet > 0;
            if s.in_round {
                s.hands.push(BjHand::new(std::mem::take(&mut s.pending_bet)));
                playing.push(i);
            }
        }
        ev.push(BjEvent::RoundStarted { round_no: self.rounds, seats: playing.clone() });
        for pass in 0..2 {
            for &i in &playing {
                let c = self.draw(rng, ev);
                self.seats[i].as_mut().unwrap().hands[0].cards.push(c);
                ev.push(BjEvent::CardDealt { to: BjTarget::Seat { seat: i, hand: 0 }, card: Some(c) });
            }
            let c = self.draw(rng, ev);
            self.dealer.push(c);
            // The second dealer card is the hole card: dealt face down.
            ev.push(BjEvent::CardDealt { to: BjTarget::Dealer, card: (pass == 0).then_some(c) });
        }

        let up = self.dealer[0];
        if up.rank() == Rank::Ace || is_ten_value(up) {
            let dealer_bj = hand_total(&self.dealer).0 == 21;
            ev.push(BjEvent::DealerPeeked { blackjack: dealer_bj });
            if dealer_bj {
                self.reveal(ev);
                for &i in &playing {
                    let outcome = if self.seats[i].as_ref().unwrap().hands[0].is_natural() { Outcome::Push } else { Outcome::Lose };
                    self.settle(i, 0, outcome, ev);
                }
                self.finish_round(ev);
                return;
            }
        }
        for &i in &playing {
            if self.seats[i].as_ref().unwrap().hands[0].is_natural() {
                self.settle(i, 0, Outcome::Blackjack, ev);
            }
        }
        self.advance(rng, ev);
    }

    fn settle(&mut self, seat: usize, h: usize, outcome: Outcome, ev: &mut Vec<BjEvent>) {
        let (num, den) = self.config.blackjack_pays;
        let s = self.seats[seat].as_mut().unwrap();
        let hand = &mut s.hands[h];
        let bet = hand.bet;
        let returned = match outcome {
            Outcome::Blackjack => bet + bet * num / den,
            Outcome::Win => 2 * bet,
            Outcome::Push => bet,
            Outcome::Lose => 0,
        };
        hand.outcome = Some(outcome);
        hand.returned = returned;
        hand.done = true;
        s.stack += returned;
        self.house_net += bet as i64 - returned as i64;
        ev.push(BjEvent::HandSettled { seat, hand: h, outcome, bet, returned });
    }

    fn reveal(&mut self, ev: &mut Vec<BjEvent>) {
        if !self.hole_revealed {
            self.hole_revealed = true;
            ev.push(BjEvent::DealerRevealed { card: self.dealer[1] });
        }
    }

    /// Hand the turn to the next unfinished hand, or play the dealer.
    fn advance<R: GameRng + ?Sized>(&mut self, rng: &mut R, ev: &mut Vec<BjEvent>) {
        let next = self.seats.iter().enumerate().find_map(|(i, s)| {
            let s = s.as_ref().filter(|s| s.in_round)?;
            s.hands.iter().position(|h| !h.done).map(|h| (i, h))
        });
        match next {
            Some(t) => {
                self.to_act = Some(t);
                self.turn_seq += 1;
            }
            None => {
                self.to_act = None;
                self.dealer_play(rng, ev);
            }
        }
    }

    fn dealer_play<R: GameRng + ?Sized>(&mut self, rng: &mut R, ev: &mut Vec<BjEvent>) {
        self.reveal(ev);
        let unsettled: Vec<(usize, usize)> = self
            .seats
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.as_ref().filter(|s| s.in_round).map(|s| (i, s)))
            .flat_map(|(i, s)| (0..s.hands.len()).filter(|&h| s.hands[h].outcome.is_none()).map(move |h| (i, h)))
            .collect();
        if !unsettled.is_empty() {
            loop {
                let (total, soft) = hand_total(&self.dealer);
                let hits = total < 17 || (total == 17 && soft && self.config.dealer_hits_soft_17);
                if !hits {
                    break;
                }
                let c = self.draw(rng, ev);
                self.dealer.push(c);
                ev.push(BjEvent::CardDealt { to: BjTarget::Dealer, card: Some(c) });
            }
        }
        let dealer_total = hand_total(&self.dealer).0;
        for (i, h) in unsettled {
            let player = hand_total(&self.seats[i].as_ref().unwrap().hands[h].cards).0;
            let outcome = if dealer_total > 21 || player > dealer_total {
                Outcome::Win
            } else if player == dealer_total {
                Outcome::Push
            } else {
                Outcome::Lose
            };
            self.settle(i, h, outcome, ev);
        }
        self.finish_round(ev);
    }

    fn finish_round(&mut self, ev: &mut Vec<BjEvent>) {
        let (dealer_total, _) = hand_total(&self.dealer);
        ev.push(BjEvent::RoundEnded { round_no: self.rounds, dealer_total, dealer_bust: dealer_total > 21 });
        self.round_live = false;
        self.to_act = None;
        // Everything dealt this round goes to the discard tray. (The hands
        // stay on show in the view until the next deal.)
        let mut table: Vec<Card> = self.dealer.clone();
        for s in self.seats.iter().flatten() {
            for h in &s.hands {
                table.extend_from_slice(&h.cards);
            }
        }
        self.shoe.discard(&table);
        let min = self.config.min_bet;
        for seat in 0..self.seats.len() {
            let Some(s) = self.seats[seat].as_mut() else { continue };
            s.in_round = false;
            if s.leaving {
                let s = self.seats[seat].take().unwrap();
                self.departed.insert(s.player, s.stack);
                ev.push(BjEvent::PlayerLeft { seat, player: s.player, stack: s.stack });
            } else if s.stack + s.pending_bet < min && !s.sitting_out {
                s.sitting_out = true;
                ev.push(BjEvent::SatOut { seat, reason: BjSitOutReason::Busted });
            }
        }
    }

    fn legal_for(&self, seat: usize, h: usize) -> BjLegal {
        let s = self.seats[seat].as_ref().unwrap();
        let hand = &s.hands[h];
        let (total, _) = hand_total(&hand.cards);
        let two = hand.cards.len() == 2 && !hand.done;
        let pair = two && card_value(hand.cards[0]) == card_value(hand.cards[1]);
        BjLegal {
            can_hit: !hand.done && total < 21 && !hand.split_aces,
            can_stand: !hand.done,
            can_double: two
                && !hand.split_aces
                && (!hand.from_split || self.config.double_after_split)
                && s.stack >= hand.bet,
            can_split: pair
                && s.hands.len() < self.config.max_hands as usize
                && s.stack >= hand.bet
                && (!hand.split_aces || self.config.resplit_aces),
        }
    }

    /// The player to act acts on their current hand. `turn` must be the
    /// current [`Self::turn`]. `rng` is only touched if the shoe runs out.
    pub fn act<R: GameRng + ?Sized>(&mut self, seat: usize, turn: TurnRef, action: BjAction, rng: &mut R) -> Result<Vec<BjEvent>, BjError> {
        if !self.round_live {
            return Err(BjError::NoRoundInProgress);
        }
        let (s, h) = self.to_act.ok_or(BjError::NoRoundInProgress)?;
        if s != seat {
            return Err(BjError::NotYourTurn);
        }
        if self.turn() != Some(turn) {
            return Err(BjError::StaleTurn);
        }
        let legal = self.legal_for(s, h);
        match action {
            BjAction::Hit if !legal.can_hit => return Err(BjError::CannotHit),
            BjAction::Double if !legal.can_double => return Err(BjError::CannotDouble),
            BjAction::Split if !legal.can_split => return Err(BjError::CannotSplit),
            _ => {}
        }
        let mut ev = Vec::new();
        self.apply(s, h, action, BjActReason::Player, rng, &mut ev);
        self.seats[s].as_mut().unwrap().timeouts = 0;
        self.advance(rng, &mut ev);
        Ok(ev)
    }

    /// The turn clock for `turn` expired: the hand stands.
    pub fn timeout<R: GameRng + ?Sized>(&mut self, turn: TurnRef, rng: &mut R) -> Result<Vec<BjEvent>, BjError> {
        if self.turn() != Some(turn) {
            return Err(BjError::StaleTurn);
        }
        let (s, h) = self.to_act.unwrap();
        let mut ev = Vec::new();
        self.apply(s, h, BjAction::Stand, BjActReason::Timeout, rng, &mut ev);
        let limit = self.config.timeouts_before_sit_out;
        let st = self.seats[s].as_mut().unwrap();
        st.timeouts = st.timeouts.saturating_add(1);
        if st.timeouts >= limit && !st.sitting_out {
            st.sitting_out = true;
            ev.push(BjEvent::SatOut { seat: s, reason: BjSitOutReason::Timeouts });
        }
        self.advance(rng, &mut ev);
        Ok(ev)
    }

    /// Applies an already-validated action.
    fn apply<R: GameRng + ?Sized>(&mut self, s: usize, h: usize, action: BjAction, reason: BjActReason, rng: &mut R, ev: &mut Vec<BjEvent>) {
        ev.push(BjEvent::Acted { seat: s, hand: h, action, reason });
        match action {
            BjAction::Stand => self.seats[s].as_mut().unwrap().hands[h].done = true,
            BjAction::Hit => {
                self.deal_to(s, h, rng, ev);
                self.check_hand_end(s, h, ev);
            }
            BjAction::Double => {
                let st = self.seats[s].as_mut().unwrap();
                let bet = st.hands[h].bet;
                st.stack -= bet;
                st.hands[h].bet = 2 * bet;
                st.hands[h].doubled = true;
                self.deal_to(s, h, rng, ev);
                self.seats[s].as_mut().unwrap().hands[h].done = true;
                self.check_hand_end(s, h, ev);
            }
            BjAction::Split => {
                let resplit_aces = self.config.resplit_aces;
                let max_hands = self.config.max_hands as usize;
                let st = self.seats[s].as_mut().unwrap();
                let bet = st.hands[h].bet;
                st.stack -= bet;
                let second = st.hands[h].cards.pop().unwrap();
                let aces = second.rank() == Rank::Ace;
                let mut new = BjHand::new(bet);
                new.cards.push(second);
                new.from_split = true;
                new.split_aces = aces;
                st.hands[h].from_split = true;
                st.hands[h].split_aces = aces;
                st.hands.insert(h + 1, new);
                for k in [h, h + 1] {
                    self.deal_to(s, k, rng, ev);
                    let st = self.seats[s].as_mut().unwrap();
                    if aces {
                        // One card each — unless resplitting aces is allowed
                        // and this one drew another ace with room to split.
                        let again = resplit_aces && st.hands[k].cards[1].rank() == Rank::Ace && st.hands.len() < max_hands;
                        st.hands[k].done = !again;
                    }
                    self.check_hand_end(s, k, ev);
                }
            }
        }
    }

    fn deal_to<R: GameRng + ?Sized>(&mut self, s: usize, h: usize, rng: &mut R, ev: &mut Vec<BjEvent>) {
        let c = self.draw(rng, ev);
        self.seats[s].as_mut().unwrap().hands[h].cards.push(c);
        ev.push(BjEvent::CardDealt { to: BjTarget::Seat { seat: s, hand: h }, card: Some(c) });
    }

    /// 21 finishes a hand; a bust finishes and loses it on the spot.
    fn check_hand_end(&mut self, s: usize, h: usize, ev: &mut Vec<BjEvent>) {
        let hand = &mut self.seats[s].as_mut().unwrap().hands[h];
        let (total, _) = hand_total(&hand.cards);
        if total > 21 {
            if hand.outcome.is_none() {
                self.settle(s, h, Outcome::Lose, ev);
            }
        } else if total == 21 {
            hand.done = true;
        }
    }

    pub fn round_in_progress(&self) -> bool {
        self.round_live
    }

    pub fn turn(&self) -> Option<TurnRef> {
        self.to_act.filter(|_| self.round_live).map(|_| TurnRef { hand_no: self.rounds, turn_seq: self.turn_seq })
    }

    /// (seat, hand index) whose decision is awaited.
    pub fn to_act(&self) -> Option<(usize, usize)> {
        self.to_act.filter(|_| self.round_live)
    }

    /// What `seat` may do — `None` unless it is that seat's turn.
    pub fn legal_actions(&self, seat: usize) -> Option<BjLegal> {
        let (s, h) = self.to_act()?;
        (s == seat).then(|| self.legal_for(s, h))
    }

    /// What the house has won (negative: lost) since the table opened.
    pub fn house_net(&self) -> i64 {
        self.house_net
    }

    /// The table as everyone sees it: the hole card is `None` until turned.
    pub fn view(&self) -> BlackjackView {
        let seats = self
            .seats
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let s = s.as_ref()?;
                Some(BjSeatView {
                    seat: i,
                    player: s.player,
                    stack: s.stack,
                    pending_bet: s.pending_bet,
                    hands: s
                        .hands
                        .iter()
                        .map(|h| {
                            let (total, soft) = hand_total(&h.cards);
                            BjHandView {
                                cards: h.cards.clone(),
                                bet: h.bet,
                                doubled: h.doubled,
                                from_split: h.from_split,
                                total,
                                soft,
                                done: h.done,
                                outcome: h.outcome,
                                returned: h.outcome.map(|_| h.returned),
                            }
                        })
                        .collect(),
                    sitting_out: s.sitting_out,
                    leaving: s.leaving,
                })
            })
            .collect();
        let dealer = self
            .dealer
            .iter()
            .enumerate()
            .map(|(i, &c)| (i != 1 || self.hole_revealed).then_some(c))
            .collect();
        BlackjackView {
            config: self.config.clone(),
            round_no: self.rounds,
            in_round: self.round_live,
            seats,
            dealer,
            dealer_total: self.hole_revealed.then(|| hand_total(&self.dealer).0),
            to_act: self.to_act(),
            turn: self.turn(),
            shoe_remaining: self.shoe.remaining(),
            shoe_size: self.shoe.size(),
            reshuffle_due: self.shoe.needs_shuffle(),
            legal: self.to_act().map(|(s, h)| self.legal_for(s, h)),
        }
    }

    /// (cards accounted for, cards the shoe owns): undealt + discarded + on
    /// the table in a live round. Equal unless a card was lost or doubled.
    #[cfg(test)]
    fn card_census(&self) -> (usize, usize) {
        let on_table = if self.round_live {
            self.dealer.len() + self.seats.iter().flatten().flat_map(|s| s.hands.iter()).map(|h| h.cards.len()).sum::<usize>()
        } else {
            0
        };
        (self.shoe.remaining() + self.shoe.discarded() + on_table, self.shoe.size())
    }

    /// `deal`, but from a shoe whose next cards are `cards` in order.
    #[cfg(test)]
    fn deal_stacked(&mut self, cards: &str) -> Result<Vec<BjEvent>, BjError> {
        self.check_can_deal()?;
        self.shoe = Shoe::stacked(self.config.decks, self.config.penetration_percent, &crate::cards::cards(cards));
        let mut ev = Vec::new();
        self.begin_round(&mut crate::rng::seeded(0), &mut ev);
        Ok(ev)
    }
}
