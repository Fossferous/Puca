/**
 * Two devices, one note — through the data layer (useListContent.setBody).
 *
 * The server refuses a save whose base revision is stale (migration 069) and
 * hands back the copy it holds. What this pins is what happens NEXT on this
 * device: the optimistic text is taken out of the cache (nothing was
 * written), the other copy and its revision go in — so the very next save is
 * judged against the right base — and the caller is told, with their words.
 *
 * It also pins the version skew, which is easy to get wrong in the quiet
 * direction: against a server that does not advertise the revision, no
 * `expect_rev` is sent at all and the save behaves exactly as it always did.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));
vi.mock('../api/e2ee', async (orig) => {
    const real = await orig<typeof import('../api/e2ee')>();
    const id = real.makeIdentity(new Uint8Array(32).fill(4));
    return { ...real, getActiveIdentity: () => id, seedMatchesCurrentAccount: () => true };
});
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn() }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));
vi.mock('../notes/model/notesPrefsSync', () => ({ pullNotesPrefs: vi.fn() }));
vi.mock('../api/noteMedia', async (orig) => ({ ...(await orig<typeof import('../api/noteMedia')>()), uploadNoteMedia: vi.fn() }));

import { apiClient, ApiError } from '../api/client';
import { isNoteBusy, resetNoteBusy } from '../notes/model/noteBusy';
import { applyTaskEvent } from '../notes/model/taskEvents';
import { uploadNoteMedia } from '../api/noteMedia';
import { type TaskAttachmentRef } from '../api/tasks';
import { sealSelfField } from '../api/listSeal';
import { type TaskList } from '../api/tasks';
import { noteSaved, useListContentActions, listContentKeys, type ListContentActions } from '../notes/model/useListContent';

const LISTS_KEY = ['notes', 'lists'] as const;

const FEATURES_069 = { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, content_rev: true, idempotent_creates: true };
const FEATURES_065 = { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536 };

const note = (o: Partial<TaskList> = {}): TaskList => ({
    id: 5, title: 'Note', created_at: '', total_tasks: 0, completed_tasks: 0,
    body: 'mine so far', attachments: null, trashed_at: null, content_rev: 3, ...o,
});

let root: Root | null = null;
let qc: QueryClient;

async function mount(features: object): Promise<() => ListContentActions> {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') return features;
        if (path.startsWith('/task-lists?trashed')) return [];
        throw new Error(`unexpected GET ${path}`);
    });
    const box: { current: ListContentActions | null } = { current: null };
    function Probe() {
        const a = useListContentActions({ lists: LISTS_KEY, tasks: () => ['tasks'] });
        useEffect(() => { box.current = a; });
        return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>); });
    // The features query has to settle before a save can name a revision.
    await act(async () => { await qc.ensureQueryData({ queryKey: listContentKeys.features, queryFn: async () => box.current!.features }); });
    for (let i = 0; i < 10 && !box.current?.features.contentRev && features === FEATURES_069; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    }
    qc.setQueryData<TaskList[]>(LISTS_KEY, [note()]);
    return () => box.current!;
}

const cached = () => qc.getQueryData<TaskList[]>(LISTS_KEY)!.find(l => l.id === 5)!;

async function staleRefusal(theirText: string, rev = 9) {
    return new ApiError('conflict', 409, undefined, JSON.stringify({
        conflict: 'stale', content_rev: rev, title: 'sealed', body: await sealSelfField(theirText), attachments: null,
    }));
}

beforeEach(() => { vi.clearAllMocks(); resetNoteBusy(); });
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    document.body.innerHTML = '';
});

describe('a note’s text saved on top of someone else’s edit', () => {
    it('names the base, and on a refusal keeps nothing of the losing save', async () => {
        const actions = await mount(FEATURES_069);
        vi.mocked(apiClient.patch).mockRejectedValueOnce(await staleRefusal('their words'));

        let outcome: unknown;
        await act(async () => { outcome = await actions().setBody(5, 'my words'); });

        // The save named the revision the cache held...
        expect((vi.mocked(apiClient.patch).mock.calls[0][1] as Record<string, unknown>).expect_rev).toBe(3);
        // ...and the caller is handed their copy so the field can show both.
        expect(outcome).toEqual({ conflict: { theirs: 'their words', rev: 9 } });
        // Nothing was written, so the cache must NOT hold the losing text —
        // it holds what the server holds, with its revision, so the next
        // save is judged against the right base.
        expect(cached().body).toBe('their words');
        expect(cached().content_rev).toBe(9);
    });

    it('a save that wins takes the new revision, so the next one chains without a refetch', async () => {
        const actions = await mount(FEATURES_069);
        vi.mocked(apiClient.patch).mockResolvedValueOnce({ content_rev: 4 });
        let outcome: unknown;
        await act(async () => { outcome = await actions().setBody(5, 'my words'); });
        expect(outcome).toEqual({ rev: 4 });   // the new revision comes back, so the next save chains
        expect(cached().body).toBe('my words');
        expect(cached().content_rev).toBe(4);

        vi.mocked(apiClient.patch).mockResolvedValueOnce({ content_rev: 5 });
        await act(async () => { await actions().setBody(5, 'more words'); });
        expect((vi.mocked(apiClient.patch).mock.calls[1][1] as Record<string, unknown>).expect_rev).toBe(4);
    });

    it('an ordinary failure still rolls the text back and is NOT reported as a conflict', async () => {
        const actions = await mount(FEATURES_069);
        vi.mocked(apiClient.patch).mockRejectedValueOnce(new ApiError('boom', 500, undefined, 'boom'));
        let outcome: unknown;
        await act(async () => { outcome = await actions().setBody(5, 'my words'); });
        expect(outcome).toBe(false);
        expect(cached().body).toBe('mine so far');
    });

    it('noteSaved tells a conflict from a save — truthiness alone would call the clash a success', async () => {
        const actions = await mount(FEATURES_069);
        vi.mocked(apiClient.patch).mockRejectedValueOnce(await staleRefusal('their words'));
        let clash: unknown;
        await act(async () => { clash = await actions().setBody(5, 'my words'); });
        expect(noteSaved(clash as never)).toBe(false);
        expect(Boolean(clash)).toBe(true);   // ...which is exactly the trap
        vi.mocked(apiClient.patch).mockResolvedValueOnce({ content_rev: 4 });
        let ok: unknown;
        await act(async () => { ok = await actions().setBody(5, 'my words'); });
        expect(noteSaved(ok as never)).toBe(true);
    });

    // The base being right at SEND time is only half of it: the cached
    // revision must not move while the save is out. A note's text, title and
    // pictures live in the LISTING query, and a task_lists UPDATE raises the
    // 'lists' event (migration 067) — so it is the listing's refetch that has
    // to wait, not this note's items. Marking `list:5` (the items key) left
    // that refetch entirely undeferred: it landed the pre-save body AND the
    // other device's revision in the cache, and the next save then named a
    // base the user had already moved past and was refused — a conflict
    // banner over the user's OWN earlier words, with nobody else involved.
    it('holds the LISTING’s refetch while a text save is out, not this note’s items', async () => {
        const actions = await mount(FEATURES_069);
        let land: (v: unknown) => void = () => {};
        vi.mocked(apiClient.patch).mockImplementationOnce(() => new Promise(r => { land = r; }));
        const qc2 = new QueryClient();
        const spy = vi.spyOn(qc2, 'invalidateQueries');

        expect(isNoteBusy('lists')).toBe(false);
        let save!: Promise<unknown>;
        await act(async () => { save = actions().setBody(5, 'my words'); await Promise.resolve(); });
        expect(isNoteBusy('lists')).toBe(true);
        // A live event for the notes now waits...
        applyTaskEvent(qc2, { t: 'lists' }, false);
        expect(spy).not.toHaveBeenCalled();
        // ...while this note's ITEMS are not held: a text save changes none.
        expect(isNoteBusy('list:5')).toBe(false);
        applyTaskEvent(qc2, { t: 'list', id: 5 }, false);
        expect(spy).toHaveBeenCalledWith({ queryKey: ['notes', 'tasks', 'list', 5] });

        await act(async () => { land({ content_rev: 4 }); await save; });
        expect(isNoteBusy('lists')).toBe(false);
        expect(spy).toHaveBeenCalledWith({ queryKey: ['notes', 'lists'] });
    });

    // A picture is the same story with a much longer window: the sidecar to
    // save is read BEFORE the upload, which is seconds on a phone. The base
    // has to be read there too, or the save names a revision its own payload
    // never saw and the check cannot refuse the race it exists for.
    it('a picture names the revision its sidecar was read from, not the one the upload finished on', async () => {
        const actions = await mount(FEATURES_069);
        let finish!: (refs: TaskAttachmentRef[]) => void;
        vi.mocked(uploadNoteMedia).mockImplementationOnce(() => new Promise(r => { finish = r; }));
        vi.mocked(apiClient.patch).mockResolvedValueOnce({ content_rev: 10 });

        let add!: Promise<boolean>;
        await act(async () => {
            add = actions().addNoteMedia(5, [new File(['x'], 'a.png', { type: 'image/png' })], []);
            await Promise.resolve();
        });
        // Mid-upload, the other device's picture lands in the cache.
        qc.setQueryData<TaskList[]>(LISTS_KEY, [note({ content_rev: 9 })]);
        await act(async () => { finish([{ href: 'file:1', name: 'a.png' }]); await add; });

        const sent = vi.mocked(apiClient.patch).mock.calls[0][1] as Record<string, unknown>;
        expect(sent.expect_rev).toBe(3);   // what `kept` was read from — so the server refuses
    });

    it('POSITIVE CONTROL: a picture added with nothing in flight names the current revision', async () => {
        const actions = await mount(FEATURES_069);
        qc.setQueryData<TaskList[]>(LISTS_KEY, [note({ content_rev: 9 })]);
        vi.mocked(uploadNoteMedia).mockResolvedValueOnce([{ href: 'file:1', name: 'a.png' }]);
        vi.mocked(apiClient.patch).mockResolvedValueOnce({ content_rev: 10 });
        await act(async () => { await actions().addNoteMedia(5, [new File(['x'], 'a.png', { type: 'image/png' })], []); });
        const sent = vi.mocked(apiClient.patch).mock.calls[0][1] as Record<string, unknown>;
        expect(sent.expect_rev).toBe(9);
    });

    it('VERSION SKEW: against a server without the revision, no base is named at all', async () => {
        const actions = await mount(FEATURES_065);
        vi.mocked(apiClient.patch).mockResolvedValueOnce({});
        await act(async () => { await actions().setBody(5, 'my words'); });
        const sent = vi.mocked(apiClient.patch).mock.calls[0][1] as Record<string, unknown>;
        expect(Object.keys(sent)).not.toContain('expect_rev');
        expect(cached().body).toBe('my words');
    });
});
