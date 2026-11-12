/**
 * Who gets a channel key re-wrapped for them, and when
 * (components/useChannelKeyUpkeep.ts).
 *
 * THE FAILURE THIS PINS (0.9.861). A member who joined a server was handed
 * every TEXT channel's key by whoever was online, and no VOICE channel's: the
 * MemberJoined re-wrap passed `channel_type === 0` only. Every SFU voice room
 * whose key predated them then refused the join with "Channel encryption key
 * unavailable — cannot join encrypted call" until somebody holding that
 * room's key happened to join it. Found live: a newcomer (on Firefox, which
 * had nothing to do with it) could join no voice channel, while the database
 * showed every text key wrapped for them a second after they joined and the
 * voice room's key still at the generation before them.
 *
 * And the catch-up: MemberJoined reaches only members online at that moment,
 * so the same device also re-wraps once per server per sign-in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const handlers = new Map<string, Set<(m: { type: string; payload: unknown }) => void>>();
vi.mock('../api/websocket', () => ({
    wsClient: {
        on: (type: string, fn: (m: { type: string; payload: unknown }) => void) => {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type)!.add(fn);
        },
        off: (type: string, fn: (m: { type: string; payload: unknown }) => void) => { handlers.get(type)?.delete(fn); },
    },
}));

const rewrap = vi.fn(async (_ids: number[], _opts?: { bootstrap?: boolean }) => 0);
vi.mock('../api/channelKeys', async (orig) => ({
    ...(await orig<typeof import('../api/channelKeys')>()),
    rewrapForMembershipChange: (ids: number[], opts?: { bootstrap?: boolean }) => rewrap(ids, opts),
}));

const listChannels = vi.fn(async (_serverId: string) => [] as Array<{ id: number; channel_type: number; server_id: string }>);
vi.mock('../api/servers', async (orig) => ({
    ...(await orig<typeof import('../api/servers')>()),
    listChannels: (serverId: string) => listChannels(serverId),
}));

import { useChannelKeyUpkeep, type ChannelKeyUpkeepInput } from '../components/useChannelKeyUpkeep';
import { keyedChannelIds } from '../api/channelKeys';

/** Dutch Coffee Shop's shape: text channels, voice rooms, one collection. */
const S1 = [
    { id: 1, channel_type: 0, server_id: 's1' },
    { id: 4, channel_type: 0, server_id: 's1' },
    { id: 2, channel_type: 1, server_id: 's1' },
    { id: 3, channel_type: 1, server_id: 's1' },
    { id: 33, channel_type: 2, server_id: 's1' },
];
const S2 = [
    { id: 90, channel_type: 0, server_id: 's2' },
    { id: 91, channel_type: 1, server_id: 's2' },
];

function emit(type: string, payload: unknown) {
    for (const fn of handlers.get(type) ?? []) fn({ type, payload });
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));

/** A component that only runs the hook, mounted with React's own act(). */
const roots: Root[] = [];
function Probe(p: ChannelKeyUpkeepInput) { useChannelKeyUpkeep(p); return null; }
function mount(props: ChannelKeyUpkeepInput) {
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    act(() => { root.render(<Probe {...props} />); });
    return { rerender: (next: ChannelKeyUpkeepInput) => act(() => { root.render(<Probe {...next} />); }) };
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function input(over: Partial<ChannelKeyUpkeepInput> = {}): ChannelKeyUpkeepInput {
    return { currentUserId: 1, servers: [{ id: 's1' }, { id: 's2' }], currentServerId: 's1', channels: S1, channelsFetched: true, ...over };
}

describe('keyedChannelIds', () => {
    it('is every text channel and every voice channel, never a collection', () => {
        expect(keyedChannelIds(S1)).toEqual([1, 4, 2, 3]);
    });
});

describe('useChannelKeyUpkeep', () => {
    afterEach(() => { for (const r of roots.splice(0)) act(() => r.unmount()); });
    beforeEach(() => {
        handlers.clear();
        rewrap.mockClear();
        listChannels.mockClear();
    });

    it('someone joins the server being viewed: their key is re-wrapped for its VOICE rooms too', async () => {
        mount(input());
        await flush();
        rewrap.mockClear(); // the catch-up's own run, tested below
        emit('MemberJoined', { server_id: 's1', user: { id: 23 } });
        await flush();
        expect(rewrap).toHaveBeenCalledTimes(1);
        const [ids, opts] = rewrap.mock.calls[0];
        expect(ids, 'the voice rooms 2 and 3 must be re-wrapped for the newcomer').toEqual(expect.arrayContaining([2, 3]));
        expect(ids).toEqual(expect.arrayContaining([1, 4]));
        expect(ids, 'a collection has no key').not.toContain(33);
        // A join mints a first key where none exists, as a send would.
        expect(opts?.bootstrap).not.toBe(false);
    });

    it('someone joins ANOTHER of our servers: its list is fetched and its voice rooms are re-wrapped too', async () => {
        listChannels.mockResolvedValueOnce(S2);
        mount(input());
        await flush();
        rewrap.mockClear();
        emit('MemberJoined', { server_id: 's2', user: { id: 23 } });
        await flush();
        expect(listChannels).toHaveBeenCalledWith('s2');
        expect(rewrap.mock.calls[0][0]).toEqual([90, 91]);
    });

    it('CONTROLS: our own join, and a server we are not in, re-wrap nothing', async () => {
        mount(input());
        await flush();
        rewrap.mockClear();
        emit('MemberJoined', { server_id: 's1', user: { id: 1 } });
        emit('MemberJoined', { server_id: 'elsewhere', user: { id: 23 } });
        await flush();
        expect(rewrap).not.toHaveBeenCalled();
    });

    it('the catch-up: once per server per sign-in, text and voice, minting no first key', async () => {
        const { rerender } = mount(input());
        await flush();
        expect(rewrap).toHaveBeenCalledTimes(1);
        expect(rewrap.mock.calls[0][0]).toEqual([1, 4, 2, 3]);
        expect(rewrap.mock.calls[0][1]).toEqual({ bootstrap: false });

        // The same server again (a re-render, a refetch): nothing more.
        rerender(input({ channels: [...S1] }));
        await flush();
        expect(rewrap).toHaveBeenCalledTimes(1);

        // Another server: its own pass, once.
        rerender(input({ currentServerId: 's2', channels: S2 }));
        await flush();
        expect(rewrap).toHaveBeenCalledTimes(2);
        expect(rewrap.mock.calls[1][0]).toEqual([90, 91]);

        // Back to the first: already done this sign-in.
        rerender(input());
        await flush();
        expect(rewrap).toHaveBeenCalledTimes(2);

        // A different account on this device: its own catch-up.
        rerender(input({ currentUserId: 7 }));
        await flush();
        expect(rewrap).toHaveBeenCalledTimes(3);
    });

    it('the catch-up waits for the list that belongs to the server, not the previous one', async () => {
        // react-query can hand the previous server's list over for a render
        // while the new one loads; and nothing runs before the fetch is done.
        const { rerender } = mount(input({ currentServerId: 's2', channels: S1, channelsFetched: true }));
        await flush();
        expect(rewrap).not.toHaveBeenCalled();
        rerender(input({ currentServerId: 's2', channels: S2, channelsFetched: false }));
        await flush();
        expect(rewrap).not.toHaveBeenCalled();
        rerender(input({ currentServerId: 's2', channels: S2, channelsFetched: true }));
        await flush();
        expect(rewrap).toHaveBeenCalledTimes(1);
        expect(rewrap.mock.calls[0][0]).toEqual([90, 91]);
    });

    it('signed out (no user) or no server: nothing', async () => {
        mount(input({ currentUserId: 0 }));
        mount(input({ currentServerId: null }));
        await flush();
        expect(rewrap).not.toHaveBeenCalled();
    });
});
