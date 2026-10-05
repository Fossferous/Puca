/**
 * `GET /files/:id` echoes back the Content-Type the UPLOADER put in the
 * multipart part (`src/upload_handlers.rs` stores `field.content_type()`
 * verbatim), so the type on the response is attacker-chosen. `res.blob()`
 * inherits it, and a `blob:` document inherits THIS app's origin — the origin
 * holding the JWT and the E2EE seed.
 *
 * Today every consumer feeds these URLs to `<img>` or `Audio`, where a
 * `text/html` blob is inert. That is one careless consumer away from stored
 * XSS, and the sibling path (decrypted attachments) has normalised its blob
 * type since the audit that found the same shape. This pins the normalisation
 * here so the two paths cannot drift apart again.
 *
 * And what `<img>` gets is a `data:` URL, never a Blob: these are kept for the
 * whole session, and a Blob kept that long kept released pictures' PLAINTEXT
 * in Chromium's blob_storage (a page file is deleted only once every blob in
 * it is gone; review 2026-10-05). The real disk: e2e/plaintext-disk-real-browser.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));

import { fetchFileUrl, fetchFileObjectUrl, cachedFileUrl, clearFileCache } from '../api/authedMedia';

/** The Blob handed to URL.createObjectURL for each call, in order. */
const seen: Blob[] = [];
const revoked: string[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

/** A response whose Content-Type is whatever the uploader claimed. */
function served(type: string, body: Uint8Array = new Uint8Array([1, 2, 3])): Response {
    return new Response(body.slice(), { headers: { 'Content-Type': type } });
}
const typeOf = (dataUrl: string | null) => /^data:([^;,]*);base64,/.exec(dataUrl ?? '')?.[1];
const bytesOf = (dataUrl: string | null) => Array.from(Buffer.from((dataUrl ?? '').split(',')[1] ?? '', 'base64'));

beforeEach(() => {
    seen.length = 0;
    revoked.length = 0;
    clearFileCache();
    globalThis.URL.createObjectURL = vi.fn((b: Blob) => {
        seen.push(b);
        return `blob:${seen.length}`;
    }) as never;
    globalThis.URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); }) as never;
});

afterEach(() => {
    fetchSpy?.mockRestore();
    clearFileCache();
});

describe('fetchFileUrl normalises the type it was handed', () => {
    it('neutralises a text/html avatar — the account-takeover case', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('text/html'));
        const url = await fetchFileUrl('evil-id');
        expect(typeOf(url)).toBe('application/octet-stream');
    });

    it('neutralises SVG, which is an image but a scriptable document', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('image/svg+xml'));
        expect(typeOf(await fetchFileUrl('svg-id'))).toBe('application/octet-stream');
    });

    it('leaves the renderable types alone, so nothing that worked stops working', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('image/png'));
        expect(typeOf(await fetchFileUrl('png-id'))).toBe('image/png');
        fetchSpy.mockImplementation(async () => served('image/gif; charset=binary'));
        expect(typeOf(await fetchFileUrl('gif-id'))).toBe('image/gif');
    });

    it('keeps the bytes while re-typing them', async () => {
        const body = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff); // longer than one base64 chunk
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('text/html', body));
        expect(bytesOf(await fetchFileUrl('bytes-id'))).toEqual(Array.from(body));
    });
});

describe('what an <img> gets is never a Blob', () => {
    it('a data: URL, and no object URL is made', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('image/png'));
        const url = await fetchFileUrl('avatar');
        expect(url?.startsWith('data:image/png;base64,')).toBe(true);
        expect(seen).toEqual([]);
    });

    it('fetched once, then from the cache; sign-out forgets it', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('image/png'));
        const a = await fetchFileUrl('avatar');
        expect(await fetchFileUrl('avatar')).toBe(a);
        expect(cachedFileUrl('avatar')).toBe(a);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        clearFileCache();
        expect(cachedFileUrl('avatar')).toBeNull();
    });

    it('the cache is bounded by size as well as count: the oldest go first', async () => {
        // 12 MiB files make 16 MiB of text each: the 44 MiB budget holds two.
        const big = new Uint8Array(12 * 1024 * 1024);
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('image/png', big));
        for (const id of ['a', 'b', 'c']) await fetchFileUrl(id);
        expect(cachedFileUrl('a')).toBeNull();
        expect(cachedFileUrl('b')).not.toBeNull();
        expect(cachedFileUrl('c')).not.toBeNull();
    });
});

describe('a sound for a one-off <audio> (fetchFileObjectUrl)', () => {
    it('is a blob: URL of the re-typed bytes, never cached, and goes when released', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('audio/ogg'));
        const clip = await fetchFileObjectUrl('ogg-id');
        expect(clip?.url).toBe('blob:1');
        expect(seen[0].type).toBe('audio/ogg');
        expect(seen[0].size).toBe(3);
        expect(cachedFileUrl('ogg-id')).toBeNull();
        clip!.release();
        clip!.release();
        expect(revoked).toEqual(['blob:1']);
    });

    it('neutralises a text/html one as well', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('text/html'));
        await fetchFileObjectUrl('evil-id');
        expect(seen[0].type).toBe('application/octet-stream');
    });
});
