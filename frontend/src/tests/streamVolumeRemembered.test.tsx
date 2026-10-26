/**
 * A stream's volume belongs to the PERSON sharing it. The level set for
 * someone's stream is remembered on this device under their user id and is
 * the level of every stream of theirs you watch: after you stop and watch
 * again, while you switch between streams, for a new share of theirs, in the
 * small player over chat (StreamAudioHost) and back on the stage, and in a
 * later session. Someone you never set starts at 100%.
 *
 * The owner, 2026-10-26: "Audio level should save between viewing streams."
 * Read against the code that day, every path below already held — these
 * tests pass on the code from before the slider change too: the level lives
 * in localStorage under the streamer's user id (streamVolumeStore.ts), the
 * stage reads it on every mount and the host on every pass. Two things do
 * NOT carry over, by design: a level above 100% into the small player (an
 * element cannot boost; the boost is the stage graph's, pinned in
 * streamAudioHost.test.tsx), and Stream Attenuation, which ducks only on the
 * stage. These pin the rest so it stays that way.
 *
 * Asserted as gain values and element volumes, never as sound.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushMicrotasks, memoryLocalStorage } from './fixtures/fakeSink';

const STREAMS = new Map<number, { username: string; stream: MediaStream }>();
let selected: number[] = [];
const subscribers = new Set<() => void>();
const notify = () => { for (const cb of [...subscribers]) cb(); };

vi.mock('../components/voiceState', () => ({
    subscribeToStreamState: (cb: () => void) => { subscribers.add(cb); return () => { subscribers.delete(cb); }; },
    subscribeToVoiceUsers: () => () => {},
    subscribeToSpeaking: () => () => {},
    getSelectedStreams: () => [...selected],
    getStreamData: (id: number) => STREAMS.get(id) ?? null,
    getAllStreamers: () => [...STREAMS.entries()].map(([userId, d]) => ({ userId, ...d })),
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
vi.mock('../api/rtc/sfuManager', () => ({ sfuManager: { setFocusedRemote: () => {} } }));

import { StreamStage } from '../components/StreamStage';
import { StreamAudioHost } from '../components/StreamAudioHost';
import { useStreamStore } from '../stores/streamStore';
import { loadSettings, saveSettings } from '../components/settingsStore';
import { getStreamVolumes } from '../components/streamVolumeStore';

/** A GainNode's AudioParam that remembers the last value it was sent. */
class RecordingParam {
    sent: number[] = [];
    private v = 1;
    get value() { return this.v; }
    set value(x: number) { this.v = x; this.sent.push(x); }
    setTargetAtTime(target: number) { this.sent.push(target); }
    get effective() { return this.sent[this.sent.length - 1]; }
}
/** Every stage graph's gain, in the order the graphs were built. */
let gains: RecordingParam[] = [];

class FakeContext {
    state: AudioContextState = 'running';
    currentTime = 0;
    destination = {};
    resume = async () => {};
    close = async () => { this.state = 'closed'; };
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
    createGain() {
        const gain = new RecordingParam();
        gains.push(gain);
        return { gain, connect: () => {}, disconnect: () => {} };
    }
}

/** A share from user `id`: a picture and its sound (a NEW track per share). */
function share(id: number, audioTrack = `a-${id}`): void {
    const s = new MediaStream();
    s.addTrack({ kind: 'video', id: `v-${id}` } as MediaStreamTrack);
    s.addTrack({ kind: 'audio', id: audioTrack } as MediaStreamTrack);
    STREAMS.set(id, { username: `user-${id}`, stream: s });
}
const ALICE = 1;
const BOB = 2;
/** Output Volume 50%, so every expected gain is level x 0.5. */
const MASTER = 0.5;
const at = (percent: number) => (percent / 100) * MASTER;

/** The gain of the graph built most recently, and of the n-th one. */
const newestGain = () => gains[gains.length - 1]?.effective;
const gainNo = (n: number) => gains[n]?.effective;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    vi.stubGlobal('AudioContext', FakeContext);
    gains = [];
    useStreamStore.getState().clearAllStreams();
    STREAMS.clear();
    share(ALICE);
    share(BOB);
    selected = [ALICE];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    saveSettings({ ...loadSettings(), outputVolume: MASTER * 100 });
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

async function watch(ids: number[]) {
    await act(async () => { selected = ids; notify(); await flushMicrotasks(); });
}
function renderStage() {
    act(() => { root.render(<StreamStage onBackToChat={() => {}} />); });
}
/** Leave the stage entirely (Back to Chat, closing the last tile). */
function leaveStage() {
    act(() => root.unmount());
    root = createRoot(container);
}
/** Open the stream menu on `id`'s tile. */
function openMenu(id: number) {
    const tile = [...container.querySelectorAll('.stream-tile')]
        .find(t => t.querySelector('.streamer-name')?.textContent?.includes(`user-${id}`));
    expect(tile, `no tile for user ${id}`).toBeTruthy();
    act(() => { tile!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
}
function slider(): HTMLInputElement {
    const range = container.querySelector<HTMLInputElement>('.scm-slider-block input[type="range"]');
    expect(range, 'the stream volume slider is not there').not.toBeNull();
    return range!;
}
/** Set `id`'s Stream Volume the way a person does: their menu, the slider. */
function setLevel(id: number, percent: number) {
    openMenu(id);
    const range = slider();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(range, String(percent));
        range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); }); // close the menu
}

describe("a stream's volume is the person's, remembered on this device", () => {
    it('stop watching and watch again: the stage comes back at that level', () => {
        renderStage();
        setLevel(ALICE, 30);
        expect(newestGain()).toBeCloseTo(at(30), 9);

        leaveStage();
        gains = [];
        renderStage();
        expect(gains).toHaveLength(1);
        expect(newestGain(), 'watched again').toBeCloseTo(at(30), 9);
        openMenu(ALICE);
        expect(slider().value).toBe('30');
    });

    it('it is stored under the user id, and only for the person you set', () => {
        renderStage();
        setLevel(ALICE, 30);
        expect(JSON.parse(localStorage.getItem('sovereign_stream_volumes')!)).toEqual({ [ALICE]: 30 });
    });

    it('someone you never set starts at 100%, and setting them leaves the other alone', async () => {
        await watch([ALICE, BOB]);
        renderStage();
        setLevel(ALICE, 30);
        expect(gainNo(0), 'Alice').toBeCloseTo(at(30), 9);
        expect(gainNo(1), 'Bob, never set').toBeCloseTo(at(100), 9);
        openMenu(BOB);
        expect(slider().value).toBe('100');

        setLevel(BOB, 70);
        expect(gainNo(1), 'Bob').toBeCloseTo(at(70), 9);
        expect(gainNo(0), 'Alice is still hers').toBeCloseTo(at(30), 9);
        expect(getStreamVolumes()).toEqual({ [ALICE]: 30, [BOB]: 70 });
    });

    it('switching streams: one you stop and watch again comes back at its level while the other plays on', async () => {
        await watch([ALICE, BOB]);
        renderStage();
        setLevel(ALICE, 30);
        await watch([BOB]); // Alice's tile closed: her graph goes
        await watch([BOB, ALICE]);
        expect(gains).toHaveLength(3); // a new graph for Alice
        expect(newestGain(), 'Alice, watched again').toBeCloseTo(at(30), 9);
        expect(gainNo(1), 'Bob, untouched').toBeCloseTo(at(100), 9);
    });

    it('a NEW share from the same person plays at their level (it is not kept per share)', async () => {
        renderStage();
        setLevel(ALICE, 30);
        await watch([]); // her share ends
        share(ALICE, 'a-1-next-share');
        await watch([ALICE]);
        expect(newestGain(), 'her next share').toBeCloseTo(at(30), 9);
    });

    it('the small player over chat plays at the level set on the stage, and the stage picks it up again', async () => {
        const audio = () => container.querySelector<HTMLAudioElement>(`audio[data-stream-audio="${ALICE}"]`);
        function Chat({ stage }: { stage: boolean }) {
            return <>{stage && <StreamStage onBackToChat={() => {}} />}<StreamAudioHost /></>;
        }
        await act(async () => { root.render(<Chat stage />); await flushMicrotasks(); });
        setLevel(ALICE, 30);
        expect(audio()!.muted, 'silent beside the stage').toBe(true);

        await act(async () => { root.render(<Chat stage={false} />); await flushMicrotasks(); });
        expect(audio()!.muted).toBe(false);
        expect(audio()!.volume, 'the small player').toBeCloseTo(at(30), 9);

        gains = [];
        await act(async () => { root.render(<Chat stage />); await flushMicrotasks(); });
        expect(newestGain(), 'back on the stage').toBeCloseTo(at(30), 9);
    });

    it('a later session (a reload, a restart) starts at the level an earlier one left on this device', () => {
        // What the earlier session's slider wrote, as it wrote it.
        localStorage.setItem('sovereign_stream_volumes', JSON.stringify({ [ALICE]: 30 }));
        renderStage();
        expect(newestGain()).toBeCloseTo(at(30), 9);
        openMenu(ALICE);
        expect(slider().value).toBe('30');
    });
});
