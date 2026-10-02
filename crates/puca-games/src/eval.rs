//! Poker hand evaluation for 5 to 7 cards.
//!
//! A [`HandValue`] is a single `u32` whose natural ordering IS the poker
//! ordering: compare two values and the larger hand wins, equal values split.
//! Layout: `category << 20 | r0 << 16 | r1 << 12 | r2 << 8 | r3 << 4 | r4`,
//! where `r0..r4` are the tie-break ranks (2 = 0 … A = 12) most significant
//! first, unused slots zero:
//!
//! | category        | r0          | r1        | r2..r4          |
//! |-----------------|-------------|-----------|-----------------|
//! | straight (flush)| high card   | –         | –               |
//! | four of a kind  | quad rank   | kicker    | –               |
//! | full house      | trips rank  | pair rank | –               |
//! | flush, high card| five ranks, high to low                     |
//! | three of a kind | trips rank  | kicker 1  | kicker 2        |
//! | two pair        | high pair   | low pair  | kicker          |
//! | one pair        | pair rank   | kickers 1..3                |
//!
//! The wheel (A-2-3-4-5) is a five-high straight. Suits never break ties.
//!
//! There are two evaluators on purpose. [`evaluate`] (rank counts + suit
//! masks, 5..=7 cards) is what the engine calls. [`evaluate5`] (sort and
//! group, exactly five) shares no logic with it beyond the encoding, and the
//! exhaustive test demands they agree on all 2,598,960 five-card hands —
//! two independent implementations being wrong the same way is much less
//! likely than one being wrong.

use crate::cards::{Card, Rank};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Category {
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

impl Category {
    const ALL: [Category; 9] = [
        Category::HighCard,
        Category::OnePair,
        Category::TwoPair,
        Category::ThreeOfAKind,
        Category::Straight,
        Category::Flush,
        Category::FullHouse,
        Category::FourOfAKind,
        Category::StraightFlush,
    ];
}

/// A comparable hand strength. See the module docs for the layout.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HandValue(u32);

impl HandValue {
    fn new(category: Category, ranks: &[u8]) -> HandValue {
        debug_assert!(ranks.len() <= 5);
        let mut v = (category as u32) << 20;
        for (i, &r) in ranks.iter().enumerate() {
            v |= (r as u32) << (16 - 4 * i);
        }
        HandValue(v)
    }

    pub fn category(self) -> Category {
        Category::ALL[(self.0 >> 20) as usize]
    }

    /// The five tie-break slots, most significant first (unused slots read as
    /// Two; the category says how many are meaningful).
    pub fn tiebreak(self) -> [Rank; 5] {
        let mut out = [Rank::Two; 5];
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = Rank::from_index(((self.0 >> (16 - 4 * i)) & 0xF) as u8).unwrap_or(Rank::Two);
        }
        out
    }

    /// The raw ordering key (what a wire format would carry).
    pub fn raw(self) -> u32 {
        self.0
    }
}

impl fmt::Debug for HandValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let t: String = self.tiebreak().iter().map(|r| r.to_char()).collect();
        write!(f, "HandValue({:?} {t})", self.category())
    }
}

const ACE: u8 = 12;

/// The high card of the best straight in a 13-bit rank mask, if any.
fn straight_high(mask: u16) -> Option<u8> {
    for high in (4..=ACE).rev() {
        let need = 0b1_1111u16 << (high - 4);
        if mask & need == need {
            return Some(high);
        }
    }
    // The wheel: A 2 3 4 5.
    let wheel = (1u16 << ACE) | 0b1111;
    (mask & wheel == wheel).then_some(3)
}

/// Up to five tie-break ranks, built without allocating (the exhaustive
/// tests evaluate 20 million hands per run).
struct Ranks {
    r: [u8; 5],
    n: usize,
}

impl Ranks {
    fn of(first: &[u8]) -> Ranks {
        let mut out = Ranks { r: [0; 5], n: 0 };
        for &x in first {
            out.r[out.n] = x;
            out.n += 1;
        }
        out
    }

    /// Appends ranks present in `mask`, high to low, until there are `upto`.
    fn fill_from(mut self, mask: u16, upto: usize) -> Ranks {
        for r in (0..=ACE).rev() {
            if self.n >= upto {
                break;
            }
            if mask & (1 << r) != 0 {
                self.r[self.n] = r;
                self.n += 1;
            }
        }
        self
    }

    fn value(&self, category: Category) -> HandValue {
        HandValue::new(category, &self.r[..self.n])
    }
}

/// Evaluates the best five-card hand among 5, 6 or 7 cards.
///
/// Panics on fewer than 5 or more than 7 cards — a programming error, never a
/// player input (the engine always passes two hole cards plus the board).
pub fn evaluate(cards: &[Card]) -> HandValue {
    assert!((5..=7).contains(&cards.len()), "evaluate needs 5..=7 cards, got {}", cards.len());
    let mut counts = [0u8; 13];
    let mut suit_masks = [0u16; 4];
    let mut all = 0u16;
    for c in cards {
        let r = c.rank().index();
        counts[r as usize] += 1;
        suit_masks[c.suit().index() as usize] |= 1 << r;
        all |= 1 << r;
    }

    let flush_mask = suit_masks.iter().copied().find(|m| m.count_ones() >= 5);
    if let Some(fm) = flush_mask {
        if let Some(h) = straight_high(fm) {
            return HandValue::new(Category::StraightFlush, &[h]);
        }
    }

    // The highest quad rank, the two highest trips ranks and the highest
    // pair rank (seven cards hold at most one quad, two trips, three pairs).
    let (mut quad, mut trips, mut pair) = (None, [None, None], None);
    for r in (0..=ACE).rev() {
        match counts[r as usize] {
            4 if quad.is_none() => quad = Some(r),
            3 if trips[0].is_none() => trips[0] = Some(r),
            3 if trips[1].is_none() => trips[1] = Some(r),
            2 if pair.is_none() => pair = Some(r),
            _ => {}
        }
    }

    if let Some(q) = quad {
        return Ranks::of(&[q]).fill_from(all & !(1 << q), 2).value(Category::FourOfAKind);
    }
    if let Some(t) = trips[0] {
        // The pair of a full house is the best OTHER rank held at least twice:
        // a second set of trips counts.
        if let Some(pr) = trips[1].max(pair) {
            return HandValue::new(Category::FullHouse, &[t, pr]);
        }
    }
    if let Some(fm) = flush_mask {
        return Ranks::of(&[]).fill_from(fm, 5).value(Category::Flush);
    }
    if let Some(h) = straight_high(all) {
        return HandValue::new(Category::Straight, &[h]);
    }
    if let Some(t) = trips[0] {
        return Ranks::of(&[t]).fill_from(all & !(1 << t), 3).value(Category::ThreeOfAKind);
    }
    if let Some(hi) = pair {
        let rest = all & !(1 << hi);
        // A second pair is the highest remaining rank held twice.
        let lo = (0..hi).rev().find(|&r| counts[r as usize] == 2);
        if let Some(lo) = lo {
            return Ranks::of(&[hi, lo]).fill_from(rest & !(1 << lo), 3).value(Category::TwoPair);
        }
        return Ranks::of(&[hi]).fill_from(rest, 4).value(Category::OnePair);
    }
    Ranks::of(&[]).fill_from(all, 5).value(Category::HighCard)
}

/// An independent evaluator for exactly five cards: sort, group, classify.
/// Used to cross-check [`evaluate`]; not on any hot path.
pub fn evaluate5(cards: &[Card; 5]) -> HandValue {
    let mut ranks: Vec<u8> = cards.iter().map(|c| c.rank().index()).collect();
    ranks.sort_unstable_by(|a, b| b.cmp(a));
    let flush = cards.iter().all(|c| c.suit() == cards[0].suit());
    let distinct = ranks.windows(2).all(|w| w[0] != w[1]);
    let straight_high = if !distinct {
        None
    } else if ranks[0] - ranks[4] == 4 {
        Some(ranks[0])
    } else if ranks == [ACE, 3, 2, 1, 0] {
        Some(3)
    } else {
        None
    };
    match (straight_high, flush) {
        (Some(h), true) => return HandValue::new(Category::StraightFlush, &[h]),
        (Some(h), false) => return HandValue::new(Category::Straight, &[h]),
        (None, true) => return HandValue::new(Category::Flush, &ranks),
        _ => {}
    }
    // Groups as (count, rank), largest group first, then higher rank.
    let mut groups: Vec<(u8, u8)> = Vec::new();
    for &r in &ranks {
        match groups.iter_mut().find(|g| g.1 == r) {
            Some(g) => g.0 += 1,
            None => groups.push((1, r)),
        }
    }
    groups.sort_unstable_by(|a, b| b.cmp(a));
    let order: Vec<u8> = groups.iter().map(|g| g.1).collect();
    let shape: Vec<u8> = groups.iter().map(|g| g.0).collect();
    let category = match shape.as_slice() {
        [4, 1] => Category::FourOfAKind,
        [3, 2] => Category::FullHouse,
        [3, 1, 1] => Category::ThreeOfAKind,
        [2, 2, 1] => Category::TwoPair,
        [2, 1, 1, 1] => Category::OnePair,
        _ => Category::HighCard,
    };
    HandValue::new(category, &order)
}
