/**
 * Epoch rollback and rotation fail-open (0.9.810 audit, C-01).
 *
 * Rotation is the ONE mechanism that removes an ejected member's future read
 * access. Three paths let the server undo it, all confirmed in the shipped
 * 0.9.810 code:
 *
 *  1. ROLLBACK. The floor guard tested `keys.has(floor)` — the EXACT floor
 *     value. A server that served every epoch BENEATH the floor while
 *     withholding the floor row failed that test and fell into "accepting the
 *     lower epoch", putting the device straight back on a superseded key.
 *  2. ROTATION FAIL-OPEN. When membership changed but the mint failed, the code
 *     kept using the current key. The failure is server-triggerable: an empty
 *     `/member-keys` response is enough, so a server could disable rotation for
 *     good while still reporting "membership changed".
 *  3. 409 ADOPTION. Losing the publish race adopted whatever key sat at the
 *     target epoch, with no wrapper attribution — and the target is derived
 *     from the server's own `max_epoch`, so the server chooses it.
 *
 * The fix rotates to FRESH key material instead of ever encrypting under a
 * below-floor served key, and keeps the floor strictly monotonic. That last
 * part is load-bearing: an earlier design re-based the floor down to each
 * freshly minted epoch, which put every epoch above it back in acceptable
 * range and made the rollback a two-round attack instead of a one-round one.
 * `the floor never drops` below pins it.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { ApiError } from '../api/client';

const fake = {
    currentEpoch: 0,
    maxEpoch: undefined as number | undefined,
    currentGeneration: 0,
    epochGeneration: 0,
    published: [] as { epoch: number; wrapped_key: string; sender_public_key: string; member_generation: number; sender_user_id?: number | null }[],
    members: [] as { user_id: number; public_key: string | null }[],
    /** Publishes answer 409, modelling another member owning that epoch. */
    conflictOnPublish: false,
    reset() {
        this.currentEpoch = 0;
        this.maxEpoch = undefined;
        this.currentGeneration = 0;
        this.epochGeneration = 0;
        this.published = [];
        this.members = [];
        this.conflictOnPublish = false;
    },
};

// FULL replacement, not a partial one: a partial mock of auth calls importOriginal,
// the real auth imports channelKeys, and channelKeys imports client while ITS
// partial mock is still being built - that cycle handed channelKeys the REAL
// http client (401s from whatever listens on :3000). channelKeys409.test.ts has
// the same shape for the same reason.
vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 1, getToken: () => null, storeRenewedToken: () => {} }));
// Keep the real module's exports (mintEpoch reads `statusOf` to recognise the
// 409); replace only the transport.
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return {
    ...real,
    apiClient: {
        get: vi.fn(async (url: string) => {
            if (url.endsWith('/keys')) {
                return {
                    current_epoch: fake.currentEpoch,
                    max_epoch: fake.maxEpoch ?? fake.currentEpoch,
                    current_generation: fake.currentGeneration,
                    epoch_generation: fake.epochGeneration,
                    keys: fake.published,
                };
            }
            if (url.endsWith('/member-keys')) return fake.members;
            throw new Error('unexpected GET ' + url);
        }),
        post: vi.fn(async (url: string, body: {
            epoch: number;
            member_generation: number;
            keys: Array<{ recipient_id: number; wrapped_key: string; sender_public_key: string }>;
        }) => {
            if (!url.endsWith('/keys')) throw new Error('unexpected POST ' + url);
            if (fake.conflictOnPublish) throw new ApiError('epoch already established', 409);
            fake.currentEpoch = body.epoch;
            fake.maxEpoch = Math.max(fake.maxEpoch ?? 0, body.epoch);
            fake.epochGeneration = body.member_generation;
            const mine = body.keys.find((k) => k.recipient_id === 1);
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
        }),
    },
    };
});

import { setActiveIdentity, wrapChannelKeyForMembers, generateChannelKey } from '../api/e2ee';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const ME = ['me', 'a1'.repeat(16)] as const;
beforeAll(() => warmIdentities([ME]), WARM_TIMEOUT_MS);

import { ensureChannelKey, clearChannelKeyCache } from '../api/channelKeys';

// setup.ts's localStorage is bare vi.fn()s that store NOTHING, so the epoch
// floor would read back undefined and every assertion here would be vacuous.
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

const CH = 42;
const floorOf = () => Number(localStorage.getItem(`e2ee_epoch_floor_${CH}`) ?? '0');
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

describe('a rolled-back epoch is never encrypted under', () => {
    let me: Awaited<ReturnType<typeof testIdentity>>;

    beforeEach(async () => {
        fake.reset();
        clearChannelKeyCache();
        localStorage.clear();
        me = await testIdentity(...ME);
        setActiveIdentity(me);
        fake.members = [{ user_id: 1, public_key: me.publicKeyEncoded }];
    });

    /** Publish a genuine row for `epoch` carrying `key`, as a real member would. */
    async function serveGenuineRow(epoch: number, key: Uint8Array) {
        const wrapped = await wrapChannelKeyForMembers(
            me, key, [{ userId: 1, publicKey: me.publicKeyEncoded }], { channelId: CH, epoch },
        );
        fake.published.push({
            epoch,
            wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 0,
            sender_user_id: 1,
        });
    }

    it('withholding ONLY the floor row does not roll the device back', async () => {
        // Reach epoch 3 honestly: floor 3, and rows for 1..3 exist.
        const first = await ensureChannelKey(CH);
        fake.currentGeneration = 1;
        const second = await ensureChannelKey(CH);
        fake.currentGeneration = 2;
        const third = await ensureChannelKey(CH);
        expect(third!.epoch).toBe(3);
        expect(floorOf()).toBe(3);

        // The server now withholds ONLY the floor row and names epoch 1. The old
        // guard asked `keys.has(3)` — false — and accepted 1.
        fake.published = fake.published.filter((r) => r.epoch !== 3);
        fake.currentEpoch = 1;
        fake.maxEpoch = 1;
        fake.epochGeneration = 2;
        clearChannelKeyCache();

        const after = await ensureChannelKey(CH);
        expect(after).not.toBeNull();
        // Not merely "not epoch 1": epoch 2 is ALSO below the floor and also a
        // key an ejected member may hold. The only acceptable outcome is fresh
        // material at or above the floor.
        expect(after!.epoch).toBeGreaterThanOrEqual(3);
        for (const old of [first!, second!, third!]) {
            expect(b64(after!.key)).not.toBe(b64(old.key));
        }
        expect(floorOf()).toBeGreaterThanOrEqual(3);
    });

    it('the two-round replay is refused: the floor never drops', async () => {
        // THE ATTACK that broke the first design. Round 1 forces a fresh mint;
        // if that mint re-based the floor downwards, round 2's replayed genuine
        // row would sit ABOVE the new floor and be adopted for sending.
        localStorage.setItem(`e2ee_epoch_floor_${CH}`, '9');

        // Round 1: a purge-shaped response. The device mints fresh material.
        fake.currentEpoch = 0;
        fake.maxEpoch = 0;
        const round1 = await ensureChannelKey(CH);
        expect(round1).not.toBeNull();
        expect(floorOf()).toBe(9); // NOT re-based down to the freshly minted epoch

        // Round 2: the server replays a GENUINE superseded epoch-5 row whose key
        // the ejected member still holds. It attributes as trusted (we wrapped
        // it ourselves), unwraps cleanly, and its generations agree.
        const ejectedKey = generateChannelKey();
        fake.published = [];
        await serveGenuineRow(5, ejectedKey);
        fake.currentEpoch = 5;
        fake.maxEpoch = 5;
        fake.currentGeneration = 0;
        fake.epochGeneration = 0;
        clearChannelKeyCache();

        const round2 = await ensureChannelKey(CH);
        expect(round2).not.toBeNull();
        expect(b64(round2!.key)).not.toBe(b64(ejectedKey));
        expect(floorOf()).toBe(9);
    });

    it('POSITIVE CONTROL: with no floor, that same replayed row IS adopted', async () => {
        // Proves the rig can observe the leak — without it the test above could
        // pass because the fixture never delivers the key at all.
        const ejectedKey = generateChannelKey();
        await serveGenuineRow(5, ejectedKey);
        fake.currentEpoch = 5;
        fake.maxEpoch = 5;
        clearChannelKeyCache();

        const res = await ensureChannelKey(CH);
        expect(res).not.toBeNull();
        expect(res!.epoch).toBe(5);
        expect(b64(res!.key)).toBe(b64(ejectedKey));
    });

    it('a genuine restore still converges instead of bricking', async () => {
        // The scenario the fail-open existed to protect: the server is restored
        // from a backup older than anything this device holds. It must keep
        // sending — under fresh material — and climb back, not return null.
        localStorage.setItem(`e2ee_epoch_floor_${CH}`, '6');
        fake.currentEpoch = 0;
        fake.maxEpoch = 0;

        let last = 0;
        for (let i = 0; i < 8; i++) {
            const res = await ensureChannelKey(CH);
            expect(res, `send ${i} must not be refused`).not.toBeNull();
            expect(res!.epoch).toBeGreaterThan(last);
            last = res!.epoch;
            clearChannelKeyCache();
            if (last >= 6) break;
        }
        expect(last).toBeGreaterThanOrEqual(6);
    });
});

describe('a rotation that cannot be minted fails closed', () => {
    beforeEach(async () => {
        fake.reset();
        clearChannelKeyCache();
        localStorage.clear();
        const me = await testIdentity(...ME);
        setActiveIdentity(me);
        fake.members = [{ user_id: 1, public_key: me.publicKeyEncoded }];
    });

    it('refuses to send under the superseded epoch when /member-keys comes back empty', async () => {
        const first = await ensureChannelKey(CH);
        expect(first!.epoch).toBe(1);

        // Membership changed — and the server suppresses the member list, which
        // is all it takes to make mintEpoch return null.
        fake.currentGeneration = 1;
        fake.members = [];
        clearChannelKeyCache();

        const res = await ensureChannelKey(CH);
        expect(res).toBeNull();
    });

    it('POSITIVE CONTROL: with the member list served, the same rotation succeeds', async () => {
        const me = await testIdentity(...ME);
        const first = await ensureChannelKey(CH);
        expect(first!.epoch).toBe(1);

        fake.currentGeneration = 1;
        fake.members = [{ user_id: 1, public_key: me.publicKeyEncoded }];
        clearChannelKeyCache();

        const res = await ensureChannelKey(CH);
        expect(res).not.toBeNull();
        expect(res!.epoch).toBe(2);
        expect(b64(res!.key)).not.toBe(b64(first!.key));
    });
});

describe('a 409 only adopts a key it can attribute', () => {
    let me: Awaited<ReturnType<typeof testIdentity>>;

    beforeEach(async () => {
        fake.reset();
        clearChannelKeyCache();
        localStorage.clear();
        me = await testIdentity(...ME);
        setActiveIdentity(me);
        fake.members = [{ user_id: 1, public_key: me.publicKeyEncoded }];
    });

    it('refuses a winner whose wrapper cannot be attributed', async () => {
        // A legacy null-wrapper row sits at the epoch our rotation targets, and
        // the publish 409s. Adopting it would send under a key we cannot
        // attribute to any published member.
        const first = await ensureChannelKey(CH);
        expect(first!.epoch).toBe(1);

        const squatted = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(
            me, squatted, [{ userId: 1, publicKey: me.publicKeyEncoded }], { channelId: CH, epoch: 2 },
        );
        fake.published.push({
            epoch: 2,
            wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 1,
            sender_user_id: null, // unattributable
        });
        fake.currentGeneration = 1;
        fake.conflictOnPublish = true;
        clearChannelKeyCache();

        const res = await ensureChannelKey(CH);
        if (res !== null) expect(b64(res.key)).not.toBe(b64(squatted));
    });

    it('POSITIVE CONTROL: an attributable winner at the same epoch IS adopted', async () => {
        // Identical to the case above EXCEPT the wrapper is attributable, so a
        // pass here proves the refusal is about attribution and not about the
        // rig failing to deliver a key at all. The generations must disagree,
        // or ensureChannelKey returns via the held-key fast path and never
        // reaches the 409 adoption branch — which would make this vacuous.
        const first = await ensureChannelKey(CH);
        expect(first!.epoch).toBe(1);

        const winner = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(
            me, winner, [{ userId: 1, publicKey: me.publicKeyEncoded }], { channelId: CH, epoch: 2 },
        );
        fake.published.push({
            epoch: 2,
            wrapped_key: wrapped[0].wrappedKey,
            sender_public_key: wrapped[0].senderPublicKey,
            member_generation: 1,
            sender_user_id: 1, // a published member — attributable
        });
        fake.currentGeneration = 1; // != epochGeneration 0 -> must rotate
        fake.conflictOnPublish = true;
        clearChannelKeyCache();

        const res = await ensureChannelKey(CH);
        expect(res).not.toBeNull();
        expect(res!.epoch).toBe(2);
        expect(b64(res!.key)).toBe(b64(winner));
    });
});
