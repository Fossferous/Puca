// The calendar's grids: under the phone gate a Day is its list alone (no
// time grid — the brief put both grids behind the fine-pointer gate), and a
// Week/Day grid opens on working hours or just before now, never at 00:00.
// Also: Notes' /calendar takes its phone/desktop answer from the SAME gate
// as Púca's Calendar tab (calendarGate.useCoarseCalendar).
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Calendar, type CalendarProps } from '../components/calendar/Calendar';
import { GRID_WORKDAY_HOUR, gridOpenHour, localDayKey } from '../utils/calendarMath';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

function render(over: Partial<CalendarProps>) {
    const props: CalendarProps = {
        sources: [], view: 'day', date: '2030-10-07', onNavigate: () => {}, showCompleted: false, showPlain: true,
        onToggleCompleted: () => {}, onTogglePlain: () => {}, weekStart: 1, now: Date.parse('2030-10-01T12:00:00Z'), coarse: false,
        onOpen: () => {}, onMove: () => {}, onAdd: () => {}, onToggleDone: () => {}, ...over,
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Calendar {...props} />));
    return host;
}

describe('gridOpenHour', () => {
    it('a day that is not today opens on the working day; today opens an hour before now', () => {
        expect(gridOpenHour(['2030-10-07'], '2030-10-01', 12 * 60)).toBe(GRID_WORKDAY_HOUR);
        expect(gridOpenHour(['2030-10-01', '2030-10-02'], '2030-10-01', 14 * 60 + 30)).toBe(13);
        expect(gridOpenHour(['2030-10-01'], '2030-10-01', 10)).toBe(0);
        expect(GRID_WORKDAY_HOUR).toBeGreaterThan(0);
    });
});

describe('Calendar grids', () => {
    it('under the phone gate a Day is its list only — no time grid', () => {
        const el = render({ coarse: true, view: 'day' });
        expect(el.querySelector('.cal-daylist')).not.toBeNull();
        expect(el.querySelector('.cal-timegrid')).toBeNull();
    });

    it('under the phone gate Week falls back to that same list', () => {
        const el = render({ coarse: true, view: 'week' });
        expect(el.querySelector('.cal-timegrid')).toBeNull();
        expect(el.querySelector('.cal-daylist')).not.toBeNull();
    });

    it('positive control: on desktop the Day and Week grids exist, and open on working hours, not midnight', () => {
        const day = render({ coarse: false, view: 'day' });
        const body = day.querySelector<HTMLElement>('.cal-tg-body');
        expect(body).not.toBeNull();
        expect(body!.dataset.openHour).toBe(String(GRID_WORKDAY_HOUR));
        expect(body!.scrollTop).toBe(GRID_WORKDAY_HOUR * 48);
        act(() => root?.unmount());
        host?.remove();
        const now = Date.now();
        const week = render({ coarse: false, view: 'week', date: localDayKey(now), now });
        const wb = week.querySelector<HTMLElement>('.cal-tg-body');
        expect(wb).not.toBeNull();
        const hourNow = new Date(now).getHours();
        expect(wb!.dataset.openHour).toBe(String(Math.max(0, hourNow - 1)));
    });
});
