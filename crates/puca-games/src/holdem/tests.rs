//! Rule tests on stacked decks. `start_hand_stacked` deals the given hole
//! cards and board (anything unnamed comes from the rest of a fresh deck), so
//! every scenario below is a specific, hand-checked poker situation.

use super::*;
use crate::cards::{cards, Card};
use crate::rng::seeded;

fn p(n: u128) -> PlayerId {
    PlayerId(n)
}

fn table_with(seats: &[usize]) -> HoldemTable {
    let mut t = HoldemTable::new(HoldemConfig::default()).unwrap();
    for &s in seats {
        t.sit(s, p(100 + s as u128)).unwrap();
    }
    t
}

fn act(t: &mut HoldemTable, seat: usize, a: Action) -> Vec<Event> {
    assert_eq!(t.to_act(), Some(seat), "expected seat {seat} to act");
    let turn = t.turn().unwrap();
    t.act(seat, turn, a).unwrap_or_else(|e| panic!("seat {seat} {a:?}: {e:?}"))
}

fn try_act(t: &mut HoldemTable, seat: usize, a: Action) -> Result<Vec<Event>, HoldemError> {
    let turn = t.turn().unwrap();
    t.act(seat, turn, a)
}

fn stack(t: &HoldemTable, seat: usize) -> u64 {
    t.view_for(None).seats[seat].as_ref().unwrap().stack
}

fn stacks(t: &HoldemTable) -> Vec<u64> {
    t.view_for(None).seats.iter().map(|s| s.as_ref().map_or(0, |s| s.stack)).collect()
}

fn hand(s: &str) -> [Card; 2] {
    let c = cards(s);
    [c[0], c[1]]
}

fn tokens(s: &str) -> Vec<String> {
    let b = s.as_bytes();
    (0..b.len().saturating_sub(3))
        .filter(|&i| b[i] == b'[' && b[i + 3] == b']' && Card::parse(&s[i + 1..i + 3]).is_some())
        .map(|i| s[i + 1..i + 3].to_string())
        .collect()
}

/// Every check-or-call until the hand ends (used to run a hand down).
fn check_down(t: &mut HoldemTable) -> Vec<Event> {
    let mut all = Vec::new();
    while t.hand_in_progress() {
        let seat = t.to_act().unwrap();
        let la = t.legal_actions(seat).unwrap();
        let a = if la.can_check { Action::Check } else { Action::Call };
        all.extend(act(t, seat, a));
    }
    all
}

fn awarded(events: &[Event]) -> Vec<(usize, u64, Vec<usize>, Vec<PotShare>)> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::PotAwarded { pot, amount, eligible, shares } => Some((*pot, *amount, eligible.clone(), shares.clone())),
            _ => None,
        })
        .collect()
}

fn showdown(events: &[Event]) -> Option<(Vec<usize>, Vec<usize>)> {
    events.iter().find_map(|e| match e {
        Event::Showdown { shown, mucked } => Some((shown.iter().map(|h| h.seat).collect(), mucked.clone())),
        _ => None,
    })
}

// ---------------------------------------------------------------------------
// Button, blinds, order of action

#[test]
fn heads_up_the_button_posts_the_small_blind_acts_first_preflop_and_last_after() {
    let mut t = table_with(&[0, 3]);
    let ev = t.start_hand_stacked(&[], "").unwrap();
    assert!(ev.contains(&Event::HandStarted {
        hand_no: 1,
        button: 0,
        small_blind: Some(0),
        big_blind: 3,
        dealt: vec![0, 3],
    }));
    assert_eq!((stack(&t, 0), stack(&t, 3)), (995, 990));
    assert_eq!(t.to_act(), Some(0), "heads-up: the button (small blind) acts first preflop");
    act(&mut t, 0, Action::Call);
    act(&mut t, 3, Action::Check);
    assert_eq!(t.view_for(None).street, Some(Street::Flop));
    assert_eq!(t.to_act(), Some(3), "heads-up: the big blind acts first after the flop");
    act(&mut t, 3, Action::Check);
    act(&mut t, 0, Action::Check);
    assert_eq!(t.view_for(None).street, Some(Street::Turn));
    assert_eq!(t.to_act(), Some(3));
    act(&mut t, 3, Action::BetOrRaiseTo(10));
    act(&mut t, 0, Action::Fold);
    // Next hand: the button moves, so the blinds swap.
    let ev = t.start_hand_stacked(&[], "").unwrap();
    assert!(ev.contains(&Event::HandStarted {
        hand_no: 2,
        button: 3,
        small_blind: Some(3),
        big_blind: 0,
        dealt: vec![0, 3],
    }));
    assert_eq!(t.to_act(), Some(3));
}

#[test]
fn the_button_and_blinds_rotate_clockwise_over_occupied_seats() {
    let mut t = table_with(&[1, 2, 4]);
    let started = |ev: &[Event]| {
        ev.iter()
            .find_map(|e| match e {
                Event::HandStarted { button, small_blind, big_blind, .. } => Some((*button, small_blind.unwrap(), *big_blind)),
                _ => None,
            })
            .unwrap()
    };
    let ev = t.start_hand_stacked(&[], "").unwrap();
    assert_eq!(started(&ev), (1, 2, 4));
    assert_eq!(t.to_act(), Some(1), "under the gun is left of the big blind, wrapping");
    act(&mut t, 1, Action::Fold);
    act(&mut t, 2, Action::Fold);
    let ev = t.start_hand_stacked(&[], "").unwrap();
    assert_eq!(started(&ev), (2, 4, 1));
    act(&mut t, 2, Action::Fold);
    act(&mut t, 4, Action::Fold);
    let ev = t.start_hand_stacked(&[], "").unwrap();
    assert_eq!(started(&ev), (4, 1, 2));
    act(&mut t, 4, Action::Fold);
    act(&mut t, 1, Action::Fold);
    // Seat 2 sits out: two players left, so the heads-up rule takes over —
    // the button (next after 4 → seat 1) posts the small blind.
    t.sit_out(2).unwrap();
    let ev = t.start_hand_stacked(&[], "").unwrap();
    assert_eq!(started(&ev), (1, 1, 4));
    assert_eq!(t.to_act(), Some(1));
}

// ---------------------------------------------------------------------------
// Bet sizing

#[test]
fn a_raise_must_be_at_least_the_last_full_raise() {
    let mut t = table_with(&[0, 1, 2]);
    t.start_hand_stacked(&[], "").unwrap();
    // Preflop, blinds 5/10: the minimum raise is TO 20.
    assert_eq!(t.legal_actions(0).unwrap().min_raise_to, 20);
    let before = format!("{:?}", t.view_for(Some(0)));
    assert_eq!(try_act(&mut t, 0, Action::BetOrRaiseTo(15)), Err(HoldemError::BetBelowMinimum { min_to: 20 }));
    assert_eq!(try_act(&mut t, 0, Action::BetOrRaiseTo(10)), Err(HoldemError::BetBelowMinimum { min_to: 20 }));
    assert_eq!(try_act(&mut t, 0, Action::BetOrRaiseTo(1_001)), Err(HoldemError::BetAboveStack { max_to: 1_000 }));
    assert_eq!(before, format!("{:?}", t.view_for(Some(0))), "a refused action changed the table");
    act(&mut t, 0, Action::BetOrRaiseTo(30)); // a raise of 20
    assert_eq!(t.legal_actions(1).unwrap().min_raise_to, 50, "re-raise by at least the last raise (20)");
    assert_eq!(try_act(&mut t, 1, Action::BetOrRaiseTo(49)), Err(HoldemError::BetBelowMinimum { min_to: 50 }));
    act(&mut t, 1, Action::BetOrRaiseTo(50));
    act(&mut t, 2, Action::Call);
    act(&mut t, 0, Action::Call);
    // Postflop the minimum bet is the big blind.
    assert_eq!(t.view_for(None).street, Some(Street::Flop));
    assert_eq!(try_act(&mut t, 1, Action::BetOrRaiseTo(5)), Err(HoldemError::BetBelowMinimum { min_to: 10 }));
    assert_eq!(try_act(&mut t, 1, Action::Call), Err(HoldemError::NothingToCall));
    act(&mut t, 1, Action::BetOrRaiseTo(10));
    assert_eq!(try_act(&mut t, 2, Action::Check), Err(HoldemError::CannotCheck { to_call: 10 }));
    assert_eq!(t.legal_actions(2).unwrap().min_raise_to, 20);
}

#[test]
fn an_all_in_below_the_minimum_is_allowed_but_only_for_the_whole_stack() {
    let mut t = table_with(&[0, 1, 2]);
    t.set_stack(1, 16);
    t.start_hand_stacked(&[], "").unwrap();
    // Button 0, SB 1 with 16 (6 behind after calling), BB 2.
    act(&mut t, 0, Action::Call);
    act(&mut t, 1, Action::Call);
    act(&mut t, 2, Action::Check);
    // Flop: the SB acts first with 6 chips — less than a minimum bet.
    assert_eq!(try_act(&mut t, 1, Action::BetOrRaiseTo(5)), Err(HoldemError::BetBelowMinimum { min_to: 6 }));
    act(&mut t, 1, Action::BetOrRaiseTo(6));
    let la = t.legal_actions(2).unwrap();
    assert_eq!(la.to_call, 6);
    // Seat 2 has not acted this street, and seat 0 behind it could answer a
    // raise, so it may raise. (Heads-up against the all-in it could not:
    // see a_lone_player_facing_a_bigger_all_in_may_only_call_or_fold.)
    assert!(la.can_raise);
}

#[test]
fn an_incomplete_all_in_raise_does_not_reopen_the_betting_to_players_who_already_acted() {
    // 4 players, button 0, SB 1, BB 2, UTG 3. Seat 3 will have exactly 150
    // behind on the flop.
    let mut t = table_with(&[0, 1, 2, 3]);
    t.set_stack(3, 160);
    t.start_hand_stacked(&[], "").unwrap();
    act(&mut t, 3, Action::Call);
    act(&mut t, 0, Action::Call);
    act(&mut t, 1, Action::Call);
    act(&mut t, 2, Action::Check);
    // Flop: 1 checks, 2 bets 100 (a full bet), 3 shoves 150 — a raise of 50,
    // less than the 100 a full raise needs.
    act(&mut t, 1, Action::Check);
    act(&mut t, 2, Action::BetOrRaiseTo(100));
    act(&mut t, 3, Action::AllIn);
    // Seat 0 has not acted on this street: it may raise, by a full raise
    // over the all-in (150 + 100).
    let la = t.legal_actions(0).unwrap();
    assert!(la.can_raise);
    assert_eq!(la.min_raise_to, 250);
    act(&mut t, 0, Action::Call);
    // Seat 1 CHECKED and now faces 150 — more than a full bet since it
    // acted — so for seat 1 the betting is open.
    assert!(t.legal_actions(1).unwrap().can_raise);
    act(&mut t, 1, Action::Fold);
    // Seat 2 bet 100 and faces only the incomplete 50 on top: call or fold.
    let la = t.legal_actions(2).unwrap();
    assert!(!la.can_raise, "{la:?}");
    assert_eq!(la.to_call, 50);
    assert_eq!(try_act(&mut t, 2, Action::BetOrRaiseTo(300)), Err(HoldemError::RaiseNotReopened));
    assert_eq!(try_act(&mut t, 2, Action::AllIn), Err(HoldemError::RaiseNotReopened));
    act(&mut t, 2, Action::Call);
    let v = t.view_for(None);
    assert_eq!(v.street, Some(Street::Turn));
    assert_eq!(t.to_act(), Some(2), "first live seat left of the button, skipping the fold and the all-in");
}

#[test]
fn short_all_ins_that_add_up_to_a_full_raise_do_reopen_the_betting() {
    let mut t = table_with(&[0, 1, 2, 3]);
    t.set_stack(3, 160);
    t.set_stack(0, 230);
    t.start_hand_stacked(&[], "").unwrap();
    act(&mut t, 3, Action::Call);
    act(&mut t, 0, Action::Call);
    act(&mut t, 1, Action::Call);
    act(&mut t, 2, Action::Check);
    act(&mut t, 1, Action::Check);
    act(&mut t, 2, Action::BetOrRaiseTo(100));
    act(&mut t, 3, Action::AllIn); // 150: +50, incomplete
    act(&mut t, 0, Action::AllIn); // 220: +70, incomplete — but 120 over seat 2's bet
    act(&mut t, 1, Action::Call); // still has chips: someone can answer a raise by seat 2
    let la = t.legal_actions(2).unwrap();
    assert!(la.can_raise, "two short raises totalling >= a full raise reopen: {la:?}");
    assert_eq!(la.min_raise_to, 320, "the minimum raise is still the last FULL raise (100)");
    assert_eq!(la.to_call, 120);
}

// ---------------------------------------------------------------------------
// Pots

fn side_pot_hand(holes: &[(usize, &str)]) -> (HoldemTable, Vec<Event>) {
    let mut t = table_with(&[0, 1, 2, 3]);
    for (seat, s) in [(0, 100), (1, 250), (2, 500), (3, 1_000)] {
        t.set_stack(seat, s);
    }
    let mut ev = t.start_hand_stacked(holes, "2c 7d 9h Jc 3s").unwrap();
    ev.extend(act(&mut t, 3, Action::AllIn));
    ev.extend(act(&mut t, 0, Action::AllIn));
    ev.extend(act(&mut t, 1, Action::AllIn));
    ev.extend(act(&mut t, 2, Action::AllIn));
    assert!(!t.hand_in_progress(), "everyone is all-in: the board runs out and the hand settles");
    (t, ev)
}

#[test]
fn three_all_ins_of_different_sizes_build_a_main_pot_and_two_side_pots() {
    // Shortest stack has the best hand, then the next, and so on.
    let (t, ev) = side_pot_hand(&[(0, "Ah Ad"), (1, "Kh Kd"), (2, "Qh Qd"), (3, "Tc 4d")]);
    assert!(ev.contains(&Event::UncalledReturned { seat: 3, amount: 500 }), "{ev:?}");
    let pots = awarded(&ev);
    assert_eq!(pots.len(), 3, "{pots:?}");
    assert_eq!(pots[0], (0, 400, vec![0, 1, 2, 3], vec![PotShare { seat: 0, amount: 400 }]));
    assert_eq!(pots[1], (1, 450, vec![1, 2, 3], vec![PotShare { seat: 1, amount: 450 }]));
    assert_eq!(pots[2], (2, 500, vec![2, 3], vec![PotShare { seat: 2, amount: 500 }]));
    assert_eq!(stacks(&t)[..4], [400, 450, 500, 500]);
    // An all-in showdown tables every live hand, in showdown order: nobody
    // bet the (run-out) river, so from the first seat left of the button.
    assert_eq!(showdown(&ev), Some((vec![1, 2, 3, 0], vec![])));
}

#[test]
fn the_covering_stack_with_the_best_hand_wins_every_pot() {
    let (t, ev) = side_pot_hand(&[(0, "Tc 4d"), (1, "Qh Qd"), (2, "Kh Kd"), (3, "Ah Ad")]);
    let pots = awarded(&ev);
    assert_eq!(pots.iter().map(|p| p.1).sum::<u64>(), 1_350);
    assert!(pots.iter().all(|p| p.3 == vec![PotShare { seat: 3, amount: p.1 }]), "{pots:?}");
    assert_eq!(stacks(&t)[..4], [0, 0, 0, 1_850]);
    // The three busted players are sat out.
    for seat in 0..3 {
        assert!(ev.contains(&Event::SatOut { seat, reason: SitOutReason::Busted }));
    }
}

#[test]
fn a_split_pot_gives_the_odd_chip_to_the_first_winner_left_of_the_button() {
    let mut t = table_with(&[0, 1, 2]);
    // Royal flush on the board: everyone still in plays it and ties.
    t.start_hand_stacked(&[(0, "2c 3d"), (1, "4h 5h"), (2, "2d 3c")], "As Ks Qs Js Ts").unwrap();
    act(&mut t, 0, Action::Call);
    act(&mut t, 1, Action::Fold); // 5 dead chips: the pot is 25, odd
    act(&mut t, 2, Action::Check);
    let ev = check_down(&mut t);
    let pots = awarded(&ev);
    assert_eq!(pots.len(), 1);
    // Left of the button (0) is seat 1 — folded — then seat 2.
    assert_eq!(pots[0].3, vec![PotShare { seat: 2, amount: 13 }, PotShare { seat: 0, amount: 12 }]);
    assert_eq!(stacks(&t)[..3], [1_002, 995, 1_003]);
}

#[test]
fn when_everyone_folds_the_uncalled_bet_comes_back_and_no_hand_is_shown() {
    let mut t = table_with(&[0, 1, 2]);
    t.start_hand_stacked(&[(0, "Ah Kh")], "").unwrap();
    act(&mut t, 0, Action::BetOrRaiseTo(30));
    act(&mut t, 1, Action::Fold);
    let ev = act(&mut t, 2, Action::Fold);
    assert!(ev.contains(&Event::UncalledReturned { seat: 0, amount: 20 }), "{ev:?}");
    assert_eq!(awarded(&ev)[0].1, 25);
    assert_eq!(showdown(&ev), None);
    assert_eq!(stacks(&t)[..3], [1_015, 995, 990]);
    let public = format!("{:?}", t.view_for(None));
    assert!(tokens(&public).is_empty(), "nothing is revealed when nobody calls: {public}");
    assert!(!format!("{:?}", t.view_for(Some(1))).contains("[Ah]"));
}

#[test]
fn a_short_big_blind_all_in_still_makes_everyone_call_the_full_blind() {
    let mut t = table_with(&[0, 1, 2]);
    t.set_stack(2, 4);
    let ev = t
        .start_hand_stacked(&[(0, "Kh Kd"), (1, "7c 2d"), (2, "Ah Ad")], "Qc 9d 5h 4s 3c")
        .unwrap();
    assert!(ev.contains(&Event::BlindPosted { seat: 2, amount: 4, all_in: true }));
    let la = t.legal_actions(0).unwrap();
    assert_eq!((la.to_call, la.min_raise_to), (10, 20));
    act(&mut t, 0, Action::Call);
    act(&mut t, 1, Action::Call);
    assert_eq!(t.view_for(None).street, Some(Street::Flop), "the all-in big blind has no option");
    let ev = check_down(&mut t);
    let pots = awarded(&ev);
    assert_eq!(pots[0], (0, 12, vec![0, 1, 2], vec![PotShare { seat: 2, amount: 12 }]));
    assert_eq!(pots[1], (1, 12, vec![0, 1], vec![PotShare { seat: 0, amount: 12 }]));
    assert_eq!(stacks(&t)[..3], [1_002, 990, 12]);
}

/// The live pots in a view: `(amount, eligible)` per pot, main pot first.
fn live_pots(t: &HoldemTable) -> Vec<(u64, Vec<usize>)> {
    t.view_for(None).pots.iter().map(|p| (p.amount, p.eligible.clone())).collect()
}

#[test]
fn the_view_shows_a_main_pot_and_a_side_pot_once_a_short_all_in_street_closes() {
    // Button 0, SB 1, BB 2, UTG 3; seat 0 can only put in 100.
    let mut t = table_with(&[0, 1, 2, 3]);
    t.set_stack(0, 100);
    t.start_hand_stacked(&[], "").unwrap();
    assert_eq!(live_pots(&t), vec![], "the blinds are bets in front of the players, not a pot yet");
    act(&mut t, 3, Action::BetOrRaiseTo(300));
    act(&mut t, 0, Action::AllIn); // 100: less than the 300 to call
    act(&mut t, 1, Action::Call);
    act(&mut t, 2, Action::Call);
    let v = t.view_for(None);
    assert_eq!(v.street, Some(Street::Flop));
    // 4 x 100 everyone matched; the 3 x 200 above it is for the three who
    // put it in, never for the short stack.
    assert_eq!(live_pots(&t), vec![(400, vec![0, 1, 2, 3]), (600, vec![1, 2, 3])]);
    assert_eq!(v.pot_total, 1_000);
    // A bet this street sits in front of the bettor until the street closes:
    // the pots do not move, the total does.
    act(&mut t, 1, Action::BetOrRaiseTo(50));
    assert_eq!(live_pots(&t), vec![(400, vec![0, 1, 2, 3]), (600, vec![1, 2, 3])]);
    assert_eq!(t.view_for(None).pot_total, 1_050);
    // A fold leaves its chips in the pots it reached but no longer contests
    // them; the call goes into the side pot only.
    act(&mut t, 2, Action::Fold);
    act(&mut t, 3, Action::Call);
    assert_eq!(t.view_for(None).street, Some(Street::Turn));
    assert_eq!(live_pots(&t), vec![(400, vec![0, 1, 3]), (700, vec![1, 3])]);
    // Every seat's view shows the same pots (they are public).
    for seat in 0..4 {
        assert_eq!(t.view_for(Some(seat)).pots, t.view_for(None).pots);
    }
    // Settled: the hand is over, no live pots remain.
    check_down(&mut t);
    assert!(!t.hand_in_progress());
    assert_eq!(live_pots(&t), vec![]);
}

#[test]
fn two_short_all_ins_make_two_side_pots_and_the_settlement_pays_exactly_them() {
    // Seats 0 (60) and 1 (150) are short; 2 and 3 cover. Seat 0 has the best
    // hand, seat 1 the second best: each wins only the pots it is in.
    let mut t = table_with(&[0, 1, 2, 3]);
    t.set_stack(0, 60);
    t.set_stack(1, 150);
    t.start_hand_stacked(&[(0, "Ah Ad"), (1, "Kh Kd"), (2, "Qh Qd"), (3, "7c 2d")], "2c 8d 9h Jc 3s").unwrap();
    act(&mut t, 3, Action::BetOrRaiseTo(400));
    act(&mut t, 0, Action::AllIn);
    act(&mut t, 1, Action::AllIn);
    act(&mut t, 2, Action::Call);
    // Flop: 3 and 2 still have chips; the street opens with the pots built.
    assert_eq!(
        live_pots(&t),
        vec![(240, vec![0, 1, 2, 3]), (270, vec![1, 2, 3]), (500, vec![2, 3])],
        "main 4 x 60, first side 3 x 90, second side 2 x 250"
    );
    let ev = check_down(&mut t);
    let pots = awarded(&ev);
    assert_eq!(
        pots.iter().map(|p| (p.1, p.2.clone())).collect::<Vec<_>>(),
        vec![(240, vec![0, 1, 2, 3]), (270, vec![1, 2, 3]), (500, vec![2, 3])],
        "the settlement pays the pots the table showed"
    );
    assert_eq!(pots[0].3, vec![PotShare { seat: 0, amount: 240 }]);
    assert_eq!(pots[1].3, vec![PotShare { seat: 1, amount: 270 }]);
    assert_eq!(pots[2].3, vec![PotShare { seat: 2, amount: 500 }]);
    assert_eq!(stacks(&t)[..4], [240, 270, 1_000 - 400 + 500, 1_000 - 400]);
}

#[test]
fn tied_hands_split_the_main_and_the_side_pot_with_the_odd_chip_left_of_the_button() {
    // The board is a straight; seats 2 and 3 both make the king-high one and
    // split everything they are in. Seat 1 (55 chips) plays the board and
    // loses. Button 0, SB 1, BB 2, UTG 3.
    let mut t = table_with(&[0, 1, 2, 3]);
    t.set_stack(1, 55);
    t.start_hand_stacked(&[(0, "2c 3d"), (1, "4c 4d"), (2, "Kh 2h"), (3, "Kd 3h")], "9s Ts Jd Qc 8h").unwrap();
    act(&mut t, 3, Action::BetOrRaiseTo(101));
    act(&mut t, 0, Action::Fold); // the button: no blind, nothing in
    act(&mut t, 1, Action::AllIn); // 55
    act(&mut t, 2, Action::Call);
    // Main 3 x 55 = 165 (odd), side 2 x 46 = 92.
    assert_eq!(live_pots(&t), vec![(165, vec![1, 2, 3]), (92, vec![2, 3])]);
    act(&mut t, 2, Action::BetOrRaiseTo(11));
    act(&mut t, 3, Action::Call);
    assert_eq!(live_pots(&t), vec![(165, vec![1, 2, 3]), (114, vec![2, 3])]);
    let ev = check_down(&mut t);
    let pots = awarded(&ev);
    assert_eq!(pots.len(), 2, "{pots:?}");
    // The odd chip of the main pot goes to the first winner left of the
    // button: seat 1 lost, so seat 2.
    assert_eq!(pots[0].3, vec![PotShare { seat: 2, amount: 83 }, PotShare { seat: 3, amount: 82 }]);
    assert_eq!(pots[1].3, vec![PotShare { seat: 2, amount: 57 }, PotShare { seat: 3, amount: 57 }]);
    assert_eq!(stacks(&t)[..4], [1_000, 0, 1_000 - 112 + 83 + 57, 1_000 - 112 + 82 + 57]);
}

// A player who already covers every all-in opponent has nothing to decide:
// nobody can call a raise, and the excess comes back uncalled. Giving such a
// player a turn would let the clock FOLD chips that already cover the pot.

/// Asserts the hand ran out with no decision at all and the uncalled chip
/// went back.
fn assert_ran_out_with_no_decision(t: &HoldemTable, ev: &[Event], returned_to: usize) {
    assert_eq!(t.turn(), None, "no decision is due: {ev:?}");
    assert!(!t.hand_in_progress(), "the board runs out and the hand settles: {ev:?}");
    assert!(ev.contains(&Event::UncalledReturned { seat: returned_to, amount: 1 }), "{ev:?}");
    assert_eq!(
        ev.iter().filter(|e| matches!(e, Event::BoardDealt { .. })).count(),
        3,
        "flop, turn and river are dealt: {ev:?}"
    );
}

#[test]
fn heads_up_a_small_blind_that_covers_an_all_in_big_blind_is_not_given_a_turn() {
    let mut t = table_with(&[0, 1]);
    t.set_stack(1, 4);
    // Button/SB 0 posts 5; BB 1 is all-in for 4.
    let ev = t.start_hand_stacked(&[(0, "Kh Kd"), (1, "Ah Ad")], "Qc 9d 5h 4s 3c").unwrap();
    assert_ran_out_with_no_decision(&t, &ev, 0);
    assert_eq!(awarded(&ev), vec![(0, 8, vec![0, 1], vec![PotShare { seat: 1, amount: 8 }])]);
    assert_eq!(stacks(&t)[..2], [996, 8]);
}

#[test]
fn folds_to_a_small_blind_that_covers_an_all_in_big_blind_end_the_betting() {
    let mut t = table_with(&[0, 1, 2]);
    t.set_stack(2, 4);
    t.start_hand_stacked(&[(0, "Kh Kd"), (1, "7c 2d"), (2, "Ah Ad")], "Qc 9d 5h 4s 3c").unwrap();
    let ev = act(&mut t, 0, Action::Fold);
    assert_ran_out_with_no_decision(&t, &ev, 1);
    assert_eq!(awarded(&ev), vec![(0, 8, vec![1, 2], vec![PotShare { seat: 2, amount: 8 }])]);
    assert_eq!(stacks(&t)[..3], [1_000, 996, 8]);
}

#[test]
fn a_departure_that_leaves_the_player_to_act_covering_every_all_in_ends_the_betting() {
    let mut t = table_with(&[0, 1, 2]);
    t.set_stack(2, 4);
    t.start_hand_stacked(&[(0, "Kh Kd"), (1, "7c 2d"), (2, "Ah Ad")], "Qc 9d 5h 4s 3c").unwrap();
    act(&mut t, 0, Action::Call); // 10 in
    assert_eq!(t.to_act(), Some(1), "the SB owes 5 more to match seat 0");
    // Seat 0 leaves out of turn: its 10 are dead, and the SB's 5 already
    // cover the all-in big blind's 4. Nothing is left to decide.
    let ev = t.leave(0).unwrap();
    assert_eq!(t.turn(), None, "no decision is due: {ev:?}");
    assert!(!t.hand_in_progress(), "{ev:?}");
    // Main pot 4 x 3 to the aces; seat 0's dead 6 above that level plus the
    // SB's extra chip are a side pot only the SB contests.
    assert_eq!(
        awarded(&ev),
        vec![
            (0, 12, vec![1, 2], vec![PotShare { seat: 2, amount: 12 }]),
            (1, 7, vec![1], vec![PotShare { seat: 1, amount: 7 }]),
        ]
    );
    assert!(ev.contains(&Event::PlayerLeft { seat: 0, player: p(100), stack: 990 }), "{ev:?}");
    assert_eq!(stacks(&t)[1..3], [1_002, 12]);
}

#[test]
fn a_lone_player_facing_a_bigger_all_in_may_only_call_or_fold() {
    let mut t = table_with(&[0, 1]);
    t.set_stack(1, 2_000);
    t.start_hand_stacked(&[], "").unwrap();
    act(&mut t, 0, Action::AllIn); // button/SB: all-in for 1,000
    let la = t.legal_actions(1).unwrap();
    assert_eq!((la.to_call, la.call_amount), (990, 990));
    assert!(!la.can_raise, "nobody is left who could answer a raise: {la:?}");
    assert_eq!(try_act(&mut t, 1, Action::BetOrRaiseTo(2_000)), Err(HoldemError::NobodyToRaise));
    assert_eq!(try_act(&mut t, 1, Action::AllIn), Err(HoldemError::NobodyToRaise));
    let ev = act(&mut t, 1, Action::Call);
    assert!(ev.iter().any(|e| matches!(e, Event::Acted { seat: 1, kind: ActedKind::Call, added: 990, .. })), "{ev:?}");
    assert!(!t.hand_in_progress());
}

// ---------------------------------------------------------------------------
// Showdown

fn river_hand(holes: &[(usize, &str)], river_bettor: Option<usize>) -> (HoldemTable, Vec<Event>) {
    let mut t = table_with(&[0, 1, 2]);
    t.start_hand_stacked(holes, "Kc Qd 9h 5s 3c").unwrap();
    act(&mut t, 0, Action::Call);
    act(&mut t, 1, Action::Fold);
    act(&mut t, 2, Action::Check);
    for _ in 0..2 {
        act(&mut t, 2, Action::Check);
        act(&mut t, 0, Action::Check);
    }
    let mut ev = Vec::new();
    match river_bettor {
        Some(0) => {
            ev.extend(act(&mut t, 2, Action::Check));
            ev.extend(act(&mut t, 0, Action::BetOrRaiseTo(20)));
            ev.extend(act(&mut t, 2, Action::Call));
        }
        Some(2) => {
            ev.extend(act(&mut t, 2, Action::BetOrRaiseTo(20)));
            ev.extend(act(&mut t, 0, Action::Call));
        }
        _ => {
            ev.extend(act(&mut t, 2, Action::Check));
            ev.extend(act(&mut t, 0, Action::Check));
        }
    }
    (t, ev)
}

#[test]
fn a_losing_hand_that_need_not_be_shown_is_mucked_and_never_revealed() {
    // Seat 2 bets the river and wins; seat 0 called and is beaten.
    let (t, ev) = river_hand(&[(0, "7c 2d"), (2, "Ah Ad")], Some(2));
    assert_eq!(showdown(&ev), Some((vec![2], vec![0])));
    assert_eq!(stacks(&t)[..3], [970, 995, 1_035]);
    let mucked = hand("7c 2d");
    for viewer in [None, Some(1), Some(2)] {
        let s = format!("{:?}", t.view_for(viewer));
        for c in mucked {
            assert!(!s.contains(&format!("{c:?}")), "{viewer:?} sees mucked {c}: {s}");
        }
    }
    assert!(format!("{ev:?}").find("[7c]").is_none());
    assert_eq!(t.view_for(Some(0)).my_cards, Some(mucked), "a player always sees their own cards");
    assert_eq!(t.view_for(None).seats[2].as_ref().unwrap().shown, Some(hand("Ah Ad")));
}

#[test]
fn the_last_river_aggressor_shows_first() {
    // Seat 0 bets the river with the WORSE hand: it must show first, and
    // seat 2 then shows to win. (Left-of-button order would have had seat 2
    // show first and seat 0 muck.)
    let (_, ev) = river_hand(&[(0, "7c 2d"), (2, "Ah Ad")], Some(0));
    assert_eq!(showdown(&ev), Some((vec![0, 2], vec![])));
}

#[test]
fn with_no_river_bet_the_first_live_player_left_of_the_button_shows_first() {
    // Seat 2 (left of button 0, after the folded seat 1) shows first with
    // the best hand; seat 0 cannot beat it and mucks.
    let (_, ev) = river_hand(&[(0, "7c 2d"), (2, "Ah Ad")], None);
    assert_eq!(showdown(&ev), Some((vec![2], vec![0])));
}

#[test]
fn an_all_in_showdown_tables_every_live_hand_even_the_loser() {
    let mut t = table_with(&[0, 1]);
    t.start_hand_stacked(&[(0, "7c 2d"), (1, "Ah Ad")], "Kc Qd 9h 5s 3c").unwrap();
    act(&mut t, 0, Action::AllIn);
    let ev = act(&mut t, 1, Action::Call);
    assert_eq!(showdown(&ev), Some((vec![1, 0], vec![])));
    assert_eq!(t.view_for(Some(1)).seats[0].as_ref().unwrap().shown, Some(hand("7c 2d")));
}

#[test]
fn a_player_may_show_a_mucked_or_folded_hand_after_the_hand_but_not_during_it() {
    let mut t = table_with(&[0, 1, 2]);
    t.start_hand_stacked(&[(1, "9s 9c")], "").unwrap();
    assert_eq!(t.show_cards(0), Err(HoldemError::NotShowable), "not while the hand is live");
    act(&mut t, 0, Action::Fold);
    act(&mut t, 1, Action::Fold);
    let ev = t.show_cards(1).unwrap();
    assert_eq!(ev, vec![Event::Shown { seat: 1, cards: hand("9s 9c") }]);
    assert_eq!(t.view_for(Some(2)).seats[1].as_ref().unwrap().shown, Some(hand("9s 9c")));
    assert_eq!(t.show_cards(1), Err(HoldemError::NotShowable), "already shown");
    assert_eq!(t.show_cards(4), Err(HoldemError::NotShowable), "never dealt in");
}

// ---------------------------------------------------------------------------
// Turn clock, staleness, leaving

#[test]
fn a_timeout_checks_if_it_can_else_folds_and_two_timeouts_sit_the_player_out() {
    let mut t = table_with(&[0, 1]);
    t.start_hand_stacked(&[], "").unwrap();
    let turn = t.turn().unwrap();
    // Seat 0 (button/SB) faces 5 more: the clock folds it.
    let ev = t.timeout(turn).unwrap();
    assert!(ev.contains(&Event::Acted {
        seat: 0,
        kind: ActedKind::Fold,
        added: 0,
        street_commit: 5,
        all_in: false,
        reason: ActReason::Timeout,
    }), "{ev:?}");
    // The old timer firing again is a no-op.
    assert_eq!(t.timeout(turn), Err(HoldemError::StaleTurn));
    assert_eq!(stacks(&t)[..2], [995, 1_005]);

    t.start_hand_stacked(&[], "").unwrap(); // button 1 (SB), seat 0 is BB
    act(&mut t, 1, Action::Call);
    let turn = t.turn().unwrap();
    let ev = t.timeout(turn).unwrap();
    assert!(ev.iter().any(|e| matches!(e, Event::Acted { seat: 0, kind: ActedKind::Check, reason: ActReason::Timeout, .. })));
    assert!(ev.contains(&Event::SatOut { seat: 0, reason: SitOutReason::Timeouts }), "second timeout in a row");
    assert!(t.view_for(None).seats[0].as_ref().unwrap().sitting_out);
    // Sitting out takes effect from the next hand; this one plays on.
    assert_eq!(t.to_act(), Some(0));
    assert_eq!(try_act(&mut t, 0, Action::Check).map(|_| ()), Ok(()));
    act(&mut t, 1, Action::BetOrRaiseTo(10));
    act(&mut t, 0, Action::Fold);
    assert_eq!(t.start_hand_stacked(&[], ""), Err(HoldemError::NotEnoughPlayers));
    t.sit_in(0).unwrap();
    t.start_hand_stacked(&[], "").unwrap();
}

#[test]
fn an_action_for_a_turn_that_has_passed_is_refused() {
    let mut t = table_with(&[0, 1, 2]);
    assert_eq!(
        t.act(0, TurnRef { hand_no: 1, turn_seq: 1 }, Action::Fold),
        Err(HoldemError::NoHandInProgress)
    );
    t.start_hand_stacked(&[], "").unwrap();
    let first = t.turn().unwrap();
    assert_eq!(t.act(1, first, Action::Fold), Err(HoldemError::NotYourTurn));
    act(&mut t, 0, Action::Call);
    // Seat 1 replays a stale click from a turn that is gone.
    assert_eq!(t.act(1, first, Action::Call), Err(HoldemError::StaleTurn));
    assert_eq!(t.act(1, TurnRef { hand_no: 99, ..t.turn().unwrap() }, Action::Call), Err(HoldemError::StaleTurn));
    act(&mut t, 1, Action::Call);
}

#[test]
fn leaving_mid_hand_folds_the_player_and_frees_the_seat_when_the_hand_ends() {
    let mut t = table_with(&[0, 1, 2]);
    t.start_hand_stacked(&[], "").unwrap();
    assert_eq!(t.to_act(), Some(0));
    // Seat 1 (the small blind, not to act) leaves.
    let ev = t.leave(1).unwrap();
    assert!(ev.iter().any(|e| matches!(e, Event::Acted { seat: 1, kind: ActedKind::Fold, reason: ActReason::Left, .. })));
    assert!(t.view_for(None).seats[1].as_ref().unwrap().leaving);
    assert_eq!(t.sit(1, p(999)), Err(HoldemError::SeatTaken), "the seat is held until the hand ends");
    assert_eq!(t.to_act(), Some(0), "leaving out of turn does not move the action");
    let ev = act(&mut t, 0, Action::Fold);
    assert!(ev.contains(&Event::PlayerLeft { seat: 1, player: p(101), stack: 995 }), "{ev:?}");
    assert!(t.view_for(None).seats[1].is_none());
    assert_eq!(stack(&t, 2), 1_005);
    // Coming back restores the stack you left with — leaving is not a refill.
    let ev = t.sit(1, p(101)).unwrap();
    assert_eq!(ev, vec![Event::PlayerSat { seat: 1, player: p(101), stack: 995 }]);
}

#[test]
fn when_the_player_to_act_leaves_heads_up_the_other_player_wins() {
    let mut t = table_with(&[0, 1]);
    t.start_hand_stacked(&[], "").unwrap();
    let ev = t.leave(0).unwrap();
    assert!(!t.hand_in_progress());
    assert!(ev.contains(&Event::PlayerLeft { seat: 0, player: p(100), stack: 995 }));
    assert_eq!(stack(&t, 1), 1_005);
}

#[test]
fn leaving_between_hands_is_immediate() {
    let mut t = table_with(&[0, 1]);
    assert_eq!(t.leave(0).unwrap(), vec![Event::PlayerLeft { seat: 0, player: p(100), stack: 1_000 }]);
    assert_eq!(t.leave(0), Err(HoldemError::SeatEmpty));
}

// ---------------------------------------------------------------------------
// Private views

#[test]
fn a_view_carries_only_its_own_seats_hole_cards() {
    let mut t = table_with(&[0, 1, 2]);
    t.start_hand_stacked(&[(0, "Ah Kh"), (1, "Qs Js"), (2, "7d 7c")], "").unwrap();
    let own = [(0, "Ah Kh"), (1, "Qs Js"), (2, "7d 7c")];
    for (seat, mine) in own {
        let v = t.view_for(Some(seat));
        assert_eq!(v.my_cards, Some(hand(mine)));
        let s = format!("{v:?}");
        for (other, theirs) in own {
            if other != seat {
                for c in hand(theirs) {
                    assert!(!s.contains(&format!("{c:?}")), "seat {seat} sees seat {other}'s {c}");
                }
            }
        }
    }
    assert!(tokens(&format!("{:?}", t.view_for(None))).is_empty());
    assert!(tokens(&format!("{t:?}")).is_empty(), "Debug of the table is redacted");
}

#[test]
fn a_new_occupant_of_a_seat_never_sees_the_previous_occupants_cards() {
    let mut t = table_with(&[0, 1]);
    t.start_hand_stacked(&[(1, "Ah Ad")], "").unwrap();
    act(&mut t, 0, Action::Fold);
    assert_eq!(t.view_for(Some(1)).my_cards, Some(hand("Ah Ad")));
    t.leave(1).unwrap();
    t.sit(1, p(555)).unwrap();
    let v = t.view_for(Some(1));
    assert_eq!(v.my_cards, None);
    assert!(tokens(&format!("{v:?}")).is_empty(), "{v:?}");
    assert_eq!(t.show_cards(1), Err(HoldemError::NotShowable), "the newcomer cannot show the old hand either");
}

// ---------------------------------------------------------------------------
// Seats, chips, configuration

#[test]
fn seating_rules() {
    let mut t = table_with(&[0]);
    assert_eq!(t.sit(6, p(1)), Err(HoldemError::SeatOutOfRange));
    assert_eq!(t.sit(0, p(1)), Err(HoldemError::SeatTaken));
    assert_eq!(t.sit(1, p(100)), Err(HoldemError::AlreadySeated));
    assert_eq!(t.seat_of(p(100)), Some(0));
    assert_eq!(t.start_hand(&mut seeded(1)), Err(HoldemError::NotEnoughPlayers));
}

#[test]
fn a_busted_player_sits_out_and_may_rebuy_only_when_busted_and_allowed() {
    let mut t = table_with(&[0, 1]);
    assert_eq!(t.rebuy(0), Err(HoldemError::NotBusted));
    t.start_hand_stacked(&[(0, "7c 2d"), (1, "Ah Ad")], "Kc Qd 9h 5s 3c").unwrap();
    act(&mut t, 0, Action::AllIn);
    let ev = act(&mut t, 1, Action::Call);
    assert!(ev.contains(&Event::SatOut { seat: 0, reason: SitOutReason::Busted }));
    assert_eq!(t.sit_in(0), Err(HoldemError::NoChips));
    assert_eq!(t.rebuy(0).unwrap(), vec![Event::Rebought { seat: 0, stack: 1_000 }]);
    assert!(!t.view_for(None).seats[0].as_ref().unwrap().sitting_out);

    let mut t = HoldemTable::new(HoldemConfig { allow_rebuy: false, ..HoldemConfig::default() }).unwrap();
    t.sit(0, p(1)).unwrap();
    t.sit(1, p(2)).unwrap();
    t.start_hand_stacked(&[(0, "7c 2d"), (1, "Ah Ad")], "Kc Qd 9h 5s 3c").unwrap();
    act(&mut t, 0, Action::AllIn);
    act(&mut t, 1, Action::Call);
    assert_eq!(t.rebuy(0), Err(HoldemError::RebuyNotAllowed));
    // ...and leaving and sitting back down is not a way around it.
    t.leave(0).unwrap();
    assert_eq!(t.sit(0, p(1)), Err(HoldemError::NoChips));
}

#[test]
fn configuration_is_validated_and_locked_once_the_first_hand_is_dealt() {
    let bad = [
        HoldemConfig { max_seats: 1, ..HoldemConfig::default() },
        HoldemConfig { max_seats: 10, ..HoldemConfig::default() },
        HoldemConfig { small_blind: 0, ..HoldemConfig::default() },
        HoldemConfig { small_blind: 20, big_blind: 10, ..HoldemConfig::default() },
        HoldemConfig { starting_stack: 5, ..HoldemConfig::default() },
        HoldemConfig { starting_stack: u64::MAX / 2, ..HoldemConfig::default() },
        HoldemConfig { turn_clock_secs: 0, ..HoldemConfig::default() },
        HoldemConfig { timeouts_before_sit_out: 0, ..HoldemConfig::default() },
    ];
    for c in bad {
        assert!(matches!(c.validate(), Err(HoldemError::InvalidConfig(_))), "{c:?} accepted");
        assert!(HoldemTable::new(c).is_err());
    }
    let mut t = table_with(&[0, 1]);
    // Before the first hand the opener may change stacks and blinds; seated
    // players get the new stack.
    let cfg = HoldemConfig { starting_stack: 2_000, small_blind: 10, big_blind: 20, ..HoldemConfig::default() };
    t.configure(cfg.clone()).unwrap();
    assert_eq!(stacks(&t)[..2], [2_000, 2_000]);
    assert_eq!(
        t.configure(HoldemConfig { max_seats: 2, ..HoldemConfig::default() }).map(|_| ()),
        Ok(()),
        "shrinking is fine while no occupied seat falls off"
    );
    assert!(matches!(
        table_with(&[0, 4]).configure(HoldemConfig { max_seats: 3, ..HoldemConfig::default() }),
        Err(HoldemError::InvalidConfig(_))
    ));
    t.start_hand(&mut seeded(7)).unwrap();
    assert_eq!(t.configure(cfg), Err(HoldemError::ConfigLocked));
}
