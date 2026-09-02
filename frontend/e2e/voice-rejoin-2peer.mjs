// Live 2-peer LEAVE/REJOIN test — the "audio doesn't always work after
// rejoining" bug (v0.5.90 connId fix).
//
// Field failure: one side keeps a STALE RTCPeerConnection for a peer that
// rebuilt its own (leave/rejoin — especially an unclean one: the backend sends
// NO StreamStopped on a WS drop, so a page reload leaves everyone else holding
// a stale pc). The rebuilt peer's fresh offer then throws "m-lines order
// doesn't match" on the stale pc, which stays signalingState='stable' — the
// old watchdog saw 'stable' and never recovered → silence until manual rejoin.
//
// Covered here, asserting audio RESUMES BOTH WAYS after each cycle:
//   1. baseline: both join, audio flows (live tracks + remote speaking ring)
//   2. clean leave/rejoin by B (higher id), twice
//   3. clean leave/rejoin by A (lower id, the classic initiator)
//   4. THE FIELD CASE: B screen-shares (3 m-lines on A's pc for B), then B
//      RELOADS (unclean — A keeps the stale 3-m-line pc) and rejoins
//   5. zero m-line / InvalidAccessError console errors across the whole run
//
// Prereqs: native Postgres + backend (:3000) + vite (:5173) up.
// Usage: node e2e/voice-rejoin-2peer.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const APP = process.env.APP || 'http://localhost:5173';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const A = 'rjA_' + stamp, B = 'rjB_' + stamp;
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-p', process.env.PGPORT || '5432', '-d', process.env.PGDB || 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

let fail = 0;
const ck = (n, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) fail++; };
const glareErr = { a: [], b: [] };
const isGlare = (t) => /m-lines|InvalidAccessError/i.test(t);

const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream',
        // Real-address host candidates: same-machine ICE must not coin-flip
        // on headless mDNS resolution (see voice-camera-2peer.mjs).
        '--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen'],
});

async function reg(ctx, u, bucket) {
    const p = await ctx.newPage();
    p.on('console', m => {
        if (m.type() === 'error' && isGlare(m.text())) { bucket.push(m.text()); console.log(`  [${u} GLARE]`, m.text().slice(0, 140)); }
    });
    await p.goto(APP + '/login');
    await p.waitForSelector('#username', { timeout: 10000 });
    await p.click('.toggle-mode'); await p.waitForSelector('#inviteCode', { timeout: 5000 });
    await p.fill('#username', u); await p.fill('#password', PASS); await p.click('button[type="submit"]');
    await p.waitForURL('**/chat', { timeout: 30000 }); await p.waitForTimeout(1200);
    try { await p.check('.recovery-confirm input[type=checkbox]', { timeout: 4000 }); await p.click('.recovery-done-btn'); } catch { /* older */ }
    try { await p.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    return p;
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

/** Reload, select the (single) server, click the first non-AFK voice channel. */
async function joinVoice(p) {
    await p.reload(); await p.waitForTimeout(1800);
    await p.evaluate(() => {
        const i = [...document.querySelectorAll('.server-icon')].find(x => !/direct message|add server|join server|notes|tasks/i.test((x.getAttribute('title') || '') + ' ' + (x.className || '')));
        i?.click();
    });
    await p.waitForTimeout(1500);
    const ok = await p.evaluate(() => {
        const el = [...document.querySelectorAll('.voice-channel-list .voice-channel')].find(n => !n.classList.contains('afk'));
        if (el) { el.click(); return true; } return false;
    });
    await p.waitForTimeout(3500);
    return ok;
}

/** Rejoin WITHOUT reloading: click the same voice channel again. */
async function rejoinVoice(p) {
    const ok = await p.evaluate(() => {
        const el = [...document.querySelectorAll('.voice-channel-list .voice-channel')].find(n => !n.classList.contains('afk'));
        if (el) { el.click(); return true; } return false;
    });
    await p.waitForTimeout(1000);
    return ok;
}

/** Click the voice-panel disconnect control (leaves voice cleanly). */
async function leaveVoice(p) {
    const clicked = await p.evaluate(() => {
        const btn = document.querySelector('.voice-btn.disconnect');
        if (btn) { btn.click(); return true; }
        return false;
    });
    await p.waitForTimeout(1200);
    return clicked;
}

/** State of received remote audio: live track bound to an audio element. */
const remoteAudioState = (page) => page.evaluate(() => {
    const els = [...document.querySelectorAll('audio[id^="audio-"]')];
    for (const el of els) {
        const s = el.srcObject;
        const t = s?.getAudioTracks?.()[0];
        if (t) return { found: true, readyState: t.readyState, muted: t.muted, id: t.id };
    }
    return { found: false };
});

/** Wait until remote audio is live on the page (rebuild can take a few RTTs +
 *  the 3s stuck-recovery worst case). */
async function audioRecovers(page, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const s = await remoteAudioState(page);
        // muted===false matters: a track from a DEAD peer stays 'live' but
        // muted (no packets) — only an actually-flowing track counts.
        if (s.found && s.readyState === 'live' && s.muted === false) return true;
        await page.waitForTimeout(300);
    }
    return false;
}

/** Poll until `username`'s voice-list entry lights the speaking ring — driven
 *  by the receiver-side VAD on the DECODED remote stream, so it proves real
 *  audio energy is arriving (Chromium's fake mic plays a repeating tone). */
async function speakingLights(page, username, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const lit = await page.evaluate((u) => {
            return [...document.querySelectorAll('.voice-user-item.speaking, .voice-user.speaking')]
                .some(el => el.textContent.includes(u));
        }, username);
        if (lit) return true;
        await page.waitForTimeout(200);
    }
    return false;
}

async function startShare(p) {
    // Open the screen-share modal and go live (fake device auto-accepts).
    const opened = await p.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b =>
            /share|screen/i.test((b.getAttribute('title') || '') + ' ' + b.className) && !/stop/i.test(b.textContent));
        if (btn) { btn.click(); return true; } return false;
    });
    if (!opened) return false;
    await p.waitForTimeout(800);
    const live = await p.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(x => /go live|select screen/i.test(x.textContent));
        if (b) { b.click(); return true; } return false;
    });
    await p.waitForTimeout(4000);
    return live;
}

try {
    const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const pa = await reg(ctxA, A, glareErr.a);
    const pb = await reg(ctxB, B, glareErr.b);

    await createServer(pa, 'RejoinTest_' + stamp);
    const serverId = psql(`SELECT id FROM servers WHERE name='RejoinTest_${stamp}'`);
    const bId = psql(`SELECT id FROM users WHERE username='${B}'`);
    const aId = psql(`SELECT id FROM users WHERE username='${A}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bId})`);
    console.log(`server=${serverId} A=${A}(${aId}) B=${B}(${bId})`);

    // ---- 1. Baseline: both join, audio both ways --------------------------
    ck('A joins voice', await joinVoice(pa));
    ck('B joins voice', await joinVoice(pb));
    ck('baseline: A receives B audio', await audioRecovers(pa));
    ck('baseline: B receives A audio', await audioRecovers(pb));
    ck('baseline: A sees B speaking (decoded energy)', await speakingLights(pa, B));

    // ---- 2. Clean leave/rejoin by B (higher id), twice --------------------
    for (let i = 1; i <= 2; i++) {
        ck(`cycle ${i}: B leaves`, await leaveVoice(pb));
        await pb.waitForTimeout(1500);
        ck(`cycle ${i}: B rejoins`, await rejoinVoice(pb));
        ck(`cycle ${i}: A re-receives B audio`, await audioRecovers(pa));
        ck(`cycle ${i}: B re-receives A audio`, await audioRecovers(pb));
        ck(`cycle ${i}: A sees B speaking again`, await speakingLights(pa, B));
    }

    // ---- 3. Clean leave/rejoin by A (lower id) ----------------------------
    ck('A leaves', await leaveVoice(pa));
    await pa.waitForTimeout(1500);
    ck('A rejoins', await rejoinVoice(pa));
    ck('after A rejoin: A receives B audio', await audioRecovers(pa));
    ck('after A rejoin: B receives A audio', await audioRecovers(pb));
    ck('after A rejoin: B sees A speaking', await speakingLights(pb, A));

    // ---- 4. FIELD CASE: B shares screen, then RELOADS (unclean) -----------
    // A's pc for B accumulates screen m-lines; the reload sends no
    // StreamStopped, so A keeps that stale multi-m-line pc while B rejoins
    // with a fresh one — exactly the logged production failure.
    const shared = await startShare(pb);
    console.log(`  (B screen share started: ${shared})`);
    await pb.waitForTimeout(2500);
    ck('B reload-rejoins (unclean leave)', await joinVoice(pb));
    ck('after unclean rejoin: A re-receives B audio', await audioRecovers(pa, 20000));
    ck('after unclean rejoin: B re-receives A audio', await audioRecovers(pb, 20000));
    ck('after unclean rejoin: A sees B speaking', await speakingLights(pa, B, 20000));

    // ---- 5. THE EXACT FIELD CASE: A (lower id) reloads uncleanly while B
    // screen-shares. B keeps a stale multi-m-line pc for A; A rejoins with an
    // empty roster and offers fresh — on the old code B's stale pc threw the
    // m-line error (or wedged in glare) and the pair stayed silent FOREVER
    // (B's reconnect offers get impolite-ignored by A's own stuck offer).
    const shared2 = await startShare(pb); // B re-shares (its reload in case 4 ended the first share)
    console.log(`  (B screen share restarted: ${shared2})`);
    await pb.waitForTimeout(2500);
    ck('A reload-rejoins (unclean leave, lower id)', await joinVoice(pa));
    ck('field case: A re-receives B audio', await audioRecovers(pa, 20000));
    ck('field case: B re-receives A audio', await audioRecovers(pb, 20000));
    ck('field case: B sees A speaking', await speakingLights(pb, A, 20000));

    // ---- 6. No negotiation-fatal console errors anywhere -------------------
    ck('no m-line/InvalidAccessError on A', glareErr.a.length === 0);
    ck('no m-line/InvalidAccessError on B', glareErr.b.length === 0);

    console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
    process.exitCode = fail === 0 ? 0 : 1;
} finally {
    await browser.close();
}
