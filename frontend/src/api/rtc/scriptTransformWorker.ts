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
 * No imports beyond the frame format, on purpose: this module is the whole
 * worker, and pulling in anything that touches the page would break it there.
 */
import { inboundDropLogger, openIncoming, sealOutgoing, type EncodedFrameLike, type MediaCryptoState } from './frameCrypto';

/** The page's messages to the worker. */
export type ScriptTransformCommand =
    | { type: 'state'; slot: string; key: CryptoKey | null; enabled: boolean; requireE2ee: boolean }
    | { type: 'forget'; slot: string };

/** The worker's messages to the page. `unreadable`: a message from the page
 *  could not be read here (a CryptoKey this engine would not hand over), so
 *  the copies it carried never arrived — the page stops using this path. */
export type ScriptTransformReport = { type: 'ready' } | { type: 'unreadable' };

/** What each RTCRtpScriptTransform is constructed with, as its `options`. */
export interface ScriptTransformOptions {
    /** `seal` on a sender, `open` on a receiver. */
    op: 'seal' | 'open';
    slot: string;
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
    return !!v && (v.op === 'seal' || v.op === 'open') && typeof v.slot === 'string';
}

/** Serve RTCRtpScriptTransforms from this worker scope. */
export function serveScriptTransforms(scope: ScriptTransformScope): void {
    const slots = new Map<string, MediaCryptoState>();

    scope.onmessage = (ev) => {
        const msg = ev.data as ScriptTransformCommand | null;
        if (!msg || typeof msg.slot !== 'string') return;
        if (msg.type === 'state') {
            slots.set(msg.slot, { key: msg.key ?? null, enabled: !!msg.enabled, requireE2ee: !!msg.requireE2ee });
        } else if (msg.type === 'forget') {
            slots.delete(msg.slot);
        }
    };
    scope.onmessageerror = () => scope.postMessage({ type: 'unreadable' });

    scope.onrtctransform = (ev) => {
        const { options, readable, writable } = ev.transformer;
        // A transform constructed with anything else is not ours: pass
        // NOTHING through it rather than guess which way it faces.
        const opts = isOptions(options) ? options : null;
        const dropped = opts?.op === 'open' ? inboundDropLogger() : null;
        (readable as ReadableStream<EncodedFrameLike>)
            .pipeThrough(new TransformStream<EncodedFrameLike, EncodedFrameLike>({
                async transform(frame, controller) {
                    const state = opts ? slots.get(opts.slot) : undefined;
                    let keep = false;
                    if (state && opts) {
                        keep = opts.op === 'seal' ? await sealOutgoing(frame, state) : await openIncoming(frame, state);
                    }
                    if (keep) controller.enqueue(frame);
                    else dropped?.();
                },
            }))
            .pipeTo(writable as WritableStream<EncodedFrameLike>)
            .catch(() => { /* stream closed */ });
    };

    scope.postMessage({ type: 'ready' });
}
