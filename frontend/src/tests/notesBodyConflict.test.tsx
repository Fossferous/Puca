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

import { apiClient, ApiError } from '../api/client';
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

beforeEach(() => { vi.clearAllMocks(); });
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

    it('VERSION SKEW: against a server without the revision, no base is named at all', async () => {
        const actions = await mount(FEATURES_065);
        vi.mocked(apiClient.patch).mockResolvedValueOnce({});
        await act(async () => { await actions().setBody(5, 'my words'); });
        const sent = vi.mocked(apiClient.patch).mock.calls[0][1] as Record<string, unknown>;
        expect(Object.keys(sent)).not.toContain('expect_rev');
        expect(cached().body).toBe('my words');
    });
});
