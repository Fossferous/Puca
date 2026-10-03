// LIVE: four players and a spectator at one card table in one voice call,
// through the REAL web client and the REAL games server (docs/GAMES.md).
//
// games-walk.mjs proves the layout (two accounts, desktop + phone). This proves
// the two halves TOGETHER under play, and above all that no connection ever
// receives a card it may not see. Every WebSocket frame each page receives is
// recorded (page.on('websocket')) and scanned afterwards.
//
// The cast, all in one MESH voice call (fake media, --mute-audio):
//   P1  owner, desktop 1280x800 — opens and closes tables (MOVE_MEMBERS), and
//       switches games on and off in Server Settings
//   P2  desktop          P3  desktop          P4  phone 390x844 (isMobile, hasTouch)
//   S   spectator, desktop — in the call WITHOUT Play Games (@everyone loses
//       the bit; a "Players" role gives it back to P2..P4). S was online and
//       in the call BEFORE the owner switched games on.
//   OLD a raw socket that announces only `own_voice,presence` — a 0.9.832-era
//       client — in the same call, on its own account.
//
// What it plays and asserts (each prints PASS/FAIL; exit code = failures):
//   - games are off until the owner's switch; S (no Play Games) is offered no
//     Open and no Sit, only "Watch the table" once a table exists;
//   - Hold'em through the UI: >= 10 hands played to the end, including a
//     showdown, a hand where someone mucks, an all-in, a fold-out and a turn
//     the clock ran out (we let it expire);
//   - a player whose socket drops and reconnects inside the rejoin grace keeps
//     seat, stack and cards; one kept away past the grace is folded/stood and
//     must sit again;
//   - the moderator closes the table; a second table in the call is refused
//     INLINE (two people opening at once — or, if the race is lost, a raw
//     GameCreate on the app's own socket); Blackjack: >= 5 rounds with a
//     double (and a split when a pair comes);
//   - the owner switches games OFF: the table ends for everyone, worded;
//   - PRIVACY, from the recorded frames: the spectator never received a hole
//     card; no player ever received another player's hole card unless that
//     hand was shown (showdown / voluntary show); a mucked hand is never
//     revealed; the Blackjack hole card is "??" until the dealer turns it;
//     OLD received no game frame at all. The oracle (who holds which card) is
//     built from each player's OWN frames; a planted leak must be caught
//     (positive control).
//
// Prereqs: a THROWAWAY backend that plays games (APP_ENV=development, raised
// AUTH_RATE_LIMIT_PER_SECOND / _BURST, its own fresh database — never a real
// one, no LiveKit so the call is mesh) at API, and vite of THIS tree at APP
// started with VITE_API_URL=API. ~10 minutes (two turn clocks run out).
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5431 API=http://127.0.0.1:5331 OUT=<dir> node e2e/games-live.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP || 'http://127.0.0.1:5431';
const API = process.env.API || 'http://127.0.0.1:5331';
const WS_BASE = API.replace(/^http/, 'ws') + '/ws';
const OUT = process.env.OUT || 'e2e/shots-games-live';
const MIN_HANDS = Number(process.env.HANDS || 10);
const MAX_HANDS = Number(process.env.MAX_HANDS || 20);
const MIN_ROUNDS = Number(process.env.ROUNDS || 5);
const GRACE_MS = Number(process.env.GRACE_MS || 8000); // WS_REJOIN_GRACE_SECS on the backend
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const results = [];
const check = (name, ok, extra = '') => {
    const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  -- ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`;
    console.log(line.slice(0, 1200));
    results.push({ ok: !!ok, name, extra });
    if (!ok) failures++;
};
const note = (s) => console.log(`  . ${s}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
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
    await page.screenshot({ path: f }).catch(() => {});
    console.log('SHOT', f);
};
const CARD = /^[2-9TJQKA][cdhs]$/;

const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

// ── Recording ───────────────────────────────────────────────────────────────
/** One recorded page: every frame its app socket(s) received, in order. */
const recs = [];
const alerts = [];
function makeRec(label, page, phone) {
    const R = { label, page, phone, frames: [], sockets: 0, cur: null, userId: null, dropped: false, acted: null, ended: [] };
    page.on('websocket', (ws) => {
        if (!ws.url().startsWith(WS_BASE)) return;
        const sock = ++R.sockets;
        ws.on('framereceived', ({ payload }) => {
            if (typeof payload !== 'string') return;
            let m;
            try { m = JSON.parse(payload); } catch { return; }
            R.frames.push({ t: Date.now(), sock, m });
            const p = m.payload;
            if ((m.type === 'GameTable' || m.type === 'GameEvents') && p && p.view) R.cur = { table_id: p.table_id, version: p.version, view: p.view, at: Date.now() };
            if (m.type === 'GameEnded' && p) { R.ended.push(p.reason); if (R.cur && R.cur.table_id === p.table_id) R.cur = null; }
        });
    });
    page.on('console', m => fs.appendFileSync(path.join(OUT, 'console.txt'), `${new Date().toISOString()} ${label} ${m.type()} ${m.text().slice(0, 300)}\n`));
    page.on('pageerror', e => console.log(`  [${label} pageerror]`, e.message.slice(0, 200)));
    page.on('dialog', d => {
        // confirm() is the moderation / stand-up prompt: accept. An alert()
        // would be a refusal shown the wrong way: count it.
        if (d.type() === 'alert') { alerts.push(`${label}: ${d.message()}`); console.log(`  [${label} ALERT]`, d.message()); }
        d.type() === 'confirm' ? d.accept().catch(() => {}) : d.dismiss().catch(() => {});
    });
    recs.push(R);
    return R;
}
const gameFrames = (R, since = 0) => R.frames.filter(f => f.t >= since && typeof f.m.type === 'string' && f.m.type.startsWith('Game'));

// The app's sockets, remembered so a test can close one (a dropped
// connection) and hold the next ones off (a connection kept away past the
// rejoin grace): while __blockWs is set, the app's reconnects go to a port
// nothing listens on and fail at once, exactly like a dead network.
const SOCKET_HOOK = `(() => {
    const Orig = window.WebSocket;
    window.__appSockets = [];
    window.__blockWs = false;
    window.WebSocket = class extends Orig {
        constructor(url, protocols) {
            const u = String(url);
            const app = u.startsWith(${JSON.stringify(WS_BASE)});
            super(app && window.__blockWs ? 'ws://127.0.0.1:9/ws' : url, protocols);
            if (app) window.__appSockets.push(this);
        }
    };
})();`;

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

async function newPlayer(label, phone) {
    const ctx = await browser.newContext(phone
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
        : { viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(SOCKET_HOOK);
    const page = await ctx.newPage();
    const R = makeRec(label, page, phone);
    R.ctx = ctx;
    R.username = `gl${label.toLowerCase()}_${stamp}`;
    await page.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 60000 });
    await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(R.username);
    await page.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 60000 });
    await sleep(1500);
    await dismiss(page);
    return R;
}

const call = (page, mod, fn, args = []) => page.evaluate(async ({ mod, fn, args }) => {
    const m = await import(mod);
    return m[fn](...args);
}, { mod, fn, args });
const press = (R, loc, opts = {}) => (R.phone ? loc.tap(opts) : loc.click(opts));
const reload = async (R) => { await R.page.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500); await dismiss(R.page); };
const inCall = async (R) => (await R.page.locator('.voice-panel-compact .voice-connected-label').count()) > 0;

async function openServer(R, srvName) {
    if (R.phone) { await R.page.locator('.mobile-nav-btn').first().tap(); await sleep(400); }
    await press(R, R.page.locator(`.server-icon[title="${srvName}"]`));
    await sleep(800);
}
async function joinCall(R) {
    await press(R, R.page.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first());
    return !!await until(() => inCall(R), 20000);
}
/** The Games entry point: the VoiceStage header on a desktop (after the
 *  connected channel is clicked, which shows its stage), the voice panel's
 *  expanded controls on a phone. Returns its label, or null when not offered. */
async function entry(R) {
    if (!R.phone && !(await R.page.locator('.voice-stage').count())) {
        await R.page.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first().click();
        await sleep(400);
    }
    if (R.phone) {
        if (!(await R.page.locator('.vp-games').count())) return null;
        return (await R.page.locator('.vp-games').getAttribute('aria-label')) || (await R.page.locator('.vp-games').textContent());
    }
    const b = R.page.locator('.voice-stage-games');
    return (await b.count()) ? (await b.textContent()).trim() : null;
}
async function openTableView(R) {
    if (R.phone) {
        if (!(await R.page.locator('.vp-games').isVisible())) await R.page.locator('.vp-expand').tap();
        await R.page.locator('.vp-games').tap();
    } else {
        await R.page.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first().click(); // the stage
        await R.page.locator('.voice-stage-games').click();
    }
    await R.page.locator('.games-view').waitFor({ timeout: 15000 });
}
const noticeText = (R) => R.page.locator('.games-notice-text').textContent().catch(() => '');

/** Sit in the first open seat; the owner's disclosure comes first, once. */
async function sit(R, expectDisclosure) {
    await R.page.locator('.gseat-sit').first().waitFor({ timeout: 15000 });
    await press(R, R.page.locator('.gseat-sit').first());
    const disc = R.page.locator('.games-disclosure');
    const shown = !!await until(() => disc.isVisible(), expectDisclosure ? 5000 : 1200);
    if (expectDisclosure !== undefined) {
        check(`${R.label}: the disclosure ${expectDisclosure ? 'comes before the first sit, in the owner\'s words' : 'is not shown again'}`,
            expectDisclosure ? shown && (await disc.textContent()).includes('Chips are free and worth nothing. This server deals the cards and its operator could see them.') : !shown);
    }
    if (shown) await press(R, disc.getByRole('button', { name: 'Sit down' }));
    return !!await until(() => R.cur && R.cur.view.viewer_seat !== null, 10000);
}

// ── Hold'em through the UI ──────────────────────────────────────────────────
async function holdemAct(R, what) {
    const f = R.page.locator('.games-footer .games-actions');
    if (!await until(() => f.isVisible(), 6000)) return false;
    const row1 = f.locator('.games-actions-row').first();
    const fold = row1.getByRole('button', { name: 'Fold', exact: true });
    const chk = row1.getByRole('button', { name: 'Check', exact: true });
    const cal = row1.locator('button', { hasText: /^Call/ });
    const rse = row1.locator('button.games-btn-primary');
    const checkOrCall = async () => ((await chk.count()) ? press(R, chk) : press(R, cal));
    if (what === 'fold') await press(R, fold);
    else if (what === 'checkcall') await checkOrCall();
    else if (what === 'raise') { if (await rse.count()) await press(R, rse); else await checkOrCall(); }
    else if (what === 'allin') {
        const preset = f.locator('button.gpreset', { hasText: 'All-in' });
        if (await preset.count()) { await press(R, preset); await sleep(150); }
        if (await rse.count()) await press(R, rse); else await checkOrCall();
    }
    return true;
}

// ── Main ────────────────────────────────────────────────────────────────────
const summary = {};
let OLD = null;
try {
    const P1 = await newPlayer('P1', false);
    const S = await newPlayer('S', false);
    const P2 = await newPlayer('P2', false);
    const P3 = await newPlayer('P3', false);
    const P4 = await newPlayer('P4', true);
    const players = [P1, P2, P3, P4];
    const everyone = [P1, P2, P3, P4, S];

    // ── 0. Server, voice channel, roles: S keeps CONNECT but loses Play Games.
    const srvName = 'GL ' + stamp.slice(-4);
    const srv = await call(P1.page, '/src/api/servers.ts', 'createServer', [srvName]);
    const vc = await call(P1.page, '/src/api/servers.ts', 'createChannel', [srv.id, 'Table', 1]);
    const ROOM = `voice_${vc.id}`;
    const PLAY_GAMES = 1 << 28;
    const roles = await call(P1.page, '/src/api/servers.ts', 'listRoles', [srv.id]);
    const everyoneRole = roles.find(r => r.is_default);
    check('new servers give @everyone Play Games (DEFAULT_MEMBER)', !!everyoneRole && (everyoneRole.permissions & PLAY_GAMES) !== 0, everyoneRole);
    await call(P1.page, '/src/api/servers.ts', 'updateRole', [srv.id, everyoneRole.id, { permissions: everyoneRole.permissions & ~PLAY_GAMES }]);
    const playersRole = await call(P1.page, '/src/api/servers.ts', 'createRole', [srv.id, { name: 'Players', permissions: PLAY_GAMES }]);
    const inv = await call(P1.page, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);

    // S joins BEFORE games are switched on, and is in the call when they are.
    await call(S.page, '/src/api/servers.ts', 'joinViaInvite', [inv.code]);
    await reload(S);
    await reload(P1);
    await openServer(P1, srvName);
    await openServer(S, srvName);
    check('P1 (owner) joined the call', await joinCall(P1));
    check('S joined the call', await joinCall(S));
    await P1.page.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first().click();
    await S.page.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first().click();
    await sleep(1000);
    check('games are off by default: the call offers no table (owner)', (await entry(P1)) === null);

    // ── OLD: a 0.9.832-era client, a raw socket without the `games` cap, in the call.
    const oldCtx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const oldPage = await oldCtx.newPage();
    const oldUser = `glold_${stamp}`;
    await oldPage.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await oldPage.getByPlaceholder('Enter username').waitFor({ timeout: 60000 });
    await oldPage.locator('.toggle-mode').click();
    await oldPage.getByPlaceholder('Enter username').fill(oldUser);
    await oldPage.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await oldPage.locator('button.login-button[type="submit"]').click();
    await oldPage.waitForURL('**/chat', { timeout: 60000 });
    await call(oldPage, '/src/api/servers.ts', 'joinViaInvite', [inv.code]);
    const oldToken = await call(oldPage, '/src/api/auth.ts', 'getToken');
    await oldCtx.close(); // its own app socket goes; only the raw one below remains
    OLD = { frames: [], features: null, closed: null };
    OLD.ws = new WebSocket(`${WS_BASE}?caps=own_voice,presence&kind=desktop`, ['bearer', oldToken]);
    OLD.ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
        OLD.frames.push({ t: Date.now(), m });
        if (m.type === 'ServerFeatures') OLD.features = m.payload.features;
    });
    OLD.ws.addEventListener('close', (e) => { OLD.closed = e.code; });
    await until(() => OLD.ws.readyState === 1 && OLD.features, 10000);
    OLD.ws.send(JSON.stringify({ type: 'JoinRoom', payload: { room_id: ROOM } }));
    OLD.ping = setInterval(() => { try { OLD.ws.send(JSON.stringify({ type: 'Ping' })); } catch { /* closed */ } }, 20000);
    check('OLD (caps own_voice,presence) is in the call', !!await until(() => OLD.frames.some(f => f.m.type === 'RoomJoined' && f.m.payload?.room_id === ROOM), 10000));
    check('the server does not confirm `games` to OLD', Array.isArray(OLD.features) && !OLD.features.includes('games'), OLD.features);

    // ── 1. The owner switches games ON in Server Settings (the real control).
    await P1.page.locator('.server-settings-btn').first().click();
    const toggle = P1.page.locator('input[aria-label="Allow games in voice calls"]');
    await toggle.waitFor({ state: 'attached', timeout: 10000 });
    if (!(await toggle.isChecked())) await P1.page.locator('label.toggle-row', { hasText: 'Allow games in voice calls' }).click();
    await P1.page.getByRole('button', { name: 'Save Changes' }).click();
    check('owner: Server Settings saved with games on', !!await until(async () => (await P1.page.locator('body').innerText()).includes('Settings saved'), 8000));
    await P1.page.locator('.server-settings-content .close-btn').click();
    await P1.page.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 });

    // P2..P4 join now (their server rows are fresh) and get the Players role.
    for (const R of [P2, P3, P4]) { await call(R.page, '/src/api/servers.ts', 'joinViaInvite', [inv.code]); }
    const members = await call(P1.page, '/src/api/servers.ts', 'listMembersWithRoles', [srv.id]);
    for (const R of everyone) R.userId = members.find(m => m.username === R.username)?.id ?? null;
    check('every account is a member with a known id', everyone.every(R => typeof R.userId === 'number'), everyone.map(R => [R.label, R.userId]));
    for (const R of [P2, P3, P4]) await call(P1.page, '/src/api/servers.ts', 'assignRole', [srv.id, R.userId, playersRole.id]);
    for (const R of [P2, P3, P4]) { await reload(R); await openServer(R, srvName); check(`${R.label} joined the call`, await joinCall(R)); }

    // ── 2. S has no Play Games: no Open, and (no table yet) nothing at all.
    await S.page.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first().click();
    await sleep(800);
    check('S (no Play Games): no table is offered while the call has none', (await entry(S)) === null);

    // ── 3. P1 opens Hold'em from the stage.
    await P1.page.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first().click();
    check('owner: the stage offers "Open a table"', /Open a table/.test(await until(() => entry(P1), 10000) || ''));
    await openTableView(P1);
    await shot(P1.page, '01-p1-open-panel');
    await P1.page.getByRole('button', { name: /Open a Poker table/ }).click();
    check('owner: a Poker table opened', !!await until(async () => (await P1.page.locator('.gtable-holdem').count()) > 0, 10000));
    const HOLDEM_ID = P1.cur?.table_id;

    // S was online, in the call, BEFORE the owner switched games on: its
    // server row still says games_enabled=false. The open table is the
    // server's own word that this call plays games.
    const sEntry = await until(() => entry(S), 8000);
    check('S (online since before games were on, no reload): the open table is offered as "Watch the table"', /Watch the table/.test(sEntry || ''), sEntry);
    if (!/Watch the table/.test(sEntry || '')) {
        note('S reloads to pick up games_enabled (the stale-row finding above)');
        await reload(S); await openServer(S, srvName);
        await S.page.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first().click();
        await until(() => entry(S), 10000);
    }
    await openTableView(S);
    check('S: watching — no Sit button and no Open panel, worded as watching', await until(async () =>
        (await S.page.locator('.gtable-holdem').count()) > 0
        && (await S.page.locator('.gseat-sit').count()) === 0
        && (await S.page.locator('.games-open').count()) === 0
        && /You are watching this table/.test(await S.page.locator('.games-footer').textContent()), 8000));
    await shot(S.page, '02-s-watching-no-sit');

    for (const R of [P2, P3, P4]) {
        check(`${R.label}: the call offers "Join the table"`, /Join the table/.test(await until(() => entry(R), 10000) || ''));
        await openTableView(R);
    }
    // Sit one by one (seat_taken races are not what this run is about).
    check('P1 seated', await sit(P1, true));
    check('P2 seated', await sit(P2, true));
    check('P3 seated', await sit(P3, true));
    check('P4 (phone) seated', await sit(P4, true));
    await shot(P4.page, '03-p4-phone-seated');

    // ── 4. Play. Scenarios by hand number; the driver reads each player's own
    // view (from its recorded frames) and acts through that player's UI.
    const SCEN = { 1: 'checkdown', 2: 'foldout', 3: 'allin', 4: 'timeout', 5: 'checkdown', 6: 'foldout', 7: 'checkdown', 8: 'allin' };
    const scen = (h) => SCEN[h] || 'checkdown';
    const hs = {};
    const handsEnded = new Set();
    const stats = { showdowns: 0, mucks: 0, allins: 0, foldouts: 0, timeouts: 0 };
    const seenEvents = new Set();
    const tally = () => {
        // From P1's frames (a seated player sees every public event).
        for (const f of gameFrames(P1)) {
            if (f.m.type !== 'GameEvents' || f.m.payload.table_id !== HOLDEM_ID) continue;
            const key = f.m.payload.version;
            if (seenEvents.has(key)) continue;
            seenEvents.add(key);
            const hand = f.m.payload.view.hand_no;
            for (const e of f.m.payload.events) {
                if (e.type === 'hand_ended') { handsEnded.add(e.hand_no); if (!(hs[e.hand_no] || {}).showdown) stats.foldouts++; }
                if (e.type === 'showdown') { stats.showdowns++; stats.mucks += e.mucked.length; (hs[hand] ||= {}).showdown = true; }
                if (e.type === 'acted' && e.reason === 'timeout') stats.timeouts++;
                if (e.type === 'acted' && e.all_in) stats.allins++;
            }
        }
    };
    let within = null, past = null;
    const fin = { within: false, past: false };
    const t0 = Date.now();
    let lastHousekeeping = 0;
    for (;;) {
        tally();
        const done = handsEnded.size >= MIN_HANDS && stats.showdowns > 0 && stats.mucks > 0 && stats.allins > 0 && stats.foldouts > 0 && stats.timeouts > 0 && fin.within && fin.past;
        if (done || handsEnded.size >= MAX_HANDS) break;
        if (Date.now() - t0 > 25 * 60_000) { note('hold\'em ran out of time'); break; }

        // The grace tests, each at the start of its hand, while the player is
        // dealt in and NOT the one to act.
        const v1 = P1.cur?.view;
        if (v1 && v1.game === 'holdem' && v1.in_hand) {
            if (!within && v1.hand_no >= 5) {
                const v3 = P3.cur?.view;
                if (v3 && v3.hand_no === v1.hand_no && v3.viewer_seat !== null && v3.to_act !== v3.viewer_seat && v3.seats[v3.viewer_seat]?.cards && v3.seats[v3.viewer_seat].cards[0] !== '??') {
                    within = graceWithin(P3, [P1, P2, P4, S]).finally(() => { fin.within = true; });
                }
            }
            if (!past && fin.within && v1.hand_no >= 7) {
                const v2 = P2.cur?.view;
                if (v2 && v2.hand_no === v1.hand_no && v2.viewer_seat !== null && v2.to_act !== v2.viewer_seat && v2.seats[v2.viewer_seat]?.cards) {
                    past = gracePast(P2, [P1, P3, P4, S]).finally(() => { fin.past = true; });
                }
            }
        }

        let actedNow = false;
        for (const R of players) {
            if (R.dropped) continue;
            const v = R.cur?.view;
            if (!v || v.game !== 'holdem' || !v.in_hand || !v.legal || !v.turn || v.to_act !== v.viewer_seat) continue;
            const key = `${v.hand_no}:${v.turn.turn_seq}`;
            if (R.acted === key) continue;
            R.acted = key;
            const h = (hs[v.hand_no] ||= {});
            const sc = scen(v.hand_no);
            let what = 'checkcall';
            if (sc === 'foldout') { what = h.raised ? 'fold' : 'raise'; h.raised = true; }
            else if (sc === 'allin') { if (!h.shoved) { what = 'allin'; h.shoved = R.label; } else if (!h.called) { what = 'checkcall'; h.called = R.label; } else what = 'fold'; }
            else if (sc === 'timeout' && !h.waited) {
                h.waited = R.label;
                note(`hand ${v.hand_no}: ${R.label} lets the ${v.config.turn_clock_secs}s clock run out`);
                if (!h.shotClock) { h.shotClock = true; await sleep(1500); await shot(R.page, `04-${R.label}-clock-running`); }
                continue;
            }
            if (v.hand_no === 3 && R.phone && !summary.phoneTurnShot) { summary.phoneTurnShot = true; await shot(R.page, '05-p4-phone-turn'); }
            const ok = await holdemAct(R, what);
            if (!ok) R.acted = null; // the bar never showed: try again on the next pass
            actedNow = true;
        }

        // Between hands: the busted rebuy, anyone sat out sits back in.
        if (Date.now() - lastHousekeeping > 1500) {
            lastHousekeeping = Date.now();
            for (const R of players) {
                if (R.dropped) continue;
                const v = R.cur?.view;
                if (!v || v.game !== 'holdem' || v.viewer_seat === null) continue;
                const reb = R.page.locator('.games-seat-row button', { hasText: /^Rebuy/ });
                if (await reb.count()) { note(`${R.label} rebuys`); await press(R, reb).catch(() => {}); }
                const back = R.page.locator('.games-seat-row button', { hasText: 'Sit back in' });
                if (await back.count()) { note(`${R.label} sits back in`); await press(R, back).catch(() => {}); }
            }
        }
        if (!actedNow) await sleep(200);
    }
    if (within) await within;
    if (past) await past;
    check('the in-grace drop ran', fin.within);
    check('the past-grace drop ran', fin.past);
    tally();
    summary.holdem = { hands_ended: handsEnded.size, ...stats };
    check(`Hold'em: >= ${MIN_HANDS} hands played to the end`, handsEnded.size >= MIN_HANDS, summary.holdem);
    check('Hold\'em: at least one showdown', stats.showdowns > 0, stats);
    check('Hold\'em: at least one mucked hand (so "never revealed" is not vacuous)', stats.mucks > 0, stats);
    check('Hold\'em: at least one all-in', stats.allins > 0, stats);
    check('Hold\'em: at least one fold-out (hand won without a showdown)', stats.foldouts > 0, stats);
    check('Hold\'em: at least one turn decided by the clock running out', stats.timeouts > 0, stats);
    await shot(P1.page, '06-p1-desktop-holdem');
    await shot(P4.page, '07-p4-phone-holdem');
    await shot(S.page, '08-s-spectator-holdem');

    // ── 5. The moderator closes the table.
    await P1.page.getByRole('button', { name: 'Close table' }).click();
    check('closing ends the table for EVERYONE, worded (moderator path)', !!await until(async () => {
        for (const R of everyone) if (!/A moderator closed the table/.test(await noticeText(R))) return false;
        return true;
    }, 10000));
    check('S (no Play Games): with no table there is still no Open panel', (await S.page.locator('.games-open').count()) === 0);
    check('everyone received GameEnded "closed"', everyone.every(R => R.ended.includes('closed')), everyone.map(R => [R.label, R.ended]));

    // ── 6. One table per call: two people open at once.
    for (const R of [P1, P2]) {
        await R.page.getByRole('radio', { name: /Blackjack/ }).click();
    }
    const go1 = P1.page.getByRole('button', { name: /Open a Blackjack table/ });
    const go2 = P2.page.getByRole('button', { name: /Open a Blackjack table/ });
    await go1.waitFor({ timeout: 5000 });
    await go2.waitFor({ timeout: 5000 });
    // Both presses fired together (a DOM click each, no actionability wait in
    // between), so both GameCreates are on the wire before either table lands.
    await Promise.all([go1.evaluate(b => b.click()).catch(() => {}), go2.evaluate(b => b.click()).catch(() => {})]);
    const refusedInline = async () => {
        for (const R of [P1, P2]) if (/A Blackjack table is already open in this call; it has to close before another game can start\./.test(await noticeText(R))) return R.label;
        return null;
    };
    let loser = await until(refusedInline, 4000);
    let path = 'two players opening at once';
    if (!loser) {
        path = 'race lost: a raw GameCreate on P2\'s own app socket';
        await P2.page.evaluate((frame) => {
            const ws = [...window.__appSockets].reverse().find(w => w.readyState === 1);
            ws && ws.send(JSON.stringify(frame));
        }, { type: 'GameCreate', payload: { room_id: ROOM, kind: 'holdem', config: {} } });
        loser = await until(async () => (/already open in this call/.test(await noticeText(P2)) ? 'P2' : null), 6000);
    }
    check(`a second table in the call is refused INLINE in the owner's words (${path})`, !!loser, { loser });
    check('no alert() for the refusal', alerts.length === 0, alerts);
    if (loser) await shot((loser === 'P1' ? P1 : P2).page, '09-refused-inline');
    const BJ_ID = await until(() => P1.cur && P1.cur.view.game === 'blackjack' && P1.cur.table_id, 8000);
    check('a Blackjack table is open for everyone', !!BJ_ID && !!await until(async () => {
        for (const R of everyone) if (!(await R.page.locator('.gtable-blackjack').count())) return false;
        return true;
    }, 10000));
    for (const R of players) check(`${R.label} sat at Blackjack (no disclosure the second time)`, await sit(R, false));
    check('S: still no Sit at Blackjack', (await S.page.locator('.gseat-sit').count()) === 0);

    // ── 7. Blackjack rounds.
    const bj = { rounds: 0, doubles: 0, splits: 0, hits: 0, stands: 0 };
    const bjSeen = new Set();
    const bjTally = () => {
        for (const f of gameFrames(P1)) {
            if (f.m.type !== 'GameEvents' || f.m.payload.table_id !== BJ_ID || bjSeen.has(f.m.payload.version)) continue;
            bjSeen.add(f.m.payload.version);
            for (const e of f.m.payload.events) {
                if (e.type === 'round_ended') bj.rounds++;
                if (e.type === 'acted') bj[e.action === 'split' ? 'splits' : e.action === 'double' ? 'doubles' : e.action === 'hit' ? 'hits' : 'stands']++;
            }
        }
    };
    const bt0 = Date.now();
    for (;;) {
        bjTally();
        if (bj.rounds >= MIN_ROUNDS && (bj.doubles + bj.splits) > 0) break;
        if (bj.rounds >= MIN_ROUNDS * 3 || Date.now() - bt0 > 10 * 60_000) break;
        let did = false;
        for (const R of players) {
            const v = R.cur?.view;
            if (!v || v.game !== 'blackjack' || v.viewer_seat === null) continue;
            const me = v.seats[v.viewer_seat];
            if (!me) continue;
            if (!v.in_round && me.pending_bet === 0 && !me.sitting_out && R.betRound !== v.round_no) {
                const betBtn = R.page.locator('.games-footer .games-actions-row').first().locator('button.games-btn-primary', { hasText: /^Bet / });
                if (await betBtn.count()) { R.betRound = v.round_no; await press(R, betBtn); did = true; }
                continue;
            }
            if (v.in_round && v.legal && v.turn && v.to_act && v.to_act.seat === v.viewer_seat) {
                const key = `${v.turn.hand_no}:${v.turn.turn_seq}`;
                if (R.acted === key) continue;
                R.acted = key;
                const hand = me.hands[v.to_act.hand];
                const name = v.legal.can_split ? 'Split'
                    : (v.legal.can_double && bj.doubles === 0) ? 'Double'
                    : (hand && hand.total < 15 && v.legal.can_hit) ? 'Hit' : 'Stand';
                if (R.phone && !summary.bjPhoneShot) { summary.bjPhoneShot = true; await shot(R.page, '10-p4-phone-blackjack-turn'); }
                const b = R.page.locator('.games-footer .games-actions button', { hasText: new RegExp(`^${name}$`) });
                if (!await until(async () => (await b.count()) && await b.isEnabled(), 5000)) { R.acted = null; continue; }
                await press(R, b);
                did = true;
            }
        }
        if (!did) await sleep(200);
    }
    bjTally();
    summary.blackjack = bj;
    check(`Blackjack: >= ${MIN_ROUNDS} rounds played to the end`, bj.rounds >= MIN_ROUNDS, bj);
    check('Blackjack: a double or a split was played', bj.doubles + bj.splits > 0, bj);
    await shot(P1.page, '11-p1-desktop-blackjack');
    await shot(P4.page, '12-p4-phone-blackjack');

    // ── 8. The owner switches games OFF: the table ends for everyone, worded.
    await P1.page.locator('.server-settings-btn').first().click();
    await toggle.waitFor({ state: 'attached', timeout: 10000 });
    if (await toggle.isChecked()) await P1.page.locator('label.toggle-row', { hasText: 'Allow games in voice calls' }).click();
    check('owner: the switch turns off', !(await toggle.isChecked()));
    await P1.page.getByRole('button', { name: 'Save Changes' }).click();
    await until(async () => (await P1.page.locator('body').innerText()).includes('Settings saved'), 8000);
    await P1.page.locator('.server-settings-content .close-btn').click();
    check('games off: every page received GameEnded "disabled"', !!await until(() => everyone.every(R => R.ended.includes('disabled')), 10000), everyone.map(R => [R.label, R.ended]));
    check('games off: the reason is shown at the table for everyone', !!await until(async () => {
        for (const R of everyone) if (!/The server owner switched games off\./.test(await noticeText(R))) return false;
        return true;
    }, 10000));
    // Their cached server rows still said games were on: the server's
    // `disabled` ending makes the client refetch them, so nobody is left
    // looking at an "Open a table" the server would refuse.
    check('games off: nobody is offered "Open a table" any more (stale server rows refetched)', !!await until(async () => {
        for (const R of everyone) if (await R.page.locator('.games-open').count()) return false;
        return true;
    }, 8000));
    await shot(P4.page, '13-p4-phone-games-off');
    await shot(S.page, '14-s-games-off');
    check('everyone is still in the call after all of it', (await Promise.all(everyone.map(inCall))).every(Boolean));
    check('no alert() at any point', alerts.length === 0, alerts);

    // ── 9. PRIVACY, from every recorded frame.
    privacy({ HOLDEM_ID, BJ_ID, players, S });
} catch (e) {
    check('live run reached the end', false, String(e && e.stack || e).slice(0, 900));
} finally {
    if (OLD) {
        clearInterval(OLD.ping);
        const g = OLD.frames.filter(f => typeof f.m.type === 'string' && f.m.type.startsWith('Game'));
        const roomTraffic = OLD.frames.filter(f => !['ServerFeatures', 'Pong', 'RoomJoined'].includes(f.m.type)).length;
        check('OLD (no `games` cap) received ZERO game frames through the whole run', g.length === 0, { game: g.length, total: OLD.frames.length });
        check('...while it stayed connected and in the room (positive control: it got other room traffic)', OLD.closed === null && roomTraffic > 0, { closed: OLD.closed, roomTraffic });
        fs.writeFileSync(path.join(OUT, 'frames-OLD.jsonl'), OLD.frames.map(f => JSON.stringify(f)).join('\n'));
        try { OLD.ws.close(); } catch { /* gone */ }
    }
    for (const R of recs) fs.writeFileSync(path.join(OUT, `frames-${R.label}.jsonl`), R.frames.map(f => JSON.stringify(f)).join('\n'));
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ summary, results, failures }, null, 2));
    await browser.close();
}
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures);

// ── The grace tests ─────────────────────────────────────────────────────────
/** Drop R's socket and let the app reconnect at once (inside the grace). */
async function graceWithin(R, others) {
    R.dropped = true;
    const v = R.cur.view;
    const seat = v.viewer_seat;
    const before = { hand: v.hand_no, cards: [...v.seats[seat].cards], stack: v.seats[seat].stack, sockets: R.sockets };
    const t0 = Date.now();
    note(`grace: ${R.label} (seat ${seat}) drops its socket in hand ${before.hand}`);
    await R.page.evaluate(() => { const ws = window.__appSockets.filter(w => w.readyState === 1).pop(); ws && ws.close(); });
    const back = await until(() => {
        if (R.sockets <= before.sockets) return null;
        const f = gameFrames(R, t0).filter(f => f.sock > before.sockets && f.m.payload?.view && f.m.payload.table_id === R.cur?.table_id);
        return f.length ? f[f.length - 1].m.payload.view : null;
    }, GRACE_MS + 6000, 100);
    const backMs = Date.now() - t0;
    const sameHand = back && back.hand_no === before.hand;
    check(`grace: ${R.label} reconnected inside the ${GRACE_MS / 1000}s grace and was resynced on the NEW socket`, !!back && backMs < GRACE_MS, { backMs });
    check(`grace: ${R.label} kept its seat`, !!back && back.viewer_seat === seat, { seat, now: back?.viewer_seat });
    check(`grace: ${R.label} kept its hole cards (same hand) and stack`, !!back && (!sameHand || (JSON.stringify(back.seats[seat].cards) === JSON.stringify(before.cards))) && (!sameHand || back.seats[seat].stack <= before.stack),
        { before, after: back && { hand: back.hand_no, cards: back.seats[seat]?.cards, stack: back.seats[seat]?.stack } });
    const sawAway = others.some(O => gameFrames(O, t0).some(f => f.m.payload?.view?.seats?.[seat]?.away === true));
    const awayCleared = await until(() => others.every(O => O.cur && O.cur.view.seats[seat] && O.cur.view.seats[seat].away === false), 5000);
    check(`grace: the others saw ${R.label}'s seat marked away, then back`, sawAway && !!awayCleared);
    const foldedForIt = others.some(O => gameFrames(O, t0).some(f => (f.m.payload?.events || []).some(e => e.type === 'acted' && e.seat === seat && e.reason === 'left')));
    check(`grace: ${R.label} was NOT folded for the blip`, !foldedForIt);
    R.dropped = false;
    return true;
}

/** Drop R's socket and keep it away past the grace: folded and stood. */
async function gracePast(R, others) {
    R.dropped = true;
    const v = R.cur.view;
    const seat = v.viewer_seat;
    const hand = v.hand_no;
    const sockets = R.sockets;
    const t0 = Date.now();
    note(`grace: ${R.label} (seat ${seat}) goes away for ${(GRACE_MS + 6000) / 1000}s in hand ${hand}`);
    await R.page.evaluate(() => { window.__blockWs = true; const ws = window.__appSockets.filter(w => w.readyState === 1).pop(); ws && ws.close(); });
    await sleep(GRACE_MS + 6000);
    const leftEv = others.flatMap(O => gameFrames(O, t0)).flatMap(f => (f.m.payload?.events || []).map(e => ({ e, t: f.t })))
        .find(({ e }) => (e.type === 'acted' && e.seat === seat && e.reason === 'left') || (e.type === 'player_left' && e.seat === seat));
    check(`past the grace: ${R.label} was folded / stood by the server (only after the grace)`, !!leftEv && leftEv.t - t0 >= GRACE_MS - 500, leftEv ? { event: leftEv.e, afterMs: leftEv.t - t0 } : 'no left/player_left event');
    await R.page.evaluate(() => { window.__blockWs = false; });
    const back = await until(() => R.sockets > sockets && gameFrames(R, t0).some(f => f.sock > sockets && f.m.payload?.view), 40000, 200);
    check(`past the grace: ${R.label}'s app reconnected once the network came back`, !!back);
    const stood = await until(() => R.cur && R.cur.view.viewer_seat === null, 40000, 200);
    check(`past the grace: ${R.label} is no longer seated (watching) once the hand is over`, !!stood, R.cur && { viewer_seat: R.cur.view.viewer_seat, in_hand: R.cur.view.in_hand });
    await shot(R.page, '15-past-grace-stood');
    check(`past the grace: ${R.label} sits again (no disclosure the second time)`, await sit(R, false));
    R.dropped = false;
    return true;
}

// ── Privacy oracle ──────────────────────────────────────────────────────────
function strings(x, out = []) {
    if (typeof x === 'string') out.push(x);
    else if (Array.isArray(x)) for (const y of x) strings(y, out);
    else if (x && typeof x === 'object') for (const y of Object.values(x)) strings(y, out);
    return out;
}

/**
 * Scan one recorder's frames for Hold'em leaks. `owners` maps
 * `${table}:${hand}` to [{seat, user, cards}] built from each player's OWN
 * frames. `revealAt` maps `${hand}:${seat}` to the table VERSION of the frame
 * whose public events showed that hand (showdown / shown): from that version
 * on the cards are public, also to someone who joined the call afterwards and
 * learned them from a GameTable rather than the event. Versions are the
 * server's one order for the table, identical on every connection.
 */
function scanHoldem(R, tableId, owners, revealAt) {
    const shownBy = (hand, seat, version) => revealAt.has(`${hand}:${seat}`) && version >= revealAt.get(`${hand}:${seat}`);
    const leaks = [];
    let scanned = 0, foreignShown = 0, nonGameCards = 0;
    for (const f of R.frames) {
        const m = f.m;
        const isGame = typeof m.type === 'string' && m.type.startsWith('Game');
        if (!isGame) {
            for (const s of strings(m)) if (CARD.test(s)) nonGameCards++;
            continue;
        }
        const p = m.payload || {};
        if (p.table_id !== tableId || !p.view || p.view.game !== 'holdem') continue;
        const hand = p.view.hand_no;
        const viewer = p.view.viewer_seat;
        // Structural: another seat's cards are '??' unless that hand was shown.
        p.view.seats.forEach((s, i) => {
            if (!s || !s.cards || i === viewer) return;
            for (const c of s.cards) if (c !== '??' && !shownBy(hand, i, p.version)) leaks.push({ why: 'structural', hand, seat: i, card: c, v: p.version });
        });
        // Ownership: every card code in the frame that is someone else's hole card.
        const own = owners.get(`${tableId}:${hand}`) || [];
        for (const c of strings(p)) {
            if (!CARD.test(c)) continue;
            scanned++;
            const o = own.find(o => o.cards.includes(c));
            if (!o || o.user === R.userId) continue;
            if (shownBy(hand, o.seat, p.version)) { foreignShown++; continue; }
            leaks.push({ why: 'owner', hand, seat: o.seat, card: c, v: p.version });
        }
    }
    return { leaks, scanned, foreignShown, nonGameCards };
}

function privacy({ HOLDEM_ID, BJ_ID, players, S }) {
    // The oracle: each seat's hole cards per hand, from the player's OWN frames.
    const owners = new Map();
    for (const R of players) {
        for (const f of gameFrames(R)) {
            const p = f.m.payload;
            if (!p?.view || p.table_id !== HOLDEM_ID || p.view.game !== 'holdem' || p.view.viewer_seat === null) continue;
            const s = p.view.seats[p.view.viewer_seat];
            if (!s || !s.cards || s.cards[0] === '??' || s.user_id !== R.userId) continue;
            const k = `${HOLDEM_ID}:${p.view.hand_no}`;
            const list = owners.get(k) || [];
            if (!list.some(o => o.seat === p.view.viewer_seat)) list.push({ seat: p.view.viewer_seat, user: R.userId, cards: [...s.cards], label: R.label });
            owners.set(k, list);
        }
    }
    // When each hand became public: the first version whose events showed it.
    const revealAt = new Map();
    for (const R of [...players, S]) {
        for (const f of gameFrames(R)) {
            const p = f.m.payload;
            if (p?.table_id !== HOLDEM_ID || !p.view) continue;
            for (const e of p.events || []) {
                const seats = e.type === 'showdown' ? e.shown.map(s => s.seat) : e.type === 'shown' ? [e.seat] : [];
                for (const seat of seats) {
                    const k = `${p.view.hand_no}:${seat}`;
                    if (!revealAt.has(k) || revealAt.get(k) > p.version) revealAt.set(k, p.version);
                }
            }
        }
    }
    // Coverage: every seat dealt in each hand has a known owner.
    let dealt = 0, unknown = 0;
    for (const f of gameFrames(S)) {
        for (const e of f.m.payload?.events || []) {
            if (e.type !== 'hand_started' || f.m.payload.table_id !== HOLDEM_ID) continue;
            for (const seat of e.dealt) { dealt++; if (!(owners.get(`${HOLDEM_ID}:${e.hand_no}`) || []).some(o => o.seat === seat)) unknown++; }
        }
    }
    check('oracle: hole cards known from their owners\' own frames for (nearly) every dealt seat', dealt > 0 && unknown <= 2, { dealt, unknown, hands: owners.size });

    // Positive control: a planted leak in a copy of S's frames MUST be caught.
    const someHand = [...owners.entries()].find(([, l]) => l.length >= 2);
    if (someHand) {
        const [k, l] = someHand;
        const hand = Number(k.split(':')[1]);
        const fake = { label: 'S-planted', userId: S.userId, frames: [{ t: 0, m: { type: 'GameEvents', payload: { table_id: HOLDEM_ID, version: 1, events: [], view: { game: 'holdem', hand_no: hand, viewer_seat: null, seats: [{ seat: l[0].seat, cards: [l[0].cards[0], '??'] }] } } } }] };
        check('POSITIVE CONTROL: a hole card planted in a spectator frame is caught as a leak', scanHoldem(fake, HOLDEM_ID, owners, revealAt).leaks.length > 0);
    } else check('POSITIVE CONTROL: a hand with two known owners exists to plant into', false);

    for (const R of [...players, S]) {
        const r = scanHoldem(R, HOLDEM_ID, owners, revealAt);
        summary[`privacy_${R.label}`] = { scanned: r.scanned, foreignShownLegit: r.foreignShown, leaks: r.leaks.length, nonGameCardStrings: r.nonGameCards, frames: R.frames.length };
        const who = R === S ? 'the SPECTATOR never received a hole card' : `${R.label} never received another player's unshown hole card`;
        check(`privacy: ${who}`, r.leaks.length === 0, { ...summary[`privacy_${R.label}`], first: r.leaks.slice(0, 3) });
        check(`privacy: ${R.label}'s non-game frames carry no card codes`, r.nonGameCards === 0, r.nonGameCards);
    }
    if (S) {
        const r = summary.privacy_S;
        check('privacy: the spectator scan actually scanned cards (board/shown), so its 0 is not vacuous', r.scanned > 0, r);
    }

    // Mucked hands: never shown to anyone but their owner.
    const mucked = [];
    for (const f of gameFrames(players[0])) {
        const p = f.m.payload;
        if (p?.table_id !== HOLDEM_ID) continue;
        for (const e of p.events || []) if (e.type === 'showdown') for (const seat of e.mucked) mucked.push({ hand: p.view.hand_no, seat });
    }
    let muckViolations = 0, muckKnown = 0;
    for (const { hand, seat } of mucked) {
        const o = (owners.get(`${HOLDEM_ID}:${hand}`) || []).find(o => o.seat === seat);
        if (!o) continue;
        muckKnown++;
        for (const R of [...players, S]) {
            if (R.userId === o.user) continue;
            for (const f of gameFrames(R)) {
                const p = f.m.payload;
                if (p?.table_id !== HOLDEM_ID || !p.view || p.view.hand_no !== hand) continue;
                if (strings(p).some(c => o.cards.includes(c))) muckViolations++;
            }
        }
    }
    summary.mucked = { mucked: mucked.length, checked: muckKnown, violations: muckViolations };
    check('privacy: no mucked hand was ever revealed to anyone but its owner', mucked.length > 0 && muckKnown > 0 && muckViolations === 0, summary.mucked);

    // Blackjack: the dealer's hole card stays '??' until the dealer turns it.
    let bjFrames = 0, holeChecked = 0, holeBad = 0, revealedRounds = 0;
    for (const R of [...players, S]) {
        for (const f of gameFrames(R)) {
            const p = f.m.payload;
            if (p?.table_id !== BJ_ID || !p.view || p.view.game !== 'blackjack') continue;
            bjFrames++;
            const d = p.view.dealer;
            if (p.view.dealer_total === null && d.length >= 2) { holeChecked++; if (d.slice(1).some(c => c !== '??')) holeBad++; }
            for (const e of p.events || []) {
                if (e.type === 'card_dealt' && e.seat === null && p.view.dealer_total === null && d.length === 2 && e.card !== '??' && e.card !== d[0]) holeBad++;
                if (e.type === 'dealer_revealed' && R === S) revealedRounds++;
            }
        }
    }
    summary.blackjack_privacy = { bjFrames, holeChecked, holeBad, revealedRoundsSeenByS: revealedRounds };
    check('privacy: the Blackjack hole card was "??" in every view until the dealer turned it', holeChecked > 0 && holeBad === 0 && revealedRounds > 0, summary.blackjack_privacy);
}
