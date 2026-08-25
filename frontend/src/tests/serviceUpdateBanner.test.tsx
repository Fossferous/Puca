/**
 * The sign-in-screen service does not auto-update, and the one place that
 * said so was a card five screens down a tab on the desktop, while the person
 * who would notice the breakage was on their phone. 2026-08-17: the installed
 * service was one build behind the app (by hash) and the unlock handover
 * silently did not exist. This banner is the fix: app-root, on launch, one
 * click, until it is no longer true.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const lockScreenSupported = vi.fn(() => true);
const lockScreenState = vi.fn();
const unattendedAccessState = vi.fn();
const bundledServiceFingerprint = vi.fn();
const updateLockScreenService = vi.fn();
vi.mock('../api/devices/lockScreen', async () => {
    const real = await vi.importActual<typeof import('../api/devices/lockScreen')>('../api/devices/lockScreen');
    return {
        // The pure decisions are the real ones, so this test exercises them too.
        serviceNeedsUpdate: real.serviceNeedsUpdate,
        serviceUpdateBannerDue: real.serviceUpdateBannerDue,
        lockScreenSupported: () => lockScreenSupported(),
        lockScreenState: () => lockScreenState(),
        unattendedAccessState: () => unattendedAccessState(),
        bundledServiceFingerprint: () => bundledServiceFingerprint(),
        updateLockScreenService: () => updateLockScreenService(),
    };
});

const { ServiceUpdateBanner } = await import('../components/ServiceUpdateBanner');
const { serviceUpdateBannerDue } = await vi.importActual<typeof import('../api/devices/lockScreen')>('../api/devices/lockScreen');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<ServiceUpdateBanner />); });
    // It waits for startup to settle before its first check.
    await act(async () => { await vi.advanceTimersByTimeAsync(13_000); });
}
const text = () => host?.textContent ?? '';
const buttonNamed = (label: string) =>
    Array.from(host?.querySelectorAll('button') ?? []).find(b => b.textContent?.trim() === label);

function machine(opts: { installed: boolean; reported: string | null; bundled: string | null }) {
    lockScreenState.mockResolvedValue({ installed: opts.installed, running: opts.installed, available: true });
    unattendedAccessState.mockResolvedValue({
        serviceInstalled: opts.installed, enrolled: true, armed: true, deviceId: 'svc', binsHash: opts.reported, error: null,
    });
    bundledServiceFingerprint.mockResolvedValue({ hash: opts.bundled, error: null });
}

beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    lockScreenSupported.mockReturnValue(true);
    lockScreenState.mockReset();
    unattendedAccessState.mockReset();
    bundledServiceFingerprint.mockReset();
    updateLockScreenService.mockReset();
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.useRealTimers();
});

describe('serviceUpdateBannerDue', () => {
    it('is due only for an installed service whose reported pair differs from the bundled one', () => {
        expect(serviceUpdateBannerDue(true, 'old', 'new')).toBe(true);
        expect(serviceUpdateBannerDue(true, null, 'new')).toBe(true); // too old to say
        expect(serviceUpdateBannerDue(true, 'same', 'same')).toBe(false);
        expect(serviceUpdateBannerDue(false, 'old', 'new')).toBe(false); // nothing to update
        expect(serviceUpdateBannerDue(true, 'old', null)).toBe(false); // dev build, no sidecars
    });
});

describe('the banner', () => {
    it('appears on the desktop when the installed service is behind the app, and updates on click', async () => {
        machine({ installed: true, reported: 'pair-0.8.84', bundled: 'pair-0.8.85' });
        updateLockScreenService.mockImplementation(async () => {
            // The update took: the restarted service now reports the new pair.
            machine({ installed: true, reported: 'pair-0.8.85', bundled: 'pair-0.8.85' });
            return null;
        });
        await mount();
        expect(text()).toContain('Sign-in-screen service is out of date');
        expect(text()).toContain('hand off to the desktop');

        await act(async () => {
            buttonNamed('Update the service')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await act(async () => { await Promise.resolve(); });
        expect(updateLockScreenService).toHaveBeenCalledTimes(1);
        // Cleared by the RE-READ, not by the click.
        expect(text()).not.toContain('out of date');
    });

    it('stays up and says why when the update fails', async () => {
        machine({ installed: true, reported: 'old', bundled: 'new' });
        updateLockScreenService.mockResolvedValue('The elevation prompt was declined.');
        await mount();
        await act(async () => {
            buttonNamed('Update the service')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await act(async () => { await Promise.resolve(); });
        expect(text()).toContain('elevation prompt was declined');
        expect(buttonNamed('Try again')).toBeTruthy();
    });

    it('does not appear when the pair already matches', async () => {
        machine({ installed: true, reported: 'same', bundled: 'same' });
        await mount();
        expect(text()).toBe('');
    });

    it('does not appear when the service is not installed at all', async () => {
        machine({ installed: false, reported: null, bundled: 'new' });
        await mount();
        expect(text()).toBe('');
        // And it did not even go asking the pipe for a service that is not there.
        expect(unattendedAccessState).not.toHaveBeenCalled();
    });

    it('does not appear off the desktop', async () => {
        lockScreenSupported.mockReturnValue(false);
        machine({ installed: true, reported: 'old', bundled: 'new' });
        await mount();
        expect(text()).toBe('');
        expect(lockScreenState).not.toHaveBeenCalled();
    });

    it('"Later" hides it for this session only, per bundled build', async () => {
        machine({ installed: true, reported: 'old', bundled: 'new' });
        await mount();
        await act(async () => {
            buttonNamed('Later')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(text()).toBe('');
        expect(sessionStorage.getItem('sovereign_service_update_dismissed')).toBe('new');

        // A NEWER app build's pair is a new mismatch: dismissed for 'new'
        // must not silence 'newer'.
        act(() => root?.unmount());
        host?.remove();
        machine({ installed: true, reported: 'old', bundled: 'newer' });
        await mount();
        expect(text()).toContain('out of date');
    });
});
