/**
 * The placeholder strings shown in place of content that could not be
 * decrypted, in ONE place.
 *
 * They were defined independently in three modules (servers.ts, dms.ts,
 * tasks.ts). That is fine for rendering — but anything that treats decrypted
 * content as TEXT has to be able to recognise them, and a per-file copy means
 * such a consumer silently misses whichever file it did not know about.
 * Search was the consumer that exposed it: typing "encrypted" or "key" matched
 * every message the user cannot read, presenting locked content as a hit.
 */

export const ENC_SIGN_IN = '[Encrypted — sign in to read]';
export const ENC_KEY_UNAVAILABLE = '[Encrypted — key unavailable]';
export const ENC_CANNOT_DECRYPT = '[Encrypted — cannot decrypt]';
/** The peer's identity key could not be pinned/verified (it differs from a
 *  previously pinned or out-of-band-verified value, i.e. a possible server
 *  key-substitution). We refuse to decrypt with an unverifiable key rather
 *  than present forged content as authentic. */
export const ENC_UNVERIFIED_SENDER = '[Encrypted — sender key unverified]';
/** Task-side wording (predates the shared marker set; kept for compatibility). */
export const TASK_DECRYPT_FAILED = '[Unable to decrypt]';
export const TASK_IDENTITY_LOCKED = '[Locked — log in again to decrypt]';

/** Every marker, for consumers that must exclude unreadable content. */
export const DECRYPT_FAILURE_MARKERS: ReadonlySet<string> = new Set([
    ENC_SIGN_IN,
    ENC_KEY_UNAVAILABLE,
    ENC_CANNOT_DECRYPT,
    ENC_UNVERIFIED_SENDER,
    TASK_DECRYPT_FAILED,
    TASK_IDENTITY_LOCKED,
]);

/**
 * True when `content` is a decrypt-failure placeholder rather than real text.
 *
 * Exact match, not a substring test: a message whose genuine text happens to
 * quote one of these strings is still a real message, and matching loosely
 * would silently hide it.
 */
export function isUndecryptable(content: string): boolean {
    return DECRYPT_FAILURE_MARKERS.has(content.trim());
}
