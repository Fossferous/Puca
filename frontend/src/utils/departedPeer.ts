/**
 * Departed-peer teardown decision (the client half of r2-3-L3-01).
 *
 * Lives outside VoicePanel.tsx because `react-refresh/only-export-components`
 * is a required gate: a .tsx file may export nothing but components.
 */
/** The room-departure event a teardown decision is made for: StreamStopped
 *  (streamer_id) or UserLeft (user_id), normalised to one shape. */
export interface DepartedPeerEvent {
    roomId: string;
    userId: number;
}

/** What the deciding client knows about itself at that moment. */
export interface DepartedPeerContext {
    roomId: string;
    currentUserId: number;
    /** isInVoiceRef — no mesh peer can exist before it flips true. */
    inVoice: boolean;
    sfuMode: boolean;
    /** sfuManager.hasParticipant(userId): their LiveKit session is
     *  demonstrably still alive despite the event. */
    sfuSessionAlive: boolean;
}

/**
 * Whether a departure event for `userId` must close our mesh peer to them
 * (and drop their audio element). ONE predicate for both StreamStopped and
 * UserLeft, because a departure can arrive as either alone: a clean LeaveRoom
 * carries no StreamStopped (the stock client sends StopStream first; nothing
 * makes a raw client do so), and once a member has left the room no eviction
 * can reach them. Mesh media is peer-to-peer under a PAIRWISE key, so until
 * the pc is closed the leaver keeps receiving everyone's microphone while on
 * no roster at all. Pure and exported so the decision is unit-testable —
 * VoicePanel itself is not mountable under vitest.
 *
 * Refusals, in order:
 * - another room: not ours to touch;
 * - ourselves: RoomLeft / leaveVoice own self-teardown;
 * - not in voice: there is no peer, and nothing to build one;
 * - an SFU peer whose LiveKit session survives (a WS blip on THEIR side): the
 *   SFU audio element is only ever created on TrackSubscribed, which never
 *   re-fires for a surviving session, so removing it silenced them for good.
 */
export function shouldTearDownDepartedPeer(ev: DepartedPeerEvent, ctx: DepartedPeerContext): boolean {
    if (ev.roomId !== ctx.roomId) return false;
    if (ev.userId === ctx.currentUserId) return false;
    if (!ctx.inVoice) return false;
    if (ctx.sfuMode && ctx.sfuSessionAlive) return false;
    return true;
}
