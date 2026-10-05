/**
 * Saving a decrypted attachment to disk.
 *
 * TWO problems are solved here, and the second is the important one.
 *
 * 1. Clicking an attachment did not download it in the desktop shell. An
 *    `<a href="blob:…" download>` is not a reliable download in a webview.
 *    Desktop therefore writes the bytes through a native command instead.
 *
 * 2. A PERSISTENT `<a href="blob:…" download>` is a security hole, and that is
 *    what both attachment lists used. `download` is honoured only for a plain
 *    left click — middle-click and "Open link in new tab" IGNORE it and
 *    navigate to the blob instead. A `blob:` document inherits this app's
 *    origin, and the attachment's MIME type comes from whoever SENT it (the
 *    `m=` parameter of the ref). A crafted `text/html` attachment opened that
 *    way would run script in-origin, with access to the stored JWT and the
 *    E2EE key material.
 *
 *    So no blob URL is ever exposed as a link. The download is a button, and
 *    the anchor it uses on the web is created, clicked and removed in one go —
 *    never in the document for a user to middle-click.
 *
 * `ImageLightbox` already documented this reasoning for images; the message and
 * task attachment lists never got the same treatment.
 */
import { isMobile, isTauri } from './platform';
import { loadSettings } from '../components/settingsStore';
import { chooseSavePath } from './savePath';
import { PUCA_FOLDER, deviceWriteFailedMessage, saveBytesToDevice, timestampedName } from './saveToDevice';
import { nativeDownloadsAvailable, saveAttachmentNatively, type EncRef } from './nativeDownloads';

/** Where a saved file ended up, for the "Saved to …" line. */
export interface SaveResult {
    /** Full path on desktop; just the file name on the web. */
    where: string;
    /** True when the bytes are definitely on disk (desktop). */
    onDisk: boolean;
    /** The user cancelled the Save As dialog; nothing was written. */
    cancelled?: true;
}

/**
 * Save a blob URL's contents under `name`.
 *
 * `folder` is the Documents/ folder a PHONE writes into; it defaults to
 * Púca's, and Púca Notes passes its own so a file saved out of a note lands
 * beside the Notes export rather than in the chat app's folder.
 *
 * Throws on failure so callers can show a real error rather than leaving the
 * user clicking a button that silently does nothing — which is the bug this
 * replaces.
 */
export async function saveAttachment(blobUrl: string, name: string, folder: string = PUCA_FOLDER): Promise<SaveResult> {
    const safeName = name || 'attachment';

    if (isTauri()) {
        // "Ask where to save files": the dialog comes first, before the bytes
        // are even read, so a cancel is free.
        let dest: string | undefined;
        if (loadSettings().askWhereToSaveFiles === true) {
            const chosen = await chooseSavePath(safeName);
            if (chosen === null) return { where: '', onDisk: false, cancelled: true };
            dest = chosen;
        }
        const resp = await fetch(blobUrl);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const { invoke } = await import('@tauri-apps/api/core');
        // The headers must be ASCII; the Rust side percent-decodes and then
        // sanitizes the NAME, since a file name from another user is untrusted
        // input. The destination is the user's own choice and is used as given.
        const path = await invoke<string>('attachment_save', bytes, {
            headers: {
                'x-file-name': encodeURIComponent(safeName),
                ...(dest ? { 'x-dest-path': encodeURIComponent(dest) } : {}),
            },
        });
        return { where: path, onDisk: true };
    }

    // A phone: the anchor below writes NOTHING in a WebView (Capacitor 8 has
    // no download listener) and would then report "saved". Documents/Puca
    // through the filesystem plugin instead, under a timestamped name — on
    // Android 11+ a reinstalled app no longer owns what it wrote before, and
    // writing over that name fails. A failure throws; it never falls through.
    if (isMobile()) {
        try {
            return await saveBytesToDevice(folder, timestampedName(safeName), blobUrl);
        } catch (e) {
            console.warn('[attachment] could not write to this device:', e);
            throw new Error(deviceWriteFailedMessage(null, 'the file'));
        }
    }

    // Web: a transient anchor. Created, clicked and removed synchronously so it
    // is never present in the document to be middle-clicked or copied.
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = safeName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { where: safeName, onDisk: false };
}

/**
 * Save an encrypted attachment the viewer clicked Download on.
 *
 * In the Android app with the native download plugin (api/nativeDownloads.ts)
 * the PHONE fetches the ciphertext again by its ref, decrypts it in Java and
 * writes it into the shared folder it belongs in — Movies/Puca for a video,
 * Pictures/Puca, Music/Puca, otherwise Download/Puca — so the bytes never
 * cross the WebView bridge and the gallery sees the file with its duration
 * and size. The copy this page already decrypted (for the inline player) is
 * not used for that: handing it to Java would mean the bridge again. Costs
 * one more download of at most 25 MB; buys the right folder and a file the
 * phone's own apps understand.
 *
 * Everywhere else, and on an older APK, the decrypted copy is saved exactly
 * as saveAttachment always did. `folder` (Púca Notes' own) keeps that path.
 */
export async function saveEncryptedAttachment(
    blobUrl: string,
    ref: EncRef | null,
    name: string,
    folder: string = PUCA_FOLDER,
    onBytes?: (received: number, total: number | null) => void,
): Promise<SaveResult> {
    if (ref && folder === PUCA_FOLDER && !isTauri() && isMobile() && await nativeDownloadsAvailable()) {
        return saveAttachmentNatively(ref, name || 'attachment', undefined, onBytes);
    }
    return saveAttachment(blobUrl, name, folder);
}

/**
 * Why a Download failed, in a few words for the button. The native path
 * rejects with a short `code` (api/nativeDownloads.ts); a fetch carries its
 * HTTP `status`. Anything else is the device's own failure.
 */
export function saveFailureNote(err: unknown): string {
    const e = err as { status?: unknown; code?: unknown } | null;
    if (e?.status === 404 || e?.status === 410 || e?.code === 'gone') return 'no longer on the server';
    if (e?.code === 'network') return 'the connection dropped, try again';
    if (e?.code === 'decrypt') return 'could not be decrypted';
    if (e?.code === 'denied') return 'the server refused it';
    return 'could not save';
}
