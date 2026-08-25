// Mobile: tap the CONNECTED voice channel → should switch to the chat panel
// and show the VoiceStage (not disconnect). Screenshot for eyeballing overlap
// with the fixed voice-panel bar.
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';

const outdir = process.argv[2] || 'mvs-shots';
fs.mkdirSync(outdir, { recursive: true });
const username = 'mvs_' + Math.random().toString(36).slice(2, 8);

const iphone = devices['iPhone 13'];
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ ...iphone, defaultBrowserType: undefined, baseURL: 'http://localhost:5173' });
const page = await ctx.newPage();
const tryStep = async (name, fn) => { try { await fn(); } catch (e) { console.log(`STEP-FAIL ${name}:`, String(e).split('\n')[0]); } };

await page.goto('/');
await page.waitForURL('**/login');
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

await page.locator('.mobile-nav-btn').nth(0).tap();
await page.waitForTimeout(400);
await page.locator('.server-add-wrapper .server-icon.add-server').tap({ timeout: 4000 });
await page.locator('.template-card').first().tap({ timeout: 4000 });
await page.locator('.audience-card').first().tap({ timeout: 4000 });
await page.locator('.server-name-input input').fill('VS Mobile');
await page.locator('.wizard-actions .create-btn').tap();
await page.waitForTimeout(2000);

await page.locator('.mobile-nav-btn').nth(1).tap(); // channels
await page.waitForTimeout(500);
const vc = page.locator('.voice-channel-list .channel.voice-channel').first();
await vc.tap();
await page.waitForTimeout(3000); // join
await page.locator('.mobile-nav-btn').nth(1).tap(); // back to channels panel
await page.waitForTimeout(400);
await vc.tap(); // tap CONNECTED channel → stage on chat panel
await page.waitForTimeout(1000);

const onChat = await page.evaluate(() =>
    document.querySelector('.chat-container')?.getAttribute('data-mobile-panel'));
const stage = await page.locator('.voice-stage').isVisible().catch(() => false);
const stillIn = await page.evaluate(() => !!document.querySelector('.voice-panel-compact'));
console.log(`panel=${onChat} stageVisible=${stage} stillConnected=${stillIn}`);
await page.screenshot({ path: `${outdir}/mobile-voice-stage.png` });
console.log('SHOT', `${outdir}/mobile-voice-stage.png`);
await browser.close();
console.log(onChat === 'chat' && stage && stillIn ? 'PASS' : 'FAIL');
