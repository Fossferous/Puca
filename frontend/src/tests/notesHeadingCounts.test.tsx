/**
 * A note's cached count ("total_tasks" on the list row) through the REAL
 * action surface (notes/model/notesQueries.ts useNoteActions): it is what a
 * card shows before its items load, so it must count steps the way the card
 * does once they have (countProgress) — a heading is not one
 * (api/taskHeading.ts). Turning an item into a heading is an EDIT, and an
 * edit used to leave the count alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn() }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: vi.fn(), post: vi.fn() } };
});
vi.mock('../notes/model/notesOutbox', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesOutbox')>();
    return { ...real, sendNoteOp: vi.fn() };
});

import { type Task, type TaskList } from '../api/tasks';
import { sendNoteOp } from '../notes/model/notesOutbox';
import { notesKeys, useNoteActions, type NoteActions } from '../notes/model/notesQueries';
import type { NoteCard, NoteRef } from '../notes/model/notesModel';

const REF: NoteRef = { kind: 'list', id: 7 };
const list: TaskList = { id: 7, title: 'Test checklist', created_at: '', total_tasks: 3, completed_tasks: 0 };
const task = (id: number, description: string): Task => ({
    id, channel_id: null, list_id: 7, parent_id: null, description, is_completed: false,
    position: id, created_at: '2026-09-01', created_by: 7, attachments: null, due_at: null,
});

function Probe({ onActions }: { onActions: (a: NoteActions) => void }) {
    const actions = useNoteActions([{ key: 'list:7', ref: REF } as unknown as NoteCard], [], true);
    useEffect(() => { onActions(actions); }, [actions, onActions]);
    return null;
}

let qc: QueryClient;
function mount(): () => NoteActions {
    const box: { current: NoteActions | null } = { current: null };
    const onActions = (a: NoteActions) => { box.current = a; };
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => { createRoot(host).render(<QueryClientProvider client={qc}><Probe onActions={onActions} /></QueryClientProvider>); });
    return () => box.current!;
}
const counted = () => qc.getQueryData<TaskList[]>(notesKeys.lists)![0].total_tasks;

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendNoteOp).mockResolvedValue({ queued: false, value: undefined });
    qc = new QueryClient();
    qc.setQueryData<TaskList[]>(notesKeys.lists, [list]);
    qc.setQueryData<Task[]>(notesKeys.tasks(REF), [task(1, 'Before you start'), task(2, 'Update the app'), task(3, 'Open each app')]);
});
afterEach(() => { document.body.innerHTML = ''; });

describe("a note's cached count", () => {
    it('drops by one when an item becomes a heading, and comes back when it is an item again', async () => {
        const actions = mount();
        const first = qc.getQueryData<Task[]>(notesKeys.tasks(REF))![0];
        await act(async () => { await actions().editTask(REF, first, '## Before you start'); });
        expect(counted()).toBe(2);
        await act(async () => { await actions().editTask(REF, first, 'Before you start'); });
        expect(counted()).toBe(3);
    });

    it('after a delete it counts steps: the heading left behind is not one', async () => {
        qc.setQueryData<Task[]>(notesKeys.tasks(REF), [task(1, '## Before you start'), task(2, 'Update the app')]);
        const actions = mount();
        await act(async () => { await actions().deleteTaskFrom(REF, 2); });
        expect(counted()).toBe(0);
        // POSITIVE CONTROL: a plain edit of an item leaves the count as it was.
        qc.setQueryData<Task[]>(notesKeys.tasks(REF), [task(1, '## Before you start'), task(3, 'Open each app')]);
        await act(async () => { await actions().editTask(REF, task(3, 'Open each app'), 'Open both apps'); });
        expect(counted()).toBe(1);
    });
});
