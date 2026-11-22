/**
 * Logout teardown, inverted so `auth.ts` never imports a feature module.
 *
 * WHY THIS EXISTS. `logout()` has to tear down state owned by optional
 * features — remembered unattended seeds, in-flight device wakes. Importing
 * those directly put `auth.ts` on the same import path as the whole
 * remote-control stack, and because `api/devices/index.ts` imports `../auth`
 * straight back, the cycle dragged `session.ts`, `wake.ts` and `machines.ts`
 * into the MAIN chunk of every build — including a lite build whose entire
 * point is that none of that code ships.
 *
 * A leaf module with zero imports breaks the cycle: features REGISTER their
 * own cleanup when they install themselves, and `logout()` just drains the
 * list. Nothing here knows what a device or a wake is.
 *
 * Registration is idempotent per function reference, so a feature that
 * re-installs (a reconnect, a hot reload) cannot queue its cleanup twice.
 */

/**
 * Why the hooks run.
 *  - `sign-out`: the account signed out, here (logout()) or in another
 *    document (api/sessionSync.ts clearSharedSessionCaches).
 *  - `account-change`: somebody ELSE signed in on this running app after the
 *    last account's session here ended without a sign-out (it ran out, which
 *    keeps everything for the same account signing back in; App.tsx). What the
 *    last account read and was told goes as at a sign-out. A hook keeps only
 *    what is bound to its own account and is that account's alone to be given
 *    (a recovery code waiting for its account's sign-in, api/recoveryPrompt.ts):
 *    the sign-in that brought this run may be the very one it was kept for.
 */
export type LogoutCleanupReason = 'sign-out' | 'account-change';

type Cleanup = (reason: LogoutCleanupReason) => void;

const cleanups = new Set<Cleanup>();

/**
 * Register work that must run on sign-out, and when somebody else signs in
 * after a session ran out (`reason`, above). Returns an unregister function —
 * a feature that can be torn down independently of a logout must be able to
 * withdraw its hook, or the Set pins the closure (and whatever it captured)
 * for the life of the page.
 */
export function registerLogoutCleanup(fn: Cleanup): () => void {
    cleanups.add(fn);
    return () => { cleanups.delete(fn); };
}

/**
 * Run every registered cleanup. Each is isolated: a cleanup that throws must
 * not abort the ones after it, because this runs on the sign-out path where
 * the alternative is leaving the NEXT user's session holding the previous
 * user's state. Failures are logged, never rethrown.
 */
export function runLogoutCleanups(reason: LogoutCleanupReason = 'sign-out'): void {
    for (const fn of cleanups) {
        try {
            fn(reason);
        } catch (e) {
            console.warn('[logout] cleanup failed:', e);
        }
    }
}

/** Test hook: drop every registration. */
export function __resetLogoutCleanupsForTest(): void {
    cleanups.clear();
}
