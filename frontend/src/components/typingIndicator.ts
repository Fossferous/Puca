/**
 * "X is typing…": who is typing in the open channel now.
 *
 * THE BUG THIS EXISTS FOR (the owner, 2026-11-21: "when on mobile if i switch app
 * and then look at a chat it will usually say someone is still typing when they
 * arent"). Reproduced on the real Android app: someone types and sends while the
 * app is in the background, the phone comes back on that message 1.5 s later, and
 * "<them> is typing..." stays under their message for 3.3 s more. A typing ping
 * kept its typer up for five seconds whatever came next, and the message they had
 * just sent ended nothing; and coming back to the app is what that message's
 * notification asks you to do. (The app's page keeps running for about a minute in
 * the background, so the ping and the message are both handled live; after that
 * the WebView freezes the page and drops its socket on the way back, so no old
 * ping reaches it: the 1 s prune clears whatever was on screen at the freeze in
 * the first tick after the return.)
 *
 * So: a message ends its sender's entry, and an entry is shown only in the room it
 * was typed in (the list used to keep the previous channel's typers for their five
 * seconds after a switch, named in the next channel).
 */
import type { TypingEntry } from './stableState';

/** How long one typing ping keeps its typer on screen. The sender pings at most
 *  every 3 s while typing (Chat.tsx handleInputChange), so 5 s spans one missed
 *  ping and no more. */
export const TYPING_TTL_MS = 5_000;

export interface TypingRow extends TypingEntry {
    /** The room the ping was for (`channel_<id>`). */
    room: string;
}

/** `prev` with `userId` typing in `room` until `now + TYPING_TTL_MS`. */
export function noteTyping(
    prev: Map<number, TypingRow>,
    userId: number,
    username: string,
    room: string,
    now: number,
): Map<number, TypingRow> {
    const next = new Map(prev);
    next.set(userId, { username, room, expiry: now + TYPING_TTL_MS });
    return next;
}

/** `prev` without `userId` (they sent their message); the SAME map when they were
 *  not in it, so a message from someone not typing renders nothing. */
export function clearTyper(prev: Map<number, TypingRow>, userId: number): Map<number, TypingRow> {
    if (!prev.has(userId)) return prev;
    const next = new Map(prev);
    next.delete(userId);
    return next;
}

/** The names to show for `room`, in the order they started typing. */
export function typersIn(map: Map<number, TypingRow>, room: string | null): string[] {
    if (!room) return [];
    const out: string[] = [];
    for (const row of map.values()) if (row.room === room) out.push(row.username);
    return out;
}
