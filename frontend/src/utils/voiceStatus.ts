/**
 * The in-band voice status ping — `__VOICE_STATUS__{json}` sent as a room chat
 * message (VoicePanel.tsx broadcastStatus / handleChatMessage). It carries the
 * per-user flags the roster shows: muted, deafened, and — since Clips — whether
 * the user has a replay buffer ARMED (the last few minutes of the call are being
 * held in memory on their machine).
 *
 * Extracted from VoicePanel so the codec is testable and so an OLD client's
 * payload ({muted, deafened} only) provably parses to `buffering: false`, never
 * `undefined` — a roster row must not render against a tri-state.
 */
export const VOICE_STATUS_PREFIX = '__VOICE_STATUS__';

export interface VoiceStatus {
    muted: boolean;
    deafened: boolean;
    /** Replay buffer armed on that user's machine (advisory — a cooperating
     *  client asserts it; the approval gate is the real guarantee). */
    buffering: boolean;
}

export function buildVoiceStatus(s: VoiceStatus): string {
    return VOICE_STATUS_PREFIX + JSON.stringify({ muted: s.muted, deafened: s.deafened, buffering: s.buffering });
}

/** Returns null when `content` is not a status ping. */
export function parseVoiceStatus(content: string): VoiceStatus | null {
    if (typeof content !== 'string' || !content.startsWith(VOICE_STATUS_PREFIX)) return null;
    try {
        const o = JSON.parse(content.slice(VOICE_STATUS_PREFIX.length)) as Record<string, unknown>;
        if (!o || typeof o !== 'object') return null;
        return { muted: o.muted === true, deafened: o.deafened === true, buffering: o.buffering === true };
    } catch {
        return null;
    }
}
