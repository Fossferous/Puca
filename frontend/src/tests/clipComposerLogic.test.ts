import { describe, it, expect } from 'vitest';
import { durationChips, CHIP_SECONDS } from '../api/clips/clipComposerLogic';
import { MIN_CLIP_SECONDS } from '../api/clips/clipsGate';

describe('clip composer — duration chips', () => {
    it('server cap bounds the chips even when far more is buffered (red if the cap is ignored → the server would 400)', () => {
        expect(durationChips(60, 300)).toEqual([30, 60]);
        expect(durationChips(120, 300)).toEqual([30, 60, 120]);
    });
    it('the buffered length bounds the chips and adds a "max" chip when it is not a standard step', () => {
        expect(durationChips(600, 12)).toEqual([12]);
        expect(durationChips(600, 90)).toEqual([30, 60, 90]);
        expect(durationChips(600, 300)).toEqual([30, 60, 120, 300]);
        expect(durationChips(600, 400)).toEqual([30, 60, 120, 300, 400]);
    });
    it('below the minimum there is nothing to offer', () => {
        expect(durationChips(600, MIN_CLIP_SECONDS - 1)).toEqual([]);
        expect(durationChips(600, MIN_CLIP_SECONDS)).toEqual([MIN_CLIP_SECONDS]);
    });
    it('standard steps are what the plan promised', () => {
        expect(CHIP_SECONDS).toEqual([30, 60, 120, 300]);
    });
});

describe('postableChannels — text channels of the VOICE server with VIEW + SEND', () => {
    it('filters by type, server and permissions; a channel without bits is offered (server decides)', async () => {
        const { postableChannels } = await import('../api/clips/clipComposerLogic');
        const { PERM } = await import('../api/permissionBits');
        const both = PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES;
        const chans = [
            { id: 1, name: 'general', channel_type: 0, server_id: 'A', my_permissions: both },
            { id: 2, name: 'voice', channel_type: 1, server_id: 'A', my_permissions: both },
            { id: 3, name: 'other-server', channel_type: 0, server_id: 'B', my_permissions: both },
            { id: 4, name: 'read-only', channel_type: 0, server_id: 'A', my_permissions: PERM.VIEW_CHANNEL },
            { id: 5, name: 'no-bits', channel_type: 0, server_id: 'A' },
        ];
        expect(postableChannels(chans, 'A').map(c => c.id)).toEqual([1, 5]);
        expect(postableChannels(chans, null).map(c => c.id)).toEqual([1, 3, 5]);
    });
});

describe('outcomeCopy', () => {
    it('every non-approved outcome says the clip is gone and nothing was uploaded; pending/approved say nothing', async () => {
        const { outcomeCopy } = await import('../api/clips/clipComposerLogic');
        for (const s of ['declined', 'expired', 'cancelled'] as const) {
            expect(outcomeCopy(s)).toMatch(/Nothing was uploaded/);
            expect(outcomeCopy(s)).toMatch(/deleted from memory/);
        }
        expect(outcomeCopy('closed')).toMatch(/Nothing was uploaded/);
        expect(outcomeCopy('pending')).toBeNull();
        expect(outcomeCopy('approved')).toBeNull();
    });
});

describe('resolveClipTarget — the no-picker destination, one answer per way it fails', () => {
    it('all four kinds, each from a real state', async () => {
        const { resolveClipTarget } = await import('../api/clips/clipComposerLogic');
        const { PERM } = await import('../api/permissionBits');
        const ok = PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES;
        const chans = [
            { id: 7, name: 'clips', channel_type: 0, server_id: 'A', my_permissions: ok },
            { id: 8, name: 'read-only', channel_type: 0, server_id: 'A', my_permissions: PERM.VIEW_CHANNEL },
        ];

        // loading: the channel list has not arrived — NOT the same as empty.
        expect(resolveClipTarget({ serverId: 'A', pinnedChannelId: 7 }, null))
            .toEqual({ kind: 'loading' });

        // pin-missing: the server never pinned a channel (pre-S1 or misconfigured).
        expect(resolveClipTarget({ serverId: 'A', pinnedChannelId: null }, chans))
            .toEqual({ kind: 'pin-missing' });

        // pin-unpostable: pinned, but this user cannot post there (or it is gone).
        expect(resolveClipTarget({ serverId: 'A', pinnedChannelId: 8 }, chans).kind)
            .toBe('pin-unpostable');
        expect(resolveClipTarget({ serverId: 'A', pinnedChannelId: 999 }, chans).kind)
            .toBe('pin-unpostable');

        // ok — the positive control, carrying the channel for the name + id.
        const res = resolveClipTarget({ serverId: 'A', pinnedChannelId: 7 }, chans);
        expect(res.kind).toBe('ok');
        if (res.kind === 'ok') expect(res.channel).toMatchObject({ id: 7, name: 'clips' });
    });
});
