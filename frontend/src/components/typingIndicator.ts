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
 * notification asks you to do. (The Android app's page keeps running for about a
 * minute in the background, so the ping and the message are both handled live;
 * after that the WebView freezes the page and drops its socket on the way back,
 * so no old ping reaches it there.)
 *
 * So: a message ends its sender's entry, and an entry is shown only in the room it
 * was typed in (the list used to keep the previous channel's typers for their five
 * seconds after a switch, named in the next channel).
 *
 * HELD PINGS. A page can also be stopped with its socket left OPEN (iOS suspending
 * a Home Screen app it has switched away from; api/websocket.ts healOnResume is
 * there because a socket can come through a freeze claiming to be open, and the
 * server keeps one that says nothing for 75 s, WS_IDLE_TIMEOUT_SECS). Nothing of
 * the page runs, and every frame the server sends meanwhile waits in the browser
 * until the page runs again, then all of them are handed over in one burst. A ping carries no send time (src/ws.rs, UserTyping), so a ping
 * that waited 30 s looked like one sent that instant and put its typer up for five
 * fresh seconds, under the message they had sent before it, or after they had
 * given up on a draft (reproduced in Edge with the page held by the debugger,
 * e2e/typing-resume-live.mjs `held` and `abandon`: up for 5.2 s and 5.7 s after the
 * page ran again, the typer having stopped 20 s before). `RunClock` notices the
 * page was not running, and a ping handled as it starts again is counted from when
 * it stopped: one that waited through more than its five seconds is not shown.
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

/**
 * `prev` with `userId` typing in `room` until `since + TYPING_TTL_MS`. `since` is
 * the earliest the ping may have reached the page (`RunClock.waitingSince`), `now`
 * when it is handled; a ping whose five seconds are already over by then changes
 * nothing (the SAME map), so it is never drawn, not even until the next prune.
 */
export function noteTyping(
    prev: Map<number, TypingRow>,
    userId: number,
    username: string,
    room: string,
    now: number,
    since: number = now,
): Map<number, TypingRow> {
    const expiry = Math.min(since, now) + TYPING_TTL_MS;
    if (expiry <= now) return prev;
    const next = new Map(prev);
    next.set(userId, { username, room, expiry });
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

/** How often Chat ticks its RunClock. */
export const RUN_TICK_MS = 1_000;

/** A tick this much later than the one before means the page was not running
 *  (suspended or frozen: a stopped page runs no timer), not that it was busy. Three
 *  ticks, so a long task or a hidden tab's 1 s timer alignment is not one. */
export const STOPPED_GAP_MS = 3_000;

/** How long after the first tick that saw the page had stopped a frame still counts
 *  as one that waited through it. The frames that waited are already queued when
 *  the page starts again, and are handed over within milliseconds of each other;
 *  in Edge they come BEFORE the late tick (measured: all of them within 2 ms of the
 *  release, then the tick), which `waitingSince` sees without this window, which
 *  is for an engine that runs its late timers first. A ping that really was just
 *  sent in this second is counted as having waited too: its typer is shown at their
 *  next ping, at most 3 s later. */
export const RESTART_MS = 1_000;

/**
 * Was this page running a moment ago, or has it just started again after being
 * stopped? Measured, not asked: `visibilitychange` and the Page Lifecycle events
 * are not delivered in the same order on every engine relative to the frames that
 * waited, and iOS sends no `freeze`. A timer stops with the page, so a tick that
 * comes long after the one before it is the page starting again, and a frame
 * handled before that tick has run (no tick for STOPPED_GAP_MS) is one too.
 */
export class RunClock {
    private lastRan: number;
    private stoppedAt = 0;
    private restartedAt = Number.NEGATIVE_INFINITY;

    constructor(now: number) {
        this.lastRan = now;
    }

    /** Call every RUN_TICK_MS. */
    tick(now: number): void {
        if (now - this.lastRan > STOPPED_GAP_MS) {
            this.stoppedAt = this.lastRan;
            this.restartedAt = now;
        }
        this.lastRan = now;
    }

    /** The earliest a frame handled at `now` may have reached the page: `now` while
     *  the page has been running, the moment it stopped when it is starting again. */
    waitingSince(now: number): number {
        if (now - this.lastRan > STOPPED_GAP_MS) return this.lastRan;
        if (now - this.restartedAt <= RESTART_MS) return this.stoppedAt;
        return now;
    }
}
