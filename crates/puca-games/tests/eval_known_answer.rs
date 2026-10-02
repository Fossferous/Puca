//! Known-answer tests for the hand evaluator.
//!
//! The category counts below are the published combinatorics of a 52-card
//! deck, not numbers this evaluator produced and we copied back: an evaluator
//! that mis-ranks the wheel fails the straight count, one that forgets the
//! steel wheel fails the straight-flush count, and one that compares kickers
//! wrongly fails the 7,462 distinct-value count.
//!
//! The crate carries TWO independent evaluators — `evaluate` (rank counts and
//! suit masks over 5..=7 cards, what the engine uses) and `evaluate5` (sorting
//! and grouping exactly five) — and the exhaustive 5-card test demands they
//! agree on every one of the 2,598,960 hands. The 7-card checks then demand
//! `evaluate` on seven cards equals the best `evaluate5` over all 21 five-card
//! subsets.

// Nested index loops are the plainest way to enumerate k-card combinations.
#![allow(clippy::needless_range_loop)]

use puca_games::cards::{full_deck, Card, Rank};
use puca_games::eval::{evaluate, evaluate5, Category, HandValue};
use puca_games::rng::{below, seeded};
use std::collections::HashSet;

const CATS: [Category; 9] = [
    Category::StraightFlush,
    Category::FourOfAKind,
    Category::FullHouse,
    Category::Flush,
    Category::Straight,
    Category::ThreeOfAKind,
    Category::TwoPair,
    Category::OnePair,
    Category::HighCard,
];

fn cat_index(c: Category) -> usize {
    CATS.iter().position(|&x| x == c).unwrap()
}

/// `"Ah Kd 7c"` -> cards. A fixture typo fails the test, which is all a
/// test-only parser needs to do.
fn cards(s: &str) -> Vec<Card> {
    s.split_whitespace().map(|c| Card::parse(c).unwrap_or_else(|| panic!("bad card code {c:?}"))).collect()
}

fn v(s: &str) -> HandValue {
    evaluate(&cards(s))
}

#[test]
fn all_2_598_960_five_card_hands_have_the_published_category_counts() {
    let deck = full_deck();
    let mut counts = [0u64; 9];
    let mut distinct: HashSet<HandValue> = HashSet::new();
    let mut royals = 0u64;
    let mut disagreements = 0u64;
    let mut first_disagreement = None;
    let mut total = 0u64;
    for a in 0..52 {
        for b in a + 1..52 {
            for c in b + 1..52 {
                for d in c + 1..52 {
                    for e in d + 1..52 {
                        let hand = [deck[a], deck[b], deck[c], deck[d], deck[e]];
                        let x = evaluate(&hand);
                        let y = evaluate5(&hand);
                        if x != y {
                            disagreements += 1;
                            first_disagreement.get_or_insert((hand, x, y));
                        }
                        counts[cat_index(x.category())] += 1;
                        if x.category() == Category::StraightFlush && x.tiebreak()[0] == Rank::Ace {
                            royals += 1;
                        }
                        distinct.insert(x);
                        total += 1;
                    }
                }
            }
        }
    }
    assert_eq!(total, 2_598_960);
    assert_eq!(disagreements, 0, "evaluate and evaluate5 disagree, first: {first_disagreement:?}");
    assert_eq!(
        counts,
        [40, 624, 3_744, 5_108, 10_200, 54_912, 123_552, 1_098_240, 1_302_540],
        "[SF, quads, full house, flush, straight, trips, two pair, pair, high card]"
    );
    assert_eq!(royals, 4, "royal flushes");
    assert_eq!(distinct.len(), 7_462, "distinct 5-card hand values (equivalence classes)");
}

/// Exhaustive over all C(52,6) = 20,358,520 six-card hands — the largest
/// exhaustive check cheap enough to run on every `cargo test`.
#[test]
fn all_six_card_hands_have_the_published_category_counts() {
    let deck = full_deck();
    let mut counts = [0u64; 9];
    let mut hand = [deck[0]; 6];
    for a in 0..52 {
        hand[0] = deck[a];
        for b in a + 1..52 {
            hand[1] = deck[b];
            for c in b + 1..52 {
                hand[2] = deck[c];
                for d in c + 1..52 {
                    hand[3] = deck[d];
                    for e in d + 1..52 {
                        hand[4] = deck[e];
                        for f in e + 1..52 {
                            hand[5] = deck[f];
                            counts[cat_index(evaluate(&hand).category())] += 1;
                        }
                    }
                }
            }
        }
    }
    assert_eq!(counts.iter().sum::<u64>(), 20_358_520);
    assert_eq!(
        counts,
        [1_844, 14_664, 165_984, 205_792, 361_620, 732_160, 2_532_816, 9_730_740, 6_612_900],
        "[SF, quads, full house, flush, straight, trips, two pair, pair, high card]"
    );
}

/// The full C(52,7) = 133,784,560 enumeration. Correct but slow in a debug
/// build; run it with `cargo test -p puca-games --release -- --ignored`.
#[test]
#[ignore = "133,784,560 hands: run with --release -- --ignored"]
fn all_seven_card_hands_have_the_published_category_counts() {
    let deck = full_deck();
    let mut counts = [0u64; 9];
    let mut hand = [deck[0]; 7];
    for a in 0..52 {
        hand[0] = deck[a];
        for b in a + 1..52 {
            hand[1] = deck[b];
            for c in b + 1..52 {
                hand[2] = deck[c];
                for d in c + 1..52 {
                    hand[3] = deck[d];
                    for e in d + 1..52 {
                        hand[4] = deck[e];
                        for f in e + 1..52 {
                            hand[5] = deck[f];
                            for g in f + 1..52 {
                                hand[6] = deck[g];
                                counts[cat_index(evaluate(&hand).category())] += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    assert_eq!(counts.iter().sum::<u64>(), 133_784_560);
    assert_eq!(
        counts,
        [41_584, 224_848, 3_473_184, 4_047_644, 6_180_020, 6_461_620, 31_433_400, 58_627_800, 23_294_460],
        "[SF, quads, full house, flush, straight, trips, two pair, pair, high card]"
    );
}

fn best_of_21(seven: &[Card; 7]) -> HandValue {
    let mut best = None;
    for skip_a in 0..7 {
        for skip_b in skip_a + 1..7 {
            let mut five = [seven[0]; 5];
            let mut k = 0;
            for (i, &c) in seven.iter().enumerate() {
                if i != skip_a && i != skip_b {
                    five[k] = c;
                    k += 1;
                }
            }
            let v = evaluate5(&five);
            if best.is_none_or(|b| v > b) {
                best = Some(v);
            }
        }
    }
    best.unwrap()
}

#[test]
fn seven_card_value_is_the_best_of_its_21_five_card_subsets_over_a_seeded_sample() {
    let mut rng = seeded(0x5EED_7CA2D);
    let mut per_category = [0u64; 9];
    for _ in 0..200_000 {
        let mut deck = full_deck();
        let mut seven = [deck[0]; 7];
        for slot in seven.iter_mut() {
            let i = below(&mut rng, deck.len() as u64) as usize;
            *slot = deck.swap_remove(i);
        }
        let direct = evaluate(&seven);
        assert_eq!(direct, best_of_21(&seven), "{seven:?}");
        per_category[cat_index(direct.category())] += 1;
    }
    // A sample this size visits every category; a category that never shows
    // up means the evaluator cannot produce it.
    assert!(per_category.iter().all(|&n| n > 0), "{per_category:?}");
}

#[test]
fn the_wheel_is_the_lowest_straight_and_the_steel_wheel_the_lowest_straight_flush() {
    let wheel = v("Ah 2d 3c 4s 5h");
    assert_eq!(wheel.category(), Category::Straight);
    assert_eq!(wheel.tiebreak()[0], Rank::Five);
    assert!(wheel < v("2h 3d 4c 5s 6h"));
    assert!(wheel > v("Ah Ad Ac Ks Qh"), "any straight beats trips");
    let steel = v("Ah 2h 3h 4h 5h");
    assert_eq!(steel.category(), Category::StraightFlush);
    assert!(steel < v("2c 3c 4c 5c 6c"));
    // A-K-Q-J-T is a straight; Q-K-A-2-3 is not (no wrap-around).
    assert_eq!(v("Ah Kd Qc Js Th").category(), Category::Straight);
    assert_eq!(v("Qh Kd Ac 2s 3h").category(), Category::HighCard);
}

#[test]
fn kickers_decide_within_a_category() {
    assert!(v("Ah Kh Qh Jh 9h") > v("Ad Kd Qd Jd 8d"), "flush, fifth card");
    assert!(v("Ah Ad Kc Ks Qh") > v("Ac As Kd Kh Jh"), "two pair kicker");
    assert!(v("9h 9d Ac 7s 4h") > v("9c 9s Kd Qh Jh"), "pair, first kicker");
    assert!(v("9h 9d Ac 7s 5h") > v("9c 9s Ad 7h 4h"), "pair, third kicker");
    assert!(v("7h 7d 7c As 2h") > v("7s 7d 7c Ks Qh"), "trips kicker");
    assert!(v("Kh Kd Kc Ks 3h") > v("Kh Kd Kc Ks 2h"), "quads kicker");
    assert!(v("3h 3d 3c 2s 2h") > v("2c 2d 2s As Ah"), "full house: trips rank first");
    assert!(v("Ah Kd Qc Js 9h") > v("Ah Kd Qc Js 8h"), "high card, fifth card");
    assert_eq!(v("Ah Kd Qc Js 9h"), v("As Kc Qd Jh 9s"), "suits never break ties");
}

#[test]
fn seven_card_hands_pick_the_best_five() {
    // Three pairs: the best two pairs plus the best remaining card, which is
    // the third pair's rank.
    let three_pairs = v("Ah Ad Kc Ks Qh Qd 2c");
    assert_eq!(three_pairs.category(), Category::TwoPair);
    assert_eq!(three_pairs.tiebreak()[..3], [Rank::Ace, Rank::King, Rank::Queen]);
    // Two sets of trips make a full house, the lower set as the pair.
    let two_trips = v("Ah Ad Ac Ks Kh Kd 2c");
    assert_eq!(two_trips.category(), Category::FullHouse);
    assert_eq!(two_trips.tiebreak()[..2], [Rank::Ace, Rank::King]);
    // Six to a flush: the top five play.
    assert_eq!(v("Ah Kh 9h 7h 4h 2h 2c"), v("Ah Kh 9h 7h 4h"));
    // A straight inside a flush suit is a straight flush even when a higher
    // plain straight is also present.
    let sf = v("5h 6h 7h 8h 9h Tc 2d");
    assert_eq!(sf.category(), Category::StraightFlush);
    assert_eq!(sf.tiebreak()[0], Rank::Nine);
    // Quads take the best remaining card as kicker, even from a pair.
    assert_eq!(v("9h 9d 9c 9s Kh Kd 2c"), v("9h 9d 9c 9s Kh"));
}

#[test]
fn the_board_playing_is_a_tie() {
    // Board: a broadway straight. Both players' hole cards are worse than it.
    let board = "Ah Kd Qc Js Tc";
    assert_eq!(v(&format!("{board} 2h 3h")), v(&format!("{board} 4d 5d")));
    // Same pair on board, kickers on board outrank both hole cards.
    let board = "9h 9d Ac Ks Qh";
    assert_eq!(v(&format!("{board} 2h 3h")), v(&format!("{board} 4d 5d")));
    // A jack would be the FOURTH kicker here — a pair plays only three.
    assert_eq!(v(&format!("{board} Jh 3h")), v(&format!("{board} 4d 5d")));
    // ...but a hole card that beats the board's third kicker does play.
    let board = "9h 9d Ac Ks 7h";
    assert_eq!(v(&format!("{board} 2h 3h")), v(&format!("{board} 4d 5d")));
    assert!(v(&format!("{board} Jh 3h")) > v(&format!("{board} 4d 5d")));
}
