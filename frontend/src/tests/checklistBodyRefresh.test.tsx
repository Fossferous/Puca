/**
 * ChecklistBody's half of the Tasks view's Refresh: each personal list on
 * the All tasks board is a ChecklistBody that keeps its items itself, and
 * hands the view the way to read them again (registerRefresh). Nothing else
 * reads a personal list again — it has no live updates.
 *
 * That read follows the view's own rule (writesInFlight): an item whose
 * edit is still saving is waited for, not put back by an answer that left
 * before the save landed, and an answer that a change made while it was out
 * has overtaken is dropped. Handed the view's own count (`writes`), a card's
 * writes count there, so the view's lists answer — the card's counts — sees
 * them too. And a list deleted for good on another device (a 404) is an
 * answer, not a failure for the view to report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { listListTasks, updateListTask } = vi.hoisted(() => ({ listListTasks: vi.fn(), updateListTask: vi.fn() }));
vi.mock('../api/tasks', async () => {
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return { ...real, listListTasks, updateListTask };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => false, hasTaskFeature: () => false }));
vi.mock('../api/websocket', () => ({ wsClient: { on: () => {}, off: () => {}, joinRoom: () => {}, leaveRoom: () => {} } }));
// The rows as text, and the one change these tests make: new words saved for
// an item (what leaving its editor does).
vi.mock('../components/TaskTree', () => ({
    TaskTree: ({ tasks, onEdit }: { tasks: Array<{ id: number; description: string }>; onEdit: (t: unknown, text: string) => void }) => (
        <ul className="rows">{tasks.map(t => (
            <li key={t.id}>
                {t.description}
                <button type="button" aria-label={`Save ${t.description} as ${t.description}!`} onClick={() => onEdit(t, `${t.description}!`)} />
            </li>
        ))}</ul>
    ),
}));

import { ApiError } from '../api/client';
import { ChecklistBody } from '../components/ChecklistBody';
import { SAVE_WAIT_MS, type WritesInFlight, writesInFlight } from '../components/writesInFlight';

const item = (id: number, description: string) => ({ id, description, is_completed: false, parent_id: null, position: id, created_at: '', created_by: 7, attachments: null, due_at: null, list_id: 4, channel_id: null });

let root: Root;
let host: HTMLDivElement;
/** What the server holds for list 4, and whether the next read fails — or
 *  finds the list gone (deleted for good on another device: a 404). */
let server: Array<ReturnType<typeof item>>;
let failRead: boolean;
let listGone: boolean;
/** The registered reads (the embedder's side). */
let registered: Array<() => Promise<boolean>>;
const registerRefresh = (reread: () => Promise<boolean>) => {
    registered.push(reread);
    return () => { registered = registered.filter(r => r !== reread); };
};

beforeEach(() => {
    server = [item(1, 'Milk')];
    failRead = false;
    listGone = false;
    registered = [];
    listListTasks.mockReset(); updateListTask.mockReset();
    // A read answers with what the server held when it was asked.
    listListTasks.mockImplementation(async () => {
        const snapshot = server.map(t => ({ ...t }));
        if (failRead) { failRead = false; throw new Error('offline'); }
        if (listGone) throw new ApiError('List not found', 404);
        return snapshot;
    });
    updateListTask.mockImplementation(async (id: number, u: { description?: string }) => {
        server = server.map(t => (t.id === id && u.description !== undefined ? { ...t, description: u.description } : t));
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
async function mount(writes?: WritesInFlight) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><ChecklistBody listId={4} compact registerRefresh={registerRefresh} writes={writes} /></QueryClientProvider>); });
    await settle();
}
const rows = () => [...host.querySelectorAll('.rows li')].map(l => l.textContent);
async function tap(label: string) {
    const b = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(b, `the "${label}" button`).toBeTruthy();
    await act(async () => { b!.click(); });
}
/** The embedder's Refresh: run every registered read. */
async function refresh(): Promise<boolean[]> {
    let answers: boolean[] = [];
    await act(async () => { answers = await Promise.all(registered.map(r => r())); });
    await settle();
    return answers;
}

describe('a board card reads its list again for the Tasks view\'s Refresh', () => {
    it('positive control: without a refresh it reads once, and another device\'s item does not show', async () => {
        await mount();
        server.push(item(2, 'Eggs'));
        await settle();
        expect(listListTasks).toHaveBeenCalledTimes(1);
        expect(rows()).toEqual(['Milk']);
    });

    it('registers while mounted, and a refresh shows the list as the server has it', async () => {
        await mount();
        expect(registered).toHaveLength(1);
        server.push(item(2, 'Eggs'));
        expect(await refresh()).toEqual([true]);
        expect(listListTasks).toHaveBeenCalledTimes(2);
        expect(rows()).toEqual(['Milk', 'Eggs']);
        act(() => root.unmount());
        root = createRoot(host);
        expect(registered).toHaveLength(0);
    });

    it('an item whose edit is still saving is waited for, not put back', async () => {
        await mount();
        let land!: () => void;
        updateListTask.mockImplementationOnce(async (id: number, u: { description?: string }) => {
            await new Promise<void>(r => { land = r; });
            server = server.map(t => (t.id === id && u.description !== undefined ? { ...t, description: u.description } : t));
        });
        await tap('Save Milk as Milk!');
        let answers: boolean[] | null = null;
        const running = Promise.all(registered.map(r => r())).then(a => { answers = a; });
        await settle();
        // Nothing read behind the save: it would answer "Milk".
        expect(listListTasks).toHaveBeenCalledTimes(1);
        expect(rows()).toEqual(['Milk!']);
        expect(answers).toBeNull();

        land();
        await act(async () => { await running; });
        await settle();
        expect(answers).toEqual([true]);
        expect(listListTasks).toHaveBeenCalledTimes(2);
        expect(rows()).toEqual(['Milk!']);
    });

    it('a save that does not answer ends the wait: nothing is read, and nothing is reported wrong', async () => {
        await mount();
        updateListTask.mockImplementationOnce(() => new Promise<void>(() => {}));
        await tap('Save Milk as Milk!');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        let answers: boolean[] | null = null;
        const running = Promise.all(registered.map(r => r())).then(a => { answers = a; });
        await act(async () => { await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS - 1_000); });
        expect(answers).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
        await act(async () => { await running; });
        vi.useRealTimers();
        // Not read (the answer would be dropped), and not a failure to report:
        // the save that is still out reports its own.
        expect(answers).toEqual([true]);
        expect(listListTasks).toHaveBeenCalledTimes(1);
        expect(rows()).toEqual(['Milk!']);
    });

    it('an answer overtaken by a change made while it was out is dropped', async () => {
        await mount();
        let answer!: () => void;
        listListTasks.mockImplementationOnce(async () => {
            const snapshot = server.map(t => ({ ...t }));
            await new Promise<void>(r => { answer = r; });
            return snapshot;
        });
        const running = Promise.all(registered.map(r => r()));
        await settle();
        await tap('Save Milk as Milk!');
        await settle();
        expect(rows()).toEqual(['Milk!']);

        answer();
        await act(async () => { await running; });
        await settle();
        expect(rows()).toEqual(['Milk!']);
    });

    it('a read that fails answers false and keeps the items', async () => {
        await mount();
        failRead = true;
        expect(await refresh()).toEqual([false]);
        expect(rows()).toEqual(['Milk']);
    });

    it('a list deleted for good on another device reads as gone: an answer, not a failure', async () => {
        await mount();
        listGone = true;
        // The embedder's own lists read takes the card away; nothing about
        // the connection is wrong, so there is nothing to report.
        expect(await refresh()).toEqual([true]);
        expect(listListTasks).toHaveBeenCalledTimes(2);
    });

    it('handed the embedder\'s count, its writes count there — the embedder\'s answers see them', async () => {
        // Through onTasksChanged a tick here changes the embedder's copy of
        // the list too (its counts), so the embedder's Refresh has to know.
        const shared = writesInFlight();
        await mount(shared);
        let land!: () => void;
        updateListTask.mockImplementationOnce(async (id: number, u: { description?: string }) => {
            await new Promise<void>(r => { land = r; });
            server = server.map(t => (t.id === id && u.description !== undefined ? { ...t, description: u.description } : t));
        });
        const mark = shared.mark();
        await tap('Save Milk as Milk!');
        expect(shared.since(mark)).toBe(true);
        // And this body's own read waits on that count.
        let answers: boolean[] | null = null;
        const running = Promise.all(registered.map(r => r())).then(a => { answers = a; });
        await settle();
        expect(listListTasks).toHaveBeenCalledTimes(1);
        land();
        await act(async () => { await running; });
        await settle();
        expect(answers).toEqual([true]);
        expect(await shared.settled(SAVE_WAIT_MS)).toBe(true);
    });
});
