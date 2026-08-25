/**
 * upsertVoiceUser — the status-preserving roster write.
 *
 * The bug this pins: mute/deafen arrive ONCE (a __VOICE_STATUS__ message on
 * the toggle) while StreamStarted — the presence event — is REPLAYED for
 * every existing member whenever anyone joins, reconnects, or is re-claimed
 * after the idle reap. Four handlers rebuilt the entry from scratch with
 * `isDeafened: false` on that replay, so a deafened user's headphone icon
 * vanished for everyone the moment a fourth person walked in ("deafened
 * icons don't stay when deafened for a long period of time"). Every one of
 * those handlers now goes through this helper.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { globalVoiceUsers, upsertVoiceUser } from '../components/voiceState';

const ROOM = 'voice_1';

describe('upsertVoiceUser', () => {
    beforeEach(() => {
        globalVoiceUsers.clear();
    });

    it('a StreamStarted REPLAY keeps a BUFFERING user buffering (the clip badge rides the same one-shot ping)', () => {
        globalVoiceUsers.set(ROOM, new Map([[7, { id: 7, username: 'bob', isMuted: false, isDeafened: false, isBuffering: true }]]));
        upsertVoiceUser(ROOM, { id: 7, username: 'bob' });
        expect(globalVoiceUsers.get(ROOM)!.get(7)!.isBuffering).toBe(true);
        // positive control: a fresh entry is NOT buffering
        expect(upsertVoiceUser(ROOM, { id: 8, username: 'cai' }).isBuffering).toBe(false);
    });

    it('a StreamStarted REPLAY keeps a deafened user deafened', () => {
        globalVoiceUsers.set(ROOM, new Map([[7, { id: 7, username: 'bob', isMuted: true, isDeafened: true }]]));

        upsertVoiceUser(ROOM, { id: 7, username: 'bob' });

        const bob = globalVoiceUsers.get(ROOM)!.get(7)!;
        expect(bob.isDeafened).toBe(true);
        expect(bob.isMuted).toBe(true);
    });

    it('creates the room and the entry when the room is unknown, defaulting to not muted / not deafened', () => {
        // Positive control for the test above: proves the preserve branch is
        // not just "return true for everything".
        expect(globalVoiceUsers.has(ROOM)).toBe(false);

        const entry = upsertVoiceUser(ROOM, { id: 3, username: 'ann' });

        expect(globalVoiceUsers.get(ROOM)!.get(3)).toBe(entry);
        expect(entry).toEqual({ id: 3, username: 'ann', isMuted: false, isDeafened: false, isBuffering: false, avatarFileId: undefined, connecting: undefined });
    });

    it('preserves isMuted and isDeafened independently', () => {
        globalVoiceUsers.set(ROOM, new Map([
            [1, { id: 1, username: 'muted-only', isMuted: true, isDeafened: false }],
            [2, { id: 2, username: 'deaf-only', isMuted: false, isDeafened: true }],
        ]));

        upsertVoiceUser(ROOM, { id: 1, username: 'muted-only' });
        upsertVoiceUser(ROOM, { id: 2, username: 'deaf-only' });

        expect(globalVoiceUsers.get(ROOM)!.get(1)).toMatchObject({ isMuted: true, isDeafened: false });
        expect(globalVoiceUsers.get(ROOM)!.get(2)).toMatchObject({ isMuted: false, isDeafened: true });
    });

    it('a rename heals the username while keeping the status', () => {
        globalVoiceUsers.set(ROOM, new Map([[7, { id: 7, username: 'old-name', isMuted: false, isDeafened: true }]]));

        upsertVoiceUser(ROOM, { id: 7, username: 'new-name' });

        expect(globalVoiceUsers.get(ROOM)!.get(7)).toMatchObject({ username: 'new-name', isDeafened: true });
    });

    it('preserves avatarFileId and the connecting flag across a replay', () => {
        // The connecting chip (join-announce gate) and the avatar would
        // otherwise flicker off on every reconnect replay.
        globalVoiceUsers.set(ROOM, new Map([[7, { id: 7, username: 'bob', isMuted: false, isDeafened: false, avatarFileId: 'av-1', connecting: true }]]));

        upsertVoiceUser(ROOM, { id: 7, username: 'bob' });

        expect(globalVoiceUsers.get(ROOM)!.get(7)).toMatchObject({ avatarFileId: 'av-1', connecting: true });
    });

    it('a supplied avatarFileId wins over the remembered one', () => {
        globalVoiceUsers.set(ROOM, new Map([[7, { id: 7, username: 'bob', isMuted: false, isDeafened: false, avatarFileId: 'av-1' }]]));

        upsertVoiceUser(ROOM, { id: 7, username: 'bob', avatarFileId: 'av-2' });

        expect(globalVoiceUsers.get(ROOM)!.get(7)!.avatarFileId).toBe('av-2');
    });

    it('fallback flags apply only when there is no prior entry, never over a known status', () => {
        // First sight of a listen-only peer: seed muted.
        upsertVoiceUser(ROOM, { id: 9, username: 'quiet' }, { isMuted: true });
        expect(globalVoiceUsers.get(ROOM)!.get(9)).toMatchObject({ isMuted: true, isDeafened: false });

        // Later status said they un-muted; a replay carrying the same fallback
        // must NOT re-mute them.
        globalVoiceUsers.get(ROOM)!.get(9)!.isMuted = false;
        upsertVoiceUser(ROOM, { id: 9, username: 'quiet' }, { isMuted: true });
        expect(globalVoiceUsers.get(ROOM)!.get(9)!.isMuted).toBe(false);
    });

    it('does not disturb other members of the room', () => {
        globalVoiceUsers.set(ROOM, new Map([[1, { id: 1, username: 'a', isMuted: true, isDeafened: true }]]));

        upsertVoiceUser(ROOM, { id: 2, username: 'b' });

        expect(globalVoiceUsers.get(ROOM)!.get(1)).toMatchObject({ isMuted: true, isDeafened: true });
        expect(globalVoiceUsers.get(ROOM)!.size).toBe(2);
    });
});
