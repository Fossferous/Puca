// A screen share through a LOOPBACK LiveKit, with the SHARER's upload squeezed:
// what a viewer sees on a weak link, and how fast the share comes back after.
//
// WHY THIS EXISTS. 2026-10-05: a streamer's estimate collapsed 20 s into a
// share and viewers got 310x180 for minutes; a second share on the same call
// sat at 320x174 for three. Nothing in Playwright or CDP can shape UDP, so this
// puts a userspace bottleneck between the browsers and LiveKit's UDP port: a
// rate limit with a drop-tail queue measured in milliseconds (a router's
// buffer, i.e. bufferbloat), on the upstream direction only.
//
// MODE=shipped publishes the way 0.9.833 did (maintain-framerate, libwebrtc
// adapts); MODE=adapt publishes the way sfuManager does now (maintain-
// resolution) and runs the REAL shareAdapt.ts, bundled with esbuild at start,
// through a copy of sfuManager.shareAdaptTick.
//
// Measured 2026-10-06 with this rig (500 ms buffer unless noted, game-like
// moving picture, headless Edge, OpenH264 — no hardware encoder headless):
//
//   link        shipped                 adapt
//   250 kbps    180p @ 3                360p @ 1
//   450 kbps    180p @ 30, or @ 0-1     360p @ 13
//   600 kbps    180p @ 30               360p @ 22
//   1 Mbps      270-360p @ 30           540p @ 30
//   1.5 Mbps    540p @ 30               720p @ 30
//   good        1080p30 from ~2 s       1080p30 from ~6 s
//   250 kbps -> 5 Mbps after 40 s (1 s buffer), time to full 1080p:
//               shipped 60, 75, 60 s    adapt 28, 30, 34 s
//   the same, share stopped at 40 s and started again at 50 s:
//               shipped 85 s, >90 s     adapt 40, 22 s
//
// LIVEKIT, LOOPBACK ONLY. On Windows a LiveKit with its default ICE/TCP port
// binds 0.0.0.0 and raises a firewall prompt on the desktop. Use:
//
//   port: 7880
//   bind_addresses: [127.0.0.1]
//   rtc: { tcp_port: 0, udp_port: 7882, use_external_ip: false, node_ip: 127.0.0.1,
//          enable_loopback_candidate: true, ips: { includes: [127.0.0.1/32] } }
//   keys: { <key>: <secret> }
//
// and check `netstat -ano` for its PID before the first run.
//
// Usage (from frontend/):
//   LK_KEY=<key> LK_SECRET=<secret> MODE=adapt RATE=450 node e2e/share-adapt-shaped.mjs
//   ... RATE=250 QUEUE=1000 LATER_RATE=5000 LATER_AT=40000 TOTAL=130000   (squeeze, then lift)
//   ... RESHARE_STOP=40000 RESHARE_START=50000                             (a second share)
// Env: LK_WS (ws://127.0.0.1:7880), LK_UDP (7882), SHAPER_PORT (7883), PAGE_PORT (7884),
//      QUEUE ms (500), TOTAL ms (90000), OUT=<file.json>, SHOT=<png> (viewer at the end).
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import dgram from 'node:dgram';
import { fileURLToPath } from 'node:url';

const env = process.env;
const LK_WS = env.LK_WS || 'ws://127.0.0.1:7880';
const LK_UDP = Number(env.LK_UDP || 7882);
const SHAPER_PORT = Number(env.SHAPER_PORT || 7883);
const PAGE_PORT = Number(env.PAGE_PORT || 7884);
const KEY = env.LK_KEY, SECRET = env.LK_SECRET;
if (!KEY || !SECRET) { console.error('LK_KEY and LK_SECRET are required (see the header).'); process.exit(2); }
const MODE = env.MODE === 'shipped' ? 'shipped' : 'adapt';
const RATE = Number(env.RATE || 1000), QUEUE = Number(env.QUEUE || 500);
const LATER_RATE = env.LATER_RATE ? Number(env.LATER_RATE) : null, LATER_AT = Number(env.LATER_AT || 45000);
const RESHARE_STOP = env.RESHARE_STOP ? Number(env.RESHARE_STOP) : null, RESHARE_START = Number(env.RESHARE_START || 0);
const TOTAL = Number(env.TOTAL || 90000);
const ROOM = 'shaped_' + Date.now().toString(36);
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// ---- the bottleneck: upstream only, rate-limited, drop-tail ----
function startShaper({ rateKbps, queueMs }) {
    const front = dgram.createSocket('udp4');
    const flows = new Map();
    const state = { rateKbps, queueMs };
    const stats = { dropped: 0, maxQueueMs: 0 };
    front.on('message', (m, rinfo) => {
        const k = `${rinfo.address}:${rinfo.port}`;
        let f = flows.get(k);
        if (!f) {
            const back = dgram.createSocket('udp4');
            back.bind(0, '127.0.0.1');
            back.on('message', (d) => front.send(d, rinfo.port, rinfo.address));
            f = { back, busyUntil: 0 };
            flows.set(k, f);
        }
        const now = performance.now();
        const start = Math.max(now, f.busyUntil);
        if (start - now > state.queueMs) { stats.dropped++; return; }
        stats.maxQueueMs = Math.max(stats.maxQueueMs, start - now);
        f.busyUntil = start + (m.length * 8) / state.rateKbps;
        setTimeout(() => f.back.send(m, LK_UDP, '127.0.0.1'), f.busyUntil - now);
    });
    front.bind(SHAPER_PORT, '127.0.0.1');
    return {
        set(o) { Object.assign(state, o); },
        take() { const s = { ...stats }; stats.maxQueueMs = 0; return s; },
        close() { front.close(); for (const f of flows.values()) f.back.close(); },
    };
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(identity) {
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: 'HS256', typ: 'JWT' });
    const p = b64({ iss: KEY, sub: identity, nbf: now - 10, exp: now + 3600, video: { room: ROOM, roomJoin: true, canPublish: true, canSubscribe: true } });
    return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}

const adaptJs = (await build({
    entryPoints: [here('../src/api/rtc/shareAdapt.ts')], bundle: true, write: false, format: 'iife', globalName: 'PucaShareAdapt',
})).outputFiles[0].text;
const lkUmd = readFileSync(here('../node_modules/livekit-client/dist/livekit-client.umd.js'), 'utf8');

const shaper = startShaper({ rateKbps: RATE, queueMs: QUEUE });
// LiveKit refuses an opaque origin, so the pages load from a loopback server.
const srv = createServer((_, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>shaped</title>'); });
await new Promise(r => srv.listen(PAGE_PORT, '127.0.0.1', r));
const browser = await chromium.launch({
    headless: true, channel: env.CHANNEL || 'msedge',
    args: ['--mute-audio', '--allow-loopback-in-peer-connection', '--autoplay-policy=no-user-gesture-required'],
});

async function page(name) {
    const p = await browser.newPage();
    p.on('console', m => { if (m.type() === 'error') console.log(`  [${name}]`, m.text().slice(0, 160)); });
    await p.goto(`http://127.0.0.1:${PAGE_PORT}/`);
    // Send every LiveKit media candidate through the bottleneck.
    await p.evaluate(({ from, to }) => {
        const rw = (s) => s.replace(new RegExp(`(127\\.0\\.0\\.1 )${from}( typ)`, 'g'), `$1${to}$2`);
        const P = RTCPeerConnection.prototype;
        const srd = P.setRemoteDescription, aic = P.addIceCandidate;
        P.setRemoteDescription = function (d) { return srd.call(this, d && d.sdp ? { type: d.type, sdp: rw(d.sdp) } : d); };
        P.addIceCandidate = function (c) {
            if (c && c.candidate) c = new RTCIceCandidate({ candidate: rw(c.candidate), sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment });
            return aic.call(this, c);
        };
    }, { from: LK_UDP, to: SHAPER_PORT });
    await p.addScriptTag({ content: lkUmd });
    await p.addScriptTag({ content: adaptJs });
    return p;
}

const viewer = await page('viewer');
await viewer.evaluate(async ({ url, tok }) => {
    const LK = window.LivekitClient;
    const room = new LK.Room({ adaptiveStream: false, dynacast: true });
    room.on(LK.RoomEvent.TrackSubscribed, (t, pub) => {
        document.querySelectorAll('video').forEach(v => v.remove());
        const el = t.attach(); el.muted = true; el.style.width = '1280px'; el.style.height = '720px';
        document.body.appendChild(el);
        try { pub.setVideoQuality(LK.VideoQuality.HIGH); } catch { /* single layer */ }
        window.__v = t;
    });
    await room.connect(url, tok, { autoSubscribe: true });
    window.__sample = async () => {
        if (!window.__v?.receiver) return null;
        let r = null; (await window.__v.receiver.getStats()).forEach(x => { if (x.type === 'inbound-rtp' && x.kind === 'video') r = x; });
        return r ? { h: r.frameHeight, size: `${r.frameWidth}x${r.frameHeight}`, decoded: r.framesDecoded, freezes: r.freezeCount } : null;
    };
}, { url: LK_WS, tok: token('viewer') });

const sharer = await page('sharer');
await sharer.evaluate(async ({ url, tok, MODE }) => {
    const LK = window.LivekitClient;
    // A game-like source: full-frame motion, which no encoder can coast on.
    const W = 1866, H = 1080;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const shapes = Array.from({ length: 140 }, (_, i) => ({ x: (i * 137) % W, y: (i * 71) % H, vx: 2 + (i % 7), vy: 1 + (i % 5), r: 20 + (i % 60), hue: (i * 17) % 360 }));
    let f = 0;
    setInterval(() => {
        f++;
        const g = ctx.createLinearGradient(0, (f * 2) % H, W, H); g.addColorStop(0, '#123'); g.addColorStop(1, '#0b1220');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        for (const s of shapes) { s.x = (s.x + s.vx) % W; s.y = (s.y + s.vy) % H; ctx.fillStyle = `hsl(${(s.hue + f) % 360} 90% 55%)`; ctx.fillRect(s.x, s.y, s.r, s.r); }
        ctx.fillStyle = '#fff'; ctx.fillRect((f * 19) % W, 0, 60, H);
    }, 1000 / 30);
    // sfuManager's room options: LiveKit takes a share's bitrate and frame rate
    // from publishDefaults.screenShareEncoding, not from publishTrack's
    // videoEncoding (without this the share is capped at 2.5 Mbps / 15 fps).
    const room = new LK.Room({ dynacast: true, adaptiveStream: false,
        publishDefaults: { simulcast: true, screenShareEncoding: { maxBitrate: 4_500_000, maxFramerate: 60 } } });
    await room.connect(url, tok, { autoSubscribe: false });
    // A silent mic first, like a call: the share joins a transport already in use.
    const ac = new AudioContext(); const osc = ac.createOscillator(); const dst = ac.createMediaStreamDestination();
    const gain = ac.createGain(); gain.gain.value = 0.05; osc.connect(gain); gain.connect(dst); osc.start();
    await room.localParticipant.publishTrack(dst.stream.getAudioTracks()[0], { source: LK.Track.Source.Microphone });
    await new Promise(r => setTimeout(r, 15000));
    // sfuManager.screenSharePublishOptions(false), both versions.
    const opts = { source: LK.Track.Source.ScreenShare, simulcast: false, videoCodec: 'h264',
        videoEncoding: { maxBitrate: 4_500_000, maxFramerate: 60 },
        degradationPreference: MODE === 'adapt' ? 'maintain-resolution' : 'maintain-framerate' };
    const timers = [];
    window.__changes = { height: 0, hint: 0 };
    // sfuManager.applyShareHeight + shareAdaptTick (publication held, not looked up).
    const adapt = (pub, mst) => {
        const applyShareHeight = async (sender, sourceHeight, height) => {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) return;
            params.encodings[0].scaleResolutionDownBy = Math.max(1, sourceHeight / height);
            params.degradationPreference = 'maintain-resolution';
            await sender.setParameters(params);
        };
        const st = { adapter: null, sender: null, busy: false };
        const tick = async () => {
            if (st.busy) return; st.busy = true;
            try {
                const sender = pub.track?.sender;
                if (!sender) return;
                const set = mst.getSettings();
                const sourceHeight = set.height > 0 ? set.height : 1080, fps = set.frameRate > 0 ? set.frameRate : 30;
                if (st.sender !== sender || !st.adapter) {
                    st.adapter = new PucaShareAdapt.ShareAdapter({ sourceHeight, fps, maxKbps: 4500 });
                    st.sender = sender;
                    await applyShareHeight(sender, sourceHeight, st.adapter.currentHeight);
                    return;
                }
                const resized = st.adapter.resize(sourceHeight, fps);
                if (resized.height !== undefined) await applyShareHeight(sender, sourceHeight, resized.height);
                let o = null;
                (await sender.getStats()).forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video') o = r; });
                if (!o || typeof o.targetBitrate !== 'number') return;
                const act = st.adapter.step({ atMs: performance.now(), targetKbps: o.targetBitrate / 1000, bytesSent: o.bytesSent,
                    framesEncoded: o.framesEncoded, limit: o.qualityLimitationReason ?? 'none' });
                if (act.height !== undefined) { await applyShareHeight(sender, sourceHeight, act.height); window.__changes.height++; }
                if (act.contentHint) { mst.contentHint = act.contentHint; window.__changes.hint++; }
            } finally { st.busy = false; }
        };
        timers.push(setInterval(tick, PucaShareAdapt.SHARE_ADAPT_INTERVAL_MS));
        return tick();
    };
    window.__share = async () => {
        const track = canvas.captureStream(30).getVideoTracks()[0];
        track.contentHint = 'motion'; // media.ts
        const pub = await room.localParticipant.publishTrack(track, opts);
        window.__track = track; window.__sender = pub.track.sender;
        if (MODE === 'adapt') await adapt(pub, track);
    };
    window.__unshare = async () => {
        timers.forEach(clearInterval); timers.length = 0;
        await room.localParticipant.unpublishTrack(window.__track, true);
        window.__sender = null;
    };
    window.__sample = async () => {
        if (!window.__sender) return null;
        let o = null; (await window.__sender.getStats()).forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video') o = r; });
        return o ? { h: o.frameHeight, size: `${o.frameWidth}x${o.frameHeight}`, encoded: o.framesEncoded, bytes: o.bytesSent, target: Math.round((o.targetBitrate || 0) / 1000), limit: o.qualityLimitationReason } : null;
    };
    await window.__share();
}, { url: LK_WS, tok: token('sharer'), MODE });

const t0 = Date.now();
const series = [];
let lifted = false, stopped = false, restarted = false;
let prev = null, prevV = null;
while (Date.now() - t0 < TOTAL) {
    await new Promise(r => setTimeout(r, 2000));
    const t = Date.now() - t0;
    if (LATER_RATE !== null && !lifted && t >= LATER_AT) { shaper.set({ rateKbps: LATER_RATE }); lifted = true; console.log(`--- link -> ${LATER_RATE} kbps`); }
    if (RESHARE_STOP !== null && !stopped && t >= RESHARE_STOP) { await sharer.evaluate(() => window.__unshare()); stopped = true; console.log('--- share ended'); prev = null; }
    if (RESHARE_STOP !== null && !restarted && t >= RESHARE_START) { await sharer.evaluate(() => window.__share()); restarted = true; console.log('--- share started again'); prev = null; }
    const s = await sharer.evaluate(() => window.__sample());
    const v = await viewer.evaluate(() => window.__sample());
    const changes = await sharer.evaluate(() => window.__changes);
    const q = shaper.take();
    if (!s) { console.log(`${String(Math.round(t / 1000)).padStart(4)}s (no share)`); continue; }
    const fps = prev && s.encoded >= prev.encoded ? Math.round((s.encoded - prev.encoded) / ((t - prev.t) / 1000)) : null;
    const kbps = prev && s.bytes >= prev.bytes ? Math.round(((s.bytes - prev.bytes) * 8) / (t - prev.t)) : null;
    const vfps = prevV && v && v.decoded >= prevV.decoded ? Math.round((v.decoded - prevV.decoded) / ((t - prevV.t) / 1000)) : null;
    prev = { ...s, t }; prevV = v ? { ...v, t } : null;
    const row = { t: Math.round(t / 1000), sent: s.size, h: s.h, fps, kbps, target: s.target, limit: s.limit, queueMs: Math.round(q.maxQueueMs), viewer: v?.size ?? null, vh: v?.h ?? null, vfps, freezes: v?.freezes ?? null, changes };
    series.push(row);
    console.log(`${String(row.t).padStart(4)}s sent ${String(s.size).padEnd(10)} ${fps ?? '?'}fps ${kbps ?? '?'}kbps target=${s.target} ${s.limit} queue=${row.queueMs}ms | viewer ${row.viewer} @${vfps ?? '?'} freezes=${row.freezes} | rung changes ${changes.height}, hint changes ${changes.hint}`);
}
if (env.SHOT) await viewer.locator('video').first().screenshot({ path: env.SHOT }).catch(e => console.log('screenshot failed:', e.message));

const from = RESHARE_STOP !== null ? Math.round(RESHARE_START / 1000) : LATER_RATE !== null ? Math.round(LATER_AT / 1000) : 30;
const after = series.filter(r => r.t >= from);
const full = after.find(r => r.h >= 1070);
const tail = series.filter(r => r.t >= Math.max(30, from));
const med = (xs) => { const a = xs.filter(x => x !== null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
console.log(`\n${MODE}: ${LATER_RATE !== null || RESHARE_STOP !== null ? `full 1080p ${full ? `${full.t - from} s after t=${from}s` : 'never'}; ` : ''}viewer median ${med(tail.map(r => r.vh))} lines @ ${med(tail.map(r => r.vfps))} fps`);
if (env.OUT) writeFileSync(env.OUT, JSON.stringify(series, null, 1));
await browser.close();
srv.close();
shaper.close();
