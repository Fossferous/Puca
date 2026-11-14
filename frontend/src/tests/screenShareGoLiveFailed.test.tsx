/**
 * The Share dialog after a Go Live that FAILED (components/ScreenShareModal.tsx).
 *
 * Go Live takes the dialog's start (VoicePanel's onGoLive, shareStarts.ts
 * takeDialog). A Go Live that threw was then followed by the dialog's own
 * Cancel-after-capture, which took the dialog's start a second time, found
 * none, and with none (ownsCapture(null) is true) stopped whatever capture the
 * slot held, while the announcement Go Live had made stayed standing (0.9.850
 * review). Now a failure after Go Live has the capture is Go Live's to take
 * down (VoicePanel's goLive takes a failed publish back itself), and the dialog
 * asks for a Cancel only for a capture nothing else holds. A quick launch whose
 * app-step Go Live failed also closed nothing: open with nothing drawn, it held
 * Share and the arrow, which ignore a press while the dialog is open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { memoryLocalStorage } from './fixtures/fakeSink';

const platform = vi.hoisted(() => ({ desktop: true }));
vi.mock('../api/platform', () => ({ isTauri: () => platform.desktop }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => undefined }));

import ScreenShareModal from '../components/ScreenShareModal';
import { loadSettings, saveSettings } from '../components/settingsStore';
import type { CaptureApp, WindowOwner } from '../api/appAudio';

const GAME: CaptureApp = { pid: 4242, name: 'deadlock', window_title: 'Deadlock', has_active_audio: true, icon: null };
const OWNER: WindowOwner = { pid: 4242, name: 'deadlock', window_title: 'Deadlock' };

let container: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn<() => void>>;
let onCancelAfterCapture: ReturnType<typeof vi.fn<() => void>>;
let goLiveCalls: number;
let goLiveFails: boolean;

function capture(owner: WindowOwner | null, loadApps: () => Promise<CaptureApp[]> = async () => [GAME]) {
    return async () => ({ windowOwner: owner, loadApps, isScreenShare: owner === null, hasBrowserAudio: !platform.desktop });
}

function render(launch: 'quick' | 'settings', onCaptureScreen: ReturnType<typeof capture>) {
    act(() => {
        root.render(
            <ScreenShareModal
                isOpen
                launch={launch}
                onClose={onClose}
                onCaptureScreen={onCaptureScreen}
                onGoLive={async () => {
                    goLiveCalls++;
                    if (goLiveFails) throw new Error('addTrack on a closed connection');
                }}
                onCancelAfterCapture={onCancelAfterCapture}
            />,
        );
    });
}
const settle = async () => {
    await act(async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); });
};
const button = (text: RegExp) =>
    [...container.querySelectorAll('button')].find(b => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const mode = (m: 'auto' | 'pick' | 'none') => saveSettings({ ...loadSettings(), shareAudio: m });
const press = async (text: RegExp) => {
    const b = button(text);
    expect(b, `the ${text} button`).toBeTruthy();
    await act(async () => { b!.click(); });
    await settle();
};

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    platform.desktop = true;
    onClose = vi.fn();
    onCancelAfterCapture = vi.fn();
    goLiveCalls = 0;
    goLiveFails = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('a Go Live that failed is not followed by a Cancel of a start the dialog no longer holds', () => {
    it('web, quick launch: Go Live throws; no Cancel-after-capture, and the dialog closes', async () => {
        platform.desktop = false;
        render('quick', capture(null));
        await settle();
        expect(goLiveCalls).toBe(1);
        expect(onCancelAfterCapture).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it("web, the arrow's dialog: Go Live throws; no Cancel-after-capture, and the dialog stays for another try", async () => {
        platform.desktop = false;
        render('settings', capture(null));
        await press(/Go Live/);
        expect(goLiveCalls).toBe(1);
        expect(onCancelAfterCapture).not.toHaveBeenCalled();
        expect(container.querySelector('.stream-modal'), 'still open').not.toBeNull();
        expect(button(/Go Live/)!.disabled, 'and usable again').toBe(false);
    });

    it("desktop, a window share in 'auto' (no app step): Go Live throws; no Cancel-after-capture", async () => {
        mode('auto');
        render('quick', capture(OWNER));
        await settle();
        expect(goLiveCalls).toBe(1);
        expect(onCancelAfterCapture).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it("desktop, quick launch's app step: Go Live throws; no Cancel-after-capture, and the dialog closes rather than hold Share", async () => {
        mode('pick');
        render('quick', capture(OWNER));
        await settle();
        expect(container.querySelector('.stream-modal'), 'the app step').not.toBeNull();
        await press(/Go Live/);
        expect(goLiveCalls).toBe(1);
        expect(onCancelAfterCapture).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it("desktop, the arrow's app step: Go Live throws; no Cancel-after-capture, back on the settings", async () => {
        mode('pick');
        render('settings', capture(OWNER));
        await press(/Go Live/);
        expect(container.querySelector('.app-mixer-row'), 'the app step').not.toBeNull();
        await press(/Go Live/);
        expect(goLiveCalls).toBe(1);
        expect(onCancelAfterCapture).not.toHaveBeenCalled();
        expect(container.querySelector('.app-mixer-row')).toBeNull();
        expect(container.querySelector('.stream-modal')).not.toBeNull();
    });
});

describe('controls: a capture nothing else holds is still torn down', () => {
    it('Cancel on the app step', async () => {
        mode('pick');
        render('settings', capture(OWNER));
        await press(/Go Live/);
        await press(/Cancel/);
        expect(onCancelAfterCapture).toHaveBeenCalledTimes(1);
        expect(goLiveCalls).toBe(0);
    });

    it('a failure after the capture and before Go Live (the app list throws)', async () => {
        mode('pick');
        render('quick', capture(OWNER, async () => { throw new Error('scan failed'); }));
        await settle();
        expect(goLiveCalls).toBe(0);
        expect(onCancelAfterCapture).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalled();
    });

    it('a Go Live that succeeds closes the dialog with no Cancel', async () => {
        goLiveFails = false;
        platform.desktop = false;
        render('quick', capture(null));
        await settle();
        expect(goLiveCalls).toBe(1);
        expect(onCancelAfterCapture).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });
});
