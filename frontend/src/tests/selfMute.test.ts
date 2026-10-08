/**
 * The member's mute and deafen transitions (api/rtc/selfMute.ts), and BURSTS
 * of them: presses handled one after another with no render in between.
 *
 * VoicePanel feeds every transition from its refs and writes the result back
 * before anything reads it again (pinned in muteIntent.test.ts), so a burst
 * is exactly these functions applied in order. The regression this exists
 * for: Toggle Deafen then Toggle Mute in one task (two desktop-global hotkey
 * events behind a busy main thread, a Stream Deck macro) left a deafened
 * member transmitting, because Toggle Mute read "deafened" from a render that
 * had not happened yet (e2e/mute-intent-live.mjs measured the listener
 * receiving their audio). The checker below is shown to catch exactly that
 * when it is handed the stale state.
 */
import { describe, it, expect } from 'vitest';
import {
    pressMute, pressDeafen, imposeMute, micBack, micOpen, UNMUTED,
    type SelfMute, type MuteConstraints, type VoiceInputMode,
} from '../api/rtc/selfMute';

const CALL: MuteConstraints = { afk: false, speakDenied: false, listenOnly: false };
const LISTEN_ONLY: MuteConstraints = { ...CALL, listenOnly: true };
const MUTED: SelfMute = { muted: true, selfMuted: true, deafened: false };

/** One press, as VoicePanel's handlers apply it. */
function press(s: SelfMute, key: 'M' | 'D', c: MuteConstraints): SelfMute {
    if (key === 'D') return pressDeafen(s);
    const p = pressMute(s, c);
    return p.kind === 'refused' ? s : p.next;
}

/** What may never hold, whatever the presses: a deafened or muted member
 *  transmitting, or deafened without being muted. */
function violations(s: SelfMute, c: MuteConstraints): string[] {
    const v: string[] = [];
    for (const mode of ['open', 'pushToTalk', 'pushToMute'] as VoiceInputMode[]) {
        for (const held of [false, true]) {
            if (micOpen(s, c, mode, held) && (s.deafened || s.muted)) v.push(`open while ${s.deafened ? 'deafened' : 'muted'} (${mode}, held=${held})`);
        }
    }
    if (s.deafened && !s.muted) v.push('deafened but not muted');
    if (s.deafened && !s.selfMuted) v.push('deafened but the member\'s own choice is unmuted');
    if (!c.listenOnly && !c.afk && !c.speakDenied && s.muted !== s.selfMuted) v.push('the mute in force differs from the member\'s choice with nothing imposed');
    return v;
}

/** A burst: every press from the state the previous one left, the
 *  invariants checked after EACH press. */
function burst(start: SelfMute, keys: string, c: MuteConstraints = CALL): SelfMute {
    let s = start;
    for (const [i, k] of [...keys].entries()) {
        s = press(s, k as 'M' | 'D', c);
        expect(violations(s, c), `after press ${i + 1} (${k}) of ${keys}`).toEqual([]);
    }
    return s;
}

describe('single presses', () => {
    it('Mute toggles the mute in force and the member\'s choice together; refused deafened, in AFK, without SPEAK', () => {
        expect(pressMute(UNMUTED, CALL)).toEqual({ kind: 'toggled', next: MUTED });
        expect(pressMute(MUTED, CALL)).toEqual({ kind: 'toggled', next: UNMUTED });
        expect(pressMute(pressDeafen(UNMUTED), CALL)).toEqual({ kind: 'refused', why: 'deafened' });
        expect(pressMute(UNMUTED, { ...CALL, afk: true })).toEqual({ kind: 'refused', why: 'afk' });
        expect(pressMute(UNMUTED, { ...CALL, speakDenied: true, listenOnly: true })).toEqual({ kind: 'refused', why: 'no-speak' });
    });

    it('with no microphone, Mute changes only how the member comes back', () => {
        const lost = imposeMute(UNMUTED);
        expect(lost).toEqual({ muted: true, selfMuted: false, deafened: false });
        const p = pressMute(lost, LISTEN_ONLY);
        expect(p).toEqual({ kind: 'choice', next: { muted: true, selfMuted: true, deafened: false } });
        expect(micBack(p.kind === 'choice' ? p.next : lost, CALL).muted).toBe(true);
        expect(micBack(lost, CALL).muted, 'control: not pressed, back live').toBe(false);
    });

    it('deafening mutes as the member\'s own choice; undeafening leaves the mute', () => {
        const d = pressDeafen(UNMUTED);
        expect(d).toEqual({ muted: true, selfMuted: true, deafened: true });
        expect(pressDeafen(d)).toEqual(MUTED);
        // Deafened while listen-only: back muted, and still deafened.
        expect(micBack(pressDeafen(imposeMute(UNMUTED)), CALL)).toEqual({ muted: true, selfMuted: true, deafened: true });
    });

    it('the microphone coming back restores the member\'s choice, except in an AFK channel', () => {
        expect(micBack(imposeMute(UNMUTED), CALL)).toEqual(UNMUTED);
        expect(micBack(imposeMute(MUTED), CALL)).toEqual(MUTED);
        expect(micBack(imposeMute(UNMUTED), { afk: true })).toEqual({ muted: true, selfMuted: false, deafened: false });
    });

    it('the gate: never deafened, muted, AFK, without SPEAK or with no microphone; push-to-talk only while held', () => {
        expect(micOpen(UNMUTED, CALL, 'open', false)).toBe(true);
        expect(micOpen(UNMUTED, CALL, 'pushToTalk', false)).toBe(false);
        expect(micOpen(UNMUTED, CALL, 'pushToTalk', true)).toBe(true);
        expect(micOpen(UNMUTED, CALL, 'pushToMute', true)).toBe(false);
        expect(micOpen(MUTED, CALL, 'pushToTalk', true)).toBe(false);
        // Deafened shuts even if the mute in force were somehow lifted.
        expect(micOpen({ muted: false, selfMuted: false, deafened: true }, CALL, 'open', false)).toBe(false);
        for (const c of [{ ...CALL, afk: true }, { ...CALL, speakDenied: true }, LISTEN_ONLY]) {
            expect(micOpen(UNMUTED, c, 'open', false)).toBe(false);
        }
    });
});

describe('bursts: presses with no render between them', () => {
    it('Toggle Deafen then Toggle Mute, from unmuted: deafened and shut (THE BUG)', () => {
        expect(burst(UNMUTED, 'DM')).toEqual({ muted: true, selfMuted: true, deafened: true });
    });
    it('Toggle Mute then Toggle Deafen, from unmuted: deafened and shut', () => {
        expect(burst(UNMUTED, 'MD')).toEqual({ muted: true, selfMuted: true, deafened: true });
    });
    it('both orders from muted: deafened and shut', () => {
        expect(burst(MUTED, 'DM')).toEqual({ muted: true, selfMuted: true, deafened: true });
        expect(burst(MUTED, 'MD')).toEqual({ muted: true, selfMuted: true, deafened: true });
    });
    it('longer alternations end in their known state', () => {
        expect(burst(UNMUTED, 'MDMDM'), 'muted, deafened, refused, undeafened (muted), unmuted').toEqual(UNMUTED);
        expect(burst(UNMUTED, 'DMDMD')).toEqual({ muted: true, selfMuted: true, deafened: true });
        expect(burst(UNMUTED, 'MMMMMMM'), 'an odd count of Mute').toEqual(MUTED);
        expect(burst(UNMUTED, 'MMMMMMMM'), 'an even count').toEqual(UNMUTED);
        expect(burst(UNMUTED, 'DDDDDD'), 'deafen leaves you muted').toEqual(MUTED);
        expect(burst(MUTED, 'DMMMMD'), 'every Mute while deafened is refused').toEqual(MUTED);
    });
    it('while there is no microphone: the presses decide how the member comes back', () => {
        const lost = imposeMute(UNMUTED);
        expect(micBack(burst(lost, 'DM', LISTEN_ONLY), CALL)).toEqual({ muted: true, selfMuted: true, deafened: true });
        expect(micBack(burst(lost, 'M', LISTEN_ONLY), CALL)).toEqual(MUTED);
        expect(micBack(burst(lost, 'MM', LISTEN_ONLY), CALL)).toEqual(UNMUTED);
        expect(micBack(burst(lost, 'DD', LISTEN_ONLY), CALL), 'deafen leaves you muted').toEqual(MUTED);
    });
    it('every sequence of up to 8 presses, from each start, keeps the invariants', () => {
        let sequences = 0;
        for (let n = 1; n <= 8; n++) {
            for (let bits = 0; bits < (1 << n); bits++) {
                const keys = [...Array(n)].map((_, i) => ((bits >> i) & 1 ? 'D' : 'M')).join('');
                for (const start of [UNMUTED, MUTED]) {
                    for (const c of [CALL, LISTEN_ONLY]) {
                        const end = burst(c.listenOnly ? imposeMute(start) : start, keys, c);
                        expect(violations(c.listenOnly ? micBack(end, CALL) : end, CALL), keys).toEqual([]);
                        sequences++;
                    }
                }
            }
        }
        expect(sequences).toBe(2 * 2 * (2 ** 9 - 2));
    });
    it('control: handed the STALE state (deafened read from before the deafen), the checker sees the bug', () => {
        const afterDeafen = pressDeafen(UNMUTED);
        // What the old Toggle Mute did: the mute in force from the ref, the
        // deafen from a closure a render behind.
        const stale = pressMute({ ...afterDeafen, deafened: false }, CALL);
        expect(stale.kind).toBe('toggled');
        const leaked = { ...(stale.kind === 'toggled' ? stale.next : afterDeafen), deafened: true };
        expect(micOpen(leaked, CALL, 'open', false)).toBe(false); // micOpen itself still refuses deafened...
        expect(violations(leaked, CALL)).toContain('deafened but not muted'); // ...and the state is caught
    });
});
