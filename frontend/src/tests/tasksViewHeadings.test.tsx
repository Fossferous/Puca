/**
 * Checklist HEADINGS in Púca's own Tasks view, with the real row renderer
 * (TaskTree) and a small fake server behind a mocked apiClient: what is
 * POSTed is sealed for real and read back through the real decrypt.
 *
 * The count a list's tab shows ("0/2") is the server's until the list is
 * read — and the server cannot tell a heading from an item (task text is
 * sealed), so its total counts headings. Once the list is open, the tab's
 * count is the view's own, which does not.
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
vi.mock('../components/ChecklistBody', () => ({ ChecklistBody: () => null }));
vi.mock('../components/calendar/TasksCalendar', () => ({ TasksCalendar: () => null }));

import { TasksView } from '../components/TasksView';
import { setActiveIdentity } from '../api/e2ee';
import { setMessageToastSink } from '../components/messageToastBus';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const ME = ['tasks-headings-pw', 'cd'.repeat(16)] as const;

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};
const row = (id: number, title: string, total: number) => ({
    id, title, created_at: '2026-09-01T00:00:00Z', total_tasks: total, completed_tasks: 0,
    body: null, attachments: null, trashed_at: null, is_self: false,
});
const item = (id: number, description: string) => ({
    id, list_id: 1, channel_id: null, parent_id: null, description, is_completed: false,
    created_at: '2026-09-01T00:00:00Z', created_by: 1, position: id, attachments: null, due_at: null,
});

let stored: Array<Record<string, unknown>>;
let nextId: number;
/** Hold the next lists read until the list's items have answered. */
let slowLists: boolean;
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
    // Held by the server as legacy plaintext (it reads back as is): what an
    // older client or this one put there does not matter to the rendering.
    stored = [item(10, '## Before you start'), item(11, 'Update the app'), item(12, 'Open each app')];
    nextId = 100;
    slowLists = false;
    setMessageToastSink(() => {});
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, content_rev: true, idempotent_creates: true };
        if (path === '/task-lists?trashed=true') return [];
        // The server's count: three rows, the heading among them.
        if (path === '/task-lists') {
            if (slowLists) await new Promise(r => { setTimeout(r, 80); });
            return [row(1, 'Test list', stored.length)];
        }
        if (path === '/task-tab-prefs') return [];
        if (path === '/servers') return [];
        if (path === '/task-lists/1/tasks') return [...stored];
        throw new Error(`unexpected GET ${path}`);
    });
    post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
        if (path === '/task-lists/1/tasks') {
            const t = { ...item(nextId++, String(body.description)), position: stored.length + 20 };
            stored.push(t);
            return t;
        }
        throw new Error(`unexpected POST ${path}`);
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
});

async function mountAndOpen() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><TasksView /></QueryClientProvider>); });
    await settle();
    const tab = [...container.querySelectorAll<HTMLButtonElement>('.tasks-tab')].find(b => b.textContent?.includes('Test list'));
    expect(tab, 'the list tab').toBeTruthy();
    await act(async () => { tab!.click(); });
    await settle();
    return tab!;
}
const rowOf = (text: string) => [...container.querySelectorAll('.task-tree li.tt-item')].find(l => l.querySelector('.tt-description')?.textContent === text) ?? null;
const tabCount = () => [...container.querySelectorAll('.tasks-tab')].find(b => b.textContent?.includes('Test list'))?.querySelector('.tasks-tab-count')?.textContent;

describe("Púca's Tasks view", () => {
    it('shows a heading as a heading, with no checkbox, among ticking items', async () => {
        await mountAndOpen();
        const heading = rowOf('Before you start');
        expect(heading?.classList.contains('tt-heading')).toBe(true);
        expect(heading?.querySelector('input[type="checkbox"]')).toBeNull();
        expect(rowOf('Update the app')?.querySelector('input[type="checkbox"]')).not.toBeNull();
    });

    it("the open list's tab counts steps, not the server's rows", async () => {
        await mountAndOpen();
        expect(tabCount()).toBe('0/2');
    });

    it("a Refresh whose lists answer lands AFTER the list's items still counts steps only", async () => {
        await mountAndOpen();
        expect(tabCount()).toBe('0/2');
        slowLists = true;
        const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;
        await act(async () => { refresh.click(); });
        for (let i = 0; i < 20; i++) await act(async () => { await new Promise(r => { setTimeout(r, 10); }); });
        await settle();
        expect(get.mock.calls.filter(c => c[0] === '/task-lists').length).toBeGreaterThanOrEqual(2);
        expect(tabCount()).toBe('0/2');
    });

    it('a heading added in "Add a task…" is no new step on the tab; an item is', async () => {
        await mountAndOpen();
        const input = container.querySelector<HTMLInputElement>('.tasks-add input')!;
        const add = async (text: string) => {
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await act(async () => { container.querySelector('form.tasks-add')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
            await settle();
        };
        await add('# Calendar');
        expect(rowOf('Calendar')?.classList.contains('tt-heading')).toBe(true);
        expect(tabCount()).toBe('0/2');
        await add('Snooze an item');
        expect(rowOf('Snooze an item')?.querySelector('input[type="checkbox"]')).not.toBeNull();
        expect(tabCount()).toBe('0/3');
    });
});

describe("an edit that changes what a row IS re-counts the tab", () => {
    beforeEach(() => {
        patch.mockResolvedValue({});
    });
    const click = async (row: Element | null, title: string) => {
        const b = [...(row?.querySelectorAll('button') ?? [])].find(x => x.getAttribute('title') === title);
        expect(b, title).toBeTruthy();
        await act(async () => { b!.click(); });
        await settle();
    };

    it('Turn into heading takes the row off the count', async () => {
        await mountAndOpen();
        expect(tabCount()).toBe('0/2');
        await click(rowOf('Update the app'), 'Turn into heading');
        expect(rowOf('Update the app')?.classList.contains('tt-heading')).toBe(true);
        expect(tabCount()).toBe('0/1');
    });

    it('Turn into item puts it on', async () => {
        await mountAndOpen();
        await click(rowOf('Before you start'), 'Turn into item');
        expect(rowOf('Before you start')?.querySelector('input[type="checkbox"]')).not.toBeNull();
        expect(tabCount()).toBe('0/3');
    });

    it('a refused edit puts the count back with the row', async () => {
        await mountAndOpen();
        patch.mockRejectedValueOnce(new Error('offline'));
        await click(rowOf('Update the app'), 'Turn into heading');
        expect(rowOf('Update the app')?.classList.contains('tt-heading')).toBe(false);
        expect(tabCount()).toBe('0/2');
    });

    it('POSITIVE CONTROL: an edit that keeps the row an item leaves the count', async () => {
        await mountAndOpen();
        await act(async () => { (rowOf('Update the app')?.querySelector('.tt-description') as HTMLElement).click(); });
        const input = container.querySelector<HTMLInputElement>('input.tt-edit-input')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Update the app today');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        await settle();
        expect(rowOf('Update the app today')).not.toBeNull();
        expect(tabCount()).toBe('0/2');
    });
});

describe('a list changed elsewhere since this view read it', () => {
    it('a Refresh does not take off headings the list may no longer have', async () => {
        // A second list to move to, so the first is NOT re-read by Refresh.
        const base = get.getMockImplementation()!;
        get.mockImplementation(async (path: string) => {
            if (path === '/task-lists') return [row(1, 'Test list', stored.length), row(2, 'Other', 0)];
            if (path === '/task-lists/2/tasks') return [];
            return base(path);
        });
        await mountAndOpen();
        expect(tabCount()).toBe('0/2');
        const other = [...container.querySelectorAll<HTMLButtonElement>('.tasks-tab')].find(b => b.textContent?.includes('Other'))!;
        await act(async () => { other.click(); });
        await settle();
        // Another device deletes the heading: two rows left, both steps.
        stored = stored.filter(t => t.id !== 10);
        await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click(); });
        for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => { setTimeout(r, 10); }); });
        await settle();
        expect(get.mock.calls.filter(c => c[0] === '/task-lists/1/tasks').length, 'list 1 was re-read, which is not this case').toBe(1);
        // The server's 2 rows, not 2 minus the heading this view once saw.
        expect(tabCount()).toBe('0/2');
    });

    it('POSITIVE CONTROL: what this view added itself is still counted right after that Refresh', async () => {
        const base = get.getMockImplementation()!;
        get.mockImplementation(async (path: string) => {
            if (path === '/task-lists') return [row(1, 'Test list', stored.length), row(2, 'Other', 0)];
            if (path === '/task-lists/2/tasks') return [];
            return base(path);
        });
        await mountAndOpen();
        const input = container.querySelector<HTMLInputElement>('.tasks-add input')!;
        for (const text of ['# Calendar', 'Snooze an item']) {
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await act(async () => { container.querySelector('form.tasks-add')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
            await settle();
        }
        expect(tabCount()).toBe('0/3');
        const other = [...container.querySelectorAll<HTMLButtonElement>('.tasks-tab')].find(b => b.textContent?.includes('Other'))!;
        await act(async () => { other.click(); });
        await settle();
        await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click(); });
        for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => { setTimeout(r, 10); }); });
        await settle();
        // Five rows on the server, two of them headings this view knows of.
        expect(stored.length).toBe(5);
        expect(tabCount()).toBe('0/3');
    });
});
