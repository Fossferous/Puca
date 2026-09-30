/**
 * Refresh in Púca's Tasks view against what the REAL components beside it
 * write: the note's text (ListContentBlock / NoteBodyField), the trash
 * (TasksTrash), the board's list cards (ChecklistBody) and the Calendar
 * tab's cache (useTaskSources). tasksViewRefresh.test.tsx pins the view's
 * own handlers; this file pins the writes it does not make itself.
 *
 * Refresh's rule (writesInFlight): an answer read before a change landed is
 * older than the screen and must not be put over it. That only holds for a
 * change Refresh can SEE — each component that writes a list has to count
 * its writes as the view's, or its change is quietly undone:
 * - text typed into a note while Refresh is out: the lists answer brought
 *   the old text back into the field, and the list's old revision with it,
 *   so the next save was refused as a conflict with the person's own words;
 * - a list restored from the trash while Refresh is out: it left the bar and
 *   went back into the trash (and one deleted forever came back into it);
 * - an item ticked on a board card: the card kept the tick, and its header
 *   went back to the old count.
 * And two more a review found:
 * - a note's text save that never answers held the button forever (the
 *   bound covered every other save, not that one);
 * - a list deleted for good on another device answers 404, which is an
 *   answer, not a broken connection — Refresh said "check your connection"
 *   for the open list, for a board card and for the Calendar tab. A read
 *   that really fails there still says so.
 *
 * Every test asserts the read it races was really asked, so none can pass
 * because Refresh read nothing. The server is a stateful fake behind a
 * mocked apiClient; items, titles and note text are sealed and opened for
 * real, and a read answers with what the server held when it was ASKED.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, patch, del, put } = vi.hoisted(() => ({
    get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn(),
}));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, post, patch, delete: del, put } };
});
// The rows, reduced to their text and state, with a tick for each — in the
// open list and on every board card alike.
vi.mock('../components/TaskTree', () => ({
    TaskTree: ({ tasks, onToggle }: {
        tasks: Array<{ id: number; description: string; is_completed: boolean }>;
        onToggle: (t: unknown, done: boolean) => void;
    }) => (
        <ul className="rows">{tasks.map(t => (
            <li key={t.id} data-done={t.is_completed ? 'yes' : 'no'}>
                <span className="text">{t.description}</span>
                <button type="button" aria-label={`Tick ${t.description}`} onClick={() => onToggle(t, true)} />
            </li>
        ))}</ul>
    ),
}));
// The Calendar tab, reduced to its real read of every scope (useTaskSources).
vi.mock('../components/calendar/TasksCalendar', async () => {
    const { useTaskSources } = await vi.importActual<typeof import('../components/taskSources')>('../components/taskSources');
    return {
        TasksCalendar: ({ lists, channels }: { lists: never[]; channels: never[] }) => {
            useTaskSources(lists, channels);
            return <div className="calendar-stand-in" />;
        },
    };
});

import { ApiError } from '../api/client';
import { createListTask } from '../api/tasks';
import { flushBodySave } from '../api/listContent';
import { TasksView } from '../components/TasksView';
import { setActiveIdentity } from '../api/e2ee';
import { setMessageToastSink } from '../components/messageToastBus';
import { SAVE_WAIT_MS } from '../components/writesInFlight';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const ME = ['tasks-refresh-races-pw', 'cd'.repeat(16)] as const;
const FAILED = 'Couldn’t refresh — check your connection';
const STILL_SAVING = 'Still saving your last change — try again in a moment';

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

/**
 * Wait in REAL time for work the event loop finishes by itself: sealing a
 * note's text is WebCrypto, whose promises settle from Node's thread pool,
 * not from the fake clock. Advancing fake time does not wait for it.
 *
 * WHY (0.9.830 CI, 2026-09-30): on a slow runner the seal was still running
 * when "a note text save that never answers" advanced its clock, so the save
 * had not gone out yet ("expected [] to have a length of 1"), and when it did
 * it landed in the NEXT test's fake server, spending that test's held gate
 * and bumping its revision ("expected 3 to be 2"). Both reproduced on demand
 * by holding the first test's seal until the second test set its hold.
 *
 * setImmediate is not among the faked timers below, and performance.now is
 * real, so this turns the real loop while the fake clock stands still.
 * It gives up well inside vitest's 5 s test timeout: a timed-out test is
 * killed inside act() and takes the tests after it down with it, where
 * this failure names what never happened.
 */
async function untilReally(what: string, done: () => boolean, ms = 3_000) {
    const end = performance.now() + ms;
    while (!done()) {
        if (performance.now() > end) throw new Error(`gave up after ${ms} ms waiting for ${what}`);
        await act(async () => { await new Promise<void>(r => setImmediate(r)); });
    }
}

interface Row {
    id: number; title: string; created_at: string; body: string | null; attachments: string | null;
    trashed_at: string | null; is_self: boolean; content_rev: number;
}
const row = (id: number, title: string, trashed_at: string | null = null): Row => ({
    id, title, created_at: '2026-09-01T00:00:00Z', body: null, attachments: null, trashed_at, is_self: false, content_rev: 1,
});

/** The fake server: live lists, the trash, each list's items as the wire
 *  holds them, and the lists deleted for good (their reads answer 404). */
let lists: Row[];
let trash: Row[];
let stored: Map<number, Array<Record<string, unknown>>>;
let gone: Set<number>;
let nextId: number;
/** Every GET path, in order. */
let reads: string[];
/** Every note-text save's payload, in order. */
let bodySaves: Array<Record<string, unknown>>;
/** The next request for a key waits for its gate; `failing` keys fail. */
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
/** A list row as GET /task-lists answers it: its counts from its items. */
const asListed = (l: Row) => {
    const items = stored.get(l.id) ?? [];
    return { ...l, total_tasks: items.length, completed_tasks: items.filter(t => t.is_completed).length };
};

beforeEach(() => {
    if (!window.matchMedia) {
        window.matchMedia = ((q: string) => ({
            matches: false, media: q, onchange: null,
            addEventListener: () => {}, removeEventListener: () => {},
            addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
    lists = [row(1, 'List 1'), row(3, 'List 3')];
    trash = [];
    stored = new Map([[1, []], [3, []], [7, []]]);
    gone = new Set();
    nextId = 100;
    reads = [];
    bodySaves = [];
    gates = new Map();
    failing = new Set();
    toasts = [];
    setMessageToastSink(t => { toasts.push(t.title); });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    get.mockImplementation(async (path: string) => {
        reads.push(path);
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, content_rev: true, idempotent_creates: true };
        if (path === '/task-features') return { version: 1, features: [] };
        if (path === '/task-tab-prefs') return [];
        if (path === '/servers') return [];
        // What the server held when it was asked, answered when the gate opens.
        if (path === '/task-lists?trashed=true') {
            const snapshot = trash.map(l => ({ ...asListed(l) }));
            await passGate('GET trash');
            return snapshot;
        }
        if (path === '/task-lists') {
            const snapshot = lists.map(asListed);
            await passGate(`GET ${path}`);
            return snapshot;
        }
        const m = /^\/task-lists\/(\d+)\/tasks$/.exec(path);
        if (m) {
            const id = Number(m[1]);
            if (gone.has(id)) throw new ApiError('List not found', 404);
            const snapshot = (stored.get(id) ?? []).map(t => ({ ...t }));
            await passGate(`GET ${path}`);
            return snapshot;
        }
        throw new Error(`unexpected GET ${path}`);
    });
    post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
        const restore = /^\/task-lists\/(\d+)\/restore$/.exec(path);
        if (restore) {
            const l = trash.find(x => x.id === Number(restore[1]))!;
            trash = trash.filter(x => x !== l);
            lists.push({ ...l, trashed_at: null });
            return { trashed_at: null };
        }
        const m = /^\/task-lists\/(\d+)\/tasks$/.exec(path);
        if (!m) throw new Error(`unexpected POST ${path}`);
        const items = stored.get(Number(m[1]))!;
        const t = { id: nextId++, list_id: Number(m[1]), channel_id: null, parent_id: null, description: body.description, is_completed: false, created_at: '2026-09-01T00:00:00Z', created_by: 1, position: items.length + 1, attachments: null, due_at: null };
        items.push(t);
        return { ...t };
    });
    // A change lands on the server when its gate opens, not before.
    patch.mockImplementation(async (path: string, body: Record<string, unknown>) => {
        const list = /^\/task-lists\/(\d+)$/.exec(path);
        if (list) {
            bodySaves.push(body);
            await passGate(`PATCH ${path}`);
            const l = lists.find(x => x.id === Number(list[1]))!;
            if ('body' in body) l.body = (body.body as string) || null;
            l.content_rev++;
            return { content_rev: l.content_rev };
        }
        const m = /^\/tasks\/(\d+)$/.exec(path);
        if (!m) throw new Error(`unexpected PATCH ${path}`);
        await passGate(`PATCH ${path}`);
        for (const items of stored.values()) {
            const t = items.find(x => x.id === Number(m[1]));
            if (t && body.is_completed !== undefined) t.is_completed = body.is_completed;
        }
        return {};
    });
    del.mockImplementation(async (path: string) => {
        const m = /^\/task-lists\/(\d+)$/.exec(path);
        if (!m) throw new Error(`unexpected DELETE ${path}`);
        const id = Number(m[1]);
        trash = trash.filter(l => l.id !== id);
        lists = lists.filter(l => l.id !== id);
        gone.add(id);
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
    vi.restoreAllMocks();
});

async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><TasksView /></QueryClientProvider>); });
    await settle();
}
async function openTab(label: string) {
    const tab = [...container.querySelectorAll<HTMLButtonElement>('.tasks-tab')].find(b => b.textContent?.includes(label));
    expect(tab, `the "${label}" tab`).toBeTruthy();
    await act(async () => { tab!.click(); });
    await settle();
}
async function tap(label: string, within: ParentNode = container) {
    const b = within.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(b, `the "${label}" button`).toBeTruthy();
    await act(async () => { b!.click(); });
}
async function tapText(text: string) {
    const b = [...container.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent === text);
    expect(b, `the "${text}" button`).toBeTruthy();
    await act(async () => { b!.click(); });
}
const refreshButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;
const busy = () => refreshButton().getAttribute('aria-busy') === 'true';
const tabTitles = () => [...container.querySelectorAll('.tasks-tab-scroll .tasks-tab-title')].map(e => e.textContent);
const countReads = (path: string) => reads.filter(p => p === path).length;
const noteField = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note text"]');
/** Type into the note's text field as a person does (React reads `input`). */
async function typeNote(text: string) {
    const area = noteField();
    expect(area, 'the note text field').toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area!, text);
        area!.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const card = (title: string) => [...container.querySelectorAll<HTMLElement>('section.checklist-card')]
    .find(s => s.querySelector('.checklist-card-header')?.textContent?.includes(title)) ?? null;

describe('Refresh and the writes the Tasks view does not make itself', () => {
    it('text typed into the note while Refresh is out stays, and so does the revision it saved', async () => {
        await mount();
        await openTab('List 1');
        const listReads = countReads('/task-lists');
        const answer = hold('GET /task-lists');
        await tap('Refresh');
        await settle();
        expect(countReads('/task-lists')).toBe(listReads + 1);

        // Typed while the read is out, and saved (the pause, or leaving the
        // field): the server now holds it, at revision 2.
        await typeNote('Typed during refresh');
        await act(async () => { await flushBodySave(1); });
        await settle();
        expect(bodySaves).toHaveLength(1);
        expect(lists[0].content_rev).toBe(2);

        // The lists answer was read before that save: text-less, revision 1.
        answer();
        await settle();
        expect(noteField()?.value).toBe('Typed during refresh');
        expect(busy()).toBe(false);

        // And the next save is based on the revision the last one made — an
        // old one would be refused as a conflict with the person's own words.
        await typeNote('Typed during refresh, and more');
        await act(async () => { await flushBodySave(1); });
        await settle();
        expect(bodySaves).toHaveLength(2);
        expect(bodySaves[1].expect_rev).toBe(2);
    });

    it('a note text save that never answers stops Refresh at the same bound, and says so', async () => {
        await mount();
        await openTab('List 1');
        const listReads = countReads('/task-lists');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        // The save goes out on a connection gone quiet: it never answers.
        hold('PATCH /task-lists/1');
        await typeNote('Words that are still saving');
        await tap('Refresh');
        // The save really goes out (its seal is real work), and only then
        // does the clock move: the bound is timed from the tap, not from here.
        await untilReally('the note text save to go out', () => bodySaves.length === 1);
        await act(async () => { await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS - 1_000); });
        // It went out once, and Refresh is waiting for it.
        expect(bodySaves).toHaveLength(1);
        expect(busy()).toBe(true);
        expect(toasts).toEqual([]);

        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
        vi.useRealTimers();
        await settle();
        expect(toasts).toEqual([STILL_SAVING]);
        expect(busy()).toBe(false);
        // Nothing was read: the answer would have been older than the screen.
        expect(countReads('/task-lists')).toBe(listReads);
        expect(noteField()?.value).toBe('Words that are still saving');
    });

    it('the note text\'s wait and every other save\'s share ONE bound, not one each', async () => {
        await createListTask(1, 'Milk');
        await mount();
        await openTab('List 1');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        // A tick whose save never answers, and note text whose save takes
        // most of the bound before it lands.
        const milkId = stored.get(1)![0].id as number;
        hold(`PATCH /tasks/${milkId}`);
        await tap('Tick Milk');
        const landNote = hold('PATCH /task-lists/1');
        setTimeout(landNote, SAVE_WAIT_MS - 5_000);
        await typeNote('Slow words');
        await tap('Refresh');
        await untilReally('the note text save to go out', () => bodySaves.length === 1);
        await act(async () => { await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS - 1_000); });
        // Exactly this test's one save, landed when its gate opened.
        expect(bodySaves).toHaveLength(1);
        expect(lists[0].content_rev).toBe(2);
        expect(toasts).toEqual([]);
        // The bound runs out at SAVE_WAIT_MS from the tap, not SAVE_WAIT_MS
        // after the note's text landed.
        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
        vi.useRealTimers();
        await settle();
        expect(toasts).toEqual([STILL_SAVING]);
        expect(busy()).toBe(false);
    });

    it('a list restored from the trash while Refresh is out stays on the bar, and out of the trash', async () => {
        trash = [row(7, 'List 7', '2026-09-20T00:00:00Z')];
        await mount();
        await act(async () => { container.querySelector<HTMLButtonElement>('.tasks-trash-toggle')!.click(); });
        const trashReads = countReads('/task-lists?trashed=true');
        const answerLists = hold('GET /task-lists');
        const answerTrash = hold('GET trash');
        await tap('Refresh');
        await settle();
        expect(countReads('/task-lists?trashed=true')).toBe(trashReads + 1);

        await tapText('Restore');
        await settle();
        expect(tabTitles()).toContain('List 7');

        // Both answers were read with List 7 still in the trash.
        answerLists();
        answerTrash();
        await settle();
        expect(lists.map(l => l.id)).toContain(7);
        expect(tabTitles()).toContain('List 7');
        expect(container.querySelector('.tasks-trash-toggle')).toBeNull();
        expect(toasts).toEqual([]);
    });

    it('a list deleted forever while Refresh is out does not come back into the trash', async () => {
        trash = [row(7, 'List 7', '2026-09-20T00:00:00Z')];
        await mount();
        await act(async () => { container.querySelector<HTMLButtonElement>('.tasks-trash-toggle')!.click(); });
        const trashReads = countReads('/task-lists?trashed=true');
        const answerTrash = hold('GET trash');
        await tap('Refresh');
        await settle();
        expect(countReads('/task-lists?trashed=true')).toBe(trashReads + 1);

        await tapText('Delete forever');
        await settle();
        expect(gone.has(7)).toBe(true);
        expect(container.querySelector('.tasks-trash-toggle')).toBeNull();

        answerTrash();
        await settle();
        expect(container.querySelector('.tasks-trash-toggle')).toBeNull();
        expect(toasts).toEqual([]);
    });

    it('an item ticked on a board card while Refresh is out keeps its count', async () => {
        await createListTask(1, 'Milk');
        await createListTask(1, 'Eggs');
        await mount();
        expect(card('List 1')?.querySelector('.tasks-card-sub')?.textContent).toBe('0/2');
        const listReads = countReads('/task-lists');
        const answer = hold('GET /task-lists');
        await tap('Refresh');
        await settle();
        expect(countReads('/task-lists')).toBe(listReads + 1);

        await tap('Tick Milk', card('List 1')!);
        await settle();
        expect(card('List 1')?.querySelector('.tasks-card-sub')?.textContent).toBe('1/2');

        // The lists answer counted the items before the tick landed.
        answer();
        await settle();
        expect(card('List 1')?.querySelector('li[data-done="yes"] .text')?.textContent).toBe('Milk');
        expect(card('List 1')?.querySelector('.tasks-card-sub')?.textContent).toBe('1/2');
    });

    it('the open list, deleted for good on another device, is gone — and no connection is blamed', async () => {
        await mount();
        await openTab('List 1');
        lists = lists.filter(l => l.id !== 1);
        gone.add(1);
        const itemReads = countReads('/task-lists/1/tasks');
        await tap('Refresh');
        await settle();
        expect(countReads('/task-lists/1/tasks')).toBe(itemReads + 1);
        expect(container.textContent).toContain('That checklist is gone');
        expect(toasts).toEqual([]);
    });

    it('a board card for a list deleted for good on another device leaves the board — and no connection is blamed', async () => {
        await mount();
        expect(card('List 3')).toBeTruthy();
        lists = lists.filter(l => l.id !== 3);
        gone.add(3);
        const itemReads = countReads('/task-lists/3/tasks');
        await tap('Refresh');
        await settle();
        // The card's own read went out and met the 404.
        expect(countReads('/task-lists/3/tasks')).toBe(itemReads + 1);
        expect(card('List 3')).toBeNull();
        expect(toasts).toEqual([]);
    });

    it('on the Calendar tab a list deleted for good is not a failure — but a read that fails still is', async () => {
        await mount();
        await openTab('Calendar');
        expect(container.querySelector('.calendar-stand-in')).toBeTruthy();
        lists = lists.filter(l => l.id !== 3);
        gone.add(3);
        const scopeReads = countReads('/task-lists/3/tasks');
        await tap('Refresh');
        await settle();
        expect(countReads('/task-lists/3/tasks')).toBe(scopeReads + 1);
        expect(toasts).toEqual([]);

        // The counterpart: a scope that really cannot be read is reported.
        failing.add('GET /task-lists/1/tasks');
        await tap('Refresh');
        await settle();
        expect(toasts).toEqual([FAILED]);
    });
});
