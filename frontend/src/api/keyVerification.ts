/**
 * Per-user identity-key verification state.
 *
 * When a user compares the safety number with a peer over a trusted channel and
 * marks them verified, we remember the EXACT public key that was verified. If the
 * server later serves a different key, the state becomes 'changed' — a loud
 * signal that the key was substituted (or the peer reset their account). This is
 * the durable anchor behind the out-of-band verification; the remote-control
 * channel already TOFU-pins keys, but verification upgrades that from
 * trust-on-first-use to trust-on-confirmation.
 */

export type VerificationState = 'verified' | 'changed' | 'unverified';

const keyOf = (userId: number) => `verified_key_${userId}`;

/** Verified state for a peer given the key currently in use for them. */
export function getVerificationState(userId: number, currentPubEncoded: string | null): VerificationState {
    if (!currentPubEncoded) return 'unverified';
    try {
        const verified = localStorage.getItem(keyOf(userId));
        if (!verified) return 'unverified';
        return verified === currentPubEncoded ? 'verified' : 'changed';
    } catch {
        return 'unverified';
    }
}

/**
 * Record that the user confirmed this exact key belongs to the peer.
 *
 * This ALSO re-pins the TOFU identity pin to the confirmed key, and that is the
 * point rather than a side effect. `pinServedIdentityKey` fails closed on a pin
 * mismatch, and the messages shown when it does — dms.ts's "Verify their safety
 * number before messaging", remoteControl's "Verify their identity" — told the
 * user to do something that could not possibly clear the block: marking verified
 * wrote `verified_key_` only, while the refusal came from the separate
 * `control_pin_` store, so gates 2 and 3 of pinServedIdentityKey still held the
 * old key. The only escape was Settings → "Clear Local Storage & Reload", which
 * also destroys the user's own E2EE seed — i.e. wrecking your identity to fix a
 * peer's pin. An out-of-band confirmation is a STRONGER signal than
 * trust-on-first-use, so it supersedes the pin instead of being ignored by it.
 */
export function markVerified(userId: number, pubEncoded: string): void {
    try {
        localStorage.setItem(keyOf(userId), pubEncoded);
    } catch {
        /* storage unavailable — verification won't persist, but the compare still happened */
    }
    // Declared in the pinning section below; function declarations hoist.
    repinIdentityKey(userId, pubEncoded);
}

/** Drop a verification (e.g. after a key change the user chooses to re-verify). */
export function clearVerified(userId: number): void {
    try {
        localStorage.removeItem(keyOf(userId));
    } catch {
        /* ignore */
    }
}

// --- TOFU pinning of the served identity key (shared by control + media) ---

import { getCachedPublicKey } from './dms';

const memPins = new Map<number, string>();
const pinKeyOf = (userId: number) => `control_pin_${userId}`;

/**
 * Apply TOFU-pin + verification to an ALREADY-fetched served key: pin it on
 * first use, and FAIL CLOSED (return null) if it differs from the in-memory /
 * localStorage pin, or if the user verified a key and this one differs. Use this
 * when the caller already holds the served key (e.g. wrapping a channel group
 * key for each member from the member-keys endpoint) so the same pin store —
 * `control_pin_<id>` and `verified_key_<id>` — gates every path. (audit M6)
 */
export function pinServedIdentityKey(userId: number, served: string | null): string | null {
    if (!served) return null;
    // Verified key wins: if the user confirmed a key and this differs, refuse.
    if (getVerificationState(userId, served) === 'changed') return null;
    const mem = memPins.get(userId);
    if (mem && mem !== served) return null;
    if (!mem) memPins.set(userId, served);
    try {
        const k = pinKeyOf(userId);
        const pinned = localStorage.getItem(k);
        if (pinned && pinned !== served) return null;
        if (!pinned) localStorage.setItem(k, served);
    } catch {
        /* no persistence; in-memory pin still applies */
    }
    return served;
}

/**
 * Overwrite the identity pin for a peer with a key the user has CONFIRMED.
 *
 * Deliberately the only way a pin is ever replaced — `pinServedIdentityKey`
 * writes one only when none exists, which is what makes a later substitution
 * loud. Reached exclusively from `markVerified`, i.e. after a human compared the
 * safety number out of band, because that is the one signal strong enough to
 * move a pin. A peer reinstalling or resetting their account is the ordinary
 * reason it needs to move, and before this there was no way to do it short of
 * clearing all of localStorage.
 *
 * Never call this with a key the user has not confirmed: doing so would turn the
 * fail-closed pin into a rubber stamp for whatever the server last served.
 */
export function repinIdentityKey(userId: number, pubEncoded: string): void {
    memPins.set(userId, pubEncoded);
    try {
        localStorage.setItem(pinKeyOf(userId), pubEncoded);
    } catch {
        /* no persistence; the in-memory pin above still applies this run */
    }
}

/**
 * Does `served` ALREADY match a pin (or verification) held for this id?
 *
 * READ-ONLY, and that is the entire point: unlike `pinServedIdentityKey` this
 * never creates a pin. Use it wherever trust has to rest on a pin established
 * through some OTHER path, because a check that pins-on-first-use cannot tell
 * "I already trusted this key" from "I have just decided to trust whatever I
 * was handed" — and an attacker who chooses the id being asked about gets the
 * second answer every time. (audit 2026-08-20 H-1)
 *
 * False means "not already trusted", covering both no-pin-yet and pinned-to-
 * something-else; callers wanting to distinguish a substitution use
 * `identityPinConflicts`.
 */
export function hasIdentityPin(userId: number, served: string | null): boolean {
    if (!served) return false;
    // Any conflict anywhere disqualifies, checked FIRST. The two stores can
    // disagree: pinServedIdentityKey writes the in-memory pin before it consults
    // localStorage, so a refused call can still leave a memory pin that storage
    // contradicts. Answering 'yes, trusted' off the memory half alone would then
    // hand out trust the pin function itself would have refused.
    if (identityPinConflicts(userId, served)) return false;
    if (memPins.get(userId) === served) return true;
    try {
        return localStorage.getItem(pinKeyOf(userId)) === served;
    } catch {
        return false;
    }
}

/**
 * Is this id pinned (or verified) to a DIFFERENT key than the one served?
 *
 * A conflict is a positive detection of substitution, not merely absence of
 * trust, so callers refuse the material outright rather than downgrading it.
 */
export function identityPinConflicts(userId: number, served: string | null): boolean {
    if (!served) return false;
    if (getVerificationState(userId, served) === 'changed') return true;
    const mem = memPins.get(userId);
    if (mem && mem !== served) return true;
    try {
        const pinned = localStorage.getItem(pinKeyOf(userId));
        return !!pinned && pinned !== served;
    } catch {
        return false;
    }
}

/**
 * Resolve a peer's identity public key with trust-on-first-use pinning: pin on
 * first use, and FAIL CLOSED (return null) if the server later serves a
 * different key — or if the user verified a key and the served one differs. The
 * in-memory pin catches a per-session swap even without localStorage.
 */
export async function resolvePinnedIdentityKey(userId: number): Promise<string | null> {
    return pinServedIdentityKey(userId, await getCachedPublicKey(userId));
}

// --- TOFU pinning of the ACCOUNT SIGNING key (device shares) ----------------
//
// A SECOND key with its own pin store, because it is a different key doing a
// different job: users.account_sign_pub is the Ed25519 key that signs device
// enrolment records, published so a FRIEND holding a device share can verify
// which machines belong to whom. Same trust posture as the X25519 identity
// key above — the server could substitute it on first contact; the pin is
// what makes any later substitution loud — and the same fail-closed rule:
// null means "refuse the session", never "carry on unauthenticated".

const signMemPins = new Map<number, string>();

/**
 * Pin-or-refuse an already-fetched account signing key. Returns the key when
 * it matches the pin (creating the pin on first use), null when it differs —
 * and a null here must abort whatever cross-user verification needed it.
 */
export function pinServedSigningKey(userId: number, served: string | null): string | null {
    if (!served) return null;
    const mem = signMemPins.get(userId);
    if (mem && mem !== served) return null;
    if (!mem) signMemPins.set(userId, served);
    try {
        const k = `sign_pin_${userId}`;
        const pinned = localStorage.getItem(k);
        if (pinned && pinned !== served) return null;
        if (!pinned) localStorage.setItem(k, served);
    } catch {
        /* no persistence; in-memory pin still applies */
    }
    return served;
}

/** Drop a signing-key pin — for the deliberate "they reset their account,
 *  trust the new key" path. Never called automatically. */
export function clearSigningKeyPin(userId: number): void {
    signMemPins.delete(userId);
    try {
        localStorage.removeItem(`sign_pin_${userId}`);
    } catch {
        /* ignore */
    }
}
