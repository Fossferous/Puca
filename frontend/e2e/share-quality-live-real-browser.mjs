// Can a RUNNING share change resolution and frame rate, up AND down?
//
// WHY THIS EXISTS. Stream quality while live (LiveShareQualityModal) rests
// on one browser capability: `applyConstraints` re-sizing a LIVE display
// capture in place — no new track, no renegotiation, nobody dropped — and
// the encoder following. Before this, the app only ever LOWERED a live cap,
// and nothing had shown that raising one works at all. jsdom has no display
// capture, so no vitest can see it. This bundles the REAL helper
// (shareHealth.ts's recapDisplayTrack, via esbuild — no port to drift),
// captures a real surface in a real browser, and watches a loopback sender.
//
// PRIVATE AND SILENT: it captures ITS OWN TAB, never the screen or a window,
// and aborts unless the track says so (`displaySurface === 'browser'`). No
// audio track exists. Do NOT add --use-fake-ui-for-media-stream: it makes
// headless auto-pick the whole monitor.
//
// THE SIZES (640x360@15 -> 1280x720@30 -> 854x480@10) are the ones
// shareHealth.ts records, and they are deliberately not 1080p. This used to
// go 720p@15 -> 1080p@30 and failed on the owner's desktop in most runs from
// 2026-10-22 on, reporting 1 fps. Measured 2026-10-23 with a game running
// (CPU about half busy): every step before the raise was fine. But after a
// raise to 1920x1080@30, the CAPTURE delivered 1-10 frames a second
// (media-source framesPerSecond, the encoder reporting no limitation).
// Counted in Edge 155:
// - 1080p in a 1920x1080 tab: 9 of 11 runs;
// - 1080p in a 2560x1440 tab: 6 of 13;
// - 1600x900: 0 of 13;
// - this sequence: 0 of 8.
// Chrome 155 (2 of 4) and Chromium 153 (1 of 5) did it too. So 1080p@30
// headless tab capture, with VP8 encode and decode, all in one process, is
// a throughput test of the machine. This script asks something else: can a
// live capture go up and down in place, with the encoder following.
//
// What it does not do any more: pass a stalled pipeline. A share sending
// 1 fps once satisfied "follows it down" (an upper bound passes at zero).
// Frames now have to flow at the starting cap first, and the down step needs
// a floor as well as a ceiling.
//
// THE FRAME WATCH, second half (2026-10-26). shareHealth.ts now tells a share
// SHORT OF FRAMES (captured 30 of 60) from a STILL picture by what the encoder
// makes of its frames (MOVING_BPP, MOVING_TARGET_SHARE), read through
// statsSummary.ts shareSendReading. Both rest on what a real report carries
// and what a real encoder makes of real content, which no vitest can see, and
// the first threshold tried (0.01 bits a pixel) failed here: a repainted
// square measured 0.013-0.02. So the same own-tab capture, at 640x360 and 30
// fps, is shown five pictures: full-frame motion at the set rate (never "short
// at the capture": the negative control), the same motion at a third of it
// (short: the positive control), nothing changing, one small square changing
// a dozen times a second like a cursor, and text typed at ten characters a
// second (the last three still: what must never be offered a step down).
//
//   cd frontend && node e2e/share-quality-live-real-browser.mjs
//
// No server and no build needed.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
    // The real helpers, as the app runs them: the capture's re-size and the
    // frame watch (shareHealth.ts), and the reading it is fed (statsSummary.ts).
    stdin: {
        contents: "export * from './shareHealth'; export { shareSendReading } from './statsSummary';",
        resolveDir: join(here, '..', 'src', 'api', 'rtc'),
        loader: 'ts',
    },
    bundle: true, write: false, format: 'iife', globalName: 'ShareHealth', platform: 'browser',
});

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

const TITLE = 'puca-share-quality-self-capture';
// A moving picture, so the encoder has frames to send at every size.
const page = `<!doctype html><meta charset=utf-8><title>${TITLE}</title>
<body style="margin:0;overflow:hidden"><canvas id=c width=1920 height=1080></canvas>
<script>const x=document.getElementById('c').getContext('2d');let f=0;
setInterval(()=>{x.fillStyle='hsl('+(f++%360)+',70%,50%)';x.fillRect(0,0,1920,1080);},16)</script>`;
// The frame watch's pictures (same title, so the same auto-selected tab):
// noise shifted every frame is motion no encoder can skip; a still canvas is
// nothing to send; one 40 px square repainted, or a character typed onto a
// page of text, is a few hundred bytes a frame.
const framesPage = `<!doctype html><meta charset=utf-8><title>${TITLE}</title>
<body style="margin:0;overflow:hidden;background:#222"><canvas id=c width=640 height=360 style="width:100vw;height:100vh;display:block"></canvas>
<script>
const c = document.getElementById('c'), x = c.getContext('2d');
const noise = [0, 1, 2, 3].map(() => {
    const n = document.createElement('canvas'); n.width = 704; n.height = 424;
    const g = n.getContext('2d'), d = g.createImageData(704, 424);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = v; d.data[i + 1] = 255 - v; d.data[i + 2] = (v * 7) % 255; d.data[i + 3] = 255; }
    g.putImageData(d, 0, 0); return n;
});
let t = null, f = 0, col = 0;
const drawNoise = () => x.drawImage(noise[f++ % 4], -Math.floor(Math.random() * 64), -Math.floor(Math.random() * 64));
const drawBox = () => { x.fillStyle = 'hsl(' + ((f++ * 47) % 360) + ',70%,50%)'; x.fillRect(24, 24, 40, 40); };
const page = () => {
    x.fillStyle = '#f3f3f3'; x.fillRect(0, 0, 640, 360); x.fillStyle = '#222'; x.font = '14px sans-serif';
    for (let y = 20; y < 360; y += 18) x.fillText('The quick brown fox jumps over the lazy dog, line ' + y, 10, y);
};
const type = () => { x.fillStyle = '#222'; x.font = '14px monospace'; x.fillText(String.fromCharCode(97 + (f++ % 26)), 10 + (col % 60) * 9, 40 + (Math.floor(col / 60) % 18) * 18); col++; };
drawNoise();
window.setPicture = (kind, fps) => {
    clearInterval(t); t = null;
    if (kind === 'type') page();
    if (kind !== 'still') t = setInterval(kind === 'noise' ? drawNoise : kind === 'type' ? type : drawBox, 1000 / fps);
};
</script>`;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/frames' ? framesPage : page);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const CHANNEL = process.env.CHANNEL || 'msedge';
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--mute-audio', `--auto-select-tab-capture-source-by-title=${TITLE}`],
});
const tab = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
await tab.goto(`http://127.0.0.1:${server.address().port}/`);
await tab.addScriptTag({ content: bundle.outputFiles[0].text });

const r = await tab.evaluate(async () => {
    const { shareVideoConstraints, recapDisplayTrack } = window.ShareHealth;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const stream = await navigator.mediaDevices.getDisplayMedia({
        video: shareVideoConstraints(640, 360, 15), audio: false, preferCurrentTab: true, selfBrowserSurface: 'include',
    });
    const track = stream.getVideoTracks()[0];
    const surface = track.getSettings().displaySurface;
    if (surface !== 'browser') { track.stop(); return { surface }; } // privacy: own tab only
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
    const sender = pc1.addTrack(track, stream);
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription);
    const sent = async () => {
        let o = null;
        (await sender.getStats()).forEach((x) => {
            if (x.type === 'outbound-rtp' && x.kind === 'video') o = { w: x.frameWidth, h: x.frameHeight, fps: x.framesPerSecond };
        });
        return o;
    };
    const out = { surface, start: track.getSettings() };
    await sleep(3000);
    out.sentStart = await sent();
    // Negative control: nothing changes by itself.
    await sleep(1500);
    out.sentStill = await sent();
    // UP: a cap raised on a live track.
    out.up = await recapDisplayTrack(track, 1280, 720, 30);
    await sleep(4000);
    out.sentUp = await sent();
    out.liveAfterUp = track.readyState;
    // DOWN.
    out.down = await recapDisplayTrack(track, 854, 480, 10);
    await sleep(4000);
    out.sentDown = await sent();
    // Past the source. MEASURED: a TAB is re-rendered at the asked size (this
    // 1920x1080 tab reports 3840x2160), where a window or screen stays at its
    // source's size. Either way the helper must report what the TRACK says,
    // never echo the request.
    out.beyond = await recapDisplayTrack(track, 3840, 2160, 60);
    const bs = track.getSettings();
    out.beyondTrack = { width: bs.width, height: bs.height, fps: Math.round(bs.frameRate ?? 0) };
    out.sameTrack = stream.getVideoTracks()[0] === track;
    pc1.close(); pc2.close();
    track.stop();
    // A stopped track: the helper must not report a size it cannot have.
    out.afterStop = await recapDisplayTrack(track, 1280, 720, 30);
    return out;
});

if (r.surface !== 'browser') {
    console.log(`ABORT: the capture was "${r.surface}", not this tab — refusing to measure anything else.`);
    await browser.close(); server.close();
    process.exit(2);
}
ck(r.start.height === 360 && r.start.frameRate === 15, 'the share starts at its cap', `${r.start.width}x${r.start.height}@${r.start.frameRate}`);
// POSITIVE CONTROL: frames flow at the starting cap, so a low rate later is
// the step under test, not a pipeline that never ran.
ck(r.sentStart && r.sentStart.fps >= 10 && r.sentStart.fps <= 17, 'the encoder sends at the starting rate', String(r.sentStart?.fps));
ck(r.sentStill && r.sentStart && r.sentStill.h === r.sentStart.h, 'negative control: the sent size holds when nothing changes', `${r.sentStart?.h} -> ${r.sentStill?.h}`);
ck(r.up && r.up.height === 720 && r.up.fps === 30, 'raising the cap re-sizes the live capture UP', JSON.stringify(r.up));
ck(r.liveAfterUp === 'live', 'the track stays live across the change');
ck(r.sentUp && r.sentStart && r.sentUp.h > r.sentStart.h, 'the encoder follows it up (more lines sent)', `${r.sentStart?.h} -> ${r.sentUp?.h}`);
ck(r.sentUp && r.sentUp.fps > 20, 'and at the higher frame rate', String(r.sentUp?.fps));
ck(r.down && r.down.height === 480 && r.down.fps === 10, 'lowering it re-sizes the capture DOWN', JSON.stringify(r.down));
ck(r.sentDown && r.sentUp && r.sentDown.h <= 480 && r.sentDown.h < r.sentUp.h && r.sentDown.fps >= 6 && r.sentDown.fps <= 12,
    'the encoder follows it down (fewer lines, about 10 fps)', JSON.stringify(r.sentDown));
ck(r.beyond && r.beyondTrack && r.beyond.width === r.beyondTrack.width && r.beyond.height === r.beyondTrack.height && r.beyond.fps === r.beyondTrack.fps,
    'a cap past the source reports what the track produces, read back', `${JSON.stringify(r.beyond)} vs track ${JSON.stringify(r.beyondTrack)}`);
ck(r.sameTrack, 'no new track: the share never restarted');
ck(r.afterStop === null || (r.afterStop.height === 0 || r.afterStop.height <= 480), 'a stopped track reports no new size', JSON.stringify(r.afterStop));

// ---- the frame watch on a real capture and a real encoder ----------------
await tab.goto(`http://127.0.0.1:${server.address().port}/frames`);
await tab.addScriptTag({ content: bundle.outputFiles[0].text });
const w = await tab.evaluate(async () => {
    const {
        shareVideoConstraints, shareSendReading, frameVerdict, bitsPerPixel, sentKbps, MOVING_BPP, MOVING_TARGET_SHARE, STILL_FPS,
    } = window.ShareHealth;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const stream = await navigator.mediaDevices.getDisplayMedia({
        video: shareVideoConstraints(640, 360, 30), audio: false, preferCurrentTab: true, selfBrowserSurface: 'include',
    });
    const track = stream.getVideoTracks()[0];
    const surface = track.getSettings().displaySurface;
    if (surface !== 'browser') { track.stop(); return { surface }; } // privacy: own tab only
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
    const sender = pc1.addTrack(track, stream);
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription);
    // One reading, exactly as sfuManager.shareEncodeSample builds it.
    const read = async () => ({
        atMs: performance.now(),
        ...shareSendReading(await sender.getStats(), track.getSettings().frameRate, sender.getParameters().encodings),
    });
    const phase = async (kind, fps) => {
        window.setPicture(kind, fps);
        await sleep(2500);
        let prev = await read();
        const out = [];
        for (let i = 0; i < 4; i++) {
            await sleep(2000);
            const s = await read();
            const kbps = sentKbps(s, prev);
            const target = s.sent?.targetKbps ?? null;
            out.push({
                verdict: frameVerdict(s, prev), capture: s.captureFps ?? null, sent: s.sent?.fps ?? null, bpp: bitsPerPixel(s, prev),
                share: kbps !== null && target ? kbps / target : null,
            });
            prev = s;
        }
        return out;
    };
    await sleep(3000); // the encoder and the bandwidth estimate settle on the noise
    const out = { surface, MOVING_BPP, MOVING_TARGET_SHARE, STILL_FPS, first: await read() };
    out.motion = await phase('noise', 30);
    out.motionThird = await phase('noise', 10);
    out.still = await phase('still', 0);
    out.small = await phase('box', 12);
    out.typing = await phase('type', 10);
    pc1.close(); pc2.close();
    track.stop();
    return out;
});

if (w.surface !== 'browser') {
    console.log(`ABORT: the capture was "${w.surface}", not this tab — refusing to measure anything else.`);
    await browser.close(); server.close();
    process.exit(2);
}
const { MOVING_BPP, MOVING_TARGET_SHARE, STILL_FPS } = w;
const median = (xs) => { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const count = (p, v) => p.filter((x) => x.verdict === v).length;
const fix = (x, d) => (typeof x === 'number' ? x.toFixed(d) : '?');
const show = (p) => p.map((x) => `${x.verdict}(cap ${x.capture}, sent ${x.sent}, bpp ${fix(x.bpp, 4)}, of target ${fix(x.share, 2)})`).join(' ');
const f = w.first;
ck(f.setFps === 30 && typeof f.captureFps === 'number' && typeof f.sent?.frames === 'number' && typeof f.sent?.bytes === 'number'
    && f.sent?.height > 0 && typeof f.sent?.ssrc === 'number' && typeof f.sent?.targetKbps === 'number',
'a real sender report carries every field the frame watch reads (set, captured, sent, counters, size, ssrc, target)', JSON.stringify(f));
ck(count(w.motion, 'capture') === 0, 'negative control: motion captured at the rate set is never short at the capture', show(w.motion));
ck((median(w.motion.map((x) => x.bpp)) ?? 0) >= MOVING_BPP && (median(w.motion.map((x) => x.share)) ?? 0) >= MOVING_TARGET_SHARE,
    `full-frame motion is moving by both measures (${MOVING_BPP} bits a pixel, ${MOVING_TARGET_SHARE} of the target)`, show(w.motion));
ck(count(w.motionThird, 'capture') >= 2, 'positive control: the same motion at a third of the rate set IS short at the capture', show(w.motionThird));
ck(count(w.still, 'capture') + count(w.still, 'send') === 0 && count(w.still, 'still') >= 3,
    'a picture where nothing changes is still, never short', show(w.still));
for (const [name, p] of [['a small square repainted (a cursor)', w.small], ['text being typed', w.typing]]) {
    ck(count(p, 'capture') + count(p, 'send') === 0 && count(p, 'still') >= 3, `${name} is still, never short`, show(p));
    // Decided by the frames, not the floor: it captures more than STILL_FPS.
    ck((median(p.map((x) => x.capture)) ?? 0) > STILL_FPS && (median(p.map((x) => x.bpp)) ?? 1) < MOVING_BPP
        && (median(p.map((x) => x.share)) ?? 1) < MOVING_TARGET_SHARE,
    `${name}: over ${STILL_FPS} fps captured, and still by what the encoder made of it`, show(p));
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
