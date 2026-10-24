/**
 * The mesh frame transforms on engines with the STANDARD WebRTC Encoded
 * Transform, `RTCRtpScriptTransform`: Firefox and Safari, including the
 * iPhone and iPad home-screen app. Chromium's `createEncodedStreams` runs the
 * same transforms on the page (mediaCrypto.ts); this is where they run when
 * frames are handed to a worker instead.
 *
 * The per-frame work is frameCrypto.ts's sealOutgoing / openIncoming, the
 * very functions the Chromium path calls, so both produce the same bytes and
 * the same fail-closed decisions.
 *
 * STATE. On the page, the transforms read the peer's MediaCryptoState object
 * on every frame, so a change takes effect on the next one. A worker cannot
 * read the page's objects: it holds a COPY per peer ("slot"), which the page
 * sends whole whenever any field changes (scriptTransform.ts,
 * PeerMediaCrypto). Messages from the page arrive in the order they were
 * sent, so the copy follows the same sequence of states the page went
 * through — a new session key, encryption switched on, "Require encryption"
 * switched on or off mid-call. A frame for a slot this worker has no copy of
 * (not arrived yet, or the peer is gone) is DROPPED: no state is never read
 * as "send it as it is".
 *
 * COUNTS. Every transform counts what it did with each frame (frameCrypto.ts
 * FrameCounts) and reports them when the page asks, and once, unasked, the
 * moment it first seals or opens one. The page needs them because a
 * transform that is attached is not proof that frames go through it: it
 * checks them against what the connection itself says it sent and received,
 * and only then calls the call encrypted (scriptTransform.ts, the audit).
 * An answer to every request is also how the page knows this worker is alive.
 *
 * No imports beyond the frame format, on purpose: this module is the whole
 * worker, and pulling in anything that touches the page would break it there.
 */
import {
    countFrame, inboundDropLogger, newFrameCounts, openIncoming, sealOutgoing,
    type EncodedFrameLike, type FrameCounts, type FrameOutcome, type MediaCryptoState,
} from './frameCrypto';

/** The page's messages to the worker. */
export type ScriptTransformCommand =
    | { type: 'state'; slot: string; key: CryptoKey | null; enabled: boolean; requireE2ee: boolean; hold: boolean }
    | { type: 'forget'; slot: string }
    /** Send every transform's counts now, answering with this seq. */
    | { type: 'report'; seq: number };

/** One transform's counts, by the id the page gave it. */
export interface TransformCountsReport extends FrameCounts {
    id: string;
}

/** The worker's messages to the page. `unreadable`: a message from the page
 *  could not be read here (a CryptoKey this engine would not hand over), so
 *  the copies it carried never arrived — the page stops using this path.
 *  `counts`: the answer to a `report` (its seq), or, with seq null, one
 *  transform's counts sent unasked when it seals or opens its first frame. */
export type ScriptTransformReport =
    | { type: 'ready' }
    | { type: 'unreadable' }
    | { type: 'counts'; seq: number | null; transforms: TransformCountsReport[] };

/** What each RTCRtpScriptTransform is constructed with, as its `options`. */
export interface ScriptTransformOptions {
    /** `seal` on a sender, `open` on a receiver. */
    op: 'seal' | 'open';
    slot: string;
    /** This transform's name in the counts. */
    id: string;
}

/** The parts of an RTCRtpScriptTransformer this uses. */
export interface ScriptTransformerLike {
    readonly options: unknown;
    readonly readable: ReadableStream;
    readonly writable: WritableStream;
}

/** The parts of a DedicatedWorkerGlobalScope this uses. */
export interface ScriptTransformScope {
    onmessage: ((ev: { data: unknown }) => void) | null;
    onmessageerror: ((ev: unknown) => void) | null;
    onrtctransform: ((ev: { transformer: ScriptTransformerLike }) => void) | null;
    postMessage(msg: ScriptTransformReport): void;
}

function isOptions(o: unknown): o is ScriptTransformOptions {
    const v = o as Partial<ScriptTransformOptions> | null;
    return !!v && (v.op === 'seal' || v.op === 'open') && typeof v.slot === 'string' && typeof v.id === 'string';
}

/** Serve RTCRtpScriptTransforms from this worker scope. */
export function serveScriptTransforms(scope: ScriptTransformScope): void {
    const slots = new Map<string, MediaCryptoState>();
    /** Every transform's counts, by id, with the slot it serves. */
    const counted = new Map<string, { slot: string; counts: FrameCounts }>();

    const report = (seq: number | null, only?: string) => {
        const transforms: TransformCountsReport[] = [];
        for (const [id, t] of counted) {
            if (only === undefined || id === only) transforms.push({ id, ...t.counts });
        }
        scope.postMessage({ type: 'counts', seq, transforms });
    };

    scope.onmessage = (ev) => {
        const msg = ev.data as ScriptTransformCommand | null;
        if (!msg) return;
        if (msg.type === 'report') {
            report(typeof msg.seq === 'number' ? msg.seq : null);
            return;
        }
        if (typeof msg.slot !== 'string') return;
        if (msg.type === 'state') {
            slots.set(msg.slot, { key: msg.key ?? null, enabled: !!msg.enabled, requireE2ee: !!msg.requireE2ee, hold: !!msg.hold });
        } else if (msg.type === 'forget') {
            slots.delete(msg.slot);
            for (const [id, t] of counted) if (t.slot === msg.slot) counted.delete(id);
        }
    };
    scope.onmessageerror = () => scope.postMessage({ type: 'unreadable' });

    scope.onrtctransform = (ev) => {
        const { options, readable, writable } = ev.transformer;
        // A transform constructed with anything else is not ours: pass
        // NOTHING through it rather than guess which way it faces.
        const opts = isOptions(options) ? options : null;
        const counts = newFrameCounts();
        if (opts) counted.set(opts.id, { slot: opts.slot, counts });
        const dropped = opts?.op === 'open' ? inboundDropLogger() : null;
        (readable as ReadableStream<EncodedFrameLike>)
            .pipeThrough(new TransformStream<EncodedFrameLike, EncodedFrameLike>({
                async transform(frame, controller) {
                    const state = opts ? slots.get(opts.slot) : undefined;
                    let outcome: FrameOutcome = 'dropped';
                    if (state && opts) {
                        outcome = opts.op === 'seal' ? await sealOutgoing(frame, state) : await openIncoming(frame, state);
                    }
                    const first = counts.done === 0 && (outcome === 'sealed' || outcome === 'opened');
                    countFrame(counts, outcome);
                    if (outcome !== 'dropped') controller.enqueue(frame);
                    else dropped?.();
                    // The page holds a receiver's track until it is shown
                    // this transform opens what that receiver gets: say so at
                    // once rather than at the next report.
                    if (first && opts) report(null, opts.id);
                },
            }))
            .pipeTo(writable as WritableStream<EncodedFrameLike>)
            .catch(() => { /* stream closed */ });
    };

    scope.postMessage({ type: 'ready' });
}
