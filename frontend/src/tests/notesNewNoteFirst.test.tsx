/**
 * Every way Púca Notes makes a note puts it FIRST among the unpinned, through
 * the REAL action surface (notes/model/notesQueries.ts useNoteActions and the
 * content paths under it, useListContent.ts):
 *
 *  - createNote with items only — the composer's Done, and so a share, a
 *    pasted checklist and the calendar's "New note…", which all call it;
 *  - createNote with text or pictures, online (one request) and offline
 *    (queued, with a temporary id);
 *  - copyNote (Make a copy, from the card menu and from a selection);
 *  - placeNewNote, for a note made some other way (a calendar import).
 *
 * What is asserted is the one pin/order save each hands the outbox (the pure
 * placement and its replay are newNoteFirst.test.ts's): the intent, the full
 * set, the order on screen, and that it goes out the moment the list exists —
 * BEFORE its items, because the live stream reads the listing again as soon
 * as the list is made, and a note placed only afterwards shows at the bottom
 * and then jumps.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { sendNoteOp } from '../notes/model/notesOutbox';

const H = vi.hoisted(() => ({
    uploadNoteMedia: vi.fn(),
    sealNoteMedia: vi.fn(),
    resealRefs: vi.fn(),
    park: vi.fn(async () => undefined),
    deleteFiles: vi.fn(async () => undefined),
    createTaskListWithContent: vi.fn(),
    createListTask: vi.fn(),
    sendNoteOp: vi.fn<typeof sendNoteOp>(),
    forgetParkedMedia: vi.fn(async () => undefined),
    pendingOutboxCount: vi.fn(() => 0),
    ensureOutboxLoaded: vi.fn(async () => undefined),
    sendCreateList: vi.fn(),
    sendCreateTask: vi.fn(),
    toasts: [] as string[],
}));

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    // Nothing here may reach a network: every write goes through a mock below.
    return { ...real, apiClient: { ...real.apiClient, get: vi.fn(async () => { throw new Error('not in this test'); }) } };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: (t: { title: string }) => { H.toasts.push(t.title); } }));
vi.mock('../api/noteMedia', async (orig) => {
    const real = await orig<typeof import('../api/noteMedia')>();
    return { ...real, uploadNoteMedia: H.uploadNoteMedia, sealNoteMedia: H.sealNoteMedia, resealRefs: H.resealRefs };
});
vi.mock('../api/listContent', async (orig) => {
    const real = await orig<typeof import('../api/listContent')>();
    return { ...real, createTaskListWithContent: H.createTaskListWithContent, deleteFiles: H.deleteFiles };
});
vi.mock('../api/tasks', async (orig) => {
    const real = await orig<typeof import('../api/tasks')>();
    return { ...real, createListTask: H.createListTask };
});
vi.mock('../notes/model/notesBlobs', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesBlobs')>();
    return { ...real, appParkedStore: { ...real.appParkedStore, park: H.park } };
});
vi.mock('../notes/model/notesOutbox', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesOutbox')>();
    // The create helpers call the outbox from inside the module, so they are
    // mocked themselves: what is asserted is what they are handed.
    return {
        ...real,
        sendNoteOp: H.sendNoteOp,
        forgetParkedMedia: H.forgetParkedMedia,
        pendingOutboxCount: H.pendingOutboxCount,
        ensureOutboxLoaded: H.ensureOutboxLoaded,
        sendCreateList: H.sendCreateList,
        sendCreateTask: H.sendCreateTask,
    };
});

import { ApiError } from '../api/client';
import { NO_LIST_FEATURES } from '../api/listContent';
import type { Task, TaskList, TaskTabPref } from '../api/tasks';
import type { NoteOp } from '../notes/model/notesOutbox';
import { notesKeys, useNoteActions, type NoteActions } from '../notes/model/notesQueries';
import type { CopyPlan } from '../notes/model/noteText';

const pref = (id: number, fav = false): TaskTabPref => ({ kind: 'list', ref_id: id, is_favorite: fav });
const show = (prefs: TaskTabPref[] | undefined) => prefs?.map(p => `${p.ref_id}${p.is_favorite ? '*' : ''}`).join(',');
/** Two pinned, two not: a new note belongs between them. */
const SAVED = [pref(1, true), pref(2, true), pref(3), pref(4)];
const listRow = (id: number, title: string): TaskList => ({ id, title, created_at: '2026-09-29T00:00:00Z', total_tasks: 0, completed_tasks: 0 });
const taskRow = (id: number, listId: number, description: string): Task => ({
    id, channel_id: null, list_id: listId, parent_id: null, description, is_completed: false, position: id,
    created_at: '', created_by: 7, attachments: null, due_at: null,
});

let root: Root | null = null;
let qc: QueryClient;
let onLine = true;
let onLineSpy: ReturnType<typeof vi.spyOn> | null = null;

/** `prefs` null: the order has never been read on this device. */
async function mountActions(prefs: TaskTabPref[] | null = SAVED): Promise<() => NoteActions> {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    qc.setQueryData<TaskList[]>(notesKeys.lists, [1, 2, 3, 4].map(id => listRow(id, `n${id}`)));
    if (prefs) qc.setQueryData<TaskTabPref[]>(notesKeys.prefs, prefs);
    qc.setQueryData(['notes', 'features'], { ...NO_LIST_FEATURES, body: true, attachments: true, idempotentCreates: true });
    const box: { current: NoteActions | null } = { current: null };
    function Probe() {
        const a = useNoteActions([], prefs ?? [], prefs !== null);
        useEffect(() => { box.current = a; });
        return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>); });
    return () => box.current!;
}

/** The pin/order saves handed to the outbox, in order. */
const prefsOps = () => H.sendNoteOp.mock.calls.map(c => c[0] as NoteOp).filter((o): o is NoteOp & { k: 'prefs' } => o.k === 'prefs');
/** When the i-th call of a mock ran, against every other mock's calls. */
const orderOf = (fn: { mock: { invocationCallOrder: number[] } }, i = 0) => fn.mock.invocationCallOrder[i];
const placementCall = () => H.sendNoteOp.mock.calls.findIndex(c => (c[0] as NoteOp).k === 'prefs');

beforeEach(() => {
    vi.clearAllMocks();
    H.toasts = [];
    onLine = true;
    H.sendNoteOp.mockResolvedValue({ queued: false, value: undefined });
    H.pendingOutboxCount.mockReturnValue(0);
    H.ensureOutboxLoaded.mockResolvedValue(undefined);
    H.uploadNoteMedia.mockResolvedValue([]);
    H.sealNoteMedia.mockResolvedValue([]);
    H.resealRefs.mockResolvedValue([]);
    let created = 50;
    H.sendCreateList.mockImplementation(async (title: string) => listRow(created++, title));
    H.createTaskListWithContent.mockImplementation(async (title: string) => listRow(9, title));
    let n = 500;
    H.sendCreateTask.mockImplementation(async (note: { id: number }, text: string) => taskRow(n++, note.id, text));
    H.createListTask.mockImplementation(async (listId: number, text: string) => taskRow(n++, listId, text));
    onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine);
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    document.body.innerHTML = '';
    onLineSpy?.mockRestore();
});

describe('a note made in Púca Notes goes first under the pinned ones', () => {
    it('the composer’s Done (a note of items — a share, a paste and the calendar’s “New note…” too): one save, first after the pinned', async () => {
        const actions = await mountActions();
        let ref: unknown;
        await act(async () => { ref = await actions().createNote('Groceries', ['Milk', 'Bread']); });
        expect(ref).toEqual({ kind: 'list', id: 50 });
        const ops = prefsOps();
        expect(ops).toHaveLength(1);
        expect(ops[0].intent).toEqual({ type: 'created', tab: { kind: 'list', id: 50 } });
        expect(show(ops[0].prefs)).toBe('1*,2*,50,3,4');                     // pinned kept, others kept in order
        expect(show(qc.getQueryData(notesKeys.prefs))).toBe('1*,2*,50,3,4');  // on screen at once
        // Placed the moment the list existed, before either item was sent.
        expect(orderOf(H.sendNoteOp, placementCall())).toBeLessThan(orderOf(H.sendCreateTask, 0));
        expect(H.sendCreateTask).toHaveBeenCalledTimes(2);
    });

    it('a text note, online (one request): placed as soon as its list exists, before its items', async () => {
        const actions = await mountActions();
        await act(async () => { await actions().createNote('Poem', ['a line'], { body: 'Roses are red' }); });
        expect(H.createTaskListWithContent).toHaveBeenCalledTimes(1);
        const ops = prefsOps();
        expect(ops.map(o => o.intent)).toEqual([{ type: 'created', tab: { kind: 'list', id: 9 } }]);
        expect(show(ops[0].prefs)).toBe('1*,2*,9,3,4');
        expect(orderOf(H.sendNoteOp, placementCall())).toBeLessThan(orderOf(H.createListTask, 0));
    });

    it('a text note made OFFLINE: placed under its temporary id, queued right behind its create and ahead of its text', async () => {
        onLine = false;
        H.sendCreateList.mockImplementation(async (title: string) => listRow(-5, title));
        H.sendNoteOp.mockResolvedValue({ queued: true });
        const actions = await mountActions();
        await act(async () => { await actions().createNote('Poem', [], { body: 'Roses are red' }); });
        expect(H.createTaskListWithContent).not.toHaveBeenCalled();         // the queued road
        const sent = H.sendNoteOp.mock.calls.map(c => (c[0] as NoteOp).k);
        expect(sent).toEqual(['prefs', 'setBody']);
        expect(prefsOps()[0].intent).toEqual({ type: 'created', tab: { kind: 'list', id: -5 } });
        expect(show(qc.getQueryData(notesKeys.prefs))).toBe('1*,2*,-5,3,4');  // first on screen while it waits
        expect(orderOf(H.sendCreateList)).toBeLessThan(orderOf(H.sendNoteOp, 0));
    });

    it('a note of items made offline: the same, under its temporary id', async () => {
        H.sendCreateList.mockImplementation(async (title: string) => listRow(-6, title));
        H.sendNoteOp.mockResolvedValue({ queued: true });
        const actions = await mountActions();
        await act(async () => { await actions().createNote('Packing', ['Socks']); });
        expect(prefsOps().map(o => o.intent)).toEqual([{ type: 'created', tab: { kind: 'list', id: -6 } }]);
        expect(show(qc.getQueryData(notesKeys.prefs))).toBe('1*,2*,-6,3,4');
    });

    it('Make a copy: the copy goes first too, before its items', async () => {
        const actions = await mountActions();
        const plan: CopyPlan = {
            title: 'Groceries (copy)', body: '', noteRefs: [], files: 0,
            items: [{ text: 'Milk', completed: false, dueAt: null, schedule: null, attachments: [], children: [] }],
        };
        await act(async () => { await actions().copyNote(plan); });
        expect(prefsOps().map(o => o.intent)).toEqual([{ type: 'created', tab: { kind: 'list', id: 9 } }]);
        expect(show(qc.getQueryData(notesKeys.prefs))).toBe('1*,2*,9,3,4');
        expect(orderOf(H.sendNoteOp, placementCall())).toBeLessThan(orderOf(H.createListTask, 0));
    });

    it('two notes made one after the other: both first under the pinned, the newer on top', async () => {
        const actions = await mountActions();
        await act(async () => { await actions().createNote('One', ['a']); });
        await act(async () => { await actions().createNote('Two', ['b']); });
        expect(show(qc.getQueryData(notesKeys.prefs))).toBe('1*,2*,51,50,3,4');
        expect(show(prefsOps()[1].prefs)).toBe('1*,2*,51,50,3,4');          // built on the first, not on a stale copy
    });

    it('online, the grid then shows the order as SAVED — with a pin another device made that this one had not read', async () => {
        const actions = await mountActions();
        // The order the outbox wrote the note into (notesOutbox.ts execOp):
        // the server's, where another device has pinned 4 meanwhile.
        H.sendNoteOp.mockImplementation(async (op: NoteOp) => (op.k === 'prefs'
            ? { queued: false, value: [pref(4, true), pref(1, true), pref(2, true), pref(50), pref(3)] }
            : { queued: false, value: undefined }));
        await act(async () => { await actions().createNote('Groceries', ['Milk']); });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(show(qc.getQueryData(notesKeys.prefs))).toBe('4*,1*,2*,50,3');
    });

    it('…but only the latest save puts its answer up: a placement answered after the next save has gone out leaves the screen to that one', async () => {
        const actions = await mountActions();
        const answers: Array<(v: TaskTabPref[]) => void> = [];
        H.sendNoteOp.mockImplementation((op: NoteOp) => (op.k === 'prefs'
            ? new Promise(r => { answers.push(v => r({ queued: false, value: v })); })
            : Promise.resolve({ queued: false as const, value: undefined })));
        await act(async () => { await actions().createNote('One', ['a']); });
        await act(async () => { await actions().createNote('Two', ['b']); });
        expect(answers).toHaveLength(2);
        await act(async () => { answers[0]([pref(1, true), pref(2, true), pref(50), pref(3), pref(4)]); });
        expect(show(qc.getQueryData(notesKeys.prefs))).toBe('1*,2*,51,50,3,4');   // not the older answer
        await act(async () => { answers[1]([pref(1, true), pref(2, true), pref(51), pref(50), pref(3), pref(4), pref(8)]); });
        expect(show(qc.getQueryData(notesKeys.prefs))).toBe('1*,2*,51,50,3,4,8');
    });

    it('a note made some other way (a calendar import) is placed through actions.placeNewNote', async () => {
        const actions = await mountActions();
        act(() => { actions().placeNewNote({ kind: 'list', id: 77 }); });
        expect(show(prefsOps()[0].prefs)).toBe('1*,2*,77,3,4');
        expect(prefsOps()[0].intent).toEqual({ type: 'created', tab: { kind: 'list', id: 77 } });
    });

    it('an order that was never read gets no save at all — and nothing is said, since nobody asked for one', async () => {
        const actions = await mountActions(null);
        await act(async () => { await actions().createNote('Groceries', ['Milk']); });
        expect(prefsOps()).toEqual([]);
        expect(qc.getQueryData(notesKeys.prefs)).toBeUndefined();
        expect(H.toasts).toEqual([]);
        // POSITIVE CONTROL: the note itself was made, so the save above was withheld, not unreached.
        expect(H.sendCreateList).toHaveBeenCalledTimes(1);
    });

    it('a placement the server refuses puts the order back as it was, and says so', async () => {
        const actions = await mountActions();
        H.sendNoteOp.mockRejectedValue(new ApiError('Bad Gateway', 502));
        await act(async () => { await actions().createNote('Groceries', ['Milk']); });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(show(qc.getQueryData(notesKeys.prefs))).toBe('1*,2*,3,4');
        expect(H.toasts).toContain('Couldn’t save the pin or order — check your connection');
    });
});
