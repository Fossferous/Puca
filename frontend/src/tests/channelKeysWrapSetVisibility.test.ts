// @vitest-environment jsdom
/**
 * Audit 2026-10 (docs/AUDIT_2026-10.md, finding on forged channel membership).
 *
 * docs/E2EE.md and docs/SECURITY_MODEL.md §3 say that after the H-1 fix an
 * operator who wants the group key must forge channel MEMBERSHIP, "which puts
 * a stranger in the member list where a human can see them". The member list
 * a person sees is `GET /servers/:id/members-with-roles`
 * (hooks/queries.ts, useServerMembers). The set the channel key is wrapped
 * for — and the set a first-contact wrapper is attributed against — is
 * `GET /channels/:id/member-keys` (channelKeys.ts mintEpoch, attributeWrapper).
 * Nothing compares the two. A server that lists an extra id on member-keys
 * ONLY therefore gets the channel key wrapped for it by an honest client, and
 * the stranger never appears on screen.
 *
 * The first test DEMONSTRATES that (it passes against the current code: the
 * attacker id is in the published wrap set and the rendered list was never
 * asked). The second is the behaviour the docs describe, skipped until the
 * product decision in the audit document is made: which list is the one a
 * human sees, and whether a wrap set may be narrowed by it at the cost of a
 * send failing while the list is stale.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

const ME = ['me', 'a1'.repeat(16)] as const;
const STRANGER = ['stranger', 'c3'.repeat(16)] as const;

const fake = {
    /** What the channel-key code asks for: the wrap set. */
    memberKeys: [] as { user_id: number; public_key: string | null }[],
    /** What a person is shown: the server member list. */
    visibleMembers: [] as { id: number; username: string }[],
    /** The rows the server received on POST /keys. */
    posted: [] as { recipient_id: number; wrapped_key: string; sender_public_key: string }[],
    visibleListRequests: 0,
    reset() {
        this.memberKeys = [];
        this.visibleMembers = [];
        this.posted = [];
        this.visibleListRequests = 0;
    },
};

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 1 }));
vi.mock('../api/client', () => ({
    apiClient: {
        get: vi.fn(async (url: string) => {
            if (url.endsWith('/keys')) {
                // A channel with no keys yet: the caller bootstraps epoch 1.
                return { current_epoch: 0, max_epoch: 0, current_generation: 0, epoch_generation: 0, keys: [] };
            }
            if (url.endsWith('/member-keys')) return fake.memberKeys;
            if (url.endsWith('/members-with-roles')) {
                fake.visibleListRequests++;
                return fake.visibleMembers;
            }
            throw new Error('unexpected GET ' + url);
        }),
        post: vi.fn(async (url: string, body: { keys: typeof fake.posted }) => {
            if (url.endsWith('/keys')) {
                fake.posted = body.keys;
                return {};
            }
            throw new Error('unexpected POST ' + url);
        }),
    },
}));

import { setActiveIdentity } from '../api/e2ee';
import { ensureChannelKey, clearChannelKeyCache } from '../api/channelKeys';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

beforeAll(() => warmIdentities([ME, STRANGER]), WARM_TIMEOUT_MS);

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
        fake.visibleMembers = [{ id: 1, username: 'me' }];
    });

    it('DEMONSTRATES the finding: an id listed on member-keys only is wrapped for, and the visible list is never consulted', async () => {
        const got = await ensureChannelKey(42);
        expect(got).not.toBeNull();
        expect(got!.epoch).toBe(1);
        const recipients = fake.posted.map((k) => k.recipient_id).sort();
        // The channel key went to user 99, whom no screen shows.
        expect(recipients).toEqual([1, 99]);
        expect(fake.visibleListRequests).toBe(0);
    });

    // The behaviour docs/E2EE.md describes. Skipped, not failing: the fix needs
    // a product decision (docs/AUDIT_2026-10.md §6) — which list is "the
    // member list where you can see them", and whether a send may fail while
    // that list is stale — so it is recorded here rather than guessed at.
    it.skip('EXPECTED once fixed: the wrap set is limited to ids the person can see as members', async () => {
        const got = await ensureChannelKey(42);
        expect(got).not.toBeNull();
        const recipients = fake.posted.map((k) => k.recipient_id);
        expect(recipients).not.toContain(99);
        expect(fake.visibleListRequests).toBeGreaterThan(0);
    });
});
