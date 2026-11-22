/**
 * A TIFF's metadata removed in place before it is sent (api/fileMetadata.ts).
 * A TIFF keeps its metadata as TAGS in the same directories (IFDs) that
 * describe the picture: a GPS directory, an EXIF directory (capture time,
 * camera, serial numbers, maker notes), XMP, IPTC, Photoshop's resources,
 * and plain-text tags (Artist, Make, Model, Software, DateTime, HostComputer,
 * ImageDescription, Copyright, DocumentName, Windows' XP* tags).
 *
 * NOTHING MOVES: each directory is rewritten where it is with only the tags
 * that describe the picture (an ALLOWLIST: size, sampling, compression, the
 * strips or tiles and where they are, colour, resolution, page numbers,
 * orientation, the ICC profile), and the bytes the other tags pointed at —
 * whole GPS, EXIF and interoperability directories with every value in them
 * — are overwritten with zeros, except where they overlap anything kept. The
 * strips and tiles are not touched, so the picture is the same, byte for
 * byte. Every directory in the chain is done (each page of a multi-page
 * TIFF), and every SubIFD.
 *
 * REFUSED (ImageMetadataError), rather than sent with a tag it could not
 * account for: a directory or value outside the file, a loop of directories,
 * a removed tag of a type this does not know (its bytes could not be found
 * to blank), and BigTIFF (not read here).
 * PASSED AS IT IS (null): a camera raw file in a TIFF's clothing (a DNG, by
 * its DNGVersion tag; a Canon CR2, by its header): raw software needs the
 * camera's data to develop it, and no app here shows one.
 */
import { ImageMetadataError } from './imageMetadata';
import { type Patch } from './metadataPatches';

/** TIFF 6.0's picture tags, PageNumber, SubIFDs, SGI's depth tags and the ICC profile. */
const KEEP = new Set([
    254, 255, 256, 257, 258, 259, 262, 263, 264, 265, 266, 273, 274, 277, 278, 279, 280, 281, 282, 283, 284,
    286, 287, 290, 291, 292, 293, 296, 297, 301, 317, 318, 319, 320, 321, 322, 323, 324, 325, 330, 332, 333,
    334, 336, 338, 339, 340, 341, 342, 347, 512, 513, 514, 515, 517, 518, 519, 520, 521, 529, 530, 531, 532,
    32997, 32998, 34675,
]);
/** Directories a tag points at whose contents are all metadata: EXIF, GPS, interoperability. */
const SUB_METADATA_IFDS = new Set([34665, 34853, 40965]);
const DNG_VERSION = 50706;
const SUB_IFDS = 330;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

const fail = (why: string): never => { throw new ImageMetadataError('TIFF', why, 'picture'); };

export function isTiff(b: Uint8Array): boolean {
    return b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0) || (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0 && b[3] === 0x2A));
}

export function isBigTiff(b: Uint8Array): boolean {
    return b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2B && b[3] === 0) || (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0 && b[3] === 0x2B));
}

interface Entry { tag: number; type: number; count: number; at: number; valueAt: number; bytes: number | null }

/** The overwrites that leave this TIFF with only its picture's tags, or null for a raw file passed as it is. */
export function tiffPatches(b: Uint8Array): Patch[] | null {
    if (isBigTiff(b)) fail('it is a BigTIFF, which is not read here');
    if (!isTiff(b) || b.length < 8) fail('its header is cut off');
    const little = b[0] === 0x49;
    const r16 = (at: number) => (little ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1]);
    const r32 = (at: number) => (little
        ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000
        : b[at] * 0x1000000 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]));
    const w16 = (o: Uint8Array, at: number, v: number) => { if (little) { o[at] = v & 255; o[at + 1] = v >> 8; } else { o[at] = v >> 8; o[at + 1] = v & 255; } };
    // A Canon CR2: "CR" and its version right after the header.
    if (b.length >= 12 && b[8] === 0x43 && b[9] === 0x52) return null;

    const n = b.length;
    const readIfd = (off: number): { entries: Entry[]; next: number; end: number } => {
        if (off < 8 || off + 2 > n) fail('a directory is outside the file');
        const count = r16(off);
        const end = off + 2 + count * 12 + 4;
        if (end > n) fail('a directory is cut off');
        const entries: Entry[] = [];
        for (let e = 0; e < count; e++) {
            const at = off + 2 + e * 12;
            const type = r16(at + 2);
            const cnt = r32(at + 4);
            const size = TYPE_SIZE[type];
            const bytes = size === undefined ? null : cnt * size;
            let valueAt = at + 8;
            if (bytes !== null && bytes > 4) {
                valueAt = r32(at + 8);
                if (valueAt + bytes > n) fail('a value is outside the file');
            }
            entries.push({ tag: r16(at), type, count: cnt, at, valueAt, bytes });
        }
        return { entries, next: r32(end - 4), end };
    };
    const offsetsOf = (e: Entry): number[] => {
        if (e.bytes === null) fail('a directory list has a type it does not know');
        const size = TYPE_SIZE[e.type];
        const out: number[] = [];
        for (let k = 0; k < e.count; k++) {
            const p = e.valueAt + k * size;
            if (size !== 2 && size !== 4) fail('a directory list is not 16 or 32 bits');
            out.push(size === 2 ? r16(p) : r32(p));
        }
        return out;
    };

    const keep: Array<[number, number]> = [[0, 8]];
    const blank: Array<[number, number]> = [];
    const rewrites: Patch[] = [];
    const seen = new Set<number>();
    /** Metadata directories (EXIF, GPS, interop): everything in them goes. */
    const blankIfd = (off: number) => {
        if (seen.has(off)) return;
        seen.add(off);
        const d = readIfd(off);
        blank.push([off, d.end]);
        for (const e of d.entries) {
            if (e.bytes === null) fail('a tag has a type it does not know');
            if (e.bytes! > 4) blank.push([e.valueAt, e.valueAt + e.bytes!]);
            if (SUB_METADATA_IFDS.has(e.tag)) for (const o of offsetsOf(e)) blankIfd(o);
        }
    };
    const queue: number[] = [r32(4)];
    let first = true;
    while (queue.length) {
        const off = queue.shift()!;
        if (off === 0) continue;
        if (seen.has(off)) fail('its directories loop');
        if (seen.size > 4096) fail('it has too many directories');
        seen.add(off);
        const d = readIfd(off);
        if (first && d.entries.some(e => e.tag === DNG_VERSION)) return null;
        first = false;
        keep.push([off, d.end]);
        const kept: Entry[] = [];
        for (const e of d.entries) {
            if (KEEP.has(e.tag)) {
                kept.push(e);
                if (e.bytes === null) fail('a tag has a type it does not know');
                if (e.bytes! > 4) keep.push([e.valueAt, e.valueAt + e.bytes!]);
                if (e.tag === SUB_IFDS) queue.push(...offsetsOf(e));
                continue;
            }
            if (e.bytes === null) fail('a tag has a type it does not know');
            if (e.bytes! > 4) blank.push([e.valueAt, e.valueAt + e.bytes!]);
            if (SUB_METADATA_IFDS.has(e.tag)) for (const o of offsetsOf(e)) blankIfd(o);
        }
        // The picture's data: never blanked, whatever a removed tag pointed at.
        const pairs: Array<[number, number]> = [[273, 279], [324, 325], [513, 514]];
        for (const [o, c] of pairs) {
            const oe = kept.find(e => e.tag === o), ce = kept.find(e => e.tag === c);
            if (!oe || !ce) continue;
            const offs = offsetsOf(oe), lens = offsetsOf(ce);
            for (let k = 0; k < Math.min(offs.length, lens.length); k++) keep.push([offs[k], offs[k] + lens[k]]);
            if (o === 513 && offs.length === 1 && lens.length === 0) keep.push([offs[0], n]);
        }
        if (kept.length !== d.entries.length) {
            // The directory rewritten where it is: the kept entries in order, the same next pointer, zeros after.
            const out = new Uint8Array(d.end - off);
            w16(out, 0, kept.length);
            kept.forEach((e, k) => out.set(b.subarray(e.at, e.at + 12), 2 + k * 12));
            out.set(b.subarray(d.end - 4, d.end), 2 + kept.length * 12);
            rewrites.push({ at: off, bytes: out });
        }
        if (d.next) queue.push(d.next);
    }

    // Zero what was blanked, minus anything kept (a shared value, the picture's own bytes).
    keep.sort((x, y) => x[0] - y[0]);
    const zeros: Patch[] = [];
    for (const [s0, e0] of blank.sort((x, y) => x[0] - y[0])) {
        let s = s0;
        for (const [ks, ke] of keep) {
            if (ke <= s || ks >= e0) continue;
            if (ks > s) zeros.push({ at: s, bytes: new Uint8Array(ks - s) });
            s = Math.max(s, ke);
            if (s >= e0) break;
        }
        if (s < e0) zeros.push({ at: s, bytes: new Uint8Array(e0 - s) });
    }
    // Two blanked ranges can overlap (a value shared by two tags): merge them, so no byte is written twice.
    const merged: Patch[] = [];
    for (const z of zeros.sort((x, y) => x.at - y.at)) {
        const last = merged[merged.length - 1];
        if (last && z.at <= last.at + last.bytes.length) {
            const end = Math.max(last.at + last.bytes.length, z.at + z.bytes.length);
            merged[merged.length - 1] = { at: last.at, bytes: new Uint8Array(end - last.at) };
        } else merged.push(z);
    }
    // A rewritten directory is in `keep`, so no zero lands on it.
    return [...rewrites, ...merged];
}
