/**
 * Saving a posted clip (the Download button on ClipAttachment).
 *
 * Desktop and web: build the file (assembleClip) and save it — the native
 * `attachment_save` command in the desktop shell, a transient anchor in a
 * browser. The file is the sealed clip with its duration and a seek index
 * added (api/clips/fmp4SaveFix.ts), byte for byte what the Android app saves
 * for the same clip: a sealed clip says duration 0 in its moov, so Explorer,
 * a file's Properties and players that read only the moov showed no length
 * for it.
 *
 * What a Download leaves besides the saved file: nothing. The desktop app
 * hands the bytes to the shell straight from memory, never as a Blob. A
 * browser needs a blob: URL to download from; it is registered by a plaintext
 * host worker (api/plaintextHost.ts), not by the page, and let go of
 * DOWNLOAD_HANDOFF_MS after the click, when the page is also made to collect
 * its garbage. Until 2026-11-22 both made a page Blob of the whole clip and
 * revoked its URL 30 s later; Chromium writes such a Blob to `blob_storage`
 * under memory pressure, and it stayed there until the page next collected
 * garbage (e2e/plaintext-disk-real-browser.mjs measures it, both ways).
 *
 * The Android app, when its APK carries the native download plugin
 * (api/nativeDownloads.ts), hands the whole job to Java: the phone fetches
 * and decrypts every part itself and writes the clip into Movies/Puca through
 * MediaStore, with its duration and a seek index added to the container — no
 * byte crosses the WebView bridge, and it keeps going with the screen off.
 *
 * An Android app on an OLDER APK (an over-the-air bundle arrives before the
 * new APK is installed) STREAMS instead: parts are fetched, decrypted and
 * written to Documents/Puca in order, in bounded slices, the NEXT part
 * downloading while this one is written and the one after not requested until
 * that write returned (forEachClipPart + saveStreamToDevice). Building the
 * whole clip and handing it to the filesystem plugin in one piece is what
 * closed the app on Download: a 2-minute 1080p clip is ~92 MB, one 128 MB
 * string over the Capacitor bridge, OutOfMemoryError on the UI thread. That
 * path holds at most two parts (≤ 48 MiB of plaintext; see forEachClipPart
 * for the transient peak while the next one is decrypted) and each bridge
 * message is ≤ 4 MiB, whatever the clip's length.
 *
 * Lives OUTSIDE api/clips on purpose: that directory may not reach any
 * file-writing API (clipNoDiskWrite.test.ts), and this is the module that
 * does — only for a clip already posted, on the viewer's explicit click. The
 * consent check (a manifest that points at parts nobody approved) is the
 * CALLER's, before this is called: ClipAttachment never offers Download for
 * such a clip.
 */
import { isMobile, isTauri } from './platform';
import { forEachClipPart, assembleClip, type ClipDownloadProgress } from './clips/clipPlayback';
import type { ClipManifest } from './clips/clipRef';
import { saveAttachment, saveBytesOnDesktop, type SaveResult } from './saveAttachment';
import { freeNow, hostPlaintextBlob } from './plaintextHost';
import { DeviceWriteError, PUCA_FOLDER, deviceWriteFailedMessage, saveStreamToDevice, timestampedName } from './saveToDevice';
import { nativeDownloadsAvailable, saveClipNatively } from './nativeDownloads';

export function clipFileName(m: ClipManifest): string {
    return `puca-clip-${m.clipId.slice(0, 8)}.mp4`;
}

/**
 * Throws on failure. A part missing from the server keeps its `status`
 * (404/410), so the caller can say "no longer on the server" rather than
 * blaming the device; a cancel (`signal`) rejects with an AbortError.
 */
export async function saveClip(m: ClipManifest, onProgress?: (p: ClipDownloadProgress) => void, signal?: AbortSignal): Promise<SaveResult> {
    const name = clipFileName(m);

    if (!isTauri() && isMobile()) {
        // MediaStore never overwrites: a second save of the same clip becomes
        // "puca-clip-… (1).mp4", so the native path keeps the plain name.
        if (await nativeDownloadsAvailable()) return saveClipNatively(m, name, onProgress, signal);
        try {
            // Timestamped: on Android 11+ a reinstalled app no longer owns
            // what it wrote before, and writing over that name fails.
            return await saveStreamToDevice(PUCA_FOLDER, timestampedName(name), (write) =>
                forEachClipPart(m, (plain) => write(plain), onProgress, undefined, signal));
        } catch (e) {
            if (e instanceof DeviceWriteError) {
                console.warn('[clip] could not write to this device:', e.reason);
                throw new Error(deviceWriteFailedMessage(null, 'the clip'));
            }
            throw e; // a fetch (with its status), a decryption failure or a cancel, as is
        }
    }

    const { chunks, bytes } = await assembleClip(m, onProgress, undefined, signal, true);
    if (isTauri()) {
        // One buffer for the shell's raw IPC body; the chunks freed once all
        // are copied (two of them can share a part's buffer).
        const file = new Uint8Array(bytes);
        let at = 0;
        for (const c of chunks) { file.set(c, at); at += c.length; }
        for (const c of chunks) freeChunk(c);
        chunks.length = 0;
        try {
            return await saveBytesOnDesktop(file, name);
        } finally {
            freeNow(file.buffer);
        }
    }
    // The page makes the Blob and hands it over at once: nothing here keeps it.
    const lease = await hostPlaintextBlob(new Blob(chunks as BlobPart[], { type: 'video/mp4' }));
    for (const c of chunks) freeChunk(c);
    chunks.length = 0;
    try {
        return await saveAttachment(lease.url, name);
    } finally {
        // The anchor was clicked synchronously, but some engines resolve the
        // URL a little later: kept for that long, then let go.
        setTimeout(() => lease.release(), DOWNLOAD_HANDOFF_MS);
    }
}

/** How long a browser's Download keeps its blob: URL after the click. */
export const DOWNLOAD_HANDOFF_MS = 10_000;

/** A decrypted part's memory back now (two chunks may share one part's buffer: the second free is a no-op). */
function freeChunk(c: Uint8Array): void {
    freeNow(c.buffer as ArrayBuffer);
}
