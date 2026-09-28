/**
 * The stream's audio: found from the shared window, changeable while live.
 *
 *  - windowHandleFromTrackLabel / sharedWindowOwner: a window share's track
 *    label is `window:<HWND>:<n>` (measured 2026-09-28 in Edge 154, the
 *    WebView2 engine — the number is exactly the window's handle), and the
 *    Rust `window_owner` command turns the handle into the app to stream.
 *  - the live source list (appAudio) and the Audio sources panel: add an app
 *    to the running mixer, drop one, change a volume — the stream keeps
 *    going. Rust: add_app_audio_source / remove_app_audio_source.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const native = vi.hoisted(() => ({
    calls: [] as Array<{ cmd: string; args?: Record<string, unknown> }>,
    /** Per-command result or thrower. */
    reply: {} as Record<string, (args?: Record<string, unknown>) => unknown>,
    listeners: new Map<string, (e: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
        native.calls.push({ cmd, args });
        const r = native.reply[cmd];
        return r ? r(args) : undefined;
    },
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
        native.listeners.set(name, cb);
        return () => { native.listeners.delete(name); };
    },
}));
vi.mock('../api/platform', () => ({ isTauri: () => true }));

import {
    addLiveAudioSource, getLiveAudioSources, liveMixerRunning, removeLiveAudioSource,
    setAppCaptureGain, sharedWindowOwner, startMultiAppAudioTrack, stopGameAudio,
    windowHandleFromTrackLabel, type CaptureApp,
} from '../api/appAudio';
import { StreamAudioSourcesModal } from '../components/StreamAudioSourcesModal';

const calls = (cmd: string) => native.calls.filter(c => c.cmd === cmd).map(c => c.args);

/** The capture context appAudio builds. The shared setup's mock returns
 *  nothing from close(), where the real one returns a promise. */
class FakeCaptureContext {
    state: AudioContextState = 'running';
    currentTime = 0;
    resume = async () => {};
    close = async () => { this.state = 'closed'; };
    createMediaStreamDestination() {
        return { stream: { getAudioTracks: () => [{ kind: 'audio', id: 'mix' }] } };
    }
}
vi.stubGlobal('AudioContext', FakeCaptureContext);

beforeEach(async () => {
    await stopGameAudio();
    native.calls = [];
    native.reply = {};
    native.listeners.clear();
});

afterEach(async () => {
    await stopGameAudio();
});

describe('the shared window names its app', () => {
    it('reads the window handle from a window share label, and nothing else', () => {
        expect(windowHandleFromTrackLabel('window:132836:0')).toBe(132836);
        expect(windowHandleFromTrackLabel('  window:214896226:0 ')).toBe(214896226);
        for (const label of [
            'screen:0:0', 'screen:2528732444:0', // a whole monitor: no window
            'web-contents-media-stream://1:2', 'window:0:0', 'window:abc:0',
            'window:12', 'Deadlock', '',
        ]) {
            expect(windowHandleFromTrackLabel(label), label).toBeNull();
        }
    });

    it("asks the desktop app who owns that window", async () => {
        native.reply.window_owner = () => ({ pid: 4242, name: 'deadlock', window_title: 'Deadlock' });
        await expect(sharedWindowOwner('window:132836:0')).resolves.toEqual({ pid: 4242, name: 'deadlock', window_title: 'Deadlock' });
        expect(calls('window_owner')).toEqual([{ hwnd: 132836 }]);
    });

    it('does not ask for a screen share, and treats a failure or an old binary as "no owner"', async () => {
        await expect(sharedWindowOwner('screen:0:0')).resolves.toBeNull();
        expect(calls('window_owner')).toEqual([]);
        native.reply.window_owner = () => { throw new Error('command window_owner not found'); };
        await expect(sharedWindowOwner('window:5:0')).resolves.toBeNull();
        native.reply.window_owner = () => null;
        await expect(sharedWindowOwner('window:5:0')).resolves.toBeNull();
    });
});

describe('the stream audio while live', () => {
    async function goLive(apps = [{ pid: 4242, name: 'Deadlock', gainPercent: 100 }], failed: number[] = []) {
        native.reply.start_multi_app_audio_capture = () => failed;
        await startMultiAppAudioTrack(apps);
    }

    it('starts with the apps it went live with, minus any that failed to start', async () => {
        await goLive([
            { pid: 4242, name: 'Deadlock', gainPercent: 100 },
            { pid: 9, name: 'Broken', gainPercent: 100 },
        ], [9]);
        expect(liveMixerRunning()).toBe(true);
        expect(getLiveAudioSources().map(s => s.pid)).toEqual([4242]);
    });

    it('adds an app to the running mixer, at the chosen volume', async () => {
        await goLive();
        await addLiveAudioSource({ pid: 777, name: 'Spotify', gainPercent: 60 });
        expect(calls('add_app_audio_source')).toEqual([{ pid: 777, gain: 0.6 }]);
        expect(getLiveAudioSources().map(s => s.pid)).toEqual([4242, 777]);
        // Already in: not added twice.
        await addLiveAudioSource({ pid: 777, name: 'Spotify', gainPercent: 60 });
        expect(calls('add_app_audio_source')).toHaveLength(1);
    });

    it('a refused add leaves the list as it was, and says why', async () => {
        await goLive();
        native.reply.add_app_audio_source = () => { throw new Error('That app is Puca itself — its audio is never streamed'); };
        await expect(addLiveAudioSource({ pid: 1, name: 'Puca' })).rejects.toThrow(/Puca itself/);
        expect(getLiveAudioSources().map(s => s.pid)).toEqual([4242]);
    });

    it('drops an app without stopping the stream', async () => {
        await goLive();
        await removeLiveAudioSource(4242);
        expect(calls('remove_app_audio_source')).toEqual([{ pid: 4242 }]);
        expect(getLiveAudioSources()).toEqual([]);
        expect(liveMixerRunning(), 'the mixer carries silence until an app is added again').toBe(true);
        expect(calls('stop_app_audio_capture')).toEqual([]);
    });

    it('forgets an app that closed, and one that was added live too', async () => {
        await goLive();
        await addLiveAudioSource({ pid: 777, name: 'Spotify' });
        await act(async () => { native.listeners.get('app-audio-source-ended')!({ payload: 777 }); });
        expect(getLiveAudioSources().map(s => s.pid)).toEqual([4242]);
    });

    it('a volume change is remembered for the panel', async () => {
        await goLive();
        await setAppCaptureGain(4242, 40);
        expect(getLiveAudioSources()[0].gainPercent).toBe(40);
        expect(calls('set_app_capture_gain')).toEqual([{ pid: 4242, gain: 0.4 }]);
    });

    it('nothing to add to once the stream audio stopped, or when there never was any', async () => {
        await expect(addLiveAudioSource({ pid: 777, name: 'Spotify' })).rejects.toThrow(/no app audio/);
        await goLive();
        await stopGameAudio();
        expect(liveMixerRunning()).toBe(false);
        expect(getLiveAudioSources()).toEqual([]);
        await expect(addLiveAudioSource({ pid: 777, name: 'Spotify' })).rejects.toThrow(/no app audio/);
        expect(calls('add_app_audio_source')).toEqual([]);
    });
});

describe('the Audio sources panel', () => {
    const RUNNING: CaptureApp[] = [
        { pid: 4242, name: 'deadlock', window_title: 'Deadlock', has_active_audio: true, icon: null },
        { pid: 777, name: 'Spotify', window_title: 'Spotify Premium', has_active_audio: true, icon: null },
    ];
    let container: HTMLDivElement;
    let root: Root;
    const settle = async () => {
        await act(async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); });
    };
    const row = (title: string) => [...container.querySelectorAll('.app-mixer-row')]
        .find(r => r.textContent?.includes(title)) as HTMLElement;
    const tick = (title: string) => row(title).querySelector('input[type="checkbox"]') as HTMLInputElement;

    beforeEach(() => {
        native.reply.get_running_apps = () => RUNNING;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    async function open() {
        await act(async () => { root.render(<StreamAudioSourcesModal isOpen onClose={() => {}} />); });
        await settle();
    }

    it("shows what the stream carries and adds an app when it's ticked", async () => {
        native.reply.start_multi_app_audio_capture = () => [];
        await startMultiAppAudioTrack([{ pid: 4242, name: 'Deadlock', gainPercent: 100 }]);
        await open();
        expect(tick('Deadlock').checked).toBe(true);
        expect(tick('Spotify Premium').checked).toBe(false);
        await act(async () => { tick('Spotify Premium').click(); });
        await settle();
        expect(calls('add_app_audio_source')).toEqual([{ pid: 777, gain: 1 }]);
        expect(tick('Spotify Premium').checked).toBe(true);
        await act(async () => { tick('Deadlock').click(); });
        await settle();
        expect(calls('remove_app_audio_source')).toEqual([{ pid: 4242 }]);
        expect(tick('Deadlock').checked).toBe(false);
    });

    it('a refused add is shown, and the app stays unticked', async () => {
        native.reply.start_multi_app_audio_capture = () => [];
        native.reply.add_app_audio_source = () => { throw new Error('Audio capture initialisation timed out'); };
        await startMultiAppAudioTrack([{ pid: 4242, name: 'Deadlock', gainPercent: 100 }]);
        await open();
        await act(async () => { tick('Spotify Premium').click(); });
        await settle();
        expect(container.querySelector('.stream-audio-error')?.textContent).toMatch(/Spotify Premium.*timed out/);
        expect(tick('Spotify Premium').checked).toBe(false);
    });

    it('a live volume slider reaches the mixer', async () => {
        native.reply.start_multi_app_audio_capture = () => [];
        await startMultiAppAudioTrack([{ pid: 4242, name: 'Deadlock', gainPercent: 100 }]);
        await open();
        const slider = row('Deadlock').querySelector('input[type="range"]') as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        await act(async () => {
            setter.call(slider, '50');
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await settle();
        expect(calls('set_app_capture_gain')).toEqual([{ pid: 4242, gain: 0.5 }]);
    });

    it('explains itself when the stream went live without app audio', async () => {
        await open();
        expect(container.querySelector('.app-mixer-list')).toBeNull();
        expect(container.textContent).toMatch(/went live without app audio/);
    });
});
