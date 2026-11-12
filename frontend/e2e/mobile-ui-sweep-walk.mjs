// LIVE: the phone UI sweep (2026-11-12). The owner's report, "mobile also has a lot of ui issues
// which need fixed and improved", came with no list; an audit of the BUILT bundle as a coarse-pointer
// phone found these, and each section below fails on the bundle from before its fix:
//
//   fields     Every field a phone types into is 16px or more (iOS zooms the page on focus below
//              that): the composer, the sign-in password, the emoji search, Server Settings'
//              description. CONTROL: a field forced to 15px must be caught.
//   nav        The bottom bar takes the theme's colours (it was navy on every theme, Light included)
//              and every label, the chosen tab's too, reads at 4.5:1 on all eight themes with and
//              without high contrast (the chosen one was 3.3-3.5:1 everywhere).
//   settings   A tap on a setting's name or hint toggles its checkbox (the labels named no control,
//              so a phone had a lone 20px box), and a tap on the box still toggles it once.
//   toggle     The chat header's checklist button has no background or border, like the pin button
//              beside it (it was the browser's own grey button on every theme). CONTROL: an
//              unstyled button in the same header must be caught.
//   header     A message from a 32-character name: its time is whole, on one line, inside the
//              message and the window (it was "Today / at / 17:54" down the edge at 390, and off
//              the screen at 360).
//   mention    The @member list spans the composer (it was the text box's width: 164px at 390),
//              inside the window, with 44px rows that a tap lands on, a 32-character name ending
//              in an ellipsis and nothing scrolling sideways.
//   live       On a call, the camera tile of someone streaming keeps its LIVE badge clear of the
//              fullscreen button (both were top-right; on a phone the button covered it). A mesh
//              call between the owner on a desktop (fake camera, a canvas shared) and the phone.
//              In the same call, nothing in the phone's one-row voice bar overlaps anything else
//              and every control in it is on screen and hit. The phone here keeps Playwright's
//              desktop user agent, so it is offered Share Screen like the Android app with its own
//              share or a touch laptop: the share's chevron was a fifth button in a bar sized for
//              four, and the encryption badge slid under Mute.
//
// All at 390x844 and 360x800 with real touches (a tap is what elementFromPoint hits, never
// locator.click(), which scrolls first and false-passes a covered control).
//
// Each check prints PASS/FAIL; the exit code is the number of failures. Screenshots go to OUT.
//
// Prereqs: a THROWAWAY backend (APP_ENV=development, raised AUTH_RATE_LIMIT_PER_SECOND / _BURST, its
// own fresh database, never a real one) at API, and a build against it served at APP (header of
// sidebar-toggles-walk.mjs). It refuses to start unless both are loopback: it creates accounts.
// Silent: --mute-audio. About 2 minutes.
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5472 API=http://127.0.0.1:5471 OUT=<dir> node e2e/mobile-ui-sweep-walk.mjs
//   ONLY=fields,...  runs some sections.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP = (process.env.APP || '').replace(/\/$/, '');
const API = (process.env.API || '').replace(/\/$/, '');
const OUT = process.env.OUT || 'e2e/shots-mobile-ui-sweep';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (s) => !ONLY || ONLY.includes(s);
const isLoopback = (url) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; } };
if (!isLoopback(APP) || !isLoopback(API)) {
    console.error(`this walk creates accounts: APP and API must both be loopback (APP=${APP} API=${API})`);
    process.exit(2);
}
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36).slice(-6);
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
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const PHONES = [[390, 844], [360, 800]];
const phoneCtx = (w, h) => browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

function watch(page, tag) {
    page.on('pageerror', e => { check(`${tag}: no uncaught page error`, false, e.message.slice(0, 200)); });
    page.on('dialog', d => d.dismiss().catch(() => {}));
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
async function signIn(ctx, user, tag, register) {
    const page = await ctx.newPage();
    watch(page, tag);
    await page.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 60000 });
    if (register) await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder(register ? 'Choose a password (min 8 characters)' : 'Enter password').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 60000 });
    await sleep(1500);
    await dismiss(page);
    return page;
}
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

/** A real tap at the middle of what is visible of `loc`; returns whether that point hits it. */
async function tap(page, loc) {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const b = await loc.boundingBox();
    if (!b) throw new Error('nothing to tap');
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    const hits = await loc.evaluate((el, [x, y]) => { const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h)); }, [x, y]);
    await page.touchscreen.tap(x, y);
    return hits;
}
const nav = async (page, label) => { await tap(page, page.locator('.mobile-nav-btn', { hasText: label }).first()); await sleep(450); };
const COMPOSER = 'form.message-form textarea';
const rowCount = (page) => page.evaluate(() => document.querySelectorAll('.messages-container > .message').length);
const acked = (page) => page.evaluate(() => !document.querySelector('.messages-container > .message[id^="msg-local_"]'));
async function say(page, text) {
    const before = await rowCount(page);
    const box = page.locator(COMPOSER);
    await box.fill(text);
    await box.press('Enter');
    return !!await until(async () => (await rowCount(page)) > before && await acked(page), 15000);
}
const fontPx = (loc) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

try {
    // ── Fixture: an owner on a desktop, a phone account with a name as long as one can be (32).
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // The owner's "screen" is a canvas (getDisplayMedia replaced, as an automation would).
    await desktop.addInitScript(() => {
        navigator.mediaDevices.getDisplayMedia = async () => {
            const c = document.createElement('canvas');
            c.width = 640; c.height = 360;
            const g = c.getContext('2d');
            let i = 0;
            setInterval(() => { g.fillStyle = `hsl(${(i += 4) % 360},60%,40%)`; g.fillRect(0, 0, 640, 360); }, 50);
            return c.captureStream(20);
        };
    });
    const ownerName = 'swo_' + stamp;
    const phoneName = ('phone_with_a_long_name_' + stamp + '_xxxxxxxx').slice(0, 32);
    const O = await signIn(desktop, ownerName, 'owner', true);
    const srv = await api(O, 'POST', '/servers', { name: 'Sweep ' + stamp });
    const mk = (name, type) => api(O, 'POST', `/servers/${srv.id}/channels`, { name, channel_type: type });
    const general = await mk('general', 0);
    const lounge = await mk('Lounge', 1);
    const inv = await api(O, 'POST', `/servers/${srv.id}/invites`, {});
    let ownerLive = false;
    if (want('live')) {
        // The owner in Lounge with a camera on and sharing: the tile the phone looks at.
        await O.reload({ waitUntil: 'domcontentloaded' });
        await sleep(2500);
        await dismiss(O);
        await O.locator(`.server-icon[data-server-id="${srv.id}"]`).first().click();
        await sleep(1000);
        await O.locator(`[data-testid="voice-channel"][data-channel-id="${lounge.id}"]`).click();
        const inCall = await until(() => O.locator('[data-testid="voice-connected"]').count(), 20000);
        await O.locator('button[title="Turn On Camera"]').first().click().catch(() => {});
        await sleep(1500);
        await O.locator('[data-testid="voice-share-screen"]').click().catch(() => {});
        await sleep(1200);
        const go = O.getByRole('button', { name: /^(Share|Go Live|Start)/ });
        if (await go.count()) await go.first().click().catch(() => {});
        ownerLive = !!inCall && !!await until(() => O.locator('[data-testid="voice-stop-share"]').count(), 15000);
        check('live: the owner is in the call, sharing, with the camera on', ownerLive);
    }

    for (const [w, h] of PHONES) {
        const size = `${w}x${h}`;
        const ctx = await phoneCtx(w, h);
        const first = w === PHONES[0][0];
        const P = await signIn(ctx, phoneName, `phone ${size}`, first);
        if (first) {
            await api(P, 'POST', `/invites/${inv.code}/join`);
            await api(P, 'POST', '/servers', { name: 'Phone own ' + stamp });
            await P.reload({ waitUntil: 'domcontentloaded' });
            await sleep(2500);
            await dismiss(P);
        }
        await P.addStyleTag({ content: '*, *::after, *::before { transition: none !important; animation: none !important; }' });
        const openServer = async (id) => { await nav(P, 'Servers'); await tap(P, P.locator(`.server-icon[data-server-id="${id}"]`).first()); await sleep(1000); };
        const openChannel = async (name) => {
            await nav(P, 'Channels');
            await tap(P, P.locator('.sidebar .channel-list .channel').filter({ has: P.locator(`.channel-name:text-is("${name}")`) }).first());
            await sleep(1200);
        };
        await openServer(srv.id);
        await openChannel(general.name);

        // ── fields
        if (want('fields')) {
            const composer = P.locator(COMPOSER);
            check(`${size} fields: the composer is 16px or more`, (await fontPx(composer)) >= 16, `${await fontPx(composer)}px`);
            // CONTROL: the same measure must catch a field forced under 16px.
            await composer.evaluate((el) => { el.style.setProperty('font-size', '15px', 'important'); });
            check(`${size} fields: CONTROL - a composer forced to 15px is caught`, (await fontPx(composer)) < 16);
            await composer.evaluate((el) => { el.style.removeProperty('font-size'); });
            await tap(P, P.locator('form.message-form .emoji-toggle'));
            const search = P.locator('.emoji-picker .emoji-search input');
            check(`${size} fields: the emoji picker opened`, !!await until(() => search.count(), 4000));
            if (await search.count()) check(`${size} fields: the emoji search is 16px or more`, (await fontPx(search)) >= 16, `${await fontPx(search)}px`);
            await tap(P, P.locator('form.message-form .emoji-toggle'));
            if (first) {
                const own = (await api(P, 'GET', '/servers')).find((s) => s.name === 'Phone own ' + stamp);
                await openServer(own.id);
                await nav(P, 'Channels');
                await tap(P, P.locator('.server-settings-btn'));
                const desc = P.locator('.server-settings-container textarea').first();
                check(`${size} fields: Server Settings opened`, !!await until(() => desc.count(), 6000));
                if (await desc.count()) check(`${size} fields: Server Settings' description is 16px or more`, (await fontPx(desc)) >= 16, `${await fontPx(desc)}px`);
                await shot(P, `fields-server-settings-${size}`);
                await tap(P, P.locator('.server-settings-container .close-btn').first()).catch(() => {});
                await sleep(400);
                await openServer(srv.id);
                await openChannel(general.name);
            }
            // The sign-in form, in a context that is not signed in.
            const fresh = await phoneCtx(w, h);
            const L = await fresh.newPage();
            await L.goto(APP + '/login', { waitUntil: 'domcontentloaded' });
            await L.getByPlaceholder('Enter username').waitFor({ timeout: 60000 });
            for (const [label, sel] of [['username', '#username'], ['password', '#password']]) {
                const f = L.locator(sel);
                check(`${size} fields: the sign-in ${label} is 16px or more`, (await fontPx(f)) >= 16, `${await fontPx(f)}px`);
            }
            await fresh.close();
        }

        // ── nav: the bottom bar takes the theme, and every label reads at 4.5:1
        if (want('nav')) {
            const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
            const bad = [];
            let lightBar = null;
            for (const theme of THEMES) for (const hc of [false, true]) {
                await P.evaluate(([theme, hc]) => {
                    document.documentElement.setAttribute('data-theme', theme);
                    document.documentElement.setAttribute('data-contrast', hc ? 'high' : 'normal');
                }, [theme, hc]);
                await sleep(120);
                const r = await P.evaluate(() => {
                    const c = document.createElement('canvas'); c.width = c.height = 1;
                    const g = c.getContext('2d', { willReadFrequently: true });
                    const rgba = (s) => { g.clearRect(0, 0, 1, 1); g.fillStyle = 'rgba(0,0,0,0)'; g.fillStyle = s; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
                    const lin = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
                    const lum = ([r, gr, b]) => 0.2126 * lin(r) + 0.7152 * lin(gr) + 0.0722 * lin(b);
                    const ratio = (x, y) => { const [h, l] = [lum(x), lum(y)].sort((p, q) => q - p); return (h + 0.05) / (l + 0.05); };
                    const over = (t, u) => [0, 1, 2].map((i) => t[i] * t[3] + u[i] * (1 - t[3]));
                    const nav = document.querySelector('.mobile-bottom-nav');
                    const cs = getComputedStyle(nav);
                    // What the bar paints: its colour, or every stop of a gradient over the page.
                    const page = rgba(getComputedStyle(document.body).backgroundColor);
                    const stops = (cs.backgroundImage.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}\b/gi) || []).map(rgba);
                    const fills = (stops.length ? stops : [rgba(cs.backgroundColor)]).map((s) => over(s, page[3] ? page : [255, 255, 255, 1]));
                    const labels = [...nav.querySelectorAll('.mobile-nav-btn')].map((b) => {
                        const col = rgba(getComputedStyle(b.querySelector('.nav-label')).color);
                        return { label: b.textContent.trim(), active: b.classList.contains('active'), worst: Math.min(...fills.map((f) => ratio(over(col, f), f))) };
                    });
                    return { barLum: Math.max(...fills.map(lum)), labels };
                });
                for (const l of r.labels) if (l.worst < 4.5) bad.push(`${theme}${hc ? '+hc' : ''} ${l.label}${l.active ? ' (chosen)' : ''} ${l.worst.toFixed(2)}`);
                if (theme === 'light' && !hc) { lightBar = r.barLum; await shot(P, `nav-light-${size}`); }
            }
            await P.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.setAttribute('data-contrast', 'normal'); });
            check(`${size} nav: every label (the chosen tab's too) reads at 4.5:1 on all eight themes, with and without high contrast`, bad.length === 0, bad.slice(0, 8));
            check(`${size} nav: on Light the bar is light, like the rest of the app`, lightBar !== null && lightBar > 0.5, { luminance: lightBar });
        }

        // ── settings: a tap on a setting's name toggles its checkbox
        if (want('settings')) {
            await nav(P, 'Channels');
            await tap(P, P.locator('.user-action-btn[title="Settings"]').first());
            const tab = P.locator('.settings-nav-item', { hasText: 'Appearance' }).first();
            check(`${size} settings: Settings opened`, !!await until(() => tab.count(), 6000));
            await tap(P, tab);
            await sleep(400);
            const rowOf = (name) => P.locator('.settings-option').filter({ has: P.locator(`label:text-is("${name}")`) }).first();
            const compact = rowOf('Compact Mode');
            const box = compact.locator('input[type="checkbox"]');
            const before = await box.isChecked();
            const boxSize = await box.boundingBox();
            check(`${size} settings: the checkbox alone is under 44px (why the row must answer)`, !!boxSize && Math.min(boxSize.width, boxSize.height) < 44, boxSize);
            check(`${size} settings: a tap on "Compact Mode" lands on its name`, await tap(P, compact.locator('label')));
            await sleep(300);
            const afterName = await box.isChecked();
            check(`${size} settings: ...and toggles it`, afterName !== before);
            await tap(P, compact.locator('.option-hint'));
            await sleep(300);
            check(`${size} settings: a tap on its hint toggles it again`, (await box.isChecked()) !== afterName);
            if ((await box.isChecked()) !== before) { await tap(P, box); await sleep(300); }
            await tap(P, box);
            await sleep(300);
            check(`${size} settings: a tap on the box itself toggles it once`, (await box.isChecked()) !== before);
            await tap(P, box);
            await sleep(300);
            check(`${size} settings: the setting is back as it was`, (await box.isChecked()) === before);
            await shot(P, `settings-${size}`);
            await tap(P, P.locator('.settings-close').first());
            await sleep(400);
            await nav(P, 'Chat');
        }

        // ── toggle: the chat header's checklist button is drawn like the pin button beside it
        if (want('toggle')) {
            const t = await P.evaluate(() => {
                const look = (el) => { const cs = getComputedStyle(el); return { bg: cs.backgroundColor, border: cs.borderTopStyle }; };
                const list = document.querySelector('.chat-header .checklist-toggle-btn');
                const pins = document.querySelector('.chat-header .pins-toggle-btn');
                // CONTROL: a button nothing styles, in the same header, is the browser's grey one.
                const bare = document.createElement('button');
                document.querySelector('.chat-header').appendChild(bare);
                const control = look(bare);
                bare.remove();
                return { list: list && look(list), pins: pins && look(pins), control };
            });
            const plain = (l) => !!l && /rgba\(0, 0, 0, 0\)|transparent/.test(l.bg) && l.border === 'none';
            check(`${size} toggle: the checklist button is drawn like the pin button (no background, no border)`, plain(t.list) && t.list.bg === t.pins.bg, t);
            check(`${size} toggle: CONTROL - an unstyled button in the header is caught`, !plain(t.control), t.control);
            check(`${size} toggle: a tap lands on the checklist button`, await tap(P, P.locator('.chat-header .checklist-toggle-btn')));
            await sleep(400);
            await tap(P, P.locator('.chat-header .checklist-toggle-btn')).catch(() => {});
            await sleep(300);
            await shot(P, `toggle-${size}`);
        }

        // ── header: a message from the 32-character name
        if (want('header')) {
            const posted = await say(P, `Header check ${size}`);
            check(`${size} header: posted a message`, posted);
            await sleep(500);
            const h = await P.evaluate(() => {
                const rows = [...document.querySelectorAll('.messages-container > .message')].filter((m) => m.querySelector('.message-header'));
                const row = rows[rows.length - 1];
                const body = row.querySelector('.message-body') || row;
                const time = row.querySelector('.message-header .message-time');
                const author = row.querySelector('.message-header .message-author');
                const br = body.getBoundingClientRect();
                const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; };
                const tr = time.getBoundingClientRect(), ar = author.getBoundingClientRect();
                return { vw: innerWidth, body: { l: br.left, r: br.right }, time: { l: tr.left, r: tr.right, lines: lines(time), text: time.textContent }, author: { r: ar.right, text: author.textContent } };
            });
            check(`${size} header: the time is on one line`, h.time.lines === 1, h.time);
            check(`${size} header: the time is inside the window and the message`, h.time.r <= h.vw && h.time.r <= h.body.r + 1 && h.time.l >= h.body.l - 1, h);
            check(`${size} header: the name is inside the message`, h.author.r <= h.body.r + 1, h);
            await shot(P, `header-${size}`);
        }

        // ── mention: the @member list
        if (want('mention')) {
            const box = P.locator(COMPOSER);
            await tap(P, box);
            await box.fill('@' + phoneName.slice(0, 6));
            const pop = P.locator('.composer-autocomplete');
            check(`${size} mention: the list opens`, !!await until(() => pop.count(), 4000));
            if (await pop.count()) {
                await shot(P, `mention-${size}`);
                const m = await P.evaluate(() => {
                    const pop = document.querySelector('.composer-autocomplete');
                    const form = document.querySelector('form.message-form');
                    const pr = pop.getBoundingClientRect(), fr = form.getBoundingClientRect();
                    const items = [...pop.querySelectorAll('.autocomplete-item')].map((i) => {
                        const r = i.getBoundingClientRect();
                        return {
                            h: r.height,
                            over: i.scrollWidth > i.clientWidth + 1,
                            names: [...i.querySelectorAll('.ac-name, .ac-sub')].map((n) => ({ cut: n.scrollWidth > n.clientWidth + 1, ellipsis: getComputedStyle(n).textOverflow === 'ellipsis' && getComputedStyle(n).overflow !== 'visible' })),
                        };
                    });
                    return { pop: { l: pr.left, r: pr.right, t: pr.top, b: pr.bottom, w: pr.width, sw: pop.scrollWidth, cw: pop.clientWidth }, form: { t: fr.top, w: fr.width }, vw: innerWidth, items };
                });
                check(`${size} mention: the list is as wide as the composer`, m.pop.w >= m.form.w - 24, { list: Math.round(m.pop.w), composer: Math.round(m.form.w) });
                check(`${size} mention: the list is inside the window and above the composer`, m.pop.l >= 0 && m.pop.r <= m.vw && m.pop.t >= 0 && m.pop.b <= m.form.t + 1, m.pop);
                check(`${size} mention: nothing in it scrolls sideways`, m.pop.sw <= m.pop.cw + 1 && m.items.every((i) => !i.over), { list: [m.pop.sw, m.pop.cw], rows: m.items.map((i) => i.over) });
                check(`${size} mention: a name too long for its row ends in an ellipsis`, m.items.length > 0 && m.items.every((i) => i.names.every((n) => !n.cut || n.ellipsis)), m.items);
                check(`${size} mention: every row is 44px tall`, m.items.length > 0 && m.items.every((i) => i.h >= 43.5), m.items.map((i) => Math.round(i.h)));
                const row = pop.locator('.autocomplete-item').first();
                check(`${size} mention: a tap on the row lands on it`, await tap(P, row));
                await sleep(300);
                const v = await box.inputValue();
                check(`${size} mention: the tap put the name in the box`, v.startsWith('@' + phoneName), v);
            }
            await box.fill('');
        }

        // ── live: a streaming member's camera tile keeps its LIVE badge clear of the fullscreen button
        if (want('live') && ownerLive) {
            await nav(P, 'Channels');
            await tap(P, P.locator(`[data-testid="voice-channel"][data-channel-id="${lounge.id}"]`));
            check(`${size} live: the phone joined the call`, !!await until(() => P.locator('[data-testid="voice-connected"]').count(), 20000));
            // The room's row again, once in it, opens the call's view.
            await nav(P, 'Channels');
            await tap(P, P.locator(`[data-testid="voice-channel"][data-channel-id="${lounge.id}"]`));
            await sleep(1200);
            const tile = P.locator('.voice-stage-tile').filter({ has: P.locator('.vs-live-badge') }).filter({ has: P.locator('.vs-fullscreen-btn') }).first();
            check(`${size} live: the owner's tile has the LIVE badge and the fullscreen button`, !!await until(() => tile.count(), 20000));
            if (await tile.count()) {
                await sleep(800);
                const m = await tile.evaluate((t) => {
                    const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
                    const badge = t.querySelector('.vs-live-badge'), btn = t.querySelector('.vs-fullscreen-btn');
                    const a = box(badge), b = box(btn);
                    const overlap = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
                    const hits = (el, r) => { const h = document.elementFromPoint((r.l + r.r) / 2, (r.t + r.b) / 2); return !!h && (h === el || el.contains(h)); };
                    return { badge: a, button: b, overlap, badgeSeen: hits(badge, a), buttonHit: hits(btn, b), tile: box(t) };
                });
                check(`${size} live: the LIVE badge and the fullscreen button do not overlap`, m.overlap === 0, m);
                check(`${size} live: the middle of the badge is the badge, not the button over it`, m.badgeSeen, m);
                check(`${size} live: the button is what a tap on it hits, and 44px`, m.buttonHit && (m.button.r - m.button.l) >= 43.5 && (m.button.b - m.button.t) >= 43.5, m.button);
                check(`${size} live: the badge is inside the tile`, m.badge.l >= m.tile.l && m.badge.r <= m.tile.r, m);
                await shot(P, `live-${size}`);
            }
            // The phone's own voice bar in that call: every control and the encryption badge on
            // screen, apart, and what a tap at its middle hits.
            const bar = await P.evaluate(() => {
                const panel = document.querySelector('.voice-panel-compact');
                if (!panel) return null;
                const els = [...panel.querySelectorAll('button, [role="button"], .voice-e2ee, .voice-channel-name')]
                    .filter((e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 1 && r.height > 1; })
                    .filter((e, _i, all) => !all.some((o) => o !== e && o.contains(e)));
                const items = els.map((e) => {
                    const r = e.getBoundingClientRect();
                    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    return { what: (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || e.className).trim().slice(0, 40), l: r.left, r: r.right, t: r.top, b: r.bottom, hit: !!h && (h === e || e.contains(h)) };
                });
                const overlaps = [];
                for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
                    const a = items[i], b = items[j];
                    const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l), oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
                    if (ox > 0.5 && oy > 0.5) overlaps.push(`${a.what} x ${b.what} (${Math.round(ox)}px)`);
                }
                return { vw: innerWidth, items, overlaps };
            });
            if (bar) {
                check(`${size} live: nothing in the phone's voice bar overlaps anything else in it`, bar.overlaps.length === 0, { overlaps: bar.overlaps, items: bar.items.map((i) => `${i.what} ${Math.round(i.l)}-${Math.round(i.r)}`) });
                check(`${size} live: every control in the voice bar is on screen and what a tap at its middle hits`, bar.items.every((i) => i.l >= 0 && i.r <= bar.vw && i.hit), bar.items.filter((i) => !(i.l >= 0 && i.r <= bar.vw && i.hit)));
            }
            await tap(P, P.locator('[data-testid="voice-leave"]').first()).catch(() => {});
            await sleep(800);
        }

        await ctx.close();
    }
} catch (e) {
    check('the walk ran to the end', false, String(e?.stack || e).slice(0, 600));
} finally {
    await browser.close();
}
console.log(`\n${failures} failure(s)`);
process.exit(failures);
