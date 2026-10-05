/**
 * Makes a downloaded Púca Clip a file every player understands — its
 * duration, and a seek index — WITHOUT re-encoding or moving a single media
 * byte. The desktop and web twin of the Android app's
 * `android/app/src/main/java/com/sovereign/app/Fmp4SaveFix.java` +
 * `ClipAssembler.java`: for the same decrypted parts and the same manifest
 * duration the two produce BYTE-IDENTICAL files, which the shared vectors
 * (`android/app/src/test/resources/download-vectors.json`, `saveFix`) check
 * from both sides — `downloadVectors.test.ts` here, `DownloadVectorsTest`
 * in JUnit. Change one, change the other, regenerate the vectors.
 *
 * WHY. A clip is fragmented MP4 straight out of the desktop muxer
 * (mediabunny, `fastStart: 'fragmented'`): the init is written before the
 * length is known, so mvhd/tkhd/mdhd carry duration 0 and there is no
 * `mvex/mehd`; the only index is an `mfra` at the very end. Measured on
 * Windows 11 (2026-10-05): Explorer's Length column, the file's Properties
 * and anything else reading the shell's System.Media.Duration show NOTHING
 * for such a file (they read the moov), while Media Foundation and ffmpeg
 * find the length and seek through the fragments and the mfra.
 *
 * WHAT CHANGES, and nothing else:
 *  1. `mehd` is inserted as the first child of `mvex` (moov and mvex grow by
 *     its size).
 *  2. A region is reserved right before the first `moof`: `free` while the
 *     parts go past, then `free + sidx`, one reference per video fragment,
 *     ending exactly at the first `moof` (first_offset 0).
 *  3. The real durations — read from the fragments themselves (`tfdt` + the
 *     `trun` sample durations) — go into mvhd, every tkhd, every mdhd and the
 *     new mehd.
 *  4. Every absolute offset after the insertion moves by the same amount, so
 *     each `tfra` moof_offset (and a `tfhd` base_data_offset, which mediabunny
 *     never writes) is rewritten to match. An `mfra` whose entries do not all
 *     point at a `moof` this pass saw becomes a `free` box: no index is better
 *     than a wrong one.
 * Fragments, samples and their bytes are untouched (default-base-is-moof makes
 * every trun data_offset relative), so removing exactly these changes gives
 * back the original file byte for byte — the tests check that.
 *
 * MEMORY. The desktop and web download already hold every decrypted part;
 * ClipAssembler keeps those very arrays as the output (only the init is a new
 * array: the original init, the mehd and the reserved index, ~6 KB for a 2:00
 * clip and at most ~0.8 MB for the longest manifest) and writes the patches
 * INTO them, so the clip is never copied to be fixed. The scan keeps one
 * moof/mfra at a time (at most 8 MiB). Measured in Edge on a 129 MB clip: the
 * whole fix ~1 ms of main thread.
 *
 * HOSTILE INPUT. A clip is written by whoever posted it, so every count in it
 * is the sender's. The limits are the Java file's, number for number (see its
 * class comment for what each one stopped): a container holds at most
 * MAX_CHILDREN boxes, a run with no per-sample fields is `count x default`
 * with no loop, more than MAX_TRUN_SAMPLES in one run is not understood, and
 * the scan keeps at most MAX_MOOFS fragment starts and MAX_PATCHES patches,
 * past which it stops reading boxes. Giving up costs the fix (the duration
 * then comes from the manifest, with no seek index), never the save.
 *
 * NUMBERS. Java's `long` wraps at 64 bits and `Math.addExact` throws there;
 * this file does the same with BigInt wherever a sender's value can get that
 * far (tfdt, durations x timescales), and both sides check a 64-bit box size
 * against the room left rather than adding it to an offset, so every shared
 * vector, the crafted ones included, gives the same bytes here as on the
 * phone. Track ids are kept as a signed 32-bit `int`, as Java keeps them, for
 * the same reason.
 *
 * Pure: no I/O, no Blob, nothing written (api/clips may not reach a file API —
 * clipNoDiskWrite.test.ts). api/clips/clipPlayback.ts's downloadClipBytes
 * drives it for the Download button on desktop and the web.
 */

/** Most boxes one container (or part 0 before its first moof) may hold before it counts as malformed. */
export const MAX_CHILDREN = 1024;
/** Room for this many sidx references is reserved per clip second (the muxer cuts at most one fragment per second). */
export const REFS_PER_SECOND = 4;
const SIDX_FIXED = 40; // v1 header through reference_count
const SIDX_PER_REF = 12;
/** A moof or mfra larger than this is not read (a real one is KB). */
const CAPTURE_MAX = 8 * 1024 * 1024;
/** Fragment starts kept to check the mfra against. */
export const MAX_MOOFS = 1 << 16;
/** Patches gathered while the parts go past (tfhd base offsets, tfra entries, retired mfra boxes). */
export const MAX_PATCHES = 1 << 16;
/** Samples one trun may declare; a fragment is about a second. */
export const MAX_TRUN_SAMPLES = 1 << 20;

const fourcc = (s: string) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
const MOOF = fourcc('moof'), MDAT = fourcc('mdat'), MFRA = fourcc('mfra'), MFRO = fourcc('mfro');
const MOOV = fourcc('moov'), MVHD = fourcc('mvhd'), MVEX = fourcc('mvex'), MEHD = fourcc('mehd'), TREX = fourcc('trex');
const TRAK = fourcc('trak'), TKHD = fourcc('tkhd'), MDIA = fourcc('mdia'), MDHD = fourcc('mdhd'), HDLR = fourcc('hdlr');
const MINF = fourcc('minf'), STBL = fourcc('stbl'), STCO = fourcc('stco'), CO64 = fourcc('co64'), STSZ = fourcc('stsz');
const TRAF = fourcc('traf'), TFHD = fourcc('tfhd'), TFDT = fourcc('tfdt'), TRUN = fourcc('trun'), TFRA = fourcc('tfra');
const VIDE = fourcc('vide'), FTYP = fourcc('ftyp'), SIDX = fourcc('sidx'), SSIX = fourcc('ssix');
const FREE_BYTES = Uint8Array.of(0x66, 0x72, 0x65, 0x65); // "free"

/** Bytes to write at an absolute output offset once every part is out. */
export interface Patch { offset: number; bytes: Uint8Array }

interface Track {
    /** Java's `int`: a track id of 2^31 or more is NEGATIVE here, as it is there. */
    id: number;
    timescale: number;
    video: boolean;
    /** Output offsets of the duration fields, and their widths (4 or 8). */
    tkhdDurOff: number; tkhdDurSize: number;
    mdhdDurOff: number; mdhdDurSize: number;
    trexDefaultDuration: number;
    trexDefaultFlags: number;
}

/** What prepareInit decided, for the scanner and the final patches. */
export interface Plan {
    /** The fixed init: the original with mehd inserted, then the reservation. */
    init: Uint8Array;
    /** Bytes of part 0 the init covers; the rest of part 0 (if any) is media. */
    consumed: number;
    /** Output offset minus input offset for everything after the init. */
    shift: number;
    movieTimescale: number;
    mvhdDurOff: number; mvhdDurSize: number;
    mehdDurOff: number; mehdDurSize: number;
    reserveOff: number; reserveLen: number; maxRefs: number;
    tracks: Track[];
    ref: Track;
}

// ---- numbers and bytes --------------------------------------------------------

const u32 = (b: Uint8Array, o: number): number => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
/** Java's `u64`: eight bytes read as a SIGNED long. */
const s64 = (b: Uint8Array, o: number): bigint => BigInt.asIntN(64, (BigInt(u32(b, o)) << 32n) | BigInt(u32(b, o + 4)));
/** Java's long arithmetic: wraps at 64 bits. */
const wrap = (v: bigint): bigint => BigInt.asIntN(64, v);
const LONG_MAX = (1n << 63n) - 1n;

/** Java's Math.addExact on longs (both operands are non-negative here). */
class Overflow extends Error {}
function addExact(a: bigint, b: bigint): bigint {
    const r = a + b;
    if (r > LONG_MAX || r < -LONG_MAX - 1n) throw new Overflow();
    return r;
}

function put32(b: Uint8Array, o: number, v: number): void {
    const x = v >>> 0; // the low 32 bits, as Java's (byte) casts keep them
    b[o] = x >>> 24; b[o + 1] = (x >>> 16) & 0xff; b[o + 2] = (x >>> 8) & 0xff; b[o + 3] = x & 0xff;
}

function put64(b: Uint8Array, o: number, v: bigint): void {
    const x = BigInt.asUintN(64, v);
    put32(b, o, Number(x >> 32n));
    put32(b, o + 4, Number(x & 0xffffffffn));
}

function field(v: bigint, size: number): Uint8Array {
    const out = new Uint8Array(size);
    if (size === 8) put64(out, 0, v);
    else put32(out, 0, Number(BigInt.asUintN(32, v)));
    return out;
}

/** A box inside b[from..to): start, header length, total size, type. */
interface Box { start: number; hdr: number; size: number; type: number }
const body = (x: Box) => x.start + x.hdr;
const end = (x: Box) => x.start + x.size;

/**
 * The boxes in b[from..to); null if one is malformed or overruns, or there
 * are more than MAX_CHILDREN.
 */
export function children(b: Uint8Array, from: number, to: number): Box[] | null {
    const out: Box[] = [];
    let off = from;
    while (off < to) {
        if (off + 8 > to || out.length >= MAX_CHILDREN) return null;
        let size = u32(b, off);
        let hdr = 8;
        if (size === 1) {
            if (off + 16 > to) return null;
            const big = s64(b, off + 8);
            if (big < 16n || big > BigInt(to - off)) return null;
            size = Number(big);
            hdr = 16;
        } else if (size === 0) {
            return null; // "to the end of the file": not inside an init or a moof
        }
        if (size < hdr || off + size > to) return null;
        out.push({ start: off, hdr, size, type: u32(b, off + 4) });
        off += size;
    }
    return out;
}

const find = (boxes: Box[], type: number): Box | null => boxes.find((x) => x.type === type) ?? null;

// ---- which files get the fix ----------------------------------------------------

/**
 * ISO BMFF brands the Android save files as something OTHER than MP4
 * (SaveTarget.java's sniff: QuickTime, HEIF/AVIF images, 3GPP, Canon raw),
 * and so never fixes. Mirrored, so the same part 0 is fixed on both sides
 * or on neither.
 */
const NOT_MP4_BRANDS = new Set(['qt  ', 'heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis', '3gp4', '3gp5', '3gp6', '3gg6', '3ge6', 'crx ']);

/** Would the Android save call these bytes an MP4 (video/mp4 or audio/mp4)? */
export function savesAsMp4(part0: Uint8Array): boolean {
    if (part0.length < 12 || u32(part0, 4) !== FTYP) return false;
    return !NOT_MP4_BRANDS.has(String.fromCharCode(part0[8], part0[9], part0[10], part0[11]));
}

// ---- the init -----------------------------------------------------------------

/** Output offset of input offset `at` inside the init. */
const out = (at: number, insertAt: number, mehdLen: number) => (at >= insertAt ? at + mehdLen : at);

/**
 * Top-level boxes of part 0 up to (not including) the first moof; null when
 * one before it is malformed or does not end inside part 0, or there are more
 * than MAX_CHILDREN.
 */
function topLevelBeforeMoof(b: Uint8Array): Box[] | null {
    const outBoxes: Box[] = [];
    const len = b.length;
    let off = 0;
    while (off < len) {
        if (off + 8 > len || outBoxes.length >= MAX_CHILDREN) return null;
        const t = u32(b, off + 4);
        if (t === MOOF) break;
        let size = u32(b, off);
        let hdr = 8;
        if (size === 1) {
            if (off + 16 > len) return null;
            const big = s64(b, off + 8);
            if (big < 16n || big > BigInt(len - off)) return null;
            size = Number(big);
            hdr = 16;
        }
        if (size < hdr || off + size > len) return null;
        outBoxes.push({ start: off, hdr, size, type: t });
        off += size;
    }
    return outBoxes;
}

function parseTrak(b: Uint8Array, trak: Box, insertAt: number, mehdLen: number): Track | null {
    const tk = children(b, body(trak), end(trak));
    if (!tk) return null;
    const tkhd = find(tk, TKHD), mdia = find(tk, MDIA);
    // Every size check comes before the version byte is read: an 8-byte box at
    // the very end of part 0 has no version byte (Java would read past the array).
    if (!tkhd || !mdia || tkhd.size < 32) return null;
    const tv = b[tkhd.start + 8];
    if (tv > 1 || tkhd.size < (tv === 1 ? 44 : 32)) return null;
    const md = children(b, body(mdia), end(mdia));
    if (!md) return null;
    const mdhd = find(md, MDHD), hdlr = find(md, HDLR), minf = find(md, MINF);
    if (!mdhd || !hdlr || hdlr.size < 20 || mdhd.size < 32) return null;
    const mv = b[mdhd.start + 8];
    if (mv > 1 || mdhd.size < (mv === 1 ? 44 : 32)) return null;
    const timescale = u32(b, mdhd.start + (mv === 1 ? 28 : 20));
    if (timescale === 0) return null;
    // A fragmented init carries no samples and no chunk offsets. If this one
    // does, its offsets would need moving too: leave the file alone.
    if (minf) {
        const mi = children(b, body(minf), end(minf));
        if (!mi) return null;
        const stbl = find(mi, STBL);
        if (stbl) {
            const st = children(b, body(stbl), end(stbl));
            if (!st) return null;
            for (const s of st) {
                if ((s.type === STCO || s.type === CO64) && (s.size < 16 || u32(b, s.start + 12) !== 0)) return null;
                if (s.type === STSZ && (s.size < 20 || u32(b, s.start + 16) !== 0)) return null;
            }
        }
    }
    return {
        id: u32(b, tkhd.start + (tv === 1 ? 28 : 20)) | 0,
        timescale,
        video: u32(b, hdlr.start + 16) === VIDE,
        tkhdDurSize: tv === 1 ? 8 : 4,
        tkhdDurOff: out(tkhd.start + (tv === 1 ? 36 : 28), insertAt, mehdLen),
        mdhdDurSize: mv === 1 ? 8 : 4,
        mdhdDurOff: out(mdhd.start + (mv === 1 ? 32 : 24), insertAt, mehdLen),
        trexDefaultDuration: 0,
        trexDefaultFlags: 0,
    };
}

/**
 * A manifest duration as the Java side receives it: a whole, non-negative
 * number of ms. The manifest carries it as a u32 (clipRef.ts), and both sides
 * are handed that same value, so nothing past 2^32 ever arrives here.
 */
function hintOf(durationHintMs: number): number {
    const n = Math.trunc(Number(durationHintMs));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Prepare the init segment of a clip: `part0` is the first decrypted part.
 * null = do not touch this file (it is saved as sealed).
 */
export function prepareInit(part0: Uint8Array, durationHintMs: number): Plan | null {
    const top = topLevelBeforeMoof(part0);
    if (!top) return null;
    // An index already in front of the media (another muxer's sidx, or the
    // ssix that goes with one) counts its offsets from where it ends: the
    // region reserved below would land inside what it points at, and ffmpeg
    // follows a leading sidx. No index is better than a wrong one: leave such
    // a file alone.
    if (find(top, SIDX) || find(top, SSIX)) return null;
    const initEnd = top.length === 0 ? 0 : end(top[top.length - 1]);
    const moov = find(top, MOOV);
    if (!moov || moov.hdr !== 8) return null;
    const mk = children(part0, body(moov), end(moov));
    if (!mk) return null;
    const mvhd = find(mk, MVHD), mvex = find(mk, MVEX);
    if (!mvhd || !mvex || mvex.hdr !== 8 || mvhd.size < 28) return null;
    const xk = children(part0, body(mvex), end(mvex));
    if (!xk || find(xk, MEHD)) return null;

    const mvhdVer = part0[mvhd.start + 8];
    if (mvhdVer > 1 || mvhd.size < (mvhdVer === 1 ? 40 : 28)) return null;
    const movieTimescale = u32(part0, mvhd.start + (mvhdVer === 1 ? 28 : 20));
    if (movieTimescale === 0) return null;
    const mvhdDurIn = mvhd.start + (mvhdVer === 1 ? 32 : 24);

    // mehd goes first in mvex; everything at or after this input offset moves.
    const insertAt = body(mvex);
    const mehdLen = mvhdVer === 1 ? 20 : 16;

    const tracks: Track[] = [];
    const byId = new Map<number, Track>();
    for (const t of mk) {
        if (t.type !== TRAK) continue;
        const tr = parseTrak(part0, t, insertAt, mehdLen);
        if (!tr) return null;
        tracks.push(tr);
        byId.set(tr.id, tr);
    }
    if (tracks.length === 0) return null;
    for (const x of xk) {
        if (x.type !== TREX || x.size < 32) continue;
        // keyed by the UNSIGNED id, looked up among signed ones: Java's (long) int vs u32
        const tr = byId.get(u32(part0, x.start + 12));
        if (!tr) continue;
        tr.trexDefaultDuration = u32(part0, x.start + 20);
        tr.trexDefaultFlags = u32(part0, x.start + 28);
    }
    const ref = tracks.find((t) => t.video) ?? tracks[0];

    const hint = hintOf(durationHintMs);
    const seconds = Math.max(0, Math.floor((hint + 999) / 1000));
    const maxRefs = Math.max(16, Math.min(0xffff, seconds * REFS_PER_SECOND + 8));
    const reserveLen = 8 + SIDX_FIXED + SIDX_PER_REF * maxRefs;

    const init = new Uint8Array(initEnd + mehdLen + reserveLen);
    init.set(part0.subarray(0, insertAt), 0);
    // the mehd: size, type, version; flags and duration 0 until the end
    put32(init, insertAt, mehdLen);
    put32(init, insertAt + 4, MEHD);
    init[insertAt + 8] = mvhdVer;
    init.set(part0.subarray(insertAt, initEnd), insertAt + mehdLen);
    // moov and mvex both contain the insertion point.
    put32(init, moov.start, moov.size + mehdLen);
    put32(init, out(mvex.start, insertAt, mehdLen), mvex.size + mehdLen);
    const reserveOff = initEnd + mehdLen;
    put32(init, reserveOff, reserveLen);
    init.set(FREE_BYTES, reserveOff + 4);

    return {
        init,
        consumed: initEnd,
        shift: mehdLen + reserveLen,
        movieTimescale,
        mvhdDurOff: out(mvhdDurIn, insertAt, mehdLen), mvhdDurSize: mvhdVer === 1 ? 8 : 4,
        mehdDurOff: insertAt + 12, mehdDurSize: mvhdVer === 1 ? 8 : 4,
        reserveOff, reserveLen, maxRefs,
        tracks,
        ref,
    };
}

// ---- the media parts -------------------------------------------------------------

/** The viewer pressed Cancel: what forEachClipPart rejects with too. */
function cancelledError(): Error {
    return new DOMException('Download cancelled.', 'AbortError');
}

/**
 * Reads the media as it goes past (output order, absolute output offsets) and
 * works out the index and the patches. Feed it slices of any size, in order:
 * the result does not depend on how the bytes were cut.
 */
export class Scanner {
    private pos: number;
    private readonly hdr = new Uint8Array(16);
    private hdrHave = 0;
    private hdrNeed = 8;
    private inBody = false;
    private boxStart = 0;
    /** May be astronomically large (a 64-bit size): only ever compared and decremented. */
    private remaining = 0;
    private boxType = 0;
    private capture: Uint8Array | null = null;
    private captureLen = 0;
    /** Top-level framing broke, or a budget ran out: stop reading boxes (see finish). */
    private framingLost = false;
    /** A fragment said something this pass does not understand: no sidx, durations from the manifest. */
    private analysisFailed = false;
    /** The last 16 bytes that went past (an mfro, if framing is lost), and how many went past. */
    private readonly tail = new Uint8Array(16);
    private fed = 0;

    /** Every moof start, ascending (the stream only moves forward). */
    private moofStarts = new Float64Array(64);
    private moofCount = 0;
    /** [moofStart, tfdt, sap]; at most maxRefs + 1 (one more = "too many"). */
    private readonly refFrags: { moofStart: number; base: bigint; sap: boolean }[] = [];
    private firstMoofStart = -1;
    private lastMediaEnd = -1;
    /** Keyed by the tfhd's UNSIGNED track id. */
    private readonly trackEnd = new Map<number, bigint>();
    private readonly patches: Patch[] = [];
    /** Output end of the last mfra this pass rewrote or retired. */
    private mfraDoneEnd = -1;
    private readonly plan: Plan;
    private readonly cancelled?: () => boolean;

    /** @param cancelled polled once per box; true throws an AbortError */
    constructor(plan: Plan, startOffset: number, cancelled?: () => boolean) {
        this.plan = plan;
        this.pos = startOffset;
        this.cancelled = cancelled;
    }

    analysisOk(): boolean { return !this.framingLost && !this.analysisFailed; }

    /** What the scanner holds per fragment (tests: it must stay bounded). */
    records(): number { return this.moofCount + this.refFrags.length + this.patches.length; }

    private checkCancelled(): void {
        if (this.cancelled?.()) throw cancelledError();
    }

    /** A budget ran out: keep nothing more, read no more boxes. */
    private giveUp(): void {
        this.framingLost = true;
    }

    private addPatch(p: Patch): boolean {
        if (this.patches.length >= MAX_PATCHES) {
            this.giveUp();
            return false;
        }
        this.patches.push(p);
        return true;
    }

    private sawMoofAt(offset: bigint): boolean {
        if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        const want = Number(offset);
        let lo = 0, hi = this.moofCount - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const v = this.moofStarts[mid];
            if (v === want) return true;
            if (v < want) lo = mid + 1;
            else hi = mid - 1;
        }
        return false;
    }

    feed(buf: Uint8Array): void {
        let p = 0;
        const n = buf.length;
        while (p < n) {
            const avail = n - p;
            if (!this.inBody && this.hdrHave === 0) this.checkCancelled();
            if (this.framingLost) {
                // Only the last 16 bytes matter now (an mfro): see the tail below.
                this.pos += avail;
                p = n;
                break;
            }
            if (!this.inBody) {
                const take = Math.min(this.hdrNeed - this.hdrHave, avail);
                this.hdr.set(buf.subarray(p, p + take), this.hdrHave);
                this.hdrHave += take;
                this.pos += take;
                p += take;
                if (this.hdrNeed === 8 && this.hdrHave === 8) {
                    const size = u32(this.hdr, 0);
                    if (size === 1) { this.hdrNeed = 16; continue; }
                    this.startBox(size, 8);
                } else if (this.hdrNeed === 16 && this.hdrHave === 16) {
                    const big = s64(this.hdr, 8);
                    // past 2^53 the exact value no longer matters: no stream is that long
                    this.startBox(big < 0n ? -1 : Number(big), 16);
                }
                continue;
            }
            const take = Math.min(this.remaining, avail);
            if (this.capture) {
                this.capture.set(buf.subarray(p, p + take), this.captureLen);
                this.captureLen += take;
            }
            p += take;
            this.pos += take;
            this.remaining -= take;
            if (this.remaining === 0) this.endBox();
        }
        // the last 16 bytes of the stream so far
        const k = Math.min(16, n);
        if (k > 0) {
            if (k < 16) this.tail.copyWithin(0, k);
            this.tail.set(buf.subarray(n - k), 16 - k);
        }
        this.fed += n;
    }

    private startBox(size: number, h: number): void {
        if (size < h) { this.framingLost = true; return; }
        const t = u32(this.hdr, 4);
        this.boxType = t;
        this.boxStart = this.pos - h;
        this.remaining = size - h;
        this.inBody = true;
        if (t === MOOF) {
            if (this.moofCount >= MAX_MOOFS) {
                this.giveUp();
                return;
            }
            if (this.moofCount === this.moofStarts.length) {
                const grown = new Float64Array(Math.min(MAX_MOOFS, this.moofCount * 2));
                grown.set(this.moofStarts);
                this.moofStarts = grown;
            }
            this.moofStarts[this.moofCount++] = this.boxStart;
            if (this.firstMoofStart < 0) this.firstMoofStart = this.boxStart;
        }
        if ((t === MOOF || t === MFRA) && size <= CAPTURE_MAX) {
            this.capture = new Uint8Array(size);
            this.capture.set(this.hdr.subarray(0, h));
            this.captureLen = h;
        } else {
            this.capture = null;
            if (t === MOOF) this.analysisFailed = true;
            if (t === MFRA) this.neutralizeMfra(this.boxStart);
        }
        if (this.remaining === 0) this.endBox();
    }

    private endBox(): void {
        const at = this.pos;
        if (this.capture) {
            const box = this.capture;
            this.capture = null;
            if (this.boxType === MOOF) this.parseMoof(box, this.boxStart);
            else if (this.boxType === MFRA) this.parseMfra(box, this.boxStart);
        }
        if (this.boxType === MFRA && !this.framingLost) this.mfraDoneEnd = at;
        if (this.boxType === MOOF || this.boxType === MDAT) this.lastMediaEnd = at;
        this.capture = null;
        this.inBody = false;
        this.hdrHave = 0;
        this.hdrNeed = 8;
    }

    private parseMoof(m: Uint8Array, moofStart: number): void {
        const kids = children(m, 8, m.length);
        if (!kids) { this.analysisFailed = true; return; }
        try {
            this.parseTrafs(m, kids, moofStart);
        } catch (e) {
            if (!(e instanceof Overflow)) throw e;
            this.analysisFailed = true; // a duration past 2^63 ticks is not a duration
        }
    }

    private parseTrafs(m: Uint8Array, kids: Box[], moofStart: number): void {
        const plan = this.plan;
        for (const traf of kids) {
            if (traf.type !== TRAF) continue;
            this.checkCancelled();
            const tk = children(m, body(traf), end(traf));
            const tfhd = tk ? find(tk, TFHD) : null;
            const tfdt = tk ? find(tk, TFDT) : null;
            if (!tk || !tfhd || !tfdt || tfhd.size < 16 || tfdt.size < 16) { this.analysisFailed = true; return; }
            const tfFlags = u32(m, tfhd.start + 8) & 0xffffff;
            const trackId = u32(m, tfhd.start + 12);
            let o = tfhd.start + 16;
            let defDur = -1, defFlags = -1;
            if (tfFlags & 0x1) {
                if (o + 8 > end(tfhd)) { this.analysisFailed = true; return; }
                // An absolute offset: it moves with everything else.
                if (!this.addPatch({ offset: moofStart + o, bytes: field(s64(m, o) + BigInt(plan.shift), 8) })) return;
                o += 8;
            }
            if (tfFlags & 0x2) o += 4;
            if (tfFlags & 0x8) { if (o + 4 > end(tfhd)) { this.analysisFailed = true; return; } defDur = u32(m, o); o += 4; }
            if (tfFlags & 0x10) o += 4;
            if (tfFlags & 0x20) { if (o + 4 > end(tfhd)) { this.analysisFailed = true; return; } defFlags = u32(m, o); }
            let tr: Track | null = null;
            for (const t of plan.tracks) if (t.id === trackId) tr = t; // a signed id never equals an unsigned one past 2^31, as in Java
            if (!tr) { this.analysisFailed = true; return; }
            if (defDur < 0) defDur = tr.trexDefaultDuration;
            if (defFlags < 0) defFlags = tr.trexDefaultFlags;
            const tv = m[tfdt.start + 8];
            const base = tv === 1 ? (tfdt.size >= 20 ? s64(m, tfdt.start + 12) : -1n) : BigInt(u32(m, tfdt.start + 12));
            if (base < 0n) { this.analysisFailed = true; return; }
            let dur = 0n;
            let firstFlags = defFlags;
            let firstSeen = false;
            for (const trun of tk) {
                if (trun.type !== TRUN) continue;
                if (trun.size < 16) { this.analysisFailed = true; return; }
                const fl = u32(m, trun.start + 8) & 0xffffff;
                const count = u32(m, trun.start + 12);
                let q = trun.start + 16;
                if (fl & 0x1) q += 4;
                let fsf = -1;
                if (fl & 0x4) { if (q + 4 > end(trun)) { this.analysisFailed = true; return; } fsf = u32(m, q); q += 4; }
                const per = (fl & 0x100 ? 4 : 0) + (fl & 0x200 ? 4 : 0) + (fl & 0x400 ? 4 : 0) + (fl & 0x800 ? 4 : 0);
                if (count > MAX_TRUN_SAMPLES || q + count * per > end(trun)) { this.analysisFailed = true; return; }
                if (count === 0) continue;
                if (per === 0) {
                    // No per-sample fields: every sample takes the defaults, so the
                    // run lasts count x the default. No loop. (< 2^52: exact.)
                    if (!firstSeen) { firstFlags = fsf >= 0 ? fsf : defFlags; firstSeen = true; }
                    dur = addExact(dur, BigInt(count * defDur));
                    continue;
                }
                // At most 2^20 samples of at most 2^32 - 1 ticks: the run's sum
                // is exact as a number, and checking it once against 2^63 is the
                // same as Java checking every sample (they are all >= 0).
                let sum = 0;
                for (let s = 0; s < count; s++) {
                    let r = q;
                    let sd = defDur;
                    if (fl & 0x100) { sd = u32(m, r); r += 4; }
                    if (fl & 0x200) r += 4;
                    if (!firstSeen) {
                        let sf = (s === 0 && fsf >= 0) ? fsf : defFlags;
                        if (fl & 0x400) sf = (s === 0 && fsf >= 0) ? fsf : u32(m, r);
                        firstFlags = sf;
                        firstSeen = true;
                    }
                    sum += sd;
                    q += per;
                }
                dur = addExact(dur, BigInt(sum));
            }
            const fragEnd = addExact(base, dur);
            const prev = this.trackEnd.get(trackId);
            if (prev === undefined || fragEnd > prev) this.trackEnd.set(trackId, fragEnd);
            // One reference past maxRefs is enough to know the sidx will not fit.
            if (tr === plan.ref && this.refFrags.length <= plan.maxRefs) {
                // sample_is_non_sync_sample is bit 16 of the sample flags.
                this.refFrags.push({ moofStart, base, sap: firstFlags >= 0 && (firstFlags & 0x10000) === 0 });
            }
        }
    }

    private parseMfra(m: Uint8Array, mfraStart: number): void {
        const kids = children(m, 8, m.length);
        if (!kids) { this.neutralizeMfra(mfraStart); return; }
        const shift = BigInt(this.plan.shift);
        // Twice over the entries: first check every one points at a moof this
        // pass saw and that they all fit the patch budget, then rewrite them —
        // so a bad index costs no memory before it is refused, and is refused whole.
        for (let pass = 0; pass < 2; pass++) {
            let entries = 0;
            for (const t of kids) {
                if (t.type !== TFRA) continue;
                this.checkCancelled();
                if (t.size < 24) { this.neutralizeMfra(mfraStart); return; }
                const v = m[t.start + 8];
                const sizes = u32(m, t.start + 16);
                const n = u32(m, t.start + 20);
                const lt = ((sizes >>> 4) & 3) + 1, lr = ((sizes >>> 2) & 3) + 1, ls = (sizes & 3) + 1;
                const w = v === 1 ? 8 : 4;
                const entry = w + w + lt + lr + ls;
                let q = t.start + 24;
                if (q + n * entry > end(t)) { this.neutralizeMfra(mfraStart); return; }
                entries += n;
                if (pass === 0 && this.patches.length + entries > MAX_PATCHES) { this.neutralizeMfra(mfraStart); return; }
                for (let i = 0; i < n; i++) {
                    const offAt = q + w;
                    const was = w === 8 ? s64(m, offAt) : BigInt(u32(m, offAt));
                    const now = wrap(was + shift);
                    if (pass === 0 && (!this.sawMoofAt(now) || (w === 4 && now > 0xffffffffn))) { this.neutralizeMfra(mfraStart); return; }
                    if (pass === 1) this.addPatch({ offset: mfraStart + offAt, bytes: field(now, w) });
                    q += entry;
                }
            }
        }
    }

    /** No index rather than a wrong one: rename the box so no reader uses it. */
    private neutralizeMfra(mfraStart: number): void {
        this.addPatch({ offset: mfraStart + 4, bytes: FREE_BYTES.slice() });
    }

    /** Every patch, once the last byte went past. */
    finish(durationHintMs: number): Patch[] {
        const plan = this.plan;
        const result: Patch[] = this.patches.slice();
        // Reading stopped before the last mfra was dealt with: find it from the
        // trailing mfro and retire it, since its offsets no longer hold.
        if (this.framingLost && this.mfraDoneEnd !== this.pos && this.fed >= 16 && u32(this.tail, 4) === MFRO) {
            const mfraSize = u32(this.tail, 12);
            if (mfraSize >= 16 && mfraSize <= this.pos) result.push({ offset: this.pos - mfraSize + 4, bytes: FREE_BYTES.slice() });
        }
        const ok = this.analysisOk() && !this.inBody && this.hdrHave === 0;
        // durations: the fragments' own, or the manifest's when they could not be read
        const hint = BigInt(hintOf(durationHintMs));
        const movieTs = BigInt(plan.movieTimescale);
        let movieDur = 0n;
        for (const t of plan.tracks) {
            const endTs = ok ? this.trackEnd.get(t.id) : undefined;
            const ts = BigInt(t.timescale);
            const trackDur = endTs !== undefined ? endTs : wrap(wrap(hint * ts) + 500n) / 1000n;
            const inMovie = wrap(wrap(trackDur * movieTs) + ts / 2n) / ts;
            if (inMovie > movieDur) movieDur = inMovie;
            if (fits(trackDur, t.mdhdDurSize)) result.push({ offset: t.mdhdDurOff, bytes: field(trackDur, t.mdhdDurSize) });
            if (fits(inMovie, t.tkhdDurSize)) result.push({ offset: t.tkhdDurOff, bytes: field(inMovie, t.tkhdDurSize) });
        }
        if (fits(movieDur, plan.mvhdDurSize)) result.push({ offset: plan.mvhdDurOff, bytes: field(movieDur, plan.mvhdDurSize) });
        if (fits(movieDur, plan.mehdDurSize)) result.push({ offset: plan.mehdDurOff, bytes: field(movieDur, plan.mehdDurSize) });
        const sidx = ok ? this.sidx() : null;
        if (sidx) {
            const region = new Uint8Array(plan.reserveLen);
            const freeLen = plan.reserveLen - sidx.length;
            put32(region, 0, freeLen);
            region.set(FREE_BYTES, 4);
            region.set(sidx, freeLen);
            result.push({ offset: plan.reserveOff, bytes: region });
        }
        return result;
    }

    /** Why finish writes no sidx, or null when it writes one. For the outcome line only. */
    noIndexReason(): string | null {
        if (!this.analysisOk()) return 'fragments not understood';
        if (this.inBody || this.hdrHave !== 0) return 'fragments incomplete'; // the stream ended inside a box
        if (this.refFrags.length === 0) return 'no fragments to index';
        if (this.refFrags.length > this.plan.maxRefs) return 'too many fragments';
        return this.sidx() === null ? 'fragments out of range' : null;
    }

    /** v1 sidx over the reference track's fragments, or null when it does not fit. */
    private sidx(): Uint8Array | null {
        const plan = this.plan;
        const n = this.refFrags.length;
        if (n === 0 || n > plan.maxRefs || this.lastMediaEnd < 0) return null;
        const sidxEnd = plan.reserveOff + plan.reserveLen;
        if (this.firstMoofStart < sidxEnd) return null;
        const refEnd = this.trackEnd.get(plan.ref.id);
        if (refEnd === undefined) return null;
        const len = SIDX_FIXED + SIDX_PER_REF * n;
        if (plan.reserveLen - len < 8) return null;
        const s = new Uint8Array(len);
        put32(s, 0, len);
        s.set([0x73, 0x69, 0x64, 0x78], 4); // "sidx"
        s[8] = 1; // version 1: 64-bit earliest_presentation_time and first_offset
        put32(s, 12, plan.ref.id);
        put32(s, 16, plan.ref.timescale);
        put64(s, 20, this.refFrags[0].base);
        put64(s, 28, BigInt(this.firstMoofStart - sidxEnd));
        s[38] = (n >>> 8) & 0xff; s[39] = n & 0xff;
        let o = SIDX_FIXED;
        for (let i = 0; i < n; i++) {
            const start = i === 0 ? this.firstMoofStart : this.refFrags[i].moofStart;
            const stop = i + 1 < n ? this.refFrags[i + 1].moofStart : this.lastMediaEnd;
            const t0 = this.refFrags[i].base;
            const t1 = i + 1 < n ? this.refFrags[i + 1].base : refEnd;
            const size = stop - start, dur = t1 - t0;
            if (size <= 0 || size > 0x7fffffff || dur < 0n || dur > 0xffffffffn) return null;
            put32(s, o, size); // reference_type 0 (media) | referenced_size
            put32(s, o + 4, Number(dur));
            if (this.refFrags[i].sap) put32(s, o + 8, 0x90000000); // starts_with_SAP, SAP_type 1
            o += SIDX_PER_REF;
        }
        return s;
    }
}

function fits(v: bigint, size: number): boolean {
    return v >= 0n && (size === 8 || v <= 0xffffffffn);
}

// ---- the whole clip ---------------------------------------------------------------

export interface AssembledClip {
    /** The file, in order: the decrypted parts themselves (patched in place), the init replaced. */
    chunks: Uint8Array[];
    bytes: number;
    /** What happened to the container, for a log line. Never names content. */
    outcome: string;
}

/**
 * Builds a clip's file from its decrypted parts, in order — with the fix
 * applied when the clip is an MP4 it understands. ClipAssembler.java's
 * twin: the same decisions, the same outcome strings, the same bytes.
 *
 * The parts are KEPT (and patched in place), not copied: the caller hands
 * over parts it will not use again.
 */
export class ClipAssembler {
    private readonly chunks: Uint8Array[] = [];
    /** Output offset of each chunk. */
    private readonly starts: number[] = [];
    private written = 0;
    private scanner: Scanner | null = null;
    private nextIndex = 0;
    private outcome = 'not started';
    private readonly durationHintMs: number;
    private readonly fix: boolean;
    private readonly cancelled?: () => boolean;

    /**
     * @param durationHintMs the manifest's duration (sizes the index, and is
     *        the duration written when the fragments cannot be read)
     * @param fix false = a plain concatenation, the sealed bytes as they are
     * @param cancelled polled before every part and once per box while a
     *        part is read; true throws an AbortError
     */
    constructor(durationHintMs: number, fix: boolean, cancelled?: () => boolean) {
        this.durationHintMs = durationHintMs;
        this.fix = fix;
        this.cancelled = cancelled;
    }

    /** Part `index`'s plaintext; parts arrive in order. */
    part(index: number, plain: Uint8Array): void {
        if (index !== this.nextIndex) throw new Error(`part ${index} out of order (expected ${this.nextIndex})`);
        if (this.cancelled?.()) throw cancelledError();
        this.nextIndex++;
        if (index === 0) {
            // Only an MP4 gets the fix, exactly as the Android save decides it.
            const mp4 = this.fix && savesAsMp4(plain);
            const plan = mp4 ? prepareInit(plain, this.durationHintMs) : null;
            if (!plan) {
                this.outcome = mp4 ? 'saved as sealed (init not recognised)' : 'saved as sealed';
                this.put(plain);
                return;
            }
            this.put(plan.init);
            this.scanner = new Scanner(plan, plan.init.length, this.cancelled);
            if (plan.consumed < plain.length) {
                const rest = plain.subarray(plan.consumed);
                this.scanner.feed(rest);
                this.put(rest);
            }
            return;
        }
        this.scanner?.feed(plain);
        this.put(plain);
    }

    /** Writes the patches into the parts; returns the file. */
    finish(): AssembledClip {
        if (this.scanner) {
            const noIndex = this.scanner.noIndexReason();
            for (const p of this.scanner.finish(this.durationHintMs)) this.writeAt(p.offset, p.bytes);
            this.outcome = noIndex === null ? 'duration and seek index added' : `duration added (no seek index: ${noIndex})`;
            this.scanner = null;
        }
        return { chunks: this.chunks, bytes: this.written, outcome: this.outcome };
    }

    private put(b: Uint8Array): void {
        if (b.length === 0) return;
        this.chunks.push(b);
        this.starts.push(this.written);
        this.written += b.length;
    }

    /** Positional write over the chunks; a patch never extends the file. */
    private writeAt(offset: number, bytes: Uint8Array): void {
        if (offset < 0 || offset + bytes.length > this.written) throw new RangeError(`patch at ${offset} (+${bytes.length}) is outside the ${this.written}-byte file`);
        let lo = 0, hi = this.starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            if (this.starts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        let i = lo, done = 0;
        while (done < bytes.length) {
            const c = this.chunks[i];
            const at = offset + done - this.starts[i];
            const n = Math.min(c.length - at, bytes.length - done);
            c.set(bytes.subarray(done, done + n), at);
            done += n;
            i++;
        }
    }
}
