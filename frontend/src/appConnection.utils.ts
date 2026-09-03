/** Pure helpers for App.tsx's connection-failure screen, kept out of the
 *  component file so fast-refresh stays happy and they are testable alone —
 *  the same split as `privacyDisclosure.utils.ts`. */

import type { SessionProbe } from './api/client';

/** What actually went wrong, so the screen can say so. A dead SESSION is
 *  deliberately absent: that re-authenticates instead of reaching the screen. */
export type ConnectionFailure = 'unreachable' | 'socket' | 'stale-client';

/**
 * Backoff, not a fixed delay.
 *
 * Three attempts one second apart gave up after ~3 seconds, and a backend
 * restart takes longer than that — so every deploy threw the error dialog at
 * everyone connected, for a condition that fixes itself within seconds. This
 * spans ~15s, which covers a restart, while still failing fast enough that a
 * genuinely dead socket does not leave someone watching a spinner.
 */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

/** Total time the automatic retries cover before the screen appears. */
export const RETRY_BUDGET_MS = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);

/**
 * Which failure the screen should describe.
 *
 * The interesting case is `probe === 'ok'`: the server answered and accepted
 * our token over HTTP, so only the socket failed. The most useful question
 * remaining is whether THIS BUILD is too old to open one — since 0.9.1 the
 * server refuses the query-string token that every client before 0.9.0 sends,
 * while REST keeps working, so a stale install lands precisely here. The old
 * copy then showed a dialog blaming the user's firewall, and neither of its
 * buttons could fix it; only replacing the binary can.
 *
 * A newer published release is not proof of that fault, but it is the one
 * actionable answer available and it is never wrong advice: if a socket will
 * not open and the app is out of date, updating is the right next step.
 */
export function failureFor(probe: SessionProbe, updateAvailable: boolean): ConnectionFailure {
    if (probe !== 'ok') return 'unreachable';
    return updateAvailable ? 'stale-client' : 'socket';
}
