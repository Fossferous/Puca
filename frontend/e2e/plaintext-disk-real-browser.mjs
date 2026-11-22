// Decrypted attachments must not outlive their use on disk: checked in a real
// browser, on the real disk.
//
// WHY THIS EXISTS. Chromium keeps a page's blobs in memory only up to a limit
// and writes the rest to <profile>/Default/blob_storage AS THEY ARE: 1% of
// the RAM in the Android WebView (79 of 85 MB of a small channel's decrypted
// pictures and videos, measured 2026-10-05 on a 2 GB emulator), 2 GB on
// desktop, where memory pressure writes every blob out at once. A blob the
// page holds goes when the page's garbage collector frees it, not when its
// URL is revoked. So the app keeps decrypted attachments only as URLs that a
// worker registered (src/api/plaintextHost.ts) and lets the worker go when
// they are no longer shown, and keeps the ciphertext it caches in the
// origin-private file system, never as a Blob (src/api/cipherStore.ts):
// Chromium writes several blobs into one page file and keeps the file while
// any of them lives. For the same reason nothing the app keeps for the whole
// session may be a Blob: avatars, server icons and custom emoji are data:
// URLs (src/api/authedMedia.ts), because a session-long avatar blob paged
// into the same file as a picture kept the picture's plaintext there after
// it was let go (found in review, 2026-10-05). jsdom has no blob storage, no
// disk and no OPFS, so the vitest suites can only check the bookkeeping. This
// bundles the REAL modules (esbuild) and, in headless Edge with throwaway
// profiles:
//
//   1. a hosted picture decodes and a hosted video's metadata loads (muted,
//      never played): the URLs work like the page's own;
//   2. simulated memory pressure writes hosted plaintext to blob_storage
//      (POSITIVE CONTROL: the scan sees plaintext where Chromium puts it);
//   3. released, it is gone from the disk within 3.5 s, with no GC forced
//      from outside (the module nudges the page's own collector);
//   4. NEGATIVE CONTROL: a blob the page itself still holds, its URL revoked,
//      is still on disk: revoking alone would not have done it;
//   5. cached ciphertext is in the OPFS directory, not in blob_storage even
//      under pressure, reads back byte for byte, and goes when dropped;
//   6. a stale cache directory no page holds a lock on is swept;
//   7. sign-out (dropAllPlaintext / dropAllCiphertext) takes plaintext that
//      IS on disk (POSITIVE CONTROL) off it, and leaves no ciphertext;
//   8. avatars fetched through authedMedia (an <img> decodes one) are never
//      in blob_storage, and small pictures hosted beside them are gone once
//      released; NEGATIVE CONTROL, in a browser of its own: page blobs kept
//      alive beside the same pictures (what authedMedia used to make) keep
//      a released picture's plaintext on disk, so this check can fail.
//   9. plaintext the app makes OTHER than a fetched attachment, through the
//      real modules (a second bundle, the app's own config): a Púca Notes
//      picture not uploaded yet (api/parkedPreview.ts, its sealed record
//      opened as the app does), a picture pasted into the message box
//      (api/composerPreviews.ts, the File kept as Chat.tsx keeps it), and a
//      clip's Download (api/clipDownload.ts saveClip, real sealed parts) in
//      the desktop app (a stand-in shell whose attachment_save is still
//      writing when the pressure comes) and in a browser (a real download).
//      Shown, under pressure, the first three are on disk (POSITIVE
//      CONTROL); the desktop clip never is (it is no Blob at all); let go
//      of (the preview unmounted, the message sent, the save done, the
//      download's handoff over) all of it is gone within 3.5 s, the
//      downloaded file and the bytes the shell was handed are the whole
//      clip, and no host worker is left;
//  10. NEGATIVE CONTROL, in a browser of its own: the same four the way the
//      app did them before (src/tests/fixtures/parkedPreviewAt869.ts; the
//      thumbnail as URL.createObjectURL(file); the clip as a page Blob whose
//      URL is revoked 30 s later) are on disk under pressure, the desktop
//      clip too, and still there after the same moment.
//  11. SMALL files (under BIG_LEASE_BYTES, so in a host worker SHARED with
//      others) let go of while three pictures in that same worker are still
//      shown: two parked Notes pictures whose cards close, then two pasted
//      pictures whose chips go, each group paged into a file of its own
//      (checked: the premise). Each is gone from the disk within 3.5 s while
//      the three shown stay (the worker is made to collect its garbage with
//      the page, api/plaintextHost.ts); NEGATIVE CONTROL, in a browser of its
//      own: with that worker's `collect` a no-op, as it was, all four are
//      still on disk at the same moments, and go only with the worker.
//
// Each numbered group that needs memory pressure runs in a browser of its
// own, all at once: Chromium pages blobs out on a simulated pressure event
// only once they have settled (~2 s), only some seconds after start, and at
// most once per ~30 s (measured: a second event 22 s after the first did
// nothing, 34 s after it did).
//
// SILENT and headless: --mute-audio; the video is muted, preload=metadata,
// never played. No server and no build.
//
//   cd frontend && node e2e/plaintext-disk-real-browser.mjs
//
// CHANNEL=msedge by default (an H.264 decoder for the fixture). ONLY=<name>[,<name>]
// runs just those groups (the names given to `only(...)` below: release, sign-out,
// avatars, avatars-as-blobs, previews-and-clip, previews-and-clip-as-they-were,
// small-beside-shown, small-beside-shown-as-it-was).
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
// authedMedia, bundled with its network seams stood in: the token, the API
// base (this rig's own origin) and the type normalisation (covered by
// src/tests/authedMediaType.test.ts) — not the app's whole auth stack.
const seams = {
    name: 'seams',
    setup(b) {
        const fromApi = (a) => a.importer.split('\\').join('/').includes('/src/api/');
        b.onResolve({ filter: /^\.\/(config|auth)$/ }, (a) => (fromApi(a) ? { path: a.path, namespace: 'seam' } : null));
        b.onResolve({ filter: /^\.\/attachments$/ }, (a) => (a.importer.split('\\').join('/').endsWith('/src/api/authedMedia.ts') ? { path: a.path, namespace: 'seam' } : null));
        b.onLoad({ filter: /.*/, namespace: 'seam' }, (a) => ({
            loader: 'ts',
            contents: {
                './config': "export const API_BASE_URL = '';",
                './auth': "export const getToken = () => 'rig-token';",
                './attachments': 'export const safeBlobType = (m: string) => m;',
            }[a.path],
        }));
    },
};
const bundle = async (opts) => (await build({ bundle: true, write: false, platform: 'browser', logLevel: 'error', ...opts })).outputFiles[0].text;
const mainJs = await bundle({
    stdin: {
        contents: `import * as host from './api/plaintextHost'; import * as store from './api/cipherStore'; import * as media from './api/authedMedia'; window.__xb = { ...host, ...store, ...media };`,
        resolveDir: src, loader: 'ts', sourcefile: 'entry.ts',
    },
    plugins: [seams],
    // authedMedia asks api/platform whether it runs in the desktop shell (where its
    // [media-diag] lines also go to puca.log), and platform reads this build flag.
    define: { __RC_ENABLED__: 'true' },
    format: 'iife',
});
const plaintextWorkerJs = await bundle({ entryPoints: [path.join(src, 'api', 'plaintextHost.worker.ts')], format: 'esm' });
/** 11's NEGATIVE CONTROL: the same worker with `collect` doing nothing, as it was before it had one. */
const plaintextNoCollectWorkerJs = await bundle({
    entryPoints: [path.join(src, 'api', 'plaintextHost.worker.ts')], format: 'esm',
    plugins: [{
        name: 'no-collect',
        setup(b) {
            b.onResolve({ filter: /^\.\/collectGarbage$/ }, (a) => ({ path: a.path, namespace: 'no-collect' }));
            b.onLoad({ filter: /.*/, namespace: 'no-collect' }, () => ({ loader: 'ts', contents: 'export const nudgeCollection = () => {};' }));
        },
    }],
});
/** 9 and 10: the real modules with the app's own config (the API at this rig's origin), built once it listens. */
let extraJs = '';
const writerWorkerJs = await bundle({ entryPoints: [path.join(src, 'api', 'cipherWriter.worker.ts')], format: 'esm' });
const fixture = fs.readFileSync(path.join(src, 'tests', 'fixtures', 'video-dims', '320x180-rot90.mp4'));

/** A real 64x48 PNG, so an <img> has something to decode. */
function png(w, h) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
    const rows = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([200, 40, 40], y * (w * 3 + 1) + 1 + x * 3);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const realAvatar = png(64, 48);
/** `kb` KB of `text` over and over: something the disk scan can find. */
const marked = (text, kb) => {
    const b = Buffer.alloc(kb * 1024);
    for (let i = 0; i + text.length <= b.length; i += 2048) b.write(text, i, 'latin1');
    return b;
};
const AVATARS = 30;

const server = http.createServer((req, res) => {
    const send = (type, body, extra = {}) => { res.writeHead(200, { 'content-type': type, ...extra }); res.end(body); };
    if (req.url === '/main.js') return send('text/javascript', mainJs);
    if (req.url === '/extra.js') return send('text/javascript', extraJs);
    if (req.url === '/w/plaintext.js') return send('text/javascript', plaintextWorkerJs);
    if (req.url === '/w/plaintext-no-collect.js') return send('text/javascript', plaintextNoCollectWorkerJs);
    if (req.url === '/w/writer.js') return send('text/javascript', writerWorkerJs);
    if (req.url === '/fixture.mp4') return send('video/mp4', fixture);
    // /files/<id>, as the app's server answers it: authenticated, never cached.
    const file = /^\/files\/(.+)$/.exec(req.url ?? '');
    if (file) {
        if (req.headers.authorization !== 'Bearer rig-token') { res.writeHead(401); res.end(); return; }
        const id = file[1];
        const body = id === 'av-real' ? realAvatar : /^av-\d+$/.test(id) ? marked(`PUCA-XB-AVATAR-${id}-`, 100) : null;
        if (!body) { res.writeHead(404); res.end(); return; }
        return send('image/png', body, { 'cache-control': 'private, no-store' });
    }
    return send('text/html', '<!doctype html><meta charset=utf-8><title>plaintext-disk</title><body>rig</body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
extraJs = await bundle({
    stdin: {
        contents: `
            import * as parked from './api/parkedPreview';
            import * as oldParked from './tests/fixtures/parkedPreviewAt869';
            import { parkedHref } from './api/parkedMedia';
            import { createComposerPreviews } from './api/composerPreviews';
            import { saveClip, clipFileName, DOWNLOAD_HANDOFF_MS } from './api/clipDownload';
            import { downloadClipBytes } from './api/clips/clipPlayback';
            import { saveAttachment } from './api/saveAttachment';
            import { sealPart, newClipSecrets } from './api/clips/clipCrypto';
            import { __setPlaintextWorkerFactory, plaintextHostStats, hostPlaintext } from './api/plaintextHost';
            window.__xc = { parked, oldParked, parkedHref, createComposerPreviews, saveClip, clipFileName, DOWNLOAD_HANDOFF_MS, downloadClipBytes, saveAttachment, sealPart, newClipSecrets, __setPlaintextWorkerFactory, plaintextHostStats, hostPlaintext };`,
        resolveDir: src, loader: 'ts', sourcefile: 'extra.ts',
    },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_API_URL: origin }), __APP_VERSION__: '"0"', __RC_ENABLED__: 'true' },
    logOverride: { 'empty-import-meta': 'silent' },
    format: 'iife',
});

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which of `marks` any file under `dir` holds. */
function onDisk(dir, marks) {
    const found = new Set();
    const walk = (d) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            let buf;
            try { buf = fs.readFileSync(p); } catch { continue; }
            for (const m of marks) if (buf.indexOf(Buffer.from(m)) >= 0) found.add(m);
        }
    };
    walk(dir);
    return [...found];
}

/** Which of `marks` each file under `dir` holds, file by file (sorted): what Chromium paged together. */
function filesOnDisk(dir, marks) {
    const files = [];
    const walk = (d) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            let buf;
            try { buf = fs.readFileSync(p); } catch { continue; }
            const has = marks.filter((m) => buf.indexOf(Buffer.from(m)) >= 0);
            if (has.length) files.push(has);
        }
    };
    walk(dir);
    return files.sort((x, y) => String(x).localeCompare(String(y)));
}

const CHANNEL = process.env.CHANNEL || 'msedge';
/**
 * A browser of its own (throwaway profile) with the modules loaded, for one
 * group of checks. `pressure()` waits until Chromium will honour the event
 * (some seconds after start, the blobs settled), simulates it, and waits for
 * the files to be written.
 */
async function scenario(name, run) {
    const t0 = Date.now();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'puca-plaintext-disk-'));
    const ctx = await chromium.launchPersistentContext(profile, {
        headless: true,
        ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
        args: ['--mute-audio'],
        acceptDownloads: true,
    });
    try {
        const page = ctx.pages()[0] || await ctx.newPage();
        page.on('pageerror', (e) => console.log(`[${name} pageerror]`, String(e).slice(0, 200)));
        await page.goto(origin + '/');
        const ready = () => page.evaluate(async () => {
            await new Promise((r) => {
                const s = document.createElement('script'); s.src = '/main.js'; s.onload = r; document.head.append(s);
            });
            window.__xb.__setPlaintextWorkerFactory(() => new Worker('/w/plaintext.js', { type: 'module' }));
            window.__xb.__setCipherWriterFactory(() => new Worker('/w/writer.js', { type: 'module' }));
            window.__mark = (text, mb) => {
                const u = new Uint8Array(Math.round(mb * 1048576));
                const m = new TextEncoder().encode(text);
                for (let i = 0; i + m.length <= u.length; i += 2048) u.set(m, i);
                return u;
            };
        });
        const pressure = async () => {
            await sleep(2000); // what was just made settles in the browser process first
            while (Date.now() - t0 < 17000) await sleep(250);
            const cdp = await ctx.newCDPSession(page);
            await cdp.send('Memory.simulatePressureNotification', { level: 'moderate' });
            await sleep(3000);
        };
        /** Until `ms` after this browser started. */
        const at = async (ms) => { while (Date.now() - t0 < ms) await sleep(100); };
        await run({
            page, ready, pressure, at, since: () => Date.now() - t0,
            BS: path.join(profile, 'Default', 'blob_storage'),
            FSDIR: path.join(profile, 'Default', 'File System'),
        });
    } finally {
        await ctx.close().catch(() => {});
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

/** Avatars through the real authedMedia (or, for the control, page blobs
 *  kept alive the way it used to keep them), then six small pictures hosted
 *  beside them; memory pressure; the pictures released. Which pictures are
 *  still on disk 3.5 s later, and what else was. */
async function picturesBesideAvatars({ page, pressure, BS }, how) {
    const out = await page.evaluate(async ({ how, n }) => {
        const urls = [];
        if (how === 'authedMedia') {
            for (let i = 0; i < n; i++) urls.push(await window.__xb.fetchFileUrl(`av-${i}`));
        } else {
            for (let i = 0; i < n; i++) urls.push(URL.createObjectURL(new Blob([window.__mark(`PUCA-XB-AVATAR-av-${i}-`, 100 / 1024)], { type: 'image/png' })));
        }
        window.__avatarUrls = urls;
        window.__pics = [];
        for (let i = 0; i < 6; i++) window.__pics.push(await window.__xb.hostPlaintext(window.__mark(`PUCA-XB-PIC-${i}-`, i < 4 ? 0.6 : 3).buffer, 'image/jpeg'));
        return { schemes: [...new Set(urls.map((u) => String(u).split(':')[0]))], missing: urls.filter((u) => !u).length };
    }, { how, n: AVATARS });
    await pressure();
    const PICS = [0, 1, 2, 3, 4, 5].map((i) => `PUCA-XB-PIC-${i}-`);
    const AV = [`PUCA-XB-AVATAR-av-0-`, `PUCA-XB-AVATAR-av-${AVATARS - 1}-`];
    const paged = onDisk(BS, [...PICS, ...AV]);
    await page.evaluate(() => { for (const l of window.__pics) l.release(); });
    await sleep(3500);
    return { ...out, paged, left: onDisk(BS, PICS), PICS, AV };
}


/**
 * 9 / 10: a parked Notes picture shown, a pasted picture on a message-box
 * chip, and a clip saved in the desktop app and in a browser; memory
 * pressure; then all of it let go of at one moment (they are paged into
 * shared files, so letting go of them apart would leave each waiting on the
 * others). `asTheyWere` does each the way the app did before 2026-11-22.
 */
async function previewsAndClip({ page, ready, pressure, at, since, BS }, asTheyWere) {
    await ready();
    await page.evaluate(async () => {
        await new Promise((r) => { const s = document.createElement('script'); s.src = '/extra.js'; s.onload = r; document.head.append(s); });
        window.__xc.__setPlaintextWorkerFactory(() => new Worker('/w/plaintext.js', { type: 'module' }));
    });
    const tag = asTheyWere ? 'OLD' : 'NEW';
    const M = { parked: `PUCA-XB-${tag}-PARKED-`, paste: `PUCA-XB-${tag}-PASTE-`, webClip: `PUCA-XB-${tag}-WEBCLIP-`, deskClip: `PUCA-XB-${tag}-DESKCLIP-` };
    const shown = await page.evaluate(async ({ M, asTheyWere }) => {
        const xc = window.__xc;
        // A parked record exactly as notesBlobs.ts keeps one: nonce || AES-GCM, base64; the key base64url.
        const keyBytes = crypto.getRandomValues(new Uint8Array(32));
        const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, window.__mark(M.parked, 8)));
        const sealed = new Uint8Array(12 + ct.length); sealed.set(nonce); sealed.set(ct, 12);
        let b = ''; for (let i = 0; i < sealed.length; i += 0x8000) b += String.fromCharCode(...sealed.subarray(i, i + 0x8000));
        const rec = { data: btoa(b), key: btoa(String.fromCharCode(...keyBytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), mime: 'image/jpeg' };
        const href = xc.parkedHref('pk-1', 'image/jpeg');
        const mod = asTheyWere ? xc.oldParked : xc.parked;
        mod.setParkedReader(async () => rec);
        let parkedUrl;
        if (asTheyWere) parkedUrl = await mod.parkedObjectUrl(href);
        else { window.__parkedHold = await mod.acquireParkedUrl(href); parkedUrl = window.__parkedHold?.url; }

        // The message box: a pasted picture's File, kept for the upload and a Retry (Chat.tsx
        // pendingFilesRef), and its chip's thumbnail. A real PNG beside it shows the thumbnail works.
        window.__files = new Map();
        const pasted = new File([window.__mark(M.paste, 8)], 'image.png', { type: 'image/png' });
        const cv = document.createElement('canvas'); cv.width = 32; cv.height = 24;
        const g = cv.getContext('2d'); g.fillStyle = '#3a6'; g.fillRect(0, 0, 32, 24);
        const png = new File([await new Promise((r) => cv.toBlob(r, 'image/png'))], 'real.png', { type: 'image/png' });
        window.__files.set('att_1', pasted);
        window.__files.set('att_2', png);
        const thumbs = new Map();
        if (asTheyWere) {
            for (const [id, f] of window.__files) thumbs.set(id, URL.createObjectURL(f));
            window.__oldThumbs = thumbs;
        } else {
            const both = new Promise((r) => {
                window.__previews = xc.createComposerPreviews((id, url) => { thumbs.set(id, url); if (thumbs.size === 2) r(); });
            });
            for (const [id, f] of window.__files) window.__previews.show(id, f);
            await both;
        }
        const im = new Image(); im.src = thumbs.get('att_2'); await im.decode().catch(() => {});
        return { parkedUrl: String(parkedUrl).slice(0, 5), thumbW: im.naturalWidth, thumbScheme: String(thumbs.get('att_1')).slice(0, 5) };
    }, { M, asTheyWere });

    // The clips are saved a few seconds before the pressure, so a browser's download is still in
    // its handoff when it comes.
    await at(12000);
    const download = page.waitForEvent('download');
    const clipAt = since();
    await page.evaluate(async ({ M, asTheyWere }) => {
        const xc = window.__xc;
        const clip = async (mark, clipId) => {
            const s = xc.newClipSecrets(clipId);
            const parts = [window.__mark(mark + 'A-', 3), window.__mark(mark + 'B-', 3)];
            const ids = []; let total = 0;
            window.__wires ??= new Map();
            for (let i = 0; i < parts.length; i++) {
                const w = await xc.sealPart(s, i, parts[i]);
                const id = `${clipId.slice(0, 7)}${i}-aaaa-4bbb-8ccc-dddddddddddd`;
                window.__wires.set(id, w); ids.push(id); total += w.byteLength;
            }
            return { key: s.key, noncePrefix: s.noncePrefix, clipId, videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2', durationMs: 2000, width: 640, height: 360, totalCipherBytes: total, parts: ids, partDurMs: [0, 1000] };
        };
        const desk = await clip(M.deskClip, '11111111-2222-4333-8444-555555555551');
        const web = await clip(M.webClip, '22222222-2222-4333-8444-555555555552');
        // GET /files/<part>: the sealed parts, as the server answers.
        const real = window.fetch;
        window.fetch = async (url, init) => {
            const m = /\/files\/([0-9a-f-]+)$/.exec(String(url));
            if (m && window.__wires.has(m[1])) return new Response(window.__wires.get(m[1]).slice());
            return real(url, init);
        };
        // What saveClip did before: a page Blob of the whole clip, its URL revoked 30 s later.
        const oldSaveClip = async (m) => {
            const blob = await xc.downloadClipBytes(m, undefined, undefined, undefined, true);
            const url = URL.createObjectURL(blob);
            try { return await xc.saveAttachment(url, xc.clipFileName(m)); } finally { setTimeout(() => URL.revokeObjectURL(url), 30_000); }
        };
        const save = asTheyWere ? oldSaveClip : xc.saveClip;
        // The desktop app: a stand-in shell whose attachment_save is still writing when the
        // pressure comes. Taken away again once the save has asked it, for the browser's turn.
        window.__shellSaves = [];
        const latin1 = (u) => new TextDecoder('latin1').decode(u);
        window.__TAURI_INTERNALS__ = {
            transformCallback: () => 0,
            invoke: (cmd, args) => new Promise((resolve) => {
                const bytes = args instanceof Uint8Array ? args : new Uint8Array(args);
                const half = bytes.length >> 1;
                window.__shellSaves.push({ cmd, n: bytes.byteLength, head: latin1(bytes.subarray(0, 64)), second: latin1(bytes.subarray(half, half + 64)) });
                window.__shellDone = () => resolve('C:/Users/someone/Downloads/Puca/clip.mp4');
            }),
        };
        window.__deskSave = save(desk);
        while (window.__shellSaves.length === 0) await new Promise((r) => setTimeout(r, 20));
        delete window.__TAURI_INTERNALS__;
        window.__webSaved = await save(web);
    }, { M, asTheyWere });
    const d = await download;
    const got = fs.readFileSync(await d.path());

    await pressure();
    const all = Object.values(M).flatMap((m) => m.includes('CLIP') ? [m + 'A-', m + 'B-'] : [m]);
    const paged = onDisk(BS, all);
    const has = (list, m) => list.some((p) => p.startsWith(m));

    // Let go of all of it at the moment the browser download's handoff ends (DOWNLOAD_HANDOFF_MS
    // after the click): the preview unmounted, the message sent, the desktop save done.
    const handoff = await page.evaluate(() => window.__xc.DOWNLOAD_HANDOFF_MS);
    await at(clipAt + handoff + 200);
    const shell = await page.evaluate(async (asTheyWere) => {
        // (the old module: a picture leaving the screen told it nothing)
        if (!asTheyWere) { window.__parkedHold?.release(); window.__parkedHold = null; }
        if (asTheyWere) { for (const u of window.__oldThumbs.values()) URL.revokeObjectURL(u); window.__oldThumbs = null; }
        window.__files.clear();
        if (!asTheyWere) window.__previews.dropAll();
        window.__shellDone();
        const result = await window.__deskSave;
        window.__deskSave = null;
        return { saves: window.__shellSaves, result };
    }, asTheyWere);
    await sleep(3500);
    const left = onDisk(BS, all);
    const stats = await page.evaluate(() => ({ ...window.__xc.plaintextHostStats(), parked: window.__xc.parked.parkedPreviewStats() }));
    return { M, paged, left, has, shown, got, shell, stats };
}

/**
 * 11: SMALL files let go of while others in their shared host worker are still
 * shown. Three small decrypted pictures stay on screen the whole time; two
 * parked Notes pictures and two pictures pasted into the message box, each
 * under BIG_LEASE_BYTES, go into the same shared host worker
 * (api/plaintextHost.ts). Made in that order, each let settle before the next,
 * so Chromium pages them out in that order (least recently used first, a file
 * of at least 4 MiB at a time under pressure): the three shown, the two parked
 * and the two pasted, each group of 4.5 MiB in a file of its own. The checks
 * read which file each went into (a file is deleted only once every blob in it
 * is gone, so one shared with something still held is said, not counted), and
 * need at least one file of parked pictures only and one of pasted ones only.
 * Then the parked pictures' cards close (the page nudges nothing else then),
 * and later both chips go, with the three still shown throughout. Which of
 * them is on disk 3.5 s after each.
 * `worker` is the host worker's script: the real one, or (the NEGATIVE
 * CONTROL) one whose `collect` does nothing, as the worker was before it had
 * one.
 */
async function smallBesideShown({ page, ready, pressure, BS }, worker) {
    await ready();
    await page.evaluate(async (worker) => {
        await new Promise((r) => { const s = document.createElement('script'); s.src = '/extra.js'; s.onload = r; document.head.append(s); });
        window.__xc.__setPlaintextWorkerFactory(() => new Worker(worker, { type: 'module' }));
    }, worker);
    const M = {
        shown: ['PUCA-XB-SHOWN-0-', 'PUCA-XB-SHOWN-1-', 'PUCA-XB-SHOWN-2-'],
        parked: ['PUCA-XB-SMALL-PARKED-A-', 'PUCA-XB-SMALL-PARKED-B-'],
        pasted: ['PUCA-XB-SMALL-PASTE-A-', 'PUCA-XB-SMALL-PASTE-B-'],
    };
    const shown = await page.evaluate(async (M) => {
        const xc = window.__xc;
        // Each blob reaches the browser process before the next is made, so they are paged in that order.
        const settle = () => new Promise((r) => setTimeout(r, 300));
        window.__shown = [];
        // (this bundle's own plaintextHost, the one the previews below use: one module, one shared worker)
        for (const m of M.shown) { window.__shown.push(await xc.hostPlaintext(window.__mark(m, 1.5).buffer, 'image/jpeg')); await settle(); }
        // Parked records as notesBlobs.ts keeps them (see previewsAndClip).
        const recs = new Map();
        for (const [i, m] of M.parked.entries()) {
            const keyBytes = crypto.getRandomValues(new Uint8Array(32));
            const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
            const nonce = crypto.getRandomValues(new Uint8Array(12));
            const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, window.__mark(m, i ? 2.5 : 2)));
            const sealed = new Uint8Array(12 + ct.length); sealed.set(nonce); sealed.set(ct, 12);
            let b = ''; for (let j = 0; j < sealed.length; j += 0x8000) b += String.fromCharCode(...sealed.subarray(j, j + 0x8000));
            recs.set(`pk-small-${i}`, { data: btoa(b), key: btoa(String.fromCharCode(...keyBytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), mime: 'image/jpeg' });
        }
        xc.parked.setParkedReader(async (id) => recs.get(id) ?? null);
        window.__parkedHolds = [];
        for (const id of recs.keys()) { window.__parkedHolds.push(await xc.parked.acquireParkedUrl(xc.parkedHref(id, 'image/jpeg'))); await settle(); }
        window.__files = new Map();
        for (const [i, m] of M.pasted.entries()) { window.__files.set(`att_${i}`, new File([window.__mark(m, i ? 2.5 : 2)], `${i}.png`, { type: 'image/png' })); await settle(); }
        const thumbs = new Map();
        await new Promise((r) => {
            window.__previews = xc.createComposerPreviews((id, url) => { thumbs.set(id, url); if (thumbs.size === 2) r(); });
            for (const [id, f] of window.__files) window.__previews.show(id, f);
        });
        return { workers: xc.plaintextHostStats().workers, urls: [...window.__parkedHolds.map((h) => h?.url), ...thumbs.values()].map((u) => String(u).slice(0, 5)) };
    }, M);
    await pressure();
    const all = [...M.shown, ...M.parked, ...M.pasted];
    const paged = onDisk(BS, all);
    const files = filesOnDisk(BS, all);
    // The parked pictures' cards close: nothing but the parked previews lets go.
    await page.evaluate(() => { for (const h of window.__parkedHolds) h.release(); window.__parkedHolds = null; });
    await sleep(3500);
    const afterParked = onDisk(BS, all);
    // Past the page's at-most-one-nudge-in-5-s, so the chips' nudge is not held back by the last one.
    await sleep(3000);
    await page.evaluate(() => { window.__files.clear(); window.__previews.drop('att_0'); window.__previews.drop('att_1'); });
    await sleep(3500);
    const afterPasted = onDisk(BS, all);
    const stats = await page.evaluate(() => window.__xc.plaintextHostStats());
    await page.evaluate(() => { for (const l of window.__shown) l.release(); });
    await sleep(3500);
    return { M, shown, paged, files, afterParked, afterPasted, stats, end: onDisk(BS, all) };
}

/**
 * 11's files, read: the marks in files of parked pictures only, of pasted ones
 * only, of either (all let go of by the end), and of the shown ones only; and
 * whether the premise holds (no let-go picture in a file with a shown one, and
 * at least one file of each let-go group alone).
 */
function byFile(r) {
    const only = (f, set) => f.every((m) => set.includes(m));
    const letGo = [...r.M.parked, ...r.M.pasted];
    const pick = (set) => r.files.filter((f) => only(f, set)).flat();
    const parkedOnly = pick(r.M.parked), pastedOnly = pick(r.M.pasted);
    const mixedWithShown = r.files.some((f) => f.some((m) => r.M.shown.includes(m)) && f.some((m) => letGo.includes(m)));
    return {
        parkedOnly, pastedOnly, letGoOnly: pick(letGo), shownOnly: pick(r.M.shown),
        premise: !mixedWithShown && parkedOnly.length > 0 && pastedOnly.length > 0,
    };
}

const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const only = (name, run) => (ONLY.length === 0 || ONLY.includes(name) ? scenario(name, run) : Promise.resolve());

await Promise.all([
    // 11: small ones let go of beside others still shown.
    only('small-beside-shown', async (s) => {
        const r = await smallBesideShown(s, '/w/plaintext.js');
        const g = byFile(r);
        console.log('INFO', 'paged into files (each list one file):', JSON.stringify(r.files));
        ck(g.premise, 'CONTROL SETUP: nothing let go of shares a file with what stays shown, and a file holds parked pictures only, another pasted ones only', JSON.stringify(r.files));
        ck(r.shown.workers === 1 && r.shown.urls.join() === 'blob:,blob:,blob:,blob:', 'CONTROL SETUP: three pictures shown, two parked ones and two pasted ones, all in ONE shared host worker', JSON.stringify(r.shown));
        ck(g.parkedOnly.every((m) => !r.afterParked.includes(m)), 'parked pictures whose cards closed, beside pictures still shown in their worker: gone from the disk within 3.5 s', JSON.stringify(r.afterParked));
        ck(g.pastedOnly.every((m) => r.afterParked.includes(m)), 'CONTROL: the pasted ones, their chips still there, are still on disk then', JSON.stringify(r.afterParked));
        ck(g.letGoOnly.every((m) => !r.afterPasted.includes(m)), 'pasted pictures whose chips went, beside pictures still shown in their worker: gone from the disk within 3.5 s', JSON.stringify(r.afterPasted));
        ck(g.shownOnly.length > 0 && g.shownOnly.every((m) => r.afterPasted.includes(m)) && r.stats.workers === 1, 'CONTROL: the three still shown are still on disk, in their worker', JSON.stringify(r.stats));
        ck(r.end.length === 0, 'and once they are let go of too, nothing is left', JSON.stringify(r.end));
    }),
    only('small-beside-shown-as-it-was', async (s) => {
        const r = await smallBesideShown(s, '/w/plaintext-no-collect.js');
        const g = byFile(r);
        ck(g.premise, 'CONTROL SETUP: the same files as above', JSON.stringify(r.files));
        ck(g.parkedOnly.every((m) => r.afterParked.includes(m)) && g.letGoOnly.every((m) => r.afterPasted.includes(m)), 'NEGATIVE CONTROL: with a host worker that does not collect its garbage (as it was), the parked and pasted pictures let go of beside others still shown are still on disk at the same moments', JSON.stringify([r.afterParked, r.afterPasted]));
        ck(r.end.length === 0, 'CONTROL: once the worker goes (the last of them let go of), nothing is left', JSON.stringify(r.end));
    }),
    // 1-6.
    only('release', async ({ page, ready, pressure, BS, FSDIR }) => {
        // 6 (setup): a directory an earlier page left, with no lock on it.
        await page.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const base = await root.getDirectoryHandle('puca-attachment-cache', { create: true });
            const stale = await base.getDirectoryHandle('s-stale', { create: true });
            const fh = await stale.getFileHandle('c1', { create: true });
            const w = await fh.createWritable(); await w.write(new TextEncoder().encode('left over')); await w.close();
        });
        await ready();

        // 1. The URLs work like the page's own.
        const media = await page.evaluate(async () => {
            const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48;
            const g = cv.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 64, 48);
            const png = await new Promise((r) => cv.toBlob(r, 'image/png'));
            const img = await window.__xb.hostPlaintext(await png.arrayBuffer(), 'image/png');
            const im = new Image(); im.src = img.url; await im.decode();
            const mp4 = await (await fetch('/fixture.mp4')).arrayBuffer();
            const vid = await window.__xb.hostPlaintext(mp4, 'video/mp4');
            const v = document.createElement('video'); v.muted = true; v.preload = 'metadata'; v.src = vid.url;
            await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 8000); });
            const out = { imgW: im.naturalWidth, url: img.url.slice(0, 5), vidW: v.videoWidth, vidH: v.videoHeight, err: v.error?.code ?? null, emptied: mp4.byteLength };
            v.removeAttribute('src'); v.load();
            img.release(); vid.release();
            return out;
        });
        ck(media.imgW === 64 && media.url === 'blob:', 'a hosted picture decodes from its blob: URL', JSON.stringify(media));
        ck(media.vidW > 0 && media.vidH > 0 && media.err === null, 'a hosted video loads its metadata (muted, never played)');
        ck(media.emptied === 0, 'the page\'s plaintext buffer was emptied once the Blob had it (freeNow)');

        // 5 (setup) + 6: cached ciphertext goes to OPFS; the stale directory is swept.
        const cipher = await page.evaluate(async () => {
            const bytes = window.__mark('PUCA-XB-CIPHER-MARK', 24);
            const sample = bytes.slice(0, 64);
            window.__cipher = window.__xb.keepCipher(bytes);
            const back = await window.__cipher.read();
            const same = back.length === 24 * 1048576 && back.slice(0, 64).every((b, i) => b === sample[i]);
            await new Promise((r) => setTimeout(r, 500));
            const root = await navigator.storage.getDirectory();
            const base = await root.getDirectoryHandle('puca-attachment-cache');
            const names = []; for await (const k of base.keys()) names.push(k);
            return { same, handedOff: bytes.byteLength === 0, names };
        });
        ck(cipher.same, 'cached ciphertext reads back byte for byte (after its file is written)');
        ck(cipher.handedOff, 'its bytes went to the writer worker (the page holds no copy)');
        ck(!cipher.names.includes('s-stale') && cipher.names.length === 1, 'a cache directory no page holds is swept', JSON.stringify(cipher.names));
        ck(onDisk(FSDIR, ['PUCA-XB-CIPHER-MARK']).length === 1, 'the ciphertext is in the OPFS directory');

        // 2 + 4 (setup): plaintext hosted by workers, and a blob the page holds.
        await page.evaluate(async () => {
            window.__leases = [];
            for (let n = 0; n < 3; n++) window.__leases.push(await window.__xb.hostPlaintext(window.__mark(`PUCA-XB-PLAIN-BIG-${n}`, 24).buffer, 'video/mp4'));
            window.__leases.push(await window.__xb.hostPlaintext(window.__mark('PUCA-XB-PLAIN-SMALL', 1).buffer, 'image/png'));
            window.__control = new Blob([window.__mark('PUCA-XB-CONTROL', 24)], { type: 'video/mp4' });
            window.__controlUrl = URL.createObjectURL(window.__control);
        });
        await pressure();
        const PLAIN = ['PUCA-XB-PLAIN-BIG-0', 'PUCA-XB-PLAIN-BIG-1', 'PUCA-XB-PLAIN-BIG-2', 'PUCA-XB-PLAIN-SMALL'];
        const paged = onDisk(BS, [...PLAIN, 'PUCA-XB-CONTROL', 'PUCA-XB-CIPHER-MARK']);
        ck(PLAIN.every((m) => paged.includes(m)), 'POSITIVE CONTROL: under memory pressure the hosted plaintext is on disk as it is', JSON.stringify(paged));
        ck(!paged.includes('PUCA-XB-CIPHER-MARK'), 'the cached ciphertext is not in blob_storage, even under pressure');

        // 3: released: gone within seconds, with nothing forced from outside (the
        // module nudges the page's collector a second after the last release).
        await page.evaluate(() => { for (const l of window.__leases) l.release(); URL.revokeObjectURL(window.__controlUrl); });
        await sleep(3500);
        const after = onDisk(BS, [...PLAIN, 'PUCA-XB-CONTROL']);
        ck(PLAIN.every((m) => !after.includes(m)), 'released: every hosted plaintext is gone from the disk within 3.5 s', JSON.stringify(after));
        ck(after.includes('PUCA-XB-CONTROL'), 'NEGATIVE CONTROL: a blob the page still holds stays on disk after its URL is revoked');
        ck(await page.evaluate(() => window.__xb.plaintextHostStats().workers === 0), 'no host worker is left running');

        // 5: the cached copy goes when dropped.
        await page.evaluate(() => window.__cipher.drop());
        await sleep(1000);
        ck(onDisk(FSDIR, ['PUCA-XB-CIPHER-MARK']).length === 0, 'a dropped ciphertext copy is removed from OPFS');
    }),

    // 7: sign-out takes plaintext that is ON DISK off it.
    only('sign-out', async ({ page, ready, pressure, BS, FSDIR }) => {
        await ready();
        await page.evaluate(async () => {
            window.__last = await window.__xb.hostPlaintext(window.__mark('PUCA-XB-SIGNOUT-PLAIN', 24).buffer, 'video/mp4');
            window.__lastCipher = window.__xb.keepCipher(window.__mark('PUCA-XB-SIGNOUT-CIPHER', 8));
            await window.__lastCipher.read();
        });
        await pressure();
        ck(onDisk(BS, ['PUCA-XB-SIGNOUT-PLAIN']).length === 1, 'POSITIVE CONTROL: before sign-out, the hosted plaintext is on disk');
        ck(onDisk(FSDIR, ['PUCA-XB-SIGNOUT-CIPHER']).length === 1, 'POSITIVE CONTROL: before sign-out, the ciphertext is in OPFS');
        await page.evaluate(() => {
            window.__xb.dropAllPlaintext();
            window.__xb.dropAllCiphertext();
        });
        await sleep(3500);
        const leftover = [...onDisk(BS, ['PUCA-XB-SIGNOUT-PLAIN']), ...onDisk(FSDIR, ['PUCA-XB-SIGNOUT-CIPHER'])];
        ck(leftover.length === 0, 'sign-out: no plaintext in blob_storage and no ciphertext in OPFS', JSON.stringify(leftover));
    }),

    // 8: avatars, emoji and server icons never keep a released picture on disk.
    only('avatars', async (s) => {
        await s.ready();
        const img = await s.page.evaluate(async () => {
            const url = await window.__xb.fetchFileUrl('av-real');
            const im = new Image(); im.src = url; await im.decode();
            const again = await window.__xb.fetchFileUrl('av-real');
            return { w: im.naturalWidth, scheme: String(url).split(':')[0], cached: again === url && window.__xb.cachedFileUrl('av-real') === url };
        });
        ck(img.w === 64 && img.scheme === 'data', 'an avatar fetched through authedMedia decodes in an <img>, from a data: URL', JSON.stringify(img));
        ck(img.cached, 'and is fetched once, then served from the cache');
        const r = await picturesBesideAvatars(s, 'authedMedia');
        ck(r.missing === 0 && r.schemes.join() === 'data', `${AVATARS} avatars fetched, every one a data: URL`, JSON.stringify(r.schemes));
        // Chromium pages out whole files' worth (about 4 MB each, measured):
        // what is left over stays in memory, so not every picture need be there.
        ck(r.PICS.some((m) => r.paged.includes(m)), 'POSITIVE CONTROL: under memory pressure pictures beside them are on disk', JSON.stringify(r.paged));
        ck(r.AV.every((m) => !r.paged.includes(m)), 'the avatars are not in blob_storage, even under pressure');
        ck(r.left.length === 0, 'released: no picture is left on disk beside the avatars', JSON.stringify(r.left));
    }),
    only('avatars-as-blobs', async (s) => {
        await s.ready();
        const r = await picturesBesideAvatars(s, 'pageBlobs');
        ck(r.AV.every((m) => r.paged.includes(m)), 'CONTROL SETUP: avatars kept as page blobs are on disk under pressure', JSON.stringify(r.paged));
        ck(r.left.length > 0, 'NEGATIVE CONTROL: page blobs kept alive beside them keep a released picture on disk (what authedMedia used to do)', JSON.stringify(r.left));
    }),

    // 9: what the app makes besides a fetched attachment: let go means gone.
    only('previews-and-clip', async (s) => {
        const r = await previewsAndClip(s, false);
        ck(r.shown.parkedUrl === 'blob:' && r.shown.thumbScheme === 'blob:' && r.shown.thumbW === 32, "a parked picture and the message box's thumbnails get blob: URLs that decode", JSON.stringify(r.shown));
        ck(r.has(r.paged, r.M.parked) && r.has(r.paged, r.M.paste) && r.has(r.paged, r.M.webClip), 'POSITIVE CONTROL: shown (a browser download in its handoff), under memory pressure, each is on disk', JSON.stringify(r.paged));
        ck(!r.has(r.paged, r.M.deskClip), "the desktop app's clip Download is never in blob_storage, even under pressure while the shell writes it", JSON.stringify(r.paged));
        ck(r.left.length === 0, 'let go of (preview unmounted, message sent, saves done): all of it is gone from the disk within 3.5 s', JSON.stringify(r.left));
        ck(r.got.length === 6 * 1048576 && r.got.indexOf(Buffer.from(r.M.webClip + 'B-')) >= 0, "the browser's download is the whole clip", String(r.got.length));
        const save = r.shell.saves[0];
        ck(r.shell.saves.length === 1 && save.cmd === 'attachment_save' && save.n === 6 * 1048576 && save.head.startsWith(r.M.deskClip + 'A-') && save.second.startsWith(r.M.deskClip + 'B-') && r.shell.result?.onDisk === true,
            'the desktop shell was handed the whole clip, once', JSON.stringify({ ...save, head: save?.head.slice(0, 26), second: save?.second.slice(0, 26) }));
        ck(r.stats.workers === 0 && r.stats.parked.entries === 0, 'no host worker is left, and no parked preview', JSON.stringify(r.stats));
    }),
    // 10: the same, the way it was done before.
    only('previews-and-clip-as-they-were', async (s) => {
        const r = await previewsAndClip(s, true);
        ck(r.has(r.paged, r.M.parked) && r.has(r.paged, r.M.paste) && r.has(r.paged, r.M.webClip), 'CONTROL SETUP: done the old way, each is on disk under pressure', JSON.stringify(r.paged));
        ck(r.has(r.paged, r.M.deskClip), 'CONTROL: the old desktop Download made a page Blob of the clip, on disk under pressure', JSON.stringify(r.paged));
        for (const [what, m] of [['the parked picture (nothing shows it)', r.M.parked], ['the pasted picture (sent)', r.M.paste], ["the browser's clip", r.M.webClip], ['the desktop clip (saved)', r.M.deskClip]]) {
            ck(r.has(r.left, m), `NEGATIVE CONTROL: ${what} is still on disk at the same moment`, JSON.stringify(r.left));
        }
    }),
]).finally(() => server.close());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
