/**
 * Cameras beside the streams.
 *
 * A camera used to exist on exactly one surface — the voice stage, which is a
 * whole view mode — so watching a share and seeing a face at the same time was
 * impossible. This pins the rail's contract: a tile per live camera, your own
 * one mirrored and nobody else's, a fullscreen control that enlarges the TILE
 * (so the name chip stays over the picture), and the simulcast rung held high
 * only while a camera actually fills the display.
 *
 * That last one matters more than it looks: without it, fullscreen showed a
 * 640x360 picture blown up to the whole screen, and the feature would look
 * broken at the exact moment somebody leaned in to look.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// vi.mock is hoisted above the file's own consts, so the spy has to be
// hoisted with it.
const { setCameraQuality } = vi.hoisted(() => ({ setCameraQuality: vi.fn() }));
vi.mock('../api/rtc/sfuManager', () => ({ sfuManager: { setCameraQuality } }));

import { CameraRail } from '../components/CameraRail';
import { globalCameraStreams, globalVoiceUsers } from '../components/voiceState';

const ROOM = 'voice_1';
let container: HTMLDivElement;
let root: Root;

function seedRoster() {
    globalVoiceUsers.set(ROOM, new Map([
        [1, { id: 1, username: 'me', isMuted: false, isDeafened: false } as never],
        [7, { id: 7, username: 'them', isMuted: false, isDeafened: false } as never],
    ]));
}

function render(currentUserId = 1) {
    act(() => { root.render(<CameraRail currentUserId={currentUserId} />); });
}

const tiles = () => container.querySelectorAll('.camera-rail-tile');

beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    setCameraQuality.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    globalCameraStreams.clear();
    globalVoiceUsers.clear();
    seedRoster();
});

afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
});

describe('the camera rail', () => {
    it('renders nothing at all when no camera is on', () => {
        render();
        expect(container.querySelector('.camera-rail')).toBeNull();
    });

    it('renders one tile per live camera, naming them from the voice roster', () => {
        globalCameraStreams.set(1, new MediaStream());
        globalCameraStreams.set(7, new MediaStream());
        render();
        expect(tiles()).toHaveLength(2);
        const labels = [...container.querySelectorAll('.camera-rail-name')].map(n => n.textContent);
        expect(labels).toContain('You');
        expect(labels).toContain('them');
    });

    it('mirrors your own camera and nobody else’s', () => {
        globalCameraStreams.set(1, new MediaStream());
        globalCameraStreams.set(7, new MediaStream());
        render(1);
        const mine = container.querySelectorAll('.camera-rail-tile')[0].querySelector('video');
        const theirs = container.querySelectorAll('.camera-rail-tile')[1].querySelector('video');
        expect(mine?.className).toContain('mirrored');
        expect(theirs?.className).not.toContain('mirrored');
    });

    it('fullscreens the TILE, so the name chip stays over the picture', () => {
        globalCameraStreams.set(7, new MediaStream());
        render();
        const btn = container.querySelector('.camera-rail-fullscreen') as HTMLButtonElement;
        const tile = btn.parentElement as HTMLElement;
        expect(tile.className).toContain('camera-rail-tile');

        const requestFullscreen = vi.fn().mockResolvedValue(undefined);
        (tile as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = requestFullscreen;
        act(() => { btn.click(); });
        expect(requestFullscreen).toHaveBeenCalledTimes(1);
    });

    it('asks for the high rung while a camera fills the display, and gives it back after', () => {
        globalCameraStreams.set(7, new MediaStream());
        render();
        const btn = container.querySelector('.camera-rail-fullscreen') as HTMLButtonElement;
        const tile = btn.parentElement as HTMLElement;
        (tile as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen =
            vi.fn().mockResolvedValue(undefined);

        act(() => { btn.click(); });
        expect(setCameraQuality).toHaveBeenCalledWith(7, 2);

        // Leaving fullscreen by ANY route releases it — Escape and the OS
        // chrome do not go through our button, and a pin left behind is paid
        // for by the other end's uplink for the rest of the call.
        setCameraQuality.mockClear();
        act(() => { document.dispatchEvent(new Event('fullscreenchange')); });
        expect(setCameraQuality).toHaveBeenCalledWith(7, null);
    });

    it('never pins your OWN camera — there is no subscription to raise', () => {
        globalCameraStreams.set(1, new MediaStream());
        render(1);
        const btn = container.querySelector('.camera-rail-fullscreen') as HTMLButtonElement;
        const tile = btn.parentElement as HTMLElement;
        (tile as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen =
            vi.fn().mockResolvedValue(undefined);
        act(() => { btn.click(); });
        expect(setCameraQuality).not.toHaveBeenCalled();
    });

    it('releases a held rung on unmount, not only on a fullscreen change', () => {
        globalCameraStreams.set(7, new MediaStream());
        render();
        const btn = container.querySelector('.camera-rail-fullscreen') as HTMLButtonElement;
        const tile = btn.parentElement as HTMLElement;
        (tile as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen =
            vi.fn().mockResolvedValue(undefined);
        act(() => { btn.click(); });
        setCameraQuality.mockClear();

        act(() => { root.unmount(); });
        expect(setCameraQuality).toHaveBeenCalledWith(7, null);
        root = createRoot(container); // afterEach unmounts again; give it a live root
    });
});
