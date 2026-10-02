/**
 * Watched-stream audio honours Settings > Output Volume, the master
 * multiplier (settingsStore's outputGain()), on every path.
 *
 * Found by reading code 2026-09-28. StreamStage's targetGain() included the
 * master, but the two handlers that react to the user did not re-derive it:
 *   - handleVolumeChange scheduled the gain toward (volume / 100) * duck, and
 *     the element-audio fallback set video.volume = volume / 100;
 *   - toggleMute scheduled an unmute toward vol * duck.
 * The next applyGain() — reached only because a state change happens to
 * re-run the bind effect — overwrote both, so the end state was right. The
 * gain was still aimed at the un-mastered level first: at 50% master, moving
 * the slider to 80% scheduled 0.8, not 0.4. Final-value assertions cannot
 * see that, so these record EVERY automation and element-volume write.
 *
 * StreamPip, the only stream audio path in chat view, never applied the
 * master at all, and never re-applied on a Settings change. That path is now
 * StreamAudioHost (2026-10-02: one element per watched stream; the float is
 * picture only), and the master rule moved with it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { memoryLocalStorage } from './fixtures/fakeSink';

const STREAMS = new Map<number, { username: string; stream: MediaStream }>();
let selected: number[] = [];
let streamers: { userId: number; username: string }[] = [];
const subscribers = new Set<() => void>();

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
vi.mock('../api/rtc/sfuManager', () => ({ sfuManager: { setFocusedRemote: () => {} } }));

import { StreamStage } from '../components/StreamStage';
import { StreamAudioHost } from '../components/StreamAudioHost';
import { useStreamStore } from '../stores/streamStore';
import { loadSettings, saveSettings } from '../components/settingsStore';
import { setStreamVolume } from '../components/streamVolumeStore';

/**
 * A GainNode's AudioParam that remembers every value it was sent, in order —
 * a setTargetAtTime's target or a direct `.value` write. Events in one task
 * share a currentTime, where the last one inserted wins, so `effective` is
 * the last entry.
 */
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

/** Every value written to an element's `volume`, per element. */
const volumeWrites = new WeakMap<HTMLMediaElement, number[]>();
const writesOf = (el: HTMLMediaElement) => volumeWrites.get(el) ?? [];

function streamWithAudio(trackId: string): MediaStream {
    const s = new MediaStream();
    s.addTrack({ kind: 'audio', id: trackId } as MediaStreamTrack);
    return s;
}
function master(outputVolume: number) {
    saveSettings({ ...loadSettings(), outputVolume });
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    vi.stubGlobal('AudioContext', FakeContext);
    gains = [];
    webAudioBroken = false;
    useStreamStore.getState().clearAllStreams();
    STREAMS.clear();
    STREAMS.set(1, { username: 'alice', stream: streamWithAudio('a-1') });
    selected = [1];
    streamers = [{ userId: 1, username: 'alice' }];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume')!;
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
        configurable: true,
        get(this: HTMLMediaElement) { return real.get!.call(this); },
        set(this: HTMLMediaElement, v: number) {
            volumeWrites.set(this, [...writesOf(this), v]);
            real.set!.call(this, v);
        },
    });
    master(50);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // Restore the real accessor after each test.
    return () => { Object.defineProperty(HTMLMediaElement.prototype, 'volume', real); };
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const video = () => container.querySelector('video')!;

function openMenu() {
    const tile = container.querySelector('.stream-tile')!;
    act(() => { tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
}
function slide(to: number) {
    const range = container.querySelector('.scm-slider-block input[type="range"]') as HTMLInputElement;
    expect(range, 'the stream volume slider is not there').not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(range, String(to));
        range.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const muteButton = () => container.querySelector('.stream-tile-controls .tile-btn') as HTMLButtonElement;

describe('StreamStage — the Web Audio path', () => {
    function renderStage() {
        act(() => { root.render(<StreamStage onBackToChat={() => {}} />); });
    }

    it('positive control: a watched stream starts at stream volume × master', async () => {
        renderStage();
        await act(async () => { await Promise.resolve(); });
        expect(gains).toHaveLength(1);
        expect(gains[0].effective).toBe(0.5); // 100% × 50%
    });

    it('the volume slider never aims the gain past the master', () => {
        renderStage();
        openMenu();
        const gain = gains[0];
        gain.sent = [];
        slide(80);
        expect(gain.sent.length, 'the slider sent the gain nothing').toBeGreaterThan(0);
        // Every value the gain was sent — not just where it ended up.
        expect(gain.sent.filter(v => !close(v, 0.4)), 'a value that ignores Output Volume').toEqual([]);
        expect(gain.effective).toBe(0.4);
    });

    it('unmuting returns to stream volume × master, never past it', () => {
        renderStage();
        const gain = gains[0];
        act(() => { muteButton().click(); });
        expect(gain.effective).toBe(0);
        gain.sent = [];
        act(() => { muteButton().click(); });
        expect(gain.sent.filter(v => !close(v, 0.5)), 'a value that ignores Output Volume').toEqual([]);
        expect(gain.effective).toBe(0.5);
    });

    it('a Settings change to Output Volume reaches the live gain', () => {
        renderStage();
        act(() => { master(20); });
        expect(gains[0].effective).toBeCloseTo(0.2, 9);
    });
});

describe('StreamStage — the element-audio fallback', () => {
    // With no Web Audio there are no graphs, and applyAllGains walked only
    // graphs: the <video> carrying the audio started at volume 1 and never
    // saw the master at all, not just while dragging.
    function renderFallback() {
        webAudioBroken = true;
        act(() => { root.render(<StreamStage onBackToChat={() => {}} />); });
        expect(video().muted, 'the fallback never engaged').toBe(false);
        return video();
    }

    it('starts at stream volume × master', () => {
        expect(renderFallback().volume).toBeCloseTo(0.5, 9);
    });

    it('follows a Settings change to Output Volume', () => {
        const el = renderFallback();
        act(() => { master(20); });
        expect(el.volume).toBeCloseTo(0.2, 9);
    });

    it('the volume slider never sets the element past the master', () => {
        const el = renderFallback();
        openMenu();
        volumeWrites.set(el, []);
        slide(80);
        expect(writesOf(el).length, 'the slider set no volume').toBeGreaterThan(0);
        expect(writesOf(el).filter(v => !close(v, 0.4)), 'a volume that ignores Output Volume').toEqual([]);
        expect(el.volume).toBeCloseTo(0.4, 9);
    });
});

describe('StreamAudioHost — the path everywhere the stage is not', () => {
    const audio = () => container.querySelector<HTMLAudioElement>('audio[data-stream-audio="1"]')!;
    async function renderHost() {
        await act(async () => { root.render(<StreamAudioHost />); });
        await act(async () => { await Promise.resolve(); });
    }

    it('plays at stream volume × master', async () => {
        await renderHost();
        expect(audio().volume).toBeCloseTo(0.5, 9); // 100% × 50%
    });

    it('a boosted stream is capped at full scale after the master is applied', async () => {
        setStreamVolume(1, 150);
        await renderHost();
        expect(audio().volume).toBeCloseTo(0.75, 9); // 150% × 50%
        master(100);
        await act(async () => { await Promise.resolve(); });
        expect(audio().volume).toBe(1); // 150% × 100%, capped
    });

    it('follows a Settings change to Output Volume', async () => {
        await renderHost();
        act(() => { master(20); });
        expect(audio().volume).toBeCloseTo(0.2, 9);
    });
});
