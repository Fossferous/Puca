// @vitest-environment jsdom
/**
 * A page that starts has no control session, so the phone must not keep one
 * (api/remoteControl.ts, initRemoteControl). A reload (the ErrorBoundary's,
 * an OTA's) used to leave the native session up, with its orange frame and
 * Stop control, and nothing in the new page that could end it or would ever
 * send it input. Red without the endPhoneControl() at the top of
 * initRemoteControl.
 *
 * Its own file: it needs a FRESH remoteControl module (wiring runs once).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/websocket', () => ({
    wsClient: { isConnected: true, on: () => {}, send: () => {}, bufferedAmount: () => 0 },
}));
vi.mock('../api/platform', () => ({ isTauri: () => false, isMobile: () => true }));
vi.mock('../components/voiceState', () => ({
    getCurrentStreamingUserId: () => null,
    getStreamData: () => null,
    selectStream: () => {},
}));
vi.mock('../api/rtc/receiverLatency', () => ({
    clearAllScreenLatency: () => {},
    setScreenLatencyMinimised: () => {},
}));
vi.mock('../api/dms', () => ({ getCachedPublicKey: async () => '' }));
vi.mock('../api/mobileApp', () => ({
    postMobileNotification: async () => {},
    clearMobileNotifications: async () => {},
}));

const phone = { ended: 0 };
vi.mock('../api/phoneControl', async () => {
    const real = await vi.importActual<typeof import('../api/phoneControl')>('../api/phoneControl');
    return {
        refusalWords: real.refusalWords,
        endedWords: real.endedWords,
        phoneHostPossible: () => true,
        beginPhoneControl: async () => ({ ok: true, refusal: null }),
        endPhoneControl: () => { phone.ended++; },
        injectPhoneControl: async () => {},
        onPhoneControlEnded: () => () => {},
    };
});

describe('a page starting', () => {
    it('ends any native control session a page before it left behind, once', async () => {
        const rc = await import('../api/remoteControl');
        expect(phone.ended).toBe(0);
        rc.initRemoteControl();
        expect(phone.ended, 'the leftover session is ended').toBe(1);
        rc.initRemoteControl();
        expect(phone.ended, 'wiring runs once').toBe(1);
    });
});
