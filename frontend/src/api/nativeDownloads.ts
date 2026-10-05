/**
 * The Android app's NATIVE download path (SovereignDownloadsPlugin.java):
 * the phone fetches the encrypted file itself, decrypts it in Java and writes
 * it straight into the shared collection it belongs in — Movies/Puca,
 * Pictures/Puca, Music/Puca or Download/Puca — so not one byte of it crosses
 * the WebView bridge. A Púca Clip also gets its real duration and a seek index
 * written into the container (Fmp4SaveFix.java), so Google Photos and the
 * phone's own players show its length and can seek in it.
 *
 * What the page hands over: the file ids, the keys (already in this message's
 * plaintext), its bearer and the API base it talks to. The plugin builds the
 * one URL itself — `<the API origin the APK was built for>/files/<uuid>` —
 * and refuses when the page's base is not that origin.
 *
 * OLDER APKs. Web bundles reach phones over the air, ahead of a new APK. On an
 * APK without the plugin `Capacitor.isPluginAvailable('SovereignDownloads')`
 * is false (the bridge lists only the plugins the APK registered — a NEW
 * plugin name is exactly what that check can see), and every caller keeps its
 * old JavaScript path (saveToDevice.ts → Documents/Puca). So does Android 9
 * and older (`supported: false`), and an APK built for another server.
 */
import { registerPlugin, Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { API_BASE_URL } from './config';
import { getToken } from './auth';
import type { SaveResult } from './saveAttachment';
import type { ClipManifest } from './clips/clipRef';
import type { ClipDownloadProgress } from './clips/clipPlayback';

interface NativeSaved { where: string; uri: string; bytes: number; container: string }
interface NativeProgress { id: string; bytesDone: number; totalBytes: number; done: number; total: number }
interface NativeStatus { version: number; supported: boolean; apiBase: string | null }

interface SovereignDownloadsPlugin {
    status(): Promise<NativeStatus>;
    saveClip(opts: {
        id: string; apiBase: string; token: string; name: string;
        clipId: string; key: string; noncePrefix: string; parts: string[];
        totalBytes: number; durationMs: number;
    }): Promise<NativeSaved>;
    saveAttachment(opts: {
        id: string; apiBase: string; token: string; name: string;
        fileId: string; key: string; cap?: string; mime: string;
    }): Promise<NativeSaved>;
    cancel(opts: { id: string }): Promise<{ cancelled: boolean }>;
    addListener(event: 'progress', fn: (e: NativeProgress) => void): Promise<PluginListenerHandle>;
}

const PLUGIN = 'SovereignDownloads';
// Registered on first use, not at import: saveAttachment.ts imports this
// module on every platform, and nothing here is needed until an Android
// download actually starts.
let registered: SovereignDownloadsPlugin | null = null;
const downloads = (): SovereignDownloadsPlugin => (registered ??= registerPlugin<SovereignDownloadsPlugin>(PLUGIN));

/** The plugin's call shapes this page speaks (SovereignDownloadsPlugin.VERSION). */
export const NATIVE_DOWNLOADS_VERSION = 1;

/** Same normalisation as DownloadInputs.normalizeApiBase's: trimmed, no trailing slash. */
export function normalizeApiBase(base: string): string {
    return base.trim().replace(/\/+$/, '');
}

let ready: Promise<boolean> | null = null;

/**
 * Can this phone save natively right now? Asked once per page load: an APK
 * does not change under a running page. False on every other platform, on an
 * APK without the plugin, below Android 10, and when the APK was built for
 * another server than the page talks to.
 */
export function nativeDownloadsAvailable(): Promise<boolean> {
    if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable(PLUGIN)) return Promise.resolve(false);
    ready ??= downloads().status()
        .then((s) => s.version >= NATIVE_DOWNLOADS_VERSION && s.supported === true && typeof s.apiBase === 'string'
            && s.apiBase === normalizeApiBase(API_BASE_URL))
        .catch(() => false);
    return ready;
}

/** Tests only: forget the cached answer. */
export function resetNativeDownloadsForTests(): void {
    ready = null;
}

/** A plugin rejection carries a short `code`; turn it into what the callers already handle. */
export function nativeDownloadError(e: unknown): Error {
    const code = (e as { code?: unknown } | null)?.code;
    // The plugin speaks in sentences; the plate adds its own full stop.
    const message = (e instanceof Error && e.message ? e.message : 'Download failed').replace(/\.\s*$/, '');
    if (code === 'cancelled') return new DOMException('Download cancelled.', 'AbortError');
    // The callers say "no longer on the server" for a 404/410.
    if (code === 'gone') return Object.assign(new Error(message), { status: 410, code });
    return Object.assign(new Error(message), { code: typeof code === 'string' ? code : 'failed' });
}

function abortError(): DOMException {
    return new DOMException('Download cancelled.', 'AbortError');
}

let seq = 0;
function newId(): string {
    seq = (seq + 1) % 1_000_000;
    return `dl-${Date.now().toString(36)}-${seq}`;
}

function b64(u: Uint8Array): string {
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
}

/** Runs one native save: progress events for this id, cancel on abort, cleanup. */
async function run(
    id: string,
    start: () => Promise<NativeSaved>,
    onProgress: ((e: NativeProgress) => void) | undefined,
    signal: AbortSignal | undefined,
): Promise<SaveResult> {
    if (signal?.aborted) throw abortError();
    const handle = onProgress
        ? await downloads().addListener('progress', (e) => { if (e.id === id) onProgress(e); })
        : null;
    const onAbort = () => { void downloads().cancel({ id }).catch(() => { /* already finished */ }); };
    signal?.addEventListener('abort', onAbort);
    try {
        // A Cancel that landed while the listener was being added fired before
        // onAbort existed, and there is no job yet for it to reach.
        if (signal?.aborted) throw abortError();
        const r = await start();
        return { where: r.where, onDisk: true };
    } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        throw nativeDownloadError(e);
    } finally {
        signal?.removeEventListener('abort', onAbort);
        await handle?.remove().catch(() => { /* bridge gone */ });
    }
}

/** A posted clip, natively. Only after nativeDownloadsAvailable() said yes. */
export function saveClipNatively(
    m: ClipManifest,
    name: string,
    onProgress?: (p: ClipDownloadProgress) => void,
    signal?: AbortSignal,
): Promise<SaveResult> {
    const token = getToken();
    if (!token) return Promise.reject(new Error('Not signed in.'));
    const id = newId();
    return run(id, () => downloads().saveClip({
        id, apiBase: normalizeApiBase(API_BASE_URL), token, name,
        clipId: m.clipId, key: b64(m.key), noncePrefix: b64(m.noncePrefix), parts: m.parts,
        totalBytes: m.totalCipherBytes, durationMs: m.durationMs,
    }), onProgress && ((e) => onProgress({ done: e.done, total: e.total, bytesDone: e.bytesDone, totalBytes: m.totalCipherBytes })), signal);
}

/** The parts of a `sovereign-enc:` ref the native path needs (attachments.ts parseEncAttachment). */
export interface EncRef { id: string; key: string; mime: string; cap?: string }

/**
 * An ordinary encrypted attachment, natively. Only after
 * nativeDownloadsAvailable() said yes. `onBytes` hears the ciphertext
 * arriving: bytes so far, and the total when the response announced one
 * (GET /files streams without a Content-Length, so usually null).
 */
export function saveAttachmentNatively(
    ref: EncRef,
    name: string,
    signal?: AbortSignal,
    onBytes?: (received: number, total: number | null) => void,
): Promise<SaveResult> {
    const token = getToken();
    if (!token) return Promise.reject(new Error('Not signed in.'));
    const id = newId();
    return run(id, () => downloads().saveAttachment({
        id, apiBase: normalizeApiBase(API_BASE_URL), token, name,
        fileId: ref.id, key: ref.key, mime: ref.mime, ...(ref.cap ? { cap: ref.cap } : {}),
    }), onBytes && ((e) => onBytes(e.bytesDone, e.totalBytes > 0 ? e.totalBytes : null)), signal);
}
