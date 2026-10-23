/**
 * The page's half of the STANDARD WebRTC Encoded Transform path
 * (`RTCRtpScriptTransform`), which is how a mesh call is end-to-end encrypted
 * on Firefox and Safari — the iPhone and iPad home-screen app included. The
 * frames are sealed and opened in a worker (scriptTransformWorker.ts) with
 * the same functions the Chromium path runs on the page, so the two kinds of
 * peer read each other's frames.
 *
 * Imported by rtc/manager.ts only: the worker URL below is what makes Vite
 * emit the worker, and a bundle that never makes calls (Púca Notes) should not
 * carry it.
 *
 * WHICH PATH: mediaCrypto.mediaTransformApi() picks ONE per engine, and the
 * manager attaches through attachMediaSenderTransform /
 * attachMediaReceiverTransform below, so a sender or receiver is never given
 * both a createEncodedStreams pipe and a `transform`.
 */
import {
    __resetScriptTransformAvailability, attachReceiverTransform, attachSenderTransform, mediaTransformApi,
    noteScriptTransformUnavailable, type MediaCryptoState,
} from './mediaCrypto';
import type { ScriptTransformCommand, ScriptTransformOptions, ScriptTransformReport } from './scriptTransformWorker';

/** Where a state copy is sent: the transform worker (a stand-in in tests). */
export interface TransformWorkerLike {
    postMessage(msg: ScriptTransformCommand): void;
    addEventListener(type: 'message', fn: (ev: MessageEvent<ScriptTransformReport>) => void): void;
    addEventListener(type: 'error', fn: (ev: Event) => void): void;
    terminate(): void;
}

let slotSeq = 0;

/**
 * A peer's media crypto state, as the frame transforms see it.
 *
 * On the createEncodedStreams path the transforms run on this page and read
 * these fields on every frame. On the RTCRtpScriptTransform path they run in
 * the worker, which keeps a copy: every write here sends the whole state to
 * it, so a new session key, `enabled` turning on, or "Require encryption"
 * changing mid-call takes effect there too. A setter rather than a send at
 * each write site, so a future write cannot forget it (the manager writes
 * these fields in five places).
 */
export class PeerMediaCrypto implements MediaCryptoState {
    /** This state's name in the worker. Never reused. */
    readonly slot: string;
    private keyValue: CryptoKey | null = null;
    private enabledValue = false;
    private requireValue: boolean;
    private sink: TransformWorkerLike | null = null;

    constructor(requireE2ee: boolean) {
        this.slot = `peer-${++slotSeq}`;
        this.requireValue = requireE2ee;
    }

    get key(): CryptoKey | null { return this.keyValue; }
    set key(v: CryptoKey | null) { this.keyValue = v; this.push(); }
    get enabled(): boolean { return this.enabledValue; }
    set enabled(v: boolean) { this.enabledValue = v; this.push(); }
    get requireE2ee(): boolean { return this.requireValue; }
    set requireE2ee(v: boolean) { this.requireValue = v; this.push(); }

    /** Give the worker a copy of this state now, and every change from now on. */
    bindTo(worker: TransformWorkerLike): void {
        if (this.sink === worker) return;
        this.sink = worker;
        this.push();
    }

    /** The peer is gone: the worker drops its copy, key and all. */
    dispose(): void {
        const sink = this.sink;
        this.sink = null;
        try { sink?.postMessage({ type: 'forget', slot: this.slot }); } catch { /* worker gone */ }
    }

    private push(): void {
        if (!this.sink) return;
        try {
            this.sink.postMessage({
                type: 'state', slot: this.slot,
                key: this.keyValue, enabled: this.enabledValue, requireE2ee: this.requireValue,
            });
        } catch (e) {
            // The copy did not reach the worker (an engine that will not hand
            // a CryptoKey to one). Its transforms keep the LAST copy they got,
            // so nothing here may rely on them any longer.
            transformPathLost('a state update could not be sent to the transform worker', e);
        }
    }
}

type WorkerFactory = () => TransformWorkerLike;
const defaultFactory: WorkerFactory = () =>
    new Worker(new URL('./scriptTransform.worker.ts', import.meta.url), { type: 'module' }) as unknown as TransformWorkerLike;
let workerFactory: WorkerFactory = defaultFactory;
let worker: TransformWorkerLike | null = null;
/** Whether the worker has said it is running (its first message). */
let workerReady = false;
let lost = false;
const lostListeners = new Set<() => void>();

/**
 * The transform path is gone: the worker would not start, or a state copy
 * could not reach it. From here on the engine reports no frame encryption
 * (mediaCrypto.mediaTransformApi), and every listener — the manager — rebuilds
 * its peers through the "cannot encrypt here" guards, so a call that was
 * counting on this path is blocked or transport-only, as the setting says,
 * never silently relying on transforms that no longer run.
 */
function transformPathLost(why: string, detail?: unknown): void {
    if (lost) return;
    lost = true;
    console.warn(`[media-e2ee] the frame-transform worker is unavailable (${why}); this browser can no longer encrypt calls`, detail ?? '');
    noteScriptTransformUnavailable();
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
    // Not from inside the attach that found it: the manager tears peers down
    // in response, and that must not run in the middle of building one.
    queueMicrotask(() => lostListeners.forEach(fn => { try { fn(); } catch (e) { console.warn('[media-e2ee] transform-lost listener failed:', e); } }));
}

/** Hear the transform path being lost (see transformPathLost). Returns the unsubscribe. */
export function onScriptTransformLost(fn: () => void): () => void {
    lostListeners.add(fn);
    return () => { lostListeners.delete(fn); };
}

function transformWorker(): TransformWorkerLike | null {
    if (lost) return null;
    if (worker) return worker;
    let w: TransformWorkerLike;
    try {
        w = workerFactory();
    } catch (e) {
        transformPathLost('it could not be created', e);
        return null;
    }
    worker = w;
    workerReady = false;
    w.addEventListener('message', (ev) => {
        if (ev.data?.type === 'ready') workerReady = true;
        else if (ev.data?.type === 'unreadable') transformPathLost('it could not read a state update');
    });
    w.addEventListener('error', (ev) => {
        // Before its first message: the script never ran (a Content-Security-
        // Policy without worker-src 'self', a missing chunk). After it, an
        // uncaught error inside it, which the worker is written not to have.
        if (!workerReady) transformPathLost('its script did not load', ev);
        else console.warn('[media-e2ee] error in the frame-transform worker:', ev);
    });
    return w;
}

function attachScript(target: RTCRtpSender | RTCRtpReceiver, op: ScriptTransformOptions['op'], state: MediaCryptoState): boolean {
    if (!(state instanceof PeerMediaCrypto)) {
        console.warn('[media-e2ee] no worker copy for this state; not attaching a frame transform');
        return false;
    }
    const w = transformWorker();
    if (!w) return false;
    try {
        // The copy is sent BEFORE the transform exists, so it is in the
        // worker's queue ahead of the first frame.
        state.bindTo(w);
        const options: ScriptTransformOptions = { op, slot: state.slot };
        target.transform = new RTCRtpScriptTransform(w as unknown as Worker, options);
        return true;
    } catch (e) {
        transformPathLost('a transform could not be attached', e);
        return false;
    }
}

/**
 * Attach the encrypt transform to a sender, through whichever API this engine
 * uses. False when none could be attached; the engine then reports no frame
 * encryption, and the manager stops relying on it.
 */
export function attachMediaSenderTransform(sender: RTCRtpSender, state: MediaCryptoState): boolean {
    const api = mediaTransformApi();
    if (api === 'encoded-streams') return attachSenderTransform(sender, state);
    if (api === 'script-transform') return attachScript(sender, 'seal', state);
    return false;
}

/** Attach the decrypt transform to a receiver (see attachMediaSenderTransform). */
export function attachMediaReceiverTransform(receiver: RTCRtpReceiver, state: MediaCryptoState): boolean {
    const api = mediaTransformApi();
    if (api === 'encoded-streams') return attachReceiverTransform(receiver, state);
    if (api === 'script-transform') return attachScript(receiver, 'open', state);
    return false;
}

/** Tests only: how the worker is made (null: the real one), with the path's health reset. */
export function __setScriptTransformWorkerFactory(f: WorkerFactory | null): void {
    workerFactory = f ?? defaultFactory;
    worker = null;
    workerReady = false;
    lost = false;
    __resetScriptTransformAvailability();
}
