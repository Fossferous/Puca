/**
 * What the user context menu offers for voice moderation, decided in one pure
 * function that Chat uses for EVERY surface that opens the menu — the member
 * list, the sidebar voice rows and the stage tiles.
 *
 * The defect: the member list located the member only in the VIEWER's own
 * call, so a moderator who was not in voice (or sat in another channel) got no
 * "Move to" / "Disconnect" for someone visibly in voice. The decision now
 * searches every voice channel of the server, independent of where the viewer
 * is — Discord's behaviour, which the owner asked for.
 */
import { describe, it, expect } from 'vitest';
import { userMenuVoiceModeration, type VoiceMoveChannel } from '../utils/voiceMove';

const ch = (id: number, opts: Partial<VoiceMoveChannel> = {}): VoiceMoveChannel => ({
    id, name: `voice-${id}`, channel_type: 1, ...opts,
});
const text = ch(1, { name: 'general', channel_type: 0 });
const lounge = ch(2, { name: 'Lounge' });
const gaming = ch(3, { name: 'Gaming' });
const afk = ch(9, { name: 'AFK', is_afk: true });
const channels = [text, lounge, gaming, afk];

const MEMBER = 42;
const rosters = (r: Record<number, number[]>) => (channelId: number) =>
    (r[channelId] ?? []).map(id => ({ id }));

describe('userMenuVoiceModeration', () => {
    it('member in a voice channel: offered, aimed at THEIR channel', () => {
        const v = userMenuVoiceModeration({
            userId: MEMBER, channels, canMoveVoiceMembers: true,
            rosterOf: rosters({ [gaming.id]: [MEMBER] }),
        });
        expect(v.canMoveMembers).toBe(true);
        expect(v.voiceChannel?.id).toBe(gaming.id);
        expect(v.targets.map(c => c.id)).toEqual([lounge.id, afk.id]);
    });

    // The helper takes no viewer input at all, by design; that the MEMBER LIST
    // reaches it whatever call the viewer is in is pinned through the real Chat
    // in chatMemberListVoiceModeration.test.tsx. This case pins only that the
    // search matches the member, not whoever sits in the first voice channel.
    it('someone else in an earlier voice channel does not mislocate the member', () => {
        const v = userMenuVoiceModeration({
            userId: MEMBER, channels, canMoveVoiceMembers: true,
            rosterOf: rosters({ [lounge.id]: [7], [gaming.id]: [MEMBER] }),
        });
        expect(v.canMoveMembers).toBe(true);
        expect(v.voiceChannel?.id).toBe(gaming.id);
    });

    it('without MOVE_MEMBERS: never offered (the channel is still located)', () => {
        const v = userMenuVoiceModeration({
            userId: MEMBER, channels, canMoveVoiceMembers: false,
            rosterOf: rosters({ [gaming.id]: [MEMBER] }),
        });
        expect(v.canMoveMembers).toBe(false);
        expect(v.voiceChannel?.id).toBe(gaming.id);
    });

    it('member in no voice channel of this server: nothing to offer', () => {
        const v = userMenuVoiceModeration({
            userId: MEMBER, channels, canMoveVoiceMembers: true,
            rosterOf: rosters({ [lounge.id]: [7] }),
        });
        expect(v.canMoveMembers).toBe(false);
        expect(v.voiceChannel).toBeNull();
        expect(v.targets).toEqual([]);
    });

    it('only VOICE channels are searched (a text channel id never locates anyone)', () => {
        const v = userMenuVoiceModeration({
            userId: MEMBER, channels, canMoveVoiceMembers: true,
            rosterOf: rosters({ [text.id]: [MEMBER] }),
        });
        expect(v.voiceChannel).toBeNull();
        expect(v.canMoveMembers).toBe(false);
    });

    it('member parked in AFK: disconnect stays possible, no destinations', () => {
        const v = userMenuVoiceModeration({
            userId: MEMBER, channels, canMoveVoiceMembers: true,
            rosterOf: rosters({ [afk.id]: [MEMBER] }),
        });
        expect(v.canMoveMembers).toBe(true);
        expect(v.voiceChannel?.id).toBe(afk.id);
        expect(v.targets).toEqual([]);
    });
});
