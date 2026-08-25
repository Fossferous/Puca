/**
 * SmartAvatar freeze/hide behaviour.
 *
 * Animated (GIF) avatars are frozen to a canvas snapshot unless the user is
 * speaking. The interesting edge is hide → unhide: hiding unmounts both the
 * <img> and the <canvas>, so un-hiding mounts a BRAND NEW canvas that has
 * never been drawn to. If the snapshot isn't retaken on the fresh element the
 * user sees an empty 300x150 default canvas instead of their avatar — which
 * is why the assertion below checks the canvas dimensions, not just that a
 * canvas exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let speaking = false;
vi.mock('../components/voiceState', () => ({
    isUserSpeaking: () => speaking,
}));

let hidden = false;
vi.mock('../components/avatarPrefs', () => ({
    isAvatarHidden: () => hidden,
}));

// /files is authenticated, so SmartAvatar resolves a file id to an object URL
// through an authenticated fetch. jsdom has no server behind that, so stand in
// a resolved URL — this suite is about the freeze/hide behaviour, not transport.
vi.mock('../hooks/useAuthedFileUrl', () => ({
    useAuthedFileUrl: (fileId: string | null | undefined) => (fileId ? 'blob:mock/' + fileId : null),
}));

import { SmartAvatar } from '../components/SmartAvatar';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    speaking = false;
    hidden = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // jsdom never loads images: fake a 64x64 decoded bitmap.
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 64 });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 64 });
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

function setHidden(userId: number, value: boolean) {
    hidden = value;
    act(() => {
        window.dispatchEvent(new CustomEvent('avatarPrefsChanged', { detail: { userId, hidden: value } }));
    });
}

describe('SmartAvatar hide → unhide', () => {
    it('re-draws the frozen snapshot after the avatar is un-hidden', () => {
        act(() => {
            root.render(<SmartAvatar userId={7} fileId="file-a" fallback={<span>AB</span>} />);
        });
        const img = container.querySelector('img')!;
        expect(img).toBeTruthy();
        act(() => { img.dispatchEvent(new Event('load')); });

        const canvas1 = container.querySelector('canvas')!;
        expect(canvas1).toBeTruthy();
        // Snapshot taken: canvas sized to the (capped) natural size.
        expect(canvas1.width).toBe(64);

        setHidden(7, true);
        expect(container.querySelector('canvas')).toBeNull();
        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).toContain('AB');

        setHidden(7, false);
        const img2 = container.querySelector('img')!;
        expect(img2).toBeTruthy();
        // Real browsers fire load again for the fresh element (memory cache).
        act(() => { img2.dispatchEvent(new Event('load')); });

        const canvas2 = container.querySelector('canvas');
        expect(canvas2).toBeTruthy();
        // 300 (the untouched HTMLCanvasElement default) would mean the fresh
        // canvas was never drawn to — a blank box where the avatar should be.
        expect(canvas2!.width).toBe(64);
    });

    it('does not lazy-load the hidden <img> (it would never fetch at all)', () => {
        // The frozen <img> is display:none, so it has no layout box and never
        // intersects the viewport. With loading="lazy" the browser therefore
        // NEVER fetches it: no load event, no snapshot, and every frozen
        // avatar renders as an empty circle until its owner speaks. jsdom
        // doesn't implement lazy loading, so this asserts the attribute
        // itself — see e2e/avatar-freeze-live.mjs for the browser proof.
        act(() => {
            root.render(<SmartAvatar userId={11} fileId="file-b" fallback={<span>EF</span>} />);
        });
        const img = container.querySelector('img')!;
        expect(img.style.display).toBe('none');
        expect(img.getAttribute('loading')).toBeNull();
    });

    it('snapshots a memory-cached image that never fires a load event', () => {
        // A remounted <img> whose src is already in the browser cache can be
        // `complete` before React attaches onLoad, so no load event arrives.
        // The avatar must still freeze rather than stay invisible forever.
        Object.defineProperty(HTMLImageElement.prototype, 'complete', {
            configurable: true,
            get: () => true,
        });
        try {
            act(() => {
                root.render(<SmartAvatar userId={9} fileId="file-cached" fallback={<span>CD</span>} />);
            });
            const canvas = container.querySelector('canvas');
            expect(canvas).toBeTruthy();
            expect(canvas!.width).toBe(64);
        } finally {
            delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).complete;
        }
    });
});
