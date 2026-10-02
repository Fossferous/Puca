/**
 * Saving a posted clip (the Download button on ClipAttachment).
 *
 * Desktop and web: build the original file (downloadClipBytes) and save it
 * like any attachment (saveAttachment) — the native `attachment_save` command
 * in the desktop shell, a transient anchor in a browser.
 *
 * The Android app STREAMS instead: each part is fetched, decrypted and written
 * to Documents/Puca in bounded slices before the next part is fetched
 * (forEachClipPart + saveStreamToDevice). Building the whole clip and handing
 * it to the filesystem plugin in one piece is what closed the app on Download:
 * a 2-minute 1080p clip is ~92 MB, one 128 MB string over the Capacitor
 * bridge, OutOfMemoryError on the UI thread. Now the phone holds about one
 * part (≤ 24 MiB) and each bridge message is ≤ 1 MiB, whatever the clip's
 * length.
 *
 * Lives OUTSIDE api/clips on purpose: that directory may not reach any
 * file-writing API (clipNoDiskWrite.test.ts), and this is the module that
 * does — only for a clip already posted, on the viewer's explicit click.
 */
import { isMobile, isTauri } from './platform';
import { forEachClipPart, downloadClipBytes, type ClipDownloadProgress } from './clips/clipPlayback';
import type { ClipManifest } from './clips/clipRef';
import { saveAttachment, type SaveResult } from './saveAttachment';
import { DeviceWriteError, PUCA_FOLDER, deviceWriteFailedMessage, saveStreamToDevice, timestampedName } from './saveToDevice';

export function clipFileName(m: ClipManifest): string {
    return `puca-clip-${m.clipId.slice(0, 8)}.mp4`;
}

/**
 * Throws on failure. A part missing from the server keeps its `status`
 * (404/410), so the caller can say "no longer on the server" rather than
 * blaming the device.
 */
export async function saveClip(m: ClipManifest, onProgress?: (p: ClipDownloadProgress) => void): Promise<SaveResult> {
    const name = clipFileName(m);

    if (!isTauri() && isMobile()) {
        try {
            // Timestamped: on Android 11+ a reinstalled app no longer owns
            // what it wrote before, and writing over that name fails.
            return await saveStreamToDevice(PUCA_FOLDER, timestampedName(name), (write) =>
                forEachClipPart(m, (plain) => write(plain), onProgress));
        } catch (e) {
            if (e instanceof DeviceWriteError) {
                console.warn('[clip] could not write to this device:', e.reason);
                throw new Error(deviceWriteFailedMessage(null, 'the clip'));
            }
            throw e; // a fetch (with its status) or a decryption failure, as is
        }
    }

    const blob = await downloadClipBytes(m, onProgress);
    const url = URL.createObjectURL(blob);
    try {
        return await saveAttachment(url, name);
    } finally {
        // The desktop path has already read the bytes; the web anchor was
        // clicked synchronously. Revoke after a grace period either way.
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
}
