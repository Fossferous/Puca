/**
 * The Stream Volume slider (in the menu a right-click on a stream opens on
 * the stage) moves 1% at a time and shows its level.
 *
 * The owner, 2026-10-26: "Stream volume slider should have smoother
 * increments." It had step 5 over 0-200% and no number anywhere, and a
 * native range's Page Up / Page Down moves a tenth of its RANGE (20% here,
 * measured in Chromium and Firefox). Now: step 1; with the slider focused
 * the arrows move it 1%, Page Up / Page Down 10% and Home / End to the ends;
 * the level is shown beside the label as it moves; and every step reaches
 * the gain (times Output Volume) and the per-person store.
 *
 * Driven through the real StreamStage only (no new export is imported), so
 * on the old code these fail on what the slider does, not on a missing name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { memoryLocalStorage } from './fixtures/fakeSink';

const STREAMS = new Map<number, { username: string; stream: MediaStream }>();
let selected: number[] = [];
const subscribers = new Set<() => void>();

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
import { getStreamVolumes, setStreamVolume } from '../components/streamVolumeStore';

/** A GainNode's AudioParam that remembers the last value it was sent. */
class RecordingParam {
    sent: number[] = [];
    private v = 1;
    get value() { return this.v; }
    set value(x: number) { this.v = x; this.sent.push(x); }
    setTargetAtTime(target: number) { this.sent.push(target); }
    get effective() { return this.sent[this.sent.length - 1]; }
}
let gains: RecordingParam[] = [];
let webAudioBroken = false;

class FakeContext {
    state: AudioContextState = 'running';
    currentTime = 0;
    destination = {};
    resume = async () => {};
    close = async () => { this.state = 'closed'; };
    createMediaStreamSource() {
        if (webAudioBroken) throw new Error('no Web Audio here');
        return { connect: () => {}, disconnect: () => {} };
    }
    createGain() {
        const gain = new RecordingParam();
        gains.push(gain);
        return { gain, connect: () => {}, disconnect: () => {} };
    }
}

function share(id: number): void {
    const s = new MediaStream();
    s.addTrack({ kind: 'video', id: `v-${id}` } as MediaStreamTrack);
    s.addTrack({ kind: 'audio', id: `a-${id}` } as MediaStreamTrack);
    STREAMS.set(id, { username: `user-${id}`, stream: s });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    vi.stubGlobal('AudioContext', FakeContext);
    gains = [];
    webAudioBroken = false;
    useStreamStore.getState().clearAllStreams();
    STREAMS.clear();
    share(1);
    selected = [1];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    saveSettings({ ...loadSettings(), outputVolume: 50 });
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

function renderStage() {
    act(() => { root.render(<StreamStage onBackToChat={() => {}} />); });
}
function openMenu() {
    const tile = container.querySelector('.stream-tile')!;
    act(() => { tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
}
/** The Stream Volume slider: the first slider in the menu. */
function slider(): HTMLInputElement {
    const range = container.querySelector<HTMLInputElement>('.scm-slider-block input[type="range"]');
    expect(range, 'the stream volume slider is not there').not.toBeNull();
    return range!;
}
/** The level shown beside the slider's label. */
function shown(): string | null {
    return container.querySelector('.scm-slider-block .scm-value')?.textContent ?? null;
}
function slide(to: number) {
    const range = slider();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(range, String(to));
        range.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
/** Press a key on the focused slider; true when its default was prevented. */
function press(key: string, mods: KeyboardEventInit = {}): boolean {
    const range = slider();
    range.focus();
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
    act(() => { range.dispatchEvent(ev); });
    return ev.defaultPrevented;
}
/** The level the slider, the label, the store and the gain all agree on. */
function expectLevel(level: number) {
    expect(slider().value, 'the slider').toBe(String(level));
    expect(shown(), 'the level shown').toBe(`${level}%`);
    expect(getStreamVolumes()[1], 'the level remembered for this person').toBe(level);
    expect(gains[0].effective, 'the gain (level x Output Volume 50%)').toBeCloseTo((level / 100) * 0.5, 9);
}

describe('Stream Volume: 1% steps, and its level on show', () => {
    it('moves in 1% steps over 0-200%', () => {
        renderStage();
        openMenu();
        expect(slider().step).toBe('1');
        expect(slider().min).toBe('0');
        expect(slider().max).toBe('200');
    });

    it('shows the level beside its label, and the shown level follows the slider', () => {
        renderStage();
        openMenu();
        expect(shown()).toBe('100%'); // someone never set starts at 100%
        slide(37);
        expect(shown()).toBe('37%');
        expect(slider().getAttribute('aria-valuetext')).toBe('37%');
        slide(143);
        expect(shown()).toBe('143%');
    });

    it('opens on the level remembered for that person', () => {
        setStreamVolume(1, 42);
        renderStage();
        openMenu();
        expect(slider().value).toBe('42');
        expect(shown()).toBe('42%');
    });
});

describe('Stream Volume from the keyboard', () => {
    it('the arrow keys move it 1%', () => {
        renderStage();
        openMenu();
        press('ArrowUp');
        expectLevel(101);
        press('ArrowRight');
        expectLevel(102);
        press('ArrowDown');
        press('ArrowDown');
        press('ArrowLeft');
        expectLevel(99);
    });

    it('Page Up / Page Down move it 10% (the browser alone moves a tenth of the range: 20%)', () => {
        renderStage();
        openMenu();
        expect(press('PageUp'), 'the browser would step it too').toBe(true);
        expectLevel(110);
        press('PageDown');
        press('PageDown');
        expectLevel(90);
    });

    it('Home and End go to the ends, and no key goes past them', () => {
        renderStage();
        openMenu();
        press('End');
        expectLevel(200);
        press('ArrowUp');
        press('PageUp');
        expectLevel(200);
        slide(5);
        press('PageDown');
        expectLevel(0);
        press('ArrowDown');
        expectLevel(0);
        press('End');
        press('Home');
        expectLevel(0);
    });

    it('a key held with Ctrl, Alt or Cmd, and any other key, is left alone', () => {
        renderStage();
        openMenu();
        slide(60);
        expect(press('PageUp', { ctrlKey: true })).toBe(false);
        expect(press('ArrowUp', { altKey: true })).toBe(false);
        expect(press('End', { metaKey: true })).toBe(false);
        expect(press('a')).toBe(false);
        expectLevel(60);
    });

    it('without Web Audio (the element fallback, which cannot boost) it stops at 100%', () => {
        webAudioBroken = true;
        setStreamVolume(1, 150);
        renderStage();
        openMenu();
        expect(slider().max).toBe('100');
        expect(shown()).toBe('100%');
        press('PageDown');
        expect(slider().value).toBe('90');
        expect(shown()).toBe('90%');
        press('End');
        expect(slider().value).toBe('100');
        expect(container.querySelector('video')!.volume).toBeCloseTo(0.5, 9); // 100% x Output Volume 50%
    });
});
