/**
 * Púca's Tasks view: a note's own reminder belongs to the list it was opened
 * on, and to no other.
 *
 * NoteReminderControl holds the open editor and its typed draft in its own
 * state. It is mounted at a fixed place in the .tasks-editor subtree, so
 * without a key React KEEPS that state when the selected list changes and
 * "Set" then writes the time drafted for list A onto list B — a silent wrong
 * write, dressed up by the optimistic patch as though it were meant. The
 * same holds for the title editor beside it, which would rename B with A's
 * draft.
 *
 * Both blocks below therefore switch tabs mid-edit and assert about the
 * OTHER list, with a positive control in the same test proving the very
 * same keystrokes do land when the list has not changed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, patch, del, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, post, patch, delete: del, put } };
});
// Not under test, and they pull in far more than the editor header.
vi.mock('../components/ChecklistBody', () => ({ ChecklistBody: () => null }));
vi.mock('../components/TaskTree', () => ({ TaskTree: () => null }));
vi.mock('../hooks/useDragReorder', () => ({
    useDragReorder: () => ({ state: { dragging: null, indicator: null, crossSteps: 0, order: [], insertAt: 0 }, setContainer: () => {}, onPointerDown: () => {} }),
}));
// A rename seals the new title, which needs an unlocked identity this test
// has no use for: WHICH list it names is the whole question here.
const rename = vi.hoisted(() => vi.fn());
vi.mock('../api/tasks', async () => {
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return { ...real, renameTaskList: rename };
});

import { setMessageToastSink } from '../components/messageToastBus';
import { TasksView } from '../components/TasksView';

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

const row = (id: number) => ({
    id, title: `List ${id}`, created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
    body: null, attachments: null, trashed_at: null, due_at: null, schedule: null, is_self: false,
});

function installServer() {
    get.mockImplementation(async (path: string) => {
        // note_reminders on: migration 068 is what mounts the control at all.
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, note_reminders: true };
        if (path === '/task-lists?trashed=true') return [];
        if (path === '/task-lists') return [row(1), row(2)];
        if (path === '/task-tab-prefs') return [];
        if (path === '/servers') return [];
        if (/^\/task-lists\/\d+\/tasks$/.test(path)) return [];
        throw new Error(`unexpected GET ${path}`);
    });
    put.mockResolvedValue({});
    patch.mockResolvedValue({});
}

let root: Root;
let container: HTMLDivElement;

async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><TasksView /></QueryClientProvider>); });
    await settle();
}

/** Click the tab for `List <id>` and wait for the editor to follow. */
async function selectList(id: number) {
    const tab = [...container.querySelectorAll<HTMLElement>('.tasks-tab')].find(t => t.textContent?.includes(`List ${id}`));
    expect(tab, `the tab for list ${id} is rendered`).toBeTruthy();
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

const timingWrites = () => patch.mock.calls
    .filter(c => /^\/task-lists\/\d+$/.test(c[0] as string))
    .map(c => [c[0] as string, (c[1] as Record<string, unknown>).due_at]);

beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    rename.mockReset(); rename.mockResolvedValue(undefined);
    // The editor body asks for the pointer; jsdom has no matchMedia. A fine
    // pointer is the desktop reading of the same header either way.
    window.matchMedia = ((q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
        addListener() { /* noop */ }, removeListener() { /* noop */ }, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    setMessageToastSink(() => {});
    installServer();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    setMessageToastSink(null);
    delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('a note reminder set in Púca belongs to the list it was opened on', () => {
    it('a draft typed on one list does not follow the tab to the next one', async () => {
        await mount();
        await selectList(1);

        const clock = container.querySelector<HTMLButtonElement>('.tasks-editor .tasks-editor-iconbtn');
        expect(clock, 'list 1 offers its own reminder clock').toBeTruthy();
        await act(async () => { clock!.click(); });
        const input = container.querySelector<HTMLInputElement>('.note-due-edit input');
        expect(input, 'the reminder editor opened on list 1').toBeTruthy();
        typeInto(input!, '2026-12-24T09:00');

        // Now change tab WITHOUT committing. The editor belongs to list 1.
        await selectList(2);
        // If it DID survive the change of tab, committing it is what does the
        // damage, so press Set when it is there rather than only asserting it
        // is not: the failure then reads as the wrong write it really is.
        const stale = [...container.querySelectorAll<HTMLButtonElement>('.note-due-edit button')].find(b => b.textContent === 'Set');
        if (stale) await act(async () => { stale.click(); });
        await settle();
        expect(timingWrites(), 'list 2 was not given the time drafted for list 1').toEqual([]);
        expect(container.querySelector('.note-due-edit'), 'the open editor did not follow the tab').toBeNull();

        // POSITIVE CONTROL: the same keystrokes, with the tab left alone,
        // really do save — so the assertions above are not about a control
        // that never writes at all.
        const clock2 = container.querySelector<HTMLButtonElement>('.tasks-editor .tasks-editor-iconbtn');
        await act(async () => { clock2!.click(); });
        const input2 = container.querySelector<HTMLInputElement>('.note-due-edit input');
        expect(input2).toBeTruthy();
        typeInto(input2!, '2026-12-24T09:00');
        const set = [...container.querySelectorAll<HTMLButtonElement>('.note-due-edit button')].find(b => b.textContent === 'Set');
        expect(set).toBeTruthy();
        await act(async () => { set!.click(); });
        await settle();
        const writes = timingWrites();
        expect(writes).toHaveLength(1);
        expect(writes[0][0], 'the reminder went to the list that was open').toBe('/task-lists/2');
        expect(String(writes[0][1])).toContain('2026-12-24');
    });

    it('a title typed on one list does not rename the next one', async () => {
        await mount();
        await selectList(1);
        const title = container.querySelector<HTMLElement>('.tasks-editor-title');
        expect(title, 'list 1 shows its title').toBeTruthy();
        await act(async () => { title!.click(); });
        const input = container.querySelector<HTMLInputElement>('.tasks-title-input');
        expect(input, 'the title editor opened').toBeTruthy();
        typeInto(input!, 'Groceries');

        await selectList(2);
        // As above: commit the stale editor if it survived, so a failure
        // names the rename it would really have done.
        const staleTitle = container.querySelector<HTMLInputElement>('.tasks-title-input');
        if (staleTitle) await act(async () => { staleTitle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        await settle();
        expect(rename.mock.calls, 'list 2 was not renamed with list 1’s draft').toEqual([]);
        expect(container.querySelector('.tasks-title-input'), 'the title editor did not follow the tab').toBeNull();
        // The rendered title is still list 2's own.
        expect(container.querySelector('.tasks-editor-title')!.textContent).toBe('List 2');

        // POSITIVE CONTROL: renaming the list that IS open still works.
        const title2 = container.querySelector<HTMLElement>('.tasks-editor-title');
        await act(async () => { title2!.click(); });
        const input2 = container.querySelector<HTMLInputElement>('.tasks-title-input');
        typeInto(input2!, 'Groceries');
        await act(async () => { input2!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        await settle();
        expect(rename.mock.calls).toEqual([[2, 'Groceries']]);
    });
});
