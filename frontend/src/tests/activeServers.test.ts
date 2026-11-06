// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { activePeople, activeServersView, reconcileRoster } from '../components/activeServers';
import type { VoiceUserStatus } from '../components/voiceState';

const ch = (id: number, name: string, channel_type = 1, is_afk = false) => ({ id, name, channel_type, is_afk });

describe('what "Active in your servers" lists', () => {
    const channels: Record<string, ReturnType<typeof ch>[]> = {
        a: [ch(1, 'Lounge'), ch(2, 'Quiet'), ch(3, 'general', 0), ch(4, 'AFK', 1, true)],
        b: [ch(10, 'Raid')],
        c: [ch(20, 'Never opened')],
    };
    const rosters: Record<string, { id: number; username: string }[]> = {
        voice_1: [{ id: 7, username: 'ana' }, { id: 8, username: 'bo' }],
        voice_3: [{ id: 9, username: 'text rooms have no roster' }],
        voice_4: [{ id: 7, username: 'ana' }],
        voice_10: [{ id: 9, username: 'cy' }],
        voice_20: [{ id: 5, username: 'dee' }],
    };
    const view = (extra: Partial<Parameters<typeof activeServersView>[0]> = {}) => activeServersView({
        servers: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }, { id: 'd', name: 'Delta' }],
        currentServerId: 'a',
        channelsOf: id => channels[id],
        rosterOf: roomId => rosters[roomId] ?? [],
        ...extra,
    });

    it("names each server that has somebody in a voice room, in the rail's order, and the rooms they are in", () => {
        const out = view();
        expect(out.map(s => [s.serverId, s.rooms.map(r => r.name)])).toEqual([['a', ['Lounge']], ['b', ['Raid']], ['c', ['Never opened']]]);
        expect(out[0].rooms[0].users.map(u => u.username)).toEqual(['ana', 'bo']);
    });

    it('marks the open server', () => {
        expect(view().map(s => s.isCurrent)).toEqual([true, false, false]);
    });

    it('leaves out the AFK room, an empty room, a text channel and a server it has no channel list for', () => {
        const names = view().flatMap(s => s.rooms.map(r => r.name));
        expect(names).not.toContain('AFK');
        expect(names).not.toContain('Quiet');
        expect(names).not.toContain('general');
        expect(view({ channelsOf: id => (id === 'b' ? undefined : channels[id]) }).map(s => s.serverId)).toEqual(['a', 'c']);
    });

    it('lists nothing for a server nobody is active in', () => {
        expect(view({ rosterOf: () => [] })).toEqual([]);
    });

    it('counts people room by room', () => {
        expect(activePeople(view())).toBe(4);
    });
});

describe("reading another server's snapshot into the shared roster", () => {
    const status = (id: number, username: string, over: Partial<VoiceUserStatus> = {}): VoiceUserStatus =>
        ({ id, username, isMuted: false, isDeafened: false, ...over });
    const existing = new Map([['voice_1', new Map([[7, status(7, 'ana', { isMuted: true })], [8, status(8, 'bo')]])]]);

    it('keeps what is known of somebody who stays, adds who is new and drops who left', () => {
        const next = reconcileRoster(existing, [
            { room_id: 'voice_1', user_id: 7, username: 'ana' },
            { room_id: 'voice_1', user_id: 9, username: 'cy' },
        ], ['voice_1']);
        const room = next.get('voice_1')!;
        expect([...room.keys()]).toEqual([7, 9]);
        expect(room.get(7)?.isMuted).toBe(true);
        expect(room.get(9)).toMatchObject({ username: 'cy', isMuted: false, isDeafened: false });
    });

    it('empties a room the snapshot no longer names, which is how somebody who left while offline stops showing', () => {
        const next = reconcileRoster(existing, [], ['voice_1']);
        expect(next.get('voice_1')?.size).toBe(0);
    });

    it('touches only the rooms it was told of or that the snapshot names', () => {
        const next = reconcileRoster(existing, [{ room_id: 'voice_5', user_id: 1, username: 'x' }], []);
        expect([...next.keys()]).toEqual(['voice_5']);
    });
});
