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

/*
 * EVERY WRITE GOES OUT IN BOUNDED SLICES. Each Filesystem call is one bridge
 * message: Capacitor JSON-stringifies it, and Android's MessageHandler parses
 * the whole string on the UI thread, then the plugin decodes it — three
 * copies of the payload on the Java heap, whose size is fixed per app (192 MB
 * on a stock emulator, no largeHeap). Its `catch (Exception)` cannot catch an
 * OutOfMemoryError, so an oversized message does not fail the call: Android
 * KILLS THE APP. That is what tapping Download on a 92 MB clip did (one
 * 128,625,344-character base64 string). Somewhat smaller files hit the caught
 * half instead: a 0-byte file and a misleading error.
 *
 * So: writeFile for the first slice (create / truncate), appendFile for the
 * rest, each slice at most DEVICE_WRITE_CHUNK_CHARS characters — a few MB of
 * Java heap whatever the file's size. A failure part-way deletes what was
 * written: nothing half-written is left wearing the real name.
 */

/** Raw bytes per bridge call. A multiple of 3, so every slice but the last is
 *  whole base64 quads with no padding, and its base64 is exactly
 *  DEVICE_WRITE_CHUNK_CHARS long. */
export const DEVICE_WRITE_CHUNK_BYTES = 768 * 1024;
/** Characters per bridge call, text and base64 alike. */
export const DEVICE_WRITE_CHUNK_CHARS = (DEVICE_WRITE_CHUNK_BYTES / 3) * 4;

/** A bridge write failed — as opposed to whatever produced the bytes (a
 *  fetch, a decryption), which a caller may want to report differently. */
export class DeviceWriteError extends Error {
    /** What the filesystem plugin rejected with. */
    readonly reason: unknown;
    constructor(reason: unknown) {
        super(`could not write to this device: ${reason instanceof Error ? reason.message : String(reason)}`);
        this.name = 'DeviceWriteError';
        this.reason = reason;
    }
}

type Fs = Awaited<ReturnType<typeof filesystem>>;

/**
 * One file in Documents, written by `fill` in bounded slices. `fill` gets a
 * `put` that takes ONE slice (at most DEVICE_WRITE_CHUNK_CHARS characters).
 * Whatever `fill` throws — its own error or a DeviceWriteError from `put` —
 * deletes the file and is rethrown.
 */
async function writeInSlices(
    fs: Fs, folder: string, name: string, utf8: boolean,
    fill: (put: (data: string) => Promise<void>) => Promise<void>,
): Promise<SaveResult> {
    const { Filesystem, Directory, Encoding } = fs;
    const file = safeDeviceFileName(name);
    const path = `${folder}/${file}`;
    let started = false;
    const put = async (data: string) => {
        const opts = { path, data, directory: Directory.Documents, ...(utf8 ? { encoding: Encoding.UTF8 } : {}) };
        try {
            if (!started) {
                // Set BEFORE the call: a writeFile that fails can still
                // leave a 0-byte file behind, and the cleanup must find it.
                started = true;
                await Filesystem.writeFile({ ...opts, recursive: true });
            } else {
                await Filesystem.appendFile(opts);
            }
        } catch (e) {
            throw new DeviceWriteError(e);
        }
    };
    try {
        await fill(put);
        if (!started) await put(''); // an empty file still has to exist
    } catch (e) {
        if (started) {
            try { await Filesystem.deleteFile({ path, directory: Directory.Documents }); } catch { /* nothing there, or not ours */ }
        }
        throw e;
    }
    return { where: `Documents/${folder}/${file}`, onDisk: true };
}

/** Text in slices of at most DEVICE_WRITE_CHUNK_CHARS UTF-16 units, never
 *  cutting between the halves of a surrogate pair (each slice is encoded to
 *  UTF-8 on its own, so a split pair would become two U+FFFD). */
export function textSlices(text: string, max: number = DEVICE_WRITE_CHUNK_CHARS): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length;) {
        let end = Math.min(i + max, text.length);
        if (end < text.length && end - i > 1) {
            const c = text.charCodeAt(end - 1);
            if (c >= 0xd800 && c <= 0xdbff) end--; // a high surrogate: keep it with its pair
        }
        out.push(text.slice(i, end));
        i = end;
    }
    return out;
}

/** Documents/<folder>/<name>, as text. */
export async function saveTextToDevice(folder: string, name: string, text: string): Promise<SaveResult> {
    const fs = await filesystem();
    return writeInSlices(fs, folder, name, true, async (put) => {
        for (const slice of textSlices(text)) await put(slice);
    });
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

/**
 * Documents/<folder>/<name>, from bytes that arrive in pieces. `fill` gets a
 * `write` for each piece — any size; it is sliced here — so a producer that
 * decrypts one part at a time (a clip) never holds the whole file. This is the
 * one binary write path on a phone.
 */
export async function saveStreamToDevice(
    folder: string, name: string,
    fill: (write: (bytes: Uint8Array) => Promise<void>) => Promise<void>,
): Promise<SaveResult> {
    const fs = await filesystem();
    return writeInSlices(fs, folder, name, false, (put) => fill(async (bytes) => {
        for (let i = 0; i < bytes.length; i += DEVICE_WRITE_CHUNK_BYTES) {
            await put(bytesToBase64(bytes.subarray(i, i + DEVICE_WRITE_CHUNK_BYTES)));
        }
    }));
}

/** Documents/<folder>/<name>, from a blob URL (a decrypted attachment). */
export async function saveBytesToDevice(folder: string, name: string, blobUrl: string): Promise<SaveResult> {
    return saveStreamToDevice(folder, name, async (write) => {
        await write(new Uint8Array(await (await fetch(blobUrl)).arrayBuffer()));
    });
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
