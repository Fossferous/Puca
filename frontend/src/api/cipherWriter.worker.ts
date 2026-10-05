/// <reference lib="webworker" />
/**
 * Writes one cached attachment's CIPHERTEXT to its file in the origin-private
 * file system, for api/cipherStore.ts, and is then terminated.
 *
 * Why a worker, one per file: a sync access handle (workers only) writes the
 * bytes as they are, where the page's createWritable() first copies them
 * into a Blob; and bytes handed to a worker stay resident in it until it is
 * terminated (measured in the Android WebView), so terminating it right after
 * the write is what gives the memory back at once. Measured on the 2 GB
 * emulator, opening a channel of 3 videos, 3 pictures and a song: the
 * renderer's peak anonymous memory was 233 MB before the cache kept
 * ciphertext, 288 MB with createWritable() from the page, and back to the
 * first with this.
 */
self.postMessage({ ready: true });

self.onmessage = async (e: MessageEvent<{ handle: FileSystemFileHandle; buf: ArrayBuffer; offset: number; length: number }>) => {
    const { handle, buf, offset, length } = e.data;
    let h: FileSystemSyncAccessHandle | null = null;
    try {
        h = await handle.createSyncAccessHandle();
        h.truncate(0);
        const view = new Uint8Array(buf, offset, length);
        let at = 0;
        while (at < view.byteLength) at += h.write(view.subarray(at), { at });
        h.flush();
        self.postMessage({ ok: true });
    } catch (err) {
        self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
        try { h?.close(); } catch { /* already closed */ }
    }
};
