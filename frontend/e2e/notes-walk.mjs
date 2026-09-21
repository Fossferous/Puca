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
// move-to-trash with undo, the Trash view (restore, delete forever); text
// notes, photo notes and drawing notes (sealed on the server — the database
// check reads the stored envelope); the text shown AND edited in Púca's own
// Tasks view; a Notes sign-out lands the main app's tab on its login
// (sessionSync); a plaintext row injected in the database is flagged "Not
// encrypted"; live updates reach a second device, colour and labels sync
// (and survive a sign-out), bulk selection works by Ctrl-click and by long
// press, the /notes/ worker plus the sealed cache open Notes offline and an
// offline edit replays when the network returns; and on the phone — one
// column, no horizontal overflow, every
// tap target at size, 16px inputs, the FAB composer, the drawer, a popover
// inside the viewport, the full-screen editor with the grip and arrows.
// And the Notes Android app's updates (NotesUpdateGate): in the browser no
// update check is ever made and the menu has no update rows; inside a FAKED
// native shell (the updater plugin answered in-page, the manifest answered by
// page.route) a bundle that needs a newer APK is not downloaded, the "install
// the new app" screen and the strip fit the phone, the strip takes its own
// row below the top bar with the account button still tappable, and the
// account menu shows the version and a working Check for updates.
// Then the calendar (notes-walk-calendar.mjs): Dublin/en-GB and New York/en-US
// with a fixed clock beside a DST change, and the phone gate.
//
// Every check is ck(): a precondition that did not happen (nothing to measure,
// an element not found) is a FAIL line, never a silent pass, and any FAIL
// makes the walk exit 1.
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
import { calendarWalk } from './notes-walk-calendar.mjs';

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
// A real (tiny) PNG for the photo note: 8x8, opaque red.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64');
const password = 'Password123!';

let fail = 0;
const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };
/** A check that could not run (its precondition is missing): printed, never a PASS. */
let skipped = 0;
const skip = (n, why) => { console.log(`SKIP  ${n}${why ? `  — ${why}` : ''}`); skipped++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--mute-audio'] });   // a walk never makes a sound
const errors = [];
const watch = page => {
    // Accept a confirm (Delete forever, Empty trash) that nothing else is
    // waiting for. A section that listens for its own question (the sign-out
    // guards) answers it alone: answering twice throws.
    page.on('dialog', d => { if (page.listenerCount('dialog') > 1) return; d.accept().catch(() => {}); });
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

/** Open the inline composer and wait for it to settle: it focuses its first
 *  item on the next animation frame, and a fill that starts before that
 *  lands half in the title and half in the item (a walk race, not a product
 *  bug — a person does not type within one frame of the click). */
const openComposerOn = page => async () => {
    await page.click('.notes-quickadd-collapsed');
    await page.waitForFunction(() => document.activeElement?.closest('.notes-quickadd-item') != null, null, { timeout: 5000 }).catch(() => {});
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
const openComposer = openComposerOn(page);

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
const notesCreatedAt = Date.now();
await openComposer();
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

// ---- 4b. Text, photo and drawing notes -----------------------------------------------
await openComposer();
await page.fill('.notes-quickadd-title', 'Poem');
await page.click('.notes-quickadd-foot button[aria-label="Text note"]');
await page.fill('.notes-quickadd-body', 'Roses are red\nViolets are blue');
await page.getByRole('button', { name: 'Done' }).click();
const poem = () => page.locator('.notes-card', { hasText: 'Poem' });
await page.waitForSelector('.notes-card:has-text("Poem") .notes-card-body', { timeout: 15000 });
ck('text note: the card shows the text, not "Empty note"', /Roses are red/.test(await poem().locator('.notes-card-body').innerText()) && await poem().locator('.notes-card-empty').count() === 0);

await openComposer();
await page.fill('.notes-quickadd-title', 'Holiday photo');
await page.locator('.notes-quickadd-foot input[type="file"]').first().setInputFiles({ name: 'beach.png', mimeType: 'image/png', buffer: PNG });
await page.waitForSelector('.notes-quickadd-media img', { timeout: 5000 });
ck('photo note: the picked photo previews in the composer', true);
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.notes-card')].some(c => c.textContent.includes('Holiday photo') && c.querySelector('.notes-card-hero img[src^="blob:"]')?.naturalWidth > 0), null, { timeout: 20000 })
    .then(() => ck('photo note: the card leads with the decrypted photo', true))
    .catch(() => ck('photo note: the card leads with the decrypted photo', false));

await openComposer();
await page.fill('.notes-quickadd-title', 'Sketch');
await page.click('.notes-quickadd-foot button[aria-label="Draw"]');
await page.waitForSelector('.notes-draw-canvas', { timeout: 5000 });
const cb = await page.locator('.notes-draw-canvas').boundingBox();
await page.mouse.move(cb.x + cb.width * 0.2, cb.y + cb.height * 0.3);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(cb.x + cb.width * (0.2 + i * 0.05), cb.y + cb.height * (0.3 + i * 0.03));
await page.mouse.up();
await shot('drawing-editor');
await page.getByRole('button', { name: 'Save drawing' }).click();
await page.waitForSelector('.notes-draw-canvas', { state: 'detached', timeout: 5000 });
ck('drawing: saving returns to the composer with the drawing attached', await page.locator('.notes-quickadd-media img').count() === 1);
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForFunction(() => [...document.querySelectorAll('.notes-card')].some(c => c.textContent.includes('Sketch') && c.querySelector('.notes-card-hero img.drawing[src^="blob:"]')), null, { timeout: 20000 })
    .then(() => ck('drawing note: the card shows the drawing', true))
    .catch(() => ck('drawing note: the card shows the drawing', false));
// Reopen it: the strokes come back into the editor (the canvas is not blank).
await page.locator('.notes-card', { hasText: 'Sketch' }).click();
await page.waitForSelector('.notes-editor .ni-item.drawing button[aria-label="Edit drawing"]', { timeout: 15000 });
await page.click('.notes-editor .ni-item.drawing button[aria-label="Edit drawing"]');
await page.waitForSelector('.notes-draw-canvas', { timeout: 10000 });
await sleep(300);
const inked = await page.evaluate(() => {
    const c = document.querySelector('.notes-draw-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 128 && d[i + 1] < 128 && d[i + 2] < 128) dark++;
    return dark;
});
ck('drawing: reopening restores the strokes for editing', inked > 50, `dark samples=${inked}`);
await page.getByRole('button', { name: 'Cancel' }).click();
await page.waitForSelector('.notes-draw-canvas', { state: 'detached', timeout: 5000 });
await page.getByRole('button', { name: 'Close', exact: true }).click();
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
await shot('text-photo-drawing-cards');

// ---- 5. The editor is Púca's TaskTree ----------------------------------------------
await page.locator('.notes-card', { hasText: 'Groceries' }).click();
await page.waitForSelector('.notes-editor .task-tree', { timeout: 15000 });
ck('editor: three TaskTree rows', await page.locator('.notes-editor .tt-item').count() === 3);
// The note's own text, above its items; it saves itself.
await page.fill('.notes-editor-content textarea.nb-text', 'Buy before Friday');
await sleep(1500);
ck('editor: note text saves without a button', await page.locator('.notes-editor .nb-status.failed').count() === 0);
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
const groceries = () => page.locator('.notes-card', { hasText: 'Groceries' });
ck('card: shows the label chip and progress', /Errands/.test(await groceries().locator('.notes-card-foot').innerText()) && /1\/5/.test(await groceries().locator('.notes-card-foot').innerText()));
ck('card: shows the note text above the items', /Buy before Friday/.test(await groceries().locator('.notes-card-body').innerText()));
ck('rail: the label appears', await page.locator('.notes-rail-item', { hasText: 'Errands' }).count() === 1);
await page.locator('.notes-rail-item', { hasText: 'Errands' }).click();
await page.waitForSelector('h1.notes-section-title', { timeout: 5000 });
// textContent, not innerText: the heading is CSS-uppercased and innerText returns the rendered case.
ck('label view: filtered heading + the one card', /Label: Errands/.test(await page.locator('h1.notes-section-title').textContent()) && await page.locator('.notes-card').count() === 1);
// Text ⇄ checklist on the text note, both ways.
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();
await poem().click();
await page.waitForSelector('.notes-editor .notes-convert-row', { timeout: 10000 });
await page.getByRole('button', { name: 'Show checkboxes' }).click();
await page.waitForFunction(() => document.querySelectorAll('.notes-editor .tt-item').length === 2, null, { timeout: 10000 })
    .then(() => ck('show checkboxes: each line became an item', true))
    .catch(() => ck('show checkboxes: each line became an item', false));
await page.waitForFunction(() => document.querySelector('.notes-editor textarea.nb-text')?.value === '', null, { timeout: 10000 }).catch(() => {});
ck('show checkboxes: the text moved out of the text field', (await page.locator('.notes-editor textarea.nb-text').inputValue()) === '');
await page.getByRole('button', { name: 'Hide checkboxes' }).click();
await page.waitForFunction(() => document.querySelectorAll('.notes-editor .tt-item').length === 0 && document.querySelector('.notes-editor textarea.nb-text')?.value !== '', null, { timeout: 10000 }).catch(() => {});
ck('hide checkboxes: the items became lines of text again', (await page.locator('.notes-editor textarea.nb-text').inputValue()) === 'Roses are red\nViolets are blue');
await page.getByRole('button', { name: 'Close', exact: true }).click();
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();

// ---- 7. Pin ------------------------------------------------------------------------------------
await groceries().hover();
await groceries().locator('.notes-card-pin').click();
await page.waitForSelector('section[aria-label="Pinned notes"]', { timeout: 10000 });
ck('pin: the card moves to the Pinned section', await page.locator('section[aria-label="Pinned notes"] .notes-card').count() === 1);
// Keyboard: Enter on a control INSIDE the card activates that control (unpin),
// it must not open the note.
await groceries().locator('.notes-card-pin').focus();
await page.keyboard.press('Enter');
await page.waitForSelector('section[aria-label="Pinned notes"]', { state: 'detached', timeout: 10000 }).catch(() => {});
ck('keyboard: Enter on the pin button unpins and does NOT open the editor',
    await page.locator('section[aria-label="Pinned notes"]').count() === 0 && await page.locator('.notes-editor').count() === 0);
await groceries().locator('.notes-card-pin').focus();
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
await openComposer();
await page.fill('.notes-quickadd-title', 'Packing');
await page.locator('.notes-quickadd-item input').first().fill('Socks');
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForFunction(() => document.querySelectorAll('.notes-card').length === 5, null, { timeout: 15000 });
await openComposer();
await page.fill('.notes-quickadd-title', 'Reading');
await page.locator('.notes-quickadd-item input').first().fill('Dune');
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForFunction(() => document.querySelectorAll('.notes-card').length === 6, null, { timeout: 15000 });
const othersTitles = async () => (await page.locator('section[aria-label="Other notes"] .notes-card-title').allInnerTexts()).map(t => t.trim());
ck('others: natural order Poem, Holiday photo, Sketch, Packing, Reading', (await othersTitles()).join(',') === 'Poem,Holiday photo,Sketch,Packing,Reading', (await othersTitles()).join(','));
await page.locator('.notes-card', { hasText: 'Reading' }).hover();
await page.locator('.notes-card', { hasText: 'Reading' }).locator('button[aria-label="More actions"]').click();
await page.waitForSelector('.context-menu', { timeout: 5000 });
await page.locator('.context-menu-item', { hasText: 'Move to top' }).click();
await sleep(400);
ck('move: "Move to top" reorders the others (and never touches the pinned one)', (await othersTitles()).join(',') === 'Reading,Poem,Holiday photo,Sketch,Packing' && await page.locator('section[aria-label="Pinned notes"] .notes-card').count() === 1);
await shot('three-cards');
// Move to bottom — the model has had the branch since ordering landed; until
// now the menu stopped at 'Move down', so sending a note 200 places took 199
// menu invocations.
await page.locator('.notes-card', { hasText: 'Poem' }).hover();
await page.locator('.notes-card', { hasText: 'Poem' }).locator('button[aria-label="More actions"]').click();
await page.waitForSelector('.context-menu', { timeout: 5000 });
await page.locator('.context-menu-item', { hasText: 'Move to bottom' }).click();
await sleep(400);
ck('move: "Move to bottom" sends the note to the end of the others',
    (await othersTitles()).join(',') === 'Reading,Holiday photo,Sketch,Packing,Poem', (await othersTitles()).join(','));
ck('move: the pinned section is untouched by a bottom move', await page.locator('section[aria-label="Pinned notes"] .notes-card').count() === 1);

// Drag to reorder, in LIST view (one column — masonry has no one-axis order).
ck('grid view (fine pointer): no drag grips, masonry is two-dimensional', await page.locator('.notes-card-grip').count() === 0);
await page.click('button[aria-label="Switch to list view"]');
await page.waitForSelector('.notes-grid.list', { timeout: 5000 });
ck('list view: every card shows a drag grip',
    await page.locator('.notes-grid.list .notes-card-grip').count() === await page.locator('.notes-grid.list .notes-card').count()
    && await page.locator('.notes-card-grip').count() > 1);
// A real Pointer Events drag: press the grip, move past the third card's
// midpoint in steps, release. Playwright's drag helpers do not drive this.
const otherCard = i => page.locator('section[aria-label="Other notes"] .notes-card').nth(i);
const gripBox = await otherCard(0).locator('.notes-card-grip').boundingBox();
const thirdBox = await otherCard(2).boundingBox();
let indicatorSeen = false;
if (gripBox && thirdBox) {
    const gx = gripBox.x + gripBox.width / 2;
    const gy = gripBox.y + gripBox.height / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    const targetY = thirdBox.y + thirdBox.height * 0.75;
    for (let i = 1; i <= 10; i++) {
        await page.mouse.move(gx, gy + (targetY - gy) * (i / 10));
        await sleep(20);
    }
    indicatorSeen = await page.locator('.notes-grid-drop-indicator').count() === 1;
    await page.mouse.up();
    await sleep(600);
}
ck('drag: the insertion line appears while dragging', indicatorSeen);
ck('drag: dropping a card lower down reorders the others',
    (await othersTitles()).join(',') === 'Holiday photo,Sketch,Reading,Packing,Poem', (await othersTitles()).join(','));
ck('drag: the drop did not open the note (the ghost click is swallowed)', await page.locator('.notes-editor').count() === 0);
ck('drag: the pinned card kept its section', await page.locator('section[aria-label="Pinned notes"] .notes-card').count() === 1);
await shot('list-drag');
// The order must have REACHED task_tab_prefs, not just the local cache.
await page.reload();
await page.waitForSelector('.notes-card', { timeout: 20000 });
await sleep(1000);
ck('drag: the new order survived a reload (it reached the saved tab order)',
    (await othersTitles()).join(',') === 'Holiday photo,Sketch,Reading,Packing,Poem', (await othersTitles()).join(','));
await page.fill('.notes-search input', 'a');
await sleep(300);
ck('drag: a search removes the grips (a result is not a section of the order)', await page.locator('.notes-card-grip').count() === 0);
await page.click('button[aria-label="Clear search"]');
await sleep(200);
await page.click('button[aria-label="Switch to grid view"]');
await page.waitForSelector('.notes-grid:not(.list)', { timeout: 5000 });

await page.fill('.notes-search input', 'bread');
await sleep(300);
ck('search: matches an item inside a note', await page.locator('.notes-card').count() === 1 && /Groceries/.test(await page.locator('.notes-card-title').first().innerText()));
await page.fill('.notes-search input', 'violets');
await sleep(300);
ck('search: matches a note\'s text', await page.locator('.notes-card').count() === 1 && /Poem/.test(await page.locator('.notes-card-title').first().innerText()));
await page.fill('.notes-search input', 'zzzz');
await sleep(300);
ck('search: no match shows the empty state', await page.locator('.notes-empty').count() === 1);
await page.click('button[aria-label="Clear search"]');
await sleep(200);
ck('search: cleared', await page.locator('.notes-card').count() === 6);

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

// ---- 10b. Edit labels: rename, merge, delete everywhere --------------------------------------------
// The POINT of this dialog is the note no other surface can reach: Packing is
// archived now, and a label view excludes archived notes (filterNotes), so a
// label stuck on it could not be renamed from the grid or the selection bar.
// Label it here first, then prove the rename followed it.
await page.locator('.notes-rail-item', { hasText: 'Archive' }).click();
await sleep(300);
await packing().click();
await page.waitForSelector('.notes-editor-foot', { timeout: 10000 });
await page.click('.notes-editor-foot button[aria-label="Labels"]');
await page.waitForSelector('.notes-labels-new input', { timeout: 5000 });
await page.fill('.notes-labels-new input', 'Trip');
await page.press('.notes-labels-new input', 'Enter');
await sleep(200);
await page.keyboard.press('Escape');
await page.locator('.notes-editor-foot').getByRole('button', { name: 'Close', exact: true }).click();
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();
await sleep(300);

ck('rail: the Labels heading offers Edit labels', await page.locator('.notes-rail button[aria-label="Edit labels"]').count() === 1);
const openLabelMgr = async () => {
    await page.click('.notes-rail button[aria-label="Edit labels"]');
    await page.waitForSelector('.notes-labelmgr-row', { timeout: 5000 });
};
const mgrRows = () => page.locator('.notes-labelmgr-row').allInnerTexts();
const mgrText = async () => (await mgrRows()).join(' | ');
await openLabelMgr();
// Trip is on an ARCHIVED note only — it is listed, and counted, here alone.
ck('label manager: lists every label with its note count, archived included',
    /Errands/.test(await mgrText()) && /Trip/.test(await mgrText())
    && (await mgrRows()).filter(t => /1 note(?!s)/.test(t)).length >= 2,
    await mgrText());
await page.click('.notes-labelmgr-row button[aria-label="Rename Errands"]');
await page.fill('.notes-labelmgr-row.editing input', 'Chores');
await page.press('.notes-labelmgr-row.editing input', 'Enter');
await sleep(300);
ck('label manager: a rename rewrites the card chip',
    await page.locator('.notes-card', { hasText: 'Groceries' }).locator('.notes-chip', { hasText: 'Chores' }).count() === 1);
ck('label manager: a rename rewrites the rail',
    await page.locator('.notes-rail-item', { hasText: 'Chores' }).count() === 1
    && await page.locator('.notes-rail-item', { hasText: 'Errands' }).count() === 0);
ck('label manager: a rename offers an Undo', await page.locator('.notes-undo-text:has-text("Renamed")').count() === 1);
// Merge: rename Trip onto Chores. It must ASK first, and must not have written.
await page.click('.notes-labelmgr-row button[aria-label="Rename Trip"]');
await page.fill('.notes-labelmgr-row.editing input', 'chores');
await page.press('.notes-labelmgr-row.editing input', 'Enter');
await sleep(200);
ck('label manager: merging asks first', /Merge into/.test(await mgrText()), await mgrText());
ck('label manager: the merge has not happened yet', await page.locator('.notes-rail-item', { hasText: 'Trip' }).count() === 1);
await page.locator('.notes-labelmgr-row.confirm button', { hasText: 'Merge' }).click();
await sleep(300);
ck('label manager: merging leaves one label and one rail row',
    await page.locator('.notes-rail-item', { hasText: 'Chores' }).count() === 1
    && await page.locator('.notes-rail-item', { hasText: 'Trip' }).count() === 0);
await shot('label-manager');
// Delete everywhere, then Undo. The archived note is the one to watch.
await page.click('.notes-labelmgr-row button[aria-label="Delete Chores"]');
await sleep(150);
ck('label manager: deleting asks first', /Remove/.test(await mgrText()), await mgrText());
await page.locator('.notes-labelmgr-row.confirm button', { hasText: 'Remove' }).click();
await sleep(300);
ck('label manager: deleting removes the rail row and every chip',
    await page.locator('.notes-rail-item', { hasText: 'Chores' }).count() === 0
    && await page.locator('.notes-chip', { hasText: 'Chores' }).count() === 0);
await page.locator('.notes-undo button').click();
await sleep(400);
ck('label manager: Undo brings the label back on every note',
    await page.locator('.notes-card', { hasText: 'Groceries' }).locator('.notes-chip', { hasText: 'Chores' }).count() === 1);
await page.keyboard.press('Escape');
await sleep(200);
ck('label manager: Escape closes the dialog', await page.locator('.notes-labelmgr-row').count() === 0);
// The open label VIEW must follow a rename, or the grid empties under a stale heading.
await page.locator('.notes-rail-item', { hasText: 'Chores' }).click();
await page.waitForSelector('h1.notes-section-title', { timeout: 5000 });
await openLabelMgr();
await page.click('.notes-labelmgr-row button[aria-label="Rename Chores"]');
await page.fill('.notes-labelmgr-row.editing input', 'Errands');
await page.press('.notes-labelmgr-row.editing input', 'Enter');
await sleep(400);
ck('label manager: the open label view follows the rename',
    /Label: Errands/.test(await page.locator('h1.notes-section-title').textContent())
    && await page.locator('.notes-card').count() >= 1,
    await page.locator('h1.notes-section-title').textContent());
await page.keyboard.press('Escape');
await sleep(200);
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();
await sleep(300);

// ---- 11. Move to trash with undo (the server keeps it restorable) ------------------------------------
const reading = () => page.locator('.notes-card', { hasText: 'Reading' });
await reading().hover();
await reading().locator('button[aria-label="More actions"]').click();
await page.locator('.context-menu-item', { hasText: 'Move to trash' }).click();
// The archive step's undo bar may still be up; wait for THIS one.
await page.waitForSelector('.notes-undo-text:has-text("to the trash")', { timeout: 5000 });
ck('trash: hidden at once, undo offered', await reading().count() === 0 && /trash/.test(await page.locator('.notes-undo-text').innerText()));
await page.locator('.notes-undo button').click();
await sleep(600);
ck('trash: Undo restores it', await reading().count() === 1);
await reading().hover();
await reading().locator('button[aria-label="More actions"]').click();
await page.locator('.context-menu-item', { hasText: 'Move to trash' }).click();
await page.waitForSelector('.notes-undo', { timeout: 5000 });
await page.waitForSelector('.notes-undo', { state: 'detached', timeout: 12000 });
await page.keyboard.press('r');   // refresh from the server
await sleep(1500);
ck('trash: gone from the notes after the undo window', await reading().count() === 0);
await shot('after-trash');

// ---- 11b. The Trash view: restore, then delete forever ---------------------------------------------------
await page.locator('.notes-rail-item', { hasText: 'Trash' }).click();
await page.waitForSelector('.notes-trash-row', { timeout: 10000 });
ck('trash view: the note is listed with its purge date', await page.locator('.notes-trash-row', { hasText: 'Reading' }).count() === 1 && /deleted forever/.test(await page.locator('.notes-trash-row').first().innerText()));
ck('trash view: says how long the server keeps trash', /deleted forever after 30 days/.test(await page.locator('.notes-trash-copy').innerText()));
await shot('trash-view');
await page.locator('.notes-trash-row', { hasText: 'Reading' }).getByRole('button', { name: 'Restore' }).click();
await page.waitForSelector('.notes-trash-row', { state: 'detached', timeout: 10000 }).catch(() => {});
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();
await page.waitForSelector('.notes-card:has-text("Reading")', { timeout: 10000 })
    .then(() => ck('trash view: Restore brings the note back', true))
    .catch(() => ck('trash view: Restore brings the note back', false));
await reading().hover();
await reading().locator('button[aria-label="More actions"]').click();
await page.locator('.context-menu-item', { hasText: 'Move to trash' }).click();
await page.waitForSelector('.notes-undo', { timeout: 5000 });
await page.locator('.notes-rail-item', { hasText: 'Trash' }).click();
await page.waitForSelector('.notes-trash-row:has-text("Reading")', { timeout: 10000 });
await page.locator('.notes-trash-row', { hasText: 'Reading' }).getByRole('button', { name: 'Delete forever' }).click();
await page.waitForSelector('.notes-trash-row', { state: 'detached', timeout: 10000 }).catch(() => {});
ck('trash view: Delete forever empties it', await page.locator('.notes-trash-row').count() === 0 && await page.locator('.notes-trash .notes-empty').count() === 1);
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();

// ---- 12. Server-side truth via the database ----------------------------------------------------------
if (psqlDsn) {
    try {
        // Scoped to THIS run's user: the throwaway database accumulates a user
        // per run, and MIN(id) over everything would tamper with somebody else's row.
        const mine = `SELECT l.id FROM task_lists l JOIN users u ON u.id = l.owner_id WHERE u.username = '${username}'`;
        const lists = sql(`SELECT count(*) FROM (${mine}) x`);
        ck('database: the note deleted forever is gone from the server (5 lists remain)', lists === '5', lists);
        const trashedRows = sql(`SELECT count(*) FROM task_lists WHERE id IN (${mine}) AND trashed_at IS NOT NULL`);
        ck('database: nothing left in the trash', trashedRows === '0', trashedRows);
        // E2EE: the note text and the photo/drawing refs are envelopes; the words are nowhere.
        const bodies = sql(`SELECT string_agg(coalesce(body,'') || '|' || coalesce(attachments,''), E'\n') FROM task_lists WHERE id IN (${mine})`);
        ck('database: note text is stored sealed', /"t":"self"/.test(bodies) && !/Roses|Violets|Friday|beach\.png|drawing-1/.test(bodies), bodies.slice(0, 120));
        const nonEnvelope = sql(`SELECT count(*) FROM task_lists WHERE id IN (${mine}) AND ((body IS NOT NULL AND body NOT LIKE '{%') OR (attachments IS NOT NULL AND attachments NOT LIKE '{%'))`);
        ck('database: no note text or sidecar is anything but an envelope', nonEnvelope === '0', nonEnvelope);
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
    skip('database: server-side truth (deleted note gone, injected plaintext flagged)', 'no psql DSN given');
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
const webGroceries = page.locator('.notes-card', { hasText: 'Groceries' });
await webGroceries.hover();
await webGroceries.locator('button[aria-label="More actions"]').click();
await page.waitForSelector('.context-menu-item', { timeout: 5000 });
ck('web card menu: "Copy as text" is there, "Share…" is not',
    await page.locator('.context-menu-item', { hasText: 'Copy as text' }).count() === 1
    && await page.locator('.context-menu-item', { hasText: 'Share…' }).count() === 0);
await page.keyboard.press('Escape');
await sleep(200);
// ---- 12c. Púca's own Tasks view: the same note text, read AND edited there ----------------------------
await page.goto('/chat');
await page.waitForSelector('.chat-container', { timeout: 20000 });
try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* no popup */ }
await page.click('.server-icon.home-button');
await page.locator('.sidebar-nav .nav-item', { hasText: 'Tasks' }).click();
await page.waitForSelector('.tasks-tabbar', { timeout: 15000 });
await page.waitForSelector('.checklist-card:has-text("Poem") .tasks-card-body', { timeout: 10000 }).catch(() => {});
ck('púca: the board card shows a text note\'s text', /Roses are red/.test(await page.locator('.checklist-card', { hasText: 'Poem' }).locator('.tasks-card-body').innerText().catch(() => '')));
ck('púca: the board card says a photo note has a picture', /1 picture/.test(await page.locator('.checklist-card', { hasText: 'Holiday photo' }).locator('.tasks-card-body').innerText().catch(() => '')));
await page.locator('.tasks-tab', { hasText: 'Poem' }).click();
await page.waitForSelector('.list-content-block textarea.nb-text', { timeout: 10000 });
ck('púca: the list editor shows the note text', /Roses are red/.test(await page.locator('.list-content-block textarea.nb-text').inputValue()));
await page.fill('.list-content-block textarea.nb-text', 'Roses are red\nViolets are blue\nEdited in Púca');
await sleep(1500);
await page.locator('.tasks-tab', { hasText: 'Holiday photo' }).click();
await page.waitForFunction(() => document.querySelector('.list-content-block .ni-open img')?.naturalWidth > 0, null, { timeout: 15000 })
    .then(() => ck('púca: a photo note shows its photo', true))
    .catch(() => ck('púca: a photo note shows its photo', false));
await shot('puca-tasks-photo-note');
// Move to trash from Púca: the list leaves the bar and the Trash section offers it back.
await page.locator('.tasks-tab', { hasText: 'Packing' }).click({ button: 'right' });
await page.locator('.context-menu-item', { hasText: 'Move to trash' }).click();
await page.waitForFunction(() => ![...document.querySelectorAll('.tasks-tab')].some(t => t.textContent.includes('Packing')), null, { timeout: 10000 }).catch(() => {});
await page.locator('.tasks-tab-all').click();
await page.waitForSelector('.tasks-trash-toggle', { timeout: 10000 });
await page.click('.tasks-trash-toggle');
ck('púca: the trashed list is in the Trash section', await page.locator('.tasks-trash-row', { hasText: 'Packing' }).count() === 1);
await shot('puca-tasks-trash');
// Notes loads (and runs its device-local prune) WHILE Púca holds Packing in the
// trash — so the archive-flag check after the restore below can fail: a prune
// that took the trashed note for deleted would erase the flag right here.
const np = await ctx.newPage();
watch(np);
await np.goto('/notes/#/trash');
const packingInNotesTrash = await np.waitForSelector('.notes-trash-row:has-text("Packing")', { timeout: 15000 }).then(() => true).catch(() => false);
await np.waitForSelector('.notes-rail-item', { timeout: 5000 }).catch(() => {});
await sleep(1500);   // the prune (and any fresh read of the trash it asks for) settles
const archivedWhileTrashed = await np.locator('.notes-rail-item', { hasText: 'Archive' }).locator('.notes-rail-count').innerText().catch(() => '?');
ck('notes (second tab): opened while Púca holds Packing in the trash — it is in the Notes trash, not counted as archived', packingInNotesTrash && archivedWhileTrashed === '0', `inTrash=${packingInNotesTrash} archived=${archivedWhileTrashed}`);
await np.close();
// Púca asks, 3 s after it mounts, about a recovery code generated at sign-up and
// never confirmed; the walk above outlasts that. Answer it (it is not under test).
await page.waitForSelector('.recovery-reminder-actions .recovery-done-btn', { timeout: 4000 })
    .then(() => page.click('.recovery-reminder-actions .recovery-done-btn'))
    .catch(() => { /* not shown */ });
await page.locator('.tasks-trash-row', { hasText: 'Packing' }).getByRole('button', { name: 'Restore' }).click();
await page.waitForSelector('.tasks-tab:has-text("Packing")', { timeout: 10000 })
    .then(() => ck('púca: Restore puts it back in the bar', true))
    .catch(() => ck('púca: Restore puts it back in the bar', false));
await page.goto('/notes/');
await page.waitForSelector('.notes-card:has-text("Poem")', { timeout: 15000 });
ck('notes: the text edited in Púca shows on the card', /Edited in Púca/.test(await poem().locator('.notes-card-body').innerText()));
ck('notes: Packing kept its archive flag through Púca\'s trash and restore', await page.locator('.notes-rail-item', { hasText: 'Archive' }).locator('.notes-rail-count').innerText() === '1');

// ---- 12d. Sync: live updates, labels across devices, bulk selection, offline ----------------------
// A SECOND device: its own browser context (own storage, own event stream),
// signed in with the same account.
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL, storageState: await ctx.storageState() });
const pageB = await ctxB.newPage();
watch(pageB);
const shotB = shotOf(pageB);
const streamB = pageB.waitForResponse(res => res.url().includes('/events/tasks'), { timeout: 20000 }).catch(() => null);
await pageB.goto('/notes/');
await pageB.waitForSelector('.notes-card', { timeout: 20000 });
const evB = await streamB;
ck('live: device B opened the task-event stream', evB?.status() === 200, String(evB?.status()));
// A creates a note; B must show it with NO refresh and no focus change (the
// list set has no poll, so only the stream can bring it).
await page.click('.notes-quickadd-collapsed');
await page.fill('.notes-quickadd-title', 'Live note');
await page.locator('.notes-quickadd-item input').first().fill('Arrives by itself');
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForSelector('.notes-card:has-text("Live note")', { timeout: 15000 });
const liveArrived = await pageB.waitForSelector('.notes-card:has-text("Live note")', { timeout: 10000 }).then(() => true, () => false);
ck('live: a note created on A appears on B without a refresh', liveArrived);
// A labels it; the sealed blob event brings the label to B.
const liveCard = () => page.locator('.notes-card', { hasText: 'Live note' });
await liveCard().hover();
await liveCard().locator('button[aria-label="Labels"]').click();
await page.waitForSelector('.notes-labels-new input', { timeout: 5000 });
await page.fill('.notes-labels-new input', 'Synced');
await page.press('.notes-labels-new input', 'Enter');
await page.keyboard.press('Escape');
const labelArrived = await pageB.waitForSelector('.notes-card:has-text("Live note") .notes-chip:has-text("Synced")', { timeout: 10000 }).then(() => true, () => false);
ck('sync: a label set on A appears on B', labelArrived);
await shotB('device-b-live');

// Bulk selection on the desktop: Ctrl-click two cards, colour both at once.
await page.locator('.notes-card', { hasText: 'Live note' }).click({ modifiers: ['Control'] });
await page.locator('.notes-card', { hasText: 'Groceries' }).click({ modifiers: ['Control'] });
await page.waitForSelector('.notes-selectbar', { timeout: 5000 });
ck('bulk: Ctrl-click selects without opening', await page.locator('.notes-editor').count() === 0 && /2 selected/.test(await page.locator('.notes-selectbar-count').innerText()));
await shot('bulk-selected');
await page.click('.notes-selectbar button[aria-label="Colour selected"]');
await page.click('.notes-popover .notes-swatch[data-color="sage"]');
await page.keyboard.press('Escape');
await sleep(300);
ck('bulk: one colour for both', await page.locator('.notes-card[data-color="sage"]').count() === 2);
await page.keyboard.press('Escape');
await sleep(200);
ck('bulk: Escape clears the selection', await page.locator('.notes-selectbar').count() === 0);
const sageOnB = await pageB.waitForFunction(() => document.querySelectorAll('.notes-card[data-color="sage"]').length === 2, null, { timeout: 10000 }).then(() => true, () => false);
ck('bulk: the colour change reached device B (one sealed write)', sageOnB);

// Selection lives on the grid only. Trash, Calendar and Reminders fall back to
// the "all notes" filter underneath, so a selection there would be of notes
// that are not on screen — and its Delete would trash every one of them.
const selectBar = () => page.locator('.notes-selectbar');
await page.locator('.notes-card', { hasText: 'Groceries' }).click({ modifiers: ['Control'] });
const barOnGrid = await page.waitForSelector('.notes-selectbar', { timeout: 5000 }).then(() => true, () => false);
ck('bulk: a selection made on the grid shows its bar (control for the checks below)', barOnGrid);
await page.locator('.notes-rail-item', { hasText: 'Trash' }).click();
await page.waitForSelector('.notes-trash', { timeout: 10000 });
ck('bulk: opening the Trash drops the grid’s selection — no bar, no Delete', await selectBar().count() === 0);
await page.locator('.notes-trash-head').click();   // focus the page, not an input
await page.keyboard.press('Control+a');
await sleep(300);
ck('bulk: Ctrl+A on the Trash selects nothing (no bar, no Delete selected)', await selectBar().count() === 0 && await page.locator('button[aria-label="Delete selected"]').count() === 0);
await page.locator('.notes-rail-item', { hasText: 'Calendar' }).click();
await page.waitForFunction(() => location.hash.startsWith('#/calendar'), null, { timeout: 5000 }).catch(() => {});
await sleep(300);
await page.keyboard.press('Control+a');
await sleep(300);
ck('bulk: Ctrl+A on the Calendar selects nothing (no bar, no Delete selected)', await selectBar().count() === 0 && await page.locator('button[aria-label="Delete selected"]').count() === 0);
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();
await page.waitForSelector('.notes-card:has-text("Groceries")', { timeout: 10000 });
await sleep(300);
ck('bulk: back on the grid the old selection does not come back', await selectBar().count() === 0 && await page.locator('.notes-card[data-selected="true"]').count() === 0);
await page.keyboard.press('Control+a');
const barAgain = await page.waitForSelector('.notes-selectbar', { timeout: 5000 }).then(() => true, () => false);
ck('bulk: POSITIVE CONTROL — Ctrl+A on the grid does select', barAgain && await page.locator('.notes-card[data-selected="true"]').count() > 0);
await page.keyboard.press('Escape');
await page.waitForSelector('.notes-selectbar', { state: 'detached', timeout: 5000 }).catch(() => {});

// Offline on A: the worker serves the page, the cache fills it, edits queue.
const swReady = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'no serviceWorker';
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(res => setTimeout(() => res(null), 10000))]);
    return reg && reg.active ? 'active' : 'not active';
});
ck('offline: the /notes/ worker is active', swReady === 'active', swReady);
const scopes = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(r => new URL(r.scope).pathname));
ck('offline: the only worker is scoped to /notes/ (the main app is never controlled)', scopes.length === 1 && scopes[0] === '/notes/', JSON.stringify(scopes));
await sleep(1500);   // the sealed cache write is debounced
await ctx.setOffline(true);
await page.reload();
const offlineCards = await page.waitForSelector('.notes-card:has-text("Groceries")', { timeout: 20000 }).then(() => true, () => false);
ck('offline: a reload with no network still shows the notes', offlineCards);
await shot('offline-reload');
const listsBeforeOffline = psqlDsn ? Number(sql(`SELECT count(*) FROM task_lists l JOIN users u ON u.id = l.owner_id WHERE u.username = '${username}'`)) : null;
await page.click('.notes-quickadd-collapsed');
await page.fill('.notes-quickadd-title', 'Offline note');
await page.locator('.notes-quickadd-item input').first().fill('Written on a plane');
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForSelector('.notes-card:has-text("Offline note")', { timeout: 10000 });
ck('offline: the new note says Not synced', await page.locator('.notes-card:has-text("Offline note") .notes-chip.unsynced').count() === 1);
ck('offline: the pending banner counts the queued changes', await page.locator('[data-sync="pending"]').count() === 1);
await shot('offline-edit');
await ctx.setOffline(false);
const synced = await page.waitForSelector('[data-sync="pending"]', { state: 'detached', timeout: 20000 }).then(() => true, () => false);
ck('offline: back online, the queue replays', synced);
const offlineOnB = await pageB.waitForSelector('.notes-card:has-text("Offline note")', { timeout: 15000 }).then(() => true, () => false);
ck('offline: the edit made offline reached the server and device B sees it', offlineOnB);
const itemOnB = await pageB.waitForFunction(() => /Written on a plane/.test(document.body.innerText), null, { timeout: 10000 }).then(() => true, () => false);
ck('offline: its item came through too (temp ids rewritten)', itemOnB);
if (psqlDsn) {
    try {
        // EXACTLY one more than before it was written: not a lower bound the
        // walk's earlier notes already satisfy, and not two (a replayed create).
        const n = Number(sql(`SELECT count(*) FROM task_lists l JOIN users u ON u.id = l.owner_id WHERE u.username = '${username}'`));
        ck('database: the offline note became exactly one real list on the server', n === listsBeforeOffline + 1, `before=${listsBeforeOffline} after=${n}`);
        const blob = sql(`SELECT blob FROM user_sealed_blobs b JOIN users u ON u.id = b.user_id WHERE u.username = '${username}' AND b.name = 'notes-prefs'`);
        ck('database: the colour/label blob is ciphertext only', blob.length > 0 && !/Synced|Errands|Chores|Trip|sage|mint/.test(blob), blob.slice(0, 60));
    } catch (e) {
        ck('database sync checks ran', false, String(e).slice(0, 200));
    }
} else {
    skip('database: the offline note became exactly one real list; the prefs blob is ciphertext', 'no psql DSN given');
}
await ctxB.close();

// ---- 13. Cross-tab: a Notes sign-out lands the main app's tab on its login ---------------------------
const page2 = await ctx.newPage();
watch(page2);
await page2.goto('/chat');
await page2.waitForSelector('.chat-container', { timeout: 20000 }).catch(() => {});
const chatUp = await page2.locator('.chat-container').count() > 0;

// A colour changed while OFFLINE has not reached the account: a sign-out would
// delete it, so both sign-outs must ask (and cancelling must keep the session).
await ctx.setOffline(true);
await page.locator('.notes-card', { hasText: 'Groceries' }).click({ modifiers: ['Control'] });
await page.waitForSelector('.notes-selectbar', { timeout: 5000 });
await page.click('.notes-selectbar button[aria-label="Colour selected"]');
await page.click('.notes-popover .notes-swatch[data-color="coral"]');
await page.keyboard.press('Escape');
await sleep(300);
await page.keyboard.press('Escape');
await sleep(1500);   // the push is debounced, then fails offline
const flag = await page2.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('pucaNotesUnsynced:')).map(([, v]) => v));
ck('sign-out guard: Notes publishes the unsynced colour for Púca to see (counts only)', flag.length === 1 && JSON.parse(flag[0]).prefs === true && !/coral|Groceries/.test(flag[0]), JSON.stringify(flag));
let askedNotes = null;
page.once('dialog', d => { askedNotes = d.message(); void d.dismiss(); });
await page.click('button[aria-label="Account and settings"]');
await page.waitForSelector('.notes-menu', { timeout: 5000 });
await page.getByRole('button', { name: 'Sign out', exact: true }).click();
await sleep(1500);
ck('sign-out guard: Notes asks before deleting a colour change that never synced', askedNotes !== null && /colours, labels or archive/.test(askedNotes), askedNotes ?? 'no question asked');
ck('sign-out guard: answering no keeps Notes signed in', await page.locator('.login-card').count() === 0 && await page.locator('.notes-card').count() > 0);
if (chatUp) {
    let askedPuca = null;
    page2.once('dialog', d => { askedPuca = d.message(); void d.dismiss(); });
    // A fresh account's first-run dialogs sit over the home view; move them
    // aside (neither is what is being tested), then Settings -> Log Out.
    await page2.getByRole('button', { name: 'Later', exact: true }).click({ timeout: 3000 }).catch(() => {});
    await page2.locator('.welcome-popup-close').click({ timeout: 3000 }).catch(() => {});
    await sleep(300);
    const opened = await page2.locator('button[aria-label="Open settings"]').first().click({ timeout: 5000 }).then(() => true, e => { console.log('[walk] settings:', String(e).slice(0, 200)); return false; });
    const clicked = opened && await page2.locator('.settings-nav-item.logout').click({ timeout: 5000 }).then(() => true, e => { console.log('[walk] log out:', String(e).slice(0, 200)); return false; });
    await sleep(500);
    if (!clicked) await page2.screenshot({ path: `${outdir}/puca-signout-unreachable.png` });
    ck('sign-out guard: Púca\'s own sign-out asks about Notes\' unsynced changes too', clicked && askedPuca !== null && /Púca Notes has/.test(askedPuca), clicked ? (askedPuca ?? 'no question asked') : 'could not reach Púca\'s Log Out');
    ck('sign-out guard: answering no keeps Púca signed in', !page2.url().includes('/login'), page2.url());
    await page2.keyboard.press('Escape');
} else {
    skip('sign-out guard: Púca\'s own sign-out asks too', 'the main app tab did not load');
}
await ctx.setOffline(false);
const flagCleared = await page.waitForFunction(() => !Object.keys(localStorage).some(k => k.startsWith('pucaNotesUnsynced:')), null, { timeout: 20000 }).then(() => true, () => false);
ck('sign-out guard: back online, the colour syncs and there is nothing left to ask about', flagCleared);

await page.click('button[aria-label="Account and settings"]');
await page.waitForSelector('.notes-menu', { timeout: 5000 });
await shot('account-menu');
ck('browser: the account menu has no update rows (they are the Android app\'s)', !/Check for updates/.test(await page.locator('.notes-menu').innerText()));
ck('browser: Notes never asked for an OTA manifest', browserUpdateChecks.length === 0, JSON.stringify(browserUpdateChecks));
let unexpectedQuestion = null;
const onUnexpected = d => { unexpectedQuestion = d.message(); void d.accept(); };
page.on('dialog', onUnexpected);
const devicesBefore = psqlDsn ? sql(`SELECT count(*) FROM devices d JOIN users u ON u.id = d.user_id WHERE u.username = '${username}' AND d.revoked_at IS NULL`) : null;
await page.getByRole('button', { name: 'Sign out', exact: true }).click();
await page.waitForSelector('.login-card', { timeout: 10000 });
page.off('dialog', onUnexpected);
ck('sign out: Notes returns to its login', true);
ck('sign out: nothing unsynced, so no question was asked', unexpectedQuestion === null, unexpectedQuestion ?? undefined);
await sleep(1500);
const marker = await page.evaluate(() => localStorage.getItem('pucaDeviceRevokePending'));
ck('sign out: the revoke was confirmed, so no pending-revoke marker is left behind', marker === null, marker ?? undefined);
if (psqlDsn) {
    const after = sql(`SELECT count(*) FROM devices d JOIN users u ON u.id = d.user_id WHERE u.username = '${username}' AND d.revoked_at IS NULL`);
    ck('sign out: this browser\'s device enrolment is revoked (no socket needed)', devicesBefore !== '0' && after === '0', `before=${devicesBefore} after=${after}`);
} else {
    skip('sign out: this browser\'s device enrolment is revoked', 'no psql DSN given');
}
await page2.waitForURL('**/login', { timeout: 8000 }).then(() => ck('sign out: the main app tab followed (sessionSync)', true)).catch(() => ck('sign out: the main app tab followed (sessionSync)', false, 'still on ' + page2.url()));
await page2.close();

// ---- 14. Sign in from Notes' own form ------------------------------------------------------------
await page.fill('#username', username);
await page.fill('#password', password);
await page.click('.login-button');
await page.waitForSelector('.notes-app', { timeout: 20000 });
await page.waitForSelector('.notes-card', { timeout: 15000 });
ck('sign in: Notes signs in with the Púca account and the notes are back', await page.locator('.notes-card').count() >= 1);
// Colour and labels follow the ACCOUNT now (a sealed blob): the sign-out
// scrubbed this browser's copy, and signing back in brings them back.
const kept = await page.waitForSelector('.notes-card:has-text("Groceries") .notes-chip:has-text("Errands")', { timeout: 10000 }).then(() => true, () => false);
ck('sign in: labels survive a sign-out and sign-in (synced, not device-local)', kept);
ck('sign in: the colour came back too', await page.locator('.notes-card[data-color="sage"]').count() >= 1);
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
    for (const sel of ['.notes-search input', '.notes-editor-add input', '.notes-editor-title', '.notes-quickadd-title', '.notes-quickadd-item input', '.tt-edit-input', '.nb-text', '.notes-quickadd-body']) {
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
// The composer's text mode, camera and drawing on a phone.
await m.tap('.notes-fab');
await m.waitForSelector('.notes-quickadd.sheet', { timeout: 5000 });
ck('phone: the composer offers the camera directly', await m.locator('.notes-quickadd-foot button[aria-label="Take photo"]').count() === 1
    && await m.locator('.notes-quickadd-foot input[capture]').count() === 1);
await m.tap('.notes-quickadd-foot button[aria-label="Text note"]');
r = await audit();
ck('phone: composer text field ≥ 16px, footer targets at size', r.fonts['.notes-quickadd-body'] >= 16 && r.under.length === 0, JSON.stringify({ f: r.fonts['.notes-quickadd-body'], u: r.under }));
await m.tap('.notes-quickadd-foot button[aria-label="Draw"]');
await m.waitForSelector('.notes-draw', { timeout: 5000 });
const dbx = await m.locator('.notes-draw').boundingBox();
const mvh = await m.evaluate(() => window.innerHeight);
r = await audit();
ck('phone: the drawing editor is full-screen with tools at size', dbx && dbx.width >= 389 && dbx.height >= mvh - 2 && r.under.length === 0 && !r.bodyScrollsHorizontally, JSON.stringify({ dbx, u: r.under }));
ck('phone: the canvas takes touch as drawing, not scrolling', await m.evaluate(() => getComputedStyle(document.querySelector('.notes-draw-canvas')).touchAction) === 'none');
await mshot('phone-drawing');
await m.getByRole('button', { name: 'Cancel' }).tap();
await m.waitForSelector('.notes-draw', { state: 'detached', timeout: 5000 });
await m.locator('.notes-quickadd.sheet button[aria-label="Discard note"]').tap();
await m.waitForSelector('.notes-quickadd.sheet', { state: 'detached', timeout: 5000 }).catch(() => {});
// The Trash at phone size — with a note in it, or there is nothing to measure.
const phoneNote = m.locator('.notes-card', { hasText: 'Phone note' });
await phoneNote.locator('button[aria-label="More actions"]').tap().catch(() => {});
await m.locator('.context-menu-item', { hasText: 'Move to trash' }).tap({ timeout: 5000 }).catch(() => {});
await m.waitForSelector('.notes-undo-text:has-text("to the trash")', { timeout: 8000 }).catch(() => {});
await m.goto('/notes/#/trash');
await m.waitForSelector('.notes-trash', { timeout: 10000 });
await m.waitForSelector('.notes-trash-row', { timeout: 10000 }).catch(() => {});
const trashRows = await m.locator('.notes-trash-row').count();
const trashRowButtons = await m.locator('.notes-trash-row button').count();
ck('phone: the Trash has a note in it to measure (moved there from the phone)', trashRows >= 1 && trashRowButtons >= 2, `rows=${trashRows} buttons=${trashRowButtons}`);
const phoneTrashMeta = await m.locator('.notes-trash-row', { hasText: 'Phone note' }).locator('.notes-trash-meta').innerText().catch(() => '');
ck('phone: a note trashed just now counts down the full 30 days (not 31)', /deleted forever in 30 days/.test(phoneTrashMeta), phoneTrashMeta);
r = await audit();
ck('phone: the Trash view fits, its row controls and Empty trash at size', trashRows >= 1 && !r.bodyScrollsHorizontally && r.under.length === 0, JSON.stringify({ rows: trashRows, under: r.under }));
await mshot('phone-trash');

// Púca's Tasks view at 390x844: the Trash section at the end of the All tasks
// board (above the bottom nav) and a photo note's text and picture controls.
const pucaAudit = scope => m.evaluate(sel => {
    const root = document.querySelector(sel);
    if (!root) return { missing: sel, buttons: 0, under: [], textPx: 0, overflow: true };
    const vis = el => { const b = el.getBoundingClientRect(); const st = getComputedStyle(el); return b.width > 0 && b.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
    const btns = [...root.querySelectorAll('button')].filter(vis).filter(b => !b.matches('.ni-open'));
    const under = btns.map(b => [b, b.getBoundingClientRect()]).filter(([, b]) => b.width < 43.5 || b.height < 43.5).map(([el, b]) => `${el.className || el.tagName} ${Math.round(b.width)}x${Math.round(b.height)}`);
    const ta = root.querySelector('textarea');
    return { buttons: btns.length, under, textPx: ta ? parseFloat(getComputedStyle(ta).fontSize) : 0, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
}, scope);
await m.goto('/chat');
await m.waitForSelector('.chat-container', { timeout: 20000 }).catch(() => {});
try { await m.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* no popup */ }
await m.locator('.mobile-nav-btn').nth(0).tap().catch(() => {});
await m.locator('.server-icon.notes-self').tap({ timeout: 5000 }).catch(() => {});
await m.waitForSelector('.tasks-tabbar', { timeout: 15000 }).catch(() => {});
const trashToggle = m.locator('.tasks-trash-toggle');
await trashToggle.waitFor({ timeout: 10000 }).catch(() => {});
const hasTrashSection = await trashToggle.count() === 1;
ck('phone púca: the All tasks board has its Trash section (a note is in the trash)', hasTrashSection);
if (hasTrashSection) {
    await trashToggle.scrollIntoViewIfNeeded();
    await trashToggle.tap();
    await m.waitForSelector('.tasks-trash-row', { timeout: 5000 }).catch(() => {});
}
let pr = await pucaAudit('.tasks-trash');
ck('phone púca: the Trash section lists the note trashed on the phone', await m.locator('.tasks-trash-row', { hasText: 'Phone note' }).count() === 1);
ck('phone púca: Trash controls at size, nothing overflows', pr.buttons >= 3 && pr.under.length === 0 && !pr.overflow, JSON.stringify(pr));
const trashTitleBox = await m.locator('.tasks-trash-row', { hasText: 'Phone note' }).locator('.tasks-trash-title').boundingBox().catch(() => null);
ck('phone púca: a trashed list’s title gets a line of its own, not a letter per line', !!trashTitleBox && trashTitleBox.width >= 200 && trashTitleBox.height <= 48, JSON.stringify(trashTitleBox));
const lastTrashBtn = m.locator('.tasks-trash-row button').last();
let reachable = false, lastBox = null, navTop = null;
if (await lastTrashBtn.count() === 1) {
    await lastTrashBtn.scrollIntoViewIfNeeded();
    lastBox = await lastTrashBtn.boundingBox();
    navTop = await m.evaluate(() => { const n = document.querySelector('.mobile-bottom-nav'); return n ? n.getBoundingClientRect().top : window.innerHeight; });
    reachable = !!lastBox && lastBox.y >= 0 && lastBox.y + lastBox.height <= navTop + 0.5;
}
ck('phone púca: the last Trash button scrolls clear of the bottom nav', reachable, JSON.stringify({ lastBox, navTop }));
await mshot('phone-puca-tasks-trash');
// Put Phone note back (Restore at phone size, in Púca): the calendar walk at
// the end opens it as a live note.
const phoneRestore = m.locator('.tasks-trash-row', { hasText: 'Phone note' }).getByRole('button', { name: 'Restore' });
if (await phoneRestore.count() === 1) {
    await phoneRestore.tap();
    await m.waitForSelector('.tasks-trash-row:has-text("Phone note")', { state: 'detached', timeout: 10000 }).catch(() => {});
}
ck('phone púca: Restore takes Phone note out of the trash', await m.locator('.tasks-trash-row', { hasText: 'Phone note' }).count() === 0);
const photoTab = m.locator('.tasks-tab', { hasText: 'Holiday photo' });
await photoTab.tap({ timeout: 5000 }).catch(() => {});
await m.waitForSelector('.list-content-block .ni-actions', { timeout: 10000 }).catch(() => {});
pr = await pucaAudit('.list-content-block');
ck('phone púca: a photo note — text field ≥ 16px, picture controls at size, no overflow', pr.buttons >= 1 && pr.under.length === 0 && pr.textPx >= 16 && !pr.overflow, JSON.stringify(pr));
await mshot('phone-puca-photo-list');
await m.goto('/notes/');
await m.waitForSelector('.notes-card', { timeout: 20000 });
// A photo note's editor: gallery controls and the text field.
await m.tap('.notes-card:has-text("Holiday photo")');
await m.waitForSelector('.notes-editor .note-images', { timeout: 15000 });
r = await audit();
ck('phone: photo note editor — picture controls at size, text ≥ 16px', r.under.length === 0 && r.fonts['.nb-text'] >= 16, JSON.stringify({ u: r.under, f: r.fonts['.nb-text'] }));
await mshot('phone-photo-note');
await m.getByRole('button', { name: 'Close', exact: true }).tap();
await m.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });

// The account menu's selects must not trigger the iOS zoom.
await m.tap('button[aria-label="Account and settings"]');
await m.waitForSelector('.notes-menu-row select', { timeout: 5000 });
const selPx = await m.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.notes-menu-row select')).fontSize));
ck('phone: account-menu selects ≥ 16px', selPx >= 16, `${selPx}px`);
await m.keyboard.press('Escape');
await m.waitForSelector('.notes-popover', { state: 'detached', timeout: 5000 });

// The label manager on a phone: reached through the drawer, which must get
// out of the way (it is a fixed overlay at this width), and rows big enough
// to tap without hitting Delete by mistake.
await m.tap('.notes-menu-btn');
await m.waitForSelector('.notes-rail.open', { timeout: 5000 });
await m.tap('.notes-rail button[aria-label="Edit labels"]');
await m.waitForSelector('.notes-labelmgr-row', { timeout: 5000 });
ck('phone: opening the label manager closes the rail drawer', await m.locator('.notes-rail.open').count() === 0);
const lmBox = await m.locator('.notes-dialog').boundingBox();
ck('phone: the label manager fits the screen', !!lmBox && lmBox.x >= 0 && lmBox.x + lmBox.width <= 390.5, JSON.stringify(lmBox));
const lmRow = await m.locator('.notes-labelmgr-row').first().boundingBox();
ck('phone: label rows are tappable', !!lmRow && lmRow.height >= 44, JSON.stringify(lmRow));
await m.tap('.notes-labelmgr-row button[aria-label="Rename Errands"]');
await m.waitForSelector('.notes-labelmgr-row.editing input', { timeout: 5000 });
const lmFont = await m.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.notes-labelmgr-row.editing input')).fontSize));
ck('phone: the rename field is >= 16px (no iOS zoom)', lmFont >= 16, lmFont + 'px');
r = await audit();
ck('phone: label manager — no overflow, targets at size', !r.bodyScrollsHorizontally && r.under.length === 0, JSON.stringify({ widest: r.widest, under: r.under }));
await mshot('phone-label-manager');
await m.keyboard.press('Escape');
await m.keyboard.press('Escape');
await m.waitForSelector('.notes-dialog', { state: 'detached', timeout: 5000 });

// Ordering on a phone: notes.css forces ONE column in both views there, so
// the grip is offered in grid view too — and it must be a real tap target
// that does not scroll the page when dragged.
ck('phone: cards carry a grip in grid view too (one column there)', await m.locator('.notes-card-grip').count() > 1);
const pg = await m.locator('.notes-card-grip').first().boundingBox();
ck('phone: the grip is a 44px tap target', !!pg && pg.width >= 44 && pg.height >= 44, JSON.stringify(pg));
ck('phone: the grip declares touch-action none (no scroll to fight)',
    await m.locator('.notes-card-grip').first().evaluate(el => getComputedStyle(el).touchAction) === 'none');

// bulk selection by LONG PRESS (the phone's way in), then the bar at 390px.
// Poem, not Phone note: that one is in the trash by now (the Trash section above).
const target = m.locator('.notes-card', { hasText: 'Poem' });
const tb = await target.boundingBox();
await target.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, clientX: tb.x + 20, clientY: tb.y + 20, bubbles: true });
await sleep(700);
await target.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, clientX: tb.x + 20, clientY: tb.y + 20, bubbles: true });
const barUp = await m.waitForSelector('.notes-selectbar', { timeout: 5000 }).then(() => true, () => false);
ck('phone: a long press starts a selection (and does not open the note)', barUp && await m.locator('.notes-editor').count() === 0);
await m.tap('.notes-card:has-text("Groceries")');
await sleep(200);
ck('phone: while selecting, a tap adds to the selection', /2 selected/.test(await m.locator('.notes-selectbar-count').innerText()) && await m.locator('.notes-editor').count() === 0);
r = await audit();
const bar = await m.locator('.notes-selectbar').boundingBox();
ck('phone: the selection bar fits the viewport', bar && bar.x >= 0 && bar.x + bar.width <= 390.5, JSON.stringify(bar));
ck('phone: selecting — no overflow, targets at size, no ghosts', !r.bodyScrollsHorizontally && r.under.length === 0 && r.ghosts.length === 0, JSON.stringify({ under: r.under, ghosts: r.ghosts }));
await mshot('phone-bulk-select');
await m.tap('.notes-selectbar button[aria-label="Clear selection"]');
await m.waitForSelector('.notes-selectbar', { state: 'detached', timeout: 5000 });

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
        // No new column: the hinted row has exactly as many cells as the control row
// beside it (checkbox, text, timing marks, note, time, snooze — the calendar
// work added the last two, so a fixed count would only measure that).
ck('desktop hint: a second line inside the item cell, not a new column', !!hinted && !!mine && !!hinted.sub && hinted.cells === mine.cells && hinted.sub.t >= hinted.text.t + 4 && hinted.sub.b <= hinted.row.b + 0.5, JSON.stringify({ hinted, mineCells: mine?.cells }));
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

// ---- 15. Calendar (pinned zones, locales and a fixed clock) — notes-walk-calendar.mjs ----------
const calendar = await calendarWalk({ browser, baseURL, state, username, ck, watch, shotOf, sql: psqlDsn ? sql : null, errors, notesCreatedAt });

await browser.close();
const skipNotes = [
    skipped ? `${skipped} check(s) SKIPPED — see the SKIP lines above (most need the psql DSN)` : '',
    calendar.skipped ? `${calendar.skipped} calendar database proof(s) SKIPPED (no DSN)` : '',
].filter(Boolean).join('; ');
console.log(fail === 0 ? `\nALL PASS${skipNotes ? ` (${skipNotes})` : ''}` : `\n${fail} FAILED${skipNotes ? `; ${skipNotes}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
