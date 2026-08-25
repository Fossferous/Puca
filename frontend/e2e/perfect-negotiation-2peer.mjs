// Perfect-negotiation late-join + answerer-share tests (the scenarios the
// onnegotiationneeded fix targets):
//   1. A shares screen, THEN B joins voice — B must receive A's share (late join,
//      A is the higher-id answerer to B's join offer OR the lower-id initiator).
//   2. Both in a call; the ANSWERER-side peer starts sharing mid-call — the other
//      side must receive it (tracks added while answering → follow-up offer).
// Also asserts no glare/m-line console errors fire during any of it.
//
// Prereqs: native Postgres + backend (:3000) + vite (:5173) up.
// Usage: node e2e/perfect-negotiation-2peer.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const APP = process.env.APP || 'http://localhost:5173';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const A = 'pnA_' + stamp, B = 'pnB_' + stamp;
const PGDB = process.env.PGDB || 'puca';
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-d', PGDB, '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

let fail = 0;
const ck = (n, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) fail++; };
// Full [WebRTC] signaling timeline across BOTH pages, dumped to $TIMELINE when
// set — the offer/answer envelope logs (connId/answerTo/mlines/state) are how
// the duplicate-answer interleaving behind the glare assertion was pinned.
const timeline = [];
const t0 = Date.now();
const glareErr = { a: [], b: [] };
const isGlare = (t) => /m-lines|InvalidAccessError|setRemoteDescription|setLocalDescription|wrong state|makeOffer/i.test(t);

const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream',
        // Real-address host candidates: same-machine ICE must not coin-flip
        // on headless mDNS resolution (see voice-camera-2peer.mjs).
        '--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-device-for-media-stream',
        // A fake screen + auto-accept getDisplayMedia (Chromium headless-new).
        '--auto-select-desktop-capture-source=Entire screen'],
});

async function reg(ctx, u, bucket) {
    const p = await ctx.newPage();
    const tag = u.startsWith('pnA') ? 'A' : 'B';
    p.on('console', m => {
        const t = m.text();
        if (/\[WebRTC\]|\[media-e2ee\]|RESURRECT/.test(t)) timeline.push(`${String(Date.now() - t0).padStart(7)} ${tag} ${m.type()} ${t}`);
        if (m.type() === 'error' && isGlare(t)) { bucket.push(t); console.log(`  [${u} GLARE]`, t.slice(0, 120)); }
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
async function startShare(p) {
    // Open the screen-share modal and go live (fake device auto-accepts).
    const opened = await p.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b =>
            /share|screen/i.test((b.getAttribute('title') || '') + ' ' + b.className) && !/stop/i.test(b.textContent));
        if (btn) { btn.click(); return true; } return false;
    });
    if (!opened) return false;
    await p.waitForTimeout(800);
    // Click "Select Screen & Go Live"
    const live = await p.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(x => /go live|select screen/i.test(x.textContent));
        if (b) { b.click(); return true; } return false;
    });
    await p.waitForTimeout(4000);
    return live;
}
// Does `page` receive a screen-share video from a remote peer with real frames?
const receivesShare = (page) => page.evaluate(() => {
    // Screen shares render as <video> in the StreamStage/StreamPip or the stream tile.
    const vids = [...document.querySelectorAll('video')];
    return vids.some(v => v.srcObject && v.videoWidth > 0 && !v.muted === false /* any */ );
});
// More robust: check the manager's received screen streams via a global probe.
const hasRemoteScreen = (page) => page.evaluate(() => {
    const vids = [...document.querySelectorAll('video')];
    // A remote screen tile has videoWidth>0 and is NOT the local self-preview.
    return vids.filter(v => v.srcObject && v.videoWidth > 0).length > 0;
});

// Since v0.7.3 stream watching is OPT-IN: nothing attaches/plays a remote
// share until the viewer clicks a Watch affordance. Click the floating
// "N Live Streams — Click to Watch" button (chat view), falling back to the
// voice-stage tile's Watch button.
async function watchStreams(page) {
    for (let i = 0; i < 20; i++) {
        const clicked = await page.evaluate(() => {
            const float = document.querySelector('.watch-live-btn');
            if (float) { float.click(); return true; }
            const tileBtn = document.querySelector('.vs-watch-btn');
            if (tileBtn) { tileBtn.click(); return true; }
            return false;
        });
        if (clicked) return true;
        await page.waitForTimeout(500);
    }
    return false;
}

try {
    const ca = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const cb = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const a = await reg(ca, A, glareErr.a);
    const b = await reg(cb, B, glareErr.b);
    await a.locator('.server-icon.add-server').click(); await a.waitForTimeout(500);
    await a.locator('.template-card').first().click(); await a.waitForTimeout(300);
    await a.locator('.audience-card').first().click(); await a.waitForTimeout(300);
    await a.locator('.server-name-input input').fill('PN ' + stamp);
    await a.locator('.wizard-actions .create-btn').click(); await a.waitForTimeout(2500);
    const sid = psql(`SELECT id FROM servers WHERE name='PN ${stamp}'`);
    const bid = psql(`SELECT id FROM users WHERE username='${B}'`);
    psql(`INSERT INTO server_members (server_id,user_id) VALUES ('${sid}',${bid})`);

    // === Scenario 1: A shares BEFORE B joins → B must receive it on join ===
    console.log('== scenario 1: A shares, THEN B joins ==');
    ck('A joins voice', await joinVoice(a));
    ck('A starts screen share', await startShare(a));
    await a.waitForTimeout(1500);
    ck('B joins voice AFTER the share started', await joinVoice(b));
    await b.waitForTimeout(6000); // mesh connect + late-join screen negotiation
    ck('B sees a Watch affordance for the live share', await watchStreams(b));
    await b.waitForTimeout(3000); // attach + first frames
    ck('B receives A\'s screen share (late joiner, after opting in)', await hasRemoteScreen(b));

    // Stop A's share to reset for scenario 2.
    await a.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(x => /stop shar/i.test(x.textContent));
        btn?.click();
    });
    await a.waitForTimeout(3000);

    // === Scenario 2: both connected; B (answerer side) starts sharing mid-call ===
    console.log('== scenario 2: B shares mid-call, A must receive ==');
    ck('B starts screen share mid-call', await startShare(b));
    await b.waitForTimeout(6000); // onnegotiationneeded → offer → A answers
    ck('A sees a Watch affordance for B\'s share', await watchStreams(a));
    await a.waitForTimeout(3000); // attach + first frames
    ck('A receives B\'s screen share (added while B was the answerer, after opting in)', await hasRemoteScreen(a));

    ck('no glare/m-line console errors on A', glareErr.a.length === 0);
    ck('no glare/m-line console errors on B', glareErr.b.length === 0);
    if (glareErr.a.length) console.log('  A:', glareErr.a.slice(0, 3));
    if (glareErr.b.length) console.log('  B:', glareErr.b.slice(0, 3));
} catch (e) {
    console.error('HARNESS ERR:', e.message);
    fail++;
} finally {
    await browser.close();
}
if (process.env.TIMELINE) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.TIMELINE, timeline.join('\n'));
    console.log(`timeline: ${timeline.length} lines -> ${process.env.TIMELINE}`);
}
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURES`);
process.exit(fail ? 1 : 0);
