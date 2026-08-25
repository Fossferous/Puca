import { describe, it, expect } from 'vitest';
import { evictionPlan, ringBytes, ringDurationUs, selectWindow, trimLeadingAudio, type GopUnit } from '../api/clips/clipRing';

/** Synthetic GOP units, 2 s each, `bytes` ciphertext each. */
function ring(count: number, opts: { gopUs?: number; bytes?: number; configIds?: number[]; startUs?: number } = {}): GopUnit[] {
    const gopUs = opts.gopUs ?? 2_000_000;
    const bytes = opts.bytes ?? 1000;
    const out: GopUnit[] = [];
    for (let i = 0; i < count; i++) {
        const startUs = (opts.startUs ?? 0) + i * gopUs;
        out.push({
            seq: i,
            configId: opts.configIds?.[i] ?? 1,
            startUs,
            endUs: startUs + gopUs,
            video: [{ tsUs: startUs, durUs: 33_333, len: 100, key: true }, { tsUs: startUs + 33_333, durUs: 33_333, len: 10, key: false }],
            audio: [{ tsUs: startUs, durUs: 20_000, len: 5, key: false }],
            counter: i,
            blob: new Uint8Array(bytes),
            plainLen: bytes - 16,
        });
    }
    return out;
}

describe('clipRing — eviction', () => {
    it('evicts oldest units until duration fits, never below one unit', () => {
        const g = ring(10); // 20 s
        const plan = evictionPlan(g, { maxDurationUs: 6_000_000, maxBytes: Infinity });
        expect(plan.map(u => u.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]); // leaves 3 units = 6 s
        expect(evictionPlan(ring(1), { maxDurationUs: 1, maxBytes: 1 })).toEqual([]);
    });
    it('evicts by bytes when memory binds first', () => {
        const g = ring(5, { bytes: 1000 }); // 5000 B
        const plan = evictionPlan(g, { maxDurationUs: Infinity, maxBytes: 2500 });
        expect(plan.map(u => u.seq)).toEqual([0, 1, 2]);
        expect(ringBytes(g.slice(3))).toBe(2000);
    });
    it('does nothing when the ring fits (positive control)', () => {
        const g = ring(3);
        expect(evictionPlan(g, { maxDurationUs: 10_000_000, maxBytes: 10_000 })).toEqual([]);
        expect(ringDurationUs(g)).toBe(6_000_000);
    });
});

describe('clipRing — window selection', () => {
    it('picks the GOP that CONTAINS the requested start (boundary is <=, not <)', () => {
        const g = ring(5); // units start at 0,2,4,6,8 s; end 10 s
        // want the last 4 s → wantStart = 6 s exactly → unit starting at 6 s
        const exact = selectWindow(g, 4_000_000)!;
        expect(exact.from).toBe(3); expect(exact.leadInUs).toBe(0); expect(exact.to).toBe(4);
        // want 3.99 s → wantStart = 6.01 s, 10 ms AFTER the 6 s keyframe → still the 6 s unit
        const after = selectWindow(g, 3_990_000)!;
        expect(after.from).toBe(3); expect(after.leadInUs).toBe(10_000);
        // want 4.01 s → wantStart = 5.99 s → the unit BEFORE (starts at 4 s), lead-in 1.99 s
        const before = selectWindow(g, 4_010_000)!;
        expect(before.from).toBe(2); expect(before.leadInUs).toBe(1_990_000);
    });
    it('never seals PAST the server cap: a max-length request whose snap-back adds a lead-in advances one GOP instead (review #1)', () => {
        const g = ring(5); // 0..10 s in 2 s GOPs
        // want 4.01 s with a 4 s cap: snap-back would give 6 s (from unit 2) → over the cap → unit 3 (4 s exactly)
        const capped = selectWindow(g, 4_010_000, 4_000_000)!;
        expect(capped.from).toBe(3);
        expect(capped.endUs - capped.startUs).toBe(4_000_000);
        expect(capped.leadInUs).toBe(0);
        // (positive control) without the cap the same request snaps back to unit 2 = 6 s
        const uncapped = selectWindow(g, 4_010_000)!;
        expect(uncapped.from).toBe(2);
        expect(uncapped.endUs - uncapped.startUs).toBe(6_000_000);
        // a cap larger than the ring changes nothing
        expect(selectWindow(g, 4_010_000, 60_000_000)!.from).toBe(2);
        // the cap can never make the selection empty: at worst it is the last unit
        expect(selectWindow(g, 4_010_000, 1)!.from).toBe(4);
    });
    it('reports the REAL duration when the ring is shorter than requested', () => {
        const g = ring(3); // 6 s
        const w = selectWindow(g, 60_000_000)!;
        expect(w.from).toBe(0);
        expect(w.endUs - w.startUs).toBe(6_000_000);
        expect(w.leadInUs).toBe(0);
    });
    it('clamps to the newest configId and reports lostUs', () => {
        const g = ring(6, { configIds: [1, 1, 1, 2, 2, 2] });
        const w = selectWindow(g, 10_000_000)!; // wants from 2 s (unit 1, config 1)
        expect(w.from).toBe(3);
        expect(w.lostUs).toBe(4_000_000); // units 1,2 (2 s each) unusable
        expect(w.endUs - w.startUs).toBe(6_000_000);
    });
    it('returns null on an empty ring', () => {
        expect(selectWindow([], 1)).toBeNull();
    });
});

describe('clipRing — audio trim', () => {
    it('drops only entries that end at or before the start', () => {
        const entries = [
            { tsUs: 0, durUs: 20_000, len: 1, key: false },        // ends 20 ms — before start 30 ms → dropped
            { tsUs: 20_000, durUs: 20_000, len: 1, key: false },   // ends 40 ms — overlaps → kept
            { tsUs: 40_000, durUs: 20_000, len: 1, key: false },
        ];
        expect(trimLeadingAudio(entries, 30_000).map(e => e.tsUs)).toEqual([20_000, 40_000]);
        // exactly at the boundary: an entry ending precisely at start is dropped
        expect(trimLeadingAudio(entries, 20_000).map(e => e.tsUs)).toEqual([20_000, 40_000]);
        expect(trimLeadingAudio(entries, 40_000).map(e => e.tsUs)).toEqual([40_000]);
    });
});
