/**
 * Sharing the PHONE's screen into a call, from the Android app.
 *
 * The Android System WebView has no getDisplayMedia, so the picture comes
 * from the app's native half (SovereignScreenSharePlugin.java,
 * ScreenShareService.java): Android's MediaProjection, with its own consent
 * dialog, draws the screen into a virtual display, and each frame reaches
 * this page as a JPEG over a private WebMessagePort. Here the JPEGs become a
 * video track again, and from then on it is a share like any other: the same
 * senders, the same Encoded Transforms, the same keys, mesh and SFU alike. A
 * native WebRTC sender would have had to rebuild both encryption formats
 * outside the page, which is why the picture comes to the page instead.
 *
 * The track is made with MediaStreamTrackGenerator where the WebView has it,
 * else from a canvas's captureStream. Its stop() ends the native capture;
 * the capture ending natively (the notification's Stop, Android's own) ends
 * the track with an `ended` event, which the voice panel handles as it does a
 * browser's own "Stop sharing".
 *
 * Video only: the phone's sound is not shared (Android's playback capture
 * would need its own path into the page). Older APKs carry no plugin, and
 * then nothing here is offered (nativeScreenShareAvailable).
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface SovereignScreenSharePlugin {
    status(): Promise<{ available: boolean; reason: string | null; sdk: number; sharing: boolean }>;
    start(options: { width: number; height: number; fps: number; nonce: string }): Promise<NativeCapture & { binary: boolean }>;
    resize(options: { width: number; height: number; fps: number }): Promise<NativeCapture>;
    stop(): Promise<{ stopped: boolean }>;
    addListener(event: 'shareEnded', cb: (e: { reason: string }) => void): Promise<PluginListenerHandle>;
}

/** What the phone captures: the screen fitted into the asked box, upright
 *  when the phone is (ScreenShareFrames.fit), at most 30 fps. */
export interface NativeCapture { width: number; height: number; fps: number }

export const SovereignScreenShare = registerPlugin<SovereignScreenSharePlugin>('SovereignScreenShare');

const PLUGIN = 'SovereignScreenShare';

/** How long the port may take to arrive once the capture runs. It is posted
 *  before start() resolves, so this only ever waits on a broken WebView. */
const PORT_TIMEOUT_MS = 5000;
/** A still screen sends no frames. The last one is sent again this often, so
 *  a viewer who joins (or a keyframe request) is never left without one. */
export const REPEAT_MS = 1000;

// The two ways a page can turn frames into a track. Neither is in the DOM
// typings TypeScript ships.
interface TrackGenerator extends MediaStreamTrack {
    writable: WritableStream<VideoFrame>;
}
type TrackGeneratorCtor = new (init: { kind: 'video' }) => TrackGenerator;
type CanvasCapture = HTMLCanvasElement & { captureStream(fps?: number): MediaStream };

function generatorCtor(): TrackGeneratorCtor | null {
    const g = (globalThis as { MediaStreamTrackGenerator?: TrackGeneratorCtor }).MediaStreamTrackGenerator;
    return typeof g === 'function' && typeof VideoFrame === 'function' ? g : null;
}

function canvasCaptures(): boolean {
    return typeof HTMLCanvasElement !== 'undefined'
        && typeof (HTMLCanvasElement.prototype as Partial<CanvasCapture>).captureStream === 'function';
}

/**
 * Whether Share is offered here: the Android app, an APK that carries the
 * plugin (OTA JavaScript can be newer than the installed app), and a page
 * that can make a track from frames. Synchronous, because the voice panel
 * renders from it; what the WebView itself supports is checked by start(),
 * which refuses with the missing feature named.
 */
export function nativeScreenShareAvailable(): boolean {
    if (Capacitor.getPlatform() !== 'android') return false;
    if (!Capacitor.isPluginAvailable(PLUGIN)) return false;
    return generatorCtor() !== null || canvasCaptures();
}

/** The box the share asks for, from the dialog's constraints (shareHealth.ts
 *  shareVideoConstraints: `{ width: { max }, height: { max }, frameRate: { max } }`). */
export function askedCapture(options: DisplayMediaStreamOptions): { width: number; height: number; fps: number } {
    const v = typeof options.video === 'object' ? options.video : {};
    const num = (c: unknown, fallback: number): number => {
        if (typeof c === 'number' && c > 0) return Math.round(c);
        if (c && typeof c === 'object') {
            const o = c as { max?: unknown; ideal?: unknown; exact?: unknown };
            for (const k of [o.exact, o.max, o.ideal]) if (typeof k === 'number' && k > 0) return Math.round(k);
        }
        return fallback;
    };
    return { width: num(v.width, 1280), height: num(v.height, 720), fps: num(v.frameRate, 30) };
}

/** The plugin's refusal as the DOMException a browser's picker would have
 *  thrown, so the share dialog treats it the same way. */
export function refusalAsDomException(err: unknown): DOMException {
    const e = err as { code?: unknown; message?: unknown } | null;
    const code = typeof e?.code === 'string' ? e.code : '';
    const message = typeof e?.message === 'string' && e.message ? e.message : 'The screen share did not start';
    switch (code) {
        case 'denied': return new DOMException(message, 'NotAllowedError');
        case 'unsupported': return new DOMException(message, 'NotSupportedError');
        case 'busy': return new DOMException(message, 'InvalidStateError');
        case 'ended': return new DOMException(message, 'AbortError');
        default: return new DOMException(message, 'NotReadableError');
    }
}

/** What arrives on the port, sorted. A frame is JPEG bytes (an ArrayBuffer,
 *  or base64 text where the WebView cannot post binary); anything that reads
 *  as a JSON object is a control message. */
export type PortMessage =
    | { kind: 'frame'; bytes: Uint8Array }
    | { kind: 'ended'; reason: string }
    | { kind: 'other' };

export function readPortMessage(data: unknown): PortMessage {
    if (data instanceof ArrayBuffer) return { kind: 'frame', bytes: new Uint8Array(data) };
    if (ArrayBuffer.isView(data)) return { kind: 'frame', bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    if (typeof data !== 'string' || data.length === 0) return { kind: 'other' };
    if (data.charCodeAt(0) === 0x7b /* { */) {
        try {
            const m = JSON.parse(data) as { type?: unknown; reason?: unknown };
            if (m.type === 'ended') return { kind: 'ended', reason: typeof m.reason === 'string' ? m.reason : 'The share ended' };
        } catch { /* not a control message */ }
        return { kind: 'other' };
    }
    try {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { kind: 'frame', bytes };
    } catch {
        return { kind: 'other' };
    }
}

/**
 * Frames in, pictures out: one decode at a time, newest first. A frame that
 * arrives while one is decoding waits; a newer one replaces it (acknowledged
 * at once, so the phone is not held back by a frame nobody will see). Every
 * frame is acknowledged once it is shown or dropped: the phone encodes the
 * next one only then (ScreenShareFrames.Gate). A still screen's last picture
 * is shown again every REPEAT_MS.
 *
 * Pure of the DOM: decoding, showing and acknowledging are handed in, so the
 * tests drive it without a WebView.
 */
export class FramePump<P extends { close(): void }> {
    private decoding = false;
    private waiting: Uint8Array | null = null;
    private last: P | null = null;
    private lastShownAt = 0;
    private stopped = false;
    readonly shown = { frames: 0, repeats: 0, dropped: 0, failed: 0 };

    private readonly decode: (bytes: Uint8Array) => Promise<P>;
    private readonly show: (picture: P) => void;
    private readonly ack: () => void;
    private readonly now: () => number;

    constructor(
        decode: (bytes: Uint8Array) => Promise<P>,
        show: (picture: P) => void,
        ack: () => void,
        now: () => number = () => Date.now(),
    ) {
        this.decode = decode;
        this.show = show;
        this.ack = ack;
        this.now = now;
    }

    push(bytes: Uint8Array): void {
        if (this.stopped) return;
        if (this.decoding) {
            if (this.waiting) {
                this.shown.dropped++;
                this.ack();
            }
            this.waiting = bytes;
            return;
        }
        void this.run(bytes);
    }

    private async run(bytes: Uint8Array): Promise<void> {
        this.decoding = true;
        let next: Uint8Array | null = bytes;
        while (next && !this.stopped) {
            const current: Uint8Array = next;
            this.waiting = null;
            try {
                const picture = await this.decode(current);
                if (this.stopped) {
                    picture.close();
                } else {
                    this.show(picture);
                    this.last?.close();
                    this.last = picture;
                    this.lastShownAt = this.now();
                    this.shown.frames++;
                }
            } catch {
                this.shown.failed++;
            }
            this.ack();
            next = this.waiting;
        }
        this.decoding = false;
    }

    /** Called on a timer: show the last picture again if the screen is still. */
    tick(): void {
        if (this.stopped || this.decoding || !this.last) return;
        if (this.now() - this.lastShownAt < REPEAT_MS) return;
        this.show(this.last);
        this.lastShownAt = this.now();
        this.shown.repeats++;
    }

    stop(): void {
        this.stopped = true;
        this.waiting = null;
        this.last?.close();
        this.last = null;
    }
}

/** A track and the way to put a picture on it. */
interface FrameSink {
    track: MediaStreamTrack;
    show(bitmap: ImageBitmap): void;
    close(): void;
}

function generatorSink(Gen: TrackGeneratorCtor): FrameSink {
    const track = new Gen({ kind: 'video' });
    const writer = track.writable.getWriter();
    const started = performance.now();
    let closed = false;
    return {
        track,
        show(bitmap) {
            if (closed) return;
            // A frame per write; the bitmap stays ours (it may be shown again).
            const frame = new VideoFrame(bitmap, { timestamp: Math.round((performance.now() - started) * 1000) });
            writer.write(frame).catch(() => { /* the track ended */ }).finally(() => frame.close());
        },
        close() {
            if (closed) return;
            closed = true;
            writer.close().catch(() => { /* already ended */ });
        },
    };
}

function canvasSink(): FrameSink {
    const canvas = document.createElement('canvas') as CanvasCapture;
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext('2d');
    // 0: a frame only when one is drawn (requestFrame), never a timer's.
    const track = canvas.captureStream(0).getVideoTracks()[0];
    return {
        track,
        show(bitmap) {
            if (!ctx) return;
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
            }
            ctx.drawImage(bitmap, 0, 0);
            (track as MediaStreamTrack & { requestFrame?: () => void }).requestFrame?.();
        },
        close() { /* the track's own stop() ends it */ },
    };
}

/** Waits for the port the plugin posts, tagged with our nonce. Listening
 *  starts at once (the port is posted before start() resolves); the timeout
 *  starts with arm(), once the plugin says the capture runs. */
interface PortWaiter {
    port: Promise<MessagePort>;
    arm(): void;
    cancel(): void;
}

function waitForPort(nonce: string): PortWaiter {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: (port: MessagePort | null, err?: DOMException) => void = () => {};
    const onMessage = (e: MessageEvent) => {
        if (typeof e.data !== 'string' || !e.ports?.[0]) return;
        let m: { type?: unknown; nonce?: unknown };
        try { m = JSON.parse(e.data) as typeof m; } catch { return; }
        if (m.type !== 'puca-screen-share' || m.nonce !== nonce) return;
        settle(e.ports[0]);
    };
    const port = new Promise<MessagePort>((resolve, reject) => {
        settle = (p, err) => {
            window.removeEventListener('message', onMessage);
            if (timer) clearTimeout(timer);
            settle = () => {};
            if (p) resolve(p);
            else reject(err);
        };
    });
    window.addEventListener('message', onMessage);
    return {
        port,
        arm() {
            timer = setTimeout(() => settle(null, new DOMException('The phone did not hand over its screen', 'NotReadableError')), PORT_TIMEOUT_MS);
        },
        cancel() {
            settle(null, new DOMException('The screen share did not start', 'AbortError'));
        },
    };
}

/** The running share's counters, for diagnostics and the live test
 *  (e2e/android-share-live.mjs): what the phone sent, what was shown. */
export interface NativeShareStats {
    messages: number;
    frames: number;
    repeats: number;
    dropped: number;
    failed: number;
}
let currentStats: (() => NativeShareStats) | null = null;
export function nativeShareStats(): NativeShareStats | null {
    return currentStats?.() ?? null;
}

function makeNonce(): string {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * getDisplayMedia for the Android app: Android's consent dialog, then a
 * stream with one video track of this phone's screen. Refuses the way a
 * browser's picker does (NotAllowedError when the person said no).
 */
export async function getNativeDisplayMedia(options: DisplayMediaStreamOptions): Promise<MediaStream> {
    const asked = askedCapture(options);
    const nonce = makeNonce();
    const waiter = waitForPort(nonce);
    waiter.port.catch(() => { /* handled below */ });
    let capture: NativeCapture;
    try {
        const started = await SovereignScreenShare.start({ ...asked, nonce });
        capture = { width: started.width, height: started.height, fps: started.fps };
    } catch (err) {
        waiter.cancel();
        throw refusalAsDomException(err);
    }
    waiter.arm();
    let port: MessagePort;
    try {
        port = await waiter.port;
    } catch (err) {
        void SovereignScreenShare.stop().catch(() => {});
        throw err;
    }

    const Gen = generatorCtor();
    const sink = Gen ? generatorSink(Gen) : canvasSink();
    const track = sink.track;
    const pump = new FramePump<ImageBitmap>(
        bytes => createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' })),
        bitmap => sink.show(bitmap),
        () => { try { port.postMessage('ack'); } catch { /* port closed */ } },
    );
    let messages = 0;
    const stats = () => ({ messages, ...pump.shown });
    currentStats = stats;
    // A line every ten seconds in the log: from a desk, the only way to tell
    // "the phone stopped sending" from "the page stopped showing".
    let logged = Date.now();
    const repeat = setInterval(() => {
        pump.tick();
        if (Date.now() - logged >= 10_000) {
            logged = Date.now();
            console.log('[ScreenShare] phone share:', JSON.stringify(stats()));
        }
    }, REPEAT_MS / 2);
    let listener: PluginListenerHandle | null = null;
    let finished = false;

    const nativeStop = track.stop.bind(track);
    const finish = (fromNative: boolean) => {
        if (finished) return;
        finished = true;
        clearInterval(repeat);
        if (currentStats === stats) currentStats = null;
        pump.stop();
        sink.close();
        port.onmessage = null;
        try { port.close(); } catch { /* closed */ }
        void listener?.remove();
        listener = null;
        if (!fromNative) void SovereignScreenShare.stop().catch(() => {});
        nativeStop();
        if (fromNative) {
            // A track stopped by its own source fires `ended`; one stopped by
            // stop() does not, so say it: the voice panel ends the share on it.
            track.dispatchEvent(new Event('ended'));
        }
    };
    // The page stopping the share (Stop Sharing, leaving the call) stops the
    // track; that is the phone's signal to stop capturing.
    track.stop = () => finish(false);
    // A live re-size (Stream quality, the step-down) re-sizes the phone's
    // capture, and the track reports what the phone now captures: a
    // generated track has no source of its own to retune or to ask.
    const ownSettings = track.getSettings.bind(track);
    track.getSettings = () => ({ ...ownSettings(), width: capture.width, height: capture.height, frameRate: capture.fps });
    track.applyConstraints = async (constraints?: MediaTrackConstraints) => {
        if (finished) throw new DOMException('The share has ended', 'InvalidStateError');
        try {
            capture = await SovereignScreenShare.resize(askedCapture({ video: constraints ?? {} }));
        } catch (err) {
            throw refusalAsDomException(err);
        }
    };

    port.onmessage = (e: MessageEvent) => {
        messages++;
        const m = readPortMessage(e.data);
        if (m.kind === 'frame') pump.push(m.bytes);
        else if (m.kind === 'ended') {
            console.log('[ScreenShare] the phone ended the share:', m.reason);
            finish(true);
        }
    };
    // The same end, by the plugin's event: a port that died first says nothing.
    void SovereignScreenShare.addListener('shareEnded', () => finish(true))
        .then(h => { if (finished) void h.remove(); else listener = h; })
        .catch(() => { /* the port message still ends it */ });

    const stream = new MediaStream();
    stream.addTrack(track);
    return stream;
}
