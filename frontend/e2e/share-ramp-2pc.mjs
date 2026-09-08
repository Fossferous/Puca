// Screen-share QUALITY RAMP rig: why a share starts blurry and climbs.
//
// THE REPORT THIS EXISTS FOR (2026-09-08): "whenever I load someone's stream,
// the resolution/bitrate and framerate start very poorly and then ramp up. I
// have gigabit so this probably shouldn't happen."
//
// WHAT IT MEASURES. One headless Chromium, two RTCPeerConnections wired to
// each other, publishing a deliberately incompressible 1080p canvas with the
// EXACT encoding parameters the app applies to a screen share
// (`tuneScreenShareSender` in rtc/manager.ts, and the same shape in
// sfuManager's publishTrack): maxBitrate, maxFramerate 60, and
// degradationPreference 'maintain-framerate'. Then it samples both ends every
// 500 ms from the first frame and reports the series.
//
// WHY A LOCAL LOOPBACK IS STILL WORTH RUNNING, and what it cannot tell you.
// It cannot reproduce a WAN: there is no loss, no queue and a sub-millisecond
// RTT, and Chromium's congestion controller will therefore climb faster here
// than it ever does in the field. Nothing in Playwright or CDP can shape UDP
// (`Network.emulateNetworkConditions` does not touch media). So treat every
// duration below as a FLOOR — the best case the code can produce — and read
// the SHAPE rather than the seconds:
//
//   * if even here the picture starts at a fraction of 1080p and climbs, the
//     ramp is intrinsic to starting cold rather than caused by the network;
//   * whether 'maintain-framerate' spends the cold-start budget on frame rate
//     and pays for it in resolution is directly visible, and is the difference
//     between "blurry for a moment" and "choppy for a moment";
//   * an `x-google-start-bitrate` munge is a real lever with a real cost, and
//     the A/B says how much of the ramp it actually removes.
//
// THE CANVAS HAS TO BE INCOMPRESSIBLE. A gradient or a few moving boxes
// encodes to almost nothing, the estimator is never pushed, and the rig
// measures its own test pattern instead of the pipeline. This one repaints
// per-pixel noise over the whole frame every frame, which no encoder can
// cheat, so the sender genuinely wants more than its ceiling and the ramp is
// the only thing limiting it.
//
// Usage (from frontend/):
//   node e2e/share-ramp-2pc.mjs
//   DURATION_MS=60000 VARIANTS=baseline,startbitrate,maintain-resolution \
//     OUT=C:/tmp/ramp.json node e2e/share-ramp-2pc.mjs
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const DURATION_MS = Number(process.env.DURATION_MS || 45000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 500);
const MAX_BITRATE = Number(process.env.MAX_BITRATE || 8_000_000); // rtc/manager.ts's mesh default
const START_BITRATE_KBPS = Number(process.env.START_BITRATE_KBPS || 4000);
const VARIANTS = (process.env.VARIANTS || 'baseline,startbitrate,maintain-resolution').split(',');
const OUT = process.env.OUT || '';
const CONTENT = process.env.CONTENT || 'shapes'; // 'shapes' (game-like) | 'noise' (worst case)

/** Runs entirely in the page: build the pair, publish, sample, return. */
async function runVariant(page, variant, opts) {
    return page.evaluate(async ({ variant, DURATION_MS, SAMPLE_MS, MAX_BITRATE, START_BITRATE_KBPS, CONTENT }) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        // --- the source ---
        //
        // CONTENT=shapes (default) is a stand-in for a GAME: constant full-frame
        // motion, strong edges, a gradient background. Compressible enough that
        // 1080p60 is reachable inside the ceiling, which is the whole point --
        // the first version of this rig painted per-pixel noise, and noise at
        // 1080p60 needs hundreds of Mbps, so the encoder correctly parked at
        // 480x270 for the entire run and resolution never became observable.
        // The rig was measuring its own test pattern.
        //
        // CONTENT=noise keeps that worst case available on purpose: it is what
        // an encoder does when the content genuinely cannot fit.
        const W = 1920, H = 1080;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        const noiseTile = document.createElement('canvas');
        noiseTile.width = 480; noiseTile.height = 270;
        {
            const tctx = noiseTile.getContext('2d');
            const img = tctx.createImageData(480, 270);
            for (let i = 0; i < img.data.length; i += 4) {
                const v = (Math.random() * 256) | 0;
                img.data[i] = v; img.data[i + 1] = (v * 7) & 255; img.data[i + 2] = (v * 13) & 255; img.data[i + 3] = 255;
            }
            tctx.putImageData(img, 0, 0);
        }
        const shapes = Array.from({ length: 140 }, (_, i) => ({
            x: (i * 137) % W, y: (i * 71) % H,
            vx: 2 + (i % 7), vy: 1 + (i % 5),
            r: 20 + (i % 60), hue: (i * 17) % 360,
        }));
        let frame = 0;
        const paint = () => {
            frame++;
            if (CONTENT === 'noise') {
                for (let y = -270; y < H; y += 270) {
                    for (let x = -480; x < W; x += 480) {
                        ctx.drawImage(noiseTile, (x + frame * 7) % (W + 480), (y + frame * 3) % (H + 270));
                    }
                }
                return;
            }
            const g = ctx.createLinearGradient(0, (frame * 2) % H, W, H);
            g.addColorStop(0, '#123'); g.addColorStop(0.5, '#2a4d69'); g.addColorStop(1, '#0b1220');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
            for (const sp of shapes) {
                sp.x = (sp.x + sp.vx) % W; sp.y = (sp.y + sp.vy) % H;
                ctx.fillStyle = `hsl(${(sp.hue + frame) % 360} 90% 55%)`;
                ctx.fillRect(sp.x, sp.y, sp.r, sp.r);
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.strokeRect(sp.x, sp.y, sp.r, sp.r);
            }
            // A hard vertical wipe: full-frame change every frame, which is
            // what stops the encoder coasting on a static background.
            ctx.fillStyle = '#fff';
            ctx.fillRect((frame * 19) % W, 0, 60, H);
        };
        const timer = setInterval(paint, 1000 / 60);
        paint();

        const stream = canvas.captureStream(60);
        const track = stream.getVideoTracks()[0];

        // --- the pair ---
        const pc1 = new RTCPeerConnection();
        const pc2 = new RTCPeerConnection();
        pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate);
        pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate);
        const inbound = new Promise(res => { pc2.ontrack = e => res(e.track); });
        const sender = pc1.addTrack(track, stream);

        const offer = await pc1.createOffer();
        let sdp = offer.sdp;
        if (variant === 'startbitrate') {
            // THE LEVER, DONE PROPERLY. `b=AS` is a CEILING, not a start hint --
            // the first version of this rig used it and merely capped the
            // session at 4 Mbps, which looked like a regression and was a rig
            // bug. The real knob is the Google-specific fmtp attribute, which
            // libwebrtc reads off the answer's video codec line and uses as its
            // initial estimate instead of the ~300 kbps default.
            const pt = (sdp.match(/^m=video \d+ [^ ]+ (\d+)/m) || [])[1];
            if (pt) {
                const fmtp = new RegExp(`^a=fmtp:${pt} (.*)$`, 'm');
                sdp = fmtp.test(sdp)
                    ? sdp.replace(fmtp, `a=fmtp:${pt} $1;x-google-start-bitrate=${START_BITRATE_KBPS}`)
                    : sdp.replace(
                        new RegExp(`^(a=rtpmap:${pt} .*)$`, 'm'),
                        `$1
a=fmtp:${pt} x-google-start-bitrate=${START_BITRATE_KBPS}`,
                    );
            }
        }
        await pc1.setLocalDescription({ type: 'offer', sdp });
        await pc2.setRemoteDescription({ type: 'offer', sdp });
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        let ansSdp = answer.sdp;
        if (variant === 'startbitrate') {
            const pt = (ansSdp.match(/^m=video \d+ [^ ]+ (\d+)/m) || [])[1];
            if (pt) {
                const fmtp = new RegExp(`^a=fmtp:${pt} (.*)$`, 'm');
                ansSdp = fmtp.test(ansSdp)
                    ? ansSdp.replace(fmtp, `a=fmtp:${pt} $1;x-google-start-bitrate=${START_BITRATE_KBPS}`)
                    : ansSdp.replace(
                        new RegExp(`^(a=rtpmap:${pt} .*)$`, 'm'),
                        `$1
a=fmtp:${pt} x-google-start-bitrate=${START_BITRATE_KBPS}`,
                    );
            }
        }
        await pc1.setRemoteDescription({ type: 'answer', sdp: ansSdp });

        // --- the app's own tuning, verbatim ---
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = MAX_BITRATE;
        params.encodings[0].maxFramerate = 60;
        params.degradationPreference =
            variant === 'maintain-resolution' ? 'maintain-resolution' : 'maintain-framerate';
        await sender.setParameters(params);

        await inbound;

        // --- sample both ends until the clock runs out ---
        const t0 = performance.now();
        const series = [];
        let prevSent = 0, prevRecv = 0, prevT = t0;
        while (performance.now() - t0 < DURATION_MS) {
            await sleep(SAMPLE_MS);
            const now = performance.now();
            const dt = (now - prevT) / 1000;
            let out = null, inb = null, pair = null;
            (await pc1.getStats()).forEach(r => {
                if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
                if (r.type === 'candidate-pair' && r.nominated) pair = r;
            });
            (await pc2.getStats()).forEach(r => {
                if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
            });
            if (!out) continue;
            const sentKbps = Math.round(((out.bytesSent - prevSent) * 8) / 1000 / dt);
            const recvKbps = inb ? Math.round(((inb.bytesReceived - prevRecv) * 8) / 1000 / dt) : 0;
            prevSent = out.bytesSent; prevRecv = inb ? inb.bytesReceived : 0; prevT = now;
            series.push({
                t: Math.round(now - t0),
                w: out.frameWidth ?? 0,
                h: out.frameHeight ?? 0,
                fps: Math.round(out.framesPerSecond ?? 0),
                sentKbps,
                recvKbps,
                target: Math.round((out.targetBitrate ?? 0) / 1000),
                limit: out.qualityLimitationReason ?? '?',
                encoder: out.encoderImplementation ?? '?',
                rttMs: pair ? Math.round((pair.currentRoundTripTime ?? 0) * 1000) : null,
            });
        }
        clearInterval(timer);
        pc1.close(); pc2.close();
        return series;
    }, { variant, DURATION_MS, SAMPLE_MS, MAX_BITRATE, START_BITRATE_KBPS, CONTENT, ...opts });
}

/** When did it first reach, and hold, a given fraction of full height? */
function timeToHeight(series, h) {
    const hit = series.find(s => s.h >= h);
    return hit ? hit.t : null;
}

// The app renders in WebView2, so Edge is the closest engine on this machine
// and the default here. Playwright's own chromium build is used only if a
// CHANNEL is not available -- and note that its bundled version may not match
// the installed @playwright/test, which is why this does not default to it.
const CHANNEL = process.env.CHANNEL || 'msedge';
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: [
        '--autoplay-policy=no-user-gesture-required',
        // Loopback ICE only; no host enumeration games.
        '--force-webrtc-ip-handling-policy=default',
    ],
});
const page = await browser.newPage();
await page.goto('about:blank');

const results = {};
for (const variant of VARIANTS) {
    process.stdout.write(`\n=== ${variant} ===\n`);
    const series = await runVariant(page, variant, {});
    results[variant] = series;
    const first = series[0];
    console.log(`  encoder: ${series.at(-1)?.encoder}  rtt: ${first?.rttMs} ms  content: ${CONTENT}`);
    console.log('    t(ms)   size        fps   sent kbps   target   limit');
    for (const s of series) {
        if (s.t % 2000 < SAMPLE_MS || s.t < 3000) {
            console.log(
                `  ${String(s.t).padStart(6)}   ${String(s.w + 'x' + s.h).padEnd(11)} ${String(s.fps).padStart(3)}` +
                `   ${String(s.sentKbps).padStart(9)}   ${String(s.target).padStart(6)}   ${s.limit}`,
            );
        }
    }
    console.log(`  -> 720p at ${timeToHeight(series, 720) ?? 'never'} ms, 1080p at ${timeToHeight(series, 1080) ?? 'never'} ms`);
    const peak = series.reduce((a, s) => Math.max(a, s.sentKbps), 0);
    console.log(`  -> peak ${peak} kbps, final ${series.at(-1)?.w}x${series.at(-1)?.h} @ ${series.at(-1)?.fps}`);
}

if (OUT) { writeFileSync(OUT, JSON.stringify(results, null, 2)); console.log(`\nwrote ${OUT}`); }
await browser.close();
