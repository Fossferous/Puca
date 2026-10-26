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
 * 2026-10-26: what sounds is a Web Audio gain PER STREAM (the owner: "make
 * sure if watching multiple streams you can still adjust each volume
 * separate of each other"), so a boost above 100% and an iPhone's volume work
 * here as on the stage; each <audio> is the muted sink Chromium needs. Stream
 * Attenuation stays the stage's ("Big view only, as before"). Where Web Audio
 * cannot play, or cannot reach the chosen Output Device (Firefox, Safari), the
 * <audio> plays it exactly as before (the element fallback, below).
 *
 * Asserted as ROUTING and VALUES (which element is bound to which track, its
 * muted flag, its volume, its sink; which gain node carries which track, what
 * it was sent, when it joined the speakers), never as sound.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    flushMicrotasks, installDeviceChangeEvents, installElementSinks, memoryLocalStorage,
} from './fixtures/fakeSink';
import { FakeStreamAudioContext, fakeAudio, resetFakeStreamAudio } from './fixtures/fakeStreamAudio';

const STREAMS = new Map<number, { username: string; stream: MediaStream | null }>();
let selected: number[] = [];
let own: number | null = null;
const subscribers = new Set<() => void>();
const notify = () => { for (const cb of [...subscribers]) cb(); };
// Read by the mock factory itself, which runs before this module's consts.
const speech = vi.hoisted(() => ({ users: new Set<number>(), listeners: new Set<() => void>() }));
const speakingUsers = speech.users;

vi.mock('../components/voiceState', () => ({
    subscribeToStreamState: (cb: () => void) => { subscribers.add(cb); return () => { subscribers.delete(cb); }; },
    subscribeToVoiceUsers: () => () => {},
    subscribeToSpeaking: (cb: () => void) => { speech.listeners.add(cb); return () => { speech.listeners.delete(cb); }; },
    getSelectedStreams: () => [...selected],
    getStreamData: (id: number) => STREAMS.get(id) ?? undefined,
    getAllStreamers: () => [...STREAMS.entries()].map(([userId, d]) => ({ userId, ...d })),
    deselectStream: vi.fn(),
    selectStream: vi.fn(),
    clearAllStreams: vi.fn(),
    stopOwnScreenShare: vi.fn(),
    getCurrentStreamingUserId: () => own,
    notifyStreamStateChange: vi.fn(),
    globalSpeakingUsers: speech.users,
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
import { setAttenuation, setStreamMuted, setStreamVolume } from '../components/streamVolumeStore';

/** The loudness curve, stated independently of the code under test. */
const loud = (p: number) => (p <= 100 ? (p / 100) ** 2 : 2 ** ((p - 100) / 100));

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
function speak(on: boolean) {
    if (on) speakingUsers.add(42); else speakingUsers.clear();
    for (const cb of [...speech.listeners]) cb();
}

let container: HTMLDivElement;
let root: Root;
let elementSinks: ReturnType<typeof installElementSinks>;
let deviceEvents: ReturnType<typeof installDeviceChangeEvents>;
let plays: HTMLMediaElement[] = [];

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    resetFakeStreamAudio({ devices: ['headset-1', 'speakers-2'] });
    vi.stubGlobal('AudioContext', FakeStreamAudioContext);
    useStreamStore.getState().clearAllStreams();
    STREAMS.clear();
    speakingUsers.clear();
    own = null;
    share(1);
    share(2);
    selected = [1, 2];
    plays = [];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        plays.push(this);
        return Promise.resolve();
    });
    elementSinks = installElementSinks(fakeAudio.devices);
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
/** The level stream `id` sounds at through the small player's graph. */
const graphLevel = (id: number) => fakeAudio.hostGainFor(`a-${id}`)?.gain.effective;

async function renderHost() {
    await act(async () => { root.render(<StreamAudioHost />); });
    await act(async () => { await flushMicrotasks(); });
}

describe('every watched stream, exactly once', () => {
    it('one element per watched stream, bound to THAT stream’s audio only, and every one sounding through its own gain', async () => {
        await renderHost();
        expect(tracksOf(audioFor(1))).toEqual(['a-1']);
        expect(tracksOf(audioFor(2))).toEqual(['a-2']); // the stream the float never voiced
        const g1 = fakeAudio.hostGainFor('a-1');
        const g2 = fakeAudio.hostGainFor('a-2');
        expect(g1, 'stream 1 has a gain of its own').not.toBeNull();
        expect(g2, 'stream 2 has a gain of its own').not.toBeNull();
        expect(g1).not.toBe(g2); // never shared
        expect(g1!.tracks).toEqual(['a-1']);
        expect(g2!.tracks).toEqual(['a-2']);
        expect(g1!.gain.effective).toBe(1);
        expect(g2!.gain.effective).toBe(1);
        expect(g1!.speakersAt).toBe('default');
        // The elements are the muted sinks the engine needs, and they play.
        expect(audioFor(1)!.muted).toBe(true);
        expect(audioFor(2)!.muted).toBe(true);
        expect(plays).toContain(audioFor(1));
        expect(plays).toContain(audioFor(2));
    });

    it('your own share is never played back to you', async () => {
        own = 2;
        await renderHost();
        expect(audioFor(1)).not.toBeNull();
        expect(audioFor(2)).toBeNull();
        expect(fakeAudio.hostGainFor('a-2')).toBeNull();
    });

    it('system audio that arrives after the video is picked up when the stream bus re-emits (the mesh and SFU ontrack paths)', async () => {
        const late = share(3, { audio: false });
        selected = [3];
        await renderHost();
        expect(tracksOf(audioFor(3))).toEqual([]);
        late.addTrack({ kind: 'audio', id: 'a-3' } as MediaStreamTrack);
        await act(async () => { notify(); await flushMicrotasks(); });
        expect(tracksOf(audioFor(3))).toEqual(['a-3']);
        expect(graphLevel(3)).toBe(1);
    });

    // A REMOTE MediaStream fires addtrack/removetrack when the peer
    // connection changes its tracks (the test MediaStream is not an
    // EventTarget, so give this one a real event surface). No notify() here:
    // the stream bus is not what is under test, the listener is.
    function evented(s: MediaStream): MediaStream {
        const et = new EventTarget();
        Object.assign(s, {
            addEventListener: et.addEventListener.bind(et),
            removeEventListener: et.removeEventListener.bind(et),
            dispatchEvent: et.dispatchEvent.bind(et),
        });
        return s;
    }

    it('a track the source stream ANNOUNCES (addtrack event, no stream-bus re-emit) is bound', async () => {
        const late = evented(share(3, { audio: false }));
        selected = [3];
        await renderHost();
        expect(tracksOf(audioFor(3))).toEqual([]);
        late.addTrack({ kind: 'audio', id: 'a-3' } as MediaStreamTrack);
        await act(async () => { late.dispatchEvent(new Event('addtrack')); await flushMicrotasks(); });
        expect(tracksOf(audioFor(3))).toEqual(['a-3']);
        expect(graphLevel(3)).toBe(1);
    });

    it('a track the source stream drops (removetrack event) is unbound', async () => {
        const src = evented(share(3));
        selected = [3];
        await renderHost();
        expect(tracksOf(audioFor(3))).toEqual(['a-3']);
        src.removeTrack(src.getAudioTracks()[0]);
        await act(async () => { src.dispatchEvent(new Event('removetrack')); await flushMicrotasks(); });
        expect(tracksOf(audioFor(3))).toEqual([]);
        expect(fakeAudio.hostGainFor('a-3')).toBeNull();
    });

    it('a stream no longer watched loses its element and its gain', async () => {
        await renderHost();
        const g2 = fakeAudio.hostGainFor('a-2')!;
        await act(async () => { selected = [1]; notify(); await flushMicrotasks(); });
        expect(audioFor(1)).not.toBeNull();
        expect(audioFor(2)).toBeNull();
        expect(g2.disconnected).toBe(true);
    });

    it('with nothing watched any more, the audio device is let go (the context closes)', async () => {
        await renderHost();
        const ctx = fakeAudio.liveOf('host')!;
        await act(async () => { selected = []; notify(); await flushMicrotasks(); });
        expect(ctx.state).toBe('closed');
    });
});

describe('the single-audible-path rule: the stage, when mounted, owns stream audio', () => {
    it('a stage claim silences every stream here AT ONCE, and its release gives them back', async () => {
        await renderHost();
        // No act(): the silence must not wait for a React render.
        const release = claimStageAudio();
        try {
            expect(stageOwnsStreamAudio()).toBe(true);
            expect(graphLevel(1)).toBe(0);
            expect(graphLevel(2)).toBe(0);
            expect(audioFor(1)!.muted).toBe(true);
            expect(audioFor(2)!.muted).toBe(true);
        } finally {
            await act(async () => { release(); await flushMicrotasks(); });
        }
        expect(stageOwnsStreamAudio()).toBe(false);
        expect(graphLevel(1)).toBe(1);
        expect(graphLevel(2)).toBe(1);
    });

    it('the REAL stage claims while mounted: nothing here sounds beside it, and it sounds again once the stage unmounts', async () => {
        function Both({ stage }: { stage: boolean }) {
            return <>{stage && <StreamStage onBackToChat={() => {}} />}<StreamAudioHost /></>;
        }
        await act(async () => { root.render(<Both stage />); });
        await act(async () => { await flushMicrotasks(); });
        expect(fakeAudio.gainsOf('stage').length, 'positive control: the stage plays them').toBe(2);
        for (const g of fakeAudio.gainsOf('host')) expect(g.gain.effective).toBe(0);
        expect(audioFor(1)!.muted).toBe(true);
        expect(audioFor(2)!.muted).toBe(true);
        await act(async () => { root.render(<Both stage={false} />); });
        await act(async () => { await flushMicrotasks(); });
        expect(stageOwnsStreamAudio()).toBe(false);
        expect(graphLevel(1)).toBe(1);
        expect(graphLevel(2)).toBe(1);
    });
});

describe('cost on the Chat render path', () => {
    // The host is an unmemoized child of Chat, which re-renders on every
    // voice-user bump. A re-render that changes nothing must do no work: the
    // plan reads localStorage (mutes, volumes, settings) and every other input
    // has its own subscription. Before: a dep-less layout effect re-ran
    // adopt()+reconcile() on EVERY render, watched streams or not.
    async function rerenderReads(): Promise<number> {
        const reads = vi.spyOn(localStorage, 'getItem');
        reads.mockClear();
        for (let i = 0; i < 3; i++) {
            await act(async () => { root.render(<StreamAudioHost />); });
        }
        const n = reads.mock.calls.length;
        reads.mockRestore();
        return n;
    }

    it('with streams watched, a parent re-render that changes nothing reads no storage', async () => {
        await renderHost();
        expect(audioFor(1)).not.toBeNull(); // positive control: there is work it COULD redo
        expect(await rerenderReads()).toBe(0);
    });

    it('with nothing watched, a parent re-render reads no storage either', async () => {
        selected = [];
        await renderHost();
        expect(await rerenderReads()).toBe(0);
    });

    it('…and still picks up a newly watched stream (the element set is what re-adopts)', async () => {
        selected = [];
        await renderHost();
        await act(async () => { selected = [1]; notify(); await flushMicrotasks(); });
        expect(tracksOf(audioFor(1))).toEqual(['a-1']);
        expect(graphLevel(1)).toBe(1);
    });

});

describe('per-stream level and mute, and the master Output Volume', () => {
    it('a stream muted on the stage stays muted here; the other plays', async () => {
        setStreamMuted(2, true);
        await renderHost();
        expect(graphLevel(1)).toBe(1);
        expect(graphLevel(2)).toBe(0);
    });

    it('each stream at its OWN level on the loudness curve, times the master, a boost included (no cap on the graph)', async () => {
        master(50);
        setStreamVolume(1, 30);
        setStreamVolume(2, 150);
        await renderHost();
        expect(graphLevel(1)).toBeCloseTo(loud(30) * 0.5, 9); // 0.09 x 0.5
        expect(graphLevel(2)).toBeCloseTo(loud(150) * 0.5, 9); // sqrt(2) x 0.5
        await act(async () => { master(100); await flushMicrotasks(); });
        expect(graphLevel(2), 'a boost above 100% is heard here now').toBeCloseTo(Math.SQRT2, 9);
        expect(graphLevel(1)).toBeCloseTo(0.09, 9);
    });

    it('one stream’s level changing never moves another’s (A 30% and B 150%, then A moves)', async () => {
        setStreamVolume(1, 30);
        setStreamVolume(2, 150);
        await renderHost();
        const g2 = fakeAudio.hostGainFor('a-2')!;
        const before = g2.gain.sent.length;
        // A changes (as the stage would write it), and a pass runs.
        setStreamVolume(1, 80);
        await act(async () => { notify(); await flushMicrotasks(); });
        expect(graphLevel(1)).toBeCloseTo(loud(80), 9);
        expect(graphLevel(2)).toBeCloseTo(loud(150), 9);
        expect(g2.gain.sent.slice(before), 'B’s gain was sent nothing at all').toEqual([]);
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
        expect(graphLevel(1)).toBeCloseTo(loud(40), 9);
        expect(graphLevel(2)).toBe(0);
    });
});

describe('Stream Attenuation is the big stream view’s alone (the owner: "Big view only, as before")', () => {
    it('the small player stays at its level while someone talks: talking sends its gains nothing', async () => {
        setAttenuation({ enabled: true, strength: 0.5 });
        setStreamVolume(1, 100); // its own, or it would be seeded with the last level (150)
        setStreamVolume(2, 150);
        await renderHost();
        const g1 = fakeAudio.hostGainFor('a-1')!;
        const g2 = fakeAudio.hostGainFor('a-2')!;
        const sent = [g1.gain.sent.length, g2.gain.sent.length];
        act(() => { speak(true); });
        expect(graphLevel(1)).toBe(1);
        expect(graphLevel(2)).toBeCloseTo(loud(150), 9);
        act(() => { speak(false); });
        expect(g1.gain.sent.slice(sent[0])).toEqual([]);
        expect(g2.gain.sent.slice(sent[1])).toEqual([]);
    });

    it('the stage still ducks by its strength while someone talks, and ramps — never jumps — even at Strength 100%', async () => {
        setAttenuation({ enabled: true, strength: 1 });
        selected = [1];
        await act(async () => { root.render(<StreamStage onBackToChat={() => {}} />); });
        await act(async () => { await flushMicrotasks(); });
        const g = fakeAudio.gainsOf('stage')[0];
        expect(g.gain.effective).toBe(1); // positive control: playing at its level
        const before = g.gain.events.length;
        act(() => { speak(true); });
        expect(g.gain.effective).toBe(0);
        act(() => { speak(false); });
        expect(g.gain.effective).toBe(1);
        expect(g.gain.events.slice(before).map(e => e.how), 'a jump clicks on every word').toEqual(['ramp', 'ramp']);
    });

    it('…while the stage’s claim on the small player is still silence at once, never a ramp', async () => {
        await renderHost();
        const g = fakeAudio.hostGainFor('a-1')!;
        const before = g.gain.events.length;
        const release = claimStageAudio();
        expect(g.gain.events.slice(before)).toEqual([{ how: 'set', to: 0 }]);
        await act(async () => { release(); await flushMicrotasks(); });
    });
});

describe('Firefox and Safari: a context cannot follow the chosen Output Device', () => {
    // An <audio> can be routed there (setSinkId, Firefox 116+, Safari 18.4+),
    // an AudioContext cannot: a graph would play on the OS default while the
    // correctly routed element sat muted.
    beforeEach(() => { fakeAudio.contextSinkId = false; });

    it('with a device chosen, every stream plays through its own routed <audio>, and nothing through the graph', async () => {
        choose('headset-1');
        await renderHost();
        const s1 = elementSinks.sinkOf(audioFor(1)!);
        const s2 = elementSinks.sinkOf(audioFor(2)!);
        expect(s1.calls).toEqual(['headset-1']);
        await act(async () => { await s1.settle(); await s2.settle(); });
        expect(s1.sinkId).toBe('headset-1');
        expect(audioFor(1)!.muted).toBe(false);
        expect(audioFor(2)!.muted).toBe(false);
        const sounding = fakeAudio.gainsOf('host').filter(g => !g.disconnected && g.speakersAt !== null && g.gain.effective > 0);
        expect(sounding, 'a graph on the OS default').toEqual([]);
    });

    it('on the default device the graph plays (there is no device to follow)', async () => {
        await renderHost();
        expect(graphLevel(1)).toBe(1);
        expect(audioFor(1)!.muted).toBe(true);
    });

    it('choosing a device moves the streams onto their elements, and the default moves them back', async () => {
        await renderHost();
        expect(graphLevel(1)).toBe(1);
        act(() => { choose('headset-1'); });
        await act(async () => {
            await elementSinks.sinkOf(audioFor(1)!).settle();
            await elementSinks.sinkOf(audioFor(2)!).settle();
        });
        expect(graphLevel(1)).toBe(0);
        expect(audioFor(1)!.muted).toBe(false);
        act(() => { choose(''); });
        await act(async () => {
            await elementSinks.sinkOf(audioFor(1)!).settle();
            await flushMicrotasks();
        });
        expect(graphLevel(1)).toBe(1);
        expect(audioFor(1)!.muted).toBe(true);
    });
});

describe('the element fallback: where Web Audio cannot play, the <audio> plays it as it always did', () => {
    it('no Web Audio at all: unmuted once routed, at min(level x master, 1), every stream its own element', async () => {
        fakeAudio.unavailable = true;
        master(50);
        setStreamVolume(1, 100); // its own, or it would be seeded with the last level (150)
        setStreamVolume(2, 150);
        await renderHost();
        expect(fakeAudio.contexts).toHaveLength(0);
        expect(audioFor(1)!.muted).toBe(false);
        expect(audioFor(2)!.muted).toBe(false);
        expect(audioFor(1)!.volume).toBeCloseTo(0.5, 9); // 100% x 50%
        expect(audioFor(2)!.volume).toBeCloseTo(Math.min(loud(150) * 0.5, 1), 9);
        await act(async () => { master(100); await flushMicrotasks(); });
        expect(audioFor(2)!.volume).toBe(1); // an element cannot boost
        // The stage's claim and a mute silence it as before.
        const release = claimStageAudio();
        expect(audioFor(1)!.muted).toBe(true);
        await act(async () => { release(); await flushMicrotasks(); });
        expect(audioFor(1)!.muted).toBe(false);
    });

    it('a context the autoplay policy holds suspended: the elements play meanwhile (no silence), and a gesture moves them onto the graph', async () => {
        fakeAudio.bornIn = 'suspended';
        await renderHost();
        const ctx = fakeAudio.liveOf('host')!;
        expect(ctx.state).toBe('suspended');
        expect(audioFor(1)!.muted, 'the element carries it while Web Audio cannot').toBe(false);
        expect(graphLevel(1) ?? 0).toBe(0);
        // A tap: the host's pass asks the context to resume (it was asked
        // already on the first pass; a gesture is where it is allowed).
        const before = ctx.resumes;
        await act(async () => { document.dispatchEvent(new Event('pointerdown')); await flushMicrotasks(); });
        expect(ctx.resumes).toBeGreaterThan(before);
        await act(async () => { ctx.become('running'); await flushMicrotasks(); });
        expect(graphLevel(1)).toBe(1);
        expect(audioFor(1)!.muted, 'and the element is the sink again').toBe(true);
    });

    it("Safari's 'interrupted' (a phone call on an iPhone): the element carries it, and the next tap resumes the context", async () => {
        await renderHost();
        const ctx = fakeAudio.liveOf('host')!;
        expect(graphLevel(1)).toBe(1);
        await act(async () => { ctx.become('interrupted' as AudioContextState); await flushMicrotasks(); });
        expect(graphLevel(1)).toBe(0);
        expect(audioFor(1)!.muted).toBe(false);
        const before = ctx.resumes;
        await act(async () => { document.dispatchEvent(new Event('pointerdown')); await flushMicrotasks(); });
        expect(ctx.resumes, 'an interrupted context is asked to resume, not left').toBeGreaterThan(before);
        await act(async () => { ctx.become('running'); await flushMicrotasks(); });
        expect(graphLevel(1)).toBe(1);
        expect(audioFor(1)!.muted).toBe(true);
    });

    it('a context closed from outside is replaced, and no stream is left on its dead nodes', async () => {
        await renderHost();
        const first = fakeAudio.liveOf('host')!;
        const dead = fakeAudio.hostGainFor('a-1')!;
        await act(async () => { first.become('closed'); await flushMicrotasks(); });
        const second = fakeAudio.liveOf('host');
        expect(second, 'a new context').not.toBeNull();
        expect(second).not.toBe(first);
        const now = fakeAudio.hostGainFor('a-1')!;
        expect(now.ctx, 'stream 1 is on the NEW context').toBe(second);
        expect(now.gain.effective).toBe(1);
        expect(dead.disconnected).toBe(true);
    });

    it('a context that could not be made is tried again the next time you watch (a refusal can be passing)', async () => {
        fakeAudio.unavailable = true;
        selected = [1];
        await renderHost();
        expect(audioFor(1)!.muted).toBe(false); // the element carries it
        await act(async () => { selected = []; notify(); await flushMicrotasks(); });
        fakeAudio.unavailable = false;
        await act(async () => { selected = [1]; notify(); await flushMicrotasks(); });
        expect(graphLevel(1)).toBe(1);
        expect(audioFor(1)!.muted).toBe(true);
    });

    it('a stream whose tracks Web Audio cannot read plays through its element; the others stay on the graph', async () => {
        await renderHost();
        fakeAudio.sourcesFail = true;
        share(3);
        await act(async () => { selected = [1, 2, 3]; notify(); await flushMicrotasks(); });
        expect(graphLevel(1)).toBe(1);
        expect(audioFor(3)!.muted).toBe(false);
        expect(audioFor(1)!.muted).toBe(true);
    });
});

describe('an iPhone or iPad: a page cannot set an element’s volume', () => {
    const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume')!;
    /** Every volume the page asked an element for (iOS takes none of them). */
    let asked: number[] = [];
    beforeEach(() => {
        asked = [];
        Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
            configurable: true, get: () => 1, set: (v: number) => { asked.push(v); /* iOS ignores it */ },
        });
    });
    afterEach(() => { Object.defineProperty(HTMLMediaElement.prototype, 'volume', real); });

    it('the level still applies, because the graph carries it (the element volume is never what sounds)', async () => {
        master(50);
        setStreamVolume(1, 40);
        await renderHost();
        expect(graphLevel(1)).toBeCloseTo(loud(40) * 0.5, 9);
    });

    it('NEGATIVE CONTROL: under the same override the element path LOSES the level — the graph is what keeps it', async () => {
        fakeAudio.unavailable = true;
        master(50);
        setStreamVolume(1, 40);
        await renderHost();
        expect(audioFor(1)!.muted).toBe(false); // the element is what plays here
        // The engine DID ask the element for the level (40% on the curve x
        // 50% = 0.08): a fallback that stopped setting it fails here...
        expect(asked.some(v => Math.abs(v - loud(40) * 0.5) < 1e-9), `asked for ${JSON.stringify(asked)}`).toBe(true);
        // ...and the element plays at 1 regardless: the level is lost there.
        expect(audioFor(1)!.volume).toBe(1);
    });
});

describe('the stage resumes an interrupted context too', () => {
    it("at the next gesture, Safari's 'interrupted' as well as 'suspended'", async () => {
        await act(async () => { root.render(<StreamStage onBackToChat={() => {}} />); });
        await act(async () => { await flushMicrotasks(); });
        const ctx = fakeAudio.liveOf('stage')!;
        expect(ctx, 'positive control: the stage built its graph').not.toBeNull();
        ctx.state = 'interrupted' as AudioContextState;
        const before = ctx.resumes;
        await act(async () => { document.dispatchEvent(new Event('pointerdown')); await flushMicrotasks(); });
        expect(ctx.resumes).toBe(before + 1);
    });
});

describe('Output Device: nothing sounds before it is on the chosen device', () => {
    it('the context is routed first, and a stream’s gain joins the speakers only once it is there', async () => {
        choose('headset-1');
        await renderHost();
        const ctx = fakeAudio.liveOf('host')!;
        expect(ctx.calls).toEqual(['headset-1']);
        expect(fakeAudio.hostGainFor('a-1'), 'no graph before the switch lands').toBeNull();
        // The elements wait for their own routing too: silent either way.
        expect(audioFor(1)!.muted).toBe(true);
        await act(async () => { await ctx.settle(); });
        expect(fakeAudio.hostGainFor('a-1')!.speakersAt).toBe('headset-1');
        expect(graphLevel(1)).toBe(1);
    });

    it('follows a Settings change (the context and the elements)', async () => {
        choose('headset-1');
        await renderHost();
        const ctx = fakeAudio.liveOf('host')!;
        await act(async () => { await ctx.settle(); });
        const s1 = elementSinks.sinkOf(audioFor(1)!);
        await act(async () => { await s1.settle(); });
        act(() => { choose('speakers-2'); });
        await act(async () => { await ctx.settle(); await s1.settle(); });
        expect(ctx.sinkId).toBe('speakers-2');
        expect(s1.sinkId).toBe('speakers-2');
    });

    it('on the default device it plays at once, with no routing call', async () => {
        await renderHost();
        expect(elementSinks.sinkOf(audioFor(1)!).calls).toEqual([]);
        expect(fakeAudio.liveOf('host')!.calls).toEqual([]);
        expect(graphLevel(1)).toBe(1);
    });

    describe('…and in the element fallback, each element is held muted until ITS switch lands', () => {
        beforeEach(() => { fakeAudio.unavailable = true; });

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

        it('chases a chosen device that was missing and comes back (devicechange)', async () => {
            fakeAudio.devices.delete('headset-1');
            choose('headset-1');
            await renderHost();
            const s1 = elementSinks.sinkOf(audioFor(1)!);
            await act(async () => { await s1.settle(); });
            expect(s1.sinkId).toBe(''); // fell back: still audible
            expect(audioFor(1)!.muted).toBe(false);
            fakeAudio.devices.add('headset-1');
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
    });
});
