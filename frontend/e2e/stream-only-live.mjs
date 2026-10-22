// LIVE: an automated streaming account (docs/STREAM_ONLY.md), set up through
// the real role editor and driven only through the automation hooks
// (docs/AUTOMATION.md), against a REAL backend + the REAL web client, on a
// MESH voice channel.
//
// What it proves:
//   1. the owner's setup UI: + Stream Only Role, the channel list, No receive,
//      Join voice without a microphone - on a 1280x800 desktop and at 390x844
//      touch (in view, no sideways scroll, what a tap hits);
//   2. the server's cap: the account lists only the voice channel opened for
//      it, and is refused a text channel's messages;
//   3. the account selects the server, opens the channel, joins and shares by
//      data-testid alone; its microphone is never asked for; the owner's
//      roster shows it with "No microphone", not muted;
//   4. viewers see its stream: the owner's mesh peer receives its video;
//   5. No receive, as the owner's own client enforces it on the mesh: before
//      it, the account receives the owner's microphone (the control); after
//      ticking it in the role editor, the owner's client stops sending
//      (outbound audio to it, and its inbound audio, stop growing);
//   6. no "producing silence" warning or "digital silence" line on the account
//      after more than the sentinel's 24 s, and it stops and leaves by testid.
// getStats only, never playback: the browser runs with --mute-audio, and the
// account's screen is a canvas behind getDisplayMedia, as an automation would
// supply it. Each check is a PASS/FAIL line; the exit code is the failures.
//
// Prereqs: a throwaway backend (APP_ENV=development, raised AUTH_RATE_LIMIT_*)
// at API and vite of this tree at APP with VITE_API_URL=API.
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5174 API=http://127.0.0.1:3000 OUT=<dir> node e2e/stream-only-live.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP || 'http://127.0.0.1:5174';
const OUT = process.env.OUT || '.';
fs.mkdirSync(OUT, { recursive: true });
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const OWNER = 'soo_' + stamp;
const BOT = 'sob_' + stamp;

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '  -- ' + extra}`);
    if (!ok) failures++;
};
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

const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

const consoleLines = { OWNER: [], BOT: [], PHONE: [] };
function watch(page, tag) {
    page.on('console', m => {
        consoleLines[tag]?.push(m.text());
        fs.appendFileSync(path.join(OUT, 'console.txt'), `${new Date().toISOString()} ${tag} ${m.type()} ${m.text().slice(0, 400)}\n`);
    });
    page.on('pageerror', e => console.log(`  [${tag} pageerror]`, e.message.slice(0, 200)));
    page.on('dialog', d => { console.log(`  [${tag} DIALOG]`, d.message()); d.dismiss().catch(() => {}); });
}

async function closeServerSettings(page) {
    await page.locator('.server-settings-overlay button.close-btn[aria-label="Close"]').first().click();
    await until(async () => (await page.locator('.server-settings-overlay').count()) === 0, 5000);
}

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

async function signIn(ctx, user, tag, registerFirst) {
    const page = await ctx.newPage();
    watch(page, tag);
    await page.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 60000 });
    if (registerFirst) await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder(registerFirst ? 'Choose a password (min 8 characters)' : 'Enter password').fill(PASS);
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

/** Inbound/outbound RTP bytes of the mesh peer `uid`, by kind and direction. */
async function rtp(page, uid) {
    const diag = await page.evaluate(async () => await window.__pucaMeshDiag());
    const peer = (diag || []).find(p => p.userId === uid);
    const sum = (dir, kind) => (peer?.rtp || []).filter(r => r.dir === dir && r.kind === kind).reduce((a, r) => a + (r.bytes || 0), 0);
    return {
        found: !!peer,
        connection: peer?.connection,
        inAudio: sum('inbound-rtp', 'audio'), inVideo: sum('inbound-rtp', 'video'),
        outAudio: sum('outbound-rtp', 'audio'), outVideo: sum('outbound-rtp', 'video'),
    };
}

/** An element is in the viewport, unclipped sideways, and a tap at its
 *  centre lands on it (after scrolling it into view). */
async function reachable(page, selector) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, why: 'missing' };
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const vw = document.documentElement.clientWidth, vh = window.innerHeight;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const label = el.closest('label');
        const hits = !!hit && (el === hit || el.contains(hit) || (label && label.contains(hit)));
        const inView = r.left >= 0 && r.right <= vw + 0.5 && r.top >= 0 && r.bottom <= vh + 0.5 && r.width > 0;
        return { ok: inView && hits && document.documentElement.scrollWidth <= vw, inView, hits, w: Math.round(r.width), h: Math.round(r.height), sw: document.documentElement.scrollWidth, vw };
    }, selector);
}

const BOT_INIT = () => {
    // Count every microphone ask; a stream-only account must make none.
    window.__audioAsks = 0;
    const md = navigator.mediaDevices;
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => { if (c && c.audio) window.__audioAsks++; return gum(c); };
    // What an automation supplies: its own video behind getDisplayMedia.
    md.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 640; c.height = 360;
        const g = c.getContext('2d');
        let i = 0;
        setInterval(() => { g.fillStyle = `hsl(${(i += 7) % 360},70%,50%)`; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.fillRect((i * 3) % 600, 150, 40, 40); }, 33);
        return c.captureStream(30);
    };
};

try {
    const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const botCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await botCtx.addInitScript(BOT_INIT);

    const owner = await signIn(ownerCtx, OWNER, 'OWNER', true);
    const bot = await signIn(botCtx, BOT, 'BOT', true);

    // ── Fixture: a server, a text channel, two voice channels; the bot joins by invite.
    const srvName = 'SO ' + stamp.slice(-4);
    const srv = await call(owner, '/src/api/servers.ts', 'createServer', [srvName]);
    const text = await call(owner, '/src/api/servers.ts', 'createChannel', [srv.id, 'notes', 0]);
    const stage = await call(owner, '/src/api/servers.ts', 'createChannel', [srv.id, 'Stage', 1]);
    const lounge = await call(owner, '/src/api/servers.ts', 'createChannel', [srv.id, 'Lounge', 1]);
    const inv = await call(owner, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);
    await call(bot, '/src/api/servers.ts', 'joinViaInvite', [inv.code]);
    const uidOf = async (p) => p.evaluate(() => {
        try { const t = localStorage.getItem('auth_token') || ''; return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { return null; }
    });
    const O = await uidOf(owner);
    const B = await uidOf(bot);
    check('fixture: server, channels, the account a member', !!srv.id && !!stage.id && !!text.id && Number.isInteger(B) && B !== O);
    for (const p of [owner, bot]) { await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500); await dismiss(p); }

    // ── 1. The owner sets it up in the role editor (desktop).
    await owner.locator(`[data-testid="server-icon"][data-server-id="${srv.id}"]`).click();
    await sleep(800);
    await owner.locator('button[title="Server Settings"]').click();
    await owner.locator('.nav-item', { hasText: 'Roles' }).click();
    await owner.locator('[data-testid="create-stream-only-role"]').click();
    const stageBox = owner.locator(`[data-testid="role-stream-channel"][data-channel-id="${stage.id}"]`);
    check('role editor: the new Stream only role lists the voice channels', !!await until(async () => (await stageBox.count()) > 0, 10000));
    check('role editor: the text channel is not offered', (await owner.locator(`[data-testid="role-stream-channel"][data-channel-id="${text.id}"]`).count()) === 0);
    check('role editor: Stream only is ticked on the preset', await owner.locator('[data-testid="role-stream-only"]').isChecked());
    const deskReach = await reachable(owner, `[data-testid="role-stream-channel"][data-channel-id="${stage.id}"]`);
    check('role editor (1280x800): the channel checkbox is reachable', deskReach.ok, JSON.stringify(deskReach));
    await stageBox.click();
    check('role editor: ticking Stage writes its overwrite', !!await until(async () => {
        const ows = await call(owner, '/src/api/channels.ts', 'getChannelOverwrites', [stage.id]);
        return ows.some(o => (o.allow & (1 << 8)) !== 0);
    }, 8000));
    await owner.locator('[data-testid="role-automated-streaming"]').screenshot({ path: path.join(OUT, 'role-section-desktop.png') });
    const roles = await call(owner, '/src/api/servers.ts', 'listRoles', [srv.id]);
    const role = roles.find(r => r.name === 'Stream only');
    check('the preset role carries Stream and Stream only, not No receive yet', !!role && (role.permissions & (1 << 11)) !== 0 && (role.permissions & (1 << 29)) !== 0 && (role.permissions & (1 << 30)) === 0, JSON.stringify(role));
    await call(owner, '/src/api/servers.ts', 'assignRole', [srv.id, B, role.id]);
    await closeServerSettings(owner);
    await sleep(500);

    // 1b. The same section, and the setting, at 390x844 touch.
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const phone = await signIn(phoneCtx, OWNER, 'PHONE', false);
    await phone.locator('.mobile-nav-btn').first().tap().catch(() => {});
    await sleep(400);
    await phone.locator(`[data-testid="server-icon"][data-server-id="${srv.id}"]`).tap();
    await sleep(800);
    await phone.locator('button[title="Server Settings"]').first().tap();
    await phone.locator('.nav-item', { hasText: 'Roles' }).tap();
    await phone.locator('.role-item', { hasText: 'Stream only' }).first().tap();
    await until(async () => (await phone.locator(`[data-testid="role-stream-channel"][data-channel-id="${stage.id}"]`).count()) > 0, 10000);
    for (const sel of ['[data-testid="role-stream-only"]', '[data-testid="role-no-receive"]', `[data-testid="role-stream-channel"][data-channel-id="${stage.id}"]`]) {
        const r = await reachable(phone, sel);
        check(`390x844: ${sel} in view, no sideways scroll, a tap hits it`, r.ok, JSON.stringify(r));
    }
    check('390x844: Stage shows as opened', await phone.locator(`[data-testid="role-stream-channel"][data-channel-id="${stage.id}"]`).isChecked());
    await phone.screenshot({ path: path.join(OUT, 'role-section-phone.png') });
    await phone.keyboard.press('Escape').catch(() => {});
    await phone.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(phone);
    await phone.locator('button[title="Settings"]').first().tap().catch(() => {});
    await phone.locator('.settings-nav-item', { hasText: 'Voice & Video' }).first().tap().catch(() => {});
    const setting = await reachable(phone, '[data-testid="settings-join-without-mic"]');
    check('390x844: Join voice without a microphone is reachable', setting.ok, JSON.stringify(setting));
    await phone.screenshot({ path: path.join(OUT, 'settings-no-mic-phone.png') });
    await phoneCtx.close();

    // ── 2. The server's cap, from the account's own session.
    await bot.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(bot);
    const seen = await call(bot, '/src/api/servers.ts', 'listChannels', [srv.id]);
    check('the account lists only the voice channel opened for it', seen.length === 1 && seen[0].id === stage.id, JSON.stringify(seen.map(c => c.name)));
    const readText = await bot.evaluate(async (id) => {
        try { await (await import('/src/api/servers.ts')).getMessages(id); return 'read'; } catch (e) { return String(e?.status ?? e?.message ?? e); }
    }, text.id);
    check('the account is refused the text channel\'s messages', readText !== 'read', readText);

    // ── 3. The owner is in Stage; the account joins and shares by testid alone.
    await owner.locator(`[data-testid="voice-channel"][data-channel-id="${stage.id}"]`).click();
    check('owner is in the Stage call', !!await until(async () => (await owner.locator('[data-testid="voice-connected"]').count()) > 0, 20000));
    await bot.locator(`[data-testid="server-icon"][data-server-id="${srv.id}"]`).click();
    await sleep(800);
    check('the account sees no Lounge row', (await bot.locator(`[data-testid="voice-channel"][data-channel-id="${lounge.id}"]`).count()) === 0);
    await bot.locator(`[data-testid="voice-channel"][data-channel-id="${stage.id}"]`).click();
    check('the account is in the Stage call (voice-connected)', !!await until(async () => (await bot.locator('[data-testid="voice-connected"]').count()) > 0, 20000));
    const asks = await bot.evaluate(() => window.__audioAsks);
    check('the account never asked for a microphone', asks === 0, String(asks));
    const joinedAt = Date.now();
    const noMicIcon = await until(async () => (await owner.locator('.voice-users-list .voice-status-icon.no-mic').count()) > 0, 10000);
    check('the owner\'s roster shows the account with "No microphone"', !!noMicIcon);
    const mesh = await until(async () => { const r = await rtp(owner, B); return r.connection === 'connected' && r; }, 25000);
    check('owner <-> account mesh peer connected', !!mesh, JSON.stringify(mesh));

    // 5a. CONTROL: before No receive, the owner's microphone reaches the account.
    const a0 = await rtp(bot, O);
    await sleep(3000);
    const a1 = await rtp(bot, O);
    check('control: without No receive the account receives the owner\'s audio', a1.inAudio - a0.inAudio > 2000, JSON.stringify({ a0, a1 }));

    await bot.locator('[data-testid="voice-share-screen"]').click();
    check('the share button turns into voice-stop-share', !!await until(async () => (await bot.locator('[data-testid="voice-stop-share"]').count()) > 0, 15000));
    // 4. Viewers see its stream.
    const v0 = await rtp(owner, B);
    await sleep(4000);
    const v1 = await rtp(owner, B);
    check('the owner receives the account\'s screen share (inbound video grows)', v1.inVideo - v0.inVideo > 20000, JSON.stringify({ v0, v1 }));
    check('the owner sees the account LIVE', (await owner.locator('.voice-users-list .live-badge-mini').count()) > 0);

    // 5b. The owner ticks No receive in the role editor.
    await owner.locator('button[title="Server Settings"]').click();
    await owner.locator('.nav-item', { hasText: 'Roles' }).click();
    await owner.locator('.role-item', { hasText: 'Stream only' }).first().click();
    await owner.locator('[data-testid="role-no-receive"]').click();
    await owner.locator('.save-role-btn').click();
    await sleep(1500);
    await closeServerSettings(owner);
    const flagged = await until(async () => {
        const o0 = await rtp(owner, B);
        await sleep(2500);
        const o1 = await rtp(owner, B);
        return (o1.outAudio - o0.outAudio) < 200 && { o0, o1 };
    }, 20000, 500);
    check('with No receive the owner\'s client stops sending the account audio', !!flagged, JSON.stringify(flagged));
    const b0 = await rtp(bot, O);
    await sleep(3000);
    const b1 = await rtp(bot, O);
    check('...and the account\'s inbound audio stops growing', b1.inAudio - b0.inAudio < 200, JSON.stringify({ b0, b1 }));
    const v2 = await rtp(owner, B);
    await sleep(3000);
    const v3 = await rtp(owner, B);
    check('...while the owner still receives its stream', v3.inVideo - v2.inVideo > 20000, JSON.stringify({ v2, v3 }));

    // 6. No silent-mic warning after more than the sentinel's 24 s.
    const wait = 26000 - (Date.now() - joinedAt);
    if (wait > 0) await sleep(wait);
    const botText = await bot.locator('body').innerText();
    check('no "producing silence" warning on the account', !botText.includes('producing silence'));
    check('no "digital silence" line in the account\'s console', !consoleLines.BOT.some(l => l.includes('digital silence')));
    check('no "No microphone detected" help on the account', !botText.includes('No microphone detected'));
    await bot.screenshot({ path: path.join(OUT, 'account-in-call.png') });

    await bot.locator('[data-testid="voice-stop-share"]').click();
    check('stop: the button is voice-share-screen again', !!await until(async () => (await bot.locator('[data-testid="voice-share-screen"]').count()) > 0, 10000));
    await bot.locator('[data-testid="voice-leave"]').click();
    check('leave: the account is out of the call', !!await until(async () => (await bot.locator('[data-testid="voice-connected"]').count()) === 0, 10000));
    const list = await call(owner, '/src/api/servers.ts', 'fetchVoiceUsers', [srv.id]);
    check('the server\'s voice list no longer has the account', !(list?.voice_users ?? []).some(r => r.user_id === B), JSON.stringify(list));
} catch (e) {
    failures++;
    console.log('FAIL  the run threw:', e?.stack || e);
} finally {
    await browser.close();
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures);
