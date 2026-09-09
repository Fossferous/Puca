// WHICH ENCODER does this machine's browser actually use for a WebRTC video
// send, and can a launch flag change it?
//
// THE QUESTION. Every `[stream-diag]` line the app has ever written says
// `encoder=OpenH264` — the SOFTWARE H.264 encoder — on machines with perfectly
// good hardware encoders. The native agent on the same machine encodes with
// "NVIDIA H.264 Encoder MFT". So the hardware is there and the browser is not
// using it, and that is the single biggest cost on a sharer's CPU.
//
// This probe answers three things the app's own logs cannot:
//   1. what `encoderImplementation` actually reads for a plain send;
//   2. whether it differs for SCREEN-shaped content (contentHint 'detail'/
//      'motion'), which is what a share is;
//   3. whether any launch flag moves it.
//
// It uses a loopback pair rather than a real call: the encoder choice is made
// by the sending side alone, so no server, no account and no second machine
// are needed.
//
// Usage (from frontend/):
//   node e2e/encoder-probe.mjs
//   CHANNEL=msedge CODEC=video/H264 HINT=motion node e2e/encoder-probe.mjs
//   ARGS="--disable-accelerated-video-encode" node e2e/encoder-probe.mjs
import { chromium } from '@playwright/test';

const CHANNEL = process.env.CHANNEL || 'msedge';
const CODEC = process.env.CODEC || 'video/H264';
const HINT = process.env.HINT || '';
const SECONDS = Number(process.env.SECONDS || 12);
const EXTRA = (process.env.ARGS || '').split(' ').filter(Boolean);
const W = Number(process.env.W || 1920);
const H = Number(process.env.H || 1080);

const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--autoplay-policy=no-user-gesture-required', ...EXTRA],
});
const page = await browser.newPage();
await page.goto('about:blank');

const result = await page.evaluate(async ({ CODEC, HINT, SECONDS, W, H }) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const shapes = Array.from({ length: 120 }, (_, i) => ({
        x: (i * 137) % W, y: (i * 71) % H, vx: 2 + (i % 7), vy: 1 + (i % 5), r: 20 + (i % 60),
    }));
    let frame = 0;
    const timer = setInterval(() => {
        frame++;
        const g = ctx.createLinearGradient(0, (frame * 2) % H, W, H);
        g.addColorStop(0, '#123'); g.addColorStop(1, '#0b1220');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        for (const s of shapes) {
            s.x = (s.x + s.vx) % W; s.y = (s.y + s.vy) % H;
            ctx.fillStyle = `hsl(${(s.x + frame) % 360} 90% 55%)`;
            ctx.fillRect(s.x, s.y, s.r, s.r);
        }
        ctx.fillStyle = '#fff'; ctx.fillRect((frame * 19) % W, 0, 60, H);
    }, 1000 / 60);

    const stream = canvas.captureStream(60);
    const track = stream.getVideoTracks()[0];
    // A screen share sets a content hint; the encoder choice can depend on it.
    if (HINT) track.contentHint = HINT;

    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate);
    const tr = pc1.addTransceiver(track, { direction: 'sendonly', streams: [stream] });

    // Pin the codec so the answer is about THIS codec's encoder.
    const caps = RTCRtpSender.getCapabilities('video');
    const wanted = caps.codecs.filter(c => c.mimeType === CODEC);
    if (wanted.length && tr.setCodecPreferences) {
        tr.setCodecPreferences([...wanted, ...caps.codecs.filter(c => c.mimeType !== CODEC)]);
    }
    const available = [...new Set(caps.codecs.map(c => c.mimeType))];

    const params = tr.sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 8_000_000;
    params.encodings[0].maxFramerate = 60;
    await tr.sender.setParameters(params);

    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    await sleep(SECONDS * 1000);

    let out = null;
    (await pc1.getStats()).forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video') out = r; });
    clearInterval(timer); pc1.close(); pc2.close();

    return {
        codecsOffered: available,
        // EVERY key, not just the one we expect: `encoderImplementation` coming
        // back undefined is itself a finding, and the raw keys say whether the
        // field is missing or merely named something else in this build.
        outboundKeys: out ? Object.keys(out).sort() : [],
        encoder: out?.encoderImplementation ?? '(absent)',
        powerEfficient: out?.powerEfficientEncoder ?? '(absent)',
        size: out ? `${out.frameWidth}x${out.frameHeight}` : '(none)',
        fps: Math.round(out?.framesPerSecond ?? 0),
        limit: out?.qualityLimitationReason ?? '(absent)',
        framesEncoded: out?.framesEncoded ?? 0,
    };
}, { CODEC, HINT, SECONDS, W, H });

console.log(`channel=${CHANNEL} codec=${CODEC} hint=${HINT || '(none)'} size=${W}x${H} args=${EXTRA.join(' ') || '(none)'}`);
console.log(`  encoder            : ${result.encoder}`);
console.log(`  powerEfficient     : ${result.powerEfficient}`);
console.log(`  produced           : ${result.size} @ ${result.fps} fps, limit=${result.limit}, frames=${result.framesEncoded}`);
console.log(`  codecs offered     : ${result.codecsOffered.join(' ')}`);
if (result.encoder === '(absent)') {
    console.log(`  outbound-rtp keys  : ${result.outboundKeys.join(' ')}`);
}
await browser.close();
