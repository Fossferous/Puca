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

const { listTasks, listListTasks, createTask, createListTask, deleteTask, wsHandlers } = vi.hoisted(() => ({
    listTasks: vi.fn(), listListTasks: vi.fn(), createTask: vi.fn(), createListTask: vi.fn(), deleteTask: vi.fn(),
    wsHandlers: new Set<(msg: unknown) => void>(),
}));
vi.mock('../api/tasks', async () => {
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return { ...real, listTasks, listListTasks, createTask, createListTask, deleteTask };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => false, hasTaskFeature: () => false }));
// The socket: what another member's edit sends this body (broadcast_checklist).
vi.mock('../api/websocket', () => ({
    wsClient: {
        on: (_type: string, h: (msg: unknown) => void) => { wsHandlers.add(h); },
        off: (_type: string, h: (msg: unknown) => void) => { wsHandlers.delete(h); },
        joinRoom: () => {}, leaveRoom: () => {},
    },
}));
vi.mock('../components/TaskTree', () => ({
    TaskTree: ({ tasks, onDelete }: { tasks: Array<{ id: number; description: string }>; onDelete: (id: number) => void }) => (
        <ul className="rows">{tasks.map(t => (
            <li key={t.id}>
                {t.description}
                <button type="button" aria-label={`Delete ${t.description}`} onClick={() => onDelete(t.id)} />
            </li>
        ))}</ul>
    ),
}));

import { ChecklistBody } from '../components/ChecklistBody';
import { ApiError } from '../api/client';
import { OP_KEY_SHAPE } from '../api/opKey';
import { PACE_MS } from '../api/icsImport';
import { PERM } from '../api/permissionBits';
import { setMessageToastSink } from '../components/messageToastBus';
import {
    ASSISTANT_ADD, ASSISTANT_ANSWER, ASSISTANT_HTML, ASSISTANT_ITEMS, ASSISTANT_RENDERED_LINES, ASSISTANT_RENDERED_TEXT, ASSISTANT_SHOWN,
} from './fixtures/assistantChecklist';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let toasts: string[];
let nextId: number;

const made = (text: string) => ({ id: nextId++, description: text, is_completed: false, parent_id: null, position: nextId, created_at: '', created_by: 7, attachments: null, due_at: null });

beforeEach(() => {
    toasts = [];
    nextId = 1;
    wsHandlers.clear();
    setMessageToastSink(t => { toasts.push(t.title); });
    listTasks.mockReset(); listListTasks.mockReset(); createTask.mockReset(); createListTask.mockReset(); deleteTask.mockReset();
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
/** Real time in short act() slices, so the body's effects run meanwhile.
 *  `ms` of the clock, however long a slice takes on a loaded machine: a
 *  count of slices stretched a 1 s wait past vitest's 5 s timeout. */
const wait = async (ms: number) => {
    const end = performance.now() + ms;
    while (performance.now() < end) await act(async () => { await new Promise(r => { setTimeout(r, 10); }); });
};
/**
 * Wait, as `wait` does, until `done()` holds, then settle. Bounded well
 * inside vitest's 5 s, so what never happens fails here and says what it was.
 *
 * The creates are PACED (icsImport's PACE_MS) on real timers, and on a loaded
 * machine every pause runs late. A fixed sleep of PACE_MS × N was a guess
 * about how late, and lost: 5 of 6 rows (2026-10-02). This waits for the
 * fact the test asserts on instead.
 */
async function until(done: () => boolean, what: () => string, ms = 3_000) {
    const giveUp = performance.now() + ms;
    while (!done()) {
        if (performance.now() > giveUp) throw new Error(`gave up after ${ms} ms waiting for ${what()}`);
        await act(async () => { await new Promise(r => { setTimeout(r, 10); }); });
    }
    await settle();
}
const creates = () => createTask.mock.calls.length + createListTask.mock.calls.length;
/** A batch is over: `n` creates were tried — the n-th may be the refusal
 *  that stops it — and a pause more passed, in which a create past the
 *  n-th, were there one, would have gone out. */
const paced = async (n: number) => {
    await until(() => creates() >= n, () => `${n} creates (${creates()} went out)`);
    await wait(PACE_MS * 2);
    await settle();
};
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
async function mount(props: { channelId?: number; listId?: number; myPerms?: number }) {
    await act(async () => { root!.render(<QueryClientProvider client={qc}><ChecklistBody {...props} /></QueryClientProvider>); });
    await settle();
}
/** A paste: the text, and the HTML beside it when there is one. */
function paste(el: Element, text: string, html?: string) {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
        value: {
            files: [], items: [], types: html ? ['text/plain', 'text/html'] : ['text/plain'],
            getData: (f: string) => (f === 'text/html' ? html ?? '' : text),
        },
    });
    act(() => { el.dispatchEvent(ev); });
    return ev;
}
const input = () => host!.querySelector<HTMLInputElement>('.checklist-add input');
const rows = () => [...host!.querySelectorAll('.rows li')].map(l => l.textContent);
const dialogLines = () => [...document.querySelectorAll('.notes-paste-line')].map(l => l.textContent);
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.notes-paste-actions button')]
    .find(b => b.textContent === text)!;
const addN = () => button(ASSISTANT_ADD);
/** Another member changed channel `channelId`'s checklist. */
const liveUpdate = (channelId: number) => act(() => {
    for (const h of wsHandlers) h({ type: 'ChecklistUpdate', payload: { channel_id: channelId } });
});

/**
 * A small server: what is created is kept per channel, and a read answers
 * with what it held when it was ASKED — late, for the channels in `slow`.
 * That is the read that races a batch: it left before the last few items
 * landed and comes back after they are on screen.
 */
function fakeServer() {
    const held = new Map<number, ReturnType<typeof made>[]>([[9, []], [10, [made('ten')]]]);
    const slow = new Set<number>();
    /** Channels whose next read waits until the test lets it answer. */
    const gates = new Map<number, Promise<void>>();
    /** Reads asked and not yet answered: the late one has landed at 0. */
    let out = 0;
    createTask.mockImplementation(async (c: number, text: string) => {
        const t = made(text);
        held.get(c)!.push(t);
        return t;
    });
    listTasks.mockImplementation(async (c: number) => {
        const snapshot = [...held.get(c)!];
        out++;
        try {
            if (slow.delete(c)) await new Promise(r => { setTimeout(r, PACE_MS * 3); });
            const gate = gates.get(c);
            if (gate) { gates.delete(c); await gate; }
            return snapshot;
        } finally {
            out--;
        }
    });
    deleteTask.mockImplementation(async (id: number) => {
        for (const items of held.values()) {
            const at = items.findIndex(t => t.id === id);
            if (at >= 0) items.splice(at, 1);
        }
    });
    /** Hold `c`'s next read; the result lets it answer. */
    const hold = (c: number) => {
        let answer!: () => void;
        gates.set(c, new Promise<void>(r => { answer = r; }));
        return async () => { await act(async () => { answer(); }); await settle(); };
    };
    /** Every read answered, and channel `c` holds `n` items. */
    const landed = (c: number, n: number) => until(
        () => held.get(c)!.length >= n && out === 0,
        () => `${n} items in channel ${c} (it holds ${held.get(c)!.length}) and no read out (${out} are)`,
    );
    return { held, slow, gates, hold, landed, reads: () => out };
}

describe('a checklist pasted into a channel checklist', () => {
    it('asks first, then creates the clean steps in order, each with its own key', async () => {
        await mount({ channelId: 9 });
        const ev = paste(input()!, ASSISTANT_ANSWER);
        expect(ev.defaultPrevented).toBe(true);
        expect(dialogLines()).toEqual(ASSISTANT_SHOWN);
        expect(createTask).not.toHaveBeenCalled();
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(createTask.mock.calls.map(c => [c[0], c[1]])).toEqual(ASSISTANT_ITEMS.map(t => [9, t]));
        const keys = createTask.mock.calls.map(c => c[4] as string);
        for (const k of keys) expect(k).toMatch(OP_KEY_SHAPE);
        expect(new Set(keys).size).toBe(keys.length);
        expect(rows()).toEqual(ASSISTANT_ITEMS);
    });

    it('copied as RENDERED text, it reads from its HTML: the same steps and heading', async () => {
        await mount({ channelId: 9 });
        // POSITIVE CONTROL: the plain text alone, one item per line.
        paste(input()!, ASSISTANT_RENDERED_TEXT);
        expect(dialogLines()).toEqual(ASSISTANT_RENDERED_LINES);
        act(() => { button('Cancel').click(); });
        paste(input()!, ASSISTANT_RENDERED_TEXT, ASSISTANT_HTML);
        expect(dialogLines()).toEqual(ASSISTANT_SHOWN);
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(createTask.mock.calls.map(c => c[1])).toEqual(ASSISTANT_ITEMS);
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
        await paced(3);
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

    it('the question takes the focus, so Enter adds nothing behind it; Cancel gives the focus back', async () => {
        await mount({ channelId: 9 });
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => { setter.call(input()!, 'Milk'); input()!.dispatchEvent(new Event('input', { bubbles: true })); });
        input()!.focus();
        paste(input()!, ASSISTANT_ANSWER);
        expect(document.activeElement?.closest('.notes-paste-dialog'), 'focus in the question').not.toBeNull();
        const form = host!.querySelector('.checklist-add') as HTMLFormElement;
        await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await settle();
        expect(createTask).not.toHaveBeenCalled();
        act(() => { button('Cancel').click(); });
        expect(document.activeElement).toBe(input());
        // POSITIVE CONTROL: with the question answered, Enter adds again.
        await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await settle();
        expect(createTask.mock.calls.map(c => c[1])).toEqual(['Milk']);
    });

    it('without CREATE_TASKS there is no add row to paste into', async () => {
        await mount({ channelId: 9, myPerms: PERM.COMPLETE_TASKS });
        expect(input()).toBeNull();
        // POSITIVE CONTROL: with the bit, the row is there.
        await mount({ channelId: 9, myPerms: PERM.CREATE_TASKS | PERM.COMPLETE_TASKS });
        expect(input()).not.toBeNull();
    });
});

describe('rows that land while the checklist is read again', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `step ${i + 1}`);

    it('every pasted row stays when the body is handed another channel and back while they land', async () => {
        const s = fakeServer();
        await mount({ channelId: 9 });
        paste(input()!, lines.join('\n'));
        act(() => { button(`Add ${lines.length} items`).click(); });
        await wait(PACE_MS * 3);
        await mount({ channelId: 10 });                       // the side panel followed the channel...
        s.slow.add(9);
        await mount({ channelId: 9 });                        // ...and back, with a read that answers late
        await s.landed(9, lines.length);
        expect(s.held.get(9)).toHaveLength(lines.length);
        expect(rows()).toEqual(lines);
    });

    it('every pasted row stays when another member’s edit makes it read again while they land', async () => {
        const s = fakeServer();
        await mount({ channelId: 9 });
        paste(input()!, lines.join('\n'));
        act(() => { button(`Add ${lines.length} items`).click(); });
        await wait(PACE_MS * 3);
        s.slow.add(9);
        liveUpdate(9);
        await s.landed(9, lines.length);
        expect(s.held.get(9)).toHaveLength(lines.length);
        expect(rows()).toEqual(lines);
    });

    it('an item deleted just after it landed does not come back with a read that was out', async () => {
        const s = fakeServer();
        await mount({ channelId: 9 });
        const answer = s.hold(9);
        liveUpdate(9);                                        // a read goes out, held until answer()
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => { setter.call(input()!, 'Milk'); input()!.dispatchEvent(new Event('input', { bubbles: true })); });
        const form = host!.querySelector('.checklist-add') as HTMLFormElement;
        await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await settle();
        expect(rows()).toEqual(['Milk']);
        act(() => { host!.querySelector<HTMLButtonElement>('[aria-label="Delete Milk"]')!.click(); });
        await settle();
        expect(s.held.get(9)).toEqual([]);
        expect(s.gates.size, 'the read went out and is still held').toBe(0);
        await answer();
        expect(rows()).toEqual([]);
    });

    it('a late read of the channel it showed before never lands in the one it shows now', async () => {
        const s = fakeServer();
        s.held.get(9)!.push(made('nine'));
        s.slow.add(9);
        await mount({ channelId: 9 });                        // its read is still out...
        await mount({ channelId: 10 });                       // ...when the panel follows the channel
        await until(() => s.reads() === 0, () => 'the late read of channel 9 to answer');
        expect(rows()).toEqual(['ten']);
    });
});

describe('another member’s pasted batch, as this body sees it', () => {
    it('is read again quietly, never through "Loading…", and a burst of updates is read twice, not once each', async () => {
        const s = fakeServer();
        await mount({ channelId: 9 });
        listTasks.mockClear();
        const remote = Array.from({ length: 20 }, (_, i) => `remote ${i + 1}`);
        let loadingSeen = false;
        const look = () => { if (host!.querySelector('.checklist-loading')) loadingSeen = true; };
        // One broadcast per create, back to back, as a pasted batch sends
        // them. The first read goes out with the first, holding only it.
        for (const text of remote) {
            s.held.get(9)!.push(made(text));
            liveUpdate(9);
            look();
        }
        // The second read goes out after a pause (LIVE_REREAD_GAP_MS); wait
        // for it to answer, not for a guess at how long that takes.
        await until(() => listTasks.mock.calls.length >= 2 && s.reads() === 0, () => `a second read to answer (${listTasks.mock.calls.length} asked)`);
        // "Loading…" swaps the tree out, and with it whatever row this viewer was editing.
        expect(loadingSeen, '"Loading…" during a live update').toBe(false);
        // One read at once, and ONE for everything that came after it.
        expect(listTasks).toHaveBeenCalledTimes(2);
        // That second read went out after the LAST update: its change is on screen.
        expect(rows()).toEqual(remote);
    });

    it('one update is still read at once', async () => {
        const s = fakeServer();
        await mount({ channelId: 9 });
        s.held.get(9)!.push(made('remote'));
        liveUpdate(9);
        await settle();
        expect(rows()).toEqual(['remote']);
        // POSITIVE CONTROL: another channel's update is not this body's.
        s.held.get(9)!.push(made('unseen'));
        liveUpdate(11);
        await wait(1000);
        expect(rows()).toEqual(['remote']);
    });
});
