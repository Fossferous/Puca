// WHAT DOES ONE STEP DOWN THE SHARE LADDER ACTUALLY BUY?
//
// THE QUESTION. The app now offers somebody whose encoder is CPU-starved a
// one-click step down (720p / 1080p / 1440p / Source, then frame rate — see
// frontend/src/api/rtc/shareHealth.ts). That offer is only honest if the step
// is worth taking. "Fewer pixels is cheaper" is obviously true in direction
// and useless in size: half the cost, or five percent?
//
// WHAT IT MEASURES. `totalEncodeTime / framesEncoded` from outbound-rtp — the
// milliseconds the encoder spent per frame — across the sizes the dialog
// offers, with the SOFTWARE encoder forced. Software is the case that matters:
// every `[stream-diag]` line this project has from the field reads
// `encoder=OpenH264`, and a machine with a working hardware encoder is not the
// machine the offer is for.
//
// READ THE RESULT AS A RATIO, NOT AS A NUMBER. Per-frame milliseconds are a
// property of the machine that ran this, and the machine that ran it first was
// a Ryzen 7 7800X3D — several times faster than the laptops this feature
// exists for. The ratio between the rungs is the transferable part.
//
// AND WHAT HARDWARE ENCODE WOULD BE WORTH. `HARDWARE=1` drops the
// software-forcing flag and runs the same rungs on the GPU encoder, which is
// the comparison that decides how much effort the "why does the app get
// OpenH264" question deserves. Each run PROVES which encoder it used and exits
// non-zero if it got the other one.
//
// Usage (from frontend/):
//   node e2e/encode-cost.mjs
//   HARDWARE=1 MAX_KBPS=20000 node e2e/encode-cost.mjs
//   SECONDS=20 CHANNEL=msedge node e2e/encode-cost.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';

const CHANNEL = process.env.CHANNEL || 'msedge';
const SECONDS = Number(process.env.SECONDS || 10);
const CODEC = process.env.CODEC || 'video/H264';
/** The initial bitrate estimate handed to libwebrtc. Above SHARE_BITRATE so
 *  the encoder starts at the size it was asked for instead of climbing to it.
 *  Without it every rung encodes 360p and the ratios are of nothing. */
const START_KBPS = Number(process.env.START_KBPS || 20000);
/** The send cap. Defaults to the app's own SHARE_BITRATE, which is the
 *  honest setting for 'what does the app produce' — and at that cap a 60 fps
 *  rung above 720p CANNOT hold its resolution: `maintain-framerate` spends
 *  the pixels to keep the frames, so the run reports `limit=bandwidth` and
 *  1280x720 for a 1440p request. That is a real property of the app, not a
 *  rig fault. To measure ENCODE COST per rung instead, raise it past the
 *  point where bitrate is the binding constraint: MAX_KBPS=20000. */
const MAX_KBPS = Number(process.env.MAX_KBPS || 4500);

/** The sizes the share dialog offers, and the frame rates, as shareHealth.ts
 *  has them. 'source' is left out: capping at 4K on a 1440p desktop captures
 *  1440p, so it would measure the same thing twice on most machines. */
const RUNGS = [
    { label: '720p30', w: 1280, h: 720, fps: 30 },
    { label: '720p60', w: 1280, h: 720, fps: 60 },
    { label: '1080p30', w: 1920, h: 1080, fps: 30 },
    { label: '1080p60', w: 1920, h: 1080, fps: 60 },
    { label: '1440p60', w: 2560, h: 1440, fps: 60 },
];

// A REAL ORIGIN AND A REAL CAPTURE, or the encoder cannot be identified.
// `encoderImplementation` and `powerEfficientEncoder` are withheld from
// getStats unless the document holds an active getUserMedia/getDisplayMedia
// capture — Chromium's anti-fingerprinting gate
// (`ExposeHardwareCapabilityStats` -> `UserMediaClient::IsCapturing`). The
// first version of this rig sent a canvas track from about:blank and could
// therefore only ever print `encoder=(absent)`, which is exactly what it did,
// leaving "software-forced" as an unverified claim about its own run.
const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><meta charset=utf-8><title>encode-cost</title><body>rig</body>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: [
        '--autoplay-policy=no-user-gesture-required',
        // Forced software, because that is what the app actually gets. Proven
        // per run below rather than assumed from the flag.
        ...(process.env.HARDWARE ? [] : ['--disable-accelerated-video-encode']),
        // A fake camera, held open purely to satisfy the capture gate above.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
    ],
});
const ctx = await browser.newContext({ permissions: ['camera'] });
const page = await ctx.newPage();
await page.goto(origin);

const measure = async ({ w, h, fps }) => page.evaluate(async ({ w, h, fps, SECONDS, CODEC, START_KBPS, MAX_KBPS }) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // Synthetic content that does not compress away: a game is closer to this
    // than to a static desktop, and a still image would flatter every rung
    // equally and tell us nothing about the ratio.
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const shapes = Array.from({ length: 160 }, (_, i) => ({
        x: (i * 137) % w, y: (i * 71) % h, vx: 3 + (i % 7), vy: 2 + (i % 5), r: 24 + (i % 70),
    }));
    let frame = 0;
    const timer = setInterval(() => {
        frame++;
        ctx.fillStyle = '#0b1220'; ctx.fillRect(0, 0, w, h);
        for (const s of shapes) {
            s.x = (s.x + s.vx) % w; s.y = (s.y + s.vy) % h;
            ctx.fillStyle = `hsl(${(s.x + frame) % 360} 90% 55%)`;
            ctx.fillRect(s.x, s.y, s.r, s.r);
        }
        ctx.fillStyle = '#fff'; ctx.fillRect((frame * 23) % w, 0, 80, h);
    }, 1000 / fps);

    const stream = canvas.captureStream(fps);
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'motion'; // what a game share is

    // Held, not sent: its only job is to make the document "capturing" so the
    // encoder name is exposed. The canvas above is still what gets encoded.
    const gate = await navigator.mediaDevices.getUserMedia({ video: { width: 160, height: 120 } });

    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate);
    const tr = pc1.addTransceiver(track, { direction: 'sendonly', streams: [stream] });

    const caps = RTCRtpSender.getCapabilities('video');
    const wanted = caps.codecs.filter(c => c.mimeType === CODEC);
    if (wanted.length && tr.setCodecPreferences) {
        tr.setCodecPreferences([...wanted, ...caps.codecs.filter(c => c.mimeType !== CODEC)]);
    }
    const params = tr.sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = MAX_KBPS * 1000;
    params.encodings[0].maxFramerate = fps;
    await tr.sender.setParameters(params);

    // START BITRATE, OR THE MEASUREMENT IS OF THE WRONG THING. The first run of
    // this rig reported `limit=bandwidth` at every rung and produced 640x360
    // for a 1440p request: libwebrtc opens at ~300 kbps and, over a ten-second
    // window with no congestion to learn from, never ramps that far. It
    // measured 360p five times and the "ratios" it printed were noise. The
    // Google-specific fmtp attribute is the real knob (`b=AS` is a ceiling,
    // not a start hint - the same trap share-ramp-2pc.mjs documents).
    const munge = (sdp) => {
        const pt = (sdp.match(/^m=video \d+ [^ ]+ (\d+)/m) || [])[1];
        if (!pt) return sdp;
        const fmtp = new RegExp(`^a=fmtp:${pt} (.*)$`, 'm');
        return fmtp.test(sdp)
            ? sdp.replace(fmtp, `a=fmtp:${pt} $1;x-google-start-bitrate=${START_KBPS}`)
            : sdp.replace(new RegExp(`^(a=rtpmap:${pt} .*)$`, 'm'),
                `$1
a=fmtp:${pt} x-google-start-bitrate=${START_KBPS}`);
    };

    const offer = await pc1.createOffer();
    const offSdp = munge(offer.sdp);
    await pc1.setLocalDescription({ type: 'offer', sdp: offSdp });
    await pc2.setRemoteDescription({ type: 'offer', sdp: offSdp });
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription({ type: 'answer', sdp: munge(answer.sdp) });

    // Discard the first two seconds: the encoder is still ramping, and the
    // first keyframe is not representative of anything.
    await sleep(2000);
    const read = async () => {
        let out = null;
        (await pc1.getStats()).forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video') out = r; });
        return out;
    };
    const a = await read();
    await sleep(SECONDS * 1000);
    const b = await read();
    clearInterval(timer); pc1.close(); pc2.close(); gate.getTracks().forEach(t => t.stop());

    const frames = (b?.framesEncoded ?? 0) - (a?.framesEncoded ?? 0);
    const encodeMs = ((b?.totalEncodeTime ?? 0) - (a?.totalEncodeTime ?? 0)) * 1000;
    return {
        // DELTAS over the window, not lifetime totals — a lifetime mean is
        // dominated by the ramp this deliberately skipped.
        frames,
        msPerFrame: frames ? encodeMs / frames : 0,
        fps: frames / SECONDS,
        size: b ? `${b.frameWidth}x${b.frameHeight}` : '(none)',
        limit: b?.qualityLimitationReason ?? '(absent)',
        encoder: b?.encoderImplementation ?? '(absent)',
    };
}, { w, h, fps, SECONDS, CODEC, START_KBPS, MAX_KBPS });

console.log(`channel=${CHANNEL} codec=${CODEC} ${process.env.HARDWARE ? 'HARDWARE (HARDWARE=1)' : 'software-forced'} cap=${MAX_KBPS}kbps start=${START_KBPS}kbps window=${SECONDS}s\n`);
console.log('rung        produced        fps   encode ms/frame   ms/sec of video   limit');
const rows = [];
for (const rung of RUNGS) {
    const r = await measure(rung);
    rows.push({ ...rung, ...r });
    const msPerSec = r.msPerFrame * r.fps;
    console.log(
        `${rung.label.padEnd(11)} ${String(r.size).padEnd(14)} ${r.fps.toFixed(1).padStart(5)}`
        + `   ${r.msPerFrame.toFixed(2).padStart(14)}   ${msPerSec.toFixed(0).padStart(15)}   ${r.limit}`,
    );
}

// The number the offer rests on: what one step down the ladder actually saves.
// A run where the encoder never reached the size it was ASKED for measured
// something else, and printing ratios off it would be worse than printing
// nothing. This is the check the first run of this rig did not have, which
// is why its output looked like a result.
// PROVE the run measured what it claims to have measured. Without this the
// only evidence for "software" was that a flag had been passed, which the
// first version of this rig could not check because it never saw an encoder
// name at all.
const wantSoftware = !process.env.HARDWARE;
const misencoded = rows.filter(r => wantSoftware
    ? !/OpenH264|libvpx|libaom/.test(String(r.encoder))
    : !/MediaFoundation|NVIDIA|Intel|AMD/.test(String(r.encoder)));
if (misencoded.length) {
    console.log(`\nMEASUREMENT INVALID: expected ${wantSoftware ? 'SOFTWARE' : 'HARDWARE'} encoding`);
    for (const r of misencoded) console.log(`  ${r.label}: encoder=${r.encoder}`);
    await browser.close();
    server.close();
    process.exit(1);
}

const wrong = rows.filter(r => r.size !== `${r.w}x${r.h}`);
if (wrong.length) {
    console.log(`\nMEASUREMENT INVALID: ${wrong.length} of ${rows.length} rungs never reached the requested size`);
    for (const r of wrong) console.log(`  ${r.label}: asked ${r.w}x${r.h}, produced ${r.size} (limit=${r.limit})`);
    console.log(MAX_KBPS <= 4500
        ? `At the app's own ${MAX_KBPS} kbps cap this is EXPECTED above 720p60: maintain-framerate`
          + ` drops resolution to hold the frame rate. Re-run with MAX_KBPS=20000 to measure encode cost.`
        : 'Raise START_KBPS or SECONDS. No ratios printed.');
    await browser.close();
    server.close();
    process.exit(1);
}

console.log('\nWhat one step down buys (encode ms per second of video):');
const cost = (label) => {
    const r = rows.find(x => x.label === label);
    return r ? r.msPerFrame * r.fps : NaN;
};
for (const [from, to] of [['1440p60', '1080p60'], ['1080p60', '720p60'], ['1080p60', '1080p30'], ['720p60', '720p30']]) {
    const a = cost(from), b = cost(to);
    if (a && b) console.log(`  ${from} -> ${to}: ${((1 - b / a) * 100).toFixed(0)}% less encode time`);
}
console.log(`\nencoder reported: ${rows[0]?.encoder}`);
console.log('Read the RATIOS, not the milliseconds — these are one machine.');
await browser.close();
server.close();
