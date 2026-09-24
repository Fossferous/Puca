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
import { ApiError } from './client';

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

/** The server's words for a key whose create DID happen, and whose row has
 *  since been deleted for good (src/task_handlers.rs `REPLAY_GONE_MESSAGE`,
 *  a plain-text 409). Byte for byte: a test holds the two together. */
export const REPLAY_GONE_MESSAGE = 'That was already created, and has since been removed';

/**
 * Whether a create was refused because its key already made something that
 * is gone now. Matched exactly — status AND words — because a 409 on a create
 * means other things too (a key spent on another kind of thing, a note in the
 * trash, an envelope refusal), and none of those may be mistaken for "that
 * one is gone, make another".
 */
export function isReplayGone(err: unknown): boolean {
    return err instanceof ApiError && err.status === 409 && err.message === REPLAY_GONE_MESSAGE;
}

/** One create key, held across the user's OWN retries. */
export interface HeldOpKey {
    /** The key for `intent`: the same one every time until it lands. */
    keyFor(intent: string): string;
    /** That create landed — the next one is a new intent. */
    landed(): void;
}

/**
 * A create key for a form that has no automatic retry.
 *
 * The offline outbox stores its key on the queued op, and the .ics import
 * mints one outside `withRetry`; a plain "type it and press the button"
 * create has neither. What it has is the user: a create that fails leaves the
 * typed text in the box and they press the button again. That second attempt
 * is the SAME intent, so it has to carry the SAME key, or a create the server
 * committed but could not answer becomes two rows — exactly what migration
 * 070 exists to stop.
 *
 * `intent` is a caller-made string that says "this is the same thing again"
 * (the target and the text). It never leaves the device and is never sent:
 * the key handed out is random, as api/opKey.ts's one rule requires. Only the
 * last intent is held, which is the shape of a retry — press the button
 * again, or change what you typed and start afresh.
 */
export function heldOpKey(): HeldOpKey {
    let held: { intent: string; key: string } | null = null;
    return {
        keyFor(intent: string): string {
            if (!held || held.intent !== intent) held = { intent, key: newOpKey() };
            return held.key;
        },
        landed(): void {
            held = null;
        },
    };
}
