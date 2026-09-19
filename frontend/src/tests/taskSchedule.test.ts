import { describe, expect, it } from 'vitest';
import {
    type EventSchedule, SCHEDULE_BUCKETS, activeSnooze, deriveDueAt, effectiveReminderMs, nextOccurrence, nextReminderAfter,
    occurrencesBetween, padToBucket, parseSchedule, parseSnooze, planCompletion, serializeSchedule, serializeSnooze, snoozeUntil,
} from '../api/taskSchedule';
import { ENC_KEY_UNAVAILABLE } from '../api/decryptMarkers';
import { instantToWall, formatWall } from '../utils/calendarMath';

const base: EventSchedule = { v: 1, kind: 'event', uid: 'uid-0001-abcd', allDay: false, start: '2026-10-05T15:00', end: '2026-10-05T16:00', tz: 'America/New_York' };
const T = (s: string) => Date.parse(s);
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('parseSchedule — strict, read-only when it cannot be trusted', () => {
    it('round-trips a valid schedule and PRESERVES unknown keys', () => {
        const plain = serializeSchedule(base, { color: 'mint', future: { nested: [1, 2] } });
        const p = parseSchedule(plain);
        expect(p.state).toBe('ok');
        if (p.state !== 'ok') return;
        expect(p.schedule).toEqual(base);
        expect(p.raw).toEqual({ color: 'mint', future: { nested: [1, 2] } });
        // Edit a known field, keep the unknown ones.
        const again = parseSchedule(serializeSchedule({ ...p.schedule, location: 'Room 2' }, p.raw));
        expect(again.state === 'ok' && again.raw.color).toBe('mint');
        expect(again.state === 'ok' && again.schedule.location).toBe('Room 2');
    });

    it('a newer version, garbage, a marker, or a swapped payload is READ-ONLY, never "none"', () => {
        const newer = JSON.stringify({ ...base, v: 2 });
        expect(parseSchedule(newer)).toMatchObject({ state: 'readonly', reason: expect.stringMatching(/Update Púca/) });
        expect(parseSchedule('not json').state).toBe('readonly');
        expect(parseSchedule('[1,2]').state).toBe('readonly');
        expect(parseSchedule(ENC_KEY_UNAVAILABLE).state).toBe('readonly');
        // A server that swapped the snooze ciphertext into the schedule column
        // (same key for a self-sealed pair) yields a snooze plaintext here.
        expect(parseSchedule(serializeSnooze({ forDue: '2026-10-05T19:00:00.000Z', until: '2026-10-05T20:00:00.000Z' })).state).toBe('readonly');
        // An attachments sidecar or a description, likewise.
        expect(parseSchedule('[{"href":"x","name":"y"}]').state).toBe('readonly');
        expect(parseSchedule(null)).toEqual({ state: 'none' });
    });

    it('validates types, caps and consistency', () => {
        const bad = (patch: Record<string, unknown>) => parseSchedule(JSON.stringify({ ...base, ...patch })).state;
        expect(bad({ kind: 'meeting' })).toBe('readonly');
        expect(bad({ tz: 'Mars/Olympus' })).toBe('readonly');
        expect(bad({ tz: undefined })).toBe('readonly');                     // timed without a zone
        expect(bad({ end: '2026-10-05T14:00' })).toBe('readonly');           // end before start
        expect(bad({ allDay: true })).toBe('readonly');                      // all-day with a timed start
        expect(bad({ rrule: 'FREQ=HOURLY' })).toBe('readonly');
        expect(bad({ exdates: Array(201).fill('2026-10-06T15:00') })).toBe('readonly');
        expect(bad({ alerts: [1, 2, 3, 4, 5, 6] })).toBe('readonly');
        expect(bad({ location: 'x'.repeat(501) })).toBe('readonly');
        expect(bad({ _pad: 'xx' })).toBe('readonly');
        expect(bad({ location: 'x'.repeat(500), alerts: [10], rrule: 'FREQ=WEEKLY' })).toBe('ok');
        const allDay = { v: 1, kind: 'event', uid: 'uid-0001-abcd', allDay: true, start: '2026-10-05', end: '2026-10-08', alertTz: 'Europe/Dublin' };
        expect(parseSchedule(JSON.stringify(allDay)).state).toBe('ok');
        expect(parseSchedule(JSON.stringify({ ...allDay, tz: 'Europe/Dublin' })).state).toBe('readonly');
    });

    it('serializeSchedule refuses to seal an invalid schedule', () => {
        expect(() => serializeSchedule({ ...base, end: '2026-10-05T14:00' })).toThrow(/invalid/);
    });
});

describe('padding to size buckets', () => {
    it('lands EXACTLY on 256 / 1024 / 4096 / 8192 bytes, counting UTF-8', () => {
        expect(bytes(padToBucket({ a: 1 }))).toBe(256);
        expect(bytes(padToBucket({ a: 'x'.repeat(300) }))).toBe(1024);
        expect(bytes(padToBucket({ a: 'é'.repeat(600) }))).toBe(4096);   // 1200 bytes of UTF-8
        expect(bytes(padToBucket({ a: 'x'.repeat(5000) }))).toBe(8192);
        expect(() => padToBucket({ a: 'x'.repeat(8200) })).toThrow(/too large/);
        expect(SCHEDULE_BUCKETS).toEqual([256, 1024, 4096, 8192]);
    });

    it('the worst valid schedule still fits the top bucket', () => {
        const worst: EventSchedule = {
            ...base, rrule: 'FREQ=DAILY', location: 'ü'.repeat(500), alerts: [1, 2, 3, 4, 5],
            exdates: Array.from({ length: 200 }, (_, i) => `2027-01-01T15:00`.replace('01-01', `0${1 + (i % 9)}-1${i % 10}`)),
        };
        expect(bytes(serializeSchedule(worst))).toBe(8192);
    });

    it('a snooze pads to 128', () => {
        expect(bytes(serializeSnooze({ forDue: '2026-10-05T19:00:00.000Z', until: '2026-10-05T20:00:00.000Z' }))).toBe(128);
    });
});

describe('derived due_at — the next reminder instant', () => {
    it('start minus the alert, in the event zone', () => {
        const s = { ...base, alerts: [10] };
        expect(deriveDueAt(s, T('2026-10-01T00:00:00Z'))).toBe('2026-10-05T18:50:00.000Z');   // 15:00 EDT − 10 min
    });

    it('private timing, no alerts, or a finished series give null', () => {
        expect(deriveDueAt({ ...base, alerts: [10], privateTiming: true }, T('2026-10-01T00:00:00Z'))).toBeNull();
        expect(deriveDueAt(base, T('2026-10-01T00:00:00Z'))).toBeNull();
        expect(deriveDueAt({ ...base, alerts: [10] }, T('2026-10-06T00:00:00Z'))).toBeNull();
        expect(deriveDueAt({ ...base, alerts: [10], rrule: 'FREQ=DAILY;COUNT=2' }, T('2026-10-07T00:00:00Z'))).toBeNull();
    });

    it('several alerts: the earliest one still ahead', () => {
        const s = { ...base, alerts: [60, 10] };
        expect(deriveDueAt(s, T('2026-10-05T18:00:00Z'))).toBe('2026-10-05T18:50:00.000Z');   // the 1 h one passed
        expect(deriveDueAt(s, T('2026-10-05T17:00:00Z'))).toBe('2026-10-05T18:00:00.000Z');
    });

    it('a weekly series walks forward, and skips an excluded week', () => {
        const s = { ...base, alerts: [0], rrule: 'FREQ=WEEKLY', exdates: ['2026-10-12T15:00'] };
        expect(nextReminderAfter(s, T('2026-10-05T19:00:00Z'))).toBe(T('2026-10-19T19:00:00Z'));
        // After the US DST change (Nov 1) the same 15:00 is 20:00 UTC.
        expect(nextReminderAfter(s, T('2026-11-01T00:00:00Z'))).toBe(T('2026-11-02T20:00:00Z'));
    });

    it('an all-day alert is computed in the STORED alert zone, whoever derives it', () => {
        const s: EventSchedule = { v: 1, kind: 'event', uid: 'uid-0002-abcd', allDay: true, start: '2026-10-05', alertTz: 'Europe/Dublin', alerts: [-540] };
        // 09:00 in Dublin (IST, +01) — the same instant for a device in New York or Tokyo.
        expect(deriveDueAt(s, T('2026-10-01T00:00:00Z'))).toBe('2026-10-05T08:00:00.000Z');
    });

    it('a repeating task reminds at its due time by default and skips what is done', () => {
        const t: EventSchedule = { v: 1, kind: 'task', uid: 'uid-0003-abcd', allDay: false, start: '2026-10-05T09:00', tz: 'Europe/Dublin', rrule: 'FREQ=DAILY', doneThrough: '2026-10-06T09:00' };
        expect(nextReminderAfter(t, T('2026-10-01T00:00:00Z'))).toBe(T('2026-10-07T08:00:00Z'));
    });
});

describe('occurrences for the calendar', () => {
    it('a multi-day all-day event covers each of its days', () => {
        const s: EventSchedule = { v: 1, kind: 'event', uid: 'uid-0004-abcd', allDay: true, start: '2026-10-05', end: '2026-10-08', alertTz: 'UTC' };
        const occ = occurrencesBetween(s, T('2026-10-01T00:00:00Z'), T('2026-11-01T00:00:00Z'));
        expect(occ).toHaveLength(1);
        expect(occ[0].dayKeys).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    });

    it('an overnight timed event (23:00–01:00) is two hours long and overlaps both days', () => {
        const s = { ...base, start: '2026-10-05T23:00', end: '2026-10-06T01:00' };
        const [o] = occurrencesBetween(s, T('2026-10-06T04:30:00Z'), T('2026-10-06T05:30:00Z'));
        expect(o).toBeDefined();
        expect(o.endMs - o.startMs).toBe(2 * 3600_000);
    });

    it('a 09:00–17:00 event on a DST day keeps its wall-clock end', () => {
        const s = { ...base, start: '2026-11-01T09:00', end: '2026-11-01T17:00' };
        const [o] = occurrencesBetween(s, T('2026-11-01T00:00:00Z'), T('2026-11-02T12:00:00Z'));
        expect(formatWall(instantToWall(o.endMs, 'America/New_York'), false)).toBe('2026-11-01T17:00');
    });

    it('nextOccurrence skips a repeating task’s done instances', () => {
        const t: EventSchedule = { v: 1, kind: 'task', uid: 'uid-0005-abcd', allDay: true, start: '2026-10-05', rrule: 'FREQ=DAILY', doneThrough: '2026-10-09' };
        expect(nextOccurrence(t, T('2026-10-05T00:00:00Z'))?.key).toBe('2026-10-10');
    });
});

describe('ticking: only a repeating TASK advances', () => {
    const task: EventSchedule = { v: 1, kind: 'task', uid: 'uid-0006-abcd', allDay: false, start: '2026-10-05T09:00', tz: 'UTC', rrule: 'FREQ=DAILY;COUNT=5' };

    it('advances to the next occurrence and stays open', () => {
        const p = planCompletion(task, true, T('2026-10-05T10:00:00Z'));
        expect(p).toMatchObject({ kind: 'advance', occurrence: '2026-10-05T09:00', dueAt: '2026-10-06T09:00:00.000Z' });
        expect(p.kind === 'advance' && p.schedule.doneThrough).toBe('2026-10-05T09:00');
    });

    it('catches up: three missed days are done with one tick', () => {
        const p = planCompletion(task, true, T('2026-10-08T10:00:00Z'));
        expect(p).toMatchObject({ kind: 'advance', occurrence: '2026-10-08T09:00', dueAt: '2026-10-09T09:00:00.000Z' });
    });

    it('ticking early does just the current one', () => {
        const p = planCompletion(task, true, T('2026-10-01T00:00:00Z'));
        expect(p).toMatchObject({ kind: 'advance', occurrence: '2026-10-05T09:00' });
    });

    it('the last occurrence completes the item; so does an event or a one-off; no schedule is plain', () => {
        expect(planCompletion({ ...task, doneThrough: '2026-10-08T09:00' }, true, T('2026-10-09T10:00:00Z')).kind).toBe('complete');
        expect(planCompletion({ ...base, rrule: 'FREQ=DAILY' }, true, T('2026-10-05T10:00:00Z')).kind).toBe('complete');
        expect(planCompletion({ ...task, rrule: undefined }, true, T('2026-10-05T10:00:00Z')).kind).toBe('complete');
        expect(planCompletion(null, true, 0).kind).toBe('plain');
        expect(planCompletion(task, false, 0).kind).toBe('complete');
    });

    it('private timing advances the series but keeps due_at null', () => {
        const p = planCompletion({ ...task, privateTiming: true }, true, T('2026-10-05T10:00:00Z'));
        expect(p).toMatchObject({ kind: 'advance', dueAt: null });
    });
});

describe('snooze', () => {
    const due = '2026-10-05T19:00:00.000Z';
    const sz = serializeSnooze({ forDue: due, until: '2026-10-05T20:00:00.000Z' });

    it('applies while due_at is the one it was taken against (compared as instants)', () => {
        expect(effectiveReminderMs(due, sz)).toBe(T('2026-10-05T20:00:00Z'));
        expect(effectiveReminderMs('2026-10-05T19:00:00Z', sz)).toBe(T('2026-10-05T20:00:00Z'));
        expect(activeSnooze(due, sz)?.until).toBe('2026-10-05T20:00:00.000Z');
    });

    it('a stale snooze (due_at moved since) is ignored', () => {
        expect(effectiveReminderMs('2026-10-12T19:00:00.000Z', sz)).toBe(T('2026-10-12T19:00:00Z'));
    });

    it('fails OPEN: an unreadable or foreign snooze means remind at due_at', () => {
        expect(effectiveReminderMs(due, ENC_KEY_UNAVAILABLE)).toBe(T(due));
        expect(effectiveReminderMs(due, serializeSchedule(base))).toBe(T(due));
        expect(parseSnooze('{"k":"snooze/1","forDue":"x","until":"y"}')).toBeNull();
        expect(effectiveReminderMs(null, sz)).toBeNaN();
    });

    it('presets: 10 minutes, an hour, tomorrow 09:00 local', () => {
        const now = T('2026-10-05T12:34:00Z');
        expect(snoozeUntil('10m', now)).toBe(now + 600_000);
        expect(snoozeUntil('1h', now)).toBe(now + 3600_000);
        expect(new Date(snoozeUntil('tomorrow', now, 'Europe/Dublin')).toISOString()).toBe('2026-10-06T08:00:00.000Z');
    });
});
