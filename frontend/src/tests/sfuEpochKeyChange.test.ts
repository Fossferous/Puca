// @vitest-environment jsdom
/**
 * An SFU call follows a changed channel KEY, not only a changed epoch number.
 *
 * THE FAILURE THIS PINS (0.9.861 review). Two rotations of one channel by the
 * same identity both minted epoch N+1; the server kept the first and answered
 * the second 200 with nothing written, so the loser joined its call under a key
 * no row holds. Every later refresh (the 30 s poll, ParticipantConnected, an
 * EncryptionError) then fetched {N+1, the stored key}, but refreshEpochKey
 * acted only when the epoch NUMBER differed, so the call stayed silent both
 * ways until the next rotation. (The rotations themselves are now queued per
 * channel and the server refuses the second one; this is the third wall.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const answer: { value: { epoch: number; key: Uint8Array } | null } = { value: null };
vi.mock('../api/channelKeys', async (orig) => ({
    ...(await orig<typeof import('../api/channelKeys')>()),
    ensureChannelKey: async () => answer.value,
}));

import { SfuManager, sameKeyBytes } from '../api/rtc/sfuManager';

const K1 = new Uint8Array(32).fill(1);
const K2 = new Uint8Array(32).fill(2);

type Internals = {
    channelId: number | null;
    currentEpoch: number | null;
    currentEpochKey: Uint8Array | null;
    refreshEpochKey(kp: { setEpochKey: (k: Uint8Array, e: number) => Promise<void> }): Promise<void>;
};

function inCall(epoch: number, key: Uint8Array) {
    const m = new SfuManager() as unknown as Internals;
    m.channelId = 42;
    m.currentEpoch = epoch;
    m.currentEpochKey = key;
    const setEpochKey = vi.fn(async (_k: Uint8Array, _e: number) => {});
    return { m, kp: { setEpochKey }, setEpochKey };
}

describe('refreshEpochKey', () => {
    beforeEach(() => { answer.value = null; });

    it('the same epoch with ANOTHER key: the call switches to the stored key', async () => {
        const { m, kp, setEpochKey } = inCall(5, K2);  // joined under the key it lost with
        answer.value = { epoch: 5, key: K1 };          // what the server holds for epoch 5
        await m.refreshEpochKey(kp);
        expect(setEpochKey, 'the call must move onto the key every other member has').toHaveBeenCalledTimes(1);
        expect(setEpochKey.mock.calls[0][1]).toBe(5);
        expect(m.currentEpochKey).toEqual(K1);
    });

    it('CONTROL: the same epoch with the same key changes nothing', async () => {
        const { m, kp, setEpochKey } = inCall(5, K1);
        answer.value = { epoch: 5, key: new Uint8Array(K1) };
        await m.refreshEpochKey(kp);
        expect(setEpochKey).not.toHaveBeenCalled();
    });

    it('CONTROL: a new epoch still switches, as before', async () => {
        const { m, kp, setEpochKey } = inCall(5, K1);
        answer.value = { epoch: 6, key: K2 };
        await m.refreshEpochKey(kp);
        expect(setEpochKey).toHaveBeenCalledTimes(1);
        expect(m.currentEpoch).toBe(6);
        expect(m.currentEpochKey).toEqual(K2);
    });
});

describe('sameKeyBytes', () => {
    it('compares bytes, and nothing equals no key', () => {
        expect(sameKeyBytes(K1, new Uint8Array(K1))).toBe(true);
        expect(sameKeyBytes(K1, K2)).toBe(false);
        expect(sameKeyBytes(K1, null)).toBe(false);
        expect(sameKeyBytes(K1, new Uint8Array(16).fill(1))).toBe(false);
    });
});
