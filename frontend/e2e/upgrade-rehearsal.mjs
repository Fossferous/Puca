// Mixed-fleet upgrade rehearsal: what existing users experience when the
// server moves from 0.9.2 (production today) to trunk, with clients updating
// at different times.
//
//   world 0.9.2  : two accounts, a server + channel, DMs both ways
//   backend ->   : trunk backend on the SAME database (migrations 059, 060)
//   old client   : signs in (SHA-256 SRP), reads history, sends (v3)
//   new client   : signs in (upgraded to Argon2id), reads everything, replies
//                  v3 while the other side still has an old client, turns on
//                  forward-secret DMs, sends v4 once both sides can read it
//   new device   : password-only sign-in sees v4 history LOCKED, unlocks it
//                  with the recovery code, receives new v4 live
//   injected row : plaintext inserted by "the server" is badged unexpected
//   old client   : comes back, still signs in and sends; v4 rows say "update"
//
// Everything runs against loopback: postgres (db puca_upgrade, dropped and
// recreated by you before each run), backend :3000, web :5173. Run it from
// frontend/ so @playwright/test resolves:
//
//   PUCA_OLD_ROOT=../../puca-092 node e2e/upgrade-rehearsal.mjs [screenshot-dir]
//
// Environment:
//   PUCA_OLD_ROOT  a checkout of the release production runs (required), with
//                  target/debug/puca.exe built and frontend/dist built as
//                  VITE_API_URL=http://127.0.0.1:3000 PUCA_ALLOW_LOCAL_BUILD=1
//   PUCA_NEW_ROOT  the tree under test (default: this repository)
//   PSQL           psql binary (default: psql on PATH)
//   PGPORT         the throwaway cluster's port (default 5433); the DB is
//                  puca_upgrade, user postgres, no password
//
// Windows-only today (taskkill, cmd.exe); the checks themselves are portable.
//
// This is a rehearsal, not a gate: it takes ~8 minutes, needs a second
// checkout and a scratch cluster, and its verdict is the PASS/FAIL list plus
// the screenshots. It caught a real defect on its first full run (a fresh
// sign-in never published its DM session key until the next app start), so
// run it before any release that touches sign-in, keys or the DM wire format.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'http://127.0.0.1:3000';
const WEB = 'http://localhost:5173';
const OUT = process.argv[2] ?? '.';
const PSQL = process.env.PSQL ?? 'psql';
const PGPORT = process.env.PGPORT ?? '5433';
const OLD_ROOT = process.env.PUCA_OLD_ROOT ? resolve(process.env.PUCA_OLD_ROOT) : null;
const NEW_ROOT = process.env.PUCA_NEW_ROOT ? resolve(process.env.PUCA_NEW_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (!OLD_ROOT) { console.error('PUCA_OLD_ROOT is required: a built checkout of the release production runs'); process.exit(2); }
const JWT_SECRET = 'upgrade_rehearsal_secret_not_real_0123456789abcdef0123456789';

const sql = (q) => execFileSync(PSQL, ['-p', PGPORT, '-U', 'postgres', '-d', 'puca_upgrade', '-tAc', q], { encoding: 'utf8' }).trim();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, cond, detail = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   [' + detail + ']' : ''}`);
    if (!cond) fails++;
};
const post = async (path, body, token) => fetch(API + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

// ---------------------------------------------------------------- processes
const procs = new Set();
function kill(p) {
    try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    procs.delete(p);
}
async function waitHttp(url, ok, timeoutMs = 60_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try { const r = await fetch(url); if (ok(r)) return true; } catch { /* not yet */ }
        await pause(400);
    }
    return false;
}
async function waitDown(url, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try { await fetch(url); } catch { return true; }
        await pause(300);
    }
    return false;
}
async function startBackend(root, label) {
    const exe = resolve(root, 'target', 'debug', process.platform === 'win32' ? 'puca.exe' : 'puca');
    if (!existsSync(exe)) throw new Error(`no backend at ${exe}`);
    const p = spawn(exe, [], {
        env: {
            ...process.env,
            DATABASE_URL: `postgres://postgres@127.0.0.1:${PGPORT}/puca_upgrade`,
            JWT_SECRET, PORT: '3000', BIND_ADDR: '127.0.0.1', APP_ENV: 'development',
            APP_URL: WEB, CORS_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    procs.add(p);
    const up = await waitHttp(API + '/', r => r.status === 200);
    if (!up) throw new Error(`${label} backend did not come up: ${err.slice(-600)}`);
    console.log(`      ${label} backend up`);
    return p;
}
async function startWeb(kind) {
    const cwd = resolve(kind === 'old' ? OLD_ROOT : NEW_ROOT, 'frontend');
    // old = the 0.9.2 production bundle (API pinned to loopback at build time);
    // new = the trunk dev server (.env.development → 127.0.0.1:3000).
    const cmd = kind === 'old'
        ? 'npx vite preview --port 5173 --strictPort'
        : 'npm run dev -- --port 5173 --strictPort';
    const p = spawn('cmd.exe', ['/c', cmd], { cwd, stdio: 'ignore' });
    procs.add(p);
    const up = await waitHttp(WEB + '/', r => r.status === 200);
    if (!up) throw new Error(`${kind} web did not come up`);
    const html = await (await fetch(WEB + '/')).text();
    console.log(`      ${kind} web up (title ${(html.match(/<title>([^<]*)<\/title>/) || [])[1] ?? '?'})`);
    if (kind === 'new') {
        // The dev server pre-bundles dependencies on the first real request;
        // pull the entry module now so the browser's first load is not the
        // one paying for it.
        const entry = (html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/) || [])[1];
        if (entry) {
            const t0 = Date.now();
            while (Date.now() - t0 < 180_000) {
                try { const r = await fetch(WEB + entry); if (r.status === 200) { await r.text(); break; } } catch { /* optimising */ }
                await pause(1000);
            }
            console.log(`      dev server warmed in ${Math.round((Date.now() - t0) / 1000)}s`);
        }
    }
    return p;
}
async function stop(p, url) { kill(p); await waitDown(url); }

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ args: ['--mute-audio'] });
let lastPage = null;
async function fresh(tag = '?') {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    lastPage = page;
    // The app narrates the two things this rehearsal keys on - the live socket
    // and the DM-key publish - so keep those lines, tagged by device.
    page.on('console', m => {
        const t = m.text();
        if (/dm-keys|WebSocket connected|Failed to connect WebSocket|Attempting WebSocket|session-dm|Stored session has expired/.test(t)) console.log(`      [${tag}] ${t}`);
    });
    page.on('pageerror', e => console.log(`      [${tag} pageerror] ${e.message}`));
    await page.goto(WEB + '/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.evaluate(() => localStorage.clear());
    await page.goto(WEB + '/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 20000 });
    return { ctx, page };
}
async function register(page, user, pass) {
    await pause(4000);
    await page.getByRole('button', { name: /Don't have an account\? Register/ }).click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder('Choose a password (min 8 characters)').fill(pass);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await pause(3500);
    const token = await page.evaluate(() => localStorage.getItem('auth_token'));
    if (!token) await login(page, user, pass);
    return page.evaluate(() => localStorage.getItem('auth_token'));
}
async function login(page, user, pass) {
    await pause(4000);
    await page.goto(WEB + '/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 20000 });
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder('Enter password').fill(pass);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.getByPlaceholder('Enter password').waitFor({ state: 'detached', timeout: 20000 });
    await pause(1500);
    return page.evaluate(() => localStorage.getItem('auth_token'));
}
async function dismissBanners(page) {
    // Overlays that swallow every click underneath, each targeted inside its
    // own container (a bare first() once picked a hidden button elsewhere):
    //  - the recovery-code modal: tick "I've written down..." then Done; on a
    //    later start it is the "never saved" reminder with Later;
    //  - the first-run Welcome popup and its close button.
    for (let i = 0; i < 4; i++) {
        let acted = false;
        const rc = page.locator('.recovery-modal-overlay').first();
        if (await rc.count()) {
            const tick = rc.locator('.recovery-confirm input[type=checkbox]');
            if (await tick.count()) {
                await tick.check({ timeout: 3000 }).catch(() => {});
                await rc.locator('button.recovery-done-btn').click({ timeout: 3000 }).catch(() => {});
            } else {
                await rc.getByRole('button', { name: 'Later', exact: true }).click({ timeout: 3000 }).catch(() => {});
            }
            acted = true;
        }
        const welcome = page.locator('.welcome-popup-overlay').first();
        if (await welcome.count()) {
            await welcome.locator('button.welcome-popup-close').click({ timeout: 3000 }).catch(() => {});
            acted = true;
        }
        if (!acted) break;
        await pause(500);
    }
}
/** Click a locator, dismissing any overlay that appears between attempts:
 *  the recovery reminder and the welcome popup arrive on their own timers,
 *  often AFTER a one-shot dismissal has already run. */
async function clickPast(page, locator, attempts = 10) {
    for (let i = 0; i < attempts; i++) {
        await dismissBanners(page);
        try { await locator.click({ timeout: 3000 }); return; } catch { /* an overlay swallowed it; go again */ }
    }
    await locator.click({ timeout: 10000 }); // last try, let the real error surface
}
async function openDm(page, partner) {
    await dismissBanners(page);
    // The DM home lists conversations by the partner's name; go there first so
    // a username in a server's member list is never what gets clicked.
    const home = page.locator('.server-icon-inner.home').first();
    if (await home.count()) await clickPast(page, home, 3).catch(() => {});
    await pause(800);
    await clickPast(page, page.getByText(partner, { exact: true }).first());
    await page.getByPlaceholder(/^Message @/).waitFor({ timeout: 15000 });
    await pause(1500);
}
async function sendHere(page, text) {
    const box = page.getByPlaceholder(/^Message [#@]/);
    await dismissBanners(page);
    await box.fill(text);
    await box.press('Enter');
    await page.getByText(text, { exact: true }).first().waitFor({ timeout: 15000 });
}
const visible = async (page, text) => (await page.getByText(text, { exact: true }).count()) > 0;
/** Wait for text to appear (a live delivery); false if it never does. */
const appears = (page, text, ms = 15000) => page.getByText(text, { exact: true }).first().waitFor({ timeout: ms }).then(() => true, () => false);
/** Poll a scalar query until it returns `want` (or the deadline); return the last value. */
async function waitSql(q, want, ms = 20000) {
    const t0 = Date.now();
    let v = sql(q);
    while (v !== want && Date.now() - t0 < ms) { await pause(500); v = sql(q); }
    return v;
}
const sessionsOf = (uid) => sql(`SELECT string_agg(left(sid,8)||' key='||(dm_pubkey IS NOT NULL)::text||' reads='||coalesce(reads_up_to::text,'-')||' revoked='||(revoked_at IS NOT NULL)::text||' seen='||to_char(last_seen_at,'HH24:MI:SS'), ' | ' ORDER BY created_at) FROM token_sessions WHERE user_id=${uid}`);
async function openChannel(page, serverName, channelName) {
    await dismissBanners(page);
    await clickPast(page, page.getByTitle(serverName).first());
    await clickPast(page, page.getByText(channelName, { exact: true }).first());
    await page.getByPlaceholder(/^Message #/).waitFor({ timeout: 15000 });
    await pause(1000);
}
/** Settings → My Account → regenerate the recovery code; return the 12 words. */
async function regenerateRecoveryCode(page, password) {
    await dismissBanners(page);
    await clickPast(page, page.getByTitle('Settings').first());
    await clickPast(page, page.getByText('My Account', { exact: true }).first());
    await clickPast(page, page.getByRole('button', { name: 'Regenerate recovery code' }));
    // Two forms on this tab ask for the current password; take the one whose
    // submit is the regenerate button.
    const retire = page.getByRole('button', { name: 'Retire the old code and show a new one' });
    const form = page.locator('form.password-change-form').filter({ has: retire });
    await form.getByPlaceholder('Current password').fill(password);
    await pause(4000); // the re-prove is an SRP exchange: pace for the auth limiter
    await retire.click();
    await page.locator('.recovery-word').first().waitFor({ timeout: 30000 });
    const words = await page.locator('.recovery-word').allInnerTexts();
    const code = words.map(w => w.replace(/^\s*\d+\s*/, '').trim()).join(' ');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
    await pause(1500);
    await dismissBanners(page);
    return code;
}
const dmWire = (text) => sql(`SELECT substr(content, 1, 12) FROM dm_messages WHERE content LIKE '%' || '' ORDER BY created_at DESC LIMIT 1`);
const lastDmVersion = () => sql(`SELECT CASE WHEN content LIKE '{"v":4%' THEN '4' WHEN content LIKE '{"v":3%' THEN '3' WHEN content LIKE '{"v":2%' THEN '2' ELSE 'plain' END FROM dm_messages ORDER BY created_at DESC LIMIT 1`);
const userId = (u) => sql(`SELECT id FROM users WHERE LOWER(username)=LOWER('${u}')`);

const ALICE = 'alice_' + Date.now().toString(36), BOB = 'bob_' + Date.now().toString(36);
const PA = 'alice-password-upgrade', PB = 'bob-password-upgrade';
const SERVER = 'Upgrade Test', CHANNEL = 'general-' + Date.now().toString(36).slice(-4);
let backend = null, web = null;

try {
    // ================================================================ world 0.9.2
    console.log('\n=== 0.9.2 world');
    backend = await startBackend(OLD_ROOT, '0.9.2');
    web = await startWeb('old');
    check('0.9.2 backend applied its migrations (highest < 59)', Number(sql('SELECT max(version) FROM _sqlx_migrations')) < 59, sql('SELECT max(version) FROM _sqlx_migrations'));

    const A = await fresh('A');
    const tokenA = await register(A.page, ALICE, PA);
    check('alice registered on 0.9.2', !!tokenA);
    const srv = await (await post('/servers', { name: SERVER }, tokenA)).json();
    const ch = await (await post(`/servers/${srv.id}/channels`, { name: CHANNEL, channel_type: 0 }, tokenA)).json();
    check('alice made a server + text channel', !!srv.id && !!ch.id, `server ${srv.id}`);
    await A.page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }); await pause(2000);
    await openChannel(A.page, SERVER, CHANNEL);
    await sendHere(A.page, 'old world channel message');
    check('alice posted an encrypted channel message on 0.9.2', (sql(`SELECT count(*) FROM messages WHERE content LIKE '{"v":%'`)) === '1');

    const B = await fresh('B');
    const tokenB = await register(B.page, BOB, PB);
    check('bob registered on 0.9.2', !!tokenB);
    const conv = await (await post('/dms', { user_id: Number(userId(BOB)) }, tokenA)).json();
    check('DM conversation exists', !!conv.id);
    await A.page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }); await pause(2000);
    await openDm(A.page, BOB);
    await sendHere(A.page, 'old world dm from alice');
    await B.page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }); await pause(2000);
    await openDm(B.page, ALICE);
    check('bob (0.9.2) reads alice’s DM', await visible(B.page, 'old world dm from alice'));
    await sendHere(B.page, 'old world dm from bob');
    check('0.9.2 DMs are v3 envelopes', lastDmVersion() === '3', lastDmVersion());
    check('accounts predate srp_version / history keys', sql(`SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name IN ('srp_version','history_pubkey')`) === '0');
    await A.ctx.close(); await B.ctx.close();

    // ================================================================ backend upgrade
    console.log('\n=== backend → trunk (same database)');
    await stop(backend, API + '/');
    backend = await startBackend(NEW_ROOT, 'trunk');
    check('migrations 059 and 060 applied', sql('SELECT max(version) FROM _sqlx_migrations') === '60', sql('SELECT max(version) FROM _sqlx_migrations'));
    check('existing accounts default to srp_version 1 with no history key', sql(`SELECT count(*) FROM users WHERE srp_version = 1 AND history_pubkey IS NULL`) === '2');

    // ================================================================ old client, new backend
    console.log('\n=== old client on the new backend');
    const B1 = await fresh('B1');
    const tB1 = await login(B1.page, BOB, PB);
    check('bob’s 0.9.2 client signs in against the trunk backend', !!tB1);
    check('...without touching his SHA-256 verifier (still srp_version 1)', sql(`SELECT srp_version FROM users WHERE id=${userId(BOB)}`) === '1');
    await openDm(B1.page, ALICE);
    check('bob (old client) still reads the old DMs', await visible(B1.page, 'old world dm from alice') && await visible(B1.page, 'old world dm from bob'));
    await sendHere(B1.page, 'bob old client after backend upgrade');
    check('...and still sends (v3)', lastDmVersion() === '3');
    await B1.page.screenshot({ path: OUT + '/upgrade-1-old-client-new-backend.png' });

    // ================================================================ new client
    console.log('\n=== new client');
    await stop(web, WEB + '/');
    web = await startWeb('new');
    const A2 = await fresh('A2');
    const tA2 = await login(A2.page, ALICE, PA);
    check('alice signs in on the new client', !!tA2);
    check('...and was upgraded to Argon2id in that exchange', sql(`SELECT srp_version FROM users WHERE id=${userId(ALICE)}`) === '2');
    await openDm(A2.page, BOB);
    check('alice (new client) reads the whole history incl. bob’s post-upgrade v3', await visible(A2.page, 'old world dm from alice') && await visible(A2.page, 'bob old client after backend upgrade'));
    await sendHere(A2.page, 'alice new client reply');
    check('alice → bob stays v3 while bob has an old client (no session key, no history key)', lastDmVersion() === '3', lastDmVersion());
    await openChannel(A2.page, SERVER, CHANNEL);
    check('alice (new client) reads the old channel message', await visible(A2.page, 'old world channel message'));
    await openDm(A2.page, BOB);
    check('bob (old client, live) receives alice’s v3 reply', await appears(B1.page, 'alice new client reply', 10000));

    // alice turns forward-secret DMs on by regenerating her recovery code
    const codeA = await regenerateRecoveryCode(A2.page, PA);
    check('alice regenerated her recovery code (12 words captured)', codeA.split(' ').length === 12, `${codeA.split(' ').length} words`);
    check('...which created her history key', sql(`SELECT history_pubkey IS NOT NULL AND history_wrapped_rc IS NOT NULL FROM users WHERE id=${userId(ALICE)}`) === 't');
    await openDm(A2.page, BOB);
    await sendHere(A2.page, 'alice after her own upgrade');
    check('still v3: bob has no history key and an old session', lastDmVersion() === '3');

    // bob updates: signs in on the new client (his old session is still recent → still v3)
    const B2 = await fresh('B2');
    await login(B2.page, BOB, PB);
    check('bob upgraded to Argon2id on his new client', sql(`SELECT srp_version FROM users WHERE id=${userId(BOB)}`) === '2');
    {
        const q = `SELECT count(*) FROM token_sessions WHERE user_id=${userId(BOB)} AND dm_pubkey IS NOT NULL AND revoked_at IS NULL`;
        const n = await waitSql(q, '1');
        check('bob’s new session published a DM session key', n === '1', sessionsOf(userId(BOB)));
    }
    const codeB = await regenerateRecoveryCode(B2.page, PB);
    check('bob regenerated his recovery code → history key', codeB.split(' ').length === 12 && sql(`SELECT history_pubkey IS NOT NULL FROM users WHERE id=${userId(BOB)}`) === 't');
    await openDm(A2.page, BOB);
    await sendHere(A2.page, 'alice while bob still has the old client open');
    check('MIXED FLEET: still v3 because bob’s 0.9.2 session is recent', lastDmVersion() === '3', lastDmVersion());
    await openDm(B1.page, ALICE);
    check('bob’s old client reads that message', await appears(B1.page, 'alice while bob still has the old client open', 10000));

    // The old devices are retired (their sessions revoked). The gate is
    // two-sided: alice's own 0.9.2-era session would keep her on v3 just as
    // bob's would, so both accounts' keyless sessions go.
    await B1.ctx.close();
    sql(`UPDATE token_sessions SET revoked_at = NOW() WHERE user_id IN (${userId(BOB)}, ${userId(ALICE)}) AND dm_pubkey IS NULL`);
    check('only key-bearing sessions remain recent for both accounts', sql(`SELECT count(*) FROM token_sessions WHERE user_id IN (${userId(BOB)}, ${userId(ALICE)}) AND revoked_at IS NULL AND dm_pubkey IS NULL`) === '0');
    await openDm(A2.page, BOB);
    await pause(31_000); // the client caches the key lookup for 30 s
    await sendHere(A2.page, 'alice v4 hello');
    check('FORWARD-SECRET: alice → bob is v4 once every recent session on both sides can read it', lastDmVersion() === '4', lastDmVersion());
    await openDm(B2.page, ALICE);
    check('bob (new client, live) reads the v4 message', await appears(B2.page, 'alice v4 hello', 10000));
    await A2.page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }); await pause(2000); await openDm(A2.page, BOB);
    check('alice reads her own v4 message back from the server', await visible(A2.page, 'alice v4 hello'));
    await A2.page.screenshot({ path: OUT + '/upgrade-2-v4-conversation.png' });

    // ================================================================ a new device for bob
    console.log('\n=== bob on a new device (password only)');
    const B3 = await fresh('B3');
    await login(B3.page, BOB, PB);
    await openDm(B3.page, ALICE);
    const lockedMarker = '[Encrypted — enter your recovery code to read older messages here]';
    check('the v4 message is LOCKED on a device that has only the password', await visible(B3.page, lockedMarker));
    check('...while v3 history is readable as before', await visible(B3.page, 'alice new client reply'));
    check('the unlock banner is shown', await B3.page.locator('.history-lock-banner').count() === 1);
    await B3.page.screenshot({ path: OUT + '/upgrade-3-locked-on-new-device.png' });
    await clickPast(B3.page, B3.page.getByRole('button', { name: 'Enter recovery code' }));
    await B3.page.getByPlaceholder('word1 word2 word3 …').fill('wrong words that are not the code at all really');
    await B3.page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await pause(3000);
    check('a wrong code does not unlock', await visible(B3.page, lockedMarker));
    await B3.page.getByPlaceholder('word1 word2 word3 …').fill(codeB);
    await B3.page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await B3.page.getByText('alice v4 hello', { exact: true }).first().waitFor({ timeout: 20000 });
    check('the recovery code unlocks it on this device', true);
    await B3.page.screenshot({ path: OUT + '/upgrade-4-unlocked.png' });
    {
        const q = `SELECT count(*) FROM token_sessions WHERE user_id=${userId(BOB)} AND dm_pubkey IS NOT NULL AND revoked_at IS NULL`;
        const n = await waitSql(q, '2');
        check('the new device published its own session key (bob now has two)', n === '2', sessionsOf(userId(BOB)));
    }
    await pause(31_000); // alice’s key cache: bob now has one more session key to wrap to
    await openDm(A2.page, BOB);
    await sendHere(A2.page, 'alice v4 second');
    check('...and new v4 messages arrive live on the new device', await appears(B3.page, 'alice v4 second', 15000));
    check('...still v4', lastDmVersion() === '4');

    // ---- The server lists a "session" of its own for bob (review C0). Its key
    // carries a signature the account never made, so alice must wrap to every
    // legitimate key and NOT to this one — and stay on v4.
    console.log('\n=== a session key the server made up');
    const attackerKey = 'x25519:' + Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255)).toString('base64');
    const bogusSig = Buffer.alloc(64, 7).toString('base64');
    sql(`INSERT INTO token_sessions (sid, user_id, dm_pubkey, dm_pubkey_sig, reads_up_to) VALUES ('attacker-${Date.now().toString(36)}', ${userId(BOB)}, '${attackerKey}', '${bogusSig}', 4)`);
    await pause(31_000); // past alice's key cache
    await openDm(A2.page, BOB);
    await sendHere(A2.page, 'alice after the server listed a fake session');
    check('...the message is still v4', lastDmVersion() === '4', lastDmVersion());
    const wrapsTo = sql(`SELECT string_agg(w->>'to', ' ') FROM dm_messages, jsonb_array_elements(content::jsonb->'w') w WHERE id = (SELECT id FROM dm_messages ORDER BY created_at DESC LIMIT 1)`);
    check('SIGNED KEYS: the made-up session is NOT among the wrap targets', !wrapsTo.includes(attackerKey), `targets: ${wrapsTo.split(' ').length}`);
    check('...and bob still reads it on his live device', await appears(B3.page, 'alice after the server listed a fake session', 15000));
    sql(`DELETE FROM token_sessions WHERE sid LIKE 'attacker-%'`);

    // ================================================================ SEC-04
    console.log('\n=== a plaintext row inserted server-side');
    sql(`INSERT INTO dm_messages (id, conversation_id, sender_id, content, created_at) VALUES (gen_random_uuid()::text, '${conv.id}', ${userId(ALICE)}, 'this was never sealed', NOW())`);
    await B3.page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }); await pause(2000); await openDm(B3.page, ALICE);
    check('injected plaintext shows, badged "Not encrypted — unexpected"', (await B3.page.getByText('this was never sealed').count()) > 0 && await B3.page.locator('.not-encrypted-tag.unexpected').count() === 1, 'badges: ' + await B3.page.locator('.not-encrypted-tag.unexpected').count()); // substring: the badge shares the element with the text
    await B3.page.screenshot({ path: OUT + '/upgrade-5-unexpected-plaintext.png' });

    // ================================================================ the old client returns
    console.log('\n=== a 0.9.2 client tries a FRESH sign-in to an upgraded account');
    await stop(web, WEB + '/');
    web = await startWeb('old');
    const B4 = await fresh('B4');
    await pause(4000);
    await B4.page.getByPlaceholder('Enter username').fill(BOB);
    await B4.page.getByPlaceholder('Enter password').fill(PB);
    const step2 = B4.page.waitForResponse(r => r.url().includes('/auth/login/step2'), { timeout: 20000 });
    await B4.page.getByRole('button', { name: 'Login', exact: true }).click();
    const res = await step2;
    // Documented consequence of SEC-01: once the account's verifier is Argon2id,
    // a client from before 0.9.3 derives SHA-256 and cannot prove the password.
    // Already-signed-in old clients keep working (proved above); a fresh
    // sign-in from one needs the update. It must fail CLEANLY: a 401, the
    // form still there, nothing rewritten server-side.
    check('a pre-0.9.3 client cannot freshly sign in to an upgraded account (expected, documented)', res.status() === 401, `step2 ${res.status()}`);
    await pause(1500);
    check('...the old client shows its login error and stays on the form', await B4.page.getByPlaceholder('Enter password').isVisible());
    check('...and the account was not touched', sql(`SELECT srp_version FROM users WHERE id=${userId(BOB)}`) === '2');
    await B4.page.screenshot({ path: OUT + '/upgrade-6-old-client-fresh-login.png' });
    await A2.ctx.close(); await B2.ctx.close(); await B3.ctx.close(); await B4.ctx.close();
} catch (e) {
    fails++;
    console.error('FAIL  script error:', e.message);
    try {
        await lastPage.screenshot({ path: OUT + '/upgrade-failure.png' });
        console.error('      page text:', (await lastPage.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 600));
    } catch { /* ignore */ }
} finally {
    await browser.close();
    for (const p of [...procs]) kill(p);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
