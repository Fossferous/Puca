// LIVE: a person in a call CONTROLS an Android phone that shares its screen
// (docs/REMOTE_CONTROL.md, "Controlling a phone"; api/phoneControl.ts and the
// APK's :phone-control module, an AccessibilityService).
//
// The phone is the REAL debug APK on a HEADLESS emulator (`-no-window
// -no-audio`; only an emulator-NNNN serial is accepted), driven through its
// WebView's DevTools and, for everything outside the WebView (Settings, the
// launcher, the shade, Android's consent), uiautomator + input over
// `adb -s <SERIAL>`. The viewer is headless Edge, --mute-audio, on a vite dev
// server of this tree. Nothing is shown on, or played through, this PC.
//
// Every effect on the phone is READ BACK from the phone itself (uiautomator
// dumps, screencaps), never from the page that sent it. What it proves:
//   - the phone shares (Android's consent, "Share entire screen");
//   - with Púca remote control OFF in Android's Accessibility settings, a
//     request shows the phone's prompt with the set-up words and a DISABLED
//     Allow, and its "Open Accessibility settings" lands on Púca's entry; the
//     viewer's cancel takes the prompt down (NEGATIVE CONTROL: nothing granted);
//   - switched on, a request the person DENIES grants nothing, and a click on
//     the viewer's picture changes nothing on the phone (NEGATIVE CONTROL);
//   - ALLOWED: the phone shows the orange frame over every app (screencap), the
//     notification says who and offers Stop control, the viewer gets the
//     phone's Back / Home / Recents (the sealed HostInfo arrived), and then,
//     with Android's Settings in front:
//       a CLICK taps a row (the page it opens is on the phone), Back goes back,
//       a DRAG swipes the list (the rows move up), Home and a RIGHT-CLICK on
//       an icon long-press it (its shortcut menu), typing goes into Settings'
//       search field (its text is what was typed), and turned SIDEWAYS a click
//       still lands on the row it was aimed at;
//   - REVOKED from the notification's Stop control: the frame goes, the viewer
//     is told, and a click aimed at the same row changes nothing (NEGATIVE
//     CONTROL); from the frame's own Stop on the screen; and by LOCKING the
//     phone, after which nothing resumes on unlock.
//
// Needs: the same rig as e2e/android-share-live.mjs (read its header: a
// THROWAWAY backend + Postgres as API, a vite dev server of this tree at APP
// against that API, the debug APK of this tree on SERIAL with `adb reverse
// tcp:<api port>`, built with VITE_API_URL = API and PUCA_ALLOW_LOCAL_BUILD=1,
// and the LOCAL uncommitted cleartext overlay for 127.0.0.1). SFU=1 as there.
// The run switches Púca's accessibility service on and off with `settings put
// secure` (only on the emulator) and leaves it off.
//
// APP may be a vite dev server of this tree or the BUILT bundle served
// (`vite preview`): the walk reads the viewer only through its page and the
// REST API, never through /src imports.
//
// Usage: SERIAL=emulator-5600 API=http://127.0.0.1:3873 APP=http://localhost:5175 [SFU=1] [OUT=dir] node e2e/android-control-live.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERIAL = process.env.SERIAL || '';
const API = process.env.API || 'http://127.0.0.1:3873';
const APP = process.env.APP || 'http://localhost:5174';
const SFU = process.env.SFU === '1';
const OUT = process.env.OUT || '';
const CHANNEL = process.env.CHANNEL || 'msedge';
const PKG = 'com.sovereign.app';
const SERVICE = `${PKG}/${PKG}.control.PhoneControlService`;
// Its own port, checked after forwarding: adb forwards are global to the
// host's adb server, so another emulator's forward on the same port takes it
// over silently (it happened: the page read back was another session's).
const CDP_PORT = Number(process.env.CDP_PORT || 9617);
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
const save = (name, bytes) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), bytes); } };

// ---- the phone's own UI ------------------------------------------------------

let dumpN = 0;
/** Is Púca remote control bound by Android right now? (dumpsys, which is not
 *  an accessibility client itself.) */
const bound = () => /Bound services:\{[^\n]*P.ca remote control/.test(sh('dumpsys accessibility'));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** While a control session is live. uiautomator connects UiAutomation, and
 *  Android unbinds every other accessibility service while it runs: the
 *  session pauses (PhoneControl.serviceChanged) and resumes when Android
 *  gives the service back. Each dump waits for that, so the next input is
 *  not dropped into the pause. */
let liveSession = false;
/** Every node uiautomator sees, and the screen's size as turned now. Saved
 *  to OUT as evidence when `tag` is given. */
function dump(tag) {
    // A dump that fails (on a loaded emulator: the screen never went idle)
    // leaves the LAST file in place, and reading it back reports a screen that
    // is long gone. So the file is removed first, and a failed dump retried.
    let xml = '';
    for (let i = 0; i < 4 && !xml.includes('<hierarchy'); i++) {
        sh('rm -f /sdcard/puca-ui.xml; uiautomator dump /sdcard/puca-ui.xml >/dev/null 2>&1; true');
        xml = sh('cat /sdcard/puca-ui.xml 2>/dev/null || true');
        if (!xml.includes('<hierarchy')) sleepSync(1000);
    }
    if (liveSession) {
        for (let i = 0; i < 40 && !bound(); i++) sleepSync(250);
        sleepSync(600); // the frame and pill shown again before anything lands
    }
    if (tag) save(`${String(++dumpN).padStart(2, '0')}-${tag}.xml`, Buffer.from(xml));
    const nodes = [];
    let w = 0, h = 0;
    const unxml = (v) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&')
        // Android writes some accented letters decomposed ("u" + a combining accent).
        .normalize('NFC');
    for (const m of xml.matchAll(/<node [^>]*>/g)) {
        const a = (k) => unxml((new RegExp(`${k}="([^"]*)"`).exec(m[0]) || [])[1] || '');
        const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a('bounds'));
        if (!b) continue;
        w = Math.max(w, +b[3]); h = Math.max(h, +b[4]);
        nodes.push({ text: a('text'), desc: a('content-desc'), id: a('resource-id'), cls: a('class'), pkg: a('package'),
            clickable: a('clickable') === 'true', focused: a('focused') === 'true',
            x: (+b[1] + +b[3]) >> 1, y: (+b[2] + +b[4]) >> 1, left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] });
    }
    // An overloaded emulator shows Android's "<app> isn't responding" over
    // whatever is in front, and it takes every tap after it: Wait, and look
    // again. Logged, so a run that needed it says so.
    if (nodes.some(n => /isn.t responding/.test(n.text)) && !dump.inAnr) {
        const wait = nodes.find(n => /^Wait$/i.test(n.text));
        console.log(`  (Android said an app isn't responding: ${nodes.find(n => /isn.t responding/.test(n.text)).text}; pressing Wait)`);
        if (wait) {
            sh(`input tap ${wait.x} ${wait.y}`);
            sleepSync(1500);
            dump.inAnr = true;
            try { return dump(tag); } finally { dump.inAnr = false; }
        }
    }
    return { nodes, w, h, texts: nodes.map(n => n.text).filter(Boolean) };
}
const uiNodes = () => dump().nodes;
const findNode = (re) => uiNodes().find(n => re.test(n.text) || re.test(n.desc));
const tapAt = (n) => sh(`input tap ${n.x} ${n.y}`);
async function tapText(re, ms = 10000) {
    const n = await until(() => findNode(re), ms, 500);
    if (!n) return false;
    tapAt(n);
    return true;
}
async function consent(answer) {
    const dialog = await until(() => findNode(/Start recording or casting|Share your screen|start (recording|casting)|Share screen with|will have access/i), 15000, 500);
    if (!dialog) return { shown: false };
    if (answer === 'cancel') return { shown: true, pressed: await tapText(/^Cancel$/i, 3000) };
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
async function realTap(page, selector) {
    const r = await page.evaluate((sel) => {
        const e = [...document.querySelectorAll(sel)].find(x => x.offsetParent !== null);
        if (!e) return null;
        e.scrollIntoView({ block: 'center' });
        const b = e.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2, dpr: devicePixelRatio };
    }, selector);
    if (!r) return null;
    // Where the WebView sits, read ONCE: finding it takes a uiautomator dump,
    // and a dump unbinds Púca's accessibility service while it runs, which
    // made the phone refuse an Allow pressed straight after it.
    if (!webOrigin) {
        const web = uiNodes().find(n => n.cls === 'android.webkit.WebView');
        if (web) webOrigin = { left: web.left, top: web.top };
    }
    const left = webOrigin ? webOrigin.left : 0, top = webOrigin ? webOrigin.top : 0;
    sh(`input tap ${Math.round(left + r.x * r.dpr)} ${Math.round(top + r.y * r.dpr)}`);
    return r;
}
let webOrigin = null;
/** The window Android has given the focus. Read with dumpsys, which asks
 *  nothing of the app (a uiautomator dump makes a focused WebView build its
 *  whole accessibility tree on the app's main thread). */
const focusedWindow = () => (/mCurrentFocus=([^\n]*)/.exec(sh('dumpsys window | grep mCurrentFocus')) || [])[1] || '';
async function answerSystemDialogs() {
    // Only when something other than Púca has the focus: nothing to answer
    // otherwise, and no dump of Púca's WebView for nothing.
    if (focusedWindow().includes(`${PKG}/`)) return;
    for (let i = 0; i < 3; i++) {
        if (!findNode(/always run in background|battery optimi[sz]ation/i)) return;
        await tapText(/^(Deny|Don.t allow|No)$/i, 2000);
        await sleep(800);
    }
}
const screencap = () => adb('exec-out', 'screencap', '-p');
const pucaFront = () => sh(`am start -W -n ${PKG}/.MainActivity`);
const settingsFront = () => sh('am start -W -a android.settings.SETTINGS');
const serviceOn = () => { sh(`settings put secure enabled_accessibility_services ${SERVICE}`); sh('settings put secure accessibility_enabled 1'); };
const serviceOff = () => { sh('settings delete secure enabled_accessibility_services'); };
const notifications = () => sh('dumpsys notification --noredact');

/** Is the orange control frame on the phone's screen? Read from a screencap
 *  (decoded by the viewer's browser): the frame's colour at the middle of the
 *  left edge and of the bottom edge. */
async function frameOnScreen(V) {
    const png = screencap();
    const px = await V.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
        return { left: at(3, c.height >> 1), bottom: at(c.width >> 1, c.height - 4), w: c.width, h: c.height };
    }, png.toString('base64'));
    const orange = ([r, g, b]) => r > 200 && g > 100 && g < 175 && b < 80;
    return { on: orange(px.left) && orange(px.bottom), px, png };
}

// ---- the pages -----------------------------------------------------------------

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
    P.setRemoteDescription = function (d, ...rest) { return setRemote.call(this, d && d.sdp ? { type: d.type, sdp: fix(d.sdp) } : d, ...rest); };
    const addCandidate = P.addIceCandidate;
    P.addIceCandidate = function (c, ...rest) {
        if (c && c.candidate) { const j = typeof c.toJSON === 'function' ? c.toJSON() : c; c = { ...j, candidate: fix(j.candidate) }; }
        return addCandidate.call(this, c, ...rest);
    };
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
    // Creating an account derives keys in the page: on a busy machine the
    // page can be unresponsive for a while, so these waits are generous.
    await page.locator('button.login-button[type="submit"]').click({ timeout: 180000, noWaitAfter: true });
    await page.waitForURL('**/chat', { timeout: 300000 });
    await sleep(2000);
    await dismiss(page);
}
/** The REST API as the page's signed-in account (its own token). */
const api = (page, method, route, body) => page.evaluate(async ({ api, method, route, body }) => {
    const r = await fetch(api + route, {
        method,
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('auth_token') },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { status: r.status, text }; }
}, { api: API, method, route, body });
const uidOf = (p) => p.evaluate(() => { try { const t = localStorage.getItem('auth_token') || ''; return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { return null; } });
const SEL = {
    share: '[data-testid="voice-share-screen"]',
    stop: '[data-testid="voice-stop-share"]',
    connected: '[data-testid="voice-connected"], .voice-connected-label',
    prompt: '[data-testid="rc-phone-prompt"]',
    allow: '[data-testid="rc-phone-allow"]',
    banner: '[data-testid="rc-banner"]',
};

/** The viewer's control state, read from what its page shows (so the viewer
 *  can be the BUILT bundle: a dev server compiling the app on first load
 *  took minutes on a busy machine): the capture surface while in control,
 *  the cancel button while asking, the phone's own buttons once the host
 *  said it is a phone, and the notice. */
const viewerControl = (V) => V.evaluate(() => {
    const active = !!document.querySelector('.control-capture');
    const asking = !!document.querySelector('[data-testid="rc-cancel-request"]');
    return {
        controlling: active ? { status: 'active' } : asking ? { status: 'requesting' } : null,
        notice: document.querySelector('.rc-toast')?.textContent ?? null,
        kind: document.querySelector('[data-testid="rc-phone-back"]') ? 'phone' : null,
    };
});

/**
 * A REAL mouse click (or press-move-release) on the viewer's picture of the
 * phone, at fractions of that picture: the same fractions of the phone's
 * screen are where it must land. Through the capture surface, as a person's
 * mouse would.
 */
async function viewerPoint(V, nx, ny) {
    return V.evaluate(({ nx, ny }) => {
        const v = document.querySelector('.control-capture')?.parentElement?.querySelector('video.stream-video')
            ?? document.querySelector('video.stream-video');
        if (!v || !v.videoWidth) return null;
        const r = v.getBoundingClientRect();
        const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
        return { x: r.left + (r.width - dw) / 2 + nx * dw, y: r.top + (r.height - dh) / 2 + ny * dh, vw: v.videoWidth, vh: v.videoHeight };
    }, { nx, ny });
}
async function viewerClick(V, nx, ny, button = 'left') {
    const p = await viewerPoint(V, nx, ny);
    if (!p) return null;
    await V.mouse.move(p.x, p.y);
    await sleep(80);
    await V.mouse.down({ button });
    await sleep(button === 'right' ? 120 : 90);
    await V.mouse.up({ button });
    await settleInput();
    return p;
}
async function viewerDrag(V, from, to, ms = 450, steps = 18) {
    const a = await viewerPoint(V, from[0], from[1]);
    const b = await viewerPoint(V, to[0], to[1]);
    if (!a || !b) return false;
    await V.mouse.move(a.x, a.y);
    await sleep(80);
    await V.mouse.down();
    for (let i = 1; i <= steps; i++) {
        await V.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
        await sleep(ms / steps);
    }
    // Held still a moment at the end, as a person scrolling (not flicking) does.
    await sleep(150);
    await V.mouse.up();
    await settleInput();
    return true;
}
const norm = (n, d) => [n.x / d.w, n.y / d.h];
/**
 * At most `tries` dumps, `gap` ms apart, until `ok(dump)`. Not a tight poll:
 * each dump is a uiautomator process on the emulator (heavy when it is short
 * of CPU, and Android then answers "isn't responding" for whatever is in
 * front) and it pauses Púca's service while it runs.
 */
async function dumpUntil(ok, tries = 3, gap = 2500) {
    for (let i = 0; i < tries; i++) {
        if (i) await sleep(gap);
        const d = dump();
        if (await ok(d)) return d;
    }
    return null;
}
const inSettings = (d) => d.nodes.some(n => n.pkg === 'com.android.settings');
/** Time for a viewer's input to cross the call and play on the phone before
 *  anything reads the phone back (a uiautomator dump pauses the service, and
 *  a gesture still playing then is cancelled). */
const settleInput = () => sleep(2000);
/** Press one of the viewer's phone buttons (Back, Home, Recents). */
async function phoneButton(V, a) {
    await V.evaluate((x) => document.querySelector(`[data-testid="rc-phone-${x}"]`)?.click(), a);
    await settleInput();
}

/** A row of Settings' main list by its words, and the page it opens. */
const ROW = /^Network (&|and) internet$/i;
const ROW_PAGE = /^(Airplane mode|Internet|SIMs?|Hotspot (&|and) tethering|Data Saver)$/i;
const MAIN_LIST = /^(Connected devices|Apps|Notifications|Battery|Display)$/i;
const onRowPage = (d) => d.texts.some(t => ROW_PAGE.test(t)) && !d.texts.some(t => /^Connected devices$/i.test(t));
const onMainList = (d) => d.texts.some(t => MAIN_LIST.test(t));

/** Throws unless the attached phone page is still this run's. */
let mine = async () => {};

/** Ask for control from the viewer's tile, and answer on the phone. */
async function requestControl(V, P, answer) {
    await mine();
    await V.evaluate(() => document.querySelector('button[title="Request control of this screen"]')?.click());
    const prompt = await until(() => P.evaluate((s) => !!document.querySelector(s), SEL.prompt), 15000);
    if (!prompt) return { prompt: false };
    const noticed = /wants to control this phone/.test(notifications());
    pucaFront();
    await sleep(1500);
    if (answer === 'none') return { prompt: true, noticed };
    // Allow waits for the phone's own answer (the service on), and the
    // service bound (an earlier dump may still be holding it away).
    const ready = await until(() => P.evaluate((s) => { const b = document.querySelector(s); return !!b && !b.disabled; }, SEL.allow), 8000);
    if (answer === 'allow') await until(() => bound(), 10000, 250);
    const sel = answer === 'allow' ? SEL.allow : '.rc-prompt .rc-deny';
    let tapped = !!await realTap(P, sel);
    // The prompt can be taller than the screen, its buttons at the very
    // bottom: a tap that missed leaves it up. Once more, then report.
    if (tapped && !await until(() => P.evaluate((s) => !document.querySelector(s), SEL.prompt), 6000, 500)) {
        await sleep(500);
        tapped = !!await realTap(P, sel);
    }
    return { prompt: true, noticed, ready: !!ready, tapped };
}

let forwarded = false;
let rotated = false;
let serviceTouched = false;
const browsers = [];
try {
    step('a fresh app');
    const attached = execFileSync(ADB, ['devices'], { encoding: 'utf8' });
    if (!attached.split('\n').map(l => l.trim().split(/\s+/)).some(([s, st]) => s === SERIAL && st === 'device')) throw new Error(`${SERIAL} is not attached`);
    sh(`pm clear ${PKG}`);
    // Settings as Android starts it: an earlier run may have left it on some page.
    sh('am force-stop com.android.settings');
    serviceTouched = true;
    serviceOff();
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh('cmd statusbar collapse');
    sh('settings put system accelerometer_rotation 0');
    sh('settings put system user_rotation 0');
    pucaFront();
    step('waiting for its WebView');
    const pid = (await until(() => sh(`pidof ${PKG}`).trim(), 30000)) || '';
    await until(() => sh('cat /proc/net/unix').includes(`webview_devtools_remote_${pid}`), 30000);
    adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);
    forwarded = true;
    const fwd = execFileSync(ADB, ['forward', '--list'], { encoding: 'utf8' });
    if (!fwd.split(/\r?\n/).some(l => l.trim() === `${SERIAL} tcp:${CDP_PORT} localabstract:webview_devtools_remote_${pid}`)) {
        throw new Error(`tcp:${CDP_PORT} is not forwarded to ${SERIAL}'s app (another device holds it?): ${fwd}`);
    }
    const wvBrowser = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`), 30000, 1000);
    browsers.push(wvBrowser);
    const P = await until(() => wvBrowser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://localhost')), 90000, 1000);
    if (!P) throw new Error('the page of the app did not appear');
    P.on('console', (m) => { const t = m.text(); if (/\[control\]|PhoneControl|ScreenShare\]/i.test(t)) console.log(`  [phone] ${t.slice(0, 240)}`); });
    if (SFU) await P.context().addInitScript(EMULATOR_LOOPBACK);
    await P.evaluate(QUIET);
    await P.reload({ waitUntil: 'domcontentloaded' });
    // This run's mark on the page, checked before every phone step reads it.
    await P.evaluate((s) => { sessionStorage.setItem('ctl-rig', s); }, stamp);
    mine = async () => {
        const m = await P.evaluate(() => sessionStorage.getItem('ctl-rig')).catch(() => null);
        if (m !== stamp) throw new Error('the phone page is no longer this run\'s (another device took the DevTools port?)');
    };
    const pluginThere = await until(() => P.evaluate(() => !!window.Capacitor?.isPluginAvailable?.('SovereignPhoneControl')), 20000);
    check('the full APK carries the control plugin', !!pluginThere);

    const b = await chromium.launch({ channel: CHANNEL, headless: true, args: VIEWER_ARGS }); browsers.push(b);
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(QUIET);
    const V = await ctx.newPage();
    V.on('pageerror', (e) => console.log(`  [viewer pageerror] ${e.message.slice(0, 200)}`));
    // A cold or busy dev server compiles the whole app on this first load.
    await V.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 300000 });

    step('signing up both, a server with a voice channel');
    await signUp(V, `ctlv_${stamp}`);
    await signUp(P, `ctlp_${stamp}`);
    const uid = { V: await uidOf(V), P: await uidOf(P) };
    const srv = await api(V, 'POST', '/servers', { name: 'PC ' + stamp.slice(-4) });
    const voice = await api(V, 'POST', `/servers/${srv.id}/channels`, { name: 'Phone desk', channel_type: 1 });
    if (SFU) await api(V, 'PATCH', `/channels/${voice.id}`, { sfu_mode: true });
    const inv = await api(V, 'POST', `/servers/${srv.id}/invites`, {});
    const joined = await P.evaluate(async ({ api, code }) => (await fetch(`${api}/invites/${code}/join`, { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } })).status, { api: API, code: inv.code });
    check(`fixture: a ${SFU ? 'SFU' : 'mesh'} voice channel, the phone a member`, joined < 300 && Number.isInteger(uid.P), { joined, uid });
    for (const p of [V, P]) { await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000); await dismiss(p); }
    for (const [tag, p] of [['viewer', V], ['phone', P]]) {
        await p.evaluate((id) => document.querySelector(`[data-testid="server-icon"][data-server-id="${id}"]`)?.click(), srv.id);
        await sleep(1200);
        await p.evaluate((id) => document.querySelector(`[data-testid="voice-channel"][data-channel-id="${id}"]`)?.click(), voice.id);
        check(`${tag} is in the call`, !!await until(async () => (await p.locator(SEL.connected).count()) > 0, 30000));
    }
    await sleep(2500);
    await answerSystemDialogs();

    step('the phone shares its whole screen');
    let started = { shown: false };
    for (let attempt = 1; attempt <= 2 && !started.shown; attempt++) {
        // Púca in front: a tap is placed by the WebView's place on screen,
        // and another app left in front (Settings, from an earlier run) takes it.
        pucaFront();
        await sleep(1500);
        await answerSystemDialogs();
        // The app's own late questions (a recovery code never saved) sit over
        // the voice bar and take the tap.
        await dismiss(P);
        await P.evaluate(() => { if (!document.querySelector('[data-testid="voice-share-screen"]')?.offsetParent) document.querySelector('button[aria-label="More voice controls"]')?.click(); });
        await sleep(800);
        save(`05-before-share-${attempt}.png`, screencap());
        const where = await P.evaluate((s) => {
            const e = document.querySelector(s);
            if (!e) return 'no button';
            const b = e.getBoundingClientRect();
            return { visible: e.offsetParent !== null, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
        }, SEL.share);
        console.log(`  (share button, attempt ${attempt}: ${JSON.stringify(where)})`);
        if (!await realTap(P, SEL.share)) await P.locator(SEL.share).first().click({ timeout: 10000 }).catch(() => {});
        started = await consent('start');
        if (!started.shown) {
            save(`05-no-consent-${attempt}.png`, screencap());
            dump(`no-consent-${attempt}`);
            // A modal (the share settings, a system question) may be in the way: close it and retry.
            await P.evaluate(() => document.querySelector('.stream-modal .stream-btn-secondary')?.click());
            await sleep(1000);
        }
    }
    check('Android\'s consent, "Share entire screen"', started.shown && started.pressed, started);
    check('the phone is live', !!await until(async () => (await P.locator(SEL.stop).count()) > 0, 20000));
    await V.evaluate((id) => document.querySelector(`[data-testid="voice-channel"][data-channel-id="${id}"]`)?.click(), voice.id);
    await sleep(800);
    await until(() => V.evaluate(() => { const x = document.querySelector('.watch-live-btn'); if (x) { x.click(); return true; } return false; }), 8000);
    await sleep(600);
    await until(() => V.evaluate(() => { const x = [...document.querySelectorAll('button')].find(e => /^watch/i.test((e.textContent || '').trim())); if (x) { x.click(); return true; } return false; }), 4000);
    check('the viewer watches the phone, the request button on its tile',
        !!await until(() => V.evaluate(() => !!document.querySelector('button[title="Request control of this screen"]') && (document.querySelector('video.stream-video')?.videoWidth ?? 0) > 0), 30000));

    // ---- 1. Púca remote control OFF: the prompt says how, Allow cannot be pressed
    settingsFront();
    await sleep(1500);
    step('service off: a request');
    const r1 = await requestControl(V, P, 'none');
    check('the request reaches the phone as its own prompt', r1.prompt);
    check('and as a notification (the phone is in another app)', r1.noticed);
    const setup = await until(() => P.evaluate(() => ({
        setup: !!document.querySelector('[data-testid="rc-phone-setup"]'),
        allowDisabled: !!document.querySelector('[data-testid="rc-phone-allow"]')?.disabled,
        words: document.querySelector('[data-testid="rc-phone-prompt"]')?.textContent ?? '',
    })).then(s => (s.setup ? s : null)), 8000);
    check('it says to turn Púca remote control on in Accessibility settings', !!setup && /Accessibility settings/.test(setup.words) && /Púca remote control/.test(setup.words), setup?.words?.slice(0, 160));
    check('and Allow cannot be pressed', !!setup?.allowDisabled);
    save('10-prompt-service-off.png', screencap());
    await realTap(P, '[data-testid="rc-phone-open-settings"]');
    const a11y = await dumpUntil((d) => d.texts.some(t => /Púca remote control|P.ca remote control/.test(t)));
    check('"Open Accessibility settings" lands on Púca\'s entry in Android\'s settings', !!a11y, a11y ? undefined : dump('a11y-missing').texts.slice(0, 20));
    if (a11y) dump('a11y-entry');
    await V.evaluate(() => document.querySelector('[data-testid="rc-cancel-request"]')?.click());
    check('the viewer cancels the request: the phone\'s prompt goes',
        !!await until(() => P.evaluate((s) => !document.querySelector(s), SEL.prompt), 8000));
    const v1 = await viewerControl(V);
    check('NEGATIVE CONTROL: nothing was granted', !v1.controlling, v1);

    // ---- 2. switched on; DENIED: nothing lands
    step('service on');
    serviceOn();
    const on = await until(() => bound() ? true : null, 10000);
    check('Android binds Púca remote control once it is switched on', !!on);
    settingsFront();
    await sleep(1500);
    const r2 = await requestControl(V, P, 'deny');
    check('a second request: the prompt, now with Allow pressable', r2.prompt && r2.ready, r2);
    const denied = await until(async () => { const s = await viewerControl(V); return !s.controlling && /declined/i.test(s.notice || '') ? s : null; }, 8000);
    check('the person denies: the viewer is told', !!denied, denied);
    settingsFront();
    await sleep(2500);
    const before = dump('denied-before');
    await V.evaluate(() => document.querySelector('video.stream-video')?.click());
    const rowN = before.nodes.find(n => ROW.test(n.text));
    if (rowN) await viewerClick(V, ...norm(rowN, before));
    await sleep(2500);
    const after = dump('denied-after');
    check('NEGATIVE CONTROL: a click on the picture after a denial changes nothing on the phone',
        !!rowN && onMainList(after) && !onRowPage(after), { row: !!rowN, main: onMainList(after) });

    // ---- 3. ALLOWED
    step('waiting out the denial cooldown');
    await sleep(11000);
    const r3 = await requestControl(V, P, 'allow');
    check('a third request, allowed on the phone', r3.prompt && r3.ready && r3.tapped, r3);
    const active = await until(async () => { const s = await viewerControl(V); return s.controlling?.status === 'active' && s.kind === 'phone' ? s : null; }, 15000);
    check('the viewer is in control, and knows its host is a phone (the sealed HostInfo)', !!active, await viewerControl(V));
    liveSession = true;
    check('the viewer\'s tile has the phone\'s Back, Home and Recents',
        !!await until(() => V.evaluate(() => ['back', 'home', 'recents'].every(a => document.querySelector(`[data-testid="rc-phone-${a}"]`))), 5000));
    check('the phone\'s own banner names who is in control',
        !!await until(() => P.evaluate((s) => /is controlling this phone/.test(document.querySelector(s)?.textContent ?? ''), SEL.banner), 5000));
    const frame = await until(async () => { const f = await frameOnScreen(V); return f.on ? f : null; }, 6000, 700) ?? await frameOnScreen(V);
    save('20-frame-on.png', frame.png);
    check('the orange frame is on the phone\'s screen (screencap)', frame.on, frame.px);
    check('the share\'s notification says who and offers Stop control',
        /is controlling this phone/.test(notifications()) && /Stop control/.test(notifications()));

    settingsFront();
    await sleep(3000);

    // a CLICK taps a row
    const main1 = dump('main-list');
    const row = main1.nodes.find(n => ROW.test(n.text));
    check('fixture: Settings shows its main list with the row to tap', !!row && onMainList(main1), main1.texts.slice(0, 12));
    if (row) await viewerClick(V, ...norm(row, main1));
    const opened = await dumpUntil((d) => onRowPage(d));
    if (opened) dump('row-opened');
    check('a CLICK on the picture taps that row on the phone: its page is open', !!opened, opened ? undefined : dump().texts.slice(0, 12));

    // Back
    await phoneButton(V, 'back');
    const back = await dumpUntil((d) => onMainList(d) && !onRowPage(d));
    check('the viewer\'s Back goes back on the phone', !!back);

    // a DRAG swipes the list
    const pre = dump('swipe-before');
    const anchorText = pre.nodes.find(n => MAIN_LIST.test(n.text))?.text;
    const y0 = pre.nodes.find(n => n.text === anchorText)?.y;
    await viewerDrag(V, [0.5, 0.78], [0.5, 0.32]);
    const swiped = await dumpUntil((d) => {
        // Still Settings' list (not a dialog over it), and the row it was
        // measured by has moved up a good way or scrolled off the top.
        if (!inSettings(d) || d.texts.some(t => /isn.t responding/.test(t))) return false;
        const a = d.nodes.find(n => n.text === anchorText);
        return !a || (y0 !== undefined && a.y < y0 - d.h * 0.15);
    });
    if (swiped) dump('swipe-after');
    check('a DRAG on the picture swipes the list up on the phone', !!swiped && !!anchorText, { anchorText, y0, after: swiped?.nodes.find(n => n.text === anchorText)?.y ?? 'scrolled away' });

    // Home, and a RIGHT-CLICK long-presses an icon
    await phoneButton(V, 'home');
    const home = await dumpUntil((d) => d.nodes.some(n => /launcher/i.test(n.pkg)));
    check('the viewer\'s Home goes to the phone\'s home screen', !!home, home ? undefined : dump().nodes.slice(0, 3).map(n => n.pkg));
    const icon = home?.nodes.find(n => /launcher/i.test(n.pkg) && n.clickable && (n.text || n.desc) && n.cls.includes('TextView') && n.y > home.h * 0.5);
    if (home) dump('home');
    if (icon) {
        await viewerClick(V, ...norm(icon, home), 'right');
        const menu = await dumpUntil((d) => d.texts.some(t => /^App info$/i.test(t)) || d.nodes.some(n => /^App info$/i.test(n.desc)));
        if (menu) dump('long-press-menu');
        check('a RIGHT-CLICK long-presses an icon: its shortcut menu opens', !!menu, { icon: icon.text || icon.desc });
        await phoneButton(V, 'back');
        await sleep(1200);
    } else {
        check('fixture: an app icon on the home screen to long-press', false, home?.texts.slice(0, 12));
    }

    // TYPING into Settings' search field
    settingsFront();
    await sleep(3000);
    const main2 = dump();
    const search = main2.nodes.find(n => /^Search Settings$/i.test(n.text))
        ?? main2.nodes.find(n => /search/i.test(n.text) || /search/i.test(n.desc) || /search/i.test(n.id));
    check('fixture: Settings\' search bar', !!search, main2.texts.slice(0, 8));
    if (search) {
        await viewerClick(V, ...norm(search, main2));
        const field = await dumpUntil((d) => d.nodes.find(n => n.cls === 'android.widget.EditText'), 5);
        check('the click opens Settings\' search, with its text field', !!field);
        await V.locator('.control-capture').focus();
        await V.keyboard.type('wifi', { delay: 60 });
        await settleInput();
        const typed = await dumpUntil(async (d) => { const e = d.nodes.find(n => n.cls === 'android.widget.EditText'); return e && /^wifi$/i.test(e.text); }, 4);
        if (typed) dump('typed');
        check('TYPING on the viewer\'s keyboard puts "wifi" in the phone\'s search field', !!typed,
            typed ? undefined : dump().nodes.filter(n => n.cls === 'android.widget.EditText').map(n => n.text));
    }

    // Out of the search again, with the viewer's Back (twice: the keyboard, then the page).
    await phoneButton(V, 'back');
    await phoneButton(V, 'back');

    // SIDEWAYS: the same aim lands on the turned screen. Settings fresh, at
    // the top of its list (the swipe above left it scrolled).
    sh('am force-stop com.android.settings');
    sh('am force-stop com.google.android.settings.intelligence');
    settingsFront();
    await sleep(1500);
    sh('settings put system user_rotation 1');
    rotated = true;
    const side = await dumpUntil(async (d) => { const p = await viewerPoint(V, 0.5, 0.5); return d.w > d.h && p && p.vw > p.vh; }, 4);
    check('turned sideways: the phone and the viewer\'s picture both landscape', !!side, side ? { w: side.w, h: side.h } : undefined);
    await sleep(1500);
    const sideList = dump('sideways-list');
    const sideRow = sideList.nodes.find(n => ROW.test(n.text));
    if (sideRow) await viewerClick(V, ...norm(sideRow, sideList));
    const sideOpened = await dumpUntil((d) => onRowPage(d));
    if (sideOpened) dump('sideways-opened');
    check('sideways, a click still lands on the row it was aimed at', !!sideRow && !!sideOpened, { row: !!sideRow });
    sh('settings put system user_rotation 0');
    await dumpUntil((d) => d.h > d.w);
    await sleep(2000);
    await phoneButton(V, 'back');
    await sleep(1500);

    // ---- 4. REVOKED from the notification
    step('revoked from the notification');
    // Any input keeps a session alive (remoteControl.ts INACTIVITY_MS, 90 s):
    // a pointer move over the picture, so the shade's Stop is what ends it.
    { const c = await viewerPoint(V, 0.5, 0.5); if (c) { await V.mouse.move(c.x, c.y); await V.mouse.move(c.x + 5, c.y + 5); } }
    check('the session is still live before the shade', (await viewerControl(V)).controlling?.status === 'active');
    settingsFront();
    await sleep(1500);
    sh('cmd statusbar expand-notifications');
    await sleep(1500);
    for (let i = 0; i < 3 && !findNode(/^Stop control$/i); i++) {
        const nodes = uiNodes();
        const title = nodes.find(n => n.text === 'Sharing your screen');
        const expand = title && nodes.filter(n => n.id === 'android:id/expand_button' && n.y >= title.y - 120).sort((a, c) => a.y - c.y)[0];
        if (expand) tapAt(expand); else break;
        await sleep(1000);
    }
    if (OUT) dump('shade');
    const stopTapped = await tapText(/^Stop control$/i, 6000);
    sh('cmd statusbar collapse');
    check('the notification\'s Stop control is there and pressed', stopTapped);
    const ended = await until(async () => { const s = await viewerControl(V); return !s.controlling ? s : null; }, 10000);
    liveSession = false;
    check('the viewer is told control ended', !!ended, ended);
    check('the phone\'s banner is gone', !!await until(() => P.evaluate((s) => !document.querySelector(s), SEL.banner), 5000));
    const off = await until(async () => { const f = await frameOnScreen(V); return !f.on ? f : null; }, 6000, 700);
    if (off) save('40-frame-off.png', off.png);
    check('the orange frame is gone from the phone\'s screen', !!off);
    check('the notification no longer offers Stop control', !/Stop control/.test(notifications()));
    settingsFront();
    await sleep(2500);
    const neg = dump('revoked-before');
    const negRow = neg.nodes.find(n => ROW.test(n.text));
    if (negRow) await viewerClick(V, ...norm(negRow, neg));
    await sleep(2500);
    const negAfter = dump('revoked-after');
    check('NEGATIVE CONTROL: after the revoke, a click aimed at the same row changes nothing', !!negRow && onMainList(negAfter) && !onRowPage(negAfter));

    // ---- 5. REVOKED with the frame's own Stop on the screen
    step('revoked from the Stop on the phone\'s screen');
    const r5 = await requestControl(V, P, 'allow');
    check('allowed again', r5.tapped && !!await until(async () => (await viewerControl(V)).controlling?.status === 'active', 15000), r5);
    liveSession = true;
    settingsFront();
    await sleep(2000);
    const withPill = dump('pill');
    await sleep(1000);
    const pillStop = withPill.nodes.find(n => n.text === 'Stop' && n.pkg === PKG);
    // An accessibility overlay is not in every uiautomator dump; when it is
    // not, its Stop is found where it is drawn: the one red (#C62828) button
    // in the top fifth of a screencap.
    const red = pillStop ? null : await V.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const h = Math.round(c.height / 5);
        const d = g.getImageData(0, 0, c.width, h).data;
        let n = 0, sx = 0, sy = 0;
        // The pill is centred with Stop at its right end; the status bar's
        // red screen-recording chip sits at the far left: leave that out.
        const x0 = Math.round(c.width * 0.45);
        for (let y = 0; y < h; y += 2) for (let x = x0; x < c.width; x += 2) {
            const i = (y * c.width + x) * 4;
            if (Math.abs(d[i] - 198) < 18 && Math.abs(d[i + 1] - 40) < 18 && Math.abs(d[i + 2] - 40) < 18) { n++; sx += x; sy += y; }
        }
        return n > 50 ? { x: Math.round(sx / n), y: Math.round(sy / n), n } : null;
    }, screencap().toString('base64'));
    if (pillStop) tapAt(pillStop);
    else if (red) sh(`input tap ${red.x} ${red.y}`);
    const ended5 = await until(async () => { const s = await viewerControl(V); return !s.controlling ? s : null; }, 10000);
    liveSession = false;
    check('the Stop on the phone\'s screen ends it for the viewer', !!(pillStop || red) && !!ended5, { inDump: !!pillStop, red });

    // ---- 6. LOCKING the phone ends it, and nothing resumes on unlock
    step('the phone locked');
    const r6 = await requestControl(V, P, 'allow');
    check('allowed once more', r6.tapped && !!await until(async () => (await viewerControl(V)).controlling?.status === 'active', 15000), r6);
    sh('input keyevent KEYCODE_SLEEP');
    const ended6 = await until(async () => { const s = await viewerControl(V); return !s.controlling ? s : null; }, 12000);
    check('locking the phone ends control at once', !!ended6, ended6);
    await sleep(2000);
    sh('input keyevent KEYCODE_WAKEUP');
    await sleep(800);
    sh('wm dismiss-keyguard');
    await sleep(2500);
    const v6 = await viewerControl(V);
    check('unlocked again: control has not come back by itself', !v6.controlling, v6);
    pucaFront();
    await sleep(1500);
    const why = await P.evaluate(() => document.querySelector('.rc-toast')?.textContent ?? '');
    console.log(`  (the phone said: ${why || 'its notice had already gone'})`);
} catch (e) {
    console.log('FAIL  the run threw:', e?.stack || e);
    failed++;
} finally {
    for (const b of browsers) await b.close().catch(() => {});
    if (rotated) { try { sh('settings put system user_rotation 0'); } catch { /* gone */ } }
    try { sh('settings put system accelerometer_rotation 1'); } catch { /* gone */ }
    if (serviceTouched) { try { serviceOff(); } catch { /* gone */ } }
    if (forwarded) { try { adb('forward', '--remove', `tcp:${CDP_PORT}`); } catch { /* gone */ } }
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
