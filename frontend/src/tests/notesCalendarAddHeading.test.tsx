// Púca Notes' calendar never makes a HEADING (api/taskHeading.ts). A heading
// has no time, and what the calendar makes always has one — so a title
// typed as "## Standup", stored as typed, would be a heading: filtered off
// the day it was added to and out of Reminders, with its reminder still
// firing. It lands as the item it was typed as, in an existing note and in
// the new note the sheet can make alike.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../components/calendar/calendarGate', () => ({ useCoarseCalendar: () => false }));
/** The grid, reduced to the prop that opens the add sheet. */
const grids: Array<{ onAdd: (dayKey: string, time?: string) => void }> = [];
vi.mock('../components/calendar/Calendar', () => ({
    Calendar: (p: { onAdd: (dayKey: string, time?: string) => void }) => { grids.push(p); return null; },
}));
/** The sheet, reduced to the callback CalendarView hands it. */
const sheets: Array<{ onSubmit: (r: AddSheetResult) => Promise<boolean> }> = [];
vi.mock('../components/calendar/CalendarAddSheet', () => ({
    CalendarAddSheet: (p: { onSubmit: (r: AddSheetResult) => Promise<boolean> }) => { sheets.push(p); return null; },
}));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => true }));
vi.mock('../api/icsDelivery', () => ({
    canAddToPhoneCalendar: async () => false, addToPhoneCalendar: async () => {}, deliverIcs: async () => ({ how: 'cancelled' }), phoneCalendarArgs: () => ({}),
}));

import { CalendarView } from '../notes/components/CalendarView';
import { type AddSheetResult } from '../components/calendar/CalendarAddSheet';
import type { NoteActions } from '../notes/model/notesQueries';
import { isHeadingText } from '../api/taskHeading';

const addTask = vi.fn(async () => ({ id: 1 }));
const createNote = vi.fn(async () => ({ kind: 'list' as const, id: 9 }));
const actions = { addTask, createNote } as unknown as NoteActions;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    grids.length = 0;
    sheets.length = 0;
    addTask.mockClear();
    createNote.mockClear();
});

function openSheet() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
        <QueryClientProvider client={new QueryClient()}>
            <MemoryRouter initialEntries={['/calendar?v=day']}>
                <CalendarView cards={[]} actions={actions} now={Date.parse('2030-10-01T12:00:00Z')} onOpenNote={() => {}} shortcutsEnabled={false} />
            </MemoryRouter>
        </QueryClientProvider>,
    ));
    act(() => { grids.at(-1)!.onAdd('2030-10-07', '09:00'); });
    expect(sheets.length, 'the add sheet never opened').toBeGreaterThan(0);
}

const filled = (over: Partial<AddSheetResult>): AddSheetResult => ({
    title: 'Bins out', dayKey: '2030-10-07', time: '09:00', allDay: false, kind: 'task', target: 'list:5', ...over,
});

async function submit(r: AddSheetResult): Promise<boolean> {
    let ok = false;
    await act(async () => { ok = await sheets.at(-1)!.onSubmit(r); });
    return ok;
}

describe("Notes' calendar add sheet", () => {
    it('"## Standup" added to a note lands as an item', async () => {
        openSheet();
        expect(await submit(filled({ title: '## Standup' }))).toBe(true);
        const text = (addTask.mock.calls[0] as unknown[])[1] as string;
        expect(text).toBe('##\u00a0Standup');
        expect(isHeadingText(text)).toBe(false);
    });

    it('...and so it does in the new note the sheet makes', async () => {
        openSheet();
        expect(await submit(filled({ title: '# Standup', target: 'new' }))).toBe(true);
        const items = (createNote.mock.calls[0] as unknown[])[1] as string[];
        expect(items).toEqual(['#\u00a0Standup']);
    });

    it('POSITIVE CONTROL: any other title is sent as typed', async () => {
        openSheet();
        expect(await submit(filled({ title: 'Bins out' }))).toBe(true);
        expect((addTask.mock.calls[0] as unknown[])[1]).toBe('Bins out');
    });
});
