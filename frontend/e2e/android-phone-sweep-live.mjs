// LIVE, on the ANDROID APP: four things a browser cannot show, from the phone sweep (2026-11-12),
// on the real debug APK on a HEADLESS emulator, with the phone's own gestures (adb input), never a
// script's click:
//
//   back       Android's BACK closes what is open on top and the app stays in front: the long-press
//              message menu, then Settings. With nothing open, Back sends the app to the background
//              as it always did (CONTROL). Before, Back left the app from every menu and dialog
//              (hooks/useBackClose.ts, api/mobileApp.ts interceptBack).
//   longpress  A real long press on a message opens Púca's menu and selects no words (it also
//              highlighted the word under the finger, with handles and Android's Copy bar).
//   stick      (2026-11-16) The newest message stays at the message box through the REAL soft
//              keyboard: a real tap raises it (the WebView resized), words typed through adb grow the
//              box to its ceiling, Enter sends, Back closes it; CONTROL: a reader a real finger
//              scrolled up keeps their exact scrollTop through all of it. This passes on the bundle
//              from before components/repinOnResize.ts too, by design: the Android WebView keeps a
//              list that is at its bottom there by itself (no script wrote scrollTop: it moved in
//              the frame the list shrank), which desktop Chromium and WebKit do not
//              (mobile-ui-sweep-walk.mjs's `stick` is the negative control). It guards the Android
//              app against a change that fights or undoes that.
//   keyboard   A tap on the message box raises the soft keyboard and the bottom tab bar steps aside
//              (<html data-keyboard-up>, api/keyboardUp.ts), the box at the keyboard's top. Back
//              closes the keyboard with the box still focused, and the bar comes back.
//
// Needs: a THROWAWAY backend + Postgres reachable on the host as API, and the debug APK of this tree
// installed on SERIAL, its bundle built with VITE_API_URL = API and PUCA_ALLOW_LOCAL_BUILD=1, with
// `adb reverse tcp:<api port> tcp:<api port>`. The APK refuses cleartext http, so a test build needs
// the LOCAL, uncommitted debug overlay android-share-live.mjs's header describes (cleartext to
// 127.0.0.1 alone); delete it after the run. Only an emulator-NNNN serial is accepted. The emulator
// runs with -no-window -no-audio; nothing here plays a sound or opens a window on the desktop.
//
// Usage: SERIAL=emulator-5584 API=http://127.0.0.1:5471 [OUT=dir] node e2e/android-phone-sweep-live.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERIAL = process.env.SERIAL || '';
const API = (process.env.API || 'http://127.0.0.1:5471').replace(/\/$/, '');
const OUT = process.env.OUT || '';
if (!/^emulator-\d+$/.test(SERIAL)) {
    console.error('SERIAL must name an emulator (emulator-NNNN); refusing to touch any other device.');
    process.exit(2);
}
if (!['127.0.0.1', 'localhost'].includes(new URL(API).hostname)) {
    console.error(`this creates an account: API must be loopback (API=${API})`);
    process.exit(2);
}
const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const sh = (cmd) => adb('shell', cmd).toString('utf8');
const PKG = 'com.sovereign.app';
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 300) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(step); }
    return last;
}
let failed = 0;
const step = (what) => console.log(`--    ${what}`);
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
    if (!ok) failed++;
    return ok;
};
const save = (name, bytes) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), bytes); } };
const screencap = (name) => save(name, adb('exec-out', 'screencap', '-p'));

/** Is the app the window in front? (After a Back that leaves, the launcher is.) */
const appInFront = () => /mCurrentFocus=.*com\.sovereign\.app/.test(sh('dumpsys window | grep mCurrentFocus'));
const imeShown = () => /mInputShown=true/.test(sh('dumpsys input_method | grep mInputShown'));
const back = () => sh('input keyevent KEYCODE_BACK');

function webViewBox() {
    sh('uiautomator dump /sdcard/puca-ui.xml >/dev/null 2>&1');
    const xml = sh('cat /sdcard/puca-ui.xml');
    for (const m of xml.matchAll(/<node [^>]*class="android\.webkit\.WebView"[^>]*>/g)) {
        const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(m[0]);
        if (b) return { left: +b[1], top: +b[2] };
    }
    return { left: 0, top: 0 };
}
let wv = null;
/** Where on the SCREEN (device px) the middle of a page element is. */
async function onScreen(page, selector, pick = 'last', text = null) {
    const r = await page.evaluate(([sel, pick, text]) => {
        const all = [...document.querySelectorAll(sel)].filter(x => x.offsetParent !== null && (text === null || x.textContent.trim().toLowerCase() === text.toLowerCase()));
        const e = pick === 'first' ? all[0] : all[all.length - 1];
        if (!e) return null;
        e.scrollIntoView({ block: 'nearest' });
        const b = e.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2, dpr: devicePixelRatio };
    }, [selector, pick, text]);
    if (!r) return null;
    wv ??= webViewBox();
    return { x: Math.round(wv.left + r.x * r.dpr), y: Math.round(wv.top + r.y * r.dpr) };
}
async function realTap(page, selector, pick, text = null) {
    const p = await onScreen(page, selector, pick, text);
    if (p) sh(`input tap ${p.x} ${p.y}`);
    return !!p;
}
async function longPress(page, selector) {
    const p = await onScreen(page, selector);
    if (p) sh(`input swipe ${p.x} ${p.y} ${p.x} ${p.y} 1100`);
    return !!p;
}

let forwarded = false;
const browsers = [];
try {
    step('a fresh app');
    const attached = execFileSync(ADB, ['devices'], { encoding: 'utf8' });
    if (!attached.split('\n').some(l => l.trim().startsWith(SERIAL) && /\bdevice\b/.test(l))) throw new Error(`${SERIAL} is not attached`);
    sh(`pm clear ${PKG}`);
    sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh('cmd statusbar collapse');
    sh(`am start -W -n ${PKG}/.MainActivity`);
    const pid = (await until(() => sh(`pidof ${PKG}`).trim(), 30000)) || '';
    await until(() => sh('cat /proc/net/unix').includes(`webview_devtools_remote_${pid}`), 30000);
    adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);
    forwarded = true;
    const b = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`), 30000, 1000);
    browsers.push(b);
    const P = await until(() => b.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://localhost')), 30000);
    if (!P) throw new Error('the page of the app did not appear');

    step('signing up');
    await P.getByPlaceholder('Enter username').waitFor({ timeout: 90000 });
    await P.locator('.toggle-mode').click();
    await P.getByPlaceholder('Enter username').fill(`andsweep_${stamp}`);
    await P.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await P.locator('button.login-button[type="submit"]').click();
    await P.waitForURL('**/chat', { timeout: 90000 });
    await sleep(2500);
    for (let i = 0; i < 3; i++) {
        if (await P.locator('.recovery-confirm input[type="checkbox"]').count()) {
            await P.locator('.recovery-confirm input[type="checkbox"]').first().check().catch(() => {});
            await P.locator('.recovery-done-btn').first().click().catch(() => {});
        }
        if (await P.locator('.welcome-popup-close').count()) await P.locator('.welcome-popup-close').first().click().catch(() => {});
        await sleep(400);
    }
    const api = (method, p, body) => P.evaluate(async ({ API, method, p, body }) => {
        const r = await fetch(API + p, { method, headers: { authorization: `Bearer ${localStorage.getItem('auth_token')}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        if (!r.ok) throw new Error(`${method} ${p}: ${r.status}`);
        return r.json();
    }, { API, method, p, body });
    const srv = await api('POST', '/servers', { name: 'Sweep ' + stamp.slice(-4) });
    await api('POST', `/servers/${srv.id}/channels`, { name: 'general', channel_type: 0 }).catch(() => null);
    await P.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const navTo = async (label) => { await realTap(P, '.mobile-nav-btn', 'first', label); await sleep(700); };
    await navTo('Servers');
    await realTap(P, `.server-icon[data-server-id="${srv.id}"]`, 'first');
    await sleep(1200);
    await navTo('Channels');
    await realTap(P, '.sidebar .channel-list .channel', 'first');
    await sleep(1500);

    // ── stick: the newest message stays at the message box while the real keyboard is up
    step('the newest message and the soft keyboard');
    {
        const COMPOSER = 'form.message-form textarea';
        const rows = () => P.evaluate(() => document.querySelectorAll('.messages-container > .message').length);
        for (let i = 0; i < 20; i++) {
            const n = await rows();
            await P.locator(COMPOSER).fill(`History ${i}: a few words so the list has rows to scroll through ${'and more '.repeat(i % 4)}`);
            await P.locator(COMPOSER).press('Enter');
            await until(async () => (await rows()) > n, 15000, 150);
        }
        await P.evaluate(() => document.activeElement?.blur());
        await sleep(1200);
        if (imeShown()) { back(); await sleep(1200); }
        const read = () => P.evaluate(() => {
            const sc = document.querySelector('.messages-container');
            const all = sc.querySelectorAll(':scope > .message');
            const last = all[all.length - 1];
            const box = document.querySelector('form.message-form');
            return {
                fromBottom: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight),
                toBox: Math.round(box.getBoundingClientRect().top - last.getBoundingClientRect().bottom),
                scrollTop: Math.round(sc.scrollTop), list: sc.clientHeight,
                boxPx: Math.round(box.querySelector('textarea').getBoundingClientRect().height),
                keyboardUp: 'keyboardUp' in document.documentElement.dataset, vh: innerHeight,
            };
        });
        const at = (label, r) => check(`stick: ${label}: the newest message is at the message box`, r.fromBottom <= 1 && r.toBox >= 0, r);
        /** The keyboard's slide and the WebView's resize are over: the page's height holds still. */
        const settled = async () => { let h = -1; for (let i = 0; i < 20; i++) { const r = await read(); if (r.vh === h) return r; h = r.vh; await sleep(250); } return read(); };
        const rest = await read();
        at('at rest', rest);
        await realTap(P, COMPOSER);
        await until(async () => imeShown() && await P.evaluate(() => 'keyboardUp' in document.documentElement.dataset), 6000, 300);
        const kbUp = await settled();
        check('stick: a real tap on the box raised the soft keyboard, and the WebView is shorter', imeShown() && kbUp.keyboardUp && kbUp.vh < rest.vh - 150, { ...kbUp, wasVh: rest.vh });
        at('the soft keyboard up', kbUp);
        screencap('stick-keyboard-up.png');
        // Typed through the keyboard's own input path, word by word, until the box has grown lines.
        for (const word of 'the quick brown fox jumps over the lazy dog and runs on down the long road again'.split(' ')) sh(`input text ${word}%s`);
        await sleep(800);
        const typed = await read();
        check('stick: the box grew as it was typed into', typed.boxPx >= kbUp.boxPx + 40, typed);
        at('typing lines into the box', typed);
        screencap('stick-typed.png');
        let n = await rows();
        sh('input keyevent KEYCODE_ENTER');
        await until(async () => (await rows()) > n, 15000);
        await sleep(800);
        at('your own message sent, the keyboard still up', await read());
        back();
        const kbDown = await settled();
        check('stick: Back closed the keyboard', !imeShown() && !kbDown.keyboardUp, kbDown);
        at('the keyboard closed by Back', kbDown);
        // CONTROL: a reader who scrolled up with a real finger stays exactly where they are.
        await P.evaluate(() => document.activeElement?.blur());
        await sleep(400);
        const mid = await onScreen(P, '.messages-container');
        sh(`input swipe ${mid.x} ${mid.y - 300} ${mid.x} ${mid.y + 500} 400`);
        await sleep(1500);
        const up0 = await read();
        check('stick: CONTROL - a finger scrolled the list up', up0.fromBottom >= 200, up0);
        const stays = (label, r) => check(`stick: CONTROL - scrolled up: ${label}: still exactly where they were reading`, Math.abs(r.scrollTop - up0.scrollTop) <= 1, { was: up0.scrollTop, ...r });
        // A tap in the box, not on the list: the list is not touched.
        await realTap(P, COMPOSER);
        await until(async () => imeShown() && await P.evaluate(() => 'keyboardUp' in document.documentElement.dataset), 6000, 300);
        stays('the soft keyboard up', await settled());
        for (const word of 'still reading up there'.split(' ')) sh(`input text ${word}%s`);
        for (const word of 'and more words to grow the box by a line or two'.split(' ')) sh(`input text ${word}%s`);
        await sleep(800);
        stays('typing lines into the box', await read());
        back();
        stays('the keyboard closed by Back', await settled());
        await P.locator(COMPOSER).fill('');
        await P.evaluate(() => document.activeElement?.blur());
        await sleep(600);
    }

    // ── keyboard
    step('the soft keyboard');
    check('keyboard: before the tap, the bottom bar is there', await P.evaluate(() => getComputedStyle(document.querySelector('.mobile-bottom-nav')).display !== 'none'));
    await realTap(P, 'form.message-form textarea');
    const up = await until(async () => imeShown() && await P.evaluate(() => 'keyboardUp' in document.documentElement.dataset), 6000, 300);
    const kb = await P.evaluate(() => {
        const form = document.querySelector('form.message-form').getBoundingClientRect();
        return { up: 'keyboardUp' in document.documentElement.dataset, nav: getComputedStyle(document.querySelector('.mobile-bottom-nav')).display, formBottomGap: Math.round(innerHeight - form.bottom), vh: innerHeight };
    });
    check('keyboard: a tap on the message box raises the soft keyboard', imeShown());
    check('keyboard: ...and the bottom bar steps aside, the box at the keyboard', !!up && kb.nav === 'none' && kb.formBottomGap <= 12, kb);
    screencap('keyboard-up.png');
    await P.locator('form.message-form textarea').fill(`Long press me ${stamp}`);
    await P.locator('form.message-form textarea').press('Enter');
    await until(() => P.evaluate(() => !!document.querySelector('.messages-container > .message:not([id^="msg-local_"])')), 15000);
    back();
    await sleep(1200);
    const kb2 = await P.evaluate(() => ({ focused: document.activeElement?.tagName, up: 'keyboardUp' in document.documentElement.dataset, nav: getComputedStyle(document.querySelector('.mobile-bottom-nav')).display }));
    check('keyboard: Back closes the keyboard, and the app stays', !imeShown() && appInFront());
    check('keyboard: ...the box still focused, the bottom bar is back', kb2.focused === 'TEXTAREA' && !kb2.up && kb2.nav !== 'none', kb2);
    await P.evaluate(() => document.activeElement?.blur());
    await sleep(400);

    // ── longpress
    step('a long press on the message');
    await P.evaluate(() => getSelection()?.removeAllRanges());
    await longPress(P, '.messages-container > .message .message-content, .messages-container > .message');
    await sleep(1200);
    const lp = await P.evaluate(() => ({ menu: !!document.querySelector('.context-menu'), selected: String(getSelection() ?? '') }));
    check('longpress: a long press opens the message menu', lp.menu, lp);
    check('longpress: ...and selects no words under it', lp.selected === '', lp);
    screencap('longpress-menu.png');

    // ── back
    step('Back');
    back();
    await sleep(1000);
    check('back: Back closes the message menu', !await P.evaluate(() => !!document.querySelector('.context-menu')));
    check('back: ...and the app stays in front', appInFront());
    await navTo('Channels');
    await realTap(P, '.user-action-btn[title="Settings"]', 'first');
    const opened = await until(() => P.evaluate(() => !!document.querySelector('.settings-modal')), 6000);
    check('back: Settings opened', !!opened);
    back();
    await sleep(1000);
    check('back: Back closes Settings', !await P.evaluate(() => !!document.querySelector('.settings-modal')));
    check('back: ...and the app stays in front', appInFront());
    screencap('back-after-settings.png');
    back();
    await sleep(1500);
    check('back: CONTROL - with nothing open, Back leaves the app as it always did', !appInFront());
    sh(`am start -W -n ${PKG}/.MainActivity`);
    const front = await until(() => appInFront(), 8000, 400);
    // Android may have made the activity again: the page is looked up afresh, through the same
    // DevTools socket (the app's process lives on).
    const read = (pg) => pg.evaluate(() => ({ path: location.pathname, signedIn: !!localStorage.getItem('auth_token') }));
    let page = await read(P).catch(() => null);
    if (!page) {
        const again = await until(async () => {
            const b2 = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
            browsers.push(b2);
            return b2.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('https://localhost')) || null;
        }, 20000, 1500);
        page = again ? await until(() => read(again), 15000, 500).catch(() => null) : null;
        page = page ? { ...page, pageMadeAgain: true } : { error: 'no page after the app came back' };
    }
    check('back: the app comes back where it was, signed in', !!front && page.signedIn === true, { front: !!front, ...page });
} catch (e) {
    check('the walk ran to the end', false, String(e?.stack || e).slice(0, 600));
} finally {
    for (const b of browsers) await b.close().catch(() => {});
    if (forwarded) { try { adb('forward', '--remove', `tcp:${CDP_PORT}`); } catch { /* gone */ } }
}
console.log(`\n${failed} failure(s)`);
process.exit(failed);
