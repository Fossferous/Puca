import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A user reported being stuck on 0.7.8: clicking Update made the banner come
 * back, over and over, with no error and no browser.
 *
 * The cause was in the catch: a failure during CHECKING or DOWNLOADING opened
 * the download page, but a failure while INSTALLING fell past that branch, set
 * progress to null, and rendered nothing. Silence was indistinguishable from an
 * install still in progress — so neither the user nor we could tell what had
 * happened.
 */
const installUpdateInPlace = vi.fn();
const openDownloadPage = vi.fn(async () => {});
vi.mock('../api/appVersion', () => ({
    checkForNewVersion: async () => ({
        version: '0.8.3', download_url: 'https://example.test', notes: 'notes',
    }),
    installUpdateInPlace: (...a: unknown[]) => installUpdateInPlace(...a),
    openDownloadPage: (...a: unknown[]) => openDownloadPage(...a),
    isNewerVersion: () => true,
}));
vi.mock('../api/platform', () => ({ isTauri: () => true, isMobile: () => false }));

// Controllable stand-in for the self-in-voice signal. `notify` is separate
// from the value on purpose: setting the value WITHOUT notifying reproduces
// the real race where a call starts after the last render but before the
// click lands.
let mockInVoice = false;
const voiceSubs = new Set<(v: boolean) => void>();
vi.mock('../components/voiceState', () => ({
    isSelfInVoice: () => mockInVoice,
    subscribeSelfInVoice: (cb: (v: boolean) => void) => {
        voiceSubs.add(cb);
        return () => voiceSubs.delete(cb);
    },
}));
function setMockInVoice(v: boolean, notify: boolean) {
    mockInVoice = v;
    if (notify) voiceSubs.forEach(cb => cb(v));
}

const { UpdateBanner } = await import('../components/UpdateBanner');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<UpdateBanner />); });
    // The banner deliberately waits 8s after mount before its first check —
    // which only PROMPTS (see the test below).
    await act(async () => { vi.advanceTimersByTime(9000); });
    await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
    vi.useFakeTimers();
    installUpdateInPlace.mockReset();
    openDownloadPage.mockReset();
    mockInVoice = false;
    voiceSubs.clear();
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.useRealTimers();
});

describe('the banner only prompts', () => {
    /**
     * The 8 s launch check used to auto-install: this component mounts inside
     * /chat after the socket is up, so "8 s after launch" was 8 s after the
     * user was already in a channel or a call — and then relaunched out of it.
     * Automatic installation now lives in UpdateGate (opt-in, pre-load). The
     * banner shows the update and waits for a click, and nothing else.
     */
    it('never installs on its own — the launch check only shows the banner', async () => {
        installUpdateInPlace.mockImplementation(async () => {});

        await mount();
        // Give any (wrong) auto-install path every chance to fire.
        await act(async () => { vi.advanceTimersByTime(60_000); });
        await act(async () => { await Promise.resolve(); });

        expect(host!.textContent, 'the banner must have rendered').toContain('Update available');
        expect(installUpdateInPlace).not.toHaveBeenCalled();
    });
});

describe('the banner stays out of a live call', () => {
    it('hides while in voice, and returns when the call ends', async () => {
        setMockInVoice(true, false);
        await mount();
        expect(host!.textContent, 'no update prompt may pop up mid-call').not.toContain('Update available');

        // Positive control: same update payload, call over → banner appears.
        await act(async () => { setMockInVoice(false, true); });
        expect(host!.textContent).toContain('Update available');
    });

    it('a FAILED install stays visible even while in voice — its explanation must never hide', async () => {
        installUpdateInPlace.mockImplementation(async (onProgress: (p: unknown) => void) => {
            onProgress({ phase: 'installing' });
            throw new Error('installer exited with code 1');
        });
        await mount();
        const btn = host!.querySelector<HTMLButtonElement>('.update-now-btn');
        await act(async () => { btn!.click(); });
        await act(async () => { await Promise.resolve(); });
        expect(host!.textContent).toContain('installer exited with code 1');

        // A call starts after the failure: the failure message must survive
        // the in-voice hide (busy is false by now — progress was cleared).
        await act(async () => { setMockInVoice(true, true); });
        expect(host!.textContent, 'hiding the failure recreates the silent-failed-install bug')
            .toContain('installer exited with code 1');
    });

    it('a call starting between render and click gets a confirm, and No means no', async () => {
        installUpdateInPlace.mockImplementation(async () => {});
        await mount();
        const btn = host!.querySelector<HTMLButtonElement>('.update-now-btn');
        expect(btn, 'the Update button must be present').toBeTruthy();

        // The race: in-voice flips true but no re-render has happened yet.
        setMockInVoice(true, false);
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        await act(async () => { btn!.click(); });
        expect(confirmSpy).toHaveBeenCalledOnce();
        expect(installUpdateInPlace).not.toHaveBeenCalled();

        // Positive control: Yes proceeds.
        confirmSpy.mockReturnValue(true);
        await act(async () => { btn!.click(); });
        expect(installUpdateInPlace).toHaveBeenCalledOnce();
        confirmSpy.mockRestore();
    });
});

describe('a failed update says so', () => {
    it('shows the reason when the INSTALL step fails', async () => {
        // Reach 'installing', then fail — the case that used to be silent.
        installUpdateInPlace.mockImplementation(async (onProgress: (p: unknown) => void) => {
            onProgress({ phase: 'downloading', percent: 100 });
            onProgress({ phase: 'installing' });
            throw new Error('installer exited with code 1');
        });

        await mount();
        expect(host!.textContent, 'the banner must have rendered').toContain('Update available');
        const btn = host!.querySelector<HTMLButtonElement>('.update-now-btn');
        expect(btn, 'the Update button must be present').toBeTruthy();

        await act(async () => { btn!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(host!.textContent, 'the failure must be visible to the user')
            .toContain('installer exited with code 1');
        // And it must NOT silently dump them on the download site.
        expect(openDownloadPage).not.toHaveBeenCalled();
    });

    /**
     * The advice must name what actually helps. The installer is per-user
     * (NSIS currentUser: %LOCALAPPDATA% + HKCU), so "as administrator" was
     * wrong twice over — elevation is not needed, and elevating into a
     * different admin account installs a second copy under that profile.
     * What blocks the swap is the running process, which the tray keeps
     * alive after the window closes.
     */
    it('the failure advice says to close the app INCLUDING the tray, and never mentions administrator', async () => {
        installUpdateInPlace.mockImplementation(async (onProgress: (p: unknown) => void) => {
            onProgress({ phase: 'installing' });
            throw new Error('installer exited with code 1');
        });
        await mount();
        const btn = host!.querySelector<HTMLButtonElement>('.update-now-btn');
        await act(async () => { btn!.click(); });
        await act(async () => { await Promise.resolve(); });

        const failure = host!.querySelector('.update-failure')?.textContent ?? '';
        // Positive control: the block rendered at all, so the assertions
        // below are not passing against an empty node.
        expect(failure).toContain('installer exited with code 1');
        expect(failure).toMatch(/close Púca completely/i);
        expect(failure).toMatch(/tray/i);
        expect(failure).not.toMatch(/as administrator/i);
    });

    /**
     * The existing behaviour for an early failure must survive: opening the
     * download page is right when the update never reached the install step.
     */
    it('still opens the download page when it fails before installing', async () => {
        installUpdateInPlace.mockImplementation(async (onProgress: (p: unknown) => void) => {
            onProgress({ phase: 'checking' });
            throw new Error('endpoint unreachable');
        });

        await mount();
        const btn = host!.querySelector<HTMLButtonElement>('.update-now-btn');
        expect(btn, 'the Update button must be present').toBeTruthy();
        await act(async () => { btn!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(openDownloadPage).toHaveBeenCalled();
    });
});
