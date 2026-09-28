/**
 * A snooze from Notes' /calendar is ONE snooze.
 *
 * CalendarView's onSnooze sent two: one with no guard for a note's own
 * reminder (a note has no snooze column, migration 068) and the person's
 * morning time for Tomorrow, and one with the guard and the default 09:00.
 * Two writes per tap, racing each other to the same item, and whichever
 * answered last decided what Tomorrow meant — while tapping Snooze on a
 * note's own reminder, which the menu does not offer but the handler is
 * reachable for, went out anyway.
 *
 * Pinned here: exactly one call per snooze, carrying the morning the account
 * chose, and none at all for a note's own reminder.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CalendarEntry } from '../api/taskCalendar';

/** The one prop under test, as the shared Calendar receives it. */
type SnoozeFn = (e: CalendarEntry, preset: 'tomorrow' | '10m' | '1h') => void;
const seen: { onSnooze?: SnoozeFn }[] = [];
vi.mock('../components/calendar/Calendar', () => ({
    Calendar: (p: { onSnooze?: SnoozeFn }) => { seen.push({ onSnooze: p.onSnooze }); return null; },
}));
vi.mock('../components/calendar/calendarGate', () => ({ useCoarseCalendar: () => false }));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => true }));
vi.mock('../api/icsDelivery', () => ({
    canAddToPhoneCalendar: async () => false, addToPhoneCalendar: async () => {}, deliverIcs: async () => ({ how: 'cancelled' }), phoneCalendarArgs: () => ({}),
}));
// A morning that is NOT the 09:00 default, so a call that dropped it shows.
const MORNING = '06:45';
vi.mock('../notes/model/notesPrefs', async (orig) => ({
    ...(await orig<typeof import('../notes/model/notesPrefs')>()),
    useReminderTimes: () => ({ morning: MORNING, afternoon: '14:00', evening: '19:00', default: '09:00' }),
}));

import { CalendarView } from '../notes/components/CalendarView';
import { snoozeUntil } from '../api/taskSchedule';
import type { NoteActions } from '../notes/model/notesQueries';
import type { Task } from '../api/tasks';

const task = { id: 5, channel_id: null, list_id: 1, parent_id: null, description: 'Bins out', is_completed: false, position: 1, created_at: '2030-09-01T00:00:00Z', created_by: 7, attachments: null, due_at: '2030-10-07T09:00:00.000Z' } as Task;
const entry = (isNote: boolean) => ({ source: { task, noteKey: 'list:1', noteTitle: 'Home', canEdit: true, canComplete: true, ...(isNote ? { isNote: true } : {}) } }) as unknown as CalendarEntry;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    seen.length = 0;
    vi.useRealTimers();
});

function mount() {
    const snoozeTask = vi.fn(async () => {});
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
        <QueryClientProvider client={new QueryClient()}>
            <MemoryRouter initialEntries={['/calendar?v=day']}>
                <CalendarView cards={[]} actions={{ snoozeTask } as unknown as NoteActions} now={Date.parse('2030-10-01T12:00:00Z')} onOpenNote={() => {}} shortcutsEnabled={false} />
            </MemoryRouter>
        </QueryClientProvider>,
    ));
    const onSnooze = seen.at(-1)?.onSnooze;
    expect(onSnooze, 'the calendar was given no snooze handler, so nothing could be driven').toBeTypeOf('function');
    return { snoozeTask, onSnooze: onSnooze! };
}

describe('Notes /calendar snooze', () => {
    it('one tap on Tomorrow is ONE snooze, at the morning the account chose', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2030-10-01T12:00:00Z'));
        const { snoozeTask, onSnooze } = mount();
        onSnooze(entry(false), 'tomorrow');
        expect(snoozeTask).toHaveBeenCalledTimes(1);
        expect(snoozeTask).toHaveBeenCalledWith({ kind: 'list', id: 1 }, task, snoozeUntil('tomorrow', Date.now(), undefined, MORNING));
        // POSITIVE CONTROL: the morning really changes the answer, so the
        // assertion above could tell the two calls apart.
        expect(snoozeUntil('tomorrow', Date.now(), undefined, MORNING)).not.toBe(snoozeUntil('tomorrow', Date.now()));
    });

    it('the short presets are one call too', () => {
        const { snoozeTask, onSnooze } = mount();
        onSnooze(entry(false), '1h');
        expect(snoozeTask).toHaveBeenCalledTimes(1);
    });

    it("a note's own reminder is never snoozed — it has nothing to snooze", () => {
        const { snoozeTask, onSnooze } = mount();
        onSnooze(entry(true), 'tomorrow');
        expect(snoozeTask).not.toHaveBeenCalled();
    });
});
