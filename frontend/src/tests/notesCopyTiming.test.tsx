/**
 * A copy of a note with TEXT keeps its items' dates and repeats.
 *
 * "Make a copy" (the card menu) and the selection bar's duplicate hand
 * createNote each open item's timing. A note with text or pictures goes
 * through the content path (useListContent.ts createContentNote), which used
 * to take no timing at all and created every item with createListTask(id,
 * text): the copy of a text note silently lost every item's date and repeat.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));
vi.mock('../api/e2ee', async (orig) => {
    const real = await orig<typeof import('../api/e2ee')>();
    const id = real.makeIdentity(new Uint8Array(32).fill(3));
    return { ...real, getActiveIdentity: () => id, seedMatchesCurrentAccount: () => true };
});
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn() }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } };
});
vi.mock('../api/tasks', async (orig) => {
    const real = await orig<typeof import('../api/tasks')>();
    return { ...real, createListTask: vi.fn() };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));

import { apiClient } from '../api/client';
import { createListTask, type NewTaskTiming, type Task } from '../api/tasks';
import { OP_KEY_SHAPE } from '../api/opKey';
import { pokeTaskReminders } from '../api/taskReminders';
import { useNoteActions, type NoteActions } from '../notes/model/notesQueries';

const task = (id: number, description: string): Task => ({
    id, channel_id: null, list_id: 77, parent_id: null, description, is_completed: false, position: id,
    created_at: '', created_by: 7, attachments: null, due_at: null,
});

let root: Root | null = null;
function mountActions(): () => NoteActions {
    const box: { current: NoteActions | null } = { current: null };
    function Probe() {
        const a = useNoteActions([], [], true);
        useEffect(() => { box.current = a; });
        return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>); });
    return () => box.current!;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.get).mockRejectedValue(new Error('not needed'));
    vi.mocked(apiClient.post).mockImplementation(async (path: string) => {
        if (path === '/task-lists') return { id: 77, title: 'x', created_at: '', total_tasks: 0, completed_tasks: 0, body: null, attachments: null };
        throw new Error(`unexpected POST ${path}`);
    });
    let n = 500;
    vi.mocked(createListTask).mockImplementation(async (_l: number, text: string) => task(n++, text));
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    document.body.innerHTML = '';
});

describe('a copy of a text note', () => {
    const dentist: NewTaskTiming = { dueAt: '2026-09-21T09:00:00.000Z', schedule: '{"v":1}' };
    const bins: NewTaskTiming = { dueAt: '2026-09-22T07:00:00.000Z' };

    it('creates each item with ITS timing, aligned through the blank-dropping clean', async () => {
        const actions = mountActions();
        let ref: unknown;
        await act(async () => {
            ref = await actions().createNote('Errands (copy)', ['Dentist', '   ', 'Milk', 'Bins'], { body: 'Remember the list' }, [dentist, undefined, undefined, bins]);
        });
        expect(ref).toEqual({ kind: 'list', id: 77 });
        // Each item also carries its own create key (api/opKey.ts): a
        // random id, DIFFERENT per item even when the text repeats, so a
        // retry cannot duplicate one and the key can never fingerprint what
        // was written.
        const calls = vi.mocked(createListTask).mock.calls;
        expect(calls.map(c => c.slice(0, 4))).toEqual([
            [77, 'Dentist', undefined, dentist],
            [77, 'Milk', undefined, undefined],
            [77, 'Bins', undefined, bins],
        ]);
        const keys = calls.map(c => c[4] as string);
        expect(keys.every(k => OP_KEY_SHAPE.test(k))).toBe(true);
        expect(new Set(keys).size).toBe(3);
        expect(pokeTaskReminders).toHaveBeenCalledTimes(1);   // a dated item is on the server now
    });

    it('POSITIVE CONTROL: with no timing given, items are created without any and nothing is poked', async () => {
        const actions = mountActions();
        await act(async () => { await actions().createNote('Plain (copy)', ['One', 'Two'], { body: 'Text' }); });
        expect(vi.mocked(createListTask).mock.calls.map(c => c.slice(0, 4)))
            .toEqual([[77, 'One', undefined, undefined], [77, 'Two', undefined, undefined]]);
        expect(pokeTaskReminders).not.toHaveBeenCalled();
    });
});
