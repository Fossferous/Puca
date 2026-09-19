// Notes' /calendar must take its phone/desktop answer from the ONE gate
// Púca's Calendar tab uses (calendarGate.useCoarseCalendar: the native shell
// OR the coarse-pointer query), not from a media query of its own — a native
// phone that did not match the query got the desktop grids.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const gate = vi.fn(() => true);
vi.mock('../components/calendar/calendarGate', () => ({ useCoarseCalendar: () => gate() }));
const seen: { coarse?: boolean }[] = [];
vi.mock('../components/calendar/Calendar', () => ({
    Calendar: (p: { coarse: boolean }) => { seen.push({ coarse: p.coarse }); return null; },
}));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => true }));
vi.mock('../api/icsDelivery', () => ({
    canAddToPhoneCalendar: async () => false, addToPhoneCalendar: async () => {}, deliverIcs: async () => ({ how: 'cancelled' }), phoneCalendarArgs: () => ({}),
}));

import { CalendarView } from '../notes/components/CalendarView';
import type { NoteActions } from '../notes/model/notesQueries';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    seen.length = 0;
});

function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
        <QueryClientProvider client={new QueryClient()}>
            <MemoryRouter initialEntries={['/calendar?v=day']}>
                <CalendarView cards={[]} actions={{} as NoteActions} now={Date.parse('2030-10-01T12:00:00Z')} onOpenNote={() => {}} shortcutsEnabled={false} />
            </MemoryRouter>
        </QueryClientProvider>,
    ));
}

describe('Notes /calendar and the shared gate', () => {
    it('renders the phone calendar when the shared gate says phone', () => {
        gate.mockReturnValue(true);
        mount();
        expect(seen.at(-1)?.coarse).toBe(true);
    });
    it('and the desktop one when it says desktop (positive control)', () => {
        gate.mockReturnValue(false);
        mount();
        expect(seen.at(-1)?.coarse).toBe(false);
    });
});
