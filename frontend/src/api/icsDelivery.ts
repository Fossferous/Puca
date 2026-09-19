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

/**
 * EXACTLY the shape Púca Notes' plugin reads (NotesNativePlugin.java, and the
 * native branch's notes/native/notesNative.ts wrappers): shareText takes
 * {filename, mime, text, subject} — any other key is ignored by the Java,
 * which then shares "notes.txt" as text/plain — and both methods RESOLVE
 * {ok:false, reason} on failure rather than rejecting.
 */
export interface NotesShareArgs { filename: string; mime: string; text: string; subject?: string }
export interface PhoneCalendarArgs { title: string; beginMs: number; endMs?: number; allDay?: boolean; location?: string }
type NativeOutcome = { ok?: boolean; reason?: string } | null | undefined;

interface NotesNativePlugin {
    info: () => Promise<{ api?: number; features?: string[] }>;
    shareText: (o: NotesShareArgs) => Promise<NativeOutcome>;
    addToPhoneCalendar: (o: PhoneCalendarArgs) => Promise<NativeOutcome>;
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

/** What the installed APK says it can do. A Capacitor plugin proxy answers
 *  `typeof x === 'function'` for ANY name, so that test detects nothing:
 *  the plugin's own info().features is the only honest answer (an APK
 *  without info() is older than both methods). */
async function nativeFeatures(p: NotesNativePlugin): Promise<string[]> {
    try {
        const r = await p.info();
        return Array.isArray(r?.features) ? r.features : [];
    } catch {
        return [];
    }
}

/** A resolved {ok:false} is a failure with the plugin's reason. */
function outcomeError(r: NativeOutcome, fallback: string): Error | null {
    if (r && r.ok === true) return null;
    return new Error(r && typeof r.reason === 'string' && r.reason ? r.reason : fallback);
}

/** Is "Add to phone calendar" available in this shell? */
export async function canAddToPhoneCalendar(): Promise<boolean> {
    const p = await notesNative();
    return !!p && (await nativeFeatures(p)).includes('calendar');
}

/**
 * The phone-calendar arguments for an entry. An ALL-DAY item is a floating
 * date, and Android's calendar reads an all-day begin/end as UTC midnight:
 * sending local midnight put it on the previous day anywhere east of UTC
 * (Dublin in summer is UTC+1). So all-day sends Date.UTC of its first day
 * and of the day after its last.
 */
export function phoneCalendarArgs(e: {
    title: string; startMs: number; endMs: number; allDay: boolean; dayKeys: string[]; location?: string;
}): PhoneCalendarArgs {
    const base = { title: e.title, ...(e.location ? { location: e.location } : {}) };
    if (e.allDay && e.dayKeys.length > 0) {
        const utc = (key: string, plusDays = 0) => {
            const [y, m, d] = key.split('-').map(Number);
            return Date.UTC(y, m - 1, d + plusDays);
        };
        return { ...base, allDay: true, beginMs: utc(e.dayKeys[0]), endMs: utc(e.dayKeys[e.dayKeys.length - 1], 1) };
    }
    return { ...base, allDay: false, beginMs: e.startMs, ...(e.endMs > e.startMs ? { endMs: e.endMs } : {}) };
}

export async function addToPhoneCalendar(o: PhoneCalendarArgs): Promise<void> {
    const p = await notesNative();
    if (!p) throw new Error('This app cannot add to the phone calendar — update Púca Notes');
    const err = outcomeError(await p.addToPhoneCalendar(o), 'Could not open the phone calendar');
    if (err) throw err;
}

export interface DeliverResult {
    how: 'shared' | 'saved' | 'downloaded' | 'cancelled';
    where?: string;
}

export async function deliverIcs(fileName: string, text: string): Promise<DeliverResult> {
    const native = await notesNative();
    if (native && (await nativeFeatures(native)).includes('share')) {
        let r: NativeOutcome;
        try {
            r = await native.shareText({ filename: fileName, mime: 'text/calendar', text, subject: fileName });
        } catch (err) {
            // A bridge that rejects outright: fall through to the other ways out.
            console.warn('[ics] share failed, falling back:', err);
            r = undefined;
        }
        if (r !== undefined) {
            // It answered: {ok:false} is the plugin saying it could not —
            // report that, never "Exported".
            const err = outcomeError(r, 'Could not open the share sheet');
            if (err) throw err;
            return { how: 'shared' };
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
