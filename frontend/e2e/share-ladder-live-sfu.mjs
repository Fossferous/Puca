// A screen share sent at several sizes, end to end in the REAL app over a
// real SFU: does Automatic ladder it, does a live quality change re-size the
// rungs in place, does a change between one size and several re-publish
// without losing the viewer, and does a changed setting reach the running
// share?
//
// WHY. sfuManager decides the ladder (shareLadder.ts), re-sizes a running
// ladder with setParameters and re-publishes on a transition; the unit tests
// drive it against a fake room. This walks the built client: two headless
// browsers, a throwaway backend whose SFU is a loopback LiveKit, the app's own
// share button and its own Stream quality panel. The viewer must keep
// decoding through every change.
//
// Phases (sharer captures a 2560x1440 canvas at 60 fps; Settings → Automatic):
//   A  share at 1440p60          expect 3 encodings (if this browser offers a
//                                hardware H.264 encoder) with a 720p middle rung
//   B  Stream quality -> 1080p   expect the SAME sender, rungs re-scaled in
//                                place (q 360 lines, h 720, f 1080)
//   C  Stream quality -> 720p30  expect one encoding (4 Mbps: Automatic says
//                                one size): a re-publish
//   D  Stream quality -> 1080p60 expect 3 encodings again
//   E  Stream quality -> 720p60  expect the SAME sender, the middle rung now
//                                540p (q 360, h 540, f 720 lines): 6 Mbps is
//                                still a ladder under Automatic
//   F  Settings -> Never         expect one encoding at once (a re-publish),
//      then Automatic again      and the ladder back (another re-publish),
//                                through the real Settings > Voice & Video
//   G  the shared "window" shrinks expect the SAME sender, its rungs re-sized
//      to 1152x648               in place by the follow check (q 360, h 540
//                                lines): no quality change was asked for
// After each, the viewer's decoded frame rate over a few seconds; across each
// RE-publish (C, D, F) also the longest stretch with no new frame on the
// viewer, sampled every 100 ms: what "the picture holds" costs.
//
// Everything is headless and muted: nothing opens on the desktop, nothing plays.
//
// Prereqs: Postgres (PGPORT / PGDB, password postgres), a throwaway backend
// with LIVEKIT_URL / _API_KEY / _API_SECRET pointing at a loopback LiveKit
// (header of share-adapt-shaped.mjs) and CORS allowing APP, and the client
// built against it served at APP (`DIST=<dir> PORT=… node e2e/serve-dist.mjs`).
// Usage: APP=http://127.0.0.1:5181 PGPORT=5433 PGDB=puca_ladder node e2e/share-ladder-live-sfu.mjs [out.json]
// Exit 1 on any failed expectation; a browser with no hardware encoder makes
// phases A, B and D report SKIP (Automatic correctly stays one size there).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const APP = process.env.APP || 'http://127.0.0.1:5181';
const CHANNEL = process.env.CHANNEL || 'msedge';
const OUT = process.argv[2] || '';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-p', process.env.PGPORT || '5432', '-d', process.env.PGDB || 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const baseArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required',
    '--allow-loopback-in-peer-connection',
    '--host-resolver-rules=MAP svrn.lol ~NOTFOUND, MAP *.svrn.lol ~NOTFOUND'];
let liveAttempts = 0;
const blockLive = async (ctx) => {
    await ctx.route(/https?:\/\/([^/]*\.)?svrn\.lol(\/|$)/, (route) => { liveAttempts++; return route.abort(); });
};

const keepPeerConnections = () => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...a) { const pc = new Native(...a); window.__pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = Native.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, Native);
};

/** The sharer's screen: a 2560x1440 canvas at 60 fps with real motion. */
const syntheticScreen = () => {
    navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 2560; c.height = 1440;
        // Phase G resizes it, as a shared window is resized.
        window.__screenCanvas = c;
        const g = c.getContext('2d');
        let n = 0;
        const draw = () => {
            const w = c.width, h = c.height;
            n++;
            g.fillStyle = `hsl(${(n * 7) % 360} 40% 20%)`; g.fillRect(0, 0, w, h);
            for (let i = 0; i < 24; i++) {
                g.fillStyle = `hsl(${(i * 15 + n * 3) % 360} 70% 55%)`;
                g.fillRect(((i * 97 + n * 13) % w), (i * h) / 24, w / 6, h / 30);
            }
            g.fillStyle = '#fff'; g.font = `${Math.round(h / 8)}px sans-serif`;
            g.fillText(String(n), w / 3, h / 2);
        };
        draw();
        setInterval(draw, 1000 / 60);
        window.__synthetic = true;
        return c.captureStream(60);
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
        const btn = [...document.querySelectorAll('button')].find(b =>
            /share|screen/i.test((b.getAttribute('title') || '') + ' ' + b.className) && !/stop/i.test(b.textContent));
        if (btn) { btn.click(); return true; } return false;
    });
    if (!opened) return false;
    await p.waitForTimeout(800);
    await p.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(x => /go live|select screen/i.test(x.textContent));
        b?.click();
    });
    await p.waitForTimeout(5000);
    return p.evaluate(() => !!window.__synthetic);
}

/** The app's own Stream quality panel (OPEN_SHARE_QUALITY_EVENT), then its buttons. */
async function liveQuality(p, resolution, fps) {
    await p.evaluate(() => window.dispatchEvent(new CustomEvent('sovereign:open-share-quality')));
    await p.waitForTimeout(800);
    const click = async (label) => p.evaluate((l) => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent?.trim() === l);
        if (!b) return false;
        b.click();
        return true;
    }, label);
    const r = await click(resolution);
    await p.waitForTimeout(1500);
    const f = await click(`${fps} fps`);
    await p.waitForTimeout(1500);
    const status = await p.evaluate(() => document.querySelector('.modal-content, [role="dialog"]')?.textContent ?? '');
    await click('Done');
    await p.waitForTimeout(500);
    return { clicked: r && f, status: status.slice(0, 200) };
}

/** Settings > Voice & Video > Send my screen at several sizes, through the UI. */
async function setLadderSetting(p, value) {
    await p.locator('button[title="Settings"]').first().click({ timeout: 5000 });
    await p.locator('.settings-nav-item', { hasText: 'Voice & Video' }).first().click({ timeout: 5000 });
    const sel = p.locator('#share-ladder-mode');
    await sel.waitFor({ timeout: 5000 });
    await sel.selectOption(value);
    const now = await sel.inputValue();
    await p.locator('button.settings-close').first().click({ timeout: 5000 }).catch(() => p.keyboard.press('Escape'));
    await p.waitForTimeout(500);
    return now;
}

/** Every sender carrying the live share track: its encodings, and a token
 *  that stays the same while it is the same RTCRtpSender object. */
const readShareSenders = async () => {
    window.__senderIds = window.__senderIds || new WeakMap();
    window.__nextSenderId = window.__nextSenderId || 1;
    const out = [];
    for (const pc of window.__pcs) {
        for (const s of pc.getSenders()) {
            if (s.track?.kind !== 'video' || s.track.readyState !== 'live') continue;
            if (!window.__senderIds.has(s)) window.__senderIds.set(s, window.__nextSenderId++);
            const p = s.getParameters();
            const st = await s.getStats();
            const rows = [];
            st.forEach(r => { if (r.type === 'outbound-rtp') rows.push({ rid: r.rid ?? null, size: r.frameWidth ? `${r.frameWidth}x${r.frameHeight}` : null, fps: r.framesPerSecond ?? null, encoder: r.encoderImplementation ?? null }); });
            out.push({
                id: window.__senderIds.get(s),
                capture: (() => { const t = s.track.getSettings(); return `${t.width}x${t.height}@${Math.round(t.frameRate ?? 0)}`; })(),
                encodings: (p.encodings ?? []).map(e => ({ rid: e.rid ?? null, scale: e.scaleResolutionDownBy ?? null, maxBitrate: e.maxBitrate ?? null, active: e.active })),
                rows,
            });
        }
    }
    return out;
};

const readDecoded = async () => {
    let frames = 0; const sizes = [];
    for (const pc of window.__pcs) {
        (await pc.getStats()).forEach(r => {
            if (r.type === 'inbound-rtp' && r.kind === 'video' && r.framesDecoded) { frames += r.framesDecoded; if (r.frameWidth) sizes.push(`${r.frameWidth}x${r.frameHeight}`); }
        });
    }
    return { frames, sizes };
};

/** Run `act` while sampling the viewer's decoded frames every 100 ms, and
 *  return the longest stretch (ms) in which none arrived. */
async function frameGap(viewer, act, ms = 9000) {
    await viewer.evaluate(() => {
        const g = { samples: [] };
        window.__gap = g;
        g.timer = setInterval(async () => {
            let frames = 0;
            for (const pc of window.__pcs) {
                (await pc.getStats()).forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video' && r.framesDecoded) frames += r.framesDecoded; });
            }
            g.samples.push([performance.now(), frames]);
        }, 100);
    });
    const out = await act();
    await sleep(ms);
    const samples = await viewer.evaluate(() => { clearInterval(window.__gap.timer); return window.__gap.samples; });
    let longest = 0;
    let since = samples[0]?.[0] ?? 0;
    for (let i = 1; i < samples.length; i++) {
        if (samples[i][1] > samples[i - 1][1]) since = samples[i][0];
        else longest = Math.max(longest, samples[i][0] - since);
    }
    return { out, gapMs: Math.round(longest), samples: samples.length };
}

async function viewerRate(viewer, ms = 6000) {
    const a = await viewer.evaluate(readDecoded);
    await sleep(ms);
    const b = await viewer.evaluate(readDecoded);
    return { fps: Math.round(((b.frames - a.frames) / (ms / 1000)) * 10) / 10, sizes: b.sizes };
}

const sharerBrowser = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args: baseArgs });
const viewerBrowser = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args: baseArgs });
const users = [`ld0_${stamp}`, `ld1_${stamp}`];
const result = { app: APP, phases: {}, checks: [] };
const check = (name, ok, detail) => { result.checks.push({ name, ok, detail }); console.log(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`); };

try {
    const sctx = await sharerBrowser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 800 } });
    await blockLive(sctx);
    await sctx.addInitScript(keepPeerConnections);
    await sctx.addInitScript(() => {
        try {
            const cur = JSON.parse(localStorage.getItem('sovereign_settings') || '{}');
            localStorage.setItem('sovereign_settings', JSON.stringify({ ...cur, shareFps: 60, shareResolution: '1440', shareLadder: 'auto', shareSimulcast: false }));
        } catch { /* storage unavailable */ }
    });
    await sctx.addInitScript(syntheticScreen);
    const vctx = await viewerBrowser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1600, height: 1000 } });
    await blockLive(vctx);
    await vctx.addInitScript(keepPeerConnections);
    const sharer = await register(sctx, users[0]);
    const viewer = await register(vctx, users[1]);

    const serverName = 'Ladder_' + stamp;
    await createServer(sharer, serverName);
    const serverId = psql(`SELECT id FROM servers WHERE name='${serverName}'`);
    const vid = psql(`SELECT id FROM users WHERE username='${users[1]}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${vid}) ON CONFLICT DO NOTHING`);
    psql(`UPDATE channels SET sfu_mode = true WHERE server_id = '${serverId}'`);
    for (const p of [sharer, viewer]) {
        if (!await joinVoice(p)) throw new Error('could not find the voice channel to join');
    }
    await sleep(6000);
    result.hardwareH264 = await sharer.evaluate(() => (RTCRtpSender.getCapabilities('video')?.codecs ?? [])
        .some(c => c.mimeType === 'video/H264' && /profile-level-id=64/i.test(c.sdpFmtpLine ?? '') && /packetization-mode=1/.test(c.sdpFmtpLine ?? '')));
    console.log(`hardware H.264 offered in the sharer's browser: ${result.hardwareH264}`);

    if (!await startShare(sharer)) throw new Error('the share did not start on the synthetic source');
    let watching = false;
    for (let i = 0; i < 40 && !watching; i++) {
        watching = await viewer.evaluate(() => { const b = document.querySelector('.watch-live-btn'); if (b) { b.click(); return true; } return false; });
        if (!watching) await sleep(250);
    }
    if (!watching) throw new Error('the viewer never got a "Click to Watch" button');
    await sleep(8000);

    // A: the share as published.
    const a = await sharer.evaluate(readShareSenders);
    result.phases.A = { senders: a, viewer: await viewerRate(viewer) };
    const aSender = a.find(s => s.capture.startsWith('2560x1440')) ?? a[0];
    const laddered = (s) => (s?.encodings.length ?? 0) === 3;
    if (result.hardwareH264) {
        check('A: Automatic ladders 1440p60 on a hardware encoder', laddered(aSender), aSender?.encodings);
        const h = aSender?.encodings.find(e => e.rid === 'h');
        check('A: the middle rung is 720p', h ? Math.round(1440 / h.scale) === 720 : false, h);
    } else {
        check('A: no hardware encoder here, Automatic stays one size', !laddered(aSender) ? null : false, aSender?.encodings);
    }
    check('A: the viewer is watching', result.phases.A.viewer.fps > 10, result.phases.A.viewer);
    // One watched share fills the stage: it must get the TOP rung, not the
    // middle one (subscribedQuality; the first run of this walk got 720p).
    check('A: the only watched share arrives full size', result.phases.A.viewer.sizes.includes('2560x1440'), result.phases.A.viewer.sizes);

    // B: 1440p -> 1080p, still 60 fps: in place.
    result.phases.B = { change: await liveQuality(sharer, '1080p', 60) };
    await sleep(3000);
    const b = await sharer.evaluate(readShareSenders);
    result.phases.B.senders = b;
    result.phases.B.viewer = await viewerRate(viewer);
    const bSender = b.find(s => s.capture.startsWith('1920x1080')) ?? b[0];
    if (laddered(aSender)) {
        check('B: the same sender (no re-publish)', bSender?.id === aSender.id, { before: aSender.id, after: bSender?.id });
        const sc = Object.fromEntries((bSender?.encodings ?? []).map(e => [e.rid, e.scale]));
        check('B: rungs re-sized in place: 360 / 720 / 1080 lines', sc.q === 3 && sc.h === 1.5 && sc.f === 1, sc);
    } else {
        check('B: (one-size share) capture re-capped', bSender?.capture.startsWith('1920x1080') ? null : false, bSender?.capture);
    }
    check('B: the viewer kept watching', result.phases.B.viewer.fps > 10, result.phases.B.viewer);
    check('B: still full size, now 1080p', result.phases.B.viewer.sizes.includes('1920x1080'), result.phases.B.viewer.sizes);

    // C: -> 720p30: 4 Mbps, one size.
    const cGap = await frameGap(viewer, () => liveQuality(sharer, '720p', 30));
    result.phases.C = { change: cGap.out, gapMs: cGap.gapMs };
    console.log(`C: longest stretch without a new frame on the viewer: ${cGap.gapMs} ms`);
    const c = await sharer.evaluate(readShareSenders);
    result.phases.C.senders = c;
    result.phases.C.viewer = await viewerRate(viewer);
    const cSender = c.find(s => s.capture.startsWith('1280x720')) ?? c[0];
    check('C: one encoding at 720p30', (cSender?.encodings.length ?? 0) === 1, cSender?.encodings);
    if (laddered(bSender)) check('C: re-published (a new sender)', cSender?.id !== bSender.id, { before: bSender.id, after: cSender?.id });
    check('C: the viewer kept watching after the switch', result.phases.C.viewer.fps > 10, result.phases.C.viewer);

    // D: -> 1080p60: a ladder again.
    const dGap = await frameGap(viewer, () => liveQuality(sharer, '1080p', 60));
    result.phases.D = { change: dGap.out, gapMs: dGap.gapMs };
    console.log(`D: longest stretch without a new frame on the viewer: ${dGap.gapMs} ms`);
    const d = await sharer.evaluate(readShareSenders);
    result.phases.D.senders = d;
    result.phases.D.viewer = await viewerRate(viewer);
    const dSender = d.find(s => s.capture.startsWith('1920x1080')) ?? d[0];
    if (result.hardwareH264) check('D: a ladder again at 1080p60', laddered(dSender), dSender?.encodings);
    check('D: the viewer kept watching after the switch', result.phases.D.viewer.fps > 10, result.phases.D.viewer);
    check('D: full size again', result.phases.D.viewer.sizes.includes('1920x1080'), result.phases.D.viewer.sizes);

    // E: 1080p60 -> 720p60 (6 Mbps, still a ladder): in place, middle rung 540p.
    result.phases.E = { change: await liveQuality(sharer, '720p', 60) };
    await sleep(3000);
    const e = await sharer.evaluate(readShareSenders);
    result.phases.E.senders = e;
    result.phases.E.viewer = await viewerRate(viewer);
    const eSender = e.find(s => s.capture.startsWith('1280x720')) ?? e[0];
    if (laddered(dSender)) {
        check('E: the same sender (no re-publish)', eSender?.id === dSender.id, { before: dSender.id, after: eSender?.id });
        const sc = Object.fromEntries((eSender?.encodings ?? []).map(x => [x.rid, x.scale]));
        check('E: rungs re-sized in place: 360 / 540 / 720 lines', sc.q === 2 && Math.abs(sc.h - 720 / 540) < 1e-6 && sc.f === 1, sc);
        const h = eSender?.encodings.find(x => x.rid === 'h');
        check('E: the middle rung sends 540p\'s bitrate', h?.maxBitrate === 1_200_000, h);
    }
    check('E: the viewer kept watching', result.phases.E.viewer.fps > 10, result.phases.E.viewer);
    check('E: full size, now 720p', result.phases.E.viewer.sizes.includes('1280x720'), result.phases.E.viewer.sizes);

    // F: the setting itself, changed while sharing.
    const fGap1 = await frameGap(viewer, () => setLadderSetting(sharer, 'never'));
    result.phases.F = { never: fGap1.out, neverGapMs: fGap1.gapMs };
    console.log(`F: Never: longest stretch without a new frame on the viewer: ${fGap1.gapMs} ms`);
    const f1 = await sharer.evaluate(readShareSenders);
    const f1Sender = f1.find(s => s.capture.startsWith('1280x720')) ?? f1[0];
    result.phases.F.afterNever = { senders: f1, viewer: await viewerRate(viewer) };
    check('F: Never sends one size at once', (f1Sender?.encodings.length ?? 0) === 1, f1Sender?.encodings);
    if (laddered(eSender)) check('F: ...by publishing again (a new sender)', f1Sender?.id !== eSender.id, { before: eSender.id, after: f1Sender?.id });
    check('F: the viewer kept watching after Never', result.phases.F.afterNever.viewer.fps > 10, result.phases.F.afterNever.viewer);
    const fGap2 = await frameGap(viewer, () => setLadderSetting(sharer, 'auto'));
    result.phases.F.auto = fGap2.out;
    result.phases.F.autoGapMs = fGap2.gapMs;
    console.log(`F: Automatic: longest stretch without a new frame on the viewer: ${fGap2.gapMs} ms`);
    const f2 = await sharer.evaluate(readShareSenders);
    const f2Sender = f2.find(s => s.capture.startsWith('1280x720')) ?? f2[0];
    result.phases.F.afterAuto = { senders: f2, viewer: await viewerRate(viewer) };
    if (result.hardwareH264) {
        check('F: Automatic again brings the ladder back', laddered(f2Sender), f2Sender?.encodings);
        check('F: ...on a new sender', f2Sender?.id !== f1Sender?.id, { before: f1Sender?.id, after: f2Sender?.id });
    }
    check('F: the viewer kept watching after Automatic', result.phases.F.afterAuto.viewer.fps > 10, result.phases.F.afterAuto.viewer);
    check('F: ...at full size', result.phases.F.afterAuto.viewer.sizes.includes('1280x720'), result.phases.F.afterAuto.viewer.sizes);
    for (const [name, ms] of [['C', cGap.gapMs], ['D', dGap.gapMs], ['F Never', fGap1.gapMs], ['F Automatic', fGap2.gapMs]]) {
        check(`${name}: the picture held for under 3 s across the re-publish`, ms < 3000, { gapMs: ms });
    }

    // G: the shared window shrinks under the live 720p cap; the ladder must
    // follow it in place (followShareTick), its bottom rung kept at 360 lines.
    await sharer.evaluate(() => { const c = window.__screenCanvas; c.width = 1152; c.height = 648; });
    await sleep(8000);
    const g = await sharer.evaluate(readShareSenders);
    const gSender = g.find(x => x.capture.startsWith('1152x648')) ?? g[0];
    result.phases.G = { senders: g, viewer: await viewerRate(viewer) };
    check('G: the capture is the smaller window', gSender?.capture.startsWith('1152x648'), gSender?.capture);
    if (laddered(f2Sender)) {
        check('G: the same sender (followed in place)', gSender?.id === f2Sender.id, { before: f2Sender.id, after: gSender?.id });
        const sc = Object.fromEntries((gSender?.encodings ?? []).map(x => [x.rid, x.scale]));
        check('G: rungs re-sized for 648 lines: 360 / 540 / 648', Math.abs(648 / sc.q - 360) < 1 && Math.abs(648 / sc.h - 540) < 1 && sc.f === 1, sc);
    }
    check('G: the viewer kept watching', result.phases.G.viewer.fps > 10, result.phases.G.viewer);
} catch (e) {
    result.error = String(e?.message || e);
    console.log('ERROR', result.error);
} finally {
    await sharerBrowser.close().catch(() => {});
    await viewerBrowser.close().catch(() => {});
}
result.liveServiceRequestsBlocked = liveAttempts;
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
const failed = !!result.error || result.checks.some(c => c.ok === false);
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
if (failed) process.exitCode = 1;
