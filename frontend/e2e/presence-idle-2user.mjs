// Live idle/away presence: two accounts, one of them on a PC AND a phone.
//
// What it proves, against a real backend and real browsers:
//   1. The most active device wins: Bob's phone going to the background does
//      not make him idle while his PC is in use.
//   2. With every device quiet, the SERVER's clock turns his dot orange
//      (idle) and then into the "zz" badge (away) for Alice — no device ever
//      reports "idle" or "away" itself.
//   3. Any activity brings him straight back to green.
//   4. "Show when I'm idle or away" off (Settings > Privacy & Safety, the real
//      control) makes Alice see plain online; on again, the truth returns.
//   5. Backward compatibility, both directions of the wire: a socket that did
//      NOT announce the capability (an old client) receives no ServerFeatures
//      and no UserStatus — while one that did, on the same account, does
//      (the positive control); and an OLDER server (OLD_API, optional) opens
//      a socket that announces ?caps=presence, sends no ServerFeatures, and
//      answers SetActivity with an Error — the alert the client's gate
//      exists to avoid (the client side of that gate is vitest's).
//   6. The member list dot renders at 390x844 (coarse pointer) too.
//
// THROWAWAY STACK ONLY. The backend must run with the TEST-ONLY clocks
// (.env.example): PRESENCE_TEST_IDLE_SECS=6 PRESENCE_TEST_AWAY_SECS=20, and
// APP_ENV=development (they are ignored in production).
//
// Usage (PowerShell or bash):
//   API=http://127.0.0.1:5311 APP=http://127.0.0.1:5411 PGDB=<db> PGPORT=<port> \
//   PGPASSWORD=<pw> [SHOTS=<dir>] \
//   [OLD_API=http://127.0.0.1:<port> OLD_PGDB=<its throwaway db> OLD_JWT_SECRET=<its secret>] \
//   node e2e/presence-idle-2user.mjs
//
// Headless, muted, fake media; never takes focus. Exit code = failures.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const API = process.env.API || 'http://127.0.0.1:5311';
const APP = process.env.APP || 'http://127.0.0.1:5411';
const OLD_API = process.env.OLD_API || '';
const SHOTS = process.env.SHOTS || '';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PGDB = process.env.PGDB;
const PGPORT = process.env.PGPORT || '5433';
if (!PGDB) { console.error('PGDB is required (a THROWAWAY database)'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const PASS = 'Password123!presence';
const stamp = Date.now().toString(36);
const ALICE = 'pa_' + stamp;
const BOB = 'pb_' + stamp;

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
    if (!ok) failures++;
};
const psqlOn = (db, sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-p', PGPORT, '-d', db, '-q', '-t', '-A', '-c', sql],
    { env: process.env }).toString().trim().split(/\r?\n/).filter(Boolean)[0] ?? '';
const psql = (sql) => psqlOn(PGDB, sql);

const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const desktop = { viewport: { width: 1280, height: 800 } };
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** Every page records the presence frames it SENDS, and can be hidden. */
async function instrument(page) {
    page.on('dialog', d => d.accept().catch(() => {}));
    await page.addInitScript(() => {
        window.__sent = [];
        const orig = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
            try { const f = JSON.parse(data); if (f.type === 'SetActivity') window.__sent.push(f); } catch { /* binary */ }
            return orig.call(this, data);
        };
        // A controllable visibility, as a backgrounded phone or a minimised
        // window would report it.
        window.__hidden = false;
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    });
}

async function setHidden(page, hidden) {
    await page.evaluate((h) => { window.__hidden = h; document.dispatchEvent(new Event('visibilitychange')); }, hidden);
}

async function dismissOnboarding(page) {
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* none */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
}

async function register(ctx, user) {
    const page = await ctx.newPage();
    await instrument(page);
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { timeout: 30000 });
    await page.click('.toggle-mode', { timeout: 5000 });
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 60000 });
    await page.waitForTimeout(1200);
    await dismissOnboarding(page);
    return page;
}

async function login(ctx, user) {
    const page = await ctx.newPage();
    await instrument(page);
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { timeout: 30000 });
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 60000 });
    await page.waitForTimeout(1200);
    await dismissOnboarding(page);
    return page;
}

async function createServer(page, name) {
    await page.locator('.server-icon.add-server').click({ timeout: 10000 });
    await page.waitForTimeout(500);
    await page.locator('.template-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.audience-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill(name);
    await page.locator('.wizard-actions .create-btn').click();
    await page.waitForTimeout(2500);
}

async function openServer(page) {
    await page.evaluate(() => {
        const t = [...document.querySelectorAll('.server-icon')].find(i => !/direct message|add server|join server|notes|tasks/i.test(
            (i.getAttribute('title') || '') + ' ' + (i.className || '')));
        t?.click();
    });
    await page.waitForTimeout(1500);
}

/** The presence dot on `name`'s row in the member list: its status class, or null. */
const dotOf = (page, name) => page.evaluate((n) => {
    const row = [...document.querySelectorAll('.member-item')].find(m => m.textContent.includes(n));
    const dot = row?.querySelector('.presence-dot');
    if (!dot) return null;
    const cls = [...dot.classList].find(c => c.startsWith('is-'));
    return { status: cls?.slice(3) ?? null, label: dot.getAttribute('aria-label'), badge: !!dot.querySelector('svg') };
}, name);

async function waitForDot(page, name, status, timeoutMs) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
        last = await dotOf(page, name);
        if (last?.status === status) return { ok: true, ms: Date.now() - t0, last };
        await page.waitForTimeout(250);
    }
    return { ok: false, ms: Date.now() - t0, last };
}

/** A raw socket from inside `page` (its token), recording every frame type. */
async function rawSocket(page, api, caps) {
    return page.evaluate(async ({ api, caps }) => {
        const token = localStorage.getItem('auth_token');
        const url = api.replace(/^http/, 'ws') + '/ws' + (caps ? '?caps=presence' : '');
        const id = Math.random().toString(36).slice(2);
        window.__raw = window.__raw || {};
        const rec = { frames: [], open: false, closed: false };
        window.__raw[id] = rec;
        const ws = new WebSocket(url, ['bearer', token]);
        rec.ws = ws;
        ws.onmessage = (e) => { try { rec.frames.push(JSON.parse(e.data)); } catch { /* binary */ } };
        ws.onclose = () => { rec.closed = true; };
        await new Promise((res) => { ws.onopen = () => { rec.open = true; res(); }; setTimeout(res, 5000); });
        return id;
    }, { api, caps });
}
const rawFrames = (page, id) => page.evaluate((id) => {
    const r = window.__raw[id];
    return { open: r.open, closed: r.closed, frames: r.frames.map(f => ({ type: f.type, payload: f.payload })) };
}, id);
const rawSend = (page, id, frame) => page.evaluate(({ id, frame }) => window.__raw[id].ws.send(JSON.stringify(frame)), { id, frame });

const ctxs = [];
try {
    // ---- accounts -------------------------------------------------------
    const ctxAlice = await browser.newContext(desktop); ctxs.push(ctxAlice);
    const alice = await register(ctxAlice, ALICE);
    await createServer(alice, 'Presence ' + stamp);
    const aliceId = psql(`SELECT id FROM users WHERE username='${ALICE}'`);
    const serverId = psql(`SELECT id FROM servers WHERE owner_id=${aliceId} ORDER BY created_at DESC LIMIT 1`);
    check('server created', !!serverId);

    const ctxBobPc = await browser.newContext(desktop); ctxs.push(ctxBobPc);
    const bobPc = await register(ctxBobPc, BOB);
    const bobId = psql(`SELECT id FROM users WHERE username='${BOB}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bobId}) ON CONFLICT DO NOTHING`);

    const ctxBobPhone = await browser.newContext(phone); ctxs.push(ctxBobPhone);
    const bobPhone = await login(ctxBobPhone, BOB);

    // Everyone re-reads the server list (Bob was added behind the UI's back).
    for (const p of [alice, bobPc]) { await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2500); }
    await openServer(alice);
    await openServer(bobPc);

    // ---- baseline ---------------------------------------------------------
    const online0 = await waitForDot(alice, BOB, 'online', 15000);
    check('Alice sees Bob online (green)', online0.ok, JSON.stringify(online0.last));
    const featuresConfirmed = await bobPc.evaluate(() => window.__sent.length > 0);
    check('Bob\'s PC told the server its state once the capability was confirmed', featuresConfirmed);
    if (SHOTS) await alice.screenshot({ path: `${SHOTS}/desktop-online.png` });

    // ---- 1. most active wins ------------------------------------------------
    await setHidden(bobPhone, true); // phone to the background
    await alice.waitForTimeout(9000); // past the 6 s test idle clock
    const stillOnline = await dotOf(alice, BOB);
    check('phone in the background, PC in use: Bob stays ONLINE', stillOnline?.status === 'online', JSON.stringify(stillOnline));
    const phoneSent = await bobPhone.evaluate(() => window.__sent.map(f => f.payload.inactive_secs));
    check('the backgrounded phone reported inactive at once', phoneSent.length >= 1 && phoneSent[phoneSent.length - 1] !== null, JSON.stringify(phoneSent));

    // ---- 2. the server's clock: idle, then away -------------------------
    await setHidden(bobPc, true); // the PC goes quiet too (minimised; no OS probe in a browser)
    const idle = await waitForDot(alice, BOB, 'idle', 15000);
    check('every device quiet: Alice sees Bob IDLE (orange) on the server clock', idle.ok, `${idle.ms} ms, ${JSON.stringify(idle.last)}`);
    check('idle has the spoken name "Idle"', idle.last?.label === 'Idle');
    const idleColour = await alice.evaluate((n) => {
        const row = [...document.querySelectorAll('.member-item')].find(m => m.textContent.includes(n));
        const dot = row.querySelector('.presence-dot');
        const probe = document.createElement('span');
        probe.style.color = 'var(--status-idle)';
        document.body.appendChild(probe);
        const want = getComputedStyle(probe).color;
        probe.remove();
        return { got: getComputedStyle(dot).backgroundColor, want };
    }, BOB);
    check('the idle dot is the --status-idle orange', idleColour.got === idleColour.want, JSON.stringify(idleColour));
    if (SHOTS) await alice.screenshot({ path: `${SHOTS}/desktop-idle.png` });
    const bobSentIdle = await bobPc.evaluate(() => window.__sent.map(f => f.payload.inactive_secs));
    check('no device ever claims idle or away: only "active" (null) or seconds', bobSentIdle.every(v => v === null || typeof v === 'number'));

    const away = await waitForDot(alice, BOB, 'away', 30000);
    check('Alice sees Bob AWAY (zz badge) after the long clock', away.ok && away.last?.badge === true, `${away.ms} ms, ${JSON.stringify(away.last)}`);
    check('away has the spoken name "Away"', away.last?.label === 'Away');
    if (SHOTS) await alice.screenshot({ path: `${SHOTS}/desktop-away.png` });

    // Bob's own devices know too (his own profile bar).
    const ownBar = await bobPc.evaluate(() => document.querySelector('.user-profile-bar .user-status')?.textContent);
    check('Bob\'s own profile bar says Away', ownBar === 'Away', ownBar);

    // ---- 6. phone layout: Bob's phone sees ALICE (active), Alice sees away on a phone too
    const ctxAlicePhone = await browser.newContext(phone); ctxs.push(ctxAlicePhone);
    const alicePhone = await login(ctxAlicePhone, ALICE);
    await openServer(alicePhone);
    // The real tab a phone user taps: the member list is its own panel there.
    await alicePhone.locator('.mobile-nav-btn', { hasText: 'Members' }).tap({ timeout: 5000 });
    await alicePhone.waitForTimeout(800);
    const phoneView = await alicePhone.evaluate((n) => {
        const row = [...document.querySelectorAll('.member-item')].find(m => m.textContent.includes(n));
        const dot = row?.querySelector('.presence-dot');
        if (!dot) return null;
        const r = dot.getBoundingClientRect();
        // On screen, and what a finger at its centre would actually reach.
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
            cls: dot.className, w: r.width, h: r.height,
            onScreen: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
            visible: !!hit && (hit === dot || dot.contains(hit) || row.contains(hit)),
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
    }, BOB);
    check('390x844: the away badge renders in the member list at 14px, on screen', !!phoneView && /is-away/.test(phoneView.cls)
        && Math.round(phoneView.w) === 14 && phoneView.onScreen && phoneView.visible, JSON.stringify(phoneView));
    check('390x844: no horizontal overflow', phoneView ? !phoneView.overflow : false);
    if (SHOTS) await alicePhone.screenshot({ path: `${SHOTS}/phone-member-list.png` });

    // ---- 5. capability gating on the live wire --------------------------
    const oldSock = await rawSocket(alice, API, false); // an OLD client: no caps
    const newSock = await rawSocket(alice, API, true);  // a new one, same account
    // Generate a status change for both to (not) hear: Bob comes back.
    await setHidden(bobPhone, false);
    await bobPhone.dispatchEvent('body', 'pointerdown');

    // ---- 3. back at once --------------------------------------------------
    const back = await waitForDot(alice, BOB, 'online', 5000);
    check('activity on any device: Bob is green again at once', back.ok, `${back.ms} ms`);

    await alice.waitForTimeout(1500);
    const oldFrames = await rawFrames(alice, oldSock);
    const newFrames = await rawFrames(alice, newSock);
    const types = (f) => f.frames.map(x => x.type);
    check('positive control: the capable socket got ServerFeatures', types(newFrames).includes('ServerFeatures'), types(newFrames).join(','));
    check('positive control: the capable socket got UserStatus(online) for Bob',
        newFrames.frames.some(f => f.type === 'UserStatus' && String(f.payload.user_id) === bobId && f.payload.status === 'online'));
    check('an OLD client socket got NO ServerFeatures and NO UserStatus',
        oldFrames.open && !types(oldFrames).includes('ServerFeatures') && !types(oldFrames).includes('UserStatus'), types(oldFrames).join(','));
    // An old client that somehow sends the frame anyway: ignored, no Error.
    await rawSend(alice, oldSock, { type: 'SetActivity', payload: { inactive_secs: 5000 } });
    await alice.waitForTimeout(800);
    const afterCrafted = await rawFrames(alice, oldSock);
    check('a SetActivity from a socket without the capability draws no Error frame',
        !afterCrafted.frames.some(f => f.type === 'Error'), types(afterCrafted).join(','));

    // ---- 4. the privacy switch, through the real Settings control -------
    // Everyone quiet again, so Bob goes idle/away...
    await setHidden(bobPhone, true);
    const idle2 = await waitForDot(alice, BOB, 'idle', 15000);
    check('quiet again: idle again', idle2.ok, `${idle2.ms} ms`);
    // ...and he turns "Show when I'm idle or away" off on his PC.
    await setHidden(bobPc, false);
    await bobPc.locator('.user-action-btn[title="Settings"], button[aria-label="Settings"]').first().click({ timeout: 5000 });
    await bobPc.getByText('Privacy & Safety', { exact: true }).first().click({ timeout: 5000 });
    const toggle = bobPc.locator('#privacy-show-idle');
    await toggle.waitFor({ timeout: 8000 });
    check('the toggle is shown and on by default', await toggle.isChecked());
    await toggle.uncheck();
    await bobPc.waitForTimeout(800);
    check('the setting is stored server-side', psql(`SELECT show_idle_status FROM users WHERE id=${bobId}`) === 'f');
    await bobPc.keyboard.press('Escape');
    await setHidden(bobPc, true);
    await alice.waitForTimeout(9000); // well past the idle clock
    const hiddenIdle = await dotOf(alice, BOB);
    check('sharing off: Alice sees Bob as plain ONLINE while he is quiet', hiddenIdle?.status === 'online', JSON.stringify(hiddenIdle));
    // Turn it back on through the API the control uses; the truth returns at once.
    const status = await bobPc.evaluate(async (api) => {
        const r = await fetch(`${api}/profile`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
            body: JSON.stringify({ show_idle_status: true }),
        });
        return r.status;
    }, API);
    check('PATCH /profile show_idle_status=true', status === 200, String(status));
    // Using Settings on the PC was activity, so his quiet spell restarted when
    // he closed it: about 10 s ago, past the 6 s idle clock, short of the 20 s
    // away one. The truth is "idle", and it must arrive at once, not at the
    // next sweep...
    const truth = await waitForDot(alice, BOB, 'idle', 1500);
    check('sharing on again: Alice sees the real status (idle) at once', truth.ok, `${truth.ms} ms, ${JSON.stringify(truth.last)}`);
    // ...and the server's clock carries on from there.
    const away2 = await waitForDot(alice, BOB, 'away', 20000);
    check('...and away once the long clock runs out', away2.ok, `${away2.ms} ms`);

    // ---- 7. a reconnect is not activity --------------------------------
    // A new capable socket for Bob (a desktop reconnecting after a blip, its
    // old socket not yet reaped) that has not reported yet must not flash
    // him online for Alice. Watched both on her screen and on her raw
    // capable socket, which hears every UserStatus.
    const beforeReconnect = (await rawFrames(alice, newSock)).frames.length;
    const bobExtra = await rawSocket(bobPc, API, true);
    let flashed = null;
    for (let i = 0; i < 30; i++) { // 3 s, every 100 ms
        const d = await dotOf(alice, BOB);
        if (d?.status !== 'away') { flashed = d; break; }
        await alice.waitForTimeout(100);
    }
    const afterReconnect = (await rawFrames(alice, newSock)).frames.slice(beforeReconnect)
        .filter(f => f.type === 'UserStatus' && String(f.payload.user_id) === bobId);
    const extraFrames = await rawFrames(bobPc, bobExtra);
    check('positive control: Bob\'s new socket was confirmed the capability',
        extraFrames.frames.some(f => f.type === 'ServerFeatures'), extraFrames.frames.map(f => f.type).join(','));
    check('a reconnect while away: Alice never sees Bob flash online', flashed === null && afterReconnect.length === 0,
        JSON.stringify({ flashed, afterReconnect }));
    await bobPc.evaluate((id) => window.__raw[id].ws.close(), bobExtra);

    // ---- 8. quick tab switching cannot strand an active user ------------
    // Each switch on a phone or in a browser is two reports (hidden =
    // inactive at once, shown = active). Six switches is twelve frames, past
    // the server's presence bucket (6 burst). The last one — back, active —
    // must still be TAKEN: the client never repeats a report.
    const sentBefore = await bobPhone.evaluate(() => window.__sent.length);
    for (let i = 0; i < 6; i++) {
        await setHidden(bobPhone, false);
        await bobPhone.waitForTimeout(60);
        await setHidden(bobPhone, true);
        await bobPhone.waitForTimeout(60);
    }
    await setHidden(bobPhone, false); // back in the tab, and staying
    await bobPhone.waitForTimeout(300);
    const burst = await bobPhone.evaluate((n) => window.__sent.slice(n).map(f => f.payload.inactive_secs), sentBefore);
    check('positive control: the switching sent more reports than the bucket holds', burst.length > 6, JSON.stringify(burst));
    check('the last report sent says active', burst[burst.length - 1] === null);
    const backAfterBurst = await waitForDot(alice, BOB, 'online', 8000);
    check('after the burst: Alice sees Bob online (the sweep publishes the throttled report)', backAfterBurst.ok,
        `${backAfterBurst.ms} ms, ${JSON.stringify(backAfterBurst.last)}`);
    await alice.waitForTimeout(9000); // past the 6 s idle clock, with the phone shown and in use
    const stillBack = await dotOf(alice, BOB);
    check('...and he stays online past the idle clock (no stale "inactive" on the server)', stillBack?.status === 'online',
        JSON.stringify(stillBack));

    // ---- 5b. an OLDER server: ?caps= is harmless, ServerFeatures never comes,
    // and the frame the gate holds back really would draw an Error there.
    if (OLD_API) {
        const db = process.env.OLD_PGDB, secret = process.env.OLD_JWT_SECRET;
        const u = 'po_' + stamp;
        const id = Number(psqlOn(db, `INSERT INTO users (username, salt, verifier, key_version, token_version) VALUES ('${u}', '\\x00', '\\x00', 3, 0) RETURNING id`));
        const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const head = b64u({ alg: 'HS256', typ: 'JWT' });
        const body = b64u({ sub: id, username: u, tv: 0, exp: Math.floor(Date.now() / 1000) + 600 });
        const jwt = `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
        const frames = [];
        const ws = new WebSocket(OLD_API.replace(/^http/, 'ws') + '/ws?caps=presence', ['bearer', jwt]);
        ws.onmessage = (e) => { try { frames.push(JSON.parse(e.data)); } catch { /* binary */ } };
        const opened = await new Promise((res) => { ws.onopen = () => res(true); ws.onerror = () => res(false); setTimeout(() => res(false), 8000); });
        await new Promise(r => setTimeout(r, 1500));
        check('an older server accepts a socket that announces ?caps=presence', opened);
        check('an older server never sends ServerFeatures', !frames.some(f => f.type === 'ServerFeatures'), frames.map(f => f.type).join(','));
        ws.send(JSON.stringify({ type: 'SetActivity', payload: { inactive_secs: null } }));
        await new Promise(r => setTimeout(r, 1500));
        const err = frames.find(f => f.type === 'Error');
        check('why the gate exists: an older server answers SetActivity with an Error frame', !!err, JSON.stringify(err?.payload ?? null));
        ws.close();
    } else {
        console.log('SKIP  older-server probe (set OLD_API, OLD_PGDB and OLD_JWT_SECRET to run it)');
    }
} catch (e) {
    console.error(e);
    failures++;
} finally {
    for (const c of ctxs) await c.close().catch(() => {});
    await browser.close();
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures);
