// LIVE: the phone UI sweep (2026-11-12). The owner's report, "mobile also has a lot of ui issues
// which need fixed and improved", came with no list; an audit of the BUILT bundle as a coarse-pointer
// phone found these, and each section below fails on the bundle from before its fix:
//
//   fields     Every field a phone types into is 16px or more (iOS zooms the page on focus below
//              that): the composer, the sign-in password, the emoji search, Server Settings'
//              description. CONTROL: a field forced to 15px must be caught.
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
    const ownerName = 'swo_' + stamp;
    const phoneName = ('phone_with_a_long_name_' + stamp + '_xxxxxxxx').slice(0, 32);
    const O = await signIn(desktop, ownerName, 'owner', true);
    const srv = await api(O, 'POST', '/servers', { name: 'Sweep ' + stamp });
    const mk = (name, type) => api(O, 'POST', `/servers/${srv.id}/channels`, { name, channel_type: type });
    const general = await mk('general', 0);
    const inv = await api(O, 'POST', `/servers/${srv.id}/invites`, {});

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

        await ctx.close();
    }
} catch (e) {
    check('the walk ran to the end', false, String(e?.stack || e).slice(0, 600));
} finally {
    await browser.close();
}
console.log(`\n${failures} failure(s)`);
process.exit(failures);
