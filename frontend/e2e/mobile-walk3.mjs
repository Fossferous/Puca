// Portrait walk part 3: content surfaces (manually switching to chat panel each time).
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';

const outdir = process.argv[2] || 'shots3';
const username = process.argv[3];
const password = process.argv[4] || 'Password123!';
fs.mkdirSync(outdir, { recursive: true });

const iphone = devices['iPhone 13'];
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ ...iphone, defaultBrowserType: undefined, baseURL: 'http://localhost:5173' });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

let n = 0;
const shot = async (name) => {
    n++;
    const f = `${outdir}/${String(n).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path: f });
    console.log('SHOT', f);
};
const tryStep = async (name, fn) => {
    try { await fn(); return true; } catch (e) { console.log(`STEP-FAIL ${name}:`, String(e).split('\n')[0]); return false; }
};
const nav = async (i) => { await page.locator('.mobile-nav-btn').nth(i).tap(); await page.waitForTimeout(500); };
const openChannel = async (name) => {
    await nav(1);
    await page.locator('.channel-list .channel-name', { hasText: name }).first().tap({ timeout: 4000 });
    await page.waitForTimeout(800);
    await nav(2); // manually switch to chat panel (missing auto-switch = bug)
};

await page.goto('/');
await page.waitForURL('**/login');
await page.fill('#username', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');
await page.waitForURL('**/chat', { timeout: 30000 });
await page.waitForTimeout(1500);
await tryStep('welcome', () => page.click('.welcome-popup-close', { timeout: 3000 }));

// ---- Checklist channel content
await tryStep('groceries', () => openChannel('groceries'));
await shot('checklist-channel');
await tryStep('add-tasks', async () => {
    const ta = page.locator('.message-textarea');
    await ta.tap({ timeout: 4000 });
    await ta.fill('Buy milk');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await ta.fill('Buy bread and eggs and a really long list of other things that will definitely wrap on a narrow phone screen to test wrapping');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
});
await shot('checklist-with-tasks');

// ---- All Checklists board
await tryStep('all-checklists', () => openChannel('All Checklists'));
await shot('all-checklists-board');

// ---- Text channel: messages, emoji, reactions, search
await tryStep('default-text', () => openChannel('default'));
await shot('text-channel-empty');
await tryStep('send', async () => {
    const ta = page.locator('.message-textarea');
    await ta.tap({ timeout: 4000 });
    await shot('keyboard-focused');
    await ta.fill('Hello from portrait emulation! This is a much longer message intended to check wrapping, padding, and how message rows behave on a 390px viewport with the fixed bottom navigation in place.');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await ta.fill('short one');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
});
await shot('messages');
await tryStep('emoji', async () => {
    await page.locator('.emoji-toggle').tap({ timeout: 3000 });
    await page.waitForTimeout(700);
    await shot('emoji-picker');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
});
await tryStep('msg-actions', async () => {
    await page.locator('.message-content').last().tap({ timeout: 3000 });
    await page.waitForTimeout(500);
    await shot('message-tapped');
});
await tryStep('search', async () => {
    await page.locator('.chat-main input[placeholder*="Search" i], .chat-main [class*="search"] input').first().tap({ timeout: 3000 });
    await page.locator('.chat-main input[placeholder*="Search" i], .chat-main [class*="search"] input').first().fill('hello');
    await page.waitForTimeout(700);
    await shot('search-open');
    await page.keyboard.press('Escape');
});

// ---- Unified hover toolbar (new surface): reveal the up-to-7-button row and
// confirm it stays within the message bounds (no wrap covering the message).
await tryStep('msg-toolbar', async () => {
    const msg = page.locator('.message').last();
    await msg.tap({ timeout: 3000 });   // sticky-hover reveals .message-actions on touch
    await msg.hover().catch(() => {});
    await page.waitForTimeout(400);
    await shot('message-toolbar');
});
// ---- Forward modal (new surface): open the destination picker from the toolbar.
await tryStep('forward-modal', async () => {
    await page.locator('.message-actions .msg-action-btn[title="Forward"]').last().tap({ timeout: 3000 });
    await page.waitForTimeout(600);
    await shot('forward-modal');
    await page.locator('.forward-modal-close').tap({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(300);
});
// ---- Task attachment affordance (new surface): the per-row attach button + strip.
await tryStep('task-attach', async () => {
    await openChannel('groceries');
    await page.locator('.tt-item').first().hover().catch(() => {});
    await page.waitForTimeout(400);
    await shot('task-attach-row');
});

// ---- Tasks & notes dashboard (server-rail Notes button → Tasks view).
// Default view is the pinned "All tasks" board; then open one tab from it.
await tryStep('tasks-dashboard', async () => {
    await nav(0); // Servers panel — the rail hosts the Tasks button
    await page.locator('.server-icon.notes-self').tap({ timeout: 4000 });
    await page.waitForTimeout(1000);
    await shot('tasks-all-board');
    await page.locator('.tasks-tab[data-drag-key]').first().tap({ timeout: 3000 });
    await page.waitForTimeout(1200);
    await shot('tasks-first-tab');
});

// ---- Voice: join voice channel "default" (voice list), see voice panel
await tryStep('voice', async () => {
    await nav(1);
    await page.locator('.voice-channel-list .channel-name', { hasText: 'default' }).first().tap({ timeout: 4000 });
    await page.waitForTimeout(3000);
    await shot('voice-joined-sidebar');
    await nav(2);
    await shot('voice-joined-chat');
});

// ---- Server settings modal (gear in sidebar header)
await tryStep('server-settings', async () => {
    await nav(1);
    await page.locator('.sidebar .server-header button, .sidebar [class*="server"] button, .sidebar-header ~ * button').first().tap({ timeout: 3000 });
    await page.waitForTimeout(700);
    await shot('server-settings');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
});

// ---- Member popup
await tryStep('member-popup', async () => {
    // By label — Tasks sits at the far right now, so nav(4) is no longer Members.
    await page.locator('.mobile-nav-btn', { hasText: 'Members' }).tap();
    await page.waitForTimeout(500);
    await page.locator('.member-sidebar [class*="member"]').first().tap({ timeout: 3000 });
    await page.waitForTimeout(600);
    await shot('member-popup');
});

console.log('DONE');
await browser.close();
