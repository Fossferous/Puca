/**
 * The two things every paste/drop target in Notes shares: whether an OS drag
 * is carrying files at all, and the words used when it cannot take them.
 *
 * `hasTransferFiles` is the preflight a dragover must pass BEFORE calling
 * preventDefault(): a drag of selected text, or of a note being reordered,
 * must keep its own default handling, and the drop affordance must only
 * light up for something a note can actually hold.
 *
 * Pure; no DOM, no network.
 */

/** True when this drag carries OS files (not text, not an internal drag). */
export function hasTransferFiles(dt: { types?: ArrayLike<string> | null } | null | undefined): boolean {
    if (!dt?.types) return false;
    return Array.from(dt.types).includes('Files');
}

/** Dropped/pasted something a note has no room for. */
export const ONLY_PICTURES = 'Only pictures can go in a note — the rest was left out';

/** An upload never queues (notes/model/notesQueries.ts), so a picture pasted
 *  with no connection is refused BEFORE it is attempted rather than after. */
export const PASTE_OFFLINE = 'Can’t add a picture while offline — a picture is uploaded, and uploads don’t wait in the queue';
