/**
 * Access to this device's keypair.
 *
 * On desktop the private keys live in Rust (`src-tauri/src/device_key.rs`) and
 * this module can only ask for the public halves and for signatures — it never
 * sees a secret. That is the whole point: a webview XSS must not be able to
 * walk off with a machine's identity, because a host device's key is what
 * authorises remote control of that machine.
 *
 * On web/mobile there is no Rust side, so the key is generated in JS and kept
 * in localStorage. That is a genuinely weaker store and it is why hosts refuse
 * unattended grants to `platform: 'web'` — a web device can be a CONTROLLER,
 * never an unattended host. Do not paper over that difference.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { isTauri } from '../platform';

export interface DevicePublicIdentity {
    /** `x25519:<base64>` */
    device_pub: string;
    /** `ed25519:<base64>` */
    sign_pub: string;
}

const WEB_KEY_STORAGE = 'sovereign_device_key_v1';

function toBase64(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
}

/** 64 bytes: 32 X25519 secret || 32 Ed25519 seed. Mirrors the Rust layout. */
function loadOrCreateWebKey(): Uint8Array {
    const stored = localStorage.getItem(WEB_KEY_STORAGE);
    if (stored) {
        try {
            const bytes = fromBase64(stored);
            if (bytes.length === 64) return bytes;
        } catch {
            // fall through and regenerate
        }
    }
    const material = crypto.getRandomValues(new Uint8Array(64));
    localStorage.setItem(WEB_KEY_STORAGE, toBase64(material));
    return material;
}

/** This device's public identity, creating the keypair on first call. */
export async function ensureDeviceKey(): Promise<DevicePublicIdentity> {
    if (isTauri()) return invokeTauri<DevicePublicIdentity>('device_key_ensure');

    const material = loadOrCreateWebKey();
    const xPub = x25519.getPublicKey(material.slice(0, 32));
    const edPub = ed25519.getPublicKey(material.slice(32));
    return {
        device_pub: `x25519:${toBase64(xPub)}`,
        sign_pub: `ed25519:${toBase64(edPub)}`,
    };
}

/**
 * Sign a transcript with the device signing key. Returns base64.
 *
 * The caller supplies the WHOLE message so there is exactly one definition of
 * what a device signature covers (see `attestationMessage` in identity.ts).
 */
export async function signWithDeviceKey(message: string): Promise<string> {
    if (isTauri()) return invokeTauri<string>('device_key_sign', { message });

    const material = loadOrCreateWebKey();
    const sig = ed25519.sign(new TextEncoder().encode(message), material.slice(32));
    return toBase64(sig);
}

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
