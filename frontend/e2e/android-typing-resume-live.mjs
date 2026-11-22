// LIVE, on the ANDROID APP: "X is typing…" after a trip to the background
// (components/typingIndicator.ts; the owner's report of 2026-11-21: "when on
// mobile if i switch app and then look at a chat it will usually say someone is
// still typing when they arent").
//
// The phone is the REAL debug APK on a HEADLESS emulator (only an emulator-NNNN
// serial is accepted), sent to the background with Android's own Home key and
// brought back with `am start` (what is measured is what the page handled and
// showed, not a touch: the way into the channel is clicked through DevTools).
// The typer is headless Edge (--mute-audio) on the web app, every key a real one
// into the real composer. What the phone's page handled, and
// when, is read from a recorder put in before the app's own script (every frame
// its socket handed the page, every change of the indicator, every visibility
// change), through the WebView's DevTools, which is DETACHED while the app is in
// the background (an attached client may keep the page visible).
//
// What was measured on this APK before the change (2026-11-21, Android 16
// emulator): for about a minute in the background the page keeps running and
// handles every frame as it comes (no gap in its timers); then the WebView
// freezes it (`freeze`), and on the way back drops its socket (1006) with what
// was sent meanwhile, so no old ping reaches the page. The stale "is typing" was
// the typer's message ending nothing: back 1.5 s after it, the phone said they
// were typing for 3.3 s more.
//
//   live    POSITIVE CONTROL: the phone shows "<typer> is typing" while they
//           type; once their message reaches the phone, it is gone within 1 s.
//   away    the phone in the background 20 s; the typer types 7 s and sends;
//           the phone back 1.5 s after: their message is on screen and nobody is
//           said to be typing. PREMISE: the message and the pings were handled
//           while the page was hidden.
//   again   POSITIVE CONTROL after the return: typing now is shown, and goes 5 s
//           after the last ping (at the next 1 s prune).
// OLD=1: the installed APK is one from before the change (the NEGATIVE CONTROL):
// live and away must FAIL on it, reported as passes of the control.
// APK=<file> installs that APK first (uninstalled first: the AVD's data
// partition is nearly full, and -r fails INSUFFICIENT_STORAGE).
//
// Needs: a THROWAWAY backend + Postgres at API (loopback), the web app of this
// tree at APP built against the same API (vite with VITE_API_URL=API, or a dist
// served by e2e/serve-dist.mjs), and the debug APK of this tree, its bundle built
// with VITE_API_URL = API and PUCA_ALLOW_LOCAL_BUILD=1 and the LOCAL, uncommitted
// cleartext overlay android-share-live.mjs's header describes; `adb reverse` of
// the API port is done here. The emulator runs -no-window -no-audio; nothing here
// plays a sound or opens a window on the desktop. ~3 min.
//
// Usage: SERIAL=emulator-5554 API=http://127.0.0.1:3047 APP=http://127.0.0.1:5487 [APK=app-debug.apk] [OLD=1] node e2e/android-typing-resume-live.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const SERIAL = process.env.SERIAL || '';
const API = (process.env.API || 'http://127.0.0.1:3047').replace(/\/$/, '');
const APP = (process.env.APP || 'http://127.0.0.1:5487').replace(/\/$/, '');
const APK = process.env.APK || '';
const OLD = process.env.OLD === '1';
if (!/^emulator-\d+$/.test(SERIAL)) {
    console.error('SERIAL must name an emulator (emulator-NNNN); refusing to touch any other device.');
    process.exit(2);
}
for (const u of [API, APP]) {
    if (!['127.0.0.1', 'localhost'].includes(new URL(u).hostname)) {
        console.error(`this creates accounts: API and APP must be loopback (${u})`);
        process.exit(2);
    }
}
const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const sh = (cmd) => adb('shell', cmd).toString('utf8');
const PKG = 'com.sovereign.app';
// Its own adb forward port: adb forwards are global, and other walks use theirs.
const CDP_PORT = Number(process.env.CDP_PORT || 9463);
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
/** A check that holds on this change and must NOT hold on the APK from before it. */
const want = (name, ok, detail) => (OLD
    ? check(`NEGATIVE CONTROL - fails on the APK from before the change: ${name}`, !ok, detail)
    : check(name, ok, detail));

const RECORDER = () => {
    if (window.__rec) return;
    window.__rec = { frames: [], typing: [], vis: [] };
    const Orig = window.WebSocket;
    window.WebSocket = class extends Orig {
        constructor(...a) {
            super(...a);
            this.addEventListener('message', (e) => {
                try {
                    const m = JSON.parse(e.data);
                    if (m.type !== 'Pong') window.__rec.frames.push({ t: Date.now(), type: m.type, hidden: document.visibilityState === 'hidden' });
                } catch { /* not JSON */ }
            });
            this.addEventListener('close', (e) => window.__rec.frames.push({ t: Date.now(), type: `(close ${e.code})` }));
        }
    };
    let last = null;
    const look = () => {
        const el = document.querySelector('.typing-indicator');
        const txt = el ? el.textContent : null;
        if (txt !== last) { window.__rec.typing.push({ t: Date.now(), txt }); last = txt; }
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
    document.addEventListener('visibilitychange', () => window.__rec.vis.push({ t: Date.now(), v: document.visibilityState }));
    for (const ev of ['freeze', 'resume']) document.addEventListener(ev, () => window.__rec.vis.push({ t: Date.now(), v: ev }));
};

let forwarded = false;
const browsers = [];
async function attach() {
    const pid = (await until(() => sh(`pidof ${PKG}`).trim(), 30000)) || '';
    await until(() => sh('cat /proc/net/unix').includes(`webview_devtools_remote_${pid}`), 30000);
    try { adb('forward', '--remove', `tcp:${CDP_PORT}`); } catch { /* none */ }
    adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);
    forwarded = true;
    const b = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`), 30000, 1000);
    browsers.push(b);
    const P = await until(() => b.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://localhost')), 30000);
    if (!P) throw new Error('the page of the app did not appear');
    return P;
}
async function detach() {
    for (const b of browsers.splice(0)) await b.close().catch(() => {});
}
const appInFront = () => /mCurrentFocus=.*com\.sovereign\.app/.test(sh('dumpsys window | grep mCurrentFocus'));

async function dismiss(page) {
    for (let i = 0; i < 3; i++) {
        let did = false;
        if (await page.locator('.recovery-confirm input[type="checkbox"]').count()) {
            await page.locator('.recovery-confirm input[type="checkbox"]').first().check().catch(() => {});
            await page.locator('.recovery-done-btn').first().click().catch(() => {});
            did = true;
        }
        if (await page.locator('.welcome-popup-close').count()) { await page.locator('.welcome-popup-close').first().click().catch(() => {}); did = true; }
        const later = page.getByRole('button', { name: 'Later', exact: true });
        if (await later.count()) { await later.first().click().catch(() => {}); did = true; }
        if (!did) return;
        await sleep(300);
    }
}
const api = (page, method, p, body) => page.evaluate(async ({ API, method, p, body }) => {
    const r = await fetch(API + p, { method, headers: { authorization: `Bearer ${localStorage.getItem('auth_token')}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status}`);
    return r.json();
}, { API, method, p, body });
const COMPOSER = 'form.message-form textarea';
async function typeFor(page, ms, text) {
    const box = page.locator(COMPOSER);
    const t0 = Date.now(); let i = 0;
    while (Date.now() - t0 < ms) { await box.pressSequentially(text[i % text.length]); i++; await sleep(250); }
}
const rec = (P) => P.evaluate(() => ({ ...window.__rec, now: Date.now() }));
const clearRec = (P) => P.evaluate(() => { for (const k of Object.keys(window.__rec)) window.__rec[k].length = 0; });
/** How long, in ms, the indicator was up between `from` and `to` (page clock). */
function shownFor(typing, from, to) {
    let total = 0;
    const before = typing.filter(x => x.t < from).pop();
    let since = before?.txt ? from : null;
    for (const x of typing.filter(x => x.t >= from && x.t <= to)) {
        if (x.txt && since === null) since = x.t;
        if (!x.txt && since !== null) { total += x.t - since; since = null; }
    }
    if (since !== null) total += to - since;
    return total;
}

const edge = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });
try {
    step('the app, fresh');
    const attached = execFileSync(ADB, ['devices'], { encoding: 'utf8' });
    if (!attached.split('\n').some(l => l.trim().startsWith(SERIAL) && /\bdevice\b/.test(l))) throw new Error(`${SERIAL} is not attached`);
    if (APK) {
        try { adb('uninstall', PKG); } catch { /* not installed */ }
        adb('install', APK);
    }
    sh(`pm clear ${PKG}`);
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh('cmd statusbar collapse');
    adb('reverse', `tcp:${new URL(API).port}`, `tcp:${new URL(API).port}`);
    sh(`am start -W -n ${PKG}/.MainActivity`);
    let P = await attach();
    await P.addInitScript(RECORDER);

    step('signing up on the phone, a server and a channel');
    await P.getByPlaceholder('Enter username').waitFor({ timeout: 90000 });
    await P.locator('.toggle-mode').click();
    await P.getByPlaceholder('Enter username').fill(`phone_${stamp}`);
    await P.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await P.locator('button.login-button[type="submit"]').click();
    await P.waitForURL('**/chat', { timeout: 90000 });
    await sleep(2500);
    await dismiss(P);
    const srv = await api(P, 'POST', '/servers', { name: 'Typing ' + stamp.slice(-4) });
    await api(P, 'POST', `/servers/${srv.id}/channels`, { name: 'talk', channel_type: 0 });
    const inv = await api(P, 'POST', `/servers/${srv.id}/invites`, {});

    step('the typer, on a desktop');
    const typerName = `typer_${stamp}`;
    const B = await (await edge.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await B.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await B.getByPlaceholder('Enter username').waitFor({ timeout: 90000 });
    await B.locator('.toggle-mode').click();
    await B.getByPlaceholder('Enter username').fill(typerName);
    await B.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await B.locator('button.login-button[type="submit"]').click();
    await B.waitForURL('**/chat', { timeout: 90000 });
    await sleep(1500);
    await dismiss(B);
    await api(B, 'POST', `/invites/${inv.code}/join`);
    await B.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(B);
    await B.locator(`.server-icon[data-server-id="${srv.id}"]`).first().click();
    await sleep(1200);
    await B.locator('.sidebar .channel-list .channel', { hasText: 'talk' }).first().click();
    await B.locator(COMPOSER).waitFor({ timeout: 15000 });

    step('the phone into #talk');
    await P.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3500);
    await dismiss(P);
    const header = async () => (await P.locator('.chat-header').first().textContent().catch(() => '')) || '';
    const nav = async (label) => { await P.locator('.mobile-nav-btn', { hasText: label }).first().click(); await sleep(900); };
    for (let i = 0; i < 3 && !/talk/.test(await header()); i++) {
        await nav('Servers');
        await P.locator(`.server-icon[data-server-id="${srv.id}"]`).first().click();
        await sleep(1200);
        await nav('Channels');
        await P.locator('.sidebar .channel-list .channel', { hasText: 'talk' }).first().click();
        await until(async () => /talk/.test(await header()), 4000, 200);
    }
    check('setup: the phone is in #talk, recording', await P.locator(COMPOSER).count() === 1 && /talk/.test(await P.locator('.chat-header').first().textContent().catch(() => '')) && await P.evaluate(() => !!window.__rec));
    check('setup: the typer is in #talk', /talk/.test(await B.locator('.chat-header').first().textContent().catch(() => '')));

    // ── live
    step('live');
    await clearRec(P);
    await typeFor(B, 4000, 'hello live ');
    const seen = await until(async () => (await rec(P)).typing.some(x => x.txt?.includes(typerName)), 4000);
    check(`live: POSITIVE CONTROL - the phone shows "${typerName} is typing" while they type`, !!seen);
    await B.locator(COMPOSER).press('Enter');
    await sleep(6500);
    {
        const r = await rec(P);
        const msgAt = r.frames.find(f => f.type === 'ChatMessage')?.t;
        const up = msgAt ? shownFor(r.typing, msgAt, r.now) : -1;
        want('live: once their message reaches the phone, the indicator is gone within 1 s', !!msgAt && up >= 0 && up <= 1000, { shownAfterMessageMs: up });
    }

    // ── away
    step('away: Home, 20 s; they type 7 s and send; back 1.5 s after');
    await clearRec(P);
    await detach();
    sh('input keyevent KEYCODE_HOME');
    await sleep(20000);
    check('away: PREMISE - the app is not in front', !appInFront());
    await typeFor(B, 7000, 'while you were away ');
    await B.locator(COMPOSER).press('Enter');
    await sleep(1500);
    sh(`am start -W -n ${PKG}/.MainActivity`);
    await until(() => appInFront(), 8000, 400);
    await sleep(6000);
    P = await attach();
    {
        const r = await rec(P);
        const back = r.vis.filter(v => v.v === 'visible').pop()?.t;
        const msg = r.frames.find(f => f.type === 'ChatMessage');
        const pings = r.frames.filter(f => f.type === 'UserTyping' && f.hidden).length;
        check('away: the app is back in front, visible', appInFront() && !!back, { vis: r.vis });
        check('away: PREMISE - their message and pings were handled while the page was hidden', msg?.hidden === true && pings >= 2, { msgHidden: msg?.hidden, pings });
        check('away: their message is on screen', await P.locator('.messages-container .message', { hasText: 'while you were away' }).count() > 0);
        const up = back ? shownFor(r.typing, back, r.now) : -1;
        want('away: after the return, nobody is said to be typing', up === 0, { shownAfterReturnMs: up, typing: r.typing.slice(-3) });
    }

    // ── again
    if (!OLD) {
        step('again: typing now, after the return');
        await clearRec(P);
        const t0 = await P.evaluate(() => Date.now());
        await typeFor(B, 4000, 'typing now ');
        await B.locator(COMPOSER).fill('');
        const shown = (await rec(P)).typing.find(x => x.txt?.includes(typerName));
        check('again: POSITIVE CONTROL - someone typing now is shown within 1.5 s', !!shown && shown.t - t0 <= 1500, { afterMs: shown ? shown.t - t0 : null });
        const gone = await until(async () => { const r = await rec(P); const l = r.typing.at(-1); return l && !l.txt ? l : null; }, 9000);
        const r = await rec(P);
        const lastPing = r.frames.filter(f => f.type === 'UserTyping').pop()?.t ?? 0;
        check('again: ...and goes 5 to 6.3 s after the last ping', !!gone && gone.t - lastPing >= 4900 && gone.t - lastPing <= 6300, { afterLastPingMs: gone ? gone.t - lastPing : null });
    }
} catch (e) {
    check('the walk ran to the end', false, String(e?.stack || e).slice(0, 800));
} finally {
    await detach();
    await edge.close().catch(() => {});
    if (forwarded) { try { adb('forward', '--remove', `tcp:${CDP_PORT}`); } catch { /* gone */ } }
}
console.log(`\n${failed} failure(s)`);
process.exit(failed);
