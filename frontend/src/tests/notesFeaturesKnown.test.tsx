/**
 * `featuresKnown` on the data layer's content actions (useListContent): true
 * once `features` is the server's answer, false while it is still the
 * NO_LIST_FEATURES stand-in.
 *
 * "Open Púca Notes to" waits on it at the app's start (native/useNotesOpenTo):
 * opened against the stand-in, "A new note" would come up as a checklist on a
 * server that keeps note text perfectly well, and the composer never
 * re-decides once it has opened (QuickAdd reads `content` at seed time only).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn() }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));
vi.mock('../notes/model/notesPrefsSync', () => ({ pullNotesPrefs: vi.fn() }));

import { apiClient } from '../api/client';
import { NO_LIST_FEATURES } from '../api/listContent';
import { useListContentActions, type ListContentActions } from '../notes/model/useListContent';

const FEATURES = { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536 };

let root: Root | null = null;
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    document.body.innerHTML = '';
});

describe('featuresKnown', () => {
    it('is false on the stand-in and true once the server has answered', async () => {
        let answer: (v: unknown) => void = () => {};
        vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
            if (path === '/task-lists/features') return new Promise(r => { answer = r; });
            if (path.startsWith('/task-lists?trashed')) return [];
            throw new Error(`unexpected GET ${path}`);
        });
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const seen: { current: ListContentActions | null } = { current: null };
        function Probe() {
            const a = useListContentActions({ lists: ['notes', 'lists'], tasks: () => ['tasks'] });
            useEffect(() => { seen.current = a; });
            return null;
        }
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>); });

        expect(seen.current!.features).toEqual(NO_LIST_FEATURES);
        expect(seen.current!.featuresKnown).toBe(false);

        await act(async () => { answer(FEATURES); });
        for (let i = 0; i < 20 && !seen.current!.featuresKnown; i++) {
            await act(async () => { await new Promise(r => setTimeout(r, 5)); });
        }
        expect(seen.current!.featuresKnown).toBe(true);
        expect(seen.current!.features.body).toBe(true);
    });
});
