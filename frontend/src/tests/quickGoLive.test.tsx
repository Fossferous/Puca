/**
 * Going live in three clicks: Share → pick the game → live, with the game's
 * audio.
 *
 * Before (owner's report, 2026-09-28): Share opened a settings dialog, "Select
 * Screen & Go Live" opened the picker, and after the picker an app list
 * asked which audio to stream — with the game NOT ticked, because the only
 * detection signal was matching the window title against the track label,
 * and WebView2's labels carry no title (`window:<HWND>:<n>`). So every stream
 * was: click, wait, pick, tick the game, click again.
 *
 * Now the Share button goes straight to the picker with the remembered
 * settings (the arrow beside it opens them), and the shared window's own app
 * is found from the handle in the label — exact — so a window share needs no
 * app step at all. The app step remains where there is no window to go by
 * (a whole-screen share) or when the streamer chose 'pick'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryLocalStorage } from './fixtures/fakeSink';

const platform = vi.hoisted(() => ({ desktop: true }));
vi.mock('../api/platform', () => ({ isTauri: () => platform.desktop }));
// saveSettings pushes close-to-tray to the shell; nothing to do here.
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => undefined }));

import ScreenShareModal from '../components/ScreenShareModal';
import { loadSettings, saveSettings } from '../components/settingsStore';
import { saveSelection, type CaptureApp, type SelectedApp, type WindowOwner } from '../api/appAudio';

const GAME: CaptureApp = { pid: 4242, name: 'deadlock', window_title: 'Deadlock', has_active_audio: true, icon: null };
const MUSIC: CaptureApp = { pid: 777, name: 'Spotify', window_title: 'Spotify Premium', has_active_audio: true, icon: null };
const OWNER: WindowOwner = { pid: 4242, name: 'deadlock', window_title: 'Deadlock' };

let container: HTMLDivElement;
let root: Root;
type ModalProps = React.ComponentProps<typeof ScreenShareModal>;
type CaptureFn = ModalProps['onCaptureScreen'];
let onClose: ReturnType<typeof vi.fn<() => void>>;
let onCancelAfterCapture: ReturnType<typeof vi.fn<() => void>>;
let goLive: Array<{ audio: string; apps?: SelectedApp[] }>;
let loadApps: ReturnType<typeof vi.fn<() => Promise<CaptureApp[]>>>;
let captureCalls: Array<{ resolution: string; fps: number; prefetchApps: boolean }>;

/** What the picker hands back: a window of `owner`, or a whole screen. */
function capture(owner: WindowOwner | null, apps: CaptureApp[] = [GAME, MUSIC]) {
    loadApps = vi.fn(async () => apps);
    return vi.fn<CaptureFn>(async (opts) => {
        captureCalls.push(opts);
        return { windowOwner: owner, loadApps, isScreenShare: owner === null, hasBrowserAudio: !platform.desktop };
    });
}

function render(launch: 'quick' | 'settings', onCaptureScreen: CaptureFn, strict = false) {
    const modal = (
        <ScreenShareModal
            isOpen
            launch={launch}
            onClose={onClose}
            onCaptureScreen={onCaptureScreen}
            onGoLive={async (audio, apps) => { goLive.push({ audio, apps }); }}
            onCancelAfterCapture={onCancelAfterCapture}
        />
    );
    act(() => { root.render(strict ? <React.StrictMode>{modal}</React.StrictMode> : modal); });
}
const settle = async () => {
    await act(async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); });
};
const dialog = () => container.querySelector('.stream-modal');
const button = (text: RegExp) =>
    [...container.querySelectorAll('button')].find(b => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const mode = (m: 'auto' | 'pick' | 'none') => saveSettings({ ...loadSettings(), shareAudio: m });

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    platform.desktop = true;
    onClose = vi.fn();
    onCancelAfterCapture = vi.fn();
    goLive = [];
    captureCalls = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe('Share: straight to the picker', () => {
    it('opens the picker on open, with the remembered quality — no dialog, no extra click', async () => {
        saveSettings({ ...loadSettings(), shareResolution: '720', shareFps: 60 });
        const onCapture = capture(OWNER);
        render('quick', onCapture);
        expect(onCapture).toHaveBeenCalledTimes(1);
        expect(captureCalls[0]).toMatchObject({ resolution: '720', fps: 60 });
        expect(dialog(), 'a quick launch must not put a dialog in front of the picker').toBeNull();
        await settle();
    });

    it('opens the picker exactly once under StrictMode (two pickers would be a disaster)', async () => {
        const onCapture = capture(OWNER);
        render('quick', onCapture, true);
        await settle();
        expect(onCapture).toHaveBeenCalledTimes(1);
    });

    it("a window share goes live with THAT window's app — no app step, no app scan", async () => {
        const onCapture = capture(OWNER);
        render('quick', onCapture);
        await settle();
        expect(goLive).toEqual([{ audio: 'app', apps: [{ pid: 4242, name: 'Deadlock', gainPercent: 100 }] }]);
        expect(loadApps, 'the ~0.5 s app scan is not needed when the window says whose it is').not.toHaveBeenCalled();
        expect(captureCalls[0].prefetchApps).toBe(false);
        expect(dialog()).toBeNull();
        expect(onClose).toHaveBeenCalled();
    });

    it("keeps the volume the streamer once gave that app", async () => {
        saveSelection([{ name: 'Deadlock', gainPercent: 80 }]);
        render('quick', capture(OWNER));
        await settle();
        expect(goLive[0].apps).toEqual([{ pid: 4242, name: 'Deadlock', gainPercent: 80 }]);
    });

    it('a whole-screen share has no window to go by, so it asks — with the saved choice ticked', async () => {
        saveSelection([{ name: 'Spotify Premium', gainPercent: 60 }]);
        render('quick', capture(null));
        await settle();
        expect(goLive).toEqual([]);
        expect(dialog(), 'the app step').not.toBeNull();
        const ticked = [...container.querySelectorAll<HTMLInputElement>('.app-mixer-row input[type="checkbox"]')]
            .map(c => c.checked);
        expect(ticked.filter(Boolean)).toHaveLength(1);
        await act(async () => { button(/Go Live/)!.click(); });
        await settle();
        expect(goLive).toEqual([{ audio: 'app', apps: [{ pid: 777, name: 'Spotify Premium', gainPercent: 60 }] }]);
    });

    it("'pick' always asks, the shared window's app first and ticked, and scans while the picker is up", async () => {
        mode('pick');
        // 'Amp' sorts ahead of 'deadlock' by name: first place must be earned
        // by being the shared window's app, not by the alphabet.
        render('quick', capture(OWNER, [{ ...MUSIC, name: 'Amp', window_title: 'Amp' }, GAME]));
        await settle();
        expect(captureCalls[0].prefetchApps).toBe(true);
        const rows = [...container.querySelectorAll('.app-mixer-row')];
        expect(rows[0].textContent).toContain('Deadlock');
        expect((rows[0].querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
        await act(async () => { button(/Go Live/)!.click(); });
        await settle();
        expect(goLive[0].apps?.map(a => a.pid)).toEqual([4242]);
    });

    it("'pick' ticks the shared window's app alongside the saved selection, not instead of it", async () => {
        mode('pick');
        saveSelection([{ name: 'Spotify Premium', gainPercent: 60 }]);
        render('quick', capture(OWNER));
        await settle();
        await act(async () => { button(/Go Live/)!.click(); });
        await settle();
        expect(goLive[0].apps?.map(a => a.pid).sort((a, b) => a - b)).toEqual([777, 4242]);
    });

    it("the window's own process is ticked even when the scan listed another of the same name", async () => {
        mode('pick');
        // The scan keeps one process per exe name — here a different one.
        const other: CaptureApp = { ...GAME, pid: 5000, window_title: null };
        render('quick', capture(OWNER, [other, MUSIC]));
        await settle();
        const first = container.querySelector('.app-mixer-row')!;
        expect(first.textContent).toContain('Deadlock');
        await act(async () => { button(/Go Live/)!.click(); });
        await settle();
        expect(goLive[0].apps?.map(a => a.pid)).toEqual([4242]);
    });

    it("'none' goes live video-only", async () => {
        mode('none');
        render('quick', capture(OWNER));
        await settle();
        expect(goLive).toEqual([{ audio: 'none', apps: undefined }]);
    });

    it('a cancelled picker ends the quick launch quietly', async () => {
        const onCapture = vi.fn<CaptureFn>(async () => null);
        render('quick', onCapture);
        await settle();
        expect(onClose).toHaveBeenCalled();
        expect(goLive).toEqual([]);
        expect(dialog()).toBeNull();
    });

    it('web: the browser picker decides the audio', async () => {
        platform.desktop = false;
        render('quick', capture(null));
        await settle();
        expect(goLive).toEqual([{ audio: 'browser', apps: undefined }]);
    });
});

describe('the arrow beside Share: settings first', () => {
    it('shows the settings and captures nothing until asked', async () => {
        const onCapture = capture(OWNER);
        render('settings', onCapture);
        await settle();
        expect(dialog()).not.toBeNull();
        expect(onCapture).not.toHaveBeenCalled();
    });

    it('remembers the audio choice, and the next quick launch uses it', async () => {
        render('settings', capture(OWNER));
        const select = container.querySelector('select.app-select') as HTMLSelectElement;
        await act(async () => {
            select.value = 'pick';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(loadSettings().shareAudio).toBe('pick');
        act(() => root.unmount());
        root = createRoot(container);
        render('quick', capture(OWNER));
        await settle();
        expect(dialog(), "'pick' shows the app step").not.toBeNull();
        expect(goLive).toEqual([]);
    });
});

describe('VoicePanel wiring (VoicePanel is not mountable under vitest)', () => {
    const vp = readFileSync(join(__dirname, '..', 'components', 'VoicePanel.tsx'), 'utf8');
    const shareButton = vp.slice(vp.indexOf('vp-screenshare'), vp.indexOf('vp-share-options'));

    it('the Share button launches quick; the arrow launches settings', () => {
        expect(shareButton).toMatch(/setShareLaunch\('quick'\);\s*setShowStreamSettings\(true\)/);
        // Not sharing: the arrow opens the settings the next share starts with
        // (while live it opens Stream quality — liveShareQuality.test.tsx).
        expect(vp).toMatch(/vp-share-options"[\s\S]{0,400}setShareLaunch\('settings'\);\s*setShowStreamSettings\(true\)/);
        expect(vp).toMatch(/<ScreenShareModal[\s\S]{0,120}launch=\{shareLaunch\}/);
    });

    it('offers Audio sources only while sharing on the desktop app, and renders the panel', () => {
        expect(vp).toMatch(/isScreenSharing && isTauri\(\) && \([\s\S]{0,200}setShowStreamAudio\(true\)/);
        expect(vp).toMatch(/<StreamAudioSourcesModal\s+isOpen=\{showStreamAudio && isScreenSharing\}/);
    });

    it("hands the dialog the shared window's owner, and scans apps only when asked to", () => {
        expect(vp).toMatch(/isDesktop && prefetchApps/);
        expect(vp).toMatch(/const windowOwner = await sharedWindowOwner\(label\)/);
    });

    it('positive control: the patterns are anchored in the real file', () => {
        expect(shareButton.length).toBeGreaterThan(100);
        expect(vp).toContain('onCaptureScreen={async ({ resolution, fps, prefetchApps })');
    });
});
