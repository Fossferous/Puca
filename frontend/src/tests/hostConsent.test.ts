import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    requestHostConsent,
    setHostConsentHandler,
    resetHostConsentHandler,
} from '../api/devices/hostConsent';

/**
 * The consent bridge exists because shipping the agent removes the browser's
 * screen picker, which was — accidentally — the host's only consent step. These
 * pin the two properties that make it safe to remove.
 */
beforeEach(() => resetHostConsentHandler());

describe('host consent', () => {
    /**
     * THE LOAD-BEARING ONE. A host with no UI mounted must DENY, never allow:
     * the caller is about to start capturing this machine's screen, and "nobody
     * was there to ask" is not permission.
     */
    it('denies when no UI is mounted to ask', async () => {
        expect(await requestHostConsent('phone', [])).toBeNull();
    });

    it('resolves with the chosen monitor when allowed', async () => {
        setHostConsentHandler(req => req.resolve({ monitor: 2 }));
        expect(await requestHostConsent('phone', [
            { id: 0, label: 'Screen 1' }, { id: 2, label: 'Screen 3' },
        ])).toEqual({ monitor: 2 });
    });

    it('resolves null when the person denies', async () => {
        setHostConsentHandler(req => req.resolve(null));
        expect(await requestHostConsent('phone', [])).toBeNull();
    });

    /** The prompt needs to name who is asking and what it may show. */
    it('passes the peer and the monitor list to the UI', async () => {
        let seen: { peerDevice: string; monitors: unknown[] } | null = null;
        setHostConsentHandler(req => {
            seen = { peerDevice: req.peerDevice, monitors: req.monitors };
            req.resolve(null);
        });
        await requestHostConsent('dev-phone', [{ id: 0, label: 'Screen 1' }]);
        expect(seen!.peerDevice).toBe('dev-phone');
        expect(seen!.monitors).toHaveLength(1);
    });

    /** Unregistering must restore the deny-by-default, not leave a stale handler. */
    it('goes back to denying after the UI unmounts', async () => {
        const off = setHostConsentHandler(req => req.resolve({ monitor: 0 }));
        expect(await requestHostConsent('phone', [])).toEqual({ monitor: 0 });
        off();
        expect(await requestHostConsent('phone', [])).toBeNull();
    });
});

describe('the ask expires', () => {
    /**
     * The server reaps an unanswered connect request at 60s. Without a deadline
     * the modal stayed up over the whole app after the session it was asking
     * about had died, and a late Allow accepted a session that no longer
     * existed.
     */
    it('denies on its own after the deadline', async () => {
        vi.useFakeTimers();
        try {
            setHostConsentHandler(() => { /* a user who never answers */ });
            const p = requestHostConsent('phone', []);
            await vi.advanceTimersByTimeAsync(46_000);
            await expect(p).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    /** A late Allow after the deadline must not resurrect a dead session. */
    it('ignores an answer that arrives after it expired', async () => {
        vi.useFakeTimers();
        try {
            let late: ((v: { monitor: number } | null) => void) | null = null;
            setHostConsentHandler(req => { late = req.resolve; });
            const p = requestHostConsent('phone', []);
            await vi.advanceTimersByTimeAsync(46_000);
            late!({ monitor: 3 });
            await expect(p).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
