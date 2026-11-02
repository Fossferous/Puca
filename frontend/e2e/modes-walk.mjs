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
//      channels, while the API still returns them with mode_ids and a #mention still
//      opens one (control: an unmoded channel is listed throughout);
//   3. switching: the owner's real selector; the phone's channels, label, notice,
//      background and accent all arrive with no reload; a member without the right
//      gets a label, not a button; the notice's Join joins the main channel;
//   4. Call everyone back moves the phone out of a private room into the main channel;
//   5. turning off: the warning names the people, the phone's real call ends with the
//      toast saying why, the channels and the look go;
//   6. Switch Modes (bit 31): a role holding it switches, and it stays a positive
//      number in the database's answer after an edit that sends the whole mask;
//   7. the look on all eight themes, with and without high contrast, on a bright
//      picture and a dark one: every text colour at 4.5:1 (or within a tenth of the
//      theme's own lower figure) over every pixel of a 32x32 reduction of the picture
//      through the real veil, and the accent at 4.5:1 with a white label and 3:1 on
//      the surfaces.
//      NEGATIVE CONTROL: a fixed 60% veil over the bright picture must fail. High
//      contrast and the personal switch must take picture and accent away, and the
//      theme's own brand must come back.
//   8. the phone: nothing overflows 390 px (a 460 px element injected must be caught),
//      the selector and the notice's buttons are 44 px and hit at their centres, the
//      menu is inside the window.
// Each check prints PASS/FAIL; the exit code is the number of failures. Screenshots
// go to OUT (SHOT <file>): look at them.
//
// Prereqs: a THROWAWAY backend (APP_ENV=development, raised AUTH_RATE_LIMIT_PER_SECOND
// / _BURST, its own fresh database, never a real one) at API, and vite of THIS tree at
// APP started with VITE_API_URL=API (the walk imports /src/api/* modules through vite
// to set the fixture up). Silent: --mute-audio and fake media devices.
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5421 API=http://127.0.0.1:5321 OUT=<dir> node e2e/modes-walk.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP || 'http://127.0.0.1:5421';
const OUT = process.env.OUT || 'e2e/shots-modes';
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

/** A picture as a PNG on disk, drawn in the page: `top` fading to `bottom`, with a
 *  scene on it if asked: what a real picture does, where a gradient says little. */
async function picture(page, file, top, bottom, scene = false) {
    const b64 = await page.evaluate(([top, bottom, scene]) => {
        const c = document.createElement('canvas');
        c.width = 1600; c.height = 900;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 0, 900);
        grad.addColorStop(0, top); grad.addColorStop(1, bottom);
        g.fillStyle = grad; g.fillRect(0, 0, 1600, 900);
        if (scene) {
            g.fillStyle = '#f4efd8';
            g.beginPath(); g.arc(1180, 210, 110, 0, Math.PI * 2); g.fill();
            g.fillStyle = '#0a0812';
            for (const [x, w, h] of [[120, 150, 300], [330, 110, 220], [520, 190, 360], [800, 130, 260], [1040, 170, 330], [1300, 150, 240]]) {
                g.fillRect(x, 900 - h, w, h);
                g.beginPath(); g.moveTo(x - 12, 900 - h); g.lineTo(x + w / 2, 900 - h - 90); g.lineTo(x + w + 12, 900 - h); g.fill();
            }
        }
        return c.toDataURL('image/png').split(',')[1];
    }, [top, bottom, scene]);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
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

/**
 * The real look on the page, measured: the veil's alpha out of .chat-main's actual
 * background, the picture's actual lightest and darkest points out of its actual
 * pixels, and each text colour's contrast against both, through that veil.
 */
async function measureLook(page, fixedVeil = null) {
    return page.evaluate(async ({ fixedVeil }) => {
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
        const main = document.querySelector('.chat-main');
        const bg = getComputedStyle(main).backgroundImage;
        const m = /url\("([^"]+)"\)/.exec(bg);
        const veil = /rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(bg);
        const surface = read('--bg-primary');
        const accent = read('--brand-primary');
        const secondary = read('--bg-secondary');
        const out = {
            picture: !!m,
            alpha: veil ? Number(veil[4]) : null,
            accent,
            labelContrast: contrast(accent, [255, 255, 255]),
            surfaceContrast: Math.min(contrast(accent, surface), contrast(accent, secondary)),
            worst: null,
        };
        if (!m) return out;
        const img = new Image();
        img.src = m[1];
        await img.decode();
        const c = document.createElement('canvas');
        c.width = 32; c.height = 32;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, 32, 32);
        const { data } = g.getImageData(0, 0, 32, 32);
        const alpha = fixedVeil ?? out.alpha;
        let worst = Infinity;
        for (const token of ['--text-normal', '--text-muted', '--text-link']) {
            const text = read(token);
            // api/serverModes.ts textFloor: AA, or within a tenth of a theme's own lower figure.
            const own = contrast(text, surface);
            const floor = own >= 4.5 ? 4.5 : own * 0.9;
            for (let i = 0; i < data.length; i += 4) {
                const under = [0, 1, 2].map(k => surface[k] * alpha + data[i + k] * (1 - alpha));
                worst = Math.min(worst, contrast(text, under) - floor);
            }
        }
        // How far above (or below, if negative) the floor the worst pixel of the worst text is.
        out.worst = Math.round(worst * 100) / 100;
        return out;
    }, { fixedVeil });
}

async function setTheme(page, theme, contrastOn) {
    await page.evaluate(([theme, contrastOn]) => {
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-contrast', contrastOn ? 'high' : 'normal');
    }, [theme, contrastOn]);
    await sleep(350);
}

const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
const MODE = 'Blood on the Clocktower';

try {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const storyCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const A = await signIn(desktop, 'mda_' + stamp, 'owner');
    const B = await signIn(phoneCtx, 'mdb_' + stamp, 'phone');
    const C = await signIn(storyCtx, 'mdc_' + stamp, 'storyteller');

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
    const inv = await servers(A, 'createInvite', [srv.id, {}]);
    await servers(B, 'joinViaInvite', [inv.code]);
    await servers(C, 'joinViaInvite', [inv.code]);
    for (const page of [A, B, C]) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(2500);
        await dismiss(page);
    }
    await A.locator(`.server-icon[title="${srvName}"]`).click();
    await C.locator(`.server-icon[title="${srvName}"]`).click();
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
    const bright = path.join(OUT, 'bright.png');
    const night = path.join(OUT, 'night.png');
    await picture(A, bright, '#ffffff', '#fff6c8');
    await picture(A, night, '#05040e', '#1c1a33');
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
        return !lists(n, 'Town Square') && !lists(n, 'Cottage') && !lists(n, 'game-chat') && !lists(n, 'Rooms') && !lists(n, 'room-a') && lists(n, 'Lobby');
    }, 10000);
    check('the phone stops listing the mode\'s channels the moment they join it, with no reload; Lobby stays', !!hiddenOnPhone, await listed(B));
    check('a member without the right sees no selector while nothing is on', await B.locator('[data-testid="mode-selector"], [data-testid="mode-label"]').count() === 0);
    const fromApi = await servers(B, 'listChannels', [srv.id]);
    const apiTown = fromApi.find(c => c.id === town.id);
    check('hiding is not access: the API still gives the member the channel, with its permissions and why it is hidden',
        !!apiTown && apiTown.mode_ids?.includes(mode.id) && apiTown.my_permissions > 0, apiTown);
    check('the owner has a selector saying Off', /Off/.test(await A.locator('[data-testid="mode-selector"]').innerText()));
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
    await pick(A, false, MODE);
    const shown = await until(async () => {
        const n = await listed(B);
        return lists(n, 'Town Square') && lists(n, 'Cottage') && lists(n, 'game-chat') && lists(n, 'Rooms') && lists(n, 'room-a');
    }, 8000);
    check('the phone lists the mode\'s channels at once, with no reload', !!shown, await listed(B));
    check('the phone gets a label, not a button', await until(async () =>
        (await B.locator('[data-testid="mode-label"]').count()) > 0 && (await B.locator('[data-testid="mode-selector"]').count()) === 0, 5000));
    check('the owner who pressed it gets no notice', await A.locator('[data-testid="mode-notice"]').count() === 0);
    check('the storyteller-to-be gets the notice on desktop', !!await until(() => C.locator('[data-testid="mode-notice"]').count(), 5000));
    check('the phone gets the notice, with Join for the main channel', !!await until(async () =>
        /Join Town Square/.test(await B.locator('[data-testid="mode-notice"]').innerText()), 5000));
    check('the notice is a polite status line', await B.locator('[data-testid="mode-notice"]').getAttribute('role') === 'status');
    check('the look arrives: the phone has the picture and the accent', !!await until(async () => {
        const m = await measureLook(B);
        return m.picture && m.alpha !== null;
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

    // ── 5. Turning off: warned, the call ends, told why, everything goes.
    const before = dialogs.length;
    await pick(A, false, 'Off');
    check('turning off warns with how many people', await until(() => dialogs.length > before, 4000) && /1 person is in .*disconnected/.test(dialogs[dialogs.length - 1]), dialogs.slice(before));
    check('the phone\'s call ended', !!await until(async () => (await B.locator('.voice-panel-compact .voice-connected-label').count()) === 0, 15000));
    check('the phone is told why', !!await until(async () => /Blood on the Clocktower ended, so this call ended/.test(await B.evaluate(() => document.body.innerText)), 5000));
    check('the channels go from the phone\'s list', !!await until(async () => {
        const n = await listed(B);
        return !lists(n, 'Cottage') && !lists(n, 'game-chat') && lists(n, 'Lobby');
    }, 8000), await listed(B));
    check('the look goes: no picture, and the theme\'s own brand', !!await until(async () => !(await measureLook(B)).picture, 5000));
    check('the document carries no accent any more', await B.evaluate(() => document.documentElement.style.getPropertyValue('--brand-primary') === ''));
    await shot(B, '06-phone-after-mode-off');
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
    await pick(C, false, MODE);
    check('the storyteller turned it on', !!await until(async () => (await servers(A, 'listServers')).find(s => s.id === srv.id).active_mode_id === mode.id, 5000));
    const editorRefused = await attempt(C, 'updateMode', [srv.id, mode.id, { name: 'x' }]);
    check('Switch Modes alone does not edit a mode', editorRefused === 403, editorRefused);

    // ── 7. The look, on eight themes.
    check('the owner sees the look', !!await until(async () => (await measureLook(A)).picture, 8000));
    const pictures = { night, bright };
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
            const m = await until(async () => { const v = await measureLook(A); return v.picture && v.alpha !== null ? v : null; }, 6000);
            check(`${label} on ${theme}: every text colour holds at the picture's worst point`, !!m && m.worst >= 0, m);
            check(`${label} on ${theme}: accent ${m ? `rgb(${m.accent})` : ''} carries a white label (4.5:1) and shows on the surfaces (3:1)`, !!m && m.labelContrast >= 4.5 && m.surfaceContrast >= 3, m && { label: m.labelContrast.toFixed(2), surface: m.surfaceContrast.toFixed(2) });
            const legible = await illegibleText(A, '.mode-notice, .mode-selector');
            check(`${label} on ${theme}: the notice and the selector are legible`, legible.measured >= 3 && legible.bad.length === 0, legible);
            await shot(A, `07-${label}-${theme}`);

            await setTheme(A, theme, true);
            const legibleHigh = await illegibleText(A, '.mode-notice, .mode-selector');
            check(`${label} on ${theme}, high contrast: the notice and the selector are legible`, legibleHigh.measured >= 3 && legibleHigh.bad.length === 0, legibleHigh);
            const hc = await measureLook(A);
            const themeBrand = await A.evaluate(() => document.documentElement.style.getPropertyValue('--brand-primary'));
            check(`${label} on ${theme}: high contrast takes the picture and the accent away`, !hc.picture && themeBrand === '', { picture: hc.picture, themeBrand });
            await shot(A, `07-${label}-${theme}-high-contrast`);
        }
        await setTheme(A, 'dark', false);
        const dim = await until(async () => { const v = await measureLook(A); return v.picture ? v : null; }, 6000);
        if (label === 'bright') {
            const fixed = await measureLook(A, 0.6);
            check('NEGATIVE CONTROL: a fixed 60% veil over the bright picture fails the same measure', fixed.worst < 0, fixed.worst);
            check('the bright picture is dimmed further than the dark one was', dim.alpha > stored.nightAlpha, { bright: dim.alpha, night: stored.nightAlpha });
        } else {
            stored = { ...stored, nightAlpha: dim.alpha };
        }
    }

    // A picture with something in it, to look at. A bright moon on a dark scene:
    // the moon decides how far the whole picture is dimmed.
    const scene = path.join(OUT, 'scene.png');
    await picture(A, scene, '#141a3a', '#3a2a55', true);
    await A.locator('.server-settings-btn').first().click();
    await A.locator('.server-settings-nav .nav-item', { hasText: 'Modes' }).click();
    await A.locator('[data-testid="mode-card"] input[type="file"]').first().setInputFiles(scene);
    await sleep(2500);
    await A.locator('.server-settings-content .close-btn').click();
    await A.locator('.server-settings-overlay').waitFor({ state: 'detached', timeout: 5000 });
    await until(async () => (await measureLook(A)).picture, 8000);
    for (const theme of ['dark', 'light', 'purple']) {
        await setTheme(A, theme, false);
        const m = await until(async () => { const v = await measureLook(A); return v.picture ? v : null; }, 6000);
        check(`a real picture on ${theme}: every text colour holds`, !!m && m.worst >= 0, m && { alpha: m.alpha, worst: m.worst });
        await shot(A, `07-scene-${theme}`);
    }
    await setTheme(A, 'dark', false);

    // The settings tab on every theme.
    await A.locator('.server-settings-btn').first().click();
    await A.locator('.server-settings-nav .nav-item', { hasText: 'Modes' }).click();
    await A.locator('[data-testid="mode-card"]').first().waitFor({ timeout: 8000 });
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

    // The personal switch, in the real settings.
    await setTheme(A, 'dark', false);
    check('control: the look is on', (await measureLook(A)).picture);
    await A.evaluate(() => document.documentElement.setAttribute('data-server-looks', 'off'));
    check('the personal switch takes the picture away', !!await until(async () => !(await measureLook(A)).picture, 4000));
    check('and the accent', await A.evaluate(() => document.documentElement.style.getPropertyValue('--brand-primary') === ''));
    const listedStill = await listed(A);
    check('and leaves the channels listed: it is about looks, not the mode', lists(listedStill, 'Town Square'), listedStill);
    await A.evaluate(() => document.documentElement.setAttribute('data-server-looks', 'on'));

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

    // A mode nobody can reach no longer offers anything; off leaves no notice behind.
    await modesApi(A, 'setActiveMode', [srv.id, null]);
    check('no notice is left behind when the mode ends', !!await until(async () => (await C.locator('[data-testid="mode-notice"]').count()) === 0, 5000));

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

    // A long list of modes scrolls rather than pushing Off above the window.
    for (let i = 0; i < 24; i++) await modesApi(A, 'createMode', [srv.id, { name: `Spare ${i}` }]);
    await sleep(1200);
    await B.locator('.mobile-nav-btn').nth(1).tap();
    await sleep(400);
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

    // Nobody was dragged out of a channel in no mode by any of this.
    check('a channel in no mode stayed listed throughout', lists(await listed(B), 'Lobby'), lobby.id);
} catch (e) {
    check('the walk ran to the end', false, String(e?.stack || e).slice(0, 800));
} finally {
    await browser.close();
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures);
