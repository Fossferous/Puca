/**
 * The metadata of a GIF, TIFF, HEIC/AVIF, MP4/MOV and WebM/MKV is gone before
 * the file leaves the device (api/fileMetadata.ts), and the picture or the
 * media is the same bytes.
 *
 * The fixtures are REAL files (src/tests/fixtures/metadata, made by Pillow and
 * FFmpeg with make-fixtures.py there) carrying made-up camera, place and
 * author values; each test first checks they are there (the control), then
 * that none is left, that the media itself is untouched, and that a second
 * pass changes nothing. The real decoders, before and after, are in
 * e2e/photo-metadata-real-browser.mjs. Below that: every truncation, random
 * corruptions and absurd lengths, which must end in the one error the UI
 * knows how to say (ImageMetadataError) or a clean result, never a hang.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripAttachmentMetadata, stripFileMetadata } from '../api/fileMetadata';
import { ImageMetadataError } from '../api/imageMetadata';
import { stripGif } from '../api/gifMetadata';
import { MAX_PATCH_BYTES, type Source } from '../api/metadataPatches';
import { GPS_SCAN_FIRST, planIsoBmff } from '../api/isoBmffMetadata';
import { be32, cat, contains, enc } from './fixtures/photoMetadata';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'metadata', name)));

/** Everything the fixtures plant, and what the tools that made them wrote about themselves. */
const MARKS = ['SECRETCAM-Corp', 'PhoneModelX-9000', 'SECRETXMP-creator-jane', 'SECRETCOMMENT-hello', 'SECRETIPTC-caption',
    '+47.6062-122.3321', 'SECRETCAM-Firmware', 'SECRETCAM-Software', '2026:10:23', '2026-10-23', 'Lavf', 'Lavc', 'note.txt', 'loci', '\xA9xyz'];
const marks = (b: Uint8Array) => MARKS.filter(m => contains(b, m));

/** Seconds since 1904 (QuickTime's epoch) of 2026-10-23T14:05:09Z, as mvhd stores a creation time. */
const QT_TIME = Uint8Array.from(be32(Date.UTC(2026, 9, 23, 14, 5, 9) / 1000 + 2082844800));

const strip = (b: Uint8Array, name: string) => stripAttachmentMetadata(b.slice(), { name });

// ---- independent readers (not the module under test)

interface IsoBox { type: string; at: number; size: number; head: number }
function isoBoxes(b: Uint8Array, from = 0, to = b.length): IsoBox[] {
    const out: IsoBox[] = [];
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let at = from; at + 8 <= to;) {
        let size = dv.getUint32(at), head = 8;
        if (size === 1) { size = Number(dv.getBigUint64(at + 8)); head = 16; }
        if (size === 0) size = to - at;
        out.push({ type: String.fromCharCode(...b.subarray(at + 4, at + 8)), at, size, head });
        at += size;
    }
    return out;
}
const child = (b: Uint8Array, box: IsoBox, type: string, skip = 0) => isoBoxes(b, box.at + box.head + skip, box.at + box.size).find(x => x.type === type);
const region = (b: Uint8Array, box: IsoBox) => b.subarray(box.at, box.at + box.size);

/** The GIF's image blocks (descriptor, colour table, LZW data), in order. */
function gifFrames(b: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let i = 13 + (b[10] & 0x80 ? 3 * (1 << ((b[10] & 7) + 1)) : 0);
    const subs = (j: number) => { while (b[j] !== 0) j += 1 + b[j]; return j + 1; };
    while (i < b.length && b[i] !== 0x3B) {
        if (b[i] === 0x21) { i = subs(i + 2); continue; }
        const start = i;
        let j = i + 10 + (b[i + 9] & 0x80 ? 3 * (1 << ((b[i + 9] & 7) + 1)) : 0) + 1;
        j = subs(j);
        frames.push(b.subarray(start, j));
        i = j;
    }
    return frames;
}
const gifApps = (b: Uint8Array) => {
    const ids: string[] = [];
    for (let i = 0; i + 14 < b.length; i++) if (b[i] === 0x21 && b[i + 1] === 0xFF && b[i + 2] === 11) ids.push(String.fromCharCode(...b.subarray(i + 3, i + 14)));
    return ids;
};

/** The Matroska elements at the top of the Segment, by ID, with their extents. */
function ebmlTop(b: Uint8Array): Array<{ id: number; at: number; end: number }> {
    const vint = (i: number, keepMarker: boolean) => {
        let len = 1;
        while (!(b[i] & (0x80 >> (len - 1)))) len++;
        let v = keepMarker ? b[i] : b[i] & (0xFF >> len);
        for (let k = 1; k < len; k++) v = v * 256 + b[i + k];
        return { v, len };
    };
    let i = 0;
    const out: Array<{ id: number; at: number; end: number }> = [];
    const ebml = vint(i, true), es = vint(i + ebml.len, false);
    i += ebml.len + es.len + es.v;
    const seg = vint(i, true), ss = vint(i + seg.len, false);
    i += seg.len + ss.len;
    while (i < b.length) {
        const id = vint(i, true), sz = vint(i + id.len, false);
        const end = i + id.len + sz.len + sz.v;
        out.push({ id: id.v, at: i, end });
        i = end;
    }
    return out;
}

// ---- each format, its control, and the media untouched

describe('a GIF', () => {
    const gif = fixture('animated.gif');
    it('control: the GIF going in carries a comment, XMP and text', () => {
        expect(marks(gif)).toEqual(expect.arrayContaining(['SECRETXMP-creator-jane', 'SECRETCOMMENT-hello']));
        expect(gifApps(gif)).toContain('XMP DataXMP');
    });
    it('loses them, keeps every frame byte for byte, still loops, and is stable on a second pass', async () => {
        const out = await strip(gif, 'a.gif');
        expect(marks(out)).toEqual([]);
        expect(gifApps(out), 'the loop count stays: still animated, still looping').toEqual(['NETSCAPE2.0']);
        const a = gifFrames(gif), b = gifFrames(out);
        expect(a.length, 'control: two frames').toBe(2);
        expect(b.map(f => Array.from(f).join())).toEqual(a.map(f => Array.from(f).join()));
        expect(out[out.length - 1]).toBe(0x3B);
        expect(stripGif(out), 'nothing more to take').toBe(out);
    });
    it('a byte that starts no block after a frame ends it there, as the browsers read it: every frame before it kept, a trailer given, nothing after it sent', async () => {
        const body = gif.subarray(0, gif.length - 1); // without its trailer
        const comment = cat([0x21, 0xFE, 19], enc('SECRETCOMMENT-after'), [0]);
        const frames = gifFrames(gif).map(f => Array.from(f).join());
        for (const [what, input] of [
            ['zero padding after the last frame, no trailer', cat(body, [0, 0, 0, 0])],
            ['a stray 0x00, then a comment and the trailer', cat(body, [0x00], comment, [0x3B])],
            ['junk after the last frame, then a comment', cat(body, enc('padding'), comment)],
        ] as Array<[string, Uint8Array]>) {
            const out = await strip(input, 'party.gif');
            expect(marks(out), what).toEqual([]);
            expect(contains(out, 'SECRETCOMMENT-after'), what).toBe(false);
            expect(gifFrames(out).map(f => Array.from(f).join()), what).toEqual(frames);
            expect(out[out.length - 1], what).toBe(0x3B);
            expect(stripGif(out), `${what}: nothing more to take`).toBe(out);
        }
    });
    it('a byte that starts no block before any frame is still refused (there is no picture before it)', async () => {
        const first = 13 + (gif[10] & 0x80 ? 3 * (1 << ((gif[10] & 7) + 1)) : 0);
        expect([0x21, 0x2C], 'control: a block starts there').toContain(gif[first]);
        await expect(strip(cat(gif.subarray(0, first), [0x00], gif.subarray(first)), 'a.gif')).rejects.toBeInstanceOf(ImageMetadataError);
    });
});

describe('a TIFF', () => {
    const tif = fixture('photo.tif');
    it('control: the TIFF going in carries the camera, the software, the author, XMP and a GPS fix', () => {
        expect(marks(tif)).toEqual(expect.arrayContaining(['SECRETCAM-Corp', 'PhoneModelX-9000', 'SECRETXMP-creator-jane', 'SECRETCAM-Software', '2026:10:23']));
    });
    it('loses them in place, its strips untouched, and a second pass changes nothing', async () => {
        const out = await strip(tif, 'scan.tif');
        expect(out.length).toBe(tif.length);
        expect(marks(out)).toEqual([]);
        // The picture: 64 x 48 RGB, uncompressed, in one strip right after the header (Pillow).
        const ifd = new DataView(out.buffer, out.byteOffset).getUint32(4, true);
        const count = out[ifd] | (out[ifd + 1] << 8);
        const tags: number[] = [];
        for (let e = 0; e < count; e++) tags.push(out[ifd + 2 + e * 12] | (out[ifd + 3 + e * 12] << 8));
        expect(tags, 'only the picture\'s own tags are left').toEqual(tags.filter(t => [256, 257, 258, 259, 262, 273, 274, 277, 278, 279, 282, 283, 284, 296, 34675].includes(t)));
        expect(tags).toEqual(expect.arrayContaining([256, 257, 258, 259, 262, 273, 277, 278, 279]));
        const strip0 = (b: Uint8Array) => {
            const dv = new DataView(b.buffer, b.byteOffset);
            const at = dv.getUint32(4, true), n = dv.getUint16(at, true);
            let off = 0, len = 0;
            for (let e = 0; e < n; e++) {
                const p = at + 2 + e * 12, tag = dv.getUint16(p, true);
                if (tag === 273) off = dv.getUint32(p + 8, true);
                if (tag === 279) len = dv.getUint32(p + 8, true);
            }
            return b.subarray(off, off + len);
        };
        expect(strip0(out).length).toBe(64 * 48 * 3);
        expect(Array.from(strip0(out)).join()).toBe(Array.from(strip0(tif)).join());
        expect(Array.from(await strip(out, 'scan.tif')).join()).toBe(Array.from(out).join());
    });
    it('a camera raw file in a TIFF\'s clothing (DNG, CR2, by name) goes as it is', async () => {
        const nef = await strip(tif, 'DSC_0001.NEF');
        expect(Array.from(nef).join()).toBe(Array.from(tif).join());
        const cr2 = tif.slice(); cr2[8] = 0x43; cr2[9] = 0x52;
        expect(Array.from(await strip(cr2, 'x.tif')).join()).toBe(Array.from(cr2).join());
    });
    it('BigTIFF is refused, not sent unread', async () => {
        await expect(strip(Uint8Array.from([0x49, 0x49, 0x2B, 0, 8, 0, 0, 0, ...new Array(16).fill(0)]), 'big.tif')).rejects.toBeInstanceOf(ImageMetadataError);
    });
});

describe('a HEIC or AVIF photo', () => {
    const avif = fixture('photo.avif');
    it('control: the AVIF going in carries the camera, its firmware, the time and XMP', () => {
        expect(marks(avif)).toEqual(expect.arrayContaining(['SECRETCAM-Corp', 'PhoneModelX-9000', 'SECRETXMP-creator-jane', '2026:10:23']));
    });
    it('loses them in place; the coded picture (mdat) is the same bytes', async () => {
        const out = await strip(avif, 'photo.avif');
        expect(out.length).toBe(avif.length);
        expect(marks(out)).toEqual([]);
        const mdat = isoBoxes(avif).find(x => x.type === 'mdat')!;
        // The picture item (av01) is in mdat; Pillow writes Exif and XMP items there too, so only
        // the bytes that are not an Exif or XMP item must match.
        const changed: number[] = [];
        for (let i = mdat.at; i < mdat.at + mdat.size; i++) if (out[i] !== avif[i]) changed.push(i);
        const metaBox = isoBoxes(avif).find(x => x.type === 'meta')!;
        expect(changed.length, 'some item bytes changed').toBeGreaterThan(0);
        // Every changed byte lies in an extent the meta box lists for an Exif or mime item: checked
        // through the module's own HEIC path, which was written and tested against libheif.
        const { stripHeifMetadata } = await import('../api/heifMetadata');
        const viaHeif = stripHeifMetadata(avif);
        expect(viaHeif, 'the HEIC path reads it the same').not.toBeNull();
        expect(Array.from(region(out, metaBox)).join()).toBe(Array.from(region(viaHeif!, metaBox)).join());
        expect(Array.from(out).join(), 'byte for byte what the HEIC path makes').toBe(Array.from(viaHeif!).join());
        expect(Array.from(await strip(out, 'photo.avif')).join()).toBe(Array.from(out).join());
    });
    it('the HEIC fixtures of the HEIC path lose theirs the same way', async () => {
        for (const name of ['rotated-gps.heic', 'exif-xmp.heic']) {
            const heic = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'heic', name)));
            const { stripHeifMetadata } = await import('../api/heifMetadata');
            const out = await strip(heic, name);
            expect(Array.from(out).join(), name).toBe(Array.from(stripHeifMetadata(heic)!).join());
        }
    });
});

describe('an MP4 or MOV video', () => {
    for (const [name, controls] of [
        ['video.mp4', ['SECRETCOMMENT-hello', 'SECRETIPTC-caption', 'loci', 'Lavf', 'Lavc']],
        ['video.mov', ['SECRETCAM-Corp', 'PhoneModelX-9000', '+47.6062-122.3321', 'SECRETCOMMENT-hello', 'Lavf', 'Lavc']],
    ] as Array<[string, string[]]>) {
        const v = fixture(name);
        it(`${name}: control: it carries the place, the title, the comment and the software, and a creation time`, () => {
            expect(marks(v)).toEqual(expect.arrayContaining(controls));
            expect(contains(v, QT_TIME), 'the creation time in mvhd').toBe(true);
        });
        it(`${name}: loses all of it in place; mdat is the same bytes; nothing moved`, async () => {
            const out = await strip(v, name);
            expect(out.length).toBe(v.length);
            expect(marks(out)).toEqual([]);
            expect(contains(out, QT_TIME), 'no creation time').toBe(false);
            const top = isoBoxes(out);
            expect(top.map(x => [x.type, x.at, x.size]), 'every top-level box where it was').toEqual(isoBoxes(v).map(x => [x.type, x.at, x.size]));
            const mdat = top.find(x => x.type === 'mdat')!;
            expect(Array.from(region(out, mdat)).join(), 'the media data').toBe(Array.from(region(v, mdat)).join());
            const moov = top.find(x => x.type === 'moov')!;
            const kids = isoBoxes(out, moov.at + 8, moov.at + moov.size).map(x => x.type);
            expect(kids).not.toContain('udta');
            expect(kids).not.toContain('meta');
            expect(kids).toContain('free');
            expect(kids, 'the track is there').toContain('trak');
            expect(Array.from(await strip(out, name)).join(), 'a second pass changes nothing').toBe(Array.from(out).join());
        });
    }
    it('the sample tables of the video track are untouched (the same frames from the same places)', async () => {
        const v = fixture('video.mp4');
        const out = await strip(v, 'video.mp4');
        const at = (b: Uint8Array) => {
            const moov = isoBoxes(b).find(x => x.type === 'moov')!;
            const trak = child(b, moov, 'trak')!, mdia = child(b, trak, 'mdia')!, minf = child(b, mdia, 'minf')!, stbl = child(b, minf, 'stbl')!;
            return ['stsz', 'stco', 'stsc', 'stts', 'stss'].map(t => Array.from(region(b, child(b, stbl, t)!)).join());
        };
        expect(at(out)).toEqual(at(v));
    });
    it('a Canon CR3 (an ISO file of brand crx) goes as it is', async () => {
        const cr3 = cat(be32(16), enc('ftypcrx '), be32(1), be32(16), enc('udtaSECRETCAM-Corp'.slice(0, 8)));
        const out = await strip(cr3, 'IMG_0001.CR3');
        expect(Array.from(out).join()).toBe(Array.from(cr3).join());
    });
});

/** A hand-built MP4 with a timed metadata track (as GoPro's GPMF and Google's camm are). */
function mp4WithMetadataTrack(o: { fragmented?: boolean; stszCount?: number; perChunk?: number; handler?: string } = {}) {
    const box = (type: string, ...body: Array<Uint8Array | number[]>) => { const b = cat(...body); return cat(be32(8 + b.length), enc(type), b); };
    const full = (type: string, ...body: Array<Uint8Array | number[]>) => box(type, [0, 0, 0, 0], ...body);
    const samples = [enc('GPS1-SECRETPOS-47.6062'), enc('GPS2-SECRETPOS-122.3321')];
    const video = enc('VIDEO-FRAME-BYTES-KEEP');
    const ftyp = box('ftyp', enc('isom'), be32(0), enc('isom'));
    const mdatBody = cat(video, ...samples);
    const mdat = box('mdat', mdatBody);
    const mdatAt = ftyp.length + 8;
    const sampleAt = mdatAt + video.length;
    const stbl = (offset: number, sizes: number[]) => box('minf', box('stbl',
        full('stsd', be32(0)),
        full('stsz', be32(0), be32(o.stszCount ?? sizes.length), ...sizes.map(be32)),
        full('stsc', be32(1), be32(1), be32(o.perChunk ?? sizes.length), be32(1)),
        full('stco', be32(1), be32(offset)),
    ));
    const trak = (handler: string, offset: number, sizes: number[]) => box('trak',
        full('tkhd', new Array(80).fill(0)),
        box('mdia', full('mdhd', new Array(20).fill(0)), full('hdlr', be32(0), enc(handler), new Array(12).fill(0), [0]), stbl(offset, sizes)));
    const moov = box('moov', full('mvhd', new Array(96).fill(0)),
        trak('vide', mdatAt, [video.length]),
        trak(o.handler ?? 'meta', sampleAt, samples.map(s => s.length)),
        ...(o.fragmented ? [box('mvex', full('trex', new Array(20).fill(0)))] : []));
    return { file: cat(ftyp, mdat, moov), video, samples };
}

describe('a timed metadata track (a GoPro\'s GPS, a phone\'s motion)', () => {
    it('becomes free, and every sample of it in mdat is zeroed; the video samples stay', async () => {
        const { file, video } = mp4WithMetadataTrack();
        expect(contains(file, 'SECRETPOS'), 'control').toBe(true);
        const out = await strip(file, 'GOPR0001.MP4');
        expect(out.length).toBe(file.length);
        expect(contains(out, 'SECRETPOS')).toBe(false);
        expect(contains(out, video), 'the video frame').toBe(true);
        const moov = isoBoxes(out).find(x => x.type === 'moov')!;
        expect(isoBoxes(out, moov.at + 8, moov.at + moov.size).map(x => x.type)).toEqual(['mvhd', 'trak', 'free']);
    });
    it('in a fragmented file (its samples in fragments) it is refused', async () => {
        await expect(strip(mp4WithMetadataTrack({ fragmented: true }).file, 'a.mp4')).rejects.toBeInstanceOf(ImageMetadataError);
    });
    it('sample tables that point outside the file, or claim billions of samples, are refused at once', async () => {
        const t0 = Date.now();
        await expect(strip(mp4WithMetadataTrack({ perChunk: 0xFFFFFFFF, stszCount: 2 }).file, 'a.mp4')).resolves.toBeInstanceOf(Uint8Array); // capped by the count
        await expect(strip(mp4WithMetadataTrack({ stszCount: 0x7FFFFFFF }).file, 'a.mp4')).rejects.toBeInstanceOf(ImageMetadataError);
        expect(Date.now() - t0).toBeLessThan(2000);
    });
    it('a car\'s (ctbx) and a data track (data), the other handlers ExifTool reads, go the same way', async () => {
        for (const handler of ['ctbx', 'data', 'camm']) {
            const { file, video } = mp4WithMetadataTrack({ handler });
            const out = await strip(file, 'drive.mp4');
            expect(contains(out, 'SECRETPOS'), handler).toBe(false);
            expect(contains(out, video), handler).toBe(true);
        }
    });
});

// ---- an allowlist, not a list of the places metadata was known to be (review 2026-11-22)

const isoBox = (type: string, ...body: Array<Uint8Array | number[]>) => { const b = cat(...body); return cat(be32(8 + b.length), enc(type), b); };
const isoFull = (type: string, ...body: Array<Uint8Array | number[]>) => isoBox(type, [0, 0, 0, 0], ...body);
/** One video track whose single chunk of `size` bytes is at `offset`. */
const videoTrak = (offset: number, size: number, extra: Uint8Array[] = [], mdiaExtra: Uint8Array[] = []) => isoBox('trak',
    isoFull('tkhd', new Array(80).fill(0)), ...extra,
    isoBox('mdia', isoFull('mdhd', new Array(20).fill(0)), isoFull('hdlr', be32(0), enc('vide'), new Array(12).fill(0), [0]), ...mdiaExtra,
        isoBox('minf', isoBox('stbl', isoFull('stsd', be32(0)), isoFull('stsz', be32(0), be32(1), be32(size)),
            isoFull('stsc', be32(1), be32(1), be32(1), be32(1)), isoFull('stco', be32(1), be32(offset))))));
/** A Novatek-style GPS block: a `free` box whose body is "GPS " and the fixes. */
const freeGps = (fix: string, size = 256) => {
    const body = new Uint8Array(size - 8);
    body.set(enc('GPS '), 0);
    body.set(enc(fix), 12);
    return cat(be32(size), enc('free'), body);
};
const topTypes = (b: Uint8Array) => isoBoxes(b).map(x => [x.type, x.at, x.size]);
const kidsOf = (b: Uint8Array, type: string) => { const m = isoBoxes(b).find(x => x.type === type)!; return isoBoxes(b, m.at + 8, m.at + m.size).map(x => x.type); };

describe('a dashcam\'s GPS blocks in the media data (Novatek\'s `moov/gps ` index and `freeGPS ` blocks)', () => {
    /** ftyp, mdat (a frame, a block, a frame, a block, a block the index does not list), moov with a `gps ` index of the first two. */
    function dashcam() {
        const ftyp = isoBox('ftyp', enc('avc1'), be32(0), enc('isom'));
        const frames = [enc('VIDEO-FRAME-ONE-KEEP'), enc('VIDEO-FRAME-TWO-KEEP')];
        const blocks = [freeGps('SECRETPOS-A 47.6062N 122.3321W 31km/h'), freeGps('SECRETPOS-B 47.6063N 122.3322W 33km/h'), freeGps('SECRETPOS-C unlisted (INNOVV)')];
        const mdatAt = ftyp.length;
        const parts = [frames[0], blocks[0], frames[1], blocks[1], blocks[2]];
        const at: number[] = [];
        let p = mdatAt + 8;
        for (const x of parts) { at.push(p); p += x.length; }
        const mdat = isoBox('mdat', ...parts);
        const gpsIndex = isoBox('gps ', be32(0x101), be32(2), be32(at[1]), be32(blocks[0].length), be32(at[3]), be32(blocks[1].length));
        const moov = isoBox('moov', isoFull('mvhd', new Array(96).fill(0)), videoTrak(at[0], frames[0].length), gpsIndex);
        return { file: cat(ftyp, mdat, moov), frames, frameAt: [at[0], at[2]], blockAt: [at[1], at[3], at[4]] };
    }
    it('control: ExifTool reads three blocks of fixes from it', () => {
        const { file } = dashcam();
        expect(contains(file, 'SECRETPOS-A') && contains(file, 'SECRETPOS-B') && contains(file, 'SECRETPOS-C')).toBe(true);
        expect(kidsOf(file, 'moov')).toEqual(['mvhd', 'trak', 'gps ']);
    });
    it('every block is zeroed after its box header (listed or not), the index freed, the frames untouched', async () => {
        const { file, frames, frameAt, blockAt } = dashcam();
        const out = await strip(file, 'FILE0001.MP4');
        expect(out.length).toBe(file.length);
        expect(contains(out, 'SECRETPOS')).toBe(false);
        expect(contains(out, 'freeGPS '), 'nothing ExifTool would take for a block').toBe(false);
        expect(kidsOf(out, 'moov')).toEqual(['mvhd', 'trak', 'free']);
        frames.forEach((f, i) => expect(Array.from(out.subarray(frameAt[i], frameAt[i] + f.length)).join(), `frame ${i}`).toBe(Array.from(f).join()));
        for (const b of blockAt) {
            expect(Array.from(out.subarray(b, b + 8)).join(), 'its box header stays').toBe(Array.from(file.subarray(b, b + 8)).join());
            expect(out.subarray(b + 8, b + 256).every(v => v === 0), 'the rest is zeros').toBe(true);
        }
        expect(topTypes(out)).toEqual(topTypes(file));
        expect(Array.from(await strip(out, 'FILE0001.MP4')).join(), 'a second pass changes nothing').toBe(Array.from(out).join());
        const viaFile = await stripFileMetadata(new File([file as BlobPart], 'FILE0001.MP4', { type: 'video/mp4' }));
        expect(Array.from(new Uint8Array(await viaFile.arrayBuffer())).join(), 'the File door does the same').toBe(Array.from(out).join());
    });
    it('a block with no index at all is found as ExifTool finds it, and so is one past the first 20 MB once one was seen', async () => {
        const ftyp = isoBox('ftyp', enc('isom'), be32(0), enc('isom'));
        const frame = enc('VIDEO-FRAME-KEEP');
        const mdatLen = 8 + GPS_SCAN_FIRST + 4096;
        const file = new Uint8Array(ftyp.length + mdatLen);
        file.set(ftyp, 0);
        file.set(be32(mdatLen), ftyp.length); file.set(enc('mdat'), ftyp.length + 4);
        const frameAt = ftyp.length + 8;
        file.set(frame, frameAt);
        const early = frameAt + 1024, late = ftyp.length + 8 + GPS_SCAN_FIRST + 512;
        file.set(freeGps('SECRETPOS-early'), early);
        file.set(freeGps('SECRETPOS-late'), late);
        const moov = isoBox('moov', isoFull('mvhd', new Array(96).fill(0)), videoTrak(frameAt, frame.length));
        const whole = new Uint8Array(file.length + moov.length); whole.set(file); whole.set(moov, file.length);
        const out = await strip(whole, 'dash.mp4');
        expect(contains(out, 'SECRETPOS')).toBe(false);
        expect(Array.from(out.subarray(frameAt, frameAt + frame.length)).join()).toBe(Array.from(frame).join());
        // CONTROL: with no block in the first 20 MB, the search stops there, as ExifTool's does.
        const lateOnly = whole.slice();
        lateOnly.fill(0, early, early + 256);
        expect(contains(await strip(lateOnly, 'dash.mp4'), 'SECRETPOS-late')).toBe(true);
    }, 30_000);
    it('an index that points outside the file is freed like any box this does not keep', async () => {
        const { file } = dashcam();
        const bad = file.slice();
        const moov = isoBoxes(bad).find(x => x.type === 'moov')!;
        const gps = isoBoxes(bad, moov.at + 8, moov.at + moov.size).find(x => x.type === 'gps ')!;
        bad.set(be32(0x7FFFFFF0), gps.at + 16);
        const out = await strip(bad, 'a.mp4');
        expect(contains(out, 'SECRETPOS')).toBe(false);
    });
    it('the 20 MB searched is one budget for the whole file, not one per mdat (a recording in many pieces is not read whole)', async () => {
        const ftyp = isoBox('ftyp', enc('isom'), be32(0), enc('isom'));
        const moov = isoBox('moov', isoFull('mvhd', new Array(96).fill(0)), videoTrak(ftyp.length + 8, 16));
        const piece = 8 * 1024 * 1024, pieces = 5;
        const file = new Uint8Array(ftyp.length + moov.length + pieces * (8 + piece));
        file.set(ftyp, 0); file.set(moov, ftyp.length);
        for (let k = 0, at = ftyp.length + moov.length; k < pieces; k++, at += 8 + piece) { file.set(be32(8 + piece), at); file.set(enc('mdat'), at + 4); }
        let read = 0;
        const src: Source = { size: file.length, read: async (at, len) => { const r = file.subarray(at, Math.min(file.length, at + len)); read += r.length; return r; } };
        const plan = await planIsoBmff(src, 'MP4');
        expect(plan!.every(p => p.at < ftyp.length + moov.length), 'nothing to change in the media data').toBe(true);
        expect(read, `bytes read of ${pieces * piece} of media data`).toBeLessThan(GPS_SCAN_FIRST + 2 * 1024 * 1024);
        expect(read, 'control: the search did read media data').toBeGreaterThan(GPS_SCAN_FIRST - 1024 * 1024);
    });
});

describe('boxes this does not keep, wherever they are, whatever they are called', () => {
    it('a Samsung HEIC: its sefd trailer and Motion Photo video (mpvd) are freed; the picture is the HEIC path\'s', async () => {
        const heic = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'heic', 'rotated-gps.heic')));
        const sefd = isoBox('sefd', enc('\0\0Image_UTC_Data1761228309000 MCC_Data310 SECRETCAM-Corp Camera_Capture_Mode_Info SEFH SEFT'));
        const mpvd = isoBox('mpvd', isoBox('ftyp', enc('mp42'), be32(0), enc('isom')), isoBox('moov', isoBox('udta', isoBox('loci', enc('+47.6062-122.3321')))));
        const file = cat(heic, mpvd, sefd);
        expect(marks(file), 'control').toEqual(expect.arrayContaining(['SECRETCAM-Corp', '+47.6062-122.3321']));
        const out = await strip(file, '20261023_140509.heic');
        expect(out.length).toBe(file.length);
        expect(marks(out)).toEqual([]);
        expect(contains(out, 'Image_UTC_Data')).toBe(false);
        const { stripHeifMetadata } = await import('../api/heifMetadata');
        expect(Array.from(out.subarray(0, heic.length)).join(), 'the picture as the HEIC path makes it').toBe(Array.from(stripHeifMetadata(heic)!).join());
        expect(isoBoxes(out).map(x => x.type)).toEqual([...isoBoxes(heic).map(x => x.type), 'free', 'free']);
    });
    it('free space a camera wrote into is zeroed (Kodak\'s serial, a Pittasoft dashcam\'s GPS log, Canon\'s thumbnail); a vendor\'s own top-level box is freed', async () => {
        const v = fixture('video.mp4');
        const extra = [
            isoBox('free', enc('\0\0\0\x14SeriSECRETCAM-Serial-0042')),
            isoBox('free', be32(40), enc('gps $GPRMC,140509,A,4736.37,N,12219.93,W,SECRETPOS')),
            isoBox('skip', be32(24), enc('CNTHSECRETCAM-thumbnail')),
            isoBox('udat', enc('$GPRMC,140509,A,4736.37,N SECRETPOS-udat')),
            isoBox('gdat', enc(btoa('{"lat":47.6062,"SECRETPOS":"gdat"}'))),
            isoBox('prft', be32(0), be32(0), enc('SECRETPOS-wallclock')),
            isoBox('uuid', enc('BE7ACFCB97A942E89C71999491E3AFAC'), enc('SECRETXMP-creator-jane')),
        ];
        const file = cat(v, ...extra);
        const out = await strip(file, 'clip.mp4');
        expect(out.length).toBe(file.length);
        expect(contains(out, 'SECRETCAM')).toBe(false);
        expect(contains(out, 'SECRETPOS')).toBe(false);
        expect(contains(out, 'SECRETXMP')).toBe(false);
        const tail = isoBoxes(out).slice(-extra.length);
        expect(tail.map(x => x.type), 'free space stays free space; the rest is free').toEqual(['free', 'free', 'skip', 'free', 'free', 'free', 'free']);
        for (const x of tail) expect(out.subarray(x.at + 8, x.at + x.size).every(b => b === 0), x.type).toBe(true);
    });
    it('in moov, a trak and its mdia: whatever a player does not need is freed (an HTC track, ISO\'s meco, a vendor\'s box)', async () => {
        const ftyp = isoBox('ftyp', enc('isom'), be32(0), enc('isom'));
        const frame = enc('VIDEO-FRAME-KEEP');
        const mdat = isoBox('mdat', frame);
        const frameAt = ftyp.length + 8;
        const moov = isoBox('moov', isoFull('mvhd', new Array(96).fill(0)),
            videoTrak(frameAt, frame.length, [isoBox('edts', isoFull('elst', be32(0))), isoBox('meco', enc('SECRETCAM-meco')), isoBox('VEND', enc('SECRETCAM-trak'))], [isoBox('SAMS', enc('SECRETCAM-mdia'))]),
            isoBox('htka', enc('SECRETCAM-htc')), isoBox('ainf', enc('SECRETCAM-asset')), isoBox('SNUM', enc('SECRETCAM-serial')), isoBox('iods', be32(0), [0x10, 7]));
        const file = cat(ftyp, mdat, moov);
        const out = await strip(file, 'a.mp4');
        expect(contains(out, 'SECRETCAM')).toBe(false);
        expect(kidsOf(out, 'moov'), 'iods is kept').toEqual(['mvhd', 'trak', 'free', 'free', 'free', 'iods']);
        const m = isoBoxes(out).find(x => x.type === 'moov')!;
        const trak = isoBoxes(out, m.at + 8, m.at + m.size).find(x => x.type === 'trak')!;
        expect(isoBoxes(out, trak.at + 8, trak.at + trak.size).map(x => x.type), 'the edit list is kept').toEqual(['tkhd', 'edts', 'free', 'free', 'mdia']);
        expect(contains(out, frame)).toBe(true);
    });
    it('a fragment\'s own metadata goes; its header and track fragments stay', async () => {
        const ftyp = isoBox('ftyp', enc('iso6'), be32(0), enc('iso6'));
        const moov = isoBox('moov', isoFull('mvhd', new Array(96).fill(0)), isoBox('mvex', isoFull('trex', new Array(20).fill(0))), videoTrak(0, 0));
        const moof = isoBox('moof', isoFull('mfhd', be32(1)), isoFull('meta', isoFull('hdlr', be32(0), enc('mdta'), new Array(12).fill(0), [0]), isoBox('keys', enc('SECRETCAM-fragment'))),
            isoBox('traf', isoFull('tfhd', be32(1)), isoFull('trun', be32(0))));
        const file = cat(ftyp, moov, moof, isoBox('mdat', enc('FRAGMENT-FRAME')));
        const out = await strip(file, 'rec.mp4');
        expect(contains(out, 'SECRETCAM')).toBe(false);
        expect(kidsOf(out, 'moof')).toEqual(['mfhd', 'free', 'traf']);
        expect(contains(out, 'FRAGMENT-FRAME')).toBe(true);
    });
    it('a compressed movie header (cmov) is refused: what is in it cannot be read here', async () => {
        const file = cat(isoBox('ftyp', enc('qt  '), be32(0), enc('qt  ')), isoBox('moov', isoBox('cmov', isoBox('dcom', enc('zlib')), isoBox('cmvd', be32(100), enc('x\x9c')))));
        await expect(strip(file, 'old.mov')).rejects.toBeInstanceOf(ImageMetadataError);
    });
});

describe('a WebM or MKV video', () => {
    for (const name of ['video.webm', 'video.mkv']) {
        const v = fixture(name);
        it(`${name}: control: it carries the title, the camera, the place, the software${name.endsWith('mkv') ? ' and an attached file' : ''}`, () => {
            expect(marks(v)).toEqual(expect.arrayContaining(['SECRETCOMMENT-hello', 'SECRETCAM-Corp', 'PhoneModelX-9000', '+47.6062-122.3321', 'Lavf', 'Lavc',
                ...(name.endsWith('mkv') ? ['note.txt', 'SECRETXMP-creator-jane'] : [])]));
        });
        it(`${name}: loses all of it in place; every cluster is the same bytes; a second pass changes nothing`, async () => {
            const out = await strip(v, name);
            expect(out.length).toBe(v.length);
            expect(marks(out)).toEqual([]);
            const before = ebmlTop(v), after = ebmlTop(out);
            expect(after.map(e => [e.at, e.end]), 'every element where it was').toEqual(before.map(e => [e.at, e.end]));
            const clusters = before.filter(e => e.id === 0x1F43B675);
            expect(clusters.length, 'control: clusters').toBeGreaterThan(0);
            for (const c of clusters) expect(Array.from(out.subarray(c.at, c.end)).join()).toBe(Array.from(v.subarray(c.at, c.end)).join());
            const ids = after.map(e => e.id);
            expect(ids).not.toContain(0x1254C367); // Tags
            expect(ids).not.toContain(0x1941A469); // Attachments
            expect(Array.from(await strip(out, name)).join()).toBe(Array.from(out).join());
        });
    }
    it('a live recording (segment and clusters of unknown size, as MediaRecorder writes) is walked to its end', async () => {
        const vint8 = (n: number) => [0x01, 0, 0, 0, (n / 2 ** 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
        const known = (id: number[], body: Uint8Array) => cat(id, vint8(body.length), body);
        const UNKNOWN = [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
        const header = known([0x1A, 0x45, 0xDF, 0xA3], known([0x42, 0x82], enc('webm')));
        const info = known([0x15, 0x49, 0xA9, 0x66], cat(known([0x4D, 0x80], enc('SECRETCAM-Corp')), known([0x57, 0x41], enc('SECRETCAM-Corp'))));
        const block = known([0xA3], enc('FRAME-KEEP'));
        const cluster = (n: number) => cat([0x1F, 0x43, 0xB6, 0x75], UNKNOWN, known([0xE7], Uint8Array.from([n])), block, block);
        const tags = known([0x12, 0x54, 0xC3, 0x67], enc('PhoneModelX-9000 in a tag'));
        const file = cat(header, [0x18, 0x53, 0x80, 0x67], UNKNOWN, info, cluster(0), cluster(1), tags);
        expect(marks(file)).toEqual(['SECRETCAM-Corp', 'PhoneModelX-9000']);
        const out = await strip(file, 'voice.webm');
        expect(marks(out)).toEqual([]);
        expect(out.length).toBe(file.length);
        expect(contains(out, 'FRAME-KEEP')).toBe(true);
    });
    it('an EBML file of another DocType goes as it is', async () => {
        const vint = (n: number) => [0x80 | n];
        const other = cat([0x1A, 0x45, 0xDF, 0xA3], vint(7), [0x42, 0x82], vint(4), enc('mka?'), enc('SECRETCAM-Corp'));
        expect(Array.from(await strip(other, 'x.bin')).join()).toBe(Array.from(other).join());
    });
});

// ---- the File door: a large video is never read whole

describe('stripFileMetadata on a video (an upload or a peer-to-peer send)', () => {
    it('reads only its header boxes and the first 20 MB of its media data, a window at a time, and makes the file from the original\'s slices', async () => {
        const v = fixture('video.mp4');
        // The same video with 48 MB of media data in front of its moov.
        const top = isoBoxes(v);
        const ftyp = top.find(x => x.type === 'ftyp')!, moov = top.find(x => x.type === 'moov')!;
        const media = new Uint8Array(48 * 1024 * 1024);
        const mdat = cat(be32(8 + media.length), enc('mdat'));
        const parts = [region(v, ftyp), mdat, media, region(v, moov)];
        const { file, seen } = watchedFile(parts as BlobPart[], 'VID_20261023.mp4', 'video/mp4');
        const out = await stripFileMetadata(file);
        expect(out).not.toBe(file);
        expect(out.name).toBe('VID_20261023.mp4');
        expect(out.type).toBe('video/mp4');
        expect(out.size).toBe(file.size);
        // A dashcam's GPS blocks are searched for where ExifTool searches (GPS_SCAN_FIRST); nothing else of the media data is read.
        expect(seen.read, 'bytes read to find and fix the metadata').toBeLessThan(GPS_SCAN_FIRST + 4 * 1024 * 1024);
        expect(seen.largest, 'never more than a window at a time').toBeLessThanOrEqual(1024 * 1024 + 16);
        const bytes = new Uint8Array(await out.arrayBuffer());
        expect(marks(bytes)).toEqual([]);
        expect(contains(bytes.subarray(0, 64), 'mdat')).toBe(true);
    });
    it('a video with nothing to remove is the same File', async () => {
        const clean = await strip(fixture('video.webm'), 'v.webm');
        const f = new File([clean as BlobPart], 'v.webm', { type: 'video/webm' });
        expect(await stripFileMetadata(f)).toBe(f);
    });
});

/**
 * A File whose own arrayBuffer() throws (read whole, it fails the test), counting the bytes read
 * through its slices and the largest single read.
 */
function watchedFile(parts: BlobPart[], name: string, type: string) {
    const file = new File(parts, name, { type });
    const seen = { read: 0, largest: 0 };
    const realSlice = file.slice.bind(file);
    Object.defineProperty(file, 'arrayBuffer', { value: () => { throw new Error('the whole file was read'); } });
    Object.defineProperty(file, 'slice', {
        value: (s?: number, e?: number, t?: string) => {
            const b = realSlice(s, e, t);
            const real = b.arrayBuffer.bind(b);
            Object.defineProperty(b, 'arrayBuffer', { value: async () => { const x = await real(); seen.read += x.byteLength; seen.largest = Math.max(seen.largest, x.byteLength); return x; } });
            return b;
        },
    });
    return { file, seen };
}

describe('stripFileMetadata on a large TIFF or GIF (a peer-to-peer send): never read whole', () => {
    it('a TIFF: only its directories and what is overwritten are read, and the file is made of the original\'s slices', async () => {
        const tif = fixture('photo.tif');
        // A 48 MB scan: the same directories, with 48 MB more of picture after them.
        const { file, seen } = watchedFile([tif as BlobPart, new Uint8Array(48 * 1024 * 1024)], 'scan.tif', 'image/tiff');
        const out = await stripFileMetadata(file);
        expect(out).not.toBe(file);
        expect(out.name).toBe('scan.tif');
        expect(out.type).toBe('image/tiff');
        expect(out.size).toBe(file.size);
        expect(seen.read, 'bytes read to find and fix the metadata').toBeLessThan(4 * 1024 * 1024);
        const bytes = new Uint8Array(await out.arrayBuffer());
        expect(marks(bytes)).toEqual([]);
        expect(Array.from(bytes.subarray(0, tif.length)).join(), 'the same as the seal makes of it').toBe(Array.from(await strip(tif, 'scan.tif')).join());
        const again = new File([bytes as BlobPart], 'scan.tif', { type: 'image/tiff' });
        expect(await stripFileMetadata(again), 'a second pass changes nothing: the same File').toBe(again);
    });
    it('a GIF: walked in slices, never more than a window at a time, and the file is the blocks it keeps', async () => {
        const gif = fixture('animated.gif');
        // 8 MB of an editor's comment in front of the trailer: walked over sub-block by sub-block.
        const sub = cat([255], new Uint8Array(255).fill(0x41));
        const big = new Uint8Array(sub.length * 32 * 1024);
        for (let i = 0; i < 32 * 1024; i++) big.set(sub, i * sub.length);
        const comment = cat([0x21, 0xFE], big, [18], enc('SECRETCOMMENT-tail'), [0]);
        const { file, seen } = watchedFile([gif.subarray(0, gif.length - 1) as BlobPart, comment as BlobPart, Uint8Array.of(0x3B)], 'party.gif', 'image/gif');
        const out = await stripFileMetadata(file);
        expect(out).not.toBe(file);
        expect(out.type).toBe('image/gif');
        expect(seen.largest, 'never more than a window read at once').toBeLessThanOrEqual(1024 * 1024);
        const bytes = new Uint8Array(await out.arrayBuffer());
        expect(contains(bytes, 'SECRETCOMMENT-tail')).toBe(false);
        expect(marks(bytes)).toEqual([]);
        expect(Array.from(bytes).join(), 'the same as the seal makes of the GIF').toBe(Array.from(await strip(gif, 'party.gif')).join());
        const again = new File([bytes as BlobPart], 'party.gif', { type: 'image/gif' });
        expect(await stripFileMetadata(again), 'a second pass changes nothing: the same File').toBe(again);
    });
});

// ---- malformed input: an error the UI can say, or a clean result; never a hang

describe('malformed input never crashes the send', () => {
    const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
    const samples: Array<[string, Uint8Array]> = [
        ['animated.gif', fixture('animated.gif')], ['photo.tif', fixture('photo.tif')], ['photo.avif', fixture('photo.avif')],
        ['video.mp4', fixture('video.mp4')], ['video.mov', fixture('video.mov')], ['video.webm', fixture('video.webm')], ['video.mkv', fixture('video.mkv')],
    ];
    const settle = async (b: Uint8Array, name: string): Promise<Uint8Array | null> => {
        try {
            const out = await stripAttachmentMetadata(b, { name });
            expect(out).toBeInstanceOf(Uint8Array);
            return out;
        } catch (e) {
            if (!(e instanceof ImageMetadataError)) throw new Error(`${name}: ${String(e)}`);
            return null;
        }
    };

    it('every truncation point: the known error, or a result with none of the planted metadata', async () => {
        for (const [name, input] of samples) {
            let results = 0;
            for (let n = 0; n <= input.length; n++) {
                const out = await settle(input.slice(0, n), name);
                if (out) { results++; expect(marks(out).filter(m => m !== 'Lavc' || !name.endsWith('.avif')), `${name} cut at ${n}`).toEqual([]); }
            }
            expect(results, `${name}: some cut points are accepted`).toBeGreaterThan(0);
        }
    }, 120_000);

    it('thousands of random corruptions: only the known error, the same length for a container, stable on a second pass', async () => {
        const next = rng(0xC0FFEE);
        for (const [name, input] of samples) {
            for (let k = 0; k < 600; k++) {
                const b = input.slice();
                const flips = 1 + Math.floor(next() * 4);
                for (let f = 0; f < flips; f++) {
                    const at = Math.floor(next() * b.length);
                    const v = next();
                    b[at] = v < 0.3 ? 0xFF : v < 0.5 ? 0 : Math.floor(next() * 256);
                }
                const out = await settle(b, name);
                if (!out) continue;
                if (!name.endsWith('.gif')) expect(out.length, name).toBe(b.length);
                const again = await settle(out.slice(), name);
                expect(again, `${name} second pass`).not.toBeNull();
                expect(Array.from(again!).join(), `${name} second pass is stable`).toBe(Array.from(out).join());
            }
        }
    }, 120_000);

    it('absurd lengths are refused at once, never read for or allocated', async () => {
        const t0 = Date.now();
        const v = fixture('video.mp4');
        const moovAt = isoBoxes(v).find(x => x.type === 'moov')!.at;
        const huge = v.slice(); huge.set(be32(0xFFFFFFF0), moovAt);
        await expect(strip(huge, 'a.mp4')).rejects.toBeInstanceOf(ImageMetadataError);
        const large = v.slice(); large.set(be32(1), moovAt); // a 64-bit size follows, read from the next bytes: nonsense
        await expect(strip(large, 'a.mp4')).rejects.toBeInstanceOf(ImageMetadataError);
        const w = fixture('video.webm');
        const tagsAt = ebmlTop(w).find(e => e.id === 0x1254C367)!.at;
        const unknownTags = w.slice(); unknownTags.set([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], tagsAt + 4);
        await expect(strip(unknownTags, 'a.webm')).rejects.toBeInstanceOf(ImageMetadataError);
        const t = fixture('photo.tif');
        const loop = t.slice(); const ifd = new DataView(loop.buffer).getUint32(4, true);
        const count = loop[ifd] | (loop[ifd + 1] << 8);
        new DataView(loop.buffer).setUint32(ifd + 2 + count * 12, ifd, true); // the next directory is itself
        await expect(strip(loop, 'a.tif')).rejects.toBeInstanceOf(ImageMetadataError);
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(MAX_PATCH_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
    });

    it('random bytes behind each magic number: the known error or a result, no hang', async () => {
        const next = rng(7);
        const magics: Array<[string, Uint8Array]> = [
            ['a.gif', enc('GIF89a')], ['a.tif', Uint8Array.from([0x49, 0x49, 0x2A, 0])], ['a.tif', Uint8Array.from([0x4D, 0x4D, 0, 0x2A])],
            ['a.mp4', cat(be32(24), enc('ftypisom'))], ['a.mov', cat(be32(16), enc('moov'))], ['a.webm', Uint8Array.from([0x1A, 0x45, 0xDF, 0xA3])],
        ];
        for (const [name, magic] of magics) {
            for (let k = 0; k < 600; k++) {
                const junk = Uint8Array.from({ length: Math.floor(next() * 160) }, () => Math.floor(next() * 256));
                await settle(cat(magic, junk), name);
            }
        }
    });
});
