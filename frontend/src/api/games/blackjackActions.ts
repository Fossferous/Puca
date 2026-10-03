/**
 * Blackjack controls read off the server's view. `legal` is present only for
 * the seat (and hand) to act; bets go between rounds and REPLACE any bet
 * already placed (the engine's place_bet: the chips leave the stack now and
 * come back with clear_bet, so what a bet can reach is stack + pending_bet).
 */
import type { BlackjackSeat, BlackjackView } from './protocol';

export interface BetRange {
    min: number;
    /** Largest bet this seat can place now: the table max or what it holds. */
    max: number;
    /** Can a bet be placed at all (between rounds, sitting in, covers the min). */
    open: boolean;
}

export function viewerSeat(view: BlackjackView): BlackjackSeat | null {
    return view.viewer_seat === null ? null : view.seats[view.viewer_seat] ?? null;
}

export function betRange(view: BlackjackView): BetRange {
    const s = viewerSeat(view);
    const available = s ? s.stack + s.pending_bet : 0;
    const max = Math.min(view.config.max_bet, available);
    return {
        min: view.config.min_bet,
        max,
        open: !!s && !view.in_round && !s.sitting_out && max >= view.config.min_bet,
    };
}

export function clampBet(amount: number, r: BetRange): number {
    const a = Math.floor(Number.isFinite(amount) ? amount : 0);
    return Math.max(r.min, Math.min(r.max, a));
}

/** Quick bets: the minimum, 5x, 25x and the most this seat can bet —
 *  distinct values only, ascending. */
export function betPresets(view: BlackjackView): number[] {
    const r = betRange(view);
    if (!r.open) return [];
    const out = [r.min, r.min * 5, r.min * 25, r.max].map(a => clampBet(a, r));
    return [...new Set(out)].sort((a, b) => a - b);
}

/** Busted: cannot cover the minimum bet with what it holds (rebuy offered). */
export function blackjackBusted(view: BlackjackView): boolean {
    const s = viewerSeat(view);
    return !!s && !view.in_round && s.stack + s.pending_bet < view.config.min_bet;
}

/** It is this viewer's turn, on which hand. */
export function blackjackMyTurn(view: BlackjackView): { hand: number } | null {
    if (!view.legal || !view.to_act || !view.turn || view.viewer_seat === null) return null;
    return view.to_act.seat === view.viewer_seat ? { hand: view.to_act.hand } : null;
}
