// Does the stream-stats overlay read REAL getStats reports correctly?
//
// WHY THIS EXISTS. src/api/rtc/streamStats.ts reduces RTCStatsReports into the
// numbers the tile overlay shows (right-click a stream → Show Stream Stats).
// Its vitest suite feeds it hand-written rows, which can only prove it against
// the field names its author expected. Chromium's real reports decide whether
// `powerEfficientDecoder` exists, whether a receiver-scoped report carries
// the codec and the candidate pair, and what a byte counter looks like one
// second later. So this bundles the REAL module (esbuild, no port that can
// drift), negotiates a loopback pair in a real browser, and runs the
// reducer and the sampler on what that browser reports — both directions.
//
// The same real reports also go through statsSummary.ts, the reducer the
// minute health line and the 5 s sampler read (2026-10-26): a viewer's line
// must carry what a freeze came with (NACKs, PLIs, keyframes, bytes and the
// RTP jitter), and those are only as real as the field names Chromium uses.
//
// A FREEZE IN PROGRESS (2026-11-19: a share froze for 65 s and the overlay
// said "0 freezes" all through it, because WebRTC counts a freeze only with
// the frame that ends it). A canvas stream over the same kind of loopback,
// read by the REAL sampler once a second as the overlay reads it:
//   - every frame dropped at the receiver for 8 s (an encoded transform that
//     forwards nothing: packets keep arriving, no frame decodes, as on a
//     lossy path): the view says frozen within 4 s and counts up, while
//     Chromium's own freezeCount stays where it was; frames back, the view
//     clears and Chromium counts ONE freeze and no pause;
//   - CONTROLS: the sender stops drawing for 8 s (no packets: Chromium counts
//     a pause, not a freeze), the sender's track disabled (black frames at
//     the full rate), and a share of a still canvas at about 1 fps (a frame
//     every 1.25 s, so one second in five or more brings none, whatever the
//     phase): never frozen, each premise checked from Chromium's counters
//     first.
//
// SILENT: video only, from the fake camera and a canvas; no audio track
// exists at all.
//
//   cd frontend && node e2e/stream-stats-real-browser.mjs
//
// No server and no build needed. ~1.5 min.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
    stdin: {
        contents: "export * from './streamStats'; export { summariseRtcStatsDelta, formatLatencyLine } from './statsSummary';",
        resolveDir: join(here, '..', 'src', 'api', 'rtc'),
        loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'StreamStats',
    platform: 'browser',
});
const moduleSrc = bundle.outputFiles[0].text;

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

// A real origin: encoderImplementation is withheld unless the document holds
// an active capture, and about:blank is not a secure context.
const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><meta charset=utf-8><title>stream-stats</title><body>rig</body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/`;

const CHANNEL = process.env.CHANNEL || 'msedge';
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--mute-audio', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const page = await (await browser.newContext({ permissions: ['camera'] })).newPage();
await page.goto(origin);
await page.addScriptTag({ content: moduleSrc });

const r = await page.evaluate(async () => {
    const { summariseStreamStats, StreamStatsSampler, summariseRtcStatsDelta, formatLatencyLine } = window.StreamStats;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const src = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: false });
    const track = src.getVideoTracks()[0];

    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
    const sender = pc1.addTrack(track, src);
    const got = new Promise((res) => { pc2.ontrack = (e) => res(e.receiver); });
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription);
    const receiver = await got;
    await sleep(2500); // let the encoder and the bandwidth estimate settle

    // The reducer on two real reads, one second apart.
    const inPrev = await receiver.getStats();
    const outPrev = await sender.getStats();
    await sleep(1000);
    const inNow = await receiver.getStats();
    const outNow = await sender.getStats();
    const inbound = summariseStreamStats([{ direction: 'inbound', kind: 'video', prev: inPrev, now: inNow, ms: 1000 }]);
    const outbound = summariseStreamStats([{ direction: 'outbound', kind: 'video', prev: outPrev, now: outNow, ms: 1000 }]);
    // Negative control: a first read has no window, so no rate.
    const firstRead = summariseStreamStats([{ direction: 'inbound', kind: 'video', prev: null, now: inNow, ms: 0 }]);
    // The health line's reducer on the same two reads (healthLog.ts videoInOf).
    const health = summariseRtcStatsDelta(inPrev, inNow, 1000).inbound[0] ?? null;
    const healthLine = health ? formatLatencyLine({ inbound: [health], outbound: [], pair: null, remoteInbound: [] }) : '';

    // The sampler, on the same endpoints: its first sample is unmeasured,
    // its second a real one-window rate.
    const sampler = new StreamStatsSampler(() => [
        { key: receiver, direction: 'inbound', kind: 'video', getStats: () => receiver.getStats() },
    ]);
    const s1 = await sampler.sample();
    await sleep(1000);
    const s2 = await sampler.sample();

    // Negative control: no endpoint carries video.
    const none = summariseStreamStats([]);
    pc1.close(); pc2.close();

    // H.264, forced first: the codec line must name the PROFILE, the thing
    // that decides whether a hardware encoder takes the share at all.
    let h264 = null;
    const h264Codecs = RTCRtpSender.getCapabilities('video').codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
    if (h264Codecs.length > 0) {
        const a = new RTCPeerConnection();
        const b = new RTCPeerConnection();
        a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
        b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
        const tx = a.addTransceiver(track, { direction: 'sendonly', streams: [src] });
        const rest = RTCRtpSender.getCapabilities('video').codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264');
        tx.setCodecPreferences([...h264Codecs, ...rest]);
        const gotB = new Promise((res) => { b.ontrack = (e) => res(e.receiver); });
        await a.setLocalDescription(await a.createOffer());
        await b.setRemoteDescription(a.localDescription);
        await b.setLocalDescription(await b.createAnswer());
        await a.setRemoteDescription(b.localDescription);
        const rx = await gotB;
        await sleep(1500);
        const p = await rx.getStats();
        await sleep(1000);
        const n = await rx.getStats();
        h264 = summariseStreamStats([{ direction: 'inbound', kind: 'video', prev: p, now: n, ms: 1000 }]);
        a.close(); b.close();
    }
    track.stop();
    return { inbound, outbound, firstRead, s1, s2, none, h264, h264Available: h264Codecs.length > 0, health, healthLine };
});

const i = r.inbound;
ck(i && i.direction === 'inbound', 'inbound view built from a real receiver report');
ck(i && /^\d+x\d+$/.test(i.size ?? ''), 'inbound size is read', i?.size);
ck(i && i.fps > 5, 'inbound fps is a real rate', String(i?.fps));
ck(i && i.videoKbps > 50, 'inbound video bitrate is a real one-second rate', `${i?.videoKbps} kbps`);
ck(i && typeof i.codec === 'string' && i.codec.length > 1, 'inbound codec is named', i?.codec);
ck(i && typeof i.implementation === 'string', 'inbound decoder is named', i?.implementation);
ck(i && typeof i.lossPct === 'number', 'inbound loss is a percentage over the window', String(i?.lossPct));
ck(i && i.measured === true, 'two reads are a measured window');
ck(i && typeof i.transport === 'string', 'the route (candidate pair) is read from a receiver-scoped report', i?.transport);

const o = r.outbound;
ck(o && o.direction === 'outbound', 'outbound view built from a real sender report');
ck(o && /^\d+x\d+$/.test(o.size ?? ''), 'outbound size is read', o?.size);
ck(o && o.fps > 5, 'outbound fps is a real rate', String(o?.fps));
ck(o && o.videoKbps > 50, 'outbound video bitrate is a real rate', `${o?.videoKbps} kbps`);
ck(o && typeof o.limit === 'string', 'outbound quality limitation is read', o?.limit);
ck(o && typeof o.implementation === 'string', 'outbound encoder is named', o?.implementation);
ck(o && o.viewers === 1, 'one sender is one viewer', String(o?.viewers));

ck(r.firstRead && r.firstRead.measured === false && r.firstRead.videoKbps === null,
    'negative control: a first read reports no rate');
ck(r.s1 && r.s1.measured === false, 'the sampler\'s first sample is unmeasured');
ck(r.s2 && r.s2.measured === true && r.s2.videoKbps > 50, 'the sampler\'s second sample is a real rate', `${r.s2?.videoKbps} kbps`);
ck(r.none === null, 'negative control: no video endpoint, no view');

// What a freeze came with, in the health reducer, from a REAL inbound report.
const hv = r.health;
ck(hv && typeof hv.jitterMs === 'number' && hv.jitterMs >= 0, 'the RTP jitter is read (inbound-rtp jitter, ms)', String(hv?.jitterMs));
ck(hv && typeof hv.nack === 'number' && typeof hv.pli === 'number' && typeof hv.keyFrames === 'number',
    'NACKs, PLIs and keyframes are counted over the window', JSON.stringify({ nack: hv?.nack, pli: hv?.pli, keyFrames: hv?.keyFrames }));
ck(hv && typeof hv.bytes === 'number' && hv.bytes * 8 / 1000 > 50, 'the window\'s bytes give a real rate (kbps in the health line)', `${hv ? Math.round(hv.bytes * 8 / 1000) : '?'} kbps`);
ck(/ nack=\d+ pli=\d+ jit=\d+ms/.test(r.healthLine), 'the 5 s line prints them, as numbers', r.healthLine);

if (r.h264Available) {
    ck(r.h264 && /^H264 (Constrained Baseline|Baseline|Main|High|Constrained High)$/.test(r.h264.codec ?? ''),
        'an H.264 stream names its profile', r.h264?.codec);
} else {
    console.log('SKIP an H.264 stream names its profile (this browser offers no H.264)');
}

// ---- a freeze in progress, on a real loopback ------------------------------
const fz = await page.evaluate(async () => {
    const { StreamStatsSampler } = window.StreamStats;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    /** A canvas stream to a receiver whose encoded transform can drop every
     *  frame. `slow`: one frame per requestFrame, every 1.25 s. */
    async function rig({ slow = false } = {}) {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        let n = 0;
        const draw = () => {
            n++;
            ctx.fillStyle = `hsl(${(n * 7) % 360} 70% 50%)`;
            ctx.fillRect(0, 0, 640, 360);
            ctx.fillStyle = '#fff';
            ctx.font = '48px sans-serif';
            ctx.fillText(String(n), 40, 120 + (n % 100));
        };
        const stream = canvas.captureStream(slow ? 0 : 30);
        const track = stream.getVideoTracks()[0];
        const state = { drawing: true, drop: false };
        let timer;
        if (slow) {
            const tick = () => { draw(); track.requestFrame(); timer = setTimeout(tick, 1250); };
            tick();
        } else {
            timer = setInterval(() => { if (state.drawing) draw(); }, 33);
        }
        const pc1 = new RTCPeerConnection();
        const pc2 = new RTCPeerConnection({ encodedInsertableStreams: true });
        pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
        pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
        pc1.addTrack(track, stream);
        const got = new Promise((res) => {
            pc2.ontrack = (e) => {
                const { readable, writable } = e.receiver.createEncodedStreams();
                readable.pipeThrough(new TransformStream({ transform(frame, c) { if (!state.drop) c.enqueue(frame); } })).pipeTo(writable);
                res(e.receiver);
            };
        });
        await pc1.setLocalDescription(await pc1.createOffer());
        await pc2.setRemoteDescription(pc1.localDescription);
        await pc2.setLocalDescription(await pc2.createAnswer());
        await pc1.setRemoteDescription(pc2.localDescription);
        const rx = await got;
        // The overlay's sampler, with the endpoint as both managers build it.
        const sampler = new StreamStatsSampler(() => [{
            key: rx, direction: 'inbound', kind: 'video', getStats: () => rx.getStats(),
            muted: () => rx.track.muted || rx.track.readyState !== 'live',
        }]);
        const reads = [];
        const t0 = performance.now();
        /** Sample once a second for `seconds`, each read labelled `phase`. */
        const run = async (phase, seconds) => {
            for (let i = 0; i < seconds; i++) {
                const started = performance.now();
                const v = await sampler.sample();
                let raw = null;
                (await rx.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') raw = s; });
                reads.push({
                    phase, t: Math.round(performance.now() - t0),
                    frozenMs: v?.frozenMs ?? null, fps: v?.fps ?? null, freezes: v?.freezes ?? null, measured: v?.measured ?? false,
                    decoded: raw?.framesDecoded ?? null, bytes: raw?.bytesReceived ?? null,
                    freezeCount: raw?.freezeCount ?? null, pauseCount: raw?.pauseCount ?? null, muted: rx.track.muted,
                });
                await sleep(Math.max(0, 1000 - (performance.now() - started)));
            }
        };
        const stop = () => { clearInterval(timer); clearTimeout(timer); pc1.close(); pc2.close(); track.stop(); canvas.remove(); };
        return { state, track, run, reads, stop };
    }

    const a = await rig();
    await a.run('flow', 5);
    a.state.drop = true;
    await a.run('dropped', 8);
    a.state.drop = false;
    await a.run('back', 5);
    a.state.drawing = false;
    await a.run('idle', 8);
    a.state.drawing = true;
    await a.run('drawing', 5);
    a.track.enabled = false;
    await a.run('disabled', 6);
    a.track.enabled = true;
    await a.run('enabled', 2);
    a.stop();

    const s = await rig({ slow: true });
    await s.run('one-fps', 18);
    s.stop();
    return { reads: a.reads, slow: s.reads };
});

const phase = (name, list = fz.reads) => list.filter((x) => x.phase === name);
const grew = (xs, k) => xs.length > 1 && xs[xs.length - 1][k] > xs[0][k];
const flat = (xs, k) => xs.every((x) => x[k] === xs[0][k]);
const before = (name, list = fz.reads) => list[list.indexOf(phase(name, list)[0]) - 1];
const fmt = (xs) => xs.map((x) => `${x.phase}@${x.t}:${x.frozenMs ?? '-'}/${x.decoded}f/${x.bytes}B/fc${x.freezeCount}/pc${x.pauseCount}`).join(' ');

// Frames dropped at the receiver: a real freeze.
const dropped = phase('dropped');
const back = phase('back');
const frozenAt = dropped.findIndex((x) => x.frozenMs !== null);
ck(grew(dropped, 'bytes') && flat(dropped.slice(1), 'decoded'),
    'premise: with every frame dropped at the receiver, packets keep arriving and no frame is decoded', fmt(dropped));
ck(dropped.every((x) => x.freezeCount === before('dropped').freezeCount),
    'Chromium\'s freezeCount does not move while the picture is frozen (it counts a freeze when it ends)', fmt(dropped));
ck(frozenAt >= 0 && frozenAt <= 4, 'the overlay says frozen within 4 s of the picture stopping', `first at read ${frozenAt} of the freeze`);
const shown = dropped.slice(frozenAt).map((x) => x.frozenMs);
ck(frozenAt >= 0 && shown.every((ms, k) => ms !== null && (k === 0 || ms > shown[k - 1])) && shown.at(-1) >= 5000,
    'and it counts up, every read, to the freeze\'s length', JSON.stringify(shown));
const cleared = back.findIndex((x) => x.frozenMs === null && x.decoded > dropped.at(-1).decoded);
ck(cleared >= 0 && cleared <= 3 && back.slice(cleared).every((x) => x.frozenMs === null),
    'frames back: the overlay stops saying frozen', fmt(back));
ck(back.at(-1).freezeCount === before('dropped').freezeCount + 1 && back.at(-1).pauseCount === before('dropped').pauseCount,
    'and Chromium then counts it: one freeze, no pause', `freezeCount ${before('dropped').freezeCount} -> ${back.at(-1).freezeCount}, pauseCount ${back.at(-1).pauseCount}`);
ck(back.some((x) => x.freezes >= 1), 'the window\'s freezes count shows it once frames are back', JSON.stringify(back.map((x) => x.freezes)));

// CONTROL: the sender stops sending. A pause, not a freeze.
const idle = phase('idle');
ck(flat(idle.slice(2), 'decoded') && flat(idle.slice(2), 'bytes'),
    'premise: a sender that stops drawing sends nothing (no frame, no packet)', fmt(idle));
ck(idle.every((x) => x.frozenMs === null), 'CONTROL: the sender stopping is never shown as frozen', fmt(idle));
const drawing = phase('drawing');
ck(drawing.at(-1).pauseCount === before('idle').pauseCount + 1 && drawing.at(-1).freezeCount === before('idle').freezeCount,
    'and Chromium counts it as a pause, not a freeze', `pauseCount ${before('idle').pauseCount} -> ${drawing.at(-1).pauseCount}, freezeCount ${before('idle').freezeCount} -> ${drawing.at(-1).freezeCount}`);

// CONTROL: the sender's track disabled: black frames, at the full rate.
const disabled = phase('disabled');
ck(disabled.slice(1).every((x) => x.fps >= 10), 'premise: a disabled sender track still sends frames (black ones)', JSON.stringify(disabled.map((x) => x.fps)));
ck(disabled.every((x) => x.frozenMs === null), 'CONTROL: a disabled sender track is never shown as frozen', fmt(disabled));

// CONTROL: a share of a still canvas at about 1 fps.
const slow = fz.slow.filter((x) => x.measured);
const frameless = slow.filter((x) => x.fps === 0).length;
ck(frameless >= 3, 'premise: a share at a frame every 1.25 s has seconds with no frame (a "no frame this second" rule would fire)', `${frameless} of ${slow.length} reads`);
ck(fz.slow.every((x) => x.frozenMs === null), 'CONTROL: a share at about 1 fps is never shown as frozen', fmt(fz.slow));
ck(fz.slow.every((x) => !x.freezeCount), 'and Chromium agrees: no freeze counted', JSON.stringify(fz.slow.map((x) => x.freezeCount)));

console.log(`\n${pass} passed, ${fail} failed`);
console.log(JSON.stringify({ inbound: i, outbound: o }, null, 1));
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
