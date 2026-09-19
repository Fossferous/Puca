/**
 * `GET/PUT /sealed-blobs/:name` — one client-encrypted document per account
 * and name, with compare-and-swap (src/sealed_blob_handlers.rs).
 *
 * This module is transport only: it moves ciphertext and revision numbers.
 * Sealing is api/e2ee.ts (sealAccountBlob / openAccountBlob); what the
 * document means is its owner's business (notes/model/notesPrefsSync.ts).
 *
 * CAPABILITY. A backend without the route answers 404, and a backend WITH it
 * never does (an absent document is `{rev: 0, blob: null}`), so `unsupported`
 * is decided without depending on a row existing.
 */
import { apiClient, ApiError } from './client';

/** Must match MAX_SEALED_BLOB_BYTES in src/sealed_blob_handlers.rs. */
export const MAX_SEALED_BLOB_BYTES = 256 * 1024;

export type SealedBlobName = 'notes-prefs';

export interface SealedBlobDoc {
    rev: number;
    blob: string | null;
}

export type GetBlobResult = { kind: 'ok'; doc: SealedBlobDoc } | { kind: 'unsupported' };

export type PutBlobResult =
    | { kind: 'written'; rev: number }
    | { kind: 'conflict'; current: SealedBlobDoc }
    | { kind: 'too-large' }
    | { kind: 'unsupported' };

function asDoc(v: unknown): SealedBlobDoc | null {
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.rev !== 'number' || !Number.isSafeInteger(o.rev) || o.rev < 0) return null;
    if (o.blob !== null && typeof o.blob !== 'string') return null;
    return { rev: o.rev, blob: o.blob as string | null };
}

/** Read the current document. Throws on network and server errors (the
 *  caller decides between "offline" and "failed"); `unsupported` on 404. */
export async function getSealedBlob(name: SealedBlobName): Promise<GetBlobResult> {
    try {
        const doc = asDoc(await apiClient.get<unknown>(`/sealed-blobs/${name}`));
        if (!doc) throw new Error('The server answered /sealed-blobs with something else');
        return { kind: 'ok', doc };
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) return { kind: 'unsupported' };
        throw err;
    }
}

/**
 * Write `blob` if the server is still on `expectedRev` (0 = "there is no
 * document yet"). A conflict carries the current document so the caller can
 * merge onto it and retry. Oversize is refused HERE before anything is sent,
 * and a 413 from the server is reported the same way — never thrown away.
 */
export async function putSealedBlob(name: SealedBlobName, expectedRev: number, blob: string): Promise<PutBlobResult> {
    if (blob.length > MAX_SEALED_BLOB_BYTES) return { kind: 'too-large' };
    try {
        const r = await apiClient.put<{ rev?: unknown }>(`/sealed-blobs/${name}`, { expected_rev: expectedRev, blob });
        if (typeof r?.rev !== 'number') throw new Error('The server answered /sealed-blobs with something else');
        return { kind: 'written', rev: r.rev };
    } catch (err) {
        if (err instanceof ApiError) {
            if (err.status === 404) return { kind: 'unsupported' };
            if (err.status === 413) return { kind: 'too-large' };
            if (err.status === 409) {
                // The body is `{rev, blob}`; apiClient hands a body with no
                // message field back verbatim as the error's message.
                let parsed: unknown = null;
                try { parsed = JSON.parse(err.message); } catch { /* fall through */ }
                const current = asDoc(parsed);
                if (current) return { kind: 'conflict', current };
            }
        }
        throw err;
    }
}
