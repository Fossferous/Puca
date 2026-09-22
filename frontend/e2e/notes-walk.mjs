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
// Tasks view, where the colour, labels and archive set in Notes show and can
// be set from there too; a Notes sign-out lands the main app's tab on its login
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
// Nothing decodes it; it only has to be a file that is NOT a picture.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');
const password = 'Password123!';

let fail = 0;
const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };
/** A check that could not run (its precondition is missing): printed, never a PASS. */
let skipped = 0;
const skip = (n, why) => { console.log(`SKIP  ${n}${why ? `  — ${why}` : ''}`); skipped++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ args: [
    '--mute-audio',                          // a walk never makes a sound
    '--use-fake-device-for-media-stream',    // and never opens a real microphone
    '--use-fake-ui-for-media-stream',
] });
const errors = [];
const watch = page => {
    // Accept a confirm (Delete forever, Empty trash) that nothing else is
    // waiting for. A section that listens for its own question (the sign-out
    // guards) answers it alone: answering twice throws.
    page.on('dialog', d => { if (page.listenerCount('dialog') > 1) return; d.accept().catch(() => {}); });
    page.on('pageerror', e => { errors.push(String(e)); console.log('[pageerror]', String(e).slice(0, 300)); });
    page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
};
/** The disclosure must come BEFORE the microphone is asked for; recording the
 *  ORDER is the only way that can fail honestly (both calls happen either way).
 *  Installed on the CONTEXT, so it is in place from the first navigation. */
const watchMicOrder = ctx => ctx.addInitScript(() => {
    window.__micOrder = [];
    const c = window.confirm.bind(window);
    window.confirm = msg => { window.__micOrder.push('confirm'); return c(msg); };
    const md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
        const g = md.getUserMedia.bind(md);
        md.getUserMedia = o => { window.__micOrder.push('getUserMedia'); return g(o); };
    }
});

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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL, permissions: ['microphone'] });
await watchMicOrder(ctx);
const page = await ctx.newPage();
watch(page);
const shot = shotOf(page);
// The browser page must never ask for an OTA manifest (NotesUpdateGate runs
// only inside the Notes Android app).
const browserUpdateChecks = [];
page.on('request', rq => { if (rq.url().includes('/api/mobile-updates/check')) browserUpdateChecks.push(rq.url()); });
// Anything that leaves this MACHINE. A recording must never be sent anywhere
// to be written down, so this list is asserted EMPTY across the voice-note
// section (the only transcriber allowed is the phone's own, offline). The
// page's own origin and the API are both on loopback in this rig, so the
// check is "no host but this one", not "no host but the page's".
const hostOf = u => { try { return new URL(u).hostname; } catch { return u; } };
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '']);
const offMachineRequests = [];
page.on('request', rq => {
    const u = rq.url();
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    if (!LOCAL.has(hostOf(u))) offMachineRequests.push(u);
});
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
/** Púca asks, a few seconds after the app mounts, about a recovery code
 *  generated at sign-up and never confirmed. Its overlay swallows clicks, so
 *  every landing on /chat answers it first (it is not under test here). */
async function dismissRecoveryReminder(pg) {
    await pg.waitForSelector('.recovery-reminder-actions .recovery-done-btn', { timeout: 4000 })
        .then(() => pg.click('.recovery-reminder-actions .recovery-done-btn'))
        .catch(() => { /* not shown */ });
}
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

// ---- 4c. Voice notes -----------------------------------------------------------------
// Chromium's FAKE capture device, and --mute-audio stays on: the walk opens no
// real microphone and makes no sound. No check below ever calls play() —
// everything is asserted on `autoplay`, `paused` and `readyState`.
await openComposer();
await page.evaluate(() => { window.__micOrder = []; });
offMachineRequests.length = 0;
ck('voice note: the composer offers one', await page.locator('.notes-quickadd-foot button[aria-label="Voice note"]').count() === 1);

// A take ABANDONED mid-recording, first. A real MediaRecorder fires onstop in
// a LATER task than the stop() that caused it, so this is the one path a unit
// test with an inline fake cannot prove: the handler runs after the sheet is
// gone, and a preview URL minted there is one nothing can ever revoke. Only
// audio blobs are counted — the cards mint their own for pictures.
await page.evaluate(() => {
    window.__audioBlobs = 0;
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b && typeof b.type === 'string' && b.type.startsWith('audio/')) window.__audioBlobs++; return make(b); };
});
await page.click('.notes-quickadd-foot button[aria-label="Voice note"]');
await page.waitForSelector('.notes-recorder button[aria-label="Stop recording"]', { timeout: 10000 });
await sleep(1200);
await page.click('.notes-recorder button[aria-label="Close"]');
await page.waitForSelector('.notes-recorder', { state: 'detached', timeout: 5000 });
await sleep(1000);   // the browser getting round to onstop
ck('voice note: Close while recording leaves no unreachable preview URL behind',
    await page.evaluate(() => window.__audioBlobs) === 0, `audio blob urls=${await page.evaluate(() => window.__audioBlobs)}`);
ck('voice note: ...and the abandoned take is not in the composer',
    await page.locator('.notes-quickadd-media audio').count() === 0);

await page.click('.notes-quickadd-foot button[aria-label="Voice note"]');
await page.waitForSelector('.notes-recorder', { timeout: 10000 });
const micOrder = await page.evaluate(() => (window.__micOrder || []).join(','));
ck('voice note: the disclosure is shown BEFORE the microphone is asked for', micOrder.startsWith('confirm,getUserMedia'), micOrder);
await page.waitForSelector('.notes-recorder button[aria-label="Stop recording"]', { timeout: 10000 }).catch(() => {});
let recText = await page.locator('.notes-recorder').innerText().catch(() => '');
ck('voice note: recording shows elapsed time and a Stop',
    await page.locator('.notes-recorder button[aria-label="Stop recording"]').count() === 1
    && /^\d+:\d\d$/.test((await page.locator('.notes-recorder-time').innerText().catch(() => '')).trim()),
    recText.replace(/\s+/g, ' ').slice(0, 140));
await sleep(1500);
await page.click('.notes-recorder button[aria-label="Stop recording"]');
const previewed = await page.waitForSelector('.notes-recorder audio', { timeout: 10000 }).then(() => true).catch(() => false);
recText = await page.locator('.notes-recorder').innerText().catch(() => '');
ck('voice note: stopping produces a take to keep', previewed, recText.replace(/\s+/g, ' ').slice(0, 140));
ck('voice note: the take previews before it is kept, and never autoplays',
    previewed && await page.locator('.notes-recorder audio').evaluate(a => a.autoplay === false && a.paused === true && a.controls === true));
await shot('voice-recorder');
await page.getByRole('button', { name: 'Keep' }).click();
await page.waitForSelector('.notes-quickadd-media audio', { timeout: 10000 });
ck('voice note: the clip previews in the composer', await page.locator('.notes-quickadd-media audio').count() === 1);
// POSITIVE CONTROL for the check above: keeping a take DOES mint one, so the
// zero there means "not created", not "not counted".
ck('voice note: (control) a kept take mints its preview URL',
    await page.evaluate(() => window.__audioBlobs) > 0, `audio blob urls=${await page.evaluate(() => window.__audioBlobs)}`);
ck('voice note: the composer preview never autoplays',
    await page.locator('.notes-quickadd-media audio').evaluate(a => a.autoplay === false && a.paused === true));
// A take kept in the COMPOSER is written down like one kept in an open note —
// on the phone's own recogniser or not at all. In a browser there is none, so
// what must show is the refusal, in words, with nothing having left the machine.
await page.waitForSelector('.notes-quickadd .notes-transcribe-notice', { timeout: 15000 }).catch(() => {});
const qaNotice = await page.locator('.notes-quickadd .notes-transcribe-notice').count() === 1
    ? (await page.locator('.notes-quickadd .notes-transcribe-notice').innerText()).trim() : '';
ck('voice note: the composer says why the browser did not write it down',
    /on-device|can.t write down|recording is saved/i.test(qaNotice), qaNotice.slice(0, 120));
ck('voice note: nothing left this machine while the composer refused', offMachineRequests.length === 0, offMachineRequests.slice(0, 3).join(','));
// Discarded on purpose: the database checks below count the notes this walk
// made, and the clip that matters is added to an EXISTING note next.
await page.locator('.notes-quickadd-foot button[aria-label="Discard note"]').click();
await page.waitForSelector('.notes-quickadd-media audio', { state: 'detached', timeout: 5000 }).catch(() => {});

// Into an existing note, through the editor — the front door Púca's Tasks view
// shares.
offMachineRequests.length = 0;
await page.locator('.notes-card', { hasText: 'Sketch' }).click();
await page.waitForSelector('.notes-editor .ni-actions button[aria-label="Voice note"]', { timeout: 15000 });
await page.click('.notes-editor .ni-actions button[aria-label="Voice note"]');
await page.waitForSelector('.notes-recorder', { timeout: 10000 });
await sleep(1200);
await page.click('.notes-recorder button[aria-label="Stop recording"]');
await page.waitForSelector('.notes-recorder audio', { timeout: 10000 });
await page.getByRole('button', { name: 'Keep' }).click();
await page.waitForSelector('.notes-editor .ni-item.audio audio[src^="blob:"]', { timeout: 25000 });
ck('voice note: the editor plays it — a player, not a paperclip chip',
    await page.locator('.notes-editor .ni-item.audio audio[src^="blob:"]').count() === 1
    && await page.locator('.notes-editor .ni-file').count() === 0);
const decoded = await page.waitForFunction(
    () => document.querySelector('.notes-editor .ni-item.audio audio')?.readyState > 0,
    null, { timeout: 10000 }).then(() => true).catch(() => false);
ck('voice note: the clip decrypted (metadata loaded, still silent)',
    decoded && await page.locator('.notes-editor .ni-item.audio audio').evaluate(a => a.paused === true && a.autoplay === false));
await page.waitForSelector('.notes-transcribe-notice', { timeout: 15000 }).catch(() => {});
const notice = await page.locator('.notes-transcribe-notice').count() === 1
    ? (await page.locator('.notes-transcribe-notice').innerText()).trim() : '';
ck('voice note: the browser refuses to write it down, honestly and in words',
    /on-device|can.t write down|recording is saved/i.test(notice), notice.slice(0, 120));
ck('voice note: nothing left this machine while it refused to write it down', offMachineRequests.length === 0, offMachineRequests.slice(0, 3).join(','));
ck('voice note: the clip is a sealed attachment, not a hero picture on the card',
    await page.locator('.notes-editor .ni-item.audio').count() === 1);
await shot('voice-note-editor');
await page.getByRole('button', { name: 'Close', exact: true }).click();
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
ck('voice note: the card still leads with the drawing, never with a recording',
    await page.locator('.notes-card', { hasText: 'Sketch' }).locator('.notes-card-hero img.drawing').count() === 1
    && await page.locator('.notes-card', { hasText: 'Sketch' }).locator('audio').count() === 0);

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
// The snooze menu on that row is a layer INSIDE the editor, and Escape must
// close the menu WITHOUT closing the note. Two different things stop the key:
// the wrapper's React onKeyDown (which also stops the native event) covers a
// keypress while the snooze button holds focus, and the menu's own
// capture-phase listener covers one while focus is anywhere else. Only the
// second is this control's doing, and MEASURED: with the button focused the
// note survives either way, so the check below BLURS first — which is the
// real state after a tap in WebKit, where a button takes no focus. Without
// the capture-phase preventDefault the editor's document Escape
// (NoteEditor.tsx) then closes the whole note.
const eggsSnooze = eggsRow.locator('.notes-snooze button').first();
if (await eggsSnooze.count() === 1) {
    await eggsRow.hover();
    await eggsSnooze.click();
    await page.waitForSelector('.notes-snooze-menu', { timeout: 5000 });
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    ck('editor: the open snooze menu holds no focus (the state this checks)',
        await page.evaluate(() => !document.activeElement?.closest?.('.notes-snooze')));
    await page.keyboard.press('Escape');
    await sleep(200);
    ck('editor: Escape closes the row’s snooze menu and leaves the note open',
        await page.locator('.notes-snooze-menu').count() === 0 && await page.locator('.notes-editor').count() === 1);
} else {
    skip('editor: snooze is off on this server (taskFeatures)');
}
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
// The Android app's status lines and "At a place" are app-only: a browser
// has no alarms to describe and no place store to read. (Section 16 is the
// positive control: the same page in the Android shell MUST show both.)
ck('reminders (web): no native status banner', await page.locator('[data-native-banner]').count() === 0);
ck('reminders (web): no "At a place" section', await page.locator('section[aria-label="At a place"]').count() === 0);
await shot('reminders');
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();

// ---- 9b. A reminder on the NOTE itself (migration 068) -----------------------------------------
// "Poem" is a TEXT note: no items at all. That is the whole point — before
// 068 the only way to be reminded about it was to invent a to-do.
await page.waitForSelector('.notes-card:has-text("Poem")', { timeout: 10000 });
await poem().click();
await page.waitForSelector('.notes-editor', { timeout: 5000 });
ck('note reminder: the note really has no items', await page.locator('.notes-editor .tt-item').count() === 0);
const remindBtn = () => page.locator('.notes-editor-foot button[aria-label="Remind me"]');
ck('note reminder: the footer offers a reminder', await remindBtn().count() === 1);
await remindBtn().click();
await page.waitForSelector('.notes-editor input[aria-label="Remind me at"]', { timeout: 5000 });
// Far enough ahead to land in Upcoming whatever hour the walk runs at.
const noteDue = new Date(Date.now() + 3 * 86400000);
const pad = n => String(n).padStart(2, '0');
const noteDueLocal = `${noteDue.getFullYear()}-${pad(noteDue.getMonth() + 1)}-${pad(noteDue.getDate())}T09:00`;
await page.fill('.notes-editor input[aria-label="Remind me at"]', noteDueLocal);
await page.locator('.notes-editor .tt-due-set').click();
await sleep(600);
ck('note reminder: setting a time creates NO item', await page.locator('.notes-editor .tt-item').count() === 0);
ck('note reminder: the open note shows its own chip', await page.locator('.notes-editor-sub .note-due-chip').count() === 1);
await page.keyboard.press('Escape');
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
ck('note reminder: the card shows the note\u2019s own due chip', await poem().locator('.notes-card-foot .note-due-chip').count() === 1);
// Its own stylesheet travels with the control (NoteReminderControl.css): it is
// a real chip here, and it does NOT read as the chip beside it, which is the
// soonest ITEM due. Two identical clock pills would be one claim made twice.
const noteChipLook = await page.evaluate(() => {
    const el = document.querySelector('.notes-card-foot .note-due-chip');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const items = [...document.querySelectorAll('.notes-card-foot .notes-chip:not(.unsynced)')]
        .map(c => parseFloat(getComputedStyle(c).borderTopWidth) || 0);
    return {
        border: parseFloat(cs.borderTopWidth) || 0,
        radius: cs.borderTopLeftRadius,
        pad: cs.paddingLeft,
        itemChips: items.length,
        widestItemBorder: items.length ? Math.max(...items) : 0,
    };
});
ck('note reminder: the chip is styled by its own stylesheet and reads apart from an item chip',
    noteChipLook && noteChipLook.border >= 1 && noteChipLook.radius === '999px'
    && noteChipLook.itemChips > 0 && noteChipLook.widestItemBorder < 1,
    JSON.stringify(noteChipLook));

await page.locator('.notes-rail-item', { hasText: 'Reminders' }).click();
await page.waitForSelector('.notes-reminders', { timeout: 5000 });
const poemRow = () => page.locator('.notes-reminder-row', { hasText: 'Poem' });
ck('note reminder: Reminders lists the note itself', await poemRow().count() === 1);
ck('note reminder: it is a note row, not an item row', await page.locator('.notes-reminder-row.note').count() === 1);
ck('note reminder: the note row has no tick box and no Snooze',
    await page.locator('.notes-reminder-row.note input[type="checkbox"]').count() === 0
    && await page.locator('.notes-reminder-row.note .notes-snooze').count() === 0);
ck('note reminder: an ITEM row still has its tick box (positive control)',
    await page.locator('.notes-reminder-row:not(.note) input[type="checkbox"]').count() >= 1);
await shot('note-reminder');
// Clicking the row opens the NOTE, not an item editor.
await poemRow().click();
await page.waitForSelector('.notes-editor', { timeout: 5000 });
ck('note reminder: clicking the row opens the note', /Poem/.test(await page.locator('.notes-editor-title').inputValue()));
// The Close button, not Escape: a note with no items autofocuses its
// "Add an item" field, and the editor deliberately leaves Escape to whatever
// input holds the focus (NoteEditor's isEditableTarget guard).
await page.locator('.notes-editor button[aria-label="Close note"]').click();
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
// Clearing it from the row takes it out of the list.
await poemRow().locator('.notes-reminder-clear').click();
await sleep(700);
ck('note reminder: clearing it removes the row', await poemRow().count() === 0);
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();
await sleep(300);
ck('note reminder: and the card chip goes with it', await poem().locator('.notes-card-foot .note-due-chip').count() === 0);

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
        ck('database: note text is stored sealed', /"t":"self"/.test(bodies) && !/Roses|Violets|Friday|beach\.png|drawing-1|voice-1/.test(bodies), bodies.slice(0, 120));
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

// ---- 12a. A note holds any file, not only pictures ------------------------------------
// After the order and count assertions above: this adds a note, and those
// checks name every note by title.
await openComposer();
await page.fill('.notes-quickadd-title', 'Tickets');
await page.locator('.notes-quickadd-foot input[type="file"]:not([accept])').first().setInputFiles({ name: 'tickets.pdf', mimeType: 'application/pdf', buffer: PDF });
await page.waitForSelector('.notes-quickadd-media .ni-file', { timeout: 5000 }).catch(() => {});
ck('file note: a PDF picked in the composer shows as a named chip, not a broken image',
    await page.locator('.notes-quickadd-media .ni-file').count() === 1 && await page.locator('.notes-quickadd-media img').count() === 0);
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForSelector('.notes-card:has-text("Tickets")', { timeout: 20000 });
ck('file note: the card counts the file it holds, rather than looking empty',
    /1 file\b/.test(await page.locator('.notes-card', { hasText: 'Tickets' }).innerText()),
    await page.locator('.notes-card', { hasText: 'Tickets' }).innerText());
await page.locator('.notes-card', { hasText: 'Tickets' }).click();
await page.waitForSelector('.notes-editor .ni-item.file', { timeout: 15000 });
ck('file note: the editor offers the file as a download button, not dead text',
    await page.locator('.notes-editor .ni-item.file button.ni-file').count() === 1);
ck('file note: the button carries the real name',
    (await page.locator('.notes-editor .ni-item.file button.ni-file').innerText()).includes('tickets.pdf'));
ck('file note: no blob: link is ever in the document', await page.locator('a[href^="blob:"]').count() === 0);
ck('file note: the editor offers Add file beside Add photo',
    (await page.locator('.notes-editor .ni-action').allInnerTexts()).some(t => /Add file/.test(t)));
if (psqlDsn) {
    const att = sql(`SELECT coalesce(string_agg(l.attachments, '|'), '') FROM task_lists l JOIN users u ON u.id = l.owner_id WHERE u.username = '${username}' AND l.attachments IS NOT NULL`);
    ck('database: the file\u2019s real name and type are nowhere in the clear', !/tickets\.pdf|application\/pdf/.test(att), att.slice(0, 80));
} else {
    skip('database: the file\u2019s real name and type are nowhere in the clear', 'no psql DSN given');
}
await shot('file-note');
await page.getByRole('button', { name: 'Close', exact: true }).click();
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });

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
await dismissRecoveryReminder(page);
await page.waitForSelector('.checklist-card:has-text("Poem") .tasks-card-body', { timeout: 10000 }).catch(() => {});
// Parity: the ONE sealed document, seen through the other front door.
// Groceries was coloured mint and labelled Errands in Notes (§5-6); Packing
// was archived there (§10).
const barTabs = () => page.locator('.tasks-tab-scroll .tasks-tab:not(.tasks-tab-all):not(.tasks-tab-calendar)');
ck('púca: a note coloured in Notes tints its tab here', await page.locator('.tasks-tab[data-color="mint"]').count() === 1);
ck('púca: …and its board card', await page.locator('.checklist-card[data-color="mint"]').count() === 1);
ck('púca: the label set in Notes is on the tab', /Errands/.test(await page.locator('.tasks-tab', { hasText: 'Groceries' }).locator('.tasks-tab-labels').innerText().catch(() => '')));
ck('púca: …and a chip on the card', /Errands/.test(await page.locator('.checklist-card', { hasText: 'Groceries' }).locator('.tasks-card-label').innerText().catch(() => '')));
ck('púca: a note archived in Notes has no tab here', await page.locator('.tasks-tab', { hasText: 'Packing' }).count() === 0);
ck('púca: …and no board card', await page.locator('.checklist-card', { hasText: 'Packing' }).count() === 0);
const tabsAll = await barTabs().count();
await shot('puca-tasks-organisation');
// The filter beside New list: one entry per label, and the archive with its count.
await page.click('.tasks-tab-filter');
await page.waitForSelector('.notes-popover .tasks-filter-item', { timeout: 5000 });
ck('púca: the filter lists the label and counts the archive',
    await page.locator('.tasks-filter-item', { hasText: 'Errands' }).count() === 1
    && /1/.test(await page.locator('.tasks-filter-item', { hasText: 'Archive' }).innerText()));
await shot('puca-tasks-filter');
await page.locator('.tasks-filter-item', { hasText: 'Errands' }).click();
await sleep(300);
const tabsLabelled = await barTabs().count();
ck('púca: filtering by the label leaves only that note', tabsLabelled === 1 && tabsAll > 1, `${tabsLabelled} of ${tabsAll}`);
// Back to everything, and set a colour from HERE: the same document, written
// the other way (the check that it reached Notes is after the trash section).
await page.click('.tasks-tab-filter');
await page.locator('.tasks-filter-item', { hasText: 'All notes' }).click();
await sleep(300);
ck('púca: "All notes" puts them back', await barTabs().count() === tabsAll);
await page.locator('.tasks-tab', { hasText: 'Sketch' }).click({ button: 'right' });
await page.locator('.context-menu-item', { hasText: 'Colour' }).click();
await page.waitForSelector('.notes-popover .notes-swatch', { timeout: 5000 });
await page.click('.notes-popover .notes-swatch[data-color="dusk"]');
ck('púca: a colour set here tints the tab at once', await page.locator('.tasks-tab[data-color="dusk"]').count() === 1);
await page.keyboard.press('Escape');
await sleep(800);   // the push is debounced
ck('púca: the board card shows a text note\'s text', /Roses are red/.test(await page.locator('.checklist-card', { hasText: 'Poem' }).locator('.tasks-card-body').innerText().catch(() => '')));
ck('púca: the board card says a photo note has a picture', /1 picture/.test(await page.locator('.checklist-card', { hasText: 'Holiday photo' }).locator('.tasks-card-body').innerText().catch(() => '')));
await page.locator('.tasks-tab', { hasText: 'Poem' }).click();
await page.waitForSelector('.list-content-block textarea.nb-text', { timeout: 10000 });
ck('púca: the list editor shows the note text', /Roses are red/.test(await page.locator('.list-content-block textarea.nb-text').inputValue()));
await page.fill('.list-content-block textarea.nb-text', 'Roses are red\nViolets are blue\nEdited in Púca');
await sleep(1500);
// The NOTE's own reminder, from Púca's side: the same control, the same chip.
const pucaRemind = page.locator('.tasks-editor-header button[aria-label="Remind me"]');
ck('púca: the list header offers the note\u2019s own reminder', await pucaRemind.count() === 1);
await pucaRemind.click();
await page.waitForSelector('.tasks-editor-header input[aria-label="Remind me at"]', { timeout: 5000 });
// Púca never loads notes.css, so a control that borrowed `.notes-chip` from it
// rendered here as bare inline text with the item editor's 36px indent. Its own
// stylesheet is what makes this a row of its own under the title.
const pucaEdit = await page.evaluate(() => {
    const el = document.querySelector('.tasks-editor-header .note-due-edit');
    const hdr = document.querySelector('.tasks-editor-header');
    const title = document.querySelector('.tasks-editor-title');
    if (!el || !hdr || !title) return null;
    const b = el.getBoundingClientRect(), h = hdr.getBoundingClientRect(), t = title.getBoundingClientRect();
    return {
        ownRow: b.top >= t.bottom - 0.5,
        inside: b.left >= h.left - 0.5 && b.right <= h.right + 0.5,
        width: Math.round(b.width),
        padLeft: getComputedStyle(el).paddingLeft,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
});
ck('púca: the due editor takes its own row in the header, not the title' + '\u2019' + 's width',
    pucaEdit && pucaEdit.ownRow && pucaEdit.inside && pucaEdit.width > 150 && !pucaEdit.overflow,
    JSON.stringify(pucaEdit));
const pucaDue = new Date(Date.now() + 4 * 86400000);
const ppad = n => String(n).padStart(2, '0');
await page.fill('.tasks-editor-header input[aria-label="Remind me at"]', `${pucaDue.getFullYear()}-${ppad(pucaDue.getMonth() + 1)}-${ppad(pucaDue.getDate())}T09:00`);
await page.locator('.tasks-editor-header .tt-due-set').click();
await sleep(800);
ck('púca: the chip appears beside the list title', await page.locator('.tasks-editor-header .note-due-chip').count() === 1);
const pucaChipLook = await page.evaluate(() => {
    const el = document.querySelector('.tasks-editor-header .note-due-chip');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { border: parseFloat(cs.borderTopWidth) || 0, radius: cs.borderTopLeftRadius, pad: cs.paddingLeft };
});
ck('púca: and it is a real chip there, not bare text (notes.css is not loaded in Púca)',
    pucaChipLook && pucaChipLook.border >= 1 && pucaChipLook.radius === '999px' && pucaChipLook.pad !== '0px',
    JSON.stringify(pucaChipLook));
// Put it back: later sections (and Notes) expect the fixture unchanged.
await page.locator('.tasks-editor-header button[aria-label="Edit this note\u2019s reminder"]').click();
await page.waitForSelector('.tasks-editor-header input[aria-label="Remind me at"]', { timeout: 5000 });
await page.locator('.tasks-editor-header .tt-delete').click();
await sleep(800);
ck('púca: clearing it from there removes the chip', await page.locator('.tasks-editor-header .note-due-chip').count() === 0);
await page.locator('.tasks-tab', { hasText: 'Holiday photo' }).click();
await page.waitForFunction(() => document.querySelector('.list-content-block .ni-open img')?.naturalWidth > 0, null, { timeout: 15000 })
    .then(() => ck('púca: a photo note shows its photo', true))
    .catch(() => ck('púca: a photo note shows its photo', false));
await shot('puca-tasks-photo-note');
// Púca's own Reminders tab: the SAME grouped list Notes shows, over every
// personal list and checklist channel — and where a due-item notification
// lands (api/desktopNotify dispatches 'sovereign:open-reminders').
await page.locator('.tasks-tab-reminders').click();
await page.waitForSelector('.tasks-reminders .notes-reminders', { timeout: 10000 });
ck('púca reminders: the tab mounts the shared list', await page.locator('.tasks-reminders .notes-reminders').count() === 1);
// The rows arrive with the per-list reads, not with the tab.
await page.waitForSelector('.tasks-reminders .notes-reminder-row', { timeout: 15000 }).catch(() => {});
ck('púca reminders: the due item from a personal note is listed', await page.locator('.tasks-reminders .notes-reminder-row', { hasText: 'Eggs' }).count() === 1);
ck('púca reminders: it is grouped, not a flat list', await page.locator('.tasks-reminders .notes-reminder-group .notes-section-title').count() >= 1);
// The styles came with the shared component: Púca never loads notes.css, so
// an unstyled row here is the failure this catches.
ck('púca reminders: the row is laid out (the shared CSS reached Púca)',
    await page.locator('.tasks-reminders .notes-reminder-row').first().evaluate(el => getComputedStyle(el).display) === 'flex');
await shot('puca-tasks-reminders');
await page.locator('.tasks-tab-all').click();
await page.waitForSelector('.tasks-tab-all.active', { timeout: 5000 });
await page.evaluate(() => window.dispatchEvent(new CustomEvent('sovereign:open-reminders')));
const landed = await page.waitForSelector('.tasks-tab-reminders.active', { timeout: 5000 }).then(() => true, () => false);
ck('púca reminders: a clicked due-item notification lands on the Reminders tab', landed);
// A drawing made in Púca Notes, opened and changed in PÚCA's own Tasks view
// (the editor is shared now, and so is its stylesheet — an unstyled or
// missing canvas here is exactly what this catches).
await page.locator('.tasks-tab', { hasText: 'Sketch' }).click();
await page.waitForSelector('.list-content-block .ni-item.drawing button[aria-label="Edit drawing"]', { timeout: 15000 })
    .then(() => ck('púca: a drawing made in Notes can be edited in the Tasks view', true))
    .catch(() => ck('púca: a drawing made in Notes can be edited in the Tasks view', false));
ck('púca: a new drawing can be started there too', await page.locator('.list-content-block .ni-action', { hasText: 'Draw' }).count() === 1);
await page.click('.list-content-block .ni-item.drawing button[aria-label="Edit drawing"]');
await page.waitForSelector('.notes-draw-canvas', { timeout: 10000 });
await sleep(300);
const pucaInked = await page.evaluate(() => {
    const c = document.querySelector('.notes-draw-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 128 && d[i + 1] < 128 && d[i + 2] < 128) dark++;
    return dark;
});
ck('púca: reopening the drawing restores the strokes', pucaInked > 50, `dark samples=${pucaInked}`);
// DrawingCanvas.css sets .notes-draw's radius to 12px. An unstyled block
// computes to '0px' — never '' — so the value itself is the assertion.
const drawRadius = await page.locator('.notes-draw').evaluate(el => getComputedStyle(el).borderRadius);
ck('púca: the editor is the full-size modal, not an unstyled block (its stylesheet travelled with it)',
    drawRadius === '12px', drawRadius);
await shot('puca-drawing-editor');
// Draw a second stroke and save: ONE drawing remains (both old refs replaced).
const pcb = await page.locator('.notes-draw-canvas').boundingBox();
await page.mouse.move(pcb.x + pcb.width * 0.5, pcb.y + pcb.height * 0.6);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(pcb.x + pcb.width * (0.5 + i * 0.03), pcb.y + pcb.height * (0.6 - i * 0.02));
await page.mouse.up();
await page.getByRole('button', { name: 'Save drawing' }).click();
await page.waitForSelector('.notes-draw-canvas', { state: 'detached', timeout: 20000 });
await sleep(1200);
ck('púca: saving the edited drawing keeps ONE drawing in the note (the pair was replaced)',
    await page.locator('.list-content-block .ni-item.drawing').count() === 1,
    String(await page.locator('.list-content-block .ni-item').count()));
// Snooze on the item ROW: the same control the calendar and Reminders offer.
await page.locator('.tasks-tab', { hasText: 'Groceries' }).click();
await page.waitForSelector('.tt-item', { timeout: 10000 });
const eggsPuca = page.locator('.tt-item', { hasText: 'Eggs' }).first();
await eggsPuca.hover();
const snoozeBtn = eggsPuca.locator('.notes-snooze button').first();
if (await snoozeBtn.count() === 1) {
    await snoozeBtn.click();
    await page.locator('.notes-snooze-menu button', { hasText: '1 hour' }).click();
    await page.waitForSelector('.tt-item .tt-snoozed', { timeout: 10000 })
        .then(() => ck('púca: Snooze on an item row pushes the reminder back', true))
        .catch(() => ck('púca: Snooze on an item row pushes the reminder back', false));
    // The menu floats over the NEXT row, so it has to be dismissible without
    // picking anything: Escape, and a press anywhere outside it.
    await eggsPuca.hover();
    await eggsPuca.locator('.notes-snooze button').first().click();
    await page.waitForSelector('.notes-snooze-menu', { timeout: 5000 });
    await page.keyboard.press('Escape');
    ck('púca: Escape closes the row’s snooze menu', await page.locator('.notes-snooze-menu').count() === 0);
    await eggsPuca.hover();
    await eggsPuca.locator('.notes-snooze button').first().click();
    await page.waitForSelector('.notes-snooze-menu', { timeout: 5000 });
    // On the tab BAR's own background — not on another tab, which would
    // unmount the rows and hide the menu whatever this handler did.
    await page.locator('.tasks-tabbar').click({ position: { x: 2, y: 2 } });
    ck('púca: a press outside closes it too (it would otherwise swallow the next row’s clicks)',
        await page.locator('.notes-snooze-menu').count() === 0 && await page.locator('.tt-item').count() > 0);
    await eggsPuca.hover();
    await eggsPuca.locator('.notes-snooze button').first().click();
    await page.locator('.notes-snooze-menu button', { hasText: 'Unsnooze' }).click();
    await page.waitForSelector('.tt-item .tt-snoozed', { state: 'detached', timeout: 10000 })
        .then(() => ck('púca: Unsnooze on the row clears it', true))
        .catch(() => ck('púca: Unsnooze on the row clears it', false));
} else {
    skip('púca: snooze on an item row (this server has no snooze — taskFeatures)');
}
// Move to trash from Púca: the list leaves the bar and the Trash section
// offers it back. Packing is ARCHIVED, so it is not on the bar at
// all any more — it is reached through the Archive filter, which is where it
// stays for the restore below.
await page.click('.tasks-tab-filter');
await page.locator('.tasks-filter-item', { hasText: 'Archive' }).click();
await page.waitForSelector('.tasks-tab:has-text("Packing")', { timeout: 10000 });
ck('púca: the Archive filter shows the archived note, and only that', await barTabs().count() === 1);
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
await dismissRecoveryReminder(page);
await page.locator('.tasks-trash-row', { hasText: 'Packing' }).getByRole('button', { name: 'Restore' }).click();
await page.waitForSelector('.tasks-tab:has-text("Packing")', { timeout: 10000 })
    .then(() => ck('púca: Restore puts it back in the bar (still archived, so behind the Archive filter)', true))
    .catch(() => ck('púca: Restore puts it back in the bar (still archived, so behind the Archive filter)', false));
// The Archive filter is still on (that is how Packing is on the bar at all).
// A list created now must not be created BEHIND it: it has no labels and is
// not archived, so every filter hides it, and the "Show all notes" way back
// only renders on an EMPTY board — which this one is not.
const underFilter = await barTabs().count();
await page.click('.tasks-tabbar-actions button[aria-label="New list"]');
await page.fill('.tasks-tab-newform input', 'Made under a filter');
await page.press('.tasks-tab-newform input', 'Enter');
await page.waitForSelector('.tasks-tab:has-text("Made under a filter")', { timeout: 10000 }).catch(() => {});
const afterCreate = await barTabs().count();
ck('púca: a list created while a filter was on is on the bar, and the filter is back to everything',
    underFilter === 1 && await page.locator('.tasks-tab', { hasText: 'Made under a filter' }).count() === 1 && afterCreate === tabsAll + 1,
    `underFilter=${underFilter} afterCreate=${afterCreate} all=${tabsAll}`);
// Put the bar back as the checks below expect to find it.
await page.locator('.tasks-tab', { hasText: 'Made under a filter' }).click({ button: 'right' });
await page.locator('.context-menu-item', { hasText: 'Move to trash' }).click();
await page.waitForFunction(() => ![...document.querySelectorAll('.tasks-tab')].some(t => t.textContent.includes('Made under a filter')), null, { timeout: 10000 }).catch(() => {});
ck('púca: …and the walk’s fixture is back as it was', await barTabs().count() === tabsAll);
await page.goto('/notes/');
await page.waitForSelector('.notes-card:has-text("Poem")', { timeout: 15000 });
ck('notes: the colour set in Púca is on the card here', await page.locator('.notes-card[data-color="dusk"]').count() === 1);
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
// openComposer(), not a bare click: the composer focuses its first item on a
// requestAnimationFrame, and filling the title before that lands loses it —
// the note then takes its title from the item and nothing finds it again.
await openComposer();
await page.fill('.notes-quickadd-title', 'Live note');
await page.locator('.notes-quickadd-item input').first().fill('Arrives by itself');
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForSelector('.notes-card:has-text("Live note")', { timeout: 15000 })
    .catch(async e => { await shot('live-note-missing'); throw e; });
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
await openComposer();   // see the note at "Live note": the bare click races the focus
await page.fill('.notes-quickadd-title', 'Offline note');
await page.locator('.notes-quickadd-item input').first().fill('Written on a plane');
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForSelector('.notes-card:has-text("Offline note")', { timeout: 10000 });
ck('offline: the new note says Not synced', await page.locator('.notes-card:has-text("Offline note") .notes-chip.unsynced').count() === 1);
ck('offline: the pending banner counts the queued changes', await page.locator('[data-sync="pending"]').count() === 1);
await shot('offline-edit');

// A note's own TEXT typed with no network is kept, not refused.
await page.locator('.notes-card', { hasText: 'Offline note' }).click();
await page.waitForSelector('.notes-editor .note-body-field textarea', { timeout: 10000 });
await page.fill('.notes-editor .note-body-field textarea', 'Typed at 30,000 feet');
// Tab blurs the field, which is what makes it save; clicking elsewhere in
// the dialog is intercepted by whatever is on top.
await page.locator('.notes-editor .note-body-field textarea').press('Tab');
const queuedSaid = await page.waitForSelector('.notes-editor .nb-status.queued', { timeout: 10000 }).then(() => true, () => false);
ck('offline: text typed with no network is kept on this device, and says so', queuedSaid);
ck('offline: it says KEPT, not saved and not failed',
    /Kept on this device/.test(await page.locator('.notes-editor .nb-status').first().innerText().catch(() => ''))
    && await page.locator('.notes-editor .nb-status.failed').count() === 0);
await page.getByRole('button', { name: 'Close', exact: true }).click();
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
ck('offline: the card shows the typed words, not "Empty note"',
    /Typed at 30,000 feet/.test(await page.locator('.notes-card', { hasText: 'Offline note' }).innerText()));

// A PICTURE taken with no network: sealed on the device, shown from those
// bytes, counted separately in the banner.
await openComposer();
await page.fill('.notes-quickadd-title', 'Offline photo');
await page.locator('.notes-quickadd-foot input[accept="image/*"]').first().setInputFiles({ name: 'plane.png', mimeType: 'image/png', buffer: PNG });
await page.waitForSelector('.notes-quickadd-media img', { timeout: 5000 });
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForSelector('.notes-card:has-text("Offline photo")', { timeout: 15000 });
const parkedShown = await page.waitForFunction(
    () => [...document.querySelectorAll('.notes-card')].some(c => c.textContent.includes('Offline photo') && c.querySelector('.notes-card-hero img[src^="blob:"]')),
    null, { timeout: 20000 }).then(() => true, () => false);
ck('offline: a photo added with no network previews on the card from this device', parkedShown);
ck('offline: the photo note says Not synced', await page.locator('.notes-card:has-text("Offline photo") .notes-chip.unsynced').count() === 1);
ck('offline: the pending banner names the picture waiting',
    /picture/.test(await page.locator('[data-sync="pending"]').innerText()));
// The editor's gallery is where a parked picture is visible as parked, so
// the "nothing is left parked" check below has something it can observe.
// Opened here FIRST as the positive control: it really is parked now.
await page.locator('.notes-card', { hasText: 'Offline photo' }).click();
await page.waitForSelector('.notes-editor .ni-item', { timeout: 10000 });
ck('offline: the editor shows the picture as waiting on this device',
    await page.locator('.notes-editor .ni-item[data-parked="true"]').count() === 1);
await page.getByRole('button', { name: 'Close', exact: true }).click();
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
await shot('offline-photo');
await ctx.setOffline(false);
const synced = await page.waitForSelector('[data-sync="pending"]', { state: 'detached', timeout: 20000 }).then(() => true, () => false);
ck('offline: back online, the queue replays', synced);
const offlineOnB = await pageB.waitForSelector('.notes-card:has-text("Offline note")', { timeout: 15000 }).then(() => true, () => false);
ck('offline: the edit made offline reached the server and device B sees it', offlineOnB);
const itemOnB = await pageB.waitForFunction(() => /Written on a plane/.test(document.body.innerText), null, { timeout: 10000 }).then(() => true, () => false);
ck('offline: its item came through too (temp ids rewritten)', itemOnB);
const bodyOnB = await pageB.waitForFunction(() => /Typed at 30,000 feet/.test(document.body.innerText), null, { timeout: 20000 }).then(() => true, () => false);
ck('offline: the text written with no network reached device B', bodyOnB);
// The hero only decrypts once the card is on screen (an IntersectionObserver),
// so scroll to it first or this measures the viewport, not the upload.
await pageB.locator('.notes-card', { hasText: 'Offline photo' }).scrollIntoViewIfNeeded({ timeout: 30000 }).catch(() => {});
const photoOnB = await pageB.waitForFunction(
    () => [...document.querySelectorAll('.notes-card')].some(c => c.textContent.includes('Offline photo') && c.querySelector('.notes-card-hero img[src^="blob:"]')),
    null, { timeout: 30000 }).then(() => true, () => false);
ck('offline: the picture taken with no network uploaded and decrypts on device B', photoOnB);
// In the EDITOR, where `.ni-item` exists at all: on the grid this counted
// zero of nothing and could not have gone red for what it names.
await page.locator('.notes-card', { hasText: 'Offline photo' }).click();
await page.waitForSelector('.notes-editor .ni-item', { timeout: 10000 });
const stillParked = await page.locator('.notes-editor .ni-item[data-parked="true"]').count();
const galleryItems = await page.locator('.notes-editor .ni-item').count();
ck('offline: nothing is left parked once the queue is empty',
    stillParked === 0 && galleryItems === 1 && await page.locator('[data-sync="pending"]').count() === 0,
    `parked=${stillParked} items=${galleryItems}`);
await page.getByRole('button', { name: 'Close', exact: true }).click();
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
if (psqlDsn) {
    try {
        // EXACTLY one more than before it was written: not a lower bound the
        // walk's earlier notes already satisfy, and not two (a replayed create).
        const n = Number(sql(`SELECT count(*) FROM task_lists l JOIN users u ON u.id = l.owner_id WHERE u.username = '${username}'`));
        // Two: the checklist note AND the photo note, each exactly once (a
        // replayed create would make three or four).
        ck('database: the notes made offline became exactly two real lists on the server', n === listsBeforeOffline + 2, `before=${listsBeforeOffline} after=${n}`);
        const bodies = sql(`SELECT coalesce(string_agg(l.body, '|'), '') FROM task_lists l JOIN users u ON u.id = l.owner_id WHERE u.username = '${username}' AND l.body IS NOT NULL`);
        ck('database: the text typed offline is stored as ciphertext only', bodies.length > 0 && !/30,000 feet/.test(bodies), bodies.slice(0, 60));
        const att = sql(`SELECT coalesce(string_agg(l.attachments, '|'), '') FROM task_lists l JOIN users u ON u.id = l.owner_id WHERE u.username = '${username}' AND l.attachments IS NOT NULL`);
        ck('database: no local puca-parked ref was ever sealed for the server', !/puca-parked/.test(att), att.slice(0, 60));
        const blob = sql(`SELECT blob FROM user_sealed_blobs b JOIN users u ON u.id = b.user_id WHERE u.username = '${username}' AND b.name = 'notes-prefs'`);
        ck('database: the colour/label blob is ciphertext only', blob.length > 0 && !/Synced|Errands|sage|mint/.test(blob), blob.slice(0, 60));
    } catch (e) {
        ck('database sync checks ran', false, String(e).slice(0, 200));
    }
} else {
    skip('database: the offline note became exactly one real list; the prefs blob is ciphertext', 'no psql DSN given');
}
// ---- 12e. Two devices, one note; and a create whose answer was lost -------------------------------
// The server must advertise both, or every check below would pass by doing
// nothing (the client sends no base and no key against an older server).
const featuresApi = await apiBaseOf(page);
const featuresAnswer = featuresApi ? await authed(page, featuresApi, 'GET', '/task-lists/features') : null;
let listFeatures = null;
try { listFeatures = JSON.parse(featuresAnswer?.body ?? 'null'); } catch { /* not JSON */ }
ck('conflict: the server advertises content_rev and idempotent creates',
    listFeatures?.content_rev === true && listFeatures?.idempotent_creates === true, JSON.stringify(listFeatures));

// A opens a note and starts typing in its text. B changes the SAME note's text
// and saves it first. A's save is then made on top of B's, which is exactly
// what used to be lost.
const openNote = async (pg, title) => {
    await pg.waitForSelector('.notes-editor', { state: 'detached', timeout: 10000 }).catch(() => {});
    await pg.locator('.notes-card', { hasText: title }).first().click();
    await pg.waitForSelector('.notes-editor', { timeout: 10000 });
};
// Escape belongs to whatever input has focus (TaskTree's editors, the title),
// so the close button is the only reliable way out of the editor here.
const closeNote = async (pg) => {
    await pg.locator('.notes-editor button[aria-label="Close note"]').click().catch(() => {});
    await pg.waitForSelector('.notes-editor', { state: 'detached', timeout: 10000 }).catch(() => {});
};
await page.goto('/notes/');
await page.waitForSelector('.notes-card:has-text("Live note")', { timeout: 15000 });
await pageB.goto('/notes/');
await pageB.waitForSelector('.notes-card:has-text("Live note")', { timeout: 15000 });

// THE REAL RACE, in the order it happens to people: A is already typing when
// B's change lands. A's live event arrives mid-sentence — the field keeps A's
// words, and the revision A is writing on top of stays the one A started
// from, so the save that follows is judged against THAT and refused. (Taking
// the revision at send time instead would name B's and quietly win.)
//
// Only the TIMING is arranged here: A's save is held at the network until B's
// has landed, which is what a slow phone does by itself. Nothing about the
// request is changed.
let releaseA = () => {};
const aHeld = new Promise(res => { releaseA = res; });
await page.route('**/task-lists/*', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await aHeld;
    return route.continue();
});
await openNote(page, 'Live note');
await page.fill('.notes-editor textarea.nb-text', 'what A typed');
await sleep(300);

// Now B writes the same note's text and saves it, first.
await openNote(pageB, 'Live note');
await pageB.fill('.notes-editor textarea.nb-text', 'what B typed');
await pageB.locator('.notes-editor-title').click();
await pageB.waitForFunction(() => !document.querySelector('.notes-editor .nb-status'), null, { timeout: 10000 }).catch(() => {});
await sleep(1500);

// A's save is let go: it names the revision A started from, which is no
// longer the current one.
releaseA();
await sleep(500);
await page.unroute('**/task-lists/*');
const banner = page.locator('.notes-editor [data-conflict="stale"]');
const sawConflict = await banner.first().waitFor({ timeout: 15000 }).then(() => true, () => false);
ck('conflict: B changed the text while A was writing, so A is told instead of one copy winning silently', sawConflict);
ck('conflict: A\'s words are still in the field — nothing was thrown away', (await page.locator('.notes-editor textarea.nb-text').inputValue()) === 'what A typed');
ck('conflict: the banner shows the other device\'s copy, so nothing is chosen blind',
    sawConflict && /what B typed/.test(await banner.first().innerText()));
await shot('conflict-banner');
// Both choices are real tap targets even here on the desktop walk; the phone
// pass below measures them at 390px.
ck('conflict: both choices are offered', sawConflict
    && await banner.locator('[data-action="keep-mine"]').count() === 1
    && await banner.locator('[data-action="use-theirs"]').count() === 1);

// Keep mine: saved against the revision the refusal handed back, so it wins —
// and reaches B.
if (sawConflict) {
    await banner.locator('[data-action="keep-mine"]').click();
    await page.waitForFunction(() => !document.querySelector('.notes-editor [data-conflict]'), null, { timeout: 10000 }).catch(() => {});
    const reachedB = await pageB.waitForFunction(() => /what A typed/.test(document.body.innerText), null, { timeout: 15000 }).then(() => true, () => false);
    ck('conflict: "Keep mine" wins and reaches the other device', reachedB);
} else {
    ck('conflict: "Keep mine" wins and reaches the other device', false, 'no conflict was raised to resolve');
}
await closeNote(page);

// THE FALSE-POSITIVE TRAP. Ticking an ITEM is not editing the note's text, so
// it must never raise a conflict — a note is one card holding both.
await openNote(page, 'Live note');
await pageB.locator('.notes-editor .task-item').first().locator('input[type="checkbox"]').click().catch(() => {});
await sleep(1500);
await page.fill('.notes-editor textarea.nb-text', 'A keeps typing while B ticks');
await page.locator('.notes-editor-title').click();
await sleep(2000);
ck('conflict: an item ticked on B while A types is NOT a clash', await page.locator('.notes-editor [data-conflict]').count() === 0);
await closeNote(page);

// The title, the opposite loss: a rename arriving from B must not wipe what A
// is typing mid-keystroke.
await openNote(page, 'Live note');
await page.locator('.notes-editor-title').fill('A is renaming this');
await pageB.goto('/notes/');
await pageB.waitForSelector('.notes-card', { timeout: 15000 });
await openNote(pageB, 'Live note');
await pageB.locator('.notes-editor-title').fill('B renamed it');
await pageB.locator('.notes-editor textarea.nb-text').click();
await sleep(2500);
ck('conflict: a rename on B does not wipe the title A is typing',
    (await page.locator('.notes-editor-title').inputValue()) === 'A is renaming this');
// ...and keeping A's draft is only half of it. A now COMMITS. The commit
// names the revision A started typing from, which B has moved past, so it
// must be refused: B's name survives and A is told. Reading the revision at
// commit time instead would name B's, be accepted, and destroy B's rename
// with nothing on screen to say so.
await page.locator('.notes-editor textarea.nb-text').click();   // blur the title = commit
await sleep(2500);
const titleAfterA = await page.locator('.notes-editor-title').inputValue();
const renameToast = await page.locator('.message-toast-title', { hasText: 'renamed somewhere else' }).count();
ck('conflict: A\'s rename is refused rather than destroying B\'s, and A is told',
    titleAfterA === 'B renamed it' && renameToast > 0, `title=${JSON.stringify(titleAfterA)} toast=${renameToast}`);
// And B still holds its own name — the loss this check exists for.
ck('conflict: B\'s rename survived on B', await pageB.locator('.notes-editor-title').inputValue() === 'B renamed it');
await closeNote(page);
await closeNote(pageB);

// AND AN UNANSWERED QUESTION IS NOT ANSWERED BY LEAVING. A gets a second
// clash and simply closes the note. Nothing A typed may reach the server, and
// B's words must still be there when A comes back to it. Every ordinary way
// out of the field used to fire a save — the textarea's own blur, the unmount
// that closing runs, the trash's flush — and that save always said "keep
// mine", so B's copy went with nobody ever choosing.
let releaseA2 = () => {};
const aHeld2 = new Promise(res => { releaseA2 = res; });
await page.route('**/task-lists/*', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await aHeld2;
    return route.continue();
});
// The note answers to B's name by now — the rename check above left it there.
const clashNote = 'B renamed it';
await openNote(page, clashNote);
await page.fill('.notes-editor textarea.nb-text', 'A typed this and walked away');
await sleep(300);
await openNote(pageB, clashNote);
await pageB.fill('.notes-editor textarea.nb-text', 'B wins and keeps it');
await pageB.locator('.notes-editor-title').click();
await sleep(1500);
releaseA2();
await sleep(500);
await page.unroute('**/task-lists/*');
const banner2 = page.locator('.notes-editor [data-conflict="stale"]');
const sawConflict2 = await banner2.first().waitFor({ timeout: 15000 }).then(() => true, () => false);
ck('conflict: a second clash is raised, so there is a question to leave unanswered', sawConflict2);
// A closes the note with the banner still up, and the page is then RELOADED
// so what comes back is the server's copy and not this tab's cache.
await closeNote(page);
await sleep(2500);
await page.goto('/notes/');
await page.waitForSelector('.notes-card', { timeout: 20000 });
await openNote(page, clashNote);
const afterClose = await page.locator('.notes-editor textarea.nb-text').inputValue();
ck('conflict: closing the note on an unanswered question saves nothing over the other copy',
    sawConflict2 && afterClose === 'B wins and keeps it', JSON.stringify(afterClose));
ck('conflict: and B still holds its own words',
    (await pageB.locator('.notes-editor textarea.nb-text').inputValue()) === 'B wins and keeps it');
await closeNote(page);
await closeNote(pageB);

// A CREATE WHOSE ANSWER WAS LOST. The note is made offline so it is QUEUED —
// the queue is what retries a 5xx, which is the only place a create is ever
// sent twice. Back online, the first attempt reaches the server and commits,
// and the page is answered with a 502: the exact shape of a connection that
// dropped after the write. The outbox sends it again, with the same key, and
// there must be ONE note.
if (psqlDsn) {
    const countLists = () => Number(sql(`SELECT count(*) FROM task_lists l JOIN users u ON u.id = l.owner_id WHERE u.username = '${username}'`));
    const openComposer = async () => {
        if (await page.locator('.notes-quickadd-collapsed').count() > 0) await page.click('.notes-quickadd-collapsed');
        await page.waitForSelector('.notes-quickadd-title', { timeout: 10000 });
    };
    // Back to a plain grid first: the composer is not reachable with the
    // editor open, and a stale route from the checks above must be gone.
    await page.goto('/notes/');
    await page.waitForSelector('.notes-quickadd-collapsed', { timeout: 20000 });
    await ctx.setOffline(true);
    await openComposer();
    await page.fill('.notes-quickadd-title', 'Lost answer');
    await page.locator('.notes-quickadd-item input').first().fill('Only once');
    await page.getByRole('button', { name: 'Done' }).click();
    const queued = await page.waitForSelector('.notes-card:has-text("Lost answer")', { timeout: 20000 }).then(() => true, () => false);
    ck('idempotent create: the note is queued, so the retry path is the one under test',
        queued && await page.locator('[data-sync="pending"]').count() === 1, `card=${queued}`);
    await shot('idempotent-queued');
    const before = countLists();
    let swallowed = 0;
    let sentKeys = [];
    await page.route('**/task-lists', async route => {
        const req = route.request();
        if (req.method() !== 'POST') return route.continue();
        try { sentKeys.push(JSON.parse(req.postData() || '{}').op_key ?? null); } catch { sentKeys.push('unreadable'); }
        if (swallowed > 0) return route.continue();
        swallowed++;
        // Let it through — the server commits — then throw the ANSWER away.
        await route.fetch().catch(() => null);
        return route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' });
    });
    await ctx.setOffline(false);
    await page.waitForSelector('[data-sync="pending"]', { state: 'detached', timeout: 40000 }).catch(() => {});
    await sleep(1500);
    await page.unroute('**/task-lists');
    ck('idempotent create: the create really was sent twice (control for the count below)',
        swallowed === 1 && sentKeys.length === 2, `swallowed=${swallowed} sent=${sentKeys.length}`);
    ck('idempotent create: both attempts carried the SAME key', sentKeys.length === 2 && sentKeys[0] && sentKeys[0] === sentKeys[1], JSON.stringify(sentKeys));
    const after = countLists();
    ck('idempotent create: a create whose answer was lost leaves ONE note, not two', after === before + 1, `before=${before} after=${after}`);
    ck('idempotent create: and it appears once on screen', await page.locator('.notes-card:has-text("Lost answer")').count() === 1);
    const onB = await pageB.waitForFunction(() => document.querySelectorAll('.notes-card').length > 0 && [...document.querySelectorAll('.notes-card')].filter(c => /Lost answer/.test(c.innerText)).length === 1, null, { timeout: 15000 }).then(() => true, () => false);
    ck('idempotent create: no duplicate reached the other device either', onB);
    // POSITIVE CONTROL: an ordinary create still makes a second note, so the
    // count above is not passing because nothing was created at all.
    await openComposer();
    await page.fill('.notes-quickadd-title', 'Second note');
    await page.locator('.notes-quickadd-item input').first().fill('A different intent');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.waitForSelector('.notes-card:has-text("Second note")', { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    ck('idempotent create: POSITIVE CONTROL — a fresh create does make a second note', countLists() === after + 1, `after=${after} now=${countLists()}`);
} else {
    skip('idempotent create: a create whose answer was lost leaves exactly one note', 'no psql DSN given');
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

/** Is the element's centre really showing IT (not a drawer or scrim on top)?
 *  Defined here because both passes use it, desktop and phone alike. */
const onTop = (pg, sel) => pg.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && (hit === el || el.contains(hit));
}, sel);

// =============================================================================
// Phone — 390x844, coarse pointer, signed in via the same origin storage
// =============================================================================
const state = await ctx.storageState();
await ctx.close();
const iphone = devices['iPhone 13'];
const mctx = await browser.newContext({ ...iphone, defaultBrowserType: undefined, baseURL, storageState: state, permissions: ['microphone'] });
await watchMicOrder(mctx);
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
// A note's OWN reminder at 390x844, coarse pointer (docs/DESIGN_PHILOSOPHY
// §7): the footer control is a real tap target, its popover fits, and the
// Reminders row keeps its shape.
await m.locator('.notes-card', { hasText: 'Poem' }).tap();
await m.waitForSelector('.notes-editor', { timeout: 8000 });
const mRemind = m.locator('.notes-editor-foot button[aria-label="Remind me"]');
const mRemindBox = await mRemind.boundingBox();
ck('phone: the note\u2019s Remind me button is a 44px target', mRemindBox && mRemindBox.width >= 43.5 && mRemindBox.height >= 43.5, JSON.stringify(mRemindBox));
await mRemind.tap();
await m.waitForSelector('.notes-editor input[aria-label="Remind me at"]', { timeout: 5000 });
const mDue = new Date(Date.now() + 2 * 86400000);
const mpad = n => String(n).padStart(2, '0');
await m.fill('.notes-editor input[aria-label="Remind me at"]', `${mDue.getFullYear()}-${mpad(mDue.getMonth() + 1)}-${mpad(mDue.getDate())}T09:00`);
r = await audit();
const dueBox = await m.locator('.notes-editor .note-due-edit').boundingBox();
ck('phone: the reminder popover fits the viewport and nothing is undersized',
    dueBox && dueBox.x >= -0.5 && dueBox.x + dueBox.width <= 390.5 && !r.bodyScrollsHorizontally && r.under.length === 0,
    JSON.stringify({ dueBox, u: r.under }));
await m.locator('.notes-editor .tt-due-set').tap();
await m.waitForTimeout(600);
await mshot('phone-note-reminder');
await m.locator('.notes-editor button[aria-label="Close note"]').tap();
await m.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 }).catch(() => {});
await m.goto('/notes/#/reminders');
await m.waitForSelector('.notes-reminders', { timeout: 10000 });
await m.waitForSelector('.notes-reminder-row.note', { timeout: 10000 }).catch(() => {});
r = await audit();
const noteRowBox = await m.locator('.notes-reminder-row.note').boundingBox();
ck('phone: the note reminder row keeps its shape at 390 and is not covered',
    noteRowBox && noteRowBox.x >= -0.5 && noteRowBox.x + noteRowBox.width <= 390.5
    && !r.bodyScrollsHorizontally && r.under.length === 0 && await onTop(m, '.notes-reminder-row.note'),
    JSON.stringify({ noteRowBox, u: r.under }));

// The calendar's day list is the ONLY body a coarse pointer gets, and it is
// where a note's reminder stands beside items. A note has nothing to tick
// (CalendarView's onToggleDone refuses it), so the row carries a bell — a
// checkbox here would be a control that silently does nothing, on the one
// surface a phone meets first.
const mDay = `${mDue.getFullYear()}-${mpad(mDue.getMonth() + 1)}-${mpad(mDue.getDate())}`;
await m.goto(`/notes/#/calendar?v=day&d=${mDay}`);
await m.waitForSelector('.cal-daylist', { timeout: 10000 });
const calNoteRow = m.locator('.cal-daylist .cal-row', { hasText: 'Poem' });
await calNoteRow.first().waitFor({ timeout: 10000 }).catch(() => {});
ck('phone calendar: a note’s own reminder has a bell, not a tick box',
    await calNoteRow.count() === 1
    && await calNoteRow.locator('input[type="checkbox"]').count() === 0
    && await calNoteRow.locator('.cal-row-mark').count() === 1,
    JSON.stringify({ rows: await calNoteRow.count() }));
// Positive control on the same list, one day earlier: "Eggs" is a real item
// with a due time, and it keeps the tick box this walk would otherwise never
// have proved the day list draws at all.
const mTom = new Date(); mTom.setDate(mTom.getDate() + 1);
await m.goto(`/notes/#/calendar?v=day&d=${mTom.getFullYear()}-${mpad(mTom.getMonth() + 1)}-${mpad(mTom.getDate())}`);
await m.waitForSelector('.cal-daylist', { timeout: 10000 });
const calItemRow = m.locator('.cal-daylist .cal-row', { hasText: 'Eggs' });
await calItemRow.first().waitFor({ timeout: 10000 }).catch(() => {});
ck('phone calendar: an ITEM row still has its tick box (positive control)',
    await calItemRow.count() === 1
    && await calItemRow.locator('input[type="checkbox"]').count() === 1
    && await calItemRow.locator('.cal-row-mark').count() === 0,
    JSON.stringify({ rows: await calItemRow.count() }));
await mshot('phone-calendar-note-reminder');
await m.goto('/notes/#/reminders');
await m.waitForSelector('.notes-reminders', { timeout: 10000 });
await m.waitForSelector('.notes-reminder-row.note', { timeout: 10000 }).catch(() => {});

// Put it back as the walk found it, so later sections see the same fixture.
await m.locator('.notes-reminder-row.note .notes-reminder-clear').tap();
await m.waitForTimeout(600);
ck('phone: clearing it from the row works with a coarse pointer', await m.locator('.notes-reminder-row.note').count() === 0);

// The OTHER front door at 390x844: Púca's Tasks view mounts the same control,
// and notes-walk exercised it on desktop only. Its buttons are new UI, so they
// take the 44px rule, and its date editor must take a row of its own here too.
await m.goto('/');
await m.waitForSelector('.mobile-nav-btn', { timeout: 20000 });
await m.waitForSelector('.recovery-reminder-actions .recovery-done-btn', { timeout: 4000 })
    .then(() => m.tap('.recovery-reminder-actions .recovery-done-btn'))
    .catch(() => { /* already answered on this profile */ });
await m.tap('.welcome-popup-close', { timeout: 2000 }).catch(() => { /* not shown */ });
await m.locator('.mobile-nav-btn').nth(0).tap();
await m.waitForTimeout(400);
await m.locator('.server-icon.notes-self').tap();
await m.waitForSelector('.tasks-tabbar', { timeout: 20000 });
await m.locator('.tasks-tab', { hasText: 'Poem' }).first().tap();
await m.waitForSelector('.tasks-editor-header', { timeout: 10000 });
const mPucaRemind = m.locator('.tasks-editor-header button[aria-label="Remind me"]');
const mPucaBox = await mPucaRemind.boundingBox();
ck('phone: Púca' + '\u2019' + 's list header offers the reminder, at a 44px target',
    mPucaBox && mPucaBox.width >= 43.5 && mPucaBox.height >= 43.5, JSON.stringify(mPucaBox));
await mPucaRemind.tap();
await m.waitForSelector('.tasks-editor-header input[aria-label="Remind me at"]', { timeout: 5000 });
const mPucaEdit = await m.evaluate(() => {
    const el = document.querySelector('.tasks-editor-header .note-due-edit');
    const title = document.querySelector('.tasks-editor-title');
    if (!el || !title) return null;
    const b = el.getBoundingClientRect(), t = title.getBoundingClientRect();
    const input = el.querySelector('input');
    return {
        ownRow: b.top >= t.bottom - 0.5,
        inside: b.left >= -0.5 && b.right <= window.innerWidth + 0.5,
        font: input ? parseFloat(getComputedStyle(input).fontSize) : 0,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
});
ck('phone: the Púca due editor fits 390, takes its own row, and its input is 16px',
    mPucaEdit && mPucaEdit.ownRow && mPucaEdit.inside && mPucaEdit.font >= 16 && !mPucaEdit.overflow,
    JSON.stringify(mPucaEdit));
await mshot('phone-puca-note-reminder');

await m.goto('/notes/');
await m.waitForSelector('.notes-card', { timeout: 10000 });

// The composer's text mode, camera and drawing on a phone.
await m.tap('.notes-fab');
await m.waitForSelector('.notes-quickadd.sheet', { timeout: 5000 });
ck('phone: the composer offers the camera directly', await m.locator('.notes-quickadd-foot button[aria-label="Take photo"]').count() === 1
    && await m.locator('.notes-quickadd-foot input[capture]').count() === 1);
// "Add file" is a seventh control in a foot that already carried six at
// 390 px: it must fit the row, not push it sideways.
ck('phone: the composer offers Add file, and its foot still fits 390 px',
    await m.locator('.notes-quickadd-foot button[aria-label="Add file"]').count() === 1
    && await m.evaluate(() => {
        const f = document.querySelector('.notes-quickadd-foot');
        return !!f && f.scrollWidth <= f.clientWidth + 1 && f.getBoundingClientRect().right <= window.innerWidth + 1;
    }),
    JSON.stringify(await m.evaluate(() => {
        const f = document.querySelector('.notes-quickadd-foot');
        return f ? { scrollWidth: f.scrollWidth, clientWidth: f.clientWidth, right: Math.round(f.getBoundingClientRect().right) } : null;
    })));
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
// A voice note at 390x844: the recorder sheet and the player must fit.
ck('phone: the composer offers a voice note', await m.locator('.notes-quickadd-foot button[aria-label="Voice note"]').count() === 1);
await m.tap('.notes-quickadd-foot button[aria-label="Voice note"]');
await m.waitForSelector('.notes-recorder', { timeout: 10000 });
const rbx = await m.locator('.notes-recorder').boundingBox();
r = await audit();
ck('phone: the recorder sheet fits the viewport with its targets at size',
    rbx && rbx.x >= -0.5 && rbx.x + rbx.width <= 390.5 && r.under.length === 0 && !r.bodyScrollsHorizontally,
    JSON.stringify({ rbx, u: r.under }));
await mshot('phone-voice-recorder');
await sleep(1000);
await m.tap('.notes-recorder button[aria-label="Stop recording"]');
await m.waitForSelector('.notes-recorder audio', { timeout: 10000 });
await m.getByRole('button', { name: 'Keep' }).tap();
await m.waitForSelector('.notes-quickadd-media audio', { timeout: 10000 });
const plx = await m.locator('.notes-quickadd-media audio').boundingBox();
r = await audit();
ck('phone: the recording player does not overflow 390',
    plx && plx.x >= -0.5 && plx.x + plx.width <= 390.5 && !r.bodyScrollsHorizontally, JSON.stringify(plx));
ck('phone: the recording preview never autoplays',
    await m.locator('.notes-quickadd-media audio').evaluate(a => a.autoplay === false && a.paused === true));
await m.waitForSelector('.notes-quickadd .notes-transcribe-notice', { timeout: 15000 }).catch(() => {});
const mNoticeBox = await m.locator('.notes-quickadd .notes-transcribe-notice').boundingBox().catch(() => null);
ck('phone: the "not written down" line reads at 390 without overflowing',
    mNoticeBox && mNoticeBox.x >= -0.5 && mNoticeBox.x + mNoticeBox.width <= 390.5,
    JSON.stringify(mNoticeBox));
await m.locator('.notes-quickadd.sheet button[aria-label="Discard note"]').tap();
await m.waitForSelector('.notes-quickadd.sheet', { state: 'detached', timeout: 5000 }).catch(() => {});
// The conflict banner at 390x844. The clash itself is scripted — the note's
// own PATCH is answered with the server's refusal, carrying a sealed body the
// page itself produced a moment earlier, so the banner opens REAL ciphertext
// and offers both choices. Everything measured here (the component, its CSS,
// the tap targets) is the shipping one.
await m.goto('/notes/');
await m.waitForSelector('.notes-card:has-text("Poem")', { timeout: 15000 });
await m.locator('.notes-card', { hasText: 'Poem' }).first().tap();
await m.waitForSelector('.notes-editor textarea.nb-text', { timeout: 10000 });
let sealedFromThePage = null;
await m.route('**/task-lists/*', async route => {
    const req = route.request();
    if (req.method() !== 'PATCH') return route.continue();
    let sent = null;
    try { sent = req.postDataJSON(); } catch { /* not JSON */ }
    if (!sealedFromThePage && sent?.body) {
        // The first save goes through, and its ciphertext becomes "their copy".
        sealedFromThePage = sent.body;
        return route.continue();
    }
    return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ conflict: 'stale', content_rev: 9999, title: 'sealed', body: sealedFromThePage, attachments: null }),
    });
});
await m.fill('.notes-editor textarea.nb-text', 'the copy that won');
await m.locator('.notes-editor-title').tap();
await sleep(1500);
await m.fill('.notes-editor textarea.nb-text', 'what this phone typed');
await m.locator('.notes-editor-title').tap();
const phoneBanner = m.locator('.notes-editor [data-conflict="stale"]');
const phoneSawConflict = await phoneBanner.first().waitFor({ timeout: 15000 }).then(() => true, () => false);
ck('phone conflict: the banner appears, with the words this phone typed still in the field', phoneSawConflict
    && (await m.locator('.notes-editor textarea.nb-text').inputValue()) === 'what this phone typed');
const phoneChoices = phoneSawConflict ? await phoneBanner.locator('button').evaluateAll(els => els.map(e => {
    const r = e.getBoundingClientRect();
    return { t: e.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
})) : [];
ck('phone conflict: both choices are full tap targets', phoneChoices.length === 2 && phoneChoices.every(b => b.h >= 44 && b.w >= 44), JSON.stringify(phoneChoices));
r = await audit();
ck('phone conflict: the banner fits — no horizontal overflow, nothing under size', phoneSawConflict && !r.bodyScrollsHorizontally && r.widest <= r.vw + 1 && r.under.length === 0, JSON.stringify({ widest: r.widest, vw: r.vw, under: r.under }));
await mshot('phone-conflict');
await m.unroute('**/task-lists/*');
// Leave the note as the server has it, so nothing downstream sees a half-save.
if (phoneSawConflict) await phoneBanner.locator('[data-action="use-theirs"]').tap().catch(() => {});
await m.keyboard.press('Escape');
await sleep(300);

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

// A note's FILE at a coarse pointer: the download button is a real tap
// target and the name does not push the row off the screen.
await m.goto('/notes/');
await m.waitForSelector('.notes-card', { timeout: 20000 });
await m.locator('.notes-card', { hasText: 'Tickets' }).tap();
await m.waitForSelector('.notes-editor .ni-item.file button.ni-file', { timeout: 15000 });
const fileBox = await m.locator('.notes-editor .ni-item.file button.ni-file').boundingBox();
r = await audit();
ck('phone: a note’s file is a 44px tap target that saves it, inside the viewport',
    !!fileBox && fileBox.height >= 43.5 && fileBox.x >= -0.5 && fileBox.x + fileBox.width <= 390.5
    && !r.bodyScrollsHorizontally && r.under.length === 0,
    JSON.stringify({ fileBox, under: r.under }));
await mshot('phone-file-note');
await m.getByRole('button', { name: 'Close', exact: true }).tap();
await m.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 }).catch(() => {});

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
// The organisation controls at 390x844: the filter belongs in the FIXED
// actions block (the tab bar itself scrolls away), and its popover has to fit
// the screen with every row at size.
const filterBox = await m.locator('.tasks-tab-filter').boundingBox().catch(() => null);
ck('phone púca: the note filter is beside New list and at size', !!filterBox && filterBox.width >= 43.5 && filterBox.height >= 43.5, JSON.stringify(filterBox));
await m.locator('.tasks-tab-filter').tap().catch(() => {});
await m.waitForSelector('.notes-popover .tasks-filter-item', { timeout: 5000 }).catch(() => {});
const fpop = await m.evaluate(() => {
    const p = document.querySelector('.notes-popover');
    if (!p) return null;
    const b = p.getBoundingClientRect();
    const rows = [...p.querySelectorAll('button')].map(x => x.getBoundingClientRect());
    return {
        rows: rows.length,
        inside: b.left >= -0.5 && b.right <= window.innerWidth + 0.5 && b.top >= -0.5 && b.bottom <= window.innerHeight + 0.5,
        small: rows.filter(i => i.height < 43.5).length,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
});
ck('phone púca: the filter popover fits, its rows at size, nothing overflows', !!fpop && fpop.rows >= 2 && fpop.inside && fpop.small === 0 && !fpop.overflow, JSON.stringify(fpop));
await mshot('phone-puca-filter');
await m.keyboard.press('Escape');
await m.waitForSelector('.notes-popover', { state: 'detached', timeout: 5000 }).catch(() => {});
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
        // ---- 15b. The SAME rule in Púca's own Reminders tab -------------------
        // Púca's sources are every member's items in that checklist, not just
        // the caller's, so this line matters MORE here: /task-reminders' channel
        // arm is `created_by = $1` and will never alert this user for it.
        await h.goto('/chat');
        await h.waitForSelector('.chat-container', { timeout: 20000 });
        try { await h.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* no popup */ }
        await h.click('.server-icon.home-button');
        await h.locator('.sidebar-nav .nav-item', { hasText: 'Tasks' }).click();
        await h.waitForSelector('.tasks-tabbar', { timeout: 15000 });
        await dismissRecoveryReminder(h);
        await h.locator('.tasks-tab-reminders').click();
        await h.waitForSelector('.tasks-reminders .notes-reminder-row:has-text("Shared errand")', { timeout: 15000 });
        const prows = await rowFacts(h);
        const phinted = prows.find(x => x.label === 'Shared errand');
        const pmine = prows.find(x => x.label === 'My shared errand');
        ck('púca reminders: the item someone else set says "Reminds whoever set it"', !!phinted && phinted.hint === 'Reminds whoever set it', JSON.stringify(phinted));
        ck('púca reminders: my own shared item does not (control)', !!pmine && pmine.hint === null, JSON.stringify(pmine));
        ck('púca reminders: a second line inside the item cell, not a new column', !!phinted && !!pmine && !!phinted.sub && phinted.cells === pmine.cells && phinted.sub.t >= phinted.text.t + 4, JSON.stringify(phinted));
        await shotOf(h)('puca-reminders-hint-desktop');
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
        // The same view in PÚCA at 390x844: the tab is a whole tap target, the
        // rows fit, and the snooze button is not a 32 px dot on a phone.
        // The phone route into Púca's Tasks view is the bottom nav plus the
        // self-note server icon (the desktop sidebar is not on screen at
        // 390 px) — the same steps section 14's phone pass uses.
        await pg.goto('/chat');
        await pg.waitForSelector('.chat-container', { timeout: 20000 }).catch(() => {});
        try { await pg.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* no popup */ }
        await pg.locator('.mobile-nav-btn').nth(0).tap().catch(() => {});
        await pg.locator('.server-icon.notes-self').tap({ timeout: 5000 }).catch(() => {});
        await pg.waitForSelector('.tasks-tabbar', { timeout: 15000 });
        await dismissRecoveryReminder(pg);
        await pg.locator('.tasks-tab-reminders').tap();
        await pg.waitForSelector('.tasks-reminders .notes-reminder-row:has-text("Shared errand")', { timeout: 15000 });
        // The LAYOUT box, not the rendered one: a tab that has just been
        // tapped is still under the press effect (measured at 0.98 of its
        // size — the shipped Calendar tab does the same), and a momentary
        // animation is not the size of the thing a finger has to hit. The
        // Calendar tab is the positive control for the convention.
        const tapBoxes = await pg.evaluate(() => {
            const box = sel => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { w: el.offsetWidth, h: el.offsetHeight, drawnW: Math.round(r.width * 100) / 100, drawnH: Math.round(r.height * 100) / 100 };
            };
            return { reminders: box('.tasks-tab-reminders'), calendar: box('.tasks-tab-calendar') };
        });
        ck('púca reminders (phone): the tab is a whole tap target, like the Calendar tab beside it',
            !!tapBoxes.reminders && !!tapBoxes.calendar
            && tapBoxes.reminders.w >= 44 && tapBoxes.reminders.h >= 44
            && tapBoxes.calendar.w >= 44 && tapBoxes.calendar.h >= 44,
            JSON.stringify(tapBoxes));
        const pucaPhone = await pg.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
            vw: window.innerWidth,
            rows: [...document.querySelectorAll('.tasks-reminders .notes-reminder-row')].map(r => r.getBoundingClientRect().right),
            box: (() => { const b = document.querySelector('.tasks-reminders input[type="checkbox"]'); return b ? b.getBoundingClientRect().width : 0; })(),
        }));
        ck('púca reminders (phone): no horizontal overflow and every row fits', !pucaPhone.overflow && pucaPhone.rows.length > 0 && pucaPhone.rows.every(r => r <= pucaPhone.vw + 0.5), JSON.stringify(pucaPhone));
        ck('púca reminders (phone): the tick box grew for a finger', pucaPhone.box >= 20, String(pucaPhone.box));
        const snoozeBtn = pg.locator('.tasks-reminders .notes-snooze button').first();
        if (await snoozeBtn.count() === 1) {
            const sb = await snoozeBtn.boundingBox();
            ck('púca reminders (phone): the snooze button is a 44 px target', !!sb && sb.width >= 44 && sb.height >= 44, JSON.stringify(sb));
            await snoozeBtn.tap();
            const presets = await pg.locator('.notes-snooze-menu .notes-textbtn').evaluateAll(els => els.map(e => { const b = e.getBoundingClientRect(); return { h: b.height, r: b.right }; }));
            ck('púca reminders (phone): every snooze preset is 44 px and inside the viewport', presets.length >= 3 && presets.every(p => p.h >= 44 && p.r <= pucaPhone.vw + 0.5), JSON.stringify(presets));
        } else {
            skip('púca reminders (phone): snooze is off on this server (taskFeatures)');
        }
        await shotOf(pg)('puca-reminders-phone');
        // The same 44 px rule on the item ROW's snooze. Reminders.css scopes
        // it to .notes-snooze.tt-snooze: the 30 px siblings beside it in
        // .tt-actions are that row's own long-standing convention.
        await pg.locator('.tasks-tab', { hasText: 'Groceries' }).tap();
        await pg.waitForSelector('.tt-item', { timeout: 15000 });
        const rowSnooze = pg.locator('.tt-item .notes-snooze button').first();
        if (await rowSnooze.count() === 1) {
            const rb = await rowSnooze.boundingBox();
            ck('púca tasks (phone): the item row’s snooze is a 44 px target too', !!rb && rb.width >= 44 && rb.height >= 44, JSON.stringify(rb));
        } else {
            skip('púca tasks (phone): no snoozable item row here (taskFeatures, or nothing dated)');
        }
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
    // A launch payload the walk parks before a reload (sessionStorage
    // survives one, an init script's own state does not). Taken ONCE, like
    // the real plugin's one-shot, so the walk can prove it does not replay.
    const takeParked = key => {
        try {
            const v = JSON.parse(sessionStorage.getItem(key) || 'null');
            sessionStorage.removeItem(key);
            return v;
        } catch { return null; }
    };
    const answers = {
        NotesNative: {
            info: () => ({ api: 2, features: ['reminders', 'backgroundRefresh', 'exactAlarm', 'battery', 'share', 'calendar', 'launchNav', 'shareIn', 'navItem', 'tile'] }),
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
            consumeLaunchNav: () => takeParked('__walkNav') || { target: null, item: -1 },
            consumeLaunchShare: () => takeParked('__walkShare') || { text: null, subject: null, files: [] },
            requestAddTile: () => ({ ok: true }),
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

    // --- the ways INTO the app that are not the launcher icon -----------------
    // A share from another app, a launcher shortcut / quick tile / widget
    // (all four carry one constant word), and a due notification that named
    // the ONE item that came due. Driven through the same fake bridge: the
    // walk parks the launch payload and reloads, which is exactly the cold
    // start the real ones produce.
    const info = await a.evaluate(() => window.Capacitor.nativePromise('NotesNative', 'info', {}));
    ck('android shell: the bridge reports the new entry points (control for every check below)',
        info.api === 2 && ['shareIn', 'navItem', 'tile'].every(f => info.features.includes(f)), JSON.stringify(info));

    const park = async (key, value) => {
        await a.evaluate(([k, v]) => sessionStorage.setItem(k, JSON.stringify(v)), [key, value]);
        await a.reload();
    };
    const sheetOpen = () => a.locator('.notes-quickadd-sheet').count();
    // Back to the grid: these entry points are judged by the cards they add,
    // and the section above left the app on Reminders.
    const toGrid = async () => {
        if (await a.locator('.notes-card').count() > 0) return;
        await a.tap('.notes-menu-btn');
        await a.waitForSelector('.notes-rail.open', { timeout: 5000 });
        await a.locator('.notes-rail-item', { hasText: 'Notes' }).first().tap();
        await a.waitForSelector('.notes-card', { timeout: 15000 });
        await closedDrawer(a);
    };
    await toGrid();

    // 1. A share of text.
    const cardsBefore = await a.locator('.notes-card').count();
    ck('share-in: the walk is on the notes grid to begin with (precondition)', cardsBefore > 0, String(cardsBefore));
    await park('__walkShare', { text: 'Milk and bread', subject: null, files: [] });
    await a.waitForSelector('.notes-quickadd-sheet', { timeout: 15000 }).catch(() => {});
    ck('share-in (390x844): a shared line opens the composer sheet, pre-filled',
        await sheetOpen() === 1 && (await a.locator('.notes-quickadd-sheet input.notes-quickadd-title').inputValue()) === 'Milk and bread');
    ck('share-in: NOTHING is saved until Done', await a.locator('.notes-card').count() === cardsBefore);
    const shareBox = await a.locator('.notes-quickadd-sheet').boundingBox();
    ck('share-in: the seeded composer fits the viewport', !!shareBox && shareBox.x >= -0.5 && shareBox.x + shareBox.width <= 390.5, JSON.stringify(shareBox));
    const shareTaps = await a.evaluate(() => [...document.querySelectorAll('.notes-quickadd-sheet button')]
        .map(b => ({ c: b.className, n: Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height) }))
        .filter(t => t.n > 0));
    // 43.5 (the 44px floor, less sub-pixel layout), NOT the 24 this check
    // shipped with. mobile.css gives every `button` min-height/min-width 44px
    // under a coarse pointer and the Notes page imports it, so all six
    // controls here measure exactly 44 — measured, class by class. A bar at
    // 24 could not go red for the regression it names: a control shrinking to
    // 28px would still have passed it. The class comes out with the number so
    // a failure says WHICH control lost its size.
    ck('share-in: every button in the seeded composer is a full tap target',
        shareTaps.length > 0 && Math.min(...shareTaps.map(t => t.n)) >= 43.5, JSON.stringify(shareTaps));
    await shotOf(a)('share-in-composer');
    // Saving it is the positive control that a seeded composer is a real one.
    await a.locator('.notes-quickadd-sheet .notes-textbtn').tap();
    await a.waitForFunction(n => document.querySelectorAll('.notes-card').length === n + 1, cardsBefore, { timeout: 15000 }).catch(() => {});
    ck('share-in: pressing Done creates exactly one card with the shared text',
        await a.locator('.notes-card').count() === cardsBefore + 1
        && await a.locator('.notes-card', { hasText: 'Milk and bread' }).count() === 1);

    // 2. One-shot: a reload must not bring the same share back.
    await a.reload();
    await a.waitForSelector('.notes-card', { timeout: 20000 });
    ck('share-in: the payload is consumed once — a reload does not replay it', await sheetOpen() === 0);

    // 3. A shared picture: the page fetches it over the app's own origin.
    await park('__walkShare', { text: null, subject: 'Snap', files: [{ url: '/notes/icon-192.png', name: 'shared.png', mime: 'image/png', size: 1 }] });
    await a.waitForSelector('.notes-quickadd-sheet .notes-quickadd-media img', { timeout: 15000 }).catch(() => {});
    ck('share-in: a shared picture arrives as a chip in the composer',
        await a.locator('.notes-quickadd-sheet .notes-quickadd-media img').count() === 1);
    await a.locator('.notes-quickadd-sheet .notes-iconbtn[aria-label="Discard note"]').tap();
    await a.waitForSelector('.notes-quickadd-sheet', { state: 'detached', timeout: 5000 }).catch(() => {});

    // 4. A launcher shortcut / quick tile / widget cell.
    await park('__walkNav', { target: 'compose-list', item: -1 });
    await a.waitForSelector('.notes-quickadd-sheet', { timeout: 15000 }).catch(() => {});
    ck('shortcut/tile/widget: the list target opens the composer as a checklist',
        await sheetOpen() === 1 && await a.locator('.notes-quickadd-sheet .notes-quickadd-item input').count() >= 1);
    await a.locator('.notes-quickadd-sheet .notes-iconbtn[aria-label="Discard note"]').tap();
    await a.waitForSelector('.notes-quickadd-sheet', { state: 'detached', timeout: 5000 }).catch(() => {});
    await park('__walkNav', { target: 'compose-something-later', item: -1 });
    await a.waitForSelector('.notes-card', { timeout: 20000 }).catch(() => {});
    await toGrid();
    ck('shortcut: a word this bundle does not know opens nothing and breaks nothing (forward-compat)',
        await sheetOpen() === 0 && await a.locator('.notes-card').count() > 0);

    // 5. A due notification that named ONE item.
    ck('android shell: an open item id was read off the page traffic (precondition)', !!open, String(taskRows.length));
    if (open) {
        await park('__walkNav', { target: 'reminders', item: open.id });
        await a.waitForSelector('.tt-item.flash', { timeout: 15000 }).catch(() => {});
        ck('reminder tap, one item due: that item\'s note opens with the item flagged',
            await a.locator('.notes-editor').count() === 1 && await a.locator('.tt-item.flash').count() === 1);
        ck('reminder tap: the flagged row is the item that came due',
            await a.locator(`#tt-task-${open.id}.flash`).count() === 1);
        ck('reminder tap: nothing covers the flagged row at 390x844', await onTop(a, '.tt-item.flash'));
        await shotOf(a)('reminder-tap-item');
        await a.keyboard.press('Escape');
        await a.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 }).catch(() => {});

        // The SAME item, a second time, WITHOUT a reload: a repeat or a
        // snooze fires again while the app is still up, and the note must
        // open again. The resolution is a one-shot per TAP, not per id —
        // keyed on the id, this second tap recognised it and opened nothing.
        // Fired through the live listener, not `park`, because park reloads
        // and a reload is a new page session, where the bug cannot happen.
        await a.evaluate(id => {
            for (const cb of (window.__fakeAndroid.listeners['NotesNative:navigate'] || [])) cb({ target: 'reminders', item: id });
        }, open.id);
        await a.waitForSelector('.notes-editor', { timeout: 15000 }).catch(() => {});
        ck('reminder tap: the same item coming due again opens its note a second time',
            await a.locator('.notes-editor').count() === 1
            && await a.locator(`#tt-task-${open.id}.flash`).count() === 1);
        await a.keyboard.press('Escape');
        await a.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 }).catch(() => {});
    }
    await park('__walkNav', { target: 'reminders', item: 99999999 });
    await a.waitForSelector('.notes-reminders', { timeout: 15000 }).catch(() => {});
    ck('reminder tap: an id that is stale by the time of the tap lands on Reminders, never a blank editor',
        await a.locator('.notes-reminders').count() === 1 && await a.locator('.notes-editor').count() === 0);
    await park('__walkNav', { target: 'reminders', item: -1 });
    await a.waitForSelector('.notes-reminders', { timeout: 15000 }).catch(() => {});
    await closedDrawer(a);
    ck('reminder tap, several due: Reminders with nothing flagged, exactly as before',
        await a.locator('.notes-reminders').count() === 1 && await a.locator('.flash').count() === 0);

    // 6. The E2EE line: only ids and times ever went the other way.
    const afterCalls = await a.evaluate(() => JSON.stringify(window.__fakeAndroid.calls));
    ck('share-in / reminder tap: the native side was handed no note content back',
        !/Eggs|Milk|Bread|Groceries|Shared errand/.test(afterCalls), (afterCalls.match(/Eggs|Milk|Bread|Groceries/) || [''])[0]);

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
