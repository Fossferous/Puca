/**
 * Where a clicked due-item notification actually lands — in the view itself,
 * mounted the way the app mounts it.
 *
 * <StrictMode> (main.tsx) deliberately double-invokes render in development,
 * and with it every useState initializer. MEASURED in this React (19.2): the
 * initializer does run twice and React keeps the FIRST value, so spending the
 * one-slot request inside it picked the right tab — but it made the
 * initializer impure, which is the very thing that double-invocation exists to
 * surface, and it would break outright if React ever kept the second. So the
 * initializer only PEEKS (api/tasksViewIntent.ts) and the mount effect spends
 * the slot; the request must not outlive that mount either, or an unrelated
 * later open of Tasks jumps to Reminders out of nowhere.
 *
 * The already-on-screen case is the window event — the one door both the web
 * notification click (api/desktopNotify.ts) and the Android intent branch in
 * Chat now use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, patch, del, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, post, patch, delete: del, put } };
});
// Not under test, and they pull in far more than a tab bar.
vi.mock('../components/ChecklistBody', () => ({ ChecklistBody: () => null }));
vi.mock('../components/TaskTree', () => ({ TaskTree: () => null }));
vi.mock('../hooks/useDragReorder', () => ({
    useDragReorder: () => ({ state: { dragging: null, indicator: null, crossSteps: 0, order: [], insertAt: 0 }, setContainer: () => {}, onPointerDown: () => {} }),
}));

import { ApiError } from '../api/client';
import { TasksView } from '../components/TasksView';
import { consumeTasksTab, peekTasksTab, requestTasksTab } from '../api/tasksViewIntent';

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    consumeTasksTab();
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists') return [{ id: 1, title: 'List 1', created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0, body: null, attachments: null, trashed_at: null, is_self: false }];
        if (path === '/task-lists?trashed=true') return [];
        if (path === '/task-tab-prefs') return [];
        if (path === '/servers') return [];
        if (path === '/task-features') throw new ApiError('Not Found', 404);
        if (/^\/task-lists\/\d+\/tasks$/.test(path)) return [];
        throw new Error(`unexpected GET ${path}`);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    consumeTasksTab();
});

/** As main.tsx mounts the app: inside StrictMode. */
async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => {
        root.render(<StrictMode><QueryClientProvider client={qc}><TasksView /></QueryClientProvider></StrictMode>);
    });
    await settle();
}

const remindersTabActive = () => !!container.querySelector('.tasks-tab-reminders.active');
const remindersShowing = () => !!container.querySelector('.tasks-reminders');

describe('a due-item notification opens the Tasks view on Reminders', () => {
    it('a request made before the view opens picks the Reminders tab, under StrictMode', async () => {
        requestTasksTab('reminders');
        await mount();
        expect(remindersTabActive()).toBe(true);
        expect(remindersShowing()).toBe(true);
    });

    it('POSITIVE CONTROL: with nobody asking, the same mount opens on the board', async () => {
        await mount();
        expect(remindersTabActive()).toBe(false);
        expect(remindersShowing()).toBe(false);
    });

    it('the request does not outlive the mount that used it', async () => {
        requestTasksTab('reminders');
        await mount();
        expect(remindersTabActive()).toBe(true);
        expect(peekTasksTab()).toBeNull();
    });

    it('a view already on screen switches tabs when the event arrives, leaving nothing pending', async () => {
        await mount();
        expect(remindersTabActive()).toBe(false);
        await act(async () => { window.dispatchEvent(new CustomEvent('sovereign:open-reminders')); });
        await settle();
        expect(remindersTabActive()).toBe(true);
        expect(remindersShowing()).toBe(true);
        expect(peekTasksTab()).toBeNull();
    });
});
