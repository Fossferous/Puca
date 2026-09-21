/**
 * Create keys — one random id per create, so a create the server committed
 * but never managed to answer is recognised on replay instead of being made
 * twice (migration 070; the server half is `op_key` in src/task_handlers.rs).
 *
 * THE ONE RULE: a key is RANDOM and is never derived from anything the user
 * typed. A digest of a title or an item would be a stable content
 * fingerprint the server could correlate across notes and accounts, and
 * brute-force for short or common texts — a create id must say only "this is
 * the same intent as the one before", never "this is the same text". Two
 * notes with identical titles therefore get different keys, which is pinned
 * by a test in tests/taskOpKey.test.ts.
 *
 * The key must be the SAME on every attempt at one create and different for
 * every other, so it is minted once when the user acts — stored on the
 * outbox op, or held by the caller across its own retries — never per
 * request.
 */

/** 22 url-safe characters of CSPRNG randomness (132 bits), inside the
 *  server's 16-64 shape check. `crypto.getRandomValues` exists in every
 *  browser Púca supports and in the test environment; the fallback is only
 *  so a missing crypto cannot break a create outright. */
export function newOpKey(): string {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const bytes = new Uint8Array(22);
    try {
        crypto.getRandomValues(bytes);
    } catch {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = '';
    for (const b of bytes) out += ALPHABET[b & 63];
    return out;
}

/** What the server accepts (src/task_handlers.rs `validate_op_key`). Exported
 *  so a test can prove the minted shape and the server's agree. */
export const OP_KEY_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;
