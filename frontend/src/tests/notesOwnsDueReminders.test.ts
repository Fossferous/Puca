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
const nativeOwns = vi.fn<(opts: { account: string; server: string; due: { id: number; mark: string }[] }) => Promise<{ owns: boolean }>>();

const SERVER = 'https://api.example.test';
const DUE = [{ id: 5, mark: '2026-09-19T10:00:00Z' }];
const q = (account: string | null, over: Partial<{ server: string; due: typeof DUE }> = {}) =>
    ({ account, server: SERVER, due: DUE, ...over });
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
        expect(await notesOwnsDueReminders(q('42'))).toBeNull();
        expect(await notesOwnsDueReminders(q('42'))).toBeNull();
        expect(nativeOwns).toHaveBeenCalledTimes(1);
    });

    it('Notes says no: false, and the next fire asks again (positive control for the latch)', async () => {
        const { notesOwnsDueReminders } = await import('../api/mobileApp');
        nativeOwns.mockResolvedValue({ owns: false });
        expect(await notesOwnsDueReminders(q('42'))).toBe(false);
        expect(await notesOwnsDueReminders(q('42'))).toBe(false);
        expect(nativeOwns).toHaveBeenCalledTimes(2);
        expect(nativeOwns).toHaveBeenLastCalledWith({ account: '42', server: SERVER, due: DUE });
    });

    it('Notes says yes: true — and a later "no" is believed, never cached', async () => {
        const { notesOwnsDueReminders } = await import('../api/mobileApp');
        nativeOwns.mockResolvedValueOnce({ owns: true }).mockResolvedValueOnce({ owns: false });
        expect(await notesOwnsDueReminders(q('42'))).toBe(true);
        expect(await notesOwnsDueReminders(q('42'))).toBe(false);
    });

    it('a bridge answer that is not a clear yes is not a yes', async () => {
        const { notesOwnsDueReminders } = await import('../api/mobileApp');
        nativeOwns.mockResolvedValue({ owns: 'true' as unknown as boolean });
        expect(await notesOwnsDueReminders(q('42'))).toBe(false);
    });

    it('no items or no server named: false without asking (Notes can only vouch for what it is told)', async () => {
        const { notesOwnsDueReminders } = await import('../api/mobileApp');
        nativeOwns.mockResolvedValue({ owns: true });
        expect(await notesOwnsDueReminders(q('42', { due: [] }))).toBe(false);
        expect(await notesOwnsDueReminders(q('42', { server: '' }))).toBe(false);
        expect(nativeOwns).not.toHaveBeenCalled();
    });

    it('no signed-in account: false without asking (Notes cannot own "nobody\'s" reminders)', async () => {
        const { notesOwnsDueReminders } = await import('../api/mobileApp');
        nativeOwns.mockResolvedValue({ owns: true });
        expect(await notesOwnsDueReminders(q(null))).toBe(false);
        expect(nativeOwns).not.toHaveBeenCalled();
    });
});

// ---- layer 1: the gate ------------------------------------------------------
describe('Púca\'s due-item notification with Púca Notes on the phone', () => {
    let owns: boolean | null = null;
    const probe = vi.fn(async (_q: { account: string | null; server: string; due: unknown[] }) => owns);
    const post = vi.fn(async (..._a: unknown[]) => undefined);

    const load = async () => {
        vi.resetModules();
        vi.doMock('../api/mobileApp', () => ({
            mobileAppAvailable: () => true,
            notesOwnsDueReminders: probe,
            postMobileNotification: post,
            requestMobileNotificationPermission: vi.fn(),
        }));
        vi.doMock('../api/platform', () => ({
            isMobile: () => true, isTauri: () => false, appIsForeground: () => false,
            getApiBaseUrl: () => SERVER, getWebSocketUrl: () => 'wss://api.example.test',
        }));
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
        m.notifyTasksDue(2, [{ id: 5, mark: 'a' }, { id: 6, mark: 'b' }]);
        await settle();
        expect(post).not.toHaveBeenCalled();
        // this account, on THIS server, about exactly the items being announced
        expect(probe).toHaveBeenCalledWith({ account: '42', server: SERVER, due: [{ id: 5, mark: 'a' }, { id: 6, mark: 'b' }] });
        expect(taskOutcomes(m)).toEqual(['notes-app-owns']);
    });

    it('Notes says no (signed out, stale, another account…): Púca notifies and logs one "fired"', async () => {
        const m = await load();
        owns = false;
        m.notifyTasksDue(2, DUE);
        await settle();
        // 'reminders' = the Tasks view's Reminders tab (the grouped list of
        // what is due), and the body stays content-free.
        expect(post).toHaveBeenCalledWith('tasks-due', 'Púca Tasks', '2 tasks are due', 'reminders');
        expect(taskOutcomes(m)).toEqual(['fired']);
    });

    it('an older Púca APK that cannot ask: Púca notifies as before', async () => {
        const m = await load();
        owns = null;
        m.notifyTasksDue(1, DUE);
        await settle();
        expect(post).toHaveBeenCalledWith('tasks-due', 'Púca Tasks', 'A task is due', 'reminders');
        expect(taskOutcomes(m)).toEqual(['fired']);
    });
});
