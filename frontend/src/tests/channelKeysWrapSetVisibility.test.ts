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
    /** How many member-keys requests fail before they answer again. */
    memberKeysFailures: 0,
    /** What GET /users/1/public-key answers for us; null fails the request. */
    ownKey: null as string | null,
    reset() {
        this.ownKey = null;
        this.currentEpoch = 0;
        this.rows = [];
        this.memberKeys = [];
        this.visibleAnswers = [];
        this.channelsOfS1 = [{ id: 42, name: 'general' }];
        this.posted = [];
        this.visibleListRequests = 0;
        this.memberKeysFailures = 0;
    },
};

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 1 }));
vi.mock('../api/client', () => ({
    apiClient: {
        get: vi.fn(async (url: string) => {
            if (url.endsWith('/keys')) {
                return { current_epoch: fake.currentEpoch, max_epoch: fake.currentEpoch, current_generation: 0, epoch_generation: 0, keys: fake.rows };
            }
            if (url.endsWith('/member-keys')) {
                if (fake.memberKeysFailures > 0) {
                    fake.memberKeysFailures--;
                    throw new Error('member-keys: 503');
                }
                return fake.memberKeys;
            }
            if (url.endsWith('/members-with-roles')) {
                fake.visibleListRequests++;
                const answer = fake.visibleAnswers.length > 1 ? fake.visibleAnswers.shift()! : (fake.visibleAnswers[0] ?? []);
                if (answer instanceof Error) throw answer;
                return answer;
            }
            if (url === '/servers') return [{ id: 's1', name: 'Home' }];
            if (url === '/servers/s1/channels') return fake.channelsOfS1;
            if (url === '/users/1/public-key') {
                if (fake.ownKey === null) throw new Error('502 from the proxy');
                return { user_id: 1, public_key: fake.ownKey };
            }
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

import { QueryClient } from '@tanstack/react-query';
import { setActiveIdentity, getActiveIdentity, generateChannelKey, wrapChannelKeyForMembers } from '../api/e2ee';
import { ensureChannelKey, clearChannelKeyCache, hiddenRecipientNotices, setVisibleMembersSource } from '../api/channelKeys';
import { noteServers } from '../api/channelDirectory';
import { visibleMembersFromQueries } from '../api/visibleMembersQuery';
import { identityRestoreReason } from '../api/auth';
import { pinServedIdentityKey } from '../api/keyVerification';
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

/** An unsigned token naming account `sub`: what auth.ts decodes for its own
 *  reads of who is signed in (the server verifies tokens; the client only decodes). */
function tokenFor(sub: number): string {
    const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify({ sub, username: 'me' }))}.sig`;
}
const OWED = 'e2ee_own_key_check_owed_v1';

// FIRST in the file, on purpose: pins live in memory for the whole file, and
// every mint below pins user 1 (us). These run with no self-pin, which is
// the device the forged row was trusted on.
describe('our own entry: the server may not list US under a key of its own (second review, finding 2)', () => {
    beforeEach(async () => {
        fake.reset();
        clearChannelKeyCache();
        localStorage.clear();
        setActiveIdentity(await testIdentity(...ME));
        fake.visibleAnswers = [[{ id: 1 }]];
    });

    it('SECURITY: member-keys listing us under another key mints nothing, wraps nothing, and puts the identity away', async () => {
        const substitute = await testIdentity(...STRANGER);
        fake.memberKeys = [{ user_id: 1, public_key: substitute.publicKeyEncoded }];

        const got = await ensureChannelKey(42);

        expect(got).toBeNull();
        expect(fake.posted, 'the channel key was wrapped to a key the server chose for us').toEqual([]);
        expect(getActiveIdentity()).toBeNull();
        expect(identityRestoreReason()).toBe('key-mismatch');
    });

    it('SECURITY: a row that names US as its wrapper, under another key, is not taken as the channel key', async () => {
        const me = await testIdentity(...ME);
        const forger = await testIdentity(...STRANGER);
        const chosen = generateChannelKey();
        // A key of the server's choosing, wrapped to us under a key it holds,
        // and said to be from us; member-keys agrees, so every first-contact
        // step would pass.
        const [row] = await wrapChannelKeyForMembers(forger, chosen, [{ userId: 1, publicKey: me.publicKeyEncoded }], { channelId: 42, epoch: 1 });
        fake.currentEpoch = 1;
        fake.rows = [{ epoch: 1, wrapped_key: row.wrappedKey, sender_public_key: row.senderPublicKey, sender_user_id: 1 }];
        fake.memberKeys = [{ user_id: 1, public_key: forger.publicKeyEncoded }];

        const got = await ensureChannelKey(42);

        expect(got === null || !Buffer.from(got.key).equals(Buffer.from(chosen)), 'encrypting under a key the server chose').toBe(true);
        expect(getActiveIdentity()).toBeNull();
        expect(identityRestoreReason()).toBe('key-mismatch');
    });

    it('SECURITY: an own-key check a sign-in could not finish is done before the next mint, and a key that is not ours stops it', async () => {
        const me = await testIdentity(...ME);
        localStorage.setItem('auth_token', tokenFor(1));
        localStorage.setItem(OWED, '1');
        fake.ownKey = (await testIdentity(...STRANGER)).publicKeyEncoded;
        fake.memberKeys = [{ user_id: 1, public_key: me.publicKeyEncoded }];

        const got = await ensureChannelKey(42);

        expect(got).toBeNull();
        expect(fake.posted, 'a key handed out before the owed check was done').toEqual([]);
        expect(getActiveIdentity()).toBeNull();
        expect(identityRestoreReason()).toBe('key-mismatch');
    });

    it('CONTROL: a row we really wrapped, under our key, is ours — adopted, nothing refused', async () => {
        const me = await testIdentity(...ME);
        const real = generateChannelKey();
        const [row] = await wrapChannelKeyForMembers(me, real, [{ userId: 1, publicKey: me.publicKeyEncoded }], { channelId: 42, epoch: 1 });
        fake.currentEpoch = 1;
        fake.rows = [{ epoch: 1, wrapped_key: row.wrappedKey, sender_public_key: row.senderPublicKey, sender_user_id: 1 }];
        fake.memberKeys = [{ user_id: 1, public_key: me.publicKeyEncoded }];

        const got = await ensureChannelKey(42);

        expect(got!.epoch).toBe(1);
        expect(Buffer.from(got!.key).equals(Buffer.from(real))).toBe(true);
        expect(getActiveIdentity()).not.toBeNull();
        expect(identityRestoreReason()).toBeNull();
    });

    it('CONTROL: member-keys listing us under OUR key mints as before', async () => {
        const me = await testIdentity(...ME);
        fake.memberKeys = [{ user_id: 1, public_key: me.publicKeyEncoded }];

        const got = await ensureChannelKey(42);

        expect(got!.epoch).toBe(1);
        expect(recipients()).toEqual([1]);
        expect(identityRestoreReason()).toBeNull();
    });

    it('CONTROL: the owed check meets our key — the mint goes ahead, and nothing is owed any more', async () => {
        const me = await testIdentity(...ME);
        localStorage.setItem('auth_token', tokenFor(1));
        localStorage.setItem(OWED, '1');
        fake.ownKey = me.publicKeyEncoded;
        fake.memberKeys = [{ user_id: 1, public_key: me.publicKeyEncoded }];

        const got = await ensureChannelKey(42);

        expect(got!.epoch).toBe(1);
        expect(recipients()).toEqual([1]);
        expect(localStorage.getItem(OWED)).toBeNull();
    });
});

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

    it('CONTROL: with member-keys failing, a pinned wrapper who has since LEFT is not reported (second review, finding 4)', async () => {
        const me = await testIdentity(...ME);
        const former = await testIdentity(...NEWCOMER);
        // They were a member once, and we pinned them; their row outlived
        // their membership (only rows addressed TO a leaver are deleted).
        pinServedIdentityKey(2, former.publicKeyEncoded);
        const [row] = await wrapChannelKeyForMembers(former, generateChannelKey(), [{ userId: 1, publicKey: me.publicKeyEncoded }], { channelId: 42, epoch: 1 });
        fake.currentEpoch = 1;
        fake.rows = [{ epoch: 1, wrapped_key: row.wrappedKey, sender_public_key: row.senderPublicKey, sender_user_id: 2 }];
        fake.memberKeys = [{ user_id: 1, public_key: me.publicKeyEncoded }];
        fake.memberKeysFailures = 1; // the load's lookup fails; the rotation's answers
        fake.visibleAnswers = [[{ id: 1 }]]; // they left

        await ensureChannelKey(42);

        expect(hiddenRecipientNotices(), 'a former member reported as someone the server listed').toEqual([]);
        expect(recipients(), 'and the rotation off their key went ahead').toEqual([1]);
    });

    it('CONTROL: through the sidebar query, a poll in flight from before the join does not answer the read past the cache (second review, finding 3)', async () => {
        const me = await testIdentity(...ME);
        const newcomer = await testIdentity(...NEWCOMER);
        fake.memberKeys = [
            { user_id: 1, public_key: me.publicKeyEncoded },
            { user_id: 2, public_key: newcomer.publicKeyEncoded },
        ];
        const qc = new QueryClient();
        const key = (s: string) => ['servers', s, 'members'] as const;
        // The list the sidebar fetched before the newcomer joined, and its
        // next poll, in flight, whose query ran before the join as well.
        qc.setQueryData(key('s1'), [{ id: 1 }]);
        // Set inside the poll's executor, which control-flow narrowing cannot see.
        let answerPoll = null as ((rows: { id: number }[]) => void) | null;
        const poll = qc.fetchQuery({
            queryKey: key('s1'),
            queryFn: () => new Promise<{ id: number }[]>((resolve) => { answerPoll = resolve; }),
            staleTime: 0,
        }).catch(() => 'cancelled');
        const fetchMembers = vi.fn(async () => [{ id: 1 }, { id: 2 }]);
        const source = visibleMembersFromQueries(qc, key, fetchMembers);
        setVisibleMembersSource((serverId, fresh) => {
            const answer = source(serverId, fresh);
            // That poll answers only now, after the read past the cache was
            // asked for. Joined, it would hand that read the old list.
            if (fresh) setTimeout(() => answerPoll?.([{ id: 1 }]), 0);
            return answer;
        });
        try {
            await ensureChannelKey(42);

            expect(recipients(), 'a real new member refused on a list from before they joined').toEqual([1, 2]);
            expect(hiddenRecipientNotices()).toEqual([]);
            expect(fetchMembers, 'the read past the cache was a request of its own').toHaveBeenCalledTimes(1);
            expect(qc.getQueryData(key('s1')), 'and the sidebar now shows what the check read').toEqual([{ id: 1 }, { id: 2 }]);
        } finally {
            setVisibleMembersSource(null);
            answerPoll?.([{ id: 1 }]);
            await poll;
            qc.clear();
        }
    });
});
