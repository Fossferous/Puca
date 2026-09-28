/**
 * ChecklistBody's "Add an item…" takes a pasted step-by-step checklist the
 * way Púca Notes and the Tasks view do (components/usePasteItems): one
 * question first, then the clean steps, in order, one create each.
 *
 * ChecklistBody is every channel checklist on the Púca page — the side
 * panel, a checklist channel's main content, the All-checklists board and
 * the Tasks board's cards — and the one of them that can be handed ANOTHER
 * channel while it stays mounted (the side panel follows the channel). So
 * the target is pinned here too: a paste lands where it was pasted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { listTasks, listListTasks, createTask, createListTask } = vi.hoisted(() => ({
    listTasks: vi.fn(), listListTasks: vi.fn(), createTask: vi.fn(), createListTask: vi.fn(),
}));
vi.mock('../api/tasks', async () => {
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return { ...real, listTasks, listListTasks, createTask, createListTask };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => false, hasTaskFeature: () => false }));
vi.mock('../api/websocket', () => ({ wsClient: { on: () => {}, off: () => {}, joinRoom: () => {}, leaveRoom: () => {} } }));
vi.mock('../components/TaskTree', () => ({
    TaskTree: ({ tasks }: { tasks: Array<{ id: number; description: string }> }) => (
        <ul className="rows">{tasks.map(t => <li key={t.id}>{t.description}</li>)}</ul>
    ),
}));

import { ChecklistBody } from '../components/ChecklistBody';
import { ApiError } from '../api/client';
import { OP_KEY_SHAPE } from '../api/opKey';
import { PACE_MS } from '../api/icsImport';
import { PERM } from '../api/permissionBits';
import { setMessageToastSink } from '../components/messageToastBus';
import { ASSISTANT_ANSWER, ASSISTANT_ITEMS } from './fixtures/assistantChecklist';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let toasts: string[];
let nextId: number;

const made = (text: string) => ({ id: nextId++, description: text, is_completed: false, parent_id: null, position: nextId, created_at: '', created_by: 7, attachments: null, due_at: null });

beforeEach(() => {
    toasts = [];
    nextId = 1;
    setMessageToastSink(t => { toasts.push(t.title); });
    listTasks.mockReset(); listListTasks.mockReset(); createTask.mockReset(); createListTask.mockReset();
    listTasks.mockResolvedValue([]);
    listListTasks.mockResolvedValue([]);
    createTask.mockImplementation(async (_c: number, text: string) => made(text));
    createListTask.mockImplementation(async (_l: number, text: string) => made(text));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    document.body.innerHTML = '';
    root = null;
    host = null;
    setMessageToastSink(null);
});

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const paced = async (n: number) => {
    await act(async () => { await new Promise(r => { setTimeout(r, PACE_MS * n + 100); }); });
    await settle();
};
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
async function mount(props: { channelId?: number; listId?: number; myPerms?: number }) {
    await act(async () => { root!.render(<QueryClientProvider client={qc}><ChecklistBody {...props} /></QueryClientProvider>); });
    await settle();
}
function paste(el: Element, text: string) {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { files: [], items: [], types: ['text/plain'], getData: () => text } });
    act(() => { el.dispatchEvent(ev); });
    return ev;
}
const input = () => host!.querySelector<HTMLInputElement>('.checklist-add input');
const rows = () => [...host!.querySelectorAll('.rows li')].map(l => l.textContent);
const dialogLines = () => [...document.querySelectorAll('.notes-paste-line')].map(l => l.textContent);
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.notes-paste-actions button')]
    .find(b => b.textContent === text)!;
const addN = () => button(`Add ${ASSISTANT_ITEMS.length} items`);

describe('a checklist pasted into a channel checklist', () => {
    it('asks first, then creates the clean steps in order, each with its own key', async () => {
        await mount({ channelId: 9 });
        const ev = paste(input()!, ASSISTANT_ANSWER);
        expect(ev.defaultPrevented).toBe(true);
        expect(dialogLines()).toEqual(ASSISTANT_ITEMS);
        expect(createTask).not.toHaveBeenCalled();
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(createTask.mock.calls.map(c => [c[0], c[1]])).toEqual(ASSISTANT_ITEMS.map(t => [9, t]));
        const keys = createTask.mock.calls.map(c => c[4] as string);
        for (const k of keys) expect(k).toMatch(OP_KEY_SHAPE);
        expect(new Set(keys).size).toBe(keys.length);
        expect(rows()).toEqual(ASSISTANT_ITEMS);
    });

    it('a personal list rendered here (Notes to self, a board card) takes it the same way', async () => {
        await mount({ listId: 4 });
        paste(input()!, ASSISTANT_ANSWER);
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(createListTask.mock.calls.map(c => [c[0], c[1]])).toEqual(ASSISTANT_ITEMS.map(t => [4, t]));
        expect(rows()).toEqual(ASSISTANT_ITEMS);
    });

    it('lands in the channel it was pasted into, even when this body is handed another one meanwhile', async () => {
        await mount({ channelId: 9 });
        paste(input()!, ASSISTANT_ANSWER);
        act(() => { addN().click(); });
        await mount({ channelId: 10 });                       // the side panel followed the channel
        await paced(ASSISTANT_ITEMS.length);
        expect(createTask.mock.calls.every(c => c[0] === 9)).toBe(true);
        expect(createTask).toHaveBeenCalledTimes(ASSISTANT_ITEMS.length);
        expect(rows()).toEqual([]);                           // channel 10 shows none of them
    });

    it('a second paste confirmed while the first is landing waits its turn: the lists never interleave', async () => {
        await mount({ channelId: 9 });
        paste(input()!, ASSISTANT_ANSWER);
        act(() => { addN().click(); });
        paste(input()!, 'Tea\nCoffee');
        act(() => { button('Add 2 items').click(); });
        await paced(ASSISTANT_ITEMS.length + 2);
        expect(createTask.mock.calls.map(c => c[1])).toEqual([...ASSISTANT_ITEMS, 'Tea', 'Coffee']);
        expect(rows()).toEqual([...ASSISTANT_ITEMS, 'Tea', 'Coffee']);
    });

    it('stops at the first refusal, and says how many landed and why', async () => {
        await mount({ channelId: 9 });
        let n = 0;
        createTask.mockImplementation(async (_c: number, text: string) => {
            if (n++ === 2) throw new ApiError('Missing Create Tasks permission', 403);
            return made(text);
        });
        paste(input()!, ASSISTANT_ANSWER);
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(createTask).toHaveBeenCalledTimes(3);
        expect(rows()).toEqual(ASSISTANT_ITEMS.slice(0, 2));
        expect(toasts).toEqual(['Missing Create Tasks permission', `Added 2 of ${ASSISTANT_ITEMS.length} items`]);
    });

    it('Cancel creates nothing, "Add as one item" only fills the box, and one line is not intercepted', async () => {
        await mount({ channelId: 9 });
        paste(input()!, ASSISTANT_ANSWER);
        act(() => { button('Cancel').click(); });
        paste(input()!, 'Milk\nBread');
        act(() => { button('Add as one item').click(); });
        await settle();
        expect(createTask).not.toHaveBeenCalled();
        expect(input()!.value).toBe('Milk Bread');
        const one = paste(input()!, 'Eggs');
        expect(one.defaultPrevented).toBe(false);
        expect(document.querySelector('.notes-paste-dialog')).toBeNull();
    });

    it('without CREATE_TASKS there is no add row to paste into', async () => {
        await mount({ channelId: 9, myPerms: PERM.COMPLETE_TASKS });
        expect(input()).toBeNull();
        // POSITIVE CONTROL: with the bit, the row is there.
        await mount({ channelId: 9, myPerms: PERM.CREATE_TASKS | PERM.COMPLETE_TASKS });
        expect(input()).not.toBeNull();
    });
});
