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
// offline edit replays when the network returns; and on the phone — two
// columns in grid view and one in list view, no horizontal overflow, every
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
// with a fixed clock beside a DST change, and the phone gate. Last, the label
// pager (notes-walk-pager.mjs): All + one page per label, tabs, swipes.
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
import { pagerWalk } from './notes-walk-pager.mjs';

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
// Every upload this page has ever fetched to decrypt. "Make a copy" must give
// the copy its OWN uploads: a copy that re-pointed at the original's would
// need no new file at all (decryptToBlobUrl caches by id AND key), so a fresh
// id appearing is the evidence that the pictures were encrypted again.
const filesFetched = new Set();
page.on('request', rq => {
    const m = /\/files\/([A-Za-z0-9_-]+)(?:$|[?#])/.exec(rq.url());
    if (m && rq.method() === 'GET') filesFetched.add(m[1]);
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

// ---- 4a. Paste into the composer ----------------------------------------------------
// Playwright cannot put a picture on the real clipboard, so the events are
// synthesized — but they are REAL ClipboardEvents carrying a real
// DataTransfer, dispatched at the element a person would be typing in, so a
// handler wired to the wrong node fails here instead of passing silently.
const pasteText = (selector, text) => page.evaluate(([sel, t]) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no ${sel}`);
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
}, [selector, text]);
const pastePicture = (selector, b64) => page.evaluate(([sel, data]) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
}, [selector, b64]);

await openComposer();
await pasteText('.notes-quickadd-item input', 'Tea\n- Coffee\n[x] Sugar');
await page.waitForSelector('.notes-paste-dialog', { timeout: 5000 }).catch(() => {});
ck('paste: a multi-line paste asks before it creates', await page.locator('.notes-paste-dialog').count() === 1);
ck('paste: the dialog previews every line it will add', (await page.locator('.notes-paste-line').allInnerTexts()).join(',') === 'Tea,Coffee,Sugar');
ck('paste: nothing is created until the dialog is answered', await page.locator('.notes-quickadd-item input').count() === 1);
await shot('paste-confirm');
await page.getByRole('button', { name: 'Add 3 items' }).click();
await page.waitForFunction(() => document.querySelectorAll('.notes-quickadd-item input').length === 3, null, { timeout: 5000 }).catch(() => {});
ck('paste: "Add 3 items" creates one item per line, in order',
    (await page.locator('.notes-quickadd-item input').evaluateAll(els => els.map(e => e.value))).join(',') === 'Tea,Coffee,Sugar');
// A ONE-line paste is never intercepted.
await pasteText('.notes-quickadd-item input', 'Just one');
await sleep(150);
ck('paste: a one-line paste does NOT open the dialog', await page.locator('.notes-paste-dialog').count() === 0);
// A picture pasted into the composer previews like a picked one.
await pastePicture('.notes-quickadd', PNG.toString('base64'));
await page.waitForSelector('.notes-quickadd-media img', { timeout: 5000 }).catch(() => {});
ck('paste: a picture lands in the composer as a picture', await page.locator('.notes-quickadd-media img').count() === 1);
// Discard: this note must not exist for the count/order checks further down.
page.once('dialog', d => d.accept());
await page.click('.notes-quickadd-foot button[aria-label="Discard note"]');
await page.waitForSelector('.notes-quickadd-open', { state: 'detached', timeout: 5000 }).catch(() => {});
ck('paste: the discarded composer left no extra note', await page.locator('.notes-card').count() === 1);

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
// ---- the reminder times: the setting, then the one-tap row that reads it ----------------------
// Set Morning to 07:30 FIRST, so "the preset used the setting" cannot pass by
// landing on the old hardcoded 09:00.
await page.click('button[aria-label="Account and settings"]');
await page.waitForSelector('.notes-menu', { timeout: 5000 });
ck('settings: the account menu has the four reminder times',
    await page.locator('#notes-remind-morning, #notes-remind-afternoon, #notes-remind-evening, #notes-remind-default').count() === 4);
await page.fill('#notes-remind-morning', '07:30');
await page.keyboard.press('Escape');
await sleep(300);
await page.click('button[aria-label="Account and settings"]');
await page.waitForSelector('.notes-menu', { timeout: 5000 });
ck('settings: the changed Morning is kept', await page.locator('#notes-remind-morning').inputValue() === '07:30');
await page.keyboard.press('Escape');
await sleep(200);

// ---- 5. The editor is Púca's TaskTree ----------------------------------------------
await page.locator('.notes-card', { hasText: 'Groceries' }).click();
await page.waitForSelector('.notes-editor .task-tree', { timeout: 15000 });
ck('editor: three TaskTree rows', await page.locator('.notes-editor .tt-item').count() === 3);
// The note's own text, above its items; it saves itself.
await page.fill('.notes-editor-content textarea.nb-text', 'Buy before Friday');
await sleep(1500);
ck('editor: note text saves without a button', await page.locator('.notes-editor .nb-status.failed').count() === 0);
// A picture DROPPED on the open note takes the picker's own seal-and-upload
// path: it must come back decrypted from the server, not merely appear.
await page.evaluate(([sel, data]) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    const el = document.querySelector(sel);
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
}, ['.notes-editor-content', PNG.toString('base64')]);
await page.waitForFunction(() => document.querySelector('.notes-editor .note-images .ni-open img')?.naturalWidth > 0, null, { timeout: 20000 })
    .then(() => ck('drop: a picture dropped on the open note is uploaded, sealed and shown decrypted', true))
    .catch(() => ck('drop: a picture dropped on the open note is uploaded, sealed and shown decrypted', false));
// Put the note back as it was — later checks count this note's pictures.
page.once('dialog', d => d.accept());
await page.click('.notes-editor .note-images button[aria-label="Remove picture"]');
await page.waitForSelector('.notes-editor .note-images .ni-item', { state: 'detached', timeout: 15000 }).catch(() => {});
ck('drop: the dropped picture can be removed again', await page.locator('.notes-editor .note-images .ni-item').count() === 0);
// ---- Links in a note's text (worked out here, never fetched) ------------------------
// Anything this page asks for that is not our own origin would be a favicon,
// an OG scrape or an unfurl — the regression this block exists to catch, and
// one no unit test can see.
const foreignRequests = [];
// "Foreign" means OFF THIS MACHINE. The API is a second local origin in this
// rig, so a baseURL prefix test would call every ordinary fetch a leak — and
// a check that always fails is a check nobody reads.
const watchForeign = rq => {
    const u = rq.url();
    if (/^(data|blob):/.test(u)) return;
    try {
        const h = new URL(u).hostname;
        if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') foreignRequests.push(u);
    } catch { foreignRequests.push(u); }
};
page.on('request', watchForeign);
await page.fill('.notes-editor-content textarea.nb-text',
    'Buy before Friday https://example.com/a and javascript:alert(1) and //evil.example/x');
await page.locator('.notes-editor-sub').click();   // blur → read view
await page.waitForSelector('.notes-editor-content .nb-rendered', { timeout: 10000 }).catch(() => {});
ck('note links: a URL in the note text becomes a link',
    await page.locator('.notes-editor-content .nb-rendered a.note-link').count() === 1);
const noteHref = await page.locator('.notes-editor-content a.note-link').getAttribute('href').catch(() => null);
const noteRel = await page.locator('.notes-editor-content a.note-link').getAttribute('rel').catch(() => null);
ck('note links: the href is the address, opened with noopener AND noreferrer',
    noteHref === 'https://example.com/a' && /noopener/.test(noteRel ?? '') && /noreferrer/.test(noteRel ?? ''),
    `${noteHref} rel=${noteRel}`);
ck('note links: javascript: and a scheme-less //host stay dead text',
    await page.locator('.notes-editor-content a[href^="javascript:"]').count() === 0
    && await page.locator('.notes-editor-content a[href^="//"]').count() === 0);
ck('note links: nothing is fetched to render them', foreignRequests.length === 0, JSON.stringify(foreignRequests.slice(0, 3)));
// A REAL tap, measured. `click({ trial: true })` deliberately dispatches no
// click at all, so it could only ever prove the target was hit-testable — and
// the way this broke was that the FOCUS the tap takes first (Chromium focuses
// an anchor on mousedown; React's onFocus is `focusin`, which bubbles) swapped
// the read view for the textarea before any click could reach the anchor.
// Only a real click, with what it opened read back, can see that.
await page.evaluate(() => {
    window.__opened = [];
    window.__realOpen = window.open;
    window.open = url => { window.__opened.push(String(url)); return null; };
});
await page.locator('.notes-editor-content a.note-link').click();
// Put window.open back before anything else runs on this page: a stub left
// lying about would make a later step's link silently do nothing.
const opened = await page.evaluate(() => { const o = window.__opened; window.open = window.__realOpen; return o; });
const stillRead = await page.locator('.notes-editor-content textarea.nb-text').count() === 0;
ck('note links: a real tap opens the address outside the app, and does NOT open the editor',
    opened.length === 1 && opened[0] === 'https://example.com/a' && stillRead,
    `${JSON.stringify(opened)} stillRead=${stillRead}`);
await shot('note-links');
// Clicking the text — not the link — puts the field back, still editable.
await page.locator('.notes-editor-content .nb-rendered').click({ position: { x: 4, y: 4 } });
ck('note links: clicking the text (not the link) returns to editing',
    await page.locator('.notes-editor-content textarea.nb-text:focus').count() === 1);
// ---- The read/edit swap must be INVISIBLE ------------------------------------------
// Measured in a real browser, because neither half is visible to a unit test
// in jsdom, which does no layout.
//
// The SIZE check is a guard, not a fix: the read view carries BOTH classes
// (`nb-text nb-rendered`), so every rule written for the field already
// reaches it — which is exactly the property that would break silently if
// someone dropped `nb-text` from it while tidying, and the reason
// NoteImages.css merges the two selectors in the first place.
//
// The HEIGHT check is a fix: the swap mounts a FRESH textarea without
// changing the text, so an auto-height effect keyed on the text alone never
// fires for it, and `.nb-text` is overflow:hidden — the note would be
// clipped to two rows until the next keystroke.
const TALL = ['Buy before Friday https://example.com/a', ...Array.from({ length: 9 }, (_, i) => `line ${i + 1}`)].join('\n');
await page.fill('.notes-editor-content textarea.nb-text', TALL);
await page.locator('.notes-editor-sub').click();
await page.waitForSelector('.notes-editor-content .nb-rendered', { timeout: 10000 }).catch(() => {});
const readMetrics = await page.evaluate(() => {
    const el = document.querySelector('.notes-editor-content .nb-rendered');
    return el ? { h: el.getBoundingClientRect().height, font: getComputedStyle(el).fontSize } : null;
});
await page.locator('.notes-editor-content .nb-rendered').click({ position: { x: 4, y: 4 } });
await page.waitForSelector('.notes-editor-content textarea.nb-text', { timeout: 5000 }).catch(() => {});
const editMetrics = await page.evaluate(() => {
    const el = document.querySelector('.notes-editor-content textarea.nb-text');
    return el ? { h: el.getBoundingClientRect().height, font: getComputedStyle(el).fontSize, scroll: el.scrollHeight } : null;
});
ck('note text: the read view and the field are the same size — no reflow on focus',
    !!readMetrics && !!editMetrics && readMetrics.font === editMetrics.font,
    `${readMetrics?.font} vs ${editMetrics?.font}`);
ck('note text: the field comes back at the HEIGHT of the text, not at two rows',
    !!readMetrics && !!editMetrics && editMetrics.h > 100 && Math.abs(editMetrics.h - readMetrics.h) <= 2,
    `read=${readMetrics?.h} edit=${editMetrics?.h}`);
ck('note text: nothing of the note is clipped by the field that came back',
    !!editMetrics && editMetrics.scroll <= Math.ceil(editMetrics.h) + 1,
    `scrollHeight=${editMetrics?.scroll} height=${editMetrics?.h}`);
await page.fill('.notes-editor-content textarea.nb-text', 'Buy before Friday https://example.com/a');
await page.locator('.notes-editor-sub').click();
await sleep(1500);
page.off('request', watchForeign);
// The text's own undo/redo (the browser's native stack is wiped by every
// sync, so the field keeps its own). A paste-sized change is ONE step.
const bodyText = () => page.locator('.notes-editor textarea.nb-text').inputValue();
// The text above HOLDS A LINK, so blurring it swapped the field for the read
// view (NoteBodyField's showRead). Click the text back into a field before
// typing in it — the two features meet here and nowhere else.
if (await page.locator('.notes-editor-content textarea.nb-text').count() === 0) {
    await page.locator('.notes-editor-content .nb-rendered').click({ position: { x: 4, y: 4 } });
    await page.waitForSelector('.notes-editor-content textarea.nb-text', { timeout: 5000 });
}
// A link-free baseline, saved, so the steps below are a plain two-step
// history: with a link in the text every blur swaps the field for the read
// view and there would be no textarea to read back.
await page.fill('.notes-editor-content textarea.nb-text', 'Buy before Friday');
await sleep(1500);
await page.fill('.notes-editor-content textarea.nb-text', 'Buy before Friday, and flowers');
await page.waitForSelector('.notes-editor .nb-histbtn[aria-label="Undo"]', { timeout: 5000 });
await page.click('.notes-editor .nb-histbtn[aria-label="Undo"]');
ck('text undo: one step back in the note text', (await bodyText()) === 'Buy before Friday');
await page.click('.notes-editor .nb-histbtn[aria-label="Redo"]');
ck('text redo: and forward again', (await bodyText()) === 'Buy before Friday, and flowers');
await page.click('.notes-editor .nb-histbtn[aria-label="Undo"]');
await sleep(1500);   // the undone text is what gets saved
ck('text undo: the undone text saves, with no failure', (await bodyText()) === 'Buy before Friday' && await page.locator('.notes-editor .nb-status.failed').count() === 0);
// Put the LINK back, saved: the card and the phone pass below both read this
// note's text expecting an address in it.
await page.fill('.notes-editor-content textarea.nb-text', 'Buy before Friday https://example.com/a');
await page.locator('.notes-editor-sub').click();
await sleep(1500);
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

const dueCount = () => Number(sql(`SELECT count(*) FROM channel_tasks t JOIN task_lists l ON l.id = t.list_id JOIN users u ON u.id = l.owner_id WHERE u.username = '${username}' AND t.due_at IS NOT NULL`));
const duesBefore = psqlDsn ? dueCount() : null;
const presetRow = page.locator('.notes-editor .tt-item', { hasText: 'Bread' }).first();
await presetRow.hover();
await presetRow.locator('.tt-btn[title="Add due time"]').click();
await page.waitForSelector('.tt-due-edit', { timeout: 5000 });
ck('presets: the due editor offers Morning, Afternoon and Evening', await page.locator('.tt-due-presets button').count() === 3);
await page.locator('.tt-due-presets button', { hasText: 'Morning' }).click();
await page.waitForSelector('.notes-editor .tt-item:has-text("Bread") .tt-due', { timeout: 10000 });
const presetDue = await presetRow.locator('.tt-due-label').first().innerText();
ck('presets: Morning wrote the configured time, not 09:00', /07:30/.test(presetDue), presetDue);
ck('presets: one tap set it — no date form is left open', await page.locator('.tt-due-edit input[type="datetime-local"]').count() === 0);
if (psqlDsn) {
    await sleep(800);
    const after = dueCount();
    ck('database: the preset wrote ONE ordinary plaintext due_at (the server learns WHEN, never WHAT)', after === duesBefore + 1, `before=${duesBefore} after=${after}`);
} else {
    skip('database: the preset wrote one plaintext due_at', 'no psql DSN given');
}
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

// ---- List actions: Uncheck all / Delete checked -------------------------------------
const doneBefore = await page.locator('.notes-editor .tt-completed-section .tt-item').count();
const itemsBefore = await page.locator('.notes-editor .tt-item').count();
ck('list actions: there is something ticked to act on', doneBefore > 0 && itemsBefore > doneBefore, `completed=${doneBefore} items=${itemsBefore}`);
// Ticked items are at the bottom with no action taken — the always-on
// invariant, which is why there is no "move checked to bottom" to build.
ck('list actions: ticked items already sit below the open ones', await page.evaluate(() => {
    const open = document.querySelector('.notes-editor .tt-list:not(.completed) .tt-item');
    const done = document.querySelector('.notes-editor .tt-list.completed .tt-item');
    return !!open && !!done && open.getBoundingClientRect().top < done.getBoundingClientRect().top;
}));
await page.click('.notes-editor-foot button[aria-label="List actions"]');
await page.waitForSelector('.notes-list-actions', { timeout: 5000 });
ck('list actions: the menu opens with both rows',
    await page.locator('.notes-list-actions button').count() === 2
    && /Uncheck all \(\d+\)/.test(await page.locator('.notes-list-actions').innerText())
    && /Delete checked \(\d+\)/.test(await page.locator('.notes-list-actions').innerText()));
await shot('list-actions');
await page.getByRole('button', { name: /Uncheck all/ }).click();
await page.waitForSelector('.notes-editor .tt-completed-section', { state: 'detached', timeout: 20000 }).catch(() => {});
ck('uncheck all: the Completed section is gone', await page.locator('.notes-editor .tt-completed-section').count() === 0);
ck('uncheck all: no item was lost', await page.locator('.notes-editor .tt-item').count() === itemsBefore);
await page.waitForSelector('.notes-undo', { timeout: 15000 }).catch(() => {});
ck('uncheck all: an Undo is offered', await page.locator('.notes-undo').count() === 1);
await page.click('.notes-undo .notes-textbtn');
await page.waitForSelector('.notes-editor .tt-completed-section', { timeout: 20000 }).catch(() => {});
ck('uncheck all: Undo puts the ticks back',
    await page.locator('.notes-editor .tt-completed-section .tt-item').count() === doneBefore);
// Delete checked, then Undo: the items come back, still ticked.
page.once('dialog', d => d.accept());
await page.click('.notes-editor-foot button[aria-label="List actions"]');
await page.waitForSelector('.notes-list-actions', { timeout: 5000 });
await page.getByRole('button', { name: /Delete checked/ }).click();
await page.waitForFunction(n => document.querySelectorAll('.notes-editor .tt-item').length === n, itemsBefore - doneBefore, { timeout: 20000 }).catch(() => {});
ck('delete checked: only the ticked items went',
    await page.locator('.notes-editor .tt-item').count() === itemsBefore - doneBefore);
await page.click('.notes-undo .notes-textbtn');
await page.waitForFunction(n => document.querySelectorAll('.notes-editor .tt-item').length === n, itemsBefore, { timeout: 20000 }).catch(() => {});
ck('delete checked: Undo brings the items back, still ticked',
    await page.locator('.notes-editor .tt-item').count() === itemsBefore
    && await page.locator('.notes-editor .tt-completed-section .tt-item').count() === doneBefore);
// ---- 5b. Deleting an item, and Undo -------------------------------------------------
// Bread carries a subtask, so this is a whole subtree leaving and coming back.
const bread = () => page.locator('.notes-editor .tt-item', { hasText: 'Bread' }).first();
await bread().hover();
await bread().locator('.tt-btn[title="Delete"]').click();
await page.waitForSelector('.notes-undo-text:has-text("Deleted")', { timeout: 5000 });
ck('item undo: the item and its subtask leave the list and the undo bar names it',
    await page.locator('.notes-editor .tt-item', { hasText: 'Bread' }).count() === 0
    && await page.locator('.notes-editor .tt-item', { hasText: 'Sourdough' }).count() === 0
    && /Bread/.test(await page.locator('.notes-undo-text').innerText()));
await page.locator('.notes-undo button').click();
await page.waitForFunction(() => [...document.querySelectorAll('.notes-editor .tt-nest .tt-item')].some(li => li.textContent.includes('Sourdough')), null, { timeout: 15000 }).catch(() => {});
ck('item undo: Undo brings the subtree back, still nested',
    await page.locator('.notes-editor .tt-item', { hasText: 'Bread' }).count() === 1
    && await page.locator('.notes-editor .tt-nest .tt-item', { hasText: 'Sourdough' }).count() === 1
    && await page.locator('.notes-undo').count() === 0);
// A NESTED item on its own: its snapshot's root names the live parent it
// hangs under, which is not in the snapshot at all. Deleting a top-level item
// never exercises that, and for one release Undo here restored nothing.
const sourdough = () => page.locator('.notes-editor .tt-nest .tt-item', { hasText: 'Sourdough' }).first();
await sourdough().hover();
await sourdough().locator('.tt-btn[title="Delete"]').click();
await page.waitForSelector('.notes-undo-text:has-text("Deleted")', { timeout: 5000 });
ck('item undo: a nested item leaves on its own, and its parent stays',
    await page.locator('.notes-editor .tt-item', { hasText: 'Sourdough' }).count() === 0
    && await page.locator('.notes-editor .tt-item', { hasText: 'Bread' }).count() === 1
    && /Sourdough/.test(await page.locator('.notes-undo-text').innerText()));
await page.locator('.notes-undo button').click();
await page.waitForFunction(() => [...document.querySelectorAll('.notes-editor .tt-nest .tt-item')].some(li => li.textContent.includes('Sourdough')), null, { timeout: 15000 }).catch(() => {});
ck('item undo: Undo puts a nested item back UNDER its live parent',
    await page.locator('.notes-editor .tt-nest .tt-item', { hasText: 'Sourdough' }).count() === 1
    && await page.locator('.notes-undo').count() === 0);

// ...and letting the window close really does delete it.
const butter = () => page.locator('.notes-editor .tt-item', { hasText: 'Butter' }).first();
await butter().hover();
await butter().locator('.tt-btn[title="Delete"]').click();
await page.waitForSelector('.notes-undo', { state: 'detached', timeout: 15000 });
await page.click('.notes-editor-foot button[aria-label="Refresh this note"]');
await sleep(1500);
ck('item undo: after the window the delete is real', await page.locator('.notes-editor .tt-item', { hasText: 'Butter' }).count() === 0);
// Put Butter back the ordinary way: the checks below count on five items.
await page.fill('.notes-editor-add input', 'Butter');
await page.press('.notes-editor-add input', 'Enter');
await page.waitForFunction(() => [...document.querySelectorAll('.notes-editor .tt-item')].some(li => li.textContent.includes('Butter')), null, { timeout: 15000 });
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
ck('card: a link on the card is marked but NOT tappable (the card opens the note)',
    await groceries().locator('.notes-card-body .note-link').count() === 1
    && await groceries().locator('.notes-card-body a').count() === 0);
ck('rail: the label appears', await page.locator('.notes-rail-item', { hasText: 'Errands' }).count() === 1);
await page.locator('.notes-rail-item', { hasText: 'Errands' }).click();
await page.waitForSelector('h1.notes-section-title', { timeout: 5000 });
// The label is a PAGE of the pager now (NotesPager.tsx): the rail slides the
// pager there, and All keeps its notes until it has slid off screen (so it
// does not go blank on the way out). Count once one page holds a grid.
await page.waitForFunction(() => document.querySelectorAll('.notes-page.live').length === 1, null, { timeout: 5000 }).catch(() => {});
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
// The PINNED section holds one card, which cannot be reordered among
// anything — so the grips belong to the Others section, one per card.
const otherCard = i => page.locator('section[aria-label="Other notes"] .notes-card').nth(i);
const othersSel = 'section[aria-label="Other notes"] .notes-grid.list';
ck('list view: every card in a reorderable section shows a drag grip',
    await page.locator(`${othersSel} .notes-card-grip`).count() === await page.locator(`${othersSel} .notes-card`).count()
    && await page.locator(`${othersSel} .notes-card-grip`).count() > 1);
ck('list view: the one-card pinned section offers no grip (nothing to reorder it among)',
    await page.locator('section[aria-label="Pinned notes"] .notes-card-grip').count() === 0);
// A real Pointer Events drag: press the grip, move past the NEXT card's
// midpoint in steps, release. Playwright's drag helpers do not drive this.
// One slot only, and scrolled into view first: a long drag reaches the
// viewport edge, where the hook's auto-scroll moves the content under the
// pointer and the landing slot stops being predictable from the boxes.
// cardAt(i) is the nth card of ONE section: the drag never leaves it.
const dragOneSlotDown = async cardAt => {
    await cardAt(0).scrollIntoViewIfNeeded();
    await sleep(200);
    const gripBox = await cardAt(0).locator('.notes-card-grip').boundingBox();
    const nextBox = await cardAt(1).boundingBox();
    if (!gripBox || !nextBox) return false;
    const gx = gripBox.x + gripBox.width / 2;
    const gy = gripBox.y + gripBox.height / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    const targetY = nextBox.y + nextBox.height * 0.75;
    for (let i = 1; i <= 10; i++) {
        await page.mouse.move(gx, gy + (targetY - gy) * (i / 10));
        await sleep(20);
    }
    const seen = await page.locator('.notes-grid-drop-indicator').count() === 1;
    await page.mouse.up();
    await sleep(600);
    return seen;
};
const indicatorSeen = await dragOneSlotDown(otherCard);
ck('drag: the insertion line appears while dragging', indicatorSeen);
ck('drag: dropping a card one slot down reorders the others',
    (await othersTitles()).join(',') === 'Holiday photo,Reading,Sketch,Packing,Poem', (await othersTitles()).join(','));
ck('drag: the drop did not open the note (the ghost click is swallowed)', await page.locator('.notes-editor').count() === 0);
ck('drag: the pinned card kept its section', await page.locator('section[aria-label="Pinned notes"] .notes-card').count() === 1);
await shot('list-drag');
// The order must have REACHED task_tab_prefs, not just the local cache.
await page.reload();
await page.waitForSelector('.notes-card', { timeout: 20000 });
await sleep(1000);
ck('drag: the new order survived a reload (it reached the saved tab order)',
    (await othersTitles()).join(',') === 'Holiday photo,Reading,Sketch,Packing,Poem', (await othersTitles()).join(','));
// The PINNED section has its own hook instance, its own drag group and its
// own arm of the shell's section -> visible-keys lookup. Invert that one
// ternary and every pinned drop hands applyVisibleOrder a list that is not a
// permutation of the visible set: it returns null and the card silently snaps
// back. Nothing below the shell can see that, so it is checked here, with two
// pinned cards — the fixture has one the rest of the time.
const pinnedTitles = async () => (await page.locator('section[aria-label="Pinned notes"] .notes-card-title').allInnerTexts()).map(t => t.trim());
const pinnedCard = i => page.locator('section[aria-label="Pinned notes"] .notes-card').nth(i);
await page.locator('section[aria-label="Other notes"] .notes-card', { hasText: 'Sketch' }).hover();
await page.locator('section[aria-label="Other notes"] .notes-card', { hasText: 'Sketch' }).locator('.notes-card-pin').click();
await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Pinned notes"] .notes-card').length === 2, null, { timeout: 10000 });
const pinnedBefore = (await pinnedTitles()).join(',');
const othersBeforePinnedDrag = (await othersTitles()).join(',');
ck('drag: a two-card pinned section offers grips', await page.locator('section[aria-label="Pinned notes"] .notes-card-grip').count() === 2);
await dragOneSlotDown(pinnedCard);
const pinnedAfter = (await pinnedTitles()).join(',');
ck('drag: a drop INSIDE the pinned section reorders the pinned cards',
    pinnedAfter === pinnedBefore.split(',').reverse().join(','), `${pinnedBefore} -> ${pinnedAfter}`);
ck('drag: a pinned drop leaves the other notes exactly as they were',
    (await othersTitles()).join(',') === othersBeforePinnedDrag, (await othersTitles()).join(','));
await page.reload();
await page.waitForSelector('.notes-card', { timeout: 20000 });
await sleep(1000);
ck('drag: the pinned order survived a reload too',
    (await pinnedTitles()).join(',') === pinnedAfter, (await pinnedTitles()).join(','));
// Put the fixture back: swap again (the inverse of a one-slot drag in a
// two-card section), then unpin. WHERE an unpinned note lands is pin
// behaviour, not the drag's — it does not keep its old slot — so only the
// section it lands in is asserted here.
await dragOneSlotDown(pinnedCard);
await page.locator('section[aria-label="Pinned notes"] .notes-card', { hasText: 'Sketch' }).hover();
await page.locator('section[aria-label="Pinned notes"] .notes-card', { hasText: 'Sketch' }).locator('.notes-card-pin').click();
await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Pinned notes"] .notes-card').length === 1, null, { timeout: 10000 });
await sleep(400);
ck('drag: unpinning puts the note back among the others',
    (await othersTitles()).includes('Sketch') && (await othersTitles()).length === 5, (await othersTitles()).join(','));

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
// A result must say WHERE it matched. 'Milk' is the item ticked back in
// section 5, and previewRows never renders a completed row — so without the
// "also matched" line that card would show nothing at all to explain itself.
await page.fill('.notes-search input', 'bread');
await sleep(300);
ck('search: the matching words are highlighted on the card',
    await page.locator('.notes-card mark.notes-hl').count() >= 1
    && /bread/i.test(await page.locator('.notes-card mark.notes-hl').first().innerText()),
    await page.locator('.notes-card mark.notes-hl').first().innerText().catch(() => 'none'));
await page.fill('.notes-search input', 'milk');
await sleep(300);
const foundRow = await page.locator('.notes-card-found-row').first().innerText().catch(() => '');
ck('search: a match on a TICKED item is still explained', /ticked/.test(foundRow) && /Milk/i.test(foundRow), foundRow);
ck('search: the ticked item is not in the card\u2019s item list', await page.locator('.notes-card-item-text', { hasText: 'Milk' }).count() === 0);
// Opening a result steps through its matches.
await page.fill('.notes-search input', 'bread');
await sleep(300);
await page.locator('.notes-card', { hasText: 'Groceries' }).click();
await page.waitForSelector('.notes-editor .task-tree', { timeout: 15000 });
const matchBar = await page.locator('.notes-editor-matches').innerText().catch(() => '');
ck('search: the open note counts its matches', /\d+ of \d+/.test(matchBar), matchBar);
ck('search: the open note highlights the matching item', await page.locator('.notes-editor mark.notes-hl').count() >= 1);
await page.click('.notes-editor button[aria-label="Next match"]');
await sleep(300);
ck('search: Next match marks exactly one as the current match', await page.locator('.notes-editor mark.notes-hl.current').count() === 1);
await shot('search-highlight');
await page.locator('.notes-editor-foot').getByRole('button', { name: 'Close', exact: true }).click();
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });

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

// Moving a reminder from the row itself — the commonest thing to do with one,
// and it must not mean opening the note.
const eggsReminder = page.locator('.notes-reminder-row', { hasText: 'Eggs' });
const whenBefore = await eggsReminder.locator('.notes-reminder-when').innerText();
await eggsReminder.locator('button[aria-label^="Change the time"]').click();
await page.waitForSelector('.notes-retime input[type="datetime-local"]', { timeout: 5000 });
ck('reminders: a plain dated item retimes from the row, with the note closed',
    await page.locator('.notes-retime input[type="datetime-local"]').count() === 1 && await page.locator('.notes-editor').count() === 0);
const later = new Date(); later.setDate(later.getDate() + 3); later.setHours(18, 45, 0, 0);
const p2 = x => String(x).padStart(2, '0');
const retimeTo = `${later.getFullYear()}-${p2(later.getMonth() + 1)}-${p2(later.getDate())}T18:45`;
await page.fill('.notes-retime input[type="datetime-local"]', retimeTo);
// Let React take the typed value before Set: fill() and click() land in
// consecutive events, which no human can do, and a Set that ran against the
// old draft would look exactly like a broken retime.
await sleep(250);
ck('reminders: the field took the typed time', await page.locator('.notes-retime input[type="datetime-local"]').inputValue() === retimeTo);
// Watch the write itself: "the row did not change" could mean the client
// never sent anything OR that the server refused it, and those are different
// bugs. The PATCH answers that without guessing.
const retimePatch = page.waitForResponse(r => r.request().method() === 'PATCH' && /\/tasks\/\d+/.test(r.url()), { timeout: 15000 }).catch(() => null);
await page.locator('.notes-retime button', { hasText: 'Set' }).click();
const retimeResp = await retimePatch;
ck('reminders: the retime reached the server and was accepted', !!retimeResp && retimeResp.status() < 300,
    retimeResp ? `${retimeResp.status()} ${retimeResp.url().replace(/^https?:\/\/[^/]+/, '')}` : 'no PATCH was sent at all');
// Wait on THIS item's row, not on the first row in the list: another
// reminder sits above it, so `document.querySelector('.notes-reminder-when')`
// already reads a different time and the wait would return at once — leaving
// the assertion to race the re-render.
await page.waitForFunction(
    prev => {
        const row = [...document.querySelectorAll('.notes-reminder-row')].find(r => r.textContent.includes('Eggs'));
        const el = row && row.querySelector('.notes-reminder-when');
        return !!el && el.textContent.trim() !== prev;
    },
    whenBefore, { timeout: 10000 },
).catch(() => {});
const whenAfter = await eggsReminder.locator('.notes-reminder-when').innerText();
ck('reminders: the row shows the new time and the note never opened',
    whenAfter !== whenBefore && /18:45/.test(whenAfter) && await page.locator('.notes-editor').count() === 0, `${whenBefore} -> ${whenAfter}`);
ck('reminders: the field closed itself after Set', await page.locator('.notes-retime input[type="datetime-local"]').count() === 0);
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
// Escape while a row is open belongs to the ROW. NotesDialog listens for it on
// document in the CAPTURE phase, so an onKeyDown on the input could never have
// beaten it there: the dialog took `escapeBlocked` and LabelManager now listens
// the same way (LabelManager.tsx).
await page.click('.notes-labelmgr-row button[aria-label="Rename Chores"]');
await page.fill('.notes-labelmgr-row.editing input', 'Nonsense');
await page.keyboard.press('Escape');
await sleep(200);
ck('label manager: Escape cancels the rename and leaves the dialog open',
    await page.locator('.notes-labelmgr-row.editing').count() === 0
    && await page.locator('.notes-labelmgr-row').count() > 0
    && await page.locator('.notes-rail-item', { hasText: 'Nonsense' }).count() === 0,
    await mgrText());
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
const followed = await page.locator('h1.notes-section-title').textContent();
ck('label manager: the open label view follows the rename',
    /Label: Errands/.test(followed) && await page.locator('.notes-card').count() >= 1, followed);
// ...and Undo has to bring the ROUTE back with the map. Restoring the labels
// un-makes the name this view is filtered by, so staying here would leave an
// empty grid under a heading naming a label that is no longer in the rail.
await page.locator('.notes-undo button').click();
await sleep(400);
const restored = await page.locator('h1.notes-section-title').textContent();
ck('label manager: Undo of a rename brings the label view back too',
    /Label: Chores/.test(restored) && await page.locator('.notes-card').count() >= 1, restored);
// Put the rename back: the rest of the walk (and the ciphertext check) names Errands.
await page.click('.notes-labelmgr-row button[aria-label="Rename Chores"]');
await page.fill('.notes-labelmgr-row.editing input', 'Errands');
await page.press('.notes-labelmgr-row.editing input', 'Enter');
await sleep(400);
ck('label manager: the rename is back on', /Label: Errands/.test(await page.locator('h1.notes-section-title').textContent()));
await page.keyboard.press('Escape');
await sleep(200);
await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();
await sleep(300);

// A SEARCH on top of a label route is still the label route. The search text
// lives in component state, not in the URL, so /label/<name> is where we are
// — but the grid's filter reports 'search' the moment the box has text, and
// a rename decided on that filter moved nothing: the view stayed on a route
// naming a label that had just ceased to exist, and Undo could not bring it
// back either (NotesShell's isLabelRoute).
await page.locator('.notes-rail-item', { hasText: 'Errands' }).click();
await page.waitForSelector('h1.notes-section-title', { timeout: 5000 });
await page.fill('.notes-search input', 'e');
await sleep(300);
const searchedLabelUrl = page.url();
ck('label manager: a search on a label route leaves the route alone',
    /\/label\/Errands/.test(searchedLabelUrl), searchedLabelUrl);
await openLabelMgr();
await page.click('.notes-labelmgr-row button[aria-label="Rename Errands"]');
await page.fill('.notes-labelmgr-row.editing input', 'Chores');
await page.press('.notes-labelmgr-row.editing input', 'Enter');
await sleep(400);
const followedWithSearch = page.url();
ck('label manager: the route follows the rename even with a search on top',
    /\/label\/Chores/.test(followedWithSearch), followedWithSearch);
// ...and Undo puts both the map and the route back.
await page.keyboard.press('Escape');
await sleep(200);
await page.locator('.notes-undo button').click();
await sleep(400);
const returnedWithSearch = page.url();
ck('label manager: Undo returns to the label route with a search on top',
    /\/label\/Errands/.test(returnedWithSearch), returnedWithSearch);
// Clear the search: the heading proves the route is a live label view and
// not an empty grid under a stale name.
await page.fill('.notes-search input', '');
await sleep(300);
const headingAfter = await page.locator('h1.notes-section-title').textContent();
ck('label manager: the returned route is the real label view',
    /Label: Errands/.test(headingAfter) && await page.locator('.notes-card').count() >= 1, headingAfter);
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

// ---- 12c. Make a copy: the WHOLE note ---------------------------------------------------------
// Groceries by now has mint, the label Errands, note text, a ticked item, a
// nested subtask and a due time — a copy used to carry only the text and the
// OPEN items, flattened.
await webGroceries.hover();
await webGroceries.locator('button[aria-label="More actions"]').click();
await page.locator('.context-menu-item', { hasText: 'Make a copy' }).click();
await page.waitForSelector('.notes-editor .task-tree', { timeout: 25000 });
ck('copy: the copy opens, titled "Groceries (copy)"', (await page.locator('.notes-editor-title').inputValue()) === 'Groceries (copy)');
// The text holds a link, so the closed field is the READ view, not a
// textarea (NoteBodyField's showRead): read whichever is on screen.
const copiedBody = await page.locator('.notes-editor textarea.nb-text').count() === 1
    ? await page.locator('.notes-editor textarea.nb-text').inputValue()
    : (await page.locator('.notes-editor .nb-rendered').innerText()).trim();
ck('copy: the note text came too', copiedBody === 'Buy before Friday https://example.com/a', copiedBody);
ck('copy: the TICKED item came too, still ticked', await page.locator('.notes-editor .tt-completed-section .tt-item', { hasText: 'Milk' }).count() === 1);
ck('copy: nesting survived', await page.locator('.notes-editor .tt-nest .tt-item', { hasText: 'Sourdough' }).count() === 1);
ck('copy: a due time came with its item', await page.locator('.notes-editor .tt-item', { hasText: 'Eggs' }).first().locator('.tt-due').count() === 1);
ck('copy: it takes the colour and the labels, and is not pinned',
    await page.locator('.notes-editor[data-color="mint"]').count() === 1
    && /Errands/.test(await page.locator('.notes-editor-sub').innerText())
    && await page.locator('.notes-editor button[aria-label="Pin note"]').count() === 1);
await shot('copy-of-a-note');
await page.locator('.notes-editor-title').blur();
await page.keyboard.press('Escape');
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });

// A photo note: the pictures come too, as the copy's OWN uploads.
const photoSrc = page.locator('.notes-card').filter({ has: page.locator('.notes-card-title', { hasText: /^Holiday photo$/ }) });
const knownFiles = new Set(filesFetched);
await photoSrc.hover();
await photoSrc.locator('button[aria-label="More actions"]').click();
await page.locator('.context-menu-item', { hasText: 'Make a copy' }).click();
await page.waitForFunction(() => {
    const img = document.querySelector('.notes-editor .note-images img');
    return !!img && img.naturalWidth > 0;
}, null, { timeout: 30000 }).catch(() => {});
ck('copy: the picture came with the copy, and it decrypts', await page.evaluate(() => {
    const img = document.querySelector('.notes-editor .note-images img');
    return !!img && img.naturalWidth > 0;
}));
const freshFiles = [...filesFetched].filter(id => !knownFiles.has(id));
ck('copy: the picture is the COPY’s OWN upload, not the original’s',
    freshFiles.length >= 1, JSON.stringify({ fresh: freshFiles.length, before: knownFiles.size }));
// The Close button, not Escape: a note with no items autofocuses its add
// row, and Escape inside an input belongs to the input.
await page.getByRole('button', { name: 'Close', exact: true }).click();
await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
ck('copy: both notes are there — the original and its copy',
    await page.locator('.notes-card').filter({ has: page.locator('.notes-card-title', { hasText: /^Holiday photo$/ }) }).count() === 1
    && await page.locator('.notes-card').filter({ has: page.locator('.notes-card-title', { hasText: /^Holiday photo \(copy\)$/ }) }).count() === 1);
// Put the copies away again: every section below names its fixtures by title,
// and "Groceries" must go on meaning ONE card. (That the copy owns its own
// uploads — so deleting either note forever never touches the other's
// pictures — is pinned by the fresh-file check above and by
// src/tests/notesCopyFidelity.test.tsx.)
for (const title of ['Groceries (copy)', 'Holiday photo (copy)']) {
    const copyCard = page.locator('.notes-card', { hasText: title });
    await copyCard.hover();
    await copyCard.locator('button[aria-label="More actions"]').click();
    await page.locator('.context-menu-item', { hasText: 'Move to trash' }).click();
    await page.waitForSelector('.notes-undo-text:has-text("to the trash")', { timeout: 8000 });
    await page.locator('.notes-undo').waitFor({ state: 'detached', timeout: 12000 });
}
ck('copy: the copies are put away, so one card means one note again',
    await page.locator('.notes-card', { hasText: '(copy)' }).count() === 0
    && await page.locator('.notes-card').filter({ has: page.locator('.notes-card-title', { hasText: /^Groceries$/ }) }).count() === 1);
await sleep(200);
// ---- 12c. Púca's own Tasks view: the same note text, read AND edited there ----------------------------
await page.goto('/chat');
await page.waitForSelector('.chat-container', { timeout: 20000 });
try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* no popup */ }
// Púca asks about a recovery code ~3 s after it mounts, and the overlay
// swallows clicks wherever it lands. This used to be answered forty lines
// below, on the assumption that the section outlasts it; under load it arrived
// mid-section instead and intercepted the trash click. Answer it here, while
// nothing else is happening. It is not under test.
await page.waitForSelector('.recovery-done-btn', { timeout: 8000 })
    .then(() => page.click('.recovery-done-btn'))
    .catch(() => { /* not shown */ });
await page.click('.server-icon.home-button');
await page.locator('.sidebar-nav .nav-item', { hasText: 'Tasks' }).click();
await page.waitForSelector('.tasks-tabbar', { timeout: 15000 });
await dismissRecoveryReminder(page);
// Púca asks, 3 s after it mounts, about a recovery code generated at sign-up
// and never confirmed. It is a FULL-SCREEN overlay that swallows every click,
// so it is answered here, before the board is driven, rather than after. The
// helper above answers it if it is already up; this waits out the 3 s for the
// one that has not appeared yet, and then waits for the overlay to go.
await sleep(3500);
await page.waitForSelector('.recovery-reminder-actions .recovery-done-btn', { timeout: 2000 })
    .then(() => page.click('.recovery-reminder-actions .recovery-done-btn'))
    .catch(() => { /* not shown */ });
await page.waitForSelector('.recovery-modal-overlay .recovery-done-btn', { timeout: 2000 })
    .then(() => page.click('.recovery-modal-overlay .recovery-done-btn'))
    .catch(() => { /* not shown */ });
await page.waitForSelector('.recovery-modal-overlay', { state: 'detached', timeout: 5000 }).catch(() => {});
await page.waitForSelector('.checklist-card:has-text("Poem") .tasks-card-body', { timeout: 10000 }).catch(() => {});
// Parity: the ONE sealed document, seen through the other front door.
// Groceries was coloured mint and labelled Errands in Notes (§5-6); Packing
// was archived there (§10).
// The NOTE tabs: everything on the bar that is not one of the three pinned
// views (All tasks, Calendar, Reminders — Reminders arrived with this release).
const barTabs = () => page.locator('.tasks-tab-scroll .tasks-tab:not(.tasks-tab-all):not(.tasks-tab-calendar):not(.tasks-tab-reminders)');
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
        // clientWidth here too, though this page is the 1280 desktop one (no
        // isMobile, so innerWidth does not widen): in a HEADED run innerWidth
        // counts the vertical scrollbar, which would hide a 15px overflow.
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
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
// THE OTHER FRONT DOOR, with that reminder still set. Section 9 walked this
// row in P\u00faca Notes; here it has to be in P\u00daCA's own Reminders tab, over the
// same note. The twelve-branch merge shipped a Tasks view that could SET a
// note's reminder and two dated tabs that read a projection built from task
// rows only \u2014 so the row, and every `isNote` branch written for it, was
// unreachable from this side and no single-branch walk could have seen it.
await page.locator('.tasks-tab-reminders').click();
await page.waitForSelector('.tasks-reminders .notes-reminders', { timeout: 10000 });
const pucaPoemRow = () => page.locator('.tasks-reminders .notes-reminder-row', { hasText: 'Poem' });
await page.waitForSelector('.tasks-reminders .notes-reminder-row.note', { timeout: 15000 }).catch(() => {});
ck('p\u00faca reminders: a note reminder set HERE is listed here', await pucaPoemRow().count() === 1);
ck('p\u00faca reminders: it reads as the note itself \u2014 a bell, no tick box, no snooze',
    await page.locator('.tasks-reminders .notes-reminder-row.note').count() === 1
    && /This note itself/.test(await pucaPoemRow().innerText())
    && await pucaPoemRow().locator('input[type="checkbox"]').count() === 0
    && await pucaPoemRow().locator('.notes-snooze').count() === 0);
// The note row is drawn from the lists the view already holds; the ITEM rows
// arrive with the per-list reads, so this control has to wait for them or it
// races the fetch (it did, once in five runs).
await page.waitForSelector('.tasks-reminders .notes-reminder-row:not(.note) input[type="checkbox"]', { timeout: 15000 }).catch(() => {});
ck('p\u00faca reminders: an ITEM row still has its tick box (positive control)',
    await page.locator('.tasks-reminders .notes-reminder-row:not(.note) input[type="checkbox"]').count() >= 1);
await shot('puca-note-reminder-row');
// Clear it from the row \u2014 the one thing that row offers \u2014 and the note's own
// chip goes with it, because the row and the header write through one setter.
// Guarded: with no row there is nothing to click, and a walk that throws here
// would take every later section down with it instead of reporting this one.
if (await pucaPoemRow().count() === 1) {
    await pucaPoemRow().locator('.notes-reminder-clear').click();
    await sleep(800);
    ck('p\u00faca reminders: clearing it from the row removes the row', await pucaPoemRow().count() === 0);
    await page.locator('.tasks-tab', { hasText: 'Poem' }).click();
    await page.waitForSelector('.tasks-editor-header', { timeout: 10000 });
    ck('p\u00faca reminders: and the note\u2019s own chip went with it',
        await page.locator('.tasks-editor-header .note-due-chip').count() === 0);
    // Set it again, so the header's own clear below still has something to clear.
    await page.locator('.tasks-editor-header button[aria-label="Remind me"]').click();
    await page.waitForSelector('.tasks-editor-header input[aria-label="Remind me at"]', { timeout: 5000 });
    await page.fill('.tasks-editor-header input[aria-label="Remind me at"]', `${pucaDue.getFullYear()}-${ppad(pucaDue.getMonth() + 1)}-${ppad(pucaDue.getDate())}T09:00`);
    await page.locator('.tasks-editor-header .tt-due-set').click();
    await sleep(800);
    ck('p\u00faca: the chip is back (control for the clear that follows)', await page.locator('.tasks-editor-header .note-due-chip').count() === 1);
} else {
    ck('p\u00faca reminders: clearing it from the row removes the row', false, 'the row was never listed, so Clear could not be reached');
    ck('p\u00faca reminders: and the note\u2019s own chip went with it', false, 'not reached');
    await page.locator('.tasks-tab', { hasText: 'Poem' }).click();
    await page.waitForSelector('.tasks-editor-header', { timeout: 10000 });
}

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
// A second chance at the same reminder, in case it had not appeared yet when
// this section started (it is answered above).
await page.waitForSelector('.recovery-reminder-actions .recovery-done-btn', { timeout: 4000 })
    .then(() => page.click('.recovery-reminder-actions .recovery-done-btn'))
    .catch(() => { /* not shown */ });
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
// 20 s, the budget its two neighbours already use, not the 10 s it shipped
// with. Device B learns about a PERSONAL note's items from the live event
// stream: the server sends the owner's other streams `{"t":"list","id":N}`
// (src/task_events.rs, personal events go to their owner), and B invalidates
// that note's items and refetches them (notes/model/taskEvents.ts). An
// earlier version of this comment said a personal list never broadcasts; it
// does. The claim is unchanged: the item created offline must reach device B,
// which is what proves its temp id was rewritten on replay. If this goes red
// while the neighbours pass, look in the DATABASE first: on 2026-09-24 it went
// red once in seven full walks with the item on the server, top-level and
// sealed (the replay was right), so the miss was B's event or refetch.
const itemOnB = await pageB.waitForFunction(() => /Written on a plane/.test(document.body.innerText), null, { timeout: 20000 }).then(() => true, () => false);
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
// The reminder times follow the account: device B pulls the sealed document
// on focus, so re-open its menu until it has (bounded), never forever.
let bMorning = '';
for (let i = 0; i < 6 && bMorning !== '07:30'; i++) {
    await pageB.bringToFront();
    await sleep(1000);
    await pageB.click('button[aria-label="Account and settings"]');
    await pageB.waitForSelector('.notes-menu', { timeout: 5000 });
    bMorning = await pageB.locator('#notes-remind-morning').inputValue();
    await pageB.keyboard.press('Escape');
    await sleep(200);
}
ck('settings: the reminder times reach a second device', bMorning === '07:30', bMorning);
await page.bringToFront();
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
        ck('database: the colour/label blob is ciphertext only', blob.length > 0 && !/Synced|Errands|Chores|Trip|sage|mint/.test(blob), blob.slice(0, 60));
        ck('database: the colour/label blob is ciphertext only', blob.length > 0 && !/Synced|Errands|sage|mint/.test(blob), blob.slice(0, 60));
        // The reminder times ride in that same document: the server must see
        // no 07:30 anywhere, only the plaintext due_at the preset wrote.
        ck('database: the reminder times are inside the ciphertext, not beside it', !/07:30/.test(blob));
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
    // Through the SETTLED opener (openComposerOn above), like every other
    // composer in this walk. Waiting for the title field alone let the fill
    // race the composer's first-frame focus: the typed title was lost and
    // the notes were made as "Only once" and "A different intent" (read back
    // off the grid, 2026-09-23), so the "Lost answer" card never appeared —
    // three FAILs that said nothing about idempotent creates.
    const openComposer = async () => {
        if (await page.locator('.notes-quickadd-collapsed').count() > 0) await openComposerOn(page)();
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

// ---- 12e. Send a note into Púca (a channel or a DM) -------------------------------------------------
// Its OWN context, for two reasons: the websocket counter below must see only
// what the NOTES page opens (the `page` above has visited /chat, which opens
// one by design), and the picker must be read on a freshly loaded Notes.
{
    const sctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL, storageState: await ctx.storageState() });
    const sp = await sctx.newPage();
    watch(sp);
    const notesSockets = [];
    sp.on('websocket', ws => notesSockets.push(ws.url()));
    await sp.goto('/notes/');
    await sp.waitForSelector('.notes-card', { timeout: 20000 });
    const sapi = await apiBaseOf(sp);
    ck('send setup: the API base was read off the page', !!sapi, String(sapi));
    const mkServer = await authed(sp, sapi, 'POST', '/servers', { name: 'Walk send' });
    ck('send setup: a server was created (positive control)', mkServer.status >= 200 && mkServer.status < 300, `${mkServer.status} ${mkServer.body.slice(0, 120)}`);
    const sendServerId = JSON.parse(mkServer.body).id;
    const chanList = await authed(sp, sapi, 'GET', `/servers/${sendServerId}/channels`);
    const textChannel = JSON.parse(chanList.body).find(c => c.channel_type === 0);
    ck('send setup: the server has a text channel', !!textChannel, textChannel ? `#${textChannel.name}` : chanList.body.slice(0, 120));
    // A second text channel, turned into a CHECKLIST channel — the one thing
    // the picker must never offer (its feed IS a note).
    const mkList = await authed(sp, sapi, 'POST', `/servers/${sendServerId}/channels`, { name: 'walk-list', channel_type: 0 });
    let listChannelId = null;
    if (mkList.status >= 200 && mkList.status < 300) listChannelId = JSON.parse(mkList.body).id;
    if (psqlDsn && listChannelId != null) sql(`UPDATE channels SET has_checklist = true WHERE id = ${listChannelId}`);

    await sp.reload();
    await sp.waitForSelector('.notes-card:has-text("Poem")', { timeout: 20000 });
    await sp.locator('.notes-card', { hasText: 'Poem' }).hover();
    await sp.locator('.notes-card', { hasText: 'Poem' }).locator('button[aria-label="More actions"]').click();
    await sp.waitForSelector('.context-menu', { timeout: 5000 });
    ck('send: the card menu offers "Send to Púca…"', await sp.locator('.context-menu-item', { hasText: 'Send to Púca' }).count() === 1);
    await sp.locator('.context-menu-item', { hasText: 'Send to Púca' }).click();
    await sp.waitForSelector('.notes-send-target', { timeout: 15000 });
    const sendRows = (await sp.locator('.notes-send-target').allInnerTexts()).map(t => t.trim());
    ck('send: the picker lists the text channel', sendRows.some(t => t.includes(textChannel.name)), sendRows.join(' | '));
    if (psqlDsn && listChannelId != null) {
        ck('send: a CHECKLIST channel is not offered (its feed is a note already)', !sendRows.some(t => t.includes('walk-list')), sendRows.join(' | '));
    } else {
        skip('send: a CHECKLIST channel is not offered', 'no psql DSN: the walk cannot flip has_checklist');
    }
    await shot('send-picker');

    await sp.locator('.notes-send-target', { hasText: textChannel.name }).click();
    await sp.waitForSelector('.notes-send-confirm', { timeout: 5000 });
    const confirmText = await sp.locator('.notes-send-confirm').innerText();
    ck('send: picking a target asks first and names it', new RegExp('#' + textChannel.name).test(confirmText) && /read it/.test(confirmText), confirmText.slice(0, 160).replace(/\n/g, ' '));
    const beforeSend = await authed(sp, sapi, 'GET', `/channels/${textChannel.id}/messages?limit=50`);
    ck('send: NOTHING is posted until Send is pressed', JSON.parse(beforeSend.body).length === 0, beforeSend.body.slice(0, 120));
    await shot('send-confirm');
    await sp.locator('.notes-send-go').click();
    await sp.waitForSelector('.notes-send-confirm', { state: 'detached', timeout: 20000 }).catch(() => {});
    await sleep(1500);
    const afterSend = JSON.parse((await authed(sp, sapi, 'GET', `/channels/${textChannel.id}/messages?limit=50`)).body);
    ck('send: exactly one message landed in the channel', afterSend.length === 1, String(afterSend.length));
    ck('send: what the SERVER stores is ciphertext, not the note', afterSend.length === 1
        && !/Roses are red/.test(afterSend[0].content) && /^\{"v"|^v\d:/.test(afterSend[0].content),
        afterSend.length === 1 ? afterSend[0].content.slice(0, 60) : 'no message');
    ck('send: the Notes page never opened a WebSocket', notesSockets.length === 0, notesSockets.join(', '));

    // Read it back where a person would: Púca's own channel view decrypts it.
    const rp = await sctx.newPage();
    watch(rp);
    await rp.goto('/chat');
    await rp.waitForSelector('.chat-container', { timeout: 20000 });
    try { await rp.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* no popup */ }
    await rp.locator('.server-icon[title="Walk send"]').click();
    await rp.waitForSelector('.channel .channel-name', { timeout: 15000 });
    await rp.locator('.channel', { hasText: textChannel.name }).first().click();
    const landed = await rp.waitForSelector('.message-content:has-text("Roses are red")', { timeout: 20000 }).then(() => true, () => false);
    ck('send: the note reads as ordinary text in the channel', landed);
    const posted = landed ? await rp.locator('.message-content').last().innerText() : '';
    ck('send: no decrypt-failure marker was posted as content', landed && !/Encrypted —|Unable to decrypt/.test(posted), posted.slice(0, 120).replace(/\n/g, ' '));
    await shot('send-landed');
    await rp.close();

    // The phone: the sheet is where the Notes Android shell's ONLY route into a
    // conversation lives (it has no "Open in Púca"), so it must fit the phone.
    const spctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined, baseURL, storageState: await ctx.storageState() });
    const spp = await spctx.newPage();
    watch(spp);
    await spp.goto('/notes/');
    await spp.waitForSelector('.notes-card:has-text("Poem")', { timeout: 20000 });

    // The open note's footer at phone width: eight buttons do not fit 390px, so
    // "Open in Púca" is the one that goes. It is hidden by its OWN class now,
    // not by a `> a` element selector, and Send must still be there — it is the
    // Notes Android shell's only route into a conversation.
    await spp.locator('.notes-card', { hasText: 'Poem' }).tap();
    await spp.waitForSelector('.notes-editor', { timeout: 10000 });
    ck('phone editor: "Send to Púca" is in the footer',
        await spp.locator('.notes-editor-foot button[aria-label="Send to Púca"]').count() === 1);
    // In the DOM but not visible — its own positive control: a missing class
    // reads as count 0, a broken rule reads as visible, and both are red.
    const openInPuca = spp.locator('.notes-editor-foot .notes-open-puca');
    const openInPucaCount = await openInPuca.count();
    ck('phone editor: "Open in Púca" is rendered but hidden by the phone rule (the card menu still offers it)',
        openInPucaCount === 1 && (await openInPuca.isVisible()) === false, `count=${openInPucaCount}`);
    ck('phone editor: the footer does not overflow 390px',
        await spp.evaluate(() => {
            const f = document.querySelector('.notes-editor-foot');
            return !!f && f.scrollWidth <= f.clientWidth + 1;
        }));
    await shotOf(spp)('send-editor-foot-phone');
    // Close it by the button, not Escape: the editor's Escape belongs to
    // whatever has focus inside it (the title input just blurs), and an
    // editor left open swallows every tap that follows.
    await spp.locator('.notes-editor button[aria-label="Close note"]').tap();
    ck('phone editor: it closes again', await spp.waitForSelector('.notes-editor', { state: 'detached', timeout: 10000 }).then(() => true, () => false));

    await spp.locator('.notes-card', { hasText: 'Poem' }).locator('button[aria-label="More actions"]').tap();
    await spp.waitForSelector('.context-menu', { timeout: 5000 });
    await spp.locator('.context-menu-item', { hasText: 'Send to Púca' }).tap();
    await spp.waitForSelector('.notes-send-target', { timeout: 15000 });
    // clientWidth, not innerWidth: see audit() in the phone pass.
    const sendWidth = await spp.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    ck('phone send: no horizontal overflow at 390x844', sendWidth.scrollWidth <= sendWidth.clientWidth + 1, JSON.stringify(sendWidth));
    const rowHeights = await spp.evaluate(() => [...document.querySelectorAll('.notes-send-target')].map(e => e.getBoundingClientRect().height));
    ck('phone send: every target is at least 44px tall', rowHeights.length > 0 && rowHeights.every(h => h >= 43.5), rowHeights.join(','));
    const filterPx = await spp.evaluate(() => {
        const el = document.querySelector('.notes-send-filter');
        return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    });
    ck('phone send: the filter input is 16px (no iOS focus-zoom)', filterPx >= 16, String(filterPx));
    await shotOf(spp)('send-picker-phone');
    await spctx.close();
    await sctx.close();
}

// ---- 12f. Save a message into a note (the other direction) ------------------------------------------
// The same channel 12e posted into: a message with text AND a picture, kept in
// a note. The assertion that earns its keep is the last one — the captured
// note names a DIFFERENT uploaded file than the message, so the copy survives
// the message being deleted and deleting the note takes only its own copy.
{
    const cctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL, storageState: await ctx.storageState() });
    const cp = await cctx.newPage();
    watch(cp);
    await cp.goto('/chat');
    await cp.waitForSelector('.chat-container', { timeout: 20000 });
    try { await cp.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* no popup */ }
    await cp.locator('.server-icon[title="Walk send"]').click();
    await cp.waitForSelector('.channel .channel-name', { timeout: 15000 });
    // 'default', never 'walk-list': a checklist channel hides the composer.
    await cp.locator('.channel', { hasText: 'default' }).first().click();
    await cp.waitForSelector('.message-form', { timeout: 15000 });

    const filesBefore = psqlDsn ? Number(sql('SELECT count(*) FROM uploaded_files')) : null;
    await cp.locator('.message-form input[type="file"]').first().setInputFiles({ name: 'camp.png', mimeType: 'image/png', buffer: PNG });
    // Wait for the chip to finish uploading — Enter before that sends the text alone.
    await cp.waitForSelector('.composer-chip-ready, .composer-chip-done', { timeout: 30000 })
        .catch(() => cp.waitForSelector('.composer-chip', { timeout: 5000 }).catch(() => {}));
    await cp.fill('.message-textarea', 'pack the tent');
    await cp.locator('.message-textarea').press('Enter');
    const sentWithPicture = await cp.waitForSelector('.message-content:has-text("pack the tent")', { timeout: 20000 }).then(() => true, () => false);
    ck('capture setup: a message with text and a picture was sent', sentWithPicture);
    const filesAfterSend = psqlDsn ? Number(sql('SELECT count(*) FROM uploaded_files')) : null;
    if (psqlDsn) ck('capture setup: the picture is an uploaded file', filesAfterSend === filesBefore + 1, `${filesBefore} -> ${filesAfterSend}`);

    await cp.locator('.message', { hasText: 'pack the tent' }).last().click({ button: 'right' });
    await cp.waitForSelector('.context-menu', { timeout: 5000 });
    ck('capture: the message menu offers "Save to Notes"', await cp.locator('.context-menu-item', { hasText: 'Save to Notes' }).count() === 1);
    await cp.locator('.context-menu-item', { hasText: 'Save to Notes' }).click();
    await cp.waitForSelector('.save-note-row', { timeout: 15000 });
    const noteRows = (await cp.locator('.save-note-row').allInnerTexts()).map(t => t.trim());
    ck('capture: the picker offers New note and personal notes only — never the channel', noteRows.includes('New note') && !noteRows.some(t => /Walk send|walk-list/.test(t)), noteRows.join(' | '));
    ck('capture: it offers to keep the picture as a copy of your own', /copy of your own/i.test(await cp.locator('.save-note-check').innerText().catch(() => '')));
    await shot('capture-picker');
    await cp.locator('.save-note-row', { hasText: 'New note' }).click();
    await cp.locator('.save-note-go').click();
    await cp.waitForSelector('.save-note-modal', { state: 'detached', timeout: 30000 }).catch(() => {});
    await sleep(2000);
    const filesAfterCapture = psqlDsn ? Number(sql('SELECT count(*) FROM uploaded_files')) : null;
    if (psqlDsn) {
        ck('capture: the note got its OWN file — a second upload, not the sender\'s', filesAfterCapture === filesAfterSend + 1, `${filesAfterSend} -> ${filesAfterCapture}`);
    } else {
        skip('capture: the note got its OWN file', 'no psql DSN: the walk cannot count uploads');
    }

    // ...and it is there, in Notes, with the picture decrypting.
    const np2 = await cctx.newPage();
    watch(np2);
    await np2.goto('/notes/');
    const captured = await np2.waitForSelector('.notes-card:has-text("pack the tent")', { timeout: 25000 }).then(() => true, () => false);
    ck('capture: the note is in Notes, titled after the message', captured);
    if (captured) {
        await np2.locator('.notes-card', { hasText: 'pack the tent' }).click();
        await np2.waitForSelector('.notes-editor', { timeout: 10000 });
        const noteText = await np2.locator('.notes-editor').innerText();
        ck('capture: the captured text carries no file key', !/[?&]k=/.test(noteText) && !/sovereign-enc/.test(noteText), noteText.slice(0, 120).replace(/\n/g, ' '));
        const picShows = await np2.waitForFunction(() => {
            const img = document.querySelector('.notes-editor .ni-item img, .notes-editor .ni-open img');
            return !!img && img.naturalWidth > 0;
        }, null, { timeout: 25000 }).then(() => true, () => false);
        ck('capture: the copied picture decrypts in the note', picShows);
        await shot('capture-note');
        await np2.keyboard.press('Escape');
    }
    await np2.close();

    // The exits are SHUT while a save is in flight. Closing does not cancel
    // the request — the copies keep uploading and the note keeps being
    // written — so a backdrop click that hid a running save would earn a
    // second save, and the message would be kept twice. The route is held
    // open deliberately, because the real one is far too quick to catch.
    const listsBeforeHeld = psqlDsn ? Number(sql('SELECT count(*) FROM task_lists')) : null;
    await cp.route('**/task-lists', async route => {
        if (route.request().method() === 'POST') await new Promise(r => setTimeout(r, 4000));
        // A held route can be torn down under us (the page navigates, or the
        // walk unroutes while this one is still sleeping). Letting that reject
        // would kill the run as an unhandled rejection, not fail a check.
        await route.continue().catch(() => {});
    });
    await cp.locator('.message', { hasText: 'pack the tent' }).last().click({ button: 'right' });
    await cp.waitForSelector('.context-menu', { timeout: 5000 });
    await cp.locator('.context-menu-item', { hasText: 'Save to Notes' }).click();
    await cp.waitForSelector('.save-note-row', { timeout: 15000 });
    // No pictures: this is about the exits, not a second upload.
    await cp.locator('.save-note-check input').uncheck().catch(() => {});
    await cp.locator('.save-note-row', { hasText: 'New note' }).click();
    await cp.locator('.save-note-go').click();
    const inFlight = await cp.waitForFunction(
        () => /Saving/.test(document.querySelector('.save-note-go')?.textContent ?? ''),
        null, { timeout: 8000 }).then(() => true, () => false);
    ck('capture: the save is held in flight (the harness caught it)', inFlight);
    if (inFlight) {
        ck('capture: the X is disabled while it saves', await cp.locator('.save-note-close').isDisabled());
        ck('capture: Cancel is disabled while it saves', await cp.locator('.save-note-cancel').isDisabled());
        await cp.locator('.save-note-overlay').click({ position: { x: 4, y: 4 } });
        const stillOpen = await cp.locator('.save-note-modal').count() === 1;
        ck('capture: the backdrop does not close a save in flight', stillOpen);
        if (!stillOpen) {
            // What a person does when the sheet vanishes mid-save: save it
            // again. The note count below is what that costs — and it is why
            // the count check, not just the two above, has to be here.
            await cp.locator('.message', { hasText: 'pack the tent' }).last().click({ button: 'right' });
            await cp.waitForSelector('.context-menu', { timeout: 5000 });
            await cp.locator('.context-menu-item', { hasText: 'Save to Notes' }).click();
            await cp.waitForSelector('.save-note-row', { timeout: 15000 });
            await cp.locator('.save-note-check input').uncheck().catch(() => {});
            await cp.locator('.save-note-row', { hasText: 'New note' }).click();
            await cp.locator('.save-note-go').click();
        }
    }
    await cp.waitForSelector('.save-note-modal', { state: 'detached', timeout: 30000 }).catch(() => {});
    await sleep(6000);
    await cp.unroute('**/task-lists').catch(() => {});
    if (psqlDsn) {
        const listsAfterHeld = Number(sql('SELECT count(*) FROM task_lists'));
        ck('capture: the held save kept the message ONCE', listsAfterHeld === listsBeforeHeld + 1,
            `${listsBeforeHeld} -> ${listsAfterHeld}`);
    } else {
        skip('capture: the held save kept the message ONCE', 'no psql DSN: the walk cannot count notes');
    }

    // The phone: the picker is reached by long-press there, and must fit.
    const cpctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined, baseURL, storageState: await ctx.storageState() });
    const cpp = await cpctx.newPage();
    watch(cpp);
    await cpp.goto('/chat');
    await cpp.waitForSelector('.chat-container', { timeout: 25000 });
    try { await cpp.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* no popup */ }
    await cpp.locator('.server-icon[title="Walk send"]').click().catch(() => {});
    await cpp.locator('.channel', { hasText: 'default' }).first().click({ timeout: 10000 }).catch(() => {});
    await cpp.waitForSelector('.message-content:has-text("pack the tent")', { timeout: 20000 }).catch(() => {});
    const reached = await cpp.locator('.message', { hasText: 'pack the tent' }).last().count() > 0;
    if (!reached) {
        skip('phone capture: the picker fits 390x844', 'the phone view did not land on the channel');
    } else {
        await cpp.locator('.message', { hasText: 'pack the tent' }).last().click({ button: 'right' });
        await cpp.waitForSelector('.context-menu', { timeout: 5000 });
        await cpp.locator('.context-menu-item', { hasText: 'Save to Notes' }).tap();
        await cpp.waitForSelector('.save-note-row', { timeout: 15000 });
        // clientWidth, not innerWidth: see audit() in the phone pass.
        const captureWidth = await cpp.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
        ck('phone capture: no horizontal overflow at 390x844', captureWidth.scrollWidth <= captureWidth.clientWidth + 1, JSON.stringify(captureWidth));
        const rh = await cpp.evaluate(() => [...document.querySelectorAll('.save-note-row')].map(e => e.getBoundingClientRect().height));
        ck('phone capture: every row is at least 44px tall', rh.length > 0 && rh.every(h => h >= 43.5), rh.join(','));
        const fs2 = await cpp.evaluate(() => {
            const el = document.querySelector('.save-note-filter');
            return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
        });
        ck('phone capture: the filter input is 16px (no iOS focus-zoom)', fs2 >= 16, String(fs2));
        await shotOf(cpp)('capture-picker-phone');
    }
    await cpctx.close();
    await cctx.close();
}

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
// "Stay signed in on this device" rides this form: measured on the TOKEN the
// server actually minted, not on the checkbox. The ticked sign-in and the
// cleared one below read the same claim through the same code, so each is the
// other's control — a server that ignored the request mints 24 h for both and
// the ticked check fails; a client that always asked mints 30 days for both
// and the cleared one fails.
const stayBox = '#stay-signed-in';
/** The session token's lifetime as the server minted it, read in-page from
 *  the payload (base64url). No `iat` in these claims, so: exp - now. */
const tokenLife = pg => pg.evaluate(() => {
    const t = localStorage.getItem('auth_token');
    if (!t || t.split('.').length !== 3) return null;
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(atob(b + '='.repeat((4 - b.length % 4) % 4)));
    const left = p.exp - Date.now() / 1000;
    return { days: left / 86400, hours: left / 3600, ls: p.ls };
});
const lifeOf = l => l ? `${l.days.toFixed(2)} days (${l.hours.toFixed(1)} h), ls=${l.ls}` : 'no token';
/** Sign in through the form and hand back the step-2 body's KEYS (values
 *  stay out of the log: one of them is the password proof). */
async function notesSignIn(pg) {
    await pg.fill('#username', username);
    await pg.fill('#password', password);
    const step2 = pg.waitForRequest(rq => rq.url().endsWith('/auth/login/step2') && rq.method() === 'POST', { timeout: 20000 });
    await pg.click('.login-button');
    const body = await step2.then(rq => rq.postDataJSON(), () => null);
    await pg.waitForSelector('.notes-app', { timeout: 20000 });
    await pg.waitForSelector('.notes-card', { timeout: 15000 });
    return body;
}
/** Account menu -> Sign out -> back on the login card, the revoke settled. */
async function notesSignOut(pg) {
    await pg.click('button[aria-label="Account and settings"]');
    await pg.waitForSelector('.notes-menu', { timeout: 5000 });
    await pg.getByRole('button', { name: 'Sign out', exact: true }).click();
    await pg.waitForSelector('.login-card', { timeout: 10000 });
    await sleep(1500);   // as above: let the device revoke finish before the next sign-in
}
// A browser starts CLEAR (the long session there is Púca's too, and a browser
// is what gets shared); the Android shell below starts ticked — each the
// other's control.
ck('stay signed in: the row is on Notes\' sign-in, clear by default in a browser',
    await page.locator(stayBox).count() === 1 && !(await page.locator(stayBox).isChecked())
        && await page.evaluate(() => localStorage.getItem('pucaStaySignedIn')) === null,
    await page.locator(stayBox).count() === 1 ? `checked=${await page.locator(stayBox).isChecked()} stored=${await page.evaluate(() => localStorage.getItem('pucaStaySignedIn'))}` : 'no checkbox');
// In a browser, Notes and Púca share one origin and one token, so the long
// session is Púca's too here: the line under the box has to say so, and say
// "once a month" (a 30-day token), not a year without a visit.
const stayHint = await page.locator('#stay-signed-in-hint').textContent({ timeout: 5000 }).catch(() => null);
ck('stay signed in: in a browser the hint says Púca stays signed in too, if used monthly',
    !!stayHint && stayHint.includes('to Notes and to Púca') && stayHint.includes('at least once a month'), JSON.stringify(stayHint));
await page.locator(stayBox).check({ timeout: 5000 }).catch(e => console.log('[walk] tick:', String(e).slice(0, 200)));
ck('stay signed in: ticking it is remembered on this browser', await page.evaluate(() => localStorage.getItem('pucaStaySignedIn')) === 'true');
const longBody = await notesSignIn(page);
ck('sign in: Notes signs in with the Púca account and the notes are back', await page.locator('.notes-card').count() >= 1);
ck('stay signed in: ticked, the step-2 request asks for it', longBody?.stay_signed_in === true, longBody ? `keys=${Object.keys(longBody).sort().join(',')}` : 'no step-2 request seen');
const longLife = await tokenLife(page);
ck('stay signed in: ticked, the server minted a ~30-day token that says ls:true',
    !!longLife && longLife.days >= 29 && longLife.days <= 31 && longLife.ls === true, lifeOf(longLife));
// Colour and labels follow the ACCOUNT now (a sealed blob): the sign-out
// scrubbed this browser's copy, and signing back in brings them back.
const kept = await page.waitForSelector('.notes-card:has-text("Groceries") .notes-chip:has-text("Errands")', { timeout: 10000 }).then(() => true, () => false);
ck('sign in: labels survive a sign-out and sign-in (synced, not device-local)', kept);
ck('sign in: the colour came back too', await page.locator('.notes-card[data-color="sage"]').count() >= 1);
await shot('signed-in-again');

// The negative control, in the same walk: sign out, CLEAR the box, sign in.
await notesSignOut(page);
await page.locator(stayBox).uncheck({ timeout: 5000 }).catch(e => console.log('[walk] untick:', String(e).slice(0, 200)));
const shortBody = await notesSignIn(page);
ck('stay signed in: cleared, the step-2 request carries no stay_signed_in at all',
    !!shortBody && !('stay_signed_in' in shortBody), shortBody ? `keys=${Object.keys(shortBody).sort().join(',')}` : 'no step-2 request seen');
const shortLife = await tokenLife(page);
ck('stay signed in: cleared, the ordinary ~24-hour token and no ls (the control)',
    !!shortLife && shortLife.hours >= 23 && shortLife.hours <= 25 && shortLife.ls !== true, lifeOf(shortLife));
// The answer belongs to the DEVICE: it must survive the real sign-out path
// (logout() clears the remember-me blob beside it, and must not clear this).
await notesSignOut(page);
const remembered = { checked: await page.locator(stayBox).isChecked({ timeout: 5000 }).catch(() => null), stored: await page.evaluate(() => localStorage.getItem('pucaStaySignedIn')) };
ck('stay signed in: a cleared box survives a sign-out (a device preference)', remembered.checked === false && remembered.stored === 'false', JSON.stringify(remembered));
await notesSignIn(page);   // as it stands (cleared): the rest of the walk runs on an ordinary session
ck('stay signed in: signed back in for the rest of the walk', await page.locator('.notes-card').count() >= 1);
ck('desktop: no page errors', errors.length === 0, errors[0]);

// The row on a phone (§5): a fresh context, so the card is the signed-out
// one a new device sees. The WHOLE row toggles the box (a tap on its text and
// one at its far end), it is a 44px target, and its text is 16px.
{
    const pctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined, baseURL });
    const p = await pctx.newPage();
    watch(p);
    await p.goto('/notes/');
    await p.waitForSelector('.login-card', { timeout: 15000 });
    const row = await p.evaluate(() => {
        const r = document.querySelector('.notes-stay-row')?.getBoundingClientRect();
        const txt = document.querySelector('.notes-stay-row .checkbox-text');
        const hint = document.querySelector('.notes-stay-hint')?.getBoundingClientRect();
        // clientWidth, not innerWidth: see audit() in the phone pass.
        const vw = document.documentElement.clientWidth, sw = document.documentElement.scrollWidth;
        return r && txt && hint ? { h: r.height, w: r.width, right: r.right, textPx: parseFloat(getComputedStyle(txt).fontSize),
            hintInside: hint.left >= 0 && hint.right <= vw, hintRight: hint.right, vw, scrollWidth: sw, scrolls: sw > vw + 1 } : null;
    });
    ck('phone sign-in: the stay row is a ≥44px tap target', !!row && row.h >= 44 - 0.5, row ? `${Math.round(row.w)}x${Math.round(row.h)}` : 'no row');
    ck('phone sign-in: the row text is ≥16px', !!row && row.textPx >= 16, row ? `${row.textPx}px` : 'no row');
    ck('phone sign-in: the card and its hint fit the width (no sideways scroll)', !!row && row.hintInside && !row.scrolls, JSON.stringify(row));
    // A phone BROWSER is still a browser: clear by default (the Android
    // app's own default is checked in the fake-shell section).
    ck('phone sign-in: clear by default in a phone browser', await p.locator(stayBox).isChecked({ timeout: 5000 }).catch(() => null) === false);
    await p.tap('.notes-stay-row .checkbox-text', { timeout: 5000 }).catch(e => console.log('[walk] text tap:', String(e).slice(0, 200)));
    const afterText = await p.locator(stayBox).isChecked({ timeout: 5000 }).catch(() => null);
    const rb = await p.locator('.notes-stay-row').boundingBox({ timeout: 5000 }).catch(() => null);
    if (rb) await p.touchscreen.tap(rb.x + rb.width - 4, rb.y + rb.height / 2);
    const afterEnd = await p.locator(stayBox).isChecked({ timeout: 5000 }).catch(() => null);
    ck('phone sign-in: a tap on the text, then one at the row\'s far end, each toggle the box', afterText === true && afterEnd === false, `after text tap=${afterText}, after far-end tap=${afterEnd}`);
    await shotOf(p)('phone-signin-stay-row');
    await pctx.close();
}

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

// Every width below is measured against document.documentElement.clientWidth,
// never window.innerWidth: under isMobile emulation a page wider than the
// screen WIDENS innerWidth to fit it (a 451px row on this 390px device reads
// innerWidth 451, scrollWidth 451, clientWidth 390), so "scrollWidth >
// innerWidth" and "widest <= innerWidth" compare the page with itself and
// cannot fail. clientWidth stays the device's 390.
const audit = () => m.evaluate(() => {
    const vw = document.documentElement.clientWidth;
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
    const scrollWidth = document.documentElement.scrollWidth;
    return { vw, widest, scrollWidth, bodyScrollsHorizontally: scrollWidth > vw + 1, under, ghosts, cards, fonts,
        fabVisible: !!document.querySelector('.notes-fab') && vis(document.querySelector('.notes-fab')),
        inlineComposerHidden: !document.querySelector('.notes-quickadd') || !vis(document.querySelector('.notes-quickadd')) };
});

await m.goto('/notes/');
await m.waitForSelector('.notes-card', { timeout: 20000 });
let r = await audit();
await mshot('phone-grid');
ck('phone: no horizontal overflow', !r.bodyScrollsHorizontally && r.widest <= r.vw + 1, `widest=${r.widest} vw=${r.vw}`);
// Grid view is TWO columns on a phone (like Keep), list view one: the top
// bar's toggle once changed only its own icon here, because notes.css forced
// one column in both views.
ck('phone: grid view is two columns', new Set(r.cards).size === 2, JSON.stringify(r.cards));
ck('phone: grid view offers no grip (masonry has no one-axis order)', await m.locator('.notes-card-grip').count() === 0);
// At half width a due chip or the "Not encrypted" flag beside an item used to
// squeeze its text to a few letters a line; the chips now wrap under it.
const squeezed = await m.evaluate(() => [...document.querySelectorAll('.notes-card-item')].map(li => {
    const t = li.querySelector('.notes-card-item-text');
    const card = li.closest('.notes-card');
    return { text: t?.textContent?.slice(0, 20), tw: Math.round(t?.getBoundingClientRect().width ?? 0), cw: Math.round(card?.getBoundingClientRect().width ?? 0),
        chips: li.querySelectorAll('.tt-due, .tt-not-encrypted').length };
}));
ck('phone: grid cards have items with chips to measure (precondition)', squeezed.some(s => s.chips > 0), JSON.stringify(squeezed.slice(0, 4)));
ck('phone: no item text is squeezed by its chips in the two-column grid',
    squeezed.filter(s => s.chips > 0).every(s => s.tw >= s.cw * 0.6),
    JSON.stringify(squeezed.filter(s => s.chips > 0 && s.tw < s.cw * 0.6)));
await m.tap('button[aria-label="Switch to list view"]');
await sleep(250);
r = await audit();
ck('phone: list view is one column', new Set(r.cards).size === 1, JSON.stringify(r.cards));
await m.tap('button[aria-label="Switch to grid view"]');
await sleep(250);
r = await audit();
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
// The paste confirmation must be answerable on a phone: inside the viewport,
// no sideways scroll, and every button a real tap target.
await m.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Socks\nShirt\nShoes\nSunglasses\nSuncream');
    document.querySelector('.notes-quickadd-item input')
        .dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
});
await m.waitForSelector('.notes-paste-dialog', { timeout: 5000 }).catch(() => {});
ck('phone: a multi-line paste asks here too', await m.locator('.notes-paste-dialog').count() === 1);
const pasteBox = await m.locator('.notes-dialog').boundingBox();
const pasteVh = await m.evaluate(() => window.innerHeight);
ck('phone: the paste confirmation is inside the viewport',
    pasteBox && pasteBox.x >= 0 && pasteBox.x + pasteBox.width <= 390.5 && pasteBox.y >= 0 && pasteBox.y + pasteBox.height <= pasteVh + 0.5,
    JSON.stringify(pasteBox));
const pasteBtns = await m.locator('.notes-paste-actions button').all();
const pasteHs = await Promise.all(pasteBtns.map(async b => (await b.boundingBox())?.height ?? 0));
ck('phone: every paste-confirmation button is a full tap target', pasteHs.length === 3 && pasteHs.every(h => h >= 44), JSON.stringify(pasteHs));
const pasteWidth = await m.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
ck('phone: the paste confirmation does not scroll the page sideways',
    pasteWidth.scrollWidth <= pasteWidth.clientWidth, JSON.stringify(pasteWidth));
await mshot('phone-paste-confirm');
await m.getByRole('button', { name: 'Cancel' }).tap();
await m.waitForSelector('.notes-paste-dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
ck('phone: Cancel leaves the composer with its one empty item',
    await m.locator('.notes-quickadd-item input').count() === 1);
await m.fill('.notes-quickadd-title', 'Phone note');
// Longer than a phone's line on purpose: the Reminders-row block below gives
// this item a due time and then measures it. A 5-letter word like "Charger"
// still fits on one line inside the 44px the broken layout left, so that
// block's height check could not have failed on it; and only text WIDER than
// the line (about 55 characters at 390) shows a content-basis layout putting
// the text below its own tick box. Still starts with "Charger": the calendar
// walk finds this item by that word.
await m.locator('.notes-quickadd-item input').first().fill('Charger for the camping trip, and the spare batteries in the blue box');
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
// One LONG item with a due time, so the Reminders rows below include a row
// whose text really has to wrap. The items already dated here — "Bread",
// "Eggs" — are single short words that still fitted on one line inside the
// 44px the broken layout left them, so on their own they could not have made
// the height check fail.
const LONG_ITEM = 'Charger for the camping trip, and the spare batteries in the blue box';
await m.locator('.notes-card', { hasText: 'Phone note' }).first().tap();
await m.waitForSelector('.notes-editor .tt-item', { timeout: 10000 });
const longItem = () => m.locator('.notes-editor .tt-item', { hasText: LONG_ITEM }).first();
await longItem().locator('.tt-btn[title="Add due time"]').tap();
await m.waitForSelector('.tt-due-edit input', { timeout: 5000 });
const mLong = new Date(); mLong.setDate(mLong.getDate() + 1);
await m.fill('.tt-due-edit input', `${mLong.getFullYear()}-${mpad(mLong.getMonth() + 1)}-${mpad(mLong.getDate())}T18:30`);
// Scoped: the note's OWN reminder control carries a .tt-due-set of its own
// (components/schedule/NoteReminderControl.tsx).
await m.locator('.tt-due-edit .tt-due-set').first().tap();
await m.waitForSelector(`.notes-editor .tt-item:has-text("${LONG_ITEM}") .tt-due`, { timeout: 10000 }).catch(() => {});
ck('phone: a long item takes a due time, so the Reminders rows below have one that must wrap',
    await longItem().locator('.tt-due').count() === 1);
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

// ---- Reminders row at 390x844 keeps its text readable ----
// The bug this block exists for (fixed in 0.9.818): under a coarse pointer
// the row wrapped — it must, the actions alone are 88px — while
// `.notes-reminder-text` was `flex: 1`, i.e. flex-BASIS 0. So the text's
// share of the first line was only what the non-shrinking siblings left it:
// the timing marks, the note title (up to 40%), the nowrap due time, the
// 44px retime and snooze buttons and six 10px gaps. At 390 that is a few
// pixels, and every item read ONE CHARACTER PER LINE. This block's first run
// against the 0.9.817 CSS: "Bread" and "Eggs" 44.3px of a 366px row
// (12.1%). Nothing above caught it: the row still fitted 390, nothing
// overflowed and every button was still 44px.
// The layout that replaced it (components/reminders/Reminders.css) puts the
// text alone beside its tick box on line 1 and everything else on line 2.
// Its first cut used a CONTENT basis, which drops a long item's text BELOW
// the tick box onto a line of its own — so the text is also checked to sit
// beside the box, and LONG_ITEM above is wider than the line.
// EVERY row on screen is measured, and a view with no rows at all is a
// FAIL, not a vacuous pass.
const remRows = await m.evaluate(() => {
    const r1 = n => Math.round(n * 10) / 10;
    return [...document.querySelectorAll('.notes-reminder-row')].map(row => {
        const t = row.querySelector('.notes-reminder-text');
        const cs = t && getComputedStyle(t);
        // `line-height: normal` computes to a keyword, not a length.
        const lh = cs ? (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4) : 0;
        const rb = row.getBoundingClientRect();
        const tb = t ? t.getBoundingClientRect() : null;
        // The tick box, or a note's bell: the row's first child either way.
        const box = row.firstElementChild && row.firstElementChild !== t ? row.firstElementChild.getBoundingClientRect() : null;
        return {
            label: t && t.firstChild ? String(t.firstChild.textContent).trim().slice(0, 20) : '(no text cell)',
            isNote: row.classList.contains('note'),
            beside: !!(tb && box && tb.top < box.bottom && box.top < tb.bottom && tb.left >= box.right),
            rowW: r1(rb.width), rowH: r1(rb.height),
            textW: tb ? r1(tb.width) : 0, textH: tb ? r1(tb.height) : 0,
            share: tb ? r1((tb.width / rb.width) * 100) : 0,
            lines: tb && lh ? r1(tb.height / lh) : 0, lh: r1(lh),
            retime: row.querySelectorAll('.notes-retime button').length,
            snooze: row.querySelectorAll('.notes-snooze button').length,
            clear: row.querySelectorAll('.notes-reminder-clear').length,
        };
    });
});
// The two WIDEST shapes have to be on screen or the measurement proves
// nothing: an item row carrying both the retime clock and the snooze, and a
// note's own row (a bell and Clear).
const remItem = remRows.find(x => !x.isNote && x.retime === 1 && x.snooze === 1);
const remNote = remRows.find(x => x.isNote && x.clear === 1);
ck('phone reminders: an item row with BOTH retime and snooze is on screen (the widest item row)',
    !!remItem, JSON.stringify(remRows.map(x => `${x.label} retime=${x.retime} snooze=${x.snooze} clear=${x.clear}`)));
ck('phone reminders: a note’s own row with its bell and Clear is on screen (the widest note row)',
    !!remNote, JSON.stringify(remRows.filter(x => x.isNote)));
const remNarrow = remRows.filter(x => x.textW < x.rowW * 0.5);
ck('phone reminders: every row gives its text at least half the row’s width',
    remRows.length > 0 && remNarrow.length === 0,
    JSON.stringify({ rows: remRows.length, narrow: remNarrow.map(x => `"${x.label}" text ${x.textW}px of a ${x.rowW}px row = ${x.share}%`) }));
const remBelow = remRows.filter(x => !x.beside);
ck('phone reminders: every row’s text sits beside its tick box or bell, not on a line below it',
    remRows.length > 0 && remBelow.length === 0,
    JSON.stringify(remBelow.map(x => `"${x.label}" ${x.textW}px wide, ${x.lines} lines`)));
const remTall = remRows.filter(x => x.lh <= 0 || x.textH > 2.5 * x.lh);
ck('phone reminders: each seeded item reads on a line or two, not one character per line',
    remRows.length > 0 && remTall.length === 0,
    JSON.stringify(remTall.map(x => `"${x.label}" ${x.lines} lines of ${x.lh}px (${x.textH}px tall)`)));
const remDeep = remRows.filter(x => x.lh <= 0 || x.rowH > 3 * x.lh + 44 + 24);
ck('phone reminders: the row stays inside about three text lines plus one 44px action line',
    remRows.length > 0 && remDeep.length === 0,
    JSON.stringify(remDeep.map(x => `"${x.label}" row ${x.rowH}px against a ${Math.round(3 * x.lh + 68)}px ceiling`)));
// Against clientWidth, NOT innerWidth: under the phone emulation a page that
// is wider than the screen WIDENS innerWidth to fit it (measured: a 451px-wide
// page on the 390px iPhone 13 reports innerWidth 451, clientWidth 390), so
// `scrollWidth > innerWidth` can never fire here. And every descendant is
// held inside its row, which catches a row that overflows inside a clipped
// container the page's own scrollWidth never sees.
const remWide = await m.evaluate(() => {
    const client = document.documentElement.clientWidth;
    const out = [];
    for (const row of document.querySelectorAll('.notes-reminder-row')) {
        const rb = row.getBoundingClientRect();
        for (const el of row.querySelectorAll('*')) {
            const b = el.getBoundingClientRect();
            if (b.width > 0 && (b.right > rb.right + 0.5 || b.right > client + 0.5)) out.push(`${String(el.getAttribute('class') || el.tagName).split(' ')[0]} r=${Math.round(b.right)} row r=${Math.round(rb.right)}`);
        }
    }
    return { scroll: document.documentElement.scrollWidth, client, inner: window.innerWidth, out: out.slice(0, 6) };
});
ck('phone reminders: the rows add no sideways scroll, and nothing sticks out of a row',
    remWide.client > 0 && remWide.scroll <= remWide.client + 1 && remWide.out.length === 0, JSON.stringify(remWide));
await mshot('phone-reminders-rows');
// ---- end of the Reminders row block ----

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
// Positive control: "Eggs" is a real item with a due time, and it keeps the
// tick box this walk would otherwise never have proved the day list draws at
// all. It is THREE days out, not tomorrow: the Reminders section above
// retimed it from its row (18:45, +3 days), which is the point of that
// check — so this one follows it rather than looking where it used to be.
const mEggs = new Date(); mEggs.setDate(mEggs.getDate() + 3);
await m.goto(`/notes/#/calendar?v=day&d=${mEggs.getFullYear()}-${mpad(mEggs.getMonth() + 1)}-${mpad(mEggs.getDate())}`);
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
    const vw = document.documentElement.clientWidth;
    return {
        ownRow: b.top >= t.bottom - 0.5,
        inside: b.left >= -0.5 && b.right <= vw + 0.5,
        font: input ? parseFloat(getComputedStyle(input).fontSize) : 0,
        overflow: document.documentElement.scrollWidth > vw + 1,
        right: Math.round(b.right), vw,
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
        return !!f && f.scrollWidth <= f.clientWidth + 1 && f.getBoundingClientRect().right <= document.documentElement.clientWidth + 1;
    }),
    JSON.stringify(await m.evaluate(() => {
        const f = document.querySelector('.notes-quickadd-foot');
        return f ? { scrollWidth: f.scrollWidth, clientWidth: f.clientWidth, right: Math.round(f.getBoundingClientRect().right), vw: document.documentElement.clientWidth } : null;
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
    const docWidth = { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
    return { buttons: btns.length, under, textPx: ta ? parseFloat(getComputedStyle(ta).fontSize) : 0, overflow: docWidth.scrollWidth > docWidth.clientWidth + 1, docWidth };
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
    const vw = document.documentElement.clientWidth;
    return {
        rows: rows.length,
        inside: b.left >= -0.5 && b.right <= vw + 0.5 && b.top >= -0.5 && b.bottom <= window.innerHeight + 0.5,
        small: rows.filter(i => i.height < 43.5).length,
        overflow: document.documentElement.scrollWidth > vw + 1,
        right: Math.round(b.right), vw,
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
// The four reminder-time rows: inside 390px, and no iOS zoom either.
const timeRow = await m.locator('.notes-menu-row:has(#notes-remind-morning)').boundingBox();
ck('phone: the reminder-time rows fit the viewport', timeRow && timeRow.x >= 0 && timeRow.x + timeRow.width <= 390.5, JSON.stringify(timeRow));
const timePx = await m.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#notes-remind-morning')).fontSize));
ck('phone: the reminder-time inputs ≥ 16px', timePx >= 16, `${timePx}px`);
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

// A highlight must not push the card sideways at 390px.
await m.fill('.notes-search input', 'bread');
await sleep(400);
r = await audit();
ck('phone: a search highlight does not overflow the card',
    await m.locator('mark.notes-hl').count() >= 1 && !r.bodyScrollsHorizontally && r.widest <= r.vw + 1,
    JSON.stringify({ widest: r.widest, vw: r.vw }));
await mshot('phone-search-highlight');
await m.tap('button[aria-label="Clear search"]');
await sleep(300);

// Ordering on a phone: list view is one column, so the grip is offered there
// — and it must be a real tap target that does not scroll the page when
// dragged. (Grid view is two columns and has none; checked above.)
await m.tap('button[aria-label="Switch to list view"]');
await sleep(250);
ck('phone: cards carry a grip in list view', await m.locator('.notes-card-grip').count() > 1);
const pg = await m.locator('.notes-card-grip').first().boundingBox();
ck('phone: the grip is a 44px tap target', !!pg && pg.width >= 44 && pg.height >= 44, JSON.stringify(pg));
ck('phone: the grip declares touch-action none (no scroll to fight)',
    await m.locator('.notes-card-grip').first().evaluate(el => getComputedStyle(el).touchAction) === 'none');

// A press that STARTS on the grip is a drag, and nothing else. Android fires
// `contextmenu` after ~500 ms of a still finger; useDragReorder only swallows
// that once a drag is LIVE (5px of movement), so a press-and-hold on the grip
// used to open a bulk selection nobody asked for — the timer was cancelled,
// the contextmenu was not.
const gripCard = m.locator('.notes-card', { hasText: 'Poem' });
const gcb = await gripCard.locator('.notes-card-grip').boundingBox();
await gripCard.locator('.notes-card-grip').dispatchEvent('pointerdown',
    { pointerType: 'touch', isPrimary: true, clientX: gcb.x + gcb.width / 2, clientY: gcb.y + gcb.height / 2, bubbles: true });
await sleep(700);
await gripCard.dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
await sleep(250);
ck('phone: holding the grip starts NO selection (that press is a drag)', await m.locator('.notes-selectbar').count() === 0);
await gripCard.dispatchEvent('pointerup',
    { pointerType: 'touch', isPrimary: true, clientX: gcb.x + gcb.width / 2, clientY: gcb.y + gcb.height / 2, bubbles: true });
await sleep(150);
await m.tap('button[aria-label="Switch to grid view"]');
await sleep(250);

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
// A long web address must not widen the note. Seed one, measure, put it back.
const LONG_URL = 'https://example.com/a/very/long/path/that/keeps/going/and/going/so/it/cannot/possibly/fit/on/one/line/at/390px?q=1';
// Aimed at x:4 — the first word — and not at the middle of the box, because
// the middle of THIS line is the link itself, and a tap on a link is the
// link's, not the editor's. The detail string measures that rather than
// asserting it: the layout may change, the aim should not.
const centreIsLink = await m.evaluate(() => {
    const el = document.querySelector('.notes-editor-content .nb-rendered');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return !!hit?.closest('a.note-link');
});
await m.tap('.notes-editor-content .nb-rendered', { position: { x: 4, y: 4 } });
await m.waitForSelector('.notes-editor-content textarea.nb-text', { timeout: 5000 }).catch(() => {});
ck('phone: tapping the words beside a link puts the field back',
    await m.locator('.notes-editor-content textarea.nb-text').count() === 1,
    `middle of the line is the link: ${centreIsLink}`);
await m.fill('.notes-editor-content textarea.nb-text', `Buy before Friday ${LONG_URL}`);
await m.tap('.notes-editor-sub');
await m.waitForSelector('.notes-editor-content .nb-rendered a.note-link', { timeout: 10000 }).catch(() => {});
r = await audit();
ck('phone: a long link in a note does not widen the page',
    !r.bodyScrollsHorizontally && r.widest <= r.vw + 1, `widest=${r.widest} vw=${r.vw}`);
ck('phone: the note text is still ≥ 16px in its read view', r.fonts['.nb-text'] >= 16, `${r.fonts['.nb-text']}px`);
const linkBox = await m.locator('.notes-editor-content a.note-link').boundingBox();
ck('phone: the link is inside the viewport and has real height',
    linkBox && linkBox.x >= 0 && linkBox.x + linkBox.width <= 390.5 && linkBox.height > 0, JSON.stringify(linkBox));
await mshot('phone-note-link');
await m.tap('.notes-editor-content .nb-rendered', { position: { x: 4, y: 4 } });
await m.waitForSelector('.notes-editor-content textarea.nb-text', { timeout: 5000 }).catch(() => {});
ck('phone: tapping the text (not the link) returns to editing',
    await m.locator('.notes-editor-content textarea.nb-text').count() === 1);
await m.fill('.notes-editor-content textarea.nb-text', 'Buy before Friday https://example.com/a');
await m.tap('.notes-editor-sub');
await new Promise(res => setTimeout(res, 1500));
const grip = await m.evaluate(() => { const g = document.querySelector('.notes-editor .tt-grip:not(.tt-grip-ghost)'); return g ? parseFloat(getComputedStyle(g).opacity) : -1; });
ck('phone: the drag grip is visible (not the desktop hover state)', grip >= 0.5, String(grip));
ck('phone: the move arrows (tap alternative) are shown', await m.locator('.notes-editor .tt-move').first().isVisible());
// The one-tap reminder row: a real button at 44px, inside the viewport.
const eggsPhone = m.locator('.notes-editor .tt-item', { hasText: 'Eggs' }).first();
await eggsPhone.locator('.tt-btn[title="Edit due time"]').tap();
await m.waitForSelector('.tt-due-presets', { timeout: 5000 });
const presetBox = await m.locator('.tt-due-presets button').first().boundingBox();
ck('phone: the preset buttons meet the tap-target size', presetBox && presetBox.height >= 44, JSON.stringify(presetBox));
const dueEditBox = await m.locator('.tt-due-edit').boundingBox();
ck('phone: the due editor stays inside the viewport', dueEditBox && dueEditBox.x >= 0 && dueEditBox.x + dueEditBox.width <= 390.5, JSON.stringify(dueEditBox));
await m.keyboard.press('Escape');
await sleep(200);

// Bread, not Butter: the database step above rewrote Butter's text.
await m.locator('.notes-editor .tt-item', { hasText: 'Bread' }).first().locator('.tt-description').tap();
await m.waitForSelector('.notes-editor .tt-edit-input', { timeout: 5000 });
r = await audit();
ck('phone: inline item edit ≥ 16px', r.fonts['.tt-edit-input'] >= 16, `${r.fonts['.tt-edit-input']}px`);
await m.keyboard.press('Escape');
await new Promise(res => setTimeout(res, 200));
ck('phone: Escape in the item edit keeps the note open', await m.locator('.notes-editor').count() === 1);
// The note text's undo is the only way to reach it here — there is no Ctrl key.
// The text holds a link, so the closed field is the read view: tap it first.
if (await m.locator('.notes-editor-content textarea.nb-text').count() === 0) {
    await m.locator('.notes-editor-content .nb-rendered').tap({ position: { x: 4, y: 4 } });
    await m.waitForSelector('.notes-editor-content textarea.nb-text', { timeout: 5000 });
}
await m.fill('.notes-editor-content textarea.nb-text', 'Buy before Friday https://example.com/a');
await sleep(1200);
await m.fill('.notes-editor-content textarea.nb-text', 'Buy before Friday and flowers');
await m.waitForSelector('.notes-editor .nb-histbtn[aria-label="Undo"]', { timeout: 5000 });
const undoBtnBox = await m.locator('.notes-editor .nb-histbtn[aria-label="Undo"]').boundingBox();
ck('phone: the note text undo is a real tap target', undoBtnBox && undoBtnBox.width >= 43.5 && undoBtnBox.height >= 43.5, JSON.stringify(undoBtnBox));
await m.tap('.notes-editor .nb-histbtn[aria-label="Undo"]');
await new Promise(res => setTimeout(res, 1500));
ck('phone: tapping Undo puts the text back', (await m.locator('.notes-editor textarea.nb-text').inputValue()) === 'Buy before Friday https://example.com/a');
// An item delete offers the same snackbar, inside the viewport. The item is
// one this section adds itself: what the sections above left in this note has
// been through a trash, a plaintext injection and two edits, and the check is
// about the snackbar, not about them.
const hasRow = t => m.waitForFunction(
    text => [...document.querySelectorAll('.notes-editor .tt-description')].some(d => d.textContent.trim() === text),
    t, { timeout: 15000 },
).then(() => true).catch(() => false);
const mine = () => m.locator('.notes-editor .tt-item', { hasText: 'Undo me' }).first();
await m.fill('.notes-editor-add input', 'Undo me');
await m.press('.notes-editor-add input', 'Enter');
ck('phone: the add row adds an item', await hasRow('Undo me'));
await mine().locator('.tt-btn[title="Delete"]').tap();
await m.waitForSelector('.notes-undo', { timeout: 8000 });
const undoBarBox = await m.locator('.notes-undo').boundingBox();
ck('phone: the item undo bar fits the viewport and clears the safe area',
    undoBarBox && undoBarBox.x >= 0 && undoBarBox.x + undoBarBox.width <= 390.5, JSON.stringify(undoBarBox));
ck('phone: the item is gone while Undo is offered', await m.locator('.notes-editor .tt-item', { hasText: 'Undo me' }).count() === 0);
await m.locator('.notes-undo button').tap();
ck('phone: tapping Undo puts the item back', await hasRow('Undo me'));
// ...and leave the note as this section found it.
await mine().locator('.tt-btn[title="Delete"]').tap();
await m.waitForSelector('.notes-undo', { timeout: 8000 });
await m.locator('.notes-undo').waitFor({ state: 'detached', timeout: 12000 });
await mshot('phone-editor');
// a popover from the footer stays inside the viewport
await m.tap('.notes-editor-foot button[aria-label="Colour"]');
await m.waitForSelector('.notes-popover', { timeout: 5000 });
const pb = await m.locator('.notes-popover').boundingBox();
ck('phone: colour popover inside the viewport', pb && pb.x >= 0 && pb.x + pb.width <= 390.5 && pb.y >= 0 && pb.y + pb.height <= vh + 0.5, JSON.stringify(pb));
await mshot('phone-popover');
await m.keyboard.press('Escape');
await m.waitForSelector('.notes-popover', { state: 'detached', timeout: 5000 }).catch(() => {});
// List actions at 390x844: answerable, inside the viewport, targets at size.
if (await m.locator('.notes-editor-foot button[aria-label="List actions"]').count() === 1) {
    await m.tap('.notes-editor-foot button[aria-label="List actions"]');
    await m.waitForSelector('.notes-list-actions', { timeout: 5000 });
    const laBoxes = await Promise.all((await m.locator('.notes-list-actions button').all()).map(async b => (await b.boundingBox())?.height ?? 0));
    ck('phone: every list-action row is a full tap target', laBoxes.length === 2 && laBoxes.every(h => h >= 44), JSON.stringify(laBoxes));
    const laBox = await m.locator('.notes-popover').boundingBox();
    ck('phone: the list-actions popover is inside the viewport',
        laBox && laBox.x >= 0 && laBox.x + laBox.width <= 390.5 && laBox.y >= 0 && laBox.y + laBox.height <= vh + 0.5, JSON.stringify(laBox));
    const laWidth = await m.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    ck('phone: the editor foot still does not scroll sideways',
        laWidth.scrollWidth <= laWidth.clientWidth, JSON.stringify(laWidth));
    await mshot('phone-list-actions');
    await m.keyboard.press('Escape');
    await m.waitForSelector('.notes-popover', { state: 'detached', timeout: 5000 }).catch(() => {});
} else {
    skip('phone: the list-actions popover', 'nothing is ticked in this note here');
}
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
        // clientWidth, not innerWidth: see audit() in the phone pass.
        const vw = await pg.evaluate(() => document.documentElement.clientWidth);
        const overflow = await pg.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        ck('phone hint (390x844): shown under the item', !!hinted && hinted.hint === 'Reminds whoever set it' && !!hinted.sub && hinted.sub.t >= hinted.text.t + 4, JSON.stringify(hinted));
        ck('phone hint: my own shared item has none (control)', !!mine && mine.hint === null);
        // The due time used to be asserted to start at or after the text's
        // right edge — the desktop column order, read on a phone. Under a
        // coarse pointer the row now wraps deliberately (Reminders.css): the
        // text owns line 1 and the time sits on line 2, so what has to hold
        // is that the time is BELOW the text, not beside it. The old form
        // passed the 0.9.817 CSS, which squeezed this row's text into 60-105px
        // beside the time (how narrow depends on the due label, i.e. on the
        // hour the walk runs) — the one-character-per-line bug itself — and
        // it fails the fixed row, whose text spans the row. This form fails
        // 0.9.817: its time sits beside the text, above the text's bottom.
        ck('phone hint: the row, the hint and the due time stay inside 390 px', !!hinted && !!hinted.sub && !overflow
            && hinted.row.r <= vw + 0.5 && hinted.sub.r <= hinted.row.r + 0.5 && hinted.when.r <= hinted.row.r + 0.5 && hinted.when.t >= hinted.text.b - 0.5,
            JSON.stringify({ vw, overflow, hinted }));
        ck('phone hint: nothing covers it', await onTop(pg, '.notes-reminder-sub'));
        // Two icon buttons now sit at the end of a reminder row (retime and
        // snooze): both are real buttons, so both are 44px under a coarse
        // pointer, and neither pushes the row past 390.
        const retimeBox = await pg.locator('.notes-reminder-row .notes-retime button').first().boundingBox();
        const snoozeBox = await pg.locator('.notes-reminder-row .notes-snooze button').first().boundingBox();
        ck('phone: the retime and snooze buttons are both at least 44 px', !!retimeBox && !!snoozeBox
            && retimeBox.height >= 44 && retimeBox.width >= 44 && snoozeBox.height >= 44 && snoozeBox.width >= 44,
            JSON.stringify({ retimeBox, snoozeBox }));
        ck('phone: they stay inside the row, which stays inside 390 px', !!retimeBox && retimeBox.x + retimeBox.width <= vw + 0.5,
            JSON.stringify({ right: retimeBox && retimeBox.x + retimeBox.width, vw }));
        // The OPEN field, which the two closed buttons above never measure:
        // the cluster takes a line of its own inside the row rather than
        // squeezing the item out of 390 px, and the field is 16px so iOS does
        // not zoom the page. 'My shared errand' is mine and plain-dated, so
        // the retime is offered and it is the inline field, not the dialog.
        const mineRow = pg.locator('.notes-reminder-row', { hasText: 'My shared errand' }).first();
        await mineRow.locator('button[aria-label^="Change the time"]').tap();
        await pg.waitForSelector('.notes-retime-edit input[type="datetime-local"]', { timeout: 5000 });
        const open = await pg.evaluate(() => {
            const row = [...document.querySelectorAll('.notes-reminder-row')].find(r => r.textContent.includes('My shared errand'));
            const box = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
            const field = row.querySelector('.notes-retime-edit');
            const input = field.querySelector('input');
            return {
                row: box(row), text: box(row.querySelector('.notes-reminder-text')),
                clock: box(row.querySelector('.notes-retime button')), field: box(field), input: box(input),
                px: parseFloat(getComputedStyle(input).fontSize),
                wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            };
        });
        ck('phone: the open retime field stays inside 390 px and adds no page scroll',
            open.field.l >= -0.5 && open.field.r <= vw + 0.5 && open.input.r <= vw + 0.5 && !open.wide, JSON.stringify(open));
        ck('phone: it takes a line of its own under the item text, not a squeeze beside it',
            open.field.t >= open.text.b - 0.5 && Math.abs(open.field.t - open.clock.t) <= 22 && open.field.b <= open.row.b + 0.5,
            JSON.stringify(open));
        ck('phone: the retime field is 16 px, so iOS does not zoom', open.px >= 16, String(open.px));
        await shotOf(pg)('retime-open-phone');
        await pg.keyboard.press('Escape');
        ck('phone: Escape closes it again', await pg.locator('.notes-retime-edit').count() === 0);
        await shotOf(pg)('hint-phone');
        // ---- A snooze on a line of its own keeps to the right edge ----
        // The OPEN retime takes a whole line of the row (above), so the
        // snooze after it starts a line with no due time on it. The two-line
        // row (Reminders.css) first pushed the actions right with the time's
        // auto margin alone, which cannot reach that line: the snooze sat at
        // the line's START, and its menu — anchored to the button's right
        // edge and opening leftwards — hung off the left of the screen
        // (measured in a fixture: x=-40..66). At 320 px an item with all
        // three timing marks and a date in another year wraps its snooze
        // alone the same way; this pass runs at 390, where the open retime
        // is the shape it can reach. So: open the retime again, open THIS
        // row's snooze, and hold the button to the row's right edge and the
        // menu on screen with BOTH edges — the Púca preset check below looks
        // only at the right one.
        await mineRow.locator('button[aria-label^="Change the time"]').tap();
        await pg.waitForSelector('.notes-retime-edit input[type="datetime-local"]', { timeout: 5000 }).catch(() => {});
        const loneSnooze = mineRow.locator('.notes-snooze > button');
        const hasLone = await loneSnooze.count() === 1;
        ck('phone: the row with its retime open carries a snooze (precondition)',
            hasLone && await pg.locator('.notes-retime-edit').count() === 1);
        if (hasLone) {
            await loneSnooze.tap();
            await pg.waitForSelector('.notes-reminder-row .notes-snooze-menu', { timeout: 5000 }).catch(() => {});
            const lone = await pg.evaluate(() => {
                const r1 = n => Math.round(n * 10) / 10;
                const row = [...document.querySelectorAll('.notes-reminder-row')].find(r => r.textContent.includes('My shared errand'));
                const box = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: r1(b.left), r: r1(b.right), t: r1(b.top), b: r1(b.bottom) }; };
                const rb = row.getBoundingClientRect();
                return {
                    client: document.documentElement.clientWidth,
                    contentR: r1(rb.right - parseFloat(getComputedStyle(row).paddingRight)),
                    field: box(row.querySelector('.notes-retime-edit')),
                    snooze: box(row.querySelector('.notes-snooze > button')),
                    menu: box(row.querySelector('.notes-snooze-menu')),
                };
            });
            ck('phone: with the retime open, the snooze keeps to the row’s right edge',
                !!lone.snooze && Math.abs(lone.snooze.r - lone.contentR) <= 0.5, JSON.stringify(lone));
            ck('phone: and its menu opens on screen, left edge included',
                !!lone.menu && lone.menu.l >= -0.5 && lone.menu.r <= lone.client + 0.5, JSON.stringify(lone));
            await shotOf(pg)('snooze-under-open-retime-phone');
            await loneSnooze.tap();   // the button toggles its own menu shut
        }
        await mineRow.locator('button[aria-label^="Change the time"]').tap();   // and the clock its field
        await pg.waitForSelector('.notes-retime-edit', { state: 'detached', timeout: 5000 }).catch(() => {});
        ck('phone: the snooze menu and the retime field close again',
            await pg.locator('.notes-snooze-menu').count() === 0 && await pg.locator('.notes-retime-edit').count() === 0);
        // ---- end of the lone-snooze block ----
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
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            vw: document.documentElement.clientWidth,
            rows: [...document.querySelectorAll('.tasks-reminders .notes-reminder-row')].map(r => r.getBoundingClientRect().right),
            box: (() => { const b = document.querySelector('.tasks-reminders input[type="checkbox"]'); return b ? b.getBoundingClientRect().width : 0; })(),
        }));
        ck('púca reminders (phone): no horizontal overflow and every row fits', !pucaPhone.overflow && pucaPhone.rows.length > 0 && pucaPhone.rows.every(r => r <= pucaPhone.vw + 0.5), JSON.stringify(pucaPhone));
        ck('púca reminders (phone): the tick box grew for a finger', pucaPhone.box >= 20, String(pucaPhone.box));
        // ---- Reminders row at 390x844 keeps its text readable (Púca's tab) ----
        // The same rows as the Notes block in the phone pass, through Púca's
        // own front door. This tab never had the wrap at all (it lived in
        // notes.css), so its text was squeezed on ONE line instead: on the
        // 0.9.817 CSS every row here failed, 25.5-30.2% ("Bread" 102.5px of
        // a 358px row). It rides the shared Reminders.css now.
        const pucaText = await pg.evaluate(() => [...document.querySelectorAll('.tasks-reminders .notes-reminder-row')].map(row => {
            const r1 = n => Math.round(n * 10) / 10;
            const t = row.querySelector('.notes-reminder-text');
            const rb = row.getBoundingClientRect();
            const tb = t ? t.getBoundingClientRect() : null;
            const box = row.firstElementChild && row.firstElementChild !== t ? row.firstElementChild.getBoundingClientRect() : null;
            return {
                label: t && t.firstChild ? String(t.firstChild.textContent).trim().slice(0, 20) : '(no text cell)',
                rowW: r1(rb.width), textW: tb ? r1(tb.width) : 0, share: tb ? r1(tb.width / rb.width * 100) : 0,
                beside: !!(tb && box && tb.top < box.bottom && box.top < tb.bottom && tb.left >= box.right),
            };
        }));
        const pucaNarrow = pucaText.filter(x => x.textW < x.rowW * 0.5 || !x.beside);
        ck('púca reminders (phone): every row gives its text half the row or more, beside its tick box',
            pucaText.length > 0 && pucaNarrow.length === 0,
            JSON.stringify({ rows: pucaText.length, narrow: pucaNarrow.map(x => `"${x.label}" text ${x.textW}px of a ${x.rowW}px row = ${x.share}%${x.beside ? '' : ', below its box'}`) }));
        // clientWidth, not innerWidth: see the Notes block in the phone pass.
        const pucaWide = await pg.evaluate(() => {
            const client = document.documentElement.clientWidth;
            const out = [];
            for (const row of document.querySelectorAll('.tasks-reminders .notes-reminder-row')) {
                const rb = row.getBoundingClientRect();
                if (rb.right > client + 0.5) out.push(`row r=${Math.round(rb.right)}`);
                for (const el of row.querySelectorAll('*')) {
                    const b = el.getBoundingClientRect();
                    if (b.width > 0 && b.right > rb.right + 0.5) out.push(`${String(el.getAttribute('class') || el.tagName).split(' ')[0]} r=${Math.round(b.right)} row r=${Math.round(rb.right)}`);
                }
            }
            return { scroll: document.documentElement.scrollWidth, client, out: out.slice(0, 6) };
        });
        ck('púca reminders (phone): no sideways scroll, and nothing sticks out of a row (against clientWidth)',
            pucaWide.client > 0 && pucaWide.scroll <= pucaWide.client + 1 && pucaWide.out.length === 0, JSON.stringify(pucaWide));
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
            // THE UNION THE REAL PLUGIN ANSWERS (NotesNativePlugin.info).
            // A fake bridge that under-reports is worse than no bridge: with
            // 'transcribe' missing, canTranscribe() was false here, so the
            // one place the walk can reach the on-device write-down path —
            // this section — silently skipped it and stayed green.
            info: () => ({ api: 2, features: ['reminders', 'backgroundRefresh', 'exactAlarm', 'battery', 'share', 'calendar', 'launchNav', 'shareIn', 'navItem', 'tile', 'transcribe'] }),
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
            // Android's ON-DEVICE recogniser, answering the way the real one
            // does: {text} or {text: null, reason}. The walk swaps in the
            // refusal for the negative control. It is handed a cache PATH
            // and never audio — which the section below asserts.
            transcribePcm: () => ({ text: 'walk transcript one two three' }),
            requestAddTile: () => ({ ok: true }),
            removeListener: () => ({}),
        },
        // The cache round trip transcribeClip makes before it calls the
        // recogniser. Faked so the call goes NATIVE (the web Filesystem would
        // answer from IndexedDB and getUri would hand back a path no
        // recogniser could open), and so the walk can prove the temporary
        // plaintext PCM is deleted on every exit path, refusals included.
        Filesystem: {
            writeFile: o => ({ uri: `file:///cache/${o.path}` }),
            appendFile: () => ({}),
            getUri: o => ({ uri: `file:///cache/${o.path}` }),
            deleteFile: () => ({}),
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
        info.api === 2 && ['shareIn', 'navItem', 'tile', 'transcribe'].every(f => info.features.includes(f)), JSON.stringify(info));

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

    // --- 7. Writing a recording down, on this phone or not at all -------------
    // The browser half of this is section 4's refusal. THIS is the only place
    // the walk can reach the other branch at all: the transcriber lives
    // behind the plugin's 'transcribe' feature, so a regression in the
    // write-down path, in its refusal copy or in the deletion of the
    // temporary plaintext PCM left every gate green. The microphone is
    // Chromium's fake device and the page is muted — nothing is played and
    // no real microphone is opened.
    await actx.grantPermissions(['microphone'], { origin: baseURL });
    const offMachineA = [];
    a.on('request', rq => {
        const u = rq.url();
        if (u.startsWith('data:') || u.startsWith('blob:')) return;
        if (!LOCAL.has(hostOf(u))) offMachineA.push(u);
    });
    await toGrid();
    await a.locator('.notes-card', { hasText: 'Sketch' }).tap();
    await a.waitForSelector('.notes-editor .ni-actions button[aria-label="Voice note"]', { timeout: 15000 });
    const recordOnce = async () => {
        await a.tap('.notes-editor .ni-actions button[aria-label="Voice note"]');
        await a.waitForSelector('.notes-recorder', { timeout: 10000 });
        await sleep(1200);
        await a.tap('.notes-recorder button[aria-label="Stop recording"]');
        await a.waitForSelector('.notes-recorder audio', { timeout: 10000 });
        await a.getByRole('button', { name: 'Keep' }).tap();
    };
    /** The note's text, whichever way the field is showing it. */
    const bodyOfA = () => a.evaluate(() => {
        const t = document.querySelector('.notes-editor textarea.nb-text');
        if (t) return t.value;
        const r = document.querySelector('.notes-editor .nb-rendered');
        return r ? r.textContent : '';
    });
    const audioBefore = await a.locator('.notes-editor .ni-item.audio').count();
    await recordOnce();
    await a.waitForFunction(() => {
        const t = document.querySelector('.notes-editor textarea.nb-text');
        const r = document.querySelector('.notes-editor .nb-rendered');
        return /walk transcript/.test((t ? t.value : (r ? r.textContent : '')) || '');
    }, null, { timeout: 30000 }).catch(() => {});
    ck('voice note (app): what the phone heard is written into the note’s text',
        /walk transcript one two three/.test(await bodyOfA()), String(await bodyOfA()).slice(0, 140));
    ck('voice note (app): the recording is kept as well as written down',
        await a.locator('.notes-editor .ni-item.audio').count() === audioBefore + 1);
    const fsCalls = (await a.evaluate(() => window.__fakeAndroid.calls)).filter(c => c.plugin === 'Filesystem');
    const tCall = (await a.evaluate(() => window.__fakeAndroid.calls)).filter(c => c.method === 'transcribePcm').pop();
    ck('voice note (app): the recogniser is handed a cache PATH and a rate — never the audio',
        !!tCall && /^file:\/\/\/cache\//.test(tCall.options.path) && tCall.options.sampleRate === 16000
        && Object.keys(tCall.options).sort().join(',') === 'path,sampleRate', JSON.stringify(tCall && tCall.options));
    ck('voice note (app): the temporary plaintext PCM is written to the cache and deleted again',
        fsCalls.some(c => c.method === 'writeFile') && fsCalls.some(c => c.method === 'deleteFile'),
        JSON.stringify(fsCalls.map(c => c.method)));
    await shotOf(a)('voice-note-transcribed');

    // The refusal branch, on a phone with no on-device model: words, and the
    // recording kept. (Also the positive control for the check above — the
    // transcript lands only when the recogniser answers with one.)
    await a.evaluate(() => {
        window.__fakeAndroid.answers.NotesNative.transcribePcm = () => ({ text: null, reason: 'no-on-device-model' });
    });
    const bodyBefore = await bodyOfA();
    const audioBefore2 = await a.locator('.notes-editor .ni-item.audio').count();
    await recordOnce();
    await a.waitForSelector('.notes-editor .notes-transcribe-notice', { timeout: 30000 }).catch(() => {});
    const refusal = await a.locator('.notes-editor .notes-transcribe-notice').count() === 1
        ? (await a.locator('.notes-editor .notes-transcribe-notice').innerText()).trim() : '';
    ck('voice note (app): a phone with no on-device model says so, in words',
        /on-device speech model/i.test(refusal) && /recording is saved/i.test(refusal), refusal.slice(0, 140));
    ck('voice note (app): the refused recording is still kept, and nothing was written into the text',
        await a.locator('.notes-editor .ni-item.audio').count() === audioBefore2 + 1 && (await bodyOfA()) === bodyBefore);
    ck('voice note (app): nothing left this machine either way — the only transcriber is this phone',
        offMachineA.length === 0, offMachineA.slice(0, 3).join(','));
    await a.keyboard.press('Escape');
    await a.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 }).catch(() => {});

    ck('android shell: no page errors', errors.length === aErrors, errors[aErrors]);
    await actx.close();

    // The sign-in the APP shows a new device: "Stay signed in" starts TICKED
    // there (a phone is one person's) — the positive control for the
    // browser's clear default checked at desktop size. No storage state, so
    // this is the signed-out card.
    const sctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined, baseURL });
    await sctx.addInitScript(installFakeAndroid);
    const s = await sctx.newPage();
    watch(s);
    await s.goto('/notes/');
    const signedOutCard = await s.waitForSelector('.login-card', { timeout: 20000 }).then(() => true, () => false);
    const appStay = signedOutCard ? {
        checked: await s.locator(stayBox).isChecked({ timeout: 5000 }).catch(() => null),
        hint: await s.locator('#stay-signed-in-hint').textContent({ timeout: 5000 }).catch(() => null),
        app: await s.evaluate(() => window.Capacitor?.getPlatform?.() ?? null),
    } : null;
    ck('android shell: the app\'s sign-in starts with Stay signed in TICKED, and speaks of the device',
        !!appStay && appStay.app === 'android' && appStay.checked === true && /^This device then stays signed in/.test(appStay.hint ?? ''),
        JSON.stringify(appStay));
    await sctx.close();
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
    // clientWidth, not innerWidth: see audit() in the phone pass.
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    // At least one must be SHOWN: "every one of none is inside" passed when
    // the thing under test was not on screen at all.
    const within = sel => { const els = [...document.querySelectorAll(sel)].filter(vis); return els.length > 0 && els.every(el => { const r = el.getBoundingClientRect(); return r.left >= -0.5 && r.right <= vw + 0.5 && r.top >= -0.5 && r.bottom <= vh + 0.5; }); };
    const small = [...document.querySelectorAll('.notes-update-gate button, .notes-update-strip button')].filter(vis)
        .map(b => b.getBoundingClientRect()).filter(r => r.width < 43.5 || r.height < 43.5).map(r => `${Math.round(r.width)}x${Math.round(r.height)}`);
    return { overflow: document.documentElement.scrollWidth > vw + 1, scrollWidth: document.documentElement.scrollWidth, vw, small,
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

// ---- Label pager (swipe between lists) ----
// All notes, then one page per label, with a tab strip above them
// (components/NotesPager.tsx): the strip in the rail's order, tab/keyboard/
// rail/deep-link navigation, search as the negative control, a draft kept
// through a trackpad flick, an open note kept through a settle, tab/panel
// ids; on the phone real touch swipes, a grip drag that must not move the
// pager, a vertical scroll inside a page and a list's reading position kept;
// and one grid at rest at fractional widths (125% desktop, Pixel-class
// phone). LAST on purpose: it seeds five labels and seven notes of its own,
// and nothing after it can be perturbed by them.
await pagerWalk({ browser, baseURL, state, ck, watch, shotOf, errors });

await browser.close();
const skipNotes = [
    skipped ? `${skipped} check(s) SKIPPED — see the SKIP lines above (most need the psql DSN)` : '',
    calendar.skipped ? `${calendar.skipped} calendar database proof(s) SKIPPED (no DSN)` : '',
].filter(Boolean).join('; ');
console.log(fail === 0 ? `\nALL PASS${skipNotes ? ` (${skipNotes})` : ''}` : `\n${fail} FAILED${skipNotes ? `; ${skipNotes}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
