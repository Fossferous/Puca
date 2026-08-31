import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// A stateful fake of the API server for one channel's key endpoints.
const fake = {
    currentEpoch: 0,
    currentGeneration: 0,
    epochGeneration: 0,
    // epoch -> wrapped rows addressed to the current user. `sender_user_id`
    // mirrors the real server, which stamps every row with the publisher's id
    // (key_handlers.rs binds it from claims.sub); the client pins that wrapper
    // key before unwrapping. NULL models a pre-migration-037 legacy row.
    published: [] as { epoch: number; wrapped_key: string; sender_public_key: string; member_generation: number; sender_user_id?: number | null }[],
    members: [] as { user_id: number; public_key: string | null }[],
    // Simulates the membership lookup being unreachable (offline, 403), which
    // must be distinguishable from "asked, and they are not a member".
    failMemberKeys: false,
    reset() {
        this.currentEpoch = 0;
        this.currentGeneration = 0;
        this.epochGeneration = 0;
        this.published = [];
        this.members = [];
        this.failMemberKeys = false;
    },
};

vi.mock('../api/client', () => ({
    apiClient: {
        get: vi.fn(async (url: string) => {
            if (url.endsWith('/keys')) {
                return {
                    current_epoch: fake.currentEpoch,
                    current_generation: fake.currentGeneration,
                    epoch_generation: fake.epochGeneration,
                    // The real get_channel_keys returns ALL epochs addressed to
                    // the user (so history decrypts), not just the current one.
                    keys: fake.published,
                };
            }
            if (url.endsWith('/member-keys')) {
                if (fake.failMemberKeys) throw new Error('member-keys unreachable');
                return fake.members;
            }
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
                // Store the row addressed to our own user id (1).
                const mine = body.keys.find((k) => k.recipient_id === 1);
                if (mine) {
                    fake.published.push({
                        epoch: body.epoch,
                        wrapped_key: mine.wrapped_key,
                        sender_public_key: mine.sender_public_key,
                        member_generation: body.member_generation,
                        // The real server stamps the publisher's id here (we are
                        // user 1 in these tests); the client pins it on read.
                        sender_user_id: 1,
                    });
                }
                return {};
            }
            throw new Error('unexpected POST ' + url);
        }),
    },
}));

import { setActiveIdentity, clearActiveIdentity, generateChannelKey, wrapChannelKeyForMembers } from '../api/e2ee';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

// Derived in beforeEach, so this was a ~380ms PBKDF2 per test. Warm once.
const ME = ['me', 'a1'.repeat(16)] as const;
// H-1 cases need a second and third identity. Warm them here too: deriving one
// inside a test is a ~380ms PBKDF2 and the source of the KDF timeout flake.
const ATTACKER = ['attacker', 'c3'.repeat(16)] as const;
const PEER = ['peer', 'd4'.repeat(16)] as const;

beforeAll(() => warmIdentities([ME, ATTACKER, PEER]), WARM_TIMEOUT_MS);
import { ensureChannelKey, getChannelKeyForEpoch, clearChannelKeyCache } from '../api/channelKeys';
import { apiClient } from '../api/client';
import { pinServedIdentityKey } from '../api/keyVerification';

// src/tests/setup.ts installs a localStorage whose methods are bare vi.fn(), so
// getItem ALWAYS returns undefined. Anything that reads back what it wrote —
// like the channel-key epoch floor — is therefore untestable against it, and a
// test written on top of it would pass no matter what the code did. Give this
// file a real in-memory store so the floor assertions below mean something.
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

describe('channelKeys manager', () => {
    beforeEach(async () => {
        fake.reset();
        clearChannelKeyCache();
        localStorage.clear(); // the epoch floor persists there; don't leak between tests
        const me = await testIdentity(...ME);
        setActiveIdentity(me);
        fake.members = [{ user_id: 1, public_key: me.publicKeyEncoded }];
    });

    it('bootstraps epoch 1 when no keys exist', async () => {
        const res = await ensureChannelKey(42);
        expect(res).not.toBeNull();
        expect(res!.epoch).toBe(1);
        expect(fake.currentEpoch).toBe(1);
    });

    it('returns the cached key without re-minting when generation is unchanged', async () => {
        const first = await ensureChannelKey(42);
        clearChannelKeyCache();
        const second = await ensureChannelKey(42);
        expect(Buffer.from(second!.key)).toEqual(Buffer.from(first!.key));
        expect(second!.epoch).toBe(1);
    });

    it('rotates to a new epoch when the member generation advances', async () => {
        const first = await ensureChannelKey(42);
        expect(first!.epoch).toBe(1);

        // Simulate a membership change: server generation advances.
        fake.currentGeneration = 1;
        clearChannelKeyCache();

        const rotated = await ensureChannelKey(42);
        expect(rotated!.epoch).toBe(2);
        expect(Buffer.from(rotated!.key)).not.toEqual(Buffer.from(first!.key));
        expect(fake.epochGeneration).toBe(1);
    });

    it('returns null when there is no active identity', async () => {
        clearActiveIdentity();
        clearChannelKeyCache();
        expect(await ensureChannelKey(42)).toBeNull();
    });

    // Positive control for the channel-key pin-bypass fix. A row wrapped with a
    // NULL sender_user_id is the exact shape a DB-write attacker (or a
    // key-substituting server) uses to forge the CURRENT epoch: before migration
    // 037 those rows were unwrapped and ADOPTED BLIND. The wrap below is valid
    // (it unwraps cleanly), so the pre-fix code path would set it as the current
    // key and return { epoch: 5, key: forgedKey } — the assertions below FAIL
    // against the vulnerable build (epoch 5, key === forgedKey). The fix refuses
    // the unverifiable key and ROTATES to a fresh verifiable epoch (6) that we
    // minted, so the attacker's key is never used and the channel keeps working.
    it('REFUSES an unverifiable null-wrapper key at the current epoch and rotates away', async () => {
        const me = await testIdentity(...ME);
        const forgedKey = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(me, forgedKey, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        fake.currentEpoch = 5;
        fake.currentGeneration = 0;
        fake.epochGeneration = 0;
        fake.published.push({
            epoch: 5,
            wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 0,
            sender_user_id: null, // legacy shape → not verifiable
        });
        clearChannelKeyCache();
        const res = await ensureChannelKey(42);
        expect(res).not.toBeNull();
        // Rotated to a fresh epoch, NOT the forged epoch 5...
        expect(res!.epoch).toBe(6);
        // ...and never adopted the attacker's key.
        expect(Buffer.from(res!.key)).not.toEqual(Buffer.from(forgedKey));
        expect(fake.currentEpoch).toBe(6);
    });

    // REGRESSION (prod incident 2026-08-10): a pre-037 channel whose CURRENT
    // epoch has a null-wrapper key that was never rotated by a send. The forged-
    // key defence refused it entirely, so READING it returned null and every
    // member saw "[Encrypted — key unavailable]" for the whole channel (this is
    // exactly the coffee-shop Bugs/Feature-requests checklists). The null-wrapper
    // key here is LEGITIMATE (the real channel key, just missing the wrapper-id
    // metadata), so it MUST be readable — while still never being ENCRYPTED under
    // (that stays the send-path's job; see the rotate test above).
    it('READS a legitimate null-wrapper key at the current epoch (regression: unreadable checklists)', async () => {
        const me = await testIdentity(...ME);
        const realKey = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(me, realKey, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        fake.currentEpoch = 1;
        fake.currentGeneration = 0;
        fake.epochGeneration = 0;
        fake.published.push({
            epoch: 1,
            wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 0,
            sender_user_id: null, // pre-037 legacy shape
        });
        clearChannelKeyCache();
        // The fix: the key is available for READING (this returned null on the
        // broken build — the whole regression).
        const readKey = await getChannelKeyForEpoch(42, 1);
        expect(readKey).not.toBeNull();
        expect(Buffer.from(readKey!)).toEqual(Buffer.from(realKey));
    });

    it('still ROTATES rather than SENDING under a null-wrapper current epoch, even though it now reads', async () => {
        // The send-side protection must survive the read fix: adopting the key
        // for reading must NOT let ensureChannelKey encrypt under it.
        const me = await testIdentity(...ME);
        const nullKey = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(me, nullKey, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        fake.currentEpoch = 3;
        fake.currentGeneration = 0;
        fake.epochGeneration = 0;
        fake.published.push({
            epoch: 3, wrapped_key: wrapped[0].wrappedKey, sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 0, sender_user_id: null,
        });
        clearChannelKeyCache();
        // Reading epoch 3 works...
        expect(await getChannelKeyForEpoch(42, 3)).not.toBeNull();
        // ...but SENDING rotates to a fresh verifiable epoch 4 and never uses the
        // null-wrapper key.
        const res = await ensureChannelKey(42);
        expect(res!.epoch).toBe(4);
        expect(Buffer.from(res!.key)).not.toEqual(Buffer.from(nullKey));
    });

    // ---- audit 2026-08-20 H-1 -------------------------------------------
    //
    // THE TEST GAP THAT LET H-1 THROUGH: every case above uses either a NULL
    // wrapper or a wrapper we have already pinned. Neither exercises the actual
    // hole, which is a NON-NULL wrapper id the victim has never pinned and never
    // will - one the server invents. pinServedIdentityKey is TOFU, so the old
    // code created a pin on the spot and reported the forged key as trusted.
    //
    // POSITIVE CONTROL: the wrap below is cryptographically valid (it unwraps
    // cleanly), and user 4242 is NOT in fake.members - a fabricated identity.
    // Against the pre-fix build these assertions FAIL: loadKeys pinned 4242,
    // never set currentRefusedUnverifiable, and ensureChannelKey returned
    // { epoch: 7, key: forgedKey } - the client encrypting under a key the
    // server chose. Proven red by reverting attributeWrapper to the old
    // `pinServedIdentityKey(...)` call.
    it('H-1: REFUSES to encrypt under a key wrapped by an UNPINNED, NON-MEMBER id', async () => {
        const attacker = await testIdentity(...ATTACKER);
        const me = await testIdentity(...ME);
        const forgedKey = generateChannelKey();
        // The attacker wraps a key of THEIR choosing, addressed to us, and
        // stamps the row with an id we have never seen.
        const wrapped = await wrapChannelKeyForMembers(attacker, forgedKey, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        fake.currentEpoch = 7;
        fake.currentGeneration = 0;
        fake.epochGeneration = 0;
        fake.published.push({
            epoch: 7,
            wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 0,
            sender_user_id: 4242, // never pinned, and NOT in fake.members
        });
        clearChannelKeyCache();

        const res = await ensureChannelKey(42);
        expect(res).not.toBeNull();
        // Rotated away to an epoch we minted ourselves...
        expect(res!.epoch).toBe(8);
        // ...and the server's chosen key was never adopted for sending.
        expect(Buffer.from(res!.key)).not.toEqual(Buffer.from(forgedKey));
    });

    // The other half of H-1's blast radius: reading must NOT be collateral
    // damage. An unattributable current-epoch key is still unwrapped, exactly
    // as the null-wrapper regression above requires - otherwise the fix
    // reintroduces the "[Encrypted - key unavailable]" outage under a new name.
    it('H-1: still READS the unattributable key it refuses to encrypt under', async () => {
        const attacker = await testIdentity(...ATTACKER);
        const me = await testIdentity(...ME);
        const someKey = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(attacker, someKey, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        fake.currentEpoch = 7;
        fake.published.push({
            epoch: 7, wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 0, sender_user_id: 4242,
        });
        clearChannelKeyCache();
        const readKey = await getChannelKeyForEpoch(42, 7);
        expect(readKey).not.toBeNull();
        expect(Buffer.from(readKey!)).toEqual(Buffer.from(someKey));
    });

    // CONVERGENCE - the risk the audit flagged against this fix ("two clients
    // that have not pinned each other can ping-pong rotations"). A wrapper we
    // have not pinned but WHO IS a published member of the channel, under the
    // same key, is attributable: this is an ordinary peer bootstrapping the
    // channel, and it must be adopted WITHOUT rotating. If this goes red the
    // fix has turned every send by a different member into a fresh epoch.
    it('H-1: ADOPTS an unpinned wrapper that IS a published member (no rotation)', async () => {
        const peer = await testIdentity(...PEER);
        const me = await testIdentity(...ME);
        const realKey = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(peer, realKey, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        fake.currentEpoch = 2;
        fake.currentGeneration = 0;
        fake.epochGeneration = 0;
        // The peer is a real member, published under the very key that wrapped.
        fake.members = [
            { user_id: 1, public_key: me.publicKeyEncoded },
            { user_id: 771, public_key: peer.publicKeyEncoded },
        ];
        fake.published.push({
            epoch: 2, wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 0, sender_user_id: 771,
        });
        clearChannelKeyCache();

        const res = await ensureChannelKey(42);
        expect(res).not.toBeNull();
        expect(res!.epoch).toBe(2);                                   // no rotation
        expect(Buffer.from(res!.key)).toEqual(Buffer.from(realKey));  // adopted theirs
        expect(fake.currentEpoch).toBe(2);
    });

    // A member id that IS published but under a DIFFERENT key than the one that
    // wrapped is the substitution case: it must not be adopted for sending even
    // though the id is a genuine member.
    it('H-1: refuses a published member whose wrapping key differs from their published one', async () => {
        const peer = await testIdentity(...PEER);
        const attacker = await testIdentity(...ATTACKER);
        const me = await testIdentity(...ME);
        const forgedKey = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(attacker, forgedKey, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        fake.currentEpoch = 4;
        // user 772 is a real member publishing PEER's key, but the row was
        // wrapped with the ATTACKER's key while claiming to be user 77.
        fake.members = [
            { user_id: 1, public_key: me.publicKeyEncoded },
            { user_id: 772, public_key: peer.publicKeyEncoded },
        ];
        fake.published.push({
            epoch: 4, wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 0, sender_user_id: 772,
        });
        clearChannelKeyCache();

        const res = await ensureChannelKey(42);
        expect(res!.epoch).toBe(5); // rotated away
        expect(Buffer.from(res!.key)).not.toEqual(Buffer.from(forgedKey));
    });

    // PERFORMANCE CONTRACT, not a nicety. The membership check added for H-1
    // sits on the send path, which already pays one forced GET per send. If it
    // re-asked every time it would double that for every channel whose current
    // epoch someone else minted - the common case. The confirmation is cached
    // for the session, so a second send must issue NO further member-keys
    // request. Goes red if that cache is removed or keyed wrongly.
    it('H-1: confirms a wrapper ONCE per session, not once per send', async () => {
        const peer = await testIdentity(...PEER);
        const me = await testIdentity(...ME);
        const realKey = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(peer, realKey, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        fake.currentEpoch = 2;
        fake.members = [
            { user_id: 1, public_key: me.publicKeyEncoded },
            { user_id: 773, public_key: peer.publicKeyEncoded },
        ];
        fake.published.push({
            epoch: 2, wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 0, sender_user_id: 773,
        });
        clearChannelKeyCache();

        const countMemberKeyGets = () =>
            vi.mocked(apiClient.get).mock.calls.filter(
                ([url]) => typeof url === 'string' && url.endsWith('/member-keys'),
            ).length;

        vi.mocked(apiClient.get).mockClear();
        const first = await ensureChannelKey(42);
        expect(first!.epoch).toBe(2);
        expect(countMemberKeyGets()).toBe(1);

        // Second send, same session: the wrapper is already confirmed.
        const second = await ensureChannelKey(42);
        expect(second!.epoch).toBe(2);
        expect(countMemberKeyGets(), 'membership must not be re-fetched per send').toBe(1);
    });

    // A membership lookup that FAILS is not evidence that the wrapper is
    // illegitimate. Falling back to the existing pin is what stops a dropped
    // connection from silently removing the ability to send in a channel that
    // was working a minute ago.
    it('H-1: a FAILED membership lookup falls back to an existing pin rather than blocking', async () => {
        const peer = await testIdentity(...PEER);
        const me = await testIdentity(...ME);
        const realKey = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(peer, realKey, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        // We already trust this identity from some earlier path (a DM, a call).
        pinServedIdentityKey(774, peer.publicKeyEncoded);

        fake.currentEpoch = 2;
        fake.published.push({
            epoch: 2, wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 0, sender_user_id: 774,
        });
        fake.failMemberKeys = true;
        clearChannelKeyCache();

        const res = await ensureChannelKey(42);
        expect(res).not.toBeNull();
        expect(res!.epoch).toBe(2);                                   // still usable
        expect(Buffer.from(res!.key)).toEqual(Buffer.from(realKey));
    });

    // The bypass this fix would otherwise have left in ITSELF. mintEpoch pins
    // every id the server lists as a member, and pins are permanent - so a
    // server could show a fabricated member once, let us pin it while wrapping,
    // withdraw it, and be trusted to DISTRIBUTE keys forever after on the
    // strength of that pin. Membership has to hold at the moment it is relied
    // on; goes red if attributeWrapper ever accepts a bare pin again.
    it('H-1: a PINNED id that is no longer a published member cannot distribute keys', async () => {
        const attacker = await testIdentity(...ATTACKER);
        const me = await testIdentity(...ME);
        const forgedKey = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(attacker, forgedKey, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        // The pin exists (this is exactly what mintEpoch would have created
        // while the fabricated member was briefly in the list)...
        pinServedIdentityKey(775, attacker.publicKeyEncoded);
        // ...but they are NOT in the member list now.
        fake.members = [{ user_id: 1, public_key: me.publicKeyEncoded }];
        fake.currentEpoch = 9;
        fake.published.push({
            epoch: 9, wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 0, sender_user_id: 775,
        });
        clearChannelKeyCache();

        const res = await ensureChannelKey(42);
        expect(res!.epoch).toBe(10); // rotated away despite holding a pin
        expect(Buffer.from(res!.key)).not.toEqual(Buffer.from(forgedKey));
    });

    // Sibling control: a HISTORICAL null-wrapper row (epoch below current) must
    // still be readable, so old history is not stranded by the fix. Here the
    // current epoch is a verifiable row we hold; an older null-sender epoch is
    // present too and must be unwrapped for reading.
    it('still unwraps a historical null-wrapper key below the current epoch', async () => {
        const me = await testIdentity(...ME);
        // Legit current epoch 2, stamped with our id (pinned + adopted).
        const cur = generateChannelKey();
        const curWrap = await wrapChannelKeyForMembers(me, cur, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        // Historical epoch 1, legacy null-sender.
        const old = generateChannelKey();
        const oldWrap = await wrapChannelKeyForMembers(me, old, [
            { userId: 1, publicKey: me.publicKeyEncoded },
        ]);
        fake.currentEpoch = 2;
        fake.currentGeneration = 0;
        fake.epochGeneration = 0;
        fake.published.push(
            { epoch: 1, wrapped_key: oldWrap[0].wrappedKey, sender_public_key: oldWrap[0].senderPublicKey, member_generation: 0, sender_user_id: null },
            { epoch: 2, wrapped_key: curWrap[0].wrappedKey, sender_public_key: curWrap[0].senderPublicKey, member_generation: 0, sender_user_id: 1 },
        );
        clearChannelKeyCache();
        const res = await ensureChannelKey(42);
        expect(res).not.toBeNull();
        expect(res!.epoch).toBe(2);
        expect(Buffer.from(res!.key)).toEqual(Buffer.from(cur));
    });
    // --- Epoch floor (anti-rollback) ------------------------------------
    //
    // The untrusted server names current_epoch. Without a floor it could name a
    // SUPERSEDED one and clients would go back to encrypting under a key an
    // ejected member still holds. The floor is only applied when we still hold
    // that epoch's key, because clamping unconditionally made the channel
    // permanently unsendable after a legitimate server-side key purge.

    it('stays on the higher epoch when the server rolls back and we hold its key', async () => {
        // Reach epoch 2 honestly, so both keys are published and held.
        const first = await ensureChannelKey(42);
        expect(first!.epoch).toBe(1);
        fake.currentGeneration = 1; // membership changed -> rotate
        const second = await ensureChannelKey(42);
        expect(second!.epoch).toBe(2);

        // The server now lies, naming the superseded epoch.
        fake.currentEpoch = 1;
        fake.epochGeneration = 1;
        clearChannelKeyCache();
        const after = await ensureChannelKey(42);
        expect(after).not.toBeNull();
        expect(after!.epoch).toBeGreaterThanOrEqual(2);
        expect(Buffer.from(after!.key)).toEqual(Buffer.from(second!.key));
    });

    it('accepts a lower epoch rather than bricking the channel when the key is gone', async () => {
        // POSITIVE CONTROL for the test above. Same rollback, but the client
        // holds no key for the floor — the state a server-side purge or a
        // restore from an older backup produces. Clamping here returned null
        // from ensureChannelKey forever, which is a self-inflicted denial of
        // service and exactly what a hostile server would want.
        localStorage.setItem('e2ee_epoch_floor_42', '9');
        const res = await ensureChannelKey(42);
        expect(res).not.toBeNull();
        expect(res!.epoch).toBeLessThan(9);
    });
});
