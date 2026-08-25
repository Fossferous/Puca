/**
 * Arming THIS machine for unattended access — the host-side control surface.
 *
 * The crypto lives in `unattended.ts` (controller side: Argon2id + Ed25519) and
 * `crates/puca-ua` (host side: verify). This is the thin layer that stores
 * the resulting record on the machine being armed.
 *
 * WHAT ARMING MEANS, in the words the UI must use: this machine will accept
 * being controlled with nobody sitting at it, and — once the SYSTEM service
 * exists — before anyone has logged in. The passphrase is the only thing
 * standing between an account compromise and SYSTEM on this box, which is why it
 * is separate from the account password and why the server never sees it.
 *
 * THE COST, which must be stated BEFORE arming rather than discovered after:
 * there is no remote recovery. Forget the passphrase and the only fix is to come
 * to this machine and disarm it locally.
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../platform';
import { buildUaRecord } from './unattended';

export interface UaHostState {
    armed: boolean;
    /** Base64 Argon2id salt; present only when armed. */
    salt: string | null;
}

function toBase64(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

/** Unattended hosting needs the desktop app: a browser has no machine to arm. */
export function unattendedSupported(): boolean {
    return isTauri();
}

export async function unattendedState(): Promise<UaHostState> {
    if (!isTauri()) return { armed: false, salt: null };
    return invoke<UaHostState>('unattended_state');
}

/**
 * Arm with `passphrase`. Derives here and stores only the PUBLIC half.
 *
 * Returns an error message, or null on success — the same shape as the other
 * device toggles so the settings UI handles them alike.
 *
 * The passphrase is not returned, not logged, and not kept: it exists inside
 * this call and nowhere else.
 */
export async function armUnattended(passphrase: string): Promise<string | null> {
    if (!isTauri()) return 'Unattended access needs the desktop app.';
    if (passphrase.length < 8) {
        // Enforced here rather than only in the UI: this is the one secret with
        // no remote recovery and no server-side rate limit behind it, so a weak
        // one is worth refusing outright.
        return 'Use at least 8 characters — this is the only thing protecting unattended access.';
    }
    try {
        const record = buildUaRecord(passphrase);
        await invoke('unattended_arm', {
            saltB64: toBase64(Uint8Array.from(record.salt)),
            verifyingKeyB64: toBase64(Uint8Array.from(record.verifying_key)),
        });
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/** Turn unattended access off. Removing the record IS the revocation. */
export async function disarmUnattended(): Promise<string | null> {
    if (!isTauri()) return 'Unattended access needs the desktop app.';
    try {
        await invoke('unattended_disarm');
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/** A host's challenge to a controller. */
export interface UaChallenge {
    nonce: string;
    salt: string;
}

/**
 * Issue a challenge if this machine is armed, or null if it is not.
 *
 * Null means "no proof required" and the session proceeds — a machine nobody
 * armed does not demand a passphrase.
 */
export async function issueUaChallenge(): Promise<UaChallenge | null> {
    if (!isTauri()) return null;
    return (await invoke<UaChallenge | null>('unattended_challenge')) ?? null;
}

/**
 * Verify a controller's response. True only on a good signature.
 *
 * The REASON for a failure stays on the host: handing it to the peer would turn
 * this into an oracle telling an attacker whether a nonce was unknown, expired,
 * or merely mis-signed.
 */
export async function verifyUaResponse(
    nonce: string,
    context: string,
    signature: string,
): Promise<boolean> {
    if (!isTauri()) return false;
    try {
        await invoke('unattended_verify', { nonce, context, signature });
        return true;
    } catch {
        return false;
    }
}
