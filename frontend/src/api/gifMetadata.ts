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
 * A BYTE THAT STARTS NO BLOCK, after a frame (stray padding, a spurious 0x00,
 * junk after the last frame with no trailer), ends the GIF there: Chromium's
 * and Firefox's decoders read such a byte as the end of the file and show
 * every frame before it, so the GIF is cut there and given its trailer. What
 * came after it is never shown, and is not sent.
 *
 * MALFORMED INPUT FAILS LOUDLY (ImageMetadataError): a block cut off before
 * its end, or a GIF with no frame before such a byte, is not passed on,
 * because a block this cannot walk is exactly where text it did not see would
 * still be. The one exception is a GIF cut off inside a frame's image data (a
 * download that stopped): everything before the cut was walked, and it goes
 * through as it is.
 *
 * The walk is written once, as a generator that asks for the bytes it needs
 * (gifWalk), so the same code reads a GIF in memory (stripGif: the seal, an
 * embedded picture in an SVG) and a File in slices (planGif: a peer-to-peer
 * send of any size, never read whole; the result is the original's slices).
 */
import { ImageMetadataError } from './imageMetadata';
import type { Source } from './metadataPatches';

export function isGif(b: Uint8Array): boolean {
    return b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
        && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;
}

const KEEP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012']);

const fail = (why: string): never => { throw new ImageMetadataError('GIF', why, 'picture'); };

/** What to send instead of the GIF: these ranges of it, in order, then a trailer byte when `trailer`. */
export interface GifPlan { keep: Array<[number, number]>; trailer: boolean }

/** A read the walk needs: up to `len` bytes at `at` (fewer at the end of the file). */
interface Need { at: number; len: number }
type Walk<T> = Generator<Need, T, Uint8Array>;

function* byteAt(at: number): Walk<number> {
    const b = yield { at, len: 1 };
    return b[0];
}

/** The end of a run of data sub-blocks starting at `i` (just past its 0 terminator), or -1 when it is cut off. */
function* subBlocksEnd(size: number, i: number): Walk<number> {
    for (;;) {
        if (i >= size) return -1;
        const n = yield* byteAt(i);
        if (n === 0) return i + 1;
        i += 1 + n;
    }
}

/** The walk of a GIF of `size` bytes: null when it is not a GIF or has nothing to remove. */
function* gifWalk(size: number): Walk<GifPlan | null> {
    const head = yield { at: 0, len: 13 };
    if (!isGif(head)) return null;
    if (size < 13 || head.length < 13) fail('it is shorter than its header');
    const packed = head[10];
    let i = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
    if (i > size) fail('its colour table is cut off');
    const keep: Array<[number, number]> = [[0, i]];
    let removed = false;
    let sawImage = false;
    let trailer = false;
    while (i < size) {
        const kind = yield* byteAt(i);
        if (kind === 0x3B) { // trailer
            keep.push([i, i + 1]);
            if (i + 1 < size) removed = true; // anything after it
            break;
        }
        if (kind === 0x2C) { // image descriptor
            if (i + 10 > size) fail('a frame header is cut off');
            const p = yield* byteAt(i + 9);
            let j = i + 10 + (p & 0x80 ? 3 * (1 << ((p & 7) + 1)) : 0);
            if (j + 1 > size) fail('a frame header is cut off');
            j += 1; // LZW minimum code size
            const end = yield* subBlocksEnd(size, j);
            sawImage = true;
            if (end < 0) { keep.push([i, size]); break; } // cut off inside its image data
            keep.push([i, end]);
            i = end;
            continue;
        }
        if (kind === 0x21) { // extension
            if (i + 2 > size) fail('an extension is cut off');
            const label = yield* byteAt(i + 1);
            const end = yield* subBlocksEnd(size, i + 2);
            if (end < 0) fail('an extension is cut off');
            let keepIt = false;
            if (label === 0xF9) keepIt = true; // graphic control
            else if (label === 0xFF) {
                // The application identifier is the first sub-block, 11 bytes (8 + 3).
                const id = yield { at: i + 2, len: 12 };
                if (id[0] === 11) keepIt = KEEP_APPS.has(String.fromCharCode(...id.subarray(1, 12)));
            }
            if (keepIt) keep.push([i, end]);
            else removed = true;
            i = end;
            continue;
        }
        // A byte that starts no block: the browsers end the GIF here, with every frame before it shown.
        if (!sawImage) fail(`it has a block it does not know (0x${kind.toString(16).padStart(2, '0')})`);
        removed = true;
        trailer = true;
        break;
    }
    if (!sawImage) fail('it holds no picture');
    // No trailer: kept as it came, every byte a block walked above.
    if (!removed) return null;
    return { keep, trailer };
}

/** The walk run over bytes in memory. */
function runSync<T>(walk: Walk<T>, b: Uint8Array): T {
    let step = walk.next(new Uint8Array(0));
    while (!step.done) step = walk.next(b.subarray(step.value.at, Math.min(b.length, step.value.at + step.value.len)));
    return step.value;
}

/**
 * The GIF without its comment, plain text and application blocks (but the
 * loop count and colour profile). The SAME array comes back when there was
 * nothing to remove.
 */
export function stripGif(b: Uint8Array): Uint8Array {
    const plan = runSync(gifWalk(b.length), b);
    if (!plan) return b;
    let n = plan.trailer ? 1 : 0;
    for (const [s, e] of plan.keep) n += e - s;
    const out = new Uint8Array(n);
    let at = 0;
    for (const [s, e] of plan.keep) { out.set(b.subarray(s, e), at); at += e - s; }
    if (plan.trailer) out[at] = 0x3B;
    return out;
}

/** The same walk over a Source (a File read in slices): null when there is nothing to remove. */
export async function planGif(src: Source): Promise<GifPlan | null> {
    const walk = gifWalk(src.size);
    let step = walk.next(new Uint8Array(0));
    while (!step.done) step = walk.next(await src.read(step.value.at, step.value.len));
    return step.value;
}

/** The File a plan describes: slices of the original, nothing read or copied. */
export function gifFile(file: File, plan: GifPlan): File {
    const parts: BlobPart[] = plan.keep.map(([s, e]) => file.slice(s, e));
    if (plan.trailer) parts.push(Uint8Array.of(0x3B));
    return new File(parts, file.name, { type: file.type, lastModified: file.lastModified });
}
