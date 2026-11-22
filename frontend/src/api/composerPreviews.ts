/**
 * The thumbnails on the message box's attachment chips (components/Chat.tsx,
 * the chip strip api/composerAttachments.ts models), and the files behind
 * them, let go of the moment a chip goes.
 *
 * A picture pasted into the message box (or dropped from another app, or a
 * HEIC made into a JPEG on the way) is a Blob the page holds in memory, not a
 * file on disk the browser can point at, and Chromium writes such blobs to
 * `blob_storage` as they are, past its memory limit (1% of the RAM in the
 * Android WebView) or under memory pressure (docs/SECURITY_MODEL.md,
 * *Decrypted attachments on your own storage*). The chip's thumbnail used to
 * be `URL.createObjectURL(file)`, revoked when the chip went; but a page's
 * Blob stays alive (and on disk) until the page collects garbage, minutes
 * later on an idle page, so a sent picture's plaintext stayed on disk long
 * after the chip was gone (measured: e2e/plaintext-disk-real-browser.mjs).
 *
 * Now the thumbnail URL is registered by a plaintext host worker
 * (api/plaintextHost.ts hostPlaintextBlob) and released with the chip, and
 * the page is made to collect its garbage then (letGoOfPlaintext), so the
 * pasted file goes from the disk within seconds of being sent or removed.
 * The File itself is still kept by the composer for the upload and a Retry,
 * exactly as long as the chip is there.
 */
import { hostPlaintextBlob, letGoOfPlaintext, type PlainLease } from './plaintextHost';

export interface ComposerPreviews {
    /** Make `blob`'s thumbnail URL for chip `localId`; `onUrl` is called with it
     *  once it is ready, unless the chip went first (or was shown again). */
    show(localId: string, blob: Blob): void;
    /** The chip went (sent, removed, or its file replaced): its thumbnail URL
     *  stops working, and the file is let go of. */
    drop(localId: string): void;
    /** Every chip went. */
    dropAll(): void;
    /** Chips with a thumbnail held or on its way (tests, diagnostics). */
    size(): number;
}

export function createComposerPreviews(onUrl: (localId: string, url: string) => void): ComposerPreviews {
    /** Per chip: the lease once it is in, or the ticket of the one on its way. */
    const held = new Map<string, { ticket: number; lease: PlainLease | null }>();
    let nextTicket = 0;

    const drop = (localId: string): void => {
        const h = held.get(localId);
        held.delete(localId);
        h?.lease?.release();
        // Whatever happened to the chip's file, the page just let go of it: the
        // release above nudges the collector when there was a lease; a chip with
        // no thumbnail (a pasted video, a file) needs the nudge as much.
        letGoOfPlaintext();
    };

    return {
        show(localId, blob) {
            const old = held.get(localId);
            old?.lease?.release();
            const ticket = ++nextTicket;
            held.set(localId, { ticket, lease: null });
            void hostPlaintextBlob(blob).then(
                (lease) => {
                    const h = held.get(localId);
                    if (!h || h.ticket !== ticket) { lease.release(); return; }
                    h.lease = lease;
                    onUrl(localId, lease.url);
                },
                () => { /* no thumbnail: the chip shows its file icon */ },
            );
        },
        drop,
        dropAll() {
            for (const id of [...held.keys()]) drop(id);
            letGoOfPlaintext();
        },
        size: () => held.size,
    };
}
