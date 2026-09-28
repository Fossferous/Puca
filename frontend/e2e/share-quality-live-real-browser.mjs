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
    entryPoints: [join(here, '..', 'src', 'api', 'rtc', 'shareHealth.ts')],
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
const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); });
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
        video: shareVideoConstraints(1280, 720, 15), audio: false, preferCurrentTab: true, selfBrowserSurface: 'include',
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
    out.up = await recapDisplayTrack(track, 1920, 1080, 30);
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
ck(r.start.height === 720 && r.start.frameRate === 15, 'the share starts at its cap', `${r.start.width}x${r.start.height}@${r.start.frameRate}`);
ck(r.sentStill && r.sentStart && r.sentStill.h === r.sentStart.h, 'negative control: the sent size holds when nothing changes', `${r.sentStart?.h} -> ${r.sentStill?.h}`);
ck(r.up && r.up.height === 1080 && r.up.fps === 30, 'raising the cap re-sizes the live capture UP', JSON.stringify(r.up));
ck(r.liveAfterUp === 'live', 'the track stays live across the change');
ck(r.sentUp && r.sentStart && r.sentUp.h > r.sentStart.h, 'the encoder follows it up (more lines sent)', `${r.sentStart?.h} -> ${r.sentUp?.h}`);
ck(r.sentUp && r.sentUp.fps > 20, 'and at the higher frame rate', String(r.sentUp?.fps));
ck(r.down && r.down.height === 480 && r.down.fps === 10, 'lowering it re-sizes the capture DOWN', JSON.stringify(r.down));
ck(r.sentDown && r.sentDown.h <= 480 && r.sentDown.fps <= 12, 'the encoder follows it down', JSON.stringify(r.sentDown));
ck(r.beyond && r.beyondTrack && r.beyond.width === r.beyondTrack.width && r.beyond.height === r.beyondTrack.height && r.beyond.fps === r.beyondTrack.fps,
    'a cap past the source reports what the track produces, read back', `${JSON.stringify(r.beyond)} vs track ${JSON.stringify(r.beyondTrack)}`);
ck(r.sameTrack, 'no new track: the share never restarted');
ck(r.afterStop === null || (r.afterStop.height === 0 || r.afterStop.height <= 480), 'a stopped track reports no new size', JSON.stringify(r.afterStop));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
