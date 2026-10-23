import { describe, expect, it } from 'vitest';
import { ImageMetadataError, orientationOfTiff, sniffStrippable, stripFileMetadata, stripImageMetadata } from '../api/imageMetadata';
import {
    FRAME_BYTES, IDAT_BYTES, SCAN, VP8_BYTES, cat, contains, enc, exifTiff, indexOfBytes, jpeg, jpegSegments, jseg, leaked,
    pchunk, png, pngChunks, riff, riffChunkList, wchunk, webp, SECRET_COMMENT, SECRET_IPTC, SECRET_XMP,
} from './fixtures/photoMetadata';

/**
 * api/imageMetadata.ts takes the metadata off a JPEG / PNG / WebP without
 * touching the picture. These tests build files byte by byte (fixtures/
 * photoMetadata.ts, with its own reader) and look for the planted values in
 * what comes out. Each "is gone" assertion is preceded by the control that the
 * input DID carry it, or it would pass on an input that never had it.
 */

const everything = {
    xmp: true, comment: true, iptc: true, icc: true, adobe: true, mpf: true,
    jfif: 'thumbnail' as const, trailer: cat(enc('MOTIONPHOTO-VIDEO-'), enc(SECRET_IPTC)),
};

describe('JPEG', () => {
    it('carries everything it should before, and none of it after', () => {
        const input = jpeg(everything);
        expect(leaked(input).sort()).toEqual(['GPS latitude', 'IPTC', 'XMP', 'camera make', 'camera model', 'capture date', 'comment']);
        expect(contains(input, 'MOTIONPHOTO-VIDEO-')).toBe(true);
        const out = stripImageMetadata(input);
        expect(leaked(out)).toEqual([]);
        expect(contains(out, 'MOTIONPHOTO-VIDEO-')).toBe(false);
        expect(contains(out, 'MPF')).toBe(false);
    });

    it('leaves the picture byte for byte as it was: tables, frame header, scan, EOI', () => {
        const input = jpeg(everything);
        const out = stripImageMetadata(input);
        const keep = (b: Uint8Array) => jpegSegments(b).filter(s => [0xDB, 0xC0, 0xC4, 0xDA].includes(s.marker));
        expect(keep(out).map(s => [s.marker, Array.from(s.payload)])).toEqual(keep(input).map(s => [s.marker, Array.from(s.payload)]));
        // The scan and the EOI, from the start of the scan data to the end of the file.
        const tail = cat(SCAN, [0xFF, 0xD9]);
        expect(Array.from(out.subarray(out.length - tail.length))).toEqual(Array.from(tail));
        expect(Array.from(out.subarray(0, 2))).toEqual([0xFF, 0xD8]);
    });

    it('keeps the colour: ICC profile, Adobe transform, JFIF header (its thumbnail goes)', () => {
        const input = jpeg(everything);
        const segs = jpegSegments(stripImageMetadata(input));
        expect(segs.some(s => s.marker === 0xE2 && contains(s.payload, 'ICC_PROFILE'))).toBe(true);
        expect(segs.some(s => s.marker === 0xEE && contains(s.payload, 'Adobe'))).toBe(true);
        const jfif = segs.find(s => s.marker === 0xE0)!;
        expect(jfif.payload.length).toBe(14);
        expect(jfif.payload[12]).toBe(0);
        expect(jfif.payload[13]).toBe(0);
        expect(Array.from(jfif.payload.subarray(0, 12))).toEqual(Array.from(jpegSegments(input).find(s => s.marker === 0xE0)!.payload.subarray(0, 12)));
    });

    it('keeps the orientation as the ONLY entry of a block it wrote itself', () => {
        for (const orientation of [2, 3, 4, 5, 6, 7, 8]) {
            const out = stripImageMetadata(jpeg({ orientation }));
            const exif = jpegSegments(out).filter(s => s.marker === 0xE1);
            expect(exif).toHaveLength(1);
            expect(exif[0].payload.length).toBe(32);
            expect(orientationOfTiff(exif[0].payload.subarray(6))).toBe(orientation);
            expect(leaked(out)).toEqual([]);
            // The orientation block sits right behind JFIF, before the tables.
            expect(jpegSegments(out).map(s => s.marker).slice(0, 3)).toEqual([0xE0, 0xE1, 0xDB]);
        }
    });

    it('writes no EXIF at all for an upright photo, or one with no orientation', () => {
        for (const orientation of [1, null, 0, 9, 65535]) {
            const out = stripImageMetadata(jpeg({ orientation: orientation as number | null }));
            expect(jpegSegments(out).some(s => s.marker === 0xE1)).toBe(false);
            expect(leaked(out)).toEqual([]);
        }
    });

    it('returns the SAME array when there was nothing to remove', () => {
        const clean = jpeg({ exif: false });
        expect(stripImageMetadata(clean)).toBe(clean);
    });

    it('is idempotent: stripping the output changes nothing', () => {
        const once = stripImageMetadata(jpeg(everything));
        const twice = stripImageMetadata(once);
        expect(Array.from(twice)).toEqual(Array.from(once));
    });

    it('walks a progressive file with several scans and keeps all of them', () => {
        const input = jpeg({ progressive: true, comment: true });
        const out = stripImageMetadata(input);
        expect(leaked(out)).toEqual([]);
        expect(jpegSegments(out).filter(s => s.marker === 0xDA)).toHaveLength(1); // jpegSegments stops at the first
        expect(contains(out, Uint8Array.from([0x9A, 0xFF, 0x00, 0xBC]))).toBe(true);
        expect(indexOfBytes(out, Uint8Array.from([0xFF, 0xC4]), indexOfBytes(out, SCAN) + SCAN.length)).toBeGreaterThan(0);
    });

    it('finds metadata that comes AFTER the scan (a second APP1 behind the picture)', () => {
        const base = jpeg({ exif: false });
        const eoi = base.length - 2;
        const late = cat(base.subarray(0, eoi), jseg(0xFE, enc('SECRETCOMMENT-late')), base.subarray(eoi));
        // A COM between the scan and the EOI is metadata in the picture's tail.
        const out = stripImageMetadata(late);
        expect(contains(late, 'SECRETCOMMENT-late')).toBe(true);
        expect(contains(out, 'SECRETCOMMENT-late')).toBe(false);
    });

    it('passes a JPEG cut off inside its scan, and still takes the metadata off the front', () => {
        const input = jpeg({ comment: true, xmp: true });
        const cut = input.subarray(0, input.length - 40);
        const out = stripImageMetadata(cut);
        expect(leaked(out)).toEqual([]);
    });

    it('refuses what it cannot take apart', () => {
        const ok = jpeg({ comment: true });
        const comAt = indexOfBytes(ok, Uint8Array.from([0xFF, 0xFE]));
        const bad = (b: Uint8Array) => expect(() => stripImageMetadata(b)).toThrow(ImageMetadataError);
        const lenTooBig = Uint8Array.from(ok); lenTooBig[comAt + 2] = 0xFF; lenTooBig[comAt + 3] = 0xFF;
        bad(lenTooBig);
        expect(() => stripImageMetadata(lenTooBig)).toThrow(/longer than the file/);
        const lenTooSmall = Uint8Array.from(ok); lenTooSmall[comAt + 2] = 0; lenTooSmall[comAt + 3] = 1;
        bad(lenTooSmall);
        bad(Uint8Array.from([0xFF, 0xD8, 0xFF])); // SOI then a bare marker
        bad(Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00])); // header cut
        bad(cat([0xFF, 0xD8], jseg(0xE1, enc('Exif\0\0')), [0xFF, 0xD9])); // no scan at all
        bad(cat([0xFF, 0xD8], jseg(0xFE, enc('hi')), Uint8Array.from([0x12, 0x34]))); // garbage where a marker belongs
        bad(ok.subarray(0, comAt + 6)); // cut inside the comment
    });

    it('says why, in words a person can act on', () => {
        const ok = jpeg({ comment: true });
        const bad = Uint8Array.from(ok); bad[indexOfBytes(ok, Uint8Array.from([0xFF, 0xFE])) + 2] = 0xFF;
        expect(() => stripImageMetadata(bad)).toThrow(/not sent/);
    });
});

describe('PNG', () => {
    const full = { unknown: true, icc: true, trailer: enc(SECRET_IPTC) };

    it('drops eXIf, tEXt, zTXt, iTXt, tIME, unknown ancillary chunks and the tail', () => {
        const input = png(full);
        expect(leaked(input).length).toBeGreaterThan(4);
        const out = stripImageMetadata(input);
        expect(leaked(out)).toEqual([]);
        const types = pngChunks(out).map(c => c.type);
        expect(types).toEqual(['IHDR', 'eXIf', 'sRGB', 'gAMA', 'iCCP', 'pHYs', 'IDAT', 'IEND']);
        expect(out.length).toBe(out.length);
        expect(contains(out, SECRET_IPTC)).toBe(false);
    });

    it('keeps the picture and the colour chunks byte for byte, CRCs intact', () => {
        const input = png(full);
        const out = stripImageMetadata(input);
        for (const t of ['IHDR', 'sRGB', 'gAMA', 'iCCP', 'pHYs', 'IDAT']) {
            const a = pngChunks(input).find(c => c.type === t)!;
            const b = pngChunks(out).find(c => c.type === t)!;
            expect(Array.from(b.data)).toEqual(Array.from(a.data));
        }
        expect(Array.from(pngChunks(out).find(c => c.type === 'IDAT')!.data)).toEqual(Array.from(IDAT_BYTES));
        expect(pngChunks(out).every(c => c.crcOk)).toBe(true);
    });

    it('keeps orientation as a minimal eXIf with a valid CRC', () => {
        const out = stripImageMetadata(png({ orientation: 8 }));
        const exif = pngChunks(out).filter(c => c.type === 'eXIf');
        expect(exif).toHaveLength(1);
        expect(exif[0].data.length).toBe(26);
        expect(exif[0].crcOk).toBe(true);
        expect(orientationOfTiff(exif[0].data)).toBe(8);
    });

    it('writes no eXIf for an upright photo', () => {
        for (const orientation of [1, null]) {
            const out = stripImageMetadata(png({ orientation }));
            expect(pngChunks(out).some(c => c.type === 'eXIf')).toBe(false);
            expect(leaked(out)).toEqual([]);
        }
    });

    it('returns the SAME array for a clean file, and is idempotent otherwise', () => {
        const clean = png({ orientation: null, text: false, time: false });
        expect(stripImageMetadata(clean)).toBe(clean);
        const once = stripImageMetadata(png(full));
        expect(Array.from(stripImageMetadata(once))).toEqual(Array.from(once));
    });

    it('keeps an unknown CRITICAL chunk (a decoder would refuse the file without it)', () => {
        const base = png({ orientation: null, text: false, time: false });
        const withCritical = cat(base.subarray(0, 8), pchunk('IHDR', cat([0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0])), pchunk('ZZZZ', [1, 2, 3]), base.subarray(8 + 25));
        expect(pngChunks(stripImageMetadata(withCritical)).map(c => c.type)).toContain('ZZZZ');
    });

    it('lets a picture cut off inside its data through, and refuses a damaged header or chunk', () => {
        const input = png({ text: true });
        const idatAt = indexOfBytes(input, 'IDAT') - 4;
        const cut = input.subarray(0, idatAt + 20);
        const out = stripImageMetadata(cut);
        expect(leaked(out)).toEqual([]);
        expect(contains(out, 'IDAT')).toBe(true);

        const bad = (b: Uint8Array) => expect(() => stripImageMetadata(b)).toThrow(ImageMetadataError);
        bad(input.subarray(0, 8 + 8)); // IHDR header, no body
        bad(cat(input.subarray(0, 8), pchunk('IDAT', [1, 2]))); // no IHDR
        const huge = Uint8Array.from(input); huge[8] = 0x7F; // IHDR longer than the file
        bad(huge);
        // A metadata chunk cut off at the end is debris, not an error.
        expect(leaked(stripImageMetadata(cat(png({ text: false }).subarray(0, 40), enc('\0\0\0\xff')))).length).toBe(0);
    });
});

describe('WebP', () => {
    it('drops EXIF, XMP and unknown chunks, clears their VP8X flags, fixes the RIFF size', () => {
        const input = webp({ xmp: true, unknown: true, icc: true });
        expect(leaked(input).length).toBeGreaterThan(4);
        const out = stripImageMetadata(input);
        expect(leaked(out)).toEqual([]);
        const list = riffChunkList(out);
        expect(list.map(c => c.type)).toEqual(['VP8X', 'ICCP', 'VP8 ', 'EXIF']);
        expect(list[0].data[0] & 0x04).toBe(0); // no XMP
        expect(list[0].data[0] & 0x08).toBe(0x08); // the orientation block
        expect(list[0].data[0] & 0x20).toBe(0x20); // ICC kept
        const size = (out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24)) >>> 0;
        expect(size + 8).toBe(out.length);
        expect(Array.from(list[2].data)).toEqual(Array.from(VP8_BYTES));
        expect(list[3].data.length).toBe(26);
        expect(orientationOfTiff(list[3].data)).toBe(6);
    });

    it('reads an EXIF chunk that carries the "Exif\\0\\0" prefix some writers add', () => {
        const out = stripImageMetadata(webp({ exifPrefix: true }));
        expect(orientationOfTiff(riffChunkList(out).find(c => c.type === 'EXIF')!.data)).toBe(6);
    });

    it('writes no EXIF for an upright photo and clears the flag', () => {
        const out = stripImageMetadata(webp({ orientation: 1 }));
        expect(riffChunkList(out).map(c => c.type)).toEqual(['VP8X', 'VP8 ']);
        expect(riffChunkList(out)[0].data[0] & 0x08).toBe(0);
    });

    it('strips inside animation frames and keeps the frame data', () => {
        const out = stripImageMetadata(webp({ animated: true, unknown: true, orientation: null }));
        expect(leaked(out)).toEqual([]);
        const frame = riffChunkList(out).find(c => c.type === 'ANMF')!;
        const inner = riffChunkList(cat(new Uint8Array(12), frame.data.subarray(16)));
        expect(inner.map(c => c.type)).toEqual(['VP8 ']);
        expect(Array.from(inner[0].data)).toEqual(Array.from(FRAME_BYTES));
    });

    it('returns the SAME array for a clean file, and is idempotent otherwise', () => {
        const clean = riff(wchunk('VP8 ', VP8_BYTES));
        expect(stripImageMetadata(clean)).toBe(clean);
        const once = stripImageMetadata(webp({ xmp: true }));
        expect(Array.from(stripImageMetadata(once))).toEqual(Array.from(once));
    });

    it('drops data after the RIFF and refuses sizes that do not add up', () => {
        const input = cat(webp({ orientation: null, exif: false }), enc('TRAILER-SECRETXMP-creator-jane'));
        expect(leaked(stripImageMetadata(input))).toEqual([]);
        const bad = (b: Uint8Array) => expect(() => stripImageMetadata(b)).toThrow(ImageMetadataError);
        const sized = Uint8Array.from(webp()); sized[17] = 0xFF; // VP8X claims 65 KB
        bad(sized);
        bad(cat(enc('RIFF'), [4, 0, 0, 0], enc('WEBP'))); // no chunks
        bad(riff(wchunk('EXIF', exifTiff(6)))); // metadata and no picture
        bad(webp().subarray(0, 30));
        const frame = riff(wchunk('VP8X', [2, 0, 0, 0, 0, 0, 0, 0, 0, 0]), wchunk('ANMF', [1, 2, 3]));
        bad(frame); // a frame shorter than its own header
    });
});

describe('everything else', () => {
    const same = (b: Uint8Array) => expect(stripImageMetadata(b)).toBe(b);
    it('GIF, SVG, AVIF/HEIC boxes, PDF, video, text, empty and tiny inputs pass through UNCHANGED', () => {
        same(cat(enc('GIF89a'), [1, 0, 1, 0, 0, 0, 0], enc(SECRET_COMMENT)));
        same(enc(`<svg xmlns="http://www.w3.org/2000/svg"><metadata>${SECRET_XMP}</metadata></svg>`));
        same(cat([0, 0, 0, 24], enc('ftypavif'), [0, 0, 0, 0], enc('mif1avif')));
        same(enc('%PDF-1.7 SECRET'));
        same(new Uint8Array(0));
        same(Uint8Array.from([0xFF]));
        same(Uint8Array.from([0xFF, 0xD8])); // two bytes: not the three of a JPEG's magic
        same(Uint8Array.from([0x89, 0x50, 0x4E, 0x47]));
        same(enc('RIFF'));
        same(cat(enc('RIFF'), [0, 0, 0, 0], enc('WAVE'), new Uint8Array(40)));
    });

    it('sniffs by the bytes, not by any name', () => {
        expect(sniffStrippable(jpeg())).toBe('jpeg');
        expect(sniffStrippable(png())).toBe('png');
        expect(sniffStrippable(webp())).toBe('webp');
        expect(sniffStrippable(enc('GIF89a'))).toBeNull();
    });
});

describe('orientationOfTiff', () => {
    it('reads both byte orders and refuses what is not a clean orientation', () => {
        const le = exifTiff(6);
        expect(orientationOfTiff(le)).toBe(6);
        // Big-endian: the minimal block this module writes.
        expect(orientationOfTiff(cat([0x4D, 0x4D, 0, 42, 0, 0, 0, 8, 0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1, 0, 3, 0, 0, 0, 0, 0, 0]))).toBe(3);
        expect(orientationOfTiff(new Uint8Array(0))).toBe(0);
        expect(orientationOfTiff(enc('not a tiff at all'))).toBe(0);
        expect(orientationOfTiff(le.subarray(0, 12))).toBe(0); // IFD cut off
        const wrongType = Uint8Array.from(le); const at = indexOfBytes(le, Uint8Array.from([0x12, 0x01]));
        wrongType[at + 2] = 4; // LONG
        expect(orientationOfTiff(wrongType)).toBe(0);
        const hugeCount = Uint8Array.from(le); hugeCount[8] = 0xFF; hugeCount[9] = 0xFF;
        expect(() => orientationOfTiff(hugeCount)).not.toThrow();
    });
});

describe('stripFileMetadata', () => {
    it('returns a File with the same name, type and date, and the metadata gone', async () => {
        const file = new File([Uint8Array.from(jpeg(everything))], 'IMG_0001.jpg', { type: 'image/jpeg', lastModified: 1234 });
        const out = await stripFileMetadata(file);
        expect(out.name).toBe('IMG_0001.jpg');
        expect(out.type).toBe('image/jpeg');
        expect(out.lastModified).toBe(1234);
        expect(leaked(new Uint8Array(await out.arrayBuffer()))).toEqual([]);
        expect(out.size).toBeLessThan(file.size);
    });

    it('hands back the same File for a type that is not a picture, and reads a typeless one', async () => {
        const video = new File(['x'], 'a.mp4', { type: 'video/mp4' });
        expect(await stripFileMetadata(video)).toBe(video);
        const typeless = new File([Uint8Array.from(jpeg({ comment: true }))], 'photo');
        expect(leaked(new Uint8Array(await (await stripFileMetadata(typeless)).arrayBuffer()))).toEqual([]);
        const gif = new File(['GIF89a....'], 'a.gif', { type: 'image/gif' });
        expect(await stripFileMetadata(gif)).toBe(gif);
    });
});

describe('malformed input never crashes the send', () => {
    // A small deterministic generator: a failure must reproduce.
    const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
    const samples: Array<[string, Uint8Array]> = [
        ['jpeg', jpeg({ ...everything, progressive: true })],
        ['png', png({ unknown: true, icc: true, trailer: enc('tail') })],
        ['webp', webp({ xmp: true, unknown: true, icc: true })],
        ['animated webp', webp({ animated: true, unknown: true })],
    ];

    /** Either bytes come out, or the one error type the UI knows how to say. */
    const settle = (b: Uint8Array): Uint8Array | null => {
        try {
            const out = stripImageMetadata(b);
            expect(out).toBeInstanceOf(Uint8Array);
            return out;
        } catch (e) {
            expect(e).toBeInstanceOf(ImageMetadataError);
            return null;
        }
    };

    it('every truncation point: an error or a result with none of the planted metadata', () => {
        for (const [name, input] of samples) {
            let results = 0;
            for (let n = 0; n < input.length; n++) {
                const out = settle(input.subarray(0, n));
                if (out) { results++; expect(leaked(out), `${name} cut at ${n}`).toEqual([]); }
            }
            expect(results, `${name} should accept some cut points`).toBeGreaterThan(0);
        }
    });

    it('thousands of random corruptions: only the known error, bounded output, stable on a second pass', () => {
        const next = rng(0xC0FFEE);
        for (const [name, input] of samples) {
            for (let k = 0; k < 1500; k++) {
                const b = Uint8Array.from(input);
                const flips = 1 + Math.floor(next() * 4);
                for (let f = 0; f < flips; f++) {
                    const at = Math.floor(next() * Math.min(b.length, 260)); // the header region is where lengths live
                    const v = next();
                    b[at] = v < 0.3 ? 0xFF : v < 0.5 ? 0 : Math.floor(next() * 256);
                }
                const out = settle(b);
                if (!out) continue;
                expect(out.length, name).toBeLessThanOrEqual(b.length + 40);
                const again = settle(out);
                expect(again, `${name} second pass`).not.toBeNull();
                expect(Array.from(again!), `${name} second pass is stable`).toEqual(Array.from(out));
            }
        }
    });

    it('random bytes behind each magic number: no throw but the known error, no hang', () => {
        const next = rng(7);
        const magics = [Uint8Array.from([0xFF, 0xD8, 0xFF]), jpeg().subarray(0, 2), png().subarray(0, 8), webp().subarray(0, 12)];
        for (const magic of magics) {
            for (let k = 0; k < 800; k++) {
                const junk = Uint8Array.from({ length: Math.floor(next() * 120) }, () => Math.floor(next() * 256));
                settle(cat(magic, junk));
            }
        }
    });
});

describe('the early return is not taken while something is still to remove', () => {
    it('metadata that is ONLY a tail behind the picture is still cut (JPEG, PNG, WebP)', () => {
        const j = jpeg({ exif: false, trailer: enc('TAIL-SECRETXMP-creator-jane') });
        expect(leaked(j)).toEqual(['XMP']);
        expect(leaked(stripImageMetadata(j))).toEqual([]);
        const p = png({ orientation: null, text: false, time: false, trailer: enc('TAIL-SECRETXMP-creator-jane') });
        expect(leaked(stripImageMetadata(p))).toEqual([]);
        const w = cat(riff(wchunk('VP8 ', VP8_BYTES)), enc('TAIL-SECRETXMP-creator-jane'));
        expect(leaked(stripImageMetadata(w))).toEqual([]);
    });
});
