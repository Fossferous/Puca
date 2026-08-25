import { describe, it, expect } from 'vitest';
import { canMoveVoiceMember, voiceMoveTargets, type VoiceMoveChannel } from '../utils/voiceMove';

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
