/**
 * The metadata of a WebM or MKV (Matroska: EBML elements) overwritten in
 * place before it is sent (api/fileMetadata.ts). NOTHING MOVES: no element
 * changes size, so the cues, the seek head and every cluster stay where they
 * point, and the frames are not touched.
 *
 *   BLANKED  Tags (titles, dates, encoder, any key a muxer wrote: a phone's
 *            location among them) and Attachments (files carried inside: cover
 *            art, fonts, anything) become Void elements of the same size;
 *            the segment's DateUTC (when it was made) becomes Void; Title,
 *            MuxingApp, WritingApp, the segment's file names and each
 *            track's Name are overwritten with zeros (an EBML string may be
 *            zero-padded, so they read as empty); a CRC-32 in an element
 *            this changed becomes Void, so it does not now say the element
 *            is damaged.
 *   KEPT     everything else: tracks, codecs, chapters, cues, clusters.
 *
 * Only the header elements are read; a cluster is skipped by its size. One of
 * unknown size (a live recording: MediaRecorder writes them so) is walked
 * block by block to find where it ends, which reads the file through once in
 * windows, never all at once.
 *
 * REFUSED (ImageMetadataError) rather than sent unread: an element that runs
 * past its parent (except a cluster cut short: a recording that stopped, its
 * header elements all before it), a header element of unknown size, an ID or
 * size that is not valid EBML. A file whose EBML DocType is neither `webm`
 * nor `matroska` is not one of these and passes as it is.
 */
import { ImageMetadataError } from './imageMetadata';
import { type Patch, type Source } from './metadataPatches';

const ID = {
    EBML: 0x1A45DFA3, DocType: 0x4282,
    Segment: 0x18538067, SeekHead: 0x114D9B74, Info: 0x1549A966, Tracks: 0x1654AE6B,
    Cluster: 0x1F43B675, Cues: 0x1C53BB6B, Chapters: 0x1043A770, Tags: 0x1254C367, Attachments: 0x1941A469,
    Void: 0xEC, CRC32: 0xBF,
    Title: 0x7BA9, MuxingApp: 0x4D80, WritingApp: 0x5741, DateUTC: 0x4461,
    SegmentFilename: 0x7384, PrevFilename: 0x3C83AB, NextFilename: 0x3E83BB,
    TrackEntry: 0xAE, Name: 0x536E,
} as const;

/** Children of the Segment: a cluster of unknown size ends where one of these starts. */
const SEGMENT_LEVEL = new Set<number>([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Chapters, ID.Tags, ID.Attachments, ID.EBML, ID.Segment]);
/** Read whole (they are small) and walked. */
const HEADER_ELEMENTS = new Set<number>([ID.Info, ID.Tracks]);
/** Blanked whole. */
const VOIDED = new Set<number>([ID.Tags, ID.Attachments]);
/** The largest header element read. */
const MAX_HEADER = 64 * 1024 * 1024;

const UNKNOWN = -1;

interface Head { id: number; idLen: number; size: number; sizeLen: number }

/** An EBML element header at `b[i]`, or null when the bytes cannot be one. */
function header(b: Uint8Array, i: number): Head | null {
    if (i >= b.length) return null;
    const first = b[i];
    let idLen = 1;
    while (idLen <= 4 && !(first & (0x80 >> (idLen - 1)))) idLen++;
    if (idLen > 4 || i + idLen > b.length) return null;
    let id = 0;
    for (let k = 0; k < idLen; k++) id = id * 256 + b[i + k];
    const s0 = i + idLen;
    if (s0 >= b.length) return null;
    const sf = b[s0];
    let sizeLen = 1;
    while (sizeLen <= 8 && !(sf & (0x80 >> (sizeLen - 1)))) sizeLen++;
    if (sizeLen > 8 || s0 + sizeLen > b.length) return null;
    let size = sf & (0xFF >> sizeLen);
    let allOnes = size === (0xFF >> sizeLen);
    for (let k = 1; k < sizeLen; k++) {
        size = size * 256 + b[s0 + k];
        if (b[s0 + k] !== 0xFF) allOnes = false;
    }
    if (allOnes) return { id, idLen, size: UNKNOWN, sizeLen };
    if (size > Number.MAX_SAFE_INTEGER) return null;
    return { id, idLen, size, sizeLen };
}

/** A Void element exactly `total` bytes long (total >= 2). */
function voidElement(total: number): Uint8Array {
    const out = new Uint8Array(total);
    out[0] = ID.Void;
    const m = Math.min(8, total - 1);
    let v = total - 1 - m;
    // VINT of length m: the marker bit, then the value big-endian.
    for (let k = m; k >= 1; k--) { out[k] = v & 0xFF; v = Math.floor(v / 256); }
    out[1] |= 0x80 >> (m - 1);
    return out;
}

const fail = (format: string, why: string): never => { throw new ImageMetadataError(format, why, 'video'); };

/** Walk a header element read whole (`b`, its data at file offset `base`), recording what to blank;
 *  true when anything in it was. */
function headerPatches(b: Uint8Array, base: number, format: string, out: Patch[]): boolean {
    let i = 0;
    const crc: Array<[number, number]> = [];
    let changed = false;
    while (i < b.length) {
        const h = header(b, i);
        if (!h || h.size === UNKNOWN) fail(format, 'a header element cannot be read');
        const dataAt = i + h!.idLen + h!.sizeLen;
        const end = dataAt + h!.size;
        if (end > b.length) fail(format, 'a header element is longer than its parent');
        switch (h!.id) {
            case ID.Title: case ID.MuxingApp: case ID.WritingApp: case ID.Name:
            case ID.SegmentFilename: case ID.PrevFilename: case ID.NextFilename:
                if (h!.size > 0) { out.push({ at: base + dataAt, bytes: new Uint8Array(h!.size) }); changed = true; }
                break;
            case ID.DateUTC:
                out.push({ at: base + i, bytes: voidElement(end - i) });
                changed = true;
                break;
            case ID.TrackEntry:
                if (headerPatches(b.subarray(dataAt, end), base + dataAt, format, out)) changed = true;
                break;
            case ID.CRC32:
                crc.push([i, end]);
                break;
            default:
                break;
        }
        i = end;
    }
    if (changed) for (const [s, e] of crc) out.push({ at: base + s, bytes: voidElement(e - s) });
    return changed;
}

/** Is this an EBML file (a WebM or MKV, if its DocType says so)? */
export function isEbml(head: Uint8Array): boolean {
    return head.length >= 4 && head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3;
}

/**
 * What to overwrite in this WebM / MKV, or null when it is not one (an EBML
 * file of another DocType: passed as it is).
 */
export async function planMatroska(src: Source, format = 'WebM'): Promise<Patch[] | null> {
    const out: Patch[] = [];
    let at = 0;
    let sawDocType = false;
    const head = async (pos: number): Promise<Head> => {
        const h = header(await src.read(pos, 12), 0);
        if (!h) fail(format, 'an element cannot be read');
        return h!;
    };
    while (at < src.size) {
        const h = await head(at);
        const dataAt = at + h.idLen + h.sizeLen;
        if (h.id === ID.EBML) {
            if (h.size === UNKNOWN || h.size > 4096 || dataAt + h.size > src.size) fail(format, 'its EBML header cannot be read');
            const b = await src.read(dataAt, h.size);
            let i = 0;
            let doc = '';
            while (i < b.length) {
                const c = header(b, i);
                if (!c || c.size === UNKNOWN) fail(format, 'its EBML header cannot be read');
                const d = i + c!.idLen + c!.sizeLen;
                if (d + c!.size > b.length) fail(format, 'its EBML header cannot be read');
                if (c!.id === ID.DocType) doc = new TextDecoder('latin1').decode(b.subarray(d, d + c!.size)).replace(/\0+$/, '');
                i = d + c!.size;
            }
            if (doc !== 'webm' && doc !== 'matroska') return null;
            sawDocType = true;
            at = dataAt + h.size;
            continue;
        }
        if (!sawDocType) fail(format, 'it does not start with an EBML header');
        if (h.id === ID.Segment) {
            const end = h.size === UNKNOWN ? src.size : dataAt + h.size;
            if (end > src.size) {
                // Cut short (a recording that stopped): what is there is walked.
                await segmentPatches(src, dataAt, src.size, format, out, head);
                break;
            }
            await segmentPatches(src, dataAt, end, format, out, head);
            at = end;
            continue;
        }
        if (h.id === ID.Void || h.id === ID.CRC32) {
            if (h.size === UNKNOWN || dataAt + h.size > src.size) fail(format, 'an element is longer than the file');
            at = dataAt + h.size;
            continue;
        }
        fail(format, 'it has data outside its segment');
    }
    if (!sawDocType) fail(format, 'it does not start with an EBML header');
    return out;
}

async function segmentPatches(src: Source, from: number, to: number, format: string, out: Patch[], head: (pos: number) => Promise<Head>): Promise<void> {
    let at = from;
    while (at < to) {
        if (to - at < 2) fail(format, 'it ends inside an element');
        const h = await head(at);
        const dataAt = at + h.idLen + h.sizeLen;
        if (h.size === UNKNOWN) {
            if (h.id !== ID.Cluster) fail(format, 'a header element has no size');
            at = await clusterEnd(dataAt, to, format, head);
            continue;
        }
        const end = dataAt + h.size;
        if (end > to) {
            if (h.id === ID.Cluster) return; // a recording that stopped inside its media
            fail(format, 'an element is longer than the file');
        }
        if (HEADER_ELEMENTS.has(h.id)) {
            if (h.size > MAX_HEADER) fail(format, 'a header element is too large to check');
            headerPatches(await src.read(dataAt, h.size), dataAt, format, out);
        } else if (VOIDED.has(h.id)) {
            out.push({ at, bytes: voidElement(end - at) });
        }
        at = end;
    }
}

/** Where a cluster of unknown size ends: at the first Segment-level element after its blocks. */
async function clusterEnd(from: number, to: number, format: string, head: (pos: number) => Promise<Head>): Promise<number> {
    let at = from;
    while (at < to) {
        if (to - at < 2) return to;
        const h = await head(at);
        if (SEGMENT_LEVEL.has(h.id)) return at;
        if (h.size === UNKNOWN) fail(format, 'a block has no size');
        const end = at + h.idLen + h.sizeLen + h.size;
        if (end > to) return to; // cut short inside its media
        at = end;
    }
    return to;
}
