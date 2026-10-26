/**
 * The touch volume button: on a touch screen each watched stream's tile has a
 * speaker that opens THAT stream's own Stream Volume and Mute.
 *
 * The owner, 2026-10-26: "Add a volume button." A touch screen (iPhone, iPad,
 * Android: a coarse pointer) has no right-click, so the stage's menu, the one
 * place a stream's volume could be set, was hard to reach there (a long press
 * at best, which not every browser turns into one). With a
 * mouse nothing changes (the one-click mute, the right-click menu); the
 * keyboard reaches the same panel from the tile.
 *
 * The panel writes the same per-person level as the menu (streamVolumeStore),
 * on the same loudness curve, in 1% steps. Geometry (44 px, inside the tile,
 * hit-testable) is the real browser's: e2e/stream-volume-button-real-browser.mjs.
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
import { useStreamStore } from '../stores/streamStore';
import { loadSettings, saveSettings } from '../components/settingsStore';
import { setStreamVolume } from '../components/streamVolumeStore';

const ALICE = 1;
const BOB = 2;
const MASTER = 0.5;
/** The loudness curve, stated independently of the code under test. */
const loud = (p: number) => (p <= 100 ? (p / 100) ** 2 : 2 ** ((p - 100) / 100));
const at = (p: number) => loud(p) * MASTER;

function share(id: number): void {
    const s = new MediaStream();
    s.addTrack({ kind: 'video', id: `v-${id}` } as MediaStreamTrack);
    s.addTrack({ kind: 'audio', id: `a-${id}` } as MediaStreamTrack);
    STREAMS.set(id, { username: `user-${id}`, stream: s });
}

/** A touch screen, or a mouse: what `(pointer: coarse)` answers. */
function pointer(coarse: boolean) {
    vi.stubGlobal('matchMedia', (q: string) => ({
        matches: coarse && q === '(pointer: coarse)',
        media: q,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
}

let container: HTMLDivElement;
let root: Root;
let plays = 0;
let pauses = 0;
let fullscreens = 0;

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    resetFakeStreamAudio();
    vi.stubGlobal('AudioContext', FakeStreamAudioContext);
    useStreamStore.getState().clearAllStreams();
    STREAMS.clear();
    share(ALICE);
    share(BOB);
    selected = [ALICE, BOB];
    plays = 0; pauses = 0; fullscreens = 0;
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => { plays++; return Promise.resolve(); });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => { pauses++; });
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true, writable: true, value: () => { fullscreens++; return Promise.resolve(); },
    });
    saveSettings({ ...loadSettings(), outputVolume: MASTER * 100 });
    pointer(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (Element.prototype as unknown as Record<string, unknown>).requestFullscreen;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function renderStage() {
    await act(async () => { root.render(<StreamStage onBackToChat={() => {}} />); });
    await act(async () => { await flushMicrotasks(); });
}
const tileOf = (id: number) => [...container.querySelectorAll<HTMLElement>('.stream-tile')]
    .find(t => t.querySelector('.streamer-name')?.textContent?.includes(`user-${id}`))!;
/** The touch speaker on `id`'s tile. */
const speakerOf = (id: number) => tileOf(id).querySelector<HTMLButtonElement>('.tile-vol:not(.tile-vol-kbd)');
const oneClickMuteOf = (id: number) => [...tileOf(id).querySelectorAll<HTMLButtonElement>('button')]
    .find(b => /^(Mute|Unmute) stream$/.test(b.title)) ?? null;
/** The panel is portaled to <body>. */
const panel = () => document.querySelector<HTMLElement>('.stream-volume-panel');
const panelRange = () => panel()!.querySelector<HTMLInputElement>('input[type="range"]')!;
const backdrop = () => document.querySelector<HTMLElement>('.stream-volume-backdrop');
/** The stage's gain for `id` (tile order: Alice's graph first). */
const stageGain = (id: number) => fakeAudio.gainsOf('stage').filter(g => !g.disconnected)[id === ALICE ? 0 : 1].gain.effective;

function open(id: number) {
    act(() => { speakerOf(id)!.click(); });
}
function slide(to: number) {
    const range = panelRange();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(range, String(to));
        range.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const levels = () => JSON.parse(localStorage.getItem('sovereign_stream_levels') ?? 'null')?.levels;

describe('on a touch screen every watched stream has its own speaker button', () => {
    it('one per tile, each its own stream, with no one-click mute beside it (the panel has Mute)', async () => {
        await renderStage();
        expect(speakerOf(ALICE), "Alice's").not.toBeNull();
        expect(speakerOf(BOB), "Bob's").not.toBeNull();
        expect(speakerOf(ALICE)).not.toBe(speakerOf(BOB));
        expect(speakerOf(ALICE)!.getAttribute('aria-label')).toBe('user-1: stream volume');
        expect(oneClickMuteOf(ALICE)).toBeNull();
        expect(tileOf(ALICE).querySelector('.tile-vol-kbd')).toBeNull();
    });

    it('with a mouse nothing changes: the one-click mute as before, and no touch button (only the keyboard’s, out of sight)', async () => {
        pointer(false);
        await renderStage();
        expect(speakerOf(ALICE)).toBeNull();
        expect(oneClickMuteOf(ALICE)).not.toBeNull();
        expect(tileOf(ALICE).querySelector('.tile-vol-kbd')).not.toBeNull();
    });
});

describe('it opens THAT stream’s own Stream Volume and Mute', () => {
    it('Bob’s button opens Bob’s panel at Bob’s level; moving it writes Bob’s level and gain, and only his', async () => {
        setStreamVolume(ALICE, 30);
        setStreamVolume(BOB, 150);
        await renderStage();
        open(BOB);
        expect(panel()).not.toBeNull();
        expect(panel()!.querySelector('.svp-name')!.textContent).toBe('user-2');
        expect(panelRange().value).toBe('150');
        expect(panelRange().step).toBe('1');
        const aliceBefore = stageGain(ALICE);
        slide(120);
        expect(levels()).toEqual({ [ALICE]: 30, [BOB]: 120 });
        expect(stageGain(BOB)).toBeCloseTo(at(120), 9);
        expect(stageGain(ALICE), 'Alice untouched').toBe(aliceBefore);
        expect(stageGain(ALICE)).toBeCloseTo(at(30), 9);
    });

    it('two tiles stay independent: Alice’s panel, then Bob’s, each writing its own person', async () => {
        await renderStage();
        open(ALICE);
        slide(40);
        open(BOB); // Alice's closes, Bob's opens
        expect(document.querySelectorAll('.stream-volume-panel')).toHaveLength(1);
        expect(panel()!.querySelector('.svp-name')!.textContent).toBe('user-2');
        expect(panelRange().value, 'Bob at his own level, not Alice’s 40').toBe('100');
        slide(70);
        expect(levels()).toEqual({ [ALICE]: 40, [BOB]: 70 });
        expect(stageGain(ALICE)).toBeCloseTo(at(40), 9);
        expect(stageGain(BOB)).toBeCloseTo(at(70), 9);
    });

    it('Mute there mutes that stream only, and says so', async () => {
        await renderStage();
        open(ALICE);
        const mute = panel()!.querySelector<HTMLButtonElement>('.svp-mute')!;
        expect(mute.getAttribute('aria-pressed')).toBe('false');
        act(() => { mute.click(); });
        expect(stageGain(ALICE)).toBe(0);
        expect(stageGain(BOB)).toBeGreaterThan(0);
        expect(JSON.parse(localStorage.getItem('sovereign_stream_mutes')!)).toEqual({ [ALICE]: true });
        expect(panel()!.querySelector('.svp-mute')!.getAttribute('aria-pressed')).toBe('true');
        expect(panelRange().disabled, 'muted: the slider waits, as in the menu').toBe(true);
    });

    it('the keys step 1% there too', async () => {
        await renderStage();
        open(ALICE);
        act(() => { panelRange().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
        act(() => { panelRange().dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true })); });
        expect(panelRange().value).toBe('111');
        expect(levels()[ALICE]).toBe(111);
    });
});

describe('opening and closing it changes nothing else', () => {
    it('no fullscreen, no tile brought to the stage, no play or pause', async () => {
        await renderStage();
        act(() => { useStreamStore.getState().setFocusedStream(ALICE); });
        const before = { plays, pauses, focused: useStreamStore.getState().focusedStreamId };
        open(BOB); // Bob is a filmstrip thumbnail here
        expect(panel()).not.toBeNull();
        act(() => { backdrop()!.click(); });
        expect(panel()).toBeNull();
        expect(fullscreens).toBe(0);
        expect(useStreamStore.getState().focusedStreamId, 'Bob was not brought to the stage').toBe(before.focused);
        expect(pauses).toBe(before.pauses);
        expect(plays).toBe(before.plays);
    });

    it('a tap on the backdrop, or in the panel, ends there: nothing around the stage sees it', async () => {
        // React events from a portal bubble to its React ancestors (the stage's
        // own tap handler is one): a parent's onClick sees any that leak.
        const onStage = vi.fn();
        await act(async () => { root.render(<div onClick={onStage}><StreamStage onBackToChat={() => {}} /></div>); });
        await act(async () => { await flushMicrotasks(); });
        open(ALICE);
        act(() => { panel()!.querySelector<HTMLButtonElement>('.svp-mute')!.click(); });
        act(() => { backdrop()!.click(); });
        expect(panel()).toBeNull();
        expect(onStage).not.toHaveBeenCalled();
    });
});

describe('the keyboard', () => {
    it('opening it puts the slider under the keyboard; Escape closes it and gives the keyboard back to its button', async () => {
        await renderStage();
        speakerOf(ALICE)!.focus();
        open(ALICE);
        expect(document.activeElement).toBe(panelRange());
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(panel()).toBeNull();
        expect(document.activeElement).toBe(speakerOf(ALICE));
    });

    it('with a mouse, the keyboard’s opener opens the same panel', async () => {
        pointer(false);
        await renderStage();
        const opener = tileOf(BOB).querySelector<HTMLButtonElement>('.tile-vol-kbd')!;
        act(() => { opener.click(); });
        expect(panel()!.querySelector('.svp-name')!.textContent).toBe('user-2');
    });
});

describe('it goes away when it should', () => {
    it('when its stream stops being watched', async () => {
        await renderStage();
        open(ALICE);
        await act(async () => { selected = [BOB]; notify(); await flushMicrotasks(); });
        expect(panel()).toBeNull();
    });

    it('the right-click menu and the panel are never open together', async () => {
        await renderStage();
        open(ALICE);
        act(() => { tileOf(BOB).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
        expect(panel()).toBeNull();
        expect(container.querySelector('.stream-context-menu')).not.toBeNull();
        open(ALICE);
        expect(container.querySelector('.stream-context-menu')).toBeNull();
        expect(panel()).not.toBeNull();
    });

    it('a second tap on the same button closes it', async () => {
        await renderStage();
        open(ALICE);
        open(ALICE);
        expect(panel()).toBeNull();
    });
});

describe('with a tile in element fullscreen (Android, an iPad, a desktop)', () => {
    // Only the element in fullscreen, and what is inside it, is painted: an
    // overlay anywhere else opens under the fullscreen layer, out of sight and
    // out of reach. Where it lands on screen is the real browser's
    // (e2e/stream-volume-button-real-browser.mjs); this is where it goes.
    let fsTarget: Element | null = null;
    function fullscreen(el: Element | null, prefixed = false) {
        fsTarget = el;
        Object.defineProperty(document, prefixed ? 'webkitFullscreenElement' : 'fullscreenElement', {
            configurable: true, get: () => fsTarget,
        });
        act(() => { document.dispatchEvent(new Event(prefixed ? 'webkitfullscreenchange' : 'fullscreenchange')); });
    }
    const menu = () => document.querySelector<HTMLElement>('.stream-context-menu');
    const rightClick = (id: number) => act(() => {
        tileOf(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    afterEach(() => {
        fsTarget = null;
        delete (document as unknown as Record<string, unknown>).fullscreenElement;
        delete (document as unknown as Record<string, unknown>).webkitFullscreenElement;
    });

    it('out of fullscreen the panel opens on <body>, as before (the control)', async () => {
        await renderStage();
        open(ALICE);
        expect(panel()!.parentElement).toBe(document.body);
        expect(tileOf(ALICE).contains(panel())).toBe(false);
    });

    it('the panel opens INSIDE the fullscreen tile, backdrop and all, and sets that stream', async () => {
        await renderStage();
        fullscreen(tileOf(ALICE));
        open(ALICE);
        expect(tileOf(ALICE).contains(panel()), 'inside the element in fullscreen').toBe(true);
        expect(tileOf(ALICE).contains(backdrop()), 'its backdrop too').toBe(true);
        slide(55);
        expect(levels()[ALICE]).toBe(55);
        expect(stageGain(ALICE)).toBeCloseTo(at(55), 9);
    });

    it('leaving fullscreen with it open closes it, so nothing is stranded in the tile; it opens again on <body>', async () => {
        await renderStage();
        fullscreen(tileOf(ALICE));
        open(ALICE);
        expect(document.activeElement, 'the slider has the keyboard').toBe(panelRange());
        fullscreen(null);
        expect(panel()).toBeNull();
        expect(backdrop()).toBeNull();
        // Escape there was the browser's (it left fullscreen): the keyboard
        // goes back to the button, as the panel's own Escape gives it.
        expect(document.activeElement).toBe(speakerOf(ALICE));
        open(ALICE);
        expect(panel()!.parentElement).toBe(document.body);
    });

    it('the prefixed API (an older iPad Safari) is followed too', async () => {
        await renderStage();
        fullscreen(tileOf(BOB), true);
        open(BOB);
        expect(tileOf(BOB).contains(panel())).toBe(true);
    });

    it('the right-click menu opens inside the fullscreen tile too, and goes when fullscreen ends', async () => {
        pointer(false);
        await renderStage();
        rightClick(ALICE);
        expect(menu()).not.toBeNull();
        expect(tileOf(ALICE).contains(menu()), 'out of fullscreen: in the stage, as before (the control)').toBe(false);
        fullscreen(tileOf(ALICE));
        expect(menu(), 'entering fullscreen closes one opened outside it').toBeNull();
        rightClick(ALICE);
        expect(tileOf(ALICE).contains(menu()), 'inside the element in fullscreen').toBe(true);
        fullscreen(null);
        expect(menu()).toBeNull();
    });
});
