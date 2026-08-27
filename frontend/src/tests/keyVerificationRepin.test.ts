import { describe, it, expect, beforeEach } from 'vitest';
import {
    markVerified,
    clearVerified,
    pinServedIdentityKey,
    identityPinConflicts,
    getVerificationState,
} from '../api/keyVerification';

/**
 * The safety-number trap.
 *
 * `pinServedIdentityKey` fails closed on a pin mismatch, and the app told users
 * to fix that by verifying the safety number — dms.ts: "Verify their safety
 * number before messaging", remoteControl: "Verify their identity". That could
 * not possibly work: `markVerified` wrote `verified_key_<id>` only, while the
 * refusal came from the separate `control_pin_<id>` store, so the block
 * survived. The sole escape was Settings → "Clear Local Storage & Reload",
 * which also destroys the user's own E2EE seed.
 *
 * Each user id here is unique per test because the pin stores are module-level
 * and localStorage persists across cases in a file.
 */

/**
 * A REAL localStorage for this file, mirroring backgroundDeliveryMigration.test.ts.
 *
 * The shared setup installs `vi.fn()` stubs that store nothing. The entire bug
 * under test is about which of two PERSISTENT stores a repair writes to, so
 * against those stubs `getItem` is always undefined — every pin gate would read
 * "nothing pinned yet" and the assertions would pass for the wrong reason.
 */
const backing = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
        getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
        setItem: (k: string, v: string) => { backing.set(k, String(v)); },
        removeItem: (k: string) => { backing.delete(k); },
        clear: () => { backing.clear(); },
    },
});

const KEY_A = 'x25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const KEY_B = 'x25519:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

let nextId = 9000;
const freshId = () => nextId++;

beforeEach(() => {
    localStorage.clear();
});

describe('verification repairs a pin it would otherwise be powerless against', () => {
    it('unblocks a peer whose key changed, which is what the UI tells users to do', () => {
        const user = freshId();
        // First contact pins A.
        expect(pinServedIdentityKey(user, KEY_A)).toBe(KEY_A);
        // The peer reinstalls; the server now serves B. Fail closed.
        expect(pinServedIdentityKey(user, KEY_B)).toBeNull();

        // The user compares the safety number out of band and confirms B.
        markVerified(user, KEY_B);

        // The block must now be gone — this is the assertion that fails without
        // the re-pin, and it is exactly the remediation the app instructs.
        expect(pinServedIdentityKey(user, KEY_B)).toBe(KEY_B);
        expect(identityPinConflicts(user, KEY_B)).toBe(false);
    });

    it('moves the persistent pin, not just the in-memory one', () => {
        const user = freshId();
        pinServedIdentityKey(user, KEY_A);
        markVerified(user, KEY_B);
        // The durable store is what survives a reload; if only memory moved, the
        // block would return on next launch.
        expect(localStorage.getItem(`control_pin_${user}`)).toBe(KEY_B);
    });

    it('still refuses a key the user never confirmed', () => {
        const user = freshId();
        pinServedIdentityKey(user, KEY_A);
        markVerified(user, KEY_B);
        // Verification moved trust to B only. A third key is still a substitution.
        const KEY_C = 'x25519:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=';
        expect(pinServedIdentityKey(user, KEY_C)).toBeNull();
        expect(identityPinConflicts(user, KEY_C)).toBe(true);
    });

    it('leaves the verification record itself intact', () => {
        const user = freshId();
        markVerified(user, KEY_A);
        expect(getVerificationState(user, KEY_A)).toBe('verified');
        expect(getVerificationState(user, KEY_B)).toBe('changed');
    });

    it('removing a verification does not silently re-open the peer to any key', () => {
        const user = freshId();
        markVerified(user, KEY_A);
        clearVerified(user);
        // Back to trust-on-first-use against the pin markVerified established:
        // dropping the confirmation must not drop the pin as well.
        expect(pinServedIdentityKey(user, KEY_A)).toBe(KEY_A);
        expect(pinServedIdentityKey(user, KEY_B)).toBeNull();
    });

    it('pins on first use when there is nothing to repair', () => {
        const user = freshId();
        expect(pinServedIdentityKey(user, KEY_A)).toBe(KEY_A);
        expect(localStorage.getItem(`control_pin_${user}`)).toBe(KEY_A);
    });
});
