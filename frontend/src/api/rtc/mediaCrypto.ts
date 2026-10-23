import { sdpFingerprints } from '../dtlsFingerprint';
import { dtlsPinTag } from '../e2ee';
import { inboundDropLogger, openIncoming, sealOutgoing, type EncodedFrameLike, type MediaCryptoState } from './frameCrypto';
/**
 * End-to-end encryption for WebRTC media (voice + screen share).
 *
 * Mesh WebRTC is pairwise, so each peer connection encrypts frames under a key
 * derived from the two users' identity keys (see e2ee.deriveMediaKey). Frames
 * are encrypted with AES-256-GCM (the format: frameCrypto.ts) by a transform
 * on every sender and receiver, so the media never reaches the server (or a
 * TURN relay) in a form it could decrypt — closing the SDP-MITM gap that plain
 * DTLS-SRTP leaves against a malicious signalling server.
 *
 * Two APIs carry those transforms, ONE per engine (mediaTransformApi):
 *  - Chromium's `createEncodedStreams` (Chrome, Edge, the Windows app's
 *    WebView2, the Android WebView): the transforms below, on the page.
 *  - The standard WebRTC Encoded Transform, `RTCRtpScriptTransform`, on every
 *    engine without the first (Firefox, Safari, the iPhone and iPad
 *    home-screen app): the same transforms in a worker (scriptTransform.ts).
 * Both run frameCrypto.ts's functions, so a call can mix the two.
 *
 * Safe rollout: `enabled` is turned on for a peer only once BOTH sides have
 * advertised support (via an SDP attribute), so a new client never sends
 * encrypted frames to a peer that can't decrypt them. If anything is
 * unsupported/unavailable it stays plaintext (transport-only) — never broken.
 */

export { encryptFrame, decryptFrame, type MediaCryptoState, type EncodedFrameLike } from './frameCrypto';

/** Which API runs this engine's frame transforms (see the header). */
export type MediaTransformApi = 'encoded-streams' | 'script-transform';

/** Set once the RTCRtpScriptTransform worker is known not to work here
 *  (scriptTransform.ts): from then on this engine cannot encrypt. */
let scriptTransformUnavailable = false;

/** The worker the standard path needs would not start, or stopped taking
 *  state (scriptTransform.ts calls this; never undone for this page). */
export function noteScriptTransformUnavailable(): void {
    scriptTransformUnavailable = true;
}

/**
 * The frame-transform API this engine uses, or null when it has none.
 *
 * Chromium-family engines that have BOTH keep `createEncodedStreams`: it is
 * the path every Chromium client has always used, and choosing per engine
 * (never per sender) is what guarantees no sender or receiver is handed both.
 * The standard path needs all of it — the constructor, a `transform` slot on
 * senders AND receivers, and workers — or a call would seal one direction and
 * not the other.
 */
export function mediaTransformApi(): MediaTransformApi | null {
    if (typeof RTCRtpSender === 'undefined') return null;
    if ('createEncodedStreams' in RTCRtpSender.prototype) return 'encoded-streams';
    if (!scriptTransformUnavailable
        && typeof RTCRtpScriptTransform === 'function'
        && typeof Worker === 'function'
        && 'transform' in RTCRtpSender.prototype
        && typeof RTCRtpReceiver !== 'undefined' && 'transform' in RTCRtpReceiver.prototype) {
        return 'script-transform';
    }
    return null;
}

/** Can this engine end-to-end encrypt mesh media at all? */
export function isMediaE2eeSupported(): boolean {
    return mediaTransformApi() !== null;
}

/** Tests only: forget that the standard path was found not to work. */
export function __resetScriptTransformAvailability(): void {
    scriptTransformUnavailable = false;
}

export async function importMediaKey(rawKey: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', rawKey as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

type Streams = { readable: ReadableStream<EncodedFrameLike>; writable: WritableStream<EncodedFrameLike> };
type WithStreams = { createEncodedStreams(): Streams };

/** Attach the encrypt transform to a sender (once), through
 *  `createEncodedStreams`. False when it could not be attached. */
export function attachSenderTransform(sender: RTCRtpSender, state: MediaCryptoState): boolean {
    if (!('createEncodedStreams' in sender)) return false;
    try {
        const { readable, writable } = (sender as unknown as WithStreams).createEncodedStreams();
        readable
            .pipeThrough(new TransformStream<EncodedFrameLike, EncodedFrameLike>({
                async transform(frame, controller) {
                    if (await sealOutgoing(frame, state)) controller.enqueue(frame);
                },
            }))
            .pipeTo(writable)
            .catch(() => { /* stream closed */ });
        return true;
    } catch (e) {
        console.warn('[media-e2ee] sender transform attach failed:', e);
        return false;
    }
}

/** Attach the decrypt transform to a receiver (once), through
 *  `createEncodedStreams`. False when it could not be attached. */
export function attachReceiverTransform(receiver: RTCRtpReceiver, state: MediaCryptoState): boolean {
    if (!('createEncodedStreams' in receiver)) return false;
    try {
        const { readable, writable } = (receiver as unknown as WithStreams).createEncodedStreams();
        const dropped = inboundDropLogger();
        readable
            .pipeThrough(new TransformStream<EncodedFrameLike, EncodedFrameLike>({
                async transform(frame, controller) {
                    if (await openIncoming(frame, state)) controller.enqueue(frame);
                    else dropped();
                },
            }))
            .pipeTo(writable)
            .catch(() => { /* stream closed */ });
        return true;
    } catch (e) {
        console.warn('[media-e2ee] receiver transform attach failed:', e);
        return false;
    }
}

/** Video transceivers preferSealableVideoCodecs has already set. */
const vp8First = new WeakSet<RTCRtpTransceiver>();

/**
 * The first codec each video section of an SDP lists, by its mid (null when
 * its first payload type has no rtpmap here).
 */
export function firstVideoCodecByMid(sdp: string): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const section of sdp.split(/\r?\nm=/).slice(1)) {
        if (!section.startsWith('video')) continue;
        const mid = /\r?\na=mid:(\S+)/.exec(section)?.[1];
        if (!mid) continue;
        const pt = section.split(/\r?\n/)[0].trim().split(' ')[3];
        const name = pt ? new RegExp(`\\r?\\na=rtpmap:${pt} ([^/\\s]+)`).exec(section)?.[1] ?? null : null;
        out.set(mid, name);
    }
    return out;
}

/**
 * Put VP8 first in a video transceiver's codec preferences, so the next
 * offer or answer this connection makes lists VP8 first there.
 *
 * The clear header frameCrypto.ts leaves on a video frame is VP8's. Chromium
 * and Firefox offer VP8 first anyway; Safari offers H.264 first, and an H.264
 * link would carry sealed frames the H.264 packetizer cannot split — no video
 * (never plaintext video, but no video).
 *
 * WHO SENDS WHAT, measured (Edge 155 and Firefox 155, an H.264-first offer):
 * the OFFERER sends the first codec of the answer, and the ANSWERER sends the
 * first codec of the OFFER — whatever its own answer says, even an answer
 * listing VP8 alone. So VP8 goes first in our offers (the peer, answering,
 * then sends VP8) and in an answer to an offer that put another codec first
 * (the peer, offering, then sends VP8); what WE send as such an answerer is
 * settled by sendSealableVideoCodec.
 *
 * WHICH TRANSCEIVERS, also measured: Firefox 155, once a transceiver's codecs
 * were negotiated in the OTHER side's payload numbers, writes its next offer
 * for it with feedback lines for those old numbers beside its own new ones
 * after ANY setCodecPreferences — and Chromium refuses that offer whole
 * ("Failed to parse codecs correctly"), so the call stalls into a rebuild
 * the moment the Firefox peer turns on a camera. Preferences on a transceiver
 * that was never negotiated (no mid yet) are kept consistent. Hence:
 *  - before an OFFER (`{ offer: true }`), only transceivers without a mid;
 *  - before an ANSWER (`{ answerTo: offerSdp }`), only those whose section of
 *    the offer does not already list VP8 first — never, between Púca
 *    clients, so a Firefox answerer meets that case only from a peer whose
 *    own pin failed.
 *
 * Reordered, never filtered: rtx, red and FEC stay, and a peer without VP8
 * (none of the engines Púca runs on) still finds a codec in common. Once per
 * transceiver: the preferences stay set, and setting them again is a change
 * an engine may answer with another round of negotiation.
 */
export function preferSealableVideoCodecs(pc: RTCPeerConnection, when: { offer: true } | { answerTo: string }): void {
    if (typeof RTCRtpReceiver === 'undefined' || typeof RTCRtpReceiver.getCapabilities !== 'function') return;
    let codecs: RTCRtpCodec[] | undefined;
    try {
        codecs = RTCRtpReceiver.getCapabilities('video')?.codecs;
    } catch {
        return;
    }
    if (!codecs?.length) return;
    const isVp8 = (c: RTCRtpCodec) => c.mimeType.toLowerCase() === 'video/vp8';
    if (!codecs.some(isVp8)) return;
    const ordered = [...codecs.filter(isVp8), ...codecs.filter(c => !isVp8(c))];
    const offered = 'answerTo' in when ? firstVideoCodecByMid(when.answerTo) : null;
    for (const t of pc.getTransceivers()) {
        if (vp8First.has(t)) continue;
        if (t.receiver.track?.kind !== 'video' || typeof t.setCodecPreferences !== 'function') continue;
        if (offered) {
            const first = t.mid ? offered.get(t.mid) : undefined;
            if (!first || first.toLowerCase() === 'vp8') continue;
        } else if (t.mid !== null) {
            continue;
        }
        try {
            t.setCodecPreferences(ordered);
            vp8First.add(t);
        } catch (e) {
            // A stopped transceiver refuses; one that is about to go needs none.
            console.warn('[media-e2ee] could not put VP8 first on a video transceiver:', e);
        }
    }
}

type EncodingWithCodec = RTCRtpEncodingParameters & { codec?: RTCRtpCodec };

/**
 * After a negotiation: make every video sender on this connection SEND VP8
 * where VP8 was negotiated but is not what it would send by default — the
 * case of an answerer whose offer put another codec first (see
 * preferSealableVideoCodecs: an answer cannot change what its own side
 * sends). Choosing the encoding's codec can: measured in Edge 155 and
 * Firefox 155, an answerer to an H.264-first offer sends VP8 after this.
 * An engine without `encodings[].codec` ignores the member; one whose sender
 * refuses it keeps the default, logged.
 *
 * Nothing to do, and no setParameters, on an ordinary call: there VP8 is
 * already the first codec negotiated.
 */
export async function sendSealableVideoCodec(pc: RTCPeerConnection): Promise<void> {
    for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue;
        let params: RTCRtpSendParameters;
        try {
            params = sender.getParameters();
        } catch {
            continue;
        }
        const isVp8 = (c: { mimeType: string } | undefined) => c?.mimeType.toLowerCase() === 'video/vp8';
        const vp8 = params.codecs?.find(isVp8);
        const encodings = params.encodings as EncodingWithCodec[] | undefined;
        if (!vp8 || !encodings?.length) continue;
        const chosen = (e: EncodingWithCodec) => e.codec ?? params.codecs[0];
        if (encodings.every((e) => isVp8(chosen(e)))) continue;
        for (const e of encodings) e.codec = vp8;
        try {
            await sender.setParameters(params);
        } catch (e) {
            console.warn('[media-e2ee] could not make a video sender use VP8:', e);
        }
    }
}

// --- SDP capability advertisement (no backend change; SDP is relayed opaquely) ---
//
// The attribute carries two values: a per-call EPHEMERAL public key (for forward
// secrecy) and a MAC (mediaReadyTag) that binds that ephemeral under the STATIC
// pairwise media key. The server can't forge the MAC (no static key) or
// cross-inject it (the key is pairwise); producing it proves the sender holds
// the identity-derived key; and because it binds the ephemeral, a server that
// tampers with the ephemeral makes the MAC fail to verify — so E2EE simply
// doesn't enable (transport-only), it never derives a mismatched key that would
// break media. The residual — a server can STRIP the whole attribute and
// downgrade to plaintext — fails safe to the DTLS-SRTP baseline and is
// observable via the caller's enabled state.
const SDP_PREFIX = 'a=sovereign-e2ee:';
const EPH_PREFIX = 'x25519:'; // stripped for SDP transport (':' would break the a= line), re-added on parse
// Encoded as `<tag>|<ephBase64>`; both halves are standard base64, and '|' never
// appears in base64, so the split is unambiguous.
const SDP_RE = /a=sovereign-e2ee:([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)/;

export interface RemoteMediaCap {
    tag: string;
    /** Peer's per-call ephemeral public key, "x25519:"-prefixed (as e2ee expects). */
    ephemeralPubEncoded: string;
}

/** Advertise media-E2EE readiness: a session-level SDP attribute carrying our
 *  ephemeral-binding MAC and our ephemeral public key. No-op unless both are
 *  ready (key derived + ephemeral generated). */
export function advertiseE2ee(sdp: string, tag: string | null, ephemeralPubEncoded: string | null): string {
    if (!tag || !ephemeralPubEncoded || sdp.includes(SDP_PREFIX)) return sdp;
    const ephB64 = ephemeralPubEncoded.startsWith(EPH_PREFIX)
        ? ephemeralPubEncoded.slice(EPH_PREFIX.length)
        : ephemeralPubEncoded;
    const idx = sdp.indexOf('m=');
    if (idx === -1) return sdp;
    return sdp.slice(0, idx) + SDP_PREFIX + tag + '|' + ephB64 + '\r\n' + sdp.slice(idx);
}

// --- DTLS fingerprint pin (every engine, with or without frame encryption) ---
//
// `a=sovereign-dtls:<tag>` where tag = dtlsPinTag(static pairwise key, the
// canonical a=fingerprint of THIS description). A relaying server that
// substitutes the peer connection presents its own certificate, so the
// fingerprint in the SDP it forwards no longer matches the tag it cannot
// re-mint. Absent on older peers: 'unbound' (today's behaviour), never a
// refusal, or the first client to update would stop connecting to everyone.
const DTLS_PREFIX = 'a=sovereign-dtls:';
const DTLS_RE = /a=sovereign-dtls:([A-Za-z0-9+/=]+)/;

export type DtlsPinResult = 'bound' | 'mismatch' | 'unbound';

/** The canonical fingerprint an SDP presents, or null when it presents none
 *  or more than one distinct value (a second fingerprint under another hash
 *  could be the one selected, so disagreement is a mismatch, not a choice). */
export function sdpSoleFingerprint(sdp: string): string | null {
    const fps = sdpFingerprints(sdp);
    if (fps.length === 0 || fps.some(f => f === null)) return null;
    const first = fps[0] as string;
    return fps.every(f => f === first) ? first : null;
}

/** Add the pin for this description's own fingerprint. No-op without the
 *  pairwise key (peer key unresolved) or a fingerprint (a stack without one). */
export function advertiseDtlsPin(sdp: string, rawStaticMediaKey: Uint8Array | null): string {
    if (!rawStaticMediaKey || sdp.includes(DTLS_PREFIX)) return sdp;
    const fp = sdpSoleFingerprint(sdp);
    if (!fp) return sdp;
    const idx = sdp.indexOf('m=');
    if (idx === -1) return sdp;
    return sdp.slice(0, idx) + DTLS_PREFIX + dtlsPinTag(rawStaticMediaKey, fp) + '\r\n' + sdp.slice(idx);
}

/** Verify a remote description's pin against the fingerprint it presents. */
export function verifyDtlsPin(sdp: string, rawStaticMediaKey: Uint8Array): DtlsPinResult {
    const m = DTLS_RE.exec(sdp);
    if (!m) return 'unbound';
    const fp = sdpSoleFingerprint(sdp);
    if (!fp) return 'mismatch';
    return m[1] === dtlsPinTag(rawStaticMediaKey, fp) ? 'bound' : 'mismatch';
}

/** Extract the peer's advertised media capability (tag + ephemeral), or null. */
export function extractE2ee(sdp: string): RemoteMediaCap | null {
    const m = SDP_RE.exec(sdp);
    if (!m) return null;
    return { tag: m[1], ephemeralPubEncoded: EPH_PREFIX + m[2] };
}
