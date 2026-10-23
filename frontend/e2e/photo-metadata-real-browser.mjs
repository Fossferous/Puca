// Does a photo sent as an attachment still carry where it was taken?
//
// WHY THIS EXISTS. Attachments are encrypted on the sender's device, so the
// server never sees a photo — but the people in the channel do, and a phone
// photo's EXIF holds a GPS fix, the camera and the capture time. vitest
// (tests/imageMetadata.test.ts, tests/attachmentMetadata.test.ts) proves the
// stripper and the seal on hand-built bytes under jsdom. Only a real browser
// shows the two things that matter to a person:
//
//   1. the REAL decoder gives the SAME PICTURE from the stripped file as from
//      the original — every pixel, at the same size, and a photo stored
//      sideways (Orientation 6) is still upright (negative control: the same
//      photo with the Orientation tag removed decodes lying down), and
//   2. the real attachment path — api/attachments.ts bundled as it ships,
//      real WebCrypto, the real apiClient posting to /upload — carries none
//      of the metadata to the recipient's side of the ciphertext.
//
// The page is a real origin; fetch('/upload') is answered by a stand-in that
// keeps the ciphertext it was sent (the server never sees plaintext anyway),
// and the script then does what a recipient's client does: read the key from
// the ref, AES-GCM-decrypt.
//
// SILENT: canvas pictures only, no audio, no window shown (headless).
//
//   cd frontend && node e2e/photo-metadata-real-browser.mjs
//
// No server and no build needed.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = `
import { encryptAndUploadRef, parseEncAttachment } from './api/attachments';
import { ImageMetadataError, stripImageMetadata } from './api/imageMetadata';
import * as fx from './tests/fixtures/photoMetadata';
window.__rig = { encryptAndUploadRef, parseEncAttachment, ImageMetadataError, stripImageMetadata, fx };
`;
const bundle = await build({
    stdin: { contents: entry, resolveDir: join(here, '..', 'src'), loader: 'ts', sourcefile: 'entry.ts' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"VITE_API_URL":"http://127.0.0.1:1"}', __APP_VERSION__: '"0"', __RC_ENABLED__: 'true' },
    logOverride: { 'empty-import-meta': 'silent' },
    logLevel: 'error',
});
const rigSrc = bundle.outputFiles[0].text;

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><meta charset=utf-8><title>photo-metadata</title><body>rig</body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/`;

const CHANNEL = process.env.CHANNEL || 'msedge';
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--mute-audio'],
});
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(origin);
await page.addScriptTag({ content: rigSrc });

const r = await page.evaluate(async () => {
    const { encryptAndUploadRef, parseEncAttachment, ImageMetadataError, stripImageMetadata, fx } = window.__rig;
    const W = 64, H = 48;

    // ---- the stand-in server: keeps the ciphertext, answers like /upload does
    const uploads = [];
    window.fetch = async (url, init) => {
        if (String(url).includes('/upload') && init?.body instanceof FormData) {
            uploads.push(new Uint8Array(await init.body.get('file').arrayBuffer()));
            return new Response(JSON.stringify({ id: 'f' + uploads.length, original_name: 'attachment.enc', mime_type: 'application/octet-stream', size_bytes: 1, url: '/files/f', cap: 'CAP' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 404 });
    };

    // ---- a recipient's side
    const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const open = async (sealed, keyB64) => {
        const key = await crypto.subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['decrypt']);
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, key, sealed.slice(12)));
    };
    const send = async (bytes, name, type) => {
        const before = uploads.length;
        const ref = await encryptAndUploadRef(new File([bytes], name, { type }));
        if (uploads.length !== before + 1) throw new Error('no upload');
        return open(uploads[uploads.length - 1], parseEncAttachment(ref.href).key);
    };

    // ---- a real picture: not flat, so a wrong pixel cannot hide
    const canvas = new OffscreenCanvas(W, H);
    const g = canvas.getContext('2d');
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        g.fillStyle = `rgb(${(x * 4) & 255},${(y * 5) & 255},${((x * y) >> 2) & 255})`;
        g.fillRect(x, y, 1, 1);
    }
    const enc = async (type) => new Uint8Array(await (await canvas.convertToBlob({ type, quality: 0.9 })).arrayBuffer());
    const jpegPlain = await enc('image/jpeg');
    const pngPlain = await enc('image/png');
    const webpPlain = await enc('image/webp');

    // ---- the same pictures, as a phone would store them: with metadata and a sideways tag
    const { cat, enc: ascii, jseg, pchunk, wchunk, exifTiff, SECRET_XMP, SECRET_COMMENT } = fx;
    const xmpPacket = ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>' + SECRET_XMP + '</x:xmpmeta>');
    const putJpeg = (plain, orientation) => {
        let at = 2;
        if (plain[2] === 0xFF && plain[3] === 0xE0) at = 4 + ((plain[4] << 8) | plain[5]); // behind JFIF
        const exif = orientation === 'none' ? [] : [jseg(0xE1, cat(ascii('Exif\0\0'), exifTiff(orientation, { gps: true })))];
        return cat(plain.subarray(0, at), ...exif, jseg(0xE1, xmpPacket), jseg(0xFE, ascii(SECRET_COMMENT)), plain.subarray(at));
    };
    const putPng = (plain, orientation) => {
        const ihdrEnd = 8 + 12 + 13;
        const exif = orientation === 'none' ? [] : [pchunk('eXIf', exifTiff(orientation, { gps: true }))];
        return cat(plain.subarray(0, ihdrEnd), ...exif,
            pchunk('tEXt', cat(ascii('Comment'), [0], ascii(SECRET_COMMENT))),
            pchunk('iTXt', cat(ascii('XML:com.adobe.xmp'), [0, 0, 0, 0, 0], ascii(SECRET_XMP))),
            plain.subarray(ihdrEnd));
    };
    const putWebp = (plain, orientation) => {
        // Chromium writes an EXTENDED WebP (VP8X, with an ICC profile): add the flags and the chunks to it.
        if (String.fromCharCode(...plain.subarray(12, 16)) !== 'VP8X') throw new Error('expected an extended WebP from the encoder');
        const head = Uint8Array.from(plain);
        head[20] |= 0x04 | (orientation === 'none' ? 0 : 0x08);
        const tail = cat(
            ...(orientation === 'none' ? [] : [wchunk('EXIF', exifTiff(orientation, { gps: true }))]),
            wchunk('XMP ', ascii('<x:xmpmeta>' + SECRET_XMP + '</x:xmpmeta>')),
        );
        const out = cat(head, tail);
        new DataView(out.buffer).setUint32(4, out.length - 8, true);
        return out;
    };

    // ---- what the real decoder makes of bytes
    const decode = async (bytes, type) => {
        let bmp;
        try { bmp = await createImageBitmap(new Blob([bytes], { type })); }
        catch (e) { throw new Error('decode failed (' + type + ', ' + bytes.length + ' bytes): ' + e.message); }
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(bmp, 0, 0);
        const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
        const out = { w: bmp.width, h: bmp.height, px: d };
        bmp.close();
        return out;
    };
    const sameImage = (a, b) => a.w === b.w && a.h === b.h && a.px.length === b.px.length && a.px.every((v, i) => v === b.px[i]);
    const imgTag = (bytes, type) => new Promise((res) => {
        const im = new Image();
        im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => res(null);
        im.src = URL.createObjectURL(new Blob([bytes], { type }));
    });

    const out = { formats: {} };
    const cases = [
        ['jpeg', 'image/jpeg', jpegPlain, putJpeg],
        ['png', 'image/png', pngPlain, putPng],
        ['webp', 'image/webp', webpPlain, putWebp],
    ];
    for (const [name, type, plain, put] of cases) {
        const sideways = put(plain, 6);
        const upright = put(plain, 'none'); // control: same file, Orientation tag absent
        const received = await send(sideways, `IMG.${name}`, type);
        const o = {
            controlLeaks: fx.leaked(sideways),
            leaks: fx.leaked(received),
            inBytes: sideways.length, outBytes: received.length,
        };
        const a = await decode(sideways, type);
        const b = await decode(received, type);
        const c = await decode(upright, type);
        o.dims = { original: [a.w, a.h], received: [b.w, b.h], noTag: [c.w, c.h] };
        o.samePixels = sameImage(a, b);
        o.tagMatters = a.w !== c.w || a.h !== c.h;
        const ta = await imgTag(sideways, type);
        const tb = await imgTag(received, type);
        o.imgTag = { original: ta, received: tb };
        o.second = Array.from(stripImageMetadata(received)).join() === Array.from(received).join();
        out.formats[name] = o;
    }

    // ---- an upright photo: no EXIF is written at all
    const upr = await send(putJpeg(jpegPlain, 1), 'up.jpg', 'image/jpeg');
    out.uprightHasExif = fx.indexOfBytes(upr, 'Exif') >= 0;
    out.uprightLeaks = fx.leaked(upr);

    // ---- a GIF and a PDF-ish blob go through as they are
    const gif = cat(ascii('GIF89a'), [1, 0, 1, 0, 0, 0, 0], ascii(SECRET_COMMENT));
    out.gifSame = Array.from(await send(gif, 'a.gif', 'image/gif')).join() === Array.from(gif).join();

    // ---- a JPEG with a damaged segment: refused loudly, nothing uploaded
    const damaged = Uint8Array.from(putJpeg(jpegPlain, 6));
    const exifAt = fx.indexOfBytes(damaged, 'Exif') - 4;
    damaged[exifAt + 2] = 0xFF; damaged[exifAt + 3] = 0xFF;
    const n0 = uploads.length;
    try { await send(damaged, 'x.jpg', 'image/jpeg'); out.damaged = 'sent'; }
    catch (e) { out.damaged = e instanceof ImageMetadataError ? 'refused:' + e.message.slice(0, 40) : 'other:' + e; }
    out.damagedUploads = uploads.length - n0;
    return out;
});

for (const [name, o] of Object.entries(r.formats)) {
    ck(o.controlLeaks.length >= 3, `${name}: the photo going in carries metadata (control)`, o.controlLeaks.join(', '));
    ck(o.leaks.length === 0, `${name}: the recipient's copy carries none of it`, JSON.stringify(o.leaks));
    ck(o.samePixels, `${name}: the real decoder gives the same picture, pixel for pixel`, JSON.stringify(o.dims));
    // Chromium applies Orientation to JPEG and PNG (eXIf) but ignores it in WebP, so there the
    // control cannot be made; the pixel-for-pixel check above is what holds.
    if (name === 'webp') console.log('INFO', `${name}: this Chromium ignores a WebP's Orientation (dims ${JSON.stringify(o.dims)}); no orientation control possible`);
    else ck(o.tagMatters, `${name}: control — the Orientation tag changes how this decoder shows the photo`, JSON.stringify(o.dims));
    ck(o.imgTag.original && o.imgTag.received && o.imgTag.original.w === o.imgTag.received.w && o.imgTag.original.h === o.imgTag.received.h,
        `${name}: an <img> shows it at the same size (upright if it was)`, JSON.stringify(o.imgTag));
    ck(o.outBytes < o.inBytes, `${name}: smaller by about the metadata (${o.inBytes} -> ${o.outBytes})`);
    ck(o.second, `${name}: stripping the received file again changes nothing`);
}
ck(r.uprightHasExif === false && r.uprightLeaks.length === 0, 'an upright photo is sent with no EXIF block at all');
ck(r.gifSame, 'a GIF goes through byte for byte');
ck(r.damaged.startsWith('refused:') && r.damagedUploads === 0, 'a damaged JPEG is refused and nothing is uploaded', r.damaged);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
