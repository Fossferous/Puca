/**
 * The Hold'em action bar, read off the server's view — never computed from
 * the rules. `view.legal` is present only in the view of the seat whose turn
 * it is (the engine's LegalActions, crates/puca-games holdem::legal_actions):
 *
 *   to_call       chips needed to stay in (0: nothing to call)
 *   can_check     to_call == 0
 *   call_amount   what Call actually puts in (less than to_call = all-in call)
 *   can_raise     a bet/raise is open to this player at all
 *   min_raise_to  the smallest legal street TOTAL (the all-in total when less)
 *   max_raise_to  the all-in street total
 *
 * Amounts the client sends are street TOTALS (`bet_or_raise_to`), never an
 * increment, so a retransmit cannot double-count.
 */
import type { HoldemAction, HoldemLegal, HoldemView } from './protocol';

export interface HoldemBar {
    /** Check (nothing to call) — otherwise Call is offered. */
    check: boolean;
    /** Chips a Call puts in, or null when there is nothing to call. */
    call: number | null;
    /** The call takes the whole stack (call_amount below to_call, or equal to it). */
    callIsAllIn: boolean;
    /** A bet or raise is open; null when only fold/check/call are. */
    raise: {
        /** "Bet" when nothing was bet on this street yet, else "Raise". */
        verb: 'Bet' | 'Raise';
        min: number;
        max: number;
        /** min === max: the only raise there is goes all-in. */
        onlyAllIn: boolean;
    } | null;
}

/** The bar for the viewer, or null when it is not their turn. */
export function holdemBar(view: HoldemView): HoldemBar | null {
    const l = view.legal;
    if (!l || view.viewer_seat === null || view.to_act !== view.viewer_seat || !view.turn) return null;
    const me = view.seats[view.viewer_seat];
    const stack = me?.stack ?? 0;
    return {
        check: l.can_check,
        call: l.can_check ? null : l.call_amount,
        callIsAllIn: !l.can_check && l.call_amount >= stack,
        raise: l.can_raise
            ? {
                  verb: view.current_bet === 0 ? 'Bet' : 'Raise',
                  min: l.min_raise_to,
                  max: l.max_raise_to,
                  onlyAllIn: l.min_raise_to >= l.max_raise_to,
              }
            : null,
    };
}

export interface RaisePreset {
    id: 'min' | 'half_pot' | 'pot' | 'all_in';
    label: string;
    amount: number;
}

/** Clamp a street total into what the engine accepts. */
export function clampRaise(amount: number, legal: Pick<HoldemLegal, 'min_raise_to' | 'max_raise_to'>): number {
    const a = Math.floor(Number.isFinite(amount) ? amount : 0);
    return Math.max(legal.min_raise_to, Math.min(legal.max_raise_to, a));
}

/**
 * The four presets as street TOTALS, each clamped to [min, all-in]:
 *
 *   min       min_raise_to
 *   ½ pot     current_bet + (pot + to_call) / 2   (rounded down)
 *   pot       current_bet + (pot + to_call)       — the standard pot-sized raise:
 *             call first, then raise by the pot as it stands after the call
 *   all-in    max_raise_to
 *
 * `pot_total` already includes every chip committed this hand, this street's
 * included (the engine sums hand_commit), so "the pot after my call" is
 * pot_total + to_call.
 */
export function raisePresets(view: HoldemView): RaisePreset[] {
    const l = view.legal;
    if (!l || !l.can_raise) return [];
    const after = view.pot_total + l.to_call;
    return [
        { id: 'min', label: 'Min', amount: clampRaise(l.min_raise_to, l) },
        { id: 'half_pot', label: '½ pot', amount: clampRaise(view.current_bet + Math.floor(after / 2), l) },
        { id: 'pot', label: 'Pot', amount: clampRaise(view.current_bet + after, l) },
        { id: 'all_in', label: 'All-in', amount: l.max_raise_to },
    ];
}

/** The stepper's increment: one big blind. */
export function raiseStep(view: HoldemView): number {
    return Math.max(1, view.config.big_blind);
}

/** The viewer has no chips and no live hand: offer a fresh stack (if the
 *  table allows rebuys — the server refuses otherwise). */
export function holdemBusted(view: HoldemView): boolean {
    if (view.viewer_seat === null) return false;
    const me = view.seats[view.viewer_seat];
    return !!me && me.stack === 0 && me.status !== 'in_hand' && me.status !== 'all_in';
}

/** One stepper press, clamped. */
export function stepRaise(amount: number, dir: 1 | -1, view: HoldemView): number {
    const l = view.legal;
    if (!l) return amount;
    return clampRaise(amount + dir * raiseStep(view), l);
}

/**
 * The action that raises to `amount`. The all-in total goes as `all_in`, not
 * `bet_or_raise_to`: when the stack is short of a full raise, max_raise_to is
 * BELOW the minimum and only the all-in action may put it in (an incomplete
 * raise), which `bet_or_raise_to` would have refused as below the minimum.
 */
export function raiseAction(amount: number, legal: HoldemLegal): HoldemAction {
    const a = clampRaise(amount, legal);
    return a >= legal.max_raise_to ? { type: 'all_in' } : { type: 'bet_or_raise_to', amount: a };
}
