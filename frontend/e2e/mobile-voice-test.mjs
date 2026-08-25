// Focused test: register, create server (with default voice channel), join
// voice, and verify the voice-panel portal is visible + positioned correctly
// while on the CHAT panel (the bug the portal fix targets).
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';

const outdir = process.argv[2] || 'voice-shots';
fs.mkdirSync(outdir, { recursive: true });
const username = 'vt_' + Math.random().toString(36).slice(2, 8);

const iphone = devices['iPhone 13'];
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ ...iphone, defaultBrowserType: undefined, baseURL: 'http://localhost:5173' });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

let n = 0;
const shot = async (label) => {
    n++;
    const f = `${outdir}/${String(n).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: f });
    console.log('SHOT', f);
};
const tryStep = async (name, fn) => {
    try { await fn(); return true; } catch (e) { console.log(`STEP-FAIL ${name}:`, String(e).split('\n')[0]); return false; }
};

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
await page.waitForTimeout(500);

await tryStep('open-wizard', async () => {
    await page.locator('.mobile-nav-btn').nth(0).tap();
    await page.waitForTimeout(400);
    await page.locator('.server-icon.add-server').tap({ timeout: 4000 });
});
await page.waitForTimeout(500);
await tryStep('wizard', async () => {
    await page.locator('.template-card').first().tap({ timeout: 4000 });
    await page.waitForTimeout(400);
    await page.locator('.audience-card').first().tap({ timeout: 4000 });
    await page.waitForTimeout(400);
    await page.locator('.server-name-input input').fill('Voice Test');
    await page.locator('.wizard-actions .create-btn').tap();
    await page.waitForTimeout(2000);
});
await shot('after-create');

// Go to channels, join the pre-existing "default" voice channel
await tryStep('nav-channels', () => page.locator('.mobile-nav-btn').nth(1).tap());
await page.waitForTimeout(500);
await shot('channels-before-voice');
await tryStep('join-voice', async () => {
    await page.locator('.voice-channel-list .channel.voice-channel', { hasText: 'default' }).first().tap({ timeout: 6000 });
    await page.waitForTimeout(3000);
});
await shot('channels-after-voice-join');

// Clips are DESKTOP capture (docs/CLIPS.md): the Arm/Save buttons must never
// render on a phone. A NEGATIVE assertion — it goes red the day someone drops
// the isTauri() gate and ships a screen-capture button to mobile.
await tryStep('clips-absent-on-mobile', async () => {
    const n = await page.locator('.voice-clip-arm, .voice-clip-save, .voice-clip-status').count();
    if (n !== 0) throw new Error(`clip controls rendered on mobile (${n})`);
    console.log('>>> clips-absent-on-mobile: OK (0 clip controls)');
});

const dump = async (label) => {
    const info = await page.evaluate(() => {
        const vp = document.querySelector('.voice-panel-compact');
        if (!vp) return null;
        const cs = getComputedStyle(vp);
        const rect = vp.getBoundingClientRect();
        return { position: cs.position, bottom: cs.bottom, zIndex: cs.zIndex, transform: cs.transform, rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }, parentIsBody: vp.parentElement === document.body };
    });
    console.log(`>>> [${label}] voice-panel=${JSON.stringify(info)}`);
};
await dump('after-join-on-channels-panel');

// Now switch to CHAT panel — this is where the old bug hid the voice panel
// entirely (trapped inside the transformed .sidebar).
await tryStep('nav-chat', () => page.locator('.mobile-nav-btn').nth(2).tap());
await page.waitForTimeout(700);
await shot('chat-panel-with-voice');
await dump('after-nav-to-chat');

// Dismiss Friends and actually look at a text channel's message-form with
// the voice panel connected, to visually confirm the overlap.
await tryStep('open-text-channel', async () => {
    await page.locator('.mobile-nav-btn').nth(1).tap();
    await page.waitForTimeout(400);
    await page.locator('.channel-list .channel-name', { hasText: 'default' }).first().tap({ timeout: 4000 });
    await page.waitForTimeout(400);
    await page.locator('.mobile-nav-btn').nth(2).tap();
    await page.waitForTimeout(600);
});
await shot('text-channel-with-voice-connected');

// Check message-form is not covered by the voice panel
const overlapInfo = await page.evaluate(() => {
    const vp = document.querySelector('.voice-panel-compact');
    const mf = document.querySelector('.message-form');
    if (!vp || !mf) return { vp: !!vp, mf: !!mf };
    const vr = vp.getBoundingClientRect();
    const mr = mf.getBoundingClientRect();
    const overlap = !(vr.bottom <= mr.top || vr.top >= mr.bottom);
    return { vpRect: { top: vr.top, bottom: vr.bottom }, mfRect: { top: mr.top, bottom: mr.bottom }, overlap };
});
console.log('>>> [overlap-check]', JSON.stringify(overlapInfo));

// Also check the checklist-drawer-closes-on-nav fix
await tryStep('open-channel-checklist', async () => {
    // The drawer-under-test is now the text-channel checklist (self-DM notes
    // moved into the Tasks dashboard, which is panel-managed, not a drawer).
    await page.locator('.mobile-nav-btn').nth(1).tap(); // Channels panel
    await page.waitForTimeout(400);
    await page.locator('.channel-list .channel-name', { hasText: 'default' }).first().tap({ timeout: 4000 });
    await page.waitForTimeout(600);
    await page.locator('.checklist-toggle-btn').first().tap({ timeout: 3000 });
    await page.waitForTimeout(600);
});
await shot('checklist-open');
await tryStep('nav-away-from-checklist', () => page.locator('.mobile-nav-btn').nth(1).tap());
await page.waitForTimeout(500);
await shot('after-nav-away-checklist-should-be-closed');
const checklistStillOpen = await page.evaluate(() => !!document.querySelector('.checklist-panel'));
console.log('>>> [checklist-closed-on-nav] stillOpen=', checklistStillOpen);

console.log('DONE user=', username);
await browser.close();
