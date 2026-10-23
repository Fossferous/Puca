/**
 * HEIC/HEIF photos (what most phone cameras save) made into JPEGs on the
 * device, because the engines most of Púca runs in cannot show them.
 *
 * Measured 2026-10-23 with a real HEIC: Edge 155 (the engine of the Windows
 * app, WebView2), Chromium 153 and Firefox 155 all refuse it, in an <img> and
 * in createImageBitmap, whatever type its Blob carries; the Android app's
 * WebView is the same Chromium. Only WebKit (Safari, iOS) decodes it. A HEIC
 * sent as it is therefore showed as a broken picture to nearly everyone
 * (the owner's IMG20261023012318.heic, sent from an Android phone and opened
 * in the Windows app).
 *
 * Attachments are end-to-end encrypted, so the server cannot convert
 * anything: it happens on a device, with what the device has.
 *  - SENDING (convertHeifForUpload): the photo becomes a JPEG before it is
 *    encrypted, so everyone gets a picture every engine shows. The engine
 *    decodes it where it can (WebKit); otherwise the platform does, through
 *    the app's native layer: Windows Imaging Component in the desktop app
 *    (needs the HEIF and HEVC extensions from the Microsoft Store, which many
 *    PCs have), Android's ImageDecoder (Android 9 and newer) in the phone app.
 *    Where nothing can, the original goes up with its metadata blanked
 *    (api/heifMetadata.ts) — never with the location in it, and not at all
 *    when even that cannot be done (HeifNotSendableError).
 *  - SHOWING (heifToJpegForDisplay): a HEIC someone already sent is decoded
 *    the same native way for display only (api/attachments.ts); the browser
 *    has no such way, and there it is shown as a file to download instead of
 *    a broken picture (MessageContent). The phone does this by itself; the
 *    desktop app only when the reader asks (mayDecodeHeifForDisplay says why).
 *
 * What the JPEG keeps: the picture, the right way up (the HEIF rotation is
 * applied by every decoder used here) and at most MAX_HEIF_EDGE pixels on its
 * long edge. Nothing else: a canvas, Android's Bitmap.compress and WIC's
 * encoder fed decoded pixels write no EXIF, so the location, camera and time
 * a phone stores in the HEIC are not in what is sent. The original is not
 * sent beside it: no engine but WebKit could show it, and it would carry
 * exactly that metadata (and twice the bytes) to everyone in the channel.
 */
import { Capacitor } from '@capacitor/core';
import { isTauri } from './platform';
import { stripHeifMetadata } from './heifMetadata';

/** The long edge a converted photo keeps at most: a 12 MP phone photo
 *  (4000x3000) goes through at full size; a 50 MP one is brought down to it. */
export const MAX_HEIF_EDGE = 4096;
/** JPEG quality of a converted photo (0..1). */
export const HEIF_JPEG_QUALITY = 0.9;
/**
 * The largest HEIC handed to the native layer. The desktop app takes it as a
 * raw IPC body, and src-tauri/src/heif.rs refuses more than 64 MB itself.
 * The Android app takes it as base64 inside Capacitor's JSON message, which
 * the WebView and Java each copy (as UTF-16) before ImageDecoder sees a byte:
 * 16 MB is ~21 MB of base64 and roughly 100 MB of Java heap at the peak, one
 * at a time (oneAtATime). A phone photo is 1-10 MB.
 */
export const MAX_NATIVE_HEIF_BYTES_DESKTOP = 64 * 1024 * 1024;
export const MAX_NATIVE_HEIF_BYTES_ANDROID = 16 * 1024 * 1024;

const HEIF_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
/** ISO-BMFF brands of HEIF stills and sequences coded in HEVC (ISO/IEC
 *  23008-12). `mif1`/`msf1` are the generic HEIF brands that AVIF uses too, so
 *  they count only with an HEVC brand beside them and no AVIF one. */
const HEVC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const GENERIC_BRANDS = new Set(['mif1', 'msf1', 'heif']);
const AV1_BRANDS = new Set(['avif', 'avis']);

/** Is this a HEIF media type? */
export function isHeifType(mime: string | null | undefined): boolean {
    return HEIF_TYPES.has((mime || '').toLowerCase().split(';')[0].trim());
}

/** Does this name end like a HEIF file? (.hif is what some cameras write.) */
export function hasHeifName(name: string | null | undefined): boolean {
    return /\.(heic|heif|hif)$/i.test(name || '');
}

/**
 * Do these bytes open as a HEVC-coded HEIF (a HEIC)? Reads the `ftyp` box at
 * the start: its major brand and compatible brands. AVIF, which shares the
 * container and the generic brands, is NOT one (every engine here shows it).
 */
export function sniffHeif(head: Uint8Array): boolean {
    if (head.length < 16) return false;
    const ascii = (at: number) => String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
    if (ascii(4) !== 'ftyp') return false;
    const size = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
    const end = Math.min(head.length, size >= 16 ? size : 16);
    const brands = [ascii(8)];
    for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(at));
    if (brands.some(b => AV1_BRANDS.has(b))) return false;
    if (HEVC_BRANDS.has(brands[0])) return true;
    return GENERIC_BRANDS.has(brands[0]) && brands.some(b => HEVC_BRANDS.has(b));
}

/**
 * What kind of picture these bytes are, from their first bytes: a HEIC
 * ('image/heic'), or one every engine here shows (JPEG, PNG, GIF, WebP, AVIF).
 * null for anything else. A file's type and a ref's `m=` are whatever the
 * sender's device said; the bytes are what a decoder will see.
 */
export function sniffImageType(head: Uint8Array): string | null {
    const at = (i: number, ...v: number[]) => v.every((x, k) => head[i + k] === x);
    if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
    if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
    if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
    if (sniffHeif(head)) return 'image/heic';
    if (head.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'image/avif';
    return null;
}

/**
 * Is this file a HEIC? Only a file that says so (its type or its name) or says
 * nothing (no type: what Windows hands over for a .heic, which has no
 * registered type there) is opened, and then its first bytes decide.
 */
export async function fileIsHeif(file: Blob & { name?: string }): Promise<boolean> {
    const t = (file.type || '').toLowerCase();
    const named = isHeifType(t) || hasHeifName(file.name);
    if (!named && t !== '' && t !== 'application/octet-stream') return false;
    try {
        return sniffHeif(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
    } catch {
        return false;
    }
}

// An 8x8 HEIC (454 bytes, made for this probe): does this engine decode HEIC?
const PROBE_HEIC_B64 =
    'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAXxtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABoAABAAAAAAAAACYAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA/GlwcnAAAADcaXBjbwAAAHVodmNDAQNwAAAAkAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQApQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbqrprm4CGgwIAAAAyAAAADAIRiAAEABkQBwXPBiQAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAAAAAAABAAAAAQAAAAChjbGFwAAAACAAAAAEAAAAIAAAAAf///8gAAAAC////yAAAAAIAAAAQcGl4aQAAAAADCAgIAAAAGGlwbWEAAAAAAAAAAQABBYECAwWEAAAALm1kYXQAAAAiKAGvBBITTOD46cJoP9Kn+SZV668n7asr40mfd7EYkqn/oA==';

let engineProbe: Promise<boolean> | null = null;
/** The probe's answer once it has one (engineShowsType reads it in render). */
let engineAnswer: boolean | null = null;

/** Does this engine decode HEIC itself (WebKit)? Asked once, by decoding a
 *  tiny one. False where there is no createImageBitmap (jsdom, old engines). */
export function engineDecodesHeif(): Promise<boolean> {
    if (!engineProbe) {
        engineProbe = (async () => {
            if (typeof createImageBitmap !== 'function') return false;
            try {
                const bytes = Uint8Array.from(atob(PROBE_HEIC_B64), c => c.charCodeAt(0));
                const bm = await createImageBitmap(new Blob([bytes], { type: 'image/heic' }));
                const ok = bm.width > 0 && bm.height > 0;
                bm.close();
                return ok;
            } catch {
                return false;
            }
        })().then(ok => { engineAnswer = ok; return ok; });
    }
    return engineProbe;
}

/**
 * Can this engine show a picture of this type? false for a HEIF type until
 * the probe has said yes (null: not known yet; engineDecodesHeif is then
 * asked), true for every other type: anything else that will not decode is
 * caught by the <img>'s own error (AttachmentImg).
 */
export function engineShowsType(type: string | null | undefined): boolean | null {
    if (!isHeifType(type)) return true;
    if (engineAnswer !== null) return engineAnswer;
    return null;
}

/** For tests: forget the probe's answer (or set one). */
export function __setEngineDecodesHeif(v: boolean | null): void {
    engineProbe = v === null ? null : Promise.resolve(v);
    engineAnswer = v;
}

/** The size to scale `w`x`h` to so its long edge is at most `maxEdge`. */
export function fitHeifEdge(w: number, h: number, maxEdge = MAX_HEIF_EDGE): { w: number; h: number } {
    const long = Math.max(w, h);
    if (long <= maxEdge || long <= 0) return { w, h };
    const k = maxEdge / long;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** The engine's own decoder (WebKit) through a canvas: no metadata survives. */
async function engineToJpeg(blob: Blob): Promise<Blob | null> {
    if (typeof document === 'undefined') return null;
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch {
        return null;
    }
    try {
        const { w, h } = fitHeifEdge(bitmap.width, bitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0, w, h);
        const out = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', HEIF_JPEG_QUALITY));
        canvas.width = canvas.height = 0;
        return out && out.size > 0 ? out : null;
    } finally {
        bitmap.close();
    }
}

/** One native conversion at a time: each holds a whole photo (and, on
 *  Android, its base64 and Java's copies of it) until it is done, and a
 *  channel scrolled past would otherwise start one per picture at once. The
 *  next one's base64 is made only when its turn comes. */
let nativeQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
    const run = nativeQueue.then(job, job);
    nativeQueue = run.catch(() => undefined);
    return run;
}

/** The native layer said it never will (an installed Android app older than
 *  the method, Android before 9): not asked again this session. */
let nativeNever = false;

/** For tests: forget that the native layer said never. */
export function __resetNativeHeif(): void {
    nativeNever = false;
    nativeQueue = Promise.resolve();
}

function bytesToB64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

/**
 * The platform's decoder, through the app's native layer: WIC in the desktop
 * app, ImageDecoder in the Android app. null where there is none, where it
 * cannot decode this (no HEIF/HEVC extension on that PC, Android before 9,
 * an installed app older than this code), or on any failure: the caller then
 * does what it does without a converter.
 */
async function nativeToJpeg(bytes: Uint8Array): Promise<Uint8Array | null> {
    if (nativeNever) return null;
    const desktop = isTauri();
    if (!desktop && !androidApp()) return null;
    if (bytes.byteLength > (desktop ? MAX_NATIVE_HEIF_BYTES_DESKTOP : MAX_NATIVE_HEIF_BYTES_ANDROID)) {
        console.warn('[heif] too large to hand to the native decoder:', bytes.byteLength, 'bytes');
        return null;
    }
    return oneAtATime(async () => {
        if (nativeNever) return null;
        try {
            if (desktop) {
                const { invoke } = await import('@tauri-apps/api/core');
                const out = await invoke<ArrayBuffer>('heif_to_jpeg', bytes, {
                    headers: { 'x-max-edge': String(MAX_HEIF_EDGE), 'x-quality': String(HEIF_JPEG_QUALITY) },
                });
                return out && out.byteLength > 0 ? new Uint8Array(out) : null;
            }
            // The Púca Notes app is a different native app with no such method:
            // only Púca's own registers SovereignApp (androidApp checks).
            // Loaded only here: api/mobileApp registers Púca's Android plugin
            // when it loads, which every bundle that shows an attachment (Púca
            // Notes' too) would otherwise do.
            const { heifToJpegNatively } = await import('./mobileApp');
            const r = await heifToJpegNatively(bytesToB64(bytes), MAX_HEIF_EDGE, HEIF_JPEG_QUALITY);
            if ('never' in r) {
                nativeNever = true;
                return null;
            }
            return 'data' in r ? Uint8Array.from(atob(r.data), c => c.charCodeAt(0)) : null;
        } catch (err) {
            console.warn('[heif] native conversion unavailable:', err instanceof Error ? err.message : err);
            return null;
        }
    });
}

/** Is there a native converter here at all (before trying one)? */
export function hasNativeHeifConverter(): boolean {
    if (isTauri()) return true;
    return androidApp();
}

function androidApp(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('SovereignApp');
}

/** Files whose HEIC the reader asked to see (MessageContent's Show photo). */
const askedToShow = new Set<string>();

/** The reader asked to see this file's HEIC: decode it next time it opens. */
export function askToShowHeif(fileId: string): void {
    askedToShow.add(fileId);
}

/** Sign-out: forget which files were asked for (api/attachments.ts). */
export function forgetHeifRequests(): void {
    askedToShow.clear();
}

/**
 * May a RECEIVED HEIC (bytes anyone in the channel chose) be decoded natively
 * for display now?
 *  - The Android app: yes, by itself. ImageDecoder hands a HEIF to the OS's
 *    media services, which parse and decode it in their own sandboxed
 *    processes (media.extractor, media.codec), as they do for every app.
 *  - The desktop app: only for a file the reader asked to see (askToShowHeif).
 *    WIC loads the HEIF and HEVC extensions INTO the app's own process, which
 *    is not sandboxed the way WebView2's renderer is (Chromium decodes every
 *    other picture there); decoding whatever arrives, unasked, would hand any
 *    member of any channel a zero-click path into those codecs, which have had
 *    remote-code-execution bugs. A photo you send yourself is your own file,
 *    so convertHeifForUpload asks nobody.
 */
export function mayDecodeHeifForDisplay(fileId: string): boolean {
    if (androidApp()) return true;
    return isTauri() && askedToShow.has(fileId);
}

/** Can the reader ask for a HEIC to be shown here (the desktop app)? */
export function canShowHeifOnRequest(): boolean {
    return isTauri();
}

/** `name` with a .jpg extension in place of its own. */
export function jpegName(name: string | null | undefined): string {
    const stem = (name || 'photo').replace(/\.[^.]+$/, '');
    return `${stem || 'photo'}.jpg`;
}

/** A HEIC that can be neither converted nor sent without its location. */
export class HeifNotSendableError extends Error {
    constructor(name: string) {
        super(`"${name}" wasn't sent: this device can't convert this HEIC photo, and couldn't remove the location and other details stored in it. Convert it to JPEG first, or send it from Púca's Android app.`);
        this.name = 'HeifNotSendableError';
    }
}

/**
 * A picture about to be sent, made safe and showable:
 *  - a HEIC becomes a JPEG where this device can make one;
 *  - a HEIC it cannot convert goes as a HEIC with its metadata blanked
 *    (api/heifMetadata.ts), typed image/heic whatever the device called it, so
 *    readers get its card (and Android readers the picture). When even the
 *    metadata cannot be removed it is refused (HeifNotSendableError) rather
 *    than sent with the sender's location in it, without a word: refusing says
 *    what happened and what to do; asking "send it with your location?" for
 *    a file this rarely seen would teach people to click yes;
 *  - a file that SAYS it is a HEIC but is a JPEG, PNG, GIF, WebP or AVIF goes
 *    under its real type, so every reader's app shows it.
 * Anything else is returned as it is.
 */
export async function convertHeifForUpload(file: File): Promise<File> {
    const t = (file.type || '').toLowerCase();
    const saysHeif = isHeifType(t) || hasHeifName(file.name);
    if (!saysHeif && t !== '' && t !== 'application/octet-stream') return file;
    let head: Uint8Array;
    try {
        head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    } catch {
        return file; // could not even be read: the upload fails on it in its own words
    }
    const real = sniffImageType(head);
    if (real !== 'image/heic') {
        // Labelled a HEIC, but another picture: sent under what it is.
        return real && saysHeif ? new File([file], file.name, { type: real, lastModified: file.lastModified }) : file;
    }
    let jpeg: Blob | null = null;
    let bytes: Uint8Array | null = null;
    try {
        if (await engineDecodesHeif()) jpeg = await engineToJpeg(file);
        if (!jpeg) {
            bytes = new Uint8Array(await file.arrayBuffer());
            const out = await nativeToJpeg(bytes);
            if (out) jpeg = new Blob([out as BlobPart], { type: 'image/jpeg' });
        }
    } catch (err) {
        console.warn('[heif] could not convert', file.name, err instanceof Error ? err.message : err);
    }
    if (jpeg) return new File([jpeg], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
    try {
        bytes ??= new Uint8Array(await file.arrayBuffer());
    } catch {
        return file;
    }
    const stripped = stripHeifMetadata(bytes);
    if (!stripped) throw new HeifNotSendableError(file.name || 'photo');
    console.info('[heif] could not convert', file.name, '- sending it as a HEIC with its metadata removed');
    return new File([stripped as BlobPart], file.name || 'photo.heic', { type: 'image/heic', lastModified: file.lastModified });
}

/**
 * A received HEIC's plaintext as JPEG bytes for DISPLAY, through the native
 * layer only (the engine path would need a page Blob of the plaintext, which
 * api/plaintextHost.ts exists to avoid, and an engine that decodes HEIC
 * shows the original anyway). null when this device cannot, or may not yet
 * (mayDecodeHeifForDisplay).
 */
export async function heifToJpegForDisplay(fileId: string, plain: Uint8Array): Promise<Uint8Array | null> {
    if (!mayDecodeHeifForDisplay(fileId) || !sniffHeif(plain.subarray(0, 64))) return null;
    return nativeToJpeg(plain);
}
