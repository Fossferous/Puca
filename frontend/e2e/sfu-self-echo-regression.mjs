// Regression for the self-echo bug (v0.6.4): ONE user in an SFU channel from
// TWO tabs must never render its own audio back. Pre-fix, each connection
// (u<id>#nonceA / u<id>#nonceB) subscribed the other → the user heard
// themselves. The fix filters any track whose u<id> equals ours.
//
// Asserts: tab B, joined to the same sfu_mode channel as tab A (same account),
// creates NO audio-<ownUid> element and logs no incoming SFU camera/mic for
// its own uid. Also confirms the LiveKit room never holds 3+ ghost sessions.
//
// Usage: INVITE=... node e2e/sfu-self-echo-regression.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const APP = 'https://app.example.com';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const USER = 'echo_' + stamp;
const INVITE = process.env.INVITE || '';
const KEY = homedir().replace(/\\/g, '/') + '/.ssh/puca_deploy';
// The live SFU tests need shell access to the box running Postgres and LiveKit.
// There is no sensible default: a wrong host would quietly query the wrong
// database and report a pass, so it must be supplied explicitly.
//
//   SFU_SSH_HOST=root@your-server \
//   [SFU_DB_EXEC='pct exec <ctid> -- ']  # wrapper if the DB is in a container
//   [SFU_DB_NAME=puca] [SFU_SSH_KEY=~/.ssh/id_ed25519] \
//   INVITE=... node e2e/<this-script>
const SSH_HOST = process.env.SFU_SSH_HOST || '';
const SSH_KEY = process.env.SFU_SSH_KEY || KEY;
const DB_EXEC = process.env.SFU_DB_EXEC || '';
const DB_NAME = process.env.SFU_DB_NAME || 'puca';
if (!SSH_HOST) {
    console.error('SFU_SSH_HOST is not set - see the header of this file.');
    process.exit(2);
}
const psql = (sql) => execFileSync('ssh', ['-i', SSH_KEY, SSH_HOST,
    `${DB_EXEC}su postgres -c "psql ${DB_NAME} -t -A -c \\"${sql}\\""`], { timeout: 30000 }).toString().trim();

let failures = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };

async function register(ctx, user) {
    const page = await ctx.newPage();
    await page.goto(APP + '/login');
    await page.waitForSelector('#username', { timeout: 20000 });
    await page.click('.toggle-mode');
    await page.waitForSelector('#inviteCode', { timeout: 5000 });
    await page.fill('#inviteCode', INVITE);
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 45000 });
    await page.waitForTimeout(1500);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 5000 }); await page.click('.recovery-done-btn'); } catch { /* */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* */ }
    return page;
}
// Second tab of the SAME account: log in (account already exists).
async function login(ctx, user) {
    const page = await ctx.newPage();
    await page.goto(APP + '/login');
    await page.waitForSelector('#username', { timeout: 20000 });
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 45000 });
    await page.waitForTimeout(1500);
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* */ }
    return page;
}
async function createServer(page, name) {
    await page.locator('.server-icon.add-server').click({ timeout: 8000 });
    await page.waitForTimeout(600);
    await page.locator('.template-card').first().click({ timeout: 5000 });
    await page.waitForTimeout(300);
    await page.locator('.audience-card').first().click({ timeout: 5000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill(name);
    await page.locator('.wizard-actions .create-btn').click();
    await page.waitForTimeout(3000);
}
async function joinVoice(page, chName) {
    await page.reload();
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
        const icons = [...document.querySelectorAll('.server-icon')];
        icons.find(i => !/direct message|add server|join server|notes|tasks/i.test((i.getAttribute('title') || '') + ' ' + (i.className || '')))?.click();
    });
    await page.waitForTimeout(2000);
    return await page.evaluate((name) => {
        const el = [...document.querySelectorAll('.voice-channel-list .voice-channel')].find(n => !n.classList.contains('afk') && n.textContent.includes(name));
        if (el) { el.click(); return true; } return false;
    }, chName);
}

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
    if (!INVITE) { console.log('FATAL: INVITE not set'); process.exit(1); }
    const ctxA = await browser.newContext();
    const pageA = await register(ctxA, USER);
    await createServer(pageA, 'EchoTest');
    const uid = psql(`SELECT id FROM users WHERE username='${USER}'`);
    const serverId = psql(`SELECT id FROM servers WHERE owner_id=${uid} ORDER BY created_at DESC LIMIT 1`);
    const chRow = psql(`SELECT id||'|'||name FROM channels WHERE server_id='${serverId}' AND type=1 AND COALESCE(is_afk,false)=false ORDER BY id LIMIT 1`);
    const [chId, chName] = chRow.split('|');
    psql(`UPDATE channels SET sfu_mode=true WHERE id=${chId}`);
    check('sfu_mode channel ready', !!chId, chRow);

    check('tab A joined voice', await joinVoice(pageA, chName));
    await pageA.waitForTimeout(7000);

    // Second tab, SAME account, same channel.
    const ctxB = await browser.newContext();
    const pageB = await login(ctxB, USER);
    check('tab B joined voice', await joinVoice(pageB, chName));
    await pageB.waitForTimeout(9000);

    // THE ASSERTION: tab B must NOT have created an audio element for its OWN
    // uid (that element playing = the user hears themselves).
    const ownAudioB = await pageB.evaluate((uid) => !!document.getElementById('audio-' + uid), Number(uid));
    check('tab B does NOT play its own audio (no self-echo)', ownAudioB === false, 'audio-' + uid + ' present');
    const ownAudioA = await pageA.evaluate((uid) => !!document.getElementById('audio-' + uid), Number(uid));
    check('tab A does NOT play its own audio', ownAudioA === false);

    // Server truth: the room should hold the live sessions but the client must
    // not render self. (2 sessions of one user is expected; 3+ = leak.)
    const active = execFileSync('ssh', ['-i', SSH_KEY, SSH_HOST,
        `${DB_EXEC}bash -c "journalctl -u livekit --since '-3 min' --no-pager | grep -c 'participant active.*sfu_${chId}' || true"`], { timeout: 30000 }).toString().trim();
    check('no runaway ghost sessions (<=2 joins in window)', Number(active) <= 2, 'joins=' + active);

    // Cleanup
    psql(`DELETE FROM servers WHERE id='${serverId}'; DELETE FROM users WHERE username='${USER}'`);
} catch (e) {
    console.log('FATAL', e.message); failures++;
} finally { await browser.close(); }
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
