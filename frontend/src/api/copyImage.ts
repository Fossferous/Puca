/**
 * Copy an image to the OS clipboard.
 *
 * WHY THIS IS NOT JUST `navigator.clipboard.write`:
 *
 * 1. PNG ONLY. Every engine that supports writing images to the clipboard
 *    accepts `image/png` and essentially nothing else — a JPEG, GIF or WebP
 *    blob handed straight to ClipboardItem is rejected. Attachments here are
 *    whatever the sender uploaded, so almost everything needs re-encoding.
 *
 * 2. CANVAS TAINTING, avoided by construction. The obvious implementation
 *    draws the on-screen <img> onto a canvas, which taints it for any
 *    cross-origin image and makes `toBlob` throw SecurityError. Fetching the
 *    BYTES first and decoding them with createImageBitmap sidesteps that
 *    entirely: a canvas drawn from a Blob we already hold is never tainted,
 *    whatever its origin. The only remaining cross-origin obstacle is the
 *    fetch, and a host that refuses CORS is reported as such rather than
 *    silently producing a blank image.
 *
 * 3. SAFARI'S GESTURE RULE. WebKit requires the ClipboardItem to be created
 *    during the user gesture that triggered it; awaiting a fetch first loses
 *    the gesture and the write is denied. Passing a *promise* as the item's
 *    value is the portable way round it, and Chromium (WebView2 on desktop,
 *    the Android WebView on mobile) accepts the same form — so there is one
 *    code path, not a per-engine branch.
 *
 * Nothing here needs a Tauri or Capacitor plugin: no clipboard plugin is
 * registered (frontend/src-tauri/capabilities/default.json lists only
 * core/process/updater/notification), and none is required, because all three
 * shells run a WebView with the async clipboard API and a secure context.
 */

/** Why a copy failed, in terms a caller can turn into a useful message. */
export type CopyImageFailure =
    | 'unsupported'   // this engine cannot write images to the clipboard at all
    | 'fetch-failed'  // couldn't get the bytes (usually a cross-origin host with no CORS)
    | 'decode-failed' // got bytes, but they aren't a decodable image
    | 'denied';       // the clipboard write itself was refused

export type CopyImageOutcome = { ok: true } | { ok: false; reason: CopyImageFailure };

/** Deadline for retrieving the bytes. See the fetch call for why. */
const FETCH_TIMEOUT_MS = 15_000;

class StageError extends Error {
    // Declared explicitly rather than as a constructor parameter property:
    // `erasableSyntaxOnly` is on, and that rule fires only in `npm run build`,
    // not in `tsc --noEmit`.
    stage: CopyImageFailure;
    constructor(stage: CopyImageFailure) {
        super(stage);
        this.stage = stage;
    }
}

/**
 * Whether this engine can put an IMAGE on the clipboard.
 *
 * Deliberately does not probe `clipboard.write` — calling it to find out would
 * itself need a user gesture. Feature detection only, so it is safe to call
 * while building a menu.
 */
export function canCopyImages(): boolean {
    return typeof navigator !== 'undefined'
        && !!navigator.clipboard
        && typeof navigator.clipboard.write === 'function'
        && typeof ClipboardItem !== 'undefined';
}

/**
 * Whether "Copy Image Link" is meaningful for this URL.
 *
 * ALLOWLIST, not a denylist, and that distinction is a security boundary.
 *
 * The first version excluded `blob:` and `data:` and allowed everything else,
 * which let `sovereign-enc:` through — and those hrefs carry the per-file
 * AES-256-GCM key in `?k=`. That was not hypothetical: `isEncAttachment` used to
 * match case-SENSITIVELY while `isSafeUrl` lowercases the scheme before testing
 * its allowlist, so `SOVEREIGN-ENC:id?k=…` was diverted away from the decrypting
 * component and rendered as a plain `<img src>`. Copying that "link" would have
 * put a live decryption key on the OS clipboard — precisely the escape
 * `stripAttachmentKeys` exists to stop. The prefix recognisers are now
 * case-insensitive (`encPrefixMatch` in api/attachments.ts), so that particular
 * divergence is closed; this allowlist stays because it is the control that does
 * not depend on two functions agreeing.
 *
 * A link is only shareable if it is http(s), so nothing else is offered. Any
 * future scheme is excluded by default rather than by remembering to add it.
 */
export function canCopyImageLink(url: string): boolean {
    return /^https?:\/\//i.test(url || '');
}

/**
 * Re-encode to PNG, the only format the clipboard reliably accepts.
 *
 * Always decodes, even when the blob already claims `image/png`. That claim is
 * not trustworthy: for an E2EE attachment the type comes from the `m=` query
 * parameter the SENDER wrote into the href, and `safeBlobType` passes any
 * `image/*` value through verbatim. Short-circuiting on it handed unvalidated
 * bytes straight to ClipboardItem, where the engine rejected them and the user
 * was told the clipboard had refused — blaming the wrong thing. Decoding first
 * both normalises the format and validates that it is an image at all.
 */
async function toPngBlob(source: Blob): Promise<Blob> {
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(source);
    } catch {
        throw new StageError('decode-failed');
    }

    try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new StageError('decode-failed');
        // An animated GIF or WebP yields its FIRST FRAME. That is what every
        // other app does on "copy image" — the clipboard has no animated image
        // format — and a still frame is a better outcome than refusing.
        ctx.drawImage(bitmap, 0, 0);
        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
                b => (b ? resolve(b) : reject(new StageError('decode-failed'))),
                'image/png',
            );
        });
    } finally {
        bitmap.close();
    }
}

/**
 * Put the image at `url` on the clipboard as a PNG.
 *
 * Must be called from a user gesture (a click handler); see the Safari note in
 * the file header for why the ClipboardItem is built around a promise rather
 * than an awaited blob.
 */
export async function copyImageToClipboard(url: string): Promise<CopyImageOutcome> {
    if (!canCopyImages()) return { ok: false, reason: 'unsupported' };

    // Recorded out-of-band rather than read back off the error, because the
    // error does not survive. When a ClipboardItem's promise rejects, Chromium
    // rejects write() with its OWN DOMException — the original cause is gone.
    // Classifying from the caught error therefore reported every CORS failure
    // as a clipboard denial, and the user got "the clipboard refused the image"
    // instead of "try Copy Image Link". A jsdom mock that re-throws the
    // original hides this completely; only a wrapped-rejection test catches it.
    let failedAt: CopyImageFailure | null = null;

    // Started synchronously so the ClipboardItem exists inside the gesture.
    const png = (async () => {
        let response: Response;
        try {
            // A host that accepts the connection and then never answers is
            // routine on mobile (radio hand-off, captive portal). Without a
            // deadline the promise never settles, write() never resolves, and
            // the lightbox button sits disabled on "Copying…" with no way back.
            response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (!response.ok) throw new StageError('fetch-failed');
        } catch (e) {
            // A cross-origin host that sends no CORS headers lands here. It is
            // not a bug and not something the app can fix, so the caller is
            // told specifically, and can offer the link instead.
            throw e instanceof StageError ? e : new StageError('fetch-failed');
        }
        return toPngBlob(await response.blob());
    })().catch((e: unknown) => {
        failedAt = e instanceof StageError ? e.stage : 'fetch-failed';
        throw e;
    });

    try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        return { ok: true };
    } catch {
        // `failedAt` is assigned in the catch handler above, which always runs
        // before write() can reject on that promise.
        return { ok: false, reason: (failedAt as CopyImageFailure | null) ?? 'denied' };
    }
}

/** Human-readable explanation for a failed copy. Used for the inline notice. */
export function describeCopyFailure(reason: CopyImageFailure): string {
    switch (reason) {
        case 'unsupported':
            return 'This app can’t copy images to the clipboard here.';
        case 'fetch-failed':
            // Deliberately does NOT say "try Copy Image Link": that item is
            // only offered for http(s) images, and this failure is at least as
            // likely on a blob: attachment whose object URL was revoked by the
            // 250-entry LRU in authedMedia while still on screen. Advice
            // pointing at a menu row that isn't there sends the user hunting.
            return 'Couldn’t load that image to copy it.';
        case 'decode-failed':
            return 'That file couldn’t be read as an image.';
        case 'denied':
            return 'The clipboard refused the image.';
    }
}
