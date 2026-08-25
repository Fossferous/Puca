import { chromium, devices } from '@playwright/test';
const username = process.argv[2], password = process.argv[3] || 'Password123!';
const iphone = devices['iPhone 13'];
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...iphone, defaultBrowserType: undefined, baseURL: 'http://localhost:5173' });
const page = await ctx.newPage();
await page.goto('/');
await page.waitForURL('**/login');
await page.fill('#username', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');
await page.waitForURL('**/chat', { timeout: 30000 });
await page.waitForTimeout(1200);
try { await page.click('.welcome-popup-close', { timeout: 3000 }); } catch {}
await page.locator('.mobile-nav-btn').nth(1).tap();
await page.waitForTimeout(400);
await page.locator('.channel-list .channel-name', { hasText: 'default' }).first().tap({ timeout: 4000 });
await page.waitForTimeout(400);
await page.locator('.mobile-nav-btn').nth(2).tap();
await page.waitForTimeout(500);
await page.locator('.emoji-toggle').tap({ timeout: 4000 });
await page.waitForTimeout(600);
const box = await page.locator('.emoji-picker').boundingBox();
console.log('emoji-picker box:', JSON.stringify(box), 'viewport width: 390');
// Writes beside this script by default; set SHOT_DIR to send it elsewhere.
// (This was an absolute path into one machine's temp directory, which meant it
// only ever worked on that machine — and published its username.)
await page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/emoji-final.png` });
await browser.close();
