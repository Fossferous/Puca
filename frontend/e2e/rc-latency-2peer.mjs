// In-call remote-control LATENCY rig: two headless Chromium clients on one
// machine against a local backend. Measures, per scenario:
//
//   1. glass-to-glass VIDEO delay of a voice-channel screen share: the host
//      page's getDisplayMedia is replaced by a canvas.captureStream() of a
//      synthetic desktop (moving blocks for encoder load + a binary wall-clock
//      strip: 24 squares, 4 ms units) — NO real desktop is ever captured, and
//      the headless shell offers only the real monitor otherwise. The viewer
//      decodes the clock back out of every presented frame via
//      requestVideoFrameCallback and subtracts it from its own Date.now()
//      (same machine, same clock). Everything downstream of capture — encoder
//      settings, the media-E2EE transform, RTP, jitter buffer, decoder, the
//      <video> — is the app's real path.
//   2. INPUT-path delay of remote control: the host runs with a fake
//      window.__TAURI_INTERNALS__ so the app believes it is the desktop shell
//      and grants control; its `inject_input` records the arrival time of
//      every event. The viewer records the DOM arrival time of every real
//      (Playwright-driven) pointer event. down/up pairs are matched in order.
//   3. getStats on both ends (jitter buffer, processing/decode/assembly delay,
//      encode time, pacer delay, RTT, codec implementations).
//
// What this CANNOT reproduce: a GPU-saturated host, a WAN, TURN. It measures
// the app's own pipeline on loopback, which is the part the code controls.
//
// Prereqs: backend on :3000 against a throwaway DB, vite on :5173 from the
// tree under test. Usage (from frontend/):
//   PGDB=puca_rclat node e2e/rc-latency-2peer.mjs
// Env knobs: RES=720|1080  FPS=15|30|60  WINDOW_MS=12000  SETTLE_MS=15000
//            MOTION=<moving blocks, 0 = static>  E2EE=off  DC=off
//            BUSY=viewer|host|both  OUT=<json path>  PHASES=watch,control
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const APP = process.env.APP || 'http://127.0.0.1:5173';
const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PGDB = process.env.PGDB || 'puca_rclat';
const PGPORT = process.env.PGPORT || '5433';
const PASS = 'Password123!';
const RES = process.env.RES || '1080';
const FPS = Number(process.env.FPS || 30);
const WINDOW_MS = Number(process.env.WINDOW_MS || 12000);
const E2EE_OFF = process.env.E2EE === 'off';
const DC_OFF = process.env.DC === 'off';
const BUSY = process.env.BUSY || '';
const PHASES = (process.env.PHASES || 'watch,control').split(',');
const OUT = process.env.OUT || '';
const SETTLE_MS = Number(process.env.SETTLE_MS || 15000);
const MOTION = Number(process.env.MOTION || 120);
const stamp = Date.now().toString(36);
const A = 'rclA_' + stamp;
const B = 'rclB_' + stamp;
const HOST_W = RES === '720' ? 1280 : 1920;
const HOST_H = RES === '720' ? 720 : 1080;

const psql = (sql) => execFileSync(PSQL,
    ['-U', 'postgres', '-h', '127.0.0.1', '-p', PGPORT, '-d', PGDB, '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const summ = (arr) => arr.length
    ? { n: arr.length, min: Math.round(pct(arr, 0)), p50: Math.round(pct(arr, 0.5)), p90: Math.round(pct(arr, 0.9)), max: Math.round(pct(arr, 1)) }
    : { n: 0 };

// ---------------------------------------------------------------------------
// Page-side scripts (run via addInitScript / evaluate)

// Every RTCPeerConnection the page makes, for getStats.
const PC_REGISTRY = `(() => {
    try { performance.setResourceTimingBufferSize(20000); } catch { /* fine */ }
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    function Patched(...args) { const pc = new Orig(...args); window.__pcs.push(pc); return pc; }
    Patched.prototype = Orig.prototype;
    Object.setPrototypeOf(Patched, Orig);
    window.RTCPeerConnection = Patched;
})();`;

const E2EE_OFF_SCRIPT = `(() => {
    delete RTCRtpSender.prototype.createEncodedStreams;
    delete RTCRtpReceiver.prototype.createEncodedStreams;
})();`;

const DC_OFF_SCRIPT = `(() => {
    RTCPeerConnection.prototype.createDataChannel = function () { throw new Error('data channels disabled by the rig'); };
})();`;

// ~60% main-thread occupancy: 30 ms busy every 50 ms.
const BUSY_SCRIPT = `setInterval(() => { const end = performance.now() + 30; while (performance.now() < end) { /* spin */ } }, 50);`;

// Synthetic desktop for the HOST: a canvas the app captures instead of the
// real screen. Row 0 is the wall clock: [white, black] sync markers, then 22
// bits of floor(Date.now()/4). Below it, moving blocks give the encoder
// game-like motion. Painted every animation frame.
const FAKE_DISPLAY = (w, h, fps, motion) => `(() => {
    const SQ = 40, W = ${w}, H = ${h};
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const blocks = Array.from({ length: ${motion} }, (_, i) => ({
        x: (i * 977) % W, y: (i * 613) % H, vx: ((i % 7) - 3) * 4 + 1, vy: ((i % 5) - 2) * 4 + 1,
        c: 'hsl(' + ((i * 37) % 360) + ',70%,50%)', s: 40 + (i % 5) * 30,
    }));
    const paint = () => {
        ctx.fillStyle = '#202830'; ctx.fillRect(0, 0, W, H);
        for (const b of blocks) {
            b.x += b.vx; b.y += b.vy;
            if (b.x < 0 || b.x > W) b.vx *= -1;
            if (b.y < SQ + 8 || b.y > H) b.vy *= -1;
            ctx.fillStyle = b.c; ctx.fillRect(b.x, b.y, b.s, b.s);
        }
        ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, W, SQ + 8);
        const v = Math.floor(Date.now() / 4) & 0x3FFFFF;
        for (let i = 0; i < 24; i++) {
            const bit = i === 0 ? 1 : i === 1 ? 0 : (v >> (21 - (i - 2))) & 1;
            ctx.fillStyle = bit ? '#fff' : '#000';
            ctx.fillRect(i * SQ, 0, SQ, SQ);
        }
        requestAnimationFrame(paint);
    };
    requestAnimationFrame(paint);
    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
        window.__fakeDisplayConstraints = constraints;
        return canvas.captureStream(${fps});
    };
})();`;

// Fake Tauri shell for the HOST: makes isTauri() true so the app will grant
// control, and records every inject_input with its arrival time.
const FAKE_TAURI = (w, h) => `(() => {
    window.__injectLog = [];
    window.__fakeTauriUnknown = [];
    const monitors = { monitors: [{ index: 0, left: 0, top: 0, width: ${w}, height: ${h}, primary: true }],
        virt_left: 0, virt_top: 0, virt_width: ${w}, virt_height: ${h} };
    const known = {
        inject_input: (args) => { window.__injectLog.push({ t: Date.now(), ev: args && args.event }); return null; },
        inject_input_batch: (args) => { for (const ev of (args && args.events) || []) window.__injectLog.push({ t: Date.now(), ev, batch: true }); return null; },
        release_control_input: () => null,
        set_control_monitor: () => null,
        start_control_guard: () => null,
        stop_control_guard: () => null,
        list_anticheat_processes: () => [],
        list_monitors: () => monitors,
        get_running_apps: () => [],
        get_idle_seconds: () => 0,
        set_stream_boost: () => 0,
        log_stream_diag: (args) => { (window.__diagLines = window.__diagLines || []).push(args && args.line); return null; },
        hide_screen_capture_bar: () => null,
        reset_capture_state: () => null,
        set_screen_share_indicator: () => null,
        set_clip_armed_indicator: () => null,
        set_device_session_indicator: () => null,
        set_unread_badge: () => null,
        set_close_to_tray: () => null,
        start_hotkey_listener: () => null,
        stop_hotkey_listener: () => null,
        attention_main_window: () => null,
        release_attention_topmost: () => null,
        clear_webview_permissions: () => null,
        lan_info: () => null,
        rc_leftovers_status: () => null,
        'plugin:event|listen': () => Math.floor(Math.random() * 1e9),
        'plugin:event|unlisten': () => null,
        'plugin:event|emit': () => null,
        'plugin:updater|check': () => null,
    };
    window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
        plugins: { path: { sep: '\\\\', delimiter: ';' } },
        callbacks: {},
        transformCallback(cb, once) {
            const id = Math.floor(Math.random() * 1e9);
            window['_' + id] = (r) => { if (once) delete window['_' + id]; return cb && cb(r); };
            return id;
        },
        unregisterCallback(id) { delete window['_' + id]; },
        convertFileSrc(p) { return p; },
        async invoke(cmd, args) {
            if (cmd in known) return known[cmd](args);
            window.__fakeTauriUnknown.push(cmd);
            if (cmd.startsWith('plugin:')) throw new Error('fake tauri: no plugin ' + cmd);
            return null;
        },
    };
})();`;

// VIEWER: DOM arrival time of every real pointer event over the capture surface.
const VIEWER_POINTER_LOG = `(() => {
    window.__ptrLog = [];
    for (const kind of ['pointermove', 'pointerdown', 'pointerup']) {
        document.addEventListener(kind, (e) => {
            const el = e.target;
            if (el && el.classList && el.classList.contains('control-capture')) {
                window.__ptrLog.push({ t: Date.now(), kind, x: e.clientX, y: e.clientY, button: e.button });
            }
        }, true);
    }
})();`;

// Import an app module by the URL the app itself loaded it from. Vite appends
// `?t=<stamp>` to modules edited since the dev server started; a bare import
// of the un-stamped URL would instantiate a SECOND copy with empty state.
const APP_MODULE = `(async (rel) => {
    const hit = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes(rel));
    return import(hit || rel);
})`;

// In-page stats summary (mesh only — every pc in the registry).
async function statsSummary(page) {
    return page.evaluate(async () => {
        const out = [];
        for (const pc of (window.__pcs || [])) {
            if (pc.connectionState === 'closed') continue;
            const rep = await pc.getStats();
            const byId = new Map();
            rep.forEach((r) => byId.set(r.id, r));
            const row = { state: pc.connectionState, inbound: [], outbound: [], pair: null, remoteInbound: [] };
            rep.forEach((r) => {
                if (r.type === 'inbound-rtp' && r.kind === 'video') {
                    const dec = r.framesDecoded || 0;
                    const emitted = r.jitterBufferEmittedCount || 0;
                    row.inbound.push({
                        ssrc: r.ssrc,
                        framesReceived: r.framesReceived, framesDecoded: dec, framesDropped: r.framesDropped,
                        fps: r.framesPerSecond, size: r.frameWidth ? r.frameWidth + 'x' + r.frameHeight : null,
                        decoder: r.decoderImplementation, powerEfficient: r.powerEfficientDecoder,
                        jitterBufferMs: emitted ? Math.round(1000 * r.jitterBufferDelay / emitted) : null,
                        jitterBufferTargetMs: emitted && r.jitterBufferTargetDelay != null ? Math.round(1000 * r.jitterBufferTargetDelay / emitted) : null,
                        jitterBufferMinMs: emitted && r.jitterBufferMinimumDelay != null ? Math.round(1000 * r.jitterBufferMinimumDelay / emitted) : null,
                        processingMs: dec && r.totalProcessingDelay != null ? Math.round(1000 * r.totalProcessingDelay / dec) : null,
                        assemblyMs: r.framesAssembledFromMultiplePackets ? Math.round(1000 * r.totalAssemblyTime / r.framesAssembledFromMultiplePackets) : null,
                        decodeMs: dec ? Math.round(10 * 1000 * r.totalDecodeTime / dec) / 10 : null,
                        interFrameMs: dec ? Math.round(1000 * r.totalInterFrameDelay / dec) : null,
                        freezeCount: r.freezeCount, freezeMs: r.totalFreezesDuration != null ? Math.round(1000 * r.totalFreezesDuration) : null,
                        pauseCount: r.pauseCount, packetsLost: r.packetsLost, nack: r.nackCount, pli: r.pliCount,
                        keyFrames: r.keyFramesDecoded, bytes: r.bytesReceived,
                    });
                }
                if (r.type === 'outbound-rtp' && r.kind === 'video') {
                    const enc = r.framesEncoded || 0;
                    row.outbound.push({
                        ssrc: r.ssrc, rid: r.rid,
                        framesSent: r.framesSent, framesEncoded: enc, fps: r.framesPerSecond,
                        size: r.frameWidth ? r.frameWidth + 'x' + r.frameHeight : null,
                        encoder: r.encoderImplementation, powerEfficient: r.powerEfficientEncoder,
                        encodeMs: enc ? Math.round(10 * 1000 * r.totalEncodeTime / enc) / 10 : null,
                        sendDelayMs: r.packetsSent ? Math.round(10 * 1000 * r.totalPacketSendDelay / r.packetsSent) / 10 : null,
                        limit: r.qualityLimitationReason, limitDurations: r.qualityLimitationDurations,
                        limitResolutionChanges: r.qualityLimitationResolutionChanges,
                        targetKbps: r.targetBitrate != null ? Math.round(r.targetBitrate / 1000) : null,
                        bytes: r.bytesSent, keyFrames: r.keyFramesEncoded, huge: r.hugeFramesSent,
                        nack: r.nackCount, pli: r.pliCount,
                    });
                }
                if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
                    row.remoteInbound.push({ ssrc: r.ssrc, rttMs: r.roundTripTime != null ? Math.round(1000 * r.roundTripTime) : null, fractionLost: r.fractionLost, jitterMs: r.jitter != null ? Math.round(1000 * r.jitter) : null });
                }
                if (r.type === 'transport' && r.selectedCandidatePairId) {
                    const p = byId.get(r.selectedCandidatePairId);
                    if (p) {
                        const l = byId.get(p.localCandidateId), rm = byId.get(p.remoteCandidateId);
                        row.pair = {
                            rttMs: p.currentRoundTripTime != null ? Math.round(1000 * p.currentRoundTripTime) : null,
                            outKbps: p.availableOutgoingBitrate != null ? Math.round(p.availableOutgoingBitrate / 1000) : null,
                            inKbps: p.availableIncomingBitrate != null ? Math.round(p.availableIncomingBitrate / 1000) : null,
                            local: l ? l.candidateType + '/' + l.protocol + (l.relayProtocol ? '/' + l.relayProtocol : '') : null,
                            remote: rm ? rm.candidateType + '/' + rm.protocol : null,
                        };
                    }
                }
            });
            row.receivers = pc.getReceivers().filter(x => x.track && x.track.kind === 'video').map(x => ({
                playoutDelayHint: x.playoutDelayHint, jitterBufferTarget: x.jitterBufferTarget,
            }));
            out.push(row);
        }
        return out;
    });
}

// VIEWER: decode the host clock out of presented frames for `ms`.
async function sampleVideo(page, ms) {
    return page.evaluate(async ({ ms, hostW, hostH }) => {
        const vids = [...document.querySelectorAll('video.stream-video')].filter(v => v.srcObject && v.videoWidth > 0);
        const video = vids[0];
        if (!video) return { error: 'no stream video' };
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const SQ = 40;
        const samples = [];
        let bad = 0;
        let lastPresented = -1;
        const decodeFrame = () => {
            const vw = video.videoWidth, vh = video.videoHeight;
            if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh; }
            ctx.drawImage(video, 0, 0, vw, vh);
            const sx = vw / hostW, sy = vh / hostH;
            // one row of pixels through the square centres
            const y = Math.round(SQ / 2 * sy);
            const row = ctx.getImageData(0, y, vw, 1).data;
            const lum = (i) => { const c = Math.round((i * SQ + SQ / 2) * sx); return 0.299 * row[c * 4] + 0.587 * row[c * 4 + 1] + 0.114 * row[c * 4 + 2]; };
            const white = lum(0), black = lum(1);
            if (white - black < 60) return null; // markers not found: not our frame / letterboxed differently
            const thr = (white + black) / 2;
            let v = 0;
            for (let b = 0; b < 22; b++) v = (v << 1) | (lum(2 + b) > thr ? 1 : 0);
            return v >>> 0;
        };
        await new Promise((resolve) => {
            const end = performance.now() + ms;
            const tick = (nowTs, md) => {
                if (md.presentedFrames !== lastPresented) {
                    lastPresented = md.presentedFrames;
                    const now = Date.now();
                    const v = decodeFrame();
                    if (v === null) { bad++; }
                    else {
                        const clockMs = v * 4;
                        // 22-bit clock wraps every ~4.66 h: align to `now`.
                        const period = 0x400000 * 4;
                        let base = now - ((now % period) - clockMs);
                        if (base > now + period / 2) base -= period;
                        samples.push({
                            now, lat: now - base,
                            presented: md.presentedFrames,
                            expectedDisplayDelta: md.expectedDisplayTime != null ? Math.round((md.expectedDisplayTime - performance.now()) * 10) / 10 : null,
                            receiveAgo: md.receiveTime != null ? Math.round(performance.now() - md.receiveTime) : null,
                            captureAgo: md.captureTime != null ? Math.round(performance.now() - md.captureTime) : null,
                            processing: md.processingDuration != null ? Math.round(md.processingDuration * 1000) : null,
                            rtp: md.rtpTimestamp ?? null,
                            w: md.width, h: md.height,
                        });
                    }
                }
                if (performance.now() < end) video.requestVideoFrameCallback(tick); else resolve();
            };
            video.requestVideoFrameCallback(tick);
        });
        return { samples, bad, videoSize: video.videoWidth + 'x' + video.videoHeight };
    }, { ms, hostW: HOST_W, hostH: HOST_H });
}

// ---------------------------------------------------------------------------

async function register(ctx, user, tag, consoleSink) {
    const page = await ctx.newPage();
    page.on('console', (m) => {
        const t = m.text();
        if (/p2p|\[media-e2ee\]|\[control\]|\[WebRTC\] (conn|Loaded|TURN)|fake tauri|\[stream-boost\]|data channel/i.test(t)) consoleSink.push(`${tag} ${m.type()} ${t.slice(0, 200)}`);
        if (m.type() === 'error' && !/favicon|manifest/i.test(t)) consoleSink.push(`${tag} ERROR ${t.slice(0, 200)}`);
    });
    page.on('pageerror', (e) => consoleSink.push(`${tag} PAGEERROR ${String(e).slice(0, 200)}`));
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) consoleSink.push(`${tag} NAVIGATED ${f.url()} at ${new Date().toISOString().slice(11, 23)}`); });
    await page.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('#username', { timeout: 60000 });
    await page.click('.toggle-mode');
    try { await page.waitForSelector('#inviteCode', { timeout: 3000 }); } catch { /* invite not required */ }
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 60000 });
    await page.waitForTimeout(1500);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* older flow */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    try { await page.getByRole('button', { name: 'Later' }).click({ timeout: 1500 }); } catch { /* none */ }
    return page;
}

async function createServer(page, name) {
    await page.locator('.server-icon.add-server').click({ timeout: 8000 });
    await page.waitForTimeout(600);
    await page.locator('.template-card').first().click({ timeout: 5000 });
    await page.waitForTimeout(300);
    await page.locator('.audience-card').first().click({ timeout: 5000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill(name);
    await page.locator('.wizard-actions .create-btn').click();
    await page.waitForTimeout(2500);
}

async function joinVoice(page) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    try { await page.getByRole('button', { name: 'Later' }).click({ timeout: 1000 }); } catch { /* none */ }
    await page.evaluate(() => {
        const icons = [...document.querySelectorAll('.server-icon')];
        const target = icons.find(i => !/direct message|add server|join server|notes|tasks/i.test((i.getAttribute('title') || '') + ' ' + (i.className || '')));
        target?.click();
    });
    await page.waitForTimeout(1500);
    const joined = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.voice-channel-list .voice-channel')];
        const el = items.find(n => !n.classList.contains('afk'));
        if (el) { el.click(); return true; }
        return false;
    });
    await page.waitForTimeout(3500);
    return joined;
}

async function startShare(page) {
    const opened = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b =>
            /share|screen/i.test((b.getAttribute('title') || '') + ' ' + b.className) && !/stop/i.test(b.textContent));
        if (btn) { btn.click(); return true; }
        return false;
    });
    if (!opened) return 'no share button';
    await page.waitForTimeout(800);
    // resolution + fps options in the modal
    await page.evaluate(({ res, fps }) => {
        const opts = [...document.querySelectorAll('.stream-option')];
        opts.find(o => o.textContent.trim() === res + 'p')?.click();
        opts.find(o => o.textContent.trim() === fps + ' fps')?.click();
    }, { res: RES, fps: FPS });
    await page.waitForTimeout(200);
    const live = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(x => /select screen/i.test(x.textContent));
        if (b) { b.click(); return true; }
        return false;
    });
    if (!live) return 'no select-screen button';
    // Desktop flow (fake Tauri): the mixer step follows the picker; go live from it.
    for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(250);
        const done = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(x => /^go live/i.test(x.textContent.trim()));
            if (b && !b.disabled) { b.click(); return 'clicked'; }
            return null;
        });
        if (done) break;
    }
    await page.waitForTimeout(4000);
    return 'ok';
}

async function watchStreams(page) {
    for (let i = 0; i < 40; i++) {
        const clicked = await page.evaluate(() => {
            const f = document.querySelector('.watch-live-btn');
            if (f) { f.click(); return true; }
            const t = document.querySelector('.vs-watch-btn');
            if (t) { t.click(); return true; }
            return false;
        });
        if (clicked) return true;
        await page.waitForTimeout(500);
    }
    return false;
}

async function waitForRemoteVideo(page, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const ok = await page.evaluate(() => [...document.querySelectorAll('video.stream-video')].some(v => v.srcObject && v.videoWidth > 0 && !v.paused));
        if (ok) return true;
        await page.waitForTimeout(400);
    }
    return false;
}

async function requestAndGrantControl(viewer, host) {
    const clicked = await viewer.evaluate(() => {
        const b = document.querySelector('button[title="Request control of this screen"]');
        if (b && !b.disabled) { b.click(); return true; }
        return false;
    });
    if (!clicked) return 'no request button';
    let allowed = false;
    for (let i = 0; i < 40 && !allowed; i++) {
        await host.waitForTimeout(250);
        allowed = await host.evaluate(() => { const b = document.querySelector('.rc-allow'); if (b) { b.click(); return true; } return false; });
    }
    if (!allowed) return 'host never showed the allow prompt';
    for (let i = 0; i < 40; i++) {
        await viewer.waitForTimeout(250);
        const active = await viewer.evaluate(() => !!document.querySelector('.control-capture'));
        if (active) return 'ok';
    }
    return 'viewer never became active';
}

/** Drive the viewer's mouse over the capture surface for `ms`: continuous
 *  motion at ~80 Hz plus a click every 250 ms. Returns Node-side timestamps. */
async function driveMouse(viewer, ms) {
    const rect = await viewer.evaluate(() => { const r = document.querySelector('.control-capture').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
    const cx = rect.l + rect.w / 2, cy = rect.t + rect.h / 2, rx = rect.w * 0.3, ry = rect.h * 0.3;
    const sent = { moves: 0, downs: [], ups: [] };
    const end = Date.now() + ms;
    let nextClick = Date.now() + 250;
    let i = 0;
    await viewer.mouse.move(cx, cy);
    while (Date.now() < end) {
        const a = (i++ * 0.05) % (Math.PI * 2);
        await viewer.mouse.move(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
        sent.moves++;
        if (Date.now() >= nextClick) {
            nextClick += 250;
            sent.downs.push(Date.now());
            await viewer.mouse.down();
            sent.ups.push(Date.now());
            await viewer.mouse.up();
        }
        const wait = 12 - 4; // ~80 Hz including CDP cost
        await new Promise(r => setTimeout(r, wait));
    }
    return sent;
}

const result = { config: { RES, FPS, WINDOW_MS, SETTLE_MS, MOTION, E2EE_OFF, DC_OFF, BUSY, PHASES }, console: [], phases: {} };
const consoleSink = result.console;

const browser = await chromium.launch({
    args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--autoplay-policy=no-user-gesture-required',
    ],
});

try {
    const hostCtx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: HOST_W, height: HOST_H } });
    const viewCtx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 720 } });
    for (const ctx of [hostCtx, viewCtx]) {
        await ctx.addInitScript(PC_REGISTRY);
        if (E2EE_OFF) await ctx.addInitScript(E2EE_OFF_SCRIPT);
        if (DC_OFF) await ctx.addInitScript(DC_OFF_SCRIPT);
    }
    await hostCtx.addInitScript(FAKE_TAURI(HOST_W, HOST_H));
    await hostCtx.addInitScript(FAKE_DISPLAY(HOST_W, HOST_H, FPS, MOTION));
    await viewCtx.addInitScript(VIEWER_POINTER_LOG);
    if (BUSY === 'host' || BUSY === 'both') await hostCtx.addInitScript(BUSY_SCRIPT);
    if (BUSY === 'viewer' || BUSY === 'both') await viewCtx.addInitScript(BUSY_SCRIPT);

    log('registering', A, B);
    const host = await register(hostCtx, A, 'HOST', consoleSink);
    const viewer = await register(viewCtx, B, 'VIEW', consoleSink);
    await createServer(host, 'RCL ' + stamp);
    const sid = psql(`SELECT id FROM servers WHERE name='RCL ${stamp}'`);
    const bid = psql(`SELECT id FROM users WHERE username='${B}'`);
    const aid = psql(`SELECT id FROM users WHERE username='${A}'`);
    psql(`INSERT INTO server_members (server_id,user_id) VALUES ('${sid}',${bid})`);
    result.users = { host: Number(aid), viewer: Number(bid), server: sid };

    log('joining voice');
    if (!await joinVoice(host)) throw new Error('host could not join voice');
    if (!await joinVoice(viewer)) throw new Error('viewer could not join voice');
    await host.waitForTimeout(2000);

    log('host sharing (synthetic canvas desktop)');
    const share = await startShare(host);
    if (share !== 'ok') throw new Error('share: ' + share);
    log('viewer watching');
    if (!await watchStreams(viewer)) throw new Error('no watch affordance');
    if (!await waitForRemoteVideo(viewer)) throw new Error('viewer never got frames');
    log('settling', SETTLE_MS, 'ms for the bandwidth estimator');
    await viewer.waitForTimeout(SETTLE_MS);
    // Control data channel state on BOTH ends before any control session:
    // created at pc construction, so it should be open here if it ever will be.
    const dcState = async (page, peer) => page.evaluate(async ({ peerId, appModule }) => {
        try {
            const m = await (0, eval)(appModule)('/src/api/rtc/controlDc.ts');
            const ch = m.controlChannels(peerId);
            const pcs = (window.__pcs || []).filter(pc => pc.connectionState !== 'closed');
            return { entry: ch ? { readyState: ch.state ? ch.state.readyState : null, helloSeen: ch.helloSeen } : null, pcs: pcs.length, sctp: pcs.map(pc => pc.sctp ? pc.sctp.state : 'none') };
        } catch (e) { return String(e); }
    }, { peerId: peer, appModule: APP_MODULE });
    result.dcBeforeControl = { host: await dcState(host, Number(bid)), viewer: await dcState(viewer, Number(aid)) };
    log('control DC before control:', JSON.stringify(result.dcBeforeControl));

    if (PHASES.includes('watch')) {
        log('phase watch:', WINDOW_MS, 'ms');
        const vid = await sampleVideo(viewer, WINDOW_MS);
        const lat = (vid.samples || []).map(s => s.lat);
        result.phases.watch = {
            video: { ...summ(lat), bad: vid.bad, size: vid.videoSize, fps: vid.samples ? Math.round(vid.samples.length / (WINDOW_MS / 1000)) : 0,
                receiveAgo: summ((vid.samples || []).map(s => s.receiveAgo).filter(x => x != null)),
                captureAgo: summ((vid.samples || []).map(s => s.captureAgo).filter(x => x != null)),
                processing: summ((vid.samples || []).map(s => s.processing).filter(x => x != null)) },
            viewerStats: await statsSummary(viewer),
            hostStats: await statsSummary(host),
            error: vid.error,
        };
        log('watch video:', JSON.stringify(result.phases.watch.video));
    }

    if (PHASES.includes('control')) {
        log('requesting control');
        const rc = await requestAndGrantControl(viewer, host);
        if (rc !== 'ok') throw new Error('control: ' + rc);
        await viewer.waitForTimeout(1500);
        result.receiverLatencyState = await viewer.evaluate(async (appModule) => {
            try { const m = await (0, eval)(appModule)('/src/api/rtc/receiverLatency.ts'); return m.screenLatencyStateForTest(); } catch (e) { return String(e); }
        }, APP_MODULE);
        result.inputTransport = await viewer.evaluate(async ({ hostId, appModule }) => {
            try {
                const m = await (0, eval)(appModule)('/src/api/rtc/controlDc.ts');
                const ch = m.controlChannels(hostId);
                return { dcReady: m.controlDcReady(hostId, 'viewer'), sfuReady: m.sfuControlReady(hostId, 'viewer'),
                    channel: ch ? { readyState: ch.state ? ch.state.readyState : null, helloSeen: ch.helloSeen, buffered: ch.state ? ch.state.bufferedAmount : null } : null };
            } catch (e) { return String(e); }
        }, { hostId: Number(aid), appModule: APP_MODULE });
        log('input transport:', JSON.stringify(result.inputTransport));
        await host.evaluate(() => { window.__injectLog.length = 0; });
        await viewer.evaluate(() => { window.__ptrLog.length = 0; });
        log('phase control:', WINDOW_MS, 'ms of motion + video sampling');
        const [vid, sent] = await Promise.all([sampleVideo(viewer, WINDOW_MS), driveMouse(viewer, WINDOW_MS)]);
        await host.waitForTimeout(800);
        const inj = await host.evaluate(() => window.__injectLog.slice());
        const ptr = await viewer.evaluate(() => window.__ptrLog.slice());
        const injDowns = inj.filter(e => e.ev && e.ev.t === 'down').map(e => e.t);
        const injUps = inj.filter(e => e.ev && e.ev.t === 'up').map(e => e.t);
        const ptrDowns = ptr.filter(e => e.kind === 'pointerdown').map(e => e.t);
        const ptrUps = ptr.filter(e => e.kind === 'pointerup').map(e => e.t);
        const pair = (a, b) => a.slice(0, Math.min(a.length, b.length)).map((t, i) => b[i] - t);
        const lat = (vid.samples || []).map(s => s.lat);
        result.phases.control = {
            video: { ...summ(lat), bad: vid.bad, size: vid.videoSize, fps: vid.samples ? Math.round(vid.samples.length / (WINDOW_MS / 1000)) : 0,
                receiveAgo: summ((vid.samples || []).map(s => s.receiveAgo).filter(x => x != null)),
                captureAgo: summ((vid.samples || []).map(s => s.captureAgo).filter(x => x != null)),
                processing: summ((vid.samples || []).map(s => s.processing).filter(x => x != null)) },
            input: {
                sent: { moves: sent.moves, downs: sent.downs.length },
                viewerDom: { moves: ptr.filter(e => e.kind === 'pointermove').length, downs: ptrDowns.length, ups: ptrUps.length },
                injected: { moves: inj.filter(e => e.ev && e.ev.t === 'move').length, downs: injDowns.length, ups: injUps.length, other: inj.filter(e => !e.ev || !['move', 'down', 'up'].includes(e.ev.t)).length },
                downLatency: summ(pair(ptrDowns, injDowns)),
                upLatency: summ(pair(ptrUps, injUps)),
            },
            viewerStats: await statsSummary(viewer),
            hostStats: await statsSummary(host),
            error: vid.error,
        };
        log('control video:', JSON.stringify(result.phases.control.video));
        log('control input:', JSON.stringify(result.phases.control.input));
    }
    // The PRODUCT diagnostics, as a user would read them — the rig's own
    // getStats reduction above is the independent check on these.
    result.productDiag = {
        viewerMesh: await viewer.evaluate(() => window.__pucaMeshDiag()),
        hostMesh: await host.evaluate(() => window.__pucaMeshDiag()),
        hostSamplerLines: await host.evaluate(() => (window.__diagLines || []).slice(-4)),
    };
result.fakeTauriUnknown = await host.evaluate(() => [...new Set(window.__fakeTauriUnknown)]);
} catch (e) {
    result.error = String(e && e.stack || e);
    log('ERROR', result.error);
} finally {
    await browser.close();
}

if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log('\n=== CONSOLE (filtered) ===');
for (const l of result.console.slice(0, 80)) console.log(l);
console.log('\n=== RESULT ===');
console.log(JSON.stringify({ config: result.config, users: result.users, receiverLatencyState: result.receiverLatencyState, inputTransport: result.inputTransport, dcBeforeControl: result.dcBeforeControl, productDiag: result.productDiag, phases: result.phases, fakeTauriUnknown: result.fakeTauriUnknown, error: result.error }, null, 1));
process.exit(result.error ? 1 : 0);
