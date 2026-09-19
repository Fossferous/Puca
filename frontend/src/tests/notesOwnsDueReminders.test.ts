/**
 * Owner decision: when Púca Notes is installed AND able to deliver reminders,
 * Notes owns due-item reminders and Púca stays quiet — one alert per item,
 * never zero. So Púca is quiet ONLY on Notes' own "yes" (its
 * ReminderOwnerProvider, asked through SovereignApp.notesOwnsDueReminders):
 * Notes absent, older, signed out, another account, stale or muted all answer
 * no (or cannot answer), and Púca notifies.
 *
 * Two layers, both run for real here:
 *  1. the gate in desktopNotify.notifyTasksDue (with the probe mocked), which
 *     must pass THIS account and record ONE diagnostics outcome;
 *  2. mobileApp.notesOwnsDueReminders itself (with only the Capacitor bridge
 *     mocked), whose reject-and-latch branch is what keeps an older Púca APK
 *     notifying — the version-skew guarantee.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- layer 2's bridge: a fake SovereignApp plugin ---------------------------
const nativeOwns = vi.fn<(opts: { account: string }) => Promise<{ owns: boolean }>>();
vi.mock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true, isPluginAvailable: () => true },
    registerPlugin: () => new Proxy({}, {
        get: (_t, prop) => (prop === 'notesOwnsDueReminders' ? nativeOwns : vi.fn(async () => ({}))),
    }),
}));

describe('mobileApp.notesOwnsDueReminders (the real function, bridge mocked)', () => {
    beforeEach(() => { vi.resetModules(); nativeOwns.mockReset(); });

    it('an older Púca APK without the method: null, and it is not asked again', async () => {
        const { notesOwnsDueReminders } = await import('../api/mobileApp');
        nativeOwns.mockRejectedValue(new Error('"SovereignApp.notesOwnsDueReminders()" is not implemented on android'));
        expect(await notesOwnsDueReminders('42')).toBeNull();
        expect(await notesOwnsDueReminders('42')).toBeNull();
        expect(nativeOwns).toHaveBeenCalledTimes(1);
    });

    it('Notes says no: false, and the next fire asks again (positive control for the latch)', async () => {
        const { notesOwnsDueReminders } = await import('../api/mobileApp');
        nativeOwns.mockResolvedValue({ owns: false });
        expect(await notesOwnsDueReminders('42')).toBe(false);
        expect(await notesOwnsDueReminders('42')).toBe(false);
        expect(nativeOwns).toHaveBeenCalledTimes(2);
        expect(nativeOwns).toHaveBeenLastCalledWith({ account: '42' });
    });

    it('Notes says yes: true — and a later "no" is believed, never cached', async () => {
        const { notesOwnsDueReminders } = await import('../api/mobileApp');
        nativeOwns.mockResolvedValueOnce({ owns: true }).mockResolvedValueOnce({ owns: false });
        expect(await notesOwnsDueReminders('42')).toBe(true);
        expect(await notesOwnsDueReminders('42')).toBe(false);
    });

    it('a bridge answer that is not a clear yes is not a yes', async () => {
        const { notesOwnsDueReminders } = await import('../api/mobileApp');
        nativeOwns.mockResolvedValue({ owns: 'true' as unknown as boolean });
        expect(await notesOwnsDueReminders('42')).toBe(false);
    });

    it('no signed-in account: false without asking (Notes cannot own "nobody\'s" reminders)', async () => {
        const { notesOwnsDueReminders } = await import('../api/mobileApp');
        nativeOwns.mockResolvedValue({ owns: true });
        expect(await notesOwnsDueReminders(null)).toBe(false);
        expect(nativeOwns).not.toHaveBeenCalled();
    });
});

// ---- layer 1: the gate ------------------------------------------------------
describe('Púca\'s due-item notification with Púca Notes on the phone', () => {
    let owns: boolean | null = null;
    const probe = vi.fn(async (_account: string | null) => owns);
    const post = vi.fn(async (..._a: unknown[]) => undefined);

    const load = async () => {
        vi.resetModules();
        vi.doMock('../api/mobileApp', () => ({
            mobileAppAvailable: () => true,
            notesOwnsDueReminders: probe,
            postMobileNotification: post,
            requestMobileNotificationPermission: vi.fn(),
        }));
        vi.doMock('../api/platform', () => ({ isMobile: () => true, isTauri: () => false, appIsForeground: () => false }));
        vi.doMock('../components/settingsStore', () => ({
            loadSettings: () => ({ mobileNotifications: true, desktopNotifications: true }),
        }));
        vi.doMock('../api/auth', () => ({ currentUserIdFromToken: () => 42 }));
        return import('../api/desktopNotify');
    };
    const settle = async () => {
        for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    };
    const taskOutcomes = (m: Awaited<ReturnType<typeof load>>) =>
        m.notifyDiag().recent.filter(e => e.kind === 'task').map(e => e.outcome);

    beforeEach(() => { post.mockClear(); probe.mockClear(); });

    it('Notes owns them: Púca stays quiet, asks for THIS account, and logs one "notes-app-owns"', async () => {
        const m = await load();
        owns = true;
        m.notifyTasksDue(2);
        await settle();
        expect(post).not.toHaveBeenCalled();
        expect(probe).toHaveBeenCalledWith('42');
        expect(taskOutcomes(m)).toEqual(['notes-app-owns']);
    });

    it('Notes says no (signed out, stale, another account…): Púca notifies and logs one "fired"', async () => {
        const m = await load();
        owns = false;
        m.notifyTasksDue(2);
        await settle();
        expect(post).toHaveBeenCalledWith('tasks-due', 'Púca Tasks', '2 tasks are due', 'tasks');
        expect(taskOutcomes(m)).toEqual(['fired']);
    });

    it('an older Púca APK that cannot ask: Púca notifies as before', async () => {
        const m = await load();
        owns = null;
        m.notifyTasksDue(1);
        await settle();
        expect(post).toHaveBeenCalledWith('tasks-due', 'Púca Tasks', 'A task is due', 'tasks');
        expect(taskOutcomes(m)).toEqual(['fired']);
    });
});
