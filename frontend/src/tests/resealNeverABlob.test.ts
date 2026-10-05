/**
 * An attachment decrypted only to be sealed again under a fresh key — a
 * message captured into a note (copyRefsIntoMyNote), a note copied
 * (resealRefs) — must never become a File or Blob on the way.
 *
 * A File made from bytes is a page Blob, and Chromium writes a page's blobs
 * beyond its in-memory limit (1% of the RAM in the Android WebView, so a
 * single 22 MB video) to <profile>/Default/blob_storage AS THEY ARE, where
 * the plaintext stays until the page next collects garbage — in the
 * background too, and after a kill until the next start (review finding,
 * 2026-10-05; docs/SECURITY_MODEL.md, *Decrypted attachments on your own
 * storage*). Both paths used to do exactly that: `new File([bytes])`.
 *
 * Every Blob and File constructed is recorded here (bytes copied at the
 * time), and none may hold the plaintext; the POSITIVE CONTROL is that the
 * real seal ran on those very bytes: what was uploaded opens, under the key
 * in the new ref, to the plaintext.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PLAIN = 'PUCA-RESEAL-PLAINTEXT-MARK';
const plaintextOf = (id: string) => new TextEncoder().encode(`${PLAIN}:${id}:`.repeat(200));
const H = vi.hoisted(() => ({
    uploaded: [] as unknown[],
    decrypted: [] as Uint8Array[],
}));
vi.mock('../api/attachments', async (orig) => {
    const real = await orig<typeof import('../api/attachments')>();
    return {
        ...real,
        // What the cache hands back: the caller's own buffer.
        decryptAttachmentBytes: vi.fn(async (id: string) => {
            const b = plaintextOf(id);
            H.decrypted.push(b);
            return b;
        }),
    };
});
vi.mock('../api/uploads', async (orig) => {
    const real = await orig<typeof import('../api/uploads')>();
    return {
        ...real,
        uploadFile: vi.fn(async (file: File) => {
            H.uploaded.push(file);
            return { id: `copy${H.uploaded.length}`, cap: `cap${H.uploaded.length}` };
        }),
    };
});
vi.mock('../api/listContent', async (orig) => ({ ...(await orig<typeof import('../api/listContent')>()), deleteFiles: vi.fn(async () => {}) }));

import { copyRefsIntoMyNote } from '../api/captureToNote';
import { resealRefs } from '../api/noteMedia';
import { parseEncAttachment } from '../api/attachments';

/** Every Blob/File made, with a copy of its byte parts as they were then. */
const made = new Map<Blob, unknown[]>();
const snapshot = (p: unknown) => (ArrayBuffer.isView(p) ? new Uint8Array(p.buffer, p.byteOffset, p.byteLength).slice()
    : p instanceof ArrayBuffer ? new Uint8Array(p).slice() : p);
const RealBlob = globalThis.Blob;
const RealFile = globalThis.File;
// jsdom's Blob has no arrayBuffer(): these read back what they were made of.
class SpyBlob extends RealBlob {
    constructor(parts?: BlobPart[], opts?: BlobPropertyBag) { super(parts, opts); made.set(this, (parts ?? []).map(snapshot)); }
    override async arrayBuffer(): Promise<ArrayBuffer> { return bytesOf(this).slice().buffer; }
}
class SpyFile extends RealFile {
    constructor(parts: BlobPart[], name: string, opts?: FilePropertyBag) { super(parts, name, opts); made.set(this, parts.map(snapshot)); }
    override async arrayBuffer(): Promise<ArrayBuffer> { return bytesOf(this).slice().buffer; }
}
/** The bytes of a recorded Blob, its Blob parts expanded. */
function bytesOf(b: unknown): Uint8Array {
    const parts = made.get(b as Blob);
    if (!parts) throw new Error('not a recorded Blob');
    const chunks = parts.map((p) => (p instanceof Uint8Array ? p : typeof p === 'string' ? new TextEncoder().encode(p) : bytesOf(p)));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
}
const holdsPlaintext = (u: Uint8Array) => new TextDecoder('latin1').decode(u).includes(PLAIN);

async function opened(uploadedFile: unknown, href: string): Promise<string> {
    const sealed = bytesOf(uploadedFile);
    const keyB64 = parseEncAttachment(href)!.key.replace(/-/g, '+').replace(/_/g, '/');
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(keyB64.padEnd(Math.ceil(keyB64.length / 4) * 4, '=')), (c) => c.charCodeAt(0)), 'AES-GCM', false, ['decrypt']);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, key, sealed.slice(12)));
}

const src = (n: number) => ({ href: `sovereign-enc:SRC${n}?k=THEIRKEY${n}&m=video%2Fmp4&c=THEIRCAP${n}`, name: `clip${n}.mp4` });

beforeEach(() => {
    made.clear();
    H.uploaded.length = 0;
    H.decrypted.length = 0;
    vi.stubGlobal('Blob', SpyBlob);
    vi.stubGlobal('File', SpyFile);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe.each([
    ['a message captured into a note (copyRefsIntoMyNote)', (refs: Array<{ href: string; name: string }>) => copyRefsIntoMyNote(refs)],
    ['a note copied (resealRefs)', (refs: Array<{ href: string; name: string }>) => resealRefs(refs)],
])('%s', (_what, reseal) => {
    it('never puts the plaintext in a Blob or File, and frees it once sealed', async () => {
        const out = await reseal([src(1), src(2)]);
        expect(out).toHaveLength(2);
        const withPlain = [...made.values()].filter((parts) => parts.some((p) => p instanceof Uint8Array && holdsPlaintext(p)));
        expect(withPlain, 'a Blob or File was made of the plaintext').toEqual([]);
        // Its memory went back once it was sealed, not at the next GC.
        expect(H.decrypted.map((b) => b.byteLength)).toEqual([0, 0]);
    });

    it('POSITIVE CONTROL: the real seal ran on those bytes (what was uploaded opens to them)', async () => {
        const out = await reseal([src(1), src(2)]);
        expect(H.uploaded).toHaveLength(2);
        expect(await opened(H.uploaded[0], out[0].href)).toBe(new TextDecoder().decode(plaintextOf('SRC1')));
        expect(await opened(H.uploaded[1], out[1].href)).toBe(new TextDecoder().decode(plaintextOf('SRC2')));
        expect(parseEncAttachment(out[0].href)!.mime).toBe('video/mp4');
        expect(out[0].name).toBe('clip1.mp4');
    });
});
