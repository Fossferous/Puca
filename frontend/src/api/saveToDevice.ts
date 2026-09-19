/**
 * Writing a file into the phone's public Documents folder — the one way a
 * Capacitor Android app can "download" anything. A blob-URL anchor click is
 * not a download in a WebView: Capacitor 8's Android core has no download
 * listener, so it writes NOTHING, and a caller that falls through to it
 * reports success for a file that does not exist.
 *
 * Shared by the account export (Púca), the note export (Púca Notes) and
 * saving an attachment (both apps). Through @capacitor/filesystem, which both
 * APKs carry — Púca's from frontend/package.json, Púca Notes' from
 * frontend/notes-app/package.json. A file the app creates in Documents needs
 * no grant on Android 11+; on 10 and older it needs storage permission, which
 * is why the failure text names that before disk space.
 *
 * THROWS when nothing was written. Never falls back to the anchor.
 */
import type { SaveResult } from './saveAttachment';

/** The folders under Documents/. ASCII on purpose: a folder name is typed and
 *  searched for in file managers, and Documents/Puca already holds the
 *  account exports earlier releases wrote. */
// hygiene-lint:allow-product-spelling — an on-disk folder name, ASCII on purpose (see above)
export const PUCA_FOLDER = 'Puca';
// hygiene-lint:allow-product-spelling — an on-disk folder name, ASCII on purpose (see above)
export const NOTES_FOLDER = 'Puca Notes';

/** Characters no Android file name may carry, plus anything that could
 *  climb out of the folder. An attachment's name comes from another user. */
export function safeDeviceFileName(name: string): string {
    // Path separators and reserved characters become '_'; control
    // characters are dropped by code point (a regex range over them is
    // what no-control-regex exists to question).
    let s = Array.from(name || '').filter(c => { const n = c.codePointAt(0) ?? 0; return n >= 32 && n !== 127; }).join('')
        .replace(/[\\/:*?"<>|]+/g, '_').trim();
    s = s.replace(/^\.+/, '');
    if (!s) s = 'file';
    if (s.length > 120) {
        const dot = s.lastIndexOf('.');
        const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
        s = s.slice(0, 120 - ext.length) + ext;
    }
    return s;
}

/**
 * `name-YYYYMMDD-HHMMSS.ext`, in local time. Unique per second, which matters
 * on Android 11+: after a reinstall the app no longer OWNS a file it wrote
 * earlier, and writing over that name fails with a permission error — so a
 * second export or save must never reuse a name.
 */
export function timestampedName(name: string, now: Date = new Date()): string {
    const safe = safeDeviceFileName(name);
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    const dot = safe.lastIndexOf('.');
    if (dot > 0) return `${safe.slice(0, dot)}-${stamp}${safe.slice(dot)}`;
    return `${safe}-${stamp}`;
}

async function filesystem() {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('Filesystem')) {
        throw new Error('this app cannot write files on this platform');
    }
    return import('@capacitor/filesystem');
}

/** Documents/<folder>/<name>, as text. */
export async function saveTextToDevice(folder: string, name: string, text: string): Promise<SaveResult> {
    const { Filesystem, Directory, Encoding } = await filesystem();
    const file = safeDeviceFileName(name);
    await Filesystem.writeFile({
        path: `${folder}/${file}`,
        data: text,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
        recursive: true,
    });
    return { where: `Documents/${folder}/${file}`, onDisk: true };
}

/** Bytes as base64 (what Filesystem.writeFile takes for binary). Chunked:
 *  String.fromCharCode over a whole large file would overflow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

/** Documents/<folder>/<name>, from a blob URL (a decrypted attachment). */
export async function saveBytesToDevice(folder: string, name: string, blobUrl: string): Promise<SaveResult> {
    const { Filesystem, Directory } = await filesystem();
    const file = safeDeviceFileName(name);
    const bytes = new Uint8Array(await (await fetch(blobUrl)).arrayBuffer());
    await Filesystem.writeFile({
        path: `${folder}/${file}`,
        data: bytesToBase64(bytes),
        directory: Directory.Documents,
        recursive: true,
    });
    return { where: `Documents/${folder}/${file}`, onDisk: true };
}

/** What to tell someone when the write failed. Names the Android 10
 *  permission first: it is the likeliest cause on exactly the devices least
 *  likely to be short of space. */
export function deviceWriteFailedMessage(appName: string | null, what: string): string {
    const who = appName ?? 'this app';
    const where = appName ? `Apps → ${appName} → Permissions` : 'Apps → (this app) → Permissions';
    return `Could not save ${what} to this device. On Android 10 and older, ${who} needs `
        + `permission to write to Documents — allow storage access in Android Settings → ${where}, `
        + 'then try again. Otherwise check you have free space.';
}
