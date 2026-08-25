// Diagnose why mobile-walk steps time out: for each selector, report whether
// the element EXISTS and is visible (product concern) versus is covered by
// another element at its centre point (harness/overlap concern).
// Usage: node e2e/mobile-diag.mjs <username> <password>
import { chromium, devices } from '@playwright/test';

const username = process.argv[2];
const password = process.argv[3] || 'Password123!';
const iphone = devices['iPhone 13'];
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...iphone, baseURL: 'http://localhost:5173' });
const page = await ctx.newPage();

await page.goto('/');
await page.waitForURL('**/login');
await page.fill('#username', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');
await page.waitForURL('**/chat', { timeout: 30000 });
await page.waitForTimeout(2000);

// open the default text channel
await page.locator('.mobile-nav-btn').nth(1).tap();
await page.waitForTimeout(500);
await page.locator('.channel-list .channel-name').filter({ hasText: /^default$/ }).first().tap();
await page.waitForTimeout(1200);

const probe = async (label, sel, which = 'first') => {
    const info = await page.evaluate(({ sel, which }) => {
        const els = [...document.querySelectorAll(sel)];
        if (!els.length) return { count: 0 };
        const el = which === 'last' ? els[els.length - 1] : els[0];
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        const cs = getComputedStyle(el);
        return {
            count: els.length,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            inViewport: r.top >= 0 && r.bottom <= innerHeight,
            display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents,
            topAtCentre: top ? `${top.tagName}.${(top.className || '').toString().slice(0, 60)}` : null,
            topIsSelfOrChild: top ? (el.contains(top) || top.contains(el)) : false,
        };
    }, { sel, which });
    console.log(`${label.padEnd(22)} ${JSON.stringify(info)}`);
};

console.log('--- after opening #default ---');
await probe('message-content', '.message-content');
await probe('message-actions', '.message-actions');
await probe('search-input', '.message-search input, .search-input, [class*="search"] input');
await probe('mobile-nav-btns', '.mobile-nav-btn');

// members panel
await page.locator('.mobile-nav-btn').nth(3).tap();
await page.waitForTimeout(900);
console.log('--- members panel ---');
await probe('member-item', '.member-item');
await probe('member-name', '.member-name');
await probe('owner-crown', '.owner-crown');
await probe('member-role-badge', '.member-role-badge');

const memberDump = await page.evaluate(() => [...document.querySelectorAll('.member-item')].map(li => ({
    text: li.textContent.trim().slice(0, 40),
    crown: !!li.querySelector('.owner-crown'),
    badge: li.querySelector('.member-role-badge')?.textContent?.trim() ?? null,
})));
console.log('MEMBERS', JSON.stringify(memberDump));

// Decisive: attempt the actual tap and print the real failure.
await page.locator('.mobile-nav-btn').nth(2).tap();
await page.waitForTimeout(800);
try {
    await page.locator('.message-content').first().tap({ timeout: 4000 });
    console.log('TAP-OK message-content');
} catch (e) { console.log('TAP-FAIL message-content:', String(e).split('\n').slice(0, 6).join(' | ')); }
try {
    await page.locator('.message-content').first().click({ timeout: 4000 });
    console.log('CLICK-OK message-content');
} catch (e) { console.log('CLICK-FAIL message-content:', String(e).split('\n')[0]); }

await browser.close();
