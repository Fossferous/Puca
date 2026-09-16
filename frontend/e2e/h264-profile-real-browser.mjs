// Does a REAL browser hand the screen share to a hardware H.264 encoder when
// the offer is ordered the way h264Profiles.ts orders it — and to OpenH264
// when it is not?
//
// WHY THIS EXISTS. Every `[stream-diag]` line this project had from the field
// (about 11,900 samples, 2026-09-02 to 2026-09-10) read `encoder=OpenH264` on
// a machine whose native clip capture uses the NVIDIA H.264 Encoder MFT. Not
// WebView2, not the GPU adapter, not E2EE: the LiveKit server registers only
// Constrained Baseline (42e01f) and High (640032) for H.264, keeps the offer's
// relative order, and Chromium's default order puts 42e01f first — the one
// profile its MediaFoundation factory never claims. Measured 2026-09-16 inside
// the shipped WebView2 153 runtime on an RTX 4080 SUPER:
//
//     browser order      -> negotiated 42e01f -> OpenH264
//     preferHardwareH264 -> negotiated 640032 -> MediaFoundationVideoEncodeAccelerator
//                                                (NVIDIA H.264 Encoder MFT)
//
// Nothing in vitest can see any of this: jsdom has no RTCPeerConnection, and
// the ordering function is pure — a test of it proves the LIST is right, not
// that a browser does anything different with it. So this hands a real
// Chromium a loopback pair whose answering side selects codecs exactly the
// way the LiveKit server does, once in the browser's order and once in ours,
// and reads the encoder each one actually used.
//
//   cd frontend && node e2e/h264-profile-real-browser.mjs
//
// No server and no build needed. The negotiation assertions hold on any
// machine; the hardware ones (which encoder ran) need a machine whose sender
// capabilities carry a High entry, i.e. one with a hardware H.264 encoder,
// and are reported as SKIP elsewhere rather than passing vacuously.
import { chromium } from '@playwright/test';
import http from 'node:http';

let pass = 0, fail = 0, skip = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};
const sk = (label, why) => { skip++; console.log('SKIP', label, why); };

/**
 * preferHardwareH264 from src/api/rtc/h264Profiles.ts, ported faithfully.
 * Kept in step by the shared-fixture assertion at the bottom, which pins the
 * same head src/tests/h264Profiles.test.ts pins.
 */
const profileOf = (c) => /profile-level-id=([0-9a-f]{6})/i.exec(c.sdpFmtpLine ?? '')?.[1]?.toLowerCase() ?? null;
// Self-contained on purpose: its source is shipped into the page verbatim.
function preferHardwareH264(codecs) {
    const profileOf = (c) => /profile-level-id=([0-9a-f]{6})/i.exec(c.sdpFmtpLine ?? '')?.[1]?.toLowerCase() ?? null;
    const pmOf = (c) => /packetization-mode=(\d)/.exec(c.sdpFmtpLine ?? '')?.[1] ?? '0';
    const rank = (c) => {
        if (c.mimeType.toLowerCase() !== 'video/h264' || pmOf(c) !== '1') return null;
        const p = profileOf(c);
        if (!p || p.slice(2, 4) !== '00') return null;
        return { '64': 0, '4d': 1, '42': 2 }[p.slice(0, 2)] ?? null;
    };
    const ranked = [], rest = [];
    codecs.forEach((c, i) => { const r = rank(c); if (r === null) rest.push(c); else ranked.push({ c, r, i }); });
    ranked.sort((a, b) => a.r - b.r || a.i - b.i);
    return [...ranked.map((x) => x.c), ...rest];
}

// A real origin and a real capture: `encoderImplementation` is withheld from
// getStats unless the document holds an active capture, and about:blank is
// not a secure context (see encoder-probe.mjs). The fake camera is the SOURCE
// too — it keeps producing frames whether or not anything is rendered.
const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><meta charset=utf-8><title>h264-profile</title><body>rig</body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/`;

const CHANNEL = process.env.CHANNEL || 'msedge';
const SECONDS = Number(process.env.SECONDS || 5);
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const page = await (await browser.newContext({ permissions: ['camera'] })).newPage();
await page.goto(origin);

const result = await page.evaluate(async ({ SECONDS, preferSrc }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // The ported function, evaluated in the page from its own source.
    const preferHardwareH264 = new Function(`return (${preferSrc});`)();
    const profileOf = (c) => /profile-level-id=([0-9a-f]{6})/i.exec(c.sdpFmtpLine ?? '')?.[1]?.toLowerCase() ?? null;
    const pmOf = (c) => /packetization-mode=(\d)/.exec(c.sdpFmtpLine ?? '')?.[1] ?? '0';
    const isH264 = (c) => c.mimeType.toLowerCase() === 'video/h264';

    const src = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } });
    const track = src.getVideoTracks()[0];
    track.contentHint = 'motion';
    const send = RTCRtpSender.getCapabilities('video').codecs;
    const recv = RTCRtpReceiver.getCapabilities('video').codecs;

    // The LiveKit v1.13.4 server, on the answering side: it registers 42e01f
    // (both modes) and 640032/1 for H.264, and prefers the requested MIME
    // type in the OFFER's relative order (configureReceiverCodecs). The
    // answerer here is a Chromium RECEIVER, whose capability list spells High
    // as 64001f (level 3.1) — pion matches H.264 on profile, not level, when
    // level-asymmetry-allowed is set, so 64001f is how the server's 640032
    // entry has to be expressed on this side. It is not a fourth variant.
    const serverKnows = (c) => !isH264(c) || ['42e01f/0', '42e01f/1', '640032/1', '64001f/1'].includes(`${profileOf(c)}/${pmOf(c)}`);

    async function negotiate(senderOrder) {
        const pc1 = new RTCPeerConnection();
        const pc2 = new RTCPeerConnection();
        pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
        pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
        const tr = pc1.addTransceiver(track, { direction: 'sendonly', streams: [src] });
        if (senderOrder) tr.setCodecPreferences(senderOrder);
        const p = tr.sender.getParameters();
        if (!p.encodings?.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 4_500_000;
        await tr.sender.setParameters(p);
        const offer = await pc1.createOffer();
        await pc1.setLocalDescription(offer);
        await pc2.setRemoteDescription(offer);
        const offerLines = [...offer.sdp.matchAll(/a=fmtp:\d+ (.*profile-level-id.*)/g)].map((m) => m[1].trim());
        const orderOf = (c) => {
            const i = offerLines.findIndex((l) => l.includes(`profile-level-id=${profileOf(c)}`) && l.includes(`packetization-mode=${pmOf(c)}`));
            return i < 0 ? 999 : i;
        };
        const answerPref = recv.filter(serverKnows).filter((c) => !isH264(c) || orderOf(c) !== 999)
            .sort((a, b) => (isH264(a) ? 0 : 1) - (isH264(b) ? 0 : 1) || orderOf(a) - orderOf(b));
        pc2.getTransceivers()[0].setCodecPreferences(answerPref);
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        await pc1.setRemoteDescription(answer);
        await sleep(SECONDS * 1000);
        let out = null, codec = null;
        const st = await pc1.getStats();
        st.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') out = r; });
        if (out?.codecId) codec = st.get(out.codecId);
        pc1.close(); pc2.close();
        return {
            profile: codec ? profileOf(codec) : null,
            encoder: out?.encoderImplementation ?? '(absent)',
            powerEfficient: out?.powerEfficientEncoder ?? '(absent)',
            frames: out?.framesEncoded ?? 0,
        };
    }
    const preferred = preferHardwareH264(send);
    const a = await negotiate(null);
    const b = await negotiate(preferred);
    track.stop();
    // Named so a SKIP on a machine that HAS an encoder is readable: a
    // headless GPU process that failed to start reports SwiftShader here and
    // advertises no High entry, which is a rig problem, not a finding.
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
        gpu: dbg && gl ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(no webgl)',
        ua: navigator.userAgent,
        senderH264: send.filter(isH264).map((c) => `${profileOf(c)}/${pmOf(c)}`),
        // profile_iop 00 as well as idc 64: Constrained High (640c) is not
        // what the factory adds, and the TypeScript's hasHardwareH264 says no
        // to it — the two must agree or this gate takes the hardware branch
        // on a machine the shipped code treats as software-only.
        hasHigh: send.some((c) => isH264(c) && profileOf(c)?.startsWith('6400') && pmOf(c) === '1'),
        a, b,
    };
}, { SECONDS, preferSrc: preferHardwareH264.toString() });

console.log(`channel=${CHANNEL} ua=${result.ua}`);
console.log(`gpu: ${result.gpu}`);
console.log(`sender H.264: ${result.senderH264.join(' ')}  (High present: ${result.hasHigh})`);
console.log(`A browser order      -> profile=${result.a.profile} encoder=${result.a.encoder} frames=${result.a.frames}`);
console.log(`B preferHardwareH264 -> profile=${result.b.profile} encoder=${result.b.encoder} frames=${result.b.frames}`);

// Negotiation: true on every machine, with or without a hardware encoder.
ck(result.a.frames > 0 && result.b.frames > 0, 'both sessions actually encoded frames (the stats are real, not absent)');
ck(result.a.profile === '42e01f', 'THE INCIDENT: the browser order negotiates Constrained Baseline against a LiveKit-shaped answer', `got ${result.a.profile}`);
if (result.hasHigh) {
    ck(result.b.profile?.startsWith('64'), 'THE FIX: our order negotiates High on a machine that can send it', `got ${result.b.profile}`);
    // Hardware: only provable where a hardware encoder exists. Positive AND
    // negative control in one run — the same machine, the same track, one
    // profile apart.
    ck(/OpenH264/.test(result.a.encoder), 'negative control: Constrained Baseline is encoded by OpenH264', result.a.encoder);
    ck(!/OpenH264|libvpx|libaom/.test(result.b.encoder), 'POSITIVE CONTROL: High is encoded by a hardware encoder', result.b.encoder);
    ck(result.b.powerEfficient === true, 'the browser itself reports the High session as power-efficient (hardware)', String(result.b.powerEfficient));
} else {
    ck(result.b.profile === '42e01f', 'a software-only machine still negotiates Constrained Baseline (nothing lost)', `got ${result.b.profile}`);
    sk('hardware encoder assertions', 'no High entry in sender capabilities: this machine has no hardware H.264 encoder');
}

// Shared fixture with src/tests/h264Profiles.test.ts: the port above must
// order the pinned list the same way the TypeScript does.
const H = (pm, p) => ({ mimeType: 'video/H264', sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=${pm};profile-level-id=${p}` });
const FIXTURE = [H(1, '42001f'), H(0, '42001f'), H(1, '42e01f'), H(0, '42e01f'), H(1, '4d001f'), H(0, '4d001f'), H(1, '640032'),
    { mimeType: 'video/VP8' }, { mimeType: 'video/rtx' }, { mimeType: 'video/red' }, { mimeType: 'video/ulpfec' }];
const head = preferHardwareH264(FIXTURE).slice(0, 3).map(profileOf);
ck(head.join(' ') === '640032 4d001f 42001f', 'the port orders the shared fixture as the TypeScript test pins', head.join(' '));
ck(preferHardwareH264(FIXTURE).length === FIXTURE.length, 'the port drops nothing');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
