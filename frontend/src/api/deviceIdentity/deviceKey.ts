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

export const WEB_KEY_STORAGE = 'sovereign_device_key_v1';

function toBase64(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
}

/** 64 bytes: 32 X25519 secret || 32 Ed25519 seed. Mirrors the Rust layout. */
export function loadOrCreateWebKey(): Uint8Array {
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
