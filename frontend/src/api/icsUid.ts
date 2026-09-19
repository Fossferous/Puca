/**
 * A stable .ics UID for a PLAIN dated task (an item with a schedule uses the
 * schedule's own random uid). HMAC-SHA256 of the task id under a key derived
 * from the account's identity key, so:
 *   - exporting twice, or from two devices, gives the same UID — the
 *     receiving calendar updates the event instead of duplicating it — and a
 *     sign-out that scrubs local storage changes nothing;
 *   - the UID reveals neither the server, nor the user, nor the task id.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { getActiveIdentity } from './e2ee';

const INFO = new TextEncoder().encode('puca/ics-uid/v1');

export function icsUidKey(identityPrivateKey: Uint8Array): Uint8Array {
    return hkdf(sha256, identityPrivateKey, undefined, INFO, 32);
}

export function icsUidFor(taskId: number, key: Uint8Array): string {
    const mac = hmac(sha256, key, new TextEncoder().encode(`task:${taskId}`));
    return `${Array.from(mac.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')}@puca-notes`;
}

/** The uid function for this signed-in account; throws while locked. */
export function currentIcsUid(): (taskId: number) => string {
    const identity = getActiveIdentity();
    if (!identity) throw new Error('Unlock your encryption keys first — the export needs them to name events');
    const key = icsUidKey(identity.privateKey);
    return id => icsUidFor(id, key);
}
