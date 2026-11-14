/**
 * The reading of the OTHER servers' calls behind "Active in your servers" (activeServers.ts): which
 * servers it asks, that it asks one at a time however many things ask, what it makes of an answer that
 * is not a list, and that it stops with the setting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ACTIVE_READ_CONCURRENCY, useActiveInServers, type ActiveReadStatus } from '../components/activeServers';
import { globalVoiceUsers } from '../components/voiceState';
import * as servers from '../api/servers';

vi.mock('../api/servers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    fetchVoiceUsers: vi.fn(),
    listChannels: vi.fn(),
}));

const fetchVoiceUsers = vi.mocked(servers.fetchVoiceUsers);
const listChannels = vi.mocked(servers.listChannels);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const seen: ActiveReadStatus[] = [];
const status = () => seen[seen.length - 1];
const onChange = vi.fn();
const eventSeq = vi.fn(() => 0);

type Opts = Parameters<typeof useActiveInServers>[0];
function Probe({ opts }: { opts: Opts }) {
    const st = useActiveInServers(opts);
    useEffect(() => { seen.push(st); }, [st]);
    return null;
}

const baseOpts = (over: Partial<Opts> = {}): Opts => ({
    enabled: true,
    servers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    currentServerId: 'a',
    eventSeq,
    onChange,
    ...over,
});

async function mount(opts: Opts) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <Probe opts={opts} />
            </QueryClientProvider>,
        );
    });
    await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
    fetchVoiceUsers.mockReset();
    listChannels.mockReset();
    onChange.mockReset();
    eventSeq.mockReturnValue(0);
    seen.length = 0;
    globalVoiceUsers.clear();
    listChannels.mockResolvedValue([{ id: 20, name: 'Arena', channel_type: 1, server_id: 'b' }]);
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
});

describe('useActiveInServers', () => {
    it('reads every server but the open one, once each, and fills the shared roster', async () => {
        fetchVoiceUsers.mockImplementation(async (id: string) => ({
            voice_users: id === 'b' ? [{ room_id: 'voice_20', user_id: 5, username: 'dee' }] : [],
        }));
        await mount(baseOpts());
        expect(fetchVoiceUsers.mock.calls.map(c => c[0]).sort()).toEqual(['b', 'c']);
        expect([...(globalVoiceUsers.get('voice_20')?.values() ?? [])].map(u => u.username)).toEqual(['dee']);
        // Naming the room needs its server's channel list, and only that server's: nothing is asked of one with nobody in it.
        expect(listChannels.mock.calls.map(c => c[0])).toEqual(['b']);
        expect(status()).toBe('ok');
        expect(onChange).toHaveBeenCalled();
    });

    it('asks for nothing while the setting is off', async () => {
        await mount(baseOpts({ enabled: false }));
        expect(fetchVoiceUsers).not.toHaveBeenCalled();
        expect(listChannels).not.toHaveBeenCalled();
    });

    it('treats an answer that is not a list as no answer: no throw, nothing changed, and not "nobody"', async () => {
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        fetchVoiceUsers.mockResolvedValue({} as never);
        await mount(baseOpts());
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
        expect(status()).toBe('partial');
        expect(globalVoiceUsers.size).toBe(0);
    });

    it('says partial when a server cannot be read, and ok again once it can', async () => {
        fetchVoiceUsers.mockImplementation(async (id: string) => {
            if (id === 'c') throw new Error('offline');
            return { voice_users: [] };
        });
        await mount(baseOpts());
        expect(status()).toBe('partial');
        fetchVoiceUsers.mockResolvedValue({ voice_users: [] });
        await act(async () => { window.dispatchEvent(new Event('wsConnected')); });
        await act(async () => { await Promise.resolve(); });
        expect(status()).toBe('ok');
    });

    it('runs one read at a time: a burst of triggers while one is out makes ONE more, not one each', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(r => { release = r; });
        fetchVoiceUsers.mockImplementation(async () => { await gate; return { voice_users: [] }; });
        await mount(baseOpts());
        const first = fetchVoiceUsers.mock.calls.length;
        expect(first).toBe(2);
        await act(async () => {
            for (let i = 0; i < 6; i++) window.dispatchEvent(new Event('wsConnected'));
        });
        expect(fetchVoiceUsers.mock.calls.length).toBe(first);
        await act(async () => { release(); });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(fetchVoiceUsers.mock.calls.length).toBe(first * 2);
    });

    it('asks a few servers at a time, never all at once, and still reads every one', async () => {
        const many = Array.from({ length: 13 }, (_, i) => ({ id: `s${i}` }));
        let inFlight = 0;
        let most = 0;
        const waiting: Array<() => void> = [];
        fetchVoiceUsers.mockImplementation(async () => {
            inFlight++;
            most = Math.max(most, inFlight);
            await new Promise<void>(r => waiting.push(r));
            inFlight--;
            return { voice_users: [] };
        });
        await mount(baseOpts({ servers: many, currentServerId: 's0' }));
        expect(fetchVoiceUsers.mock.calls.length, 'the first few asked').toBe(ACTIVE_READ_CONCURRENCY);
        // Answer them one by one: each answer lets one more go, never more than the cap at once.
        for (let i = 0; i < 40 && waiting.length > 0; i++) {
            await act(async () => { waiting.shift()!(); await new Promise(r => setTimeout(r, 0)); });
        }
        expect(most, 'never more than the cap at once').toBe(ACTIVE_READ_CONCURRENCY);
        expect(fetchVoiceUsers.mock.calls.map(c => c[0]).sort(), 'every server but the open one, once')
            .toEqual(many.filter(s => s.id !== 's0').map(s => s.id).sort());
        expect(status()).toBe('ok');
    });

    it('lets go of a room that the next read no longer names', async () => {
        fetchVoiceUsers.mockImplementation(async (id: string) => ({
            voice_users: id === 'b' ? [{ room_id: 'voice_20', user_id: 5, username: 'dee' }] : [],
        }));
        await mount(baseOpts());
        expect(globalVoiceUsers.get('voice_20')?.size).toBe(1);
        fetchVoiceUsers.mockImplementation(async () => ({ voice_users: [] }));
        await act(async () => { window.dispatchEvent(new Event('wsConnected')); });
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(globalVoiceUsers.get('voice_20')?.size ?? 0).toBe(0);
    });

    it('leaves the room of the call this client is in alone', async () => {
        globalVoiceUsers.set('voice_20', new Map([[1, { id: 1, username: 'me', isMuted: false, isDeafened: false, connecting: true }]]));
        fetchVoiceUsers.mockImplementation(async (id: string) => ({
            voice_users: id === 'b' ? [{ room_id: 'voice_20', user_id: 5, username: 'dee' }] : [],
        }));
        await mount(baseOpts({ callRoomId: 'voice_20' }));
        expect([...(globalVoiceUsers.get('voice_20')?.keys() ?? [])]).toEqual([1]);
    });
});
