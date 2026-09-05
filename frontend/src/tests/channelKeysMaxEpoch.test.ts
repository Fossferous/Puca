/**
 * Epoch squatting (audit 2026-09-05, C12). Rotation used to target
 * `currentEpoch + 1` — the epoch the SERVER said was current, plus one. A
 * revoked member who still held a key could publish epoch N+1 (and N+2, ...)
 * ahead of time; every honest rotation then collided with a squatted epoch,
 * lost the 409 race, and adopted the squatter's key. Rotation never moved off a
 * key the ejected member held.
 *
 * The fix: GET /channels/:id/keys reports `max_epoch` — the highest epoch ANY
 * row exists for — and a rotation targets `Math.max(currentEpoch, maxEpoch) + 1`,
 * above everything already published. These tests pin that arithmetic through
 * the public API: the server holds epoch 2 current with rows squatted up to 3,
 * and the mint must POST epoch 4. Against the pre-fix client it posts 3.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

const fake = vi.hoisted(() => ({
    currentEpoch: 0,
    currentGeneration: 0,
    epochGeneration: 0,
    // undefined = a server that predates the field (rollout window, see below).
    maxEpoch: undefined as number | undefined,
    published: [] as { epoch: number; wrapped_key: string; sender_public_key: string; member_generation: number; sender_user_id: number | null }[],
    members: [] as { user_id: number; public_key: string | null }[],
    // Every epoch the client tried to publish, in order.
    posted: [] as { epoch: number; member_generation: number }[],
}));

// The rig IS user 1: a v3 wrap is bound to the recipient's id, and the unwrap
// side takes ours from the token.
vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 1 }));
vi.mock('../api/client', () => ({
    statusOf: () => undefined,
    apiClient: {
        get: vi.fn(async (url: string) => {
            if (url.endsWith('/keys')) {
                return {
                    current_epoch: fake.currentEpoch,
                    current_generation: fake.currentGeneration,
                    epoch_generation: fake.epochGeneration,
                    ...(fake.maxEpoch === undefined ? {} : { max_epoch: fake.maxEpoch }),
                    keys: fake.published,
                };
            }
            if (url.endsWith('/member-keys')) return fake.members;
            throw new Error('unexpected GET ' + url);
        }),
        post: vi.fn(async (url: string, body: { epoch: number; member_generation: number; keys: Array<{ recipient_id: number; wrapped_key: string; sender_public_key: string }> }) => {
            if (url.endsWith('/keys')) {
                fake.posted.push({ epoch: body.epoch, member_generation: body.member_generation });
                fake.currentEpoch = body.epoch;
                fake.epochGeneration = body.member_generation;
                fake.maxEpoch = Math.max(fake.maxEpoch ?? 0, body.epoch);
                const mine = body.keys.find((k) => k.recipient_id === 1);
                if (mine) {
                    fake.published.push({ epoch: body.epoch, wrapped_key: mine.wrapped_key, sender_public_key: mine.sender_public_key, member_generation: body.member_generation, sender_user_id: 1 });
                }
                return {};
            }
            throw new Error('unexpected POST ' + url);
        }),
    },
}));

import { setActiveIdentity, generateChannelKey, wrapChannelKeyForMembers } from '../api/e2ee';
import { ensureChannelKey, clearChannelKeyCache } from '../api/channelKeys';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const ME = ['me', 'a1'.repeat(16)] as const;
beforeAll(() => warmIdentities([ME]), WARM_TIMEOUT_MS);

const CHANNEL = 42;

/** The channel as the server presents it: epoch 2 is current and we HOLD its
 *  key (our own v3 wrap, so the wrapper is trusted with no lookup). The
 *  generation has moved (a member left), which is what forces a rotation. */
async function holdingEpoch2(opts: { maxEpoch?: number; generationMoved: boolean }) {
    const me = await testIdentity(...ME);
    const wrapped = await wrapChannelKeyForMembers(me, generateChannelKey(), [{ userId: 1, publicKey: me.publicKeyEncoded }], { channelId: CHANNEL, epoch: 2 });
    fake.currentEpoch = 2;
    fake.epochGeneration = 0;
    fake.currentGeneration = opts.generationMoved ? 1 : 0;
    fake.maxEpoch = opts.maxEpoch;
    fake.published = [{ epoch: 2, wrapped_key: wrapped[0].wrappedKey, sender_public_key: wrapped[0].senderPublicKey, member_generation: 0, sender_user_id: 1 }];
}

describe('channel-key rotation target (max_epoch)', () => {
    beforeEach(async () => {
        clearChannelKeyCache();
        const me = await testIdentity(...ME);
        setActiveIdentity(me);
        fake.members = [{ user_id: 1, public_key: me.publicKeyEncoded }];
        fake.published = [];
        fake.posted = [];
        fake.maxEpoch = undefined;
    });

    it('rotates ABOVE a squatted epoch: current 2, max_epoch 3 -> mints 4, not 3', async () => {
        await holdingEpoch2({ maxEpoch: 3, generationMoved: true });
        const res = await ensureChannelKey(CHANNEL);
        expect(res).not.toBeNull();
        // The pre-fix client posts currentEpoch + 1 = 3 here — straight into
        // the squatter's row, where the 409 path adopts THEIR key.
        expect(fake.posted).toEqual([{ epoch: 4, member_generation: 1 }]);
        expect(res!.epoch).toBe(4);
    });

    it('positive control: with nothing squatted (max_epoch == current) the target is still current + 1', async () => {
        await holdingEpoch2({ maxEpoch: 2, generationMoved: true });
        const res = await ensureChannelKey(CHANNEL);
        expect(fake.posted).toEqual([{ epoch: 3, member_generation: 1 }]);
        expect(res!.epoch).toBe(3);
    });

    it('control: max_epoch alone does not force a rotation while the generation is unchanged', async () => {
        // Squatted rows exist but membership has not moved: keep sending under
        // the held epoch. Rotation is driven by the generation; max_epoch only
        // decides WHERE a rotation lands.
        await holdingEpoch2({ maxEpoch: 3, generationMoved: false });
        const res = await ensureChannelKey(CHANNEL);
        expect(fake.posted).toEqual([]);
        expect(res!.epoch).toBe(2);
    });

    it('a server that omits max_epoch still gets a numeric target (current + 1)', async () => {
        // Clients ship before the backend (rollout order), so for a window the
        // new client talks to a server whose /keys response has no max_epoch.
        // Math.max(2, undefined) is NaN; a NaN epoch would be refused by the
        // server and every send in the channel would fail until the restart.
        await holdingEpoch2({ maxEpoch: undefined, generationMoved: true });
        const res = await ensureChannelKey(CHANNEL);
        expect(fake.posted).toEqual([{ epoch: 3, member_generation: 1 }]);
        expect(res!.epoch).toBe(3);
    });
});
