// The touch volume button on a stream tile, in real browsers: the shipped
// StreamStage inside the real phone chat chrome (the e2e/iphone-stream harness,
// built by vite.iphoneharness.config.ts), two streams watched.
//
// The owner, 2026-10-26: "Add a volume button." On a touch screen the stage's
// right-click menu, the one place a stream's volume could be set, is hard to
// reach (a long press at best, which not every browser turns into one). Each
// tile now has a speaker button that opens THAT stream's own Stream Volume
// and Mute.
//
// Checks, each a PASS/FAIL line, as an iPhone (Edge with touch, a 390x844
// screen and the iPhone user agent; and Playwright's WebKit, Safari's engine,
// layout only on Windows) at 390x844 portrait and 844x390 sideways:
//   - every watched stream's tile has its own button: at least 44x44 px,
//     inside that tile, and what elementFromPoint hits at its middle; the
//     one-click mute is not there beside it (the panel has Mute);
//   - a tap opens THAT stream's panel: inside the window, named for that
//     stream, its slider (44 px tall) and Mute what elementFromPoint hits;
//   - it writes that person's level only: the other tile's panel shows its
//     own, and the store holds one level per person; Mute there mutes one;
//   - opening and closing it changes nothing else: no fullscreen (element or
//     in-app), no tile focused, no picture paused;
//   - all eight themes, with and without high contrast: the button and the
//     panel stay in reach, and their text and ink keep 4.5:1;
//   - FULLSCREEN: with the tile in element fullscreen (Android, an iPad, a
//     desktop) the panel opens inside it, on screen and what a tap hits, and
//     the level changes there; so does the right-click menu on a desktop;
//     leaving fullscreen with either open leaves nothing stranded; and the
//     iPhone's in-app fullscreen (no element fullscreen) works as before;
// and in a 1280x800 window with a mouse (nothing may change there):
//   - no button on screen, the one-click mute as before, the right-click
//     menu as before; the keyboard reaches the panel: Tab to the tile shows
//     its opener, Enter opens the panel with the slider under the keyboard,
//     Escape closes it and gives the keyboard back to the opener;
//   - the tile's header shows for keyboard focus only: not kept up after a
//     mouse click on its buttons, nor by a control session's capture surface
//     (a stand-in), begun from the mouse or from the keyboard;
//   - NEGATIVE CONTROL: a phone-sized window with a MOUSE (fine pointer) shows
//     no button — it is the touch screen's, not the small window's.
//
// SILENT: the harness's streams are canvas pictures with no audio track at
// all, and the browser runs with --mute-audio. Asserted too: every media
// element in the page is muted or carries no audio.
//
//   cd frontend && node e2e/stream-volume-button-real-browser.mjs
// No server. WebKit needs `npx playwright install webkit` once; WEBKIT=0 skips it.
import { chromium, webkit, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANDROID_UA, IPHONE_FULLSCREEN, IPHONE_UA } from './iphone-stream/checks.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));
execFileSync(process.execPath, [join(here, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.iphoneharness.config.ts', '--logLevel', 'error'], { cwd: here, stdio: 'inherit' });
const ROOT = join(here, 'e2e-artifacts', 'iphone-stream-dist');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^([/\\])+/, '');
    if (rel.includes('..')) { res.writeHead(403); return res.end(); }
    for (const c of [join(ROOT, rel), join(ROOT, 'index.html')]) {
        try {
            const b = await readFile(c);
            res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' });
            return res.end(b);
        } catch { /* next */ }
    }
    res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

let fail = 0;
const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** The harness's two streams: user ids 101 and 102. */
const STREAMS = [{ id: 101, name: 'Streamer 1' }, { id: 102, name: 'Streamer 2' }];

async function openPage(browser, opts, init = []) {
    const ctx = await browser.newContext(opts);
    for (const i of init) await ctx.addInitScript(i);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    await page.goto(`${base}?view=stream&streams=2`);
    await page.waitForSelector('.stream-stage .stream-tile', { timeout: 20000 });
    await sleep(700);
    return { ctx, page, errors };
}

/** Geometry and hit tests, in the page. */
const probe = (page) => page.evaluate(({ STREAMS }) => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
    const hits = (el) => {
        const b = el.getBoundingClientRect();
        const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return !!at && (at === el || el.contains(at));
    };
    const tileOf = (name) => [...document.querySelectorAll('.stream-tile')].find(t => t.querySelector('.streamer-name')?.textContent?.includes(name));
    const tiles = STREAMS.map(({ id, name }) => {
        const tile = tileOf(name);
        const btn = tile?.querySelector('.tile-vol:not(.tile-vol-kbd)');
        const mute = tile ? [...tile.querySelectorAll('button')].find(b => /^(Mute|Unmute) stream$/.test(b.title)) : null;
        return {
            id, name, tile: tile ? r(tile) : null,
            btn: btn ? { ...r(btn), hit: hits(btn), label: btn.getAttribute('aria-label') } : null,
            kbd: !!tile?.querySelector('.tile-vol-kbd'),
            oneClickMute: !!mute,
        };
    });
    const panel = document.querySelector('.stream-volume-panel[data-placed]');
    const range = panel?.querySelector('input[type="range"]');
    const muteBtn = panel?.querySelector('.svp-mute');
    const media = [...document.querySelectorAll('audio, video')];
    return {
        coarse: matchMedia('(pointer: coarse)').matches,
        vw: innerWidth, vh: innerHeight,
        tiles,
        panel: panel ? {
            ...r(panel),
            hit: hits(panel),
            inFullscreen: !!document.fullscreenElement && document.fullscreenElement.contains(panel),
            name: panel.querySelector('.svp-name')?.textContent ?? '',
            range: range ? { ...r(range), hit: hits(range), value: range.value } : null,
            mute: muteBtn ? { ...r(muteBtn), hit: hits(muteBtn), pressed: muteBtn.getAttribute('aria-pressed') } : null,
            focusOnRange: document.activeElement === range,
        } : null,
        fullscreen: !!document.fullscreenElement || !!document.querySelector('.is-app-fullscreen'),
        focusedTiles: document.querySelectorAll('.stream-tile.focused').length,
        playing: [...document.querySelectorAll('video.stream-video')].map(v => (v.srcObject ? !v.paused : null)),
        silent: media.every(el => el.muted || !((el.srcObject)?.getAudioTracks?.().length)),
        levels: JSON.parse(localStorage.getItem('sovereign_stream_levels') ?? 'null'),
        mutes: JSON.parse(localStorage.getItem('sovereign_stream_mutes') ?? 'null'),
    };
}, { STREAMS });

const inside = (a, box, slack = 0.5) => a.x >= box.x - slack && a.y >= box.y - slack && a.r <= box.r + slack && a.b <= box.b + slack;
const inWindow = (a, p) => a.x >= -0.5 && a.y >= -0.5 && a.r <= p.vw + 0.5 && a.b <= p.vh + 0.5;
const tap = async (page, box) => {
    const x = box.x + box.w / 2, y = box.y + box.h / 2;
    await page.touchscreen.tap(x, y).catch(async () => page.mouse.click(x, y));
    await sleep(350);
};

async function phone(browser, engine, size) {
    const iphone = engine === 'webkit'
        ? { ...devices['iPhone 15'] }
        : { deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA };
    const [w, h] = size;
    const tag = `[${engine} ${w}x${h}]`;
    const { ctx, page, errors } = await openPage(browser, { ...iphone, viewport: { width: w, height: h }, screen: { width: w, height: h } });
    try {
        let p = await probe(page);
        ck(`${tag} precondition: a touch screen (pointer: coarse)`, p.coarse);
        for (const t of p.tiles) {
            ck(`${tag} ${t.name}: its own volume button`, !!t.btn, JSON.stringify(t));
            if (!t.btn) continue;
            ck(`${tag} ${t.name}: the button is at least 44x44 px`, t.btn.w >= 43.5 && t.btn.h >= 43.5, `${t.btn.w}x${t.btn.h}`);
            ck(`${tag} ${t.name}: the button is inside its tile`, inside(t.btn, t.tile), JSON.stringify({ btn: t.btn, tile: t.tile }));
            ck(`${tag} ${t.name}: the button is what a tap at its middle hits`, t.btn.hit);
            ck(`${tag} ${t.name}: no one-click mute beside it, and no keyboard twin (the panel has Mute)`, !t.oneClickMute && !t.kbd);
        }
        const before = { focused: p.focusedTiles, playing: p.playing };
        const [a, b] = p.tiles;
        if (!a.btn || !b.btn) return;

        // Open A's panel: inside the window, A's, its controls in reach.
        await tap(page, a.btn);
        p = await probe(page);
        ck(`${tag} a tap opens a panel`, !!p.panel);
        if (!p.panel) return;
        ck(`${tag} ...named for THAT stream (${a.name})`, p.panel.name === a.name, p.panel.name);
        ck(`${tag} ...inside the window`, inWindow(p.panel, p), JSON.stringify(p.panel));
        ck(`${tag} ...its slider is 44 px tall and what a tap hits`, !!p.panel.range && p.panel.range.h >= 43.5 && p.panel.range.hit, JSON.stringify(p.panel.range));
        ck(`${tag} ...its Mute is 44 px tall and what a tap hits`, !!p.panel.mute && p.panel.mute.h >= 43.5 && p.panel.mute.hit, JSON.stringify(p.panel.mute));
        ck(`${tag} opening it changes nothing else (no fullscreen, no tile focused, no picture paused)`,
            !p.fullscreen && p.focusedTiles === before.focused && JSON.stringify(p.playing) === JSON.stringify(before.playing), JSON.stringify(p));

        // A's level, written for A alone.
        await page.locator('.stream-volume-panel input[type="range"]').fill('40');
        await sleep(150);
        p = await probe(page);
        ck(`${tag} moving it writes A's level (40) and only A's`,
            p.panel?.range?.value === '40' && p.levels?.levels?.[a.id] === 40 && p.levels?.levels?.[b.id] !== 40, JSON.stringify(p.levels));

        // Close by tapping away (on B's picture): nothing else happens.
        await tap(page, { x: b.tile.x + b.tile.w / 2 - 1, y: b.tile.b - 30, w: 2, h: 2 });
        p = await probe(page);
        ck(`${tag} a tap away closes it`, !p.panel);
        ck(`${tag} closing it changes nothing else (no fullscreen, no tile focused, no picture paused)`,
            !p.fullscreen && p.focusedTiles === before.focused && JSON.stringify(p.playing) === JSON.stringify(before.playing), JSON.stringify({ f: p.fullscreen, t: p.focusedTiles, pl: p.playing }));

        // B's own panel: B's level, independent of A's.
        p = await probe(page);
        await tap(page, p.tiles[1].btn);
        p = await probe(page);
        ck(`${tag} B's button opens B's panel, at B's own level (not A's 40)`,
            p.panel?.name === b.name && p.panel?.range?.value !== '40', JSON.stringify(p.panel));
        if (p.panel?.mute) {
            await tap(page, p.panel.mute);
            p = await probe(page);
            ck(`${tag} Mute there mutes B alone`, p.mutes?.[b.id] === true && !p.mutes?.[a.id], JSON.stringify(p.mutes));
            ck(`${tag} ...and says so`, p.panel?.mute?.pressed === 'true');
        }
        ck(`${tag} SILENT every media element is muted or carries no audio`, p.silent);
        ck(`${tag} no page errors`, errors.length === 0, errors.join(' | '));
    } finally {
        await ctx.close();
    }
}

/** A box for one element, by selector (optionally inside the fullscreen element). */
const boxOf = (page, sel, inFs = false) => page.evaluate(([s, f]) => {
    const scope = f ? document.fullscreenElement : document;
    const el = scope?.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom };
}, [sel, inFs]);
const fullscreenState = (page) => page.evaluate(() => ({
    element: document.fullscreenElement?.classList?.contains('stream-tile') ? (document.fullscreenElement.querySelector('.streamer-name')?.textContent?.trim() ?? '?') : null,
    inApp: !!document.querySelector('.is-app-fullscreen'),
    overlays: document.querySelectorAll('.stream-volume-panel, .stream-volume-backdrop, .stream-context-menu').length,
}));

/** ELEMENT fullscreen: on Android, an iPad and a desktop the TILE goes
 *  fullscreen (mediaFullscreen.ts route 1), and anything left outside it
 *  opens under the fullscreen layer. The panel must open inside it. */
async function elementFullscreen(browser) {
    const tag = '[chromium 390x844 Android, the tile in element fullscreen]';
    const android = { deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, userAgent: ANDROID_UA, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
    const { ctx, page, errors } = await openPage(browser, android);
    try {
        await tap(page, await boxOf(page, '.stream-tile .tile-btn[aria-label="Fullscreen"]'));
        await sleep(500);
        let fs = await fullscreenState(page);
        ck(`${tag} precondition: Fullscreen put the TILE in element fullscreen`, fs.element === STREAMS[0].name, JSON.stringify(fs));
        const speaker = await boxOf(page, '.tile-vol', true);
        ck(`${tag} the fullscreen tile has its speaker`, !!speaker);
        if (!speaker) return;
        await tap(page, speaker);
        let p = await probe(page);
        ck(`${tag} a tap opens the panel INSIDE the fullscreen tile`, !!p.panel?.inFullscreen, JSON.stringify(p.panel));
        ck(`${tag} ...on screen, and what a tap at its middle hits`, !!p.panel && inWindow(p.panel, p) && p.panel.hit, JSON.stringify(p.panel));
        ck(`${tag} ...its slider and Mute what a tap hits`, !!p.panel?.range?.hit && !!p.panel?.mute?.hit);
        await page.locator('.stream-volume-panel input[type="range"]').fill('55');
        await sleep(150);
        p = await probe(page);
        ck(`${tag} changing the level there works (that person's, 55)`, p.panel?.range?.value === '55' && p.levels?.levels?.[STREAMS[0].id] === 55, JSON.stringify(p.levels));
        // Leaving fullscreen with the panel still open: nothing left behind.
        await page.evaluate(() => document.exitFullscreen());
        await sleep(500);
        fs = await fullscreenState(page);
        ck(`${tag} leaving fullscreen with it open closes it: nothing stranded`, fs.element === null && fs.overlays === 0, JSON.stringify(fs));
        p = await probe(page);
        await tap(page, p.tiles[0].btn);
        p = await probe(page);
        ck(`${tag} ...and out of fullscreen the speaker opens it again, in reach`, !!p.panel && !p.panel.inFullscreen && p.panel.hit, JSON.stringify(p.panel));
        ck(`${tag} SILENT every media element is muted or carries no audio`, p.silent);
        ck(`${tag} no page errors`, errors.length === 0, errors.join(' | '));
    } finally {
        await ctx.close();
    }
}

/** The right-click menu in element fullscreen (a desktop): it had the same gap. */
async function menuInFullscreen(browser) {
    const tag = '[desktop 1280x800, the tile in element fullscreen]';
    const { ctx, page, errors } = await openPage(browser, { viewport: { width: 1280, height: 800 } });
    try {
        const fsBtn = await boxOf(page, '.stream-tile .tile-btn[aria-label="Fullscreen"]');
        await page.mouse.click(fsBtn.x + fsBtn.w / 2, fsBtn.y + fsBtn.h / 2);
        await sleep(500);
        let fs = await fullscreenState(page);
        ck(`${tag} precondition: the TILE is in element fullscreen`, fs.element === STREAMS[0].name, JSON.stringify(fs));
        await page.mouse.click(640, 500, { button: 'right' });
        await sleep(250);
        const menu = await page.evaluate(() => {
            const m = document.querySelector('.stream-context-menu');
            if (!m) return null;
            const b = m.getBoundingClientRect();
            const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            return { inside: !!document.fullscreenElement?.contains(m), hit: !!at && m.contains(at), onScreen: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight };
        });
        ck(`${tag} right-click opens the menu INSIDE the fullscreen tile, on screen, and what a click hits`, !!menu && menu.inside && menu.onScreen && menu.hit, JSON.stringify(menu));
        await page.locator('.stream-context-menu input[aria-label="Stream Volume"]').fill('70');
        await sleep(150);
        const p = await probe(page);
        ck(`${tag} its Stream Volume works there (that person's, 70)`, p.levels?.levels?.[STREAMS[0].id] === 70, JSON.stringify(p.levels));
        await page.evaluate(() => document.exitFullscreen());
        await sleep(500);
        fs = await fullscreenState(page);
        ck(`${tag} leaving fullscreen with it open closes it: nothing stranded`, fs.element === null && fs.overlays === 0, JSON.stringify(fs));
        ck(`${tag} SILENT every media element is muted or carries no audio`, (await probe(page)).silent);
        ck(`${tag} no page errors`, errors.length === 0, errors.join(' | '));
    } finally {
        await ctx.close();
    }
}

/** The iPhone's IN-APP fullscreen (no element fullscreen at all): unchanged,
 *  the panel at <body> over the app-fullscreen tile. */
async function inAppFullscreen(browser) {
    const tag = '[chromium 390x844 iPhone, in-app fullscreen]';
    const iphone = { deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
    const { ctx, page, errors } = await openPage(browser, iphone, [IPHONE_FULLSCREEN]);
    try {
        await tap(page, await boxOf(page, '.stream-tile .tile-btn[aria-label="Fullscreen"]'));
        await sleep(400);
        const fs = await fullscreenState(page);
        ck(`${tag} precondition: the stream fills the app (no element fullscreen here)`, fs.inApp && fs.element === null, JSON.stringify(fs));
        const speaker = await boxOf(page, '.stream-tile.is-app-fullscreen .tile-vol');
        ck(`${tag} the full-screen tile has its speaker`, !!speaker);
        if (!speaker) return;
        await tap(page, speaker);
        let p = await probe(page);
        ck(`${tag} a tap opens the panel, on screen, and what a tap at its middle hits`, !!p.panel && inWindow(p.panel, p) && p.panel.hit, JSON.stringify(p.panel));
        await page.locator('.stream-volume-panel input[type="range"]').fill('65');
        await sleep(150);
        p = await probe(page);
        ck(`${tag} changing the level there works (65)`, p.levels?.levels?.[STREAMS[0].id] === 65, JSON.stringify(p.levels));
        ck(`${tag} SILENT every media element is muted or carries no audio`, p.silent);
        ck(`${tag} no page errors`, errors.length === 0, errors.join(' | '));
    } finally {
        await ctx.close();
    }
}

/** All eight themes, with and without high contrast: the button and the
 *  panel stay in reach, and their text and ink keep a 4.5:1 contrast. */
async function themes(browser) {
    const tag = '[chromium 390x844 themes]';
    const iphone = { deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
    const { ctx, page } = await openPage(browser, iphone);
    const poor = [];
    const lost = [];
    try {
        for (const theme of ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow']) {
            for (const hc of ['normal', 'high']) {
                await page.evaluate(([t, c]) => {
                    document.documentElement.setAttribute('data-theme', t);
                    document.documentElement.setAttribute('data-contrast', c);
                }, [theme, hc]);
                await sleep(200);
                let p = await probe(page);
                const btn = p.tiles[0].btn;
                if (!btn || btn.w < 43.5 || !btn.hit) { lost.push(`${theme}/${hc} button ${JSON.stringify(btn)}`); continue; }
                await tap(page, btn);
                p = await probe(page);
                if (!p.panel || !p.panel.range?.hit || !p.panel.mute?.hit || !inWindow(p.panel, p)) { lost.push(`${theme}/${hc} panel ${JSON.stringify(p.panel)}`); continue; }
                const c = await page.evaluate(() => {
                    const opaque = (el) => {
                        for (let e = el; e; e = e.parentElement) {
                            const m = getComputedStyle(e).backgroundColor.match(/[\d.]+/g);
                            if (m && (m[3] === undefined || Number(m[3]) >= 0.99)) return getComputedStyle(e).backgroundColor;
                        }
                        return 'rgb(0, 0, 0)';
                    };
                    const panel = document.querySelector('.stream-volume-panel');
                    const bg = opaque(panel);
                    const ink = (sel, on) => { const el = document.querySelector(sel); return el ? [getComputedStyle(el).color, on] : null; };
                    return {
                        name: ink('.stream-volume-panel .svp-name', bg),
                        label: ink('.stream-volume-panel .scm-label', bg),
                        value: ink('.stream-volume-panel .scm-value', bg),
                        mute: ink('.stream-volume-panel .svp-mute', bg),
                        // The tile's button sits on the picture's dark header.
                        button: ink('.stream-tile .tile-vol', 'rgb(0, 0, 0)'),
                    };
                });
                const lum = (rgb) => {
                    const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map((x) => { const v = Number(x) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
                    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
                };
                const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
                for (const [k, pair] of Object.entries(c)) {
                    if (!pair) { poor.push(`${theme}/${hc} ${k} missing`); continue; }
                    const r = ratio(pair[0], pair[1]);
                    if (r < 4.5) poor.push(`${theme}/${hc} ${k} ${r.toFixed(2)} (${pair[0]} on ${pair[1]})`);
                }
                // Close it: tap away, off the panel.
                const away = p.panel.b + 40 < p.vh ? { x: 20, y: p.panel.b + 20, w: 2, h: 2 } : { x: 20, y: 20, w: 2, h: 2 };
                await tap(page, away);
            }
        }
        ck(`${tag} the button and its panel stay in reach in all eight themes, with and without high contrast`, lost.length === 0, lost.join('; '));
        ck(`${tag} their text and ink keep 4.5:1 in all eight themes, with and without high contrast`, poor.length === 0, poor.join('; '));
    } finally {
        await ctx.close();
    }
}

async function desktop(browser) {
    const tag = '[desktop 1280x800, mouse]';
    const { ctx, page, errors } = await openPage(browser, { viewport: { width: 1280, height: 800 } });
    try {
        let p = await probe(page);
        ck(`${tag} precondition: a fine pointer`, !p.coarse);
        ck(`${tag} nothing new on screen: no volume button`, p.tiles.every(t => !t.btn || t.btn.w <= 1), JSON.stringify(p.tiles.map(t => t.btn)));
        ck(`${tag} the one-click mute as before`, p.tiles.every(t => t.oneClickMute));
        // The right-click menu as before.
        const t0 = p.tiles[0].tile;
        await page.mouse.click(t0.x + t0.w / 2, t0.y + t0.h / 2, { button: 'right' });
        await sleep(200);
        const menu = await page.evaluate(() => !!document.querySelector('.stream-context-menu .scm-slider-block input[type="range"]'));
        ck(`${tag} right-click opens the menu with Stream Volume, as before`, menu);
        await page.keyboard.press('Escape');
        await sleep(150);
        // The header shows for KEYBOARD focus only: not kept up by a mouse
        // click on a tile button (focus stays on it), nor by a control
        // session's capture surface, which the page focuses inside the tile
        // (a stand-in with its class here, as the harness has no session),
        // whether the session began from the mouse or from the keyboard (then
        // the browser counts the page's focus as keyboard focus).
        const headerOpacity = () => page.evaluate(() => getComputedStyle(document.querySelector('.stream-tile .stream-tile-header')).opacity);
        const mute = await boxOf(page, '.stream-tile button[title="Mute stream"]');
        await page.mouse.click(mute.x + mute.w / 2, mute.y + mute.h / 2);
        await page.mouse.click(mute.x + mute.w / 2, mute.y + mute.h / 2); // and back
        await page.mouse.move(2, 2);
        await sleep(400);
        const afterClick = await headerOpacity();
        const focusCapture = () => page.evaluate(() => {
            const d = document.createElement('div');
            d.tabIndex = 0;
            d.className = 'control-capture';
            document.querySelector('.stream-tile').appendChild(d);
            d.focus();
            return d.matches(':focus-visible');
        });
        const dropCapture = () => page.evaluate(() => document.querySelector('.stream-tile .control-capture')?.remove());
        const mouseVisible = await focusCapture();
        await sleep(400);
        const afterCapture = await headerOpacity();
        await dropCapture();
        await page.keyboard.press('Tab');
        const keyVisible = await focusCapture();
        await sleep(400);
        const afterKeyCapture = await headerOpacity();
        await dropCapture();
        ck(`${tag} a mouse click on a tile button does not keep its header up once the mouse leaves`, afterClick === '0', afterClick);
        ck(`${tag} a control session's capture surface, focused by the page, does not keep it up either`,
            !mouseVisible && afterCapture === '0', `focus-visible=${mouseVisible} opacity=${afterCapture}`);
        ck(`${tag} ...nor in a session begun from the keyboard (the surface then has keyboard focus)`,
            keyVisible && afterKeyCapture === '0', `focus-visible=${keyVisible} opacity=${afterKeyCapture}`);
        // The keyboard: Tab to the first tile's opener.
        await page.evaluate(() => { document.activeElement?.blur?.(); document.body.focus(); });
        let reached = false;
        for (let i = 0; i < 40 && !reached; i++) {
            await page.keyboard.press('Tab');
            reached = await page.evaluate(() => !!document.activeElement?.classList?.contains('tile-vol-kbd'));
        }
        await sleep(350); // the header's opacity transition
        if (reached) {
            reached = await page.evaluate(() => {
                const a = document.activeElement;
                const b = a.getBoundingClientRect();
                const header = a.closest('.stream-tile-header');
                return { w: b.width, h: b.height, headerOpacity: header ? getComputedStyle(header).opacity : null };
            });
        }
        ck(`${tag} Tab reaches a tile's volume opener, and it shows (with the tile's controls)`,
            !!reached && reached.w >= 20 && reached.h >= 20 && reached.headerOpacity === '1', JSON.stringify(reached));
        await page.keyboard.press('Enter');
        await sleep(200);
        p = await probe(page);
        ck(`${tag} Enter opens the panel, the slider under the keyboard`, !!p.panel && p.panel.focusOnRange, JSON.stringify(p.panel));
        await page.keyboard.press('ArrowUp');
        await sleep(100);
        p = await probe(page);
        ck(`${tag} ...where the arrows move it 1%`, p.panel?.range?.value === '101', p.panel?.range?.value);
        await page.keyboard.press('Escape');
        await sleep(150);
        const back = await page.evaluate(() => ({
            open: !!document.querySelector('.stream-volume-panel'),
            onOpener: !!document.activeElement?.classList?.contains('tile-vol-kbd'),
        }));
        ck(`${tag} Escape closes it and gives the keyboard back to the opener`, !back.open && back.onOpener, JSON.stringify(back));
        ck(`${tag} SILENT every media element is muted or carries no audio`, (await probe(page)).silent);
        ck(`${tag} no page errors`, errors.length === 0, errors.join(' | '));
    } finally {
        await ctx.close();
    }
    // NEGATIVE CONTROL: the phone's size with a mouse is not a touch screen.
    const small = await openPage(browser, { viewport: { width: 390, height: 844 } });
    try {
        const q = await probe(small.page);
        ck('[390x844 with a mouse] NEGATIVE CONTROL no volume button: it is the touch screen\'s, not the small window\'s',
            !q.coarse && q.tiles.every(t => !t.btn || t.btn.w <= 1), JSON.stringify(q.tiles.map(t => t.btn)));
    } finally {
        await small.ctx.close();
    }
}

const cr = await chromium.launch({ channel: process.env.CHANNEL === 'bundled' ? undefined : 'msedge', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
try {
    await phone(cr, 'chromium', [390, 844]);
    await phone(cr, 'chromium', [844, 390]);
    await elementFullscreen(cr);
    await menuInFullscreen(cr);
    await inAppFullscreen(cr);
    await themes(cr);
    await desktop(cr);
} finally {
    await cr.close();
}
if (process.env.WEBKIT !== '0') {
    let wk;
    try {
        wk = await webkit.launch();
    } catch (e) {
        console.error(String(e.message || e).split('\n')[0]);
        ck('WebKit is installed (npx playwright install webkit)', false);
    }
    if (wk) {
        try {
            await phone(wk, 'webkit', [390, 844]);
            await phone(wk, 'webkit', [844, 390]);
        } finally {
            await wk.close();
        }
    }
}
server.close();
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
