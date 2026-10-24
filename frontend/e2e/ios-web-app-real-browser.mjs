// Púca as an iPhone Home Screen app, and the download page that offers it, in
// REAL WebKit (Playwright's WebKit build: Safari's engine, the closest thing to
// an iPhone this PC has).
//
// WHAT THIS CAN AND CANNOT SEE. It builds the app (throwaway build, API baked as
// a closed local port, nothing ever shipped) and renders the download page the
// way deploy/ops/dual-ship.sh does, serves both on loopback, and loads them at
// 390x844 (touch, device scale 3) with an iPhone user agent. It checks, in
// WebKit's own DOM and layout: the manifest is linked, parses, and every icon in
// it loads, is the size it declares and is opaque once DECODED; the Apple tags
// are present; viewport-fit=cover is added in a Home Screen app in portrait and
// removed in landscape and is never there in a Safari tab; the phone bottom bar
// keeps its buttons clear of a 34 px home-indicator inset (with the old CSS as
// the negative control that must FAIL the same check); and the download page puts
// "iPhone & iPad" first for an iPhone user agent, keeps it in place for a
// desktop one and with JavaScript off, keeps ?variant=lite working, loads nothing
// from outside, and has no horizontal overflow.
//
// WHAT IT CANNOT SEE, and nothing here pretends to: Add to Home Screen itself,
// standalone mode (navigator.standalone is faked with an init script), the status
// bar, the real safe-area insets (WebKit on Windows reports 0; the bar's check
// overrides the variable), the Share sheet, and anything WebRTC (this WebKit has
// none). Those need a real iPhone: docs/USER_GUIDE.md says which.
//
//   cd frontend && node e2e/ios-web-app-real-browser.mjs [outdir]
//
// Needs WebKit once:  npx playwright install webkit   (about 60 MB, per machine).
// No server, no backend, no audio: the pages play nothing. Screenshots land in
// outdir (default e2e-artifacts/ios-web-app-shots, git-ignored).
import { webkit, devices } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { qrSvg } from '../../deploy/ops/make-qr-svg.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FE = path.resolve(here, '..');
const REPO = path.resolve(FE, '..');
const outDir = path.resolve(process.argv[2] || path.join(FE, 'e2e-artifacts', 'ios-web-app-shots'));
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'puca-ios-web-'));

let fails = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  - ${detail}` : ''}`);
    if (!ok) fails++;
};

// ---------------------------------------------------------------- the build ---
const dist = process.env.DIST || path.join(tmp, 'dist');
if (!process.env.DIST) {
    const r = spawnSync(process.execPath, [path.join(FE, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', dist, '--emptyOutDir'], {
        cwd: FE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        // A closed local port: the page can never reach a real server, and the
        // production API in .env.production is never baked into a test build.
        env: { ...process.env, VITE_API_URL: 'http://127.0.0.1:9' },
    });
    if (r.status !== 0) { console.error(r.stdout + r.stderr); console.error('FAIL  the throwaway build'); process.exit(1); }
}

// -------------------------------------------------- the rendered download page ---
// The same substitutions render_download_page makes in dual-ship.sh; the QR comes
// from the same module its CLI calls. APP_HOST is a name that cannot resolve.
const APP_HOST = 'app.invalid';
const template = fs.readFileSync(path.join(REPO, 'deploy', 'download-site', 'index.html'), 'utf8');
const pageHtml = template
    .replaceAll('__API_HOST__', 'api.invalid').replaceAll('__DOWNLOAD_HOST__', 'dl.invalid').replaceAll('__APP_HOST__', APP_HOST)
    .replace('__APP_QR_SVG__', () => qrSvg(`https://${APP_HOST}`, APP_HOST));
check('the rendered page has no token left', !/__[A-Z_]+__/.test(pageHtml));

// ------------------------------------------------------------------ servers ---
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
};
function serve(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
    });
}
const app = await serve((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    if (rel.includes('..')) { res.writeHead(403); return res.end(); }
    for (const f of [path.join(dist, rel), path.join(dist, rel, 'index.html'), path.join(dist, 'index.html')]) {
        try {
            if (!fs.statSync(f).isFile()) continue;
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
            return res.end(fs.readFileSync(f));
        } catch { /* next candidate */ }
    }
    res.writeHead(404); res.end();
});
const site = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    res.end(pageHtml);
});

// ------------------------------------------------------------------ WebKit ---
let browser;
try {
    browser = await webkit.launch();
} catch (e) {
    console.error(String(e.message || e).split('\n')[0]);
    console.error('FAIL  WebKit is not installed here. Run:  npx playwright install webkit');
    process.exit(1);
}
// 390x844 as asked (the stock profile's 393x659 is Safari's page area, not the screen).
const iphone = { ...devices['iPhone 15'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
console.log(`WebKit ${browser.version()} as "${iphone.userAgent}"`);
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

/** A page in a fresh context; every request URL is recorded. */
async function open(url, opts, { init } = {}) {
    const context = await browser.newContext(opts);
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    const seen = [];
    const errors = [];
    page.on('request', (r) => seen.push(r.url()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url, { waitUntil: 'load' });
    return { context, page, seen, errors };
}
const viewportContent = (page) => page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null);

// =========================================================== 1. the web app ===
console.log('\n--- the web app, as Safari (a tab) ---');
{
    const { context, page, errors } = await open(app.url, iphone);
    await page.waitForFunction(() => (document.getElementById('root')?.children.length ?? 0) > 0, null, { timeout: 20000 }).catch(() => {});
    check('the app mounted something in WebKit (no WebRTC there)', await page.evaluate(() => (document.getElementById('root')?.children.length ?? 0) > 0), errors.join(' | ').slice(0, 300));
    await page.screenshot({ path: path.join(outDir, 'app-390x844-safari-tab.png') });

    const head = await page.evaluate(() => {
        const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content') ?? null;
        const link = (r) => document.querySelector(`link[rel="${r}"]`);
        return {
            manifest: link('manifest')?.getAttribute('href') ?? null,
            touch: link('apple-touch-icon')?.getAttribute('href') ?? null,
            touchSizes: link('apple-touch-icon')?.getAttribute('sizes') ?? null,
            title: meta('apple-mobile-web-app-title'), capable: meta('apple-mobile-web-app-capable'),
            capableGeneric: meta('mobile-web-app-capable'), bar: meta('apple-mobile-web-app-status-bar-style'),
            theme: meta('theme-color'), viewport: meta('viewport'),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
    });
    check('manifest linked', head.manifest === '/manifest.json', JSON.stringify(head));
    check('apple-touch-icon is the 180x180 file', head.touch === '/apple-touch-icon.png' && head.touchSizes === '180x180');
    check('apple-mobile-web-app-capable, title, status-bar style', head.capable === 'yes' && head.title === 'Púca' && head.bar === 'black', JSON.stringify(head));
    check('mobile-web-app-capable and theme-color', head.capableGeneric === 'yes' && /^#[0-9a-f]{6}$/i.test(head.theme ?? ''));
    check('a Safari TAB gets no viewport-fit (control: the standalone case below does)', !/viewport-fit/.test(head.viewport ?? ''), head.viewport);
    check('no horizontal overflow at 390 px (clientWidth, not innerWidth)', head.overflow <= 0, String(head.overflow));
    await page.waitForSelector('#stay-signed-in', { timeout: 10000 }).catch(() => {});
    check('the sign-in form is there and "Stay signed in" is CLEAR in a Safari tab', await page.evaluate(() => document.querySelector('#stay-signed-in')?.checked === false));

    // The manifest and every icon, fetched and DECODED by WebKit.
    const m = await page.evaluate(async () => {
        const r = await fetch('/manifest.json');
        const json = await r.json();
        const icons = [];
        for (const icon of json.icons) {
            const res = await fetch(icon.src);
            const blob = await res.blob();
            const bmp = await createImageBitmap(blob);
            const c = document.createElement('canvas');
            c.width = bmp.width; c.height = bmp.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(bmp, 0, 0);
            const corner = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
            icons.push({
                src: icon.src, declared: icon.sizes, status: res.status, type: res.headers.get('content-type'),
                actual: `${bmp.width}x${bmp.height}`,
                opaque: [corner(0, 0), corner(bmp.width - 1, 0), corner(0, bmp.height - 1), corner(bmp.width - 1, bmp.height - 1), corner(bmp.width >> 1, bmp.height >> 1)].every((a) => a === 255),
            });
        }
        return { status: r.status, json, icons };
    });
    check('the manifest fetches and parses', m.status === 200 && m.json.name === 'Púca' && m.json.display === 'standalone' && m.json.start_url === '/');
    check('every manifest icon loads, decodes at its declared size, and is opaque',
        m.icons.length >= 4 && m.icons.every((i) => i.status === 200 && i.type === 'image/png' && i.actual === i.declared && i.opaque), JSON.stringify(m.icons));
    check('180, 192 and 512 px icons and a maskable one', ['180x180', '192x192', '512x512'].every((s) => m.icons.some((i) => i.declared === s)) && m.json.icons.some((i) => i.purpose === 'maskable'));

    // The phone bottom bar against a 34 px home-indicator inset. WebKit on
    // Windows reports env(safe-area-inset-bottom) as 0, so the variable the CSS
    // reads is set directly: what is under test is the bar's own geometry. The
    // bottom edge is measured against a 1 px element fixed at bottom:0 in the same
    // place (this WebKit's fixed boxes end a few px short of the window).
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse) and (max-width: 1024px)').matches);
    check('precondition: WebKit as an iPhone matches the phone layout rule (pointer: coarse)', coarse);
    const bar = async (extraCss, inset = '34px') => page.evaluate(([css, inset]) => {
        document.querySelectorAll('.zz-bar, .zz-css').forEach((n) => n.remove());
        document.documentElement.style.setProperty('--safe-area-bottom', inset);
        const style = document.createElement('style');
        style.className = 'zz-css';
        style.textContent = css;
        document.head.appendChild(style);
        const wrap = document.createElement('div');
        wrap.className = 'chat-container zz-bar';
        wrap.innerHTML = '<div class="zz-ref" style="position:fixed;left:0;bottom:0;width:1px;height:1px"></div>'
            + '<div class="file-transfers-tray" style="height:40px"></div><div class="device-downloads" style="height:40px"></div>'
            + '<nav class="mobile-bottom-nav">' + ['Servers', 'Channels', 'Chat', 'Members', 'Devices', 'Tasks']
            .map((l) => `<button class="mobile-nav-btn"><span class="nav-icon">o</span><span class="nav-label">${l}</span></button>`).join('') + '</nav>';
        document.body.appendChild(wrap);
        const nav = wrap.querySelector('.mobile-bottom-nav').getBoundingClientRect();
        const btns = [...wrap.querySelectorAll('.mobile-nav-btn')].map((b) => b.getBoundingClientRect());
        const labels = [...wrap.querySelectorAll('.nav-label')].map((b) => b.getBoundingClientRect());
        const tray = (sel) => Math.round(wrap.querySelector(sel).getBoundingClientRect().bottom);
        return { trayBottoms: [tray('.file-transfers-tray'), tray('.device-downloads')], h: Math.round(wrap.querySelector('.zz-ref').getBoundingClientRect().bottom), navTop: nav.top, navBottom: nav.bottom, navH: nav.height, btnBottoms: btns.map((b) => Math.round(b.bottom)), labelBottoms: labels.map((b) => Math.round(b.bottom)), btnH: Math.round(Math.min(...btns.map((b) => b.height))) };
    }, [extraCss, inset]);
    const good = await bar('');
    check('with a 34 px inset the bar is 94 px tall, flush to the bottom', Math.round(good.navH) === 94 && Math.round(good.navBottom) === good.h, JSON.stringify(good));
    // The LABELS, not the 63 px button boxes: those overflow the 59 px content box by
    // 2 px a side on every surface (pre-existing, the same with no inset at all).
    check('and no tab label (nor its icon above it) reaches into the home-indicator band', good.labelBottoms.every((b) => b <= good.h - 34), JSON.stringify(good));
    check('and every tab keeps at least a 44 px touch height', good.btnH >= 44, JSON.stringify(good));
    // The trays that sit above the bar (file transfers, device downloads) used to
    // hard-code bottom: 60px, which in a Home Screen app left the bar's top 34 px
    // under them, taking its taps.
    check('with the inset, the file-transfer and device-download trays end at or above the bar', good.trayBottoms.every((b) => b <= good.navTop + 1), JSON.stringify(good));
    await page.screenshot({ path: path.join(outDir, 'app-390x844-bottom-bar-inset-34.png') });
    const old = await bar('.mobile-bottom-nav { height: var(--mobile-nav-height) !important; }');
    // Where the inset is 0 (Android, desktop, a Safari tab) nothing moved: the bar is
    // the 60 px it always was, and the trays sit on it as they always did.
    const flat = await bar('', '0px');
    check('with NO inset the bar is 60 px and the trays still end at the bar (nothing changed there)', Math.round(flat.navH) === 60 && flat.trayBottoms.every((b) => Math.abs(b - (flat.h - 60)) <= 1), JSON.stringify(flat));
    const oldTray = await bar('.file-transfers-tray, .device-downloads { bottom: 60px !important; }');
    check('CONTROL: the old bottom: 60px trays FAIL the tray check (they overlap the bar)', !oldTray.trayBottoms.every((b) => b <= oldTray.navTop + 1), JSON.stringify(oldTray));
    check('CONTROL: the old fixed 60 px bar FAILS that check (labels spill into the band)', !old.labelBottoms.every((b) => b <= old.h - 34), JSON.stringify(old));
    await context.close();
}

console.log('\n--- the web app, as a Home Screen app (navigator.standalone faked) ---');
{
    const standalone = () => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });
    const { context, page } = await open(app.url, iphone, { init: standalone });
    await page.waitForFunction(() => document.documentElement.dataset.iosStandalone === 'true', null, { timeout: 20000 }).catch(() => {});
    await page.waitForSelector('#stay-signed-in', { timeout: 10000 }).catch(() => {});
    check('"Stay signed in" starts TICKED in a Home Screen app (the page promises "sign in once")', await page.evaluate(() => document.querySelector('#stay-signed-in')?.checked === true));
    check('the module saw standalone', await page.evaluate(() => document.documentElement.dataset.iosStandalone) === 'true');
    check('portrait: viewport-fit=cover is on, the other keys kept', /width=device-width/.test(await viewportContent(page)) && /viewport-fit=cover/.test(await viewportContent(page)), String(await viewportContent(page)));
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => !/viewport-fit/.test(document.querySelector('meta[name="viewport"]').content), null, { timeout: 5000 }).catch(() => {});
    check('landscape (a REAL orientation media query changing): viewport-fit is off again', !/viewport-fit/.test(await viewportContent(page)), String(await viewportContent(page)));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => /viewport-fit=cover/.test(document.querySelector('meta[name="viewport"]').content), null, { timeout: 5000 }).catch(() => {});
    check('back to portrait: cover is back', /viewport-fit=cover/.test(await viewportContent(page)), String(await viewportContent(page)));
    await page.screenshot({ path: path.join(outDir, 'app-390x844-standalone.png') });
    // A 13-inch iPad in portrait is 1032 px wide: the DESKTOP layout, which pads
    // for no inset, so cover there put its composer under the home indicator.
    await page.setViewportSize({ width: 1032, height: 1376 });
    await page.waitForFunction(() => !/viewport-fit/.test(document.querySelector('meta[name="viewport"]').content), null, { timeout: 5000 }).catch(() => {});
    check('a 13-inch iPad in portrait (1032 px, the desktop layout): no cover', !/viewport-fit/.test(await viewportContent(page)), String(await viewportContent(page)));
    // CONTROL: an 11-inch iPad in portrait (834 px) is in the phone layout, and
    // gets cover back — so the check above is the width, not a stuck listener.
    await page.setViewportSize({ width: 834, height: 1194 });
    await page.waitForFunction(() => /viewport-fit=cover/.test(document.querySelector('meta[name="viewport"]').content), null, { timeout: 5000 }).catch(() => {});
    check('CONTROL: an 11-inch iPad in portrait (834 px, the phone layout) gets cover', /viewport-fit=cover/.test(await viewportContent(page)), String(await viewportContent(page)));
    await page.setViewportSize({ width: 390, height: 844 });
    await context.close();
}

// ====================================================== 2. the download page ===
const sectionState = (page) => page.evaluate(() => {
    const sec = document.getElementById('iphone');
    const r = sec.getBoundingClientRect();
    const qr = sec.querySelector('.qr');
    const qrBox = qr.querySelector('svg')?.getBoundingClientRect();
    const vis = (el) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    return {
        prev: sec.previousElementSibling?.className ?? null, next: sec.nextElementSibling?.className ?? null,
        first: sec.classList.contains('first'), top: Math.round(r.top), sectionVisible: vis(sec),
        qrVisible: vis(qr) && !!qrBox && qrBox.width > 100, qrW: qrBox ? Math.round(qrBox.width) : 0,
        steps: [...sec.querySelectorAll('.iphone-steps li')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()),
        openHref: [...sec.querySelectorAll('a.btn')].map((a) => a.getAttribute('href')),
        stepHrefs: [...sec.querySelectorAll('a')].map((a) => a.getAttribute('href')),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tab: document.querySelector('.variant-btn.active')?.id, fullShown: document.querySelector('[data-variant-panel="full"].shown') !== null && vis(document.querySelector('[data-variant-panel="full"]')),
        liteShown: vis(document.querySelector('[data-variant-panel="lite"]')),
        order: [...document.querySelectorAll('.card > *')].map((n) => n.id || n.className).filter(Boolean),
    };
});

console.log('\n--- the download page on an iPhone ---');
{
    const { context, page, seen } = await open(site.url, iphone);
    const s = await sectionState(page);
    check('the iPhone & iPad section comes first, directly under the tagline', s.prev === 'tag' && s.next === 'variant-picker' && s.first, JSON.stringify(s.order));
    check('it is on screen above the fold at 390x844', s.sectionVisible && s.top < 300, `top ${s.top}`);
    check('the four steps are there, in order', s.steps.length === 4 && /Safari/.test(s.steps[0]) && /Share/.test(s.steps[1]) && /Add to Home Screen/.test(s.steps[2]) && /Add\b/.test(s.steps[3]), JSON.stringify(s.steps));
    check('Open Púca and the address link both point at the web app host', s.openHref.length === 1 && s.openHref[0] === `https://${APP_HOST}` && s.stepHrefs.every((h) => h === `https://${APP_HOST}`), JSON.stringify(s));
    check('the QR code is hidden for a visitor already on a phone', !s.qrVisible, JSON.stringify(s));
    check('no horizontal overflow at 390 px', s.overflow <= 0, String(s.overflow));
    check('the full build tab is still the default', s.tab === 'tab-full' && s.fullShown && !s.liteShown);
    check('nothing is requested from anywhere but the page itself', seen.every((u) => u.startsWith(site.url)), seen.filter((u) => !u.startsWith(site.url)).join(' '));
    await page.screenshot({ path: path.join(outDir, 'download-390x844-iphone.png') });
    await page.screenshot({ path: path.join(outDir, 'download-390x844-iphone-full.png'), fullPage: true });
    await context.close();
}
{
    const { context, page } = await open(`${site.url}/?variant=lite`, iphone);
    const s = await sectionState(page);
    check('?variant=lite on an iPhone: section still first AND the Lite tab and panel shown', s.first && s.prev === 'tag' && s.tab === 'tab-lite' && s.liteShown && !s.fullShown, JSON.stringify(s));
    await context.close();
}
{
    // This WebKit does not emulate navigator.maxTouchPoints, which a real iPadOS
    // Safari reports as 5; the init script supplies it, so this proves the
    // script's logic and not Safari's value.
    const { context, page } = await open(site.url, { ...devices['iPad Pro 11'], userAgent: DESKTOP_UA.replace('Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 10_15_7') },
        { init: () => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true }) });
    const s = await sectionState(page);
    check('an iPad that asks for desktop sites (Macintosh + touch) also gets it first', s.first && s.prev === 'tag', JSON.stringify(s.order));
    await context.close();
}
{
    // CONTROL: a Mac (Macintosh, no touch screen) must NOT be treated as an iPad.
    const { context, page } = await open(site.url, { viewport: { width: 1280, height: 800 }, userAgent: DESKTOP_UA.replace('Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 10_15_7') },
        { init: () => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 0, configurable: true }) });
    check('CONTROL: a Mac without a touch screen is not moved', !(await sectionState(page)).first);
    await context.close();
}

console.log('\n--- the download page on a computer, and with JavaScript off ---');
{
    const { context, page } = await open(site.url, { viewport: { width: 1280, height: 800 }, userAgent: DESKTOP_UA });
    const s = await sectionState(page);
    check('a desktop visitor: section in place (after the build tabs and panels, before Notes), not boxed first', !s.first && s.order.indexOf('iphone') > s.order.indexOf('variant-picker') && s.order[s.order.indexOf('iphone') + 1] === 'notes-app', JSON.stringify(s.order));
    check('the QR code is shown, 168 px, for scanning with a phone', s.qrVisible && s.qrW === 168, JSON.stringify(s));
    await page.screenshot({ path: path.join(outDir, 'download-1280x800-desktop.png') });
    await context.close();
}
{
    const { context, page } = await open(site.url, { viewport: { width: 1280, height: 800 }, userAgent: DESKTOP_UA, javaScriptEnabled: false });
    const s = await sectionState(page);
    check('JavaScript OFF: the section, its steps and the QR code are all there', s.sectionVisible && s.steps.length === 4 && s.qrVisible, JSON.stringify(s));
    check('JavaScript OFF: the downloads are still offered (the full panel is pre-selected)', s.fullShown && !s.liteShown && s.tab === 'tab-full', JSON.stringify(s));
    await context.close();
}
{
    const { context, page } = await open(site.url, { ...iphone, javaScriptEnabled: false });
    const s = await sectionState(page);
    check('JavaScript OFF on an iPhone: the section is in place and usable, QR shown', s.sectionVisible && s.steps.length === 4 && s.qrVisible && !s.first, JSON.stringify(s));
    await context.close();
}

await browser.close();
app.s.close();
site.s.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fails ? `${fails} check(s) FAILED` : 'all checks passed'}. Screenshots in ${outDir}`);
process.exit(fails ? 1 : 0);
