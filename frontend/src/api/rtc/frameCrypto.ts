/**
 * The media frame format: AES-256-GCM over one encoded audio or video frame.
 *
 * This module is the format and nothing else, with no imports, because TWO
 * places run it and they must produce the same bytes:
 *
 *  - the page itself, through Chromium's `createEncodedStreams`
 *    (mediaCrypto.ts attachSenderTransform / attachReceiverTransform), and
 *  - the transform worker, through the standard `RTCRtpScriptTransform` that
 *    Firefox and Safari implement (mediaCrypto.worker.ts).
 *
 * A Chromium peer and a Firefox or Safari peer in one call read each other's
 * frames only because both import these two functions. A second copy of
 * them, however careful, is how the two would drift apart.
 *
 * Frame wire format (encrypted):
 *   [ codec header (unencrypted) | AES-GCM ciphertext | iv(12) | magic(4) ]
 * The codec header (a few leading bytes) is left in the clear so the RTP
 * packetizer and keyframe detection keep working. The trailing magic lets the
 * receiver tell encrypted frames from plaintext ones (mixed-version / pre-cap
 * window), so this is always safe: an unmarked frame passes through untouched.
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
// They are NOT correct for H.264, whose Annex-B NAL layout is unrelated. Only
// browser-produced mesh media passes through here, and a client that seals
// frames makes VP8 the codec of every link: first in what it offers, first in
// an answer to an offer that did not list it first, and chosen for what it
// sends (mediaCrypto.ts preferSealableVideoCodecs, sendSealableVideoCodec) —
// Safari's own default is H.264.
// Anything that starts sealing H.264 needs a codec-aware header length (a
// slice-NAL walk), not a tweaked constant.
const CLEAR_HEADER = { key: 10, delta: 3, audio: 1 } as const;
// 4-byte trailing tag marking an encrypted frame ("SVRN").
const MAGIC = new Uint8Array([0x53, 0x56, 0x52, 0x4e]);
const IV_LEN = 12;
const TRAILER = IV_LEN + MAGIC.length; // iv + magic
const GCM_TAG_LEN = 16; // AES-GCM authentication tag, always appended to the ciphertext
// Smallest frame we could possibly have produced: empty body (tag only) + trailer.
const MIN_ENCRYPTED_LEN = GCM_TAG_LEN + TRAILER;

/** Per-peer, mutable crypto state the attached transforms read on every frame. */
export interface MediaCryptoState {
    key: CryptoKey | null;
    enabled: boolean; // only true once both peers advertised support
    /** Fail-closed mode: when true, media is exchanged ONLY while `enabled`.
     *  Outgoing frames to an unencrypted peer are dropped (never sent as
     *  plaintext) and incoming plaintext frames are dropped (never rendered),
     *  so the server never sees or relays media it could access. */
    requireE2ee: boolean;
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

/**
 * One frame through the SEND side: seal it, or drop it. Both transform paths
 * run exactly this per outgoing frame, so their fail-closed rule cannot
 * differ either: on an error the frame is kept UNLESS enforcement is on — a
 * crypto failure must never fall back to sending plaintext when the user
 * required E2EE.
 */
export async function sealOutgoing(frame: EncodedFrameLike, state: MediaCryptoState): Promise<boolean> {
    try { return await encryptFrame(frame, state); } catch { return !state.requireE2ee; }
}

/** The RECEIVE-side twin of sealOutgoing: open the frame, or drop it. */
export async function openIncoming(frame: EncodedFrameLike, state: MediaCryptoState): Promise<boolean> {
    try { return await decryptFrame(frame, state); } catch { return !state.requireE2ee; }
}

/**
 * Counts inbound frames a transform dropped, and says so on the first and
 * then every 250th. A decrypt failure (or an enforced-plaintext block) used to
 * be 100% silent, which made "arrives but plays as silence" undiagnosable from
 * the console. Counts only — no key material.
 */
export function inboundDropLogger(): () => void {
    let drops = 0;
    return () => {
        if (++drops === 1 || drops % 250 === 0) {
            console.warn(`[media-e2ee] dropped ${drops} inbound frame(s) (undecryptable or plaintext while E2EE required)`);
        }
    };
}
