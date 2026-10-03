/**
 * Games as ACTIVITIES (docs/GAMES.md, *Activities*): the small pure pieces the
 * launcher, the picker, the notice, the stage tile and the sidebar share. All
 * of it is read off the server's views - who is seated is the view's seats,
 * never a list the client keeps.
 */
import type { GameKind, GameView } from './protocol';

/** The activities a call can start, in the picker's order. */
export const ACTIVITY_KINDS: readonly GameKind[] = ['holdem', 'blackjack'];

/** One line under each activity's name in the picker. */
export const ACTIVITY_BLURB: Record<GameKind, string> = {
    holdem: 'No-limit Texas Hold\u2019em for up to 6. 1,000 free chips, blinds 5/10.',
    blackjack: 'Everyone against the dealer. 6 decks, blackjack pays 3:2.',
};

/** The user ids seated at the table, in seat order. */
export function seatedUserIds(view: GameView): number[] {
    const out: number[] = [];
    for (const s of view.seats) if (s) out.push(s.user_id);
    return out;
}

/** The first empty seat, or null when the table is full. */
export function firstOpenSeat(view: GameView): number | null {
    const i = view.seats.findIndex(s => s === null);
    return i === -1 ? null : i;
}

/** "1 playing", "3 playing", "Nobody playing yet". */
export function playingLabel(n: number): string {
    return n === 0 ? 'Nobody playing yet' : `${n} playing`;
}

/**
 * The cached server rows with one server's `games_enabled` replaced (the
 * owner's switch, pushed live as `GamesEnabled`). A NEW array when it changes
 * (react-query compares by identity); the same one when the server is not
 * listed or already says so.
 */
export function applyGamesEnabled<T extends { id: string; games_enabled?: boolean }>(
    rows: T[] | undefined,
    f: { server_id: string; games_enabled: boolean },
): T[] | undefined {
    if (!rows) return rows;
    const i = rows.findIndex(r => r.id === f.server_id);
    if (i === -1 || rows[i].games_enabled === f.games_enabled) return rows;
    const next = rows.slice();
    next[i] = { ...rows[i], games_enabled: f.games_enabled };
    return next;
}
