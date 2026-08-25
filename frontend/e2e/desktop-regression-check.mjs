// Desktop non-regression: fine pointer, 1280x800, no touch — confirms the
// coarse-pointer mobile CSS never applies and desktop layout is unchanged.
import { chromium } from '@playwright/test';

const username = 'desk_' + Math.random().toString(36).slice(2, 8);
const outdir = process.argv[2] || 'desktop-shots';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

let n = 0;
const shot = async (label) => {
    n++;
    await page.screenshot({ path: `${outdir}/${String(n).padStart(2, '0')}-${label}.png` });
    console.log('SHOT', label);
};
const tryStep = async (name, fn) => {
    try { await fn(); return true; } catch (e) { console.log(`STEP-FAIL ${name}:`, String(e).split('\n')[0]); return false; }
};

await page.goto('http://localhost:5173/');
await page.waitForURL('**/login');
console.log('coarse-pointer matches (should be false):', await page.evaluate(() => matchMedia('(pointer: coarse) and (max-width: 1024px)').matches));
console.log('bottom-nav present (should be false pre-login):', await page.evaluate(() => !!document.querySelector('.mobile-bottom-nav')));

await page.click('.toggle-mode');
await page.fill('#username', username);
await page.fill('#password', 'Password123!');
await page.click('button[type="submit"]');
await page.waitForURL('**/chat', { timeout: 30000 });
await page.waitForTimeout(1200);
await tryStep('recovery', async () => {
    await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 5000 });
    await page.click('.recovery-done-btn');
});
await page.waitForTimeout(500);
await tryStep('welcome', () => page.click('.welcome-popup-close', { timeout: 3000 }));
await page.waitForTimeout(500);
await shot('friends-home');

console.log('isMobile-driven bottom-nav present (should be false):', await page.evaluate(() => !!document.querySelector('.mobile-bottom-nav')));
console.log('friends-dashboard left (should be 72px, not 0):', await page.evaluate(() => {
    const el = document.querySelector('.friends-dashboard');
    return el ? getComputedStyle(el).left : null;
}));

// Create a server and check normal desktop layout
await tryStep('create-server', async () => {
    await page.locator('.server-icon.add-server').click({ timeout: 4000 });
    await page.waitForTimeout(400);
    await page.locator('.template-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.audience-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill('Desktop Test');
    await page.locator('.wizard-actions .create-btn').click();
    await page.waitForTimeout(1500);
});
await shot('server-created');

await tryStep('open-settings', async () => {
    await page.locator('.user-action-btn[title="Settings"]').click({ timeout: 4000 });
    await page.waitForTimeout(600);
});
await shot('settings-modal');
console.log('settings-modal width (should be 90vw/1100px, not 100vw):', await page.evaluate(() => {
    const el = document.querySelector('.settings-modal');
    return el ? getComputedStyle(el).width : null;
}));
await tryStep('close-settings', () => page.keyboard.press('Escape'));
await page.waitForTimeout(400);

await tryStep('send-message', async () => {
    const ta = page.locator('.message-textarea');
    await ta.click({ timeout: 4000 });
    await ta.fill('Desktop regression check message.');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
});
await shot('message-sent');

await tryStep('emoji-picker', async () => {
    await page.locator('.emoji-toggle').click({ timeout: 4000 });
    await page.waitForTimeout(500);
});
await shot('emoji-picker');
console.log('emoji-picker width (should be 352px, not stretched):', await page.evaluate(() => {
    const el = document.querySelector('.emoji-picker');
    return el ? getComputedStyle(el).width : null;
}));

console.log('DONE user=', username);
await browser.close();
