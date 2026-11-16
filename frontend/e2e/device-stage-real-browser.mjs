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
//      moves from the same desktop point;
//   5. an agent too old to send pointer shapes (2026-10-26, a laptop host on
//      0.9.844): one line says that computer runs an older Púca, inside the
//      window and clear of the toolbar, with a 44 px close button a tap
//      reaches and that presses nothing over there (CONTROL: a current agent
//      gets no line);
//   6. the monitor-hop chip (2026-11-14, "This button is too big"): on the
//      phone it PAINTS at most 36 px a side (a screenshot with it against one
//      without it), see-through, its arrow at 3:1 over a white picture, in a
//      44 px target that elementFromPoint hits to its corners, clear of the
//      mouse pad and the toolbar, on its own edge with its arrow that way, for
//      all four directions on a desk with a screen on every side; a real tap
//      switches screens and presses nothing over there (POSITIVE CONTROL: a
//      tap on the picture does). NEGATIVE CONTROL: the same chip without its
//      touch-layout class (the chip as it was, 164x44 painted) fails.
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
// CPU_THROTTLE=<n> runs every page n times slower (DevTools' CPU throttling):
// a busy machine, or a slow phone, on a quiet one. Every check must pass at 6.
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

/** `knobs`: the stand-in host's knobs from its very first hand-over (an
 *  agent too old to send shapes, say) — fakeSession.ts reads them at load.
 *  `monitors`: another desk for the stand-in host (fakeSession.ts's
 *  MONITORS); `storage`: the stage's remembered settings, set before load;
 *  `viewport`: another phone shape (a phone turned sideways, say). */
async function open(knobs = null, { monitors = null, storage = null, viewport = { width: 390, height: 844 } } = {}) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', e => { fail++; console.log('[pageerror]', String(e).slice(0, 300)); });
    if (knobs) await page.addInitScript(k => { window.__stageKnobsInit = k; }, knobs);
    if (monitors) await page.addInitScript(m => { window.__stageMonitorsInit = m; }, monitors);
    if (storage) await page.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
    const cdp = await ctx.newCDPSession(page);
    if (Number(process.env.CPU_THROTTLE) > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU_THROTTLE) });
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
    /** Two fingers moving together: a pan (a pinch with no change of spread). */
    const pan2 = async (c, dx, dy, steps = 12) => {
        for (let i = 0; i <= steps; i++) {
            const x = c.x + dx * i / steps, y = c.y + dy * i / steps;
            await touch(i === 0 ? 'touchStart' : 'touchMove', [{ x: x - 30, y, id: 0 }, { x: x + 30, y, id: 1 }]);
            await page.waitForTimeout(16);
        }
        await touch('touchEnd', []);
    };
    const focused = () => page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
    return { ctx, page, cdp, tap, drag, pinch, pan2, focused };
}

/** The stage's "<PC> runs an older Púca" line, measured where it is drawn. */
const olderBanner = page => page.evaluate(() => {
    const el = document.querySelector('.device-stage-older-host');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const span = el.querySelector('span');
    const btn = el.querySelector('button');
    const b = btn?.getBoundingClientRect();
    const hit = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
    const bar = document.querySelector('.device-stage-mobile-toolbar, .mobile-toolbar')?.getBoundingClientRect() ?? null;
    return {
        text: span?.textContent ?? '',
        top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width,
        W: document.documentElement.clientWidth, H: document.documentElement.clientHeight,
        clipped: !!span && (span.scrollWidth > span.clientWidth + 1 || span.scrollHeight > span.clientHeight + 1),
        btn: b ? { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height } : null,
        btnHit: !!btn && !!hit && (hit === btn || btn.contains(hit)),
        barTop: bar ? bar.top : null,
    };
});

/** The desktop point under the middle of the stage, from what is on screen,
 *  and `surface`, the capture whose PICTURE is on the stage (255 = All
 *  Displays), read from that picture's own shape. Not from the host's
 *  `capturing`: that flips at the commit, a frame or more before the new
 *  capture's first frame reaches the video element, and in that window the
 *  composite's fractions were read as Display 2's (2026-11-16: a `before`
 *  775 desktop px out, which the zoom-follow check reported as the stage
 *  landing 533 px off; the stage had landed right). Two screens of one shape
 *  cannot be told apart, so a picture that fits the capture the host is
 *  producing is that capture's; `surface` is null (and the point unknown)
 *  for a picture that fits nothing the host could be showing. `w` is that
 *  surface's width in desktop px. */
const centreDesktop = page => page.evaluate(() => {
    const S = window.__stage;
    const t = S.transform();
    const v = document.querySelector('video.device-stage-video');
    const s = Math.min(v.offsetWidth / v.videoWidth, v.offsetHeight / v.videoHeight);
    const dw = v.videoWidth * s, dh = v.videoHeight * s;
    const ox = (v.offsetWidth - dw) / 2, oy = (v.offsetHeight - dh) / 2;
    const fx = ((v.offsetWidth / 2 - t.x) / t.scale - ox) / dw;
    const fy = ((v.offsetHeight / 2 - t.y) / t.scale - oy) / dh;
    const M = S.MONITORS;
    const rectOf = id => {
        if (id !== 255) { const m = M.find(x => x.id === id); return { l: m.left, t: m.top, w: m.width, h: m.height }; }
        const l = Math.min(...M.map(m => m.left)), tp = Math.min(...M.map(m => m.top));
        return { l, t: tp, w: Math.max(...M.map(m => m.left + m.width)) - l, h: Math.max(...M.map(m => m.top + m.height)) - tp };
    };
    // The stage's own tolerance for "this picture is that capture's"
    // (deviceZoomFollow.ts, SWITCH_ASPECT_MATCH).
    const fits = id => { const r = rectOf(id); return Math.abs((v.videoWidth / v.videoHeight) / (r.w / r.h) - 1) <= 0.03; };
    const fitting = [255, ...M.map(m => m.id)].filter(fits);
    const surface = fits(S.state.capturing) ? S.state.capturing : fitting.length === 1 ? fitting[0] : null;
    if (surface === null) return { x: null, y: null, scale: t.scale, surface, w: null };
    const r = rectOf(surface);
    return { x: r.l + fx * r.w, y: r.t + fy * r.h, scale: t.scale, surface, w: r.w };
});
/** Until the host has confirmed `monitor` and the stage shows that screen's
 *  picture at its native size, which is what the host's viewer fit re-encodes
 *  it to at any zoom the follow lands on (the first frames after a switch
 *  keep the old step), plus two frames for the stage to take the resize.
 *  Resolves whether it came (true) or not (false) within 8 s. */
const confirmedAndRefitted = (page, monitor) => page.waitForFunction(m => {
    const S = window.__stage, v = S.video(), mon = S.MONITORS.find(x => x.id === m);
    return S.state.activeMonitor === m && v.vw === mon.width && v.vh === mon.height;
}, monitor, { timeout: 8000 })
    .then(() => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))))
    .then(() => true, () => false);
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
    // picture), and look — while the confirmation is still in flight. Each
    // sample reads the picture and the view in ONE step: `before` is the view
    // over the composite's picture as long as that picture is on the stage.
    let before = null;
    let onNew = null;
    for (const until = Date.now() + 5000; !onNew && Date.now() < until;) {
        const now = await centreDesktop(page);
        if (now.surface === 255) before = now;
        else if (now.surface === 1) {
            await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
            onNew = { active: await page.evaluate(() => window.__stage.state.activeMonitor), centre: await centreDesktop(page) };
        }
        await page.waitForTimeout(5);
    }
    ck('precondition: the view over All Displays was read before the switch', !!before);
    ck('precondition: zooming over Display 2 followed it', !!onNew && onNew.centre.surface === 1);
    // Where the landing SHOULD put the middle: the point that was there,
    // pulled in only as far as the pan clamp needs to keep Display 2 filling
    // the stage (there is nothing beyond its edge in the single-screen view).
    const expected = c => {
        const halfW = (390 / c.scale / 2) / 390 * 1440;
        const halfH = (799 / c.scale / 2) / (390 * 2560 / 1440) * 2560;
        const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        return { x: cl(before.x, 2560 + halfW, 4000 - halfW), y: cl(before.y, -700 + halfH, 1860 - halfH) };
    };
    if (before && onNew?.centre.surface === 1) {
        const e = expected(onNew.centre);
        const d = Math.hypot(onNew.centre.x - e.x, onNew.centre.y - e.y);
        ck('precondition: the confirmation has not arrived yet', onNew.active !== 1, String(onNew.active));
        ck('the new screen is framed in place as soon as its picture arrives, not when the confirmation does',
            d < 20, `${Math.round(d)} desktop px off`);
    }
    ck('precondition: the host confirmed Display 2 and re-fitted its picture', await confirmedAndRefitted(page, 1));
    const settled = await centreDesktop(page);
    if (before && settled.surface === 1) {
        const e2 = expected(settled);
        const d2 = Math.hypot(settled.x - e2.x, settled.y - e2.y);
        ck('…and stays there once confirmed and re-fitted', d2 < 20, `${Math.round(d2)} desktop px off`);
    } else ck('…and stays there once confirmed and re-fitted', false, `the picture on the stage is ${settled.surface ?? 'no capture'}'s`);
    await page.screenshot({ path: `${outdir}/02-followed-display-2.png` });
    await ctx.close();
}

// ---- 3b: a pinch that carries on across the switch ---------------------------
{
    const { ctx, page, pinch } = await open();
    // A slow host: it switches only once the fingers have carried on. Held by
    // the stand-in until the second pinch is over, not timed: a 700 ms commit
    // raced the pinch's own speed, and on a busy machine the picture landed
    // before the pinch ended, so `before` was read on Display 2 as if it were
    // the composite (2026-11-16, "magnification ratio 3.78": 5440 / 1440).
    await page.evaluate(() => { window.__stage.knobs.holdSwitch = true; window.__stage.knobs.confirmMs = 300; });
    const c = await clientOnComposite(page, 2560 + 720, -700 + 900);
    await pinch(c, 60, 360);
    // The follow has asked (the trigger fires 120 ms after the pinch rests).
    await page.waitForFunction(() => window.__stage.monitorRequests.length > 0, null, { timeout: 5000 }).catch(() => {});
    const asked = await page.evaluate(() => window.__stage.monitorRequests.length);
    await pinch(c, 100, 260);                             // and the zoom goes on
    const before = await centreDesktop(page);
    await page.evaluate(() => window.__stage.releaseSwitch());
    const landed = await confirmedAndRefitted(page, 1);
    const after = await centreDesktop(page);
    ck('precondition: the follow asked before the second pinch', asked === 1, String(asked));
    ck('precondition: the second pinch ended over All Displays, and the follow then landed on Display 2',
        before.surface === 255 && landed && after.surface === 1, `before on ${before.surface}, after on ${after.surface}, landed ${landed}`);
    // One desktop pixel's size on screen, before and after (the picture is
    // 390 css wide in both).
    const px = st => st.scale * 390 / st.w;
    const ratio = px(after) / px(before);
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

// THE PAUSED BANNER'S RESUME, on the phone (it had no way to resume before
// 2026-10-23). A hardware keyboard's Ctrl+Alt+Home pauses; Resume must be a
// 44 px target inside the window that a tap reaches, with its word inside it
// and beside its icon — under the coarse pointer's flex rule the text squeezed
// the button until the icon stacked above the word and the word ran out past
// the button's edge. The tap resumes and presses nothing on the remote machine.
{
    const { ctx, page } = await open();
    await page.keyboard.down('Control'); await page.keyboard.down('Alt');
    await page.keyboard.press('Home');
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
        const b = document.querySelector('.device-stage-paused button');
        if (!b) return null;
        const rect = b.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const icon = b.querySelector('svg')?.getBoundingClientRect();
        const word = [...b.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        const range = document.createRange();
        if (word) range.selectNodeContents(word);
        const wr = word ? range.getBoundingClientRect() : null;
        return {
            w: Math.round(rect.width), h: Math.round(rect.height), left: rect.left, right: rect.right, bottom: rect.bottom,
            hit: !!hit && !!hit.closest('.device-stage-paused button'),
            wordInside: !!wr && wr.left >= rect.left - 0.5 && wr.right <= rect.right + 0.5,
            besideIcon: !!wr && !!icon && Math.abs((icon.top + icon.bottom) / 2 - (wr.top + wr.bottom) / 2) < 6,
        };
    });
    ck('a hardware keyboard\'s Ctrl+Alt+Home pauses the phone stage, with a Resume', !!r);
    if (r) {
        ck('Resume is a 44 px target inside the window, and what a tap hits',
            r.w >= 44 && r.h >= 44 && r.left >= 0 && r.right <= 390 && r.bottom <= 844 && r.hit, `${r.w}x${r.h}`);
        ck('…its word inside it, beside its icon (not stacked, not spilling out)', r.wordInside && r.besideIcon,
            `word inside ${r.wordInside}, beside the icon ${r.besideIcon}`);
        await page.screenshot({ path: join(outdir, 'phone-paused-resume.png') });
        const b = await page.locator('.device-stage-paused button').boundingBox();
        await page.evaluate(() => { window.__stage.inputs.length = 0; });
        await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
        await page.waitForTimeout(300);
        const pressed = await page.evaluate(() => window.__stage.inputs.filter(e => e.t === 'down' || e.t === 'tap').length);
        ck('a tap on Resume resumes, and presses nothing over there',
            !(await page.locator('.device-stage-paused').count()) && pressed === 0, `${pressed} presses`);
    }
    await ctx.close();
}

// ---- 5: the other computer runs an older Púca --------------------------------
// The phone's trackpad takes the pointer; an agent from before 0.9.847 hands
// it over and never says its shape. One line at the top says so: inside the
// 390 px window, unclipped, clear of the toolbar, its close button a 44 px
// target that a tap reaches — and the tap presses nothing over there.
// CONTROL first: a current agent says its shape, and there is no line.
{
    const { ctx, page } = await open();
    await page.waitForTimeout(3_500);
    ck('CONTROL: a current agent gets no "older Púca" line on the phone', (await olderBanner(page)) === null);
    await ctx.close();
}
{
    const { ctx, page } = await open({ sendsShapes: false });
    await page.evaluate(() => { window.__stage.state.peerName = 'Study PC'; window.__stage.emit(); });
    const owned = await page.evaluate(() => window.__stage.state.cursorOwned);
    ck('precondition: the phone\'s trackpad took the pointer', owned === true, String(owned));
    await page.waitForTimeout(3_500);
    const r = await olderBanner(page);
    ck('an agent that sends no shapes: one line says that computer runs an older Púca',
        !!r && r.text === 'Study PC runs an older Púca: the pointer is drawn there and can lag. Update Púca on Study PC.', r?.text ?? 'missing');
    if (r) {
        ck('…inside the window, unclipped, parked at the top and clear of the toolbar',
            r.left >= 0 && r.right <= r.W && r.top >= 0 && r.top < 200 && !r.clipped && (r.barTop === null || r.bottom <= r.barTop),
            `${Math.round(r.left)}..${Math.round(r.right)} of ${r.W}, top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)}${r.barTop !== null ? ` (toolbar at ${Math.round(r.barTop)})` : ''}${r.clipped ? ', CLIPPED' : ''}`);
        ck('…its close button a 44 px target that a tap reaches', !!r.btn && r.btn.w >= 44 && r.btn.h >= 44 && r.btnHit,
            r.btn ? `${Math.round(r.btn.w)}x${Math.round(r.btn.h)}, hit ${r.btnHit}` : 'no button');
        await page.screenshot({ path: join(outdir, 'phone-older-host.png') });
        await page.evaluate(() => { window.__stage.inputs.length = 0; });
        await page.touchscreen.tap(r.btn.x, r.btn.y);
        await page.waitForTimeout(300);
        const pressed = await page.evaluate(() => window.__stage.inputs.filter(e => e.t === 'down' || e.t === 'tap' || e.t === 'up').length);
        ck('a tap on it puts it away, and presses nothing over there', (await olderBanner(page)) === null && pressed === 0, `${pressed} presses`);
    }
    await ctx.close();
}

// ---- 6: the monitor-hop chip on a phone --------------------------------------
// The owner, 2026-11-14, controlling a PC from a 390 pt iPhone: "This button
// is too big". The chip that offers the next screen, once a zoomed view is
// panned to an edge with another monitor beyond it, was a named pill that
// grew to its 42% cap there: 164x47 of black over the picture. On the touch
// layout it is now a translucent disc with the arrow, inside the same 44 px
// target. A desk with a screen on every side of the main one, so all four
// chips are reached by REAL two-finger pans, and the stage's mouse pad shown
// where it sits by default, so "clear of the other controls" means something.
//
// What is measured is what is PAINTED: a screenshot with the chip, against
// one with it hidden. BOUND: 36 CSS px a side, under the 44 px target it sits
// in (the painted part never reads as a full-size control) and under a tenth
// of the phone's width; and at least 24, so it is not hidden either.
// NEGATIVE CONTROL: the same chip without its touch-layout class is the chip
// as it was (those rules are untouched, and the desktop keeps them) and must
// FAIL the bound.
const HOP_PAINT_MAX = 36;
const HOP_PAINT_MIN = 24;
const HOP_DESK = [
    { id: 0, label: 'Main display (2560x1440)', left: 0, top: 0, width: 2560, height: 1440 },
    { id: 1, label: 'Left display (2560x1440)', left: -2560, top: 0, width: 2560, height: 1440 },
    { id: 2, label: 'Right display (2560x1440)', left: 2560, top: 0, width: 2560, height: 1440 },
    { id: 3, label: 'Top display (2560x1440)', left: 0, top: -1440, width: 2560, height: 1440 },
    { id: 4, label: 'Bottom display (2560x1440)', left: 0, top: 1440, width: 2560, height: 1440 },
];

/** One chip, measured where it is drawn. Colours as WCAG computes them; a
 *  translucent fill is laid over a WHITE picture, the worst case for the
 *  chip's white glyph and words. */
const hopChip = (page, dir) => page.evaluate(dir => {
    const b = document.querySelector(`.device-stage-hop-${dir}`);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const s = document.querySelector('.device-stage-surface').getBoundingClientRect();
    const mine = el => !!el && (el === b || b.contains(el));
    const overlaps = [...document.querySelectorAll('.device-stage-virtual-mouse, .device-stage-mobile-toolbar, .mobile-toolbar, .device-stage-mobile-toolbar-toggle, .device-stage-paused')]
        .map(el => ({ cls: String(el.className), q: el.getBoundingClientRect() }))
        .filter(o => o.q.width > 0 && o.q.left < r.right && o.q.right > r.left && o.q.top < r.bottom && o.q.bottom > r.top)
        .map(o => o.cls);
    const rgba = c => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
    const lum = c => { const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const onWhite = t => ({ r: t.r * t.a + 255 * (1 - t.a), g: t.g * t.a + 255 * (1 - t.a), b: t.b * t.a + 255 * (1 - t.a) });
    const ratio = (x, y) => { const p = lum(x), q = lum(y); return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05); };
    const icon = b.querySelector('.device-stage-hop-icon');
    const svg = icon?.querySelector('svg');
    const label = b.querySelector('.device-stage-hop-label');
    // The glyph's backing: the disc, or (the pill) the chip itself.
    const fill = [icon, b].map(el => rgba(getComputedStyle(el).backgroundColor)).find(c => c.a > 0) ?? { r: 0, g: 0, b: 0, a: 0 };
    const pill = rgba(getComputedStyle(b).backgroundColor);
    const wordsShown = !!label && label.getClientRects().length > 0 && label.textContent.trim() !== '';
    return {
        x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        shift: Number(b.dataset.hopShift) || 0,
        surf: { left: s.left, right: s.right, top: s.top, bottom: s.bottom },
        W: document.documentElement.clientWidth, H: document.documentElement.clientHeight,
        hitCentre: mine(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)),
        // Inside the target, outside the painted disc: the transparent part
        // of the target takes a tap too.
        hitCorners: [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]]
            .every(([x, y]) => mine(document.elementFromPoint(x, y))),
        overlaps,
        aria: b.getAttribute('aria-label'), title: b.getAttribute('title'),
        path: svg?.querySelector('path')?.getAttribute('d') ?? null,
        turn: icon ? getComputedStyle(icon).transform : null,
        fillAlpha: fill.a,
        iconContrast: ratio(rgba(getComputedStyle(svg ?? b).color), onWhite(fill)),
        wordsShown,
        wordsContrast: wordsShown ? ratio(rgba(getComputedStyle(label).color), onWhite(pill)) : null,
    };
}, dir);

/** What a chip PAINTS: the box round every pixel that changes when it is
 *  hidden, and how much it covers; `noise` is two shots with it shown, which
 *  must not differ at all or the measurement means nothing. */
async function hopPainted(page, dir) {
    const sel = `.device-stage-hop-${dir}`;
    const clip = await page.evaluate(sel => {
        const r = document.querySelector(sel).getBoundingClientRect();
        const x = Math.max(0, Math.floor(r.left) - 12), y = Math.max(0, Math.floor(r.top) - 12);
        return { x, y, width: Math.min(innerWidth, Math.ceil(r.right) + 12) - x, height: Math.min(innerHeight, Math.ceil(r.bottom) + 12) - y };
    }, sel);
    const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const shown = await page.screenshot({ clip });
    const again = await page.screenshot({ clip });
    await page.evaluate(sel => { const b = document.querySelector(sel); b.style.transition = 'none'; b.style.visibility = 'hidden'; }, sel);
    await settle();
    const hidden = await page.screenshot({ clip });
    await page.evaluate(sel => { const b = document.querySelector(sel); b.style.visibility = ''; b.style.transition = ''; }, sel);
    await settle();
    return page.evaluate(async ({ shots, dpr }) => {
        const px = async b64 => {
            const img = new Image();
            img.src = `data:image/png;base64,${b64}`;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0);
            return { w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data };
        };
        const [A, A2, H] = await Promise.all(shots.map(px));
        const diff = (P, Q) => {
            let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
            for (let y = 0; y < P.h; y++) {
                for (let x = 0; x < P.w; x++) {
                    const i = (y * P.w + x) * 4;
                    if (Math.max(Math.abs(P.d[i] - Q.d[i]), Math.abs(P.d[i + 1] - Q.d[i + 1]), Math.abs(P.d[i + 2] - Q.d[i + 2])) <= 24) continue;
                    n++;
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
            }
            return n ? { w: (x1 - x0 + 1) / dpr, h: (y1 - y0 + 1) / dpr, area: n / dpr / dpr } : { w: 0, h: 0, area: 0 };
        };
        return { painted: diff(A, H), noise: diff(A, A2) };
    }, { shots: [shown, again, hidden].map(b => b.toString('base64')), dpr: 3 });
}

/** Every check a chip on the touch layout must pass, in `dir`'s place.
 *  `slid`: it should have slid along its edge out from under a floating
 *  control (otherwise it should be centred on it). */
async function checkHopChip(page, dir, label, slid = false) {
    const c = await hopChip(page, dir);
    ck(`hop ${dir}: a chip is offered toward ${label}`, !!c);
    if (!c) return null;
    const p = await hopPainted(page, dir);
    ck(`hop ${dir}: precondition: the picture under the chip holds still (two shots identical)`, p.noise.area === 0, `${p.noise.area.toFixed(1)} px² differ`);
    ck(`hop ${dir}: what it PAINTS is small: at most ${HOP_PAINT_MAX} px a side, at least ${HOP_PAINT_MIN}`,
        p.painted.w <= HOP_PAINT_MAX && p.painted.h <= HOP_PAINT_MAX && p.painted.w >= HOP_PAINT_MIN && p.painted.h >= HOP_PAINT_MIN,
        `${p.painted.w.toFixed(1)}x${p.painted.h.toFixed(1)}, ${Math.round(p.painted.area)} px² painted`);
    ck(`hop ${dir}: …see-through (fill under 60% opaque), no words painted`, c.fillAlpha < 0.6 && !c.wordsShown,
        `fill alpha ${c.fillAlpha}, words ${c.wordsShown ? 'shown' : 'none'}`);
    ck(`hop ${dir}: …its arrow at 3:1 or more on its disc, over a white picture`, c.iconContrast >= 3, `${c.iconContrast.toFixed(2)}:1`);
    ck(`hop ${dir}: its TARGET is still 44 px, inside the picture and the window`,
        c.w >= 44 && c.h >= 44 && c.left >= c.surf.left && c.right <= c.surf.right && c.top >= c.surf.top && c.bottom <= c.surf.bottom
        && c.left >= 0 && c.right <= c.W && c.top >= 0 && c.bottom <= c.H,
        `${Math.round(c.w)}x${Math.round(c.h)} at ${Math.round(c.left)},${Math.round(c.top)}`);
    ck(`hop ${dir}: …what a tap at its centre hits, and at its corners outside the disc`, c.hitCentre && c.hitCorners,
        `centre ${c.hitCentre}, corners ${c.hitCorners}`);
    ck(`hop ${dir}: …clear of the mouse pad and the toolbar`, c.overlaps.length === 0, c.overlaps.join(', ') || 'clear');
    const cx = (c.surf.left + c.surf.right) / 2, cy = (c.surf.top + c.surf.bottom) / 2;
    const onEdge = {
        left: c.left - c.surf.left <= 12, right: c.surf.right - c.right <= 12,
        up: c.top - c.surf.top <= 12, down: c.surf.bottom - c.bottom <= 12,
    }[dir];
    const along = dir === 'left' || dir === 'right' ? c.y - cy : c.x - cx;
    const placed = onEdge && Math.abs(along - c.shift) <= 1 && (slid ? c.shift !== 0 : c.shift === 0);
    ck(`hop ${dir}: …on its own edge of the picture, ${slid ? 'slid along it out from under a control' : 'centred along it'}`, placed,
        `target ${Math.round(c.left)}..${Math.round(c.right)} x ${Math.round(c.top)}..${Math.round(c.bottom)} in ${Math.round(c.surf.left)}..${Math.round(c.surf.right)} x ${Math.round(c.surf.top)}..${Math.round(c.surf.bottom)}, ${Math.round(along)} px off centre, shift ${c.shift}`);
    // The arrow points the way it goes: up and down have their own chevrons,
    // left is the right chevron turned round.
    const arrow = {
        up: c.path?.startsWith('m5.75 14.75') && c.turn === 'none',
        down: c.path?.startsWith('m5.75 9.25') && c.turn === 'none',
        right: c.path?.startsWith('m9.25 5.75') && c.turn === 'none',
        left: c.path?.startsWith('m9.25 5.75') && /^matrix\(-1, [-\d.e]+, [-\d.e]+, -1, 0, 0\)$/.test(c.turn ?? ''),
    }[dir];
    ck(`hop ${dir}: …its arrow points ${dir}`, arrow, `${c.path} turned ${c.turn}`);
    ck(`hop ${dir}: …and it still names the screen (its accessible name; no title to read twice)`,
        c.aria === `Show ${label}` && c.title === null, `${c.aria} / title ${c.title}`);
    return c;
}

/** Zoomed into the main display (trackpad mode, a phone's default), the
 *  mouse pad shown, then taken to a corner of it, two ways a person does:
 *   - 'pan': two fingers pull the picture toward the top-left, clear of the
 *     pad's clusters (a finger on one leaves a one-finger drag, which moves
 *     the pointer instead).
 *   - 'pointer': one finger walks the pointer to the bottom-right and the
 *     camera follows it (follow-cursor, on by default). Not two fingers
 *     there: a two-finger pan settles short of the right and bottom edges
 *     (the stage clamps between the two fingers' separate pointer moves, a
 *     transient zoom), so it never reaches the far edges' offers.
 *  `sideways`: a phone turned sideways (844x390), with a pinned key too — the
 *  shape where the pad's default places cover the middle of both side edges. */
async function hopStage(route, sideways = false, knobs = null) {
    const storage = { 'device-stage-virtual-mouse': 'on' };
    if (sideways) storage['device-stage-pinned-keys'] = JSON.stringify([{ id: 'hoppin', code: 'F5', mods: [] }]);
    const o = await open(knobs, { monitors: HOP_DESK, storage, viewport: sideways ? { width: 844, height: 390 } : { width: 390, height: 844 } });
    await o.page.evaluate(() => window.__stage.setActive(0));
    await o.page.waitForTimeout(1500);
    const s = await o.page.evaluate(() => { const r = document.querySelector('.device-stage-surface').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const fitted = await o.page.locator('.device-stage-hop').count();
    await o.pinch(s, 60, 360);
    await o.page.waitForTimeout(400);
    const zoom = await o.page.evaluate(() => window.__stage.transform()?.scale ?? 0);
    ck('precondition: the pinch zoomed in (x4 or more)', zoom >= 4, `x${zoom}`);
    await o.page.evaluate(() => { window.__stage.inputs.length = 0; });
    for (let i = 0; i < (sideways ? 8 : 6); i++) {
        if (route === 'pan') await o.pan2({ x: s.x - 125, y: sideways ? 40 : 150 }, 250, sideways ? 200 : 300);
        else if (sideways) await o.drag({ x: 300, y: 60 }, { x: 600, y: 250 }, 12);
        else await o.drag({ x: 100, y: 200 }, { x: 330, y: 420 }, 12);
        await o.page.waitForTimeout(300);
    }
    await o.page.waitForTimeout(500);
    const sent = await o.page.evaluate(() => window.__stage.inputs.map(e => e.t));
    if (route === 'pan') ck('precondition: the two-finger pans moved the view, not the pointer', sent.length === 0, sent.join(',') || 'nothing sent');
    else ck('precondition: the drags moved the pointer and pressed nothing', sent.length > 0 && sent.every(t => t === 'move'), `${sent.length} sent: ${[...new Set(sent)].join(',')}`);
    return { ...o, fitted };
}

/** A chip pressed, then really tapped.
 *  PRESSED: it stays put and unfaded (mobile.css's `button:active` transform
 *  once replaced its centring and slid it 22 px under the finger). The press
 *  state is FORCED through DevTools (CSS.forcePseudoState): a CDP touch held
 *  down never turns :active on in headless Chromium, so a held finger could
 *  not show it; that the press styles did apply is the precondition (the
 *  disc darkens).
 *  TAPPED (a real touch): no focus taken from a field being typed into,
 *  the screen it names shown, nothing pressed over there. */
async function hopPress(o, dir, monitorId, name) {
    const { page, cdp, tap } = o;
    const before = await hopChip(page, dir);
    ck(`hop ${dir}: the chip is there to press`, !!before);
    if (!before) return;
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `.device-stage-hop-${dir}` });
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const pressed = await page.evaluate(dir => {
        const b = document.querySelector(`.device-stage-hop-${dir}`);
        const r = b.getBoundingClientRect();
        const disc = getComputedStyle(b.querySelector('.device-stage-hop-icon')).backgroundColor;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, opacity: getComputedStyle(b).opacity, disc };
    }, dir);
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    ck(`hop ${dir}: precondition: the press styles apply when pressed (the disc darkens)`, pressed.disc === 'rgba(0, 0, 0, 0.8)', pressed.disc);
    ck(`hop ${dir}: …pressed, it stays where it is and does not fade`,
        Math.hypot(pressed.x - before.x, pressed.y - before.y) < 0.5 && pressed.opacity === '1',
        `moved ${Math.hypot(pressed.x - before.x, pressed.y - before.y).toFixed(1)} px, opacity ${pressed.opacity}`);

    await page.evaluate(() => {
        const i = document.createElement('input');
        i.id = 'hop-focus-probe';
        i.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
        document.body.appendChild(i);
        i.focus();
    });
    await page.evaluate(() => { window.__stage.inputs.length = 0; });
    const asked = await page.evaluate(() => window.__stage.monitorRequests.length);
    // What the tap produced, for the failure line: whether a click reached
    // the arrow at all tells a lost tap from a hop that refused to go.
    await page.evaluate(dir => {
        window.__hopTapEvents = [];
        const b = document.querySelector(`.device-stage-hop-${dir}`);
        for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'click', 'contextmenu']) {
            b.addEventListener(t, () => window.__hopTapEvents.push(t), true);
        }
    }, dir);
    await tap({ x: before.x, y: before.y });
    await page.waitForTimeout(100);
    const focus = await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName);
    ck(`hop ${dir}: a real tap on it takes no focus from the field being typed into`, focus === 'hop-focus-probe', `focus on ${focus}`);
    await page.waitForTimeout(1200);
    const r = await page.evaluate(n => ({
        asked: window.__stage.monitorRequests.slice(n).map(q => q.monitor),
        active: window.__stage.state.activeMonitor,
        sent: window.__stage.inputs.map(e => e.t),
        events: window.__hopTapEvents ?? [],
    }), asked);
    ck(`…and switches to the ${name}`, r.asked.join(',') === String(monitorId) && r.active === monitorId,
        `asked for ${r.asked.join(',') || 'nothing'}, now on ${r.active}; the arrow saw ${r.events.join(',') || 'nothing'}`);
    // The one move the trackpad mode may send is the stage carrying its
    // pointer across the seam AFTER the host confirmed (vitest pins it);
    // nothing the tap itself made may reach the far side.
    ck('…and presses nothing on the far side', r.sent.filter(t => t !== 'move').length === 0 && r.sent.filter(t => t === 'move').length <= 1,
        r.sent.join(',') || 'nothing sent');
}

/** CONTROL for the sideways runs: at its centred spot the chip WOULD be under
 *  one of the pad's clusters — what a tap there hits is the cluster. */
const coveredAtCentre = (page, dir) => page.evaluate(dir => {
    const b = document.querySelector(`.device-stage-hop-${dir}`);
    const shift = Number(b?.dataset.hopShift) || 0;
    if (!b || !shift) return null;
    const r = b.getBoundingClientRect();
    const sideways = dir === 'left' || dir === 'right';
    const x = r.left + r.width / 2 - (sideways ? 0 : shift);
    const y = r.top + r.height / 2 - (sideways ? shift : 0);
    return document.elementFromPoint(x, y)?.closest('.device-stage-virtual-mouse')?.className ?? null;
}, dir);

{
    // Toward the top-left: two fingers carry the picture right and down.
    const o = await hopStage('pan');
    const { ctx, page, tap, fitted } = o;
    ck('CONTROL: a fitted view offers no hop', fitted === 0, `${fitted} chips`);
    const dirs = await page.evaluate(() => [...document.querySelectorAll('.device-stage-hop')].map(b => b.className));
    ck('precondition: panned into the top-left corner, the left and up hops are offered', dirs.length === 2, dirs.join(' | '));
    const left = await checkHopChip(page, 'left', 'Left display (2560x1440)');
    await checkHopChip(page, 'up', 'Top display (2560x1440)');
    await page.screenshot({ path: join(outdir, 'phone-hop-left-up.png') });

    // NEGATIVE CONTROL: the chip as it was (no touch-layout class) fails the
    // bound. Its transition off, or the shots catch it half way (every button
    // has `transition: all`).
    await page.evaluate(() => {
        const b = document.querySelector('.device-stage-hop-left');
        b.style.transition = 'none';
        b.classList.remove('device-stage-hop-compact');
    });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const old = await hopPainted(page, 'left');
    const oldC = await hopChip(page, 'left');
    ck('NEGATIVE CONTROL: precondition: the picture under the old chip holds still', old.noise.area === 0, `${old.noise.area.toFixed(1)} px² differ`);
    ck(`NEGATIVE CONTROL: the chip as it was paints more than ${HOP_PAINT_MAX} px a side`,
        old.painted.w > HOP_PAINT_MAX || old.painted.h > HOP_PAINT_MAX,
        `${old.painted.w.toFixed(1)}x${old.painted.h.toFixed(1)}, ${Math.round(old.painted.area)} px²`);
    ck('…(the desktop look it keeps: its words at 4.5:1 or more over a white picture)', !!oldC && oldC.wordsShown && oldC.wordsContrast >= 4.5,
        oldC ? `${oldC.wordsContrast?.toFixed(2)}:1` : 'missing');
    await page.screenshot({ path: join(outdir, 'phone-hop-as-it-was.png') });
    await page.evaluate(async () => {
        const b = document.querySelector('.device-stage-hop-left');
        b.classList.add('device-stage-hop-compact');
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        b.style.transition = '';
    });

    // POSITIVE CONTROL: the rig sees a press reach the far side — a real tap
    // on the picture clicks it.
    await page.evaluate(() => { window.__stage.inputs.length = 0; });
    await tap({ x: 195, y: 300 });
    await page.waitForTimeout(300);
    const onPicture = await page.evaluate(() => window.__stage.inputs.map(e => e.t));
    ck('POSITIVE CONTROL: a real tap on the picture presses on the far side', onPicture.includes('down'), onPicture.join(',') || 'nothing');

    if (left) await hopPress(o, 'left', 1, 'left screen');
    await ctx.close();
}
{
    // Toward the bottom-right: the pointer walked there, the camera after it.
    const o = await hopStage('pointer');
    const { ctx, page, tap } = o;
    const dirs = await page.evaluate(() => [...document.querySelectorAll('.device-stage-hop')].map(b => b.className));
    ck('precondition: following the pointer into the bottom-right corner, the right and down hops are offered', dirs.length === 2, dirs.join(' | '));
    await checkHopChip(page, 'right', 'Right display (2560x1440)');
    const down = await checkHopChip(page, 'down', 'Bottom display (2560x1440)');
    await page.screenshot({ path: join(outdir, 'phone-hop-right-down.png') });
    if (down) {
        // THE FEEDBACK LINE DOES NOT MOVE IT. The line lets touches through
        // and comes and goes on its own (6 s); an arrow that stepped aside for
        // it snapped back as it went, out from under a finger aimed at it.
        // Here the line's band touches the arrow's target, the case that
        // moved it.
        await page.evaluate(() => { window.__stage.state.powerNotice = 'Turned off 2 of 2 other displays'; window.__stage.emit(); });
        await page.waitForTimeout(400);
        // Whatever triggers a placement (a finger lifted anywhere does), the
        // line must not count: make one happen while it is up.
        await page.evaluate(() => { window.dispatchEvent(new PointerEvent('pointerup')); });
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        const line = await page.evaluate(() => { const r = document.querySelector('.device-stage-mobile-error')?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom } : null; });
        const withNote = await hopChip(page, 'down');
        ck('hop down: precondition: the feedback line is up, its band within 4 px of the arrow',
            !!line && !!withNote && line.bottom >= withNote.top - 4, line && withNote ? `line ${Math.round(line.top)}..${Math.round(line.bottom)}, arrow from ${Math.round(withNote.top)}` : 'no line');
        ck('hop down: …the arrow stays where it was, and a tap on it still reaches it',
            !!withNote && withNote.shift === 0 && Math.abs(withNote.x - down.x) < 0.5 && withNote.hitCentre,
            withNote ? `shift ${withNote.shift}, x ${Math.round(withNote.x)} (was ${Math.round(down.x)}), hit ${withNote.hitCentre}` : 'gone');
        await page.evaluate(() => { window.__stage.state.powerNotice = null; window.__stage.emit(); });
        await page.waitForTimeout(200);

        // ABOVE THE PAUSED BANNER: paused by a hardware keyboard's chord, the
        // arrow is clear of the banner (whose Resume is 44 px on a touch
        // screen) and still on the bottom edge's centre line.
        await page.keyboard.down('Control'); await page.keyboard.down('Alt');
        await page.keyboard.press('Home');
        await page.keyboard.up('Alt'); await page.keyboard.up('Control');
        await page.waitForTimeout(300);
        const paused = await page.evaluate(() => {
            const banner = document.querySelector('.device-stage-paused')?.getBoundingClientRect();
            const b = document.querySelector('.device-stage-hop-down');
            if (!banner || !b) return null;
            const r = b.getBoundingClientRect();
            const s = document.querySelector('.device-stage-surface').getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
                clear: r.bottom <= banner.top || r.top >= banner.bottom || r.right <= banner.left || r.left >= banner.right,
                centred: Math.abs(r.left + r.width / 2 - (s.left + s.right) / 2) <= 1,
                hit: !!hit && (hit === b || b.contains(hit)),
                gap: Math.round(banner.top - r.bottom),
            };
        });
        ck('hop down: paused, the arrow is clear of the paused banner, centred, and what a tap hits',
            !!paused && paused.clear && paused.centred && paused.hit, paused ? `gap ${paused.gap} px, centred ${paused.centred}, hit ${paused.hit}` : 'no banner or no arrow');
        const resume = await page.locator('.device-stage-paused button').boundingBox();
        if (resume) await tap({ x: resume.x + resume.width / 2, y: resume.y + resume.height / 2 });
        await page.waitForTimeout(300);
        ck('…(resumed for what follows)', (await page.locator('.device-stage-paused').count()) === 0);

        await hopPress(o, 'down', 4, 'bottom screen (beside the toolbar)');
    }
    await ctx.close();
}
// SIDEWAYS (844x390), the pad at its default places and a pinned key: the
// L/M/R row covers the middle of the left edge and the scroll column the
// middle of the right one, so each side chip must slide out from under them.
{
    // An agent too old to say the pointer's shape, this run: the stage's
    // "runs an older Púca" band comes up across the top, where the up arrow
    // sits.
    const o = await hopStage('pan', true, { sendsShapes: false });
    const { ctx, page } = o;
    const dirs = await page.evaluate(() => [...document.querySelectorAll('.device-stage-hop')].map(b => b.className));
    ck('sideways: precondition: panned into the top-left corner, the left and up hops are offered', dirs.length === 2, dirs.join(' | '));
    const under = await coveredAtCentre(page, 'left');
    ck('sideways: CONTROL: at its centred spot the left chip would be under the mouse pad', !!under, under ?? 'not covered (or not slid)');
    await checkHopChip(page, 'left', 'Left display (2560x1440)', true);
    await checkHopChip(page, 'up', 'Top display (2560x1440)');
    await page.screenshot({ path: join(outdir, 'phone-sideways-hop-left-up.png') });
    // THE OLDER-AGENT BAND DOES NOT MOVE IT: the band lets touches through,
    // is drawn under the arrow and comes and goes on its own, so an arrow
    // that stepped aside for it would move out from under a finger.
    await page.waitForFunction(() => !!document.querySelector('.device-stage-older-host'), null, { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => { window.dispatchEvent(new PointerEvent('pointerup')); });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const band = await page.evaluate(() => { const r = document.querySelector('.device-stage-older-host')?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null; });
    const upNow = await hopChip(page, 'up');
    ck('sideways: precondition: the older-agent band is up, across the up arrow\'s spot',
        !!band && !!upNow && band.left < upNow.right && band.right > upNow.left && band.top < upNow.bottom && band.bottom > upNow.top,
        band ? `band ${Math.round(band.left)}..${Math.round(band.right)} x ${Math.round(band.top)}..${Math.round(band.bottom)}` : 'no band');
    ck('sideways: …the up arrow stays centred over it, and is what a tap hits',
        !!upNow && upNow.shift === 0 && upNow.hitCentre && upNow.hitCorners,
        upNow ? `shift ${upNow.shift}, hit ${upNow.hitCentre}/${upNow.hitCorners}` : 'gone');
    // Measured again (a resize, a finger lifted elsewhere), a slid arrow stays
    // where it is: the read-back of its own shift is exact, so it does not
    // alternate between slid and centred.
    const shifts = () => page.evaluate(() => [...document.querySelectorAll('.device-stage-hop')].map(b => `${b.dataset.hopDir}:${b.dataset.hopShift}`).join(' '));
    const first = await shifts();
    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => { window.dispatchEvent(new Event('resize')); window.dispatchEvent(new PointerEvent('pointerup')); });
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    ck('sideways: measured again three times, the arrows stay where they are', (await shifts()) === first, `${first} -> ${await shifts()}`);
    await hopPress(o, 'left', 1, 'left screen');
    await ctx.close();
}
{
    const o = await hopStage('pointer', true);
    const { ctx, page } = o;
    const dirs = await page.evaluate(() => [...document.querySelectorAll('.device-stage-hop')].map(b => b.className));
    ck('sideways: precondition: following the pointer into the bottom-right corner, the right and down hops are offered', dirs.length === 2, dirs.join(' | '));
    const under = await coveredAtCentre(page, 'right');
    ck('sideways: CONTROL: at its centred spot the right chip would be under the scroll column', !!under, under ?? 'not covered (or not slid)');
    await checkHopChip(page, 'right', 'Right display (2560x1440)', true);
    await checkHopChip(page, 'down', 'Bottom display (2560x1440)');
    await page.screenshot({ path: join(outdir, 'phone-sideways-hop-right-down.png') });
    // A CLUSTER DRAGGED OVER A SHOWING ARROW: the L/M/R row, by its grip and
    // a real finger, dropped on the bottom arrow. The arrow steps aside when
    // the finger lifts.
    const grip = await page.evaluate(() => {
        const g = document.querySelector('.vm-cluster-buttons .vm-grip')?.getBoundingClientRect();
        const c = document.querySelector('.vm-cluster-buttons')?.getBoundingClientRect();
        const d = document.querySelector('.device-stage-hop-down')?.getBoundingClientRect();
        return g && c && d ? { gx: g.left + g.width / 2, gy: g.top + g.height / 2, dx: (d.left + d.right) / 2 - (c.left + c.right) / 2, dy: (d.top + d.bottom) / 2 - (c.top + c.bottom) / 2 } : null;
    });
    if (grip) {
        await page.evaluate(() => { window.__stage.inputs.length = 0; });
        await o.drag({ x: grip.gx, y: grip.gy }, { x: grip.gx + grip.dx, y: grip.gy + grip.dy }, 12);
        await page.waitForTimeout(300);
        const under = await coveredAtCentre(page, 'down');
        ck('sideways: precondition: the L/M/R row now covers the bottom arrow\'s centred spot', !!under, under ?? 'not covered (or the arrow did not move)');
        const after = await hopChip(page, 'down');
        ck('sideways: …the arrow stepped aside, clear of it, and is what a tap hits',
            !!after && after.shift !== 0 && after.overlaps.length === 0 && after.hitCentre && after.hitCorners,
            after ? `shift ${after.shift}, overlaps ${after.overlaps.join(', ') || 'none'}, hit ${after.hitCentre}/${after.hitCorners}` : 'gone');
        const sent = await page.evaluate(() => window.__stage.inputs.map(e => e.t));
        ck('…(dragging the row by its grip sent nothing over there)', sent.length === 0, sent.join(',') || 'nothing sent');
        await page.screenshot({ path: join(outdir, 'phone-sideways-hop-row-dragged.png') });
    } else ck('sideways: precondition: the L/M/R row and the bottom arrow are on the page', false);
    await hopPress(o, 'right', 2, 'right screen');
    await ctx.close();
}

await browser.close();
server.close();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
