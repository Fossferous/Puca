// LIVE: the Android app shares its screen into a call, and a desktop viewer
// sees it, on a mesh call and (SFU=1) on a LiveKit call, encrypted end to end.
//
// The phone is the REAL APK on a HEADLESS emulator (`-no-window -no-audio`),
// driven through its WebView's DevTools (Playwright's _android) and, for
// Android's own consent dialog and the notification shade, uiautomator + input
// over `adb -s <SERIAL>`. The viewer is headless Edge, --mute-audio, on a vite
// dev server of this tree. Nothing is shown on, or played through, this PC.
//
// What it proves, each measured:
//   - Share is offered in the app (the button the voice panel shows), and the
//     tap opens Android's own consent; "Share entire screen" starts it;
//   - the viewer RECEIVES the phone's share and its picture IS the phone's
//     screen: an 8x16 grid of the viewer's decoded frame against the same grid
//     of `adb screencap` (the picture a sealed-but-undecrypted VP8 frame
//     "decodes" to is noise; that is why framesDecoded alone proves nothing);
//   - both panels say Encrypted;
//   - the phone turned sideways: the picture turns with it (wider than tall),
//     and back;
//   - the app in the BACKGROUND keeps sharing (the launcher appears on the
//     viewer's side, frames still rising);
//   - "Stop sharing" in the notification ends the share on both sides, the
//     app's own Stop does too, and a "Cancel" at the consent starts nothing.
//   - WALK=1: the run happens on a 390x844 screen (the emulator's display set
//     to 1024x2216 at its 2.625 density, reset afterwards), every tap on Púca's
//     own controls a REAL touch (adb input tap at the element's place on the
//     screen), and Share, the arrow beside it and the arrow's settings dialog
//     are measured: on screen, >= 44 px, what a tap there hits, no sideways
//     overflow, and the dialog speaking of Android's dialog, not a picker.
//
// Needs: a THROWAWAY backend + Postgres reachable on the host as API, a vite
// dev server of this tree at APP built against that API, the debug APK of this
// tree installed on SERIAL with `adb reverse tcp:<api port>` (the APK's bundle
// built with VITE_API_URL = API and PUCA_ALLOW_LOCAL_BUILD=1). SFU=1 also needs
// the backend wired to a loopback LiveKit the emulator can reach.
// The APK targets a recent Android, which refuses cleartext http, so a test
// build needs a LOCAL, uncommitted debug overlay permitting it to 127.0.0.1
// alone: android/app/src/debug/AndroidManifest.xml setting
// android:networkSecurityConfig (tools:replace) to an xml with
// <domain-config cleartextTrafficPermitted="true"><domain>127.0.0.1</domain>.
// Delete it after the run; it must never reach a shipped APK.
//
// SFU on an emulator, loopback only: LiveKit listens on 127.0.0.1 alone (UDP,
// tcp_port 0; see share-adapt-shaped.mjs's header for the config), and the
// emulator reaches the host's loopback as 10.0.2.2. So on the PHONE page only,
// LiveKit's 127.0.0.1 candidates are rewritten to 10.0.2.2 (EMULATOR_LOOPBACK
// below); nothing listens on any other interface. LK_API/LK_KEY/LK_SECRET (the
// throwaway LiveKit's) add a check that LiveKit itself sees the phone publish
// a screen share.
//
// Usage: SERIAL=emulator-5584 API=http://127.0.0.1:3010 APP=http://127.0.0.1:5196 [SFU=1] [OUT=dir] node e2e/android-share-live.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERIAL = process.env.SERIAL || '';
const API = process.env.API || 'http://127.0.0.1:3010';
const APP = process.env.APP || 'http://127.0.0.1:5196';
const SFU = process.env.SFU === '1';
const WALK = process.env.WALK === '1';
const OUT = process.env.OUT || '';
const CHANNEL = process.env.CHANNEL || 'msedge';
const PKG = 'com.sovereign.app';
const CDP_PORT = Number(process.env.CDP_PORT || 9347);
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

async function until(fn, ms = 15000, step = 300) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(step); }
    return last;
}
let failed = 0;
const step = (what) => console.log(`--    ${what}`);
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
    if (!ok) failed++;
    return ok;
};

// ---- the phone's own UI (consent dialog, notification shade) ---------------

/** Every on-screen node uiautomator sees: text, content-desc, resource id, centre. */
function uiNodes() {
    sh('uiautomator dump /sdcard/puca-ui.xml >/dev/null 2>&1');
    const xml = sh('cat /sdcard/puca-ui.xml');
    const nodes = [];
    for (const m of xml.matchAll(/<node [^>]*>/g)) {
        const a = (k) => (new RegExp(`${k}="([^"]*)"`).exec(m[0]) || [])[1] || '';
        const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a('bounds'));
        if (!b) continue;
        nodes.push({ text: a('text'), desc: a('content-desc'), id: a('resource-id'), cls: a('class'),
            clickable: a('clickable') === 'true', x: (+b[1] + +b[3]) >> 1, y: (+b[2] + +b[4]) >> 1,
            left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] });
    }
    return nodes;
}
const findNode = (re) => uiNodes().find(n => re.test(n.text) || re.test(n.desc));
const tapAt = (n) => sh(`input tap ${n.x} ${n.y}`);
async function tapText(re, ms = 10000) {
    const n = await until(() => findNode(re), ms, 500);
    if (!n) return false;
    tapAt(n);
    return true;
}

/**
 * Android's capture consent: on 14+ a choice of one app or the entire
 * screen, then the button that starts it. Answers what it pressed.
 */
async function consent(answer) {
    const dialog = await until(() => findNode(/Start recording or casting|Share your screen|start (recording|casting)|Share screen with|will have access/i), 15000, 500);
    if (!dialog) return { shown: false };
    if (answer === 'cancel') return { shown: true, pressed: await tapText(/^Cancel$/i, 3000) };
    // The spinner, when there is one: pick the entire screen.
    const spinner = findNode(/^(A single app|Share one app|One app|Entire screen|Share entire screen)$/i);
    if (spinner && !/entire/i.test(spinner.text)) {
        tapAt(spinner);
        await sleep(800);
        await tapText(/^(Entire screen|Share entire screen)$/i, 4000);
        await sleep(800);
    }
    const pressed = await tapText(/^(Start|Start now|Share screen|Next)$/i, 5000);
    return { shown: true, pressed };
}

/**
 * A REAL touch on a page element: its centre in CSS px, scaled by the page's
 * devicePixelRatio and offset by where the WebView sits on the screen.
 * Answers the element's box, or null when it is not there.
 */
async function realTap(page, selector) {
    const r = await page.evaluate((sel) => {
        const e = [...document.querySelectorAll(sel)].find(x => x.offsetParent !== null);
        if (!e) return null;
        e.scrollIntoView({ block: 'nearest' });
        const b = e.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, dpr: devicePixelRatio };
    }, selector);
    if (!r) return null;
    const web = uiNodes().find(n => n.cls === 'android.webkit.WebView');
    const left = web ? web.left : 0, top = web ? web.top : 0;
    sh(`input tap ${Math.round(left + r.x * r.dpr)} ${Math.round(top + r.y * r.dpr)}`);
    return r;
}
/** Where an element is, whether it is on screen, and whether a tap at its
 *  centre reaches it (document.elementFromPoint). */
const geometry = (page, selector) => page.evaluate((sel) => {
    const e = [...document.querySelectorAll(sel)].find(x => x.offsetParent !== null);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        onScreen: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
        hits: !!hit && (hit === e || e.contains(hit)) };
}, selector);

/** The app asks, on joining a call, to run unrestricted in the background
 *  (a system dialog over the page). Answered No here: it is not this test's
 *  question, and a tap meant for the page would land on it. */
async function answerSystemDialogs() {
    for (let i = 0; i < 3; i++) {
        if (!findNode(/always run in background|battery optimi[sz]ation/i)) return;
        await tapText(/^(Deny|Don.t allow|No)$/i, 2000);
        await sleep(800);
    }
}

/** The screen as it is now, PNG bytes. */
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
const LK = { api: process.env.LK_API, key: process.env.LK_KEY, secret: process.env.LK_SECRET }; // the throwaway LiveKit's
/** What LiveKit says each participant publishes, or null without LK_*. */
async function lkTracks(room) {
    if (!LK.api || !LK.key || !LK.secret) return null;
    const { createHmac } = await import('node:crypto');
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: LK.key, sub: 'android-share-check', nbf: now - 5, exp: now + 300, video: { roomAdmin: true, roomList: true, room } })}`;
    const jwt = `${body}.${createHmac('sha256', LK.secret).update(body).digest('base64url')}`;
    const r = await fetch(`${LK.api}/twirp/livekit.RoomService/ListParticipants`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ room }),
    });
    if (!r.ok) return { error: r.status };
    return Object.fromEntries(((await r.json()).participants || []).map(x => [x.identity, (x.tracks || []).map(t => t.source)]));
}
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
const uidOf = (p) => p.evaluate(() => { try { const t = localStorage.getItem('auth_token') || ''; return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { return null; } });
const badge = (page) => page.evaluate(() => document.querySelector('.voice-e2ee .voice-e2ee-label')?.textContent ?? null);
const SEL = {
    share: '[data-testid="voice-share-screen"]',
    stop: '[data-testid="voice-stop-share"]',
    connected: '[data-testid="voice-connected"], .voice-connected-label',
};

/** An 8x16 grid of BLOCK MEANS (RGBA) of an ImageData. A drawImage straight
 *  to 8x16 samples single pixels, and two resolutions of the same dark screen
 *  with thin bright text (the SFU's smaller layer against the phone's own
 *  screencap) then sample different pixels: correlation near 0 for the same
 *  picture. Means over each block compare the pictures, not the sampling. */
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
};`;

/** The viewer's received video of `uid`'s share: decoded frames, size, and an
 *  8x16 RGB grid of the picture (for comparison with the phone's screen). */
const received = async (v, uid) => { await v.evaluate(BLOCK_GRID); return v.evaluate(async (uid) => {
    const m = await import('/src/components/voiceState.ts');
    const track = m.getStreamData(uid)?.stream?.getVideoTracks().find(t => t.readyState === 'live');
    if (!track) return { live: false };
    let frames = 0, w = 0, h = 0;
    for (const pc of window.__pcs) {
        if (pc.connectionState === 'closed') continue;
        for (const r of pc.getReceivers()) {
            if (r.track !== track) continue;
            (await r.getStats()).forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'video') { frames += s.framesDecoded || 0; w = s.frameWidth || w; h = s.frameHeight || h; } });
        }
    }
    // One sampling element per track, kept: a fresh <video> shows nothing until
    // the track's NEXT frame, and a phone screen that is not changing sends
    // about one a second, so a new element read 400 ms later was often black.
    window.__probe ??= new Map();
    let el = window.__probe.get(track);
    if (!el) {
        el = document.createElement('video');
        el.muted = true;
        el.srcObject = new MediaStream([track]);
        window.__probe.set(track, el);
        await el.play().catch(() => {});
        await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => requestAnimationFrame(() => r()));
    let grid = null;
    if (el.videoWidth > 0) {
        const big = document.createElement('canvas'); big.width = el.videoWidth; big.height = el.videoHeight;
        const bg = big.getContext('2d', { willReadFrequently: true });
        bg.drawImage(el, 0, 0);
        grid = blockGrid(bg.getImageData(0, 0, big.width, big.height));
        window.__probeShot = big.toDataURL('image/png');
    }
    return { live: true, frames, w, h, grid };
}, uid); };

/** The same 8x16 grid of a PNG, decoded by the viewer's browser. */
const gridOfPng = async (v, png) => { await v.evaluate(BLOCK_GRID); return v.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return blockGrid(g.getImageData(0, 0, c.width, c.height));
}, png.toString('base64')); };

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

const save = (name, bytes) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), bytes); } };

let forwarded = false;
let resized = false;
let rotated = false;
const browsers = [];
try {
    // ---- the phone ----
    step('a fresh app');
    const attached = execFileSync(ADB, ['devices'], { encoding: 'utf8' });
    const rows = attached.split('\n').map(l => l.trim().split(/\s+/));
    if (!rows.some(([serial, state]) => serial === SERIAL && state === 'device')) throw new Error(`${SERIAL} is not attached`);
    sh(`pm clear ${PKG}`);
    if (WALK) { sh('wm size 1024x2216'); resized = true; }
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh('cmd statusbar collapse');
    sh(`am start -W -n ${PKG}/.MainActivity`);
    // The app's WebView, by its own DevTools socket (webview_devtools_remote_<pid>;
    // the debug build allows it). Not _android.webView(): another app's socket
    // on the same emulator stalled its lookup.
    step('waiting for its WebView');
    const pid = (await until(() => sh(`pidof ${PKG}`).trim(), 30000)) || '';
    await until(() => sh('cat /proc/net/unix').includes(`webview_devtools_remote_${pid}`), 30000);
    adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);
    forwarded = true;
    const wvBrowser = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`), 30000, 1000);
    browsers.push(wvBrowser);
    const P = await until(() => wvBrowser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://localhost')), 30000);
    if (!P) throw new Error('the page of the app did not appear');
    P.on('console', (m) => { const t = m.text(); if (/ScreenShare|nativeScreen|\[sfu|VoicePanel.*(share|capture)/i.test(t)) console.log(`  [phone] ${t.slice(0, 240)}`); });
    if (SFU) await P.context().addInitScript(EMULATOR_LOOPBACK);
    await P.evaluate(QUIET);
    await P.reload({ waitUntil: 'domcontentloaded' });

    // ---- the viewer ----
    const b = await chromium.launch({ channel: CHANNEL, headless: true, args: VIEWER_ARGS }); browsers.push(b);
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(VIEWER_INIT);
    await ctx.addInitScript(QUIET);
    const V = await ctx.newPage();
    V.on('pageerror', (e) => console.log(`  [viewer pageerror] ${e.message.slice(0, 200)}`));
    await V.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });

    step('signing up both');
    await signUp(V, `andv_${stamp}`);
    await signUp(P, `andp_${stamp}`);
    const uid = { V: await uidOf(V), P: await uidOf(P) };

    const srv = await call(V, '/src/api/servers.ts', 'createServer', ['AS ' + stamp.slice(-4)]);
    const voice = await call(V, '/src/api/servers.ts', 'createChannel', [srv.id, 'Phone stage', 1]);
    if (SFU) await call(V, '/src/api/servers.ts', 'updateChannel', [voice.id, { sfu_mode: true }]);
    const inv = await call(V, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);
    const joined = await P.evaluate(async ({ api, code }) => {
        const r = await fetch(`${api}/invites/${code}/join`, { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } });
        return r.status;
    }, { api: API, code: inv.code });
    check(`fixture: a server with a ${SFU ? 'SFU' : 'mesh'} voice channel, the phone a member`, joined < 300 && Number.isInteger(uid.V) && Number.isInteger(uid.P), { joined, uid });

    for (const p of [V, P]) { await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000); await dismiss(p); }
    // Into the call: the viewer by its sidebar, the phone the same way (the
    // channel list is the phone's first screen once the server is chosen).
    for (const [tag, p] of [['viewer', V], ['phone', P]]) {
        await p.evaluate((id) => document.querySelector(`[data-testid="server-icon"][data-server-id="${id}"]`)?.click(), srv.id);
        await sleep(1200);
        await p.evaluate((id) => document.querySelector(`[data-testid="voice-channel"][data-channel-id="${id}"]`)?.click(), voice.id);
        check(`${tag} is in the call`, !!await until(async () => (await p.locator(SEL.connected).count()) > 0, 30000));
    }
    await sleep(3000);
    if (SFU) {
        // On an SFU call the badge counts only participants that PUBLISH
        // something (sfuManager.allMediaE2eeStatuses), and neither side has
        // published yet (no microphone here): no badge is the right answer.
        // Encryption is checked once the share is live (below).
        step('SFU: the badge waits for something published (checked with the share live)');
    } else {
        const badges = await until(async () => { const x = [await badge(V), await badge(P)]; return x[0] === 'Encrypted' && x[1] === 'Encrypted' ? x : null; }, 20000)
            ?? [await badge(V), await badge(P)];
        check('both panels say Encrypted', badges[0] === 'Encrypted' && badges[1] === 'Encrypted', badges);
    }

    // ---- Share is offered on the phone, and opens Android's consent ----
    async function phoneShare(answer) {
        // The phone bar keeps its full controls behind the chevron.
        await P.evaluate(() => {
            if (document.querySelector('[data-testid="voice-share-screen"]')?.offsetParent) return;
            document.querySelector('button[aria-label="More voice controls"]')?.click();
        });
        await sleep(600);
        const btn = P.locator(SEL.share).first();
        if (!await btn.count()) return { button: false };
        if (!await realTap(P, SEL.share)) await btn.click();
        return { button: true, ...await consent(answer) };
    }

    await answerSystemDialogs();
    if (WALK) {
        await P.evaluate(() => {
            if (document.querySelector('[data-testid="voice-share-screen"]')?.offsetParent) return;
            document.querySelector('button[aria-label="More voice controls"]')?.click();
        });
        await sleep(800);
        const vp = await P.evaluate(() => ({ w: innerWidth, h: innerHeight, coarse: matchMedia('(pointer: coarse)').matches,
            overflow: document.scrollingElement.scrollWidth - innerWidth }));
        check('walk: a 390 px wide coarse-pointer screen, no sideways overflow', Math.abs(vp.w - 390) <= 2 && vp.coarse && vp.overflow <= 0, vp);
        for (const [name, sel] of [['Share', SEL.share], ['the arrow beside Share', 'button.vp-share-options']]) {
            const g = await geometry(P, sel);
            check(`walk: ${name} is on screen, >= 44 px, and what a tap there hits`, !!g && g.onScreen && g.w >= 44 && g.h >= 44 && g.hits, g);
        }
        save('walk-panel.png', screencap());
        await realTap(P, 'button.vp-share-options');
        const open = await until(() => P.evaluate(() => !!document.querySelector('.stream-modal')), 5000);
        check('walk: a real tap on the arrow opens the stream settings', !!open);
        if (open) {
            await sleep(500);
            const d = await P.evaluate(() => {
                const m = document.querySelector('.stream-modal').getBoundingClientRect();
                return { left: Math.round(m.left), right: Math.round(m.right), vw: innerWidth,
                    overflow: document.scrollingElement.scrollWidth - innerWidth,
                    hint: document.querySelector('.stream-quality-hint')?.textContent ?? '' };
            });
            check('walk: the dialog fits the width', d.left >= 0 && d.right <= d.vw && d.overflow <= 0, d);
            check('walk: it says Android asks, not "pick the window, screen, or tab"', /Android asks/.test(d.hint) && !/tab/.test(d.hint), d.hint);
            await P.evaluate(() => document.querySelector('[data-testid="share-go-live"]')?.scrollIntoView({ block: 'nearest' }));
            await sleep(300);
            for (const [name, sel] of [['Select Screen & Go Live', '[data-testid="share-go-live"]'], ['Cancel', '.stream-modal .stream-btn-secondary']]) {
                const g = await geometry(P, sel);
                check(`walk: the dialog's ${name} is on screen, >= 44 px tall, and what a tap there hits`, !!g && g.onScreen && g.h >= 44 && g.hits, g);
            }
            save('walk-dialog.png', screencap());
            await realTap(P, '.stream-modal .stream-btn-secondary');
            check('walk: a real tap on Cancel closes it', !!await until(() => P.evaluate(() => !document.querySelector('.stream-modal')), 4000));
        }
    }

    const cancelled = await phoneShare('cancel');
    check('the phone offers Share, and a tap opens Android\'s capture consent', cancelled.button && cancelled.shown, cancelled);
    await sleep(2000);
    check('Cancel at the consent starts nothing', (await P.locator(SEL.stop).count()) === 0
        && !(await V.evaluate(async (id) => (await import('/src/components/voiceState.ts')).getAllStreamers().some(s => s.userId === id), uid.P)));

    const started = await phoneShare('start');
    check('"Share entire screen" starts the share', started.shown && started.pressed, started);
    check('the phone is live (its button says Stop Sharing)', !!await until(async () => (await P.locator(SEL.stop).count()) > 0, 20000));
    check('the viewer sees the phone live', !!await until(() => V.evaluate(async (id) => (await import('/src/components/voiceState.ts')).getAllStreamers().some(s => s.userId === id), uid.P), 20000));

    // Watch it: the voice channel's Watch button.
    await V.evaluate((id) => document.querySelector(`[data-testid="voice-channel"][data-channel-id="${id}"]`)?.click(), voice.id);
    await sleep(800);
    await until(() => V.evaluate(() => { const x = document.querySelector('.watch-live-btn'); if (x) { x.click(); return true; } return false; }), 8000);
    await sleep(600);
    await until(() => V.evaluate(() => { const x = [...document.querySelectorAll('button')].find(e => /^watch/i.test((e.textContent || '').trim())); if (x) { x.click(); return true; } return false; }), 4000);

    async function measure(tag) {
        const r1 = await until(async () => { const r = await received(V, uid.P); return r.live && r.frames > 0 && r.grid ? r : null; }, 30000, 1000);
        await sleep(2500);
        const r2 = await received(V, uid.P);
        const png = screencap();
        save(`${tag}-phone.png`, png);
        if (OUT) save(`${tag}-viewer.png`, await V.screenshot());
        if (OUT) { const d = await V.evaluate(() => window.__probeShot || ''); if (d) save(`${tag}-probe.png`, Buffer.from(d.split(',')[1], 'base64')); }
        const like = likeness(r2.grid, await gridOfPng(V, png));
        check(`${tag}: the viewer receives the phone's share`, !!r1?.live && r2.live, { w: r2.w, h: r2.h });
        check(`${tag}: frames keep arriving`, !!r1 && r2.frames > r1.frames, { before: r1?.frames, after: r2.frames });
        check(`${tag}: the picture IS the phone's screen (8x16 likeness >= 0.8)`, like >= 0.8, { likeness: Math.round(like * 1000) / 1000 });
        return r2;
    }
    const first = await measure(`${SFU ? 'sfu' : 'mesh'}-foreground`);
    check('upright phone: an upright picture', first.h > first.w, { w: first.w, h: first.h });
    if (WALK) {
        const g = await geometry(P, SEL.stop);
        check('walk: Stop Sharing is on screen, >= 44 px, and what a tap there hits', !!g && g.onScreen && g.w >= 44 && g.h >= 44 && g.hits, g);
        save('walk-live.png', screencap());
    }
    if (SFU) {
        // The phone publishes; the viewer publishes nothing, so only the
        // viewer's badge has anything to count (the phone's has none).
        const vb = await until(async () => (await badge(V)) === 'Encrypted' ? 'Encrypted' : null, 15000) ?? await badge(V);
        check("the viewer's panel says Encrypted with the phone's share live", vb === 'Encrypted', { viewer: vb, phone: await badge(P) });
        const st = await V.evaluate(async (id) => (await import('/src/api/rtc/sfuManager.ts')).sfuManager.allMediaE2eeStatuses().find(s => s.userId === id) ?? null, uid.P);
        check("LiveKit E2EE: the viewer opens the phone's publications encrypted", !!st && st.encrypted === true, st);
    } else {
        check('still Encrypted with the share live', (await badge(V)) === 'Encrypted' && (await badge(P)) === 'Encrypted');
    }
    if (SFU && LK.api) {
        const t = await until(async () => { const x = await lkTracks(`sfu_${voice.id}`); return x && Object.values(x).some(a => a.includes('SCREEN_SHARE') || a.includes(3)) ? x : null; }, 10000)
            ?? await lkTracks(`sfu_${voice.id}`);
        check('LiveKit sees the phone publish a screen share (the SFU path, not mesh)', !!t && Object.values(t).some(a => a.includes('SCREEN_SHARE') || a.includes(3)), t);
    }

    // ---- the app in the background keeps sharing ----
    sh('input keyevent KEYCODE_HOME');
    await sleep(3000);
    await measure(`${SFU ? 'sfu' : 'mesh'}-background`);

    // ---- the phone turned sideways, and back: over another app (Settings), which
    // turns; turned in Púca it shows its own stream, a hall of mirrors that never
    // holds still long enough to compare ----
    sh('am start -W -a android.settings.SETTINGS');
    await sleep(1500);
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 1');
    rotated = true;
    await sleep(4000);
    const side = await until(async () => { const r = await received(V, uid.P); return r.live && r.w > r.h ? r : null; }, 20000, 1000)
        ?? await received(V, uid.P);
    check('turned sideways: the viewer gets a sideways picture', side.w > side.h, { w: side.w, h: side.h });
    const sideLike = likeness((await received(V, uid.P)).grid, await gridOfPng(V, screencap()));
    check('turned sideways: still the phone\'s screen (likeness >= 0.8)', sideLike >= 0.8, { likeness: Math.round(sideLike * 1000) / 1000 });
    if (OUT) save(`${SFU ? 'sfu' : 'mesh'}-sideways-viewer.png`, await V.screenshot());
    sh('settings put system user_rotation 0');
    await sleep(4000);
    const back = await until(async () => { const r = await received(V, uid.P); return r.live && r.h > r.w ? r : null; }, 20000, 1000)
        ?? await received(V, uid.P);
    check('turned back upright: an upright picture again', back.h > back.w, { w: back.w, h: back.h });

    // ---- "Stop sharing" in the notification ----
    sh('cmd statusbar expand-notifications');
    await sleep(1500);
    // A quiet notification can sit collapsed under others, its actions
    // hidden: open it out first.
    for (let i = 0; i < 3 && !findNode(/^Stop sharing$/i); i++) {
        const nodes = uiNodes();
        const title = nodes.find(n => n.text === 'Sharing your screen');
        // Its own expand button (the nearest below the title), else the
        // app's group row.
        const expand = title && nodes.filter(n => n.id === 'android:id/expand_button' && n.y >= title.y - 120)
            .sort((a, b) => a.y - b.y)[0];
        const group = nodes.find(n => n.id === 'android:id/app_name_text' && /P.ca/.test(n.text));
        if (expand) tapAt(expand); else if (group) tapAt(group); else break;
        await sleep(1000);
    }
    const stopTapped = await tapText(/^Stop sharing$/i, 6000);
    if (!stopTapped && OUT) save('shade.txt', Buffer.from(uiNodes().map(n => `${n.text}|${n.desc}|${n.id}`).join('\n')));
    sh('cmd statusbar collapse');
    check('the notification\'s Stop sharing is there and pressed', stopTapped);
    check('the viewer sees the share end', !!await until(() => V.evaluate(async (id) => !(await import('/src/components/voiceState.ts')).getAllStreamers().some(s => s.userId === id), uid.P), 15000));
    sh(`am start -W -n ${PKG}/.MainActivity`);
    await sleep(1500);
    check('the phone\'s panel says it is not sharing any more', !!await until(async () => (await P.locator(SEL.stop).count()) === 0, 8000));
    check('and the phone still in the call', (await P.locator(SEL.connected).count()) > 0);

    // ---- again, stopped by the app's own button ----
    const again = await phoneShare('start');
    check('a second share starts (a fresh consent each time)', again.shown && again.pressed && !!await until(async () => (await P.locator(SEL.stop).count()) > 0, 20000), again);
    check('the viewer sees it live again', !!await until(() => V.evaluate(async (id) => (await import('/src/components/voiceState.ts')).getAllStreamers().some(s => s.userId === id), uid.P), 20000));
    if (!await realTap(P, SEL.stop)) await P.locator(SEL.stop).first().click();
    check('Stop Sharing in the app ends it for the viewer', !!await until(() => V.evaluate(async (id) => !(await import('/src/components/voiceState.ts')).getAllStreamers().some(s => s.userId === id), uid.P), 15000));
    check('and the phone\'s capture is gone (no sharing notification)', !!await until(() => !/Sharing your screen/.test(sh('dumpsys notification --noredact')), 8000));
} catch (e) {
    console.log('FAIL  the run threw:', e?.stack || e);
    failed++;
} finally {
    for (const b of browsers) await b.close().catch(() => {});
    if (rotated) { try { sh('settings put system user_rotation 0'); sh('settings put system accelerometer_rotation 1'); } catch { /* emulator gone */ } }
    if (resized) { try { sh('wm size reset'); } catch { /* emulator gone */ } }
    if (forwarded) { try { adb('forward', '--remove', `tcp:${CDP_PORT}`); } catch { /* gone */ } }
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
