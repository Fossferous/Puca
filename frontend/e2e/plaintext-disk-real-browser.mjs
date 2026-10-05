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
// CHANNEL=msedge by default (an H.264 decoder for the fixture).
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
    format: 'iife',
});
const plaintextWorkerJs = await bundle({ entryPoints: [path.join(src, 'api', 'plaintextHost.worker.ts')], format: 'esm' });
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
    if (req.url === '/w/plaintext.js') return send('text/javascript', plaintextWorkerJs);
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
        await run({
            page, ready, pressure,
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

await Promise.all([
    // 1-6.
    scenario('release', async ({ page, ready, pressure, BS, FSDIR }) => {
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
    scenario('sign-out', async ({ page, ready, pressure, BS, FSDIR }) => {
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
    scenario('avatars', async (s) => {
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
    scenario('avatars-as-blobs', async (s) => {
        await s.ready();
        const r = await picturesBesideAvatars(s, 'pageBlobs');
        ck(r.AV.every((m) => r.paged.includes(m)), 'CONTROL SETUP: avatars kept as page blobs are on disk under pressure', JSON.stringify(r.paged));
        ck(r.left.length > 0, 'NEGATIVE CONTROL: page blobs kept alive beside them keep a released picture on disk (what authedMedia used to do)', JSON.stringify(r.left));
    }),
]).finally(() => server.close());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
