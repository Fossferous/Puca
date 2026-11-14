// LIVE: the Android app's camera in a call, FRONT and REAR, as the other side
// sees it. The owner's report: "clicking 'flip' on camera just mirrors the
// image, there should be an option to use rear cameras too".
//
// The phone is the REAL debug APK on a HEADLESS emulator (`-no-window
// -no-audio`; only an emulator-NNNN serial is accepted), whose two virtual
// cameras are told apart by Android itself (`android.lens.facing`): the front
// one `emulated`, the back one `virtualscene`. Every press on Púca's own
// controls is a REAL touch (adb input tap at the element's place on the
// screen). The viewer is headless Edge, --mute-audio, on a vite dev server of
// this tree. Nothing is shown on, or played through, this PC.
//
// What it proves, each measured:
//   - the camera starts on the FRONT camera (its track says facingMode
//     "user"), its self-view is mirrored, and the viewer's picture of it is
//     what the phone's own preview shows (8x16 likeness);
//   - Flip, a real tap, puts the REAR camera on: the track says "environment"
//     and carries the back camera's label, the self-view is NOT mirrored any
//     more, the viewer's picture changes to what the phone now shows (and is
//     unlike the front camera's), frames keep arriving, and both panels still
//     say Encrypted (mesh) / the viewer still opens it encrypted (SFU=1);
//   - Flip again: front, mirrored, the viewer back on the front picture;
//   - the camera menu lists every camera the phone has by its name, a real tap
//     on the back one switches to it, and the choice is remembered: the camera
//     turned off and on again opens the back camera;
//   - every camera control is on screen, >= 44 px and what a tap there hits.
// NEGATIVE CONTROL: the same run against a debug APK built before the fix
// (its Flip asked for the front camera again) fails the flip checks; that is
// how the bug was reproduced (docs/USER_GUIDE.md, Cameras: front, rear and the camera menu).
//
// Needs: a THROWAWAY backend + Postgres reachable on the host as API, a vite
// dev server of this tree at APP built against that API, the debug APK of this
// tree installed on SERIAL with `adb reverse tcp:<api port>` (see
// android-share-live.mjs's header for the APK, the cleartext debug overlay it
// needs and SFU on an emulator; the same rules hold here).
//
// Usage: SERIAL=emulator-5584 API=http://127.0.0.1:3010 APP=http://127.0.0.1:5196 [SFU=1] [OUT=dir] node e2e/android-camera-flip-live.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERIAL = process.env.SERIAL || '';
const API = process.env.API || 'http://127.0.0.1:3010';
const APP = process.env.APP || 'http://127.0.0.1:5196';
const SFU = process.env.SFU === '1';
const OUT = process.env.OUT || '';
const CHANNEL = process.env.CHANNEL || 'msedge';
const PKG = 'com.sovereign.app';
const CDP_PORT = Number(process.env.CDP_PORT || 9348);
/** OFF_ON=1: only the camera turned off and on again, with no flip, and what
 *  the viewer's tile shows after it (run against a build before this change
 *  to tell whether that is this change's doing). */
const OFF_ON = process.env.OFF_ON === '1';
/** The viewer's tile is checked wherever one is on its screen; TILE=1 demands one. */
const TILE = process.env.TILE === '1';
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!/^emulator-\d+$/.test(SERIAL)) {
    console.error('SERIAL must name an emulator (emulator-NNNN); refusing to touch any other device.');
    process.exit(2);
}
const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const sh = (cmd) => adb('shell', cmd).toString('utf8');

async function until(fn, ms = 15000, stepMs = 300) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(stepMs); }
    return last;
}
let failed = 0;
const step = (what) => console.log(`--    ${what}`);
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
    if (!ok) failed++;
    return ok;
};
const save = (name, bytes) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), bytes); } };

// ---- the phone's own UI ------------------------------------------------------

function uiNodes() {
    // uiautomator can refuse a dump while the screen is busy (it waits for an
    // idle UI): once more, and then nothing found rather than the run ended.
    let xml = '';
    for (let i = 0; i < 2 && !xml; i++) {
        try {
            sh('uiautomator dump /sdcard/puca-ui.xml >/dev/null 2>&1');
            xml = sh('cat /sdcard/puca-ui.xml');
        } catch { /* busy: again, or nothing */ }
    }
    const nodes = [];
    for (const m of xml.matchAll(/<node [^>]*>/g)) {
        const a = (k) => (new RegExp(`${k}="([^"]*)"`).exec(m[0]) || [])[1] || '';
        const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a('bounds'));
        if (!b) continue;
        nodes.push({ text: a('text'), desc: a('content-desc'), cls: a('class'),
            x: (+b[1] + +b[3]) >> 1, y: (+b[2] + +b[4]) >> 1, left: +b[1], top: +b[2] });
    }
    return nodes;
}
const findNode = (re) => uiNodes().find(n => re.test(n.text) || re.test(n.desc));
async function tapText(re, ms = 10000) {
    const n = await until(() => findNode(re), ms, 500);
    if (!n) return false;
    sh(`input tap ${n.x} ${n.y}`);
    return true;
}
async function answerSystemDialogs() {
    for (let i = 0; i < 5; i++) {
        // On a busy machine Android can put "System UI isn't responding" over
        // everything (a cold-booted emulator did, over the prompt below): Wait
        // is the answer that closes nothing.
        if (findNode(/isn.t responding/i)) {
            console.log('      (Android said its System UI is not responding; answered Wait)');
            await tapText(/^Wait$/i, 2000);
            await sleep(1500);
            continue;
        }
        if (!findNode(/always run in background|battery optimi[sz]ation/i)) return;
        await tapText(/^(Deny|Don.t allow|No)$/i, 2000);
        await sleep(800);
    }
}
let webOrigin = null;
/** A REAL touch at the centre of the first visible match of `selector`
 *  (optionally the one whose text matches `text`). Answers its box. */
async function realTap(page, selector, text = null) {
    const r = await page.evaluate(({ sel, text }) => {
        const re = text ? new RegExp(text) : null;
        const e = [...document.querySelectorAll(sel)].find(x => x.getClientRects().length > 0 && (!re || re.test((x.textContent || '').trim())));
        if (!e) return null;
        e.scrollIntoView({ block: 'nearest' });
        const b = e.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, dpr: devicePixelRatio };
    }, { sel: selector, text });
    if (!r) return null;
    if (!webOrigin) {
        const web = uiNodes().find(n => n.cls === 'android.webkit.WebView');
        webOrigin = { left: web ? web.left : 0, top: web ? web.top : 0 };
    }
    // On a loaded machine `input tap` can take seconds between its down and
    // its up, and Android then makes it a LONG press (contextmenu, no click):
    // that is the emulator's lateness, not a tap. Such a press is closed and
    // tapped again, and the run says so.
    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => { window.__longPress = false; document.addEventListener('contextmenu', () => { window.__longPress = true; }, { once: true, capture: true }); });
        sh(`input tap ${Math.round(webOrigin.left + r.x * r.dpr)} ${Math.round(webOrigin.top + r.y * r.dpr)}`);
        await sleep(150);
        if (!await page.evaluate(() => window.__longPress)) break;
        longPresses++;
        console.log(`--    (the emulator made a tap on ${selector} a long press; tapping again)`);
        sh('input keyevent KEYCODE_ESCAPE');
        await sleep(600);
    }
    return r;
}
let longPresses = 0;
const geometry = (page, selector, text = null) => page.evaluate(({ sel, text }) => {
    const re = text ? new RegExp(text) : null;
    const e = [...document.querySelectorAll(sel)].find(x => x.getClientRects().length > 0 && (!re || re.test((x.textContent || '').trim())));
    if (!e) return null;
    const b = e.getBoundingClientRect();
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        onScreen: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
        hits: !!hit && (hit === e || e.contains(hit)) };
}, { sel: selector, text });
const screencap = () => adb('exec-out', 'screencap', '-p');

// ---- the pages ---------------------------------------------------------------

const VIEWER_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
    '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'];
const QUIET = () => {
    try {
        const k = 'sovereign_settings';
        const s = JSON.parse(localStorage.getItem(k) || '{}');
        Object.assign(s, { joinWithoutMic: true, soundsEnabled: false, joinLeaveSound: false, voiceTTS: false, streamSound: false });
        localStorage.setItem(k, JSON.stringify(s));
    } catch { /* storage refused */ }
};
const EMULATOR_LOOPBACK = () => {
    const fix = (x) => (typeof x === 'string' ? x.replace(/ 127\.0\.0\.1 (\d+) typ host/g, ' 10.0.2.2 $1 typ host') : x);
    const P = window.RTCPeerConnection.prototype;
    const setRemote = P.setRemoteDescription;
    P.setRemoteDescription = function (d, ...rest) {
        return setRemote.call(this, d && d.sdp ? { type: d.type, sdp: fix(d.sdp) } : d, ...rest);
    };
    const addCandidate = P.addIceCandidate;
    P.addIceCandidate = function (c, ...rest) {
        if (c && c.candidate) {
            const j = typeof c.toJSON === 'function' ? c.toJSON() : c;
            c = { ...j, candidate: fix(j.candidate) };
        }
        return addCandidate.call(this, c, ...rest);
    };
};
const VIEWER_INIT = () => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...a) { const pc = new Native(...a); window.__pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = Native.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, Native);
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
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 300000 });
    await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 300000 });
    await sleep(2000);
    await dismiss(page);
}
const call = (page, mod, fn, a = []) => page.evaluate(async ({ mod, fn, a }) => (await import(mod))[fn](...a), { mod, fn, a });
const uidOf = (p) => p.evaluate(() => { try { const t = localStorage.getItem('auth_token') || ''; return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { return null; } });
const badge = (page) => page.evaluate(() => document.querySelector('.voice-e2ee .voice-e2ee-label')?.textContent ?? null);
const SEL = { connected: '[data-testid="voice-connected"], .voice-connected-label' };

const BLOCK_GRID = `window.blockGrid = (d) => {
    const out = [];
    for (let by = 0; by < 16; by++) for (let bx = 0; bx < 8; bx++) {
        const x0 = Math.floor(bx * d.width / 8), x1 = Math.floor((bx + 1) * d.width / 8);
        const y0 = Math.floor(by * d.height / 16), y1 = Math.floor((by + 1) * d.height / 16);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * d.width + x) * 4; r += d.data[i]; g += d.data[i + 1]; b += d.data[i + 2]; n++; }
        out.push(r / n, g / n, b / n, 255);
    }
    return out;
};
window.gridOfVideo = async (el) => {
    await new Promise(r => requestAnimationFrame(() => r()));
    if (!el || el.videoWidth === 0) return null;
    const c = document.createElement('canvas'); c.width = el.videoWidth; c.height = el.videoHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(el, 0, 0);
    window.__shot = c.toDataURL('image/png');
    return blockGrid(g.getImageData(0, 0, c.width, c.height));
};`;

/** The phone's own camera, as its page has it: the live video track's
 *  settings and label, every <video> showing it and whether each is drawn
 *  mirrored, and an 8x16 grid of its picture (unmirrored, as captured). */
const phoneCamera = async (P) => { await P.evaluate(BLOCK_GRID); return P.evaluate(async () => {
    const vids = [...document.querySelectorAll('video')];
    let track = null;
    for (const v of vids) {
        const t = v.srcObject?.getVideoTracks?.().find(x => x.readyState === 'live');
        if (t && (v.closest('.camera-preview-mini, .camera-fullscreen') || v.classList.contains('vs-camera-video'))) { track = t; break; }
    }
    if (!track) return { live: false };
    const shows = vids.filter(v => v.srcObject?.getVideoTracks?.().includes(track) && v.getBoundingClientRect().width > 0);
    const mirrored = shows.map(v => {
        const m = getComputedStyle(v).transform;
        const a = m && m !== 'none' ? Number(m.replace(/^matrix\(/, '').split(',')[0]) : 1;
        return { cls: v.className || v.parentElement?.className || '', mirrored: a < 0 };
    });
    const s = track.getSettings();
    // The self-view the person looks at: its own frame count (rising = it
    // renders the camera; a black self-view does not count).
    const self = shows.find(v => v.closest('.camera-preview-mini, .camera-fullscreen')) ?? null;
    const selfFrames = self?.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
    // Sample from a private element: the visible ones may be mid-transition.
    window.__phoneProbe ??= new Map();
    let el = window.__phoneProbe.get(track);
    if (!el) {
        el = document.createElement('video'); el.muted = true; el.playsInline = true;
        el.srcObject = new MediaStream([track]);
        window.__phoneProbe.set(track, el);
        await el.play().catch(() => {});
        await new Promise(r => setTimeout(r, 500));
    }
    const grid = await window.gridOfVideo(el);
    return { live: true, id: track.id, label: track.label, facingMode: s.facingMode ?? null, deviceId: s.deviceId ?? null,
        w: s.width, h: s.height, mirrored, grid, shot: window.__shot, selfFrames, selfW: self?.videoWidth ?? 0 };
}); };

/** The viewer's received camera of `uid`: the NEWEST camera track it has
 *  from the phone (frames decoded, size and a grid), and what the viewer's
 *  own tile of it shows (its frame count and a grid drawn from it). */
const viewerCamera = async (V, uid) => { await V.evaluate(BLOCK_GRID); return V.evaluate(async (uid) => {
    const m = await import('/src/components/voiceState.ts');
    const stream = m.globalCameraStreams.get(uid);
    const all = stream?.getVideoTracks().filter(t => t.readyState === 'live') ?? [];
    // Each track's decoded frames now and a second later: the camera is the
    // one whose count moves (the last one when none or several do).
    const decoded = async (t) => {
        let n = 0;
        for (const pc of window.__pcs) {
            if (pc.connectionState === 'closed') continue;
            for (const r of pc.getReceivers()) if (r.track === t) (await r.getStats()).forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'video') n += s.framesDecoded || 0; });
        }
        return n;
    };
    let track = all[all.length - 1];
    if (all.length > 1) {
        const a = await Promise.all(all.map(decoded));
        await new Promise(r => setTimeout(r, 1200));
        const b = await Promise.all(all.map(decoded));
        const moving = all.filter((_, i) => b[i] > a[i]);
        if (moving.length === 1) track = moving[0];
    }
    if (!track) return { live: false };
    const tileEl = [...document.querySelectorAll('video')].find(v => v.srcObject === stream && v.getClientRects().length > 0) ?? null;
    let tile = null;
    if (tileEl) {
        const q = tileEl.getVideoPlaybackQuality?.();
        tile = { frames: q ? q.totalVideoFrames : null, w: tileEl.videoWidth, h: tileEl.videoHeight, tracks: all.length, grid: await window.gridOfVideo(tileEl) };
    }
    let frames = 0, w = 0, h = 0;
    for (const pc of window.__pcs) {
        if (pc.connectionState === 'closed') continue;
        for (const r of pc.getReceivers()) {
            if (r.track !== track) continue;
            (await r.getStats()).forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'video') { frames += s.framesDecoded || 0; w = s.frameWidth || w; h = s.frameHeight || h; } });
        }
    }
    window.__probe ??= new Map();
    let el = window.__probe.get(track);
    if (!el) {
        el = document.createElement('video'); el.muted = true;
        el.srcObject = new MediaStream([track]);
        window.__probe.set(track, el);
        await el.play().catch(() => {});
        await new Promise(r => setTimeout(r, 500));
    }
    const grid = await window.gridOfVideo(el);
    return { live: true, frames, w, h, grid, shot: window.__shot, tracks: all.length, tile };
}, uid); };

/** How alike two grids are: the correlation of their luminance, -1..1. */
function likeness(a, b) {
    if (!a || !b) return -1;
    const lum = (g) => { const o = []; for (let i = 0; i < g.length; i += 4) o.push(0.299 * g[i] + 0.587 * g[i + 1] + 0.114 * g[i + 2]); return o; };
    const x = lum(a), y = lum(b);
    const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : (sxx === syy ? 1 : 0);
}
/** Mean colour distance between two grids, 0..441. */
function distance(a, b) {
    if (!a || !b) return 999;
    let d = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) { d += Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]); n++; }
    return d / n;
}
const r3 = (x) => Math.round(x * 1000) / 1000;
const shotOf = (dataUrl) => Buffer.from((dataUrl || ',').split(',')[1] || '', 'base64');

let forwarded = false;
const browsers = [];
try {
    // The desktop viewer first: its page comes from a dev server, and with
    // the phone's app starting at the same time a loaded machine starved it
    // for minutes.
    step('the viewer');
    const b = await chromium.launch({ channel: CHANNEL, headless: true, args: VIEWER_ARGS }); browsers.push(b);
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(VIEWER_INIT);
    await ctx.addInitScript(QUIET);
    const V = await ctx.newPage();
    V.setDefaultTimeout(120000); // a loaded machine: see the viewer's comment above
    V.on('pageerror', (e) => console.log(`  [viewer pageerror] ${e.message.slice(0, 200)}`));
    await V.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 300000 });
    await V.getByPlaceholder('Enter username').waitFor({ timeout: 300000 });
    step('a fresh app');
    const attached = execFileSync(ADB, ['devices'], { encoding: 'utf8' });
    if (!attached.split('\n').map(l => l.trim().split(/\s+/)).some(([s, st]) => s === SERIAL && st === 'device')) throw new Error(`${SERIAL} is not attached`);
    const cams = sh('dumpsys media.camera');
    check('fixture: the emulator has a front and a back camera', /Facing: Front/.test(cams) && /Facing: Back/.test(cams));
    sh(`pm clear ${PKG}`);
    for (const perm of ['CAMERA', 'RECORD_AUDIO', 'POST_NOTIFICATIONS']) sh(`pm grant ${PKG} android.permission.${perm}`);
    sh('cmd statusbar collapse');
    sh(`am start -W -n ${PKG}/.MainActivity`);
    step('waiting for its WebView');
    const pid = (await until(() => sh(`pidof ${PKG}`).trim(), 30000)) || '';
    await until(() => sh('cat /proc/net/unix').includes(`webview_devtools_remote_${pid}`), 30000);
    adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);
    forwarded = true;
    // A cold-booted emulator on a busy machine can take more than a minute to
    // bring the app's WebView up.
    const wvBrowser = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`), 90000, 1000);
    if (!wvBrowser) throw new Error("the app's WebView did not answer DevTools (the emulator still busy booting?)");
    browsers.push(wvBrowser);
    const P = await until(() => wvBrowser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://localhost')), 30000);
    if (!P) throw new Error('the page of the app did not appear');
    P.setDefaultTimeout(120000);
    P.on('console', (m) => { const t = m.text(); if (/camera|\[WebRTC\]|facing/i.test(t)) console.log(`  [phone] ${t.slice(0, 240)}`); });
    if (SFU) await P.context().addInitScript(EMULATOR_LOOPBACK);
    await P.evaluate(QUIET);
    await P.reload({ waitUntil: 'domcontentloaded' });


    step('signing up both');
    await signUp(V, `camv_${stamp}`);
    await signUp(P, `camp_${stamp}`);
    const uid = { V: await uidOf(V), P: await uidOf(P) };
    const srv = await call(V, '/src/api/servers.ts', 'createServer', ['CF ' + stamp.slice(-4)]);
    const voice = await call(V, '/src/api/servers.ts', 'createChannel', [srv.id, 'Camera room', 1]);
    if (SFU) await call(V, '/src/api/servers.ts', 'updateChannel', [voice.id, { sfu_mode: true }]);
    const inv = await call(V, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);
    const joined = await P.evaluate(async ({ api, code }) => {
        const r = await fetch(`${api}/invites/${code}/join`, { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } });
        return r.status;
    }, { api: API, code: inv.code });
    check(`fixture: a server with a ${SFU ? 'SFU' : 'mesh'} voice channel, the phone a member`, joined < 300 && Number.isInteger(uid.V) && Number.isInteger(uid.P), { joined, uid });

    for (const p of [V, P]) { await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000); await dismiss(p); }
    for (const [tag, p] of [['viewer', V], ['phone', P]]) {
        await p.evaluate((id) => document.querySelector(`[data-testid="server-icon"][data-server-id="${id}"]`)?.click(), srv.id);
        await sleep(1200);
        await p.evaluate((id) => document.querySelector(`[data-testid="voice-channel"][data-channel-id="${id}"]`)?.click(), voice.id);
        check(`${tag} is in the call`, !!await until(async () => (await p.locator(SEL.connected).count()) > 0, 30000));
    }
    await sleep(3000);
    await answerSystemDialogs();
    // The viewer looks at the call (its stage, where the phone's camera tile is).
    await V.evaluate((id) => document.querySelector(`[data-testid="voice-channel"][data-channel-id="${id}"]`)?.click(), voice.id);
    check('the viewer has the call on screen (its stage)', !!await until(() => V.evaluate(() => !!document.querySelector('.voice-stage-grid')), 8000));

    // ---- the camera on: the front one ----
    step('camera on, by a real tap');
    await P.evaluate(() => {
        if (document.querySelector('.vp-camera')?.offsetParent) return;
        document.querySelector('button[aria-label="More voice controls"]')?.click();
    });
    await sleep(700);
    const camBtn = await geometry(P, '.vp-camera');
    check('the camera button is on screen, >= 44 px, and what a tap there hits', !!camBtn && camBtn.onScreen && camBtn.w >= 44 && camBtn.h >= 44 && camBtn.hits, camBtn);
    await realTap(P, '.vp-camera');
    const front = await until(async () => { const c = await phoneCamera(P); return c.live && c.grid ? c : null; }, 20000, 800) ?? { live: false };
    check('the camera is on', front.live, { label: front.label });
    check('it starts on the FRONT camera (facingMode "user")', front.facingMode === 'user', { facingMode: front.facingMode, label: front.label });
    check('the front camera\'s self-view is mirrored (every place it is shown)', front.live && front.mirrored.length > 0 && front.mirrored.every(m => m.mirrored), front.mirrored);
    save('front-phone.png', shotOf(front.shot));
    await selfViewRenders('front');
    save('front-screen.png', screencap());

    /** After the camera was turned OFF and on again the viewer's tile used to
     *  show the dead track from before (the mesh stream held both, the dead
     *  one first; reported as KNOWN before the fix): a check now,
     *  like every other tile. */
    /** The phone's own self-view renders the camera: its frames rise. */
    async function selfViewRenders(tag) {
        const a = await phoneCamera(P);
        const b2 = await until(async () => { const c = await phoneCamera(P); return c.selfFrames > (a.selfFrames ?? 0) && c.selfW > 0 ? c : null; }, 8000, 500) ?? await phoneCamera(P);
        check(`${tag}: the phone's own self-view shows the camera (its frames rise)`, b2.selfW > 0 && b2.selfFrames > (a.selfFrames ?? 0), { before: a.selfFrames, after: b2.selfFrames, w: b2.selfW });
    }
    const viewerSees = async (tag, phone) => {
        const v1 = await until(async () => { const r = await viewerCamera(V, uid.P); return r.live && r.frames > 0 && r.grid ? r : null; }, 30000, 1000) ?? { live: false };
        await sleep(2000);
        const v2 = await until(async () => { const r = await viewerCamera(V, uid.P); return r.live && r.frames > (v1.frames ?? 0) ? r : null; }, 8000, 700) ?? await viewerCamera(V, uid.P);
        const p2 = await phoneCamera(P);
        save(`${tag}-viewer.png`, shotOf(v2.shot));
        if (OUT) save(`${tag}-viewer-page.png`, await V.screenshot());
        const like = likeness(v2.grid, p2.grid);
        check(`${tag}: the viewer receives the phone's camera, frames rising`, !!v1.live && v2.live && v2.frames > v1.frames, { before: v1.frames, after: v2.frames, w: v2.w, h: v2.h });
        check(`${tag}: the viewer's picture IS what the phone's camera shows (8x16 likeness >= 0.6)`, like >= 0.6, { likeness: r3(like) });
        if (v2.tile || TILE) {
            const tl = v2.tile ? likeness(v2.tile.grid, p2.grid) : -1;
            check(`${tag}: and the viewer's own tile shows it (8x16 likeness >= 0.6)`, !!v2.tile && tl >= 0.6, { likeness: r3(tl), tracks: v2.tracks });
        }
        return { v: v2, p: p2 ?? phone };
    };
    const seenFront = await viewerSees('front', front);
    const enc = async (tag) => {
        if (SFU) {
            const st = await V.evaluate(async (id) => (await import('/src/api/rtc/sfuManager.ts')).sfuManager.allMediaE2eeStatuses().find(s => s.userId === id) ?? null, uid.P);
            check(`${tag}: LiveKit E2EE: the viewer opens the phone's camera encrypted`, !!st && st.encrypted === true, st);
        } else {
            const bs = await until(async () => { const x = [await badge(V), await badge(P)]; return x[0] === 'Encrypted' && x[1] === 'Encrypted' ? x : null; }, 15000) ?? [await badge(V), await badge(P)];
            check(`${tag}: both panels say Encrypted`, bs[0] === 'Encrypted' && bs[1] === 'Encrypted', bs);
        }
    };
    await enc('front');

    if (OFF_ON) {
        step('OFF_ON: camera off and on again, no flip');
        const tileBefore = (await viewerCamera(V, uid.P)).tile;
        await realTap(P, '.vp-camera');
        await until(async () => !(await phoneCamera(P)).live, 10000, 500);
        await sleep(1500);
        await realTap(P, '.vp-camera');
        const on2 = await until(async () => { const c = await phoneCamera(P); return c.live && c.grid ? c : null; }, 20000, 800) ?? { live: false };
        await sleep(4000);
        const a = await viewerCamera(V, uid.P);
        await sleep(2500);
        const b2 = await viewerCamera(V, uid.P);
        const p2 = await phoneCamera(P);
        if (OUT) save('offon-viewer-page.png', await V.screenshot());
        check('OFF_ON: the phone\'s camera is on again', on2.live);
        check('OFF_ON: the viewer receives the new camera track (newest track, frames rising)', b2.live && b2.frames > a.frames, { tracks: b2.tracks, before: a.frames, after: b2.frames });
        check('OFF_ON: the viewer\'s TILE shows it (frames rising, the phone\'s picture)', !!b2.tile && !!a.tile && b2.tile.frames > a.tile.frames && likeness(b2.tile.grid, p2.grid) >= 0.6,
            { tileBefore: tileBefore?.frames, a: a.tile?.frames, b: b2.tile?.frames, tracks: b2.tracks, likeness: b2.tile ? r3(likeness(b2.tile.grid, p2.grid)) : null });
        if (!SFU) {
            // The camera went back on its own sender: ONE video transceiver
            // between the two (it used to add a second, the viewer's stream
            // then holding the dead track first). Counted on the viewer's
            // side, whose connections this walk tracks (the phone runs the
            // APK's built bundle: none of its modules can be imported).
            const lines = await V.evaluate(() => window.__pcs.filter(pc => pc.connectionState !== 'closed')
                .flatMap(pc => pc.getTransceivers()).filter(t => t.receiver.track.kind === 'video').length);
            check("OFF_ON: the phone's camera went back on its own sender (one video transceiver between them)", lines === 1, { videoTransceivers: lines });
        }
        throw new Error('OFF_ON done');
    }

    // ---- Flip: the rear camera ----
    /** Press Flip. On the build before the fix, Flip sat behind a tap on the
     *  self-view, which mostly did nothing: tapped until its options show. */
    async function flip() {
        if (await geometry(P, '[data-testid="camera-flip"]')) return realTap(P, '[data-testid="camera-flip"]');
        for (let i = 0; i < 4; i++) {
            if (await geometry(P, '.camera-fullscreen-controls button', 'Flip')) return realTap(P, '.camera-fullscreen-controls button', 'Flip');
            await realTap(P, '.camera-preview-mini');
            await sleep(700);
            if (await geometry(P, '.pip-option-btn', '^Flip')) return realTap(P, '.pip-option-btn', '^Flip');
            if (await geometry(P, '.camera-fullscreen-controls button', 'Flip')) return realTap(P, '.camera-fullscreen-controls button', 'Flip');
            await sleep(3500); // the old options close by themselves after 3 s
        }
        return null;
    }
    step('Flip, by a real tap');
    const flipGeo = await geometry(P, '[data-testid="camera-flip"]');
    check('Flip is ON the self-view, on screen, >= 44 px, and what a tap there hits', !!flipGeo && flipGeo.onScreen && flipGeo.w >= 44 && flipGeo.h >= 44 && flipGeo.hits, flipGeo);
    await flip();
    const rear = await until(async () => { const c = await phoneCamera(P); return c.live && c.id !== front.id && c.grid ? c : null; }, 15000, 800)
        ?? await phoneCamera(P);
    save('rear-phone.png', shotOf(rear.shot));
    save('rear-screen.png', screencap());
    check('Flip opens a new camera track', rear.live && rear.id !== front.id, { before: front.id, after: rear.id });
    check('Flip puts the REAR camera on (facingMode "environment")', rear.facingMode === 'environment', { facingMode: rear.facingMode, label: rear.label });
    check('the rear camera\'s self-view is NOT mirrored, anywhere', rear.live && rear.mirrored.length > 0 && rear.mirrored.every(m => !m.mirrored), rear.mirrored);
    await selfViewRenders('rear');
    const seenRear = await viewerSees('rear', rear);
    const change = { likeness: r3(likeness(seenRear.v.grid, seenFront.v.grid)), distance: Math.round(distance(seenRear.v.grid, seenFront.v.grid)) };
    check('the viewer\'s picture changed to another camera\'s (unlike the front camera\'s picture)', change.likeness < 0.5 || change.distance > 40, change);
    await enc('rear');

    step('Flip back');
    await flip();
    const back = await until(async () => { const c = await phoneCamera(P); return c.live && c.id !== rear.id && c.grid ? c : null; }, 15000, 800)
        ?? await phoneCamera(P);
    check('Flip again: the FRONT camera, mirrored again', back.facingMode === 'user' && back.mirrored.length > 0 && back.mirrored.every(m => m.mirrored), { facingMode: back.facingMode, mirrored: back.mirrored });
    await selfViewRenders('front-again');
    const seenBack = await viewerSees('front-again', back);
    check('the viewer is back on the front camera\'s picture (unlike the rear\'s)', likeness(seenBack.v.grid, seenRear.v.grid) < 0.5 || distance(seenBack.v.grid, seenRear.v.grid) > 40,
        { likeness: r3(likeness(seenBack.v.grid, seenRear.v.grid)), distance: Math.round(distance(seenBack.v.grid, seenRear.v.grid)) });

    // ---- the camera menu: every camera by name, the choice remembered ----
    // ---- a tap on the self-view opens the camera menu, every time ----
    step('taps on the self-view');
    let opened = 0;
    for (let i = 0; i < 4; i++) {
        if (await P.evaluate(() => !!document.querySelector('.camera-fullscreen'))) {
            // The old second tap went full screen: back out first.
            await realTap(P, '.camera-fullscreen-controls .exit-btn');
            await sleep(800);
        }
        await realTap(P, '.camera-preview-mini');
        const got = await until(() => P.evaluate(() => [...document.querySelectorAll('[data-testid="camera-option"], .pip-option-btn')].some(e => e.getClientRects().length > 0)), 1500, 150);
        if (got) opened++;
        if (await P.evaluate(() => !!document.querySelector('[data-testid="camera-option"]'))) { sh('input keyevent KEYCODE_ESCAPE'); await sleep(500); }
        else if (got) await sleep(3500); // the old options close by themselves
    }
    check('a real tap on the self-view opens its menu every time (4 of 4)', opened === 4, { opened });

    step('the camera menu');
    await P.evaluate(() => { if (!document.querySelector('.vp-camera')?.offsetParent) document.querySelector('button[aria-label="More voice controls"]')?.click(); });
    await sleep(600);
    const menuBtn = await geometry(P, '[data-testid="camera-options"]');
    check('a camera menu is offered beside the camera button, on screen, >= 44 px, and what a tap there hits', !!menuBtn && menuBtn.onScreen && menuBtn.w >= 44 && menuBtn.h >= 44 && menuBtn.hits, menuBtn);
    if (menuBtn) {
        await realTap(P, '[data-testid="camera-options"]');
        const items = await until(() => P.evaluate(() => {
            const els = [...document.querySelectorAll('[data-testid="camera-option"]')].filter(e => e.getClientRects().length > 0);
            return els.length ? els.map(e => ({ label: (e.textContent || '').trim(), id: e.getAttribute('data-value'), checked: e.getAttribute('aria-checked') })) : null;
        }), 6000) ?? [];
        check('the menu lists both cameras by name', items.length === 2 && items.every(i => i.label && i.id), items);
        check('the camera in use is the checked one', items.filter(i => i.checked === 'true').length === 1 && /front/i.test(items.find(i => i.checked === 'true')?.label || ''), items);
        const rearItem = items.find(i => /back|rear/i.test(i.label));
        await sleep(600); // past the menu's scale-in, which measures it short
        if (rearItem) {
            const g = await geometry(P, `[data-testid="camera-option"][data-value="${rearItem.id}"]`);
            check('each camera in the menu is on screen, >= 44 px tall, and what a tap there hits', !!g && g.onScreen && g.h >= 44 && g.hits, g);
            save('menu-screen.png', screencap());
            await realTap(P, `[data-testid="camera-option"][data-value="${rearItem.id}"]`);
            const chosen = await until(async () => { const c = await phoneCamera(P); return c.live && c.facingMode === 'environment' ? c : null; }, 15000, 800) ?? await phoneCamera(P);
            check('a real tap on the back camera in the menu switches to it', chosen.facingMode === 'environment' && chosen.deviceId === rearItem.id, { facingMode: chosen.facingMode, deviceId: chosen.deviceId, want: rearItem.id });
            await viewerSees('menu-rear', chosen);
            step('camera off and on again');
            await P.evaluate(() => { if (!document.querySelector('.vp-camera')?.offsetParent) document.querySelector('button[aria-label="More voice controls"]')?.click(); });
            await sleep(600);
            await realTap(P, '.vp-camera');
            await until(async () => !(await phoneCamera(P)).live, 10000, 500);
            await sleep(1000);
            await realTap(P, '.vp-camera');
            const again = await until(async () => { const c = await phoneCamera(P); return c.live && c.grid ? c : null; }, 20000, 800) ?? { live: false };
            check('the choice is remembered: the camera back on is the BACK camera, not mirrored', again.facingMode === 'environment' && again.mirrored.length > 0 && again.mirrored.every(m => !m.mirrored),
                { facingMode: again.facingMode, mirrored: again.mirrored });
            await selfViewRenders('remembered');
            await viewerSees('remembered', again);
            await enc('remembered');

            // ---- full screen: its own Flip, mirrored only for the front camera, its buttons whole ----
            step('full screen');
            await realTap(P, '.camera-preview-mini');
            await until(() => P.evaluate(() => !!document.querySelector('[data-testid="camera-option"]')), 4000);
            await realTap(P, '.camera-menu .context-menu-item', '^Full screen$');
            await until(() => P.evaluate(() => !!document.querySelector('.camera-fullscreen') && !document.querySelector('.camera-menu')), 6000);
            await sleep(1500);
            const fs1 = await until(async () => (await geometry(P, '.camera-fullscreen-controls .cam-off-btn')), 6000);
            save('fullscreen-screen.png', screencap());
            check('full screen: Turn Off Camera is a whole button (not squeezed into a circle), >= 44 px, and what a tap there hits',
                !!fs1 && fs1.onScreen && fs1.w > fs1.h && fs1.h >= 44 && fs1.hits, fs1);
            const fsBack = await phoneCamera(P);
            check('full screen on the back camera: not mirrored', fsBack.facingMode === 'environment' && fsBack.mirrored.length > 0 && fsBack.mirrored.every(m => !m.mirrored), fsBack.mirrored);
            await selfViewRenders('full screen');
            const fsFlip = await geometry(P, '.camera-fullscreen-controls [data-testid="camera-flip"]');
            check('full screen: Flip Camera is on screen, >= 44 px, and what a tap there hits', !!fsFlip && fsFlip.onScreen && fsFlip.h >= 44 && fsFlip.hits, fsFlip);
            // On a loaded emulator `input tap` can take seconds between its
            // down and up, and Android then makes it a long press (contextmenu,
            // no click): such a press is tapped again, and said so.
            let fsFront = null;
            for (let i = 0; i < 3 && !fsFront; i++) {
                await P.evaluate(() => { window.__longPress = false; document.addEventListener('contextmenu', () => { window.__longPress = true; }, { once: true, capture: true }); });
                await realTap(P, '.camera-fullscreen-controls [data-testid="camera-flip"]');
                // A starved emulator WebView took 15 s to act on this press once.
                fsFront = await until(async () => { const c = await phoneCamera(P); return c.live && c.facingMode === 'user' ? c : null; }, 45000, 800);
                if (!fsFront && await P.evaluate(() => window.__longPress)) console.log('--    (the emulator made that tap a long press; tapping again)');
                else if (!fsFront) break;
            }
            fsFront ??= await phoneCamera(P);
            check('full screen: its Flip puts the front camera on, mirrored', fsFront.facingMode === 'user' && fsFront.mirrored.length > 0 && fsFront.mirrored.every(m => m.mirrored), { facingMode: fsFront.facingMode, mirrored: fsFront.mirrored });
            await selfViewRenders('full screen, front');
            await viewerSees('fullscreen-front', fsFront);
            await realTap(P, '.camera-fullscreen-controls .exit-btn');
        }
    }
} catch (e) {
    if (!(OFF_ON && /OFF_ON done/.test(String(e?.message)))) {
        console.log('FAIL  the run threw:', e?.stack || e);
        failed++;
    }
} finally {
    for (const b of browsers) await b.close().catch(() => {});
    if (forwarded) { try { adb('forward', '--remove', `tcp:${CDP_PORT}`); } catch { /* gone */ } }
}
if (longPresses) console.log(`--    ${longPresses} tap(s) the loaded emulator turned into long presses were tapped again`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
