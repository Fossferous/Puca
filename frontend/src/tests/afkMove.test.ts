import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// Only the network edge is mocked; the query cache is the real thing, because
// the bug this guards against was about WHICH cache entry gets consulted.
const { listChannelsMock } = vi.hoisted(() => ({ listChannelsMock: vi.fn() }));
vi.mock('../api/servers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    listChannels: (serverId: string) => listChannelsMock(serverId),
}));

import { resolveAfkTarget } from '../utils/afkMove';
import { keys } from '../hooks/queries';
import type { Channel } from '../api/servers';

const chan = (id: number, server_id: string | null, opts: Partial<Channel> = {}): Channel => ({
    id,
    name: `c${id}`,
    channel_type: 1,
    server_id,
    ...opts,
});

// Regression guard for the cross-server AFK move: the idle timer used to look
// up an `is_afk` channel in the CURRENTLY VIEWED server's channel list, so a
// user in voice on server A while browsing server B could be moved into B's
// AFK channel — or not moved at all when only A had one.
describe('resolveAfkTarget', () => {
    let qc: QueryClient;
    const voiceA = chan(10, 'srv-a');
    const afkA = chan(11, 'srv-a', { is_afk: true });
    const afkB = chan(21, 'srv-b', { is_afk: true });

    beforeEach(() => {
        listChannelsMock.mockReset();
        qc = new QueryClient({
            defaultOptions: { queries: { staleTime: Infinity, retry: false } },
        });
    });

    it('resolves the AFK channel of the VOICE channel\'s server, not the viewed one', async () => {
        // Both servers cached, both have an AFK channel — the viewed server
        // (srv-b) is the trap the old code fell into.
        qc.setQueryData(keys.channels('srv-a'), [voiceA, afkA, chan(12, 'srv-a', { channel_type: 0 })]);
        qc.setQueryData(keys.channels('srv-b'), [chan(20, 'srv-b'), afkB]);

        const target = await resolveAfkTarget(qc, voiceA);
        expect(target?.id).toBe(afkA.id);
        expect(target?.server_id).toBe('srv-a');
        expect(listChannelsMock).not.toHaveBeenCalled(); // cache hit, no fetch
    });

    it('does NOT move when only the viewed server has an AFK channel', async () => {
        qc.setQueryData(keys.channels('srv-a'), [voiceA, chan(12, 'srv-a', { channel_type: 0 })]);
        qc.setQueryData(keys.channels('srv-b'), [chan(20, 'srv-b'), afkB]);

        expect(await resolveAfkTarget(qc, voiceA)).toBeNull();
    });

    it('fetches the voice server\'s channels on a cache miss', async () => {
        listChannelsMock.mockResolvedValue([voiceA, afkA]);

        const target = await resolveAfkTarget(qc, voiceA);
        expect(target?.id).toBe(afkA.id);
        expect(listChannelsMock).toHaveBeenCalledExactlyOnceWith('srv-a');
    });

    it('never moves out of the AFK channel itself', async () => {
        qc.setQueryData(keys.channels('srv-a'), [voiceA, afkA]);
        expect(await resolveAfkTarget(qc, afkA)).toBeNull();
        expect(listChannelsMock).not.toHaveBeenCalled();
    });

    it('no-ops for a channel without a server', async () => {
        expect(await resolveAfkTarget(qc, chan(30, null))).toBeNull();
        expect(listChannelsMock).not.toHaveBeenCalled();
    });

    it('ignores a text channel wrongly flagged is_afk', async () => {
        qc.setQueryData(keys.channels('srv-a'), [voiceA, chan(13, 'srv-a', { channel_type: 0, is_afk: true })]);
        expect(await resolveAfkTarget(qc, voiceA)).toBeNull();
    });
});
