/**
 * The OTHER half of the device-control known-answer test.
 *
 * `crates/puca-agent/src/control_key.rs` pins the agent's derivation to a vector
 * that was produced by running THIS file's primitives. That pins Rust. Nothing
 * pinned TypeScript — so a change on this side would leave the Rust test happily
 * green while the controller derived a key the agent never produces.
 *
 * The symptom of that mismatch is the worst kind: remote control connects, the
 * session looks established at both ends, and every keystroke is silently
 * dropped. Nothing errors, because a wrong key does not announce itself — it
 * just fails to open sealed frames.
 *
 * This is not hypothetical. A rename changed the shared KDF label, and
 * separately a build staged the agent under a filename the bundler does not
 * resolve, so the installer shipped a stale agent carrying the OLD label. Both
 * would have produced exactly this failure, and the full suite was green.
 *
 * The vector is IDENTICAL to the one asserted in control_key.rs. That is the
 * entire point: two languages, one number. If you change the derivation, both
 * files must change together, and the vector must be regenerated from a
 * deliberate decision — never pasted from whatever the code currently prints,
 * which pins the bug instead of the contract.
 */
import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { deriveDeviceControlKey, encodePublicKey } from '../api/e2ee';

// Exactly the inputs control_key.rs uses.
const STATIC_SHARED = new Uint8Array(32).fill(7);
const A_PRIV = new Uint8Array(32).fill(1);
const B_PUB = 'x25519:zo060cy2M+x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk=';

const A_PUB_EXPECTED = 'x25519:pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk=';
const KEY_EXPECTED = '7edf227b446297e55de1318380afcd76a9a258ba581e7125deb17fba4ae7521a';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('device-control key (cross-language KAT)', () => {
    /**
     * Checked separately, for the reason the Rust test gives: the two encoded
     * public keys are sorted into the KDF info, so if THIS disagrees the key
     * mismatch below would be explained by encoding rather than by derivation.
     */
    it('encodes the ephemeral public key the way the agent expects', () => {
        expect(encodePublicKey(x25519.getPublicKey(A_PRIV))).toBe(A_PUB_EXPECTED);
    });

    it('derives the same key the agent derives, byte for byte', () => {
        const key = deriveDeviceControlKey(STATIC_SHARED, A_PRIV, B_PUB);
        expect(key).not.toBeNull();
        expect(hex(key as Uint8Array)).toBe(KEY_EXPECTED);
    });

    /**
     * Positive control. The assertion above compares against a constant, and
     * would be equally satisfied by a function that ignored its arguments. This
     * proves the derivation actually depends on its inputs — so the test is
     * measuring the derivation, not a hardcoded return.
     */
    it('produces a different key when any input changes', () => {
        const base = hex(deriveDeviceControlKey(STATIC_SHARED, A_PRIV, B_PUB) as Uint8Array);

        const otherShared = hex(
            deriveDeviceControlKey(new Uint8Array(32).fill(8), A_PRIV, B_PUB) as Uint8Array
        );
        const otherPriv = hex(
            deriveDeviceControlKey(STATIC_SHARED, new Uint8Array(32).fill(2), B_PUB) as Uint8Array
        );

        expect(otherShared).not.toBe(base);
        expect(otherPriv).not.toBe(base);
    });

    it('refuses a malformed peer key rather than deriving something', () => {
        expect(deriveDeviceControlKey(STATIC_SHARED, A_PRIV, 'not-a-key')).toBeNull();
    });

    /**
     * The label is the domain separator both ends bake in. It is shared wire
     * format, not branding — an agent built from a tree where it differs cannot
     * talk to a controller from this one, in either direction.
     */
    it('is derived under the label the agent also uses', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const root = join(__dirname, '..', '..', '..');

        const ts = readFileSync(join(root, 'frontend', 'src', 'api', 'e2ee.ts'), 'utf8');
        const rs = readFileSync(
            join(root, 'crates', 'puca-agent', 'src', 'control_key.rs'),
            'utf8'
        );

        const tsLabel = ts.match(/DEVICE_CONTROL_KDF_LABEL\s*=\s*'([^']+)'/)?.[1] ?? null;
        const rsLabel = rs.match(/LABEL[^=]*=\s*"([^"]+)"/)?.[1] ?? null;

        expect(tsLabel, 'no DEVICE_CONTROL_KDF_LABEL in api/e2ee.ts').not.toBeNull();
        expect(rsLabel, 'no label constant in control_key.rs').not.toBeNull();
        expect(rsLabel, 'the agent and the controller disagree on the KDF label').toBe(tsLabel);
    });
});
