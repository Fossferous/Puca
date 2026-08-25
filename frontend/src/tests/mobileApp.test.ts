/**
 * The SovereignApp plugin wrapper: keep-alive reason merging, silent
 * degradation on an APK without the plugin, and the pending-navigation
 * hold/consume/defer cycle that carries widget buttons and notification taps
 * into a Chat component that mounts seconds after launch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    platform: 'android',
    reject: false,
    // Method-scoped failures: a transient bridge error on ONE call must be
    // distinguishable from the whole plugin being absent.
    rejectStatus: false,
    rejectBattery: false,
    rejectShowKeyboard: false,
    calls: [] as Array<Record<string, unknown>>,
    listeners: [] as Array<(d: { target: string }) => void>,
    launchNav: null as string | null,
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => h.platform,
        isNativePlatform: () => h.platform !== 'web',
    },
    registerPlugin: () => ({
        setKeepAlive: async (opts: Record<string, unknown>) => {
            // Attempts are recorded BEFORE the throw: the retry-loop test
            // below counts native-bridge crossings, refused or not.
            if (h.reject) {
                h.calls.push({ setKeepAlive: opts, rejected: true });
                throw new Error('refused');
            }
            h.calls.push({ setKeepAlive: opts });
        },
        notify: async (opts: Record<string, unknown>) => {
            if (h.reject) throw new Error('plugin missing');
            h.calls.push({ notify: opts });
        },
        clearNotifications: async (opts: Record<string, unknown>) => {
            if (h.reject) throw new Error('plugin missing');
            h.calls.push({ clear: opts });
        },
        consumeLaunchNav: async () => {
            if (h.reject) throw new Error('plugin missing');
            return { target: h.launchNav };
        },
        addListener: async (_evt: string, cb: (d: { target: string }) => void) => {
            h.listeners.push(cb);
            return { remove: async () => {} };
        },
        notificationStatus: async () => {
            if (h.reject || h.rejectStatus) throw new Error('bridge hiccup');
            h.calls.push({ notificationStatus: true });
            return { granted: true, needsRequest: false };
        },
        requestNotificationPermission: async () => {
            if (h.reject || h.rejectStatus) throw new Error('bridge hiccup');
            return { granted: true };
        },
        batteryStatus: async () => {
            // Crossings recorded BEFORE the throw (the setKeepAlive
            // convention): the latch tests count bridge round-trips, and an
            // unobservable refusal makes their assertions vacuous.
            if (h.reject || h.rejectBattery) {
                h.calls.push({ batteryStatus: true, rejected: true });
                throw new Error('method missing');
            }
            h.calls.push({ batteryStatus: true });
            return { ignoring: false };
        },
        requestIgnoreBatteryOptimizations: async () => {
            if (h.reject || h.rejectBattery) {
                h.calls.push({ requestIgnore: true, rejected: true });
                throw new Error('method missing');
            }
            h.calls.push({ requestIgnore: true });
        },
        openNotificationSettings: async () => {
            if (h.reject || h.rejectBattery) {
                h.calls.push({ openNotifSettings: true, rejected: true });
                throw new Error('method missing');
            }
            h.calls.push({ openNotifSettings: true });
        },
        showKeyboard: async () => {
            if (h.reject || h.rejectShowKeyboard) {
                h.calls.push({ showKeyboard: true, rejected: true });
                throw new Error('method missing');
            }
            h.calls.push({ showKeyboard: true });
            return { ok: true };
        },
    }),
}));

async function freshModule() {
    vi.resetModules();
    return import('../api/mobileApp');
}

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => {
    h.platform = 'android';
    h.reject = false;
    h.rejectStatus = false;
    h.rejectBattery = false;
    h.rejectShowKeyboard = false;
    h.calls.length = 0;
    h.listeners.length = 0;
    h.launchNav = null;
});

describe('keep-alive reason merging', () => {
    it('pushes the COMPLETE state on every reason change, and dedupes repeats', async () => {
        const m = await freshModule();
        m.setControlKeepAlive(true);
        await settle();
        m.setNotifyKeepAlive(true);
        await settle();
        m.setControlKeepAlive(false);
        await settle();
        m.setControlKeepAlive(false); // repeat: no extra call
        await settle();
        expect(h.calls).toEqual([
            { setKeepAlive: { control: true, notify: false, geofence: false } },
            { setKeepAlive: { control: true, notify: true, geofence: false } },
            { setKeepAlive: { control: false, notify: true, geofence: false } },
        ]);
    });

    it('converges on the FINAL state when reasons flip during an in-flight call', async () => {
        const m = await freshModule();
        m.setControlKeepAlive(true);
        m.setControlKeepAlive(false);   // flips while the first push is out
        await settle();
        expect(h.calls[h.calls.length - 1]).toEqual(
            { setKeepAlive: { control: false, notify: false, geofence: false } },
        );
    });

    it('does nothing off Android', async () => {
        h.platform = 'web';
        const m = await freshModule();
        m.setControlKeepAlive(true);
        m.setNotifyKeepAlive(true);
        await settle();
        expect(h.calls).toEqual([]);
    });

    it('geofence merges as a third independent reason', async () => {
        const m = await freshModule();
        m.setNotifyKeepAlive(true);
        await settle();
        m.setGeofenceKeepAlive(true);
        await settle();
        // The MERGE is policy-free: one reason dropping must not take the
        // others with it. (Product policy — notifications-off also clearing
        // the fences — lives in taskPlaces.syncTaskPlacesToNative, which
        // would call setGeofenceKeepAlive(false) itself.)
        m.setNotifyKeepAlive(false);
        await settle();
        expect(h.calls).toEqual([
            { setKeepAlive: { control: false, notify: true, geofence: false } },
            { setKeepAlive: { control: false, notify: true, geofence: true } },
            { setKeepAlive: { control: false, notify: false, geofence: true } },
        ]);
    });

    it('a refusal AFTER the plugin proved usable is not retried in a loop', async () => {
        // The bug this pins: Android refuses foreground-service starts from
        // the background, the catch left `pushed` behind the desired state,
        // and the convergence re-push spun the bridge at ~70 calls/s for as
        // long as the session stayed active.
        const m = await freshModule();
        m.setNotifyKeepAlive(true);            // proves the plugin usable
        await settle();
        expect(h.calls.length).toBe(1);
        h.reject = true;
        m.setControlKeepAlive(true);           // this state gets refused
        await settle();
        expect(
            h.calls.length,
            'ONE refused attempt, not an unbounded retry loop',
        ).toBe(2);
        expect(m.mobileAppAvailable(), 'a transient refusal is not "old APK"').toBe(true);

        // The refused state IS retried when it becomes legal again — the app
        // coming to the foreground, where FGS starts are always allowed.
        h.reject = false;
        m.installMobileNav();                  // installs the visibility listener
        await settle();
        h.calls.length = 0;
        document.dispatchEvent(new Event('visibilitychange'));
        await settle();
        expect(h.calls).toEqual([
            { setKeepAlive: { control: true, notify: true, geofence: false } },
        ]);
    });

    it('re-asserts the full state on foreground return, exactly once', async () => {
        // JS is no longer the only writer of the native reason state — the
        // wake doorbell starts the service too. `pushed` is a claim about the
        // past, so without this repair a divergence is PERMANENT: every later
        // push is deduped against a state that no longer exists, and
        // setControlKeepAlive early-returns while the session's own view is
        // unchanged. Foreground return is the one moment an FGS start is
        // always legal, so it is where the truth gets re-asserted.
        //
        // A geofence-ONLY state is used because `installMobileNav` listeners
        // from earlier tests in this file survive vi.resetModules() (they are
        // bound to the shared jsdom document), and no other test produces
        // this combination — so the count below is attributable to THIS
        // module, not to a stale listener.
        const m = await freshModule();
        m.setGeofenceKeepAlive(true);
        await settle();
        m.installMobileNav();
        await settle();
        h.calls.length = 0;

        document.dispatchEvent(new Event('visibilitychange'));
        await settle();
        const mine = h.calls.filter(c => JSON.stringify(c.setKeepAlive)
            === JSON.stringify({ control: false, notify: false, geofence: true }));
        // Exactly one: clearing `pushed` is precisely what used to make the
        // convergence re-push in `finally` unbounded, so the count matters as
        // much as the presence.
        expect(mine.length, 're-asserted once, not spun').toBe(1);
    });

    it('does not re-push on foreground return when nothing is wanted', async () => {
        // The repair exists to protect live reasons. With none held there is
        // nothing to protect, and a push would only start a service that
        // immediately stops itself.
        const m = await freshModule();
        m.installMobileNav();
        await settle();
        h.calls.length = 0;
        document.dispatchEvent(new Event('visibilitychange'));
        await settle();
        const allFalse = h.calls.filter(c => JSON.stringify(c.setKeepAlive)
            === JSON.stringify({ control: false, notify: false, geofence: false }));
        expect(allFalse).toEqual([]);
    });

    it('degrades silently on an APK without the plugin, and stops calling', async () => {
        h.reject = true;
        const m = await freshModule();
        m.setControlKeepAlive(true);
        await settle();
        expect(m.mobileAppAvailable(), 'a reject marks the plugin unusable').toBe(false);
        h.calls.length = 0;
        await m.postMobileNotification('k', 'title', 'body');
        m.setNotifyKeepAlive(true);
        await settle();
        expect(h.calls, 'no further native calls after the APK proved old').toEqual([]);
    });
});

describe('the usable latch under transient errors', () => {
    it('a status error AFTER the plugin proved usable does not kill the module', async () => {
        // The bug this pins: mobileNotificationStatus's catch set
        // `usable = false` UNCONDITIONALLY, so one mid-session bridge hiccup
        // silently disabled the keep-alive service and every notification for
        // the rest of the session — on a fully current APK.
        const m = await freshModule();
        m.setNotifyKeepAlive(true);            // proves the plugin usable
        await settle();
        expect(m.mobileAppAvailable()).toBe(true);

        h.rejectStatus = true;
        expect(await m.mobileNotificationStatus(), 'the failed call itself returns null').toBeNull();
        expect(await m.requestMobileNotificationPermission()).toBe(false);
        expect(
            m.mobileAppAvailable(),
            'a transient error must not read as "old APK"',
        ).toBe(true);

        h.rejectStatus = false;
        h.calls.length = 0;
        await m.postMobileNotification('k', 't', 'b');
        expect(h.calls, 'notifications still flow after the hiccup').toEqual([
            { notify: { key: 'k', title: 't', body: 'b', nav: undefined } },
        ]);
    });

    it('POSITIVE CONTROL: a first-ever failure still detects an old APK', async () => {
        h.reject = true;
        const m = await freshModule();
        expect(await m.mobileNotificationStatus()).toBeNull();
        expect(
            m.mobileAppAvailable(),
            'the rig CAN see the latch close — first-call failure means no plugin',
        ).toBe(false);
    });
});

describe('battery methods on APKs without them', () => {
    it('their absence latches THEIR capability, never the whole plugin', async () => {
        // APKs 0.8.34-0.8.37 have the plugin but not the battery methods —
        // notifications must keep working there.
        const m = await freshModule();
        m.setNotifyKeepAlive(true);
        await settle();
        h.rejectBattery = true;
        expect(await m.mobileBatteryStatus()).toBeNull();
        // batterySupported latched by the status probe: the request short-
        // circuits on the entry guard, no native call.
        h.calls.length = 0;
        expect(await m.requestIgnoreBatteryOptimizations()).toBe(false);
        expect(h.calls, 'entry guard, not a repeated native crossing').toEqual([]);
        expect(await m.openMobileNotificationSettings()).toBe(false);
        expect(m.mobileAppAvailable(), 'core plugin unaffected').toBe(true);

        // And the failed capabilities stay latched: no more native calls.
        h.calls.length = 0;
        expect(await m.mobileBatteryStatus()).toBeNull();
        expect(await m.openMobileNotificationSettings()).toBe(false);
        expect(h.calls).toEqual([]);
    });

    it('POSITIVE CONTROL: with the methods present the calls go through', async () => {
        const m = await freshModule();
        expect(await m.mobileBatteryStatus()).toEqual({ ignoring: false });
        expect(await m.requestIgnoreBatteryOptimizations()).toBe(true);
        expect(await m.openMobileNotificationSettings()).toBe(true);
        expect(h.calls).toEqual([
            { batteryStatus: true },
            { requestIgnore: true },
            { openNotifSettings: true },
        ]);
    });

    it('a failed dialog launch does not blind the status path', async () => {
        // The health row is driven by mobileBatteryStatus; a ROM that lacks a
        // handler for the exemption dialog must not make the row vanish (the
        // row is where the manual-fix instructions live).
        const m = await freshModule();
        expect(await m.mobileBatteryStatus()).toEqual({ ignoring: false });
        h.rejectBattery = true;
        expect(await m.requestIgnoreBatteryOptimizations(), 'the ask fails').toBe(false);
        h.rejectBattery = false;
        expect(
            await m.mobileBatteryStatus(),
            'the status capability survives the failed ask',
        ).toEqual({ ignoring: false });
    });

    it('a transient status error after a success does not latch either', async () => {
        const m = await freshModule();
        expect(await m.mobileBatteryStatus()).toEqual({ ignoring: false });
        h.rejectBattery = true;
        expect(await m.mobileBatteryStatus()).toBeNull();
        h.rejectBattery = false;
        expect(await m.mobileBatteryStatus(), 'recovers after the hiccup').toEqual({ ignoring: false });
    });
});

describe('pending navigation', () => {
    it('holds the launch target until the consumer asks, exactly once', async () => {
        h.launchNav = 'tasks';
        const m = await freshModule();
        const announced = vi.fn();
        window.addEventListener('sovereign-navigate', announced);
        try {
            m.installMobileNav();
            await settle();
            expect(announced, 'a launch target is announced for a live consumer').toHaveBeenCalled();
            expect(m.consumePendingNav()).toBe('tasks');
            expect(m.consumePendingNav(), 'one-shot: a second read finds nothing').toBeNull();
        } finally {
            window.removeEventListener('sovereign-navigate', announced);
        }
    });

    it('announces warm targets (widget tap on a running app) the same way', async () => {
        const m = await freshModule();
        m.installMobileNav();
        await settle();
        const announced = vi.fn();
        window.addEventListener('sovereign-navigate', announced);
        try {
            expect(h.listeners.length, 'the native navigate listener is installed').toBeGreaterThan(0);
            h.listeners[0]({ target: 'friends' });
            expect(announced).toHaveBeenCalled();
            expect(m.consumePendingNav()).toBe('friends');
        } finally {
            window.removeEventListener('sovereign-navigate', announced);
        }
    });

    it('deferNav puts a not-yet-actionable target back for the next attempt', async () => {
        const m = await freshModule();
        m.installMobileNav();
        await settle();
        h.listeners[0]({ target: 'dm:abc' });
        const t = m.consumePendingNav();
        expect(t).toBe('dm:abc');
        m.deferNav(t!);
        expect(m.consumePendingNav(), 'the deferred target comes back').toBe('dm:abc');
    });
});

// showKeyboard (APKs from 0.8.104): the remote-control view raises the IME
// when a tap lands in a text box on the other machine, long after the tap's
// gesture — only the native showSoftInput can do that. Its own latch, like the
// battery and keyboard-inset pairs: an APK without the method must not blind
// the rest of the plugin, and a later success must not be latched out by one
// transient bridge error.
describe('showMobileKeyboard', () => {
    it('returns true and crosses the bridge when the method exists', async () => {
        const m = await freshModule();
        expect(await m.showMobileKeyboard()).toBe(true);
        expect(h.calls).toEqual([{ showKeyboard: true }]);
    });

    it('an APK without the method answers false, latches ITS capability, and is not asked again', async () => {
        const m = await freshModule();
        m.setNotifyKeepAlive(true);
        await settle();
        h.rejectShowKeyboard = true;
        h.calls.length = 0;
        expect(await m.showMobileKeyboard()).toBe(false);
        expect(h.calls).toEqual([{ showKeyboard: true, rejected: true }]);
        h.calls.length = 0;
        expect(await m.showMobileKeyboard(), 'latched: no second crossing').toBe(false);
        expect(h.calls).toEqual([]);
        expect(m.mobileAppAvailable(), 'the core plugin is unaffected').toBe(true);
    });

    it('a transient failure AFTER a success does not latch', async () => {
        const m = await freshModule();
        expect(await m.showMobileKeyboard()).toBe(true);
        h.rejectShowKeyboard = true;
        expect(await m.showMobileKeyboard()).toBe(false);
        h.rejectShowKeyboard = false;
        expect(await m.showMobileKeyboard(), 'the next call still goes through').toBe(true);
    });

    it('does nothing off Android', async () => {
        h.platform = 'web';
        const m = await freshModule();
        expect(await m.showMobileKeyboard()).toBe(false);
        expect(h.calls).toEqual([]);
    });
});
