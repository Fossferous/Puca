// @vitest-environment jsdom
/**
 * Someone joins a server; can they actually say anything?
 *
 * THE FAILURE THIS PINS. Channel keys are wrapped per member, so whoever just
 * joined holds nothing for the current epoch. `ensureChannelKey` returns null
 * for them and the composer refuses with "this channel's encryption key isn't
 * available yet — try again in a moment". Nothing made that moment arrive: the
 * rotate-and-rewrap path only ran inside a send, an edit, a task write or a
 * voice join, all of which are things an EXISTING member does. Invite someone
 * while you are asleep and their first message failed, under copy promising a
 * recovery nothing was going to deliver.
 *
 * `rewrapForMembershipChange` is what an existing holder now runs on
 * `MemberJoined`. These tests assert the newcomer ends up with a wrap
 * addressed to THEM — not merely that a rotation happened.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

/** The server's channel-key state, as this rig models it. */
const fake = {
    currentEpoch: 0,
    currentGeneration: 0,
    epochGeneration: 0,
    published: [] as Array<{ epoch: number; wrapped_key: string; sender_public_key: string; member_generation: number; sender_user_id: number }>,
    /** Every recipient id in the LAST publish — the thing that decides whether the newcomer can write. */
    lastRecipients: [] as number[],
    publishes: 0,
    members: [] as Array<{ user_id: number; public_key: string }>,
    /** Every GET of a channel's /keys, and whether the server answers them 429. */
    keyGets: 0,
    rateLimited: false,
    reset() {
        this.keyGets = 0;
        this.rateLimited = false;
        this.currentEpoch = 0;
        this.currentGeneration = 0;
        this.epochGeneration = 0;
        this.published = [];
        this.lastRecipients = [];
        this.publishes = 0;
        this.members = [];
    },
};

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 1 }));
vi.mock('../api/client', () => ({
    statusOf: (e: unknown) => (e as { status?: number } | null)?.status,
    apiClient: {
        get: vi.fn(async (url: string) => {
            if (url.endsWith('/keys')) {
                fake.keyGets++;
                if (fake.rateLimited) throw Object.assign(new Error('Too Many Requests'), { status: 429 });
                return {
                    current_epoch: fake.currentEpoch,
                    current_generation: fake.currentGeneration,
                    epoch_generation: fake.epochGeneration,
                    keys: fake.published,
                };
            }
            if (url.endsWith('/member-keys')) return fake.members;
            // An honest server: the member list people see holds everyone it
            // lists for a channel's key, and the channels are listed under s1 (F-2).
            if (url === '/servers') return [{ id: 's1', name: 'Test server' }];
            if (url === '/servers/s1/channels') return [{ id: 77, name: 'general' }];
            if (url.endsWith('/members-with-roles')) return [{ id: 1 }, ...fake.members.map((m) => ({ id: m.user_id }))];
            throw new Error('unexpected GET ' + url);
        }),
        post: vi.fn(async (url: string, body: {
            epoch: number;
            member_generation: number;
            keys: Array<{ recipient_id: number; wrapped_key: string; sender_public_key: string }>;
        }) => {
            if (url.endsWith('/keys')) {
                fake.currentEpoch = body.epoch;
                fake.epochGeneration = body.member_generation;
                fake.publishes++;
                fake.lastRecipients = body.keys.map(k => k.recipient_id);
                const mine = body.keys.find(k => k.recipient_id === 1);
                if (mine) {
                    fake.published.push({
                        epoch: body.epoch,
                        wrapped_key: mine.wrapped_key,
                        sender_public_key: mine.sender_public_key,
                        member_generation: body.member_generation,
                        sender_user_id: 1,
                    });
                }
                return {};
            }
            throw new Error('unexpected POST ' + url);
        }),
    },
}));

import { setActiveIdentity, generateChannelKey } from '../api/e2ee';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';
import { ensureChannelKey, rewrapForMembershipChange, clearChannelKeyCache } from '../api/channelKeys';

const ME = ['me', 'a1'.repeat(16)] as const;       // the existing member (user 1)
const NEWCOMER = ['newcomer', 'e5'.repeat(16)] as const; // user 2, just joined

beforeAll(() => warmIdentities([ME, NEWCOMER]), WARM_TIMEOUT_MS);

// The real localStorage in setup.ts never reads back what it wrote, and the
// epoch floor lives there — give this file a store that works.
const memStore = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
        getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
        setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
        removeItem: (k: string) => { memStore.delete(k); },
        clear: () => { memStore.clear(); },
        key: (i: number) => [...memStore.keys()][i] ?? null,
        get length() { return memStore.size; },
    },
});

const CHANNEL = 77;

describe('a new member can speak', () => {
    let newcomerId: number;

    beforeEach(async () => {
        fake.reset();
        clearChannelKeyCache();
        localStorage.clear();
        const me = await testIdentity(...ME);
        setActiveIdentity(me);
        // Only us in the channel, and we mint epoch 1.
        fake.members = [{ user_id: 1, public_key: me.publicKeyEncoded }];
        const first = await ensureChannelKey(CHANNEL);
        expect(first!.epoch).toBe(1);
        expect(fake.lastRecipients).toEqual([1]);

        // Now someone joins: the server's member generation moves and the
        // member-keys endpoint starts naming them.
        const them = await testIdentity(...NEWCOMER);
        newcomerId = 2;
        fake.members = [
            { user_id: 1, public_key: me.publicKeyEncoded },
            { user_id: newcomerId, public_key: them.publicKeyEncoded },
        ];
        fake.currentGeneration = 1;
        clearChannelKeyCache(); // as a fresh page load would see it
    });

    it('POSITIVE CONTROL: before the fix ran, the newcomer has no wrap addressed to them', () => {
        // Epoch 1 was minted when only user 1 was a member. This is exactly the
        // state in which their first message was refused.
        expect(fake.lastRecipients).toEqual([1]);
        expect(fake.lastRecipients).not.toContain(newcomerId);
    });

    it('re-wraps on join, and the new epoch is addressed to the newcomer', async () => {
        const rotated = await rewrapForMembershipChange([CHANNEL]);
        expect(rotated, 'an existing holder should have rotated once').toBe(1);
        expect(fake.currentEpoch).toBe(2);
        expect(fake.lastRecipients, 'the newcomer must be among the recipients').toContain(newcomerId);
        expect(fake.lastRecipients).toContain(1);
        expect(fake.epochGeneration).toBe(fake.currentGeneration);
    });

    it('collapses: a second member running it publishes nothing more', async () => {
        await rewrapForMembershipChange([CHANNEL]);
        const after = fake.publishes;
        // Everyone runs this on MemberJoined. The second one through re-reads
        // state, sees the generation already matched, and stands down.
        await rewrapForMembershipChange([CHANNEL]);
        expect(fake.publishes, 'a second run must not mint another epoch').toBe(after);
    });

    it('is best-effort: a channel we hold no key for is skipped, not thrown', async () => {
        // A channel whose epoch exists but was never wrapped for us — the
        // state a member who is ALSO new would be in.
        fake.currentEpoch = 9;
        fake.published = [];
        clearChannelKeyCache();
        await expect(rewrapForMembershipChange([CHANNEL])).resolves.toBe(0);
        expect(fake.publishes, 'nothing published for a channel we cannot rotate').toBe(1);
    });

    it('does nothing for an empty channel list', async () => {
        const before = fake.publishes;
        await expect(rewrapForMembershipChange([])).resolves.toBe(0);
        expect(fake.publishes).toBe(before);
    });

    it('the catch-up (bootstrap: false) still re-wraps a keyed channel whose membership moved', async () => {
        // components/useChannelKeyUpkeep.ts runs this once per server per
        // sign-in, for members who joined while nobody holding keys was online.
        const rotated = await rewrapForMembershipChange([CHANNEL], { bootstrap: false });
        expect(rotated).toBe(1);
        expect(fake.lastRecipients).toContain(newcomerId);
    });

    it('the catch-up mints nothing for a channel nobody has a key for yet', async () => {
        // Whoever uses an empty channel first mints its key; an upkeep pass
        // over every channel of a server must not write one for each.
        fake.reset();
        fake.members = [{ user_id: 1, public_key: (await testIdentity(...ME)).publicKeyEncoded }];
        clearChannelKeyCache();
        await expect(rewrapForMembershipChange([CHANNEL], { bootstrap: false })).resolves.toBe(0);
        expect(fake.publishes, 'no first epoch minted by the catch-up').toBe(0);
        await expect(ensureChannelKey(CHANNEL, { bootstrap: false })).resolves.toBeNull();
        expect(fake.publishes).toBe(0);
        // CONTROL: the ordinary path (a send, a join) does mint it.
        const minted = await ensureChannelKey(CHANNEL);
        expect(minted?.epoch).toBe(1);
        expect(fake.publishes).toBe(1);
    });

    it('two rotations of one channel at once make ONE publish, and both callers get its key', async () => {
        // The sign-in catch-up and a send (or the MemberJoined re-wrap and an
        // SFU call's poll) read the same pre-rotation state. Both used to mint
        // the next epoch; the server kept one and, before 0.9.861, told the
        // other 200 with nothing written, so that caller sealed under a key no
        // row holds (0.9.861 review). Queued per channel, the second caller
        // finds the first one's epoch and publishes nothing.
        const before = fake.publishes;
        const [a, b] = await Promise.all([ensureChannelKey(CHANNEL), ensureChannelKey(CHANNEL)]);
        expect(fake.publishes - before, 'one rotation, not two').toBe(1);
        expect(a!.epoch).toBe(b!.epoch);
        expect(Array.from(a!.key)).toEqual(Array.from(b!.key));
    });

    it('counts what it minted, not what a fresh page merely loaded', async () => {
        await expect(rewrapForMembershipChange([CHANNEL])).resolves.toBe(1);
        clearChannelKeyCache(); // a fresh page: nothing cached, the key already current
        const before = fake.publishes;
        await expect(rewrapForMembershipChange([CHANNEL])).resolves.toBe(0);
        expect(fake.publishes).toBe(before);
    });

    it('a 429 ends the pass instead of asking for every remaining channel', async () => {
        fake.rateLimited = true;
        clearChannelKeyCache();
        fake.keyGets = 0;
        await expect(rewrapForMembershipChange([CHANNEL, 78, 79], { bootstrap: false })).resolves.toBe(0);
        expect(fake.keyGets, 'stopped at the first refusal').toBe(1);
    });

    it('the newcomer can then read the key it was handed', async () => {
        await rewrapForMembershipChange([CHANNEL]);
        // Re-run as the NEWCOMER: their client loads the wraps addressed to
        // them. The rig stores only user 1's row, so assert the wrap set
        // instead — proving the publish carried a row for them, which is what
        // their loadKeys would find.
        expect(fake.lastRecipients).toContain(newcomerId);
        expect(generateChannelKey().length, 'sanity: the key size is unchanged').toBe(32);
    });
});
