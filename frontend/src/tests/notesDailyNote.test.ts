/**
 * Today's note (notes/model/dailyNote.ts): the title New note fills in, and
 * which existing note counts as today's.
 */
import { describe, it, expect } from 'vitest';
import { dailyTitle, findDailyNote, type DailyCandidate } from '../notes/model/dailyNote';

/** Local wall-clock times: the Date constructor reads them in the machine's
 *  zone, which is the zone the title is written in. */
const at = (y: number, m: number, d: number, hh = 12, mm = 0, ss = 0) => new Date(y, m - 1, d, hh, mm, ss);

type Card = DailyCandidate & { id: string };
const note = (id: string, title: string, extra: Partial<Card> = {}): Card => ({
    id, title, ref: { kind: 'list' }, updatedAt: '2026-10-12T08:00:00Z', ...extra,
});

describe('dailyTitle', () => {
    // 12 October 2026 is a Monday. CLDR versions differ on the comma after
    // the weekday in en-GB, so that one character is left open.
    it('is the long date in the given locale', () => {
        expect(dailyTitle(at(2026, 10, 12), 'en-GB')).toMatch(/^Monday,? 12 October 2026$/);
        expect(dailyTitle(at(2026, 10, 12), 'en-US')).toBe('Monday, October 12, 2026');
        expect(dailyTitle(at(2026, 10, 12), 'de-DE')).toBe('Montag, 12. Oktober 2026');
    });

    it('turns over at LOCAL midnight, not before and not after', () => {
        expect(dailyTitle(at(2026, 10, 12, 23, 59, 59), 'en-US')).toBe('Monday, October 12, 2026');
        expect(dailyTitle(at(2026, 10, 13, 0, 0, 0), 'en-US')).toBe('Tuesday, October 13, 2026');
        expect(dailyTitle(at(2026, 10, 12, 0, 0, 0), 'en-US')).toBe('Monday, October 12, 2026');
        expect(dailyTitle(at(2026, 10, 11, 23, 59, 59), 'en-US')).toBe('Sunday, October 11, 2026');
    });

    it('with no locale, is the device’s own long date', () => {
        const want = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(at(2026, 10, 12));
        expect(dailyTitle(at(2026, 10, 12))).toBe(want);
    });
});

describe('findDailyNote', () => {
    const now = at(2026, 10, 12, 9);
    const today = dailyTitle(now, 'en-GB');
    const yesterday = dailyTitle(at(2026, 10, 11, 9), 'en-GB');

    it('finds the note titled exactly today’s date', () => {
        const notes = [note('a', 'Groceries'), note('b', today), note('c', yesterday)];
        expect(findDailyNote(notes, now, 'en-GB')?.id).toBe('b');
    });

    it('none titled today → null', () => {
        expect(findDailyNote([note('a', 'Groceries'), note('c', yesterday)], now, 'en-GB')).toBeNull();
        expect(findDailyNote([], now, 'en-GB')).toBeNull();
    });

    it('yesterday’s note stops matching at local midnight, and today’s starts', () => {
        const notes = [note('sun', today)];
        expect(findDailyNote(notes, at(2026, 10, 12, 23, 59, 59), 'en-GB')?.id).toBe('sun');
        expect(findDailyNote(notes, at(2026, 10, 13, 0, 0, 0), 'en-GB')).toBeNull();
    });

    it('a note in the trash never matches', () => {
        expect(findDailyNote([note('t', today, { trashed: true })], now, 'en-GB')).toBeNull();
        expect(findDailyNote([note('t', today, { trashed: true, updatedAt: '2026-10-12T09:00:00Z' }), note('live', today)], now, 'en-GB')?.id).toBe('live');
    });

    it('a channel checklist never matches, whatever its name', () => {
        expect(findDailyNote([note('ch', today, { ref: { kind: 'channel' } })], now, 'en-GB')).toBeNull();
    });

    it('only the exact title: a longer one, or another day, is not today’s note', () => {
        expect(findDailyNote([note('x', `${today} — work`), note('y', today.replace(' 2026', ''))], now, 'en-GB')).toBeNull();
    });

    it('surrounding spaces do not stop a match', () => {
        expect(findDailyNote([note('s', ` ${today} `)], now, 'en-GB')?.id).toBe('s');
    });

    it('several match: the most recently edited wins', () => {
        const notes = [
            note('old', today, { updatedAt: '2026-10-12T07:00:00Z' }),
            note('new', today, { updatedAt: '2026-10-12T08:30:00Z' }),
            note('mid', today, { updatedAt: '2026-10-12T08:00:00Z' }),
        ];
        expect(findDailyNote(notes, now, 'en-GB')?.id).toBe('new');
    });

    it('falls back to when it was made, and a note with neither loses', () => {
        const notes = [
            note('none', today, { updatedAt: undefined }),
            note('made', today, { updatedAt: undefined, createdAt: '2026-10-12T06:00:00Z' }),
        ];
        expect(findDailyNote(notes, now, 'en-GB')?.id).toBe('made');
    });
});
