// @vitest-environment jsdom
/**
 * An SVG is cleaned before it is sent (api/svgMetadata.ts): what an editor
 * writes about the person and their machine goes, and so does anything that
 * would run or load something when the recipient opens the file. The drawing
 * stays, labels and embedded fonts included; e2e/photo-metadata-real-browser.mjs
 * checks it renders the same in a real browser (an editor's drawing, and a
 * diagram as Mermaid, draw.io and Excalidraw export one) and that the
 * original's script ran and its requests went out where the cleaned file's
 * do not.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanSvg, sniffSvg } from '../api/svgMetadata';
import { stripAttachmentMetadata } from '../api/fileMetadata';
import { ImageMetadataError } from '../api/imageMetadata';
import { contains, enc, indexOfBytes, jpeg, leaked } from './fixtures/photoMetadata';
import { diagramSvg, inkscapeSvg } from './fixtures/svgDrawing';

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const utf8 = (s: string) => new TextEncoder().encode(s);
const clean = (s: string) => text(cleanSvg(utf8(s)));
const svg = (body: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${attrs}>${body}</svg>`;
const b64 = (b: Uint8Array) => { let s = ''; for (const v of b) s += String.fromCharCode(v); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
/** Every embedded base64 data: URL in the text, with its bytes. */
const embedded = (s: string) => [...s.matchAll(/data:([a-z0-9/+.-]*);base64,([A-Za-z0-9+/=]+)/gi)].map(m => ({ type: m[1], bytes: unb64(m[2]) }));
const boxFont = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'metadata', 'box-font.ttf')));

describe('an SVG an editor saved', () => {
    const original = enc(inkscapeSvg(jpeg({ xmp: true, comment: true })));
    it('control: it carries the file\'s path and name, an author, comments, script, events and outside requests', () => {
        const s = text(original);
        for (const what of ['sodipodi:docname', 'inkscape:export-filename', '/home/jane/Documents', '<metadata', 'SECRETXMP-creator-jane', '<!--', '<script', 'onload=', '<foreignObject', 'https://tracker.example/pixel.png', '@import', 'javascript:',
            'u\\72l(https://tracker.example/esc-bg.png)', '@\\69mport "https://tracker.example/esc-import.css"', 'image-set("https://tracker.example/is.png"', 'attributeName="q:href"', '<html:iframe', 'ping=']) {
            expect(s, what).toContain(what);
        }
        // The embedded photo carries its EXIF (as base64), here twice: once as itself, once claiming to be a GIF.
        const photos = embedded(s);
        expect(photos.map(p => p.type)).toEqual(['image/jpeg', 'image/gif']);
        for (const p of photos) expect(leaked(p.bytes)).toEqual(expect.arrayContaining(['camera make', 'GPS latitude']));
    });

    it('loses all of that; the shapes, gradients, labels and links within the file stay', async () => {
        const out = text(await stripAttachmentMetadata(original.slice(), { name: 'logo.svg', type: 'image/svg+xml' }));
        for (const gone of ['sodipodi', 'inkscape', '/home/jane', 'logo-final', '<metadata', 'SECRETXMP-creator-jane', 'rdf:', '<!--', '<script', 'onload', 'onclick', 'onmouseover',
            'tracker.example', '@import', 'javascript:', 'xml:base', 'evil.example', 'SECRETCOMMENT', 'attributeName="href"', 'q:href', '72l', '69mport', 'image-set',
            '<iframe', '<html:iframe', 'ping', 'srcset', 'background=', '<object', '<video', 'poster', '<form', '<input', '<link', 'html:style', 'html:script']) {
            expect(out, gone).not.toContain(gone);
        }
        for (const kept of ['<rect', 'id="grad"', 'fill="url(#grad)"', '<use', 'href="#dot"', 'https://puca.example/about', 'Hello drawing', '<title>', 'stroke-width',
            '<foreignObject', 'Hi ', 'there</html:b>', 'href="https://puca.example/fo"', '>go</html:a>', 'font: 7px sans-serif']) {
            expect(out, kept).toContain(kept);
        }
        // The embedded photo is still there, twice, as a photo without its EXIF; the one that
        // claimed to be a GIF is called what it is.
        const photos = embedded(out);
        expect(photos.map(p => p.type), 'the embedded photos stay').toEqual(['image/jpeg', 'image/jpeg']);
        for (const p of photos) {
            expect(p.bytes[0]).toBe(0xFF);
            expect(leaked(p.bytes)).toEqual([]);
        }
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

describe('a diagram as Mermaid, draw.io and Excalidraw export one', () => {
    it('keeps its labels (HTML in a foreignObject) and its embedded font', () => {
        const out = clean(diagramSvg(boxFont));
        for (const kept of ['<foreignObject x="2" y="2"', '<span class="nodeLabel"><p style="margin: 0;">Start <b>here</b></p></span>', '<switch><foreignObject',
            'requiredFeatures=', '>Decide</div>', 'display: flex; align-items: center;', `src: url(data:font/ttf;base64,${b64(boxFont)});`, 'font-family: "Box"', 'ABC ACB']) {
            expect(out, kept).toContain(kept);
        }
        expect(out).not.toMatch(/src:\s*none/);
        // Mermaid's and draw.io's labels are what a reader sees in it, once each.
        expect(out.match(/Start <b>here<\/b>|Decide/g)).toEqual(['Start <b>here</b>', 'Decide']);
        expect(clean(out)).toBe(out);
    });
});

describe('HTML in a foreignObject: its text and layout stay, nothing that loads, runs, plays or posts', () => {
    const fo = (html: string) => clean(svg(`<foreignObject width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml">${html}</div></foreignObject>`));
    for (const [what, html, gone] of [
        ['an iframe', '<iframe src="https://t.example/f"></iframe>', ['<iframe', 't.example']],
        ['an object and an embed', '<object data="https://t.example/o"></object><embed src="https://t.example/e"/>', ['<object', '<embed', 't.example']],
        ['a video, its poster and its sources', '<video poster="https://t.example/p.png"><source src="https://t.example/v.mp4"/></video><audio src="https://t.example/a.mp3"></audio>', ['<video', '<source', '<audio', 't.example']],
        ['a form and its fields', '<form action="https://t.example/f"><input type="image" src="https://t.example/i.png"/><button formaction="https://t.example/b">b</button><textarea>t</textarea></form>', ['<form', '<input', '<button', '<textarea', 't.example']],
        ['a style sheet, a link to one, a base and a meta refresh', '<style>@import "https://t.example/s.css";</style><link rel="stylesheet" href="https://t.example/l.css"/><base href="https://t.example/"/><meta http-equiv="refresh" content="0;url=https://t.example/m"/>', ['<style', '<link', '<base', '<meta', 't.example']],
        ['script and event handlers', '<script>alert(1)</script><span onclick="alert(2)" onmouseover="alert(3)">s</span>', ['<script', 'alert', 'onclick', 'onmouseover']],
        ['a picture from outside, and srcset', '<img src="https://t.example/i.png" alt="a"/><img srcset="https://t.example/s.png 1x" alt="b"/>', ['t.example', 'srcset']],
        ['a background attribute and a style that loads', '<table background="https://t.example/t.png"><tr><td style="background: url(https://t.example/c.png)">c</td></tr></table>', ['background=', 't.example']],
        ['a link\'s ping, target, download, and a javascript: link', '<a href="https://ok.example/x" ping="https://t.example/p" target="_blank" download="x">ok</a><a href="javascript:alert(1)">no</a>', ['ping', 'target', 'download', 'javascript', 't.example']],
        ['xml:base and other namespaces\' attributes', '<span xml:base="https://t.example/" xmlns:z="urn:z" z:thing="secret">s</span>', ['xml:base', 't.example', 'z:thing', 'secret']],
        ['MathML and SVG-in-HTML that calls out', '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math><svg xmlns="http://www.w3.org/2000/svg"><image href="https://t.example/s.png"/></svg>', ['<math', 't.example']],
    ] as Array<[string, string, string[]]>) {
        it(what, () => {
            const out = fo(`<p>label</p>${html}`);
            for (const g of gone) expect(out, g).not.toContain(g);
            expect(out, 'the label stays').toContain('<p>label</p>');
        });
    }

    it('a link keeps http(s), mailto and a part of the file; a picture keeps only an embedded one, cleaned', () => {
        const photo = jpeg({ xmp: true, comment: true });
        const out = fo(`<a href="https://ok.example/x" title="t">a</a><a href="mailto:x@ok.example">m</a><a href="#n">n</a><img src="data:image/jpeg;base64,${b64(photo)}" alt="p" width="4" height="3"/>`);
        for (const kept of ['href="https://ok.example/x"', 'title="t"', 'href="mailto:x@ok.example"', 'href="#n"', 'alt="p"', 'width="4"']) expect(out, kept).toContain(kept);
        const pics = embedded(out);
        expect(pics).toHaveLength(1);
        expect(leaked(pics[0].bytes)).toEqual([]);
        expect(leaked(photo)).not.toEqual([]);
    });

    it('HTML that is not in a foreignObject still goes (it is never drawn there)', () => {
        const out = clean(svg('<g><div xmlns="http://www.w3.org/1999/xhtml">stray SECRETCOMMENT</div></g><rect width="1" height="1"/>'));
        expect(out).not.toContain('SECRETCOMMENT');
        expect(out).toContain('<rect');
    });
});

describe('CSS is read the way the engine reads it', () => {
    const style = (css: string) => clean(svg(`<style>${css}</style><rect width="1" height="1"/>`));
    const attr = (name: string, value: string) => clean(svg(`<rect width="1" height="1" ${name}="${value}"/>`));
    for (const [what, run] of [
        ['an escaped url( in a style attribute', () => attr('style', 'background-image: u\\72l(https://t.example/a.png)')],
        ['an escaped url( in a presentation attribute', () => attr('fill', 'u\\72l(https://t.example/a.svg#p)')],
        ['an escaped url( whose escape eats a space, in <style>', () => style('rect { fill: \\75 rl(https://t.example/a.svg#p); }')],
        ['an escaped url( with a quoted, escaped address', () => style('rect { fill: url("ht\\74ps://t.example/a.svg#p"); }')],
        ['an escaped @import with a plain string', () => style('@\\69mport "https://t.example/s.css"; rect { fill: red; }')],
        ['@import in capitals, with a media list', () => style('@IMPORT url(https://t.example/s.css) screen; rect { fill: red; }')],
        ['image-set( with plain strings', () => style('rect { background-image: image-set("https://t.example/a.png" 1x, "https://t.example/b.png" 2x); }')],
        ['-webkit-image-set( with plain strings', () => attr('style', 'cursor: -webkit-image-set(&quot;https://t.example/c.png&quot; 1x), auto')],
        ['an escaped image-set(', () => style('rect { background-image: im\\61ge-set("https://t.example/a.png" 1x); }')],
        ['an animation that sets a style that loads', () => clean(svg('<rect width="1" height="1"><set attributeName="style" to="background:u\\72l(https://t.example/a.png)"/></rect>'))],
    ] as Array<[string, () => string]>) {
        it(`${what} loads nothing`, () => {
            const out = run();
            expect(out).not.toContain('t.example');
            expect(out).toContain('<rect');
        });
    }

    it('what loads nothing is left as it was: a part of the file, colours, transforms, strings and comments', () => {
        const css = 'rect { fill: url(#g); stroke: url( "#h" ); content: "url(https://t.example/not-loaded)"; } /* @import "nothing" */ .a\\:b { transform: rotate(45deg) translate(1px, 2px); }';
        expect(style(css)).toContain(css);
        expect(attr('transform', 'matrix(1 0 0 1 2 3)')).toContain('transform="matrix(1 0 0 1 2 3)"');
    });

    it('an embedded font stays as it is, told by its bytes; an embedded picture is cleaned; anything else goes', () => {
        const photo = jpeg({ xmp: true, comment: true });
        const font = b64(boxFont);
        const out = style(`@font-face { font-family: A; src: url(data:font/ttf;base64,${font}) format("truetype"); }
            @font-face { font-family: B; src: url("data:application/octet-stream;base64,${font}"); }
            @font-face { font-family: C; src: url(data:font/woff2;base64,${b64(utf8('not a font at all, just words'))}); }
            rect { background-image: url(data:image/jpeg;base64,${b64(photo)}); }
            g { background-image: url("data:text/html;base64,${b64(utf8('<script>alert(1)</script>'))}"); }`);
        expect(out).toContain(`src: url(data:font/ttf;base64,${font}) format("truetype");`);
        expect(out).toContain(`src: url("data:application/octet-stream;base64,${font}");`);
        expect(out).toMatch(/font-family: C; src: none;/);
        expect(out).toMatch(/g \{ background-image: none; \}/);
        const pics = embedded(out).filter(p => p.type.startsWith('image/'));
        expect(pics).toHaveLength(1);
        expect(pics[0].bytes[0]).toBe(0xFF);
        expect(leaked(pics[0].bytes)).toEqual([]);
        expect(clean(out)).toBe(out);
    });
});

describe('an embedded picture is told by its bytes, not the type it claims', () => {
    const photo = jpeg({ xmp: true, comment: true });
    it('a JPEG with its EXIF that says it is a GIF, a PNG or a WebP is cleaned as the JPEG it is', () => {
        for (const claim of ['image/gif', 'image/png', 'image/webp']) {
            const out = clean(svg(`<image width="4" height="3" href="data:${claim};base64,${b64(photo)}"/>`));
            const pics = embedded(out);
            expect(pics.map(p => p.type), claim).toEqual(['image/jpeg']);
            expect(leaked(pics[0].bytes), claim).toEqual([]);
        }
    });
    it('a picture of a kind this cannot clean (an AVIF with its camera in it) is not kept', () => {
        const avif = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'metadata', 'photo.avif')));
        expect(contains(avif, 'SECRETCAM-Corp')).toBe(true);
        const out = clean(svg(`<image width="4" height="3" href="data:image/png;base64,${b64(avif)}"/><rect width="1" height="1"/>`));
        expect(embedded(out)).toEqual([]);
        expect(out).toContain('<image width="4" height="3"/>');
    });
});

describe('an animation that would put an address back', () => {
    for (const name of ['href', 'xlink:href', 'q:href', 'HREF', 'xml:base']) {
        it(`targeting ${name} goes`, () => {
            const out = clean(svg(`<image width="4" height="3"><set attributeName="${name}" to="https://t.example/a.png"/></image>`, ' xmlns:q="http://www.w3.org/1999/xlink"'));
            expect(out).not.toContain('t.example');
            expect(out).not.toContain('<set');
        });
    }
    it('control: an animation of a colour stays', () => {
        expect(clean(svg('<rect width="1" height="1"><set attributeName="fill" to="red"/></rect>'))).toContain('<set attributeName="fill" to="red"/>');
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
        const doc = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/jpeg;base64,${btoa(s)}"/></svg>`;
        await expect(stripAttachmentMetadata(enc(doc), { name: 'x.svg' })).rejects.toBeInstanceOf(ImageMetadataError);
    });
});
