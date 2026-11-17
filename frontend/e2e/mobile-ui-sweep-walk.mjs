// LIVE: the phone UI sweep (2026-11-12). The owner's report, "mobile also has a lot of ui issues
// which need fixed and improved", came with no list; an audit of the BUILT bundle as a coarse-pointer
// phone found these, and each section below fails on the bundle from before its fix:
//
//   fields     The fields found under 16px are 16px or more (iOS zooms the page on focus below
//              that): the composer, the sign-in password and its recovery code box, the emoji
//              search, Server Settings' description. CONTROL: a field forced to 15px must be caught. The empty composer's
//              "Message #channel" stays on one line (at 16px it wrapped at 360, the second line
//              cut in half).
//   nav        The bottom bar takes the theme's colours (it was navy on every theme, Light included)
//              and every label, the chosen tab's too, reads at 4.5:1 on all eight themes with and
//              without high contrast (the chosen one was 3.3-3.5:1 everywhere).
//   settings   A tap on a setting's name or hint toggles its checkbox (the labels named no control,
//              so a phone had a lone 20px box), and a tap on the box still toggles it once. No
//              "ESC" key hint on the phone's close button, and its X still drawn with Classic icons
//              (an emoji <span>). On the desktop, a mouse drag selecting a hint's words leaves the
//              setting alone, as a native label does (CONTROL: a plain click toggles it), and a
//              single click on words already selected toggles it at the first click.
//   toggle     The chat header's checklist button has no background or border, like the pin button
//              beside it (it was the browser's own grey button on every theme). CONTROL: an
//              unstyled button in the same header must be caught. Just tapped, it paints no box
//              (a sticky :hover on touch left the grey one).
//   header     A message from a 32-character name: its time is whole, on one line, inside the
//              message and the window (it was "Today / at / 17:54" down the edge at 390, and off
//              the screen at 360).
//   link       A long address's card (built in the app from the address alone, so nothing is
//              fetched) wraps it inside the card (it was cut off sideways mid-path).
//   tasks      The Tasks view's empty-state sentence keeps 12px from the screen's edges (it ran
//              flush from edge to edge), while Trash, drawn in the same box, keeps its rows' own
//              alignment and width. Chat in the bottom bar then goes back to the channel
//              (it left the Tasks view on screen: the tap did nothing).
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
//              four, and the encryption badge slid under Mute. The bar and the call view's header
//              show the room's whole name (the Encrypted badge cut it to "Lo..." at 390, to nothing
//              at 360: it is its lock there, named in full), the LIVE badge stays clear of the
//              button in the in-app fullscreen too, and SIDEWAYS (the phone turned, watching the
//              stream with the owner's camera on) the camera strip and the floating call bar do not
//              overlap, and the strip goes back down when a tap hides the controls.
//   friends    Friends' Add Friend tab is whole on screen, left of the close button, with no sideways
//              scroll (it was cut at the edge at 390, mostly hidden at 360). On the owner's 1280x800
//              desktop, the All and Pending tabs' search boxes take their row, at rest and focused
//              (Chat.css's chat-header width held them at 200 px, 280 on focus).
//   names      The channel header's search box says its whole word ("Search this c" before) and
//              the channel's name keeps four letters' room, even with 220px more beside it.
//   keyboard   With the soft keyboard up (<html data-keyboard-up>, api/keyboardUp.ts) the bottom
//              bar is gone and the chat comes down to the keyboard; down, it is back. CONTROL:
//              the box focused with no keyboard keeps the bar.
//   longpress  As Android (its user agent), a message, a member and a channel take no text
//              selection (a long press is Púca's menu there and also selected a word under it);
//              as an iPhone they do (no menu: selection is how it copies). The box keeps its own.
//   faint      --text-faint is 4.5:1 on every surface it rests on, and an offline member's name
//              (the row was at half opacity: 1.8:1) too, on all eight themes x contrast.
//   stick      (2026-11-16, the owner's "when typing in an active conversation on mobile, the latest
//              message doesn't stay at the bottom") As an iPhone in WEBKIT (Safari's engine), as an
//              Android phone in Chromium, at 390x844, and on a 1280x800 desktop: the newest message
//              stays at the message box with the keyboard up, after EVERY keystroke while the box
//              grows to its 200 px ceiling, with the other side's typing indicator up, as a message
//              and one with a link card arrive, after your own send and with the keyboard down
//              again. The keyboard is simulated as each app gets it (stickWalk's softKeyboard: the
//              Android app's WebView resized, an iPhone's visual viewport shrunk, read by
//              keyboardUp.ts itself). CONTROLS: a reader scrolled 400 px up keeps their exact
//              scrollTop (and Jump to latest) through all of it, and the desktop has no keyboard
//              handling and keeps the newest message at rest, on receiving and on sending. The bundle
//              from before the fix fails 8 checks: as Android (desktop Chromium, which does not pin
//              a list by itself; the real Android WebView does, e2e/android-phone-sweep-live.mjs)
//              270 px under the box with the keyboard up, 424 px typing, 455 px with the indicator;
//              as an iPhone 154 px typing, 185 px with the indicator, 60 px with the keyboard down;
//              on the desktop 64 px typing, 95 px with the indicator. A second CONTROL, from the
//              review of the fix: a reader ONE NOTCH (100 px) up, inside the slop that still counts
//              as "at the bottom" for a new message, is not pulled down by the other side's typing
//              indicator coming and going or by the keyboard (a fix that pins every list in the slop
//              when the list's own height changes fails it). It CANNOT see what a real iPhone does
//              besides shrinking the visual viewport: iOS also pans the page to show the focused
//              box (the layout does not move, so the list's place against the box is what this
//              measures), and Safari's own keyboard animation. Needs WebKit
//              (npx playwright install webkit). Its own channel, at 390x844 only, about 4 minutes.
//
// All at 390x844 and 360x800 with real touches (a tap is what elementFromPoint hits, never
// locator.click(), which scrolls first and false-passes a covered control). `stick` scrolls the
// iPhone's list from the page: Playwright's mobile WebKit takes no wheel and no touch drag.
//
// Each check prints PASS/FAIL; the exit code is the number of failures. Screenshots go to OUT.
//
// Prereqs: a THROWAWAY backend (APP_ENV=development, raised AUTH_RATE_LIMIT_PER_SECOND / _BURST, its
// own fresh database, never a real one) at API, and a build against it served at APP (header of
// sidebar-toggles-walk.mjs). It refuses to start unless both are loopback: it creates accounts.
// Silent: --mute-audio, and WebKit through muteWebkit. About 5 minutes.
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5472 API=http://127.0.0.1:5471 OUT=<dir> node e2e/mobile-ui-sweep-walk.mjs
//   ONLY=fields,...  runs some sections.
import { chromium, webkit, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { muteWebkit } from './muted.mjs';

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

/** A real tap at the middle of what is visible of `loc`; returns whether that point hits it.
 *  `lastHit` names what the point hit, for a check's detail. */
let lastHit = '';
async function tap(page, loc) {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const b = await loc.boundingBox();
    if (!b) throw new Error('nothing to tap');
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    const r = await loc.evaluate((el, [x, y]) => {
        const h = document.elementFromPoint(x, y);
        return { hits: !!h && (h === el || el.contains(h)), what: h ? `${h.tagName.toLowerCase()}.${String(h.className).split(' ').slice(0, 2).join('.')} at ${Math.round(x)},${Math.round(y)}` : 'nothing' };
    }, [x, y]);
    lastHit = r.what;
    await page.touchscreen.tap(x, y);
    return r.hits;
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

// ── stick: the newest message stays at the message box while the phone types (header: `stick`).
let wk = null;
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
/** Where the newest message is: `fromBottom` 0 is a list at its newest message, `toBox` what lies
 *  between its bottom edge and the message box's top (negative: under the box). */
const stickRead = (page) => page.evaluate(() => {
    const sc = document.querySelector('.messages-container');
    const rows = sc.querySelectorAll(':scope > .message');
    const last = rows[rows.length - 1];
    const box = document.querySelector('form.message-form');
    const ta = box.querySelector('textarea');
    return {
        fromBottom: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight),
        toBox: Math.round(box.getBoundingClientRect().top - last.getBoundingClientRect().bottom),
        scrollTop: Math.round(sc.scrollTop),
        list: sc.clientHeight,
        boxPx: Math.round(ta.getBoundingClientRect().height),
        typing: !!document.querySelector('.typing-indicator'),
        pill: !!document.querySelector('.jump-latest-pill'),
        keyboardUp: 'keyboardUp' in document.documentElement.dataset,
        nav: (() => { const n = document.querySelector('.mobile-bottom-nav'); return n ? getComputedStyle(n).display : 'absent'; })(),
        vh: innerHeight,
    };
});
/** Two frames: the list's ResizeObserver has run and the frame is painted. */
const twoFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
/** The soft keyboard, as each app sees it (a headless browser has none):
 *  - Android: the app's WebView is RESIZED to above the keyboard (the real APK: innerHeight 473 with
 *    it up, e2e/android-phone-sweep-live.mjs), then the app's own keyboard event raises
 *    <html data-keyboard-up>, held as long as the keyboard is up as the native answer holds it
 *    (keyboardUp.ts's focus listeners would otherwise read the resized page as "no keyboard");
 *  - iPhone: the layout keeps its height and only the VISUAL viewport shrinks, by the keyboard's
 *    336 px: window.visualViewport answers with that height and the real visual viewport's resize
 *    event is fired, so the app's own keyboardUp.ts sees it and raises the attribute itself. */
async function softKeyboard(page, engine, up) {
    if (engine === 'Android') {
        if (up) {
            await page.setViewportSize({ width: 390, height: 844 - 330 });
            await twoFrames(page);
            await page.evaluate(() => {
                const root = document.documentElement;
                window.__stickKb = true;
                root.dataset.keyboardUp = '';
                window.__stickKbHold ??= new MutationObserver(() => { if (window.__stickKb && !('keyboardUp' in root.dataset)) root.dataset.keyboardUp = ''; });
                window.__stickKbHold.observe(root, { attributes: true, attributeFilter: ['data-keyboard-up'] });
            });
        } else {
            await page.setViewportSize({ width: 390, height: 844 });
            await twoFrames(page);
            await page.evaluate(() => { window.__stickKb = false; delete document.documentElement.dataset.keyboardUp; });
        }
    } else if (engine === 'iPhone') {
        await page.evaluate((kb) => {
            const real = window.__stickVV || window.visualViewport;
            window.__stickVV = real;
            const shown = kb === 0 ? real : new Proxy(real, {
                get: (t, k) => (k === 'height' ? innerHeight - kb : k === 'offsetTop' ? kb : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])),
            });
            Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => shown });
            real.dispatchEvent(new Event('resize'));
        }, up ? 336 : 0);
    }
    await twoFrames(page);
}

/**
 * The owner's report (2026-11-16): "when typing in an active conversation on mobile, the latest
 * message doesn't stay at the bottom, it seems to move up." The message list re-pinned to its newest
 * message only when its CONTENT grew; its own box shrinking from the bottom (the keyboard, the message
 * box growing a line, the typing indicator) kept scrollTop and slid the newest message under the box,
 * and on WebKit measuring the box clamped the list's scrollTop on every keystroke
 * (components/repinOnResize.ts, components/growToFit.ts). As an Android phone (Chromium) and as an
 * iPhone (WebKit, Safari's engine) at 390x844, each step must leave the newest message at the box;
 * a reader scrolled up stays exactly where they are (CONTROL); and on a 1280x800 desktop the same
 * steps, with no keyboard, keep what the desktop did before (CONTROL) and the message box growing or
 * the typing indicator no longer hide the newest message there either.
 */
async function stickWalk(O, srv, phoneName) {
    const chan = await api(O, 'POST', `/servers/${srv.id}/channels`, { name: 'stick-' + stamp, channel_type: 0 });
    await O.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(O);
    await O.locator(`.server-icon[data-server-id="${srv.id}"]`).first().click();
    await sleep(1000);
    const chanRow = (page) => page.locator('.sidebar .channel-list .channel').filter({ has: page.locator(`.channel-name:text-is("${chan.name}")`) }).first();
    await chanRow(O).click();
    await sleep(1000);
    for (let i = 0; i < 20; i++) await say(O, `History ${i}: a few words so the list has rows to scroll through ${'and more '.repeat(i % 4)}`);
    wk = muteWebkit(await webkit.launch());
    const ENGINES = [
        ['Android', () => browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: ANDROID_UA })],
        ['iPhone', () => wk.newContext({ ...devices['iPhone 15'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } })],
        ['desktop', () => browser.newContext({ viewport: { width: 1280, height: 800 } })],
    ];
    const words = 'the quick brown fox jumps over the lazy dog and runs on down the road ';
    for (const [engine, make] of ENGINES) {
        const phone = engine !== 'desktop';
        const ctx = await make();
        const P = await signIn(ctx, phoneName, `stick ${engine}`, false);
        if (phone) {
            await nav(P, 'Servers');
            await tap(P, P.locator(`.server-icon[data-server-id="${srv.id}"]`).first());
            await sleep(1000);
            await nav(P, 'Channels');
            await tap(P, chanRow(P));
        } else {
            await P.locator(`.server-icon[data-server-id="${srv.id}"]`).first().click();
            await sleep(1000);
            await chanRow(P).click();
        }
        await until(async () => (await rowCount(P)) >= 20, 30000);
        await sleep(1200);
        const at = (label, r) => check(`${engine} stick: ${label}: the newest message is at the message box`, r.fromBottom <= 1 && r.toBox >= 0, r);
        const box = P.locator(COMPOSER);
        const focusBox = async () => { if (phone) await tap(P, box); else await box.click(); await twoFrames(P); };
        /** Types until the box is `px` tall or more (or stops growing), reading the list after EVERY
         *  keystroke: on WebKit every keystroke on a box of several lines moved the list. */
        const typeUntil = async (px) => {
            const readings = [];
            let grew = 0, last = (await stickRead(P)).boxPx;
            for (let i = 0; i < 900; i++) {
                await P.keyboard.type(words[i % words.length]);
                await twoFrames(P);
                const r = { ...(await stickRead(P)), afterKeystroke: i + 1 };
                readings.push(r);
                if (r.boxPx !== last) { grew++; last = r.boxPx; }
                if (r.boxPx >= px && i % words.length === words.length - 1) break;
            }
            return { readings, grew, boxPx: last };
        };
        /** The reading furthest from the newest message (for "at the box"). */
        const furthest = (rs) => rs.reduce((w, r) => (r.fromBottom > w.fromBottom || r.toBox < w.toBox ? r : w));
        /** The reading furthest from where a reader was (for "stays"): any keystroke that moved them. */
        const drifted = (rs, top) => rs.reduce((w, r) => (Math.abs(r.scrollTop - top) > Math.abs(w.scrollTop - top) || (!r.pill && w.pill) ? r : w));

        // ── at the newest message
        const rest = await stickRead(P);
        at('at rest', rest);
        if (phone) check(`${engine} stick: the phone layout (the bottom bar is there)`, rest.nav !== 'none', rest);
        else check(`desktop stick: CONTROL - the desktop layout: no keyboard handling, no bottom bar`, !rest.keyboardUp && (rest.nav === 'absent' || rest.nav === 'none'), rest);
        await focusBox();
        await softKeyboard(P, engine, true);
        const kb = await stickRead(P);
        if (phone) {
            check(`${engine} stick: the keyboard is up, the bottom bar gone (${engine === 'iPhone' ? 'keyboardUp.ts read the visual viewport' : 'the WebView resized'})`, kb.keyboardUp && kb.nav === 'none', kb);
            at('the keyboard up', kb);
            await shot(P, `stick-${engine}-keyboard`);
        }
        const typed = await typeUntil(phone ? 190 : 100);
        check(`${engine} stick: the message box grew line by line as it was typed into`, typed.grew >= 3, { grew: typed.grew, boxPx: typed.boxPx });
        at(`typing ${typed.grew} lines more, after every keystroke (${typed.readings.length}; the furthest)`, furthest(typed.readings));
        await shot(P, `stick-${engine}-typed`);
        // The other side starts typing: the indicator comes up between the list and the box.
        await O.locator(COMPOSER).click();
        await O.keyboard.type('typing back');
        const ind = await until(() => P.evaluate(() => !!document.querySelector('.typing-indicator')), 8000);
        await twoFrames(P);
        const typingRead = await stickRead(P);
        check(`${engine} stick: the other side's typing indicator came up`, !!ind, typingRead);
        at('the typing indicator up', typingRead);
        await shot(P, `stick-${engine}-typing`);
        // Their message arrives, then one with an address (its card is built from the address alone).
        let n = await rowCount(P);
        await O.keyboard.type(', and a reply');
        await O.keyboard.press('Enter');
        await until(async () => (await rowCount(P)) > n, 15000);
        await sleep(500);
        at('a message received', await stickRead(P));
        n = await rowCount(P);
        await O.locator(COMPOSER).fill(`see https://example.com/stick/${stamp}/a/long/path/that/goes/on/and/on/index.html`);
        await O.keyboard.press('Enter');
        await until(async () => (await rowCount(P)) > n, 15000);
        const card = await until(() => P.evaluate(() => {
            const rows = document.querySelectorAll('.messages-container > .message');
            return !!rows[rows.length - 1]?.querySelector('.link-preview-card');
        }), 8000);
        await twoFrames(P);
        const link = await stickRead(P);
        check(`${engine} stick: the newest message's link card is drawn`, !!card, link);
        at('a message with a link card received', link);
        n = await rowCount(P);
        await P.keyboard.press('Enter');
        await until(async () => (await rowCount(P)) > n, 15000);
        await sleep(800);
        at('your own message sent', await stickRead(P));
        await softKeyboard(P, engine, false);
        const down = await stickRead(P);
        if (phone) {
            check(`${engine} stick: the keyboard down, the bottom bar back`, !down.keyboardUp && down.nav !== 'none', down);
            at('the keyboard down', down);
        }
        await P.evaluate(() => document.activeElement?.blur?.());
        await sleep(400);

        // ── CONTROL: a reader 400 px up stays exactly where they are through all of it
        if (engine === 'iPhone') {
            // Playwright's mobile WebKit takes no wheel and no touch drag: the list is scrolled from
            // the page, which fires the same scroll events Chat.tsx reads a reader's scroll from.
            await P.evaluate(() => document.querySelector('.messages-container').scrollBy(0, -400));
        } else {
            const list = await P.locator('.messages-container').boundingBox();
            await P.mouse.move(list.x + list.width / 2, list.y + list.height / 2);
            await P.mouse.wheel(0, -400);
        }
        await sleep(700);
        const up0 = await stickRead(P);
        check(`${engine} stick: CONTROL - scrolled up to read (Jump to latest shown)`, up0.fromBottom >= 300 && up0.pill, up0);
        const stays = (label, r) => check(`${engine} stick: CONTROL - scrolled up: ${label}: still exactly where they were reading`, Math.abs(r.scrollTop - up0.scrollTop) <= 1 && r.pill, { was: up0.scrollTop, ...r });
        await focusBox();
        await softKeyboard(P, engine, true);
        if (phone) stays('the keyboard up', await stickRead(P));
        const typedUp = await typeUntil(phone ? 140 : 90);
        stays(`typing lines, after every keystroke (${typedUp.readings.length}; the one furthest from where they were)`, drifted(typedUp.readings, up0.scrollTop));
        await O.locator(COMPOSER).click();
        await O.keyboard.type('more');
        await until(() => P.evaluate(() => !!document.querySelector('.typing-indicator')), 8000);
        await twoFrames(P);
        const upTyping = await stickRead(P);
        check(`${engine} stick: CONTROL - scrolled up: the other side's typing indicator came up`, upTyping.typing, upTyping);
        stays('the typing indicator up', upTyping);
        n = await rowCount(P);
        await O.keyboard.press('Enter');
        await until(async () => (await rowCount(P)) > n, 15000);
        await sleep(500);
        stays('a message received', await stickRead(P));
        await softKeyboard(P, engine, false);
        if (phone) stays('the keyboard down', await stickRead(P));
        await P.locator(COMPOSER).fill('');
        await P.evaluate(() => document.activeElement?.blur?.());
        await O.locator(COMPOSER).fill('');

        // ── CONTROL: a reader ONE NOTCH up (100 px, inside the slop Chat.tsx still calls "at the
        // bottom", so no Jump to latest) is not pulled down by a change that is not theirs: the
        // other side's typing indicator, the keyboard (the review of this fix: it pinned them).
        await P.evaluate(() => { const sc = document.querySelector('.messages-container'); sc.scrollTop = sc.scrollHeight; });
        await sleep(600);
        await until(() => P.evaluate(() => !document.querySelector('.typing-indicator')), 12000);
        await twoFrames(P);
        if (engine === 'iPhone') {
            await P.evaluate(() => document.querySelector('.messages-container').scrollBy(0, -100));
        } else {
            const list = await P.locator('.messages-container').boundingBox();
            await P.mouse.move(list.x + list.width / 2, list.y + list.height / 2);
            await P.mouse.wheel(0, -100);
        }
        await sleep(700);
        const notch = await stickRead(P);
        check(`${engine} stick: CONTROL - one notch up (inside the slop: no Jump to latest)`, notch.fromBottom >= 60 && notch.fromBottom <= 120 && !notch.pill, notch);
        const keeps = (label, r) => check(`${engine} stick: CONTROL - one notch up: ${label}: still exactly where they were reading`, Math.abs(r.scrollTop - notch.scrollTop) <= 1, { was: notch.scrollTop, ...r });
        await O.locator(COMPOSER).click();
        await O.keyboard.type('typing again');
        await until(() => P.evaluate(() => !!document.querySelector('.typing-indicator')), 8000);
        await twoFrames(P);
        const notchTyping = await stickRead(P);
        check(`${engine} stick: CONTROL - one notch up: the other side's typing indicator came up`, notchTyping.typing, notchTyping);
        keeps('the typing indicator up', notchTyping);
        await O.locator(COMPOSER).fill('');
        await until(() => P.evaluate(() => !document.querySelector('.typing-indicator')), 12000);
        await twoFrames(P);
        const notchQuiet = await stickRead(P);
        check(`${engine} stick: CONTROL - one notch up: ...and went again`, !notchQuiet.typing, notchQuiet);
        keeps('the typing indicator gone again', notchQuiet);
        if (phone) {
            await focusBox();
            await softKeyboard(P, engine, true);
            keeps('the keyboard up', await stickRead(P));
            await softKeyboard(P, engine, false);
            await P.evaluate(() => document.activeElement?.blur?.());
        }
        await ctx.close();
    }
}

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
    const longName = 'announcements-and-updates';
    await mk(longName, 0);
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

    // ── settings, on the owner's DESKTOP: a mouse drag across a setting's hint selects the words to
    // copy and leaves the setting alone, as a native <label> does (review finding: the row-press
    // helper flipped and saved it). CONTROL: a plain click on the same hint does toggle it.
    if (want('settings')) {
        // The server was made through the API: open it, so the channel list (and its cog) is drawn.
        if (!ownerLive) {
            await O.reload({ waitUntil: 'domcontentloaded' });
            await sleep(2500);
            await dismiss(O);
            await O.locator(`.server-icon[data-server-id="${srv.id}"]`).first().click();
            await sleep(1000);
        }
        await O.locator('.sidebar .user-action-btn[title="Settings"]').first().click();
        await O.locator('.settings-nav-item', { hasText: 'Appearance' }).first().click();
        await sleep(400);
        const row = O.locator('.settings-option').filter({ has: O.locator('label:text-is("Compact Mode")') }).first();
        const box = row.locator('input[type="checkbox"]');
        const hint = row.locator('.option-hint');
        const before = await box.isChecked();
        const b = await hint.boundingBox();
        await O.mouse.move(b.x + 3, b.y + b.height / 2);
        await O.mouse.down();
        await O.mouse.move(b.x + b.width * 0.6, b.y + b.height / 2, { steps: 8 });
        await O.mouse.up();
        await sleep(300);
        const selected = await O.evaluate(() => String(getSelection()));
        check('desktop settings: a drag across "Compact Mode"\'s hint selected its words', selected.trim().length > 3, selected);
        check('desktop settings: ...and left the setting as it was', (await box.isChecked()) === before);
        await O.evaluate(() => getSelection().removeAllRanges());
        const preClick = await box.isChecked();
        await O.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        await sleep(300);
        check('desktop settings: CONTROL - a plain click on the hint toggles it', (await box.isChecked()) !== preClick);
        // A single click on words that are ALREADY selected toggles it, as a native label does
        // (Chromium skips only the click that ended a drag): the guard skipped it too (review low).
        const preSecond = await box.isChecked();
        await O.mouse.move(b.x + 3, b.y + b.height / 2);
        await O.mouse.down();
        await O.mouse.move(b.x + b.width * 0.6, b.y + b.height / 2, { steps: 8 });
        await O.mouse.up();
        await sleep(300);
        check('desktop settings: dragged across the hint again, its words selected, the setting left alone', (await O.evaluate(() => String(getSelection()))).trim().length > 3 && (await box.isChecked()) === preSecond);
        await O.mouse.click(b.x + b.width * 0.3, b.y + b.height / 2);
        await sleep(300);
        check('desktop settings: a single click on those selected words toggles it, at the first click', (await box.isChecked()) !== preSecond);
        if ((await box.isChecked()) !== before) { await box.click(); await sleep(300); }
        check('desktop settings: the setting is back as it was', (await box.isChecked()) === before);
        await O.locator('.settings-close').first().click();
        await sleep(300);
    }

    // ── friends, on the owner's DESKTOP: Friends' search boxes take their row. They are .search-bar
    // like the chat header's, whose Chat.css width (200 px, 280 on focus) held them to a stub of a
    // 900 px row (the phone rule fixed only phones).
    if (want('friends')) {
        await O.locator('.server-icon.home-button').first().click();
        await sleep(800);
        const measure = () => O.evaluate(() => {
            const i = [...document.querySelectorAll('.friends-dashboard .search-bar input')].find((x) => x.getBoundingClientRect().width > 0);
            const c = i?.closest('.friends-content');
            if (!i || !c) return null;
            const cs = getComputedStyle(c);
            return { input: Math.round(i.getBoundingClientRect().width), room: Math.round(c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) };
        });
        for (const [tab, label] of [['All', /^All$/], ['Pending', /^Pending/]]) {
            await O.locator('.friends-header-bar .header-tab', { hasText: label }).first().click();
            await sleep(400);
            const at = await measure();
            check(`desktop friends: the ${tab} tab's search box takes its row`, !!at && at.room > 400 && at.input >= at.room - 2, at);
            await O.locator('.friends-dashboard .search-bar input').filter({ visible: true }).first().focus();
            await sleep(400); // past the box's width transition
            const focused = await measure();
            check(`desktop friends: ...and keeps exactly its row with the focus (it jumped to 280 px)`, !!focused && Math.abs(focused.input - focused.room) <= 2, focused);
            await O.evaluate(() => document.activeElement?.blur?.());
        }
        await O.locator('.friends-dashboard .close-btn[aria-label="Close"]').first().click().catch(() => {});
        await sleep(300);
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
            // An empty composer's placeholder ("Message #channel") is one line: a second one is cut
            // in half under the one-line box. Here and in a channel with a long name.
            const oneLine = () => composer.evaluate((t) => ({ ph: t.placeholder, sh: t.scrollHeight, ch: t.clientHeight }));
            await composer.fill('');
            let ph = await oneLine();
            check(`${size} fields: the empty composer's placeholder is on one line`, ph.sh <= ph.ch + 1, ph);
            await openChannel(longName);
            ph = await oneLine();
            check(`${size} fields: ...in a channel with a long name too`, ph.ph.includes(longName) && ph.sh <= ph.ch + 1, ph);
            await shot(P, `fields-placeholder-${size}`);
            await openChannel(general.name);
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
            // The recovery form behind "Forgot your password?": its username and its 12-word box.
            await tap(L, L.locator('.forgot-password-link'));
            const rec = L.locator('#rec-code');
            check(`${size} fields: the recovery form opened`, !!await until(() => rec.count(), 6000));
            for (const [label, sel] of [['recovery username', '#rec-username'], ['recovery code box', '#rec-code']]) {
                const f = L.locator(sel);
                if (await f.count()) check(`${size} fields: the sign-in ${label} is 16px or more`, (await fontPx(f)) >= 16, `${await fontPx(f)}px`);
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
                    // A color-mix() stop computes to color(srgb r g b / a) (channels 0 to 1), which
                    // the canvas reads; it must be picked out too. A stop in any other space fails.
                    const stops = (cs.backgroundImage.match(/(?:rgba?|color|lab|lch|oklab|oklch|hsla?|hwb)\([^)]+\)|#[0-9a-f]{3,8}\b/gi) || []).map((s) => {
                        if (!/^(?:rgba?\(|color\(srgb |#)/i.test(s)) throw new Error(`a gradient stop this cannot read: ${s}`);
                        return rgba(s);
                    });
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
            // A tapped tab keeps a sticky :hover on touch: the line along the bar's top must stay
            // whole above it. Read from the screen: one row of pixels at the bar's top edge.
            await tap(P, P.locator('.mobile-nav-btn', { hasText: 'Chat' }).first());
            await sleep(300);
            const navTop = await P.evaluate(() => document.querySelector('.mobile-bottom-nav').getBoundingClientRect().top);
            const row = await P.screenshot({ clip: { x: 0, y: navTop, width: w, height: 1 } });
            const line = await P.evaluate(async (b64) => {
                const img = new Image();
                img.src = 'data:image/png;base64,' + b64;
                await img.decode();
                const c = document.createElement('canvas'); c.width = img.width; c.height = 1;
                const g = c.getContext('2d'); g.drawImage(img, 0, 0);
                const d = g.getImageData(0, 0, img.width, 1).data;
                const ref = [d[8], d[9], d[10]];
                let off = 0;
                for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - ref[0]) + Math.abs(d[i + 1] - ref[1]) + Math.abs(d[i + 2] - ref[2]) > 24) off++;
                return { pixels: d.length / 4, off };
            }, row.toString('base64'));
            check(`${size} nav: the line along the bar's top is whole above the tab just tapped`, line.off === 0, line);
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
            const esc = await P.evaluate(() => [...document.querySelectorAll('.settings-close *')].filter((e) => e.children.length === 0 && /^\s*esc\s*$/i.test(e.textContent) && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0).length);
            check(`${size} settings: no "ESC" key hint on a phone's close button`, esc === 0, { shown: esc });
            // ...but its X stays, with either icon style: Classic draws it as a <span> emoji, which a
            // bare `span` rule hid along with the hint (review finding). Drawn = some leaf of the
            // button other than the hint has a box and is not hidden.
            const closeGlyph = () => P.evaluate(() => {
                const btn = document.querySelector('.settings-close');
                const leaves = [...btn.querySelectorAll('*')].filter((e) => !/^\s*esc\s*$/i.test(e.textContent ?? ''));
                const hiddenUpTo = (e) => { for (let x = e; x && x !== btn; x = x.parentElement) if (getComputedStyle(x).display === 'none') return true; return false; };
                const drawn = leaves.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(e).visibility !== 'hidden' && !hiddenUpTo(e); });
                return { drawn: drawn.map((e) => `${e.tagName.toLowerCase()}.${String(e.getAttribute('class') ?? '')}`), text: btn.textContent.trim() };
            });
            const modern = await closeGlyph();
            check(`${size} settings: CONTROL - with Modern icons the close button draws its X`, modern.drawn.length > 0, modern);
            const styleSelect = P.locator('#icon-style-select');
            await styleSelect.selectOption('classic');
            await sleep(400);
            const classic = await closeGlyph();
            check(`${size} settings: with Classic icons the close button still draws its X`, classic.drawn.length > 0 && /✕/.test(classic.text), classic);
            await styleSelect.selectOption('modern');
            await sleep(300);
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
            // The tapped button keeps :hover on a touch screen until the next tap elsewhere: it must
            // not paint a box then (it drew the grey hover box). What it may paint is the header's
            // own colour (mobile.css: a touch button's :hover inherits), which is no box at all.
            // A headless tap leaves no :hover behind (review: the check passed either way), so the
            // state a real phone keeps is forced on the button through DevTools.
            const cdp = await P.context().newCDPSession(P);
            await cdp.send('DOM.enable');
            await cdp.send('CSS.enable');
            const { root: doc } = await cdp.send('DOM.getDocument', { depth: 0 });
            const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '.chat-header .checklist-toggle-btn' });
            await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
            const after = await P.evaluate(() => {
                const btn = document.querySelector('.chat-header .checklist-toggle-btn');
                return { hovered: btn.matches(':hover'), bg: getComputedStyle(btn).backgroundColor, header: getComputedStyle(document.querySelector('.chat-header')).backgroundColor };
            });
            await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
            await cdp.detach();
            check(`${size} toggle: with the :hover a tap leaves on a touch screen, the checklist button paints no box`, after.hovered && (/rgba\(0, 0, 0, 0\)|transparent/.test(after.bg) || after.bg === after.header), after);
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

        // ── link: a long address's card (built in the app from the address: nothing is fetched)
        if (want('link')) {
            const url = `https://example.org/a/very/long/path/that/does/not/wrap/on/a/phone/screen/${size}?with=query&and=more`;
            check(`${size} link: posted a long address`, await say(P, url));
            const card = P.locator('.messages-container > .message').last().locator('.link-preview-card');
            check(`${size} link: its card is drawn`, !!await until(() => card.count(), 6000));
            if (await card.count()) {
                const m = await card.first().evaluate((c) => {
                    const d = c.querySelector('.link-preview-description');
                    const cr = c.getBoundingClientRect();
                    const lines = (() => { const r = document.createRange(); r.selectNodeContents(d); return [...r.getClientRects()].map((x) => ({ l: x.left, r: x.right })); })();
                    return { sw: d.scrollWidth, cw: d.clientWidth, card: { l: cr.left, r: cr.right }, lines };
                });
                check(`${size} link: the address in the card is not cut off sideways`, m.sw <= m.cw + 1, { scrollWidth: m.sw, clientWidth: m.cw });
                check(`${size} link: every line of it is inside the card`, m.lines.length > 0 && m.lines.every((l) => l.r <= m.card.r + 1), m);
                await card.first().scrollIntoViewIfNeeded();
                await shot(P, `link-${size}`);
            }
        }

        // ── tasks: the Tasks view's empty state
        if (want('tasks')) {
            await nav(P, 'Tasks');
            const empty = P.locator('.tasks-editor-empty').first();
            check(`${size} tasks: the Tasks view opened on its empty state`, !!await until(() => empty.count(), 6000));
            if (await empty.count()) {
                // The glyphs only: a Range over the whole box also returns each element's own box.
                const m = await empty.evaluate((e) => {
                    const rects = [];
                    const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
                    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                        if (!n.textContent.trim()) continue;
                        const r = document.createRange(); r.selectNodeContents(n);
                        rects.push(...[...r.getClientRects()].filter((x) => x.width > 1));
                    }
                    return { vw: innerWidth, lines: rects.length, l: Math.min(...rects.map((x) => x.left)), r: Math.max(...rects.map((x) => x.right)) };
                });
                check(`${size} tasks: its words keep at least 12px from both edges of the screen`, m.l >= 12 && m.r <= m.vw - 12, m);
                await shot(P, `tasks-${size}`);
                // Trash (TasksTrash) is drawn in the same box when something is in it: its rows keep
                // their own alignment and width (review finding: a centred, padded box reached them).
                // TasksTrash's own markup, put where TasksView puts it, through the real stylesheet.
                const t = await empty.evaluate((e) => {
                    const trash = document.createElement('section');
                    trash.className = 'tasks-trash';
                    trash.innerHTML = '<p class="tasks-trash-copy">Lists in the trash stay until you delete them forever.</p><ul class="tasks-trash-list"><li class="tasks-trash-row"><span class="tasks-trash-title">A trashed list</span></li></ul>';
                    e.appendChild(trash);
                    const out = { copy: getComputedStyle(trash.querySelector('.tasks-trash-copy')).textAlign, title: getComputedStyle(trash.querySelector('.tasks-trash-title')).textAlign, boxPadding: getComputedStyle(e).paddingLeft };
                    trash.remove();
                    return out;
                });
                check(`${size} tasks: Trash under the empty state keeps its rows' own alignment and the box no side padding`, t.copy !== 'center' && t.title !== 'center' && t.boxPadding === '0px', t);
            }
            // The bottom bar's Chat leaves the Tasks view for the channel under it.
            await nav(P, 'Chat');
            await sleep(400);
            const back = await P.evaluate(() => {
                const t = document.querySelector('.tasks-editor-empty, .tasks-view');
                const shown = !!t && t.getBoundingClientRect().width > 0 && getComputedStyle(t).visibility !== 'hidden'
                    && (() => { const r = t.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && t.contains(h); })();
                const f = document.querySelector('form.message-form textarea');
                const r = f?.getBoundingClientRect();
                const h = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return { tasksOnTop: shown, composerHit: !!h && (h === f || f.contains(h)), chatActive: !!document.querySelector('.mobile-nav-btn.active')?.textContent?.match(/chat/i) };
            });
            check(`${size} tasks: Chat in the bottom bar goes back to the channel (the Tasks view is gone, the composer is what a tap hits)`, !back.tasksOnTop && back.composerHit, back);
            check(`${size} tasks: ...and Chat is the tab lit`, back.chatActive, back);
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
                check(`${size} mention: a tap on the row lands on it`, await tap(P, row), lastHit);
                await sleep(300);
                const v = await box.inputValue();
                check(`${size} mention: the tap put the name in the box`, v.startsWith('@' + phoneName), v);
            }
            await box.fill('');
        }

        // ── friends: Friends' Add Friend tab is whole on screen, with no scrolling
        if (want('friends')) {
            await nav(P, 'Servers');
            await tap(P, P.locator('.server-icon.home-button').first());
            await sleep(900);
            const addShown = () => P.evaluate(() => {
                const bar = [...document.querySelectorAll('.friends-header-bar')].find((x) => x.querySelector('.add-friend-btn'));
                const r = bar?.getBoundingClientRect();
                return !!r && r.width > 0 && r.top >= 0 && r.bottom <= innerHeight;
            });
            if (!await until(addShown, 3000)) await nav(P, 'Chat');
            check(`${size} friends: the Friends page is on screen`, !!await until(addShown, 6000));
            const m = await P.evaluate(() => {
                const bar = [...document.querySelectorAll('.friends-header-bar')].find((x) => x.querySelector('.add-friend-btn'));
                if (!bar) return null;
                const add = bar.querySelector('.add-friend-btn'), row = bar.querySelector('.header-left'), acts = bar.querySelector('.header-actions');
                const a = add.getBoundingClientRect(), rr = row.getBoundingClientRect(), x = acts.getBoundingClientRect();
                const h = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
                return { vw: innerWidth, add: { l: a.left, r: a.right }, row: { r: rr.right, scroll: row.scrollWidth - row.clientWidth, left: row.scrollLeft }, actionsLeft: x.left, hit: !!h && (h === add || add.contains(h)) };
            });
            check(`${size} friends: Add Friend is whole, inside the window and its row, left of the close button`, !!m && m.add.l >= 0 && m.add.r <= m.vw && m.add.r <= m.row.r + 0.5 && m.add.r <= m.actionsLeft + 0.5, m);
            check(`${size} friends: the tab row needs no sideways scroll to show it`, !!m && m.row.scroll <= 1 && m.row.left === 0, m);
            check(`${size} friends: the middle of Add Friend is Add Friend (a tap lands on it)`, !!m && m.hit, m);
            await shot(P, `friends-${size}`);
            // Friends' own search box (the All tab) takes its row: it shares .search-bar with the
            // chat header, whose phone width (88px, 120px before) reached it (review finding).
            await tap(P, P.locator('.friends-header-bar .header-tab', { hasText: /^All$/ }).first());
            await sleep(500);
            const fsb = await P.evaluate(() => {
                const i = [...document.querySelectorAll('.friends-dashboard .search-bar input')].find((x) => x.getBoundingClientRect().width > 0);
                const c = i?.closest('.friends-content') ?? i?.parentElement?.parentElement;
                if (!i || !c) return null;
                const cs = getComputedStyle(c);
                return { input: Math.round(i.getBoundingClientRect().width), room: Math.round(c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)), font: parseFloat(getComputedStyle(i).fontSize) };
            });
            check(`${size} friends: the All tab's search box takes its row`, !!fsb && fsb.input >= fsb.room - 2, fsb);
            // Chat.css's top-level `.search-bar input` (0.85rem) loads after FriendsPanel.css and beat its
            // `.friends-dashboard input { font-size: 16px }` once the phone rule was scoped to the header
            // (release review): under 16px an iPhone zooms the page on focus.
            check(`${size} friends: the All tab's search box is 16px or more`, !!fsb && fsb.font >= 16, fsb);
            await openServer(srv.id);
            await openChannel(general.name);
        }

        // ── names: the channel's name in the header keeps its room; the search box's word fits
        if (want('names')) {
            await openChannel(longName);
            const hd = await P.evaluate(() => {
                const hdr = document.querySelector('.chat-header'), h2 = hdr.querySelector('h2'), inp = hdr.querySelector('.search-bar input');
                // The box's own words, put in it as its value (the placeholder is drawn in the
                // same place): cut off when the text runs wider than the box. Set and taken out
                // without an input event, so nothing is searched.
                const before = inp.value;
                inp.value = inp.placeholder;
                const fit = { sw: inp.scrollWidth, cw: inp.clientWidth };
                inp.value = before;
                return { name: h2.getBoundingClientRect().width, em: parseFloat(getComputedStyle(h2).fontSize), placeholder: inp.placeholder, ...fit };
            });
            check(`${size} names: the search box's own words fit in it ("${hd.placeholder}")`, hd.sw <= hd.cw + 1, hd);
            check(`${size} names: the channel's name keeps at least four letters' room`, hd.name >= 4 * hd.em - 1, hd);
            // Under pressure: something wide beside it must not squeeze the name to nothing.
            const pressed = await P.evaluate(() => {
                const hdr = document.querySelector('.chat-header'), h2 = hdr.querySelector('h2');
                const wide = document.createElement('span');
                wide.style.cssText = 'flex: 0 0 auto; width: 220px; height: 10px;';
                h2.after(wide);
                const r = { name: h2.getBoundingClientRect().width, em: parseFloat(getComputedStyle(h2).fontSize) };
                wide.remove();
                return r;
            });
            check(`${size} names: ...with something 220px wide beside it, still four letters`, pressed.name >= 4 * pressed.em - 1, pressed);
            await shot(P, `names-header-${size}`);
            await openChannel(general.name);
        }

        // ── keyboard: the bottom bar steps aside while the soft keyboard is up for a text field
        if (want('keyboard')) {
            const box = P.locator(COMPOSER);
            await tap(P, box);
            await sleep(300);
            const s0 = await P.evaluate(() => ({ focused: document.activeElement?.tagName, up: 'keyboardUp' in document.documentElement.dataset, nav: getComputedStyle(document.querySelector('.mobile-bottom-nav')).display }));
            check(`${size} keyboard: CONTROL - the box focused and no keyboard (a hardware one): the bar stays`, s0.focused === 'TEXTAREA' && !s0.up && s0.nav !== 'none', s0);
            // <html data-keyboard-up> is what api/keyboardUp.ts sets when the Android app or the
            // visual viewport says the keyboard is up (keyboardUp.test.ts); a headless browser has no
            // soft keyboard, so this measures the layout it gives through the real stylesheet.
            const s1 = await P.evaluate(async () => {
                const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
                document.documentElement.dataset.keyboardUp = '';
                await frame();
                const nav = document.querySelector('.mobile-bottom-nav'), main = document.querySelector('.chat-main'), form = document.querySelector('form.message-form');
                const out = { nav: getComputedStyle(nav).display, mainGap: Math.round(innerHeight - main.getBoundingClientRect().bottom), formGap: Math.round(innerHeight - form.getBoundingClientRect().bottom) };
                delete document.documentElement.dataset.keyboardUp;
                await frame();
                out.navAfter = getComputedStyle(nav).display;
                out.mainGapAfter = Math.round(innerHeight - main.getBoundingClientRect().bottom);
                return out;
            });
            check(`${size} keyboard: with the keyboard up the bottom bar is gone`, s1.nav === 'none', s1);
            check(`${size} keyboard: ...and the chat, its message box with it, comes down to the keyboard`, s1.mainGap <= 1 && s1.formGap <= 12, s1);
            check(`${size} keyboard: with it down again the bar is back and the chat above it`, s1.navAfter !== 'none' && s1.mainGapAfter >= 40, s1);
            await box.evaluate((el) => el.blur());
        }

        // ── longpress: on Android a long press is the message menu, so the rows take no selection
        if (want('longpress') && first) {
            if ((await rowCount(P)) === 0) await say(P, 'Long press check');
            const UAS = [
                ['Android', 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', true],
                ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', false],
            ];
            for (const [label, ua, android] of UAS) {
                const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: ua });
                const A = await signIn(c, phoneName, `${label} ${size}`, false);
                await nav(A, 'Servers');
                await tap(A, A.locator(`.server-icon[data-server-id="${srv.id}"]`).first());
                await sleep(1000);
                await nav(A, 'Channels');
                await tap(A, A.locator('.sidebar .channel-list .channel').filter({ has: A.locator(`.channel-name:text-is("${general.name}")`) }).first());
                await sleep(1500);
                const st = await A.evaluate(() => {
                    const us = (q) => { const e = document.querySelector(q); if (!e) return 'absent'; const cs = getComputedStyle(e); return cs.userSelect || cs.webkitUserSelect; };
                    // A field inside a message, as editing one puts there: Chromium inherits
                    // user-select, so it must be given back its own (the composer is not inside one).
                    const row = document.querySelector('.messages-container > .message');
                    const edit = document.createElement('textarea');
                    row?.appendChild(edit);
                    const inMessage = row ? (getComputedStyle(edit).userSelect || getComputedStyle(edit).webkitUserSelect) : 'absent';
                    edit.remove();
                    return { marked: 'longPressMenu' in document.documentElement.dataset, message: us('.messages-container > .message'), member: us('.member-item'), channel: us('.sidebar .channel-list .channel'), composer: us('form.message-form textarea'), inMessage };
                });
                if (android) check(`${size} longpress: Android - a message, a member and a channel take no text selection`, st.marked && st.message === 'none' && st.member === 'none' && st.channel === 'none', st);
                else check(`${size} longpress: an iPhone still selects a message's words (no long-press menu there: it is how it copies)`, !st.marked && st.message !== 'none' && st.message !== 'absent', st);
                check(`${size} longpress: ${label} - a field inside a message (editing it) and the message box keep their own selection`, st.inMessage !== 'none' && st.inMessage !== 'absent' && st.composer !== 'none' && st.composer !== 'absent', st);
                await c.close();
            }
        }

        // ── faint: hints, timestamps and offline members at 4.5:1, all eight themes x contrast
        if (want('faint') && first) {
            const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
            const bad = [];
            let readings = 0;
            for (const theme of THEMES) for (const hc of [false, true]) {
                await P.evaluate(([theme, hc]) => {
                    document.documentElement.setAttribute('data-theme', theme);
                    document.documentElement.setAttribute('data-contrast', hc ? 'high' : 'normal');
                }, [theme, hc]);
                await sleep(120);
                const r = await P.evaluate((theme) => {
                    const c = document.createElement('canvas'); c.width = c.height = 1;
                    const g = c.getContext('2d', { willReadFrequently: true });
                    const rgba = (s) => { g.clearRect(0, 0, 1, 1); g.fillStyle = 'rgba(0,0,0,0)'; g.fillStyle = s; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
                    const lin = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
                    const lum = ([r, gr, b]) => 0.2126 * lin(r) + 0.7152 * lin(gr) + 0.0722 * lin(b);
                    const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
                    const over = (t, u) => [0, 1, 2].map((i) => t[i] * t[3] + u[i] * (1 - t[3])).concat(1);
                    const probe = (token, prop) => { const e = document.createElement('span'); e.style[prop] = `var(${token})`; document.body.appendChild(e); const v = getComputedStyle(e)[prop]; e.remove(); return v; };
                    const faint = rgba(probe('--text-faint', 'color'));
                    // The surfaces its words sit on at rest. Light's --bg-quaternary is a hover and
                    // pressed shade, not a surface words rest on: read and printed, not held to 4.5.
                    const surfaces = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-floating', '--bg-hover', '--input-bg', '--bg-quaternary'];
                    const out = surfaces.map((sf) => ({ sf, ratio: ratio(faint, over(rgba(probe(sf, 'backgroundColor')), [0, 0, 0, 1])), held: !(theme === 'light' && sf === '--bg-quaternary') }));
                    // An offline member, as Chat.tsx draws one, in the real member list.
                    const list = document.querySelector('.member-sidebar ul');
                    let offline = null;
                    if (list) {
                        const li = document.createElement('li');
                        li.className = 'member-item offline clickable';
                        li.innerHTML = '<div class="member-avatar"><span>O</span></div><span class="member-name">offline_member</span>';
                        list.appendChild(li);
                        const name = li.querySelector('.member-name');
                        let op = 1;
                        for (let e = name; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
                        let bg = [0, 0, 0, 1];
                        for (let e = li; e; e = e.parentElement) { const col = rgba(getComputedStyle(e).backgroundColor); if (col[3] > 0) { bg = over(col, [0, 0, 0, 1]); break; } }
                        const col = rgba(getComputedStyle(name).color);
                        offline = ratio(over([col[0], col[1], col[2], col[3] * op], bg), bg);
                        li.remove();
                    }
                    return { out, offline };
                }, theme);
                const tag = `${theme}${hc ? '+hc' : ''}`;
                for (const o of r.out) {
                    readings++;
                    if (o.held && o.ratio < 4.5) bad.push(`${tag} faint on ${o.sf} ${o.ratio.toFixed(2)}`);
                    if (!o.held) console.log(`  (read, not held) ${tag} faint on ${o.sf} ${o.ratio.toFixed(2)}`);
                }
                readings++;
                if (r.offline === null || r.offline < 4.5) bad.push(`${tag} offline member ${r.offline === null ? 'not drawn' : r.offline.toFixed(2)}`);
            }
            await P.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.setAttribute('data-contrast', 'normal'); });
            check(`${size} faint: --text-faint 4.5:1 on every surface it rests on, an offline member's name 4.5:1, all eight themes x contrast (${readings} readings)`, bad.length === 0, bad.slice(0, 10));
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
                // The in-app fullscreen (mediaFullscreen.ts route 3, where nothing can go fullscreen:
                // an iPhone) moves the button inside the safe areas at 44px. Its state put on this
                // tile through the real stylesheet: the badge must follow (it sat on the button).
                const fs = await tile.evaluate(async (t) => {
                    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
                    // A phone turned with its notch to the right: the button moves 40px in. With
                    // no inset the old rule kept them apart by luck, and could not fail (review).
                    document.documentElement.style.setProperty('--safe-area-right', '40px');
                    document.documentElement.dataset.mediaFullscreen = '';
                    t.classList.add('is-app-fullscreen');
                    await frame();
                    const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
                    const a = box(t.querySelector('.vs-live-badge')), b = box(t.querySelector('.vs-fullscreen-btn'));
                    const overlap = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
                    t.classList.remove('is-app-fullscreen');
                    delete document.documentElement.dataset.mediaFullscreen;
                    document.documentElement.style.removeProperty('--safe-area-right');
                    await frame();
                    return { badge: a, button: b, overlap, vw: innerWidth };
                });
                check(`${size} live: in the in-app fullscreen (a 40px safe area at the side) the LIVE badge stays clear of the 44px button, on screen`, fs.overlap === 0 && fs.button.r - fs.button.l >= 43.5 && fs.badge.l >= 0, fs);
                // The call view's header: the room's whole name ("2 people" sat beside it).
                const vh = await P.evaluate(() => { const n = document.querySelector('.voice-stage-name'); return n && { text: n.textContent, whole: n.scrollWidth <= n.clientWidth + 1, w: Math.round(n.getBoundingClientRect().width) }; });
                check(`${size} live: the call view's header shows the room's whole name`, !!vh && vh.whole && vh.w > 0, vh);
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
            // The bar shows the room's whole name: the Encrypted badge's words squeezed it to "Lo..."
            // at 390 and to nothing at 360. The badge is its lock there, still named in full.
            const cb = await P.evaluate(() => {
                const p = document.querySelector('.voice-panel-compact');
                const n = p?.querySelector('.voice-channel-name');
                if (!n) return null;
                const vis = (e) => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
                const badge = p.querySelector('.voice-e2ee');
                return { text: n.textContent, w: Math.round(n.getBoundingClientRect().width), whole: n.scrollWidth <= n.clientWidth + 1, lock: vis(badge?.querySelector('.voice-e2ee-lock svg')), words: vis(badge?.querySelector('.voice-e2ee-label')), named: badge?.getAttribute('aria-label') ?? null };
            });
            check(`${size} live: the call bar shows the room's whole name`, !!cb && cb.whole && cb.w > 0, cb);
            check(`${size} live: ...beside the encryption badge drawn as its lock, still named in full for a screen reader`, !!cb && cb.lock && !cb.words && /encryption/i.test(cb.named ?? ''), cb);
            // Sideways, watching the owner's stream with the owner's camera on: the camera strip and
            // the call bar floating over the picture do not overlap (the bar covered the cameras).
            const watch = P.locator('.voice-stage-tile .vs-watch-btn').first();
            if (await watch.count()) {
                await tap(P, watch);
                await sleep(1500);
                await P.setViewportSize({ width: h, height: w });
                await sleep(1500);
                const sideways = () => P.evaluate(() => {
                    const take = document.documentElement.dataset.streamTakeover ?? null;
                    const chrome = document.documentElement.dataset.streamChrome ?? null;
                    const rail = document.querySelector('.stream-stage .camera-rail'), bar = document.querySelector('.voice-panel-compact');
                    const box = (e) => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; };
                    if (!rail || !bar) return { take, chrome, rail: !!rail, bar: !!bar };
                    const a = box(rail), b = box(bar);
                    const overlap = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
                    const tile = rail.querySelector('.camera-rail-tile');
                    const tr = tile && tile.getBoundingClientRect();
                    const hit = tr && document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
                    return { take, chrome, rail: a, bar: b, overlap, tileSeen: !!hit && tile.contains(hit), vh: innerHeight };
                });
                const sw = await until(async () => { const r = await sideways(); return r.take && r.rail && r.bar ? r : null; }, 8000) || await sideways();
                check(`${size} sideways: the stream takes the screen, with the camera strip and the call bar on it`, sw.take === 'landscape' && typeof sw.rail === 'object' && typeof sw.bar === 'object', sw);
                check(`${size} sideways: the camera strip and the call bar do not overlap`, sw.overlap === 0, sw);
                check(`${size} sideways: the middle of the camera's tile is the camera, not the bar over it`, sw.tileSeen === true, sw);
                await shot(P, `sideways-camera-${h}x${w}`);
                // A tap on the picture hides the controls: the strip is back at the bottom edge.
                await P.touchscreen.tap(Math.round(h / 2), Math.round(w / 3));
                await sleep(700);
                const hid = await sideways();
                check(`${size} sideways: controls hidden, the strip is back down at the bottom`, hid.chrome === 'hidden' && typeof hid.rail === 'object' && hid.rail.b >= hid.vh - 2, hid);
                await P.touchscreen.tap(Math.round(h / 2), Math.round(w / 3));
                await sleep(500);
                await P.setViewportSize({ width: w, height: h });
                await sleep(1000);
                await P.locator('.stream-stage-header .back-to-chat-btn').first().tap().catch(() => {});
                await sleep(600);
            } else {
                check(`${size} sideways: the owner's tile offers Watch stream`, false);
            }
            await tap(P, P.locator('[data-testid="voice-leave"]').first()).catch(() => {});
            await sleep(800);
        }

        await ctx.close();
    }

    // ── stick: the newest message stays at the message box while the phone types
    if (want('stick')) await stickWalk(O, srv, phoneName);
} catch (e) {
    check('the walk ran to the end', false, String(e?.stack || e).slice(0, 600));
} finally {
    await browser.close();
    await wk?.close();
}
console.log(`\n${failures} failure(s)`);
process.exit(failures);
