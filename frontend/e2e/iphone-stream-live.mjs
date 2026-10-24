// LIVE: watching a friend's stream on an iPhone-shaped phone, in the REAL app
// against a REAL backend, on an encrypted mesh call — the owner's report
// (0.9.848, iPhone Safari: "full screen on the web app stream does nothing,
// horizontal mode is really bad and cant even see the stream at all").
//
// e2e/iphone-stream-real-browser.mjs is the gate (no server; the real stage in
// the real phone chrome). This is the same story end to end: a desktop account
// shares a canvas "screen" (getDisplayMedia replaced, as an automation would
// supply it); the phone (390x844, touch, the iPhone user agent, and NO element
// fullscreen — the iPhone's engine) joins the call and watches:
//   1. portrait: the stage under the header, the composer reachable, the
//      picture live (frames decoded through the call's encryption), the voice
//      bar says Encrypted;
//   2. sideways (844x390, and 750x340 for a Safari tab): the stage covers the
//      screen with the picture flush, nothing of the chat reachable under it,
//      controls 44 px and hit-testable, a tap hides them all and another
//      brings them back, and the voice bar's Mute really mutes from there;
//   3. Chat: the chat with the docked player beside the list, and the player's
//      expand back to the stage;
//   4. portrait Fullscreen: the in-app fullscreen fills the screen and its
//      Exit gives the chat back;
//   5. the header's Watch button stays one line and leaves the channel name
//      its room.
// Silent: --mute-audio, and the shared "screen" has no sound.
//
// Prereqs: a throwaway backend (APP_ENV=development, raised AUTH_RATE_LIMIT_*)
// and vite of this tree with VITE_API_URL pointing at it.
//   APP=http://127.0.0.1:5174 OUT=<dir> node e2e/iphone-stream-live.mjs
// DUMP=<file> also writes the phone's chat chrome markup: the fixture the gate
// renders (e2e/iphone-stream/real-phone-chrome.json). Refresh it when the
// chat header, composer, voice bar or bottom nav change.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { IPHONE_FULLSCREEN, IPHONE_UA, measure, overlap } from './iphone-stream/checks.mjs';

const APP = process.env.APP || 'http://127.0.0.1:5174';
const OUT = process.env.OUT || 'e2e-artifacts/iphone-stream-live';
fs.mkdirSync(OUT, { recursive: true });
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const SHARER = 'ips_' + stamp;
const VIEWER = 'ipv_' + stamp;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 250) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
        try { last = await fn(); if (last) return last; } catch { /* retry */ }
        await sleep(step);
    }
    return last;
}
let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '  -- ' + extra}`);
    if (!ok) failures++;
};

const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

async function dismiss(page) {
    for (let i = 0; i < 3; i++) {
        let did = false;
        if (await page.locator('.recovery-confirm input[type="checkbox"]').count()) {
            await page.locator('.recovery-confirm input[type="checkbox"]').first().check().catch(() => {});
            await page.locator('.recovery-done-btn').first().click().catch(() => {});
            did = true;
        }
        if (await page.locator('.welcome-popup-close').count()) { await page.locator('.welcome-popup-close').first().click().catch(() => {}); did = true; }
        const later = page.getByRole('button', { name: 'Later', exact: true });
        if (await later.count()) { await later.first().click().catch(() => {}); did = true; }
        if (!did) return;
        await sleep(300);
    }
}
async function signIn(ctx, user) {
    const page = await ctx.newPage();
    page.on('pageerror', e => { failures++; console.log(`  [${user} pageerror]`, e.message.slice(0, 200)); });
    await page.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 60000 });
    await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 60000 });
    await sleep(1500);
    await dismiss(page);
    return page;
}
const call = (page, mod, fn, args = []) => page.evaluate(async ({ mod, fn, args }) => {
    const m = await import(mod);
    return m[fn](...args);
}, { mod, fn, args });

const SHARE_INIT = () => {
    navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 1280; c.height = 720;
        const g = c.getContext('2d');
        let i = 0;
        setInterval(() => {
            g.fillStyle = `hsl(${(i += 3) % 360},60%,40%)`; g.fillRect(0, 0, 1280, 720);
            g.fillStyle = '#fff'; g.font = 'bold 80px sans-serif'; g.fillText('SHARED SCREEN', 340, 380);
            g.fillRect((i * 5) % 1200, 600, 80, 80);
        }, 33);
        return c.captureStream(30);
    };
};
const liveVideo = (page) => page.evaluate(() => [...document.querySelectorAll('.stream-stage video, .stream-pip video')].some(v => v.srcObject && v.videoWidth > 0));
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

try {
    const sharerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await sharerCtx.addInitScript(SHARE_INIT);
    const sharer = await signIn(sharerCtx, SHARER);
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
    await phoneCtx.addInitScript(IPHONE_FULLSCREEN);
    const phone = await signIn(phoneCtx, VIEWER);

    const srv = await call(sharer, '/src/api/servers.ts', 'createServer', ['iPhone ' + stamp.slice(-4)]);
    await call(sharer, '/src/api/servers.ts', 'createChannel', [srv.id, 'general', 0]);
    const vc = await call(sharer, '/src/api/servers.ts', 'createChannel', [srv.id, 'Hangout', 1]);
    const inv = await call(sharer, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);
    await call(phone, '/src/api/servers.ts', 'joinViaInvite', [inv.code]);
    for (const p of [sharer, phone]) { await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500); await dismiss(p); }

    await sharer.locator(`[data-testid="server-icon"][data-server-id="${srv.id}"]`).click();
    await sleep(800);
    await sharer.locator(`[data-testid="voice-channel"][data-channel-id="${vc.id}"]`).click();
    check('the sharer is in the call', !!await until(async () => (await sharer.locator('[data-testid="voice-connected"]').count()) > 0, 20000));

    await phone.locator('.mobile-nav-btn').first().tap().catch(() => {});
    await sleep(400);
    await phone.locator(`[data-testid="server-icon"][data-server-id="${srv.id}"]`).tap();
    await sleep(800);
    await phone.locator(`[data-testid="voice-channel"][data-channel-id="${vc.id}"]`).tap();
    check('the phone is in the call', !!await until(async () => (await phone.locator('[data-testid="voice-connected"]').count()) > 0, 20000));
    // Back to the text channel's chat (the voice row's tap may have opened the voice view).
    await phone.locator('.mobile-nav-btn').nth(1).tap().catch(() => {});
    await sleep(400);
    await phone.locator('.channel', { hasText: 'general' }).first().tap({ force: true }).catch(() => {});
    await sleep(800);
    check('the voice bar says Encrypted', !!await until(async () => (await phone.locator('.voice-panel-compact .voice-e2ee.on').count()) > 0, 10000));

    if (process.env.DUMP) {
        const dom = await phone.evaluate(() => {
            const main = document.querySelector('.chat-main').cloneNode(true);
            main.querySelector('.messages-container').innerHTML = '';
            const attrs = (el) => Object.fromEntries([...el.attributes].map(a => [a.name, a.value]));
            return {
                html: attrs(document.documentElement),
                body: attrs(document.body),
                container: attrs(document.querySelector('.chat-container')),
                chatMain: main.outerHTML,
                nav: document.querySelector('.mobile-bottom-nav').outerHTML,
                voice: document.querySelector('.voice-panel-compact').outerHTML,
            };
        });
        fs.writeFileSync(process.env.DUMP, JSON.stringify(dom, null, 1));
        console.log('dumped the phone chrome to', process.env.DUMP);
    }

    await sharer.locator('[data-testid="voice-share-screen"]').click();
    check('the sharer is live', !!await until(async () => (await sharer.locator('[data-testid="voice-stop-share"]').count()) > 0, 15000));
    const sharerUid = await sharer.evaluate(() => {
        const t = localStorage.getItem('auth_token') || '';
        return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
    });
    // What the voice view's "Watch stream" does.
    await until(() => phone.evaluate(async (uid) => (await import('/src/components/voiceState.ts')).getStreamData(uid)?.stream != null, sharerUid), 15000);
    await phone.evaluate(async (uid) => (await import('/src/components/voiceState.ts')).selectStream(uid), sharerUid);

    // ── 1. Portrait.
    check('portrait: the picture is live (decoded through the call\'s encryption)', !!await until(() => liveVideo(phone), 20000));
    await sleep(800);
    let m = await measure(phone);
    check('portrait: no takeover', m.takeover === null);
    check('portrait: the stage sits under the chat header', !!m.stage && m.stage.t >= m.parts['.chat-header'].b - 0.5, JSON.stringify(m.stage));
    check('portrait: the composer is below the stage and reachable', !!m.parts['.message-form']?.hit && m.parts['.message-form'].t >= m.stage.b - 0.5);
    await shot(phone, '01-portrait-stream.png');

    // ── 2. Sideways.
    for (const [w, h, name] of [[844, 390, 'Home Screen app'], [750, 340, 'Safari tab']]) {
        const tag = `sideways ${w}x${h} (${name})`;
        await phone.setViewportSize({ width: w, height: h });
        await sleep(900);
        m = await measure(phone);
        check(`${tag}: the stage takes over`, m.takeover === 'landscape', String(m.takeover));
        check(`${tag}: the stage covers the window`, !!m.stage && m.stage.l <= 0.5 && m.stage.t <= 0.5 && m.stage.r >= m.vw - 0.5 && m.stage.b >= m.vh - 0.5, JSON.stringify(m.stage));
        check(`${tag}: the live picture is flush with the window`, m.liveFrames && !!m.picture && (m.picture.h >= m.vh - 1 || m.picture.w >= m.vw - 1), JSON.stringify(m.picture));
        check(`${tag}: the middle of the picture is the picture`, m.pictureCentreHit);
        check(`${tag}: nothing of the chat is reachable under it`, !['.chat-header', '.message-form', '.mobile-bottom-nav'].some((s) => m.parts[s]?.hit), JSON.stringify(m.parts));
        const small = m.buttons.filter((b) => b.w < 43.5 || b.h < 43.5 || !b.hit);
        check(`${tag}: every control (${m.buttons.length}) is >= 44 px and a tap lands on it`, m.buttons.length >= 6 && small.length === 0, JSON.stringify(small));
        const pairs = [];
        for (let i = 0; i < m.buttons.length; i++) for (let j = i + 1; j < m.buttons.length; j++) if (overlap(m.buttons[i], m.buttons[j]) > 1) pairs.push([m.buttons[i].label, m.buttons[j].label]);
        check(`${tag}: no two controls overlap`, pairs.length === 0, JSON.stringify(pairs));
        await shot(phone, `02-${w}x${h}-stream.png`);
    }
    // The voice bar works from there: Mute mutes.
    const muteBtn = phone.locator('.voice-panel-compact .voice-btn[title="Mute"]').first();
    await muteBtn.tap();
    check('sideways: the voice bar\'s Mute mutes from over the stream', !!await until(async () => (await phone.locator('.voice-panel-compact .voice-btn[title="Unmute"]').count()) > 0, 5000));
    await phone.locator('.voice-panel-compact .voice-btn[title="Unmute"]').first().tap();
    await sleep(400);
    m = await measure(phone);
    await phone.touchscreen.tap(m.vw / 2, m.vh / 2);
    await sleep(400);
    const hidden = await measure(phone);
    check('sideways: a tap on the picture hides every control', hidden.chrome === 'hidden' && hidden.buttons.length === 0, JSON.stringify(hidden.buttons));
    await shot(phone, '03-sideways-clean.png');
    await phone.touchscreen.tap(m.vw / 2, m.vh / 2);
    await sleep(400);
    check('sideways: another tap brings them back', (await measure(phone)).chrome === null);

    // ── 3. Chat, sideways, with the docked player.
    await phone.locator('.stream-stage-header .back-to-chat-btn').first().tap();
    await sleep(900);
    m = await measure(phone);
    const list = m.parts['.messages-container'];
    check('Chat: out of the takeover, the chat with the docked player', m.takeover === null && !!m.parts['.stream-pip']?.shown && m.liveFrames);
    check('Chat: the player is beside the list and the list keeps >= 120 px', !!list && list.h >= 120 && overlap(m.parts['.stream-pip'], list) < 1, JSON.stringify({ list, pip: m.parts['.stream-pip'] }));
    check('Chat: the composer, voice bar and nav are reachable', ['.message-form', '.voice-panel-compact', '.mobile-bottom-nav'].every((s) => m.parts[s]?.hit));
    await shot(phone, '04-750x340-chat-with-player.png');
    await phone.locator('.stream-pip .pip-btn[title*="xpand"], .stream-pip button[title*="xpand"], .stream-pip button[title*="ull"]').first().tap().catch(() => {});
    await sleep(800);
    check('the player\'s expand brings the stage back, taking over', (await measure(phone)).takeover === 'landscape');

    // ── 4. Portrait Fullscreen, on the iPhone's engine.
    await phone.setViewportSize({ width: 390, height: 844 });
    await sleep(900);
    await phone.locator('.stream-tile-header button[aria-label="Fullscreen"]').first().tap();
    await sleep(1300);
    m = await measure(phone);
    const tile = await phone.evaluate(() => { const r = document.querySelector('.stream-tile.is-app-fullscreen')?.getBoundingClientRect(); return r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; });
    check('Fullscreen (no element fullscreen, as on an iPhone): the stream fills the screen', m.takeover === 'fullscreen' && !!tile && tile.t <= 0.5 && tile.b >= m.vh - 0.5 && tile.l <= 0.5 && tile.r >= m.vw - 0.5, JSON.stringify(tile));
    check('Fullscreen: the picture stays live', m.liveFrames);
    await shot(phone, '05-portrait-fullscreen.png');
    await phone.locator('.stream-tile-header button[aria-label="Exit fullscreen"]').first().tap();
    await sleep(500);
    m = await measure(phone);
    check('Exit fullscreen gives the chat back', m.takeover === null && !!m.parts['.message-form']?.hit);

    // ── 5. The header's Watch button, with the docked player.
    await phone.locator('.stream-stage-header .back-to-chat-btn').first().tap();
    await sleep(800);
    const head = await phone.evaluate(() => {
        const b = document.querySelector('.watch-streams-btn')?.getBoundingClientRect();
        const h2 = document.querySelector('.chat-header h2')?.getBoundingClientRect();
        return { btnH: b?.height ?? 0, nameW: h2?.width ?? 0, headerH: document.querySelector('.chat-header').getBoundingClientRect().height };
    });
    check('portrait: the header\'s Watch button is one line and the channel name keeps its room', head.btnH > 0 && head.btnH <= 50 && head.nameW >= 50, JSON.stringify(head));
    await shot(phone, '06-portrait-chat-with-player.png');
} finally {
    await browser.close();
}
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (screenshots: ${OUT})`);
process.exit(failures === 0 ? 0 : 1);
