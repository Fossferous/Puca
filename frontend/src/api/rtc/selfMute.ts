/**
 * The member's own mute and deafen, and the mutes a call imposes on them -
 * every transition VoicePanel makes, as pure functions of the state BEFORE it.
 *
 * WHY PURE, AND WHY "THE STATE BEFORE IT". VoicePanel keeps this state in
 * refs and mirrors it into React state for the render. Its handlers used to
 * read some of it from the render's closure, which lags a render behind: two
 * presses handled before React re-rendered (two desktop-global hotkey events
 * queued behind a busy main thread, a Stream Deck macro) each saw the state
 * from before the FIRST one. Toggle Deafen then Toggle Mute in one task left
 * a deafened member transmitting, unmuted, with nobody told (measured live:
 * the listener received audio energy 0.80 on mesh, 0.93 on SFU). Here every
 * transition takes the current state as an argument and returns the next
 * one, and the panel feeds it from the refs and writes the result back to
 * the refs before anything reads them again - so a burst of presses is just
 * these functions applied in order (selfMute.test.ts).
 *
 * THE RULES.
 *   - `muted` is the mute IN FORCE: what the button shows, what the room is
 *     told, and what shuts the mic. `selfMuted` is the member's OWN choice,
 *     what Mute/Unmute last set; deafening sets it too, and undeafening leaves
 *     it (deafen has always left you muted).
 *   - The call imposes mutes the member did not choose: no microphone
 *     (listen-only), no SPEAK, an AFK channel. Imposing one never touches the
 *     member's choice, and lifting listen-only restores it - never a constant
 *     "unmuted" (a member who had muted came back live when the microphone
 *     returned).
 *   - Deafened never transmits; muted never transmits; push-to-talk opens
 *     only while held, push-to-mute shuts while held.
 */

export interface SelfMute {
    /** The mute in force: the member's own, or one the call imposes. */
    muted: boolean;
    /** The member's own choice: what Mute/Unmute (or deafening) last set. */
    selfMuted: boolean;
    deafened: boolean;
}

/** What the call imposes right now. */
export interface MuteConstraints {
    /** An AFK channel: talk-disabled. */
    afk: boolean;
    /** No SPEAK in this channel: no microphone for the whole call. */
    speakDenied: boolean;
    /** No microphone open: none was found, it died, or no SPEAK. */
    listenOnly: boolean;
}

export type VoiceInputMode = 'open' | 'pushToTalk' | 'pushToMute';

export const UNMUTED: SelfMute = { muted: false, selfMuted: false, deafened: false };

export type MutePress =
    /** Nothing changes. `deafened` is said out loud (a silent hotkey no-op
     *  reads as a broken hotkey); the others have their own on-screen copy. */
    | { kind: 'refused'; why: 'afk' | 'no-speak' | 'deafened' }
    /** No microphone: only how the member comes back changes. Nothing to
     *  gate, and the room already sees them muted. */
    | { kind: 'choice'; next: SelfMute }
    /** The mute in force changed: gate the mic and tell the room. */
    | { kind: 'toggled'; next: SelfMute };

/** Mute / Unmute: the button, Toggle Mute in the app, or from other apps. */
export function pressMute(s: SelfMute, c: MuteConstraints): MutePress {
    if (c.afk) return { kind: 'refused', why: 'afk' };
    if (c.speakDenied) return { kind: 'refused', why: 'no-speak' };
    if (s.deafened) return { kind: 'refused', why: 'deafened' };
    if (c.listenOnly) return { kind: 'choice', next: { ...s, selfMuted: !s.selfMuted } };
    const muted = !s.muted;
    return { kind: 'toggled', next: { muted, selfMuted: muted, deafened: false } };
}

/** Deafen / Undeafen. Deafening mutes, as the member's own choice; undeafening
 *  leaves the mute as it is. Allowed everywhere (AFK, listen-only, no SPEAK):
 *  it only ever shuts. */
export function pressDeafen(s: SelfMute): SelfMute {
    if (!s.deafened) return { muted: true, selfMuted: true, deafened: true };
    return { ...s, deafened: false };
}

/** The call imposes a mute (no microphone, no SPEAK, an AFK channel). */
export function imposeMute(s: SelfMute): SelfMute {
    return { ...s, muted: true };
}

/** The microphone is back after listen-only: what the member chose, unless
 *  another imposed mute still holds (an AFK channel). */
export function micBack(s: SelfMute, c: Pick<MuteConstraints, 'afk'>): SelfMute {
    return { ...s, muted: s.selfMuted || s.deafened || c.afk };
}

/** May the microphone transmit right now? */
export function micOpen(s: SelfMute, c: MuteConstraints, mode: VoiceInputMode, holdKeyDown: boolean): boolean {
    if (s.muted || s.deafened || c.afk || c.speakDenied || c.listenOnly) return false;
    if (mode === 'pushToTalk') return holdKeyDown;
    if (mode === 'pushToMute') return !holdKeyDown;
    return true;
}
