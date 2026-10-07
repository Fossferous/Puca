// The remote-control stage on a phone, in a REAL browser: the shipped
// DeviceStage, its keyboard bar and its zoom maths, against a stand-in host
// (e2e/device-stage/fakeSession.ts) that plays the agent the way the field
// logs show it behaving — the viewer fit re-encoding the picture, a monitor
// switch whose frames (direct media) beat its confirmation (relay).
//
// Written for the 2026-10-07 owner report ("kb no longer seems to input",
// "zoom is jumpy when switching monitors", "selecting a text field sometimes
// shows all black"). jsdom has no compatibility mouse events, no focus
// change on a tap and no layout, so each of these is pinned here as well as in
// vitest:
//
//   1. a tap into a field that already holds the caret raises the keyboard
//      AND the bar's field keeps focus (the tap's own mousedown used to move it
//      to BODY, leaving the IME attached to nothing);
//   2. tapping the picture while typing keeps it too — with a NEGATIVE
//      CONTROL: a desktop mouse click does take focus, so the rig can see a
//      focus loss at all;
//   3. a zoom-follow into a portrait screen of All Displays lands the same
//      desktop point in the middle, when the new screen's frames arrive
//      before the confirmation, and keeps a pinch that carried on meanwhile;
//   4. the trackpad pointer crosses with it: the first nudge after the switch
//      moves from the same desktop point.
//
// The black stage needs the Android IME's own report (the native keyboard
// tier), which a desktop browser cannot produce; it is pinned in vitest
// (deviceStageZoomFollowSwitch.test.tsx) and was reproduced and verified on a
// headless Android emulator by loading this same harness into a debug APK
// (copy e2e-artifacts/device-stage-dist over dist/, `npx cap copy android`,
// `gradlew assembleDebug`, then drive the WebView over its devtools socket).
//
// Usage: node e2e/device-stage-real-browser.mjs [outdir]
// Builds the harness itself (vite.stageharness.config.ts); no server needed.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const outdir = process.argv[2] || join(here, 'e2e-artifacts', 'device-stage-shots');
await mkdir(outdir, { recursive: true });
execFileSync(process.execPath, [join(here, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.stageharness.config.ts', '--logLevel', 'error'], { cwd: here, stdio: 'inherit' });
const ROOT = join(here, 'e2e-artifacts', 'device-stage-dist');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^([/\\])+/, '');
    if (rel.includes('..')) { res.writeHead(403); return res.end(); }
    for (const c of [join(ROOT, rel), join(ROOT, 'index.html')]) {
        try {
            const b = await readFile(c);
            res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' });
            return res.end(b);
        } catch { /* next */ }
    }
    res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

let fail = 0;
const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });

async function open() {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', e => { fail++; console.log('[pageerror]', String(e).slice(0, 300)); });
    const cdp = await ctx.newCDPSession(page);
    await page.goto(base);
    await page.waitForSelector('.device-stage-surface', { timeout: 15000 });
    await page.waitForFunction(() => (window.__stage.video()?.vw ?? 0) > 0, null, { timeout: 10000 });
    // Past the first fit (the stage reports its size; the host re-encodes).
    await page.waitForTimeout(1500);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 4, radiusY: 4, force: 1 })),
    });
    const tap = async p => { await touch('touchStart', [p]); await page.waitForTimeout(40); await touch('touchEnd', []); };
    const drag = async (a, b, steps = 6) => {
        await touch('touchStart', [a]);
        for (let i = 1; i <= steps; i++) { await touch('touchMove', [{ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }]); await page.waitForTimeout(16); }
        await touch('touchEnd', []);
    };
    const pinch = async (c, d0, d1, steps = 16) => {
        for (let i = 0; i <= steps; i++) {
            const d = d0 + (d1 - d0) * i / steps;
            await touch(i === 0 ? 'touchStart' : 'touchMove', [{ x: c.x - d / 2, y: c.y, id: 0 }, { x: c.x + d / 2, y: c.y, id: 1 }]);
            await page.waitForTimeout(16);
        }
        await touch('touchEnd', []);
    };
    const focused = () => page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
    return { ctx, page, tap, drag, pinch, focused };
}

/** The desktop point under the middle of the stage, from what is on screen. */
const centreDesktop = page => page.evaluate(() => {
    const S = window.__stage;
    const t = S.transform();
    const v = document.querySelector('video.device-stage-video');
    const s = Math.min(v.offsetWidth / v.videoWidth, v.offsetHeight / v.videoHeight);
    const dw = v.videoWidth * s, dh = v.videoHeight * s;
    const ox = (v.offsetWidth - dw) / 2, oy = (v.offsetHeight - dh) / 2;
    const fx = ((v.offsetWidth / 2 - t.x) / t.scale - ox) / dw;
    const fy = ((v.offsetHeight / 2 - t.y) / t.scale - oy) / dh;
    // What is ON the stage: the capture producing the frames.
    const M = S.MONITORS;
    const r = S.state.capturing === 255
        ? (() => { const l = Math.min(...M.map(m => m.left)), tp = Math.min(...M.map(m => m.top)); return { l, t: tp, w: Math.max(...M.map(m => m.left + m.width)) - l, h: Math.max(...M.map(m => m.top + m.height)) - tp }; })()
        : (() => { const m = M.find(x => x.id === S.state.capturing); return { l: m.left, t: m.top, w: m.width, h: m.height }; })();
    return { x: r.l + fx * r.w, y: r.t + fy * r.h, scale: t.scale };
});
/** Client point of a desktop point on the composite picture. */
const clientOnComposite = (page, dx, dy) => page.evaluate(({ dx, dy }) => {
    const M = window.__stage.MONITORS;
    const l = Math.min(...M.map(m => m.left)), t = Math.min(...M.map(m => m.top));
    const W = Math.max(...M.map(m => m.left + m.width)) - l, H = Math.max(...M.map(m => m.top + m.height)) - t;
    const v = document.querySelector('video.device-stage-video');
    const r = v.getBoundingClientRect();
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const dw = v.videoWidth * s, dh = v.videoHeight * s;
    return { x: r.left + (r.width - dw) / 2 + dw * (dx - l) / W, y: r.top + (r.height - dh) / 2 + dh * (dy - t) / H };
}, { dx, dy });

// ---- 1 + 2: the keyboard keeps its field ------------------------------------
{
    const { ctx, page, tap, focused } = await open();
    // The PC's focused field already holds the caret where the pointer is.
    await page.evaluate(() => window.__stage.pushCaret({ vis: true, x: 0.5, y: 0.497, w: 0.0002, h: 0.007, src: 'msaa', mon: 255 }));
    await page.waitForTimeout(200);
    await tap({ x: 200, y: 600 });
    await page.waitForTimeout(400);
    const panel = await page.evaluate(() => !!document.querySelector('.device-stage-keyboard-overlay'));
    ck('a tap into the field holding the caret raises the keyboard bar', panel);
    ck('…and its field HAS focus after the tap (the IME types into it)', await focused() === 'device-stage-keyboard-capture', await focused());
    await page.screenshot({ path: `${outdir}/01-keyboard-raised.png` });

    await tap({ x: 200, y: 500 });
    await page.waitForTimeout(300);
    ck('tapping the picture while typing keeps the field focused', await focused() === 'device-stage-keyboard-capture', await focused());
    // (No "and typing arrives" check here: CDP's insertText reaches the last
    // focused editable even from BODY, so it would pass against the bug. A
    // real IME does not — on the emulator, Gboard fell back to raw key events
    // with the field unfocused. Focus is the property.)

    // NEGATIVE CONTROL: the rig can see focus leave the field.
    await page.mouse.click(200, 500);
    await page.waitForTimeout(200);
    ck('NEGATIVE CONTROL: a desktop mouse click on the picture does take focus', await focused() !== 'device-stage-keyboard-capture', await focused());
    await ctx.close();
}

// ---- 3: zoom-follow into a portrait screen ----------------------------------
{
    const { ctx, page, pinch } = await open();
    // A slow confirmation, as over a busy relay: the new screen's picture is
    // on the stage well before the host says so.
    await page.evaluate(() => { window.__stage.knobs.commitMs = 150; window.__stage.knobs.confirmMs = 800; });
    // The middle of the screen, so the landing is not pulled by the pan
    // clamp at an edge (the off-centre case is vitest's).
    const c = await clientOnComposite(page, 2560 + 720, -700 + 1280);
    await pinch(c, 60, 360);
    // The trigger fires 120 ms after the pinch rests; sample until the new
    // screen's picture is on the stage, give the stage two animation frames
    // to react to it (NOT the same frame: the view follows a render after the
    // picture), and look — while the confirmation is still in flight.
    let before = await centreDesktop(page);
    let onNew = null;
    for (let i = 0; i < 120 && !onNew; i++) {
        const st = await page.evaluate(() => ({ cap: window.__stage.state.capturing, vw: window.__stage.video().vw, vh: window.__stage.video().vh }));
        if (st.cap === 255) before = await centreDesktop(page);
        if (st.cap === 1 && st.vh > st.vw) {
            await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
            onNew = { active: await page.evaluate(() => window.__stage.state.activeMonitor), centre: await centreDesktop(page) };
        }
        await page.waitForTimeout(5);
    }
    ck('precondition: zooming over Display 2 followed it', !!onNew);
    // Where the landing SHOULD put the middle: the point that was there,
    // pulled in only as far as the pan clamp needs to keep Display 2 filling
    // the stage (there is nothing beyond its edge in the single-screen view).
    const expected = c => {
        const halfW = (390 / c.scale / 2) / 390 * 1440;
        const halfH = (799 / c.scale / 2) / (390 * 2560 / 1440) * 2560;
        const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        return { x: cl(before.x, 2560 + halfW, 4000 - halfW), y: cl(before.y, -700 + halfH, 1860 - halfH) };
    };
    if (onNew) {
        const e = expected(onNew.centre);
        const d = Math.hypot(onNew.centre.x - e.x, onNew.centre.y - e.y);
        ck('precondition: the confirmation has not arrived yet', onNew.active !== 1, String(onNew.active));
        ck('the new screen is framed in place as soon as its picture arrives, not when the confirmation does',
            d < 20, `${Math.round(d)} desktop px off`);
    }
    await page.waitForTimeout(1500);
    const settled = await centreDesktop(page);
    const e2 = expected(settled);
    const d2 = Math.hypot(settled.x - e2.x, settled.y - e2.y);
    ck('…and stays there once confirmed and re-fitted', d2 < 20, `${Math.round(d2)} desktop px off`);
    await page.screenshot({ path: `${outdir}/02-followed-display-2.png` });
    await ctx.close();
}

// ---- 3b: a pinch that carries on across the switch ---------------------------
{
    const { ctx, page, pinch } = await open();
    // A slow host: the switch takes long enough for the fingers to carry on.
    await page.evaluate(() => { window.__stage.knobs.commitMs = 700; window.__stage.knobs.confirmMs = 300; });
    const c = await clientOnComposite(page, 2560 + 720, -700 + 900);
    await pinch(c, 60, 360);
    await page.waitForTimeout(250);                       // the follow has asked
    const asked = await page.evaluate(() => window.__stage.monitorRequests.length);
    await pinch(c, 100, 260);                             // and the zoom goes on
    const before = await centreDesktop(page);
    await page.waitForTimeout(1800);
    const after = await centreDesktop(page);
    ck('precondition: the follow asked before the second pinch', asked === 1, String(asked));
    // One desktop pixel's size on screen, before and after.
    const px = (st, w) => st.scale * 390 / w;            // picture 390 css wide in both
    const ratio = px(after, 1440) / px(before, 5440);
    ck('a pinch that carried on while the host switched is kept, not undone', ratio > 0.85 && ratio < 1.15,
        `magnification ratio ${ratio.toFixed(2)}`);
    await ctx.close();
}

// ---- 4: the trackpad pointer crosses with the switch -------------------------
{
    const { ctx, page, pinch, drag } = await open();
    // The pointer starts the session in the middle of the composite: desktop
    // (1280, 576), on the main display 40% of the way down it.
    const c = await clientOnComposite(page, 1280, 720);
    await pinch(c, 60, 400);
    await page.waitForTimeout(1500);
    const followed = await page.evaluate(() => window.__stage.state.activeMonitor);
    ck('precondition: the main display was followed', followed === 0, String(followed));
    const n = await page.evaluate(() => window.__stage.inputs.length);
    await drag({ x: 200, y: 400 }, { x: 203, y: 400 }, 3);
    await page.waitForTimeout(200);
    const moves = await page.evaluate(n => window.__stage.inputs.slice(n).filter(e => e.t === 'move'), n);
    const last = moves[moves.length - 1];
    ck('the first nudge after the switch moves from the same desktop point', !!last && Math.abs(last.y - 576 / 1440) < 0.01,
        last ? `y=${last.y.toFixed(3)} (0.400 = same row; 0.500 = the stale fraction)` : 'no move');
    await ctx.close();
}

// ---- 4b: …and when the PC's pointer is on ANOTHER screen ---------------------
{
    const { ctx, page, pinch, drag } = await open();
    // The pointer is on the main display (the middle of the composite); the
    // zoom goes deep into the right-hand part of Display 2. The pointer has no
    // place on Display 2: clamped onto its far edge it sat out of view, and the
    // first nudge flew the camera there (the review measured 778 desktop px).
    const c = await clientOnComposite(page, 2560 + 1150, -700 + 1000);
    await pinch(c, 40, 400);
    await page.waitForTimeout(1500);
    const followed = await page.evaluate(() => window.__stage.state.activeMonitor);
    ck('precondition: Display 2 was followed', followed === 1, String(followed));
    const before = await centreDesktop(page);
    const n = await page.evaluate(() => window.__stage.inputs.length);
    await drag({ x: 200, y: 400 }, { x: 203, y: 400 }, 3);
    await page.waitForTimeout(300);
    const after = await centreDesktop(page);
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    ck('a pointer from another screen does not fly the camera on the first nudge', moved < 60,
        `the view moved ${Math.round(moved)} desktop px`);
    const moves = await page.evaluate(n => window.__stage.inputs.slice(n).filter(e => e.t === 'move'), n);
    const last = moves[moves.length - 1];
    ck('…it is put where the user is looking', !!last && Math.abs(2560 + last.x * 1440 - before.x) < 150,
        last ? `pointer at desktop x=${Math.round(2560 + last.x * 1440)}, view centre x=${Math.round(before.x)}` : 'no move');
    await ctx.close();
}

await browser.close();
server.close();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
