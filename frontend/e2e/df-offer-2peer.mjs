// The settled-DeepFilter offer in a real call, on a phone-sized panel.
//
// When DeepFilter falls behind for good, the call settles on its RNNoise
// bridge and the voice panel offers "Try DeepFilter again" (useDfSettledOffer).
// The settle itself is pinned by unit tests (dfOverloadWiring, dfCore); a real
// CPU starvation cannot be staged in headless Chromium, so this raises the
// settle EVENT in a live call and checks what the member sees and can do:
//
//   - the offer renders in the collapsed phone bar (390x844, touch) on a row of
//     its own, inside the viewport, with thumb-sized buttons;
//   - "Try DeepFilter again" rebuilds DeepFilter (the offer clears when the new
//     graph goes live) and the other peer keeps receiving audio throughout;
//   - "Keep RNNoise" just dismisses it, rebuilding nothing.
//
// MUTED (--mute-audio): Chromium's fake mic plays a tone and the other peer
// would play it out loud. Needs a throwaway backend + Postgres + vite:
//   APP=http://localhost:5173  PGPORT=5432  PGDB=puca  node e2e/df-offer-2peer.mjs
// (psql as postgres/postgres, as the other live suites assume.)
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP || 'http://localhost:5173';
const PGPORT = process.env.PGPORT || '5432';
const PGDB = process.env.PGDB || 'puca';
// Under the gitignored e2e-artifacts/, like every other harness's evidence:
// a screenshot directory that is not ignored gets swept into the repo by the
// next `git add -A` (it happened once, during the 0.9.810 ship).
const SHOTS = process.env.SHOTS || 'e2e-artifacts/df-offer';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const AUSER = 'dfoffer_a_' + stamp;
const BUSER = 'dfoffer_b_' + stamp;

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) failures++;
};
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-p', PGPORT, '-d', PGDB, '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
        '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

async function register(ctx, user) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`  [${user} exception]`, String(e).slice(0, 160)));
    await page.goto(`${APP}/login`);
    await page.waitForSelector('#username', { timeout: 15000 });
    await page.click('.toggle-mode', { timeout: 5000 });
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 30000 });
    await page.waitForTimeout(1200);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* older flow */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    return page;
}

async function createServer(page, name) {
    await page.locator('.server-icon.add-server').click({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.locator('.template-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.audience-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill(name);
    await page.locator('.wizard-actions .create-btn').click();
    await page.waitForTimeout(2500);
}

async function joinVoice(page) {
    await page.reload();
    await page.waitForTimeout(1800);
    await page.evaluate(() => {
        const icons = [...document.querySelectorAll('.server-icon')];
        const target = icons.find(i => !/direct message|add server|join server|notes|tasks/i.test(
            (i.getAttribute('title') || '') + ' ' + (i.className || '')));
        target?.click();
    });
    await page.waitForTimeout(1500);
    const joined = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.voice-channel-list .voice-channel')];
        const el = items.find(n => !n.classList.contains('afk'));
        if (el) { el.click(); return true; }
        return false;
    });
    await page.waitForTimeout(3000);
    return joined;
}

const remoteAudioLive = (page) => page.evaluate(() => {
    for (const el of document.querySelectorAll('audio[id^="audio-"]')) {
        const t = el.srcObject?.getAudioTracks?.()[0];
        if (t) return t.readyState === 'live';
    }
    return false;
});

async function setNsMode(page, mode) {
    return page.evaluate((m) => {
        const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === m));
        if (!sel) return false;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, m);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }, mode);
}

/** The running DeepFilter graph's emitted-sample count from its latest ~2 s
 *  stats report (null: no DeepFilter graph, or none reported yet). */
const dfEmitted = (page) => page.evaluate(async () => {
    const d = await window.__pucaVoiceDiag?.();
    return d?.noise?.mode === 'deepfilter' ? (d?.noise?.deepFilter?.worklet?.emittedSamples ?? null) : null;
});
/** Poll until `probe` yields a non-null value (or the deadline passes). */
async function until(page, probe, ms = 15000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await probe();
        if (v !== null || Date.now() > end) return v;
        await page.waitForTimeout(250);
    }
}

const offer = (page) => page.evaluate(() => {
    const el = [...document.querySelectorAll('.voice-load-offer')].find(n => /DeepFilter/.test(n.textContent || ''));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const buttons = [...el.querySelectorAll('button')].map(b => {
        const br = b.getBoundingClientRect();
        return { text: b.textContent?.trim(), h: Math.round(br.height), right: Math.round(br.right) };
    });
    const bar = el.closest('.voice-panel-compact');
    return {
        text: el.querySelector('span')?.textContent || '', left: Math.round(r.left), right: Math.round(r.right),
        width: Math.round(r.width), visible: r.width > 0 && r.height > 0, buttons,
        collapsed: !!bar?.classList.contains('vp-collapsed'), barWidth: Math.round(bar?.getBoundingClientRect().width ?? 0),
        // clientWidth, never innerWidth: on the isMobile phone a page wider
        // than the screen WIDENS innerWidth to fit it, and the checks below
        // would compare the page with itself.
        vw: document.documentElement.clientWidth, scrollW: document.documentElement.scrollWidth,
    };
});

const settle = (page, reason) => page.evaluate((r) => {
    window.dispatchEvent(new CustomEvent('sovereign:df-settled', { detail: { reason: r } }));
}, reason);

try {
    mkdirSync(SHOTS, { recursive: true });
    console.log('== setup ==', APP);
    const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
    const ctxA = await browser.newContext({ ...phone, permissions: ['microphone', 'camera'] });
    const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const a = await register(ctxA, AUSER);
    const b = await register(ctxB, BUSER);
    // B (desktop) creates the server: on the phone layout the server rail is a
    // drawer off-screen. A joins it through the database, as the other live
    // suites do.
    await createServer(b, 'DF Offer ' + stamp);
    const serverId = psql(`SELECT id FROM servers WHERE name = 'DF Offer ${stamp}'`);
    const aId = psql(`SELECT id FROM users WHERE username = '${AUSER}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${aId})`);

    check('A (phone) joins voice', await joinVoice(a));
    check('B joins voice', await joinVoice(b));
    await b.waitForTimeout(4000);
    check('B receives A audio', await remoteAudioLive(b));

    console.log('== A onto DeepFilter ==');
    await a.evaluate(() => {
        const KEY = 'sovereign_settings';
        const s = JSON.parse(localStorage.getItem(KEY) || '{}');
        s.experimentalDeepFilter = true;
        localStorage.setItem(KEY, JSON.stringify(s));
        window.dispatchEvent(new Event('settingsChanged'));
    });
    await a.waitForTimeout(500);
    check('DeepFilter picked', await setNsMode(a, 'deepfilter'));
    await a.waitForTimeout(12000); // wasm + tract build + RNNoise bridge + swap
    const e0 = await until(a, () => dfEmitted(a));
    check('DeepFilter graph live', e0 !== null, `emitted=${e0}`);

    console.log('== settled: the offer on the phone bar ==');
    await settle(a, 'sustained');
    await a.waitForTimeout(400);
    const o = await offer(a);
    check('offer shown with the settle sentence', !!o && o.visible && /couldn.t keep up/.test(o.text), o ? o.text : 'none');
    if (o) {
        console.log('  offer:', JSON.stringify(o));
        check('panel is the collapsed phone bar', o.collapsed);
        check('offer is a full-width row of its own', o.width >= o.barWidth - 40, `offer ${o.width}px of bar ${o.barWidth}px`);
        check('offer inside the viewport, no horizontal scroll', o.left >= 0 && o.right <= o.vw && o.scrollW <= o.vw, `right ${o.right} vw ${o.vw} scrollW ${o.scrollW}`);
        check('both buttons present and thumb-sized (>= 30 px)', o.buttons.length === 2 && o.buttons.every(x => x.h >= 30 && x.right <= o.vw),
            JSON.stringify(o.buttons));
    }
    await a.screenshot({ path: `${SHOTS}/df-offer-phone.png` });

    console.log('== Keep RNNoise: dismiss, no rebuild ==');
    const before = await dfEmitted(a);
    await a.locator('.voice-load-offer button', { hasText: 'Keep RNNoise' }).tap();
    await a.waitForTimeout(600);
    check('Keep RNNoise dismisses the offer', (await offer(a)) === null);
    await a.waitForTimeout(2500); // one more stats report from the same graph
    const after = await dfEmitted(a);
    check('...and rebuilt nothing (same graph still counting)', before !== null && after !== null && after > before, `${before} -> ${after}`);

    console.log('== Try DeepFilter again: a fresh graph ==');
    await settle(a, 'repeated');
    await a.waitForTimeout(400);
    const o2 = await offer(a);
    check('repeated-reason sentence', !!o2 && /kept falling behind/.test(o2.text), o2 ? o2.text : 'none');
    const beforeRetry = await dfEmitted(a);
    // The button clears the offer itself, so its disappearing proves nothing
    // about a rebuild. The evidence is the event noiseFilter fires when a new
    // DeepFilter graph goes live, and that graph's counters starting again.
    await a.evaluate(() => {
        window.__dfGraphLive = 0;
        window.addEventListener('sovereign:df-graph-live', () => { window.__dfGraphLive++; });
    });
    await a.locator('.voice-load-offer button', { hasText: 'Try DeepFilter again' }).tap();
    check('the tap clears the offer', (await offer(a)) === null);
    const live = await until(a, () => a.evaluate(() => (window.__dfGraphLive > 0 ? window.__dfGraphLive : null)), 20000);
    check('a new DeepFilter graph went live (df-graph-live)', live === 1, `events=${live}`);
    const fresh = await until(a, async () => {
        const v = await dfEmitted(a);
        return v !== null && v < beforeRetry ? v : null;
    }, 20000);
    // A NEW graph restarts its counters: fewer samples than the old one had.
    check('a fresh DeepFilter graph is running', fresh !== null && beforeRetry !== null && fresh < beforeRetry, `${beforeRetry} -> ${fresh}`);
    check('B still receives A audio after the rebuild', await remoteAudioLive(b));
    await a.screenshot({ path: `${SHOTS}/df-offer-after-retry-phone.png` });
} catch (e) {
    console.log('FAIL  harness error:', e?.message || e);
    failures++;
} finally {
    await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
