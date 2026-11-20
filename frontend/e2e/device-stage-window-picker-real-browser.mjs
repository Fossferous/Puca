// ONE WINDOW on the REAL remote-control stage, in a real browser, against the
// stand-in host (e2e/device-stage/fakeSession.ts, built by
// vite.stageharness.config.ts): choose one of the PC's open windows and the
// stage shows just that window, sized to it, with Whole screen one press away
// (DeviceStageWindowPicker.tsx, windowPick.ts; docs/REMOTE_CONTROL.md, One
// window). The stand-in plays the host as the agent behaves: a list, then its
// icons (one made by the agent's own PNG writer, pinned byte for byte by
// crates/puca-agent window_pick.rs), a confirmation after a choice, a picture
// the size of the window's part of its screen.
//
// What it proves, each measured:
//   DESKTOP, 1280x800, a real mouse and keyboard:
//   1. Screen > Show one window… opens the picker inside the window, its
//      search field focused, Whole screen first and every window listed; the
//      agent's icon DECODES in the browser (24x24, its teal centre and
//      transparent corner read back from the pixels), a window without one
//      gets the glyph;
//   2. typing filters, the arrows move, Enter shows the highlighted window:
//      the picker closes only once the host confirms, the bar's chip names
//      it, and the picture takes the WINDOW's shape (its aspect, not the
//      screen's); a click at the picture's middle is a move to (0.5, 0.5) of
//      the window;
//   3. while it is open a typed key reaches nothing over there, and Escape
//      closes it unsent (NEGATIVE CONTROL: closed, the same key does go);
//   4. Whole screen in the chip, and in the Screen menu, goes back: the chip
//      goes, the picture is the screen's shape again;
//   5. a refusal keeps the picker open saying why; the host's fallbacks
//      (minimised, closed) and "another program is in front" are said in the
//      bar's note; the administrator window says input will not reach it; a
//      list the host fails is said, with Refresh;
//   PHONE, 390x844, coarse pointer, every press a REAL touch (CDP):
//   6. the Display sheet offers Show one window… as a 44 px row; the picker
//      is a bottom sheet inside the window that does NOT raise the keyboard,
//      every row >= 44 px and what a tap there hits;
//   7. a tapped window shows: the strip above the bottom bar names it, its
//      Whole screen is >= 44 px and hit, the picture ends above the strip;
//      a two-finger pinch still zooms the window's picture; Whole screen goes
//      back;
//   THEMES, both shapes:
//   8. every word in the picker and on the chip at 4.5:1 and every icon at
//      3:1 on what it is painted on, all eight themes with and without high
//      contrast (NEGATIVE CONTROL: the same measure fails a row's muted words
//      painted in the surface's colour);
//   NEGATIVE CONTROL, both shapes:
//   9. a host that does not offer it (an older one, the sign-in screen, a
//      view-only share) shows no Show one window… anywhere.
//
// What it cannot see: a real PC (the agent's crop, DPI and focus are its own
// tests, crates/puca-agent window_pick.rs), and a real phone.
//
// Usage: node e2e/device-stage-window-picker-real-browser.mjs [outdir]
// Builds the harness itself; no server needed. Silent (--mute-audio).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const outdir = process.argv[2] || join(here, 'e2e-artifacts', 'device-stage-window-picker-shots');
await mkdir(outdir, { recursive: true });
execFileSync(process.execPath, [join(here, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.stageharness.config.ts', '--logLevel', 'error'], { cwd: here, stdio: 'inherit' });
const ROOT = join(here, 'e2e-artifacts', 'device-stage-dist');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
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
const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });

async function ready(page) {
    await page.waitForSelector('.device-stage-surface', { timeout: 15000 });
    await page.waitForFunction(() => (window.__stage.video()?.vw ?? 0) > 0, null, { timeout: 10000 });
    await sleep(800);
}
const knobs = (page, k) => page.evaluate(k2 => Object.assign(window.__stage.knobs, k2), k);
const video = page => page.evaluate(() => window.__stage.video());
const inputs = page => page.evaluate(() => window.__stage.inputs.slice());
const clearInputs = page => page.evaluate(() => { window.__stage.inputs.length = 0; });
const keyFrames = list => list.filter(f => f.t === 'key').map(f => `${f.code}${f.down ? '↓' : '↑'}`);
const rowTitles = page => page.evaluate(() => [...document.querySelectorAll('.dswp-row .dswp-title')].map(e => e.textContent));
const waitFor = async (page, fn, arg, ms = 4000) => {
    try { await page.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; }
};
/** The picture's shape against a width/height: within 2%. */
const aspectIs = (v, w, h) => !!v && v.vw > 0 && Math.abs(v.vw / v.vh - w / h) < 0.02 * (w / h);

/** Centre, size and hit-test of the first element matching, in the page. */
const box = (page, sel, text) => page.evaluate(([sel, text]) => {
    const all = [...document.querySelectorAll(sel)];
    const el = text === undefined ? all[0] : all.find(e => e.textContent.trim() === text || e.getAttribute('aria-label') === text || e.textContent.trim().endsWith(text));
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom, hit: !!hit && (hit === el || el.contains(hit)) };
}, [sel, text]);

/** The picker in the window: inside it, no sideways scroll, every row and
 *  button >= 44 px and what a press there hits. */
const pickerLayout = page => page.evaluate(() => {
    const d = document.querySelector('.dswp-picker');
    if (!d) return null;
    const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight;
    const r = d.getBoundingClientRect();
    const list = d.querySelector('.dswp-list').getBoundingClientRect();
    const small = [], missed = [];
    for (const el of d.querySelectorAll('button, .dswp-row, .dswp-search')) {
        const b = el.getBoundingClientRect();
        if (b.height < 44 - 0.5) small.push(`${(el.textContent.trim() || el.getAttribute('aria-label')).slice(0, 24)} ${b.height.toFixed(1)}px`);
        const x = b.left + b.width / 2, y = b.top + b.height / 2;
        const inList = el.classList.contains('dswp-row');
        if (y > (inList ? list.top : r.top) && y < (inList ? list.bottom : r.bottom) && y > 0 && y < H) {
            const hit = document.elementFromPoint(x, y);
            if (!hit || !(hit === el || el.contains(hit))) missed.push((el.textContent.trim() || el.getAttribute('aria-label')).slice(0, 24));
        }
    }
    return {
        inside: r.left >= -0.5 && r.right <= W + 0.5 && r.top >= -0.5 && r.bottom <= H + 0.5,
        rect: `${r.left.toFixed(0)},${r.top.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)} in ${W}x${H}`,
        bottom: r.bottom, W, H,
        overflow: document.documentElement.scrollWidth > W + 0.5 || d.scrollWidth > d.clientWidth + 0.5,
        small, missed,
    };
});

/** Read an icon <img> back through a canvas: size, centre and corner. */
const iconPixels = (page, windowIdSel) => page.evaluate(sel => {
    const img = document.querySelector(`${sel} .dswp-icon img`);
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const px = (x, y) => [...g.getImageData(x, y, 1, 1).data];
    return { w: img.naturalWidth, h: img.naturalHeight, centre: px(12, 12), corner: px(0, 0), src: img.src.slice(0, 22) };
}, windowIdSel);

// ============================ DESKTOP ============================
{
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => { fail++; console.log('[pageerror]', String(e).slice(0, 300)); });
    await page.goto(base);
    await ready(page);
    const screenMenu = () => page.locator('.dsb-menu-btn', { hasText: 'Screen' }).first().click();
    const screenAll = await video(page);

    // 1. Open it.
    await screenMenu();
    const item = page.getByRole('menuitem', { name: 'Show one window…' });
    ck('desktop: the Screen menu offers "Show one window…"', await item.count() === 1);
    await item.click();
    await page.waitForSelector('.dswp-picker');
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    ck('desktop: the picker opens with its search field focused', focused === 'Find a window', String(focused));
    ck('desktop: …and waits for the host, then lists Whole screen first and every window', await waitFor(page, () => document.querySelectorAll('.dswp-row').length === 13),
        (await rowTitles(page)).slice(0, 3).join(' | '));
    const titles = await rowTitles(page);
    ck('desktop: Whole screen is the first row', titles[0] === 'Whole screen', titles[0]);
    const lay = await pickerLayout(page);
    ck('desktop: the picker is inside the window, no sideways overflow', !!lay && lay.inside && !lay.overflow, lay && lay.rect);
    ck('desktop: every row and button in it is >= 44 px tall, and what a click there hits', !!lay && lay.small.length === 0 && lay.missed.length === 0,
        lay && `${lay.small.join('; ')} / ${lay.missed.join('; ')}`);
    ck('desktop: the icons arrive after the list', await waitFor(page, () => !!document.querySelector('.dswp-row img')));
    const word = await iconPixels(page, '.dswp-row[data-window="65552:4100"]');
    ck('desktop: the agent-made icon decodes in the browser at 24x24', !!word && word.w === 24 && word.h === 24 && word.src.startsWith('data:image/png'), JSON.stringify(word));
    ck('desktop: …its centre is the fixture\'s opaque teal, its corner transparent', !!word
        && Math.abs(word.centre[0] - 0x1a) <= 2 && Math.abs(word.centre[1] - 0x9e) <= 2 && Math.abs(word.centre[2] - 0x8f) <= 2
        && word.centre[3] === 255 && word.corner[3] === 0, JSON.stringify(word && [word.centre, word.corner]));
    const glyph = await page.evaluate(() => !!document.querySelector('.dswp-row[data-window="65568:4200"] .dswp-icon svg'));
    ck('desktop: a window without an icon gets the glyph', glyph);
    const admin = await page.evaluate(() => document.querySelector('.dswp-row[data-window="65600:4400"] .dswp-warn')?.textContent ?? '');
    ck('desktop: the administrator window says clicks and keys will not reach it', /administrator/.test(admin) && /will not let your clicks and keys reach it/.test(admin), admin);
    await page.screenshot({ path: `${outdir}/desktop-01-picker.png` });

    // 3. Keys go nowhere while it is open.
    await clearInputs(page);
    await page.keyboard.press('KeyZ');
    await page.keyboard.press('Space');
    await sleep(150);
    ck('desktop: while the picker is open, a typed key reaches nothing over there', keyFrames(await inputs(page)).length === 0, keyFrames(await inputs(page)).join(' '));

    // 2. Type, arrow, Enter.
    await page.keyboard.press('Control+A');
    await page.keyboard.type('note');
    await sleep(100);
    const filtered = await rowTitles(page);
    ck('desktop: typing "note" leaves Whole screen and Notepad', JSON.stringify(filtered) === JSON.stringify(['Whole screen', 'notes.txt - Notepad']), filtered.join(' | '));
    const activeRow = await page.evaluate(() => document.querySelector('.dswp-row.active .dswp-title')?.textContent);
    ck('desktop: …with the match highlighted', activeRow === 'notes.txt - Notepad', activeRow);
    await page.keyboard.press('ArrowUp');
    ck('desktop: ArrowUp moves to Whole screen', await page.evaluate(() => document.querySelector('.dswp-row.active .dswp-title')?.textContent) === 'Whole screen');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await sleep(60);
    ck('desktop: the picker stays open until the host confirms', (await page.$('.dswp-picker')) !== null);
    ck('desktop: …then closes', await waitFor(page, () => !document.querySelector('.dswp-picker')));
    ck('desktop: the window asked for is Notepad', await page.evaluate(() => window.__stage.windowRequests.at(-1)?.id) === '65584:4300');
    const chip = await page.evaluate(() => document.querySelector('[data-testid="window-chip"] .dswp-chip-title')?.textContent);
    ck('desktop: the bar\'s chip names the window', chip === 'notes.txt - Notepad', chip);
    ck('desktop: the picture takes the WINDOW\'s shape (900x1300), not the screen\'s', await waitFor(page, () => { const v = window.__stage.video(); return v && Math.abs(v.vw / v.vh - 900 / 1300) < 0.02; }), JSON.stringify(await video(page)));
    ck('desktop: …which it was not before (the whole desk is wider than tall)', aspectIs(screenAll, 1, 1) === false && screenAll.vw > screenAll.vh, JSON.stringify(screenAll));
    await page.screenshot({ path: `${outdir}/desktop-02-notepad.png` });
    // A click at the middle of the picture: half-way across the WINDOW.
    const mid = await page.evaluate(() => { const r = document.querySelector('video.device-stage-video').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await clearInputs(page);
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down(); await page.mouse.up();
    await sleep(200);
    const lastMove = (await inputs(page)).filter(f => f.t === 'move').at(-1);
    ck('desktop: a click at the middle of the picture is a move to the middle of the window', !!lastMove && Math.abs(lastMove.x - 0.5) < 0.03 && Math.abs(lastMove.y - 0.5) < 0.03, JSON.stringify(lastMove));
    ck('NEGATIVE CONTROL: with the picker closed, a typed key does go over', await (async () => {
        await clearInputs(page); await page.keyboard.press('KeyA'); await sleep(150);
        return JSON.stringify(keyFrames(await inputs(page))) === JSON.stringify(['KeyA↓', 'KeyA↑']);
    })());

    // 4. Whole screen from the chip.
    await page.locator('[data-testid="window-chip"] button', { hasText: 'Whole screen' }).click();
    ck('desktop: the chip\'s Whole screen goes back: the chip goes', await waitFor(page, () => !document.querySelector('[data-testid="window-chip"]')));
    // Notepad is on the portrait screen beside the main one: the whole of
    // THAT screen (1440x2560) is what comes back.
    ck('desktop: …and the picture is its screen\'s shape again (the portrait one, 1440x2560)', await waitFor(page, () => { const v = window.__stage.video(); return v && Math.abs(v.vw / v.vh - 1440 / 2560) < 0.02; }), JSON.stringify(await video(page)));

    // A mouse click on a row; Escape closes unsent.
    await screenMenu();
    await page.getByRole('menuitem', { name: 'Show one window…' }).click();
    await page.waitForSelector('.dswp-row[data-window="65568:4200"]');
    await clearInputs(page);
    await page.keyboard.press('Escape');
    await sleep(150);
    ck('desktop: Escape closes the picker, and is not sent', (await page.$('.dswp-picker')) === null && keyFrames(await inputs(page)).length === 0);
    // Zoomed in on the screen first: a window chosen opens at Fit, not at the
    // screen's zoom (which showed some corner of the window).
    await screenMenu();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.keyboard.press('Escape');
    const zoomed = (await page.evaluate(() => window.__stage.transform()))?.scale ?? 1;
    await screenMenu();
    await page.getByRole('menuitem', { name: 'Show one window…' }).click();
    await page.waitForSelector('.dswp-row[data-window="65568:4200"]');
    await page.locator('.dswp-row[data-window="65568:4200"]').click();
    ck('desktop: a click on a row shows that window', await waitFor(page, () => document.querySelector('[data-testid="window-chip"] .dswp-chip-title')?.textContent === 'Inbox - Mail'));
    const atFit = (await page.evaluate(() => window.__stage.transform()))?.scale ?? 1;
    ck('desktop: …at Fit, though the screen was zoomed in before', zoomed > 1.2 && atFit === 1, `${zoomed} -> ${atFit}`);
    // Whole screen from the Screen menu too.
    await screenMenu();
    await page.getByRole('menuitem', { name: 'Whole screen' }).click();
    ck('desktop: Screen > Whole screen goes back too', await waitFor(page, () => !document.querySelector('[data-testid="window-chip"]')));

    // 5. A refusal, the fallbacks, the front hint, a failed list.
    await knobs(page, { windowRefusal: 'that window has closed' });
    await screenMenu();
    await page.getByRole('menuitem', { name: 'Show one window…' }).click();
    await page.waitForSelector('.dswp-row[data-window="65584:4300"]');
    await page.locator('.dswp-row[data-window="65584:4300"]').click();
    ck('desktop: a refused choice keeps the picker open, saying why', await waitFor(page, () => /that window has closed/.test(document.querySelector('[data-testid="window-picker-notice"]')?.textContent ?? '')),
        await page.evaluate(() => document.querySelector('[data-testid="window-picker-notice"]')?.textContent));
    ck('desktop: …and nothing is shown on its own', (await page.$('[data-testid="window-chip"]')) === null);
    await knobs(page, { windowRefusal: null });
    await page.locator('.dswp-row[data-window="65584:4300"]').click();
    await waitFor(page, () => !!document.querySelector('[data-testid="window-chip"]'));
    await page.evaluate(() => window.__stage.setWindowFront(false));
    const frontNote = await page.evaluate(() => document.querySelector('[data-testid="window-note"]')?.textContent ?? '');
    ck('desktop: another program in front is said, with what to do', /Another program is in front of “notes.txt - Notepad”/.test(frontNote) && /Click into the window/.test(frontNote), frontNote);
    await page.evaluate(() => window.__stage.setWindowFront(true));
    await page.evaluate(() => window.__stage.windowGone('minimized'));
    await sleep(100);
    const gone = await page.evaluate(() => document.querySelector('[data-testid="window-note"]')?.textContent ?? '');
    ck('desktop: a window minimised over there goes back to the whole screen and says so', (await page.$('[data-testid="window-chip"]')) === null
        && /“notes.txt - Notepad” was minimised\. Showing the whole screen\./.test(gone), gone);
    await page.screenshot({ path: `${outdir}/desktop-03-minimised-note.png` });
    await knobs(page, { windowList: 'fail' });
    await screenMenu();
    await page.getByRole('menuitem', { name: 'Show one window…' }).click();
    ck('desktop: a list the host failed is said', await waitFor(page, () => /Could not list that computer's windows/.test(document.querySelector('[data-testid="window-picker-status"]')?.textContent ?? '')),
        await page.evaluate(() => [...document.querySelectorAll('.dswp-status')].map(e => e.textContent).join(' / ')));
    await knobs(page, { windowList: 'ok' });
    await page.getByRole('button', { name: 'Refresh the list' }).click();
    ck('desktop: Refresh asks again and lists them', await waitFor(page, () => document.querySelectorAll('.dswp-row').length === 13 && !document.querySelector('[data-testid="window-picker-status"]')));

    // 8 (desktop). Themes, with the picker open and a row HIGHLIGHTED that is
    // not the chosen one (the arrow's), so both fills are measured. The
    // focus is on Refresh after the press above: back into the field first.
    await page.locator('.dswp-search input').focus();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowDown');
    ck('desktop: the measure sees a highlighted row that is not the chosen one', await page.evaluate(() => {
        const a = document.querySelector('.dswp-row.active');
        return !!a && a.getAttribute('aria-selected') !== 'true';
    }));
    await themes(page, 'desktop');
    await page.keyboard.press('Escape');
    await ctx.close();
}

// 9. NEGATIVE CONTROL (desktop): a host that does not offer it.
{
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => { window.__stageKnobsInit = { windows: false }; });
    const page = await ctx.newPage();
    await page.goto(base);
    await ready(page);
    await page.locator('.dsb-menu-btn', { hasText: 'Screen' }).first().click();
    ck('NEGATIVE CONTROL (desktop): a host that does not offer it shows no "Show one window…"', await page.getByRole('menuitem', { name: /one window/ }).count() === 0);
    await ctx.close();
}

// ============================ PHONE ============================
async function openPhone(init) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on('pageerror', e => { fail++; console.log('[pageerror]', String(e).slice(0, 300)); });
    const cdp = await ctx.newCDPSession(page);
    await page.goto(base);
    await ready(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 4, radiusY: 4, force: 1 })),
    });
    const tap = async p => { await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); await sleep(150); };
    return { ctx, page, touch, tap };
}
{
    const { ctx, page, touch, tap } = await openPhone();
    // 6. The Display sheet, then the picker.
    await tap(await box(page, 'button[title="Display"]'));
    const row = await box(page, '.dswp-menu-row', 'Show one window…');
    ck('phone: the Display sheet offers "Show one window…", >= 44 px and what a tap hits', !!row && row.h >= 44 && row.hit, JSON.stringify(row));
    await tap(row);
    await page.waitForSelector('.dswp-picker');
    await waitFor(page, () => document.querySelectorAll('.dswp-row').length === 13);
    await waitFor(page, () => !!document.querySelector('.dswp-row img'));
    const lay = await pickerLayout(page);
    ck('phone: the picker is a sheet inside the window, at its bottom, no sideways overflow', !!lay && lay.inside && !lay.overflow && Math.abs(lay.bottom - lay.H) < 1, lay && lay.rect);
    ck('phone: every row and button >= 44 px, and what a tap there hits', !!lay && lay.small.length === 0 && lay.missed.length === 0, lay && `${lay.small.join('; ')} / ${lay.missed.join('; ')}`);
    const focus = await page.evaluate(() => document.activeElement?.tagName);
    ck('phone: nothing typed into is focused (the soft keyboard stays down)', focus !== 'INPUT', String(focus));
    ck('phone: twelve windows: the search field is offered', (await page.$('.dswp-search input')) !== null);
    await page.screenshot({ path: `${outdir}/phone-01-picker.png` });
    await themes(page, 'phone');

    // 7. Tap a window.
    await tap(await box(page, '.dswp-row[data-window="65584:4300"]'));
    ck('phone: a tapped window closes the sheet once the host confirms', await waitFor(page, () => !document.querySelector('.dswp-picker')));
    const strip = await page.evaluate(() => {
        const s = document.querySelector('[data-testid="window-strip"]');
        const bar = document.querySelector('.device-stage-mobile-toolbar');
        const surf = document.querySelector('.device-stage-surface');
        const b = s?.querySelector('button');
        if (!s || !b || !bar || !surf) return null;
        const br = b.getBoundingClientRect();
        const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
        return {
            title: s.querySelector('.dswp-chip-title')?.textContent,
            btn: { w: br.width, h: br.height, hit: !!hit && (hit === b || b.contains(hit)), on: br.left >= 0 && br.right <= innerWidth && br.bottom <= innerHeight },
            inBar: bar.contains(s), stripTop: s.getBoundingClientRect().top, surfBottom: surf.getBoundingClientRect().bottom,
        };
    });
    ck('phone: the strip names the window, inside the bottom bar', !!strip && strip.title === 'notes.txt - Notepad' && strip.inBar, JSON.stringify(strip));
    ck('phone: its Whole screen is >= 44 px, on screen and what a tap hits', !!strip && strip.btn.h >= 44 && strip.btn.w >= 44 && strip.btn.hit && strip.btn.on, JSON.stringify(strip?.btn));
    ck('phone: the picture ends above the strip (it gives way to the bar, strip included)', !!strip && strip.surfBottom <= strip.stripTop + 0.5, JSON.stringify(strip && [strip.surfBottom, strip.stripTop]));
    ck('phone: the picture takes the window\'s shape', await waitFor(page, () => { const v = window.__stage.video(); return v && Math.abs(v.vw / v.vh - 900 / 1300) < 0.03; }), JSON.stringify(await video(page)));
    await page.screenshot({ path: `${outdir}/phone-02-notepad.png` });
    // A two-finger pinch still zooms.
    const v = await page.evaluate(() => { const r = document.querySelector('video.device-stage-video').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const scaleBefore = (await page.evaluate(() => window.__stage.transform()))?.scale ?? 1;
    await touch('touchStart', [{ x: v.x - 40, y: v.y, id: 1 }, { x: v.x + 40, y: v.y, id: 2 }]);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: v.x - 40 - i * 10, y: v.y, id: 1 }, { x: v.x + 40 + i * 10, y: v.y, id: 2 }]); await sleep(16); }
    await touch('touchEnd', []);
    await sleep(300);
    const scaleAfter = (await page.evaluate(() => window.__stage.transform()))?.scale ?? 1;
    ck('phone: a two-finger pinch still zooms the window\'s picture', scaleAfter > scaleBefore * 1.5, `${scaleBefore} -> ${scaleAfter}`);
    const hopNone = await page.evaluate(() => document.querySelectorAll('.device-stage-hop').length);
    ck('phone: no screen-hop arrow is offered while one window is shown (it is not a screen)', hopNone === 0, String(hopNone));
    await tap(await box(page, '[data-testid="window-strip"] button'));
    ck('phone: the strip\'s Whole screen goes back', await waitFor(page, () => !document.querySelector('[data-testid="window-strip"]')));
    ck('phone: …and the picture is its screen\'s shape again (the portrait one)', await waitFor(page, () => { const v2 = window.__stage.video(); return v2 && Math.abs(v2.vw / v2.vh - 1440 / 2560) < 0.03; }), JSON.stringify(await video(page)));
    await ctx.close();
}
{
    const { ctx, page, tap } = await openPhone(() => { window.__stageKnobsInit = { windows: false }; });
    await tap(await box(page, 'button[title="Display"]'));
    ck('NEGATIVE CONTROL (phone): a host that does not offer it shows no "Show one window…"', (await page.$('.dswp-menu-row')) === null);
    await ctx.close();
}

/**
 * 8. All eight themes x contrast: every run of words in the picker (and the
 * desktop chip, when shown) at 4.5:1 and every icon at 3:1 on what it is
 * painted on, translucent layers composited down to the first opaque one.
 * The picker must be open.
 */
async function themes(page, where) {
    const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
    const poor = [];
    let words = 0, icons = 0;
    for (const theme of THEMES) {
        for (const hc of ['normal', 'high']) {
            await page.evaluate(([t, c]) => {
                document.documentElement.setAttribute('data-theme', t);
                document.documentElement.setAttribute('data-contrast', c);
            }, [theme, hc]);
            await sleep(400);
            const got = await page.evaluate(measure, ['.dswp-picker', '[data-testid="window-chip"]', '[data-testid="window-strip"]']);
            for (const g of got) {
                if (g.kind === 'icon') icons++; else words++;
                const need = g.kind === 'icon' ? 3 : 4.5;
                if (g.ratio < need) poor.push(`${theme}/${hc} ${g.kind} "${g.text}" ${g.ratio.toFixed(2)}:1`);
            }
            if (theme === 'light' && hc === 'normal') await page.screenshot({ path: `${outdir}/${where}-theme-light.png` });
        }
    }
    ck(`${where}: every word at 4.5:1 and every icon at 3:1 in the picker, all eight themes x contrast`, poor.length === 0 && words > 200 && icons > 50,
        poor.length ? poor.slice(0, 6).join('; ') : `${words} words, ${icons} icons`);
    // NEGATIVE CONTROL: the measure fails words painted in their own surface's colour.
    await page.evaluate(() => {
        const d = document.querySelector('.dswp-picker');
        const bg = getComputedStyle(d).backgroundColor;
        const s = document.createElement('style');
        s.id = 'neg';
        s.textContent = `.dswp-picker .dswp-app { color: ${bg} !important; }`;
        document.head.appendChild(s);
    });
    const neg = await page.evaluate(measure, ['.dswp-picker']);
    await page.evaluate(() => document.getElementById('neg')?.remove());
    ck(`NEGATIVE CONTROL (${where}): the same measure fails a row's words painted in the surface's colour`, neg.some(g => g.kind === 'text' && g.ratio < 1.5));
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.setAttribute('data-contrast', 'normal'); });
}

function measure(roots) {
    // A color-mix() computes to color(srgb r g b / a) with channels from 0 to 1: read digit by
    // digit as 0 to 255 it is near black. A colour in any other space fails the run.
    const rgba = s => {
        const m = s.match(/[\d.]+/g);
        if (!m) return null;
        const srgb = s.match(/^color\(srgb ([^)]+)\)$/);
        if (srgb) {
            const [r, g, b, a = 1] = srgb[1].split(/[ /]+/).filter(Boolean).map(Number);
            if (![r, g, b, a].every(Number.isFinite)) throw new Error(`a colour this cannot read: ${s}`);
            return [r * 255, g * 255, b * 255, a];
        }
        if (!/^rgba?\(/.test(s)) throw new Error(`a colour this cannot read: ${s}`);
        const [r, g, b, a = 1] = m.map(Number);
        return [r, g, b, a];
    };
    const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
    const lum = c => { const v = c.slice(0, 3).map(x => x / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const background = el => {
        const layers = [];
        for (let e = el; e; e = e.parentElement) {
            const c = rgba(getComputedStyle(e).backgroundColor);
            if (!c || c[3] === 0) continue;
            layers.push(c);
            if (c[3] >= 1) break;
        }
        let bg = [255, 255, 255, 1];
        for (const l of layers.reverse()) bg = over(l, bg);
        return bg;
    };
    const ratioOf = (el, colour) => {
        const bg = background(el);
        let op = 1;
        for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
        const ink = over([colour[0], colour[1], colour[2], colour[3] * op], bg);
        const [a, b] = [lum(ink), lum(bg)].sort((p, q) => q - p);
        return (a + 0.05) / (b + 0.05);
    };
    const out = [];
    for (const sel of roots) {
        const root = document.querySelector(sel);
        if (!root) continue;
        for (const el of root.querySelectorAll('*')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (el.closest(':disabled')) continue;
            if (el.tagName.toLowerCase() === 'svg') {
                // An outline icon is drawn in currentColor.
                out.push({ kind: 'icon', text: el.closest('[aria-label]')?.getAttribute('aria-label') ?? el.parentElement?.className ?? 'svg', ratio: ratioOf(el, rgba(getComputedStyle(el).color)) });
                continue;
            }
            const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
            if (!own) continue;
            // The search field's typed words and its placeholder are its own.
            out.push({ kind: 'text', text: el.textContent.trim().slice(0, 30), ratio: ratioOf(el, rgba(getComputedStyle(el).color)) });
        }
        for (const input of root.querySelectorAll('input')) {
            const ph = rgba(getComputedStyle(input, '::placeholder').color);
            out.push({ kind: 'text', text: `placeholder "${input.placeholder}"`, ratio: ratioOf(input, ph) });
        }
    }
    return out;
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
