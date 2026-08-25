import { describe, it, expect } from 'vitest';
import { VOICE_STATUS_PREFIX, buildVoiceStatus, parseVoiceStatus } from '../utils/voiceStatus';

describe('voiceStatus codec', () => {
    it('round-trips all three flags', () => {
        const s = buildVoiceStatus({ muted: true, deafened: false, buffering: true });
        expect(s.startsWith(VOICE_STATUS_PREFIX)).toBe(true);
        expect(parseVoiceStatus(s)).toEqual({ muted: true, deafened: false, buffering: true });
    });
    it('an OLD client payload (no buffering key) parses to buffering === false, never undefined', () => {
        const old = `${VOICE_STATUS_PREFIX}{"muted":true,"deafened":false}`;
        const p = parseVoiceStatus(old)!;
        expect(p.buffering).toBe(false);
        expect(p.muted).toBe(true);
        expect(Object.keys(p).sort()).toEqual(['buffering', 'deafened', 'muted']);
    });
    it('ignores unknown extra keys and non-boolean junk', () => {
        expect(parseVoiceStatus(`${VOICE_STATUS_PREFIX}{"muted":"yes","deafened":1,"buffering":"true","x":5}`)).toEqual({ muted: false, deafened: false, buffering: false });
    });
    it('returns null for non-status messages and malformed JSON', () => {
        expect(parseVoiceStatus('hello')).toBeNull();
        expect(parseVoiceStatus(`${VOICE_STATUS_PREFIX}{oops`)).toBeNull();
        expect(parseVoiceStatus(`${VOICE_STATUS_PREFIX}null`)).toBeNull();
    });
});
