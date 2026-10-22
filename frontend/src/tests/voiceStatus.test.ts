import { describe, it, expect } from 'vitest';
import { VOICE_STATUS_PREFIX, buildVoiceStatus, parseVoiceStatus } from '../utils/voiceStatus';

describe('voiceStatus codec', () => {
    it('round-trips all four flags', () => {
        const s = buildVoiceStatus({ muted: true, selfMuted: false, deafened: false, buffering: true, noMic: false });
        expect(s.startsWith(VOICE_STATUS_PREFIX)).toBe(true);
        expect(parseVoiceStatus(s)).toEqual({ muted: true, deafened: false, buffering: true, noMic: false });
    });
    it("carries the member's own choice for the server (src/ws.rs voice_status_flags reads `selfMuted`)", () => {
        const body = JSON.parse(buildVoiceStatus({ muted: true, selfMuted: false, deafened: false, buffering: false, noMic: false }).slice(VOICE_STATUS_PREFIX.length));
        expect(body).toEqual({ muted: true, selfMuted: false, deafened: false, buffering: false, noMic: false });
    });
    it('carries "no microphone" apart from "muted" (docs/STREAM_ONLY.md)', () => {
        const p = parseVoiceStatus(buildVoiceStatus({ muted: true, selfMuted: false, deafened: false, buffering: false, noMic: true }))!;
        expect(p.noMic).toBe(true);
        expect(p.muted).toBe(true);
        // Negative control: a muted member WITH a microphone is not "no mic".
        expect(parseVoiceStatus(buildVoiceStatus({ muted: true, selfMuted: true, deafened: false, buffering: false, noMic: false }))!.noMic).toBe(false);
    });
    it('an OLD client payload (no buffering or noMic key) parses to false, never undefined', () => {
        const old = `${VOICE_STATUS_PREFIX}{"muted":true,"deafened":false}`;
        const p = parseVoiceStatus(old)!;
        expect(p.buffering).toBe(false);
        expect(p.noMic).toBe(false);
        expect(p.muted).toBe(true);
        expect(Object.keys(p).sort()).toEqual(['buffering', 'deafened', 'muted', 'noMic']);
    });
    it('ignores unknown extra keys and non-boolean junk', () => {
        expect(parseVoiceStatus(`${VOICE_STATUS_PREFIX}{"muted":"yes","deafened":1,"buffering":"true","noMic":"true","x":5}`)).toEqual({ muted: false, deafened: false, buffering: false, noMic: false });
    });
    it('returns null for non-status messages and malformed JSON', () => {
        expect(parseVoiceStatus('hello')).toBeNull();
        expect(parseVoiceStatus(`${VOICE_STATUS_PREFIX}{oops`)).toBeNull();
        expect(parseVoiceStatus(`${VOICE_STATUS_PREFIX}null`)).toBeNull();
    });
});
