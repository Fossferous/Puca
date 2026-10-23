/**
 * Which server a channel belongs to, from the client's own lists
 * (api/channelDirectory.ts) — what channelKeys.ts holds a channel key's wrap
 * set to (audit 2026-10, F-2). A channel the lists have not shown yet is
 * looked for through the user's servers, and one server whose channel list
 * cannot be read must not end the search: the channel may be in the next one
 * (second review). Unplaced, it mints nothing at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const wire = vi.hoisted(() => ({ broken: new Set<string>(), gets: [] as string[] }));
vi.mock('../api/client', () => ({
    apiClient: {
        get: vi.fn(async (url: string) => {
            wire.gets.push(url);
            if (url === '/servers') return [{ id: 's1', name: 'One' }, { id: 's2', name: 'Two' }];
            const m = /^\/servers\/(s\d)\/channels$/.exec(url);
            if (m) {
                if (wire.broken.has(m[1])) throw new Error(`${url}: 503`);
                return m[1] === 's2' ? [{ id: 77, name: 'voice-two' }] : [{ id: 11, name: 'general' }];
            }
            throw new Error('unexpected GET ' + url);
        }),
    },
}));

import { channelName, clearChannelDirectory, serverName, serverOfChannel } from '../api/channelDirectory';

beforeEach(() => {
    clearChannelDirectory();
    wire.broken.clear();
    wire.gets = [];
});

describe('placing a channel the lists have not shown yet', () => {
    it('finds it through the user\'s servers, and learns the names the notice uses', async () => {
        expect(await serverOfChannel(77)).toBe('s2');
        expect(channelName(77)).toBe('voice-two');
        expect(serverName('s2')).toBe('Two');
    });

    it('one server whose channel list fails does not end the search', async () => {
        wire.broken.add('s1');
        expect(await serverOfChannel(77), 'gave up at the first server that could not be read').toBe('s2');
    });

    it('CONTROL: a channel in no list stays unplaced, and is not looked for again at once', async () => {
        expect(await serverOfChannel(999)).toBeNull();
        const asked = wire.gets.length;
        expect(await serverOfChannel(999)).toBeNull();
        expect(wire.gets.length, 'every send would walk every server').toBe(asked);
    });
});
