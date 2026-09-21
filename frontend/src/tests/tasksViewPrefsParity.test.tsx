/**
 * Púca's Tasks view wears Púca Notes' organisation: colour, labels, archive.
 *
 * The same account-wide sealed document (notes/model/notesPrefs.ts and its
 * sync) now has two front doors, so this pins what the second one does with
 * it — and, above all, what it does to the SAVED TAB ORDER.
 *
 * That order is a full replace (PUT /task-tab-prefs) of every tab the view
 * knows about. The archive and the label filter HIDE tabs, exactly as the
 * trash does, so every hidden key has to be put back at its index or one
 * favourite would drop it to the tail — the bug already fixed for the trash
 * alone (frontend/src/tests/tasksViewTrashSlots.test.tsx, whose rig this
 * follows). Each of those has a positive control proving the fixture can see
 * the drift, because a test that cannot fail is worth nothing here.
 *
 * The sync ENGINE is not under test (notesPrefsSync.test.ts owns that); the
 * hook is stubbed and only its being mounted at all is asserted, since a view
 * that reads the document without keeping it in step shows one device's idea
 * of the colours forever.
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
// The prefs are namespaced per account, so the snapshot needs a signed-in id.
vi.mock('../api/auth', async (orig) => ({
    ...(await orig<typeof import('../api/auth')>()),
    currentUserIdFromToken: () => 7,
    getToken: () => null,
}));
// The real engine talks to /sealed-blobs; its own suite covers it.
const syncHook = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('../notes/model/notesPrefsSync', async (orig) => ({
    ...(await orig<typeof import('../notes/model/notesPrefsSync')>()),
    useNotesPrefsSync: () => { syncHook.mounts++; return 'synced' as const; },
}));
// The view's children are not under test and pull in far more than a tab bar.
vi.mock('../components/ChecklistBody', () => ({ ChecklistBody: () => null }));
vi.mock('../components/TaskTree', () => ({ TaskTree: () => null }));
// The tab bar's drop handler, as TasksView hands it to the drag hook.
type DropEvent = { key: string; group: string; order: string[]; insertAt: number; crossDelta: number; sameSlot?: boolean };
const drag = vi.hoisted(() => ({ onDrop: null as null | ((e: DropEvent) => void) }));
vi.mock('../hooks/useDragReorder', () => ({
    useDragReorder: (opts: { axis: string; onDrop: (e: DropEvent) => void }) => {
        if (opts.axis === 'x') drag.onDrop = opts.onDrop;
        return { state: { dragging: null, indicator: null, crossSteps: 0, order: [], insertAt: 0 }, setContainer: () => {}, onPointerDown: () => {} };
    },
}));

import { ApiError } from '../api/client';
import { setMessageToastSink } from '../components/messageToastBus';
import { TasksView } from '../components/TasksView';
import { getNotesPrefs, invalidateNotesPrefs } from '../notes/model/notesPrefs';
import { type TaskTabPref } from '../api/tasks';

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

/** Saved order: 5, then 7, then 9 — list 7's index is what the hidden-slot
 *  rule has to preserve. */
const SAVED: TaskTabPref[] = [5, 7, 9].map(id => ({ kind: 'list', ref_id: id, is_favorite: false }));
let trashSupported = true;
/** Which lists the server actually returns (dropping 7 makes it an UNKNOWN
 *  saved ref — a tab nothing knows is hidden, which is the control). */
let serverLists = [5, 7, 9];
let toasts: string[] = [];
// Restored per test rather than with vi.restoreAllMocks(), which would also
// clear the localStorage stand-ins the setup file installs.
let confirmSpy: ReturnType<typeof vi.spyOn> | null = null;
const confirmYes = () => { confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true); };

const row = (id: number) => ({
    id, title: `List ${id}`, created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
    body: null, attachments: null, trashed_at: null, is_self: false,
});

function installServer() {
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') {
            if (!trashSupported) throw new ApiError('Method Not Allowed', 405);
            return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536 };
        }
        if (path === '/task-lists?trashed=true') return [];
        if (path === '/task-lists') return serverLists.map(row);
        if (path === '/task-tab-prefs') return SAVED;
        if (path === '/servers') return [];
        if (/^\/task-lists\/\d+\/tasks$/.test(path)) return [];
        throw new Error(`unexpected GET ${path}`);
    });
    put.mockResolvedValue({});
    post.mockResolvedValue({});
    del.mockResolvedValue(undefined);
}

// --- the sealed document, as this browser holds it ---------------------------
const store: Record<string, string> = {};
const PREFS_KEY = 'pucaNotesPrefs:7';
function seedPrefs(p: { colors?: Record<string, string>; labels?: Record<string, string[]>; archived?: Record<string, true> }) {
    store[PREFS_KEY] = JSON.stringify({ colors: {}, labels: {}, archived: {}, view: 'grid', sort: 'puca', ...p });
    invalidateNotesPrefs();
}

let root: Root;
let container: HTMLDivElement;

async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><TasksView /></QueryClientProvider>); });
    await settle();
}

const tabs = () => [...container.querySelectorAll<HTMLElement>('.tasks-tab')];
const tabFor = (label: string) => tabs().find(t => t.querySelector('.tasks-tab-title')?.textContent === label);
const cardFor = (label: string) => [...container.querySelectorAll<HTMLElement>('.checklist-card')]
    .find(c => c.querySelector('.checklist-card-header')?.textContent?.includes(label));

/** Open a tab's context menu and return the item labels. */
async function openMenu(label: string): Promise<string[]> {
    const tab = tabFor(label);
    expect(tab, `the tab for ${label}`).toBeTruthy();
    await act(async () => { tab!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    await settle();
    return [...document.querySelectorAll<HTMLElement>('.context-menu-item')].map(b => b.textContent!.trim());
}

async function clickMenuItem(text: string) {
    const item = [...document.querySelectorAll<HTMLElement>('.context-menu-item')].find(b => b.textContent?.trim() === text);
    expect(item, `the "${text}" menu item is offered`).toBeTruthy();
    await act(async () => { item!.click(); });
    await settle();
}

/** Pick one entry from the tab bar's filter popover. */
async function pickFilter(text: string) {
    const filter = container.querySelector<HTMLElement>('.tasks-tab-filter');
    expect(filter, 'the filter control is in the fixed actions block').toBeTruthy();
    await act(async () => { filter!.click(); });
    await settle();
    const entry = [...document.querySelectorAll<HTMLElement>('.tasks-filter-item')]
        .find(b => b.textContent?.includes(text));
    expect(entry, `the "${text}" filter entry is offered`).toBeTruthy();
    return entry!;
}

async function showArchive() {
    const entry = await pickFilter('Archive');
    expect(entry.textContent, 'the count is the archived note').toContain('1');
    await act(async () => { entry.click(); });
    await settle();
}

/** Favourite one list through its tab's context menu; returns the saved order. */
async function favourite(label: string): Promise<string[]> {
    await openMenu(label);
    await clickMenuItem('Favourite');
    const puts = put.mock.calls.filter(c => c[0] === '/task-tab-prefs');
    expect(puts.length, 'exactly one order was saved').toBe(1);
    return (puts[0][1] as { prefs: TaskTabPref[] }).prefs.map(p => `${p.kind}:${p.ref_id}${p.is_favorite ? '*' : ''}`);
}

beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    trashSupported = true;
    serverLists = [5, 7, 9];
    drag.onDrop = null;
    syncHook.mounts = 0;
    toasts = [];
    setMessageToastSink(t => { toasts.push(t.title); });
    for (const k of Object.keys(store)) delete store[k];
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
    seedPrefs({});
    installServer();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    setMessageToastSink(null);
    confirmSpy?.mockRestore();
    confirmSpy = null;
});

describe('Púca Tasks view: the colours and labels set in Notes show here', () => {
    it('tints the tab and the board card, and leaves the others plain', async () => {
        seedPrefs({ colors: { 'list:7': 'mint' } });
        await mount();
        expect(tabFor('List 7')!.getAttribute('data-color')).toBe('mint');
        expect(cardFor('List 7')!.getAttribute('data-color')).toBe('mint');
        // Positive control: the fixture would have seen a tint anywhere.
        expect(tabFor('List 5')!.getAttribute('data-color')).toBe('default');
        expect(container.querySelectorAll('.tasks-tab[data-color="mint"]').length).toBe(1);
        expect(container.querySelectorAll('.checklist-card[data-color="mint"]').length).toBe(1);
    });

    it('shows a note’s labels on its tab and on its card, and nowhere else', async () => {
        seedPrefs({ labels: { 'list:9': ['Shopping'] } });
        await mount();
        expect(tabFor('List 9')!.querySelector('.tasks-tab-labels')!.textContent).toBe('Shopping');
        expect(cardFor('List 9')!.querySelector('.tasks-card-label')!.textContent).toContain('Shopping');
        expect(tabFor('List 5')!.querySelector('.tasks-tab-labels')).toBeNull();
    });

    it('keeps the account’s document in step while it is open', async () => {
        await mount();
        expect(syncHook.mounts, 'TasksView mounts useNotesPrefsSync').toBeGreaterThan(0);
    });
});

describe('Púca Tasks view: the archive', () => {
    it('takes an archived note off the bar and off the board', async () => {
        seedPrefs({ archived: { 'list:7': true } });
        await mount();
        expect(tabFor('List 7')).toBeUndefined();
        expect(cardFor('List 7')).toBeUndefined();
        // Positive control: the other two are exactly where they were.
        expect(tabFor('List 5')).toBeTruthy();
        expect(cardFor('List 9')).toBeTruthy();
    });

    it('archives from the tab’s menu', async () => {
        await mount();
        expect(await openMenu('List 7')).toContain('Archive');
        await clickMenuItem('Archive');
        expect(getNotesPrefs().archived).toEqual({ 'list:7': true });
        expect(tabFor('List 7')).toBeUndefined();
    });

    it('shows the archive behind the filter, and unarchives from there', async () => {
        seedPrefs({ archived: { 'list:7': true } });
        await mount();
        await showArchive();
        expect(tabFor('List 7'), 'the archive shows what it holds').toBeTruthy();
        expect(tabFor('List 5'), 'and nothing else').toBeUndefined();

        expect(await openMenu('List 7')).toContain('Unarchive');
        await clickMenuItem('Unarchive');
        expect(getNotesPrefs().archived).toEqual({});
    }, 15_000);
});

describe('Púca Tasks view: a hidden note keeps its slot in the saved order', () => {
    it('a favourite with a note ARCHIVED saves the archived note back at its index', async () => {
        seedPrefs({ archived: { 'list:7': true } });
        await mount();
        expect(await favourite('List 9')).toEqual(['list:9*', 'list:7', 'list:5']);
    });

    it('POSITIVE CONTROL: the same favourite with nothing known to be hidden sends the ref to the tail', async () => {
        // List 7 is not archived and not trashed — the server simply does not
        // return it, so the view has no tab for it and no reason to hold its
        // place. That drift is exactly what an archived note would suffer.
        serverLists = [5, 9];
        await mount();
        expect(await favourite('List 9')).toEqual(['list:9*', 'list:5', 'list:7']);
    });

    it('a DRAG with a note archived keeps the archived note at its index', async () => {
        seedPrefs({ archived: { 'list:7': true } });
        await mount();
        expect(drag.onDrop, 'TasksView wired a drop handler for the tab bar').toBeTruthy();
        await act(async () => { drag.onDrop!({ key: 'list:9', group: '', order: ['list:5'], insertAt: 0, crossDelta: 0 }); });
        await settle();
        const saved = put.mock.calls.filter(c => c[0] === '/task-tab-prefs')
            .map(c => (c[1] as { prefs: TaskTabPref[] }).prefs.map(p => `${p.kind}:${p.ref_id}`));
        expect(saved).toEqual([['list:9', 'list:7', 'list:5']]);
    });

    it('a favourite while a LABEL FILTER is on keeps the filtered-out notes in place', async () => {
        seedPrefs({ labels: { 'list:7': ['Shopping'], 'list:9': ['Shopping'] } });
        await mount();
        const entry = await pickFilter('Shopping');
        await act(async () => { entry.click(); });
        await settle();
        expect(tabFor('List 5'), 'the filter is on').toBeUndefined();
        // List 5 is hidden by the filter, not gone: it keeps index 0.
        expect(await favourite('List 9')).toEqual(['list:5', 'list:9*', 'list:7']);
    }, 15_000);

    it('POSITIVE CONTROL: the same favourite with the filter OFF puts list 5 behind the favourite', async () => {
        seedPrefs({ labels: { 'list:7': ['Shopping'], 'list:9': ['Shopping'] } });
        await mount();
        expect(await favourite('List 9')).toEqual(['list:9*', 'list:5', 'list:7']);
    });
});

describe('Púca Tasks view: a delete forgets the organisation, the trash does not', () => {
    it('a permanent delete forgets the note’s colour and labels', async () => {
        trashSupported = false;                       // no trash: Delete is for good
        seedPrefs({ colors: { 'list:7': 'mint' }, labels: { 'list:7': ['Shopping'] } });
        confirmYes();
        await mount();
        await openMenu('List 7');
        await clickMenuItem('Delete List');
        expect(del).toHaveBeenCalledWith('/task-lists/7');
        expect(getNotesPrefs().colors).toEqual({});
        expect(getNotesPrefs().labels).toEqual({});
    });

    it('a move to the TRASH keeps them, so a restore brings them back', async () => {
        seedPrefs({ colors: { 'list:7': 'mint' }, labels: { 'list:7': ['Shopping'] } });
        confirmYes();
        await mount();
        await openMenu('List 7');
        await clickMenuItem('Move to trash');
        expect(post).toHaveBeenCalledWith('/task-lists/7/trash', {});
        expect(toasts, 'the trash accepted it').toEqual([]);
        expect(getNotesPrefs().colors).toEqual({ 'list:7': 'mint' });
        expect(getNotesPrefs().labels).toEqual({ 'list:7': ['Shopping'] });
    });
});
