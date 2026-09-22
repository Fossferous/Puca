// Púca Notes — the CALENDAR section of the live walk (notes-walk.mjs calls
// calendarWalk() at the end; it also runs on its own, below).
//
// Every context here pins what a calendar depends on, so an assertion about a
// date or a week can never flake with the host's zone, language or the hour
// the walk happens to run at:
//   - timezoneId: Europe/Dublin (en-GB) and America/New_York (en-US), both DST
//     zones;
//   - locale: en-GB (weeks start Monday) and en-US (weeks start Sunday);
//   - a fixed clock the day before each zone's 2026 spring-forward. The clock
//     is in the PAST on purpose: the session's JWT was minted by the real
//     server clock, and a fake time later than its expiry would sign the page
//     out (auth.ts isTokenExpired).
//
// What it proves, end to end through the real backend: tap-to-add creates the
// item and its timing; a daily repeat keeps 09:00 on both sides of a DST
// change (in the grid AND in the server's due_at, which is the next reminder
// instant); a nonexistent local time takes the pre-gap offset (RFC 5545); the
// sealed schedule and snooze reach the database as envelopes with no
// plaintext in them; snooze from Reminders; keyboard move; ticking a repeating
// to-do moves it on instead of ending it; Edited + the Recently-edited sort;
// .ics export (RFC shape, deterministic UIDs) and import (preview, dedupe by
// UID); and on the phone gate: dots, no week grid (not even via the URL), tap
// targets, no overflow.
//
// Standalone: node e2e/notes-walk-calendar.mjs [outdir] [baseURL] [psql-dsn]
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Fill the open tap-to-add sheet. Opened without a time it defaults to all
 *  day, so a timed item unticks that first. */
async function fillAddSheet(page, { title, time, kind, target }) {
    await page.waitForSelector('form.cal-add', { timeout: 5000 });
    await page.fill('form.cal-add input[aria-label="Title"]', title);
    if (kind === 'task') await page.locator('form.cal-add [role="radio"]', { hasText: 'To-do' }).click();
    if (time) {
        const allDay = page.locator('form.cal-add .sched-check input[type="checkbox"]');
        if (await allDay.count() && await allDay.isChecked()) await allDay.uncheck();
        await page.fill('form.cal-add input[aria-label="Time"]', time);
    }
    if (target) await page.selectOption('form.cal-add select[aria-label="Note"]', target);
    await page.click('form.cal-add button[type="submit"]');
    await page.waitForSelector('form.cal-add', { state: 'detached', timeout: 10000 });
}
// Saturday 10:00 in each zone, the day before the clocks go forward.
const DUBLIN_NOW = '2026-03-28T10:00:00Z';     // GMT; IST (UTC+1) from 01:00Z on the 29th
const NEW_YORK_NOW = '2026-03-07T15:00:00Z';   // EST; EDT (UTC-4) from 07:00Z on the 8th

const ICS_IN = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//walk//test//EN', 'X-WR-CALNAME:Trip',
    'BEGIN:VEVENT', 'UID:flight-1@walk.test', 'DTSTAMP:20260301T000000Z',
    'DTSTART;TZID=Europe/Dublin:20260401T140000', 'DTEND;TZID=Europe/Dublin:20260401T150000',
    'SUMMARY:Flight out', 'LOCATION:Terminal 2', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:holiday-1@walk.test', 'DTSTAMP:20260301T000000Z',
    'DTSTART;VALUE=DATE:20260402', 'DTEND;VALUE=DATE:20260403', 'SUMMARY:Bank holiday', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:hourly-1@walk.test', 'DTSTAMP:20260301T000000Z',
    'DTSTART:20260403T090000Z', 'RRULE:FREQ=HOURLY;COUNT=3', 'SUMMARY:Hourly thing', 'END:VEVENT',
    'END:VCALENDAR', '',
].join('\r\n');

/**
 * @param {object} o
 * @param {import('@playwright/test').Browser} o.browser
 * @param {string} o.baseURL
 * @param {object} o.state  storageState of a signed-in context
 * @param {string} o.username
 * @param {(n: string, ok: boolean, detail?: unknown) => void} o.ck
 * @param {(page: import('@playwright/test').Page) => void} o.watch
 * @param {(page: import('@playwright/test').Page) => (name: string) => Promise<void>} o.shotOf
 * @param {((statement: string) => string) | null} o.sql
 * @param {string[]} o.errors
 * @param {number} [o.notesCreatedAt]  when "Groceries" was created (real ms):
 *   "Edited" is hidden for an edit within a minute of creation, so the check
 *   waits out that minute rather than depend on how fast the walk ran
 */
export async function calendarWalk({ browser, baseURL, state, username, ck, watch, shotOf, sql, errors, notesCreatedAt = 0 }) {
    const mine = `SELECT l.id FROM task_lists l JOIN users u ON u.id = l.owner_id WHERE u.username = '${username}'`;
    const dialogs = [];
    // A database proof without a DSN must SAY it did not run — never vanish
    // and leave "ALL PASS" standing for checks that never happened.
    let skipped = 0;
    const db = (name, fn) => {
        if (sql) { fn(); return; }
        skipped++;
        console.log(`SKIP  ${name}  — no psql DSN given (pass one to run the database proofs)`);
    };

    // =========================================================================
    // Desktop, Europe/Dublin, en-GB
    // =========================================================================
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL, storageState: state, timezoneId: 'Europe/Dublin', locale: 'en-GB', acceptDownloads: true });
    const c = await ctx.newPage();
    watch(c);
    c.on('dialog', d => { dialogs.push(d.message()); void d.accept(); });
    const shot = shotOf(c);
    await c.clock.install({ time: new Date(DUBLIN_NOW) });
    await c.goto('/notes/');
    await c.waitForSelector('.notes-card', { timeout: 20000 });
    await c.locator('.notes-rail-item', { hasText: 'Calendar' }).click();
    await c.waitForSelector('.cal-month', { timeout: 10000 });
    ck('calendar: the rail opens /calendar', /#\/calendar/.test(c.url()), c.url());
    ck('calendar en-GB: month title', (await c.locator('.cal-title').innerText()).trim() === 'March 2026', await c.locator('.cal-title').innerText());
    ck('calendar en-GB: the week starts on Monday', (await c.locator('.cal-dow').first().innerText()).trim() === 'Mon', await c.locator('.cal-dow').first().innerText());
    ck('calendar: today (fixed clock) is the 28th', (await c.locator('.cal-cell.today .cal-daynum').innerText()).trim() === '28');
    ck('calendar desktop: the Week view is offered', await c.locator('.cal-viewbtn.view-week').isVisible());

    // ---- tap-to-add, into a new note (the selected day's Add; the FAB is the phone's) --
    await c.locator('.cal-daylist-head button', { hasText: 'Add' }).click();
    await fillAddSheet(c, { title: 'Standup', time: '09:00', target: 'new' });
    const cell = day => c.locator(`.cal-cell[data-drop-target="${day}"]`);
    await cell('2026-03-28').locator('.cal-chip', { hasText: 'Standup' }).waitFor({ timeout: 10000 }).catch(() => {});
    ck('tap-to-add: the event is on the 28th (and only there)',
        await cell('2026-03-28').locator('.cal-chip', { hasText: 'Standup' }).count() === 1
        && await c.locator('.cal-chip', { hasText: 'Standup' }).count() === 1,
        await c.locator('.cal-chip', { hasText: 'Standup' }).count());

    // ---- make it repeat daily ---------------------------------------------------------
    await cell('2026-03-28').locator('.cal-chip', { hasText: 'Standup' }).click();
    await c.waitForSelector('.cal-menu', { timeout: 5000 });
    await c.locator('.cal-menu-item', { hasText: 'Date & repeat' }).click();
    await c.waitForSelector('.sched-dialog[aria-label="Date and repeat"]', { timeout: 5000 });
    await c.selectOption('select[aria-label="Repeat"]', 'daily');
    await c.click('.sched-dialog .sched-btn.primary');
    await c.waitForSelector('.sched-dialog', { state: 'detached', timeout: 5000 });
    await cell('2026-03-29').locator('.cal-chip', { hasText: 'Standup' }).waitFor({ timeout: 10000 });
    ck('repeat: a daily event shows on the next days too', await cell('2026-03-30').locator('.cal-chip', { hasText: 'Standup' }).count() === 1);

    // ---- DST: 09:00 on both sides of the change, in the week grid ------------------------
    await c.click('.cal-viewbtn.view-week');
    await c.waitForSelector('.cal-timegrid.cols-7', { timeout: 5000 });
    await sleep(200);
    // Fixed clock: 10:00 in Dublin on the 28th, which is in this week, so the
    // grid opens at 09:00 (an hour before now), i.e. 9 rows of 48 px down.
    const opened = await c.locator('.cal-tg-body').evaluate(el => ({ top: el.scrollTop, hour: el.dataset.openHour ?? null, room: el.scrollHeight - el.clientHeight }));
    ck('week grid: opens an hour before now, not at 00:00', opened.hour === '9' && Math.abs(opened.top - 9 * 48) <= 2, JSON.stringify(opened));
    const offsetFromSlot = async (dayKey) => {
        const slot = await c.locator(`[data-drop-target="${dayKey}T09:00"]`).boundingBox();
        const colChips = c.locator('.cal-tg-col').filter({ has: c.locator(`[data-drop-target="${dayKey}T09:00"]`) }).locator('.cal-chip', { hasText: 'Standup' });
        const chipBox = await colChips.first().boundingBox();
        return slot && chipBox ? Math.round(chipBox.y - slot.y) : null;
    };
    const before = await offsetFromSlot('2026-03-28');
    const after = await offsetFromSlot('2026-03-29');
    ck('DST: the daily 09:00 sits in the 09:00 row the day BEFORE the change', before !== null && Math.abs(before) <= 4, before);
    ck('DST: …and still in the 09:00 row the day the clocks go forward', after !== null && Math.abs(after) <= 4, after);
    await shot('cal-week-dst');

    db('database: due_at is the next reminder instant, the schedule sealed and unreadable', () => {
        const row = sql(`SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') || '|' || left(schedule, 12) || '|' || (schedule LIKE '%Standup%' OR schedule LIKE '%FREQ%' OR schedule LIKE '%Dublin%' OR schedule LIKE '%09:00%')::text FROM channel_tasks WHERE list_id IN (${mine}) AND schedule IS NOT NULL`);
        const [due, head, leaks] = row.split('|');
        // Next reminder: the 29th at 09:00 IST (UTC+1) less the 10-minute alert.
        // A fixed-offset bug would say 08:50Z.
        ck('database: due_at is the next reminder instant, DST-correct (07:50Z)', due === '2026-03-29T07:50', row);
        ck('database: the schedule is a sealed envelope', /^\{"v":\d/.test(head ?? ''), head);
        ck('database: nothing of the schedule is readable (title, rule, zone, time)', leaks === 'false', leaks);
    });

    // ---- keyboard move + ticking a repeating to-do --------------------------------------
    await c.click('.cal-viewbtn.view-month');
    await c.waitForSelector('.cal-month', { timeout: 5000 });
    await cell('2026-03-30').locator('.cal-daynum').click();
    await c.locator('.cal-daylist-head button', { hasText: 'Add' }).click();
    await fillAddSheet(c, { title: 'Call plumber', time: '11:00', kind: 'task' });
    const plumberOn = day => cell(day).locator('.cal-chip', { hasText: 'Call plumber' });
    await plumberOn('2026-03-30').waitFor({ timeout: 10000 });
    await plumberOn('2026-03-30').focus();
    await c.keyboard.press(']');
    await plumberOn('2026-03-31').waitFor({ timeout: 10000 }).catch(() => {});
    ck('keyboard: ] moves a focused item a day later', await plumberOn('2026-03-31').count() === 1 && await plumberOn('2026-03-30').count() === 0);
    await plumberOn('2026-03-31').click();
    await c.waitForSelector('.cal-menu', { timeout: 5000 });
    await c.locator('.cal-menu-item', { hasText: 'Date & repeat' }).click();
    await c.waitForSelector('.sched-dialog', { timeout: 5000 });
    await c.selectOption('select[aria-label="Repeat"]', 'weekly');
    await c.click('.sched-dialog .sched-btn.primary');
    await c.waitForSelector('.sched-dialog', { state: 'detached', timeout: 5000 });
    await sleep(800);
    await plumberOn('2026-03-31').click();
    await c.waitForSelector('.cal-menu', { timeout: 5000 });
    await c.locator('.cal-menu-item', { hasText: 'Done — move to the next time' }).click();
    await sleep(1500);
    // The weekly series draws Apr 7 whether or not the tick did anything, so
    // Apr 7 alone proves nothing. The tick must have (a) taken Mar 31 off the
    // calendar (done occurrences hide without "Show completed") AND (b) left
    // the series alive (Apr 7 still there — a tick that COMPLETED the item
    // would hide that too).
    await c.goto('/notes/#/calendar?v=day&d=2026-03-31');
    await c.waitForSelector('.cal.view-day', { timeout: 10000 });
    // "Not there" means something only once the notes have loaded: the daily
    // Standup is on the 31st too, so wait for IT before counting the plumber.
    const loaded31 = await c.locator('.cal-chip', { hasText: 'Standup' }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    const mar31 = loaded31 ? await c.locator('.cal-chip', { hasText: 'Call plumber' }).count() : -1;
    const dayGrid = await c.locator('.cal-tg-body').evaluate(el => el.dataset.openHour ?? null).catch(() => null);
    ck('day grid: a day that is not today opens on the working day (08:00)', dayGrid === '8', dayGrid);
    await c.goto('/notes/#/calendar?v=day&d=2026-04-07');
    await c.waitForSelector('.cal.view-day', { timeout: 10000 });
    await c.locator('.cal-chip', { hasText: 'Call plumber' }).first().waitFor({ timeout: 10000 }).catch(() => {});
    const apr7 = await c.locator('.cal-chip', { hasText: 'Call plumber' }).count();
    ck('repeat tick: the ticked occurrence (Mar 31) is done, and the series goes on (Apr 7)', mar31 === 0 && apr7 === 1, `mar31=${mar31} apr7=${apr7}`);
    db('database: ticking a repeating to-do left it OPEN with the next due', () => {
        const r = sql(`SELECT is_completed::text || '|' || to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') FROM channel_tasks WHERE list_id IN (${mine}) AND schedule IS NOT NULL ORDER BY id DESC LIMIT 1`);
        ck('database: ticking a repeating to-do left it OPEN with the next due (Apr 7 11:00 IST)', r === 'false|2026-04-07T10:00', r);
    });

    // ---- a PLAIN parent of a repeating to-do: ticking it is refused ----------------------
    // The server sweeps a completed item's subtree and cannot see whether a
    // child repeats (the rule is sealed), so it lets this client through; the
    // client itself must refuse (taskCompletion.subtreeCompletionBlock), or the
    // child's series would silently end.
    await c.goto('/notes/');
    await c.waitForSelector('.notes-card', { timeout: 10000 });
    await c.locator('.notes-card', { hasText: 'Phone note' }).first().click();
    await c.waitForSelector('.notes-editor .task-tree', { timeout: 10000 });
    await c.fill('.notes-editor-add input', 'Chores');
    await c.press('.notes-editor-add input', 'Enter');
    const choresRow = c.locator('.notes-editor .tt-item', { hasText: 'Chores' }).first();
    await choresRow.waitFor({ timeout: 10000 });
    await choresRow.hover();
    await choresRow.locator('.tt-btn[title="Add subtask"]').click();
    await c.fill('.notes-editor .tt-subtask-add input', 'Water plants');
    await c.press('.notes-editor .tt-subtask-add input', 'Enter');
    const plantsRow = c.locator('.notes-editor .tt-nest .tt-item', { hasText: 'Water plants' }).first();
    await plantsRow.waitFor({ timeout: 10000 });
    await c.keyboard.press('Escape');
    await sleep(150);
    await plantsRow.hover();
    await plantsRow.locator('button[aria-label="Add date & repeat"]').click();
    await c.waitForSelector('.sched-dialog', { timeout: 5000 });
    await c.selectOption('.sched-dialog select[aria-label="Repeat"]', 'weekly');
    await c.click('.sched-dialog .sched-btn.primary');
    await c.waitForSelector('.sched-dialog', { state: 'detached', timeout: 5000 });
    await plantsRow.locator('.tt-sched').waitFor({ timeout: 10000 }).catch(() => {});
    ck('parent tick: precondition — the subtask now repeats weekly', await plantsRow.locator('.tt-sched').count() === 1);
    await choresRow.locator('input[type="checkbox"]').click();
    const refusal = c.locator('.message-toast-title', { hasText: 'repeats' });
    await refusal.first().waitFor({ timeout: 8000 }).catch(() => {});
    await sleep(1000);
    ck('parent tick: ticking a plain parent of a repeating to-do is REFUSED, with the reason', await refusal.count() >= 1,
        (await c.locator('.message-toast-title').allInnerTexts()).join(' / ') || 'no toast');
    ck('parent tick: …and nothing was ticked (parent and child still open)',
        !(await choresRow.locator('input[type="checkbox"]').isChecked()) && !(await plantsRow.locator('input[type="checkbox"]').isChecked())
        && await c.locator('.notes-editor .tt-completed-section').count() === 0);
    db('database: the refused tick left the repeating child AND its parent open', () => {
        const r = sql(`SELECT p.is_completed::text || '|' || k.is_completed::text || '|' || (k.schedule IS NOT NULL)::text FROM channel_tasks k JOIN channel_tasks p ON p.id = k.parent_id WHERE k.list_id IN (${mine}) AND k.schedule IS NOT NULL ORDER BY k.id DESC LIMIT 1`);
        ck('database: the refused tick left the repeating child AND its parent open', r === 'false|false|true', r);
    });
    // Positive control, same note, same click: a plain item with no repeating
    // child under it DOES tick.
    await c.locator('.notes-editor .tt-item', { hasText: 'Charger' }).first().locator('input[type="checkbox"]').click();
    await c.waitForSelector('.notes-editor .tt-completed-section', { timeout: 10000 }).catch(() => {});
    ck('parent tick (positive control): a plain item ticks as before', await c.locator('.notes-editor .tt-completed-section').count() === 1);
    await c.getByRole('button', { name: 'Close', exact: true }).click();
    await c.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
    await shot('cal-parent-tick-refused');

    // ---- snooze from Reminders ----------------------------------------------------------
    await c.goto('/notes/#/reminders');
    await c.waitForSelector('.notes-reminders', { timeout: 10000 });
    const standupRow = c.locator('.notes-reminder-row', { hasText: 'Standup' });
    ck('reminders: the event is listed, and not as overdue', await standupRow.count() === 1 && await c.locator('.notes-reminder-group.overdue .notes-reminder-row', { hasText: 'Standup' }).count() === 0);
    // Retime from the row: an item that repeats opens the same Date & repeat
    // dialog the calendar uses, and the shell's single-key shortcuts must stop
    // while it is up (isEditableTarget says false for a <select>, and that
    // dialog is full of them). Cancel, so the snooze checks below still
    // measure an untouched item.
    await standupRow.locator('button[aria-label^="Change the time"]').click();
    await c.waitForSelector('.sched-dialog[aria-label="Date and repeat"]', { timeout: 10000 });
    ck('reminders: a repeating item retimes through the Date & repeat dialog', await c.locator('.sched-dialog[aria-label="Date and repeat"]').count() === 1);
    await c.keyboard.press('?');
    await sleep(300);
    ck('reminders: single-key shortcuts are off while that dialog is open',
        await c.locator('.notes-kbd-grid').count() === 0 && await c.locator('.sched-dialog').count() === 1);
    await c.locator('.sched-dialog .sched-btn', { hasText: 'Cancel' }).click();
    await c.waitForSelector('.sched-dialog', { state: 'detached', timeout: 5000 });
    // Positive control: with the dialog gone, `?` works again. The listener is
    // re-registered by an effect when the dialog closes, so give React a frame
    // and press again if the first key beat it — a control that is merely slow
    // must not read as a broken one.
    let helpBack = false;
    for (let i = 0; i < 4 && !helpBack; i++) {
        await sleep(400);
        await c.keyboard.press('?');
        helpBack = await c.waitForSelector('.notes-kbd-grid', { timeout: 2000 }).then(() => true, () => false);
    }
    ck('reminders: …and they come back when it closes (control)', helpBack);
    await c.keyboard.press('Escape');
    await c.waitForSelector('.notes-kbd-grid', { state: 'detached', timeout: 5000 }).catch(() => {});

    // Snooze's Tomorrow is the account's own morning time (the reminder-time
    // setting), so read it rather than assume 09:00 — the notes walk hands
    // this run an account whose morning has been changed.
    await c.click('button[aria-label="Account and settings"]');
    await c.waitForSelector('#notes-remind-morning', { timeout: 5000 });
    const morning = await c.locator('#notes-remind-morning').inputValue();
    ck('reminders: the account carries a morning time for Tomorrow to use', /^\d{2}:\d{2}$/.test(morning), morning);
    await c.keyboard.press('Escape');
    await sleep(300);

    await standupRow.locator('button[aria-label="Snooze"]').click();
    await standupRow.locator('.notes-snooze-menu button', { hasText: 'Tomorrow' }).click();
    await standupRow.locator('[aria-label="snoozed"]').waitFor({ timeout: 10000 }).catch(() => {});
    ck('snooze: the row is marked snoozed', await standupRow.locator('[aria-label="snoozed"]').count() === 1);
    db('database: one sealed snooze, nothing readable in it', () => {
        const s = sql(`SELECT count(*) FILTER (WHERE snooze IS NOT NULL)::text || '|' || coalesce(bool_or(snooze LIKE '%until%' OR snooze LIKE '%forDue%')::text, 'none') || '|' || coalesce(max(left(snooze, 8)), '') FROM channel_tasks WHERE list_id IN (${mine})`);
        const [n, leak, head] = s.split('|');
        ck('database: one sealed snooze, nothing readable in it', n === '1' && leak === 'false' && head.startsWith('{"v":'), s);
        // L15 on the phone: the snooze moved the plaintext due_at to the snooze
        // instant — tomorrow at the account's morning time, Dublin. The 29th is
        // IST (UTC+1), so the stored UTC is that time less an hour.
        const moved = sql(`SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') FROM channel_tasks WHERE list_id IN (${mine}) AND snooze IS NOT NULL`);
        const want = `2026-03-29T${String(Number(morning.slice(0, 2)) - 1).padStart(2, '0')}:${morning.slice(3)}`;
        ck(`database: the snooze moved due_at to the snooze instant (tomorrow ${morning} IST)`, moved === want, `${moved} want ${want}`);
    });
    await shot('cal-reminders-snoozed');

    // ---- Edited + the Recently-edited sort ---------------------------------------------
    const closeEditor = async () => {
        await c.getByRole('button', { name: 'Close', exact: true }).click();
        await c.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
    };
    const minute = notesCreatedAt + 61_000 - Date.now();
    if (minute > 0) await sleep(minute);
    await c.goto('/notes/');
    await c.waitForSelector('.notes-card', { timeout: 10000 });
    await c.locator('.notes-card', { hasText: 'Groceries' }).first().click();
    await c.waitForSelector('.notes-editor .task-tree', { timeout: 10000 });
    await c.fill('.notes-editor-add input', 'Jam');
    await c.press('.notes-editor-add input', 'Enter');
    await c.waitForSelector('.notes-editor .tt-item:has-text("Jam")', { timeout: 10000 });
    await closeEditor();
    await c.locator('.notes-card', { hasText: 'Groceries' }).first().click();
    await c.waitForSelector('.notes-editor .notes-edited', { timeout: 10000 }).catch(() => {});
    ck('edited: the editor shows "Edited" after an edit', /Edited/.test(await c.locator('.notes-editor .notes-edited').innerText().catch(() => '')));
    await closeEditor();
    // Unpinned notes (with nothing pinned there is no "Other notes" heading).
    const others = async () => {
        const sel = await c.locator('section[aria-label="Other notes"]').count() ? 'section[aria-label="Other notes"] .notes-card-title' : '.notes-card-title';
        return (await c.locator(sel).allInnerTexts()).map(t => t.trim());
    };
    const setSort = async v => {
        await c.click('button[aria-label="Account and settings"]');
        await c.waitForSelector('#notes-sort', { timeout: 5000 });
        await c.selectOption('#notes-sort', v);
        await c.keyboard.press('Escape');
        await sleep(300);
    };
    // Edit the OLDER of the two unpinned notes, so "edited" and "newest" disagree.
    await c.locator('.notes-card', { hasText: 'Phone note' }).first().click();
    await c.waitForSelector('.notes-editor .task-tree', { timeout: 10000 });
    await c.fill('.notes-editor-add input', 'Cable');
    await c.press('.notes-editor-add input', 'Enter');
    await c.waitForSelector('.notes-editor .tt-item:has-text("Cable")', { timeout: 10000 });
    await closeEditor();
    await sleep(500);
    await setSort('created');
    const byCreated = await others();
    await setSort('edited');
    const byEdited = await others();
    ck('sort: Newest first puts the calendar note ahead of Phone note', byCreated.indexOf('Phone note') > byCreated.findIndex(t => t.startsWith('Calendar')), JSON.stringify(byCreated));
    ck('sort: Recently edited puts the just-edited Phone note first', byEdited[0] === 'Phone note', JSON.stringify(byEdited));
    await setSort('puca');

    // ---- .ics export: RFC shape, deterministic UIDs -------------------------------------
    await c.goto('/notes/#/calendar?v=month&d=2026-03-28');
    await c.waitForSelector('.cal-month', { timeout: 10000 });
    const exportOnce = async () => {
        const [dl] = await Promise.all([
            c.waitForEvent('download', { timeout: 15000 }),
            c.locator('.cal-toggles button', { hasText: 'Export .ics' }).click(),
        ]);
        return fs.readFileSync(await dl.path(), 'utf8');
    };
    const ics1 = await exportOnce();
    ck('export: the plaintext warning was shown first', dialogs.some(m => /NOT encrypted/.test(m)), dialogs.at(-1));
    const lines = ics1.split('\r\n');
    ck('export: VCALENDAR with VERSION:2.0 and PRODID', lines[0] === 'BEGIN:VCALENDAR' && lines.includes('VERSION:2.0') && lines.some(l => l.startsWith('PRODID:')), lines.slice(0, 4).join(' / '));
    ck('export: CRLF only (no bare LF)', !/[^\r]\n/.test(ics1) && ics1.endsWith('\r\n'));
    ck('export: every line folded at 75 octets', lines.every(l => Buffer.byteLength(l, 'utf8') <= 75), lines.find(l => Buffer.byteLength(l, 'utf8') > 75));
    ck('export: every VEVENT has UID and DTSTAMP', ics1.split('BEGIN:VEVENT').slice(1).every(v => /\r\nUID:/.test(v) && /\r\nDTSTAMP:/.test(v)));
    ck('export: the daily series with its zone', ics1.includes('RRULE:FREQ=DAILY') && ics1.includes('DTSTART;TZID=Europe/Dublin:20260328T090000') && ics1.includes('BEGIN:VTIMEZONE'));
    const uids = s => s.split('\r\n').filter(l => l.startsWith('UID:')).sort().join(',');
    const ics2 = await exportOnce();
    ck('export: UIDs are deterministic (a second export names the same events)', uids(ics1) !== '' && uids(ics1) === uids(ics2), uids(ics1));

    // ---- .ics import: preview, then dedupe by UID ---------------------------------------
    const fileInput = c.locator('input[type="file"][accept*=".ics"]');
    await fileInput.setInputFiles({ name: 'trip.ics', mimeType: 'text/calendar', buffer: Buffer.from(ICS_IN) });
    await c.waitForSelector('.ics-import', { timeout: 5000 });
    const preview = await c.locator('.ics-import').innerText();
    ck('import preview: counts the items', /3 items/.test(preview), preview.slice(0, 120));
    ck('import preview: names what it cannot represent (an hourly repeat)', /repeat rule not supported/.test(preview));
    await c.locator('.ics-actions button', { hasText: 'Import 3' }).click();
    await c.waitForSelector('.ics-actions button:has-text("Close")', { timeout: 20000 });
    ck('import: all three created', /3 imported/.test(await c.locator('.ics-progress').innerText()), await c.locator('.ics-progress').innerText());
    await c.locator('.ics-actions button', { hasText: 'Close' }).click();
    await sleep(1500);
    await c.goto('/notes/#/calendar?v=month&d=2026-04-01');
    await c.waitForSelector('.cal-month', { timeout: 10000 });
    await cell('2026-04-01').locator('.cal-chip', { hasText: 'Flight out' }).waitFor({ timeout: 10000 }).catch(() => {});
    ck('import: the timed event is on its day', await cell('2026-04-01').locator('.cal-chip', { hasText: 'Flight out' }).count() === 1);
    ck('import: the all-day event is on its day', await cell('2026-04-02').locator('.cal-chip', { hasText: 'Bank holiday' }).count() === 1);
    // Again, into the note the first import made: every UID is already there.
    await fileInput.setInputFiles({ name: 'trip.ics', mimeType: 'text/calendar', buffer: Buffer.from(ICS_IN) });
    await c.waitForSelector('.ics-import', { timeout: 5000 });
    const tripValue = await c.locator('select[aria-label="Import into"] option', { hasText: 'Trip' }).first().getAttribute('value');
    await c.selectOption('select[aria-label="Import into"]', tripValue);
    await c.locator('.ics-actions button', { hasText: 'Import 3' }).click();
    await c.waitForSelector('.ics-actions button:has-text("Close")', { timeout: 20000 });
    const again = await c.locator('.ics-progress').innerText();
    ck('import again: every event already there is skipped', /0 imported/.test(again) && /3 already there/.test(again), again);
    await c.locator('.ics-actions button', { hasText: 'Close' }).click();
    db('database: imported events are sealed', () => {
        const leaks = sql(`SELECT count(*) FROM channel_tasks WHERE list_id IN (${mine}) AND (schedule LIKE '%Terminal%' OR schedule LIKE '%walk.test%' OR description LIKE '%Flight%')`);
        ck('database: imported events are sealed (no title, place or UID in the clear)', leaks === '0', leaks);
    });
    await shot('cal-imported');
    // ---- the SAME import, driven from PÚCA's own Calendar tab -----------------------
    // The dialog and its stylesheet moved out of notes/ so both calendars can
    // offer it; an unstyled dialog here would look fine in Notes.
    await c.goto('/chat');
    await c.waitForSelector('.chat-container', { timeout: 20000 });
    try { await c.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* no popup */ }
    await c.click('.server-icon.home-button');
    await c.locator('.sidebar-nav .nav-item', { hasText: 'Tasks' }).click();
    await c.waitForSelector('.tasks-tabbar', { timeout: 15000 });
    // The recovery-code reminder's overlay swallows clicks; answer it first.
    await c.waitForSelector('.recovery-reminder-actions .recovery-done-btn', { timeout: 4000 })
        .then(() => c.click('.recovery-reminder-actions .recovery-done-btn'))
        .catch(() => { /* not shown */ });
    await c.locator('.tasks-tab-calendar').click();
    await c.waitForSelector('.tasks-calendar', { timeout: 15000 });
    ck('púca calendar: Import .ics is offered beside Export', await c.locator('.cal-btn', { hasText: 'Import .ics' }).count() === 1);
    const pucaFile = c.locator('.tasks-calendar input[type="file"][accept*=".ics"]');
    await pucaFile.setInputFiles({ name: 'trip2.ics', mimeType: 'text/calendar', buffer: Buffer.from(ICS_IN) });
    await c.waitForSelector('.ics-import', { timeout: 5000 });
    const pucaPreview = await c.locator('.ics-import').innerText();
    ck('púca import preview: counts the items', /3 items/.test(pucaPreview), pucaPreview.slice(0, 120));
    ck('púca import preview: names what it cannot represent', /repeat rule not supported/.test(pucaPreview));
    ck('púca import: the dialog is styled (its CSS travelled with it)',
        await c.locator('.notes-dialog').evaluate(el => getComputedStyle(el).borderRadius) === '12px',
        await c.locator('.notes-dialog').evaluate(el => getComputedStyle(el).borderRadius));
    const pucaTargets = await c.locator('.ics-import select[aria-label="Import into"] option').allInnerTexts();
    ck('púca import: only personal notes are offered, never a shared checklist',
        pucaTargets.length > 1 && pucaTargets.every(t => !t.startsWith('#')), JSON.stringify(pucaTargets));
    const tripAgain = await c.locator('.ics-import select[aria-label="Import into"] option', { hasText: 'Trip' }).first().getAttribute('value').catch(() => null);
    if (tripAgain) {
        await c.selectOption('.ics-import select[aria-label="Import into"]', tripAgain);
        await c.locator('.ics-actions button', { hasText: 'Import 3' }).click();
        await c.waitForSelector('.ics-actions button:has-text("Close")', { timeout: 20000 });
        const pucaAgain = await c.locator('.ics-progress').innerText();
        ck('púca import: a second run of the same file imports nothing (UID dedupe)', /0 imported/.test(pucaAgain), pucaAgain);
    } else {
        ck('púca import: the note the first import made is offered as a target', false, JSON.stringify(pucaTargets));
    }
    await shot('puca-cal-import');
    await c.locator('.ics-actions button', { hasText: 'Close' }).first().click().catch(() => {});
    await ctx.close();

    // =========================================================================
    // Desktop, America/New_York, en-US: week start, and the spring-forward gap
    // =========================================================================
    const uctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL, storageState: state, timezoneId: 'America/New_York', locale: 'en-US' });
    const u = await uctx.newPage();
    watch(u);
    await u.clock.install({ time: new Date(NEW_YORK_NOW) });
    await u.goto('/notes/#/calendar?v=month&d=2026-03-07');
    await u.waitForSelector('.cal-month', { timeout: 20000 });
    ck('calendar en-US: the week starts on Sunday', (await u.locator('.cal-dow').first().innerText()).trim() === 'Sun', await u.locator('.cal-dow').first().innerText());
    ck('calendar en-US: today (fixed clock) is the 7th', (await u.locator('.cal-cell.today .cal-daynum').innerText()).trim() === '7');
    await u.locator('.cal-cell[data-drop-target="2026-03-08"] .cal-daynum').click();
    await u.locator('.cal-daylist-head button', { hasText: 'Add' }).click();
    await fillAddSheet(u, { title: 'Gap check', time: '02:30', target: 'new' });
    const gapChip = u.locator('.cal-cell[data-drop-target="2026-03-08"] .cal-chip', { hasText: 'Gap check' });
    await gapChip.waitFor({ timeout: 10000 });
    // 02:30 does not exist on Mar 8 in New York. RFC 5545: take the offset from
    // before the gap (EST, -5) → 07:30Z → 03:30 EDT on the wall.
    const gapTime = (await gapChip.locator('.cal-chip-time').innerText()).trim();
    ck('DST gap (RFC 5545): 02:30 on the spring-forward day shows as 3:30 AM', gapTime === '3:30 AM', gapTime);
    db('database: the gap event reminds 10 minutes before 07:30Z', () => {
        const due = sql(`SELECT to_char(t.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') FROM channel_tasks t WHERE t.list_id IN (${mine}) AND t.schedule IS NOT NULL ORDER BY t.id DESC LIMIT 1`);
        ck('database: the gap event reminds 10 minutes before 07:30Z', due === '2026-03-08T07:20', due);
    });
    await uctx.close();

    // =========================================================================
    // Phone: 390x844, coarse, en-US, New York
    // =========================================================================
    const mctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined, baseURL, storageState: state, timezoneId: 'America/New_York', locale: 'en-US' });
    const m = await mctx.newPage();
    watch(m);
    const mshot = shotOf(m);
    await m.clock.install({ time: new Date(NEW_YORK_NOW) });
    await m.goto('/notes/#/calendar?v=month&d=2026-03-08');
    await m.waitForSelector('.cal-month', { timeout: 20000 });
    // The notes load after the grid renders: wait for the item before auditing.
    await m.locator('.cal-daylist .cal-row', { hasText: 'Gap check' }).waitFor({ timeout: 15000 }).catch(() => {});
    const audit = await m.evaluate(() => {
        const vw = window.innerWidth;
        const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        const under = [];
        for (const b of [...document.querySelectorAll('.cal button, .cal input, .notes-fab')].filter(vis)) {
            const r = b.getBoundingClientRect();
            const min = b.matches('input[type="checkbox"]') ? 20 : 44;
            if (r.width < min - 0.5 || r.height < min - 0.5) under.push(`${b.className || b.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        const dot = document.querySelector('.cal-cell[data-drop-target="2026-03-08"] .cal-dots');
        const chips = document.querySelector('.cal-cell[data-drop-target="2026-03-08"] .cal-cell-chips');
        return {
            overflow: document.documentElement.scrollWidth > vw + 1, under,
            dots: !!dot && vis(dot), chipsHidden: !chips || !vis(chips),
            weekBtn: !!document.querySelector('.cal-viewbtn.view-week') && vis(document.querySelector('.cal-viewbtn.view-week')),
        };
    });
    await mshot('phone-calendar-month');
    ck('phone calendar: no horizontal overflow', !audit.overflow);
    ck('phone calendar: every tap target at size', audit.under.length === 0, JSON.stringify(audit.under));
    ck('phone calendar: a day shows dots, not chips', audit.dots && audit.chipsHidden);
    ck('phone calendar: no Week button under the phone gate', !audit.weekBtn);
    ck('phone calendar: the selected day lists its items', await m.locator('.cal-daylist .cal-row', { hasText: 'Gap check' }).count() === 1);
    await m.goto('/notes/#/calendar?v=week&d=2026-03-08');
    await m.waitForSelector('.cal', { timeout: 10000 });
    ck('phone calendar: ?v=week renders the day view, never a 7-column grid (JS gate = CSS gate)',
        await m.locator('.cal.view-day').count() === 1 && await m.locator('.cal-timegrid.cols-7').count() === 0);
    await mshot('phone-calendar-week-url');
    // Day on a phone is the day's LIST, with no time grid under it.
    await m.goto('/notes/#/calendar?v=day&d=2026-03-08');
    await m.waitForSelector('.cal.view-day', { timeout: 10000 });
    await m.locator('.cal-daylist .cal-row', { hasText: 'Gap check' }).waitFor({ timeout: 10000 }).catch(() => {});
    const phoneDay = await m.evaluate(() => ({
        grid: document.querySelectorAll('.cal-timegrid').length,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }));
    ck('phone Day (390x844): the day list, and NO time grid', phoneDay.grid === 0 && await m.locator('.cal-daylist .cal-row', { hasText: 'Gap check' }).count() === 1, JSON.stringify(phoneDay));
    ck('phone Day: no horizontal overflow', !phoneDay.overflow);
    await mshot('phone-calendar-day');
    await mctx.close();
    ck('calendar: no page errors', errors.length === 0, errors[0]);
    if (skipped) console.log(`SKIP  calendar: ${skipped} database proof(s) did not run — no psql DSN`);
    return { skipped };
}

// ---- Standalone -------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const outdir = process.argv[2] || 'e2e/shots-notes-calendar';
    const baseURL = process.argv[3] || 'http://127.0.0.1:5176';
    const psqlDsn = process.argv[4] || '';
    const PSQL = process.env.PSQL || 'psql';
    const sql = psqlDsn ? statement => {
        const r = spawnSync(PSQL, ['-v', 'ON_ERROR_STOP=1', '-At', '-c', statement, psqlDsn], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`psql failed: ${r.stderr || r.stdout}`);
        return (r.stdout || '').trim();
    } : null;
    fs.mkdirSync(outdir, { recursive: true });
    let fail = 0;
    const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };
    const errors = [];
    const watch = page => {
        page.on('pageerror', e => { errors.push(String(e)); console.log('[pageerror]', String(e).slice(0, 300)); });
        page.on('console', msg => { if (msg.type() === 'error') console.log('[console.error]', msg.text().slice(0, 200)); });
    };
    let n = 0;
    const shotOf = page => async name => { n++; const f = `${outdir}/${String(n).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: f }); console.log('SHOT', f); };
    const browser = await chromium.launch({ args: ['--mute-audio'] });   // a walk never makes a sound
    const username = 'notescal_' + Math.random().toString(36).slice(2, 8);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL });
    const page = await ctx.newPage();
    watch(page);
    await page.goto('/login');
    await page.waitForSelector('.toggle-mode', { timeout: 15000 });
    await page.click('.toggle-mode');
    await page.fill('#username', username);
    await page.fill('#password', 'Password123!');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 30000 });
    try { await page.click('.recovery-done-btn', { timeout: 8000 }); } catch { /* no modal */ }
    await page.goto('/notes/');
    await page.waitForSelector('.notes-empty', { timeout: 15000 });
    const notesCreatedAt = Date.now();
    for (const [title, first] of [['Groceries', 'Milk'], ['Phone note', 'Charger']]) {
        await page.click('.notes-quickadd-collapsed');
        await page.fill('.notes-quickadd-title', title);
        await page.locator('.notes-quickadd-item input').first().fill(first);
        await page.getByRole('button', { name: 'Done' }).click();
        await page.waitForSelector(`.notes-card:has-text("${title}")`, { timeout: 15000 });
    }
    const state = await ctx.storageState();
    await ctx.close();
    const { skipped } = await calendarWalk({ browser, baseURL, state, username, ck, watch, shotOf, sql, errors, notesCreatedAt });
    await browser.close();
    console.log(fail === 0 ? `\nALL PASS${skipped ? ` — ${skipped} database proof(s) SKIPPED (no DSN)` : ''}` : `\n${fail} FAILED`);
    process.exit(fail === 0 ? 0 : 1);
}
