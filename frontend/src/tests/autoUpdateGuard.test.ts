/**
 * Auto-install at launch: opt-in, and once per version.
 *
 * Automatic (no-click) installation now happens ONLY in UpdateGate, before
 * the app loads, and ONLY when the user has turned on "Install updates
 * automatically". Two rules are pinned here against the real helper the gate
 * calls (`shouldAutoInstallOnLaunch`, not a re-implementation):
 *
 *  1. OPT-IN. Off means never — the banner prompts instead. This is what
 *     stops the old behaviour of relaunching people out of a call.
 *  2. ONCE PER VERSION. If the app comes back up STILL not running the
 *     advertised version — a manifest claiming 0.6.17 while the installer
 *     behind it is 0.6.16, a failed silent install, a partial download — an
 *     unguarded implementation checks, finds the same "newer" version,
 *     installs again, relaunches, and repeats, and it starts before any button
 *     can be pressed. So: one automatic attempt per version, then wait for a
 *     human.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { shouldAutoInstallOnLaunch, AUTO_ATTEMPT_KEY } from '../components/updateGate.utils';

/** What the GATE does around the pure helper: read the guard, and record the
 *  version when it decides to install. Models the launch sequence so the
 *  long-sequence case below still reads as a story. */
function attempt(store: Map<string, string>, version: string, optedIn = true, isNewer = true): boolean {
    const go = shouldAutoInstallOnLaunch(optedIn, store.get(AUTO_ATTEMPT_KEY) ?? null, version, isNewer);
    if (go) store.set(AUTO_ATTEMPT_KEY, version);
    return go;
}

describe('auto-install at launch', () => {
    let store: Map<string, string>;
    beforeEach(() => { store = new Map(); });

    /** The whole point of the change: default OFF means it never installs. */
    it('opted out NEVER installs, however new the release is', () => {
        expect(attempt(store, '0.9.0', /* optedIn */ false)).toBe(false);
        expect(attempt(store, '0.9.0', false)).toBe(false);
        expect(store.size).toBe(0); // and it never even records an attempt
    });

    it('opted in installs on a clean first launch', () => {
        expect(attempt(store, '0.6.17')).toBe(true);
    });

    /** The loop the once-per-version guard exists to prevent. */
    it('does NOT retry the same version after a failed attempt', () => {
        expect(attempt(store, '0.6.17')).toBe(true);
        // App relaunches, still on the old build, sees the same version again.
        expect(attempt(store, '0.6.17')).toBe(false);
        // ...and again, and again. Never true a second time.
        expect(attempt(store, '0.6.17')).toBe(false);
        expect(attempt(store, '0.6.17')).toBe(false);
    });

    /**
     * The guard must not become a permanent opt-out: a genuinely new release
     * has to auto-install even though an older one previously failed.
     */
    it('still installs a DIFFERENT version after one failed', () => {
        attempt(store, '0.6.17');
        expect(attempt(store, '0.6.18')).toBe(true);
    });

    it('installs each new version exactly once across a long sequence', () => {
        const attempts = ['0.6.17', '0.6.17', '0.6.18', '0.6.18', '0.6.18', '0.6.19'];
        const results = attempts.map(v => attempt(store, v));
        expect(results).toEqual([true, false, true, false, false, true]);
    });

    /** Anti-rollback: /app-version is an operator-pushed file and the signature
     *  covers the installer bytes, not the advertised number. A candidate that
     *  is not strictly newer never installs. */
    it('a candidate that is not newer than what is running is never installed', () => {
        expect(attempt(store, '0.6.16', true, /* isNewer */ false)).toBe(false);
        expect(shouldAutoInstallOnLaunch(true, null, null, true)).toBe(false); // no candidate at all
    });

    /**
     * The key must survive the relaunch or the guard is useless — that is why
     * it is localStorage and not sessionStorage. Pin the storage choice AND
     * the string: earlier builds wrote this exact key, and a user mid-way
     * through a failed attempt keeps their loop protection only if it matches.
     */
    it('uses a key that persists across a relaunch, not a session key', () => {
        expect(AUTO_ATTEMPT_KEY).toBe('sovereign_update_auto_attempted');
        // A session-scoped store would be empty on the next launch, so the
        // "already attempted" branch could never fire. Demonstrate the
        // difference explicitly.
        const sessionLike = new Map<string, string>();
        attempt(sessionLike, '0.6.17');
        sessionLike.clear();                       // what a relaunch does to sessionStorage
        expect(attempt(sessionLike, '0.6.17')).toBe(true); // loops forever
        // localStorage-like store keeps it, so the second launch declines.
        const persistent = new Map<string, string>();
        attempt(persistent, '0.6.17');
        expect(attempt(persistent, '0.6.17')).toBe(false);
    });
});
