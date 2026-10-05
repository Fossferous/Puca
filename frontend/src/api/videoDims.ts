/**
 * The picture size a video file declares in its container header, read from
 * the decrypted bytes without a player: MP4 / MOV (ISO BMFF, fragmented or
 * not, moov anywhere) and Matroska / WebM.
 *
 * WHY. A message's video gets a live <video> only while it is among the few
 * closest to the screen (components/attachmentZone.ts); the others, loaded
 * and waiting, used to be a 30 px chip that grew to a ~260 px player the
 * moment one came on screen. Scrolling up through videos posted back to back,
 * that growth pushed whatever the reader was looking at 100-380 px down
 * (measured 2026-10-05 in Edge, 1 step in 5 on desktop, 2 in 5 in the phone
 * layout). Knowing the picture size before there is a player lets the
 * waiting video take the player's box already (MessageContent's stand-in),
 * so giving it a player changes no layout.
 *
 * What a player would show: an MP4 track turned a quarter (a phone held
 * upright records 1920x1080 with a 90 degree matrix) is reported upright,
 * and a WebM's DisplayWidth/DisplayHeight win over its pixel size. Anything
 * else, or anything that does not parse, is null — the caller then waits for
 * the player's own metadata, as before.
 */

export interface VideoDims {
    width: number;
    height: number;
}

/** Never read past this many top-level boxes / elements: a header is near
 *  the start (or, for an MP4 written without "faststart", after one mdat). */
const MAX_STEPS = 4096;

export function readVideoDims(bytes: Uint8Array): VideoDims | null {
    try {
        if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
            return matroskaDims(bytes);
        }
        return isoBmffDims(bytes);
    } catch {
        return null;
    }
}

const sane = (w: number, h: number): VideoDims | null =>
    Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1 && w <= 65535 && h <= 65535 ? { width: w, height: h } : null;

// ---- ISO BMFF (MP4, MOV, fragmented MP4) ------------------------------------

interface Box { type: string; start: number; end: number }

/** The boxes directly inside [from, to). */
function* boxes(dv: DataView, from: number, to: number): Generator<Box> {
    let off = from;
    for (let steps = 0; off + 8 <= to && steps < MAX_STEPS; steps++) {
        let size = dv.getUint32(off);
        const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
        let header = 8;
        if (size === 1) {
            if (off + 16 > to) return;
            const big = dv.getBigUint64(off + 8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) return;
            size = Number(big);
            header = 16;
        } else if (size === 0) {
            size = to - off;
        }
        if (size < header) return;
        const end = off + size;
        yield { type, start: off + header, end: Math.min(end, to) };
        if (end > to) return;
        off = end;
    }
}

const child = (dv: DataView, b: Box, type: string): Box | undefined => {
    for (const c of boxes(dv, b.start, b.end)) if (c.type === type) return c;
    return undefined;
};

function isoBmffDims(bytes: Uint8Array): VideoDims | null {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let moov: Box | undefined;
    for (const b of boxes(dv, 0, bytes.byteLength)) {
        if (b.type === 'moov') { moov = b; break; }
    }
    if (!moov) return null;
    for (const trak of boxes(dv, moov.start, moov.end)) {
        if (trak.type !== 'trak') continue;
        const mdia = child(dv, trak, 'mdia');
        const hdlr = mdia && child(dv, mdia, 'hdlr');
        // hdlr: version+flags (4), pre_defined (4), handler_type (4).
        if (!hdlr || hdlr.start + 12 > hdlr.end) continue;
        const handler = String.fromCharCode(dv.getUint8(hdlr.start + 8), dv.getUint8(hdlr.start + 9), dv.getUint8(hdlr.start + 10), dv.getUint8(hdlr.start + 11));
        if (handler !== 'vide') continue;
        const tkhd = child(dv, trak, 'tkhd');
        if (!tkhd) continue;
        // tkhd: version+flags (4); times, track id, reserved, duration (20, or
        // 32 in version 1); reserved (8), layer, alternate group, volume,
        // reserved (2 each); matrix (9 x 4); width, height (16.16 fixed).
        const matrix = tkhd.start + 4 + (dv.getUint8(tkhd.start) === 1 ? 32 : 20) + 16;
        if (matrix + 44 > tkhd.end) continue;
        let w = dv.getUint32(matrix + 36) / 65536;
        let h = dv.getUint32(matrix + 40) / 65536;
        // A quarter turn: a and d (the scale terms) are 0, b and c are not.
        const a = dv.getInt32(matrix), b = dv.getInt32(matrix + 4), c = dv.getInt32(matrix + 12), d = dv.getInt32(matrix + 16);
        if (a === 0 && d === 0 && b !== 0 && c !== 0) [w, h] = [h, w];
        const dims = sane(Math.round(w), Math.round(h));
        if (dims) return dims;
    }
    return null;
}

// ---- Matroska / WebM --------------------------------------------------------

const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;
const DISPLAY_WIDTH = 0x54b0;
const DISPLAY_HEIGHT = 0x54ba;
const DISPLAY_UNIT = 0x54b2;

interface Element { id: number; start: number; end: number; unknownSize: boolean }

/** An EBML variable-length integer at `off`: its value (marker bit kept for
 *  an ID, dropped for a size) and its length; null if malformed. */
function vint(b: Uint8Array, off: number, keepMarker: boolean): { value: number; length: number; allOnes: boolean } | null {
    if (off >= b.length) return null;
    const first = b[off];
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
    if (length > 8 || off + length > b.length) return null;
    let value = keepMarker ? first : first & (0xff >> length);
    let allOnes = value === (0xff >> length);
    for (let i = 1; i < length; i++) {
        value = value * 256 + b[off + i];
        if (b[off + i] !== 0xff) allOnes = false;
    }
    return { value, length, allOnes };
}

function* elements(b: Uint8Array, from: number, to: number): Generator<Element> {
    let off = from;
    for (let steps = 0; off < to && steps < MAX_STEPS; steps++) {
        const id = vint(b, off, true);
        if (!id) return;
        const size = vint(b, off + id.length, false);
        if (!size) return;
        const start = off + id.length + size.length;
        const unknownSize = size.allOnes;
        const end = unknownSize ? to : Math.min(start + size.value, to);
        yield { id: id.value, start, end, unknownSize };
        if (unknownSize) return; // only a Segment (or a Cluster, where we stop) is written that way
        off = start + size.value;
    }
}

const uint = (b: Uint8Array, e: Element): number => {
    let v = 0;
    for (let i = e.start; i < e.end && i < e.start + 8; i++) v = v * 256 + b[i];
    return v;
};

function matroskaDims(b: Uint8Array): VideoDims | null {
    for (const top of elements(b, 0, b.length)) {
        if (top.id !== SEGMENT) continue;
        for (const seg of elements(b, top.start, top.end)) {
            if (seg.id === CLUSTER) return null; // the tracks come before the first cluster
            if (seg.id !== TRACKS) continue;
            for (const entry of elements(b, seg.start, seg.end)) {
                if (entry.id !== TRACK_ENTRY) continue;
                let type = 0;
                let video: Element | undefined;
                for (const f of elements(b, entry.start, entry.end)) {
                    if (f.id === TRACK_TYPE) type = uint(b, f);
                    else if (f.id === VIDEO) video = f;
                }
                if (type !== 1 || !video) continue;
                let pw = 0, ph = 0, dw = 0, dh = 0, unit = 0;
                for (const f of elements(b, video.start, video.end)) {
                    if (f.id === PIXEL_WIDTH) pw = uint(b, f);
                    else if (f.id === PIXEL_HEIGHT) ph = uint(b, f);
                    else if (f.id === DISPLAY_WIDTH) dw = uint(b, f);
                    else if (f.id === DISPLAY_HEIGHT) dh = uint(b, f);
                    else if (f.id === DISPLAY_UNIT) unit = uint(b, f);
                }
                return (unit === 0 && dw && dh ? sane(dw, dh) : null) ?? sane(pw, ph);
            }
            return null;
        }
    }
    return null;
}
