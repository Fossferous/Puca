// Focused verification for the 2026-07-24 minor-fixes batch:
//  1. clicking the CONNECTED voice channel opens the VoiceStage (no disconnect)
//  2. consecutive same-author messages sit tight (grouped)
//  3. avatar upload goes through the zoom/pan cropper
//  4. member-sidebar online dot pokes OUTSIDE the avatar circle
//  5. checklist subtasks can hold sub-subtasks (depth 3 via real API)
//  6. task tabs have a right-click menu with Rename/Delete
//  7. mobile bottom nav puts Tasks at the far right
// Run: node e2e/minor-fixes-verify.mjs <outdir>   (backend + vite must be up)
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';

const outdir = process.argv[2] || 'minor-fixes-shots';
fs.mkdirSync(outdir, { recursive: true });
const username = 'mf_' + Math.random().toString(36).slice(2, 8);

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
};

const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    baseURL: 'http://localhost:5173',
});
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('dialog', d => d.accept());

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

// --- Register + first-run dialogs ---
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

// --- Create a server (wizard) ---
await page.click('.server-icon.add-server');
await page.locator('.template-card').first().click({ timeout: 5000 });
await page.locator('.audience-card').first().click({ timeout: 5000 });
await page.locator('.server-name-input input').fill('Minor Fixes');
await page.click('.wizard-actions .create-btn');
await page.waitForTimeout(2500);
await shot('server-created');

// --- 2. Message grouping: three quick messages from the same author ---
const input = page.locator('.message-form input[placeholder^="Message"], .message-form textarea[placeholder^="Message"]').first();
for (const text of ['first message', 'second message', 'third message']) {
    await input.fill(text);
    await input.press('Enter');
    await page.waitForTimeout(350);
}
await page.waitForTimeout(600);
const groupedCount = await page.locator('.message.grouped').count();
check('grouped messages render compact', groupedCount >= 2, `${groupedCount} grouped rows`);
const gap = await page.evaluate(() => {
    const msgs = [...document.querySelectorAll('.message')];
    const g = msgs.find(m => m.classList.contains('grouped'));
    if (!g || !g.previousElementSibling) return null;
    const prev = g.previousElementSibling.querySelector('.message-content')?.getBoundingClientRect();
    const cur = g.querySelector('.message-content')?.getBoundingClientRect();
    return prev && cur ? Math.round(cur.top - prev.bottom) : null;
});
check('grouped gap is tight (<6px)', gap !== null && gap < 6, `gap=${gap}px`);
await shot('message-grouping');

// --- 4. Member sidebar online dot pokes outside the avatar circle ---
const dot = await page.evaluate(() => {
    const avatar = document.querySelector('.member-item .member-avatar');
    const d = avatar?.querySelector('.status-dot');
    if (!avatar || !d) return null;
    const a = avatar.getBoundingClientRect();
    const r = d.getBoundingClientRect();
    return { outsideRight: r.right > a.right, outsideBottom: r.bottom > a.bottom, w: r.width };
});
check('online dot extends outside the circle', !!dot && dot.outsideRight && dot.outsideBottom, JSON.stringify(dot));
check('online dot is bigger (>=13px)', !!dot && dot.w >= 13, `w=${dot?.w}`);
await shot('member-online-dot');

// --- 1. Voice: join, then click the SAME channel → VoiceStage, still connected ---
const voiceChannel = page.locator('.voice-channel-list .channel.voice-channel').first();
await voiceChannel.click();
await page.waitForTimeout(3000); // join + WS presence
const inVoiceBefore = await page.locator('.voice-users-list .voice-user-item').count();
check('joined voice (self listed in sidebar)', inVoiceBefore >= 1, `${inVoiceBefore} users`);

await voiceChannel.click(); // used to DISCONNECT — must now open the stage
await page.waitForTimeout(800);
const stageVisible = await page.locator('.voice-stage').isVisible().catch(() => false);
check('clicking connected channel opens VoiceStage', stageVisible);
const tiles = await page.locator('.voice-stage-tile').count();
check('stage shows participant tile(s)', tiles >= 1, `${tiles} tiles`);
const stillConnected = await page.locator('.voice-users-list .voice-user-item').count();
check('still connected after re-click (no disconnect)', stillConnected >= 1, `${stillConnected} users`);
await shot('voice-stage');

await page.click('.voice-stage .voice-stage-btn:has-text("Back to Chat")');
await page.waitForTimeout(500);
const stageGone = await page.locator('.voice-stage').count();
const connectedAfterBack = await page.locator('.voice-users-list .voice-user-item').count();
check('Back to Chat closes stage but stays in voice', stageGone === 0 && connectedAfterBack >= 1);
await shot('voice-back-to-chat');

// --- 3. Avatar cropper ---
await page.click('.user-profile-info');
await page.waitForTimeout(500);
// Any real PNG works as the "photo" — reuse a screenshot of the page itself.
const pngBuffer = await page.screenshot();
await page.setInputFiles('.profile-settings-modal input[type="file"]', {
    name: 'photo.png', mimeType: 'image/png', buffer: pngBuffer,
});
await page.waitForTimeout(600);
const cropperUp = await page.locator('.avatar-crop-viewport').isVisible().catch(() => false);
check('picking an image opens the zoom/pan cropper', cropperUp);
await shot('avatar-cropper-open');
// Zoom in via the slider, drag the image, then save.
await page.locator('.avatar-crop-zoom').evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '2');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(300);
const vp = await page.locator('.avatar-crop-viewport').boundingBox();
await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
await page.mouse.down();
await page.mouse.move(vp.x + vp.width / 2 + 40, vp.y + vp.height / 2 + 25, { steps: 5 });
await page.mouse.up();
await shot('avatar-cropper-zoomed');
await page.click('.avatar-crop-actions .avatar-upload-btn');
await page.waitForTimeout(1500);
const avatarSaved = await page.locator('.profile-success').isVisible().catch(() => false);
check('cropped avatar uploads (success banner)', avatarSaved);
await shot('avatar-saved');
await page.click('.profile-close-btn');
await page.waitForTimeout(400);

// --- 5. Checklist: sub-subtask nesting through the real API ---
await page.click('.checklist-toggle-btn');
await page.waitForTimeout(800);
const drawerInput = page.locator('.checklist-panel .checklist-add input');
await drawerInput.fill('top level task');
await page.locator('.checklist-panel .checklist-add button').click();
await page.waitForTimeout(600);
// depth 2
await page.locator('.checklist-panel .tt-item', { hasText: 'top level task' }).hover();
await page.locator('.checklist-panel .tt-item', { hasText: 'top level task' }).locator('.tt-btn[title="Add subtask"]').click();
await page.locator('.checklist-panel .tt-subtask-add input').fill('child task');
await page.locator('.checklist-panel .tt-subtask-add input').press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Escape');
// depth 3 — the button on a SUBTASK is the new capability
const childRow = page.locator('.checklist-panel .tt-item.subtask', { hasText: 'child task' });
await childRow.hover();
const childAddBtn = childRow.locator('.tt-btn[title="Add subtask"]');
const childCanNest = await childAddBtn.count();
check('subtask row offers "add subtask"', childCanNest === 1);
await childAddBtn.click();
await page.locator('.checklist-panel .tt-subtask-add input').fill('grandchild task');
await page.locator('.checklist-panel .tt-subtask-add input').press('Enter');
await page.waitForTimeout(800);
await page.keyboard.press('Escape');
const deepRendered = await page.locator('.checklist-panel .tt-nest .tt-nest .tt-item', { hasText: 'grandchild task' }).count();
check('sub-subtask persists and renders nested (depth 3)', deepRendered === 1);
await shot('checklist-deep-nesting');
await page.click('.checklist-toggle-btn'); // close drawer
await page.waitForTimeout(400);

// --- 6. Task tabs: right-click menu ---
await page.click('.server-icon.home-button');
await page.waitForTimeout(800);
await page.locator('.sidebar-nav .nav-item', { hasText: 'Tasks' }).click();
await page.waitForTimeout(1000);
await page.locator('.tasks-tabbar-actions .tasks-tab-icon').first().click(); // ＋ new list
await page.locator('.tasks-tab-newform input').fill('Groceries');
await page.locator('.tasks-tab-newform input').press('Enter');
await page.waitForTimeout(800);
const tab = page.locator('.tasks-tab', { hasText: 'Groceries' });
await tab.click({ button: 'right' });
await page.waitForTimeout(400);
const menuUp = await page.locator('.context-menu').isVisible().catch(() => false);
const hasDelete = await page.locator('.context-menu-item', { hasText: 'Delete List' }).count();
const hasRename = await page.locator('.context-menu-item', { hasText: 'Rename List' }).count();
check('task tab right-click opens menu', menuUp);
check('menu offers Rename + Delete', hasDelete === 1 && hasRename === 1);
await shot('task-tab-context-menu');
await page.locator('.context-menu-item', { hasText: 'Delete List' }).click(); // confirm auto-accepted
await page.waitForTimeout(800);
const tabGone = await page.locator('.tasks-tab', { hasText: 'Groceries' }).count();
check('Delete List removes the tab', tabGone === 0);
await shot('task-tab-deleted');

await ctx.close();

// --- 7. Mobile: Tasks nav pinned far right ---
const iphone = devices['iPhone 13'];
const mctx = await browser.newContext({ ...iphone, defaultBrowserType: undefined, baseURL: 'http://localhost:5173' });
const mpage = await mctx.newPage();
await mpage.goto('/');
await mpage.waitForURL('**/login');
await mpage.fill('#username', username);
await mpage.fill('#password', 'Password123!');
await mpage.click('button[type="submit"]');
await mpage.waitForURL('**/chat', { timeout: 30000 });
await mpage.waitForTimeout(1500);
const navLabels = await mpage.locator('.mobile-bottom-nav .nav-label').allTextContents();
check('mobile nav ends with Tasks (far right)', navLabels[navLabels.length - 1] === 'Tasks', navLabels.join(' | '));
n++;
await mpage.screenshot({ path: `${outdir}/${String(n).padStart(2, '0')}-mobile-nav-tasks-right.png` });
console.log('SHOT', `${outdir}/${String(n).padStart(2, '0')}-mobile-nav-tasks-right.png`);
await mctx.close();

await browser.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
