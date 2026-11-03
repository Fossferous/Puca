/**
 * Púca Notes and server modes (docs/SERVER_MODES.md): a checklist channel a mode hides is
 * marked for the grid to leave out, and is still IN the sources, because the prune reads
 * them and must not take a mode switch for the channel having been deleted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let activeMode: number | null = null;
vi.mock('../api/servers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    listServers: async () => [{ id: 's1', name: 'S', owner_id: 1, active_mode_id: activeMode }],
    listChannels: async () => [
        { id: 1, name: 'Always', channel_type: 0, server_id: 's1', has_checklist: true, mode_ids: [] },
        { id: 2, name: 'Game notes', channel_type: 0, server_id: 's1', has_checklist: true, mode_ids: [7] },
        { id: 3, name: 'Rooms', channel_type: 2, server_id: 's1', has_checklist: false, mode_ids: [7] },
        { id: 4, name: 'Under', channel_type: 0, server_id: 's1', has_checklist: true, parent_id: 3, mode_ids: [] },
    ],
    listMembersWithRoles: async () => [],
}));

const { useChannelSources } = await import('../notes/model/notesQueries');
const { MODES_CHANGED_EVENT } = await import('../api/serverModes');

let root: Root;
let container: HTMLDivElement;

function Probe() {
    const { sources } = useChannelSources();
    return <pre>{JSON.stringify(Object.fromEntries(sources.map(s => [s.title, s.hiddenByMode])))}</pre>;
}

async function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); });
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const hidden = () => JSON.parse(container.textContent || '{}');

beforeEach(() => {
    activeMode = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
});

describe('Notes\' channel sources and a server mode', () => {
    it('keeps every checklist channel, marking what a mode hides, under a collection or not', async () => {
        await mount();
        expect(hidden()).toEqual({ Always: false, 'Game notes': true, Under: true });
    });

    it('CONTROL: with the mode on, nothing is marked', async () => {
        activeMode = 7;
        await mount();
        expect(hidden()).toEqual({ Always: false, 'Game notes': false, Under: false });
    });

    it('hears a switch in the app around it, while it stays mounted', async () => {
        await mount();
        expect(hidden()['Game notes'], 'control: hidden while the mode is off').toBe(true);
        activeMode = 7;
        await act(async () => {
            window.dispatchEvent(new CustomEvent(MODES_CHANGED_EVENT));
            for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
        });
        expect(hidden()['Game notes']).toBe(false);
        expect(hidden().Under).toBe(false);
    });
});
