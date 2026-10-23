/**
 * Photos built byte by byte for the metadata tests (tests/imageMetadata.test.ts,
 * tests/attachmentMetadata.test.ts): structurally real JPEG / PNG / WebP files
 * whose metadata carries values the tests can look for, and whose picture data
 * is a known byte string, so "the pixels did not change" is an equality, not a
 * judgement. Nothing here depends on the module under test: the reader below is
 * its own, so a bug in one cannot hide in the other.
 */

export const SECRET_MAKE = 'SECRETCAM-Corp';
export const SECRET_MODEL = 'PhoneModelX-9000';
export const SECRET_DATE = '2026:10:23 14:05:09';
export const SECRET_XMP = 'SECRETXMP-creator-jane';
export const SECRET_COMMENT = 'SECRETCOMMENT-hello';
export const SECRET_IPTC = 'SECRETIPTC-caption';
/** 47 deg 36' 22.3" N as three EXIF rationals, little-endian: the bytes a GPS fix is made of. */
export const GPS_LAT_BYTES = Uint8Array.from([47, 0, 0, 0, 1, 0, 0, 0, 36, 0, 0, 0, 1, 0, 0, 0, 0xDF, 0, 0, 0, 10, 0, 0, 0]);

/** A picture's compressed data: stuffed FF00, a restart marker and a run of every byte value. */
export const SCAN = Uint8Array.from([0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0x78, 0xFF, 0x00, ...Array.from({ length: 200 }, (_, i) => (i * 7 + 3) & 0xFF).map(v => (v === 0xFF ? 0xFE : v))]);

export const enc = (s: string): Uint8Array => Uint8Array.from(Array.from(s, c => c.charCodeAt(0)));
export const cat = (...parts: Array<Uint8Array | number[]>): Uint8Array => {
    const out: number[] = [];
    for (const p of parts) for (const v of p) out.push(v);
    return Uint8Array.from(out);
};
export const be16 = (v: number) => [(v >> 8) & 0xFF, v & 0xFF];
export const be32 = (v: number) => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
export const le32 = (v: number) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

/** True when `needle` occurs in `hay`. */
export function contains(hay: Uint8Array, needle: Uint8Array | string): boolean {
    const n = typeof needle === 'string' ? enc(needle) : needle;
    outer: for (let i = 0; i + n.length <= hay.length; i++) {
        for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
        return true;
    }
    return false;
}

export function indexOfBytes(hay: Uint8Array, needle: Uint8Array | string, from = 0): number {
    const n = typeof needle === 'string' ? enc(needle) : needle;
    outer: for (let i = from; i + n.length <= hay.length; i++) {
        for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
        return i;
    }
    return -1;
}

/** Every value a test plants, as something to search an output for. */
export const SECRETS: Array<[string, Uint8Array]> = [
    ['camera make', enc(SECRET_MAKE)], ['camera model', enc(SECRET_MODEL)], ['capture date', enc(SECRET_DATE)],
    ['XMP', enc(SECRET_XMP)], ['comment', enc(SECRET_COMMENT)], ['IPTC', enc(SECRET_IPTC)], ['GPS latitude', GPS_LAT_BYTES],
];
export const leaked = (bytes: Uint8Array): string[] => SECRETS.filter(([, v]) => contains(bytes, v)).map(([k]) => k);

/**
 * A little-endian TIFF/EXIF structure: IFD0 (Make, Model, Orientation, DateTime,
 * GPSInfo) -> GPS IFD (lat/lon with refs), with values past 4 bytes in a data
 * area, exactly the layout a phone writes.
 */
export function exifTiff(orientation: number | null = 6, o: { gps?: boolean } = {}): Uint8Array {
    const gps = o.gps ?? true;
    const asc = (s: string) => cat(enc(s), [0]);
    const make = asc(SECRET_MAKE), model = asc(SECRET_MODEL), date = asc(SECRET_DATE);
    interface Ent { tag: number; type: number; count: number; value: Uint8Array }
    const ifd0: Ent[] = [
        { tag: 0x010F, type: 2, count: make.length, value: make },
        { tag: 0x0110, type: 2, count: model.length, value: model },
        ...(orientation === null ? [] : [{ tag: 0x0112, type: 3, count: 1, value: Uint8Array.from([orientation, 0]) }]),
        { tag: 0x0132, type: 2, count: date.length, value: date },
        ...(gps ? [{ tag: 0x8825, type: 4, count: 1, value: new Uint8Array(4) }] : []),
    ];
    const gpsIfd: Ent[] = [
        { tag: 1, type: 2, count: 2, value: Uint8Array.from([0x4E, 0]) },
        { tag: 2, type: 5, count: 3, value: GPS_LAT_BYTES },
        { tag: 3, type: 2, count: 2, value: Uint8Array.from([0x57, 0]) },
        { tag: 4, type: 5, count: 3, value: cat(GPS_LAT_BYTES.subarray(0, 8), [122, 0, 0, 0, 1, 0, 0, 0], [0, 0, 0, 0, 1, 0, 0, 0]) },
    ];
    const ifdSize = (e: Ent[]) => 2 + e.length * 12 + 4;
    const gpsAt = 8 + ifdSize(ifd0) + [...ifd0].reduce((n, e) => n + (e.value.length > 4 ? e.value.length : 0), 0);
    const dataAt0 = 8 + ifdSize(ifd0);
    const dataAt1 = gpsAt + ifdSize(gpsIfd);
    const out: number[] = [0x49, 0x49, 42, 0, 8, 0, 0, 0];
    const put = (list: Ent[], dataStart: number, gpsPtr?: number) => {
        out.push(list.length & 0xFF, list.length >> 8);
        let data = dataStart;
        const tail: number[] = [];
        for (const e of list) {
            out.push(e.tag & 0xFF, e.tag >> 8, e.type, 0, ...le32(e.count));
            if (e.tag === 0x8825 && gpsPtr !== undefined) out.push(...le32(gpsPtr));
            else if (e.value.length <= 4) { out.push(...e.value); for (let k = e.value.length; k < 4; k++) out.push(0); }
            else { out.push(...le32(data)); data += e.value.length; tail.push(...e.value); }
        }
        out.push(0, 0, 0, 0);
        out.push(...tail);
    };
    put(ifd0, dataAt0, gps ? gpsAt : undefined);
    if (gps) put(gpsIfd, dataAt1);
    return Uint8Array.from(out);
}

// ------------------------------------------------------------------- JPEG

export const jseg = (marker: number, payload: Uint8Array | number[]): Uint8Array =>
    cat([0xFF, marker], be16(payload.length + 2), payload);

export interface JpegOpts {
    orientation?: number | null;
    gps?: boolean;
    exif?: boolean;
    xmp?: boolean;
    comment?: boolean;
    iptc?: boolean;
    jfif?: 'plain' | 'thumbnail' | false;
    icc?: boolean;
    adobe?: boolean;
    mpf?: boolean;
    trailer?: Uint8Array;
    progressive?: boolean;
}

export function jpeg(o: JpegOpts = {}): Uint8Array {
    const parts: Uint8Array[] = [Uint8Array.from([0xFF, 0xD8])];
    const jfif = o.jfif === undefined ? 'plain' : o.jfif;
    if (jfif) {
        const thumb = jfif === 'thumbnail';
        parts.push(jseg(0xE0, cat(enc('JFIF'), [0, 1, 1, 0], be16(72), be16(72), thumb ? [2, 2] : [0, 0], thumb ? enc(SECRET_MAKE).subarray(0, 12) : [])));
    }
    if (o.exif !== false) parts.push(jseg(0xE1, cat(enc('Exif'), [0, 0], exifTiff(o.orientation === undefined ? 6 : o.orientation, { gps: o.gps }))));
    if (o.xmp) parts.push(jseg(0xE1, cat(enc('http://ns.adobe.com/xap/1.0/'), [0], enc(`<x:xmpmeta><dc:creator>${SECRET_XMP}</dc:creator></x:xmpmeta>`))));
    if (o.iptc) parts.push(jseg(0xED, cat(enc('Photoshop 3.0'), [0], enc('8BIM'), enc(SECRET_IPTC))));
    if (o.comment) parts.push(jseg(0xFE, enc(SECRET_COMMENT)));
    if (o.icc) parts.push(jseg(0xE2, cat(enc('ICC_PROFILE'), [0, 1, 1], enc('ICCDATA-profile-bytes'))));
    if (o.mpf) parts.push(jseg(0xE2, cat(enc('MPF'), [0], enc('secondary-image-index'))));
    if (o.adobe) parts.push(jseg(0xEE, cat(enc('Adobe'), [0, 100, 0, 0, 0, 0, 2])));
    parts.push(jseg(0xDB, cat([0], Array.from({ length: 64 }, (_, i) => i + 1))));
    parts.push(jseg(o.progressive ? 0xC2 : 0xC0, cat([8], be16(16), be16(16), [1, 1, 0x11, 0])));
    parts.push(jseg(0xC4, cat([0x00], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0])));
    parts.push(jseg(0xDA, [1, 1, 0, 0, 63, 0]));
    parts.push(SCAN);
    if (o.progressive) { // a second scan after a table, as progressive files have
        parts.push(jseg(0xC4, cat([0x10], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0])));
        parts.push(jseg(0xDA, [1, 1, 0, 1, 63, 0]));
        parts.push(Uint8Array.from([0x9A, 0xFF, 0x00, 0xBC]));
    }
    parts.push(Uint8Array.from([0xFF, 0xD9]));
    if (o.trailer) parts.push(o.trailer);
    return cat(...parts);
}

/** The JPEG's segments (marker, payload) up to the first scan, read independently. */
export function jpegSegments(b: Uint8Array): Array<{ marker: number; payload: Uint8Array }> {
    const out: Array<{ marker: number; payload: Uint8Array }> = [];
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xFF) {
        const marker = b[i + 1];
        if (marker === 0xD9) break;
        const len = (b[i + 2] << 8) | b[i + 3];
        out.push({ marker, payload: b.subarray(i + 4, i + 2 + len) });
        if (marker === 0xDA) break;
        i += 2 + len;
    }
    return out;
}

// -------------------------------------------------------------------- PNG

const table = (() => {
    const t = new Uint32Array(256);
    for (let k = 0; k < 256; k++) { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[k] = c >>> 0; }
    return t;
})();
export function crc32(b: Uint8Array): number {
    let c = 0xFFFFFFFF;
    for (const v of b) c = table[(c ^ v) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
export const pchunk = (type: string, data: Uint8Array | number[]): Uint8Array => {
    const d = Uint8Array.from(data);
    return cat(be32(d.length), enc(type), d, be32(crc32(cat(enc(type), d))));
};

export interface PngOpts { orientation?: number | null; text?: boolean; time?: boolean; unknown?: boolean; trailer?: Uint8Array; icc?: boolean }

export const IDAT_BYTES = Uint8Array.from(Array.from({ length: 120 }, (_, i) => (i * 13 + 5) & 0xFF));

export function png(o: PngOpts = {}): Uint8Array {
    const parts: Uint8Array[] = [Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])];
    parts.push(pchunk('IHDR', cat(be32(8), be32(8), [8, 2, 0, 0, 0])));
    parts.push(pchunk('sRGB', [0]));
    parts.push(pchunk('gAMA', be32(45455)));
    if (o.icc) parts.push(pchunk('iCCP', cat(enc('profile'), [0, 0], enc('zdata'))));
    parts.push(pchunk('pHYs', cat(be32(2835), be32(2835), [1])));
    const orientation = o.orientation === undefined ? 6 : o.orientation;
    if (orientation !== null) parts.push(pchunk('eXIf', exifTiff(orientation, { gps: true })));
    if (o.text !== false) {
        parts.push(pchunk('tEXt', cat(enc('Author'), [0], enc(SECRET_MAKE), [0], enc(SECRET_MODEL))));
        parts.push(pchunk('zTXt', cat(enc('Comment'), [0, 0], enc(SECRET_COMMENT))));
        parts.push(pchunk('iTXt', cat(enc('XML:com.adobe.xmp'), [0, 0, 0, 0, 0], enc(SECRET_XMP))));
    }
    if (o.time !== false) parts.push(pchunk('tIME', [0x07, 0xEA, 10, 23, 14, 5, 9]));
    if (o.unknown) { parts.push(pchunk('caBX', enc(SECRET_IPTC))); parts.push(pchunk('prVt', [1, 2, 3])); }
    parts.push(pchunk('IDAT', IDAT_BYTES));
    parts.push(pchunk('IEND', []));
    if (o.trailer) parts.push(o.trailer);
    return cat(...parts);
}

export function pngChunks(b: Uint8Array): Array<{ type: string; data: Uint8Array; crcOk: boolean }> {
    const out: Array<{ type: string; data: Uint8Array; crcOk: boolean }> = [];
    let i = 8;
    while (i + 12 <= b.length) {
        const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
        const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
        const data = b.subarray(i + 8, i + 8 + len);
        const crc = ((b[i + 8 + len] << 24) | (b[i + 9 + len] << 16) | (b[i + 10 + len] << 8) | b[i + 11 + len]) >>> 0;
        out.push({ type, data, crcOk: crc === crc32(b.subarray(i + 4, i + 8 + len)) });
        i += 12 + len;
    }
    return out;
}

// ------------------------------------------------------------------- WebP

export const wchunk = (type: string, data: Uint8Array | number[]): Uint8Array => {
    const d = Uint8Array.from(data);
    return cat(enc(type), le32(d.length), d, d.length & 1 ? [0] : []);
};
export const riff = (...chunks: Uint8Array[]): Uint8Array => {
    const body = cat(enc('WEBP'), ...chunks);
    return cat(enc('RIFF'), le32(body.length), body);
};

export const VP8_BYTES = Uint8Array.from(Array.from({ length: 41 }, (_, i) => (i * 11 + 1) & 0xFF)); // odd on purpose: padded
export const FRAME_BYTES = Uint8Array.from(Array.from({ length: 30 }, (_, i) => (i * 5 + 9) & 0xFF));

export interface WebpOpts { orientation?: number | null; xmp?: boolean; exif?: boolean; unknown?: boolean; animated?: boolean; icc?: boolean; exifPrefix?: boolean }

export function webp(o: WebpOpts = {}): Uint8Array {
    const orientation = o.orientation === undefined ? 6 : o.orientation;
    const withExif = o.exif !== false;
    const flags = (o.icc ? 0x20 : 0) | (o.animated ? 0x02 : 0) | (withExif ? 0x08 : 0) | (o.xmp ? 0x04 : 0);
    const chunks: Uint8Array[] = [wchunk('VP8X', cat([flags, 0, 0, 0], [15, 0, 0], [15, 0, 0]))];
    if (o.icc) chunks.push(wchunk('ICCP', enc('ICCDATA-profile-bytes')));
    if (o.animated) {
        chunks.push(wchunk('ANIM', [0, 0, 0, 0, 0, 0]));
        chunks.push(wchunk('ANMF', cat([0, 0, 0, 0, 0, 0, 7, 0, 0, 7, 0, 0, 100, 0, 0, 0], wchunk('VP8 ', FRAME_BYTES), ...(o.unknown ? [wchunk('SECR', enc(SECRET_IPTC))] : []))));
    } else {
        chunks.push(wchunk('VP8 ', VP8_BYTES));
    }
    if (withExif) chunks.push(wchunk('EXIF', cat(o.exifPrefix ? enc('Exif\0\0') : [], exifTiff(orientation, { gps: true }))));
    if (o.xmp) chunks.push(wchunk('XMP ', enc(`<x:xmpmeta>${SECRET_XMP}</x:xmpmeta>`)));
    if (o.unknown) chunks.push(wchunk('C2PA', enc(SECRET_IPTC)));
    return riff(...chunks);
}

export function riffChunkList(b: Uint8Array): Array<{ type: string; data: Uint8Array }> {
    const out: Array<{ type: string; data: Uint8Array }> = [];
    let i = 12;
    while (i + 8 <= b.length) {
        const size = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
        out.push({ type: String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]), data: b.subarray(i + 8, i + 8 + size) });
        i += 8 + size + (size & 1);
    }
    return out;
}
