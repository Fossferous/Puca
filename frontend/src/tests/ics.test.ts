// .ics on the device: a writer that produces RFC-valid files (VERSION,
// PRODID, DTSTAMP, CRLF, 75-octet folding, VTIMEZONE for every TZID) and a
// reader that brings Google / Outlook / Apple exports in and says what it
// could not represent — never fetching anything.
import { describe, expect, it, vi } from 'vitest';
import {
    PRODID, buildIcs, escapeText, foldLine, parseContentLine, parseDuration, parseIcs, unescapeText, unfold, zoneTransitions,
} from '../api/ics';
import { type EventSchedule } from '../api/taskSchedule';
import { expandSeries, parseRRule } from '../api/recurrence';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const bytes = (s: string) => new TextEncoder().encode(s).length;

const weekly: EventSchedule = {
    v: 1, kind: 'event', uid: 'a1b2c3d4-uid', allDay: false, start: '2026-10-06T15:00', end: '2026-10-06T16:30', tz: 'Europe/Dublin',
    rrule: 'FREQ=WEEKLY;BYDAY=TU', exdates: ['2026-10-20T15:00'], location: 'Room 2, Floor; 3', alerts: [10, 1440],
};
const allDay: EventSchedule = { v: 1, kind: 'event', uid: 'b2c3d4e5-uid', allDay: true, start: '2026-10-10', end: '2026-10-13', alertTz: 'UTC', alerts: [-540] };

describe('writing', () => {
    const text = buildIcs([
        { uid: weekly.uid, summary: 'Standup, daily-ish; with “quotes”\nand a newline', schedule: weekly },
        { uid: allDay.uid, summary: 'Trip', schedule: allDay },
        { uid: '0123456789abcdef@puca-notes', summary: 'Plain reminder', at: Date.parse('2026-10-07T08:00:00Z') },
        { uid: 'c3-long-uid-000', summary: 'Ü'.repeat(80), schedule: { ...allDay, uid: 'c3-long-uid-000', end: undefined } },
    ], { nowMs: NOW, calName: 'Plans' });

    it('is a valid VCALENDAR: VERSION, PRODID, DTSTAMP on every VEVENT, CRLF only', () => {
        expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:' + PRODID + '\r\n')).toBe(true);
        expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
        expect(/[^\r]\n/.test(text)).toBe(false);
        const events = text.split('BEGIN:VEVENT').length - 1;
        expect(events).toBe(4);
        expect(text.split('DTSTAMP:20261005T120000Z').length - 1).toBe(4);
    });

    it('folds at 75 octets without splitting a character, and escapes TEXT', () => {
        for (const line of text.split('\r\n')) expect(bytes(line)).toBeLessThanOrEqual(75);
        expect(text).toContain('SUMMARY:Standup\\, daily-ish\\; with “quotes”\\nand a newline');
        expect(foldLine('x'.repeat(200)).split('\r\n ').map(bytes)).toEqual([75, 74, 51]);
        expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
        expect(unescapeText(escapeText('a\\b;c,d\ne'))).toBe('a\\b;c,d\ne');
    });

    it('timed events carry TZID with a VTIMEZONE; all-day are VALUE=DATE; a plain item is UTC', () => {
        expect(text).toContain('BEGIN:VTIMEZONE\r\nTZID:Europe/Dublin');
        expect(text).toContain('DTSTART;TZID=Europe/Dublin:20261006T150000');
        expect(text).toContain('DTEND;TZID=Europe/Dublin:20261006T163000');
        expect(text).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU');
        expect(text).toContain('EXDATE;TZID=Europe/Dublin:20261020T150000');
        expect(text).toContain('DTSTART;VALUE=DATE:20261010');
        expect(text).toContain('DTEND;VALUE=DATE:20261013');
        expect(text).toContain('DTSTART:20261007T080000Z');
        expect(text).toContain('TRIGGER:-PT10M');
        expect(text).toContain('TRIGGER:-P1D');
        expect(text).toContain('TRIGGER:PT9H');
    });

    it('the VTIMEZONE lists the zone’s real transitions', () => {
        const t = zoneTransitions('Europe/Dublin', 2026, 2026);
        expect(t.map(x => new Date(x.at).toISOString())).toEqual(['2026-03-29T01:00:00.000Z', '2026-10-25T01:00:00.000Z']);
        expect(zoneTransitions('Asia/Kolkata', 2026, 2027)).toEqual([]);
    });

    it('a UID never names the server or the user', () => {
        for (const m of text.matchAll(/^UID:(.*)$/gm)) {
            expect(m[1]).not.toMatch(/https?:|localhost|example\.com|user/i);
        }
    });

    it('round-trips: what it writes, it reads back the same', () => {
        const back = parseIcs(text);
        expect(back.calName).toBe('Plans');
        const w = back.items.find(i => i.uid === weekly.uid)!;
        expect(w.schedule).toMatchObject({ kind: 'event', allDay: false, start: '2026-10-06T15:00', end: '2026-10-06T16:30', tz: 'Europe/Dublin', rrule: 'FREQ=WEEKLY;BYDAY=TU', exdates: ['2026-10-20T15:00'], location: 'Room 2, Floor; 3' });
        expect(new Set(w.schedule.alerts)).toEqual(new Set([10, 1440]));
        expect(w.summary).toBe('Standup, daily-ish; with “quotes”\nand a newline');
        const a = back.items.find(i => i.uid === allDay.uid)!;
        expect(a.schedule).toMatchObject({ allDay: true, start: '2026-10-10', end: '2026-10-13', alerts: [-540] });
        expect(back.items.find(i => i.summary === 'Plain reminder')!.schedule).toMatchObject({ tz: 'UTC', start: '2026-10-07T08:00' });
    });
});

const OUTLOOK = [
    'BEGIN:VCALENDAR', 'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN', 'VERSION:2.0', 'X-WR-CALNAME:Work',
    'BEGIN:VTIMEZONE', 'TZID:Pacific Standard Time', 'BEGIN:STANDARD', 'DTSTART:16011104T020000', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:040000008200E00074C5B7101A82E008', 'SUMMARY:Planning', 'DTSTART;TZID="Pacific Standard Time":20261013T090000',
    'DTEND;TZID="Pacific Standard Time":20261013T100000', 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4', 'EXDATE;TZID="Pacific Standard Time":20261020T090000',
    'LOCATION:Conf room', 'URL:https://example.invalid/should-never-be-fetched', 'ATTACH:https://example.invalid/also-not',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:040000008200E00074C5B7101A82E008', 'RECURRENCE-ID;TZID="Pacific Standard Time":20261027T090000',
    'SUMMARY:Planning (moved)', 'DTSTART;TZID="Pacific Standard Time":20261028T140000', 'DTEND;TZID="Pacific Standard Time":20261028T150000', 'END:VEVENT',
    'END:VCALENDAR',
].join('\r\n');

const GOOGLE = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-TIMEZONE:America/New_York',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261226', 'UID:abc123@google.com', 'SUMMARY:Holiday',
    'DESCRIPTION:Line one\\nLine two with a very long text that goes on and on and on and on and on and on',
    ' and continues on a folded line', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261101T063000', 'DURATION:PT45M', 'UID:float-1@google.com', 'SUMMARY:Run', 'RRULE:FREQ=DAILY;BYHOUR=6', 'END:VEVENT',
    'BEGIN:VTODO', 'UID:todo-1', 'SUMMARY:Pay rent', 'DUE;VALUE=DATE:20261101', 'END:VTODO',
    'BEGIN:VTODO', 'UID:todo-2', 'SUMMARY:Done thing', 'DUE;VALUE=DATE:20261001', 'STATUS:COMPLETED', 'END:VTODO',
    'BEGIN:VJOURNAL', 'UID:j1', 'END:VJOURNAL',
    'END:VCALENDAR',
].join('\n');   // LF line ends — Apple and some exports use them

describe('reading', () => {
    it('Outlook: a Windows zone, quoted TZID, COUNT with EXDATE, a changed occurrence, and links never fetched', () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const r = parseIcs(OUTLOOK);
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
        expect(r.calName).toBe('Work');
        const series = r.items.find(i => i.summary === 'Planning')!;
        expect(series.schedule).toMatchObject({ tz: 'America/Los_Angeles', start: '2026-10-13T09:00', rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=4', alerts: [15], location: 'Conf room' });
        expect(series.schedule.exdates).toEqual(['2026-10-20T09:00', '2026-10-27T09:00']);
        // COUNT counts before exclusion: 4 slots, 2 excluded → 2 real occurrences.
        const rule = parseRRule(series.schedule.rrule!);
        expect(rule.ok && [...expandSeries(rule.rule, series.schedule.start, { exdates: new Set(series.schedule.exdates) })].map(o => o.key))
            .toEqual(['2026-10-13T09:00', '2026-11-03T09:00']);
        const moved = r.items.find(i => i.summary === 'Planning (moved)')!;
        expect(moved.schedule).toMatchObject({ start: '2026-10-28T14:00', tz: 'America/Los_Angeles' });
        expect(moved.schedule.rrule).toBeUndefined();
        expect(moved.uid).not.toBe(series.uid);
        expect(r.notes.join(' ')).toMatch(/not imported \(never fetched\)/);
    });

    it('Google: all-day, a folded description, floating time in the calendar zone, VTODO, and what is skipped', () => {
        const r = parseIcs(GOOGLE);
        const hol = r.items.find(i => i.summary === 'Holiday')!;
        expect(hol.schedule).toMatchObject({ allDay: true, start: '2026-12-24', end: '2026-12-26' });
        expect(hol.description).toBe('Line one\nLine two with a very long text that goes on and on and on and on and on and onand continues on a folded line');
        const run = r.items.find(i => i.summary === 'Run')!;
        expect(run.schedule).toMatchObject({ tz: 'America/New_York', start: '2026-11-01T06:30', end: '2026-11-01T07:15' });
        expect(run.schedule.rrule).toBeUndefined();
        expect(run.notes.join(' ')).toMatch(/BYHOUR is not supported/);
        const todo = r.items.find(i => i.summary === 'Pay rent')!;
        expect(todo.schedule).toMatchObject({ kind: 'task', allDay: true, start: '2026-11-01', alerts: [0] });
        expect(todo.uid).toBe('todo-1');   // a to-do keeps its UID too, so a re-import dedupes it
        expect(r.items.some(i => i.summary === 'Done thing')).toBe(false);
        expect(r.notes.join(' ')).toMatch(/completed to-do skipped/);
        expect(r.notes.join(' ')).toMatch(/vjournal skipped/);
    });

    it('an unknown zone is flagged, not guessed silently; garbage is refused', () => {
        const r = parseIcs('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x-unknown-1\r\nSUMMARY:X\r\nDTSTART;TZID=Mars Standard Time:20261013T090000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
        expect(r.items[0].notes.join(' ')).toMatch(/unknown — shown in your zone/);
        expect(parseIcs('hello').notes[0]).toMatch(/not an iCalendar/);
        expect(parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:no start\nEND:VEVENT\nEND:VCALENDAR').notes[0]).toMatch(/no start time/);
    });

    it('low-level pieces', () => {
        expect(unfold('A:1\r\n 2\r\n\t3\nB:4')).toEqual(['A:123', 'B:4']);
        expect(parseContentLine('DTSTART;TZID="Zone: with colon":20261013T090000')).toEqual({ name: 'DTSTART', params: { TZID: 'Zone: with colon' }, value: '20261013T090000' });
        expect(parseDuration('-PT15M')).toBe(-15);
        expect(parseDuration('P1DT2H')).toBe(1560);
        expect(parseDuration('P1W')).toBe(10080);
        expect(parseDuration('PT0S')).toBe(0);
        expect(parseDuration('nonsense')).toBeNull();
    });
});
