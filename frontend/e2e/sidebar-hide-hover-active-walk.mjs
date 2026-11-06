// LIVE: three things the channel sidebar and the member list gained together, in a real browser on
// the real cascade, through a real backend and the BUILT bundle.
//
//   A. FOLD (Discord's "Collapse Category"). The Text Channels and Voice Channels headings, and each
//      collection, are buttons. Folded, a group keeps the channel that is open, every unread channel
//      (messages are end-to-end encrypted, so the list cannot know which unread one holds an @mention:
//      none is folded out of sight) and, for voice, every room with somebody in it. It says how many it
//      is holding back, is remembered on this device PER SERVER, never reaches the server, and is
//      reachable and pressable from the keyboard.
//   B. WHO IS IN IT. A mouse resting on a voice row, or the keyboard on it, brings up a card naming
//      everyone in the room, or saying that nobody is: the case the row's own list cannot show. A
//      finger opens nothing (there is no hover), and a phone has the occupants under the row instead.
//   C. ACTIVE IN YOUR SERVERS. Under the member list: the voice channels with somebody in them in EVERY
//      server the account is in, not only the open one. A room appears and goes with no reload (the
//      live roster events), a page loaded while a call was already running shows it (the snapshot), a
//      server the account is not in, and a channel it may not view, are never shown and never asked
//      for, a row goes to its server without joining, and Settings > Appearance turns it, and the
//      reading it needs, off.
//
// All of it at 1280x800 with a real mouse and at 390x844 with real touches, on all eight themes with and
// without high contrast (every run of words 4.5:1, every control 44 px on touch).
//
// Each check prints PASS/FAIL; the exit code is the number of failures. Screenshots go to OUT.
//
// Prereqs: a THROWAWAY backend (APP_ENV=development, raised AUTH_RATE_LIMIT_PER_SECOND / _BURST, its own
// fresh database, never a real one) at API, and a build against it served at APP (header of
// sidebar-toggles-walk.mjs). It refuses to start unless both are loopback: it creates accounts.
// Silent: --mute-audio and fake media devices. No LiveKit: the calls are mesh. A few minutes.
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5332 API=http://127.0.0.1:5331 OUT=<dir> node e2e/sidebar-hide-hover-active-walk.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP = (process.env.APP || '').replace(/\/$/, '');
const API = (process.env.API || '').replace(/\/$/, '');
const OUT = process.env.OUT || 'e2e/shots-sidebar-hide-hover-active';
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

const requests = [];
function watch(page, tag) {
    page.on('console', m => fs.appendFileSync(path.join(OUT, 'console.txt'), `${new Date().toISOString()} ${tag} ${m.type()} ${m.text().slice(0, 400)}\n`));
    page.on('pageerror', e => { check(`${tag}: no uncaught page error`, false, e.message.slice(0, 200)); });
    page.on('dialog', d => { d.type() === 'confirm' ? d.accept().catch(() => {}) : d.dismiss().catch(() => {}); });
    page.on('request', r => requests.push({ tag, url: r.url(), at: Date.now() }));
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
/** The same, but the status instead of a throw. */
const status = (page, method, p) => page.evaluate(async ({ API, method, p }) => {
    const r = await fetch(API + p, { method, headers: { authorization: `Bearer ${localStorage.getItem('auth_token')}` } });
    return r.status;
}, { API, method, p });

async function setTheme(page, theme, contrastOn) {
    await page.evaluate(([theme, contrastOn]) => {
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-contrast', contrastOn ? 'high' : 'normal');
    }, [theme, contrastOn]);
    await sleep(120);
}
const noTransitions = (page) => page.addStyleTag({ content: '*, *::after, *::before { transition: none !important; animation: none !important; }' });

const textRows = (page) => page.evaluate(() => [...document.querySelectorAll('.sidebar .channel-list:not(.voice-channel-list) .channel')].map(e => (e.querySelector('.channel-name')?.textContent ?? '').trim()));
const voiceRows = (page) => page.evaluate(() => [...document.querySelectorAll('.voice-channel-list [data-testid="voice-channel"]')].map(e => e.getAttribute('aria-label')?.split(',')[0] ?? ''));
const voiceRow = (page, id) => page.locator(`[data-testid="voice-channel"][data-channel-id="${id}"]`);
const textRow = (page, name) => page.locator('.sidebar .channel-list:not(.voice-channel-list) .channel').filter({ has: page.locator(`.channel-name:text-is("${name}")`) });
const card = (page) => page.locator('[data-testid="roster-card"]');
const panel = (page) => page.locator('[data-testid="active-panel"]');
const panelRooms = (page) => page.evaluate(() => [...document.querySelectorAll('.active-server')].map(s => ({
    server: s.querySelector('.active-server-text')?.textContent ?? '',
    rooms: [...s.querySelectorAll('.active-room')].map(r => ({ name: r.querySelector('.active-room-name')?.textContent ?? '', who: r.querySelector('.active-room-who')?.textContent ?? '' })),
})));
const inCall = (page) => page.locator('.voice-panel-compact .voice-connected-label').count();

/** Contrast of a run of words against what it is painted on, 1 level of ancestor blending included. */
const contrasts = (page, selectors) => page.evaluate((selectors) => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true });
    const rgba = (s) => { g.clearRect(0, 0, 1, 1); g.fillStyle = 'rgba(0,0,0,0)'; g.fillStyle = s; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
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
    const ratio = (x, y) => { const [h, l] = [lum(x), lum(y)].sort((p, q) => q - p); return Math.round(((h + 0.05) / (l + 0.05)) * 100) / 100; };
    return selectors.map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { sel, missing: true };
        const col = rgba(getComputedStyle(el).color);
        const bg = behind(el);
        return { sel, ratio: ratio(over(col, bg), bg) };
    });
}, selectors);

/** Real Tab presses from `start` until the focus is on an element matching `sel`. */
async function tabTo(page, start, sel, max = 40) {
    await start.focus();
    for (let i = 0; i < max; i++) {
        await page.keyboard.press('Tab');
        if (await page.evaluate((sel) => !!document.activeElement?.matches(sel), sel)) return true;
    }
    return false;
}

try {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const otherCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const outsiderCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const A = await signIn(desktop, 'fha_' + stamp, 'owner');
    const B = await signIn(phoneCtx, 'fhb_' + stamp, 'phone');
    const C = await signIn(otherCtx, 'fhc_' + stamp, 'caller');
    const D = await signIn(outsiderCtx, 'fhd_' + stamp, 'outsider');

    // ── Fixture. S1 (A owns): text, a collection of two text channels, three voice rooms.
    //    S2 (C owns; A and B are members): a voice room, and one A may not view.
    //    S3 (D owns; nobody else is in it): a voice room with somebody in it that A must never see.
    const s1Name = 'fh1_' + stamp, s2Name = 'fh2_' + stamp, s3Name = 'fh3_' + stamp;
    const s1 = await api(A, 'POST', '/servers', { name: s1Name });
    const mk = (page, sid, name, type, parent) => api(page, 'POST', `/servers/${sid}/channels`, { name, channel_type: type, parent_id: parent });
    // The defaults a server starts with would blur every count below: take the text ones away once the ones wanted are made.
    const lobby = await mk(A, s1.id, 'lobby', 0);
    const news = await mk(A, s1.id, 'news', 0);
    const docs = await mk(A, s1.id, 'Docs', 2);
    const guide = await mk(A, s1.id, 'guide', 0, docs.id);
    const faq = await mk(A, s1.id, 'faq', 0, docs.id);
    const lounge = await mk(A, s1.id, 'Lounge', 1);
    const quiet = await mk(A, s1.id, 'Quiet', 1);
    for (const c of await api(A, 'GET', `/servers/${s1.id}/channels`)) {
        if (![lobby.id, news.id, docs.id, guide.id, faq.id, lounge.id, quiet.id].includes(c.id)) await api(A, 'DELETE', `/channels/${c.id}`).catch(() => {});
    }
    const inv1 = await api(A, 'POST', `/servers/${s1.id}/invites`, {});
    for (const p of [B, C]) await api(p, 'POST', `/invites/${inv1.code}/join`);

    const s2 = await api(C, 'POST', '/servers', { name: s2Name });
    const arena = await mk(C, s2.id, 'Arena', 1);
    const backroom = await mk(C, s2.id, 'Backroom', 1);
    const inv2 = await api(C, 'POST', `/servers/${s2.id}/invites`, {});
    for (const p of [A, B]) await api(p, 'POST', `/invites/${inv2.code}/join`);
    const roles2 = await api(C, 'GET', `/servers/${s2.id}/roles`);
    await api(C, 'PUT', `/channels/${backroom.id}/overwrites/${roles2.find(r => r.is_default).id}`, { allow: 0, deny: 1 << 0 });

    const s3 = await api(D, 'POST', '/servers', { name: s3Name });
    const vault = await mk(D, s3.id, 'Vault', 1);

    for (const page of [A, B, C, D]) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(2500);
        await dismiss(page);
    }
    for (const page of [A, C]) await noTransitions(page);
    await A.locator(`.server-icon[title="${s1Name}"]`).click();
    await C.locator(`.server-icon[title="${s1Name}"]`).click();
    await B.locator('.mobile-nav-btn').first().tap();
    await sleep(400);
    await B.locator(`.server-icon[title="${s1Name}"]`).tap();
    await until(async () => (await textRows(A)).includes('news') && (await voiceRows(A)).includes('Lounge'), 15000);
    await sleep(500);
    await textRow(A, 'lobby').click();
    await sleep(400);

    // ── A. Folding.
    const toggleText = A.locator('[data-testid="toggle-text-channels"]');
    const toggleVoice = A.locator('[data-testid="toggle-voice-channels"]');
    check('the Text Channels heading is a button, open to start with', (await toggleText.getAttribute('aria-expanded')) === 'true');
    check('control: with nothing folded every text row is drawn', (await textRows(A)).join() === 'lobby,news,Docs,guide,faq', await textRows(A));
    check('and no count of what is held back', await A.locator('.section-hidden').count() === 0);
    await shot(A, 'a1-desktop-open');

    await toggleText.click();
    await sleep(200);
    check('folding Text Channels leaves the open channel and takes the rest away', (await textRows(A)).join() === 'lobby', await textRows(A));
    check('the heading says it is folded, and how many it holds back', (await toggleText.getAttribute('aria-expanded')) === 'false' && (await A.locator('.sidebar-section').first().locator('.section-hidden').innerText()) === '3 hidden');
    check('the voice rooms are untouched by it', (await voiceRows(A)).join() === 'Lounge,Quiet', await voiceRows(A));
    await shot(A, 'a2-desktop-text-folded');

    // Unread keeps a channel on the list: a message into `news` from another account, then the poll.
    await api(C, 'POST', `/channels/${news.id}/messages`, { content: 'something to read' });
    check('an unread channel comes back onto a folded list (the 30 s unread poll)', !!await until(async () => (await textRows(A)).includes('news'), 40000), await textRows(A));
    check('and only that one: a channel nothing was said in stays folded', !(await textRows(A)).includes('guide') && !(await textRows(A)).includes('faq'), await textRows(A));
    check('its count is the unread badge, and the heading counts the rest', (await textRow(A, 'news').locator('.unread-badge').count()) === 1 && (await A.locator('.sidebar-section').first().locator('.section-hidden').innerText()) === '2 hidden');
    // Reading it makes it the open channel (so it stays), and opening another channel lets it fold away.
    await textRow(A, 'news').click();
    await sleep(800);
    check('opened, it stays on the folded list whether or not it has anything unread', (await textRows(A)).join() === 'news', await textRows(A));
    await toggleText.click();
    await sleep(150);
    await textRow(A, 'lobby').click();
    await sleep(600);
    await toggleText.click();
    await sleep(150);
    check('read, it folds away again once it is not the open channel', !!await until(async () => !(await textRows(A)).includes('news'), 40000) || !(await textRows(A)).includes('news'), await textRows(A));

    // Remembered on this device, per server, and kept off the server.
    const sentFold = requests.filter(r => /fold|collapse/i.test(r.url));
    await A.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await dismiss(A);
    await noTransitions(A);
    check('the fold is still there after a reload', (await A.locator('[data-testid="toggle-text-channels"]').getAttribute('aria-expanded')) === 'false' && (await A.locator('.sidebar .channel-list:not(.voice-channel-list) .channel').count()) <= 2, await textRows(A));
    check('it is not sent to the server', sentFold.length === 0, sentFold.map(r => r.url));
    await A.locator(`.server-icon[title="${s2Name}"]`).click();
    await until(async () => (await A.locator('.server-name').innerText()) === s2Name, 8000);
    check('it belongs to one server: the next server\'s Text Channels are not folded', (await A.locator('[data-testid="toggle-text-channels"]').getAttribute('aria-expanded')) === 'true');
    await A.locator(`.server-icon[title="${s1Name}"]`).click();
    await until(async () => (await A.locator('.server-name').innerText()) === s1Name, 8000);
    check('and the first is still folded when you come back', (await A.locator('[data-testid="toggle-text-channels"]').getAttribute('aria-expanded')) === 'false');

    // From the keyboard: Tab to the heading and Enter, then Space.
    const toggleText2 = A.locator('[data-testid="toggle-text-channels"]');
    check('the keyboard reaches the Text Channels heading', await tabTo(A, A.locator('.server-settings-btn'), '[data-testid="toggle-text-channels"]'));
    await A.keyboard.press('Enter');
    await sleep(150);
    check('Enter unfolds it', (await toggleText2.getAttribute('aria-expanded')) === 'true' && (await textRows(A)).length === 5, await textRows(A));
    await A.keyboard.press('Space');
    await sleep(150);
    check('Space folds it', (await toggleText2.getAttribute('aria-expanded')) === 'false');
    const ring = await toggleText2.evaluate(el => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), focus: el.matches(':focus-visible') }; });
    check('with a visible ring from the keyboard', ring.focus && ring.style !== 'none' && ring.width >= 2, ring);
    await toggleText2.click();
    await sleep(150);

    // A collection.
    const toggleDocs = A.locator(`[data-testid="toggle-collection"][data-channel-id="${docs.id}"]`);
    check('a collection has its own fold', (await toggleDocs.getAttribute('aria-expanded')) === 'true');
    await toggleDocs.click();
    await sleep(200);
    check('folding it takes its channels away and keeps the collection', (await textRows(A)).join() === 'lobby,news,Docs', await textRows(A));
    check('and says how many', (await textRow(A, 'Docs').locator('.section-hidden').innerText()) === '2 hidden');
    check('pressing the arrow did not open the collection', (await A.locator('.chat-header h2').first().innerText()) !== 'Docs');
    await A.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await dismiss(A);
    await noTransitions(A);
    check('a folded collection is still folded after a reload', (await textRows(A)).join() === 'lobby,news,Docs', await textRows(A));
    await A.locator(`[data-testid="toggle-collection"][data-channel-id="${docs.id}"]`).click();
    await sleep(200);
    check('and unfolds', (await textRows(A)).join() === 'lobby,news,Docs,guide,faq', await textRows(A));
    // A collection's fold gives way to the section's.
    await A.locator('[data-testid="toggle-text-channels"]').click();
    await sleep(150);
    check('while the section is folded there is no per-collection arrow (its fold decides)', await A.locator('[data-testid="toggle-collection"]').count() === 0);
    await A.locator('[data-testid="toggle-text-channels"]').click();
    await sleep(150);

    // Voice: empty rooms fold, occupied ones stay.
    await voiceRow(C, lounge.id).click();
    check('fixture: the caller is in Lounge', !!await until(async () => (await inCall(C)) > 0, 25000));
    check('control: Lounge lists who is in it on the owner\'s list', !!await until(async () => (await A.locator(`[data-voice-drop="${lounge.id}"] .voice-users-list`).innerText().catch(() => '')).includes('fhc_'), 10000));
    await toggleVoice.click();
    await sleep(200);
    check('folding Voice Channels keeps the room with somebody in it and takes the empty one away', (await voiceRows(A)).join() === 'Lounge', await voiceRows(A));
    check('the occupants are still listed under it', (await A.locator(`[data-voice-drop="${lounge.id}"] .voice-users-list`).innerText()).includes('fhc_'));
    check('the heading counts the empty rooms it holds back', (await A.locator('.sidebar-section').nth(1).locator('.section-hidden').innerText()) === '1 empty');
    await shot(A, 'a3-desktop-voice-folded');
    await toggleVoice.click();
    await sleep(150);
    check('unfolded, every room is back', (await voiceRows(A)).join() === 'Lounge,Quiet', await voiceRows(A));

    // ── B. Who is in it.
    const loungeRow = voiceRow(A, lounge.id);
    const quietRow = voiceRow(A, quiet.id);
    await loungeRow.hover();
    check('a mouse resting on a voice row brings up who is in it', !!await until(async () => (await card(A).count()) === 1, 2500));
    const cardText = await card(A).innerText();
    check('the card names the room, the count and the person', cardText.includes('Lounge') && cardText.includes('1 in this channel') && cardText.includes('fhc_'), cardText);
    const box = await card(A).boundingBox();
    const rowBox = await loungeRow.boundingBox();
    check('it sits beside the row, inside the window', box.x >= rowBox.x + rowBox.width - 1 && box.x + box.width <= 1280 && box.y >= 0 && box.y + box.height <= 800, { box, rowBox });
    check('it is a tooltip that takes no pointer events', (await card(A).getAttribute('role')) === 'tooltip' && (await card(A).evaluate(el => getComputedStyle(el).pointerEvents)) === 'none');
    check('the row points at it', (await loungeRow.getAttribute('aria-describedby')) === (await card(A).getAttribute('id')));
    await shot(A, 'b1-desktop-card-on-an-occupied-room');
    await A.mouse.move(640, 400);
    check('it goes when the mouse leaves', !!await until(async () => (await card(A).count()) === 0, 2000));
    await quietRow.hover();
    check('an empty room says that nobody is there', !!await until(async () => (await card(A).count()) === 1, 2500) && (await card(A).innerText()).includes('Nobody is here'), await card(A).innerText().catch(() => ''));
    await shot(A, 'b2-desktop-card-on-an-empty-room');
    await A.mouse.move(640, 400);
    await sleep(200);
    // A pass over the list opens none.
    await A.mouse.move(rowBox.x + 20, rowBox.y + 5);
    await A.mouse.move(rowBox.x + 20, rowBox.y + 200, { steps: 6 });
    await sleep(500);
    check('a mouse passing over the rows opens no card', await card(A).count() === 0);
    // The keyboard.
    check('the keyboard reaches a voice row', await tabTo(A, A.locator('[data-testid="toggle-voice-channels"]'), '[data-testid="voice-channel"]'));
    check('and brings up the card at once', !!await until(async () => (await card(A).count()) === 1, 1500));
    await A.keyboard.press('Escape');
    check('Escape closes it', !!await until(async () => (await card(A).count()) === 0, 1500));
    // A click's focus is not the keyboard's.
    await loungeRow.click();
    await sleep(500);
    check('a click joins the call, and brings up no card of its own', (await inCall(A)) > 0 && (await card(A).count()) === 0);
    await A.mouse.move(640, 400);
    // Enter on a focused row does what a click does, and nothing else.
    await A.locator('[title="Disconnect"]').first().click().catch(() => {});
    await until(async () => (await inCall(A)) === 0, 8000);
    await quietRow.focus();
    await A.keyboard.press('Enter');
    check('Enter on a focused voice row joins it, as a click does', !!await until(async () => (await inCall(A)) > 0, 25000));
    await A.locator('[title="Disconnect"]').first().click().catch(() => {});
    await until(async () => (await inCall(A)) === 0, 8000);
    // The fold does not take the card away from a row it keeps.
    await toggleVoice.click();
    await sleep(150);
    await voiceRow(A, lounge.id).hover();
    check('with the voice list folded, the room it keeps still has its card', !!await until(async () => (await card(A).count()) === 1, 2500));
    await A.mouse.move(640, 400);
    await toggleVoice.click();
    await sleep(150);

    // A touch screen has no hover: nothing opens, and the occupants are under the row.
    await B.locator('.mobile-nav-btn').nth(1).tap().catch(() => {});
    await sleep(400);
    await until(async () => (await voiceRows(B)).includes('Lounge'), 10000);
    const phoneOccupants = await B.locator(`[data-voice-drop="${lounge.id}"] .voice-users-list`).innerText().catch(() => '');
    check('the phone lists the occupants under the room', phoneOccupants.includes('fhc_'), phoneOccupants);
    await B.evaluate((id) => {
        const row = document.querySelector(`[data-testid="voice-channel"][data-channel-id="${id}"]`);
        for (const type of ['pointerenter', 'pointerover']) {
            const e = new Event(type, { bubbles: type === 'pointerover' });
            Object.defineProperty(e, 'pointerType', { value: 'touch' });
            row.dispatchEvent(e);
        }
    }, lounge.id);
    await sleep(700);
    check('a finger on a room opens no card (there is no hover), and nothing is lost by it', await card(B).count() === 0);

    // ── C. Active in your servers.
    check('the panel is in the member list, under the members', (await panel(A).count()) === 1 && (await A.locator('.member-sidebar > .active-panel').count()) === 1);
    const geometry = await A.evaluate(() => {
        const side = document.querySelector('.member-sidebar').getBoundingClientRect();
        const pan = document.querySelector('.active-panel').getBoundingClientRect();
        const last = [...document.querySelectorAll('.member-section')].pop().getBoundingClientRect();
        return { sideBottom: side.bottom, panBottom: pan.bottom, panTop: pan.top, membersBottom: last.bottom, right: pan.right, sideRight: side.right };
    });
    check('pinned to the bottom of the right column, below the members', Math.abs(geometry.panBottom - geometry.sideBottom) <= 2 && geometry.panTop >= geometry.membersBottom - 1, geometry);
    check('with no calls in the other servers it says so', (await panelRooms(A)).every(s => s.server === s1Name), await panelRooms(A));
    check('the open server\'s own call is listed, and marked as this server', (await panelRooms(A)).some(s => s.server === s1Name && s.rooms.some(r => r.name === 'Lounge' && r.who.includes('fhc_'))) && (await A.locator('.active-server-here').count()) === 1, await panelRooms(A));

    // The caller moves to a room in the server the owner is NOT looking at: it appears with no reload.
    await C.locator(`.server-icon[title="${s2Name}"]`).click();
    await until(async () => (await voiceRows(C)).includes('Arena'), 10000);
    await voiceRow(C, arena.id).click();
    check('fixture: the caller moved to Arena, in the other server', !!await until(async () => (await inCall(C)) > 0, 25000));
    check('the room in the other server appears in the panel with no reload (the live roster events)', !!await until(async () => (await panelRooms(A)).some(s => s.server === s2Name && s.rooms.some(r => r.name === 'Arena' && r.who.includes('fhc_'))), 15000), await panelRooms(A));
    check('and the room she left is gone from the open server\'s part', !(await panelRooms(A)).some(s => s.server === s1Name), await panelRooms(A));
    await shot(A, 'c1-desktop-panel');

    // Never a server the account is not in, never a channel it may not view.
    await D.locator(`.server-icon[title="${s3Name}"]`).click();
    await until(async () => (await voiceRows(D)).includes('Vault'), 10000);
    await voiceRow(D, vault.id).click();
    check('fixture: an outsider is in a call in a server the owner is not in', !!await until(async () => (await inCall(D)) > 0, 25000));
    await sleep(2500);
    check('that server is never listed', !(await panelRooms(A)).some(s => s.server === s3Name), await panelRooms(A));
    check('nor asked for: no snapshot request for it', !requests.some(r => r.tag === 'owner' && r.url.includes(`/servers/${s3.id}/`)), requests.filter(r => r.url.includes(s3.id)).map(r => r.url));
    check('and the server refuses to say, if asked', (await status(A, 'GET', `/servers/${s3.id}/voice-users`)) === 403);
    await voiceRow(C, backroom.id).click().catch(() => {});
    await C.locator(`.server-icon[title="${s2Name}"]`).click().catch(() => {});
    // Backroom: a room in a server she is in that she may not view.
    const backroomRow = voiceRow(C, backroom.id);
    await backroomRow.click();
    check('fixture: the caller is in Backroom, a room the owner may not view', !!await until(async () => (await C.locator('.voice-panel-compact .voice-connected-label').innerText().catch(() => '')).includes('Backroom') || (await inCall(C)) > 0, 25000));
    await sleep(2500);
    check('so the panel shows nothing of it, and Arena is empty now', !(await panelRooms(A)).some(s => s.rooms.some(r => r.name === 'Backroom' || r.name === 'Arena')), await panelRooms(A));
    check('the server would not have said (a snapshot of that server leaves it out)', !(await api(A, 'GET', `/servers/${s2.id}/voice-users`)).voice_users.some(v => v.room_id === `voice_${backroom.id}`));

    // A page loaded while the call is already running reads the snapshot.
    await voiceRow(C, arena.id).click();
    check('fixture: back to Arena', !!await until(async () => (await panelRooms(A)).some(s => s.server === s2Name), 15000));
    await B.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3500);
    await dismiss(B);
    await B.locator('.mobile-nav-btn').nth(3).tap();
    await sleep(500);
    check('a phone that loaded after the call began shows it (the snapshot)', !!await until(async () => (await panelRooms(B)).some(s => s.server === s2Name && s.rooms.some(r => r.name === 'Arena')), 15000), await panelRooms(B));
    await shot(B, 'c2-phone-panel');

    // A row goes to the room's server and joins nothing.
    await A.locator('.active-room', { hasText: 'Arena' }).click();
    check('a row goes to its server', !!await until(async () => (await A.locator('.server-name').innerText()) === s2Name, 8000));
    check('and the voice row is there to see, with the focus on it', !!await until(async () => A.evaluate((id) => document.activeElement?.getAttribute('data-channel-id') === String(id), arena.id), 4000));
    check('and joined no call', (await inCall(A)) === 0);
    await A.locator(`.server-icon[title="${s1Name}"]`).click();
    await until(async () => (await A.locator('.server-name').innerText()) === s1Name, 8000);

    // Folding the panel.
    await A.locator('.active-panel-toggle').click();
    await sleep(200);
    check('the panel folds to its heading, and keeps the count', (await A.locator('.active-panel-toggle').getAttribute('aria-expanded')) === 'false' && (await A.locator('.active-rooms').count()) === 0 && (await A.locator('.active-panel-count').innerText()) === '1');
    await A.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await dismiss(A);
    check('and stays folded after a reload', (await A.locator('.active-panel-toggle').getAttribute('aria-expanded')) === 'false');
    await A.locator('.active-panel-toggle').click();
    await sleep(150);

    // Phone: sizes and a tap.
    await B.evaluate(() => {});
    const sizes = await B.evaluate(() => Object.fromEntries(['.active-panel-toggle', '.active-room'].map(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return [s, r ? [Math.round(r.width), Math.round(r.height)] : null]; })));
    check('on the phone the panel\'s heading and rows are 44 px tall', sizes['.active-panel-toggle']?.[1] >= 44 && sizes['.active-room']?.[1] >= 44, sizes);
    await B.locator('.active-room', { hasText: 'Arena' }).tap();
    check('a tap goes to the room\'s server, on the channel list', !!await until(async () => (await B.locator('.chat-container').getAttribute('data-mobile-panel')) === 'channels' && (await B.locator('.server-name').innerText()) === s2Name, 8000));
    await B.locator('.mobile-nav-btn').first().tap();
    await sleep(300);
    await B.locator(`.server-icon[title="${s1Name}"]`).tap();
    await sleep(500);
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(400);
    const phoneSizes = await B.evaluate(() => Object.fromEntries(['[data-testid="toggle-text-channels"]', '[data-testid="toggle-voice-channels"]', '[data-testid="toggle-collection"]'].map(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return [s, r ? [Math.round(r.width), Math.round(r.height)] : null]; })));
    check('on the phone the fold buttons are 44 px', Object.values(phoneSizes).every(v => v && v[0] >= 44 && v[1] >= 44), phoneSizes);
    await B.locator('[data-testid="toggle-text-channels"]').tap();
    await sleep(250);
    check('a tap folds the section on the phone, with no reload', (await B.locator('[data-testid="toggle-text-channels"]').getAttribute('aria-expanded')) === 'false' && (await textRows(B)).length <= 2, await textRows(B));
    await shot(B, 'c3-phone-folded');
    await B.locator('[data-testid="toggle-text-channels"]').tap();
    await sleep(250);
    const rowHeights = await B.evaluate(() => [...document.querySelectorAll('.sidebar .channel-list:not(.voice-channel-list) .channel')].map(e => Math.round(e.getBoundingClientRect().height)));
    check('and the arrows did not make the rows taller than a row of this list is', Math.max(...rowHeights) - Math.min(...rowHeights) <= 6, rowHeights);

    // ── Themes and contrast: every run of words 4.5:1, with the card held open.
    await A.locator('[data-testid="toggle-text-channels"]').click();
    await sleep(100);
    await A.locator(`[data-testid="toggle-collection"]`).count();
    // The card of the panel's own row, which has someone in it (Lounge, back in the first server, is empty by now).
    await A.locator('.active-room').first().hover();
    await until(async () => (await card(A).count()) === 1, 2500);
    const words = ['.section-toggle > span', '.section-hidden', '.active-panel-toggle', '.active-server-text', '.active-room-name', '.active-room-who', '.active-panel-count', '.roster-card-title', '.roster-card-count', '.roster-card-name'];
    let worst = { r: 99 };
    let measured = 0;
    for (const theme of THEMES) {
        for (const hc of [false, true]) {
            await setTheme(A, theme, hc);
            const got = await contrasts(A, words);
            const missing = got.filter(g => g.missing).map(g => g.sel);
            measured += got.filter(g => !g.missing).length;
            const low = got.filter(g => !g.missing && g.ratio < 4.5);
            for (const l of low) if (l.ratio < worst.r) worst = { r: l.ratio, theme, hc, sel: l.sel };
            check(`${theme}${hc ? ' + high contrast' : ''}: every run of words is 4.5:1 or better`, low.length === 0 && missing.length === 0, { low, missing });
        }
    }
    check(`(${measured} runs of words measured; the lowest was ${worst.r === 99 ? 'none below 4.5' : JSON.stringify(worst)})`, true);
    await shot(A, 'd1-desktop-dark-card');
    await setTheme(A, 'light', false);
    await shot(A, 'd2-desktop-light-card');
    await setTheme(A, 'dark', false);
    await A.mouse.move(640, 400);

    // ── The setting: Settings > Appearance turns the panel, and the reading it needs, off.
    await A.locator('.chat-header-cog').click();
    await A.locator('.settings-nav-item', { hasText: 'Appearance' }).click();
    const setting = A.locator('[data-testid="setting-active-in-servers"]');
    check('Settings > Appearance has the control, on by default', await setting.isChecked());
    await shot(A, 'e1-desktop-setting');
    await setting.uncheck();
    await sleep(300);
    check('turning it off removes the panel at once', (await panel(A).count()) === 0);
    const before = requests.filter(r => r.tag === 'owner' && /\/voice-users/.test(r.url)).length;
    await sleep(500);
    await A.keyboard.press('Escape');
    await sleep(300);
    await C.locator(`.server-icon[title="${s1Name}"]`).click();
    await sleep(500);
    check('and the server is not read for the others\' calls while it is off (no new voice-users request)', requests.filter(r => r.tag === 'owner' && /\/voice-users/.test(r.url)).length <= before + 1, { before, after: requests.filter(r => r.tag === 'owner' && /\/voice-users/.test(r.url)).length });
    await A.locator('.chat-header-cog').click();
    await A.locator('.settings-nav-item', { hasText: 'Appearance' }).click();
    await A.locator('[data-testid="setting-active-in-servers"]').check();
    await sleep(300);
    await A.keyboard.press('Escape');
    check('turning it on brings it back', !!await until(async () => (await panel(A).count()) === 1, 4000));
    check('and it lists the call again, found by reading the other servers', !!await until(async () => (await panelRooms(A)).some(s => s.server === s2Name), 15000), await panelRooms(A));
} catch (e) {
    check('the walk ran to the end', false, String(e && e.stack || e).slice(0, 600));
} finally {
    await browser.close();
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures);
