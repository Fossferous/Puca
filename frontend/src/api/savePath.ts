/**
 * The OS "Save As" dialog for the desktop shell — one place, used by
 * everything that writes a file from the desktop app:
 *
 *  - a received transfer (transferSinks.ts) and a downloaded attachment
 *    (saveAttachment.ts), files the user did not create: only when Settings ›
 *    "Ask where to save files" is on; off, both keep writing into
 *    <Downloads>/Puca exactly as before;
 *  - a file of text the user asked for — a calendar .ics (icsDelivery.ts),
 *    Púca Notes' export (notes/model/noteText.ts): always, through
 *    saveTextAs below, because the user is choosing to take it out.
 *
 * The plugin is registered for `dialog:allow-save` and nothing else (no
 * open/message/ask).
 *
 * `null` = the user cancelled. Callers treat that as a decline, and the
 * dialog runs BEFORE any bytes are fetched or any sender is answered, so a
 * cancel costs nobody anything.
 */
export async function chooseSavePath(suggestedName: string): Promise<string | null> {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const chosen = await save({ defaultPath: suggestedName, title: 'Save file' });
    return chosen ?? null;
}

/**
 * Save `text` as a file the user names, on the desktop: the Save As dialog,
 * then the same native write every saved file uses (`attachment_save`). A
 * webview's `<a download>` is not a reliable download there — it can write
 * nothing and say nothing.
 *
 * Returns the full path it was written to, or null when the user cancelled
 * (nothing is written then). A failed write rejects with the shell's reason.
 *
 * Headers must be ASCII, so the name and the chosen path go percent-encoded
 * and the shell decodes them as UTF-8: "Púca notes.md" under C:\Users\Zoë
 * arrives whole. The bytes are the text as UTF-8.
 */
export async function saveTextAs(suggestedName: string, text: string): Promise<string | null> {
    const dest = await chooseSavePath(suggestedName);
    if (dest === null) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('attachment_save', new TextEncoder().encode(text), {
        headers: { 'x-file-name': encodeURIComponent(suggestedName), 'x-dest-path': encodeURIComponent(dest) },
    });
}
