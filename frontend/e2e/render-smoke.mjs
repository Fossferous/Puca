// DOES THE APP STILL RENDER? The cheapest check that this release's diff did
// not blank the whole application.
//
// WHY IT IS WORTH RUNNING even though every unit gate is green: this change
// touched VoicePanel, ScreenShareModal and SettingsModal, and the failure mode
// those three share is not a wrong value — it is React #310 from a hook below
// an early return, which the root ErrorBoundary turns into a crash screen
// replacing the ENTIRE app for every user on every platform. That shipped once
// here (v0.7.7) past typecheck, vitest and build. `npm run lint` catches the
// rule; this catches the symptom, including the ways lint cannot see.
//
// POINT IT AT AN ORIGIN THAT CANNOT BE THE WRONG TREE. Both checkouts on this
// machine define a `frontend-dev` launch config on port 5173, so a dev server
// started from the wrong project root answers on the expected port with a
// DIFFERENT tree — and nothing says so. This rig reported green exactly that
// way once, against a checkout containing none of the release under test.
//
//   APP=https://app.svrn.lol node e2e/render-smoke.mjs      # the deployed app
//   node e2e/serve-dist.mjs                                 # prints a URL
//   APP=http://127.0.0.1:<that port> node e2e/render-smoke.mjs
//
// The second form serves frontend/dist by explicit path, so the bundle under
// test is the one that ships. Note it trips CORS on the production API — the
// built bundle asks chat.svrn.lol for its ICE config from an origin that host
// does not allow — which is the harness, not the app. The deployed origin has
// no such problem, so reach for that one first.
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'https://app.svrn.lol';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => pageErrors.push(String(e)));

let failed = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok) failed++;
};

await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

const text = await page.evaluate(() => document.body.innerText || '');
const html = await page.evaluate(() => document.body.innerHTML || '');

// The ErrorBoundary's crash screen. Matched on its own words rather than on
// "error" anywhere, so an unrelated console message cannot fake a pass or a
// failure.
const crashed = /something went wrong|unexpected error|reload the app/i.test(text);
check('the root ErrorBoundary did NOT replace the app', !crashed,
    crashed ? text.slice(0, 200).replace(/\s+/g, ' ') : '');

// React #310 / #300 are the minified invariant numbers for hook-order breaks.
const reactInvariant = [...consoleErrors, ...pageErrors].filter(e => /Minified React error #3\d\d|Rendered more hooks|Rendered fewer hooks|change in the order of Hooks/i.test(e));
check('no React hook-order invariant', reactInvariant.length === 0, reactInvariant[0] || '');

check('something actually rendered', html.length > 500, `body html ${html.length} bytes`);

// POSITIVE CONTROL for the two checks above: if the page never mounted at all,
// "no crash screen" and "no hook error" would both pass vacuously. The login
// form is the thing this route is supposed to show.
const hasLoginUi = await page.evaluate(() =>
    !!document.querySelector('input[type="password"], input[name="password"], form'));
check('the login UI is present (control: proves the page mounted)', hasLoginUi);

const otherErrors = [...pageErrors, ...consoleErrors].filter(e =>
    !/favicon|manifest|404|Failed to load resource|net::ERR|WebSocket|ResizeObserver/i.test(e));
check('no unexpected console/page errors', otherErrors.length === 0,
    otherErrors.slice(0, 3).join(' | ').slice(0, 300));

console.log(`\n${failed === 0 ? 'ALL RENDER CHECKS PASSED' : failed + ' CHECK(S) FAILED'}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
