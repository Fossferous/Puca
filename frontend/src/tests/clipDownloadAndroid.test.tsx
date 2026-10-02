/**
 * Download on a posted clip, in the ANDROID app (owner bug: tapping Download
 * closed the app).
 *
 * Driven through the real button in ClipAttachment, with real sealed parts
 * (clipCrypto.sealPart) served as GET /files/:id, so what is asserted is what
 * a phone would do: fetch, decrypt, write. Three properties:
 *
 *   1. No bridge message is larger than BRIDGE_MAX_CHARS. Before the fix the
 *      whole clip was one base64 writeFile (a 92 MB clip = a 128 MB string,
 *      OutOfMemoryError on the UI thread, process killed).
 *   2. It STREAMS: the first part is on disk before the last part has even
 *      been fetched, so JS holds about one part, not the whole clip.
 *   3. The file on disk is the plaintext, byte for byte, and a failure
 *      part-way shows "Download failed" inline and leaves no partial file.
 *
 * The positive control is a clip small enough for one bridge call, which the
 * old code already saved correctly — it shows the harness itself is sound.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fakeCapacitorFs, patternBytes } from './fixtures/fakeCapacitorFs';
import { memoryLocalStorage } from './fixtures/fakeSink';

const BRIDGE_MAX_CHARS = 1024 * 1024;

const h = vi.hoisted(() => ({
    fs: null as ReturnType<typeof import('./fixtures/fakeCapacitorFs').fakeCapacitorFs> | null,
    events: [] as string[],
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => 'android',
        isPluginAvailable: (n: string) => n === 'Filesystem',
        isNativePlatform: () => true,
    },
    registerPlugin: () => ({}),
}));
vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        writeFile: (o: never) => { h.events.push('write'); return h.fs!.api.writeFile(o); },
        appendFile: (o: never) => { h.events.push('write'); return h.fs!.api.appendFile(o); },
        deleteFile: (o: never) => h.fs!.api.deleteFile(o),
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

const CLIP_ID = '0000abcd-0000-4000-8000-000000000001';

let container: HTMLDivElement;
let root: Root;
let disk: ReturnType<typeof fakeCapacitorFs>;
/** id → sealed wire bytes, served by the fetch stub. */
const served = new Map<string, Uint8Array<ArrayBuffer>>();
const blobs = new Map<string, Blob>();

function readBlob(b: Blob): Promise<Uint8Array<ArrayBuffer>> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(b);
    });
}

async function sealedClip(partSizes: number[]): Promise<{ href: string; plain: Buffer }> {
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
    return { href: encodeClipRef(m), plain: Buffer.concat(plains.map(p => Buffer.from(p))) };
}

const settle = async (rounds = 8) => {
    await act(async () => { for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0)); });
};
const downloadButton = () => container.querySelector('button.clip-attachment-download') as HTMLButtonElement;

/** Click Download and wait until the button leaves "Downloading". */
async function clickDownloadAndWait(): Promise<void> {
    await act(async () => { downloadButton().click(); });
    for (let i = 0; i < 2000 && /Downloading/.test(downloadButton().textContent ?? ''); i++) {
        await settle(2);
        await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    }
}

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    disk = fakeCapacitorFs();
    h.fs = disk;
    h.events.length = 0;
    served.clear();
    blobs.clear();
    vi.stubGlobal('fetch', vi.fn(async (u: string | URL | Request) => {
        const url = String(u);
        const part = /\/files\/([0-9a-f-]+)$/.exec(url);
        if (part) {
            h.events.push(`fetch:${part[1]}`);
            const wire = served.get(part[1]);
            return wire ? new Response(wire) : new Response('gone', { status: 404 });
        }
        const b = blobs.get(url);
        if (b) return new Response(await readBlob(b));
        throw new Error(`unexpected fetch ${url}`);
    }));
    URL.createObjectURL = vi.fn((b: Blob) => { const u = `blob:clip/${blobs.size + 1}`; blobs.set(u, b); return u; });
    URL.revokeObjectURL = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe('Android: Download on a clip', () => {
    it('streams a multi-part clip to Documents/Puca in bounded bridge calls, byte for byte', async () => {
        const { href, plain } = await sealedClip([1024, 6 * 1024 * 1024, 6 * 1024 * 1024, 6 * 1024 * 1024, 6 * 1024 * 1024 - 5]);
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await clickDownloadAndWait();

        const saved = container.querySelector('.clip-attachment-saved')?.textContent ?? '';
        expect(container.textContent).not.toMatch(/Download failed/);
        expect(saved).toMatch(/^Saved to Documents\/Puca\/puca-clip-0000abcd-\d{8}-\d{6}\.mp4$/);
        expect(disk.maxChars(), 'largest single bridge message, in characters').toBeLessThanOrEqual(BRIDGE_MAX_CHARS);

        const path = saved.replace(/^Saved to Documents\//, '');
        const onDisk = disk.read(path)!;
        expect(onDisk.length).toBe(plain.length);
        expect(onDisk.equals(plain)).toBe(true);
        expect([...disk.files.keys()]).toEqual([path]);

        // Streaming, not "build the whole clip, then write": the first write
        // happens before the LAST part is fetched.
        const lastFetch = h.events.lastIndexOf(h.events.filter(e => e.startsWith('fetch:')).pop()!);
        expect(h.events.indexOf('write'), `event order: ${h.events.slice(0, 12).join(' ')} …`).toBeLessThan(lastFetch);
    }, 120_000);

    it('a write failing part-way shows the error inline and leaves no partial clip', async () => {
        const { href } = await sealedClip([1024, 3 * 1024 * 1024, 3 * 1024 * 1024]);
        disk.failOn((n) => (n === 3 ? new Error('OS-PLUG-FILE-0013') : null));
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await clickDownloadAndWait();

        expect(container.textContent).toMatch(/Download failed/);
        expect(container.querySelector('.clip-attachment-saved')).toBeNull();
        expect(disk.files.size, 'no partial clip left in Documents/Puca').toBe(0);
    }, 60_000);

    it('a part gone from the server still says "no longer on the server", not a write error', async () => {
        const { href } = await sealedClip([1024, 4096, 4096]);
        served.delete([...served.keys()][2]);
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await clickDownloadAndWait();
        expect(container.textContent).toMatch(/This clip is no longer on the server/);
        expect(disk.files.size).toBe(0);
    });

    it('positive control: a clip small enough for one bridge call saves exactly', async () => {
        const { href, plain } = await sealedClip([1024, 300 * 1024]);
        await act(async () => { root.render(<ClipAttachment href={href} />); });
        await clickDownloadAndWait();
        const saved = container.querySelector('.clip-attachment-saved')?.textContent ?? '';
        expect(saved).toMatch(/^Saved to Documents\/Puca\/puca-clip-0000abcd-\d{8}-\d{6}\.mp4$/);
        expect(disk.maxChars()).toBeLessThanOrEqual(BRIDGE_MAX_CHARS);
        expect(disk.read(saved.replace(/^Saved to Documents\//, ''))!.equals(plain)).toBe(true);
    });
});
