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
import { MAX_PATCH_BYTES } from '../api/metadataPatches';
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
function mp4WithMetadataTrack(o: { fragmented?: boolean; stszCount?: number; perChunk?: number } = {}) {
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
        trak('meta', sampleAt, samples.map(s => s.length)),
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
    it('reads only its header boxes, and makes the file from the original\'s slices', async () => {
        const v = fixture('video.mp4');
        // The same video with 48 MB of media data in front of its moov.
        const top = isoBoxes(v);
        const ftyp = top.find(x => x.type === 'ftyp')!, moov = top.find(x => x.type === 'moov')!;
        const media = new Uint8Array(48 * 1024 * 1024);
        const mdat = cat(be32(8 + media.length), enc('mdat'));
        const parts = [region(v, ftyp), mdat, media, region(v, moov)];
        const file = new File(parts as BlobPart[], 'VID_20261023.mp4', { type: 'video/mp4' });
        let read = 0;
        const realSlice = file.slice.bind(file);
        Object.defineProperty(file, 'arrayBuffer', { value: () => { throw new Error('the whole video was read'); } });
        Object.defineProperty(file, 'slice', {
            value: (s?: number, e?: number, t?: string) => {
                const b = realSlice(s, e, t);
                const real = b.arrayBuffer.bind(b);
                Object.defineProperty(b, 'arrayBuffer', { value: async () => { const x = await real(); read += x.byteLength; return x; } });
                return b;
            },
        });
        const out = await stripFileMetadata(file);
        expect(out).not.toBe(file);
        expect(out.name).toBe('VID_20261023.mp4');
        expect(out.type).toBe('video/mp4');
        expect(out.size).toBe(file.size);
        expect(read, 'bytes read to find and fix the metadata').toBeLessThan(4 * 1024 * 1024);
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
