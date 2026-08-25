import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => false,
}));

import {
    lockScreenSupported,
    lockScreenState,
    enableLockScreenAccess,
    disableLockScreenAccess,
} from '../api/devices/lockScreen';

describe('lock-screen access is opt-in', () => {
    beforeEach(() => vi.clearAllMocks());

    it('is not offered outside the desktop app', () => {
        // A web tab or phone cannot install a Windows service, and offering a
        // switch that cannot work is worse than not offering one.
        expect(lockScreenSupported()).toBe(false);
    });

    it('reports OFF rather than unknown when it cannot ask', async () => {
        // THE DEFAULT THAT MATTERS. Anything other than "off" here would draw a
        // switch as already enabled on a machine where nothing is installed —
        // and the whole promise of this feature is that it is absent until
        // somebody deliberately turns it on.
        const s = await lockScreenState();
        expect(s.installed).toBe(false);
        expect(s.running).toBe(false);
        expect(s.available).toBe(false);
    });

    it('refuses to enable from a non-desktop context, with a reason', async () => {
        // Returning a message rather than throwing: every failure on this path
        // is something the user should read, and a switch that snaps back for
        // no stated reason is the worst version of this.
        const err = await enableLockScreenAccess();
        expect(err).toBeTruthy();
        expect(err).toMatch(/desktop app/i);
    });

    it('refuses to disable from a non-desktop context too', async () => {
        // The positive control for the pair: if `enable` were refusing because
        // of some unrelated guard, `disable` would tell us by behaving
        // differently.
        const err = await disableLockScreenAccess();
        expect(err).toBeTruthy();
        expect(err).toMatch(/desktop app/i);
    });
});
