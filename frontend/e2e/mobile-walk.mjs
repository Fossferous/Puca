// Portrait-mode walk of the Puca app with real touch emulation.
// Usage: node mobile-walk.mjs <outdir> [username]
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';

const outdir = process.argv[2] || 'shots';
const username = process.argv[3] || ('mob_' + Math.random().toString(36).slice(2, 8));
fs.mkdirSync(outdir, { recursive: true });

const iphone = devices['iPhone 13'];
const browser = await chromium.launch();
const ctx = await browser.newContext({
    ...iphone,
    defaultBrowserType: undefined,
    baseURL: 'http://localhost:5173',
});
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

let n = 0;
const shot = async (name) => {
    n++;
    const f = `${outdir}/${String(n).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path: f });
    console.log('SHOT', f);
};
const tryStep = async (name, fn) => {
    try { await fn(); } catch (e) { console.log(`STEP-FAIL ${name}:`, String(e).split('\n')[0]); }
};

// ---- 1. Login screen
await page.goto('/');
await page.waitForURL('**/login');
await page.waitForTimeout(800);
await shot('login');

// media-query sanity
console.log('MQ coarse+1024:', await page.evaluate(() =>
    matchMedia('(pointer: coarse) and (max-width: 1024px)').matches));

// ---- 2. Register
await page.click('.toggle-mode');
await page.fill('#username', username);
await page.fill('#password', 'Password123!');
await shot('register-filled');
await page.click('button[type="submit"]');
await page.waitForURL('**/chat', { timeout: 30000 });
await page.waitForTimeout(1500);
await shot('post-register'); // recovery modal expected

// ---- 3. Recovery modal
await tryStep('recovery', async () => {
    await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 5000 });
    await page.click('.recovery-done-btn');
    await page.waitForTimeout(800);
});
await shot('after-recovery'); // welcome popup expected

await tryStep('welcome', async () => {
    await page.click('.welcome-popup-close', { timeout: 4000 });
    await page.waitForTimeout(500);
});
await shot('main-initial');

// ---- 4. Bottom nav panels
for (const p of ['servers', 'channels', 'chat', 'members']) {
    await tryStep(`nav-${p}`, async () => {
        const idx = { servers: 0, channels: 1, chat: 2, members: 3 }[p];
        await page.locator('.mobile-nav-btn').nth(idx).tap({ timeout: 4000 });
        await page.waitForTimeout(600);
    });
    await shot(`panel-${p}`);
}

// ---- 5. Create a server via wizard
await tryStep('open-wizard', async () => {
    await page.locator('.mobile-nav-btn').nth(0).tap();
    await page.waitForTimeout(500);
    // The add-server control is a div.server-icon (not a <button>).
    await page.locator('.server-add-wrapper .server-icon.add-server').tap({ timeout: 4000 });
    await page.waitForTimeout(600);
});
await shot('wizard-step1');
await tryStep('wizard-walk', async () => {
    // step 1: pick first template
    await page.locator('.wizard-step .template-card, .template-step button, .template-step [class*="card"]').first().tap({ timeout: 4000 });
    await page.waitForTimeout(400);
    await shot('wizard-step2');
    // step 2: pick first audience option
    await page.locator('.audience-step button:not(.wizard-back), .audience-step [class*="card"]').first().tap({ timeout: 4000 });
    await page.waitForTimeout(400);
    await shot('wizard-step3');
    // step 3: name + create
    const nameInput = page.locator('.customize-step input[type="text"]').first();
    await nameInput.fill('Mobile Test Server', { timeout: 4000 });
    await page.locator('.wizard-actions button').last().tap();
    await page.waitForTimeout(1500);
});
await shot('after-server-create');

// ---- 6. Channels panel with real server, open a channel
await tryStep('channels-open', async () => {
    await page.locator('.mobile-nav-btn').nth(1).tap();
    await page.waitForTimeout(600);
});
await shot('channels-with-server');
await tryStep('open-channel', async () => {
    await page.locator('.channel-item, .channel-list li, [class*="channel-name"]').first().tap({ timeout: 4000 });
    await page.waitForTimeout(800);
});
await shot('chat-view');

// ---- 7. Send a message
await tryStep('send-msg', async () => {
    const input = page.locator('.message-form input[type="text"], .message-form textarea').first();
    await input.tap({ timeout: 4000 });
    await input.fill('Hello from portrait emulation! This is a longer message to see how wrapping behaves on a narrow screen.');
    await shot('composing');
    await page.locator('.message-form button[type="submit"]').tap();
    await page.waitForTimeout(800);
});
await shot('after-send');

// ---- 8. Emoji picker
await tryStep('emoji', async () => {
    await page.locator('.message-form .emoji-btn, .message-form button[title*="moji" i], .message-form [class*="emoji"]').first().tap({ timeout: 4000 });
    await page.waitForTimeout(600);
    await shot('emoji-picker');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
});

// ---- 9. Members panel (select by label — Tasks moved to the far right,
// so fixed indices for the last two buttons went stale)
await tryStep('members', async () => {
    await page.locator('.mobile-nav-btn', { hasText: 'Members' }).tap();
    await page.waitForTimeout(600);
});
await shot('members-panel');

// ---- 10. Settings modal
await tryStep('settings', async () => {
    await page.locator('.mobile-nav-btn').nth(1).tap(); // channels panel shows user bar
    await page.waitForTimeout(400);
    await page.locator('.user-action-btn[title="Settings"]').evaluate(el => el.click());
    await page.waitForTimeout(700);
});
await shot('settings-modal');
await tryStep('settings-close', async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
});

// ---- 11. Add-channel modal (checklist etc.)
await tryStep('add-channel', async () => {
    await page.locator('.mobile-nav-btn').nth(1).tap();
    await page.waitForTimeout(400);
    await page.locator('.add-channel-btn').first().evaluate(el => el.click());
    await page.waitForTimeout(600);
});
await shot('add-channel-modal');
await tryStep('close-modal', async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
});

console.log('DONE. user=', username);
await browser.close();
