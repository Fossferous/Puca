/// <reference lib="webworker" />
/**
 * Holds decrypted attachments for the page as blob: URLs (api/plaintextHost.ts).
 *
 * The page hands over a Blob it made and dropped; the URL registered HERE is
 * a normal same-origin URL that an <img>, <video> or <audio> on the page
 * loads like any other, but this worker is what keeps the blob alive: when
 * the page terminates the worker, every blob registered here goes at once,
 * and so do the files Chromium paged them to. A blob the PAGE keeps instead
 * stays alive, revoked or not, until the page's garbage collector happens to
 * run (measured in the Android WebView: a revoked 20 MB blob's plaintext
 * file was still on disk 21 s later, and 60 s into the background; gone
 * straight after a forced GC).
 *
 * A blob dropped here while others are still shown has its URL revoked, but
 * the Blob object this worker received for it is garbage the worker does not
 * collect while it idles, and it keeps the bytes (and their file) alive. So
 * the page, when it next makes itself collect, sends `collect` here too
 * (api/plaintextHost.ts), and this worker does the same in its own isolate.
 *
 * Nothing here reads, keeps or logs the bytes: only the URL goes back.
 */
import { nudgeCollection } from './collectGarbage';

const urls = new Map<number, string>();

// Started: the page hands blobs over only after this, so one that never
// loads falls back to the page cleanly.
self.postMessage({ ready: true });

self.onmessage = (e: MessageEvent<{ op: 'host'; id: number; blob: Blob } | { op: 'drop'; id: number } | { op: 'collect' }>) => {
    const m = e.data;
    if (m.op === 'host') {
        try {
            const url = URL.createObjectURL(m.blob);
            urls.set(m.id, url);
            self.postMessage({ id: m.id, url });
        } catch (err) {
            self.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) });
        }
    } else if (m.op === 'drop') {
        const url = urls.get(m.id);
        if (url) {
            URL.revokeObjectURL(url);
            urls.delete(m.id);
        }
    } else if (m.op === 'collect') {
        nudgeCollection();
    }
};
