// LIVE: the in-call card table as an ACTIVITY (docs/GAMES.md, "Activities"
// and "The table on screen") — Poker and Blackjack, on a 1280x800 desktop and
// a 390x844 coarse-pointer phone, two accounts in one voice call.
//
// What it proves, against the REAL web client and a backend that serves games
// (it confirms `games` in ServerFeatures):
//   1. games are on by default: the owner's "Allow games in voice calls" switch
//      in Server Settings is already on, and the call offers the Activities
//      launcher (the rocket beside camera and screen share; on the phone with
//      the camera behind the chevron);
//   2. the launcher's picker (a centred panel on the desktop, a SHEET on the
//      phone - 44 px targets, no overflow by clientWidth, a 460 px injection
//      caught) starts Poker; the starter is seated behind the owner's
//      disclosure ("Chips are free and worth nothing. This server deals the
//      cards and its operator could see them.") — shown on the FIRST sit only;
//      the phone gets the "<name> started Poker" notice and the activity tile
//      in the call grid (both measured the same way) and joins from the tile;
//   3. privacy: neither player's DOM ever holds the other's hole cards, and a
//      spectator's holds no card but the board;
//   4. the phone at 390x844: at most 6 seats, the opponents in a strip that
//      scrolls sideways, the TWO-ROW action bar above the voice bar and the
//      bottom nav, every visible target >= 44 px and hit by a tap at its
//      centre, no horizontal overflow measured with clientWidth (never
//      innerWidth) — and a 460 px element injected into the table MUST be
//      caught (positive control);
//   5. the raise amount edited in a sheet that rides above the soft keyboard:
//      headless Chromium has no keyboard, so the keyboard is emulated by
//      shrinking window.visualViewport by 336 px (what Android's resizes-visual
//      keyboard does) — the sheet must sit entirely inside the visible part,
//      field >= 16 px, and follow the viewport back down when it closes;
//   6. a typed refusal is shown inline (a second GameCreate in a call that has
//      a table -> "already open in this call"), never as an alert();
//   7. the table closes for everyone (MOVE_MEMBERS) with the ending worded, and
//      Blackjack starts from the launcher in the same call; the phone joins it
//      from the notice: bet, deal (1.5 s after the last bet), hit/stand, results;
//   8. "Back to call" never touches the call, and the tile brings you back;
//   9. the felt, the card faces and the buttons keep >= 4.5:1 text contrast in
//      all eight themes, with and without high contrast - and so do the
//      ACTIVITY surfaces: the picker, the notice, the call-grid tile and the
//      sidebar's channel chip, with the sidebar's playing mark >= 3:1 (a
//      non-text mark; its own opacity and its parents' are counted; a disabled
//      control and the aria-hidden art are exempt, as WCAG exempts them). The
//      light theme once put dark ink on a dark picker (1.05:1) and nothing
//      measured it.
// Each check prints PASS/FAIL; the exit code is the number of failures.
// Screenshots go to OUT (SHOT <file>) — look at them.
//
// Prereqs: a THROWAWAY backend that plays games (APP_ENV=development, raised
// AUTH_RATE_LIMIT_PER_SECOND / _BURST, its own fresh database — never a real
// one) at API, and vite of THIS tree at APP started with VITE_API_URL=API (the
// walk imports /src/api/* modules through vite to set the fixture up).
// Before the server half landed this ran against a games MOCK in front of a
// real backend (it proxies everything and answers Game* frames from the
// contract fixtures); since the integration it runs against the real games
// server (and e2e/games-live.mjs plays four players and a spectator there).
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5421 API=http://127.0.0.1:5321 OUT=<dir> node e2e/games-walk.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP || 'http://127.0.0.1:5421';
const OUT = process.env.OUT || 'e2e/shots-games';
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const AUSER = 'gma_' + stamp;
const BUSER = 'gmb_' + stamp;
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  -- ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
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

const alerts = [];
function watch(page, tag) {
    page.on('console', m => fs.appendFileSync(path.join(OUT, 'console.txt'), `${new Date().toISOString()} ${tag} ${m.type()} ${m.text().slice(0, 400)}\n`));
    page.on('pageerror', e => console.log(`  [${tag} pageerror]`, e.message.slice(0, 200)));
    page.on('dialog', d => {
        // confirm() is the moderation prompt (Close table): accept it. An
        // alert() would be a refusal shown the wrong way: count it.
        if (d.type() === 'alert') { alerts.push(`${tag}: ${d.message()}`); console.log(`  [${tag} ALERT]`, d.message()); }
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

const call = (page, mod, fn, args = []) => page.evaluate(async ({ mod, fn, args }) => {
    const m = await import(mod);
    return m[fn](...args);
}, { mod, fn, args });

/** Tap on a phone, click on a desktop. */
const press = (page, loc, phone) => (phone ? loc.tap() : loc.click());

/** Face-up card codes in this page's DOM. */
const faceUp = (page) => page.evaluate(() => [...document.querySelectorAll('[data-card]')].map(e => e.getAttribute('data-card')));
const myCards = (page) => page.evaluate(() => [...document.querySelectorAll('.games-me-cards [data-card], .bj-me-hands [data-card]')].map(e => e.getAttribute('data-card')));

/**
 * The phone geometry of the table. Overflow is measured against
 * documentElement.clientWidth (innerWidth WIDENS to fit an overflowing page
 * under isMobile, so a check against it cannot fail): every element of the
 * table and its sheet must end inside clientWidth, unless it lives in a
 * container that scrolls sideways on purpose (the opponents' strip).
 */
const TABLE_ROOTS = '.games-view, .games-sheet, .games-disclosure';
const ACTIVITY_ROOTS = '.activity-picker, .activity-notice, .activity-tile';
async function phoneGeometry(page, rootSel = TABLE_ROOTS) {
    return page.evaluate((rootSel) => {
        const vw = document.documentElement.clientWidth;
        const roots = [...document.querySelectorAll(rootSel)];
        const scrollsX = (el, root) => {
            for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
                const o = getComputedStyle(p).overflowX;
                if (o === 'auto' || o === 'scroll') return true;
            }
            return false;
        };
        const overflow = [];
        for (const root of roots) {
            // Inside the table, an element must also stay inside the TABLE: a
            // row wider than its own column spills past the view's edge long
            // before it reaches the screen's.
            const box = root.getBoundingClientRect();
            const lo = Math.max(0, box.left), hi = Math.min(vw, box.right);
            for (const el of [root, ...root.querySelectorAll('*')]) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                if (el !== root && scrollsX(el, root)) continue;
                const [l, h] = el === root ? [0, vw] : [lo, hi];
                if (r.right > h + 0.5 || r.left < l - 0.5) overflow.push({ el: String(el.className || el.tagName).slice(0, 40), left: Math.round(r.left), right: Math.round(r.right), box: [Math.round(l), Math.round(h)] });
            }
        }
        const small = [];
        const covered = [];
        for (const b of roots.flatMap(r => [...r.querySelectorAll('button')])) {
            const r = b.getBoundingClientRect();
            if (r.width === 0 || getComputedStyle(b).visibility === 'hidden') continue;
            // A button scrolled out of the sideways strip is reachable by scrolling, not covered.
            const strip = b.closest('.games-opps');
            if (strip) { const s = strip.getBoundingClientRect(); if (r.right <= s.left || r.left >= s.right) continue; }
            if (r.height < 44 - 0.5 || r.width < 44 - 0.5) small.push({ text: b.textContent.trim().slice(0, 24) || b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height) });
            if (parseFloat(getComputedStyle(b).opacity) < 1 && !b.disabled) small.push({ text: b.textContent.trim().slice(0, 24), hidden: 'opacity' });
            const cx = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
            const hit = document.elementFromPoint(cx, r.top + r.height / 2);
            if (r.top >= 0 && r.bottom <= innerHeight && !(hit && b.contains(hit))) covered.push({ text: b.textContent.trim().slice(0, 24), by: hit ? (hit.className || hit.tagName) : null });
        }
        const footer = document.querySelector('.games-footer')?.getBoundingClientRect();
        const bar = document.querySelector('.voice-panel-compact')?.getBoundingClientRect();
        const nav = document.querySelector('.mobile-bottom-nav')?.getBoundingClientRect();
        const floor = Math.min(bar && bar.height ? bar.top : Infinity, nav && nav.height ? nav.top : Infinity, innerHeight);
        return {
            vw,
            scrollWidth: document.documentElement.scrollWidth,
            overflow: overflow.slice(0, 6),
            small: small.slice(0, 8),
            covered: covered.slice(0, 6),
            footerBottom: footer ? Math.round(footer.bottom) : null,
            floor: Math.round(floor),
            seats: document.querySelectorAll('.games-opps .gseat').length + (document.querySelector('.games-me .games-me-info') ? 1 : 0),
            stripScrolls: (() => { const s = document.querySelector('.games-opps'); return s ? getComputedStyle(s).overflowX : null; })(),
            barRows: document.querySelectorAll('.games-footer .games-actions > .games-actions-row').length,
            roots: roots.length,
        };
    }, rootSel);
}
const geometryOk = (g) => g.overflow.length === 0 && g.scrollWidth <= g.vw && g.small.length === 0 && g.covered.length === 0;

/** Emulate the soft keyboard: shrink window.visualViewport by `kb` px. */
async function keyboard(page, kb) {
    await page.evaluate((kb) => {
        if (!window.__fakeVV) {
            const vv = new EventTarget();
            vv.__kb = 0;
            Object.defineProperties(vv, {
                width: { get: () => innerWidth },
                height: { get: () => innerHeight - vv.__kb },
                offsetTop: { get: () => 0 },
                offsetLeft: { get: () => 0 },
                pageTop: { get: () => scrollY },
                pageLeft: { get: () => scrollX },
                scale: { get: () => 1 },
            });
            window.__fakeVV = vv;
            Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
        }
        window.__fakeVV.__kb = kb;
        window.__fakeVV.dispatchEvent(new Event('resize'));
        // Paint the "keyboard" so the screenshot shows what it covers.
        let k = document.getElementById('__fake_kb');
        if (kb > 0) {
            if (!k) { k = document.createElement('div'); k.id = '__fake_kb'; document.body.appendChild(k); }
            Object.assign(k.style, { position: 'fixed', left: 0, right: 0, bottom: 0, height: kb + 'px', background: 'repeating-linear-gradient(90deg,#3a3d44 0 36px,#2b2d31 36px 40px)', zIndex: 99999, pointerEvents: 'none' });
        } else if (k) k.remove();
    }, kb);
    await sleep(150);
}

/** WCAG contrast of two computed rgb() colours. */
function contrast(a, b) {
    const lum = (s) => {
        const [r, g, bl] = s.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

/**
 * In the page: every visible element under `roots` that carries its own text,
 * as [its colour, what it is painted on, a label, the ratio it needs] - text
 * 4.5:1; the sidebar's playing mark (an icon, no text) 3:1. Colours are
 * composited: a translucent background down to the first opaque one, and the
 * ink blended by the element's opacity and its ancestors' (a 0.7 icon on the
 * sidebar is what a person sees, not its computed colour).
 */
const activityPairs = (roots) => {
    const rgba = (s) => { const m = s.match(/[\d.]+/g); if (!m) return null; const [r, g, b2, a = 1] = m.map(Number); return [r, g, b2, a]; };
    const paint = (el) => {
        const layers = [];
        for (let e = el; e; e = e.parentElement) {
            const c = rgba(getComputedStyle(e).backgroundColor);
            if (!c || c[3] === 0) continue;
            layers.push(c);
            if (c[3] >= 1) break;
        }
        let [r, g, b2] = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : [255, 255, 255];
        for (const [lr, lg, lb, la] of layers.reverse()) {
            r = lr * la + r * (1 - la); g = lg * la + g * (1 - la); b2 = lb * la + b2 * (1 - la);
        }
        return [r, g, b2];
    };
    const ink = (el, bg) => {
        let [r, g, b2, a] = rgba(getComputedStyle(el).color);
        for (let e = el; e; e = e.parentElement) a *= Number(getComputedStyle(e).opacity);
        return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b2 * a + bg[2] * (1 - a)];
    };
    const css = ([r, g, b2]) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b2)})`;
    const out = [];
    for (const sel of roots) {
        for (const root of document.querySelectorAll(sel)) {
            for (const el of [root, ...root.querySelectorAll('*')]) {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                const mark = el.matches('.voice-status-icon.playing');
                // Exempt, as WCAG 1.4.3 / 1.4.11 exempt them: a DISABLED
                // control (the picker's waiting game, dimmed on purpose; the
                // note under it says why in full contrast) and pure
                // decoration (the aria-hidden art, whose SVG paints with
                // fill, not color).
                if (el.closest('[aria-hidden="true"], button:disabled, [aria-disabled="true"]')) continue;
                if (!mark && el instanceof SVGElement) continue;
                const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
                if (!mark && !ownText) continue;
                const bg = paint(el);
                out.push([css(ink(el, bg)), css(bg), `${sel} ${mark ? 'playing-mark' : el.textContent.trim().slice(0, 24)}`, mark ? 3 : 4.5]);
            }
        }
    }
    return out;
};

try {
    const aCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // The desktop's app sockets, remembered so step 5 can put a raw frame on
    // the wire the way a second client tab would — through the module system
    // it could land on a stale vite module instance with no socket.
    await aCtx.addInitScript(() => {
        const Orig = window.WebSocket;
        window.__gwSockets = [];
        window.WebSocket = class extends Orig {
            constructor(url, protocols) {
                super(url, protocols);
                if (String(url).includes('/ws')) window.__gwSockets.push(this);
            }
        };
    });
    const bCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const A = await signIn(aCtx, AUSER, 'A');
    const B = await signIn(bCtx, BUSER, 'B-phone');

    // ── 0. The server, a voice channel; the owner switches games ON in the UI.
    const srvName = 'GM ' + stamp.slice(-4);
    const srv = await call(A, '/src/api/servers.ts', 'createServer', [srvName]);
    const vc = await call(A, '/src/api/servers.ts', 'createChannel', [srv.id, 'Table', 1]);
    await A.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(A);
    await A.locator(`.server-icon[title="${srvName}"]`).click();
    await sleep(800);
    const offered = async (page) => (await page.locator('.vp-activities').count()) > 0;
    await A.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first().click();
    check('A joined the call', !!await until(async () => (await A.locator('.voice-panel-compact .voice-connected-label').count()) > 0, 20000));
    check('games are ON by default: a fresh server\'s call offers the Activities launcher at once', !!await until(() => offered(A), 8000));
    check('desktop: the launcher sits beside camera and screen share in the call\'s controls', await A.evaluate(() => {
        const b = document.querySelector('.vp-activities');
        return !!b && b.previousElementSibling?.classList.contains('vp-camera') && !!b.parentElement?.querySelector('.vp-screenshare');
    }));

    await A.locator('.server-settings-btn').first().click();
    const toggle = A.locator('input[aria-label="Allow games in voice calls"]');
    await toggle.waitFor({ state: 'attached', timeout: 10000 });
    check('the Games switch sits right after Clips in Server Settings', await A.evaluate(() => {
        const g = document.querySelector('input[aria-label="Allow games in voice calls"]')?.closest('.form-group');
        return !!g && /Allow clips/.test(g.previousElementSibling?.textContent || '');
    }));
    check('the switch is already ON (games are on by default; the owner may turn them off)', await toggle.isChecked());
    await shot(A, '01-desktop-settings-games-switch');
    await A.locator('.server-settings-content .close-btn').click();
    await A.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 });

    const inv = await call(A, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);
    await call(B, '/src/api/servers.ts', 'joinViaInvite', [inv.code]);
    await B.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(B);

    // ── 1. The phone joins the call first, so it is there when the activity starts.
    await B.locator('.mobile-nav-btn').first().tap();
    await sleep(400);
    await B.locator(`.server-icon[title="${srvName}"]`).tap();
    await sleep(800);
    await B.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first().tap();
    check('B (phone) joined the call', !!await until(async () => (await B.locator('.voice-panel-compact .voice-connected-label').count()) > 0, 20000));
    check('phone: the launcher is behind the collapsed bar\'s chevron with the camera (hidden until expanded)', await until(async () => {
        const n = await B.locator('.vp-activities').count();
        return n > 0 && !(await B.locator('.vp-activities').isVisible());
    }, 8000));
    // The phone's picker: a sheet.
    await B.locator('.vp-expand').tap();
    check('phone: expanded, the launcher shows beside the camera', await B.locator('.vp-activities').isVisible());
    await B.locator('.vp-activities').tap();
    await B.locator('.activity-picker.activity-sheet').waitFor({ timeout: 8000 });
    const gS = await phoneGeometry(B, ACTIVITY_ROOTS);
    check('phone: the picker is a sheet that fits 390 px, every target >= 44 px and hit at its centre', gS.roots > 0 && geometryOk(gS), gS);
    await B.evaluate(() => {
        const d = document.createElement('div');
        d.id = '__w460s'; d.style.cssText = 'width:460px;height:8px;background:red;flex-shrink:0';
        document.querySelector('.activity-cards')?.appendChild(d);
    });
    const gS460 = await phoneGeometry(B, ACTIVITY_ROOTS);
    check('POSITIVE CONTROL: a 460 px element injected into the picker sheet is caught', gS460.overflow.length > 0, gS460.overflow);
    await shot(B, '02-phone-activities-sheet-460');
    await B.evaluate(() => document.getElementById('__w460s')?.remove());
    await shot(B, '02-phone-activities-sheet');
    await B.locator('.activity-picker').getByRole('button', { name: 'Close' }).tap();
    check('phone: the sheet closes', !!await until(async () => (await B.locator('.activity-picker').count()) === 0, 4000));
    // The phone looks at the call's grid (where the tile will show).
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(400);
    await B.locator('.voice-channel-list .voice-channel', { hasText: 'Table' }).first().tap();
    await B.locator('.voice-stage').waitFor({ timeout: 10000 });

    // ── 2. The desktop starts Poker from the launcher's picker.
    await A.locator('.vp-activities').click();
    await A.locator('.activity-picker').waitFor({ timeout: 8000 });
    check('desktop: the picker shows Poker and Blackjack as cards with art', (await A.locator('.activity-card').count()) === 2 && (await A.locator('.activity-card svg').count()) >= 2);
    await shot(A, '02-desktop-activities-picker');
    await A.locator('.activity-card[data-kind="holdem"]').click();
    check('desktop: the Poker table opened for the starter', !!await until(async () => (await A.locator('.gtable-holdem').count()) > 0, 10000));
    check('desktop: the call is untouched by opening the table', (await A.locator('.voice-panel-compact .voice-connected-label').count()) > 0);

    // ── 3. The phone hears of it live: the notice and the tile, both fitting.
    check('phone: the notice "<owner> started Poker" with Join and Watch', !!await until(async () =>
        /started Poker/.test(await B.locator('.activity-notice').textContent().catch(() => '')), 5000));
    check('phone: the activity tile in the call grid', !!await until(async () => (await B.locator('.activity-tile').count()) > 0, 5000));
    await B.locator('.activity-tile').scrollIntoViewIfNeeded();
    const gN = await phoneGeometry(B, ACTIVITY_ROOTS);
    check('phone: the notice and the tile fit 390 px, every target >= 44 px and hit at its centre', gN.roots >= 2 && geometryOk(gN), gN);
    // Nothing in the tile sits on top of anything else: the art, the name, the
    // count and the buttons stack (a 16:9 tile squeezed them over each other).
    const stack = await B.evaluate(() => ['.activity-art', '.activity-tile-name', '.activity-tile-count', '.activity-tile-actions']
        .map(s => document.querySelector(`.activity-tile ${s}`)?.getBoundingClientRect()).map(r => r && [Math.round(r.top), Math.round(r.bottom)]));
    check('phone: in the tile, the art, the name, the count and the buttons stack without overlapping', stack.every(Boolean) && stack.every((r, i) => i === 0 || r[0] >= stack[i - 1][1] - 0.5), stack);
    await B.evaluate(() => {
        const d = document.createElement('div');
        d.id = '__w460n'; d.style.cssText = 'width:460px;height:8px;background:red;flex-shrink:0';
        document.querySelector('.activity-tile')?.appendChild(d);
    });
    check('POSITIVE CONTROL: a 460 px element injected into the tile is caught', (await phoneGeometry(B, ACTIVITY_ROOTS)).overflow.length > 0);
    await B.evaluate(() => document.getElementById('__w460n')?.remove());
    await shot(B, '03-phone-notice-and-tile');
    check('phone: the notice took no focus and is not a dialog', await B.evaluate(() => !document.querySelector('.activity-notice')?.contains(document.activeElement) && !document.querySelector('[role="dialog"]')));

    // ── 3b. The starter was seated behind the disclosure; the phone joins from the tile.
    const disc = A.locator('.games-disclosure');
    check('desktop: the disclosure comes before the first sit, in the owner\'s words', await disc.isVisible().catch(() => false)
        && (await disc.innerText()).includes('Chips are free and worth nothing. This server deals the cards and its operator could see them.'));
    await shot(A, '03-desktop-disclosure');
    await disc.getByRole('button', { name: 'Sit down' }).click();
    check('desktop: seated', !!await until(async () => (await A.locator('.games-me .games-me-info').count()) > 0, 10000));
    await B.locator('.activity-tile').getByRole('button', { name: 'Join', exact: true }).tap();
    await B.locator('.games-view').waitFor({ timeout: 15000 });
    check('phone: Join opened the table; nothing face up yet (nothing dealt, nothing shown)', (await faceUp(B)).length === 0, (await faceUp(B)).join(' '));
    const bdisc = B.locator('.games-disclosure');
    check('phone: the disclosure too', await until(() => bdisc.isVisible(), 5000));
    const gD = await phoneGeometry(B);
    check('phone: the disclosure fits 390 px with 44 px buttons', gD.overflow.length === 0 && gD.small.length === 0, gD);
    await shot(B, '04-phone-disclosure');
    await bdisc.getByRole('button', { name: 'Sit down' }).tap();
    check('phone: seated', !!await until(async () => (await B.locator('.games-me .games-me-info').count()) > 0, 10000));

    // ── 4. The deal: privacy both ways, then walk the turns until the phone acts.
    check('a hand is dealt to both', !!await until(async () => (await myCards(A)).length === 2 && (await myCards(B)).length === 2, 30000));
    const aCards = await myCards(A);
    const bCards = await myCards(B);
    const bSees = await faceUp(B);
    const aSees = await faceUp(A);
    check('privacy: the phone never holds the desktop\'s hole cards', !aCards.some(c => bSees.includes(c)), { aCards, bSees });
    check('privacy: the desktop never holds the phone\'s hole cards', !bCards.some(c => aSees.includes(c)), { bCards, aSees });

    let phoneTurn = false;
    for (let i = 0; i < 8 && !phoneTurn; i++) {
        const who = await until(async () => {
            if (await B.locator('.games-footer .games-actions').count()) return 'B';
            if (await A.locator('.games-footer .games-actions').count()) return 'A';
            return null;
        }, 40000);
        if (who === 'B') { phoneTurn = true; break; }
        if (who !== 'A') break;
        if (i === 0) await shot(A, '05-desktop-holdem-your-turn');
        const btn = A.locator('.games-footer .games-actions-row').first().locator('button').nth(1); // Check / Call
        await btn.click();
        await sleep(800);
    }
    check('the phone gets a turn', phoneTurn);

    if (phoneTurn) {
        await sleep(400);
        const g = await phoneGeometry(B);
        check('phone 390x844: no horizontal overflow, every target >= 44 px and hit at its centre', geometryOk(g), g);
        check('phone: the action bar is TWO rows', g.barRows === 2, g);
        check('phone: the action bar ends above the voice bar and the bottom nav', g.footerBottom !== null && g.footerBottom <= g.floor + 0.5, g);
        check('phone: at most 6 seats; the opponents\' strip scrolls sideways', g.seats <= 6 && g.stripScrolls === 'auto', g);
        await shot(B, '06-phone-holdem-your-turn');

        // Positive control: a 460 px element in the table MUST be caught.
        await B.evaluate(() => {
            const d = document.createElement('div');
            d.id = '__w460'; d.style.cssText = 'width:460px;height:8px;background:red;flex-shrink:0';
            document.querySelector('.games-scroll')?.appendChild(d);
        });
        const g460 = await phoneGeometry(B);
        check('POSITIVE CONTROL: a 460 px element injected into the table is caught', g460.overflow.length > 0, g460.overflow);
        await shot(B, '07-phone-460-injection');
        await B.evaluate(() => document.getElementById('__w460')?.remove());
        check('…and with it removed the table fits again', (await phoneGeometry(B)).overflow.length === 0);

        // The raise sheet, keyboard open. The (emulated) visualViewport is in
        // place BEFORE the sheet mounts, as the real one always is; the
        // keyboard then opens over it and the sheet must follow its resize.
        await keyboard(B, 0);
        await B.locator('.games-amount-btn').tap();
        await B.locator('.games-sheet').waitFor({ timeout: 5000 });
        await keyboard(B, 336);
        const kb = await B.evaluate(() => {
            const s = document.querySelector('.games-sheet').getBoundingClientRect();
            const input = document.querySelector('.games-sheet input');
            const ir = input.getBoundingClientRect();
            const confirm = [...document.querySelectorAll('.games-sheet-actions button')].pop().getBoundingClientRect();
            const visible = window.visualViewport.height;
            return {
                visible, sheetTop: Math.round(s.top), sheetBottom: Math.round(s.bottom),
                inputInView: ir.top >= 0 && ir.bottom <= visible, confirmInView: confirm.top >= 0 && confirm.bottom <= visible,
                fontPx: parseFloat(getComputedStyle(input).fontSize), focused: document.activeElement === input,
                min: Number(input.min), step: Number(input.step),
            };
        });
        check('keyboard open: the sheet sits entirely above the keyboard', kb.sheetBottom <= kb.visible + 0.5 && kb.sheetTop >= 0, kb);
        check('keyboard open: the amount field and the confirm are visible; the field is >= 16 px and focused', kb.inputInView && kb.confirmInView && kb.fontPx >= 16 && kb.focused, kb);
        const gk = await phoneGeometry(B);
        check('keyboard open: the sheet fits 390 px with 44 px targets', gk.overflow.length === 0 && gk.small.length === 0, gk);
        await shot(B, '08-phone-raise-sheet-keyboard-open');
        await keyboard(B, 0);
        const down = await B.evaluate(() => Math.round(document.querySelector('.games-sheet').getBoundingClientRect().bottom));
        check('keyboard closed: the sheet follows the viewport back to the bottom', Math.abs(down - 844) <= 1, { down });
        await B.locator('.games-sheet input').fill(String(kb.min + kb.step));
        const label = await B.locator('.games-sheet-actions button').last().innerText();
        check('typing an amount re-labels the confirm with it', label.includes(String(kb.min + kb.step)) || /All-in/.test(label), label);
        await B.locator('.games-sheet-actions button').last().tap();
        check('confirming closes the sheet and the turn passes', !!await until(async () => (await B.locator('.games-sheet').count()) === 0 && (await B.locator('.games-footer .games-actions').count()) === 0, 10000));
    }

    // ── 5. A typed refusal is inline, never an alert.
    const sentRaw = await A.evaluate((frame) => {
        const ws = [...window.__gwSockets].reverse().find(w => w.readyState === 1);
        if (!ws) return false;
        ws.send(JSON.stringify(frame));
        return true;
    }, { type: 'GameCreate', payload: { room_id: `voice_${vc.id}`, kind: 'blackjack', config: {} } });
    check('a second GameCreate went out on the desktop socket', sentRaw);
    check('a second table in the call is refused INLINE, in the owner\'s words', !!await until(async () => /already open in this call/.test(await A.locator('.games-notice').innerText().catch(() => '')), 8000));
    check('no alert() was raised for any refusal', alerts.length === 0, alerts);
    await shot(A, '09-desktop-refusal-inline');

    // ── 6. "Back to call" never touches the call; the tile brings you back.
    await A.getByRole('button', { name: 'Back to call' }).click();
    check('desktop: back on the call\'s grid with the activity tile, still connected', (await A.locator('.voice-stage').count()) > 0 && (await A.locator('.activity-tile').count()) > 0 && (await A.locator('.voice-panel-compact .voice-connected-label').count()) > 0);
    await A.locator('.activity-tile').getByRole('button', { name: 'Open', exact: true }).click();
    check('desktop: the table is still there on return (the store kept it), same seat', !!await until(async () => (await A.locator('.gtable-holdem').count()) > 0 && (await A.locator('.games-me .games-me-info').count()) > 0, 5000));
    // The phone: at the table the composer steps aside; Back to call brings it back.
    check('phone: at the table, no composer', (await B.locator('form.message-form').count()) === 0);
    await B.getByRole('button', { name: 'Back to call' }).tap();
    check('phone: Back to call shows the grid and the composer again; still in the call', !!await until(async () =>
        (await B.locator('.voice-stage').count()) > 0 && (await B.locator('form.message-form').count()) > 0, 5000) && (await B.locator('.voice-panel-compact .voice-connected-label').count()) > 0);
    await shot(B, '09b-phone-back-to-call');
    await B.locator('.activity-tile').getByRole('button', { name: 'Open', exact: true }).tap();
    check('phone: Open returns to the table', !!await until(async () => (await B.locator('.gtable-holdem').count()) > 0, 5000));

    // ── 7. Themes: felt, card faces and buttons keep their contrast.
    const themes = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
    const poor = [];
    const activityPoor = [];
    const activityMeasured = [];
    for (const theme of themes) {
        for (const hc of ['normal', 'high']) {
            await A.evaluate(([theme, hc]) => {
                document.documentElement.setAttribute('data-theme', theme);
                document.documentElement.setAttribute('data-contrast', hc);
            }, [theme, hc]);
            await sleep(700); // past the app's colour transitions
            const c = await A.evaluate(() => {
                const cs = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
                const felt = getComputedStyle(document.querySelector('.gcentre')).getPropertyValue('--felt').trim();
                const probe = document.createElement('span'); probe.style.color = felt; document.body.appendChild(probe);
                const feltRgb = getComputedStyle(probe).color; probe.remove();
                // Every enabled button: its text on its own background, or on
                // the first painted ancestor's for a transparent (ghost) one.
                // Translucent layers are composited down to the first opaque one.
                const paint = (el) => {
                    const layers = [];
                    for (let e = el; e; e = e.parentElement) {
                        const m = getComputedStyle(e).backgroundColor.match(/[\d.]+/g);
                        if (!m) continue;
                        const [r, g, b2, a = 1] = m.map(Number);
                        if (a === 0) continue;
                        layers.push([r, g, b2, a]);
                        if (a >= 1) break;
                    }
                    let [r, g, b2] = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : [255, 255, 255];
                    for (const [lr, lg, lb, la] of layers.reverse()) {
                        r = lr * la + r * (1 - la); g = lg * la + g * (1 - la); b2 = lb * la + b2 * (1 - la);
                    }
                    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b2)})`;
                };
                const buttons = [...document.querySelectorAll('.games-view button.games-btn:not(:disabled)')]
                    .filter(b => b.getBoundingClientRect().width > 0)
                    .map(b => [getComputedStyle(b).color, paint(b), b.textContent.trim().slice(0, 20)]);
                const out = {
                    pot: [cs('.gpot', 'color'), feltRgb],
                    notice: document.querySelector('.games-notice') ? [cs('.games-notice-text', 'color'), paint(document.querySelector('.games-notice'))] : null,
                    card: document.querySelector('.pcard-red, .pcard-black') ? [cs('.pcard-red, .pcard-black', 'color'), cs('.pcard-red, .pcard-black', 'backgroundColor')] : null,
                    text: [cs('.games-view', 'color'), paint(document.querySelector('.games-view'))],
                };
                buttons.forEach((b, i) => { out[`btn${i}`] = b; });
                return out;
            });
            for (const [k, pair] of Object.entries(c)) {
                if (!pair || !pair[0] || !pair[1] || /rgba\(0, 0, 0, 0\)/.test(pair[1])) continue;
                const r = contrast(pair[0], pair[1]);
                if (r < 4.5) poor.push(`${theme}/${hc} ${k} ${r.toFixed(2)} ${pair[0]} on ${pair[1]}${pair[2] ? ' (' + pair[2] + ')' : ''}`);
            }
            // One screenshot per theme and contrast: the set a person checks by eye.
            await shot(A, `10-desktop-theme-${theme}-${hc}`);
            // The activity surfaces in the same theme: the picker (from the
            // launcher), then the call grid's tile and the sidebar's chip and
            // playing marks (Back to call), then back to the table.
            await A.locator('.vp-activities').click();
            await A.locator('.activity-picker').waitFor({ timeout: 5000 });
            await sleep(250);
            const picker = await A.evaluate(activityPairs, ['.activity-picker']);
            if (hc === 'normal' && (theme === 'light' || theme === 'dark')) await shot(A, `10b-desktop-picker-${theme}`);
            await A.keyboard.press('Escape');
            await until(async () => (await A.locator('.activity-picker').count()) === 0, 3000);
            await A.getByRole('button', { name: 'Back to call' }).click();
            await A.locator('.activity-tile').waitFor({ timeout: 5000 });
            await sleep(250);
            const grid = await A.evaluate(activityPairs, ['.activity-tile', '.voice-activity-chip', '.voice-status-icon.playing']);
            if (hc === 'normal' && (theme === 'light' || theme === 'dark')) await shot(A, `10c-desktop-grid-${theme}`);
            await A.locator('.activity-tile').getByRole('button', { name: 'Open', exact: true }).click();
            await A.locator('.gtable-holdem').waitFor({ timeout: 5000 });
            const marks = grid.filter(p => / playing-mark$/.test(p[2])).length;
            activityMeasured.push(`${theme}/${hc}: picker ${picker.length}, grid ${grid.length} (${marks} playing marks)`);
            if (picker.length < 5 || !grid.some(p => /\.activity-tile /.test(p[2])) || marks < 2) activityPoor.push(`${theme}/${hc}: too little measured (picker ${picker.length}, grid ${grid.length}, marks ${marks})`);
            for (const [fg, bg, label, need] of [...picker, ...grid]) {
                const r = contrast(fg, bg);
                if (r < need) activityPoor.push(`${theme}/${hc} ${label} ${r.toFixed(2)} ${fg} on ${bg}`);
            }
        }
    }
    check('all eight themes, normal and high contrast: felt, card, button and page text >= 4.5:1', poor.length === 0, poor);
    check('all eight themes, normal and high contrast: the picker, the tile and the sidebar chip >= 4.5:1, the playing mark >= 3:1', activityPoor.length === 0, activityPoor.length ? activityPoor : activityMeasured.slice(0, 4));
    await A.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.setAttribute('data-contrast', 'normal'); });

    // ── 8. The owner closes the table; Blackjack opens in the same call.
    await A.getByRole('button', { name: 'Close table' }).click();
    check('closing ends the table for everyone, worded', !!await until(async () =>
        /moderator closed the table/.test(await A.locator('.games-notice').innerText().catch(() => ''))
        && /moderator closed the table/.test(await B.locator('.games-notice').innerText().catch(() => '')), 10000));
    // B goes back to the call's grid; A starts Blackjack from the launcher.
    await B.getByRole('button', { name: 'Back to call' }).tap();
    await A.locator('.vp-activities').click();
    await A.locator('.activity-card[data-kind="blackjack"]').click();
    check('a Blackjack table opened for the starter', !!await until(async () => (await A.locator('.gtable-blackjack').count()) > 0, 10000));
    check('desktop: the starter is seated, no disclosure the second time on this server', !!await until(async () => (await A.locator('.games-me .games-me-info').count()) > 0, 8000) && !(await A.locator('.games-disclosure').count()));
    check('phone: the Blackjack notice', !!await until(async () => /started Blackjack/.test(await B.locator('.activity-notice').textContent().catch(() => '')), 5000));
    const gN2 = await phoneGeometry(B, ACTIVITY_ROOTS);
    check('phone: the Blackjack notice and tile fit, 44 px targets', geometryOk(gN2), gN2);
    // The notice is only ever on screen here: measure it (and the tile) in
    // every theme while it is up.
    const noticePoor = [];
    let noticeMeasured = 0;
    for (const theme of themes) {
        for (const hc of ['normal', 'high']) {
            await B.evaluate(([theme, hc]) => {
                document.documentElement.setAttribute('data-theme', theme);
                document.documentElement.setAttribute('data-contrast', hc);
            }, [theme, hc]);
            await sleep(700);
            const pairs = await B.evaluate(activityPairs, ['.activity-notice', '.activity-tile']);
            if (!pairs.some(p => /^\.activity-notice /.test(p[2]))) noticePoor.push(`${theme}/${hc}: no notice measured`);
            noticeMeasured += pairs.length;
            for (const [fg, bg, label, need] of pairs) {
                const r = contrast(fg, bg);
                if (r < need) noticePoor.push(`${theme}/${hc} ${label} ${r.toFixed(2)} ${fg} on ${bg}`);
            }
            if (hc === 'normal' && theme === 'light') await shot(B, '11a-phone-notice-light');
        }
    }
    await B.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.setAttribute('data-contrast', 'normal'); });
    check('phone, all eight themes, normal and high contrast: the notice and the tile >= 4.5:1', noticePoor.length === 0, noticePoor.length ? noticePoor : { measured: noticeMeasured });
    await B.locator('.activity-notice').getByRole('button', { name: 'Join', exact: true }).tap();
    check('phone: Join from the notice seats it, no disclosure the second time', !!await until(async () => (await B.locator('.gtable-blackjack').count()) > 0 && (await B.locator('.games-me .games-me-info').count()) > 0, 8000) && !(await B.locator('.games-disclosure').count()));
    check('both seated at Blackjack with a bet bar', !!await until(async () => (await A.locator('.games-footer .games-actions').count()) > 0 && (await B.locator('.games-footer .games-actions').count()) > 0, 10000));
    await shot(B, '11-phone-blackjack-bet');
    const gb = await phoneGeometry(B);
    check('phone: the Blackjack bet bar fits, 44 px targets, two rows', geometryOk(gb) && gb.barRows === 2, gb);
    await A.getByRole('button', { name: /^Bet / }).click();
    await B.locator('.games-footer .games-actions-row').first().locator('button').first().tap();
    check('the round is dealt: the dealer shows one card up, one down', !!await until(async () =>
        (await B.locator('.bj-dealer .pcard-back').count()) === 1 && (await B.locator('.bj-dealer [data-card]').count()) === 1, 20000));
    let bjTurns = 0;
    for (let i = 0; i < 10; i++) {
        const who = await until(async () => {
            if (await B.locator('.games-footer button', { hasText: 'Stand' }).count()) return 'B';
            if (await A.locator('.games-footer button', { hasText: 'Stand' }).count()) return 'A';
            if ((await B.locator('.bj-hand-outcome').count()) > 0) return 'done';
            return null;
        }, 40000);
        if (who === 'done' || !who) break;
        if (who === 'B') {
            const g = await phoneGeometry(B);
            check('phone: Blackjack turn bar fits, 44 px targets, two rows', geometryOk(g) && g.barRows === 2, g);
            await shot(B, '12-phone-blackjack-your-turn');
            await B.locator('.games-footer button', { hasText: 'Stand' }).tap();
        } else {
            if (bjTurns === 0) await shot(A, '13-desktop-blackjack-your-turn');
            await A.locator('.games-footer button', { hasText: 'Stand' }).click();
        }
        bjTurns++;
        await sleep(600);
    }
    check('the round settles with results on both screens', !!await until(async () => (await A.locator('.bj-hand-outcome').count()) > 0 && (await B.locator('.bj-hand-outcome').count()) > 0, 20000));
    await shot(A, '14-desktop-blackjack-results');
    await shot(B, '15-phone-blackjack-results');
    check('both still in the call after all of it', (await A.locator('.voice-panel-compact .voice-connected-label').count()) > 0 && (await B.locator('.voice-panel-compact .voice-connected-label').count()) > 0);
    check('no alert() at any point', alerts.length === 0, alerts);
} catch (e) {
    check('walk ran to the end', false, String(e && e.stack || e).slice(0, 600));
} finally {
    await browser.close();
}
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures);
