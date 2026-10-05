//! The games wire contract: what the in-call card games look like on the
//! WebSocket (docs/GAMES.md, *Frames*).
//!
//! The rules live in `crates/puca-games`; this module only TRANSLATES. It
//! turns the engine's per-seat views and public events into the JSON the
//! client reads, turns the client's intents into engine calls, and turns
//! every engine refusal into a typed code. Nothing here decides who may do
//! what, holds a table or runs a clock - that is the server half (registry,
//! handlers, timers), which calls these functions.
//!
//! WHAT NEVER LEAVES. A hidden card leaves the engine only through
//! `HoldemTable::view_for(Some(seat))` (that seat's own hole cards) and
//! through shown hands. These conversions read nothing else: a Hold'em view
//! is built from a `HoldemView` alone and a Blackjack view from a
//! `BlackjackView` alone, so a bug here can mislabel a card but cannot reach
//! one the engine did not hand over. A face-down card is `"??"` - two
//! characters, like every card, so a frame's length never depends on whether
//! a card in it is visible (crates/puca-games/src/cards.rs).
//!
//! NUMBERS. Every integer on the wire is a JavaScript-safe integer: table ids
//! stay below 2^53 (`registry::MAX_TABLE_ID`), stacks are capped at 10^9
//! (`MAX_STARTING_STACK`), and the counters (`version`, `hand_no`,
//! `turn_seq`) count one per action. User ids are the server's `i64`s.
//!
//! NO FREE TEXT. No frame here carries a string a person typed or a message
//! the client would render: card codes, enum names and numbers only. The
//! engine's `Display` messages stay on the server (logs); the client words
//! each `code` itself.

use puca_games::blackjack::{
    BjAction, BjActReason, BjError, BjEvent, BjSitOutReason, BjTarget, BlackjackConfig, BlackjackView, Outcome,
};
use puca_games::cards::HIDDEN_CODE;
use puca_games::eval::Category;
use puca_games::holdem::{
    ActReason, ActedKind, Action, Event, HoldemConfig, HoldemError, HoldemView, SeatStatus, SitOutReason, Street,
};
use puca_games::registry::{GameKind, OpenError};
use puca_games::{Card, PlayerId, TurnRef};
use serde::{Deserialize, Serialize};
use std::fmt;

use crate::state::UserId;

/// Whether this server build plays games: what makes it confirm the `games`
/// capability in `ServerFeatures` (`crate::presence::ClientCaps::features`).
///
/// TRUE since the commit that added the game handlers (src/games.rs): a
/// client that announced `games` may now send the Game* frames, and the
/// tables they open are played here. (It was false in the contract commit,
/// when nothing acted on the frames.)
pub const GAMES_SERVED: bool = true;

// ---------------------------------------------------------------------------
// Identity

/// The engine's opaque player id for a user. Every `i64` maps to a distinct
/// id and back ([`user_of`]); the engine only compares them.
pub fn player_id(user: UserId) -> PlayerId {
    PlayerId(u128::from(user as u64))
}

/// The user a [`player_id`] was made from.
pub fn user_of(player: PlayerId) -> UserId {
    player.0 as u64 as i64
}

fn code(c: Card) -> String {
    c.to_string()
}

fn codes<const N: usize>(cs: [Card; N]) -> Vec<String> {
    cs.iter().map(|&c| code(c)).collect()
}

// ---------------------------------------------------------------------------
// Client -> server pieces

/// Which game. The wire names; `registry::GameKind` is the engine's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameKindWire {
    Holdem,
    Blackjack,
}

impl From<GameKind> for GameKindWire {
    fn from(k: GameKind) -> Self {
        match k {
            GameKind::Holdem => GameKindWire::Holdem,
            GameKind::Blackjack => GameKindWire::Blackjack,
        }
    }
}

impl From<GameKindWire> for GameKind {
    fn from(k: GameKindWire) -> Self {
        match k {
            GameKindWire::Holdem => GameKind::Holdem,
            GameKindWire::Blackjack => GameKind::Blackjack,
        }
    }
}

/// The opener's settings in `GameCreate`. Every field is optional and
/// defaults to the engine's default (the owner's fixed table: NLHE 6-max,
/// 1,000 chips, 5/10; Blackjack 6 decks S17 3:2, bets 10-500). Only the
/// stack and the stakes are the opener's to choose; seats, clocks, decks and
/// payouts are the server's. A field that belongs to the OTHER game is
/// refused (`invalid_config`), not ignored, so a client bug cannot open a
/// table with settings nobody asked for. Unknown fields are ignored, like
/// every frame's (a newer client must not draw an Error from an older
/// server).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameConfigWire {
    #[serde(default)]
    pub starting_stack: Option<u64>,
    /// Hold'em only.
    #[serde(default)]
    pub small_blind: Option<u64>,
    /// Hold'em only.
    #[serde(default)]
    pub big_blind: Option<u64>,
    /// Blackjack only.
    #[serde(default)]
    pub min_bet: Option<u64>,
    /// Blackjack only.
    #[serde(default)]
    pub max_bet: Option<u64>,
}

impl GameConfigWire {
    /// The Hold'em table this asks for, validated by the engine.
    pub fn holdem(&self) -> Result<HoldemConfig, GameRefusal> {
        if self.min_bet.is_some() || self.max_bet.is_some() {
            return Err(GameRefusal::InvalidConfig);
        }
        let d = HoldemConfig::default();
        let c = HoldemConfig {
            starting_stack: self.starting_stack.unwrap_or(d.starting_stack),
            small_blind: self.small_blind.unwrap_or(d.small_blind),
            big_blind: self.big_blind.unwrap_or(d.big_blind),
            ..d
        };
        c.validate().map_err(GameRefusal::from)?;
        Ok(c)
    }

    /// The Blackjack table this asks for, validated by the engine.
    pub fn blackjack(&self) -> Result<BlackjackConfig, GameRefusal> {
        if self.small_blind.is_some() || self.big_blind.is_some() {
            return Err(GameRefusal::InvalidConfig);
        }
        let d = BlackjackConfig::default();
        let c = BlackjackConfig {
            starting_stack: self.starting_stack.unwrap_or(d.starting_stack),
            min_bet: self.min_bet.unwrap_or(d.min_bet),
            max_bet: self.max_bet.unwrap_or(d.max_bet),
            ..d
        };
        c.validate().map_err(GameRefusal::from)?;
        Ok(c)
    }
}

/// `TurnRef` on the wire: the decision a client was shown (`view.turn`) and
/// is answering. A stale one is refused with `stale_turn`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnWire {
    pub hand_no: u64,
    pub turn_seq: u64,
}

impl From<TurnRef> for TurnWire {
    fn from(t: TurnRef) -> Self {
        TurnWire { hand_no: t.hand_no, turn_seq: t.turn_seq }
    }
}

impl From<TurnWire> for TurnRef {
    fn from(t: TurnWire) -> Self {
        TurnRef { hand_no: t.hand_no, turn_seq: t.turn_seq }
    }
}

/// What a player does on their turn (`GameAct.action`). One list for both
/// games; an action of the other game is refused with `wrong_game`.
///
/// Hold'em: `fold`, `check`, `call`, `bet_or_raise_to {amount}` (the STREET
/// TOTAL, never an increment, so a retransmit cannot double-count) and
/// `all_in`. Blackjack: `hit`, `stand`, `double`, `split`. Note: the
/// Blackjack action `stand` (take no more cards) is NOT the `GameStand`
/// frame (get up from the table).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GameActionWire {
    Fold,
    Check,
    Call,
    BetOrRaiseTo { amount: u64 },
    AllIn,
    Hit,
    Stand,
    Double,
    Split,
}

impl GameActionWire {
    /// The Hold'em action, or `None` for a Blackjack one.
    pub fn holdem(self) -> Option<Action> {
        Some(match self {
            GameActionWire::Fold => Action::Fold,
            GameActionWire::Check => Action::Check,
            GameActionWire::Call => Action::Call,
            GameActionWire::BetOrRaiseTo { amount } => Action::BetOrRaiseTo(amount),
            GameActionWire::AllIn => Action::AllIn,
            GameActionWire::Hit | GameActionWire::Stand | GameActionWire::Double | GameActionWire::Split => return None,
        })
    }

    /// The Blackjack action, or `None` for a Hold'em one.
    pub fn blackjack(self) -> Option<BjAction> {
        Some(match self {
            GameActionWire::Hit => BjAction::Hit,
            GameActionWire::Stand => BjAction::Stand,
            GameActionWire::Double => BjAction::Double,
            GameActionWire::Split => BjAction::Split,
            GameActionWire::Fold
            | GameActionWire::Check
            | GameActionWire::Call
            | GameActionWire::BetOrRaiseTo { .. }
            | GameActionWire::AllIn => return None,
        })
    }
}

/// Which client frame a `GameRefused` answers, so the client can show the
/// refusal where the person acted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameOp {
    Create,
    Sit,
    Stand,
    Act,
    Bet,
    ClearBet,
    SitOut,
    SitIn,
    Rebuy,
    ShowCards,
    Resync,
    Close,
    RemovePlayer,
}

// ---------------------------------------------------------------------------
// Refusals

/// Why a game frame was refused (`GameRefused.code`, plus the numbers some
/// codes carry). Typed, never text: the client words each code. Expected
/// refusals - a call that already has a table, a bet below the minimum - are
/// these, never the generic `Error` frame the client shows as an alert.
///
/// A frame naming a table that is not open in that room (it closed, the
/// server restarted, the id is wrong) is NOT refused: it is answered with
/// `GameEnded { reason: gone }`, so the client drops the stale table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum GameRefusal {
    // -- The server's own gates (checked before the engine is asked).
    /// Games are switched off on this server (`servers.games_enabled`).
    Disabled,
    /// Missing `PLAY_GAMES` (with `CONNECT`) to open or sit; missing
    /// `MOVE_MEMBERS` to close a table or remove a player.
    NoPermission,
    /// This connection is not in that call (checked with `conns_of`, never
    /// the socket's own `joined_rooms`). Says nothing about whether the room
    /// has a table.
    NotInCall,
    /// `room_id` is not a voice room.
    NotAVoiceRoom,
    /// The owner's rule: one table per call. `open_table_id` / `kind` name
    /// the table that is open; it must close first.
    RoomHasTable { open_table_id: u64, kind: GameKindWire },
    /// The server-wide cap on open tables.
    TooManyTables,
    /// Too many tables opened (5 per 5 minutes per user), or resyncs (one a
    /// second per connection).
    RateLimited,
    /// An action, bet or request of the other game (`hit` at Poker, a bet
    /// or `show_cards` at Blackjack...).
    WrongGame,
    /// Act, stand, bet, sit out/in, rebuy or show without a seat.
    NotSeated,

    // -- Engine refusals, both games.
    InvalidConfig,
    ConfigLocked,
    SeatOutOfRange,
    SeatTaken,
    SeatEmpty,
    AlreadySeated,
    NotYourTurn,
    /// The `turn` names a decision that has passed. A client that double-
    /// submitted sees this; it should drop it silently.
    StaleTurn,
    /// Hold'em: busted and the table allows no rebuy. Blackjack: cannot
    /// cover the minimum bet.
    NoChips,
    NotBusted,
    RebuyNotAllowed,
    /// Hold'em: the smallest legal `bet_or_raise_to` total. Blackjack: the
    /// minimum bet.
    BetBelowMinimum { min: u64 },

    // -- Hold'em.
    HandInProgress,
    NoHandInProgress,
    NotEnoughPlayers,
    CannotCheck { to_call: u64 },
    NothingToCall,
    /// The largest street total this stack can reach.
    BetAboveStack { max: u64 },
    /// Facing only an incomplete raise after having acted: call or fold.
    RaiseNotReopened,
    /// Everyone else is all-in: call or fold.
    NobodyToRaise,
    NotShowable,

    // -- Blackjack.
    RoundInProgress,
    NoRoundInProgress,
    NoBets,
    BetAboveMaximum { max: u64 },
    InsufficientChips { stack: u64 },
    SittingOut,
    CannotHit,
    CannotDouble,
    CannotSplit,
}

impl From<OpenError> for GameRefusal {
    fn from(e: OpenError) -> Self {
        match e {
            OpenError::RoomHasTable { open, kind } => GameRefusal::RoomHasTable { open_table_id: open.0, kind: kind.into() },
            OpenError::TooManyTables { .. } => GameRefusal::TooManyTables,
        }
    }
}

impl From<HoldemError> for GameRefusal {
    fn from(e: HoldemError) -> Self {
        match e {
            HoldemError::InvalidConfig(_) => GameRefusal::InvalidConfig,
            HoldemError::ConfigLocked => GameRefusal::ConfigLocked,
            HoldemError::SeatOutOfRange => GameRefusal::SeatOutOfRange,
            HoldemError::SeatTaken => GameRefusal::SeatTaken,
            HoldemError::SeatEmpty => GameRefusal::SeatEmpty,
            HoldemError::AlreadySeated => GameRefusal::AlreadySeated,
            HoldemError::HandInProgress => GameRefusal::HandInProgress,
            HoldemError::NoHandInProgress => GameRefusal::NoHandInProgress,
            HoldemError::NotEnoughPlayers => GameRefusal::NotEnoughPlayers,
            HoldemError::NotYourTurn => GameRefusal::NotYourTurn,
            HoldemError::StaleTurn => GameRefusal::StaleTurn,
            HoldemError::CannotCheck { to_call } => GameRefusal::CannotCheck { to_call },
            HoldemError::NothingToCall => GameRefusal::NothingToCall,
            HoldemError::BetBelowMinimum { min_to } => GameRefusal::BetBelowMinimum { min: min_to },
            HoldemError::BetAboveStack { max_to } => GameRefusal::BetAboveStack { max: max_to },
            HoldemError::RaiseNotReopened => GameRefusal::RaiseNotReopened,
            HoldemError::NobodyToRaise => GameRefusal::NobodyToRaise,
            HoldemError::NoChips => GameRefusal::NoChips,
            HoldemError::NotBusted => GameRefusal::NotBusted,
            HoldemError::RebuyNotAllowed => GameRefusal::RebuyNotAllowed,
            HoldemError::NotShowable => GameRefusal::NotShowable,
        }
    }
}

impl From<BjError> for GameRefusal {
    fn from(e: BjError) -> Self {
        match e {
            BjError::InvalidConfig(_) => GameRefusal::InvalidConfig,
            BjError::ConfigLocked => GameRefusal::ConfigLocked,
            BjError::SeatOutOfRange => GameRefusal::SeatOutOfRange,
            BjError::SeatTaken => GameRefusal::SeatTaken,
            BjError::SeatEmpty => GameRefusal::SeatEmpty,
            BjError::AlreadySeated => GameRefusal::AlreadySeated,
            BjError::RoundInProgress => GameRefusal::RoundInProgress,
            BjError::NoRoundInProgress => GameRefusal::NoRoundInProgress,
            BjError::NoBets => GameRefusal::NoBets,
            BjError::BetBelowMinimum { min } => GameRefusal::BetBelowMinimum { min },
            BjError::BetAboveMaximum { max } => GameRefusal::BetAboveMaximum { max },
            BjError::InsufficientChips { stack } => GameRefusal::InsufficientChips { stack },
            BjError::SittingOut => GameRefusal::SittingOut,
            BjError::NotYourTurn => GameRefusal::NotYourTurn,
            BjError::StaleTurn => GameRefusal::StaleTurn,
            BjError::CannotHit => GameRefusal::CannotHit,
            BjError::CannotDouble => GameRefusal::CannotDouble,
            BjError::CannotSplit => GameRefusal::CannotSplit,
            BjError::NoChips => GameRefusal::NoChips,
            BjError::NotBusted => GameRefusal::NotBusted,
            BjError::RebuyNotAllowed => GameRefusal::RebuyNotAllowed,
        }
    }
}

/// Why a table ended (`GameEnded.reason`). Every connection that could see
/// the table is told once; the client drops the table and says why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameEndReason {
    /// Closed by someone holding `MOVE_MEMBERS` (`GameClose`).
    Closed,
    /// The call emptied and stayed empty for one rejoin grace.
    CallEnded,
    /// Nobody sat at the table for the idle limit, so it stopped holding the
    /// call's one table slot.
    Idle,
    /// The owner switched games off for this server.
    Disabled,
    /// The voice channel was deleted.
    ChannelDeleted,
    /// The answer to a frame naming a table that is not open in that room:
    /// it closed while this client was not listening, or the server
    /// restarted (every restart ends every table). The server cannot tell
    /// those apart, so it does not pretend to.
    Gone,
}

// ---------------------------------------------------------------------------
// Views

/// Server-side facts a view shows that the engine does not hold.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ViewExtras {
    /// Seats whose player has dropped out of the call and is inside the
    /// disconnect grace (their seat, stack and cards are kept).
    pub away: Vec<usize>,
    /// Milliseconds left on the current turn's clock (`view.turn`), relative
    /// so a client's clock skew cannot shift it.
    pub clock_ms: Option<u64>,
    /// Milliseconds until the server deals the next hand / round, when one
    /// is scheduled.
    pub next_deal_in_ms: Option<u64>,
}

/// The table as ONE connection may see it. Tagged by `game`.
///
/// `Debug` is REDACTED, like the engine's tables: a view can hold the
/// viewer's hole cards, so a stray `{:?}` of a frame must not log them. The
/// view structs below carry no `Debug` at all, so nothing can print one
/// field by field either.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "game", rename_all = "snake_case")]
pub enum GameView {
    Holdem(HoldemViewWire),
    Blackjack(BlackjackViewWire),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HoldemConfigWire {
    pub max_seats: usize,
    pub starting_stack: u64,
    pub small_blind: u64,
    pub big_blind: u64,
    pub turn_clock_secs: u32,
    pub timeouts_before_sit_out: u8,
    pub allow_rebuy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreetWire {
    Preflop,
    Flop,
    Turn,
    River,
    Showdown,
}

impl From<Street> for StreetWire {
    fn from(s: Street) -> Self {
        match s {
            Street::Preflop => StreetWire::Preflop,
            Street::Flop => StreetWire::Flop,
            Street::Turn => StreetWire::Turn,
            Street::River => StreetWire::River,
            Street::Showdown => StreetWire::Showdown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeatStatusWire {
    Waiting,
    SittingOut,
    InHand,
    Folded,
    AllIn,
}

impl From<SeatStatus> for SeatStatusWire {
    fn from(s: SeatStatus) -> Self {
        match s {
            SeatStatus::Waiting => SeatStatusWire::Waiting,
            SeatStatus::SittingOut => SeatStatusWire::SittingOut,
            SeatStatus::InHand => SeatStatusWire::InHand,
            SeatStatus::Folded => SeatStatusWire::Folded,
            SeatStatus::AllIn => SeatStatusWire::AllIn,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct HoldemSeatWire {
    pub seat: usize,
    pub user_id: UserId,
    pub stack: u64,
    pub status: SeatStatusWire,
    pub street_commit: u64,
    pub hand_commit: u64,
    /// `null`: not dealt into the live hand (or folded, or between hands
    /// with nothing shown). `["??","??"]`: in the live hand, face down.
    /// Real codes: the VIEWER's own hand, or a hand that was shown.
    pub cards: Option<Vec<String>>,
    pub sitting_out: bool,
    pub leaving: bool,
    /// In the disconnect grace (`ViewExtras::away`).
    pub away: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LegalWire {
    pub to_call: u64,
    pub can_check: bool,
    pub call_amount: u64,
    pub can_raise: bool,
    pub min_raise_to: u64,
    pub max_raise_to: u64,
}

/// A live pot (`HoldemViewWire::pots`): pot 0 is the main pot, every one after
/// it a side pot. `eligible`: the seats that can still win it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PotWire {
    pub amount: u64,
    pub eligible: Vec<usize>,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct HoldemViewWire {
    /// The viewer's seat, or `null` for a spectator.
    pub viewer_seat: Option<usize>,
    pub config: HoldemConfigWire,
    /// 0 before the first hand.
    pub hand_no: u64,
    pub in_hand: bool,
    pub street: Option<StreetWire>,
    pub button: Option<usize>,
    pub small_blind_seat: Option<usize>,
    pub big_blind_seat: Option<usize>,
    /// `max_seats` entries; `null` is an empty seat.
    pub seats: Vec<Option<HoldemSeatWire>>,
    pub board: Vec<String>,
    /// Everything put in this hand, this street's bets included.
    pub pot_total: u64,
    /// The main pot and the side pots from the streets that have closed
    /// (this street's bets are each seat's `street_commit` until it closes);
    /// empty between hands. ADDED after 0.9.833: an older client ignores it
    /// (unknown fields are), and a newer client facing an older server reads
    /// its absence as "no breakdown" and shows `pot_total` alone.
    pub pots: Vec<PotWire>,
    pub current_bet: u64,
    pub to_act: Option<usize>,
    pub turn: Option<TurnWire>,
    /// Only in the view of the seat whose turn it is.
    pub legal: Option<LegalWire>,
    pub clock_ms: Option<u64>,
    pub next_deal_in_ms: Option<u64>,
}

/// The Hold'em view for one connection: `view` is `view_for(seat)` for a
/// seated viewer and `view_for(None)` for everyone else.
pub fn holdem_view(view: &HoldemView, extras: &ViewExtras) -> GameView {
    let c = &view.config;
    let seats = view
        .seats
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let s = s.as_ref()?;
            let own = view.viewer == Some(i);
            let cards = own
                .then_some(view.my_cards)
                .flatten()
                .or(s.shown)
                .map(codes)
                .or_else(|| {
                    matches!(s.status, SeatStatus::InHand | SeatStatus::AllIn)
                        .then(|| vec![HIDDEN_CODE.to_string(), HIDDEN_CODE.to_string()])
                });
            Some(HoldemSeatWire {
                seat: i,
                user_id: user_of(s.player),
                stack: s.stack,
                status: s.status.into(),
                street_commit: s.street_commit,
                hand_commit: s.hand_commit,
                cards,
                sitting_out: s.sitting_out,
                leaving: s.leaving,
                away: extras.away.contains(&i),
            })
        })
        .collect();
    GameView::Holdem(HoldemViewWire {
        viewer_seat: view.viewer,
        config: HoldemConfigWire {
            max_seats: c.max_seats,
            starting_stack: c.starting_stack,
            small_blind: c.small_blind,
            big_blind: c.big_blind,
            turn_clock_secs: c.turn_clock_secs,
            timeouts_before_sit_out: c.timeouts_before_sit_out,
            allow_rebuy: c.allow_rebuy,
        },
        hand_no: view.hand_no,
        in_hand: view.in_hand,
        street: view.street.map(Into::into),
        button: view.button,
        small_blind_seat: view.small_blind_seat,
        big_blind_seat: view.big_blind_seat,
        seats,
        board: view.board.iter().map(|&c| code(c)).collect(),
        pot_total: view.pot_total,
        pots: view.pots.iter().map(|p| PotWire { amount: p.amount, eligible: p.eligible.clone() }).collect(),
        current_bet: view.current_bet,
        to_act: view.to_act,
        turn: view.turn.map(Into::into),
        legal: view.legal.map(|l| LegalWire {
            to_call: l.to_call,
            can_check: l.can_check,
            call_amount: l.call_amount,
            can_raise: l.can_raise,
            min_raise_to: l.min_raise_to,
            max_raise_to: l.max_raise_to,
        }),
        clock_ms: extras.clock_ms,
        next_deal_in_ms: extras.next_deal_in_ms,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BlackjackConfigWire {
    pub max_seats: usize,
    pub starting_stack: u64,
    pub min_bet: u64,
    pub max_bet: u64,
    pub decks: u8,
    pub penetration_percent: u8,
    pub dealer_hits_soft_17: bool,
    /// `[numerator, denominator]`: `[3, 2]`.
    pub blackjack_pays: [u64; 2],
    pub double_after_split: bool,
    pub max_hands: u8,
    pub resplit_aces: bool,
    pub turn_clock_secs: u32,
    pub timeouts_before_sit_out: u8,
    pub allow_rebuy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeWire {
    Blackjack,
    Win,
    Push,
    Lose,
}

impl fmt::Debug for GameView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GameView::Holdem(v) => f
                .debug_struct("HoldemView")
                .field("viewer_seat", &v.viewer_seat)
                .field("hand_no", &v.hand_no)
                .field("in_hand", &v.in_hand)
                .finish_non_exhaustive(),
            GameView::Blackjack(v) => f
                .debug_struct("BlackjackView")
                .field("viewer_seat", &v.viewer_seat)
                .field("round_no", &v.round_no)
                .field("in_round", &v.in_round)
                .finish_non_exhaustive(),
        }
    }
}

impl From<Outcome> for OutcomeWire {
    fn from(o: Outcome) -> Self {
        match o {
            Outcome::Blackjack => OutcomeWire::Blackjack,
            Outcome::Win => OutcomeWire::Win,
            Outcome::Push => OutcomeWire::Push,
            Outcome::Lose => OutcomeWire::Lose,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct BjHandWire {
    pub cards: Vec<String>,
    pub bet: u64,
    pub doubled: bool,
    pub from_split: bool,
    pub total: u8,
    pub soft: bool,
    pub done: bool,
    pub outcome: Option<OutcomeWire>,
    /// What came back to the stack, bet included, once settled.
    pub returned: Option<u64>,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct BjSeatWire {
    pub seat: usize,
    pub user_id: UserId,
    pub stack: u64,
    /// The bet placed for the next round (already out of `stack`).
    pub pending_bet: u64,
    /// This round's hands, or the last round's until the next deal.
    pub hands: Vec<BjHandWire>,
    pub sitting_out: bool,
    pub leaving: bool,
    pub away: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct BjSpotWire {
    pub seat: usize,
    pub hand: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BjLegalWire {
    pub can_hit: bool,
    pub can_stand: bool,
    pub can_double: bool,
    pub can_split: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct BlackjackViewWire {
    pub viewer_seat: Option<usize>,
    pub config: BlackjackConfigWire,
    pub round_no: u64,
    pub in_round: bool,
    pub seats: Vec<Option<BjSeatWire>>,
    /// The dealer's cards; the face-down hole card is `"??"`.
    pub dealer: Vec<String>,
    /// Known once the hole card is turned.
    pub dealer_total: Option<u8>,
    pub to_act: Option<BjSpotWire>,
    pub turn: Option<TurnWire>,
    pub shoe_remaining: usize,
    pub shoe_size: usize,
    pub reshuffle_due: bool,
    /// Only in the view of the seat whose turn it is.
    pub legal: Option<BjLegalWire>,
    pub clock_ms: Option<u64>,
    pub next_deal_in_ms: Option<u64>,
}

/// The Blackjack view for one connection. The engine has ONE public view
/// (every player card is dealt face up; the hole card is `None` until the
/// dealer turns it); `viewer` only labels it and decides who sees `legal`.
pub fn blackjack_view(view: &BlackjackView, viewer: Option<usize>, extras: &ViewExtras) -> GameView {
    let c = &view.config;
    let seats = view
        .seats
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let s = s.as_ref()?;
            Some(BjSeatWire {
                seat: i,
                user_id: user_of(s.player),
                stack: s.stack,
                pending_bet: s.pending_bet,
                hands: s
                    .hands
                    .iter()
                    .map(|h| BjHandWire {
                        cards: h.cards.iter().map(|&c| code(c)).collect(),
                        bet: h.bet,
                        doubled: h.doubled,
                        from_split: h.from_split,
                        total: h.total,
                        soft: h.soft,
                        done: h.done,
                        outcome: h.outcome.map(Into::into),
                        returned: h.returned,
                    })
                    .collect(),
                sitting_out: s.sitting_out,
                leaving: s.leaving,
                away: extras.away.contains(&i),
            })
        })
        .collect();
    let my_turn = viewer.is_some() && view.to_act.map(|(s, _)| s) == viewer;
    GameView::Blackjack(BlackjackViewWire {
        viewer_seat: viewer,
        config: BlackjackConfigWire {
            max_seats: c.max_seats,
            starting_stack: c.starting_stack,
            min_bet: c.min_bet,
            max_bet: c.max_bet,
            decks: c.decks,
            penetration_percent: c.penetration_percent,
            dealer_hits_soft_17: c.dealer_hits_soft_17,
            blackjack_pays: [c.blackjack_pays.0, c.blackjack_pays.1],
            double_after_split: c.double_after_split,
            max_hands: c.max_hands,
            resplit_aces: c.resplit_aces,
            turn_clock_secs: c.turn_clock_secs,
            timeouts_before_sit_out: c.timeouts_before_sit_out,
            allow_rebuy: c.allow_rebuy,
        },
        round_no: view.round_no,
        in_round: view.in_round,
        seats,
        dealer: view.dealer.iter().map(|c| c.map_or_else(|| HIDDEN_CODE.to_string(), code)).collect(),
        dealer_total: view.dealer_total,
        to_act: view.to_act.map(|(seat, hand)| BjSpotWire { seat, hand }),
        turn: view.turn.map(Into::into),
        shoe_remaining: view.shoe_remaining,
        shoe_size: view.shoe_size,
        reshuffle_due: view.reshuffle_due,
        legal: view.legal.filter(|_| my_turn).map(|l| BjLegalWire {
            can_hit: l.can_hit,
            can_stand: l.can_stand,
            can_double: l.can_double,
            can_split: l.can_split,
        }),
        clock_ms: extras.clock_ms,
        next_deal_in_ms: extras.next_deal_in_ms,
    })
}

// ---------------------------------------------------------------------------
// Events

/// One engine call's public events, as a JSON array. Every event is safe for
/// every connection at the table: none carries a hidden card except
/// `showdown` / `shown` (exactly the hands that were shown) and the Blackjack
/// hole card, which is dealt as `"??"` and named only by `dealer_revealed`.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum GameEventsWire {
    Holdem(Vec<HoldemEventWire>),
    Blackjack(Vec<BjEventWire>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SitOutReasonWire {
    Requested,
    Timeouts,
    Busted,
}

/// Why something happened: the player chose, their clock ran out, or they
/// left - so the table says "timed out" instead of pretending they chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActReasonWire {
    Player,
    Timeout,
    Left,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActedKindWire {
    Fold,
    Check,
    Call,
    Bet,
    Raise,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandCategoryWire {
    HighCard,
    OnePair,
    TwoPair,
    ThreeOfAKind,
    Straight,
    Flush,
    FullHouse,
    FourOfAKind,
    StraightFlush,
}

impl From<Category> for HandCategoryWire {
    fn from(c: Category) -> Self {
        match c {
            Category::HighCard => HandCategoryWire::HighCard,
            Category::OnePair => HandCategoryWire::OnePair,
            Category::TwoPair => HandCategoryWire::TwoPair,
            Category::ThreeOfAKind => HandCategoryWire::ThreeOfAKind,
            Category::Straight => HandCategoryWire::Straight,
            Category::Flush => HandCategoryWire::Flush,
            Category::FullHouse => HandCategoryWire::FullHouse,
            Category::FourOfAKind => HandCategoryWire::FourOfAKind,
            Category::StraightFlush => HandCategoryWire::StraightFlush,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct ShownHandWire {
    pub seat: usize,
    pub cards: Vec<String>,
    pub category: HandCategoryWire,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PotShareWire {
    pub seat: usize,
    pub amount: u64,
}

/// A Hold'em event (`crates/puca-games/src/holdem/mod.rs`, `Event`).
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HoldemEventWire {
    PlayerSat { seat: usize, user_id: UserId, stack: u64 },
    /// The seat is empty now; `stack` left with the player.
    PlayerLeft { seat: usize, user_id: UserId, stack: u64 },
    SatOut { seat: usize, reason: SitOutReasonWire },
    SatIn { seat: usize },
    Rebought { seat: usize, stack: u64 },
    HandStarted { hand_no: u64, button: usize, small_blind: Option<usize>, big_blind: usize, dealt: Vec<usize> },
    BlindPosted { seat: usize, amount: u64, all_in: bool },
    Acted { seat: usize, kind: ActedKindWire, added: u64, street_commit: u64, all_in: bool, reason: ActReasonWire },
    BoardDealt { street: StreetWire, cards: Vec<String> },
    UncalledReturned { seat: usize, amount: u64 },
    /// `shown` in showdown order; `mucked` seats are never revealed.
    Showdown { shown: Vec<ShownHandWire>, mucked: Vec<usize> },
    /// Pot 0 is the main pot.
    PotAwarded { pot: usize, amount: u64, eligible: Vec<usize>, shares: Vec<PotShareWire> },
    /// Shown voluntarily after the hand.
    Shown { seat: usize, cards: Vec<String> },
    HandEnded { hand_no: u64 },
}

/// Redacted: counts only (events carry shown cards and the board).
impl fmt::Debug for GameEventsWire {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GameEventsWire::Holdem(e) => write!(f, "HoldemEvents({} events)", e.len()),
            GameEventsWire::Blackjack(e) => write!(f, "BlackjackEvents({} events)", e.len()),
        }
    }
}

pub fn holdem_event(e: &Event) -> HoldemEventWire {
    use HoldemEventWire as W;
    match e {
        Event::PlayerSat { seat, player, stack } => W::PlayerSat { seat: *seat, user_id: user_of(*player), stack: *stack },
        Event::PlayerLeft { seat, player, stack } => W::PlayerLeft { seat: *seat, user_id: user_of(*player), stack: *stack },
        Event::SatOut { seat, reason } => W::SatOut {
            seat: *seat,
            reason: match reason {
                SitOutReason::Requested => SitOutReasonWire::Requested,
                SitOutReason::Timeouts => SitOutReasonWire::Timeouts,
                SitOutReason::Busted => SitOutReasonWire::Busted,
            },
        },
        Event::SatIn { seat } => W::SatIn { seat: *seat },
        Event::Rebought { seat, stack } => W::Rebought { seat: *seat, stack: *stack },
        Event::HandStarted { hand_no, button, small_blind, big_blind, dealt } => W::HandStarted {
            hand_no: *hand_no,
            button: *button,
            small_blind: *small_blind,
            big_blind: *big_blind,
            dealt: dealt.clone(),
        },
        Event::BlindPosted { seat, amount, all_in } => W::BlindPosted { seat: *seat, amount: *amount, all_in: *all_in },
        Event::Acted { seat, kind, added, street_commit, all_in, reason } => W::Acted {
            seat: *seat,
            kind: match kind {
                ActedKind::Fold => ActedKindWire::Fold,
                ActedKind::Check => ActedKindWire::Check,
                ActedKind::Call => ActedKindWire::Call,
                ActedKind::Bet => ActedKindWire::Bet,
                ActedKind::Raise => ActedKindWire::Raise,
            },
            added: *added,
            street_commit: *street_commit,
            all_in: *all_in,
            reason: match reason {
                ActReason::Player => ActReasonWire::Player,
                ActReason::Timeout => ActReasonWire::Timeout,
                ActReason::Left => ActReasonWire::Left,
            },
        },
        Event::BoardDealt { street, cards } => {
            W::BoardDealt { street: (*street).into(), cards: cards.iter().map(|&c| code(c)).collect() }
        }
        Event::UncalledReturned { seat, amount } => W::UncalledReturned { seat: *seat, amount: *amount },
        Event::Showdown { shown, mucked } => W::Showdown {
            shown: shown
                .iter()
                .map(|h| ShownHandWire { seat: h.seat, cards: codes(h.cards), category: h.value.category().into() })
                .collect(),
            mucked: mucked.clone(),
        },
        Event::PotAwarded { pot, amount, eligible, shares } => W::PotAwarded {
            pot: *pot,
            amount: *amount,
            eligible: eligible.clone(),
            shares: shares.iter().map(|s| PotShareWire { seat: s.seat, amount: s.amount }).collect(),
        },
        Event::Shown { seat, cards } => W::Shown { seat: *seat, cards: codes(*cards) },
        Event::HandEnded { hand_no } => W::HandEnded { hand_no: *hand_no },
    }
}

pub fn holdem_events(events: &[Event]) -> GameEventsWire {
    GameEventsWire::Holdem(events.iter().map(holdem_event).collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BjActionWire {
    Hit,
    Stand,
    Double,
    Split,
}

/// A Blackjack event (`crates/puca-games/src/blackjack/mod.rs`, `BjEvent`).
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BjEventWire {
    PlayerSat { seat: usize, user_id: UserId, stack: u64 },
    PlayerLeft { seat: usize, user_id: UserId, stack: u64 },
    SatOut { seat: usize, reason: SitOutReasonWire },
    SatIn { seat: usize },
    Rebought { seat: usize, stack: u64 },
    BetPlaced { seat: usize, amount: u64 },
    BetCleared { seat: usize, amount: u64 },
    /// `cards_in_shoe`: how many cards were shuffled (the whole shoe, or
    /// the discard tray mid-round).
    ShoeShuffled { cards_in_shoe: usize, mid_round: bool },
    RoundStarted { round_no: u64, seats: Vec<usize> },
    /// `seat` / `hand` are `null` for a card to the DEALER. The hole card is
    /// dealt as `"??"`; `dealer_revealed` names it later.
    CardDealt { seat: Option<usize>, hand: Option<usize>, card: String },
    DealerPeeked { blackjack: bool },
    Acted { seat: usize, hand: usize, action: BjActionWire, reason: ActReasonWire },
    DealerRevealed { card: String },
    /// `returned` is what came back to the stack, bet included.
    HandSettled { seat: usize, hand: usize, outcome: OutcomeWire, bet: u64, returned: u64 },
    RoundEnded { round_no: u64, dealer_total: u8, dealer_bust: bool },
}

pub fn blackjack_event(e: &BjEvent) -> BjEventWire {
    use BjEventWire as W;
    match e {
        BjEvent::PlayerSat { seat, player, stack } => W::PlayerSat { seat: *seat, user_id: user_of(*player), stack: *stack },
        BjEvent::PlayerLeft { seat, player, stack } => W::PlayerLeft { seat: *seat, user_id: user_of(*player), stack: *stack },
        BjEvent::SatOut { seat, reason } => W::SatOut {
            seat: *seat,
            reason: match reason {
                BjSitOutReason::Requested => SitOutReasonWire::Requested,
                BjSitOutReason::Timeouts => SitOutReasonWire::Timeouts,
                BjSitOutReason::Busted => SitOutReasonWire::Busted,
            },
        },
        BjEvent::SatIn { seat } => W::SatIn { seat: *seat },
        BjEvent::Rebought { seat, stack } => W::Rebought { seat: *seat, stack: *stack },
        BjEvent::BetPlaced { seat, amount } => W::BetPlaced { seat: *seat, amount: *amount },
        BjEvent::BetCleared { seat, amount } => W::BetCleared { seat: *seat, amount: *amount },
        BjEvent::ShoeShuffled { cards, mid_round } => W::ShoeShuffled { cards_in_shoe: *cards, mid_round: *mid_round },
        BjEvent::RoundStarted { round_no, seats } => W::RoundStarted { round_no: *round_no, seats: seats.clone() },
        BjEvent::CardDealt { to, card } => {
            let (seat, hand) = match to {
                BjTarget::Seat { seat, hand } => (Some(*seat), Some(*hand)),
                BjTarget::Dealer => (None, None),
            };
            W::CardDealt { seat, hand, card: card.map_or_else(|| HIDDEN_CODE.to_string(), code) }
        }
        BjEvent::DealerPeeked { blackjack } => W::DealerPeeked { blackjack: *blackjack },
        BjEvent::Acted { seat, hand, action, reason } => W::Acted {
            seat: *seat,
            hand: *hand,
            action: match action {
                BjAction::Hit => BjActionWire::Hit,
                BjAction::Stand => BjActionWire::Stand,
                BjAction::Double => BjActionWire::Double,
                BjAction::Split => BjActionWire::Split,
            },
            reason: match reason {
                BjActReason::Player => ActReasonWire::Player,
                BjActReason::Timeout => ActReasonWire::Timeout,
                BjActReason::Left => ActReasonWire::Left,
            },
        },
        BjEvent::DealerRevealed { card } => W::DealerRevealed { card: code(*card) },
        BjEvent::HandSettled { seat, hand, outcome, bet, returned } => W::HandSettled {
            seat: *seat,
            hand: *hand,
            outcome: (*outcome).into(),
            bet: *bet,
            returned: *returned,
        },
        BjEvent::RoundEnded { round_no, dealer_total, dealer_bust } => {
            W::RoundEnded { round_no: *round_no, dealer_total: *dealer_total, dealer_bust: *dealer_bust }
        }
    }
}

pub fn blackjack_events(events: &[BjEvent]) -> GameEventsWire {
    GameEventsWire::Blackjack(events.iter().map(blackjack_event).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_user_id_maps_to_a_distinct_player_and_back() {
        for u in [0_i64, 1, 7, 2_147_483_647, i64::MAX, -1, i64::MIN] {
            assert_eq!(user_of(player_id(u)), u, "{u}");
        }
        assert_ne!(player_id(1), player_id(2));
        assert_ne!(player_id(-1), player_id(1));
    }

    #[test]
    fn config_defaults_are_the_owners_table_and_wrong_game_fields_are_refused() {
        let h = GameConfigWire::default().holdem().unwrap();
        assert_eq!((h.max_seats, h.starting_stack, h.small_blind, h.big_blind), (6, 1_000, 5, 10));
        let b = GameConfigWire::default().blackjack().unwrap();
        assert_eq!((b.decks, b.dealer_hits_soft_17, b.blackjack_pays, b.max_hands), (6, false, (3, 2), 4));
        assert!(!b.resplit_aces);
        // The opener's own stakes are taken...
        let h = GameConfigWire { starting_stack: Some(2_000), small_blind: Some(10), big_blind: Some(20), ..Default::default() }
            .holdem()
            .unwrap();
        assert_eq!((h.starting_stack, h.small_blind, h.big_blind), (2_000, 10, 20));
        // ...a field of the other game is refused, not ignored...
        let mixed = GameConfigWire { min_bet: Some(10), ..Default::default() };
        assert_eq!(mixed.holdem(), Err(GameRefusal::InvalidConfig));
        let mixed = GameConfigWire { big_blind: Some(10), ..Default::default() };
        assert_eq!(mixed.blackjack(), Err(GameRefusal::InvalidConfig));
        // ...and the engine's own validation still applies.
        let silly = GameConfigWire { small_blind: Some(50), big_blind: Some(10), ..Default::default() };
        assert_eq!(silly.holdem(), Err(GameRefusal::InvalidConfig));
        let silly = GameConfigWire { min_bet: Some(600), ..Default::default() };
        assert_eq!(silly.blackjack(), Err(GameRefusal::InvalidConfig));
    }

    #[test]
    fn each_action_belongs_to_exactly_one_game() {
        let all = [
            GameActionWire::Fold,
            GameActionWire::Check,
            GameActionWire::Call,
            GameActionWire::BetOrRaiseTo { amount: 60 },
            GameActionWire::AllIn,
            GameActionWire::Hit,
            GameActionWire::Stand,
            GameActionWire::Double,
            GameActionWire::Split,
        ];
        for a in all {
            assert!(a.holdem().is_some() != a.blackjack().is_some(), "{a:?}");
        }
        assert_eq!(GameActionWire::BetOrRaiseTo { amount: 60 }.holdem(), Some(Action::BetOrRaiseTo(60)));
        assert_eq!(GameActionWire::Stand.blackjack(), Some(BjAction::Stand));
    }

    /// A frame holding the viewer's own hole cards, the board and shown
    /// hands, formatted with `{:?}`, prints none of them: the engine's
    /// redacted-Debug promise survives the translation.
    #[test]
    fn a_debug_printed_frame_holds_no_card() {
        use puca_games::holdem::HoldemTable;
        let mut t = HoldemTable::new(HoldemConfig::default()).unwrap();
        t.sit(0, player_id(7)).unwrap();
        t.sit(1, player_id(8)).unwrap();
        let ev = t.start_hand(&mut puca_games::rng::seeded(5)).unwrap();
        let view = t.view_for(Some(0));
        let mine: Vec<String> = view.my_cards.unwrap().iter().map(|c| c.to_string()).collect();
        let frame = crate::protocol::ServerMessage::GameEvents {
            room_id: "voice_1".into(),
            table_id: 9,
            version: 2,
            events: holdem_events(&ev),
            view: holdem_view(&view, &ViewExtras::default()),
        };
        let printed = format!("{frame:?}");
        // Positive control: the same frame serialised DOES carry the cards.
        let wire = serde_json::to_string(&frame).unwrap();
        for c in &mine {
            assert!(wire.contains(c.as_str()), "{c} missing from the wire: the control is broken");
            assert!(!printed.contains(c.as_str()), "{c} in {printed}");
        }
        assert!(printed.contains("HoldemView") && printed.contains("events"), "{printed}");
    }

    /// The live pots the engine reports reach the wire as they are, main pot
    /// first, each with the seats that can win it.
    #[test]
    fn side_pots_reach_the_wire_with_who_can_win_them() {
        use puca_games::holdem::{HoldemTable, PotView};
        let mut t = HoldemTable::new(HoldemConfig::default()).unwrap();
        t.sit(0, player_id(7)).unwrap();
        t.sit(1, player_id(8)).unwrap();
        t.start_hand(&mut puca_games::rng::seeded(5)).unwrap();
        let mut view = t.view_for(None);
        view.pots = vec![PotView { amount: 300, eligible: vec![0, 1, 2] }, PotView { amount: 450, eligible: vec![1, 2] }];
        let wire = serde_json::to_value(holdem_view(&view, &ViewExtras::default())).unwrap();
        assert_eq!(
            wire["pots"],
            serde_json::json!([{"amount": 300, "eligible": [0, 1, 2]}, {"amount": 450, "eligible": [1, 2]}])
        );
        // And an engine table's own (empty, preflop) pots are an empty list,
        // never a missing field.
        let fresh = serde_json::to_value(holdem_view(&t.view_for(None), &ViewExtras::default())).unwrap();
        assert_eq!(fresh["pots"], serde_json::json!([]));
    }

    #[test]
    fn engine_refusals_keep_their_numbers() {
        assert_eq!(GameRefusal::from(HoldemError::BetBelowMinimum { min_to: 40 }), GameRefusal::BetBelowMinimum { min: 40 });
        assert_eq!(GameRefusal::from(HoldemError::BetAboveStack { max_to: 990 }), GameRefusal::BetAboveStack { max: 990 });
        assert_eq!(GameRefusal::from(HoldemError::CannotCheck { to_call: 10 }), GameRefusal::CannotCheck { to_call: 10 });
        assert_eq!(GameRefusal::from(BjError::InsufficientChips { stack: 5 }), GameRefusal::InsufficientChips { stack: 5 });
        assert_eq!(
            GameRefusal::from(OpenError::RoomHasTable { open: puca_games::registry::TableId(9), kind: GameKind::Blackjack }),
            GameRefusal::RoomHasTable { open_table_id: 9, kind: GameKindWire::Blackjack }
        );
    }
}
