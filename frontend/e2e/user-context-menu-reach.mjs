// Real-browser rig: everything in the user right-click menu (UserContextMenu)
// must be reachable — its submenus included — on desktop, in a short window,
// and on a 390x844 phone.
//
// The bug this pins (found by the review of the member-popup scroll fix,
// reproduced here): `.user-context-menu` was `overflow: hidden`, and its
// submenus were flyouts (`position: absolute; left: 100%`) INSIDE it, so every
// submenu was clipped to a 2px strip — the voice "Move to" list (the only way
// to move someone between voice channels on a phone) could not be seen or
// clicked. The menu's own placement clamp (`y = innerHeight - h - 10`) also had
// no lower bound, so in a window shorter than the menu its top items sat above
// the window with nothing to scroll. ServerList.css's unscoped `.context-submenu`
// rule (its own inline submenu) leaked a 2px left border into this menu too.
//
// It drives e2e/user-context-menu.html (the real component and the app's real
// global stylesheets, fixture props, no server) headless, and checks
// reachability with document.elementFromPoint at each control's centre — never
// locator.click, which scrolls clipped containers by itself and false-passes.
// Wheel (desktop) and raw CDP touch drags (phone) are the only scrolling.
//
// Usage: start the dev server in frontend/
//   npx vite --port 5402 --strictPort --host 127.0.0.1
// then: node e2e/user-context-menu-reach.mjs [outdir] [baseURL]
//   baseURL defaults to http://127.0.0.1:5402
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const outdir = process.argv[2] || 'e2e/shots-user-context-menu';
const BASE = process.argv[3] || 'http://127.0.0.1:5402';
fs.mkdirSync(outdir, { recursive: true });

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? '  — ' + detail : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// In-page: where a control is and whether it is the topmost element at its
// own centre. `which` picks the element: a selector plus an index (-1 = last)
// or a text match on .context-item buttons.
const PROBE = ({ sel, idx, text }) => {
    const menu = document.querySelector('.user-context-menu');
    if (!menu) return null;
    let el = null;
    if (text) el = [...menu.querySelectorAll('.context-item')].find(b => b.textContent.trim().startsWith(text)) || null;
    else { const all = [...menu.querySelectorAll(sel)]; el = all.length ? all[idx < 0 ? all.length + idx : idx] : null; }
    const mr = menu.getBoundingClientRect();
    const out = {
        menu: { top: Math.round(mr.top), bottom: Math.round(mr.bottom), left: Math.round(mr.left), right: Math.round(mr.right), scrollTop: menu.scrollTop, scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight },
        innerHeight, vw: document.documentElement.clientWidth,
        pageScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        found: !!el,
    };
    if (!el) return out;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const inView = cx >= 0 && cx < innerWidth && cy >= 0 && cy < innerHeight;
    const at = inView ? document.elementFromPoint(cx, cy) : null;
    return { ...out, cx, cy, hit: !!at && el.contains(at), at: at ? `${at.tagName}.${String(at.className).slice(0, 40)}` : null };
};

async function open(page, x, y) {
    await page.goto(`${BASE}/e2e/user-context-menu.html?x=${x}&y=${y}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.user-context-menu', { timeout: 20000 });
    await page.waitForTimeout(300);
}

// A raw one-finger drag through CDP touch events. dy < 0 drags UP = scrolls DOWN.
async function touchDrag(cdp, x, y, dy, steps = 12) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / steps }] });
        await sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(350);
}

// Scroll the menu (wheel on desktop, touch drag on a phone) until `which` is
// reachable; returns the last probe.
async function scrollUntilReachable(page, which, { cdp = null, tries = 15 } = {}) {
    let p = await page.evaluate(PROBE, which);
    for (let i = 0; i < tries && p && !p.hit; i++) {
        const mx = Math.round((p.menu.left + p.menu.right) / 2);
        const my = Math.round(Math.max(p.menu.top, 0) + Math.min(p.menu.bottom, p.innerHeight)) / 2;
        if (cdp) await touchDrag(cdp, mx, Math.round(my), -160);
        else { await page.mouse.move(mx, Math.round(my)); await page.mouse.wheel(0, 160); await page.waitForTimeout(200); }
        p = await page.evaluate(PROBE, which);
    }
    return p;
}

async function tapOrClick(page, p, touch) {
    if (touch) await page.touchscreen.tap(p.cx, p.cy);
    else await page.mouse.click(p.cx, p.cy);
    await page.waitForTimeout(250);
}

const inWindow = (p) => p.menu.top >= 0 && p.menu.bottom <= p.innerHeight && p.menu.left >= 0 && p.menu.right <= p.vw;
const box = (p) => `top=${p.menu.top} bottom=${p.menu.bottom} left=${p.menu.left} right=${p.menu.right} innerHeight=${p.innerHeight} vw=${p.vw}`;

const browser = await chromium.launch({
    channel: 'msedge', headless: true,
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

async function walk(label, page, { x, y, cdp = null }) {
    const touch = !!cdp;
    await open(page, x, y);
    let p = await page.evaluate(PROBE, { sel: '.volume-control input[type="range"]', idx: 0 });
    await page.screenshot({ path: `${outdir}/${label}-open.png` });
    check(`${label}: the menu is inside the window`, inWindow(p), box(p));
    check(`${label}: the page does not scroll sideways`, !p.pageScrollsX);
    check(`${label}: the FIRST control (User Volume) is reachable where the menu opens`, p.hit, `at=${p.at} cy=${Math.round(p.cy)}`);

    // "Move to": open it, then the LAST voice room must be reachable and work.
    p = await scrollUntilReachable(page, { text: 'Move to' }, { cdp });
    check(`${label}: "Move to" is reachable`, p.hit, `at=${p.at}`);
    if (!p.hit) return;
    await tapOrClick(page, p, touch);
    const sub = await page.evaluate(() => {
        const s = document.querySelector('.user-context-menu .ucm-submenu');
        if (!s) return null;
        const cs = getComputedStyle(s);
        const m = document.querySelector('.user-context-menu');
        const sr = s.getBoundingClientRect(), mr = m.getBoundingClientRect();
        // ServerList.css styles the SERVER menu's submenu with a
        // --border-separator left border; the user menu's own .ucm-submenu has
        // a --bg-tertiary one. Compare colours, not widths: both are 2px.
        const probe = document.createElement('div');
        probe.style.borderLeft = '2px solid var(--border-separator, #2a2b2f)';
        document.body.appendChild(probe);
        const serverListColour = getComputedStyle(probe).borderLeftColor;
        probe.remove();
        return { borderLeft: cs.borderLeftWidth, borderColour: cs.borderLeftColor, serverListColour, notServerClass: !s.classList.contains('context-submenu'), left: Math.round(sr.left), right: Math.round(sr.right), menuLeft: Math.round(mr.left), menuRight: Math.round(mr.right), scrollLeft: m.scrollLeft };
    });
    check(`${label}: "Move to" opens its list`, !!sub);
    if (!sub) return;
    // Inside the menu's own box, with the menu not shifted sideways: a flyout
    // beside an overflow box is clipped (or drags the whole menu sideways).
    check(`${label}: the opened list sits inside the menu, not beside it`, sub.left >= sub.menuLeft && sub.right <= sub.menuRight && sub.scrollLeft === 0, JSON.stringify(sub));
    check(`${label}: ServerList.css's submenu border does not leak into the user menu`, sub.notServerClass && (sub.borderLeft === '0px' || sub.borderColour !== sub.serverListColour), `border=${sub.borderLeft} ${sub.borderColour} vs ServerList ${sub.serverListColour}`);
    const lastRoom = { sel: '.ucm-submenu .context-item', idx: -1 };
    p = await page.evaluate(PROBE, lastRoom);
    check(`${label}: the menu is still inside the window with "Move to" open`, inWindow(p), box(p));
    p = await scrollUntilReachable(page, lastRoom, { cdp });
    await page.screenshot({ path: `${outdir}/${label}-move-to.png` });
    check(`${label}: the LAST voice room in "Move to" is reachable (elementFromPoint)`, p.hit, `at=${p.at} cy=${p.cy !== undefined ? Math.round(p.cy) : 'n/a'} menu.scrollTop=${p.menu.scrollTop}`);
    if (p.hit) {
        await tapOrClick(page, p, touch);
        const moved = await page.evaluate(() => window.__ctxHarness().moved);
        check(`${label}: choosing it moves the member there`, moved.length === 1 && moved[0] === 113, JSON.stringify(moved));
    }

    // Roles: the last role checkbox must be reachable and toggle.
    await open(page, x, y);
    p = await scrollUntilReachable(page, { text: 'Roles' }, { cdp });
    check(`${label}: "Roles" is reachable`, p.hit, `at=${p.at}`);
    if (!p.hit) return;
    await tapOrClick(page, p, touch);
    const lastRole = { sel: '.ucm-submenu .role-checkbox', idx: -1 };
    p = await scrollUntilReachable(page, lastRole, { cdp });
    await page.screenshot({ path: `${outdir}/${label}-roles.png` });
    check(`${label}: the LAST role in "Roles" is reachable (elementFromPoint)`, p.hit, `at=${p.at} cy=${p.cy !== undefined ? Math.round(p.cy) : 'n/a'}`);
    if (p.hit) {
        const before = await page.evaluate(() => { const b = [...document.querySelectorAll('.ucm-submenu .role-checkbox input')]; return b[b.length - 1].checked; });
        await tapOrClick(page, p, touch);
        const after = await page.evaluate(() => { const b = [...document.querySelectorAll('.ucm-submenu .role-checkbox input')]; return b[b.length - 1].checked; });
        check(`${label}: tapping the last role toggles it`, after !== before, `${before} -> ${after}`);
    }
    // And the very last control in the menu (Roles sits last) can still be
    // scrolled back to the first one: nothing is stranded above the window.
    p = await page.evaluate(PROBE, { sel: '.volume-control input[type="range"]', idx: 0 });
    for (let i = 0; i < 15 && !p.hit; i++) {
        const mx = Math.round((p.menu.left + p.menu.right) / 2), my = Math.round((Math.max(p.menu.top, 0) + Math.min(p.menu.bottom, p.innerHeight)) / 2);
        if (cdp) await touchDrag(cdp, mx, my, 160);
        else { await page.mouse.move(mx, my); await page.mouse.wheel(0, -160); await page.waitForTimeout(200); }
        p = await page.evaluate(PROBE, { sel: '.volume-control input[type="range"]', idx: 0 });
    }
    check(`${label}: scrolling back up reaches the first control again`, p.hit, `at=${p.at}`);
}

let pageErrors = 0;
try {
    // Desktop 1280x720, opened low and right (a right-click on the member list).
    const dctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const desk = await dctx.newPage();
    desk.on('pageerror', e => { pageErrors++; console.log('[pageerror]', String(e).slice(0, 200)); });
    await walk('desktop-1280x720', desk, { x: 1100, y: 600 });

    // A short window: the menu is taller than it.
    await desk.setViewportSize({ width: 1280, height: 400 });
    await walk('desktop-1280x400', desk, { x: 1100, y: 380 });

    // Phone 390x844, touch (a long-press on a member opens the same menu).
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const phone = await mctx.newPage();
    phone.on('pageerror', e => { pageErrors++; console.log('[pageerror/phone]', String(e).slice(0, 200)); });
    const cdp = await mctx.newCDPSession(phone);
    await walk('phone-390x844', phone, { x: 300, y: 700, cdp });

    const unstubbed = await phone.evaluate(() => window.__ctxHarness().unstubbed);
    check('no API call was made by just opening and scrolling the menu', unstubbed.length === 0, unstubbed.join(', '));
    check('no page errors', pageErrors === 0, `pageErrors=${pageErrors}`);
} catch (e) {
    console.log('EXCEPTION:', String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
    failures++;
} finally {
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
