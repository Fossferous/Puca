// LIVE: stopping your OWN share leaves the stream you are watching alone, on
// every surface and every way a share stops, on a mesh call and (SFU=1) on a
// LiveKit call.
//
// Reported again 2026-10-27 after the 0.9.840 fix: "when closing my stream, it
// still closes the streams im watching as well". 0.9.840 was proven only on a
// mesh call, on the stage (stop-own-share-keeps-watching.mjs). This sibling
// walks the rest:
//   surfaces: the stream stage, and the small player over a TEXT channel;
//   stops:    the voice panel's button, the stage's Stop Sharing, the stage's
//             right-click Stop Sharing, and the picture ending on its own
//             (the source's `ended`, as when the shared window closes);
//   sharer:   an ordinary member, and (STREAM_ONLY=1) a stream-only account
//             (docs/STREAM_ONLY.md) like the automated "TV" streams people
//             leave running.
// "Still watching" is measured, never assumed: a <video> inside that surface
// whose track is one this page RECEIVES, decoded frames rising across two
// reads, AND the sharer still in the watch selection. The positive control is
// the same measurement just before the stop (both sharing at once); the stop
// itself is proven by A's own capture leaving A's page.
//
// Headless Edge, --mute-audio, fake devices, synthetic screens (canvas): no
// real screen is captured, nothing is shown, nothing plays. Joins without a
// microphone.
// Needs a THROWAWAY backend + Postgres and a vite dev server of this tree
// (VITE_API_URL = that backend); SFU=1 also needs the backend wired to a
// loopback LiveKit (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET).
// Usage: APP=http://127.0.0.1:5194 [SFU=1] [STREAM_ONLY=1] [ONLY=pip-panel,...] node e2e/stop-own-share-surfaces.mjs
import { chromium } from '@playwright/test';

const APP = process.env.APP || 'http://127.0.0.1:5173';
const CHANNEL = process.env.CHANNEL || 'msedge';
const SFU = process.env.SFU === '1';
const STREAM_ONLY = process.env.STREAM_ONLY === '1';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const PASS = 'Password123!pw'; // a test value for the throwaway backend only
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 250) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(step); }
    return last;
}
const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
    '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'];

const PAGE_INIT = () => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...a) { const pc = new Native(...a); window.__pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = Native.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, Native);
    navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
        const g = c.getContext('2d'); let n = 0;
        setInterval(() => { n++; g.fillStyle = `hsl(${(n * 9) % 360} 50% 40%)`; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#fff'; g.font = '90px sans-serif'; g.fillText(String(n), 500, 380); }, 1000 / 15);
        const s = c.captureStream(15);
        window.__ownShareTrack = s.getVideoTracks()[0];
        return s;
    };
    try {
        const k = 'sovereign_settings';
        const s = JSON.parse(localStorage.getItem(k) || '{}');
        Object.assign(s, { joinWithoutMic: true, soundsEnabled: false, joinLeaveSound: false, voiceTTS: false, streamSound: false });
        localStorage.setItem(k, JSON.stringify(s));
    } catch { /* storage refused */ }
};

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); if (!ok) failed++; return ok; };

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
async function signUp(ctx, user, tag) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`  [${tag} pageerror] ${e.message.slice(0, 200)}`));
    page.on('console', (m) => { const t = m.text(); if (process.env.VERBOSE && /\[(VoicePanel|Chat|sfu|stream)/i.test(t)) console.log(`  [${tag}] ${t.slice(0, 240)}`); });
    await page.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 90000 });
    await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder('Choose a password (min 8 characters)').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 60000 });
    await sleep(1500);
    await dismiss(page);
    return page;
}
const call = (page, mod, fn, a = []) => page.evaluate(async ({ mod, fn, a }) => (await import(mod))[fn](...a), { mod, fn, a });
const uidOf = (p) => p.evaluate(() => { try { const t = localStorage.getItem('auth_token') || ''; return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { return null; } });
const selected = (p) => p.evaluate(async () => (await import('/src/components/voiceState.ts')).getSelectedStreams());

async function startShare(p) {
    await p.locator('[data-testid="voice-share-screen"]').click();
    await sleep(800);
    await p.evaluate(() => { [...document.querySelectorAll('button')].find(x => /go live|select screen/i.test(x.textContent))?.click(); });
    return !!await until(async () => (await p.locator('[data-testid="voice-stop-share"]').count()) > 0
        && await p.evaluate(() => window.__ownShareTrack?.readyState === 'live'), 20000);
}
/** A <video> inside `within` PLAYING a track this page receives; its decoded frames. */
const watching = (p, within) => p.evaluate(async (within) => {
    const remote = new Set();
    for (const pc of window.__pcs) {
        if (pc.connectionState === 'closed') continue;
        for (const r of pc.getReceivers()) if (r.track?.kind === 'video' && r.track.readyState === 'live') remote.add(r.track.id);
    }
    const root = document.querySelector(within);
    if (!root) return { playing: false, frames: 0, why: `no ${within}` };
    const vids = [...root.querySelectorAll('video')].filter(v => v.srcObject && v.videoWidth > 0 && !v.paused
        && v.srcObject.getVideoTracks().some(t => remote.has(t.id)));
    if (!vids.length) return { playing: false, frames: 0, why: 'no received video playing there', videos: root.querySelectorAll('video').length };
    const q = vids[0].getVideoPlaybackQuality?.();
    return { playing: true, frames: q ? q.totalVideoFrames : 0, w: vids[0].videoWidth };
}, within);
/** Is A's OWN capture still bound to any <video> on A's page, live? */
const showingOwn = (p) => p.evaluate(() => [...document.querySelectorAll('video')]
    .some(v => v.srcObject && v.srcObject.getVideoTracks().some(t => t === window.__ownShareTrack && t.readyState === 'live')));

const browsers = [];
try {
    const bA = await chromium.launch({ channel: CHANNEL, headless: true, args }); browsers.push(bA);
    const bB = await chromium.launch({ channel: CHANNEL, headless: true, args }); browsers.push(bB);
    const ctxA = await bA.newContext({ viewport: { width: 1400, height: 900 } });
    const ctxB = await bB.newContext({ viewport: { width: 1400, height: 900 } });
    for (const c of [ctxA, ctxB]) await c.addInitScript(PAGE_INIT);
    const A = await signUp(ctxA, `ssa_${stamp}`, 'A');
    const B = await signUp(ctxB, `ssb_${stamp}`, 'B');

    // Fixture: A's server with a text channel and a voice channel (sfu_mode on SFU=1); B joins by invite.
    const srv = await call(A, '/src/api/servers.ts', 'createServer', ['SS ' + stamp.slice(-4)]);
    const text = await call(A, '/src/api/servers.ts', 'createChannel', [srv.id, 'notes', 0]);
    const voice = await call(A, '/src/api/servers.ts', 'createChannel', [srv.id, 'Stage', 1]);
    if (SFU) await call(A, '/src/api/servers.ts', 'updateChannel', [voice.id, { sfu_mode: true }]);
    const inv = await call(A, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);
    await call(B, '/src/api/servers.ts', 'joinViaInvite', [inv.code]);
    const uid = { A: await uidOf(A), B: await uidOf(B) };
    if (STREAM_ONLY) {
        // The "Stream only" preset (RoleSettingsModal) opened for this voice channel (streamOnlyOverwrite.ts).
        const STREAM = 1 << 11, SO = 1 << 29, OPEN = (1 << 0) | (1 << 8) | (1 << 11);
        const role = await call(A, '/src/api/servers.ts', 'createRole', [srv.id, { name: 'Stream only', color: '#99AAB5', permissions: STREAM | SO }]);
        await call(A, '/src/api/channels.ts', 'putChannelOverwrite', [voice.id, role.id, OPEN, 0]);
        await call(A, '/src/api/servers.ts', 'assignRole', [srv.id, uid.B, role.id]);
    }
    check(`fixture: server, text + ${SFU ? 'SFU' : 'mesh'} voice channel, B a member${STREAM_ONLY ? ' with the Stream only role' : ''}`,
        !!srv.id && !!text.id && !!voice.id && Number.isInteger(uid.A) && Number.isInteger(uid.B), uid);
    for (const p of [A, B]) { await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(2500); await dismiss(p); }
    for (const [tag, p] of [['B', B], ['A', A]]) {
        await p.locator(`[data-testid="server-icon"][data-server-id="${srv.id}"]`).click();
        await sleep(800);
        await p.locator(`[data-testid="voice-channel"][data-channel-id="${voice.id}"]`).click();
        check(`${tag} is in the call`, !!await until(async () => (await p.locator('[data-testid="voice-connected"]').count()) > 0, 25000));
    }
    if (STREAM_ONLY) check('A knows B is stream-only', !!await until(() => A.evaluate(async (id) => (await import('/src/components/voiceState.ts')).isStreamOnlyMember(id), uid.B), 10000));
    await sleep(3000);
    check('B shares its screen', await startShare(B));
    check('A sees B live', !!await until(() => A.evaluate(async (id) => (await import('/src/components/voiceState.ts')).getAllStreamers().some(s => s.userId === id), uid.B), 15000));

    const SURF = { stage: '.stream-stage', pip: '.stream-pip' };
    /** Put A on `surface`, watching B. */
    async function watchOn(surface) {
        if (!(await selected(A)).includes(uid.B)) {
            // A person's click: the voice stage's Watch, or the floating Live Streams button.
            await A.locator(`[data-testid="voice-channel"][data-channel-id="${voice.id}"]`).click().catch(() => {});
            await sleep(600);
            await until(() => A.evaluate(() => { const b = document.querySelector('.watch-live-btn'); if (b) { b.click(); return true; } return false; }), 8000);
            await sleep(500);
            await until(() => A.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /^watch/i.test((x.textContent || '').trim())); if (b) { b.click(); return true; } return false; }), 4000);
        }
        if (surface === 'pip') {
            await A.locator('.channel', { hasText: 'notes' }).first().click();
        } else if ((await A.locator('.stream-stage').count()) === 0) {
            const exp = A.getByRole('button', { name: 'Expand to full view' });
            if (await exp.count()) await exp.first().click();
        }
        return until(async () => {
            const w = await watching(A, SURF[surface]);
            return w.playing && (surface !== 'pip' || (await A.locator('.stream-stage').count()) === 0) ? w : null;
        }, 20000);
    }
    const STOPS = {
        panel: () => A.locator('[data-testid="voice-stop-share"]').click().then(() => true, () => false),
        'stage-button': () => A.evaluate(() => { const b = document.querySelector('.stop-watching-btn'); if (!b) return false; b.click(); return true; }),
        'stage-menu': async (ownName) => {
            const tile = A.locator('.stream-tile', { has: A.locator('.streamer-name', { hasText: ownName }) }).first();
            if (!(await tile.count())) return false;
            await tile.click({ button: 'right' });
            const item = A.locator('.scm-item.scm-danger', { hasText: 'Stop Sharing' }).first();
            if (!(await until(async () => (await item.count()) > 0, 3000))) return false;
            await item.click();
            return true;
        },
        // The shared window closing / the browser's own stop: the capture's track ends.
        ended: () => A.evaluate(() => { const t = window.__ownShareTrack; if (!t) return false; t.stop(); t.dispatchEvent(new Event('ended')); return true; }),
    };
    const PLAN = [
        ['stage', 'panel'], ['stage', 'stage-button'], ['stage', 'stage-menu'], ['stage', 'ended'],
        ['pip', 'panel'], ['pip', 'ended'],
    ].filter(([s, h]) => !ONLY.length || ONLY.includes(`${s}-${h}`));

    for (const [surface, how] of PLAN) {
        const tag = `${SFU ? 'sfu' : 'mesh'}/${surface}/${how}`;
        const w0 = await watchOn(surface);
        check(`${tag}: control: A watches B on the ${surface === 'pip' ? 'small player over the chat' : 'stage'}`, !!w0?.playing, w0 ?? (await watching(A, SURF[surface])));
        check(`${tag}: A starts sharing too`, await startShare(A));
        await sleep(3000);
        if (surface === 'stage') check(`${tag}: control: A's own stream is on A's stage`, await showingOwn(A));
        const before1 = await watching(A, SURF[surface]);
        await sleep(1500);
        const before2 = await watching(A, SURF[surface]);
        check(`${tag}: POSITIVE CONTROL: A still plays B's stream there while both share (frames rising)`,
            before1.playing && before2.playing && before2.frames > before1.frames, { before1, before2 });
        check(`${tag}: control: B is in A's watch selection before the stop`, (await selected(A)).includes(uid.B), await selected(A));
        const stopped = await STOPS[how](`ssa_${stamp}`);
        check(`${tag}: A stops its own share (${how})`, stopped);
        const gone = await until(async () => (await A.locator('[data-testid="voice-share-screen"]').count()) > 0 && !(await showingOwn(A)), 8000);
        check(`${tag}: the stop took: A is no longer sharing and its own picture left the page`, !!gone);
        await sleep(2500);
        const sel = await selected(A);
        const after1 = await watching(A, SURF[surface]);
        await sleep(2000);
        const after2 = await watching(A, SURF[surface]);
        check(`${tag}: B is STILL in A's watch selection after A stopped its own share`, sel.includes(uid.B), { selected: sel, B: uid.B });
        check(`${tag}: A is STILL playing B's stream on the same surface (frames rising)`,
            after1.playing && after2.playing && after2.frames > after1.frames, { after1, after2 });
        // The next round starts from watching again, whatever this one did.
        await sleep(1000);
    }
} catch (e) {
    check('the run itself', false, e?.stack || String(e));
} finally {
    for (const b of browsers) await b.close().catch(() => {});
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
