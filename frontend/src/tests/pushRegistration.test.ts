import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The JS side of NATIVE background delivery (the self-hosted replacement for
 * the removed FCM path): credentials, gates, and the account binding all live
 * in WebView storage that Java cannot read, so this module's syncs are the
 * only bridge. A missed sync is invisible until a mute stops working or the
 * native token expires — hence pinning every duty here.
 */

// A REAL localStorage: the shared setup.ts installs vi.fn() stubs that store
// nothing, and this module reads the auth token and the mute stores out of
// storage — against the stubs every path here is "signed out" forever. Same
// fix as backgroundDeliveryMigration.test.ts, for the same reason.
const backing = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
        getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
        setItem: (k: string, v: string) => { backing.set(k, String(v)); },
        removeItem: (k: string) => { backing.delete(k); },
        clear: () => { backing.clear(); },
    },
});

const bridge = vi.hoisted(() => ({
    setMobileNativeDelivery: vi.fn().mockResolvedValue(undefined),
    setMobilePushAccount: vi.fn<(id: number | null) => Promise<void>>().mockResolvedValue(undefined),
    syncMobilePushGates: vi.fn().mockResolvedValue(undefined),
    getMobileWakeToken: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    disableMobileWake: vi.fn().mockResolvedValue(undefined),
}));
const api = vi.hoisted(() => ({
    post: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
}));
const platform = vi.hoisted(() => ({ mobile: true }));

vi.mock('../api/mobileApp', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/mobileApp')>()),
    setMobileNativeDelivery: bridge.setMobileNativeDelivery,
    setMobilePushAccount: bridge.setMobilePushAccount,
    syncMobilePushGates: bridge.syncMobilePushGates,
    getMobileWakeToken: bridge.getMobileWakeToken,
    disableMobileWake: bridge.disableMobileWake,
}));
vi.mock('../api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/client')>()),
    apiClient: { post: api.post, delete: api.delete },
}));
vi.mock('../api/thisDevice', () => ({ thisDeviceId: () => 'dev-test-1' }));
vi.mock('../api/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isMobile: () => platform.mobile,
}));

import { initPushRegistration, teardownPushRegistration } from '../api/pushRegistration';
import { setServerNotifyLevel } from '../components/mutedServersStore';
import { loadSettings, saveSettings } from '../components/settingsStore';
import { storeRenewedToken } from '../api/auth';

/** Mint an unsigned JWT carrying `sub`, the way the test-env auth helpers do. */
function fakeToken(sub: number, salt = ''): string {
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    return `${b64({ alg: 'none' })}.${b64({ sub, salt, exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
}

beforeEach(async () => {
    platform.mobile = true;
    // This module holds latches (the registered wake token) and installs
    // window listeners, and there is no resetModules here — so without an
    // explicit reset each test inherits the previous one's state, and an
    // assertion can pass or fail for reasons belonging to another test.
    await teardownPushRegistration();
    vi.clearAllMocks();
    // clearAllMocks resets CALL RECORDS but keeps implementations, so a
    // mockResolvedValue set by one test leaks into every later one. Restore
    // the default explicitly: tests that need a wake token set their own.
    bridge.getMobileWakeToken.mockResolvedValue(null);
    backing.clear();
    localStorage.setItem('auth_token', fakeToken(9));
});

describe('initPushRegistration', () => {
    it('binds the account, mirrors the gates, and hands over the socket credentials', async () => {
        await initPushRegistration();
        expect(bridge.setMobilePushAccount).toHaveBeenCalledWith(9);
        expect(bridge.syncMobilePushGates).toHaveBeenCalled();
        expect(bridge.setMobileNativeDelivery).toHaveBeenCalledWith(expect.objectContaining({
            token: localStorage.getItem('auth_token'),
            wsUrl: expect.stringContaining('ws'),
        }));
    });

    it('re-mirrors when a server mute changes', async () => {
        await initPushRegistration();
        const before = bridge.syncMobilePushGates.mock.calls.length;
        setServerNotifyLevel('srv-1', 'nothing'); // fires serverMuteChanged
        await Promise.resolve();
        expect(bridge.syncMobilePushGates.mock.calls.length).toBeGreaterThan(before);
        const last = bridge.syncMobilePushGates.mock.calls.at(-1)![0];
        expect(last.mutedServers['srv-1']).toBe(true);
    });

    it('re-syncs the token on sliding-session renewal — or native delivery dies 24h after login', async () => {
        await initPushRegistration();
        const before = bridge.setMobileNativeDelivery.mock.calls.length;
        const old = localStorage.getItem('auth_token')!;
        const renewed = fakeToken(9, 'renewed');
        storeRenewedToken(old, renewed); // fires authTokenRenewed
        await Promise.resolve();
        expect(bridge.setMobileNativeDelivery.mock.calls.length).toBeGreaterThan(before);
        expect(bridge.setMobileNativeDelivery.mock.calls.at(-1)![0]).toMatchObject({ token: renewed });
    });

    it('does nothing signed out', async () => {
        localStorage.removeItem('auth_token');
        await initPushRegistration();
        expect(bridge.setMobilePushAccount).not.toHaveBeenCalled();
        expect(bridge.setMobileNativeDelivery).not.toHaveBeenCalled();
    });

    it('does nothing off mobile', async () => {
        platform.mobile = false;
        await initPushRegistration();
        expect(bridge.setMobilePushAccount).not.toHaveBeenCalled();
    });
});

describe('wake doorbell registration', () => {
    it('registers the wake token with the server when one exists', async () => {
        bridge.getMobileWakeToken.mockResolvedValue('wake-tok-1');
        await initPushRegistration();
        await new Promise(r => setTimeout(r, 0)); // registration is unawaited by design
        expect(api.post).toHaveBeenCalledWith('/device/register', expect.objectContaining({
            token: 'wake-tok-1',
            platform: 'android',
        }));
    });

    it('hands the native socket the device id, so revoke can reach it', async () => {
        await initPushRegistration();
        expect(bridge.setMobileNativeDelivery).toHaveBeenCalledWith(
            expect.objectContaining({ deviceId: 'dev-test-1' }));
    });

    it('registers nothing without a token — socket-only builds stay silent to Google', async () => {
        bridge.getMobileWakeToken.mockResolvedValue(null);
        await initPushRegistration();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('unregisters the doorbell on teardown, before the account unbinds', async () => {
        bridge.getMobileWakeToken.mockResolvedValue('wake-tok-2');
        await initPushRegistration();
        // Registration is deliberately fire-and-forget (a wedged Firebase
        // promise must not block the gate listeners) — let it settle before
        // the teardown that should unregister it.
        await new Promise(r => setTimeout(r, 0));
        await teardownPushRegistration();
        expect(api.delete).toHaveBeenCalledWith('/device/unregister', expect.objectContaining({
            body: expect.stringContaining('wake-tok-2'),
        }));
    });
});

describe('the background-delivery opt-out', () => {
    /** Flip a setting and let the settingsChanged listeners run. */
    async function setBackgroundDelivery(on: boolean): Promise<void> {
        const s = { ...loadSettings(), mobileBackgroundDelivery: on };
        saveSettings(s);
        await new Promise(r => setTimeout(r, 0));
    }

    it('tears the socket down when the user turns it off', async () => {
        // The bug: settingsChanged only refreshed the gate MIRROR, so an
        // opted-out phone kept its native credentials and stayed connected.
        await initPushRegistration();
        expect(bridge.setMobileNativeDelivery).toHaveBeenCalledWith(
            expect.objectContaining({ token: expect.any(String) }));
        await setBackgroundDelivery(false);
        expect(bridge.setMobileNativeDelivery).toHaveBeenLastCalledWith(null);
    });

    it('unregisters the doorbell too — the phone stops being addressable', async () => {
        bridge.getMobileWakeToken.mockResolvedValue('wake-tok-optout');
        await initPushRegistration();
        await new Promise(r => setTimeout(r, 0));
        await setBackgroundDelivery(false);
        expect(api.delete).toHaveBeenCalledWith('/device/unregister', expect.objectContaining({
            body: expect.stringContaining('wake-tok-optout'),
        }));
    });

    it('re-registers when turned back on — the latch releases', async () => {
        // A registration latch with no release path makes opt-in a silent
        // no-op forever after. This is the shape that has bitten twice.
        bridge.getMobileWakeToken.mockResolvedValue('wake-tok-relatch');
        await initPushRegistration();
        await new Promise(r => setTimeout(r, 0));
        await setBackgroundDelivery(false);
        api.post.mockClear();
        await setBackgroundDelivery(true);
        await new Promise(r => setTimeout(r, 0));
        expect(api.post).toHaveBeenCalledWith('/device/register', expect.objectContaining({
            token: 'wake-tok-relatch',
        }));
        expect(bridge.setMobileNativeDelivery).toHaveBeenLastCalledWith(
            expect.objectContaining({ token: expect.any(String) }));
    });

    it('mirrors the switch natively, so a wake can be refused on the device', async () => {
        await initPushRegistration();
        await setBackgroundDelivery(false);
        const last = bridge.syncMobilePushGates.mock.calls.at(-1)![0];
        expect(last.backgroundDelivery).toBe(false);
        // Kept SEPARATE from the master notification switch: folding them
        // together would silence foreground notifications as well.
        expect(last.pushEnabled).toBe(true);
    });
});

describe('credential re-sync', () => {
    it('always reaches the native side, so a cleared native copy can recover', async () => {
        // Deciding whether the credentials CHANGED — and so whether to drop
        // and redial the socket — belongs to Java (DeliveryCreds), which is
        // the only half that knows what the socket currently holds. A JS-side
        // "already synced this" cache looks free and is not: NativeDelivery
        // wipes its credentials on a 401 without telling JS, and the cache
        // would then suppress the very re-sync that recovers from it, leaving
        // delivery dead until the next token change or app restart.
        await initPushRegistration();
        const after = bridge.setMobileNativeDelivery.mock.calls.length;
        window.dispatchEvent(new Event('deviceAttested'));
        await new Promise(r => setTimeout(r, 0));
        expect(bridge.setMobileNativeDelivery.mock.calls.length).toBeGreaterThan(after);
    });

    it('re-syncs a genuinely renewed token', async () => {
        // If this ever stops firing, the native token expires ~24h after
        // login and background delivery dies silently, long after any deploy.
        await initPushRegistration();
        const after = bridge.setMobileNativeDelivery.mock.calls.length;
        const renewed = fakeToken(9, 'renew-control');
        storeRenewedToken(localStorage.getItem('auth_token')!, renewed);
        await new Promise(r => setTimeout(r, 0));
        expect(bridge.setMobileNativeDelivery.mock.calls.length).toBeGreaterThan(after);
        expect(bridge.setMobileNativeDelivery.mock.calls.at(-1)![0]).toMatchObject({ token: renewed });
    });

    it('does not re-ask for the wake token on every unrelated setting change', async () => {
        // settingsChanged fires for theme, font size, anything. Re-asking
        // crosses the bridge to a Firebase promise that on a
        // no-Play-Services build may never settle.
        bridge.getMobileWakeToken.mockResolvedValue('wake-tok-churn');
        await initPushRegistration();
        await new Promise(r => setTimeout(r, 0));
        const after = bridge.getMobileWakeToken.mock.calls.length;
        saveSettings({ ...loadSettings(), fontSize: 'large' } as never);
        await new Promise(r => setTimeout(r, 0));
        expect(bridge.getMobileWakeToken.mock.calls.length).toBe(after);
    });
});

describe('teardownPushRegistration', () => {
    it('clears the credentials AND the account binding', async () => {
        await initPushRegistration();
        await teardownPushRegistration();
        expect(bridge.setMobileNativeDelivery).toHaveBeenLastCalledWith(null);
        expect(bridge.setMobilePushAccount).toHaveBeenLastCalledWith(null);
    });

    it('stops re-syncing after teardown — a signed-out app must not refresh gates', async () => {
        await initPushRegistration();
        await teardownPushRegistration();
        const after = bridge.syncMobilePushGates.mock.calls.length;
        setServerNotifyLevel('srv-2', 'nothing');
        await Promise.resolve();
        expect(bridge.syncMobilePushGates.mock.calls.length).toBe(after);
    });

    /**
     * The consent gate has to be revocable. Enabling Firebase auto-init on
     * first use and never disabling it left a phone registered with Google
     * after sign-out — consent granted once and never withdrawable.
     *
     * This assertion exists because the mock previously OMITTED
     * disableMobileWake, so both call sites fell through to the real jsdom
     * no-op and no test could observe whether revocation happened at all.
     */
    it('stops this device registering with Google', async () => {
        await initPushRegistration();
        await teardownPushRegistration();
        expect(bridge.disableMobileWake).toHaveBeenCalled();
    });
});
