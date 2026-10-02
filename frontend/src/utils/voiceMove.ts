/**
 * Rules for moderator-driven voice moves, kept pure so both entry points — the
 * sidebar drag and the context menu's "Move to" list — decide identically, and
 * so the decision can be tested without a DOM.
 *
 * These mirror `moderation_handlers::move_member_voice`. The server is the
 * authority; this exists so the UI never offers a gesture the server will
 * refuse.
 */

/** The subset of `Channel` these rules need. */
export interface VoiceMoveChannel {
    id: number;
    name: string;
    /** 1 = voice. Anything else is not a destination. */
    channel_type?: number;
    is_afk?: boolean;
}

export type VoiceMoveRefusal =
    | 'same-channel'
    | 'source-is-afk'
    | 'not-a-voice-channel';

export type VoiceMoveVerdict =
    | { ok: true }
    | { ok: false; reason: VoiceMoveRefusal; message: string };

/**
 * May a member sitting in `from` be moved into `to`?
 *
 * Nobody is dragged OUT of the AFK channel. AFK is a holding pen people leave
 * under their own steam — anyone parked there can click any channel and walk
 * out — so this is deliberate policy about the MODERATOR's gesture, not a lock
 * on the member. Moving someone INTO AFK stays allowed, which is the direction
 * that gets used.
 */
export function canMoveVoiceMember(
    from: VoiceMoveChannel,
    to: VoiceMoveChannel,
): VoiceMoveVerdict {
    if (to.channel_type !== undefined && to.channel_type !== 1) {
        return {
            ok: false,
            reason: 'not-a-voice-channel',
            message: `${to.name} is not a voice channel.`,
        };
    }
    if (from.id === to.id) {
        return {
            ok: false,
            reason: 'same-channel',
            message: `They are already in ${to.name}.`,
        };
    }
    if (from.is_afk) {
        return {
            ok: false,
            reason: 'source-is-afk',
            message: 'Members can’t be moved out of the AFK channel — they leave it themselves.',
        };
    }
    return { ok: true };
}

/**
 * Voice channels a member currently in `from` may be moved to, for the "Move
 * to" submenu. Empty when they are in AFK — which is exactly the case that must
 * offer no destinations at all rather than a list that every click rejects.
 */
export function voiceMoveTargets<C extends VoiceMoveChannel>(
    channels: readonly C[],
    from: VoiceMoveChannel,
): C[] {
    return channels.filter(c => canMoveVoiceMember(from, c).ok);
}

/**
 * What the user context menu offers for voice moderation of `userId`, for
 * EVERY surface that opens it (member list, sidebar voice rows, stage tiles).
 *
 * The member is located in whichever voice channel of the server lists them,
 * not only the viewer's own call: a moderator who is not in voice, or sits in
 * another channel, can still move or disconnect someone (Discord does the
 * same). The member list used to find people only in the viewer's call, so it
 * offered neither action unless the moderator was sitting beside them.
 *
 * Deliberately independent of the viewer's own call. Whether the LOCAL
 * listener controls (per-user volume, mute, give screen control) show is a
 * separate question the caller answers; those act on what this device hears.
 *
 * A stale roster is harmless: the server re-checks MOVE_MEMBERS and refuses to
 * move someone who is no longer in voice.
 */
export function userMenuVoiceModeration<C extends VoiceMoveChannel>(opts: {
    userId: number;
    /** The channels of the server being viewed (any type; only voice is searched). */
    channels: readonly C[];
    /** Who is in a voice channel right now. */
    rosterOf: (channelId: number) => ReadonlyArray<{ id: number }>;
    /** The viewer holds MOVE_MEMBERS (or owns the server). */
    canMoveVoiceMembers: boolean;
}): { voiceChannel: C | null; canMoveMembers: boolean; targets: C[] } {
    const voiceChannel = opts.channels.find(c =>
        c.channel_type === 1 && opts.rosterOf(c.id).some(u => u.id === opts.userId)) ?? null;
    if (!voiceChannel) return { voiceChannel: null, canMoveMembers: false, targets: [] };
    return {
        voiceChannel,
        canMoveMembers: opts.canMoveVoiceMembers,
        targets: opts.canMoveVoiceMembers
            ? voiceMoveTargets(opts.channels.filter(c => c.channel_type === 1), voiceChannel)
            : [],
    };
}
