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
// SILENT: video only, from the fake camera; no audio track exists at all.
//
//   cd frontend && node e2e/stream-stats-real-browser.mjs
//
// No server and no build needed.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
    entryPoints: [join(here, '..', 'src', 'api', 'rtc', 'streamStats.ts')],
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
    const { summariseStreamStats, StreamStatsSampler } = window.StreamStats;
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
    return { inbound, outbound, firstRead, s1, s2, none, h264, h264Available: h264Codecs.length > 0 };
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

if (r.h264Available) {
    ck(r.h264 && /^H264 (Constrained Baseline|Baseline|Main|High|Constrained High)$/.test(r.h264.codec ?? ''),
        'an H.264 stream names its profile', r.h264?.codec);
} else {
    console.log('SKIP an H.264 stream names its profile (this browser offers no H.264)');
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(JSON.stringify({ inbound: i, outbound: o }, null, 1));
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
