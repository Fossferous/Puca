/**
 * A GIF without the text it can carry, before it is encrypted
 * (api/fileMetadata.ts). LOSSLESS: every frame's image data, colour tables
 * and timing are copied byte for byte; only blocks that are not the picture
 * are dropped.
 *
 *   DROPPED  comment extensions (0xFE: whatever an editor or a person wrote),
 *            plain text extensions (0x01: text drawn over the picture, which
 *            no browser draws), application extensions other than the loop
 *            count (XMP's "XMP DataXMP" among them: an editor's whole XMP
 *            packet), and everything after the trailer.
 *   KEPT     the header, the logical screen and global colour table, every
 *            graphic control extension (delays, disposal, transparency), every
 *            image (descriptor, local colour table, LZW data), the loop count
 *            (NETSCAPE2.0 / ANIMEXTS1.0: an animated GIF stays animated and
 *            loops as it did) and an ICC colour profile (ICCRGBG1012).
 *
 * MALFORMED INPUT FAILS LOUDLY (ImageMetadataError): an unknown block, or a
 * block cut off before its end, is not passed on, because a block this cannot
 * walk is exactly where text it did not see would still be. The one exception
 * is a GIF cut off inside a frame's image data (a download that stopped):
 * everything before the cut was walked, and it goes through as it is.
 */
import { ImageMetadataError } from './imageMetadata';

export function isGif(b: Uint8Array): boolean {
    return b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
        && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;
}

const KEEP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012']);

const fail = (why: string): never => { throw new ImageMetadataError('GIF', why, 'picture'); };

/** The end of a run of data sub-blocks starting at `i` (just past its 0 terminator), or -1 when it is cut off. */
function subBlocksEnd(b: Uint8Array, i: number): number {
    for (;;) {
        if (i >= b.length) return -1;
        const n = b[i];
        if (n === 0) return i + 1;
        i += 1 + n;
    }
}

/**
 * The GIF without its comment, plain text and application blocks (but the
 * loop count and colour profile). The SAME array comes back when there was
 * nothing to remove.
 */
export function stripGif(b: Uint8Array): Uint8Array {
    if (!isGif(b)) return b;
    if (b.length < 13) fail('it is shorter than its header');
    const packed = b[10];
    let i = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
    if (i > b.length) fail('its colour table is cut off');
    const keep: Array<[number, number]> = [[0, i]];
    let removed = false;
    let sawImage = false;
    while (i < b.length) {
        const kind = b[i];
        if (kind === 0x3B) { // trailer
            keep.push([i, i + 1]);
            if (i + 1 < b.length) removed = true; // anything after it
            break;
        }
        if (kind === 0x2C) { // image descriptor
            if (i + 10 > b.length) fail('a frame header is cut off');
            const p = b[i + 9];
            let j = i + 10 + (p & 0x80 ? 3 * (1 << ((p & 7) + 1)) : 0);
            if (j + 1 > b.length) fail('a frame header is cut off');
            j += 1; // LZW minimum code size
            const end = subBlocksEnd(b, j);
            sawImage = true;
            if (end < 0) { keep.push([i, b.length]); break; } // cut off inside its image data
            keep.push([i, end]);
            i = end;
            continue;
        }
        if (kind === 0x21) { // extension
            if (i + 2 > b.length) fail('an extension is cut off');
            const label = b[i + 1];
            const end = subBlocksEnd(b, i + 2);
            if (end < 0) fail('an extension is cut off');
            let keepIt = false;
            if (label === 0xF9) keepIt = true; // graphic control
            else if (label === 0xFF) {
                // The application identifier is the first sub-block, 11 bytes (8 + 3).
                if (b[i + 2] === 11) {
                    let id = '';
                    for (let k = 0; k < 11; k++) id += String.fromCharCode(b[i + 3 + k]);
                    keepIt = KEEP_APPS.has(id);
                }
            }
            if (keepIt) keep.push([i, end]);
            else removed = true;
            i = end;
            continue;
        }
        fail(`it has a block it does not know (0x${kind.toString(16).padStart(2, '0')})`);
    }
    if (!sawImage) fail('it holds no picture');
    // No trailer: kept as it came, every byte a block walked above.
    if (!removed) return b;
    let n = 0;
    for (const [s, e] of keep) n += e - s;
    const out = new Uint8Array(n);
    let at = 0;
    for (const [s, e] of keep) { out.set(b.subarray(s, e), at); at += e - s; }
    return out;
}
