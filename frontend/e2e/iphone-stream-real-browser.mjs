// Watching a stream on a PHONE, in real browsers: the shipped StreamStage and
// docked StreamPip inside the real phone chat chrome (e2e/iphone-stream/, built
// by vite.iphoneharness.config.ts), portrait and sideways.
//
// Written for the owner's iPhone report (0.9.848, Safari, a friend's stream in
// a voice call): "full screen on the web app stream does nothing, horizontal
// mode is really bad and cant even see the stream at all". The geometry was
// measured in the live app first (e2e/iphone-stream-live.mjs): at 844x390 the
// chat header, composer, voice bar and nav took 286 px and the stage got a
// 17 px strip under the composer.
//
// Engines: Chromium as an iPhone (390x844 screen, touch, the iPhone user
// agent; it carries a LIVE picture, a canvas behind captureStream) and
// Playwright's WebKit (Safari's engine; on Windows it has no MediaStream, so
// its tile has no picture and only the layout is checked). Sizes: 390x844
// portrait, 844x390 sideways (the Home Screen app), 750x340 sideways (a
// Safari tab: its toolbar and side margins take the rest — an approximation,
// the exact size depends on the toolbar state).
//
// Checks, each a PASS/FAIL line:
//   1. Sideways with a stream on the stage: the stage covers the viewport, the
//      picture fills it (one side flush), its middle is the picture (nothing
//      over it), the chat's header, composer and nav are not reachable under
//      it; every control is at least 44 px, inside the window and inside the
//      safe areas (a notch simulated through mobile.css's --safe-area-*), and
//      no two overlap; the voice bar's mute is one tap away; a tap on the
//      picture hides every control (none hit-testable) and another brings
//      them back; idle, they hide by themselves; Chat leaves the takeover.
//   2. Sideways chat (no stage): header, composer, voice bar and nav each on
//      screen, hit-testable and disjoint, nav buttons >= 44 px, and the
//      message list keeps >= 120 px; with the docked mini-player, the player
//      AND >= 120 px of list.
//   3. Portrait stays what worked: no takeover, the stage under the header
//      with the composer below it and reachable.
//   4. Fullscreen on an engine without element fullscreen (the iPhone shape:
//      requestFullscreen removed, fullscreenEnabled false): the stream fills
//      the screen in-app, its exit is 44 px and hit-testable, and it leaves.
//   5. Desktop and Android unchanged: a 1280x800 fine-pointer window asks the
//      TILE for real fullscreen exactly as before and never takes over, nor
//      does a short 1000x400 one; a portrait Android phone (a browser: the
//      Android APP's fullscreen is e2e/android-stream-fullscreen-live.mjs's)
//      takes no takeover and asks the tile, and neither does one typing upright with the keyboard shrinking its
//      viewport to 360x278 (the composer keeps its width beside the docked
//      player; the old viewport-shaped rule as the control that must fail).
//   6. The controls in reach: a touch on the voice bar (outside the stage)
//      restarts the clock; Tab brings hidden controls back and keyboard focus
//      on one keeps them up; a control session lays them out above and below
//      the remote screen, never over it (the overlay as the control).
//   7. A control session in the IN-APP fullscreen (Chromium), in the Android
//      APP (its bridge faked: e2e/iphone-stream/checks.mjs FAKE_ANDROID_APP)
//      sideways and upright, and on the iPhone shape sideways: Fullscreen is
//      the bare picture first (the Android app: no voice bar, no stage header,
//      SystemBars hidden); once a session starts the header is above the
//      remote screen and the voice bar below it, the WHOLE remote picture is
//      between them, every one of 35 points across it is the capture surface
//      (elementFromPoint), the stage still holds the window and the bars stay
//      hidden, Chat and Mute in reach; the session ending gives the bare
//      picture back. CONTROL (must fail): the rule that puts the tile in the
//      picture's row taken out of the stylesheet (the tile fixed to the
//      window, under the header and the voice bar).
//   8. FOCUS VIEW with a filmstrip (two streams) in the Android APP's in-app
//      fullscreen (Chromium, the bridge faked), sideways 844x390 and upright
//      390x844: Fullscreen on the stage makes it the whole window (its
//      edges and 27 points across the window are the tile, the live picture
//      centred with one side flush), Exit fullscreen 44 px and hit; a control
//      session in it gets 7's checks and its tile fills the picture's row
//      (header to voice bar, edge to edge); Exit gives the layout back; a filmstrip
//      THUMB put in fullscreen from its menu is the stage there (the whole
//      window, opacity 1, its Exit fullscreen 44 px and hit) and its Exit
//      gives the stage back to the stream that had it. CONTROL (must fail):
//      the focus-view rule taken out of the stylesheet (the stage's filmstrip
//      row leaves the tile 112 px short sideways, 76 upright).
//   "Sideways" is the DEVICE turning (api/phoneSideways.ts): Chromium's
//   emulation turns its screen with the viewport; Playwright's WebKit always
//   reports landscape-primary, so its screen orientation is made to follow
//   its emulated screen (ORIENTATION_FOLLOWS_SCREEN).
//   NEGATIVE CONTROLS, which must FAIL: the same checks with the new rules
//   removed from the page's stylesheets (the old layout: 1 and 2 fail), and
//   the old fullscreen call on the iPhone shape (nothing fills the screen).
//
// No server, no audio (--mute-audio; the stand-in picture has no sound).
//   cd frontend && node e2e/iphone-stream-real-browser.mjs [outdir]
// Needs WebKit once:  npx playwright install webkit
import { chromium, webkit, devices } from '@playwright/test';
import { muteWebkit } from './muted.mjs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ANDROID_UA, CONTROL_SESSION, FAKE_ANDROID_APP, IPHONE_FULLSCREEN, IPHONE_UA, OLD_LAYOUT, ORIENTATION_FOLLOWS_SCREEN, ORIENTATION_UPRIGHT, RECORD_FULLSCREEN,
    insets, measure, overlap,
} from './iphone-stream/checks.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));
const outdir = process.argv[2] || join(here, 'e2e-artifacts', 'iphone-stream-shots');
await mkdir(outdir, { recursive: true });
execFileSync(process.execPath, [join(here, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.iphoneharness.config.ts', '--logLevel', 'error'], { cwd: here, stdio: 'inherit' });
const ROOT = join(here, 'e2e-artifacts', 'iphone-stream-dist');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };
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
const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };
/** A negative control: the check must come out false. */
const control = (n, wouldPass, detail) => ck(`CONTROL (must fail): ${n}`, !wouldPass, detail);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** The sideways stream checks. Returns whether the core ones held (for the controls). */
async function streamSideways(page, tag, { live, inset }) {
    const m = await measure(page);
    const covers = !!m.stage && m.stage.l <= 0.5 && m.stage.t <= 0.5 && m.stage.r >= m.vw - 0.5 && m.stage.b >= m.vh - 0.5;
    const fills = !!m.picture && (m.picture.live
        ? (m.picture.h >= m.vh - 1 || m.picture.w >= m.vw - 1)
        : (m.picture.w >= m.vw - 1 && m.picture.h >= m.vh - 1));
    const chatGone = !['.chat-header', '.message-form', '.mobile-bottom-nav'].some((s) => m.parts[s]?.hit);
    const res = { covers, fills, centre: m.pictureCentreHit, chatGone };
    if (live === undefined) return { res, m };
    ck(`${tag}: the stage covers the whole ${m.vw}x${m.vh} window`, covers, JSON.stringify(m.stage));
    ck(`${tag}: the picture fills it (one side flush${live ? ', live frames' : ', layout only'})`, fills && (!live || m.liveFrames), JSON.stringify(m.picture));
    ck(`${tag}: the middle of the picture is the picture (nothing over it)`, m.pictureCentreHit);
    ck(`${tag}: the chat header, composer and nav are not reachable under it`, chatGone, JSON.stringify(m.parts));
    ck(`${tag}: no sideways scroll (scrollWidth ${m.sw} <= clientWidth ${m.vw})`, m.sw <= m.vw);
    const small = m.buttons.filter((b) => b.w < 44 - 0.5 || b.h < 44 - 0.5);
    ck(`${tag}: every control (${m.buttons.length}) is at least 44x44`, m.buttons.length >= 6 && small.length === 0, JSON.stringify(small));
    const L = inset.left ?? 0, R = inset.right ?? 0, T = inset.top ?? 0, B = inset.bottom ?? 0;
    const outside = m.buttons.filter((b) => b.l < L - 0.5 || b.t < T - 0.5 || b.r > m.vw - R + 0.5 || b.b > m.vh - B + 0.5);
    ck(`${tag}: every control is inside the safe areas (L${L} R${R} T${T} B${B})`, outside.length === 0, JSON.stringify(outside));
    const covered = m.buttons.filter((b) => !b.hit);
    ck(`${tag}: a tap at every control's centre lands on it`, covered.length === 0, JSON.stringify(covered));
    const pairs = [];
    for (let i = 0; i < m.buttons.length; i++) for (let j = i + 1; j < m.buttons.length; j++) if (overlap(m.buttons[i], m.buttons[j]) > 1) pairs.push([m.buttons[i].label, m.buttons[j].label]);
    ck(`${tag}: no two controls overlap`, pairs.length === 0, JSON.stringify(pairs));
    ck(`${tag}: the voice bar's mute is one tap away`, !!m.mute?.hit, JSON.stringify(m.mute));
    return { res, m };
}

async function chatSideways(page, tag, { withPip }) {
    const m = await measure(page);
    const names = ['.chat-header', '.message-form', '.voice-panel-compact', '.mobile-bottom-nav'];
    const each = names.every((s) => m.parts[s]?.shown && m.parts[s]?.hit && m.parts[s].t >= -0.5 && m.parts[s].b <= m.vh + 0.5);
    let disjoint = true;
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (overlap(m.parts[names[i]], m.parts[names[j]]) > 1) disjoint = false;
    const list = m.parts['.messages-container'];
    const listH = list ? list.h : 0;
    const pipOk = !withPip || (!!m.parts['.stream-pip']?.shown && m.parts['.stream-pip'].h >= 150 && overlap(m.parts['.stream-pip'], list) < 1);
    return { m, each, disjoint, listH, pipOk, navOk: m.navBtns.length === 6 && m.navBtns.every((b) => b.h >= 44 - 0.5) };
}

/** Init scripts every page of the running engine gets (WebKit's orientation). */
let engineInit = [];

async function openPage(browser, opts, { init = [], view = 'stream', streams = 1 } = {}) {
    const ctx = await browser.newContext(opts);
    for (const i of [...engineInit, ...init]) await ctx.addInitScript(i);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    await page.goto(`${base}?view=${view}&streams=${streams}`);
    await page.waitForSelector(view === 'stream' ? '.stream-stage' : '.chat-header', { timeout: 20000 });
    await sleep(600);
    return { ctx, page, errors };
}

const tapAt = async (page, x, y) => { await page.touchscreen.tap(x, y).catch(async () => page.mouse.click(x, y)); await sleep(350); };

async function suite(browser, engine) {
    const live = engine === 'chromium';
    const phone = engine === 'chromium'
        ? { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA }
        : { ...devices['iPhone 15'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
    delete phone.defaultBrowserType;
    engineInit = engine === 'webkit' ? [ORIENTATION_FOLLOWS_SCREEN] : [];
    console.log(`\n===== ${engine} as an iPhone =====`);

    // ---- 3. Portrait: what worked keeps working.
    {
        const { ctx, page, errors } = await openPage(browser, phone);
        if (live) await page.waitForFunction(() => (document.querySelector('.stream-stage video')?.videoWidth ?? 0) > 0, null, { timeout: 10000 }).catch(() => {});
        const m = await measure(page);
        ck(`${engine} 390x844: the app's phone layout applies (coarse pointer)`, await page.evaluate(() => matchMedia('(pointer: coarse) and (max-width: 1024px)').matches));
        ck(`${engine} 390x844 portrait: no takeover`, m.takeover === null);
        ck(`${engine} 390x844 portrait: the stage sits under the chat header`, !!m.stage && m.stage.t >= m.parts['.chat-header'].b - 0.5);
        ck(`${engine} 390x844 portrait: the composer is below the stage and reachable`, !!m.parts['.message-form']?.hit && m.parts['.message-form'].t >= m.stage.b - 0.5);
        ck(`${engine} 390x844 portrait: the tile's controls are 44 px and reachable`, m.buttons.filter(b => /Fullscreen|Mute stream|Unmute stream|Stop Watching/.test(b.label)).every(b => b.w >= 43.5 && b.h >= 43.5 && b.hit), JSON.stringify(m.buttons));
        if (live) ck(`${engine} 390x844 portrait: the picture is live`, m.liveFrames);
        ck(`${engine} 390x844 portrait: no sideways scroll`, m.sw <= m.vw, `${m.sw} > ${m.vw}`);
        await page.screenshot({ path: join(outdir, `${engine}-390x844-portrait-stream.png`) });
        ck(`${engine}: no page errors`, errors.length === 0, errors.join(' | '));
        await ctx.close();
    }

    // ---- 1. Sideways with a stream, Home Screen size and Safari-tab size.
    for (const [w, h, name, inset] of [
        [844, 390, 'Home Screen app', { left: 47, right: 47, bottom: 21 }],
        [750, 340, 'Safari tab', {}],
    ]) {
        const tag = `${engine} ${w}x${h} sideways (${name})`;
        const { ctx, page, errors } = await openPage(browser, { ...phone, viewport: { width: w, height: h }, screen: { width: 844, height: 390 } });
        await insets(page, inset);
        if (live) await page.waitForFunction(() => (document.querySelector('.stream-stage video')?.videoWidth ?? 0) > 0, null, { timeout: 10000 }).catch(() => {});
        await sleep(300);
        const take = await page.evaluate(() => document.documentElement.dataset.streamTakeover ?? null);
        ck(`${tag}: the stage takes over the screen`, take === 'landscape', String(take));
        await streamSideways(page, tag, { live, inset });
        await page.screenshot({ path: join(outdir, `${engine}-${w}x${h}-stream-controls.png`) });

        // A tap on the picture hides everything; another brings it back.
        const before = await measure(page);
        await tapAt(page, before.vw / 2, before.vh / 2);
        const hidden = await measure(page);
        const stillHit = await page.evaluate((btns) => btns.filter((b) => {
            const h = document.elementFromPoint(b.l + b.w / 2, b.t + b.h / 2);
            return !!h && !!h.closest('button');
        }).map((b) => b.label), before.buttons);
        ck(`${tag}: a tap on the picture hides every control (none hit-testable)`, hidden.chrome === 'hidden' && stillHit.length === 0, JSON.stringify({ chrome: hidden.chrome, stillHit }));
        ck(`${tag}: ...and the voice bar with them`, !hidden.parts['.voice-panel-compact']?.shown);
        await page.screenshot({ path: join(outdir, `${engine}-${w}x${h}-stream-clean.png`) });
        await tapAt(page, before.vw / 2, before.vh / 2);
        const back = await measure(page);
        ck(`${tag}: another tap brings them back`, back.chrome === null && !!back.mute?.hit);
        await sleep(4600);
        ck(`${tag}: left alone, they hide by themselves`, (await measure(page)).chrome === 'hidden');
        await tapAt(page, before.vw / 2, before.vh / 2);

        // 6. A touch on the voice bar (portaled outside the stage) restarts
        // the clock: Mute at ~3 s, still up 1.7 s later, gone ~4 s after it.
        await sleep(3000);
        await tapAt(page, back.mute.l + back.mute.w / 2, back.mute.t + back.mute.h / 2);
        await sleep(1350);
        ck(`${tag}: a touch on the voice bar keeps the controls up (4.7 s after they came back)`, (await measure(page)).chrome === null);
        await sleep(2700);
        ck(`${tag}: ...and they hide 4 s after that touch`, (await measure(page)).chrome === 'hidden');
        // Hidden, a key brings them back with focus on a control, and
        // keyboard focus on a control keeps them up.
        await page.keyboard.press('Tab');
        await sleep(300);
        const kb = await page.evaluate(() => ({ chrome: document.documentElement.dataset.streamChrome ?? null, on: !!document.activeElement?.closest('.stream-stage, .voice-panel-compact') }));
        ck(`${tag}: Tab brings hidden controls back, focus on one of them`, kb.chrome === null && kb.on, JSON.stringify(kb));
        await sleep(4600);
        ck(`${tag}: keyboard focus on a control keeps them up past the idle time`, (await measure(page)).chrome === null);
        await page.evaluate(() => (document.activeElement)?.blur?.());
        if ((await measure(page)).chrome === 'hidden') await tapAt(page, before.vw / 2, before.vh / 2);

        // Chat: out of the takeover, into the chat with the docked player.
        await page.locator('.stream-stage-header .back-to-chat-btn').first().click();
        await page.waitForSelector('.stream-pip', { timeout: 5000 }).catch(() => {});
        await sleep(400);
        const c = await chatSideways(page, `${tag} chat`, { withPip: true });
        ck(`${tag}: Chat leaves the takeover`, c.m.takeover === null);
        ck(`${tag}: chat + docked player: header, composer, voice bar, nav on screen, reachable, disjoint`, c.each && c.disjoint, JSON.stringify(c.m.parts));
        ck(`${tag}: chat + docked player: the player is beside the list, the list keeps >= 120 px`, c.pipOk && c.listH >= 120, JSON.stringify({ list: c.m.parts['.messages-container'], pip: c.m.parts['.stream-pip'] }));
        await page.screenshot({ path: join(outdir, `${engine}-${w}x${h}-chat-with-player.png`) });
        ck(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
        await ctx.close();
    }

    // ---- 2. Sideways chat, nothing being watched.
    for (const [w, h] of [[844, 390], [750, 340]]) {
        const tag = `${engine} ${w}x${h} sideways chat`;
        const { ctx, page } = await openPage(browser, { ...phone, viewport: { width: w, height: h }, screen: { width: 844, height: 390 } }, { view: 'chat' });
        const c = await chatSideways(page, tag, { withPip: false });
        ck(`${tag}: header, composer, voice bar and nav on screen, reachable and disjoint`, c.each && c.disjoint, JSON.stringify(c.m.parts));
        ck(`${tag}: every nav tab is at least 44 px tall`, c.navOk, JSON.stringify(c.m.navBtns));
        ck(`${tag}: the message list keeps >= 120 px (${Math.round(c.listH)})`, c.listH >= 120);
        await page.screenshot({ path: join(outdir, `${engine}-${w}x${h}-chat.png`) });
        // NEGATIVE CONTROL: the old layout.
        await page.evaluate(OLD_LAYOUT);
        await sleep(200);
        const o = await chatSideways(page, tag, { withPip: false });
        control(`${tag}, OLD layout: the message list keeps >= 120 px (${Math.round(o.listH)})`, o.listH >= 120);
        await ctx.close();
    }

    // ---- 6. A control session sideways: the controls beside the remote
    // screen, not over it (every tap on it is a click on the other computer).
    {
        const tag = `${engine} 844x390 control session`;
        const { ctx, page } = await openPage(browser, { ...phone, viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 } });
        // Settled: the voice bar re-measures itself (--mobile-voice-panel-h)
        // once the takeover has restyled it.
        await sleep(1200);
        // What StreamStage publishes with an active session (vitest pins that
        // it does), and the capture surface it lays over the tile.
        const layout = () => page.evaluate(() => {
            const r = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b ? { t: b.top, b: b.bottom, h: b.height } : null; };
            return {
                head: r('.stream-stage-header'), tile: r('.stream-tile'), grid: r('.stream-grid'), voice: r('.voice-panel-compact'),
                tileHead: getComputedStyle(document.querySelector('.stream-tile-header')).display,
                stagePad: getComputedStyle(document.querySelector('.stream-stage')).paddingBottom,
                barVar: getComputedStyle(document.documentElement).getPropertyValue('--mobile-voice-panel-h'),
            };
        });
        await page.evaluate(() => {
            document.documentElement.dataset.streamControlling = 'true';
            const cap = document.createElement('div');
            cap.className = 'control-capture';
            document.querySelector('.stream-tile').appendChild(cap);
        });
        await sleep(200);
        const l = await layout();
        const m = await measure(page);
        ck(`${tag}: the header is above the remote screen and the voice bar below it, nothing over it`, !!l.head && !!l.tile && !!l.voice && l.head.b <= l.tile.t + 0.5 && l.voice.t >= l.tile.b - 0.5 && l.tile.h >= 200, JSON.stringify(l));
        ck(`${tag}: the tile's own overlay steps aside (the capture surface covers it)`, l.tileHead === 'none');
        ck(`${tag}: Chat and the voice bar's Mute are in reach`, !!m.buttons.find((b) => /chat/i.test(b.label))?.hit && !!m.mute?.hit, JSON.stringify(m.buttons));
        await page.screenshot({ path: join(outdir, `${engine}-844x390-control-session.png`) });
        await page.evaluate(() => { delete document.documentElement.dataset.streamControlling; });
        await sleep(200);
        const o = await layout();
        control(`${tag}, without the session layout: nothing over the remote screen`, !!o.head && o.head.b <= o.tile.t + 0.5 && o.voice.t >= o.tile.b - 0.5, JSON.stringify(o));
        await ctx.close();
    }

    // ---- 1, NEGATIVE CONTROL: the old layout sideways must fail.
    {
        const { ctx, page } = await openPage(browser, { ...phone, viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 } }, { init: [OLD_LAYOUT] });
        await page.evaluate(OLD_LAYOUT);
        await sleep(300);
        const { res } = await streamSideways(page, 'old', {});
        control(`${engine} 844x390, OLD layout: the stage covers the window`, res.covers);
        control(`${engine} 844x390, OLD layout: the picture fills it with nothing over it`, res.fills && res.centre && res.chatGone);
        await page.screenshot({ path: join(outdir, `${engine}-844x390-OLD-layout.png`) });
        await ctx.close();
    }

    // ---- 4. Fullscreen on the iPhone shape (no element fullscreen at all).
    {
        const { ctx, page, errors } = await openPage(browser, phone, { init: [IPHONE_FULLSCREEN] });
        ck(`${engine} iPhone shape: no element fullscreen here (precondition)`, await page.evaluate(() => typeof document.body.requestFullscreen !== 'function' && document.fullscreenEnabled === false));
        // CONTROL: the old call does nothing.
        await page.evaluate(() => { const v = document.querySelector('.stream-stage video'); const t = v?.parentElement ?? v; t?.requestFullscreen?.(); });
        await sleep(300);
        const o = await measure(page);
        control(`${engine} iPhone shape, OLD fullscreen call: the stream fills the screen`, !!o.stage && o.stage.t <= 0.5 && o.stage.b >= o.vh - 0.5 && o.takeover !== null);
        await page.locator('.stream-tile-header button[aria-label="Fullscreen"]').first().tap();
        await sleep(1300); // past the system player's chance to begin (WebKit has webkitEnterFullscreen; this video has no metadata)
        const m = await measure(page);
        const tile = await page.evaluate(() => { const r = document.querySelector('.stream-tile.is-app-fullscreen')?.getBoundingClientRect(); return r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; });
        ck(`${engine} iPhone shape, Fullscreen: the stream fills the whole screen in-app`, m.takeover === 'fullscreen' && !!tile && tile.l <= 0.5 && tile.t <= 0.5 && tile.r >= m.vw - 0.5 && tile.b >= m.vh - 0.5, JSON.stringify({ takeover: m.takeover, tile }));
        const exit = m.buttons.find((b) => b.label === 'Exit fullscreen');
        ck(`${engine} iPhone shape, Fullscreen: Exit fullscreen is 44 px and a tap lands on it`, !!exit && exit.w >= 43.5 && exit.h >= 43.5 && exit.hit, JSON.stringify(exit));
        await page.screenshot({ path: join(outdir, `${engine}-390x844-in-app-fullscreen.png`) });
        await page.locator('.stream-tile-header button[aria-label="Exit fullscreen"]').first().tap();
        await sleep(300);
        const after = await measure(page);
        ck(`${engine} iPhone shape: Exit fullscreen gives the chat back (stage under the header again)`, after.takeover === null && after.stage.t >= after.parts['.chat-header'].b - 0.5 && !!after.parts['.message-form']?.hit);
        ck(`${engine} iPhone shape: no page errors`, errors.length === 0, errors.join(' | '));
        await ctx.close();
    }
}

// ---- 5. Desktop and Android: unchanged.
async function unchanged(browser) {
    console.log('\n===== unchanged surfaces (Chromium) =====');
    {
        const { ctx, page, errors } = await openPage(browser, { viewport: { width: 1280, height: 800 } }, { init: [RECORD_FULLSCREEN] });
        const m = await measure(page);
        ck('desktop 1280x800: the phone layout does not apply', !(await page.evaluate(() => matchMedia('(pointer: coarse) and (max-width: 1024px)').matches)));
        ck('desktop 1280x800: no takeover, the stage in the page flow', m.takeover === null && (await page.evaluate(() => getComputedStyle(document.querySelector('.stream-stage')).position)) === 'relative');
        await page.locator('.stream-tile').first().hover();
        await page.locator('.stream-tile-header button[aria-label="Fullscreen"]').first().click();
        await sleep(500);
        const calls = await page.evaluate(() => window.__fsCalls);
        ck('desktop: Fullscreen asks the TILE for real fullscreen, once, as before', calls.length === 1 && /stream-tile/.test(calls[0]), JSON.stringify(calls));
        ck('desktop: and never the in-app fullscreen', (await measure(page)).takeover === null);
        await page.keyboard.press('Escape');
        ck('desktop: no page errors', errors.length === 0, errors.join(' | '));
        await ctx.close();
    }
    {
        // A short, wide DESKTOP window is not a phone on its side.
        const { ctx, page } = await openPage(browser, { viewport: { width: 1000, height: 400 } });
        const m = await measure(page);
        const side = await page.evaluate(() => document.documentElement.dataset.phoneSideways ?? null);
        ck('desktop 1000x400: no takeover, not "sideways", the stage in the page flow', m.takeover === null && side === null
            && (await page.evaluate(() => getComputedStyle(document.querySelector('.stream-stage')).position)) === 'relative', JSON.stringify({ takeover: m.takeover, side }));
        await ctx.close();
    }
    {
        // An Android phone typing UPRIGHT: Android 14 and older WebViews shrink
        // the viewport for the keyboard, 360x640 -> 360x278.
        const typing = { viewport: { width: 360, height: 278 }, screen: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: ANDROID_UA };
        const tag = 'Android 360x640 typing upright (viewport 360x278)';
        const { ctx, page } = await openPage(browser, typing, { init: [ORIENTATION_UPRIGHT], view: 'pip' });
        await page.waitForSelector('.stream-pip', { timeout: 5000 }).catch(() => {});
        await sleep(300);
        ck(`${tag}: precondition: the OLD viewport-shaped rule would have matched here`,
            await page.evaluate(() => matchMedia('(pointer: coarse) and (max-width: 1024px) and (orientation: landscape) and (max-height: 500px)').matches));
        const state = await page.evaluate(() => ({
            side: document.documentElement.dataset.phoneSideways ?? null,
            takeover: document.documentElement.dataset.streamTakeover ?? null,
            input: document.querySelector('.input-wrapper')?.getBoundingClientRect().width ?? 0,
            pipBottom: document.querySelector('.stream-pip')?.getBoundingClientRect().bottom ?? 0,
            listTop: document.querySelector('.messages-container')?.getBoundingClientRect().top ?? 0,
        }));
        ck(`${tag}: not "sideways", no takeover`, state.side === null && state.takeover === null, JSON.stringify(state));
        // 136 px is this composer's width on any upright 360 px phone (four
        // buttons beside it); the sideways rule left it ~0.
        ck(`${tag}: the composer keeps its width (${Math.round(state.input)} px) with the player above, not beside`, state.input >= 100 && state.pipBottom <= state.listTop + 0.5, JSON.stringify(state));
        await page.screenshot({ path: join(outdir, 'android-360x278-typing-upright.png') });
        // NEGATIVE CONTROL: decided by the viewport's shape (the old rule).
        await page.evaluate(() => { document.documentElement.dataset.phoneSideways = 'true'; });
        await sleep(200);
        const old = await page.evaluate(() => document.querySelector('.input-wrapper')?.getBoundingClientRect().width ?? 0);
        control(`${tag}, decided by the viewport: the composer keeps its width (${Math.round(old)} px)`, old >= 100);
        await ctx.close();
    }
    {
        const android = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, userAgent: ANDROID_UA };
        const { ctx, page } = await openPage(browser, android, { init: [RECORD_FULLSCREEN] });
        const m = await measure(page);
        ck('Android phone portrait: no takeover, the stage under the header', m.takeover === null && m.stage.t >= m.parts['.chat-header'].b - 0.5);
        await page.locator('.stream-tile-header button[aria-label="Fullscreen"]').first().tap();
        await sleep(500);
        const calls = await page.evaluate(() => window.__fsCalls);
        // A BROWSER on Android (Chrome's own fullscreen); the Android APP takes
        // the in-app fullscreen instead (e2e/android-stream-fullscreen-live.mjs).
        ck('Android browser: Fullscreen asks the TILE for element fullscreen, as before', calls.length === 1 && /stream-tile/.test(calls[0]), JSON.stringify(calls));
        await ctx.close();
    }
}

// ---- 7. A control session in the in-app fullscreen.
/** Where the session's pieces are, and what a tap across the remote picture hits. */
const controlLayout = (page) => page.evaluate(() => {
    const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { l: b.left, t: b.top, r: b.right, b: b.bottom, h: b.height } : null; };
    const cap = document.querySelector('.control-capture');
    const video = document.querySelector('.stream-stage video');
    // The picture itself (object-fit: contain), not the element's box.
    let pic = r(video);
    if (pic && video.videoWidth > 0) {
        const s = Math.min((pic.r - pic.l) / video.videoWidth, pic.h / video.videoHeight);
        const w = video.videoWidth * s, h = video.videoHeight * s;
        const l = pic.l + ((pic.r - pic.l) - w) / 2, t = pic.t + (pic.h - h) / 2;
        pic = { l, t, r: l + w, b: t + h, h };
    }
    const missed = [];
    let points = 0;
    if (cap && pic) {
        for (let i = 0; i < 5; i++) for (let j = 0; j < 7; j++) {
            const x = pic.l + 2 + (pic.r - pic.l - 4) * (i / 4);
            const y = pic.t + 2 + (pic.h - 4) * (j / 6);
            points++;
            const hit = document.elementFromPoint(x, y);
            if (hit !== cap) missed.push({ x: Math.round(x), y: Math.round(y), hit: hit?.closest('.stream-stage-header') ? 'stage header' : hit?.closest('.voice-panel-compact') ? 'voice bar' : String(hit?.className || hit?.tagName) });
        }
    }
    const shown = (s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).visibility === 'visible'; };
    return {
        head: r(document.querySelector('.stream-stage-header')), voice: r(document.querySelector('.voice-panel-compact')),
        cap: r(cap), tile: r(document.querySelector('.stream-tile.is-app-fullscreen')), pic, live: !!video && video.videoWidth > 0,
        points, missed, headShown: shown('.stream-stage-header'), voiceShown: shown('.voice-panel-compact'),
        vw: document.documentElement.clientWidth, vh: innerHeight,
        takeover: document.documentElement.dataset.streamTakeover ?? null,
        bare: document.documentElement.dataset.fullscreenBare ?? null,
        native: [...(window.__native ?? [])],
    };
});

/** The capture surface (the remote screen) in a row of its own, between the header and the voice bar. */
const capBetween = (l) => !!l.head && !!l.voice && !!l.cap && l.head.b <= l.cap.t + 0.5 && l.voice.t >= l.cap.b - 0.5 && l.cap.h >= 200;
/** Nothing of Púca's over the remote screen: in its row, and every point across its picture the capture surface. */
const sessionClear = (l) => capBetween(l) && l.points === 35 && l.missed.length === 0;

/** The checks on a session in the in-app fullscreen. */
function controlChecks(tag, l, m, { android }) {
    const between = capBetween(l);
    ck(`${tag}: the header is above the remote screen and the voice bar below it`, between, JSON.stringify({ head: l.head, cap: l.cap, voice: l.voice }));
    ck(`${tag}: the WHOLE remote picture is between them (live frames)`, l.live && !!l.pic && l.pic.t >= l.head.b - 0.5 && l.pic.b <= l.voice.t + 0.5, JSON.stringify({ pic: l.pic, head: l.head, voice: l.voice }));
    ck(`${tag}: every one of ${l.points} points across the remote picture is the capture surface`, l.points === 35 && l.missed.length === 0, JSON.stringify(l.missed.slice(0, 8)));
    ck(`${tag}: still the in-app fullscreen, the stage holding the window`, l.takeover === 'fullscreen' && !!m.stage && m.stage.t <= 0.5 && m.stage.b >= m.vh - 0.5 && m.stage.l <= 0.5 && m.stage.r >= m.vw - 0.5, JSON.stringify({ takeover: l.takeover, stage: m.stage }));
    if (android) ck(`${tag}: Android's bars stay hidden (no SystemBars.show)`, l.native.includes('SystemBars.hide') && !l.native.includes('SystemBars.show'), JSON.stringify(l.native));
    ck(`${tag}: Chat and the voice bar's Mute are in reach`, !!m.buttons.find((b) => /chat/i.test(b.label))?.hit && !!m.mute?.hit, JSON.stringify(m.buttons));
}

/** Take the rule that puts the fullscreen tile in the picture's row out. */
const DROP_CONTROL_FULLSCREEN_RULE = () => {
    let n = 0;
    const strip = (list) => {
        for (let i = list.cssRules.length - 1; i >= 0; i--) {
            const r = list.cssRules[i];
            if ((r.selectorText ?? '').includes('[data-stream-takeover="fullscreen"][data-stream-controlling]')) { list.deleteRule(i); n++; continue; }
            if (r.cssRules) strip(r);
        }
    };
    for (const sh of document.styleSheets) strip(sh);
    return n;
};

async function controlInAppFullscreen(browser) {
    console.log('\n===== a control session in the in-app fullscreen (Chromium) =====');
    const android = (w, h) => ({ viewport: { width: w, height: h }, screen: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: ANDROID_UA });
    for (const [w, h, name] of [[844, 390, 'sideways'], [390, 844, 'upright']]) {
        const tag = `Android app ${w}x${h} ${name}`;
        const { ctx, page, errors } = await openPage(browser, android(w, h), { init: [FAKE_ANDROID_APP] });
        ck(`${tag}: the page is the Android app (precondition: the faked bridge)`, await page.evaluate(() => window.Capacitor.getPlatform() === 'android'));
        await page.waitForFunction(() => (document.querySelector('.stream-stage video')?.videoWidth ?? 0) > 0, null, { timeout: 10000 }).catch(() => {});
        await sleep(600); // the voice bar re-measures itself once restyled
        await page.locator('.stream-tile-header button[aria-label="Fullscreen"]').first().tap();
        await sleep(500);
        const bare = await controlLayout(page);
        ck(`${tag}, Fullscreen: the bare picture (no voice bar, no stage header, bars hidden), the tile the whole window`,
            bare.takeover === 'fullscreen' && bare.bare === 'true' && !bare.headShown && !bare.voiceShown && bare.native.includes('SystemBars.hide')
                && !!bare.tile && bare.tile.t <= 0.5 && bare.tile.b >= bare.vh - 0.5,
            JSON.stringify(bare));
        // The review's scenario: the session starts while the stream is fullscreen.
        await page.evaluate(CONTROL_SESSION, true);
        await sleep(400);
        const l = await controlLayout(page);
        ck(`${tag}, session: the header and the voice bar are back (Stop controlling and Mute in reach)`, l.headShown && l.voiceShown);
        controlChecks(`${tag}, session`, l, await measure(page), { android: true });
        await page.screenshot({ path: join(outdir, `android-app-${w}x${h}-control-in-fullscreen.png`) });
        await page.evaluate(CONTROL_SESSION, false);
        await sleep(400);
        const after = await controlLayout(page);
        ck(`${tag}, session over: the bare picture again, the tile the whole window`,
            after.takeover === 'fullscreen' && !after.headShown && !after.voiceShown && !!after.tile && after.tile.t <= 0.5 && after.tile.b >= after.vh - 0.5,
            JSON.stringify(after));
        // NEGATIVE CONTROL: without the rule, the session's bars lie over the picture.
        await page.evaluate(CONTROL_SESSION, true);
        const dropped = await page.evaluate(DROP_CONTROL_FULLSCREEN_RULE);
        await sleep(300);
        const o = await controlLayout(page);
        ck(`${tag}: the control's rule was found (${dropped} rules taken out)`, dropped === 2);
        // Upright, a 16:9 picture is letterboxed clear of both bars, but the
        // capture surface still runs under them (a tap there is a tap over there).
        control(`${tag}, the tile fixed to the window: nothing of Púca's over the remote screen`, sessionClear(o), JSON.stringify({ head: o.head, cap: o.cap, voice: o.voice, missed: o.missed.slice(0, 4) }));
        ck(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
        await ctx.close();
    }
    {
        // The iPhone shape's in-app fullscreen (route 3): not bare, the same layout once controlling.
        const tag = 'iPhone shape 844x390 sideways';
        const phone = { viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA };
        const { ctx, page, errors } = await openPage(browser, phone, { init: [IPHONE_FULLSCREEN] });
        await page.waitForFunction(() => (document.querySelector('.stream-stage video')?.videoWidth ?? 0) > 0, null, { timeout: 10000 }).catch(() => {});
        await sleep(600);
        await page.locator('.stream-tile-header button[aria-label="Fullscreen"]').first().tap();
        await sleep(1300); // past the system player's chance to begin
        await page.evaluate(CONTROL_SESSION, true);
        await sleep(400);
        const l = await controlLayout(page);
        ck(`${tag}: the in-app fullscreen, not bare (precondition)`, l.takeover === 'fullscreen' && l.bare === null, JSON.stringify({ takeover: l.takeover, bare: l.bare }));
        controlChecks(`${tag}, session`, l, await measure(page), { android: false });
        await page.evaluate(DROP_CONTROL_FULLSCREEN_RULE);
        await sleep(300);
        const o = await controlLayout(page);
        control(`${tag}, the tile fixed to the window: nothing of Púca's over the remote screen`, sessionClear(o), JSON.stringify({ head: o.head, cap: o.cap, voice: o.voice, missed: o.missed.slice(0, 4) }));
        ck(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
        await ctx.close();
    }
}

// ---- 8. Focus view with a filmstrip, in the Android app's in-app fullscreen.
/** The tile in the in-app fullscreen: where it is, what the window's points hit, its picture and its exit. */
const fullscreenTile = (page) => page.evaluate(() => {
    const t = document.querySelector('.stream-tile.is-app-fullscreen');
    const vw = document.documentElement.clientWidth, vh = innerHeight;
    const box = t?.getBoundingClientRect();
    // The window's bottom and top rows and down its middle: each point must be the tile.
    const pts = [];
    for (let i = 0; i < 9; i++) { const x = 4 + (vw - 8) * (i / 8); pts.push([x, vh - 4], [x, 4]); }
    for (let j = 0; j < 9; j++) pts.push([vw / 2, 4 + (vh - 8) * (j / 8)]);
    const off = pts.flatMap(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return t && hit && t.contains(hit) ? [] : [{ x: Math.round(x), y: Math.round(y), hit: String(hit?.className || hit?.tagName) }];
    });
    // The picture itself (object-fit: contain).
    const video = t?.querySelector('video');
    let pic = null;
    if (video && video.videoWidth > 0) {
        const r = video.getBoundingClientRect();
        const s = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
        const w = video.videoWidth * s, h = video.videoHeight * s;
        pic = { l: r.left + (r.width - w) / 2, t: r.top + (r.height - h) / 2, w, h };
    }
    const exit = t?.querySelector('button[aria-label="Exit fullscreen"]');
    const e = exit?.getBoundingClientRect();
    return {
        cls: t?.className ?? null, name: t?.querySelector('.streamer-name')?.textContent?.trim() ?? null,
        tile: box ? { l: box.left, t: box.top, r: box.right, b: box.bottom } : null, vw, vh,
        opacity: t ? Number(getComputedStyle(t).opacity) : null, points: pts.length, off, pic,
        exit: e ? { w: e.width, h: e.height, hit: document.elementFromPoint(e.left + e.width / 2, e.top + e.height / 2)?.closest('button') === exit } : null,
        bare: document.documentElement.dataset.fullscreenBare ?? null,
        stageName: document.querySelector('.stream-tile.is-stage .streamer-name')?.textContent?.trim() ?? null,
    };
});

/** The whole window is the tile, and its live picture is centred with one side flush. */
const fillsWindow = (f) => !!f.tile && f.tile.l <= 0.5 && f.tile.t <= 0.5 && f.tile.r >= f.vw - 0.5 && f.tile.b >= f.vh - 0.5 && f.off.length === 0;
const pictureCentred = (f) => !!f.pic && Math.abs(f.pic.l + f.pic.w / 2 - f.vw / 2) <= 1 && Math.abs(f.pic.t + f.pic.h / 2 - f.vh / 2) <= 1
    && (f.pic.w >= f.vw - 1 || f.pic.h >= f.vh - 1);
const exitInReach = (f) => !!f.exit && f.exit.w >= 43.5 && f.exit.h >= 43.5 && f.exit.hit;
/** The controls hide by themselves after a few idle seconds: a key brings them back. Not a tap on the
 *  picture, which also puts its stream on the stage (the tile's own click) and would decide which
 *  stream the stage goes back to. */
const showControls = async (page) => {
    if (await page.evaluate(() => document.documentElement.dataset.streamChrome !== 'hidden')) return;
    await page.keyboard.press('Shift');
    await sleep(350);
};

/** Take the rule that sizes the fullscreen tile in focus view out. */
const DROP_FOCUS_FULLSCREEN_RULE = () => {
    let n = 0;
    const strip = (list) => {
        for (let i = list.cssRules.length - 1; i >= 0; i--) {
            const r = list.cssRules[i];
            if ((r.selectorText ?? '').includes('.stream-grid.focus-mode .stream-tile.is-app-fullscreen')) { list.deleteRule(i); n++; continue; }
            if (r.cssRules) strip(r);
        }
    };
    for (const sh of document.styleSheets) strip(sh);
    return n;
};

async function focusViewInAppFullscreen(browser) {
    console.log('\n===== focus view with a filmstrip, the Android app\'s in-app fullscreen (Chromium) =====');
    for (const [w, h, name] of [[844, 390, 'sideways'], [390, 844, 'upright']]) {
        const tag = `Android app ${w}x${h} ${name}, focus view`;
        const opts = { viewport: { width: w, height: h }, screen: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: ANDROID_UA };
        const { ctx, page, errors } = await openPage(browser, opts, { init: [FAKE_ANDROID_APP], streams: 2 });
        await page.waitForFunction(() => [...document.querySelectorAll('.stream-stage video')].every((v) => v.videoWidth > 0), null, { timeout: 10000 }).catch(() => {});
        await showControls(page);
        await page.locator('button[title="Switch to Focus View"]').tap();
        await sleep(400);
        const grid = await page.evaluate(() => document.querySelector('.stream-grid')?.className ?? '');
        ck(`${tag}: focus view with a filmstrip (precondition: the Android app, two streams)`,
            /focus-mode/.test(grid) && /has-strip/.test(grid) && await page.evaluate(() => window.Capacitor.getPlatform() === 'android'), grid);

        // The stage in fullscreen.
        await page.locator('.stream-tile.is-stage .stream-tile-header button[aria-label="Fullscreen"]').tap();
        await sleep(500);
        const st = await fullscreenTile(page);
        ck(`${tag}, the stage in Fullscreen: the bare fullscreen, the stage's tile`, st.bare === 'true' && /is-stage/.test(st.cls ?? '') && st.name?.includes('Streamer 1'), JSON.stringify({ cls: st.cls, name: st.name, bare: st.bare }));
        ck(`${tag}, the stage in Fullscreen: the tile is the whole window (its edges and ${st.points} points across it)`, fillsWindow(st), JSON.stringify({ tile: st.tile, vw: st.vw, vh: st.vh, off: st.off.slice(0, 6) }));
        ck(`${tag}, the stage in Fullscreen: the live picture is centred, one side flush`, pictureCentred(st), JSON.stringify(st.pic));
        ck(`${tag}, the stage in Fullscreen: Exit fullscreen is 44 px and what a tap hits`, exitInReach(st), JSON.stringify(st.exit));
        await page.screenshot({ path: join(outdir, `android-app-${w}x${h}-focus-fullscreen.png`) });

        // A control session in it: the stage's tile is the first in the DOM, where CONTROL_SESSION puts its surface.
        await page.evaluate(CONTROL_SESSION, true);
        await sleep(400);
        const l = await controlLayout(page);
        controlChecks(`${tag}, session`, l, await measure(page), { android: true });
        // 7's checks hold for a tile short of its row too (a smaller picture is
        // still between the bars): the tile must fill the row.
        ck(`${tag}, session: the tile fills the picture's row, the header's foot to the voice bar's top, edge to edge`,
            !!l.tile && !!l.head && !!l.voice && Math.abs(l.tile.t - l.head.b) <= 1 && Math.abs(l.tile.b - l.voice.t) <= 1 && l.tile.l <= 0.5 && l.tile.r >= l.vw - 0.5,
            JSON.stringify({ head: l.head, tile: l.tile, voice: l.voice }));
        await page.screenshot({ path: join(outdir, `android-app-${w}x${h}-focus-control-in-fullscreen.png`) });
        await page.evaluate(CONTROL_SESSION, false);
        await sleep(400);

        await showControls(page);
        await page.locator('.stream-tile.is-app-fullscreen button[aria-label="Exit fullscreen"]').tap();
        await sleep(400);
        const back = await fullscreenTile(page);
        ck(`${tag}, Exit fullscreen: the layout back (no fullscreen tile, not bare)`, back.cls === null && back.bare === null && back.stageName?.includes('Streamer 1'), JSON.stringify({ cls: back.cls, bare: back.bare, stage: back.stageName }));

        // A filmstrip THUMB put in fullscreen from its menu (a long press opens it).
        const thumb = page.locator('.stream-tile.is-thumb').first();
        const tb = await thumb.boundingBox();
        await thumb.dispatchEvent('contextmenu', { clientX: tb.x + tb.width / 2, clientY: tb.y + tb.height / 2 });
        await sleep(300);
        const item = page.locator('.stream-context-menu .scm-item', { hasText: /^\s*Fullscreen/ });
        // Sideways the menu is taller than the window and its last row, this
        // one, is below it (a separate defect): pressed through the DOM there.
        if (name === 'upright') await item.tap();
        else await item.evaluate((b) => b.click());
        await sleep(500);
        const th = await fullscreenTile(page);
        ck(`${tag}, a thumb in Fullscreen from its menu: it is the stage there`, th.bare === 'true' && /is-stage/.test(th.cls ?? '') && !/is-thumb/.test(th.cls ?? '') && th.name?.includes('Streamer 2'), JSON.stringify({ cls: th.cls, name: th.name }));
        ck(`${tag}, a thumb in Fullscreen: the tile is the whole window, at full opacity`, fillsWindow(th) && th.opacity === 1, JSON.stringify({ tile: th.tile, opacity: th.opacity, off: th.off.slice(0, 6) }));
        ck(`${tag}, a thumb in Fullscreen: the live picture is centred, one side flush`, pictureCentred(th), JSON.stringify(th.pic));
        ck(`${tag}, a thumb in Fullscreen: its Exit fullscreen is 44 px and what a tap hits`, exitInReach(th), JSON.stringify(th.exit));
        await page.screenshot({ path: join(outdir, `android-app-${w}x${h}-focus-thumb-fullscreen.png`) });
        await showControls(page);
        // With no exit to tap (the failure above), Escape leaves, so the run goes on.
        if (exitInReach(await fullscreenTile(page))) await page.locator('.stream-tile.is-app-fullscreen button[aria-label="Exit fullscreen"]').tap();
        else await page.keyboard.press('Escape');
        await sleep(400);
        const after = await fullscreenTile(page);
        ck(`${tag}, the thumb's Exit fullscreen: the stage back to the stream that had it`, after.cls === null && after.bare === null && after.stageName?.includes('Streamer 1'), JSON.stringify({ cls: after.cls, stage: after.stageName }));

        // NEGATIVE CONTROL: the focus-view rule taken out, the stage's filmstrip row keeps the tile short.
        await showControls(page);
        await page.locator('.stream-tile.is-stage .stream-tile-header button[aria-label="Fullscreen"]').tap();
        await sleep(400);
        const dropped = await page.evaluate(DROP_FOCUS_FULLSCREEN_RULE);
        await sleep(300);
        ck(`${tag}: the focus-view rule was found (${dropped} taken out)`, dropped === 1);
        const o = await fullscreenTile(page);
        control(`${tag}, without the rule: the tile is the whole window`, fillsWindow(o), JSON.stringify({ tile: o.tile, vh: o.vh }));
        ck(`${tag}: no page errors`, errors.length === 0, errors.join(' | '));
        await ctx.close();
    }
}

// Desktop, not WebKit's iPhone emulation, for the surfaces that must not change.
const cr = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
try {
    await suite(cr, 'chromium');
    engineInit = [];
    await unchanged(cr);
    await controlInAppFullscreen(cr);
    await focusViewInAppFullscreen(cr);
} finally {
    await cr.close();
}
let wk;
try {
    wk = muteWebkit(await webkit.launch());
} catch (e) {
    console.error(String(e.message || e).split('\n')[0]);
    ck('WebKit is installed (npx playwright install webkit)', false);
}
if (wk) {
    try { await suite(wk, 'webkit'); } finally { await wk.close(); }
}
server.close();
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}  (screenshots: ${outdir})`);
process.exit(fail === 0 ? 0 : 1);
