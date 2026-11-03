// LIVE: server modes (docs/SERVER_MODES.md) through a real backend and the REAL
// web client, the owner on a 1280x800 desktop and a member on a 390x844
// coarse-pointer phone that is never reloaded after sign-in, so anything it shows
// reached it live. A third account holds the Switch Modes permission.
//
// What it proves:
//   1. defining: the real Modes tab in Server Settings, on both pointer worlds: a
//      name, ticked channels, a main voice channel, a real picture through the real
//      upload path, an accent colour; a phone's controls are 44 px, its inputs 16 px;
//   2. hiding is tidiness: with the mode off the phone does not list the mode's
//      channels (a voice room under a ticked collection among them), while the API still
//      returns them with mode_ids and a real #mention opens one (control: an unmoded
//      channel is listed throughout, and keeps its call);
//   3. switching: the owner's real selector; the phone's channels, label, notice,
//      background and accent all arrive with no reload; a member without the right
//      gets a label, not a button; the notice's Join joins the main channel;
//   4. Call everyone back moves the phone out of a private room into the main channel,
//      and a role holding only Move Members can press it;
//   5. turning off: the warning names the people, the phone's real call ends with the
//      toast saying why, in a room under a ticked collection, the channels and the look go;
//   6. Switch Modes (bit 31): a role holding it switches, and it stays a positive
//      number in the database's answer after an edit that sends the whole mask;
//   7. the look on all eight themes, with and without high contrast, on a bright picture
//      and a dark one: the picture really there and mapped per theme, every run of real text
//      on it (messages, links, timestamps, the date line, the header, the composer's
//      placeholder) at 4.5:1 over every pixel actually rendered behind it, read from a
//      screenshot with the text made transparent, and the accent at 4.5:1 with a white label
//      and 3:1 on the surfaces. NEGATIVE CONTROL: the theme's own text colours over the same
//      picture must fail. High contrast and the personal switch must take picture and accent
//      away, and the theme's own brand must come back. A mode never changes the reader's theme.
//   8. the phone: nothing overflows 390 px (a 460 px element injected must be caught),
//      the selector and the notice's buttons are 44 px and hit at their centres, the
//      menu is inside the window, and the focus is on it, on no item, with no ring.
//      The owner's selector from real keys: Enter puts the focus in the menu, arrows and End
//      walk it, Escape gives it back, Tab closes it. NEGATIVE CONTROL: a right click's menu
//      takes no focus and no role. (Every key is in e2e/user-menu-move-to-real-browser.mjs.)
//   9. a message toast about a hidden channel on another server opens it; a picture over
//      the limit arrives as a JPEG of at most 1920 px, a GIF is refused, a picture nobody
//      can read is treated as black and white; the real personal-switch checkbox;
//  10. with LK_API, on channels with sfu_mode on, by what LiveKit's ListParticipants says
//      (rooms are sfu_<id>): turning off takes everyone out, a client that ignores being
//      told and a session whose socket died among them; a channel shared with the next
//      mode keeps the very same session; Call everyone back moves them, LiveKit's removal
//      first, and after a removal that was no move a directive moves nobody; Turn off when
//      empty sees a person in an SFU call and a session with no room entry, and not a
//      stream-only account. A call in a channel no mode names is the control throughout.
// Each check prints PASS/FAIL; the exit code is the number of failures. Screenshots
// go to OUT (SHOT <file>): look at them.
//
// Prereqs: a THROWAWAY backend (APP_ENV=development, raised AUTH_RATE_LIMIT_PER_SECOND
// / _BURST, its own fresh database, never a real one) at API, and vite of THIS tree at
// APP started with VITE_API_URL=API (the walk imports /src/api/* modules through vite
// to set the fixture up). It refuses to start unless both are loopback and the page
// really talks to API: it creates accounts. Silent: --mute-audio and fake media devices.
// Step 10 also needs that backend's LIVEKIT_* pointing at a loopback-only LiveKit (config
// in share-adapt-shaped.mjs's header, plus a webhook to API/livekit/webhook; check its
// sockets, a firewall prompt is what a mistake there costs), LK_API / LK_KEY / LK_SECRET
// for that LiveKit, and PGDB / PGPORT for the backend's database, whose clock it moves
// back to make a tick judge a mode. A tick is once a minute, so it takes about 6 minutes.
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5421 API=http://127.0.0.1:5321 OUT=<dir> node e2e/modes-walk.mjs
//   ... LK_API=http://127.0.0.1:7895 LK_KEY=... LK_SECRET=... PGDB=... PGPORT=... [SFU_ONLY=1] node e2e/modes-walk.mjs
import { chromium } from '@playwright/test';
import { drawScene } from './mode-scenes.mjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP || 'http://127.0.0.1:5421';
const API = process.env.API;
const OUT = process.env.OUT || 'e2e/shots-modes';
const isLoopback = (url) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return false; } };
if (!isLoopback(APP) || !isLoopback(API)) {
    console.error(`modes-walk creates accounts: APP and API must both be loopback (APP=${APP} API=${API})`);
    process.exit(2);
}
const LK = process.env.LK_API && process.env.LK_KEY && process.env.LK_SECRET
    ? { api: process.env.LK_API, key: process.env.LK_KEY, secret: process.env.LK_SECRET } : null; // the throwaway LiveKit's
const PG = { db: process.env.PGDB, port: process.env.PGPORT || '5432' };
const PSQL = process.env.PSQL || 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
if (LK && (!isLoopback(LK.api) || !PG.db)) {
    console.error(`the SFU run needs a loopback LK_API and PGDB (LK_API=${LK.api} PGDB=${PG.db})`);
    process.exit(2);
}
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
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

const dialogs = [];
function watch(page, tag) {
    page.on('console', m => fs.appendFileSync(path.join(OUT, 'console.txt'), `${new Date().toISOString()} ${tag} ${m.type()} ${m.text().slice(0, 400)}\n`));
    page.on('pageerror', e => { console.log(`  [${tag} pageerror]`, e.message.slice(0, 200)); check(`${tag}: no uncaught page error`, false, e.message.slice(0, 200)); });
    page.on('dialog', d => {
        dialogs.push(`${tag}: ${d.message()}`);
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
const servers = (page, fn, args = []) => call(page, '/src/api/servers.ts', fn, args);
const modesApi = (page, fn, args = []) => call(page, '/src/api/serverModes.ts', fn, args);
/** A call that may be refused: 'ok', or the status. An error loses its fields
 *  crossing out of page.evaluate, so the status has to be read in the page. */
const attempt = (page, fn, args = []) => page.evaluate(async ({ fn, args }) => {
    const m = await import('/src/api/serverModes.ts');
    try { await m[fn](...args); return 'ok'; } catch (e) { return e.status ?? String(e); }
}, { fn, args });

/**
 * Text that fails 4.5:1 on what is actually painted behind it, under `roots`. The
 * light theme once put dark ink on a dark notice here and every other check passed.
 * Disabled controls and aria-hidden decoration are exempt, as WCAG 1.4.3 exempts them.
 */
const illegibleText = (page, roots) => page.evaluate((roots) => {
    const rgba = (s) => { const m = s.match(/[\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); return [r, g, b, a]; };
    const paint = (el) => {
        const layers = [];
        for (let e = el; e; e = e.parentElement) {
            const c = rgba(getComputedStyle(e).backgroundColor);
            if (!c || c[3] === 0) continue;
            layers.push(c);
            if (c[3] >= 1) break;
        }
        let [r, g, b] = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : [255, 255, 255];
        for (const [lr, lg, lb, la] of layers.reverse()) {
            r = lr * la + r * (1 - la); g = lg * la + g * (1 - la); b = lb * la + b * (1 - la);
        }
        return [r, g, b];
    };
    const lin = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (x, y) => { const [h, l] = [lum(x), lum(y)].sort((p, q) => q - p); return (h + 0.05) / (l + 0.05); };
    const bad = [];
    let measured = 0;
    for (const root of document.querySelectorAll(roots)) {
        for (const el of [root, ...root.querySelectorAll('*')]) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (el.closest('[aria-hidden="true"], button:disabled, [aria-disabled="true"], option')) continue;
            if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
            const bg = paint(el);
            let [ir, ig, ib, ia] = rgba(getComputedStyle(el).color);
            for (let e = el; e; e = e.parentElement) ia *= Number(getComputedStyle(e).opacity);
            const ink = [ir * ia + bg[0] * (1 - ia), ig * ia + bg[1] * (1 - ia), ib * ia + bg[2] * (1 - ia)];
            measured++;
            const c = ratio(ink, bg);
            if (c < 4.5) bad.push(`${el.textContent.trim().slice(0, 28)} ${c.toFixed(2)}`);
        }
    }
    return { measured, bad: [...new Set(bad)].slice(0, 8) };
}, roots);

/** Channel names the sidebar lists right now, read without touching the panels. */
const listed = (page) => page.evaluate(() =>
    [...document.querySelectorAll('.sidebar .channel-name, .sidebar .voice-channel')].map(e => e.textContent.trim()));
const lists = (names, name) => names.some(n => n.includes(name));

/** A picture as a JPEG on disk, drawn in the page (e2e/mode-scenes.mjs). */
async function picture(page, name) {
    const file = path.join(OUT, `${name}.jpg`);
    fs.writeFileSync(file, Buffer.from(await page.evaluate(drawScene, name), 'base64'));
    return file;
}

/** The phone's geometry for what `rootSel` matches, measured as games-walk does. */
async function phoneGeometry(page, rootSel) {
    return page.evaluate((rootSel) => {
        const vw = document.documentElement.clientWidth;
        const overflow = [];
        const small = [];
        const covered = [];
        const roots = [...document.querySelectorAll(rootSel)];
        for (const root of roots) {
            for (const el of [root, ...root.querySelectorAll('*')]) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                if (r.right > vw + 0.5 || r.left < -0.5) overflow.push({ el: String(el.className || el.tagName).slice(0, 40), left: Math.round(r.left), right: Math.round(r.right) });
            }
            const buttons = root.matches('button') ? [root, ...root.querySelectorAll('button')] : [...root.querySelectorAll('button')];
            for (const b of buttons) {
                const r = b.getBoundingClientRect();
                if (r.width === 0) continue;
                if (r.height < 43.5 || r.width < 43.5) small.push({ text: (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) });
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                if (r.top >= 0 && r.bottom <= innerHeight && !(hit && b.contains(hit))) covered.push({ text: b.textContent.trim().slice(0, 24), by: hit ? String(hit.className || hit.tagName).slice(0, 40) : null });
            }
        }
        return { roots: roots.length, vw, scrollWidth: document.documentElement.scrollWidth, overflow: overflow.slice(0, 6), small: small.slice(0, 8), covered: covered.slice(0, 6) };
    }, rootSel);
}
const fits = (g) => g.roots > 0 && g.overflow.length === 0 && g.small.length === 0 && g.covered.length === 0 && g.scrollWidth <= g.vw + 0.5;

/** Open the selector's menu on this page and press the item called `label`. */
async function pick(page, phone, label) {
    const sel = page.locator('[data-testid="mode-selector"]');
    await (phone ? sel.tap() : sel.click());
    const item = page.locator('.context-menu .context-menu-item', { hasText: label }).first();
    await item.waitFor({ timeout: 8000 });
    await (phone ? item.tap() : item.click());
}

/** Any change of look maps the picture again and none shows meanwhile, so gone has to last. */
async function pictureStaysGone(page) {
    if (!await until(async () => !(await measureLook(page)).picture, 4000)) return false;
    await sleep(2500);
    return !(await measureLook(page)).picture;
}

/** Is the picture up, and what does the accent do on this theme? */
async function measureLook(page) {
    return page.evaluate(() => {
        // What the page paints, by the arithmetic the WCAG defines.
        const lin = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        const contrast = (a, b) => { const [h, l] = [lum(a), lum(b)].sort((x, y) => y - x); return (h + 0.05) / (l + 0.05); };
        const read = (token) => {
            const p = document.createElement('div');
            p.style.color = `var(${token})`;
            p.style.display = 'none';
            document.body.appendChild(p);
            const m = getComputedStyle(p).color.match(/[\d.]+/g).map(Number);
            p.remove();
            return m.slice(0, 3);
        };
        const accent = read('--brand-primary');
        return {
            picture: /url\("data:image\/jpeg/.test(getComputedStyle(document.querySelector('.chat-main')).backgroundImage),
            accent,
            labelContrast: contrast(accent, [255, 255, 255]),
            surfaceContrast: Math.min(contrast(accent, read('--bg-primary')), contrast(accent, read('--bg-secondary'))),
        };
    });
}

/**
 * Every run of text drawn directly on the picture, against the pixels actually behind it. The
 * page is photographed with its text transparent, and each run's colour is compared with
 * every pixel of its box, so the JPEG, the scaling and anything translucent on the way all
 * count. Text on a surface of its own (a button, a chip, the notice) is not on the picture.
 */
/**
 * Fades and colour transitions over: a colour on its way counts against the ink, and a fixed wait
 * promises nothing on a busy machine (the Mode menu read 1.00:1, every item, at its first keyframe).
 * What loops never finishes and is not waited for.
 */
const settled = (page) => page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations()
        .filter(a => a.effect?.getComputedTiming().iterations !== Infinity)
        .map(a => a.finished.catch(() => {}))),
    new Promise(done => setTimeout(done, 5000)),
]).then(() => {}));

async function textOverPicture(page) {
    await page.mouse.move(1, 1);
    await settled(page);
    const runs = await page.evaluate(() => {
        const rgba = (s) => { const m = s.match(/[\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); return [r, g, b, a]; };
        const root = document.querySelector('.chat-main');
        const onItsOwnSurface = (el) => {
            for (let e = el; e && e !== root; e = e.parentElement) {
                const cs = getComputedStyle(e);
                if ((rgba(cs.backgroundColor)?.[3] ?? 0) >= 0.9 || cs.backgroundImage !== 'none') return true;
            }
            return false;
        };
        const inView = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
        const faded = (el) => { let a = 1; for (let e = el; e; e = e.parentElement) a *= Number(getComputedStyle(e).opacity); return a; };
        const out = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const el = node.parentElement;
            if (!node.textContent.trim() || el.closest('[aria-hidden="true"], button:disabled, [aria-disabled="true"], option, script, style')) continue;
            if (onItsOwnSurface(el)) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const rects = [...range.getClientRects()].filter(inView);
            const cs = getComputedStyle(el);
            if (!rects.length || cs.visibility === 'hidden') continue;
            const [r, g, b, a] = rgba(cs.color);
            const alpha = a * faded(el);
            if (alpha > 0) out.push({ text: node.textContent.trim().slice(0, 24), colour: [r, g, b], alpha, rects: rects.map(q => [q.left, q.top, q.right, q.bottom]) });
        }
        for (const box of root.querySelectorAll('textarea[placeholder]')) {
            if (onItsOwnSurface(box)) continue;
            const q = box.getBoundingClientRect();
            const [r, g, b, a] = rgba(getComputedStyle(box, '::placeholder').color);
            if (inView(q)) out.push({ text: 'placeholder', colour: [r, g, b], alpha: a, rects: [[q.left, q.top + q.height * 0.2, Math.min(q.right, q.left + 240), q.bottom - q.height * 0.2]] });
        }
        return out;
    });
    const hide = await page.addStyleTag({ content: '.chat-main, .chat-main * { color: transparent !important; text-shadow: none !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; } .chat-main *::placeholder { color: transparent !important; }' });
    await settled(page);
    const png = await page.screenshot();
    await hide.evaluate(e => e.remove());
    // Colours with a transition are on their way back from transparent: the next reader waits.
    await settled(page);
    return page.evaluate(async ({ b64, runs }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const scale = img.naturalWidth / innerWidth;
        const lin = new Float64Array(256);
        for (let i = 0; i < 256; i++) { const v = i / 255; lin[i] = v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
        const lum = (r, gg, b) => 0.2126 * lin[Math.round(r)] + 0.7152 * lin[Math.round(gg)] + 0.0722 * lin[Math.round(b)];
        const bad = [];
        let tightest = Infinity;
        for (const run of runs) {
            let worst = Infinity;
            for (const [l, t, r, b] of run.rects) {
                const x = Math.max(0, Math.floor(l * scale));
                const y = Math.max(0, Math.floor(t * scale));
                const w = Math.min(c.width - x, Math.ceil((r - l) * scale));
                const h = Math.min(c.height - y, Math.ceil((b - t) * scale));
                if (w <= 0 || h <= 0) continue;
                const { data } = g.getImageData(x, y, w, h);
                for (let i = 0; i < data.length; i += 4) {
                    const under = lum(data[i], data[i + 1], data[i + 2]);
                    const a = run.alpha;
                    const ink = lum(run.colour[0] * a + data[i] * (1 - a), run.colour[1] * a + data[i + 1] * (1 - a), run.colour[2] * a + data[i + 2] * (1 - a));
                    const ratio = (Math.max(ink, under) + 0.05) / (Math.min(ink, under) + 0.05);
                    if (ratio < worst) worst = ratio;
                }
            }
            if (worst < tightest) tightest = worst;
            if (worst < 4.5) bad.push(`${run.text} ${worst.toFixed(2)}`);
        }
        return { measured: runs.length, tightest: Math.round(tightest * 100) / 100, bad: [...new Set(bad)].slice(0, 10) };
    }, { b64: png.toString('base64'), runs });
}

async function setTheme(page, theme, contrastOn) {
    await page.evaluate(([theme, contrastOn]) => {
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-contrast', contrastOn ? 'high' : 'normal');
    }, [theme, contrastOn]);
    await settled(page);
}

/**
 * Open the menu people switch from and read it, and on Light the server icon's own menu
 * too. Both sit on a fixed dark background, and on the Light theme their text was once
 * dark as well, at 1.5:1, which every other check passed.
 */
async function menuLegible(page, label) {
    await page.locator('[data-testid="mode-selector"]').click();
    await page.locator('.context-menu').waitFor({ timeout: 5000 });
    await settled(page); // It fades in, and opacity counts against the ink.
    const menu = await illegibleText(page, '.context-menu');
    check(`${label}: the Mode menu is legible`, menu.measured >= 2 && menu.bad.length === 0, menu);
    await page.keyboard.press('Escape');
    await page.locator('.context-menu').waitFor({ state: 'detached', timeout: 5000 });
}

/** The real selector's menu from real keys, and Chat's right-click menu as the control. */
async function menuFromTheKeyboard(page) {
    const focusOn = () => page.evaluate(() => {
        const a = document.activeElement;
        return a?.getAttribute('data-testid') || a?.textContent?.trim() || 'body';
    });
    const gone = () => page.locator('.context-menu').waitFor({ state: 'detached', timeout: 5000 });
    await page.locator('[data-testid="mode-selector"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('.context-menu').waitFor({ timeout: 5000 });
    check('keyboard: Enter on the real selector opens a menu with the focus on its first item',
        await focusOn() === 'Off' && await page.locator('.context-menu').getAttribute('role') === 'menu', await focusOn());
    await page.keyboard.press('ArrowDown');
    check('keyboard: Down moves on from it', await focusOn() !== 'Off', await focusOn());
    await page.keyboard.press('End');
    check('keyboard: End is the last item', await focusOn() === 'Manage modes', await focusOn());
    await page.keyboard.press('Escape');
    await gone();
    check('keyboard: Escape closes it, and the focus is back on the selector', await focusOn() === 'mode-selector', await focusOn());
    await page.keyboard.press('Enter');
    await page.locator('.context-menu').waitFor({ timeout: 5000 });
    await page.keyboard.press('Tab');
    await gone();
    check('keyboard: Tab closes it, and the focus goes on from the selector', await focusOn() !== 'mode-selector', await focusOn());
    await page.locator('.sidebar .channel').first().click({ button: 'right' });
    await page.locator('.context-menu').waitFor({ timeout: 5000 });
    const atPointer = await page.evaluate(() => {
        const menu = document.querySelector('.context-menu');
        return { inside: menu.contains(document.activeElement), role: menu.getAttribute('role'), items: menu.querySelectorAll('button').length };
    });
    check('NEGATIVE CONTROL: a right click in the same Chat opens the same menu with no focus in it and no role', !atPointer.inside && atPointer.role === null && atPointer.items > 0, atPointer);
    await page.keyboard.press('Escape');
    await gone();
}

function keepSockets() {
    const Native = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Native {
        constructor(...args) {
            super(...args);
            window.__sockets.push(this);
        }
    };
}

/**
 * Every WebSocket the page opens, with four things a test can do to the app's alone: ignore
 * frames matching `window.__ignoreFrames` (a client that does not act on what it is told),
 * hold back those matching `window.__lateFrames` for 800 ms (LiveKit's removal then always
 * gets there first), hand it a frame with `window.__deliverFrame`, and refuse a new one while
 * `window.__noAppSocket` holds (a page in a LiveKit call whose socket to the app is gone).
 * LiveKit's own socket is left alone.
 */
function appSockets(origin) {
    const Native = window.WebSocket;
    window.__appSockets = [];
    window.WebSocket = class extends Native {
        constructor(url, ...rest) {
            const app = String(url).startsWith(origin);
            super(app && window.__noAppSocket ? 'ws://127.0.0.1:9/' : url, ...rest);
            this.__app = app;
            if (app) window.__appSockets.push(this);
        }
        set onmessage(fn) {
            if (fn && this.__app) window.__deliverFrame = (data) => fn(new MessageEvent('message', { data }));
            super.onmessage = !fn || !this.__app ? fn : (e) => {
                if (window.__ignoreFrames?.test(String(e.data))) return;
                if (window.__lateFrames?.test(String(e.data))) setTimeout(() => fn(e), 800);
                else fn(e);
            };
        }
    };
}

/** Who LiveKit itself says is in `room`. A query it refuses throws: it cannot read as nobody. */
async function lkPeople(room) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: LK.key, sub: 'modes-walk', nbf: now - 5, exp: now + 300, video: { roomAdmin: true, roomList: true, room } })}`;
    const jwt = `${body}.${crypto.createHmac('sha256', LK.secret).update(body).digest('base64url')}`;
    const r = await fetch(`${LK.api}/twirp/livekit.RoomService/ListParticipants`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ room }),
    });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`ListParticipants ${room}: ${r.status}`);
    return ((await r.json()).participants || []).map(p => ({ identity: p.identity, sid: p.sid }));
}

/** The walk's story again on channels with sfu_mode on, asking LiveKit who is in each room. */
async function sfuRun() {
    const ctxOf = async (tag, sockets) => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        if (sockets) await ctx.addInitScript(appSockets, API.replace(/^http/, 'ws'));
        return signIn(ctx, `${tag}_${stamp}`, tag);
    };
    const O = await ctxOf('sfo');
    const P = await ctxOf('sfp', true);
    const Q = await ctxOf('sfq', true);
    const S = await ctxOf('sfs');
    const uidOf = (page) => page.evaluate(() => JSON.parse(atob(localStorage.getItem('auth_token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub);
    const [oId, pId, qId, sId] = await Promise.all([O, P, Q, S].map(uidOf));

    const srvName = 'sfu_' + stamp;
    const srv = await servers(O, 'createServer', [srvName]);
    const voice = async (name, parent) => {
        const c = await servers(O, 'createChannel', parent ? [srv.id, name, 1, parent] : [srv.id, name, 1]);
        await servers(O, 'updateChannel', [c.id, { sfu_mode: true }]);
        return c;
    };
    const town = await voice('Town Square');
    const cottage = await voice('Cottage');
    const shared = await voice('Shared');
    const keep = await voice('Keep');
    const rooms = await servers(O, 'createChannel', [srv.id, 'Rooms', 2]);
    const attic = await voice('Attic', rooms.id);
    const inv = await servers(O, 'createInvite', [srv.id, {}]);
    for (const page of [P, Q, S]) await servers(page, 'joinViaInvite', [inv.code]);
    const clock = await modesApi(O, 'createMode', [srv.id, { name: 'Clocktower', channel_ids: [town.id, cottage.id, shared.id, rooms.id], home_channel_id: town.id }]);
    await modesApi(O, 'createMode', [srv.id, { name: 'Werewolf', channel_ids: [shared.id], home_channel_id: shared.id }]);

    const sql = (text) => execFileSync(PSQL, ['-h', '127.0.0.1', '-p', PG.port, '-U', 'postgres', '-d', PG.db, '-t', '-A', '-c', text],
        { encoding: 'utf8', windowsHide: true, env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' } }).trim();
    if (sql(`SELECT count(*) FROM servers WHERE id = '${srv.id}'`) !== '1') throw new Error(`PGDB=${PG.db} is not the database API=${API} uses`);
    /** Where the auto-off stands: seconds since it last saw someone (null: nobody yet), and the mode on. */
    const autoOff = () => {
        const [mode, age] = sql(`SELECT active_mode_id, EXTRACT(EPOCH FROM NOW() - active_mode_occupied_at)::int FROM servers WHERE id = '${srv.id}'`).split('|');
        return { mode: mode === '' ? null : Number(mode), age: age === '' ? null : Number(age) };
    };
    /** Make it look empty for 40 minutes, and wait for a tick (once a minute) to judge it. */
    const nextVerdict = async () => {
        sql(`UPDATE servers SET active_mode_occupied_at = NOW() - interval '40 minutes' WHERE id = '${srv.id}'`);
        return until(() => { const a = autoOff(); return a.mode === null || a.age < 300 ? a : null; }, 80000, 1000);
    };

    const afresh = async (page) => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(2500);
        await dismiss(page);
        await page.locator(`.server-icon[title="${srvName}"]`).click();
        await sleep(600);
    };
    for (const page of [O, P, Q, S]) await afresh(page);

    const sessions = async (channel, user) => (await lkPeople(`sfu_${channel.id}`)).filter(p => p.identity.startsWith(`u${user}#`));
    const row = (page, channel) => page.locator(`[data-testid="voice-channel"][data-channel-id="${channel.id}"]`).first();
    /** Join by the real row; the session LiveKit lists for them, once it has exactly one. */
    const enter = async (page, channel, user) => {
        await row(page, channel).click();
        return until(async () => { const s = await sessions(channel, user); return s.length === 1 ? s[0] : null; }, 30000, 500);
    };
    const gone = (channel, user) => until(async () => (await sessions(channel, user)).length === 0, 15000, 250);
    const inCall = async (page) => (await page.locator('.voice-panel-compact .voice-connected-label').count()) > 0;
    const leave = async (page) => {
        if (await inCall(page)) await page.locator('[title="Disconnect"]').first().click();
        await until(async () => !(await inCall(page)), 10000);
    };
    const room = (page) => page.evaluate(async () => {
        const live = (await import('/src/api/rtc/sfuManager.ts')).sfuManager?.room;
        return live ? { name: live.name, state: live.state } : null;
    });
    const told = (page, name) => until(async () => (await page.evaluate(() => document.body.innerText)).includes(`${name} ended, so this call ended`), 8000);
    const auditRow = async (action) => (await servers(O, 'listAuditLog', [srv.id])).find(r => r.action_type === action);
    /** On from the owner's real selector, and arrived at the page that needs its rows. */
    const turnOn = async (name, page, channel) => {
        await pick(O, false, name);
        await until(() => row(page, channel).count(), 8000);
    };

    // A control that stays through every step: a call in a channel no mode names.
    const keepSession = await enter(O, keep, oId);
    check('SFU: the owner\'s call in a channel no mode names is in LiveKit, in a room named for it', !!keepSession, await lkPeople(`sfu_${keep.id}`));
    const keptCall = async () => (await sessions(keep, oId))[0]?.sid === keepSession?.sid;

    // ── Turning off. One person's client does what it is told. The other's ignores it, so
    //    only the server can take them out, and they are in a room under the collection.
    await turnOn('Clocktower', Q, attic);
    const pTown = await enter(P, town, pId);
    const qAttic = await enter(Q, attic, qId);
    check('SFU: LiveKit lists the person in the main channel and the one under the collection', !!pTown && !!qAttic, { pTown, qAttic });
    await Q.evaluate(() => { window.__ignoreFrames = /"type":"(RoomLeft|ServerModeChanged)"/; });
    let warned = dialogs.length;
    await pick(O, false, 'Off');
    check('SFU: turning off warns of the two, and not of the call elsewhere', await until(() => dialogs.length > warned, 4000) && /^sfo: 2 people are in .*disconnected/.test(dialogs[dialogs.length - 1]), dialogs.slice(warned));
    check('SFU: turning off takes the main channel\'s session out of LiveKit', !!await gone(town, pId), await lkPeople(`sfu_${town.id}`));
    check('SFU: and the session of a client that ignored being told, under the collection: only the server can do that', !!await gone(attic, qId), await lkPeople(`sfu_${attic.id}`));
    check('SFU: the client that listened ended its call and says why', !!await until(async () => !(await inCall(P)), 10000) && !!await told(P, 'Clocktower'));
    await sleep(4000);
    check('SFU: four seconds on, nobody is back in LiveKit', (await lkPeople(`sfu_${town.id}`)).length === 0 && (await lkPeople(`sfu_${attic.id}`)).length === 0);
    check('SFU control: the call in a channel no mode names is the same session', await keptCall(), await lkPeople(`sfu_${keep.id}`));
    await Q.evaluate(() => { window.__ignoreFrames = null; });
    await afresh(Q);
    await leave(P);

    // ── A channel the next mode also shows keeps its call, the very session.
    await turnOn('Clocktower', Q, cottage);
    await until(() => row(P, shared).count(), 8000);
    const pShared = await enter(P, shared, pId);
    const qCottage = await enter(Q, cottage, qId);
    check('SFU: one person in the channel both modes show, one in a channel only this one does', !!pShared && !!qCottage, { pShared, qCottage });
    warned = dialogs.length;
    await pick(O, false, 'Werewolf');
    check('SFU: switching warns of the one it ends, and not of the one it keeps', await until(() => dialogs.length > warned, 4000) && /^sfo: 1 person is in .*disconnected/.test(dialogs[dialogs.length - 1]), dialogs.slice(warned));
    check('SFU: the switch takes the other channel\'s session out of LiveKit', !!await gone(cottage, qId), await lkPeople(`sfu_${cottage.id}`));
    check('SFU control: and that person\'s client is told why', !!await told(Q, 'Clocktower'));
    await sleep(5000);
    const stillShared = await sessions(shared, pId);
    check('SFU: the channel shared with the next mode keeps its call in LiveKit, the same session', stillShared.length === 1 && stillShared[0].sid === pShared?.sid, { pShared, stillShared });
    const pRoom = await room(P);
    check('SFU: its client is still connected to that room, and nothing told it the call ended', pRoom?.name === `sfu_${shared.id}` && pRoom.state === 'connected' && await inCall(P)
        && !(await P.evaluate(() => document.body.innerText)).includes('so this call ended'), pRoom);
    check('SFU control: the call elsewhere is the same session', await keptCall());
    await leave(P);

    // ── Call everyone back: out of a private room and a room under the collection.
    await turnOn('Clocktower', Q, attic);
    await until(() => row(P, cottage).count(), 8000);
    check('SFU: one person in a private room, one under the collection', !!await enter(P, cottage, pId) && !!await enter(Q, attic, qId));
    // Two sockets, nothing ordering them: for one of them LiveKit's removal arrives first.
    await Q.evaluate(() => { window.__lateFrames = /"type":"VoiceMoved"/; });
    await pick(O, false, 'Call everyone to Town Square');
    const moved = await until(async () => {
        const [p, q] = await Promise.all([sessions(town, pId), sessions(town, qId)]);
        return p.length === 1 && q.length === 1 ? { p, q } : null;
    }, 30000, 500);
    check('SFU: Call everyone back moves both into the main channel, by LiveKit\'s own list', !!moved, await lkPeople(`sfu_${town.id}`));
    check('SFU: and out of where they were, with one session each', !!await gone(cottage, pId) && !!await gone(attic, qId), { cottage: await lkPeople(`sfu_${cottage.id}`), attic: await lkPeople(`sfu_${attic.id}`) });
    // LiveKit lists a session a moment before its client calls itself connected.
    const movedTo = await until(async () => {
        const both = [await room(P), await room(Q)];
        return both.every(r => r?.name === `sfu_${town.id}` && r.state === 'connected') ? both : null;
    }, 10000);
    check('SFU: both clients are connected to the main channel\'s room', !!movedTo, [await room(P), await room(Q)]);
    check('SFU: and each is told who moved them', (await Promise.all([P, Q].map(p => until(async () => (await p.evaluate(() => document.body.innerText)).includes('moved you to Town Square'), 8000)))).every(Boolean));
    check('SFU control: the caller\'s own call elsewhere did not move', await keptCall());
    await shot(O, 'sfu-01-called-back');
    // A removal that was no move, with LiveKit's getting there first again. The eviction's RoomLeft
    // comes on top of the answer to the client's own leave, so a directive after them moves nobody.
    await Q.evaluate(() => { window.__lateFrames = /"type":"RoomLeft"/; });
    await servers(O, 'moveMemberVoice', [srv.id, qId, null]);
    check('SFU: a moderator\'s disconnect takes the session out of LiveKit', !!await gone(town, qId), await lkPeople(`sfu_${town.id}`));
    const qOut = await until(async () => !(await inCall(Q)), 10000);
    await sleep(1200);
    await Q.evaluate(({ server, to, from }) => window.__deliverFrame(JSON.stringify({ type: 'VoiceMoved', payload: { server_id: server, channel_id: to, from_channel_id: from, moved_by: 'someone' } })), { server: srv.id, to: cottage.id, from: town.id });
    await sleep(2500);
    check('SFU: after a removal that was no move, a directive moves nobody', !!qOut && !await inCall(Q) && (await sessions(cottage, qId)).length === 0, await room(Q));
    await Q.evaluate(() => { window.__lateFrames = null; });
    await leave(Q);

    // ── Turn off when empty. A person in an SFU call keeps a stale mode on.
    let verdict = await nextVerdict();
    check('SFU: Turn off when empty sees a person in an SFU call: a tick judged it and the mode stayed on', verdict?.mode === clock.id && verdict.age < 300, verdict);
    const pBefore = (await sessions(town, pId))[0];
    const voiceRow = () => O.locator('.voice-channel-container', { hasText: 'Town Square' }).first().innerText();
    check('SFU control: everyone lists the person in the main channel', !!await until(async () => (await voiceRow()).includes('sfp_'), 8000), await voiceRow().catch(String));
    // Then the socket goes and the LiveKit session stays: the room has lost track of them.
    const closed = await P.evaluate(() => {
        window.__noAppSocket = true;
        const open = window.__appSockets.filter(s => s.readyState === WebSocket.OPEN);
        for (const s of open) s.close();
        return open.length;
    });
    check('SFU: the person\'s socket to the app is gone', closed >= 1, closed);
    check('SFU: the room has lost track of them (past the rejoin grace, everyone stops listing them)', !!await until(async () => !(await voiceRow()).includes('sfp_'), 25000), await voiceRow().catch(String));
    const pAfter = (await sessions(town, pId))[0];
    check('SFU control: LiveKit still has that session', !!pBefore && pAfter?.sid === pBefore.sid, { pBefore, pAfter });
    verdict = await nextVerdict();
    check('SFU: Turn off when empty counts a LiveKit session with no room entry', verdict?.mode === clock.id && verdict.age < 300, verdict);
    await pick(O, false, 'Off');
    check('SFU: turning off cuts a LiveKit session with no room entry', !!await gone(town, pId), await lkPeople(`sfu_${town.id}`));
    await until(async () => (await auditRow('mode_switch'))?.details === 'Clocktower off, 1 disconnected', 5000);
    const offRow = await auditRow('mode_switch');
    check('SFU: and the audit log counts them', offRow?.details === 'Clocktower off, 1 disconnected', offRow);
    await P.evaluate(() => { window.__noAppSocket = false; });
    await afresh(P);

    // ── The same tick with only a stream-only account there: it is nobody, so it turns off.
    const role = await servers(O, 'createRole', [srv.id, { name: 'Stream only', permissions: (1 << 11) | (1 << 29) }]);
    await call(O, '/src/api/channels.ts', 'putChannelOverwrite', [town.id, role.id, 1 | (1 << 8), 0]);
    await servers(O, 'assignRole', [srv.id, sId, role.id]);
    await afresh(S);
    await turnOn('Clocktower', Q, town);
    await until(() => row(S, town).count(), 8000);
    check('SFU: someone uses the mode and goes', !!await enter(Q, town, qId));
    await leave(Q);
    await gone(town, qId);
    check('SFU: joining stamped the mode', autoOff().age !== null, autoOff());
    const sSession = await enter(S, town, sId);
    check('SFU: the stream-only account is in LiveKit', !!sSession, await lkPeople(`sfu_${town.id}`));
    verdict = await nextVerdict();
    check('SFU: Turn off when empty does not count a stream-only account: the mode turned itself off', verdict?.mode === null, verdict);
    check('SFU: and took its session out of LiveKit', !!await gone(town, sId), await lkPeople(`sfu_${town.id}`));
    await until(async () => (await auditRow('mode_auto_off'))?.details === 'Clocktower off, 1 disconnected', 5000);
    const autoRow = await auditRow('mode_auto_off');
    check('SFU: the audit log says the mode did it, and how many', autoRow?.details === 'Clocktower off, 1 disconnected' && autoRow.actor_id === null, autoRow);
    await O.locator('.server-settings-btn').first().click();
    await O.locator('.server-settings-nav .nav-item', { hasText: 'Moderation' }).click();
    await O.locator('.mod-tab', { hasText: 'Audit Log' }).click();
    const autoLine = O.locator('.mod-item', { hasText: 'mode_auto_off' }).first();
    await autoLine.waitFor({ timeout: 8000 });
    const autoText = await autoLine.innerText();
    check('SFU: the real Audit Log tab says the channels stayed empty, and names nobody', /stayed empty/.test(autoText) && !/deleted user| by /.test(autoText), autoText);
    await O.locator('.server-settings-content .close-btn').click();
    check('SFU control: the call in a channel no mode names kept its session, and never kept a mode on', await keptCall());
}

const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
const MODE = 'Blood on the Clocktower';

if (process.env.SFU_ONLY === '1') {
    try {
        await sfuRun();
    } catch (e) {
        check('the SFU run ran to the end', false, String(e?.stack || e).slice(0, 800));
    } finally {
        await browser.close();
    }
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exit(failures);
}

try {
    const probe = await browser.newContext();
    const probePage = await probe.newPage();
    await probePage.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    const pageApi = await probePage.evaluate(async () => (await import('/src/api/config.ts')).API_BASE_URL);
    await probe.close();
    if (new URL(pageApi).origin !== new URL(API).origin) {
        throw new Error(`the page talks to ${pageApi}, not to API=${API}: start vite with VITE_API_URL=API`);
    }

    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    // Every WebSocket the page opens, so a test can drop the app's without asking the app:
    // going offline does not end one that is already open.
    await phoneCtx.addInitScript(keepSockets);
    const storyCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const A = await signIn(desktop, 'mda_' + stamp, 'owner');
    const B = await signIn(phoneCtx, 'mdb_' + stamp, 'phone');
    const C = await signIn(storyCtx, 'mdc_' + stamp, 'storyteller');
    const moverCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // This one is also an embedding host (docs/EMBEDDING.md), for what the host is listed.
    await moverCtx.addInitScript(() => { window.__PUCA_EMBED_HOST__ = { apiVersion: 1, name: 'modes walk' }; });
    await moverCtx.addInitScript(keepSockets);
    const D = await signIn(moverCtx, 'mdd_' + stamp, 'mover');

    // ── Fixture: a server with the channels of a game, and two ordinary ones.
    const srvName = 'modes_' + stamp;
    const srv = await servers(A, 'createServer', [srvName]);
    const town = await servers(A, 'createChannel', [srv.id, 'Town Square', 1]);
    const cottage = await servers(A, 'createChannel', [srv.id, 'Cottage', 1]);
    const gameChat = await servers(A, 'createChannel', [srv.id, 'game-chat', 0]);
    const lobby = await servers(A, 'createChannel', [srv.id, 'Lobby', 1]);
    await servers(A, 'createChannel', [srv.id, 'lounge', 0]);
    const rooms = await servers(A, 'createChannel', [srv.id, 'Rooms', 2]);
    await servers(A, 'createChannel', [srv.id, 'room-a', 0, rooms.id]);
    await servers(A, 'createChannel', [srv.id, 'room-b', 0, rooms.id]);
    // A voice room under the collection, ticked by nothing of its own: the usual layout.
    await servers(A, 'createChannel', [srv.id, 'Attic', 1, rooms.id]);
    const inv = await servers(A, 'createInvite', [srv.id, {}]);
    await servers(B, 'joinViaInvite', [inv.code]);
    await servers(C, 'joinViaInvite', [inv.code]);
    await servers(D, 'joinViaInvite', [inv.code]);
    for (const page of [A, B, C, D]) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(2500);
        await dismiss(page);
    }
    await A.locator(`.server-icon[title="${srvName}"]`).click();
    await C.locator(`.server-icon[title="${srvName}"]`).click();
    await D.locator(`.server-icon[title="${srvName}"]`).click();
    await B.locator('.mobile-nav-btn').first().tap();
    await sleep(400);
    await B.locator(`.server-icon[title="${srvName}"]`).tap();
    await sleep(1000);
    // From here on the phone is NEVER reloaded: whatever it shows reached it live.

    // ── 1. Defining a mode, in the real tab.
    check('no modes yet: nobody has a selector', await A.locator('[data-testid="mode-selector"]').count() === 0
        && await B.locator('[data-testid="mode-selector"], [data-testid="mode-label"]').count() === 0);
    await A.locator('.server-settings-btn').first().click();
    await A.locator('.server-settings-nav .nav-item', { hasText: 'Modes' }).click();
    await A.locator('[data-testid="modes-settings"]').waitFor({ timeout: 8000 });
    await A.locator('input[aria-label="New mode name"]').fill(MODE);
    await A.getByRole('button', { name: 'Add mode' }).click();
    const card = A.locator('[data-testid="mode-card"]').first();
    await card.waitFor({ timeout: 8000 });
    check('the tab says a mode is not access control', /does not keep anyone out/.test(await A.locator('[data-testid="modes-settings"]').innerText()));
    check('the tab says the background is unencrypted', /unencrypted, like the server icon/.test((await card.innerText()).replace(/\s+/g, ' ')));
    for (const name of ['Town Square', 'Cottage', 'game-chat']) {
        await card.locator(`input[aria-label="${name} belongs to ${MODE}"]`).check();
    }
    await card.locator('select').first().selectOption({ label: 'Town Square' });
    await card.locator(`input[aria-label="Accent colour for ${MODE}"]`).evaluate((el) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(el, '#ffee00');
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await until(async () => (await A.locator('[data-testid="mode-card"] .notice.success').count()) > 0
        || !(await A.locator('[data-testid="mode-card"]').first().getByRole('button', { name: 'Save', exact: true }).isEnabled()), 8000);
    const night = await picture(A, 'night');
    const bright = await picture(A, 'daylight');
    await A.locator('[data-testid="mode-card"] input[type="file"]').setInputFiles(night);
    await until(async () => (await A.locator('[data-testid="mode-card"] img.mode-background-preview').count()) > 0, 15000);
    let stored = await modesApi(A, 'listModes', [srv.id]);
    const mode = stored.modes[0];
    check('the mode was saved as chosen', mode?.name === MODE && mode.home_channel_id === town.id && mode.accent_color === '#ffee00'
        && [town.id, cottage.id, gameChat.id].every(id => mode.channel_ids.includes(id)) && !!mode.background_file_id, mode);
    await shot(A, '01-desktop-modes-tab');
    const rows = await A.evaluate(() => {
        const row = getComputedStyle(document.querySelector('.mode-channel'));
        const sw = document.querySelector('.modes-settings .toggle-switch').getBoundingClientRect();
        const cut = [...document.querySelectorAll('.mode-channel-name')].filter(n => n.scrollWidth > n.clientWidth).map(n => n.textContent);
        return { display: row.display, transform: row.textTransform, track: [Math.round(sw.width), Math.round(sw.height)], cut };
    });
    check('the tab\'s channel rows are rows, not small capitals, no name cut short, and the switch has its track',
        rows.display === 'flex' && rows.transform === 'none' && rows.track[0] === 44 && rows.track[1] === 24 && rows.cut.length === 0, rows);
    await A.locator('[data-testid="mode-card"] .toggle-row').evaluate(el => el.scrollIntoView({ block: 'center' }));
    await shot(A, '01-desktop-modes-tab-bottom');
    await A.locator('.server-settings-nav .nav-item', { hasText: 'Overview' }).click();
    await sleep(300);
    await A.locator('input[aria-label="Allow games in voice calls"]').evaluate(el => el.closest('.form-group').scrollIntoView({ block: 'center' }));
    await shot(A, '01-desktop-overview-toggles');
    await A.locator('.server-settings-content .close-btn').click();
    await A.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 });

    // A collection is ticked alone: its subchannel, in no mode itself, goes with it.
    await modesApi(A, 'updateMode', [srv.id, mode.id, { channel_ids: [town.id, cottage.id, gameChat.id, rooms.id] }]);

    // ── 2. Hiding is tidiness.
    const hiddenOnPhone = await until(async () => {
        const n = await listed(B);
        return !lists(n, 'Town Square') && !lists(n, 'Cottage') && !lists(n, 'game-chat') && !lists(n, 'Rooms') && !lists(n, 'room-a') && !lists(n, 'Attic') && lists(n, 'Lobby');
    }, 10000);
    check('the phone stops listing the mode\'s channels the moment they join it, with no reload; Lobby stays', !!hiddenOnPhone, await listed(B));
    check('a member without the right sees no selector while nothing is on', await B.locator('[data-testid="mode-selector"], [data-testid="mode-label"]').count() === 0);
    const fromApi = await servers(B, 'listChannels', [srv.id]);
    const apiTown = fromApi.find(c => c.id === town.id);
    check('hiding is not access: the API still gives the member the channel, with its permissions and why it is hidden',
        !!apiTown && apiTown.mode_ids?.includes(mode.id) && apiTown.my_permissions > 0, apiTown);
    check('the owner has a selector saying Off', /Off/.test(await A.locator('[data-testid="mode-selector"]').innerText()));
    await menuFromTheKeyboard(A);
    const openable = await B.evaluate(async ([id]) => {
        const { apiClient } = await import('/src/api/client.ts');
        const rows = await apiClient.get(`/channels/${id}/messages`).then(() => 'ok').catch(e => String(e.status ?? e));
        return rows;
    }, [gameChat.id]);
    check('and its messages can still be read by someone allowed to see it', openable === 'ok', openable);
    await shot(B, '02-phone-mode-off-channels-hidden');

    // ── 3. Switching on: everything reaches the phone with no reload. It sits in a
    //    chat, where the notice shows.
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(400);
    await B.locator('.sidebar .channel', { hasText: 'lounge' }).first().tap();
    await sleep(800);

    // A real #mention of a channel the mode hides, through the real composer: what the
    // docs mean by "a mention still opens it". On a row with its author's name: on a one-line
    // row the phone's toolbar, shown by the tap, takes the click from the second mention.
    await A.locator('.sidebar .channel', { hasText: 'lounge' }).first().click();
    const say = A.locator('textarea[placeholder^="Message #"]');
    await say.waitFor({ timeout: 8000 });
    await say.fill('see #game-chat and #room-a');
    await say.press('Enter');
    const mention = (name) => B.locator('.mention.channel', { hasText: name }).first();
    check('the phone gets the message with the hidden channels as mentions, not as plain text', !!await until(async () =>
        (await mention('game-chat').count()) > 0 && (await mention('room-a').count()) > 0, 10000));
    const header = (page) => page.locator('.chat-header h2').first().innerText().then(t => t.trim());
    await mention('game-chat').tap();
    check('tapping it opens the channel the mode hides', !!await until(async () => (await header(B)).includes('game-chat'), 8000), await header(B).catch(String));
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(400);
    let open = await listed(B);
    check('it stays listed while it is open, and nothing else of the mode comes back with it',
        lists(open, 'game-chat') && !lists(open, 'Cottage') && !lists(open, 'Rooms') && !lists(open, 'room-a'), open);
    await B.locator('.sidebar .channel', { hasText: 'lounge' }).first().tap();
    await sleep(600);
    await mention('room-a').tap();
    check('a mention of a subchannel opens it too', !!await until(async () => (await header(B)).includes('room-a'), 8000), await header(B).catch(String));
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(400);
    open = await listed(B);
    check('its collection returns as its header, and its sibling stays hidden', lists(open, 'Rooms') && lists(open, 'room-a') && !lists(open, 'room-b'), open);
    await B.locator('.sidebar .channel', { hasText: 'lounge' }).first().tap();
    await sleep(600);
    await shot(B, '02-phone-back-in-lounge');

    const themeBefore = await A.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await pick(A, false, MODE);
    const shown = await until(async () => {
        const n = await listed(B);
        return lists(n, 'Town Square') && lists(n, 'Cottage') && lists(n, 'game-chat') && lists(n, 'Rooms') && lists(n, 'room-a') && lists(n, 'Attic');
    }, 8000);
    check('the phone lists the mode\'s channels at once, with no reload', !!shown, await listed(B));
    await until(async () => (await measureLook(A)).picture, 8000);
    check('a mode with a picture leaves the reader\'s theme alone', await A.evaluate(() => document.documentElement.getAttribute('data-theme')) === themeBefore, themeBefore);
    check('the phone gets a label, not a button', await until(async () =>
        (await B.locator('[data-testid="mode-label"]').count()) > 0 && (await B.locator('[data-testid="mode-selector"]').count()) === 0, 5000));
    check('the owner who pressed it gets no notice', await A.locator('[data-testid="mode-notice"]').count() === 0);
    check('the storyteller-to-be gets the notice on desktop', !!await until(() => C.locator('[data-testid="mode-notice"]').count(), 5000));
    check('the phone gets the notice, with Join for the main channel', !!await until(async () =>
        /Join Town Square/.test(await B.locator('[data-testid="mode-notice"]').innerText()), 5000));
    check('the notice is a polite status line', await B.locator('[data-testid="mode-notice"]').getAttribute('role') === 'status');
    check('the look arrives: the phone has the picture and the accent', !!await until(async () => {
        const m = await measureLook(B);
        const accent = await B.evaluate(() => document.documentElement.style.getPropertyValue('--brand-primary'));
        return m.picture && m.alpha !== null && accent !== '';
    }, 8000));

    // ── 8. The phone, with the notice up.
    const gNotice = await phoneGeometry(B, '[data-testid="mode-notice"]');
    check('phone: the notice fits 390 px, its buttons 44 px and hit at their centres', fits(gNotice), gNotice);
    await B.evaluate(() => {
        const d = document.createElement('div');
        d.id = '__w460'; d.style.cssText = 'width:460px;height:8px;flex-shrink:0';
        document.querySelector('[data-testid="mode-notice"]')?.appendChild(d);
    });
    const g460 = await phoneGeometry(B, '[data-testid="mode-notice"]');
    check('POSITIVE CONTROL: a 460 px element injected into the notice is caught', g460.overflow.length > 0, g460.overflow);
    await B.evaluate(() => document.getElementById('__w460')?.remove());
    await shot(B, '03-phone-mode-on-notice');

    // The phone joins from the notice.
    await B.locator('[data-testid="mode-notice"]').getByRole('button', { name: 'Join Town Square' }).tap();
    check('the notice\'s Join joins the main voice channel', !!await until(async () =>
        (await B.locator('.voice-panel-compact .voice-connected-label').count()) > 0, 25000));
    check('and the notice goes', await until(async () => (await B.locator('[data-testid="mode-notice"]').count()) === 0, 4000));
    check('the owner sees the phone in Town Square', !!await until(async () =>
        (await A.locator('.voice-channel-container', { hasText: 'Town Square' }).first().innerText()).includes('mdb_'), 10000));
    await shot(B, '04-phone-in-call-with-look');

    // ── 4. Call everyone back. The phone walks to the private room first.
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(500);
    await B.locator('.voice-channel-list .voice-channel', { hasText: 'Cottage' }).first().tap();
    const inCottage = await until(async () => {
        const rows = await A.locator('.voice-channel-container', { hasText: 'Cottage' }).first().innerText();
        return rows.includes('mdb_');
    }, 15000);
    check('the phone walked into the private room', !!inCottage);
    await sleep(800);
    await pick(A, false, 'Call everyone to Town Square');
    const backInTown = await until(async () => {
        const rows = await A.locator('.voice-channel-container', { hasText: 'Town Square' }).first().innerText();
        return rows.includes('mdb_');
    }, 15000);
    check('Call everyone back moved the phone into the main channel', !!backInTown);
    await shot(A, '05-desktop-after-call-back');
    await sleep(1500);
    check('the phone is still in a call after the move', await B.locator('.voice-panel-compact .voice-connected-label').count() > 0);

    // A role holding only Move Members: the selector is a button for it now, with the one
    // thing it may do, and it works on a room under a ticked collection.
    check('control: without any of the three rights, a label', !!await until(async () =>
        (await D.locator('[data-testid="mode-label"]').count()) > 0 && (await D.locator('[data-testid="mode-selector"]').count()) === 0, 5000));
    const moverRole = await servers(A, 'createRole', [srv.id, { name: 'Usher', permissions: 1 << 14 }]);
    const memberId = async (prefix) => {
        const m = (await servers(A, 'listMembersWithRoles', [srv.id])).find(x => x.username.startsWith(prefix));
        return m.id ?? m.user_id;
    };
    await servers(A, 'assignRole', [srv.id, await memberId('mdd_'), moverRole.id]);
    check('a role holding only Move Members gets the button, live', !!await until(async () =>
        (await D.locator('[data-testid="mode-selector"]').count()) > 0, 8000));
    await D.locator('[data-testid="mode-selector"]').click();
    await D.locator('.context-menu').waitFor({ timeout: 5000 });
    const usherItems = await D.locator('.context-menu .context-menu-item').allInnerTexts();
    check('and its menu offers that and nothing else', usherItems.length === 1 && /Call everyone to Town Square/.test(usherItems[0]), usherItems);
    await D.keyboard.press('Escape');
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(500);
    await B.locator('.voice-channel-list .voice-channel', { hasText: 'Attic' }).first().tap();
    check('the phone walked into the room under the collection', !!await until(async () =>
        (await A.locator('.voice-channel-container', { hasText: 'Attic' }).first().innerText()).includes('mdb_'), 15000));
    await sleep(800);
    await pick(D, false, 'Call everyone to Town Square');
    check('Call everyone back reaches a voice room under a ticked collection', !!await until(async () =>
        (await A.locator('.voice-channel-container', { hasText: 'Town Square' }).first().innerText()).includes('mdb_'), 15000));
    await sleep(1500);

    // ── 5. Turning off: warned, the call ends, told why, everything goes. The phone is in
    //    a voice room under the ticked collection, whose row names no mode; someone else
    //    is in a channel no mode names, and stays.
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(500);
    await B.locator('.voice-channel-list .voice-channel', { hasText: 'Attic' }).first().tap();
    check('the phone is in the room under the collection', !!await until(async () =>
        (await A.locator('.voice-channel-container', { hasText: 'Attic' }).first().innerText()).includes('mdb_'), 15000));
    await C.locator('.voice-channel-list .voice-channel', { hasText: 'Lobby' }).first().click();
    check('someone else is in a channel no mode names', !!await until(async () =>
        (await A.locator('.voice-channel-container', { hasText: 'Lobby' }).first().innerText()).includes('mdc_'), 15000));
    await sleep(800);
    const before = dialogs.length;
    await pick(A, false, 'Off');
    check('turning off warns with how many people, the room under the collection counted and the other call not', await until(() => dialogs.length > before, 4000) && /^owner: 1 person is in .*disconnected/.test(dialogs[dialogs.length - 1]), dialogs.slice(before));
    check('the phone\'s call ended', !!await until(async () => (await B.locator('.voice-panel-compact .voice-connected-label').count()) === 0, 15000));
    check('the phone is told why', !!await until(async () => /Blood on the Clocktower ended, so this call ended/.test(await B.evaluate(() => document.body.innerText)), 5000));
    check('the channels go from the phone\'s list', !!await until(async () => {
        const n = await listed(B);
        return !lists(n, 'Cottage') && !lists(n, 'game-chat') && lists(n, 'Lobby');
    }, 8000), await listed(B));
    check('the look goes: no picture, and the theme\'s own brand', !!await until(async () => !(await measureLook(B)).picture, 5000));
    check('the document carries no accent any more', await B.evaluate(() => document.documentElement.style.getPropertyValue('--brand-primary') === ''));
    check('the room under the collection goes too', !lists(await listed(B), 'Attic'), await listed(B));
    await sleep(1000);
    check('a call in a channel no mode names carried on', (await A.locator('.voice-channel-container', { hasText: 'Lobby' }).first().innerText()).includes('mdc_'));
    await shot(B, '06-phone-after-mode-off');

    // Move to offers what the list shows: the owner right-clicks the person still in Lobby.
    await A.locator('.voice-channel-container', { hasText: 'Lobby' }).first().getByText(/^mdc_/).first().click({ button: 'right' });
    await A.locator('.user-context-menu .ucm-toggle', { hasText: 'Move to' }).click();
    const moveTargets = await A.locator('.user-context-menu .ucm-submenu').innerText();
    check('Move to offers no voice channel the mode hides', !/Town Square|Cottage|Attic/.test(moveTargets), moveTargets);
    await A.keyboard.press('Escape');
    await A.mouse.click(640, 400);
    await sleep(300);

    // An embedding host is listed what the channel list shows.
    const hostList = async () => (await D.evaluate((s) => window.pucaEmbed.listVoiceChannels(s), srv.id)).map(c => c.name);
    const hosted = await hostList();
    check('a host is not listed the voice channels a mode hides, under a collection or not', hosted.includes('Lobby') && !hosted.includes('Town Square') && !hosted.includes('Attic'), hosted);
    const hostJoin = await D.evaluate(([s, c]) => window.pucaEmbed.joinVoice(s, c), [srv.id, cottage.id]);
    check('a host can still join one: hiding is not access', hostJoin.ok === true, hostJoin);
    const withCall = await until(async () => { const l = await hostList(); return l.includes('Cottage') ? l : null; }, 15000);
    check('and it lists the call it is in', !!withCall, withCall);
    check('and everyone\'s list shows a call nobody could otherwise see', !!await until(async () => lists(await listed(B), 'Cottage'), 10000), await listed(B));
    await D.evaluate(() => window.pucaEmbed.leaveVoice());
    await until(async () => !lists(await listed(B), 'Cottage'), 10000);
    const audit = await servers(A, 'listAuditLog', [srv.id]);
    const auditRow = audit.find(r => r.action_type === 'mode_switch' && /off/.test(r.details ?? ''));
    check('the audit log says who and how many', auditRow?.details === `${MODE} off, 1 disconnected` && !!auditRow.actor_username, auditRow);

    // ── 6. Switch Modes, bit 31. A role holding it switches; the owner's editor and an
    //    older client's negative mask both leave it a positive number.
    const SWITCH = 2147483648;
    const noRight = await attempt(C, 'setActiveMode', [srv.id, mode.id]);
    check('without the permission the server refuses', noRight === 403, noRight);
    const role = await servers(A, 'createRole', [srv.id, { name: 'Storyteller', permissions: SWITCH }]);
    const cId = (await servers(A, 'listMembersWithRoles', [srv.id])).find(m => m.username.startsWith('mdc_')).id ?? (await servers(A, 'listMembersWithRoles', [srv.id])).find(m => m.username.startsWith('mdc_')).user_id;
    await servers(A, 'assignRole', [srv.id, cId, role.id]);
    const roleBits = async () => (await servers(A, 'listRoles', [srv.id])).find(r => r.id === role.id).permissions;
    check('the role stored bit 31 as a positive number', await roleBits() === SWITCH, await roleBits());
    // What an older client's editor sends: `mask | bit` in 32-bit JavaScript.
    await servers(A, 'updateRole', [srv.id, role.id, { permissions: (SWITCH | (1 << 9)) }]);
    check('an edit that sends it NEGATIVE (what older clients do) is stored positive, bit kept', await roleBits() === SWITCH + (1 << 9), await roleBits());
    check('the storyteller gets the selector, live, from the role change alone', !!await until(async () =>
        (await C.locator('[data-testid="mode-selector"]').count()) > 0, 8000));
    // The main channel for a moment is Lobby, always listed, with the owner in it: a
    // Join button for the channel someone is already in would only open their voice view.
    await modesApi(A, 'updateMode', [srv.id, mode.id, { home_channel_id: lobby.id }]);
    await A.locator('.voice-channel-list .voice-channel', { hasText: 'Lobby' }).first().click();
    check('the owner joined the main channel', !!await until(async () => (await A.locator('.voice-panel-compact .voice-connected-label').count()) > 0, 25000));
    await sleep(1000);
    await pick(C, false, MODE);
    check('the storyteller turned it on', !!await until(async () => (await servers(A, 'listServers')).find(s => s.id === srv.id).active_mode_id === mode.id, 5000));
    check('control: someone elsewhere is offered Join for it', !!await until(async () =>
        /Join Lobby/.test(await B.locator('[data-testid="mode-notice"]').innerText()), 8000));
    check('someone already in the main channel gets the notice with no Join', !!await until(async () => {
        const t = await A.locator('[data-testid="mode-notice"]').innerText();
        return /is on/.test(t) && !/Join/.test(t);
    }, 8000));
    await A.locator('[title="Disconnect"]').first().click();
    await until(async () => (await A.locator('.voice-panel-compact .voice-connected-label').count()) === 0, 8000);
    await modesApi(A, 'updateMode', [srv.id, mode.id, { home_channel_id: town.id }]);
    const editorRefused = await attempt(C, 'updateMode', [srv.id, mode.id, { name: 'x' }]);
    check('Switch Modes alone does not edit a mode', editorRefused === 403, editorRefused);

    // ── 7. The look, on eight themes.
    check('the owner sees the look', !!await until(async () => (await measureLook(A)).picture, 8000));
    const accentOf = (page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--brand-primary'));
    check('control: the accent is on the document', await accentOf(A) !== '', await accentOf(A));
    await A.locator('.server-icon.home-button').click();
    check('the accent stays with its server: not behind Friends', !!await until(async () => await accentOf(A) === '', 4000), await accentOf(A));
    await A.locator(`.server-icon[title="${srvName}"]`).click();
    check('and comes back with it', !!await until(async () => await accentOf(A) !== '', 4000));
    // What a message can hold, through the real composer: each has colours of its own, and the
    // look holds for what is really on the screen. One at a time: a row's actions open once the
    // server has given it its id.
    await A.locator('.sidebar .channel', { hasText: 'lounge' }).first().click();
    await say.waitFor({ timeout: 8000 });
    // A list of its own in the real composer: the chat around it wears the picture's halo, and it not.
    await say.fill('@');
    await A.locator('.composer-autocomplete .autocomplete-item').first().waitFor({ timeout: 8000 });
    const listHalo = await A.evaluate(() => ({
        chat: getComputedStyle(document.querySelector('.chat-main')).textShadow,
        row: getComputedStyle(document.querySelector('.autocomplete-item')).textShadow,
        avatar: getComputedStyle(document.querySelector('.ac-avatar')).textShadow,
    }));
    check('the composer\'s real autocomplete list has no halo, and the chat around it does', listHalo.chat !== 'none' && listHalo.row === 'none' && listHalo.avatar === 'none', listHalo);
    await say.fill('');
    const posted = async (appears) => {
        await A.locator(appears).last().waitFor({ timeout: 8000 });
        await until(async () => (await A.locator('.msg-action-btn[title="Sending…"]').count()) === 0, 8000);
    };
    const post = async (text, appears) => {
        await say.fill(text);
        await say.press('Enter');
        await posted(appears);
    };
    await post('the rules are at https://example.invalid/rules for anyone new', '.message-content a[href^="https://example.invalid"]');
    await post('**bold** *lean* `code` and @everyone to read them', '.message-content .mention.everyone');
    await post('> a quoted line', '.message-content .message-quote');
    await post('```\nlet block = 1;\n```', '.message-content .code-block');
    const linked = A.locator('.message', { hasText: 'the rules are at' }).first();
    await linked.hover();
    await linked.locator('.msg-action-btn[title="Reply"]').click();
    await post('a reply to it', '.message-reply-ref .reply-author');
    const notes = path.join(OUT, 'notes.txt');
    fs.writeFileSync(notes, 'a file, shown as a chip\n');
    await A.locator('.message-form input[type="file"]').setInputFiles(notes);
    await A.locator('.composer-chip:not(.composer-chip-uploading)').first().waitFor({ timeout: 8000 });
    await say.press('Enter');
    await posted('.message-attachment');
    const reacted = A.locator('.message', { hasText: 'a reply to it' }).first();
    await reacted.hover();
    await reacted.locator('.msg-action-btn[title="Add Reaction"]').click();
    await A.locator('.toolbar-react-picker .emoji-btn').first().click();
    await A.locator('.reaction-badge').first().waitFor({ timeout: 8000 });
    await A.mouse.move(1, 1);
    await shot(A, '07-what-a-message-holds');
    const pictures = { night, daylight: bright };
    for (const [label, file] of Object.entries(pictures)) {
        await A.locator('.server-settings-btn').first().click();
        await A.locator('.server-settings-nav .nav-item', { hasText: 'Modes' }).click();
        await A.locator('[data-testid="mode-card"] input[type="file"]').setInputFiles(file);
        await sleep(2500);
        await A.locator('.server-settings-content .close-btn').click();
        await A.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 });
        await until(async () => (await measureLook(A)).picture, 8000);
        for (const theme of THEMES) {
            await setTheme(A, theme, false);
            const m = await until(async () => { const v = await measureLook(A); return v.picture ? v : null; }, 6000);
            const onPicture = await textOverPicture(A);
            check(`${label} on ${theme}: every run of real text holds at 4.5:1 over every rendered pixel behind it`, !!m && onPicture.measured >= 8 && onPicture.bad.length === 0, onPicture);
            const chip = await A.locator('.message-attachment').first().evaluate(e => getComputedStyle(e).backgroundColor);
            check(`${label} on ${theme}: a file's chip, whose colours are fixed, is on a surface of its own`, !/rgba/.test(chip), chip);
            check(`${label} on ${theme}: accent ${m ? `rgb(${m.accent})` : ''} carries a white label (4.5:1) and shows on the surfaces (3:1)`, !!m && m.labelContrast >= 4.5 && m.surfaceContrast >= 3, m && { label: m.labelContrast.toFixed(2), surface: m.surfaceContrast.toFixed(2) });
            const legible = await illegibleText(A, '.mode-notice, .mode-selector');
            check(`${label} on ${theme}: the notice and the selector are legible`, legible.measured >= 3 && legible.bad.length === 0, legible);
            await menuLegible(A, `${label} on ${theme}`);
            await shot(A, `07-${label}-${theme}`);

            await setTheme(A, theme, true);
            const legibleHigh = await illegibleText(A, '.mode-notice, .mode-selector');
            check(`${label} on ${theme}, high contrast: the notice and the selector are legible`, legibleHigh.measured >= 3 && legibleHigh.bad.length === 0, legibleHigh);
            await menuLegible(A, `${label} on ${theme}, high contrast`);
            const gone = await pictureStaysGone(A);
            const themeBrand = await A.evaluate(() => document.documentElement.style.getPropertyValue('--brand-primary'));
            check(`${label} on ${theme}: high contrast takes the picture and the accent away`, gone && themeBrand === '', { gone, themeBrand });
            await shot(A, `07-${label}-${theme}-high-contrast`);
        }
        await setTheme(A, 'dark', false);
        await until(async () => (await measureLook(A)).picture, 6000);
        if (label === 'daylight') {
            // The same check with the text colours the theme had: it has to be able to fail.
            const keep = await A.evaluate(() => {
                const main = document.querySelector('.chat-main');
                const kept = {};
                for (const t of ['--text-normal', '--text-muted', '--text-faint', '--text-link', '--header-primary', '--header-secondary']) {
                    kept[t] = main.style.getPropertyValue(t);
                    main.style.removeProperty(t);
                }
                return kept;
            });
            const own = await textOverPicture(A);
            check('NEGATIVE CONTROL: the theme\'s own text colours fail the same check over this picture', own.bad.length > 0, own);
            await A.evaluate((kept) => {
                const main = document.querySelector('.chat-main');
                for (const [t, v] of Object.entries(kept)) main.style.setProperty(t, v);
            }, keep);
        }
    }

    // The picture is mapped per theme, and mapped again when the reader changes theme.
    // The end of it: every JPEG starts with the same header.
    const pictureUrl = () => A.evaluate(() => /url\("([^"]+)/.exec(getComputedStyle(document.querySelector('.chat-main')).backgroundImage)?.[1].slice(-200) ?? null);
    const onDark = await pictureUrl();
    await setTheme(A, 'light', false);
    const onLight = await until(async () => { const u = await pictureUrl(); return u && u !== onDark ? u : null; }, 6000);
    check('changing theme maps the picture again', !!onDark && !!onLight && onDark !== onLight, { onDark: onDark?.slice(0, 30), onLight: onLight?.slice(0, 30) });
    await setTheme(A, 'dark', false);
    await until(async () => (await measureLook(A)).picture, 6000);

    // Timestamps sit on the picture too, in a colour that holds. Outside the chat, nothing moved.
    const faint = await A.evaluate(() => {
        const color = (parent, token) => {
            const p = document.createElement('span');
            p.style.color = `var(${token})`;
            parent.appendChild(p);
            const c = getComputedStyle(p).color;
            p.remove();
            return c;
        };
        const main = document.querySelector('.chat-main');
        return { inFaint: color(main, '--text-faint'), outFaint: color(document.body, '--text-faint') };
    });
    check('over a picture, timestamps take a reading colour, and the rest of the window keeps the theme\'s', faint.inFaint !== faint.outFaint, faint);

    // A picture nobody can read is no picture at all.
    const unreadable = await A.evaluate(async () => {
        const m = await import('/src/api/modeLook.ts');
        return m.mapPicture('data:image/png;base64,AAAA', { kind: 'ceiling', luminance: 0.125 });
    });
    check('a picture that cannot be read gives no picture', unreadable === null, unreadable);

    // The server icon's own menu: the same fixed dark surface and the same old mistake.
    for (const high of [false, true]) {
        await setTheme(A, 'light', high);
        await A.locator(`.server-icon[title="${srvName}"]`).click({ button: 'right' });
        await A.locator('.server-context-menu').waitFor({ timeout: 5000 });
        await sleep(200);
        const iconMenu = await illegibleText(A, '.server-context-menu');
        check(`the server icon's menu on light${high ? ', high contrast' : ''} is legible`, iconMenu.measured >= 3 && iconMenu.bad.length === 0, iconMenu);
        if (!high) {
            await A.evaluate(() => { document.querySelector('.server-context-menu .context-menu-item').style.color = '#313338'; });
            const dimmed = await illegibleText(A, '.server-context-menu');
            check('NEGATIVE CONTROL: the old dark ink on that menu is caught', dimmed.bad.length > 0, dimmed);
        }
        await A.keyboard.press('Escape');
        await A.mouse.click(640, 400);
        await sleep(200);
    }
    await setTheme(A, 'dark', false);

    // The settings tab on every theme.
    await A.locator('.server-settings-btn').first().click();
    await A.locator('.server-settings-nav .nav-item', { hasText: 'Modes' }).click();
    await A.locator('[data-testid="mode-card"]').first().waitFor({ timeout: 8000 });

    // What actually gets uploaded: a picture over the limit, and a GIF, through the real input.
    const huge = path.join(OUT, 'huge.png');
    const hugeB64 = await A.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 3000; c.height = 1500;
        const g = c.getContext('2d');
        g.fillStyle = '#123456'; g.fillRect(0, 0, 3000, 1500);
        return c.toDataURL('image/png').split(',')[1];
    });
    fs.writeFileSync(huge, Buffer.from(hugeB64, 'base64'));
    const firstInput = A.locator('[data-testid="mode-card"] input[type="file"]').first();
    const pictureBefore = (await modesApi(A, 'listModes', [srv.id])).modes[0].background_file_id;
    await firstInput.setInputFiles(huge);
    const hugeId = await until(async () => {
        const id = (await modesApi(A, 'listModes', [srv.id])).modes[0].background_file_id;
        return id !== pictureBefore ? id : null;
    }, 15000);
    const uploaded = await A.evaluate(async (id) => {
        const url = await (await import('/src/api/authedMedia.ts')).fetchFileUrl(id);
        const img = new Image();
        img.src = url;
        await img.decode();
        return { type: url.slice(0, url.indexOf(';')), edge: Math.max(img.naturalWidth, img.naturalHeight) };
    }, hugeId);
    check('a 3000 px PNG arrives as a JPEG of at most 1920 px', uploaded.type === 'data:image/jpeg' && uploaded.edge === 1920, uploaded);
    const gif = path.join(OUT, 'animated.gif');
    fs.writeFileSync(gif, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    await firstInput.setInputFiles(gif);
    check('a GIF is refused, saying why', !!await until(async () => /Animated pictures are not supported/.test(await A.locator('[data-testid="mode-card"]').first().innerText()), 6000));
    check('and the picture stays as it was', (await modesApi(A, 'listModes', [srv.id])).modes[0].background_file_id === hugeId);

    for (const theme of THEMES) {
        for (const high of [false, true]) {
            await setTheme(A, theme, high);
            const legible = await illegibleText(A, '.modes-settings');
            check(`the Modes tab on ${theme}${high ? ', high contrast' : ''}: legible`, legible.measured >= 10 && legible.bad.length === 0, legible);
        }
        await setTheme(A, theme, false);
        await shot(A, `07-tab-${theme}`);
    }
    await setTheme(A, 'dark', false);
    await A.locator('.server-settings-content .close-btn').click();
    await A.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 });

    // The personal switch, the real checkbox in the real settings.
    await setTheme(A, 'dark', false);
    check('control: the look is on', (await measureLook(A)).picture);
    const looksBox = async () => {
        await A.locator('.user-actions .user-action-btn[title="Settings"]').first().click();
        await A.locator('.settings-nav-item', { hasText: 'Accessibility' }).click();
        const box = A.locator('input[aria-label="Show server backgrounds and colours"]');
        await box.waitFor({ state: 'attached', timeout: 8000 });
        return box;
    };
    const closeSettings = async () => {
        await A.keyboard.press('Escape');
        await A.locator('.settings-nav').waitFor({ state: 'detached', timeout: 5000 });
    };
    await (await looksBox()).evaluate(el => el.click());
    await closeSettings();
    check('the personal switch takes the picture away', await pictureStaysGone(A));
    check('and the accent', await A.evaluate(() => document.documentElement.style.getPropertyValue('--brand-primary') === ''));
    const listedStill = await listed(A);
    check('and leaves the channels listed: it is about looks, not the mode', lists(listedStill, 'Town Square'), listedStill);
    await (await looksBox()).evaluate(el => el.click());
    await closeSettings();
    check('turning it back on brings the look back', !!await until(async () => (await measureLook(A)).picture, 6000));

    // The phone's selector and tab, as someone who may use them.
    await servers(A, 'assignRole', [srv.id, (await servers(A, 'listMembersWithRoles', [srv.id])).find(m => m.username.startsWith('mdb_')).id ?? (await servers(A, 'listMembersWithRoles', [srv.id])).find(m => m.username.startsWith('mdb_')).user_id, role.id]);
    await until(async () => (await B.locator('[data-testid="mode-selector"]').count()) > 0, 8000);
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(500);
    const gSelector = await phoneGeometry(B, '[data-testid="mode-selector"]');
    check('phone: the selector fits, 44 px and hit at its centre', fits(gSelector), gSelector);
    await shot(B, '08-phone-selector');
    await B.locator('[data-testid="mode-selector"]').tap();
    await B.locator('.context-menu').waitFor({ timeout: 5000 });
    await sleep(400); // It scales in from 95%: measured any sooner, 44 px reads 42.
    const menu = await B.evaluate(() => {
        const r = document.querySelector('.context-menu').getBoundingClientRect();
        return {
            inside: r.left >= 0 && r.top >= 0 && r.right <= document.documentElement.clientWidth && r.bottom <= innerHeight,
            hit: [...document.querySelectorAll('.context-menu .context-menu-item')].every(b => {
                const q = b.getBoundingClientRect();
                const at = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
                return b.contains(at);
            }),
            heights: [...document.querySelectorAll('.context-menu .context-menu-item')].map(b => Math.round(b.getBoundingClientRect().height)),
        };
    });
    check('phone: the menu is inside the window and every item is what a tap hits', menu.inside && menu.hit, menu);
    check('phone: every menu item is a 44 px target', menu.heights.every(h => h >= 44), menu.heights);
    const phoneFocus = await B.evaluate(() => {
        const a = document.activeElement;
        return { menu: a === document.querySelector('.context-menu'), ring: a.matches(':focus-visible') };
    });
    check('phone: a tap puts the focus on the menu, on no item, and shows no ring', phoneFocus.menu && !phoneFocus.ring, phoneFocus);
    await shot(B, '09-phone-menu');
    await B.mouse.click(5, 800);
    await sleep(300);
    await B.keyboard.press('Escape').catch(() => {});

    // Manager on a phone: the tab.
    await servers(A, 'updateRole', [srv.id, role.id, { permissions: SWITCH + (1 << 17) }]);
    await sleep(1200);
    await B.locator('.server-settings-btn').first().tap();
    await B.locator('.server-settings-nav .nav-item', { hasText: 'Modes' }).tap();
    await B.locator('[data-testid="mode-card"]').first().waitFor({ timeout: 10000 });
    const tab = await B.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const root = document.querySelector('[data-testid="modes-settings"]');
        const over = [...root.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > vw + 0.5; }).map(e => String(e.className || e.tagName).slice(0, 40));
        const fonts = [...root.querySelectorAll('input[type="text"], select')].map(e => parseFloat(getComputedStyle(e).fontSize));
        const small = [...root.querySelectorAll('button, .mode-channel, input[type="text"], select')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height < 43.5; }).map(e => String(e.className || e.tagName).slice(0, 40) + ':' + (e.textContent || '').trim().slice(0, 16));
        return { over: over.slice(0, 6), fonts, small: small.slice(0, 8) };
    });
    check('phone: the Modes tab has nothing past the edge', tab.over.length === 0, tab.over);
    check('phone: its inputs are 16 px, so iOS does not zoom', tab.fonts.length > 0 && tab.fonts.every(f => f >= 16), tab.fonts);
    check('phone: its controls are 44 px', tab.small.length === 0, tab.small);
    await shot(B, '10-phone-modes-tab');
    await B.locator('[data-testid="mode-card"]').first().scrollIntoViewIfNeeded().catch(() => {});
    await B.evaluate(() => document.querySelector('.mode-card-actions')?.scrollIntoView({ block: 'center' }));
    await shot(B, '11-phone-modes-tab-bottom');
    await B.locator('.server-settings-content .close-btn').tap();

    // Two devices with no socket when the mode ends: the phone in a call, the other showing
    // the start notice. Neither gets a frame. The phone's replay must not put it back in the
    // ended call, and the other's notice must not go on saying the mode is on.
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(500);
    await B.locator('.voice-channel-list .voice-channel', { hasText: 'Town Square' }).first().tap();
    check('the phone is in a call', !!await until(async () =>
        (await A.locator('.voice-channel-container', { hasText: 'Town Square' }).first().innerText()).includes('mdb_'), 25000));
    check('control: the other device still shows the notice', await D.locator('[data-testid="mode-notice"]').count() === 1);
    const dropSocket = async (ctx, page) => {
        await ctx.setOffline(true);
        // Only the app's own: vite reloads a page whose hot-reload socket comes back.
        return page.evaluate((origin) => {
            const open = window.__sockets.filter(s => s.url.startsWith(origin) && s.readyState === WebSocket.OPEN);
            for (const s of open) s.close();
            return open.length;
        }, API.replace(/^http/, 'ws'));
    };
    const dropped = [await dropSocket(phoneCtx, B), await dropSocket(moverCtx, D)];
    check('each device had a socket to drop', dropped.every(n => n >= 1), dropped);
    check('the phone\'s socket is really gone: it left the room', !!await until(async () =>
        !(await A.locator('.voice-channel-container', { hasText: 'Town Square' }).first().innerText()).includes('mdb_'), 25000));
    // Off leaves no notice behind. The owner still has the one the storyteller's switch
    // gave it: the storyteller pressed, so it never had one to lose.
    check('control: the owner still has the notice', await A.locator('[data-testid="mode-notice"]').count() === 1);
    await modesApi(C, 'setActiveMode', [srv.id, null]);
    check('no notice is left behind when the mode ends', !!await until(async () => (await A.locator('[data-testid="mode-notice"]').count()) === 0, 5000));
    await phoneCtx.setOffline(false);
    await moverCtx.setOffline(false);
    // The toast first: it only stays a few seconds, and reconnecting backs off for longer.
    check('the phone reconnects and is told its call ended and why', !!await until(async () => /ended, so this call ended/.test(await B.evaluate(() => document.body.innerText)), 45000));
    check('it is out of the ended call, not back in it', !!await until(async () =>
        (await B.locator('.voice-panel-compact .voice-connected-label').count()) === 0, 8000));
    check('a device that missed the frame drops the notice once it reconnects', !!await until(async () => (await D.locator('[data-testid="mode-notice"]').count()) === 0, 45000));
    await sleep(2000);
    check('it stayed out: nobody is back in the hidden channel', !lists(await listed(A), 'Town Square'), await listed(A));

    // Entering a server does not open a channel a mode hides. Its first text channel
    // is put in a mode, the mode is off, and the owner walks out and back.
    const firstText = (await servers(A, 'listChannels', [srv.id])).find(c => c.channel_type === 0);
    await modesApi(A, 'createMode', [srv.id, { name: 'Second', channel_ids: [firstText.id] }]);
    await servers(A, 'createServer', ['elsewhere_' + stamp]);
    // Only the owner reloads: the rail learns of a server made through the API no other way.
    await A.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(A);
    await A.locator(`.server-icon[title="elsewhere_${stamp}"]`).click();
    await sleep(800);
    await A.locator(`.server-icon[title="${srvName}"]`).click();
    const opened = await until(async () => {
        const t = (await A.locator('.chat-header h2').first().innerText()).trim();
        return t && t !== firstText.name ? t : null;
    }, 8000);
    check('entering a server opens a listed channel, not one a mode hides', opened === 'lounge', { opened, hiddenFirst: firstText.name });
    // Text rows only: a voice channel is called `default` too.
    const textRows = await A.evaluate(() => [...document.querySelectorAll('.sidebar .channel-name')].map(e => e.textContent.trim()));
    check('and the hidden first channel stays out of the list', textRows.includes('lounge') && !textRows.includes(firstText.name), textRows);

    // A message in a hidden channel while the owner looks at another server: the toast
    // opens it, though that server's list has no row for it.
    await A.locator(`.server-icon[title="elsewhere_${stamp}"]`).click();
    await sleep(800);
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(500);
    await B.locator('.sidebar .channel', { hasText: 'lounge' }).first().tap();
    await sleep(600);
    await mention('game-chat').tap();
    await until(async () => (await header(B)).includes('game-chat'), 8000);
    const phoneSay = B.locator('textarea[placeholder^="Message #"]');
    await phoneSay.waitFor({ timeout: 8000 });
    await phoneSay.fill('in a hidden channel');
    await phoneSay.press('Enter');
    const toast = A.locator('.message-toast').first();
    await toast.waitFor({ timeout: 10000 });
    await toast.click();
    check('a toast about a hidden channel on another server opens it', !!await until(async () =>
        (await A.locator('.server-name').first().innerText()) === srvName && (await header(A)).includes('game-chat'), 8000),
        { server: await A.locator('.server-name').first().innerText().catch(String), header: await header(A).catch(String) });
    await A.locator('.sidebar .channel', { hasText: 'lounge' }).first().click();
    await sleep(600);
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(400);

    // A navigation target opens and never joins: any app on a phone can send one.
    const navigate = (target) => A.evaluate(async (t) => {
        (await import('/src/api/mobileApp.ts')).deferNav(t);
        window.dispatchEvent(new CustomEvent('sovereign-navigate'));
    }, target);
    const inACall = async () => (await A.locator('.voice-panel-compact .voice-connected-label').count()) > 0;
    check('control: the owner is in no call', !(await inACall()));
    await navigate(`channel:${srv.id}:${town.id}`);
    await sleep(3000);
    check('a navigation target to a voice channel joins nothing', !(await inACall()));
    await A.locator(`.server-icon[title="elsewhere_${stamp}"]`).click();
    await sleep(800);
    await navigate(`channel:${srv.id}:${town.id}`);
    await until(async () => (await A.locator('.server-name').first().innerText()) === srvName, 8000);
    await sleep(3000);
    check('from another server too, where it opens the server and joins nothing', (await A.locator('.server-name').first().innerText()) === srvName && !(await inACall()));
    await navigate(`channel:${srv.id}:${gameChat.id}`);
    check('control: a target to a text channel opens it', !!await until(async () => (await header(A)).includes('game-chat'), 8000), await header(A).catch(String));
    await A.locator('.sidebar .channel', { hasText: 'lounge' }).first().click();
    await sleep(400);

    // A collection's merged feed leaves out a subchannel a mode hides, as the list does.
    const hall = await servers(A, 'createChannel', [srv.id, 'Hall', 2]);
    const openSub = await servers(A, 'createChannel', [srv.id, 'open-sub', 0, hall.id]);
    const spoilers = await servers(A, 'createChannel', [srv.id, 'spoilers', 0, hall.id]);
    // Channels made through the API reach the owner's list with the next edit's frame.
    const spoiled = await modesApi(A, 'createMode', [srv.id, { name: 'Spoiled' }]);
    await until(async () => lists(await listed(A), 'spoilers'), 8000);
    for (const name of ['open-sub', 'spoilers']) {
        await A.locator('.sidebar .channel', { hasText: name }).first().click();
        const box = A.locator('textarea[placeholder^="Message #"]');
        await box.waitFor({ timeout: 8000 });
        await box.fill(`in ${name}`);
        await box.press('Enter');
        await sleep(600);
    }
    const feedHeaders = async () => A.locator('.collection-channel-header .channel-name').allInnerTexts();
    await A.locator('.sidebar .channel', { hasText: 'Hall' }).first().click();
    const both = await until(async () => { const h = await feedHeaders(); return h.includes('open-sub') && h.includes('spoilers') ? h : null; }, 10000);
    check('control: a collection\'s feed merges its subchannels', !!both, await feedHeaders());
    await modesApi(A, 'updateMode', [srv.id, spoiled.id, { channel_ids: [spoilers.id] }]);
    const without = await until(async () => { const h = await feedHeaders(); return h.includes('open-sub') && !h.includes('spoilers') ? h : null; }, 10000);
    check('a subchannel a mode hides leaves the feed', !!without, await feedHeaders());
    await A.locator('.sidebar .channel', { hasText: 'lounge' }).first().click();
    await sleep(400);
    void openSub;

    // A long list of modes scrolls rather than pushing Off above the window.
    for (let i = 0; i < 23; i++) await modesApi(A, 'createMode', [srv.id, { name: `Spare ${i}` }]);
    await sleep(1200);
    // The owner's messages above raise toasts on the phone, on top of everything for a moment.
    await until(async () => (await B.locator('.message-toast').count()) === 0, 20000);
    await B.locator('[data-testid="mode-selector"]').tap();
    await B.locator('.context-menu').waitFor({ timeout: 5000 });
    await sleep(400);
    const longMenu = await B.evaluate(() => {
        const box = document.querySelector('.context-menu').getBoundingClientRect();
        const first = document.querySelector('.context-menu .context-menu-item');
        const q = first.getBoundingClientRect();
        return {
            inside: box.top >= 0 && box.bottom <= innerHeight,
            offReachable: first.textContent.trim() === 'Off' && first.contains(document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2)),
            scrolls: document.querySelector('.context-menu').scrollHeight > box.height,
        };
    });
    check('phone: 25 modes scroll inside the window, with Off at the top and reachable', longMenu.inside && longMenu.offReachable && longMenu.scrolls, longMenu);
    await shot(B, '12-phone-many-modes');

    check('a channel in no mode stayed listed to the end', lists(await listed(B), 'Lobby'), lobby.id);

    if (LK) await sfuRun();
    else console.log('SKIP  the SFU run (LK_API / LK_KEY / LK_SECRET not set)');
} catch (e) {
    check('the walk ran to the end', false, String(e?.stack || e).slice(0, 800));
} finally {
    await browser.close();
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures);
