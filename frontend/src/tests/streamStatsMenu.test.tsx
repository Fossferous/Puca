/**
 * Right-click a stream → Show Stream Stats: the overlay appears on THAT tile,
 * the item flips to Hide, and the tile's <video> is the same element before
 * and after (the layout contract in streamStageLayout.test.tsx — a remounted
 * video paints black over a live stream). Never on a filmstrip thumbnail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const STREAMS = new Map<number, { username: string; stream: MediaStream }>();
let selected: number[] = [];
let streamers: { userId: number; username: string }[] = [];
let ownId: number | null = null;
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
    getCurrentStreamingUserId: () => ownId,
    notifyStreamStateChange: vi.fn(),
    globalSpeakingUsers: new Set<number>(),
    getAllVoiceUsers: () => [],
    globalCameraStreams: new Map<number, MediaStream>(),
}));
vi.mock('../api/remoteControl', () => ({
    requestControl: vi.fn(), stopControlling: vi.fn(), sendControlEvent: vi.fn(),
    subscribeControl: () => () => {}, getControlState: () => ({ controlling: null, hosting: null }),
    offerControl: vi.fn(), computeRmoveScale: () => 1, getControlHostCapture: () => null,
}));
vi.mock('../api/rtc/sfuManager', () => ({ sfuManager: { setFocusedRemote: () => {} } }));
const sampled = vi.hoisted(() => ({ streams: [] as unknown[] }));
vi.mock('../api/rtc/streamStatsLive', () => ({
    streamStatsSampler: (stream: unknown) => {
        sampled.streams.push(stream);
        return { sample: async () => null };
    },
}));

import { StreamStage } from '../components/StreamStage';
import { useStreamStore } from '../stores/streamStore';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    useStreamStore.getState().clearAllStreams();
    STREAMS.clear();
    STREAMS.set(1, { username: 'alice', stream: new MediaStream() });
    STREAMS.set(2, { username: 'bob', stream: new MediaStream() });
    selected = [1, 2];
    streamers = [{ userId: 1, username: 'alice' }, { userId: 2, username: 'bob' }];
    ownId = null;
    sampled.streams = [];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root.render(<StreamStage onBackToChat={() => {}} />); });
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

const tiles = () => [...container.querySelectorAll('.stream-tile')] as HTMLElement[];
const tileOf = (name: string) => tiles().find(t => t.textContent?.includes(name))!;
function rightClick(tile: HTMLElement) {
    act(() => { tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
}
const menuItem = (label: RegExp) =>
    [...container.querySelectorAll('.stream-context-menu button')].find(b => label.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

describe('Show Stream Stats', () => {
    it("puts the overlay on the right-clicked tile only, reading that tile's stream", async () => {
        const video = tileOf('bob').querySelector('video');
        rightClick(tileOf('bob'));
        await act(async () => { menuItem(/Show Stream Stats/)!.click(); });
        expect(tileOf('bob').querySelector('.stream-stats-overlay')).not.toBeNull();
        expect(tileOf('alice').querySelector('.stream-stats-overlay')).toBeNull();
        expect(sampled.streams).toEqual([STREAMS.get(2)!.stream]);
        expect(tileOf('bob').querySelector('video'), 'the tile video was remounted').toBe(video);
        expect(container.querySelector('.stream-context-menu'), 'the menu closes').toBeNull();
    });

    it('the same item hides it again', async () => {
        rightClick(tileOf('bob'));
        await act(async () => { menuItem(/Show Stream Stats/)!.click(); });
        rightClick(tileOf('bob'));
        await act(async () => { menuItem(/Hide Stream Stats/)!.click(); });
        expect(tileOf('bob').querySelector('.stream-stats-overlay')).toBeNull();
    });

    it('is offered on your own stream too', async () => {
        ownId = 1;
        act(() => { for (const cb of [...subscribers]) cb(); });
        rightClick(tileOf('alice'));
        expect(menuItem(/Stop Sharing/), 'this is the own-stream menu').toBeTruthy();
        await act(async () => { menuItem(/Show Stream Stats/)!.click(); });
        expect(tileOf('alice').querySelector('.stream-stats-overlay')).not.toBeNull();
    });

    it('never on a filmstrip thumbnail', async () => {
        rightClick(tileOf('bob'));
        await act(async () => { menuItem(/Show Stream Stats/)!.click(); });
        // Focus mode with alice on the stage: bob becomes a thumbnail.
        const toggle = [...container.querySelectorAll('button')].find(b => /Grid|Focus/.test(b.textContent ?? ''))!;
        act(() => { toggle.click(); });
        act(() => { tileOf('alice').click(); });
        expect(tileOf('bob').className).toContain('is-thumb');
        expect(tileOf('bob').querySelector('.stream-stats-overlay')).toBeNull();
    });

    it('a stream no longer watched forgets its overlay', async () => {
        rightClick(tileOf('bob'));
        await act(async () => { menuItem(/Show Stream Stats/)!.click(); });
        act(() => { selected = [1]; for (const cb of [...subscribers]) cb(); });
        act(() => { selected = [1, 2]; for (const cb of [...subscribers]) cb(); });
        expect(tileOf('bob').querySelector('.stream-stats-overlay')).toBeNull();
    });
});
