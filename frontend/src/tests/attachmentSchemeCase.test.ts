/**
 * URL schemes are case-insensitive, and this app has two of its own that carry
 * KEY MATERIAL in the href: `sovereign-enc:` (the per-file AES key) and
 * `sovereign-clip:` (the packed clip manifest, which IS the key).
 *
 * `utils/messageParser.ts`'s `isSafeUrl` lowercases the scheme before consulting
 * its allowlist, so `SOVEREIGN-ENC:id?k=KEY` was judged SAFE — while every
 * recogniser downstream compared case-sensitively and therefore did not
 * recognise it. The consequences were not theoretical:
 *
 *   - `MessageContent` skipped `EncryptedAttachment` and emitted the ref as a
 *     live `<a href>` / `<img src>`, putting the file key in the DOM;
 *   - `stripAttachmentKeys` (Copy Text, Quote) scrubbed `k=`/`c=` from a
 *     lowercase ref and left an uppercase one intact — the key and the fetch
 *     capability reaching the OS clipboard is exactly what it exists to stop.
 *
 * One canonicalisation, applied by every recogniser. These tests pin it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));

import { isEncAttachment, parseEncAttachment, decryptToBlobUrl, clearBlobCache } from '../api/attachments';
import { isClipRef, isScrubbedClipRef, hasClipRef } from '../api/clips/clipRef';
import { stripAttachmentKeys, scrubClipRefs, replyPreviewText } from '../components/contextMenuUtils';
import { isSafeUrl } from '../utils/messageParser';

describe('the enc scheme is recognised however it is cased', () => {
    it('isSafeUrl and isEncAttachment agree — which is the whole bug', () => {
        for (const href of [
            'sovereign-enc:x?k=K',
            'SOVEREIGN-ENC:x?k=K',
            'Sovereign-Enc:x?k=K',
            'sOvErEiGn-EnC:x?k=K',
        ]) {
            expect(isSafeUrl(href)).toBe(true);
            expect(isEncAttachment(href)).toBe(true);
        }
    });

    it('parseEncAttachment reads the same ref whatever its case', () => {
        const lower = parseEncAttachment('sovereign-enc:abc?k=KEY&m=image%2Fpng&c=CAP');
        const upper = parseEncAttachment('SOVEREIGN-ENC:abc?k=KEY&m=image%2Fpng&c=CAP');
        expect(lower).toEqual({ id: 'abc', key: 'KEY', mime: 'image/png', cap: 'CAP' });
        expect(upper).toEqual(lower);
    });

    it('does not match a scheme that merely starts the same way', () => {
        expect(isEncAttachment('sovereign-encx:abc?k=K')).toBe(false);
        expect(isEncAttachment('https://example.test/sovereign-enc:abc')).toBe(false);
        expect(parseEncAttachment('sovereign-encrypted:abc?k=K')).toBeNull();
    });
});

describe('the clipboard scrub is case-insensitive', () => {
    it('strips the file key and the capability from an UPPERCASE ref', () => {
        const out = stripAttachmentKeys('[a](SOVEREIGN-ENC:x?k=KEY&c=CAP&m=image%2Fpng)');
        expect(out).not.toContain('k=');
        expect(out).not.toContain('c=');
        expect(out).not.toContain('KEY');
        expect(out).not.toContain('CAP');
        expect(out).toContain('m=image%2Fpng');   // the harmless part survives
    });

    it('strips a mixed-case clip payload, which is the clip KEY', () => {
        const href = 'SOVEREIGN-CLIP:v1?AQEBAQEBAQEBAQEB';
        expect(scrubClipRefs(`[Clip 0:05](${href})`)).toBe('[Clip 0:05](sovereign-clip:v1)');
        expect(stripAttachmentKeys(`[Clip 0:05](${href})`)).not.toContain('AQEBAQEBAQEBAQEB');
    });

    it('an uppercase clip ref is still recognised as a clip, not rendered as a link', () => {
        expect(isClipRef('SOVEREIGN-CLIP:v1?AQEB')).toBe(true);
        expect(hasClipRef('look: SOVEREIGN-CLIP:v1?AQEB')).toBe(true);
        expect(isScrubbedClipRef('SOVEREIGN-CLIP:v1')).toBe(true);
        // …and the reply preview summarises it rather than echoing the key.
        expect(replyPreviewText('[Clip](SOVEREIGN-CLIP:v1?AQEB)', 50)).not.toContain('AQEB');
    });
});

/**
 * The decrypted-blob cache used to be keyed on the bare file id, and it
 * short-circuited BEFORE the fetch and before `crypto.subtle.decrypt`. So the
 * AES key stopped being verified on a hit: anyone who learned a file id could
 * post `![x](sovereign-enc:<id>?k=<garbage>)` and, in any session that had
 * already opened that file, the REAL plaintext rendered inside the attacker's
 * message under their chosen display name and MIME.
 */
describe('decryptToBlobUrl keys its cache on everything that determines the bytes', () => {
    let created = 0;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    async function sealed(plaintext: string): Promise<{ key: string; bytes: Uint8Array }> {
        const raw = crypto.getRandomValues(new Uint8Array(32));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, new TextEncoder().encode(plaintext)));
        const key = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const bytes = new Uint8Array(nonce.length + ct.length);
        bytes.set(nonce); bytes.set(ct, nonce.length);
        return { key, bytes };
    }

    beforeEach(() => {
        clearBlobCache();
        created = 0;
        globalThis.URL.createObjectURL = vi.fn(() => `blob:${++created}`) as never;
        globalThis.URL.revokeObjectURL = vi.fn() as never;
    });

    afterEach(() => {
        fetchSpy?.mockRestore();
        clearBlobCache();
    });

    it('a WRONG key for a already-decrypted id re-fetches and fails the AES-GCM tag', async () => {
        const { key, bytes } = await sealed('the real plaintext');
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(bytes));

        const first = await decryptToBlobUrl('same-id', key, 'image/png');
        expect(first).toBe('blob:1');
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // A different key for the SAME id: must not be served the cached URL.
        const wrong = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        await expect(decryptToBlobUrl('same-id', wrong, 'image/png')).rejects.toThrow();
        expect(fetchSpy).toHaveBeenCalledTimes(2);   // it really went back to the server
        expect(created).toBe(1);                     // and produced no second blob
    });

    it('the same id+key+mime still decrypts once (the cache is not defeated)', async () => {
        const { key, bytes } = await sealed('cached');
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(bytes));

        const a = await decryptToBlobUrl('cache-me', key, 'image/png');
        const b = await decryptToBlobUrl('cache-me', key, 'image/png');
        expect(b).toBe(a);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('a different declared MIME gets its own blob, since the Blob type differs', async () => {
        const { key, bytes } = await sealed('typed');
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(bytes));

        const png = await decryptToBlobUrl('typed-id', key, 'image/png');
        const webm = await decryptToBlobUrl('typed-id', key, 'video/webm');
        expect(webm).not.toBe(png);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('MIMEs that normalise to the same Blob type share one entry', async () => {
        const { key, bytes } = await sealed('normalised');
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(bytes));

        // Both become application/octet-stream (safeBlobType), so the bytes and
        // the type are identical and one blob is correct.
        const html = await decryptToBlobUrl('norm-id', key, 'text/html');
        const pdf = await decryptToBlobUrl('norm-id', key, 'application/pdf');
        expect(pdf).toBe(html);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});
