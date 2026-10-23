/**
 * A HEIC with its metadata blanked: for a photo that has to be sent as it is
 * because nothing on this device can convert it (a browser other than Safari,
 * a PC without the HEIF/HEVC extensions, a photo too large to hand to the
 * phone's decoder). Sent untouched it would carry the location, camera and
 * time the phone stored in it to everyone in the channel, and the sender
 * would never know (review finding 2026-10-23).
 *
 * A HEIF keeps its metadata as ITEMS beside the picture, listed in the `meta`
 * box: an `Exif` item (the EXIF block: GPS, camera, time) and XMP as a `mime`
 * item of type application/rdf+xml. `iloc` says where each item's bytes are.
 * Those bytes are overwritten in a copy — an Exif item with an EXIF block that
 * has no entries, an XMP item with an empty XMP packet, padding with zeros or
 * spaces — so every box keeps its size and every offset stays valid: the
 * picture decodes exactly as before (checked with libheif and Windows' WIC),
 * and a reader finds metadata that says nothing (a block of plain zeros made
 * Pillow's EXIF reader throw). Nothing is re-encoded.
 *
 * Anything this cannot read with certainty — a version of a box it does not
 * know, an item stored in another file or built from other items, an extent
 * outside the file, a HEIF sequence (`moov`, whose tracks carry their own
 * metadata) — is null: the caller then does not send the file at all rather
 * than send it with its metadata.
 */

/** XMP content types (a `mime` item's content_type). */
const XMP_TYPES = /rdf\+xml|xmp/i;

/** An Exif item that says nothing: exif_tiff_header_offset 0, then a
 *  big-endian TIFF header whose first IFD has no entries and no next IFD. */
const EMPTY_EXIF_ITEM = new Uint8Array([0, 0, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0]);
/** An XMP packet with nothing in it. */
const EMPTY_XMP = new TextEncoder().encode('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');

interface Box { type: string; start: number; body: number; end: number }

function readBoxes(b: Uint8Array, from: number, to: number): Box[] | null {
    const out: Box[] = [];
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let at = from;
    while (at < to) {
        if (at + 8 > to) return null;
        let size = dv.getUint32(at);
        const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
        let body = at + 8;
        if (size === 1) {
            if (at + 16 > to) return null;
            const big = dv.getBigUint64(at + 8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            size = Number(big);
            body = at + 16;
        } else if (size === 0) {
            size = to - at;
        }
        if (size < body - at || at + size > to) return null;
        out.push({ type, start: at, body, end: at + size });
        at += size;
    }
    return out;
}

/** Reads an unsigned big-endian integer of 0, 4 or 8 bytes. */
function uint(dv: DataView, at: number, n: number): number | null {
    if (n === 0) return 0;
    if (n === 4) return dv.getUint32(at);
    if (n === 8) {
        const v = dv.getBigUint64(at);
        return v > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(v);
    }
    return null;
}

/** A null-terminated string at `at`, and where it ends (after the NUL). */
function cstring(b: Uint8Array, at: number, end: number): { s: string; next: number } | null {
    let i = at;
    while (i < end && b[i] !== 0) i++;
    if (i >= end) return null;
    let s = '';
    for (let j = at; j < i; j++) s += String.fromCharCode(b[j]);
    return { s, next: i + 1 };
}

type Kind = 'exif' | 'xmp';

/** The metadata items (Exif, XMP) listed in `iinf`, by item ID. */
function metadataItems(b: Uint8Array, iinf: Box): Map<number, Kind> | null {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const version = b[iinf.body];
    let at = iinf.body + 4;
    at += version === 0 ? 2 : 4; // entry_count; the boxes that follow say it all
    const ids = new Map<number, Kind>();
    const entries = readBoxes(b, at, iinf.end);
    if (!entries) return null;
    for (const e of entries) {
        if (e.type !== 'infe') continue;
        const v = b[e.body];
        // Versions 0 and 1 have no item_type: nothing here can tell what they are.
        if (v < 2 || v > 3) return null;
        let p = e.body + 4;
        if (p + (v === 2 ? 2 : 4) + 2 + 4 > e.end) return null;
        const id = v === 2 ? dv.getUint16(p) : dv.getUint32(p);
        p += v === 2 ? 2 : 4;
        p += 2; // item_protection_index
        const type = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
        p += 4;
        if (type === 'Exif') { ids.set(id, 'exif'); continue; }
        if (type === 'mime') {
            const name = cstring(b, p, e.end);
            if (!name) return null;
            const content = cstring(b, name.next, e.end);
            if (!content) return null;
            if (XMP_TYPES.test(content.s)) ids.set(id, 'xmp');
        }
    }
    return ids;
}

/** Where each metadata item's bytes are, as absolute [start, end) ranges,
 *  one list per item. */
function itemRanges(b: Uint8Array, iloc: Box, wanted: Map<number, Kind>, idat: Box | null): Map<number, Array<[number, number]>> | null {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const version = b[iloc.body];
    if (version > 2) return null;
    let p = iloc.body + 4;
    if (p + 2 > iloc.end) return null;
    const offsetSize = b[p] >> 4, lengthSize = b[p] & 15, baseSize = b[p + 1] >> 4;
    const indexSize = version >= 1 ? b[p + 1] & 15 : 0;
    p += 2;
    const count = version < 2 ? dv.getUint16(p) : dv.getUint32(p);
    p += version < 2 ? 2 : 4;
    const ranges = new Map<number, Array<[number, number]>>();
    for (let i = 0; i < count; i++) {
        if (p + (version < 2 ? 2 : 4) > iloc.end) return null;
        const id = version < 2 ? dv.getUint16(p) : dv.getUint32(p);
        p += version < 2 ? 2 : 4;
        let method = 0;
        if (version >= 1) { method = dv.getUint16(p) & 15; p += 2; }
        const dataRef = dv.getUint16(p); p += 2;
        const base = uint(dv, p, baseSize); p += baseSize;
        const extents = dv.getUint16(p); p += 2;
        if (base === null || p + extents * (indexSize + offsetSize + lengthSize) > iloc.end) return null;
        for (let x = 0; x < extents; x++) {
            p += indexSize;
            const off = uint(dv, p, offsetSize); p += offsetSize;
            const len = uint(dv, p, lengthSize); p += lengthSize;
            if (!wanted.has(id)) continue;
            // Stored in another file, built from other items, of unknown
            // length: not something to guess about.
            if (dataRef !== 0 || method > 1 || off === null || len === null || len === 0) return null;
            const origin = method === 1 ? (idat ? idat.body : -1) : 0;
            if (origin < 0) return null;
            const start = origin + base + off;
            const limit = method === 1 ? idat!.end : b.length;
            if (start + len > limit) return null;
            if (!ranges.has(id)) ranges.set(id, []);
            ranges.get(id)!.push([start, start + len]);
        }
    }
    return ranges;
}

/**
 * A copy of this HEIF with every Exif and XMP item's bytes zeroed, or null when
 * it cannot be done with certainty (see the top of this file). A HEIF with no
 * such items comes back as an unchanged copy.
 */
export function stripHeifMetadata(file: Uint8Array): Uint8Array | null {
    const top = readBoxes(file, 0, file.length);
    if (!top || top[0]?.type !== 'ftyp') return null;
    if (top.some(t => t.type === 'moov')) return null;
    const metas = top.filter(t => t.type === 'meta');
    if (metas.length !== 1) return null;
    const meta = metas[0];
    const children = readBoxes(file, meta.body + 4, meta.end);
    if (!children) return null;
    const iinf = children.find(c => c.type === 'iinf');
    const iloc = children.find(c => c.type === 'iloc');
    if (!iinf || !iloc) return null;
    const ids = metadataItems(file, iinf);
    if (!ids) return null;
    const out = file.slice();
    if (ids.size === 0) return out;
    const ranges = itemRanges(file, iloc, ids, children.find(c => c.type === 'idat') ?? null);
    if (!ranges) return null;
    for (const [id, extents] of ranges) {
        for (const [s, e] of extents) out.fill(ids.get(id) === 'xmp' ? 0x20 : 0, s, e);
        // One extent (what every camera writes): a stand-in that parses.
        if (extents.length !== 1) continue;
        const [s, e] = extents[0];
        const filler = ids.get(id) === 'xmp' ? EMPTY_XMP : EMPTY_EXIF_ITEM;
        if (e - s >= filler.length) out.set(filler, s);
    }
    return out;
}
