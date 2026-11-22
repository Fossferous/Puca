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
 * The plaintext lives exactly as long as something shows it, like any
 * decrypted attachment (api/attachments.ts acquireAttachmentUrl): each
 * component that shows one takes a HOLD (components/useHeldParkedUrl.ts) and
 * lets it go when it stops; while any hold is out the same URL is shared, so
 * a picture on a card and in the editor is decrypted once. The URL is
 * registered by a plaintext host worker (api/plaintextHost.ts), never by the
 * page: when the last hold goes, the worker goes (or, a small picture in a
 * worker shared with others still shown, it is made to collect its garbage),
 * the page is made to collect its own, and any file Chromium paged the
 * plaintext to (blob_storage) is gone within seconds. Until 2026-11-22 a parked preview was a page Blob
 * cached until the picture uploaded or the account signed out: decrypted the
 * whole time a note waited for a connection, shown or not, and on disk under
 * memory pressure (e2e/plaintext-disk-real-browser.mjs measures both).
 */
import { openParkedBytes, safeBlobType } from './attachments';
import { registerLogoutCleanup } from './logoutHooks';
import { bytesFromB64, parseParkedRef } from './parkedMedia';
import { hostPlaintext, type PlainLease } from './plaintextHost';

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
 *  sign-out does take away is every decrypted preview below. */
export function setParkedReader(r: Reader | null): void {
    reader = r;
}

/** A parked picture's plaintext URL, for as long as it is held. */
export interface ParkedHold {
    readonly url: string;
    /** What the URL's bytes are typed as (safeBlobType of the parked type). */
    readonly type: string;
    /** Let it go. Twice does nothing. */
    release(): void;
}

interface Entry {
    holds: number;
    lease: PlainLease | null;
    opening: Promise<PlainLease | null> | null;
    type: string;
}

/** By parked id. An entry leaves this map when its last hold goes or its
 *  record is gone, and an open still on its way for an entry that left is
 *  let go as soon as it lands. */
const entries = new Map<string, Entry>();

function letGo(id: string, e: Entry): void {
    if (entries.get(id) === e) entries.delete(id);
    e.lease?.release();
    e.lease = null;
}

/**
 * Hold the plaintext URL of a parked ref: null when it is not a parked ref,
 * nothing is registered, or the bytes are gone (or could not be opened).
 * Release the hold once nothing on the page uses the URL: the render that
 * stops showing it first.
 */
export async function acquireParkedUrl(href: string): Promise<ParkedHold | null> {
    const p = parseParkedRef(href);
    if (!p || !reader) return null;
    let e = entries.get(p.id);
    if (!e) {
        e = { holds: 0, lease: null, opening: null, type: safeBlobType(p.mime) };
        entries.set(p.id, e);
    }
    const entry = e;
    entry.holds++;
    let held = true;
    const drop = () => {
        if (!held) return;
        held = false;
        entry.holds = Math.max(0, entry.holds - 1);
        if (entry.holds === 0 && !entry.opening) letGo(p.id, entry);
    };
    try {
        if (!entry.lease) {
            entry.opening ??= openEntry(p.id, p.mime, entry);
            await entry.opening;
        }
    } catch {
        drop();
        return null;
    }
    const lease = entry.lease as PlainLease | null;
    if (!lease || entries.get(p.id) !== entry) { drop(); return null; }
    return { url: lease.url, type: entry.type, release: drop };
}

function openEntry(id: string, parkedMime: string, e: Entry): Promise<PlainLease | null> {
    const run = (async () => {
        const rec = await reader?.(id);
        if (!rec || entries.get(id) !== e) return null;
        const pt = await openParkedBytes(bytesFromB64(rec.data), rec.key);
        e.type = safeBlobType(rec.mime || parkedMime);
        // Copied into the hosted Blob and emptied (freeNow).
        const lease = await hostPlaintext(pt, e.type);
        // Its record went (uploaded, removed, signed out) while it opened.
        if (entries.get(id) !== e) { lease.release(); return null; }
        e.lease = lease;
        return lease;
    })();
    return run.finally(() => {
        e.opening = null;
        if (e.holds === 0) letGo(id, e);
    });
}

/** Take back the previews of parked records that are gone (uploaded, or
 *  removed): every hold on them stops working. */
export function revokeParkedPreviews(ids: Iterable<string>): void {
    for (const id of ids) {
        const e = entries.get(id);
        if (e) letGo(id, e);
    }
}

/**
 * Take back every parked preview.
 *
 * Registered below as a sign-out cleanup, and that is what makes it run: the
 * ciphertext goes with the account's database (api/notesCacheScrub.ts), but
 * a decrypted picture's URL lives in the DOCUMENT, and Notes' sign-out
 * navigates to its login inside the same page rather than reloading it.
 *
 * Through the registry rather than an import from `auth.ts`: these URLs
 * belong to the document that made them, which is exactly what a per-document
 * hook covers, and `auth.ts` importing this module puts it on the same import
 * path as the whole attachment stack (see api/logoutHooks.ts).
 */
export function clearParkedPreviews(): void {
    revokeParkedPreviews([...entries.keys()]);
}

/** What is held now (tests, diagnostics). */
export function parkedPreviewStats(): { entries: number; hosted: number } {
    let hosted = 0;
    for (const e of entries.values()) if (e.lease) hosted++;
    return { entries: entries.size, hosted };
}

registerLogoutCleanup(clearParkedPreviews);
