/**
 * The chat composer makes a phone's HEIC photo a JPEG before it is encrypted
 * and uploaded (Chat.tsx enqueueUpload, api/heif.ts), through the real Chat
 * with the same stand-ins as chatDropZone.test.tsx; the desktop app's native
 * converter is the one stand-in for what is native.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ME = 1;

const h = vi.hoisted(() => ({
    channel: {} as Record<string, unknown>,
    uploads: [] as Array<{ name: string; type: string; head: number[]; camera?: boolean }>,
    invoke: null as null | ((cmd: string, body: unknown) => Promise<unknown>),
}));

vi.mock('../api/attachments', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/attachments')>()),
    // Never resolves: the test only cares whether an upload STARTED.
    encryptAndUploadRef: async (file: File) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        h.uploads.push({ name: file.name, type: file.type, head: [...bytes.subarray(0, 2)], camera: Buffer.from(bytes).includes('PucaTestCam') });
        return new Promise(() => {});
    },
}));
vi.mock('@tauri-apps/api/core', async importOriginal => ({
    ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
    invoke: (cmd: string, body: unknown) => (h.invoke ? h.invoke(cmd, body) : Promise.reject(new Error('not the desktop app'))),
}));
vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    getMessages: async () => [],
    decryptChannelMessages: async (_ch: number, raw: unknown[]) => raw,
    listPinnedMessages: async () => [],
}));
vi.mock('../api/auth', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/auth')>()),
    getToken: () => `h.${btoa(JSON.stringify({ sub: ME, username: 'me' })).replace(/=+$/, '')}.s`,
}));
vi.mock('../utils/audioFeedback', async importOriginal => ({
    ...(await importOriginal<typeof import('../utils/audioFeedback')>()),
    playMessageSound: () => {},
    playMentionSound: () => {},
}));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function scrollIntoView() {};
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);

const reply = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text, headers: new Headers() } as unknown as Response;
};
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (/\/config$/.test(u)) return reply(200, { app_url: 'https://app.example.com', registration_invite_required: false, srp_version: 2 });
    if (/\/servers$/.test(u)) return reply(200, [{ id: 's1', name: 'Srv', owner_id: ME, created_at: '2026-10-01T00:00:00Z' }]);
    if (/\/servers\/s1\/channels$/.test(u)) return reply(200, [h.channel]);
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    if (/\/dms$/.test(u)) return reply(200, []);
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

// jsdom's Blob has no arrayBuffer(); read real bytes through FileReader.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
        configurable: true,
        value(this: Blob) {
            return new Promise<ArrayBuffer>((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(r.result as ArrayBuffer);
                r.onerror = () => rej(r.error);
                r.readAsArrayBuffer(this);
            });
        },
    });
}
const thumbs = new Map<string, string>();
let seq = 0;
URL.createObjectURL = ((b: Blob) => { const u = `blob:chip-${++seq}`; thumbs.set(u, b.type); return u; }) as typeof URL.createObjectURL;
URL.revokeObjectURL = () => {};

const { Chat } = await import('../components/Chat');
const { __setEngineDecodesHeif } = await import('../api/heif');

/** The real fixture: a HEIC as a phone camera saves one (api/heif.ts). */
const HEIC = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'heic', 'rotated-gps.heic')));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    h.uploads = [];
    h.invoke = null;
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

async function mountChat() {
    h.channel = { id: 10, name: 'general', channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    for (let i = 0; i < 40 && !document.querySelector('.chat-header')?.textContent?.includes('general'); i++) await settle();
    expect(document.querySelector('.chat-header')?.textContent, 'the channel opened').toContain('general');
    await settle();
}

async function drop(file: File) {
    const zone = document.querySelector('.messages-container');
    const dt = { types: ['Files'], files: [file], dropEffect: 'copy' };
    for (const type of ['dragover', 'drop']) {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        await act(async () => { zone!.dispatchEvent(ev); });
    }
    for (let i = 0; i < 20 && h.uploads.length === 0; i++) await settle();
}

const chip = () => document.querySelector('.composer-chip');

/**
 * A photo from a phone, dropped into a channel: the owner's report
 * (2026-10-23, "HEIC doesnt load in text channels"). Where the device can,
 * the composer makes it a JPEG BEFORE it is encrypted and uploaded, and its
 * chip previews that JPEG; where it cannot, the original goes and its chip
 * is a file icon, never a broken thumbnail.
 */
describe('a HEIC in the chat composer', () => {
    it('in the desktop app it is uploaded as a JPEG, and the chip shows the JPEG', async () => {
        __setEngineDecodesHeif(false);
        await mountChat();
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
        h.invoke = async (cmd) => (cmd === 'heif_to_jpeg' ? JPEG.slice().buffer : undefined);
        await drop(new File([HEIC as BlobPart], 'IMG20261023012318.heic', { type: 'image/heic' }));
        expect(h.uploads).toEqual([{ name: 'IMG20261023012318.jpg', type: 'image/jpeg', head: [0xff, 0xd8], camera: false }]);
        expect(chip()?.textContent).toContain('IMG20261023012318.jpg');
        const img = chip()?.querySelector('img');
        expect(img, 'the chip previews the converted picture').toBeTruthy();
        expect(thumbs.get(img!.getAttribute('src')!)).toBe('image/jpeg');
    });

    it('where nothing can convert it, the HEIC goes with its metadata blanked, and the chip is a file icon', async () => {
        __setEngineDecodesHeif(false);
        await mountChat();
        await drop(new File([HEIC as BlobPart], 'IMG20261023012318.heic', { type: 'image/heic' }));
        expect(h.uploads.map(u => [u.name, u.type])).toEqual([['IMG20261023012318.heic', 'image/heic']]);
        expect(h.uploads[0].camera, 'the camera and location left the upload').toBe(false);
        expect(chip()?.textContent).toContain('IMG20261023012318.heic');
        expect(chip()?.querySelector('img'), 'a HEIC thumbnail no engine here can draw').toBeNull();
    });

    it('one that can be neither converted nor stripped is not sent: its chip says why, and Retry tries again', async () => {
        __setEngineDecodesHeif(false);
        await mountChat();
        const broken = new Uint8Array(200);
        broken.set(HEIC.subarray(0, 28));
        broken.set([0, 0, 0, 0xff, 0x6d, 0x65, 0x74, 0x61], 28);
        const zone = document.querySelector('.messages-container');
        const dt = { types: ['Files'], files: [new File([broken as BlobPart], 'odd.heic', { type: 'image/heic' })], dropEffect: 'copy' };
        for (const type of ['dragover', 'drop']) {
            const ev = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt });
            await act(async () => { zone!.dispatchEvent(ev); });
        }
        for (let i = 0; i < 20 && !chip()?.classList.contains('composer-chip-failed'); i++) await settle();
        expect(h.uploads).toEqual([]);
        expect(chip()?.classList.contains('composer-chip-failed')).toBe(true);
        expect(chip()?.textContent).toContain('location');
        const retry = chip()?.querySelector('button[aria-label^="Retry"]') as HTMLButtonElement;
        await act(async () => { retry.click(); });
        await settle(60);
        expect(h.uploads, 'Retry went through the conversion again, not straight to the upload').toEqual([]);
        expect(chip()?.classList.contains('composer-chip-failed')).toBe(true);
    });

    it('positive control: a JPEG is uploaded as it is, with its thumbnail at once', async () => {
        await mountChat();
        await drop(new File([JPEG as BlobPart], 'photo.jpg', { type: 'image/jpeg' }));
        expect(h.uploads).toEqual([{ name: 'photo.jpg', type: 'image/jpeg', head: [0xff, 0xd8], camera: false }]);
        expect(chip()?.querySelector('img')).toBeTruthy();
    });
});
