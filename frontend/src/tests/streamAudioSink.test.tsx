/**
 * Watched-stream audio follows Settings > Output Device.
 *
 * Found 2026-09-28 at 0.9.823: stream audio ignored the chosen device on both
 * of its paths and always played on the OS default.
 *   - StreamStage plays a stream through a Web Audio graph (source -> gain ->
 *     ctx.destination) on a context that was never routed. Its <video>s were
 *     re-routed on settingsChanged, but they are MUTED in the normal path, so
 *     that re-route did nothing audible.
 *   - StreamPip, the only stream audio path in chat view (the stage is
 *     unmounted there), plays through its own unmuted <video>, which was never
 *     routed at all.
 * Both now route, re-route on settingsChanged/devicechange, and make no sound
 * before the first routing has landed (a fresh context or element starts on
 * the default).
 *
 * 2026-10-02: the path outside the stage is now StreamAudioHost (one hidden
 * <audio> per watched stream — StreamPip voiced only the first, and nothing
 * where it was not mounted); the float's <video> is picture only. The same
 * routing guarantees moved with it (more in streamAudioHost.test.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    FakeSink, flushMicrotasks, installDeviceChangeEvents, installElementSinks, memoryLocalStorage,
} from './fixtures/fakeSink';

const STREAMS = new Map<number, { username: string; stream: MediaStream }>();
let selected: number[] = [];
let streamers: { userId: number; username: string }[] = [];
const subscribers = new Set<() => void>();
const notify = () => { for (const cb of [...subscribers]) cb(); };

vi.mock('../components/voiceState', () => ({
    subscribeToStreamState: (cb: () => void) => { subscribers.add(cb); return () => { subscribers.delete(cb); }; },
    subscribeToVoiceUsers: () => () => {},
    subscribeToSpeaking: () => () => {},
    getSelectedStreams: () => [...selected],
    getStreamData: (id: number) => STREAMS.get(id) ?? null,
    getAllStreamers: () => [...streamers],
    deselectStream: vi.fn(),
    selectStream: vi.fn(),
    clearAllStreams: vi.fn(),
    stopOwnScreenShare: vi.fn(),
    getCurrentStreamingUserId: () => null,
    notifyStreamStateChange: vi.fn(),
    globalSpeakingUsers: new Set<number>(),
    getAllVoiceUsers: () => [],
    globalCameraStreams: new Map<number, MediaStream>(),
}));

vi.mock('../api/remoteControl', () => ({
    requestControl: vi.fn(),
    stopControlling: vi.fn(),
    sendControlEvent: vi.fn(),
    subscribeControl: () => () => {},
    getControlState: () => ({ controlling: null, hosting: null }),
    offerControl: vi.fn(),
    computeRmoveScale: () => 1,
    getControlHostCapture: () => null,
}));

vi.mock('../api/rtc/sfuManager', () => ({
    sfuManager: { setFocusedRemote: () => {} },
}));

import { StreamStage } from '../components/StreamStage';
import { StreamAudioHost } from '../components/StreamAudioHost';
import { useStreamStore } from '../stores/streamStore';
import { loadSettings, saveSettings } from '../components/settingsStore';

/** A stream carrying system audio, as a watched share does. */
function streamWithAudio(trackId: string): MediaStream {
    const s = new MediaStream();
    s.addTrack({ kind: 'audio', id: trackId } as MediaStreamTrack);
    return s;
}

const devices = new Set<string>();
/** Each gain's arrival at the speakers, tagged with the sink it landed on. */
let connected: string[] = [];
let contexts: FakeStageContext[] = [];

class FakeStageContext extends FakeSink {
    state: AudioContextState = 'running';
    currentTime = 0;
    destination = { speakers: true };
    constructor() {
        super(devices);
        contexts.push(this);
    }
    resume = async () => { this.state = 'running'; };
    close = async () => { this.state = 'closed'; };
    createMediaStreamSource() {
        return { connect: () => {}, disconnect: () => {} };
    }
    createGain() {
        return {
            gain: { value: 1, setTargetAtTime: () => {} },
            connect: (dest: unknown) => {
                if (dest === this.destination) connected.push(`speakers@${this.sinkId || 'default'}`);
            },
            disconnect: () => {},
        };
    }
}

function choose(outputDeviceId: string) {
    saveSettings({ ...loadSettings(), outputDeviceId });
}

let container: HTMLDivElement;
let root: Root;
let elementSinks: ReturnType<typeof installElementSinks>;
let deviceEvents: ReturnType<typeof installDeviceChangeEvents>;

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    vi.stubGlobal('AudioContext', FakeStageContext);
    devices.clear();
    devices.add('headset-1');
    devices.add('speakers-2');
    connected = [];
    contexts = [];
    useStreamStore.getState().clearAllStreams();
    STREAMS.clear();
    STREAMS.set(1, { username: 'alice', stream: streamWithAudio('a-1') });
    selected = [1];
    streamers = [{ userId: 1, username: 'alice' }];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    elementSinks = installElementSinks(devices);
    deviceEvents = installDeviceChangeEvents();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    elementSinks.uninstall();
    deviceEvents.uninstall();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const video = () => container.querySelector('video')!;

describe('StreamStage — the Web Audio path', () => {
    function renderStage() {
        act(() => { root.render(<StreamStage onBackToChat={() => {}} />); });
    }

    it('routes its context to the chosen device, and joins the speakers only once it is there', async () => {
        choose('headset-1');
        renderStage();
        expect(contexts).toHaveLength(1);
        const ctx = contexts[0];
        expect(ctx.calls).toEqual(['headset-1']);
        await act(async () => { await flushMicrotasks(); });
        // The switch has not landed: the context is still on the OS default,
        // and connecting now is the leak.
        expect(connected).toEqual([]);
        await act(async () => { await ctx.settle(); });
        expect(connected).toEqual(['speakers@headset-1']);
    });

    it('follows a Settings change to the live context', async () => {
        choose('headset-1');
        renderStage();
        const ctx = contexts[0];
        await act(async () => { await ctx.settle(); });
        act(() => { choose('speakers-2'); });
        expect(ctx.calls).toEqual(['headset-1', 'speakers-2']);
        await act(async () => { await ctx.settle(); });
        expect(ctx.sinkId).toBe('speakers-2');
    });

    it('chases a chosen device that was missing and comes back (devicechange)', async () => {
        devices.delete('headset-1');
        choose('headset-1');
        renderStage();
        const ctx = contexts[0];
        await act(async () => { await ctx.settle(); });
        expect(connected).toEqual(['speakers@default']); // fell back: still audible

        devices.add('headset-1');
        act(() => { deviceEvents.fire(); });
        await act(async () => { await ctx.settle(); });
        expect(ctx.sinkId).toBe('headset-1');
    });

    it('never connects a graph that was torn down while routing was in flight', async () => {
        choose('headset-1');
        renderStage();
        const ctx = contexts[0];
        act(() => { selected = []; notify(); });
        await act(async () => { await ctx.settle(); });
        expect(connected).toEqual([]);
    });

    it('routes the tile <video> when it binds, so the element-audio fallback follows too', async () => {
        choose('headset-1');
        renderStage();
        expect(elementSinks.sinkOf(video()).calls).toEqual(['headset-1']);
    });

    it('routes a tile whose stream arrives later, with no re-render (the bind retry poll)', async () => {
        // A re-render re-runs the inline ref callback, which binds on its own;
        // the poll is the path for a stream that lands with no state change.
        vi.useFakeTimers();
        try {
            choose('headset-1');
            const late = STREAMS.get(1)!.stream;
            STREAMS.set(1, { username: 'alice', stream: null as unknown as MediaStream });
            renderStage();
            expect(video().srcObject ?? null).toBeNull();
            expect(elementSinks.sinkOf(video()).calls).toEqual([]);
            STREAMS.set(1, { username: 'alice', stream: late });
            act(() => { vi.advanceTimersByTime(500); });
            expect(video().srcObject).toBe(late);
            expect(elementSinks.sinkOf(video()).calls).toEqual(['headset-1']);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('StreamAudioHost — the path everywhere the stage is not', () => {
    const audio = () => container.querySelector<HTMLAudioElement>('audio[data-stream-audio="1"]')!;
    function renderHost() {
        act(() => { root.render(<StreamAudioHost />); });
    }

    it('routes its <audio> to the chosen device and holds it muted until the switch lands', async () => {
        choose('headset-1');
        renderHost();
        const sink = elementSinks.sinkOf(audio());
        expect(sink.calls).toEqual(['headset-1']);
        expect((audio().srcObject as MediaStream).getAudioTracks()).toEqual(STREAMS.get(1)!.stream.getAudioTracks());
        // Bound and autoplaying, but still on the OS default: must be silent.
        expect(audio().muted).toBe(true);
        await act(async () => { await sink.settle(); });
        expect(sink.sinkId).toBe('headset-1');
        expect(audio().muted).toBe(false);
    });

    it('follows a Settings change', async () => {
        choose('headset-1');
        renderHost();
        const sink = elementSinks.sinkOf(audio());
        await act(async () => { await sink.settle(); });

        act(() => { choose('speakers-2'); });
        await act(async () => { await sink.settle(); });
        expect(sink.sinkId).toBe('speakers-2');
    });

    it('chases a chosen device that was missing and comes back (devicechange)', async () => {
        devices.delete('headset-1');
        choose('headset-1');
        renderHost();
        const sink = elementSinks.sinkOf(audio());
        await act(async () => { await sink.settle(); });
        expect(sink.sinkId).toBe(''); // fell back: still audible
        expect(audio().muted).toBe(false);

        devices.add('headset-1');
        act(() => { deviceEvents.fire(); });
        await act(async () => { await sink.settle(); });
        expect(sink.sinkId).toBe('headset-1');
    });

    it('an <audio> remounted after the selection emptied is held muted until IT is routed', async () => {
        // The host renders nothing while no stream is selected, so the element
        // is a new one each time a selection comes back — with a fresh sinkId.
        choose('headset-1');
        renderHost();
        const first = audio();
        await act(async () => { await elementSinks.sinkOf(first).settle(); });
        expect(first.muted).toBe(false);

        act(() => { selected = []; notify(); });
        expect(container.querySelector('audio')).toBeNull();
        act(() => { selected = [1]; notify(); });
        const second = audio();
        expect(second).not.toBe(first);
        expect(elementSinks.sinkOf(second).calls).toEqual(['headset-1']);
        expect(second.muted).toBe(true);
        await act(async () => { await elementSinks.sinkOf(second).settle(); });
        expect(second.muted).toBe(false);
    });

    it('on the default device it plays at once, with no routing call', async () => {
        renderHost();
        await act(async () => { await flushMicrotasks(); });
        expect(elementSinks.sinkOf(audio()).calls).toEqual([]);
        expect(audio().muted).toBe(false);
    });
});
