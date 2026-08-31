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

type Cleanup = () => void;

const cleanups = new Set<Cleanup>();

/**
 * Register work that must run on sign-out. Returns an unregister function —
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
export function runLogoutCleanups(): void {
    for (const fn of cleanups) {
        try {
            fn();
        } catch (e) {
            console.warn('[logout] cleanup failed:', e);
        }
    }
}

/** Test hook: drop every registration. */
export function __resetLogoutCleanupsForTest(): void {
    cleanups.clear();
}
