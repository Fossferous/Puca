/**
 * The BST hour-back bug: naive Postgres timestamp text ("2026-07-27 18:45:02")
 * is UTC, but new Date(...) parses zone-less strings as LOCAL time — so every
 * history-loaded message rendered one hour early in Europe/London summer.
 * parseServerTimestamp must pin naive strings to UTC while trusting explicit
 * offsets, in every format the server has ever emitted.
 */
import { describe, it, expect } from 'vitest';
import { parseServerTimestamp, parseServerTimestampSecs } from '../utils/serverTime';

describe('parseServerTimestamp', () => {
    it('treats naive space-separated strings as UTC (old server format)', () => {
        expect(parseServerTimestamp('2026-07-27 18:45:02.741'))
            .toBe(Date.UTC(2026, 6, 27, 18, 45, 2, 741));
    });

    it('treats naive T-separated strings as UTC', () => {
        expect(parseServerTimestamp('2026-07-27T18:45:02'))
            .toBe(Date.UTC(2026, 6, 27, 18, 45, 2));
    });

    it('parses the new Z-suffixed serialization', () => {
        expect(parseServerTimestamp('2026-07-27T18:45:02.741Z'))
            .toBe(Date.UTC(2026, 6, 27, 18, 45, 2, 741));
    });

    it('parses microsecond precision (Postgres ::text carries 6 digits)', () => {
        expect(parseServerTimestamp('2026-07-27 18:45:02.741048'))
            .toBe(Date.UTC(2026, 6, 27, 18, 45, 2, 741));
    });

    it('normalizes Postgres timestamptz bare-hours offset ("+00")', () => {
        expect(parseServerTimestamp('2026-07-27 18:45:02+00'))
            .toBe(Date.UTC(2026, 6, 27, 18, 45, 2));
    });

    it('respects a real explicit offset', () => {
        expect(parseServerTimestamp('2026-07-27T18:45:02+01:00'))
            .toBe(Date.UTC(2026, 6, 27, 17, 45, 2));
    });

    it('treats a DATE-ONLY string as naive UTC midnight (the "-27" is not an offset)', () => {
        expect(parseServerTimestamp('2026-07-27')).toBe(Date.UTC(2026, 6, 27));
    });

    it('returns NaN for empty/null', () => {
        expect(parseServerTimestamp('')).toBeNaN();
        expect(parseServerTimestamp(null)).toBeNaN();
        expect(parseServerTimestamp(undefined)).toBeNaN();
    });

    it('seconds variant divides by 1000', () => {
        expect(parseServerTimestampSecs('2026-07-27T18:45:02Z'))
            .toBe(Date.UTC(2026, 6, 27, 18, 45, 2) / 1000);
    });

    /**
     * Anti-vacuity: prove the helper actually CHANGES behaviour rather than
     * agreeing with the expression it replaced.
     *
     * This has to be written carefully, because the drift it measures is zero
     * in a UTC environment — which is exactly what CI and the production
     * server run. An unguarded `toBe(-offsetMin * 60_000)` there compares
     * `0` against `-0`, which are NOT equal under Object.is, so it failed in
     * CI while passing on a British developer machine in BST. The guard the
     * original comment described was never actually implemented.
     *
     * So: assert the drift only where a drift exists, and always assert the
     * invariant that matters — naive text is pinned to UTC regardless of the
     * machine's zone. That second assertion is meaningful in every timezone,
     * including UTC, so this test can never go vacuous.
     */
    it('pins naive text to UTC, and drifts from the old expression off-UTC', () => {
        const naive = '2026-07-27 18:45:02';
        const parsed = parseServerTimestamp(naive);

        // Timezone-independent: the real contract.
        expect(parsed).toBe(Date.UTC(2026, 6, 27, 18, 45, 2));

        // getTimezoneOffset is UTC-minus-local (BST → -60): local-parsed naive
        // text lands the instant EARLIER by the positive offset, so
        // parse(UTC) - old(local) = -offset minutes. Zero in UTC, where the
        // old expression was never wrong in the first place.
        const offsetMin = new Date(Date.UTC(2026, 6, 27)).getTimezoneOffset();
        const drift = parsed - new Date(naive).getTime();
        if (offsetMin === 0) {
            expect(drift).toBe(0);
        } else {
            expect(drift).toBe(-offsetMin * 60_000);
            expect(drift).not.toBe(0);   // the bug really was reachable here
        }
    });
});
