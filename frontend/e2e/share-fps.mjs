// Does a screen share arrive at the frame rate it was sent at?
//
// WHY. On 2026-09-25 the owner watched a friend's share at a steady 21-22 fps
// with nothing dropped, frozen or lost on his end: every frame sent was shown,
// so the ~22 was decided on the streamer's side. This rig takes the viewer and
// the network out of question on a THROWAWAY stack (never a live server, never
// real people): one client shares, another watches, and it reports, over a
// window, what the sender captured, encoded and sent, and what the viewer
// decoded and actually PRESENTED on screen (requestVideoFrameCallback).
//
// THE SOURCE. Headless Chromium's own screen capture barely changes, and a
// screen that does not change is not captured — that alone produces a low
// frame rate and would fake the very effect under test. So the sharer's
// getDisplayMedia returns a synthetic WxH canvas that changes CHANGE_FPS times
// a second (default: every frame at FPS), through the app's own share button,
// share dialog and publish path. CHANGE_FPS below FPS is the control: the
// screen then only changes that often, and the sender's capture rate should
// say so while the encoder reports no limit — exactly the distinction the
// health-send line's s=[...] section draws.
//
// PATH (TRANSPORT=mesh|sfu). The two are NOT the same chain at the encoder,
// which is the part usually under suspicion: mesh sends the browser's default
// codec (VP8/libvpx here) capped at 8 Mbps (tuneScreenShareSender), with E2EE on
// a main-thread transform; SFU channels publish H.264 (preferHardwareH264: the
// GPU's encoder where available, else OpenH264) at SHARE_BITRATE 4.5 Mbps,
// optional simulcast and LiveKit's worker E2EE, and the viewer decodes H.264.
// TRANSPORT=sfu needs a LiveKit server the backend is configured for
// (LIVEKIT_URL / _API_KEY / _API_SECRET) and switches this run's channels to
// sfu_mode through psql. Either way a PASS covers THIS machine only, not anybody
// else's. The verdict carries the path and codec for that reason.
//
// Everything is headless and muted: nothing opens on the desktop, nothing plays.
//
// Prereqs: a throwaway backend (CORS allowing APP) and Postgres (PGPORT / PGDB,
// password postgres), and the client built against that backend served at APP
// (`DIST=<dir> PORT=… node e2e/serve-dist.mjs`).
// Usage: APP=http://127.0.0.1:5181 PGPORT=55433 PGDB=puca_rig [FPS=30] [CHANGE_FPS=30]
//        [RES=1920x1080] [MEASURE_MS=60000] [ADAPTER_LUID=0,<low>] node e2e/share-fps.mjs [out.json]
// Exit 1 when the viewer shows less than 90% of what the sender sent, or the
// sender sends less than 90% of what its capture produced.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const APP = process.env.APP || 'http://127.0.0.1:5173';
const FPS = Number(process.env.FPS || 30);
const CHANGE_FPS = Number(process.env.CHANGE_FPS || FPS);
const [W, H] = (process.env.RES || '1920x1080').split('x').map(Number);
const MEASURE_MS = Number(process.env.MEASURE_MS || 60_000);
const WARM_MS = Number(process.env.WARM_MS || 15_000);
const CHANNEL = process.env.CHANNEL || 'msedge';
/** The viewer's GPU: the owner's app is pinned to the integrated GPU. */
const ADAPTER_LUID = process.env.ADAPTER_LUID || '';
const TRANSPORT = process.env.TRANSPORT === 'sfu' ? 'sfu' : 'mesh';
const OUT = process.argv[2] || '';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-p', process.env.PGPORT || '5432', '-d', process.env.PGDB || 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const baseArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required',
    // NEVER the live service: the production hostname still appears in the bundle
    // (the default-server helper), so it resolves to nothing here, and any
    // attempt is counted below and reported.
    '--host-resolver-rules=MAP svrn.lol ~NOTFOUND, MAP *.svrn.lol ~NOTFOUND'];
// A LOCAL SFU listens on 127.0.0.1 only (so nothing is exposed and Windows
// raises no firewall prompt), and Chromium leaves loopback out of its ICE
// candidates unless told otherwise: without this every SFU join failed ICE.
if (process.env.TRANSPORT === 'sfu') baseArgs.push('--allow-loopback-in-peer-connection');
let liveAttempts = 0;
const blockLive = async (ctx) => {
    await ctx.route(/https?:\/\/([^/]*\.)?svrn\.lol(\/|$)/, (route) => { liveAttempts++; return route.abort(); });
};

/** Every page keeps its peer connections where the rig can read their stats. */
const keepPeerConnections = () => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...a) { const pc = new Native(...a); window.__pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = Native.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, Native);
};

/** The sharer's screen: a canvas that changes `change` times a second. Bars
 *  sweep, blocks move and a counter ticks, so the encoder has real work. */
const syntheticScreen = ({ w, h, fps, change }) => {
    navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        let n = 0;
        const draw = () => {
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
        setInterval(draw, 1000 / change);
        const stream = c.captureStream(fps);
        window.__synthetic = { w, h, fps, change };
        return stream;
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

/** The app's own share button and its "Go live" — the real share path. */
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
    await p.waitForTimeout(4000);
    return p.evaluate(() => !!window.__synthetic);
}

/** Outbound video, its media-source, and the capture track's setting. */
const readSender = async () => {
    const out = [];
    for (const pc of window.__pcs) {
        for (const s of pc.getSenders()) {
            if (s.track?.kind !== 'video') continue;
            const st = await s.getStats();
            const set = s.track.getSettings?.().frameRate ?? null;
            st.forEach(r => {
                if (r.type !== 'outbound-rtp') return;
                const src = r.mediaSourceId ? st.get(r.mediaSourceId) : undefined;
                out.push({
                    rid: r.rid ?? null, set, framesEncoded: r.framesEncoded, framesSent: r.framesSent, fps: r.framesPerSecond ?? null,
                    size: r.frameWidth ? `${r.frameWidth}x${r.frameHeight}` : null,
                    limit: r.qualityLimitationReason ?? null, limitDurations: r.qualityLimitationDurations ?? null,
                    encoder: r.encoderImplementation ?? null, hw: r.powerEfficientEncoder ?? null,
                    source: src ? { frames: src.frames ?? null, fps: src.framesPerSecond ?? null, size: src.width ? `${src.width}x${src.height}` : null } : null,
                });
            });
        }
    }
    return out;
};

/** Inbound video on the viewer. */
const readViewer = async () => {
    const out = [];
    for (const pc of window.__pcs) {
        const st = await pc.getStats();
        st.forEach(r => {
            if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
            out.push({
                framesReceived: r.framesReceived, framesDecoded: r.framesDecoded, framesDropped: r.framesDropped ?? 0,
                freezes: r.freezeCount ?? 0, freezeSec: r.totalFreezesDuration ?? 0, fps: r.framesPerSecond ?? null,
                size: r.frameWidth ? `${r.frameWidth}x${r.frameHeight}` : null, lost: r.packetsLost ?? 0,
                decoder: r.decoderImplementation ?? null, hw: r.powerEfficientDecoder ?? null,
            });
        });
    }
    return out;
};

const sharerBrowser = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args: baseArgs });
const viewerBrowser = await chromium.launch({
    channel: CHANNEL === 'bundled' ? undefined : CHANNEL,
    args: [...baseArgs, ...(ADAPTER_LUID ? [`--use-adapter-luid=${ADAPTER_LUID}`] : [])],
});
const users = [`sf0_${stamp}`, `sf1_${stamp}`];
const result = { app: APP, fps: FPS, changeFps: CHANGE_FPS, res: `${W}x${H}`, measureMs: MEASURE_MS, adapter: ADAPTER_LUID || 'default', path: TRANSPORT };
let failed = false;

try {
    const sctx = await sharerBrowser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 800 } });
    await blockLive(sctx);
    await sctx.addInitScript(keepPeerConnections);
    // The share dialog opens on the remembered quality (settingsStore's
    // `sovereign_settings`, read on every load). Set it BEFORE the app loads.
    await sctx.addInitScript((fps) => {
        try {
            const cur = JSON.parse(localStorage.getItem('sovereign_settings') || '{}');
            localStorage.setItem('sovereign_settings', JSON.stringify({ ...cur, shareFps: fps, shareResolution: '1080' }));
        } catch { /* storage unavailable: the dialog's default (1080p30) stands */ }
    }, FPS);
    await sctx.addInitScript(syntheticScreen, { w: W, h: H, fps: FPS, change: CHANGE_FPS });
    const vctx = await viewerBrowser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1600, height: 1000 } });
    await blockLive(vctx);
    await vctx.addInitScript(keepPeerConnections);
    const sharer = await register(sctx, users[0]);
    const viewer = await register(vctx, users[1]);

    const serverName = 'ShareFps_' + stamp;
    await createServer(sharer, serverName);
    const serverId = psql(`SELECT id FROM servers WHERE name='${serverName}'`);
    const vid = psql(`SELECT id FROM users WHERE username='${users[1]}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${vid}) ON CONFLICT DO NOTHING`);
    // The SFU path: this run's channels are routed through LiveKit.
    if (TRANSPORT === 'sfu') psql(`UPDATE channels SET sfu_mode = true WHERE server_id = '${serverId}'`);
    for (const p of [sharer, viewer]) {
        if (!await joinVoice(p)) throw new Error('could not find the voice channel to join');
    }
    await sleep(6000);

    result.shareStarted = await startShare(sharer);
    if (!result.shareStarted) throw new Error('the share did not start on the synthetic source');
    // The viewer WATCHES: the floating "Live Stream — Click to Watch" button.
    let watching = false;
    for (let i = 0; i < 40 && !watching; i++) {
        watching = await viewer.evaluate(() => {
            const b = document.querySelector('.watch-live-btn');
            if (b) { b.click(); return true; }
            return false;
        });
        if (!watching) await sleep(250);
    }
    if (!watching) throw new Error('the viewer never got a "Click to Watch" button');

    // The playing <video> whose source is the share (the largest one).
    let playing = false;
    for (let i = 0; i < 80 && !playing; i++) {
        playing = await viewer.evaluate(() => [...document.querySelectorAll('video')].some(v => v.videoWidth >= 640 && !v.paused));
        if (!playing) await sleep(250);
    }
    if (!playing) throw new Error('the viewer never showed a playing stream');
    await sleep(WARM_MS);

    // Presented frames: requestVideoFrameCallback on the biggest playing video.
    await viewer.evaluate(() => {
        const v = [...document.querySelectorAll('video')].filter(x => x.videoWidth > 0).sort((a, b) => b.videoWidth - a.videoWidth)[0];
        window.__present = { calls: 0, first: null, last: null, maxGapMs: 0, prevTs: null, size: `${v.videoWidth}x${v.videoHeight}` };
        const tick = (now, meta) => {
            const p = window.__present;
            p.calls++;
            if (p.first === null) p.first = meta.presentedFrames;
            p.last = meta.presentedFrames;
            if (p.prevTs !== null) p.maxGapMs = Math.max(p.maxGapMs, now - p.prevTs);
            p.prevTs = now;
            v.requestVideoFrameCallback(tick);
        };
        v.requestVideoFrameCallback(tick);
    });

    const s0 = await sharer.evaluate(readSender);
    const v0 = await viewer.evaluate(readViewer);
    await sleep(MEASURE_MS);
    const s1 = await sharer.evaluate(readSender);
    const v1 = await viewer.evaluate(readViewer);
    const present = await viewer.evaluate(() => window.__present);
    const secs = MEASURE_MS / 1000;
    // What the APP ITSELF reports for the share (the rows healthLog.ts turns
    // into its s=[...] section): source, chosen/capped/captured/sent fps, size,
    // on/off and sender id, read through the app's own mesh diagnostics hook.
    const row = (r, peer) => ({ peer, rid: r.rid ?? null, source: r.source ?? null, setFps: r.setFps ?? null, maxFps: r.maxFps ?? null,
        captureFps: r.captureFps ?? null, fps: r.fps ?? null, size: r.size ?? null, active: r.active ?? null,
        ssrc: r.ssrc ?? null, limit: r.limit ?? null, encoder: r.encoder ?? null, hw: r.hwEncoder ?? null });
    result.appSendRows = TRANSPORT === 'sfu'
        ? await sharer.evaluate(async () => (await window.__pucaVoiceDiag?.(3000))?.localRtp ?? [])
            .then(rows => rows.filter(r => r.kind === 'video').map(r => row(r, null)))
        : await sharer.evaluate(async () => {
            const peers = await window.__pucaMeshDiag?.(3000);
            const rows = [];
            for (const p of peers ?? []) {
                for (const r of p.rtp ?? []) if (r.dir === 'outbound-rtp' && r.kind === 'video') rows.push({ ...r, peer: p.userId });
            }
            return rows;
        }).then(rows => rows.map(r => row(r, r.peer)));
    // ...and how the viewer's app labels what it receives (healthLog's v=[...]).
    result.appReceiveRows = TRANSPORT === 'sfu'
        ? await viewer.evaluate(async () => ((await window.__pucaVoiceDiag?.(3000))?.remoteRtp ?? []).map(r => {
            const i = r.latency?.inbound?.[0] ?? {};
            return { peer: r.userId ?? null, source: r.source ?? null, fps: i.fps ?? null, size: i.size ?? null, decoder: i.decoder ?? null };
        }))
        : await viewer.evaluate(async () => {
            const peers = await window.__pucaMeshDiag?.(3000);
            return (peers ?? []).flatMap(p => (p.latency?.inbound ?? []).map(i => ({
                peer: p.userId, source: i.source ?? null, fps: i.fps ?? null, size: i.size ?? null, decoder: i.decoder ?? null,
            })));
        });

    const rate = (a, b, k) => (a && b && typeof a[k] === 'number' && typeof b[k] === 'number') ? Math.round(((b[k] - a[k]) / secs) * 10) / 10 : null;
    result.sender = s1.map((e, i) => {
        const before = s0[i] || {};
        const limitSecs = {};
        if (e.limitDurations && before.limitDurations) {
            for (const [k, v] of Object.entries(e.limitDurations)) limitSecs[k] = Math.round((v - (before.limitDurations[k] ?? 0)) * 10) / 10;
        }
        return {
            rid: e.rid, set: e.set, size: e.size, encoder: e.encoder, hw: e.hw, limitNow: e.limit, limitSecsInWindow: limitSecs,
            capturedFps: rate(before.source, e.source, 'frames'), capturedFpsStat: e.source?.fps ?? null,
            encodedFps: rate(before, e, 'framesEncoded'), sentFps: rate(before, e, 'framesSent'), sentFpsStat: e.fps,
            mediaSourceStatsPresent: !!e.source, mediaSourceFpsPresent: typeof e.source?.fps === 'number',
        };
    });
    result.viewer = v1.map((e, i) => {
        const before = v0[i] || {};
        return {
            size: e.size, decoder: e.decoder, hw: e.hw,
            receivedFps: rate(before, e, 'framesReceived'), decodedFps: rate(before, e, 'framesDecoded'),
            dropped: e.framesDropped - (before.framesDropped ?? 0), freezes: e.freezes - (before.freezes ?? 0),
            freezeSec: Math.round((e.freezeSec - (before.freezeSec ?? 0)) * 100) / 100, lost: e.lost - (before.lost ?? 0),
        };
    });
    result.presented = {
        fps: present.last !== null && present.first !== null ? Math.round(((present.last - present.first) / secs) * 10) / 10 : null,
        callbacksPerSec: Math.round((present.calls / secs) * 10) / 10,
        maxGapMs: Math.round(present.maxGapMs), size: present.size,
    };

    const top = result.sender.reduce((a, b) => ((b.sentFps ?? 0) > (a?.sentFps ?? -1) ? b : a), null);
    const sent = top?.sentFps ?? 0;
    const captured = top?.capturedFps ?? null;
    const shown = result.presented.fps ?? 0;
    result.verdict = {
        path: TRANSPORT, encoder: top?.encoder ?? null, hwEncoder: top?.hw ?? null,
        decoder: result.viewer[0]?.decoder ?? null,
        captured, sent, shown,
        viewerKeptUp: sent > 0 && shown >= 0.9 * sent,
        encoderKeptUp: captured === null ? null : sent >= 0.9 * captured,
        sourceChangedAtTarget: captured === null ? null : captured >= 0.9 * Math.min(FPS, CHANGE_FPS),
    };
    failed = !result.verdict.viewerKeptUp || result.verdict.encoderKeptUp === false;
} catch (e) {
    result.error = String(e?.message || e);
    failed = true;
} finally {
    await sharerBrowser.close().catch(() => {});
    await viewerBrowser.close().catch(() => {});
}
result.liveServiceRequestsBlocked = liveAttempts;
console.log(JSON.stringify(result, null, 2));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
if (failed) process.exitCode = 1;
