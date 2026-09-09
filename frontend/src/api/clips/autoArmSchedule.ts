/**
 * When auto-arm should try, and how many times.
 *
 * WHY ARMING IS RETRIED AT ALL. Auto-arm fires 800 ms after joining a voice
 * channel, and the app rejoins within about a second of launching — so the very
 * first thing a cold start does is open a DXGI desktop duplication, while
 * Windows is still bringing the app's window up. Measured from a real machine's
 * log on 2026-09-09:
 *
 *     09-06 16:14:37 start -> 16:14:39 armed OK   (+2s)
 *     09-06 17:52:27 start -> 17:52:29 armed OK   (+2s)
 *     09-07 16:37:13 start -> 16:37:15 armed OK   (+2s)
 *     09-09 17:49:52 start -> 17:49:53 FAILED     (+1s)
 *     09-09 19:47:27 start -> 19:47:28 FAILED     (+1s)
 *
 * Every arm that landed two seconds after start succeeded; both that landed one
 * second after start failed to duplicate ANY monitor — the same monitors that
 * duplicate perfectly a minute later.
 *
 * The race was always there. It only became visible when the extra "this server
 * has been armed by hand once" gate came out in 0.9.803, which let auto-arm
 * fire on a cold start again. A longer fixed delay would just be a guess about
 * someone else's machine; retrying is self-tuning — a host that is ready
 * immediately still arms immediately, and a slow one takes the second or third
 * attempt instead of showing a failure the member cannot act on.
 *
 * ITS OWN MODULE, importing nothing. `replayBuffer` reaches the Tauri bridge
 * and the API config behind it, so a test that wanted this schedule from there
 * had to mock that whole chain — the same trap that split shareHealth.ts from
 * shareHealthLive.ts.
 */

/** Delay before each attempt, in milliseconds. Length = attempts allowed. */
export const AUTO_ARM_BACKOFF_MS = [800, 2_000, 5_000] as const;

/**
 * The delay before attempt `n` (0-based), or null when there are none left —
 * at which point the caller falls back to nudging the Arm button, which is what
 * a genuine "this machine cannot capture" has always done.
 */
export function autoArmDelayMs(attempt: number): number | null {
    return attempt >= 0 && attempt < AUTO_ARM_BACKOFF_MS.length ? AUTO_ARM_BACKOFF_MS[attempt] : null;
}
