/**
 * Refs for media sealed on THIS DEVICE and not yet uploaded.
 *
 * The href of a parked ref is `puca-parked:<id>?m=<mime>` — a local name, not
 * a server one. It lives in this device's own view of a note's sidecar (the
 * query cache, and the sealed on-device cache behind it) so the note looks
 * finished while it waits for a connection, and it is stripped from anything
 * sealed FOR the server (api/listContent.ts `setTaskListAttachments`): a
 * parked href names bytes only this device holds, so another device could
 * never open it.
 *
 * Pure, and imports nothing but a type, so both api/noteMedia.ts and
 * api/listContent.ts can use it without a cycle.
 */
import { type TaskAttachmentRef } from './tasks';

export const PARKED_PREFIX = 'puca-parked:';

export function parkedHref(id: string, mime: string): string {
    return `${PARKED_PREFIX}${id}?m=${encodeURIComponent(mime)}`;
}

/** TOTAL: null for anything that is not a parked ref, never a throw. */
export function parseParkedRef(href: string): { id: string; mime: string } | null {
    if (href.slice(0, PARKED_PREFIX.length).toLowerCase() !== PARKED_PREFIX) return null;
    const [id, query = ''] = href.slice(PARKED_PREFIX.length).split('?');
    if (!id) return null;
    let mime = 'application/octet-stream';
    try {
        const m = new URLSearchParams(query).get('m');
        if (m) mime = m;
    } catch { /* keep the generic type */ }
    return { id, mime };
}

export function isParkedRef(ref: TaskAttachmentRef): boolean {
    return parseParkedRef(ref.href) !== null;
}

/** Refs the server may be told about: everything still parked is dropped. */
export function withoutParked(refs: TaskAttachmentRef[]): TaskAttachmentRef[] {
    return refs.filter(r => !isParkedRef(r));
}

/** The parked ids a sidecar names, in order. */
export function parkedIdsOf(refs: TaskAttachmentRef[]): string[] {
    return refs.map(r => parseParkedRef(r.href)?.id).filter((x): x is string => !!x);
}

export function bytesToB64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

export function bytesFromB64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
