// The device card's POWER OFF in a REAL browser: the shipped DevicesView, its
// cards and CSS, api/devices/powerOff.ts's wording and the app's own question
// (components/AppDialogs.tsx), against stand-in PCs (e2e/devices-power/: the
// device list, the shares and the session layer are played; each PC answers
// a power-off the way the real hosts do — pinned against the real session
// layer in src/tests/devicePowerOffController.test.ts).
//
// NOTHING IS EVER POWERED OFF: there is no host here at all, only a script in
// the page. No server, no agent, no Windows call.
//
//  1280x800, a fake Tauri shell (so askConfirm is the app's IN-PAGE question,
//  as in the desktop app), a real mouse:
//   - Power off is on every online Windows PC and a control share, and on no
//     offline PC, phone, Linux box or view-only share; its glyph is an SVG
//     from the icon set; what elementFromPoint hits at its middle is it;
//   - the press asks first: the in-page question is on screen, names the PC
//     and the unsaved work, OK is what a click there hits; Cancel sends
//     nothing (NO connect recorded) and leaves no line; no native dialog;
//   - OK: the steps are said, Power off and Control wait, and the outcome
//     stays: going; an older Púca there; Windows refusing; nobody let it in;
//     not set up for unattended access (somebody there let it in, and the
//     host refuses a forced power-off on such a session);
//     a PC that went offline after the card was painted (nothing sent); a
//     friend's PC with control (the share rides along); a friend's PC that
//     refuses (not allowed). Refusals look like refusals;
//   - every line stays inside its card, every card inside the window.
//  390x844 coarse pointer (no shell: askConfirm is the browser's confirm, as
//  on the web and in the Android app), real taps:
//   - Power off is a 44x44 target a tap reaches; the confirm names the PC;
//     dismissing it sends nothing; accepting it powers off;
//   - no horizontal overflow with the lines shown (POSITIVE CONTROL: a 460 px
//     element is reported).
//  Both: every word on the Power off buttons and the lines at 4.5:1 on all
//  eight themes with and without high contrast (NEGATIVE CONTROL: a line
//  painted in its own surface's colour fails the same measure).
//
//   cd frontend && node e2e/devices-power-real-browser.mjs [outdir]
//
// Builds e2e-artifacts/devices-power-dist (vite.devicesharness.config.ts).
// Headless Edge, --mute-audio, never fullscreen; nothing leaves 127.0.0.1.
import { chromium, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const outdir = process.argv[2] || join(here, 'e2e-artifacts', 'devices-power-shots');
await mkdir(outdir, { recursive: true });
execFileSync(process.execPath, [join(here, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.devicesharness.config.ts', '--logLevel', 'error'], { cwd: here, stdio: 'inherit' });
const ROOT = join(here, 'e2e-artifacts', 'devices-power-dist');

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
const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OFFERED = ['Slim-Jim', 'Old Laptop', 'Desk PC', 'Garage PC', 'Living Room PC', 'Media PC', 'Box', 'Attic PC'];
const NOT_OFFERED = ['Spare PC', 'Pixel', 'Server', 'Den PC'];

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });

/** In the page: the card whose name starts with `name`, and its parts. */
function cardParts(name) {
    const card = [...document.querySelectorAll('.device-card')]
        .find(c => (c.querySelector('.device-name')?.firstChild?.textContent ?? '').trim() === name);
    if (!card) return null;
    const btn = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Power off');
    const line = card.querySelector('.device-power-status');
    const control = [...card.querySelectorAll('button')].find(b => ['Control', 'View'].includes(b.textContent.trim()));
    const r = card.getBoundingClientRect();
    return {
        hasButton: !!btn,
        buttonDisabled: btn ? btn.disabled : null,
        buttonHasSvg: !!btn?.querySelector('svg'),
        controlDisabled: control ? control.disabled : null,
        line: line?.textContent ?? null,
        lineFailed: !!line?.classList.contains('device-wake-status-failed'),
        lineInside: line ? (() => { const l = line.getBoundingClientRect(); return l.left >= r.left - 0.5 && l.right <= r.right + 0.5; })() : null,
        cardInsideWindow: r.left >= 0 && r.right <= document.documentElement.clientWidth + 0.5,
    };
}

/** The Power off button of `name`, scrolled into view: its box and whether
 *  elementFromPoint at its middle is it. */
async function powerOffTarget(page, name) {
    const loc = page.locator('.device-card', { has: page.locator('.device-name', { hasText: name }) })
        .locator('button', { hasText: /^Power off$/ });
    await loc.first().scrollIntoViewIfNeeded();
    await sleep(80);
    const box = await loc.first().boundingBox();
    const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        const b = el?.closest('button');
        return b ? b.textContent.trim() : (el ? el.tagName : null);
    }, [box.x + box.width / 2, box.y + box.height / 2]);
    return { box, hit };
}

/** Follow a card's line until it is no longer a step ("…"), collecting
 *  what it said on the way. */
async function followLine(page, name, ms = 6000) {
    const seen = [];
    const end = Date.now() + ms;
    let parts = null;
    while (Date.now() < end) {
        parts = await page.evaluate(cardParts, name);
        const t = parts?.line;
        if (t && seen[seen.length - 1] !== t) seen.push(t);
        if (t && !t.endsWith('…')) break;
        await sleep(40);
    }
    return { seen, parts };
}

const calls = page => page.evaluate(() => window.__power.calls.map(c => ({ host: c.host, opts: c.opts })));

// ============================================================ DESKTOP ======
{
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // The desktop app: the shell is what makes askConfirm the IN-PAGE
    // question. Every command it is sent is refused, as a shell without that
    // command would; nothing here answers for real.
    await ctx.addInitScript(() => {
        window.__TAURI_INTERNALS__ = {
            invoke: async cmd => { throw new Error(`not in this harness: ${cmd}`); },
            transformCallback: () => 0,
            unregisterCallback: () => {},
        };
    });
    const page = await ctx.newPage();
    let crashes = 0;
    const nativeDialogs = [];
    page.on('pageerror', e => { if (/Minified React error|is not a function|Cannot read prop/.test(String(e))) { crashes++; console.log('[pageerror]', String(e).slice(0, 300)); } });
    page.on('dialog', d => { nativeDialogs.push(d.message()); void d.dismiss(); });
    await page.goto(base);
    await page.waitForSelector('.devices-dashboard', { timeout: 15000 });
    await page.waitForFunction(n => document.querySelectorAll('.device-card').length >= n, OFFERED.length + NOT_OFFERED.length, { timeout: 10000 });

    const offered = [];
    const notOffered = [];
    for (const n of [...OFFERED, ...NOT_OFFERED]) {
        const p = await page.evaluate(cardParts, n);
        (p?.hasButton ? offered : notOffered).push(n);
    }
    ck('desktop: Power off on every online Windows PC and control share', OFFERED.every(n => offered.includes(n)), offered.join(', '));
    ck('desktop: …and on no offline PC, phone, Linux box or view-only share', NOT_OFFERED.every(n => notOffered.includes(n)), notOffered.join(', '));
    ck('desktop: its glyph is an SVG from the icon set (no emoji)', (await page.evaluate(cardParts, 'Slim-Jim')).buttonHasSvg);
    await page.screenshot({ path: `${outdir}/desktop-cards.png` });

    // --- the question, then Cancel ---------------------------------------
    let t = await powerOffTarget(page, 'Slim-Jim');
    ck('desktop: elementFromPoint at the middle of Power off is Power off', t.hit === 'Power off', String(t.hit));
    await page.mouse.click(t.box.x + t.box.width / 2, t.box.y + t.box.height / 2);
    const q = page.locator('dialog.app-question[open]');
    const shown = await q.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
    ck('desktop: the press asks first, with the app\'s own in-page question', shown);
    const msg = shown ? await q.locator('.app-question-message').textContent() : '';
    ck('desktop: the question names the PC and says unsaved work is lost', /^Power off Slim-Jim now\?/.test(msg) && /unsaved work on Slim-Jim will be lost/.test(msg), JSON.stringify(msg?.slice(0, 120)));
    const qGeom = await page.evaluate(() => {
        const d = document.querySelector('dialog.app-question[open]');
        const r = d.getBoundingClientRect();
        const ok = d.querySelector('.app-question-ok').getBoundingClientRect();
        const hit = document.elementFromPoint(ok.x + ok.width / 2, ok.y + ok.height / 2);
        return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, okHit: hit?.textContent?.trim() };
    });
    ck('desktop: the question is on screen and OK is what a click there hits', qGeom.inside && qGeom.okHit === 'OK', JSON.stringify(qGeom));
    await page.screenshot({ path: `${outdir}/desktop-question.png` });
    const cancel = await q.locator('button', { hasText: 'Cancel' }).boundingBox();
    await page.mouse.click(cancel.x + cancel.width / 2, cancel.y + cancel.height / 2);
    await sleep(400);
    ck('desktop: Cancel sends nothing and leaves no line', (await calls(page)).length === 0 && (await page.evaluate(cardParts, 'Slim-Jim')).line === null);

    // --- OK, each PC's answer ---------------------------------------------
    async function pressAndConfirm(name) {
        const tt = await powerOffTarget(page, name);
        await page.mouse.click(tt.box.x + tt.box.width / 2, tt.box.y + tt.box.height / 2);
        await q.waitFor({ state: 'visible', timeout: 3000 });
        const ok = await q.locator('.app-question-ok').boundingBox();
        await page.mouse.click(ok.x + ok.width / 2, ok.y + ok.height / 2);
    }

    await pressAndConfirm('Slim-Jim');
    await sleep(120);
    const running = await page.evaluate(cardParts, 'Slim-Jim');
    ck('desktop: while it runs, Power off and Control wait', running.buttonDisabled === true && running.controlDisabled === true, JSON.stringify(running));
    let r = await followLine(page, 'Slim-Jim');
    ck('desktop: the steps are said, then "Slim-Jim is powering off."',
        r.seen.includes('Slim-Jim is powering off…') && r.parts.line === 'Slim-Jim is powering off.' && !r.parts.lineFailed,
        r.seen.join(' | '));
    const c0 = (await calls(page))[0];
    ck('desktop: the connect went to that PC as a power-off session, naming it', c0?.host === 'pc-going' && c0?.opts?.powerOff === true && c0?.opts?.peerName === 'Slim-Jim', JSON.stringify(c0));
    ck('desktop: Power off is back once it is over', (await page.evaluate(cardParts, 'Slim-Jim')).buttonDisabled === false);

    const expectations = [
        ['Old Laptop', /^Old Laptop runs a Púca too old to be powered off from here\. Update Púca on Old Laptop/],
        ['Desk PC', /^Desk PC was not powered off: Windows refused: the account Púca runs as there may not shut it down\.$/],
        ['Garage PC', /^Garage PC asked the person there to let the connection in, and nobody did/],
        ['Living Room PC', /^Living Room PC was not powered off: it is not set up for unattended access/],
        ['Attic PC', /^Your access to Attic PC does not include control, so you cannot power it off/],
    ];
    for (const [name, want] of expectations) {
        await pressAndConfirm(name);
        r = await followLine(page, name);
        ck(`desktop: ${name}: said, as a refusal`, want.test(r.parts?.line ?? '') && r.parts.lineFailed, r.parts?.line);
    }

    // A PC that went away after the card was painted: decided at the press.
    await page.evaluate(() => { window.__devicesGoOffline = ['pc-gone']; });
    const before = (await calls(page)).length;
    await pressAndConfirm('Media PC');
    r = await followLine(page, 'Media PC');
    ck('desktop: a PC offline at the press: said, and NOTHING sent', r.parts?.line === 'Media PC is offline, so it cannot be powered off from here (it may already be off).'
        && (await calls(page)).length === before, `${r.parts?.line} calls ${before}->${(await calls(page)).length}`);

    // A friend's PC with control: the share rides along.
    await pressAndConfirm('Box');
    r = await followLine(page, 'Box');
    const boxCall = (await calls(page)).find(c => c.host === 'their-box');
    ck('desktop: a friend\'s PC with control powers off, the share riding along', r.parts?.line === 'Box is powering off.'
        && boxCall?.opts?.share?.capabilities?.includes('control') && boxCall?.opts?.share?.inviteId === 1, JSON.stringify(boxCall));
    await page.mouse.move(5, 795);
    await sleep(200);
    for (const [name, file] of [['Box', 'desktop-card-box'], ['Slim-Jim', 'desktop-card-slimjim'], ['Old Laptop', 'desktop-card-old']]) {
        await page.locator('.device-card', { has: page.locator('.device-name', { hasText: name }) }).first().screenshot({ path: `${outdir}/${file}.png` });
    }

    const geom = [];
    const stuck = [];
    for (const n of OFFERED) {
        const p = await page.evaluate(cardParts, n);
        if (!p.lineInside || !p.cardInsideWindow) geom.push(n);
        // Once it is over, nothing on the card is left waiting on it.
        if (p.buttonDisabled === true || p.controlDisabled === true) stuck.push(`${n} ${JSON.stringify(p)}`);
    }
    ck('desktop: every line inside its card, every card inside the window', geom.length === 0, geom.join(', '));
    ck('desktop: once each is over, its card\'s Power off and Control are back', stuck.length === 0, stuck.join(' / '));
    ck('desktop: no native dialog was ever opened', nativeDialogs.length === 0, nativeDialogs.join(' | '));
    ck('desktop: no render crash', crashes === 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${outdir}/desktop-outcomes.png`, fullPage: true });
    await themes(page, 'desktop');
    await ctx.close();
}

// ============================================================ PHONE ========
{
    const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    let crashes = 0;
    page.on('pageerror', e => { if (/Minified React error|is not a function|Cannot read prop/.test(String(e))) { crashes++; console.log('[pageerror]', String(e).slice(0, 300)); } });
    const confirms = [];
    let answer = false;
    page.on('dialog', d => { confirms.push({ type: d.type(), message: d.message() }); void (answer ? d.accept() : d.dismiss()); });
    await page.goto(base);
    await page.waitForSelector('.devices-dashboard', { timeout: 15000 });
    await page.waitForFunction(n => document.querySelectorAll('.device-card').length >= n, OFFERED.length + NOT_OFFERED.length, { timeout: 10000 });

    const small = await page.evaluate(() => [...document.querySelectorAll('.device-card button')]
        .filter(b => b.textContent.trim() === 'Power off')
        .map(b => b.getBoundingClientRect())
        .filter(r => r.height < 44 || r.width < 44).length);
    ck('phone: every Power off is at least 44x44', small === 0, `${small} under`);

    let t = await powerOffTarget(page, 'Slim-Jim');
    ck('phone: what a tap at the middle of Power off hits is Power off', t.hit === 'Power off', String(t.hit));
    answer = false;
    await page.touchscreen.tap(t.box.x + t.box.width / 2, t.box.y + t.box.height / 2);
    await sleep(500);
    ck('phone: the tap asks first (the browser\'s confirm, as on the web and in the Android app), naming the PC',
        confirms.length === 1 && confirms[0].type === 'confirm' && /^Power off Slim-Jim now\?/.test(confirms[0].message) && /will be lost/.test(confirms[0].message),
        JSON.stringify(confirms[0]?.message?.slice(0, 80)));
    ck('phone: dismissing it sends nothing', (await calls(page)).length === 0 && (await page.evaluate(cardParts, 'Slim-Jim')).line === null);

    answer = true;
    t = await powerOffTarget(page, 'Slim-Jim');
    await page.touchscreen.tap(t.box.x + t.box.width / 2, t.box.y + t.box.height / 2);
    let r = await followLine(page, 'Slim-Jim');
    ck('phone: accepted, it powers off and says so', r.parts?.line === 'Slim-Jim is powering off.', r.seen.join(' | '));
    t = await powerOffTarget(page, 'Old Laptop');
    await page.touchscreen.tap(t.box.x + t.box.width / 2, t.box.y + t.box.height / 2);
    r = await followLine(page, 'Old Laptop');
    ck('phone: an older Púca there is said, as a refusal', /too old/.test(r.parts?.line ?? '') && r.parts.lineFailed, r.parts?.line);
    t = await powerOffTarget(page, 'Garage PC');
    await page.touchscreen.tap(t.box.x + t.box.width / 2, t.box.y + t.box.height / 2);
    r = await followLine(page, 'Garage PC');
    ck('phone: nobody letting it in is said', /nobody did/.test(r.parts?.line ?? ''), r.parts?.line);

    const overflow = () => page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const widest = Math.max(0, ...[...document.querySelectorAll('#root *')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; }).map(e => Math.round(e.getBoundingClientRect().right)));
        return { scrolls: document.documentElement.scrollWidth > vw, widest, vw };
    });
    const ov = await overflow();
    ck('phone: no horizontal overflow with the lines shown', !ov.scrolls && ov.widest <= ov.vw, JSON.stringify(ov));
    await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'walk-wide-control';
        d.style.cssText = 'position:absolute;left:0;top:0;width:460px;height:1px;pointer-events:none';
        document.getElementById('root').appendChild(d);
    });
    const wide = await overflow();
    ck('POSITIVE CONTROL (phone): a 460 px element IS reported as overflow', wide.scrolls || wide.widest > wide.vw, JSON.stringify(wide));
    await page.evaluate(() => document.getElementById('walk-wide-control')?.remove());
    ck('phone: no render crash', crashes === 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${outdir}/phone-outcomes.png`, fullPage: true });
    await themes(page, 'phone');
    await ctx.close();
}

/**
 * All eight themes x contrast: every run of words on the Power off buttons
 * and the lines at 4.5:1 on what it is painted on (translucent layers
 * composited down to the first opaque one). Disabled controls are exempt, as
 * WCAG has them.
 */
async function themes(page, where) {
    const THEMES = ['dark', 'light', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
    const poor = [];
    let readings = 0;
    for (const theme of THEMES) {
        for (const hc of ['normal', 'high']) {
            await page.evaluate(([th, c]) => {
                document.documentElement.setAttribute('data-theme', th);
                document.documentElement.setAttribute('data-contrast', c);
            }, [theme, hc]);
            await sleep(250);
            const got = await page.evaluate(measure, ['.device-power-status', 'POWER_OFF_BUTTONS']);
            readings += got.length;
            for (const g of got) if (g.ratio < 4.5) poor.push(`${theme}/${hc} "${g.text}" ${g.ratio.toFixed(2)}:1`);
            if (hc === 'normal' && (theme === 'light' || theme === 'yellow')) {
                await page.screenshot({ path: `${outdir}/${where}-theme-${theme}.png`, fullPage: true });
            }
        }
    }
    ck(`${where}: every word on Power off and its lines at 4.5:1, all eight themes x contrast`, poor.length === 0 && readings > 100, poor.length ? poor.slice(0, 8).join('; ') : `${readings} readings`);
    // NEGATIVE CONTROL: the measure fails a line painted in its own surface's colour.
    await page.evaluate(() => {
        const s = document.createElement('style');
        s.id = 'neg';
        s.textContent = '.device-power-status { color: transparent !important; } .device-power-status { color: inherit; }';
        document.head.appendChild(s);
        const line = document.querySelector('.device-power-status');
        let bg = 'rgb(0,0,0)';
        for (let e = line; e; e = e.parentElement) {
            const c = getComputedStyle(e).backgroundColor;
            if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { bg = c; break; }
        }
        s.textContent = `.device-power-status { color: ${bg} !important; }`;
    });
    const neg = await page.evaluate(measure, ['.device-power-status']);
    await page.evaluate(() => document.getElementById('neg')?.remove());
    ck(`NEGATIVE CONTROL (${where}): the same measure fails a line painted in its surface's colour`, neg.some(g => g.ratio < 1.6), neg.map(g => g.ratio.toFixed(2)).join(','));
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.documentElement.setAttribute('data-contrast', 'normal'); });
}

function measure(roots) {
    const rgba = s => { const m = s.match(/[\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); return [r, g, b, a]; };
    const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
    const lum = c => { const v = c.slice(0, 3).map(x => x / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const out = [];
    const els = [];
    for (const sel of roots) {
        if (sel === 'POWER_OFF_BUTTONS') {
            for (const b of document.querySelectorAll('.device-card button')) if (b.textContent.trim() === 'Power off') els.push(b);
        } else {
            els.push(...document.querySelectorAll(sel));
        }
    }
    for (const el of els) {
        if (el.closest(':disabled')) continue;
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
    return out;
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
