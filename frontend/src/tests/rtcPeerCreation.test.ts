/**
 * Regression test for the peer-creation TOCTOU leak (fixed alongside the
 * "CPU climbs over a long stream" bug): getOrCreatePeer awaits the ICE config
 * BEFORE inserting into the peers map, so two concurrent callers for the same
 * user could each build a separate RTCPeerConnection and orphan one — which
 * keeps running its per-frame media-E2EE encrypt transform forever. The fix
 * coalesces concurrent same-user builds onto one in-flight promise.
 *
 * This test drives the real manager with a counting RTCPeerConnection and an
 * async-gapped ICE config, and asserts exactly ONE connection is built for two
 * concurrent callUser() calls to the same peer (and two for distinct peers).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Give getRtcConfigAsync a real async gap (a resolved promise, one microtask)
// so the concurrency window is genuinely exercised.
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        iceTransportPolicy: 'all',
    })),
}));

import { WebRTCManager } from '../api/rtc/manager';

let constructed = 0;

class CountingRTCPeerConnection {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    connectionState = 'new';
    constructor() { constructed++; }
    getSenders() { return []; }
    close() { /* no-op */ }
}

beforeEach(() => {
    constructed = 0;
    // setup.ts defines RTCPeerConnection non-writable; stubGlobal overrides it.
    vi.stubGlobal('RTCPeerConnection', CountingRTCPeerConnection);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('WebRTCManager peer-creation concurrency', () => {
    it('builds exactly ONE connection for two concurrent same-user calls', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1); // sets inVoice = true so the epoch guard passes

        // Fire two concurrent calls for the SAME peer, as a doubled StreamStarted
        // handler + reconnect storm would.
        await Promise.all([mgr.callUser(2), mgr.callUser(2)]);

        expect(constructed).toBe(1);
    });

    it('still builds one connection per distinct user', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);

        await Promise.all([mgr.callUser(2), mgr.callUser(3), mgr.callUser(2)]);

        // Two distinct peers (2 and 3); the duplicate call to 2 must not add a third.
        expect(constructed).toBe(2);
    });

    it('does not resurrect a peer when voice is left mid-build', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);

        // Start a build, then leave voice before it resolves; the in-flight build
        // must self-abort (close its pc, not re-insert) rather than leak.
        const pending = mgr.callUser(2);
        mgr.closeAll(); // bumps voiceEpoch + sets inVoice = false
        await pending;

        expect(mgr.getConnectedPeers()).toHaveLength(0);
    });
});
