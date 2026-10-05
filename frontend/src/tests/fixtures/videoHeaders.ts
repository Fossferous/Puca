/**
 * Minimal video container headers for api/videoDims.ts and the attachment
 * tests: just the boxes (MP4) or elements (WebM) a player reads a picture
 * size from, followed by some opaque media bytes.
 */

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const zeros = (n: number) => new Array<number>(n).fill(0);

/** An ISO BMFF box: 32-bit size, type, payload. */
export function box(type: string, ...payload: number[][]): number[] {
    const body = payload.flat();
    return [...be32(8 + body.length), ...ascii(type), ...body];
}

/** The same box with a 64-bit size (size field 1, then the real size). */
export function largeBox(type: string, ...payload: number[][]): number[] {
    const body = payload.flat();
    return [...be32(1), ...ascii(type), ...be32(0), ...be32(16 + body.length), ...body];
}

const FIXED_1 = 0x00010000;
const matrixFor = (rotate: 0 | 90 | 180 | 270): number[] => {
    // [a b u; c d v; x y w], 16.16 except u, v, w (2.30).
    const [a, b, c, d] = rotate === 90 ? [0, FIXED_1, -FIXED_1, 0]
        : rotate === 180 ? [-FIXED_1, 0, 0, -FIXED_1]
            : rotate === 270 ? [0, -FIXED_1, FIXED_1, 0]
                : [FIXED_1, 0, 0, FIXED_1];
    return [a, b, 0, c, d, 0, 0, 0, 0x40000000].flatMap(be32);
};

export interface TrackSpec {
    handler: string;
    width: number;
    height: number;
    rotate?: 0 | 90 | 180 | 270;
    version?: 0 | 1;
}

export function trak({ handler, width, height, rotate = 0, version = 0 }: TrackSpec): number[] {
    const times = version === 1 ? zeros(32) : zeros(20);
    const tkhd = box('tkhd', [version, 0, 0, 7], times, zeros(16), matrixFor(rotate), be32(width * 65536), be32(height * 65536));
    const hdlr = box('hdlr', zeros(4), zeros(4), ascii(handler), zeros(12), [0]);
    return box('trak', tkhd, box('mdia', box('mdhd', zeros(24)), hdlr));
}

/** ftyp, moov (the given tracks; a video track by default), then mdat —
 *  or mdat first and moov last, as a file written without "faststart". */
export function mp4Header(opts: { tracks?: TrackSpec[]; moovLast?: boolean; media?: number } = {}): Uint8Array {
    const tracks = opts.tracks ?? [{ handler: 'vide', width: 1920, height: 1080 }];
    const ftyp = box('ftyp', ascii('isom'), be32(0x200), ascii('isomiso2avc1mp41'));
    const moov = box('moov', box('mvhd', zeros(100)), ...tracks.map(trak));
    const mdat = box('mdat', new Array<number>(opts.media ?? 64).fill(7));
    return new Uint8Array(opts.moovLast ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat]);
}

// ---- Matroska / WebM --------------------------------------------------------

const ebmlSize = (n: number): number[] => (n < 0x7f ? [0x80 | n] : n < 0x3fff ? [0x40 | (n >> 8), n & 255] : [0x10 | ((n >>> 24) & 0x0f), (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const idBytes = (id: number): number[] => {
    const out: number[] = [];
    for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255);
    return out;
};
const uintBytes = (n: number): number[] => {
    const out: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255);
    return out.length ? out : [0];
};

export function el(id: number, ...payload: number[][]): number[] {
    const body = payload.flat();
    return [...idBytes(id), ...ebmlSize(body.length), ...body];
}
export const uel = (id: number, n: number) => el(id, uintBytes(n));

export interface WebmTrack {
    type: 1 | 2;
    width?: number;
    height?: number;
    displayWidth?: number;
    displayHeight?: number;
    displayUnit?: number;
}

/** EBML header, a Segment of unknown size (as MediaRecorder writes it):
 *  Info, Tracks, then a Cluster of unknown size. */
export function webmHeader(tracks: WebmTrack[] = [{ type: 1, width: 1280, height: 720 }]): Uint8Array {
    const header = el(0x1a45dfa3, el(0x4282, ascii('webm')));
    const entries = tracks.map((t, i) => el(0xae,
        uel(0xd7, i + 1),
        uel(0x83, t.type),
        t.type === 1 ? el(0xe0,
            t.width !== undefined ? uel(0xb0, t.width) : [],
            t.height !== undefined ? uel(0xba, t.height) : [],
            t.displayWidth !== undefined ? uel(0x54b0, t.displayWidth) : [],
            t.displayHeight !== undefined ? uel(0x54ba, t.displayHeight) : [],
            t.displayUnit !== undefined ? uel(0x54b2, t.displayUnit) : [],
        ) : el(0xe1, uel(0x9f, 2)),
    ));
    const segment = [
        ...idBytes(0x18538067), ...UNKNOWN_SIZE,
        ...el(0x1549a966, uel(0x2ad7b1, 1000000)),
        ...el(0x1654ae6b, ...entries),
        ...idBytes(0x1f43b675), ...UNKNOWN_SIZE, ...uel(0xe7, 0), ...new Array<number>(64).fill(7),
    ];
    return new Uint8Array([...header, ...segment]);
}
