/**
 * Can anybody hear this microphone right now? ONE pure function over every
 * input that decides it. dfPause.ts gathers the inputs from the call and
 * applies the answer; deepFilter.ts / dfWorklet.js do the pausing.
 *
 * Why it exists (2026-10-04): DeepFilter's model costs about a fifth of a CPU
 * core on every 10 ms hop, and it ran for the whole call whether or not
 * anyone could hear the result. When nobody can, the RNNoise bridge that
 * already covers a CPU spike carries the mic instead, and the Worker sleeps.
 *
 * THE RULE: pause only when nobody can hear, and only when every input that
 * says so is KNOWN. A wrongly paused DeepFilter means the room hears RNNoise
 * (the same suppressor a CPU spike already swaps in, never silence); a wrongly
 * running one only costs CPU. So an unknown input always means "someone can
 * hear", and the caller resumes at once but pauses only after a hold.
 *
 * The conditions, and why each is safe:
 *  - mic-closed: the published track is disabled (track.enabled = false), so
 *    every receiver gets silence whatever the graph emits. That one gate is
 *    muted, push-to-talk not held, push-to-mute held, deafened (deafen mutes
 *    the mic in Púca: VoicePanel's toggleDeafen) and an AFK channel - every
 *    path that gates the mic goes through WebRTCManager.setAudioEnabled.
 *  - alone: nobody else is in the roster AND no media connection to anyone
 *    exists. Both, because each can lag the other: the WS roster drops an SFU
 *    peer on a socket blip while their LiveKit session (and their hearing)
 *    lives on, and a mesh peer connection can exist before the roster row.
 *    Our own OTHER device in the same call counts as someone (it has a media
 *    connection), and so does any spectator or listen-only member.
 *  - all-deafened: everyone who could hear is a roster member whose last
 *    status said deafened. Deafen mutes every voice <audio> element on their
 *    side, mesh and SFU alike (VoicePanel attachVoice / toggleDeafen). A media
 *    peer with no roster row, our own other device (the roster has one row
 *    per USER), and anyone whose status we never received (the roster seeds
 *    isDeafened=false) all count as hearing.
 *
 * NOT conditions: listeners exist (they hear); other people's private
 * per-user mute or volume (not knowable, and private); silence (DeepFilter
 * must already be running when speech starts); SPEAK withdrawn (the mic and
 * its whole graph are closed then - MediaManager.releaseMic - so there is
 * nothing left to pause).
 */

export type DfPauseReason = 'mic-closed' | 'alone' | 'all-deafened';

export interface DfPauseInputs {
    /** The mic gate on the published track: false when muted / push-to-talk
     *  not held / push-to-mute held / deafened / in an AFK channel. null = not
     *  known yet (nothing has gated it since the call started). */
    micOpen: boolean | null;
    /** This client's user id. */
    selfId: number;
    /** The call's roster (one row per user, self included); null = none
     *  loaded for this room. */
    roster: ReadonlyArray<{ id: number; isDeafened: boolean }> | null;
    /** The signalling socket is up. While it is down the roster may be
     *  missing whoever joined meanwhile, and status pings are not arriving. */
    socketUp: boolean;
    /** User ids with a media connection to us right now: mesh peer
     *  connections (any state) and SFU participants (our own id included when
     *  it is our other device). null = unknown: an SFU call that is not
     *  connected, or is reconnecting. */
    transportPeers: ReadonlyArray<number> | null;
}

export interface DfPauseDecision {
    paused: boolean;
    /** Every condition that holds right now (empty when not paused). */
    reasons: DfPauseReason[];
}

export function decideDfPause(i: DfPauseInputs): DfPauseDecision {
    const reasons: DfPauseReason[] = [];
    if (i.micOpen === false) reasons.push('mic-closed');

    // Who could hear. Only judged on a roster that is this call's (it has our
    // own row: written at join, so a roster read before then is not ours),
    // over a live socket, with a known transport.
    const rosterKnown = i.roster !== null && i.roster.some(u => u.id === i.selfId);
    if (rosterKnown && i.socketUp && i.transportPeers !== null) {
        const roster = new Map(i.roster!.map(u => [u.id, u]));
        const listeners = new Set<number>();
        for (const u of i.roster!) if (u.id !== i.selfId) listeners.add(u.id);
        for (const id of i.transportPeers) listeners.add(id);
        if (listeners.size === 0) {
            reasons.push('alone');
        } else if ([...listeners].every(id => id !== i.selfId && roster.get(id)?.isDeafened === true)) {
            reasons.push('all-deafened');
        }
    }
    return { paused: reasons.length > 0, reasons };
}
