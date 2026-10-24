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
 *  - under enforcement a receiver's track is held silent until its transform
 *    has opened something (`opened`), and a sender carries a silent, black
 *    stand-in of its track until its transform has sealed something
 *    (`sealed`): the manager's receive gate and sender hold.
 *
 * GIVING UP. Two different things, said differently to the user:
 *  - The path cannot run on this page at all (the worker would not load — a
 *    Content-Security-Policy without worker-src 'self' — or this engine will
 *    not hand it a key, or will not build a transform): UNAVAILABLE, for
 *    good. The engine then reports that it cannot encrypt, and the status
 *    says so (mediaCrypto.noteScriptTransformUnavailable).
 *  - The audit could not confirm encryption on THIS call — frames went past
 *    a transform, one passed plaintext while none may pass, a sender's frames
 *    were not sealed while encryption was on, the worker failed after it had
 *    started, stopped answering, or never started: SUSPENDED. The call is
 *    rebuilt as one that cannot encrypt (blocked under enforcement), the
 *    status says encryption could not be confirmed on this call, and the
 *    path is tried again when the call ends or after a cool-down that
 *    doubles with each give-up in a row (resumePath). A misjudgement costs a
 *    call some seconds, never every later call.
 */
import {
    __resetScriptTransformAvailability, attachReceiverTransform, attachSenderTransform, mediaTransformApi,
    newFrameCounts, noteScriptTransformUnavailable, setScriptTransformSuspended,
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
/** How long a new worker may take to start — its script fetched and run,
 *  counted only while the page itself is awake — before the path is
 *  suspended. Its silence until then is not a miss: a slow network, a busy
 *  self-hosted server or a captive portal only makes it start late. */
const START_MS = 30_000;
/** Audio packets / video frames that must have moved through a sender or
 *  receiver before what reached its transform is judged against them. */
const MIN_MEDIA = { audio: 10, video: 3 } as const;
/** Windows the "most of it went past" check looks back over (it judges from
 *  the second on), and the looks a transform must have been watched for
 *  before "none of it ever reached it" or "part of it went past" is judged
 *  — so a worker that only fell behind for a moment is not taken for one
 *  that is passed by. */
const RATIO_WINDOWS = 3;
/** How many times MIN_MEDIA must have moved since a transform was first
 *  looked at before "part of it went past" is judged: enough that the
 *  moments the two counts are taken at, a few milliseconds apart, cannot
 *  make a quarter of it. */
const PARTIAL_FLOOR = 10;
/** Windows in a row carrying frames none of which sealed or opened, encryption
 *  on, after which the status says it could not be verified. */
const STUCK_WINDOWS = 5;
/** The first wait before a suspended path is tried again within a call; it
 *  doubles with each give-up in a row, up to RETRY_MAX_MS, and starts over
 *  once a call proves its encryption. The end of a call always lifts it. */
const RETRY_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

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
    /** Its counts and the connection's at the first look that had the
     *  connection's, and how many looks there have been since. */
    base: { seen: number; media: number; looks: number } | null = null;
    /** The latest windows' frames: what reached it, and what the connection moved. */
    recent: Array<{ seen: number; media: number }> = [];
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
    /** When `enabled` last turned on (Date.now()), or null while it is off. */
    enabledSince: number | null = null;
    /** The last report the audit had asked for when this state last changed:
     *  the audit's clock for "was this the state for the whole window". */
    changedAt = 0;
    /** Told when `proven` or `stuck` changes, or a transform seals or opens
     *  its first frame. */
    onChange: (() => void) | null = null;

    constructor(requireE2ee: boolean) {
        this.slot = `peer-${++slotSeq}`;
        this.requireValue = requireE2ee;
    }

    get key(): CryptoKey | null { return this.keyValue; }
    set key(v: CryptoKey | null) { this.set({ key: v }); }
    get enabled(): boolean { return this.enabledValue; }
    set enabled(v: boolean) { this.set({ enabled: v }); }
    get requireE2ee(): boolean { return this.requireValue; }
    set requireE2ee(v: boolean) { this.set({ requireE2ee: v }); }
    get hold(): boolean { return this.holdValue; }
    set hold(v: boolean) { this.set({ hold: v }); }

    /** Several fields at once, sent to the worker as ONE copy, so no frame is
     *  ever handled with half of the change (a hold that lands after
     *  `enabled` went off would let frames out in the clear between the two). */
    set(patch: { key?: CryptoKey | null; enabled?: boolean; requireE2ee?: boolean; hold?: boolean }): void {
        if (patch.key !== undefined) this.keyValue = patch.key;
        if (patch.enabled !== undefined) {
            if (patch.enabled && !this.enabledValue) this.enabledSince = Date.now();
            if (!patch.enabled) this.enabledSince = null;
            this.enabledValue = patch.enabled;
        }
        if (patch.requireE2ee !== undefined) this.requireValue = patch.requireE2ee;
        if (patch.hold !== undefined) this.holdValue = patch.hold;
        this.push();
    }

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
        return this.records.some((r) => r.target === receiver && r.op === 'open' && r.counts.done > 0);
    }

    /** Has the transform on this sender sealed a frame yet? */
    sealed(sender: RTCRtpSender): boolean {
        return this.records.some((r) => r.target === sender && r.op === 'seal' && r.counts.done > 0);
    }

    /** By the audit's latest look, has anything gone out on this worker-path
     *  sender — through its transform or past it, by the connection's own
     *  counters (which name no stream until its first packet)? Null until
     *  the audit has looked at it: a worker still starting has said nothing. */
    carriedOn(sender: RTCRtpSender): boolean | null {
        const r = this.records.find((x) => x.target === sender && x.op === 'seal' && x.path === 'script-transform');
        if (!r?.last) return null;
        return r.counts.seen > 0 || (r.last.media ?? 0) > 0;
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
        if (proven) retryRound = 0; // encryption works here: the next give-up waits the shortest
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
            transformPathUnavailable('a state update could not be sent to the transform worker', e);
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
/** How long the current worker has been starting, counting awake time only. */
let startWaited = 0;
let startLookedAt = 0;
/** For good, on this page: the worker cannot run here. */
let unavailable = false;
/** On this call: encryption could not be confirmed; tried again later. */
let suspended = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Give-ups in a row: the next cool-down is RETRY_MS doubled this many times. */
let retryRound = 0;
const lostListeners = new Set<() => void>();
const restoredListeners = new Set<() => void>();

/** Every state bound to the worker, and every worker-path transform by id. */
const audited = new Set<PeerMediaCrypto>();
const byId = new Map<string, TransformRecord>();
let auditTimer: ReturnType<typeof setTimeout> | null = null;
let auditRunning = false;
/** The last report asked for. */
let reportSeq = 0;
let misses = 0;
const awaiting = new Map<number, () => void>();

/** Stop what runs on the worker: the worker, and the audit's next look. */
function stopWorker(): void {
    if (auditTimer !== null) clearTimeout(auditTimer);
    auditTimer = null;
    audited.clear();
    misses = 0;
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
    workerReady = false;
}

/** Not from inside whatever found it: the manager tears peers down in
 *  response, and that must not run in the middle of building one. */
function tell(listeners: Set<() => void>, what: string): void {
    queueMicrotask(() => listeners.forEach((fn) => {
        try { fn(); } catch (e) { console.warn(`[media-e2ee] transform-${what} listener failed:`, e); }
    }));
}

/**
 * The path cannot run on this page: the worker would not start, or will not
 * take a state copy or build a transform. From here on the engine reports no
 * frame encryption (mediaCrypto.mediaTransformApi), and every listener — the
 * manager — rebuilds its peers through the "cannot encrypt here" guards, so a
 * call that was counting on this path is blocked or transport-only, as the
 * setting says, never silently relying on transforms that no longer run.
 */
function transformPathUnavailable(why: string, detail?: unknown): void {
    if (unavailable) return;
    unavailable = true;
    suspended = false;
    setScriptTransformSuspended(false);
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    console.warn(`[media-e2ee] the frame-transform worker is unavailable (${why}); this browser can no longer encrypt calls`, detail ?? '');
    noteScriptTransformUnavailable();
    stopWorker();
    tell(lostListeners, 'lost');
}

/**
 * Encryption could not be confirmed on this call. The same rebuild as
 * transformPathUnavailable — so nothing relies on transforms that may not be
 * running — but for this call only: the path is tried again when the call
 * ends (retryScriptTransformNextCall) or after the cool-down (resumePath),
 * and the status says what happened instead of calling this browser unable.
 */
function suspendPath(why: string, detail?: unknown): void {
    if (unavailable || suspended) return;
    suspended = true;
    setScriptTransformSuspended(true);
    const wait = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** retryRound);
    retryRound++;
    console.warn(`[media-e2ee] encryption could not be confirmed on this call (${why}); trying again in ${Math.round(wait / 1000)} s, or on the next call`, detail ?? '');
    stopWorker();
    retryTimer = setTimeout(() => resumePath('its cool-down is over'), wait);
    tell(lostListeners, 'lost');
}

/** Lift a suspension: the next transform attached gets a fresh worker. */
function resumePath(why: string): void {
    if (!suspended) return;
    suspended = false;
    setScriptTransformSuspended(false);
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    console.warn(`[media-e2ee] trying end-to-end encryption on this browser again (${why})`);
    tell(restoredListeners, 'restored');
}

/** Hear the path being given up, for good or for this call. Returns the unsubscribe. */
export function onScriptTransformLost(fn: () => void): () => void {
    lostListeners.add(fn);
    return () => { lostListeners.delete(fn); };
}

/** Hear a suspended path being tried again. Returns the unsubscribe. */
export function onScriptTransformRestored(fn: () => void): () => void {
    restoredListeners.add(fn);
    return () => { restoredListeners.delete(fn); };
}

/** The call ended: a give-up holds for one call, so the next one tries again. */
export function retryScriptTransformNextCall(): void {
    resumePath('the call ended');
}

/** The worker's counts, into the records they belong to. */
function applyCounts(msg: { seq: number | null; transforms: TransformCountsReport[] }): void {
    const first = new Set<PeerMediaCrypto>();
    for (const t of msg.transforms ?? []) {
        const r = byId.get(t.id);
        if (!r) continue;
        if (r.counts.done === 0 && t.done > 0) first.add(r.state);
        r.counts.seen = t.seen;
        r.counts.done = t.done;
        r.counts.clear = t.clear;
        r.counts.dropped = t.dropped;
    }
    for (const s of first) s.changed();
    if (typeof msg.seq === 'number') awaiting.get(msg.seq)?.();
}

function transformWorker(): TransformWorkerLike | null {
    if (unavailable || suspended) return null;
    if (worker) return worker;
    let w: TransformWorkerLike;
    try {
        w = workerFactory();
    } catch (e) {
        transformPathUnavailable('it could not be created', e);
        return null;
    }
    worker = w;
    workerReady = false;
    startWaited = 0;
    startLookedAt = Date.now();
    w.addEventListener('message', (ev) => {
        if (worker !== w) return;
        const msg = ev.data;
        if (msg?.type === 'ready') workerReady = true;
        else if (msg?.type === 'unreadable') transformPathUnavailable('it could not read a state update');
        else if (msg?.type === 'counts') applyCounts(msg);
    });
    w.addEventListener('error', (ev) => {
        if (worker !== w) return;
        // Before its first message: the script never ran (a Content-Security-
        // Policy without worker-src 'self', a missing chunk) — it will not on
        // this page. After it, an uncaught error inside it, which the worker
        // is written not to have: its transforms may be dead or half-working,
        // so they are not relied on for this call.
        if (workerReady) suspendPath('it failed', ev);
        else transformPathUnavailable('its script did not load', ev);
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
            transformPathUnavailable('it could not be asked for its counts', e);
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

/** One transform's window. False when the path was suspended over it. */
function judge(r: TransformRecord, media: { total: number; kind: 'audio' | 'video' } | null, seq: number): boolean {
    const prev = r.last;
    r.last = { seq, seen: r.counts.seen, done: r.counts.done, clear: r.counts.clear, media: media?.total ?? null };
    r.carried = false;
    r.moved = false;
    if (media && !r.base) {
        r.base = { seen: r.counts.seen, media: media.total, looks: 0 };
        return true;
    }
    if (!prev) return true;
    const dSeen = r.counts.seen - prev.seen;
    const dDone = r.counts.done - prev.done;
    const dClear = r.counts.clear - prev.clear;
    const dMedia = media && prev.media !== null ? Math.max(0, media.total - prev.media) : 0;
    const floor = media ? MIN_MEDIA[media.kind] : Infinity;
    if (media && prev.media !== null) {
        r.recent.push({ seen: dSeen, media: dMedia });
        if (r.recent.length > RATIO_WINDOWS) r.recent.shift();
    }
    if (r.base) r.base.looks++;
    r.carried = dSeen > 0 || dMedia >= floor;
    r.moved = dDone > 0;
    // Frames the connection sent or decoded that did not go through the
    // transform. None at all since it was first looked at, however slowly
    // they came (a screen share at one frame a second strikes no window)...
    const neverSeen = !!media && !!r.base && r.base.looks >= RATIO_WINDOWS
        && r.counts.seen === r.base.seen && media.total - r.base.media >= floor;
    // ...or, over the latest windows, fewer than a quarter of them (passed
    // by partway, or passed by since some point)...
    const sum = r.recent.reduce((a, w) => ({ seen: a.seen + w.seen, media: a.media + w.media }), { seen: 0, media: 0 });
    const mostlyPast = r.recent.length >= 2 && sum.media >= floor && sum.seen * 4 < sum.media;
    // ...or, steadily, fewer than three quarters of them since it was first
    // looked at (a part of every second's frames passed by, at any rate) —
    // while each of the two latest windows still moved more on the
    // connection than through the transform: a worker catching up after it
    // fell behind is not passed by. (A sender's frames go out only after
    // its transform, so on a sender nothing but a bypass makes a deficit.)
    const since = media && r.base ? { seen: r.counts.seen - r.base.seen, media: media.total - r.base.media } : null;
    const lastTwo = r.recent.slice(-2);
    const partlyPast = !!since && r.base!.looks >= RATIO_WINDOWS && since.media >= PARTIAL_FLOOR * floor
        && since.seen * 4 < since.media * 3 && lastTwo.length === 2 && lastTwo.every((w) => w.media > w.seen);
    if (neverSeen || mostlyPast || partlyPast) {
        const how = neverSeen ? 'never went' : mostlyPast ? 'mostly did not go' : 'partly did not go';
        suspendPath(`${r.op === 'seal' ? 'a sender sent' : 'a receiver took'} frames that ${how} through its transform`);
        return false;
    }
    // The rest is about what the state said, so only for a window the state
    // held from start to end (it was sent before the request that opened it).
    const s = r.state;
    if (s.changedAt >= prev.seq) return true;
    if (dClear > 0 && (s.requireE2ee || s.hold)) {
        suspendPath('it passed frames on as they came while none may be');
        return false;
    }
    if (r.op === 'seal' && dSeen > 0 && dDone === 0 && s.enabled && s.key && !s.hold) {
        suspendPath('a sender’s frames were not sealed although encryption is on');
        return false;
    }
    return true;
}

function scheduleAudit(): void {
    if (auditTimer !== null || auditRunning || unavailable || suspended || audited.size === 0) return;
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
    if (!w || unavailable || suspended || audited.size === 0 || auditRunning) return;
    auditRunning = true;
    try {
        if (!workerReady) {
            // Still starting: nothing to ask it yet. Only awake time counts —
            // a look that comes far later than due was a page asleep, and
            // the worker was too.
            const now = Date.now();
            startWaited += Math.min(now - startLookedAt, 2 * AUDIT_MS);
            startLookedAt = now;
            if (startWaited > START_MS) suspendPath('it did not start');
            return;
        }
        const records = [...audited].flatMap((s) => s.audits());
        const startedAt = Date.now();
        const answered = requestCounts(w);
        const seq = reportSeq;
        const media = await Promise.all(records.map(mediaSoFar));
        const ok = await answered;
        if (unavailable || suspended || worker !== w) return;
        if (!ok) {
            // Unanswered. A page that was itself asleep (a locked phone, a
            // throttled background tab) has its timer fire long after it was
            // due: then the worker was asleep too, and nothing is counted.
            if (Date.now() - startedAt < 2 * REPLY_MS) {
                if (++misses >= MISSES) suspendPath('it stopped answering');
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
        transformPathUnavailable('a transform could not be attached', e);
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
    if (!w || unavailable || suspended) return false;
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
    unavailable = false;
    suspended = false;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    retryRound = 0;
    if (auditTimer !== null) clearTimeout(auditTimer);
    auditTimer = null;
    auditRunning = false;
    audited.clear();
    byId.clear();
    awaiting.clear();
    reportSeq = 0;
    misses = 0;
    startWaited = 0;
    __resetScriptTransformAvailability();
}
