/**
 * api/clips/fmp4SaveFix.ts against clips built to hurt it — the desktop and
 * web twin of Fmp4SaveFixHostileTest.java. A clip is written by whoever
 * posted it, so reading it must cost no more than a pass over its bytes, keep
 * a bounded record per fragment, and stop when the viewer presses Cancel.
 * Every shape here ran the Java save out of time or memory before its limits
 * (the numbers are in Fmp4SaveFix.java's class comment); the TS port has the
 * same limits, and the shared vectors (downloadVectors.test.ts, `saveFix`)
 * prove it writes the same bytes as Java for these very shapes. The init is
 * the real mediabunny one from download-vectors.json.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPart, uuidToBytes } from '../api/clips/clipCrypto';
import { ClipAssembler, Scanner, prepareInit, children, savesAsMp4, MAX_CHILDREN, MAX_MOOFS, MAX_PATCHES, type Plan } from '../api/clips/fmp4SaveFix';

const VECTORS = join(__dirname, '..', '..', 'android', 'app', 'src', 'test', 'resources', 'download-vectors.json');

let clip: Uint8Array[] = [];
let init: Uint8Array;
let plan: Plan;
/** The video track's id (the sidx reference track). */
let ref: number;

beforeAll(async () => {
    const v = JSON.parse(readFileSync(VECTORS, 'utf8')) as { clip: { key: string; noncePrefix: string; clipId: string; parts: { wire: string }[] } };
    const s = { key: new Uint8Array(Buffer.from(v.clip.key, 'base64')), noncePrefix: new Uint8Array(Buffer.from(v.clip.noncePrefix, 'base64')), clipId: uuidToBytes(v.clip.clipId) };
    clip = [];
    for (let i = 0; i < v.clip.parts.length; i++) clip.push(await openPart(s, i, new Uint8Array(Buffer.from(v.clip.parts[i].wire, 'base64'))));
    init = clip[0];
    const p = prepareInit(init, 4000);
    expect(p, 'the real init is recognised').not.toBeNull();
    plan = p!;
    expect(plan.ref.video).toBe(true);
    ref = plan.ref.id;
});

// ---- building boxes -----------------------------------------------------------

const be32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const latin = (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0));
function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    return out;
}
function box(type: string, ...kids: Uint8Array[]): Uint8Array {
    const body = concat(...kids);
    return concat(be32(8 + body.byteLength), latin(type), body);
}
/** A full box: version 0, the flags, then 32-bit fields. */
function full(type: string, flags: number, ...fields: number[]): Uint8Array {
    const b = new Uint8Array(12 + 4 * fields.length);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, b.byteLength); b.set(latin(type), 4); dv.setUint32(8, flags & 0xffffff);
    fields.forEach((f, i) => dv.setUint32(12 + 4 * i, f >>> 0));
    return b;
}
function repeat(unit: Uint8Array, times: number): Uint8Array {
    const out = new Uint8Array(unit.byteLength * times);
    for (let i = 0; i < times; i++) out.set(unit, i * unit.byteLength);
    return out;
}
/** traf for `track`: tfhd (default-base-is-moof | flags), tfdt v0 = 0, then the truns. */
const traf = (track: number, tfhdFlags: number, tfhdFields: number[], ...truns: Uint8Array[]) =>
    box('traf', full('tfhd', 0x020000 | tfhdFlags, track, ...tfhdFields), full('tfdt', 0, 0), ...truns);
/** A tfra (version 0, 1-byte numbers) whose entries all point at `moofAt`. */
function tfra(track: number, moofAt: number, n: number): Uint8Array {
    const entry = new Uint8Array(11);
    new DataView(entry.buffer).setUint32(4, moofAt);
    const t = concat(full('tfra', 0, track, 0, n), repeat(entry, n));
    new DataView(t.buffer).setUint32(0, t.byteLength);
    return t;
}
const EMPTY_MOOF = box('moof');
const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o);
const isFree = (b: Uint8Array) => b.byteLength === 4 && String.fromCharCode(...b) === 'free';

function save(parts: Uint8Array[], durationMs = 4000, cancelled?: () => boolean): { bytes: Uint8Array; outcome: string } {
    const a = new ClipAssembler(durationMs, true, cancelled);
    parts.forEach((p, i) => a.part(i, p));
    const r = a.finish();
    return { bytes: concat(...r.chunks), outcome: r.outcome };
}

/** mdhd duration of track `id` in a saved file (an independent walk). */
function mdhdDuration(f: Uint8Array, id: number): number {
    const kids = (from: number, to: number) => {
        const out: { s: number; n: number; t: string }[] = [];
        for (let o = from; o < to;) { const n = u32(f, o); out.push({ s: o, n, t: String.fromCharCode(...f.subarray(o + 4, o + 8)) }); o += n; }
        return out;
    };
    const moov = kids(0, f.byteLength).find((b) => b.t === 'moov')!;
    for (const trak of kids(moov.s + 8, moov.s + moov.n).filter((b) => b.t === 'trak')) {
        const tk = kids(trak.s + 8, trak.s + trak.n);
        const tkhd = tk.find((b) => b.t === 'tkhd')!;
        if (u32(f, tkhd.s + 20) !== id) continue;
        const mdia = tk.find((b) => b.t === 'mdia')!;
        const mdhd = kids(mdia.s + 8, mdia.s + mdia.n).find((b) => b.t === 'mdhd')!;
        return u32(f, mdhd.s + 24);
    }
    throw new Error('no such track');
}

/** Feed parts to a fresh scanner in 1 MiB slices; return it unfinished. */
function scan(...parts: Uint8Array[]): Scanner {
    const s = new Scanner(plan, plan.init.byteLength);
    for (const p of parts) for (let o = 0; o < p.byteLength; o += 1 << 20) s.feed(p.subarray(o, o + (1 << 20)));
    return s;
}

// ---- CPU -----------------------------------------------------------------------

describe('a crafted clip costs no more than a pass over its bytes', () => {
    it('a run declaring 2^32 - 1 samples, 64 times over, costs no time and is not understood', () => {
        const moof = box('moof', traf(ref, 0, [], ...Array.from({ length: 64 }, () => full('trun', 0, 0xffffffff))));
        const t0 = performance.now();
        const { bytes, outcome } = save([init, concat(moof, box('mdat'))]);
        expect(performance.now() - t0).toBeLessThan(1000);
        expect(outcome).toContain('fragments not understood');
        // the duration is the manifest's, not 2^32 samples' worth
        expect(mdhdDuration(bytes, ref)).toBe(Math.round((4000 * plan.tracks.find((t) => t.id === ref)!.timescale) / 1000));
    });

    it('a run with no per-sample fields lasts count x the default — what the per-sample walk gives', () => {
        const d = 1500;
        const closed = save([init, concat(box('moof', traf(ref, 0x8, [d], full('trun', 0, 40), full('trun', 0, 2))), box('mdat'))]);
        expect(closed.outcome).toBe('duration and seek index added');
        expect(mdhdDuration(closed.bytes, ref)).toBe(42 * d);
        // the same 42 samples with their durations written out one by one
        const walked = save([init, concat(box('moof', traf(ref, 0, [], full('trun', 0x100, 42, ...Array<number>(42).fill(d)))), box('mdat'))]);
        expect(mdhdDuration(walked.bytes, ref)).toBe(42 * d);
    });

    it('a part of 24 MiB of 8-byte boxes is read in one pass (the worst case per byte)', () => {
        const part = repeat(box('free'), (24 << 20) / 8);
        const t0 = performance.now();
        const { outcome } = save([init, part]);
        const ms = performance.now() - t0;
        expect(outcome).toBe('duration added (no seek index: too many fragments)');
        // ~0.25 s on a desktop (also in Edge, as one long task, for such a
        // part in a posted clip); the bound is for a slow CI box
        expect(ms).toBeLessThan(5000);
    });
});

// ---- memory ------------------------------------------------------------------------

describe('a crafted clip keeps a bounded record', () => {
    it('a flood of empty moofs: past MAX_MOOFS the scanner stops keeping them', () => {
        const s = scan(repeat(EMPTY_MOOF, MAX_MOOFS + 20_000));
        expect(s.records()).toBeLessThanOrEqual(MAX_MOOFS);
        expect(s.analysisOk()).toBe(false);
        s.finish(4000);
    });

    it('a flood of base-offset fragments: past MAX_PATCHES the scanner gives up', () => {
        const moof = box('moof', repeat(traf(ref, 0x1, [0, 0]), 1000));
        const s = scan(repeat(moof, 80)); // 80,000 base offsets
        expect(s.records()).toBeLessThanOrEqual(80 + plan.maxRefs + 1 + MAX_PATCHES);
        expect(s.analysisOk()).toBe(false);
    });

    it('a flood of index entries: two mfras fit the budget and are rewritten, three are retired whole', () => {
        const moofAt = plan.init.byteLength - plan.shift; // the first moof's offset in the SEALED file
        const mfra = box('mfra', tfra(ref, moofAt, 30_000));
        const s = scan(concat(EMPTY_MOOF, box('mdat')), repeat(mfra, 5)); // 150,000 entries
        expect(s.records()).toBeLessThanOrEqual(1 + MAX_PATCHES);
        let frees = 0, entries = 0;
        for (const p of s.finish(4000)) {
            if (isFree(p.bytes)) frees++;
            else if (p.bytes.byteLength === 4 && u32(p.bytes, 0) === plan.init.byteLength) entries++;
        }
        expect(entries).toBe(60_000);
        expect(frees).toBe(3);
    });

    it('an init stuffed with tiny boxes is not an MP4 this touches: saved exactly as sealed', () => {
        const moovAt = 0 + u32(init, 0); // ftyp, then the moov to the end
        expect(String.fromCharCode(...init.subarray(moovAt + 4, moovAt + 8))).toBe('moov');
        expect(moovAt + u32(init, moovAt)).toBe(init.byteLength);
        const stuffed = concat(init, repeat(box('free'), 5000));
        new DataView(stuffed.buffer).setUint32(moovAt, u32(init, moovAt) + 5000 * 8);
        expect(prepareInit(stuffed, 4000)).toBeNull();
        const media = concat(EMPTY_MOOF, box('mdat'));
        const { bytes, outcome } = save([stuffed.slice(), media.slice()]);
        expect(outcome).toBe('saved as sealed (init not recognised)');
        expect(bytes).toEqual(concat(stuffed, media));
    });

    it('a container of more than MAX_CHILDREN boxes is malformed', () => {
        const ok = repeat(box('free'), MAX_CHILDREN);
        expect(children(ok, 0, ok.byteLength)?.length).toBe(MAX_CHILDREN);
        const tooMany = repeat(box('free'), MAX_CHILDREN + 1);
        expect(children(tooMany, 0, tooMany.byteLength)).toBeNull();
    });
});

// ---- the index and the durations ---------------------------------------------------

describe('a broken index or duration is dropped, never written wrong', () => {
    it('reading stops after an mfra was rewritten: the LAST mfra, found through its mfro, is retired', () => {
        const moofAt = plan.init.byteLength - plan.shift;
        const goodMfra = box('mfra', tfra(ref, moofAt, 1));
        const broken = concat(be32(4), latin('junk')); // a size smaller than its own header
        const t = tfra(ref, moofAt, 1);
        const lastLen = 8 + t.byteLength + 16;
        const lastMfra = box('mfra', t, full('mfro', 0, lastLen));
        expect(lastMfra.byteLength).toBe(lastLen);
        const media = concat(EMPTY_MOOF, box('mdat'));
        const s = scan(media, goodMfra, broken, lastMfra);
        const goodAt = plan.init.byteLength + media.byteLength;
        const lastAt = goodAt + goodMfra.byteLength + broken.byteLength;
        const ps = s.finish(4000);
        expect(ps.some((p) => p.offset === goodAt + 8 + 24 + 4 && u32(p.bytes, 0) === plan.init.byteLength), 'the earlier mfra was rewritten').toBe(true);
        expect(ps.some((p) => p.offset === lastAt + 4 && isFree(p.bytes)), 'the last mfra became a free box').toBe(true);
    });

    it('a tfdt near 2^63 plus one sample: no wrapped, negative duration is used', () => {
        const tfdt = full('tfdt', 0, 0x7fffffff, 0xffffff00);
        tfdt[8] = 1; // version 1: a 64-bit base media decode time
        const moof = box('moof', box('traf', full('tfhd', 0x020000, ref), tfdt, full('trun', 0x100, 1, 0x1000)));
        expect(save([init, concat(moof, box('mdat'))]).outcome).toContain('fragments not understood');
    });

    it('an mfra entry that points at no moof turns the mfra into a free box; the rest of the fix stands', () => {
        const last = clip[clip.length - 1].slice();
        const mfra = last.byteLength - u32(last, last.byteLength - 4);
        const at = mfra + 8 + 24 + 8;
        const dv = new DataView(last.buffer);
        dv.setBigUint64(at, dv.getBigUint64(at) + 1n);
        const { bytes, outcome } = save([...clip.slice(0, -1).map((p) => p.slice()), last]);
        expect(outcome).toBe('duration and seek index added');
        const tail = bytes.byteLength - u32(last, last.byteLength - 4);
        expect(String.fromCharCode(...bytes.subarray(tail + 4, tail + 8))).toBe('free');
    });

    it('only an MP4 by the phone\'s rules gets the fix (QuickTime, HEIF and 3GPP brands do not)', () => {
        const brand = (b: string) => { const p = init.slice(); p.set(latin(b), 8); return p; };
        expect(savesAsMp4(init)).toBe(true);
        expect(savesAsMp4(brand('M4A '))).toBe(true);
        for (const b of ['qt  ', 'heic', 'avif', '3gp4', 'crx ']) expect(savesAsMp4(brand(b)), b).toBe(false);
        expect(savesAsMp4(init.subarray(0, 11))).toBe(false);
    });
});

// ---- slicing and Cancel -----------------------------------------------------------

describe('the scan does not depend on how the bytes arrive, and Cancel reaches inside a part', () => {
    it('the same patches however the parts are sliced', () => {
        const patchesOf = (slice: number) => {
            const s = new Scanner(plan, plan.init.byteLength);
            for (const p of clip.slice(1)) for (let o = 0; o < p.byteLength; o += slice) s.feed(p.subarray(o, o + slice));
            return s.finish(4000).map((p) => `${p.offset}:${Buffer.from(p.bytes).toString('hex')}`).join(';');
        };
        const whole = patchesOf(Number.MAX_SAFE_INTEGER);
        expect(whole.length).toBeGreaterThan(0);
        for (const slice of [1, 3, 7, 8, 9, 15, 16, 17, 64, 100, 1000]) expect(patchesOf(slice), `slices of ${slice} bytes`).toBe(whole);
    });

    it('Cancel inside a part stops the read within a box or two', () => {
        let polls = 0;
        const a = new ClipAssembler(4000, true, () => ++polls > 100);
        a.part(0, init.slice());
        const part = repeat(concat(EMPTY_MOOF, box('mdat')), 10_000);
        expect(() => a.part(1, part)).toThrow(expect.objectContaining({ name: 'AbortError' }));
        expect(polls).toBeLessThanOrEqual(102);
    });

    it('Cancel before a part stops it, fix or no fix', () => {
        let cancelled = false;
        const a = new ClipAssembler(4000, false, () => cancelled);
        a.part(0, init.slice());
        cancelled = true;
        expect(() => a.part(1, EMPTY_MOOF.slice())).toThrow(expect.objectContaining({ name: 'AbortError' }));
    });

    it('parts must arrive in order', () => {
        const a = new ClipAssembler(4000, true);
        expect(() => a.part(1, clip[1])).toThrow(/out of order/);
    });
});

describe('the fix patches the parts it was given, and copies none of them', () => {
    it('every media part handed over IS a chunk of the output (only the init is new)', () => {
        const parts = clip.map((p) => p.slice());
        const a = new ClipAssembler(4000, true);
        parts.forEach((p, i) => a.part(i, p));
        const r = a.finish();
        expect(r.outcome).toBe('duration and seek index added');
        expect(r.chunks.length).toBe(parts.length);
        for (let i = 1; i < parts.length; i++) expect(r.chunks[i], `part ${i}`).toBe(parts[i]);
        expect(r.chunks[0]).not.toBe(parts[0]);
        // the last part's mfra was rewritten in place: its tfra offsets moved
        expect(parts[parts.length - 1]).not.toEqual(clip[clip.length - 1]);
        expect(r.bytes).toBe(r.chunks.reduce((n, c) => n + c.byteLength, 0));
    });
});
