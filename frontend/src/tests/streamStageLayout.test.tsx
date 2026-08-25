import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * THE LAYOUT CONTRACT of the screen-share stage.
 *
 * The set of mounted <video> elements is a pure function of WHICH STREAMS YOU
 * ARE WATCHING — never of the layout. Grid vs focus, and which tile is on the
 * stage, are CSS classes over a stable element set.
 *
 * This is not a style preference. A <video> that React unmounts, or that any
 * DOM mutation detaches and reattaches, comes back PAUSED and paints a black
 * frame over a stream that is still live. Rendering only the focused tile is
 * what produced the long-running "the stream went black after I moved around
 * the UI" bug; 0.6.7 patched the symptom by re-play()ing paused tiles.
 *
 * So these tests assert element IDENTITY and DOM ORDER across layout changes.
 * They fail against any implementation that filters the rendered list, sorts it
 * to move the stage first, or wraps the thumbnails in their own container —
 * the three natural ways to reintroduce the bug.
 */

const STREAMS = new Map<number, { username: string; stream: MediaStream }>();
let selected: number[] = [];
let streamers: { userId: number; username: string }[] = [];
let notify: (() => void) | null = null;

vi.mock('../components/voiceState', () => ({
    subscribeToStreamState: (cb: () => void) => { notify = cb; return () => { notify = null; }; },
    subscribeToVoiceUsers: () => () => { /* no voice users in these tests */ },
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
}));

/** Mutable so a test can put an ACTIVE remote-control session on a given user. */
let controlState: { controlling: unknown; hosting: unknown } = { controlling: null, hosting: null };

vi.mock('../api/remoteControl', () => ({
    requestControl: vi.fn(),
    stopControlling: vi.fn(),
    sendControlEvent: vi.fn(),
    subscribeControl: () => () => { /* unsubscribe */ },
    getControlState: () => controlState,
    offerControl: vi.fn(),
    computeRmoveScale: () => 1,
    getControlHostCapture: () => null,
}));

const setFocusedRemote = vi.fn();
vi.mock('../api/rtc/sfuManager', () => ({
    sfuManager: {
        setFocusedRemote: (id: number | null) => setFocusedRemote(id),
    },
}));

import { StreamStage } from '../components/StreamStage';
import { useStreamStore } from '../stores/streamStore';

/** A video-only stream: no audio track keeps the Web-Audio graph out of this. */
function fakeStream(): MediaStream {
    return new MediaStream() as MediaStream;
}

let container: HTMLDivElement;
let root: Root;

function render() {
    act(() => {
        root = createRoot(container);
        root.render(<StreamStage onBackToChat={() => { /* not exercised */ }} />);
    });
}

const grid = () => container.querySelector('.stream-grid')!;
const tiles = () => Array.from(container.querySelectorAll('.stream-tile'));
const videos = () => Array.from(container.querySelectorAll('video'));
/** The toggle is the only control rendered as "⊞ Grid" / "⬚ Focus". */
const toggle = () => Array.from(container.querySelectorAll('button'))
    .find(b => /Grid|Focus/.test(b.textContent ?? ''))!;

beforeEach(() => {
    // Focus state now lives in a module-global zustand store (so Chat's
    // jump-to-stream can set it before this component mounts). Global means
    // it survives between tests — reset it, or every test after the first
    // focus-mode test starts focused.
    useStreamStore.getState().clearAllStreams();
    controlState = { controlling: null, hosting: null };
    STREAMS.clear();
    STREAMS.set(1, { username: 'alice', stream: fakeStream() });
    STREAMS.set(2, { username: 'bob', stream: fakeStream() });
    STREAMS.set(3, { username: 'carol', stream: fakeStream() });
    selected = [1, 2, 3];
    streamers = [
        { userId: 1, username: 'alice' },
        { userId: 2, username: 'bob' },
        { userId: 3, username: 'carol' },
    ];
    setFocusedRemote.mockClear();
    // jsdom has no media stack: play() is "not implemented" and returns
    // undefined, which would blow up the `.catch()` on the bind path.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe('StreamStage layout contract', () => {
    it('renders every watched stream in grid mode', () => {
        render();
        expect(videos()).toHaveLength(3);
    });

    it('keeps the SAME video elements when switching grid → focus → grid', () => {
        render();
        const before = videos();
        expect(before).toHaveLength(3);

        act(() => { toggle().click(); });   // → focus
        const inFocus = videos();
        expect(inFocus).toHaveLength(3);
        // Identity, not just count: a remount would produce new objects.
        inFocus.forEach((el, i) => expect(el).toBe(before[i]));

        act(() => { toggle().click(); });   // → grid
        const after = videos();
        after.forEach((el, i) => expect(el).toBe(before[i]));
    });

    it('never reorders the DOM while spotlighting a different tile', () => {
        render();
        act(() => { toggle().click(); });
        const before = videos();

        // Spotlight the last tile. Its role changes; its position must not.
        act(() => { tiles()[2].click(); });

        const after = videos();
        after.forEach((el, i) => expect(el).toBe(before[i]));
        expect(tiles()[2].className).toContain('is-stage');
        expect(tiles()[0].className).toContain('is-thumb');
    });

    it('expresses focus as classes: exactly one stage, the rest a filmstrip', () => {
        render();
        expect(grid().className).toContain('grid-3');

        act(() => { toggle().click(); });
        expect(grid().className).toContain('focus-mode');
        expect(grid().className).toContain('has-strip');
        expect(tiles().filter(t => t.className.includes('is-stage'))).toHaveLength(1);
        expect(tiles().filter(t => t.className.includes('is-thumb'))).toHaveLength(2);
    });

    it('has no filmstrip when only one stream is watched', () => {
        selected = [1];
        streamers = [{ userId: 1, username: 'alice' }];
        render();
        // The toggle only appears with >1 stream, so drive focus via the tile.
        expect(videos()).toHaveLength(1);
        expect(grid().className).not.toContain('has-strip');
    });

    it('keeps every tile bound to its own stream across a layout change', () => {
        render();
        act(() => { toggle().click(); });
        const bound = videos().map(v => (v as HTMLVideoElement).srcObject);
        expect(bound).toEqual([STREAMS.get(1)!.stream, STREAMS.get(2)!.stream, STREAMS.get(3)!.stream]);
    });

    it('tells the SFU which stream is on the stage, even before one is clicked', () => {
        render();
        // Grid mode focuses nobody.
        expect(setFocusedRemote).toHaveBeenLastCalledWith(null);

        act(() => { toggle().click(); });
        // Entering focus without clicking a tile must still nominate a stage,
        // or the big tile sits on the SFU's LOW simulcast layer — a blurry stage.
        expect(setFocusedRemote).toHaveBeenLastCalledWith(1);

        act(() => { tiles()[1].click(); });
        expect(setFocusedRemote).toHaveBeenLastCalledWith(2);
    });

    /**
     * Once non-focused tiles became visible, you could be CONTROLLING one
     * person's machine while spotlighting someone else. Their tile is then a
     * ~176px thumbnail — and if it still carried the input-capture surface, a
     * click meant to spotlight it would be forwarded to their real desktop, at
     * a coordinate mapped from a thumbnail. You cannot aim at a screen you
     * cannot see, so the capture surface belongs to the stage only.
     */
    it('never puts the remote-control capture surface on a filmstrip thumbnail', () => {
        controlState = { controlling: { userId: 1, username: 'alice', status: 'active' }, hosting: null };
        render();

        // Grid mode: the controlled tile carries the capture surface.
        expect(container.querySelectorAll('.control-capture')).toHaveLength(1);

        act(() => { toggle().click(); });          // focus; stage falls back to user 1
        expect(tiles()[0].className).toContain('is-stage');
        expect(container.querySelectorAll('.control-capture')).toHaveLength(1);

        act(() => { tiles()[1].click(); });        // spotlight user 2 — user 1 is now a thumb
        expect(tiles()[0].className).toContain('is-thumb');
        expect(container.querySelectorAll('.control-capture')).toHaveLength(0);

        act(() => { tiles()[0].click(); });        // spotlight the controlled machine again
        expect(container.querySelectorAll('.control-capture')).toHaveLength(1);
    });

    /**
     * Someone live that you have not started watching gets a "Watch" card at the
     * end of the filmstrip. This replaced a text sidebar that was hidden below
     * 768px, so on a phone there was previously no way to start watching a
     * second stream at all.
     */
    it('offers a Watch card for a live streamer you are not watching', async () => {
        selected = [1];
        streamers = [
            { userId: 1, username: 'alice' },
            { userId: 2, username: 'bob' },
        ];
        render();

        // Grid mode keeps the strip out: `grid-N` is sized for exactly N tiles.
        expect(container.querySelectorAll('.watch-card')).toHaveLength(0);
        // ...but focus must be reachable, or the card can never be seen: with
        // one stream watched the toggle used to be hidden entirely.
        expect(toggle()).toBeTruthy();

        act(() => { toggle().click(); });
        const cards = container.querySelectorAll('.watch-card');
        expect(cards).toHaveLength(1);
        expect(cards[0].textContent).toContain('bob');

        const { selectStream } = await import('../components/voiceState');
        act(() => { (cards[0] as HTMLElement).click(); });
        expect(selectStream).toHaveBeenCalledWith(2);
    });

    it('shows no Watch card for someone already being watched', () => {
        render(); // all three selected
        act(() => { toggle().click(); });
        expect(container.querySelectorAll('.watch-card')).toHaveLength(0);
    });

    it('drops a tile only when the stream itself stops being watched', () => {
        render();
        expect(videos()).toHaveLength(3);

        act(() => {
            selected = [1, 3];
            streamers = streamers.filter(s => s.userId !== 2);
            notify?.();
        });

        expect(videos()).toHaveLength(2);
    });
});
