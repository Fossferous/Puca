// LIVE: two things only a real browser on the real cascade can see, through a real
// backend and the BUILT bundle (the CSS order that ships, not vite's dev injection).
//
//   A. A voice channel under a collection is drawn ONCE: as a voice row in the Voice
//      Channels section, which joins on click and shows who is in it, never as a #
//      row in the collection's list. Around that: a collection holding only voice
//      rooms still opens (and says what it is), and a server with no text channel lands
//      on that same page; it edits and deletes (the confirmation names what goes with it,
//      at every level, and the list loses it at once); its feed asks for text subchannels
//      only, and so does the server's; a message in a voice room lights no badge on its
//      collection; Hide Muted Channels hides it unless it is open; a collection made from
//      Create Subchannel is not nested; dragging a voice row, inside a collection and
//      across collections, keeps every other row where it was, a room the mode hides
//      among them; the phone at 390x844; a mode hides and shows a room with its
//      collection, a room it hides stays listed while someone is in it, and Parent
//      Collection is still what the mode reads. The real field's "No parent (top level)"
//      takes a text channel and a voice room out of their collection, for the phone too
//      with no reload, and a voice room out of the mode with it. Another member's list hears
//      of a delete and a reorder with no reload, and a delete closes what they had open of
//      it: a channel, a collection, a call, on the server they are looking at or not, and what
//      they were writing there goes in a notice and not in the next channel's box. A
//      manager who cannot see all of a collection is told why they cannot delete it. An open
//      collection's header follows a rename, an emptied topic stays empty, a cancelled Create
//      Subchannel leaves no parent behind, and a channel under a collection inside a
//      collection has a row, and that collection is not offered as a parent. A channel under
//      a collection a member is denied is not listed to them at all, and refused if they ask for
//      it by number (the server enforces a collection's deny on what is inside it); a channel
//      inside with its own allow is listed and drawn at the top (control).
//      NEGATIVE CONTROL: a # row for a voice room injected into the list must be caught.
//   B. Every switch on Server Settings > Overview (and Modes) is a switch: a track with
//      a knob, a label beside it, on and off plainly different, at 3:1 on all eight
//      themes with and without high contrast, 44 px, real clicks and real taps landing,
//      reachable and pressable from the keyboard with a visible focus ring, and the
//      Overview tab saving what it shows.
//      NEGATIVE CONTROL: the old bare dot, forced back with a stylesheet, must be caught.
//      Also the server menu's own switch, the plain checkboxes in Edit Channel (negative
//      controls: collapsed, see-through, not what a click hits), and a sweep of every
//      form group's checkboxes: Login and Notes' sign-in too. A page with none says INFO.
//
// Each check prints PASS/FAIL; the exit code is the number of failures. Screenshots go
// to OUT (SHOT <file>): look at them.
//
// Prereqs: a THROWAWAY backend (APP_ENV=development, raised AUTH_RATE_LIMIT_PER_SECOND /
// _BURST, its own fresh database, never a real one) at API, and a build against it,
// served at APP:
//   VITE_API_URL=$API npx vite build --outDir <dir> --emptyOutDir
//   DIST=<dir> PORT=<port> node e2e/serve-dist.mjs
// It refuses to start unless both are loopback: it creates accounts. Silent:
// --mute-audio and fake media devices. No LiveKit: the calls are mesh. About 2 minutes.
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5332 API=http://127.0.0.1:5331 OUT=<dir> node e2e/sidebar-toggles-walk.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP = (process.env.APP || '').replace(/\/$/, '');
const API = (process.env.API || '').replace(/\/$/, '');
const OUT = process.env.OUT || 'e2e/shots-sidebar-toggles';
const isLoopback = (url) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; } };
if (!isLoopback(APP) || !isLoopback(API)) {
    console.error(`this walk creates accounts: APP and API must both be loopback (APP=${APP} API=${API})`);
    process.exit(2);
}
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  -- ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 12000, step = 150) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
        try { last = await fn(); if (last) return last; } catch { /* retry */ }
        await sleep(step);
    }
    return last;
}
const shot = async (page, name) => {
    const f = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: f });
    console.log('SHOT', f);
};

const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

const dialogs = [];
function watch(page, tag) {
    page.on('console', m => fs.appendFileSync(path.join(OUT, 'console.txt'), `${new Date().toISOString()} ${tag} ${m.type()} ${m.text().slice(0, 400)}\n`));
    page.on('pageerror', e => { check(`${tag}: no uncaught page error`, false, e.message.slice(0, 200)); });
    page.on('dialog', d => {
        dialogs.push(d.message());
        d.type() === 'confirm' ? d.accept().catch(() => {}) : d.dismiss().catch(() => {});
    });
}

async function dismiss(page) {
    for (let i = 0; i < 3; i++) {
        let did = false;
        if (await page.locator('.recovery-confirm input[type="checkbox"]').count()) {
            await page.locator('.recovery-confirm input[type="checkbox"]').first().check().catch(() => {});
            await page.locator('.recovery-done-btn').first().click().catch(() => {});
            did = true;
        }
        if (await page.locator('.welcome-popup-close').count()) { await page.locator('.welcome-popup-close').first().click().catch(() => {}); did = true; }
        const later = page.getByRole('button', { name: 'Later', exact: true });
        if (await later.count()) { await later.first().click().catch(() => {}); did = true; }
        if (!did) return;
        await sleep(300);
    }
}

async function signIn(ctx, user, tag) {
    const page = await ctx.newPage();
    watch(page, tag);
    await page.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 60000 });
    await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 60000 });
    await sleep(1500);
    await dismiss(page);
    return page;
}

/** The API, as the signed-in page: the built bundle has no modules to import. */
const api = (page, method, p, body) => page.evaluate(async ({ API, method, p, body }) => {
    const r = await fetch(API + p, {
        method,
        headers: { authorization: `Bearer ${localStorage.getItem('auth_token')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
}, { API, method, p, body });

async function setTheme(page, theme, contrastOn) {
    await page.evaluate(([theme, contrastOn]) => {
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-contrast', contrastOn ? 'high' : 'normal');
    }, [theme, contrastOn]);
    await sleep(120);
}

// ── A: what the sidebar draws ──────────────────────────────────────────────────

/** Every row of the channel lists, by what it is drawn as. */
const sidebarRows = (page) => page.evaluate(() => [...document.querySelectorAll('.sidebar .channel')].map(el => ({
    name: (el.querySelector('.channel-name')?.textContent ?? el.textContent).trim(),
    voice: el.classList.contains('voice-channel'),
    sub: el.classList.contains('subchannel'),
    collection: el.classList.contains('collection-parent'),
    hash: !!el.querySelector('.hash'),
    inVoiceList: !!el.closest('.voice-channel-list'),
})));
/** Exactly one row of that name, and it is a voice row in the voice list with no # about it. */
const oneVoiceRow = (rows, name) => {
    const m = rows.filter(r => r.name === name);
    return m.length === 1 && m[0].voice && m[0].inVoiceList && !m[0].sub && !m[0].hash;
};
const named = (rows, name) => rows.filter(r => r.name === name);
const voiceOrder = (page) => page.evaluate(() => [...document.querySelectorAll('.voice-channel-list [data-testid="voice-channel"]')].map(e => e.textContent.trim()));
const textOrder = (page) => page.evaluate(() => [...document.querySelectorAll('.sidebar .channel-list:not(.voice-channel-list) .channel')].map(e => (e.querySelector('.channel-name')?.textContent ?? '').trim()));
const voiceRow = (page, id) => page.locator(`[data-testid="voice-channel"][data-channel-id="${id}"]`);
const textRow = (page, name) => page.locator('.sidebar .channel-list:not(.voice-channel-list) .channel').filter({ has: page.locator(`.channel-name:text-is("${name}")`) });

/** A real mouse drag, row to row, as the owner's reorder reads it. */
async function drag(page, from, to) {
    await to.scrollIntoViewIfNeeded();
    await from.scrollIntoViewIfNeeded();
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await sleep(120);
    await page.mouse.up();
    await sleep(100);
}

/** Open a sidebar row's context menu and press the item called `label`. */
async function menu(page, row, label) {
    await row.click({ button: 'right' });
    const item = page.locator('.context-menu .context-menu-item', { hasText: label }).first();
    await item.waitFor({ timeout: 6000 });
    await item.click();
}

async function pickMode(page, phone, label) {
    const sel = page.locator('[data-testid="mode-selector"]');
    await (phone ? sel.tap() : sel.click());
    const item = page.locator('.context-menu .context-menu-item', { hasText: label }).first();
    await item.waitFor({ timeout: 8000 });
    await (phone ? item.tap() : item.click());
}

// ── B: what a switch is ────────────────────────────────────────────────────────

/** A switch as it is painted: geometry, computed style and what is under its centre. */
const switchFacts = (page, root) => page.evaluate((root) => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true });
    const rgba = (s) => {
        g.clearRect(0, 0, 1, 1);
        g.fillStyle = 'rgba(0,0,0,0)';
        g.fillStyle = s;
        g.fillRect(0, 0, 1, 1);
        const d = g.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3]));
    const behind = (el) => {
        const layers = [];
        for (let e = el; e; e = e.parentElement) {
            const l = rgba(getComputedStyle(e).backgroundColor);
            if (l[3] === 0) continue;
            layers.push(l);
            if (l[3] >= 1) break;
        }
        let base = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop().slice(0, 3) : [255, 255, 255];
        for (const l of layers.reverse()) base = over(l, base);
        return base;
    };
    const lin = v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, gr, b]) => 0.2126 * lin(r) + 0.7152 * lin(gr) + 0.0722 * lin(b);
    const contrast = (x, y) => { const [h, l] = [lum(x), lum(y)].sort((p, q) => q - p); return Math.round(((h + 0.05) / (l + 0.05)) * 100) / 100; };
    return [...document.querySelectorAll(`${root} .toggle-row`)].map((row) => {
        row.scrollIntoView({ block: 'center', behavior: 'instant' });
        const input = row.querySelector('input[type="checkbox"]');
        const track = row.querySelector('.toggle-switch');
        const text = row.querySelector('span:not(.toggle-switch)');
        const cs = getComputedStyle(row);
        const ts = getComputedStyle(track);
        const ks = getComputedStyle(track, '::after');
        const r = row.getBoundingClientRect();
        const t = track.getBoundingClientRect();
        const x = text.getBoundingClientRect();
        const surface = behind(row);
        const trackPaint = rgba(ts.backgroundColor);
        const trackOn = over(trackPaint, surface);
        const knob = over(rgba(ks.backgroundColor), trackOn);
        const shift = ks.transform === 'none' ? 0 : new DOMMatrix(ks.transform).m41;
        const knobLeft = parseFloat(ks.left) + shift;
        const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
        const hitText = document.elementFromPoint(x.left + Math.min(10, x.width / 2), x.top + x.height / 2);
        return {
            label: text.textContent.trim(),
            checked: input.checked,
            display: cs.display,
            transform: cs.textTransform,
            fontSize: parseFloat(cs.fontSize),
            row: [Math.round(r.width), Math.round(r.height)],
            inside: r.left >= -0.5 && r.right <= document.documentElement.clientWidth + 0.5,
            track: [Math.round(t.width), Math.round(t.height)],
            alpha: trackPaint[3],
            paint: trackOn.map(Math.round),
            trackVsSurface: contrast(trackOn, surface),
            knobVsTrack: contrast(knob, trackOn),
            knobLeft,
            knobFits: knobLeft >= 0 && knobLeft + parseFloat(ks.width) <= t.width + 0.5 && parseFloat(ks.width) > 0,
            beside: (x.right <= t.left + 0.5 || t.right <= x.left + 0.5) && Math.abs((x.top + x.height / 2) - (t.top + t.height / 2)) <= 3,
            hitsTrack: !!hit && row.contains(hit),
            hitsText: !!hitText && row.contains(hitText),
            // A checkbox with display:none takes no focus: the keyboard cannot reach the switch.
            focusable: getComputedStyle(input).display !== 'none' && getComputedStyle(input).visibility !== 'hidden',
        };
    });
}, root);
/** What is wrong with one, in words. A bare dot has no track, and says so. */
const switchProblems = (f, { minRow = 44 } = {}) => {
    const out = [];
    if (f.display !== 'flex') out.push(`the row is display:${f.display}`);
    if (f.transform !== 'none') out.push(`the label is ${f.transform}`);
    if (f.fontSize < 14) out.push(`the label is ${f.fontSize}px`);
    if (f.track[0] < 36 || f.track[1] < 20) out.push(`bare dot: the track is ${f.track.join('x')}`);
    if (f.alpha === 0) out.push('the track paints nothing');
    if (f.trackVsSurface < 3) out.push(`track on surface ${f.trackVsSurface}:1`);
    if (f.knobVsTrack < 3) out.push(`knob on track ${f.knobVsTrack}:1`);
    if (!f.knobFits) out.push(`the knob is outside the track (${f.knobLeft})`);
    if (!f.beside) out.push('the label is not beside the switch');
    if (f.row[1] < minRow) out.push(`the row is ${f.row[1]}px tall`);
    if (!f.inside) out.push('the row is past the edge');
    if (!f.hitsTrack) out.push('the track is covered');
    if (!f.hitsText) out.push('the label is covered');
    if (!f.focusable) out.push('the checkbox cannot take focus');
    return out;
};
const noTransitions = (page) => page.addStyleTag({ content: '*, *::after, *::before { transition: none !important; animation: none !important; }' });

/** Tab (really) from `start` until the checkbox called `aria` or holding `text` has focus. */
async function tabTo(page, start, match) {
    await start.focus();
    for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab');
        const hit = await page.evaluate((match) => {
            const el = document.activeElement;
            if (!el || el.type !== 'checkbox') return null;
            const row = el.closest('.toggle-row');
            return row && row.textContent.includes(match) ? true : null;
        }, match);
        if (hit) return true;
    }
    return false;
}
/** The focus ring on the track of the focused switch, against what is behind it. */
const focusRing = (page) => page.evaluate(() => {
    const el = document.activeElement;
    const t = el.closest('.toggle-row').querySelector('.toggle-switch');
    const s = getComputedStyle(t);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor, matches: el.matches(':focus-visible') };
});

try {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const A = await signIn(desktop, 'sba_' + stamp, 'owner');
    const B = await signIn(phoneCtx, 'sbb_' + stamp, 'phone');
    const thirdCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const C = await signIn(thirdCtx, 'sbc_' + stamp, 'third');

    // ── Fixture. A collection of nothing but voice rooms, one with both kinds, one a mode
    //    ticks, one that gets deleted.
    const srvName = 'sbt_' + stamp;
    const srv = await api(A, 'POST', '/servers', { name: srvName });
    const mk = (name, type, parent) => api(A, 'POST', `/servers/${srv.id}/channels`, { name, channel_type: type, parent_id: parent });
    await mk('lobby', 0);
    const town = await mk('Town', 1);
    const rooms = await mk('Rooms', 2);
    const attic = await mk('Attic', 1, rooms.id);
    const cellar = await mk('Cellar', 1, rooms.id);
    const mixed = await mk('Mixed', 2);
    const mixedNotes = await mk('mixed-notes', 0, mixed.id);
    const den = await mk('Den', 1, mixed.id);
    const secret = await mk('Secret rooms', 2);
    const crypt = await mk('Crypt', 1, secret.id);
    const moved = await mk('Moved', 1);
    const doomed = await mk('Doomed', 2);
    const goneRoom = await mk('Gone room', 1, doomed.id);
    // Two levels down, which a PATCH still takes and a database may already hold. A create
    // drops a collection's parent: an old client's Create Subchannel means one of its own.
    const deeper = await mk('Deeper', 2);
    await api(A, 'PATCH', `/channels/${deeper.id}`, { parent_id: doomed.id });
    const deepRoom = await mk('Deep room', 1, deeper.id);
    await api(A, 'POST', `/servers/${srv.id}/modes`, { name: 'Night', channel_ids: [secret.id] });
    const inv = await api(A, 'POST', `/servers/${srv.id}/invites`, {});
    await api(B, 'POST', `/invites/${inv.code}/join`);
    await api(C, 'POST', `/invites/${inv.code}/join`);
    const phoneSrvName = 'sbp_' + stamp;
    const phoneSrv = await api(B, 'POST', '/servers', { name: phoneSrvName });
    // Somewhere for the third account to look at while it is in a call on the other server.
    const thirdSrvName = 'sbc_' + stamp;
    await api(C, 'POST', '/servers', { name: thirdSrvName });
    // A server with no text channel, whose first row is a collection of voice rooms.
    const landSrvName = 'sbl_' + stamp;
    const landSrv = await api(A, 'POST', '/servers', { name: landSrvName });
    const vault = await api(A, 'POST', `/servers/${landSrv.id}/channels`, { name: 'Vault', channel_type: 2 });
    await api(A, 'POST', `/servers/${landSrv.id}/channels`, { name: 'Vault room', channel_type: 1, parent_id: vault.id });
    const landRows = await api(A, 'GET', `/servers/${landSrv.id}/channels`);
    for (const c of landRows.filter(c => c.channel_type === 0)) await api(A, 'DELETE', `/channels/${c.id}`);
    await api(A, 'POST', `/servers/${landSrv.id}/channels/reorder`, { channel_ids: [vault.id, ...landRows.filter(c => c.channel_type !== 0 && c.id !== vault.id).map(c => c.id)] });
    for (const page of [A, B]) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(2500);
        await dismiss(page);
    }
    await A.locator(`.server-icon[title="${srvName}"]`).click();
    await B.locator('.mobile-nav-btn').first().tap();
    await sleep(400);
    await B.locator(`.server-icon[title="${srvName}"]`).tap();
    await until(async () => (await sidebarRows(A)).length > 3 && (await sidebarRows(B)).length > 3);
    await sleep(600);

    // ── A1. Each voice channel exactly once, as a voice row.
    for (const [who, page] of [['desktop', A], ['phone', B]]) {
        const rows = await sidebarRows(page);
        for (const name of ['Town', 'Attic', 'Cellar', 'Den', 'Gone room', 'Deep room']) {
            check(`${who}: ${name} is listed exactly once, as a voice row`, oneVoiceRow(rows, name), named(rows, name));
        }
        const notes = named(rows, 'mixed-notes');
        check(`${who} control: a text subchannel is still listed once under its collection`, notes.length === 1 && notes[0].sub && notes[0].hash, notes);
        const lobbyRow = named(rows, 'lobby');
        check(`${who} control: a top-level text channel is listed once`, lobbyRow.length === 1 && !lobbyRow[0].sub, lobbyRow);
        for (const name of ['Rooms', 'Mixed']) {
            const row = named(rows, name);
            check(`${who}: the collection ${name} keeps its one row`, row.length === 1 && row[0].collection, row);
        }
        check(`${who}: no voice room is drawn in a collection's list`, !rows.some(r => r.sub && ['Attic', 'Cellar', 'Den', 'Gone room', 'Deep room'].includes(r.name)), rows.filter(r => r.sub));
    }
    const text = await textOrder(A);
    check('the collection of voice rooms draws nothing under itself, and the mixed one its text only',
        text.indexOf('Mixed') === text.indexOf('Rooms') + 1 && text.indexOf('mixed-notes') === text.indexOf('Mixed') + 1, text);
    // NEGATIVE CONTROL: a # row for a voice room, as the old list drew it, must be caught.
    await A.evaluate(() => {
        const li = document.createElement('li');
        li.className = 'channel subchannel';
        li.id = 'injected-row';
        li.innerHTML = '<span class="hash">#</span><span class="channel-name">Attic</span>';
        document.querySelector('.sidebar .collection-parent').after(li);
    });
    check('NEGATIVE CONTROL: a voice room listed twice is caught', !oneVoiceRow(await sidebarRows(A), 'Attic'), named(await sidebarRows(A), 'Attic'));
    await A.evaluate(() => document.getElementById('injected-row').remove());
    await shot(A, '01-desktop-collection-of-voice-rooms');
    await shot(B, '02-phone-collection-of-voice-rooms');

    // ── A2. A voice row joins on click, and shows who is in it, everywhere.
    await voiceRow(A, attic.id).click();
    check('a click on the room under a collection joins it', !!await until(async () => (await A.locator('.voice-panel-compact .voice-connected-label').count()) > 0, 25000));
    const occupant = (page, id) => page.locator(`[data-voice-drop="${id}"] .voice-users-list`).innerText().catch(() => '');
    check('its row shows who is in it, on the owner\'s list', !!await until(async () => (await occupant(A, attic.id)).includes('sba_'), 10000), await occupant(A, attic.id));
    check('and on the phone\'s, with no reload', !!await until(async () => (await occupant(B, attic.id)).includes('sba_'), 10000), await occupant(B, attic.id));
    await shot(A, '03-desktop-in-a-room-under-a-collection');

    // ── A3. A collection's feed and its row.
    const fetched = [];
    A.on('request', r => { const m = /\/channels\/(\d+)\/messages/.exec(r.url()); if (m) fetched.push(Number(m[1])); });
    await textRow(A, 'Rooms').click();
    const header = (page) => page.locator('.chat-header h2').first().innerText().then(t => t.trim());
    check('a collection of voice rooms opens', !!await until(async () => (await header(A)) === 'Rooms', 6000), await header(A));
    await sleep(500);
    check('its feed asks for none of the voice rooms\' messages', fetched.length === 0, fetched);
    const empty = () => A.locator('[data-testid="collection-empty"]');
    const emptyText = (await empty().count()) ? await empty().innerText() : '';
    check('the page says what it holds, and where those are', /voice/i.test(emptyText) && /Voice Channels/.test(emptyText), emptyText);
    check('there is no composer: there is nowhere for a message to go', await A.locator('textarea[placeholder^="Message"]').count() === 0);
    check('opening it did not leave the call', await A.locator('.voice-panel-compact .voice-connected-label').count() > 0);
    await shot(A, '04-desktop-collection-of-voice-rooms-open');

    // A text subchannel, its message, the feed and an unread badge. A voice room has a
    // text side the server keeps too: its message goes first, so the poll that lights the
    // subchannel's badge has already counted it.
    await api(A, 'POST', `/channels/${attic.id}/messages`, { content: 'a note left in the attic' });
    await textRow(A, 'mixed-notes').click();
    const say = A.locator('textarea[placeholder^="Message #"]');
    await say.waitFor({ timeout: 8000 });
    await say.fill('hello from the notes');
    await say.press('Enter');
    // Shown at once, sent a moment later: wait for the server to have it.
    check('the text subchannel takes a message', !!await until(async () => (await api(A, 'GET', `/channels/${mixedNotes.id}/messages?limit=5`)).length > 0, 10000));
    fetched.length = 0;
    await textRow(A, 'Mixed').click();
    check('the mixed collection\'s feed shows the text subchannel\'s message', !!await until(async () => (await A.locator('body').innerText()).includes('hello from the notes'), 8000));
    check('and asked the text subchannel only, never the voice room under the same collection', fetched.includes(mixedNotes.id) && !fetched.includes(den.id), fetched);
    check('with text to read, it does not say it is empty', await empty().count() === 0);
    const badge = (page, name) => textRow(page, name).locator('.unread-badge');
    check('the phone gets the unread badge on the text subchannel (a 30 s poll)', !!await until(async () => (await badge(B, 'mixed-notes').count()) > 0, 35000));
    const unread = async (page, id) => (await api(page, 'GET', `/servers/${srv.id}/unread`)).channels.find(c => c.channel_id === id)?.unread_count ?? 0;
    check('control: the phone has an unread message in a voice room under the collection', await unread(B, attic.id) > 0, await unread(B, attic.id));
    check('and no badge on the collection for it: nothing of that room is drawn under it', await badge(B, 'Rooms').count() === 0);

    // The server's own feed, which an installed older client draws as a # row per child.
    const feedNames = async (id) => (await api(A, 'GET', `/channels/${id}/feed`)).children.map(c => c.name);
    check('the server\'s feed of a collection of voice rooms lists none of them', (await feedNames(rooms.id)).length === 0, await feedNames(rooms.id));
    check('and of a mixed one, its text channel only', (await feedNames(mixed.id)).join() === 'mixed-notes', await feedNames(mixed.id));

    // Entering a server with no text channel opens its first row, here a collection: the
    // page a click on that row opens, not a second page with a voice room as a # row.
    await A.locator(`.server-icon[title="${landSrvName}"]`).click();
    check('a server with no text channel lands on its first row, a collection', !!await until(async () => (await header(A)) === 'Vault', 8000), await header(A));
    const landed = await until(async () => ((await empty().count()) ? empty().innerText() : ''), 6000);
    check('on the page that says what it holds', /voice/i.test(landed ?? '') && /Voice Channels/.test(landed ?? ''), landed);
    check('and not a dashboard listing a voice room as # Vault room', await A.locator('.channel-dashboard').count() === 0 && !(await A.locator('body').innerText()).includes('# Vault room'));
    check('its room is listed once, as a voice row', oneVoiceRow(await sidebarRows(A), 'Vault room'), named(await sidebarRows(A), 'Vault room'));
    await shot(A, '04b-desktop-landed-on-a-collection');
    await A.locator(`.server-icon[title="${srvName}"]`).click();
    await until(async () => (await voiceOrder(A)).includes('Town') && (await header(A)) !== 'Vault', 8000);

    // ── A4. Dragging. A flat list has one order: a move changes that, and nothing else.
    const beforeText = await textOrder(A);
    const startVoice = await voiceOrder(A);
    check('fixture: the voice list starts in creation order', startVoice.join() === 'default,Town,Attic,Cellar,Den,Moved,Gone room,Deep room,AFK', startVoice);
    await drag(A, voiceRow(A, attic.id), voiceRow(A, cellar.id));
    await until(async () => (await voiceOrder(A)).join() !== startVoice.join(), 5000);
    let order = await voiceOrder(A);
    check('dragging a room onto its neighbour in the same collection swaps those two and leaves the rest', order.join() === 'default,Town,Cellar,Attic,Den,Moved,Gone room,Deep room,AFK', order);
    await drag(A, voiceRow(A, den.id), voiceRow(A, town.id));
    await until(async () => (await voiceOrder(A)).join() !== order.join(), 5000);
    order = await voiceOrder(A);
    check('dragging a room under one collection onto a room outside it moves it there', order.join() === 'default,Den,Town,Cellar,Attic,Moved,Gone room,Deep room,AFK', order);
    check('and another member\'s list takes that order, with no reload: the frame makes it refetch', !!await until(async () => (await voiceOrder(B)).join() === order.join(), 8000), await voiceOrder(B));
    const stored = await api(A, 'GET', `/servers/${srv.id}/channels`);
    const storedVoice = stored.filter(c => c.channel_type === 1).map(c => c.name);
    // Crypt is hidden by the mode and keeps its slot, between Attic and Moved: numbering only
    // what is drawn would leave it on its old position, out of step with every row renumbered.
    const wholeVoiceOrder = 'default,Den,Town,Cellar,Attic,Crypt,Moved,Gone room,Deep room';
    check('the server stores the order the list shows, with the room a mode hides in its own slot', storedVoice.filter(n => n !== 'AFK').join() === wholeVoiceOrder, storedVoice);
    const parents = Object.fromEntries(stored.map(c => [c.name, c.parent_id ?? null]));
    check('a drag changes no room\'s collection', parents.Attic === rooms.id && parents.Cellar === rooms.id && parents.Den === mixed.id && parents.Town === null, parents);
    check('and moves nothing in the text list', (await textOrder(A)).join() === beforeText.join(), await textOrder(A));
    await A.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(A);
    await A.locator(`.server-icon[title="${srvName}"]`).click();
    await until(async () => (await voiceOrder(A)).length > 3);
    check('a reload shows the same order', (await voiceOrder(A)).join() === order.join(), await voiceOrder(A));
    await drag(A, textRow(A, 'Mixed'), textRow(A, 'Rooms'));
    await until(async () => (await textOrder(A)).indexOf('Mixed') < (await textOrder(A)).indexOf('Rooms'), 5000);
    const textMoved = await textOrder(A);
    check('control: a collection of voice rooms still reorders among the text rows', textMoved.indexOf("Mixed") < textMoved.indexOf("Rooms") && textMoved.indexOf("mixed-notes") === textMoved.indexOf("Mixed") + 1, textMoved);
    check('and that moves nothing in the voice list', (await voiceOrder(A)).join() === order.join(), await voiceOrder(A));

    // ── A5. Modes read Parent Collection.
    const hasRow = (rows, name) => rows.some(r => r.name === name);
    for (const [who, page] of [['desktop', A], ['phone', B]]) {
        const rows = await sidebarRows(page);
        check(`${who}: with the mode off, the room under a ticked collection and the collection are hidden`, !hasRow(rows, 'Crypt') && !hasRow(rows, 'Secret rooms'), rows.map(r => r.name));
        check(`${who} control: a room under a collection no mode ticks is listed`, oneVoiceRow(rows, 'Cellar'));
    }
    await pickMode(A, false, 'Night');
    for (const [who, page] of [['desktop', A], ['phone', B]]) {
        check(`${who}: with the mode on, its room shows, once, as a voice row`, !!await until(async () => oneVoiceRow(await sidebarRows(page), 'Crypt'), 8000), named(await sidebarRows(page), 'Crypt'));
        const rows = await sidebarRows(page);
        check(`${who}: and its collection, with nothing drawn under it`, named(rows, 'Secret rooms').length === 1 && !rows.some(r => r.sub && r.name === 'Crypt'), named(rows, 'Secret rooms'));
    }
    check('and the room the mode hid sits where the numbering left it, AFK still last', (await voiceOrder(A)).join() === `${wholeVoiceOrder},AFK`, await voiceOrder(A));
    await shot(A, '05-desktop-mode-on-room-under-collection');
    // Parent Collection, the real field: a top-level room goes under the ticked collection.
    await menu(A, voiceRow(A, moved.id), 'Edit');
    const parentField = A.locator('#channel-parent');
    await parentField.waitFor({ timeout: 6000 });
    await parentField.selectOption({ label: 'Secret rooms' });
    await shot(A, '06-desktop-edit-voice-channel');
    await A.locator('.edit-channel-modal').getByRole('button', { name: /^Save/ }).click();
    await A.locator('.edit-channel-modal').waitFor({ state: 'detached', timeout: 6000 });
    check('Parent Collection is saved for a voice room', !!await until(async () => (await api(A, 'GET', `/servers/${srv.id}/channels`)).find(c => c.id === moved.id)?.parent_id === secret.id, 5000));
    check('and the room is still drawn once, as a voice row', oneVoiceRow(await sidebarRows(A), 'Moved'), named(await sidebarRows(A), 'Moved'));
    await pickMode(A, false, 'Off');
    check('the mode reads it: off, the room moved under the ticked collection is hidden', !!await until(async () => !hasRow(await sidebarRows(A), 'Moved'), 8000), (await sidebarRows(A)).map(r => r.name));
    check('on the phone too', !!await until(async () => !hasRow(await sidebarRows(B), 'Moved'), 8000), (await sidebarRows(B)).map(r => r.name));
    // A call nobody can see is a secret. Turning the mode off ended its calls and nothing
    // refuses a later join, so this is someone back in a room it hides, as from a link or an
    // older client: a socket of their own, joining by the room's id.
    const hiddenRoom = `voice_${crypt.id}`;
    await C.evaluate(({ API, hiddenRoom }) => new Promise((resolve, reject) => {
        const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws`, ['bearer', localStorage.getItem('auth_token')]);
        window.__bare = ws;
        ws.onopen = () => { ws.send(JSON.stringify({ type: 'JoinRoom', payload: { room_id: hiddenRoom } })); resolve(); };
        ws.onerror = () => reject(new Error('the socket was refused'));
    }), { API, hiddenRoom });
    check('a room the mode hides, with someone in it, is listed, once', !!await until(async () => oneVoiceRow(await sidebarRows(A), 'Crypt'), 8000), named(await sidebarRows(A), 'Crypt'));
    check('and says who is in it', !!await until(async () => (await occupant(A, crypt.id)).includes('sbc_'), 5000), await occupant(A, crypt.id));
    const withSomeone = await sidebarRows(A);
    check('its empty sibling stays hidden, and so does their collection', !hasRow(withSomeone, 'Moved') && !hasRow(withSomeone, 'Secret rooms'), withSomeone.map(r => r.name));
    await C.evaluate((hiddenRoom) => {
        window.__bare.send(JSON.stringify({ type: 'LeaveRoom', payload: { room_id: hiddenRoom } }));
        window.__bare.close();
    }, hiddenRoom);
    check('and when they leave, the mode hides it again', !!await until(async () => !hasRow(await sidebarRows(A), 'Crypt'), 10000), (await sidebarRows(A)).map(r => r.name));

    // ── A5b. Parent Collection's "No parent (top level)": the real select, text and voice.
    //    The server used to read its null as "nothing said". The editor's own list moved the
    //    row at once and the refetch put it back, so each of these waits for the server first.
    const parentOf = async (id) => (await api(A, 'GET', `/servers/${srv.id}/channels`)).find(c => c.id === id)?.parent_id ?? null;
    const editParent = async (row, label) => {
        await menu(A, row, 'Edit');
        const field = A.locator('#channel-parent');
        await field.waitFor({ timeout: 6000 });
        await field.selectOption({ label });
        await A.locator('.edit-channel-modal').getByRole('button', { name: /^Save/ }).click();
        await A.locator('.edit-channel-modal').waitFor({ state: 'detached', timeout: 6000 });
    };
    const topLevelText = (rows, name) => named(rows, name).length === 1 && !named(rows, name)[0].sub && !named(rows, name)[0].voice;
    const NO_PARENT = 'No parent (top level)';
    // Text. A channel in a collection, out of it, and back: both directions through one field.
    await editParent(textRow(A, 'mixed-notes'), NO_PARENT);
    const notesCleared = await until(async () => (await parentOf(mixedNotes.id)) === null, 5000);
    check('text: No parent (top level) reaches the server', !!notesCleared, await parentOf(mixedNotes.id));
    // Past a refetch: the frame goes to the editor too, so a stale answer would have put it back.
    await sleep(800);
    check('text: its row is at the top level on the owner\'s list, and stays', topLevelText(await sidebarRows(A), 'mixed-notes'), named(await sidebarRows(A), 'mixed-notes'));
    check('text: and on the phone, with no reload: the frame makes it refetch', !!await until(async () => topLevelText(await sidebarRows(B), 'mixed-notes'), 8000), named(await sidebarRows(B), 'mixed-notes'));
    await shot(A, '05b-desktop-no-parent-text');
    await A.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(A);
    await A.locator(`.server-icon[title="${srvName}"]`).click();
    await until(async () => (await voiceOrder(A)).length > 3);
    check('text: a reload agrees', topLevelText(await sidebarRows(A), 'mixed-notes'), named(await sidebarRows(A), 'mixed-notes'));
    await editParent(textRow(A, 'mixed-notes'), 'Mixed');
    check('control: naming a collection in that field still moves it there', !!await until(async () => (await parentOf(mixedNotes.id)) === mixed.id, 5000), await parentOf(mixedNotes.id));
    check('and the phone sees that too', !!await until(async () => named(await sidebarRows(B), 'mixed-notes')[0]?.sub === true, 8000), named(await sidebarRows(B), 'mixed-notes'));
    // Left out: a request that does not name the field keeps the parent.
    await api(A, 'PATCH', `/channels/${cellar.id}`, { description: 'under the stairs' });
    check('control: an edit that leaves the field out leaves the parent', (await parentOf(cellar.id)) === rooms.id, await parentOf(cellar.id));
    // Voice. The list draws a voice room the same under a collection or not, so what shows
    // the change is the mode: under the ticked collection it goes when the mode does.
    await pickMode(A, false, 'Night');
    await until(async () => oneVoiceRow(await sidebarRows(A), 'Moved'), 8000);
    await menu(A, voiceRow(A, moved.id), 'Edit');
    await A.locator('#channel-parent').waitFor({ timeout: 6000 });
    check('voice: the field shows the collection it is under', (await A.locator('#channel-parent').inputValue()) === String(secret.id), await A.locator('#channel-parent').inputValue());
    await A.locator('#channel-parent').selectOption({ label: NO_PARENT });
    await A.locator('.edit-channel-modal').getByRole('button', { name: /^Save/ }).click();
    await A.locator('.edit-channel-modal').waitFor({ state: 'detached', timeout: 6000 });
    const movedCleared = await until(async () => (await parentOf(moved.id)) === null, 5000);
    check('voice: No parent (top level) reaches the server', !!movedCleared, await parentOf(moved.id));
    check('voice: still drawn once, as a voice row', oneVoiceRow(await sidebarRows(A), 'Moved'), named(await sidebarRows(A), 'Moved'));
    // The phone hears the edit before the switch, so the room it keeps is the frame's doing.
    await sleep(1500);
    await pickMode(A, false, 'Off');
    for (const [who, page] of [['desktop', A], ['phone', B]]) {
        // Crypt going says the switch has landed: until then Moved would be listed either way.
        check(`${who} control: the mode is off, its room gone`, !!await until(async () => !hasRow(await sidebarRows(page), 'Crypt'), 8000), (await sidebarRows(page)).map(r => r.name));
        check(`${who}: the room taken out of the ticked collection is not hidden with it, and is listed once`, oneVoiceRow(await sidebarRows(page), 'Moved'), named(await sidebarRows(page), 'Moved'));
    }
    await shot(A, '05c-desktop-no-parent-voice');

    // ── A6. Editing, muting, deleting a collection of voice rooms.
    await textRow(A, 'Rooms').click({ button: 'right' });
    const items = await A.locator('.context-menu .context-menu-item').allInnerTexts();
    check('its menu still offers Create Subchannel, Mute, Edit and Delete', ['Create Subchannel', 'Mute Channel', 'Edit', 'Delete'].every(w => items.some(i => i.includes(w))), items);
    await A.keyboard.press('Escape');
    await sleep(150);
    // With its page open: the header has to follow, with no press on the row.
    await textRow(A, 'Rooms').click();
    await until(async () => (await header(A)) === 'Rooms', 6000);
    await menu(A, textRow(A, 'Rooms'), 'Edit');
    const nameField = A.locator('.edit-channel-modal input[type="text"]').first();
    await nameField.fill('Rooms renamed');
    const topicField = () => A.locator('#channel-topic');
    const saveEdit = async () => {
        await A.locator('.edit-channel-modal').getByRole('button', { name: /^Save/ }).click();
        await A.locator('.edit-channel-modal').waitFor({ state: 'detached', timeout: 6000 });
    };
    const headerTopic = () => A.locator('.chat-header .channel-description');
    await topicField().fill('where the rooms are');
    await saveEdit();
    check('it edits', !!await until(async () => named(await sidebarRows(A), 'Rooms renamed').length === 1, 6000));
    check('and its rooms stay in the voice list', oneVoiceRow(await sidebarRows(A), 'Cellar'));
    // Past the refetch the editor's own frame makes, which is what used to leave the old row.
    await sleep(800);
    check('the open collection\'s header takes the new name', (await header(A)) === 'Rooms renamed', await header(A));
    check('and the title of its page', (await empty().locator('h2').innerText()) === 'Rooms renamed', await empty().locator('h2').innerText());
    check('and the header its new topic', (await headerTopic().count()) === 1 && (await headerTopic().innerText()) === 'where the rooms are');
    // An emptied topic: the form used to leave it out, and the refetch put the old one back.
    await menu(A, textRow(A, 'Rooms renamed'), 'Edit');
    await topicField().fill('');
    await saveEdit();
    await sleep(800);
    const rowOfRooms = (await api(A, 'GET', `/servers/${srv.id}/channels`)).find(c => c.id === rooms.id);
    check('Channel Topic can be emptied', !rowOfRooms.description, rowOfRooms.description);
    check('and the header shows none, past the refetch', (await headerTopic().count()) === 0);
    // And a save that says nothing about the parent leaves a parent set behind this form's back.
    await menu(A, textRow(A, 'Rooms renamed'), 'Edit');
    await api(A, 'PATCH', `/channels/${rooms.id}`, { parent_id: mixed.id });
    await topicField().fill('moved while the form was open');
    await saveEdit();
    await sleep(300);
    check('a save from a form opened before someone else\'s move does not undo it', (await parentOf(rooms.id)) === mixed.id, await parentOf(rooms.id));
    await api(A, 'PATCH', `/channels/${rooms.id}`, { parent_id: null, description: '' });
    await until(async () => !named(await sidebarRows(A), 'Rooms renamed')[0]?.sub, 5000);
    await textRow(A, 'lobby').click();
    await until(async () => (await header(A)) === 'lobby', 6000);

    // Hide Muted Channels: a muted collection stays only as the header of what is under it,
    // and a voice room is not under it. The switch is the server menu's own.
    await menu(A, textRow(A, 'Rooms renamed'), 'Mute Channel');
    await A.locator(`.server-icon[title="${srvName}"]`).click({ button: 'right' });
    const hideItem = A.locator('.context-menu-item.has-toggle', { hasText: 'Hide Muted Channels' });
    await hideItem.waitFor({ timeout: 6000 });
    const menuSwitch = () => A.evaluate(() => {
        const t = document.querySelector('.has-toggle .toggle-switch');
        const s = getComputedStyle(t);
        const k = getComputedStyle(t, '::after');
        const r = t.getBoundingClientRect();
        // The knob at the far end leaves the same margin as at the near one.
        const knobEnd = parseFloat(k.left) + parseFloat(k.width) + (k.transform === 'none' ? 0 : new DOMMatrix(k.transform).m41);
        return { w: Math.round(r.width), h: Math.round(r.height), bg: s.backgroundColor, knob: k.transform, left: parseFloat(k.left), endMargin: r.width - knobEnd };
    });
    await sleep(250);
    const menuOff = await menuSwitch();
    await shot(A, '07-desktop-server-menu-switch-off');
    await hideItem.click();
    await sleep(350);
    const menuOn = await until(async () => {
        const open = await A.locator('.has-toggle .toggle-switch').count();
        return open ? menuSwitch() : null;
    }, 1500);
    check('the server menu stays open when its switch is pressed', !!menuOn);
    if (menuOn) await shot(A, '07-desktop-server-menu-switch-on');
    check('the server menu\'s own switch has a track, at the size its own rules give it', menuOff.w === 40 && menuOff.h === 22, menuOff);
    check('and on and off differ, the knob reaching the far end', !!menuOn && menuOn.bg !== menuOff.bg && menuOn.knob !== menuOff.knob && menuOn.endMargin === menuOff.left, { menuOff, menuOn });
    check('its off track is not a ghost on that dark menu (a settings rule used to paint it, by load order)', /rgba\(255, 255, 255, 0\.3/.test(menuOff.bg), menuOff.bg);
    await A.keyboard.press('Escape').catch(() => {});
    await A.mouse.click(700, 500);
    await sleep(300);
    let rows = await sidebarRows(A);
    check('Hide Muted Channels hides a muted collection of voice rooms: nothing would sit under its header', !hasRow(rows, 'Rooms renamed'), rows.map(r => r.name));
    check('and its rooms stay listed', oneVoiceRow(rows, 'Cellar') && oneVoiceRow(rows, 'Attic'), rows.filter(r => r.voice).map(r => r.name));
    const pressHideMuted = async () => {
        await A.locator(`.server-icon[title="${srvName}"]`).click({ button: 'right' });
        await A.locator('.context-menu-item.has-toggle', { hasText: 'Hide Muted Channels' }).click();
        await A.keyboard.press('Escape').catch(() => {});
        await A.mouse.click(700, 500);
        await sleep(300);
    };
    // What is open never vanishes from under the reader, a collection as much as a channel.
    await pressHideMuted();
    await textRow(A, 'Rooms renamed').click();
    await until(async () => (await header(A)) === 'Rooms renamed', 6000);
    await pressHideMuted();
    rows = await sidebarRows(A);
    const openRow = named(rows, 'Rooms renamed');
    check('Hide Muted Channels keeps the muted collection that is open, once', openRow.length === 1 && openRow[0].collection, rows.map(r => r.name));
    check('with its page still there', (await header(A)) === 'Rooms renamed' && await empty().count() === 1, await header(A));
    await shot(A, '07b-desktop-open-muted-collection-stays');
    await textRow(A, 'lobby').click();
    check('and leaving it is what hides it', !!await until(async () => !hasRow(await sidebarRows(A), 'Rooms renamed'), 6000), (await sidebarRows(A)).map(r => r.name));
    await pressHideMuted();
    await menu(A, textRow(A, 'Rooms renamed'), 'Unmute Channel');

    // Create Subchannel, then the Collection button: Nest Under is hidden for a collection, so
    // it has no parent. A nested one would be a collection whose rooms a delete can miss.
    const createFrom = async (collection, kind, name) => {
        await menu(A, textRow(A, collection), 'Create Subchannel');
        await A.locator('.type-btn', { hasText: kind }).click();
        await A.locator('form:has(button.create-btn) input[type="text"]').fill(name);
        await A.locator('button.create-btn').click();
        await A.locator('button.create-btn').waitFor({ state: 'detached', timeout: 6000 });
    };
    const rowCalled = async (name) => (await api(A, 'GET', `/servers/${srv.id}/channels`)).find(c => c.name === name);
    await createFrom('Mixed', 'Collection', 'Top shelf');
    const shelf = await until(() => rowCalled('Top shelf'), 5000);
    check('a collection made from Create Subchannel has no parent', !!shelf && shelf.channel_type === 2 && (shelf.parent_id ?? null) === null, shelf);
    await createFrom('Mixed', 'Text', 'mixed-more');
    const more = await until(() => rowCalled('mixed-more'), 5000);
    check('control: a text channel made the same way is nested', more?.parent_id === mixed.id, more);

    // Create Subchannel, then Cancel: Cancel only hides the form, and what it hid must not come
    // back with the next +. Elsewhere it named a collection the next server does not have, and
    // every create was refused for a reason nobody could see.
    const parentPick = () => A.locator('.parent-channel-select');
    const cancelCreate = () => A.locator('form:has(button.create-btn) button.cancel-btn').click();
    const typedCreate = async (name) => {
        await A.locator('form:has(button.create-btn) input[type="text"]').fill(name);
        await A.locator('button.create-btn').click();
        await A.locator('button.create-btn').waitFor({ state: 'detached', timeout: 6000 });
    };
    await menu(A, textRow(A, 'Mixed'), 'Create Subchannel');
    await parentPick().waitFor({ timeout: 6000 });
    check('control: Create Subchannel starts under its collection', (await parentPick().inputValue()) === String(mixed.id), await parentPick().inputValue());
    await A.locator('.type-btn', { hasText: 'Checklist' }).click();
    await cancelCreate();
    await A.locator('.add-channel-btn[title="Create Text Channel"]').click();
    check('the + after a cancelled Create Subchannel starts at the top level', (await parentPick().inputValue()) === '', await parentPick().inputValue());
    check('as a plain text channel', /Text$/.test((await A.locator('.type-btn.active').innerText()).trim()), await A.locator('.type-btn.active').innerText());
    await typedCreate('after-cancel');
    const afterCancel = await until(() => rowCalled('after-cancel'), 5000);
    check('and what it makes has no parent', !!afterCancel && (afterCancel.parent_id ?? null) === null && !afterCancel.has_checklist, afterCancel);
    await menu(A, textRow(A, 'Mixed'), 'Create Subchannel');
    await parentPick().waitFor({ timeout: 6000 });
    await cancelCreate();
    await A.locator(`.server-icon[title="${landSrvName}"]`).click();
    await until(async () => named(await sidebarRows(A), 'Vault').length === 1, 8000);
    dialogs.length = 0;
    await A.locator('.add-channel-btn[title="Create Voice Channel"]').click();
    await typedCreate('Far from Mixed');
    const onOtherServer = await until(async () => (await api(A, 'GET', `/servers/${landSrv.id}/channels`)).find(c => c.name === 'Far from Mixed'), 5000);
    check('on another server it creates, with no refusal', !!onOtherServer && (onOtherServer.parent_id ?? null) === null && dialogs.length === 0, { onOtherServer, dialogs });
    await A.locator(`.server-icon[title="${srvName}"]`).click();
    await until(async () => (await voiceOrder(A)).includes('Town'), 8000);

    // A channel under a collection inside a collection: nothing draws it there, and it still
    // needs a row. Only the API or an older client can make one now, and the pickers stop adding to it.
    const inner = await mk('Inner', 2);
    const underInner = await mk('under-inner', 0, inner.id);
    await api(A, 'PATCH', `/channels/${inner.id}`, { parent_id: mixed.id });
    for (const [who, page] of [['desktop', A], ['phone', B]]) {
        const found = await until(async () => {
            const row = named(await sidebarRows(page), 'under-inner');
            return row.length === 1 && !row[0].sub ? row : null;
        }, 8000);
        check(`${who}: a channel under a collection inside a collection has one row, at the top level`, !!found, named(await sidebarRows(page), 'under-inner'));
        check(`${who} control: the collection it is under keeps its row under its own parent`, named(await sidebarRows(page), 'Inner')[0]?.sub === true, named(await sidebarRows(page), 'Inner'));
    }
    const optionsOf = (field) => field.locator('option').allInnerTexts();
    await A.locator('.add-channel-btn[title="Create Text Channel"]').click();
    const nestOptions = await optionsOf(parentPick());
    check('Nest Under does not offer a collection inside a collection', nestOptions.includes('Mixed') && !nestOptions.includes('Inner'), nestOptions);
    await cancelCreate();
    await menu(A, textRow(A, 'lobby'), 'Edit');
    const parentOptions = await optionsOf(A.locator('#channel-parent'));
    check('nor does Parent Collection', parentOptions.includes('Mixed') && !parentOptions.includes('Inner'), parentOptions);
    await A.locator('.edit-channel-modal .close-button').click();
    await menu(A, textRow(A, 'under-inner'), 'Edit');
    check('except on the channel already in it, as what it is under', (await A.locator('#channel-parent').inputValue()) === String(inner.id), await A.locator('#channel-parent').inputValue());
    await A.locator('#channel-parent').selectOption({ label: NO_PARENT });
    await saveEdit();
    check('and from there it can leave', !!await until(async () => (await parentOf(underInner.id)) === null, 5000), await parentOf(underInner.id));

    // Deleting takes the rooms with it (the foreign key cascades): they are not drawn under
    // it any more, so the confirmation has to say so, and the list has to lose them.
    dialogs.length = 0;
    await menu(A, textRow(A, 'Doomed'), 'Delete');
    await until(() => dialogs.length > 0, 3000);
    const asked = dialogs[dialogs.length - 1] ?? '';
    check('deleting a collection names what goes with it, at every level', ['Gone room', 'Deeper', 'Deep room'].every(n => asked.includes(n)), dialogs);
    check('with no # on anything that is not a text channel', !asked.includes('#'), asked);
    check('its row goes', !!await until(async () => !hasRow(await sidebarRows(A), 'Doomed'), 6000));
    const afterDelete = await sidebarRows(A);
    check('and so does everything in it, at every level, with no reload', !hasRow(afterDelete, 'Gone room') && !hasRow(afterDelete, 'Deeper') && !hasRow(afterDelete, 'Deep room'), afterDelete.map(r => r.name));
    const gone = await api(A, 'GET', `/servers/${srv.id}/channels`);
    check('as the server says', !gone.some(c => [doomed.id, goneRoom.id, deeper.id, deepRoom.id].includes(c.id)), gone.map(c => c.name));
    // Nobody but the deleter used to hear of it: no mode names these, so only the new frame can.
    const phoneLost = await until(async () => {
        const left = await sidebarRows(B);
        return ['Doomed', 'Gone room', 'Deeper', 'Deep room'].every(n => !hasRow(left, n)) ? left : null;
    }, 8000);
    check('another member\'s list loses all of it too, with no reload', !!phoneLost, (await sidebarRows(B)).map(r => r.name));

    // What they had open of it closes. The third account in a room of it and reading a channel
    // of it, the phone on the collection's own page.
    const vanish = await mk('Vanishing', 2);
    await mk('vanish-notes', 0, vanish.id);
    const vanishRoom = await mk('Vanish room', 1, vanish.id);
    const farAway = await mk('Far away', 2);
    const farRoom = await mk('Far room', 1, farAway.id);
    const spare = await mk('spare', 0);
    await C.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(C);
    await C.locator(`.server-icon[title="${srvName}"]`).click();
    await until(async () => (await voiceOrder(C)).includes('Vanish room'), 8000);
    const inCall = (page) => page.locator('.voice-panel-compact .voice-connected-label').count();
    await voiceRow(C, vanishRoom.id).click();
    check('fixture: the third account is in the room', !!await until(async () => (await inCall(C)) > 0, 25000));
    await textRow(C, 'vanish-notes').click();
    check('fixture: and reading the channel', !!await until(async () => (await header(C)) === 'vanish-notes', 6000), await header(C));
    const composerOfC = C.locator('textarea.message-textarea');
    await composerOfC.fill('written for vanish-notes');
    await B.locator('.mobile-nav-btn').nth(1).tap().catch(() => {});
    await sleep(400);
    await textRow(B, 'Vanishing').tap();
    check('fixture: the phone has the collection open', !!await until(async () => (await header(B)) === 'Vanishing', 6000), await header(B).catch(String));
    await api(A, 'DELETE', `/channels/${vanish.id}`);
    check('another member reading a channel in it is taken off it', !!await until(async () => (await header(C)) !== 'vanish-notes', 8000), await header(C));
    check('their call in a room of it ends', !!await until(async () => (await inCall(C)) === 0, 8000), await inCall(C));
    check('and a toast says why, naming the room', (await C.locator('.app-toast-text').allInnerTexts()).some(t => t.includes('Vanish room is no longer available, so you left its call.')), await C.locator('.app-toast-text').allInnerTexts());
    check('what they were writing there is not in the next channel\'s box', (await composerOfC.inputValue()) === '', await composerOfC.inputValue());
    const noticeOfC = C.locator('.app-notice-text');
    check('a notice has it, and says where it was written', !!await until(async () => (await noticeOfC.allInnerTexts()).some(t => t.includes('#vanish-notes') && t.includes('written for vanish-notes')), 4000), await noticeOfC.allInnerTexts());
    await composerOfC.press('Enter');
    await sleep(500);
    check('and Enter posts nothing', !(await C.locator('.messages-container').innerText()).includes('written for vanish-notes'));
    await C.locator('.app-notice-close').first().click({ timeout: 3000 }).catch(() => {});
    const thirdRows = await sidebarRows(C);
    check('and neither is listed', !hasRow(thirdRows, 'vanish-notes') && !hasRow(thirdRows, 'Vanish room'), thirdRows.map(r => r.name));
    check('another member with the collection open is taken off it', !!await until(async () => (await header(B).catch(() => '')) !== 'Vanishing', 8000), await header(B).catch(String));

    // A call on a server they are not looking at has its own list.
    await voiceRow(C, farRoom.id).click();
    check('fixture: the third account is in a room again', !!await until(async () => (await inCall(C)) > 0, 25000));
    await C.locator(`.server-icon[title="${thirdSrvName}"]`).click();
    await until(async () => !(await voiceOrder(C)).includes('Far room'), 8000);
    check('control: looking at another server keeps the call', (await inCall(C)) > 0);
    await api(A, 'DELETE', `/channels/${spare.id}`);
    await sleep(1500);
    check('control: and so does the delete of another channel over there', (await inCall(C)) > 0);
    check('control: with nothing said of either', !(await C.locator('.app-toast-text').allInnerTexts()).some(t => t.includes('Far room') || t.includes('spare')), await C.locator('.app-toast-text').allInnerTexts());
    await api(A, 'DELETE', `/channels/${farAway.id}`);
    check('the delete of the room they are in ends the call, wherever they are looking', !!await until(async () => (await inCall(C)) === 0, 8000), await inCall(C));
    check('and a toast says why there too', (await C.locator('.app-toast-text').allInnerTexts()).some(t => t.includes('Far room is no longer available, so you left its call.')), await C.locator('.app-toast-text').allInnerTexts());

    // A manager who cannot see all of a collection: the question can only name what they
    // can see, so the server refuses, and the person is told why and what to do.
    const guarded = await mk('Guarded', 2);
    await mk('guarded-notes', 0, guarded.id);
    const staffRoom = await mk('Staff room', 1, guarded.id);
    const roles = await api(A, 'GET', `/servers/${srv.id}/roles`);
    const everyone = roles.find(r => r.is_default);
    await api(A, 'PUT', `/channels/${staffRoom.id}/overwrites/${everyone.id}`, { allow: 0, deny: 1 << 0 });
    const mods = await api(A, 'POST', `/servers/${srv.id}/roles`, { name: 'Mods', permissions: (1 << 17) | (1 << 0) });
    const thirdId = await C.evaluate(() => JSON.parse(atob(localStorage.getItem('auth_token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub);
    await api(A, 'PUT', `/servers/${srv.id}/members/${thirdId}/roles/${mods.id}`);
    await C.locator(`.server-icon[title="${srvName}"]`).click();
    await until(async () => named(await sidebarRows(C), 'Guarded').length === 1, 8000);
    check('fixture: the manager has no row of the room hidden from them', !hasRow(await sidebarRows(C), 'Staff room'), (await sidebarRows(C)).map(r => r.name));
    dialogs.length = 0;
    await menu(C, textRow(C, 'Guarded'), 'Delete');
    await until(() => dialogs.length > 1, 5000);
    check('a manager who cannot see all of a collection is told why it was not deleted, and what to do', dialogs.some(d => /nothing was deleted/.test(d) && /ask someone who can see every channel/.test(d)), dialogs);
    const stillGuarded = await api(A, 'GET', `/servers/${srv.id}/channels`);
    check('and nothing was', [guarded.id, staffRoom.id].every(id => stillGuarded.some(c => c.id === id)), stillGuarded.map(c => c.name));
    dialogs.length = 0;
    await menu(A, textRow(A, 'Guarded'), 'Delete');
    await until(() => dialogs.length > 0, 3000);
    check('control: someone who can see all of it is asked, and the question names the room', (dialogs[0] ?? '').includes('Staff room'), dialogs);
    check('and it goes, for the manager too', !!await until(async () => !hasRow(await sidebarRows(C), 'Guarded'), 8000), (await sidebarRows(C)).map(r => r.name));

    // A collection a member is denied. What is in it is not theirs either: the SERVER leaves it out of
    // their list and refuses it by number (a collection's deny reaches what is inside it, and a channel
    // inside with an allow of its own takes it back). Denying the collection is how an owner makes it
    // private, and until the server did that only this sidebar kept the rows out of sight.
    const deniedOne = await mk('Denied', 2);
    await mk('denied-notes', 0, deniedOne.id);
    const takenBack = await mk('taken-back', 0, deniedOne.id);
    await B.locator('.mobile-nav-btn').nth(1).tap().catch(() => {});
    await sleep(400);
    const beforeDeny = await until(async () => {
        const row = named(await sidebarRows(B), 'denied-notes');
        return row.length === 1 && row[0].sub ? row : null;
    }, 8000);
    check('control: a member who can see a collection has a row for what is in it, under it', !!beforeDeny, named(await sidebarRows(B), 'denied-notes'));
    const notesId = (await api(A, 'GET', `/servers/${srv.id}/channels`)).find(c => c.name === 'denied-notes').id;
    await api(A, 'PUT', `/channels/${takenBack.id}/overwrites/${everyone.id}`, { allow: 1 << 0, deny: 0 });
    await api(A, 'PUT', `/channels/${deniedOne.id}/overwrites/${everyone.id}`, { allow: 0, deny: 1 << 0 });
    check('fixture: denied it, the member has no row for the collection', !!await until(async () => !hasRow(await sidebarRows(B), 'Denied'), 8000), (await sidebarRows(B)).map(r => r.name));
    const listedForThem = (await api(B, 'GET', `/servers/${srv.id}/channels`)).map(c => c.name);
    check('the server does not list them what is in it, nor the collection', !listedForThem.includes('denied-notes') && !listedForThem.includes('Denied'), listedForThem);
    check('and has no row for it, because there is none to draw', !hasRow(await sidebarRows(B), 'denied-notes'), (await sidebarRows(B)).map(r => r.name));
    const refused = await api(B, 'GET', `/channels/${notesId}/messages`).then(() => 'answered', e => String(e.message).match(/: (\d+) /)?.[1]);
    check('asked for by number it is refused as one that does not exist', refused === '404', refused);
    check('control: the channel inside with an allow of its own is listed to them', listedForThem.includes('taken-back'), listedForThem);
    check('and drawn at the top, its collection not being theirs to see', !!await until(async () => named(await sidebarRows(B), 'taken-back').length === 1 && named(await sidebarRows(B), 'taken-back')[0].sub === false, 8000), named(await sidebarRows(B), 'taken-back'));
    check('control: someone who can see the collection keeps it there, under it', named(await sidebarRows(A), 'denied-notes')[0]?.sub === true, named(await sidebarRows(A), 'denied-notes'));
    await api(A, 'DELETE', `/channels/${deniedOne.id}`);

    // ── A7. The phone.
    await B.locator('.mobile-nav-btn').nth(1).tap().catch(() => {});
    await sleep(500);
    const phoneRows = await B.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const rows = [...document.querySelectorAll('.sidebar .channel')].filter(e => e.getClientRects().length > 0);
        return {
            vw,
            rows: rows.length,
            scrollWidth: document.documentElement.scrollWidth,
            over: rows.filter(e => e.getBoundingClientRect().right > vw + 0.5).map(e => e.textContent.trim().slice(0, 20)),
            covered: rows.filter((e) => {
                e.scrollIntoView({ block: 'center', behavior: 'instant' });
                const r = e.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return !hit || !e.contains(hit);
            }).map(e => e.textContent.trim().slice(0, 20)),
        };
    });
    check('phone: no row is past the edge', phoneRows.rows > 0 && phoneRows.over.length === 0 && phoneRows.scrollWidth <= phoneRows.vw + 0.5, phoneRows);
    check('phone: every row is what a tap at its centre hits', phoneRows.covered.length === 0, phoneRows.covered);
    await voiceRow(B, cellar.id).tap();
    check('phone: a tap on a room under a collection joins it', !!await until(async () => (await B.locator('.voice-panel-compact .voice-connected-label').count()) > 0, 25000));
    check('phone: and it shows the phone\'s own account in it', !!await until(async () => (await occupant(B, cellar.id)).includes('sbb_'), 10000), await occupant(B, cellar.id));
    await shot(B, '08-phone-in-a-room-under-a-collection');
    await B.locator('[title="Disconnect"]').first().tap().catch(() => {});
    await sleep(500);
    await B.locator('.mobile-nav-btn').nth(1).tap().catch(() => {});
    await sleep(300);
    await textRow(B, 'Rooms renamed').tap();
    check('phone: a collection of voice rooms opens', !!await until(async () => (await header(B)) === 'Rooms renamed', 6000), await header(B).catch(String));
    const phoneEmptyBox = () => B.locator('[data-testid="collection-empty"]').boundingBox({ timeout: 500 }).catch(() => null);
    const phoneEmpty = await until(async () => {
        const box = await phoneEmptyBox();
        return box && box.x >= 0 && box.x + box.width <= 390.5 ? box : null;
    }, 3000);
    check('phone: the page says what it holds, inside the window', !!phoneEmpty && phoneEmpty.x >= 0 && phoneEmpty.x + phoneEmpty.width <= 390.5, phoneEmpty);
    await shot(B, '09-phone-collection-of-voice-rooms-open');

    await A.locator('[title="Disconnect"]').first().click().catch(() => {});
    await sleep(300);

    // ── B1. Overview, desktop: the owner's four switches.
    await A.locator('.server-settings-btn').first().click();
    const overview = '.server-settings-content';
    await until(async () => (await A.locator(`${overview} .toggle-row`).count()) > 0, 8000);
    await noTransitions(A);
    await sleep(100);
    const names = ['Private Server', 'Require encryption for calls', 'Allow clips', 'Allow games in voice calls'];
    let facts = await switchFacts(A, overview);
    check('Overview: all four switches are there', names.every(n => facts.some(f => f.label === n)), facts.map(f => f.label));
    for (const f of facts) {
        const bad = switchProblems(f);
        check(`Overview: ${f.label} is a switch with a label beside it, on the default theme`, bad.length === 0, bad.length ? { bad, f } : '');
    }
    await A.locator('.form-group:has(.toggle-row)').first().evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await shot(A, '10-desktop-overview-switches');

    // NEGATIVE CONTROL: the bare dot, as `.form-group label` made it, must fail this check.
    const forced = await A.addStyleTag({ content: '.form-group label.toggle-row, .toggle-row { display: block !important; } .toggle-row .toggle-switch { display: inline !important; }' });
    const dot = await switchFacts(A, overview);
    check('NEGATIVE CONTROL: the bare dot forced back is caught, in so many words', dot.length === 4 && dot.every(f => switchProblems(f).some(p => p.startsWith('bare dot'))), dot.map(f => switchProblems(f)));
    await forced.evaluate(el => el.remove());
    await sleep(100);

    // A real click on each track, and on each label: lands, flips once, on and off differ.
    const facts1 = async (label) => (await switchFacts(A, overview)).find(f => f.label.includes(label));
    const rowOf = (label) => A.locator(`${overview} .toggle-row`, { hasText: label });
    for (const label of ['Require encryption for calls', 'Allow clips', 'Allow games in voice calls', 'Server']) {
        const before = await facts1(label);
        const track = rowOf(label).locator('.toggle-switch');
        await track.scrollIntoViewIfNeeded();
        const box = await track.boundingBox();
        await A.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(80);
        const after = await facts1(label);
        check(`Overview: a real click on the ${label} track flips it once`, after.checked === !before.checked, { before: before.checked, after: after.checked });
        const moved = Math.abs(after.knobLeft - before.knobLeft);
        const delta = before.paint.reduce((s, v, i) => s + Math.abs(v - after.paint[i]), 0);
        check(`Overview: on and off of ${label} are plainly different`, moved >= 16 && delta >= 60, { moved, delta, before: before.paint, after: after.paint });
        check(`Overview: and the other state is a switch too`, switchProblems(after).length === 0, switchProblems(after));
        await rowOf(label).locator('span:not(.toggle-switch)').first().click();
        await sleep(80);
        check(`Overview: a real click on its label flips it back`, (await facts1(label)).checked === before.checked);
    }

    // The keyboard, really: Tab from the description to each one, Space, and a ring to see.
    const description = A.locator(`${overview} textarea`).first();
    for (const label of ['Server', 'Require encryption for calls', 'Allow clips', 'Allow games in voice calls']) {
        const reached = await tabTo(A, description, label);
        check(`Overview: Tab reaches ${label}`, reached);
        if (!reached) continue;
        const ring = await focusRing(A);
        check(`Overview: and the focus shows on the switch`, ring.style !== 'none' && ring.width >= 2, ring);
        const before = (await facts1(label)).checked;
        await A.keyboard.press('Space');
        await sleep(80);
        check(`Overview: Space flips ${label}`, (await facts1(label)).checked === !before);
        await A.keyboard.press('Space');
        await sleep(80);
    }

    // The tab still saves what it shows: all four, both ways, read back from the server.
    const mine = async (page, id) => (await api(page, 'GET', '/servers')).find(s => s.id === id);
    const stateBefore = await mine(A, srv.id);
    check('fixture: the server starts private, unenforced, clips off and games on',
        !stateBefore.is_public && !stateBefore.require_media_e2ee && !stateBefore.clips_enabled && stateBefore.games_enabled !== false, stateBefore);
    const flip = async (label) => {
        const track = rowOf(label).locator('.toggle-switch');
        await track.scrollIntoViewIfNeeded();
        const box = await track.boundingBox();
        await A.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(80);
    };
    for (const label of ['Server', 'Require encryption for calls', 'Allow clips', 'Allow games in voice calls']) await flip(label);
    await A.locator('#clip-channel').selectOption({ label: '#lobby' });
    const save = A.locator(`${overview} .primary-btn`, { hasText: 'Save Changes' });
    await save.scrollIntoViewIfNeeded();
    await save.click();
    check('Overview: Save saves all four', !!await until(async () => {
        const s = await mine(A, srv.id);
        return s.is_public === true && s.require_media_e2ee === true && s.clips_enabled === true && s.games_enabled === false;
    }, 8000), await mine(A, srv.id));
    await A.locator(`${overview} .close-btn`).click();
    await A.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 });
    await A.locator('.server-settings-btn').first().click();
    await until(async () => (await A.locator(`${overview} .toggle-row`).count()) > 0, 8000);
    const reopened = await switchFacts(A, overview);
    const on = (label) => reopened.find(f => f.label.includes(label))?.checked;
    check('reopening shows what was saved', on('Server') === true && on('Require encryption') === true && on('Allow clips') === true && on('Allow games') === false, reopened.map(f => [f.label, f.checked]));
    for (const label of ['Server', 'Require encryption for calls', 'Allow clips', 'Allow games in voice calls']) await flip(label);
    await save.scrollIntoViewIfNeeded();
    await save.click();
    check('Overview: and saves them back', !!await until(async () => {
        const s = await mine(A, srv.id);
        return s.is_public === false && s.require_media_e2ee === false && s.clips_enabled === false && s.games_enabled === true;
    }, 8000), await mine(A, srv.id));

    // ── B2. All eight themes, with and without high contrast, both states.
    await A.locator(`${overview} .close-btn`).click();
    await A.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 });
    await A.locator('.server-settings-btn').first().click();
    await until(async () => (await A.locator(`${overview} .toggle-row`).count()) > 0, 8000);
    const setAll = (page, root, value) => page.evaluate(([root, value]) => {
        for (const i of document.querySelectorAll(`${root} .toggle-row input[type="checkbox"]`)) i.checked = value;
    }, [root, value]);
    for (const theme of THEMES) {
        for (const high of [false, true]) {
            await setTheme(A, theme, high);
            for (const state of [false, true]) {
                await setAll(A, overview, state);
                const all = await switchFacts(A, overview);
                const bad = all.flatMap(f => switchProblems(f).map(p => `${f.label}: ${p}`));
                check(`Overview on ${theme}${high ? ', high contrast' : ''}, ${state ? 'on' : 'off'}: every switch is a switch`, all.length === 4 && bad.length === 0,
                    bad.length ? { bad: bad.slice(0, 4), paint: all[0].paint } : `track ${all[0].trackVsSurface}:1, knob ${all[0].knobVsTrack}:1`);
            }
        }
        await setTheme(A, theme, false);
        await setAll(A, overview, true);
        await A.locator('.form-group:has(.toggle-row)').first().evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await sleep(60);
        await shot(A, `11-overview-${theme}-on`);
        await setAll(A, overview, false);
    }
    await setTheme(A, 'dark', false);

    // ── B3. The Modes tab's switch, the one the local fix was for.
    await A.locator('.server-settings-nav .nav-item', { hasText: 'Modes' }).click();
    await A.locator('[data-testid="mode-card"]').first().waitFor({ timeout: 8000 });
    await noTransitions(A);
    const modeFacts = await switchFacts(A, '.modes-settings');
    check('Modes tab: Turn off when empty is a switch', modeFacts.length >= 1 && modeFacts.every(f => switchProblems(f).length === 0), modeFacts.map(f => switchProblems(f)));
    const modeRow = A.locator('.modes-settings .toggle-row').first();
    const modeBefore = await modeRow.locator('input').isChecked();
    await modeRow.locator('.toggle-switch').click();
    check('Modes tab: a real click flips it', (await modeRow.locator('input').isChecked()) === !modeBefore);
    await modeRow.locator('.toggle-switch').click();
    await modeRow.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await shot(A, '12-desktop-modes-switch');
    for (const theme of THEMES) {
        for (const high of [false, true]) {
            await setTheme(A, theme, high);
            for (const state of [false, true]) {
                await setAll(A, '.modes-settings', state);
                const all = await switchFacts(A, '.modes-settings');
                const bad = all.flatMap(f => switchProblems(f).map(p => `${f.label}: ${p}`));
                check(`Modes tab on ${theme}${high ? ', high contrast' : ''}, ${state ? 'on' : 'off'}: its switch is a switch`, all.length >= 1 && bad.length === 0, bad.length ? bad.slice(0, 4) : `track ${all[0].trackVsSurface}:1, knob ${all[0].knobVsTrack}:1`);
            }
        }
    }
    await setTheme(A, 'dark', false);
    await A.locator(`${overview} .close-btn`).click();
    await A.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 });

    // ── B4. The sweep: every checkbox in a form group, on every page reached here, is one
    //    of the two rows this walk knows. Edit Channel's are `.form-group label.checkbox-label`,
    //    the same collision: its text was small capitals with the box above it on a phone.
    const groupCheckboxes = (page) => page.evaluate(() => [...document.querySelectorAll('.form-group input[type="checkbox"]')].map((i) => {
        const l = i.closest('label');
        return { kind: l ? (l.className || '(plain label)') : '(no label)', text: (l?.textContent ?? '').trim().slice(0, 30) };
    }));
    const known = /(^|\s)(toggle-row|checkbox-label|mode-channel)(\s|$)/;
    const sweep = {};
    // A page with no such row is no evidence of anything: it says so, and a page that should
    // have one fails without it. Any row on any page still has to be a known kind.
    const sweepOk = (found, expectRows) => (!expectRows || found.length > 0) && found.every(f => known.test(f.kind));
    const look = async (where, { page = A, expectRows = false } = {}) => {
        await sleep(250);
        const found = await groupCheckboxes(page);
        sweep[where] = found.map(f => `${f.kind}: ${f.text}`);
        if (found.length === 0 && !expectRows) {
            console.log(`INFO  sweep, ${where}: no checkbox in a form group on this page`);
            return;
        }
        check(`sweep, ${where}: ${found.length} checkbox row(s) in a form group, each a kind this walk knows`, sweepOk(found, true), found.filter(f => !known.test(f.kind)));
    };
    const checkboxRows = (page, root) => page.evaluate((root) => [...document.querySelectorAll(`${root} .form-group label`)].filter(l => l.querySelector('input[type="checkbox"]')).map((l) => {
        l.scrollIntoView({ block: 'center', behavior: 'instant' });
        const input = l.querySelector('input[type="checkbox"]');
        const box = input.getBoundingClientRect();
        const s = getComputedStyle(l);
        let opacity = 1;
        for (let e = input; e && e !== l.parentElement; e = e.parentElement) opacity *= parseFloat(getComputedStyle(e).opacity);
        const range = document.createRange();
        // The words: a text node in Edit Channel, a span in the two sign-in forms.
        const words = [...l.childNodes].filter(n => n.textContent.trim()).pop();
        range.selectNodeContents(words ?? l);
        const t = range.getBoundingClientRect();
        return { text: l.textContent.trim().slice(0, 30), display: s.display, transform: s.textTransform, height: Math.round(l.getBoundingClientRect().height), box: [Math.round(box.width), Math.round(box.height)], opacity, hitsBox: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === input, beside: box.right <= t.left + 1 && Math.abs((box.top + box.height / 2) - (t.top + t.height / 2)) <= 14, right: Math.round(l.getBoundingClientRect().right) };
    }), root);
    const checkboxBad = (r, minRow = 0) => [
        r.display !== 'flex' ? `display:${r.display}` : null,
        r.transform !== 'none' ? r.transform : null,
        r.box[0] > 24 || r.box[1] > 24 || r.box[0] < 14 || r.box[1] < 14 ? `checkbox ${r.box.join('x')}` : null,
        r.opacity < 0.5 ? `checkbox at opacity ${r.opacity}` : null,
        !r.hitsBox ? 'the checkbox is not what a click on it hits' : null,
        !r.beside ? 'text not beside the box' : null,
        r.height < minRow ? `row ${r.height}px` : null,
    ].filter(Boolean);
    const closeEdit = async (page) => {
        await page.locator('.edit-channel-modal').getByRole('button', { name: 'Cancel' }).click();
        await page.locator('.edit-channel-modal').waitFor({ state: 'detached', timeout: 5000 });
    };
    await A.locator('.server-settings-btn').first().click();
    for (const tab of ['Overview', 'Roles', 'Modes', 'Emoji', 'Invites', 'Moderation']) {
        await A.locator('.server-settings-nav .nav-item', { hasText: tab }).click();
        await A.locator('.server-settings-nav .nav-item.active', { hasText: tab }).waitFor({ timeout: 4000 });
        await look(`Server Settings > ${tab}`, { expectRows: tab === 'Overview' || tab === 'Modes' });
    }
    // NEGATIVE CONTROLS: what the sweep reads must be able to fail it. The last tab has no row.
    const noRows = await groupCheckboxes(A);
    check('NEGATIVE CONTROL: a page that should hold a row and holds none fails the sweep', noRows.length === 0 && !sweepOk(noRows, true), noRows);
    await A.evaluate(() => {
        const group = document.createElement('div');
        group.id = 'mystery-group';
        group.className = 'form-group';
        group.innerHTML = '<label class="mystery-row"><input type="checkbox"> a kind nobody measured</label>';
        document.querySelector('.server-settings-content').append(group);
    });
    const mystery = await groupCheckboxes(A);
    check('NEGATIVE CONTROL: a row of a kind this walk does not know fails the sweep', mystery.length === 1 && !sweepOk(mystery, false), mystery);
    await A.evaluate(() => document.getElementById('mystery-group').remove());
    await A.locator(`${overview} .close-btn`).click();
    await A.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 });
    await menu(A, voiceRow(A, attic.id), 'Edit');
    await A.locator('.edit-channel-modal').waitFor({ timeout: 6000 });
    await look('Edit Channel, voice', { expectRows: true });
    const voiceBoxes = await checkboxRows(A, '.edit-channel-modal');
    check('Edit Channel, voice: AFK and SFU are rows with the box beside the words', voiceBoxes.length === 2 && voiceBoxes.every(r => checkboxBad(r).length === 0), voiceBoxes.map(r => [r.text.slice(0, 12), checkboxBad(r)]));
    // NEGATIVE CONTROLS: a box you cannot see or cannot press must fail that measure.
    for (const [what, css] of [['collapsed to nothing', 'width: 0 !important; height: 0 !important;'], ['see-through', 'opacity: 0 !important;'], ['that a click goes through', 'pointer-events: none !important;']]) {
        const forcedBox = await A.addStyleTag({ content: `.edit-channel-modal .checkbox-label input[type="checkbox"] { ${css} }` });
        const boxes = await checkboxRows(A, '.edit-channel-modal');
        check(`NEGATIVE CONTROL: a checkbox ${what} is caught`, boxes.length === 2 && boxes.every(r => checkboxBad(r).length > 0), boxes.map(r => checkboxBad(r)));
        await forcedBox.evaluate(el => el.remove());
    }
    const afkBox = A.locator('.edit-channel-modal .checkbox-label input').first();
    const afkWas = await afkBox.isChecked();
    await A.locator('.edit-channel-modal .checkbox-label').first().click();
    check('Edit Channel: a click on the words ticks the box', (await afkBox.isChecked()) === !afkWas);
    await A.locator('.edit-channel-modal .checkbox-label').first().click();
    await shot(A, '13-desktop-edit-voice-checkboxes');
    await closeEdit(A);
    await menu(A, textRow(A, 'lobby'), 'Edit');
    await A.locator('.edit-channel-modal').waitFor({ timeout: 6000 });
    await look('Edit Channel, text', { expectRows: true });
    const textBoxes = await checkboxRows(A, '.edit-channel-modal');
    check('Edit Channel, text: Checklist is a row with the box beside the words', textBoxes.length === 1 && textBoxes.every(r => checkboxBad(r).length === 0), textBoxes.map(r => [r.text.slice(0, 12), checkboxBad(r)]));
    await closeEdit(A);
    await A.locator('.add-channel-btn').first().click();
    await A.locator('button.create-btn').waitFor({ timeout: 6000 });
    await look('Create Channel');
    await A.locator('button.cancel-btn').first().click();
    await sleep(150);
    await A.locator('.user-actions .user-action-btn[title="Settings"]').first().click({ timeout: 6000 });
    await A.locator('.settings-nav-item').first().waitFor({ timeout: 6000 });
    // Log Out is a row of this nav too, and not a page.
    const userSections = A.locator('.settings-nav-item:not(.logout)');
    const userTabs = await userSections.allInnerTexts();
    check('the user settings have pages to sweep', userTabs.length >= 3, userTabs);
    for (let i = 0; i < userTabs.length; i++) {
        await userSections.nth(i).click();
        await A.locator('.settings-nav-item.active', { hasText: userTabs[i].trim() }).waitFor({ timeout: 4000 });
        await look(`Settings > ${userTabs[i].trim()}`);
    }
    await A.keyboard.press('Escape');
    await sleep(200);
    // The two forms outside the app that hold such a row, signed out.
    const signedOutCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const signedOut = await signedOutCtx.newPage();
    watch(signedOut, 'signed-out');
    for (const [where, url] of [['Login', '/login'], ['Notes sign-in', '/notes/']]) {
        await signedOut.goto(APP + url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await signedOut.locator('#stay-signed-in').waitFor({ timeout: 30000 });
        await look(where, { page: signedOut, expectRows: true });
        const stayRows = await checkboxRows(signedOut, 'body');
        check(`${where}: Stay signed in is a row with the box beside the words`, stayRows.length === 1 && stayRows.every(r => checkboxBad(r).length === 0), stayRows.map(r => [r.text.slice(0, 12), checkboxBad(r)]));
    }
    console.log('SWEEP', JSON.stringify(Object.fromEntries(Object.entries(sweep).filter(([, v]) => v.length))));

    // ── B5. The phone, at 390x844 with a coarse pointer: its own server, so its own switches.
    await B.locator('.mobile-nav-btn').first().tap();
    await sleep(400);
    await B.locator(`.server-icon[title="${phoneSrvName}"]`).tap();
    await sleep(900);
    await B.locator('.mobile-nav-btn').nth(1).tap().catch(() => {});
    await sleep(300);
    await B.locator('.server-settings-btn').first().tap();
    await until(async () => (await B.locator(`${overview} .toggle-row`).count()) > 0, 8000);
    await noTransitions(B);
    await sleep(100);
    const phoneFacts = await switchFacts(B, overview);
    check('phone Overview: all four switches are there', phoneFacts.length === 4, phoneFacts.map(f => f.label));
    for (const f of phoneFacts) {
        const bad = switchProblems(f);
        check(`phone Overview: ${f.label} is a switch with 44 px to press, inside the window`, bad.length === 0, bad.length ? { bad, f } : `row ${f.row.join('x')}`);
    }
    await B.locator('.form-group:has(.toggle-row)').first().evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await shot(B, '14-phone-overview-switches');
    const phoneRow = (label) => B.locator(`${overview} .toggle-row`, { hasText: label });
    const tapTrack = async (label) => {
        const track = phoneRow(label).locator('.toggle-switch');
        await track.scrollIntoViewIfNeeded();
        const box = await track.boundingBox();
        await B.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(120);
    };
    const encBefore = await phoneRow('Require encryption').locator('input').isChecked();
    await tapTrack('Require encryption');
    check('phone: a real tap on the track flips it once', (await phoneRow('Require encryption').locator('input').isChecked()) === !encBefore);
    const phoneSave = B.locator(`${overview} .primary-btn`, { hasText: 'Save Changes' });
    await phoneSave.scrollIntoViewIfNeeded();
    await phoneSave.tap();
    check('phone: Save saves it', !!await until(async () => (await mine(B, phoneSrv.id)).require_media_e2ee === !encBefore, 8000), await mine(B, phoneSrv.id));
    for (const theme of ['light', 'yellow']) {
        await setTheme(B, theme, true);
        await setAll(B, overview, false);
        const all = await switchFacts(B, overview);
        const bad = all.flatMap(f => switchProblems(f).map(p => `${f.label}: ${p}`));
        check(`phone Overview on ${theme}, high contrast: every switch is a switch`, bad.length === 0, bad.slice(0, 4));
    }
    await setTheme(B, 'dark', false);
    await B.locator(`${overview} .close-btn`).tap();
    await B.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 });
    const phoneVoice = await api(B, 'POST', `/servers/${phoneSrv.id}/channels`, { name: 'Phone room', channel_type: 1 });
    await B.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(B);
    await B.locator('.mobile-nav-btn').first().tap();
    await sleep(400);
    await B.locator(`.server-icon[title="${phoneSrvName}"]`).tap();
    await sleep(900);
    await B.locator('.mobile-nav-btn').nth(1).tap().catch(() => {});
    await sleep(300);
    await voiceRow(B, phoneVoice.id).evaluate((el) => {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10, button: 2 }));
    });
    const editItem = B.locator('.context-menu .context-menu-item', { hasText: 'Edit' }).first();
    await editItem.waitFor({ timeout: 6000 });
    await editItem.tap();
    await B.locator('.edit-channel-modal').waitFor({ timeout: 6000 });
    await sleep(200);
    const phoneBoxes = await checkboxRows(B, '.edit-channel-modal');
    check('phone Edit Channel: AFK and SFU are 44 px rows with the box beside the words, inside the window', phoneBoxes.length === 2 && phoneBoxes.every(r => checkboxBad(r, 44).length === 0 && r.right <= 390), phoneBoxes);
    await shot(B, '15-phone-edit-voice-checkboxes');
} catch (e) {
    check('the walk ran to the end', false, String(e?.stack || e).slice(0, 800));
} finally {
    await browser.close();
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures);
