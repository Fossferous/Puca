/**
 * A step-by-step checklist pasted into Púca's OWN Tasks view — "Add a task…"
 * and the "New list" name — becomes clean items, in order, after the same
 * one question Púca Notes asks (components/usePasteItems).
 *
 * The owner's ask: an assistant's answer ("Here's how:", "# Title", numbered
 * steps, **bold**, a closing line) pasted anywhere should become the
 * checklist, not forty lines of Markdown — and nothing may be created until
 * the person answers, because a delete here has no Undo.
 *
 * Also pinned, because a batch is what exposed them: the add handler used to
 * build `[...tasks, created]` from its closure, so N creates in a row showed
 * only the LAST one, and a refused create was swallowed without a word.
 *
 * The server is a small stateful fake behind a mocked apiClient: what is
 * POSTed is sealed for real and read back through the real decrypt, so the
 * rows on screen are what the view would show after a reload.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, patch, del, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, post, patch, delete: del, put } };
});
// Not under test, and between them they pull in half the app. The rows are
// reduced to their text, in the order the view holds them.
vi.mock('../components/ChecklistBody', () => ({ ChecklistBody: () => null }));
vi.mock('../components/TaskTree', () => ({
    TaskTree: ({ tasks, onToggle, onDelete }: {
        tasks: Array<{ id: number; description: string }>;
        onToggle: (t: unknown, done: boolean) => void;
        onDelete: (id: number) => void;
    }) => (
        <ul className="rows">{tasks.map(t => (
            <li key={t.id}>
                {t.description}
                <button type="button" aria-label={`Tick ${t.description}`} onClick={() => onToggle(t, true)} />
                <button type="button" aria-label={`Delete ${t.description}`} onClick={() => onDelete(t.id)} />
            </li>
        ))}</ul>
    ),
}));
vi.mock('../components/calendar/TasksCalendar', () => ({ TasksCalendar: () => null }));

import { ApiError } from '../api/client';
import { TasksView } from '../components/TasksView';
import { OP_KEY_SHAPE } from '../api/opKey';
import { PACE_MS } from '../api/icsImport';
import { setActiveIdentity } from '../api/e2ee';
import { setMessageToastSink } from '../components/messageToastBus';
import { MAX_TAKEN_ITEMS } from '../notes/model/noteContent';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';
import { ASSISTANT_ANSWER, ASSISTANT_ITEMS, ASSISTANT_TITLE } from './fixtures/assistantChecklist';

const ME = ['paste-checklist-pw', 'ab'.repeat(16)] as const;

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};
/** Real time: the creates are PACED, so N items take N-1 pauses. Waited out
 *  in short act() slices, not one long one: an act() holds back effects until
 *  it ends, and the view's own effects (the list it opens, the one it reads)
 *  must run WHILE the items land, as they do in the app. */
const paced = async (n: number) => {
    for (let t = 0; t < PACE_MS * n + 100; t += 10) {
        await act(async () => { await new Promise(r => { setTimeout(r, 10); }); });
    }
    await settle();
};

const row = (id: number, title: string) => ({
    id, title, created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
    body: null, attachments: null, trashed_at: null, is_self: false,
});

/** The fake server's items, by list, as the wire holds them (sealed). */
let stored: Map<number, Array<Record<string, unknown>>>;
let nextId: number;
/** Refuse the create of the item at this 0-based position among item POSTs. */
let refuseAt: number | null;
/** Lists whose FIRST read answers late, with what the server held when it
 *  was asked — a new list's editor opens before its items exist. */
let slowFirstRead: Set<number>;
/** Lists whose next read is held until the test lets it answer. */
let heldReads: Map<number, Promise<void>>;
let toasts: string[];

let root: Root;
let container: HTMLDivElement;

beforeAll(async () => {
    await warmIdentities([ME]);
    setActiveIdentity(await testIdentity(...ME));
}, WARM_TIMEOUT_MS);

beforeEach(() => {
    if (!window.matchMedia) {
        window.matchMedia = ((q: string) => ({
            matches: false, media: q, onchange: null,
            addEventListener: () => {}, removeEventListener: () => {},
            addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
    stored = new Map([[1, []], [3, []]]);
    nextId = 100;
    refuseAt = null;
    slowFirstRead = new Set();
    heldReads = new Map();
    toasts = [];
    setMessageToastSink(t => { toasts.push(t.title); });
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, content_rev: true, idempotent_creates: true };
        if (path === '/task-lists?trashed=true') return [];
        if (path === '/task-lists') return [row(1, 'List 1'), row(3, 'List 3')];
        if (path === '/task-tab-prefs') return [];
        if (path === '/servers') return [];
        const m = /^\/task-lists\/(\d+)\/tasks$/.exec(path);
        if (m) {
            const id = Number(m[1]);
            const snapshot = [...(stored.get(id) ?? [])];
            if (slowFirstRead.delete(id)) await new Promise(r => { setTimeout(r, PACE_MS * 3); });
            const held = heldReads.get(id);
            if (held) { heldReads.delete(id); await held; }
            return snapshot;
        }
        throw new Error(`unexpected GET ${path}`);
    });
    let itemPosts = 0;
    post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
        if (path === '/task-lists') {
            const id = nextId++;
            stored.set(id, []);
            return { ...row(id, String(body.title)), content_rev: 1 };
        }
        const m = /^\/task-lists\/(\d+)\/tasks$/.exec(path);
        if (m) {
            if (refuseAt !== null && itemPosts++ === refuseAt) throw new ApiError('gateway', 502);
            const list = stored.get(Number(m[1]))!;
            const t = { id: nextId++, list_id: Number(m[1]), channel_id: null, parent_id: body.parent_id ?? null, description: body.description, is_completed: false, created_at: '2026-09-01T00:00:00Z', created_by: 1, position: list.length + 1, attachments: null, due_at: null };
            list.push(t);
            return t;
        }
        throw new Error(`unexpected POST ${path}`);
    });
    del.mockImplementation(async (path: string) => {
        const m = /^\/tasks\/(\d+)$/.exec(path);
        if (!m) throw new Error(`unexpected DELETE ${path}`);
        for (const items of stored.values()) {
            const at = items.findIndex(t => t.id === Number(m[1]));
            if (at >= 0) items.splice(at, 1);
        }
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

function typeInto(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** A paste, as the browser delivers it: a real event carrying the text. */
function paste(el: Element, text: string) {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { files: [], items: [], types: ['text/plain'], getData: () => text } });
    act(() => { el.dispatchEvent(ev); });
    return ev;
}

/** Enter in a field: its form's submit, which is what the key does. */
async function submit(selector: string) {
    const form = container.querySelector(selector) as HTMLFormElement;
    expect(form, selector).not.toBeNull();
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
}
/** Real time in short act() slices, as `paced` waits. */
const wait = async (ms: number) => {
    for (let t = 0; t < ms; t += 10) await act(async () => { await new Promise(r => { setTimeout(r, 10); }); });
};

const addInput = () => container.querySelector<HTMLInputElement>('.tasks-add input')!;
const rows = () => [...container.querySelectorAll('.rows li')].map(l => l.textContent);
const dialog = () => document.querySelector('.notes-paste-dialog');
const dialogLines = () => [...document.querySelectorAll('.notes-paste-line')].map(l => l.textContent);
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.notes-paste-actions button')]
    .find(b => b.textContent === text)!;
const itemPosts = (listId?: number) => post.mock.calls.filter(c => (listId === undefined ? /^\/task-lists\/\d+\/tasks$/ : new RegExp(`^/task-lists/${listId}/tasks$`)).test(c[0] as string));
const tabCount = (label: string) => [...container.querySelectorAll('.tasks-tab')].find(b => b.textContent?.includes(label))?.querySelector('.tasks-tab-count')?.textContent;

describe('"Add a task…" takes a pasted checklist', () => {
    it("an assistant's answer asks first, then lands as its clean steps, in order, each with its own key", async () => {
        await mount();
        await openList('List 1');
        const ev = paste(addInput(), ASSISTANT_ANSWER);
        expect(ev.defaultPrevented).toBe(true);
        expect(dialogLines()).toEqual(ASSISTANT_ITEMS);
        expect(itemPosts()).toHaveLength(0);                 // nothing before the answer

        act(() => { button(`Add ${ASSISTANT_ITEMS.length} items`).click(); });
        await paced(ASSISTANT_ITEMS.length);

        // EVERY item on screen, in order — a closure's `[...tasks, created]`
        // showed only the last.
        expect(rows()).toEqual(ASSISTANT_ITEMS);
        const posts = itemPosts(1);
        expect(posts).toHaveLength(ASSISTANT_ITEMS.length);
        const keys = posts.map(c => (c[1] as Record<string, unknown>).op_key as string);
        for (const k of keys) expect(k).toMatch(OP_KEY_SHAPE);
        expect(new Set(keys).size).toBe(keys.length);        // one intent each
        expect(tabCount('List 1')).toBe(`0/${ASSISTANT_ITEMS.length}`);
        // The text is sealed on the wire, never beside the key.
        expect(JSON.stringify(post.mock.calls)).not.toContain('Unplug');
        expect(toasts).toEqual([]);
    });

    it('Cancel creates nothing; "Add as one item" only fills the box', async () => {
        await mount();
        await openList('List 1');
        paste(addInput(), ASSISTANT_ANSWER);
        act(() => { button('Cancel').click(); });
        expect(dialog()).toBeNull();
        paste(addInput(), 'Milk\nBread\nEggs');
        act(() => { button('Add as one item').click(); });
        await settle();
        expect(itemPosts()).toHaveLength(0);
        expect(addInput().value).toBe('Milk Bread Eggs');
    });

    it('a ONE-line paste is the browser’s: no dialog, not intercepted', async () => {
        await mount();
        await openList('List 1');
        const ev = paste(addInput(), 'Milk');
        expect(ev.defaultPrevented).toBe(false);
        expect(dialog()).toBeNull();
        // POSITIVE CONTROL: two lines in the same field do ask.
        const two = paste(addInput(), 'Milk\nBread');
        expect(two.defaultPrevented).toBe(true);
        expect(dialog()).not.toBeNull();
    });

    it('stops at the first refusal, and says how many landed and why', async () => {
        await mount();
        await openList('List 1');
        refuseAt = 2;
        paste(addInput(), ASSISTANT_ANSWER);
        act(() => { button(`Add ${ASSISTANT_ITEMS.length} items`).click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(itemPosts(1)).toHaveLength(3);                // the third was tried, refused, and nothing after it
        expect(rows()).toEqual(ASSISTANT_ITEMS.slice(0, 2));
        expect(toasts).toContain(`Added 2 of ${ASSISTANT_ITEMS.length} items`);
        expect(toasts).toContain('Couldn’t add the task — check your connection');
    });

    it('the items go to the list the paste was for, even if the person moves on while they land', async () => {
        await mount();
        await openList('List 1');
        paste(addInput(), ASSISTANT_ANSWER);
        act(() => { button(`Add ${ASSISTANT_ITEMS.length} items`).click(); });
        await openList('List 3');
        await paced(ASSISTANT_ITEMS.length);
        expect(itemPosts(1)).toHaveLength(ASSISTANT_ITEMS.length);
        expect(itemPosts(3)).toHaveLength(0);
        expect(rows()).toEqual([]);                          // List 3 shows none of them
        expect(tabCount('List 1')).toBe(`0/${ASSISTANT_ITEMS.length}`);
        await openList('List 1');
        expect(rows()).toEqual(ASSISTANT_ITEMS);
    });

    it('every pasted row stays on screen when the list is read again while they land', async () => {
        await mount();
        await openList('List 1');
        const lines = Array.from({ length: 12 }, (_, i) => `step ${i + 1}`);
        paste(addInput(), lines.join('\n'));
        act(() => { button(`Add ${lines.length} items`).click(); });
        await wait(PACE_MS * 3);
        await openList('List 3');
        // Back to List 1, whose read answers late while its items keep
        // landing: the read's answer is older than the rows already shown.
        slowFirstRead.add(1);
        await openList('List 1');
        await paced(lines.length);
        expect(stored.get(1)).toHaveLength(lines.length);
        expect(rows()).toEqual(lines);
        expect(tabCount('List 1')).toBe(`0/${lines.length}`);
    });

    it('every pasted row stays when a refused tick makes the list read again while they land', async () => {
        await mount();
        await openList('List 1');
        patch.mockRejectedValue(new ApiError('Changed on another device', 409));
        const lines = Array.from({ length: 12 }, (_, i) => `step ${i + 1}`);
        paste(addInput(), lines.join('\n'));
        act(() => { button(`Add ${lines.length} items`).click(); });
        await wait(PACE_MS * 3);
        // Refused as out of date: the list is read again (rereadList), and
        // that read answers late while the rest land.
        slowFirstRead.add(1);
        act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Tick step 1"]')!.click(); });
        await paced(lines.length);
        expect(toasts).toContain('Changed on another device');
        expect(stored.get(1)).toHaveLength(lines.length);
        expect(rows()).toEqual(lines);
    });

    it('an item deleted just after it landed does not come back with a read that was out', async () => {
        await mount();
        await openList('List 1');
        await openList('List 3');
        let answer!: () => void;
        heldReads.set(1, new Promise<void>(r => { answer = r; }));
        await openList('List 1');                          // its read is out until answer()
        typeInto(addInput(), 'Milk');
        await submit('.tasks-add');
        expect(rows()).toEqual(['Milk']);
        act(() => { container.querySelector<HTMLButtonElement>('[aria-label="Delete Milk"]')!.click(); });
        await settle();
        expect(stored.get(1)).toEqual([]);
        expect(heldReads.size, 'the read went out and is still held').toBe(0);
        await act(async () => { answer(); });
        await settle();
        expect(rows()).toEqual([]);
    });

    it('the question takes the focus, so Enter adds nothing behind it; any answer gives the focus back', async () => {
        await mount();
        await openList('List 1');
        typeInto(addInput(), 'Milk');
        addInput().focus();
        paste(addInput(), ASSISTANT_ANSWER);
        expect(document.activeElement?.closest('.notes-paste-dialog'), 'focus in the question').not.toBeNull();
        // Enter in the field, were it still there: nothing is added behind it.
        await submit('.tasks-add');
        expect(itemPosts()).toHaveLength(0);
        expect(dialog()).not.toBeNull();
        act(() => { button('Cancel').click(); });
        expect(document.activeElement).toBe(addInput());
        // POSITIVE CONTROL: with the question answered, Enter adds again.
        await submit('.tasks-add');
        expect(itemPosts(1)).toHaveLength(1);
    });

    it('a typed item that is refused is SAID, and its words stay for the retry', async () => {
        await mount();
        await openList('List 1');
        refuseAt = 0;
        typeInto(addInput(), 'Milk');
        const form = container.querySelector('.tasks-add') as HTMLFormElement;
        await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await settle();
        expect(toasts).toEqual(['Couldn’t add the task — check your connection']);
        expect(addInput().value).toBe('Milk');
    });

    it(`a paste of more than ${MAX_TAKEN_ITEMS} lines creates the first ${MAX_TAKEN_ITEMS}, and the prompt says so`, async () => {
        await mount();
        await openList('List 1');
        paste(addInput(), Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n'));
        expect(document.body.textContent).toContain('You pasted 250 lines');
        expect(document.body.textContent).toContain(`Only the first ${MAX_TAKEN_ITEMS} are added`);
        // The pauses are skipped, not the work: each create still seals for
        // real, which settles on the event loop (setImmediate is left real).
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        act(() => { button(`Add ${MAX_TAKEN_ITEMS} items`).click(); });
        for (let i = 0; i < 20 * MAX_TAKEN_ITEMS && itemPosts(1).length < MAX_TAKEN_ITEMS; i++) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(PACE_MS);
                await new Promise(r => setImmediate(r));
            });
        }
        // One pause more: a 201st create, were there one, would go out now.
        await act(async () => { await vi.advanceTimersByTimeAsync(PACE_MS * 3); });
        vi.useRealTimers();
        await settle();
        expect(itemPosts(1)).toHaveLength(MAX_TAKEN_ITEMS);
        expect(rows().at(-1)).toBe(`line ${MAX_TAKEN_ITEMS}`);
    }, 30_000);
});

describe('the "New list" name takes a pasted checklist', () => {
    async function openNewList() {
        await act(async () => { (container.querySelector('[aria-label="New list"]') as HTMLButtonElement).click(); });
        return container.querySelector<HTMLInputElement>('.tasks-tab-newform input')!;
    }

    it('makes the list, named after the checklist, then its steps in order — all of them on screen', async () => {
        await mount();
        const name = await openNewList();
        const ev = paste(name, ASSISTANT_ANSWER);
        expect(ev.defaultPrevented).toBe(true);
        expect(post).not.toHaveBeenCalled();                  // asked first
        // The editor opens on the new list at once, and its first read of
        // the (still empty) list answers while the steps are landing.
        slowFirstRead.add(100);
        act(() => { button(`Add ${ASSISTANT_ITEMS.length} items`).click(); });
        await paced(ASSISTANT_ITEMS.length);
        const lists = post.mock.calls.filter(c => c[0] === '/task-lists');
        expect(lists).toHaveLength(1);
        expect(container.querySelector('.tasks-editor-title')?.textContent).toBe(ASSISTANT_TITLE);
        expect(itemPosts(100)).toHaveLength(ASSISTANT_ITEMS.length);
        expect(rows()).toEqual(ASSISTANT_ITEMS);
        expect(container.querySelector('.tasks-tab-newform')).toBeNull();
    });

    it('what was typed there names it instead', async () => {
        await mount();
        const name = await openNewList();
        typeInto(name, 'Saturday');
        paste(name, ASSISTANT_ANSWER);
        act(() => { button(`Add ${ASSISTANT_ITEMS.length} items`).click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(container.querySelector('.tasks-editor-title')?.textContent).toBe('Saturday');
        expect(rows()).toEqual(ASSISTANT_ITEMS);
    });

    it('"Add as one item" makes the list with the whole checklist as its one item', async () => {
        await mount();
        const name = await openNewList();
        paste(name, ASSISTANT_ANSWER);
        act(() => { button('Add as one item').click(); });
        await paced(1);
        expect(container.querySelector('.tasks-editor-title')?.textContent).toBe(ASSISTANT_TITLE);
        expect(itemPosts(100)).toHaveLength(1);
        expect(rows()).toEqual([ASSISTANT_ITEMS.join(' ')]);
    });

    it('the question says it makes a list, and what the list is called', async () => {
        await mount();
        const name = await openNewList();
        paste(name, ASSISTANT_ANSWER);
        expect(dialog()?.textContent).toContain(`This makes a new list, “${ASSISTANT_TITLE}”.`);
        act(() => { button('Cancel').click(); });
        typeInto(name, 'Saturday');
        paste(name, ASSISTANT_ANSWER);
        expect(dialog()?.textContent).toContain('This makes a new list, “Saturday”.');
        act(() => { button('Add as one item').click(); });
        await paced(1);
        // The name it said, for either answer.
        expect(container.querySelector('.tasks-editor-title')?.textContent).toBe('Saturday');
        // With no heading and nothing typed, the first step names it — for
        // "Add as one item" too, not the whole paste run together.
        const again = await openNewList();
        paste(again, '- Milk\n- Bread\n- Eggs');
        expect(dialog()?.textContent).toContain('This makes a new list, “Milk”.');
        act(() => { button('Add as one item').click(); });
        await paced(1);
        expect(container.querySelector('.tasks-editor-title')?.textContent).toBe('Milk');
        expect(rows()).toEqual(['Milk Bread Eggs']);
        // POSITIVE CONTROL: a paste into a list that exists makes no list, and says none.
        paste(addInput(), ASSISTANT_ANSWER);
        expect(dialog()).not.toBeNull();
        expect(dialog()?.textContent).not.toContain('new list');
    });

    it('Enter in the name while the question is open makes no second list', async () => {
        await mount();
        const name = await openNewList();
        typeInto(name, 'Saturday');
        paste(name, ASSISTANT_ANSWER);
        await submit('.tasks-tab-newform');
        expect(post.mock.calls.filter(c => c[0] === '/task-lists')).toHaveLength(0);
        expect(dialog()).not.toBeNull();
        act(() => { button(`Add ${ASSISTANT_ITEMS.length} items`).click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(post.mock.calls.filter(c => c[0] === '/task-lists')).toHaveLength(1);
        expect(rows()).toEqual(ASSISTANT_ITEMS);
    });

    it('an empty name stays open under the question, and Cancel gives it the focus back', async () => {
        await mount();
        const name = await openNewList();
        expect(document.activeElement).toBe(name);
        paste(name, ASSISTANT_ANSWER);
        // A tap on Cancel takes the focus before its click, as a real one does.
        act(() => { button('Cancel').focus(); });
        act(() => { button('Cancel').click(); });
        const still = container.querySelector<HTMLInputElement>('.tasks-tab-newform input');
        expect(still, 'the New list name is still open').not.toBeNull();
        expect(document.activeElement).toBe(still);
        // POSITIVE CONTROL: leaving it empty with no question open still closes it.
        act(() => { still!.blur(); });
        expect(container.querySelector('.tasks-tab-newform')).toBeNull();
    });

    it('Cancel makes no list; text that is not a checklist pastes as a name', async () => {
        await mount();
        const name = await openNewList();
        paste(name, ASSISTANT_ANSWER);
        act(() => { button('Cancel').click(); });
        await settle();
        expect(post).not.toHaveBeenCalled();
        // POSITIVE CONTROL: plain lines are not a checklist, so no question.
        const plain = paste((await openNewList()), 'Milk\nBread');
        expect(plain.defaultPrevented).toBe(false);
        expect(dialog()).toBeNull();
    });
});
