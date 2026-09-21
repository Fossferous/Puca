/**
 * Showing a picture that has not been uploaded yet.
 *
 * A parked ref (api/parkedMedia.ts) names ciphertext held only on this
 * device. The bytes live in Púca Notes' sealed database, which is a Notes
 * concern, so the store REGISTERS itself here (notes/model/notesBlobs.ts)
 * and the shared picture components ask this module. Anywhere the store was
 * never registered — Púca's Tasks view, which has no offline queue — this
 * answers null and a parked ref simply does not render, which is correct:
 * those bytes are not on that page's device either.
 *
 * Object URLs are cached per parked id and revoked when the record is
 * forgotten, so the same picture is decrypted once however many places show
 * it, and a removed picture's plaintext does not linger in the document.
 */
import { decryptParkedBlobUrl } from './attachments';
import { bytesFromB64, parseParkedRef } from './parkedMedia';

/** What a registered store hands back for one parked id. */
export interface ParkedBytes {
    /** nonce || ciphertext, base64. */
    data: string;
    /** The AES key, base64url. */
    key: string;
    mime: string;
}

type Reader = (id: string) => Promise<ParkedBytes | null>;

let reader: Reader | null = null;

/** Called once by the store that holds parked media. */
export function setParkedReader(r: Reader | null): void {
    reader = r;
}

const urls = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** The object URL for a parked ref's plaintext, or null when it is not a
 *  parked ref, nothing is registered, or the bytes are gone. */
export function parkedObjectUrl(href: string): Promise<string | null> {
    const p = parseParkedRef(href);
    if (!p || !reader) return Promise.resolve(null);
    const cached = urls.get(p.id);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.get(p.id);
    if (pending) return pending;
    const run = (async () => {
        try {
            const rec = await reader?.(p.id);
            if (!rec) return null;
            const url = await decryptParkedBlobUrl(bytesFromB64(rec.data), rec.key, rec.mime || p.mime);
            urls.set(p.id, url);
            return url;
        } catch {
            return null;
        } finally {
            inflight.delete(p.id);
        }
    })();
    inflight.set(p.id, run);
    return run;
}

/** Forget (and revoke) the previews of parked records that are gone. */
export function revokeParkedPreviews(ids: Iterable<string>): void {
    for (const id of ids) {
        const url = urls.get(id);
        if (!url) continue;
        urls.delete(id);
        try { URL.revokeObjectURL(url); } catch { /* already gone */ }
    }
}

/** Revoke every parked preview (sign-out). */
export function clearParkedPreviews(): void {
    revokeParkedPreviews([...urls.keys()]);
}
