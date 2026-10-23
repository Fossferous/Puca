// The remote-control stage on a DESKTOP, in a REAL browser: the shipped
// DeviceStage and its desktop bar against the stand-in host of
// e2e/device-stage/ (built by vite.stageharness.config.ts), driven by a real
// mouse and keyboard. Written for the owner's 2026-10-23 report ("mouse doesnt
// always work", "the desktop ui isn't good enough"); vitest covers the logic,
// and jsdom has no layout, no hit-testing and no real pointer:
//
//   1. a hovering mouse moves the remote pointer (it sent NOTHING from
//      2026-07-30 until this branch: the control is paused control, which
//      must send none);
//   2. the wheel scrolls the remote machine the way the mouse does (a notch
//      down is -120: the host counts positive as UP);
//   3. every bar menu opens inside the window and each of its rows is what
//      document.elementFromPoint hits — at 1280x800 and in a narrow 900x700
//      window — and a press outside an open menu closes it and sends nothing
//      to the remote (the control: the same press with the menu closed does);
//   4. Esc goes to the remote machine; Ctrl+Alt+Home pauses and the paused
//      banner's own Resume is on screen and hit;
//   5. the pointer is drawn here once the host hands it over, in the host's
//      shape, and the elevated-window banner is on screen, unclipped, parked
//      at the top.
//
// Usage: node e2e/device-stage-desktop-real-browser.mjs [outdir]
// Builds the harness itself; no server needed. Silent (--mute-audio).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const outdir = process.argv[2] || join(here, 'e2e-artifacts', 'device-stage-desktop-shots');
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

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });

async function open(width, height) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    page.on('pageerror', e => { fail++; console.log('[pageerror]', String(e).slice(0, 300)); });
    await page.goto(base);
    await page.waitForSelector('.device-stage-surface', { timeout: 15000 });
    await page.waitForFunction(() => (window.__stage.video()?.vw ?? 0) > 0, null, { timeout: 10000 });
    await page.waitForTimeout(1500);
    return { ctx, page };
}

/** A real press at the centre of what is on screen — never locator.click(),
 *  which scrolls a clipped element into view and has false-passed an
 *  invisible flyout here before. */
async function press(page, locator) {
    const b = await locator.boundingBox();
    if (!b) throw new Error('not on screen');
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

const sentOf = (page, t) => page.evaluate(k => window.__stage.inputs.filter(e => e.t === k), t);
const clearSent = page => page.evaluate(() => { window.__stage.inputs.length = 0; });

/** Is every menu row inside the window and the element a real click lands on? */
async function menuRowsReachable(page) {
    return page.evaluate(() => {
        const rows = [...document.querySelectorAll('.dsb-menu .dsb-item, .dsb-menu .dsb-row button')];
        const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight;
        const bad = [];
        for (const el of rows) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const inside = r.left >= 0 && r.top >= 0 && r.right <= W && r.bottom <= H;
            const hit = document.elementFromPoint(cx, cy);
            if (!inside || !(hit === el || el.contains(hit))) bad.push(`${el.textContent.trim().slice(0, 30)} (${Math.round(r.left)},${Math.round(r.top)} in ${W}x${H}${inside ? '' : ', OUTSIDE'})`);
        }
        return { count: rows.length, bad };
    });
}

for (const [label, w, h] of [['desktop 1280x800', 1280, 800], ['narrow 900x700', 900, 700]]) {
    const { ctx, page } = await open(w, h);
    const video = await page.locator('video.device-stage-video').boundingBox();

    // 1. Hover (paused control is the control, in 4).
    await clearSent(page);
    await page.mouse.move(video.x + video.width * 0.3, video.y + video.height * 0.4);
    await page.mouse.move(video.x + video.width * 0.7, video.y + video.height * 0.6, { steps: 20 });
    await page.waitForTimeout(150);
    ck(`${label}: a hovering mouse moves the remote pointer`, (await sentOf(page, 'move')).length >= 15, `${(await sentOf(page, 'move')).length} moves for 21 hovers`);

    // 2. The wheel.
    await clearSent(page);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(150);
    const wheels = (await sentOf(page, 'wheel')).map(e => e.dy);
    ck(`${label}: a notch DOWN scrolls the remote machine down (-120)`, wheels.length === 1 && wheels[0] === -120, JSON.stringify(wheels));

    // 3. Every menu: on screen and hit; an outside press closes it and sends nothing.
    for (const name of ['Screen', 'Quality', 'Keyboard', 'Mouse', 'More']) {
        const btn = name === 'More'
            ? page.locator('button[aria-label="More"]')
            : page.locator('.dsb-menu-btn', { hasText: name }).first();
        await press(page, btn);
        await page.waitForTimeout(150);
        const { count, bad } = await menuRowsReachable(page);
        ck(`${label}: ${name} — every row inside the window and hit`, count > 0 && bad.length === 0, bad.length ? bad.join('; ') : `${count} rows`);
        if (name === 'Screen' && w === 1280) await page.screenshot({ path: join(outdir, `menu-screen-${w}.png`) });
        await clearSent(page);
        await page.mouse.click(video.x + video.width * 0.5, video.y + video.height * 0.8);
        await page.waitForTimeout(150);
        const leaked = (await sentOf(page, 'down')).length + (await sentOf(page, 'up')).length;
        const closed = await page.evaluate(() => !document.querySelector('.dsb-menu'));
        ck(`${label}: ${name} — a press outside closes it and clicks nothing over there`, closed && leaked === 0, `closed=${closed}, buttons sent=${leaked}`);
    }
    // CONTROL: the same press with no menu open does click over there.
    await clearSent(page);
    await page.mouse.click(video.x + video.width * 0.5, video.y + video.height * 0.8);
    await page.waitForTimeout(150);
    ck(`${label}: CONTROL — with no menu open the same press clicks`, (await sentOf(page, 'down')).length === 1);

    // 4. Esc goes over; Ctrl+Alt+Home pauses; the banner's Resume.
    await clearSent(page);
    await page.mouse.move(video.x + video.width * 0.5, video.y + video.height * 0.5);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const keys = (await sentOf(page, 'key')).map(e => `${e.code}${e.down ? 'v' : '^'}`);
    ck(`${label}: Esc goes to the remote machine`, keys.join(',') === 'Escapev,Escape^', keys.join(','));
    ck(`${label}: …and control stays on`, !(await page.locator('.device-stage-paused').count()));
    await page.keyboard.down('Control'); await page.keyboard.down('Alt');
    await page.keyboard.press('Home');
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    await page.waitForTimeout(150);
    const resume = page.locator('.device-stage-paused button');
    ck(`${label}: Ctrl+Alt+Home pauses`, await resume.count() === 1);
    if (await resume.count()) {
        const rb = await resume.boundingBox();
        const hit = await page.evaluate(([x, y]) => {
            const el = document.elementFromPoint(x, y);
            return !!el && !!el.closest('.device-stage-paused button');
        }, [rb.x + rb.width / 2, rb.y + rb.height / 2]);
        ck(`${label}: the paused banner's Resume is on screen and hit`, hit && rb.y + rb.height <= h, `${Math.round(rb.x)},${Math.round(rb.y)}`);
        // CONTROL for 1: paused, the same hover sends nothing.
        await clearSent(page);
        await page.mouse.move(video.x + video.width * 0.3, video.y + video.height * 0.3);
        await page.mouse.move(video.x + video.width * 0.6, video.y + video.height * 0.35, { steps: 20 });
        await page.waitForTimeout(150);
        ck(`${label}: CONTROL — paused, a hover moves nothing over there`, (await sentOf(page, 'move')).length === 0, `${(await sentOf(page, 'move')).length} moves`);
        await clearSent(page);
        await press(page, resume);
        await page.waitForTimeout(150);
        ck(`${label}: Resume resumes, and its press clicks nothing over there`, !(await page.locator('.device-stage-paused').count()) && (await sentOf(page, 'down')).length === 0);
    }

    // 4b. Edge pan: zoomed in from the Screen menu, the pointer parked on the
    // stage's right edge looks further right and keeps aiming; a press made
    // MID-PAN stops it; it runs to the picture's edge; at Fit an edge is only
    // an edge.
    const canvasPan = () => page.evaluate(() => {
        const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(document.querySelector('.device-stage-canvas')?.style.transform ?? '');
        return m ? { x: +m[1], y: +m[2], scale: +m[3] } : null;
    });
    const zoomMenu = async label => {
        await press(page, page.locator('.dsb-menu-btn', { hasText: 'Screen' }).first());
        await page.waitForTimeout(100);
        // The zoom row's own buttons: "Fit" alone would also match the
        // picture's "Fit to this screen", which comes first.
        const row = page.locator('.dsb-menu .dsb-row[aria-label="Zoom"] button');
        await press(page, label === 'Fit' ? row.filter({ hasText: /^Fit$/ }) : row.and(page.locator(`[aria-label="${label}"]`)));
        await page.waitForTimeout(100);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
    };
    await zoomMenu('Zoom in');
    await zoomMenu('Zoom in');
    const surf = await page.locator('.device-stage-surface').boundingBox();
    const z0 = await canvasPan();
    // The far right the clamp allows: the stage's width times the zoom past 1.
    const maxLeft = -surf.width * ((z0?.scale ?? 1) - 1);
    await page.mouse.move(surf.x + surf.width - 4, surf.y + surf.height / 2);
    await clearSent(page);
    await page.waitForTimeout(120);
    const zMid = await canvasPan();
    const aimedMid = (await sentOf(page, 'move')).length;
    ck(`${label}: zoomed in (${z0?.scale}x), the right edge looks further right`, !!z0 && !!zMid && z0.scale > 1 && zMid.x < z0.x - 20 && Math.abs(zMid.y - z0.y) < 0.5, `x ${z0?.x} -> ${zMid?.x} in 120 ms`);
    ck(`${label}: …aiming the remote pointer while the hand is still`, aimedMid >= 3, `${aimedMid} moves in 120 ms`);
    await page.mouse.down();
    const z2 = await canvasPan();
    await clearSent(page);
    await page.waitForTimeout(300);
    const z3 = await canvasPan();
    const duringPress = (await sentOf(page, 'move')).length;
    await page.mouse.up();
    ck(`${label}: a press made mid-pan stops it (no drag under a moving picture)`,
        !!z2 && z2.x > maxLeft + 20 && JSON.stringify(z2) === JSON.stringify(z3) && duringPress === 0,
        `pressed at x ${z2?.x} (edge ${maxLeft}), ${z3?.x} after 300 ms, ${duringPress} moves`);
    // The next hover carries on, to the picture's edge and no further.
    await page.mouse.move(surf.x + surf.width - 5, surf.y + surf.height / 2);
    await page.waitForTimeout(700);
    const zEnd = await canvasPan();
    await clearSent(page);
    await page.waitForTimeout(200);
    const zAfter = await canvasPan();
    ck(`${label}: …and runs to the picture's edge, then stops`,
        !!zEnd && Math.abs(zEnd.x - maxLeft) < 0.5 && JSON.stringify(zEnd) === JSON.stringify(zAfter) && (await sentOf(page, 'move')).length === 0,
        `x ${zEnd?.x} (edge ${maxLeft})`);
    await zoomMenu('Fit');
    await page.mouse.move(surf.x + surf.width / 2, surf.y + surf.height / 2);
    await page.mouse.move(surf.x + surf.width - 4, surf.y + surf.height / 2);
    const f0 = await canvasPan();
    await page.waitForTimeout(300);
    const f1 = await canvasPan();
    ck(`${label}: CONTROL — at Fit an edge is only an edge`, f0?.scale === 1 && JSON.stringify(f0) === JSON.stringify(f1), JSON.stringify(f1));

    // 5. The pointer drawn here, in the host's shape; the elevated banner.
    await page.waitForFunction(() => window.__stage.state.cursorOwned, null, { timeout: 3000 }).catch(() => undefined);
    await page.evaluate(() => { window.__stage.state.remoteCursor = 'text'; window.__stage.emit(); });
    await page.waitForTimeout(100);
    const surfaceCursor = () => page.evaluate(() => getComputedStyle(document.querySelector('.device-stage-surface')).cursor);
    const cursor = await surfaceCursor();
    ck(`${label}: the pointer is drawn here in the host's shape`, cursor === 'text', cursor);
    // CONTROL: Mouse > "Draw the pointer here" off hands the pointer back.
    await press(page, page.locator('.dsb-menu-btn', { hasText: 'Mouse' }).first());
    await page.waitForTimeout(100);
    await press(page, page.locator('.dsb-menu .dsb-item', { hasText: 'Draw the pointer here' }).first());
    await page.waitForTimeout(400);
    const handedBack = await surfaceCursor();
    ck(`${label}: CONTROL — with the instant pointer off it is the host's to draw`, handedBack !== 'text' && !(await page.evaluate(() => window.__stage.state.cursorOwned)), handedBack);
    const bannerFor = app => page.evaluate(a => {
        const el = [...document.querySelectorAll('.device-stage-secure')].find(e => e.textContent.includes(a));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, W: document.documentElement.clientWidth, clipped: el.scrollWidth > el.clientWidth + 1 };
    }, app);
    ck(`${label}: CONTROL — no elevated-window banner while nothing is in the way`, (await bannerFor('valheim.exe')) === null);
    await page.evaluate(() => { window.__stage.state.peerName = 'Work Laptop'; window.__stage.state.inputBlocked = 'valheim.exe'; window.__stage.emit(); });
    await page.waitForTimeout(100);
    const banner = await bannerFor('valheim.exe');
    ck(`${label}: the elevated-window banner is on screen, unclipped, parked at the top`,
        !!banner && banner.left >= 0 && banner.right <= banner.W && !banner.clipped && banner.top < 160,
        banner ? `top ${Math.round(banner.top)}, ${Math.round(banner.left)}..${Math.round(banner.right)} of ${banner.W}` : 'missing');
    if (w === 1280) await page.screenshot({ path: join(outdir, `banner-${w}.png`) });
    await page.evaluate(() => { window.__stage.state.inputBlocked = null; window.__stage.emit(); });

    // 6. Copy diagnostics in a real browser: it ends, whatever the clipboard
    // says — never stuck at "Measuring…" — and, with the clipboard allowed,
    // the copy holds the rows and the stage's own state.
    if (w === 1280) {
        const copyDiag = async () => {
            await press(page, page.locator('button[aria-label="More"]'));
            await page.waitForTimeout(100);
            await press(page, page.locator('.dsb-menu .dsb-item', { hasText: 'Copy diagnostics' }).first());
        };
        const finalNote = () => page.waitForFunction(
            () => /Diagnostics copied|Could not copy diagnostics/.exec(document.body.textContent ?? '')?.[0] ?? null,
            null, { timeout: 6000 },
        ).then(hnd => hnd.jsonValue()).catch(() => null);
        await copyDiag();
        const first = await finalNote();
        ck(`${label}: Copy diagnostics ends with a note, clipboard allowed or not`, !!first, first ?? 'still waiting after 6 s');
        await page.waitForTimeout(6500); // that note's own lifetime
        await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
        await copyDiag();
        const second = await finalNote();
        const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(e => `read failed: ${e}`);
        ck(`${label}: …and with the clipboard allowed, the copy is the report`,
            second === 'Diagnostics copied' && copied.includes('"harness"') && copied.includes('"caret"') && copied.includes('"stageInput"'),
            `${second}; ${copied.slice(0, 60).replace(/\s+/g, ' ')}`);
        // The 0.9.819 failure itself: a clipboard that never answers (a
        // permission prompt nobody can see). It must end, and say why.
        await page.waitForTimeout(6500);
        await page.evaluate(() => { navigator.clipboard.writeText = () => new Promise(() => { /* never */ }); });
        const t0 = Date.now();
        await copyDiag();
        const third = await page.waitForFunction(
            () => /Could not copy diagnostics: the clipboard gave no answer[^.]*\. Is a permission prompt waiting\?/.exec(document.body.textContent ?? '')?.[0] ?? null,
            null, { timeout: 8000 },
        ).then(hnd => hnd.jsonValue()).catch(() => null);
        ck(`${label}: a clipboard that never answers ends in a note naming it`, !!third, third ? `${third} (${Date.now() - t0} ms)` : 'still waiting after 8 s');
    }

    // 6b. An agent too old to report pointer shapes: the stage takes the
    // pointer, hears no shape within 3 s, and hands it back to the host for
    // the session (the default above, a current agent, keeps it).
    if (w === 1280) {
        await page.evaluate(() => { window.__stage.knobs.sendsShapes = false; window.__stage.state.remoteCursor = null; window.__stage.emit(); });
        const toggleDraw = async () => {
            await press(page, page.locator('.dsb-menu-btn', { hasText: 'Mouse' }).first());
            await page.waitForTimeout(100);
            await press(page, page.locator('.dsb-menu .dsb-item', { hasText: 'Draw the pointer here' }).first());
            await page.waitForTimeout(150);
        };
        // Off if it is on, then on: a fresh take, by the menu a person uses.
        const drawIsOn = () => page.evaluate(() => localStorage.getItem('device-stage-instant-pointer') !== 'off');
        if (await drawIsOn()) await toggleDraw();
        await toggleDraw();
        await page.waitForFunction(() => window.__stage.state.cursorOwned === true, null, { timeout: 3000 }).catch(() => undefined);
        const tookIt = await page.evaluate(() => window.__stage.state.cursorOwned);
        await page.waitForTimeout(3500);
        const after = await page.evaluate(() => ({ owned: window.__stage.state.cursorOwned, cursor: getComputedStyle(document.querySelector('.device-stage-surface')).cursor }));
        ck(`${label}: an agent that sends no shapes gets the pointer back within 3 s`, tookIt === true && after.owned === false && after.cursor === 'crosshair',
            `took it ${tookIt}; after 3.5 s owned ${after.owned}, cursor ${after.cursor}`);
        await page.evaluate(() => { window.__stage.knobs.sendsShapes = true; });
    }

    // 7. Minimised to the chat ("Back to Púca"), the keyboard is the app's: a
    // key typed with the focus off the composer, Enter, Delete, Ctrl+A and the
    // stage's own Ctrl+Alt+End send NOTHING. CONTROL: back on the stage, the
    // same keys go over.
    {
        const typeSome = async () => {
            await page.keyboard.type('ok');
            await page.keyboard.press('Enter');
            await page.keyboard.press('Delete');
            await page.keyboard.press('Control+a');
            await page.keyboard.press('Control+Alt+End');
            await page.waitForTimeout(150);
            return page.evaluate(() => window.__stage.inputs.filter(e => e.t === 'key' || e.t === 'sas' || e.t === 'text').length);
        };
        await press(page, page.locator('button[aria-label="More"]'));
        await page.waitForTimeout(100);
        await press(page, page.locator('.dsb-menu .dsb-item', { hasText: 'Back to Púca' }).first());
        await page.waitForTimeout(200);
        const pill = page.locator('.device-stage-minimized');
        ck(`${label}: Back to Púca leaves the stage as a pill`, await pill.count() === 1);
        await page.evaluate(() => { document.activeElement instanceof HTMLElement && document.activeElement.blur(); });
        await clearSent(page);
        const whileMinimised = await typeSome();
        ck(`${label}: minimised, typing sends nothing over there — not a key, not Ctrl+Alt+Del`, whileMinimised === 0, `${whileMinimised} sent`);
        await press(page, pill);
        await page.waitForTimeout(300);
        await page.mouse.move(video.x + video.width * 0.5, video.y + video.height * 0.5);
        await clearSent(page);
        const onStage = await typeSome();
        ck(`${label}: CONTROL — back on the stage, the same keys go over`, onStage > 0, `${onStage} sent`);
    }

    // The stats chip.
    const chip = await page.locator('.dsb-stats-chip').textContent().catch(() => null);
    ck(`${label}: the stats chip shows the frame rate`, !!chip && /\d+ fps/.test(chip), chip ?? 'missing');
    await ctx.close();
}

await browser.close();
server.close();
console.log(fail ? `${fail} FAILED` : 'ALL PASS');
process.exit(fail ? 1 : 0);
