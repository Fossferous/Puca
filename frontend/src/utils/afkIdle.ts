/**
 * The AFK auto-move decision, copying Discord's rules (2026-08-31).
 *
 * Discord's contract, per its own support material and the observed behaviour
 * its community documents: a member idle in a voice channel for the server's
 * AFK timeout is moved to the AFK channel — where "idle" means NO
 * keyboard/mouse/touch input and no speech for that window, and being muted,
 * deafened, or "just listening" does NOT exempt you (their community forum's
 * standing complaint is listeners in meetings being moved — that is the
 * designed behaviour, not a bug). The timeout is owner-configurable from
 * exactly five options: 1, 5, 15, 30 or 60 minutes.
 *
 * This replaced a rule set where being muted, listen-only, or watching a
 * stream each granted PERMANENT immunity. Most people mute before walking
 * away, so in practice almost nobody was ever moved — reported as "users are
 * not getting kicked when AFK, possibly when they have a game open". The game
 * was incidental: the OS-input probe (which correctly treats an actively
 * playing gamer as present, same as Discord) never even ran for muted users,
 * because the mute exemption returned first.
 *
 * This function is deliberately pure and takes NO mute/deafen inputs — that
 * absence IS the Discord copy, and the tests pin it. `watching` is the one
 * later addition (2026-09-02), honoured ONLY where no OS input probe exists:
 * on a phone the only presence signal is a touch, and watching a friend's
 * stream in the docked mini-player produces none, so the mini-player was
 * moving its own viewer to AFK mid-stream. On desktop the OS probe still
 * decides first, so a silent desktop viewer is moved at Discord's line.
 *
 * The caller (VoicePanel) arms a timer for the timeout; the timer only fires
 * at all if nothing reset it — and speech (VAD) resets it, so "the timer
 * fired" already proves silence for the whole window. This decision then
 * separates the present-but-silent from the genuinely away:
 *
 *  - Actively BROADCASTING (screen share / camera) is presence: yanking a
 *    streamer ends the stream for every viewer, and idling at desktop while
 *    sharing a movie is ordinary use. (Discord is harsher here; we keep this
 *    one deliberate deviation, documented.)
 *  - Desktop: the OS input probe (GetLastInputInfo) is the authority. A gamer
 *    deep in a match generates constant input → present. A muted user who
 *    walked away generates none → moved, exactly at Discord's line.
 *  - Web/mobile (no OS probe): watching a stream, or input anywhere in the
 *    app, stands in for it.
 *  - No probe and no recorded input → moved: every presence signal we can
 *    observe has been silent for the whole window.
 */

/** Discord's five AFK-timeout choices, in minutes. */
export const AFK_TIMEOUT_CHOICES_MIN = [1, 5, 15, 30, 60] as const;

/** The pre-setting hardcoded window, kept as the fallback when the backend
 *  predates `afk_timeout_minutes`. */
export const DEFAULT_AFK_TIMEOUT_MS = 15 * 60 * 1000;

export type AfkDecision =
    | { action: 'move' }
    /** Not idle long enough — re-check after this many ms (the remainder of
     *  the window, so a 1-minute timeout can't take 2 minutes to act). */
    | { action: 'wait'; recheckInMs: number };

export function decideAfk(input: {
    /** The server's AFK window, ms. */
    timeoutMs: number;
    /** Actively sending a screen share or camera track. */
    broadcasting: boolean;
    /** Seconds since the last OS-wide input, or null when no probe exists
     *  (browser, mobile, non-Windows desktop, or a probe error — the caller
     *  maps errors to a full-window wait itself, fail-open). */
    osIdleSecs: number | null;
    /** Epoch ms of the last input inside the app, or null if none recorded. */
    lastAppInputMs: number | null;
    nowMs: number;
    /** Watching someone ELSE's stream. Presence only where no OS probe
     *  exists — see the header. Optional so the desktop callers and the
     *  older tests read unchanged. */
    watching?: boolean;
}): AfkDecision {
    const { timeoutMs, broadcasting, osIdleSecs, lastAppInputMs, nowMs, watching = false } = input;
    if (broadcasting) return { action: 'wait', recheckInMs: timeoutMs };
    if (osIdleSecs !== null) {
        const idleMs = osIdleSecs * 1000;
        if (idleMs >= timeoutMs) return { action: 'move' };
        return { action: 'wait', recheckInMs: Math.max(1000, timeoutMs - idleMs) };
    }
    // No OS probe from here on. A phone viewer in the docked mini-player
    // touches nothing for as long as the stream holds them.
    if (watching) return { action: 'wait', recheckInMs: timeoutMs };
    if (lastAppInputMs !== null) {
        const idleMs = nowMs - lastAppInputMs;
        if (idleMs >= timeoutMs) return { action: 'move' };
        return { action: 'wait', recheckInMs: Math.max(1000, timeoutMs - idleMs) };
    }
    return { action: 'move' };
}
