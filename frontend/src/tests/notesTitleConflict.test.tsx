/**
 * Two devices, one note — the TITLE half.
 *
 * The note's text has had this since migration 069: the revision a save is
 * judged against is taken when the user STARTS TYPING, not when the save
 * fires, because a live refetch arriving mid-sentence moves the cached
 * revision to the other device's. A title that read the revision at commit
 * time would name THEIRS and be accepted — destroying their rename with no
 * refusal, no banner and no toast, which is the precise loss this whole
 * feature exists to stop.
 *
 * Two levels, because the bug can live at either:
 *  - NoteEditor captures the base on the clean→dirty edge of the title;
 *  - renameNote sends the base it was GIVEN, and only falls back to the
 *    cache when it was given none.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, patch, del, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn() }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { get, post, patch, delete: del, put } };
});
vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));
vi.mock('../api/e2ee', async (orig) => {
    const real = await orig<typeof import('../api/e2ee')>();
    const id = real.makeIdentity(new Uint8Array(32).fill(9));
    return { ...real, getActiveIdentity: () => id, seedMatchesCurrentAccount: () => true };
});
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn(), setMessageToastSink: vi.fn() }));
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));
vi.mock('../notes/model/notesPrefsSync', () => ({ pullNotesPrefs: vi.fn(), pushNotesPrefs: vi.fn() }));
// The editor's body is not what this file is about, and rendering it would
// drag the whole task tree in.
vi.mock('../components/TaskTree', () => ({ TaskTree: () => null }));
vi.mock('../notes/components/NoteContentSection', () => ({ NoteContentSection: () => null }));
vi.mock('../notes/model/notesQueries', async (orig) => ({
    ...(await orig<typeof import('../notes/model/notesQueries')>()),
    useNoteTasks: () => ({ data: [], isPending: false, isFetching: false }),
}));

import { type TaskList } from '../api/tasks';
import { type NoteActions, notesKeys, useNoteActions } from '../notes/model/notesQueries';
import { type NoteCard } from '../notes/model/notesModel';
import { NoteEditor } from '../notes/components/NoteEditor';
import { listContentKeys } from '../notes/model/useListContent';
import { parseListFeatures } from '../api/listContent';

const FEATURES = { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, content_rev: true, idempotent_creates: true, server_now_ms: Date.now() };

let root: Root | null = null;
let container: HTMLDivElement;

const card = (o: Partial<NoteCard> = {}): NoteCard => ({
    key: 'list:5', ref: { kind: 'list', id: 5 }, title: 'Shopping', tasks: [],
    pinned: false, color: 'default', labels: [], archived: false, total: 0, completed: 0,
    contentRev: 3, ...o,
});

// The editor is portaled to document.body, not into the host div.
const titleInput = () => document.body.querySelector('.notes-editor-title') as HTMLInputElement;
function typeTitle(value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        const el = titleInput();
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const blurTitle = () => { act(() => { titleInput().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); }); };

beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
    document.body.innerHTML = '';
});

describe('NoteEditor: the base a rename names', () => {
    const stub = (): NoteActions => ({ renameNote: vi.fn(async () => true) } as unknown as NoteActions);

    function show(actions: NoteActions, c: NoteCard) {
        act(() => {
            root!.render(
                <NoteEditor
                    card={c} actions={actions} onClose={() => {}} onMenu={() => {}}
                    onPickColor={() => {}} onPickLabels={() => {}} onArchive={() => {}} pucaHref={null}
                />,
            );
        });
    }

    it('names the revision the typing STARTED from, not the one the refetch moved to', () => {
        const actions = stub();
        show(actions, card());
        typeTitle('Weekly shop');
        // Mid-typing, the other device's rename lands. The draft is kept (the
        // guard that already existed) and the card's revision moves to theirs.
        show(actions, card({ title: 'Theirs', contentRev: 4 }));
        expect(titleInput().value).toBe('Weekly shop');
        blurTitle();
        // 3, not 4. With 4 the server accepts and their rename is gone.
        expect(actions.renameNote).toHaveBeenCalledWith({ kind: 'list', id: 5 }, 'Weekly shop', 3);
    });

    it('POSITIVE CONTROL: a revision that moved BEFORE the typing is the one that is named', () => {
        const actions = stub();
        show(actions, card());
        // Nothing typed yet, so this is a plain refresh...
        show(actions, card({ title: 'Theirs', contentRev: 4 }));
        expect(titleInput().value).toBe('Theirs');
        // ...and typing now starts from THAT revision.
        typeTitle('Mine now');
        blurTitle();
        expect(actions.renameNote).toHaveBeenCalledWith({ kind: 'list', id: 5 }, 'Mine now', 4);
    });

    it('a title left alone commits nothing at all', () => {
        const actions = stub();
        show(actions, card());
        blurTitle();
        expect(actions.renameNote).not.toHaveBeenCalled();
    });
});

describe('renameNote sends the base it was given', () => {
    const row = (rev: number): TaskList => ({
        id: 5, title: 'Shopping', created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
        body: null, attachments: null, trashed_at: null, is_self: false, content_rev: rev,
    });

    async function mountActions(): Promise<{ qc: QueryClient; actions: () => NoteActions }> {
        get.mockImplementation(async (path: string) => {
            if (path === '/task-lists/features') return FEATURES;
            if (path.startsWith('/task-lists?trashed')) return [];
            throw new Error(`unexpected GET ${path}`);
        });
        patch.mockResolvedValue({ content_rev: 11 });
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        // Primed rather than fetched: a rename only names a revision once the
        // features are KNOWN, and waiting on the probe here would make the
        // whole file a race.
        qc.setQueryData(listContentKeys.features, parseListFeatures(FEATURES));
        const box: { current: NoteActions | null } = { current: null };
        function Probe() {
            const a = useNoteActions([], [], true);
            useEffect(() => { box.current = a; });
            return null;
        }
        await act(async () => { root!.render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>); });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(box.current!.content.features.contentRev).toBe(true);
        qc.setQueryData<TaskList[]>(notesKeys.lists, [row(3)]);
        return { qc, actions: () => box.current! };
    }

    it('prefers the caller’s base over the cache, which the refetch has already moved', async () => {
        const { qc, actions } = await mountActions();
        // What a live refetch did while the title was being typed.
        qc.setQueryData<TaskList[]>(notesKeys.lists, [row(9)]);
        await act(async () => { await actions().renameNote({ kind: 'list', id: 5 }, 'Weekly shop', 3); });
        const body = patch.mock.calls.at(-1)![1] as Record<string, unknown>;
        expect(body.expect_rev).toBe(3);
        // And the answer's revision is taken, so a second rename straight
        // after does not name the one this call has already moved past.
        expect(qc.getQueryData<TaskList[]>(notesKeys.lists)![0].content_rev).toBe(11);
    });

    it('POSITIVE CONTROL: with no base given it still names the cached one', async () => {
        const { qc, actions } = await mountActions();
        qc.setQueryData<TaskList[]>(notesKeys.lists, [row(9)]);
        await act(async () => { await actions().renameNote({ kind: 'list', id: 5 }, 'Weekly shop'); });
        const body = patch.mock.calls.at(-1)![1] as Record<string, unknown>;
        expect(body.expect_rev).toBe(9);
    });
});
