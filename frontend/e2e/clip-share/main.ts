// The page half of e2e/clip-share-follow-real-browser.mjs. A canvas stands in
// for the screen (the picker's choice: a headless browser has no screen to
// pick, and its content must be known to check what the clip holds): every
// frame carries its own number in 16 black/white blocks. getDisplayMedia is
// answered with a capture of that canvas, labelled the way Chromium labels a
// screen (deviceId, displaySurface, frameRate), one fresh capture per call,
// each recorded. Everything else is the app's own: replayBuffer.ts arms and
// follows, rtc/media.ts starts the share, the worker seals and previews.
// Silent: there is no audio track anywhere, and every <video> is muted.
import { arm, attachPreview, disarm, followShareCapture, getReplayState, seal } from '../../src/api/clips/replayBuffer';
import { media } from './stubs/webrtc';

type Capture = { purpose: string; track: MediaStreamTrack; width: number; height: number };

const BLOCK = 96; // 4x4 blocks of the frame number, top left
const W = 1920, H = 1080;

function makeScreen(w: number, h: number) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d')!;
    const scale = w / W;
    return { canvas, ctx, scale };
}
const screens = [makeScreen(W, H), makeScreen(1280, 720)];
let frameNo = 0;
function draw() {
    frameNo++;
    for (const { ctx, scale, canvas } of screens) {
        ctx.fillStyle = '#204060'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        // Motion, so the encoder has something to do.
        ctx.fillStyle = '#e0a030';
        ctx.fillRect(((frameNo * 17) % W) * scale, 600 * scale, 120 * scale, 120 * scale);
        // The frame number, 16 bits, and two fixed blocks to read it by.
        const b = BLOCK * scale;
        for (let i = 0; i < 16; i++) {
            ctx.fillStyle = (frameNo >> i) & 1 ? '#ffffff' : '#000000';
            ctx.fillRect((i % 4) * b, Math.floor(i / 4) * b, b, b);
        }
        ctx.fillStyle = '#ffffff'; ctx.fillRect(4 * b, 0, b, b);
        ctx.fillStyle = '#000000'; ctx.fillRect(4 * b, b, b, b);
    }
}
setInterval(draw, 1000 / 30);
draw();

/** Read a frame number back off a picture of the screen (null: unreadable). */
function readFrameNo(src: CanvasImageSource, w: number, h: number): number | null {
    const c = new OffscreenCanvas(w / 4, h / 4);
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.drawImage(src, 0, 0, w / 4, h / 4);
    const b = (BLOCK * (w / W)) / 4;
    const lum = (bx: number, by: number) => {
        const d = x.getImageData(Math.floor(bx * b + b / 2), Math.floor(by * b + b / 2), 1, 1).data;
        return (d[0] + d[1] + d[2]) / 3;
    };
    if (lum(4, 0) < 200 || lum(4, 1) > 55) return null;
    let n = 0;
    for (let i = 0; i < 16; i++) if (lum(i % 4, Math.floor(i / 4)) > 128) n |= 1 << i;
    return n;
}

const captures: Capture[] = [];
let nextCapture: { purpose: string; deviceId: string; screen: number } = { purpose: 'clip', deviceId: 'screen:rig:0', screen: 0 };
navigator.mediaDevices.getDisplayMedia = async () => {
    const want = nextCapture;
    const { canvas } = screens[want.screen];
    const track = canvas.captureStream(30).getVideoTracks()[0];
    const real = track.getSettings.bind(track);
    // What Chromium reports for a screen: the same deviceId for every
    // capture of one surface (measured with its fake capture device).
    track.getSettings = () => ({ ...real(), deviceId: want.deviceId, displaySurface: 'monitor', frameRate: 30, width: canvas.width, height: canvas.height });
    captures.push({ purpose: want.purpose, track, width: canvas.width, height: canvas.height });
    return new MediaStream([track]);
};

declare global { interface Window { harness: unknown } }
window.harness = {
    frameNo: () => frameNo,
    next(purpose: string, deviceId = 'screen:rig:0', screen = 0) { nextCapture = { purpose, deviceId, screen }; },
    captures: () => captures.map((c) => ({ purpose: c.purpose, state: c.track.readyState, width: c.width, height: c.height })),
    arm: (maxSeconds = 60) => arm({ maxSeconds }),
    disarm: () => disarm('test'),
    state: () => { const s = getReplayState(); return { phase: s.phase, sharedCapture: s.sharedCapture, bufferedMs: s.bufferedMs, fps: s.fps, width: s.width, height: s.height, videoCodec: s.videoCodec, notice: s.notice, error: s.error }; },
    share: async (w = 1920, h = 1080) => { const s = await media.getScreenShareStream({ width: w, height: h, fps: 30, audio: false }); return s.getVideoTracks()[0]?.readyState; },
    stopShare: () => media.stopScreenShare(),
    /** Debug: the follow's own answer for the live share. */
    follow: async () => { const t = media.getScreenShareStreamSync()?.getVideoTracks()[0]; return t ? followShareCapture(t) : 'no share'; },
    seal: async (ms: number) => {
        try { return { ok: true, info: await seal(ms, 60_000) }; } catch (e) { return { ok: false, message: String((e as Error).message ?? e) }; }
    },
    /** The post-approval preview (the app reaches it only after every
     *  participant approved: docs/CLIPS.md; here it is driven directly, as
     *  e2e/clip-worker-headless.mjs drives the worker's). Plays the clip at
     *  2x and reads every presented frame's number. */
    watch: async () => {
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true;
        document.body.appendChild(v);
        const { ready, detach } = attachPreview(v);
        const durationMs = await ready;
        const seen: number[] = [];
        let unreadable = 0;
        await new Promise<void>((resolve) => {
            const onFrame = () => {
                const n = readFrameNo(v, v.videoWidth, v.videoHeight);
                if (n === null) unreadable++; else seen.push(n);
                if (!v.ended) v.requestVideoFrameCallback(onFrame);
            };
            v.requestVideoFrameCallback(onFrame);
            v.onended = () => resolve();
            setTimeout(resolve, 60_000);
            v.playbackRate = 2;
            void v.play();
        });
        const out = { durationMs, width: v.videoWidth, height: v.videoHeight, seen, unreadable, muted: v.muted };
        detach();
        v.remove();
        return out;
    },
};
