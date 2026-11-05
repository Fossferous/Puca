// LIVE: deleting a channel, a voice room or a collection while people are in it. Through a
// real backend and the BUILT bundle, real voice rooms (mesh), every frame each page received
// read off its socket, and what the SERVER says about each account afterwards.
//
// What the server says: a fresh socket that announces `own_voice` is sent, at connect, the
// voice room this ACCOUNT is in (OwnVoiceState.room_id, from the same room map a kick and a
// disband empty; src/ws.rs, current_voice_room / push_own_voice_state). That is the backend's
// own membership and not any page's idea of it, and it does not need the channel to exist
// (GET /servers/:id/voice-users lists only channels still in the database, so after a delete it
// says nothing). On the LiveKit rig the answer is LiveKit's own ListParticipants.
//
//   A voice room deleted under a call (mesh), by someone else and by the one in it:
//     every call in it ends and says the room is no longer available, once; the server has
//     nobody of theirs in the room; CONTROLS: a call in ANOTHER room of the same server goes on,
//     with nothing said and the server still having them there; a call on a different server
//     hears nothing and goes on.
//   A client that does not end its own call (OLD_APP, a build from before the delete reached
//     other servers' calls, looking at another server): the server ends it. This is the gap:
//     without it the call stays in the server's room map, and goes on, for good.
//   A collection holding a voice room with people in it; the main voice channel of a mode that
//     is on (the mode stays on, with no main channel); a card table open in the room (the table
//     ends, and its players are taken out of the call with it).
//   LK_API (a loopback-only LiveKit the backend is pointed at): the same on sfu_mode rooms,
//     asking LiveKit who is in each; a device asleep through it (its sockets cut, its LiveKit
//     session alive, as a phone that lost its connection mid-call) is cut by the server: its call
//     ends, it cannot be told why, and on waking it shows no bare refusal.
//
// The checks are run against the old server too (see below): the ones that name the gap must
// fail there, which is the reproduction this walk was written from. LIVE_MS is how long a push
// gets; STAY_MS is how long a call that was NOT taken out is watched for, to say how long it stays.
//
// Each check prints PASS/FAIL; the exit code is the number of failures. Screenshots go to
// OUT (SHOT <file>).
//
// Prereqs: as e2e/server-gone-live.mjs: a THROWAWAY backend (APP_ENV=development, raised
// AUTH_RATE_LIMIT_PER_SECOND / _BURST, its own fresh database, never a real one) at API, a build
// against it served at APP (VITE_API_URL=$API npx vite build --outDir <dir> --emptyOutDir, then
// DIST=<dir> PORT=<port> node e2e/serve-dist.mjs), and for OLD_APP a build of an older tree
// against the same API. It refuses to start unless everything is loopback: it creates accounts.
// Silent: --mute-audio and fake media devices. LK_API needs that backend's LIVEKIT_* pointing
// at a loopback-only LiveKit (config in share-adapt-shaped.mjs's header, plus a webhook to
// API/livekit/webhook; check its sockets, a firewall prompt is what a mistake there costs) and
// LK_KEY / LK_SECRET. About 6 minutes.
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5479 API=http://127.0.0.1:5478 OUT=<dir> [OLD_APP=http://127.0.0.1:5480] [LK_API=... LK_KEY=... LK_SECRET=...] node e2e/channel-gone-live.mjs
import { chromium } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const APP = (process.env.APP || '').replace(/\/$/, '');
const API = (process.env.API || '').replace(/\/$/, '');
const OLD_APP = (process.env.OLD_APP || '').replace(/\/$/, '');
const OUT = process.env.OUT || 'e2e/shots-channel-gone';
const LIVE_MS = Number(process.env.LIVE_MS || 5000);
const SFU_ONLY = process.env.SFU_ONLY === '1';
const isLoopback = (url) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; } };
const LK = process.env.LK_API && process.env.LK_KEY && process.env.LK_SECRET
    ? { api: process.env.LK_API, key: process.env.LK_KEY, secret: process.env.LK_SECRET } : null;
if (!isLoopback(APP) || !isLoopback(API) || (OLD_APP && !isLoopback(OLD_APP)) || (LK && !isLoopback(LK.api))) {
    console.error(`this walk creates accounts: APP, API and OLD_APP must all be loopback (APP=${APP} API=${API} OLD_APP=${OLD_APP})`);
    process.exit(2);
}
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  -- ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = LIVE_MS, step = 100) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
        try { last = await fn(); if (last) return last; } catch { /* retry */ }
        await sleep(step);
    }
    return last;
}
const shot = async (page, name) => {
    const f = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: f });
    console.log('SHOT', f);
};

const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

/** Everything each page was sent and sent itself, off its own sockets, and every native dialog it raised. */
const received = new Map();
const sentBy = new Map();
const raised = new Map();
function watch(page, tag) {
    received.set(tag, []);
    sentBy.set(tag, []);
    raised.set(tag, []);
    const heard = (into) => (f) => {
        try {
            const raw = typeof f.payload === 'string' ? f.payload : f.payload.toString();
            into.get(tag).push({ at: Date.now(), type: JSON.parse(raw).type, raw });
        } catch { /* not JSON: nothing here asks about it */ }
    };
    page.on('websocket', ws => {
        ws.on('framereceived', heard(received));
        ws.on('framesent', heard(sentBy));
    });
    page.on('console', m => fs.appendFileSync(path.join(OUT, 'console.txt'), `${new Date().toISOString()} ${tag} ${m.type()} ${m.text().slice(0, 400)}\n`));
    page.on('pageerror', e => { check(`${tag}: no uncaught page error`, false, e.message.slice(0, 200)); });
    page.on('dialog', d => {
        raised.get(tag).push({ at: Date.now(), kind: d.type(), text: d.message() });
        d.type() === 'confirm' ? d.accept().catch(() => {}) : d.dismiss().catch(() => {});
    });
}
const framesSince = (tag, at, type) => received.get(tag).filter(f => f.at >= at && (!type || f.type === type));
const framesSince2 = (tag, at) => sentBy.get(tag).filter(f => f.at >= at).map(f => `${f.at - at} ${f.raw.slice(0, 90)}`);
const alertsSince = (tag, at) => raised.get(tag).filter(d => d.at >= at && d.kind !== 'confirm').map(d => d.text);

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

async function makeContext(desktop = true) {
    const ctx = await browser.newContext(desktop
        ? { viewport: { width: 1280, height: 800 } }
        : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    // A socket the walk can hold down, as a device asleep through the frame.
    await ctx.addInitScript((apiHost) => {
        window.__sgSockets = [];
        const Orig = window.WebSocket;
        window.WebSocket = class extends Orig {
            constructor(url, protocols) {
                const api = String(url).includes(apiHost);
                super(api && window.__sgAsleep ? 'ws://127.0.0.1:9/' : url, protocols);
                if (api) window.__sgSockets.push(this);
            }
        };
    }, new URL(API).host);
    // Toasts and notices come and go: every one that was ever on the page, and when.
    await ctx.addInitScript(() => {
        window.__said = [];
        const SEL = '.app-toast-text, .app-notice-text';
        new MutationObserver(muts => {
            for (const m of muts) for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                for (const el of [n, ...n.querySelectorAll(SEL)]) {
                    if (el.matches?.(SEL)) window.__said.push({ at: Date.now(), notice: el.matches('.app-notice-text'), text: el.textContent });
                }
            }
        }).observe(document, { subtree: true, childList: true });
    });
    return ctx;
}

async function signIn(ctx, base, user, tag, registerFirst) {
    const page = await ctx.newPage();
    watch(page, tag);
    await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
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

/** The API, as the signed-in page: the built bundle has no modules to import. */
const api = (page, method, p, body) => page.evaluate(async ({ API, method, p, body }) => {
    const r = await fetch(API + p, {
        method,
        headers: { authorization: `Bearer ${localStorage.getItem('auth_token')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
}, { API, method, p, body });

/** A server with one text channel and one voice room, its members joined by invite. */
async function makeServer(owner, name, members = []) {
    const srv = await api(owner, 'POST', '/servers', { name });
    const rows = await api(owner, 'GET', `/servers/${srv.id}/channels`);
    const text = rows.find(c => c.channel_type === 0);
    const voice = rows.find(c => c.channel_type === 1) ?? await api(owner, 'POST', `/servers/${srv.id}/channels`, { name: 'Room', channel_type: 1 });
    if (members.length) {
        const inv = await api(owner, 'POST', `/servers/${srv.id}/invites`, {});
        for (const m of members) await api(m, 'POST', `/invites/${inv.code}/join`);
    }
    return { id: srv.id, name, text: text.name, textId: text.id, voice: voice.name, voiceId: voice.id };
}

const icon = (page, name) => page.locator(`.server-icon[title="${name}"]`);
const header = (page) => page.locator('.chat-header').first().innerText({ timeout: 800 }).catch(() => '');
const composer = (page) => page.locator('textarea.message-textarea');
const words = (page) => composer(page).first().inputValue({ timeout: 800 }).catch(() => null);
const onHome = async (page) => (await page.locator('.friends-dashboard').count()) > 0;
const inCall = async (page) => (await page.locator('.voice-panel-compact .voice-connected-label').count()) > 0;
const said = (page, since) => page.evaluate((since) => window.__said.filter(s => s.at >= since), since);
const toastSays = async (page, since, text) => (await said(page, since)).some(s => !s.notice && s.text.includes(text));
const noticeSays = async (page, since, ...texts) => (await said(page, since)).some(s => s.notice && texts.every(t => s.text.includes(t)));
/** Whatever was said, it never read as a kick or a ban, or as being refused entry. */
const neverKicked = async (page, since) => !(await said(page, since)).some(s => /kick|\bban|removed you|removed from|not a member|not in this room/i.test(s.text));

async function goTo(page, srv, phone) {
    if (phone) {
        await page.locator('.mobile-nav-btn').first().tap();
        await sleep(400);
        await icon(page, srv.name).tap();
        await until(async () => (await page.locator('.server-header .server-name').first().innerText({ timeout: 500 })) === srv.name, 8000);
        // The phone lands on the channel list; the chat is one tap further.
        const row = page.locator('.sidebar .channel-list:not(.voice-channel-list) .channel').filter({ has: page.locator(`.channel-name:text-is("${srv.text}")`) });
        await row.first().tap({ timeout: 6000 });
    } else {
        await icon(page, srv.name).click();
    }
    const there = await until(async () => (await header(page)).includes(srv.text) && (await page.locator('.server-header .server-name').first().innerText({ timeout: 500 })) === srv.name, 8000);
    if (!there) throw new Error(`could not open ${srv.name}: header "${await header(page)}"`);
}

async function join(page, srv, phone) {
    const row = page.locator(`[data-testid="voice-channel"][data-channel-id="${srv.voiceId}"]`);
    if (phone) {
        await page.locator('.mobile-nav-btn').nth(1).tap().catch(() => {});
        await sleep(300);
        await row.tap({ timeout: 8000 });
    } else {
        await row.click({ timeout: 8000 });
    }
    if (!await until(() => inCall(page), 25000)) throw new Error(`could not join ${srv.name}'s room`);
    if (phone) {
        // Back to something other than the panel: the frame must reach whatever is showing.
        await sleep(200);
    }
}

/** A press in the real rail menu, answered by the confirm it asks. */
async function press(page, srv, label) {
    await icon(page, srv.name).click({ button: 'right' });
    const item = page.locator('.context-menu-item', { hasText: label }).first();
    await item.waitFor({ timeout: 6000 });
    await item.click();
}

async function fresh(...pages) {
    for (const page of pages) {
        await page.reload({ waitUntil: 'domcontentloaded' });
    }
    await sleep(2200);
    for (const page of pages) {
        await dismiss(page);
        await page.locator('.app-notice-close').first().click({ timeout: 300 }).catch(() => {});
    }
}

/** Inbound audio bytes on this page's mesh connections, to see a call still carrying. */
const audioIn = (page) => page.evaluate(async () => {
    if (typeof window.__pucaMeshDiag !== 'function') return null;
    const diag = await window.__pucaMeshDiag();
    return (diag || []).flatMap(p => p.rtp || []).filter(r => r.dir === 'inbound-rtp' && r.kind === 'audio').reduce((a, r) => a + (r.bytes || 0), 0);
});
/** Who the server has in its rooms. */
const inRoom = async (page, srv, uid) => {
    const list = await api(page, 'GET', `/servers/${srv.id}/voice-users`).catch(() => null);
    return !!(list?.voice_users ?? []).find(r => r.room_id === `voice_${srv.voiceId}` && r.user_id === uid);
};

/** Who LiveKit itself says is in a channel's room. A query it refuses throws: it cannot read as nobody. */
async function lkPeople(channelId) {
    const room = `sfu_${channelId}`;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: LK.key, sub: 'server-gone-walk', nbf: now - 5, exp: now + 300, video: { roomAdmin: true, roomList: true, room } })}`;
    const jwt = `${body}.${crypto.createHmac('sha256', LK.secret).update(body).digest('base64url')}`;
    const r = await fetch(`${LK.api}/twirp/livekit.RoomService/ListParticipants`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ room }),
    });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`ListParticipants ${room}: ${r.status}`);
    return ((await r.json()).participants || []).map(p => p.identity);
}
const hasUser = (people, uid) => people.some(i => i.startsWith(`u${uid}#`));


// ── What the server says ───────────────────────────────────────────────────────────

const WS_BASE = API.replace(/^http/, 'ws') + '/ws';
const STAY_MS = Number(process.env.STAY_MS || 12000);
const tokenOf = (page) => page.evaluate(() => localStorage.getItem('auth_token'));

/** A socket of the walk's own, speaking the protocol as the client does: no page, no reaction. */
function openRaw(token) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${WS_BASE}?caps=own_voice,presence,games&kind=browser`, ['bearer', token]);
        const frames = [];
        ws.onmessage = (e) => { try { frames.push({ at: Date.now(), ...JSON.parse(e.data) }); } catch { /* not JSON */ } };
        ws.onopen = () => resolve({ ws, frames, send: (m) => ws.send(JSON.stringify(m)), close: () => { try { ws.close(); } catch { /* gone */ } } });
        ws.onerror = () => reject(new Error("the walk's own socket could not connect"));
    });
}

/** Which voice room the server has this ACCOUNT in. Throws when it cannot ask: that cannot read as "none". */
async function roomOf(token) {
    const s = await openRaw(token);
    try {
        const f = await until(() => s.frames.find(x => x.type === 'OwnVoiceState'), 4000, 25);
        if (!f) throw new Error('no OwnVoiceState arrived on a fresh socket');
        return f.payload.room_id ?? null;
    } finally { s.close(); }
}
/** How long until the server has this account out of every voice room, from `since`; null if it never does in `ms`. */
async function emptiedAfter(token, since, ms = LIVE_MS) {
    const done = await until(async () => (await roomOf(token)) === null, ms, 60);
    return done ? Date.now() - since : null;
}
/** A call the walk expects to be taken out is watched for STAY_MS: how long it stays, or that it did not. */
async function stays(label, token, room) {
    const t0 = Date.now();
    const gone = await until(async () => (await roomOf(token)) !== room, STAY_MS, 500);
    console.log(`INFO  ${label}: ${gone ? `out of ${room} after ${((Date.now() - t0) / 1000).toFixed(1)} s` : `STILL in ${room} on the server ${(STAY_MS / 1000).toFixed(0)} s later`}`);
    return !!gone;
}

async function joinChannel(page, channelId, phone) {
    const row = page.locator(`[data-testid="voice-channel"][data-channel-id="${channelId}"]`);
    if (phone) {
        await page.locator('.mobile-nav-btn').nth(1).tap().catch(() => {});
        await sleep(300);
        await row.tap({ timeout: 8000 });
    } else {
        await row.click({ timeout: 8000 });
    }
    if (!await until(() => inCall(page), 25000)) throw new Error(`could not join channel ${channelId}`);
}
const makeVoice = (owner, srv, name, parent) => api(owner, 'POST', `/servers/${srv.id}/channels`, { name, channel_type: 1, ...(parent ? { parent_id: parent } : {}) });
const hangUp = async (...pages) => {
    for (const p of pages) await p.locator('[data-testid="voice-leave"]').first().click({ timeout: 2500 }).catch(() => {});
    await sleep(400);
};
/** The room-is-gone words, as the client says them. */
const goneWords = (name) => `${name} is no longer available, so you left its call`;
const toasts = async (page, since) => (await said(page, since)).filter(s => !s.notice);

const SUFFIX = '_' + stamp;
try {
    const ctxO = await makeContext(), ctxM = await makeContext(), ctxP = await makeContext(), ctxX = await makeContext(), ctxQ = await makeContext(false);
    const O = await signIn(ctxO, APP, 'cdo' + SUFFIX, 'OWNER', true);
    const M = await signIn(ctxM, APP, 'cdm' + SUFFIX, 'MEMBER', true);
    const P = await signIn(ctxP, APP, 'cdp' + SUFFIX, 'SIDE', true);
    const X = await signIn(ctxX, APP, 'cdx' + SUFFIX, 'X', true);
    const Q = await signIn(ctxQ, APP, 'cdq' + SUFFIX, 'PHONE', true);
    const whoAmI = (page) => page.evaluate(() => JSON.parse(atob(localStorage.getItem('auth_token').split('.')[1])).sub);
    const tok = { O: await tokenOf(O), M: await tokenOf(M), P: await tokenOf(P), X: await tokenOf(X), Q: await tokenOf(Q) };
    let OP = null, tokOP = null;
    if (OLD_APP) {
        OP = await signIn(await makeContext(), OLD_APP, 'cdold' + SUFFIX, 'OLD-PC', true);
        tokOP = await tokenOf(OP);
    }
    const outside = await makeServer(X, 'cdout' + SUFFIX);
    const members = OP ? [M, P, Q, OP] : [M, P, Q];

    // ── A voice room deleted under a call (mesh) ─────────────────────────────────────
    if (!SFU_ONLY) {
        const srv = await makeServer(O, 'cdA' + SUFFIX, members);
        const side = await makeVoice(O, srv, 'Side');
        await fresh(O, M, P, X);
        await goTo(O, srv); await goTo(M, srv); await goTo(P, srv); await goTo(X, outside);
        await join(O, srv); await join(M, srv);
        await joinChannel(P, side.id);
        await join(X, outside);
        const room = `voice_${srv.voiceId}`;
        check('fixture: the server has both in the room, one in the side room, one on another server',
            (await roomOf(tok.O)) === room && (await roomOf(tok.M)) === room && (await roomOf(tok.P)) === `voice_${side.id}` && (await roomOf(tok.X)) === `voice_${outside.voiceId}`);
        const at = Date.now();
        await api(O, 'DELETE', `/channels/${srv.voiceId}`);
        const mine = await emptiedAfter(tok.M, at);
        const theirs = await emptiedAfter(tok.O, at);
        console.log(`INFO  deleted under two calls: the server had the member out after ${mine} ms and the deleter after ${theirs} ms`);
        check('delete: the server has the member out of the room', mine !== null, mine);
        check('delete: and the one who pressed Delete', theirs !== null, theirs);
        check('delete: the member\'s call ends', !!await until(async () => !(await inCall(M))), await inCall(M));
        check('delete: and says so, once', !!await until(() => toastSays(M, at, goneWords(srv.voice))) && (await toasts(M, at)).length === 1, await said(M, at));
        check('delete: the deleter\'s call ends too', !!await until(async () => !(await inCall(O))), await inCall(O));
        check('delete: nothing says they were removed', await neverKicked(M, at) && await neverKicked(O, at), [await said(M, at), await said(O, at)]);
        check('delete: no error on either page', alertsSince('MEMBER', at).length === 0 && alertsSince('OWNER', at).length === 0, [alertsSince('MEMBER', at), alertsSince('OWNER', at)]);
        await shot(M, '01-delete-voice-member');
        check('control: the side room of the same server keeps its person, per the server', (await roomOf(tok.P)) === `voice_${side.id}`, await roomOf(tok.P));
        check('control: and their call goes on with nothing said', (await inCall(P)) && (await said(P, at)).length === 0, await said(P, at));
        check('control: a call on a different server goes on, per the server', (await roomOf(tok.X)) === `voice_${outside.voiceId}` && await inCall(X), await roomOf(tok.X));
        check('control: and heard nothing of it', !framesSince('X', at).some(f => f.raw.includes(srv.id)) && (await said(X, at)).length === 0, await said(X, at));
        await goTo(M, srv);
        await composer(M).fill('still here ' + stamp);
        await composer(M).press('Enter');
        check('control: the server still carries messages', !!await until(async () => (await O.locator('.messages-container').innerText().catch(() => '')).includes('still here ' + stamp), 8000));
        await hangUp(P, X);
    }

    // ── A client that does not end its own call ──────────────────────────────────────
    if (!SFU_ONLY && OP) {
        const srv = await makeServer(O, 'cdB' + SUFFIX, [M, OP]);
        const keep = await makeServer(O, 'cdBkeep' + SUFFIX, [OP]);
        await fresh(O, M, OP);
        await goTo(O, srv); await goTo(M, srv); await goTo(OP, srv);
        await join(O, srv); await join(M, srv); await join(OP, srv);
        await goTo(OP, keep); // looking at another server: this build does not end a call on one it is not looking at
        const room = `voice_${srv.voiceId}`;
        check('old client, fixture: the server has it in the room, and it is looking elsewhere', (await roomOf(tokOP)) === room && await inCall(OP) && (await header(OP)).includes(keep.text), [await roomOf(tokOP), await header(OP)]);
        const at = Date.now();
        await api(O, 'DELETE', `/channels/${srv.voiceId}`);
        check('old client, delete: the current clients\' calls end', !!await until(async () => !(await inCall(M)) && !(await inCall(O))));
        const out = await emptiedAfter(tokOP, at);
        console.log(`INFO  old client: the server had it out ${out === null ? 'never within ' + LIVE_MS + ' ms' : 'after ' + out + ' ms'}`);
        check('old client, delete: the server takes it out of the room', out !== null, await roomOf(tokOP));
        check('old client, delete: its call ends', !!await until(async () => !(await inCall(OP))), await inCall(OP));
        if (out === null) await stays('old client', tokOP, room);
        await sleep(1200);
        check('old client, delete: it stays where it was, and nothing bare is left on its screen', (await header(OP)).includes(keep.text) && await neverKicked(OP, at), [await header(OP), await said(OP, at)]);
        check('old client, delete: no error', alertsSince('OLD-PC', at).length === 0, alertsSince('OLD-PC', at));
        await shot(OP, '02-delete-old-client');
    }

    // ── A collection holding a voice room with people in it ──────────────────────────
    if (!SFU_ONLY) {
        const srv = await makeServer(O, 'cdC' + SUFFIX, members);
        const keep = OP ? await makeServer(O, 'cdCkeep' + SUFFIX, [OP]) : null;
        const coll = await api(O, 'POST', `/servers/${srv.id}/channels`, { name: 'Rooms', channel_type: 2 });
        const inside = await makeVoice(O, srv, 'Inside', coll.id);
        const beside = await makeVoice(O, srv, 'Beside');
        await fresh(O, M, P, ...(OP ? [OP] : []));
        await goTo(O, srv); await goTo(M, srv); await goTo(P, srv);
        await joinChannel(M, inside.id);
        await joinChannel(P, beside.id);
        if (OP) { await goTo(OP, srv); await joinChannel(OP, inside.id); await goTo(OP, keep); }
        const room = `voice_${inside.id}`;
        check('collection, fixture: the server has them in the room under it', (await roomOf(tok.M)) === room && (!OP || (await roomOf(tokOP)) === room));
        const at = Date.now();
        await api(O, 'DELETE', `/channels/${coll.id}`);
        check('collection: the server has the member out of the room under it', (await emptiedAfter(tok.M, at)) !== null, await roomOf(tok.M));
        check('collection: their call ends and says so', !!await until(async () => !(await inCall(M)) && await toastSays(M, at, goneWords('Inside'))), await said(M, at));
        if (OP) {
            check('collection, old client: the server has it out too', (await emptiedAfter(tokOP, at)) !== null, await roomOf(tokOP));
            check('collection, old client: its call ends', !!await until(async () => !(await inCall(OP))), await inCall(OP));
        }
        check('control: a room beside the collection keeps its person', (await roomOf(tok.P)) === `voice_${beside.id}` && await inCall(P), await roomOf(tok.P));
        await hangUp(P);
    }

    // ── The main voice channel of a mode that is on ───────────────────────────────────
    if (!SFU_ONLY) {
        const srv = await makeServer(O, 'cdM' + SUFFIX, [M, P]);
        const spare = await makeVoice(O, srv, 'Spare');
        const mode = await api(O, 'POST', `/servers/${srv.id}/modes`, { name: 'Game', channel_ids: [srv.voiceId, spare.id], home_channel_id: srv.voiceId });
        await api(O, 'PUT', `/servers/${srv.id}/modes/active`, { mode_id: mode.id });
        await fresh(O, M, P);
        await goTo(O, srv); await goTo(M, srv); await goTo(P, srv);
        await join(O, srv); await join(M, srv);
        await joinChannel(P, spare.id);
        const at = Date.now();
        await api(O, 'DELETE', `/channels/${srv.voiceId}`);
        check('mode main channel: the server has both out of it', (await emptiedAfter(tok.M, at)) !== null && (await emptiedAfter(tok.O, at)) !== null, [await roomOf(tok.M), await roomOf(tok.O)]);
        check('mode main channel: their calls end', !!await until(async () => !(await inCall(M)) && !(await inCall(O))));
        const modes = await api(O, 'GET', `/servers/${srv.id}/modes`);
        const list = Array.isArray(modes) ? modes : (modes.modes ?? []);
        const again = list.find(m => m.id === mode.id);
        check('mode main channel: the mode is still there, with no main channel', !!again && !again.home_channel_id, again);
        const rows = await api(O, 'GET', '/servers');
        const row = (Array.isArray(rows) ? rows : []).find(s => s.id === srv.id);
        check('mode main channel: and still on', row?.active_mode_id === mode.id, row?.active_mode_id);
        check('mode main channel: every member heard the mode was edited', framesSince('MEMBER', at, 'ServerModesEdited').some(f => f.raw.includes(srv.id)), framesSince('MEMBER', at).map(f => f.type));
        check('mode main channel, control: the other room of the mode keeps its person', (await roomOf(tok.P)) === `voice_${spare.id}` && await inCall(P), await roomOf(tok.P));
        check('mode main channel: no error', alertsSince('MEMBER', at).length === 0 && alertsSince('OWNER', at).length === 0);
        await hangUp(P);
    }

    // ── A card table open in the room ────────────────────────────────────────────────
    if (!SFU_ONLY) {
        const srv = await makeServer(O, 'cdG' + SUFFIX, [P]);
        const room = `voice_${srv.voiceId}`;
        const seat = await openRaw(tok.P);
        seat.send({ type: 'JoinRoom', payload: { room_id: room } });
        await until(() => seat.frames.some(f => f.type === 'RoomJoined' && f.payload?.room_id === room), 6000, 50);
        seat.send({ type: 'GameCreate', payload: { room_id: room, kind: 'holdem', config: null } });
        const opened = await until(() => seat.frames.some(f => f.type.startsWith('Game')), 6000, 50);
        check('card table, fixture: the table opened and the server has its player in the room', !!opened && (await roomOf(tok.P)) === room, [seat.frames.map(f => f.type).slice(-6), await roomOf(tok.P)]);
        const at = Date.now();
        await api(O, 'DELETE', `/channels/${srv.voiceId}`);
        check('card table: the player is told the table ended, because the channel is gone', !!await until(() => seat.frames.some(f => f.at >= at && f.type === 'GameEnded' && JSON.stringify(f.payload).includes('channel_deleted'))), seat.frames.filter(f => f.at >= at).map(f => f.type));
        check('card table: and the server takes the player out of the call with it', (await emptiedAfter(tok.P, at)) !== null, await roomOf(tok.P));
        check('card table: they are sent the RoomLeft', !!await until(() => seat.frames.some(f => f.at >= at && f.type === 'RoomLeft' && f.payload?.room_id === room), 2000), seat.frames.filter(f => f.at >= at).map(f => f.type));
        seat.close();
    }

    // ── The same on LiveKit, which keeps its own list ─────────────────────────────────
    if (LK) {
        const ids = { O: await whoAmI(O), M: await whoAmI(M), P: await whoAmI(P), X: await whoAmI(X), Q: await whoAmI(Q) };
        const sfuOn = (id) => api(O, 'PATCH', `/channels/${id}`, { sfu_mode: true });
        const elsewhere = await makeServer(X, 'cdsfuOut' + SUFFIX);
        await api(X, 'PATCH', `/channels/${elsewhere.voiceId}`, { sfu_mode: true });
        const srv = await makeServer(O, 'cdS' + SUFFIX, members);
        const side = await makeVoice(O, srv, 'Side');
        await sfuOn(srv.voiceId); await sfuOn(side.id);
        const keep = OP ? await makeServer(O, 'cdSkeep' + SUFFIX, [OP]) : null;
        await fresh(O, M, P, X, Q, ...(OP ? [OP] : []));
        await goTo(O, srv); await goTo(M, srv); await goTo(P, srv); await goTo(Q, srv, true); await goTo(X, elsewhere);
        await join(O, srv); await join(M, srv); await joinChannel(P, side.id); await join(X, elsewhere); await join(Q, srv, true);
        if (OP) { await goTo(OP, srv); await join(OP, srv); await goTo(OP, keep); }
        const everyone = [ids.O, ids.M, ids.Q];
        check('sfu, fixture: LiveKit has them all in the room', !!await until(async () => {
            const people = await lkPeople(srv.voiceId);
            return everyone.every(u => hasUser(people, u));
        }, 25000), await lkPeople(srv.voiceId));
        if (OP) check('sfu, fixture: and the old client', hasUser(await lkPeople(srv.voiceId), await whoAmI(OP)), await lkPeople(srv.voiceId));
        // A phone that lost its connection mid-call: the page's sockets to the API cut, its LiveKit session alive.
        await Q.evaluate(() => { window.__sgAsleep = true; for (const s of window.__sgSockets) s.close(); });
        await sleep(1000);
        const at = Date.now();
        await api(O, 'DELETE', `/channels/${srv.voiceId}`);
        check('sfu, delete: the member\'s call ends and says so', !!await until(async () => !(await inCall(M)) && await toastSays(M, at, goneWords(srv.voice)), 8000), await said(M, at));
        check('sfu, delete: LiveKit has the member and the deleter out', !!await until(async () => { const p = await lkPeople(srv.voiceId); return !hasUser(p, ids.M) && !hasUser(p, ids.O); }, 10000), await lkPeople(srv.voiceId));
        check('sfu, delete: and the phone that was cut off, which can hear nothing', !!await until(async () => !hasUser(await lkPeople(srv.voiceId), ids.Q), 10000), await lkPeople(srv.voiceId));
        if (OP) {
            const oldId = await whoAmI(OP);
            check('sfu, old client, delete: LiveKit has it out', !!await until(async () => !hasUser(await lkPeople(srv.voiceId), oldId), 10000), await lkPeople(srv.voiceId));
            check('sfu, old client, delete: and its call ends', !!await until(async () => !(await inCall(OP)), 6000), await inCall(OP));
            if (hasUser(await lkPeople(srv.voiceId), oldId)) {
                const t0 = Date.now();
                const gone = await until(async () => !hasUser(await lkPeople(srv.voiceId), oldId), STAY_MS, 1000);
                console.log(`INFO  sfu, old client: ${gone ? 'out of LiveKit after ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s' : 'STILL in LiveKit ' + (STAY_MS / 1000) + ' s later'}`);
            }
        }
        check('sfu control: the side room keeps its person, per LiveKit', hasUser(await lkPeople(side.id), ids.P), await lkPeople(side.id));
        check("sfu control: and another server's room keeps its person", hasUser(await lkPeople(elsewhere.voiceId), ids.X), await lkPeople(elsewhere.voiceId));
        check('sfu control: both calls go on, with nothing said', (await inCall(P)) && (await inCall(X)) && (await said(P, at)).length === 0 && (await said(X, at)).length === 0, [await said(P, at), await said(X, at)]);
        await shot(M, '03-sfu-delete-member');
        // The phone wakes. The cut ended its call (LiveKit told it, PARTICIPANT_REMOVED) while its
        // sockets were down, so there is no call for the room-is-gone replay to refuse: it has
        // nothing to say, and must not say anything wrong.
        const wake = Date.now();
        await Q.evaluate(() => { window.__sgAsleep = false; });
        check('sfu, asleep, on waking: its call is over', !!await until(async () => !(await inCall(Q)), 30000), await inCall(Q));
        await sleep(3000);
        console.log(`INFO  sfu, asleep: said ${JSON.stringify((await said(Q, at)).map(s => s.text))} between the delete and ${Date.now() - wake} ms after waking`);
        check('sfu, asleep, on waking: nothing reads as a kick or a bare refusal', await neverKicked(Q, at), await said(Q, at));
        await hangUp(P, X);
    } else {
        console.log('INFO  LK_API not set: the calls here were all mesh');
    }
    if (!OLD_APP) console.log('INFO  OLD_APP not set: the older client was not walked');
} catch (e) {
    check('the walk ran to the end', false, String(e?.stack || e).slice(0, 800));
} finally {
    await browser.close();
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures);
