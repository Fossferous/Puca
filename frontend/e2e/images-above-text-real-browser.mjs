// A message's pictures and videos ABOVE its words, in a real browser: the
// real MessageContent in the real message row (Chat.tsx's markup: avatar,
// author line, .message-content) with the app's stylesheets, the attachments
// sealed by the real upload seal and served as /files serves them, decrypted
// by the real attachment cache. At 1280x800 with a mouse and at 390x844 with
// a touchscreen, on all eight themes with and without high contrast.
//
// WHY THIS EXISTS. The owner, 2026-11-12, with a screenshot of a message
// whose picture stood to the RIGHT of its words, the words on the picture's
// bottom edge: "images should be above the message". The composer sends
// `words ![photo](ref)` on one line and a picture is an inline span, so the
// browser laid the two out as one line of text (components/messageMediaFirst.ts).
// jsdom lays nothing out; only a real engine says where a picture lands.
// Checked, for each message, from the boxes the engine drew:
//
//   1. every picture, video and spoilered picture is below the author line
//      and wholly ABOVE the first line of the words, starting at the column's
//      left edge; the words start at the column's left too, and a long message
//      runs across the column (its full width, nothing beside it);
//   2. several pictures keep the order they were sent in; a file chip sent
//      with a picture stays after the words, as before;
//   3. a spoilered picture is still covered (blurred, SPOILER) until a real
//      click or tap reveals it, and is still above the words after;
//   4. CONTROLS that must not change: a picture with no words, and words with
//      no picture, are drawn exactly where the old layout drew them;
//   5. nothing scrolls sideways at 390 px;
//   6. NEGATIVE CONTROL: the same messages through a MessageContent built
//      without the change (messageMediaFirst stubbed out) must FAIL check 1
//      for the owner's message and the video: the picture beside the words.
//
// Writes before/after screenshots to [outdir]. Silent and headless
// (--mute-audio; the video fixture has no audio track and nothing plays it).
//
//   cd frontend && node e2e/images-above-text-real-browser.mjs [outdir]
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
const outdir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'puca-images-above-'));
fs.mkdirSync(outdir, { recursive: true });
const VIDEO = fs.readFileSync(path.join(here, 'assets', 'video-controls', 'landscape-480x270.webm'));
const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
const CONTRASTS = ['normal', 'high'];

// ---- the page --------------------------------------------------------------
const entry = `
import './index.css';
import './mobile.css';
import './components/Chat.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MessageContent } from './components/MessageContent';
import { sealFileForUpload } from './api/attachments';
import { __setPlaintextWorkerFactory } from './api/plaintextHost';
import { __setCipherWriterFactory } from './api/cipherStore';

__setPlaintextWorkerFactory(() => new Worker('/w/plaintext.js', { type: 'module' }));
__setCipherWriterFactory(() => new Worker('/w/writer.js', { type: 'module' }));

const root = createRoot(document.getElementById('root'));
let uploads = 0;
/** Seal a file as the composer does and hand the ciphertext to the rig's
 *  /files, as an upload would: the markdown the composer appends. */
async function send(file) {
    const sealed = await sealFileForUpload(file);
    const id = 'f' + (++uploads);
    await fetch('/rig-upload/' + id, { method: 'POST', body: sealed.blob });
    const href = 'sovereign-enc:' + id + '?k=' + sealed.key + '&m=' + encodeURIComponent(sealed.mime);
    return (sealed.mime.startsWith('image/') ? '!' : '') + '[' + sealed.name + '](' + href + ')';
}
/** A picture with something to see in it (a game-ish scene), drawn here. */
async function picture(name, w, h, hue) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'hsl(' + hue + ',45%,35%)'); g.addColorStop(1, 'hsl(' + ((hue + 60) % 360) + ',50%,22%)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(255,255,255,0.18)';
    for (let i = 0; i < 6; i++) x.fillRect((i * w) / 6 + 8, h * 0.15, w / 9, h * 0.25);
    x.strokeStyle = '#2f2'; x.lineWidth = Math.max(3, w / 120);
    x.beginPath(); x.moveTo(w * 0.3, h * 0.8); x.lineTo(w * 0.45, h * 0.7); x.lineTo(w * 0.62, h * 0.78); x.lineTo(w * 0.47, h * 0.9); x.closePath(); x.stroke();
    x.fillStyle = '#e6c27a'; x.beginPath(); x.arc(w * 0.47, h * 0.5, Math.min(w, h) * 0.08, 0, Math.PI * 2); x.fill();
    return new File([await new Promise((r) => c.toBlob(r, 'image/png'))], name, { type: 'image/png' });
}
window.__rig = {
    send,
    picture,
    video: async () => new File([await (await fetch('/asset/landscape.webm')).arrayBuffer()], 'clip.webm', { type: 'video/webm' }),
    text: (name) => new File([new TextEncoder().encode('notes\\n')], name, { type: 'text/plain' }),
    /** The channel's messages, in the real row markup (Chat.tsx). */
    show(msgs) {
        flushSync(() => root.render(
            <div className="messages-container rig-list">
                {msgs.map((m) => (
                    <div className="message" key={m.id} data-msg={m.id}>
                        <div className="message-avatar">M</div>
                        <div className="message-body">
                            <div className="message-header">
                                <span className="message-author">Mick</span>
                                <span className="message-time">Today at 01:22</span>
                            </div>
                            <div className="message-content"><MessageContent content={m.content} members={[]} /></div>
                        </div>
                    </div>
                ))}
            </div>,
        ));
    },
};
`;
const RIG_CSS = `
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg-primary); color: var(--text-normal); }
.rig-list { height: 100%; box-sizing: border-box; }
`;

const stored = new Map();
const server = http.createServer((req, res) => {
    const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    const url = req.url ?? '/';
    if (url === '/new.js') return send('text/javascript', bundles.new);
    if (url === '/old.js') return send('text/javascript', bundles.old);
    if (url === '/main.css') return send('text/css', bundles.css + RIG_CSS);
    if (url === '/w/plaintext.js') return send('text/javascript', bundles.plaintext);
    if (url === '/w/writer.js') return send('text/javascript', bundles.writer);
    if (url === '/asset/landscape.webm') return send('video/webm', VIDEO);
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
    const page = /^\/(new|old)$/.exec(url);
    if (page) {
        return send('text/html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>images above text rig</title><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script src="/${page[1]}.js"></script></body></html>`);
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
/** The negative control's MessageContent: the same component with the split
 *  taken out, which is the layout the app had before. */
let stubbed = 0;
const withoutTheChange = {
    name: 'without-media-first',
    setup(b) {
        b.onResolve({ filter: /\/messageMediaFirst$/ }, () => ({ path: 'stub', namespace: 'old-layout' }));
        b.onLoad({ filter: /.*/, namespace: 'old-layout' }, () => { stubbed++; return { contents: 'export const liftMediaAbove = () => null; export const encAttachmentKind = () => "file";', loader: 'js' }; });
    },
};
const bundle = async (old) => build({
    stdin: { contents: entry, resolveDir: src, loader: 'tsx', sourcefile: 'entry.tsx' },
    bundle: true, write: false, outdir: path.join(here, '.rig-out'), format: 'iife', platform: 'browser', jsx: 'automatic',
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.svg': 'empty', '.png': 'empty', '.mp3': 'empty', '.ogg': 'empty', '.wasm': 'empty' },
    define: {
        'process.env.NODE_ENV': '"production"',
        __RC_ENABLED__: 'true',
        __APP_VERSION__: '"0.0.0-rig"',
        'import.meta.env': JSON.stringify({ VITE_API_URL: origin, DEV: false, PROD: true, MODE: 'production' }),
    },
    plugins: old ? [stubs, withoutTheChange] : [stubs], logOverride: { 'empty-import-meta': 'silent' }, logLevel: 'error',
});
const [newBuild, oldBuild] = await Promise.all([bundle(false), bundle(true)]);
const workerBuild = async (f) => (await build({ entryPoints: [path.join(src, 'api', f)], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'error' })).outputFiles[0].text;
const js = (b) => b.outputFiles.find((f) => f.path.endsWith('.js')).text;
const bundles = {
    new: js(newBuild),
    old: js(oldBuild),
    css: newBuild.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '',
    plaintext: await workerBuild('plaintextHost.worker.ts'),
    writer: await workerBuild('cipherWriter.worker.ts'),
};
if (!bundles.css.includes('.message-media')) throw new Error('rig: Chat.css (with .message-media) did not make it into the bundle');
if (stubbed !== 1 || bundles.old.includes('function liftMediaAbove')) throw new Error('rig: the negative control still has the change in it');
if (!bundles.new.includes('function liftMediaAbove')) throw new Error('rig: the change is not in the bundle under test');

// ---- checks ----------------------------------------------------------------
let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};
const CHANNEL = process.env.CHANNEL || 'msedge';
// Edge 157 upgrades http:// navigations to https:// by default; this rig is http on loopback.
const NO_HTTPS_FIRST = '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForTypicallySecureUsers,'
    + 'HttpsFirstModeIncognito,HttpsFirstBalancedMode,HttpsFirstModeV2ForEngagedSites,HttpsFirstModeForAdvancedProtectionUsers';
const browser = await chromium.launch({ headless: true, ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }), args: ['--mute-audio', NO_HTTPS_FIRST] });
console.log(`engine: ${CHANNEL} ${browser.version()}`);

const SIZES = [
    { name: 'desktop', opts: { viewport: { width: 1280, height: 800 } } },
    { name: 'phone', opts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
];
const WORDS = 'peep the player that just gave me her adamant axe for free';
const LONG = 'so I was standing by the fence near the bank when this player walks up, trades me, and just puts her adamant axe in the window for nothing at all, no catch, then logs out before I can even say thanks, which is honestly the nicest thing that has happened to me in this game all week';

async function open(which, size) {
    const ctx = await browser.newContext(size.opts);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { fail++; console.log(`FAIL [${which} ${size.name}] page error`, e.message); });
    await page.addInitScript(() => { localStorage.setItem('auth_token', 'rig-token'); });
    await page.goto(`${origin}/${which}`);
    await page.waitForFunction(() => !!window.__rig);
    await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.documentElement.setAttribute('data-contrast', 'normal');
    });
    return { ctx, page };
}

/** Seal the attachments once, in a page, and build the messages from them. */
async function makeMessages(page) {
    return page.evaluate(async () => {
        const r = window.__rig;
        const square = await r.send(await r.picture('axe.png', 600, 600, 90));
        const wide = await r.send(await r.picture('bank.png', 800, 450, 200));
        const a = await r.send(await r.picture('first.png', 360, 240, 20));
        const b = await r.send(await r.picture('second.png', 360, 240, 280));
        const video = await r.send(await r.video());
        const file = await r.send(r.text('notes.txt'));
        return { square, wide, a, b, video, file };
    });
}
const messagesFrom = (f) => [
    { id: 'owner', content: `${WORDS} ${f.square}`, media: 1 },
    { id: 'long', content: `${LONG} ${f.wide}`, media: 1, long: true },
    { id: 'two', content: `two of them ${f.a} ${f.b}`, media: 2 },
    { id: 'spoiler', content: `careful, spoilers ||${f.square}||`, media: 1, spoiler: true },
    { id: 'video', content: `look at this ${f.video}`, media: 1, video: true },
    { id: 'file', content: `here you go ${f.wide} ${f.file}`, media: 1, chip: true },
    { id: 'alone', content: f.square, media: 1, control: true },
    { id: 'words', content: 'just words, nothing else', media: 0, control: true },
];

/** Scroll message `id` into view, wait until what it shows has arrived, and
 *  read where the engine put its parts (CSS px, viewport). */
async function measure(page, m) {
    await page.evaluate((id) => document.querySelector(`[data-msg="${id}"]`).scrollIntoView({ block: 'center' }), m.id);
    if (m.media) {
        await page.waitForFunction(({ id, video, n }) => {
            const row = document.querySelector(`[data-msg="${id}"]`);
            if (video) return !!row.querySelector('.message-video video');
            const imgs = [...row.querySelectorAll('.message-image img')];
            return imgs.length === n && imgs.every((i) => i.complete && i.naturalWidth > 0);
        }, { id: m.id, video: !!m.video, n: m.media }, { timeout: 20000 }).catch(() => {});
    }
    return page.evaluate((id) => {
        const row = document.querySelector(`[data-msg="${id}"]`);
        const content = row.querySelector('.message-content');
        const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
        // A spoiler holding a picture is the picture's box on screen (its cover); otherwise the
        // picture itself, or the video's whole card (player and its Download chip).
        const media = [];
        for (const el of content.querySelectorAll('.message-image img, .message-video')) {
            const sp = el.closest('.spoiler');
            const target = sp ?? el;
            if (!media.some((x) => x.el === target)) media.push({ el: target, kind: sp ? 'spoiler' : el.tagName === 'IMG' ? 'img' : 'video', name: el.getAttribute('alt') ?? '' });
        }
        // The words: every run of text outside the pictures and chips, line by line.
        const lines = [];
        const walk = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (!n.textContent.trim()) continue;
            if (n.parentElement.closest('.message-image, .message-video, .message-attachment, .spoiler, .attachment-loading')) continue;
            const range = document.createRange(); range.selectNodeContents(n);
            for (const r of range.getClientRects()) if (r.width > 0) lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height });
        }
        const chip = content.querySelector(':scope .message-attachment:not(.message-video .message-attachment)');
        const spoiler = content.querySelector('.spoiler');
        const spoilerImg = spoiler?.querySelector('img');
        const header = row.querySelector('.message-header');
        const list = document.querySelector('.rig-list');
        return {
            content: box(content),
            header: box(header),
            media: media.map((m) => ({ kind: m.kind, name: m.name, ...box(m.el) })),
            lines,
            chip: chip ? box(chip) : null,
            hasBlock: !!content.querySelector('.message-media'),
            spoiler: spoiler ? { revealed: spoiler.classList.contains('revealed'), filter: spoilerImg ? getComputedStyle(spoilerImg).filter : '', label: getComputedStyle(spoiler, '::after').content, ...box(spoiler) } : null,
            overflow: { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, list: list.scrollWidth - list.clientWidth },
        };
    }, m.id);
}

/** Check 1 for one message: every picture under the author line and above
 *  every line of the words, at the column's left; the words at the column's
 *  left. Returns the reasons it does not hold ([] = holds). */
function aboveTheWords(m, g) {
    const why = [];
    if (g.media.length !== m.media) why.push(`${g.media.length} pictures on screen, expected ${m.media}`);
    if (g.lines.length === 0) why.push('no words found');
    const wordsTop = Math.min(...g.lines.map((l) => l.top));
    const wordsLeft = Math.min(...g.lines.map((l) => l.left));
    for (const p of g.media) {
        if (p.top < g.header.bottom - 0.5) why.push(`${p.kind} ${p.name} starts above the author line (${p.top.toFixed(1)} < ${g.header.bottom.toFixed(1)})`);
        if (p.bottom > wordsTop + 0.5) why.push(`${p.kind} ${p.name} reaches ${p.bottom.toFixed(1)}, below the words' first line at ${wordsTop.toFixed(1)} (beside or under the words)`);
    }
    if (g.media[0] && Math.abs(g.media[0].left - g.content.left) > 1) why.push(`first picture at x=${g.media[0].left.toFixed(1)}, column at ${g.content.left.toFixed(1)}`);
    if (Math.abs(wordsLeft - g.content.left) > 1) why.push(`words start at x=${wordsLeft.toFixed(1)}, column at ${g.content.left.toFixed(1)}`);
    return why;
}

let oldOwnerFailed = 0, oldVideoFailed = 0, oldChecked = 0;
const controlsOld = {};

for (const size of SIZES) {
    // ---- the layout without the change: the before, and the negative control
    {
        const { ctx, page } = await open('old', size);
        const msgs = messagesFrom(await makeMessages(page));
        await page.evaluate((m) => window.__rig.show(m), msgs);
        for (const m of msgs) {
            const g = await measure(page, m);
            if (m.control) { controlsOld[`${size.name}:${m.id}`] = g; continue; }
            if (m.id === 'owner' || m.id === 'video') {
                oldChecked++;
                const why = aboveTheWords(m, g);
                if (why.length > 0) { if (m.id === 'owner') oldOwnerFailed++; else oldVideoFailed++; }
                ck(why.length > 0, `[old ${size.name}] NEGATIVE CONTROL: without the change, "${m.id}" fails the check`, why[0] ?? 'it passed: the check cannot see the bug');
            }
        }
        await page.evaluate(() => document.querySelector('[data-msg="owner"]').scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: path.join(outdir, `before-${size.name}.png`) });
        await page.locator('[data-msg="owner"]').screenshot({ path: path.join(outdir, `before-${size.name}-owner.png`) });
        for (const id of ['two', 'spoiler', 'video', 'file']) await page.locator(`[data-msg="${id}"]`).screenshot({ path: path.join(outdir, `before-${size.name}-${id}.png`) });
        await ctx.close();
    }

    // ---- with the change
    const { ctx, page } = await open('new', size);
    const msgs = messagesFrom(await makeMessages(page));
    await page.evaluate((m) => window.__rig.show(m), msgs);
    for (const theme of THEMES) {
        for (const contrast of CONTRASTS) {
            const look = `${theme}${contrast === 'high' ? '+hc' : ''}`;
            await page.evaluate(([t, c]) => {
                document.documentElement.setAttribute('data-theme', t);
                document.documentElement.setAttribute('data-contrast', c);
            }, [theme, contrast]);
            const bad = [];
            for (const m of msgs) {
                const g = await measure(page, m);
                if (g.overflow.doc > 0 || g.overflow.list > 0) bad.push(`${m.id}: scrolls sideways (${g.overflow.doc}/${g.overflow.list} px)`);
                if (m.control) {
                    const o = controlsOld[`${size.name}:${m.id}`];
                    if (g.hasBlock) bad.push(`${m.id}: a control got the block`);
                    const same = (a, b) => Math.abs((a.top - a.c.top) - (b.top - b.c.top)) <= 0.5 && Math.abs((a.left - a.c.left) - (b.left - b.c.left)) <= 0.5 && Math.abs(a.width - b.width) <= 0.5 && Math.abs(a.height - b.height) <= 0.5;
                    const parts = (x) => [...x.media, ...x.lines].map((r) => ({ ...r, c: x.content }));
                    const np = parts(g), op = parts(o);
                    const moved = np.findIndex((r, i) => !op[i] || !same(r, op[i]));
                    if (np.length !== op.length || moved >= 0) {
                        const at = (r) => r ? `${(r.left - r.c.left).toFixed(1)},${(r.top - r.c.top).toFixed(1)} ${r.width?.toFixed(1) ?? (r.right - r.left).toFixed(1)}x${r.height?.toFixed(1) ?? (r.bottom - r.top).toFixed(1)}` : 'none';
                        bad.push(`${m.id}: drawn somewhere else than before (${np.length} vs ${op.length} parts; part ${moved}: now ${at(np[moved])}, was ${at(op[moved])})`);
                    }
                    if (Math.abs(g.content.height - o.content.height) > 0.5) bad.push(`${m.id}: ${g.content.height}px tall, was ${o.content.height}px`);
                    continue;
                }
                for (const why of aboveTheWords(m, g)) bad.push(`${m.id}: ${why}`);
                if (!g.hasBlock) bad.push(`${m.id}: no .message-media block`);
                if (m.long) {
                    const right = Math.max(...g.lines.map((l) => l.right));
                    if (right < g.content.left + 0.8 * g.content.width) bad.push(`long: the words reach x=${right.toFixed(0)} of a column ${g.content.left.toFixed(0)}-${g.content.right.toFixed(0)} (not its full width)`);
                }
                if (m.id === 'two') {
                    const [p, q] = g.media;
                    const inOrder = p && q && (p.name === 'first.png' && q.name === 'second.png') && (q.left > p.left + 1 || q.top > p.top + 1);
                    if (!inOrder) bad.push(`two: not in the order sent (${g.media.map((x) => x.name).join(', ')})`);
                }
                if (m.chip) {
                    // After the words: beside the end of their last line, or below it; and under the picture.
                    const last = g.lines.reduce((a, l) => (l.top > a.top ? l : a));
                    const after = g.chip && g.chip.bottom > last.top && (g.chip.left >= last.right - 1 || g.chip.top >= last.bottom - 1)
                        && g.chip.top >= Math.max(...g.media.map((p) => p.bottom)) - 0.5;
                    if (!after) bad.push(`file: the chip is not after the words (${g.chip ? `chip at ${g.chip.left.toFixed(0)},${g.chip.top.toFixed(0)}` : 'no chip'}; last line ends ${last.right.toFixed(0)},${last.top.toFixed(0)})`);
                }
                if (m.spoiler && !g.spoiler?.revealed) {
                    if (!/blur/.test(g.spoiler?.filter ?? '')) bad.push(`spoiler: the picture is not covered (filter ${g.spoiler?.filter})`);
                    if (!/SPOILER/.test(g.spoiler?.label ?? '')) bad.push('spoiler: no SPOILER label');
                }
            }
            ck(bad.length === 0, `[new ${size.name} ${look}] every picture and video above its words, controls unchanged, nothing sideways`, bad.slice(0, 4).join(' | '));
            await page.evaluate(() => document.querySelector('[data-msg="owner"]').scrollIntoView({ block: 'start' }));
            await page.screenshot({ path: path.join(outdir, `after-${size.name}-${look}.png`) });
        }
    }
    await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.documentElement.setAttribute('data-contrast', 'normal');
        document.querySelector('[data-msg="owner"]').scrollIntoView({ block: 'start' });
    });
    await page.screenshot({ path: path.join(outdir, `after-${size.name}.png`) });
    await page.locator('[data-msg="owner"]').screenshot({ path: path.join(outdir, `after-${size.name}-owner.png`) });
    for (const id of ['two', 'spoiler', 'video', 'file']) await page.locator(`[data-msg="${id}"]`).screenshot({ path: path.join(outdir, `after-${size.name}-${id}.png`) });

    // ---- the spoiler: a real click (or tap) reveals it, still above the words
    const sp = msgs.find((m) => m.id === 'spoiler');
    const g0 = await measure(page, sp);
    ck(g0.spoiler && !g0.spoiler.revealed, `[new ${size.name}] the spoilered picture starts covered`);
    const cx = g0.spoiler.left + g0.spoiler.width / 2, cy = g0.spoiler.top + g0.spoiler.height / 2;
    const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.spoiler'), [cx, cy]);
    ck(hit, `[new ${size.name}] the cover is what a press at its centre hits`);
    if (size.opts.hasTouch) await page.touchscreen.tap(cx, cy); else await page.mouse.click(cx, cy);
    const g1 = await page.evaluate(() => document.querySelector('[data-msg="spoiler"] .spoiler')?.classList.contains('revealed'));
    ck(g1 === true, `[new ${size.name}] one ${size.opts.hasTouch ? 'tap' : 'click'} reveals it`);
    const g2 = await measure(page, sp);
    const why = aboveTheWords(sp, g2);
    ck(why.length === 0 && !/blur/.test(g2.spoiler?.filter ?? ''), `[new ${size.name}] revealed, the picture is uncovered and still above the words`, why.join(' | ') || g2.spoiler?.filter);
    await ctx.close();
}

ck(oldChecked === 4 && oldOwnerFailed === 2 && oldVideoFailed === 2, 'NEGATIVE CONTROL: the old layout failed the check for the owner\'s message and the video at both sizes', `${oldOwnerFailed + oldVideoFailed}/${oldChecked}`);

await browser.close();
server.close();
console.log(`\nscreenshots: ${outdir}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
