/**
 * Sealing and opening a personal list's own content — the note text (`body`)
 * and the note-level attachments sidecar — added by migration 065.
 *
 * Both are encrypt-to-self envelopes, exactly like the list title, with ONE
 * difference that is the point of this module: these fields never held
 * plaintext, so the reader is STRICT. The title reader (`openSelf` in
 * tasks.ts) passes a non-envelope value through as legacy text, because
 * titles predate encryption. Doing the same here would let whoever controls
 * the database write a "note" that renders as the owner's own words; instead
 * a non-envelope value opens as a decrypt-failure marker, shown as unreadable
 * and refused by every writer (a marker is never sealed back — see
 * `sealSelfField`). The server refuses a non-envelope value on write too
 * (src/list_content.rs), so an honest server never stores one.
 *
 * Depends only on e2ee.ts and the marker set, so tasks.ts can import it
 * without a cycle.
 */
import { getActiveIdentity, encryptSelf, decryptSelf, parseEnvelopeEx, serializeEnvelope } from './e2ee';
import * as MARKERS from './decryptMarkers';

/** Seal owner-only text. Throws without an identity, and for a
 *  decrypt-failure marker (the original ciphertext would be replaced by the
 *  words of the error). */
export async function sealSelfField(plaintext: string): Promise<string> {
    if (MARKERS.isUndecryptable(plaintext)) {
        throw new Error('Refusing to store a decrypt-failure marker as content: the original ciphertext would be replaced by the words of the error');
    }
    const identity = getActiveIdentity();
    if (!identity) throw new Error('E2EE identity not available; cannot store note content');
    return serializeEnvelope(await encryptSelf(identity, plaintext));
}

/** Open a sealed list field. Never throws; a value that is not a v2 self
 *  envelope, or that does not open, becomes a marker. */
export async function openSelfField(stored: string): Promise<string> {
    const parsed = parseEnvelopeEx(stored);
    if (parsed.kind === 'unsupported-version') return MARKERS.ENC_UNSUPPORTED_VERSION;
    // STRICT: no plaintext pass-through (see the header).
    if (parsed.kind !== 'envelope') return MARKERS.TASK_DECRYPT_FAILED;
    if (parsed.env.t !== 'self') return MARKERS.TASK_DECRYPT_FAILED;
    if (parsed.env.v !== 2) return MARKERS.ENC_UNSUPPORTED_VERSION;
    const identity = getActiveIdentity();
    if (!identity) return MARKERS.TASK_IDENTITY_LOCKED;
    try {
        return (await decryptSelf(identity, parsed.env)) ?? MARKERS.TASK_DECRYPT_FAILED;
    } catch {
        return MARKERS.TASK_DECRYPT_FAILED;
    }
}

/** The list fields migration 065 added, as the server sends them. */
export interface ListContentWire {
    body?: string | null;
    attachments?: string | null;
    trashed_at?: string | null;
}

/** The same fields opened. Each is `undefined` when the server did not send
 *  the key at all (a server older than 065), `null` when the list has none,
 *  and otherwise the opened text — or a marker, never the envelope. */
export interface ListContentOpened {
    body?: string | null;
    attachments?: string | null;
    trashed_at?: string | null;
}

export async function openListContent(wire: ListContentWire): Promise<ListContentOpened> {
    const out: ListContentOpened = {};
    if ('body' in wire) out.body = wire.body ? await openSelfField(wire.body) : null;
    if ('attachments' in wire) out.attachments = wire.attachments ? await openSelfField(wire.attachments) : null;
    if ('trashed_at' in wire) out.trashed_at = wire.trashed_at ?? null;
    return out;
}
