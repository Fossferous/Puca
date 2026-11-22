// @vitest-environment jsdom
/**
 * An SVG is cleaned before it is sent (api/svgMetadata.ts): what an editor
 * writes about the person and their machine goes, and so does anything that
 * would run or load something when the recipient opens the file. The drawing
 * stays; e2e/photo-metadata-real-browser.mjs checks it renders the same in a
 * real browser and that the original's script ran where the cleaned file's
 * does not.
 */
import { describe, it, expect } from 'vitest';
import { cleanSvg, sniffSvg } from '../api/svgMetadata';
import { stripAttachmentMetadata } from '../api/fileMetadata';
import { ImageMetadataError } from '../api/imageMetadata';
import { contains, enc, indexOfBytes, jpeg, leaked } from './fixtures/photoMetadata';
import { inkscapeSvg } from './fixtures/svgDrawing';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('an SVG an editor saved', () => {
    const original = enc(inkscapeSvg(jpeg({ xmp: true, comment: true })));
    it('control: it carries the file\'s path and name, an author, comments, script, events and outside requests', () => {
        const s = text(original);
        for (const what of ['sodipodi:docname', 'inkscape:export-filename', '/home/jane/Documents', '<metadata', 'SECRETXMP-creator-jane', '<!--', '<script', 'onload=', '<foreignObject', 'https://tracker.example/pixel.png', '@import', 'javascript:']) {
            expect(s, what).toContain(what);
        }
        // The embedded photo carries its EXIF (as base64): decoded, it is there.
        const b64 = /data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/.exec(s)![1];
        expect(leaked(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))).toEqual(expect.arrayContaining(['camera make', 'GPS latitude']));
    });

    it('loses all of that; the shapes, gradients and links within the file stay', async () => {
        const out = text(await stripAttachmentMetadata(original.slice(), { name: 'logo.svg', type: 'image/svg+xml' }));
        for (const gone of ['sodipodi', 'inkscape', '/home/jane', 'logo-final', '<metadata', 'SECRETXMP-creator-jane', 'rdf:', '<!--', '<script', 'onload', 'onclick', 'foreignObject',
            'tracker.example', '@import', 'javascript:', 'xml:base', 'evil.example', 'SECRETCOMMENT', 'attributeName="href"']) {
            expect(out, gone).not.toContain(gone);
        }
        for (const kept of ['<rect', 'id="grad"', 'fill="url(#grad)"', '<use', 'href="#dot"', 'https://puca.example/about', 'Hello drawing', '<title>', 'stroke-width']) {
            expect(out, kept).toContain(kept);
        }
        // The embedded photo is still there, as a photo, without its EXIF.
        const b64 = /data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/.exec(out)?.[1];
        expect(b64, 'the embedded photo stays').toBeTruthy();
        const photo = Uint8Array.from(atob(b64!), c => c.charCodeAt(0));
        expect(photo[0]).toBe(0xFF);
        expect(leaked(photo)).toEqual([]);
        // It is still an SVG, and cleaning it again changes nothing.
        expect(sniffSvg(enc(out))).toBe(true);
        expect(text(cleanSvg(enc(out)))).toBe(out);
    });

    it('found by its bytes when the device said nothing about it', async () => {
        const out = await stripAttachmentMetadata(original.slice(), { name: 'drawing', type: '' });
        expect(contains(out, 'sodipodi')).toBe(false);
        // A text file that happens to hold SVG source is the sender's text, left as it is.
        const asText = await stripAttachmentMetadata(original.slice(), { name: 'example.txt', type: 'text/plain' });
        expect(text(asText)).toBe(text(original));
    });
});

describe('an SVG that cannot be read is refused, not sent with what it holds', () => {
    for (const [what, bytes] of [
        ['not well-formed', enc('<svg xmlns="http://www.w3.org/2000/svg"><metadata>SECRETXMP-creator-jane</svg>')],
        ['its root is not <svg>', enc('<html xmlns="http://www.w3.org/1999/xhtml"><body>hi</body></html>')],
        ['compressed (.svgz)', Uint8Array.from([0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 0, 3])],
    ] as Array<[string, Uint8Array]>) {
        it(what, async () => {
            await expect(stripAttachmentMetadata(bytes, { name: 'x.svg', type: 'image/svg+xml' })).rejects.toBeInstanceOf(ImageMetadataError);
            await expect(stripAttachmentMetadata(bytes, { name: 'x.svg', type: 'image/svg+xml' })).rejects.toThrow(/was not sent/);
        });
    }
    it('an embedded picture that is damaged refuses the drawing', async () => {
        const bad = Uint8Array.from(jpeg({ comment: true }));
        const com = indexOfBytes(bad, Uint8Array.from([0xFF, 0xFE]));
        bad[com + 2] = 0xFF; bad[com + 3] = 0xFF; // the comment's length runs past the end
        let s = ''; for (const v of bad) s += String.fromCharCode(v);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/jpeg;base64,${btoa(s)}"/></svg>`;
        await expect(stripAttachmentMetadata(enc(svg), { name: 'x.svg' })).rejects.toBeInstanceOf(ImageMetadataError);
    });
});
