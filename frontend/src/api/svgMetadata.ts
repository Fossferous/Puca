/**
 * An SVG cleaned before it is sent (api/fileMetadata.ts): of what an editor
 * leaves in it about the person and their machine, and of anything that
 * runs or loads something when the file is opened.
 *
 * Púca itself never draws a received SVG (safeBlobType makes it opaque bytes:
 * it is a download), but the person who downloads it opens it in a browser,
 * where it is a document: script runs, and an `<image href="https://…">`
 * tells that site who opened it. And an editor writes a lot into it:
 * Inkscape's `sodipodi:docname` and `inkscape:export-filename` (the file's
 * name and full path on the sender's disk, user name included), RDF
 * `<metadata>` (author, licence, dates), comments, and pictures embedded as
 * `data:` URLs with their EXIF.
 *
 * Parsed with the engine's own XML parser (DOMParser, `image/svg+xml`) and
 * written back with XMLSerializer, so it is the same drawing in different
 * bytes (formatting, entity references and the DOCTYPE do not survive; the
 * drawing does: checked pixel for pixel in a real browser,
 * e2e/photo-metadata-real-browser.mjs).
 *
 *   REMOVED  comments and processing instructions; `<metadata>`; every
 *            element and attribute outside the SVG, XLink and XML namespaces
 *            (Inkscape's, Sodipodi's, Illustrator's, RDF, HTML); `<script>`,
 *            `<foreignObject>`, SVG Tiny's `<handler>` and `<listener>`;
 *            every `on…` event attribute; an animation that targets `href`
 *            or an event attribute, or that names `javascript:`; `xml:base`;
 *            any `href` that is not a link to a part of the same file (`#…`)
 *            or an embedded PNG/JPEG/GIF/WebP — on a link (`<a>`), http(s)
 *            and mailto stay; CSS `@import` and any `url(…)` that is not
 *            `#…`, in `<style>`, in `style=` and in every other attribute.
 *   CLEANED  an embedded PNG, JPEG, GIF or WebP loses its metadata as a file
 *            of its own would (api/imageMetadata.ts, api/gifMetadata.ts).
 *
 * A file that is not well-formed XML, or whose root is not an SVG `<svg>`,
 * is refused (ImageMetadataError), as is a compressed one (`.svgz`): it would
 * otherwise be sent with whatever this could not read.
 */
import { ImageMetadataError, stripImageMetadata } from './imageMetadata';
import { stripGif } from './gifMetadata';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const DROP = new Set(['metadata', 'script', 'foreignobject', 'handler', 'listener']);
const ANIMATIONS = new Set(['set', 'animate', 'animatemotion', 'animatetransform', 'animatecolor']);

const fail = (why: string): never => { throw new ImageMetadataError('SVG', why, 'drawing'); };

/** Does this file look like an SVG (its first bytes, after any prolog)? */
export function sniffSvg(head: Uint8Array): boolean {
    let s = '';
    for (let i = 0; i < Math.min(head.length, 4096); i++) s += String.fromCharCode(head[i]);
    s = s.replace(/^\xEF\xBB\xBF/, '');
    return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)\s*)*<svg[\s>/]/i.test(s);
}

/** gzip's magic: a .svgz. */
export function isGzip(head: Uint8Array): boolean {
    return head.length >= 2 && head[0] === 0x1F && head[1] === 0x8B;
}

function decode(bytes: Uint8Array): string {
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
    let prolog = '';
    for (let i = 0; i < Math.min(bytes.length, 200); i++) prolog += String.fromCharCode(bytes[i]);
    const label = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(prolog.replace(/^\xEF\xBB\xBF/, ''))?.[1];
    try {
        return new TextDecoder(label && !/^utf-?8$/i.test(label) ? label : 'utf-8', { fatal: false }).decode(bytes);
    } catch {
        fail(`it is in an encoding this cannot read (${label})`);
        return '';
    }
}

const b64ToBytes = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function bytesToB64(b: Uint8Array): string {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
}

/** An embedded raster with its metadata taken off, or null when the URL is not one this keeps. */
function cleanDataImage(url: string): string | null {
    const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]*)$/i.exec(url);
    if (!m) return null;
    let bytes: Uint8Array;
    try { bytes = b64ToBytes(m[2].replace(/\s+/g, '')); } catch { return null; }
    const out = m[1].toLowerCase() === 'gif' ? stripGif(bytes) : stripImageMetadata(bytes);
    return `data:image/${m[1].toLowerCase()};base64,${bytesToB64(out)}`;
}

/** CSS with no @import and no url() but to a part of the same file. */
function cleanCss(css: string): string {
    return css
        .replace(/@import\b[^;]*;?/gi, '')
        .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole, _q, target: string) => (target.trim().startsWith('#') ? whole : 'none'));
}

function cleanHref(el: Element, value: string): string | null {
    const v = value.trim();
    if (v.startsWith('#')) return value;
    if (el.localName === 'a' && /^(https?:|mailto:)/i.test(v)) return value;
    if (/^data:/i.test(v)) return cleanDataImage(v);
    return null;
}

function cleanElement(el: Element): void {
    for (const attr of [...el.attributes]) {
        const name = attr.localName.toLowerCase();
        const ns = attr.namespaceURI;
        if (ns === XMLNS_NS) {
            // Declarations of namespaces nothing here uses any more; the serializer writes what it needs.
            if (attr.value !== SVG_NS && attr.value !== XLINK_NS) el.removeAttributeNode(attr);
            continue;
        }
        if (ns !== null && ns !== XLINK_NS && ns !== XML_NS) { el.removeAttributeNode(attr); continue; }
        if (ns === XML_NS && name === 'base') { el.removeAttributeNode(attr); continue; }
        if (name.startsWith('on')) { el.removeAttributeNode(attr); continue; }
        if (name === 'href') {
            const v = cleanHref(el, attr.value);
            if (v === null) el.removeAttributeNode(attr);
            else if (v !== attr.value) attr.value = v;
            continue;
        }
        if (/url\(|@import/i.test(attr.value)) attr.value = cleanCss(attr.value);
    }
}

/**
 * The SVG cleaned (see the top of this file), as UTF-8 bytes. Throws
 * ImageMetadataError for one that cannot be read.
 */
export function cleanSvg(bytes: Uint8Array): Uint8Array {
    if (isGzip(bytes)) fail('it is compressed (.svgz); save it as a plain .svg and send that');
    if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') fail('this device cannot read SVG here');
    const doc = new DOMParser().parseFromString(decode(bytes), 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || doc.getElementsByTagName('parsererror').length > 0) fail('it is not well-formed');
    if (root.namespaceURI !== SVG_NS || root.localName !== 'svg') fail('its root is not an SVG drawing');

    // Collect first, then remove: a live walk would skip the node after each one removed.
    const doomed: Node[] = [];
    const walker = doc.createTreeWalker(root, 0x1 | 0x80 | 0x40 | 0x8 /* elements, comments, PIs, CDATA in place */);
    for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
        if (n.nodeType === 8 || n.nodeType === 7) { doomed.push(n); continue; }
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        const local = el.localName.toLowerCase();
        if (el.namespaceURI !== SVG_NS || DROP.has(local)) { doomed.push(el); continue; }
        if (ANIMATIONS.has(local)) {
            const target = (el.getAttribute('attributeName') || '').trim().toLowerCase();
            const values = ['values', 'to', 'from', 'by'].map(a => el.getAttribute(a) || '').join(' ');
            if (target === 'href' || target === 'xlink:href' || target.startsWith('on') || /javascript:/i.test(values)) { doomed.push(el); continue; }
        }
        cleanElement(el);
        if (local === 'style') el.textContent = cleanCss(el.textContent || '');
    }
    // Children of a doomed element go with it; removing one already detached is harmless.
    for (const n of doomed) n.parentNode?.removeChild(n);
    // Comments and PIs outside the root (before or after it).
    for (const n of [...doc.childNodes]) if (n !== root && (n.nodeType === 8 || n.nodeType === 7)) doc.removeChild(n);

    const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root);
    return new TextEncoder().encode(text);
}
