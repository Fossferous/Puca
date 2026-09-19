/**
 * The "sign in again" notice (posted when Púca Notes' background job gets a
 * 401) opens the app with the target 'signin'. The page checks its OWN
 * session before acting: dead, and the ordinary expiry signal takes it to
 * sign-in; still good (it holds a newer token than the job saw), and it
 * re-arms the job with that token and shows Reminders instead.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 7, getToken: () => 'tok' }));
vi.mock('../notes/native/notesNative', () => ({
    consumeNativeLaunchNav: vi.fn(), notesNativeAvailable: () => true, onNativeNavigate: vi.fn(),
    setNativeBackgroundRefresh: vi.fn(), syncNativeReminders: vi.fn(),
}));

const { routeNativeTarget } = await import('../notes/native/useNativeReminders');

describe('the "sign in again" notice tap', () => {
    it('a dead page session goes to sign-in through the ordinary expiry signal', async () => {
        const navigate = vi.fn();
        const expired = vi.fn();
        const repush = vi.fn();
        await routeNativeTarget('signin', navigate, { probe: async () => 'rejected', expired, repush });
        expect(expired).toHaveBeenCalledTimes(1);
        expect(navigate).not.toHaveBeenCalled();
    });

    it('a page whose own session is still good re-arms the job and shows Reminders (control)', async () => {
        const navigate = vi.fn();
        const expired = vi.fn();
        const repush = vi.fn();
        await routeNativeTarget('signin', navigate, { probe: async () => 'ok', expired, repush });
        expect(expired).not.toHaveBeenCalled();
        expect(repush).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledWith('/reminders');
    });

    it('a reminder tap still opens Reminders, and an unknown target does nothing', async () => {
        const navigate = vi.fn();
        const probe = vi.fn(async () => 'ok' as const);
        await routeNativeTarget('reminders', navigate, { probe, expired: vi.fn(), repush: vi.fn() });
        await routeNativeTarget('elsewhere', navigate, { probe, expired: vi.fn(), repush: vi.fn() });
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledWith('/reminders');
        expect(probe).not.toHaveBeenCalled();
    });
});
