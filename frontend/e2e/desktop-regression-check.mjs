// Desktop non-regression: fine pointer, 1280x800, no touch — confirms the
// coarse-pointer mobile CSS never applies and desktop layout is unchanged.
import { chromium } from '@playwright/test';

const username = 'desk_' + Math.random().toString(36).slice(2, 8);
const outdir = process.argv[2] || 'desktop-shots';

// APP=<origin> points it at a throwaway static server; default is the dev server.
const BASE = process.env.APP || process.env.WALK_BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ args: ['--mute-audio'] });   // a walk never makes a sound
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
// A step whose failure FAILS the run (exit 1). tryStep alone logs and moves
// on, which is right for a layout probe and wrong for an assertion.
const mustFails = [];
const mustStep = async (name, fn) => {
    const ok = await tryStep(name, fn);
    if (!ok) mustFails.push(name);
    return ok;
};

await page.goto(`${BASE}/`);
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

// Púca's Tasks view with schedules: the date & repeat editor on a TaskTree
// row, the row then showing its date chip INSTEAD of the raw due editor, and
// the pinned Calendar tab with its desktop Week grid.
await mustStep('tasks-schedule', async () => {
    await page.keyboard.press('Escape');   // the emoji picker from the step above
    await page.waitForTimeout(300);
    await page.locator('.server-icon.notes-self').click({ timeout: 4000 });
    await page.waitForTimeout(800);
    await page.locator('.tasks-tabbar-actions .tasks-tab-icon[title="New list"]').click({ timeout: 4000 });
    await page.locator('.tasks-tab-newform input').fill('Bills');
    await page.locator('.tasks-tab-newform input').press('Enter');
    await page.waitForTimeout(800);
    await page.locator('.tasks-add input').fill('Pay rent');
    await page.locator('.tasks-add button[type="submit"]').click();
    const row = page.locator('.tt-item', { hasText: 'Pay rent' }).first();
    await row.waitFor({ timeout: 5000 });
    await row.hover();
    // Positive control: a PLAIN row offers the raw due editor, so "hidden"
    // below means the schedule hid it, not that the selector never matched.
    const rawBefore = await row.locator('.tt-btn[title="Add due time"]').count();
    if (rawBefore !== 1) throw new Error(`plain row: expected the raw due editor, found ${rawBefore}`);
    await row.locator('.tt-btn[title="Add date & repeat"]').click({ timeout: 4000 });
    await page.selectOption('select[aria-label="Repeat"]', 'monthly-day');
    await page.click('.sched-dialog .sched-btn.primary');
    await row.locator('.tt-sched').waitFor({ timeout: 5000 });
    await row.hover();
    const rawDue = await row.locator('.tt-btn[title="Add due time"], .tt-btn[title="Edit due time"]').count();
    const ok = await row.locator('.tt-sched').count() === 1 && rawDue === 0;
    console.log('scheduled row: date chip shown, raw due editor hidden (should be true):', ok);
    if (!ok) throw new Error(`scheduled row: chip/raw-due wrong (rawDue=${rawDue})`);
});
await shot('tasks-scheduled-row');
await mustStep('tasks-calendar-tab', async () => {
    await page.locator('.tasks-tab-calendar').click({ timeout: 4000 });
    await page.locator('.tasks-calendar .cal-month').waitFor({ timeout: 5000 });
    const weekOffered = await page.locator('.tasks-calendar .cal-viewbtn.view-week').isVisible();
    console.log('tasks calendar: Week offered on desktop (should be true):', weekOffered);
    if (!weekOffered) throw new Error('desktop: no Week button');
    await page.locator('.tasks-calendar .cal-viewbtn.view-week').click();
    await page.waitForTimeout(300);
    const grid = await page.locator('.tasks-calendar .cal-timegrid.cols-7').count() === 1;
    console.log('tasks calendar: 7-column week grid (should be true):', grid);
    if (!grid) throw new Error('desktop: no 7-column week grid');
    // The week grid opens on working hours (or just before now), not 00:00
    // (before 01:00 "an hour before now" IS 00:00, the one honest zero).
    const open = await page.locator('.tasks-calendar .cal-tg-body').evaluate(el => ({ top: el.scrollTop, hour: el.dataset.openHour ?? null }));
    const opened = open.hour !== null && (Number(open.hour) > 0 ? open.top > 0 : new Date().getHours() < 1);
    console.log('tasks calendar: the week grid opens on working hours / now (should be true):', opened, JSON.stringify(open));
    if (!opened) throw new Error(`week grid opened at ${JSON.stringify(open)}`);
});
await shot('tasks-calendar-week');
// The pinned Reminders tab beside it, and the door a clicked due-item
// notification comes through (api/desktopNotify dispatches this very event).
// One check here because the release gate list runs THIS file; notes-walk
// drives the view itself.
await mustStep('tasks-reminders-intent', async () => {
    // Positive control: the Calendar tab is active right now, so the switch
    // below is the event's doing and not a tab that was already selected.
    if (await page.locator('.tasks-tab-reminders.active').count() !== 0) throw new Error('Reminders was already active — the event would prove nothing');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sovereign:open-reminders')));
    await page.locator('.tasks-tab-reminders.active').waitFor({ timeout: 5000 });
    await page.locator('.tasks-reminders .notes-reminders').waitFor({ timeout: 5000 });
    console.log('tasks reminders: the notification event selects the pinned tab and mounts the list (should be true): true');
});
await shot('tasks-reminders');

console.log('DONE user=', username);
await browser.close();
if (mustFails.length) {
    console.log(`FAILED: ${mustFails.length} required step(s): ${mustFails.join(', ')}`);
    process.exit(1);
}
