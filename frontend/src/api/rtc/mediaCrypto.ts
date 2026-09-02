import { sdpFingerprints } from '../dtlsFingerprint';
import { dtlsPinTag } from '../e2ee';
/**
 * End-to-end encryption for WebRTC media (voice + screen share).
 *
 * Mesh WebRTC is pairwise, so each peer connection encrypts frames under a key
 * derived from the two users' identity keys (see e2ee.deriveMediaKey). Frames
 * are encrypted with AES-256-GCM via the Insertable Streams API
 * (`RTCRtpSender/Receiver.createEncodedStreams`), so the media never reaches the
 * server (or a TURN relay) in a form it could decrypt — closing the SDP-MITM gap
 * that plain DTLS-SRTP leaves against a malicious signalling server.
 *
 * Frame wire format (encrypted):
 *   [ codec header (unencrypted) | AES-GCM ciphertext | iv(12) | magic(4) ]
 * The codec header (a few leading bytes) is left in the clear so the RTP
 * packetizer and keyframe detection keep working. The trailing magic lets the
 * receiver tell encrypted frames from plaintext ones (mixed-version / pre-cap
 * window), so this is always safe: an unmarked frame passes through untouched.
 *
 * Safe rollout: `enabled` is turned on for a peer only once BOTH sides have
 * advertised support (via an SDP attribute), so a new client never sends
 * encrypted frames to a peer that can't decrypt them. If anything is
 * unsupported/unavailable it stays plaintext (transport-only) — never broken.
 */

// Leading bytes left unencrypted, per the WebRTC insertable-streams E2EE
// reference: video keyframe=10, delta=3, audio=1. Preserves packetization.
//
// NAME THE CODEC, because the numbers are not generic: these are the **VP8**
// uncompressed data chunk sizes (RFC 6386 §9.1 — 3-byte frame tag + 3-byte
// start code 9d 01 2a + 2-byte width + 2-byte height for a keyframe; the frame
// tag alone for an interframe) and the **Opus** TOC byte (RFC 6716 §3.1). They
// are where the entropy-coded partition begins.
//
// They are NOT correct for H.264, whose Annex-B NAL layout is unrelated. Today
// only browser-produced mesh media passes through here and Chrome offers VP8
// first, so this holds — but anything that starts sealing H.264 needs a
// codec-aware header length (a slice-NAL walk), not a tweaked constant.
const CLEAR_HEADER = { key: 10, delta: 3, audio: 1 } as const;
// 4-byte trailing tag marking an encrypted frame ("SVRN").
const MAGIC = new Uint8Array([0x53, 0x56, 0x52, 0x4e]);
const IV_LEN = 12;
const TRAILER = IV_LEN + MAGIC.length; // iv + magic
const GCM_TAG_LEN = 16; // AES-GCM authentication tag, always appended to the ciphertext
// Smallest frame we could possibly have produced: empty body (tag only) + trailer.
const MIN_ENCRYPTED_LEN = GCM_TAG_LEN + TRAILER;

/** Per-peer, mutable crypto state shared with the attached transforms. */
export interface MediaCryptoState {
    key: CryptoKey | null;
    enabled: boolean; // only true once both peers advertised support
    /** Fail-closed mode: when true, media is exchanged ONLY while `enabled`.
     *  Outgoing frames to an unencrypted peer are dropped (never sent as
     *  plaintext) and incoming plaintext frames are dropped (never rendered),
     *  so the server never sees or relays media it could access. */
    requireE2ee: boolean;
}

export function isMediaE2eeSupported(): boolean {
    return typeof RTCRtpSender !== 'undefined' &&
        'createEncodedStreams' in RTCRtpSender.prototype;
}

export async function importMediaKey(rawKey: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', rawKey as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export interface EncodedFrameLike {
    data: ArrayBuffer;
    type?: 'key' | 'delta'; // present for video; absent for audio
}

function clearHeaderLen(frame: EncodedFrameLike): number {
    if (frame.type === 'key') return CLEAR_HEADER.key;
    if (frame.type === 'delta') return CLEAR_HEADER.delta;
    return CLEAR_HEADER.audio;
}

function endsWithMagic(data: Uint8Array): boolean {
    if (data.length < TRAILER) return false;
    const off = data.length - MAGIC.length;
    for (let i = 0; i < MAGIC.length; i++) if (data[off + i] !== MAGIC[i]) return false;
    return true;
}

/** Returns false when the outgoing frame should be DROPPED (require-E2EE is on
 *  but encryption isn't active for this peer — never emit plaintext media). */
export async function encryptFrame(frame: EncodedFrameLike, state: MediaCryptoState): Promise<boolean> {
    if (!state.enabled || !state.key) {
        // Fail-closed: drop rather than transmit plaintext to an unencrypted peer.
        return !state.requireE2ee; // passthrough (true) unless enforcement is on
    }
    const data = new Uint8Array(frame.data);
    const n = Math.min(clearHeaderLen(frame), data.length);
    const header = data.subarray(0, n);
    const body = data.subarray(n);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    // Bind the clear codec header as AAD so the server can't tamper with it undetected.
    const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: header as BufferSource },
        state.key, body as BufferSource,
    ));
    const out = new Uint8Array(n + ct.length + TRAILER);
    out.set(header, 0);
    out.set(ct, n);
    out.set(iv, n + ct.length);
    out.set(MAGIC, n + ct.length + IV_LEN);
    frame.data = out.buffer;
    return true;
}

/** Returns false when the frame should be DROPPED (marked but undecryptable,
 *  or plaintext arriving while require-E2EE is on). */
export async function decryptFrame(frame: EncodedFrameLike, state: MediaCryptoState): Promise<boolean> {
    const data = new Uint8Array(frame.data);
    // Not (or not yet) an encrypted frame. Normally pass through; under
    // enforcement, drop it so no plaintext media from the server is ever
    // rendered.
    if (!state.enabled || !state.key || !endsWithMagic(data)) return !state.requireE2ee;
    // Too short to be something WE produced (our smallest output is an empty
    // body: tag + trailer), so it is plaintext that merely happens to end in the
    // magic. Treat it exactly like any other unmarked frame — which means
    // enforcement still drops it rather than rendering plaintext.
    if (data.length < MIN_ENCRYPTED_LEN) return !state.requireE2ee;
    // Recover the header length the SENDER used. encryptFrame clamps it by the
    // PLAINTEXT length (`Math.min(headerLen, data.length)`), so a frame shorter
    // than its own clear header keeps a shorter header. Clamping by the
    // CIPHERTEXT length here instead would pick the full headerLen, mis-split
    // header/ciphertext, and fail authentication — such frames encrypted fine
    // and could never be decrypted. Plaintext length is exactly
    // `data.length - GCM_TAG_LEN - TRAILER`.
    const plaintextLen = data.length - GCM_TAG_LEN - TRAILER;
    const n = Math.min(clearHeaderLen(frame), plaintextLen);
    const header = data.subarray(0, n);
    const ivStart = data.length - TRAILER;
    const iv = data.subarray(ivStart, ivStart + IV_LEN);
    const ct = data.subarray(n, ivStart);
    try {
        const body = new Uint8Array(await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv as BufferSource, additionalData: header as BufferSource },
            state.key, ct as BufferSource,
        ));
        const out = new Uint8Array(n + body.length);
        out.set(header, 0);
        out.set(body, n);
        frame.data = out.buffer;
        return true;
    } catch {
        return false; // authentication failed → drop (never feed garbage to the decoder)
    }
}

type Streams = { readable: ReadableStream<EncodedFrameLike>; writable: WritableStream<EncodedFrameLike> };
type WithStreams = { createEncodedStreams(): Streams };

/** Attach the encrypt transform to a sender (once). No-op if unsupported. */
export function attachSenderTransform(sender: RTCRtpSender, state: MediaCryptoState): void {
    if (!('createEncodedStreams' in sender)) return;
    try {
        const { readable, writable } = (sender as unknown as WithStreams).createEncodedStreams();
        readable
            .pipeThrough(new TransformStream<EncodedFrameLike, EncodedFrameLike>({
                async transform(frame, controller) {
                    let keep = true;
                    // On error, keep the frame UNLESS enforcement is on — a
                    // crypto failure must never fall back to sending plaintext
                    // when the user required E2EE.
                    try { keep = await encryptFrame(frame, state); } catch { keep = !state.requireE2ee; }
                    if (keep) controller.enqueue(frame);
                },
            }))
            .pipeTo(writable)
            .catch(() => { /* stream closed */ });
    } catch (e) {
        console.warn('[media-e2ee] sender transform attach failed:', e);
    }
}

/** Attach the decrypt transform to a receiver (once). No-op if unsupported. */
export function attachReceiverTransform(receiver: RTCRtpReceiver, state: MediaCryptoState): void {
    if (!('createEncodedStreams' in receiver)) return;
    try {
        const { readable, writable } = (receiver as unknown as WithStreams).createEncodedStreams();
        // Dropped-frame counter: a decrypt failure (or enforced-plaintext block)
        // used to be 100% silent, which made "arrives but plays as silence"
        // undiagnosable from the console. Counts only — no key material.
        let drops = 0;
        readable
            .pipeThrough(new TransformStream<EncodedFrameLike, EncodedFrameLike>({
                async transform(frame, controller) {
                    let keep = true;
                    try { keep = await decryptFrame(frame, state); } catch { keep = !state.requireE2ee; }
                    if (keep) {
                        controller.enqueue(frame);
                    } else if (++drops === 1 || drops % 250 === 0) {
                        console.warn(`[media-e2ee] dropped ${drops} inbound frame(s) (undecryptable or plaintext while E2EE required)`);
                    }
                },
            }))
            .pipeTo(writable)
            .catch(() => { /* stream closed */ });
    } catch (e) {
        console.warn('[media-e2ee] receiver transform attach failed:', e);
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
