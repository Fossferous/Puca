// LIVE: "You're in <channel> on your PC" — Leave / Move here, with ONE account
// signed in on two devices (a desktop context and a 390x844 touch phone
// context) and a second account in the call.
//
// What it proves, against a REAL backend + the REAL web client:
//   1. the phone, sitting on the DM home screen, shows the banner while the
//      PC is in a mesh call (OwnVoiceState reaches every screen);
//   2. Leave on the phone ends the PC's call: the PC's voice panel goes, it
//      says why, and the server's voice list no longer has the account;
//   3. Move here on the phone moves a call the second account is in: the PC
//      says "You moved the call to your phone", the phone is connected, the
//      server's voice list holds the account exactly once, and the second
//      account's mesh peer for the account is CONNECTED again on a NEW
//      connection id with inbound audio packets growing (getStats, never
//      playback — the browser runs with --mute-audio);
//   4. the PC's own banner then offers the call back, and Move here on the PC
//      moves it back;
//   5. SFU (when LK_* is set): the phone tapping the SAME voice channel the PC
//      is in moves the call (no dual connection), and LiveKit's own
//      participant list holds exactly ONE session of the account — the
//      phone's — next to the second account's;
//   6. voice exclusivity: the PC joining ANOTHER channel takes the phone out
//      with a notice too;
//   7. the PC "sleeps" (its socket is closed and held down, so it is out of
//      the room but the phone is told only after the 8 s rejoin grace):
//      Move here, then Leave, pressed on the phone inside that grace. When
//      the PC's socket comes back, its replayed join is refused - it shows
//      the notice instead of rejoining next to the phone (or with an open
//      mic after Leave), and its media re-claim raises no alert().
// Each check is a PASS/FAIL line; the exit code is the number of failures.
// Screenshots of the banner (phone and desktop) go to OUT.
//
// Prereqs: a throwaway backend (APP_ENV=development, raised AUTH_RATE_LIMIT_*)
// at API and vite of this tree at APP with VITE_API_URL=API. For step 5 a
// loopback-only LiveKit (see the livekit-local-rig notes: rtc.tcp_port 0) with
// the backend's LIVEKIT_* pointing at it, and LK_API / LK_KEY / LK_SECRET here.
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5422 API=http://127.0.0.1:5322 OUT=<dir> \
//   [LK_API=http://127.0.0.1:7892 LK_KEY=... LK_SECRET=...] node e2e/own-voice-2device.mjs
import { chromium } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP || 'http://127.0.0.1:5422';
const OUT = process.env.OUT || '.';
const LK = process.env.LK_API && process.env.LK_KEY && process.env.LK_SECRET
    ? { api: process.env.LK_API, key: process.env.LK_KEY, secret: process.env.LK_SECRET } : null;
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const AUSER = 'ova_' + stamp;
const BUSER = 'ovb_' + stamp;

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '  -- ' + extra}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 250) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
        try { last = await fn(); if (last) return last; } catch { /* retry */ }
        await sleep(step);
    }
    return last;
}

function lkToken(room) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: LK.key, sub: 'own-voice-check', nbf: now - 5, exp: now + 300, video: { roomAdmin: true, roomList: true, room } })}`;
    return `${body}.${crypto.createHmac('sha256', LK.secret).update(body).digest('base64url')}`;
}
async function lkParticipants(room) {
    const r = await fetch(`${LK.api}/twirp/livekit.RoomService/ListParticipants`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${lkToken(room)}` },
        body: JSON.stringify({ room }),
    });
    if (!r.ok) return { error: r.status };
    return ((await r.json()).participants || []).map(p => p.identity);
}

const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

const consoleErrors = [];
function watch(page, tag) {
    // Every console line of every device, timestamped, for diagnosing a failed run.
    page.on('console', m => fs.appendFileSync(path.join(OUT, 'console.txt'), `${new Date().toISOString()} ${tag} ${m.type()} ${m.text().slice(0, 400)}
`));
    page.on('pageerror', e => { consoleErrors.push(`${tag} pageerror ${e.message}`); console.log(`  [${tag} pageerror]`, e.message.slice(0, 200)); });
    page.on('dialog', d => { consoleErrors.push(`${tag} dialog ${d.message()}`); console.log(`  [${tag} DIALOG]`, d.message()); d.dismiss().catch(() => {}); });
}

/** Overlays that arrive on their own timers and swallow clicks. */
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

async function signIn(ctx, user, tag, registerFirst) {
    const page = await ctx.newPage();
    watch(page, tag);
    await page.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 60000 });
    if (registerFirst) await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder(registerFirst ? 'Choose a password (min 8 characters)' : 'Enter password').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 60000 });
    await sleep(1500);
    await dismiss(page);
    return page;
}

const call = (page, mod, fn, args = []) => page.evaluate(async ({ mod, fn, args }) => {
    const m = await import(mod);
    return m[fn](...args);
}, { mod, fn, args });

const toastSeen = (page, text) => until(async () => (await page.locator('body').innerText()).includes(text), 8000);
// In a call = the panel's connected branch is rendered (the label is in the DOM;
// the phone's collapsed bar hides it with CSS, so visibility would lie there).
const inCallLoc = (page) => page.locator('.voice-panel-compact .voice-connected-label');
const inCall = (page) => ({ isVisible: async () => (await inCallLoc(page).count()) > 0 });
const banner = (page) => page.locator('.own-voice-banner');

async function openServer(page, name, phone) {
    if (phone) {
        await page.locator('.mobile-nav-btn').first().tap();
        await sleep(400);
        await page.locator(`.server-icon[title="${name}"]`).tap();
    } else {
        await page.locator(`.server-icon[title="${name}"]`).click();
    }
    await sleep(800);
}
async function clickVoice(page, name, phone) {
    const row = page.locator('.voice-channel-list .voice-channel', { hasText: name }).first();
    if (phone) await row.tap(); else await row.click();
}
async function voiceList(page, serverId) {
    const r = await call(page, '/src/api/servers.ts', 'fetchVoiceUsers', [serverId]);
    return r;
}
/** How many entries the account has in that voice channel, per the server's own list. */
function occupants(list, channelId, uid) {
    const rows = list?.voice_users ?? [];
    return { n: rows.filter(r => r.room_id === `voice_${channelId}` && r.user_id === uid).length, json: JSON.stringify(rows) };
}
async function meshPeer(page, uid) {
    const diag = await page.evaluate(async () => await window.__pucaMeshDiag());
    const peer = (diag || []).find(p => p.userId === uid);
    if (!peer) return null;
    const audioIn = (peer.rtp || []).filter(r => r.dir === 'inbound-rtp' && r.kind === 'audio').reduce((a, r) => a + (r.bytes || 0), 0);
    return { connId: peer.connId, connection: peer.connection, audioIn };
}

/** The banner is on screen, inside the viewport, above the phone's bottom nav,
 *  its buttons are what a tap at their centre hits, and at least 44px tall. */
async function bannerGeometry(page, phone) {
    return page.evaluate((phone) => {
        const b = document.querySelector('.own-voice-banner');
        if (!b) return { ok: false, why: 'no banner' };
        const r = b.getBoundingClientRect();
        const vw = document.documentElement.clientWidth, vh = window.innerHeight;
        const inView = r.left >= 0 && r.right <= vw + 0.5 && r.top >= 0 && r.bottom <= vh + 0.5 && r.height > 0;
        const nav = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect();
        const aboveNav = !phone || !nav || r.bottom <= nav.top + 0.5;
        const buttons = [...b.querySelectorAll('button')].map(btn => {
            const br = btn.getBoundingClientRect();
            const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
            return { text: btn.textContent.trim(), h: Math.round(br.height), hits: !!hit && btn.contains(hit) };
        });
        const tall = !phone || buttons.every(x => x.h >= 44);
        const noHScroll = document.documentElement.scrollWidth <= vw;
        return { ok: inView && aboveNav && tall && buttons.every(x => x.hits) && noHScroll, inView, aboveNav, tall, noHScroll, buttons, text: b.textContent };
    }, phone);
}

try {
    const pcCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // Step 7's "sleep": every socket the PC opens to the API is remembered,
    // and while __ovBlockWs is set a new one goes to a closed port (its
    // reconnects fail until the flag is cleared). Only the API's sockets:
    // vite's HMR socket reloads the whole page when it is cut.
    await pcCtx.addInitScript((apiHost) => {
        const Orig = window.WebSocket;
        window.__ovSockets = [];
        window.WebSocket = class extends Orig {
            constructor(url, protocols) {
                const api = String(url).includes(apiHost);
                super(api && window.__ovBlockWs ? 'ws://127.0.0.1:9/' : url, protocols);
                if (api) window.__ovSockets.push(this);
            }
        };
    }, new URL(process.env.API || 'http://127.0.0.1:5322').host);
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const bCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    const pc = await signIn(pcCtx, AUSER, 'PC', true);
    const b = await signIn(bCtx, BUSER, 'B', true);
    const phone = await signIn(phoneCtx, AUSER, 'PHONE', false);

    // The server, a mesh channel, an SFU channel; B joins by invite.
    const srvName = 'OV ' + stamp.slice(-4);
    const srv = await call(pc, '/src/api/servers.ts', 'createServer', [srvName]);
    const lounge = await call(pc, '/src/api/servers.ts', 'createChannel', [srv.id, 'Lounge', 1]);
    const stage = await call(pc, '/src/api/servers.ts', 'createChannel', [srv.id, 'Stage', 1]);
    if (LK) await call(pc, '/src/api/servers.ts', 'updateChannel', [stage.id, { sfu_mode: true }]);
    const inv = await call(pc, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);
    await call(b, '/src/api/servers.ts', 'joinViaInvite', [inv.code]);
    check('fixture: server, two voice channels, B a member', !!srv.id && !!lounge.id && !!stage.id && !!inv.code);

    for (const p of [pc, b, phone]) { await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500); await dismiss(p); }
    const uidOf = async (p) => p.evaluate(() => {
        try { const t = localStorage.getItem('auth_token') || ''; return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { return null; }
    });
    const A = await uidOf(pc);
    const B = await uidOf(b);
    check('fixture: both account ids read', Number.isInteger(A) && Number.isInteger(B) && A !== B, `${A} ${B}`);

    // ── 1. PC joins Lounge; the phone, on its DM home screen, shows the banner.
    await phone.locator('.mobile-nav-btn').first().tap();
    await sleep(400);
    await phone.locator('.server-icon.home-button').tap();
    await sleep(800);
    await openServer(pc, srvName, false);
    await clickVoice(pc, 'Lounge', false);
    check('PC is in the Lounge call', !!await until(() => inCall(pc).isVisible(), 20000));
    const shown = await until(() => banner(phone).isVisible(), 10000);
    check('phone (DM home screen) shows the banner', !!shown);
    const t1 = shown ? await banner(phone).innerText() : '';
    check('banner names the channel and the device', /You're in Lounge in a browser/.test(t1) && t1.includes(srvName), JSON.stringify(t1));
    const g1 = await bannerGeometry(phone, true);
    check('banner at 390x844: in view, above the nav, 44px buttons that a tap hits, no sideways scroll', g1.ok, JSON.stringify(g1));
    await phone.screenshot({ path: path.join(OUT, 'phone-banner-home.png') });
    check('the PC itself shows no banner (the call is here)', !(await banner(pc).isVisible()));

    // ── 2. Leave on the phone ends the PC's call.
    await banner(phone).getByRole('button', { name: 'Leave' }).tap();
    check('PC voice panel gone after Leave', !!await until(async () => !(await inCall(pc).isVisible()), 10000));
    check('PC says why: "You left voice from your phone"', !!await toastSeen(pc, 'You left voice from your phone'));
    check('phone banner gone', !!await until(async () => !(await banner(phone).isVisible()), 8000));
    const v2 = occupants(await voiceList(b, srv.id), lounge.id, A);
    check('server voice list: the account is out of Lounge', v2.n === 0, v2.json);

    // ── 3. B and the PC in Lounge; Move here on the phone.
    await openServer(b, srvName, false);
    await clickVoice(b, 'Lounge', false);
    check('B is in the Lounge call', !!await until(() => inCall(b).isVisible(), 20000));
    await clickVoice(pc, 'Lounge', false);
    check('PC rejoined Lounge by a deliberate click', !!await until(() => inCall(pc).isVisible(), 20000));
    const before = await until(async () => { const m = await meshPeer(b, A); return m && m.connection === 'connected' && m.audioIn > 0 ? m : null; }, 30000, 500);
    check('control: B\'s mesh peer for the account is connected with audio arriving (from the PC)', !!before, JSON.stringify(before));

    await until(() => banner(phone).isVisible(), 10000);
    await banner(phone).getByRole('button', { name: 'Move here' }).tap();
    check('PC voice panel gone', !!await until(async () => !(await inCall(pc).isVisible()), 15000));
    check('PC says "You moved the call to your phone"', !!await toastSeen(pc, 'You moved the call to your phone'));
    check('phone is connected after Move here', !!await until(() => inCall(phone).isVisible(), 25000));
    const after = await until(async () => {
        const m = await meshPeer(b, A);
        return m && m.connection === 'connected' && before && m.connId !== before.connId ? m : null;
    }, 30000, 500);
    check('B\'s mesh peer for the account is connected again, on a NEW connection (the phone)', !!after, JSON.stringify(after));
    const a1 = after?.audioIn ?? 0;
    await sleep(3000);
    const a2 = (await meshPeer(b, A))?.audioIn ?? 0;
    check('...and audio packets from the phone keep arriving at B (getStats, nothing played)', a2 > a1 && a1 > 0, `${a1} -> ${a2}`);
    const v3 = occupants(await voiceList(b, srv.id), lounge.id, A);
    check('server voice list: the account is in Lounge exactly once', v3.n === 1, v3.json);
    check('B is still in the call', await inCall(b).isVisible());

    // ── 4. The desktop banner, and Move here back to the PC.
    const deskBanner = await until(() => banner(pc).isVisible(), 10000);
    check('PC now shows the banner: the call is on the phone', !!deskBanner);
    const t4 = deskBanner ? await banner(pc).innerText() : '';
    check('desktop banner text', /You're in Lounge on your phone/.test(t4), JSON.stringify(t4));
    const g4 = await bannerGeometry(pc, false);
    check('desktop banner: in view, buttons hit', g4.ok, JSON.stringify(g4));
    // A Range over the label's text reports one rect per line box (the span
    // itself is a flex item and always reports one - proven by a control).
    const oneLine = await pc.evaluate(() => [...document.querySelectorAll('.own-voice-banner button')].map(b => {
        if (!b.lastElementChild) return 0;
        const r = document.createRange();
        r.selectNodeContents(b.lastElementChild);
        return r.getClientRects().length;
    }));
    check('desktop banner: both labels on one line in the 240px sidebar', oneLine.length === 2 && oneLine.every(n => n === 1), JSON.stringify(oneLine));
    await pc.screenshot({ path: path.join(OUT, 'desktop-banner.png') });
    await banner(pc).getByRole('button', { name: 'Move here' }).click();
    check('PC connected again after its own Move here', !!await until(() => inCall(pc).isVisible(), 25000));
    check('phone dropped, saying "You moved the call to a browser"', !!await until(async () => !(await inCall(phone).isVisible()), 10000) && !!await toastSeen(phone, 'You moved the call to a browser'));
    const v4 = occupants(await voiceList(b, srv.id), lounge.id, A);
    check('server voice list: still exactly once', v4.n === 1, v4.json);

    // ── 5. SFU: the phone taps the SAME channel the PC is in.
    if (LK) {
        await clickVoice(pc, 'Stage', false);
        check('PC moved itself to Stage (SFU)', !!await until(async () => (await pc.locator('.voice-panel-compact').innerText()).includes('Stage') && await inCall(pc).isVisible(), 25000));
        await clickVoice(b, 'Stage', false);
        check('B is in Stage', !!await until(async () => (await b.locator('.voice-panel-compact').innerText()).includes('Stage') && await inCall(b).isVisible(), 25000));
        const room = `sfu_${stage.id}`;
        const lk1 = await until(async () => { const ids = await lkParticipants(room); return Array.isArray(ids) && ids.filter(i => i.startsWith(`u${A}#`)).length === 1 && ids.some(i => i.startsWith(`u${B}#`)) ? ids : null; }, 30000, 1000);
        check('control: LiveKit has one session of the account (the PC) and B\'s', !!lk1, JSON.stringify(lk1));
        await openServer(phone, srvName, true);
        await sleep(600);
        const onChannels = await until(() => banner(phone).isVisible(), 10000);
        const gc = await bannerGeometry(phone, true);
        check('phone channel list: the banner is there too, clear of the nav, buttons hit', !!onChannels && gc.ok && /You're in Stage/.test(gc.text || ''), JSON.stringify(gc));
        const stageRowHit = await phone.evaluate(() => {
            const row = [...document.querySelectorAll('.voice-channel-list .voice-channel')].find(r => r.textContent.includes('Stage'));
            if (!row) return false;
            const r = row.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!hit && row.contains(hit);
        });
        check('the channel row is not covered by the banner (a tap reaches it)', stageRowHit);
        await phone.screenshot({ path: path.join(OUT, 'phone-banner-channels.png') });
        await clickVoice(phone, 'Stage', true);
        check('PC dropped out of Stage with the notice', !!await until(async () => !(await inCall(pc).isVisible()), 15000) && !!await toastSeen(pc, 'You moved the call to your phone'));
        check('phone connected to Stage', !!await until(async () => await inCall(phone).isVisible(), 30000));
        check('no dual connection: the phone joined with take_over, the PC is not in voice', !(await inCall(pc).isVisible()));
        const phoneIdentity = await phone.evaluate(async () => (await import('/src/api/rtc/sfuManager.ts')).sfuManager?.room?.localParticipant?.identity ?? null);
        const lk2 = await until(async () => {
            const ids = await lkParticipants(room);
            const mine = Array.isArray(ids) ? ids.filter(i => i.startsWith(`u${A}#`)) : [];
            return mine.length === 1 && mine[0] === phoneIdentity && ids.some(i => i.startsWith(`u${B}#`)) ? ids : null;
        }, 30000, 1000);
        check('LiveKit: exactly ONE session of the account - the phone\'s - next to B\'s', !!lk2, JSON.stringify({ phoneIdentity, now: await lkParticipants(room) }));
        const v5 = occupants(await voiceList(b, srv.id), stage.id, A);
        check('server voice list: the account is in Stage exactly once', v5.n === 1, v5.json);
        await phone.screenshot({ path: path.join(OUT, 'phone-in-call-after-move.png') });

        // ── 6. Exclusivity: the PC joins ANOTHER channel; the phone is told.
        await clickVoice(pc, 'Lounge', false);
        check('PC joined Lounge', !!await until(async () => (await pc.locator('.voice-panel-compact').innerText()).includes('Lounge') && await inCall(pc).isVisible(), 25000));
        check('phone dropped out of Stage with a notice', !!await until(async () => !(await inCall(phone).isVisible()), 15000) && !!await toastSeen(phone, 'You moved the call to a browser'));
        const lk3 = await until(async () => { const ids = await lkParticipants(room); return Array.isArray(ids) && !ids.some(i => i.startsWith(`u${A}#`)) ? ids : null; }, 30000, 1000);
        check('LiveKit: the phone\'s Stage session is gone', !!lk3, JSON.stringify(await lkParticipants(room)));
    } else {
        console.log('SKIP  SFU steps (LK_API / LK_KEY / LK_SECRET not set)');
    }

    // ── 7. The PC sleeps through a Move here, then through a Leave.
    const sleepPc = () => pc.evaluate(() => {
        window.__ovBlockWs = true;
        window.__ovMark = 'asleep'; // a page reload would lose this
        let closed = 0;
        for (const s of window.__ovSockets) if (s.readyState <= 1) { s.close(); closed++; }
        return closed;
    });
    const wakePc = () => pc.evaluate(() => { window.__ovBlockWs = false; });
    const bPanel = async () => (await b.locator('.voice-panel-compact').count()) ? await b.locator('.voice-panel-compact').innerText() : '';
    if (!(await bPanel()).includes('Lounge') || !(await inCall(b).isVisible())) await clickVoice(b, 'Lounge', false);
    check('7: B is in Lounge', !!await until(async () => (await bPanel()).includes('Lounge') && await inCall(b).isVisible(), 25000));
    if (!(await inCall(pc).isVisible())) await clickVoice(pc, 'Lounge', false);
    check('7: the PC is in Lounge', !!await until(() => inCall(pc).isVisible(), 25000));
    const pcPeer = await until(async () => { const m = await meshPeer(b, A); return m && m.connection === 'connected' && m.audioIn > 0 ? m : null; }, 30000, 500);
    check('7: control: B hears the PC (mesh connected, audio arriving)', !!pcPeer, JSON.stringify(pcPeer));
    await until(() => banner(phone).isVisible(), 10000);
    // Let step 5's notice on the PC (a 5 s toast) expire, so 7a's is its own.
    await until(async () => !(await pc.locator('body').innerText()).includes('You moved the call to your phone'), 15000);

    // 7a. Move here while the PC's socket is down (inside the rejoin grace).
    check('7a: the PC API socket is closed and held down', (await sleepPc()) === 1);
    await sleep(1200);
    const stillOffered = await banner(phone).isVisible();
    check('7a: inside the grace the phone still offers the call', stillOffered);
    await banner(phone).getByRole('button', { name: 'Move here' }).tap();
    check('7a: phone connected after Move here', !!await until(() => inCall(phone).isVisible(), 25000));
    await sleep(2000);
    check('7a: control: no stale notice on the PC before it wakes', !(await pc.locator('body').innerText()).includes('You moved the call to your phone'));
    check('7a: control: the PC page was not reloaded and still holds the call while asleep', (await pc.evaluate(() => window.__ovMark)) === 'asleep' && await inCall(pc).isVisible());
    await wakePc();
    check('7a: the woken PC drops the call with "You moved the call to your phone"', !!await until(async () => !(await inCall(pc).isVisible()), 45000) && !!await toastSeen(pc, 'You moved the call to your phone'));
    await sleep(3000);
    const v7a = occupants(await voiceList(b, srv.id), lounge.id, A);
    check('7a: server voice list: the account is in Lounge exactly once (the phone), the PC did not rejoin', v7a.n === 1 && !(await inCall(pc).isVisible()), v7a.json);
    const phonePeer = await until(async () => {
        const m = await meshPeer(b, A);
        return m && m.connection === 'connected' && m.connId !== pcPeer?.connId ? m : null;
    }, 30000, 500);
    const pa1 = phonePeer?.audioIn ?? 0;
    await sleep(3000);
    const pa2 = (await meshPeer(b, A))?.audioIn ?? 0;
    check('7a: B is connected to the phone, audio arriving (getStats, nothing played)', !!phonePeer && pa2 > pa1, `${JSON.stringify(phonePeer)} ${pa1} -> ${pa2}`);

    // 7b. The PC takes the call back by a click, sleeps, and the phone presses Leave.
    await clickVoice(pc, 'Lounge', false);
    check('7b: the PC took the call back by a deliberate click', !!await until(() => inCall(pc).isVisible(), 25000) && !!await until(async () => !(await inCall(phone).isVisible()), 15000));
    await until(() => banner(phone).isVisible(), 10000);
    check('7b: the PC API socket is closed and held down', (await sleepPc()) === 1);
    await sleep(1200);
    check('7b: inside the grace the phone still offers Leave', await banner(phone).isVisible());
    await banner(phone).getByRole('button', { name: 'Leave' }).tap();
    await sleep(2000);
    check('7b: control: no stale notice on the PC before it wakes', !(await pc.locator('body').innerText()).includes('You left voice from your phone'));
    check('7b: control: the PC page was not reloaded and still holds the call while asleep', (await pc.evaluate(() => window.__ovMark)) === 'asleep' && await inCall(pc).isVisible());
    await wakePc();
    check('7b: the woken PC drops the call with "You left voice from your phone"', !!await until(async () => !(await inCall(pc).isVisible()), 45000) && !!await toastSeen(pc, 'You left voice from your phone'));
    await sleep(3000);
    const v7b = occupants(await voiceList(b, srv.id), lounge.id, A);
    check('7b: server voice list: the account is out of Lounge - the PC did not rejoin with an open mic', v7b.n === 0 && !(await inCall(pc).isVisible()), v7b.json);

    check('no page errors and no alert() dialogs on any device', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
    console.log('FAIL  harness threw:', e?.stack || e);
    failures++;
} finally {
    await browser.close();
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
fs.writeFileSync(path.join(OUT, 'own-voice-2device.result'), failures === 0 ? 'ALL PASS\n' : `${failures} FAILURE(S)\n`);
process.exit(failures);
