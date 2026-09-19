// Púca Notes — the live walk. Drives the BUILT bundle (serve it with
// e2e/serve-dist.mjs, which answers /notes/ with Notes' own index) against a
// throwaway backend, at desktop size and then at 390x844 with a coarse
// pointer, and ASSERTS the design rules rather than only taking screenshots
// (docs/DESIGN_PHILOSOPHY.md §7; the clips-mobile-walk pattern).
//
// What it proves: Notes is signed in by the web app's own sign-in (shared
// origin storage); a note created in Notes is a list with items on the server;
// the editor is Púca's TaskTree (toggle, subtask, due, Escape inside an item
// edit does not close the note); colour/labels/pin/search/reminders/archive/
// delete-with-undo; a Notes sign-out lands the main app's tab on its login
// (sessionSync); a plaintext row injected in the database is flagged "Not
// encrypted"; and on the phone — one column, no horizontal overflow, every
// tap target at size, 16px inputs, the FAB composer, the drawer, a popover
// inside the viewport, the full-screen editor with the grip and arrows.
// And the Notes Android app's updates (NotesUpdateGate): in the browser no
// update check is ever made and the menu has no update rows; inside a FAKED
// native shell (the updater plugin answered in-page, the manifest answered by
// page.route) a bundle that needs a newer APK is not downloaded, the "install
// the new app" screen and the strip fit the phone, the strip takes its own
// row below the top bar with the account button still tappable, and the
// account menu shows the version and a working Check for updates.
//
// Usage: node e2e/notes-walk.mjs [outdir] [baseURL] [psql-dsn]
//   baseURL  default http://127.0.0.1:5176 — `PORT=5176 node e2e/serve-dist.mjs`
//   psql-dsn optional, e.g. postgres://postgres:testpw@127.0.0.1:55433/puca_keep_e2e
//            (enables the injected-plaintext check and the shared-item hint
//            walk; needs psql on PATH). Without it those sections print SKIP —
//            never a silent PASS.
//
// The last section runs the page as the ANDROID APP sees it, through a fake
// Capacitor bridge (window.androidBridge + NotesNative / SovereignLocation
// answering from the walk): it is the positive control for every "not on the
// web" check above — the banner, "At a place", the location toggle and Share
// must APPEAR there, and the native side must be handed ids and times only.
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const outdir = process.argv[2] || 'e2e/shots-notes';
const baseURL = process.argv[3] || 'http://127.0.0.1:5176';
const psqlDsn = process.argv[4] || '';
// The PostgreSQL client, or PSQL=<path> when another `psql` shadows it on PATH.
const PSQL = process.env.PSQL || 'psql';
/** Run one statement; returns psql's stdout (e.g. "UPDATE 1") or throws.
 *  Options BEFORE the DSN: on Windows psql's option parsing stops at the
 *  first positional argument, so `psql <dsn> -c ...` silently ignores the
 *  statement (a warning on stderr, exit 0) — the first cut of this walk
 *  "ran" every statement that way and proved nothing. */
function sql(statement) {
    const r = spawnSync(PSQL, ['-v', 'ON_ERROR_STOP=1', '-At', '-c', statement, psqlDsn], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`psql failed: ${r.stderr || r.stdout}`);
    return (r.stdout || '').trim();
}
fs.mkdirSync(outdir, { recursive: true });

const username = 'notes_' + Math.random().toString(36).slice(2, 8);
const password = 'Password123!';

let fail = 0;
const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let skipped = 0;
const skip = why => { skipped++; console.log(`SKIP  ${why}`); };

const browser = await chromium.launch();
const errors = [];
const watch = page => {
    page.on('pageerror', e => { errors.push(String(e)); console.log('[pageerror]', String(e).slice(0, 300)); });
    page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
};
let n = 0;
const shotOf = page => async name => {
    n++;
    const f = `${outdir}/${String(n).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path: f, fullPage: false });
    console.log('SHOT', f);
};

// =============================================================================
// Desktop
// =============================================================================
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL });
const page = await ctx.newPage();
watch(page);
const shot = shotOf(page);
// The browser page must never ask for an OTA manifest (NotesUpdateGate runs
// only inside the Notes Android app).
const browserUpdateChecks = [];
page.on('request', rq => { if (rq.url().includes('/api/mobile-updates/check')) browserUpdateChecks.push(rq.url()); });

// ---- 1. Notes before any sign-in: its OWN login card, not the main app ----------
await page.goto('/notes/');
await page.waitForSelector('.login-card', { timeout: 15000 });
ck('notes: signed out → Notes login card', await page.locator('.login-title').innerText() === 'Púca Notes');
ck('notes: the page is Notes, not the main app', await page.locator('#root[data-app="notes"]').count() === 1 && await page.locator('.chat-container').count() === 0);
await shot('notes-login');

// ---- 2. Register through the MAIN app: Notes shares the sign-in --------------------
await page.goto('/login');
await page.waitForSelector('.toggle-mode', { timeout: 15000 });
await page.click('.toggle-mode');
await page.fill('#username', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');
await page.waitForURL('**/chat', { timeout: 30000 });
try { await page.click('.recovery-done-btn', { timeout: 8000 }); } catch { /* no modal */ }
try { await page.click('.welcome-popup-close', { timeout: 3000 }); } catch { /* no popup */ }
await shot('main-app-signed-in');

// ---- 3. Notes is signed in (same origin, shared storage) ---------------------------
await page.goto('/notes/');
await page.waitForSelector('.notes-app', { timeout: 15000 });
ck('notes: shell mounted after the main app signed in', true);
await page.waitForSelector('.notes-empty', { timeout: 15000 });
ck('notes: fresh account shows the empty state', /Take a note/.test(await page.locator('.notes-empty').innerText()));
await shot('notes-empty');

// ---- 4. Take a note… ---------------------------------------------------------------
await page.click('.notes-quickadd-collapsed');
await page.fill('.notes-quickadd-title', 'Groceries');
const item = i => page.locator('.notes-quickadd-item input').nth(i);
await item(0).fill('Milk');
await item(0).press('Enter');
await item(1).fill('Bread');
await item(1).press('Enter');
await item(2).fill('Eggs');
await shot('quickadd-open');
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForSelector('.notes-card', { timeout: 15000 });
ck('quick add: one card, titled Groceries', await page.locator('.notes-card').count() === 1 && (await page.locator('.notes-card-title').first().innerText()).startsWith('Groceries'));
await page.waitForFunction(() => document.querySelectorAll('.notes-card-item').length === 3, null, { timeout: 15000 });
ck('quick add: three items in typed order', (await page.locator('.notes-card-item-text').allInnerTexts()).join(',') === 'Milk,Bread,Eggs');
await shot('one-card');

// ---- 5. The editor is Púca's TaskTree ----------------------------------------------
await page.click('.notes-card');
await page.waitForSelector('.notes-editor .task-tree', { timeout: 15000 });
ck('editor: three TaskTree rows', await page.locator('.notes-editor .tt-item').count() === 3);
// toggle Milk. click(), not check(): the box is a CONTROLLED input whose DOM
// state React restores until the optimistic update commits a frame later,
// and check() asserts the flip synchronously — the completed section is the
// real evidence.
await page.locator('.notes-editor .tt-item input[type="checkbox"]').first().click();
await page.waitForSelector('.notes-editor .tt-completed-section', { timeout: 10000 });
ck('editor: completing a row moves it to the Completed section', /Completed \(1\)/.test(await page.locator('.tt-toggle-completed').innerText()));
// add from the TOP row
await page.fill('.notes-editor-add input', 'Butter');
await page.press('.notes-editor-add input', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('.notes-editor .tt-item').length === 4, null, { timeout: 10000 });
ck('editor: the add row (on top) adds an item', true);
// subtask under Bread
const breadRow = page.locator('.notes-editor .tt-item', { hasText: 'Bread' }).first();
await breadRow.hover();
await breadRow.locator('.tt-btn[title="Add subtask"]').click();
await page.fill('.notes-editor .tt-subtask-add input', 'Sourdough');
await page.press('.notes-editor .tt-subtask-add input', 'Enter');
await page.waitForSelector('.notes-editor .tt-nest .tt-item', { timeout: 10000 });
ck('editor: a subtask nests under its parent', await page.locator('.notes-editor .tt-nest .tt-item').count() >= 1);
// The subtask input stays open for the next one (TaskTree's behaviour);
// close it with Escape as a user would, or its blur-on-mousedown shifts the
// rows below out from under the next click.
await page.keyboard.press('Escape');
await sleep(150);
ck('editor: Escape closes the subtask input and keeps the note open', await page.locator('.notes-editor .tt-subtask-add').count() === 0 && await page.locator('.notes-editor').count() === 1);
// due time on Eggs (tomorrow 09:00)
const eggsRow = page.locator('.notes-editor .tt-item', { hasText: 'Eggs' }).first();
await eggsRow.hover();
await eggsRow.locator('.tt-btn[title="Add due time"]').click();
const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
const p = x => String(x).padStart(2, '0');
await page.fill('.tt-due-edit input', `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`);
await page.click('.tt-due-set');
await page.waitForSelector('.notes-editor .tt-due', { timeout: 10000 });
ck('editor: a due time renders its chip', true);
// Escape INSIDE an inline item edit must not close the note
await page.locator('.notes-editor .tt-item', { hasText: 'Butter' }).first().locator('.tt-description').click();
await page.waitForSelector('.notes-editor .tt-edit-input', { timeout: 5000 });
await page.keyboard.press('Escape');
await sleep(200);
ck('editor: Escape in an item edit cancels the edit and keeps the note open',
    await page.locator('.notes-editor .tt-edit-input').count() === 0 && await page.locator('.notes-editor').count() === 1);
// colour from the footer, then Escape closes only the popover
await page.click('.notes-editor-foot button[aria-label="Colour"]');
await page.waitForSelector('.notes-popover', { timeout: 5000 });
await page.click('.notes-swatch[data-color="mint"]');
ck('editor: colour applies to the editor', await page.locator('.notes-editor[data-color="mint"]').count() === 1);
await page.keyboard.press('Escape');
await sleep(150);
ck('editor: Escape closes the popover, not the note', await page.locator('.notes-popover').count() === 0 && await page.locator('.notes-editor').count() === 1);
// labels
await page.click('.notes-editor-foot button[aria-label="Labels"]');
await page.waitForSelector('.notes-labels-new input', { timeout: 5000 });
await page.fill('.notes-labels-new input', 'Errands');
await page.press('.notes-labels-new input', 'Enter');
await sleep(150);
ck('editor: a typed label is ticked', await page.locator('.notes-labels-list input:checked').count() === 1);
await page.keyboard.press('Escape');
// the card menu opened FROM the editor: Escape closes the menu only
await page.click('.notes-editor-foot button[aria-label="More actions"]');
await page.waitForSelector('.context-menu', { timeout: 5000 });
await page.keyboard.press('Escape');
await sleep(200);
ck('editor: Escape closes the context menu, not the note', await page.locator('.context-menu').count() === 0 && await page.locator('.notes-editor').count() === 1);
await shot('editor');
// close via Escape with nothing focused
await page.locator('.notes-editor-title').blur();
await page.keyboard.press('Escape');
await sleep(200);
ck('editor: Escape (outside inputs) closes the note', await page.locator('.notes-editor').count() === 0);

// ---- 6. Card state, labels rail, filter ------------------------------------------------
ck('card: carries the colour', await page.locator('.notes-card[data-color="mint"]').count() === 1);
ck('card: shows the label chip and progress', /Errands/.test(await page.locator('.notes-card-foot').innerText()) && /1\/5/.test(await page.locator('.notes-card-foot').innerText()));
ck('rail: the label appears', await page.locator('.notes-rail-item', { hasText: 'Errands' }).count() === 1);
await page.locator('.notes-rail-item', { hasText: 'Errands' }).click();
await page.waitForSelector('h1.notes-section-title', { timeout: 5000 });
// textContent, not innerText: the heading is CSS-uppercased and innerText returns the rendered case.
ck('label view: filtered heading + the one card', /Label: Errands/.test(await page.locator('h1.notes-section-title').textContent()) && await page.locator('.notes-card').count() === 1);
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();

// ---- 7. Pin ------------------------------------------------------------------------------------
await page.locator('.notes-card').first().hover();
await page.click('.notes-card-pin');
await page.waitForSelector('section[aria-label="Pinned notes"]', { timeout: 10000 });
ck('pin: the card moves to the Pinned section', await page.locator('section[aria-label="Pinned notes"] .notes-card').count() === 1);
// Keyboard: Enter on a control INSIDE the card activates that control (unpin),
// it must not open the note.
await page.locator('.notes-card').first().locator('.notes-card-pin').focus();
await page.keyboard.press('Enter');
await page.waitForSelector('section[aria-label="Pinned notes"]', { state: 'detached', timeout: 10000 }).catch(() => {});
ck('keyboard: Enter on the pin button unpins and does NOT open the editor',
    await page.locator('section[aria-label="Pinned notes"]').count() === 0 && await page.locator('.notes-editor').count() === 0);
await page.locator('.notes-card').first().locator('.notes-card-pin').focus();
await page.keyboard.press('Enter');
await page.waitForSelector('section[aria-label="Pinned notes"]', { timeout: 10000 });
ck('keyboard: Enter again re-pins', await page.locator('section[aria-label="Pinned notes"] .notes-card').count() === 1);
// Enter on the card itself opens it.
await page.locator('.notes-card').first().focus();
await page.keyboard.press('Enter');
await page.waitForSelector('.notes-editor', { timeout: 5000 });
ck('keyboard: Enter on the card opens the note', true);
await page.keyboard.press('Escape');
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });

// ---- 8. Second note, search, move -----------------------------------------------------------
await page.click('.notes-quickadd-collapsed');
await page.fill('.notes-quickadd-title', 'Packing');
await page.locator('.notes-quickadd-item input').first().fill('Socks');
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForFunction(() => document.querySelectorAll('.notes-card').length === 2, null, { timeout: 15000 });
await page.click('.notes-quickadd-collapsed');
await page.fill('.notes-quickadd-title', 'Reading');
await page.locator('.notes-quickadd-item input').first().fill('Dune');
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForFunction(() => document.querySelectorAll('.notes-card').length === 3, null, { timeout: 15000 });
const othersTitles = async () => (await page.locator('section[aria-label="Other notes"] .notes-card-title').allInnerTexts()).map(t => t.trim());
ck('others: natural order Packing, Reading', (await othersTitles()).join(',') === 'Packing,Reading');
await page.locator('.notes-card', { hasText: 'Reading' }).hover();
await page.locator('.notes-card', { hasText: 'Reading' }).locator('button[aria-label="More actions"]').click();
await page.waitForSelector('.context-menu', { timeout: 5000 });
await page.locator('.context-menu-item', { hasText: 'Move to top' }).click();
await sleep(400);
ck('move: "Move to top" reorders the others (and never touches the pinned one)', (await othersTitles()).join(',') === 'Reading,Packing' && await page.locator('section[aria-label="Pinned notes"] .notes-card').count() === 1);
await shot('three-cards');
await page.fill('.notes-search input', 'bread');
await sleep(300);
ck('search: matches an item inside a note', await page.locator('.notes-card').count() === 1 && /Groceries/.test(await page.locator('.notes-card-title').first().innerText()));
await page.fill('.notes-search input', 'zzzz');
await sleep(300);
ck('search: no match shows the empty state', await page.locator('.notes-empty').count() === 1);
await page.click('button[aria-label="Clear search"]');
await sleep(200);
ck('search: cleared', await page.locator('.notes-card').count() === 3);

// ---- 9. Reminders view -----------------------------------------------------------------------------
await page.locator('.notes-rail-item', { hasText: 'Reminders' }).click();
await page.waitForSelector('.notes-reminders', { timeout: 5000 });
ck('reminders: the due item is listed under Upcoming', await page.locator('.notes-reminder-row', { hasText: 'Eggs' }).count() === 1);
// The Android app's status lines and "At a place" are app-only: a browser
// has no alarms to describe and no place store to read. (Section 16 is the
// positive control: the same page in the Android shell MUST show both.)
ck('reminders (web): no native status banner', await page.locator('[data-native-banner]').count() === 0);
ck('reminders (web): no "At a place" section', await page.locator('section[aria-label="At a place"]').count() === 0);
await shot('reminders');
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();

// ---- 10. Archive with undo -----------------------------------------------------------------------------
const packing = () => page.locator('.notes-card', { hasText: 'Packing' });
await packing().hover();
await packing().locator('button[aria-label="Archive"]').click();
await page.waitForSelector('.notes-undo', { timeout: 5000 });
ck('archive: the card leaves the view and the undo bar shows', await packing().count() === 0);
await page.locator('.notes-undo button').click();
await sleep(200);
ck('archive: Undo brings it back', await packing().count() === 1 && await page.locator('.notes-undo').count() === 0);
await packing().hover();
await packing().locator('button[aria-label="Archive"]').click();
await page.waitForSelector('.notes-undo', { timeout: 5000 });
await page.locator('.notes-rail-item', { hasText: 'Archive' }).click();
await sleep(300);
ck('archive view: the archived card is there with its chip', await packing().count() === 1 && /archived/.test(await packing().locator('.notes-card-foot').innerText()));
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();

// ---- 11. Delete with undo (server-side only on expiry) -----------------------------------------------
const reading = () => page.locator('.notes-card', { hasText: 'Reading' });
await reading().hover();
await reading().locator('button[aria-label="More actions"]').click();
await page.locator('.context-menu-item', { hasText: 'Delete note' }).click();
await page.waitForSelector('.notes-undo', { timeout: 5000 });
ck('delete: hidden at once, undo offered', await reading().count() === 0);
await page.locator('.notes-undo button').click();
await sleep(200);
ck('delete: Undo restores it', await reading().count() === 1);
await reading().hover();
await reading().locator('button[aria-label="More actions"]').click();
await page.locator('.context-menu-item', { hasText: 'Delete note' }).click();
await page.waitForSelector('.notes-undo', { timeout: 5000 });
await page.waitForSelector('.notes-undo', { state: 'detached', timeout: 12000 });
await page.keyboard.press('r');   // refresh from the server
await sleep(1500);
ck('delete: gone from the view after the undo window', await reading().count() === 0);
await shot('after-delete');

// ---- 12. Server-side truth via the database ----------------------------------------------------------
if (psqlDsn) {
    try {
        // Scoped to THIS run's user: the throwaway database accumulates a user
        // per run, and MIN(id) over everything would tamper with somebody else's row.
        const mine = `SELECT l.id FROM task_lists l JOIN users u ON u.id = l.owner_id WHERE u.username = '${username}'`;
        const lists = sql(`SELECT count(*) FROM (${mine}) x`);
        ck('database: the deleted note is gone from the server (2 lists remain)', lists === '2', lists);
        // An OPEN top-level row of the FIRST list (Groceries, still in the main
        // view): the card preview folds completed rows away ("1 completed"), and
        // Packing is archived at this point, so a badge on either would be
        // correct yet invisible here.
        const injected = sql(`UPDATE channel_tasks SET description = 'INJECTED PLAINTEXT' WHERE id = (SELECT MAX(t.id) FROM channel_tasks t WHERE t.list_id = (SELECT MIN(id) FROM (${mine}) y) AND NOT t.is_completed AND t.parent_id IS NULL)`);
        ck('database: one row rewritten as plaintext (positive control)', injected === 'UPDATE 1', injected);
        await page.keyboard.press('r');
        await sleep(1500);
        await page.waitForSelector('.notes-card .tt-not-encrypted', { timeout: 10000 }).catch(() => {});
        ck('injected plaintext: the card flags the row "Not encrypted"', await page.locator('.notes-card .tt-not-encrypted').count() >= 1);
        await page.fill('.notes-search input', 'injected');
        await sleep(300);
        ck('injected plaintext: searchable as plain text (it IS readable)', await page.locator('.notes-card').count() === 1);
        await page.click('button[aria-label="Clear search"]');
    } catch (e) {
        ck('database checks ran', false, String(e).slice(0, 200));
    }
} else {
    skip('database checks (no psql DSN given)');
}

// ---- 12b. Export and share on the web ---------------------------------------------------------------
// The Android app saves to Documents and offers Share and location reminders;
// the browser keeps its download and shows neither app-only control (section
// 16 proves the controls do appear in the Android shell).
await page.click('button[aria-label="Account and settings"]');
await page.waitForSelector('.notes-menu', { timeout: 5000 });
ck('web menu: no location-reminders toggle', await page.locator('#notes-location').count() === 0);
ck('web menu: no "Share notes…"', await page.getByRole('button', { name: /Share notes/ }).count() === 0);
ck('web menu: the export items are there', await page.getByRole('button', { name: 'Export notes as Markdown' }).count() === 1
    && await page.getByRole('button', { name: 'Export notes as JSON' }).count() === 1);
const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.getByRole('button', { name: 'Export notes as Markdown' }).click(),
]);
ck('web export: still a browser download', !!dl && /^puca-notes-\d{4}-\d{2}-\d{2}\.md$/.test(dl.suggestedFilename()), dl ? dl.suggestedFilename() : 'no download');
const groceries = page.locator('.notes-card', { hasText: 'Groceries' });
await groceries.hover();
await groceries.locator('button[aria-label="More actions"]').click();
await page.waitForSelector('.context-menu-item', { timeout: 5000 });
ck('web card menu: "Copy as text" is there, "Share…" is not',
    await page.locator('.context-menu-item', { hasText: 'Copy as text' }).count() === 1
    && await page.locator('.context-menu-item', { hasText: 'Share…' }).count() === 0);
await page.keyboard.press('Escape');
await sleep(200);

// ---- 13. Cross-tab: a Notes sign-out lands the main app's tab on its login ---------------------------
const page2 = await ctx.newPage();
watch(page2);
await page2.goto('/chat');
await page2.waitForSelector('.chat-container', { timeout: 20000 }).catch(() => {});
await page.click('button[aria-label="Account and settings"]');
await page.waitForSelector('.notes-menu', { timeout: 5000 });
await shot('account-menu');
ck('browser: the account menu has no update rows (they are the Android app\'s)', !/Check for updates/.test(await page.locator('.notes-menu').innerText()));
ck('browser: Notes never asked for an OTA manifest', browserUpdateChecks.length === 0, JSON.stringify(browserUpdateChecks));
await page.getByRole('button', { name: 'Sign out', exact: true }).click();
await page.waitForSelector('.login-card', { timeout: 10000 });
ck('sign out: Notes returns to its login', true);
await page2.waitForURL('**/login', { timeout: 8000 }).then(() => ck('sign out: the main app tab followed (sessionSync)', true)).catch(() => ck('sign out: the main app tab followed (sessionSync)', false, 'still on ' + page2.url()));
await page2.close();

// ---- 14. Sign in from Notes' own form ------------------------------------------------------------
await page.fill('#username', username);
await page.fill('#password', password);
await page.click('.login-button');
await page.waitForSelector('.notes-app', { timeout: 20000 });
await page.waitForSelector('.notes-card', { timeout: 15000 });
ck('sign in: Notes signs in with the Púca account and the notes are back', await page.locator('.notes-card').count() >= 1);
// Labels/colours are DEVICE-LOCAL and sign-out scrubs them (documented): the
// card must come back without them — anything else would mean the scrub failed.
ck('sign in: device-local colour was scrubbed by the sign-out (as documented)', await page.locator('.notes-card[data-color="mint"]').count() === 0);
await shot('signed-in-again');
ck('desktop: no page errors', errors.length === 0, errors[0]);

// =============================================================================
// Phone — 390x844, coarse pointer, signed in via the same origin storage
// =============================================================================
const state = await ctx.storageState();
await ctx.close();
const iphone = devices['iPhone 13'];
const mctx = await browser.newContext({ ...iphone, defaultBrowserType: undefined, baseURL, storageState: state });
const m = await mctx.newPage();
watch(m);
const mshot = shotOf(m);

const audit = () => m.evaluate(() => {
    const vw = window.innerWidth;
    const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    let widest = 0;
    for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); if (vis(el) && r.right > widest) widest = r.right; }
    const buttons = [...document.querySelectorAll('button, a.notes-iconbtn, [role="button"]')].filter(vis);
    const under = [];
    for (const b of buttons) {
        const r = b.getBoundingClientRect();
        const min = b.matches('.tt-btn') ? 30 : b.matches('.notes-iconbtn.small') ? 40 : b.matches('.notes-chip, .notes-card') ? 0 : 44;
        if (min && (r.width < min - 0.5 || r.height < min - 0.5)) under.push(`${b.className || b.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    const ghosts = [...document.querySelectorAll('button, input, a')].filter(el => vis(el) && parseFloat(getComputedStyle(el).opacity) === 0).map(el => el.className);
    const cards = [...document.querySelectorAll('.notes-card')].map(c => Math.round(c.getBoundingClientRect().left));
    const fonts = {};
    for (const sel of ['.notes-search input', '.notes-editor-add input', '.notes-editor-title', '.notes-quickadd-title', '.notes-quickadd-item input', '.tt-edit-input']) {
        const el = document.querySelector(sel);
        if (el) fonts[sel] = parseFloat(getComputedStyle(el).fontSize);
    }
    return { vw, widest, bodyScrollsHorizontally: document.documentElement.scrollWidth > vw + 1, under, ghosts, cards, fonts,
        fabVisible: !!document.querySelector('.notes-fab') && vis(document.querySelector('.notes-fab')),
        inlineComposerHidden: !document.querySelector('.notes-quickadd') || !vis(document.querySelector('.notes-quickadd')) };
});

await m.goto('/notes/');
await m.waitForSelector('.notes-card', { timeout: 20000 });
let r = await audit();
await mshot('phone-grid');
ck('phone: no horizontal overflow', !r.bodyScrollsHorizontally && r.widest <= r.vw + 1, `widest=${r.widest} vw=${r.vw}`);
ck('phone: single column', new Set(r.cards).size === 1, JSON.stringify(r.cards));
ck('phone: every tap target at size', r.under.length === 0, JSON.stringify(r.under));
ck('phone: no invisible-but-tappable controls', r.ghosts.length === 0, JSON.stringify(r.ghosts));
ck('phone: FAB shown, inline composer hidden', r.fabVisible && r.inlineComposerHidden);
ck('phone: search input ≥ 16px', r.fonts['.notes-search input'] >= 16, `${r.fonts['.notes-search input']}px`);

// drawer
await m.tap('.notes-menu-btn');
await m.waitForSelector('.notes-rail.open', { timeout: 5000 });
r = await audit();
await mshot('phone-drawer');
ck('phone: drawer opens and the FAB is not trapped behind it', r.fabVisible);
// Tap the scrim where it is NOT covered by the drawer (Playwright taps the
// element's centre by default, which the 300px drawer sits over).
await m.tap('.notes-rail-scrim', { position: { x: 370, y: 400 } });
await m.waitForSelector('.notes-rail.open', { state: 'detached', timeout: 5000 }).catch(() => {});
ck('phone: tap-outside closes the drawer', await m.locator('.notes-rail.open').count() === 0);

// FAB composer
await m.tap('.notes-fab');
await m.waitForSelector('.notes-quickadd.sheet', { timeout: 5000 });
r = await audit();
ck('phone: composer inputs ≥ 16px', r.fonts['.notes-quickadd-title'] >= 16 && r.fonts['.notes-quickadd-item input'] >= 16, JSON.stringify(r.fonts));
await m.fill('.notes-quickadd-title', 'Phone note');
await m.locator('.notes-quickadd-item input').first().fill('Charger');
// A long list must keep Done reachable: the sheet scrolls, nothing is clipped.
for (let i = 1; i <= 14; i++) {
    await m.locator('.notes-quickadd-item input').nth(i - 1).press('Enter');
    await m.locator('.notes-quickadd-item input').nth(i).fill(`Item ${i}`);
}
await mshot('phone-composer');
const done = m.getByRole('button', { name: 'Done' });
await done.scrollIntoViewIfNeeded();
const db = await done.boundingBox();
const sheetVh = await m.evaluate(() => window.innerHeight);
ck('phone: Done stays reachable under a 15-item list (the sheet scrolls)', db && db.y >= 0 && db.y + db.height <= sheetVh + 0.5, JSON.stringify(db));
await done.tap();
await m.waitForSelector('.notes-card:has-text("Phone note")', { timeout: 15000 });
ck('phone: the FAB composer creates a note', true);
// The account menu's selects must not trigger the iOS zoom.
await m.tap('button[aria-label="Account and settings"]');
await m.waitForSelector('.notes-menu-row select', { timeout: 5000 });
const selPx = await m.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.notes-menu-row select')).fontSize));
ck('phone: account-menu selects ≥ 16px', selPx >= 16, `${selPx}px`);
await m.keyboard.press('Escape');
await m.waitForSelector('.notes-popover', { state: 'detached', timeout: 5000 });

// editor
await m.tap('.notes-card:has-text("Groceries")');
await m.waitForSelector('.notes-editor .task-tree', { timeout: 15000 });
const box = await m.locator('.notes-editor').boundingBox();
const vh = await m.evaluate(() => window.innerHeight);
ck('phone: editor is full-screen', box && box.height >= vh - 2 && box.width >= 389, JSON.stringify(box));
r = await audit();
ck('phone: editor title + add row ≥ 16px', r.fonts['.notes-editor-title'] >= 16 && r.fonts['.notes-editor-add input'] >= 16, JSON.stringify(r.fonts));
ck('phone: editor tap targets at size', r.under.length === 0, JSON.stringify(r.under));
const grip = await m.evaluate(() => { const g = document.querySelector('.notes-editor .tt-grip:not(.tt-grip-ghost)'); return g ? parseFloat(getComputedStyle(g).opacity) : -1; });
ck('phone: the drag grip is visible (not the desktop hover state)', grip >= 0.5, String(grip));
ck('phone: the move arrows (tap alternative) are shown', await m.locator('.notes-editor .tt-move').first().isVisible());
// Bread, not Butter: the database step above rewrote Butter's text.
await m.locator('.notes-editor .tt-item', { hasText: 'Bread' }).first().locator('.tt-description').tap();
await m.waitForSelector('.notes-editor .tt-edit-input', { timeout: 5000 });
r = await audit();
ck('phone: inline item edit ≥ 16px', r.fonts['.tt-edit-input'] >= 16, `${r.fonts['.tt-edit-input']}px`);
await m.keyboard.press('Escape');
await new Promise(res => setTimeout(res, 200));
ck('phone: Escape in the item edit keeps the note open', await m.locator('.notes-editor').count() === 1);
await mshot('phone-editor');
// a popover from the footer stays inside the viewport
await m.tap('.notes-editor-foot button[aria-label="Colour"]');
await m.waitForSelector('.notes-popover', { timeout: 5000 });
const pb = await m.locator('.notes-popover').boundingBox();
ck('phone: colour popover inside the viewport', pb && pb.x >= 0 && pb.x + pb.width <= 390.5 && pb.y >= 0 && pb.y + pb.height <= vh + 0.5, JSON.stringify(pb));
await mshot('phone-popover');
await m.keyboard.press('Escape');
await m.getByRole('button', { name: 'Close', exact: true }).tap();
await m.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });

// themes: light + high contrast at 130% text, then amoled with animations off
for (const [name, patch] of [
    ['light-contrast-130', { theme: 'light', highContrast: true, fontScale: 130 }],
    ['amoled-noanim', { theme: 'amoled', animationsEnabled: false }],
]) {
    await m.evaluate(p => {
        const cur = JSON.parse(localStorage.getItem('sovereign_settings') || '{}');
        localStorage.setItem('sovereign_settings', JSON.stringify({ ...cur, ...p }));
    }, patch);
    await m.reload();
    await m.waitForSelector('.notes-card', { timeout: 20000 });
    r = await audit();
    ck(`phone ${name}: still no overflow, targets at size`, !r.bodyScrollsHorizontally && r.under.length === 0, JSON.stringify(r.under));
    await mshot(`phone-${name}`);
}
ck('phone: no page errors', errors.length === 0, errors[0]);
await mctx.close();

// Where the API lives, read off the page's own traffic (the dist was built
// against it): the first /task-lists request's origin.
async function apiBaseOf(pg) {
    const url = await pg.evaluate(() => performance.getEntriesByType('resource').map(e => e.name).find(u => /\/task-lists(\?|$)/.test(u)));
    return url ? url.replace(/\/task-lists.*$/, '') : null;
}
async function authed(pg, api, method, path, body) {
    return pg.evaluate(async ([api, method, path, body]) => {
        const r = await fetch(api + path, {
            method,
            headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token'), 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: r.status, body: await r.text() };
    }, [api, method, path, body]);
}

// The phone drawer closes with a 0.2 s slide: measure and shoot after it.
async function closedDrawer(pg) {
    await pg.waitForSelector('.notes-rail.open', { state: 'detached', timeout: 5000 }).catch(() => {});
    await sleep(350);
}
/** Is the element's centre really showing IT (not a drawer or scrim on top)? */
const onTop = (pg, sel) => pg.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && (hit === el || el.contains(hit));
}, sel);

// ---- 15. "Reminds whoever set it": a shared item someone else set -----------------------------------
// GET /task-reminders covers only the caller's own channel tasks, so an item in
// a shared note that ANOTHER member set reminds them, not this user, and the
// Reminders row says so — on a second line, at desktop size and at 390x844.
if (!psqlDsn) {
    skip('shared-item hint (no psql DSN: the walk cannot seed a shared note)');
} else {
    try {
        // A second account, registered like the first.
        const bctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL });
        const b = await bctx.newPage();
        const username2 = username + 'b';
        await b.goto('/login');
        await b.waitForSelector('.toggle-mode', { timeout: 15000 });
        await b.click('.toggle-mode');
        await b.fill('#username', username2);
        await b.fill('#password', password);
        await b.click('button[type="submit"]');
        await b.waitForURL('**/chat', { timeout: 30000 });
        await bctx.close();

        const hctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL, storageState: state });
        const h = await hctx.newPage();
        watch(h);
        await h.goto('/notes/');
        await h.waitForSelector('.notes-card', { timeout: 20000 });
        const api = await apiBaseOf(h);
        ck('hint setup: the API base was read off the page', !!api, String(api));
        const created = await authed(h, api, 'POST', '/servers', { name: 'Walk shared' });
        ck('hint setup: a server was created (positive control)', created.status >= 200 && created.status < 300, `${created.status} ${created.body.slice(0, 120)}`);
        const serverId = JSON.parse(created.body).id;
        const cid = sql(`SELECT id FROM channels WHERE server_id = '${serverId}' ORDER BY position, id LIMIT 1`);
        const me = sql(`SELECT id FROM users WHERE username = '${username}'`);
        const other = sql(`SELECT id FROM users WHERE username = '${username2}'`);
        ck('hint setup: two distinct accounts and a channel', /^\d+$/.test(cid) && /^\d+$/.test(me) && /^\d+$/.test(other) && me !== other, `${cid} ${me} ${other}`);
        sql(`UPDATE channels SET has_checklist = true WHERE id = ${cid}`);
        const ins = sql(`INSERT INTO channel_tasks (channel_id, description, created_by, position, due_at) VALUES (${cid}, 'Shared errand', ${other}, 0, now() + interval '3 hours'), (${cid}, 'My shared errand', ${me}, 1, now() + interval '4 hours')`);
        ck('hint setup: two due items in the shared note', ins === 'INSERT 0 2', ins);

        await h.reload();
        await h.waitForSelector('.notes-card', { timeout: 20000 });
        await h.locator('.notes-rail-item', { hasText: 'Reminders' }).click();
        await h.waitForSelector('.notes-reminder-row:has-text("Shared errand")', { timeout: 15000 });
        const rowFacts = pg => pg.evaluate(() => [...document.querySelectorAll('.notes-reminder-row')].map(r => {
            const text = r.querySelector('.notes-reminder-text');
            const sub = text ? text.querySelector('.notes-reminder-sub') : null;
            const when = r.querySelector('.notes-reminder-when');
            const box = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
            return {
                label: text ? (text.firstChild ? text.firstChild.textContent : '').trim() : '',
                cells: r.children.length,
                hint: sub ? sub.textContent : null,
                row: box(r), text: text ? box(text) : null, sub: sub ? box(sub) : null, when: when ? box(when) : null,
            };
        }));
        let rows = await rowFacts(h);
        let hinted = rows.find(x => x.label === 'Shared errand');
        let mine = rows.find(x => x.label === 'My shared errand');
        ck('desktop hint: the item someone else set says "Reminds whoever set it"', !!hinted && hinted.hint === 'Reminds whoever set it', JSON.stringify(hinted));
        ck('desktop hint: my own shared item does not (control)', !!mine && mine.hint === null, JSON.stringify(mine));
        ck('desktop hint: a second line inside the item cell, not a new column', !!hinted && !!hinted.sub && hinted.cells === 4 && hinted.sub.t >= hinted.text.t + 4 && hinted.sub.b <= hinted.row.b + 0.5, JSON.stringify(hinted));
        await shotOf(h)('hint-desktop');
        await hctx.close();

        const pctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined, baseURL, storageState: state });
        const pg = await pctx.newPage();
        watch(pg);
        await pg.goto('/notes/');
        await pg.waitForSelector('.notes-card', { timeout: 20000 });
        await pg.tap('.notes-menu-btn');
        await pg.waitForSelector('.notes-rail.open', { timeout: 5000 });
        await pg.locator('.notes-rail-item', { hasText: 'Reminders' }).tap();
        await pg.waitForSelector('.notes-reminder-row:has-text("Shared errand")', { timeout: 15000 });
        await closedDrawer(pg);
        rows = await rowFacts(pg);
        hinted = rows.find(x => x.label === 'Shared errand');
        mine = rows.find(x => x.label === 'My shared errand');
        const vw = await pg.evaluate(() => window.innerWidth);
        const overflow = await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        ck('phone hint (390x844): shown under the item', !!hinted && hinted.hint === 'Reminds whoever set it' && !!hinted.sub && hinted.sub.t >= hinted.text.t + 4, JSON.stringify(hinted));
        ck('phone hint: my own shared item has none (control)', !!mine && mine.hint === null);
        ck('phone hint: the row, the hint and the due time stay inside 390 px', !!hinted && !!hinted.sub && !overflow
            && hinted.row.r <= vw + 0.5 && hinted.sub.r <= hinted.row.r + 0.5 && hinted.when.r <= hinted.row.r + 0.5 && hinted.when.l >= hinted.text.r - 0.5,
            JSON.stringify({ vw, overflow, hinted }));
        ck('phone hint: nothing covers it', await onTop(pg, '.notes-reminder-sub'));
        await shotOf(pg)('hint-phone');
        await pctx.close();
    } catch (e) {
        ck('shared-item hint walk ran', false, String(e).slice(0, 300));
    }
}

// ---- 16. The Android app's own controls, through a fake Capacitor bridge ---------------------------
// Positive control for every web-absence check above: the SAME built page,
// told it runs in the Púca Notes APK, must show the notification banner,
// "At a place", the location toggle and Share — and must hand the native
// side reminder ids and times, never an item's text.
function installFakeAndroid() {
    const calls = [];
    const listeners = {};
    let cb = 0;
    const answers = {
        NotesNative: {
            info: () => ({ api: 1, features: ['reminders', 'backgroundRefresh', 'exactAlarm', 'battery', 'share', 'calendar', 'launchNav'] }),
            syncReminders: o => ({ count: (o.entries || []).length }),
            clearAll: () => ({}),
            setBackgroundRefresh: () => ({ scheduled: true }),
            takeRenewedToken: () => ({ token: null, account: null }),
            notificationStatus: () => ({ granted: false, needsRequest: true, blocked: false }),
            requestNotificationPermission: () => ({ granted: false }),
            openNotificationSettings: () => ({}),
            exactAlarmStatus: () => ({ exact: true }),
            openExactAlarmSettings: () => ({}),
            batteryStatus: () => ({ ignoring: true }),
            requestIgnoreBatteryOptimizations: () => ({}),
            shareText: () => ({ ok: true }),
            addToPhoneCalendar: () => ({ ok: true }),
            consumeLaunchNav: () => ({ target: null }),
            removeListener: () => ({}),
        },
        SovereignLocation: {
            status: () => ({ foreground: false, precise: false, background: false, locationOn: true }),
            requestForegroundPermission: () => ({ granted: false, precise: false }),
            requestBackgroundPermission: () => ({ granted: false }),
            currentPosition: () => ({ lat: 51.5, lon: -0.12, accuracy: 10 }),
            setFences: () => ({}),
            openLocationSettings: () => ({}),
        },
    };
    // Android's WebView has no Notification API; without this the page would
    // also show the BROWSER's "blocked for this site" line, which the app never does.
    try { delete window.Notification; } catch { /* non-configurable: leave it */ }
    window.androidBridge = { postMessage() {} };
    window.Capacitor = {
        PluginHeaders: Object.entries(answers).map(([name, m]) => ({
            name,
            methods: [...Object.keys(m).map(k => ({ name: k, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }],
        })),
        nativePromise(plugin, method, options) {
            calls.push({ plugin, method, options: JSON.parse(JSON.stringify(options ?? {})) });
            const f = answers[plugin] && answers[plugin][method];
            return f ? Promise.resolve(f(options ?? {})) : Promise.reject(new Error(`${plugin}.${method} not faked`));
        },
        nativeCallback(plugin, method, options, callback) {
            const id = String(++cb);
            if (method === 'addListener') (listeners[`${plugin}:${options.eventName}`] ||= []).push(callback);
            return id;
        },
    };
    window.__fakeAndroid = { calls, listeners, answers };
}

try {
    const actx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined, baseURL, storageState: state });
    await actx.addInitScript(installFakeAndroid);
    const a = await actx.newPage();
    watch(a);
    const aErrors = errors.length;
    const taskRows = [];
    a.on('response', async res => {
        if (!/\/task-lists\/\d+\/tasks(\?|$)/.test(res.url())) return;
        try { const j = await res.json(); if (Array.isArray(j)) taskRows.push(...j); } catch { /* not json */ }
    });
    await a.goto('/notes/');
    await a.waitForSelector('.notes-card', { timeout: 20000 });
    ck('android shell: the page believes it is the app (control for the fake bridge itself)',
        await a.evaluate(() => window.Capacitor.getPlatform() === 'android' && window.Capacitor.isPluginAvailable('NotesNative')));
    await a.waitForFunction(() => window.__fakeAndroid.calls.some(c => c.method === 'syncReminders'), null, { timeout: 15000 }).catch(() => {});
    const calls = await a.evaluate(() => window.__fakeAndroid.calls);
    const uid = await a.evaluate(() => JSON.parse(atob(localStorage.getItem('auth_token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub);
    const syncs = calls.filter(c => c.plugin === 'NotesNative' && c.method === 'syncReminders');
    const entries = syncs.length ? syncs[syncs.length - 1].options.entries : [];
    ck('android shell: the reminder feed is handed to the native alarms', syncs.length > 0 && syncs.every(c => c.options.account === String(uid)) && entries.length >= 1,
        JSON.stringify(syncs.map(c => c.options.account)));
    const keysOk = entries.length > 0 && entries.every(e => Object.keys(e).every(k => ['id', 'at', 'mark', 'due'].includes(k)) && typeof e.id === 'number' && typeof e.at === 'number');
    const leaked = JSON.stringify(calls.filter(c => c.method === 'syncReminders' || c.method === 'setBackgroundRefresh')).match(/Eggs|Milk|Bread|Groceries|Shared errand/);
    ck('android shell: native gets ids and times only — no item text (E2EE)', keysOk && !leaked, leaked ? leaked[0] : JSON.stringify(entries[0]));
    const refresh = calls.filter(c => c.method === 'setBackgroundRefresh').pop();
    const pageToken = await a.evaluate(() => localStorage.getItem('auth_token'));
    ck('android shell: the background refresh gets this session', !!refresh && refresh.options.account === String(uid)
        && refresh.options.token === pageToken && /^https?:\/\//.test(refresh.options.apiBase));

    // A saved place on this phone for one open item, then Reminders.
    const open = taskRows.find(t => t && !t.is_completed && typeof t.id === 'number');
    ck('android shell: an open item id was read off the page traffic', !!open, String(taskRows.length));
    await a.evaluate(([uid, id]) => {
        localStorage.setItem(`sovereignTaskPlaces:${uid}`, JSON.stringify([{ id: 'walkplace', label: 'Walk shop', lat: 51.5, lon: -0.12, radiusM: 150 }]));
        localStorage.setItem(`sovereignTaskPlaceAssign:${uid}`, JSON.stringify({ [String(id)]: 'walkplace' }));
    }, [uid, open ? open.id : -1]);
    await a.reload();
    await a.waitForSelector('.notes-card', { timeout: 20000 });
    await a.tap('.notes-menu-btn');
    await a.waitForSelector('.notes-rail.open', { timeout: 5000 });
    await a.locator('.notes-rail-item', { hasText: 'Reminders' }).tap();
    await a.waitForSelector('.notes-reminders', { timeout: 10000 });
    await a.waitForSelector('[data-native-banner]', { timeout: 10000 }).catch(() => {});
    await closedDrawer(a);
    ck('android shell: the notification banner shows (control for "no native status banner")',
        await a.locator('[data-native-banner="enable"]').count() === 1);
    ck('android shell: "At a place" lists the item with its place (control)',
        await a.locator('section[aria-label="At a place"] .notes-reminder-row', { hasText: 'Walk shop' }).count() === 1);
    const btn = await a.evaluate(() => {
        const b = document.querySelector('[data-native-banner="enable"] button');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const bar = b.parentElement.getBoundingClientRect();
        return { w: r.width, h: r.height, right: r.right, barRight: bar.right, clipped: b.scrollWidth > b.clientWidth + 1 };
    });
    ck('android shell (390x844): the banner button holds its label and is a full tap target',
        !!btn && !btn.clipped && btn.right <= btn.barRight + 0.5 && btn.h >= 43.5, JSON.stringify(btn));
    ck('android shell: the banner is not covered', await onTop(a, '[data-native-banner="enable"] button'));
    await shotOf(a)('android-shell-reminders');

    await a.tap('.notes-menu-btn');
    await a.waitForSelector('.notes-rail.open', { timeout: 5000 });
    await a.locator('.notes-rail-item', { hasText: 'Notes' }).first().tap();
    await a.waitForSelector('.notes-card', { timeout: 10000 });
    await a.tap('button[aria-label="Account and settings"]');
    await a.waitForSelector('.notes-menu', { timeout: 5000 });
    await a.waitForSelector('#notes-location', { timeout: 5000 }).catch(() => {});
    ck('android shell: the location-reminders toggle is there (control)', await a.locator('#notes-location').count() === 1);
    ck('android shell: "Share notes…" is there (control)', await a.getByRole('button', { name: /Share notes/ }).count() === 1);
    await a.keyboard.press('Escape');
    await a.waitForSelector('.notes-popover', { state: 'detached', timeout: 5000 }).catch(() => {});

    const card = a.locator('.notes-card', { hasText: 'Groceries' });
    await card.locator('button[aria-label="More actions"]').tap();
    await a.waitForSelector('.context-menu-item', { timeout: 5000 });
    ck('android shell: the card menu offers "Share…" (control)', await a.locator('.context-menu-item', { hasText: 'Share…' }).count() === 1);
    a.once('dialog', d => void d.accept());
    await a.locator('.context-menu-item', { hasText: 'Share…' }).tap();
    await a.waitForFunction(() => window.__fakeAndroid.calls.some(c => c.method === 'shareText'), null, { timeout: 5000 }).catch(() => {});
    const shared = (await a.evaluate(() => window.__fakeAndroid.calls)).filter(c => c.method === 'shareText').pop();
    ck('android shell: Share hands the note to the share sheet as a .md file', !!shared && /^Groceries\.md$/.test(shared.options.filename) && /Bread/.test(shared.options.text),
        shared ? shared.options.filename : 'no shareText call');
    // The other two status lines: notifications on, but exact alarms refused
    // (Android 12-12L lets the user revoke them) and battery-optimised. The
    // native side of those states cannot be produced on an API 36 emulator
    // (USE_EXACT_ALARM is granted at install), so the page's half is walked here.
    await a.evaluate(() => {
        const n = window.__fakeAndroid.answers.NotesNative;
        n.notificationStatus = () => ({ granted: true, needsRequest: false, blocked: false });
        n.exactAlarmStatus = () => ({ exact: false });
        n.batteryStatus = () => ({ ignoring: false });
    });
    await a.tap('.notes-menu-btn');
    await a.waitForSelector('.notes-rail.open', { timeout: 5000 });
    await a.locator('.notes-rail-item', { hasText: 'Reminders' }).tap();
    await a.waitForSelector('[data-native-banner="exact"]', { timeout: 10000 }).catch(() => {});
    await closedDrawer(a);
    const banners = await a.evaluate(() => [...document.querySelectorAll('[data-native-banner]')].map(b => {
        const btn = b.querySelector('button');
        const r = btn ? btn.getBoundingClientRect() : null;
        return { kind: b.getAttribute('data-native-banner'), clipped: btn ? btn.scrollWidth > btn.clientWidth + 1 : null, h: r ? r.height : 0, right: r ? r.right : 0, barRight: b.getBoundingClientRect().right };
    }));
    ck('android shell: exact alarms refused and battery-optimised → both status lines, and no "enable" line',
        JSON.stringify(banners.map(b => b.kind).sort()) === JSON.stringify(['battery', 'exact']), JSON.stringify(banners));
    ck('android shell (390x844): their buttons hold their labels and are full tap targets',
        banners.length === 2 && banners.every(b => b.clipped === false && b.h >= 43.5 && b.right <= b.barRight + 0.5), JSON.stringify(banners));
    await shotOf(a)('android-shell-exact-battery');
    ck('android shell: no page errors', errors.length === aErrors, errors[aErrors]);
    await actx.close();
} catch (e) {
    ck('android-shell walk ran', false, String(e).slice(0, 300));
}

// =============================================================================
// The Notes ANDROID APP's updates, in a faked native shell at 390x844
// =============================================================================
// @capacitor/core treats a page with window.androidBridge as Android and
// routes a plugin call to window.Capacitor.nativePromise when PluginHeaders
// lists it — so answering CapacitorUpdater here stands in for the one native
// plugin the Notes APK carries. Nothing else is faked: every other plugin is
// as absent as it is in the real APK. The manifest comes from page.route.
const nctx = await browser.newContext({ ...iphone, defaultBrowserType: undefined, baseURL, storageState: state });
await nctx.addInitScript(() => {
    const calls = [];
    window.__otaCalls = calls;
    window.androidBridge = { postMessage() {} };
    window.Capacitor = {
        PluginHeaders: [{
            name: 'CapacitorUpdater',
            methods: ['notifyAppReady', 'current', 'download', 'set', 'next', 'reset', 'list', 'delete', 'getLatest', 'getId', 'getPluginVersion', 'removeListener']
                .map(name => ({ name, rtype: 'promise' }))
                // As the real bridge declares it: events arrive through a callback.
                .concat([{ name: 'addListener', rtype: 'callback' }]),
        }],
        nativePromise: async (plugin, method) => {
            calls.push(`${plugin}.${method}`);
            if (method === 'current') return { bundle: { id: 'builtin', version: 'builtin' }, native: '0.9.815' };
            if (method === 'download') return new Promise(() => {});
            return {};
        },
        nativeCallback: () => 'cb',
    };
});
const nativeChecks = [];
let manifest = null;
await nctx.route('**/api/mobile-updates/check**', route => {
    nativeChecks.push(route.request().url());
    return manifest
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) })
        : route.fulfill({ status: 404, body: '' });
});
const nm = await nctx.newPage();
watch(nm);
const nshot = shotOf(nm);
const gateAudit = () => nm.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    // At least one must be SHOWN: "every one of none is inside" passed when
    // the thing under test was not on screen at all.
    const within = sel => { const els = [...document.querySelectorAll(sel)].filter(vis); return els.length > 0 && els.every(el => { const r = el.getBoundingClientRect(); return r.left >= -0.5 && r.right <= vw + 0.5 && r.top >= -0.5 && r.bottom <= vh + 0.5; }); };
    const small = [...document.querySelectorAll('.notes-update-gate button, .notes-update-strip button')].filter(vis)
        .map(b => b.getBoundingClientRect()).filter(r => r.width < 43.5 || r.height < 43.5).map(r => `${Math.round(r.width)}x${Math.round(r.height)}`);
    return { overflow: document.documentElement.scrollWidth > vw + 1, small,
        gateInside: within('.notes-update-gate-content'), stripInside: within('.notes-update-strip') };
});

// 1. A bundle that needs a newer APK: NOT downloaded, the install screen says why.
manifest = {
    version: '99.0.0', variant: 'notes', url: 'https://download.example.com/mobile/puca-notes-web-99.0.0.enc.zip',
    sessionKey: 'x:y', checksum: 'ab', native: { min: '99.0.0', version: '99.0.0' },
};
await nm.goto('/notes/');
await nm.waitForSelector('.notes-update-gate', { timeout: 20000 });
ck('app: the update check asks ?variant=notes', nativeChecks.some(u => u.includes('variant=notes')), JSON.stringify(nativeChecks));
ck('app: the running bundle is blessed first thing (notifyAppReady)', (await nm.evaluate(() => window.__otaCalls)).includes('CapacitorUpdater.notifyAppReady'));
ck('app: native.min newer than the APK → the install-the-new-app screen', /Install the new Púca Notes app/.test(await nm.locator('.notes-update-gate').innerText()));
ck('app: …and the bundle is NOT downloaded', !(await nm.evaluate(() => window.__otaCalls)).includes('CapacitorUpdater.download'));
let g = await gateAudit();
await nshot('app-needs-new-apk');
ck('app: install screen fits the phone, no overflow', g.gateInside && !g.overflow, JSON.stringify(g));
ck('app: install screen buttons at size', g.small.length === 0, JSON.stringify(g.small));
await nm.getByRole('button', { name: 'Continue', exact: true }).tap();
await nm.waitForSelector('.notes-card', { timeout: 20000 });
ck('app: Continue runs the app on the bundle it has', await nm.locator('.notes-update-gate').count() === 0);
ck('app: the strip keeps saying why', /needs Púca Notes 99\.0\.0/.test(await nm.locator('.notes-update-strip').innerText()));
g = await gateAudit();
await nshot('app-strip');
ck('app: strip inside the viewport, buttons at size', g.stripInside && g.small.length === 0 && !g.overflow, JSON.stringify(g));
// The strip is its own row BELOW the top bar. It used to lie over the top of
// the app and cover the account button — the way to "Check for updates" — and
// a 'required' strip comes back for every new version.
const lay = await nm.evaluate(() => {
    const s = document.querySelector('.notes-update-strip')?.getBoundingClientRect();
    const t = document.querySelector('.notes-topbar')?.getBoundingClientRect();
    const a = document.querySelector('button[aria-label="Account and settings"]');
    const ar = a?.getBoundingClientRect();
    const hit = ar ? document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2) : null;
    return { strip: s ? { top: s.top, bottom: s.bottom } : null, topbarBottom: t ? t.bottom : null, accountOnTop: !!(a && hit && (hit === a || a.contains(hit))) };
});
ck('app: the strip sits below the top bar, not over it', !!lay.strip && lay.topbarBottom !== null && lay.strip.top >= lay.topbarBottom - 0.5, JSON.stringify(lay));
ck('app: nothing covers the account button while the strip shows', lay.accountOnTop, JSON.stringify(lay));
let menuWithStrip = 'the account button could not be tapped';
try {
    await nm.tap('button[aria-label="Account and settings"]', { timeout: 5000 });
    await nm.waitForSelector('.notes-menu', { timeout: 5000 });
    menuWithStrip = await nm.locator('.notes-update-strip').count() === 1 ? '' : 'the menu opened but the strip was gone';
} catch (e) {
    menuWithStrip += `: ${String(e).split('\n')[0]}`;
}
ck('app: the account menu opens with a tap WHILE the strip shows', menuWithStrip === '', menuWithStrip);
await nm.keyboard.press('Escape');
await nm.waitForSelector('.notes-popover', { state: 'detached', timeout: 5000 }).catch(() => {});

// 2. The account menu: version + Check for updates, which re-runs the check
//    without unmounting the app.
await nm.tap('.notes-update-strip-close');
ck('app: the strip dismisses', await nm.locator('.notes-update-strip').count() === 0);
await nm.tap('button[aria-label="Account and settings"]');
await nm.waitForSelector('.notes-menu', { timeout: 5000 });
ck('app: the account menu shows the running version', /\S/.test(await nm.locator('[data-testid="notes-app-version"]').innerText()));
await nshot('app-account-menu');
manifest = null;   // nothing published now
const before = nativeChecks.length;
await nm.getByRole('button', { name: 'Check for updates' }).tap();
await nm.waitForSelector('.notes-menu [role="status"]', { timeout: 20000 });
ck('app: Check for updates asks again and reports', nativeChecks.length === before + 1 && /up to date/.test(await nm.locator('.notes-menu [role="status"]').innerText()),
    `${nativeChecks.length - before} check(s): ${await nm.locator('.notes-menu [role="status"]').innerText()}`);
ck('app: …without leaving the app', await nm.locator('.notes-card').count() >= 1 && await nm.locator('.notes-update-gate').count() === 0);
await nm.keyboard.press('Escape');

// 3. POSITIVE CONTROL for the refusals: Púca's full manifest (what an old
//    server answers on ?variant=notes) is not applied either — but a tagged,
//    current-APK manifest IS downloaded, so the refusals above are not a gate
//    that refuses everything.
manifest = { version: '99.0.0', url: 'https://download.example.com/mobile/puca-web-99.0.0.enc.zip', sessionKey: 'x:y', checksum: 'ab', variant: 'full' };
await nm.reload();
await nm.waitForSelector('.notes-card', { timeout: 20000 });
ck('app: Púca\'s full manifest is refused (no download)', !(await nm.evaluate(() => window.__otaCalls)).includes('CapacitorUpdater.download'));
manifest = { version: '99.0.0', url: `${new URL(nativeChecks[0]).origin.replace(/^http:/, 'https:')}/b.enc.zip`, sessionKey: 'x:y', checksum: 'ab', variant: 'notes' };
await nm.reload();
await nm.waitForSelector('.notes-update-gate', { timeout: 20000 }).catch(() => {});
const applied = (await nm.evaluate(() => window.__otaCalls)).includes('CapacitorUpdater.download');
ck('app: a tagged Notes manifest IS downloaded (positive control)', applied, JSON.stringify(await nm.evaluate(() => window.__otaCalls)));
if (applied) {
    g = await gateAudit();
    await nshot('app-downloading');
    ck('app: the downloading screen fits the phone', g.gateInside && !g.overflow, JSON.stringify(g));
}
ck('app: no page errors', errors.length === 0, errors[0]);

await browser.close();
console.log(fail === 0 ? `\nALL PASS${skipped ? ` (${skipped} section(s) SKIPPED: give the psql DSN to run them)` : ''}` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
