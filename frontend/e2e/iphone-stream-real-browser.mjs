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
//      does a short 1000x400 one; a portrait Android phone takes no takeover,
//      and neither does one typing upright with the keyboard shrinking its
//      viewport to 360x278 (the composer keeps its width beside the docked
//      player; the old viewport-shaped rule as the control that must fail).
//   6. The controls in reach: a touch on the voice bar (outside the stage)
//      restarts the clock; Tab brings hidden controls back and keyboard focus
//      on one keeps them up; a control session lays them out above and below
//      the remote screen, never over it (the overlay as the control).
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
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ANDROID_UA, IPHONE_FULLSCREEN, IPHONE_UA, OLD_LAYOUT, ORIENTATION_FOLLOWS_SCREEN, ORIENTATION_UPRIGHT, RECORD_FULLSCREEN,
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
        ck('Android: Fullscreen asks the TILE for element fullscreen, as before', calls.length === 1 && /stream-tile/.test(calls[0]), JSON.stringify(calls));
        await ctx.close();
    }
}

// Desktop, not WebKit's iPhone emulation, for the surfaces that must not change.
const cr = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
try {
    await suite(cr, 'chromium');
    engineInit = [];
    await unchanged(cr);
} finally {
    await cr.close();
}
let wk;
try {
    wk = await webkit.launch();
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
