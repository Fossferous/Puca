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
// And the same for every other format the seal strips (api/fileMetadata.ts),
// with REAL files (src/tests/fixtures/metadata, made by Pillow and FFmpeg;
// make-fixtures.py there says how), each one's metadata found in it first
// (the NEGATIVE CONTROL) and gone from what the recipient opens:
//
//   3. an animated GIF: WebCodecs' ImageDecoder gives the same frames, pixel
//      for pixel, the same number of them, and it still loops; and one with
//      a byte that starts no block after its last frame (padding, no
//      trailer; a stray 0x00 before one frame more): the engine shows the
//      frames before that byte and no more (the frame after it NOT shown,
//      while the same frame with no stray byte before it IS: the NEGATIVE
//      CONTROL), and the cleaned copy is exactly those frames;
//   4. an AVIF photo: the same picture, pixel for pixel;
//   5. an MP4 (Android's udta and ©xyz-style tags), a MOV (the iPhone's
//      moov/meta keys), the MP4 again with a dashcam's GPS block and index
//      and vendors' boxes in moov and at the top (freed whatever they are
//      called), and a WebM and an MKV (Tags, an attached file): the
//      same size, duration and first and last frames, pixel for pixel, from
//      a muted <video> that never plays (seeked); an engine that cannot open
//      the ORIGINAL says SKIP for that one, never PASS;
//      and a WebM this engine's own MediaRecorder wrote (what Púca Notes'
//      voice recorder makes), its first frame the same;
//   6. a TIFF loses its tags too; no engine here draws one, so its strips
//      are compared byte for byte (and in tests/fileMetadata.test.ts);
//   7. an SVG an editor saved: drawn in an <img>, the same picture pixel for
//      pixel; opened as a DOCUMENT (an iframe, which is what a downloaded
//      file opened in a browser is), the original's script runs and it asks
//      outside hosts for things, each planted way of asking among them (HTML
//      in a foreignObject, an escaped `u\72l(`, `@\69mport "…"`,
//      `image-set("…")`, an href animation under another prefix: NEGATIVE
//      CONTROLS), the cleaned one does neither; no outside request ever
//      leaves this machine (they are all answered here, refused); and a
//      diagram as Mermaid, draw.io and Excalidraw export one (HTML labels in
//      a foreignObject, a font embedded as a data: URL): drawn the same,
//      pixel for pixel, where the same diagram with its labels or its font
//      taken out (what the cleaner did before 2026-11-22) is not (NEGATIVE
//      CONTROLS: the comparison can fail); draw.io's icons, SVGs in data:
//      URLs (base64 and percent-encoded), are part of that same picture, and
//      the diagram with them taken out (the cleaner before its review) is
//      drawn differently too;
//   8. a 256 MB video, a 256 MB TIFF and a 128 MB GIF sent peer to peer
//      (stripFileMetadata, a File made of slices): fixed in a bounded time
//      without the page reading them whole.
//
// The page is a real origin; fetch('/upload') is answered by a stand-in that
// keeps the ciphertext it was sent (the server never sees plaintext anyway),
// and the script then does what a recipient's client does: read the key from
// the ref, AES-GCM-decrypt.
//
// SILENT: pictures, and videos with no audio track in a muted <video> that
// is only seeked, never played; no window shown (headless).
//
//   cd frontend && node e2e/photo-metadata-real-browser.mjs
//
// No server and no build needed; no request leaves this machine.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const entry = `
import { encryptAndUploadRef, parseEncAttachment } from './api/attachments';
import { ImageMetadataError, stripImageMetadata } from './api/imageMetadata';
import { stripFileMetadata } from './api/fileMetadata';
import * as fx from './tests/fixtures/photoMetadata';
import { inkscapeSvg, diagramSvg } from './tests/fixtures/svgDrawing';
window.__rig = { encryptAndUploadRef, parseEncAttachment, ImageMetadataError, stripImageMetadata, stripFileMetadata, fx, inkscapeSvg, diagramSvg };
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

const fixtures = join(here, '..', 'src', 'tests', 'fixtures', 'metadata');
const server = http.createServer((req, res) => {
    const fx = /^\/fx\/([a-z0-9.-]+)$/.exec(req.url ?? '');
    if (fx) {
        try { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(readFileSync(join(fixtures, fx[1]))); }
        catch { res.writeHead(404); res.end(); }
        return;
    }
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
// Nothing leaves this machine: a request to anywhere but this rig is refused here (and counted:
// an SVG opened as a document must ask for nothing).
const outside = [];
await page.route((url) => !url.href.startsWith(origin) && !url.href.startsWith('blob:') && !url.href.startsWith('data:'), (route) => {
    outside.push(route.request().url());
    return route.abort();
});
await page.goto(origin);
await page.addScriptTag({ content: rigSrc });
await page.evaluate(() => { window.__realFetch = window.fetch.bind(window); });

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

    // ---- a PDF-ish file goes through as it is
    const pdf = ascii('%PDF-1.7 ' + SECRET_COMMENT);
    out.pdfSame = Array.from(await send(pdf, 'a.pdf', 'application/pdf')).join() === Array.from(pdf).join();

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
ck(r.pdfSame, 'a file of no format with metadata (a PDF) goes through byte for byte');
ck(r.damaged.startsWith('refused:') && r.damagedUploads === 0, 'a damaged JPEG is refused and nothing is uploaded', r.damaged);

// ---- 3-8: the other formats, real files, through the same seal
const MARKS = ['SECRETCAM-Corp', 'PhoneModelX-9000', 'SECRETXMP-creator-jane', 'SECRETCOMMENT-hello', 'SECRETIPTC-caption', '+47.6062-122.3321', 'SECRETCAM-Firmware', 'SECRETCAM-Software', '2026:10:23', '2026-10-23', 'note.txt', 'Lavf'];
// Helpers in the page, once: the seal and a recipient's open, the fixtures, pixels.
await page.evaluate((MARKS) => {
    const { encryptAndUploadRef, parseEncAttachment } = window.__rig;
    const uploads = [];
    window.fetch = async (url, init) => {
        if (String(url).includes('/upload') && init?.body instanceof FormData) {
            uploads.push(new Uint8Array(await init.body.get('file').arrayBuffer()));
            return new Response(JSON.stringify({ id: 'f' + uploads.length, original_name: 'attachment.enc', mime_type: 'application/octet-stream', size_bytes: 1, url: '/files/f', cap: 'CAP' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 404 });
    };
    const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const latin1 = (b) => new TextDecoder('latin1').decode(b);
    window.__h = {
        latin1,
        send: async (bytes, name, type) => {
            const ref = await encryptAndUploadRef(new File([bytes], name, { type }));
            const sealed = uploads[uploads.length - 1];
            const key = await crypto.subtle.importKey('raw', unb64(parseEncAttachment(ref.href).key), 'AES-GCM', false, ['decrypt']);
            return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, key, sealed.slice(12)));
        },
        marks: (b) => { const s = latin1(b); return MARKS.filter((m) => s.includes(m)); },
        fixture: async (name) => new Uint8Array(await (await window.__realFetch('/fx/' + name)).arrayBuffer()),
        pixels: (src, w, h) => {
            const c = new OffscreenCanvas(w, h);
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(src, 0, 0, w, h);
            return g.getImageData(0, 0, w, h).data;
        },
        same: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    };
}, MARKS);
const f = {};

// 3. GIF: every frame through WebCodecs' own decoder.
f.gif = await page.evaluate(async () => {
    const { send, marks, fixture, pixels, same } = window.__h;
    const orig = await fixture('animated.gif');
    const got = await send(orig.slice(), 'party.gif', 'image/gif');
    const frames = async (bytes) => {
        const dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
        await dec.tracks.ready;
        const t = dec.tracks.selectedTrack;
        const list = [];
        for (let i = 0; i < t.frameCount; i++) {
            const { image } = await dec.decode({ frameIndex: i });
            list.push({ w: image.displayWidth, h: image.displayHeight, d: image.duration, px: pixels(image, image.displayWidth, image.displayHeight) });
            image.close();
        }
        const o = { n: t.frameCount, loop: t.repetitionCount, list };
        dec.close();
        return o;
    };
    const a = await frames(orig), b = await frames(got);
    return {
        control: marks(orig), leaks: marks(got), frames: [a.n, b.n], loop: [String(a.loop), String(b.loop)],
        durations: [a.list.map((x) => x.d), b.list.map((x) => x.d)],
        samePixels: a.n === b.n && a.list.every((x, i) => x.w === b.list[i].w && x.h === b.list[i].h && same(x.px, b.list[i].px)),
        bytes: [orig.length, got.length],
    };
});

// 3b. A GIF with a byte that starts no block after a frame: what the engine shows of it, and what is sent.
f.gifJunk = await page.evaluate(async () => {
    const { send, fixture, pixels, same } = window.__h;
    const orig = await fixture('animated.gif');
    const body = orig.subarray(0, orig.length - 1); // without its trailer
    // The last frame's own block (descriptor, colour table, LZW data), to put after a stray byte.
    const subs = (b, j) => { while (b[j] !== 0) j += 1 + b[j]; return j + 1; };
    let i = 13 + (orig[10] & 0x80 ? 3 * (1 << ((orig[10] & 7) + 1)) : 0);
    let last = null;
    while (i < orig.length && orig[i] !== 0x3B) {
        if (orig[i] === 0x21) { i = subs(orig, i + 2); continue; }
        const start = i;
        i = subs(orig, i + 10 + (orig[i + 9] & 0x80 ? 3 * (1 << ((orig[i + 9] & 7) + 1)) : 0) + 1);
        last = orig.subarray(start, i);
    }
    const join = (...parts) => { const n = parts.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let at = 0; for (const x of parts) { o.set(x, at); at += x.length; } return o; };
    const frames = async (bytes) => {
        try {
            const dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
            await dec.tracks.ready;
            await dec.completed;
            const t = dec.tracks.selectedTrack;
            const list = [];
            for (let k = 0; k < t.frameCount; k++) {
                const { image } = await dec.decode({ frameIndex: k });
                list.push(pixels(image, image.displayWidth, image.displayHeight));
                image.close();
            }
            dec.close();
            return list;
        } catch (e) { return String(e); }
    };
    const want = await frames(orig);
    const cases = {
        padding: join(body, new Uint8Array(4)),
        strayThenFrame: join(body, Uint8Array.of(0), last, Uint8Array.of(0x3B)),
    };
    const out = {};
    for (const [name, bytes] of Object.entries(cases)) {
        const shown = await frames(bytes);
        let got = null, err = null;
        try { got = await send(bytes.slice(), 'party.gif', 'image/gif'); } catch (e) { err = String(e); }
        const sent = got ? await frames(got) : null;
        out[name] = {
            shown: Array.isArray(shown) ? shown.length : shown,
            shownSame: Array.isArray(shown) && shown.length === want.length && shown.every((px, k) => same(px, want[k])),
            sent: Array.isArray(sent) ? sent.length : (sent ?? err),
            sentSame: Array.isArray(sent) && sent.length === want.length && sent.every((px, k) => same(px, want[k])),
            trailer: got ? got[got.length - 1] === 0x3B : false,
        };
    }
    // NEGATIVE CONTROL: the same frame after the last one with NO stray byte before it is shown.
    const more = await frames(join(body, last, Uint8Array.of(0x3B)));
    return { want: want.length, cases: out, withoutStray: Array.isArray(more) ? more.length : more };
});

// 4. AVIF: the engine's decoder.
f.avif = await page.evaluate(async () => {
    const { send, marks, fixture, pixels, same } = window.__h;
    const orig = await fixture('photo.avif');
    const got = await send(orig.slice(), 'photo.avif', 'image/avif');
    const dec = async (bytes) => { const bm = await createImageBitmap(new Blob([bytes], { type: 'image/avif' })); const o = { w: bm.width, h: bm.height, px: pixels(bm, bm.width, bm.height) }; bm.close(); return o; };
    let a = null, b = null, err = null;
    try { a = await dec(orig); b = await dec(got); } catch (e) { err = String(e); }
    return { control: marks(orig), leaks: marks(got), err, dims: a && b ? [[a.w, a.h], [b.w, b.h]] : null, samePixels: !!(a && b && a.w === b.w && a.h === b.h && same(a.px, b.px)), bytes: [orig.length, got.length] };
});

// 5. Videos: a muted <video> that never plays, seeked to its first and last frames.
f.videos = {};
// The MP4 again as a dashcam and phone vendors leave theirs (VENDOR): a GPS block (`freeGPS `) at the
// end of its media data and its `gps ` index, an HTC track and ISO's meco in moov, then Samsung's sefd,
// a Pittasoft GPS log in free space and a dashcam's NMEA box at the top. Boxes this does not keep are
// freed whatever they are called: the real decoder must show the same frames from what is left.
const VENDOR = 'video.mp4 + dashcam and vendor boxes';
for (const [name, type, engineType, file] of [['video.mp4', 'video/mp4', 'video/mp4'], ['video.mov', 'video/quicktime', 'video/mp4'], ['video.webm', 'video/webm', 'video/webm'], ['video.mkv', 'video/x-matroska', 'video/x-matroska'], [VENDOR, 'video/mp4', 'video/mp4', 'video.mp4']]) {
    f.videos[name] = await page.evaluate(async ({ name, type, engineType, file, VENDOR }) => {
        const { send, marks, fixture, pixels, same } = window.__h;
        const frames = async (bytes) => {
            const url = URL.createObjectURL(new Blob([bytes], { type: engineType }));
            const v = document.createElement('video');
            v.muted = true; v.preload = 'auto'; v.playsInline = true;
            const ok = await new Promise((r) => { v.onloadeddata = () => r(true); v.onerror = () => r(false); setTimeout(() => r(false), 8000); v.src = url; });
            if (!ok) { URL.revokeObjectURL(url); return null; }
            const seek = (t) => new Promise((r) => { v.onseeked = r; v.currentTime = t; setTimeout(r, 4000); });
            await seek(0);
            const first = pixels(v, v.videoWidth, v.videoHeight);
            await seek(Math.max(0, v.duration - 0.05));
            const last = pixels(v, v.videoWidth, v.videoHeight);
            const o = { w: v.videoWidth, h: v.videoHeight, dur: v.duration, first, last, played: !v.paused };
            v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
            return o;
        };
        const withVendorBoxes = (v) => {
            const join = (...parts) => { const n = parts.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let at = 0; for (const x of parts) { o.set(x, at); at += x.length; } return o; };
            const be32 = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
            const enc = (str) => new TextEncoder().encode(str);
            const box = (t, ...parts) => { const body = join(...parts); return join(be32(8 + body.length), enc(t), body); };
            const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
            const top = [];
            for (let at = 0; at < v.length;) { const size = dv.getUint32(at); top.push({ type: new TextDecoder('latin1').decode(v.subarray(at + 4, at + 8)), at, b: v.subarray(at, at + size) }); at += size; }
            const mdat = top.find((x) => x.type === 'mdat'), moov = top.find((x) => x.type === 'moov');
            const gpsBody = new Uint8Array(248); gpsBody.set(enc('GPS '), 0); gpsBody.set(enc('SECRETCAM-Corp +47.6062-122.3321 31km/h'), 12);
            const block = join(be32(256), enc('free'), gpsBody);
            const blockAt = mdat.at + mdat.b.length;
            const newMdat = join(be32(mdat.b.length + 256), mdat.b.subarray(4), block);
            const newMoov = box('moov', moov.b.subarray(8), box('gps ', Uint8Array.of(0, 0, 1, 1), be32(1), be32(blockAt), be32(256)), box('htka', enc('SECRETCAM-Corp')), box('meco', enc('+47.6062-122.3321')));
            return join(...top.filter((x) => x.at < mdat.at).map((x) => x.b), newMdat, newMoov,
                box('sefd', enc('Image_UTC_Data1761228309000 SECRETCAM-Corp SEFH SEFT')), box('free', be32(40), enc('gps $GPRMC,140509,A,+47.6062-122.3321')), box('udat', enc('$GPRMC SECRETCAM-Corp')));
        };
        const orig = name === VENDOR ? withVendorBoxes(await fixture(file)) : await fixture(name);
        const got = await send(orig.slice(), file ?? name, type);
        const a = await frames(orig);
        const b = a ? await frames(got) : null;
        return {
            control: marks(orig), leaks: marks(got), bytes: [orig.length, got.length], opened: !!a,
            dims: a && b ? [[a.w, a.h, a.dur], [b.w, b.h, b.dur]] : null,
            samePixels: !!(a && b && a.w === b.w && a.h === b.h && a.dur === b.dur && same(a.first, b.first) && same(a.last, b.last)),
            played: !!(a?.played || b?.played),
        };
    }, { name, type, engineType, file, VENDOR });
}

// 5b. A WebM as this engine's own MediaRecorder writes one (what Púca Notes' recorder makes), the
// muxer's name in it. A canvas, no audio track at all.
f.recorded = await page.evaluate(async () => {
    const { send, pixels, same, latin1 } = window.__h;
    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
    const g = c.getContext('2d');
    let n = 0;
    const paint = () => { g.fillStyle = `rgb(${(n * 40) & 255},120,${255 - ((n * 40) & 255)})`; g.fillRect(0, 0, 64, 48); g.fillStyle = '#fff'; g.fillRect(n % 64, 10, 8, 8); n++; };
    paint();
    const stream = c.captureStream(15);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const parts = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const timer = setInterval(paint, 60);
    rec.start();
    await new Promise((r) => setTimeout(r, 700));
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    const orig = new Uint8Array(await new Blob(parts).arrayBuffer());
    // A size field of all ones is an element of unknown size (a live recording's segment or clusters).
    const text = latin1(orig);
    const unknown = { segment: text.includes('\x18\x53\x80\x67\x01\xFF\xFF\xFF\xFF\xFF\xFF\xFF'), cluster: text.includes('\x1F\x43\xB6\x75\x01\xFF\xFF\xFF\xFF\xFF\xFF\xFF') };
    const got = await send(orig.slice(), 'voice-note.webm', 'video/webm');
    const first = async (bytes) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
        const v = document.createElement('video');
        v.muted = true; v.preload = 'auto';
        const ok = await new Promise((r) => { v.onloadeddata = () => r(true); v.onerror = () => r(false); setTimeout(() => r(false), 8000); v.src = url; });
        const o = ok ? { w: v.videoWidth, h: v.videoHeight, px: pixels(v, v.videoWidth, v.videoHeight) } : null;
        v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
        return o;
    };
    const a = await first(orig), b = await first(got);
    return {
        unknown, control: text.includes('Chrome'), leaks: latin1(got).includes('Chrome'),
        bytes: [orig.length, got.length], samePixels: !!(a && b && a.w === b.w && same(a.px, b.px)), opened: !!a,
    };
});

// 6. TIFF: no engine here draws one; its strip, byte for byte.
f.tiff = await page.evaluate(async () => {
    const { send, marks, fixture, same } = window.__h;
    const orig = await fixture('photo.tif');
    const got = await send(orig.slice(), 'scan.tif', 'image/tiff');
    const strip = (b) => {
        const dv = new DataView(b.buffer, b.byteOffset);
        const at = dv.getUint32(4, true), n = dv.getUint16(at, true);
        let off = 0, len = 0;
        for (let e = 0; e < n; e++) { const q = at + 2 + e * 12, tag = dv.getUint16(q, true); if (tag === 273) off = dv.getUint32(q + 8, true); if (tag === 279) len = dv.getUint32(q + 8, true); }
        return b.subarray(off, off + len);
    };
    return { control: marks(orig), leaks: marks(got), bytes: [orig.length, got.length], sameStrip: strip(orig).length === 64 * 48 * 3 && same(strip(orig), strip(got)) };
});

// 7. SVG: drawn in an <img> (compared by screenshots: an SVG with a foreignObject taints a
// canvas), and opened as a document.
f.svg = await page.evaluate(async () => {
    const { send, marks } = window.__h;
    const c = new OffscreenCanvas(64, 48);
    const g = c.getContext('2d');
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) { g.fillStyle = `rgb(${x * 4},${y * 5},${(x * y) >> 2})`; g.fillRect(x, y, 1, 1); }
    const jpeg = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
    // The embedded photo with EXIF, as a phone writes it (behind JFIF).
    const { cat, jseg, enc: ascii, exifTiff, leaked } = window.__rig.fx;
    const at = jpeg[2] === 0xFF && jpeg[3] === 0xE0 ? 4 + ((jpeg[4] << 8) | jpeg[5]) : 2;
    const photo = cat(jpeg.subarray(0, at), jseg(0xE1, cat(ascii('Exif\0\0'), exifTiff(null, { gps: true }))), jpeg.subarray(at));
    const orig = new TextEncoder().encode(window.__rig.inkscapeSvg(photo));
    const got = await send(orig.slice(), 'logo.svg', 'image/svg+xml');
    const show = (bytes, id) => new Promise((res) => {
        const im = new Image();
        im.id = id; im.width = 64; im.height = 48; im.style.cssText = 'display:block;width:64px;height:48px';
        im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => res(null);
        im.src = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
        document.body.append(im);
    });
    const a = await show(orig, 'svg-original'), b = await show(got, 'svg-cleaned');
    const text = new TextDecoder().decode(got);
    // Every embedded picture (the photo is in it twice: as itself, and claiming to be a GIF).
    const photos = [...text.matchAll(/data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)/g)].map((m) => ({ type: m[1], bytes: Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0)) }));
    window.__svgDocs = { orig, got };
    return {
        control: marks(orig), leaks: marks(got).concat(['sodipodi', 'inkscape', 'jane', '<script', 'onload', 'onmouseover', 'tracker.example', 'javascript:', 'iframe', 'ping', 'image-set', '72l', '69mport'].filter((x) => text.includes(x))),
        dims: a && b ? [[a.w, a.h], [b.w, b.h]] : null,
        embeddedLeaks: photos.length === 2 ? photos.flatMap((p) => leaked(p.bytes)) : [`${photos.length} embedded photos`],
        embeddedTypes: photos.map((p) => p.type),
        embeddedControl: leaked(photo),
        labelKept: text.includes('there</html:b>') && text.includes('<foreignObject'),
    };
});
const shotA = await page.locator('#svg-original').screenshot({ animations: 'disabled' });
const shotB = await page.locator('#svg-cleaned').screenshot({ animations: 'disabled' });
f.svg.samePixels = shotA.length > 0 && shotA.equals(shotB);
// As a document: a same-origin iframe of the file, which is what opening a downloaded SVG in a
// browser is. Its script, if it runs, says so to this page; what it asks of outside hosts is counted.
for (const which of ['orig', 'got']) {
    const before = outside.length;
    f.svg[which] = await page.evaluate(async (which) => new Promise((res) => {
        let ran = 0;
        const onMsg = (e) => { if (e.data === 'svg-script-ran') ran++; };
        window.addEventListener('message', onMsg);
        const fr = document.createElement('iframe');
        fr.src = URL.createObjectURL(new Blob([window.__svgDocs[which]], { type: 'image/svg+xml' }));
        fr.onload = () => setTimeout(() => {
            let flag = null;
            try { flag = fr.contentWindow.__svgRan ?? 0; } catch { flag = 'unreadable'; }
            window.removeEventListener('message', onMsg);
            fr.remove();
            res({ ran, flag });
        }, 1500);
        document.body.append(fr);
    }), which);
    f.svg[which].outside = outside.length - before;
    f.svg[which].paths = outside.slice(before).map((u) => new URL(u).pathname);
}

// 7b. A diagram as Mermaid, draw.io and Excalidraw export one: drawn the same once cleaned. The
// NEGATIVE CONTROLS are the same diagram with its labels (the foreignObjects) or its font (the
// @font-face's url) taken out, what the cleaner did to it before: each must draw differently,
// so the comparison is one that can fail.
f.diagram = await page.evaluate(async () => {
    const { send, fixture } = window.__h;
    const font = await fixture('box-font.ttf');
    const src = window.__rig.diagramSvg(font);
    const orig = new TextEncoder().encode(src);
    const got = await send(orig.slice(), 'flowchart.svg', 'image/svg+xml');
    const noLabels = new TextEncoder().encode(src.replace(/<foreignObject[\s\S]*?<\/foreignObject>/g, ''));
    const noFont = new TextEncoder().encode(src.replace(/src: url\(data:font\/ttf;base64,[A-Za-z0-9+/=]+\);/, 'src: none;'));
    // What the cleaner did to draw.io's icons before its review: their hrefs taken out.
    const noIcons = new TextEncoder().encode(src.replace(/ (?:xlink:)?href="data:image\/svg\+xml[^"]*"/g, ''));
    const show = (bytes, id) => new Promise((res) => {
        const im = new Image();
        im.id = id; im.width = 160; im.height = 80; im.style.cssText = 'display:block;width:160px;height:80px';
        im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => res(null);
        im.src = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
        document.body.append(im);
    });
    const dims = [];
    for (const [bytes, id] of [[orig, 'dg-original'], [got, 'dg-cleaned'], [noLabels, 'dg-no-labels'], [noFont, 'dg-no-font'], [noIcons, 'dg-no-icons']]) dims.push(await show(bytes, id));
    // Let the embedded font load and the pictures settle before they are compared.
    await document.fonts.ready;
    await new Promise((r) => setTimeout(r, 500));
    const text = new TextDecoder().decode(got);
    const icons = [...text.matchAll(/href="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/g)].map((m) => atob(m[1]));
    return {
        dims, keptLabels: text.includes('Start <b>here</b>') && text.includes('>Decide</div>'), keptFont: text.includes('src: url(data:font/ttf;base64,'),
        icons: icons.length, iconLeaks: icons.filter((x) => /SECRETCOMMENT|inkscape|\/home\/jane/.test(x)).length,
        iconControl: (src.match(/data:image\/svg\+xml/g) || []).length,
    };
});
{
    // Each one drawn in the SAME place on the page: a gradient in an SVG drawn inside an SVG <image>
    // (draw.io's icons) is dithered by where it is on the page, so the same drawing 80 px lower
    // differs by one level in a few dozen pixels (measured: the original against itself, 2026-11-22).
    const shot = async (id) => {
        await page.evaluate((id) => {
            for (const im of document.querySelectorAll('img[id^="dg-"]')) im.style.cssText = 'display:none';
            document.getElementById(id).style.cssText = 'display:block;width:160px;height:80px;position:fixed;left:0;top:0;z-index:2147483647';
        }, id);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)))));
        return page.locator('#' + id).screenshot({ animations: 'disabled' });
    };
    const [o, c, nl, nf, ni] = [await shot('dg-original'), await shot('dg-cleaned'), await shot('dg-no-labels'), await shot('dg-no-font'), await shot('dg-no-icons')];
    f.diagram.same = o.length > 0 && o.equals(c);
    f.diagram.labelsShow = !o.equals(nl);
    f.diagram.fontShows = !o.equals(nf);
    f.diagram.iconsShow = !o.equals(ni);
}

// 8. A 256 MB video sent peer to peer: a File made of slices of the same 1 MB (no 256 MB in memory),
// its moov at the end, fixed without being read whole.
f.big = await page.evaluate(async () => {
    const { marks, fixture, latin1 } = window.__h;
    const v = await fixture('video.mp4');
    const dv = new DataView(v.buffer);
    let at = 0; const boxes = {};
    while (at < v.length) { const size = dv.getUint32(at); boxes[latin1(v.subarray(at + 4, at + 8))] = v.subarray(at, at + size); at += size; }
    const chunk = new Blob([new Uint8Array(1024 * 1024)]);
    const media = 256 * 1024 * 1024;
    const head = new Uint8Array(8); new DataView(head.buffer).setUint32(0, media + 8); head.set(new TextEncoder().encode('mdat'), 4);
    const file = new File([boxes.ftyp, head, ...new Array(256).fill(chunk), boxes.moov], 'VID_big.mp4', { type: 'video/mp4' });
    const t0 = performance.now();
    const clean = await window.__rig.stripFileMetadata(file);
    const ms = performance.now() - t0;
    const tail = new Uint8Array(await clean.slice(clean.size - boxes.moov.length).arrayBuffer());
    return { ms: Math.round(ms), size: [file.size, clean.size], changed: clean !== file, tailLeaks: marks(tail), tailControl: marks(boxes.moov) };
});

// 8b. A 256 MB TIFF and a 128 MB GIF sent peer to peer, Files made of slices of the same 1 MB: fixed
// without the page reading them whole (the TIFF reads its directories; the GIF is walked a window at a
// time), the result what the seal makes of the small file they start with.
f.bigStill = await page.evaluate(async () => {
    const { marks, fixture } = window.__h;
    const MB = 1024 * 1024;
    const tif = await fixture('photo.tif');
    const gif = await fixture('animated.gif');
    const sealTif = await window.__rig.stripFileMetadata(new File([tif], 's.tif', { type: 'image/tiff' }));
    const sealGif = await window.__rig.stripFileMetadata(new File([gif], 's.gif', { type: 'image/gif' }));
    // TIFF: 256 MB of picture after the directories (nothing points at it: no reader cares).
    const zeros = new Blob([new Uint8Array(MB)]);
    const bigTif = new File([tif, ...new Array(256).fill(zeros)], 'scan.tif', { type: 'image/tiff' });
    // GIF: a 128 MB comment in front of the trailer, 256-byte sub-blocks (a 1 MB chunk holds 4096 whole ones).
    const sub = new Uint8Array(MB);
    for (let k = 0; k < MB; k += 256) { sub[k] = 255; sub.fill(0x41, k + 1, k + 256); }
    const subs = new Blob([sub]);
    const bigGif = new File([gif.subarray(0, gif.length - 1), Uint8Array.of(0x21, 0xFE), ...new Array(128).fill(subs), Uint8Array.of(0, 0x3B)], 'party.gif', { type: 'image/gif' });
    const out = {};
    for (const [name, file, small, seal] of [['tiff', bigTif, tif, sealTif], ['gif', bigGif, gif, sealGif]]) {
        // Read whole, it fails: only slices of it may be read.
        Object.defineProperty(file, 'arrayBuffer', { value: () => { throw new Error('the whole file was read'); } });
        const t0 = performance.now();
        let clean = null, err = null;
        try { clean = await window.__rig.stripFileMetadata(file); } catch (e) { err = String(e); }
        const ms = Math.round(performance.now() - t0);
        const sealBytes = new Uint8Array(await seal.arrayBuffer());
        const head = clean ? new Uint8Array(await clean.slice(0, sealBytes.length).arrayBuffer()) : new Uint8Array(0);
        out[name] = {
            ms, err, size: [file.size, clean?.size], changed: clean !== file, control: marks(small),
            leaks: clean ? marks(head) : null,
            asSealed: head.length === sealBytes.length && head.every((v, k) => v === sealBytes[k]),
        };
    }
    return out;
});

ck(f.gif.control.length >= 2, 'GIF: the GIF going in carries a comment and XMP (control)', f.gif.control.join(', '));
ck(f.gif.leaks.length === 0, "GIF: the recipient's copy carries none of it", JSON.stringify(f.gif.leaks));
ck(f.gif.frames[0] >= 2 && f.gif.frames[0] === f.gif.frames[1] && f.gif.samePixels, 'GIF: every frame decodes to the same pixels (WebCodecs)', JSON.stringify({ frames: f.gif.frames }));
ck(f.gif.loop[0] === f.gif.loop[1] && f.gif.loop[0] === 'Infinity' && JSON.stringify(f.gif.durations[0]) === JSON.stringify(f.gif.durations[1]), 'GIF: still animated, the same delays, still looping forever', JSON.stringify({ loop: f.gif.loop, d: f.gif.durations }));
ck(f.gif.bytes[1] < f.gif.bytes[0], `GIF: smaller by the blocks taken out (${f.gif.bytes.join(' -> ')})`);
for (const [name, label] of [['padding', 'zero padding after its last frame and no trailer'], ['strayThenFrame', 'a stray 0x00 after its last frame, then one frame more']]) {
    const o = f.gifJunk.cases[name];
    ck(o.shown === f.gifJunk.want && o.shownSame, `GIF with ${label}: the engine shows the frames before that byte`, JSON.stringify(o));
    ck(o.sent === f.gifJunk.want && o.sentSame && o.trailer, `GIF with ${label}: sent, not refused, as exactly those frames with a trailer`, JSON.stringify(o));
}
ck(f.gifJunk.withoutStray === f.gifJunk.want + 1, 'NEGATIVE CONTROL: the same frame more with no stray byte before it IS shown (so the one after a stray byte is not)', JSON.stringify({ want: f.gifJunk.want, withoutStray: f.gifJunk.withoutStray }));
ck(f.avif.control.length >= 3, 'AVIF: the photo going in carries the camera, the time and XMP (control)', f.avif.control.join(', '));
ck(f.avif.leaks.length === 0, "AVIF: the recipient's copy carries none of it", JSON.stringify(f.avif.leaks));
ck(f.avif.samePixels && f.avif.bytes[0] === f.avif.bytes[1], 'AVIF: the same picture, pixel for pixel, the same size in bytes (overwritten in place)', JSON.stringify({ dims: f.avif.dims, err: f.avif.err }));
for (const [name, o] of Object.entries(f.videos)) {
    ck(o.control.length >= 3, `${name}: the video going in carries its place, title, camera or software (control)`, o.control.join(', '));
    ck(o.leaks.length === 0, `${name}: the recipient's copy carries none of it`, JSON.stringify(o.leaks));
    ck(o.bytes[0] === o.bytes[1], `${name}: overwritten in place: the same size in bytes`, o.bytes.join(' -> '));
    if (!o.opened) console.log('SKIP', `${name}: this engine does not open the ORIGINAL in a <video>; frames not compared (tests/fileMetadata.test.ts compares the bytes)`);
    else ck(o.samePixels, `${name}: the same size, duration, first and last frames, pixel for pixel`, JSON.stringify(o.dims));
    ck(!o.played, `${name}: never played (muted, seeked only)`);
}
ck(f.recorded.control, 'a MediaRecorder WebM: it names its muxer and writer (control)', JSON.stringify(f.recorded));
console.log('INFO', `this engine's MediaRecorder wrote a segment of ${f.recorded.unknown.segment ? 'unknown' : 'known'} size and clusters of ${f.recorded.unknown.cluster ? 'unknown' : 'known'} size (tests/fileMetadata.test.ts walks a live recording's unknown sizes)`);
ck(!f.recorded.leaks && f.recorded.bytes[0] === f.recorded.bytes[1], "a MediaRecorder WebM: the muxer's and writer's names gone, nothing moved");
ck(f.recorded.opened && f.recorded.samePixels, 'a MediaRecorder WebM: its first frame the same, pixel for pixel');
ck(f.tiff.control.length >= 3 && f.tiff.leaks.length === 0, 'TIFF: the camera, software, author and XMP going in (control) are gone', JSON.stringify(f.tiff));
ck(f.tiff.sameStrip && f.tiff.bytes[0] === f.tiff.bytes[1], 'TIFF: its picture strip is the same bytes, the file the same size');
ck(f.svg.control.length >= 2 && f.svg.embeddedControl.length >= 2, "SVG: the drawing going in carries an editor's notes and a photo with its EXIF (control)", JSON.stringify([f.svg.control, f.svg.embeddedControl]));
ck(f.svg.leaks.length === 0 && f.svg.embeddedLeaks.length === 0, "SVG: the recipient's copy carries none of it, nor do its embedded photos", JSON.stringify([f.svg.leaks, f.svg.embeddedLeaks]));
ck(f.svg.embeddedTypes.join() === 'image/jpeg,image/jpeg', 'SVG: the photo that claimed to be a GIF is kept, cleaned, as the JPEG it is', JSON.stringify(f.svg.embeddedTypes));
ck(f.svg.labelKept, "SVG: the label in its foreignObject is kept");
ck(f.svg.samePixels, 'SVG: drawn in an <img>, the same picture, pixel for pixel', JSON.stringify(f.svg.dims));
ck(f.svg.orig.ran > 0 || (typeof f.svg.orig.flag === 'number' && f.svg.orig.flag > 0), "NEGATIVE CONTROL: opened as a document, the original's script runs", JSON.stringify(f.svg.orig));
ck(f.svg.orig.outside > 0, 'NEGATIVE CONTROL: opened as a document, the original asks outside hosts for things (refused here)', String(f.svg.orig.outside));
console.log('INFO', 'the original asked for:', JSON.stringify([...new Set(f.svg.orig.paths)].sort()));
// Each way of asking planted to get past a plain search, and HTML in a foreignObject: the
// original asks by each (so the cleaned one asking by none of them is a finding, not luck).
for (const [how, paths] of [
    ['an escaped u\\72l( in style=', ['/esc-bg.png']],
    ['@\\69mport "…"', ['/esc-import.css']],
    ['image-set("…") and -webkit-image-set("…")', ['/is.png', '/wis.png']],
    ['an href animation under another prefix (q:href)', ['/anim.png']],
    ["HTML in a foreignObject: a picture and its srcset, an iframe, a video's poster, a form's image button, its own style sheet and a link to one",['/fo-img.png', '/fo-srcset.png', '/fo-frame.html', '/fo-poster.png', '/fo-input.png', '/fo-style.css', '/fo-link.css']],
]) ck(paths.every((p) => f.svg.orig.paths.includes(p)), `NEGATIVE CONTROL: opened as a document, the original asks by ${how}`, JSON.stringify(paths));
ck(f.svg.got.ran === 0 && f.svg.got.flag === 0, 'SVG: opened as a document, the cleaned one runs nothing', JSON.stringify(f.svg.got));
ck(f.svg.got.outside === 0, 'SVG: opened as a document, the cleaned one asks nothing of anyone', JSON.stringify(f.svg.got.paths));
ck(f.diagram.keptLabels && f.diagram.keptFont, "SVG diagram: the recipient's copy keeps Mermaid's and draw.io's labels and the embedded font", JSON.stringify(f.diagram));
ck(f.diagram.same, 'SVG diagram (Mermaid, draw.io and Excalidraw shapes): drawn in an <img>, the same picture, pixel for pixel', JSON.stringify(f.diagram.dims));
ck(f.diagram.labelsShow && f.diagram.fontShows, 'NEGATIVE CONTROL: the same diagram with its labels, or its font, taken out (the cleaner before 2026-11-22) is drawn differently', JSON.stringify({ labels: f.diagram.labelsShow, font: f.diagram.fontShows }));
ck(f.diagram.iconControl === 2 && f.diagram.icons === 2 && f.diagram.iconLeaks === 0, "SVG diagram: draw.io's two icons (SVGs in data: URLs) are kept, each cleaned of what its editor left in it", JSON.stringify({ control: f.diagram.iconControl, icons: f.diagram.icons, leaks: f.diagram.iconLeaks }));
ck(f.diagram.iconsShow, 'NEGATIVE CONTROL: the same diagram with its icons taken out (the cleaner before its review) is drawn differently', String(f.diagram.iconsShow));
ck(f.big.changed && f.big.size[0] === f.big.size[1] && f.big.tailControl.length > 0 && f.big.tailLeaks.length === 0, 'a 256 MB video sent peer to peer: its metadata (at the end) gone, nothing moved', JSON.stringify(f.big));
ck(f.big.ms < 5000, `a 256 MB video sent peer to peer: fixed in ${f.big.ms} ms, no more of its media read than the first 20 MB (a dashcam's GPS blocks)`);
for (const [name, o] of Object.entries(f.bigStill)) {
    ck(o.control.length >= 2 && o.changed && (name === 'tiff' ? o.size[0] === o.size[1] : o.size[1] < o.size[0]), `a large ${name.toUpperCase()} sent peer to peer: its metadata found going in (control), and a new File comes out`, JSON.stringify(o));
    ck(!o.err && o.leaks && o.leaks.length === 0 && o.asSealed, `a large ${name.toUpperCase()} sent peer to peer: its metadata gone, the result what the seal makes of it`, JSON.stringify(o));
    ck(o.ms < 10000, `a large ${name.toUpperCase()} sent peer to peer: fixed in ${o.ms} ms, never read whole`);
}
ck(outside.every((u) => /tracker\.example|evil\.example/.test(u)), 'nothing but the SVG controls asked for anything outside this machine, and all of it was refused here', JSON.stringify([...new Set(outside.map((u) => new URL(u).host))]));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
