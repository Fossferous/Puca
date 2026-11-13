// LIVE: switching cameras in a call, in the REAL app on the web, a phone and a
// desktop in one encrypted call (mesh; SFU=1 through a loopback LiveKit).
// The owner's report: "clicking 'flip' on camera just mirrors the image, there
// should be an option to use rear cameras too".
//
// Two headless Edge pages (--mute-audio, fake microphone) on a vite dev server
// of this tree against a THROWAWAY backend:
//   - a PHONE: 390x844, touch (coarse pointer), every press a real tap; its
//     cameras are an iPhone's as Safari lists them ("Front Camera", "Back
//     Camera", "Back Ultra Wide Camera"; no getCapabilities, so the names
//     and the open track's own facingMode are all there is), each a canvas
//     of its own colour with a white block LEFT of centre, and like a phone it
//     will not open a second camera while one is open (NotReadableError);
//   - a DESKTOP: 1280x800, a real mouse and real keys, two webcams that face
//     no known way ("Integrated Webcam (0bda:58f4)", "Logitech BRIO
//     (046d:085e)"). It is also the phone's viewer, and the phone its.
// Stand-in cameras are the one thing faked: the switch, the senders, the
// encryption, the call and the UI are the app's.
//
// What it proves, each measured:
//   - the phone starts on the front camera, its self-view mirrored (the white
//     block drawn RIGHT of centre in a screenshot), and the desktop's tile of
//     it is red;
//   - Flip (a real tap on the self-view's own button) puts the plain Back
//     Camera on, asked for EXACTLY: the self-view is not mirrored (block on
//     the left), the desktop's tile turns green, frames keep coming, and the
//     call is still Encrypted on both sides (SFU=1: the desktop opens the
//     phone's camera encrypted, and LiveKit still has ONE camera publication
//     from the phone: the same one, swapped, not a new one);
//   - a real tap on the self-view opens the camera menu: all three cameras by
//     name, the one on ticked; the ultra wide from it turns the tile blue;
//     Flip from there goes to the front (red, mirrored again);
//   - the choice is remembered: camera off and on opens the camera last used;
//   - full screen: its Flip and its Turn Off Camera whole, the picture
//     mirrored only for the front camera;
//   - the desktop: Flip goes to the other webcam (mirrored both: a webcam
//     faces you), the menu opens from the arrow beside the camera button by a
//     real click and by the keyboard (Enter on the arrow puts the focus on the
//     first camera, arrows walk, Enter switches, Escape closes), each row on
//     screen and what elementFromPoint hits;
//   - Settings > Voice & Video lists the cameras, and a choice there is the
//     camera the next call opens;
//   - every camera control >= 44 px on the phone, on screen, what a tap there
//     hits; every word in the camera menu 4.5:1 and every icon-only control
//     3:1 on all eight themes with and without high contrast (the controls
//     over the picture measured over a WHITE picture, the worst there is).
// NEGATIVE CONTROL: PHONE_APP= a bundle built before this change (Flip asked
// for the front camera again): the flip checks must FAIL.
//
// Start the dev server AFTER the last edit to a module this walk imports by its
// path (components/voiceState.ts, api/rtc/sfuManager.ts): an edit under a
// running server gives the app's import an HMR timestamp, and the walk's own
// import is then a second, empty copy (every tile reads as missing).
//
// Usage: API=http://127.0.0.1:3010 APP=http://127.0.0.1:5196 [PHONE_APP=<old build>] [SFU=1 LK_API= LK_KEY= LK_SECRET=] [OUT=dir] node e2e/camera-switch-live.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.API || 'http://127.0.0.1:3010';
const APP = process.env.APP || 'http://127.0.0.1:5196';
const PHONE_APP = process.env.PHONE_APP || APP;
const SFU = process.env.SFU === '1';
const OUT = process.env.OUT || '';
const CHANNEL = process.env.CHANNEL || 'msedge';
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
const LK = { api: process.env.LK_API, key: process.env.LK_KEY, secret: process.env.LK_SECRET };

let failed = 0;
const step = (what) => console.log(`--    ${what}`);
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
    if (!ok) failed++;
    return ok;
};
async function until(fn, ms = 15000, stepMs = 300) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(stepMs); }
    return last;
}
const save = (name, bytes) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), bytes); } };

// ---- the stand-in cameras ------------------------------------------------------

const PHONE_CAMS = [
    { deviceId: 'cam-front', label: 'Front Camera', facing: 'user', color: '#c81e1e', name: 'red' },
    { deviceId: 'cam-back', label: 'Back Camera', facing: 'environment', color: '#1ea03c', name: 'green' },
    { deviceId: 'cam-ultra', label: 'Back Ultra Wide Camera', facing: 'environment', color: '#1e46d2', name: 'blue' },
];
const DESK_CAMS = [
    { deviceId: 'cam-int', label: 'Integrated Webcam (0bda:58f4)', facing: null, color: '#d27814', name: 'orange' },
    { deviceId: 'cam-brio', label: 'Logitech BRIO (046d:085e)', facing: null, color: '#8c28be', name: 'purple' },
];

/** In the page, before anything: the cameras of `cfg`, each a canvas. */
const CAMERAS = (cfg) => {
    const md = navigator.mediaDevices;
    const realGUM = md.getUserMedia.bind(md);
    const realEnum = md.enumerateDevices.bind(md);
    const state = { asked: [], opens: [], live: new Set(), refused: 0 };
    window.__cams = state;
    const open = (cam) => {
        const c = document.createElement('canvas'); c.width = 640; c.height = 480;
        const g = c.getContext('2d');
        let n = 0;
        const draw = () => {
            g.fillStyle = cam.color; g.fillRect(0, 0, 640, 480);
            // A white block LEFT of centre: where a screenshot finds it says
            // whether the picture is drawn mirrored.
            g.fillStyle = '#ffffff'; g.fillRect(180, 120, 110, 240);
            g.fillStyle = (n++ % 2) ? '#000000' : '#202020'; g.fillRect(560, 400, 40, 40);
        };
        draw();
        const iv = setInterval(draw, 66);
        const s = c.captureStream(15);
        const t = s.getVideoTracks()[0];
        Object.defineProperty(t, 'label', { value: cam.label });
        const settings = t.getSettings.bind(t);
        t.getSettings = () => ({ ...settings(), deviceId: cam.deviceId, ...(cam.facing ? { facingMode: cam.facing } : {}) });
        const stop = t.stop.bind(t);
        t.stop = () => { clearInterval(iv); state.live.delete(t); stop(); };
        state.live.add(t);
        state.opens.push(cam.deviceId);
        return s;
    };
    md.getUserMedia = async (c) => {
        if (!c || !c.video) return realGUM(c);
        const v = typeof c.video === 'object' ? c.video : {};
        state.asked.push(JSON.stringify({ deviceId: v.deviceId, facingMode: v.facingMode }));
        // Every camera busy (another app has them all): a switch opens neither
        // the next camera nor, put back, the one that was on.
        if (state.allBusy) throw new DOMException('Could not start video source', 'NotReadableError');
        if (cfg.onlyOne && [...state.live].some(t => t.readyState === 'live')) {
            state.refused++;
            throw new DOMException('Could not start video source', 'NotReadableError');
        }
        const exact = v.deviceId && v.deviceId.exact;
        const fm = v.facingMode;
        const want = fm && (fm.exact || fm.ideal || (typeof fm === 'string' ? fm : null));
        const cam = exact ? cfg.cams.find(x => x.deviceId === exact)
            : fm && fm.exact ? cfg.cams.find(x => x.facing === fm.exact)
                : (cfg.cams.find(x => x.facing === want) || cfg.cams[0]);
        if (!cam) throw new DOMException('no such camera', 'OverconstrainedError');
        const vs = open(cam);
        if (c.audio) (await realGUM({ audio: c.audio })).getAudioTracks().forEach(x => vs.addTrack(x));
        return vs;
    };
    // A camera plugged in while the page is open, and a list that is slow to
    // come (so the camera menu draws, and measures itself, before it).
    state.plug = (cam) => { cfg.cams.push(cam); };
    state.unplug = (id) => { const i = cfg.cams.findIndex(x => x.deviceId === id); if (i >= 0) cfg.cams.splice(i, 1); };
    md.enumerateDevices = async () => {
        if (state.listDelayMs) await new Promise(r => setTimeout(r, state.listDelayMs));
        const real = (await realEnum()).filter(d => d.kind !== 'videoinput');
        return [...real, ...cfg.cams.map(cam => {
            const d = { kind: 'videoinput', deviceId: cam.deviceId, groupId: '', label: cam.label };
            if (cfg.capabilities) d.getCapabilities = () => (cam.facing ? { facingMode: [cam.facing] } : {});
            d.toJSON = () => ({ kind: d.kind, deviceId: d.deviceId, label: d.label });
            return d;
        })];
    };
};

const QUIET = () => {
    try {
        const k = 'sovereign_settings';
        const s = JSON.parse(localStorage.getItem(k) || '{}');
        Object.assign(s, { joinWithoutMic: true, soundsEnabled: false, joinLeaveSound: false, voiceTTS: false, streamSound: false });
        localStorage.setItem(k, JSON.stringify(s));
    } catch { /* storage refused */ }
};
const PCS = () => {
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

/** The element's box, whether it is on screen, and whether what is at its
 *  centre is it (document.elementFromPoint). */
const geometry = (page, selector, text = null) => page.evaluate(({ sel, text }) => {
    const re = text ? new RegExp(text) : null;
    const e = [...document.querySelectorAll(sel)].find(x => x.getClientRects().length > 0 && (!re || re.test((x.textContent || '').trim())));
    if (!e) return null;
    const b = e.getBoundingClientRect();
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        cx: b.x + b.width / 2, cy: b.y + b.height / 2,
        onScreen: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
        hits: !!hit && (hit === e || e.contains(hit)) };
}, { sel: selector, text });
/** A real tap (touch) or a real click (mouse) at the element's centre. */
async function press(page, selector, text = null) {
    const g = await geometry(page, selector, text);
    if (!g) return null;
    if (page.__touch) await page.touchscreen.tap(g.cx, g.cy);
    else await page.mouse.click(g.cx, g.cy);
    return g;
}
const target44 = (g) => !!g && g.onScreen && g.w >= 44 && g.h >= 44 && g.hits;

/** This page's own camera as its page has it: the live track's settings and
 *  label, whether each <video> showing it is drawn mirrored, the self-view's
 *  frames, and where a screenshot of the self-view finds the white block. */
async function ownCamera(page) {
    const r = await page.evaluate(() => {
        const vids = [...document.querySelectorAll('.camera-preview-mini video, .camera-fullscreen video')].filter(v => v.getClientRects().length > 0);
        const self = vids[0] ?? null;
        const track = self?.srcObject?.getVideoTracks?.().find(t => t.readyState === 'live') ?? null;
        if (!track) return { live: false };
        const s = track.getSettings();
        const shows = [...document.querySelectorAll('video')].filter(v => v.getClientRects().length > 0 && v.srcObject?.getVideoTracks?.().includes(track));
        const mirrored = shows.map(v => { const m = getComputedStyle(v).transform; return { cls: v.className || v.parentElement?.className || '', mirrored: m && m !== 'none' ? Number(m.replace(/^matrix\(/, '').split(',')[0]) < 0 : false }; });
        const b = self.getBoundingClientRect();
        return { live: true, label: track.label, deviceId: s.deviceId ?? null, facingMode: s.facingMode ?? null, mirrored,
            frames: self.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, w: self.videoWidth,
            clip: { x: b.x, y: b.y, width: b.width, height: b.height } };
    });
    if (!r.live) return r;
    // Where the white block is drawn: left of centre unmirrored, right mirrored.
    const png = await page.screenshot({ clip: r.clip });
    r.block = await page.evaluate(async (b64) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let sx = 0, n = 0;
        for (let y = Math.floor(c.height * 0.3); y < c.height * 0.7; y++) for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) { sx += x; n++; }
        }
        return n > 20 ? (sx / n < c.width / 2 ? 'left' : 'right') : 'none';
    }, png.toString('base64'));
    r.selfShot = png;
    return r;
}
const unmirrored = (c) => c.live && c.block === 'left' && c.mirrored.length > 0 && c.mirrored.every(m => !m.mirrored);
const mirroredView = (c) => c.live && c.block === 'right' && c.mirrored.length > 0 && c.mirrored.every(m => m.mirrored);

/** What the desktop's tile of `uid`'s camera shows: its colour (by the
 *  stand-in palette), its frame count and the newest camera track's. */
const tileOf = (V, uid, probeOk = false) => V.evaluate(async ({ uid, probeOk }) => {
    const m = await import('/src/components/voiceState.ts');
    const stream = m.globalCameraStreams.get(uid);
    if (!stream) return { live: false };
    let el = [...document.querySelectorAll('video')].find(v => v.srcObject === stream && v.getClientRects().length > 0);
    let probe = false;
    if (!el && probeOk) {
        // No tile on this screen (a phone on its channel list): what it
        // receives, the newest camera track, in an element of our own.
        const tracks = stream.getVideoTracks().filter(t => t.readyState === 'live');
        const t = tracks[tracks.length - 1];
        window.__tileProbe ??= new Map();
        el = window.__tileProbe.get(t);
        if (!el && t) {
            el = document.createElement('video'); el.muted = true; el.playsInline = true; el.srcObject = new MediaStream([t]);
            window.__tileProbe.set(t, el);
            await el.play().catch(() => {});
            await new Promise(r => setTimeout(r, 600));
        }
        probe = true;
    }
    if (!el || el.videoWidth === 0) return { live: true, tile: false };
    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(el, 0, 0, 64, 48);
    // The block is white: the picture's colour is the edges'.
    const d = g.getImageData(0, 0, 8, 48).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    r /= n; gg /= n; b /= n;
    const palette = { red: [200, 30, 30], green: [30, 160, 60], blue: [30, 70, 210], orange: [210, 120, 20], purple: [140, 40, 190] };
    let best = null, bd = 1e9;
    for (const [k, [pr, pg, pb]] of Object.entries(palette)) { const dd = Math.hypot(r - pr, gg - pg, b - pb); if (dd < bd) { bd = dd; best = k; } }
    return { live: true, tile: true, probe, color: bd < 70 ? best : `unclear(${Math.round(r)},${Math.round(gg)},${Math.round(b)})`, frames: el.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, tracks: stream.getVideoTracks().length };
}, { uid, probeOk });
async function tileShows(V, uid, color, tag, { probe = false } = {}) {
    const a = await until(async () => { const t = await tileOf(V, uid, probe); return t.tile && t.color === color ? t : null; }, 15000, 500) ?? await tileOf(V, uid, probe);
    await sleep(1500);
    const b = await tileOf(V, uid, probe);
    const what = probe ? ' receives' : "'s tile shows";
    check(`${tag}: the other side${what} the ${color} camera, frames rising`, a.tile && a.color === color && b.color === color && b.frames > a.frames, { before: a, after: b });
}

/** Encrypted end to end, as each side says. */
async function encrypted(V, P, uidP, tag) {
    if (SFU) {
        const st = await until(() => V.evaluate(async (id) => (await import('/src/api/rtc/sfuManager.ts')).sfuManager.allMediaE2eeStatuses().find(s => s.userId === id && s.encrypted === true) ?? null, uidP), 15000)
            ?? await V.evaluate(async (id) => (await import('/src/api/rtc/sfuManager.ts')).sfuManager.allMediaE2eeStatuses().find(s => s.userId === id) ?? null, uidP);
        check(`${tag}: the desktop opens the phone's camera encrypted (LiveKit E2EE)`, !!st && st.encrypted === true, st);
    } else {
        const bs = await until(async () => { const x = [await badge(V), await badge(P)]; return x[0] === 'Encrypted' && x[1] === 'Encrypted' ? x : null; }, 15000) ?? [await badge(V), await badge(P)];
        check(`${tag}: both panels say Encrypted`, bs[0] === 'Encrypted' && bs[1] === 'Encrypted', bs);
    }
}

/** What LiveKit says the phone publishes (SFU=1 with LK_*), by source. */
async function lkTracks(room) {
    if (!LK.api || !LK.key || !LK.secret) return null;
    const { createHmac } = await import('node:crypto');
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: LK.key, sub: 'camera-switch-check', nbf: now - 5, exp: now + 300, video: { roomAdmin: true, roomList: true, room } })}`;
    const jwt = `${body}.${createHmac('sha256', LK.secret).update(body).digest('base64url')}`;
    const r = await fetch(`${LK.api}/twirp/livekit.RoomService/ListParticipants`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ room }),
    });
    if (!r.ok) return { error: r.status };
    return Object.fromEntries(((await r.json()).participants || []).map(x => [x.identity, (x.tracks || []).filter(t => t.source === 'CAMERA' || t.source === 1).map(t => t.sid)]));
}

/**
 * The background `selector` is drawn with while HOVERED, as a phone leaves a
 * button after a tap: under touch emulation (hover: none) a tap keeps no
 * hover, but a mouse resting on it does, and mobile.css's touch rule
 * (button:hover { background-color: inherit }) then applies as on a phone.
 * Answers its colour and alpha.
 */
async function hoveredBackground(page, selector) {
    const g = await geometry(page, selector);
    if (!g) return null;
    await page.mouse.move(g.cx, g.cy);
    await sleep(200);
    const r = await page.evaluate((sel) => ({
        bg: getComputedStyle(document.querySelector(sel)).backgroundColor,
        hoverNone: matchMedia('(hover: none)').matches,
    }), selector);
    await page.mouse.move(2, 2);
    const m = r.bg.match(/[\d.]+/g) || [];
    return { ...r, alpha: r.bg === 'transparent' ? 0 : m.length >= 4 ? Number(m[3]) : 1 };
}

/** Press Flip. Before this change it sat behind a tap on the self-view. */
async function flip(page) {
    if (await geometry(page, '[data-testid="camera-flip"]')) return press(page, '[data-testid="camera-flip"]');
    for (let i = 0; i < 3; i++) {
        await press(page, '.camera-preview-mini');
        await sleep(500);
        if (await geometry(page, '.pip-option-btn', '^Flip')) return press(page, '.pip-option-btn', '^Flip');
        if (await geometry(page, '.camera-fullscreen-controls button', 'Flip')) return press(page, '.camera-fullscreen-controls button', 'Flip');
    }
    return null;
}
async function expandPhonePanel(P) {
    if (await geometry(P, '.vp-camera')) return;
    await press(P, 'button[aria-label="More voice controls"]');
    await sleep(500);
}
async function waitOwn(page, pred, ms = 12000) {
    return await until(async () => { const c = await ownCamera(page); return pred(c) ? c : null; }, ms, 400) ?? await ownCamera(page);
}

const browsers = [];
try {
    const b = await chromium.launch({ channel: CHANNEL, headless: true, args: [
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
        '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
    browsers.push(b);
    const dctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    await dctx.addInitScript(CAMERAS, { cams: DESK_CAMS, onlyOne: false, capabilities: true });
    await dctx.addInitScript(QUIET); await dctx.addInitScript(PCS);
    const pctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    await pctx.addInitScript(CAMERAS, { cams: PHONE_CAMS, onlyOne: true, capabilities: false });
    await pctx.addInitScript(QUIET); await pctx.addInitScript(PCS);
    const D = await dctx.newPage(); const P = await pctx.newPage();
    P.__touch = true;
    for (const [tag, p] of [['desktop', D], ['phone', P]]) {
        p.on('pageerror', (e) => console.log(`  [${tag} pageerror] ${e.message.slice(0, 200)}`));
        p.on('console', (m) => { const t = m.text(); if (/Camera switched|Failed to switch|camera could not/i.test(t)) console.log(`  [${tag}] ${t.slice(0, 200)}`); });
    }
    await D.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await P.goto(PHONE_APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });

    step('signing up both');
    await signUp(D, `camd_${stamp}`);
    await signUp(P, `camp_${stamp}`);
    const uid = { D: await uidOf(D), P: await uidOf(P) };
    const srv = await call(D, '/src/api/servers.ts', 'createServer', ['CS ' + stamp.slice(-4)]);
    const voice = await call(D, '/src/api/servers.ts', 'createChannel', [srv.id, 'Camera room', 1]);
    if (SFU) await call(D, '/src/api/servers.ts', 'updateChannel', [voice.id, { sfu_mode: true }]);
    const inv = await call(D, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);
    const joined = await P.evaluate(async ({ api, code }) => (await fetch(`${api}/invites/${code}/join`, { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } })).status, { api: API, code: inv.code });
    check(`fixture: a ${SFU ? 'SFU' : 'mesh'} voice channel, both members`, joined < 300 && Number.isInteger(uid.D) && Number.isInteger(uid.P), { joined, uid });
    for (const p of [D, P]) { await p.reload({ waitUntil: 'domcontentloaded', timeout: 180000 }); await sleep(2500); await dismiss(p); }
    for (const [tag, p] of [['desktop', D], ['phone', P]]) {
        await p.evaluate((id) => document.querySelector(`[data-testid="server-icon"][data-server-id="${id}"]`)?.click(), srv.id);
        await sleep(1000);
        await p.evaluate((id) => document.querySelector(`[data-testid="voice-channel"][data-channel-id="${id}"]`)?.click(), voice.id);
        check(`${tag} is in the call`, !!await until(async () => (await p.locator('[data-testid="voice-connected"]').count()) > 0, 30000));
    }
    await sleep(2500);
    // The desktop looks at the call (its stage, with the phone's tile).
    await D.evaluate((id) => document.querySelector(`[data-testid="voice-channel"][data-channel-id="${id}"]`)?.click(), voice.id);
    check('the desktop has the call on screen (its stage)', !!await until(() => D.evaluate(() => !!document.querySelector('.voice-stage-grid')), 8000));

    // ---- the phone: front camera on ----
    step('phone: camera on');
    await expandPhonePanel(P);
    const camBtn = await geometry(P, '.vp-camera');
    check('phone: the camera button is >= 44 px, on screen, and what a tap there hits', target44(camBtn), camBtn);
    await press(P, '.vp-camera');
    const front = await waitOwn(P, c => c.live && c.frames > 0 && c.block !== 'none');
    save('phone-front-self.png', front.selfShot ?? Buffer.alloc(0));
    check('phone: the camera starts on the FRONT camera', front.live && front.facingMode === 'user' && front.label === 'Front Camera', { label: front.label, facingMode: front.facingMode });
    check('phone: the front camera\'s self-view is mirrored (the block drawn right of centre)', mirroredView(front), { block: front.block, mirrored: front.mirrored });
    await tileShows(D, uid.P, 'red', 'front');
    await encrypted(D, P, uid.P, 'front');
    const lk0 = SFU ? await until(async () => { const t = await lkTracks(`sfu_${voice.id}`); return t && t[String(uid.P)]?.length ? t : null; }, 10000) : null;

    // ---- Flip: the rear camera ----
    step('phone: Flip');
    const flipBtn = await geometry(P, '[data-testid="camera-flip"]');
    check('phone: Flip is on the self-view, >= 44 px, on screen, and what a tap there hits', target44(flipBtn), flipBtn);
    await P.evaluate(() => { window.__cams.asked.length = 0; });
    await flip(P);
    const rear = await waitOwn(P, c => c.live && c.label !== 'Front Camera' && c.block !== 'none');
    save('phone-rear-self.png', rear.selfShot ?? Buffer.alloc(0));
    const asked = await P.evaluate(() => window.__cams.asked.slice());
    check('phone: Flip puts the plain Back Camera on (not the ultra wide)', rear.live && rear.label === 'Back Camera' && rear.facingMode === 'environment', { label: rear.label, facingMode: rear.facingMode });
    check('phone: and asked for it EXACTLY', asked.length > 0 && asked.every(a => /"exact"/.test(a)), asked);
    check('phone: the phone was never asked for two cameras at once', (await P.evaluate(() => window.__cams.refused)) === 0);
    check('phone: the rear camera\'s self-view is NOT mirrored (the block left of centre)', unmirrored(rear), { block: rear.block, mirrored: rear.mirrored });
    await tileShows(D, uid.P, 'green', 'rear');
    await encrypted(D, P, uid.P, 'rear');
    if (SFU && lk0) {
        const lk1 = await lkTracks(`sfu_${voice.id}`);
        check('SFU: LiveKit has ONE camera publication from the phone, the same one (swapped, not republished)',
            lk1?.[String(uid.P)]?.length === 1 && lk1[String(uid.P)][0] === lk0[String(uid.P)][0], { before: lk0[String(uid.P)], after: lk1?.[String(uid.P)] });
    }

    // ---- the menu, from a tap on the self-view ----
    step('phone: the camera menu');
    await press(P, '[data-testid="camera-self-view-menu"]');
    const items = await until(() => P.evaluate(() => {
        const els = [...document.querySelectorAll('[data-testid="camera-option"]')].filter(e => e.getClientRects().length > 0);
        return els.length ? els.map(e => ({ label: (e.textContent || '').trim(), id: e.getAttribute('data-value'), checked: e.getAttribute('aria-checked'), role: e.getAttribute('role') })) : null;
    }), 5000) ?? [];
    check('phone: a tap on the self-view opens the menu, every camera by name', items.map(i => i.label).join('|') === 'Front Camera|Back Camera|Back Ultra Wide Camera', items);
    const pipHover = await hoveredBackground(P, '[data-testid="camera-self-view-menu"]');
    check('phone: the self-view stays a picture while its button is hovered after the tap (no box over the camera)', !!pipHover && pipHover.hoverNone && pipHover.alpha === 0, pipHover);
    check('phone: the camera on is the one ticked (menuitemradio, aria-checked)', items.filter(i => i.checked === 'true').map(i => i.id).join() === 'cam-back' && items.every(i => i.role === 'menuitemradio'), items);
    await sleep(400); // past the menu's scale-in
    const rows = [];
    for (const it of items) rows.push(await geometry(P, `[data-testid="camera-option"][data-value="${it.id}"]`));
    for (const t of ['^Switch to the front camera$', '^Full screen$', '^Turn off camera$']) rows.push(await geometry(P, '.camera-menu .context-menu-item', t));
    check('phone: every row of the menu is >= 44 px tall, on screen, and what a tap there hits', rows.length === 6 && rows.every(g => !!g && g.onScreen && g.h >= 44 && g.hits), rows);
    if (OUT) save('phone-menu.png', await P.screenshot());
    await press(P, '[data-testid="camera-option"][data-value="cam-ultra"]');
    const ultra = await waitOwn(P, c => c.live && c.label === 'Back Ultra Wide Camera');
    check('phone: the ultra wide from the menu is on, not mirrored', ultra.label === 'Back Ultra Wide Camera' && unmirrored(ultra), { label: ultra.label, block: ultra.block });
    await tileShows(D, uid.P, 'blue', 'ultra wide');
    await flip(P);
    const front2 = await waitOwn(P, c => c.live && c.label === 'Front Camera' && c.block !== 'none');
    check('phone: Flip from the ultra wide goes to the front camera, mirrored again', front2.label === 'Front Camera' && mirroredView(front2), { label: front2.label, block: front2.block });
    await tileShows(D, uid.P, 'red', 'front again');
    await encrypted(D, P, uid.P, 'front again');

    // ---- remembered ----
    step('phone: camera off and on, on the back camera');
    await flip(P);
    await waitOwn(P, c => c.label === 'Back Camera');
    await expandPhonePanel(P);
    await press(P, '.vp-camera');
    await until(async () => !(await ownCamera(P)).live, 8000);
    await sleep(800);
    await press(P, '.vp-camera');
    const again = await waitOwn(P, c => c.live && c.block !== 'none');
    check('phone: the camera turned on again is the one last used (Back Camera), not mirrored', again.label === 'Back Camera' && unmirrored(again), { label: again.label, block: again.block });
    const stored = await P.evaluate(() => JSON.parse(localStorage.getItem('sovereign_settings') || '{}').camera ?? null);
    check('phone: kept in Settings as the camera to open', stored?.deviceId === 'cam-back' && stored?.facing === 'environment', stored);

    // ---- full screen ----
    step('phone: full screen');
    await press(P, '[data-testid="camera-self-view-menu"]');
    await until(() => geometry(P, '.camera-menu .context-menu-item', '^Full screen$'), 4000);
    await press(P, '.camera-menu .context-menu-item', '^Full screen$');
    await until(() => P.evaluate(() => !!document.querySelector('.camera-fullscreen') && !document.querySelector('.camera-menu')), 5000);
    await sleep(600);
    const fsBack = await waitOwn(P, c => c.live && c.block !== 'none');
    check('phone: full screen on the back camera is not mirrored', unmirrored(fsBack), { block: fsBack.block, mirrored: fsBack.mirrored });
    const fsButtons = [];
    for (const sel of ['.camera-fullscreen-controls [data-testid="camera-flip"]', '.camera-fullscreen-controls [data-testid="camera-choose"]', '.camera-fullscreen-controls .exit-btn', '.camera-fullscreen-controls .cam-off-btn']) fsButtons.push(await geometry(P, sel));
    check('phone: full screen\'s Flip, Cameras, Exit and Turn Off Camera are whole buttons, >= 44 px, on screen, what a tap hits', fsButtons.every(g => target44(g) && g.w > g.h), fsButtons);
    const fsHover = [];
    for (const sel of ['.camera-fullscreen-controls [data-testid="camera-flip"]', '.camera-fullscreen-controls [data-testid="camera-choose"]', '.camera-fullscreen-controls .exit-btn', '.camera-fullscreen-controls .cam-off-btn']) fsHover.push(await hoveredBackground(P, sel));
    check("phone: full screen's buttons keep their dark backing when hovered after a tap", fsHover.every(h => !!h && h.hoverNone && h.alpha >= 0.6), fsHover);
    const fsFlipNamed = await P.locator('.camera-fullscreen-controls').getByRole('button', { name: /^Flip Camera$/ }).count();
    check("phone: full screen's Flip is named by the words on it, Flip Camera (what voice control says to press)", fsFlipNamed === 1, { fsFlipNamed });
    if (OUT) save('phone-fullscreen.png', await P.screenshot());
    await press(P, '.camera-fullscreen-controls [data-testid="camera-flip"]');
    const fsFront = await waitOwn(P, c => c.live && c.label === 'Front Camera' && c.block !== 'none');
    check('phone: full screen\'s Flip puts the front camera on, mirrored', fsFront.label === 'Front Camera' && mirroredView(fsFront), { label: fsFront.label, block: fsFront.block });
    await press(P, '.camera-fullscreen-controls .exit-btn');
    await sleep(500);

    // ---- the desktop: two webcams, a mouse and keys ----
    step('desktop: camera on, Flip, the menu by mouse and by keys');
    await D.locator('.vp-camera').click();
    const d1 = await waitOwn(D, c => c.live && c.block !== 'none');
    check('desktop: the first webcam, mirrored (a webcam faces you)', d1.label === 'Integrated Webcam (0bda:58f4)' && mirroredView(d1), { label: d1.label, block: d1.block });
    await tileShows(P, uid.D, 'orange', 'desktop webcam', { probe: true });
    await flip(D);
    const d2 = await waitOwn(D, c => c.live && c.label !== d1.label && c.block !== 'none');
    check('desktop: Flip goes to the other webcam, still mirrored', d2.label === 'Logitech BRIO (046d:085e)' && mirroredView(d2), { label: d2.label, block: d2.block });
    await tileShows(P, uid.D, 'purple', 'desktop BRIO', { probe: true });
    const arrow = await geometry(D, '[data-testid="camera-options"]');
    check('desktop: the arrow beside the camera button is on screen and what a click there hits', !!arrow && arrow.onScreen && arrow.hits, arrow);
    await press(D, '[data-testid="camera-options"]');
    const dItems = await until(() => D.evaluate(() => [...document.querySelectorAll('[data-testid="camera-option"]')].filter(e => e.getClientRects().length > 0).map(e => (e.textContent || '').trim())), 4000) ?? [];
    check('desktop: the menu names the webcams without their USB ids', dItems.join('|') === 'Integrated Webcam|Logitech BRIO', dItems);
    const dRows = [];
    for (const e of await D.locator('.camera-menu .context-menu-item').all()) dRows.push(await e.evaluate((el) => { const b = el.getBoundingClientRect(); const h = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return { t: el.textContent.trim(), on: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight, hits: !!h && el.contains(h) }; }));
    check('desktop: every row of the menu is inside the window and what a click there hits', dRows.length >= 4 && dRows.every(r => r.on && r.hits), dRows);
    await D.keyboard.press('Escape');
    check('desktop: Escape closes it', !!await until(() => D.evaluate(() => !document.querySelector('.camera-menu')), 2000));
    await D.locator('[data-testid="camera-options"]').focus();
    await D.keyboard.press('Enter');
    const focused = await until(() => D.evaluate(() => document.activeElement?.closest('.camera-menu') ? (document.activeElement.textContent || '').trim() : null), 3000);
    check('desktop: Enter on the arrow opens it with the focus on the first camera', focused === 'Integrated Webcam', { focused });
    await D.keyboard.press('Enter');
    const d3 = await waitOwn(D, c => c.live && c.label === d1.label);
    check('desktop: Enter on it switches back to that webcam', d3.label === d1.label, { label: d3.label });
    const back = await until(() => D.evaluate(() => document.activeElement?.getAttribute('data-testid')), 2000);
    check('desktop: and the focus goes back to the arrow', back === 'camera-options', { back });
    await tileShows(P, uid.D, 'orange', 'desktop by keys', { probe: true });

    step('desktop: a switch in full screen that can open no camera at all');
    await press(D, '[data-testid="camera-options"]');
    await until(() => geometry(D, '.camera-menu .context-menu-item', '^Full screen$'), 4000);
    await press(D, '.camera-menu .context-menu-item', '^Full screen$');
    const dFs = await until(() => D.evaluate(() => !!document.querySelector('.camera-fullscreen')), 5000);
    await D.evaluate(() => { window.__cams.allBusy = true; });
    await press(D, '.camera-fullscreen-controls [data-testid="camera-flip"]');
    const dOff = await until(() => D.evaluate(() => (document.body.innerText.includes('could not be opened again') && !document.querySelector('.camera-fullscreen, .camera-preview-mini')) || null), 12000);
    check('desktop: no camera to be had, it is off, out of full screen, and it says so', !!dFs && !!dOff, { dFs, dOff });
    await D.evaluate(() => { window.__cams.allBusy = false; });
    await D.locator('.vp-camera').click();
    const dBack = await until(() => D.evaluate(() => (document.querySelector('.camera-preview-mini') && !document.querySelector('.camera-fullscreen')) ? true : document.querySelector('.camera-fullscreen') ? 'full screen' : null), 8000);
    check('desktop: turned on again, the camera opens in its small window, not straight into full screen', dBack === true, { dBack });
    await D.evaluate(() => [...document.querySelectorAll('.camera-fullscreen-controls .exit-btn')].forEach(b => b.click()));

    step('phone: cameras plugged in since, the menu opened low on the screen');
    await expandPhonePanel(P);
    await P.evaluate(() => {
        window.__cams.plug({ deviceId: 'cam-usb-1', label: 'USB Camera (1234:0001)', facing: null, color: '#808080', name: 'grey' });
        window.__cams.plug({ deviceId: 'cam-usb-2', label: 'USB Camera (1234:0002)', facing: null, color: '#606060', name: 'grey2' });
        window.__cams.listDelayMs = 400;
    });
    const lowArrow = await geometry(P, '[data-testid="camera-options"]');
    await press(P, '[data-testid="camera-options"]');
    const grown = await until(() => P.evaluate(() => [...document.querySelectorAll('[data-testid="camera-option"]')].filter(e => e.getClientRects().length > 0).length >= 5 || null), 6000);
    await sleep(700);
    const lowRows = [];
    for (const e of await P.locator('.camera-menu .context-menu-item').all()) lowRows.push(await e.evaluate((el) => { const b = el.getBoundingClientRect(); const h = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return { t: el.textContent.trim(), top: Math.round(b.top), bottom: Math.round(b.bottom), on: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight, hits: !!h && el.contains(h) }; }));
    check('phone: rows that arrive after the menu opened (two cameras plugged in) keep every row inside the window and what a tap hits, Turn off camera too',
        !!grown && lowRows.length >= 8 && lowRows.every(r => r.on && r.hits) && lowRows.some(r => r.t === 'Turn off camera'), { arrowTop: lowArrow && Math.round(lowArrow.cy), lowRows });
    if (OUT) save('phone-menu-grown.png', await P.screenshot());
    await P.keyboard.press('Escape');
    await until(() => P.evaluate(() => !document.querySelector('.camera-menu')), 3000);
    await P.evaluate(() => { window.__cams.listDelayMs = 0; window.__cams.unplug('cam-usb-1'); window.__cams.unplug('cam-usb-2'); });

    // ---- themes: the menu's words, the controls' icons ----
    step('all eight themes, with and without high contrast');
    const poor = [];
    let measured = 0;
    await press(P, '[data-testid="camera-self-view-menu"]');
    await until(() => geometry(P, '.camera-menu .context-menu-item', '^Full screen$'), 4000);
    await expandPhonePanel(P);
    for (const theme of THEMES) {
        for (const hc of ['normal', 'high']) {
            for (const page of [P, D]) {
                await page.evaluate(([t, c]) => { document.documentElement.setAttribute('data-theme', t); document.documentElement.setAttribute('data-contrast', c); }, [theme, hc]);
            }
            await sleep(400);
            for (const [tag, page] of [['phone', P], ['desktop', D]]) {
                const r = await page.evaluate(() => {
                    const rgba = (s) => { const m = s && s.match(/[\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); return [r, g, b, a]; };
                    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
                    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
                    // What an element is painted on: translucent layers down to the
                    // first opaque one; over a camera picture, the brightest there is.
                    const paint = (el) => {
                        const layers = [];
                        let base = null;
                        for (let e = el; e; e = e.parentElement) {
                            if (e.matches('.camera-preview-mini, .camera-fullscreen')) { base = [255, 255, 255]; break; }
                            const c = rgba(getComputedStyle(e).backgroundColor);
                            if (!c || c[3] === 0) continue;
                            layers.push(c);
                            if (c[3] >= 1) break;
                        }
                        let [r, g, b] = base ?? (layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : [255, 255, 255]);
                        for (const [lr, lg, lb, la] of layers.reverse()) { r = lr * la + r * (1 - la); g = lg * la + g * (1 - la); b = lb * la + b * (1 - la); }
                        return [r, g, b];
                    };
                    const ink = (el, bg) => {
                        let [r, g, b, a] = rgba(getComputedStyle(el).color);
                        for (let e = el; e; e = e.parentElement) a *= Number(getComputedStyle(e).opacity);
                        return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
                    };
                    const out = [];
                    const visible = (e) => e.getClientRects().length > 0;
                    for (const row of document.querySelectorAll('.camera-menu .context-menu-item')) {
                        if (!visible(row)) continue;
                        const label = row.querySelector('.context-menu-label');
                        const bg = paint(row);
                        out.push({ what: 'menu: ' + label.textContent.trim(), need: 4.5, got: ratio(ink(label, bg), bg) });
                    }
                    for (const sel of ['[data-testid="camera-flip"]', '[data-testid="camera-options"]', '.camera-fullscreen-controls button']) {
                        for (const el of document.querySelectorAll(sel)) {
                            if (!visible(el)) continue;
                            const bg = paint(el);
                            const words = (el.textContent || '').trim();
                            out.push({ what: sel + (words ? ' ' + words : ''), need: words ? 4.5 : 3, got: ratio(ink(el, bg), bg) });
                        }
                    }
                    return out;
                });
                for (const x of r) { measured++; if (x.got < x.need) poor.push({ theme, hc, tag, ...x, got: Math.round(x.got * 100) / 100 }); }
            }
            if (OUT && hc === 'normal') save(`theme-${theme}-phone.png`, await P.screenshot());
        }
    }
    check(`every word in the camera menu 4.5:1 and every icon-only camera control 3:1 on all eight themes x contrast (${measured} measured)`, poor.length === 0 && measured >= 16 * 8, poor.slice(0, 12));
    for (const page of [P, D]) await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.setAttribute('data-contrast', 'normal'); });
    await P.keyboard.press('Escape');

    // ---- Settings > Voice & Video ----
    step('desktop: Settings > Voice & Video > Camera');
    await D.evaluate(() => [...document.querySelectorAll('button[title="Settings"]')].find(e => e.getClientRects().length > 0)?.click());
    const opened = await until(() => D.evaluate(() => !!document.querySelector('.settings-modal')), 5000);
    if (opened) {
        await D.evaluate(() => [...document.querySelectorAll('.settings-nav-item')].find(e => /Voice & Video/.test(e.textContent || ''))?.click());
        // The list fills in once the browser has listed the devices.
        const opts = await until(() => D.evaluate(() => { const s = document.querySelector('[data-testid="settings-camera"]'); const o = s ? [...s.options].map(x => x.textContent.trim()) : []; return o.length >= 3 ? o : null; }), 8000)
            ?? await D.evaluate(() => [...(document.querySelector('[data-testid="settings-camera"]')?.options ?? [])].map(x => x.textContent.trim()));
        check('Settings > Voice & Video lists the cameras, the one in use chosen', !!opts && opts.includes('Integrated Webcam') && opts.includes('Logitech BRIO')
            && (await D.inputValue('[data-testid="settings-camera"]')) === 'cam-int', { opts, value: await D.inputValue('[data-testid="settings-camera"]') });
        await D.selectOption('[data-testid="settings-camera"]', 'cam-brio');
        const kept = await D.evaluate(() => JSON.parse(localStorage.getItem('sovereign_settings') || '{}').camera ?? null);
        check('a camera chosen there is kept as the one to open', kept?.deviceId === 'cam-brio', kept);
        await D.keyboard.press('Escape');
    } else {
        check('Settings opens', false);
    }
} catch (e) {
    console.log('FAIL  the run threw:', e?.stack || e);
    failed++;
} finally {
    for (const b of browsers) await b.close().catch(() => {});
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
