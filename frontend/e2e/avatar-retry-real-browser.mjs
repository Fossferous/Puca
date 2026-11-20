// A profile picture (or server icon, or emoji) whose GET /files/<id> failed
// ONCE comes back by itself, in a real browser: the real SmartAvatar and
// AuthedImg over the real hooks/useAuthedFileUrl.ts and api/authedMedia.ts,
// against a stand-in /files on loopback that answers as the server does.
//
// WHY THIS EXISTS. Field report 2026-11-19: a member's desktop app drew the
// owner's and another member's pictures as initials while the owner saw both
// and the server served them. A single failed fetch (a 503 from the server's
// per-address download ceiling, src/upload_handlers.rs get_file, with
// `Retry-After: 2`; a 429; a dropped connection) resolved null for the whole
// session, because the hook asked again only for a new file id and a member
// row keeps its id. vitest (authedMediaRetry.test.ts, authedFileUrlRecovery
// .test.tsx) pins the schedule on fake timers under jsdom, which decodes no
// picture, has no network to lose and fires no real `online`. Checked here:
//
//   1. a 503 with Retry-After: 2 and then a 200: the picture DECODES in the
//      same mounted avatar (and in an AuthedImg), the second request no sooner
//      than 2 s after the first, two requests in all;
//   2. a 404 is one request and stays initials;
//   3. a page that asks for 30 pictures at once has at most SIX fetches out
//      at a time, counted in the page's own fetch (and six: the cap binds) and
//      at the server, and all 30 decode. The page's count is the one that
//      matters: on this rig's HTTP/1.1 the browser itself holds a host to six
//      connections, behind production's HTTP/2 CDN nothing does;
//   4. the network really down (Playwright's offline emulation: every attempt
//      a real network error that never reaches the server), the page's own
//      clock run through the backoff until the job gives up and writes its
//      `[media-diag] picture gave up` line, then the network back: the
//      browser's own `online` event, and the avatar asks once and decodes;
//   5. NEGATIVE CONTROL: the same through the modules as they were at 0.9.865
//      (src/tests/fixtures/authedMediaAt865.ts, useAuthedFileUrlAt865.ts) must
//      FAIL check 1 (one request, initials after 5 s) and puts all thirty
//      fetches out at once in check 3.
//
//   cd frontend && node e2e/avatar-retry-real-browser.mjs
//
// No server and no build needed; silent (--mute-audio, nothing here plays).
// CHANNEL=msedge (default) or CHANNEL=bundled. ~30 s.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
// A real 1x1 PNG: the browser must decode it, not merely be handed a URL.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// ---- the page --------------------------------------------------------------
const entry = `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SmartAvatar } from './components/SmartAvatar';
import { AuthedImg } from './components/AuthedImg';

const root = createRoot(document.getElementById('root'));
window.__rig = {
    /** Rows as the member list draws them: one per file id, kept mounted. */
    show(rows) {
        flushSync(() => root.render(
            <div>
                {rows.map((r) => (
                    <div key={r.fileId} data-row={r.fileId}>
                        {r.kind === 'img'
                            ? <AuthedImg fileId={r.fileId} alt="" width={32} height={32} />
                            : <SmartAvatar userId={r.userId} fileId={r.fileId} className="rig-av" fallback={<span className="initials">MI</span>} />}
                    </div>
                ))}
            </div>,
        ));
    },
    /** What a row shows: initials, or a picture the engine decoded. */
    state(fileId) {
        const row = document.querySelector('[data-row="' + fileId + '"]');
        if (!row) return { missing: true };
        const img = row.querySelector('img');
        return {
            initials: !!row.querySelector('.initials'),
            dataUrl: !!img && img.getAttribute('src').startsWith('data:image/png;base64,'),
            decoded: !!img && img.complete && img.naturalWidth > 0,
            canvas: !!row.querySelector('canvas'),
        };
    },
};
`;

// ---- the stand-in /files ------------------------------------------------------
/** Request times per file id (ms since the server started). */
const seen = new Map();
let out = 0;
let mostOut = 0;
const t0 = Date.now();
const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const send = (code, headers, body, delay = 0) => {
        setTimeout(() => { out--; res.writeHead(code, { 'cache-control': 'no-store', ...headers }); res.end(body); }, delay);
    };
    if (url === '/new.js' || url === '/old.js') {
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        return res.end(url === '/new.js' ? bundles.new : bundles.old);
    }
    const page = /^\/(new|old)$/.exec(url);
    if (page) {
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>avatar retry rig</title></head><body><div id="root"></div><script src="/${page[1]}.js"></script></body></html>`);
    }
    const file = /^\/files\/([\w-]+)$/.exec(url);
    if (!file) { res.writeHead(404); return res.end(); }
    const id = file[1];
    const times = seen.get(id) ?? [];
    times.push(Date.now() - t0);
    seen.set(id, times);
    out++;
    mostOut = Math.max(mostOut, out);
    if (req.headers.authorization !== 'Bearer rig-token') return send(401, {}, 'Unauthorized');
    const png = (delay) => send(200, { 'content-type': 'image/png', 'content-length': PNG.length }, PNG, delay);
    // As get_file answers a caller past the per-address ceiling.
    if (id.includes('once503') && times.length === 1) return send(503, { 'retry-after': '2' }, 'Too many concurrent downloads');
    if (id.includes('gone')) return send(404, {}, 'File not found');
    if (id.includes('slow')) return png(250);
    return png(0);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const requests = (id) => (seen.get(id) ?? []).length;

// ---- the two bundles ----------------------------------------------------------
const stubs = {
    name: 'url-stub',
    setup(b) {
        b.onResolve({ filter: /\?(url|worker)$/ }, (a) => ({ path: a.path, namespace: 'url-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'url-stub' }, (a) => ({ contents: a.path.endsWith('?worker') ? 'export default class W {}' : 'export default ""', loader: 'js' }));
    },
};
/** The negative control: SmartAvatar and AuthedImg over the 0.9.865 hook and media module. */
let redirected = 0;
const at865 = {
    name: 'at-865',
    setup(b) {
        b.onResolve({ filter: /\/hooks\/useAuthedFileUrl$/ }, () => { redirected++; return { path: path.join(src, 'tests', 'fixtures', 'useAuthedFileUrlAt865.ts') }; });
    },
};
const bundle = async (old) => build({
    stdin: { contents: entry, resolveDir: src, loader: 'tsx', sourcefile: 'entry.tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.svg': 'empty', '.png': 'empty', '.mp3': 'empty', '.ogg': 'empty', '.wasm': 'empty', '.css': 'empty' },
    define: {
        'process.env.NODE_ENV': '"production"',
        __RC_ENABLED__: 'true',
        __APP_VERSION__: '"0.0.0-rig"',
        'import.meta.env': JSON.stringify({ VITE_API_URL: origin, DEV: false, PROD: true, MODE: 'production' }),
    },
    plugins: old ? [stubs, at865] : [stubs], logOverride: { 'empty-import-meta': 'silent' }, logLevel: 'error',
});
const [newBuild, oldBuild] = await Promise.all([bundle(false), bundle(true)]);
const bundles = { new: newBuild.outputFiles[0].text, old: oldBuild.outputFiles[0].text };
if (!bundles.new.includes('[media-diag]') || !bundles.new.includes('wsConnected')) throw new Error('rig: the change is not in the bundle under test');
if (redirected < 2 || bundles.old.includes('[media-diag]')) throw new Error('rig: the negative control still has the change in it');
if (!fs.existsSync(path.join(src, 'tests', 'fixtures', 'authedMediaAt865.ts'))) throw new Error('rig: the 0.9.865 fixture is missing');

// ---- checks ------------------------------------------------------------------
let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};
const CHANNEL = process.env.CHANNEL || 'msedge';
// Edge 157 upgrades http:// navigations to https:// by default; this rig is http on loopback.
const NO_HTTPS_FIRST = '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForTypicallySecureUsers,'
    + 'HttpsFirstModeIncognito,HttpsFirstBalancedMode,HttpsFirstModeV2ForEngagedSites,HttpsFirstModeForAdvancedProtectionUsers';
const browser = await chromium.launch({ headless: true, ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }), args: ['--mute-audio', NO_HTTPS_FIRST] });
console.log(`engine: ${CHANNEL} ${browser.version()}`);

async function open(which, { clock = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await ctx.newPage();
    const lines = [];
    page.on('console', (m) => { if (m.text().startsWith('[media-diag]')) lines.push(m.text()); });
    page.on('pageerror', (e) => { fail++; console.log(`FAIL [${which}] page error`, e.message); });
    await page.addInitScript(() => {
        localStorage.setItem('auth_token', 'rig-token');
        // How many GET /files the PAGE has out at once, whatever the browser then queues.
        const real = window.fetch.bind(window);
        let now = 0;
        window.__mostOut = 0;
        window.__asked = 0;   // every GET /files the page made, reached the server or not
        window.fetch = async (input, init) => {
            const isFile = String(input).includes('/files/');
            if (isFile) { window.__asked++; now++; window.__mostOut = Math.max(window.__mostOut, now); }
            try { return await real(input, init); } finally { if (isFile) now--; }
        };
    });
    if (clock) await page.clock.install();
    await page.goto(`${origin}/${which}`);
    await page.waitForFunction(() => !!window.__rig);
    return { ctx, page, lines };
}
const state = (page, id) => page.evaluate((i) => window.__rig.state(i), id);
const pictured = async (page, id) => { const s = await state(page, id); return s.decoded && s.dataUrl && !s.initials; };
async function waitPictured(page, id, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await pictured(page, id)) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return pictured(page, id);
}

try {
    // 1 + 2: one 503, and a 404 beside it.
    {
        const { ctx, page } = await open('new');
        await page.evaluate(() => window.__rig.show([
            { fileId: 'new-once503-avatar', userId: 1 },
            { fileId: 'new-once503-icon', kind: 'img' },
            { fileId: 'new-gone-avatar', userId: 2 },
        ]));
        await page.waitForTimeout(300);
        ck((await state(page, 'new-once503-avatar')).initials, '1. after the 503 the avatar shows its initials while it waits');
        const avatarBack = await waitPictured(page, 'new-once503-avatar', 6000);
        const iconBack = await waitPictured(page, 'new-once503-icon', 3000);
        const [a1, a2] = seen.get('new-once503-avatar') ?? [];
        ck(avatarBack, '1. the 503 then 200: the SAME mounted avatar decodes its picture', JSON.stringify(await state(page, 'new-once503-avatar')));
        ck((await state(page, 'new-once503-avatar')).canvas, '1. ...and SmartAvatar drew its frozen frame from it');
        ck(iconBack, '1. ...and so does an AuthedImg (emoji, server icons)');
        ck(requests('new-once503-avatar') === 2 && requests('new-once503-icon') === 2, '1. two requests each', `${requests('new-once503-avatar')}, ${requests('new-once503-icon')}`);
        ck(a2 - a1 >= 1900, '1. the second no sooner than Retry-After: 2 asked', `${a2 - a1} ms`);
        await page.waitForTimeout(3000);
        const gone = await state(page, 'new-gone-avatar');
        ck(requests('new-gone-avatar') === 1 && gone.initials && !gone.dataUrl, '2. a 404 is one request and stays initials', `${requests('new-gone-avatar')} request(s)`);
        await ctx.close();
    }

    // 3: thirty at once.
    const burst = async (which) => {
        const { ctx, page } = await open(which);
        out = 0; mostOut = 0;
        const ids = Array.from({ length: 30 }, (_, i) => `${which}-slow-${i}`);
        await page.evaluate((list) => window.__rig.show(list.map((fileId, i) => ({ fileId, userId: i + 10 }))), ids);
        const until = Date.now() + 15_000;
        let done = 0;
        while (Date.now() < until) {
            done = (await Promise.all(ids.map((id) => pictured(page, id)))).filter(Boolean).length;
            if (done === ids.length) break;
            await new Promise((r) => setTimeout(r, 150));
        }
        const pageMost = await page.evaluate(() => window.__mostOut);
        await ctx.close();
        return { done, most: mostOut, pageMost };
    };
    {
        const { done, most, pageMost } = await burst('new');
        ck(done === 30, '3. thirty pictures asked for at once all decode', `${done}/30`);
        ck(pageMost === 6, '3. the page has at most six fetches out at once, and the cap is what binds', `most at once: ${pageMost}`);
        // A consistency check only: on this rig's HTTP/1.1 the browser holds a host to six anyway.
        ck(most <= 6, '3. ...and the server never saw more than six at once (consistency: HTTP/1.1 here)', `most at once: ${most}`);
    }

    // 4: the network down through the whole schedule, then back.
    {
        const { ctx, page, lines } = await open('new', { clock: true });
        await ctx.setOffline(true);
        await page.evaluate(() => window.__rig.show([{ fileId: 'new-net-avatar', userId: 3 }]));
        // The page's clock walked through the schedule a second at a time (a
        // jump past a wait would count as time the job waited), each step
        // leaving the real network error time to arrive.
        let gaveUp = false;
        for (let i = 0; i < 150 && !gaveUp; i++) {
            await page.waitForTimeout(30);
            await page.clock.runFor(1000);
            gaveUp = lines.some((l) => l.includes('picture gave up'));
        }
        await page.waitForTimeout(200);
        const line = lines.find((l) => l.includes('picture gave up')) ?? '';
        ck(gaveUp && /last=network/.test(line) && /attempts=6/.test(line), '4. offline: the job gave up after six attempts and said so', line);
        ck(!/rig-token|\/files\/|new-net-avatar/.test(line), '4. ...naming no token, no URL and no whole file id');
        const asked = await page.evaluate(() => window.__asked);
        ck(asked === 6 && requests('new-net-avatar') === 0, '4. ...six fetches by the page, none of which reached the server (a real network error)', `${asked} asked`);
        ck((await state(page, 'new-net-avatar')).initials, '4. ...and the avatar shows initials meanwhile');
        for (let i = 0; i < 10; i++) { await page.clock.runFor(60_000); await page.waitForTimeout(30); }
        ck(await page.evaluate(() => window.__asked) === 6, '4. control: nothing asks by itself in the ten minutes after giving up');
        await ctx.setOffline(false);   // the browser fires `online`
        const back = await waitPictured(page, 'new-net-avatar', 5000);
        ck(back && requests('new-net-avatar') === 1, '4. back online: the browser\'s own `online` asks once and the picture decodes', `${requests('new-net-avatar')} request(s)`);
        await ctx.close();
    }

    // 5: the negative control.
    {
        const { ctx, page } = await open('old');
        await page.evaluate(() => window.__rig.show([{ fileId: 'old-once503-avatar', userId: 1 }]));
        const back = await waitPictured(page, 'old-once503-avatar', 5000);
        ck(!back && (await state(page, 'old-once503-avatar')).initials && requests('old-once503-avatar') === 1,
            '5. NEGATIVE CONTROL: at 0.9.865 the same 503 is initials after 5 s, one request (the field report)', `${requests('old-once503-avatar')} request(s)`);
        await ctx.close();
        const { pageMost } = await burst('old');
        ck(pageMost === 30, '5. NEGATIVE CONTROL: at 0.9.865 the page put all thirty fetches out at once', `most at once: ${pageMost}`);
    }
} finally {
    await browser.close();
    server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
