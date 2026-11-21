// LIVE: "X is typing…" names only people typing NOW, in the REAL web client
// through a real backend (components/typingIndicator.ts; the owner's report of
// 2026-11-21: "when on mobile if i switch app and then look at a chat it will
// usually say someone is still typing when they arent").
//
// The viewer is a 390x844 touch phone, the typer a 1280x800 desktop, both
// headless Edge (--mute-audio), every keystroke the typer's a real one into the
// real composer (a typing ping at most every 3 s, as the app sends them). A phone
// in the background is played on the viewer's page the way the Android app's
// WebView is for its first minute there (measured on the real APK: the page keeps
// running and handles every frame as it comes; android-typing-resume-live.mjs is
// that walk on the APK): `document.visibilityState` reads 'hidden' and
// `visibilitychange` fires, then 'visible' again on the way back.
//
// Each round prints PASS/FAIL; the exit code is the number of failures.
//   live    POSITIVE CONTROL: the viewer sees "<typer> is typing" while they
//           type; once their message reaches the viewer, the indicator is gone
//           within 1 s (it stayed up to 5 s under the message).
//   away    the viewer in the background; the typer types for 7 s and SENDS;
//           the viewer back 1.5 s after the message: the message is on screen
//           and nobody is typing (it said they were, for 3 s more). PREMISE: the
//           message was handled while the page was hidden.
//   room    someone typing in #talk is not named in #other, opened at once.
//   stop    CONTROL, the rule kept: typing with no message shows, and goes 5 s
//           after the last ping handled (at the next 1 s prune).
// OLD_APP= (a bundle built before this change, against the same API) runs the
// viewer of live, away and room on it as the NEGATIVE CONTROL: each must fail
// there, or the rounds above measured nothing.
//
// Needs: a THROWAWAY backend at API (APP_ENV=development, raised
// AUTH_RATE_LIMIT_PER_SECOND / _BURST, its own fresh database) and the web app
// of this tree at APP (vite with VITE_API_URL=API, or a built dist served by
// e2e/serve-dist.mjs). Nothing is played: no call is made and the browsers are
// muted. ~2 min (~3 with OLD_APP).
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5487 API=http://127.0.0.1:3047 [OLD_APP=http://127.0.0.1:5488] node e2e/typing-resume-live.mjs
import { chromium } from '@playwright/test';

const APP = (process.env.APP || 'http://127.0.0.1:5487').replace(/\/$/, '');
const API = (process.env.API || 'http://127.0.0.1:3047').replace(/\/$/, '');
const OLD_APP = (process.env.OLD_APP || '').replace(/\/$/, '');
for (const u of [APP, API, OLD_APP].filter(Boolean)) {
    if (!['127.0.0.1', 'localhost'].includes(new URL(u).hostname)) {
        console.error(`this creates accounts: every URL must be loopback (${u})`);
        process.exit(2);
    }
}
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(step); }
    return last;
}
let failures = 0;
const step = (what) => console.log(`--    ${what}`);
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
    if (!ok) failures++;
    return ok;
};

/** In the viewer, before any of the app's script: every frame its socket hands
 *  the page and every change of the indicator, on the page's clock; and the
 *  switch that sends the page to the background and back. */
const RECORDER = () => {
    window.__rec = { frames: [], typing: [] };
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
        }
    };
    let last = null;
    const look = () => {
        const el = document.querySelector('.typing-indicator');
        const txt = el ? el.textContent : null;
        if (txt !== last) { window.__rec.typing.push({ t: Date.now(), txt }); last = txt; }
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
    let hidden = false;
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
    window.__setHidden = (h) => { hidden = h; document.dispatchEvent(new Event('visibilitychange')); };
};

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

async function signUp(ctx, app, user, recorder) {
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log(`  [${user} pageerror]`, e.message.slice(0, 200)));
    if (recorder) await page.addInitScript(RECORDER);
    await page.goto(app + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 90000 });
    await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 90000 });
    await sleep(1500);
    await dismiss(page);
    return page;
}

const api = (page, method, p, body) => page.evaluate(async ({ API, method, p, body }) => {
    const r = await fetch(API + p, { method, headers: { authorization: `Bearer ${localStorage.getItem('auth_token')}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status}`);
    return r.json();
}, { API, method, p, body });

const COMPOSER = 'form.message-form textarea';

/** The desktop: a channel by its sidebar row. */
async function openOnDesktop(page, srvId, name) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(page);
    await page.locator(`.server-icon[data-server-id="${srvId}"]`).first().click();
    await sleep(1200);
    await page.locator('.sidebar .channel-list .channel', { hasText: name }).first().click();
    await page.locator(COMPOSER).waitFor({ timeout: 15000 });
    await sleep(800);
}

/** The phone: Servers, the server, Channels, the channel; real taps. */
async function openOnPhone(page, srvId, name, { reload = true } = {}) {
    if (reload) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(2500);
        await dismiss(page);
    }
    const nav = async (label) => { await page.locator('.mobile-nav-btn', { hasText: label }).first().tap(); await sleep(700); };
    await nav('Servers');
    await page.locator(`.server-icon[data-server-id="${srvId}"]`).first().tap();
    await sleep(1200);
    await nav('Channels');
    await page.locator('.sidebar .channel-list .channel', { hasText: name }).first().tap();
    await sleep(1500);
}

/** Keys into the typer's real composer for `ms`, one every 250 ms. */
async function typeFor(page, ms, text) {
    const box = page.locator(COMPOSER);
    const t0 = Date.now(); let i = 0;
    while (Date.now() - t0 < ms) { await box.pressSequentially(text[i % text.length]); i++; await sleep(250); }
}

const rec = (page) => page.evaluate(() => ({ ...window.__rec, now: Date.now() }));
const clearRec = (page) => page.evaluate(() => { window.__rec.frames.length = 0; window.__rec.typing.length = 0; });
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

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
try {
    step('two accounts, a server with two channels');
    const typerName = `typer_${stamp}`;
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const B = await signUp(ctxB, APP, typerName, false);
    const srv = await api(B, 'POST', '/servers', { name: 'Typing ' + stamp.slice(-4) });
    await api(B, 'POST', `/servers/${srv.id}/channels`, { name: 'talk', channel_type: 0 });
    await api(B, 'POST', `/servers/${srv.id}/channels`, { name: 'other', channel_type: 0 });
    const inv = await api(B, 'POST', `/servers/${srv.id}/invites`, {});
    await openOnDesktop(B, srv.id, 'talk');
    check('setup: the typer is in #talk', /talk/.test(await B.locator('.chat-header').first().textContent().catch(() => '')));

    /** Every round on one viewer. `fixed`: the change is in its bundle. */
    async function rounds(app, tag, fixed) {
        const ctx = await browser.newContext(phone);
        const V = await signUp(ctx, app, `${tag}_${stamp}`, true);
        await api(V, 'POST', `/invites/${inv.code}/join`);
        await openOnPhone(V, srv.id, 'talk');
        check(`${tag}: setup: the viewer is in #talk on the phone, recording`, await V.locator(COMPOSER).count() === 1 && /talk/.test(await V.locator('.chat-header').first().textContent().catch(() => '')) && await V.evaluate(() => !!window.__rec));
        const want = (name, ok, detail) => (fixed
            ? check(`${tag}: ${name}`, ok, detail)
            : check(`${tag}: NEGATIVE CONTROL - fails on the old bundle: ${name}`, !ok, detail));

        // ── live
        step(`${tag}: live`);
        await clearRec(V);
        await typeFor(B, 4000, 'hello live ');
        const seenLive = await until(async () => (await rec(V)).typing.some(x => x.txt?.includes(typerName)), 4000);
        check(`${tag}: live: POSITIVE CONTROL - the viewer sees "${typerName} is typing" while they type`, !!seenLive);
        await B.locator(COMPOSER).press('Enter');
        await sleep(6500);
        {
            const r = await rec(V);
            const msgAt = r.frames.find(f => f.type === 'ChatMessage')?.t;
            const up = msgAt ? shownFor(r.typing, msgAt, r.now) : -1;
            want('live: once their message arrives, the indicator is gone within 1 s', !!msgAt && up >= 0 && up <= 1000, { shownAfterMessageMs: up });
        }

        // ── away
        step(`${tag}: in the background while they type and send; back 1.5 s after`);
        await sleep(1000);
        await clearRec(V);
        await V.evaluate(() => window.__setHidden(true));
        await sleep(1500);
        await typeFor(B, 7000, 'while you were away ');
        await B.locator(COMPOSER).press('Enter');
        const msgSeen = await until(async () => (await rec(V)).frames.find(f => f.type === 'ChatMessage'), 10000);
        await sleep(1500);
        const backAt = await V.evaluate(() => { window.__setHidden(false); return Date.now(); });
        await sleep(5500);
        {
            const r = await rec(V);
            check(`${tag}: away: PREMISE - their message was handled while the page was hidden`, !!msgSeen && msgSeen.hidden === true, msgSeen || {});
            const pings = r.frames.filter(f => f.type === 'UserTyping' && f.hidden).length;
            check(`${tag}: away: PREMISE - their typing pings were too`, pings >= 2, { pings });
            check(`${tag}: away: their message is on screen after the return`, await V.locator('.messages-container .message', { hasText: 'while you were away' }).count() > 0);
            const up = shownFor(r.typing, backAt, r.now);
            want('away: after the return, nobody is said to be typing', up === 0, { shownAfterReturnMs: up });
        }

        // ── room
        step(`${tag}: room`);
        await sleep(5500);
        await clearRec(V);
        const typingRoom = typeFor(B, 3500, 'here ');
        await until(async () => (await rec(V)).typing.some(x => x.txt), 4000);
        await openOnPhone(V, srv.id, 'other', { reload: false });
        const inOther = await V.evaluate(() => Date.now());
        await typingRoom;
        await sleep(1500);
        {
            const r = await rec(V);
            const up = shownFor(r.typing, inOther, r.now);
            want('room: in #other, nobody typing in #talk is named', up === 0, { shownInOtherMs: up });
        }
        await B.locator(COMPOSER).fill('');
        await openOnPhone(V, srv.id, 'talk', { reload: false });
        await sleep(5500);

        if (!fixed) return;
        // ── stop
        step(`${tag}: stop`);
        await clearRec(V);
        const t0 = await V.evaluate(() => Date.now());
        await typeFor(B, 7000, 'typing now ');
        await B.locator(COMPOSER).fill('');
        const shown = (await rec(V)).typing.find(x => x.txt?.includes(typerName));
        check(`${tag}: stop: CONTROL - someone typing with no message is shown within 1 s of their first key`, !!shown && shown.t - t0 <= 1500, { afterMs: shown ? shown.t - t0 : null });
        const gone = await until(async () => { const r = await rec(V); const l = r.typing.at(-1); return l && !l.txt ? l : null; }, 8000);
        {
            const r = await rec(V);
            const lastPing = r.frames.filter(f => f.type === 'UserTyping').pop()?.t ?? 0;
            // Five seconds, then the next 1 s prune.
            check(`${tag}: stop: CONTROL - ...and goes 5 to 6.3 s after the last ping`, !!gone && gone.t - lastPing <= 6300 && gone.t - lastPing >= 4900, { afterLastPingMs: gone ? gone.t - lastPing : null });
        }
        await ctx.close();
    }

    await rounds(APP, 'app', true);
    if (OLD_APP) await rounds(OLD_APP, 'old', false);
} catch (e) {
    check('the walk ran to the end', false, String(e?.stack || e).slice(0, 800));
} finally {
    await browser.close();
}
console.log(`\n${failures} failure(s)`);
process.exit(failures);
