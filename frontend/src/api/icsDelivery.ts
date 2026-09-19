/**
 * Getting an .ics out of the app, per shell:
 *
 *  - Púca Notes' Android app: NotesNative.shareText (the share sheet) when the
 *    installed APK has it — feature-detected, because the plugin ships in a
 *    native build that may be older or newer than this web bundle;
 *  - the desktop shell: the OS Save As dialog, then the same native write
 *    every saved file uses;
 *  - Púca's Android app: Documents/Puca through Capacitor Filesystem (a
 *    blob-anchor click writes nothing in a WebView — accountExport.ts);
 *  - a browser: a transient download anchor (saveAttachment's web path).
 *
 * The file is PLAINTEXT — titles, times, places. The UI says so before the
 * export runs.
 *
 * "Add to phone calendar" goes through NotesNative.addToPhoneCalendar (an
 * ACTION_INSERT intent the user confirms in their own calendar app) — also
 * feature-detected, and only offered where it exists.
 */
import { isMobile, isTauri } from './platform';
import { saveAttachment } from './saveAttachment';
import { chooseSavePath } from './savePath';

interface NotesNativePlugin {
    shareText?: (o: { text: string; title?: string; fileName?: string; mimeType?: string }) => Promise<unknown>;
    addToPhoneCalendar?: (o: { title: string; beginMs: number; endMs?: number; allDay?: boolean; location?: string }) => Promise<unknown>;
}

async function notesNative(): Promise<NotesNativePlugin | null> {
    try {
        const { Capacitor, registerPlugin } = await import('@capacitor/core');
        if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('NotesNative')) return null;
        return registerPlugin<NotesNativePlugin>('NotesNative');
    } catch {
        return null;
    }
}

/** Is "Add to phone calendar" available in this shell? */
export async function canAddToPhoneCalendar(): Promise<boolean> {
    const p = await notesNative();
    return !!p && typeof p.addToPhoneCalendar === 'function';
}

export async function addToPhoneCalendar(o: { title: string; beginMs: number; endMs?: number; allDay?: boolean; location?: string }): Promise<void> {
    const p = await notesNative();
    if (!p || typeof p.addToPhoneCalendar !== 'function') throw new Error('This app cannot add to the phone calendar — update Púca Notes');
    await p.addToPhoneCalendar(o);
}

export interface DeliverResult {
    how: 'shared' | 'saved' | 'downloaded' | 'cancelled';
    where?: string;
}

export async function deliverIcs(fileName: string, text: string): Promise<DeliverResult> {
    const native = await notesNative();
    if (native && typeof native.shareText === 'function') {
        try {
            await native.shareText({ text, title: fileName, fileName, mimeType: 'text/calendar' });
            return { how: 'shared' };
        } catch (err) {
            // A plugin that exists but lacks the method rejects "not
            // implemented": fall through to the other ways out.
            console.warn('[ics] share failed, falling back:', err);
        }
    }
    if (isTauri()) {
        const dest = await chooseSavePath(fileName);
        if (dest === null) return { how: 'cancelled' };
        const { invoke } = await import('@tauri-apps/api/core');
        const path = await invoke<string>('attachment_save', new TextEncoder().encode(text), {
            headers: { 'x-file-name': encodeURIComponent(fileName), 'x-dest-path': encodeURIComponent(dest) },
        });
        return { how: 'saved', where: path };
    }
    if (isMobile()) {
        const { Capacitor } = await import('@capacitor/core');
        if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('Filesystem')) {
            throw new Error('This app cannot write files here');
        }
        const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
        // A fresh name every time: Android 11+ refuses to overwrite a file a
        // previous install created.
        const unique = fileName.replace(/\.ics$/, `-${Date.now()}.ics`);
        await Filesystem.writeFile({ path: `Puca/${unique}`, data: text, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
        return { how: 'saved', where: `Documents/Puca/${unique}` };
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
    try {
        const r = await saveAttachment(url, fileName);
        return { how: r.cancelled ? 'cancelled' : 'downloaded', where: r.where };
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
}
