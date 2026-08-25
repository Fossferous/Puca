// Unit tests for the device-local place store behind location reminders:
// storage parsing (malformed blobs must degrade, never throw) and the pure
// assignments × places → fences join the native push is built from. The
// geofence ENGINE is native Java — its tests live in
// frontend/android/app/src/test/ (GeofenceEngineTest, run with `gradlew
// test`), not here.
import { describe, it, expect } from 'vitest';
import {
    parseStoredPlaces, parseStoredAssignments, planFences, clampRadius,
    MIN_PLACE_RADIUS_M, MAX_PLACE_RADIUS_M, DEFAULT_PLACE_RADIUS_M, MAX_FENCES,
    type TaskPlace,
} from '../api/taskPlaces';

function place(id: string, overrides: Partial<TaskPlace> = {}): TaskPlace {
    return { id, label: `place ${id}`, lat: 51.5, lon: -0.12, radiusM: 150, ...overrides };
}

describe('parseStoredPlaces', () => {
    it('round-trips a valid list', () => {
        const places = [place('a'), place('b', { lat: -33.9, lon: 151.2, radiusM: 300 })];
        expect(parseStoredPlaces(JSON.stringify(places))).toEqual(places);
    });

    it('degrades malformed input to an empty list', () => {
        expect(parseStoredPlaces(null)).toEqual([]);
        expect(parseStoredPlaces('')).toEqual([]);
        expect(parseStoredPlaces('not json {')).toEqual([]);
        expect(parseStoredPlaces('"a string"')).toEqual([]);
        expect(parseStoredPlaces('{"id":"a"}')).toEqual([]); // object, not array
    });

    it('drops entries with missing or out-of-range fields, keeps the valid', () => {
        const good = place('ok');
        const noisy = JSON.stringify([
            good,
            { ...place('badlat'), lat: 91 },
            { ...place('badlon'), lon: -200 },
            { ...place('nanlat'), lat: 'x' },
            { id: '', label: 'no id', lat: 0, lon: 0, radiusM: 150 },
            null,
            42,
        ]);
        expect(parseStoredPlaces(noisy)).toEqual([good]);
    });

    it('clamps stored radii and strips unknown fields (canonical shape)', () => {
        const stored = JSON.stringify([{ ...place('a'), radiusM: 5, evil: '<script>' }]);
        expect(parseStoredPlaces(stored)).toEqual([place('a', { radiusM: MIN_PLACE_RADIUS_M })]);
    });
});

describe('parseStoredAssignments', () => {
    it('round-trips and filters non-string values', () => {
        expect(parseStoredAssignments('{"7":"a","8":42,"9":""}')).toEqual({ '7': 'a' });
        expect(parseStoredAssignments(null)).toEqual({});
        expect(parseStoredAssignments('[]')).toEqual({});
        expect(parseStoredAssignments('nope')).toEqual({});
    });
});

describe('clampRadius', () => {
    it('holds the band and defaults the unusable', () => {
        expect(clampRadius(50)).toBe(MIN_PLACE_RADIUS_M);
        expect(clampRadius(150)).toBe(150);
        expect(clampRadius(999_999)).toBe(MAX_PLACE_RADIUS_M);
        expect(clampRadius(NaN)).toBe(DEFAULT_PLACE_RADIUS_M);
        expect(clampRadius(Infinity)).toBe(DEFAULT_PLACE_RADIUS_M);
    });
});

describe('planFences (the native push)', () => {
    const places = [place('a'), place('b', { lat: 48.9, lon: 2.35 })];

    it('joins assignments to places, content-free (task id + circle only)', () => {
        const fences = planFences({ '7': 'a', '9': 'b' }, places, true);
        expect(fences).toEqual([
            { id: '7', lat: 51.5, lon: -0.12, radiusM: 150 },
            { id: '9', lat: 48.9, lon: 2.35, radiusM: 150 },
        ]);
        // The label must never reach the native layer.
        for (const f of fences) expect(Object.keys(f).sort()).toEqual(['id', 'lat', 'lon', 'radiusM']);
    });

    it('disabled collapses to [] — the "setting off / signed out" clear', () => {
        expect(planFences({ '7': 'a' }, places, false)).toEqual([]);
    });

    it('skips assignments whose place was deleted', () => {
        expect(planFences({ '7': 'gone' }, places, true)).toEqual([]);
    });

    it('caps at the OS geofence limit instead of erroring', () => {
        const many = Object.fromEntries(
            Array.from({ length: MAX_FENCES + 20 }, (_, i) => [String(i), 'a']));
        expect(planFences(many, places, true)).toHaveLength(MAX_FENCES);
    });
});
