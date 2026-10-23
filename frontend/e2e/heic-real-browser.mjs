// A real HEIC photo through the REAL send-and-show path, in a real browser:
// api/heif.ts's conversion, the real seal (AES-GCM, as an upload), the
// ciphertext served the way /files serves it, the real attachment cache and
// plaintext host workers, and the real MessageContent / TaskAttachments /
// ComposerAttachments with the app's CSS. At 1280x800 with a mouse and at
// 390x844 with a touchscreen.
//
// WHY THIS EXISTS. The owner, 2026-10-23: "HEIC doesnt load in text
// channels" — a broken-image icon for IMG20261023012318.heic, a photo from an
// Android phone opened in the Windows app. Edge (the WebView2 engine) decodes
// no HEIC at all, so whether a HEIC ever reaches an <img>, and what a reader
// sees instead, only a real engine can say; jsdom decodes nothing either way.
// Checked:
//
//   1. the engine itself: Edge refuses the fixture in an <img> and in
//      createImageBitmap (the bug's root cause), and the app's probe says so;
//   2. the web app (no native decoder): a HEIC goes up as a HEIC with its
//      Exif blanked (no camera, no location; api/heifMetadata.ts); in a channel,
//      in a Task and in the composer it is a FILE CARD (name, "HEIC photo",
//      size, Download) and never an <img>; the Download button is on screen
//      and is what a pointer at its centre hits; nothing on the page is a
//      broken image (POSITIVE CONTROL: a PNG beside it IS an <img> that
//      decoded);
//   3. the desktop app (a stand-in `heif_to_jpeg` behind a fake Tauri shell;
//      the real command is tested on real bytes in src-tauri/src/heif.rs): a
//      HEIC is uploaded as a JPEG named .jpg and its composer chip previews
//      the JPEG; one already sent in HEIC is NOT decoded until the reader
//      presses Show photo on its card (the codec runs in the app's own
//      process), and then shows as a decoded picture;
//   4. the decoded JPEG lives only as long as the plaintext did: once every
//      attachment is unmounted, no plaintext host worker and no page lease is
//      left (api/plaintextHost.ts);
//   5. at 390x844 on a touchscreen: the card fits the column, nothing scrolls
//      sideways (clientWidth), the Download button is a 44 px target.
//
// Silent and headless (--mute-audio; nothing here makes sound).
//
//   cd frontend && node e2e/heic-real-browser.mjs [outdir]
//
// No server and no build needed. CHANNEL=msedge (default) or CHANNEL=bundled.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const outdir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'puca-heic-'));
fs.mkdirSync(outdir, { recursive: true });
const HEIC = fs.readFileSync(path.join(src, 'tests', 'fixtures', 'heic', 'rotated-gps.heic'));

// ---- the page --------------------------------------------------------------
const entry = `
import './index.css';
import './mobile.css';
import './components/Chat.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MessageContent } from './components/MessageContent';
import { TaskAttachments } from './components/TaskAttachments';
import { ComposerAttachments } from './components/ComposerAttachments';
import { pendingAttachment } from './api/composerAttachments';
import { sealFileForUpload } from './api/attachments';
import { convertHeifForUpload, engineDecodesHeif } from './api/heif';
import { __setPlaintextWorkerFactory, plaintextHostStats } from './api/plaintextHost';
import { __setCipherWriterFactory } from './api/cipherStore';

__setPlaintextWorkerFactory(() => new Worker('/w/plaintext.js', { type: 'module' }));
__setCipherWriterFactory(() => new Worker('/w/writer.js', { type: 'module' }));

const root = createRoot(document.getElementById('root'));
let uploads = 0;
/** Seal a file as the composer does and hand the ciphertext to the rig's
 *  /files, as an upload would: the ref a message carries. */
async function send(file) {
    const sealed = await sealFileForUpload(file);
    const id = 'f' + (++uploads);
    await fetch('/rig-upload/' + id, { method: 'POST', body: sealed.blob });
    return { href: 'sovereign-enc:' + id + '?k=' + sealed.key + '&m=' + encodeURIComponent(sealed.mime), name: sealed.name, mime: sealed.mime };
}
window.__rig = {
    engineDecodesHeif,
    plaintextHostStats,
    heic: () => new File([Uint8Array.from(atob(window.__HEIC_B64), (c) => c.charCodeAt(0))], 'IMG20261023012318.heic', { type: 'image/heic' }),
    png: async () => {
        const c = document.createElement('canvas'); c.width = 40; c.height = 30;
        const x = c.getContext('2d'); x.fillStyle = '#3a7'; x.fillRect(0, 0, 40, 30);
        return new File([await new Promise((r) => c.toBlob(r, 'image/png'))], 'shot.png', { type: 'image/png' });
    },
    convert: (f) => convertHeifForUpload(f),
    send,
    /** A channel's messages, a Task's attachments and the composer's chips. */
    show(msgs, taskRefs, chips) {
        flushSync(() => root.render(
            <div className="rig-list">
                {msgs.map((m) => (
                    <div className="rig-msg" key={m.id} data-msg={m.id}>
                        <div className="message-content"><MessageContent content={m.content} members={[]} /></div>
                    </div>
                ))}
                {taskRefs.length > 0 && <div className="rig-msg" data-msg="task"><TaskAttachments refs={taskRefs} canEdit={false} onRemove={() => {}} /></div>}
                {chips.length > 0 && <div className="rig-msg" data-msg="composer"><ComposerAttachments attachments={chips} onRemove={() => {}} onToggleSpoiler={() => {}} onRetry={() => {}} /></div>}
            </div>,
        ));
    },
    chip: (file) => pendingAttachment(file, file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/heic' ? URL.createObjectURL(file) : null),
    clear() { flushSync(() => root.render(<div />)); },
};
`;
const RIG_CSS = `
html, body, #root { height: 100%; margin: 0; }
.rig-list { height: 100%; overflow-y: auto; background: var(--bg-primary); color: var(--text-normal); }
.rig-msg { padding: 6px 16px 6px 72px; }
@media (max-width: 500px) { .rig-msg { padding: 6px 12px; } }
`;

const stored = new Map();
const server = http.createServer((req, res) => {
    const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    const url = req.url ?? '/';
    if (url === '/main.js') return send('text/javascript', bundles.main);
    if (url === '/main.css') return send('text/css', bundles.css + RIG_CSS);
    if (url === '/w/plaintext.js') return send('text/javascript', bundles.plaintext);
    if (url === '/w/writer.js') return send('text/javascript', bundles.writer);
    const up = /^\/rig-upload\/(\w+)$/.exec(url);
    if (up && req.method === 'POST') {
        const parts = [];
        req.on('data', (c) => parts.push(c));
        req.on('end', () => { stored.set(up[1], Buffer.concat(parts)); res.writeHead(204); res.end(); });
        return;
    }
    const file = /^\/files\/(\w+)$/.exec(url);
    if (file) {
        if (req.headers.authorization !== 'Bearer rig-token') { res.writeHead(401); res.end(); return; }
        const body = stored.get(file[1]);
        if (!body) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length, 'cache-control': 'private, no-store' });
        res.end(body);
        return;
    }
    if (url === '/' || url.startsWith('/?')) {
        return send('text/html', '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>heic rig</title><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script src="/main.js"></script></body></html>');
    }
    res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const stubs = {
    name: 'url-stub',
    setup(b) {
        b.onResolve({ filter: /\?(url|worker)$/ }, (a) => ({ path: a.path, namespace: 'url-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'url-stub' }, (a) => ({ contents: a.path.endsWith('?worker') ? 'export default class W {}' : 'export default ""', loader: 'js' }));
    },
};
const mainBuild = await build({
    stdin: { contents: entry, resolveDir: src, loader: 'tsx', sourcefile: 'entry.tsx' },
    bundle: true, write: false, outdir: path.join(here, '.rig-out'), format: 'iife', platform: 'browser', jsx: 'automatic',
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.svg': 'empty', '.png': 'empty', '.mp3': 'empty', '.ogg': 'empty', '.wasm': 'empty' },
    define: {
        'process.env.NODE_ENV': '"production"',
        __RC_ENABLED__: 'true',
        __APP_VERSION__: '"0.0.0-rig"',
        'import.meta.env': JSON.stringify({ VITE_API_URL: origin, DEV: false, PROD: true, MODE: 'production' }),
    },
    plugins: [stubs], logOverride: { 'empty-import-meta': 'silent' }, logLevel: 'error',
});
const workerBuild = async (f) => (await build({ entryPoints: [path.join(src, 'api', f)], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'error' })).outputFiles[0].text;
const bundles = {
    main: mainBuild.outputFiles.find((f) => f.path.endsWith('.js')).text,
    css: mainBuild.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '',
    plaintext: await workerBuild('plaintextHost.worker.ts'),
    writer: await workerBuild('cipherWriter.worker.ts'),
};
if (!bundles.css.includes('.message-picture-file')) throw new Error('rig: Chat.css did not make it into the bundle');

// ---- checks ----------------------------------------------------------------
let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHANNEL = process.env.CHANNEL || 'msedge';
const browser = await chromium.launch({ headless: true, ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }), args: ['--mute-audio'] });
console.log(`engine: ${CHANNEL} ${browser.version()}`);
let shots = 0;
const shot = async (page, name) => { shots++; await page.screenshot({ path: path.join(outdir, `${name}.png`) }); };

/**
 * A fake desktop shell: `heif_to_jpeg` answers with a JPEG the page draws
 * (48x64, four coloured quarters: what the real command makes of the
 * fixture), and any other command fails the run.
 */
const DESKTOP_SHELL = () => {
    window.__heifCalls = [];
    window.__unknownCommands = [];
    window.__TAURI_INTERNALS__ = {
        transformCallback: () => 0,
        async invoke(cmd, args, options) {
            if (cmd !== 'heif_to_jpeg') { window.__unknownCommands.push(cmd); throw new Error('not in the rig: ' + cmd); }
            const head = Array.from(new Uint8Array(args.buffer, args.byteOffset, 12)).map((b) => String.fromCharCode(b)).join('');
            window.__heifCalls.push({ bytes: args.byteLength, head, maxEdge: options?.headers?.['x-max-edge'] });
            const c = document.createElement('canvas'); c.width = 48; c.height = 64;
            const x = c.getContext('2d');
            x.fillStyle = 'rgb(30,30,220)'; x.fillRect(0, 0, 24, 32);
            x.fillStyle = 'rgb(220,30,30)'; x.fillRect(24, 0, 24, 32);
            x.fillStyle = 'rgb(240,240,240)'; x.fillRect(0, 32, 24, 32);
            x.fillStyle = 'rgb(30,200,30)'; x.fillRect(24, 32, 24, 32);
            const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
            return await blob.arrayBuffer();
        },
    };
};

async function open(name, ctxOpts, initScript) {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { fail++; console.log(`FAIL [${name}] page error`, e.message); });
    await page.addInitScript((b64) => { window.__HEIC_B64 = b64; localStorage.setItem('auth_token', 'rig-token'); }, HEIC.toString('base64'));
    if (initScript) await page.addInitScript(initScript);
    await page.goto(origin + '/');
    await page.waitForFunction(() => !!window.__rig);
    return { ctx, page };
}

/** Every <img> on the page, and whether it decoded. */
const images = (page) => page.evaluate(() => [...document.querySelectorAll('img')].map((i) => ({
    alt: i.getAttribute('alt'), complete: i.complete, w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0, 5),
})));
const waitShown = (page, sel) => page.waitForFunction((s) => {
    const el = document.querySelector(s);
    return !!el && (el.tagName !== 'IMG' || (el.complete && el.naturalWidth > 0));
}, sel, { timeout: 20000 }).then(() => true, () => false);

/** The card of chat message `msg`: on screen, its Download what a pointer hits. */
const cardOf = (page, msg) => page.evaluate((msg) => {
    const card = document.querySelector(`[data-msg="${msg}"] .message-picture-file`);
    if (!card) return null;
    const btn = card.querySelector('button.message-attachment');
    const b = btn.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
        text: card.textContent, btn: { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height },
        card: { l: c.left, r: c.right, w: c.width }, hit: !!at && (at === btn || btn.contains(at)),
        vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        listOverflow: (() => { const l = document.querySelector('.rig-list'); return l.scrollWidth - l.clientWidth; })(),
    };
}, msg);

async function noBrokenImages(page, tag) {
    const imgs = await images(page);
    const broken = imgs.filter((i) => i.complete && i.w === 0);
    ck(broken.length === 0, `${tag}: no broken image anywhere on the page`, JSON.stringify(broken));
}

// ======================= 1. the engine itself ===============================
{
    const { ctx, page } = await open('engine', { viewport: { width: 1280, height: 800 } });
    const r = await page.evaluate(async () => {
        const f = window.__rig.heic();
        let bitmap;
        try { const b = await createImageBitmap(f); bitmap = `${b.width}x${b.height}`; } catch (e) { bitmap = 'refused: ' + e.name; }
        const img = await new Promise((res) => { const i = new Image(); i.onload = () => res('decoded'); i.onerror = () => res('error'); i.src = URL.createObjectURL(f); });
        return { bitmap, img, probe: await window.__rig.engineDecodesHeif() };
    });
    ck(r.bitmap.startsWith('refused') && r.img === 'error', 'engine: this engine cannot decode HEIC (the root cause)', JSON.stringify(r));
    ck(r.probe === false, "engine: the app's probe says so (engineDecodesHeif)");
    await ctx.close();
}

// ======================= 2. the web app =====================================
async function webApp(name, ctxOpts, coarse) {
    const { ctx, page } = await open(name, ctxOpts);
    const sent = await page.evaluate(async () => {
        const heic = window.__rig.heic();
        const out = await window.__rig.convert(heic);
        const ref = await window.__rig.send(out);
        const pngFile = await window.__rig.png();
        const png = await window.__rig.send(pngFile);
        // A ref an older sender made: PNG bytes, labelled image/heic.
        const liar = await window.__rig.send(new File([pngFile], 'liar.heic', { type: 'image/heic' }));
        const bytes = new Uint8Array(await out.arrayBuffer());
        return { ref, png, liar, sentB64: btoa(String.fromCharCode(...bytes)), size: bytes.length, camera: new TextDecoder('latin1').decode(bytes).includes('PucaTestCam') };
    });
    const sentBytes = Buffer.from(sent.sentB64, 'base64');
    ck(sent.ref.mime === 'image/heic' && sent.ref.name.endsWith('.heic') && sent.size === HEIC.length, `[${name}] with no decoder anywhere, it is sent as a HEIC`, JSON.stringify({ mime: sent.ref.mime, name: sent.ref.name, size: sent.size }));
    ck(!sent.camera && HEIC.includes('PucaTestCam'), `[${name}] ... with its metadata blanked: the camera and location are not in what was sent (control: the fixture has them)`);
    await page.evaluate((s) => {
        const chip = window.__rig.chip(window.__rig.heic());
        window.__rig.show([
            { id: 'm-heic', content: `![${s.ref.name}](${s.ref.href})` },
            { id: 'm-png', content: `![shot.png](${s.png.href})` },
            { id: 'm-liar', content: `![liar.heic](${s.liar.href})` },
        ], [{ href: s.ref.href, name: s.ref.name }], [chip]);
    }, sent);
    ck(await waitShown(page, '[data-msg="m-png"] .message-image img'), `[${name}] positive control: the PNG beside it decodes into an <img>`);
    ck(sent.liar.mime === 'image/heic', `[${name}] (the liar ref really says image/heic)`);
    ck(await waitShown(page, '[data-msg="m-liar"] .message-image img'), `[${name}] a PNG labelled image/heic is shown as the picture it is, by its bytes`);
    ck(await waitShown(page, '[data-msg="m-heic"] .message-picture-file'), `[${name}] the HEIC message is a file card`);
    const card = await cardOf(page, 'm-heic');
    ck(!!card && /IMG20261023012318\.heic/.test(card.text) && /HEIC photo, \d+ KB/.test(card.text) && /can't show it/.test(card.text), `[${name}] the card names it, says what it is and its size`, JSON.stringify(card?.text));
    ck(!!card && card.hit, `[${name}] its Download button is what a pointer at its centre hits`);
    ck(!!card && card.btn.l >= 0 && card.btn.r <= card.vw && card.btn.t >= 0 && card.btn.b <= card.vh, `[${name}] its Download button is inside the window`, JSON.stringify(card?.btn));
    ck(!!card && card.pageOverflow <= 0 && card.listOverflow <= 0, `[${name}] nothing scrolls sideways (clientWidth)`, `page ${card?.pageOverflow}, list ${card?.listOverflow}`);
    if (coarse) ck(!!card && card.btn.h >= 44, `[${name}] the Download button is a 44 px touch target`, `${card?.btn.w}x${card?.btn.h}`);
    ck(await page.evaluate(() => !document.querySelector('[data-msg="m-heic"] img')), `[${name}] no <img> was ever given the HEIC in the message`);
    ck(await waitShown(page, '[data-msg="task"] button'), `[${name}] the Task's HEIC is its download button`);
    ck(await page.evaluate(() => !document.querySelector('[data-msg="task"] img')), `[${name}] ... and not an <img>`);
    ck(await page.evaluate(() => { const t = document.querySelector('[data-msg="composer"] .composer-chip-thumb'); return !!t && !t.querySelector('img') && !!t.querySelector('svg'); }), `[${name}] the composer's HEIC chip is a file icon, not a broken thumbnail`);
    await sleep(300);
    await noBrokenImages(page, `[${name}]`);
    await shot(page, `${name}-card`);
    // Download from the card: the real save path hands over the HEIC as it is.
    if (!coarse) {
        const [dl] = await Promise.all([
            page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
            page.click('[data-msg="m-heic"] .message-picture-file button.message-attachment'),
        ]);
        const saved = dl ? fs.readFileSync(await dl.path()) : null;
        ck(!!dl && dl.suggestedFilename() === 'IMG20261023012318.heic' && saved?.equals(sentBytes), `[${name}] Download saves the HEIC that was sent, byte for byte`, dl ? dl.suggestedFilename() : 'no download');
    }
    await page.evaluate(() => window.__rig.clear());
    await sleep(2500);
    const stats = await page.evaluate(() => window.__rig.plaintextHostStats());
    ck(stats.workers === 0 && stats.pageLeases === 0, `[${name}] unmounted: no plaintext host worker or lease is left`, JSON.stringify(stats));
    await ctx.close();
}
await webApp('web-1280', { viewport: { width: 1280, height: 800 }, acceptDownloads: true }, false);
await webApp('web-phone-390', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, true);

// ======================= 3. the desktop app =================================
{
    const name = 'desktop-app';
    const { ctx, page } = await open(name, { viewport: { width: 1280, height: 800 } }, DESKTOP_SHELL);
    // An already-sent HEIC (sealed as the web app would have sent it), and a
    // new one converted before it is sealed.
    const sent = await page.evaluate(async () => {
        const old = await window.__rig.send(window.__rig.heic());
        const out = await window.__rig.convert(window.__rig.heic());
        const fresh = await window.__rig.send(out);
        return { old, fresh, out: { name: out.name, type: out.type, size: out.size }, calls: window.__heifCalls.slice() };
    });
    ck(sent.out.name === 'IMG20261023012318.jpg' && sent.out.type === 'image/jpeg' && sent.fresh.mime === 'image/jpeg', `[${name}] a new HEIC is sealed and sent as a JPEG named .jpg`, JSON.stringify(sent.out));
    ck(sent.calls.length === 1 && sent.calls[0].bytes === HEIC.length && sent.calls[0].head.slice(4, 12) === 'ftypheic' && sent.calls[0].maxEdge === '4096', `[${name}] heif_to_jpeg was handed the photo's own bytes`, JSON.stringify(sent.calls));
    await page.evaluate((s) => {
        window.__rig.show([
            { id: 'm-old', content: `![${s.old.name}](${s.old.href})` },
            { id: 'm-new', content: `![${s.fresh.name}](${s.fresh.href})` },
        ], [], []);
    }, sent);
    ck(await waitShown(page, '[data-msg="m-new"] .message-image img'), `[${name}] the converted photo shows as a picture`);
    ck(await waitShown(page, '[data-msg="m-old"] .message-picture-file'), `[${name}] a HEIC sent earlier is a card first`);
    await sleep(300);
    ck((await page.evaluate(() => window.__heifCalls.length)) === 1, `[${name}] ... and nothing was decoded before the reader asked`);
    const showBtn = page.locator('[data-msg="m-old"] .message-picture-file button', { hasText: 'Show photo' });
    ck(await showBtn.count() === 1, `[${name}] the card offers Show photo`);
    await showBtn.click();
    ck(await waitShown(page, '[data-msg="m-old"] .message-image img'), `[${name}] Show photo shows it, decoded by the app`);
    const imgs = await images(page);
    ck(imgs.length === 2 && imgs.every((i) => i.w === 48 && i.h === 64), `[${name}] both pictures decoded, 48x64 (upright)`, JSON.stringify(imgs));
    ck(!(await page.evaluate(() => document.querySelector('.message-picture-file'))), `[${name}] no file card left once it is decoded`);
    // The composer: a chip for the converted file previews the JPEG.
    await page.evaluate(async () => {
        const out = await window.__rig.convert(window.__rig.heic());
        window.__rig.show([], [], [window.__rig.chip(out)]);
    });
    ck(await waitShown(page, '[data-msg="composer"] .composer-chip-thumb img'), `[${name}] the composer chip previews the converted JPEG`);
    ck(await page.evaluate(() => document.querySelector('.composer-chip-name')?.textContent) === 'IMG20261023012318.jpg', `[${name}] ... under the JPEG's name`);
    await shot(page, `${name}-pictures`);
    ck((await page.evaluate(() => window.__unknownCommands)).length === 0, `[${name}] the app sent no command the rig does not know`);
    await page.evaluate(() => window.__rig.clear());
    await sleep(2500);
    const stats = await page.evaluate(() => window.__rig.plaintextHostStats());
    ck(stats.workers === 0 && stats.pageLeases === 0, `[${name}] unmounted: the decoded JPEG went with its plaintext host (no worker, no lease)`, JSON.stringify(stats));
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed; ${shots} screenshots in ${outdir}`);
process.exit(fail ? 1 : 0);
