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
// encrypted"; and on the phone — one column, no horizontal overflow, every
// tap target at size, 16px inputs, the FAB composer, the drawer, a popover
// inside the viewport, the full-screen editor with the grip and arrows.
//
// Every check is ck(): a precondition that did not happen (nothing to measure,
// an element not found) is a FAIL line, never a silent pass, and any FAIL
// makes the walk exit 1.
//
// Usage: node e2e/notes-walk.mjs [outdir] [baseURL] [psql-dsn]
//   baseURL  default http://127.0.0.1:5176 — `PORT=5176 node e2e/serve-dist.mjs`
//   psql-dsn optional, e.g. postgres://postgres:testpw@127.0.0.1:55433/puca_keep_e2e
//            (enables the injected-plaintext check; needs psql on PATH)
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
// A real (tiny) PNG for the photo note: 8x8, opaque red.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64');
const password = 'Password123!';

let fail = 0;
const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch();
const errors = [];
const watch = page => {
    page.on('dialog', d => { void d.accept(); });
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
}

// ---- 12b. Púca's own Tasks view: the same note text, read AND edited there ----------------------------
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

// ---- 13. Cross-tab: a Notes sign-out lands the main app's tab on its login ---------------------------
const page2 = await ctx.newPage();
watch(page2);
await page2.goto('/chat');
await page2.waitForSelector('.chat-container', { timeout: 20000 }).catch(() => {});
await page.click('button[aria-label="Account and settings"]');
await page.waitForSelector('.notes-menu', { timeout: 5000 });
await shot('account-menu');
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

await browser.close();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
