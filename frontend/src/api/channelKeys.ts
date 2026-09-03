/**
 * Channel Key Manager
 * ===================
 *
 * Caches and distributes the symmetric per-channel "channel keys" (CKs) used for
 * group E2EE. Talks to the backend key endpoints:
 *
 *   GET  /channels/:id/keys         -> wrapped keys addressed to me + current epoch
 *   GET  /channels/:id/member-keys  -> public keys of all members (for wrapping)
 *   POST /channels/:id/keys         -> publish wrapped keys for an epoch
 *
 * A channel key never reaches the server unwrapped: we unwrap locally with our
 * identity key, and when bootstrapping we wrap it for each member's public key.
 */

import { apiClient, statusOf } from './client';
import {
    getActiveIdentity,
    generateChannelKey,
    wrapChannelKeyForMembers,
    unwrapChannelKey,
    type Identity,
    type WrappedChannelKey,
} from './e2ee';
import { pinServedIdentityKey, hasIdentityPin, identityPinConflicts } from './keyVerification';
import { currentUserIdFromToken } from './auth';

interface ChannelKeyState {
    currentEpoch: number;
    currentGeneration: number;   // server's current member generation
    epochGeneration: number;     // generation the current epoch was minted for
    keys: Map<number, Uint8Array>; // epoch -> channel key
    /** The CURRENT epoch's row addressed to us existed but its WRAPPER could
     *  not be attributed (a NULL-wrapper legacy row, or an identity we have no
     *  pin for and the server does not publish as a member of this channel).
     *  Signals ensureChannelKey to rotate AWAY to a fresh epoch we mint
     *  ourselves rather than encrypting under a key we cannot attribute.
     *  Distinct from "no current row for us", which stays a can't-send-yet
     *  (returns null). */
    currentRefusedUnverifiable?: boolean;
}

interface ServerKeysResponse {
    current_epoch: number;
    current_generation: number;
    epoch_generation: number;
    keys: {
        epoch: number;
        wrapped_key: string;
        sender_public_key: string;
        /** Who wrapped it. Absent on rows predating migration 037. */
        sender_user_id?: number | null;
    }[];
}

interface MemberKey {
    user_id: number;
    public_key: string | null;
}

// Per-channel in-memory cache. Cleared on logout via clearChannelKeyCache().
const cache = new Map<number, ChannelKeyState>();
/**
 * Wrappers confirmed as channel members this session: channelId -> "<id>|<key>".
 *
 * Exists so the membership check in attributeWrapper costs ONE extra request per
 * new wrapper per channel per session rather than one per send. Deliberately NOT
 * persisted: a confirmation is a statement about who was in the channel when we
 * looked, and it should expire with the session rather than harden into a
 * permanent grant the way an identity pin does.
 */
const confirmedWrappers = new Map<number, Set<string>>();
const wrapperTag = (userId: number, key: string) => `${userId}|${key}`;
const confirmedWrapper = (channelId: number, userId: number, key: string): boolean =>
    confirmedWrappers.get(channelId)?.has(wrapperTag(userId, key)) ?? false;
function rememberWrapper(channelId: number, userId: number, key: string): void {
    let set = confirmedWrappers.get(channelId);
    if (!set) { set = new Set(); confirmedWrappers.set(channelId, set); }
    set.add(wrapperTag(userId, key));
}
// De-duplicate concurrent loads for the same channel.
const inflight = new Map<number, Promise<ChannelKeyState>>();

/** Why we do - or do not - trust the identity that wrapped a channel-key row.
 *  Only 'trusted' may ever be ENCRYPTED under; 'unverifiable' is still READ. */
type WrapperTrust = 'trusted' | 'unverifiable' | 'conflict';

/**
 * Decide whether the wrapper of a channel-key row is an identity we can attribute.
 *
 * THE ATTACK THIS EXISTS TO STOP (audit 2026-08-20, H-1). The previous rule was
 * "pin the wrapper, then unwrap" - but the pin call was TOFU, so an id with no
 * prior pin got one CREATED on the spot and was reported back as trusted. A
 * server that stamped a row with an id no client had ever seen (or would ever
 * see through any other path) therefore had its own key adopted as the channel
 * key, and the client encrypted every subsequent message under it. It needed no
 * member's private key, worked against desktop users, was repeatable at every
 * epoch, and was invisible to everyone. TOFU is the right posture for a first
 * contact with a REAL peer; it is not a check at all when the adversary chooses
 * the identifier being asked about.
 */
async function attributeWrapper(
    channelId: number,
    row: ServerKeysResponse['keys'][number],
    identity: Identity,
    memberKeys: () => Promise<Map<number, string> | null>,
): Promise<WrapperTrust> {
    // 1. Pre-migration-037 rows carry no wrapper id. There is nothing to
    //    attribute them to, ever - readable, never encrypted under.
    //
    //    Checked BEFORE the self-wrap shortcut below, deliberately. A legacy row
    //    can carry our own key as its wrapper (we minted it, back when the id
    //    was not recorded), and trusting it on that basis would be sound
    //    cryptographically - but it would also quietly undo the rotate-away
    //    behaviour chosen after the 2026-08-10 incident, for no gain: rotating
    //    off a legacy epoch costs one mint and converges immediately.
    if (row.sender_user_id == null) return 'unverifiable';

    // 2. We wrapped it ourselves. Certain, with no lookup and no network call:
    //    the KEK is X25519(senderPriv, ourPub), so a row whose sender key is our
    //    own published key can only have been produced by the holder of our
    //    private key. A forgery that merely CLAIMS our key fails the GCM tag in
    //    unwrapChannelKey and never reaches the key map.
    if (row.sender_public_key === identity.publicKeyEncoded) return 'trusted';

    // 3. A key CONTRADICTING what we already pinned or verified for this id is a
    //    detected substitution: refuse the row outright rather than downgrade it.
    if (identityPinConflicts(row.sender_user_id, row.sender_public_key)) return 'conflict';

    // 4. Confirmed earlier THIS SESSION as a member of THIS channel under this
    //    exact key. Session-scoped on purpose - see the note in step 5 about why
    //    a permanent pin is not enough on its own - and the reason the steady
    //    state costs no extra request.
    if (confirmedWrapper(channelId, row.sender_user_id, row.sender_public_key)) return 'trusted';

    // 5. First contact with this wrapper for this channel. Accept only if the
    //    server ALSO publishes that id as a member of THIS channel under the
    //    very same key. That is the step the fabricated-id attack cannot satisfy
    //    without forging channel membership too - which puts a stranger in the
    //    member list where a human can see them, instead of leaving the attack
    //    invisible.
    //
    //    Note this deliberately does NOT accept a bare identity pin. Pins are
    //    permanent and mintEpoch creates one for every id the server lists as a
    //    member, so honouring a pin here would let a server show a fabricated
    //    member ONCE, have us pin it while wrapping, then withdraw it and still
    //    be trusted to distribute keys forever after. Membership has to hold at
    //    the moment we rely on it.
    const members = await memberKeys();
    if (members) {
        const published = members.get(row.sender_user_id);
        if (published && published === row.sender_public_key) {
            pinServedIdentityKey(row.sender_user_id, row.sender_public_key);
            rememberWrapper(channelId, row.sender_user_id, row.sender_public_key);
            return 'trusted';
        }
        return 'unverifiable';
    }

    // 6. The membership lookup FAILED (offline, 403) - which is not evidence of
    //    anything. Fall back to trust we already hold: an existing pin keeps
    //    working exactly as before, so a network partition cannot take away the
    //    ability to send in a channel that was fine a minute ago. It only means
    //    we decline to UPGRADE an unknown wrapper on no evidence.
    return hasIdentityPin(row.sender_user_id, row.sender_public_key) ? 'trusted' : 'unverifiable';
}

/** Fetch and unwrap all channel keys currently addressed to us. */
async function loadKeys(channelId: number): Promise<ChannelKeyState> {
    const identity = getActiveIdentity();
    const keys = new Map<number, Uint8Array>();
    if (!identity) return { currentEpoch: 0, currentGeneration: 0, epochGeneration: 0, keys };

    const resp: ServerKeysResponse = await apiClient.get(`/channels/${channelId}/keys`);
    let currentRefusedUnverifiable = false;

    // Member keys, fetched at most ONCE per load and only if some row actually
    // needs first-contact attribution (step 5 above). A failure leaves the map
    // empty, making every such wrapper 'unverifiable' - still read, just never
    // encrypted under. Fail closed on TRUST, open on READING: a blank channel is
    // a self-inflicted outage, and refusing to read protects no secret anyway
    // (whoever can forge the row can serve the ciphertext it decrypts too).
    let memberKeyCache: Map<number, string> | null = null;
    let memberKeysFailed = false;
    const memberKeys = async (): Promise<Map<number, string> | null> => {
        if (memberKeyCache) return memberKeyCache;
        if (memberKeysFailed) return null;
        try {
            const list: MemberKey[] = await apiClient.get(`/channels/${channelId}/member-keys`);
            const m = new Map<number, string>();
            for (const mk of list) if (mk.public_key) m.set(mk.user_id, mk.public_key);
            memberKeyCache = m;
            return m;
        } catch {
            // NULL means "could not ask", which is different from "asked, and
            // they are not a member". Conflating the two would turn a dropped
            // connection into a refusal to send.
            memberKeysFailed = true;
            return null;
        }
    };

    // Our own user id is the recipient a v3 wrap was bound to (recipient_id
    // in the row); a signed-out rig has none, and then no v3 wrap can open.
    const me = currentUserIdFromToken() ?? -1;
    for (const row of resp.keys) {
        // The conflict check runs at EVERY epoch, history included: it is free
        // (no network) and a substituted key for someone we already trust must
        // never be unwrapped, however old the row.
        if (
            row.sender_user_id != null &&
            row.sender_public_key !== identity.publicKeyEncoded &&
            identityPinConflicts(row.sender_user_id, row.sender_public_key)
        ) {
            console.warn(
                `[e2ee] channel ${channelId} epoch ${row.epoch}: refusing key - wrapper ` +
                `${row.sender_user_id}'s served key differs from the pinned/verified value`
            );
            continue;
        }

        // Only the CURRENT epoch can be encrypted under, so only it needs the
        // wrapper attributed - which keeps the member-keys lookup off the path
        // for the long tail of historical rows a busy channel accumulates.
        // Older rows are read on the strength of the conflict check above.
        if (row.epoch >= resp.current_epoch) {
            const trust = await attributeWrapper(channelId, row, identity, memberKeys);
            if (trust === 'conflict') {
                console.warn(
                    `[e2ee] channel ${channelId} epoch ${row.epoch}: refusing key - wrapper ` +
                    `${row.sender_user_id}'s served key differs from the pinned/verified value`
                );
                continue;
            }
            if (trust === 'unverifiable') {
                if (row.epoch === resp.current_epoch) currentRefusedUnverifiable = true;
                console.warn(
                    `[e2ee] channel ${channelId} epoch ${row.epoch}: UNVERIFIABLE key ` +
                    `(wrapper ${row.sender_user_id ?? 'unknown'} is neither pinned nor a ` +
                    `published member) - readable, but will rotate before sending`
                );
            }
        }

        // Unwrap for reading. Reached by: an attributed row, a historical row
        // that conflicts with nothing, or an unverifiable current-epoch row we
        // have just flagged for rotation.
        const wrapped: WrappedChannelKey = {
            recipientId: me,
            wrappedKey: row.wrapped_key,
            senderPublicKey: row.sender_public_key,
        };
        // The row's OWN channel and epoch, and our own id: a v3 wrap opens under
        // exactly that context and no other (a row lifted from elsewhere is null).
        //
        // Wrap-version floor (the epoch floor's sibling): a v2 wrap is bound to
        // nothing, so the binding above is only worth something once unbound
        // wraps stop being accepted. From the first v3 wrap this device opens
        // for the channel, an unprefixed wrap at that epoch or later is refused
        // — every 0.9.0 client publishes v3, so such a row is an older client
        // (update to fix) or a substitution. Earlier epochs stay readable.
        const isV3Wrap = row.wrapped_key.startsWith('v3.');
        const v3Since = wrapV3Since(channelId);
        if (!isV3Wrap && v3Since !== null && row.epoch >= v3Since) {
            console.warn(`[e2ee] channel ${channelId} epoch ${row.epoch}: refusing an unbound (v2) wrap at or above the v3 floor (${v3Since})`);
            continue;
        }
        const ck = await unwrapChannelKey(identity, wrapped, { channelId, epoch: row.epoch, recipientId: me });
        if (ck) {
            keys.set(row.epoch, ck);
            if (isV3Wrap && (v3Since === null || row.epoch < v3Since)) setWrapV3Since(channelId, row.epoch);
        }
    }
    // Epoch floor. `current_epoch` is whatever the untrusted server says it is,
    // and nothing remembered the highest this channel had already reached — so
    // the server could name a SUPERSEDED epoch and every client would go back to
    // encrypting under a key that an ejected member still holds. Rotation is the
    // one mechanism that removes someone's future read access; letting the party
    // being defended against choose the epoch number undoes it.
    //
    // The floor is only APPLIED when we actually hold that epoch's key. Clamping
    // unconditionally is what a first cut did, and it bricks the channel: with
    // `currentEpoch` set above anything in `keys`, ensureChannelKey finds no held
    // key, matches none of its branches, and returns null — "can't send
    // securely", permanently, because the floor never decreases. A server-side
    // key purge (see the membership_change_bumps_generation_and_purges_keys
    // test) or a restore from an older backup reaches that state legitimately.
    // Refusing to send is also exactly the denial-of-service a malicious server
    // would want, so the safe direction is: prefer the higher epoch when we can
    // still encrypt under it, otherwise take the server's word and say so.
    const floor = epochFloor(channelId);
    let currentEpoch = resp.current_epoch;
    if (resp.current_epoch < floor) {
        if (keys.has(floor)) {
            currentEpoch = floor;
            console.warn(
                `[e2ee] channel ${channelId}: server offered epoch ${resp.current_epoch} but this device ` +
                `already holds ${floor} — staying on ${floor} (rotation must not go backwards)`,
            );
        } else {
            console.warn(
                `[e2ee] channel ${channelId}: server offered epoch ${resp.current_epoch}, below the ${floor} ` +
                `this device has seen, and no key for ${floor} is held — accepting ${resp.current_epoch}. ` +
                `Expected after a server-side key purge or restore; suspicious otherwise.`,
            );
        }
    } else if (resp.current_epoch > floor) {
        raiseEpochFloor(channelId, resp.current_epoch);
    }
    return {
        currentEpoch,
        currentGeneration: resp.current_generation ?? 0,
        epochGeneration: resp.epoch_generation ?? 0,
        keys,
        currentRefusedUnverifiable,
    };
}

/**
 * Generate a fresh channel key, wrap it for every member with a v2 key, and
 * publish it as the given epoch stamped with `generation`. Returns the new key,
 * or null if E2EE can't be used (no identity / no members with keys).
 */
async function mintEpoch(
    channelId: number,
    epoch: number,
    generation: number
): Promise<Uint8Array | null> {
    const identity = getActiveIdentity();
    if (!identity) return null;

    console.debug(`[e2ee] mintEpoch(${channelId}) epoch=${epoch} gen=${generation}: fetching member keys`);
    const members: MemberKey[] = await apiClient.get(`/channels/${channelId}/member-keys`);
    // Pin each member's served identity key before wrapping the group key for it.
    // A server that substitutes one member's key would otherwise get the CK
    // wrapped for its key and recover the channel key; pinServedIdentityKey drops
    // (skips) any member whose served key changed from a previously pinned /
    // verified value, so we never wrap for a substituted key. (audit M6)
    const withKeys = members.reduce<{ userId: number; publicKey: string }[]>((acc, m) => {
        const pinned = pinServedIdentityKey(m.user_id, m.public_key);
        if (pinned) acc.push({ userId: m.user_id, publicKey: pinned });
        else if (m.public_key) console.warn(`[e2ee] mintEpoch(${channelId}) skipping user ${m.user_id}: served key differs from pinned/verified value`);
        return acc;
    }, []);
    console.debug(`[e2ee] mintEpoch(${channelId}) members=${members.length} withKeys=${withKeys.length}`);
    if (withKeys.length === 0) return null;

    const channelKey = generateChannelKey();
    const wrapped = await wrapChannelKeyForMembers(identity, channelKey, withKeys, { channelId, epoch });
    if (wrapped.length === 0) return null;
    console.debug(`[e2ee] mintEpoch(${channelId}) publishing ${wrapped.length} wrapped keys`);

    try {
        await apiClient.post(`/channels/${channelId}/keys`, {
            epoch,
            member_generation: generation,
            keys: wrapped.map((w) => ({
                recipient_id: w.recipientId,
                wrapped_key: w.wrappedKey,
                sender_public_key: w.senderPublicKey,
            })),
        });
        return channelKey;
    } catch (e) {
        // 409 = another member established this epoch at the same instant. Adopt
        // THEIR key (they wrapped it for us too, as a current member) so everyone
        // converges on one key for the epoch instead of a split. If they didn't
        // wrap it for us (they hadn't seen us as a member yet), we can't send this
        // round — return null; the next ensureChannelKey retries.
        if (statusOf(e) === 409) {
            console.debug(`[e2ee] mintEpoch(${channelId}) epoch=${epoch}: lost the race, adopting winner's key`);
            const fresh = await getState(channelId, true);
            return fresh.keys.get(epoch) ?? null;
        }
        throw e;
    }
}

async function getState(channelId: number, forceReload = false): Promise<ChannelKeyState> {
    if (!forceReload && cache.has(channelId)) return cache.get(channelId)!;
    if (inflight.has(channelId)) {
        console.debug(`[e2ee] getState(${channelId}) joining in-flight load (forceReload=${forceReload})`);
        return inflight.get(channelId)!;
    }

    console.debug(`[e2ee] getState(${channelId}) loading keys (forceReload=${forceReload})`);
    const p = loadKeys(channelId)
        .then((state) => {
            console.debug(`[e2ee] getState(${channelId}) loaded: epoch=${state.currentEpoch} gen=${state.currentGeneration} epochGen=${state.epochGeneration} keys=${state.keys.size}`);
            cache.set(channelId, state);
            return state;
        })
        .finally(() => inflight.delete(channelId));
    inflight.set(channelId, p);
    return p;
}

/**
 * Highest channel-key epoch this device has ever seen for `channelId`.
 *
 * Persisted so a server cannot roll a client back to a superseded epoch — the
 * key an ejected member still holds. Per browser profile, which is the right
 * grain: it records what THIS device observed.
 */
function epochFloor(channelId: number): number {
    try {
        return Number(localStorage.getItem(`e2ee_epoch_floor_${channelId}`) ?? '0') || 0;
    } catch {
        return 0; // private mode / storage disabled: no floor, no false alarms
    }
}

/**
 * Record a newly observed epoch, if it is higher than what we had.
 *
 * Called from BOTH the server-load path and every mint, because a mint makes an
 * epoch current WITHOUT a reload: without the mint call sites the floor lagged a
 * rotation by one, and a server could roll back to the epoch we had just
 * rotated away from — precisely the move the floor exists to stop.
 */
function raiseEpochFloor(channelId: number, epoch: number): void {
    if (epoch <= epochFloor(channelId)) return;
    try {
        localStorage.setItem(`e2ee_epoch_floor_${channelId}`, String(epoch));
    } catch {
        /* private mode */
    }
}

/**
 * Ensure a channel key exists that we can encrypt with, returning its epoch and
 * key. If the channel has no keys yet, bootstrap epoch 1 by generating a key and
 * wrapping it for every member. Returns null if E2EE can't be used (no identity,
 * or we're a new member nobody has wrapped the current key for yet).
 */
export async function ensureChannelKey(
    channelId: number
): Promise<{ epoch: number; key: Uint8Array } | null> {
    const identity = getActiveIdentity();
    if (!identity) return null;

    // Always refresh from the server before encrypting: the member generation
    // may have changed (someone kicked/joined) since this channel's state was
    // cached, and serving a stale generation here would keep encrypting under
    // an epoch the removed member still holds — breaking forward secrecy until
    // an app reload. One extra GET per send is the price of the E2EE promise.
    const state = await getState(channelId, true);

    // No keys yet: bootstrap epoch 1 for the current member generation.
    if (state.currentEpoch === 0) {
        const key = await mintEpoch(channelId, 1, state.currentGeneration);
        if (!key) return null;
        raiseEpochFloor(channelId, 1);
        cache.set(channelId, {
            currentEpoch: 1,
            currentGeneration: state.currentGeneration,
            epochGeneration: state.currentGeneration,
            keys: new Map([[1, key]]),
        });
        return { epoch: 1, key };
    }

    const held = state.keys.get(state.currentEpoch);

    // The current epoch's key is UNVERIFIABLE (null wrapper — see loadKeys). We
    // now hold it for READING, so this check MUST come before the held-key fast
    // path below, or we would encrypt under a key we cannot attribute. Rotate to
    // a fresh epoch we minted instead: that unblocks a genuine pre-037 legacy
    // channel and moves an attacked one off a forged key, without ever sending
    // under it. Convergent — the new epoch carries our own id, so the next load
    // pins it and stops rotating. Historical epochs stay readable throughout.
    if (state.currentRefusedUnverifiable) {
        const newEpoch = state.currentEpoch + 1;
        const key = await mintEpoch(channelId, newEpoch, state.currentGeneration);
        if (!key) return null; // e.g. no member keys yet — can't send this round
        const newKeys = new Map(state.keys);
        newKeys.set(newEpoch, key);
        raiseEpochFloor(channelId, newEpoch);
        cache.set(channelId, {
            currentEpoch: newEpoch,
            currentGeneration: state.currentGeneration,
            epochGeneration: state.currentGeneration,
            keys: newKeys,
        });
        return { epoch: newEpoch, key };
    }

    // We hold the current key and membership hasn't changed since it was minted.
    if (held && state.epochGeneration === state.currentGeneration) {
        return { epoch: state.currentEpoch, key: held };
    }

    // Membership changed: rotate to a new epoch wrapped only for current members.
    // Only a holder of the current key can rotate (so history stays readable).
    if (held) {
        const newEpoch = state.currentEpoch + 1;
        const key = await mintEpoch(channelId, newEpoch, state.currentGeneration);
        if (!key) {
            // Couldn't rotate (e.g. no members with keys); keep using current.
            return { epoch: state.currentEpoch, key: held };
        }
        const newKeys = new Map(state.keys);
        newKeys.set(newEpoch, key);
        raiseEpochFloor(channelId, newEpoch);
        cache.set(channelId, {
            currentEpoch: newEpoch,
            currentGeneration: state.currentGeneration,
            epochGeneration: state.currentGeneration,
            keys: newKeys,
        });
        return { epoch: newEpoch, key };
    }

    // A key exists but wasn't wrapped for us yet — we can't send securely.
    return null;
}

/**
 * Someone joined: give them a key they can write under.
 *
 * THE BUG THIS FIXES. A group key is wrapped per member, so a member who
 * joined after the current epoch was minted holds nothing. `ensureChannelKey`
 * returns null for them and the composer refuses with "this channel's
 * encryption key isn't available yet — try again in a moment". But nothing
 * made that moment arrive: the rotate-and-rewrap path only runs inside a
 * SEND, an EDIT, a task write or a voice join, so the newcomer stayed mute
 * until some existing member happened to write something. Invite a friend
 * while you are asleep and their first message fails, with copy promising a
 * recovery that nothing was going to deliver.
 *
 * So an existing holder does it for them, on the `MemberJoined` event. This
 * calls the ordinary path: `ensureChannelKey` sees the member generation has
 * moved, mints the next epoch and wraps it for every current member —
 * including whoever just arrived. History stays readable because only a
 * holder of the current key can rotate, which is unchanged.
 *
 * EVERY member runs this, so it is written to collapse to one rotation:
 *  - a short random delay staggers the clients, and
 *  - `ensureChannelKey` re-reads state first, so once the first client has
 *    rotated the rest see `epochGeneration === currentGeneration`, return the
 *    key they now hold, and publish nothing.
 * The 409 path in `mintEpoch` is the backstop for a genuine tie.
 *
 * Best-effort by construction: a channel this member cannot rotate (no key,
 * no permission, offline) is skipped silently — the send path still refuses
 * safely, exactly as before. Returns how many channels were rotated.
 */
export async function rewrapForMembershipChange(channelIds: number[]): Promise<number> {
    if (!getActiveIdentity() || channelIds.length === 0) return 0;
    // 0-1500ms. Cheap dispersion: with N members the expected number that get
    // as far as minting is ~1, and the rest cost one cached state read each.
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1500)));
    let rotated = 0;
    for (const channelId of channelIds) {
        try {
            const before = cache.get(channelId)?.currentEpoch ?? 0;
            const got = await ensureChannelKey(channelId);
            if (got && got.epoch > before) rotated++;
        } catch (e) {
            console.debug(`[e2ee] rewrapForMembershipChange(${channelId}) skipped:`, e);
        }
    }
    if (rotated > 0) console.log(`[e2ee] re-wrapped ${rotated} channel key(s) for the new member`);
    return rotated;
}

/**
 * Get the channel key for a specific epoch (to decrypt a historical message).
 * Reloads once from the server if the epoch isn't cached.
 */
export async function getChannelKeyForEpoch(
    channelId: number,
    epoch: number
): Promise<Uint8Array | null> {
    let state = await getState(channelId);
    if (state.keys.has(epoch)) return state.keys.get(epoch)!;
    // Maybe a peer just published a key for us; reload once.
    state = await getState(channelId, true);
    return state.keys.get(epoch) ?? null;
}

/** The lowest epoch this device has opened a v3 (context-bound) wrap for in
 *  `channelId`, or null when it has never seen one. Persists like the epoch
 *  floor; storage disabled = no floor, no false alarms. */
function wrapV3Since(channelId: number): number | null {
    try {
        const v = localStorage.getItem(`e2ee_wrap_v3_since_${channelId}`);
        return v === null ? null : (Number(v) || null);
    } catch {
        return null;
    }
}
function setWrapV3Since(channelId: number, epoch: number): void {
    try { localStorage.setItem(`e2ee_wrap_v3_since_${channelId}`, String(epoch)); } catch { /* no floor without storage */ }
}

/** Drop all cached channel keys (e.g. on logout). */
export function clearChannelKeyCache(): void {
    cache.clear();
    inflight.clear();
    confirmedWrappers.clear();
}
