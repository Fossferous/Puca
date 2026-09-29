/**
 * Refresh in Púca's Tasks view: the lists, and the list that is open, read
 * again on a tap — without undoing what the person has just done.
 *
 * The owner, asked about live updates for the Tasks tab: "A manual refresh
 * is fine". Until this the view read its lists once, when it opened, and a
 * list's items when it was picked, so a change made on another device showed
 * only after leaving the tab and coming back. Nothing sends this view a
 * personal list's changes — there is no one else to tell.
 *
 * What is pinned, beyond "it reads again":
 * - the tap that reaches the button takes the focus out of an item being
 *   edited, which SAVES it, and the read goes out behind that save. Read
 *   first and the answer is the item's old words, put back over the new ones
 *   on screen. So the refresh waits for the save (writesInFlight);
 * - a change made while the read is out is newer than its answer, which is
 *   dropped rather than let it undo the change;
 * - a save that never answers does not hold the button: after the bounded
 *   wait the refresh stops and says so;
 * - two taps before the button re-renders start one read, and so does a
 *   tap after it: busy is aria-disabled, not disabled, so the button keeps
 *   the keyboard focus and only the view's guard stops a tap;
 * - a read that fails says so, as every other failure in the view does;
 * - and, the positive control, without the button nothing is read again —
 *   so what the tests see is the button's doing.
 *
 * What the components BESIDE the view write while it is out (the note's
 * text, the trash, a board card, the Calendar tab) is
 * tasksViewRefreshRaces.test.tsx.
 *
 * The server is a small stateful fake behind a mocked apiClient: items are
 * sealed for real on the way in and opened through the real decrypt, and a
 * read answers with what the server held when it was ASKED.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, patch, del, put, cardReads, cardAnswers } = vi.hoisted(() => ({
    get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn(),
    /** The board cards' reads, by list id, and what each answers. */
    cardReads: [] as number[],
    cardAnswers: new Map<number, boolean>(),
}));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, post, patch, delete: del, put } };
});
// A board card keeps its items itself; here it only hands Refresh its read,
// the way the real one does (registerRefresh).
vi.mock('../components/ChecklistBody', async () => {
    const { useEffect } = await vi.importActual<typeof import('react')>('react');
    return {
        ChecklistBody: ({ listId, registerRefresh }: { listId?: number; registerRefresh?: (reread: () => Promise<boolean>) => () => void }) => {
            useEffect(() => registerRefresh?.(async () => {
                cardReads.push(listId!);
                return cardAnswers.get(listId!) ?? true;
            }), [registerRefresh, listId]);
            return null;
        },
    };
});
// The rows, reduced to their text and state, with the two changes a person
// makes to one: tick it, and save new words for it (what leaving its editor
// does — TaskTree commits on blur).
vi.mock('../components/TaskTree', () => ({
    TaskTree: ({ tasks, onToggle, onEdit }: {
        tasks: Array<{ id: number; description: string; is_completed: boolean }>;
        onToggle: (t: unknown, done: boolean) => void;
        onEdit: (t: unknown, text: string) => void;
    }) => (
        <ul className="rows">{tasks.map(t => (
            <li key={t.id} data-done={t.is_completed ? 'yes' : 'no'}>
                <span className="text">{t.description}</span>
                <button type="button" aria-label={`Tick ${t.description}`} onClick={() => onToggle(t, true)} />
                <button type="button" aria-label={`Save ${t.description} as Oat milk`} onClick={() => onEdit(t, 'Oat milk')} />
            </li>
        ))}</ul>
    ),
}));
vi.mock('../components/calendar/TasksCalendar', () => ({ TasksCalendar: () => null }));

import { ApiError } from '../api/client';
import { createListTask } from '../api/tasks';
import { TasksView } from '../components/TasksView';
import { setActiveIdentity } from '../api/e2ee';
import { setMessageToastSink } from '../components/messageToastBus';
import { SAVE_WAIT_MS } from '../components/writesInFlight';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const ME = ['tasks-refresh-pw', 'ef'.repeat(16)] as const;
const FAILED = 'Couldn’t refresh — check your connection';

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

const row = (id: number, title: string) => ({
    id, title, created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
    body: null, attachments: null, trashed_at: null, is_self: false,
});

/** The fake server: its lists, and each list's items as the wire holds them. */
let lists: Array<ReturnType<typeof row>>;
let stored: Map<number, Array<Record<string, unknown>>>;
let nextId: number;
/** Every GET path, in order. */
let reads: string[];
/** The next request for a key (`GET /task-lists`, `PATCH /tasks/100`) waits
 *  for its gate; `failing` keys fail instead of answering. */
let gates: Map<string, Promise<void>>;
let failing: Set<string>;
let toasts: string[];

let root: Root;
let container: HTMLDivElement;

beforeAll(async () => {
    await warmIdentities([ME]);
    setActiveIdentity(await testIdentity(...ME));
}, WARM_TIMEOUT_MS);

/** Hold the next request for `key` until the returned function is called. */
function hold(key: string): () => void {
    let release!: () => void;
    gates.set(key, new Promise<void>(r => { release = r; }));
    return () => release();
}
async function passGate(key: string) {
    const gate = gates.get(key);
    if (gate) { gates.delete(key); await gate; }
    if (failing.delete(key)) throw new ApiError('gateway', 502);
}

beforeEach(() => {
    if (!window.matchMedia) {
        window.matchMedia = ((q: string) => ({
            matches: false, media: q, onchange: null,
            addEventListener: () => {}, removeEventListener: () => {},
            addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
    lists = [row(1, 'List 1'), row(3, 'List 3')];
    stored = new Map([[1, []], [3, []]]);
    nextId = 100;
    reads = [];
    gates = new Map();
    failing = new Set();
    toasts = [];
    cardReads.length = 0;
    cardAnswers.clear();
    setMessageToastSink(t => { toasts.push(t.title); });
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    get.mockImplementation(async (path: string) => {
        reads.push(path);
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, content_rev: true, idempotent_creates: true };
        if (path === '/task-tab-prefs') return [];
        if (path === '/servers') return [];
        if (path === '/task-lists?trashed=true') return [];
        // What the server held when it was asked, answered when the gate opens.
        if (path === '/task-lists') {
            const snapshot = lists.map(l => ({ ...l }));
            await passGate(`GET ${path}`);
            return snapshot;
        }
        const m = /^\/task-lists\/(\d+)\/tasks$/.exec(path);
        if (m) {
            const snapshot = (stored.get(Number(m[1])) ?? []).map(t => ({ ...t }));
            await passGate(`GET ${path}`);
            return snapshot;
        }
        throw new Error(`unexpected GET ${path}`);
    });
    post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
        const m = /^\/task-lists\/(\d+)\/tasks$/.exec(path);
        if (!m) throw new Error(`unexpected POST ${path}`);
        const items = stored.get(Number(m[1]))!;
        const t = { id: nextId++, list_id: Number(m[1]), channel_id: null, parent_id: null, description: body.description, is_completed: false, created_at: '2026-09-01T00:00:00Z', created_by: 1, position: items.length + 1, attachments: null, due_at: null };
        items.push(t);
        return { ...t };
    });
    // A change lands on the server when its gate opens, not before.
    patch.mockImplementation(async (path: string, body: Record<string, unknown>) => {
        const m = /^\/tasks\/(\d+)$/.exec(path);
        if (!m) throw new Error(`unexpected PATCH ${path}`);
        await passGate(`PATCH ${path}`);
        for (const items of stored.values()) {
            const t = items.find(x => x.id === Number(m[1]));
            if (!t) continue;
            if (body.description !== undefined) t.description = body.description;
            if (body.is_completed !== undefined) t.is_completed = body.is_completed;
        }
        return {};
    });
    put.mockResolvedValue({});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    document.body.innerHTML = '';
    setMessageToastSink(null);
    vi.useRealTimers();
});

async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><TasksView /></QueryClientProvider>); });
    await settle();
}

async function openList(label: string) {
    const tab = [...container.querySelectorAll<HTMLButtonElement>('.tasks-tab')].find(b => b.textContent?.includes(label));
    expect(tab, `the "${label}" tab`).toBeTruthy();
    await act(async () => { tab!.click(); });
    await settle();
}

const refreshButton = () => {
    const b = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]');
    expect(b, 'the Refresh button').toBeTruthy();
    return b!;
};
/** Refresh says it is running (aria-busy, with the spin and the dimming). */
const busy = () => refreshButton().getAttribute('aria-busy') === 'true';
async function tap(label: string) {
    const b = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(b, `the "${label}" button`).toBeTruthy();
    await act(async () => { b!.click(); });
}
const rows = () => [...container.querySelectorAll('.rows li')].map(li => `${li.querySelector('.text')?.textContent}${li.getAttribute('data-done') === 'yes' ? ' [done]' : ''}`);
const tabTitles = () => [...container.querySelectorAll('.tasks-tab-scroll .tasks-tab-title')].map(e => e.textContent);
const countReads = (path: string) => reads.filter(p => p === path).length;
/** An item added on the server by another device (sealed to this account,
 *  as that device would). */
async function addedElsewhere(listId: number, text: string) {
    await createListTask(listId, text);
}

describe('Refresh reads again what the Tasks view shows', () => {
    it('positive control: without the button nothing is read again, and another device\'s change does not show', async () => {
        await addedElsewhere(1, 'Milk');
        await mount();
        await openList('List 1');
        expect(rows()).toEqual(['Milk']);
        const listReads = countReads('/task-lists');
        const itemReads = countReads('/task-lists/1/tasks');

        await addedElsewhere(1, 'Eggs');
        lists.push(row(5, 'List 5'));
        await settle();
        await settle();

        expect(countReads('/task-lists')).toBe(listReads);
        expect(countReads('/task-lists/1/tasks')).toBe(itemReads);
        expect(rows()).toEqual(['Milk']);
        expect(tabTitles()).not.toContain('List 5');
    });

    it('reads the lists and the open list\'s items again, and the list stays open where it was', async () => {
        await addedElsewhere(1, 'Milk');
        await mount();
        await openList('List 1');
        const editor = container.querySelector('.tasks-editor');
        expect(editor).toBeTruthy();
        const listReads = countReads('/task-lists');
        const itemReads = countReads('/task-lists/1/tasks');
        const trashReads = countReads('/task-lists?trashed=true');

        await addedElsewhere(1, 'Eggs');
        lists.push(row(5, 'List 5'));
        await tap('Refresh');
        await settle();

        expect(countReads('/task-lists')).toBe(listReads + 1);
        expect(countReads('/task-lists/1/tasks')).toBe(itemReads + 1);
        // The trash below the board is read again too (a list trashed or
        // restored on the other device).
        expect(countReads('/task-lists?trashed=true')).toBe(trashReads + 1);
        expect(rows()).toEqual(['Milk', 'Eggs']);
        expect(tabTitles()).toContain('List 5');
        // Still on List 1, in the SAME editor: nothing was swapped for
        // "Loading…", so the scroll and an open editor are where they were.
        expect(container.querySelector('.tasks-tab.active')?.textContent).toContain('List 1');
        expect(container.querySelector('.tasks-editor')).toBe(editor);
        expect(toasts).toEqual([]);
    });

    it('a second tap while it runs starts no second read, and the button says it is busy', async () => {
        await mount();
        const listReads = countReads('/task-lists');
        const release = hold('GET /task-lists');

        // Two taps before the first one's render, then one after it: the view's
        // own guard stops both — the button is never natively disabled.
        await act(async () => { refreshButton().click(); refreshButton().click(); });
        await settle();
        await tap('Refresh');
        await settle();
        expect(countReads('/task-lists')).toBe(listReads + 1);
        expect(refreshButton().getAttribute('aria-disabled')).toBe('true');
        expect(refreshButton().getAttribute('aria-busy')).toBe('true');
        expect(refreshButton().classList.contains('busy')).toBe(true);

        release();
        await settle();
        expect(refreshButton().getAttribute('aria-disabled')).toBe('false');
        expect(refreshButton().getAttribute('aria-busy')).toBe('false');
        expect(refreshButton().classList.contains('busy')).toBe(false);
        // And it is not stuck: the next tap reads again.
        await tap('Refresh');
        await settle();
        expect(countReads('/task-lists')).toBe(listReads + 2);
    });

    it('while it runs the button keeps the keyboard focus: busy is aria-disabled, never disabled', async () => {
        // A browser moves the focus off a focused button that becomes
        // disabled — to the page, where it stays (measured in headless
        // Chromium: activeElement is BODY during and after, and the next
        // Enter does nothing). jsdom has no such rule, so what is pinned here
        // is the cause: the button is not natively disabled while busy.
        await mount();
        const release = hold('GET /task-lists');
        refreshButton().focus();
        await tap('Refresh');
        await settle();
        expect(busy()).toBe(true);
        expect(refreshButton().disabled).toBe(false);
        expect(refreshButton().getAttribute('aria-disabled')).toBe('true');
        expect(document.activeElement).toBe(refreshButton());
        release();
        await settle();
        expect(document.activeElement).toBe(refreshButton());
    });

    it('an item whose edit is still saving is not put back: the read waits for the save', async () => {
        await addedElsewhere(1, 'Milk');
        await mount();
        await openList('List 1');
        const itemReads = countReads('/task-lists/1/tasks');
        const milkId = stored.get(1)![0].id as number;

        // The person leaves Milk's editor with new words — the tap on Refresh
        // is what takes the focus out of it — and the save is slow.
        const landSave = hold(`PATCH /tasks/${milkId}`);
        await tap('Save Milk as Oat milk');
        await tap('Refresh');
        await settle();
        expect(rows()).toEqual(['Oat milk']);
        // No read has gone out behind the save: it would answer "Milk".
        expect(countReads('/task-lists/1/tasks')).toBe(itemReads);

        landSave();
        await settle();
        expect(countReads('/task-lists/1/tasks')).toBe(itemReads + 1);
        expect(rows()).toEqual(['Oat milk']);
        expect(toasts).toEqual([]);
    });

    it('a save that does not answer stops Refresh after the wait, and says so: the button is not held', async () => {
        await addedElsewhere(1, 'Milk');
        await mount();
        await openList('List 1');
        const listReads = countReads('/task-lists');
        const itemReads = countReads('/task-lists/1/tasks');
        const milkId = stored.get(1)![0].id as number;

        // The save goes out on a connection that has gone quiet: it never
        // answers (nothing times a request out).
        hold(`PATCH /tasks/${milkId}`);
        await tap('Save Milk as Oat milk');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await tap('Refresh');
        await act(async () => { await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS - 1_000); });
        expect(busy()).toBe(true);
        expect(toasts).toEqual([]);

        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
        vi.useRealTimers();
        await settle();
        expect(toasts).toEqual(['Still saving your last change — try again in a moment']);
        expect(busy()).toBe(false);
        // Nothing was read: the answer would have been older than the screen.
        expect(countReads('/task-lists')).toBe(listReads);
        expect(countReads('/task-lists/1/tasks')).toBe(itemReads);
        expect(rows()).toEqual(['Oat milk']);
    });

    it('a change made while the read is out is not undone by its answer', async () => {
        await addedElsewhere(1, 'Milk');
        await mount();
        await openList('List 1');

        // The read leaves before the tick and answers after it.
        const answer = hold('GET /task-lists/1/tasks');
        await tap('Refresh');
        await settle();
        await tap('Tick Milk');
        await settle();
        expect(rows()).toEqual(['Milk [done]']);

        answer();
        await settle();
        expect(rows()).toEqual(['Milk [done]']);
        expect(busy()).toBe(false);
    });

    it('a failed read of the lists says so, and keeps what is on screen', async () => {
        await mount();
        expect(tabTitles()).toEqual(['All tasks', 'Calendar', 'Reminders', 'List 1', 'List 3']);
        failing.add('GET /task-lists');
        await tap('Refresh');
        await settle();
        expect(toasts).toEqual([FAILED]);
        expect(tabTitles()).toEqual(['All tasks', 'Calendar', 'Reminders', 'List 1', 'List 3']);
        expect(busy()).toBe(false);
    });

    it('a failed read of the open list says so, and keeps its items', async () => {
        await addedElsewhere(1, 'Milk');
        await mount();
        await openList('List 1');
        failing.add('GET /task-lists/1/tasks');
        await tap('Refresh');
        await settle();
        expect(toasts).toEqual([FAILED]);
        expect(rows()).toEqual(['Milk']);
    });

    it('on the All tasks board it reads every list card again, and a card that fails says so', async () => {
        await mount();
        expect(cardReads).toEqual([]);
        await tap('Refresh');
        await settle();
        expect([...cardReads].sort()).toEqual([1, 3]);
        expect(toasts).toEqual([]);

        cardAnswers.set(3, false);
        await tap('Refresh');
        await settle();
        expect(toasts).toEqual([FAILED]);
    });
});
