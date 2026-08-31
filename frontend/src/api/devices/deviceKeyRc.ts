/**
 * Remote-control-only half of the device keypair.
 *
 * Split out of deviceKey.ts so a build without remote control ships neither
 * these functions nor the Tauri commands they invoke (`device_key_dh`,
 * `device_key_forget`), both of which are compiled out of a lite shell. The
 * shared half — ensureDeviceKey/signWithDeviceKey, which device ATTESTATION
 * needs and push registration depends on — lives in api/deviceIdentity/deviceKey.ts
 * and ships in every build.
 */
import { x25519 } from '@noble/curves/ed25519';
import { isTauri } from '../platform';
import { fromBase64, invokeTauri, loadOrCreateWebKey, WEB_KEY_STORAGE } from '../deviceIdentity/deviceKey';

/**
 * X25519 shared secret with a peer device, base64.
 *
 * Returns the SECRET, never the key. This is the static half of a
 * device-control session handshake, and it is what makes that handshake
 * meaningful at all: between two devices of one account the ACCOUNT identity
 * keys are identical, so a static DH over them degenerates into self-DH and
 * authenticates nothing. Device keys are per-machine, so this actually proves
 * which machine is at the other end.
 *
 * Throws on a low-order peer point rather than returning a predictable secret,
 * so callers fail closed.
 */
export async function deviceKeyDh(peerPub: string): Promise<Uint8Array> {
    if (isTauri()) return fromBase64(await invokeTauri<string>('device_key_dh', { peerPub }));

    const material = loadOrCreateWebKey();
    const peer = peerPub.startsWith('x25519:') ? fromBase64(peerPub.slice(7)) : null;
    if (!peer || peer.length !== 32) throw new Error('peer key must be x25519:<32 bytes>');
    // noble throws on a zero/low-order result, which is the fail-closed
    // behaviour we want — do not catch it here.
    return x25519.getSharedSecret(material.slice(0, 32), peer);
}

/**
 * Discard this device's identity, so a later enrolment is genuinely a NEW
 * device rather than a resurrection of a revoked one.
 */
export async function forgetDeviceKey(): Promise<void> {
    if (isTauri()) {
        await invokeTauri<void>('device_key_forget');
        return;
    }
    localStorage.removeItem(WEB_KEY_STORAGE);
}

/**
 * Where this device's private key actually lives. Surfaced in the UI so a user
 * arming unattended access can see whether they are trusting an OS-protected
 * store or localStorage, rather than having to take it on faith.
 */
export function deviceKeyCustody(): 'os-protected' | 'browser-storage' {
    return isTauri() ? 'os-protected' : 'browser-storage';
}
