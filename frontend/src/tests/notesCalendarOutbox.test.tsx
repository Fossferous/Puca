/**
 * The calendar's writes go through Púca Notes' offline outbox, like every
 * other task write there (notes/model/notesQueries.ts): a tick (a repeating
 * one included, which advances), a date & repeat, a snooze, and an item made
 * by the calendar's tap-to-add with its timing. None of them may call the
 * task API around the outbox — offline that silently dropped the write.
 *
 * sendNoteOp is mocked, so what is asserted is the op each action hands the
 * outbox; notesOutboxTrash.test.ts runs those ops through the real outbox and
 * execOp.
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
vi.mock('../api/tasks', async (orig) => {
    const real = await orig<typeof import('../api/tasks')>();
    return { ...real, patchTaskTiming: vi.fn(), createTask: vi.fn(), createListTask: vi.fn() };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));
vi.mock('../notes/model/notesOutbox', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesOutbox')>();
    // The create helpers call the outbox from inside the module, so they are
    // mocked themselves: what is asserted is what they are handed.
    return { ...real, sendNoteOp: vi.fn(), sendCreateTask: vi.fn(), sendCreateList: vi.fn() };
});

import { apiClient, ApiError } from '../api/client';
import { createListTask, createTask, patchTaskTiming, type Task, type TaskList } from '../api/tasks';
import { pokeTaskReminders } from '../api/taskReminders';
import { pushMessageToast } from '../components/messageToastBus';
import { serializeSchedule, type EventSchedule } from '../api/taskSchedule';
import { queuedTaskStandIn, sendCreateList, sendCreateTask, sendNoteOp, type NoteOp } from '../notes/model/notesOutbox';
import { notesKeys, useNoteActions, type NoteActions } from '../notes/model/notesQueries';
import type { NoteCard } from '../notes/model/notesModel';

const LIST = { kind: 'list' as const, id: 1 };
const mk = (id: number, over: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description: `t${id}`, is_completed: false, position: id,
    created_at: '2026-09-01T00:00:00Z', created_by: 7, attachments: null, due_at: null, ...over,
});
const card = (id: number) => ({ key: `list:${id}`, ref: { kind: 'list' as const, id } }) as unknown as NoteCard;
const daily: EventSchedule = { v: 1, kind: 'task', uid: 'uid-rep-0001', allDay: false, start: '2026-09-01T09:00', tz: 'UTC', rrule: 'FREQ=DAILY' };

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

const lastOp = () => vi.mocked(sendNoteOp).mock.calls.at(-1)?.[0] as NoteOp;

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.get).mockResolvedValue(undefined);
});
afterEach(() => { document.body.innerHTML = ''; });

describe('the calendar\'s writes go through the outbox', () => {
    it('a plain tick is a timing op (recurrence-aware), never a direct PATCH', async () => {
        const qc = new QueryClient();
        qc.setQueryData(notesKeys.tasks(LIST), [mk(5)]);
        vi.mocked(sendNoteOp).mockResolvedValue({ queued: false, value: undefined });
        const actions = mountActions(qc);
        await act(async () => { await actions().toggleTask(LIST, mk(5), true); });
        expect(sendNoteOp).toHaveBeenCalledTimes(1);
        expect(lastOp()).toMatchObject({ k: 'timing', note: LIST, taskId: 5, createdBy: 7, patch: { is_completed: true } });
        expect(patchTaskTiming).not.toHaveBeenCalled();
        expect(pokeTaskReminders).toHaveBeenCalled();   // it ran now
    });

    it('a repeating tick queued OFFLINE stays advanced on screen and carries its compare-and-swap', async () => {
        const qc = new QueryClient();
        const t = mk(5, { schedule: serializeSchedule(daily), due_at: '2026-09-19T09:00:00.000Z' });
        qc.setQueryData(notesKeys.tasks(LIST), [t]);
        vi.mocked(sendNoteOp).mockResolvedValue({ queued: true });
        const actions = mountActions(qc);
        await act(async () => { await actions().toggleTask(LIST, t, true); });
        const op = lastOp() as NoteOp & { k: 'timing' };
        expect(op.k).toBe('timing');
        expect(op.patch).toMatchObject({ expect_due_at: '2026-09-19T09:00:00.000Z', reopen_subtree: true });
        expect(op.patch).not.toHaveProperty('is_completed');   // an advance, not a completion
        const shown = qc.getQueryData<Task[]>(notesKeys.tasks(LIST))![0];
        expect(shown.is_completed).toBe(false);
        expect(shown.due_at).toBe(op.patch.due_at);            // the optimistic advance stays
        expect(pokeTaskReminders).not.toHaveBeenCalled();      // the replay pokes them
    });

    it('a tick the plan refuses never reaches the outbox (no network, one toast)', async () => {
        const qc = new QueryClient();
        const t = mk(5, { schedule: '[Encrypted — key unavailable]' });
        qc.setQueryData(notesKeys.tasks(LIST), [t]);
        const actions = mountActions(qc);
        await act(async () => { await actions().toggleTask(LIST, t, true); });
        expect(sendNoteOp).not.toHaveBeenCalled();
        expect(pushMessageToast).toHaveBeenCalledWith({ title: expect.stringMatching(/can’t be read/) });
    });

    it('a date & repeat is a timing op with its derived due_at', async () => {
        const qc = new QueryClient();
        qc.setQueryData(notesKeys.tasks(LIST), [mk(5)]);
        vi.mocked(sendNoteOp).mockResolvedValue({ queued: true });
        const actions = mountActions(qc);
        const sched = serializeSchedule(daily);
        await act(async () => { await actions().setSchedule(LIST, mk(5), sched, '2026-09-20T09:00:00.000Z'); });
        expect(lastOp()).toMatchObject({ k: 'timing', taskId: 5, patch: { schedule: sched, due_at: '2026-09-20T09:00:00.000Z' } });
        expect(qc.getQueryData<Task[]>(notesKeys.tasks(LIST))![0].schedule).toBe(sched);   // kept while queued
    });

    it('a snooze is a timing op; a refusal rolls it back', async () => {
        const qc = new QueryClient();
        const t = mk(5, { due_at: '2026-09-19T09:00:00.000Z' });
        qc.setQueryData(notesKeys.tasks(LIST), [t]);
        vi.mocked(sendNoteOp).mockRejectedValue(new ApiError('Missing Complete Tasks permission', 403));
        const actions = mountActions(qc);
        await act(async () => { await actions().snoozeTask(LIST, t, Date.parse('2026-09-19T10:00:00Z')); });
        const op = lastOp() as NoteOp & { k: 'timing' };
        expect(op.k).toBe('timing');
        expect(op.patch.snooze).toEqual(expect.any(String));
        expect(qc.getQueryData<Task[]>(notesKeys.tasks(LIST))![0]).toEqual(t);   // rolled back
        expect(pushMessageToast).toHaveBeenCalledWith({ title: 'Missing Complete Tasks permission' });
    });

    it('tap-to-add: the item AND its timing go to the outbox together, and a queued one stays on its day', async () => {
        const qc = new QueryClient();
        qc.setQueryData(notesKeys.tasks(LIST), []);
        const timing = { dueAt: '2026-09-21T09:00:00.000Z', schedule: serializeSchedule({ ...daily, rrule: undefined }) };
        vi.mocked(sendCreateTask).mockImplementation(async (note, description, parentId, siblings, t) => queuedTaskStandIn(note, -77, description, parentId, siblings(), t));
        const actions = mountActions(qc);
        let made: Task | null = null;
        await act(async () => { made = await actions().addTask(LIST, 'Dentist', undefined, timing); });
        expect(sendCreateTask).toHaveBeenCalledWith(LIST, 'Dentist', undefined, expect.any(Function), timing);
        expect(made!.id).toBe(-77);                            // a temporary item, on screen
        expect(made!.due_at).toBe(timing.dueAt);
        expect(made!.schedule).toBe(timing.schedule);
        expect(qc.getQueryData<Task[]>(notesKeys.tasks(LIST))).toEqual([made]);
        expect(createTask).not.toHaveBeenCalled();
        expect(createListTask).not.toHaveBeenCalled();
        expect(pokeTaskReminders).not.toHaveBeenCalled();      // not on the server yet
    });

    it('a new calendar note: the list and each item’s own timing go through the outbox', async () => {
        const qc = new QueryClient();
        qc.setQueryData<TaskList[]>(notesKeys.lists, []);
        vi.mocked(sendCreateList).mockResolvedValue({ id: -50, title: 'Calendar', created_at: '', total_tasks: 0, completed_tasks: 0 });
        vi.mocked(sendCreateTask).mockImplementation(async (note, description, parentId, siblings, t) => queuedTaskStandIn(note, -51, description, parentId, siblings(), t));
        const actions = mountActions(qc);
        const timing = { dueAt: '2026-09-21T09:00:00.000Z' };
        let ref: unknown = null;
        await act(async () => { ref = await actions().createNote('Calendar', ['', 'Dentist'], undefined, [undefined, timing]); });
        expect(sendCreateList).toHaveBeenCalledTimes(1);
        // The blank row was dropped; its (absent) timing did not slide onto the next item.
        expect(sendCreateTask).toHaveBeenCalledTimes(1);
        expect(sendCreateTask).toHaveBeenCalledWith({ kind: 'list', id: -50 }, 'Dentist', undefined, expect.any(Function), timing);
        expect(ref).toEqual({ kind: 'list', id: -50 });
        expect(qc.getQueryData<TaskList[]>(notesKeys.lists)!.map(l => l.id)).toEqual([-50]);
    });
});
