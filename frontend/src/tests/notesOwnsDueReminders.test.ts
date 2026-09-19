/**
 * Owner decision: when Púca Notes is installed on a phone, Notes owns
 * due-item reminders (its own alarms, open or closed) and Púca stays quiet
 * for them — one due item, one notification. An older Púca APK cannot answer
 * the question and must keep today's behaviour (notify).
 *
 * Three states, each the control for the others: installed → silent; not
 * installed → posts; unknown (old APK) → posts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let installed: boolean | null = null;
const post = vi.fn(async () => undefined);
vi.mock('../api/mobileApp', () => ({
    mobileAppAvailable: () => true,
    notesAppInstalled: async () => installed,
    postMobileNotification: (...a: unknown[]) => post(...(a as [])),
    requestMobileNotificationPermission: vi.fn(),
}));
vi.mock('../api/platform', () => ({ isMobile: () => true, isTauri: () => false, appIsForeground: () => false }));
vi.mock('../components/settingsStore', () => ({
    loadSettings: () => ({ mobileNotifications: true, desktopNotifications: true }),
}));

const { notifyTasksDue } = await import('../api/desktopNotify');

const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
};

beforeEach(() => { post.mockClear(); });

describe('Púca\'s due-item notification with Púca Notes on the phone', () => {
    it('Notes installed: Púca stays quiet', async () => {
        installed = true;
        notifyTasksDue(2);
        await settle();
        expect(post).not.toHaveBeenCalled();
    });

    it('Notes not installed: Púca notifies (positive control)', async () => {
        installed = false;
        notifyTasksDue(2);
        await settle();
        expect(post).toHaveBeenCalledWith('tasks-due', 'Púca Tasks', '2 tasks are due', 'tasks');
    });

    it('an older Púca APK that cannot tell: Púca notifies as before', async () => {
        installed = null;
        notifyTasksDue(1);
        await settle();
        expect(post).toHaveBeenCalledWith('tasks-due', 'Púca Tasks', 'A task is due', 'tasks');
    });
});
