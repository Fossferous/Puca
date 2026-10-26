/**
 * A stream's volume belongs to the PERSON sharing it, and every watched
 * stream has its own: its own menu and slider on the stage, its own gain
 * there and in the small player over chat.
 *
 * The owner, 2026-10-26:
 *  - "Audio level should save between viewing streams" — the level set for
 *    someone's stream is remembered on this device under their user id and
 *    used for every stream of theirs you watch: after you stop and watch
 *    again, while you switch between streams, for a new share of theirs, in
 *    the small player and back on the stage, in a later session;
 *  - "Per person, new = my last level" — someone you have never set starts
 *    at the LAST level you set on anyone (100% before you have set any). That
 *    seeds their first level once; it never links two people afterwards;
 *  - "make sure if watching multiple streams you can still adjust each
 *    volume separate of each other".
 *
 * Read against the code before these changes, the first list already held
 * (those tests pass there too): the level lived in localStorage under the
 * streamer's user id and was read on every stage mount and by the host. The
 * small player then capped a boost at 100%; it now plays it.
 *
 * Asserted as gain values and element volumes, never as sound.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushMicrotasks, memoryLocalStorage } from './fixtures/fakeSink';
import { FakeStreamAudioContext, fakeAudio, resetFakeStreamAudio } from './fixtures/fakeStreamAudio';

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

/** A share from user `id`: a picture and its sound (a NEW track per share). */
function share(id: number, audioTrack = `a-${id}`): void {
    const s = new MediaStream();
    s.addTrack({ kind: 'video', id: `v-${id}` } as MediaStreamTrack);
    s.addTrack({ kind: 'audio', id: audioTrack } as MediaStreamTrack);
    STREAMS.set(id, { username: `user-${id}`, stream: s });
}
const ALICE = 1;
const BOB = 2;
const CAROL = 3;
/** Output Volume 50%, so every expected gain is curve(level) x 0.5. */
const MASTER = 0.5;
/** The loudness curve, stated independently of the code under test. */
const loud = (p: number) => (p <= 100 ? (p / 100) ** 2 : 2 ** ((p - 100) / 100));
const at = (percent: number) => loud(percent) * MASTER;

/** The stage's gains, in the order its graphs were built (tile order). */
const stageGains = () => fakeAudio.gainsOf('stage').filter(g => !g.disconnected);
const newestStageGain = () => fakeAudio.gainsOf('stage').at(-1)?.gain.effective;
/** What the small player sends stream `id` to the speakers at. */
const smallPlayer = (id: number, track = `a-${id}`) => fakeAudio.hostGainFor(track)?.gain.effective;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    resetFakeStreamAudio();
    vi.stubGlobal('AudioContext', FakeStreamAudioContext);
    useStreamStore.getState().clearAllStreams();
    STREAMS.clear();
    share(ALICE);
    share(BOB);
    share(CAROL);
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
/** The stage and the small player's audio, as Chat mounts them. */
function Chat({ stage }: { stage: boolean }) {
    return <>{stage && <StreamStage onBackToChat={() => {}} />}<StreamAudioHost /></>;
}
async function renderChat(stage: boolean) {
    await act(async () => { root.render(<Chat stage={stage} />); await flushMicrotasks(); });
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
function closeMenu() {
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
}
/** The level `id`'s own slider shows. */
function shownFor(id: number): string {
    openMenu(id);
    const v = slider().value;
    closeMenu();
    return v;
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
    closeMenu();
}
const record = () => JSON.parse(localStorage.getItem('sovereign_stream_levels') ?? 'null');

describe("a stream's volume is the person's, remembered on this device", () => {
    it('stop watching and watch again: the stage comes back at that level', () => {
        renderStage();
        setLevel(ALICE, 30);
        expect(newestStageGain()).toBeCloseTo(at(30), 9);

        leaveStage();
        renderStage();
        expect(newestStageGain(), 'watched again').toBeCloseTo(at(30), 9);
        expect(shownFor(ALICE)).toBe('30');
    });

    it('it is stored under the user id, with the last level set beside it', () => {
        renderStage();
        setLevel(ALICE, 30);
        expect(record()).toEqual({ levels: { [ALICE]: 30 }, last: 30 });
    });

    it('a NEW share from the same person plays at their level (it is not kept per share)', async () => {
        renderStage();
        setLevel(ALICE, 30);
        await watch([]); // her share ends
        share(ALICE, 'a-1-next-share');
        await watch([ALICE]);
        expect(newestStageGain(), 'her next share').toBeCloseTo(at(30), 9);
    });

    it('switching streams: one you stop and watch again comes back at its level while the other plays on', async () => {
        await watch([ALICE, BOB]);
        renderStage();
        setLevel(ALICE, 30);
        await watch([BOB]); // Alice's tile closed: her graph goes
        await watch([BOB, ALICE]);
        expect(newestStageGain(), 'Alice, watched again').toBeCloseTo(at(30), 9);
        expect(stageGains()[0].gain.effective, 'Bob, untouched').toBeCloseTo(at(100), 9);
    });

    it('a later session (a reload, a restart) starts at the level an earlier one left on this device', () => {
        localStorage.setItem('sovereign_stream_levels', JSON.stringify({ levels: { [ALICE]: 30 }, last: 30 }));
        renderStage();
        expect(newestStageGain()).toBeCloseTo(at(30), 9);
        expect(shownFor(ALICE)).toBe('30');
    });
});

describe('someone you have never set starts at the last level you set (seeded once, then theirs)', () => {
    it('before you have set anyone, a new person starts at 100%', () => {
        renderStage();
        expect(newestStageGain()).toBeCloseTo(at(100), 9);
        expect(shownFor(ALICE)).toBe('100');
    });

    it('a new person picks up the last level set on anyone', async () => {
        renderStage();
        setLevel(ALICE, 40);
        await watch([ALICE, CAROL]); // Carol, never set, starts watching
        expect(newestStageGain(), 'Carol').toBeCloseTo(at(40), 9);
        expect(shownFor(CAROL)).toBe('40');
    });

    it('seeded once: setting someone else later never moves them, now or in a later session', async () => {
        renderStage();
        setLevel(ALICE, 40);
        await watch([ALICE, CAROL]); // Carol seeded at 40
        setLevel(ALICE, 90); // the last level moves on
        expect(stageGains()[1].gain.effective, 'Carol, while watched').toBeCloseTo(at(40), 9);
        expect(shownFor(CAROL)).toBe('40');
        leaveStage();
        renderStage(); // a later session
        await watch([CAROL]);
        expect(newestStageGain(), 'Carol, next time').toBeCloseTo(at(40), 9);
        expect(record().levels).toEqual({ [ALICE]: 90, [CAROL]: 40 });
    });

    it('a person you adjust keeps theirs, whatever the last level does', async () => {
        renderStage();
        setLevel(ALICE, 25);
        await watch([ALICE, BOB]);
        setLevel(BOB, 160); // the last level is now 160
        expect(stageGains()[0].gain.effective, 'Alice').toBeCloseTo(at(25), 9);
        expect(record()).toEqual({ levels: { [ALICE]: 25, [BOB]: 160 }, last: 160 });
    });

    it('the last level survives a reload: a new person in a later session starts there', () => {
        localStorage.setItem('sovereign_stream_levels', JSON.stringify({ levels: { [BOB]: 70 }, last: 70 }));
        renderStage(); // Alice: never set
        expect(newestStageGain()).toBeCloseTo(at(70), 9);
        expect(record().levels[ALICE]).toBe(70);
    });

    it('mute stays per person: a new person is never seeded muted', async () => {
        localStorage.setItem('sovereign_stream_mutes', JSON.stringify({ [ALICE]: true }));
        await watch([ALICE, CAROL]);
        renderStage();
        expect(stageGains()[0].gain.effective, 'Alice, muted').toBe(0);
        expect(stageGains()[1].gain.effective, 'Carol').toBeGreaterThan(0);
    });
});

describe('two streams watched at once: each its own control, its own gain, everywhere', () => {
    it('A at 30% and B at 150%: own gains on the stage and in the small player; moving A leaves B alone; a third, new person starts at the last level set', async () => {
        // Output Volume 100%, so B's boost is above what an element could play.
        saveSettings({ ...loadSettings(), outputVolume: 100 });
        await watch([ALICE, BOB]);
        await renderChat(true);
        setLevel(ALICE, 30);
        setLevel(BOB, 150);
        // On the stage: one gain node per stream, each at its own level.
        const [gA, gB] = stageGains();
        expect(gA).not.toBe(gB);
        expect(gA.gain.effective).toBeCloseTo(loud(30), 9);
        expect(gB.gain.effective).toBeCloseTo(loud(150), 9);
        // Each has its own slider, at its own level.
        expect(shownFor(ALICE)).toBe('30');
        expect(shownFor(BOB)).toBe('150');

        // Moving A never moves B: nothing B's gain is sent is anything but B's level.
        const sentToB = gB.gain.sent.length;
        setLevel(ALICE, 60);
        expect(gA.gain.effective).toBeCloseTo(loud(60), 9);
        expect(gB.gain.sent.slice(sentToB).filter(v => Math.abs(v - loud(150)) > 1e-9), 'B moved').toEqual([]);
        expect(gB.gain.effective).toBeCloseTo(loud(150), 9);
        expect(shownFor(BOB)).toBe('150');

        // In the small player over chat: the same two levels, two gains.
        await renderChat(false);
        expect(fakeAudio.hostGainFor('a-1')).not.toBe(fakeAudio.hostGainFor('a-2'));
        expect(smallPlayer(ALICE)).toBeCloseTo(loud(60), 9);
        expect(smallPlayer(BOB), 'a boost, above 100% and not capped').toBeCloseTo(loud(150), 9);
        expect(smallPlayer(BOB)!).toBeGreaterThan(1);

        // A third person, never set, starts at the LAST level set (A's 60).
        await watch([ALICE, BOB, CAROL]);
        expect(smallPlayer(CAROL)).toBeCloseTo(loud(60), 9);
        expect(smallPlayer(BOB)).toBeCloseTo(loud(150), 9);
        expect(smallPlayer(ALICE)).toBeCloseTo(loud(60), 9);

        // And back on the stage, all three at their own levels.
        await renderChat(true);
        const levels = stageGains().map(g => g.gain.effective);
        expect(levels[0]).toBeCloseTo(loud(60), 9);
        expect(levels[1]).toBeCloseTo(loud(150), 9);
        expect(levels[2]).toBeCloseTo(loud(60), 9);
    });

    it('in focus view, a filmstrip thumbnail has its own menu and slider too', async () => {
        await watch([ALICE, BOB]);
        renderStage();
        act(() => { useStreamStore.getState().setFocusedStream(ALICE); });
        expect(container.querySelector('.stream-tile.is-thumb')).not.toBeNull(); // Bob, as a thumbnail
        setLevel(BOB, 45);
        expect(stageGains()[1].gain.effective).toBeCloseTo(at(45), 9);
        expect(stageGains()[0].gain.effective).toBeCloseTo(at(100), 9);
    });
});
