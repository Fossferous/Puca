/**
 * HEIC photos: made a JPEG before they are sent where the device can, shown
 * through the device's decoder where it can, and a file card — never a
 * broken image — where it cannot (api/heif.ts, AttachmentImg).
 *
 * The owner, 2026-10-23: "HEIC doesnt load in text channels", with a
 * broken-image icon for IMG20261023012318.heic, sent from an Android phone and
 * opened in the Windows app. Measured the same day in headless Edge 155 (the
 * WebView2 engine), Chromium 153 and Firefox 155 with the fixture below: an
 * <img> and createImageBitmap both refuse a HEIC, whatever its Blob's type.
 *
 * jsdom decodes nothing, which is what an engine without HEIC looks like here:
 * the real attachment cache opens real AES-GCM ciphertext of the real fixture
 * (only fetch and URL.createObjectURL are stand-ins), the real components
 * decide, and the desktop app's native converter is the one stand-in for what
 * is native (`heif_to_jpeg`, tested on real bytes in src-tauri/src/heif.rs).
 * Every case has a positive control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', async (orig) => ({ ...(await orig<typeof import('@tauri-apps/api/core')>()), invoke: (...a: unknown[]) => invoke(...a) }));
const phoneConvert = vi.fn();
const saved = vi.fn();
vi.mock('../api/saveAttachment', async (orig) => ({
    ...(await orig<typeof import('../api/saveAttachment')>()),
    saveEncryptedAttachment: async (...a: unknown[]) => { saved(...a); return { cancelled: false, where: 'Pictures' }; },
}));
vi.mock('../api/mobileApp', async (orig) => ({ ...(await orig<typeof import('../api/mobileApp')>()), heifToJpegNatively: (...a: unknown[]) => phoneConvert(...a) }));

import { acquireAttachmentUrl, clearBlobCache } from '../api/attachments';
import {
    __resetNativeHeif, __setEngineDecodesHeif, askToShowHeif, convertHeifForUpload, engineDecodesHeif, fileIsHeif, fitHeifEdge, hasHeifName,
    heifToJpegForDisplay, HeifNotSendableError, isHeifType, jpegName, MAX_NATIVE_HEIF_BYTES_ANDROID, sniffHeif, sniffImageType,
} from '../api/heif';
import { stripHeifMetadata } from '../api/heifMetadata';
import { Capacitor } from '@capacitor/core';
import { pendingAttachment, replaceFile, serializeAttachments, markReady } from '../api/composerAttachments';
import { MessageContent } from '../components/MessageContent';
import { TaskAttachments } from '../components/TaskAttachments';
import { ComposerAttachments } from '../components/ComposerAttachments';
import { NoteImages } from '../components/NoteImages';

/** 64x48 stored with a 90-degree irot (shows 48x64), EXIF with a camera name
 *  and GPS; made with libheif for these tests. */
const HEIC = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'heic', 'rotated-gps.heic')));
/** The same kind of photo with XMP beside its Exif (camera "PucaTestCamXmp"). */
const HEIC_XMP = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'heic', 'exif-xmp.heic')));
const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(text);
/** A HEIC whose boxes cannot be read past its ftyp: neither convertible nor
 *  strippable here. */
const BROKEN_HEIC = (() => { const b = new Uint8Array(200); b.set(HEIC.subarray(0, 28)); b.set([0, 0, 0, 0xff, 0x6d, 0x65, 0x74, 0x61], 28); return b; })();
/** What the desktop app's converter hands back in these tests: a JPEG's
 *  start (SOI + JFIF APP0), enough to tell it from the HEIC. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

// jsdom's Blob has no arrayBuffer(); these read real bytes through FileReader.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
        configurable: true,
        value(this: Blob) {
            return new Promise<ArrayBuffer>((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(r.result as ArrayBuffer);
                r.onerror = () => rej(r.error);
                r.readAsArrayBuffer(this);
            });
        },
    });
}

function ftyp(major: string, ...compatible: string[]): Uint8Array {
    const size = 16 + 4 * compatible.length;
    const b = new Uint8Array(size + 8);
    new DataView(b.buffer).setUint32(0, size);
    const put = (at: number, s: string) => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i); };
    put(4, 'ftyp');
    put(8, major);
    compatible.forEach((c, i) => put(16 + 4 * i, c));
    put(size + 4, 'meta');
    return b;
}

describe('which files are HEIC (the same cases as HeifImagesTest.java)', () => {
    it('the real fixture, and the brands phones write', () => {
        expect(sniffHeif(HEIC.subarray(0, 64))).toBe(true);
        expect(sniffHeif(ftyp('heic', 'mif1', 'heic'))).toBe(true);
        expect(sniffHeif(ftyp('heix', 'mif1'))).toBe(true);
        expect(sniffHeif(ftyp('hevc', 'msf1'))).toBe(true);
        expect(sniffHeif(ftyp('mif1', 'mif1', 'heic'))).toBe(true);
    });

    it('positive control: AVIF, MP4, JPEG and PNG are not', () => {
        expect(sniffHeif(ftyp('avif', 'mif1', 'miaf'))).toBe(false);
        expect(sniffHeif(ftyp('mif1', 'avif', 'mif1', 'miaf'))).toBe(false);
        expect(sniffHeif(ftyp('mif1', 'heic', 'avif'))).toBe(false);
        expect(sniffHeif(ftyp('mif1', 'miaf'))).toBe(false);
        expect(sniffHeif(ftyp('isom', 'mp41'))).toBe(false);
        expect(sniffHeif(JPEG)).toBe(false);
        expect(sniffHeif(PNG)).toBe(false);
        expect(sniffHeif(new Uint8Array(0))).toBe(false);
    });

    it('a file is opened only when its type or name says HEIC, or it says nothing', async () => {
        expect(await fileIsHeif(new File([HEIC as BlobPart], 'IMG20261023012318.heic', { type: 'image/heic' }))).toBe(true);
        // What Windows hands over for a .heic: no type at all.
        expect(await fileIsHeif(new File([HEIC as BlobPart], 'IMG.heic'))).toBe(true);
        expect(await fileIsHeif(new File([HEIC as BlobPart], 'photo'))).toBe(true);
        // Named HEIC, but it is a JPEG: not converted.
        expect(await fileIsHeif(new File([JPEG as BlobPart], 'wrong.heic', { type: 'image/heic' }))).toBe(false);
        // Says it is something else: not even read.
        expect(await fileIsHeif(new File([HEIC as BlobPart], 'a.png', { type: 'image/png' }))).toBe(false);
        expect(isHeifType('image/HEIF; foo')).toBe(true);
        expect(isHeifType('image/avif')).toBe(false);
        expect(hasHeifName('x.HIF')).toBe(true);
        expect(jpegName('IMG20261023012318.heic')).toBe('IMG20261023012318.jpg');
        expect(jpegName('')).toBe('photo.jpg');
        expect(fitHeifEdge(8160, 6120)).toEqual({ w: 4096, h: 3072 });
        expect(fitHeifEdge(4000, 3000)).toEqual({ w: 4000, h: 3000 });
    });

    it('what the bytes are, whatever the label: sniffImageType', () => {
        expect(sniffImageType(JPEG)).toBe('image/jpeg');
        expect(sniffImageType(PNG)).toBe('image/png');
        expect(sniffImageType(HEIC.subarray(0, 64))).toBe('image/heic');
        expect(sniffImageType(ftyp('avif', 'mif1'))).toBe('image/avif');
        expect(sniffImageType(new TextEncoder().encode('GIF89a......'))).toBe('image/gif');
        expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
        expect(sniffImageType(ftyp('isom', 'mp41'))).toBeNull();
        expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    });

    it('jsdom, like Chromium, does not decode HEIC itself', async () => {
        __setEngineDecodesHeif(null);
        expect(await engineDecodesHeif()).toBe(false);
    });
});

/** The desktop app, as far as api/heif.ts can tell. */
function asDesktopApp(on: boolean) {
    const w = window as unknown as Record<string, unknown>;
    if (on) w.__TAURI_INTERNALS__ = {}; else delete w.__TAURI_INTERNALS__;
}

describe("a HEIC's metadata, blanked when it has to go as it is", () => {
    it('Exif: the location and camera are gone, every box and offset kept', () => {
        expect(has(HEIC, 'PucaTestCam'), 'control: the fixture names its camera').toBe(true);
        const out = stripHeifMetadata(HEIC)!;
        expect(out).not.toBeNull();
        expect(out.length).toBe(HEIC.length);
        expect(has(out, 'PucaTestCam')).toBe(false);
        // Only the metadata item's bytes changed: the picture (mdat's HEVC)
        // and every box header are as they were.
        const changed = [...out].map((v, i) => (v !== HEIC[i] ? i : -1)).filter(i => i >= 0);
        expect(changed.length).toBeGreaterThan(0);
        expect(changed.length).toBeLessThan(100);
        expect(sniffHeif(out.subarray(0, 64))).toBe(true);
        // The stand-in is an EXIF block with no entries (a big-endian TIFF header).
        const at = changed[0] - 4 >= 0 ? Buffer.from(out).indexOf(Buffer.from([0x4d, 0x4d, 0, 0x2a])) : -1;
        expect(at).toBeGreaterThan(0);
    });

    it('XMP too', () => {
        expect(has(HEIC_XMP, 'PucaTestCamXmp'), 'control: the XMP names the camera').toBe(true);
        const out = stripHeifMetadata(HEIC_XMP)!;
        expect(has(out, 'PucaTestCamXmp')).toBe(false);
        expect(has(out, 'PucaTestCam')).toBe(false);
        expect(has(out, 'adobe:ns:meta/')).toBe(true);
    });

    it('anything it cannot read with certainty is null, never a half-stripped file', () => {
        expect(stripHeifMetadata(BROKEN_HEIC)).toBeNull();
        expect(stripHeifMetadata(JPEG)).toBeNull();
        expect(stripHeifMetadata(HEIC.subarray(0, 300))).toBeNull();
    });
});

describe('sending: a HEIC becomes a JPEG where the device can make one', () => {
    beforeEach(() => {
        __setEngineDecodesHeif(false);
        __resetNativeHeif();
        invoke.mockReset();
        phoneConvert.mockReset();
    });
    afterEach(() => { vi.restoreAllMocks(); });
    afterEach(() => asDesktopApp(false));

    it('the desktop app converts it through the native layer, named .jpg', async () => {
        asDesktopApp(true);
        invoke.mockResolvedValue(JPEG.slice().buffer);
        const heic = new File([HEIC as BlobPart], 'IMG20261023012318.heic', { type: 'image/heic', lastModified: 5 });
        const sent = await convertHeifForUpload(heic);
        expect(sent).not.toBe(heic);
        expect(sent.name).toBe('IMG20261023012318.jpg');
        expect(sent.type).toBe('image/jpeg');
        expect(new Uint8Array(await sent.arrayBuffer())).toEqual(JPEG);
        // The command got the photo's bytes, raw, and the edge to keep.
        expect(invoke).toHaveBeenCalledTimes(1);
        const [cmd, body, opts] = invoke.mock.calls[0] as [string, Uint8Array, { headers: Record<string, string> }];
        expect(cmd).toBe('heif_to_jpeg');
        expect(body).toEqual(HEIC);
        expect(opts.headers['x-max-edge']).toBe('4096');
    });

    it('a .heic with no type (Windows) is converted too', async () => {
        asDesktopApp(true);
        invoke.mockResolvedValue(JPEG.slice().buffer);
        const sent = await convertHeifForUpload(new File([HEIC as BlobPart], 'IMG.heic'));
        expect(sent.type).toBe('image/jpeg');
    });

    it('positive control: anything else goes up untouched and the native layer is never asked', async () => {
        asDesktopApp(true);
        for (const f of [
            new File([JPEG as BlobPart], 'photo.jpg', { type: 'image/jpeg' }),
            new File([PNG as BlobPart], 'shot.png', { type: 'image/png' }),
            new File([ftyp('avif', 'mif1') as BlobPart], 'a.avif', { type: '' }),
        ]) {
            expect(await convertHeifForUpload(f)).toBe(f);
        }
        expect(invoke).not.toHaveBeenCalled();
    });

    it('a JPEG labelled HEIC goes under its real type, so every reader shows it', async () => {
        asDesktopApp(true);
        const liar = new File([JPEG as BlobPart], 'liar.heic', { type: 'image/heic' });
        const sent = await convertHeifForUpload(liar);
        expect(sent.type).toBe('image/jpeg');
        expect(sent.name).toBe('liar.heic');
        expect(new Uint8Array(await sent.arrayBuffer())).toEqual(JPEG);
        expect(invoke).not.toHaveBeenCalled();
    });

    it('where nothing can convert it, it goes as a HEIC with its metadata blanked, never with the location', async () => {
        const heic = new File([HEIC as BlobPart], 'IMG.heic', { type: 'image/heic' });
        // The web app: no native layer, and the engine cannot decode it.
        const web = await convertHeifForUpload(heic);
        expect(invoke).not.toHaveBeenCalled();
        // The desktop app without the extensions: the command fails.
        asDesktopApp(true);
        invoke.mockRejectedValue(new Error('component not found'));
        const desktop = await convertHeifForUpload(heic);
        for (const sent of [web, desktop]) {
            expect(sent).not.toBe(heic);
            expect(sent.name).toBe('IMG.heic');
            expect(sent.type).toBe('image/heic');
            const bytes = new Uint8Array(await sent.arrayBuffer());
            expect(bytes.length).toBe(HEIC.length);
            expect(has(bytes, 'PucaTestCam')).toBe(false);
        }
    });

    it('a .heic with no type that cannot be converted is still typed image/heic, so readers get its card', async () => {
        const sent = await convertHeifForUpload(new File([HEIC as BlobPart], 'IMG.heic'));
        expect(sent.type).toBe('image/heic');
    });

    it('one that can be neither converted nor stripped is refused, saying why', async () => {
        const err = await convertHeifForUpload(new File([BROKEN_HEIC as BlobPart], 'odd.heic', { type: 'image/heic' })).catch(e => e);
        expect(err).toBeInstanceOf(HeifNotSendableError);
        expect(String(err.message)).toContain('"odd.heic" wasn\'t sent');
        expect(String(err.message)).toContain('location');
    });

    it('the Android app: a photo too large for the bridge is never handed to it', async () => {
        vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
        vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
        vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
        phoneConvert.mockResolvedValue({ data: Buffer.from(JPEG).toString('base64') });
        const big = new Uint8Array(MAX_NATIVE_HEIF_BYTES_ANDROID + 1);
        big.set(HEIC);
        const sent = await convertHeifForUpload(new File([big as BlobPart], 'big.heic', { type: 'image/heic' }));
        expect(phoneConvert).not.toHaveBeenCalled();
        expect(sent.type).toBe('image/heic');
        // Control: one at the cap's size is handed over.
        await convertHeifForUpload(new File([HEIC as BlobPart], 'small.heic', { type: 'image/heic' }));
        expect(phoneConvert).toHaveBeenCalledTimes(1);
    });

    it('the Android app: one conversion at a time, and an app that never will is not asked again', async () => {
        vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
        vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
        vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
        let inFlight = 0, most = 0;
        phoneConvert.mockImplementation(async () => {
            inFlight++; most = Math.max(most, inFlight);
            await new Promise(r => setTimeout(r, 15));
            inFlight--;
            return { data: Buffer.from(JPEG).toString('base64') };
        });
        const files = Array.from({ length: 5 }, (_, i) => new File([HEIC as BlobPart], `p${i}.heic`, { type: 'image/heic' }));
        const out = await Promise.all(files.map(f => convertHeifForUpload(f)));
        expect(out.every(f => f.type === 'image/jpeg')).toBe(true);
        expect(phoneConvert).toHaveBeenCalledTimes(5);
        expect(most, 'conversions running at once').toBe(1);
        // An APK without the method (or Android 8): asked once, then never.
        phoneConvert.mockReset();
        phoneConvert.mockResolvedValue({ never: true });
        await convertHeifForUpload(files[0]);
        await convertHeifForUpload(files[1]);
        expect(phoneConvert).toHaveBeenCalledTimes(1);
    });
});

describe('the composer', () => {
    it('a converted photo\'s chip takes the JPEG\'s name, type and thumbnail, and is sent as a picture', () => {
        const chip = pendingAttachment({ name: 'IMG.heic', type: 'image/heic' }, null);
        let list = replaceFile([chip], chip.localId, { name: 'IMG.jpg', type: 'image/jpeg' }, 'blob:jpeg');
        expect(list[0]).toMatchObject({ name: 'IMG.jpg', mime: 'image/jpeg', previewUrl: 'blob:jpeg', status: 'uploading' });
        list = markReady(list, chip.localId, 'sovereign-enc:x?k=k&m=image%2Fjpeg');
        expect(serializeAttachments(list)).toBe('![IMG.jpg](sovereign-enc:x?k=k&m=image%2Fjpeg)');
    });

    it('a thumbnail the engine cannot draw is the file icon, never a broken image', async () => {
        __setEngineDecodesHeif(false);
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const heic = { ...pendingAttachment({ name: 'IMG.heic', type: 'image/heic' }, 'blob:heic') };
        const jpg = { ...pendingAttachment({ name: 'IMG.jpg', type: 'image/jpeg' }, 'blob:jpg') };
        await act(async () => { root.render(<ComposerAttachments attachments={[heic, jpg]} onRemove={() => {}} onToggleSpoiler={() => {}} onRetry={() => {}} />); });
        const thumbs = [...container.querySelectorAll('.composer-chip-thumb')];
        expect(thumbs[0].querySelector('img'), 'a HEIC thumbnail was mounted').toBeNull();
        expect(thumbs[0].querySelector('svg')).not.toBeNull();
        // Positive control: the JPEG's thumbnail is an <img>.
        expect(thumbs[1].querySelector('img')?.getAttribute('src')).toBe('blob:jpg');
        // And one that fails to decode becomes the icon too.
        await act(async () => { thumbs[1].querySelector('img')!.dispatchEvent(new Event('error')); });
        expect(thumbs[1].querySelector('img')).toBeNull();
        await act(async () => { root.unmount(); });
        container.remove();
    });
});

describe('showing one someone already sent', () => {
    let container: HTMLDivElement;
    let root: Root;
    let served: Map<string, Uint8Array>;
    let blobTypes: Map<string, string>;
    let seq = 0;
    const origCreate = URL.createObjectURL;

    async function seal(id: string, plain: Uint8Array): Promise<string> {
        const raw = crypto.getRandomValues(new Uint8Array(32));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, plain as BufferSource));
        const body = new Uint8Array(12 + ct.length);
        body.set(nonce);
        body.set(ct, 12);
        served.set(id, body);
        return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    const ref = (id: string, key: string, mime: string) => `sovereign-enc:${id}?k=${key}&m=${encodeURIComponent(mime)}`;
    const settle = async () => {
        await act(async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); });
    };

    beforeEach(() => {
        __setEngineDecodesHeif(false);
        __resetNativeHeif();
        invoke.mockReset();
        phoneConvert.mockReset();
        saved.mockReset();
        served = new Map();
        blobTypes = new Map();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const body = served.get(String(input).split('/files/')[1]);
            return body ? new Response(body.slice()) : new Response('', { status: 404 });
        });
        URL.createObjectURL = ((b: Blob) => {
            const u = `blob:test-${++seq}`;
            blobTypes.set(u, b.type);
            return u;
        }) as typeof URL.createObjectURL;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
        clearBlobCache();
        asDesktopApp(false);
        URL.createObjectURL = origCreate;
        vi.restoreAllMocks();
    });

    it('the desktop app does NOT decode a received HEIC by itself (its codec runs in the app process)', async () => {
        asDesktopApp(true);
        invoke.mockResolvedValue(JPEG.slice().buffer);
        const key = await seal('h0', HEIC);
        const hold = await acquireAttachmentUrl('h0', key, 'image/heic');
        expect(hold.type).toBe('image/heic');
        expect(invoke).not.toHaveBeenCalled();
        hold.release();
    });

    it('the Android app decodes one by itself (the OS decodes it in its sandboxed media services)', async () => {
        vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
        vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
        vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
        let given = '';
        phoneConvert.mockImplementation(async (b64: string) => { given = b64; return { data: Buffer.from(JPEG).toString('base64') }; });
        const key = await seal('ha', HEIC);
        const hold = await acquireAttachmentUrl('ha', key, 'image/heic');
        expect(hold.type).toBe('image/jpeg');
        expect(blobTypes.get(hold.url)).toBe('image/jpeg');
        expect(new Uint8Array(Buffer.from(given, 'base64'))).toEqual(HEIC);
        hold.release();
    });

    it('the desktop app decodes one the reader asked to see: the held URL is a JPEG', async () => {
        asDesktopApp(true);
        askToShowHeif('h1');
        // A copy of what it was handed: the cache frees the plaintext as soon
        // as the JPEG replaces it.
        let given: Uint8Array | null = null;
        invoke.mockImplementation(async (_cmd: string, body: Uint8Array) => { given = body.slice(); return JPEG.slice().buffer; });
        const key = await seal('h1', HEIC);
        const hold = await acquireAttachmentUrl('h1', key, 'image/heic');
        expect(hold.type).toBe('image/jpeg');
        expect(blobTypes.get(hold.url)).toBe('image/jpeg');
        // It was handed the decrypted photo.
        expect(given).toEqual(HEIC);
        hold.release();
    });

    it('positive control: with no decoder the URL is the HEIC itself, and other pictures are never converted', async () => {
        const key = await seal('h2', HEIC);
        const hold = await acquireAttachmentUrl('h2', key, 'image/heic');
        expect(hold.type).toBe('image/heic');
        expect(blobTypes.get(hold.url)).toBe('image/heic');
        hold.release();
        asDesktopApp(true);
        const k2 = await seal('p1', PNG);
        const png = await acquireAttachmentUrl('p1', k2, 'image/png');
        expect(png.type).toBe('image/png');
        expect(invoke).not.toHaveBeenCalled();
        // heifToJpegForDisplay refuses bytes that are not a HEIC outright.
        askToShowHeif('p1');
        expect(await heifToJpegForDisplay('p1', PNG)).toBeNull();
        expect(invoke).not.toHaveBeenCalled();
        png.release();
    });

    it('a chat message: a HEIC nothing here can show is a card with its name, size and Download, never an <img>', async () => {
        const key = await seal('m-heic', HEIC);
        await act(async () => { root.render(<MessageContent content={`![IMG20261023012318.heic](${ref('m-heic', key, 'image/heic')})`} members={[]} />); });
        await settle();
        expect(container.querySelector('img'), 'a HEIC was handed to an <img>').toBeNull();
        const card = container.querySelector('.message-picture-file');
        expect(card?.textContent).toContain('IMG20261023012318.heic');
        expect(card?.textContent).toContain('HEIC photo, 1 KB');
        expect(card?.textContent).toContain("can't show it");
        expect(card?.querySelector('button.message-attachment')?.textContent).toContain('IMG20261023012318.heic');
    });

    it('in the desktop app the card offers Show photo, which shows the decoded picture', async () => {
        asDesktopApp(true);
        invoke.mockResolvedValue(JPEG.slice().buffer);
        const key = await seal('m-heic2', HEIC);
        await act(async () => { root.render(<MessageContent content={`![IMG.heic](${ref('m-heic2', key, 'image/heic')})`} members={[]} />); });
        await settle();
        expect(invoke, 'nothing decoded before the reader asked').not.toHaveBeenCalled();
        const show = [...container.querySelectorAll('.message-picture-file button')].find(b => b.textContent?.includes('Show photo')) as HTMLButtonElement | undefined;
        expect(show, 'the card offers Show photo').toBeTruthy();
        await act(async () => { show!.click(); });
        await settle();
        const img = container.querySelector('.message-image img');
        expect(img).not.toBeNull();
        expect(blobTypes.get(img!.getAttribute('src')!)).toBe('image/jpeg');
        expect(container.querySelector('.message-picture-file')).toBeNull();
    });

    it('in the desktop app without the HEIF extensions, Show photo says what is missing', async () => {
        asDesktopApp(true);
        invoke.mockRejectedValue(new Error('component not found'));
        const key = await seal('m-heic3', HEIC);
        await act(async () => { root.render(<MessageContent content={`![IMG.heic](${ref('m-heic3', key, 'image/heic')})`} members={[]} />); });
        await settle();
        const show = [...container.querySelectorAll('.message-picture-file button')].find(b => b.textContent?.includes('Show photo')) as HTMLButtonElement;
        await act(async () => { show.click(); });
        await settle();
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(container.querySelector('img')).toBeNull();
        const card = container.querySelector('.message-picture-file');
        expect(card?.textContent).toContain('Windows could not open it');
        expect([...card!.querySelectorAll('button')].map(b => b.textContent?.trim())).toEqual(['IMG.heic']);
    });

    it('a JPEG labelled image/heic is shown as the JPEG it is', async () => {
        const key = await seal('m-liar', JPEG);
        const hold = await acquireAttachmentUrl('m-liar', key, 'image/heic');
        expect(hold.type).toBe('image/jpeg');
        hold.release();
        await act(async () => { root.render(<MessageContent content={`![liar.heic](${ref('m-liar', key, 'image/heic')})`} members={[]} />); });
        await settle();
        expect(container.querySelector('.message-image img')).not.toBeNull();
        expect(container.querySelector('.message-picture-file')).toBeNull();
    });

    it('a HEIC labelled image/jpeg, or sent with no type under a .heic name, gets the HEIC card', async () => {
        const key = await seal('m-hj', HEIC);
        const k2 = await seal('m-ho', HEIC);
        await act(async () => {
            root.render(<>
                <MessageContent content={`![a.jpg](${ref('m-hj', key, 'image/jpeg')})`} members={[]} />
                <MessageContent content={`[b.heic](${ref('m-ho', k2, 'application/octet-stream')})`} members={[]} />
            </>);
        });
        await settle();
        expect(container.querySelector('img')).toBeNull();
        const cards = [...container.querySelectorAll('.message-picture-file')].map(c => c.textContent);
        expect(cards.length).toBe(2);
        expect(cards.every(t => t?.includes('HEIC photo'))).toBe(true);
    });

    it('positive control: an octet-stream file with another name is still a plain download', async () => {
        const key = await seal('m-bin', HEIC);
        await act(async () => { root.render(<MessageContent content={`[notes.bin](${ref('m-bin', key, 'application/octet-stream')})`} members={[]} />); });
        await settle();
        expect(container.querySelector('.message-picture-file')).toBeNull();
        expect(container.querySelector('button.message-attachment')?.textContent).toContain('notes.bin');
    });

    it('Download from the lightbox saves what is shown: a decoded HEIC is saved as its JPEG, never natively from the original', async () => {
        vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
        vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
        vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
        phoneConvert.mockResolvedValue({ data: Buffer.from(JPEG).toString('base64') });
        const key = await seal('m-dl', HEIC);
        const k2 = await seal('m-dl2', PNG);
        await act(async () => {
            root.render(<>
                <MessageContent content={`![IMG.heic](${ref('m-dl', key, 'image/heic')})`} members={[]} />
                <MessageContent content={`![shot.png](${ref('m-dl2', k2, 'image/png')})`} members={[]} />
            </>);
        });
        await settle();
        const download = async (alt: string) => {
            await act(async () => { (container.querySelector(`img[alt="${alt}"]`) as HTMLImageElement).click(); });
            await settle();
            const btn = document.querySelector('.image-lightbox-dl') as HTMLButtonElement;
            await act(async () => { btn.click(); });
            await settle();
            const call = saved.mock.calls.at(-1) as [string, unknown, string];
            await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
            await settle();
            return call;
        };
        const [, ref1, name1] = await download('IMG.heic');
        expect(ref1, 'no ref: the native save would fetch the original HEIC').toBeNull();
        expect(name1).toBe('IMG.jpg');
        // Control: an ordinary picture still saves from its ref (natively on Android).
        const [, ref2, name2] = await download('shot.png');
        expect(ref2).not.toBeNull();
        expect(name2).toBe('shot.png');
    });

    it('any picture that fails to decode becomes the card (control: it was an <img> first)', async () => {
        const key = await seal('m-png', PNG);
        await act(async () => { root.render(<MessageContent content={`![shot.png](${ref('m-png', key, 'image/png')})`} members={[]} />); });
        await settle();
        const img = container.querySelector('.message-image img');
        expect(img, 'control: a PNG is shown as a picture').not.toBeNull();
        await act(async () => { img!.dispatchEvent(new Event('error')); });
        expect(container.querySelector('.message-image img')).toBeNull();
        expect(container.querySelector('.message-picture-file')?.textContent).toContain('Picture, ');
    });

    it("a note's gallery: a HEIC nothing here can show is its download button", async () => {
        const k1 = await seal('n-heic', HEIC);
        const k2 = await seal('n-png', PNG);
        const opened = JSON.stringify([
            { href: ref('n-heic', k1, 'image/heic'), name: 'IMG.heic' },
            { href: ref('n-png', k2, 'image/png'), name: 'shot.png' },
        ]);
        await act(async () => { root.render(<NoteImages opened={opened} editable={false} />); });
        await settle();
        expect([...container.querySelectorAll('img')].map(i => i.getAttribute('alt')), 'only the PNG is an <img>').toEqual(['shot.png']);
        expect([...container.querySelectorAll('button.ni-file')].map(b => b.textContent)).toEqual(['IMG.heic']);
    });

    it('a Task attachment: a HEIC nothing here can show is its download button', async () => {
        const key = await seal('t-heic', HEIC);
        const k2 = await seal('t-png', PNG);
        await act(async () => {
            root.render(<TaskAttachments refs={[
                { href: ref('t-heic', key, 'image/heic'), name: 'IMG.heic' },
                { href: ref('t-png', k2, 'image/png'), name: 'shot.png' },
            ]} canEdit={false} onRemove={() => {}} />);
        });
        await settle();
        const imgs = [...container.querySelectorAll('img')];
        expect(imgs.map(i => i.getAttribute('alt')), 'only the PNG is an <img>').toEqual(['shot.png']);
        expect(container.textContent).toContain('IMG.heic');
        expect([...container.querySelectorAll('button')].some(b => b.textContent?.includes('IMG.heic'))).toBe(true);
    });
});
