// 390x844 coarse-pointer walk for the Clips consent UI (docs/CLIPS.md), driving
// e2e/clips-mobile.html headless and reading its `__clipsHarness()` report.
//
// What it proves (jsdom cannot — no box model): no horizontal overflow, every
// tap target ≥ 44 px, the approval prompt's Decline is the BOTTOM-MOST action
// (thumb-nearest) and owns focus, the body copy is ≥ 16 px on a phone, the
// posted-clip plate renders its badge per stamp and refuses playback on a
// mismatch, a scrubbed ref never becomes a link, and the owner's settings block
// mounts at phone width. Screenshots land in the out dir — LOOK at them.
//
// Usage: node e2e/clips-mobile-walk.mjs [outdir] [baseURL]
//   baseURL defaults to http://localhost:5175 — start `npx vite --port 5175 --strictPort`
//   in frontend/ first (or point at whatever dev server is up).
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';

const outdir = process.argv[2] || 'e2e/shots-clips';
const baseURL = process.argv[3] || 'http://localhost:5175';
fs.mkdirSync(outdir, { recursive: true });

let fail = 0;
const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };

const browser = await chromium.launch();
const iphone = devices['iPhone 13'];
const ctx = await browser.newContext({ ...iphone, defaultBrowserType: undefined, baseURL });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

const shot = async (name) => { const f = `${outdir}/${name}.png`; await page.screenshot({ path: f, fullPage: true }); console.log('SHOT', f); };
const report = () => page.evaluate(() => window.__clipsHarness());

// ---- approval prompt -----------------------------------------------------------
await page.goto('/e2e/clips-mobile.html?view=prompt');
await page.waitForSelector('.clip-approval', { timeout: 15000 });
await page.waitForTimeout(600); // past the 400 ms hold-off so focus has landed
let r = await report();
await shot('01-prompt-phone');
ck('prompt: renders on the phone', r.promptShown);
ck('prompt: no horizontal overflow', !r.bodyScrollsHorizontally && r.widestElement <= r.viewportWidth, `widest=${r.widestElement} vw=${r.viewportWidth}`);
ck('prompt: every button ≥ 44 px', r.buttonsUnder44px.length === 0, JSON.stringify(r.buttonsUnder44px));
ck('prompt: Decline is below Approve and is the bottom-most action (thumb-nearest)', r.declineBelowApprove === true && r.declineIsBottomMost === true, JSON.stringify({ below: r.declineBelowApprove, bottom: r.declineIsBottomMost }));
ck('prompt: Decline is fully inside the viewport (no overflow past the bottom edge)', r.declineInsideViewport === true);
ck('prompt: Decline owns focus', r.activeIsDecline);
ck('prompt: body copy ≥ 16 px', typeof r.bodyFontPx === 'number' && r.bodyFontPx >= 16, `${r.bodyFontPx}px`);
ck('prompt: two requests ⇒ "1 of 2 requests" chip, oldest first', r.queueChip === '1 of 2 requests', String(r.queueChip));
const text = await page.locator('.clip-approval').innerText(); // VISIBLE text only (details collapsed)
ck('prompt: copy renders the server flags (camera + share, left the call)', /your voice, your camera, and the screen you were sharing/.test(text) && /You were in that call at the time/.test(text));
ck('prompt: visible copy says nothing was uploaded and the answer is final', /Nothing has been uploaded/.test(text) && /Your answer is final/.test(text));
// Escape must DECLINE, not dismiss: the harness records what the prompt sent.
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const votes = await page.evaluate(() => window.__votes || []);
ck('prompt: Escape sends approve:false', votes.length === 1 && votes[0].body && votes[0].body.approve === false, JSON.stringify(votes));
r = await report();
ck('prompt: after answering, the second request slides in', r.promptShown && r.queueChip === null);
await shot('02-prompt-phone-second');

// ---- posted clip in a message ---------------------------------------------------
await page.goto('/e2e/clips-mobile.html?view=clip');
await page.waitForSelector('.clip-attachment', { timeout: 15000 });
await page.waitForTimeout(300);
r = await report();
await shot('03-clip-attachment-phone');
ck('clip: five plates rendered (approved / solo / no stamp / mismatch / scrubbed→text)', r.clipPlates === 4, `plates=${r.clipPlates}`);
ck('clip: no horizontal overflow', !r.bodyScrollsHorizontally && r.widestElement <= r.viewportWidth, `widest=${r.widestElement} vw=${r.viewportWidth}`);
ck('clip: play targets ≥ 44 px', r.buttonsUnder44px.filter(b => /Play/.test(b.label)).length === 0, JSON.stringify(r.buttonsUnder44px));
ck('clip: badges — approved (3 people), solo, mismatch warning; none for the unstamped one', r.clipBadges.length === 3 && /3 people/.test(r.clipBadges[0]) && /Solo clip/.test(r.clipBadges[1]) && /nobody approved/.test(r.clipBadges[2]), JSON.stringify(r.clipBadges));
ck('clip: the mismatch plate refuses playback', r.clipRefusedPlay === 1, `refused=${r.clipRefusedPlay}`);
ck('clip: every plate offers Download (anyone who can see a posted clip can save the original)', r.clipDownloadButtons === r.clipPlates, `download=${r.clipDownloadButtons} plates=${r.clipPlates}`);
ck('clip: the mismatch plate refuses Download too (same rule as Play)', r.clipRefusedDownload === 1, `refusedDownload=${r.clipRefusedDownload}`);
ck('clip: download targets ≥ 44 px on a phone', r.buttonsUnder44px.filter(b => /Download/.test(b.label)).length === 0, JSON.stringify(r.buttonsUnder44px));
ck('clip: no <a href="sovereign-clip…"> anywhere (the key must never be a link)', r.clipLinks === 0, `links=${r.clipLinks}`);
ck('clip: a scrubbed ref reads as "clip removed"', /clip removed/.test(await page.locator('body').innerText()));
// Tap Play on the approved plate: parts are stubbed 404 ⇒ "no longer on the server".
await page.locator('.clip-attachment-play').first().tap();
await page.waitForTimeout(800);
ck('clip: parts gone ⇒ honest note', /no longer on the server/.test(await page.locator('.clip-attachment').first().innerText()));
await shot('04-clip-attachment-phone-gone');

// ---- owner settings block -------------------------------------------------------
await page.goto('/e2e/clips-mobile.html?view=settings');
await page.waitForSelector('#clip-max-seconds', { timeout: 15000 });
await page.waitForTimeout(300);
r = await report();
await shot('05-server-settings-clips-phone');
ck('settings: clips block mounts at phone width', r.settingsClipsBlock);
ck('settings: no horizontal overflow', !r.bodyScrollsHorizontally, `widest=${r.widestElement} vw=${r.viewportWidth}`);

// ---- desktop width, same prompt (regression eyeball) ------------------------------
const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL });
const dpage = await desk.newPage();
await dpage.goto('/e2e/clips-mobile.html?view=prompt');
await dpage.waitForSelector('.clip-approval', { timeout: 15000 });
await dpage.waitForTimeout(600);
const dr = await dpage.evaluate(() => window.__clipsHarness());
await dpage.screenshot({ path: `${outdir}/06-prompt-desktop.png` });
console.log('SHOT', `${outdir}/06-prompt-desktop.png`);
ck('desktop: Decline first (left) with focus, buttons ≥ 44 px', dr.activeIsDecline && dr.buttonsUnder44px.length === 0, JSON.stringify(dr.buttonsUnder44px));
await dpage.goto('/e2e/clips-mobile.html?view=clip');
await dpage.waitForSelector('.clip-attachment', { timeout: 15000 });
await dpage.screenshot({ path: `${outdir}/07-clip-attachment-desktop.png`, fullPage: true });
console.log('SHOT', `${outdir}/07-clip-attachment-desktop.png`);

await browser.close();
console.log(`\n${fail ? 'FAILED' : 'OK'}: ${fail} failing check(s)`);
process.exit(fail ? 1 : 0);
