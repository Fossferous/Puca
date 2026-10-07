// Púca's own video controls (src/components/VideoPlayer.tsx) on the REAL
// chat attachment path, in a real browser, at 1280x800 with a mouse and at
// 390x844 with a touchscreen.
//
// WHY THIS EXISTS. The owner, 2026-10-07: "videos should have volume
// selecter, full screen icon and speed selecter". His screenshot was a
// portrait .mp4 in a message: Chromium's own controls had folded volume,
// fullscreen and speed away on a ~170 px player. Whether three buttons are
// VISIBLE and PRESSABLE at that width, whether the speed and volume panels
// fit a 390 px phone column and work in fullscreen, whether a finger
// scrolling the chat seeks the video, whether the speed really changes
// playback — none of that exists in jsdom (no layout, no media, no touch
// scrolling). This bundles the REAL MessageContent (esbuild) with the app's
// global CSS and Chat.css, serves three encrypted videos the way the server
// does (/files/<id>, authenticated, AES-GCM), and lets the real attachment
// pipeline decrypt them (its workers included). Checked:
//
//   1. a portrait (180x320), a very tall (180x420, letterboxed) and a
//      landscape (480x270) video: volume, speed and fullscreen are in the
//      bar, inside the player, inside the window, and are what a pointer at
//      their centre hits; 44 px on the touchscreen; nothing scrolls sideways;
//   2. speed: the menu fits the window, 2x really plays twice as fast
//      (POSITIVE CONTROL: 1x plays at 1x) — always MUTED first;
//   3. volume: the element's volume is this video's level x Settings >
//      Output Volume, a Settings change reaches it, the master is never
//      written; the panel fits the window;
//   4. fullscreen: the player's FRAME fills the window with its controls
//      usable (the speed menu opens above it), and comes back to its box;
//      the in-app fullscreen (what the phone app uses) covers the window in
//      the top layer and Esc leaves it;
//   5. keyboard: nothing happens to a player from the message box; inside
//      it, M / K / arrows / F do what they say;
//   6. touch: a tap on the picture shows/hides the controls and never
//      plays; a vertical swipe starting on the timeline scrolls the chat and
//      does not seek (POSITIVE CONTROL: the list did scroll; a sideways drag
//      DOES seek);
//   7. a spoilered video: nothing in it is focusable until revealed;
//   8. all eight themes, with and without high contrast: the panels' text
//      against their surface, the bar's ink against its fade; a screenshot
//      each.
//
// SILENT and headless: --mute-audio, the fixtures have NO audio track, and
// every element is muted (asserted) before anything plays.
//
//   cd frontend && node e2e/video-controls-real-browser.mjs [outdir]
//
// No server and no build needed. CHANNEL=msedge (default) or CHANNEL=bundled.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const outdir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'puca-video-controls-'));
fs.mkdirSync(outdir, { recursive: true });

// ---- the files, encrypted as the app uploads them: nonce || AES-GCM(ct||tag)
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function seal(bytes) {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([c.update(bytes), c.final(), c.getAuthTag()]);
    return { key: b64url(key), body: Buffer.concat([nonce, ct]) };
}
const asset = (n) => fs.readFileSync(path.join(here, 'assets', 'video-controls', n));
const FILES = {
    vportrait: { name: 'portrait.webm', ...seal(asset('portrait-180x320.webm')) },
    vtall: { name: 'screen-recording.webm', ...seal(asset('tall-180x420.webm')) },
    vland: { name: 'landscape.webm', ...seal(asset('landscape-480x270.webm')) },
    vspoil: { name: 'secret.webm', ...seal(asset('portrait-180x320.webm')) },
    vtask: { name: 'walkthrough.webm', ...seal(asset('portrait-180x320.webm')) },
};
const ref = (id) => `[${FILES[id].name}](sovereign-enc:${id}?k=${FILES[id].key}&m=video%2Fwebm)`;
const MSGS = [
    { id: 'm-portrait', content: ref('vportrait') },
    { id: 'm-tall', content: ref('vtall') },
    { id: 'm-land', content: ref('vland') },
    { id: 'm-spoil', content: `||${ref('vspoil')}||` },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, content: `Line ${i + 1} of the conversation after the videos, so the list scrolls.` })),
];

// ---- the page: the real MessageContent in a message list ------------------
const entry = `
import './index.css';
import './mobile.css';
import './components/Chat.css';
import { createRoot } from 'react-dom/client';
import { MessageContent } from './components/MessageContent';
import { TaskAttachments } from './components/TaskAttachments';
import { saveSettings, loadSettings } from './components/settingsStore';
import { __setPlaintextWorkerFactory } from './api/plaintextHost';
import { __setCipherWriterFactory } from './api/cipherStore';

__setPlaintextWorkerFactory(() => new Worker('/w/plaintext.js', { type: 'module' }));
__setCipherWriterFactory(() => new Worker('/w/writer.js', { type: 'module' }));
window.__rig = { saveSettings, loadSettings };
function App() {
    return (
        <div className="rig-list" data-scroller="">
            <textarea className="rig-composer" aria-label="Message" />
            {window.__MSGS.map((m) => (
                <div className="rig-msg" key={m.id} data-msg={m.id}>
                    <div className="message-content"><MessageContent content={m.content} members={[]} /></div>
                </div>
            ))}
            <div className="rig-msg" data-msg="m-task">
                <TaskAttachments refs={[window.__TASK_REF]} canEdit={false} onRemove={() => {}} />
            </div>
        </div>
    );
}
createRoot(document.getElementById('root')).render(<App />);
`;
const RIG_CSS = `
html, body, #root { height: 100%; margin: 0; }
.rig-list { height: 100%; overflow-y: auto; background: var(--bg-primary); color: var(--text-normal); }
.rig-composer { display: block; box-sizing: border-box; width: calc(100% - 32px); margin: 8px 16px; height: 40px; }
.rig-msg { padding: 6px 16px 6px 72px; }
`;

let origin = '';
const server = http.createServer((req, res) => {
    const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    const url = req.url ?? '/';
    if (url === '/main.js') return send('text/javascript', bundles.main);
    if (url === '/main.css') return send('text/css', bundles.css + RIG_CSS);
    if (url === '/w/plaintext.js') return send('text/javascript', bundles.plaintext);
    if (url === '/w/writer.js') return send('text/javascript', bundles.writer);
    const file = /^\/files\/(\w+)$/.exec(url);
    if (file) {
        if (req.headers.authorization !== 'Bearer rig-token') { res.writeHead(401); res.end(); return; }
        const f = FILES[file[1]];
        if (!f) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': f.body.length, 'cache-control': 'private, no-store' });
        res.end(f.body);
        return;
    }
    if (url === '/' || url.startsWith('/?')) {
        return send('text/html', '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>video controls rig</title><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script src="/main.js"></script></body></html>');
    }
    res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${server.address().port}`;

const stubs = {
    name: 'url-stub',
    setup(b) {
        b.onResolve({ filter: /\?(url|worker)$/ }, (a) => ({ path: a.path, namespace: 'url-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'url-stub' }, (a) => ({ contents: a.path.endsWith('?worker') ? 'export default class W {}' : 'export default ""', loader: 'js' }));
    },
};
const define = {
    'process.env.NODE_ENV': '"production"',
    __RC_ENABLED__: 'true',
    __APP_VERSION__: '"0.0.0-rig"',
    'import.meta.env': JSON.stringify({ VITE_API_URL: origin, DEV: false, PROD: true, MODE: 'production' }),
};
const mainBuild = await build({
    stdin: { contents: entry, resolveDir: src, loader: 'tsx', sourcefile: 'entry.tsx' },
    bundle: true, write: false, outdir: path.join(here, '.rig-out'), format: 'iife', platform: 'browser', jsx: 'automatic',
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.svg': 'empty', '.png': 'empty', '.mp3': 'empty', '.ogg': 'empty', '.wasm': 'empty' },
    define, plugins: [stubs], logOverride: { 'empty-import-meta': 'silent' }, logLevel: 'error',
});
const workerBuild = async (f) => (await build({ entryPoints: [path.join(src, 'api', f)], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'error' })).outputFiles[0].text;
const bundles = {
    main: mainBuild.outputFiles.find((f) => f.path.endsWith('.js')).text,
    css: mainBuild.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '',
    plaintext: await workerBuild('plaintextHost.worker.ts'),
    writer: await workerBuild('cipherWriter.worker.ts'),
};
if (!bundles.css.includes('.vpl-bar')) throw new Error('rig: VideoPlayer.css did not make it into the bundle');
if (!bundles.css.includes('.message-video .video-box')) throw new Error('rig: Chat.css did not make it into the bundle');

// ---- checks ----------------------------------------------------------------
let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHANNEL = process.env.CHANNEL || 'msedge';
const browser = await chromium.launch({ headless: true, ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }), args: ['--mute-audio'] });
let shots = 0;
const shot = async (page, name, clip) => { shots++; await page.screenshot({ path: path.join(outdir, `${name}.png`), ...(clip ? { clip } : {}) }); };

async function open(name, ctxOpts, initScript) {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { fail++; console.log(`FAIL [${name}] page error`, e.message); });
    await page.addInitScript(([msgs, taskRef]) => {
        window.__MSGS = msgs;
        window.__TASK_REF = taskRef;
        localStorage.setItem('auth_token', 'rig-token');
    }, [MSGS, { href: `sovereign-enc:vtask?k=${FILES.vtask.key}&m=video%2Fwebm`, name: FILES.vtask.name }]);
    if (initScript) await page.addInitScript(initScript);
    await page.goto(origin + '/');
    // Every video decrypted, mounted and its metadata loaded.
    const ok = await page.waitForFunction(() => {
        const vids = [...document.querySelectorAll('.message-video video, .task-attachments video')];
        return vids.length === 5 && vids.every((v) => v.readyState >= 1 && v.closest('.vpl'));
    }, null, { timeout: 30000 }).then(() => true, () => false);
    ck(ok, `[${name}] four chat videos and a Task's video decrypted into Púca's player, metadata loaded`);
    return { ctx, page };
}

/** The player of message `msg` and its controls, as laid out. */
const layoutOf = (page, msg) => page.evaluate((msg) => {
    const frame = document.querySelector(`[data-msg="${msg}"] .vpl`);
    if (!frame) return null;
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    const hit = (el) => {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) return false;
        const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return !!at && (at === el || el.contains(at));
    };
    const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
    const find = (re) => [...frame.querySelectorAll('.vpl-bar button')].find((b) => re.test(b.getAttribute('aria-label') ?? ''));
    const ctl = {};
    for (const [k, re] of Object.entries({ volume: /^(Volume, |Mute$|Unmute$)/, speed: /^Playback speed, /, fullscreen: /^(Full screen|Exit full screen)$/, play: /^(Play|Pause)$/ })) {
        const b = find(re);
        ctl[k] = b ? { rect: r(b), shown: shown(b), hit: shown(b) && hit(b), opacity: Number(getComputedStyle(b.closest('.vpl-bar')).opacity) } : null;
    }
    const center = frame.querySelector('.vpl-center');
    const video = frame.querySelector('video');
    return {
        frame: r(frame), video: r(video), size: frame.dataset.size, shown: frame.dataset.shown, fs: frame.dataset.fs,
        ctl, center: center ? { shown: shown(center), hit: shown(center) && hit(center), rect: r(center) } : null,
        vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        listOverflow: (() => { const l = document.querySelector('.rig-list'); return l.scrollWidth - l.clientWidth; })(),
        objectFit: getComputedStyle(video).objectFit,
    };
}, msg);

/** Bring message `msg`'s player fully into view in the list. */
const reveal = (page, msg) => page.evaluate((msg) => {
    const el = document.querySelector(`[data-msg="${msg}"]`);
    const list = document.querySelector('.rig-list');
    list.scrollTop += el.getBoundingClientRect().top - list.getBoundingClientRect().top - 60;
}, msg);
const media = (page, msg) => page.evaluate((msg) => {
    const v = document.querySelector(`[data-msg="${msg}"] .vpl video`);
    return { muted: v.muted, volume: v.volume, rate: v.playbackRate, defRate: v.defaultPlaybackRate, pitch: v.preservesPitch, paused: v.paused, t: v.currentTime, duration: v.duration };
}, msg);
const center = (rect) => [rect.l + rect.w / 2, rect.t + rect.h / 2];

function checkLayout(tag, L, { coarse, expectSize }) {
    if (!L) { ck(false, `${tag}: player present`); return; }
    if (expectSize) ck(L.size === expectSize, `${tag}: sized as "${expectSize}" by its own width`, `(${L.frame.w.toFixed(1)} px → ${L.size})`);
    for (const k of ['volume', 'speed', 'fullscreen']) {
        const c = L.ctl[k];
        ck(!!c && c.shown, `${tag}: ${k} is in the bar`);
        if (!c || !c.shown) continue;
        const inside = c.rect.l >= L.frame.l - 0.5 && c.rect.r <= L.frame.r + 0.5 && c.rect.t >= L.frame.t - 0.5 && c.rect.b <= L.frame.b + 0.5;
        ck(inside, `${tag}: ${k} sits inside the player`, JSON.stringify(c.rect));
        ck(c.rect.l >= 0 && c.rect.r <= L.vw && c.rect.t >= 0 && c.rect.b <= L.vh, `${tag}: ${k} is inside the window`);
        ck(c.hit, `${tag}: ${k} is what a pointer at its centre hits`);
        if (coarse) ck(c.rect.w >= 44 && c.rect.h >= 44, `${tag}: ${k} is a 44 px touch target`, `${c.rect.w}x${c.rect.h}`);
    }
    ck(L.pageOverflow <= 0 && L.listOverflow <= 0, `${tag}: nothing scrolls sideways (clientWidth)`, `page ${L.pageOverflow}, list ${L.listOverflow}`);
    const tops = ['volume', 'speed', 'fullscreen'].map((k) => L.ctl[k]?.rect.t).filter((t) => t !== undefined);
    ck(tops.length === 3 && Math.max(...tops) - Math.min(...tops) < 1, `${tag}: volume, speed and fullscreen share one row (nothing wrapped)`, JSON.stringify(tops));
}

// ======================= 1280x800, mouse ===================================
{
    const { ctx, page } = await open('desktop', { viewport: { width: 1280, height: 800 } });
    await reveal(page, 'm-portrait');
    await sleep(300);
    const P = await layoutOf(page, 'm-portrait');
    checkLayout('desktop portrait', P, { coarse: false, expectSize: 'narrow' });
    ck(Math.abs(P.frame.w - 176) < 1.5, 'desktop portrait: the box keeps the 176 px minimum (168.75 px by the height cap)', `${P.frame.w}`);
    ck(P.center?.hit, 'desktop portrait: the centre Play button is there and pressable (narrow player)');
    await reveal(page, 'm-tall');
    await sleep(200);
    const T = await layoutOf(page, 'm-tall');
    checkLayout('desktop tall 9:21', T, { coarse: false, expectSize: 'narrow' });
    ck(Math.abs(T.frame.w - 176) < 1.5 && Math.abs(T.frame.h - 300) < 1.5 && T.objectFit === 'contain', 'desktop tall: 176x300 box, picture letterboxed (contain)', `${T.frame.w}x${T.frame.h} ${T.objectFit}`);
    await reveal(page, 'm-land');
    await sleep(200);
    const Lw = await layoutOf(page, 'm-land');
    checkLayout('desktop landscape', Lw, { coarse: false, expectSize: 'wide' });
    ck(!!Lw && await page.evaluate(() => getComputedStyle(document.querySelector('[data-msg="m-land"] .vpl-volume-inline')).display !== 'none'), 'desktop landscape: the volume slider is in the bar (wide)');
    await reveal(page, 'm-portrait');
    await sleep(200);
    await shot(page, '01-desktop-chat');

    // ---- 5. keyboard: from the message box, nothing happens to a player.
    await page.focus('.rig-composer');
    for (const k of ['k', 'm', 'f', ' ', 'ArrowRight', 'ArrowUp']) await page.keyboard.press(k);
    const fromBox = await media(page, 'm-portrait');
    ck(fromBox.paused && !fromBox.muted && fromBox.t === 0 && Math.abs(fromBox.volume - 1) < 1e-6
        && await page.evaluate(() => !document.fullscreenElement && document.querySelector('.rig-composer').value === 'kmf '),
    'keyboard: keys typed in the message box go to the box, never to a player');

    // Tab into the first player: M (muted, ASSERTED before anything plays), K plays.
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.matches('[data-msg="m-portrait"] .vpl'));
    ck(focused, 'keyboard: Tab from the message box reaches the first player');
    const visibleOnFocus = await page.evaluate(() => Number(getComputedStyle(document.querySelector('[data-msg="m-portrait"] .vpl-bar')).opacity) === 1);
    ck(visibleOnFocus, 'keyboard: a focused player shows its controls');
    await page.keyboard.press('m');
    const mutedNow = (await media(page, 'm-portrait')).muted;
    ck(mutedNow, 'keyboard: M mutes (the element is muted before anything plays)');
    if (!mutedNow) throw new Error('SAFETY: refusing to play an unmuted element');
    await page.keyboard.press('k');
    await sleep(400);
    ck(!(await media(page, 'm-portrait')).paused, 'keyboard: K plays (muted)');
    await page.keyboard.press('k');
    const afterK = await media(page, 'm-portrait');
    ck(afterK.paused, 'keyboard: K pauses');
    const t0 = afterK.t;
    await page.keyboard.press('ArrowRight');
    await sleep(150);
    ck(Math.abs((await media(page, 'm-portrait')).t - Math.min(t0 + 5, 6)) < 0.3, 'keyboard: → seeks 5 s', `${t0} → ${(await media(page, 'm-portrait')).t}`);
    await page.keyboard.press('ArrowLeft');
    await sleep(150);
    ck(Math.abs((await media(page, 'm-portrait')).t - Math.max(0, Math.min(t0 + 5, 6) - 5)) < 0.3, 'keyboard: ← seeks back 5 s');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    ck(Math.abs((await media(page, 'm-portrait')).volume - 0.9) < 1e-6, 'keyboard: ↓ lowers this video 5 % a press', `${(await media(page, 'm-portrait')).volume}`);
    await page.keyboard.press('f');
    await sleep(500);
    const fsByKey = await page.evaluate(() => document.fullscreenElement?.matches('[data-msg="m-portrait"] .vpl') === true);
    ck(fsByKey, 'keyboard: F puts the player (its frame) fullscreen');
    await page.keyboard.press('f');
    await sleep(500);
    ck(await page.evaluate(() => !document.fullscreenElement), 'keyboard: F again leaves fullscreen');

    // ---- 2. speed: really twice as fast; 1x as the positive control. Muted.
    const measureRate = async (rate) => {
        await page.evaluate(() => { const v = document.querySelector('[data-msg="m-portrait"] .vpl video'); v.pause(); v.currentTime = 0; });
        const P2 = await layoutOf(page, 'm-portrait');
        await page.mouse.click(...center(P2.ctl.speed.rect));
        await page.waitForSelector('.vpl-panel-speed', { timeout: 3000 });
        const menu = await page.evaluate(() => {
            const m = document.querySelector('.vpl-panel-speed');
            const b = m.getBoundingClientRect();
            return { l: b.left, t: b.top, r: b.right, b: b.bottom, open: m.matches(':popover-open'), vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight };
        });
        ck(menu.open && menu.l >= 0 && menu.t >= 0 && menu.r <= menu.vw && menu.b <= menu.vh, `speed ${rate}×: the menu opens in the top layer, inside the window`, JSON.stringify(menu));
        const item = await page.evaluate((label) => {
            const b = [...document.querySelectorAll('.vpl-panel-speed [role="menuitemradio"]')].find((x) => x.textContent === label);
            const r = b.getBoundingClientRect();
            return [r.left + r.width / 2, r.top + r.height / 2];
        }, `${rate}×`);
        await page.mouse.click(...item);
        const m = await media(page, 'm-portrait');
        ck(m.rate === rate && m.defRate === rate && m.pitch === true, `speed ${rate}×: playbackRate ${rate}, pitch kept`, JSON.stringify(m));
        if (!m.muted) throw new Error('SAFETY: refusing to play an unmuted element');
        await page.evaluate(() => document.querySelector('[data-msg="m-portrait"] .vpl video').play());
        await page.waitForFunction(() => document.querySelector('[data-msg="m-portrait"] .vpl video').currentTime > 0.2, null, { timeout: 5000 });
        const a = await page.evaluate(() => [document.querySelector('[data-msg="m-portrait"] .vpl video').currentTime, performance.now()]);
        await sleep(1500);
        const b = await page.evaluate(() => [document.querySelector('[data-msg="m-portrait"] .vpl video').currentTime, performance.now()]);
        await page.evaluate(() => document.querySelector('[data-msg="m-portrait"] .vpl video').pause());
        return (b[0] - a[0]) / ((b[1] - a[1]) / 1000);
    };
    const r1 = await measureRate(1);
    ck(r1 > 0.75 && r1 < 1.25, 'speed 1× (positive control): plays at real time', r1.toFixed(2));
    const r2 = await measureRate(2);
    ck(r2 > 1.6 && r2 < 2.4, 'speed 2×: plays twice as fast', r2.toFixed(2));

    // ---- 3. volume x Output Volume, through the panel, by mouse.
    await page.evaluate(() => { const s = window.__rig.loadSettings(); window.__rig.saveSettings({ ...s, outputVolume: 50 }); });
    await page.waitForFunction(() => Math.abs(document.querySelector('[data-msg="m-portrait"] .vpl video').volume - 0.45) < 1e-3, null, { timeout: 1000, polling: 'raf' }).catch(() => {});
    let m = await media(page, 'm-portrait');
    ck(Math.abs(m.volume - 0.9 * 0.5) < 1e-3, 'volume: the element plays at this video (90 %) x Output Volume (50 %)', `${m.volume}`);
    const P3 = await layoutOf(page, 'm-portrait');
    await page.mouse.click(...center(P3.ctl.volume.rect));
    await page.waitForSelector('.vpl-panel-volume', { timeout: 3000 });
    const vp = await page.evaluate(() => {
        const p = document.querySelector('.vpl-panel-volume');
        const s = p.querySelector('[role="slider"]').getBoundingClientRect();
        const b = p.getBoundingClientRect();
        return { panel: { l: b.left, t: b.top, r: b.right, b: b.bottom }, slider: { l: s.left, t: s.top, w: s.width, h: s.height }, text: p.textContent, vw: document.documentElement.clientWidth };
    });
    ck(vp.panel.l >= 0 && vp.panel.r <= vp.vw && vp.panel.t >= 0, 'volume: the panel is inside the window', JSON.stringify(vp.panel));
    ck(/Output Volume in Settings: 50%/.test(vp.text), 'volume: the panel says what the master is');
    await page.mouse.click(vp.slider.l + vp.slider.w * 0.4, vp.slider.t + vp.slider.h / 2);
    const slider2 = await page.evaluate(() => { const r = document.querySelector('.vpl-panel-volume [role="slider"]').getBoundingClientRect(); return { l: r.left, w: r.width }; });
    ck(Math.abs(slider2.l - vp.slider.l) < 0.5 && Math.abs(slider2.w - vp.slider.w) < 0.5, 'volume: the slider did not move when Unmute became Mute under the press', `${JSON.stringify(vp.slider)} → ${JSON.stringify(slider2)}`);
    m = await media(page, 'm-portrait');
    ck(!m.muted && Math.abs(m.volume - 0.4 * 0.5) < 0.02, 'volume: the slider at 40 % → element 0.4 x 0.5 (and a slider move unmutes)', `${m.volume} muted=${m.muted}`);
    // Settings moved: the player follows within a frame or two (React's own
    // scheduling), with no reload and no click.
    const t0m = Date.now();
    await page.evaluate(() => { const s = window.__rig.loadSettings(); window.__rig.saveSettings({ ...s, outputVolume: 100 }); });
    const followed = await page.waitForFunction(() => Math.abs(document.querySelector('[data-msg="m-portrait"] .vpl video').volume - 0.4) < 0.02, null, { timeout: 1000, polling: 'raf' }).then(() => true, () => false);
    ck(followed, 'volume: a Settings change reaches the player at once', `${(await media(page, 'm-portrait')).volume} after ${Date.now() - t0m} ms`);
    ck(await page.evaluate(() => window.__rig.loadSettings().outputVolume === 100), 'volume: the video slider never wrote the master');
    await page.keyboard.press('Escape');
    ck(await page.evaluate(() => !document.querySelector('.vpl-panel-volume')), 'volume: Esc closes the panel');
    // Back to silence before anything else happens.
    await page.evaluate(() => { const f = document.querySelector('[data-msg="m-portrait"] .vpl'); f.focus(); });
    await page.keyboard.press('m');
    ck((await media(page, 'm-portrait')).muted, 'volume: muted again');

    // ---- 4. fullscreen by mouse: the frame fills the window, controls usable.
    await reveal(page, 'm-land');
    await sleep(200);
    const L0 = await layoutOf(page, 'm-land');
    await page.mouse.click(...center(L0.ctl.fullscreen.rect));
    await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 3000 }).catch(() => {});
    await sleep(400);
    const F = await layoutOf(page, 'm-land');
    const isFrame = await page.evaluate(() => document.fullscreenElement?.matches('[data-msg="m-land"] .vpl') === true);
    ck(isFrame && F.fs === 'native', 'fullscreen: the FRAME is the fullscreen element (Púca\'s controls go with it)');
    ck(Math.abs(F.frame.w - 1280) < 1 && Math.abs(F.frame.h - 800) < 1 && Math.abs(F.video.w - 1280) < 1, 'fullscreen: it fills the window', `${F.frame.w}x${F.frame.h}`);
    checkLayout('fullscreen desktop', F, { coarse: false, expectSize: 'wide' });
    await page.mouse.move(640, 400);
    await page.mouse.click(...center(F.ctl.speed.rect));
    await sleep(200);
    const fsMenu = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.vpl-panel-speed [role="menuitemradio"]')];
        return items.map((b) => { const r = b.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return at === b; });
    });
    ck(fsMenu.length === 6 && fsMenu.every(Boolean), 'fullscreen: the speed menu opens ABOVE the fullscreen player and every speed is pressable', JSON.stringify(fsMenu));
    await shot(page, '02-desktop-fullscreen-speed-menu');
    await page.keyboard.press('Escape'); // closes the menu first
    await sleep(150);
    ck(await page.evaluate(() => !document.querySelector('.vpl-panel-speed') && !!document.fullscreenElement), 'fullscreen: Esc closes the open menu first, still fullscreen');
    const F2 = await layoutOf(page, 'm-land');
    await page.mouse.click(...center(F2.ctl.fullscreen.rect));
    await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 }).catch(() => {});
    await sleep(300);
    const L1 = await layoutOf(page, 'm-land');
    ck(L1.fs === 'none' && Math.abs(L1.frame.w - L0.frame.w) < 1 && Math.abs(L1.frame.h - L0.frame.h) < 1, 'fullscreen: Exit puts it back in its box, same size', `${L0.frame.w}x${L0.frame.h} → ${L1.frame.w}x${L1.frame.h}`);

    // ---- 7. a spoilered video: not focusable until revealed.
    await reveal(page, 'm-spoil');
    await sleep(200);
    const spoil = await page.evaluate(() => {
        const f = document.querySelector('[data-msg="m-spoil"] .vpl');
        f.focus();
        const btn = f.querySelector('.vpl-bar button');
        btn.focus();
        return { inert: f.inert, focused: document.activeElement === f || document.activeElement === btn };
    });
    ck(spoil.inert && !spoil.focused, 'spoiler: covered, nothing in the player can take focus');
    await page.mouse.click(...center((await layoutOf(page, 'm-spoil')).frame));
    await sleep(200);
    const revealed = await page.evaluate(() => {
        const f = document.querySelector('[data-msg="m-spoil"] .vpl');
        return { revealed: !!f.closest('.spoiler.revealed'), inert: f.inert, v: f.querySelector('video').paused };
    });
    ck(revealed.revealed && !revealed.inert && revealed.v, 'spoiler: the first click reveals it (and plays nothing); the player is usable');
    ck((await layoutOf(page, 'm-spoil')).ctl.speed.hit, 'spoiler: revealed, its speed button is pressable');

    // ---- 8. themes x contrast: the panels' text on their surface, the bar's ink.
    const lum = (rgb) => {
        const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map((x) => { const c = Number(x) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const themes = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
    await reveal(page, 'm-land');
    await sleep(200);
    const poor = [];
    for (const theme of themes) {
        for (const hc of ['normal', 'high']) {
            await page.evaluate(([theme, hc]) => {
                document.documentElement.setAttribute('data-theme', theme);
                document.documentElement.setAttribute('data-contrast', hc);
            }, [theme, hc]);
            await sleep(250);
            const Lt = await layoutOf(page, 'm-land');
            await page.mouse.click(...center(Lt.ctl.speed.rect));
            await page.waitForSelector('.vpl-panel-speed', { timeout: 3000 });
            await sleep(150);
            const c = await page.evaluate(() => {
                const opaque = (el) => {
                    for (let e = el; e; e = e.parentElement) {
                        const bg = getComputedStyle(e).backgroundColor;
                        const m = bg.match(/[\d.]+/g);
                        if (m && (m[3] === undefined || Number(m[3]) >= 0.99)) return bg;
                    }
                    return 'rgb(0, 0, 0)';
                };
                const panel = document.querySelector('.vpl-panel-speed');
                const items = [...panel.querySelectorAll('[role="menuitemradio"]')];
                const plain = items.find((i) => i.getAttribute('aria-checked') === 'false');
                const checked = items.find((i) => i.getAttribute('aria-checked') === 'true');
                const btn = document.querySelector('[data-msg="m-land"] .vpl-speed');
                return {
                    item: [getComputedStyle(plain).color, opaque(panel)],
                    checked: [getComputedStyle(checked).color, opaque(panel)],
                    barInk: [getComputedStyle(btn).color, 'rgb(0, 0, 0)'],
                };
            });
            for (const [k, [fg, bg]] of Object.entries(c)) {
                const r = contrast(fg, bg);
                const min = 4.5;
                if (r < min) poor.push(`${theme}/${hc} ${k} ${r.toFixed(2)} (${fg} on ${bg})`);
            }
            const fr = (await layoutOf(page, 'm-land')).frame;
            await shot(page, `10-theme-${theme}-${hc}`, { x: Math.max(0, fr.l - 20), y: Math.max(0, fr.t - 200), width: Math.min(560, 1280 - fr.l + 20), height: Math.min(fr.h + 240, 800 - Math.max(0, fr.t - 200)) });
            await page.keyboard.press('Escape');
            await sleep(100);
        }
    }
    ck(poor.length === 0, 'themes: menu text, the chosen speed and the bar\'s ink keep their contrast in all eight themes, with and without high contrast', poor.join('; '));
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.setAttribute('data-contrast', 'normal'); });
    await ctx.close();
}

// ======================= 390x844, touchscreen ==============================
{
    const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
    const { ctx, page } = await open('phone', phone);
    await reveal(page, 'm-portrait');
    await sleep(300);
    const P = await layoutOf(page, 'm-portrait');
    checkLayout('phone portrait', P, { coarse: true, expectSize: 'narrow' });
    ck(P.center?.hit && P.center.rect.w >= 44, 'phone portrait: the centre Play button is a 44 px target');
    checkLayout('phone tall 9:21', await layoutOf(page, 'm-tall'), { coarse: true, expectSize: 'narrow' });
    await reveal(page, 'm-land');
    await sleep(200);
    const Lp = await layoutOf(page, 'm-land');
    checkLayout('phone landscape', Lp, { coarse: true });
    ck(Lp.frame.r <= 390, 'phone landscape: the player fits the column', `${Lp.frame.l}..${Lp.frame.r}`);
    await reveal(page, 'm-task');
    await sleep(200);
    const Tk = await layoutOf(page, 'm-task');
    checkLayout('phone Task video', Tk, { coarse: true, expectSize: 'narrow' });
    ck(Math.abs(Tk.frame.w - 240) < 1 && Math.abs(Tk.frame.h - 160) < 1 && Tk.objectFit === 'contain', "phone Task video: a 240x160 tile, the portrait picture letterboxed", `${Tk.frame.w}x${Tk.frame.h}`);
    await shot(page, '24-phone-task-video');
    await shot(page, '20-phone-chat');

    // ---- 6. touch: a tap on the picture shows/hides the controls, never plays.
    await reveal(page, 'm-portrait');
    await sleep(200);
    const P1 = await layoutOf(page, 'm-portrait');
    await page.touchscreen.tap(P1.video.l + 20, P1.video.t + 20);
    await sleep(200);
    let s = await layoutOf(page, 'm-portrait');
    ck(s.shown === 'false' && (await media(page, 'm-portrait')).paused, 'touch: a tap on the picture hides the controls and plays nothing');
    await page.touchscreen.tap(P1.video.l + 20, P1.video.t + 20);
    await sleep(200);
    s = await layoutOf(page, 'm-portrait');
    ck(s.shown === 'true' && (await media(page, 'm-portrait')).paused, 'touch: a second tap shows them again, still nothing playing');

    // Speed menu by touch, inside the 390 px column, 44 px items.
    await page.touchscreen.tap(...center(s.ctl.speed.rect));
    await page.waitForSelector('.vpl-panel-speed', { timeout: 3000 });
    const pm = await page.evaluate(() => {
        const m = document.querySelector('.vpl-panel-speed').getBoundingClientRect();
        const items = [...document.querySelectorAll('.vpl-panel-speed [role="menuitemradio"]')].map((b) => b.getBoundingClientRect());
        return { l: m.left, r: m.right, t: m.top, b: m.bottom, minH: Math.min(...items.map((r) => r.height)), minW: Math.min(...items.map((r) => r.width)), vw: document.documentElement.clientWidth };
    });
    ck(pm.l >= 0 && pm.r <= pm.vw && pm.t >= 0, 'touch: the speed menu fits the 390 px window', JSON.stringify(pm));
    ck(pm.minH >= 44 && pm.minW >= 44, 'touch: every speed is a 44 px target', `${pm.minW}x${pm.minH}`);
    await shot(page, '21-phone-speed-menu');
    const tapLook = await page.evaluate(() => {
        const b = getComputedStyle(document.querySelector('[data-msg="m-portrait"] .vpl-speed'));
        const v = getComputedStyle(document.querySelector('[data-msg="m-portrait"] .vpl video'));
        return { bg: b.backgroundColor, videoTap: v.webkitTapHighlightColor };
    });
    ck(/rgba\(0, 0, 0, 0\)/.test(tapLook.bg), 'touch: a tapped button keeps no hover fill (no sticky hover)', JSON.stringify(tapLook));
    ck(/rgba\(0, 0, 0, 0\)/.test(tapLook.videoTap), 'touch: a tap on the picture flashes nothing over it', JSON.stringify(tapLook));
    const item15 = await page.evaluate(() => { const b = [...document.querySelectorAll('.vpl-panel-speed [role="menuitemradio"]')].find((x) => x.textContent === '1.5×').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
    await page.touchscreen.tap(...item15);
    ck((await media(page, 'm-portrait')).rate === 1.5, 'touch: tapping 1.5× sets it');
    // Volume panel by touch.
    s = await layoutOf(page, 'm-portrait');
    await page.touchscreen.tap(...center(s.ctl.volume.rect));
    await page.waitForSelector('.vpl-panel-volume', { timeout: 3000 });
    const pv = await page.evaluate(() => {
        const p = document.querySelector('.vpl-panel-volume').getBoundingClientRect();
        const sl = document.querySelector('.vpl-panel-volume [role="slider"]').getBoundingClientRect();
        const mute = document.querySelector('.vpl-panel-mute').getBoundingClientRect();
        return { l: p.left, r: p.right, t: p.top, sliderH: sl.height, muteH: mute.height, sl: { l: sl.left, t: sl.top, w: sl.width, h: sl.height }, vw: document.documentElement.clientWidth };
    });
    ck(pv.l >= 0 && pv.r <= pv.vw && pv.t >= 0, 'touch: the volume panel fits the 390 px window', JSON.stringify(pv));
    ck(pv.sliderH >= 44 && pv.muteH >= 44, 'touch: the volume slider and Mute are 44 px tall');
    await page.touchscreen.tap(pv.sl.l + pv.sl.w * 0.3, pv.sl.t + pv.sl.h / 2);
    ck(Math.abs((await media(page, 'm-portrait')).volume - 0.3) < 0.03, 'touch: a tap on the volume slider sets the level', `${(await media(page, 'm-portrait')).volume}`);
    await shot(page, '22-phone-volume-panel');
    await page.touchscreen.tap(195, 20); // outside: closes it
    await sleep(150);
    ck(await page.evaluate(() => !document.querySelector('.vpl-panel-volume')), 'touch: a tap elsewhere closes the panel');

    // A vertical swipe starting on the timeline scrolls the chat, never seeks.
    const cdp = await ctx.newCDPSession(page);
    const swipe = async (x0, y0, x1, y1, steps = 8) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
        for (let i = 1; i <= steps; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }] });
            await sleep(16);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(400);
    };
    await page.evaluate(() => { const v = document.querySelector('[data-msg="m-portrait"] .vpl video'); v.currentTime = 1; });
    await sleep(200);
    s = await layoutOf(page, 'm-portrait');
    const seekRect = await page.evaluate(() => { const r = document.querySelector('[data-msg="m-portrait"] [role="slider"][aria-label="Seek"]').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
    const scrollBefore = await page.evaluate(() => document.querySelector('.rig-list').scrollTop);
    await swipe(seekRect.l + seekRect.w * 0.7, seekRect.t + seekRect.h / 2, seekRect.l + seekRect.w * 0.72, seekRect.t + seekRect.h / 2 - 220);
    const scrollAfter = await page.evaluate(() => document.querySelector('.rig-list').scrollTop);
    const tAfterSwipe = (await media(page, 'm-portrait')).t;
    ck(scrollAfter - scrollBefore > 80, 'touch (positive control): the vertical swipe scrolled the chat', `${scrollBefore} → ${scrollAfter}`);
    ck(Math.abs(tAfterSwipe - 1) < 0.05, 'touch: …and did NOT seek the video it started on', `t=${tAfterSwipe}`);
    // Positive control: a sideways drag on the timeline does seek.
    await reveal(page, 'm-portrait');
    await sleep(300);
    const seek2 = await page.evaluate(() => { const r = document.querySelector('[data-msg="m-portrait"] [role="slider"][aria-label="Seek"]').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
    await swipe(seek2.l + seek2.w * 0.2, seek2.t + seek2.h / 2, seek2.l + seek2.w * 0.75, seek2.t + seek2.h / 2 + 2);
    const tDrag = (await media(page, 'm-portrait')).t;
    ck(Math.abs(tDrag - 0.75 * 6) < 0.6, 'touch (positive control): a sideways drag on the timeline seeks', `t=${tDrag}`);

    // A TAP on the centre Play plays (muted, asserted first). Found on the
    // Android emulator: with the button centred by a CSS transform, the
    // touch went to the button but Chromium's tap gesture sent the click to
    // the <video> behind it, so Play only toggled the controls.
    await page.evaluate(() => document.querySelector('[data-msg="m-portrait"] .vpl').focus());
    if (!(await media(page, 'm-portrait')).muted) await page.keyboard.press('m');
    const mutedForTap = (await media(page, 'm-portrait')).muted;
    ck(mutedForTap, 'touch: muted before the centre Play is tapped');
    if (!mutedForTap) throw new Error('SAFETY: refusing to play an unmuted element');
    await page.evaluate(() => document.querySelector('[data-msg="m-portrait"] .vpl').blur());
    s = await layoutOf(page, 'm-portrait');
    if (s.shown !== 'true') { await page.touchscreen.tap(s.video.l + 20, s.video.t + 20); await sleep(200); s = await layoutOf(page, 'm-portrait'); }
    await page.evaluate(() => { window.__clicks = []; document.addEventListener('click', (e) => window.__clicks.push(e.target.closest('button')?.getAttribute('aria-label') ?? e.target.tagName), { capture: true, once: true }); });
    await page.touchscreen.tap(...center(s.center.rect));
    await sleep(500);
    const tapped = await page.evaluate(() => window.__clicks[0]);
    const afterTap = await media(page, 'm-portrait');
    ck(tapped === 'Play' && !afterTap.paused && afterTap.muted, 'touch: a tap on the centre Play reaches the button and plays (muted)', `click went to ${tapped}, paused=${afterTap.paused}`);
    await page.evaluate(() => document.querySelector('[data-msg="m-portrait"] .vpl video').pause());
    await sleep(200);

    // Fullscreen by touch (a mobile browser: the Fullscreen API).
    s = await layoutOf(page, 'm-portrait');
    await page.touchscreen.tap(...center(s.ctl.fullscreen.rect));
    await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 3000 }).catch(() => {});
    await sleep(400);
    const PF = await layoutOf(page, 'm-portrait');
    ck(PF.fs === 'native' && Math.abs(PF.frame.w - 390) < 1 && Math.abs(PF.frame.h - 844) < 1, 'phone browser: fullscreen fills the screen', `${PF.frame.w}x${PF.frame.h} ${PF.fs}`);
    checkLayout('phone fullscreen', PF, { coarse: true });
    await shot(page, '23-phone-fullscreen');
    await page.touchscreen.tap(...center(PF.ctl.fullscreen.rect));
    await sleep(400);
    ck(await page.evaluate(() => !document.fullscreenElement), 'phone browser: Exit full screen by touch');
    await ctx.close();
}

// ============ in-app fullscreen (what the Android/iOS app uses) =============
{
    // No Fullscreen API here, as in the app (elementFullscreen.ts): the
    // player fills the app's view in the top layer instead.
    const { ctx, page } = await open('in-app', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, () => {
        delete Element.prototype.requestFullscreen;
        delete Element.prototype.webkitRequestFullscreen;
        delete HTMLElement.prototype.requestFullscreen;
    });
    await reveal(page, 'm-tall');
    await sleep(300);
    const T0 = await layoutOf(page, 'm-tall');
    await page.touchscreen.tap(...center(T0.ctl.fullscreen.rect));
    await sleep(400);
    const T1 = await layoutOf(page, 'm-tall');
    const top = await page.evaluate(() => {
        const f = document.querySelector('[data-msg="m-tall"] .vpl');
        const at = document.elementFromPoint(195, 422);
        const corner = document.elementFromPoint(2, 2);
        return { popoverOpen: f.matches(':popover-open'), centreInside: f.contains(at), cornerInside: f.contains(corner) };
    });
    ck(T1.fs === 'app' && top.popoverOpen, 'in-app fullscreen: the frame is in the top layer (Popover API, not moved in the DOM)');
    ck(Math.abs(T1.frame.l) < 1 && Math.abs(T1.frame.t) < 1 && Math.abs(T1.frame.w - 390) < 1 && Math.abs(T1.frame.h - 844) < 1, 'in-app fullscreen: covers the whole window', JSON.stringify(T1.frame));
    ck(top.centreInside && top.cornerInside, 'in-app fullscreen: nothing of the chat is on top of it');
    checkLayout('in-app fullscreen', T1, { coarse: true });
    await page.touchscreen.tap(...center(T1.ctl.speed.rect));
    await page.waitForSelector('.vpl-panel-speed', { timeout: 3000 });
    const above = await page.evaluate(() => [...document.querySelectorAll('.vpl-panel-speed [role="menuitemradio"]')].every((b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b; }));
    ck(above, 'in-app fullscreen: the speed menu opens above it, every speed pressable');
    await shot(page, '30-in-app-fullscreen-menu');
    await page.keyboard.press('Escape'); // the menu
    await page.keyboard.press('Escape'); // the fullscreen
    await sleep(300);
    const T2 = await layoutOf(page, 'm-tall');
    ck(T2.fs === 'none' && Math.abs(T2.frame.w - T0.frame.w) < 1, 'in-app fullscreen: Esc leaves it, back in its box');
    await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed; ${shots} screenshots in ${outdir}`);
process.exit(fail ? 1 : 0);
