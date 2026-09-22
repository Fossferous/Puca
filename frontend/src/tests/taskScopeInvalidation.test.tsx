/**
 * A due time set in a LIST tab has to reach the Calendar and Reminders tabs.
 *
 * Those two read every scope through useTaskSources, a react-query cache with
 * a 30 s staleTime. A list tab keeps its items in its own component state and
 * PATCHes the API directly, so nothing told that cache anything: set a date on
 * an item, tap Reminders within half a minute of the last read, and the item
 * was simply not there — no spinner, no retry, just missing until the cache
 * went stale by itself. The walk caught it (mobile-walk2's Reminders step);
 * this is the same thing in one file.
 *
 * What it pins is the CALL, at the writers: the tabs' own correctness is
 * theirs to prove.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { patchTaskTiming } = vi.hoisted(() => ({ patchTaskTiming: vi.fn(async () => {}) }));
vi.mock('../api/tasks', async () => {
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return { ...real, patchTaskTiming };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));

import { invalidateTaskScope, taskScopeKey } from '../components/taskSources';
import { useScheduleSetter, useSnoozeSetter } from '../components/schedule/useScheduleSetter';
import type { Task } from '../api/tasks';

const listTask = { id: 5, channel_id: null, list_id: 7, parent_id: null, description: 'Bins out', is_completed: false, position: 1, created_at: '2030-09-01T00:00:00Z', created_by: 2, attachments: null, due_at: '2030-10-07T09:00:00.000Z' } as Task;
const chanTask = { ...listTask, id: 6, channel_id: 9, list_id: null } as Task;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });
beforeEach(() => { patchTaskTiming.mockClear(); });

/** A client that records what was invalidated, and nothing else. */
function spyClient() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const seen: unknown[][] = [];
    qc.invalidateQueries = (async (f?: { queryKey?: unknown[] }) => { seen.push(f?.queryKey ?? []); }) as typeof qc.invalidateQueries;
    return { qc, seen };
}

describe('invalidateTaskScope picks the scope the dated views read', () => {
    it('a personal list task invalidates its list, a channel task its channel', () => {
        const { qc, seen } = spyClient();
        invalidateTaskScope(qc, listTask);
        invalidateTaskScope(qc, chanTask);
        expect(seen).toEqual([[...taskScopeKey('list', 7)], [...taskScopeKey('channel', 9)]]);
    });
    it('a task in neither scope asks for nothing (no all-keys sweep)', () => {
        const { qc, seen } = spyClient();
        invalidateTaskScope(qc, { list_id: null, channel_id: null });
        expect(seen).toEqual([]);
    });
});

/** Renders a hook and hands back its callback. */
function useHook<T>(make: () => T, qc: QueryClient): () => T {
    let got: T;
    function Probe() { got = make(); return null; }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>));
    return () => got;
}

describe('the shared timing writers tell the dated views', () => {
    it('setting a date & repeat invalidates the item’s scope, after the server answered', async () => {
        const { qc, seen } = spyClient();
        const get = useHook(() => useScheduleSetter([listTask], () => {}), qc);
        await act(async () => { await get()(listTask, 'FREQ=DAILY', '2030-10-08T09:00:00.000Z'); });
        expect(patchTaskTiming).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([[...taskScopeKey('list', 7)]]);
    });

    it('POSITIVE CONTROL: a REFUSED write invalidates nothing — the cache still matches the server', async () => {
        const { qc, seen } = spyClient();
        patchTaskTiming.mockRejectedValueOnce(new Error('nope'));
        const get = useHook(() => useScheduleSetter([listTask], () => {}), qc);
        await act(async () => { await get()(listTask, 'FREQ=DAILY', '2030-10-08T09:00:00.000Z'); });
        expect(patchTaskTiming).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([]);
    });

    it('a snooze does too', async () => {
        const { qc, seen } = spyClient();
        const get = useHook(() => useSnoozeSetter([listTask], () => {}, () => true), qc);
        await act(async () => { await get()(listTask, Date.parse('2030-10-07T10:00:00.000Z')); });
        expect(patchTaskTiming).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([[...taskScopeKey('list', 7)]]);
    });
});
