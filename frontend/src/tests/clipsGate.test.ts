import { describe, it, expect } from 'vitest';
import { clipUiState, clipReasonCopy, MIN_CLIP_SECONDS, type ClipUiInput } from '../api/clips/clipsGate';
import { PERM } from '../api/permissionBits';

const ok: ClipUiInput = {
    isDesktop: true, inVoice: true, isAfkChannel: false, listenOnly: false,
    serverClipsEnabled: true, voiceChannelPerms: PERM.VIEW_CHANNEL | PERM.CREATE_CLIPS,
    experimentalOn: true, armed: false, bufferedSeconds: 0, localOnly: false,
};

describe('clipsGate', () => {
    it('all-good renders, arm enabled, clip disabled until armed (positive control)', () => {
        const s = clipUiState(ok);
        expect(s).toEqual({ visible: true, armEnabled: true, clipEnabled: false, reason: null, noMic: false });
        expect(clipUiState({ ...ok, armed: true, bufferedSeconds: 30 }).clipEnabled).toBe(true);
    });
    it('hidden off desktop, when the flag is off, and on an old server', () => {
        expect(clipUiState({ ...ok, isDesktop: false })).toMatchObject({ visible: false, reason: 'not-desktop' });
        expect(clipUiState({ ...ok, experimentalOn: false })).toMatchObject({ visible: false, reason: 'flag-off' });
        expect(clipUiState({ ...ok, serverClipsEnabled: undefined })).toMatchObject({ visible: false, reason: 'old-server' });
    });
    it('localOnly (Phase 1) ignores the server fields entirely', () => {
        expect(clipUiState({ ...ok, localOnly: true, serverClipsEnabled: undefined, voiceChannelPerms: 0 })).toMatchObject({ visible: true, armEnabled: true, reason: null });
    });
    it('server-off and no-permission render disabled with their reasons', () => {
        expect(clipUiState({ ...ok, serverClipsEnabled: false })).toMatchObject({ visible: true, armEnabled: false, reason: 'server-off' });
        expect(clipUiState({ ...ok, voiceChannelPerms: PERM.VIEW_CHANNEL })).toMatchObject({ visible: true, armEnabled: false, reason: 'no-permission' });
        // pre-migration server (null perms) is allowed, matching hasPerm's contract
        expect(clipUiState({ ...ok, voiceChannelPerms: null }).armEnabled).toBe(true);
    });
    it('not in voice / AFK channel are disabled', () => {
        expect(clipUiState({ ...ok, inVoice: false })).toMatchObject({ armEnabled: false, reason: 'not-in-voice' });
        expect(clipUiState({ ...ok, isAfkChannel: true })).toMatchObject({ armEnabled: false, reason: 'afk-channel' });
    });
    it('listen-only is ALLOWED, with the no-mic note', () => {
        const s = clipUiState({ ...ok, listenOnly: true });
        expect(s.armEnabled).toBe(true);
        expect(s.noMic).toBe(true);
    });
    it('too short a buffer disables Clip but not Arm', () => {
        const s = clipUiState({ ...ok, armed: true, bufferedSeconds: MIN_CLIP_SECONDS - 1 });
        expect(s).toMatchObject({ visible: true, armEnabled: true, clipEnabled: false, reason: 'buffer-too-short' });
        expect(clipUiState({ ...ok, armed: true, bufferedSeconds: MIN_CLIP_SECONDS }).clipEnabled).toBe(true);
    });
    it('every reason has copy', () => {
        for (const r of ['not-desktop', 'flag-off', 'old-server', 'server-off', 'no-permission', 'afk-channel', 'not-in-voice', 'buffer-too-short'] as const) {
            expect(clipReasonCopy(r).length).toBeGreaterThan(10);
        }
        expect(clipReasonCopy(null)).toBe('');
    });
});
