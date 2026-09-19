// Portrait walk part 2: server creation + channels + checklists + DMs + voice.
// Usage: node e2e/mobile-walk2.mjs <outdir> <username> <password>
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';

const outdir = process.argv[2] || 'shots2';
const username = process.argv[3];
const password = process.argv[4] || 'Password123!';
fs.mkdirSync(outdir, { recursive: true });

const iphone = devices['iPhone 13'];
const browser = await chromium.launch({
    // --mute-audio: the fake media device must never reach the speakers.
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio'],
});
// APP=<origin> points it at a throwaway static server; default is the dev server.
const ctx = await browser.newContext({ ...iphone, defaultBrowserType: undefined, baseURL: process.env.APP || 'http://localhost:5173' });
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
// A step whose failure FAILS the run (exit 1). tryStep alone logs and moves
// on, which is right for a layout probe and wrong for an assertion.
const mustFails = [];
const mustStep = async (name, fn) => {
    const ok = await tryStep(name, fn);
    if (!ok) mustFails.push(name);
    return ok;
};

// ---- Login
await page.goto('/');
await page.waitForURL('**/login');
await page.fill('#username', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');
await page.waitForURL('**/chat', { timeout: 30000 });
await page.waitForTimeout(1500);
await tryStep('welcome', () => page.click('.welcome-popup-close', { timeout: 3000 }));
await page.waitForTimeout(400);

// ---- Create server via wizard
await tryStep('nav-servers', () => page.locator('.mobile-nav-btn').nth(0).tap());
await page.waitForTimeout(400);
await tryStep('open-wizard', () => page.locator('.server-icon.add-server').tap({ timeout: 4000 }));
await page.waitForTimeout(600);
await shot('wizard-template');
await tryStep('pick-template', () => page.locator('.template-card').first().tap({ timeout: 4000 }));
await page.waitForTimeout(500);
await shot('wizard-audience');
await tryStep('pick-audience', () => page.locator('.audience-card').first().tap({ timeout: 4000 }));
await page.waitForTimeout(500);
await shot('wizard-customize');
await tryStep('create-server', async () => {
    await page.locator('.server-name-input input').fill('Mobile Test');
    await page.locator('.wizard-actions .create-btn').tap();
    await page.waitForTimeout(2500);
});
await shot('after-create');

// ---- Channels panel
await tryStep('nav-channels', () => page.locator('.mobile-nav-btn').nth(1).tap());
await page.waitForTimeout(500);
await shot('channels-panel');

// ---- Create a checklist channel
await tryStep('add-channel', async () => {
    await page.locator('.add-channel-btn').first().tap({ timeout: 4000 });
    await page.waitForTimeout(500);
    await shot('create-channel-modal');
    await page.locator('.channel-type-selector .type-btn', { hasText: 'Checklist' }).tap();
    await page.waitForTimeout(300);
    const nameField = page.locator('.modal input[type="text"]').first();
    await nameField.fill('groceries');
    await shot('create-channel-filled');
    await page.locator('.modal button[type="submit"], .modal .create-btn').last().tap();
    await page.waitForTimeout(1200);
});
await shot('after-channel-create');

// ---- Open the checklist channel
await tryStep('open-checklist', async () => {
    await page.locator('.mobile-nav-btn').nth(1).tap();
    await page.waitForTimeout(400);
    await page.locator('.channel-list .channel-name', { hasText: 'groceries' }).first().tap({ timeout: 4000 });
    await page.waitForTimeout(1000);
});
await shot('checklist-channel');
await tryStep('add-task', async () => {
    // A checklist CHANNEL renders ChecklistBody, whose composer is
    // `.checklist-add input` ("Add an item…") — not the message composer and
    // not TasksView's `.tasks-add`. This step silently no-opped against
    // `.message-textarea`, which exists only in text channels.
    const ta = page.locator('.checklist-add input');
    await ta.tap({ timeout: 3000 });
    await ta.fill('Buy milk');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await ta.fill('Buy bread and eggs and a really long list of other things that will definitely wrap on a narrow phone screen');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
});
await shot('checklist-with-tasks');

// ---- All Checklists board
await tryStep('all-checklists', async () => {
    await page.locator('.mobile-nav-btn').nth(1).tap();
    await page.waitForTimeout(400);
    await page.locator('.channel-list .channel-name', { hasText: 'All Checklists' }).first().tap({ timeout: 4000 });
    await page.waitForTimeout(1000);
});
await shot('all-checklists-board');

// ---- Open the default text channel, long message + emoji picker.
// Named 'default' (not 'general') since a698fd3 gave new servers a
// text+voice+AFK bootstrap; the old name matched nothing, so this step and
// every step below it that needs an open text channel silently no-opped.
await tryStep('open-text-channel', async () => {
    await page.locator('.mobile-nav-btn').nth(1).tap();
    await page.waitForTimeout(400);
    await page.locator('.channel-list .channel-item:not(.voice) .channel-name, .channel-list .channel-name')
        .filter({ hasText: /^default$/ }).first().tap({ timeout: 4000 });
    await page.waitForTimeout(800);
});
await shot('text-channel');
await tryStep('send-long', async () => {
    const ta = page.locator('.message-textarea');
    await ta.tap({ timeout: 3000 });
    await ta.fill('Hello from portrait emulation! This is a much longer message intended to check wrapping, padding, and how message rows behave on a 390px wide viewport with the fixed bottom navigation in place.');
    await shot('composing');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    await ta.fill('short one');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
});
await shot('after-send');
await tryStep('emoji', async () => {
    await page.locator('.emoji-toggle').tap({ timeout: 3000 });
    await page.waitForTimeout(600);
    await shot('emoji-picker');
    // Dismiss the way a phone user must — there is no Escape key on a touch
    // device, so tap the backdrop OUTSIDE the picker. Use a coordinate tap:
    // .emoji-backdrop spans the viewport, so locator.tap() aims at its centre,
    // which the picker itself covers, and waits forever for a hit. Leaving the
    // picker open used to cover the message list and time out every step below.
    await page.touchscreen.tap(20, 20);
    await page.waitForTimeout(400);
});

// ---- Message hover actions (reactions etc.) via long-press-ish tap.
// Target the FIRST message: the last one sits under the action bar that a
// previous tap opens (and above it, the composer), so tapping it is not
// stable — the step timed out on an overlap, not on missing actions.
await tryStep('msg-tap', async () => {
    await page.locator('.message-content').first().tap({ timeout: 3000 });
    await page.waitForTimeout(500);
});
await shot('message-tapped');

// ---- Tasks & notes dashboard (server-rail Notes button → Friends panel Tasks view)
await tryStep('tasks-dashboard', async () => {
    await page.locator('.mobile-nav-btn').nth(0).tap(); // Servers panel (the rail)
    await page.waitForTimeout(400);
    await page.locator('.server-icon.notes-self').tap({ timeout: 4000 });
    await page.waitForTimeout(1000);
});
await shot('tasks-dashboard');
// Create a personal list and add an item to it.
await tryStep('tasks-new-list', async () => {
    await page.locator('.tasks-tabbar-actions .tasks-tab-icon[title="New list"]').tap();
    await page.locator('.tasks-tab-newform input').fill('Groceries');
    await page.locator('.tasks-tab-newform input').press('Enter');
    await page.waitForTimeout(800);
    await page.locator('.tasks-add input').fill('oat milk');
    await page.locator('.tasks-add button[type="submit"]').tap();
    await page.waitForTimeout(600);
});
await shot('tasks-personal-list');
// All-tasks board: the pinned first tab shows every list + server checklist
// as live cards (replaced the separate Server-checklists board in 0.8.61).
await tryStep('tasks-all-board', async () => {
    await page.locator('.tasks-tab-all').tap({ timeout: 3000 });
    await page.waitForTimeout(1200);
});
await shot('tasks-all-board');
// The pinned Calendar tab (the same component as Notes' /calendar) on the
// phone gate: no Week button, dots in the month, nothing wider than the screen.
await mustStep('tasks-calendar-tab', async () => {
    await page.locator('.tasks-tab-calendar').tap({ timeout: 3000 });
    await page.locator('.tasks-calendar .cal-month').waitFor({ timeout: 5000 });
    const r = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        week: (() => { const b = document.querySelector('.tasks-calendar .cal-viewbtn.view-week'); return !!b && getComputedStyle(b).display !== 'none'; })(),
        // The pinned tab is a whole tap target, not squeezed to "C…".
        tabW: Math.round(document.querySelector('.tasks-tab-calendar')?.getBoundingClientRect().width ?? 0),
    }));
    console.log('tasks calendar (phone): no overflow, no Week button, tab >= 44px (should be true):', !r.overflow && !r.week && r.tabW >= 44, r.tabW);
    if (r.overflow || r.week || r.tabW < 44) throw new Error(`phone calendar gate: ${JSON.stringify(r)}`);
    // Day on a phone is the day's list alone: no time grid under it.
    await page.locator('.tasks-calendar .cal-viewbtn.view-day').tap({ timeout: 3000 });
    await page.locator('.tasks-calendar .cal.view-day').waitFor({ timeout: 5000 });
    const d = await page.evaluate(() => ({
        list: !!document.querySelector('.tasks-calendar .cal-daylist'),
        grid: document.querySelectorAll('.tasks-calendar .cal-timegrid').length,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }));
    console.log('tasks calendar (phone Day): the list, no time grid, no overflow (should be true):', d.list && d.grid === 0 && !d.overflow, JSON.stringify(d));
    if (!d.list || d.grid !== 0 || d.overflow) throw new Error(`phone Day: ${JSON.stringify(d)}`);
});
await shot('tasks-calendar-phone');
// A server checklist opened as its own tab (channel tabs carry the kind glyph).
await tryStep('tasks-channel-tab', async () => {
    await page.locator('.tasks-tab.tasks-tab-channel').first().tap({ timeout: 3000 });
    await page.waitForTimeout(800);
});
await shot('tasks-channel-tab');

// ---- Create + join a voice channel
await tryStep('voice-create', async () => {
    await page.locator('.mobile-nav-btn').nth(1).tap();
    await page.waitForTimeout(400);
    await page.locator('.add-channel-btn').nth(1).tap({ timeout: 3000 });
    await page.waitForTimeout(500);
    await page.locator('.channel-type-selector .type-btn', { hasText: 'Voice' }).tap();
    const nameField = page.locator('.modal input[type="text"]').first();
    await nameField.fill('hangout');
    await page.locator('.modal button[type="submit"], .modal .create-btn').last().tap();
    await page.waitForTimeout(1200);
});
await tryStep('voice-join', async () => {
    // Bootstrap voice channel is 'default' (a698fd3), not 'hangout'. Take the
    // LAST 'default' match: the text channel of the same name sorts first.
    await page.locator('.voice-channel-list .channel-name, .channel-list .channel-name')
        .filter({ hasText: /^default$/ }).last().tap({ timeout: 4000 });
    await page.waitForTimeout(2500);
});
await shot('voice-joined-channels-panel');
await tryStep('voice-chatview', async () => {
    await page.locator('.mobile-nav-btn').nth(2).tap();
    await page.waitForTimeout(600);
});
await shot('voice-joined-chat');

// ---- Members panel with a real server
await tryStep('members', async () => {
    // By label — Tasks sits at the far right now, so nth(4) is no longer Members.
    await page.locator('.mobile-nav-btn', { hasText: 'Members' }).tap();
    await page.waitForTimeout(600);
});
await shot('members-panel');

// ---- Friends panel explicitly (rail button)
await tryStep('friends', async () => {
    await page.locator('.mobile-nav-btn').nth(0).tap();
    await page.waitForTimeout(400);
    await page.locator('.server-icon').first().tap({ timeout: 3000 });
    await page.waitForTimeout(800);
});
await shot('friends-panel');

console.log('DONE');
await browser.close();
if (mustFails.length) {
    console.log(`FAILED: ${mustFails.length} required step(s): ${mustFails.join(', ')}`);
    process.exit(1);
}
