// Geometry probe for the mobile Friends dashboard sidebar clipping.
import { chromium, devices } from '@playwright/test';

const username = process.argv[2];
const password = process.argv[3] || 'Password123!';

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
await page.waitForTimeout(2000);
try { await page.click('.welcome-popup-close', { timeout: 2500 }); } catch { /* none */ }

await page.locator('.mobile-nav-btn').nth(0).tap();
await page.waitForTimeout(400);
await page.locator('.server-icon[title="Direct Messages"]').tap({ timeout: 4000 });
await page.waitForTimeout(1000);

const geo = await page.evaluate(() => {
    const grab = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
                 maxH: s.maxHeight, overflow: s.overflow + '/' + s.overflowY, flex: s.flex, display: s.display, minH: s.minHeight };
    };
    return {
        dashboard: grab('.friends-dashboard'),
        sidebar: grab('.friends-sidebar'),
        search: grab('.sidebar-search'),
        nav: grab('.sidebar-nav'),
        dmSection: grab('.dm-section'),
        dmList: grab('.dm-list'),
        dmItem: grab('.dm-item'),
        main: grab('.friends-main'),
    };
});
console.log(JSON.stringify(geo, null, 1));
await browser.close();
