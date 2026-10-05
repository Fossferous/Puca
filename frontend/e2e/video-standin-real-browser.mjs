// A video waiting for a player takes exactly the box its player will: checked
// in a real browser.
//
// WHY THIS EXISTS. Only the few videos closest to the screen have a live
// <video> (components/attachmentZone.ts); the rest of a channel's loaded
// videos wait with a stand-in. The stand-in used to be a 30 px "Loading
// attachment…" chip that became a ~260 px player when it reached the screen,
// and scrolling up through videos posted back to back pushed what the reader
// was looking at 100-380 px down (review finding 2026-10-05: 1 wheel step in
// 5 on desktop, 2 in 5 in the phone layout). The fix reads the picture size
// from the file's own header (src/api/videoDims.ts) and gives the stand-in
// AND the player the box the browser would give that picture (Chat.css
// `.video-box`), so swapping one for the other moves nothing. jsdom has no
// layout and no media, so the vitest suite can only check the structure; the
// sizes are proven here. For each real file in src/tests/fixtures (landscape,
// a phone video stored turned a quarter, fragmented portrait, anamorphic, a
// 1080p Púca clip), at a desktop column (700 px) and a phone column (358 px):
//
//   1. NATURAL: a plain <video> under the real Chat.css, sized by its own
//      metadata — what a player has always looked like. The reference.
//   2. The header reader agrees with what the browser reports
//      (videoWidth x videoHeight).
//   3. PLAYER: <video class="video-box"> sized from the header, before its
//      metadata has loaded and after: the natural box both times.
//   4. STAND-IN: the span that waits for a player: the same box.
//   5. NEGATIVE CONTROL: a stand-in given the size the wrong way round is NOT
//      the natural box for the portrait files, so the comparison can fail.
//
// SILENT and headless: --mute-audio, every <video> muted with
// preload="metadata", nothing is ever played. No server and no build.
//
//   cd frontend && node e2e/video-standin-real-browser.mjs
//
// CHANNEL=msedge by default (an H.264 decoder: Playwright's bundled Chromium
// has none and cannot open the MP4s); CHANNEL=chrome works too.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');
const bundle = await build({
    stdin: { contents: `import { readVideoDims } from './api/videoDims'; window.__readVideoDims = readVideoDims;`, resolveDir: src, loader: 'ts', sourcefile: 'entry.ts' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    logLevel: 'error',
});
const css = readFileSync(join(src, 'components', 'Chat.css'), 'utf8');

const FILES = [
    ['video-dims/320x180.webm', 'video/webm'],
    ['video-dims/320x180-rot90.mp4', 'video/mp4'],
    ['video-dims/320x180-rot90.mov', 'video/quicktime'],
    ['video-dims/180x320-fragmented.mp4', 'video/mp4'],
    ['video-dims/320x240-sar4-3.mp4', 'video/mp4'],
    ['clip-avc-1s.mp4', 'video/mp4'],
];
const PORTRAIT = new Set(['video-dims/320x180-rot90.mp4', 'video-dims/320x180-rot90.mov', 'video-dims/180x320-fragmented.mp4']);
const COLUMNS = [700, 358];

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

const CHANNEL = process.env.CHANNEL || 'msedge';
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--mute-audio'],
});
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => { fail++; console.log('FAIL page error', String(e)); });
    await page.setContent('<!doctype html><meta charset=utf-8><title>video-standin</title><body></body>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });

    for (const [name, type] of FILES) {
        const b64 = readFileSync(join(src, 'tests', 'fixtures', name)).toString('base64');
        for (const column of COLUMNS) {
            const r = await page.evaluate(async ({ b64, type, column }) => {
                const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
                const dims = window.__readVideoDims(bytes);
                const url = URL.createObjectURL(new Blob([bytes], { type }));
                const host = document.createElement('div');
                host.style.width = `${column}px`;
                document.body.replaceChildren(host);
                const card = (inner) => { const s = document.createElement('span'); s.className = 'message-video'; s.append(inner); host.append(s); return inner; };
                const sized = (el, d) => { el.classList.add('video-box'); el.style.setProperty('--vw', String(d.width)); el.style.setProperty('--vh', String(d.height)); return el; };
                const video = (withSrc) => { const v = document.createElement('video'); v.muted = true; v.preload = 'metadata'; v.controls = true; if (withSrc) v.src = url; return v; };
                const metadata = (v) => new Promise((res) => {
                    if (v.readyState >= 1) { res(true); return; }
                    v.addEventListener('loadedmetadata', () => res(true), { once: true });
                    v.addEventListener('error', () => res(false), { once: true });
                    setTimeout(() => res(false), 8000);
                });
                const box = (el) => { const b = el.getBoundingClientRect(); return { w: +b.width.toFixed(2), h: +b.height.toFixed(2) }; };

                const natural = card(video(true));
                const loaded = await metadata(natural);
                const out = { dims, loaded, reported: { width: natural.videoWidth, height: natural.videoHeight }, natural: box(natural) };
                if (!dims) return out;
                const player = card(sized(video(false), dims));
                out.playerBefore = box(player);
                player.src = url;
                await metadata(player);
                out.playerAfter = box(player);
                const standIn = card(sized(Object.assign(document.createElement('span'), { className: 'message-video-standin' }), dims));
                out.standIn = box(standIn);
                const turned = card(sized(Object.assign(document.createElement('span'), { className: 'message-video-standin' }), { width: dims.height, height: dims.width }));
                out.turned = box(turned);
                for (const v of host.querySelectorAll('video')) { v.removeAttribute('src'); v.load(); }
                URL.revokeObjectURL(url);
                return out;
            }, { b64, type, column });
            const tag = `${name} @${column}px`;
            const same = (a, b) => !!a && !!b && Math.abs(a.w - b.w) <= 0.5 && Math.abs(a.h - b.h) <= 0.5;
            ck(r.loaded, `${tag}: the browser opened it`, JSON.stringify(r.reported));
            ck(r.dims && r.dims.width === r.reported.width && r.dims.height === r.reported.height, `${tag}: the header says what the browser reports`, `${JSON.stringify(r.dims)} vs ${JSON.stringify(r.reported)}`);
            ck(same(r.playerBefore, r.natural), `${tag}: a player sized from the header takes the natural box before its metadata`, `${JSON.stringify(r.playerBefore)} vs ${JSON.stringify(r.natural)}`);
            ck(same(r.playerAfter, r.natural), `${tag}: ...and after it`, `${JSON.stringify(r.playerAfter)} vs ${JSON.stringify(r.natural)}`);
            ck(same(r.standIn, r.natural), `${tag}: the stand-in takes the same box`, `${JSON.stringify(r.standIn)} vs ${JSON.stringify(r.natural)}`);
            if (PORTRAIT.has(name)) ck(!same(r.turned, r.natural), `${tag}: NEGATIVE CONTROL: the size the wrong way round is a different box`, `${JSON.stringify(r.turned)} vs ${JSON.stringify(r.natural)}`);
        }
    }
} finally {
    await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
