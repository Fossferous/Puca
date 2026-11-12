// LIVE: a member who joins a server is handed the keys of the voice channels that existed before
// them (0.9.861, components/useChannelKeyUpkeep.ts). Through the BUILT bundle and a real backend,
// with every verdict read from the DATABASE (channel_keys: channel_id, epoch, recipient_id,
// member_generation; servers.member_generation), never from a log line.
//
// Channel keys are wrapped per member, so a newcomer holds nothing until a holder re-wraps. Until
// 0.9.861 holders re-wrapped only TEXT channels on MemberJoined, so a newcomer could join no SFU voice
// room whose key predated them: "Channel encryption key unavailable — cannot join encrypted call"
// (api/rtc/sfuManager.ts). Reported as a new member on Firefox who could join no voice channel.
//
//   SETUP: owner A signs up in a real page, makes a server with an sfu_mode voice room, a second
//     voice room nobody uses, and a collection; sends a message in the text channel (its key, epoch 1)
//     and joins the voice room through its real row (the SFU join mints that room's key BEFORE it asks
//     for an SFU token, so the key exists even with no LiveKit), then hangs up: nobody holding the key
//     stays in the call, whose 30 s epoch poll would otherwise re-key the room for a newcomer itself.
//   ON JOIN: with A's page open, B joins by invite (API). Within KEY_MS the voice room's current epoch
//     has a row for B, minted for the server's current member generation, and the text channel's too.
//     CONTROL: the collection (channel_type 2) has no key rows at all.
//   CATCH-UP: A's browser context closed (no holder online anywhere), C joins. C holds nothing for the
//     voice room or the text channel after QUIET_MS (the state exists: the positive control), and the
//     server's generation has moved past the room's epoch. A signs in again in a FRESH context and opens
//     the server: within KEY_MS C has a row for the room's current epoch, and the text channel's. A voice
//     room made after the join, never used, has no key afterwards (the catch-up mints no first key);
//     CONTROL: D then joins with A online, and the ordinary MemberJoined path DOES mint that room, so
//     the zero was the catch-up's rule and not a room A's page could not key.
//   JOIN THE CALL (LK_API set: the backend on a loopback-only LiveKit): B, in FIREFOX (the reported
//     browser; FIREFOX=0 uses Edge), and C, in Edge, each sign in fresh and press the voice room's row:
//     each passes the key gate (the join asks for its SFU token only once it holds the room's key, and
//     the token is issued), LiveKit's own ListParticipants has the session, and nothing on the page or
//     its console says "Channel encryption key unavailable". C's call is LIVE: the page says Voice
//     Connected and LiveKit has it ACTIVE with its microphone published (a listed session alone is
//     only signalling). B's media cannot connect on this rig (headless Firefox on Windows offers no
//     127.0.0.1 ICE candidate under any pref, and the LiveKit answers on 127.0.0.1 only), so B's
//     ACTIVE prints SKIP, never a pass. Neither sign-in nor join rotates a key (the DB is unchanged).
//     Without LK_API this whole part prints SKIP.
//
// NEGATIVE CONTROL: OLD_APP, a build of 0.9.860 (d8157eda, before the fix) against the same API, walks
// the same steps on its own accounts and server. Every check is printed for it as "OLD  PASS|FAIL",
// with what it must be: the voice checks must FAIL there (B and C get no voice key, a join refuses with
// the reported words) while B still gets the text key on join. A "PASS/FAIL  negative control" line
// per check says whether the old bundle did what it must; a mismatch counts as a failure.
//
// Each check prints PASS/FAIL; the exit code is the number of failures. Screenshots go to OUT.
//
// Prereqs: a THROWAWAY stack (CLAUDE.md, Throwaway stack recipe): a backend (APP_ENV=development,
// raised AUTH_RATE_LIMIT_PER_SECOND / _BURST, its own fresh database, never a real one) at API, the
// main bundle built against it (PUCA_ALLOW_LOCAL_BUILD=1 VITE_API_URL=$API node node_modules/vite/bin/
// vite.js build --outDir <dir> --emptyOutDir) served at APP (DIST=<dir> PORT=<port> node
// e2e/serve-dist.mjs), and for OLD_APP the same build of d8157eda (a detached worktree with its own
// npm ci). PGDB / PGPORT / PGHOST / PGUSER / PGPASSWORD (and PSQL, the psql binary) name THAT backend's
// database: the walk checks it holds the server it made. LK_API / LK_KEY / LK_SECRET: the LiveKit the
// backend's LIVEKIT_* point at, loopback only, its webhook at API/livekit/webhook. Everything must be
// loopback: it creates accounts. Run the backend with STUN_SERVERS= (empty) and give the LiveKit an
// rtc.stun_servers on loopback (it hands its own list to every client, Google's by default), so no
// page asks a public STUN server for its address. Silent: Edge with --mute-audio and fake
// devices, Firefox with media.volume_scale 0 and fake streams; headless. Firefox: npx playwright
// install firefox. About 5 minutes with OLD_APP and LiveKit (most of it the old bundle's 15 s waits
// for keys that never come).
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5196 API=http://127.0.0.1:3071 OUT=<dir> PGDB=<db> PGPORT=5447 [OLD_APP=http://127.0.0.1:5197]
//     [LK_API=http://127.0.0.1:7985 LK_KEY=... LK_SECRET=...] [FIREFOX=0] node e2e/newcomer-voice-key-live.mjs
import { chromium, firefox } from '@playwright/test';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP = (process.env.APP || '').replace(/\/$/, '');
const API = (process.env.API || '').replace(/\/$/, '');
const OLD_APP = (process.env.OLD_APP || '').replace(/\/$/, '');
const OUT = process.env.OUT || 'e2e/shots-newcomer-voice-key';
const KEY_MS = Number(process.env.KEY_MS || 15000);
const QUIET_MS = Number(process.env.QUIET_MS || 5000);
const USE_FIREFOX = process.env.FIREFOX !== '0';
const PG = { db: process.env.PGDB || '', host: process.env.PGHOST || '127.0.0.1', port: process.env.PGPORT || '5432', user: process.env.PGUSER || 'postgres' };
const PSQL = process.env.PSQL || 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
const LK = process.env.LK_API && process.env.LK_KEY && process.env.LK_SECRET
    ? { api: process.env.LK_API.replace(/\/$/, ''), key: process.env.LK_KEY, secret: process.env.LK_SECRET } : null;
const isLoopback = (url) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; } };
if (!isLoopback(APP) || !isLoopback(API) || (OLD_APP && !isLoopback(OLD_APP)) || (LK && !isLoopback(LK.api)) || !['127.0.0.1', 'localhost', '::1'].includes(PG.host)) {
    console.error(`this walk creates accounts: APP, API, OLD_APP, LK_API and PGHOST must all be loopback (APP=${APP} API=${API} OLD_APP=${OLD_APP} PGHOST=${PG.host})`);
    process.exit(2);
}
if (!PG.db) {
    console.error('PGDB must name the throwaway backend\'s database: every verdict here is read from it');
    process.exit(2);
}
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
fs.mkdirSync(OUT, { recursive: true });
const KEY_GONE = 'Channel encryption key unavailable';

// ── Verdicts ─────────────────────────────────────────────────────────────────────────
// The fixed bundle: every check must pass. The old bundle: every check carries what it MUST be
// there ('fail' where the fix is what makes it pass), and is judged against that.
let failures = 0;
let mode = 'new';
const tally = { oldAsExpected: 0, oldNot: 0, oldVoiceFails: 0 };
const fmt = (extra) => extra !== '' && extra !== undefined ? '  -- ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : '';
function check(name, ok, extra = '', old = 'pass') {
    ok = !!ok;
    if (mode === 'new') {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${fmt(extra)}`);
        if (!ok) failures++;
        return ok;
    }
    const want = old === 'fail' ? false : old === 'pass' ? true : ok;
    console.log(`OLD  ${ok ? 'PASS' : 'FAIL'}  ${name}${fmt(extra)}`);
    const matched = ok === want;
    console.log(`${matched ? 'PASS' : 'FAIL'}  negative control (0.9.860): "${name}" ${old === 'fail' ? 'must FAIL' : old === 'pass' ? 'must PASS' : 'either'} there, and it ${ok ? 'passed' : 'failed'}`);
    if (matched) tally.oldAsExpected++; else { tally.oldNot++; failures++; }
    if (old === 'fail' && !ok) tally.oldVoiceFails++;
    return ok;
}
const info = (s) => console.log(`${mode === 'old' ? 'OLD  ' : ''}INFO  ${s}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = KEY_MS, step = 200) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
        try { last = await fn(); if (last) return last; } catch { /* retry */ }
        await sleep(step);
    }
    try { last = await fn(); } catch { /* the last word */ }
    return last;
}

// ── The database: what is actually stored, whoever wrote it ────────────────────────
const sql = (text) => execFileSync(PSQL, ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', PG.db, '-t', '-A', '-F', '|', '-c', text],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' } }).trim();
const int = (v) => { const n = Number(v); if (!Number.isInteger(n)) throw new Error(`not an integer: ${v}`); return n; };
const sid = (v) => { if (!/^[\w-]+$/.test(String(v))) throw new Error(`not a server id: ${v}`); return String(v); };
const userId = (name) => int(sql(`SELECT id FROM users WHERE username = '${name.replace(/[^\w]/g, '')}'`));
const hasIdentityKey = (uid) => sql(`SELECT count(*) FROM users WHERE id = ${int(uid)} AND public_key IS NOT NULL AND public_key <> ''`) === '1';
const serverGen = (srvId) => int(sql(`SELECT member_generation FROM servers WHERE id = '${sid(srvId)}'`));
/** The channel's current epoch (the highest stored), whom it is wrapped for, and the generation it was minted for. */
function keyState(channelId) {
    const c = int(channelId);
    const epoch = int(sql(`SELECT COALESCE(MAX(epoch), 0) FROM channel_keys WHERE channel_id = ${c}`));
    const total = int(sql(`SELECT count(*) FROM channel_keys WHERE channel_id = ${c}`));
    if (epoch === 0) return { epoch, total, gen: null, to: [] };
    const rows = sql(`SELECT recipient_id, member_generation FROM channel_keys WHERE channel_id = ${c} AND epoch = ${epoch} ORDER BY recipient_id`)
        .split('\n').filter(Boolean).map(l => l.split('|').map(Number));
    return { epoch, total, gen: rows[0]?.[1] ?? null, to: rows.map(r => r[0]) };
}
/** Whether `uid` has a row at the channel's CURRENT epoch. */
const holdsCurrent = (channelId, uid) => keyState(channelId).to.includes(int(uid));
/** Whether `uid` has a row at ANY epoch of the channel. */
const holdsAny = (channelId, uid) => int(sql(`SELECT count(*) FROM channel_keys WHERE channel_id = ${int(channelId)} AND recipient_id = ${int(uid)}`)) > 0;

// ── LiveKit's own word on who is in a room ─────────────────────────────────────────
// ListParticipants lists a session from the moment its signalling joins, before any media
// connects (state JOINING), so "listed" alone proves only that the SFU token was issued and used.
// A call that carries media is ACTIVE, with its microphone among its published tracks.
async function lkParticipants(channelId) {
    const room = `sfu_${channelId}`;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: LK.key, sub: 'newcomer-voice-key-walk', nbf: now - 5, exp: now + 300, video: { roomAdmin: true, roomList: true, room } })}`;
    const jwt = `${body}.${crypto.createHmac('sha256', LK.secret).update(body).digest('base64url')}`;
    const r = await fetch(`${LK.api}/twirp/livekit.RoomService/ListParticipants`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ room }),
    });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`ListParticipants ${room}: ${r.status}`);
    return (await r.json()).participants || [];
}
const lkPeople = async (channelId) => (await lkParticipants(channelId)).map(p => `${p.identity}:${p.state ?? 'JOINING'}:${(p.tracks || []).length}t`);
const lkOf = async (channelId, uid) => (await lkParticipants(channelId)).find(p => String(p.identity).startsWith(`u${uid}#`)) ?? null;
const lkHas = async (channelId, uid) => !!(await lkOf(channelId, uid));
/** ACTIVE (media connected) with at least one published track: the microphone. */
const lkLive = async (channelId, uid) => {
    const p = await lkOf(channelId, uid);
    return !!p && (p.state === 'ACTIVE' || p.state === 2) && (p.tracks || []).length > 0;
};

// ── Browsers: headless and silent ──────────────────────────────────────────────────
const edge = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
let fox = null;
if (USE_FIREFOX) {
    try {
        fox = await firefox.launch({
            headless: true,
            firefoxUserPrefs: {
                'media.volume_scale': '0.0',
                'media.navigator.streams.fake': true,
                'media.navigator.permission.disabled': true,
                // LiveKit's rig answers on 127.0.0.1 only; Firefox leaves loopback out of ICE by default.
                'media.peerconnection.ice.loopback': true,
                'media.peerconnection.ice.obfuscate_host_addresses': false,
            },
        });
    } catch (e) {
        console.log(`INFO  Firefox could not be launched (${String(e.message || e).split('\n')[0]}): B uses Edge`);
    }
}

const received = new Map();
const consoleOf = new Map();
const tokensAsked = new Map();
function watch(page, tag) {
    received.set(tag, []);
    consoleOf.set(tag, []);
    tokensAsked.set(tag, []);
    // An SFU join asks for its token only once it holds the channel's key (sfuManager.ts doConnect).
    page.on('response', (res) => {
        const m = /\/channels\/(\d+)\/sfu-token(\?|$)/.exec(res.url());
        if (m) tokensAsked.get(tag).push({ at: Date.now(), channel: Number(m[1]), status: res.status() });
    });
    page.on('websocket', ws => ws.on('framereceived', (f) => {
        try {
            const raw = typeof f.payload === 'string' ? f.payload : f.payload.toString();
            const msg = JSON.parse(raw);
            received.get(tag).push({ at: Date.now(), type: msg.type, payload: msg.payload });
        } catch { /* not JSON */ }
    }));
    page.on('console', m => {
        const t = m.text();
        consoleOf.get(tag).push({ at: Date.now(), type: m.type(), text: t });
        fs.appendFileSync(path.join(OUT, 'console.txt'), `${new Date().toISOString()} ${tag} ${m.type()} ${t.slice(0, 500)}\n`);
    });
    page.on('pageerror', e => fs.appendFileSync(path.join(OUT, 'console.txt'), `${new Date().toISOString()} ${tag} PAGEERROR ${e.message.slice(0, 500)}\n`));
    page.on('dialog', d => { d.type() === 'confirm' ? d.accept().catch(() => {}) : d.dismiss().catch(() => {}); });
}

async function makeContext(browser) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // Every voice error ever put on the page, so a join that fails and tears its panel down still
    // leaves what it said.
    await ctx.addInitScript(() => {
        window.__voiceErrors = [];
        const note = (el) => {
            const t = el?.textContent || '';
            if (t && (el.matches?.('.voice-error-mini') || t.includes('encryption key unavailable'))) window.__voiceErrors.push({ at: Date.now(), text: t.slice(0, 300) });
        };
        new MutationObserver(muts => {
            for (const m of muts) {
                if (m.type === 'characterData') { note(m.target.parentElement); continue; }
                for (const n of m.addedNodes) {
                    if (n.nodeType === 3) { note(n.parentElement); continue; }
                    if (n.nodeType !== 1) continue;
                    note(n);
                    for (const el of n.querySelectorAll('.voice-error-mini')) note(el);
                }
            }
        }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    return ctx;
}

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

/** Sign up (or in) through the real login page: real SRP, a real identity key. */
async function signIn(ctx, base, user, tag, registerFirst) {
    const page = await ctx.newPage();
    watch(page, tag);
    await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 60000 });
    if (registerFirst) await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder(registerFirst ? 'Choose a password (min 8 characters)' : 'Enter password').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 90000 });
    await sleep(1500);
    await dismiss(page);
    return page;
}

const tokenOf = (page) => page.evaluate(() => localStorage.getItem('auth_token'));
/** The API as the signed-in page. */
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
/** The API with a token and no page: an account that has no device online at all. */
async function apiAs(token, method, p, body) {
    const r = await fetch(API + p, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
}

const header = (page) => page.locator('.chat-header').first().innerText({ timeout: 800 }).catch(() => '');
async function goTo(page, srv) {
    await page.locator(`.server-icon[title="${srv.name}"]`).click({ timeout: 15000 });
    const there = await until(async () => (await page.locator('.server-header .server-name').first().innerText({ timeout: 500 })) === srv.name
        && (await header(page)).includes(srv.text), 15000);
    if (!there) throw new Error(`could not open ${srv.name}: header "${await header(page)}"`);
}
const inCall = async (page) => (await page.locator('.voice-panel-compact .voice-connected-label').count()) > 0;
const voiceRow = (page, channelId) => page.locator(`[data-testid="voice-channel"][data-channel-id="${channelId}"]`);
/** "Channel encryption key unavailable", anywhere this page has said it: on screen or in its console. */
async function refusedForKey(page, tag) {
    const onScreen = await page.evaluate(() => window.__voiceErrors.map(e => e.text)).catch(() => []);
    const inConsole = consoleOf.get(tag).filter(m => m.text.includes(KEY_GONE)).map(m => m.text.slice(0, 160));
    const seen = [...onScreen.filter(t => t.includes(KEY_GONE)), ...inConsole];
    return { refused: seen.length > 0, seen, errors: onScreen };
}
const hangUp = async (page) => {
    await page.locator('[data-testid="voice-leave"]').first().click({ timeout: 2500 }).catch(() => {});
    await until(async () => !(await inCall(page)), 8000);
};
/** Whether this page was sent MemberJoined for `uid` on `srvId` since `at`. */
const heardJoin = (tag, at, srvId, uid) => received.get(tag).some(f => f.at >= at && f.type === 'MemberJoined'
    && f.payload?.server_id === srvId && Number(f.payload?.user?.id) === Number(uid));
const shot = async (page, name) => {
    const f = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: f }).catch(() => {});
    console.log('SHOT', f);
};

// ── One walk, against one bundle ──────────────────────────────────────────────────
async function walk(base) {
    const tagOf = (t) => `${mode}-${t}`;
    const S = `_${mode === 'old' ? 'o' : 'n'}${stamp}`;
    const name = { A: 'nvka' + S, B: 'nvkb' + S, C: 'nvkc' + S, D: 'nvkd' + S };
    const bBrowser = fox ?? edge;
    const contexts = [];
    const ctxOn = async (browser) => { const c = await makeContext(browser); contexts.push(c); return c; };
    try {
        // Accounts. B, C and D sign up and close their pages straight away: none of them has a
        // device online until the very end, so only A's pages can hand anybody a key.
        const ctxA = await ctxOn(edge);
        const A = await signIn(ctxA, base, name.A, tagOf('A'), true);
        const tok = {};
        for (const k of ['B', 'C', 'D']) {
            const ctx = await ctxOn(k === 'B' ? bBrowser : edge);
            const page = await signIn(ctx, base, name[k], tagOf(k), true);
            tok[k] = await tokenOf(page);
            await ctx.close();
        }
        const id = { A: userId(name.A), B: userId(name.B), C: userId(name.C), D: userId(name.D) };
        check('fixture: all four accounts signed up through the real page and published an identity key',
            !!await until(() => Object.values(id).every(hasIdentityKey), 10000), id);

        // The server: its own default text channel, an sfu_mode voice room, a voice room nobody
        // uses, a collection; all made before A's page loads the list.
        const made = await api(A, 'POST', '/servers', { name: 'nvk' + S });
        const listed = await api(A, 'GET', `/servers/${made.id}/channels`);
        const text = listed.find(c => c.channel_type === 0);
        const room = await api(A, 'POST', `/servers/${made.id}/channels`, { name: 'Room', channel_type: 1 });
        await api(A, 'PATCH', `/channels/${room.id}`, { sfu_mode: true });
        const unused = await api(A, 'POST', `/servers/${made.id}/channels`, { name: 'Unused', channel_type: 1 });
        const coll = await api(A, 'POST', `/servers/${made.id}/channels`, { name: 'Rooms', channel_type: 2 });
        const others = listed.filter(c => c.channel_type === 1);
        const srv = { id: made.id, name: 'nvk' + S, text: text.name };
        const invite = await api(A, 'POST', `/servers/${made.id}/invites`, {});
        if (sql(`SELECT count(*) FROM servers WHERE id = '${sid(srv.id)}'`) !== '1') throw new Error(`PGDB=${PG.db} is not the database API=${API} uses`);
        check('fixture: the voice room is a voice channel in SFU mode, the collection a collection',
            sql(`SELECT type || ':' || COALESCE(sfu_mode, false) FROM channels WHERE id = ${int(room.id)}`) === '1:true'
            && sql(`SELECT type FROM channels WHERE id = ${int(coll.id)}`) === '2');
        await A.reload({ waitUntil: 'domcontentloaded' });
        await sleep(2000);
        await dismiss(A);
        await goTo(A, srv);

        // ── 1. The keys exist, the way the app makes them ────────────────────────────
        await A.locator('textarea.message-textarea').first().fill('before anyone else ' + stamp);
        await A.locator('textarea.message-textarea').first().press('Enter');
        check('setup: A\'s message in the text channel is stored sealed, and the channel\'s key exists for A',
            !!await until(() => int(sql(`SELECT count(*) FROM messages WHERE channel_id = ${int(text.id)} AND key_epoch IS NOT NULL`)) > 0 && holdsCurrent(text.id, id.A)),
            keyState(text.id));
        await voiceRow(A, room.id).click({ timeout: 10000 });
        if (LK) {
            check('setup: A joins the voice room through its row: the page says Voice Connected and LiveKit has A ACTIVE with its microphone published',
                !!await until(async () => (await inCall(A)) && await lkLive(room.id, id.A), 25000), await lkPeople(room.id).catch(e => String(e)));
        } else {
            info('LK_API not set: the voice room\'s row is pressed, the SFU join mints its key and then fails at the SFU token, as it does with no LiveKit');
        }
        check('setup: the voice room\'s key exists, wrapped for A, at the generation A alone makes',
            !!await until(() => holdsCurrent(room.id, id.A) && keyState(room.id).gen === serverGen(srv.id)), keyState(room.id));
        if (LK) {
            await hangUp(A);
            check('setup: A has left the call, per the page and per LiveKit (nobody holding the key stays in it to re-key it)',
                !!await until(async () => !(await inCall(A)) && !(await lkHas(room.id, id.A)), 20000), await lkPeople(room.id).catch(e => String(e)));
        }
        const room0 = keyState(room.id);
        const text0 = keyState(text.id);
        info(`before B: the voice room at epoch ${room0.epoch} (generation ${room0.gen}), the text channel at epoch ${text0.epoch} (generation ${text0.gen}), the server at generation ${serverGen(srv.id)}`);
        check('setup: nothing has keyed the collection, the unused room or the server\'s own voice rooms yet',
            [coll.id, unused.id, ...others.map(c => c.id)].every(c => keyState(c).total === 0),
            Object.fromEntries([coll, unused, ...others].map(c => [c.name + '#' + c.id, keyState(c.id).total])));

        // ── 2. ON JOIN: A's page is open and hears it ────────────────────────────────
        await sleep(1500);
        const at2 = Date.now();
        await apiAs(tok.B, 'POST', `/invites/${invite.code}/join`);
        check('on join, fixture: A\'s page is sent MemberJoined for B',
            !!await until(() => heardJoin(tagOf('A'), at2, srv.id, id.B), 6000));
        const bVoice = await until(() => holdsCurrent(room.id, id.B));
        const bVoiceMs = Date.now() - at2;
        check('on join: B holds the voice room\'s current key', bVoice, { ...keyState(room.id), B: id.B, ms: bVoiceMs }, 'fail');
        check('on join: and that epoch is a rotation minted for the generation B\'s join made',
            keyState(room.id).epoch > room0.epoch && keyState(room.id).gen === serverGen(srv.id), { before: room0, now: keyState(room.id), server: serverGen(srv.id) }, 'fail');
        check('on join: B holds the text channel\'s current key', !!await until(() => holdsCurrent(text.id, id.B)), { ...keyState(text.id), B: id.B });
        check('on join: and that epoch is a rotation minted for the current generation',
            keyState(text.id).epoch > text0.epoch && keyState(text.id).gen === serverGen(srv.id), { before: text0, now: keyState(text.id) });
        check('on join: A still holds both current keys', holdsCurrent(room.id, id.A) && holdsCurrent(text.id, id.A));
        await sleep(2000);
        check('on join, control: the collection has no key rows', keyState(coll.id).total === 0, keyState(coll.id));
        info(`on join: voice rooms nobody has used: ${[unused, ...others].map(c => `${c.name}#${c.id} epoch ${keyState(c.id).epoch}`).join(', ')} (an epoch 1 here is a first key minted by the MemberJoined re-wrap, which does not pass bootstrap:false; the catch-up does)`);

        // A voice room made now, while A's page is open, and never used by anyone.
        const late = await api(A, 'POST', `/servers/${made.id}/channels`, { name: 'Late', channel_type: 1 });
        await api(A, 'PATCH', `/channels/${late.id}`, { sfu_mode: true });
        await sleep(1000);

        // ── 3. CATCH-UP: nobody holding a key is online when C joins ─────────────────
        await ctxA.close();
        await sleep(1500);
        await apiAs(tok.C, 'POST', `/invites/${invite.code}/join`);
        await sleep(QUIET_MS);
        const room2 = keyState(room.id);
        check('catch-up, positive control: with nobody online, C holds nothing for the voice room', !holdsAny(room.id, id.C), room2);
        check('catch-up, positive control: nor for the text channel', !holdsAny(text.id, id.C), keyState(text.id));
        check('catch-up, positive control: the server\'s generation has moved past the voice room\'s epoch', serverGen(srv.id) > room2.gen, { server: serverGen(srv.id), room: room2.gen });
        check('catch-up, positive control: the room nobody used has no key', keyState(late.id).total === 0, keyState(late.id));

        const ctxA2 = await ctxOn(edge);
        const A2 = await signIn(ctxA2, base, name.A, tagOf('A2'), false);
        await goTo(A2, srv);
        const at3 = Date.now();
        const cVoice = await until(() => holdsCurrent(room.id, id.C) && keyState(room.id).gen === serverGen(srv.id));
        check('catch-up: once A signs in on a fresh device and opens the server, C holds the voice room\'s current key, minted for the current generation',
            cVoice, { ...keyState(room.id), server: serverGen(srv.id), C: id.C, ms: Date.now() - at3 }, 'fail');
        check('catch-up: and the text channel\'s', !!await until(() => holdsCurrent(text.id, id.C) && keyState(text.id).gen === serverGen(srv.id)),
            { ...keyState(text.id), server: serverGen(srv.id) }, 'fail');
        await sleep(3000);
        check('catch-up: the voice room nobody has used still has no key (the catch-up mints no first key)', keyState(late.id).total === 0, keyState(late.id));
        info(`catch-up: the unused room ${unused.name}#${unused.id} is at epoch ${keyState(unused.id).epoch} (generation ${keyState(unused.id).gen}); the server at ${serverGen(srv.id)}`);

        // CONTROL: the same page, on an ordinary join, can and does key that room.
        const at4 = Date.now();
        await apiAs(tok.D, 'POST', `/invites/${invite.code}/join`);
        check('control: D joins with A online and A\'s page hears it', !!await until(() => heardJoin(tagOf('A2'), at4, srv.id, id.D), 6000));
        check('control: D holds the voice room\'s current key', !!await until(() => holdsCurrent(room.id, id.D)), keyState(room.id), 'fail');
        check('control: D holds the text channel\'s current key', !!await until(() => holdsCurrent(text.id, id.D)), keyState(text.id));
        check('control: the ordinary MemberJoined re-wrap DOES mint the unused room, for D too (so its zero above was the catch-up\'s rule, not a room this page could not key)',
            !!await until(() => holdsCurrent(late.id, id.D)), keyState(late.id), 'fail');

        // ── 4. Into the call ──────────────────────────────────────────────────────────
        if (!LK) {
            console.log(`${mode === 'old' ? 'OLD  ' : ''}SKIP  join the call: LK_API is not set, so no SFU join can complete here (never a pass)`);
        } else {
            const roomBefore = keyState(room.id), textBefore = keyState(text.id);
            for (const [who, browser] of [['B', bBrowser], ['C', edge]]) {
                const kind = browser === fox ? 'Firefox' : 'Edge';
                const ctx = await ctxOn(browser);
                const tag = tagOf(who + '-call');
                const page = await signIn(ctx, base, name[who], tag, false);
                await goTo(page, srv);
                const pressed = Date.now();
                await voiceRow(page, room.id).click({ timeout: 10000 });
                const token = () => tokensAsked.get(tag).find(t => t.at >= pressed && t.channel === Number(room.id) && t.status === 200);
                await until(async () => token() || (await refusedForKey(page, tag)).refused, 25000);
                const said = await refusedForKey(page, tag);
                check(`call: ${who} (${kind}) passes the key gate: the SFU token is asked for and issued`, !!token(),
                    { tokens: tokensAsked.get(tag).filter(t => t.at >= pressed), errors: said.errors.slice(-3) }, 'fail');
                check(`call: nothing on ${who}'s page or console says "${KEY_GONE}"`, !said.refused, said.seen.slice(0, 2), 'fail');
                check(`call: LiveKit has ${who}'s session in the room`, !!await until(() => lkHas(room.id, id[who]), 10000),
                    await lkPeople(room.id).catch(e => String(e)), 'fail');
                const live = await until(async () => (await inCall(page)) && await lkLive(room.id, id[who]), 15000);
                if (browser === fox && !live) {
                    // Measured on the owner's machine: headless Firefox on Windows offers no 127.0.0.1 ICE
                    // candidate under any media.peerconnection.ice.* pref (loopback, force_interface,
                    // default_address_only), and this rig's LiveKit answers on 127.0.0.1 only.
                    console.log(`${mode === 'old' ? 'OLD  ' : ''}SKIP  call: ${who} (Firefox) carrying media (LiveKit ACTIVE): this loopback-only LiveKit cannot be reached by Firefox's ICE here; the key gate above is what the fix decides (never a pass) -- ${JSON.stringify(await lkPeople(room.id).catch(e => String(e)))}`);
                } else {
                    check(`call: ${who} (${kind})'s call is live: the page says Voice Connected and LiveKit has it ACTIVE with its microphone published`, live,
                        { inCall: await inCall(page), livekit: await lkPeople(room.id).catch(e => String(e)) }, 'fail');
                }
                await shot(page, `${mode}-${who}-call`);
            }
            for (const ctx of contexts) for (const p of ctx.pages()) await hangUp(p).catch(() => {});
            check('call: B\'s and C\'s own sign-ins and joins wrote no key: both channels\' epochs and rows are as D\'s join left them',
                JSON.stringify(keyState(room.id)) === JSON.stringify(roomBefore) && JSON.stringify(keyState(text.id)) === JSON.stringify(textBefore),
                { room: [roomBefore, keyState(room.id)], text: [textBefore, keyState(text.id)] });
        }
    } catch (e) {
        check('the walk ran to the end', false, String(e?.stack || e).slice(0, 800));
    } finally {
        for (const ctx of contexts) await ctx.close().catch(() => {});
    }
}

try {
    console.log(`INFO  APP=${APP} OLD_APP=${OLD_APP || '(not set)'} LiveKit=${LK ? LK.api : '(not set)'} B in ${fox ? 'Firefox' : 'Edge'} KEY_MS=${KEY_MS}`);
    mode = 'new';
    await walk(APP);
    if (OLD_APP) {
        mode = 'old';
        console.log('INFO  ── the same walk against OLD_APP (0.9.860, before the fix): the NEGATIVE CONTROL');
        await walk(OLD_APP);
        mode = 'new';
        check(`negative control (0.9.860): every check did what it must there (${tally.oldAsExpected} as required, ${tally.oldNot} not), and the checks the fix decides failed there (${tally.oldVoiceFails})`,
            tally.oldNot === 0 && tally.oldVoiceFails > 0);
    } else {
        console.log('INFO  OLD_APP not set: the negative control (0.9.860) was not walked');
    }
} finally {
    await edge.close().catch(() => {});
    if (fox) await fox.close().catch(() => {});
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures);
