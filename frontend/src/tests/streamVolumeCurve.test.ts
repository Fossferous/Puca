/**
 * The Stream Volume slider follows loudness, and each person's level is
 * theirs (streamVolumeStore.ts).
 *
 * The owner, 2026-10-26: "Yes, follow loudness" and "Per person, new = my
 * last level". Before, a level was a linear gain (p % played at p/100), so
 * everything from silence to -20 dB was squeezed into the bottom tenth of
 * the slider (1 -> 2 % was +6 dB, 50 -> 51 % +0.17 dB) and the whole
 * 100-200 % half held only +6 dB. Now a position plays at (p/100)^2 up to
 * 100 % and 2^((p-100)/100) above it, every level saved before is converted
 * ONCE so it plays at the gain it had, and someone you have never set starts
 * at the last level you set on anyone — seeded once, then theirs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { memoryLocalStorage } from './fixtures/fakeSink';
import {
    DEFAULT_STREAM_VOLUME, MAX_STREAM_VOLUME, getLastStreamVolume, getStreamVolumes, levelForGain,
    seedStreamVolumes, setStreamVolume, streamGain, streamVolumeKeyStep,
} from '../components/streamVolumeStore';

const dB = (gain: number) => 20 * Math.log10(gain);
const LEGACY = 'sovereign_stream_volumes';
const RECORD = 'sovereign_stream_levels';

beforeEach(() => { vi.stubGlobal('localStorage', memoryLocalStorage()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('the loudness curve', () => {
    it('its points: silence, -12 dB at 50%, unity at 100%, +3 dB at 150%, +6 dB at 200%', () => {
        expect(streamGain(0)).toBe(0);
        expect(streamGain(50)).toBeCloseTo(0.25, 12);
        expect(dB(streamGain(50))).toBeCloseTo(-12.04, 2);
        expect(dB(streamGain(10))).toBeCloseTo(-40, 6);
        expect(streamGain(100)).toBe(1);
        expect(streamGain(150)).toBeCloseTo(Math.SQRT2, 12);
        expect(dB(streamGain(150))).toBeCloseTo(3.01, 2);
        expect(streamGain(200)).toBeCloseTo(2, 12);
        expect(dB(streamGain(200))).toBeCloseTo(6.02, 2);
    });

    it('square-law below 100%; even in decibels above it (each 10% another 0.6 dB)', () => {
        for (let p = 0; p <= 100; p += 5) expect(streamGain(p)).toBeCloseTo((p / 100) ** 2, 12);
        for (let p = 100; p < 200; p += 10) {
            expect(dB(streamGain(p + 10)) - dB(streamGain(p))).toBeCloseTo(6.0206 / 10, 3);
        }
    });

    it('rises with the slider at every 1% step, and is continuous at 100%', () => {
        for (let p = 1; p <= MAX_STREAM_VOLUME; p++) expect(streamGain(p)).toBeGreaterThan(streamGain(p - 1));
        expect(streamGain(99.999)).toBeCloseTo(1, 4);
        expect(streamGain(100.001)).toBeCloseTo(1, 4);
    });

    it('at the same loudness, a 1% step is now much smaller where the linear slider jumped', () => {
        // At -40 dB: linear sat at 1%, and a step to 2% was +6.0 dB; the curve
        // sits at 10%, and a step to 11% is +1.7 dB.
        expect(dB(0.02) - dB(0.01)).toBeCloseTo(6.02, 2);
        expect(dB(streamGain(10))).toBeCloseTo(-40, 6);
        expect(dB(streamGain(11)) - dB(streamGain(10))).toBeCloseTo(1.66, 2);
        // At -20 dB: linear at 10% (+0.83 dB a step), the curve at 31.6% (+0.54).
        expect(dB(0.11) - dB(0.10)).toBeCloseTo(0.83, 2);
        const p = levelForGain(0.1);
        expect(p).toBeCloseTo(31.62, 2);
        expect(dB(streamGain(p + 1)) - dB(streamGain(p))).toBeCloseTo(0.54, 2);
    });

    it('nothing outside 0-200% plays: below 0 is silence, above 200 is 200', () => {
        expect(streamGain(-5)).toBe(0);
        expect(streamGain(Number.NaN)).toBe(0);
        expect(streamGain(500)).toBeCloseTo(2, 12);
    });

    it('levelForGain is its inverse', () => {
        for (let p = 0; p <= MAX_STREAM_VOLUME; p += 0.5) expect(levelForGain(streamGain(p))).toBeCloseTo(p, 9);
        expect(levelForGain(0.3)).toBeCloseTo(100 * Math.sqrt(0.3), 12); // 54.77
        expect(levelForGain(1.5)).toBeCloseTo(100 + 100 * Math.log2(1.5), 12); // 158.50
        expect(levelForGain(0)).toBe(0);
    });
});

describe('the one-time conversion of the levels saved before the curve', () => {
    const before = { 1: 30, 2: 150, 3: 0, 4: 100, 5: 200, 6: 55 };

    it('every saved level plays at exactly the gain it played at (new = 100·√(old/100) below 100%, 100 + 100·log2(old/100) above)', () => {
        localStorage.setItem(LEGACY, JSON.stringify(before));
        const levels = getStreamVolumes();
        for (const [id, old] of Object.entries(before)) {
            expect(streamGain(levels[Number(id)]), `user ${id} at ${old}%`).toBeCloseTo(old / 100, 12);
        }
        expect(levels[1]).toBeCloseTo(54.772, 3);
        expect(levels[2]).toBeCloseTo(158.496, 3);
        expect(levels[3]).toBe(0);
        expect(levels[4]).toBe(100);
        expect(levels[5]).toBeCloseTo(200, 12);
    });

    it('runs once: done is marked by the new record, so nothing is converted twice', () => {
        localStorage.setItem(LEGACY, JSON.stringify(before));
        const first = getStreamVolumes();
        expect(localStorage.getItem(RECORD), 'the mark').not.toBeNull();
        // Reading again (every pass, every mount) changes nothing.
        expect(getStreamVolumes()).toEqual(first);
        expect(getStreamVolumes()).toEqual(first);
        // A level set after it is kept as set, not converted.
        setStreamVolume(1, 30);
        expect(getStreamVolumes()[1]).toBe(30);
        expect(getStreamVolumes()[1]).toBe(30);
    });

    it('never reads the old levels again, and never writes them (a release before the curve still finds its own)', () => {
        localStorage.setItem(LEGACY, JSON.stringify(before));
        getStreamVolumes();
        setStreamVolume(2, 90);
        expect(JSON.parse(localStorage.getItem(LEGACY)!)).toEqual(before);
        // An old build writing its linear levels afterwards changes nothing here.
        localStorage.setItem(LEGACY, JSON.stringify({ 1: 100, 9: 20 }));
        expect(getStreamVolumes()[1]).toBeCloseTo(54.772, 3);
        expect(getStreamVolumes()[9]).toBeUndefined();
    });

    it('nothing saved before: an empty record, marked done', () => {
        expect(getStreamVolumes()).toEqual({});
        expect(JSON.parse(localStorage.getItem(RECORD)!)).toEqual({ levels: {} });
    });

    it('junk in the old store is dropped, not converted into a level', () => {
        localStorage.setItem(LEGACY, JSON.stringify({ 1: 'loud', 2: null, 3: 70 }));
        expect(getStreamVolumes()).toEqual({ 3: levelForGain(0.7) });
        localStorage.setItem(RECORD, '{not json');
        expect(getStreamVolumes(), 'an unreadable record is rebuilt from the same source').toEqual({ 3: levelForGain(0.7) });
    });
});

describe('per person, and someone new starts at the last level set', () => {
    it('a set level is that person’s, and the last level', () => {
        setStreamVolume(7, 40);
        expect(getStreamVolumes()).toEqual({ 7: 40 });
        expect(getLastStreamVolume()).toBe(40);
        expect(JSON.parse(localStorage.getItem(RECORD)!)).toEqual({ levels: { 7: 40 }, last: 40 });
    });

    it('before anyone was set, a new person is seeded at 100%', () => {
        expect(getLastStreamVolume()).toBeNull();
        seedStreamVolumes([8]);
        expect(getStreamVolumes()[8]).toBe(DEFAULT_STREAM_VOLUME);
    });

    it('a new person picks up the last level; a seed never changes the last level', () => {
        setStreamVolume(7, 40);
        setStreamVolume(9, 120);
        seedStreamVolumes([8]);
        expect(getStreamVolumes()[8]).toBe(120);
        expect(getLastStreamVolume()).toBe(120);
    });

    it('an adjusted person keeps theirs, and a seeded one is seeded only once', () => {
        setStreamVolume(7, 40);
        seedStreamVolumes([7, 8]); // 7 is set: untouched; 8 is new: 40
        expect(getStreamVolumes()).toEqual({ 7: 40, 8: 40 });
        setStreamVolume(9, 150); // the last level moves on
        seedStreamVolumes([8]); // watched again: still 40
        expect(getStreamVolumes()).toEqual({ 7: 40, 8: 40, 9: 150 });
    });

    it('survives a reload: a fresh copy of the code reads the same levels and the same last level', async () => {
        setStreamVolume(7, 33);
        vi.resetModules();
        const fresh = await import('../components/streamVolumeStore');
        expect(fresh.getStreamVolumes()).toEqual({ 7: 33 });
        expect(fresh.getLastStreamVolume()).toBe(33);
        fresh.seedStreamVolumes([8]);
        expect(fresh.getStreamVolumes()[8]).toBe(33);
    });
});

describe('the slider still steps 1% on the curve (the keys move the POSITION)', () => {
    it('arrows 1%, Page Up / Page Down 10%, Home / End the ends, modifiers left alone', () => {
        expect(streamVolumeKeyStep({ key: 'ArrowUp' }, 55, 200)).toBe(56);
        expect(streamVolumeKeyStep({ key: 'ArrowLeft' }, 55, 200)).toBe(54);
        expect(streamVolumeKeyStep({ key: 'PageUp' }, 55, 200)).toBe(65);
        expect(streamVolumeKeyStep({ key: 'PageDown' }, 5, 200)).toBe(0);
        expect(streamVolumeKeyStep({ key: 'End' }, 55, 100)).toBe(100);
        expect(streamVolumeKeyStep({ key: 'Home' }, 55, 200)).toBe(0);
        expect(streamVolumeKeyStep({ key: 'PageUp', ctrlKey: true }, 55, 200)).toBeNull();
        expect(streamVolumeKeyStep({ key: 'a' }, 55, 200)).toBeNull();
    });
});
