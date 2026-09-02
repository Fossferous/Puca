import { describe, it, expect } from 'vitest';
import { clipUiState, clipReasonCopy, MIN_CLIP_SECONDS, type ClipUiInput } from '../api/clips/clipsGate';
import { PERM } from '../api/permissionBits';

const ok: ClipUiInput = {
    isDesktop: true, inVoice: true, isAfkChannel: false, listenOnly: false,
    serverClipsEnabled: true, viewerIsOwner: false, voiceChannelPerms: PERM.VIEW_CHANNEL | PERM.CREATE_CLIPS,
    armed: false, bufferedSeconds: 0,
};

describe('clipsGate', () => {
    it('all-good renders, arm enabled, clip disabled until armed (positive control)', () => {
        const s = clipUiState(ok);
        expect(s).toEqual({ visible: true, armEnabled: true, clipEnabled: false, reason: null, noMic: false });
        expect(clipUiState({ ...ok, armed: true, bufferedSeconds: 30 }).clipEnabled).toBe(true);
    });
    it('hidden off desktop and on an old server', () => {
        expect(clipUiState({ ...ok, isDesktop: false })).toMatchObject({ visible: false, reason: 'not-desktop' });
        expect(clipUiState({ ...ok, serverClipsEnabled: undefined })).toMatchObject({ visible: false, reason: 'old-server' });
    });
    it('Phase 3: no experimental flag — the input has no such field', () => {
        expect('experimentalOn' in ok).toBe(false);
        expect('localOnly' in ok).toBe(false);
    });
    it('server-off: hidden for a member (nothing they can do), disabled with the reason for the owner', () => {
        expect(clipUiState({ ...ok, serverClipsEnabled: false })).toMatchObject({ visible: false, reason: 'server-off' });
        expect(clipUiState({ ...ok, serverClipsEnabled: false, viewerIsOwner: true })).toMatchObject({ visible: true, armEnabled: false, reason: 'server-off' });
    });
    it('no-permission renders disabled with its reason', () => {
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
        for (const r of ['not-desktop', 'old-server', 'server-off', 'no-permission', 'afk-channel', 'not-in-voice', 'buffer-too-short'] as const) {
            expect(clipReasonCopy(r).length).toBeGreaterThan(10);
        }
        expect(clipReasonCopy(null)).toBe('');
    });
});
