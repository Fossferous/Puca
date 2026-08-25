/**
 * Copy-image: the decisions, and the one path that can be exercised in jsdom.
 *
 * The message row's onContextMenu calls preventDefault, so the WebView's own
 * "Copy image" never appears on an image inside a message. These items are the
 * only way to copy a picture, which makes two things load-bearing:
 *
 *  - the item must APPEAR when (and only when) the right-click landed on an
 *    image, and
 *  - "Copy Image Link" must never be offered for a `blob:` URL. Those are
 *    handles into this document — dead everywhere else — so copying one hands
 *    the user a string that looks like a link and can never work. Encrypted
 *    attachments are all blob URLs, so this is the common case, not an edge.
 *
 * jsdom has no decoder or canvas, so those are stubbed here to pin that the
 * re-encode HAPPENS and that the clipboard receives its output. Whether the
 * output is the right PIXELS is proven in real Chromium by
 * e2e/copy-image-live.mjs, which checks dimensions, opacity and colour — a
 * blank canvas is still a valid PNG and would pass anything weaker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    canCopyImageLink,
    canCopyImages,
    copyImageToClipboard,
} from '../api/copyImage';
import { imageMenuItems, imageSrcFromTarget } from '../components/contextMenuUtils';

const BLOB = 'blob:http://localhost:5173/9f0c-abc';
const REMOTE = 'https://example.com/cat.png';

/** A stand-in for a right-clicked <img>. */
function imgEl(src: string, currentSrc?: string): HTMLImageElement {
    const el = document.createElement('img');
    el.setAttribute('src', src);
    if (currentSrc) Object.defineProperty(el, 'currentSrc', { value: currentSrc });
    return el;
}

describe('imageSrcFromTarget', () => {
    it('returns the src for an image', () => {
        expect(imageSrcFromTarget(imgEl(REMOTE))).toBe(REMOTE);
    });

    it('returns null for anything that is not an image', () => {
        expect(imageSrcFromTarget(document.createElement('div'))).toBeNull();
        expect(imageSrcFromTarget(document.createElement('span'))).toBeNull();
        expect(imageSrcFromTarget(null)).toBeNull();
    });

    it('prefers currentSrc — the variant actually on screen', () => {
        expect(imageSrcFromTarget(imgEl('/small.png', '/large.png'))).toBe('/large.png');
    });
});

describe('canCopyImageLink', () => {
    it('refuses blob: URLs', () => {
        // The one that matters for usability: every E2EE attachment is a blob
        // URL, and one copied out of this document resolves to nothing.
        expect(canCopyImageLink(BLOB)).toBe(false);
    });
    it('refuses data: URIs', () => {
        expect(canCopyImageLink('data:image/png;base64,iVBOR')).toBe(false);
    });
    it('allows a real remote URL', () => {
        expect(canCopyImageLink(REMOTE)).toBe(true);
        expect(canCopyImageLink('http://example.com/a.png')).toBe(true);
    });

    // SECURITY. `sovereign-enc:` hrefs carry the per-file AES-256-GCM key in
    // `?k=`. They normally never reach an <img src> — MessageContent diverts
    // them to the decrypting component — but that check is case-SENSITIVE
    // (`href.startsWith('sovereign-enc:')`) while isSafeUrl lowercases the
    // scheme before testing its allowlist. So an UPPERCASE variant slips past
    // the diversion, renders as a plain <img>, and the original denylist
    // (!blob && !data) would have offered to copy the key to the OS clipboard.
    it('refuses sovereign-enc: in any case — it carries the decryption key', () => {
        expect(canCopyImageLink('sovereign-enc:abc?k=SECRETKEY&m=image%2Fpng')).toBe(false);
        expect(canCopyImageLink('SOVEREIGN-ENC:abc?k=SECRETKEY&m=image%2Fpng')).toBe(false);
        expect(canCopyImageLink('Sovereign-Enc:abc?k=SECRETKEY')).toBe(false);
    });

    it('refuses every other scheme by default', () => {
        // An allowlist, so a scheme added later is excluded until considered.
        for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'ftp://h/x.png', '']) {
            expect(canCopyImageLink(u)).toBe(false);
        }
    });
});

describe('imageMenuItems', () => {
    const noop = () => {};

    beforeEach(() => {
        vi.stubGlobal('ClipboardItem', class {});
        Object.defineProperty(navigator, 'clipboard', {
            value: { write: vi.fn(), writeText: vi.fn() },
            configurable: true,
        });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('is empty when the click was not on an image', () => {
        // Spread into a menu unconditionally, so "empty" is the contract.
        expect(imageMenuItems(document.createElement('div'), noop)).toEqual([]);
    });

    it('offers copy AND link for a remote image', () => {
        const ids = imageMenuItems(imgEl(REMOTE), noop).map(i => i.id);
        expect(ids).toEqual(['copy-image', 'copy-image-link', 'separator']);
    });

    it('offers copy but NOT link for a blob attachment', () => {
        const ids = imageMenuItems(imgEl(BLOB), noop).map(i => i.id);
        expect(ids).toEqual(['copy-image', 'separator']);
        expect(ids).not.toContain('copy-image-link');
    });

    // Each condition is removed INDEPENDENTLY. Doing both at once (the first
    // version of this test) proves nothing: jsdom ships no ClipboardItem, so
    // canCopyImages() was already false and the navigator.clipboard line was
    // decorative — the guard could have been reduced to a single check and the
    // test would still have passed.
    it('hides the copy item when ClipboardItem is missing (clipboard present)', () => {
        vi.stubGlobal('ClipboardItem', undefined);
        expect(canCopyImages()).toBe(false);
        expect(imageMenuItems(imgEl(REMOTE), noop).map(i => i.id)).not.toContain('copy-image');
    });

    it('hides the copy item when navigator.clipboard is missing (ClipboardItem present)', () => {
        // The real shape of a non-secure context: `navigator.clipboard` is
        // undefined outright, not a rejecting promise.
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        expect(canCopyImages()).toBe(false);
        expect(imageMenuItems(imgEl(REMOTE), noop).map(i => i.id)).not.toContain('copy-image');
    });

    it('hides the copy item when clipboard.write is missing', () => {
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn() }, configurable: true });
        expect(canCopyImages()).toBe(false);
        expect(imageMenuItems(imgEl(REMOTE), noop).map(i => i.id)).not.toContain('copy-image');
    });

    it('still offers the link without image support — and reports if it fails', () => {
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        const items = imageMenuItems(imgEl(REMOTE), noop);
        const link = items.find(i => i.id === 'copy-image-link');
        expect(link).toBeDefined();

        // Asserting the row EXISTS is not the same as it working. With no
        // clipboard at all, its handler dereferences undefined — so without a
        // guard this throws into React's event handler, the menu never closes,
        // and nothing tells the user. Invoke it.
        const notices: string[] = [];
        const guarded = imageMenuItems(imgEl(REMOTE), m => notices.push(m))
            .find(i => i.id === 'copy-image-link')!;
        expect(() => guarded.onClick!()).not.toThrow();
        expect(notices).toEqual(['Couldn’t write to the clipboard.']);
    });
});

describe('copyImageToClipboard', () => {
    let write: ReturnType<typeof vi.fn>;
    let written: unknown[];

    beforeEach(() => {
        written = [];
        write = vi.fn(async (items: unknown[]) => {
            // Resolve the promise values, exactly as a real implementation must.
            for (const item of items as Array<{ types: string[]; data: Record<string, Promise<Blob>> }>) {
                for (const type of item.types) written.push({ type, blob: await item.data[type] });
            }
        });
        vi.stubGlobal('ClipboardItem', class {
            types: string[];
            data: Record<string, Promise<Blob>>;
            constructor(d: Record<string, Promise<Blob>>) {
                this.data = d;
                this.types = Object.keys(d);
            }
        });
        Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    /**
     * jsdom has no decoder or canvas, so stand them in. The point is not to
     * verify the pixels — e2e/copy-image-live.mjs does that in real Chromium,
     * including that the output keeps the source's dimensions and colour — but
     * to pin that the re-encode HAPPENS. A previous version short-circuited on
     * `source.type === 'image/png'`, and the test then asserted only that the
     * blob it had built itself came back out, which would have passed with the
     * whole canvas path deleted.
     */
    function stubDecoder() {
        const closed = { count: 0 };
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: 8, height: 4, close: () => { closed.count++; },
        })));
        const drawn: unknown[] = [];
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            drawImage: (...a: unknown[]) => { drawn.push(a); },
        } as unknown as CanvasRenderingContext2D);
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
            cb(new Blob([new Uint8Array(99)], { type: 'image/png' }));
        } as HTMLCanvasElement['toBlob']);
        return { closed, drawn };
    }

    it('re-encodes and puts the result on the clipboard', async () => {
        const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => jpeg })));
        const { closed, drawn } = stubDecoder();

        const out = await copyImageToClipboard(BLOB);

        expect(out).toEqual({ ok: true });
        // CONTROL: {ok:true} alone passes on an implementation that never
        // writes. Assert the clipboard got the RE-ENCODED blob (99 bytes from
        // the stub), not the 3-byte JPEG that went in.
        expect(write).toHaveBeenCalledTimes(1);
        const got = written[0] as { type: string; blob: Blob };
        expect(got.type).toBe('image/png');
        expect(got.blob.type).toBe('image/png');
        expect(got.blob.size).toBe(99);
        expect(drawn).toHaveLength(1);
        // The bitmap must be released whichever way toBlob went.
        expect(closed.count).toBe(1);
    });

    it('re-encodes even when the blob already CLAIMS to be a PNG', async () => {
        // The type is attacker-controlled for E2EE attachments: it comes from
        // the `m=` parameter the sender wrote into the href, and safeBlobType
        // passes any image/* through verbatim. Trusting it fed undecodable
        // bytes to the clipboard and blamed the clipboard for refusing them.
        const liar = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => liar })));
        stubDecoder();

        expect(await copyImageToClipboard(BLOB)).toEqual({ ok: true });
        // 99 bytes proves it went through the decoder rather than straight out.
        expect((written[0] as { blob: Blob }).blob.size).toBe(99);
    });

    it('reports decode-failed when the bytes are not a real image', async () => {
        const junk = new Blob(['definitely not an image'], { type: 'image/png' });
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => junk })));
        vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('bad image'); }));
        expect(await copyImageToClipboard(BLOB)).toEqual({ ok: false, reason: 'decode-failed' });
    });

    it('reports fetch-failed when the host refuses CORS', async () => {
        // A cross-origin image with no CORS headers rejects the fetch. This is
        // not a bug the app can fix, so it must be distinguishable from a
        // clipboard denial — the caller offers "Copy Image Link" instead.
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        expect(await copyImageToClipboard(REMOTE)).toEqual({ ok: false, reason: 'fetch-failed' });
        // write() IS called — the ClipboardItem is built around a pending
        // promise so it exists inside the user gesture (WebKit requires that).
        // The failure surfaces when that promise rejects.
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('still says fetch-failed when the engine WRAPS the rejection', async () => {
        // Chromium does not propagate a ClipboardItem promise's rejection: it
        // rejects write() with its own DOMException and the original cause is
        // lost. A mock that re-throws the original (the test above) cannot
        // detect that, and the first implementation here read the reason off
        // the caught error — so every CORS failure in a real browser was
        // reported as "the clipboard refused the image".
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        write.mockImplementationOnce(async (items: Array<{ types: string[]; data: Record<string, Promise<Blob>> }>) => {
            try {
                await items[0].data['image/png'];
            } catch {
                throw new DOMException('Failed to write ClipboardItem', 'DataError');
            }
        });
        expect(await copyImageToClipboard(REMOTE)).toEqual({ ok: false, reason: 'fetch-failed' });
    });

    it('reports fetch-failed on a non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob() })));
        expect(await copyImageToClipboard(REMOTE)).toEqual({ ok: false, reason: 'fetch-failed' });
    });

    it('reports denied when the clipboard itself refuses', async () => {
        const png = new Blob([new Uint8Array([1])], { type: 'image/png' });
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => png })));
        stubDecoder();
        write.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
        expect(await copyImageToClipboard(BLOB)).toEqual({ ok: false, reason: 'denied' });
    });

    it('reports unsupported without touching the network', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        expect(await copyImageToClipboard(BLOB)).toEqual({ ok: false, reason: 'unsupported' });
        // Downloading bytes we cannot use would be pure waste on a slow link.
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
