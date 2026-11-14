// notify-renotify-probe.mjs: does Firefox's and WebKit's Notification have
// `renotify`? (It must not: desktopNotify.ts's browserRenotifies keeps a quiet
// update off the screen where a same-tag replacement would pop.)
//
// Run by notify-coalesce-real-browser.mjs as a child process, and runnable on
// its own: `node e2e/notify-renotify-probe.mjs`. It lives in a file of its own
// because that walk grants notifications to Chromium, and
// scripts/check-e2e-muted.mjs allows no Firefox or WebKit launch in a file that
// grants them. Nothing here grants notifications or constructs one: only the
// property on the prototype is read, so nothing is shown and nothing sounds.
// Both browsers launch muted (Firefox's volume pref, WebKit through muteWebkit).
//
// FIREFOX=0 / WEBKIT=0 skip a browser. Exit 0 pass, 1 a check failed, 3 nothing
// was checked (every browser skipped), which the walk prints as a SKIP, never a pass.
import { firefox, webkit } from '@playwright/test';
import { muteWebkit } from './muted.mjs';

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) pass++; else fail++;
    console.log(cond ? 'PASS' : 'FAIL', label, extra);
};

for (const [label, start, skip] of [
    ['Firefox', () => firefox.launch({ headless: true, firefoxUserPrefs: { 'media.volume_scale': '0.0' } }), process.env.FIREFOX === '0'],
    ['WebKit', async () => muteWebkit(await webkit.launch({ headless: true })), process.env.WEBKIT === '0'],
]) {
    if (skip) { console.log('SKIP', `${label}: skipped by its env switch`); continue; }
    let other;
    try {
        other = await start();
    } catch (e) {
        console.log('SKIP', `${label}: cannot launch (npx playwright install ${label.toLowerCase()})`, String(e.message).split('\n')[0]);
        continue;
    }
    const ctx = await other.newContext();
    const p = await ctx.newPage();
    await p.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset=utf-8><title>notify</title><body>rig</body>' }));
    // Not port 9: Firefox refuses it (a blocked port) before the route can
    // answer. Nothing listens here either; the route answers every request.
    await p.goto('http://127.0.0.1:47110/');
    const got = await p.evaluate(() => ({ has: typeof Notification !== 'undefined', renotify: typeof Notification !== 'undefined' && 'renotify' in Notification.prototype }));
    if (!got.has) console.log('SKIP', `${label}: has no Notification on this platform`);
    else ck(got.renotify === false, `${label}: no renotify on Notification.prototype, so quiet updates stay off its screen`, JSON.stringify(got));
    await other.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : pass ? 0 : 3);
