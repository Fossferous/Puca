// "That PC's screen is off" on the phone, in a REAL browser: the shipped
// DeviceStage (the stand-in host of e2e/device-stage/, built by
// vite.stageharness.config.ts) showing the two messages a laptop with its lid
// shut now produces instead of "could not connect to the device":
//
//   1. while the host switches on its virtual screen, the waiting banner says
//      "<PC>'s screen is off — starting a virtual screen…";
//   2. when there is no screen and no virtual screen, the session ends with
//      "<PC>'s screen is off — is its lid closed? Turn on 'Allow remote
//      control with the lid closed' on that PC." (the longest sentence the
//      stage has to fit).
//
// Each must be on screen, unclipped and inside a 390x844 coarse-pointer phone
// without widening the page, and at 1280x800. jsdom has no layout, so vitest
// (deviceNoScreen*.test.ts) cannot see any of that.
//
// Width is measured against documentElement.clientWidth, never innerWidth: an
// isMobile page wider than the screen widens innerWidth to fit, so a check
// against it cannot fail. POSITIVE CONTROL per context: a 460 px element is
// injected and the same check must FAIL. Second control: with the notice off,
// the banner says the old words, so the rig can see the knob at all.
//
// Usage: node e2e/no-screen-stage-real-browser.mjs [outdir]
// Builds the harness itself; no server needed. Silent (--mute-audio).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const outdir = process.argv[2] || join(here, 'e2e-artifacts', 'no-screen-stage-shots');
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

// The sentences, as noScreen.ts writes them for a PC called "Work Laptop".
const STARTING = 'Work Laptop’s screen is off — starting a virtual screen…';
const LID = 'Work Laptop’s screen is off — is its lid closed? '
    + 'Turn on “Allow remote control with the lid closed” on that PC.';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });

/** Is `sel` on screen, unclipped, and inside the page's real width? */
const fits = (page, sel) => page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) return { ok: false, why: 'not on screen' };
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const inside = r.left >= 0 && r.right <= vw + 0.5 && r.top >= 0 && r.bottom <= vh + 0.5;
    const unclipped = el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1;
    const pageWide = document.documentElement.scrollWidth > vw + 0.5;
    const st = getComputedStyle(el);
    const visible = st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0;
    return {
        ok: inside && unclipped && !pageWide && visible && r.width > 0,
        why: `rect ${Math.round(r.left)}..${Math.round(r.right)} x ${Math.round(r.top)}..${Math.round(r.bottom)} in ${vw}x${vh}, `
            + `scroll ${el.scrollWidth}/${el.clientWidth}, page ${document.documentElement.scrollWidth}, visible ${visible}`,
        text: el.textContent?.trim() ?? '',
    };
}, sel);

for (const [tag, opts] of [
    ['phone 390x844', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }],
    ['desktop 1280x800', { viewport: { width: 1280, height: 800 } }],
]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.on('pageerror', e => { fail++; console.log('[pageerror]', String(e).slice(0, 300)); });
    await page.goto(base);
    await page.waitForSelector('.device-stage-surface', { timeout: 15000 });

    // Control: waiting, no notice -> the old words.
    await page.evaluate(() => { const S = window.__stage; S.state.peerName = 'Work Laptop'; S.state.awaitingMedia = true; S.emit(); });
    await page.waitForTimeout(150);
    const plain = await fits(page, '.device-stage-waiting');
    ck(`${tag}: control — waiting with no notice says the old words`, plain.text === 'Waiting for the device\'s screen…', plain.text);

    // 1. The virtual screen is starting.
    await page.evaluate(() => { const S = window.__stage; S.state.hostScreen = 'virtual-starting'; S.emit(); });
    await page.waitForTimeout(150);
    const starting = await fits(page, '.device-stage-waiting');
    ck(`${tag}: the waiting banner names the PC and the virtual screen`, starting.text === STARTING, starting.text);
    ck(`${tag}: …on screen, unclipped, inside the window`, starting.ok, starting.why);
    await page.screenshot({ path: `${outdir}/${tag.split(' ')[0]}-1-starting.png` });

    // 2. No screen at all: the session ends with the lid sentence.
    await page.evaluate(lid => { const S = window.__stage; S.state.endedWith = lid; S.emit(); }, LID);
    await page.waitForTimeout(250);
    const ended = await fits(page, '.device-stage-failure');
    ck(`${tag}: the ended session shows the lid sentence`, ended.text.includes(LID), ended.text);
    ck(`${tag}: …on screen, unclipped, inside the window`, ended.ok, ended.why);
    // ...and it uses the room it has. A fixed banner at left:50% shrank to
    // half the phone (195 px of 390) and wrapped this sentence onto nine
    // lines; the cap is min(560 px, the window less 32 px).
    const room = await page.evaluate(() => {
        const r = document.querySelector('.device-stage-failure').getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        return { w: Math.round(r.width), want: Math.min(560, vw - 32) };
    });
    ck(`${tag}: …as wide as its cap allows for a long reason`, room.w >= room.want - 2, `${room.w} of ${room.want} px`);
    await page.screenshot({ path: `${outdir}/${tag.split(' ')[0]}-2-lid.png` });

    // POSITIVE CONTROL: the same check fails for a page made too wide.
    await page.evaluate(() => {
        const d = document.createElement('div');
        d.style.cssText = 'width:2000px;height:4px;background:red';
        document.body.appendChild(d);
    });
    const wide = await fits(page, '.device-stage-failure');
    ck(`${tag}: control — a 2000 px element makes the same check FAIL`, !wide.ok, wide.why);
    await ctx.close();
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
