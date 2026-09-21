/**
 * Púca's OWN Tasks view mints a create key, and holds it across a retry.
 *
 * The offline outbox stores its key on the queued op and the .ics import
 * mints one outside `withRetry`, so both were covered. These forms have
 * neither: nothing retries for them. What they have is the user — a create
 * that fails leaves the typed words in the box and they press the button
 * again. Until this, that second press went out with no key at all, so a
 * create the server had COMMITTED but could not answer became two rows, on
 * the one surface where the user is most likely to try again straight away.
 *
 * What is pinned here is the whole rule, not just "a key is sent": the SAME
 * key on the retry of one intent, a DIFFERENT one once that create lands or
 * the user types something else. A test that only looked for `op_key` would
 * pass just as happily on a key minted fresh per request, which is the bug.
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
// Not under test, and between them they pull in half the app.
vi.mock('../components/ChecklistBody', () => ({ ChecklistBody: () => null }));
vi.mock('../components/TaskTree', () => ({ TaskTree: () => null }));
vi.mock('../components/calendar/TasksCalendar', () => ({ TasksCalendar: () => null }));

import { ApiError } from '../api/client';
import { TasksView } from '../components/TasksView';
import { OP_KEY_SHAPE } from '../api/opKey';
import { setActiveIdentity } from '../api/e2ee';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const ME = ['create-keys-pw', 'cd'.repeat(16)] as const;

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

const row = (id: number, title: string) => ({
    id, title, created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
    body: null, attachments: null, trashed_at: null, is_self: false,
});

let root: Root;
let container: HTMLDivElement;

beforeAll(async () => {
    await warmIdentities([ME]);
    setActiveIdentity(await testIdentity(...ME));
}, WARM_TIMEOUT_MS);

beforeEach(() => {
    // jsdom has no matchMedia, and the selected list's content block asks it
    // whether the pointer is coarse.
    if (!window.matchMedia) {
        window.matchMedia = ((q: string) => ({
            matches: false, media: q, onchange: null,
            addEventListener: () => {}, removeEventListener: () => {},
            addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, content_rev: true, idempotent_creates: true };
        if (path === '/task-lists?trashed=true') return [];
        if (path === '/task-lists') return [row(1, 'List 1')];
        if (path === '/task-tab-prefs') return [];
        if (path === '/servers') return [];
        if (/^\/task-lists\/\d+\/tasks$/.test(path)) return [];
        throw new Error(`unexpected GET ${path}`);
    });
    put.mockResolvedValue({});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
});

async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><TasksView /></QueryClientProvider>); });
    await settle();
}

function typeInto(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** Open the "new list" form, type `title`, submit it. */
async function addList(title: string) {
    const open = container.querySelector('[aria-label="New list"]') as HTMLButtonElement | null;
    if (open) await act(async () => { open.click(); });
    const form = container.querySelector('.tasks-tab-newform') as HTMLFormElement;
    expect(form, 'the new-list form is open').toBeTruthy();
    typeInto(form.querySelector('input') as HTMLInputElement, title);
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
}

/** Type `text` into the selected list's add-task form and submit it. */
async function addTask(text: string) {
    const form = container.querySelector('.tasks-add') as HTMLFormElement;
    expect(form, 'the add-task form is on screen').toBeTruthy();
    typeInto(form.querySelector('input') as HTMLInputElement, text);
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
}

const keysPostedTo = (path: string | RegExp) =>
    post.mock.calls
        .filter(c => (typeof path === 'string' ? c[0] === path : path.test(c[0] as string)))
        .map(c => (c[1] as Record<string, unknown>).op_key as string | undefined);

describe('a create the user retries by hand carries the SAME key', () => {
    it('a new list: the retry replays the first attempt, and the next list is a new intent', async () => {
        await mount();
        // The server commits it and the answer is lost.
        post.mockRejectedValueOnce(new ApiError('gateway', 502));
        await addList('Shopping');
        // The words are still in the box; the user presses the button again.
        post.mockResolvedValueOnce({ ...row(2, ''), content_rev: 1 });
        await addList('Shopping');

        const keys = keysPostedTo('/task-lists');
        expect(keys.length).toBe(2);
        expect(keys[0]).toMatch(OP_KEY_SHAPE);
        expect(keys[1]).toBe(keys[0]);   // the same intent, so the same key

        // POSITIVE CONTROL: a different list is a different intent, and the
        // one that landed is not replayed onto it.
        post.mockResolvedValueOnce({ ...row(3, ''), content_rev: 1 });
        await addList('Hardware');
        const after = keysPostedTo('/task-lists');
        expect(after.length).toBe(3);
        expect(after[2]).toMatch(OP_KEY_SHAPE);
        expect(after[2]).not.toBe(keys[0]);
    });

    it('an item: same again, and the key is never a fingerprint of the text', async () => {
        await mount();
        post.mockResolvedValueOnce({ ...row(2, ''), content_rev: 1 });
        await addList('Shopping');

        post.mockRejectedValueOnce(new ApiError('gateway', 502));
        await addTask('Milk');
        post.mockResolvedValueOnce({ id: 11, description: 'x', is_completed: false, created_at: '', created_by: 1, position: 1 });
        await addTask('Milk');

        const keys = keysPostedTo(/^\/task-lists\/\d+\/tasks$/);
        expect(keys.length).toBe(2);
        expect(keys[0]).toMatch(OP_KEY_SHAPE);
        expect(keys[1]).toBe(keys[0]);

        // Once it lands, the SAME words typed again are a new item, not a
        // replay of the one that is already there.
        post.mockResolvedValueOnce({ id: 12, description: 'x', is_completed: false, created_at: '', created_by: 1, position: 2 });
        await addTask('Milk');
        const after = keysPostedTo(/^\/task-lists\/\d+\/tasks$/);
        expect(after.length).toBe(3);
        expect(after[2]).not.toBe(keys[0]);

        // And nothing the user typed rides along in the key or beside it.
        expect(JSON.stringify(post.mock.calls)).not.toContain('Milk');
        expect(JSON.stringify(post.mock.calls)).not.toContain('Shopping');
    });
});
