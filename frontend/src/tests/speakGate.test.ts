/**
 * Receiver-side SPEAK enforcement (api/rtc/speakGate.ts) and the wire frame it
 * acts on.
 *
 * Mesh audio is peer-to-peer: a member denied Speak whose client ignores the
 * rule (an old or modified build) still sends their mic to every peer. The
 * receiver is the only place that can refuse it. Reproduced live on
 * 2026-09-28 (frontend/e2e/speak-perms-live.mjs, TRANSPORT=mesh): the owner
 * played the denied member's audio at full level.
 */
import { describe, it, expect } from 'vitest';
import fixture from './fixtures/voiceSpeakState.json';
import { SpeakGate, parseVoiceSpeakState } from '../api/rtc/speakGate';

const stream = (id: string) => ({ id }) as unknown as MediaStream;

describe('SpeakGate', () => {
    it('POSITIVE CONTROL: plays a member the server never flagged (older servers send nothing)', () => {
        const g = new SpeakGate();
        expect(g.admit(3, stream('a'))).toBe(true);
    });

    it('holds a member flagged before their stream arrives, and never plays it', () => {
        const g = new SpeakGate();
        expect(g.set(3, false)).toBe('none');
        expect(g.admit(3, stream('a'))).toBe(false);
        expect(g.admit(3, stream('b')), 'a renegotiated stream is held too').toBe(false);
    });

    it('retracts a member already playing when Speak is withdrawn mid-call', () => {
        const g = new SpeakGate();
        g.admit(3, stream('a'));
        expect(g.set(3, false)).toBe('retract');
        expect(g.set(3, false), 'only once').toBe('none');
    });

    it('re-delivers the held stream on a grant, exactly once', () => {
        const g = new SpeakGate();
        g.set(3, false);
        g.admit(3, stream('a'));
        expect(g.set(3, true)).toBe('deliver');
        expect(g.stream(3)).toEqual({ id: 'a' });
        expect(g.set(3, true)).toBe('none');
    });

    it('a grant with no stream yet has nothing to deliver; the stream then plays', () => {
        const g = new SpeakGate();
        g.set(3, false);
        expect(g.set(3, true)).toBe('none');
        expect(g.admit(3, stream('a'))).toBe(true);
    });

    it('is per member: denying one leaves the others playing', () => {
        const g = new SpeakGate();
        g.set(3, false);
        expect(g.admit(4, stream('c'))).toBe(true);
        expect(g.admit(3, stream('a'))).toBe(false);
    });

    it('forget and reset drop everything (a re-join starts from the server\'s word)', () => {
        const g = new SpeakGate();
        g.set(3, false);
        g.forget(3);
        expect(g.admit(3, stream('a'))).toBe(true);
        g.set(4, false);
        g.reset();
        expect(g.isDenied(4)).toBe(false);
    });
});

describe('parseVoiceSpeakState', () => {
    it('reads the exact frame the server serialises (src/protocol.rs pins the same fixture)', () => {
        expect(parseVoiceSpeakState(fixture)).toEqual({ room_id: 'voice_42', user_id: 7, can_speak: false });
    });

    it('ignores anything else rather than guessing can_speak', () => {
        expect(parseVoiceSpeakState({ type: 'CameraStarted', payload: fixture.payload })).toBeNull();
        expect(parseVoiceSpeakState({ type: 'VoiceSpeakState', payload: { ...fixture.payload, can_speak: 'false' } })).toBeNull();
        expect(parseVoiceSpeakState({ type: 'VoiceSpeakState', payload: { ...fixture.payload, user_id: '7' } })).toBeNull();
        expect(parseVoiceSpeakState({ type: 'VoiceSpeakState', payload: { room_id: 'voice_42', user_id: 7 } })).toBeNull();
        expect(parseVoiceSpeakState({ type: 'VoiceSpeakState' })).toBeNull();
    });
});
