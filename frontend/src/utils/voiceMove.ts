/**
 * Rules for moderator-driven voice moves, kept pure so both entry points — the
 * sidebar drag and the context menu's "Move to" list — decide identically, and
 * so the decision can be tested without a DOM.
 *
 * These mirror `moderation_handlers::move_member_voice`. The server is the
 * authority; this exists so the UI never offers a gesture the server will
 * refuse.
 */

/** How long after the server cut this device's LiveKit session a VoiceMoved for that channel is still about this device. */
export const MOVE_AFTER_CUT_MS = 3000;

/** The channel the server last cut this device's LiveKit session in, and when. */
export interface SfuCut {
    channelId: number;
    at: number;
}

/**
 * Is a VoiceMoved out of `from` about the call on this device? It goes to every device of
 * the account, so being in that channel is the test. An SFU call adds one case: the server
 * sends the directive before it cuts the session, but on another socket, and nothing orders
 * the two on arrival. LiveKit's removal can get here first and end the call, and dropping
 * the directive then would leave someone out of voice who was only being moved.
 */
export function movedOutOfHere(
    from: number,
    inCallId: number | null | undefined,
    cut: SfuCut | null,
    now: number,
): boolean {
    if (inCallId === from) return true;
    return inCallId == null && cut?.channelId === from && now - cut.at < MOVE_AFTER_CUT_MS;
}

/**
 * What is left of the note once a RoomLeft for `roomId` has arrived. A move never sends one
 * (ws::SelfNotice), so that removal was not a move, and the note must not turn a later
 * VoiceMoved into pulling a device out of no call into the next one, unattended.
 */
export function cutAfterRoomLeft(cut: SfuCut | null, roomId: string): SfuCut | null {
    return cut && roomId === `voice_${cut.channelId}` ? null : cut;
}

/**
 * Does a notification, a toast or a navigation target open this channel the way a click does?
 * Not a voice channel: a click there joins the call with the microphone open, and a target
 * need not come from a person. Android's main activity is exported, so any app on the phone can
 * start it with `sovereign_nav=channel:<server>:<channel>`. Opening never joins.
 */
export function opensFromNav(channel: { channel_type?: number }): boolean {
    return channel.channel_type !== 1;
}

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
    /** Does the channel list show this channel? A menu offers what a drag could reach,
     *  and a drag reaches only rendered rows. Who is where is still searched in all. */
    isListed?: (channel: C) => boolean;
}): { voiceChannel: C | null; canMoveMembers: boolean; targets: C[] } {
    const voiceChannel = opts.channels.find(c =>
        c.channel_type === 1 && opts.rosterOf(c.id).some(u => u.id === opts.userId)) ?? null;
    if (!voiceChannel) return { voiceChannel: null, canMoveMembers: false, targets: [] };
    return {
        voiceChannel,
        canMoveMembers: opts.canMoveVoiceMembers,
        targets: opts.canMoveVoiceMembers
            ? voiceMoveTargets(opts.channels.filter(c => c.channel_type === 1 && (opts.isListed?.(c) ?? true)), voiceChannel)
            : [],
    };
}
