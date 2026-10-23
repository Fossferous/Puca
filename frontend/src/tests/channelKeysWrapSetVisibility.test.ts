// @vitest-environment jsdom
/**
 * Audit 2026-10, F-2: the channel key is wrapped only for people the person
 * can SEE as members, and a refusal is said out loud.
 *
 * THE GAP. docs/E2EE.md and docs/SECURITY_MODEL.md §3 said that after the
 * H-1 fix an operator who wants the group key must forge channel MEMBERSHIP,
 * "which puts a stranger in the member list where a human can see them". The
 * member list a person sees is `GET /servers/:id/members-with-roles`
 * (hooks/queries.ts, useServerMembers). The set the channel key was wrapped
 * for — and the set a first-contact wrapper was attributed against — was
 * `GET /channels/:id/member-keys` alone (channelKeys.ts mintEpoch,
 * attributeWrapper), which no screen renders, and nothing compared the two.
 * A server listing an extra id on member-keys ONLY was handed the key by
 * every honest member who minted an epoch, and the stranger never appeared.
 *
 * These cases go red against that code: the stranger is wrapped for, no
 * member list is asked for, and nothing is said. The controls are the other
 * half: a member who joined a moment ago (in member-keys before a cached
 * member list has them) must still get the key with no alarm — and if the
 * read past the cache fails, must not be reported off the stale list — and a
 * member list that comes back degraded must not read as "nobody is a member".
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

const ME = ['me', 'a1'.repeat(16)] as const;
const STRANGER = ['stranger', 'c3'.repeat(16)] as const;
const NEWCOMER = ['newcomer', 'e5'.repeat(16)] as const;

type Row = { epoch: number; wrapped_key: string; sender_public_key: string; sender_user_id?: number | null };

const fake = {
    currentEpoch: 0,
    /** Rows addressed to us (GET /channels/:id/keys). */
    rows: [] as Row[],
    /** What the channel-key code is told: the wrap set. */
    memberKeys: [] as { user_id: number; public_key: string | null }[],
    /** What a person is shown: the server member list, one answer per read
     *  (the last one repeats); an Error is a read that fails. */
    visibleAnswers: [] as ({ id: number }[] | Error)[],
    /** Where the channel appears in our own lists. */
    channelsOfS1: [{ id: 42, name: 'general' }] as { id: number; name: string }[],
    /** The rows the server received on POST /keys. */
    posted: [] as { recipient_id: number; wrapped_key: string; sender_public_key: string }[],
    visibleListRequests: 0,
    reset() {
        this.currentEpoch = 0;
        this.rows = [];
        this.memberKeys = [];
        this.visibleAnswers = [];
        this.channelsOfS1 = [{ id: 42, name: 'general' }];
        this.posted = [];
        this.visibleListRequests = 0;
    },
};

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 1 }));
vi.mock('../api/client', () => ({
    apiClient: {
        get: vi.fn(async (url: string) => {
            if (url.endsWith('/keys')) {
                return { current_epoch: fake.currentEpoch, max_epoch: fake.currentEpoch, current_generation: 0, epoch_generation: 0, keys: fake.rows };
            }
            if (url.endsWith('/member-keys')) return fake.memberKeys;
            if (url.endsWith('/members-with-roles')) {
                fake.visibleListRequests++;
                const answer = fake.visibleAnswers.length > 1 ? fake.visibleAnswers.shift()! : (fake.visibleAnswers[0] ?? []);
                if (answer instanceof Error) throw answer;
                return answer;
            }
            if (url === '/servers') return [{ id: 's1', name: 'Home' }];
            if (url === '/servers/s1/channels') return fake.channelsOfS1;
            throw new Error('unexpected GET ' + url);
        }),
        post: vi.fn(async (url: string, body: { epoch: number; keys: typeof fake.posted }) => {
            if (url.endsWith('/keys')) {
                fake.posted = body.keys;
                fake.currentEpoch = body.epoch;
                return {};
            }
            throw new Error('unexpected POST ' + url);
        }),
    },
}));

import { setActiveIdentity, generateChannelKey, wrapChannelKeyForMembers } from '../api/e2ee';
import { ensureChannelKey, clearChannelKeyCache, hiddenRecipientNotices } from '../api/channelKeys';
import { noteServers } from '../api/channelDirectory';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

beforeAll(() => warmIdentities([ME, STRANGER, NEWCOMER]), WARM_TIMEOUT_MS);

// The shared setup installs a localStorage whose getItem always answers
// undefined; the pin store must read back what it wrote for this to mean
// anything (see channelKeys.test.ts).
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

const recipients = () => fake.posted.map((k) => k.recipient_id).sort((a, b) => a - b);

describe('the wrap set versus the member list a person sees', () => {
    beforeEach(async () => {
        fake.reset();
        clearChannelKeyCache();
        localStorage.clear();
        const me = await testIdentity(...ME);
        const stranger = await testIdentity(...STRANGER);
        setActiveIdentity(me);
        // The server lists the stranger on member-keys ONLY. The list a person
        // is shown has one member: us.
        fake.memberKeys = [
            { user_id: 1, public_key: me.publicKeyEncoded },
            { user_id: 99, public_key: stranger.publicKeyEncoded },
        ];
        fake.visibleAnswers = [[{ id: 1 }]];
    });

    it('SECURITY: an id listed on member-keys only is NOT wrapped for, and the member list was asked', async () => {
        const got = await ensureChannelKey(42);
        expect(got).not.toBeNull();
        expect(got!.epoch).toBe(1);
        expect(recipients(), 'the channel key went to someone no screen shows').toEqual([1]);
        expect(fake.visibleListRequests).toBeGreaterThan(0);
    });

    it('SECURITY: the refusal is said, naming the channel and its server', async () => {
        noteServers([{ id: 's1', name: 'Home' }]);
        await ensureChannelKey(42);
        expect(hiddenRecipientNotices()).toEqual([
            { channelId: 42, serverId: 's1', channelName: 'general', serverName: 'Home', userIds: [99] },
        ]);
    });

    it('SECURITY: a first-contact wrapper listed on member-keys only is not taken as the channel key', async () => {
        const me = await testIdentity(...ME);
        const stranger = await testIdentity(...STRANGER);
        const forged = generateChannelKey();
        const [row] = await wrapChannelKeyForMembers(stranger, forged, [{ userId: 1, publicKey: me.publicKeyEncoded }], { channelId: 42, epoch: 1 });
        fake.currentEpoch = 1;
        fake.rows = [{ epoch: 1, wrapped_key: row.wrappedKey, sender_public_key: row.senderPublicKey, sender_user_id: 99 }];

        const got = await ensureChannelKey(42);

        expect(got).not.toBeNull();
        expect(Buffer.from(got!.key).equals(Buffer.from(forged)), 'encrypting under a key a stranger chose').toBe(false);
        expect(got!.epoch, 'rotated to an epoch of our own').toBe(2);
        expect(recipients()).toEqual([1]);
        expect(hiddenRecipientNotices()[0]?.userIds).toEqual([99]);
    });

    it('CONTROL: a first-contact wrapper who IS in the member list is adopted, no rotation, no notice', async () => {
        const me = await testIdentity(...ME);
        const stranger = await testIdentity(...STRANGER);
        const real = generateChannelKey();
        const [row] = await wrapChannelKeyForMembers(stranger, real, [{ userId: 1, publicKey: me.publicKeyEncoded }], { channelId: 42, epoch: 1 });
        fake.currentEpoch = 1;
        fake.rows = [{ epoch: 1, wrapped_key: row.wrappedKey, sender_public_key: row.senderPublicKey, sender_user_id: 99 }];
        fake.visibleAnswers = [[{ id: 1 }, { id: 99 }]];

        const got = await ensureChannelKey(42);

        expect(got!.epoch).toBe(1);
        expect(Buffer.from(got!.key).equals(Buffer.from(real))).toBe(true);
        expect(fake.posted).toEqual([]);
        expect(hiddenRecipientNotices()).toEqual([]);
    });

    it('CONTROL: everyone member-keys lists is wrapped for when the member list shows them all', async () => {
        fake.visibleAnswers = [[{ id: 1 }, { id: 99 }]];
        await ensureChannelKey(42);
        expect(recipients(), 'the check refuses real members').toEqual([1, 99]);
        expect(hiddenRecipientNotices()).toEqual([]);
    });

    it('CONTROL: someone who joined a moment ago is refetched for, wrapped for, and raises no alarm', async () => {
        const newcomer = await testIdentity(...NEWCOMER);
        fake.memberKeys = [
            { user_id: 1, public_key: (await testIdentity(...ME)).publicKeyEncoded },
            { user_id: 2, public_key: newcomer.publicKeyEncoded },
        ];
        // The first read is from before they joined; the second has them.
        fake.visibleAnswers = [[{ id: 1 }], [{ id: 1 }, { id: 2 }]];

        await ensureChannelKey(42);

        expect(recipients()).toEqual([1, 2]);
        expect(fake.visibleListRequests).toBe(2);
        expect(hiddenRecipientNotices(), 'a false alarm about a real new member').toEqual([]);
    });

    it('CONTROL: when reading past the cache FAILS, the newcomer is not reported and nothing is minted on the stale list', async () => {
        const newcomer = await testIdentity(...NEWCOMER);
        fake.memberKeys = [
            { user_id: 1, public_key: (await testIdentity(...ME)).publicKeyEncoded },
            { user_id: 2, public_key: newcomer.publicKeyEncoded },
        ];
        // The first read is from before they joined; the read past it fails.
        fake.visibleAnswers = [[{ id: 1 }], new Error('offline')];

        const got = await ensureChannelKey(42);

        expect(fake.visibleListRequests).toBe(2);
        expect(hiddenRecipientNotices(), 'a false alarm about a real new member').toEqual([]);
        expect(got, 'minted on the list the second read was meant to replace').toBeNull();
        expect(fake.posted).toEqual([]);
    });

    it('CONTROL: nor is a first-contact wrapper who just joined, when reading past the cache fails', async () => {
        const me = await testIdentity(...ME);
        const newcomer = await testIdentity(...NEWCOMER);
        const real = generateChannelKey();
        const [row] = await wrapChannelKeyForMembers(newcomer, real, [{ userId: 1, publicKey: me.publicKeyEncoded }], { channelId: 42, epoch: 1 });
        fake.currentEpoch = 1;
        fake.rows = [{ epoch: 1, wrapped_key: row.wrappedKey, sender_public_key: row.senderPublicKey, sender_user_id: 2 }];
        fake.memberKeys = [
            { user_id: 1, public_key: me.publicKeyEncoded },
            { user_id: 2, public_key: newcomer.publicKeyEncoded },
        ];
        fake.visibleAnswers = [[{ id: 1 }], new Error('offline')];

        await ensureChannelKey(42);

        expect(hiddenRecipientNotices(), 'a false alarm about a real new member').toEqual([]);
        expect(fake.posted, 'minted on a list known to be stale').toEqual([]);
    });

    it('CONTROL: a member list without us in it (a degraded answer) mints nothing and alarms nobody', async () => {
        fake.visibleAnswers = [[]]; // members-with-roles answers [] when its own query fails
        const got = await ensureChannelKey(42);
        expect(got).toBeNull();
        expect(fake.posted).toEqual([]);
        expect(hiddenRecipientNotices()).toEqual([]);
    });

    it('SECURITY: a channel no list of ours places in a server mints nothing', async () => {
        fake.channelsOfS1 = []; // the server never listed channel 42 to us
        const got = await ensureChannelKey(42);
        expect(got).toBeNull();
        expect(fake.posted).toEqual([]);
    });
});
