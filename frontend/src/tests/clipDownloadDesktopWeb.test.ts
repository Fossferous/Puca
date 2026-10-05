/**
 * Download on a Púca Clip in the DESKTOP app and on the WEB saves the clip
 * with its duration and a seek index (api/clips/fmp4SaveFix.ts) — the very
 * file the Android app saves for the same clip.
 *
 * Driven through the real saveClip → downloadClipBytes → saveAttachment, with
 * the real sealed parts from download-vectors.json served by a stand-in for
 * GET /files and decrypted by the real openPart. What is checked is the
 * file that leaves the page: the bytes handed to the shell's attachment_save
 * (desktop), and the bytes behind the anchor's blob: URL (web). Both must be
 * byte for byte the `saveFix` case "the real clip" — whose expected output
 * was written by the JAVA save (DownloadVectorsTest) — and not the sealed
 * bytes saved before. Any clip, posted before this change or after, takes
 * this path: the fix happens at download.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

import { saveClip, clipFileName } from '../api/clipDownload';
import type { ClipManifest } from '../api/clips/clipRef';
import { API_BASE_URL } from '../api/config';

const VECTORS = join(__dirname, '..', '..', 'android', 'app', 'src', 'test', 'resources', 'download-vectors.json');
interface V {
    clip: { key: string; noncePrefix: string; clipId: string; durationMs: number; parts: { wire: string }[]; plainSha256: string };
    saveFix: { cases: { name: string; durationMs: number; outSha256: string; outBytes: number }[] };
}
const sha = (u: Uint8Array) => createHash('sha256').update(u).digest('hex');

let v: V;
let manifest: ClipManifest;
const wires = new Map<string, Uint8Array>();
const blobs = new Map<string, Blob>();

beforeAll(() => {
    v = JSON.parse(readFileSync(VECTORS, 'utf8')) as V;
    const ids = v.clip.parts.map((_, i) => `0000000${i}-aaaa-4bbb-8ccc-dddddddddddd`);
    let total = 0;
    v.clip.parts.forEach((p, i) => {
        const wire = new Uint8Array(Buffer.from(p.wire, 'base64'));
        total += wire.byteLength;
        wires.set(ids[i], wire);
    });
    manifest = {
        key: new Uint8Array(Buffer.from(v.clip.key, 'base64')),
        noncePrefix: new Uint8Array(Buffer.from(v.clip.noncePrefix, 'base64')),
        clipId: v.clip.clipId,
        videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2',
        durationMs: v.clip.durationMs, width: 640, height: 360,
        totalCipherBytes: total, parts: ids,
        partDurMs: v.clip.parts.map((_, i) => (i === 0 ? 0 : 1000)),
    };
});

beforeEach(() => {
    h.invokes.length = 0;
    blobs.clear();
    // jsdom's Blob cannot be read back; Node's can (and is what a browser's behaves like here).
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('URL', Object.assign(class extends URL {}, {
        createObjectURL: (b: Blob) => { const u = `blob:test/${blobs.size + 1}`; blobs.set(u, b); return u; },
        revokeObjectURL: () => {},
    }));
    vi.stubGlobal('fetch', async (url: string) => {
        if (url.startsWith('blob:')) return new Response(await blobs.get(url)!.arrayBuffer());
        const m = /\/files\/([0-9a-f-]+)$/.exec(url);
        const wire = m && url.startsWith(API_BASE_URL) ? wires.get(m[1]) : undefined;
        return wire ? new Response(wire.slice()) : new Response('gone', { status: 404 });
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const expected = () => {
    const c = v.saveFix.cases.find((x) => x.name === 'the real clip');
    if (!c) throw new Error('no "the real clip" case in the vectors');
    expect(c.durationMs).toBe(v.clip.durationMs);
    return c;
};

describe('a clip downloaded on desktop and the web is the file the phone saves', () => {
    it('desktop: attachment_save is handed the fixed clip — duration and seek index, not the sealed bytes', async () => {
        h.tauri = true;
        const res = await saveClip(manifest);
        expect(res.onDisk).toBe(true);
        expect(h.invokes.map((i) => i.cmd)).toEqual(['attachment_save']);
        const saved = h.invokes[0];
        expect(decodeURIComponent(saved.headers['x-file-name'])).toBe(clipFileName(manifest));
        expect(saved.bytes).not.toBeNull();
        const bytes = saved.bytes!;
        expect(sha(bytes), 'not the sealed bytes').not.toBe(v.clip.plainSha256);
        expect(bytes.byteLength).toBe(expected().outBytes);
        expect(sha(bytes), 'the file the Android save writes').toBe(expected().outSha256);
    });

    it('web: the anchor\'s blob is the fixed clip, under the clip\'s name', async () => {
        h.tauri = false;
        const clicked: { href: string; download: string }[] = [];
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            clicked.push({ href: this.href, download: this.download });
        });
        const res = await saveClip(manifest);
        expect(res.onDisk).toBe(false);
        expect(clicked).toHaveLength(1);
        expect(clicked[0].download).toBe(clipFileName(manifest));
        const blob = blobs.get(clicked[0].href);
        expect(blob, 'the anchor points at the blob saveClip made').toBeDefined();
        expect(blob!.type).toBe('video/mp4');
        const bytes = new Uint8Array(await blob!.arrayBuffer());
        expect(sha(bytes), 'not the sealed bytes').not.toBe(v.clip.plainSha256);
        expect(sha(bytes), 'the file the Android save writes').toBe(expected().outSha256);
    });

    it('a part the server no longer has still fails the download with its status (nothing half-fixed is saved)', async () => {
        h.tauri = true;
        const broken = { ...manifest, parts: [...manifest.parts.slice(0, -1), 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd'] };
        await expect(saveClip(broken)).rejects.toMatchObject({ status: 404 });
        expect(h.invokes).toHaveLength(0);
    });
});
