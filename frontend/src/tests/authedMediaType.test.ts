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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));

import { fetchFileUrl, clearFileCache } from '../api/authedMedia';

/** The Blob handed to URL.createObjectURL for each call, in order. */
const seen: Blob[] = [];
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

/** A response whose Content-Type is whatever the uploader claimed. */
function served(type: string): Response {
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': type } });
}

beforeEach(() => {
    seen.length = 0;
    clearFileCache();
    globalThis.URL.createObjectURL = vi.fn((b: Blob) => {
        seen.push(b);
        return `blob:${seen.length}`;
    }) as never;
    globalThis.URL.revokeObjectURL = vi.fn() as never;
});

afterEach(() => {
    fetchSpy?.mockRestore();
    clearFileCache();
});

describe('fetchFileUrl normalises the blob type it was handed', () => {
    it('neutralises a text/html avatar — the account-takeover case', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('text/html'));
        const url = await fetchFileUrl('evil-id');
        expect(url).toBe('blob:1');
        expect(seen[0].type).toBe('application/octet-stream');
    });

    it('neutralises SVG, which is an image but a scriptable document', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('image/svg+xml'));
        await fetchFileUrl('svg-id');
        expect(seen[0].type).toBe('application/octet-stream');
    });

    it('leaves the renderable types alone, so nothing that worked stops working', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('image/png'));
        await fetchFileUrl('png-id');
        expect(seen[0].type).toBe('image/png');

        fetchSpy.mockImplementation(async () => served('audio/ogg'));
        await fetchFileUrl('ogg-id');
        expect(seen[1].type).toBe('audio/ogg');
    });

    it('keeps the bytes while re-typing them (jsdom Blob has no arrayBuffer, so: size)', async () => {
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => served('text/html'));
        await fetchFileUrl('bytes-id');
        expect(seen[0].size).toBe(3);
    });
});
