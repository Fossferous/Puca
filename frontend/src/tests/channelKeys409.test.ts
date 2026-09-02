/**
 * The channel-key epoch race (channelKeys.ts mintEpoch): when two members
 * try to establish the same epoch at once, the loser gets a 409 and must
 * ADOPT the winner's key rather than fail the send.
 *
 * That branch was dead until 0.9.2: it read `err.response.status`, the axios
 * shape, from errors this client never throws (ApiError has a flat `.status`),
 * so the 409 always re-threw and the losing user saw "Message failed to send.
 * Check your connection". Positive control: with the old shape check the
 * first test rejects instead of resolving.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../api/client';
import { generateIdentitySeed, makeIdentity, setActiveIdentity, wrapChannelKeyForMembers, generateChannelKey } from '../api/e2ee';

const fake = vi.hoisted(() => ({
    postStatus: 409 as number,
    // The winner's row, addressed to us, appears on the reload after the 409.
    winnerRows: [] as Array<Record<string, unknown>>,
    members: [] as Array<{ user_id: number; public_key: string | null }>,
    posts: 0,
}));

// auth is a PLAIN mock (no importOriginal): the real auth.ts imports client,
// and client's factory below imports the real client, which imports auth —
// importOriginal on both sides is a cycle that hands channelKeys the real
// apiClient (observed: a real fetch to localhost). The three names are all
// the rig needs.
vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 1, getToken: () => null, storeRenewedToken: () => {} }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return {
        ...real,
        apiClient: {
            get: vi.fn(async (url: string) => {
                if (url.endsWith('/keys')) {
                    // THE RACE: the winner's row is only visible AFTER our own
                    // mint was refused — before it, the channel looks empty
                    // and we go on to mint, exactly like the losing client.
                    const visible = fake.posts > 0 ? fake.winnerRows : [];
                    return { current_epoch: visible.length ? 1 : 0, current_generation: 1, epoch_generation: visible.length ? 1 : 0, keys: visible };
                }
                if (url.endsWith('/member-keys')) return fake.members;
                throw new Error('unexpected GET ' + url);
            }),
            post: vi.fn(async (url: string) => {
                if (url.endsWith('/keys')) {
                    fake.posts += 1;
                    throw new ApiError('epoch already established', fake.postStatus);
                }
                throw new Error('unexpected POST ' + url);
            }),
        },
    };
});

const { ensureChannelKey, clearChannelKeyCache } = await import('../api/channelKeys');

// ONE pair of identities for the whole file: channelKeys pins each member's
// served key (keyVerification) and a fresh key per test would read as a
// substitution attack — every member skipped, nothing wrapped, mint returns
// null before the POST the second test needs to see.
const me = makeIdentity(generateIdentitySeed());
const winner = makeIdentity(generateIdentitySeed());

beforeEach(async () => {
    clearChannelKeyCache();
    setActiveIdentity(me);
    fake.members = [
        { user_id: 1, public_key: me.publicKeyEncoded },
        { user_id: 2, public_key: winner.publicKeyEncoded },
    ];
    fake.winnerRows = [];
    fake.posts = 0;
    fake.postStatus = 409;
});

async function winnerPublishes(): Promise<Uint8Array> {
    const key = generateChannelKey();
    const wrapped = await wrapChannelKeyForMembers(winner, key, [{ userId: 1, publicKey: me.publicKeyEncoded }], { channelId: 7, epoch: 1 });
    fake.winnerRows = wrapped.map(w => ({
        epoch: 1, wrapped_key: w.wrappedKey, sender_public_key: w.senderPublicKey, member_generation: 1, sender_user_id: 2,
    }));
    return key;
}

describe('mintEpoch losing the race', () => {
    it('a 409 adopts the winner\'s key instead of failing the send', async () => {
        const winnersKey = await winnerPublishes();
        // Our mint POST 409s (the winner got there first); the reload finds their wrap for us.
        const got = await ensureChannelKey(7);
        expect(fake.posts).toBe(1);
        expect(got).not.toBeNull();
        expect(Buffer.from(got!.key).equals(Buffer.from(winnersKey))).toBe(true);
        expect(got!.epoch).toBe(1);
    });

    it('any other status still throws — a 409 is the ONLY signal to adopt', async () => {
        fake.postStatus = 500;
        await expect(ensureChannelKey(7)).rejects.toBeInstanceOf(ApiError);
    });
});
