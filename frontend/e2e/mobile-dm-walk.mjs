// Focused portrait walk: the DM home layout (HomeSidebar refactor).
// Verifies on a coarse-pointer 390x844 phone:
//   1. server sidebar has NO Direct Messages section
//   2. Friends dashboard DM list shows the account's conversations
//   3. tapping a DM opens the conversation in the chat panel
//   4. the channels panel then hosts the home sidebar (search + nav + DM list)
//   5. Friends nav row reopens the dashboard
// Requires the account to have at least ONE DM conversation.
// Usage: node e2e/mobile-dm-walk.mjs <outdir> <username> <password>
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';

const outdir = process.argv[2] || 'shots-dm';
const username = process.argv[3];
const password = process.argv[4] || 'Password123!';
fs.mkdirSync(outdir, { recursive: true });

const iphone = devices['iPhone 13'];
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...iphone, defaultBrowserType: undefined, baseURL: 'http://localhost:5173' });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

let failures = 0;
const check = (name, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failures++;
};
let n = 0;
const shot = async (name) => {
    n++;
    const f = `${outdir}/${String(n).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path: f });
    console.log('SHOT', f);
};
const nav = async (i) => { await page.locator('.mobile-nav-btn').nth(i).tap(); await page.waitForTimeout(500); };

await page.goto('/');
await page.waitForURL('**/login');
await page.fill('#username', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');
await page.waitForURL('**/chat', { timeout: 30000 });
await page.waitForTimeout(2000);
try { await page.click('.welcome-popup-close', { timeout: 2500 }); } catch { /* no popup */ }

// 1. Server context: channels panel must have zero DM chrome.
await nav(1);
await shot('channels-panel');
check('server sidebar has channel list', await page.locator('.sidebar .channel-list').count() > 0);
check('server sidebar has NO dm-section', await page.locator('.sidebar .dm-section').count() === 0);
check('server sidebar has NO home sidebar', await page.locator('.sidebar .friends-sidebar').count() === 0);

// 2. Friends dashboard via the rail home button.
await nav(0);
await page.locator('.server-icon[title="Direct Messages"]').tap({ timeout: 4000 });
await page.waitForTimeout(1000);
await shot('friends-dashboard');
check('dashboard open', await page.locator('.friends-dashboard').count() > 0);
const dmRow = page.locator('.friends-dashboard .dm-item').first();
check('DM list has at least one conversation', await dmRow.count() > 0);
const dmName = (await dmRow.locator('.dm-username').textContent().catch(() => ''))?.trim() ?? '';

// 3. Tap a DM -> conversation in the chat panel.
await dmRow.tap({ timeout: 4000 });
await page.waitForTimeout(1200);
await shot('dm-open');
check('dashboard closed after opening DM', await page.locator('.friends-dashboard').count() === 0);
check('header matches the tapped conversation',
    (await page.locator('.chat-header h2').textContent().catch(() => '')) === dmName, dmName);
check('DM composer placeholder',
    (await page.locator('.message-textarea').getAttribute('placeholder').catch(() => '')) === `Message @${dmName}`);

// 4. Channels panel now hosts the home sidebar.
await nav(1);
await shot('home-sidebar-panel');
check('home sidebar present', await page.locator('.sidebar .friends-sidebar').count() > 0);
check('home sidebar has search', await page.locator('.sidebar .friends-sidebar .sidebar-search input').count() > 0);
check('home sidebar has Friends/Tasks nav', await page.locator('.sidebar .friends-sidebar .nav-item').count() === 2);
check('active DM highlighted', await page.locator('.sidebar .friends-sidebar .dm-item.active').count() > 0);

// 5. Friends nav row reopens the dashboard.
await page.locator('.sidebar .friends-sidebar .nav-item', { hasText: 'Friends' }).tap({ timeout: 4000 });
await page.waitForTimeout(800);
await shot('back-to-dashboard');
check('dashboard reopened', await page.locator('.friends-dashboard').count() > 0);

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
