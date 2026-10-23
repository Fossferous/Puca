/**
 * Removes the metadata a photo carries — where it was taken, when, on which
 * device, who edited it — from the bytes of a JPEG, PNG or WebP, BEFORE they
 * are encrypted. Púca's end-to-end encryption keeps a photo from the server;
 * it does nothing about the people in the channel, who are exactly who an
 * EXIF block's GPS position is shown to once the photo is opened.
 *
 * LOSSLESS: the compressed picture is copied byte for byte, never decoded and
 * never re-encoded, so the pixels cannot change. Only the containers that are
 * not the picture are dropped:
 *
 *   JPEG  APP1 (Exif, XMP, extended XMP), APP13 (Photoshop / IPTC), APP11
 *         (JUMBF / C2PA), the other APPn but the three a decoder needs, COM
 *         comments, a JFIF thumbnail, and everything after the end of the
 *         image (Motion Photo video, MPF secondary images, vendor trailers).
 *         KEPT: JFIF's header, the ICC colour profile (APP2), Adobe's colour
 *         transform (APP14) and every table and scan.
 *   PNG   eXIf, tEXt, iTXt, zTXt, tIME, every unknown ancillary chunk (C2PA's
 *         caBX among them) and anything after IEND. KEPT: the critical chunks
 *         and the ones that change how the picture looks (colour, palette,
 *         transparency, gamma, animation).
 *   WebP  EXIF, XMP and unknown chunks, inside animation frames too, and
 *         anything after the RIFF. KEPT: the picture, alpha, animation, ICC.
 *
 * ORIENTATION is the one thing worth keeping (a portrait photo from a phone
 * is stored sideways with a tag saying so; without it the picture arrives
 * lying down). It is kept as the ONLY entry of a minimal EXIF block that this
 * file writes itself, never copied from the original: 32 bytes that say "turn
 * it this way" and nothing else. The alternative — baking the rotation in —
 * means decoding and re-encoding, which is exactly what this does not do.
 *
 * MALFORMED INPUT FAILS LOUDLY. A file whose magic says JPEG/PNG/WebP but
 * whose segments or chunks cannot be walked (a length that runs off the end,
 * no image header) throws ImageMetadataError and the send is refused with a
 * sentence that says why. Passing it through would be the quiet way to leak:
 * a parser that cannot read a file is the very case where a block it skipped
 * is still there for the recipient's. A JPEG or PNG that is merely CUT SHORT
 * inside its picture data (a download that stopped) is not malformed in that
 * sense: everything before the cut is walked and checked, the rest is picture,
 * and it goes through. (A WebP's chunk sizes must add up; one cut short is refused.) Anything that is not one of the three formats — GIF, SVG, AVIF,
 * a PDF, a video — is returned untouched; the caller does not need to know the
 * type first, the bytes decide.
 */

/** A file that claims to be a JPEG, PNG or WebP and cannot be taken apart. */
export class ImageMetadataError extends Error {
    constructor(format: string, why: string) {
        super(`This ${format} photo looks damaged (${why}), so its location and camera details could not be safely removed and it was not sent. Re-save or re-export it as a new image and try again.`);
        this.name = 'ImageMetadataError';
    }
}

export type StrippableFormat = 'jpeg' | 'png' | 'webp';

/** Which of the three formats the bytes are, from their magic numbers alone. */
export function sniffStrippable(b: Uint8Array): StrippableFormat | null {
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
        && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'png';
    if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
    return null;
}

/**
 * The bytes without the metadata. The SAME array comes back when there was
 * nothing to remove (and for every other format), so a caller can tell by
 * identity and a clean file costs no copy.
 */
export function stripImageMetadata(bytes: Uint8Array): Uint8Array {
    switch (sniffStrippable(bytes)) {
        case 'jpeg': return stripJpeg(bytes);
        case 'png': return stripPng(bytes);
        case 'webp': return stripWebp(bytes);
        default: return bytes;
    }
}

/** The same for a File; the name and type are kept. Another type is returned as it came. */
export async function stripFileMetadata(file: File): Promise<File> {
    // Only what is, or may be, a picture is read: a 25 MB video is not pulled into memory for this.
    if (file.type && !/^image\/(jpeg|jpg|pjpeg|png|webp|x-png)$/i.test(file.type)) return file;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = stripImageMetadata(bytes);
    if (out === bytes) return file;
    return new File([out as BlobPart], file.name, { type: file.type, lastModified: file.lastModified });
}

// ---------------------------------------------------------------- helpers

function ascii(b: Uint8Array, at: number, n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[at + i]);
    return s;
}

function startsWith(b: Uint8Array, at: number, prefix: string): boolean {
    if (at + prefix.length > b.length) return false;
    for (let i = 0; i < prefix.length; i++) if (b[at + i] !== prefix.charCodeAt(i)) return false;
    return true;
}

const u16be = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1];
const u32be = (b: Uint8Array, at: number): number => ((b[at] * 0x1000000) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]));
const u32le = (b: Uint8Array, at: number): number => ((b[at + 3] * 0x1000000) + ((b[at + 2] << 16) | (b[at + 1] << 8) | b[at]));

function concat(parts: Uint8Array[]): Uint8Array {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

/**
 * The Orientation (2..8) from the first IFD of a TIFF structure, or 0 for
 * "upright, absent, or not something to trust". Every read is bounds-checked:
 * this runs on bytes a stranger chose.
 */
export function orientationOfTiff(t: Uint8Array): number {
    if (t.length < 8) return 0;
    const little = t[0] === 0x49 && t[1] === 0x49;
    const big = t[0] === 0x4D && t[1] === 0x4D;
    if (!little && !big) return 0;
    const r16 = (at: number) => (little ? t[at] | (t[at + 1] << 8) : u16be(t, at));
    const r32 = (at: number) => (little ? u32le(t, at) : u32be(t, at));
    if (r16(2) !== 42) return 0;
    const ifd = r32(4);
    if (ifd < 8 || ifd + 2 > t.length) return 0;
    const count = r16(ifd);
    for (let e = 0; e < count; e++) {
        const at = ifd + 2 + e * 12;
        if (at + 12 > t.length) return 0;
        if (r16(at) !== 0x0112) continue;
        // SHORT, one value, held in the entry itself.
        if (r16(at + 2) !== 3 || r32(at + 4) !== 1) return 0;
        const v = r16(at + 8);
        return v >= 2 && v <= 8 ? v : 0;
    }
    return 0;
}

/** TIFF structure holding ONLY Orientation: header, one IFD entry, no next IFD. */
function minimalTiff(orientation: number): Uint8Array {
    return Uint8Array.from([
        0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, // "MM", 42, IFD0 at 8
        0x00, 0x01, // one entry
        0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT, 1
        0x00, 0x00, 0x00, 0x00, // no next IFD
    ]);
}

// ------------------------------------------------------------------- JPEG

const EXIF_ID = 'Exif\0\0';

function stripJpeg(b: Uint8Array): Uint8Array {
    const n = b.length;
    // Everything before the first scan, in order: [marker bytes + length + payload].
    const head: Uint8Array[] = [];
    const body: Uint8Array[] = [];
    let into = head;
    let orientation = 0;
    let removed = false;
    let sawFrame = false;
    let i = 2; // after SOI
    while (i < n) {
        if (b[i] !== 0xFF) throw new ImageMetadataError('JPEG', 'a marker is missing');
        while (i + 1 < n && b[i + 1] === 0xFF) i++; // fill bytes
        if (i + 1 >= n) throw new ImageMetadataError('JPEG', 'it ends inside a marker');
        const m = b[i + 1];
        if (m === 0x00) throw new ImageMetadataError('JPEG', 'a stray byte sits between segments');
        if (m === 0xD9) { // EOI: whatever follows is not the picture
            into.push(b.subarray(i, i + 2));
            if (i + 2 < n) removed = true;
            break;
        }
        if (m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { // markers with no length
            into.push(b.subarray(i, i + 2));
            i += 2;
            continue;
        }
        if (i + 4 > n) throw new ImageMetadataError('JPEG', 'a segment header is cut off');
        const len = u16be(b, i + 2);
        if (len < 2 || i + 2 + len > n) throw new ImageMetadataError('JPEG', 'a segment is longer than the file');
        const seg = b.subarray(i, i + 2 + len);
        const payload = i + 4; // first byte after the length
        const plen = len - 2;
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) sawFrame = true;

        if (m === 0xDA) { // SOS: the header, then entropy-coded data up to the next real marker
            if (!sawFrame) throw new ImageMetadataError('JPEG', 'a scan comes before the image header');
            let j = i + 2 + len;
            for (;;) {
                const ff = b.indexOf(0xFF, j);
                if (ff < 0 || ff + 1 >= n) { j = n; break; }
                let k = ff + 1;
                while (k < n && b[k] === 0xFF) k++;
                if (k >= n) { j = n; break; }
                const c = b[k];
                if (c === 0x00 || (c >= 0xD0 && c <= 0xD7)) { j = k + 1; continue; } // stuffed byte or restart
                j = k - 1; // the FF in front of the marker
                break;
            }
            body.push(b.subarray(i, j));
            into = body;
            i = j;
            if (j >= n) break; // cut short inside the scan: everything before it was checked
            continue;
        }

        let keep: Uint8Array | null = seg;
        if (m === 0xE0) { // APP0
            if (plen >= 14 && startsWith(b, payload, 'JFIF\0')) {
                // A JFIF header with a thumbnail is a small picture of the ORIGINAL, uncropped photo.
                if (b[payload + 12] !== 0 || b[payload + 13] !== 0 || plen !== 14) {
                    const copy = Uint8Array.from(b.subarray(i, payload + 14));
                    copy[2] = 0; copy[3] = 16; // length of what is left
                    copy[payload - i + 12] = 0; copy[payload - i + 13] = 0;
                    keep = copy;
                    removed = true;
                }
            } else keep = null;
        } else if (m === 0xE1) { // APP1: Exif / XMP / extended XMP
            if (!orientation && startsWith(b, payload, EXIF_ID)) orientation = orientationOfTiff(b.subarray(payload + 6, payload + plen));
            keep = null;
        } else if (m === 0xE2) { // APP2: keep the ICC profile, drop MPF / FlashPix
            if (!startsWith(b, payload, 'ICC_PROFILE\0')) keep = null;
        } else if (m === 0xEE) { // APP14: Adobe's colour transform decides how CMYK / YCCK is read
            if (!startsWith(b, payload, 'Adobe')) keep = null;
        } else if ((m >= 0xE3 && m <= 0xEF) || m === 0xFE) { // the other APPn, COM
            keep = null;
        }
        if (keep) into.push(keep);
        else removed = true;
        i += 2 + len;
    }
    if (into === head) throw new ImageMetadataError('JPEG', 'it holds no picture data');
    if (!removed && !orientation) return b;

    // JFIF wants to be first after SOI; the orientation block goes right behind it.
    const first = head[0];
    const jfifFirst = first && first[1] === 0xE0;
    const orient = orientation ? [jpegOrientationSegment(orientation)] : [];
    return concat([
        b.subarray(0, 2),
        ...(jfifFirst ? [first] : []), ...orient, ...(jfifFirst ? head.slice(1) : head),
        ...body,
    ]);
}

function jpegOrientationSegment(orientation: number): Uint8Array {
    const tiff = minimalTiff(orientation);
    const len = 2 + EXIF_ID.length + tiff.length;
    const seg = new Uint8Array(2 + len);
    seg[0] = 0xFF; seg[1] = 0xE1; seg[2] = len >> 8; seg[3] = len & 0xFF;
    for (let k = 0; k < EXIF_ID.length; k++) seg[4 + k] = EXIF_ID.charCodeAt(k);
    seg.set(tiff, 4 + EXIF_ID.length);
    return seg;
}

// -------------------------------------------------------------------- PNG

/** The chunks a picture needs, or that change how it looks. Everything else
 *  ancillary (lower-case first letter) is dropped; an unknown CRITICAL one is
 *  kept, because a decoder will refuse the file without it. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'cLLI']);

let crcTable: Uint32Array | null = null;
function crc32(parts: Uint8Array[]): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let k = 0; k < 256; k++) {
            let c = k;
            for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            crcTable[k] = c >>> 0;
        }
    }
    let c = 0xFFFFFFFF;
    for (const p of parts) for (let k = 0; k < p.length; k++) c = crcTable[(c ^ p[k]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32([out.subarray(4, 8 + data.length)]));
    return out;
}

function stripPng(b: Uint8Array): Uint8Array {
    const n = b.length;
    const parts: Uint8Array[] = [b.subarray(0, 8)];
    let orientation = 0;
    let removed = false;
    let sawHeader = false;
    let headerAt = 1; // index in parts after IHDR
    let i = 8;
    while (i < n) {
        if (i + 8 > n) { removed = true; break; } // fewer bytes than a chunk header: nothing but debris
        const len = u32be(b, i);
        const type = ascii(b, i + 4, 4);
        const end = i + 12 + len;
        if (!sawHeader && type !== 'IHDR') throw new ImageMetadataError('PNG', 'the image header is missing');
        if (end > n) {
            // A picture cut off inside its data goes through as it is; a metadata chunk cut off
            // is debris. Anything else cannot be walked.
            if (type === 'IDAT' || type === 'fdAT') { parts.push(b.subarray(i, n)); break; }
            if (!PNG_KEEP.has(type) && type.charCodeAt(0) >= 0x61) { removed = true; break; }
            throw new ImageMetadataError('PNG', `the ${type} chunk is longer than the file`);
        }
        if (type === 'eXIf') {
            if (!orientation) orientation = orientationOfTiff(b.subarray(i + 8, i + 8 + len));
            removed = true;
        } else if (PNG_KEEP.has(type) || type.charCodeAt(0) < 0x61) {
            parts.push(b.subarray(i, end));
            if (type === 'IHDR') { sawHeader = true; headerAt = parts.length; }
        } else removed = true;
        i = end;
        if (type === 'IEND') {
            if (i < n) removed = true; // anything after the end
            break;
        }
    }
    if (!sawHeader) throw new ImageMetadataError('PNG', 'the image header is missing');
    if (!removed && !orientation) return b;
    if (orientation) parts.splice(headerAt, 0, pngChunk('eXIf', minimalTiff(orientation)));
    return concat(parts);
}

// ------------------------------------------------------------------- WebP

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const WEBP_FRAME_KEEP = new Set(['VP8 ', 'VP8L', 'ALPH']);

interface RiffChunk { type: string; data: Uint8Array }

/** The chunks inside `b[from, to)`; a size that runs past `to` is malformed. */
function riffChunks(b: Uint8Array, from: number, to: number, what: string): RiffChunk[] {
    const out: RiffChunk[] = [];
    let i = from;
    while (i < to) {
        if (i + 8 > to) throw new ImageMetadataError('WebP', `${what} ends inside a chunk header`);
        const size = u32le(b, i + 4);
        const dataEnd = i + 8 + size;
        if (dataEnd > to) throw new ImageMetadataError('WebP', `a ${ascii(b, i, 4).trim()} chunk is longer than the file`);
        out.push({ type: ascii(b, i, 4), data: b.subarray(i + 8, dataEnd) });
        i = dataEnd + (size & 1); // chunks are padded to an even length
    }
    return out;
}

function riffChunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + data.length + (data.length & 1));
    for (let k = 0; k < 4; k++) out[k] = type.charCodeAt(k);
    new DataView(out.buffer).setUint32(4, data.length, true);
    out.set(data, 8);
    return out;
}

function stripWebp(b: Uint8Array): Uint8Array {
    const declared = u32le(b, 4) + 8;
    const to = Math.min(declared, b.length);
    if (declared < 12 + 8) throw new ImageMetadataError('WebP', 'its size is wrong');
    // A file that stops short of its declared size is cut off: walk what is there.
    const chunks = riffChunks(b, 12, to, 'the file');
    if (!chunks.some(c => c.type === 'VP8 ' || c.type === 'VP8L' || c.type === 'ANMF')) throw new ImageMetadataError('WebP', 'it holds no picture data');

    let removed = declared < b.length;
    let orientation = 0;
    const kept: RiffChunk[] = [];
    for (const c of chunks) {
        if (c.type === 'EXIF') {
            if (!orientation) orientation = orientationOfTiff(startsWith(c.data, 0, EXIF_ID) ? c.data.subarray(6) : c.data);
            removed = true;
        } else if (!WEBP_KEEP.has(c.type)) {
            removed = true;
        } else if (c.type === 'ANMF') {
            if (c.data.length < 16) throw new ImageMetadataError('WebP', 'an animation frame is too short');
            const inner = riffChunks(c.data, 16, c.data.length, 'an animation frame');
            const innerKept = inner.filter(x => WEBP_FRAME_KEEP.has(x.type));
            if (innerKept.length === inner.length) kept.push(c);
            else {
                removed = true;
                kept.push({ type: 'ANMF', data: concat([c.data.subarray(0, 16), ...innerKept.map(x => riffChunk(x.type, x.data))]) });
            }
        } else kept.push(c);
    }
    if (!removed && !orientation) return b;

    // A file can only carry EXIF behind a VP8X header (its flags say what follows).
    const vp8x = kept.find(c => c.type === 'VP8X');
    if (vp8x && vp8x.data.length >= 10) {
        const flags = Uint8Array.from(vp8x.data);
        flags[0] &= ~(0x08 | 0x04); // EXIF, XMP
        if (orientation) flags[0] |= 0x08;
        vp8x.data = flags;
    } else orientation = 0;

    const body = concat([
        ...kept.map(c => riffChunk(c.type, c.data)),
        ...(orientation ? [riffChunk('EXIF', minimalTiff(orientation))] : []),
    ]);
    const out = new Uint8Array(12 + body.length);
    out.set(b.subarray(0, 12));
    new DataView(out.buffer).setUint32(4, 4 + body.length, true);
    out.set(body, 12);
    return out;
}
