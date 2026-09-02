/**
 * The OS "Save As" dialog for the desktop shell — one place, used by both
 * things that write a file the user did not create: a received transfer
 * (transferSinks.ts) and a downloaded attachment (saveAttachment.ts).
 *
 * Only reached when Settings › "Ask where to save files" is on; off, both
 * callers keep writing into <Downloads>/Puca exactly as before. The plugin is
 * registered for `dialog:allow-save` and nothing else (no open/message/ask).
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
