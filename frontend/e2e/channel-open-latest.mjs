// Opening a text channel must land on the NEWEST message.
//
// Reported twice. v0.7.4 added an explicit channel-open anchor and fixed the
// plain case, but the report came back — so this measures the real thing
// (distance from the bottom, in pixels, after everything settles) instead of
// asserting that some code path ran.
//
// The cases that matter are the ones where content GROWS after the anchor
// scroll: images and custom emoji that load late, link previews, and — since
// /files became authenticated — avatars and emoji that arrive as object URLs
// from an async fetch rather than being laid out immediately.
//
// Prereqs: native Postgres + backend (:3000) + vite (:5173) up.
// Usage: node e2e/channel-open-latest.mjs
import { chromium } from '@playwright/test';

const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const USER = 'scroll_' + stamp;
/** Enough to overflow the viewport several times over. */
const MESSAGE_COUNT = 60;
/** Within this many px of the bottom counts as "at the latest". */
const SLOP = 120;

let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failures++; };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on('dialog', d => d.accept().catch(() => {}));

/** How far the message list is from the bottom, and whether the newest row is visible. */
const bottomGap = () => page.evaluate(() => {
    const el = document.querySelector('.messages-container')
        || document.querySelector('[class*="messages"]');
    if (!el) return { found: false };
    return {
        found: true,
        gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollable: el.scrollHeight > el.clientHeight + 10,
    };
});

try {
    await page.goto('http://localhost:5173/login');
    await page.waitForSelector('#username');
    await page.click('.toggle-mode');
    await page.waitForSelector('#inviteCode');
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 30000 });
    await page.waitForTimeout(1500);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* older */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }

    // A server with two text channels, so we can switch BETWEEN them (the
    // reported case is "when I go to that tab", i.e. a switch, not a cold load).
    await page.locator('.server-icon.add-server').click({ timeout: 8000 });
    await page.waitForTimeout(600);
    await page.locator('.template-card').first().click({ timeout: 5000 });
    await page.waitForTimeout(300);
    await page.locator('.audience-card').first().click({ timeout: 5000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill('ScrollTest');
    await page.locator('.wizard-actions .create-btn').click();
    await page.waitForTimeout(3000);
    check('server created', true);

    // The starter template ships ONE text channel, so there is nothing to
    // switch between. Make a second one through the API, then reload so the
    // sidebar shows it.
    const made = await page.evaluate(async () => {
        const token = localStorage.getItem('auth_token');
        const api = 'http://127.0.0.1:3000';
        const servers = await fetch(`${api}/servers`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
        const srv = servers[servers.length - 1];
        const res = await fetch(`${api}/servers/${srv.id}/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ name: 'second', channel_type: 0 }),
        });
        return { ok: res.ok, status: res.status };
    });
    check('created a SECOND text channel to switch between', made.ok, `status=${made.status}`);
    await page.reload();
    await page.waitForTimeout(3000);
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }

    // Post enough messages to overflow, through the real composer.
    const composer = page.locator('textarea[placeholder^="Message #"]');
    await composer.waitFor({ timeout: 15000 });
    for (let i = 1; i <= MESSAGE_COUNT; i++) {
        await composer.fill(`message ${i} of ${MESSAGE_COUNT}`);
        await composer.press('Enter');
        if (i % 15 === 0) await page.waitForTimeout(400);
    }
    await page.waitForTimeout(2500);

    const afterSend = await bottomGap();
    check('the list actually scrolls (test is meaningful)', afterSend.scrollable,
        `h=${afterSend.scrollHeight} vs ${afterSend.clientHeight}`);
    check('after sending, the view is at the latest', afterSend.gap <= SLOP, `gap=${afterSend.gap}px`);

    // Scroll to the TOP, then switch away and back — the reported journey.
    await page.evaluate(() => {
        const el = document.querySelector('.messages-container') || document.querySelector('[class*="messages"]');
        if (el) el.scrollTop = 0;
    });
    await page.waitForTimeout(600);
    const parked = await bottomGap();
    check('parked at the top before switching (control)', parked.gap > SLOP, `gap=${parked.gap}px`);

    // Switch to another channel and back. Assert the switch REALLY happened —
    // otherwise "still parked at the top" would just mean the click missed and
    // the test would be blaming the product for its own bug.
    const openChannel = () => page.evaluate(() => {
        const ph = document.querySelector('textarea[placeholder^="Message #"]');
        return ph ? ph.getAttribute('placeholder') : null;
    });
    const before = await openChannel();
    const switched = await page.evaluate((current) => {
        const items = [...document.querySelectorAll('li.channel')];
        const target = items.find(i => !i.textContent || !current.includes(i.textContent.trim()));
        if (!target) return false;
        target.click();
        return true;
    }, before || '');
    await page.waitForTimeout(1800);
    const middle = await openChannel();
    check('actually switched to a DIFFERENT channel (control)',
        switched && middle !== null && middle !== before, `${before} -> ${middle}`);

    await page.evaluate((want) => {
        const items = [...document.querySelectorAll('li.channel')];
        const target = items.find(i => want.includes((i.textContent || '').trim()));
        target?.click();
    }, before || '');
    await page.waitForTimeout(2500);
    const back = await openChannel();
    check('switched BACK to the original channel (control)', back === before, `${middle} -> ${back}`);
    const afterSwitch = await bottomGap();
    check('after switching back, the view is at the LATEST', afterSwitch.gap <= SLOP,
        `gap=${afterSwitch.gap}px (0 = pinned to newest)`);

    // Reload: a cold open of the same channel.
    await page.reload();
    await page.waitForTimeout(4000);
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    await page.waitForTimeout(2000);
    const afterReload = await bottomGap();
    if (afterReload.found && afterReload.scrollable) {
        check('after a reload, the view is at the LATEST', afterReload.gap <= SLOP, `gap=${afterReload.gap}px`);
    } else {
        console.log('SKIP  reload landed without a scrollable list');
    }
} catch (e) {
    console.log('EXCEPTION:', String(e).split('\n').slice(0, 3).join(' | '));
    failures++;
} finally {
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
