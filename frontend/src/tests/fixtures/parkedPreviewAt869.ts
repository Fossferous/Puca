/**
 * api/parkedPreview.ts as it was at 0.9.869 (45f95985), frozen, for one
 * control: e2e/plaintext-disk-real-browser.mjs shows a parked picture through
 * it and through today's module, and this one must FAIL the "let go when
 * nothing shows it" check: its preview was a page Blob cached until the
 * picture uploaded or the account signed out. Only the import paths differ,
 * attachments.ts's decryptParkedBlobUrl (gone since) is copied in below, and
 * the sign-out registration at its end is left out (the live module's is the
 * one that runs); nothing in the app imports this file.
 */
import { safeBlobType } from '../../api/attachments';
import { bytesFromB64, parseParkedRef } from '../../api/parkedMedia';

function fromB64url(s: string): Uint8Array {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** attachments.ts at 0.9.869. */
async function decryptParkedBlobUrl(bytes: Uint8Array, keyB64url: string, mime: string): Promise<string> {
    const nonce = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const key = await crypto.subtle.importKey('raw', fromB64url(keyB64url) as BufferSource, 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, ct as BufferSource);
    return URL.createObjectURL(new Blob([pt], { type: safeBlobType(mime) }));
}

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

/** Called once by the store that holds parked media. A sign-out does NOT
 *  unregister it and must not: the store answers nothing once the account's
 *  seed is gone (notesBlobs.ts `ctx`), and a sign-in as the same account in
 *  the same document would otherwise be left with no reader at all, because
 *  the registration happens when the module is first imported. What a
 *  sign-out does clear is the decrypted previews below. */
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

/**
 * Revoke every parked preview.
 *
 * Registered below as a sign-out cleanup, and that is what makes it run: the
 * ciphertext goes with the account's database (api/notesCacheScrub.ts), but
 * a decrypted picture's object URL lives in the DOCUMENT, and Notes' sign-out
 * navigates to its login inside the same page rather than reloading it.
 *
 * Through the registry rather than an import from `auth.ts`: these URLs
 * belong to the document that made them, which is exactly what a per-document
 * hook covers, and `auth.ts` importing this module puts it on the same import
 * path as the whole attachment stack (see api/logoutHooks.ts).
 */
export function clearParkedPreviews(): void {
    revokeParkedPreviews([...urls.keys()]);
}

