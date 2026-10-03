// LIVE: games as Discord-style ACTIVITIES (docs/GAMES.md, *Activities*) -
// four players, a spectator and an old client in one voice call, through the
// REAL web client and the REAL games server, with NO reload anywhere.
//
// games-walk.mjs proves the layout (two accounts, desktop + phone). This proves
// the two halves TOGETHER under play: that everyone in the call sees an
// activity start, live; that the owner's switch reaches everyone live; and
// above all that no connection ever receives a card it may not see. Every
// WebSocket frame each page receives is recorded (page.on('websocket')) and
// scanned afterwards.
//
// The cast, all in one MESH voice call (fake media, --mute-audio):
//   P1  owner, desktop 1280x800 - starts activities from the launcher, closes
//       a table (MOVE_MEMBERS), switches games off and on in Server Settings
//   P2  desktop          P3  desktop          P4  phone 390x844 (isMobile, hasTouch)
//   S   spectator, desktop - in the call WITHOUT Play Games (@everyone loses
//       the bit; a "Players" role gives it back to P2..P4 - while they are
//       already in the call, so the launcher must appear for them LIVE)
//   OLD a raw socket that announces only `own_voice,presence` - a 0.9.832-era
//       client - in the same call, on its own account.
//
// What it asserts (each prints PASS/FAIL; exit code = failures):
//   - games are AVAILABLE BY DEFAULT: a fresh server has games_enabled, the
//     owner's launcher is there at once; a role granting Play Games while P2..P4
//     sit in the call brings their launcher live; S never has one;
//   - P1 starts Poker from the launcher (the picker's card) and is seated; EVERY
//     other page shows the notice ("<P1> started Poker", Join for the players,
//     Watch only for S), the activity TILE in the call grid and the sidebar's
//     playing marks within a second or two - measured, no reload;
//   - they Join from the tile and the notice; Hold'em: >= 10 hands to the end,
//     a showdown, a muck, an all-in, a fold-out, a clock that runs out; a socket
//     drop inside the rejoin grace (seat, stack and cards kept) and one kept away
//     past it (folded, stood, sits again); "Back to call" and back keeps the seat
//     (on the phone the composer returns on the call and goes at the table);
//   - the owner switches games OFF: the table ends for everyone at once
//     (GameEnded disabled on every page), the tile, the marks and the notice go,
//     the launcher goes everywhere (GamesEnabled pushed); ON: the launcher comes
//     back everywhere - no reload;
//   - P1 starts Blackjack from the launcher the same way; everyone joins; a
//     second activity in the call is refused INLINE; >= 5 rounds with a double or
//     a split; when everyone has bet the deal comes ~1.5 s after the last bet;
//   - the moderator closes the table: tile, marks and notice gone everywhere;
//   - PRIVACY, from the recorded frames: the spectator never received a hole
//     card; no player ever received another player's hole card unless that hand
//     was shown; a mucked hand is never revealed; the Blackjack hole card is
//     "??" until the dealer turns it; OLD received no game frame and no settings
//     frame at all. The oracle (who holds which card) is built from each
//     player's OWN frames; a planted leak must be caught (positive control).
//
// Prereqs: a THROWAWAY backend that plays games (APP_ENV=development, raised
// AUTH_RATE_LIMIT_PER_SECOND / _BURST, its own fresh database - never a real
// one, no LiveKit so the call is mesh) at API, and vite of THIS tree at APP
// started with VITE_API_URL=API. ~12 minutes (two turn clocks run out).
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5481 API=http://127.0.0.1:5381 OUT=<dir> node e2e/games-live.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP || 'http://127.0.0.1:5481';
const API = process.env.API || 'http://127.0.0.1:5381';
const WS_BASE = API.replace(/^http/, 'ws') + '/ws';
const OUT = process.env.OUT || 'e2e/shots-games-live';
const MIN_HANDS = Number(process.env.HANDS || 10);
const MAX_HANDS = Number(process.env.MAX_HANDS || 20);
const MIN_ROUNDS = Number(process.env.ROUNDS || 5);
const GRACE_MS = Number(process.env.GRACE_MS || 8000); // WS_REJOIN_GRACE_SECS on the backend
/** "Within a second or two": every page shows a started activity this soon. */
const LIVE_MS = Number(process.env.LIVE_MS || 2500);
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
    const R = { label, page, phone, frames: [], sockets: 0, cur: null, userId: null, dropped: false, acted: null, ended: [], switched: [] };
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
            if (m.type === 'GameEnded' && p) { R.ended.push({ reason: p.reason, t: Date.now() }); if (R.cur && R.cur.table_id === p.table_id) R.cur = null; }
            if (m.type === 'GamesEnabled' && p) R.switched.push({ on: p.games_enabled, t: Date.now() });
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
    // Any navigation after sign-in is a reload this run promised not to need.
    R.loads = 0;
    page.on('load', () => { R.loads++; });
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
    if (R.phone) { await R.page.locator('.mobile-nav-btn').nth(0).tap(); await sleep(400); }
    await press(R, R.page.locator(`.server-icon[title="${srvName}"]`));
    await sleep(800);
}
const channelRow = (R) => R.page.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first();
async function joinCall(R) {
    await press(R, channelRow(R));
    return !!await until(() => inCall(R), 20000);
}
/** The call's stage (the grid with the activity tile): the connected channel's
 *  row on a desktop; on a phone through the Channels tab, which lands on it. */
async function toStage(R) {
    if (R.phone) { await R.page.locator('.mobile-nav-btn').nth(1).tap(); await sleep(400); }
    await press(R, channelRow(R));
    await R.page.locator('.voice-stage').waitFor({ timeout: 10000 });
}
/** The launcher is offered (attached: on a phone it waits behind the chevron). */
const hasLauncher = async (R) => (await R.page.locator('.vp-activities').count()) > 0;
async function openLauncher(R) {
    if (R.phone && !(await R.page.locator('.vp-activities').isVisible())) await R.page.locator('.vp-expand').tap();
    await press(R, R.page.locator('.vp-activities'));
    await R.page.locator('.activity-picker').waitFor({ timeout: 8000 });
}
const tile = (R) => R.page.locator('.activity-tile');
const noticeBar = (R) => R.page.locator('.activity-notice');
const playingMarks = (R) => R.page.locator('.voice-status-icon.playing');
const tableNotice = (R) => R.page.locator('.games-notice-text').first().textContent().catch(() => '');

/** Sit at the first open seat; the owner's disclosure comes first, once. */
async function acceptDisclosure(R, expectDisclosure) {
    const disc = R.page.locator('.games-disclosure');
    const shown = !!await until(() => disc.isVisible(), expectDisclosure ? 6000 : 1200);
    if (expectDisclosure !== undefined) {
        check(`${R.label}: the disclosure ${expectDisclosure ? 'comes before the first sit, in the owner\'s words' : 'is not shown again'}`,
            expectDisclosure ? shown && (await disc.textContent()).includes('Chips are free and worth nothing. This server deals the cards and its operator could see them.') : !shown);
    }
    if (shown) await press(R, disc.getByRole('button', { name: 'Sit down' }));
    return !!await until(() => R.cur && R.cur.view.viewer_seat !== null, 10000);
}
async function sit(R, expectDisclosure) {
    await R.page.locator('.gseat-sit').first().waitFor({ timeout: 15000 });
    await press(R, R.page.locator('.gseat-sit').first());
    return acceptDisclosure(R, expectDisclosure);
}

/**
 * Time from `t0` until EVERY page in `pages` shows `kind` started by the
 * owner: the notice (Join for a player, Watch only for S), the tile in the
 * grid, the sidebar's playing mark for the starter. Polls each page.
 */
async function everyoneSeesActivity(pages, kind, t0) {
    const seen = {};
    await until(async () => {
        for (const R of pages) {
            if (seen[R.label]) continue;
            const n = noticeBar(R);
            const ok = (await n.count()) > 0
                && new RegExp(`started ${kind}`).test(await n.textContent())
                && (await tile(R).count()) > 0
                && (await playingMarks(R).count()) > 0;
            if (ok) seen[R.label] = Date.now() - t0;
        }
        return pages.every(R => seen[R.label] !== undefined);
    }, 15000, 100);
    return seen;
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

/** The owner's switch in Server Settings, through the real control. */
async function setGames(P1, on) {
    await P1.page.locator('.server-settings-btn').first().click();
    const toggle = P1.page.locator('input[aria-label="Allow games in voice calls"]');
    await toggle.waitFor({ state: 'attached', timeout: 10000 });
    if ((await toggle.isChecked()) !== on) await P1.page.locator('label.toggle-row', { hasText: 'Allow games in voice calls' }).click();
    const flipped = (await toggle.isChecked()) === on;
    await P1.page.getByRole('button', { name: 'Save Changes' }).click();
    const saved = !!await until(async () => (await P1.page.locator('body').innerText()).includes('Settings saved'), 8000);
    const t = Date.now();
    await P1.page.locator('.server-settings-content .close-btn').click();
    await P1.page.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    return { flipped, saved, t };
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
    const others = [P2, P3, P4, S];

    // ── 0. A fresh server: games are on by default. S keeps CONNECT but no
    // Play Games; P2..P4 get it back through a role once they are in the call.
    const srvName = 'GL ' + stamp.slice(-4);
    const srv = await call(P1.page, '/src/api/servers.ts', 'createServer', [srvName]);
    check('a NEW server has games on by default (the create answer)', srv.games_enabled === true, srv);
    const vc = await call(P1.page, '/src/api/servers.ts', 'createChannel', [srv.id, 'Table', 1]);
    const ROOM = `voice_${vc.id}`;
    const PLAY_GAMES = 1 << 28;
    const roles = await call(P1.page, '/src/api/servers.ts', 'listRoles', [srv.id]);
    const everyoneRole = roles.find(r => r.is_default);
    check('new servers give @everyone Play Games (DEFAULT_MEMBER)', !!everyoneRole && (everyoneRole.permissions & PLAY_GAMES) !== 0, everyoneRole);
    await call(P1.page, '/src/api/servers.ts', 'updateRole', [srv.id, everyoneRole.id, { permissions: everyoneRole.permissions & ~PLAY_GAMES }]);
    const playersRole = await call(P1.page, '/src/api/servers.ts', 'createRole', [srv.id, { name: 'Players', permissions: PLAY_GAMES }]);
    const inv = await call(P1.page, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);
    for (const R of others) await call(R.page, '/src/api/servers.ts', 'joinViaInvite', [inv.code]);
    const listed = await call(S.page, '/src/api/servers.ts', 'listServers');
    check('...and the server list says so to a member', listed.find(s => s.id === srv.id)?.games_enabled === true);
    // Sign-in is over: from here on, nobody reloads.
    for (const R of everyone) { await reload(R); await openServer(R, srvName); check(`${R.label} joined the call`, await joinCall(R)); }
    for (const R of everyone) R.loadsAtStart = R.loads;

    const members = await call(P1.page, '/src/api/servers.ts', 'listMembersWithRoles', [srv.id]);
    for (const R of everyone) R.userId = members.find(m => m.username === R.username)?.id ?? null;
    check('every account is a member with a known id', everyone.every(R => typeof R.userId === 'number'), everyone.map(R => [R.label, R.userId]));
    const ownerName = members.find(m => m.id === P1.userId)?.username;

    check('owner: the Activities launcher is in the call\'s controls on a fresh server', !!await until(() => hasLauncher(P1), 8000));
    for (const R of [P2, P3, P4, S]) check(`${R.label} (no Play Games yet): no launcher`, !(await hasLauncher(R)));

    // P2..P4 get the Players role WHILE in the call: the launcher must appear
    // without a reload (ChannelPermsChanged refetches the channel's perms).
    const tRole = Date.now();
    for (const R of [P2, P3, P4]) await call(P1.page, '/src/api/servers.ts', 'assignRole', [srv.id, R.userId, playersRole.id]);
    for (const R of [P2, P3, P4]) check(`${R.label}: the launcher appears live once a role grants Play Games`, !!await until(() => hasLauncher(R), 10000), { ms: Date.now() - tRole });
    check('S (no Play Games): still no launcher', !(await hasLauncher(S)));

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

    // Everyone else on the call's stage, where the tile shows.
    for (const R of others) await toStage(R);

    // ── 1. P1 starts Poker from the launcher: the picker's Poker card.
    await openLauncher(P1);
    check('owner: the picker offers Poker and Blackjack as cards', (await P1.page.locator('.activity-card').count()) === 2
        && (await P1.page.locator('.activity-card[data-kind="holdem"] svg').count()) > 0);
    await shot(P1.page, '01-p1-picker');
    const tPoker = Date.now();
    await P1.page.locator('.activity-card[data-kind="holdem"]').click();
    check('owner (the starter): the table opens for them and seats them, behind the first-sit disclosure', await acceptDisclosure(P1, true));
    const HOLDEM_ID = P1.cur?.table_id;
    const seenPoker = await everyoneSeesActivity(others, 'Poker', tPoker);
    summary.poker_seen_ms = seenPoker;
    for (const R of others) check(`${R.label}: notice "${ownerName} started Poker", the tile and the playing mark within ${LIVE_MS} ms, no reload`, seenPoker[R.label] !== undefined && seenPoker[R.label] <= LIVE_MS, seenPoker);
    check('the notice names the starter', /started Poker/.test(await noticeBar(P2).textContent()) && (await noticeBar(P2).textContent()).includes(ownerName));
    check('S (no Play Games): the notice and the tile offer Watch only', (await noticeBar(S).getByRole('button', { name: 'Join', exact: true }).count()) === 0
        && (await noticeBar(S).getByRole('button', { name: 'Watch', exact: true }).count()) === 1
        && (await tile(S).getByRole('button', { name: 'Join', exact: true }).count()) === 0);
    check('the notice is not a dialog and took no focus', await P2.page.evaluate(() => !document.querySelector('.activity-notice')?.contains(document.activeElement) && !document.querySelector('[role="dialog"]')));
    check('the channel row says the activity is on (sidebar)', (await P3.page.locator('.voice-channel .voice-activity-chip', { hasText: 'Poker' }).count()) === 1);
    await shot(P2.page, '02-p2-notice-and-tile');
    await shot(P4.page, '03-p4-phone-notice-and-tile');
    await shot(S.page, '04-s-watch-only');

    // ── 2. They join: P2 and P3 from the tile, P4 (phone) from the notice; S watches.
    for (const R of [P2, P3]) {
        await press(R, tile(R).getByRole('button', { name: 'Join', exact: true }));
        check(`${R.label} joined from the tile (disclosure first)`, await acceptDisclosure(R, true));
    }
    await press(P4, noticeBar(P4).getByRole('button', { name: 'Join', exact: true }));
    check('P4 (phone) joined from the notice (disclosure first)', await acceptDisclosure(P4, true));
    await shot(P4.page, '05-p4-phone-seated');
    await press(S, tile(S).getByRole('button', { name: 'Watch', exact: true }));
    check('S: watching - no Sit, worded as watching', !!await until(async () =>
        (await S.page.locator('.gtable-holdem').count()) > 0
        && (await S.page.locator('.gseat-sit').count()) === 0
        && /You are watching this table/.test(await S.page.locator('.games-footer').textContent()), 8000));
    check('every seated player has a playing mark in the sidebar (4)', !!await until(async () => (await playingMarks(P1).count()) === 4, 8000), await playingMarks(P1).count());
    await shot(P1.page, '06-p1-sidebar-marks');

    // ── 3. Play. Scenarios by hand number; the driver reads each player's own
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
                if (!h.shotClock) { h.shotClock = true; await sleep(1500); await shot(R.page, `07-${R.label}-clock-running`); }
                continue;
            }
            if (v.hand_no === 3 && R.phone && !summary.phoneTurnShot) { summary.phoneTurnShot = true; await shot(R.page, '08-p4-phone-turn'); }
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
    await shot(P1.page, '09-p1-desktop-holdem');
    await shot(P4.page, '10-p4-phone-holdem');
    await shot(S.page, '11-s-spectator-holdem');

    // ── 4. "Back to call" and back keeps the seat (desktop and phone).
    for (const R of [P3, P4]) {
        const seat = R.cur?.view?.viewer_seat;
        await press(R, R.page.getByRole('button', { name: 'Back to call' }));
        const onStage = !!await until(async () => (await R.page.locator('.voice-stage').count()) > 0 && (await tile(R).count()) > 0, 6000);
        const composerBack = !R.phone || !!await until(async () => (await R.page.locator('form.message-form').count()) > 0, 4000);
        check(`${R.label}: Back to call shows the call's grid with the tile${R.phone ? ', and the composer returns' : ''}; still in the call`, onStage && composerBack && await inCall(R));
        if (R.phone) await shot(R.page, '12-p4-phone-back-to-call');
        check(`${R.label}: the tile says Open (seated)`, (await tile(R).getByRole('button', { name: 'Open', exact: true }).count()) === 1);
        await press(R, tile(R).getByRole('button', { name: 'Open', exact: true }));
        check(`${R.label}: back at the table, same seat`, !!await until(async () => (await R.page.locator('.gtable-holdem').count()) > 0, 6000) && R.cur?.view?.viewer_seat === seat, { seat, now: R.cur?.view?.viewer_seat });
        if (R.phone) check('P4 (phone): at the table the composer steps aside', (await R.page.locator('form.message-form').count()) === 0);
    }

    // ── 5. The owner switches games OFF: the table ends for everyone at once,
    // and the launcher, the tile, the marks and the notice go - live.
    for (const R of others) await toStage(R).catch(() => {});
    const off = await setGames(P1, false);
    check('owner: Server Settings saved with games OFF', off.flipped && off.saved);
    check('games off: every page received GameEnded "disabled"', !!await until(() => everyone.every(R => R.ended.some(e => e.reason === 'disabled')), 10000), everyone.map(R => [R.label, R.ended.map(e => e.reason)]));
    const endTimes = everyone.map(R => R.ended.find(e => e.reason === 'disabled')?.t).filter(Boolean);
    check('...at once: every page within 1 s of the others', endTimes.length === everyone.length && Math.max(...endTimes) - Math.min(...endTimes) <= 1000, { spreadMs: Math.max(...endTimes) - Math.min(...endTimes) });
    check('games off: every page received the switch (GamesEnabled false)', !!await until(() => everyone.every(R => R.switched.some(s => s.on === false)), 8000), everyone.map(R => [R.label, R.switched]));
    check('games off: the launcher is gone everywhere, no reload', !!await until(async () => { for (const R of everyone) if (await hasLauncher(R)) return false; return true; }, 8000));
    check('games off: tile, playing marks and notice gone everywhere', !!await until(async () => {
        for (const R of everyone) if ((await tile(R).count()) || (await playingMarks(R).count()) || (await noticeBar(R).count()) || (await R.page.locator('.voice-activity-chip').count())) return false;
        return true;
    }, 8000));
    await shot(P4.page, '13-p4-phone-games-off');

    // ── 6. ...and ON: the launcher comes back everywhere, no reload.
    const on = await setGames(P1, true);
    check('owner: Server Settings saved with games ON', on.flipped && on.saved);
    check('games on: every page received the switch (GamesEnabled true)', !!await until(() => everyone.every(R => R.switched.some(s => s.on === true)), 8000));
    for (const R of players) check(`${R.label}: the launcher is back without a reload`, !!await until(() => hasLauncher(R), 8000));
    check('S: still no launcher (no Play Games)', !(await hasLauncher(S)));

    // ── 7. P1 starts Blackjack from the launcher; everyone sees it, joins.
    await openLauncher(P1);
    const tBj = Date.now();
    await P1.page.locator('.activity-card[data-kind="blackjack"]').click();
    check('owner: seated at Blackjack (no disclosure the second time)', await acceptDisclosure(P1, false));
    const BJ_ID = P1.cur?.table_id;
    const seenBj = await everyoneSeesActivity(others, 'Blackjack', tBj);
    summary.blackjack_seen_ms = seenBj;
    for (const R of others) check(`${R.label}: Blackjack notice, tile and mark within ${LIVE_MS} ms`, seenBj[R.label] !== undefined && seenBj[R.label] <= LIVE_MS, seenBj);
    // The picker of someone else in the call: Join the running one; the other waits.
    await openLauncher(P2);
    check('P2: the picker shows Blackjack running and Poker waiting, with the reason', (await P2.page.locator('.activity-card[data-kind="holdem"]').isDisabled())
        && /Blackjack is running in this call/.test(await P2.page.locator('.activity-picker').textContent()));
    await shot(P2.page, '14-p2-picker-running');
    await press(P2, P2.page.locator('.activity-picker').getByRole('button', { name: 'Join', exact: true }));
    check('P2 joined Blackjack from the picker', await acceptDisclosure(P2, false));
    await press(P3, tile(P3).getByRole('button', { name: 'Join', exact: true }));
    check('P3 joined Blackjack from the tile', await acceptDisclosure(P3, false));
    await press(P4, noticeBar(P4).getByRole('button', { name: 'Join', exact: true }));
    check('P4 (phone) joined Blackjack from the notice', await acceptDisclosure(P4, false));
    await press(S, noticeBar(S).getByRole('button', { name: 'Watch', exact: true }));
    check('S watches Blackjack: no Sit', !!await until(async () => (await S.page.locator('.gtable-blackjack').count()) > 0 && (await S.page.locator('.gseat-sit').count()) === 0, 8000));

    // One activity per call: a raw second GameCreate on P2's own app socket is
    // refused INLINE (a GameRefused, never an alert).
    await P2.page.evaluate((frame) => {
        const ws = [...window.__appSockets].reverse().find(w => w.readyState === 1);
        ws && ws.send(JSON.stringify(frame));
    }, { type: 'GameCreate', payload: { room_id: ROOM, kind: 'holdem', config: {} } });
    check('a second activity in the call is refused INLINE in the owner\'s words', !!await until(async () => /A Blackjack table is already open in this call; it has to close before another game can start\./.test(await tableNotice(P2)), 6000));
    check('no alert() for the refusal', alerts.length === 0, alerts);
    await shot(P2.page, '15-p2-refused-inline');

    // ── 8. Blackjack rounds.
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
                if (R.phone && !summary.bjPhoneShot) { summary.bjPhoneShot = true; await shot(R.page, '16-p4-phone-blackjack-turn'); }
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
    // The deal ~1.5 s after the LAST bet (owner-side default, 2026-10-03): the
    // round_started frame against the frame just before it, when that frame was
    // a bet that completed the table (every active seat had bet).
    const pauses = [];
    const bjFr = gameFrames(P1).filter(f => f.m.payload?.table_id === BJ_ID && f.m.payload.view);
    for (let i = 1; i < bjFr.length; i++) {
        const f = bjFr[i], prev = bjFr[i - 1];
        if (!(f.m.payload.events || []).some(e => e.type === 'round_started')) continue;
        const pv = prev.m.payload.view;
        const lastBet = (prev.m.payload.events || []).some(e => e.type === 'bet_placed');
        const active = pv.seats.filter(s => s && !s.sitting_out);
        if (lastBet && active.length > 0 && active.every(s => s.pending_bet > 0) && f.m.payload.version === prev.m.payload.version + 1) pauses.push(f.t - prev.t);
    }
    summary.bj_last_bet_pause_ms = pauses;
    check('Blackjack: once everyone has bet, the deal comes ~1.5 s after the last bet (every such round 1.3-3 s)',
        pauses.length > 0 && pauses.every(ms => ms >= 1300 && ms <= 3000), pauses);
    await shot(P1.page, '17-p1-desktop-blackjack');
    await shot(P4.page, '18-p4-phone-blackjack');

    // ── 9. The moderator closes the table: tile, marks and notice go everywhere.
    for (const R of others) await toStage(R).catch(() => {});
    await P1.page.getByRole('button', { name: 'Close table' }).click();
    check('closing ends the table for EVERYONE (GameEnded "closed" on every page)', !!await until(() => everyone.every(R => R.ended.some(e => e.reason === 'closed')), 10000), everyone.map(R => [R.label, R.ended.map(e => e.reason)]));
    check('closed: tile, playing marks, channel chip and notice gone everywhere', !!await until(async () => {
        for (const R of everyone) if ((await tile(R).count()) || (await playingMarks(R).count()) || (await noticeBar(R).count()) || (await R.page.locator('.voice-activity-chip').count())) return false;
        return true;
    }, 8000));
    check('closed: the launcher is still there for the players (a new activity may start)', (await Promise.all(players.map(hasLauncher))).every(Boolean));
    await shot(P2.page, '19-p2-after-close');
    check('everyone is still in the call after all of it', (await Promise.all(everyone.map(inCall))).every(Boolean));
    check('nobody reloaded after sign-in (everything above arrived live)', everyone.every(R => R.loads === R.loadsAtStart), everyone.map(R => [R.label, R.loads - R.loadsAtStart]));
    check('no alert() at any point', alerts.length === 0, alerts);

    // ── 10. PRIVACY, from every recorded frame.
    privacy({ HOLDEM_ID, BJ_ID, players, S });
} catch (e) {
    check('live run reached the end', false, String(e && e.stack || e).slice(0, 900));
} finally {
    if (OLD) {
        clearInterval(OLD.ping);
        const g = OLD.frames.filter(f => typeof f.m.type === 'string' && (f.m.type.startsWith('Game') || f.m.type === 'GamesEnabled'));
        const roomTraffic = OLD.frames.filter(f => !['ServerFeatures', 'Pong', 'RoomJoined'].includes(f.m.type)).length;
        check('OLD (no `games` cap) received ZERO game or games-switch frames through the whole run', g.length === 0, { game: g.length, total: OLD.frames.length, types: [...new Set(g.map(f => f.m.type))] });
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
