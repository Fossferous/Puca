/**
 * "Make a copy" as it actually runs (useListContent.ts createNoteFromPlan).
 *
 * THE LOAD-BEARING ONE is the re-seal. Putting the source's `href` into the
 * copy's sidecar would leave two notes naming one upload — the hazard
 * docs/SECURITY_MODEL.md §2 describes — so *Delete forever* on either note
 * would delete files the other still shows, and a trashed copy expiring after
 * 30 days would silently destroy the original's pictures. The copy must own
 * fresh file ids under fresh keys, and the test asserts the two sets are
 * disjoint.
 *
 * The rest: children land under the COPY's parent, a ticked item comes back
 * ticked, a copy whose uploads fail part-way leaves nothing behind on the
 * server for the owner to be billed for, and a copy that fails SAYS SO — it
 * is asked for from a card menu with nowhere to report a null, and a copy
 * never queues, so silence looked exactly like a copy that worked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));
vi.mock('../api/e2ee', async (orig) => {
    const real = await orig<typeof import('../api/e2ee')>();
    const id = real.makeIdentity(new Uint8Array(32).fill(3));
    return { ...real, getActiveIdentity: () => id, seedMatchesCurrentAccount: () => true };
});
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn() }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } };
});
vi.mock('../api/tasks', async (orig) => {
    const real = await orig<typeof import('../api/tasks')>();
    return { ...real, createListTask: vi.fn(), updateListTaskAttachments: vi.fn(), patchTaskTiming: vi.fn() };
});
vi.mock('../api/listContent', async (orig) => {
    const real = await orig<typeof import('../api/listContent')>();
    return { ...real, createTaskListWithContent: vi.fn(), deleteFiles: vi.fn(), fetchListFeatures: vi.fn() };
});
vi.mock('../api/attachments', async (orig) => {
    const real = await orig<typeof import('../api/attachments')>();
    return { ...real, encryptAndUploadRef: vi.fn(), decryptToBlobUrl: vi.fn() };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));

import { apiClient, ApiError } from '../api/client';
import { decryptToBlobUrl, encryptAndUploadRef } from '../api/attachments';
import { createTaskListWithContent, deleteFiles } from '../api/listContent';
import { createListTask, patchTaskTiming, updateListTaskAttachments, type Task, type TaskAttachmentRef, type TaskList } from '../api/tasks';
import { pushMessageToast } from '../components/messageToastBus';
import { type CopyPlan } from '../notes/model/noteText';
import { useNoteActions, type NoteActions } from '../notes/model/notesQueries';

const href = (id: string) => `sovereign-enc:${id}?k=KEY-${id}&m=${encodeURIComponent('image/png')}`;
const ref = (id: string): TaskAttachmentRef => ({ href: href(id), name: `${id}.png` });
const task = (id: number, description: string): Task => ({
    id, channel_id: null, list_id: 77, parent_id: null, description, is_completed: false, position: id,
    created_at: '', created_by: 7, attachments: null, due_at: null,
});
const list: TaskList = { id: 77, title: 'Groceries (copy)', created_at: '', total_tasks: 0, completed_tasks: 0 };

const item = (text: string, over: Partial<CopyPlan['items'][number]> = {}) => ({
    text, completed: false, dueAt: null, schedule: null, attachments: [], children: [], ...over,
});
const plan = (over: Partial<CopyPlan> = {}): CopyPlan => ({
    title: 'Groceries (copy)', body: '', noteRefs: [], items: [], files: 0, ...over,
});

let root: Root | null = null;
function mountActions(): () => NoteActions {
    const box: { current: NoteActions | null } = { current: null };
    function Probe() {
        const a = useNoteActions([], [], true);
        useEffect(() => { box.current = a; });
        return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>); });
    return () => box.current!;
}

/** Every file id the copy's sidecars name, note-level and per item. */
function copiedIds(): string[] {
    const fromList = (vi.mocked(createTaskListWithContent).mock.calls[0]?.[1].refs ?? []) as TaskAttachmentRef[];
    const fromItems = vi.mocked(updateListTaskAttachments).mock.calls.flatMap(c => c[1]);
    return [...fromList, ...fromItems].map(r => r.href.slice('sovereign-enc:'.length).split('?')[0]);
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.get).mockRejectedValue(new Error('not needed'));
    vi.mocked(createTaskListWithContent).mockResolvedValue(list);
    vi.mocked(deleteFiles).mockResolvedValue(undefined);
    let n = 500;
    vi.mocked(createListTask).mockImplementation(async (_l: number, text: string, parentId?: number) => ({
        ...task(n++, text), parent_id: parentId ?? null,
    }));
    vi.mocked(decryptToBlobUrl).mockResolvedValue('blob:fake');
    let copy = 0;
    vi.mocked(encryptAndUploadRef).mockImplementation(async (f: File) => {
        const id = `new${++copy}`;
        return { href: href(id), name: f.name, mime: 'image/png' };
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['bytes']) })));
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

describe('copyNote', () => {
    it('RE-SEALS every picture: the copy names its own uploads, never the original’s', async () => {
        const actions = mountActions();
        await act(async () => {
            await actions().copyNote(plan({
                noteRefs: [ref('src-note')],
                items: [item('Milk', { attachments: [ref('src-item')] })],
                files: 2,
            }));
        });
        expect(encryptAndUploadRef).toHaveBeenCalledTimes(2);
        const ids = copiedIds();
        expect(ids).toHaveLength(2);
        expect(ids.some(id => id.startsWith('src-'))).toBe(false);
        expect(new Set(ids)).toEqual(new Set(['new1', 'new2']));
        expect(deleteFiles).not.toHaveBeenCalled();
    });

    it('creates children under the COPY’s parent, not the source’s, and ticks what was ticked', async () => {
        const actions = mountActions();
        await act(async () => {
            await actions().copyNote(plan({
                items: [item('Milk', { children: [item('Semi-skimmed')] }), item('Bread', { completed: true })],
            }));
        });
        expect(vi.mocked(createListTask).mock.calls.map(c => [c[1], c[2]]))
            .toEqual([['Milk', undefined], ['Semi-skimmed', 500], ['Bread', undefined]]);
        // A timing patch, not a plain is_completed: migration 066's guard
        // refuses the latter for a scheduled item, and the ordinary tick would
        // advance a repeating one.
        expect(vi.mocked(patchTaskTiming).mock.calls).toEqual([[expect.objectContaining({ id: 502 }), { is_completed: true }]]);
    });

    it('ALL OR NOTHING: an upload that fails part-way leaves nothing on the server and makes no note', async () => {
        vi.mocked(encryptAndUploadRef)
            .mockResolvedValueOnce({ href: href('new1'), name: 'a.png', mime: 'image/png' })
            .mockResolvedValueOnce({ href: href('new2'), name: 'b.png', mime: 'image/png' })
            .mockRejectedValueOnce(new Error('upload failed'));
        const actions = mountActions();
        let out: unknown = 'unset';
        await act(async () => {
            out = await actions().copyNote(plan({
                noteRefs: [ref('s1'), ref('s2')],
                items: [item('Milk', { attachments: [ref('s3')] })],
                files: 3,
            }));
        });
        expect(out).toBeNull();
        expect(createTaskListWithContent).not.toHaveBeenCalled();
        expect(createListTask).not.toHaveBeenCalled();
        // Both halves of the rollback: resealRefs cleans its own partial, and
        // createNoteFromPlan cleans everything the copy had uploaded.
        expect(vi.mocked(deleteFiles).mock.calls.flat(2).filter(Boolean).sort()).toEqual(['new1', 'new2']);
    });

    it('says so when the copy fails with no reason of its own — offline, or a 500', async () => {
        vi.mocked(createTaskListWithContent).mockRejectedValue(new TypeError('Failed to fetch'));
        const actions = mountActions();
        let out: unknown = 'unset';
        await act(async () => { out = await actions().copyNote(plan({ items: [item('Milk')] })); });
        expect(out).toBeNull();
        expect(vi.mocked(pushMessageToast).mock.calls).toEqual([[{ title: 'Couldn’t copy the note — check your connection' }]]);
    });

    it('POSITIVE CONTROL: when the server gives a reason, that reason is shown instead — once', async () => {
        vi.mocked(createTaskListWithContent).mockRejectedValue(new ApiError('Notes to self cannot be copied', 400));
        const actions = mountActions();
        await act(async () => { await actions().copyNote(plan({ items: [item('Milk')] })); });
        expect(vi.mocked(pushMessageToast).mock.calls).toEqual([[{ title: 'Notes to self cannot be copied' }]]);
    });

    it('POSITIVE CONTROL: a note with no pictures uploads nothing and still copies its items', async () => {
        const actions = mountActions();
        let out: unknown = null;
        await act(async () => { out = await actions().copyNote(plan({ body: 'Before Friday', items: [item('Milk')] })); });
        expect(out).toEqual({ kind: 'list', id: 77 });
        expect(encryptAndUploadRef).not.toHaveBeenCalled();
        expect(decryptToBlobUrl).not.toHaveBeenCalled();
        expect(updateListTaskAttachments).not.toHaveBeenCalled();
        expect(vi.mocked(createTaskListWithContent).mock.calls[0]).toEqual(['Groceries (copy)', { body: 'Before Friday', refs: [] }]);
        expect(vi.mocked(createListTask).mock.calls.map(c => c[1])).toEqual(['Milk']);
    });
});
