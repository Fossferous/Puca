//! Blackjack rule tests on a stacked shoe. `deal_stacked("Ah 9c Kd 7s ...")`
//! puts those cards on top of the shoe in that order; the deal is the casino
//! order — one card to each betting seat (ascending), the dealer's up card,
//! a second card to each seat, the dealer's hole card — and every later draw
//! (hits, doubles, split cards, the dealer's draws) takes the next card.

use super::*;
use crate::cards::{cards, Card};
use crate::rng::{below, seeded};

fn p(n: u128) -> PlayerId {
    PlayerId(n)
}

fn table(cfg: BlackjackConfig, seats: &[usize]) -> BlackjackTable {
    let mut t = BlackjackTable::new(cfg).unwrap();
    for &s in seats {
        t.sit(s, p(200 + s as u128)).unwrap();
    }
    t
}

fn default_table(seats: &[usize]) -> BlackjackTable {
    table(BlackjackConfig::default(), seats)
}

fn act(t: &mut BlackjackTable, seat: usize, a: BjAction) -> Vec<BjEvent> {
    assert_eq!(t.to_act().map(|x| x.0), Some(seat), "expected seat {seat} to act");
    let turn = t.turn().unwrap();
    t.act(seat, turn, a, &mut seeded(0)).unwrap_or_else(|e| panic!("seat {seat} {a:?}: {e:?}"))
}

fn try_act(t: &mut BlackjackTable, seat: usize, a: BjAction) -> Result<Vec<BjEvent>, BjError> {
    let turn = t.turn().unwrap();
    t.act(seat, turn, a, &mut seeded(0))
}

fn stack(t: &BlackjackTable, seat: usize) -> u64 {
    t.view().seats[seat].as_ref().unwrap().stack
}

fn settled(ev: &[BjEvent]) -> Vec<(usize, usize, Outcome, u64, u64)> {
    ev.iter()
        .filter_map(|e| match e {
            BjEvent::HandSettled { seat, hand, outcome, bet, returned } => Some((*seat, *hand, *outcome, *bet, *returned)),
            _ => None,
        })
        .collect()
}

fn tokens(s: &str) -> Vec<String> {
    let b = s.as_bytes();
    (0..b.len().saturating_sub(3))
        .filter(|&i| b[i] == b'[' && b[i + 3] == b']' && Card::parse(&s[i + 1..i + 3]).is_some())
        .map(|i| s[i + 1..i + 3].to_string())
        .collect()
}

#[test]
fn hand_totals_count_aces_soft_when_they_fit() {
    assert_eq!(hand_total(&cards("Ah 6d")), (17, true));
    assert_eq!(hand_total(&cards("Ah 6d Th")), (17, false));
    assert_eq!(hand_total(&cards("Ah Ad")), (12, true));
    assert_eq!(hand_total(&cards("Ah Ad Ac Ad 7s")), (21, true));
    assert_eq!(hand_total(&cards("Kh Qd 5c")), (25, false));
    assert_eq!(hand_total(&cards("Ah Kd")), (21, true));
}

#[test]
fn a_natural_pays_three_to_two_rounded_down_for_odd_bets() {
    let mut t = default_table(&[0]);
    t.place_bet(0, 10).unwrap();
    let ev = t.deal_stacked("Ah 9c Kd 7s").unwrap();
    assert_eq!(settled(&ev), vec![(0, 0, Outcome::Blackjack, 10, 25)]);
    assert!(!t.round_in_progress(), "nothing left to play: the dealer does not draw against a settled natural");
    assert_eq!(stack(&t, 0), 1_015);
    assert_eq!(t.house_net(), -15);

    let mut t = default_table(&[0]);
    t.place_bet(0, 15).unwrap();
    let ev = t.deal_stacked("Ah 9c Kd 7s").unwrap();
    assert_eq!(settled(&ev), vec![(0, 0, Outcome::Blackjack, 15, 37)], "15 * 3/2 = 22.5 pays 22");
}

fn soft_17_round(cfg: BlackjackConfig) -> (BlackjackTable, Vec<BjEvent>) {
    let mut t = table(cfg, &[0]);
    t.place_bet(0, 10).unwrap();
    // Player T 8 = 18. Dealer A up, 6 in the hole: soft 17. Then 5, 9.
    let mut ev = t.deal_stacked("Tc Ah 8c 6d 5h 9s").unwrap();
    assert!(ev.contains(&BjEvent::DealerPeeked { blackjack: false }));
    ev.extend(act(&mut t, 0, BjAction::Stand));
    (t, ev)
}

#[test]
fn the_dealer_stands_on_soft_17_under_s17_and_hits_it_under_h17() {
    let (t, ev) = soft_17_round(BlackjackConfig::default());
    assert_eq!(settled(&ev), vec![(0, 0, Outcome::Win, 10, 20)]);
    assert!(ev.contains(&BjEvent::RoundEnded { round_no: 1, dealer_total: 17, dealer_bust: false }));
    assert_eq!(t.view().dealer.len(), 2, "S17: no draw on soft 17");

    let (t, ev) = soft_17_round(BlackjackConfig { dealer_hits_soft_17: true, ..BlackjackConfig::default() });
    // A 6 5 = hard 12, then 9 = 21.
    assert_eq!(settled(&ev), vec![(0, 0, Outcome::Lose, 10, 0)]);
    assert!(ev.contains(&BjEvent::RoundEnded { round_no: 1, dealer_total: 21, dealer_bust: false }));
    assert_eq!(t.view().dealer.len(), 4);
}

#[test]
fn the_dealer_hits_hard_16_and_stands_on_hard_17() {
    let mut t = default_table(&[0]);
    t.place_bet(0, 10).unwrap();
    t.deal_stacked("Tc Th 9c 6d Ah 5s").unwrap();
    let ev = act(&mut t, 0, BjAction::Stand);
    // T 6 = 16 draws the ace: hard 17, stands; the 5 is never drawn.
    assert!(ev.contains(&BjEvent::RoundEnded { round_no: 1, dealer_total: 17, dealer_bust: false }), "{ev:?}");
    assert_eq!(settled(&ev), vec![(0, 0, Outcome::Win, 10, 20)]);
}

#[test]
fn the_dealer_peeks_with_an_ace_or_ten_up_and_a_dealer_blackjack_ends_the_round() {
    let mut t = default_table(&[0, 1]);
    t.place_bet(0, 10).unwrap();
    t.place_bet(1, 10).unwrap();
    // Seat 0: 9 9. Seat 1: A K. Dealer: A up, K in the hole.
    let ev = t.deal_stacked("9c Ac Ah 9d Kc Kd").unwrap();
    assert!(ev.contains(&BjEvent::DealerPeeked { blackjack: true }));
    assert!(!t.round_in_progress(), "nobody plays into a dealer blackjack");
    assert_eq!(
        settled(&ev),
        vec![(0, 0, Outcome::Lose, 10, 0), (1, 0, Outcome::Push, 10, 10)],
        "only the original bet is lost; a player natural pushes"
    );
    assert_eq!(t.house_net(), 10);

    // Ten up, ace in the hole is a blackjack too.
    let mut t = default_table(&[0]);
    t.place_bet(0, 10).unwrap();
    let ev = t.deal_stacked("9c Kh 9d Ah").unwrap();
    assert!(ev.contains(&BjEvent::DealerPeeked { blackjack: true }));
    assert_eq!(settled(&ev), vec![(0, 0, Outcome::Lose, 10, 0)]);

    // A 9 up never peeks (an ace underneath makes 20, not a blackjack).
    let mut t = default_table(&[0]);
    t.place_bet(0, 10).unwrap();
    let ev = t.deal_stacked("Tc 9h 8d Ah").unwrap();
    assert!(!ev.iter().any(|e| matches!(e, BjEvent::DealerPeeked { .. })));
    assert!(t.round_in_progress());
}

#[test]
fn split_aces_get_one_card_each_cannot_be_resplit_and_21_is_not_blackjack() {
    let mut t = default_table(&[0]);
    t.place_bet(0, 10).unwrap();
    // Player A A; dealer 9 up, 7 hole. Split cards: K (hand 0), A (hand 1).
    // Dealer 16 draws T and busts.
    t.deal_stacked("Ah 9c Ad 7s Kd As Tc").unwrap();
    assert!(t.legal_actions(0).unwrap().can_split);
    let ev = act(&mut t, 0, BjAction::Split);
    let v = t.view();
    let hands = &v.seats[0].as_ref().unwrap().hands;
    assert_eq!(hands.len(), 2, "A A re-paired with an ace is NOT split again");
    assert_eq!(hands[0].cards, cards("Ah Kd"));
    assert_eq!(hands[1].cards, cards("Ad As"));
    assert!(hands.iter().all(|h| h.done), "split aces get exactly one card");
    assert!(!t.round_in_progress(), "nothing left to decide, so the dealer has played");
    assert_eq!(
        settled(&ev),
        vec![(0, 0, Outcome::Win, 10, 20), (0, 1, Outcome::Win, 10, 20)],
        "A K after a split is 21 paid 1:1, not a 3:2 blackjack"
    );
    assert_eq!(stack(&t, 0), 1_020);
}

#[test]
fn doubling_after_a_split_is_allowed_by_default_and_refused_without_das() {
    let mut t = default_table(&[0]);
    t.place_bet(0, 10).unwrap();
    // 8 8 vs dealer 6 (hole T). Split cards: 3, 2. Doubles: T, 9. Dealer: K.
    t.deal_stacked("8h 6c 8d Ts 3c 2s Th 9h Kc").unwrap();
    act(&mut t, 0, BjAction::Split);
    assert!(t.legal_actions(0).unwrap().can_double);
    act(&mut t, 0, BjAction::Double); // 8 3 T = 21
    let ev = act(&mut t, 0, BjAction::Double); // 8 2 9 = 19
    assert_eq!(settled(&ev), vec![(0, 0, Outcome::Win, 20, 40), (0, 1, Outcome::Win, 20, 40)]);
    assert_eq!(stack(&t, 0), 1_040);

    let mut t = table(BlackjackConfig { double_after_split: false, ..BlackjackConfig::default() }, &[0]);
    t.place_bet(0, 10).unwrap();
    t.deal_stacked("8h 6c 8d Ts 3c 2s Th 9h Kc").unwrap();
    act(&mut t, 0, BjAction::Split);
    assert!(!t.legal_actions(0).unwrap().can_double);
    assert_eq!(try_act(&mut t, 0, BjAction::Double), Err(BjError::CannotDouble));
}

#[test]
fn a_seat_splits_to_at_most_four_hands() {
    let mut t = default_table(&[0]);
    t.place_bet(0, 10).unwrap();
    // 8 8 vs 6 (hole T). First split: 8 (hand 0), 8 (hand 1).
    t.deal_stacked("8h 6c 8d Ts 8c 8s 2c 8h 5d 4d Th").unwrap();
    act(&mut t, 0, BjAction::Split); // [8h 8c] [8d 8s]
    act(&mut t, 0, BjAction::Split); // [8h 2c] [8c 8h] [8d 8s]
    assert!(!t.legal_actions(0).unwrap().can_split, "8 2 is not a pair");
    act(&mut t, 0, BjAction::Stand);
    act(&mut t, 0, BjAction::Split); // [8h 2c] [8c 5d] [8h 4d] [8d 8s]
    act(&mut t, 0, BjAction::Stand);
    act(&mut t, 0, BjAction::Stand);
    assert_eq!(t.to_act(), Some((0, 3)));
    assert!(!t.legal_actions(0).unwrap().can_split, "a fifth hand is refused");
    assert_eq!(try_act(&mut t, 0, BjAction::Split), Err(BjError::CannotSplit));
    let ev = act(&mut t, 0, BjAction::Stand);
    // Dealer T 6 draws T: bust. Four hands of 10 each win.
    assert_eq!(settled(&ev).iter().map(|s| s.4).sum::<u64>(), 80);
    assert_eq!(stack(&t, 0), 1_040);
}

#[test]
fn double_on_any_two_cards_takes_one_card_and_needs_the_chips() {
    let mut t = default_table(&[0]);
    t.place_bet(0, 10).unwrap();
    // 2 3 vs T (hole 7, no blackjack). Double draws A: soft 16 — and stops.
    t.deal_stacked("2h Tc 3d 7s Ah").unwrap();
    let ev = act(&mut t, 0, BjAction::Double);
    assert_eq!(settled(&ev), vec![(0, 0, Outcome::Lose, 20, 0)]);
    assert_eq!(stack(&t, 0), 980);

    let mut t = table(BlackjackConfig { max_bet: 1_000, ..BlackjackConfig::default() }, &[0]);
    t.place_bet(0, 1_000).unwrap();
    t.deal_stacked("2h Tc 3d 7s Ah").unwrap();
    let la = t.legal_actions(0).unwrap();
    assert!(!la.can_double && !la.can_split && la.can_hit && la.can_stand);
    assert_eq!(try_act(&mut t, 0, BjAction::Double), Err(BjError::CannotDouble));
}

#[test]
fn a_busted_hand_loses_even_when_the_dealer_busts_and_ties_push() {
    let mut t = default_table(&[0, 1, 2]);
    for s in 0..3 {
        t.place_bet(s, 10).unwrap();
    }
    // Seats: T 6 | T 7 | T 8. Dealer 6 up, T hole. Seat 0 hits K (bust).
    t.deal_stacked("Tc Th Ts 6c 6d 7d 8d Td Kh 9s").unwrap();
    act(&mut t, 0, BjAction::Hit);
    assert_eq!(t.to_act(), Some((1, 0)), "a bust ends that hand; turns go seat by seat");
    act(&mut t, 1, BjAction::Stand);
    let ev = act(&mut t, 2, BjAction::Stand);
    assert_eq!(
        settled(&ev),
        vec![(1, 0, Outcome::Win, 10, 20), (2, 0, Outcome::Win, 10, 20)],
        "the dealer busts (6 T 9)"
    );
    assert_eq!(stack(&t, 0), 990, "the bust was settled when it happened");

    let mut t = default_table(&[0]);
    t.place_bet(0, 10).unwrap();
    t.deal_stacked("Tc Th 8d 8s").unwrap();
    let ev = act(&mut t, 0, BjAction::Stand);
    assert_eq!(settled(&ev), vec![(0, 0, Outcome::Push, 10, 10)]);
    assert_eq!(t.house_net(), 0);
}

#[test]
fn reaching_21_ends_the_hand_without_asking() {
    let mut t = default_table(&[0, 1]);
    t.place_bet(0, 10).unwrap();
    t.place_bet(1, 10).unwrap();
    t.deal_stacked("5c 9c 9h 6d Th 8s Td").unwrap();
    // Seat 0: 5 6 = 11, hits T = 21: done, turn passes to seat 1.
    act(&mut t, 0, BjAction::Hit);
    assert_eq!(t.to_act(), Some((1, 0)));
}

#[test]
fn bets_are_checked_against_the_table_limits_and_the_stack() {
    let mut t = default_table(&[0, 1]);
    assert_eq!(t.place_bet(0, 5), Err(BjError::BetBelowMinimum { min: 10 }));
    assert_eq!(t.place_bet(0, 501), Err(BjError::BetAboveMaximum { max: 500 }));
    assert_eq!(t.place_bet(3, 10), Err(BjError::SeatEmpty));
    assert_eq!(t.deal(&mut seeded(1)), Err(BjError::NoBets));
    t.place_bet(0, 100).unwrap();
    assert_eq!(stack(&t, 0), 900, "a placed bet leaves the stack");
    t.place_bet(0, 50).unwrap();
    assert_eq!(stack(&t, 0), 950, "re-betting replaces the old bet");
    t.clear_bet(0).unwrap();
    assert_eq!(stack(&t, 0), 1_000);
    t.sit_out(1).unwrap();
    assert_eq!(t.place_bet(1, 10), Err(BjError::SittingOut));
    let mut t = table(BlackjackConfig { starting_stack: 50, min_bet: 10, max_bet: 100, ..BlackjackConfig::default() }, &[0]);
    assert_eq!(t.place_bet(0, 60), Err(BjError::InsufficientChips { stack: 50 }));
    t.place_bet(0, 10).unwrap();
    t.deal(&mut seeded(2)).unwrap();
    if t.round_in_progress() {
        assert_eq!(t.place_bet(0, 10), Err(BjError::RoundInProgress));
    }
}

#[test]
fn a_timeout_stands_and_a_stale_timer_is_a_no_op() {
    let mut t = default_table(&[0, 1]);
    t.place_bet(0, 10).unwrap();
    t.place_bet(1, 10).unwrap();
    t.deal_stacked("Tc 9c 9h 5d 6d 8s").unwrap();
    let turn = t.turn().unwrap();
    let ev = t.timeout(turn, &mut seeded(0)).unwrap();
    assert!(ev.contains(&BjEvent::Acted { seat: 0, hand: 0, action: BjAction::Stand, reason: BjActReason::Timeout }));
    assert_eq!(t.timeout(turn, &mut seeded(0)), Err(BjError::StaleTurn));
    assert_eq!(t.act(1, turn, BjAction::Hit, &mut seeded(0)), Err(BjError::StaleTurn));
    assert_eq!(t.act(0, t.turn().unwrap(), BjAction::Hit, &mut seeded(0)), Err(BjError::NotYourTurn));
    assert_eq!(t.to_act(), Some((1, 0)));
}

#[test]
fn two_timeouts_in_a_row_sit_a_player_out() {
    let mut t = default_table(&[0]);
    for round in 0..2 {
        t.place_bet(0, 10).unwrap();
        t.deal_stacked("Tc 9c 7h 8d 2s").unwrap();
        let ev = t.timeout(t.turn().unwrap(), &mut seeded(0)).unwrap();
        let sat_out = ev.contains(&BjEvent::SatOut { seat: 0, reason: BjSitOutReason::Timeouts });
        assert_eq!(sat_out, round == 1);
    }
    assert_eq!(t.place_bet(0, 10), Err(BjError::SittingOut));
    t.sit_in(0).unwrap();
    t.place_bet(0, 10).unwrap();
}

#[test]
fn leaving_mid_round_stands_every_hand_and_the_seat_is_freed_at_settlement() {
    let mut t = default_table(&[0, 1]);
    t.place_bet(0, 10).unwrap();
    t.place_bet(1, 10).unwrap();
    // Seat 0: T 9 (19). Seat 1: 9 8. Dealer 7 up, T hole = 17.
    t.deal_stacked("Tc 9h 7c 9d 8s Ts").unwrap();
    let ev = t.leave(0, &mut seeded(0)).unwrap();
    assert!(ev.contains(&BjEvent::Acted { seat: 0, hand: 0, action: BjAction::Stand, reason: BjActReason::Left }));
    assert_eq!(t.sit(0, p(9)), Err(BjError::SeatTaken));
    assert!(t.view().seats[0].as_ref().unwrap().leaving);
    let ev = act(&mut t, 1, BjAction::Stand);
    // Seat 0's 19 still beats 17 — its bet is settled before it goes.
    assert!(settled(&ev).contains(&(0, 0, Outcome::Win, 10, 20)));
    assert!(ev.contains(&BjEvent::PlayerLeft { seat: 0, player: p(200), stack: 1_010 }));
    assert!(t.view().seats[0].is_none());
    // Back again: the stack it left with, not a fresh one.
    assert_eq!(t.sit(0, p(200)).unwrap(), vec![BjEvent::PlayerSat { seat: 0, player: p(200), stack: 1_010 }]);
}

#[test]
fn leaving_between_rounds_returns_a_pending_bet_with_the_stack() {
    let mut t = default_table(&[0]);
    t.place_bet(0, 40).unwrap();
    let ev = t.leave(0, &mut seeded(0)).unwrap();
    assert_eq!(ev, vec![BjEvent::BetCleared { seat: 0, amount: 40 }, BjEvent::PlayerLeft { seat: 0, player: p(200), stack: 1_000 }]);
}

#[test]
fn the_dealer_hole_card_stays_hidden_until_the_dealer_plays() {
    let mut t = default_table(&[0]);
    t.place_bet(0, 10).unwrap();
    let ev = t.deal_stacked("Tc 9c 9h 5d 2s").unwrap();
    let v = t.view();
    assert_eq!(v.dealer, vec![Some(cards("9c")[0]), None]);
    assert!(!format!("{v:?}").contains("[5d]"));
    assert!(!format!("{ev:?}").contains("[5d]"), "the deal events carry the hole card face down");
    assert!(ev.contains(&BjEvent::CardDealt { to: BjTarget::Dealer, card: None }));
    assert!(tokens(&format!("{t:?}")).is_empty(), "Debug of the table is redacted");
    let ev = act(&mut t, 0, BjAction::Stand);
    assert!(ev.contains(&BjEvent::DealerRevealed { card: cards("5d")[0] }));
    assert_eq!(t.view().dealer[1], Some(cards("5d")[0]));
}

#[test]
fn the_shoe_holds_six_decks_and_reshuffles_at_the_cut_card_between_rounds_only() {
    let mut shoe = Shoe::new(6, 75);
    let mut rng = seeded(3);
    shoe.shuffle(&mut rng);
    assert_eq!((shoe.size(), shoe.remaining(), shoe.discarded()), (312, 312, 0));
    let mut counts = [0u32; 52];
    let mut drawn = Vec::new();
    while shoe.remaining() > 0 {
        let (c, reshuffled) = shoe.draw(&mut rng);
        assert!(!reshuffled);
        counts[c.index() as usize] += 1;
        drawn.push(c);
        // The cut card sits after 75% of 312 = 234 cards.
        assert_eq!(shoe.needs_shuffle(), drawn.len() >= 234, "after {} cards", drawn.len());
    }
    assert!(counts.iter().all(|&n| n == 6), "six of every card: {counts:?}");
    // An empty shoe mid-round reshuffles the discard tray (cards not in play).
    shoe.discard(&drawn[..100]);
    assert_eq!(shoe.discarded(), 100);
    let (_, reshuffled) = shoe.draw(&mut rng);
    assert!(reshuffled);
    assert_eq!((shoe.remaining(), shoe.discarded()), (99, 0));

    // At the table: past the cut card, the NEXT deal shuffles first.
    let mut t = default_table(&[0]);
    let mut rng = seeded(9);
    let mut shuffles = 0;
    let mut rounds = 0;
    while shuffles < 3 {
        t.place_bet(0, 10).unwrap_or_else(|_| {
            t.rebuy(0).unwrap();
            t.place_bet(0, 10).unwrap();
            vec![]
        });
        let due = t.view().reshuffle_due;
        let ev = t.deal(&mut rng).unwrap();
        let shuffled = ev.iter().any(|e| matches!(e, BjEvent::ShoeShuffled { mid_round: false, .. }));
        assert_eq!(shuffled, due || rounds == 0, "round {rounds}: shuffle exactly when due (or first deal)");
        if shuffled {
            shuffles += 1;
            assert_eq!(t.view().shoe_remaining, 312 - 4, "a fresh shoe minus this deal's four cards");
        }
        while t.round_in_progress() {
            let seat = t.to_act().unwrap().0;
            act(&mut t, seat, BjAction::Stand);
        }
        assert!(
            !ev.iter().any(|e| matches!(e, BjEvent::ShoeShuffled { mid_round: true, .. })),
            "never mid-round with a 6-deck shoe"
        );
        rounds += 1;
    }
}

#[test]
fn configuration_is_validated_and_locked_after_the_first_round() {
    let bad = [
        BlackjackConfig { max_seats: 0, ..BlackjackConfig::default() },
        BlackjackConfig { max_seats: 8, ..BlackjackConfig::default() },
        BlackjackConfig { decks: 0, ..BlackjackConfig::default() },
        BlackjackConfig { decks: 9, ..BlackjackConfig::default() },
        BlackjackConfig { penetration_percent: 20, ..BlackjackConfig::default() },
        BlackjackConfig { penetration_percent: 95, ..BlackjackConfig::default() },
        BlackjackConfig { min_bet: 0, ..BlackjackConfig::default() },
        BlackjackConfig { min_bet: 600, ..BlackjackConfig::default() },
        BlackjackConfig { blackjack_pays: (3, 0), ..BlackjackConfig::default() },
        // A denominator this large is refused, not overflowed: `num <= 2 * den`
        // must not be what decides it.
        BlackjackConfig { blackjack_pays: (3, u64::MAX), ..BlackjackConfig::default() },
        BlackjackConfig { blackjack_pays: (1, 1_000), ..BlackjackConfig::default() },
        BlackjackConfig { max_hands: 0, ..BlackjackConfig::default() },
        BlackjackConfig { starting_stack: 5, ..BlackjackConfig::default() },
        BlackjackConfig { turn_clock_secs: 1, ..BlackjackConfig::default() },
    ];
    for c in bad {
        assert!(matches!(c.validate(), Err(BjError::InvalidConfig(_))), "{c:?} accepted");
    }
    let mut t = default_table(&[0]);
    t.configure(BlackjackConfig { starting_stack: 500, ..BlackjackConfig::default() }).unwrap();
    assert_eq!(stack(&t, 0), 500);
    t.place_bet(0, 10).unwrap();
    t.deal(&mut seeded(4)).unwrap();
    assert_eq!(t.configure(BlackjackConfig::default()), Err(BjError::ConfigLocked));
}

/// Thousands of seeded random rounds with random bets, actions, timeouts and
/// departures. After every operation: chips are conserved (stacks + bets on
/// the table + the house's net == what entered), every card of the shoe is
/// in exactly one place, and the hole card never shows before it is turned.
#[test]
fn random_rounds_conserve_chips_and_cards_and_never_show_the_hole_card_early() {
    let mut rounds = 0u64;
    let mut splits = 0u64;
    let mut doubles = 0u64;
    let mut naturals = 0u64;
    let mut refills = 0u64;
    let mut count_refills = |ev: &[BjEvent]| {
        refills += ev.iter().filter(|e| matches!(e, BjEvent::ShoeShuffled { mid_round: true, .. })).count() as u64;
    };
    for seed in 0..12u64 {
        let mut rng = seeded(0xB1AC_0000 + seed);
        let cfg = BlackjackConfig {
            max_seats: 1 + below(&mut rng, 7) as usize,
            decks: 1 + below(&mut rng, 8) as u8,
            dealer_hits_soft_17: seed % 2 == 0,
            starting_stack: [50, 1_000][below(&mut rng, 2) as usize],
            ..BlackjackConfig::default()
        };
        let mut t = BlackjackTable::new(cfg.clone()).unwrap();
        let mut ledger: i64 = 0;
        let mut next = seed << 32;
        let check = |t: &BlackjackTable, ledger: i64| {
            let v = t.view();
            let mut on_table: i64 = 0;
            for s in v.seats.iter().flatten() {
                on_table += (s.stack + s.pending_bet) as i64;
                on_table += s.hands.iter().filter(|h| h.outcome.is_none()).map(|h| h.bet as i64).sum::<i64>();
            }
            assert_eq!(on_table + t.house_net(), ledger, "chips: {v:?}");
            let (placed, size) = t.card_census();
            assert_eq!(placed, size, "a card is missing or doubled");
            // While players are still deciding, the hole card is face down
            // and the dealer's total unknown.
            if t.round_in_progress() {
                assert_eq!(v.dealer.len(), 2, "{v:?}");
                assert_eq!(v.dealer[1], None, "{v:?}");
                assert_eq!(v.dealer_total, None, "{v:?}");
            }
        };
        for _ in 0..300 {
            for seat in 0..cfg.max_seats {
                let occ = t.view().seats[seat].clone();
                match occ {
                    None if below(&mut rng, 100) < 40 => {
                        next += 1;
                        for e in t.sit(seat, p(next as u128)).unwrap() {
                            if let BjEvent::PlayerSat { stack, .. } = e {
                                ledger += stack as i64;
                            }
                        }
                    }
                    Some(s) if s.stack < cfg.min_bet && s.pending_bet == 0 => {
                        if t.rebuy(seat).is_ok() {
                            ledger += cfg.starting_stack as i64 - s.stack as i64;
                        }
                    }
                    Some(s) if s.sitting_out => {
                        let _ = t.sit_in(seat);
                    }
                    Some(s) => {
                        if below(&mut rng, 100) < 5 {
                            for e in t.leave(seat, &mut rng).unwrap() {
                                if let BjEvent::PlayerLeft { stack, .. } = e {
                                    ledger -= stack as i64;
                                }
                            }
                        } else if below(&mut rng, 100) < 85 {
                            let max = s.stack.min(cfg.max_bet);
                            if max >= cfg.min_bet {
                                let amount = cfg.min_bet + below(&mut rng, max - cfg.min_bet + 1);
                                t.place_bet(seat, amount).unwrap();
                            }
                        }
                    }
                    _ => {}
                }
                check(&t, ledger);
            }
            let deal_seed = below(&mut rng, u64::MAX);
            match t.deal(&mut seeded(deal_seed)) {
                Ok(ev) => {
                    count_refills(&ev);
                    rounds += 1;
                    naturals += settled(&ev).iter().filter(|s| s.2 == Outcome::Blackjack).count() as u64;
                }
                Err(BjError::NoBets) => continue,
                Err(e) => panic!("deal: {e:?}"),
            }
            check(&t, ledger);
            let mut steps = 0;
            while t.round_in_progress() {
                steps += 1;
                assert!(steps < 200);
                let (seat, _) = t.to_act().unwrap();
                let turn = t.turn().unwrap();
                let la = t.legal_actions(seat).unwrap();
                let r = below(&mut rng, 100);
                let ev = if r < 3 {
                    t.leave(seat, &mut rng).unwrap()
                } else if r < 8 {
                    t.timeout(turn, &mut rng).unwrap()
                } else if r < 20 && la.can_split {
                    splits += 1;
                    t.act(seat, turn, BjAction::Split, &mut rng).unwrap()
                } else if r < 32 && la.can_double {
                    doubles += 1;
                    t.act(seat, turn, BjAction::Double, &mut rng).unwrap()
                } else if r < 65 && la.can_hit {
                    t.act(seat, turn, BjAction::Hit, &mut rng).unwrap()
                } else {
                    t.act(seat, turn, BjAction::Stand, &mut rng).unwrap()
                };
                count_refills(&ev);
                // A seat that left mid-round is freed (and its stack goes)
                // when the round settles — whoever's action settles it.
                for e in &ev {
                    if let BjEvent::PlayerLeft { stack, .. } = e {
                        ledger -= *stack as i64;
                    }
                }
                check(&t, ledger);
            }
        }
    }
    eprintln!("rounds {rounds} splits {splits} doubles {doubles} naturals {naturals} mid-round refills {refills}");
    assert!(rounds > 2_000, "{rounds}");
    assert!(splits > 0 && doubles > 0 && naturals > 0, "splits {splits} doubles {doubles} naturals {naturals}");
    // Small shoes run dry mid-round now and then; the census above proved
    // the discard-tray refill neither lost nor duplicated a card.
    assert!(refills > 0, "the run never refilled a shoe mid-round");
}
