// LIVE: the way back to a minimised remote-control session (components/DeviceStageReturn.tsx), in the
// REAL app (the whole Chat, through a real backend) with a session on screen and a stand-in PC.
//
// The owner's report (2026-11-22, the Android app, a channel with the soft keyboard up): the blue
// "Return to remote device (ds7babefb5bd2042d38d9c)" pill was drawn right over the message box,
// "Blocks textbox", and named the session by its raw id. It was fixed 20 px from the bottom-right
// corner at z 10000, over whatever was there. NEGATIVE CONTROL, this walk against a build from before
// the fix: 70 of the 97 checks in desktop, banner, phone and button fail. At 390x844 with the keyboard up it covered 100% of the message
// box and of Send; with it down, 53% of the bottom bar, and every tab but Servers (at 360x800 every
// one) was the pill under a tap, so a tap on Chat, Channels or Devices brought the stage back instead;
// sideways 11-22% of the box and 14-82% of Send; on a 1280x800 desktop 100% of Send and nearly half the
// emoji button (33% of Send with a grown message box), and at 900x700, where the message box runs to
// the window's edge, 65% of the box itself; the Devices and Friends views ran on under it. Each check
// below fails there.
//
//   desktop   1280x800 and 900x700, a mouse: in a channel (the member list beside it at 1280, none at
//             900), with a grown message box, in a call (the voice panel in the channel list), in the
//             Devices view and the Friends view: the strip is on screen and what a press at its middle
//             hits, and nothing it should leave alone is covered: not one point of the message box,
//             Send, the emoji button, the channel list's profile bar, the voice panel or the member
//             list's column has the strip on top (elementFromPoint), and no box of those overlaps it;
//             the chat's column (.chat-container) ends where the strip begins; the views end above it.
//   banner    1280x800 with the desktop app's update banner up, the sign-in-screen service's, and both
//             (their markup on the page with their own classes: the real stylesheet pads `.app` down
//             52, 66 and 132 px under them), at rest and with a grown message box, and once more with
//             them gone: the same checks as the desktop's. NEGATIVE CONTROL, the branch's first
//             reservation (`.chat-container` fixed at the window less the strip, which the padded
//             column shrank back to its own height): 12 of the section's 25 checks fail, the chat's
//             column ending at the window's foot (800) under the strip (759), half of the message box,
//             Send and the emoji button and two thirds of the profile bar under it.
//   phone     390x844 and 360x800 upright, 844x390 sideways, real touches, as the Android app: with the
//             keyboard down the strip sits between the message box and the bottom bar, every bottom-bar
//             tab and the message box and Send uncovered, and a real tap on Chat lands on Chat; the
//             Channels, Members, Devices and Tasks panels (the channel list's profile bar too) end above
//             it; with the soft keyboard up (the WebView resized and <html data-keyboard-up>, as the
//             Android app gets it) the strip steps aside, the message box comes down to the keyboard
//             and nothing covers it or Send; down again, it is back. In a voice call the strip sits
//             between the message box and the voice bar and covers none of the bar's controls, and with
//             the keyboard up the box comes down to the voice bar.
//   button    It is a <button>: its accessible name is "Return to <the PC's name>" ("Return to the remote
//             computer" with no name), no session id is on the page, Tab reaches it on the desktop and
//             Enter and Space each bring the stage back; 44 px tall on a touchscreen; its words 4.5:1 on
//             all eight themes with and without high contrast (the colour read back from the page, every
//             CSS colour form); and its pulse (the dot's, now) stops for prefers-reduced-motion, while
//             the button itself never scales (the old pill grew to 1.05 over its neighbours).
//   dialogs   The strip is under every dialog the app opens. 390x844 as the Android app, keyboard down,
//             each opened as a person does it with its scroll areas run to their end: the member profile
//             sheet, Edit Channel (from the channel's menu), Create Channel, Settings and Server Settings,
//             and in a call (the strip higher, above the voice bar) the sheet and Settings again: every
//             point where the dialog and the strip overlap is the dialog's (elementFromPoint), every
//             control of the dialog in the strip's place is what a tap there hits, a real tap on the
//             sheet's foot over the strip stays in the sheet, and a real tap on Create Channel's backdrop
//             over the strip closes it with the session still put away; on a 1280x800 desktop Settings
//             and Create Channel the same way, with a CONTROL (the strip forced over Settings must be
//             caught). In the phone layout `.chat-container` is fixed, so a stacking context holding all
//             of Chat's dialogs, and the strip drawn beside it at z 250 was over every one of them.
//             NEGATIVE CONTROL, the branch's strip before it was drawn inside Chat's root (chatRoot.ts):
//             10 of the section's 36 checks fail, 64 of 64 points on the strip over each phone dialog, a
//             tap on the profile sheet's foot or on Create Channel's backdrop bringing the stage back,
//             Settings' Delete Account under it.
//
// It CANNOT see: a real phone's keyboard (the Android app's is played as mobile-ui-sweep-walk.mjs plays
// it; an iPhone's, a shrunk visual viewport that keyboardUp.ts reads into the same attribute, is not
// walked), the own-call banner beside the strip (it needs the account in a call on another device; its
// rules mirror the voice bar's), or a docked stream player (it is inside the chat panel, which ends
// above the strip).
//
// Each check prints PASS/FAIL; the exit code is the number of failures. Screenshots go to OUT.
//
// Prereqs: a THROWAWAY backend (APP_ENV=development, raised AUTH_RATE_LIMIT_PER_SECOND / _BURST, its own
// fresh database, never a real one, CORS_ORIGINS=<APP>) at API, and THE APP BUILT WITH THE STAND-IN
// SESSION (vite.appstage.config.ts: the real app, the stage's half of the session layer played by
// e2e/device-stage/fakeSession.ts, started by `window.__appStage.start(name)`), served at APP:
//   VITE_API_URL=$API PUCA_ALLOW_LOCAL_BUILD=1 npx vite build --config vite.appstage.config.ts
//   DIST=e2e-artifacts/app-stage-dist PORT=<port> node e2e/serve-dist.mjs
// It refuses to start unless both are loopback: it creates accounts. Silent: --mute-audio and fake
// media devices; the voice call is mesh, no LiveKit. About 3 minutes.
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5492 API=http://127.0.0.1:5491 OUT=<dir> node e2e/return-pill-live.mjs
//   ONLY=desktop,banner,phone,button,dialogs  runs some sections.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP = (process.env.APP || '').replace(/\/$/, '');
const API = (process.env.API || '').replace(/\/$/, '');
const OUT = process.env.OUT || 'e2e-artifacts/return-pill-shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (s) => !ONLY || ONLY.includes(s);
const isLoopback = (url) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; } };
if (!isLoopback(APP) || !isLoopback(API)) {
    console.error(`this walk creates accounts: APP and API must both be loopback (APP=${APP} API=${API})`);
    process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36).slice(-6);
const PC = 'Office PC';
/** The stand-in's session id (fakeSession.ts): it must never be on the page. */
const SESSION_ID = 'ds-harness';

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
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };

const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

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
    page.on('pageerror', e => { check(`${tag}: no uncaught page error`, false, e.message.slice(0, 200)); });
    page.on('dialog', d => d.dismiss().catch(() => {}));
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

/** A real tap at the middle of `loc`; returns what that point hit before the tap. */
async function tap(page, loc) {
    const b = await loc.boundingBox();
    if (!b) throw new Error('nothing to tap');
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    const r = await loc.evaluate((el, [x, y]) => {
        const h = document.elementFromPoint(x, y);
        return { hits: !!h && (h === el || el.contains(h)), what: h ? `${h.tagName.toLowerCase()}.${(h.getAttribute('class') || '').split(' ').slice(0, 2).join('.')}` : 'nothing' };
    }, [x, y]);
    await page.touchscreen.tap(x, y);
    return r;
}

/**
 * What the way back covers. The strip is the fixed element (the old pill was its own); for each named
 * surface on screen: the share of a 12x6 grid of points over it where elementFromPoint lands on the
 * strip (what is on top there), and whether its box overlaps the strip's at all.
 */
const SURFACES = {
    composer: 'form.message-form textarea',
    send: 'form.message-form button[type="submit"]',
    emoji: 'form.message-form .emoji-toggle',
    form: 'form.message-form',
    nav: '.mobile-bottom-nav',
    voice: '.voice-panel-compact',
    profile: '.sidebar .user-profile-bar',
    members: '.member-sidebar',
};
const measure = (page, extra = {}) => page.evaluate(({ SURFACES, extra }) => {
    const strip = document.querySelector('.device-stage-minimized-strip') || document.querySelector('.device-stage-minimized');
    const shown = (el) => {
        if (!el) return false;
        const cs = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
    };
    const box = (b) => ({ x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) });
    const out = { vw: innerWidth, vh: innerHeight, keyboardUp: 'keyboardUp' in document.documentElement.dataset, strip: null, on: {} };
    // Not on screen (stepped aside for the keyboard): it covers nothing, and the surfaces are still read.
    const s = shown(strip) ? strip.getBoundingClientRect() : null;
    if (s) out.strip = box(s);
    const all = { ...SURFACES, ...extra };
    for (const [k, sel] of Object.entries(all)) {
        const el = [...document.querySelectorAll(sel)].find(shown);
        if (!el) { out.on[k] = null; continue; }
        const b = el.getBoundingClientRect();
        if (!s) { out.on[k] = { box: box(b), coveredPct: 0, overlapPx: 0 }; continue; }
        let n = 0, hit = 0;
        for (let i = 0; i < 12; i++) for (let j = 0; j < 6; j++) {
            const x = b.left + (i + 0.5) * b.width / 12, y = b.top + (j + 0.5) * b.height / 6;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
            n++;
            const h = document.elementFromPoint(x, y);
            if (h && (h === strip || strip.contains(h))) hit++;
        }
        const overlap = Math.max(0, Math.min(b.right, s.right) - Math.max(b.left, s.left)) * Math.max(0, Math.min(b.bottom, s.bottom) - Math.max(b.top, s.top));
        out.on[k] = { box: box(b), coveredPct: n ? Math.round(100 * hit / n) : 0, overlapPx: Math.round(overlap) };
    }
    return out;
}, { SURFACES, extra });
/** Every named surface that is on screen is neither under the strip nor touching it. */
function clear(m, names) {
    const bad = [];
    for (const k of names) {
        const r = m.on[k];
        if (r === undefined || r === null) continue;
        if (r.coveredPct > 0 || r.overlapPx > 0) bad.push(`${k}: ${r.coveredPct}% covered, ${r.overlapPx} px² overlap`);
    }
    return bad;
}
const present = (m, names) => names.filter(k => m.on[k]);
/** The strip is on screen, inside the window, and what a press at its button's middle lands on. */
const reachable = (page) => page.evaluate(() => {
    const b = document.querySelector('.device-stage-minimized');
    if (!b) return { ok: false, why: 'no button' };
    const r = b.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const h = document.elementFromPoint(x, y);
    const inside = r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
    return { ok: inside && !!h && (h === b || b.contains(h)), inside, hit: h ? `${h.tagName.toLowerCase()}.${(h.getAttribute('class') || '').split(' ')[0]}` : 'nothing', h: Math.round(r.height) };
});

/** The Android app's soft keyboard (e2e/mobile-ui-sweep-walk.mjs's softKeyboard): the WebView is
 *  resized to above it and the app's keyboard event holds <html data-keyboard-up> while it is up. */
async function softKeyboard(page, w, h, up) {
    if (up) {
        await page.locator('form.message-form textarea').focus();
        await page.setViewportSize({ width: w, height: h - (w < h ? 330 : 200) });
        await page.evaluate(() => {
            const root = document.documentElement;
            window.__kb = true;
            root.dataset.keyboardUp = '';
            window.__kbHold ??= new MutationObserver(() => { if (window.__kb && !('keyboardUp' in root.dataset)) root.dataset.keyboardUp = ''; });
            window.__kbHold.observe(root, { attributes: true, attributeFilter: ['data-keyboard-up'] });
        });
    } else {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate(() => { window.__kb = false; delete document.documentElement.dataset.keyboardUp; });
    }
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await sleep(250);
}

// ── the account, a server with a text channel and a voice room ───────────────────────────────────
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const owner = 'rp_' + stamp;
const O = await signIn(desktop, owner, 'desktop', true);
const srv = await api(O, 'POST', '/servers', { name: 'Return ' + stamp });
await api(O, 'POST', `/servers/${srv.id}/channels`, { name: 'general', channel_type: 0 });
const lounge = await api(O, 'POST', `/servers/${srv.id}/channels`, { name: 'Lounge', channel_type: 1 });
await O.reload({ waitUntil: 'domcontentloaded' });
await sleep(2500);
await dismiss(O);
await O.locator(`.server-icon[data-server-id="${srv.id}"]`).first().click();
await sleep(1000);
const chanRow = (page) => page.locator('.sidebar .channel-list .channel').filter({ has: page.locator('.channel-name:text-is("general")') }).first();
await chanRow(O).click();
await sleep(800);
for (let i = 0; i < 14; i++) {
    await O.locator('form.message-form textarea').fill(`History ${i}: a line or two so the list has rows${' and more words'.repeat(i % 5)}`);
    await O.locator('form.message-form textarea').press('Enter');
    await sleep(200);
}

/** The session comes up and the stage is minimised as a person does it. */
async function startAndMinimise(page, phone, name = PC) {
    await page.evaluate((n) => window.__appStage.start(n), name);
    await until(() => page.locator('.device-stage').count(), 10000);
    if (phone) await tap(page, page.locator('.device-stage-mobile-btn[title="Chat"]'));
    else {
        await page.locator('button[aria-label="More"]').click();
        await page.locator('.dsb-item', { hasText: 'Back to Púca (keep the session)' }).click();
    }
    await until(() => page.locator('.device-stage-minimized').count(), 5000);
    await sleep(400);
}

// ── desktop ─────────────────────────────────────────────────────────────────────────────────────
const DESK = ['composer', 'send', 'emoji', 'form', 'profile', 'voice', 'members'];
/** The chat's column (`.chat-container`) and the strip: the column must end where the strip begins. */
const column = (page) => page.evaluate(() => {
    const c = document.querySelector('.chat-container');
    const s = document.querySelector('.device-stage-minimized-strip');
    if (!c || !s) return { column: !!c, strip: !!s };
    const cb = c.getBoundingClientRect(), sb = s.getBoundingClientRect();
    return { column: true, strip: true, top: Math.round(cb.top), bottom: Math.round(cb.bottom), stripTop: Math.round(sb.top), appPadTop: getComputedStyle(document.querySelector('.app')).paddingTop };
});
const deskCheck = async (tag) => {
    const m = await measure(O);
    const r = await reachable(O);
    check(`desktop ${tag}: the way back is on screen and a press at its middle lands on it`, !!m.strip && r.ok, { strip: m.strip, ...r });
    const bad = clear(m, DESK);
    check(`desktop ${tag}: it covers none of ${present(m, DESK).join(', ')}`, !!m.strip && present(m, ['composer', 'send']).length === 2 && bad.length === 0, bad.length ? bad : m.on.send);
    const col = await column(O);
    check(`desktop ${tag}: the chat's column ends where the strip begins`, col.column && col.strip && Math.abs(col.bottom - col.stripTop) <= 1, col);
    return m;
};
if (want('desktop') || want('button') || want('banner')) await startAndMinimise(O, false);
if (want('desktop')) {
    await deskCheck('1280x800, in a channel, the member list beside it');
    await shot(O, 'desktop-channel');
    await O.locator('form.message-form textarea').fill('a line\n'.repeat(7));
    await sleep(300);
    await deskCheck('1280x800, a grown message box');
    await O.locator('form.message-form textarea').fill('');
    // Narrower than the member list's breakpoint: the message box runs to the window's right edge,
    // where the old corner pill sat on the text box itself.
    await O.setViewportSize({ width: 900, height: 700 });
    await sleep(400);
    const narrow = await deskCheck('900x700, no member list');
    console.log(`INFO  900x700: member list ${narrow.on.members ? 'shown' : 'not shown'}, message box ends at x=${narrow.on.form ? narrow.on.form.box.x + narrow.on.form.box.w : '?'}`);
    await shot(O, 'desktop-900');
    await O.setViewportSize({ width: 1280, height: 800 });
    await sleep(300);
    // In a call: the voice panel at the foot of the channel list.
    await O.locator(`[data-testid="voice-channel"][data-channel-id="${lounge.id}"]`).click();
    const inCall = !!await until(() => O.locator('[data-testid="voice-connected"]').count(), 20000);
    check('desktop: joined the voice room (mesh, fake devices)', inCall);
    await chanRow(O).click();
    await sleep(700);
    await deskCheck('1280x800, in a call');
    await shot(O, 'desktop-call');
    // The views that take the place beside the rail end above the strip.
    for (const [label, open, sel] of [
        ['the Devices view', () => O.locator('.server-icon.devices-button').click(), '.devices-dashboard'],
        ['the Friends view', () => O.locator('.server-icon.home-button').click(), '.friends-dashboard'],
    ]) {
        await open();
        await sleep(900);
        const v = await O.evaluate((sel) => {
            const el = document.querySelector(sel);
            const s = document.querySelector('.device-stage-minimized-strip') || document.querySelector('.device-stage-minimized');
            if (!el || !s) return { el: !!el, strip: !!s };
            return { el: true, strip: true, viewBottom: Math.round(el.getBoundingClientRect().bottom), stripTop: Math.round(s.getBoundingClientRect().top) };
        }, sel);
        const r = await reachable(O);
        check(`desktop: in ${label} the way back is on screen and ${label} ends above it`, v.el && v.strip && v.viewBottom <= v.stripTop && r.ok, { ...v, ...r });
    }
    await O.locator(`.server-icon[data-server-id="${srv.id}"]`).first().click();
    await sleep(700);
    await chanRow(O).click();
    await sleep(500);
    await O.locator('[data-testid="voice-leave"]').first().click().catch(() => {});
    await sleep(500);
}

// ── an update banner up (desktop) ───────────────────────────────────────────────────────────────
// The desktop app's update banner (UpdateBanner.tsx, up after every release until Later) and the
// sign-in-screen service's (ServiceUpdateBanner.tsx) are fixed along the top, and UpdateBanner.css
// pads `.app` down under them: 52 px, 66 px, 132 px for both (`body:has(.update-banner) .app`). They
// render only under the desktop shell, so the walk puts their markup on the page with their own
// classes and the real stylesheet lays the app out round them. The strip's first reservation fixed
// `.chat-container` at the window less the strip, and the padded column shrank it to its own height
// instead: its foot stayed at the window's, under the strip, over the message box and Send.
if (want('banner')) {
    await O.setViewportSize({ width: 1280, height: 800 });
    await O.locator(`.server-icon[data-server-id="${srv.id}"]`).first().click();
    await sleep(600);
    await chanRow(O).click();
    await sleep(600);
    for (const [label, banners] of [
        ['the app-update banner', ['update-banner']],
        ['the service banner', ['update-banner service-update-banner']],
        ['both banners', ['update-banner', 'update-banner service-update-banner']],
    ]) {
        await O.evaluate((banners) => {
            for (const cls of banners) {
                const b = document.createElement('div');
                b.className = cls;
                b.dataset.walkBanner = '';
                b.innerHTML = '<div class="update-banner-content"><span class="update-icon"></span><div class="update-text"><strong>A new version is ready</strong><span>Update when you are ready.</span></div></div>';
                document.body.appendChild(b);
            }
        }, banners);
        await sleep(500);
        const pad = await O.evaluate(() => getComputedStyle(document.querySelector('.app')).paddingTop);
        console.log(`INFO  ${label}: .app padding-top ${pad}`);
        check(`banner: ${label} pads the app down (the stylesheet's rule applies)`, pad !== '0px', pad);
        await deskCheck(`1280x800, ${label} up`);
        await shot(O, `desktop-banner-${banners.length}-${banners[0].includes('service') ? 'service' : 'app'}`);
        await O.locator('form.message-form textarea').fill('a line\n'.repeat(7));
        await sleep(300);
        await deskCheck(`1280x800, ${label} up, a grown message box`);
        await O.locator('form.message-form textarea').fill('');
        await O.evaluate(() => { for (const b of document.querySelectorAll('[data-walk-banner]')) b.remove(); });
        await sleep(300);
    }
    // Banner gone: the app comes back up and still ends where the strip begins.
    const after = await O.evaluate(() => getComputedStyle(document.querySelector('.app')).paddingTop);
    check('banner: with the banner gone the app is not padded down', after === '0px', after);
    await deskCheck('1280x800, the banner gone again');
}

// ── the button (desktop half) ───────────────────────────────────────────────────────────────────
const contrastOf = (page) => page.evaluate(() => {
    // Every CSS colour form the page can compute (CLAUDE.md: a color-mix() is color(srgb ...)).
    const parse = (s) => {
        let m = /^rgba?\(([^)]+)\)$/.exec(s);
        if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; }
        m = /^color\(srgb ([^)]+)\)$/.exec(s);
        if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] ?? 1 }; }
        throw new Error(`a colour this walk cannot read: ${s}`);
    };
    const lum = ({ r, g, b }) => {
        const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const btn = document.querySelector('.device-stage-minimized');
    const label = btn.querySelector('.device-stage-minimized-label') || btn;
    const fg = parse(getComputedStyle(label).color);
    let bg = parse(getComputedStyle(btn).backgroundColor);
    if (bg.a < 1) {
        // A see-through fill: over what is under it (the strip's surface, else the page).
        let under = btn.parentElement;
        let base = null;
        while (under) { const c = parse(getComputedStyle(under).backgroundColor); if (c.a >= 1) { base = c; break; } under = under.parentElement; }
        base ??= { r: 255, g: 255, b: 255, a: 1 };
        bg = { r: bg.r * bg.a + base.r * (1 - bg.a), g: bg.g * bg.a + base.g * (1 - bg.a), b: bg.b * bg.a + base.b * (1 - bg.a), a: 1 };
    }
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return { ratio: (hi + 0.05) / (lo + 0.05), fg: getComputedStyle(label).color, bg: getComputedStyle(btn).backgroundColor };
});
const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
async function buttonChecks(page, tag, phone) {
    const info = await page.evaluate((SESSION_ID) => {
        const b = document.querySelector('.device-stage-minimized');
        return {
            tag: b?.tagName.toLowerCase(), type: b?.getAttribute('type'), name: b ? (b.getAttribute('aria-label') || b.textContent || '').trim() : null,
            idOnPage: document.body.innerText.includes(SESSION_ID), height: b ? Math.round(b.getBoundingClientRect().height) : 0,
            transform: b ? getComputedStyle(b).transform : null, dotAnimation: b?.querySelector('.device-stage-minimized-dot') ? getComputedStyle(b.querySelector('.device-stage-minimized-dot')).animationName : null,
        };
    }, SESSION_ID);
    const name = await page.getByRole('button', { name: `Return to ${PC}`, exact: true }).count();
    check(`${tag} button: a <button> named "Return to ${PC}" by the accessibility tree, and no session id on the page`, info.tag === 'button' && info.type === 'button' && name === 1 && !info.idOnPage, info);
    if (phone) check(`${tag} button: 44 px tall on a touchscreen`, info.height >= 44, info.height);
    // The fallback: no name known for the PC.
    await page.evaluate(() => { window.__stage.state.peerName = null; window.__stage.emit(); });
    await sleep(200);
    const fallback = await page.getByRole('button', { name: 'Return to the remote computer', exact: true }).count();
    const idAfter = await page.evaluate((id) => document.body.innerText.includes(id), SESSION_ID);
    check(`${tag} button: with no name for the PC it says "Return to the remote computer", still no id`, fallback === 1 && !idAfter);
    await page.evaluate((pc) => { window.__stage.state.peerName = pc; window.__stage.emit(); }, PC);
    await sleep(200);
    // Contrast, all eight themes x contrast.
    const bad = [];
    let readings = 0;
    for (const theme of THEMES) for (const contrast of ['normal', 'high']) {
        await page.evaluate(([t, c]) => { document.documentElement.setAttribute('data-theme', t); document.documentElement.setAttribute('data-contrast', c); }, [theme, contrast]);
        await sleep(60);
        const c = await contrastOf(page);
        readings++;
        if (c.ratio < 4.5) bad.push(`${theme}/${contrast}: ${c.ratio.toFixed(2)} (${c.fg} on ${c.bg})`);
    }
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.setAttribute('data-contrast', 'normal'); });
    check(`${tag} button: its words 4.5:1 on all eight themes with and without high contrast (${readings} readings)`, bad.length === 0, bad);
    // Motion: the dot breathes, the button never scales, and reduced motion stills the dot.
    const transforms = new Set();
    for (let i = 0; i < 8; i++) { transforms.add(await page.evaluate(() => getComputedStyle(document.querySelector('.device-stage-minimized')).transform)); await sleep(130); }
    check(`${tag} button: it never scales over its neighbours (transform none through a whole pulse)`, transforms.size === 1 && transforms.has('none'), [...transforms]);
    check(`${tag} button: its live dot pulses`, info.dotAnimation === 'dsm-live-dot', info.dotAnimation);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const still = await page.evaluate(() => {
        const b = document.querySelector('.device-stage-minimized');
        const anim = [b, ...b.querySelectorAll('*')].map(el => getComputedStyle(el).animationName).filter(n => n && n !== 'none');
        return anim;
    });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    check(`${tag} button: with prefers-reduced-motion nothing in it animates`, still.length === 0, still);
}
if (want('button')) {
    await buttonChecks(O, 'desktop', false);
    // Keyboard: Tab reaches it; Enter brings the stage back; minimised again, Space does.
    await O.locator('body').click({ position: { x: 640, y: 300 } }).catch(() => {});
    let reached = false;
    for (let i = 0; i < 80 && !reached; i++) {
        await O.keyboard.press('Tab');
        reached = await O.evaluate(() => document.activeElement?.classList.contains('device-stage-minimized') ?? false);
    }
    check('desktop button: Tab reaches it', reached);
    for (const key of ['Enter', 'Space']) {
        await O.locator('.device-stage-minimized').focus();
        const focused = await O.evaluate(() => document.activeElement?.classList.contains('device-stage-minimized') ?? false);
        await O.keyboard.press(key);
        const back = !!await until(() => O.locator('.device-stage').count(), 3000);
        check(`desktop button: ${key} on it brings the stage back`, focused && back && !await O.locator('.device-stage-minimized').count(), { focused, back });
        if (back) {
            await O.locator('button[aria-label="More"]').click();
            await O.locator('.dsb-item', { hasText: 'Back to Púca (keep the session)' }).click();
            await until(() => O.locator('.device-stage-minimized').count(), 5000);
        }
    }
}

// ── phone ───────────────────────────────────────────────────────────────────────────────────────
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const PHONE = ['composer', 'send', 'form', 'nav', 'voice'];
if (want('phone') || want('button')) {
    for (const [w, h] of [[390, 844], [360, 800], [844, 390]]) {
        if (!want('phone') && w !== 390) continue;
        const size = `${w}x${h}`;
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: ANDROID_UA });
        const P = await signIn(ctx, owner, `phone ${size}`, false);
        const navTo = async (label) => { await tap(P, P.locator('.mobile-nav-btn', { hasText: label }).first()); await sleep(450); };
        await navTo('Servers');
        await tap(P, P.locator(`.server-icon[data-server-id="${srv.id}"]`).first());
        await sleep(900);
        await navTo('Channels');
        await tap(P, chanRow(P));
        await sleep(900);
        await startAndMinimise(P, true);
        if (want('phone')) {
            const phoneCheck = async (tag, kbUp) => {
                const m = await measure(P);
                const bad = clear(m, PHONE);
                if (kbUp) {
                    // Stepped aside, or at least over nothing; the box comes down to the keyboard.
                    const formBottom = m.on.form ? m.on.form.box.y + m.on.form.box.h : null;
                    // What the box rests on with the keyboard up: the voice bar in a call, else the keyboard.
                    const floor = m.on.voice ? m.on.voice.box.y : m.vh;
                    check(`phone ${size} ${tag}: nothing covers the message box or Send`, present(m, ['composer', 'send']).length === 2 && bad.length === 0, bad.length ? bad : { strip: m.strip, composer: m.on.composer });
                    check(`phone ${size} ${tag}: the way back steps aside and the message box comes down to the ${m.on.voice ? 'voice bar' : 'keyboard'}`, m.keyboardUp && m.strip === null && formBottom !== null && Math.abs(formBottom - floor) <= 2, { strip: m.strip, formBottom, floor, keyboardUp: m.keyboardUp });
                } else {
                    const r = await reachable(P);
                    check(`phone ${size} ${tag}: the way back is on screen, and a tap at its middle lands on it`, !!m.strip && r.ok, { strip: m.strip, ...r });
                    check(`phone ${size} ${tag}: it covers none of ${present(m, PHONE).join(', ')}`, !!m.strip && present(m, ['composer', 'send', 'nav']).length === 3 && bad.length === 0, bad.length ? bad : { strip: m.strip, form: m.on.form?.box, nav: m.on.nav?.box });
                    // Between the message box and the bar below it.
                    const below = m.on.voice ?? m.on.nav;
                    const order = m.strip && m.on.form && below && m.on.form.box.y + m.on.form.box.h <= m.strip.y && m.strip.y + m.strip.h <= below.box.y;
                    check(`phone ${size} ${tag}: it sits between the message box and the ${m.on.voice ? 'voice bar' : 'bottom bar'}`, !!order, { form: m.on.form?.box, strip: m.strip, below: below?.box });
                }
                return m;
            };
            await phoneCheck('keyboard down', false);
            await shot(P, `phone-${size}-down`);
            // Every bottom-bar tab is what a tap at its middle hits.
            const tabs = await P.evaluate(() => [...document.querySelectorAll('.mobile-nav-btn')].map((b) => {
                const r = b.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return { label: b.textContent.trim(), ok: !!hit && (hit === b || b.contains(hit)) };
            }));
            check(`phone ${size}: every bottom-bar tab is what a tap at its middle hits`, tabs.length >= 4 && tabs.every(t => t.ok), tabs.filter(t => !t.ok));
            const chat = await tap(P, P.locator('.mobile-nav-btn', { hasText: 'Chat' }).first());
            await sleep(400);
            check(`phone ${size}: a real tap on Chat lands on Chat and the stage stays minimised`, chat.hits && await P.locator('.device-stage-minimized').count() === 1 && !await P.locator('.device-stage').count(), chat.what);
            // (The old pill took that tap and brought the stage back: minimise it again to walk on.)
            if (await P.locator('.device-stage').count()) {
                await tap(P, P.locator('.device-stage-mobile-btn[title="Chat"]'));
                await until(() => P.locator('.device-stage-minimized').count(), 5000);
            }
            await softKeyboard(P, w, h, true);
            await phoneCheck('keyboard up', true);
            await shot(P, `phone-${size}-up`);
            await softKeyboard(P, w, h, false);
            await P.locator('form.message-form textarea').blur();
            await sleep(200);
            await phoneCheck('keyboard down again', false);
            if (w === 390) {
                // The other panels end above it too (their last rows, the channel list's profile bar).
                for (const [label, sel] of [['Channels', '.sidebar'], ['Members', '.member-sidebar'], ['Devices', '.devices-dashboard'], ['Tasks', '.friends-dashboard']]) {
                    await navTo(label);
                    await sleep(400);
                    const v = await P.evaluate((sel) => {
                        const el = [...document.querySelectorAll(sel)].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1; });
                        const s = document.querySelector('.device-stage-minimized-strip') || document.querySelector('.device-stage-minimized');
                        if (!el || !s) return { panel: !!el, strip: !!s };
                        const prof = el.querySelector('.user-profile-bar');
                        return { panel: true, strip: true, panelBottom: Math.round(el.getBoundingClientRect().bottom), stripTop: Math.round(s.getBoundingClientRect().top), profileBottom: prof ? Math.round(prof.getBoundingClientRect().bottom) : null };
                    }, sel);
                    check(`phone ${size}: the ${label} panel ends above the way back`, v.panel && v.strip && v.panelBottom <= v.stripTop && (v.profileBottom === null || v.profileBottom <= v.stripTop), v);
                }
                await navTo('Chat');
                await sleep(400);
                if (await P.locator('.device-stage').count()) {
                    // (The old pill took the tap on a tab: minimise again to walk on.)
                    await tap(P, P.locator('.device-stage-mobile-btn[title="Chat"]'));
                    await until(() => P.locator('.device-stage-minimized').count(), 5000);
                }
                // In a voice call: the voice bar above the bottom bar, the strip above the voice bar.
                await navTo('Channels');
                await tap(P, P.locator(`[data-testid="voice-channel"][data-channel-id="${lounge.id}"]`));
                const joined = !!await until(() => P.locator('[data-testid="voice-connected"]').count(), 20000);
                check(`phone ${size}: joined the voice room`, joined);
                await navTo('Chat');
                await sleep(500);
                if (await P.locator('.device-stage').count()) {
                    // (The old pill took the tap on Chat: minimise again to walk on.)
                    await tap(P, P.locator('.device-stage-mobile-btn[title="Chat"]'));
                    await until(() => P.locator('.device-stage-minimized').count(), 5000);
                }
                await phoneCheck('in a call', false);
                const vbtns = await P.evaluate(() => [...document.querySelectorAll('.voice-panel-compact button, .voice-panel-compact [role="button"]')].filter(b => b.getBoundingClientRect().width > 0).map((b) => {
                    const r = b.getBoundingClientRect();
                    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    return { what: b.getAttribute('title') || b.getAttribute('aria-label') || b.className, ok: !!hit && (hit === b || b.contains(hit)) };
                }));
                check(`phone ${size} in a call: every voice-bar control is what a tap at its middle hits`, vbtns.length >= 2 && vbtns.every(b => b.ok), vbtns.filter(b => !b.ok));
                await shot(P, `phone-${size}-call`);
                await softKeyboard(P, w, h, true);
                await phoneCheck('in a call, keyboard up', true);
                await softKeyboard(P, w, h, false);
                await P.locator('[data-testid="voice-leave"]').first().click().catch(() => {});
                await sleep(400);
            }
        }
        if (want('button') && w === 390) await buttonChecks(P, `phone ${size}`, true);
        await ctx.close();
    }
}

// ── dialogs: the way back is under every dialog the app opens ──────────────────────────────────
// In the phone layout mobile.css fixes `.chat-container` to the screen, and a fixed element is a
// stacking context of its own: every dialog Chat draws (the member profile sheet, Edit Channel,
// Create Channel, Settings, Server Settings; z 1000 to 2000) is stacked INSIDE it, at the page's
// level 0, so a strip beside it at z 250 was drawn over all of them (the review of 2026-11-22): the
// profile sheet's foot, the foot of Edit Channel and a band of Settings were the strip under a tap,
// and no backdrop dimmed it. For each dialog, opened as a person does it, with its scroll areas run
// to their end: every point of the place where the dialog and the strip overlap is the dialog's
// (elementFromPoint), and every control of the dialog whose middle falls in the strip's place is what
// a tap there hits; a real tap where Create Channel's backdrop is over the strip closes the dialog and
// leaves the session put away. The desktop's Settings and Create Channel the same way, and a CONTROL:
// the strip forced over the desktop's Settings must be caught by the same measure.
/** Where `sel` (the dialog's outermost box: its backdrop, or the sheet) and the strip overlap. */
const underDialog = (page, sel) => page.evaluate((sel) => {
    const strip = document.querySelector('.device-stage-minimized-strip');
    const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const d = [...document.querySelectorAll(sel)].find(shown);
    if (!strip || !d || !shown(strip)) return { strip: !!strip && shown(strip), dialog: !!d };
    const s = strip.getBoundingClientRect(), b = d.getBoundingClientRect();
    const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    const inS = (h) => !!h && (h === strip || strip.contains(h));
    const inD = (h) => !!h && (h === d || d.contains(h));
    const L = Math.max(s.left, b.left), R = Math.min(s.right, b.right), T = Math.max(s.top, b.top), B = Math.min(s.bottom, b.bottom);
    const out = { strip: true, dialog: true, stripBox: box(s), dialogBox: box(b), overlap: R > L && B > T ? Math.round((R - L) * (B - T)) : 0, n: 0, onStrip: 0, onDialog: 0, other: [], controls: [] };
    if (out.overlap) for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) {
        const x = L + (i + 0.5) * (R - L) / 16, y = T + (j + 0.5) * (B - T) / 4;
        out.n++;
        const h = document.elementFromPoint(x, y);
        if (inS(h)) out.onStrip++;
        else if (inD(h)) out.onDialog++;
        else if (out.other.length < 3) out.other.push(`${Math.round(x)},${Math.round(y)}: ${h ? h.tagName.toLowerCase() + '.' + (h.getAttribute('class') || '').split(' ')[0] : 'nothing'}`);
    }
    // The dialog's own controls in the strip's place (the end of its scroll included).
    for (const c of d.querySelectorAll('button, input, select, textarea, a[href], label, [role="button"], [role="switch"]')) {
        const r = c.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < s.left || x > s.right || y < s.top || y > s.bottom) continue;
        const h = document.elementFromPoint(x, y);
        out.controls.push({ what: (c.getAttribute('aria-label') || c.textContent || c.tagName).trim().slice(0, 30), ok: !!h && (h === c || c.contains(h)), hit: h ? `${h.tagName.toLowerCase()}.${(h.getAttribute('class') || '').split(' ')[0]}` : 'nothing' });
    }
    return out;
}, sel);
/** Every scroll area inside the dialog run to its end (its last rows are what the strip sat on). */
const scrollToEnd = (page, sel) => page.evaluate((sel) => {
    const d = document.querySelector(sel);
    if (!d) return 0;
    let n = 0;
    for (const el of [d, ...d.querySelectorAll('*')]) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) { el.scrollTop = el.scrollHeight; n++; }
    }
    return n;
}, sel);
async function dialogCheck(page, tag, sel) {
    const scrolled = await scrollToEnd(page, sel);
    await sleep(250);
    const m = await underDialog(page, sel);
    const badControls = (m.controls || []).filter(c => !c.ok);
    check(`${tag}: the dialog is over the way back where they overlap (every point there is the dialog's, none the strip's)`,
        m.strip && m.dialog && m.overlap > 0 && m.n > 0 && m.onStrip === 0 && m.onDialog === m.n,
        { overlap: m.overlap, n: m.n, onStrip: m.onStrip, onDialog: m.onDialog, other: m.other, strip: m.stripBox, dialog: m.dialogBox, scrolled });
    check(`${tag}: every control of the dialog in the strip's place is what a tap there hits (${(m.controls || []).length})`, m.strip && m.dialog && badControls.length === 0, badControls);
    return m;
}
/** The stage minimised again if a tap brought it back (the old strip took them). */
async function ensureMinimised(page, phone) {
    if (await page.locator('.device-stage-minimized').count()) return;
    if (!await page.locator('.device-stage').count()) { await startAndMinimise(page, phone); return; }
    if (phone) await tap(page, page.locator('.device-stage-mobile-btn[title="Chat"]'));
    else {
        await page.locator('button[aria-label="More"]').click();
        await page.locator('.dsb-item', { hasText: 'Back to Púca (keep the session)' }).click();
    }
    await until(() => page.locator('.device-stage-minimized').count(), 5000);
    await sleep(300);
}
const stillAway = async (page) => await page.locator('.device-stage-minimized').count() === 1 && !await page.locator('.device-stage').count();
/** A real tap at the middle of the strip, where a dialog's BACKDROP is over it: it must close the
 *  dialog and leave the session put away. Taps only on the backdrop itself (or on the strip, which is
 *  the defect), never on a control. */
async function tapBackdropOverStrip(page, tag, overlaySel, dialogGoneSel, phone) {
    const at = await page.evaluate((overlaySel) => {
        const s = document.querySelector('.device-stage-minimized');
        const o = document.querySelector(overlaySel);
        if (!s || !o) return null;
        const r = s.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const h = document.elementFromPoint(x, y);
        return { x, y, backdrop: h === o, strip: !!h && (h === s || s.contains(h)), hit: h ? `${h.tagName.toLowerCase()}.${(h.getAttribute('class') || '').split(' ')[0]}` : 'nothing' };
    }, overlaySel);
    if (!at || (!at.backdrop && !at.strip)) { console.log(`INFO  ${tag}: no backdrop over the strip's middle to tap (${at ? at.hit : 'no dialog'})`); return; }
    if (phone) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
    await sleep(500);
    const closed = !await page.locator(dialogGoneSel).count();
    const away = await stillAway(page);
    check(`${tag}: a real ${phone ? 'tap' : 'click'} on the backdrop over the way back closes the dialog and leaves the session put away`, at.backdrop && closed && away, { hit: at.hit, closed, away });
}
async function closeDialog(page, sel, closers) {
    for (const c of closers) {
        if (!await page.locator(sel).count()) return true;
        const loc = page.locator(c).first();
        if (await loc.count()) { await loc.click().catch(() => {}); await sleep(400); }
    }
    if (await page.locator(sel).count()) { await page.keyboard.press('Escape').catch(() => {}); await sleep(400); }
    return !await page.locator(sel).count();
}
if (want('dialogs')) {
    // The desktop: the dialogs are in the page's own stacking order, and the strip is under them.
    await O.setViewportSize({ width: 1280, height: 800 });
    await O.locator(`.server-icon[data-server-id="${srv.id}"]`).first().click();
    await sleep(600);
    await chanRow(O).click();
    await sleep(500);
    await ensureMinimised(O, false);
    await O.locator('.sidebar .user-action-btn[title="Settings"]').first().click();
    check('dialogs desktop: Settings opened', !!await until(() => O.locator('.settings-modal').count(), 6000));
    await sleep(300);
    await dialogCheck(O, 'dialogs desktop Settings', '.settings-modal-overlay');
    // CONTROL: the strip forced over the dialog is caught by the same measure.
    await O.evaluate(() => document.querySelector('.device-stage-minimized-strip').style.setProperty('z-index', '5000', 'important'));
    const forced = await underDialog(O, '.settings-modal-overlay');
    check('dialogs desktop CONTROL: the strip forced over Settings is caught (points on the strip)', forced.onStrip > 0, { onStrip: forced.onStrip, n: forced.n });
    await O.evaluate(() => document.querySelector('.device-stage-minimized-strip').style.removeProperty('z-index'));
    await shot(O, 'dialogs-desktop-settings');
    check('dialogs desktop: Settings closed', await closeDialog(O, '.settings-modal', ['.settings-close']));
    await O.locator('.sidebar .add-channel-btn').first().click();
    check('dialogs desktop: Create Channel opened', !!await until(() => O.locator('.modal-overlay .modal').count(), 6000));
    await sleep(300);
    await dialogCheck(O, 'dialogs desktop Create Channel', '.modal-overlay');
    await tapBackdropOverStrip(O, 'dialogs desktop Create Channel', '.modal-overlay', '.modal-overlay .modal', false);
    await closeDialog(O, '.modal-overlay .modal', ['.modal-overlay .modal button:text-is("Cancel")']);
    await ensureMinimised(O, false);

    // The phone, keyboard down, the way back above the bottom bar.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: ANDROID_UA });
    const P = await signIn(ctx, owner, 'dialogs phone', false);
    const navTo = async (label) => { await tap(P, P.locator('.mobile-nav-btn', { hasText: label }).first()); await sleep(450); };
    await navTo('Servers');
    await tap(P, P.locator(`.server-icon[data-server-id="${srv.id}"]`).first());
    await sleep(900);
    await navTo('Channels');
    await tap(P, chanRow(P));
    await sleep(900);
    await startAndMinimise(P, true);
    const pre = await reachable(P);
    check('dialogs phone: the way back is up (the premise)', pre.ok, pre);

    // The member profile sheet (above the bottom bar, its own scroll area).
    await navTo('Members');
    await sleep(300);
    const member = P.locator('.member-sidebar .member-item').first();
    if (await member.count()) {
        await tap(P, member);
        const sheet = !!await until(() => P.locator('.user-profile-popup.upp-sheet').count(), 6000);
        check('dialogs phone: the member profile sheet opened', sheet);
        await sleep(400);
        if (sheet) {
            await dialogCheck(P, 'dialogs phone profile sheet', '.user-profile-popup');
            await shot(P, 'dialogs-phone-profile-sheet');
            // A real tap on the sheet where it overlaps the strip (its last 3 px, the sheet's own
            // padding): the sheet's, never the strip's. Not on one of its controls.
            const at = await P.evaluate(() => {
                const strip = document.querySelector('.device-stage-minimized-strip');
                const s = strip?.getBoundingClientRect();
                const d = document.querySelector('.user-profile-popup')?.getBoundingClientRect();
                if (!s || !d || d.bottom <= s.top) return null;
                const x = d.left + d.width / 2, y = Math.min(d.bottom, s.bottom) - 3;
                const h = document.elementFromPoint(x, y);
                const onStrip = !!h && strip.contains(h);
                return { x, y, strip: onStrip, control: !onStrip && !!h && !!h.closest('button, input, select, textarea, a[href], label, [role="button"]'), hit: h ? `${h.tagName.toLowerCase()}.${(h.getAttribute('class') || '').split(' ')[0]}` : 'nothing' };
            });
            if (at && !at.control) {
                await P.touchscreen.tap(at.x, at.y);
                await sleep(500);
                const away = await stillAway(P);
                const open = await P.locator('.user-profile-popup').count() === 1;
                check('dialogs phone profile sheet: a real tap on its foot over the way back stays in the sheet (the session stays put away, the sheet open)', !at.strip && away && open, { hit: at.hit, away, open });
            } else console.log(`INFO  dialogs phone profile sheet: its foot is ${at ? 'a control (' + at.hit + ')' : 'clear of the strip'}; no tap`);
            await P.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
            await sleep(400);
        }
    } else check('dialogs phone: a member row to tap', false);
    await ensureMinimised(P, true);

    // Edit Channel (centred at 85dvh, Save at the end of its scroll), from the channel's menu.
    await navTo('Channels');
    await chanRow(P).evaluate((el) => {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10, button: 2 }));
    });
    const editItem = P.locator('.context-menu .context-menu-item', { hasText: 'Edit' }).first();
    if (await until(() => editItem.count(), 6000)) {
        await editItem.tap();
        const open = !!await until(() => P.locator('.edit-channel-modal').count(), 6000);
        check('dialogs phone: Edit Channel opened', open);
        await sleep(300);
        if (open) {
            await dialogCheck(P, 'dialogs phone Edit Channel', '.modal-overlay:has(.edit-channel-modal)');
            await shot(P, 'dialogs-phone-edit-channel');
            check('dialogs phone: Edit Channel closed', await closeDialog(P, '.edit-channel-modal', ['.edit-channel-modal .close-button']));
        }
    } else check('dialogs phone: the channel menu offers Edit', false);
    await ensureMinimised(P, true);

    // Create Channel (a backdrop over the whole screen), and a real tap on that backdrop over the strip.
    await navTo('Channels');
    await tap(P, P.locator('.sidebar .add-channel-btn').first());
    const create = !!await until(() => P.locator('.modal-overlay .modal').count(), 6000);
    check('dialogs phone: Create Channel opened', create);
    await sleep(300);
    if (create) {
        await dialogCheck(P, 'dialogs phone Create Channel', '.modal-overlay');
        await shot(P, 'dialogs-phone-create-channel');
        await tapBackdropOverStrip(P, 'dialogs phone Create Channel', '.modal-overlay', '.modal-overlay .modal', true);
        await closeDialog(P, '.modal-overlay .modal', ['.modal-overlay .modal button:text-is("Cancel")']);
    }
    await ensureMinimised(P, true);

    // Settings and Server Settings (full screen on a phone).
    for (const [label, opener, overlay, inner, closers] of [
        ['Settings', '.sidebar .user-action-btn[title="Settings"]', '.settings-modal-overlay', '.settings-modal', ['.settings-close']],
        ['Server Settings', '.server-settings-btn', '.server-settings-overlay', '.server-settings-container', ['.server-settings-container .close-btn']],
    ]) {
        await navTo('Channels');
        await tap(P, P.locator(opener).first());
        const open = !!await until(() => P.locator(inner).count(), 6000);
        check(`dialogs phone: ${label} opened`, open);
        await sleep(400);
        if (!open) continue;
        await dialogCheck(P, `dialogs phone ${label}`, overlay);
        await shot(P, `dialogs-phone-${label.toLowerCase().replace(/ /g, '-')}`);
        check(`dialogs phone: ${label} closed`, await closeDialog(P, inner, closers));
        await ensureMinimised(P, true);
    }
    // Every dialog gone: the way back is still up and reachable.
    await navTo('Chat');
    const post = await reachable(P);
    check('dialogs phone: with every dialog closed the way back is on screen and a tap at its middle lands on it', post.ok, post);

    // In a call the strip sits higher, above the voice bar: the profile sheet and Settings once more.
    await navTo('Channels');
    await tap(P, P.locator(`[data-testid="voice-channel"][data-channel-id="${lounge.id}"]`));
    const joined = !!await until(() => P.locator('[data-testid="voice-connected"]').count(), 20000);
    check('dialogs phone: joined the voice room', joined);
    await navTo('Chat');
    await ensureMinimised(P, true);
    if (joined) {
        await navTo('Members');
        await tap(P, P.locator('.member-sidebar .member-item').first());
        if (await until(() => P.locator('.user-profile-popup.upp-sheet').count(), 6000)) {
            await sleep(400);
            await dialogCheck(P, 'dialogs phone in a call, profile sheet', '.user-profile-popup');
            await P.evaluate(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
            await sleep(400);
        } else check('dialogs phone in a call: the member profile sheet opened', false);
        await ensureMinimised(P, true);
        await navTo('Channels');
        await tap(P, P.locator('.sidebar .user-action-btn[title="Settings"]').first());
        if (await until(() => P.locator('.settings-modal').count(), 6000)) {
            await sleep(400);
            await dialogCheck(P, 'dialogs phone in a call, Settings', '.settings-modal-overlay');
            await shot(P, 'dialogs-phone-call-settings');
            await closeDialog(P, '.settings-modal', ['.settings-close']);
        } else check('dialogs phone in a call: Settings opened', false);
        await ensureMinimised(P, true);
        await P.locator('[data-testid="voice-leave"]').first().click().catch(() => {});
        await sleep(400);
    }
    await ctx.close();
}

await browser.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures);
