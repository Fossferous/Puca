/**
 * UpdateGate — the DESKTOP branch: opt-in auto-install BEFORE the app loads.
 *
 * The bug this replaces: UpdateBanner auto-installed 8 s after it mounted, and
 * it mounts inside /chat after the socket is up — i.e. after the user was
 * already in a channel or a call, who then got relaunched out of it. Now:
 *  - opted OUT (the default): the gate does nothing at all — no check, no
 *    screen — and the banner prompts later;
 *  - opted IN: the gate checks and installs here, pre-login, on the same
 *    screens and under the same "may delay, never hold" bounds as mobile OTA.
 *
 * Mounted like the sibling updateGateHang.test.tsx (raw react-dom/client +
 * act, fake timers). localStorage MUST be a real backing object here:
 * tests/setup.ts replaces it with no-op stubs, under which loadSettings()
 * can never see the opt-in and every case would silently exercise the
 * opted-out path and look green for the wrong reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type InstallOpts = { proceedToInstall?: () => boolean };
const h = vi.hoisted(() => {
    class FakeAbandoned extends Error { constructor() { super('abandoned'); this.name = 'UpdateAbandonedError'; } }
    return {
        checkForNewVersion: vi.fn<() => Promise<{ version: string; download_url: string } | null>>(),
        currentAppVersion: vi.fn<() => Promise<string>>(),
        installUpdateInPlace: vi.fn<(cb: (p: unknown) => void, opts?: { proceedToInstall?: () => boolean }) => Promise<void>>(),
        FakeAbandoned,
    };
});
const FakeAbandoned = h.FakeAbandoned;

vi.mock('../api/platform', () => ({ isTauri: () => true, isMobile: () => false }));
vi.mock('../api/appVersion', () => ({
    checkForNewVersion: () => h.checkForNewVersion(),
    currentAppVersion: () => h.currentAppVersion(),
    installUpdateInPlace: (cb: (p: unknown) => void, opts?: { proceedToInstall?: () => boolean }) => h.installUpdateInPlace(cb, opts),
    UpdateAbandonedError: h.FakeAbandoned,
}));

import { UpdateGate } from '../components/UpdateGate';
import { AUTO_ATTEMPT_KEY } from '../components/updateGate.utils';

let store: Record<string, string> = {};
let container: HTMLDivElement;
let root: Root;

function optIn() {
    store['sovereign_settings'] = JSON.stringify({ autoInstallUpdates: true });
}

async function mountGate(): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
        root = createRoot(container);
        root.render(<UpdateGate><div data-testid="app">APP</div></UpdateGate>);
    });
}

async function advance(ms: number): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const appRendered = () => !!container.querySelector('[data-testid="app"]');

beforeEach(() => {
    vi.useFakeTimers();
    store = {};
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { store = {}; },
    });
    h.checkForNewVersion.mockReset();
    h.currentAppVersion.mockReset();
    h.installUpdateInPlace.mockReset();
    h.checkForNewVersion.mockResolvedValue({ version: '99.0.0', download_url: 'https://download.example.com/' });
    h.currentAppVersion.mockResolvedValue('0.8.0');
    h.installUpdateInPlace.mockResolvedValue();
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    container?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('desktop auto-install is opt-in and pre-load', () => {
    it('opted OUT (the default): no check, no screen, the app renders at once', async () => {
        await mountGate();
        await advance(100);
        expect(h.checkForNewVersion, 'no network on an opted-out launch').not.toHaveBeenCalled();
        expect(h.installUpdateInPlace).not.toHaveBeenCalled();
        expect(appRendered()).toBe(true);
    });

    it('opted IN + newer release: installs BEFORE the app renders, showing progress', async () => {
        optIn();
        let progress: ((p: unknown) => void) | null = null;
        h.installUpdateInPlace.mockImplementation(async (cb) => {
            progress = cb;
            // Never resolves on its own — the installer takes over the process.
            await new Promise<void>(() => {});
        });

        await mountGate();
        await advance(50);

        expect(h.installUpdateInPlace).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('Updating to v99.0.0');
        expect(appRendered(), 'the app must NOT be up while an install is running').toBe(false);

        await act(async () => { progress!({ phase: 'downloading', percent: 42 }); });
        expect(container.textContent).toContain('42%');

        await act(async () => { progress!({ phase: 'installing' }); });
        expect(container.textContent).toContain('Restarting with v99.0.0');
        expect(appRendered()).toBe(false);

        // The loop guard is recorded before the attempt, so a relaunch that
        // comes back on the old build will not try this version again.
        expect(store[AUTO_ATTEMPT_KEY]).toBe('99.0.0');
    });

    it('opted IN but this version was already attempted: no install, the app renders', async () => {
        optIn();
        store[AUTO_ATTEMPT_KEY] = '99.0.0';

        await mountGate();
        await advance(100);

        expect(h.checkForNewVersion).toHaveBeenCalled(); // it does look
        expect(h.installUpdateInPlace, 'once per version, then wait for a human').not.toHaveBeenCalled();
        expect(appRendered()).toBe(true);
    });

    it('opted IN, candidate not newer than what is running: no install', async () => {
        optIn();
        h.currentAppVersion.mockResolvedValue('99.0.0'); // already on it

        await mountGate();
        await advance(100);

        expect(h.installUpdateInPlace).not.toHaveBeenCalled();
        expect(appRendered()).toBe(true);
    });

    it('a HUNG check waves the app through at the deadline, and a late answer never installs', async () => {
        optIn();
        let resolveCheck: ((v: { version: string; download_url: string }) => void) | null = null;
        h.checkForNewVersion.mockImplementation(() => new Promise(resolve => { resolveCheck = resolve; }));

        await mountGate();
        expect(container.textContent).toContain('Checking for updates');
        expect(appRendered()).toBe(false);

        await advance(16_000);
        expect(appRendered(), 'the invariant: past the deadline the app RUNS').toBe(true);

        // The check finally answers — installing UNDER the running app is the
        // exact mid-session relaunch this branch exists to remove.
        await act(async () => { resolveCheck!({ version: '99.0.0', download_url: 'https://download.example.com/' }); });
        await advance(100);
        expect(h.installUpdateInPlace).not.toHaveBeenCalled();
        expect(appRendered()).toBe(true);
    });

    it('a FAILED install surfaces Retry / Continue Anyway, and Continue renders the app', async () => {
        optIn();
        h.installUpdateInPlace.mockRejectedValue(new Error('installer exited with code 1'));

        await mountGate();
        await advance(100);

        expect(container.textContent).toContain('could not be installed');
        // The remedy must be the real one: the per-user installer needs the
        // running process (tray included) gone, never administrator rights.
        expect(container.textContent).toMatch(/tray/i);
        expect(container.textContent).not.toMatch(/as administrator/i);
        const labels = [...container.querySelectorAll('button')].map(b => b.textContent);
        expect(labels).toEqual(expect.arrayContaining(['Retry', 'Continue Anyway']));
        expect(appRendered()).toBe(false);

        const cont = [...container.querySelectorAll('button')].find(b => b.textContent === 'Continue Anyway')!;
        await act(async () => { cont.click(); });
        expect(appRendered()).toBe(true);
    });

    it('Retry after a failure bypasses the once-per-version guard (a click is a human decision)', async () => {
        optIn();
        h.installUpdateInPlace.mockRejectedValueOnce(new Error('first attempt failed'));

        await mountGate();
        await advance(100);
        expect(h.installUpdateInPlace).toHaveBeenCalledTimes(1);
        expect(store[AUTO_ATTEMPT_KEY]).toBe('99.0.0');

        h.installUpdateInPlace.mockImplementation(async () => { await new Promise<void>(() => {}); });
        const retry = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry')!;
        await act(async () => { retry.click(); });
        await advance(100);
        expect(h.installUpdateInPlace, 'the same version is tried again on an explicit click').toHaveBeenCalledTimes(2);
    });

    it('a download that goes SILENT surfaces the stall screen instead of holding the gate', async () => {
        optIn();
        let progress: ((p: unknown) => void) | null = null;
        h.installUpdateInPlace.mockImplementation(async (cb) => {
            progress = cb;
            await new Promise<void>(() => {});
        });

        await mountGate();
        await advance(100);
        await act(async () => { progress!({ phase: 'downloading', percent: 10 }); });
        expect(container.textContent).toContain('10%');

        await advance(50_000);
        expect(container.textContent).toContain('gone quiet');
        expect([...container.querySelectorAll('button')].map(b => b.textContent))
            .toEqual(expect.arrayContaining(['Retry', 'Continue Anyway']));

        // Late progress after the verdict must not yank the user back into a
        // progress screen they were told had stalled.
        await act(async () => { progress!({ phase: 'downloading', percent: 90 }); });
        expect(container.textContent).toContain('gone quiet');
    });

    it('Retry after a STALL resumes the in-flight download instead of starting a second one', async () => {
        optIn();
        let progress: ((p: unknown) => void) | null = null;
        h.installUpdateInPlace.mockImplementation(async (cb) => {
            progress = cb;
            await new Promise<void>(() => {});
        });

        await mountGate();
        await advance(100);
        await act(async () => { progress!({ phase: 'downloading', percent: 30 }); });
        await advance(50_000);
        expect(container.textContent).toContain('gone quiet');
        expect(h.installUpdateInPlace).toHaveBeenCalledTimes(1);

        const retry = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry')!;
        await act(async () => { retry.click(); });
        // Cross several watchdog ticks: Retry must grant a FRESH silence
        // window, not bounce back to the stall screen 5 s later.
        await advance(20_000);
        // The same download continues; no second check/download is started,
        // and the screen goes back to the progress it had.
        expect(h.installUpdateInPlace, 'the Tauri download cannot be cancelled — never stack a second one').toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('Updating to v99.0.0');
        expect(container.textContent).toContain('30%');
        expect(container.textContent).not.toContain('gone quiet');
        await act(async () => { progress!({ phase: 'downloading', percent: 60 }); });
        expect(container.textContent).toContain('60%');
        // ...and a full silence window after Retry stalls again, honestly.
        await advance(50_000);
        expect(container.textContent).toContain('gone quiet');
    });

    it('Continue Anyway that lands after the installer has started keeps the Restarting screen (never the app under a running install)', async () => {
        optIn();
        let progress: ((p: unknown) => void) | null = null;
        h.installUpdateInPlace.mockImplementation(async (cb) => {
            progress = cb;
            await new Promise<void>(() => {});
        });
        await mountGate();
        await advance(100);
        await act(async () => { progress!({ phase: 'downloading', percent: 10 }); });
        await advance(50_000);
        const cont = [...container.querySelectorAll('button')].find(b => b.textContent === 'Continue Anyway')!;
        // The download completes and the installer starts in the same turn as the click.
        await act(async () => { progress!({ phase: 'installing' }); cont.click(); });
        expect(appRendered()).toBe(false);
        expect(container.textContent).toContain('Restarting with v99.0.0');
    });

    it('Continue Anyway after a stall ABANDONS the download: when it limps home it must not install under the running app', async () => {
        optIn();
        let progress: ((p: unknown) => void) | null = null;
        let opts: InstallOpts | undefined;
        let finishDownload: (() => void) | null = null;
        h.installUpdateInPlace.mockImplementation(async (cb, o) => {
            progress = cb; opts = o;
            await new Promise<void>(resolve => { finishDownload = resolve; });
            // Model the real helper: consult the gate between download and install.
            if (o?.proceedToInstall && !o.proceedToInstall()) throw new FakeAbandoned();
            cb({ phase: 'installing' });
        });

        await mountGate();
        await advance(100);
        await act(async () => { progress!({ phase: 'downloading', percent: 10 }); });
        await advance(50_000);
        expect(container.textContent).toContain('gone quiet');
        const cont = [...container.querySelectorAll('button')].find(b => b.textContent === 'Continue Anyway')!;
        await act(async () => { cont.click(); });
        expect(appRendered()).toBe(true);
        expect(opts?.proceedToInstall?.(), 'the gate must now refuse').toBe(false);

        // The network comes back and the download completes under the live app.
        await act(async () => { finishDownload!(); });
        await advance(50);
        expect(appRendered(), 'still on the app — no install, no restart screen').toBe(true);
        expect(container.textContent).not.toContain('Restarting');
    });

    it('positive control: a stall verdict the user does NOT act on still lets the download install (the gate still holds the app)', async () => {
        optIn();
        let opts: InstallOpts | undefined;
        let progress: ((p: unknown) => void) | null = null;
        let finishDownload: (() => void) | null = null;
        h.installUpdateInPlace.mockImplementation(async (cb, o) => {
            progress = cb; opts = o;
            await new Promise<void>(resolve => { finishDownload = resolve; });
            if (o?.proceedToInstall && !o.proceedToInstall()) throw new FakeAbandoned();
            cb({ phase: 'installing' });
        });

        await mountGate();
        await advance(100);
        await act(async () => { progress!({ phase: 'downloading', percent: 10 }); });
        await advance(50_000);
        expect(container.textContent).toContain('gone quiet');
        expect(opts?.proceedToInstall?.()).toBe(true);
        await act(async () => { finishDownload!(); });
        await advance(50);
        expect(container.textContent).toContain('Restarting with v99.0.0');
        expect(appRendered()).toBe(false);
    });

    it('a check that throws is non-fatal: the app renders on the installed build', async () => {
        optIn();
        h.checkForNewVersion.mockRejectedValue(new Error('offline'));

        await mountGate();
        await advance(100);

        expect(h.installUpdateInPlace).not.toHaveBeenCalled();
        expect(appRendered()).toBe(true);
    });
});
