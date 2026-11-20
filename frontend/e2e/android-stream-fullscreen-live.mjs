// LIVE: the ANDROID APP watching a stream and a camera in FULLSCREEN (the owner's
// report, 2026-11-20: a watched stream put in fullscreen in the Android app did not
// take the whole screen, parts of Púca still showed around or over the picture).
//
// The phone is the REAL debug APK on a HEADLESS emulator (`-no-window -no-audio`),
// read through its WebView's DevTools and driven by REAL touches (`adb input tap`)
// and Android's own Back (`adb input keyevent`). The other side of the call is
// headless Edge, --mute-audio, on a vite dev server of this tree, sharing a canvas
// "screen" (getDisplayMedia replaced, as an automation would supply it) and its
// fake camera, on an encrypted mesh call. Nothing is shown on, or played through,
// this PC.
//
// What it proves, each a PASS/FAIL line, with the picture LIVE (frames counted):
//   portrait, the stream: a real tap on the tile's Fullscreen and the tile fills the
//     app's view, the view is the whole screen (Android's status and navigation bars
//     hidden: the WebView's bounds are the display's), every one of 45 points across
//     the screen is the stream (document.elementFromPoint), none of Púca's voice bar,
//     stage header, bottom tabs, chat header or composer is painted, and the stream's
//     own Exit fullscreen is what a tap at its centre hits; a real tap on it gives the
//     layout and the bars back;
//   a camera (the stage's camera strip): the same;
//   sideways: the same, and Android's Back gives the sideways takeover back with the
//     app still in front;
//   portrait again: Android's Back leaves fullscreen, the app stays in front and in
//     the call, and the layout is back.
// NEGATIVE CONTROLS (they must FAIL): APK=<the debug APK of the tree before the fix>
//   (the WebView's own fullscreen: the bars stay, the button is not an exit, and Back
//   closes the app's activity and the call with it); with REFUSE=1 the page's
//   requestFullscreen refuses, as a WebView may, and the build before the fix then
//   shows its voice bar and stage header over the picture (the fixed one never asks).
//
// Needs (the header of android-share-live.mjs has the details): a THROWAWAY backend
// + Postgres reachable on the host as API (STUN_SERVERS= empty: nothing outside), a
// vite dev server of this tree at APP against that API, the debug APK of this tree
// built with VITE_API_URL = API and PUCA_ALLOW_LOCAL_BUILD=1 and the LOCAL,
// uncommitted cleartext overlay, installed on SERIAL (or APK= to install one), and
// `adb -s SERIAL reverse tcp:<api port> tcp:<api port>`.
//
// Usage: SERIAL=emulator-5554 API=http://127.0.0.1:3061 APP=http://127.0.0.1:5461
//        [APK=<path>] [REFUSE=1] [OUT=dir] node e2e/android-stream-fullscreen-live.mjs
// ~4 min. Leaves the emulator upright with auto-rotate as it found it.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERIAL = process.env.SERIAL || '';
const API = process.env.API || 'http://127.0.0.1:3061';
const APP = process.env.APP || 'http://127.0.0.1:5461';
const APK = process.env.APK || '';
const REFUSE = process.env.REFUSE === '1';
const OUT = process.env.OUT || '';
const PKG = 'com.sovereign.app';
const CDP_PORT = Number(process.env.CDP_PORT || 9461);
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Only ever an emulator: a real phone may be attached over Wi-Fi debugging,
// and nothing here may reach it.
if (!/^emulator-\d+$/.test(SERIAL)) {
    console.error('SERIAL must name an emulator (emulator-NNNN); refusing to touch any other device.');
    process.exit(2);
}
const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const sh = (cmd) => adb('shell', cmd).toString('utf8');
const save = (name, bytes) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), bytes); } };
const screencap = () => adb('exec-out', 'screencap', '-p');

async function until(fn, ms = 15000, step = 300) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(step); }
    return last;
}
let failed = 0;
const step = (what) => console.log(`--    ${what}`);
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
    if (!ok) failed++;
    return ok;
};

// ---- the phone's own screen -------------------------------------------------

/** Every on-screen node uiautomator sees (class and bounds), retried while the
 *  screen will not go idle (a playing video). */
function uiNodes() {
    let xml = '';
    for (let i = 0; i < 5 && !xml.includes('<hierarchy'); i++) {
        sh('rm -f /sdcard/puca-ui.xml; uiautomator dump /sdcard/puca-ui.xml >/dev/null 2>&1; true');
        xml = sh('cat /sdcard/puca-ui.xml 2>/dev/null || true');
        if (!xml.includes('<hierarchy')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    }
    const nodes = [];
    for (const m of xml.matchAll(/<node [^>]*>/g)) {
        const a = (k) => (new RegExp(`${k}="([^"]*)"`).exec(m[0]) || [])[1] || '';
        const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a('bounds'));
        if (!b) continue;
        nodes.push({ text: a('text'), cls: a('class'), x: (+b[1] + +b[3]) >> 1, y: (+b[2] + +b[4]) >> 1, left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] });
    }
    return nodes;
}
/** The app's WebView on the screen, in device pixels. */
const webViewBox = () => uiNodes().find(n => n.cls === 'android.webkit.WebView') || null;
/** The display, in device pixels, as it is turned now. */
function display() {
    const out = sh('wm size');
    const m = /Override size: (\d+)x(\d+)/.exec(out) || /Physical size: (\d+)x(\d+)/.exec(out);
    let w = +m[1], h = +m[2];
    const rot = +(/(\d)\s*$/.exec(sh('wm user-rotation').trim()) || [0, 0])[1];
    if (rot % 2 === 1) [w, h] = [h, w];
    return { w, h };
}
/** Turn the phone (0 upright, 1 sideways) and wait until the display has. */
async function turn(rotation) {
    sh(`wm user-rotation lock ${rotation}`);
    await until(() => new RegExp(`mRotation=${rotation}(?!\\d)`).test(sh('dumpsys window displays | grep -E "mRotation="')), 10000, 400);
    await sleep(1500);
}
/** Is the app the activity in front? (A Back that closed it leaves the launcher.) */
const appInFront = () => /topResumedActivity=.*com\.sovereign\.app\//.test(sh('dumpsys activity activities | grep -E "topResumedActivity"'));

async function answerSystemDialogs(waitMs = 0) {
    const t0 = Date.now();
    for (let i = 0; i < 12; i++) {
        const n = uiNodes();
        if (!n.some(x => /always run in background|battery optimi[sz]ation/i.test(x.text))) {
            if (Date.now() - t0 > waitMs) return;
            await sleep(800);
            continue;
        }
        const no = n.find(x => /^(Deny|Don.t allow|No)$/i.test(x.text));
        if (no) sh(`input tap ${no.x} ${no.y}`);
        await sleep(800);
    }
}

/** A REAL touch at the centre of the first element on screen matching `sel`
 *  (`web`: the WebView's place on the screen, if already known). */
async function realTap(page, sel, web = null) {
    const r = await page.evaluate((s) => {
        const e = [...document.querySelectorAll(s)].find(x => x.getClientRects().length);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2, dpr: devicePixelRatio };
    }, sel);
    if (!r) return null;
    const box = web || webViewBox();
    sh(`input tap ${Math.round((box ? box.left : 0) + r.x * r.dpr)} ${Math.round((box ? box.top : 0) + r.y * r.dpr)}`);
    return r;
}
/** Is `sel` on screen and what a tap at its centre reaches? */
const reachable = (page, sel) => page.evaluate((s) => {
    const e = [...document.querySelectorAll(s)].find(x => x.getClientRects().length);
    if (!e) return false;
    const cs = getComputedStyle(e);
    const b = e.getBoundingClientRect();
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return cs.visibility !== 'hidden' && +cs.opacity >= 0.5 && !!hit && (hit === e || e.contains(hit));
}, sel);
/** A tile's own control, with a real touch, until `done` says it took (up to
 *  three presses). The controls hide by themselves a few seconds after the
 *  last touch in a takeover (StreamStage CHROME_HIDE_MS), so a tap on the
 *  picture brings them back first, and the WebView's place is read BEFORE
 *  (a uiautomator dump takes seconds, long enough for them to hide again). */
async function tapControl(page, tileSel, sel, done) {
    const web = webViewBox();
    for (let i = 0; i < 3; i++) {
        if (!await reachable(page, sel)) { await realTap(page, `${tileSel} video`, web); await sleep(450); }
        await realTap(page, sel, web);
        if (!done || await until(done, 2500, 250)) return true;
    }
    return false;
}

// ---- the pages ---------------------------------------------------------------

const QUIET = () => {
    try {
        const k = 'sovereign_settings';
        const s = JSON.parse(localStorage.getItem(k) || '{}');
        Object.assign(s, { joinWithoutMic: true, soundsEnabled: false, joinLeaveSound: false, voiceTTS: false, streamSound: false });
        localStorage.setItem(k, JSON.stringify(s));
    } catch { /* storage refused */ }
};
const SHARE_INIT = () => {
    navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 1280; c.height = 720;
        const g = c.getContext('2d');
        let i = 0;
        setInterval(() => {
            g.fillStyle = `hsl(${(i += 3) % 360},60%,40%)`; g.fillRect(0, 0, 1280, 720);
            g.fillStyle = '#fff'; g.font = 'bold 80px sans-serif'; g.fillText('SHARED SCREEN', 340, 380);
            g.fillRect((i * 5) % 1200, 600, 80, 80);
        }, 33);
        return c.captureStream(30);
    };
};
/** REFUSE=1: a WebView that refuses element fullscreen (the negative control's
 *  second half). Installed on the phone's page after it loads. */
const REFUSE_FULLSCREEN = () => {
    const no = function () { return Promise.reject(new TypeError('refused (REFUSE=1)')); };
    Element.prototype.requestFullscreen = no;
    return true;
};

async function dismiss(page) {
    for (let i = 0; i < 4; i++) {
        let did = false;
        if (await page.locator('.recovery-confirm input[type="checkbox"]').count()) {
            await page.locator('.recovery-confirm input[type="checkbox"]').first().check().catch(() => {});
            await page.locator('.recovery-done-btn').first().click().catch(() => {});
            did = true;
        }
        if (await page.locator('.welcome-popup-close').count()) { await page.locator('.welcome-popup-close').first().click().catch(() => {}); did = true; }
        for (const name of ['Later', 'Not now', 'Skip']) {
            const b = page.getByRole('button', { name, exact: true });
            if (await b.count()) { await b.first().click().catch(() => {}); did = true; }
        }
        if (!did) return;
        await sleep(400);
    }
}
async function signUp(page, user) {
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 90000 });
    await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 90000 });
    await sleep(2000);
    await dismiss(page);
}
const call = (page, mod, fn, a = []) => page.evaluate(async ({ mod, fn, a }) => (await import(mod))[fn](...a), { mod, fn, a });

/** What the phone shows while `targetSel` (or the element in fullscreen) is
 *  meant to fill it: the target's box, a 5x9 grid of hit tests, which of Púca's
 *  own bars are painted, and whether the picture is moving. */
const MEASURE = async (targetSel) => {
    const fe = document.fullscreenElement || null;
    const target = fe || [...document.querySelectorAll(targetSel)].find(x => x.getClientRects().length) || null;
    const vw = innerWidth, vh = innerHeight;
    const desc = (e) => e ? e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : 'nothing';
    const outside = [];
    let points = 0;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 9; j++) {
        const x = 2 + (vw - 4) * i / 4, y = 2 + (vh - 4) * j / 8;
        points++;
        const hit = document.elementFromPoint(x, y);
        if (!target || !hit || !target.contains(hit)) outside.push(`${Math.round(x)},${Math.round(y)}:${desc(hit)}`);
    }
    const painted = [];
    for (const s of ['.voice-panel-compact', '.stream-stage-header', '.mobile-bottom-nav', '.chat-header', '.message-form']) {
        for (const e of document.querySelectorAll(s)) {
            if (!e.getClientRects().length || (target && target.contains(e))) continue;
            const cs = getComputedStyle(e);
            if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
            // Drawn somewhere a point lands on it (a bar under the picture is not painted).
            const b = e.getBoundingClientRect();
            const hit = document.elementFromPoint(Math.min(Math.max(b.x + b.width / 2, 1), vw - 1), Math.min(Math.max(b.y + b.height / 2, 1), vh - 1));
            if (hit && (hit === e || e.contains(hit))) painted.push(s);
        }
    }
    const v = target?.querySelector('video');
    const frames = () => v?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const f0 = frames();
    await new Promise(r => setTimeout(r, 1200));
    const r = target?.getBoundingClientRect();
    return {
        vw, vh, dpr: devicePixelRatio, element: !!fe,
        box: r ? { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) } : null,
        points, outside, painted, live: !!v && v.videoWidth > 0 && frames() > f0,
        takeover: document.documentElement.dataset.streamTakeover ?? null,
    };
};
const measure = (page, targetSel) => page.evaluate(MEASURE, targetSel);
/** Is the normal layout back: the voice bar and the chat's own header painted? */
const layoutBack = (page) => page.evaluate(() => {
    const shown = (s) => {
        const e = [...document.querySelectorAll(s)].find(x => x.getClientRects().length);
        if (!e) return false;
        const cs = getComputedStyle(e);
        const b = e.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return cs.visibility !== 'hidden' && !!hit && (hit === e || e.contains(hit));
    };
    return {
        fullscreen: !!document.fullscreenElement || !!document.querySelector('.is-app-fullscreen'),
        takeover: document.documentElement.dataset.streamTakeover ?? null,
        voiceBar: shown('.voice-panel-compact'),
        chatHeader: shown('.chat-header'),
        tabs: shown('.mobile-bottom-nav'),
        inCall: !!document.querySelector('[data-testid="voice-connected"]'),
    };
});

/** The checks for one thing in fullscreen. */
function fullscreenChecks(tag, m, web, disp) {
    check(`${tag}: the picture is live in fullscreen`, m.live, m);
    check(`${tag}: it fills the app's view`, !!m.box && m.box.l <= 0 && m.box.t <= 0 && m.box.r >= m.vw && m.box.b >= m.vh, { box: m.box, vw: m.vw, vh: m.vh });
    check(`${tag}: the app's view is the whole screen (Android's status and navigation bars hidden)`,
        !!web && web.left === 0 && web.top === 0 && web.right === disp.w && web.bottom === disp.h, { webView: web && [web.left, web.top, web.right, web.bottom], display: disp });
    check(`${tag}: every one of ${m.points} points across the screen is the picture or its own controls`, m.outside.length === 0, m.outside.slice(0, 8));
    check(`${tag}: nothing of Púca's painted (voice bar, stage header, bottom tabs, chat header, composer)`, m.painted.length === 0, m.painted);
}

let forwarded = false;
let rotated = false;
let rotationWas = '';
const browsers = [];
let P = null;
try {
    // ---- the phone ----
    const attached = execFileSync(ADB, ['devices'], { encoding: 'utf8' });
    if (!attached.split('\n').some(l => l.trim().split(/\s+/)[0] === SERIAL && /\bdevice$/.test(l.trim()))) throw new Error(`${SERIAL} is not attached`);
    if (APK) {
        step(`installing ${path.basename(APK)}`);
        // A nearly full emulator refuses to put a second copy beside the
        // first (INSTALL_FAILED_INSUFFICIENT_STORAGE): its data is cleared
        // below anyway, so the old one goes first.
        try { adb('install', '-r', APK); } catch { adb('uninstall', PKG); adb('install', APK); }
    }
    step('a fresh app');
    sh(`pm clear ${PKG}`);
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh('cmd statusbar collapse');
    // `wm user-rotation` (lock N / free), not the settings: turning auto-rotate
    // off locks the CURRENT rotation, a write that can land after ours.
    rotationWas = sh('wm user-rotation').trim();
    step(`rotation was "${rotationWas}"; upright for the walk`);
    await turn(0);
    rotated = true;
    sh(`am start -W -n ${PKG}/.MainActivity`);
    const pid = (await until(() => sh(`pidof ${PKG}`).trim(), 30000)) || '';
    await until(() => sh('cat /proc/net/unix').includes(`webview_devtools_remote_${pid}`), 30000);
    adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);
    forwarded = true;
    // Attached, not launched: the emulator's WebView, whose sound is the
    // emulator's own (-no-audio in the header).
    const wv = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`), 30000, 1000);
    browsers.push(wv);
    P = await until(() => wv.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://localhost')), 30000);
    if (!P) throw new Error('the page of the app did not appear');
    await P.evaluate(QUIET);
    await P.reload({ waitUntil: 'domcontentloaded' });

    // ---- the other side ----
    const b = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
    browsers.push(b);
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(SHARE_INIT);
    await ctx.addInitScript(QUIET);
    const V = await ctx.newPage();
    await V.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });

    step('signing up both, a server with a voice channel');
    await signUp(V, `afv_${stamp}`);
    await signUp(P, `afp_${stamp}`);
    const srv = await call(V, '/src/api/servers.ts', 'createServer', ['AF ' + stamp.slice(-4)]);
    await call(V, '/src/api/servers.ts', 'createChannel', [srv.id, 'general', 0]);
    const voice = await call(V, '/src/api/servers.ts', 'createChannel', [srv.id, 'Stage', 1]);
    const inv = await call(V, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);
    const joined = await P.evaluate(async ({ api, code }) => (await fetch(`${api}/invites/${code}/join`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') },
    })).status, { api: API, code: inv.code });
    check('fixture: the phone is a member of the server', joined < 300, { joined });
    for (const p of [V, P]) { await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000); await dismiss(p); }
    for (const [tag, p] of [['the other side', V], ['the phone', P]]) {
        await p.evaluate((id) => document.querySelector(`[data-testid="server-icon"][data-server-id="${id}"]`)?.click(), srv.id);
        await sleep(1200);
        await p.evaluate((id) => document.querySelector(`[data-testid="voice-channel"][data-channel-id="${id}"]`)?.click(), voice.id);
        check(`fixture: ${tag} is in the call`, !!await until(async () => (await p.locator('[data-testid="voice-connected"]').count()) > 0, 30000));
    }
    await answerSystemDialogs(6000);
    await V.locator('[data-testid="voice-share-screen"]').click();
    check('fixture: the other side is live', !!await until(async () => (await V.locator('[data-testid="voice-stop-share"]').count()) > 0, 15000));
    await V.locator('button[title="Turn On Camera"]').first().click();
    // The phone: back to the text channel, then Watch. (A press through the
    // page: the floating Watch button sits under the phone's voice bar, a
    // layout matter outside this walk.)
    await P.evaluate(() => [...document.querySelectorAll('.channel')].find(e => /general/.test(e.textContent || ''))?.click());
    await sleep(1500);
    await answerSystemDialogs(3000);
    await until(() => P.evaluate(() => { const x = document.querySelector('.watch-live-btn'); if (x) { x.click(); return true; } return false; }), 15000);
    const live = await until(() => P.evaluate(() => {
        const v = [...document.querySelectorAll('.stream-tile video')].find(x => x.videoWidth > 0);
        const c = [...document.querySelectorAll('.camera-rail-tile video')].find(x => x.videoWidth > 0);
        return !!v && !!c;
    }), 40000);
    check('fixture: the phone watches the stream and the camera, both pictures live (decrypted)', !!live);
    // A question the app asks a fresh account can arrive late (the recovery
    // code): out of the way before anything is measured.
    await dismiss(P);
    await until(() => P.evaluate(() => !document.querySelector('.recovery-modal-overlay')), 8000);
    if (REFUSE) {
        await P.evaluate(REFUSE_FULLSCREEN);
        step('REFUSE=1: the page\'s requestFullscreen now refuses');
    }
    save('00-stage.png', screencap());

    const STREAM = '.stream-tile';
    const CAMERA = '.camera-rail-tile';
    const FS = '.stream-tile-header button[aria-label="Fullscreen"]';
    const EXIT = '.stream-tile-header button[aria-label="Exit fullscreen"]';
    /** Leave fullscreen however the build allows, so the walk can go on. */
    async function forceOut() {
        await P.evaluate(() => {
            if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
            document.querySelector('.is-app-fullscreen button[aria-label="Exit fullscreen"]')?.click();
        });
        await sleep(1200);
    }

    // ---- 1. portrait, the stream ----
    // Upright, as the page sees it too (the display was found turned once
    // between the start of a run and here).
    await turn(0);
    check('fixture: the phone is upright', !!await until(() => P.evaluate(() => innerHeight > innerWidth), 8000), sh('wm user-rotation').trim());
    const inFullscreen = () => P.evaluate(() => !!document.fullscreenElement || !!document.querySelector('.is-app-fullscreen'));
    const outOfFullscreen = async () => !await inFullscreen();
    step('portrait: the stream\'s Fullscreen, a real tap');
    await tapControl(P, STREAM, FS, inFullscreen);
    await sleep(1500);
    let disp = display();
    let m = await measure(P, `${STREAM}.is-app-fullscreen`);
    let web = webViewBox();
    save('01-stream-fullscreen.png', screencap());
    fullscreenChecks('portrait stream', m, web, disp);
    const exitHit = await P.evaluate((sel) => {
        const e = document.querySelector(sel);
        if (!e) return { label: document.querySelector('.stream-tile-header button[aria-label$="ullscreen"]')?.getAttribute('aria-label') ?? null };
        const b = e.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return { label: e.getAttribute('aria-label'), hit: !!hit && (hit === e || e.contains(hit)), w: Math.round(b.width), h: Math.round(b.height) };
    }, EXIT);
    check('portrait stream: its own Exit fullscreen is on top, what a tap at its centre hits', exitHit.label === 'Exit fullscreen', exitHit);
    if (exitHit.label === 'Exit fullscreen') {
        await tapControl(P, STREAM, EXIT, outOfFullscreen);
        await sleep(1500);
    } else {
        await forceOut();
    }
    let back = await layoutBack(P);
    web = webViewBox();
    check('portrait stream: a real tap on Exit fullscreen gives the layout back (voice bar, chat header, tabs)',
        exitHit.label === 'Exit fullscreen' && !back.fullscreen && back.voiceBar && back.chatHeader && back.tabs, back);
    check('portrait stream: and Android\'s status and navigation bars', !!web && web.top > 0 && web.bottom < disp.h, web && [web.left, web.top, web.right, web.bottom]);

    // ---- 2. the camera, in the stage's camera strip ----
    step('portrait: the camera\'s Fullscreen, a real tap');
    await tapControl(P, CAMERA, '.camera-rail-fullscreen', inFullscreen);
    await sleep(1500);
    m = await measure(P, `${CAMERA}.is-app-fullscreen`);
    web = webViewBox();
    save('02-camera-fullscreen.png', screencap());
    fullscreenChecks('portrait camera', m, web, disp);
    const camExit = await P.evaluate(() => document.querySelector('.camera-rail-fullscreen')?.getAttribute('aria-label') ?? null);
    check('portrait camera: its button is now Exit fullscreen', camExit === 'Exit fullscreen', camExit);
    if (camExit === 'Exit fullscreen') { await tapControl(P, CAMERA, '.is-app-fullscreen .camera-rail-fullscreen', outOfFullscreen); await sleep(1500); } else await forceOut();
    back = await layoutBack(P);
    check('portrait camera: leaving gives the layout back', camExit === 'Exit fullscreen' && !back.fullscreen && back.voiceBar && back.chatHeader, back);

    // ---- 3. sideways ----
    step('sideways: the stream\'s Fullscreen, then Android\'s Back');
    await turn(1);
    await until(() => P.evaluate(() => innerWidth > innerHeight), 8000);
    disp = display();
    const sideTakeover = await P.evaluate(() => document.documentElement.dataset.streamTakeover ?? null);
    check('sideways: the stage takes over (precondition)', sideTakeover === 'landscape', sideTakeover);
    const sideIn = await tapControl(P, STREAM, FS, inFullscreen);
    await sleep(1500);
    m = await measure(P, `${STREAM}.is-app-fullscreen`);
    web = webViewBox();
    save('03-sideways-fullscreen.png', screencap());
    fullscreenChecks('sideways stream', m, web, disp);
    // Back with nothing open leaves the app by design: pressed only in fullscreen.
    if (sideIn) { sh('input keyevent KEYCODE_BACK'); await sleep(2000); }
    const sideFront = sideIn && appInFront();
    check('sideways: Android\'s Back leaves fullscreen and the app stays in front', sideFront, 'the app is no longer the activity in front');
    if (sideFront) {
        back = await layoutBack(P);
        check('sideways: and the sideways takeover is back, still in the call', !back.fullscreen && back.takeover === 'landscape' && back.inCall, back);
    }
    await turn(0);
    await until(() => P.evaluate(() => innerHeight > innerWidth), 8000);
    disp = display();

    // ---- 4. portrait, Back ----
    if (!sideFront) {
        check('portrait: Android\'s Back leaves fullscreen and the app stays in front (not run: the app was closed above)', false);
    } else {
        step('portrait: the stream\'s Fullscreen, then Android\'s Back');
        const again = await tapControl(P, STREAM, FS, inFullscreen);
        await sleep(1500);
        m = await measure(P, `${STREAM}.is-app-fullscreen`);
        check('portrait (again): in fullscreen before Back (precondition)', again && !!m.box && m.box.t <= 0 && m.box.b >= m.vh && m.box.r >= m.vw, m.box);
        // Back with nothing open leaves the app by design: pressed only in fullscreen.
        if (again) { sh('input keyevent KEYCODE_BACK'); await sleep(2000); }
        const front = again && appInFront();
        check('portrait: Android\'s Back leaves fullscreen and the app stays in front', front, 'the app is no longer the activity in front');
        if (front) {
            back = await layoutBack(P);
            web = webViewBox();
            check('portrait: and the layout is back, still in the call', !back.fullscreen && back.takeover === null && back.voiceBar && back.chatHeader && back.tabs && back.inCall, back);
            check('portrait: and Android\'s bars', !!web && web.top > 0 && web.bottom < disp.h, web && [web.left, web.top, web.right, web.bottom]);
        }
        save('04-after-back.png', screencap());
    }
} catch (e) {
    console.log(`FAIL  the walk stopped: ${e?.message ?? e}`);
    failed++;
} finally {
    if (rotated) {
        try {
            const [mode, rot] = rotationWas.split(/\s+/);
            sh(mode === 'free' ? 'wm user-rotation free' : `wm user-rotation lock ${/^\d$/.test(rot || '') ? rot : 0}`);
        } catch { /* emulator gone */ }
    }
    for (const b of browsers) await b.close().catch(() => {});
    if (forwarded) { try { adb('forward', '--remove', `tcp:${CDP_PORT}`); } catch { /* gone */ } }
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
