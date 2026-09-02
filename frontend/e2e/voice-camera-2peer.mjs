// Live 2-peer camera test: proves a remote peer's camera feed actually RENDERS
// (inside the participant's VoiceStage tile — the .vs-camera-video path; the
// old floating .remote-camera-tile grid is gone), not just that an icon
// toggles. Peer B opens the voice stage by clicking the connected voice
// channel, then must see A's tile carrying live video frames.
// Also exercises real mesh WebRTC on localhost — the "live voice never tested
// end-to-end" gap.
//
// Both peers are registered FRESH (unique names) and each owns/joins exactly
// ONE server, so server-rail selection is unambiguous. Peer A creates the
// server via the wizard; peer B is inserted into it via psql (skips invite UI).
//
// Prereqs: native Postgres + backend (:3000) + vite (:5173) up.
// Usage: node e2e/voice-camera-2peer.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const APP = process.env.APP || APP;
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const AUSER = 'camowner_' + stamp;
const BUSER = 'campeer_' + stamp;

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-p', process.env.PGPORT || '5432', '-d', process.env.PGDB || 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

const browser = await chromium.launch({
    args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        // Real-address host candidates. Headless Chromium's mDNS (.local)
        // candidate resolution is a race, and when it loses, the only
        // remaining ICE pairs go via the STUN-reflexive address — which on a
        // VPN'd dev machine hairpins requests but EATS the responses, so ICE
        // sits in 'checking' for 15s and Chromium kills a call whose media
        // is actually flowing (the pc-rebuild cascade this suite kept
        // tripping over). Same-machine tests must connect host<->host.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
});

async function register(ctx, user) {
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') console.log(`  [${user} err]`, m.text().slice(0, 140)); });
    await page.goto(APP + '/login');
    await page.waitForURL('**/login');
    await page.waitForSelector('#username', { timeout: 10000 });
    await page.click('.toggle-mode', { timeout: 5000 });
    await page.waitForSelector('#inviteCode', { timeout: 5000 });
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

// Select the (single) server on the rail, then join the named voice channel.
async function joinVoice(page, chName) {
    await page.reload();
    await page.waitForTimeout(1800);
    await page.evaluate(() => {
        const icons = [...document.querySelectorAll('.server-icon')];
        const target = icons.find(i => !/direct message|add server|join server|notes|tasks/i.test(
            (i.getAttribute('title') || '') + ' ' + (i.className || '')));
        target?.click();
    });
    await page.waitForTimeout(1500);
    const result = await page.evaluate((name) => {
        // Voice channels render the name as raw text inside `.voice-channel`
        // (beside a speaker/AFK icon span), NOT in a `.channel-name` element.
        // The icon is an <svg> and contributes no textContent, so collapsing
        // whitespace is all this needs.
        const items = [...document.querySelectorAll('.voice-channel-list .voice-channel')];
        const dump = items.map(n => n.textContent.replace(/\s+/g, ' ').trim());
        const el = items.find(n => !n.classList.contains('afk') && n.textContent.includes(name));
        if (el) { el.click(); return { ok: true, dump }; }
        return { ok: false, dump };
    }, chName);
    return result;
}

try {
    // --- Peer A: fresh owner, one server ---
    const ctxA = await browser.newContext();
    const pageA = await register(ctxA, AUSER);
    await createServer(pageA, 'CamTest');
    const aId = psql(`SELECT id FROM users WHERE username='${AUSER}'`);
    const serverId = psql(`SELECT id FROM servers WHERE owner_id=${aId} ORDER BY id DESC LIMIT 1`);
    check('server created for owner', !!serverId);

    // --- Peer B: fresh, inserted as member ---
    const ctxB = await browser.newContext();
    const pageB = await register(ctxB, BUSER);
    const bId = psql(`SELECT id FROM users WHERE username='${BUSER}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bId}) ON CONFLICT DO NOTHING`);
    check('peer B is a server member', psql(`SELECT count(*) FROM server_members WHERE server_id='${serverId}' AND user_id=${bId}`) === '1');

    // --- Both join the "default" voice channel ---
    const jA = await joinVoice(pageA, 'default');
    const jB = await joinVoice(pageB, 'default');
    console.log('  A voice channels:', JSON.stringify(jA.dump), '-> joined:', jA.ok);
    console.log('  B voice channels:', JSON.stringify(jB.dump), '-> joined:', jB.ok);
    check('both joined the voice channel', jA.ok && jB.ok);
    await pageA.waitForTimeout(6000); // mesh WebRTC connect
    check('A shows Voice Connected', await pageA.locator('.voice-connection-info').count() > 0);
    check('B shows Voice Connected', await pageB.locator('.voice-connection-info').count() > 0);

    // --- A turns on camera ---
    const camClicked = await pageA.evaluate(() => {
        const btn = [...document.querySelectorAll('.voice-controls-compact .voice-btn')].find(b => /camera/i.test(b.getAttribute('title') || ''));
        if (btn) { btn.click(); return true; }
        return false;
    });
    check('A camera button clicked', camClicked);
    await pageA.waitForTimeout(1200);
    check('A self-preview visible', await pageA.locator('.camera-preview-mini video, .camera-fullscreen video').count() > 0);

    // --- B opens the voice stage (cameras render in participant tiles now) ---
    await pageB.evaluate(() => {
        const items = [...document.querySelectorAll('.voice-channel-list .voice-channel')];
        const el = items.find(n => !n.classList.contains('afk') && n.textContent.includes('default'));
        el?.click();
    });
    await pageB.waitForTimeout(1500);
    check('B voice stage open (still connected)', await pageB.locator('.voice-stage').count() > 0
        && await pageB.locator('.voice-connection-info').count() > 0);

    // --- B should render A's camera feed inside A's stage tile ---
    // Poll rather than a single fixed wait: mesh camera renegotiation + first
    // decoded frame has seconds of variance and a point check raced it flaky.
    const tile = await pageB.evaluate(async () => {
        const deadline = Date.now() + 20000;
        let v = null;
        while (Date.now() < deadline) {
            v = document.querySelector('.voice-stage .vs-camera-video');
            if (v && v.videoWidth > 0) break;
            await new Promise(r => setTimeout(r, 250));
        }
        if (!v) return { present: false };
        const so = v.srcObject;
        return {
            present: true, videoWidth: v.videoWidth ?? 0, mirrored: v.classList.contains('mirrored'),
            // Diagnostics for the failing case: is playback started, and is
            // the bound track actually delivering RTP (muted flips false on
            // the first arriving frame)?
            paused: v.paused, readyState: v.readyState,
            tracks: so ? so.getTracks().map(t => `${t.kind}:${t.readyState}:${t.muted ? 'muted' : 'unmuted'}`) : null,
        };
    });
    console.log('  B stage camera video:', JSON.stringify(tile));
    check('B renders the camera inside a stage tile', tile.present === true);
    check('B video is receiving frames (videoWidth>0)', (tile.videoWidth || 0) > 0);
    check('B does NOT mirror the remote feed', tile.mirrored !== true);

    // --- A stops camera -> B's tile falls back to the avatar ---
    await pageA.evaluate(() => {
        const btn = [...document.querySelectorAll('.voice-controls-compact .voice-btn')].find(b => /camera/i.test(b.getAttribute('title') || ''));
        btn?.click();
    });
    await pageB.waitForTimeout(3500);
    check('B stage camera removed after A stops camera', await pageB.locator('.voice-stage .vs-camera-video').count() === 0);
} catch (e) {
    console.log('EXCEPTION:', String(e).split('\n').slice(0, 2).join(' | '));
    failures++;
} finally {
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
