import { describe, it, expect } from 'vitest';
import { canMoveVoiceMember, MOVE_AFTER_CUT_MS, movedOutOfHere, voiceMoveTargets, type VoiceMoveChannel } from '../utils/voiceMove';

const ch = (id: number, opts: Partial<VoiceMoveChannel> = {}): VoiceMoveChannel => ({
    id,
    name: `voice-${id}`,
    channel_type: 1,
    ...opts,
});

const general = ch(1);
const gaming = ch(2);
const afk = ch(9, { name: 'AFK', is_afk: true });
const textChannel = ch(5, { name: 'general-text', channel_type: 0 });

describe('canMoveVoiceMember', () => {
    // POSITIVE CONTROL. Every refusal below is a "must not happen" assertion,
    // and those are worthless without proof that this predicate can say yes at
    // all — a function that returned `{ok:false}` unconditionally would pass
    // every other test in this file.
    it('allows an ordinary move between two voice channels', () => {
        expect(canMoveVoiceMember(general, gaming)).toEqual({ ok: true });
    });

    it('allows moving somebody INTO the AFK channel', () => {
        // The direction that actually gets used: parking someone.
        expect(canMoveVoiceMember(general, afk)).toEqual({ ok: true });
    });

    it('refuses to move somebody OUT of the AFK channel', () => {
        const verdict = canMoveVoiceMember(afk, general);
        expect(verdict.ok).toBe(false);
        expect(verdict).toMatchObject({ reason: 'source-is-afk' });
    });

    it('refuses a move to the channel they are already in', () => {
        const verdict = canMoveVoiceMember(general, ch(1));
        expect(verdict.ok).toBe(false);
        expect(verdict).toMatchObject({ reason: 'same-channel' });
    });

    it('refuses a text channel as a destination', () => {
        const verdict = canMoveVoiceMember(general, textChannel);
        expect(verdict.ok).toBe(false);
        expect(verdict).toMatchObject({ reason: 'not-a-voice-channel' });
    });

    it('checks the destination type BEFORE same-channel, so a text channel is never "already in"', () => {
        // Both rules could fire; the message the user sees must name the real
        // problem rather than claim they are already sitting in a text channel.
        const verdict = canMoveVoiceMember(textChannel, ch(5, { channel_type: 0 }));
        expect(verdict).toMatchObject({ reason: 'not-a-voice-channel' });
    });

    it('leaves channel_type unchecked when the caller did not supply it', () => {
        // Callers that already filtered to voice channels pass partial rows.
        const verdict = canMoveVoiceMember({ id: 1, name: 'a' }, { id: 2, name: 'b' });
        expect(verdict).toEqual({ ok: true });
    });
});

describe('movedOutOfHere', () => {
    const NOW = 1_000_000;

    it('is about this device when it is in the channel', () => {
        expect(movedOutOfHere(7, 7, null, NOW)).toBe(true);
    });

    it('is not when this device is in no call, or in another', () => {
        expect(movedOutOfHere(7, null, null, NOW)).toBe(false);
        expect(movedOutOfHere(7, undefined, null, NOW)).toBe(false);
        expect(movedOutOfHere(7, 8, null, NOW)).toBe(false);
    });

    it('still is when LiveKit\'s removal got here first', () => {
        expect(movedOutOfHere(7, null, { channelId: 7, at: NOW - 200 }, NOW)).toBe(true);
    });

    it('not for a removal from another channel', () => {
        expect(movedOutOfHere(7, null, { channelId: 8, at: NOW - 200 }, NOW)).toBe(false);
    });

    it('not once the removal is old: a device that left long ago is not this call', () => {
        expect(movedOutOfHere(7, null, { channelId: 7, at: NOW - MOVE_AFTER_CUT_MS }, NOW)).toBe(false);
        expect(movedOutOfHere(7, null, { channelId: 7, at: NOW - MOVE_AFTER_CUT_MS + 1 }, NOW)).toBe(true);
    });

    it('not when the person has already gone somewhere else', () => {
        expect(movedOutOfHere(7, 9, { channelId: 7, at: NOW - 200 }, NOW)).toBe(false);
    });
});

describe('voiceMoveTargets', () => {
    const all = [general, gaming, afk, textChannel];

    it('offers the other voice channels, including AFK, and never the current one', () => {
        expect(voiceMoveTargets(all, general).map(c => c.id)).toEqual([2, 9]);
    });

    it('offers NOTHING for somebody sitting in AFK', () => {
        // The submenu must be absent rather than present-and-always-refused.
        expect(voiceMoveTargets(all, afk)).toEqual([]);
    });

    it('never offers a text channel', () => {
        expect(voiceMoveTargets(all, general).some(c => c.channel_type === 0)).toBe(false);
    });
});
