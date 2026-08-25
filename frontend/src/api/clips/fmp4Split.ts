/**
 * Streaming ISO-BMFF top-level box splitter for fragmented MP4 — PURE.
 *
 * mediabunny hands the muxer output over as an ordered byte stream. The clip
 * parts must be cut so that:
 *   - part 0 is the INIT SEGMENT ONLY (`ftyp` + `moov` + anything else that
 *     precedes the first `moof`), so a player can fetch a few KB of init and
 *     then any later part directly (seeking never re-downloads 24 MiB);
 *   - every later cut lands IMMEDIATELY BEFORE a `moof`, and a `moof` is never
 *     separated from the `mdat` that follows it — a part therefore starts at
 *     a fragment boundary and every fragment starts at a GOP keyframe;
 *   - concatenating all parts in order reproduces the muxer output byte for
 *     byte (the non-MSE fallback is a plain concat, no box surgery).
 *
 * The splitter also reads each fragment's start time out of `moof>traf>tfdt`
 * (with the timescales from `moov>trak>mdia>mdhd`) so the manifest can carry
 * per-part durations for seek-by-part — `GET /files/:id` has no Range support.
 */

export interface SplitPart {
    index: number;
    bytes: Uint8Array;
    /** True for part 0 (init segment). */
    isInit: boolean;
    /** Presentation start (seconds) of the first fragment in the part; null for the init part. */
    startS: number | null;
    /** Number of moof/mdat fragments in the part (0 for the init part). */
    fragments: number;
    /** True if a single fragment exceeded the budget (emitted anyway; logged by the caller). */
    overBudget: boolean;
}

interface Box { type: string; size: number; hdr: number; }

const td = new TextDecoder('latin1');
function readBox(u8: Uint8Array, off: number): Box | null {
    if (off + 8 > u8.byteLength) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let size = dv.getUint32(off);
    const type = td.decode(u8.subarray(off + 4, off + 8));
    let hdr = 8;
    if (size === 1) {
        if (off + 16 > u8.byteLength) return null;
        const big = dv.getBigUint64(off + 8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('box too large');
        size = Number(big);
        hdr = 16;
    } else if (size === 0) {
        // "extends to end of file" — legal only for a final box; we cannot
        // stream that, and mediabunny never emits it for fragmented output.
        throw new Error('largesize-0 (to-EOF) box is not supported by the splitter');
    }
    if (size < hdr) throw new Error(`invalid box size ${size} for ${type}`);
    return { type, size, hdr };
}

/** Iterate the child boxes of a container box body. */
function* children(u8: Uint8Array, start: number, end: number): Generator<{ type: string; off: number; size: number; hdr: number }> {
    let off = start;
    while (off + 8 <= end) {
        const b = readBox(u8, off);
        if (!b || off + b.size > end) return;
        yield { type: b.type, off, size: b.size, hdr: b.hdr };
        off += b.size;
    }
}

/** trackId → timescale, from a `moov` box. */
export function parseTimescales(moov: Uint8Array): Map<number, number> {
    const out = new Map<number, number>();
    const top = readBox(moov, 0);
    if (!top || top.type !== 'moov') return out;
    const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
    for (const trak of children(moov, top.hdr, top.size)) {
        if (trak.type !== 'trak') continue;
        let trackId = -1, timescale = 0;
        for (const c of children(moov, trak.off + trak.hdr, trak.off + trak.size)) {
            if (c.type === 'tkhd') {
                const v = moov[c.off + c.hdr];
                trackId = v === 1 ? dv.getUint32(c.off + c.hdr + 4 + 8 + 8) : dv.getUint32(c.off + c.hdr + 4 + 4 + 4);
            } else if (c.type === 'mdia') {
                for (const m of children(moov, c.off + c.hdr, c.off + c.size)) {
                    if (m.type !== 'mdhd') continue;
                    const v = moov[m.off + m.hdr];
                    timescale = v === 1 ? dv.getUint32(m.off + m.hdr + 4 + 8 + 8) : dv.getUint32(m.off + m.hdr + 4 + 4 + 4);
                }
            }
        }
        if (trackId >= 0 && timescale > 0) out.set(trackId, timescale);
    }
    return out;
}

/** Earliest `tfdt` (in seconds) across the trafs of a `moof`, or null. */
export function parseFragmentStart(moof: Uint8Array, timescales: Map<number, number>): number | null {
    const top = readBox(moof, 0);
    if (!top || top.type !== 'moof') return null;
    const dv = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
    let best: number | null = null;
    for (const traf of children(moof, top.hdr, top.size)) {
        if (traf.type !== 'traf') continue;
        let trackId = -1; let bmdt: number | null = null;
        for (const c of children(moof, traf.off + traf.hdr, traf.off + traf.size)) {
            if (c.type === 'tfhd') trackId = dv.getUint32(c.off + c.hdr + 4);
            else if (c.type === 'tfdt') {
                const v = moof[c.off + c.hdr];
                bmdt = v === 1 ? Number(dv.getBigUint64(c.off + c.hdr + 4)) : dv.getUint32(c.off + c.hdr + 4);
            }
        }
        const ts = timescales.get(trackId);
        if (bmdt != null && ts) {
            const s = bmdt / ts;
            if (best == null || s < best) best = s;
        }
    }
    return best;
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    return out;
}

export class Fmp4Splitter {
    private pending: Uint8Array = new Uint8Array(0);
    private initDone = false;
    private initBoxes: Uint8Array[] = [];
    private initBytes = 0;
    private timescales = new Map<number, number>();
    // current fragment group (boxes since the last complete moof+mdat pair)
    private group: Uint8Array[] = [];
    private groupBytes = 0;
    private groupHasMoof = false;
    private groupStartS: number | null = null;
    // current part
    private part: Uint8Array[] = [];
    private partBytes = 0;
    private partStartS: number | null = null;
    private partFragments = 0;
    private partOver = false;
    private nextIndex = 0;
    private ended = false;
    private readonly budgetBytes: number;
    private readonly onPart: (p: SplitPart) => void;

    constructor(budgetBytes: number, onPart: (p: SplitPart) => void) {
        if (!(budgetBytes > 0)) throw new Error('budget must be positive');
        this.budgetBytes = budgetBytes;
        this.onPart = onPart;
    }

    push(bytes: Uint8Array): void {
        if (this.ended) throw new Error('push after end');
        if (bytes.byteLength === 0) return;
        if (this.pending.byteLength === 0) this.pending = bytes.slice();
        else this.pending = concat([this.pending, bytes], this.pending.byteLength + bytes.byteLength);
        let off = 0;
        for (;;) {
            const b = readBox(this.pending, off);
            if (!b || off + b.size > this.pending.byteLength) break;
            this.handleBox(b.type, this.pending.slice(off, off + b.size));
            off += b.size;
        }
        if (off > 0) this.pending = this.pending.slice(off);
    }

    end(): void {
        if (this.ended) return;
        this.ended = true;
        if (this.pending.byteLength > 0) throw new Error(`splitter ended with ${this.pending.byteLength} trailing bytes that do not form a complete box`);
        if (!this.initDone) { this.emitInit(); }
        // An incomplete trailing group (moof without mdat) would be a muxer bug;
        // keep the bytes rather than lose them, so concat stays byte-identical.
        if (this.group.length) this.appendGroupToPart();
        this.flushPart();
    }

    private handleBox(type: string, box: Uint8Array): void {
        if (!this.initDone) {
            if (type === 'moof') {
                this.emitInit();
            } else {
                if (type === 'moov') this.timescales = parseTimescales(box);
                this.initBoxes.push(box);
                this.initBytes += box.byteLength;
                return;
            }
        }
        this.group.push(box);
        this.groupBytes += box.byteLength;
        if (type === 'moof') {
            this.groupHasMoof = true;
            this.groupStartS = parseFragmentStart(box, this.timescales);
        } else if (type === 'mdat' && this.groupHasMoof) {
            // A complete fragment. Would it overflow the current part?
            if (this.partBytes > 0 && this.partBytes + this.groupBytes > this.budgetBytes) this.flushPart();
            this.appendGroupToPart();
        }
    }

    private emitInit(): void {
        this.initDone = true;
        const bytes = concat(this.initBoxes, this.initBytes);
        this.onPart({ index: this.nextIndex++, bytes, isInit: true, startS: null, fragments: 0, overBudget: false });
        this.initBoxes = [];
        this.initBytes = 0;
    }

    private appendGroupToPart(): void {
        if (this.part.length === 0) this.partStartS = this.groupStartS;
        for (const b of this.group) this.part.push(b);
        this.partBytes += this.groupBytes;
        if (this.groupHasMoof) this.partFragments++;
        if (this.groupBytes > this.budgetBytes) this.partOver = true;
        this.group = []; this.groupBytes = 0; this.groupHasMoof = false; this.groupStartS = null;
    }

    private flushPart(): void {
        if (this.part.length === 0) return;
        const bytes = concat(this.part, this.partBytes);
        this.onPart({ index: this.nextIndex++, bytes, isInit: false, startS: this.partStartS, fragments: this.partFragments, overBudget: this.partOver });
        this.part = []; this.partBytes = 0; this.partStartS = null; this.partFragments = 0; this.partOver = false;
    }
}
