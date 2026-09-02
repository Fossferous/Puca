/**
 * The `sovereign-clip:` reference — how a posted clip is written into an E2EE
 * message body. PURE (no browser APIs beyond atob/btoa).
 *
 *     [Clip 2:04](sovereign-clip:v1?<base64url(packed manifest)>)
 *
 * PACKED BINARY, NOT JSON. The binding cap is the markdown link parser's
 * 2048-character href (utils/messageParser.ts), not the 8000-byte message
 * limit: a JSON manifest with 40 UUID strings already overflows it and the
 * link silently degrades to plain text. Layout (big-endian):
 *
 *   off  len   field
 *     0    1   version = 1
 *     1    1   flags — bit0: audio codec (0 = mp4a.40.2, 1 = opus); bits1-7 reserved 0
 *     2   32   clip content key
 *    34    8   nonce prefix
 *    42    4   durationMs        u32
 *    46    2   width             u16
 *    48    2   height            u16
 *    50    4   totalCipherBytes  u32
 *    54    1   partCount (1..64) — INCLUDING the init part at index 0
 *    55   16   clipId (raw UUID bytes) — the part AAD (see clipCrypto.ts)
 *    71    3   AVC profile_idc, constraint flags, level_idc — the encoder's
 *              ACTUAL codec string (e.g. avc1.640029), which differs from the
 *              requested one and is what MSE must be told
 *    74   16n  part file ids (raw UUID bytes), index order
 *  74+16n  2n  part durations, units of 10 ms, u16 (init part = 0)
 *
 * 64 parts ⇒ 74 + 18·64 = 1226 bytes ⇒ 1635 base64url chars + 18 for the
 * prefix = 1653 < 2048. MAX_CLIP_PARTS = 64 leaves margin; at 24 MiB per part
 * that is 1.5 GiB — never the binding constraint.
 *
 * The key is IN the ref, i.e. in the message body — exactly like
 * `sovereign-enc:`. Whoever can decrypt the message can decrypt the clip,
 * forever. The approval gate is about POSTING, not about revocation.
 */
import { bytesToUuid, uuidToBytes } from './clipCrypto';

export const CLIP_PREFIX = 'sovereign-clip:v1?';
export const CLIP_SCHEME = 'sovereign-clip';
export const MAX_CLIP_PARTS = 64;
export const CLIP_MANIFEST_VERSION = 1;
const HEADER_BYTES = 74;
const PER_PART_BYTES = 18;
/** Hard cap from utils/messageParser.ts's link regex — verified there. */
export const MAX_HREF_CHARS = 2048;

export type ClipAudioCodec = 'mp4a.40.2' | 'opus';

export interface ClipManifest {
    key: Uint8Array;          // 32
    noncePrefix: Uint8Array;  // 8
    clipId: string;           // UUID string
    /** e.g. 'avc1.640029' — the encoder's reported decoderConfig.codec. */
    videoCodec: string;
    audioCodec: ClipAudioCodec;
    durationMs: number;
    width: number;
    height: number;
    totalCipherBytes: number;
    /** File ids in index order; [0] is the init segment. */
    parts: string[];
    /** Per-part durations in ms (10 ms granularity); [0] is 0. */
    partDurMs: number[];
}

export function isClipRef(href: string | null | undefined): boolean {
    // Case-INSENSITIVE on the prefix, deliberately. URL schemes are
    // case-insensitive and `utils/messageParser.ts`'s isSafeUrl lowercases
    // before consulting its allowlist, so a case-sensitive test here let
    // `SOVEREIGN-CLIP:v1?<manifest>` be judged safe, miss this recogniser, and
    // be emitted as a live <a href> carrying the clip key. (docs/CLIPS.md)
    return typeof href === 'string' && href.slice(0, CLIP_PREFIX.length).toLowerCase() === CLIP_PREFIX;
}

/** Does this message body carry a clip ref anywhere? (Forward is refused for
 *  such a message: the body carries the clip key — docs/CLIPS.md.) */
export function hasClipRef(content: string | null | undefined): boolean {
    return typeof content === 'string' && content.toLowerCase().includes(CLIP_PREFIX);
}

/** A clip ref whose manifest was scrubbed (Copy Text / Quote — see
 *  contextMenuUtils.stripAttachmentKeys): renders as "clip removed", never as a link. */
export function isScrubbedClipRef(href: string | null | undefined): boolean {
    return typeof href === 'string' && href.toLowerCase() === 'sovereign-clip:v1';
}

function b64urlEncode(u8: Uint8Array): string {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    try {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

/** 'avc1.PPCCLL' → 3 bytes; anything else throws (only H.264 is ever muxed). */
export function avcBytes(codec: string): Uint8Array {
    const mt = /^avc[13]\.([0-9a-fA-F]{6})$/.exec(codec);
    if (!mt) throw new Error('not an avc1 codec string: ' + codec);
    const h = mt[1];
    return new Uint8Array([parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);
}
export function avcString(b: Uint8Array): string {
    return 'avc1.' + Array.from(b.subarray(0, 3), x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Throws on a manifest that cannot be represented (too many parts, bad sizes). */
export function encodeClipRef(m: ClipManifest): string {
    const n = m.parts.length;
    if (n < 1 || n > MAX_CLIP_PARTS) throw new Error(`part count ${n} out of range 1..${MAX_CLIP_PARTS}`);
    if (m.partDurMs.length !== n) throw new Error('partDurMs length must equal parts length');
    if (m.key.byteLength !== 32 || m.noncePrefix.byteLength !== 8) throw new Error('bad secret lengths');
    if (!(m.durationMs >= 0 && m.durationMs <= 0xffffffff)) throw new Error('bad duration');
    if (!(m.width >= 0 && m.width <= 0xffff && m.height >= 0 && m.height <= 0xffff)) throw new Error('bad geometry');
    if (!(m.totalCipherBytes >= 0 && m.totalCipherBytes <= 0xffffffff)) throw new Error('bad size');
    const buf = new Uint8Array(HEADER_BYTES + PER_PART_BYTES * n);
    const dv = new DataView(buf.buffer);
    buf[0] = CLIP_MANIFEST_VERSION;
    buf[1] = m.audioCodec === 'opus' ? 1 : 0;
    buf.set(m.key, 2);
    buf.set(m.noncePrefix, 34);
    dv.setUint32(42, Math.round(m.durationMs));
    dv.setUint16(46, m.width);
    dv.setUint16(48, m.height);
    dv.setUint32(50, m.totalCipherBytes);
    buf[54] = n;
    buf.set(uuidToBytes(m.clipId), 55);
    buf.set(avcBytes(m.videoCodec), 71);
    let off = HEADER_BYTES;
    for (const id of m.parts) { buf.set(uuidToBytes(id), off); off += 16; }
    for (const d of m.partDurMs) {
        const units = Math.min(0xffff, Math.max(0, Math.round(d / 10)));
        dv.setUint16(off, units); off += 2;
    }
    const href = CLIP_PREFIX + b64urlEncode(buf);
    if (href.length > MAX_HREF_CHARS) throw new Error(`clip ref is ${href.length} chars; the message parser caps hrefs at ${MAX_HREF_CHARS}`);
    return href;
}

/** null on ANY structural violation (version, length, count, uuid) — never throws. */
export function decodeClipRef(href: string): ClipManifest | null {
    if (!isClipRef(href) || href.length > MAX_HREF_CHARS) return null;
    const buf = b64urlDecode(href.slice(CLIP_PREFIX.length));
    if (!buf || buf.byteLength < HEADER_BYTES) return null;
    if (buf[0] !== CLIP_MANIFEST_VERSION) return null;
    if ((buf[1] & 0xfe) !== 0) return null;
    const n = buf[54];
    if (n < 1 || n > MAX_CLIP_PARTS) return null;
    if (buf.byteLength !== HEADER_BYTES + PER_PART_BYTES * n) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    try {
        const parts: string[] = [];
        let off = HEADER_BYTES;
        for (let i = 0; i < n; i++) { parts.push(bytesToUuid(buf.slice(off, off + 16))); off += 16; }
        const partDurMs: number[] = [];
        for (let i = 0; i < n; i++) { partDurMs.push(dv.getUint16(off) * 10); off += 2; }
        return {
            key: buf.slice(2, 34),
            noncePrefix: buf.slice(34, 42),
            clipId: bytesToUuid(buf.slice(55, 71)),
            videoCodec: avcString(buf.slice(71, 74)),
            audioCodec: (buf[1] & 1) ? 'opus' : 'mp4a.40.2',
            durationMs: dv.getUint32(42),
            width: dv.getUint16(46),
            height: dv.getUint16(48),
            totalCipherBytes: dv.getUint32(50),
            parts,
            partDurMs,
        };
    } catch {
        return null;
    }
}

/** Map a playback time to the part index that contains it (init part excluded). */
export function partIndexForTime(m: ClipManifest, timeMs: number): number {
    let acc = 0;
    for (let i = 1; i < m.parts.length; i++) {
        acc += m.partDurMs[i];
        if (timeMs < acc) return i;
    }
    return m.parts.length - 1;
}

/** Start time (ms) of a part in the clip timeline. */
export function partStartMs(m: ClipManifest, index: number): number {
    let acc = 0;
    for (let i = 1; i < index && i < m.parts.length; i++) acc += m.partDurMs[i];
    return acc;
}


/** Human label used as the link text: `Clip 2:04`. */
export function clipLabel(durationMs: number): string {
    const s = Math.round(durationMs / 1000);
    const m = Math.floor(s / 60);
    return `Clip ${m}:${String(s % 60).padStart(2, '0')}`;
}
