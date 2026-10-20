/**
 * The picture viewer's Download on the DESKTOP app and the WEB.
 *
 * Desktop: the viewer used to click a transient `<a download>` of the blob,
 * which is not a reliable download in the shell's webview — so Download in
 * the viewer did nothing there, while every other attachment saved through
 * the attachment_save command (api/saveAttachment.ts). It must take that
 * command now, with the picture's bytes and name, and say where it went.
 *
 * Web: a transient anchor is still the right thing there, created, clicked
 * and removed (never left in the document to be middle-clicked).
 *
 * The Android branches live in clipDownloadNative.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Blob as NodeBlob } from 'node:buffer';

const h = vi.hoisted(() => ({ tauri: false, invokes: [] as { cmd: string; bytes: Uint8Array | null; headers: Record<string, string> }[] }));

vi.mock('../api/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isMobile: () => false,
    isTauri: () => h.tauri,
}));
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, body: unknown, options?: { headers?: Record<string, string> }) => {
        h.invokes.push({ cmd, bytes: body instanceof Uint8Array ? body.slice() : null, headers: { ...(options?.headers ?? {}) } });
        return 'C:\\Users\\test\\Downloads\\Puca\\' + decodeURIComponent(options?.headers?.['x-file-name'] ?? '');
    },
}));

import { ImageLightbox } from '../components/ImageLightbox';

const PICTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
const REF = { id: '6a1b2c3d-0b1d-4c2e-9a7f-30e62651d0f5', key: 'PIC_key', mime: 'image/png' };

let container: HTMLDivElement;
let root: Root;
let clicks: string[];
const origClick = HTMLAnchorElement.prototype.click;

const download = () => [...document.querySelectorAll<HTMLButtonElement>('button.image-lightbox-dl')]
    .find(b => /Download|Saving|Saved|Could not save/.test(b.textContent ?? ''))!;

async function settleUntil(cond: () => boolean, what: string) {
    for (let i = 0; i < 100; i++) {
        if (cond()) return;
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    }
    throw new Error(`timed out waiting for: ${what}`);
}

beforeEach(() => {
    h.invokes.length = 0;
    clicks = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicks.push(this.download); };
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
        if (u !== 'blob:pic') throw new Error(`unexpected fetch ${u}`);
        return new Response(PICTURE.slice());
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    HTMLAnchorElement.prototype.click = origClick;
    vi.unstubAllGlobals();
});

describe('the picture viewer\'s Download', () => {
    it('desktop: writes the picture through attachment_save, not an anchor, and says where', async () => {
        h.tauri = true;
        await act(async () => { root.render(<ImageLightbox url="blob:pic" name="photo.png" encRef={REF} onClose={() => {}} />); });
        await act(async () => { download().click(); });
        await settleUntil(() => /Saved/.test(download().textContent ?? ''), 'the desktop save');
        expect(clicks).toEqual([]);
        expect(h.invokes).toHaveLength(1);
        expect(h.invokes[0].cmd).toBe('attachment_save');
        expect(h.invokes[0].bytes).toEqual(PICTURE);
        expect(decodeURIComponent(h.invokes[0].headers['x-file-name'])).toBe('photo.png');
        expect(download().title).toBe('Saved to C:\\Users\\test\\Downloads\\Puca\\photo.png');
    });

    it('desktop: a Notes picture (no attachment ref) takes the same command', async () => {
        h.tauri = true;
        await act(async () => { root.render(<ImageLightbox url="blob:pic" name="sketch.png" onClose={() => {}} />); });
        await act(async () => { download().click(); });
        await settleUntil(() => /Saved/.test(download().textContent ?? ''), 'the desktop save');
        expect(clicks).toEqual([]);
        expect(h.invokes.map(i => i.cmd)).toEqual(['attachment_save']);
        expect(h.invokes[0].bytes).toEqual(PICTURE);
    });

    it('desktop: a failed write says so on the button instead of doing nothing', async () => {
        h.tauri = true;
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        await act(async () => { root.render(<ImageLightbox url="blob:pic" name="photo.png" encRef={REF} onClose={() => {}} />); });
        await act(async () => { download().click(); });
        await settleUntil(() => /Could not save/.test(download().textContent ?? ''), 'the error');
        expect(h.invokes).toEqual([]);
    });

    it('web: a transient anchor with the picture\'s name, and no shell command', async () => {
        h.tauri = false;
        await act(async () => { root.render(<ImageLightbox url="blob:pic" name="photo.png" encRef={REF} onClose={() => {}} />); });
        await act(async () => { download().click(); });
        await settleUntil(() => clicks.length === 1, 'the anchor');
        expect(clicks).toEqual(['photo.png']);
        expect(h.invokes).toEqual([]);
        expect(document.querySelector('a[download]')).toBeNull();
    });
});
