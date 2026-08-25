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
import { isTauri } from './platform';

/** Where a saved file ended up, for the "Saved to …" line. */
export interface SaveResult {
    /** Full path on desktop; just the file name on the web. */
    where: string;
    /** True when the bytes are definitely on disk (desktop). */
    onDisk: boolean;
}

/**
 * Save a blob URL's contents under `name`.
 *
 * Throws on failure so callers can show a real error rather than leaving the
 * user clicking a button that silently does nothing — which is the bug this
 * replaces.
 */
export async function saveAttachment(blobUrl: string, name: string): Promise<SaveResult> {
    const safeName = name || 'attachment';

    if (isTauri()) {
        const resp = await fetch(blobUrl);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const { invoke } = await import('@tauri-apps/api/core');
        // The header must be ASCII; the Rust side percent-decodes and then
        // sanitizes, since a file name from another user is untrusted input.
        const path = await invoke<string>('attachment_save', bytes, {
            headers: { 'x-file-name': encodeURIComponent(safeName) },
        });
        return { where: path, onDisk: true };
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
