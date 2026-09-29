// Púca Notes INSIDE the desktop app — the live walk (REQUIRED gate; CLAUDE.md).
//
// On the desktop the rail's "Tasks & notes" opens Púca Notes inside Púca's own
// page (components/NotesDesktopView.tsx). Every other gate is blind to that
// path: NotesDesktopView renders only under Tauri, notes-walk.mjs drives
// Notes' own /notes/ page, and the vitest suites mount pieces of it under
// jsdom with the shell mocked. This drives the BUILT main bundle in headless
// Chromium with a FAKE desktop shell injected before any page script (a
// window.__TAURI_INTERNALS__ that answers every command the app sends with a
// safe default and RECORDS each one — the rc-latency-2peer.mjs pattern), against
// a throwaway backend. Nothing is shown, nothing is played, no window opens:
// the browser is headless with --mute-audio and a fake media device, and the
// "shell" is a JavaScript object that writes nothing to disk.
//
// What it proves, as the person at the PC would see it:
//   - registered and signed in through the main app, the rail's Tasks & notes
//     opens Notes INSIDE the app: the address stays /chat, the document is
//     not reloaded or navigated, the same WebSocket stays open, notes.css is
//     the first stylesheet in <head>, and Notes' portals land in the view;
//   - a note made in the composer; a Markdown answer from an assistant pasted
//     into the composer's title asks first, then "Add 4 items" gives clean
//     items and the heading as the title; search finds it; a colour and a
//     label set from the open note; the note opens and closes;
//   - to a server channel and back: Notes is hidden (inert) but kept — the
//     same shell, the search still typed, the same socket — and c, / and ?
//     pressed on the page from the chat do nothing to Notes, not even for a
//     moment, while the same presses DO act with Notes on screen (the
//     positive control);
//   - a chat toast still appears, rendered by Púca's own React root (not a
//     second toast sink inside Notes), and clicking "Saved to …" opens Notes,
//     where the message has arrived as an item;
//   - Export notes as Markdown asks where (the shell's Save As), then writes
//     through the shell's attachment_save with the note in the bytes — never
//     a browser download — and a non-ASCII folder arrives whole;
//   - Sign out in Notes' menu lands on Púca's login with no Notes UI left, its
//     query cache emptied and its sealed on-device cache deleted.
// Negative controls, so none of that can pass vacuously: without the fake
// shell the SAME rail button opens the Tasks view (the web app's behaviour)
// and never fetches Notes' chunk; the "Notes is inside the app" check and the
// export check are each run against a deliberately wrong target and must
// report false there; and before sign-out the query-cache and the on-device
// cache checks must see something to delete.
//
// Every check prints PASS or FAIL; a precondition that did not happen is a
// FAIL, never a silent pass. Any FAIL exits 1.
//
// Needs (all on 127.0.0.1, all throwaway — never the dev or production DB):
//   1. a backend against a fresh database, e.g. PORT=3301 with
//      AUTH_RATE_LIMIT_PER_SECOND=1000 AUTH_RATE_LIMIT_BURST=1000 (the walk
//      signs up and signs in); health is GET / == 200;
//   2. the main bundle built against it, into a directory of its own so the
//      shippable dist/ is untouched:
//        PUCA_ALLOW_LOCAL_BUILD=1 VITE_API_URL=http://127.0.0.1:3301 \
//          npx vite build --outDir <dir> --emptyOutDir
//   3. that directory served: DIST=<dir> PORT=5181 node e2e/serve-dist.mjs
// Usage (from frontend/):
//   APP=http://127.0.0.1:5181 API=http://127.0.0.1:3301 node e2e/notes-desktop-embed.mjs [shots-dir]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const APP = process.env.APP || 'http://127.0.0.1:5181';
const API = process.env.API || 'http://127.0.0.1:3301';
const SHOTS = process.argv[2] || '';
const username = 'embed_' + Math.random().toString(36).slice(2, 8);
const password = 'Password123!';
const SERVER = 'Walk Server';
const MESSAGE = 'Walk message to keep';
/** Where the fake Save As dialog "chose": a folder and a name outside ASCII. */
const SAVE_AS = 'C:\\Users\\Zoë\\Documents\\Púca notes – export.md';

let failures = 0;
const ck = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
    if (!ok) failures++;
};
/** A check run against a target where it MUST come out false. */
const control = (name, result, detail) => ck(`control: ${name}`, result === false, detail ?? `the check answered ${result}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (page, fn, arg, timeout = 10000) =>
    page.waitForFunction(fn, arg, { timeout }).then(() => true).catch(() => false);

if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let shotN = 0;
const shot = async (page, name) => {
    if (!SHOTS) return;
    shotN++;
    await page.screenshot({ path: `${SHOTS}/${String(shotN).padStart(2, '0')}-${name}.png` });
};

// ---------------------------------------------------------------------------
// Page-side scripts, installed before any page script runs.

/** The desktop shell, faked. Every command is recorded in __shell.calls;
 *  attachment_save's body is decoded and kept whole in __shell.saves. An
 *  unknown PLUGIN command throws (as a missing plugin would) and an unknown
 *  app command answers null — both recorded, so the walk can say which. */
const FAKE_SHELL = `(() => {
    const shell = window.__shell = { calls: [], unknown: [], saves: [], dialogs: [], notifications: [] };
    const SAVE_AS = ${JSON.stringify(SAVE_AS)};
    const known = {
        reset_capture_state: () => null,
        set_close_to_tray: () => null,
        set_unread_badge: () => null,
        set_screen_share_indicator: () => null,
        set_clip_armed_indicator: () => null,
        set_device_session_indicator: () => null,
        start_hotkey_listener: () => null,
        stop_hotkey_listener: () => null,
        attention_main_window: () => null,
        release_attention_topmost: () => null,
        clear_webview_permissions: () => null,
        hide_screen_capture_bar: () => null,
        list_monitors: () => ({ monitors: [{ index: 0, left: 0, top: 0, width: 1280, height: 800, primary: true }], virt_left: 0, virt_top: 0, virt_width: 1280, virt_height: 800 }),
        get_running_apps: () => [],
        get_idle_seconds: () => 0,
        list_anticheat_processes: () => [],
        lan_info: () => null,
        rc_leftovers_status: () => null,
        log_stream_diag: () => null,
        open_external: () => null,
        // Not under test, answered as a machine without them would be:
        // no device key (so this walk enrols no device), no autostart, no
        // lock-screen service.
        device_key_ensure: () => { throw new Error('fake shell: this walk has no device key'); },
        autostart_enabled: () => false,
        service_state: () => ({ installed: false, running: false, available: false, problem: null }),
        attachment_save: (body, options) => {
            const headers = (options && options.headers) || {};
            const bytes = body instanceof Uint8Array ? body : null;
            shell.saves.push({
                raw: bytes !== null,
                text: bytes ? new TextDecoder().decode(bytes) : null,
                headers: { ...headers },
            });
            const dest = headers['x-dest-path'];
            return dest ? decodeURIComponent(dest) : 'C:\\\\Users\\\\walk\\\\Downloads\\\\Puca\\\\' + decodeURIComponent(headers['x-file-name'] || 'attachment');
        },
        'plugin:dialog|save': (args) => { shell.dialogs.push(args && args.options); return SAVE_AS; },
        'plugin:notification|is_permission_granted': () => false,
        'plugin:notification|request_permission': () => 'denied',
        'plugin:notification|notify': (args) => { shell.notifications.push(args); return null; },
        'plugin:event|listen': () => Math.floor(Math.random() * 1e9),
        'plugin:event|unlisten': () => null,
        'plugin:event|emit': () => null,
        'plugin:updater|check': () => null,
        'plugin:app|version': () => '0.0.0-walk',
    };
    window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
        plugins: { path: { sep: '\\\\', delimiter: ';' } },
        callbacks: {},
        transformCallback(cb, once) {
            const id = Math.floor(Math.random() * 1e9);
            window['_' + id] = (r) => { if (once) delete window['_' + id]; return cb && cb(r); };
            return id;
        },
        unregisterCallback(id) { delete window['_' + id]; },
        convertFileSrc(p) { return p; },
        async invoke(cmd, args, options) {
            shell.calls.push(cmd);
            if (cmd in known) return known[cmd](args, options);
            shell.unknown.push(cmd);
            if (cmd.startsWith('plugin:')) throw new Error('fake shell: no plugin ' + cmd);
            return null;
        },
    };
})();`;

/** Every WebSocket the page opens; a stamp per document (a reload or a real
 *  navigation makes a new one); every anchor download the page clicks. */
const RECORDERS = `(() => {
    window.__docStamp = Math.random().toString(36).slice(2);
    window.__sockets = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
        constructor(...a) { super(...a); window.__sockets.push(this); }
    };
    // Every key press: where it was aimed, and whether anything had claimed
    // it by the end of its dispatch (read a tick later).
    window.__keyLog = [];
    window.addEventListener('keydown', e => {
        const t = e.target;
        const rec = { key: e.key, target: t === document.body ? 'body' : (t && t.tagName ? t.tagName.toLowerCase() + (typeof t.className === 'string' && t.className ? '.' + t.className.split(' ')[0] : '') : String(t)) };
        window.__keyLog.push(rec);
        setTimeout(() => { rec.prevented = e.defaultPrevented; }, 0);
    }, true);
    window.__anchorDownloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        if (this.hasAttribute('download')) window.__anchorDownloads.push(this.download || this.href);
        return click.call(this);
    };
})();`;

// ---------------------------------------------------------------------------
// Preflight: a walk against nothing must not pass by default.

const health = await fetch(`${API}/`).then(r => r.status).catch(e => String(e));
ck('preflight: the throwaway backend answers GET /', health === 200, `status ${health}`);
const index = await fetch(`${APP}/`).then(r => r.text()).catch(() => '');
ck('preflight: the built bundle is served', /assets\/index-[\w-]+\.js/.test(index));
if (failures) {
    console.log(`\n${failures} FAIL — nothing to walk`);
    process.exit(1);
}

const browser = await chromium.launch({ args: [
    '--mute-audio',                          // a walk never makes a sound
    '--use-fake-device-for-media-stream',    // and never opens a real microphone or camera
    '--use-fake-ui-for-media-stream',
] });

const pageErrors = [];
function watch(page, tag) {
    // Accept any confirm (App's sign-out asks one only when something is unsent).
    page.on('dialog', d => { d.accept().catch(() => {}); });
    page.on('pageerror', e => { pageErrors.push(`${tag}: ${String(e).slice(0, 300)}`); console.log(`[pageerror ${tag}]`, String(e).slice(0, 300)); });
    page.on('console', m => { if (m.type() === 'error') console.log(`[console.error ${tag}]`, m.text().slice(0, 200)); });
    page.on('response', r => { if (r.status() >= 400) console.log(`[http ${tag}] ${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`); });
}

/** Púca's own onboarding overlays swallow clicks; none of them is under test. */
async function clearOnboarding(page) {
    if (await page.locator('.recovery-confirm input[type="checkbox"]').count()) {
        await page.check('.recovery-confirm input[type="checkbox"]').catch(() => {});
        await page.click('.recovery-done-btn').catch(() => {});
    }
    await page.click('.recovery-reminder-actions .recovery-done-btn', { timeout: 1500 }).catch(() => {});
    await page.click('.welcome-popup-close', { timeout: 1500 }).catch(() => {});
}

// ---- Notes-inside-the-app, as one predicate (run on the desktop AND the web) --
const notesInsideApp = page => page.evaluate(() => {
    const view = document.querySelector('.notes-desktop-view');
    const app = view && view.querySelector('.notes-app.embedded');
    if (!view || !app || view.hasAttribute('inert')) return false;
    const r = app.getBoundingClientRect();
    return location.pathname === '/chat'
        && document.querySelector('.chat-container') !== null
        && getComputedStyle(view).visibility === 'visible'
        && r.width > 0 && r.height > 0;
});

const appSocket = page => page.evaluate(() => {
    const ws = (window.__sockets || []).filter(s => /\/ws(\?|$)/.test(s.url));
    const last = ws[ws.length - 1];
    return { count: ws.length, open: !!last && last.readyState === 1 };
});

/** Paste a real ClipboardEvent at the element a person would be typing in. */
const pasteText = (page, selector, text) => page.evaluate(([sel, t]) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no ${sel}`);
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
}, [selector, text]);

// =============================================================================
// 1. The desktop app: sign up through Púca, with the fake shell in place
// =============================================================================
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });
await ctx.addInitScript(FAKE_SHELL);
await ctx.addInitScript(RECORDERS);
const page = await ctx.newPage();
watch(page, 'desktop');
let mainFrameNavigations = 0;
page.on('framenavigated', f => { if (f === page.mainFrame()) mainFrameNavigations++; });
const notesChunkRequests = [];
page.on('request', rq => { if (/NotesDesktopView-[\w-]+\.js/.test(rq.url())) notesChunkRequests.push(rq.url()); });

await page.goto(`${APP}/login`);
await page.waitForSelector('.toggle-mode', { timeout: 20000 });
await page.click('.toggle-mode');
await page.fill('#username', username);
await page.fill('#password', password);
await page.click('button[type="submit"]');
const signedIn = await page.waitForURL('**/chat', { timeout: 30000 }).then(() => true).catch(() => false);
ck('sign-up: through the main app, onto /chat', signedIn, page.url());
await sleep(800);
await clearOnboarding(page);
ck('shell: the app believes it is the desktop app, and talks to the shell',
    await page.evaluate(() => '__TAURI_INTERNALS__' in window && window.__shell.calls.length > 0),
    (await page.evaluate(() => [...new Set(window.__shell.calls)].join(','))).slice(0, 200));

// A server, so there is a channel to go to and a message to keep.
await page.locator('.server-icon.add-server').click({ timeout: 5000 });
await page.locator('.template-card').first().click({ timeout: 5000 });
await page.locator('.audience-card').first().click({ timeout: 5000 });
await page.locator('.server-name-input input').fill(SERVER);
await page.locator('.wizard-actions .create-btn').click();
const inChannel = await page.waitForSelector('.message-textarea', { timeout: 20000 }).then(() => true).catch(() => false);
ck('setup: a server of our own, its text channel open', inChannel);
await clearOnboarding(page);
await page.locator('.message-textarea').fill(MESSAGE);
await page.keyboard.press('Enter');
const posted = await page.waitForSelector(`.message:has-text("${MESSAGE}")`, { timeout: 15000 }).then(() => true).catch(() => false);
ck('setup: a message posted in the channel', posted);
ck('Notes\' chunk is not fetched before it is asked for', notesChunkRequests.length === 0, notesChunkRequests.join(','));

// =============================================================================
// 2. Tasks & notes → Púca Notes, inside the app
// =============================================================================
const before = await page.evaluate(() => ({ path: location.pathname, stamp: window.__docStamp }));
const sockBefore = await appSocket(page);
ck('setup: the app\'s WebSocket is open before Notes opens', sockBefore.open, JSON.stringify(sockBefore));
const navBefore = mainFrameNavigations;

await page.click('.server-icon.notes-self');
const appeared = await page.waitForSelector('.notes-desktop-view:not([inert]) .notes-app.embedded', { timeout: 20000 }).then(() => true).catch(() => false);
ck('rail: Tasks & notes opens Púca Notes', appeared);
await page.waitForSelector('.notes-desktop-view .notes-empty', { timeout: 15000 }).catch(() => {});
ck('notes: inside the app — address, document and chat all still Púca\'s', await notesInsideApp(page));
const after = await page.evaluate(() => ({ path: location.pathname, stamp: window.__docStamp }));
ck('notes: location.pathname is unchanged', after.path === before.path && after.path === '/chat', `${before.path} → ${after.path}`);
ck('notes: no navigation and no reload (same document, no frame navigation)',
    after.stamp === before.stamp && mainFrameNavigations === navBefore, `navigations ${mainFrameNavigations - navBefore}`);
const sockAfter = await appSocket(page);
ck('notes: the same WebSocket is still open — no new one', sockAfter.open && sockAfter.count === sockBefore.count, JSON.stringify(sockAfter));
ck('notes: its chunk was fetched once asked for', notesChunkRequests.length === 1, notesChunkRequests.join(','));
ck('notes: the rail button shows it as the view on screen', await page.locator('.server-icon.notes-self.active').count() === 1);
ck('notes: notes.css is the FIRST stylesheet in <head>', await page.evaluate(() => {
    const first = document.head.querySelector('style, link[rel="stylesheet"]');
    return !!first && first.hasAttribute('data-notes-desktop') && document.head.querySelectorAll('style[data-notes-desktop]').length === 1;
}));
ck('notes: the empty state', /Take a note/.test(await page.locator('.notes-desktop-view .notes-empty').innerText().catch(() => '')));
await shot(page, 'notes-open');

// =============================================================================
// 3. The composer, and an assistant's Markdown pasted into its title
// =============================================================================
const openComposer = async () => {
    await page.click('.notes-quickadd-collapsed');
    await until(page, () => document.activeElement?.closest('.notes-quickadd-item') != null, null, 5000);
};
await openComposer();
await page.fill('.notes-quickadd-title', 'Groceries');
const item = i => page.locator('.notes-quickadd-item input').nth(i);
await item(0).fill('Milk');
await item(0).press('Enter');
await item(1).fill('Bread');
await item(1).press('Enter');
await item(2).fill('Eggs');
await page.getByRole('button', { name: 'Done' }).click();
const groceries = () => page.locator('.notes-card', { hasText: 'Groceries' });
await until(page, () => [...document.querySelectorAll('.notes-card')].some(c => c.textContent.includes('Groceries') && c.querySelectorAll('.notes-card-item').length === 3), null, 15000);
ck('composer: a note with its items, in typed order',
    (await groceries().locator('.notes-card-item-text').allInnerTexts()).join(',') === 'Milk,Bread,Eggs',
    (await groceries().locator('.notes-card-item-text').allInnerTexts()).join(','));

const ANSWER = [
    '## Set up the new router',
    '',
    'Here’s how to do it:',
    '',
    '1. **Unplug** the old router',
    '2. Plug the new one into the `WAN` port',
    '3. Wait for the *light* to turn green',
    '4. Log in at the admin page and change the password',
    '',
    'That’s it — you’re done!',
].join('\n');
const CLEAN = ['Unplug the old router', 'Plug the new one into the WAN port', 'Wait for the light to turn green', 'Log in at the admin page and change the password'];
await openComposer();
await pasteText(page, '.notes-quickadd-title', ANSWER);
const asked = await page.waitForSelector('.notes-paste-dialog', { timeout: 5000 }).then(() => true).catch(() => false);
ck('paste: an assistant\'s checklist in the title asks first', asked);
ck('paste: nothing is added before the answer', await page.locator('.notes-quickadd-item input').evaluateAll(els => els.every(e => e.value === '')));
ck('paste: the prompt lists the clean steps',
    (await page.locator('.notes-paste-line').allInnerTexts()).join('|') === CLEAN.join('|'),
    (await page.locator('.notes-paste-line').allInnerTexts()).join('|'));
ck('paste: the prompt is Notes\' own, in the view\'s layer',
    await page.locator('.notes-desktop-layer .notes-paste-dialog').count() === 1);
await shot(page, 'paste-prompt');
await page.getByRole('button', { name: 'Add 4 items' }).click();
await until(page, () => document.querySelectorAll('.notes-quickadd-item input').length === 4, null, 5000);
ck('paste: "Add 4 items" gives clean items — no numbers, no Markdown, no prose',
    (await page.locator('.notes-quickadd-item input').evaluateAll(els => els.map(e => e.value))).join('|') === CLEAN.join('|'),
    (await page.locator('.notes-quickadd-item input').evaluateAll(els => els.map(e => e.value))).join('|'));
ck('paste: the heading became the title', await page.inputValue('.notes-quickadd-title') === 'Set up the new router', await page.inputValue('.notes-quickadd-title'));
await page.getByRole('button', { name: 'Done' }).click();
const router = () => page.locator('.notes-card', { hasText: 'Set up the new router' });
await until(page, () => [...document.querySelectorAll('.notes-card')].some(c => c.textContent.includes('Set up the new router') && c.querySelectorAll('.notes-card-item').length === 4), null, 15000);
ck('paste: saved as a note with those four items',
    (await router().locator('.notes-card-item-text').allInnerTexts()).join('|') === CLEAN.join('|'));

// ---- Search ------------------------------------------------------------------
await page.fill('.notes-search input', 'green');
await sleep(400);
ck('search: finds the pasted note by an item',
    await page.locator('.notes-card').count() === 1 && await router().count() === 1,
    `${await page.locator('.notes-card').count()} card(s)`);
await page.click('button[aria-label="Clear search"]');
await until(page, () => document.querySelectorAll('.notes-card').length === 2, null, 5000);

// ---- Open the note: a colour and a label, then close it ----------------------
await router().click();
const opened = await page.waitForSelector('.notes-editor', { timeout: 10000 }).then(() => true).catch(() => false);
ck('editor: the note opens', opened);
ck('editor: portaled into the view\'s own layer, not the body', await page.locator('.notes-desktop-layer .notes-editor').count() === 1);
await page.click('.notes-editor-foot button[aria-label="Colour"]');
await page.waitForSelector('.notes-popover', { timeout: 5000 }).catch(() => {});
await page.click('.notes-swatch[data-color="mint"]');
ck('editor: the colour applies', await page.locator('.notes-editor[data-color="mint"]').count() === 1);
await page.keyboard.press('Escape');
await sleep(150);
ck('editor: Escape closes the colour popover, not the note', await page.locator('.notes-popover').count() === 0 && await page.locator('.notes-editor').count() === 1);
await page.click('.notes-editor-foot button[aria-label="Labels"]');
await page.waitForSelector('.notes-labels-new input', { timeout: 5000 }).catch(() => {});
await page.fill('.notes-labels-new input', 'Home');
await page.press('.notes-labels-new input', 'Enter');
await sleep(200);
ck('editor: a typed label is ticked', await page.locator('.notes-labels-list input:checked').count() === 1);
await page.keyboard.press('Escape');
await sleep(150);
await shot(page, 'editor');
await page.getByRole('button', { name: 'Close', exact: true }).click();
const closed = await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 }).then(() => true).catch(() => false);
ck('editor: the note closes', closed);
ck('card: the colour and the label show on the card',
    await router().getAttribute('data-color') === 'mint' && /Home/.test(await router().locator('.notes-card-foot').innerText().catch(() => '')));

// =============================================================================
// 4. To a channel and back: Notes kept, hidden, and still itself
// =============================================================================
await page.fill('.notes-search input', 'milk');
await sleep(400);
ck('setup: a search typed in Notes before leaving it', await page.locator('.notes-card').count() === 1 && await groceries().count() === 1);
await page.evaluate(() => { document.querySelector('.notes-app.embedded').__walkMark = 'kept'; });
const sockMid = await appSocket(page);

await page.click(`.server-icons .server-icon[title="${SERVER}"]`);
await page.waitForSelector('.notes-desktop-view[inert]', { timeout: 5000 }).catch(() => {});
ck('channel: Notes is hidden, not unmounted (inert, invisible, still there)', await page.evaluate(() => {
    const v = document.querySelector('.notes-desktop-view');
    return !!v && v.hasAttribute('inert') && getComputedStyle(v).visibility === 'hidden'
        && document.querySelector('.notes-app.embedded')?.__walkMark === 'kept';
}));
ck('channel: the chat is on screen', await page.locator('.message-textarea').isVisible().catch(() => false)
    && await page.locator(`.message:has-text("${MESSAGE}")`).isVisible().catch(() => false));
control('"Notes is inside the app" answers false while the chat is on screen', await notesInsideApp(page));

await page.click('.server-icon.notes-self');
await page.waitForSelector('.notes-desktop-view:not([inert])', { timeout: 5000 }).catch(() => {});
ck('back: Notes is on screen again', await notesInsideApp(page));
ck('back: the SAME shell, not a new one', await page.evaluate(() => document.querySelector('.notes-app.embedded')?.__walkMark === 'kept'));
ck('back: the search is still typed and still filtering',
    await page.inputValue('.notes-search input') === 'milk' && await page.locator('.notes-card').count() === 1);
const sockBack = await appSocket(page);
ck('back: still the same WebSocket, still open', sockBack.open && sockBack.count === sockMid.count, JSON.stringify(sockBack));
await page.click('button[aria-label="Clear search"]');
await until(page, () => document.querySelectorAll('.notes-card').length === 2, null, 5000);

// =============================================================================
// 5. Keys: Notes' shortcuts act on Notes, never from the chat
// =============================================================================
// Pressed with the focus on the page itself — the path a window-level
// shortcut listens on, and where each of these acts on Notes' own page. No
// search is typed now, so the composer is there for `c` to open.
const blur = () => page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
/** Record anything Notes does in answer to a key, even for a moment: the
 *  composer opening, a dialog of its own (the shortcuts help), its search
 *  taking the focus. */
const watchNotesActs = () => page.evaluate(() => {
    const acted = window.__notesActed = [];
    const look = () => {
        if (document.querySelector('.notes-quickadd-open')) acted.push('composer');
        if (document.querySelector('.notes-desktop-view .notes-dialog')) acted.push('dialog');
    };
    window.__notesObserver?.disconnect();
    window.__notesObserver = new MutationObserver(look);
    window.__notesObserver.observe(document.querySelector('.notes-desktop-view'), { subtree: true, childList: true, attributes: true });
    document.querySelector('.notes-search input')?.addEventListener('focus', () => acted.push('search'));
    look();
});
const pressOnPage = async (keys) => {
    const from = await page.evaluate(() => window.__keyLog.length);
    for (const k of keys) {
        await blur();
        await page.keyboard.press(k);
        await sleep(300);
    }
    return page.evaluate(n => ({ acted: [...new Set(window.__notesActed)], keys: window.__keyLog.slice(n) }), from);
};

// On screen first: the positive control — the same keys DO act here.
await watchNotesActs();
const onScreenActs = [];
for (const k of ['c', '/', '?']) {
    const r = await pressOnPage([k]);
    onScreenActs.push(`${k}:${r.acted.join('+') || 'nothing'}`);
    await page.keyboard.press('Escape');
    await until(page, () => !document.querySelector('.notes-quickadd-open') && !document.querySelector('.notes-desktop-view .notes-dialog'), null, 3000);
    await watchNotesActs();
}
control('"c did nothing to Notes" answers false with Notes on screen', !onScreenActs[0].includes('composer'), onScreenActs[0]);
control('"/ did nothing to Notes" answers false with Notes on screen', !onScreenActs[1].includes('search'), onScreenActs[1]);
control('"? did nothing to Notes" answers false with Notes on screen', !onScreenActs[2].includes('dialog'), onScreenActs[2]);

// Then the chat: the very same presses reach the page, and Notes hears none.
await page.click(`.server-icons .server-icon[title="${SERVER}"]`);
await page.waitForSelector('.notes-desktop-view[inert]', { timeout: 5000 }).catch(() => {});
await watchNotesActs();
const inChat = await pressOnPage(['c', '/', '?']);
ck('keys: pressed in the chat with the focus on the page, as a shortcut would be',
    inChat.keys.length === 3 && inChat.keys.every(k => k.target === 'body'), JSON.stringify(inChat.keys));
ck('keys: c in the chat does not open Notes\' composer', !inChat.acted.includes('composer'), JSON.stringify(inChat));
ck('keys: / in the chat does not take focus into Notes\' search', !inChat.acted.includes('search'), JSON.stringify(inChat));
ck('keys: ? in the chat does not open Notes\' help', !inChat.acted.includes('dialog'), JSON.stringify(inChat));
await page.evaluate(() => window.__notesObserver?.disconnect());
// Whatever the chat did with those keys is the chat's; leave its box empty.
await page.locator('.message-textarea').fill('');
await page.keyboard.press('Escape');

// =============================================================================
// 6. A chat toast still appears — in Púca's own container
// =============================================================================
/** Which React root rendered the toast container: Púca's (#root) or Notes'
 *  (the view's own root). Both portal to the body, so only the owner tells a
 *  second sink inside Notes from Púca's own. */
const toastOwner = () => page.evaluate(() => {
    const el = document.querySelector('.message-toasts');
    if (!el) return 'none';
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    let f = key ? el[key] : null;
    while (f && f.tag !== 3) f = f.return;    // 3 = HostRoot
    const container = f?.stateNode?.containerInfo;
    if (!container) return 'unknown';
    if (container.closest?.('.notes-desktop-view')) return 'notes';
    return container.id === 'root' ? 'app' : `other:${container.id || container.className}`;
});
await page.locator('.message', { hasText: MESSAGE }).first().click({ button: 'right' });
await page.locator('.context-menu-item', { hasText: 'Save to Notes' }).click({ timeout: 5000 });
await page.waitForSelector('.save-note-row', { timeout: 10000 }).catch(() => {});
await page.locator('.save-note-row', { hasText: 'Groceries' }).click({ timeout: 10000 });
await page.click('.save-note-go');
const toast = await page.waitForSelector('.message-toast:has-text("Saved to")', { timeout: 10000 }).then(() => true).catch(() => false);
ck('toast: the chat\'s "Saved to …" toast appears', toast);
ck('toast: in one toast container, on the body — not inside Notes', await page.evaluate(() => {
    const all = document.querySelectorAll('.message-toasts');
    return all.length === 1 && all[0].parentElement === document.body && !all[0].closest('.notes-desktop-view');
}));
const chatToastOwner = await toastOwner();
ck('toast: the container is Púca\'s own, not a second sink of Notes\'', chatToastOwner === 'app', chatToastOwner);
await shot(page, 'chat-toast');
await page.locator('.message-toast', { hasText: 'Saved to' }).click();
await page.waitForSelector('.notes-desktop-view:not([inert])', { timeout: 5000 }).catch(() => {});
ck('toast: clicking "Saved to …" opens Notes', await notesInsideApp(page));
const arrived = await until(page, (m) => [...document.querySelectorAll('.notes-card')].some(c => c.textContent.includes('Groceries') && c.textContent.includes(m)), MESSAGE, 20000);
ck('toast: the kept message is in the note — Notes stayed live while hidden', arrived);

// =============================================================================
// 7. Export, through the shell
// =============================================================================
await page.click('button[aria-label="Account and settings"]');
await page.waitForSelector('.notes-menu', { timeout: 5000 }).catch(() => {});
ck('menu: no "Open Púca" inside Púca', await page.locator('.notes-menu', { hasText: 'Open Púca' }).count() === 0);
const downloads = [];
page.on('download', d => downloads.push(d.suggestedFilename()));
await page.getByRole('button', { name: 'Export notes as Markdown' }).click();
await until(page, () => window.__shell.saves.length > 0, null, 10000);
const shellState = await page.evaluate(() => ({ saves: window.__shell.saves, dialogs: window.__shell.dialogs, anchors: window.__anchorDownloads }));
const save = shellState.saves[0];
/** The export check: one raw write through the shell whose bytes hold `want`. */
const exportHas = (want) => shellState.saves.length === 1 && !!save && save.raw && want.every(w => save.text.includes(w));
ck('export: the Save As dialog is asked first, with the export\'s name',
    shellState.dialogs.length === 1 && /^puca-notes-\d{4}-\d{2}-\d{2}\.md$/.test(shellState.dialogs[0]?.defaultPath ?? ''),
    JSON.stringify(shellState.dialogs));
ck('export: written through attachment_save, with the notes in the bytes',
    exportHas(['# Groceries', '- [ ] Milk', '- [ ] Bread', '- [ ] Eggs', MESSAGE, '# Set up the new router', '- [ ] Unplug the old router', 'labels: Home']),
    save ? save.text.slice(0, 160).replace(/\n/g, '\\n') : 'no write');
control('the export check answers false for text that is in no note', exportHas(['Not a note in this account']));
ck('export: the chosen folder and name, outside ASCII, arrive whole',
    !!save && /^[\x20-\x7e]*$/.test(save.headers['x-dest-path'] ?? '') && decodeURIComponent(save.headers['x-dest-path'] ?? '') === SAVE_AS,
    save ? save.headers['x-dest-path'] : 'no write');
await sleep(500);
ck('export: never a browser download', shellState.anchors.length === 0 && downloads.length === 0,
    JSON.stringify({ anchors: shellState.anchors, downloads }));
const savedToast = await page.waitForSelector('.message-toast:has-text("not encrypted")', { timeout: 5000 }).then(() => true).catch(() => false);
ck('export: Notes\' toast says where, in Púca\'s container', savedToast && await page.evaluate((where) => {
    const t = [...document.querySelectorAll('.message-toasts .message-toast')].find(x => x.textContent.includes('not encrypted'));
    return !!t && t.textContent.includes(where) && !t.closest('.notes-desktop-view');
}, SAVE_AS) && await toastOwner() === 'app');
await page.keyboard.press('Escape');

// =============================================================================
// 8. Sign out from Notes: Púca's login, and nothing of Notes left
// =============================================================================
const held = await page.evaluate(() => {
    const mount = document.querySelector('.notes-desktop-root');
    const key = mount && Object.keys(mount).find(k => k.startsWith('__reactContainer$'));
    const stack = key ? [mount[key]] : [];
    const seen = new Set();
    while (stack.length) {
        const f = stack.pop();
        if (!f || seen.has(f)) continue;
        seen.add(f);
        const c = f.memoizedProps && f.memoizedProps.client;
        if (c && typeof c.getQueryCache === 'function') { window.__walkNotesQc = c; break; }
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
    }
    return window.__walkNotesQc ? window.__walkNotesQc.getQueryCache().getAll().filter(q => q.queryKey[0] === 'notes').length : -1;
});
control('"Notes\' query cache is empty" answers false while signed in', held === 0, `${held} notes queries held`);
ck('setup: found Notes\' own query client', held > 0, `${held}`);
await sleep(1200);   // the sealed cache's write is debounced
const cacheDbs = () => page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).filter(n => n && n.startsWith('pucaNotesCache:')));
const dbsBefore = await cacheDbs();
control('"no sealed Notes cache on this device" answers false while signed in', dbsBefore.length === 0, JSON.stringify(dbsBefore));

await page.click('button[aria-label="Account and settings"]');
await page.waitForSelector('.notes-menu', { timeout: 5000 }).catch(() => {});
await page.locator('.notes-menu').getByRole('button', { name: 'Sign out', exact: true }).click();
const toLogin = await page.waitForURL('**/login', { timeout: 20000 }).then(() => true).catch(() => false);
await page.waitForSelector('.toggle-mode', { timeout: 10000 }).catch(() => {});
ck('sign-out: Púca\'s login screen', toLogin && await page.locator('#username').count() === 1, page.url());
await sleep(800);
ck('sign-out: no Notes UI left', await page.locator('.notes-desktop-view, .notes-app, .notes-desktop-layer, .notes-editor').count() === 0);
ck('sign-out: Notes\' query cache is empty',
    await page.evaluate(() => window.__walkNotesQc && window.__walkNotesQc.getQueryCache().getAll().length) === 0);
await sleep(1000);
const dbsAfter = await cacheDbs();
ck('sign-out: Notes\' sealed on-device cache is deleted', dbsAfter.length === 0, JSON.stringify(dbsAfter));
ck('sign-out: no Notes prefs left in storage', await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('pucaNotesPrefs')).length === 0));

const shellFinal = await page.evaluate(() => ({ calls: [...new Set(window.__shell.calls)], unknown: [...new Set(window.__shell.unknown)], notes: window.__shell.notifications.length }));
console.log(`INFO  commands the app sent the shell: ${shellFinal.calls.join(', ')}`);
// A command the table does not know was answered by a guess (null, or a
// throw for a plugin): add it with a deliberate answer, so what the walk
// proves never rests on one.
ck('shell: every command the app sent has a deliberate answer', shellFinal.unknown.length === 0, shellFinal.unknown.join(','));
// The fake shows nothing whatever it is asked; this only reports it.
console.log(`INFO  notifications the app asked the shell to show: ${shellFinal.notes}`);
await ctx.close();

// =============================================================================
// 9. Negative control: the SAME rail button with no desktop shell (the web app)
// =============================================================================
const web = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await web.addInitScript(RECORDERS);
const wp = await web.newPage();
watch(wp, 'web');
const webChunk = [];
wp.on('request', rq => { if (/NotesDesktopView-[\w-]+\.js/.test(rq.url())) webChunk.push(rq.url()); });
await wp.goto(`${APP}/login`);
await wp.waitForSelector('#username', { timeout: 20000 });
await wp.fill('#username', username);
await wp.fill('#password', password);
await wp.click('button[type="submit"]');
const webIn = await wp.waitForURL('**/chat', { timeout: 30000 }).then(() => true).catch(() => false);
ck('web: signed in again, with no shell', webIn && await wp.evaluate(() => !('__TAURI_INTERNALS__' in window)));
await sleep(800);
await clearOnboarding(wp);
await wp.click('.server-icon.notes-self');
const tasks = await wp.waitForSelector('.tasks-view-outer', { timeout: 15000 }).then(() => true).catch(() => false);
ck('web: the same rail button opens the Tasks view', tasks);
ck('web: and no Notes inside the app', await wp.locator('.notes-desktop-view, .notes-app').count() === 0);
control('"Notes is inside the app" answers false in the web app', await notesInsideApp(wp));
await sleep(500);
ck('web: Notes\' desktop chunk is never fetched', webChunk.length === 0, webChunk.join(','));
await web.close();

ck('no uncaught errors on any page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`);
process.exit(failures === 0 ? 0 : 1);
