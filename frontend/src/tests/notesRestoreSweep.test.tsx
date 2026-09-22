/**
 * Putting a completed branch back shows the WHOLE branch done, at once.
 *
 * `restoreCompleted` (notesQueries.ts) is the Undo-only completion path: a
 * plain timing patch, never the tick, which would advance a repeating to-do.
 * The server completes a subtree along with its root (src/task_handlers.rs,
 * the recursive UPDATE after the PATCH), so the optimistic update has to
 * sweep too — every other completion path does, through applyToggle. Marking
 * only the one row left the parent ticked and its children open on screen
 * until the next refetch: exactly the half-restored branch the second pass
 * over recreateSubtree was written to prevent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn() }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));
vi.mock('../notes/model/notesOutbox', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesOutbox')>();
    return { ...real, sendNoteOp: vi.fn() };
});

import { apiClient, ApiError } from '../api/client';
import { type Task, type TaskList } from '../api/tasks';
import { sendNoteOp, type NoteOp } from '../notes/model/notesOutbox';
import { notesKeys, useNoteActions, type NoteActions } from '../notes/model/notesQueries';
import type { NoteCard } from '../notes/model/notesModel';

const LIST = { kind: 'list' as const, id: 1 };
const mk = (id: number, over: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description: `t${id}`, is_completed: false, position: id,
    created_at: '2026-09-01T00:00:00Z', created_by: 7, attachments: null, due_at: null, ...over,
});
const card = (id: number) => ({ key: `list:${id}`, ref: { kind: 'list' as const, id } }) as unknown as NoteCard;

function Probe({ onActions }: { onActions: (a: NoteActions) => void }) {
    const actions = useNoteActions([card(1)], [], true);
    useEffect(() => { onActions(actions); }, [actions, onActions]);
    return null;
}
function mountActions(qc: QueryClient): () => NoteActions {
    const box: { current: NoteActions | null } = { current: null };
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => { createRoot(host).render(<QueryClientProvider client={qc}><Probe onActions={a => { box.current = a; }} /></QueryClientProvider>); });
    return () => box.current!;
}
const shown = (qc: QueryClient) => (qc.getQueryData<Task[]>(notesKeys.tasks(LIST)) ?? []).map(t => [t.id, t.is_completed]);

/** A parent with a child and a grandchild, plus an unrelated item. */
const BRANCH = [mk(5), mk(6, { parent_id: 5 }), mk(7, { parent_id: 6 }), mk(8)];

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.get).mockResolvedValue(undefined);
});
afterEach(() => { document.body.innerHTML = ''; });

describe('restoreCompleted', () => {
    it('sweeps the whole subtree on screen, as the server does — and nothing beside it', async () => {
        const qc = new QueryClient();
        qc.setQueryData(notesKeys.tasks(LIST), BRANCH);
        qc.setQueryData<TaskList[]>(notesKeys.lists, [{ id: 1, title: 'Groceries', created_at: '', total_tasks: 4, completed_tasks: 0 }]);
        vi.mocked(sendNoteOp).mockResolvedValue({ queued: false, value: undefined });
        const actions = mountActions(qc);
        await act(async () => { await actions().restoreCompleted(LIST, mk(5)); });
        expect(shown(qc)).toEqual([[5, true], [6, true], [7, true], [8, false]]);
        // Still the Undo-only path: one timing patch, no tick, no advance.
        const op = vi.mocked(sendNoteOp).mock.calls.at(-1)?.[0] as NoteOp & { k: 'timing' };
        expect(op).toMatchObject({ k: 'timing', taskId: 5, patch: { is_completed: true } });
        expect(qc.getQueryData<TaskList[]>(notesKeys.lists)![0].completed_tasks).toBe(3);
    });

    it('POSITIVE CONTROL: a refusal puts every row back the way it was', async () => {
        const qc = new QueryClient();
        qc.setQueryData(notesKeys.tasks(LIST), BRANCH);
        vi.mocked(sendNoteOp).mockRejectedValue(new ApiError('Missing Complete Tasks permission', 403));
        const actions = mountActions(qc);
        await act(async () => { await actions().restoreCompleted(LIST, mk(5)); });
        expect(shown(qc)).toEqual([[5, false], [6, false], [7, false], [8, false]]);
    });

    it('POSITIVE CONTROL: a leaf sweeps nothing but itself', async () => {
        const qc = new QueryClient();
        qc.setQueryData(notesKeys.tasks(LIST), BRANCH);
        vi.mocked(sendNoteOp).mockResolvedValue({ queued: true });
        const actions = mountActions(qc);
        await act(async () => { await actions().restoreCompleted(LIST, mk(7, { parent_id: 6 })); });
        expect(shown(qc)).toEqual([[5, false], [6, false], [7, true], [8, false]]);
    });
});
