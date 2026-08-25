import { describe, it, expect } from 'vitest';
import { CLIP_PRESETS, DEFAULT_CLIP_PRESET, GIB, MIB, SEAL_HEADROOM_BYTES, clipPreset, estimateRing, maxRingBytesForBudget, memoryBudgetBytes, presetBytesPerSecond, formatMB, formatClock } from '../api/clips/clipPresets';

describe('clipPresets — ring estimate', () => {
    const p1080 = clipPreset('1080p30');
    it('does NOT bind when the wanted length fits (positive control)', () => {
        const e = estimateRing(p1080, 300, 4 * GIB);
        expect(e.boundBy).toBe('seconds');
        expect(e.seconds).toBe(300);
        // (6 000 000 + 128 000) / 8 × 300 ≈ 229.8 MB
        expect(e.bytes / MIB).toBeGreaterThan(218);
        expect(e.bytes / MIB).toBeLessThan(221);
    });
    it('binds by bytes when the cap is smaller', () => {
        const e = estimateRing(clipPreset('1440p30'), 300, 256 * MIB);
        expect(e.boundBy).toBe('bytes');
        expect(e.seconds).toBeLessThan(300);
        expect(e.bytes).toBeLessThanOrEqual(256 * MIB);
        expect(e.wantBytes).toBeGreaterThan(256 * MIB);
    });
    it('falls back to the default preset for unknown ids', () => {
        expect(clipPreset('nope').id).toBe(DEFAULT_CLIP_PRESET);
        expect(clipPreset(undefined).id).toBe(DEFAULT_CLIP_PRESET);
        expect(CLIP_PRESETS.map(p => p.id)).toContain('720p30');
    });
    it('bytes-per-second includes audio', () => {
        expect(presetBytesPerSecond(p1080)).toBe((6_000_000 + 128_000) / 8);
    });
});

describe('clipPresets — memory budget', () => {
    it('is computed in BYTES from navigator.deviceMemory (GiB), 40 %', () => {
        expect(memoryBudgetBytes(8)).toBe(Math.floor(0.4 * 8 * GIB));
        expect(memoryBudgetBytes(32)).toBe(Math.floor(0.4 * 32 * GIB));
    });
    it('falls back to 4 GiB when deviceMemory is missing (Firefox/Safari)', () => {
        expect(memoryBudgetBytes(undefined)).toBe(Math.floor(0.4 * 4 * GIB));
        expect(memoryBudgetBytes(null)).toBe(memoryBudgetBytes(undefined));
        expect(memoryBudgetBytes(0)).toBe(memoryBudgetBytes(undefined));
    });
    it('the largest ring the budget allows leaves room to double for the seal', () => {
        const budget = memoryBudgetBytes(8); // 3.2 GiB
        const max = maxRingBytesForBudget(budget);
        expect(2 * max + SEAL_HEADROOM_BYTES).toBeLessThanOrEqual(budget);
        expect(2 * (max + 1) + SEAL_HEADROOM_BYTES).toBeGreaterThan(budget);
        expect(maxRingBytesForBudget(0)).toBe(0);
    });
    it('formats', () => {
        expect(formatMB(230 * MIB)).toBe('230 MB');
        expect(formatMB(1.5 * GIB)).toBe('1.50 GB');
        expect(formatClock(300)).toBe('5:00');
        expect(formatClock(167.4)).toBe('2:47');
    });
});
