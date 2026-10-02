//! Cards and their fixed-width encoding.
//!
//! A card is one byte, `rank * 4 + suit`, so a 52-card deck is `0..52`. On
//! the wire a card is ALWAYS two ASCII characters — rank then suit, `"Ah"`,
//! `"Td"`, `"2c"` — with ten written `T`, never `10`. Fixed width is a
//! privacy property, not a style choice: with `"10h"` a frame carrying a ten
//! would be one byte longer than any other, and frame length is visible to
//! anything that can see the encrypted transport's record sizes. A hidden
//! card is [`HIDDEN_CODE`], also two characters.

use std::fmt;

/// The two-character stand-in for a face-down card.
pub const HIDDEN_CODE: &str = "??";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Rank {
    Two = 0,
    Three,
    Four,
    Five,
    Six,
    Seven,
    Eight,
    Nine,
    Ten,
    Jack,
    Queen,
    King,
    Ace,
}

impl Rank {
    pub const ALL: [Rank; 13] = [
        Rank::Two,
        Rank::Three,
        Rank::Four,
        Rank::Five,
        Rank::Six,
        Rank::Seven,
        Rank::Eight,
        Rank::Nine,
        Rank::Ten,
        Rank::Jack,
        Rank::Queen,
        Rank::King,
        Rank::Ace,
    ];

    /// `0` for Two up to `12` for Ace.
    pub const fn index(self) -> u8 {
        self as u8
    }

    pub fn from_index(i: u8) -> Option<Rank> {
        Rank::ALL.get(i as usize).copied()
    }

    pub const fn to_char(self) -> char {
        match self {
            Rank::Two => '2',
            Rank::Three => '3',
            Rank::Four => '4',
            Rank::Five => '5',
            Rank::Six => '6',
            Rank::Seven => '7',
            Rank::Eight => '8',
            Rank::Nine => '9',
            Rank::Ten => 'T',
            Rank::Jack => 'J',
            Rank::Queen => 'Q',
            Rank::King => 'K',
            Rank::Ace => 'A',
        }
    }

    pub fn from_char(c: char) -> Option<Rank> {
        Rank::ALL.iter().copied().find(|r| r.to_char() == c)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Suit {
    Clubs = 0,
    Diamonds,
    Hearts,
    Spades,
}

impl Suit {
    pub const ALL: [Suit; 4] = [Suit::Clubs, Suit::Diamonds, Suit::Hearts, Suit::Spades];

    pub const fn index(self) -> u8 {
        self as u8
    }

    pub const fn to_char(self) -> char {
        match self {
            Suit::Clubs => 'c',
            Suit::Diamonds => 'd',
            Suit::Hearts => 'h',
            Suit::Spades => 's',
        }
    }

    pub fn from_char(c: char) -> Option<Suit> {
        Suit::ALL.iter().copied().find(|s| s.to_char() == c)
    }
}

/// One card of a standard 52-card deck.
///
/// `Debug` prints `[Ah]` — bracketed, so the leak tests can find every card a
/// formatted view contains without mistaking prose ("Th" in "ThreeOfAKind")
/// for a ten of hearts. `Display` prints the bare wire code `Ah`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Card(u8);

impl Card {
    pub const fn new(rank: Rank, suit: Suit) -> Card {
        Card(rank.index() * 4 + suit.index())
    }

    /// `None` outside `0..52`.
    pub fn from_index(i: u8) -> Option<Card> {
        (i < 52).then_some(Card(i))
    }

    pub const fn index(self) -> u8 {
        self.0
    }

    pub fn rank(self) -> Rank {
        Rank::ALL[(self.0 / 4) as usize]
    }

    pub fn suit(self) -> Suit {
        Suit::ALL[(self.0 % 4) as usize]
    }

    /// The fixed-width wire code: exactly two ASCII bytes.
    pub fn code(self) -> [u8; 2] {
        [self.rank().to_char() as u8, self.suit().to_char() as u8]
    }

    /// Parses a two-character code (`"Ah"`, `"Td"`). Anything else — `"10h"`,
    /// lowercase ranks, [`HIDDEN_CODE`] — is `None`.
    pub fn parse(s: &str) -> Option<Card> {
        let mut it = s.chars();
        let (r, su) = (it.next()?, it.next()?);
        if it.next().is_some() {
            return None;
        }
        Some(Card::new(Rank::from_char(r)?, Suit::from_char(su)?))
    }
}

impl fmt::Display for Card {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let [r, s] = self.code();
        write!(f, "{}{}", r as char, s as char)
    }
}

impl fmt::Debug for Card {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{self}]")
    }
}

/// The 52 cards in index order (2c 2d 2h 2s 3c … As). Unshuffled.
pub fn full_deck() -> Vec<Card> {
    (0..52).map(Card).collect()
}

/// Parses whitespace-separated codes: `"Ah Kd 7c"`. Panics on a bad code, so
/// it exists only in the crate's own unit tests: outside them, card codes
/// are parsed with [`Card::parse`], which refuses a bad code instead.
#[cfg(test)]
pub(crate) fn cards(s: &str) -> Vec<Card> {
    s.split_whitespace()
        .map(|c| Card::parse(c).unwrap_or_else(|| panic!("bad card code {c:?}")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_card_round_trips_through_a_two_byte_code() {
        let deck = full_deck();
        assert_eq!(deck.len(), 52);
        let mut seen = std::collections::HashSet::new();
        for c in deck {
            let code = c.code();
            assert_eq!(code.len(), 2);
            let s = c.to_string();
            assert_eq!(s.len(), 2, "{s} is not fixed-width");
            assert_eq!(Card::parse(&s), Some(c));
            assert!(seen.insert(s));
        }
    }

    #[test]
    fn ten_is_t_and_malformed_codes_are_refused() {
        assert_eq!(Card::new(Rank::Ten, Suit::Hearts).to_string(), "Th");
        for bad in ["10h", "th", "Ahh", "", "A", HIDDEN_CODE, "1h", "Ax"] {
            assert_eq!(Card::parse(bad), None, "{bad:?} parsed");
        }
        assert_eq!(format!("{:?}", Card::new(Rank::Ace, Suit::Spades)), "[As]");
    }
}
