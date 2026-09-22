/**
 * The two cheap gates on .ics import, in BOTH front doors — Notes' /calendar
 * and Púca's pinned Calendar tab. Neither is deep, and that is the point:
 * each is a single condition that every other suite and both walks drive
 * straight past, so deleting either left the whole tree green.
 *
 *  1. A file over MAX_ICS_BYTES is refused BEFORE parseIcs runs. Parsing a
 *     20 MB calendar in order to then reject it blocks the main thread for
 *     exactly as long as accepting it would have.
 *  2. Against a server with no `schedule` feature the "Import .ics…" header
 *     action is not offered at all — an import writes schedules, so a button
 *     there could only fail.
 *
 * Both doors go through one implementation (api/icsImport.icsPickRefusal),
 * which is what stops the cap and its wording drifting apart; these mount the
 * real components so that shared call is proved at each door, not assumed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { parseIcs } = vi.hoisted(() => ({ parseIcs: vi.fn(() => ({ items: [], notes: [] })) }));
vi.mock('../api/ics', async () => {
    const real = await vi.importActual<typeof import('../api/ics')>('../api/ics');
    return { ...real, parseIcs };
});
// The calendar grid itself is not under test; what it was HANDED is.
const seen: { headerActions?: { id: string }[] }[] = [];
vi.mock('../components/calendar/Calendar', () => ({
    Calendar: (p: { headerActions?: { id: string }[] }) => { seen.push({ headerActions: p.headerActions }); return null; },
}));
vi.mock('../components/calendar/calendarGate', () => ({ useCoarseCalendar: () => false }));
vi.mock('../api/icsDelivery', () => ({
    canAddToPhoneCalendar: async () => false, addToPhoneCalendar: async () => {}, deliverIcs: async () => ({ how: 'cancelled' }), phoneCalendarArgs: () => ({}),
}));
// No rows, and no socket: both views read them through this one hook.
vi.mock('../components/taskSources', () => ({
    taskScopeKey: (kind: string, id: number) => ['tasks-calendar', kind, id],
    useTaskSources: () => ({ sources: [], tasksIn: () => [], refetch: async () => {} }),
}));
const features = { schedule: true, snooze: true };
vi.mock('../api/taskFeatures', () => ({
    useTaskFeature: (f: 'schedule' | 'snooze') => features[f] ?? false,
    hasTaskFeature: (f: 'schedule' | 'snooze') => features[f] ?? false,
}));

import { CalendarView } from '../notes/components/CalendarView';
import { TasksCalendar } from '../components/calendar/TasksCalendar';
import { ICS_TOO_BIG, MAX_ICS_BYTES } from '../api/icsImport';
import { setMessageToastSink } from '../components/messageToastBus';
import type { NoteActions } from '../notes/model/notesQueries';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let toasts: string[] = [];

beforeEach(() => {
    features.schedule = true;
    features.snooze = true;
    parseIcs.mockClear();
    toasts = [];
    setMessageToastSink(t => { toasts.push(t.title); });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    seen.length = 0;
    setMessageToastSink(null);
});

function render(node: React.ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>));
    return host;
}
const notes = () => render(
    <MemoryRouter initialEntries={['/calendar?v=month']}>
        <CalendarView cards={[]} actions={{} as NoteActions} now={Date.parse('2030-10-01T12:00:00Z')} onOpenNote={() => {}} shortcutsEnabled={false} />
    </MemoryRouter>,
);
const puca = () => render(<TasksCalendar lists={[]} channels={[]} currentUserId={3} onOpen={() => {}} />);

const actionIds = () => (seen.at(-1)?.headerActions ?? []).map(a => a.id);

/** The picked file, as the hidden input hands it over. `text()` would throw
 *  if anything read it — an over-cap file must never be read at all. */
function pick(el: HTMLElement, size: number) {
    const input = el.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = {
        name: 'calendar.ics',
        size,
        text: async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    } as unknown as File;
    Object.defineProperty(input, 'files', { value: { 0: file, length: 1, item: () => file }, configurable: true });
    act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}
/** The change handler reads the file asynchronously; let that settle. */
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

describe('an over-cap .ics is refused before it is parsed', () => {
    it('Púca’s Calendar tab refuses it, in the shared words, without parsing', async () => {
        pick(puca(), MAX_ICS_BYTES + 1);
        await settle();
        expect(parseIcs).not.toHaveBeenCalled();
        expect(toasts).toEqual([ICS_TOO_BIG]);
        // The dialog PORTALS to the body (NotesDialog), so look there.
        expect(document.body.querySelector('.ics-import')).toBeNull();
    });
    it('POSITIVE CONTROL: a file exactly at the cap is read and parsed', async () => {
        pick(puca(), MAX_ICS_BYTES);
        await settle();
        expect(parseIcs).toHaveBeenCalledTimes(1);
        expect(toasts).toEqual([]);
        expect(document.body.querySelector('.ics-import')).not.toBeNull();
    });
    it('Notes’ /calendar refuses the same file the same way', async () => {
        pick(notes(), MAX_ICS_BYTES + 1);
        await settle();
        expect(parseIcs).not.toHaveBeenCalled();
        expect(toasts).toEqual([ICS_TOO_BIG]);
    });
    it('POSITIVE CONTROL: Notes parses one at the cap', async () => {
        pick(notes(), MAX_ICS_BYTES);
        await settle();
        expect(parseIcs).toHaveBeenCalledTimes(1);
        expect(toasts).toEqual([]);
    });
});

describe('Import .ics… needs a server that stores schedules', () => {
    it('Púca’s Calendar tab offers Export only when the feature is off', () => {
        features.schedule = false;
        puca();
        expect(actionIds()).toEqual(['export']);
    });
    it('POSITIVE CONTROL: with the feature it offers Import as well', () => {
        puca();
        expect(actionIds()).toEqual(['export', 'import']);
    });
    it('Notes’ /calendar follows the same gate', () => {
        features.schedule = false;
        notes();
        expect(actionIds()).toEqual(['export']);
        act(() => root?.unmount());
        host?.remove();
        features.schedule = true;
        notes();
        expect(actionIds()).toEqual(['export', 'import']);
    });
});
