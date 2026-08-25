// Live 2-user blocking test: blocked members' server messages collapse to a
// stub, blocking mutes their voice locally, the context menu flips to
// Unblock, and unblocking restores everything. Exercises the full wiring the
// static review can't run: blockStore load → context-menu block → render
// collapse → localStorage voice mute → unblock reveal.
//
// Prereqs: native Postgres + backend (:3000) + vite (:5173) up.
// Usage: node e2e/block-2user.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const BLOCKER = 'blk_owner_' + stamp;
const BLOCKED = 'blk_member_' + stamp;
const MARKER = `blocktest-${stamp}`;

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-d', 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

const browser = await chromium.launch();

async function register(ctx, user) {
    const page = await ctx.newPage();
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

// Right-click the member row and click a context-menu action containing actionWord.
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

const localMutes = (page) => page.evaluate(() =>
    JSON.parse(localStorage.getItem('sovereign_local_user_mutes') || '{}'));

try {
    const ctxA = await browser.newContext();
    const blocker = await register(ctxA, BLOCKER);
    await createServer(blocker, 'BlockTest');
    const aId = psql(`SELECT id FROM users WHERE username='${BLOCKER}'`);
    const serverId = psql(`SELECT id FROM servers WHERE owner_id=${aId} ORDER BY id DESC LIMIT 1`);
    check('server created', !!serverId);

    const ctxB = await browser.newContext();
    const blocked = await register(ctxB, BLOCKED);
    const bId = psql(`SELECT id FROM users WHERE username='${BLOCKED}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bId}) ON CONFLICT DO NOTHING`);

    // B opens the server and sends a channel message (E2EE happens in-page).
    await selectServer(blocked);
    const composer = blocked.locator('textarea[placeholder^="Message #"]');
    await composer.waitFor({ timeout: 8000 });
    await composer.fill(MARKER);
    await composer.press('Enter');
    await blocked.waitForTimeout(1500);

    // A sees the message.
    await selectServer(blocker);
    check('blocker sees the message before blocking',
        await blocker.locator('.message-content', { hasText: MARKER }).count() > 0);

    // A blocks B from the member context menu (confirm auto-accepted).
    const blockRes = await contextAction(blocker, BLOCKED, 'Block');
    console.log('  block action:', blockRes);
    check('block action clicked', blockRes === 'clicked');
    await blocker.waitForTimeout(1500);

    check('blocked_users row exists',
        psql(`SELECT count(*) FROM blocked_users WHERE blocker_id=${aId} AND blocked_id=${bId}`) === '1');
    check('message content hidden after block',
        await blocker.locator('.message-content', { hasText: MARKER }).count() === 0);
    check('blocked stub shown',
        await blocker.locator('.blocked-message-stub').count() > 0);
    const mutes1 = await localMutes(blocker);
    check('voice locally muted on block', mutes1[bId] === true);

    // The context menu now offers Unblock; use it.
    const unblockRes = await contextAction(blocker, BLOCKED, 'Unblock');
    console.log('  unblock action:', unblockRes);
    check('unblock action clicked (menu flipped to Unblock)', unblockRes === 'clicked');
    await blocker.waitForTimeout(1500);

    check('blocked_users row gone after unblock',
        psql(`SELECT count(*) FROM blocked_users WHERE blocker_id=${aId} AND blocked_id=${bId}`) === '0');
    check('message content restored after unblock (no refetch needed)',
        await blocker.locator('.message-content', { hasText: MARKER }).count() > 0);
    check('stub gone after unblock',
        await blocker.locator('.blocked-message-stub').count() === 0);
    const mutes2 = await localMutes(blocker);
    check('voice mute lifted on unblock', mutes2[bId] === false);
} catch (e) {
    console.log('EXCEPTION:', String(e).split('\n').slice(0, 2).join(' | '));
    failures++;
} finally {
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
