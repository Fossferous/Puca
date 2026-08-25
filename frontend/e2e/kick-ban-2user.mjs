// Live 2-user kick/ban test for the newly-wired UserContextMenu buttons
// (they used to just console.log). A fresh owner and a fresh member share a
// server; the owner right-clicks the member and Kicks, then Bans, and we assert
// the server-side effect (server_members row gone; ban row present) plus the
// member vanishing from the owner's list.
//
// Prereqs: native Postgres + backend (:3000) + vite (:5173) up.
// Usage: node e2e/kick-ban-2user.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const OWNER = 'kbowner_' + stamp;
const MEMBER = 'kbmember_' + stamp;

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-d', 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

const browser = await chromium.launch();

async function register(ctx, user) {
    const page = await ctx.newPage();
    // Auto-accept the kick/ban confirm() dialogs.
    page.on('dialog', d => d.accept().catch(() => {}));
    await page.goto('http://localhost:5173/login');
    await page.waitForURL('**/login');
    await page.waitForSelector('#username', { timeout: 10000 });
    await page.click('.toggle-mode', { timeout: 5000 });
    await page.waitForSelector('#inviteCode', { timeout: 5000 });
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 30000 });
    await page.waitForTimeout(1200);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* older */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    return page;
}

async function createServer(page, name) {
    await page.locator('.server-icon.add-server').click({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.locator('.template-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.audience-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill(name);
    await page.locator('.wizard-actions .create-btn').click();
    await page.waitForTimeout(2500);
}

async function selectServer(page) {
    await page.reload();
    await page.waitForTimeout(1800);
    await page.evaluate(() => {
        const t = [...document.querySelectorAll('.server-icon')].find(i => !/direct message|add server|join server|notes|tasks/i.test(
            (i.getAttribute('title') || '') + ' ' + (i.className || '')));
        t?.click();
    });
    await page.waitForTimeout(1200);
}

// Right-click the member row (not the owner) and click a context-menu action.
async function contextAction(page, memberName, actionWord) {
    return await page.evaluate(async ({ memberName, actionWord }) => {
        const row = [...document.querySelectorAll('.member-item')].find(m => m.textContent.includes(memberName));
        if (!row) return 'member-row-not-found';
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 }));
        await new Promise(res => setTimeout(res, 400));
        const btn = [...document.querySelectorAll('.user-context-menu button')].find(b => b.textContent.includes(actionWord));
        if (!btn) return 'action-btn-not-found';
        btn.click();
        return 'clicked';
    }, { memberName, actionWord });
}

try {
    const ctxO = await browser.newContext();
    const owner = await register(ctxO, OWNER);
    await createServer(owner, 'KickBanTest');
    const oId = psql(`SELECT id FROM users WHERE username='${OWNER}'`);
    const serverId = psql(`SELECT id FROM servers WHERE owner_id=${oId} ORDER BY id DESC LIMIT 1`);
    check('server created', !!serverId);

    const ctxM = await browser.newContext();
    await register(ctxM, MEMBER); // registers the account
    const mId = psql(`SELECT id FROM users WHERE username='${MEMBER}'`);

    // --- KICK ---
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${mId}) ON CONFLICT DO NOTHING`);
    check('member joined (pre-kick)', psql(`SELECT count(*) FROM server_members WHERE server_id='${serverId}' AND user_id=${mId}`) === '1');
    await selectServer(owner);
    check('owner sees the member', await owner.locator('.member-item', { hasText: MEMBER }).count() > 0);
    const kickRes = await contextAction(owner, MEMBER, 'Kick');
    console.log('  kick action:', kickRes);
    check('kick action clicked', kickRes === 'clicked');
    await owner.waitForTimeout(1500);
    check('member removed from server_members after kick', psql(`SELECT count(*) FROM server_members WHERE server_id='${serverId}' AND user_id=${mId}`) === '0');
    check('member gone from owner list after kick', await owner.locator('.member-item', { hasText: MEMBER }).count() === 0);

    // --- BAN (re-add first, then ban) ---
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${mId}) ON CONFLICT DO NOTHING`);
    await selectServer(owner);
    check('owner sees the member again (pre-ban)', await owner.locator('.member-item', { hasText: MEMBER }).count() > 0);
    const banRes = await contextAction(owner, MEMBER, 'Ban');
    console.log('  ban action:', banRes);
    check('ban action clicked', banRes === 'clicked');
    await owner.waitForTimeout(1500);
    check('member removed from server_members after ban', psql(`SELECT count(*) FROM server_members WHERE server_id='${serverId}' AND user_id=${mId}`) === '0');
    const banRows = psql(`SELECT count(*) FROM bans WHERE server_id='${serverId}' AND user_id=${mId}`);
    check('ban row recorded in server_bans', banRows === '1');
} catch (e) {
    console.log('EXCEPTION:', String(e).split('\n').slice(0, 2).join(' | '));
    failures++;
} finally {
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
