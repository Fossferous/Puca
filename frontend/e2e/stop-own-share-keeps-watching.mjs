// LIVE: stopping your OWN share leaves the streams you are watching alone.
//
// Reported 2026-10-19: "Whenever a user is streaming whilst watching a stream,
// and they end their stream, it closes the stream(s) they're watching too."
// Every stop path ran clearAllStreams(), which is for leaving the call: it
// dropped every selected stream and everyone's share from the stream list.
//
// Two real clients in a throwaway call. B shares and A watches it; A shares
// too; A stops its own share - once with the voice panel's Share button, once
// with the stage's Stop Sharing button. After each stop, A must still be
// PLAYING B's stream: a <video> on the page whose track is one A RECEIVES,
// with decoded frames still rising. The positive control is the state before
// the stop (the same measurement must see B's stream), and A's own stream
// must be gone from A's stage (the stop did stop).
//
// Headless Edge, --mute-audio, fake devices, synthetic screens (canvas): no
// real screen is captured, nothing is shown, nothing plays.
// Needs a THROWAWAY backend + Postgres and the built client served at APP.
// Usage: APP=http://127.0.0.1:7921 PGPORT=55437 PGDB=... PGPASSWORD=... node e2e/stop-own-share-keeps-watching.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const APP = process.env.APP || 'http://127.0.0.1:5173';
const CHANNEL = process.env.CHANNEL || 'msedge';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-p', process.env.PGPORT || '5432', '-d', process.env.PGDB || 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' } }).toString().trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 250) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(step); }
    return last;
}
const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required',
    '--host-resolver-rules=MAP svrn.lol ~NOTFOUND, MAP *.svrn.lol ~NOTFOUND'];

const keepPeerConnections = () => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...a) { const pc = new Native(...a); window.__pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = Native.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, Native);
};
const syntheticScreen = () => {
    navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
        const g = c.getContext('2d'); let n = 0;
        setInterval(() => { n++; g.fillStyle = `hsl(${(n * 9) % 360} 50% 40%)`; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#fff'; g.font = '90px sans-serif'; g.fillText(String(n), 500, 380); }, 1000 / 15);
        const s = c.captureStream(15);
        window.__ownShareTrack = s.getVideoTracks()[0].id;
        return s;
    };
};

async function register(ctx, u) {
    const p = await ctx.newPage();
    await p.goto(APP + '/login');
    await p.waitForSelector('#username', { timeout: 30_000 });
    await p.click('.toggle-mode');
    await p.fill('#username', u); await p.fill('#password', PASS); await p.click('button[type="submit"]');
    await p.waitForURL('**/chat', { timeout: 60_000 }); await p.waitForTimeout(1200);
    try { await p.check('.recovery-confirm input[type=checkbox]', { timeout: 4000 }); await p.click('.recovery-done-btn'); } catch { /* none */ }
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
async function joinVoice(p) {
    await p.reload(); await p.waitForTimeout(2000);
    await p.evaluate(() => {
        const i = [...document.querySelectorAll('.server-icon')].find(x => !/direct message|add server|join server|notes|tasks/i.test((x.getAttribute('title') || '') + ' ' + (x.className || '')));
        i?.click();
    });
    await p.waitForTimeout(1500);
    const ok = await p.evaluate(() => {
        const el = [...document.querySelectorAll('.voice-channel-list .voice-channel')].find(n => !n.classList.contains('afk'));
        if (el) { el.click(); return true; } return false;
    });
    await p.waitForTimeout(3000);
    return ok;
}
async function startShare(p) {
    const opened = await p.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === 'Share Screen' && !x.disabled);
        if (b) { b.click(); return true; } return false;
    });
    if (!opened) return false;
    await p.waitForTimeout(800);
    await p.evaluate(() => { [...document.querySelectorAll('button')].find(x => /go live|select screen/i.test(x.textContent))?.click(); });
    return !!await until(() => p.evaluate(() => !!window.__ownShareTrack
        && !!document.querySelector('button[title="Stop Sharing"], .voice-btn.vp-screenshare.active')), 15000);
}
/** Is the page PLAYING a stream it receives (not its own capture)? Frames decoded on it. */
const watchingRemote = (p) => p.evaluate(async () => {
    const remote = new Set();
    for (const pc of window.__pcs) {
        if (pc.connectionState === 'closed') continue;
        for (const r of pc.getReceivers()) if (r.track?.kind === 'video' && r.track.readyState === 'live') remote.add(r.track.id);
    }
    const vids = [...document.querySelectorAll('video')].filter(v => v.srcObject && v.videoWidth > 0 && !v.paused
        && v.srcObject.getVideoTracks().some(t => remote.has(t.id)));
    if (!vids.length) return { playing: false, frames: 0 };
    const v = vids[0];
    const q = v.getVideoPlaybackQuality?.();
    return { playing: true, frames: q ? q.totalVideoFrames : 0, w: v.videoWidth };
});
/** Is A's OWN capture still shown on A's stage? */
const showingOwn = (p) => p.evaluate(() => [...document.querySelectorAll('video')]
    .some(v => v.srcObject && v.srcObject.getVideoTracks().some(t => t.id === window.__ownShareTrack && t.readyState === 'live')));

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

const bA = await chromium.launch({ channel: CHANNEL, args });
const bB = await chromium.launch({ channel: CHANNEL, args });
try {
    const ctxA = await bA.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1400, height: 900 } });
    const ctxB = await bB.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1400, height: 900 } });
    for (const c of [ctxA, ctxB]) { await c.addInitScript(keepPeerConnections); await c.addInitScript(syntheticScreen); }
    const A = await register(ctxA, `sk_a_${stamp}`);
    const B = await register(ctxB, `sk_b_${stamp}`);
    const serverName = 'StopOwn_' + stamp;
    await createServer(B, serverName);
    const sid = psql(`SELECT id FROM servers WHERE name='${serverName}'`);
    const aid = psql(`SELECT id FROM users WHERE username='sk_a_${stamp}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${sid}', ${aid}) ON CONFLICT DO NOTHING`);
    if (process.env.SFU === '1') psql(`UPDATE channels SET sfu_mode = true WHERE server_id='${sid}' AND type=1 AND NOT is_afk`);
    check('B joins voice', await joinVoice(B));
    check('A joins voice', await joinVoice(A));
    await sleep(4000);

    check('B starts sharing', await startShare(B));
    const clicked = await until(() => A.evaluate(() => { const b = document.querySelector('.watch-live-btn'); if (b) { b.click(); return true; } return false; }), 15000);
    check('A clicks to watch B', !!clicked);
    const w0 = await until(async () => { const w = await watchingRemote(A); return w.playing ? w : null; }, 20000);
    check("control: A is playing B's stream", !!w0?.playing, JSON.stringify(w0));

    for (const how of ['panel', 'stage']) {
        check(`${how}: A starts sharing too`, await startShare(A));
        await sleep(3000);
        check(`${how}: control: A's own stream is on A's stage`, await showingOwn(A));
        const before = await watchingRemote(A);
        check(`${how}: control: A still plays B's stream while both share`, before.playing, JSON.stringify(before));
        const stopped = await A.evaluate((how) => {
            const b = how === 'panel'
                ? [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === 'Stop Sharing' && x.classList.contains('vp-screenshare'))
                : document.querySelector('.stop-watching-btn');
            if (!b) return false;
            b.click(); return true;
        }, how);
        check(`${how}: A stops its own share (${how === 'panel' ? "the voice panel's button" : "the stage's Stop Sharing"})`, stopped);
        await sleep(3000);
        check(`${how}: A's own stream left A's stage`, !(await showingOwn(A)));
        const after1 = await watchingRemote(A);
        await sleep(2000);
        const after2 = await watchingRemote(A);
        check(`${how}: A is STILL playing B's stream after stopping its own`, after1.playing && after2.playing && after2.frames > after1.frames,
            JSON.stringify({ after1, after2 }));
        // Put it back for the next round if the bug closed it.
        if (!after2.playing) {
            await until(() => A.evaluate(() => { const b = document.querySelector('.watch-live-btn'); if (b) { b.click(); return true; } return false; }), 8000);
            await until(async () => (await watchingRemote(A)).playing, 10000);
        }
    }
} finally {
    await bA.close().catch(() => {});
    await bB.close().catch(() => {});
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
