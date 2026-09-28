/**
 * Receiver-side enforcement of the SPEAK permission, for BOTH transports.
 *
 * Mesh audio is peer-to-peer, so the server cannot stop a member's mic from
 * reaching anyone: the only place SPEAK can be enforced against a sender that
 * ignores it (an old or modified client) is the receiver. The server is the
 * AUTHORITY — it tells every occupant of a voice room each member's right
 * (`VoiceSpeakState`: a full replay on join, then every change) — and this
 * gate decides, per remote user, whether the voice stream the transport
 * delivered may be PLAYED.
 *
 * The same gate sits in front of the SFU's mic streams: LiveKit already
 * refuses a mic publication from a token without SPEAK, but a token is minted
 * once per join, so a mid-call revoke is enforced here too.
 *
 * Unknown users are ALLOWED: a server that predates the frame never sends it,
 * and silencing everyone on an old server would break every call. A member
 * the server flags false is held from then on; a stream that was already
 * playing is retracted (the caller detaches it) and remembered, so a later
 * grant can play it again without a renegotiation — the SFU never re-fires
 * TrackSubscribed for a surviving session.
 */
export type SpeakAction = 'deliver' | 'retract' | 'none';

export class SpeakGate {
    private denied = new Set<number>();
    private streams = new Map<number, MediaStream>();
    private delivered = new Set<number>();

    /** A voice stream from `userId` arrived. true = play it now; false = hold it. */
    admit(userId: number, stream: MediaStream): boolean {
        this.streams.set(userId, stream);
        if (this.denied.has(userId)) {
            this.delivered.delete(userId);
            return false;
        }
        this.delivered.add(userId);
        return true;
    }

    /**
     * The server said whether `userId` may speak. 'retract' = a stream of
     * theirs is playing and must be detached now; 'deliver' = a held stream
     * may play now (get it with {@link stream}); 'none' = nothing to do.
     */
    set(userId: number, canSpeak: boolean): SpeakAction {
        if (canSpeak) {
            this.denied.delete(userId);
            if (this.streams.has(userId) && !this.delivered.has(userId)) {
                this.delivered.add(userId);
                return 'deliver';
            }
            return 'none';
        }
        this.denied.add(userId);
        return this.delivered.delete(userId) ? 'retract' : 'none';
    }

    /** The latest voice stream seen from `userId`, delivered or held. */
    stream(userId: number): MediaStream | undefined {
        return this.streams.get(userId);
    }

    isDenied(userId: number): boolean {
        return this.denied.has(userId);
    }

    /** The user left the room: their next join starts from the server's word. */
    forget(userId: number): void {
        this.denied.delete(userId);
        this.streams.delete(userId);
        this.delivered.delete(userId);
    }

    /** Leaving (or re-joining) the call. */
    reset(): void {
        this.denied.clear();
        this.streams.clear();
        this.delivered.clear();
    }
}

/** A `VoiceSpeakState` frame's payload, or null when it is not one. */
export interface VoiceSpeakState {
    room_id: string;
    user_id: number;
    can_speak: boolean;
}

/** Parse the server's `VoiceSpeakState` (src/protocol.rs). Strict: a frame
 *  missing a field or carrying the wrong type is ignored rather than guessed
 *  at — guessing `can_speak` either way is worse than not acting. */
export function parseVoiceSpeakState(msg: { type?: unknown; payload?: unknown }): VoiceSpeakState | null {
    if (msg?.type !== 'VoiceSpeakState') return null;
    const p = msg.payload as Partial<VoiceSpeakState> | null | undefined;
    if (!p || typeof p.room_id !== 'string' || typeof p.user_id !== 'number'
        || !Number.isInteger(p.user_id) || typeof p.can_speak !== 'boolean') return null;
    return { room_id: p.room_id, user_id: p.user_id, can_speak: p.can_speak };
}
