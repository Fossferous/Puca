/**
 * The metadata of an MP4, MOV, M4A, 3GP, HEIC or AVIF (all ISO base media /
 * QuickTime files: boxes, a.k.a. atoms) overwritten in place before it is
 * sent (api/fileMetadata.ts). A phone video keeps where it was recorded in
 * exactly these places — Android's `udta/©xyz`, the iPhone's `moov/meta`
 * (com.apple.quicktime.location.ISO6709, make, model, software, creation
 * date), 3GPP's `udta/loci` — a GoPro or a phone with a motion sensor
 * records its position all the way through, as a timed metadata track, and
 * cameras and dashcams put theirs in boxes of their own (ExifTool reads
 * dozens: a Novatek dashcam's `moov/gps ` index and the `freeGPS ` blocks of
 * fixes it lists in the media data, Samsung's `sefd` trailer, Kodak's serial
 * number and a Pittasoft dashcam's GPS log in a top-level `free` box).
 *
 * AN ALLOWLIST, at every level this walks: the top of the file, `moov`, each
 * `trak` and its `mdia`, and each `moof`. A box a player needs is kept (the
 * file type, the media data, the movie and track headers, edit lists, track
 * references, the sample tables, fragments and their indexes); every other
 * box becomes a `free` box of the same size with zeros in it (every reader
 * skips `free`), whatever it is called. NOTHING MOVES: no chunk offset, no
 * sample and no frame changes, and the media decodes exactly as before.
 * Beyond that:
 *
 *   - free space (a top-level `free`, `skip`, `wide` or `junk`) is zeroed
 *     where it holds anything: nothing reads it, but cameras write into it;
 *   - the creation and modification times in `mvhd`, `tkhd` and `mdhd`
 *     (when it was recorded) are written as zero, and a video sample entry's
 *     compressor name (the encoder's name: EXIF's Software) as empty;
 *   - a timed metadata track (handler `meta`, `camm`, `data` or `ctbx`, the
 *     ones ExifTool reads: GoPro's GPMF telemetry, Google's camera motion,
 *     Apple's metadata tracks, a car's): the track becomes `free` and every
 *     sample of it in `mdat` is zeroed, found through its own sample tables;
 *   - a dashcam's GPS blocks in the media data (`freeGPS `, as Novatek and
 *     the many dashcams on its chips write them): the media data is searched
 *     for them as ExifTool searches it (the first 20 MB, and all of it when
 *     one is found or the movie has a `gps ` index), and each is zeroed after
 *     its box header; the index itself is freed like any box not allowed;
 *   - in a HEIC or AVIF picture, every Exif and XMP item, overwritten in
 *     place (api/heifMetadata.ts), as the HEIC path has done since 0.9.8xx; a
 *     Samsung HEIC's `sefd` trailer and its Motion Photo video (`mpvd`) are
 *     freed with the rest, as a JPEG's Motion Photo video is dropped.
 *
 * KEPT: the subtitle tracks (some drones write their position into one, as
 * text: that is content this does not read), a track's handler name and
 * data references, and GoPro-format GPS records some cameras leave in the
 * media data without listing them anywhere (ExifTool finds those only by
 * decoding the whole recording).
 *
 * Only the boxes that are walked are read (`moov`, a top-level `meta` and
 * each `moof`, a few MB even for an hour of video), free space, and the
 * first 20 MB of the media data (all of it in a dashcam's recording).
 *
 * REFUSED (ImageMetadataError), rather than sent with something unread: a box
 * that runs past the end of the file (except a final `mdat` cut short: a
 * recording that stopped, whose metadata was all before it), a `moov` too
 * large to read or compressed (`cmov`), a HEIF whose items cannot be read
 * with certainty, sample tables that point outside the file, and a timed
 * metadata track in a fragmented file (its samples are in fragments this
 * does not walk).
 * PASSED AS IT IS: a Canon CR3 raw (brand `crx `): raw software needs what is
 * in its boxes, and it is not a picture any app here shows.
 */
import { ImageMetadataError } from './imageMetadata';
import { heifMetadataPatches } from './heifMetadata';
import { ascii4, type Patch, type Source } from './metadataPatches';

/** The largest `moov` (or top-level meta box, or `moof`) read; an hour of 4K is ~10 MB. */
export const MAX_ISO_METADATA_BOX = 256 * 1024 * 1024;

/** How much of the media data is searched for a dashcam's GPS blocks when none has been seen (ExifTool's own limit). */
export const GPS_SCAN_FIRST = 20 * 1000 * 1000;

const FREE = Uint8Array.from([0x66, 0x72, 0x65, 0x65]);
const FREE_GPS = Uint8Array.from([0x66, 0x72, 0x65, 0x65, 0x47, 0x50, 0x53, 0x20]); // "freeGPS "
/** The largest `freeGPS ` block zeroed as one (they are 168 bytes to 32 KB); a longer size is not believed. */
const MAX_GPS_BLOCK = 1024 * 1024;
/** Free space, the media data and the search for GPS blocks are read this much at a time. */
const CHUNK = 1024 * 1024;

/** Top-level boxes a player needs, kept as they are (moov, meta and moof are walked; free space zeroed). */
const TOP_KEEP = new Set(['ftyp', 'styp', 'mdat', 'imda', 'mfra', 'sidx', 'ssix']);
/** Free space: nothing reads it, and cameras write into it. */
const PADDING = new Set(['free', 'skip', 'wide', 'junk']);
/** In `moov`, beside mvhd and the tracks: what playing a movie, a fragmented one or a protected one, needs. */
const MOOV_KEEP = new Set(['mvex', 'iods', 'pssh', 'prfl', 'clip', 'ctab']);
/** In a `trak`, beside tkhd and mdia: edits, references, groups, and QuickTime's own layout boxes. */
const TRAK_KEEP = new Set(['tref', 'trgr', 'edts', 'tapt', 'clip', 'matt', 'load', 'imap', 'txas']);
/** In a track's `mdia`, beside mdhd. */
const MDIA_KEEP = new Set(['hdlr', 'minf', 'elng']);
/** In a `moof` (a fragment's header). */
const MOOF_KEEP = new Set(['mfhd', 'traf', 'pssh']);

interface Box { type: string; start: number; body: number; end: number }

/** Which top-level types, as the first box, make a file a QuickTime / ISO one. */
const FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot']);

/** Do these bytes open like an ISO base media / QuickTime file? `ftyp` first
 *  is certain; an old QuickTime movie may open with another box, and counts
 *  only when the caller already believes it is a movie (`movie`). */
export function looksIsoBmff(head: Uint8Array, movie: boolean): boolean {
    if (head.length < 8) return false;
    const type = ascii4(head, 4);
    if (type === 'ftyp') return true;
    if (!movie || !FIRST_BOXES.has(type)) return false;
    const size = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
    return size === 0 || size === 1 || size >= 8;
}

/** The boxes in `b[from, to)` (positions relative to `b`); null when one runs past `to` or is too small. */
function boxes(b: Uint8Array, from: number, to: number): Box[] | null {
    const out: Box[] = [];
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let at = from;
    while (at < to) {
        if (at + 8 > to) return null;
        let size = dv.getUint32(at);
        let body = at + 8;
        if (size === 1) {
            if (at + 16 > to) return null;
            const big = dv.getBigUint64(at + 8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            size = Number(big);
            body = at + 16;
        } else if (size === 0) size = to - at;
        if (size < body - at || at + size > to) return null;
        out.push({ type: ascii4(b, at + 4), start: at, body, end: at + size });
        at += size;
    }
    return out;
}

/** The overwrites that make box `x` (in `b`, which starts at file offset `base`) a `free` box of the same size. */
function freePatches(x: Box, base: number): Patch[] {
    return [{ at: base + x.start + 4, bytes: FREE.slice() }, { at: base + x.body, bytes: new Uint8Array(x.end - x.body) }];
}

/** Zero the creation and modification times of an mvhd / tkhd / mdhd (a FullBox). */
function timePatch(b: Uint8Array, x: Box, base: number): Patch[] {
    if (x.body + 4 > x.end) return [];
    const v = b[x.body];
    const n = v === 1 ? 16 : 8;
    if (x.body + 4 + n > x.end) return [];
    return [{ at: base + x.body + 4, bytes: new Uint8Array(n) }];
}

/** Handlers of the timed metadata tracks ExifTool extracts (besides subtitles): GoPro, Google, Apple, cars. */
const TIMED_METADATA_HANDLERS = new Set(['meta', 'camm', 'data', 'ctbx']);

/** A meta box is an ISO FullBox (children after 4 bytes) or, in QuickTime, a plain one. */
function metaChildren(b: Uint8Array, m: Box): Box[] | null {
    return boxes(b, m.body + 4, m.end) ?? boxes(b, m.body, m.end);
}

/** The handler type in a meta or mdia box's hdlr, or ''. */
function handlerOf(b: Uint8Array, children: Box[]): string {
    const h = children.find(c => c.type === 'hdlr');
    if (!h || h.body + 12 > h.end) return '';
    return ascii4(b, h.body + 8);
}

/**
 * Where a track's samples are, as [start, end) file ranges, from its stbl:
 * one range per chunk (its samples are contiguous), so the work is bounded by
 * the tables' sizes whatever they claim. null when they cannot be read or
 * point outside the file.
 */
function trackSampleRanges(b: Uint8Array, stbl: Box, fileSize: number): Array<[number, number]> | null {
    const kids = boxes(b, stbl.body, stbl.end);
    if (!kids) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const find = (t: string) => kids.find(k => k.type === t);
    // Chunk offsets.
    const stco = find('stco'), co64 = find('co64');
    const offsets: number[] = [];
    if (stco || co64) {
        const x = (stco ?? co64)!;
        if (x.body + 8 > x.end) return null;
        const n = dv.getUint32(x.body + 4);
        const w = stco ? 4 : 8;
        if (x.body + 8 + n * w > x.end) return null;
        for (let i = 0; i < n; i++) {
            const p = x.body + 8 + i * w;
            const off = stco ? dv.getUint32(p) : Number(dv.getBigUint64(p));
            offsets.push(off);
        }
    }
    if (offsets.length === 0) return [];
    // Sample sizes.
    let constant = 0;
    let count = 0;
    let sizes: (i: number) => number = () => 0;
    const stsz = find('stsz'), stz2 = find('stz2');
    if (stsz) {
        if (stsz.body + 12 > stsz.end) return null;
        constant = dv.getUint32(stsz.body + 4);
        count = dv.getUint32(stsz.body + 8);
        if (constant === 0) {
            if (stsz.body + 12 + count * 4 > stsz.end) return null;
            sizes = (i) => dv.getUint32(stsz.body + 12 + i * 4);
        }
    } else if (stz2) {
        if (stz2.body + 12 > stz2.end) return null;
        const field = b[stz2.body + 7];
        count = dv.getUint32(stz2.body + 8);
        const at = stz2.body + 12;
        if (field === 16) { if (at + count * 2 > stz2.end) return null; sizes = (i) => dv.getUint16(at + i * 2); }
        else if (field === 8) { if (at + count > stz2.end) return null; sizes = (i) => b[at + i]; }
        else if (field === 4) { if (at + Math.ceil(count / 2) > stz2.end) return null; sizes = (i) => (i & 1 ? b[at + (i >> 1)] & 15 : b[at + (i >> 1)] >> 4); }
        else return null;
    } else return null;
    // Samples per chunk.
    const stsc = find('stsc');
    if (!stsc || stsc.body + 8 > stsc.end) return null;
    const entries = dv.getUint32(stsc.body + 4);
    if (stsc.body + 8 + entries * 12 > stsc.end || entries === 0) return null;
    const firstChunk = (e: number) => dv.getUint32(stsc.body + 8 + e * 12);
    const perChunk = (e: number) => dv.getUint32(stsc.body + 12 + e * 12);
    const out: Array<[number, number]> = [];
    let sample = 0;
    let e = 0;
    for (let c = 0; c < offsets.length && sample < count; c++) {
        while (e + 1 < entries && firstChunk(e + 1) <= c + 1) e++;
        const n = Math.min(perChunk(e), count - sample);
        let len = 0;
        if (constant) len = n * constant;
        else for (let k = 0; k < n; k++) len += sizes(sample + k);
        sample += n;
        const start = offsets[c];
        if (start + len > fileSize) return null;
        if (len > 0) out.push([start, start + len]);
    }
    return out;
}

/**
 * A video sample entry's compressorname (32 bytes: the encoder's name, e.g.
 * "Lavc63.1.101 libx264", as EXIF's Software tag would say) written as an
 * empty name. Nothing reads it to decode.
 */
function compressorNamePatches(b: Uint8Array, mdiaKids: Box[], base: number): Patch[] {
    const minf = mdiaKids.find(k => k.type === 'minf');
    const stbl = minf ? boxes(b, minf.body, minf.end)?.find(k => k.type === 'stbl') : undefined;
    const stsd = stbl ? boxes(b, stbl.body, stbl.end)?.find(k => k.type === 'stsd') : undefined;
    if (!stsd || stsd.body + 8 > stsd.end) return [];
    const entries = boxes(b, stsd.body + 8, stsd.end);
    if (!entries) return [];
    // A VisualSampleEntry: 8 bytes of SampleEntry, then 34 of sizes and counts, then the name.
    return entries.filter(e => e.body + 42 + 32 <= e.end && b[e.body + 42] <= 31).map(e => ({ at: base + e.body + 42, bytes: new Uint8Array(32) }));
}

/** What a walk of a file's boxes has found so far. */
interface Plan {
    /** The overwrites. */
    out: Patch[];
    /** Ranges of the media data to zero (a metadata track's samples, GPS blocks), merged before they are written. */
    media: Array<[number, number]>;
    /** The movie has a dashcam's `gps ` index: all of the media data is searched. */
    gpsIndex: boolean;
}

/** The overwrites for one `trak` (in `b`, at file offset `base`). */
function trakPatches(plan: Plan, b: Uint8Array, trak: Box, base: number, fileSize: number, fragmented: boolean): void {
    const kids = boxes(b, trak.body, trak.end);
    if (!kids) throw new ImageMetadataError('MP4', 'a track cannot be read', 'video');
    const mdia = kids.find(k => k.type === 'mdia');
    const mdiaKids = mdia ? boxes(b, mdia.body, mdia.end) : [];
    if (!mdiaKids) throw new ImageMetadataError('MP4', 'a track cannot be read', 'video');
    if (TIMED_METADATA_HANDLERS.has(handlerOf(b, mdiaKids))) {
        if (fragmented) throw new ImageMetadataError('MP4', 'it has a timed metadata track in fragments', 'video');
        const minf = mdiaKids.find(k => k.type === 'minf');
        const stbl = minf ? boxes(b, minf.body, minf.end)?.find(k => k.type === 'stbl') : undefined;
        const ranges = stbl ? trackSampleRanges(b, stbl, fileSize) : [];
        if (!ranges) throw new ImageMetadataError('MP4', 'a metadata track points outside the file', 'video');
        // Its samples are media data, never the movie header they are described in.
        if (ranges.some(([s, e]) => s < base + b.length && e > base)) throw new ImageMetadataError('MP4', 'a metadata track points into its own header', 'video');
        plan.out.push(...freePatches(trak, base));
        plan.media.push(...ranges);
        return;
    }
    if (handlerOf(b, mdiaKids) === 'vide') plan.out.push(...compressorNamePatches(b, mdiaKids, base));
    for (const k of kids) {
        if (k.type === 'tkhd') plan.out.push(...timePatch(b, k, base));
        else if (k.type !== 'mdia' && !TRAK_KEEP.has(k.type)) plan.out.push(...freePatches(k, base));
    }
    for (const k of mdiaKids) {
        if (k.type === 'mdhd') plan.out.push(...timePatch(b, k, base));
        else if (!MDIA_KEEP.has(k.type)) plan.out.push(...freePatches(k, base));
    }
}

/** The overwrites for a `moov` box's bytes (`b`, the whole box, at file offset `base`). */
function moovPatches(plan: Plan, b: Uint8Array, base: number, fileSize: number): void {
    const moov = boxes(b, 0, b.length)?.[0];
    const kids = moov ? boxes(b, moov.body, moov.end) : null;
    if (!moov || !kids) throw new ImageMetadataError('MP4', 'its movie header cannot be read', 'video');
    const fragmented = kids.some(k => k.type === 'mvex');
    for (const k of kids) {
        if (k.type === 'mvhd') plan.out.push(...timePatch(b, k, base));
        else if (k.type === 'trak') trakPatches(plan, b, k, base, fileSize, fragmented);
        else if (k.type === 'cmov') throw new ImageMetadataError('MP4', 'its movie header is compressed, which is not read here', 'video');
        else if (!MOOV_KEEP.has(k.type)) {
            // A Novatek dashcam's index of its GPS blocks: they are found in the media data by themselves.
            if (k.type === 'gps ') plan.gpsIndex = true;
            plan.out.push(...freePatches(k, base));
        }
    }
}

/** The overwrites for a `moof` (a fragment's header), whose own kind of metadata (`meta`, `udta`) goes. */
function moofPatches(plan: Plan, b: Uint8Array, base: number): void {
    const moof = boxes(b, 0, b.length)?.[0];
    const kids = moof ? boxes(b, moof.body, moof.end) : null;
    if (!moof || !kids) throw new ImageMetadataError('MP4', 'a fragment header cannot be read', 'video');
    for (const k of kids) if (!MOOF_KEEP.has(k.type)) plan.out.push(...freePatches(k, base));
}

/** Zeros over whatever free space at [from, to) holds (nothing, almost always: then no patch at all). */
async function paddingPatches(src: Source, from: number, to: number): Promise<Patch[]> {
    const out: Patch[] = [];
    for (let p = from; p < to; p += CHUNK) {
        const b = await src.read(p, Math.min(CHUNK, to - p));
        let first = -1, last = -1;
        for (let k = 0; k < b.length; k++) if (b[k] !== 0) { if (first < 0) first = k; last = k; }
        if (first >= 0) out.push({ at: p + first, bytes: new Uint8Array(last - first + 1) });
    }
    return out;
}

/**
 * The `freeGPS ` blocks in the media data at [from, to): for each, the range
 * after its 8-byte box header (its "GPS " and its fixes), to be zeroed. The
 * first `budget` bytes are searched, and the rest once a block is found.
 */
async function gpsBlocks(src: Source, from: number, to: number, budget: number): Promise<Array<[number, number]>> {
    const out: Array<[number, number]> = [];
    let limit = Math.min(to, from + budget);
    for (let p = from; p < limit; p += CHUNK) {
        // The chunk and the 7 bytes after it, so a signature across two chunks is found once, in the first.
        const b = await src.read(p, Math.min(CHUNK + FREE_GPS.length - 1, to - p));
        for (let k = b.indexOf(0x66); k >= 0 && k < CHUNK && k + 8 <= b.length && p + k < limit; k = b.indexOf(0x66, k + 1)) {
            let match = true;
            for (let j = 1; j < 8 && match; j++) if (b[k + j] !== FREE_GPS[j]) match = false;
            const start = p + k - 4;
            if (!match || start < from) continue;
            const head = k >= 4 ? b.subarray(k - 4, k) : await src.read(start, 4);
            const size = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
            // A size that cannot be a block's: only its signature goes, so nothing reads it as one.
            const len = size >= 12 && size <= MAX_GPS_BLOCK ? size : 12;
            out.push([start + 8, Math.min(to, start + len)]);
            limit = to;
        }
    }
    return out;
}

/** Sorted, with ranges that touch or overlap made one, so no byte is written twice. */
function merged(ranges: Array<[number, number]>): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const [s, e] of [...ranges].filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0])) {
        const last = out[out.length - 1];
        if (last && s <= last[1]) last[1] = Math.max(last[1], e);
        else out.push([s, e]);
    }
    return out;
}

/**
 * What to overwrite in this ISO base media / QuickTime file, or null for a
 * file passed as it is (a CR3 raw). `format` names it in a refusal ('MP4',
 * 'MOV', 'HEIC', 'AVIF').
 */
export async function planIsoBmff(src: Source, format = 'MP4'): Promise<Patch[] | null> {
    const what = /HEIC|HEIF|AVIF/.test(format) ? 'photo' : 'video';
    const fail = (why: string): never => { throw new ImageMetadataError(format, why, what); };
    const plan: Plan = { out: [], media: [], gpsIndex: false };
    const mdats: Array<[number, number]> = [];
    let at = 0;
    let first = true;
    while (at < src.size) {
        const h = await src.read(at, 16);
        if (h.length < 8) fail('it ends inside a box header');
        const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
        let size = dv.getUint32(0);
        const type = ascii4(h, 4);
        let headLen = 8;
        if (size === 1) {
            if (h.length < 16) fail('it ends inside a box header');
            const big = dv.getBigUint64(8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail('a box is larger than any file');
            size = Number(big);
            headLen = 16;
        } else if (size === 0) size = src.size - at;
        if (size < headLen) fail(`a ${type.trim() || 'box'} box is too small`);
        if (at + size > src.size) {
            // A recording that stopped: its media data cut short, everything before it walked.
            if (type === 'mdat') { mdats.push([at + headLen, src.size]); break; }
            fail(`a ${type.trim()} box is longer than the file`);
        }
        if (first && type === 'ftyp') {
            const f = await src.read(at, Math.min(size, 256));
            for (let i = 8; i + 4 <= f.length; i += 4) {
                if (i === 12) continue; // minor_version
                if (ascii4(f, i) === 'crx ') return null;
            }
        }
        first = false;
        const box: Box = { type, start: 0, body: headLen, end: size };
        if (type === 'moov' || type === 'meta' || type === 'moof') {
            if (size > MAX_ISO_METADATA_BOX) fail(`its ${type} box is too large to check`);
            const b = await src.read(at, size);
            if (b.length !== size) fail('it could not be read');
            if (type === 'moov') moovPatches(plan, b, at, src.size);
            else if (type === 'moof') moofPatches(plan, b, at);
            else {
                const kids = metaChildren(b, { type, start: 0, body: headLen, end: size });
                if (kids && handlerOf(b, kids) === 'pict') {
                    // A HEIF picture's own meta box: its Exif and XMP items are blanked.
                    const p = heifMetadataPatches(b, at, src.size);
                    if (!p) fail('its picture items cannot be read with certainty');
                    plan.out.push(...p!);
                } else plan.out.push(...freePatches(box, at));
            }
        } else if (type === 'mdat') {
            mdats.push([at + headLen, at + size]);
        } else if (PADDING.has(type)) {
            plan.out.push(...await paddingPatches(src, at + headLen, at + size));
        } else if (!TOP_KEEP.has(type)) {
            // Anything a player does not need: Samsung's trailer and Motion Photo video, XMP, a preview, a vendor's box.
            plan.out.push(...freePatches(box, at));
        }
        at += size;
    }
    // ExifTool's own search (ScanMediaData): the first GPS_SCAN_FIRST bytes of the media data, and ALL
    // of it once a block is found (or the movie has a `gps ` index). The budget is shared by every
    // mdat, so the many small ones of a fragmented recording are not each searched.
    let budget = plan.gpsIndex ? Infinity : GPS_SCAN_FIRST;
    for (const [s, e] of mdats) {
        if (budget <= 0) break;
        const found = await gpsBlocks(src, s, e, budget);
        plan.media.push(...found);
        budget = found.length ? Infinity : budget - (e - s);
    }
    for (const [s, e] of merged(plan.media)) plan.out.push({ at: s, bytes: new Uint8Array(e - s) });
    return plan.out;
}
