// LIVE: a server going away reaches everyone it concerns with no reload: its owner
// disbanding it reaches every member, and a member leaving it reaches that member's
// other devices. Through a real backend and the BUILT bundle, real rail menus, real
// voice rooms (mesh), every frame each page received read off its socket.
//
//   Disband, seen by another member:
//     on screen with words in the box: gone from the rail, on the home page, the words
//     in a notice, and it says the owner disbanded it, never that they were kicked;
//     in a call on it, on screen or while looking at another server: the call ends and
//     says why, and what they were looking at and writing over there stays;
//     CONTROLS: a call on the owner's OTHER server goes on, with audio still arriving,
//     and that server is still there and still carries messages; a member of a
//     different server hears nothing about any of it.
//   Leave, seen by the same account on another device (a 390x844 phone):
//     the same four, saying they left on another device; the device that pressed goes
//     on to its next server and says nothing;
//     CONTROLS: the people left on the server stay where they are, their call goes on,
//     the phone's call on another server goes on.
//   OLD_APP (a bundle built before this change, against the same API): an older client
//     on this server copes: it drops the server, keeps the words, a call ends with it,
//     a call elsewhere goes on, its own Leave and Disband work and raise no error.
//   LK_API (a loopback-only LiveKit the backend is pointed at): the same on sfu_mode
//     rooms, asking LiveKit's own ListParticipants who is in each (SFU_ONLY=1 runs just that).
//   A device asleep through the frame, on waking: the server goes, the call says the
//     room is gone, and no bare "Not a member" is left on its screen.
//
// The checks are run against the old server too (see below): every "live" one must fail
// there, which is the reproduction this walk was written from. LIVE_MS is how long a
// push gets; nothing here refreshes the list by itself in that time.
//
// Each check prints PASS/FAIL; the exit code is the number of failures. Screenshots go to
// OUT (SHOT <file>).
//
// Prereqs: a THROWAWAY backend (APP_ENV=development, raised AUTH_RATE_LIMIT_PER_SECOND /
// _BURST, its own fresh database, never a real one) at API, and a build against it,
// served at APP:
//   VITE_API_URL=$API npx vite build --outDir <dir> --emptyOutDir
//   DIST=<dir> PORT=<port> node e2e/serve-dist.mjs
// It refuses to start unless everything is loopback: it creates accounts. Silent:
// --mute-audio and fake media devices. Without LK_API the calls are all mesh. About 5
// minutes. LK_API needs that backend's LIVEKIT_* pointing at a loopback-only LiveKit (config
// in share-adapt-shaped.mjs's header, plus a webhook to API/livekit/webhook; check its
// sockets, a firewall prompt is what a mistake there costs) and LK_KEY / LK_SECRET.
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5479 API=http://127.0.0.1:5478 OUT=<dir> [OLD_APP=http://127.0.0.1:5480] [LK_API=... LK_KEY=... LK_SECRET=...] node e2e/server-gone-live.mjs
import { chromium } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const APP = (process.env.APP || '').replace(/\/$/, '');
const API = (process.env.API || '').replace(/\/$/, '');
const OLD_APP = (process.env.OLD_APP || '').replace(/\/$/, '');
const OUT = process.env.OUT || 'e2e/shots-server-gone';
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

/** A member of a different server heard nothing of it, and nothing moved. */
async function outsiderUndisturbed(outsider, at, srv, home, text) {
    const leak = framesSince('X', at).filter(f => f.type === 'RemovedFromServer' || f.raw.includes(srv.id));
    check(`a member of a different server is sent nothing about ${srv.name}`, leak.length === 0, leak.map(f => f.raw.slice(0, 120)));
    check('and nothing moved there: same channel, same words, nothing said',
        (await header(outsider)).includes(home.text) && (await words(outsider)) === text && (await said(outsider, at)).length === 0,
        [await header(outsider), await words(outsider), await said(outsider, at)]);
}

const SUFFIX = '_' + stamp;
try {
    const ownerName = 'sgo' + SUFFIX, memberName = 'sgm' + SUFFIX, outsiderName = 'sgx' + SUFFIX;
    const ctxO = await makeContext(), ctxM1 = await makeContext(), ctxM2 = await makeContext(false), ctxX = await makeContext();
    const O = await signIn(ctxO, APP, ownerName, 'OWNER', true);
    const M1 = await signIn(ctxM1, APP, memberName, 'MEMBER-PC', true);
    const M2 = await signIn(ctxM2, APP, memberName, 'MEMBER-PHONE', false);
    const X = await signIn(ctxX, APP, outsiderName, 'X', true);
    const whoAmI = (page) => page.evaluate(() => JSON.parse(atob(localStorage.getItem('auth_token').split('.')[1])).sub);
    const memberId = await whoAmI(M1);

    const keep = await makeServer(O, 'keep' + SUFFIX, [M1]);
    const outside = await makeServer(X, 'outside' + SUFFIX);
    const OUTSIDER_WORDS = 'the outsider is writing this';

    // ── Disband: on screen, words in the box ──────────────────────────────────────
    if (!SFU_ONLY) {
        const doom = await makeServer(O, 'doomA' + SUFFIX, [M1]);
        await fresh(O, M1, M2, X);
        await goTo(O, doom);
        await goTo(M1, doom);
        await goTo(M2, keep, true);
        await goTo(X, outside);
        await composer(M1).fill('written for doomA');
        await composer(M2).fill('the phone is writing to keep');
        await composer(O).fill('the owner was writing this');
        await composer(X).fill(OUTSIDER_WORDS);
        const at = Date.now();
        await press(O, doom, 'Disband Server');

        check('disband: a member looking at it loses it from the rail, live', !!await until(async () => (await icon(M1, doom.name).count()) === 0), await icon(M1, doom.name).count());
        check('disband: and is on the home page, not a channel of it', !!await until(() => onHome(M1)), await header(M1));
        check('disband: it says the owner disbanded it', !!await until(() => toastSays(M1, at, `${doom.name} was disbanded by its owner`)), await said(M1, at));
        check('disband: what they were writing is in a notice, and says where', !!await until(() => noticeSays(M1, at, '#' + doom.text, 'written for doomA')), await said(M1, at));
        check('disband: nothing reads as a kick', await neverKicked(M1, at), await said(M1, at));
        check('disband: the frame said why', framesSince('MEMBER-PC', at, 'RemovedFromServer').some(f => f.raw.includes(doom.id) && f.raw.includes('"reason":"disbanded"')), framesSince('MEMBER-PC', at, 'RemovedFromServer').map(f => f.raw));
        await shot(M1, '01-disband-member-on-screen');

        check('disband, own press: the owner goes on to their other server', !!await until(async () => (await header(O)).includes(keep.text) && (await icon(O, doom.name).count()) === 0), await header(O));
        check('disband, own press: what they were writing is in a notice', !!await until(() => noticeSays(O, at, 'the owner was writing this')), await said(O, at));
        check('disband, own press: the box they land on is empty', (await words(O)) === '', await words(O));
        check('disband, own press: nothing tells them what they just did', !await toastSays(O, at, 'disbanded'), await said(O, at));
        check('disband, own press: no error', alertsSince('OWNER', at).length === 0, alertsSince('OWNER', at));
        check('control: the owner\'s other server is still in their rail', (await icon(O, keep.name).count()) === 1);

        check('disband, the member\'s phone on another server: gone from its rail too', !!await until(async () => (await icon(M2, doom.name).count()) === 0), await icon(M2, doom.name).count());
        check('disband, the member\'s phone: still where it was, the words still there', (await header(M2)).includes(keep.text) && (await words(M2)) === 'the phone is writing to keep', [await header(M2), await words(M2)]);
        await outsiderUndisturbed(X, at, doom, outside, OUTSIDER_WORDS);

        // The box is empty, and the server they still have works.
        await goTo(M1, keep);
        check('disband: the next channel\'s box is empty', (await words(M1)) === '', await words(M1));
        await composer(M1).fill('still here ' + stamp);
        await composer(M1).press('Enter');
        check('control: the server they still have carries a message, end to end', !!await until(async () => (await O.locator('.messages-container').innerText()).includes('still here ' + stamp), 8000));
        await composer(M2).fill('');
    }

    // ── Disband: in a call on it ──────────────────────────────────────────────────
    if (!SFU_ONLY) {
        const doom = await makeServer(O, 'doomB' + SUFFIX, [M1]);
        await fresh(O, M1, M2, X);
        await goTo(O, doom);
        await goTo(M1, doom);
        await goTo(X, outside);
        await composer(X).fill(OUTSIDER_WORDS);
        await join(O, doom);
        await join(M1, doom);
        check('fixture: both are in the room, per the server', !!await until(() => inRoom(O, doom, memberId), 8000));
        const at = Date.now();
        await press(O, doom, 'Disband Server');
        check('disband, in a call on it: the call ends', !!await until(async () => !(await inCall(M1))), await inCall(M1));
        check('disband, in a call on it: and it says why', !!await until(() => toastSays(M1, at, `${doom.name} was disbanded by its owner, so this call ended`)), await said(M1, at));
        check('disband, in a call on it: one thing said, not two', (await said(M1, at)).filter(s => !s.notice).length === 1, await said(M1, at));
        check('disband, in a call on it: on the home page', !!await until(() => onHome(M1)));
        check('disband, in a call on it: nothing reads as a kick', await neverKicked(M1, at), await said(M1, at));
        check('disband, own press in the call: the owner\'s call ends too', !!await until(async () => !(await inCall(O))), await inCall(O));
        check('disband, own press in the call: and no toast tells them why', !await toastSays(O, at, 'this call ended'), await said(O, at));
        await shot(M1, '02-disband-member-in-call');
        await outsiderUndisturbed(X, at, doom, outside, OUTSIDER_WORDS);
    }

    // ── Disband: in a call on it, looking at another server ───────────────────────
    if (!SFU_ONLY) {
        const doom = await makeServer(O, 'doomC' + SUFFIX, [M1]);
        await fresh(O, M1, M2);
        await goTo(O, doom);
        await goTo(M1, doom);
        await join(M1, doom);
        await goTo(M1, keep);
        check('control: looking at another server keeps the call', await inCall(M1));
        await composer(M1).fill('written for keep');
        const at = Date.now();
        await press(O, doom, 'Disband Server');
        check('disband, a call on it from another server: the call ends', !!await until(async () => !(await inCall(M1))), await inCall(M1));
        check('disband, a call on it from another server: and it says why', !!await until(() => toastSays(M1, at, `${doom.name} was disbanded by its owner, so this call ended`)), await said(M1, at));
        check('disband, a call on it from another server: they stay where they are, the words too', (await header(M1)).includes(keep.text) && (await words(M1)) === 'written for keep', [await header(M1), await words(M1)]);
        check('disband, a call on it from another server: no notice takes their words', !(await said(M1, at)).some(s => s.notice), await said(M1, at));
        await shot(M1, '03-disband-call-from-another-server');
        await composer(M1).fill('');
    }

    // ── Disband: looking at it, in a call on the owner's other server ─────────────
    if (!SFU_ONLY) {
        const doom = await makeServer(O, 'doomD' + SUFFIX, [M1]);
        await fresh(O, M1, M2, X);
        await goTo(O, keep);
        await goTo(X, outside);
        await composer(X).fill(OUTSIDER_WORDS);
        await goTo(M1, keep);
        await join(O, keep);
        await join(M1, keep);
        check('fixture: both are in keep\'s room', !!await until(() => inRoom(O, keep, memberId), 8000));
        await goTo(M1, doom);
        check('control: looking at the other server keeps the call', await inCall(M1));
        await sleep(3500); // the mesh settles before its bytes are counted
        const before = await audioIn(M1);
        const at = Date.now();
        await press(O, doom, 'Disband Server');
        check('disband, a call on another server: the server on screen goes', !!await until(async () => (await icon(M1, doom.name).count()) === 0), await icon(M1, doom.name).count());
        check('disband, a call on another server: on the home page', !!await until(() => onHome(M1)));
        await sleep(2500);
        check('control: the call on the other server goes on, for the member', await inCall(M1));
        check('control: and for the owner', await inCall(O));
        check('control: and the server still has them both', (await inRoom(O, keep, memberId)) && (await inRoom(M1, keep, await whoAmI(O))));
        const after = await audioIn(M1);
        if (before === null || after === null) console.log('INFO  this build has no mesh diagnostics, so audio bytes were not counted');
        else check('control: and its audio still arrives', after > before, [before, after]);
        check('control: nothing says that call ended', !(await said(M1, at)).some(s => /call ended|left its call/.test(s.text)), await said(M1, at));
        check('control: the owner is still on keep\'s page', (await header(O)).includes(keep.text), await header(O));
        check('control: no RoomLeft for keep\'s room reached either', ![...framesSince('MEMBER-PC', at, 'RoomLeft'), ...framesSince('OWNER', at, 'RoomLeft')].some(f => f.raw.includes(`voice_${keep.voiceId}`)));
        await shot(M1, '04-disband-call-on-another-server');
        await outsiderUndisturbed(X, at, doom, outside, OUTSIDER_WORDS);
        await O.locator('[data-testid="voice-leave"]').first().click({ timeout: 3000 }).catch(() => {});
        await M1.locator('[data-testid="voice-leave"]').first().click({ timeout: 3000 }).catch(() => {});
        await sleep(500);
    }

    // ── Leave: the other device, on screen with words in the box ──────────────────
    if (!SFU_ONLY) {
        const gone = await makeServer(O, 'leaveA' + SUFFIX, [M1]);
        await fresh(O, M1, M2, X);
        await goTo(O, gone);
        await goTo(M1, gone);
        await goTo(M2, gone, true);
        await goTo(X, outside);
        await composer(X).fill(OUTSIDER_WORDS);
        await composer(M2).fill('the phone was writing this');
        await composer(M1).fill('the PC was writing this');
        await composer(O).fill('the owner is writing this');
        const at = Date.now();
        await press(M1, gone, 'Leave Server');
        check('leave: the other device loses it from the rail, live', !!await until(async () => (await icon(M2, gone.name).count()) === 0), await icon(M2, gone.name).count());
        check('leave: and is on the home page', !!await until(() => onHome(M2)), await header(M2));
        check('leave: it says they left, on another device', !!await until(() => toastSays(M2, at, `You left ${gone.name} on another device`)), await said(M2, at));
        check('leave: what it was writing is in a notice', !!await until(() => noticeSays(M2, at, '#' + gone.text, 'the phone was writing this')), await said(M2, at));
        check('leave: nothing reads as a kick', await neverKicked(M2, at), await said(M2, at));
        check('leave: the frame said why', framesSince('MEMBER-PHONE', at, 'RemovedFromServer').some(f => f.raw.includes(gone.id) && f.raw.includes('"reason":"left"')));
        await shot(M2, '05-leave-other-device-phone');
        check('leave, own press: goes on to its next server', !!await until(async () => (await icon(M1, gone.name).count()) === 0 && !(await header(M1)).includes(gone.text + ' ') && (await words(M1)) === ''), [await header(M1), await words(M1)]);
        check('leave, own press: not to the home page', !await onHome(M1));
        check('leave, own press: its words are in a notice', !!await until(() => noticeSays(M1, at, 'the PC was writing this')), await said(M1, at));
        check('leave, own press: nothing tells it what it just did', !await toastSays(M1, at, 'You left'), await said(M1, at));
        check('leave, own press: no error', alertsSince('MEMBER-PC', at).length === 0, alertsSince('MEMBER-PC', at));
        check('control: the owner is sent no such frame', framesSince('OWNER', at, 'RemovedFromServer').length === 0);
        check('control: and stays where they were, words and all', (await header(O)).includes(gone.text) && (await words(O)) === 'the owner is writing this' && (await icon(O, gone.name).count()) === 1, [await header(O), await words(O)]);
        check('control: the frame recorder does hear the owner\'s frames', !!await until(() => framesSince('OWNER', at, 'ChannelPermsChanged').length > 0));
        await outsiderUndisturbed(X, at, gone, outside, OUTSIDER_WORDS);
        await composer(O).fill('');
    }

    // ── Leave: a call on it, on the other device ──────────────────────────────────
    if (!SFU_ONLY) {
        const gone = await makeServer(O, 'leaveB' + SUFFIX, [M1]);
        await fresh(O, M1, M2);
        await goTo(O, gone);
        await goTo(M2, gone, true);
        await join(O, gone);
        await join(M2, gone, true);
        check('fixture: the phone and the owner are in the room', !!await until(() => inRoom(O, gone, memberId), 8000));
        const at = Date.now();
        await press(M1, gone, 'Leave Server');
        check('leave, a call on the other device: the call ends', !!await until(async () => !(await inCall(M2))), await inCall(M2));
        check('leave, a call on the other device: and it says why', !!await until(() => toastSays(M2, at, `You left ${gone.name} on another device, so this call ended`)), await said(M2, at));
        check('leave, a call on the other device: one thing said, not two', (await said(M2, at)).filter(s => !s.notice).length === 1, await said(M2, at));
        await shot(M2, '06-leave-call-on-other-device');
        check('control: the owner\'s call goes on without them', await inCall(O));
        check('and the server has them out of the room', !!await until(async () => !(await inRoom(O, gone, memberId)), 8000));
        await O.locator('[data-testid="voice-leave"]').first().click({ timeout: 3000 }).catch(() => {});
    }

    // ── Leave: looking at it, the phone's call on another server ──────────────────
    if (!SFU_ONLY) {
        const gone = await makeServer(O, 'leaveC' + SUFFIX, [M1]);
        await fresh(O, M1, M2);
        await goTo(O, keep);
        await goTo(M2, keep, true);
        await join(O, keep);
        await join(M2, keep, true);
        await goTo(M2, gone, true);
        check('control: looking at the other server keeps the call', await inCall(M2));
        const at = Date.now();
        await press(M1, gone, 'Leave Server');
        check('leave, the phone\'s call on another server: the server on screen goes', !!await until(async () => (await icon(M2, gone.name).count()) === 0), await icon(M2, gone.name).count());
        await sleep(2500);
        check('control: that call goes on', await inCall(M2));
        check('control: and the server still has them in it', await inRoom(O, keep, memberId));
        check('control: nothing says it ended', !(await said(M2, at)).some(s => /call ended|left its call/.test(s.text)), await said(M2, at));
        await O.locator('[data-testid="voice-leave"]').first().click({ timeout: 3000 }).catch(() => {});
        await M2.locator('[data-testid="voice-leave"]').first().click({ timeout: 3000 }).catch(() => {});
        await sleep(500);
    }

    // ── Leave: the device that pressed is the one in the call ─────────────────────
    if (!SFU_ONLY) {
        const gone = await makeServer(O, 'leaveD' + SUFFIX, [M1]);
        await fresh(O, M1, M2);
        await goTo(O, gone);
        await goTo(M1, gone);
        await join(O, gone);
        await join(M1, gone);
        const at = Date.now();
        await press(M1, gone, 'Leave Server');
        check('leave, own press in the call: the call ends', !!await until(async () => !(await inCall(M1))), await inCall(M1));
        check('leave, own press in the call: goes on to its next server', !!await until(async () => (await icon(M1, gone.name).count()) === 0 && !(await onHome(M1))));
        check('leave, own press in the call: no toast tells it why', !await toastSays(M1, at, 'this call ended'), await said(M1, at));
        check('control: the owner\'s call goes on', await inCall(O));
        await O.locator('[data-testid="voice-leave"]').first().click({ timeout: 3000 }).catch(() => {});
    }

    // ── A device asleep through the frame ─────────────────────────────────────────
    if (!SFU_ONLY) {
        const doom = await makeServer(O, 'doomE' + SUFFIX, [M1]);
        await fresh(O, M1, M2);
        await goTo(O, keep);
        await goTo(M2, doom, true);
        await join(M2, doom, true);
        await composer(M2).fill('written while asleep');
        await M2.evaluate(() => { window.__sgAsleep = true; for (const s of window.__sgSockets) s.close(); });
        await sleep(1000);
        const at = Date.now();
        await press(O, doom, 'Disband Server');
        await sleep(1500);
        check('asleep: it heard nothing (the fixture)', framesSince('MEMBER-PHONE', at, 'RemovedFromServer').length === 0);
        await M2.evaluate(() => { window.__sgAsleep = false; });
        check('asleep, on waking: the server goes from the rail', !!await until(async () => (await icon(M2, doom.name).count()) === 0, 30000), await icon(M2, doom.name).count());
        check('asleep, on waking: on the home page', !!await until(() => onHome(M2)));
        check('asleep, on waking: the call ends and says the room is gone', !!await until(async () => !(await inCall(M2)) && await toastSays(M2, at, 'is no longer available, so you left its call')), await said(M2, at));
        check('asleep, on waking: the words are in a notice', !!await until(() => noticeSays(M2, at, 'written while asleep')), await said(M2, at));
        await sleep(2500);
        check('asleep, on waking: nothing reads as a kick', await neverKicked(M2, at), await said(M2, at));
        check('asleep, on waking: no bare refusal is left on screen', !(await said(M2, at)).some(s => /Not a member/i.test(s.text)), await said(M2, at));
        await shot(M2, '06b-asleep-on-waking');
    }

    // ── The same on LiveKit, which keeps its own list ─────────────────────────────
    if (LK) {
        const ownerId = await whoAmI(O), outsiderId = await whoAmI(X);
        const sfuOn = (srv) => api(O, 'PATCH', `/channels/${srv.voiceId}`, { sfu_mode: true });
        const elsewhere = await makeServer(X, 'sfuOut' + SUFFIX);
        await api(X, 'PATCH', `/channels/${elsewhere.voiceId}`, { sfu_mode: true });
        await fresh(X);
        await goTo(X, elsewhere);
        await join(X, elsewhere);
        check('sfu control, fixture: a member of a different server is in a room of theirs, per LiveKit', !!await until(async () => hasUser(await lkPeople(elsewhere.voiceId), outsiderId), 15000));

        // Disband.
        const doom = await makeServer(O, 'sfuA' + SUFFIX, [M1]);
        await sfuOn(doom);
        await fresh(O, M1, M2);
        await goTo(O, doom);
        await goTo(M1, doom);
        await join(O, doom);
        await join(M1, doom);
        check('sfu, fixture: both are in the room, per LiveKit', !!await until(async () => {
            const people = await lkPeople(doom.voiceId);
            return hasUser(people, ownerId) && hasUser(people, memberId);
        }, 20000), await lkPeople(doom.voiceId));
        let at = Date.now();
        await press(O, doom, 'Disband Server');
        check("sfu, disband: the member's call ends", !!await until(async () => !(await inCall(M1)), 8000), await inCall(M1));
        check('sfu, disband: and says why', !!await until(() => toastSays(M1, at, `${doom.name} was disbanded by its owner, so this call ended`)), await said(M1, at));
        await sleep(1200);
        const sfuSaid = await said(M1, at);
        check('sfu, disband: nothing reads as a kick or a bare refusal', await neverKicked(M1, at), { said: sfuSaid, sent: framesSince2('MEMBER-PC', at - 1500) });
        check('sfu, disband: one thing said, not two', sfuSaid.length === 1, sfuSaid);
        check('sfu, disband: LiveKit has nobody left in the room', !!await until(async () => (await lkPeople(doom.voiceId)).length === 0, 10000), await lkPeople(doom.voiceId));
        check("sfu, disband: the owner's call ends", !!await until(async () => !(await inCall(O)), 8000), await inCall(O));
        check("sfu control: another server's room still has its person", hasUser(await lkPeople(elsewhere.voiceId), outsiderId), await lkPeople(elsewhere.voiceId));
        check('sfu control: and their call goes on, with nothing said', (await inCall(X)) && (await said(X, at)).length === 0, await said(X, at));
        await shot(M1, '06c-sfu-disband-member');

        // Leave, the call on the other device.
        const gone = await makeServer(O, 'sfuB' + SUFFIX, [M1]);
        await sfuOn(gone);
        await fresh(O, M1, M2);
        await goTo(O, gone);
        await goTo(M2, gone, true);
        await join(O, gone);
        await join(M2, gone, true);
        check('sfu, leave, fixture: the phone and the owner are in the room, per LiveKit', !!await until(async () => {
            const people = await lkPeople(gone.voiceId);
            return hasUser(people, ownerId) && hasUser(people, memberId);
        }, 20000), await lkPeople(gone.voiceId));
        at = Date.now();
        await press(M1, gone, 'Leave Server');
        check("sfu, leave: the phone's call ends and says why", !!await until(async () => !(await inCall(M2)) && await toastSays(M2, at, `You left ${gone.name} on another device, so this call ended`), 8000), await said(M2, at));
        check('sfu, leave: LiveKit has them out', !!await until(async () => !hasUser(await lkPeople(gone.voiceId), memberId), 10000), await lkPeople(gone.voiceId));
        check('sfu control: and still has the owner, whose call goes on', hasUser(await lkPeople(gone.voiceId), ownerId) && (await inCall(O)), await lkPeople(gone.voiceId));
        await O.locator('[data-testid="voice-leave"]').first().click({ timeout: 3000 }).catch(() => {});
        await X.locator('[data-testid="voice-leave"]').first().click({ timeout: 3000 }).catch(() => {});
        await sleep(500);

        // An older client still finishes a join after the call has ended, and its start
        // arrives after the eviction. Disbanded straight after it connects, so that it does.
        if (OLD_APP) {
            const old = await signIn(await makeContext(), OLD_APP, 'sgoldsfu' + SUFFIX, 'OLD-SFU', true);
            const oldServer = await makeServer(O, 'sfuOld' + SUFFIX, [old]);
            await sfuOn(oldServer);
            await fresh(O, old);
            await goTo(old, oldServer);
            await join(old, oldServer);
            at = Date.now();
            await press(O, oldServer, 'Disband Server');
            check('old client, sfu, disband: the call ends', !!await until(async () => !(await inCall(old)), 8000), await inCall(old));
            check('old client, sfu, disband: LiveKit has them out', !!await until(async () => (await lkPeople(oldServer.voiceId)).length === 0, 10000), await lkPeople(oldServer.voiceId));
            await sleep(1200);
            check('old client, sfu, disband: no bare refusal is left on screen', await neverKicked(old, at), { said: await said(old, at), sent: framesSince2('OLD-SFU', at - 1500) });
        }
    } else {
        console.log('INFO  LK_API not set: the calls here were all mesh');
    }

    // ── An older client, on this server ───────────────────────────────────────────
    if (OLD_APP && !SFU_ONLY) {
        const oldName = 'sgold' + SUFFIX;
        const ctxOld = await makeContext(), ctxOld2 = await makeContext(false);
        const P = await signIn(ctxOld, OLD_APP, oldName, 'OLD-PC', true);
        const P2 = await signIn(ctxOld2, OLD_APP, oldName, 'OLD-PHONE', false);
        const oldId = await whoAmI(P);
        const oldKeep = await makeServer(O, 'keepOld' + SUFFIX, [P]);

        // Disband, on screen, words in the box.
        const a = await makeServer(O, 'oldA' + SUFFIX, [P]);
        await fresh(O, P, P2);
        await goTo(O, oldKeep);
        await goTo(P, a);
        await goTo(P2, oldKeep, true);
        await composer(P).fill('the old client was writing this');
        let at = Date.now();
        await press(O, a, 'Disband Server');
        check('old client, disband on screen: gone from the rail, live', !!await until(async () => (await icon(P, a.name).count()) === 0));
        check('old client, disband on screen: on the home page', !!await until(() => onHome(P)));
        check('old client, disband on screen: the words are in a notice', !!await until(() => noticeSays(P, at, 'the old client was writing this')), await said(P, at));
        check('old client, disband: no error', alertsSince('OLD-PC', at).length === 0, alertsSince('OLD-PC', at));
        check('old client, its phone on another server: gone from the rail, still where it was', !!await until(async () => (await icon(P2, a.name).count()) === 0) && (await header(P2)).includes(oldKeep.text));
        check('old client: the extra field in the frame reached it and changed nothing else', framesSince('OLD-PC', at, 'RemovedFromServer').some(f => f.raw.includes('"reason":"disbanded"')));
        await shot(P, '07-old-client-disband-on-screen');

        // Disband, in a call on it, looking at another server: only RoomLeft can end this.
        const b = await makeServer(O, 'oldB' + SUFFIX, [P]);
        await fresh(O, P, P2);
        await goTo(O, oldKeep);
        await goTo(P, b);
        await join(P, b);
        await goTo(P, oldKeep);
        check('old client, fixture: in the call, looking elsewhere', await inCall(P));
        at = Date.now();
        await press(O, b, 'Disband Server');
        check('old client, a call on it from another server: the call ends', !!await until(async () => !(await inCall(P))), await inCall(P));
        check('old client, a call on it from another server: stays where it is', (await header(P)).includes(oldKeep.text), await header(P));

        // Disband, looking at it, in a call on another server.
        const c = await makeServer(O, 'oldC' + SUFFIX, [P]);
        await fresh(O, P, P2);
        await goTo(O, oldKeep);
        await goTo(P, oldKeep);
        await join(O, oldKeep);
        await join(P, oldKeep);
        await goTo(P, c);
        at = Date.now();
        await press(O, c, 'Disband Server');
        check('old client, a call on another server: the server on screen goes', !!await until(async () => (await icon(P, c.name).count()) === 0));
        await sleep(2500);
        check('old client, a call on another server: that call goes on', (await inCall(P)) && (await inRoom(O, oldKeep, oldId)));
        await O.locator('[data-testid="voice-leave"]').first().click({ timeout: 3000 }).catch(() => {});
        await P.locator('[data-testid="voice-leave"]').first().click({ timeout: 3000 }).catch(() => {});
        await sleep(500);

        // Its own Leave, with its other device on screen.
        const d = await makeServer(O, 'oldD' + SUFFIX, [P]);
        await fresh(O, P, P2);
        await goTo(P, d);
        await goTo(P2, d, true);
        await composer(P).fill('old client own leave');
        await composer(P2).fill('old phone other device');
        at = Date.now();
        await press(P, d, 'Leave Server');
        check('old client, its own Leave: gone from its rail', !!await until(async () => (await icon(P, d.name).count()) === 0));
        check('old client, its own Leave: somewhere sensible, with an empty box or the home page', !!await until(async () => (await onHome(P)) || (await words(P)) === ''), await header(P));
        check('old client, its own Leave: the words are in one notice', !!await until(() => noticeSays(P, at, 'old client own leave')) && (await said(P, at)).filter(s => s.notice).length === 1, await said(P, at));
        check('old client, its own Leave: no error', alertsSince('OLD-PC', at).length === 0, alertsSince('OLD-PC', at));
        check('old client, its other device: gone, on the home page, its words in a notice', !!await until(async () => (await icon(P2, d.name).count()) === 0 && (await onHome(P2))) && !!await until(() => noticeSays(P2, at, 'old phone other device')), await said(P2, at));

        // Its own Disband.
        const e = await makeServer(P, 'oldE' + SUFFIX);
        const f = await makeServer(P, 'oldF' + SUFFIX);
        await fresh(P, P2);
        await goTo(P, e);
        at = Date.now();
        await press(P, e, 'Disband Server');
        check('old client, its own Disband: gone from its rail', !!await until(async () => (await icon(P, e.name).count()) === 0));
        check('old client, its own Disband: its other server is still there', (await icon(P, f.name).count()) === 1);
        check('old client, its own Disband: no error', alertsSince('OLD-PC', at).length === 0, alertsSince('OLD-PC', at));
        await shot(P, '08-old-client-own-disband');

        // Asleep through a disband, in a call on it: it is told with a RoomLeft on waking.
        const s = await makeServer(O, 'oldS' + SUFFIX, [P]);
        await fresh(O, P, P2);
        await goTo(O, oldKeep);
        await goTo(P2, s, true);
        await join(P2, s, true);
        await P2.evaluate(() => { window.__sgAsleep = true; for (const sock of window.__sgSockets) sock.close(); });
        await sleep(1000);
        at = Date.now();
        await press(O, s, 'Disband Server');
        await sleep(1500);
        await P2.evaluate(() => { window.__sgAsleep = false; });
        check('old client, asleep, on waking: the call ends', !!await until(async () => !(await inCall(P2)), 30000), await inCall(P2));
        check('old client, asleep, on waking: the server goes from the rail', !!await until(async () => (await icon(P2, s.name).count()) === 0, 10000));
        await sleep(2500);
        check('old client, asleep, on waking: no bare refusal is left on screen', await neverKicked(P2, at), await said(P2, at));
    } else {
        console.log('INFO  OLD_APP not set: the older client was not walked');
    }
} catch (e) {
    check('the walk ran to the end', false, String(e?.stack || e).slice(0, 800));
} finally {
    await browser.close();
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures);
