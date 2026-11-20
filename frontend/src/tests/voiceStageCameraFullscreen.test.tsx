/**
 * A camera tile can be made fullscreen.
 *
 * The voice grid gives every tile a few hundred pixels whatever the call size,
 * so a face was a thumbnail with no way to enlarge it — the stream stage has
 * had a fullscreen button all along, and cameras do not live there. This pins
 * the control's existence, what it fullscreens, and that it does not appear on
 * a tile with no camera (a button that does nothing is worse than none).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Take the real platform module and override only what would reach a shell
// that does not exist under jsdom — a hand-written stub of it drifts.
const cam = vi.hoisted(() => ({ android: false, bars: [] as string[] }));
vi.mock('../api/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => false,
    isMobile: () => false,
    // The Android APP, as a switch (mediaFullscreen.ts route 0).
    isAndroidApp: () => cam.android,
}));
vi.mock('../api/systemBars', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/systemBars')>()),
    holdSystemBarsHidden: () => {
        cam.bars.push('hide');
        let done = false;
        return () => { if (!done) { done = true; cam.bars.push('show'); } };
    },
}));
vi.mock('../components/SmartAvatar', () => ({ SmartAvatar: () => null }));

import { VoiceStage } from '../components/VoiceStage';
import { globalCameraStreams, globalCameraUsers, globalVoiceUsers } from '../components/voiceState';

let container: HTMLDivElement;
let root: Root;

const ROOM = 'voice_1';

/** The stage reads its roster from the module-level voice state, not a prop. */
function seedRoom() {
    globalVoiceUsers.set(ROOM, new Map([
        [1, { id: 1, username: 'me', isMuted: false, isDeafened: false } as never],
        [7, { id: 7, username: 'them', isMuted: false, isDeafened: false } as never],
    ]));
}

function render() {
    act(() => {
        root.render(
            <VoiceStage
                roomId={ROOM}
                channelName="General"
                currentUserId={1}
                memberAvatars={new Map()}
                memberNames={new Map([[1, 'Me'], [7, 'Them']])}
                onBackToChat={() => {}}
                onWatchStream={() => {}}
            />,
        );
    });
}

beforeEach(() => {
    // jsdom's HTMLMediaElement.play() returns undefined; the tile calls
    // .catch() on it. Stubbing it here keeps the failure from masquerading as
    // "the camera tile did not render".
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    globalCameraStreams.clear();
    globalCameraUsers.clear();
    globalVoiceUsers.clear();
    seedRoom();
});

afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
});

describe('fullscreening a camera tile', () => {
    it('offers the control only on a tile that has a camera', () => {
        render();
        expect(container.querySelectorAll('.vs-fullscreen-btn')).toHaveLength(0);

        globalCameraUsers.set(7, 'them');
        globalCameraStreams.set(7, new MediaStream());
        render();
        expect(container.querySelectorAll('.vs-fullscreen-btn')).toHaveLength(1);
    });

    it('fullscreens the TILE, so the name chip stays over the picture', () => {
        globalCameraUsers.set(7, 'them');
        globalCameraStreams.set(7, new MediaStream());
        render();

        const btn = container.querySelector('.vs-fullscreen-btn') as HTMLButtonElement;
        const tile = btn.parentElement as HTMLElement;
        expect(tile.className).toContain('voice-stage-tile');

        const requestFullscreen = vi.fn();
        (tile as unknown as { requestFullscreen: () => void }).requestFullscreen = requestFullscreen;
        act(() => { btn.click(); });
        expect(requestFullscreen).toHaveBeenCalledTimes(1);
    });

    it('the Android APP never asks the WebView: the tile fills the app, bare, with the system bars hidden, and leaves again', () => {
        cam.android = true;
        cam.bars = [];
        try {
            globalCameraUsers.set(7, 'them');
            globalCameraStreams.set(7, new MediaStream());
            render();
            const btn = () => container.querySelector('.vs-fullscreen-btn') as HTMLButtonElement;
            const tile = btn().parentElement as HTMLElement;
            const requestFullscreen = vi.fn().mockResolvedValue(undefined);
            (tile as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = requestFullscreen;
            act(() => { btn().click(); });
            expect(requestFullscreen).not.toHaveBeenCalled();
            expect(container.querySelector('.voice-stage-tile.is-app-fullscreen')).not.toBeNull();
            expect(document.documentElement.dataset.mediaFullscreen).toBe('on');
            expect(document.documentElement.dataset.fullscreenBare).toBe('true');
            expect(cam.bars).toEqual(['hide']);
            expect(btn().getAttribute('aria-label')).toBe('Exit fullscreen');
            act(() => { btn().click(); });
            expect(container.querySelector('.is-app-fullscreen')).toBeNull();
            expect(document.documentElement.dataset.fullscreenBare).toBeUndefined();
            expect(cam.bars).toEqual(['hide', 'show']);
        } finally {
            cam.android = false;
        }
    });

    it('where nothing can go fullscreen (an iPhone without its player for this video), the tile fills the app and leaves again', () => {
        Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
        try {
            globalCameraUsers.set(7, 'them');
            globalCameraStreams.set(7, new MediaStream());
            render();
            const btn = () => container.querySelector('.vs-fullscreen-btn') as HTMLButtonElement;
            act(() => { btn().click(); });
            expect(container.querySelector('.voice-stage-tile.is-app-fullscreen')).not.toBeNull();
            expect(document.documentElement.dataset.mediaFullscreen).toBe('on');
            expect(btn().getAttribute('aria-label')).toBe('Exit fullscreen');
            act(() => { btn().click(); });
            expect(container.querySelector('.is-app-fullscreen')).toBeNull();
            expect(document.documentElement.dataset.mediaFullscreen).toBeUndefined();
        } finally {
            delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
        }
    });

    it('the camera going away ends the in-app fullscreen: nothing is left holding the page', () => {
        Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
        try {
            globalCameraUsers.set(7, 'them');
            globalCameraStreams.set(7, new MediaStream());
            render();
            act(() => { (container.querySelector('.vs-fullscreen-btn') as HTMLButtonElement).click(); });
            expect(document.documentElement.dataset.mediaFullscreen).toBe('on');
            globalCameraStreams.delete(7);
            globalCameraUsers.delete(7);
            render();
            expect(document.documentElement.dataset.mediaFullscreen).toBeUndefined();
            // ...and the same camera coming back does not reopen it unasked.
            globalCameraUsers.set(7, 'them');
            globalCameraStreams.set(7, new MediaStream());
            render();
            expect(document.documentElement.dataset.mediaFullscreen).toBeUndefined();
            expect(container.querySelector('.is-app-fullscreen')).toBeNull();
        } finally {
            delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
        }
    });
});
