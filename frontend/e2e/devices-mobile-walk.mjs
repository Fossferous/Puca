// 390x844 coarse-pointer walk for the Devices view, driving
// e2e/devices-mobile.html headless and reading its `__devicesHarness()` report.
//
// What it proves (jsdom cannot — no box model): the view mounts at all (the
// harness sat dead for a long time importing a deleted component, and nothing
// noticed because nothing drove it), both tabs fit 390px with no horizontal
// overflow, every button is a 44px target, a device that fails verification is
// flagged rather than dropped, and no API call the view makes went unanswered
// by the fixtures. Screenshots land in the out dir — LOOK at them.
//
// The overflow check is given a POSITIVE CONTROL every run: a 460px element is
// put in the page and the report must call it overflow. Measured against
// window.innerWidth it would not — under isMobile a page wider than the screen
// widens innerWidth to fit (461 for a 460px element, clientWidth staying 390).
//
// Usage: node e2e/devices-mobile-walk.mjs [outdir] [baseURL]
//   baseURL defaults to http://localhost:5175 — start `npx vite --port 5175 --strictPort`
//   in frontend/ first (or point at whatever dev server is up).
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';

const outdir = process.argv[2] || 'e2e/shots-devices';
const baseURL = process.argv[3] || 'http://localhost:5175';
fs.mkdirSync(outdir, { recursive: true });

let fail = 0;
const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };

const browser = await chromium.launch({ args: ['--mute-audio'] });
const ctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined, baseURL });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

const shot = async (name) => { const f = `${outdir}/${name}.png`; await page.screenshot({ path: f, fullPage: true }); console.log('SHOT', f); };
const report = () => page.evaluate(() => window.__devicesHarness());
const overflowDetail = r => `widest=${r.widestElement} vw=${r.viewportWidth} bodyScrolls=${r.bodyScrollsHorizontally}`;

// ---- My devices ------------------------------------------------------------------
await page.goto('/e2e/devices-mobile.html');
const mounted = await page.waitForSelector('.devices-dashboard', { timeout: 15000 }).then(() => true, () => false);
ck('devices: the view mounts', mounted);
// The rows land after the list request and the machine fold; wait for all three.
await page.waitForFunction(() => document.querySelectorAll('.device-row').length === 3, null, { timeout: 10000 }).catch(() => {});
let r = mounted ? await report() : null;
await shot('01-devices-phone');
if (r) {
    ck('devices: the three fixture devices are listed', r.deviceRows === 3, String(r.deviceRows));
    ck('devices: a device that fails verification is flagged, not dropped', r.unverifiedFlagged);
    ck('devices: no horizontal overflow', !r.bodyScrollsHorizontally && r.widestElement <= r.viewportWidth, overflowDetail(r));
    ck('devices: every button ≥ 44 px tall', r.buttonsUnder44px.length === 0, JSON.stringify(r.buttonsUnder44px));

    // POSITIVE CONTROL for the overflow check above.
    await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'walk-wide-control';
        d.style.cssText = 'position:absolute;left:0;top:0;width:460px;height:1px;pointer-events:none';
        document.body.appendChild(d);
    });
    const wide = await report();
    ck('control: a 460px element IS reported as overflow', wide.bodyScrollsHorizontally && wide.widestElement > wide.viewportWidth, overflowDetail(wide));
    await page.evaluate(() => document.getElementById('walk-wide-control')?.remove());
    const back = await report();
    ck('control: …and removing it clears the report again', !back.bodyScrollsHorizontally && back.widestElement <= back.viewportWidth, overflowDetail(back));

    // ---- This device -------------------------------------------------------------
    await page.getByRole('tab', { name: 'This device' }).tap();
    await page.waitForTimeout(800);
    r = await report();
    await shot('02-this-device-phone');
    ck('this device: no horizontal overflow', !r.bodyScrollsHorizontally && r.widestElement <= r.viewportWidth, overflowDetail(r));
    ck('this device: every button ≥ 44 px tall', r.buttonsUnder44px.length === 0, JSON.stringify(r.buttonsUnder44px));
    // Last, so it covers both tabs: a request the fixtures do not answer means
    // the view grew a dependency this harness does not know about, and the
    // layout above was measured over an error state.
    ck('devices: every API call the view made was answered by a fixture', r.unstubbed.length === 0, JSON.stringify(r.unstubbed));
}

await browser.close();
console.log(`\n${fail ? 'FAILED' : 'OK'}: ${fail} failing check(s)`);
process.exit(fail ? 1 : 0);
