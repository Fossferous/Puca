// PINNED KEYS on the REAL remote-control stage, in a real browser, against
// the stand-in host (e2e/device-stage/fakeSession.ts, built by
// vite.stageharness.config.ts): the keys a person pins appear as buttons
// beside the virtual mouse's, and a press reaches the host as the right
// key-down and key-up.
//
// What it proves, each measured:
//   PHONE, 390x844, coarse pointer, every press a REAL touch (CDP):
//   1. More > Pinned keys… opens the editor on screen, inside the window with
//      no sideways overflow, every control >= 44 px tall and what a tap there
//      hits;
//   2. pinning F5, Ctrl + C, Win + Shift + S and Ctrl + Alt + Del from the
//      editor (the key chosen through the real <select>, the modifiers by
//      tapping their checkboxes), moving one up, unpinning one: the cluster
//      shows exactly that list, in that order;
//   3. the cluster's buttons are >= 44x44, on screen, clear of the toolbar,
//      and what a tap there hits;
//   4. a touch held on Ctrl + C sends ControlLeft down, KeyC down and nothing
//      else until the finger lifts, then KeyC up, ControlLeft up; F5 is a
//      down and an up; Ctrl + Alt + Del is ONE {t:'sas'} frame; none of these
//      taps moves or clicks the remote pointer (NEGATIVE CONTROL: the same
//      tap on the bare picture does);
//   5. the keyboard bar keeps its field focused through a press on a pin
//      (the soft keyboard stays up), and the key still arrives;
//   6. the cluster dragged by its grip stays where it was put, and after a
//      RELOAD the pins are there in the same order at the same place;
//   7. "Show pinned keys on the screen" off takes the cluster away, on brings
//      it back;
//   DESKTOP, 1280x800, a real mouse and keyboard:
//   8. Keyboard > Pinned keys… opens the editor; while it is open a typed key
//      reaches nothing over there (NEGATIVE CONTROL: after Escape closes it,
//      the same key does); a mouse press on the pinned F5 is F5 down, the
//      release F5 up, with no mouse click over there; it survives a reload;
//   THEMES:
//   9. every run of words in the editor at 4.5:1 or more on what it is
//      painted on, and the cluster's labels too, on all eight themes with
//      and without high contrast (NEGATIVE CONTROL: the measure finds the
//      editor's muted words failing when they are painted in the surface's
//      own colour).
//
// What it cannot see: Android's own notification shade (that is
// android-shade-keys-live.mjs, on a headless emulator) and a real PC.
//
// Usage: node e2e/device-stage-pinned-keys-real-browser.mjs [outdir]
// Builds the harness itself; no server needed. Silent (--mute-audio).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const outdir = process.argv[2] || join(here, 'e2e-artifacts', 'device-stage-pinned-keys-shots');
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

async function openPhone() {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', e => { fail++; console.log('[pageerror]', String(e).slice(0, 300)); });
    const cdp = await ctx.newCDPSession(page);
    await page.goto(base);
    await ready(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 4, radiusY: 4, force: 1 })),
    });
    const tap = async p => { await touch('touchStart', [p]); await sleep(40); await touch('touchEnd', []); await sleep(120); };
    return { ctx, page, touch, tap };
}

/** Centre, size and hit-test of the first element matching, in the page. */
const box = (page, sel, text) => page.evaluate(([sel, text]) => {
    const all = [...document.querySelectorAll(sel)];
    const el = text === undefined ? all[0] : all.find(e => e.textContent.trim() === text || e.getAttribute('aria-label') === text);
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom, hit: !!hit && (hit === el || el.contains(hit)) };
}, [sel, text]);
const inputs = page => page.evaluate(() => window.__stage.inputs.slice());
const clearInputs = page => page.evaluate(() => { window.__stage.inputs.length = 0; });
const keyFrames = list => list.filter(f => f.t === 'key').map(f => `${f.code}${f.down ? '↓' : '↑'}`);
const mouseFrames = list => list.filter(f => ['move', 'down', 'up', 'rmove', 'wheel'].includes(f.t));
const clusterLabels = page => page.evaluate(() => [...document.querySelectorAll('[data-testid="pinned-keys"] .vm-pin')].map(b => b.getAttribute('aria-label')));
const listNames = page => page.evaluate(() => [...document.querySelectorAll('.dspk-row .dspk-name')].map(e => e.textContent));

/** The editor in the window: inside it, no sideways scroll, controls >= 44 px and hit. */
const editorLayout = page => page.evaluate(() => {
    const d = document.querySelector('.dspk-editor');
    if (!d) return null;
    const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight;
    const r = d.getBoundingClientRect();
    const small = [];
    const missed = [];
    for (const el of d.querySelectorAll('button, select, label.dspk-check')) {
        const b = el.getBoundingClientRect();
        if (b.height < 44 - 0.5) small.push(`${el.textContent.trim() || el.getAttribute('aria-label')} ${b.height.toFixed(1)}px`);
        const x = b.left + b.width / 2, y = b.top + b.height / 2;
        if (y > r.top && y < r.bottom && y > 0 && y < H) {
            const hit = document.elementFromPoint(x, y);
            if (!hit || !(hit === el || el.contains(hit))) missed.push(el.textContent.trim() || el.getAttribute('aria-label'));
        }
    }
    return {
        inside: r.left >= 0 && r.right <= W + 0.5 && r.top >= 0 && r.bottom <= H + 0.5,
        rect: `${r.left.toFixed(0)},${r.top.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)} in ${W}x${H}`,
        overflow: document.documentElement.scrollWidth > W + 0.5 || d.scrollWidth > d.clientWidth + 0.5,
        small, missed,
    };
});

// ============================ PHONE ============================
{
    const { ctx, page, touch, tap } = await openPhone();
    ck('phone: nothing pinned, no cluster', (await page.$('[data-testid="pinned-keys"]')) === null);

    // 1. More > Pinned keys…
    await tap(await box(page, 'button[title="More"]'));
    const item = await box(page, '.device-stage-mobile-menu-item', 'Pinned keys…');
    ck('phone: More offers "Pinned keys…", on screen and hit', !!item && item.hit, JSON.stringify(item));
    await tap(item);
    const lay = await editorLayout(page);
    ck('phone: the editor opens inside the window, no sideways overflow', !!lay && lay.inside && !lay.overflow, lay && lay.rect);
    ck('phone: every editor control is >= 44 px tall', !!lay && lay.small.length === 0, lay && lay.small.join('; '));
    ck('phone: every editor control in view is what a tap there hits', !!lay && lay.missed.length === 0, lay && lay.missed.join('; '));
    await page.screenshot({ path: `${outdir}/phone-01-editor.png` });

    // 2. Pin four, move one, unpin one — every press a real tap.
    const pinIt = async () => tap(await box(page, '.dspk-add button', 'Pin it'));
    const tapCheck = async label => tap(await box(page, '.dspk-mods label.dspk-check', label));
    const choose = async code => {
        // A native <select> opens the OS picker, which no page can drive; the
        // value is set through the element as that picker would set it.
        await page.selectOption('select[aria-label="Key"]', code);
        await sleep(80);
    };
    await pinIt();                                   // F5, the default
    await tapCheck('Ctrl'); await choose('KeyC'); await pinIt();
    await tapCheck('Ctrl'); await tapCheck('Win'); await tapCheck('Shift'); await choose('KeyS'); await pinIt();
    await choose('SecureAttention');
    const modsOff = await page.evaluate(() => [...document.querySelectorAll('.dspk-mods input')].every(i => i.disabled));
    ck('phone: Ctrl + Alt + Del takes no modifiers (they are disabled for it)', modsOff);
    await pinIt();
    ck('phone: four pinned, in the order pinned', JSON.stringify(await listNames(page)) === JSON.stringify(['F5', 'Ctrl + C', 'Win + Shift + S', 'Ctrl + Alt + Del']), (await listNames(page)).join(' | '));
    // F5 again, with no modifiers ticked (Win and Shift still are, from the
    // last pin: they are shown unticked only while Ctrl + Alt + Del is chosen).
    await choose('F5');
    await tapCheck('Win'); await tapCheck('Shift');
    ck('phone: the modifiers are all unticked now', await page.evaluate(() => [...document.querySelectorAll('.dspk-mods input')].every(i => !i.checked)));
    ck('phone: pinning F5 again is refused', await page.evaluate(() => [...document.querySelectorAll('.dspk-add button')].find(b => b.textContent === 'Pin it').disabled));
    await tap(await box(page, '.dspk-row button', 'Move Ctrl + C up'));
    await tap(await box(page, '.dspk-row button', 'Unpin Win + Shift + S'));
    const after = await listNames(page);
    ck('phone: moved up and unpinned', JSON.stringify(after) === JSON.stringify(['Ctrl + C', 'F5', 'Ctrl + Alt + Del']), after.join(' | '));
    await page.screenshot({ path: `${outdir}/phone-02-edited.png` });
    await tap(await box(page, '.dspk-editor button', 'Done'));
    ck('phone: Done closes the editor', (await page.$('.dspk-editor')) === null);

    // 3. The cluster.
    ck('phone: the cluster shows exactly that list, in that order', JSON.stringify(await clusterLabels(page)) === JSON.stringify(['Ctrl + C', 'F5', 'Ctrl + Alt + Del']), (await clusterLabels(page)).join(' | '));
    const geo = await page.evaluate(() => {
        const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight;
        const bar = document.querySelector('.device-stage-mobile-toolbar')?.getBoundingClientRect();
        return [...document.querySelectorAll('[data-testid="pinned-keys"] .vm-pin')].map(b => {
            const r = b.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
                n: b.getAttribute('aria-label'), w: r.width, h: r.height,
                on: r.left >= 0 && r.right <= W && r.top >= 0 && r.bottom <= H,
                clearOfBar: !bar || r.bottom <= bar.top || r.top >= bar.bottom,
                hit: !!hit && (hit === b || b.contains(hit)),
            };
        });
    });
    ck('phone: every pinned key is >= 44x44', geo.every(g => g.w >= 44 && g.h >= 44), geo.map(g => `${g.n} ${g.w.toFixed(0)}x${g.h.toFixed(0)}`).join('; '));
    ck('phone: every pinned key is on screen, clear of the toolbar, and what a tap hits', geo.every(g => g.on && g.clearOfBar && g.hit), JSON.stringify(geo.filter(g => !(g.on && g.clearOfBar && g.hit))));
    await page.screenshot({ path: `${outdir}/phone-03-cluster.png` });

    // 4. Presses.
    await clearInputs(page);
    const copy = await box(page, '[data-testid="pinned-keys"] .vm-pin', 'Ctrl + C');
    await touch('touchStart', [copy]);
    await sleep(350);
    const holding = await inputs(page);
    const heldPaint = await page.evaluate(() => document.querySelector('[data-testid="pinned-keys"] .vm-pin[aria-label="Ctrl + C"]').classList.contains('vm-held'));
    ck('phone: a touch held on Ctrl + C sends ControlLeft down, KeyC down, and nothing more yet', JSON.stringify(keyFrames(holding)) === JSON.stringify(['ControlLeft↓', 'KeyC↓']), keyFrames(holding).join(' '));
    ck('phone: …painted as held while the finger is down', heldPaint);
    await touch('touchEnd', []);
    await sleep(150);
    const released = await inputs(page);
    ck('phone: lifting it sends KeyC up, then ControlLeft up', JSON.stringify(keyFrames(released)) === JSON.stringify(['ControlLeft↓', 'KeyC↓', 'KeyC↑', 'ControlLeft↑']), keyFrames(released).join(' '));
    await tap(await box(page, '[data-testid="pinned-keys"] .vm-pin', 'F5'));
    await tap(await box(page, '[data-testid="pinned-keys"] .vm-pin', 'Ctrl + Alt + Del'));
    await sleep(700); // past any tap timer on the surface, so a leaked tap would show
    const all = await inputs(page);
    ck('phone: a tap on F5 is F5 down, F5 up', JSON.stringify(keyFrames(all).slice(4)) === JSON.stringify(['F5↓', 'F5↑']), keyFrames(all).slice(4).join(' '));
    ck('phone: Ctrl + Alt + Del is ONE secure-attention frame, no keys', all.filter(f => f.t === 'sas').length === 1 && keyFrames(all).length === 6, `sas=${all.filter(f => f.t === 'sas').length}`);
    ck('phone: no press on a pin moved or clicked the remote pointer', mouseFrames(all).length === 0, JSON.stringify(mouseFrames(all).slice(0, 4)));
    // NEGATIVE CONTROL: the rig sees a tap that reaches the picture.
    await clearInputs(page);
    await tap({ x: 300, y: 300 });
    await sleep(700);
    ck('NEGATIVE CONTROL: the same tap on the bare picture does reach the remote pointer', mouseFrames(await inputs(page)).length > 0, JSON.stringify(mouseFrames(await inputs(page)).slice(0, 3)));

    // 5. The keyboard bar keeps its field.
    await tap(await box(page, 'button[title="Keyboard"]'));
    await sleep(300);
    const focusedBefore = await page.evaluate(() => document.activeElement?.className);
    await clearInputs(page);
    await tap(await box(page, '[data-testid="pinned-keys"] .vm-pin', 'F5'));
    const focusedAfter = await page.evaluate(() => document.activeElement?.className);
    ck('phone: with the keyboard bar up, its field is focused', focusedBefore === 'device-stage-keyboard-capture', focusedBefore);
    ck('phone: …and still is after a press on a pin, which still arrives', focusedAfter === 'device-stage-keyboard-capture' && JSON.stringify(keyFrames(await inputs(page))) === JSON.stringify(['F5↓', 'F5↑']), `${focusedAfter} ${keyFrames(await inputs(page)).join(' ')}`);
    await tap(await box(page, 'button[title="Keyboard"]'));
    await sleep(200);

    // 6. Drag by the grip, reload.
    const before = await page.evaluate(() => { const r = document.querySelector('[data-testid="pinned-keys"]').getBoundingClientRect(); return { left: r.left, top: r.top }; });
    const grip = await box(page, '[data-testid="pinned-keys"] .vm-grip');
    const target = { x: 60, y: 200 };
    await touch('touchStart', [grip]);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: grip.x + (target.x - grip.x) * i / 8, y: grip.y + (target.y - grip.y) * i / 8 }]); await sleep(16); }
    await touch('touchEnd', []);
    await sleep(200);
    const parked = await page.evaluate(() => { const r = document.querySelector('[data-testid="pinned-keys"]').getBoundingClientRect(); return { left: r.left, top: r.top }; });
    ck('phone: the grip drags the cluster where the finger took it', before.top - parked.top > 100 && Math.abs((grip.y - before.top) - (target.y - parked.top)) < 3, `${JSON.stringify(before)} -> ${JSON.stringify(parked)}`);
    ck('phone: dragging sent nothing to the host', mouseFrames(await inputs(page)).length === 0 && keyFrames(await inputs(page)).length === 2);
    await page.reload();
    await ready(page);
    const back = await page.evaluate(() => { const r = document.querySelector('[data-testid="pinned-keys"]')?.getBoundingClientRect(); return r ? { left: r.left, top: r.top } : null; });
    ck('phone: after a reload, the same pins in the same order', JSON.stringify(await clusterLabels(page)) === JSON.stringify(['Ctrl + C', 'F5', 'Ctrl + Alt + Del']), (await clusterLabels(page)).join(' | '));
    ck('phone: …parked where it was left', !!back && Math.abs(back.left - parked.left) < 1 && Math.abs(back.top - parked.top) < 1, JSON.stringify(back));
    await page.screenshot({ path: `${outdir}/phone-04-after-reload.png` });

    // 7. The switch.
    await tap(await box(page, 'button[title="More"]'));
    await tap(await box(page, '.device-stage-mobile-menu-item', 'Pinned keys…'));
    const showBox = await box(page, '.dspk-editor label.dspk-check', 'Show pinned keys on the screen');
    await tap(showBox);
    ck('phone: "Show pinned keys" off takes the cluster away', (await page.$('[data-testid="pinned-keys"]')) === null);
    await tap(showBox);
    ck('phone: …and on brings it back', (await page.$('[data-testid="pinned-keys"]')) !== null);

    // 9 (phone half). Themes.
    await themes(page, 'phone');
    await ctx.close();
}

// ============================ DESKTOP ============================
{
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => { fail++; console.log('[pageerror]', String(e).slice(0, 300)); });
    await page.goto(base);
    await ready(page);
    await page.getByRole('button', { name: /Keyboard/ }).click();
    const menuItem = page.getByRole('menuitem', { name: 'Pinned keys…' });
    ck('desktop: the Keyboard menu offers "Pinned keys…"', await menuItem.count() === 1);
    await menuItem.click();
    await sleep(200);
    const lay = await editorLayout(page);
    ck('desktop: the editor opens inside the window', !!lay && lay.inside && !lay.overflow, lay && lay.rect);
    await clearInputs(page);
    await page.keyboard.press('KeyA');
    await sleep(150);
    ck('desktop: while the editor is open, a typed key reaches nothing over there', keyFrames(await inputs(page)).length === 0, keyFrames(await inputs(page)).join(' '));
    // …including once the focus has fallen to the page (a press that removed
    // or disabled the focused button does that), where only the stage's own
    // guard stands between the key and the computer.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('KeyB');
    await sleep(150);
    ck('desktop: …and with the focus fallen to the page, still nothing', keyFrames(await inputs(page)).length === 0 && (await page.$('.dspk-editor')) !== null, keyFrames(await inputs(page)).join(' '));
    await page.getByRole('button', { name: 'Pin it' }).click();
    await page.screenshot({ path: `${outdir}/desktop-01-editor.png` });
    await page.keyboard.press('Escape');
    await sleep(150);
    ck('desktop: Escape closes it (and is not sent)', (await page.$('.dspk-editor')) === null && keyFrames(await inputs(page)).length === 0);
    await page.mouse.move(640, 400);
    await page.keyboard.press('KeyA');
    await sleep(150);
    ck('NEGATIVE CONTROL: with the editor closed, the same key does go over', JSON.stringify(keyFrames(await inputs(page))) === JSON.stringify(['KeyA↓', 'KeyA↑']), keyFrames(await inputs(page)).join(' '));

    await clearInputs(page);
    const f5 = await box(page, '[data-testid="pinned-keys"] .vm-pin', 'F5');
    ck('desktop: the pinned F5 is on screen and what the mouse hits', !!f5 && f5.hit && f5.left >= 0 && f5.right <= 1280 && f5.bottom <= 800, JSON.stringify(f5));
    const bar = await page.evaluate(() => document.querySelector('.device-stage-bar')?.getBoundingClientRect().bottom ?? 0);
    ck('desktop: …clear of the bar', !!f5 && f5.top >= bar, `${f5?.top} vs ${bar}`);
    await page.mouse.move(f5.x, f5.y);
    await page.mouse.down();
    await sleep(200);
    const down = keyFrames(await inputs(page));
    await page.mouse.up();
    await sleep(200);
    const mouseOnly = mouseFrames(await inputs(page)).filter(f => f.t !== 'move');
    ck('desktop: a mouse press on F5 is F5 down, the release F5 up', JSON.stringify(down) === JSON.stringify(['F5↓']) && JSON.stringify(keyFrames(await inputs(page))) === JSON.stringify(['F5↓', 'F5↑']), keyFrames(await inputs(page)).join(' '));
    ck('desktop: …and no click over there', mouseOnly.length === 0, JSON.stringify(mouseOnly));
    await page.screenshot({ path: `${outdir}/desktop-02-cluster.png` });
    await page.reload();
    await ready(page);
    ck('desktop: F5 is still pinned after a reload', JSON.stringify(await clusterLabels(page)) === JSON.stringify(['F5']));
    await page.getByRole('button', { name: /Keyboard/ }).click();
    await page.getByRole('menuitem', { name: 'Pinned keys…' }).click();
    await themes(page, 'desktop');
    await ctx.close();
}

/**
 * 9. All eight themes x contrast: every run of words in the editor and on the
 * cluster at 4.5:1 on what it is painted on (translucent layers composited
 * down to the first opaque one). Disabled controls are exempt, as WCAG has
 * them. The editor must be open.
 */
async function themes(page, where) {
    const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
    const poor = [];
    let readings = 0;
    for (const theme of THEMES) {
        for (const hc of ['normal', 'high']) {
            await page.evaluate(([t, c]) => {
                document.documentElement.setAttribute('data-theme', t);
                document.documentElement.setAttribute('data-contrast', c);
            }, [theme, hc]);
            await sleep(450);
            const got = await page.evaluate(measure, ['.dspk-editor', '[data-testid="pinned-keys"]']);
            readings += got.length;
            for (const g of got) if (g.ratio < 4.5) poor.push(`${theme}/${hc} "${g.text}" ${g.ratio.toFixed(2)}:1`);
            if (theme === 'light' && hc === 'normal') await page.screenshot({ path: `${outdir}/${where}-theme-light.png` });
        }
    }
    ck(`${where}: every word in the editor and on the pinned keys at 4.5:1, all eight themes x contrast`, poor.length === 0 && readings > 40, poor.length ? poor.slice(0, 6).join('; ') : `${readings} readings`);
    // NEGATIVE CONTROL: the measure fails words painted in their own surface's colour.
    await page.evaluate(() => {
        const d = document.querySelector('.dspk-editor');
        const bg = getComputedStyle(d).backgroundColor;
        const s = document.createElement('style');
        s.id = 'neg';
        s.textContent = `.dspk-editor .device-stage-typetext-help { color: ${bg} !important; }`;
        document.head.appendChild(s);
    });
    const neg = await page.evaluate(measure, ['.dspk-editor']);
    await page.evaluate(() => document.getElementById('neg')?.remove());
    ck(`NEGATIVE CONTROL (${where}): the same measure fails the help text painted in the surface's colour`, neg.some(g => g.ratio < 1.5));
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.setAttribute('data-contrast', 'normal'); });
}

function measure(roots) {
    const rgba = s => { const m = s.match(/[\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); return [r, g, b, a]; };
    const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
    const lum = c => { const v = c.slice(0, 3).map(x => x / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const out = [];
    for (const sel of roots) {
        const root = document.querySelector(sel);
        if (!root) continue;
        for (const el of root.querySelectorAll('*')) {
            const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
            if (!own) continue;
            if (el.closest(':disabled') || el.closest('label')?.querySelector('input:disabled')) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const layers = [];
            for (let e = el; e; e = e.parentElement) {
                const c = rgba(getComputedStyle(e).backgroundColor);
                if (!c || c[3] === 0) continue;
                layers.push(c);
                if (c[3] >= 1) break;
            }
            let bg = [255, 255, 255, 1];
            for (const l of layers.reverse()) bg = over(l, bg);
            let ink = rgba(getComputedStyle(el).color);
            let op = 1;
            for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
            ink = over([ink[0], ink[1], ink[2], ink[3] * op], bg);
            const [a, b] = [lum(ink), lum(bg)].sort((p, q) => q - p);
            out.push({ text: el.textContent.trim().slice(0, 30), ratio: (a + 0.05) / (b + 0.05) });
        }
    }
    return out;
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
