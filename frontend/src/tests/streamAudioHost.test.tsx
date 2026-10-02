/**
 * StreamAudioHost — the ONE audio path for watched streams whenever the
 * stream stage is not mounted (chat view with the float, the voice view,
 * Notes, a DM, the dashboards, the phone's docked strip), and silent while
 * the stage is mounted (the stage's Web Audio graph owns stream audio then).
 *
 * Before it: the chat-view path was the float's single <video>, bound to the
 * FIRST watched stream only — every other watched stream was silent in chat
 * view, popped out or not — and the voice view with the float up mounted
 * neither the stage nor the float, so no stream had any audio at all.
 *
 * Asserted as ROUTING (which element is bound to which audio track, its
 * muted flag, its volume, its sink), never as sound.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    FakeSink, flushMicrotasks, installDeviceChangeEvents, installElementSinks, memoryLocalStorage,
} from './fixtures/fakeSink';

const STREAMS = new Map<number, { username: string; stream: MediaStream | null }>();
let selected: number[] = [];
let own: number | null = null;
const subscribers = new Set<() => void>();
const notify = () => { for (const cb of [...subscribers]) cb(); };

vi.mock('../components/voiceState', () => ({
    subscribeToStreamState: (cb: () => void) => { subscribers.add(cb); return () => { subscribers.delete(cb); }; },
    subscribeToVoiceUsers: () => () => {},
    subscribeToSpeaking: () => () => {},
    getSelectedStreams: () => [...selected],
    getStreamData: (id: number) => STREAMS.get(id) ?? undefined,
    getAllStreamers: () => [...STREAMS.entries()].map(([userId, d]) => ({ userId, ...d })),
    deselectStream: vi.fn(),
    selectStream: vi.fn(),
    clearAllStreams: vi.fn(),
    stopOwnScreenShare: vi.fn(),
    getCurrentStreamingUserId: () => own,
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
vi.mock('../api/rtc/sfuManager', () => ({ sfuManager: { setFocusedRemote: () => {} } }));

import { StreamAudioHost } from '../components/StreamAudioHost';
import { claimStageAudio, stageOwnsStreamAudio } from '../components/streamAudioRouting';
import { StreamStage } from '../components/StreamStage';
import { useStreamStore } from '../stores/streamStore';
import { loadSettings, saveSettings } from '../components/settingsStore';
import { setStreamMuted, setStreamVolume } from '../components/streamVolumeStore';

const devices = new Set<string>();

class FakeStageContext extends FakeSink {
    state: AudioContextState = 'running';
    currentTime = 0;
    destination = {};
    constructor() { super(devices); }
    resume = async () => {};
    close = async () => { this.state = 'closed'; };
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
    createGain() { return { gain: { value: 1, setTargetAtTime: () => {} }, connect: () => {}, disconnect: () => {} }; }
}

/** A watched share: a video track plus its system-audio track. */
function share(id: number, opts: { audio?: boolean } = {}): MediaStream {
    const s = new MediaStream();
    s.addTrack({ kind: 'video', id: `v-${id}` } as MediaStreamTrack);
    if (opts.audio !== false) s.addTrack({ kind: 'audio', id: `a-${id}` } as MediaStreamTrack);
    STREAMS.set(id, { username: `user-${id}`, stream: s });
    return s;
}
const choose = (outputDeviceId: string) => saveSettings({ ...loadSettings(), outputDeviceId });
const master = (outputVolume: number) => saveSettings({ ...loadSettings(), outputVolume });

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
    useStreamStore.getState().clearAllStreams();
    STREAMS.clear();
    own = null;
    share(1);
    share(2);
    selected = [1, 2];
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

const audioFor = (id: number) => container.querySelector<HTMLAudioElement>(`audio[data-stream-audio="${id}"]`);
const tracksOf = (el: HTMLMediaElement | null) => ((el?.srcObject as MediaStream | null)?.getTracks() ?? []).map(t => t.id);

async function renderHost() {
    await act(async () => { root.render(<StreamAudioHost />); });
    await act(async () => { await flushMicrotasks(); });
}

describe('every watched stream, exactly once', () => {
    it('one element per watched stream, bound to THAT stream’s audio only, and all of them audible', async () => {
        await renderHost();
        expect(tracksOf(audioFor(1))).toEqual(['a-1']);
        expect(tracksOf(audioFor(2))).toEqual(['a-2']); // the stream the float never voiced
        expect(audioFor(1)!.muted).toBe(false);
        expect(audioFor(2)!.muted).toBe(false);
    });

    it('your own share is never played back to you', async () => {
        own = 2;
        await renderHost();
        expect(audioFor(1)).not.toBeNull();
        expect(audioFor(2)).toBeNull();
    });

    it('system audio that arrives after the video is picked up', async () => {
        const late = share(3, { audio: false });
        selected = [3];
        await renderHost();
        expect(tracksOf(audioFor(3))).toEqual([]);
        late.addTrack({ kind: 'audio', id: 'a-3' } as MediaStreamTrack);
        await act(async () => { notify(); await flushMicrotasks(); });
        expect(tracksOf(audioFor(3))).toEqual(['a-3']);
    });

    it('a stream no longer watched loses its element', async () => {
        await renderHost();
        await act(async () => { selected = [1]; notify(); await flushMicrotasks(); });
        expect(audioFor(1)).not.toBeNull();
        expect(audioFor(2)).toBeNull();
    });
});

describe('the single-audible-path rule: the stage, when mounted, owns stream audio', () => {
    it('a stage claim silences every host element AT ONCE, and its release gives them back', async () => {
        await renderHost();
        // No act(): the mute must not wait for a React render.
        const release = claimStageAudio();
        try {
            expect(stageOwnsStreamAudio()).toBe(true);
            expect(audioFor(1)!.muted).toBe(true);
            expect(audioFor(2)!.muted).toBe(true);
        } finally {
            await act(async () => { release(); await flushMicrotasks(); });
        }
        expect(stageOwnsStreamAudio()).toBe(false);
        expect(audioFor(1)!.muted).toBe(false);
        expect(audioFor(2)!.muted).toBe(false);
    });

    it('the REAL stage claims while mounted: host silent beside it, audible again once it unmounts', async () => {
        function Both({ stage }: { stage: boolean }) {
            return <>{stage && <StreamStage onBackToChat={() => {}} />}<StreamAudioHost /></>;
        }
        await act(async () => { root.render(<Both stage />); });
        await act(async () => { await flushMicrotasks(); });
        expect(audioFor(1)!.muted).toBe(true);
        expect(audioFor(2)!.muted).toBe(true);
        await act(async () => { root.render(<Both stage={false} />); });
        await act(async () => { await flushMicrotasks(); });
        expect(stageOwnsStreamAudio()).toBe(false);
        expect(audioFor(1)!.muted).toBe(false);
        expect(audioFor(2)!.muted).toBe(false);
    });
});

describe('per-stream mute and volume, and the master Output Volume', () => {
    it('a stream muted on the stage stays muted here; the other plays', async () => {
        setStreamMuted(2, true);
        await renderHost();
        expect(audioFor(1)!.muted).toBe(false);
        expect(audioFor(2)!.muted).toBe(true);
    });

    it('plays at stream volume × master, capped at full scale (an element cannot boost)', async () => {
        master(50);
        setStreamVolume(2, 150);
        await renderHost();
        expect(audioFor(1)!.volume).toBeCloseTo(0.5, 9);
        expect(audioFor(2)!.volume).toBeCloseTo(0.75, 9);
        await act(async () => { master(100); await flushMicrotasks(); });
        expect(audioFor(2)!.volume).toBe(1);
    });

    it('a stage edit to volume/mute is read back when the stage hands audio back', async () => {
        await renderHost();
        const release = claimStageAudio();
        try {
            setStreamVolume(1, 40);
            setStreamMuted(2, true);
        } finally {
            await act(async () => { release(); await flushMicrotasks(); });
        }
        expect(audioFor(1)!.volume).toBeCloseTo(0.4, 9);
        expect(audioFor(2)!.muted).toBe(true);
    });
});

describe('Output Device: routed before it is ever unmuted', () => {
    it('holds each element muted until ITS switch lands, then plays on the chosen device', async () => {
        choose('headset-1');
        await renderHost();
        const s1 = elementSinks.sinkOf(audioFor(1)!);
        const s2 = elementSinks.sinkOf(audioFor(2)!);
        expect(s1.calls).toEqual(['headset-1']);
        expect(s2.calls).toEqual(['headset-1']);
        expect(audioFor(1)!.muted).toBe(true);
        expect(audioFor(2)!.muted).toBe(true);
        await act(async () => { await s1.settle(); });
        expect(audioFor(1)!.muted).toBe(false);
        expect(audioFor(2)!.muted).toBe(true); // its own routing has not landed
        await act(async () => { await s2.settle(); });
        expect(s2.sinkId).toBe('headset-1');
        expect(audioFor(2)!.muted).toBe(false);
    });

    it('follows a Settings change', async () => {
        choose('headset-1');
        await renderHost();
        const s1 = elementSinks.sinkOf(audioFor(1)!);
        await act(async () => { await s1.settle(); });
        act(() => { choose('speakers-2'); });
        await act(async () => { await s1.settle(); });
        expect(s1.sinkId).toBe('speakers-2');
    });

    it('chases a chosen device that was missing and comes back (devicechange)', async () => {
        devices.delete('headset-1');
        choose('headset-1');
        await renderHost();
        const s1 = elementSinks.sinkOf(audioFor(1)!);
        await act(async () => { await s1.settle(); });
        expect(s1.sinkId).toBe(''); // fell back: still audible
        expect(audioFor(1)!.muted).toBe(false);
        devices.add('headset-1');
        act(() => { deviceEvents.fire(); });
        await act(async () => { await s1.settle(); });
        expect(s1.sinkId).toBe('headset-1');
    });

    it('a stream watched later gets a NEW element, held muted until it is routed', async () => {
        choose('headset-1');
        selected = [1];
        await renderHost();
        await act(async () => { await elementSinks.sinkOf(audioFor(1)!).settle(); });
        await act(async () => { selected = [1, 2]; notify(); await flushMicrotasks(); });
        const s2 = elementSinks.sinkOf(audioFor(2)!);
        expect(s2.calls).toEqual(['headset-1']);
        expect(audioFor(2)!.muted).toBe(true);
        await act(async () => { await s2.settle(); });
        expect(audioFor(2)!.muted).toBe(false);
    });

    it('on the default device it plays at once, with no routing call', async () => {
        await renderHost();
        expect(elementSinks.sinkOf(audioFor(1)!).calls).toEqual([]);
        expect(audioFor(1)!.muted).toBe(false);
    });
});
