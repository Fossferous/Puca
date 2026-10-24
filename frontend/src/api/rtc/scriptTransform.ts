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
 *
 * PROOF, on the worker path. A createEncodedStreams pipe cannot be passed by:
 * once it exists, frames reach the network or the decoder only through it.
 * An RTCRtpScriptTransform can be — measured: Chromium, on this path, accepts
 * one set on the offerer's receiver in ontrack, reports it attached, and
 * decodes every frame that receiver gets without handing a single one to it.
 * So on this path nothing is taken on trust:
 *  - every transform counts what it did with each frame, and the worker
 *    reports those counts (scriptTransformWorker.ts);
 *  - every AUDIT_MS the page asks for them and reads the connection's own
 *    counters for the same sender or receiver (auditTick);
 *  - a peer counts as encrypted only once a window of that shows every
 *    transform that carried frames sealing or opening them (`proven`);
 *  - a receiver's track is held silent under enforcement until its transform
 *    has opened something (`opened`, the manager's receive gate);
 *  - and the path is given up — every peer rebuilt as "cannot encrypt here",
 *    which under enforcement means blocked — when frames go by a transform,
 *    when one passes plaintext while nothing may pass, when a sender's frames
 *    are not sealed while encryption is on, when the worker reports an error,
 *    or when it stops answering.
 */
import {
    __resetScriptTransformAvailability, attachReceiverTransform, attachSenderTransform, mediaTransformApi,
    newFrameCounts, noteScriptTransformUnavailable,
    type FrameCounts, type MediaCryptoState, type MediaTransformApi,
} from './mediaCrypto';
import type {
    ScriptTransformCommand, ScriptTransformOptions, ScriptTransformReport, TransformCountsReport,
} from './scriptTransformWorker';

/** Where a state copy is sent: the transform worker (a stand-in in tests). */
export interface TransformWorkerLike {
    postMessage(msg: ScriptTransformCommand): void;
    addEventListener(type: 'message', fn: (ev: MessageEvent<ScriptTransformReport>) => void): void;
    addEventListener(type: 'error', fn: (ev: Event) => void): void;
    terminate(): void;
}

/** How often the audit looks (and asks the worker for its counts). */
export const AUDIT_MS = 2000;
/** How long an answer to one request may take before it counts as missed. */
const REPLY_MS = 5000;
/** Missed answers in a row, with the page awake, that mean the worker is gone. */
const MISSES = 2;
/** Windows in a row with frames going by a transform that mean it is passed by. */
const STRIKES = 2;
/** Fewer than this many audio packets / video frames in a window prove nothing
 *  about a transform that saw none (a static screen share sends almost none). */
const MIN_MEDIA = { audio: 10, video: 3 } as const;
/** Windows in a row carrying frames none of which sealed or opened, encryption
 *  on, after which the status says it could not be verified. */
const STUCK_WINDOWS = 5;

let slotSeq = 0;
let transformSeq = 0;

/** One frame transform this page attached, and what it has done so far. */
export interface FrameTransformRecord {
    readonly id: string;
    /** `seal` on a sender, `open` on a receiver. */
    readonly op: 'seal' | 'open';
    /** Where its frames are handled: on this page, counted as they pass, or in
     *  the worker, as it last reported. */
    readonly path: MediaTransformApi;
    readonly target: RTCRtpSender | RTCRtpReceiver;
    readonly counts: FrameCounts;
}

/** The audit's look at one transform: its counts and the connection's. */
interface Sample {
    seq: number;
    seen: number;
    done: number;
    clear: number;
    media: number | null;
}

class TransformRecord implements FrameTransformRecord {
    readonly id: string;
    readonly op: 'seal' | 'open';
    readonly path: MediaTransformApi;
    readonly target: RTCRtpSender | RTCRtpReceiver;
    readonly counts: FrameCounts;
    readonly state: PeerMediaCrypto;
    /** The audit's previous look. */
    last: Sample | null = null;
    /** Windows in a row in which the connection moved frames past it. */
    strikes = 0;
    /** In the audit's latest window: frames went through it (or past it),
     *  and some were sealed or opened. */
    carried = false;
    moved = false;

    constructor(id: string, op: 'seal' | 'open', path: MediaTransformApi, target: RTCRtpSender | RTCRtpReceiver, counts: FrameCounts, state: PeerMediaCrypto) {
        this.id = id;
        this.op = op;
        this.path = path;
        this.target = target;
        this.counts = counts;
        this.state = state;
    }
}

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
    private holdValue = false;
    private sink: TransformWorkerLike | null = null;
    private readonly records: TransformRecord[] = [];
    private provenValue = false;
    private stuckWindows = 0;
    /** The last report the audit had asked for when this state last changed:
     *  the audit's clock for "was this the state for the whole window". */
    changedAt = 0;
    /** Told when `proven` or `stuck` changes, or a receiver's transform opens
     *  its first frame. */
    onChange: (() => void) | null = null;

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
    get hold(): boolean { return this.holdValue; }
    set hold(v: boolean) { this.holdValue = v; this.push(); }

    /** Every transform attached for this peer, either path. */
    get transforms(): readonly FrameTransformRecord[] { return this.records; }

    /**
     * Worker path: the audit's latest window that carried frames saw every
     * transform that carried them seal or open them. False until that first
     * window; unchanged by a window in which nothing moved. (The page path
     * has nothing to prove: its transforms cannot be passed by.)
     */
    get proven(): boolean { return this.provenValue; }

    /** Encryption is on, and for STUCK_WINDOWS windows in a row frames came
     *  and went without one being sealed or opened: not "setting up" any
     *  more, but failing. */
    get stuck(): boolean { return this.stuckWindows >= STUCK_WINDOWS; }

    /** Has the transform on this receiver opened a frame yet? */
    opened(receiver: RTCRtpReceiver): boolean {
        return this.records.some((r) => r.target === receiver && r.counts.done > 0);
    }

    /** Give the worker a copy of this state now, and every change from now on. */
    bindTo(worker: TransformWorkerLike): void {
        if (this.sink === worker) return;
        this.sink = worker;
        audited.add(this);
        this.push();
        scheduleAudit();
    }

    /** The peer is gone: the worker drops its copy, key and all. */
    dispose(): void {
        const sink = this.sink;
        this.sink = null;
        audited.delete(this);
        for (const r of this.records) byId.delete(r.id);
        this.onChange = null;
        try { sink?.postMessage({ type: 'forget', slot: this.slot }); } catch { /* worker gone */ }
    }

    /** @internal */
    addRecord(op: 'seal' | 'open', path: MediaTransformApi, target: RTCRtpSender | RTCRtpReceiver, counts: FrameCounts): TransformRecord {
        const record = new TransformRecord(`t-${++transformSeq}`, op, path, target, counts, this);
        this.records.push(record);
        if (path === 'script-transform') byId.set(record.id, record);
        return record;
    }

    /** @internal The worker-path records the audit looks at. */
    audits(): TransformRecord[] {
        return this.records.filter((r) => r.path === 'script-transform');
    }

    /** @internal After a window: is every transform that carried frames
     *  sealing or opening them? */
    settle(): void {
        const carriers = this.audits().filter((r) => r.carried);
        if (carriers.length === 0) return; // nothing moved: nothing learned
        const proven = carriers.every((r) => r.moved);
        const stuckBefore = this.stuck;
        this.stuckWindows = proven || !this.enabledValue ? 0 : this.stuckWindows + 1;
        if (proven !== this.provenValue || stuckBefore !== this.stuck) {
            this.provenValue = proven;
            this.changed();
        }
    }

    /** @internal */
    changed(): void {
        try { this.onChange?.(); } catch (e) { console.warn('[media-e2ee] frame-proof listener failed:', e); }
    }

    private push(): void {
        this.changedAt = reportSeq;
        if (!this.sink) return;
        try {
            this.sink.postMessage({
                type: 'state', slot: this.slot,
                key: this.keyValue, enabled: this.enabledValue, requireE2ee: this.requireValue, hold: this.holdValue,
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

/** Every state bound to the worker, and every worker-path transform by id. */
const audited = new Set<PeerMediaCrypto>();
const byId = new Map<string, TransformRecord>();
let auditTimer: ReturnType<typeof setTimeout> | null = null;
let auditRunning = false;
/** The last report asked for. */
let reportSeq = 0;
let misses = 0;
const awaiting = new Map<number, () => void>();

/**
 * The transform path is gone: the worker would not start, a state copy could
 * not reach it, it failed, it stopped answering, or the audit found frames
 * not going through it as they must. From here on the engine reports no
 * frame encryption (mediaCrypto.mediaTransformApi), and every listener — the
 * manager — rebuilds its peers through the "cannot encrypt here" guards, so a
 * call that was counting on this path is blocked or transport-only, as the
 * setting says, never silently relying on transforms that no longer run.
 */
function transformPathLost(why: string, detail?: unknown): void {
    if (lost) return;
    lost = true;
    console.warn(`[media-e2ee] the frame-transform worker is unavailable (${why}); this browser can no longer encrypt calls`, detail ?? '');
    noteScriptTransformUnavailable();
    if (auditTimer !== null) clearTimeout(auditTimer);
    auditTimer = null;
    audited.clear();
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

/** The worker's counts, into the records they belong to. */
function applyCounts(msg: { seq: number | null; transforms: TransformCountsReport[] }): void {
    const opened = new Set<PeerMediaCrypto>();
    for (const t of msg.transforms ?? []) {
        const r = byId.get(t.id);
        if (!r) continue;
        if (r.op === 'open' && r.counts.done === 0 && t.done > 0) opened.add(r.state);
        r.counts.seen = t.seen;
        r.counts.done = t.done;
        r.counts.clear = t.clear;
        r.counts.dropped = t.dropped;
    }
    for (const s of opened) s.changed();
    if (typeof msg.seq === 'number') awaiting.get(msg.seq)?.();
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
        const msg = ev.data;
        if (msg?.type === 'ready') workerReady = true;
        else if (msg?.type === 'unreadable') transformPathLost('it could not read a state update');
        else if (msg?.type === 'counts' && worker === w) applyCounts(msg);
    });
    w.addEventListener('error', (ev) => {
        // Before its first message: the script never ran (a Content-Security-
        // Policy without worker-src 'self', a missing chunk). After it, an
        // uncaught error inside it, which the worker is written not to have:
        // its transforms may be dead or half-working, so neither is relied on.
        transformPathLost(workerReady ? 'it failed' : 'its script did not load', ev);
    });
    return w;
}

/** Ask the worker for every transform's counts; true once they are in. */
function requestCounts(w: TransformWorkerLike): Promise<boolean> {
    const seq = ++reportSeq;
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { awaiting.delete(seq); resolve(false); }, REPLY_MS);
        awaiting.set(seq, () => { clearTimeout(timer); awaiting.delete(seq); resolve(true); });
        try {
            w.postMessage({ type: 'report', seq });
        } catch (e) {
            clearTimeout(timer);
            awaiting.delete(seq);
            transformPathLost('it could not be asked for its counts', e);
            resolve(false);
        }
    });
}

/** The connection's own count of what went through a sender or receiver:
 *  audio packets, or video frames (encoded, for a sender; received, for a
 *  receiver). Null when the engine says nothing. */
async function mediaSoFar(r: TransformRecord): Promise<{ total: number; kind: 'audio' | 'video' } | null> {
    let report: RTCStatsReport;
    try {
        report = await r.target.getStats();
    } catch {
        return null;
    }
    let total: number | null = null;
    let kind: 'audio' | 'video' = 'audio';
    for (const s of report.values() as Iterable<Record<string, unknown>>) {
        const k = (s.kind ?? s.mediaType) as string | undefined;
        let v: unknown;
        if (r.op === 'seal' && s.type === 'outbound-rtp') v = k === 'video' ? s.framesEncoded : s.packetsSent;
        else if (r.op === 'open' && s.type === 'inbound-rtp') v = k === 'video' ? (s.framesReceived ?? s.framesDecoded) : s.packetsReceived;
        if (typeof v !== 'number') continue;
        total = (total ?? 0) + v;
        if (k === 'video') kind = 'video';
    }
    return total === null ? null : { total, kind };
}

/** One transform's window. False when the path was given up over it. */
function judge(r: TransformRecord, media: { total: number; kind: 'audio' | 'video' } | null, seq: number): boolean {
    const prev = r.last;
    r.last = { seq, seen: r.counts.seen, done: r.counts.done, clear: r.counts.clear, media: media?.total ?? null };
    r.carried = false;
    r.moved = false;
    if (!prev) return true;
    const dSeen = r.counts.seen - prev.seen;
    const dDone = r.counts.done - prev.done;
    const dClear = r.counts.clear - prev.clear;
    const dMedia = media && prev.media !== null ? media.total - prev.media : 0;
    const passedBy = dSeen === 0 && !!media && dMedia >= MIN_MEDIA[media.kind];
    r.carried = dSeen > 0 || passedBy;
    r.moved = dDone > 0;
    // Frames the connection sent or decoded that never reached the transform.
    r.strikes = passedBy ? r.strikes + 1 : 0;
    if (r.strikes >= STRIKES) {
        transformPathLost(`${r.op === 'seal' ? 'a sender sent' : 'a receiver took'} frames that never went through its transform`);
        return false;
    }
    // The rest is about what the state said, so only for a window the state
    // held from start to end (it was sent before the request that opened it).
    const s = r.state;
    if (s.changedAt >= prev.seq) return true;
    if (dClear > 0 && (s.requireE2ee || s.hold)) {
        transformPathLost('it passed frames on as they came while none may be');
        return false;
    }
    if (r.op === 'seal' && dSeen > 0 && dDone === 0 && s.enabled && s.key && !s.hold) {
        transformPathLost('a sender’s frames were not sealed although encryption is on');
        return false;
    }
    return true;
}

function scheduleAudit(): void {
    if (auditTimer !== null || auditRunning || lost || audited.size === 0) return;
    auditTimer = setTimeout(() => {
        auditTimer = null;
        void auditTick();
    }, AUDIT_MS);
}

/**
 * One look: ask the worker for its counts, read the connection's counters
 * for every worker-path transform, and judge the window since the last look.
 */
async function auditTick(): Promise<void> {
    const w = worker;
    if (!w || lost || audited.size === 0 || auditRunning) return;
    auditRunning = true;
    try {
        const records = [...audited].flatMap((s) => s.audits());
        const startedAt = Date.now();
        const answered = requestCounts(w);
        const seq = reportSeq;
        const media = await Promise.all(records.map(mediaSoFar));
        const ok = await answered;
        if (lost || worker !== w) return;
        if (!ok) {
            // Unanswered. A page that was itself asleep (a locked phone, a
            // throttled background tab) has its timer fire long after it was
            // due: then the worker was asleep too, and nothing is counted.
            if (Date.now() - startedAt < 2 * REPLY_MS) {
                if (++misses >= MISSES) transformPathLost('it stopped answering');
            } else {
                misses = 0;
            }
            return;
        }
        misses = 0;
        for (let i = 0; i < records.length; i++) {
            if (!judge(records[i], media[i], seq)) return;
        }
        for (const s of audited) s.settle();
    } finally {
        auditRunning = false;
        scheduleAudit();
    }
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
        const record = state.addRecord(op, 'script-transform', target, newFrameCounts());
        const options: ScriptTransformOptions = { op, slot: state.slot, id: record.id };
        target.transform = new RTCRtpScriptTransform(w as unknown as Worker, options);
        return true;
    } catch (e) {
        transformPathLost('a transform could not be attached', e);
        return false;
    }
}

/** createEncodedStreams, counting into a record of the peer's when it keeps them. */
function attachOnPage<T extends RTCRtpSender | RTCRtpReceiver>(
    target: T, op: 'seal' | 'open', state: MediaCryptoState,
    attach: (t: T, s: MediaCryptoState, counts: FrameCounts) => boolean,
): boolean {
    const counts = newFrameCounts();
    if (!attach(target, state, counts)) return false;
    if (state instanceof PeerMediaCrypto) state.addRecord(op, 'encoded-streams', target, counts);
    return true;
}

/**
 * Attach the encrypt transform to a sender, through whichever API this engine
 * uses. False when none could be attached; the engine then reports no frame
 * encryption, and the manager stops relying on it.
 */
export function attachMediaSenderTransform(sender: RTCRtpSender, state: MediaCryptoState): boolean {
    const api = mediaTransformApi();
    if (api === 'encoded-streams') return attachOnPage(sender, 'seal', state, attachSenderTransform);
    if (api === 'script-transform') return attachScript(sender, 'seal', state);
    return false;
}

/** Attach the decrypt transform to a receiver (see attachMediaSenderTransform). */
export function attachMediaReceiverTransform(receiver: RTCRtpReceiver, state: MediaCryptoState): boolean {
    const api = mediaTransformApi();
    if (api === 'encoded-streams') return attachOnPage(receiver, 'open', state, attachReceiverTransform);
    if (api === 'script-transform') return attachScript(receiver, 'open', state);
    return false;
}

/** Have the worker's latest counts in every record now (tests and the
 *  real-browser harness; the audit asks on its own). True once they are. */
export async function refreshFrameCounts(): Promise<boolean> {
    const w = worker;
    if (!w || lost) return false;
    return requestCounts(w);
}

/** Tests only: one audit look, now. */
export function __runFrameAudit(): Promise<void> {
    if (auditTimer !== null) clearTimeout(auditTimer);
    auditTimer = null;
    return auditTick();
}

/** Tests only: how the worker is made (null: the real one), with the path's health reset. */
export function __setScriptTransformWorkerFactory(f: WorkerFactory | null): void {
    workerFactory = f ?? defaultFactory;
    worker = null;
    workerReady = false;
    lost = false;
    if (auditTimer !== null) clearTimeout(auditTimer);
    auditTimer = null;
    auditRunning = false;
    audited.clear();
    byId.clear();
    awaiting.clear();
    reportSeq = 0;
    misses = 0;
    __resetScriptTransformAvailability();
}
