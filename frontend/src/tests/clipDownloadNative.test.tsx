/**
 * Download in the Android app with the NATIVE download plugin
 * (api/nativeDownloads.ts → SovereignDownloadsPlugin.java), and the fallback
 * an older APK takes (the old Documents/Puca path, clipDownloadAndroid.test.tsx).
 *
 * Driven through the real Download button of ClipAttachment and the real
 * attachment save, against a fake plugin that records what the page hands
 * over. What must hold:
 *   - with the plugin, NO byte of the clip crosses the bridge: the page never
 *     fetches a part and never calls the filesystem plugin; it passes the ids,
 *     the keys, its bearer and its API base, and nothing that is a URL;
 *   - progress events for THIS download (by id) drive "Downloading N%";
 *   - Cancel reaches the plugin with the same id and the button goes back to
 *     Download; "gone" still says the clip is no longer on the server;
 *   - a clip whose manifest points at unapproved parts is never sent;
 *   - an APK without the plugin, one built for another server, or Android 9
 *     keep the old JavaScript path; Cancel works there too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fakeCapacitorFs, patternBytes } from './fixtures/fakeCapacitorFs';
import { memoryLocalStorage } from './fixtures/fakeSink';

type Listener = (e: { id: string; bytesDone: number; totalBytes: number; done: number; total: number }) => void;
interface SaveCall { method: 'saveClip' | 'saveAttachment'; opts: Record<string, unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }

const h = vi.hoisted(() => ({
    fs: null as ReturnType<typeof import('./fixtures/fakeCapacitorFs').fakeCapacitorFs> | null,
    nativePlugin: true,
    status: { version: 1, supported: true, apiBase: 'http://localhost:3000' as string | null },
    statusCalls: 0,
    saves: [] as SaveCall[],
    cancels: [] as string[],
    listeners: [] as Listener[],
    removed: 0,
    /** When set, addListener waits for this before it resolves. */
    listenerGate: null as Promise<void> | null,
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => 'android',
        isPluginAvailable: (n: string) => n === 'Filesystem' || (h.nativePlugin && n === 'SovereignDownloads'),
        isNativePlatform: () => true,
    },
    registerPlugin: (name: string) => name !== 'SovereignDownloads' ? {} : {
        status: async () => { h.statusCalls++; return { ...h.status }; },
        saveClip: (opts: Record<string, unknown>) => new Promise((resolve, reject) => { h.saves.push({ method: 'saveClip', opts, resolve, reject }); }),
        saveAttachment: (opts: Record<string, unknown>) => new Promise((resolve, reject) => { h.saves.push({ method: 'saveAttachment', opts, resolve, reject }); }),
        cancel: async ({ id }: { id: string }) => { h.cancels.push(id); return { cancelled: true }; },
        addListener: async (_e: string, fn: Listener) => {
            if (h.listenerGate) await h.listenerGate;
            h.listeners.push(fn);
            return { remove: async () => { h.removed++; h.listeners.splice(h.listeners.indexOf(fn), 1); } };
        },
    },
}));
vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        writeFile: (o: never) => h.fs!.api.writeFile(o),
        appendFile: (o: never) => h.fs!.api.appendFile(o),
        deleteFile: (o: never) => h.fs!.api.deleteFile(o),
        rename: (o: never) => h.fs!.api.rename(o),
    },
    Directory: { Documents: 'DOCUMENTS' },
    Encoding: { UTF8: 'utf8' },
}));
vi.mock('../api/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isMobile: () => true,
    isTauri: () => false,
}));

import { ClipAttachment } from '../components/ClipAttachment';
import { encodeClipRef, type ClipManifest } from '../api/clips/clipRef';
import { newClipSecrets, sealPart } from '../api/clips/clipCrypto';
import { resetNativeDownloadsForTests } from '../api/nativeDownloads';
import { saveEncryptedAttachment, saveFailureNote } from '../api/saveAttachment';
import { NOTES_FOLDER } from '../api/saveToDevice';
import { ImageLightbox } from '../components/ImageLightbox';
import type { ClipConsent } from '../api/servers';

const CLIP_ID = '0000abcd-0000-4000-8000-000000000001';

let container: HTMLDivElement;
let root: Root;
let disk: ReturnType<typeof fakeCapacitorFs>;
const served = new Map<string, Uint8Array<ArrayBuffer>>();
let fetched: string[] = [];

async function sealedClip(partSizes: number[]): Promise<{ href: string; m: ClipManifest; plain: Buffer }> {
    const secrets = newClipSecrets(CLIP_ID);
    const plains = partSizes.map((n, i) => patternBytes(n, i + 11));
    const ids: string[] = [];
    let cipher = 0;
    for (let i = 0; i < plains.length; i++) {
        const wire = await sealPart(secrets, i, plains[i]);
        const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
        served.set(id, new Uint8Array(wire));
        ids.push(id);
        cipher += wire.length;
    }
    const m: ClipManifest = {
        key: secrets.key, noncePrefix: secrets.noncePrefix, clipId: CLIP_ID,
        videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2', durationMs: 120_000, width: 1920, height: 1080,
        totalCipherBytes: cipher, parts: ids, partDurMs: ids.map((_, i) => (i === 0 ? 0 : 10_000)),
    };
    return { href: encodeClipRef(m), m, plain: Buffer.concat(plains.map(p => Buffer.from(p))) };
}

const settle = async (rounds = 8) => {
    await act(async () => { for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0)); });
};
const downloadButton = () => container.querySelector('button.clip-attachment-download') as HTMLButtonElement;
const cancelButton = () => container.querySelector('button.clip-attachment-cancel') as HTMLButtonElement | null;
/** The lightbox's Download (portaled to <body>; the Copy button shares its class). */
const lightboxDownload = () => [...document.querySelectorAll('button.image-lightbox-dl')]
    .find(b => /Download|Saving|Saved|Could not/.test(b.textContent ?? '')) as HTMLButtonElement;
const b64ToBytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** Bounded well inside the test timeout: a test that times out mid-act()
 *  leaves React's act queue entangled and fails the tests after it. */
async function waitFor(cond: () => boolean, what: string) {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < 2000) await settle(2);
    expect(cond(), what).toBe(true);
}

beforeEach(() => {
    const ls = memoryLocalStorage();
    ls.setItem('auth_token', 'the-bearer');
    vi.stubGlobal('localStorage', ls);
    disk = fakeCapacitorFs();
    h.fs = disk;
    h.nativePlugin = true;
    h.status = { version: 1, supported: true, apiBase: 'http://localhost:3000' };
    h.statusCalls = 0;
    h.saves.length = 0;
    h.cancels.length = 0;
    h.listeners.length = 0;
    h.removed = 0;
    h.listenerGate = null;
    resetNativeDownloadsForTests();
    served.clear();
    fetched = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string | URL | Request) => {
        const url = String(u);
        const part = /\/files\/([0-9a-f-]+)$/.exec(url);
        if (part) {
            fetched.push(part[1]);
            const wire = served.get(part[1]);
            return wire ? new Response(wire) : new Response('gone', { status: 404 });
        }
        throw new Error(`unexpected fetch ${url}`);
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe('Android with the native download plugin', () => {
    it('hands the clip to the plugin: ids, keys, bearer and API base — and not one byte over the bridge', async () => {
        const { href, m } = await sealedClip([1024, 4096, 4096]);
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await act(async () => { downloadButton().click(); });
        await waitFor(() => h.saves.length === 1, 'the plugin was asked to save the clip');

        const call = h.saves[0];
        expect(call.method).toBe('saveClip');
        const o = call.opts;
        expect(o.parts).toEqual(m.parts);
        expect(o.clipId).toBe(CLIP_ID);
        expect(b64ToBytes(o.key as string)).toEqual(m.key);
        expect(b64ToBytes(o.noncePrefix as string)).toEqual(m.noncePrefix);
        expect(o.token).toBe('the-bearer');
        expect(o.apiBase).toBe('http://localhost:3000');
        expect(o.totalBytes).toBe(m.totalCipherBytes);
        expect(o.durationMs).toBe(120_000);
        expect(o.name).toBe('puca-clip-0000abcd.mp4');
        // nothing that is a URL, and the page fetched and wrote nothing itself
        for (const v of Object.values(o)) expect(String(v)).not.toMatch(/\/files\//);
        expect(fetched).toEqual([]);
        expect(disk.calls).toEqual([]);

        // progress for THIS download moves the button; another id's does not
        const id = o.id as string;
        await act(async () => { for (const l of [...h.listeners]) l({ id: 'dl-someone-else', bytesDone: m.totalCipherBytes, totalBytes: m.totalCipherBytes, done: 3, total: 3 }); });
        expect(downloadButton().textContent).toMatch(/Downloading 0%/);
        await act(async () => { for (const l of [...h.listeners]) l({ id, bytesDone: Math.floor(m.totalCipherBytes / 2), totalBytes: m.totalCipherBytes, done: 1, total: 3 }); });
        expect(downloadButton().textContent).toMatch(/Downloading (49|50)%/);

        await act(async () => { call.resolve({ where: 'Movies/Puca/puca-clip-0000abcd.mp4', uri: 'content://media/x', bytes: 9000, container: 'duration and seek index added' }); });
        await settle();
        expect(container.querySelector('.clip-attachment-saved')?.textContent).toBe('Saved to Movies/Puca/puca-clip-0000abcd.mp4');
        expect(h.listeners.length, 'the progress listener was removed').toBe(0);
    });

    it('Cancel reaches the plugin with the same id, and the button goes back to Download', async () => {
        const { href } = await sealedClip([1024, 4096]);
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await act(async () => { downloadButton().click(); });
        await waitFor(() => h.saves.length === 1, 'save started');
        expect(cancelButton(), 'a Cancel button while downloading').not.toBeNull();
        await act(async () => { cancelButton()!.click(); });
        await settle();
        expect(h.cancels).toEqual([h.saves[0].opts.id]);
        // the plugin answers a cancelled job with code "cancelled"
        await act(async () => { h.saves[0].reject(Object.assign(new Error('Download cancelled.'), { code: 'cancelled' })); });
        await settle();
        expect(downloadButton().textContent).toMatch(/^\s*Download$/);
        expect(container.textContent).not.toMatch(/Download failed/);
        expect(cancelButton()).toBeNull();
    });

    it('a Cancel pressed while the download is still being set up never starts it', async () => {
        const { href } = await sealedClip([1024, 4096]);
        let open!: () => void;
        h.listenerGate = new Promise<void>(r => { open = r; });
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await act(async () => { downloadButton().click(); });
        await waitFor(() => cancelButton() !== null, 'a Cancel button while downloading');
        await act(async () => { cancelButton()!.click(); });
        await act(async () => { open(); });
        await settle();
        expect(h.saves, 'the plugin was never asked to save').toEqual([]);
        expect(downloadButton().textContent).toMatch(/^\s*Download$/);
        expect(container.textContent).not.toMatch(/Download failed/);
        expect(h.listeners.length, 'the progress listener was removed').toBe(0);
    });

    it('a clip gone from the server still says so', async () => {
        const { href } = await sealedClip([1024, 4096]);
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await act(async () => { downloadButton().click(); });
        await waitFor(() => h.saves.length === 1, 'save started');
        await act(async () => { h.saves[0].reject(Object.assign(new Error('This file is no longer on the server.'), { code: 'gone' })); });
        await settle();
        expect(container.textContent).toMatch(/This clip is no longer on the server/);
    });

    it('a decryption failure is shown, not swallowed', async () => {
        const { href } = await sealedClip([1024, 4096]);
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await act(async () => { downloadButton().click(); });
        await waitFor(() => h.saves.length === 1, 'save started');
        await act(async () => { h.saves[0].reject(Object.assign(new Error('Part 2 of this clip could not be decrypted.'), { code: 'decrypt' })); });
        await settle();
        expect(container.textContent).toMatch(/Download failed: Part 2 of this clip could not be decrypted/);
        // the plate adds its own full stop; the plugin's sentence must not double it
        expect(container.textContent).not.toMatch(/decrypted\.\./);
    });

    it('a clip pointing at footage nobody approved is never handed to the plugin', async () => {
        const { href } = await sealedClip([1024, 4096]);
        const consent: ClipConsent = { part_file_ids: ['ffffffff-0000-4000-8000-000000000009'], approver_count: 2, solo: false } as unknown as ClipConsent;
        await act(async () => { root.render(<ClipAttachment href={href} consent={consent} />); });
        expect(downloadButton().disabled).toBe(true);
        await act(async () => { downloadButton().click(); });
        await settle();
        expect(h.saves).toEqual([]);
        expect(fetched).toEqual([]);
    });

    it('an attachment is saved natively from its ref (id, key, capability, MIME, name)', async () => {
        const p = saveEncryptedAttachment('blob:unused', { id: '5f243cae-0b1d-4c2e-9a7f-30e62651d0f5', key: 'KEY_url-safe', mime: 'video/mp4', cap: 'the-cap' }, 'holiday.mp4');
        await waitFor(() => h.saves.length === 1, 'saveAttachment called');
        const o = h.saves[0].opts;
        expect(h.saves[0].method).toBe('saveAttachment');
        expect(o).toMatchObject({ fileId: '5f243cae-0b1d-4c2e-9a7f-30e62651d0f5', key: 'KEY_url-safe', cap: 'the-cap', mime: 'video/mp4', name: 'holiday.mp4', token: 'the-bearer', apiBase: 'http://localhost:3000' });
        h.saves[0].resolve({ where: 'Movies/Puca/holiday.mp4', uri: 'content://media/y', bytes: 1, container: 'video' });
        await expect(p).resolves.toEqual({ where: 'Movies/Puca/holiday.mp4', onDisk: true });
        expect(disk.calls).toEqual([]);
    });

    it('an attachment reports how much has arrived, and the total only when the server announced one', async () => {
        const heard: [number, number | null][] = [];
        const p = saveEncryptedAttachment('blob:unused', { id: '5f243cae-0b1d-4c2e-9a7f-30e62651d0f5', key: 'k', mime: 'video/mp4' }, 'clip.mp4', undefined, (n, t) => heard.push([n, t]));
        await waitFor(() => h.saves.length === 1 && h.listeners.length === 1, 'save started with a progress listener');
        const id = h.saves[0].opts.id as string;
        h.listeners[0]({ id: 'dl-other', bytesDone: 10, totalBytes: 10, done: 1, total: 1 });
        h.listeners[0]({ id, bytesDone: 5_000_000, totalBytes: 0, done: 0, total: 1 }); // streamed: no Content-Length
        h.listeners[0]({ id, bytesDone: 50, totalBytes: 200, done: 0, total: 1 });
        h.listeners[0]({ id, bytesDone: 200, totalBytes: 200, done: 1, total: 1 });
        expect(heard).toEqual([[5_000_000, null], [50, 200], [200, 200]]);
        h.saves[0].resolve({ where: 'Movies/Puca/clip.mp4', uri: 'content://media/y', bytes: 1, container: 'video' });
        await p;
        expect(h.listeners.length, 'the progress listener was removed').toBe(0);
    });

    it('an attachment saved natively says at once that the page\'s copy is not needed: the phone downloads it again', async () => {
        // Review finding 2026-10-05: the message's Download held its decrypted
        // copy (and its player) for the whole native re-download, which never
        // reads it.
        let unneeded = 0;
        const p = saveEncryptedAttachment('blob:unused', { id: '5f243cae-0b1d-4c2e-9a7f-30e62651d0f5', key: 'k', mime: 'video/mp4' }, 'clip.mp4', undefined, undefined, () => { unneeded++; });
        await waitFor(() => h.saves.length === 1, 'the plugin was asked to save it');
        expect(unneeded, 'told before the plugin settles').toBe(1);
        h.saves[0].resolve({ where: 'Movies/Puca/clip.mp4', uri: 'content://media/y', bytes: 1, container: 'video' });
        await p;
        expect(unneeded).toBe(1);
    });

    it('a save that reads the page\'s copy never says it is not needed', async () => {
        // Notes' own folder and an older APK both save the copy this page holds.
        let unneeded = 0;
        const blob = new Blob([patternBytes(10, 1)]);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(await new Response(blob).arrayBuffer())));
        await saveEncryptedAttachment('blob:x', { id: '5f243cae-0b1d-4c2e-9a7f-30e62651d0f5', key: 'k', mime: 'text/plain' }, 'note.txt', NOTES_FOLDER, undefined, () => { unneeded++; });
        h.nativePlugin = false;
        resetNativeDownloadsForTests();
        await saveEncryptedAttachment('blob:x', { id: '5f243cae-0b1d-4c2e-9a7f-30e62651d0f5', key: 'k', mime: 'text/plain' }, 'a.txt', undefined, undefined, () => { unneeded++; });
        expect(disk.files.size, 'both were written from the copy').toBe(2);
        expect(h.saves).toEqual([]);
        expect(unneeded).toBe(0);
    });

    it('a failed save says why in a few words', () => {
        expect(saveFailureNote(Object.assign(new Error('x'), { status: 410, code: 'gone' }))).toBe('no longer on the server');
        expect(saveFailureNote({ status: 404 })).toBe('no longer on the server');
        expect(saveFailureNote({ code: 'network' })).toBe('the connection dropped, try again');
        expect(saveFailureNote({ code: 'decrypt' })).toBe('could not be decrypted');
        expect(saveFailureNote({ code: 'denied' })).toBe('the server refused it');
        expect(saveFailureNote(new Error('disk full'))).toBe('could not save');
        expect(saveFailureNote(null)).toBe('could not save');
    });

    it('a picture\'s Download in the lightbox saves it natively too (a blob anchor saves nothing in the app)', async () => {
        const ref = { id: '6a1b2c3d-0b1d-4c2e-9a7f-30e62651d0f5', key: 'PIC_key', mime: 'image/jpeg' };
        await act(async () => { root.render(<ImageLightbox url="blob:pic" name="photo.jpg" encRef={ref} onClose={() => {}} />); });
        await act(async () => { lightboxDownload().click(); });
        await waitFor(() => h.saves.length === 1, 'the plugin was asked to save the picture');
        expect(h.saves[0].method).toBe('saveAttachment');
        expect(h.saves[0].opts).toMatchObject({ fileId: ref.id, key: 'PIC_key', mime: 'image/jpeg', name: 'photo.jpg', token: 'the-bearer' });
        expect(lightboxDownload().textContent).toMatch(/Saving/);
        await act(async () => { h.saves[0].resolve({ where: 'Pictures/Puca/photo.jpg', uri: 'content://media/z', bytes: 5, container: 'image' }); });
        await settle();
        expect(lightboxDownload().textContent).toMatch(/Saved/);
        expect(lightboxDownload().title).toBe('Saved to Pictures/Puca/photo.jpg');
        expect(disk.calls).toEqual([]);
    });

    it('a picture with no attachment ref (Notes\' own) keeps the plain anchor', async () => {
        const clicks: string[] = [];
        const orig = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicks.push(this.download); };
        try {
            await act(async () => { root.render(<ImageLightbox url="blob:pic" name="note.png" onClose={() => {}} />); });
            await act(async () => { lightboxDownload().click(); });
            await settle();
        } finally {
            HTMLAnchorElement.prototype.click = orig;
        }
        expect(clicks).toEqual(['note.png']);
        expect(h.saves).toEqual([]);
    });

    it('Púca Notes\' own folder keeps the old path', async () => {
        const blob = new Blob([patternBytes(10, 1)]);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(await new Response(blob).arrayBuffer())));
        const r = await saveEncryptedAttachment('blob:x', { id: '5f243cae-0b1d-4c2e-9a7f-30e62651d0f5', key: 'k', mime: 'text/plain' }, 'note.txt', NOTES_FOLDER);
        expect(r.where).toMatch(/^Documents\/Puca Notes\/note-\d{8}-\d{6}\.txt$/);
        expect(h.saves).toEqual([]);
    });
});

describe('Android WITHOUT a usable native plugin keeps the old path', () => {
    const oldPathSaves = async () => {
        const { href, plain } = await sealedClip([1024, 4096, 4096]);
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await act(async () => { downloadButton().click(); });
        for (let i = 0; i < 400 && /Downloading|Saving/.test(downloadButton().textContent ?? ''); i++) await settle(2);
        const saved = container.querySelector('.clip-attachment-saved')?.textContent ?? '';
        expect(saved).toMatch(/^Saved to Documents\/Puca\/puca-clip-0000abcd-\d{8}-\d{6}\.mp4$/);
        expect(disk.read(saved.replace(/^Saved to Documents\//, ''))!.equals(plain)).toBe(true);
        expect(h.saves).toEqual([]);
    };

    it('an older APK (no SovereignDownloads plugin): never even asked', async () => {
        h.nativePlugin = false;
        await oldPathSaves();
        expect(h.statusCalls).toBe(0);
    });

    it('an APK built for another server', async () => {
        h.status = { version: 1, supported: true, apiBase: 'https://some-other-server.example' };
        await oldPathSaves();
    });

    it('an APK with no pinned server', async () => {
        h.status = { version: 1, supported: true, apiBase: null };
        await oldPathSaves();
    });

    it('Android 9 and older', async () => {
        h.status = { version: 1, supported: false, apiBase: 'http://localhost:3000' };
        await oldPathSaves();
    });

    it('an older APK saves a picture from the lightbox into Documents/Puca instead of nothing', async () => {
        h.nativePlugin = false;
        const bytes = patternBytes(64, 3);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
        await act(async () => { root.render(<ImageLightbox url="blob:pic" name="photo.jpg" encRef={{ id: '6a1b2c3d-0b1d-4c2e-9a7f-30e62651d0f5', key: 'k', mime: 'image/jpeg' }} onClose={() => {}} />); });
        await act(async () => { lightboxDownload().click(); });
        await waitFor(() => /Saved/.test(lightboxDownload().textContent ?? ''), 'saved on the old path');
        expect(lightboxDownload().title).toMatch(/^Saved to Documents\/Puca\/photo-\d{8}-\d{6}\.jpg$/);
        expect(h.saves).toEqual([]);
    });

    it('Cancel on the old path stops the fetches and leaves no partial file', async () => {
        h.nativePlugin = false;
        const { href } = await sealedClip([1024, 3 * 1024 * 1024, 3 * 1024 * 1024, 3 * 1024 * 1024]);
        // hold part 2's response until after the Cancel
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const realFetch = globalThis.fetch;
        vi.stubGlobal('fetch', vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
            if (String(u).endsWith(served.size ? [...served.keys()][2] : 'x')) {
                await gate;
                if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
            }
            return (realFetch as (u: string | URL | Request, i?: RequestInit) => Promise<Response>)(u, init);
        }));
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await act(async () => { downloadButton().click(); });
        await waitFor(() => fetched.length >= 2, 'the first parts were fetched');
        await act(async () => { cancelButton()!.click(); });
        release();
        for (let i = 0; i < 400 && /Downloading|Saving/.test(downloadButton().textContent ?? ''); i++) await settle(2);
        expect(downloadButton().textContent).toMatch(/^\s*Download$/);
        expect(container.textContent).not.toMatch(/Download failed/);
        expect(fetched.length, 'part 3 was never requested').toBeLessThan(4);
        expect(disk.files.size, 'no .part and no partial clip left behind').toBe(0);
    });
});
