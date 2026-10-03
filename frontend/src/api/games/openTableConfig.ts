/**
 * The opener's settings (docs/GAMES.md: "only the stack and stakes are the
 * opener's"), checked on the client against the engine's own limits so the
 * form can say what is wrong before the server refuses it with
 * `invalid_config`. The server's `validate()` (crates/puca-games
 * HoldemConfig / BlackjackConfig) still decides; these mirror it:
 *
 *   Hold'em    1 <= small_blind <= big_blind <= starting_stack <= 10^9
 *   Blackjack  1 <= min_bet <= max_bet <= 10^9, min_bet <= starting_stack <= 10^9
 */
import type { GameConfigInput, GameKind } from './protocol';

/** MAX_STARTING_STACK in both engines. */
export const MAX_STACK = 1_000_000_000;

export const HOLDEM_DEFAULTS = { starting_stack: 1000, small_blind: 5, big_blind: 10 } as const;
export const BLACKJACK_DEFAULTS = { starting_stack: 1000, min_bet: 10, max_bet: 500 } as const;

export interface OpenTableForm {
    starting_stack: number;
    small_blind: number;
    big_blind: number;
    min_bet: number;
    max_bet: number;
}

export function defaultForm(): OpenTableForm {
    return { ...HOLDEM_DEFAULTS, min_bet: BLACKJACK_DEFAULTS.min_bet, max_bet: BLACKJACK_DEFAULTS.max_bet };
}

const whole = (n: number) => Number.isSafeInteger(n) && n >= 1;

/** What is wrong with the form for `kind`, in words, or null when it is fine. */
export function formProblem(kind: GameKind, f: OpenTableForm): string | null {
    if (!whole(f.starting_stack) || f.starting_stack > MAX_STACK) return 'The starting stack must be a whole number from 1 to 1,000,000,000.';
    if (kind === 'holdem') {
        if (!whole(f.small_blind)) return 'The small blind must be at least 1.';
        if (!whole(f.big_blind) || f.big_blind < f.small_blind) return 'The big blind must be at least the small blind.';
        if (f.starting_stack < f.big_blind) return 'The starting stack must cover the big blind.';
        return null;
    }
    if (!whole(f.min_bet)) return 'The minimum bet must be at least 1.';
    if (!whole(f.max_bet) || f.max_bet < f.min_bet) return 'The maximum bet must be at least the minimum bet.';
    if (f.max_bet > MAX_STACK) return 'The maximum bet is too large.';
    if (f.starting_stack < f.min_bet) return 'The starting stack must cover the minimum bet.';
    return null;
}

/**
 * The `config` for GameCreate: ONLY the chosen game's fields (a field of the
 * other game is refused as `invalid_config`, not ignored).
 */
export function configFor(kind: GameKind, f: OpenTableForm): GameConfigInput {
    return kind === 'holdem'
        ? { starting_stack: f.starting_stack, small_blind: f.small_blind, big_blind: f.big_blind }
        : { starting_stack: f.starting_stack, min_bet: f.min_bet, max_bet: f.max_bet };
}
