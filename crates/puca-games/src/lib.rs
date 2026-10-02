//! Pure game engines for Púca's in-call card games: No-Limit Texas Hold'em
//! ([`holdem`]) and Blackjack against the house ([`blackjack`]).
//!
//! WHAT THIS CRATE IS. The rules, and only the rules. No I/O, no async, no
//! clock, no global state, and no randomness of its own: every shuffle takes a
//! [`GameRng`] from the caller. Production passes the OS CSPRNG
//! ([`rng::os_rng`]); tests pass a seeded generator, so every hand in the test
//! suite is reproducible from its seed. Time is the caller's too: a turn clock
//! is a [`TurnRef`] the server schedules a timer for, and hands back on expiry.
//!
//! WHAT IT IS NOT. Not the server wiring (tables bound to a voice room,
//! per-connection fan-out, permissions, disconnect grace) and not the UI —
//! `docs/GAMES.md` designs those. The engine's contract with that layer is:
//!
//! * every mutation is a method returning `Result<Vec<Event>, Error>`; an
//!   `Err` leaves the table exactly as it was;
//! * events are PUBLIC — safe to send to everyone at the table — and never
//!   carry a hidden card;
//! * hidden information leaves the engine only through a per-seat view
//!   ([`holdem::HoldemTable::view_for`]): a view for seat A never contains
//!   seat B's hole cards unless B's hand was shown at showdown;
//! * the tables' `Debug` output is redacted, so a stray `tracing::debug!` of a
//!   table cannot log the deck;
//! * a call holds at most ONE table at a time, of either game
//!   ([`registry::RoomTables`]; the owner's rule).
//!
//! Chips are free and per table: everyone sits down with the same stack and
//! nothing persists when the table closes. There is no API that buys, sells,
//! or transfers chips other than by playing a hand.

#![forbid(unsafe_code)]

pub mod blackjack;
pub mod cards;
pub mod eval;
pub mod holdem;
pub mod registry;
pub mod rng;

pub use cards::{Card, Rank, Suit};
pub use rng::GameRng;

/// An opaque player identity. The engine only compares it (one seat per
/// player per table); the server maps it to a user id (a UUID fits in 128
/// bits).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PlayerId(pub u128);

/// Names ONE decision: hand (or round) number plus the turn sequence within
/// it. A client action and a turn-clock expiry both carry the `TurnRef` they
/// were issued for, and the engine refuses one that no longer matches — so a
/// delayed "Call 10" can never be applied to a later "Call 500", and a timer
/// that fires after the player already acted is a harmless no-op.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TurnRef {
    pub hand_no: u64,
    pub turn_seq: u64,
}
