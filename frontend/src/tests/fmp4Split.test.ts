import { describe, it, expect } from 'vitest';
import { Fmp4Splitter, PART_RAMP_FRAGMENTS, fitPartCount, parseFragmentStart, parseTimescales, type SplitPart } from '../api/clips/fmp4Split';

// ---- tiny ISO-BMFF builders -------------------------------------------------
const enc = new TextEncoder();
function box(type: string, payload: Uint8Array = new Uint8Array(0), largesize = false): Uint8Array {
    const hdr = largesize ? 16 : 8;
    const out = new Uint8Array(hdr + payload.byteLength);
    const dv = new DataView(out.buffer);
    if (largesize) { dv.setUint32(0, 1); out.set(enc.encode(type), 4); dv.setBigUint64(8, BigInt(out.byteLength)); }
    else { dv.setUint32(0, out.byteLength); out.set(enc.encode(type), 4); }
    out.set(payload, hdr);
    return out;
}
function cat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((a, p) => a + p.byteLength, 0);
    const out = new Uint8Array(total); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    return out;
}
function fullbox(type: string, version: number, payload: Uint8Array): Uint8Array {
    const p = new Uint8Array(4 + payload.byteLength); p[0] = version; p.set(payload, 4);
    return box(type, p);
}
function u32(...v: number[]): Uint8Array { const o = new Uint8Array(v.length * 4); const dv = new DataView(o.buffer); v.forEach((x, i) => dv.setUint32(i * 4, x)); return o; }
function u64(v: bigint): Uint8Array { const o = new Uint8Array(8); new DataView(o.buffer).setBigUint64(0, v); return o; }

/** moov with two tracks: id 1 @ 90000 (video, tkhd v0), id 2 @ 48000 (audio, tkhd v1 + mdhd v1). */
function moov(): Uint8Array {
    const trak1 = box('trak', cat(
        fullbox('tkhd', 0, u32(0, 0, 1 /*track_ID*/, 0)),
        box('mdia', fullbox('mdhd', 0, u32(0, 0, 90000 /*timescale*/, 0))),
    ));
    const trak2 = box('trak', cat(
        fullbox('tkhd', 1, cat(u64(0n), u64(0n), u32(2 /*track_ID*/, 0))),
        box('mdia', fullbox('mdhd', 1, cat(u64(0n), u64(0n), u32(48000), u64(0n)))),
    ));
    return box('moov', cat(box('mvhd', new Uint8Array(20)), trak1, trak2));
}
/** moof with a video traf at `startS` and an audio traf 5 ms later; tfdt v0 for video, v1 for audio. */
function moof(startS: number): Uint8Array {
    const trafV = box('traf', cat(fullbox('tfhd', 0, u32(1)), fullbox('tfdt', 0, u32(Math.round(startS * 90000)))));
    const trafA = box('traf', cat(fullbox('tfhd', 0, u32(2)), fullbox('tfdt', 1, u64(BigInt(Math.round((startS + 0.005) * 48000))))));
    return box('moof', cat(fullbox('mfhd', 0, u32(1)), trafV, trafA));
}
function mdat(bytes: number, largesize = false): Uint8Array {
    const p = new Uint8Array(bytes); for (let i = 0; i < bytes; i++) p[i] = i & 0xff;
    return box('mdat', p, largesize);
}

function run(stream: Uint8Array, budget: number, chunk: number | number[]): SplitPart[] {
    const parts: SplitPart[] = [];
    const s = new Fmp4Splitter(budget, p => parts.push(p));
    if (typeof chunk === 'number') { for (let o = 0; o < stream.byteLength; o += chunk) s.push(stream.subarray(o, Math.min(stream.byteLength, o + chunk))); }
    else { let o = 0; for (const c of chunk) { s.push(stream.subarray(o, o + c)); o += c; } if (o < stream.byteLength) s.push(stream.subarray(o)); }
    s.end();
    return parts;
}

describe('fmp4Split — box parsers', () => {
    it('reads timescales from moov (tkhd/mdhd v0 and v1)', () => {
        const ts = parseTimescales(moov());
        expect(ts.get(1)).toBe(90000);
        expect(ts.get(2)).toBe(48000);
    });
    it('reads the earliest tfdt of a moof in seconds', () => {
        expect(parseFragmentStart(moof(4), parseTimescales(moov()))).toBeCloseTo(4, 6);
    });
});

describe('fmp4Split — cutting rules', () => {
    const ftyp = box('ftyp', enc.encode('isom'));
    const N = 6;
    const frags: Uint8Array[] = [];
    for (let i = 0; i < N; i++) frags.push(cat(moof(i * 2), mdat(1000)));
    const stream = cat(ftyp, moov(), ...frags);

    it('part 0 is init only (no moof), every later cut lands before a moof, concat is byte-identical', () => {
        const parts = run(stream, 2600, 7); // budget fits ~2 fragments (each ~1150 B)
        expect(parts[0].isInit).toBe(true);
        expect(parts[0].fragments).toBe(0);
        expect(new TextDecoder('latin1').decode(parts[0].bytes.subarray(4, 8))).toBe('ftyp');
        expect(parts[0].bytes.includes(0x6d)).toBe(true); // has bytes; sanity
        // no 'moof' in the init part
        expect(indexOfType(parts[0].bytes, 'moof')).toBe(-1);
        for (const p of parts.slice(1)) {
            expect(p.isInit).toBe(false);
            expect(new TextDecoder('latin1').decode(p.bytes.subarray(4, 8))).toBe('moof');
            expect(p.overBudget).toBe(false);
            expect(p.bytes.byteLength).toBeLessThanOrEqual(2600);
        }
        expect(cat(...parts.map(p => p.bytes))).toEqual(stream);
        expect(parts.slice(1).reduce((a, p) => a + p.fragments, 0)).toBe(N);
        // fragment start times flow into the parts
        expect(parts[1].startS).toBeCloseTo(0, 6);
        expect(parts[2].startS).toBeCloseTo(4, 6);
    });
    it('never separates a moof from its mdat even when a header straddles two pushes', () => {
        // Push sizes chosen so a box header (8 bytes) is split across calls.
        const parts = run(stream, 100_000, [3, 5, 1, 7, 2, 500, 13, 999]);
        expect(parts.length).toBe(2); // init + one big part
        expect(parts[1].fragments).toBe(N);
        expect(cat(...parts.map(p => p.bytes))).toEqual(stream);
    });
    it('handles a 64-bit largesize box and flags an over-budget single fragment instead of splitting it', () => {
        const big = cat(moof(0), mdat(5000, true));
        const s2 = cat(ftyp, moov(), big, cat(moof(2), mdat(100)));
        const parts = run(s2, 2000, 64);
        expect(parts.length).toBe(3);
        expect(parts[1].overBudget).toBe(true);
        expect(parts[1].fragments).toBe(1);
        expect(parts[2].overBudget).toBe(false);
        expect(cat(...parts.map(p => p.bytes))).toEqual(s2);
    });
    it('a stream with no fragments yields just the init part', () => {
        const parts = run(cat(ftyp, moov()), 1000, 16);
        expect(parts.length).toBe(1);
        expect(parts[0].isInit).toBe(true);
    });
    it('rejects trailing garbage at end()', () => {
        const s = new Fmp4Splitter(1000, () => {});
        s.push(new Uint8Array([0, 0, 0, 20, 0x66, 0x74]));
        expect(() => s.end()).toThrow(/trailing/);
    });
});

// ---- the ramp: small first parts so a viewer starts playing after a few MB ----
// A part is one AES-GCM unit: nothing in it can play before ALL of it has
// arrived. With every part cut at the 24 MiB budget a 2-minute clip made a
// phone fetch ~24 MB before the first frame (6-26 s measured, 2026-10-04).
describe('fmp4Split — the graduated first parts (PART_RAMP_FRAGMENTS)', () => {
    const ftyp = box('ftyp', enc.encode('isom'));
    const frag = (i: number) => cat(moof(i * 2), mdat(1000)); // ~1.15 KB, one 2 s fragment
    const streamOf = (n: number) => cat(ftyp, moov(), ...Array.from({ length: n }, (_, i) => frag(i)));
    const F = frag(0).byteLength; // every fragment here is the same size
    const fits = (n: number) => n * F + 10; // a budget that holds exactly n fragments
    function runRamp(stream: Uint8Array, budget: number, ramp: readonly number[], chunk = 97): SplitPart[] {
        const parts: SplitPart[] = [];
        const s = new Fmp4Splitter(budget, p => parts.push(p), ramp);
        for (let o = 0; o < stream.byteLength; o += chunk) s.push(stream.subarray(o, Math.min(stream.byteLength, o + chunk)));
        s.end();
        return parts;
    }

    it('the seal ramps 1, 2, 4, 8 fragments before packing to the budget', () => {
        expect(PART_RAMP_FRAGMENTS).toEqual([1, 2, 4, 8]);
    });

    it('media parts 1-4 hold 1, 2, 4 and 8 fragments, then the budget alone decides; concat stays byte-identical', () => {
        const stream = streamOf(40);
        const parts = runRamp(stream, fits(20), PART_RAMP_FRAGMENTS);
        expect(parts[0].isInit).toBe(true);
        const counts = parts.slice(1).map(p => p.fragments);
        expect(counts.slice(0, 4)).toEqual([1, 2, 4, 8]);
        // 40 - 15 = 25 fragments left: one full-budget part and the rest.
        expect(counts.slice(4)).toEqual([20, 5]);
        expect(cat(...parts.map(p => p.bytes))).toEqual(stream);
        // Every part still starts on a fragment, with its start time.
        expect(parts.slice(1).map(p => p.startS)).toEqual([0, 2, 6, 14, 30, 70]);
        for (const p of parts.slice(1)) expect(new TextDecoder('latin1').decode(p.bytes.subarray(4, 8))).toBe('moof');
    });

    it('the byte budget still wins over a ramp step that does not fit', () => {
        const parts = runRamp(streamOf(20), fits(3), PART_RAMP_FRAGMENTS);
        expect(parts.slice(1).map(p => p.fragments)).toEqual([1, 2, 3, 3, 3, 3, 3, 2]);
    });

    it('no ramp passed = the flat cut every caller had before (positive control)', () => {
        const parts = runRamp(streamOf(40), fits(20), []);
        expect(parts.slice(1).map(p => p.fragments)).toEqual([20, 20]);
    });

    it('fitPartCount keeps a ramped split that fits, and re-cuts one that does not FLAT, byte-identical', () => {
        const stream = streamOf(40);
        const ramped = runRamp(stream, fits(20), PART_RAMP_FRAGMENTS); // 7 parts
        expect(ramped.length).toBe(7);
        expect(fitPartCount(ramped, fits(20), 7)).toBe(ramped);
        const flat = runRamp(stream, fits(20), []);
        const refit = fitPartCount(ramped, fits(20), 6);
        expect(refit.map(p => p.fragments)).toEqual(flat.map(p => p.fragments));
        expect(refit.map(p => p.startS)).toEqual(flat.map(p => p.startS));
        expect(refit.map(p => p.index)).toEqual([0, 1, 2]);
        expect(cat(...refit.map(p => p.bytes))).toEqual(stream);
        // The ramped input was consumed and its plaintext zero-filled.
        expect(ramped.length).toBe(0);
    });

    it('rejects a ramp entry that is not a positive whole number', () => {
        expect(() => new Fmp4Splitter(1000, () => {}, [1, 0])).toThrow(/positive integers/);
        expect(() => new Fmp4Splitter(1000, () => {}, [1.5])).toThrow(/positive integers/);
    });
});

function indexOfType(u8: Uint8Array, type: string): number {
    const t = enc.encode(type);
    outer: for (let i = 4; i + 4 <= u8.byteLength; i++) {
        for (let j = 0; j < 4; j++) if (u8[i + j] !== t[j]) continue outer;
        return i;
    }
    return -1;
}
