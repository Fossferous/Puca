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
 * drawing does: checked pixel for pixel in a real browser, for an editor's
 * drawing and for a diagram drawn the way Mermaid, draw.io and Excalidraw
 * export them, e2e/photo-metadata-real-browser.mjs).
 *
 *   REMOVED  comments and processing instructions; `<metadata>`; every
 *            element and attribute outside the SVG, XLink and XML namespaces
 *            (Inkscape's, Sodipodi's, Illustrator's, RDF), except the HTML a
 *            `<foreignObject>` holds (below); every attribute SVG does not
 *            define (SVG_ATTRS), which draws nothing: draw.io's `content`
 *            (its copy of the diagram for editing it again, whose `<mxfile>`
 *            header names the site, the user agent and the time it was
 *            drawn), Mermaid's own `data-*` and `label-offset-x`, any
 *            editor's, except a `data-*` attribute the drawing's own CSS
 *            selects on or reads with attr() (cssDataAttributes: taking it
 *            out would change how it looks); `<script>`, SVG Tiny's
 *            `<handler>` and `<listener>`; every `on…` event attribute; an
 *            animation that targets `href` (under any prefix), `xml:base` or
 *            an event attribute, or that names `javascript:`; `xml:base`;
 *            any `href` that is not a link to a part of the same file (`#…`)
 *            or an embedded picture (below) — on a link (`<a>`), http(s)
 *            and mailto stay; in CSS (`<style>`, `style=` and every other
 *            attribute) `@import`, `image-set()` and its kin, and any `url(…)`
 *            that is not `#…`, an embedded picture or an embedded font, read
 *            the way the engine reads CSS (an escaped `u\72l(` is a `url(`).
 *   KEPT     a `<foreignObject>`'s HTML, which is how Mermaid and draw.io
 *            write their labels: text and the elements that lay it out
 *            (HTML_KEEP), with only the attributes that say how it looks
 *            (HTML_ATTRS; `style` cleaned as above); anything else in it
 *            (an iframe, a form, a video, a style sheet, script) goes. A link
 *            keeps http(s) and mailto, a picture only an embedded one. An
 *            embedded font (`url(data:font/woff2;base64,…)`, as Excalidraw
 *            writes them), told by its bytes; its own names are the font's.
 *   CLEANED  an embedded PNG, JPEG, GIF or WebP loses its metadata as a file
 *            of its own would (api/imageMetadata.ts, api/gifMetadata.ts),
 *            told by its bytes, not the type it claims; an embedded SVG (a
 *            `data:image/svg+xml` URL, base64 or percent-encoded: how draw.io
 *            writes its library icons and Excalidraw an SVG placed in a
 *            scene) is cleaned by this same function, as a drawing of its
 *            own, to MAX_NESTING deep; one the engine would not draw either
 *            (not well-formed, not an `<svg>`, compressed, or deeper) goes, as
 *            does an embedded picture of any other kind.
 *
 * A file that is not well-formed XML, or whose root is not an SVG `<svg>`,
 * is refused (ImageMetadataError), as is a compressed one (`.svgz`): it would
 * otherwise be sent with whatever this could not read.
 */
import { ImageMetadataError, sniffStrippable, stripImageMetadata } from './imageMetadata';
import { isGif, stripGif } from './gifMetadata';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

const DROP = new Set(['metadata', 'script', 'handler', 'listener']);
const ANIMATIONS = new Set(['set', 'animate', 'animatemotion', 'animatetransform', 'animatecolor']);

/** The HTML a `<foreignObject>` may keep: text and what lays it out. Nothing
 *  here loads, runs, plays or takes input (an `<img>` keeps only an embedded
 *  picture, a link only http(s), mailto or a part of the file). */
const HTML_KEEP = new Set([
    'div', 'span', 'p', 'br', 'wbr', 'hr', 'b', 'i', 'u', 's', 'em', 'strong', 'small', 'big', 'sub', 'sup',
    'code', 'pre', 'kbd', 'samp', 'var', 'mark', 'abbr', 'q', 'blockquote', 'cite', 'del', 'ins', 'strike', 'tt',
    'font', 'center', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup', 'label',
    'section', 'article', 'header', 'footer', 'aside', 'main', 'figure', 'figcaption', 'address', 'time', 'a', 'img',
    'body',
]);
/** ...and the attributes of it that say only how it looks or what it is
 *  (`aria-*` too). `style` is cleaned like any CSS here; `href` (a link) and
 *  `src` (a picture) as said above; everything else (`ping`, `srcset`,
 *  `background`, event handlers…) goes. */
const HTML_ATTRS = new Set([
    'class', 'id', 'style', 'dir', 'lang', 'title', 'align', 'valign', 'width', 'height', 'colspan', 'rowspan', 'span',
    'color', 'face', 'size', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'nowrap', 'alt', 'start', 'reversed',
    'value', 'type', 'role', 'hidden', 'datetime', 'name',
]);

/**
 * The attributes SVG defines with no namespace, lowercased: SVG 1.1 and 2,
 * SMIL animation, Filter Effects, CSS Masking, SVG fonts, every presentation
 * attribute (a CSS property spelt as an attribute), and ARIA's `role` (with
 * `aria-*`). Any other goes (cleanElement): it draws nothing, and it is where
 * an editor keeps what is its own, draw.io's `content` (its copy of the
 * diagram, with an `<mxfile>` header naming the site, the user agent and the
 * time it was drawn) and an editor's `data-*` among them. Not here though SVG
 * 2 defines them: `ping` (a request on every click) and `download`, which
 * the HTML a foreignObject keeps does not keep either. `href` is cleaned on
 * its own (cleanHref).
 */
const SVG_ATTRS = new Set(`
    id class style lang tabindex focusable autofocus role transform href
    version baseprofile x y width height viewbox preserveaspectratio zoomandpan contentscripttype contentstyletype
    externalresourcesrequired requiredfeatures requiredextensions systemlanguage
    target rel hreflang type referrerpolicy media title name
    cx cy r rx ry x1 y1 x2 y2 points d pathlength fr fx fy
    dx dy rotate textlength lengthadjust startoffset method spacing side path
    gradientunits gradienttransform spreadmethod offset
    patternunits patterncontentunits patterntransform
    markerunits markerwidth markerheight refx refy orient
    clippathunits maskunits maskcontentunits viewtarget
    attributename attributetype begin dur end min max restart repeatcount repeatdur fill calcmode values keytimes keysplines
    keypoints from to by additive accumulate origin
    filterunits primitiveunits filterres result in in2 mode operator k1 k2 k3 k4 tablevalues slope intercept amplitude exponent
    stddeviation edgemode order kernelmatrix divisor bias targetx targety preservealpha kernelunitlength surfacescale
    diffuseconstant specularconstant specularexponent azimuth elevation z pointsatx pointsaty pointsatz limitingconeangle
    scale xchannelselector ychannelselector basefrequency numoctaves seed stitchtiles radius crossorigin
    horiz-adv-x horiz-origin-x horiz-origin-y vert-adv-y vert-origin-x vert-origin-y unicode glyph-name orientation arabic-form
    units-per-em ascent descent cap-height x-height accent-height alphabetic ideographic hanging mathematical bbox panose-1
    stemh stemv underline-position underline-thickness overline-position overline-thickness strikethrough-position
    strikethrough-thickness unicode-range widths u1 u2 g1 g2 k v-alphabetic v-hanging v-ideographic v-mathematical
    string format local glyphref rendering-intent
    alignment-baseline baseline-shift buffered-rendering clip clip-path clip-rule color color-interpolation
    color-interpolation-filters color-profile color-rendering cursor direction display dominant-baseline enable-background
    fill-opacity fill-rule filter flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style
    font-variant font-weight glyph-orientation-horizontal glyph-orientation-vertical image-rendering inline-size isolation
    kerning letter-spacing lighting-color marker-end marker-mid marker-start mask mask-type mix-blend-mode opacity overflow
    paint-order pointer-events shape-rendering stop-color stop-opacity stroke stroke-dasharray stroke-dashoffset
    stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-overflow
    text-rendering transform-box transform-origin unicode-bidi vector-effect visibility white-space word-spacing writing-mode
`.trim().split(/\s+/));

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

const SVG_TYPE = 'image/svg+xml';

/** A data: URL as the URL standard reads one: its type, and its payload, base64 or percent-encoded. */
interface DataUrl { type: string; base64: boolean; payload: string }

/** A data: URL's parts, or null for any other URL (or base64 that is not). */
function parseDataUrl(url: string): DataUrl | null {
    const m = /^data:([^,]*),([\s\S]*)$/i.exec(url.trim());
    if (!m) return null;
    const params = m[1].split(';').map(x => x.trim());
    const base64 = params.length > 1 && /^base64$/i.test(params[params.length - 1]);
    if (base64 && !/^[A-Za-z0-9+/=\s]*$/.test(m[2])) return null;
    return { type: params[0].toLowerCase(), base64, payload: base64 ? m[2].replace(/\s+/g, '') : m[2] };
}

const isHexByte = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

/** The URL standard's percent-decode: the text as UTF-8, and each %XX the byte it names. */
function percentDecode(s: string): Uint8Array {
    const b = new TextEncoder().encode(s);
    const out = new Uint8Array(b.length);
    let n = 0;
    for (let i = 0; i < b.length; i++) {
        if (b[i] === 0x25 && i + 2 < b.length && isHexByte(b[i + 1]) && isHexByte(b[i + 2])) {
            out[n++] = parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16);
            i += 2;
        } else out[n++] = b[i];
    }
    return out.subarray(0, n);
}

/** What a data: URL holds (only its first bytes, enough for a magic number, when `head`), or null. */
function payloadBytes(d: DataUrl, head = false): Uint8Array | null {
    if (!d.base64) return percentDecode(head ? d.payload.slice(0, 96) : d.payload);
    try { return b64ToBytes(head ? d.payload.slice(0, 24) : d.payload); } catch { return null; }
}

type Picture = 'jpeg' | 'png' | 'webp' | 'gif';
const pictureOf = (b: Uint8Array): Picture | null => sniffStrippable(b) ?? (isGif(b) ? 'gif' : null);

/** WOFF, WOFF2, TrueType, OpenType/CFF, a collection, an old Mac TrueType. */
function isFont(b: Uint8Array): boolean {
    if (b.length < 4) return false;
    if (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) return true;
    const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
    return tag === 'wOFF' || tag === 'wOF2' || tag === 'OTTO' || tag === 'ttcf' || tag === 'true' || tag === 'typ1';
}

/** How deep a drawing embedded in a drawing is followed (an icon in an icon in a diagram is 2). */
export const MAX_NESTING = 4;
let nesting = 0;

/** An embedded SVG cleaned as a drawing of its own, or null for one the engine would not draw either. */
function cleanEmbeddedSvg(bytes: Uint8Array): Uint8Array | null {
    if (nesting >= MAX_NESTING) return null;
    nesting++;
    try { return cleanSvgBytes(bytes, true); } finally { nesting--; }
}

/**
 * An embedded picture with its metadata taken off, or null when the URL is
 * not one this keeps. A raster picture is told by its bytes: a JPEG that says
 * it is a GIF is a JPEG (and the engine would draw it as one), and a picture
 * of any other kind (AVIF, HEIC, TIFF…) is not kept, since its metadata would
 * be. An SVG, which the engine draws only when the URL says it is one, is
 * cleaned as a drawing (cleanEmbeddedSvg) and written back as base64.
 */
function cleanDataImage(url: string): string | null {
    const d = parseDataUrl(url);
    if (!d) return null;
    const bytes = payloadBytes(d);
    if (!bytes) return null;
    const kind = pictureOf(bytes);
    if (kind) {
        const out = kind === 'gif' ? stripGif(bytes) : stripImageMetadata(bytes);
        return `data:image/${kind};base64,${bytesToB64(out)}`;
    }
    if (d.type !== SVG_TYPE) return null;
    const svg = cleanEmbeddedSvg(bytes);
    return svg ? `data:${SVG_TYPE};base64,${bytesToB64(svg)}` : null;
}

/** What a CSS url() may keep: `#…`, an embedded picture (cleaned), an embedded font (as it is). */
function cleanCssUrl(value: string): string | null {
    const v = value.trim();
    if (v.startsWith('#')) return value;
    const d = parseDataUrl(v);
    if (!d) return null;
    const head = payloadBytes(d, true);
    if (!head) return null;
    if (pictureOf(head) || d.type === SVG_TYPE) return cleanDataImage(v);
    return isFont(head) ? value : null;
}

// ---------------------------------------------------------------- CSS, read as the engine reads it
// (CSS Syntax 3: escapes count in names, so `u\72l(` is `url(` and `@\69mport` is `@import`.)

const isNewline = (c: string | undefined): boolean => c === '\n' || c === '\r' || c === '\f';
const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || isNewline(c);
const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isNameChar = (c: string | undefined): boolean => c !== undefined && (/^[A-Za-z0-9_-]$/.test(c) || c.charCodeAt(0) >= 0x80);
/** A backslash that starts an escape (not one before a newline or at the end). */
const escapeAt = (css: string, i: number): boolean => css[i] === '\\' && i + 1 < css.length && !isNewline(css[i + 1]);

/** The escape at `i` (a backslash): what it stands for, and where it ends. */
function readEscape(css: string, i: number): [string, number] {
    let j = i + 1;
    let hex = '';
    while (hex.length < 6 && isHex(css[j])) hex += css[j++];
    if (!hex) {
        const ch = String.fromCodePoint(css.codePointAt(j) ?? 0xFFFD);
        return [ch, j + ch.length];
    }
    if (isSpace(css[j])) j += css[j] === '\r' && css[j + 1] === '\n' ? 2 : 1;
    const cp = parseInt(hex, 16);
    return [cp > 0 && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) ? String.fromCodePoint(cp) : '�', j];
}

/** A name (an identifier, an at-rule's, a function's) from `i`, its escapes read. */
function readName(css: string, i: number): [string, number] {
    let name = '';
    let j = i;
    while (j < css.length) {
        if (isNameChar(css[j])) { name += css[j++]; continue; }
        if (escapeAt(css, j)) { const [ch, k] = readEscape(css, j); name += ch; j = k; continue; }
        break;
    }
    return [name, j];
}

/** The string that starts at `i` (a quote): its value, and where it ends. */
function readString(css: string, i: number): { value: string; end: number } {
    const q = css[i];
    let value = '';
    let j = i + 1;
    while (j < css.length) {
        const c = css[j];
        if (c === q) return { value, end: j + 1 };
        if (isNewline(c)) return { value, end: j }; // a bad string ends at the line
        if (c === '\\') {
            const n = css[j + 1];
            if (n === undefined) { j++; continue; }
            if (isNewline(n)) { j += n === '\r' && css[j + 2] === '\n' ? 3 : 2; continue; }
            const [ch, k] = readEscape(css, j);
            value += ch;
            j = k;
            continue;
        }
        value += c;
        j++;
    }
    return { value, end: j };
}

const endOfComment = (css: string, i: number): number => {
    const e = css.indexOf('*/', i + 2);
    return e < 0 ? css.length : e + 2;
};

/** Past the bracket that closes the one at `open` (strings, comments and escapes skipped). */
function endOfBlock(css: string, open: number): number {
    const o = css[open];
    const c = o === '(' ? ')' : o === '{' ? '}' : ']';
    let depth = 0;
    let j = open;
    while (j < css.length) {
        const ch = css[j];
        if (ch === '"' || ch === "'") { j = readString(css, j).end; continue; }
        if (ch === '/' && css[j + 1] === '*') { j = endOfComment(css, j); continue; }
        if (ch === '\\') { j += 2; continue; }
        if (ch === o) depth++;
        else if (ch === c && --depth === 0) return j + 1;
        j++;
    }
    return css.length;
}

/** Past the end of the at-rule whose prelude starts at `i`: its `;`, or its block. */
function endOfAtRule(css: string, i: number): number {
    let j = i;
    while (j < css.length) {
        const ch = css[j];
        if (ch === '"' || ch === "'") { j = readString(css, j).end; continue; }
        if (ch === '/' && css[j + 1] === '*') { j = endOfComment(css, j); continue; }
        if (ch === '\\') { j += 2; continue; }
        if (ch === '(' || ch === '[') { j = endOfBlock(css, j); continue; }
        if (ch === ';') return j + 1;
        if (ch === '{') return endOfBlock(css, j);
        j++;
    }
    return css.length;
}

/** A url(…) whose `(` is at `open`: what it points at, and where it ends. */
function readUrl(css: string, open: number): { value: string; end: number } {
    let k = open + 1;
    while (isSpace(css[k])) k++;
    if (css[k] === '"' || css[k] === "'") return { value: readString(css, k).value, end: endOfBlock(css, open) };
    let value = '';
    while (k < css.length && css[k] !== ')') {
        if (escapeAt(css, k)) { const [ch, e] = readEscape(css, k); value += ch; k = e; continue; }
        value += css[k++];
    }
    return { value: value.trim(), end: Math.min(css.length, k + 1) };
}

/** Functions that take a plain string as an address to load (CSS Images 4, CSS Values 5). */
const LOADS_A_STRING = new Set(['image-set', '-webkit-image-set', 'image', 'src']);

/** CSS with nothing left that loads from anywhere but the file itself (see the top of this file). */
function cleanCss(css: string): string {
    let out = '';
    let i = 0;
    while (i < css.length) {
        const c = css[i];
        if (c === '/' && css[i + 1] === '*') { const j = endOfComment(css, i); out += css.slice(i, j); i = j; continue; }
        if (c === '"' || c === "'") { const j = readString(css, i).end; out += css.slice(i, j); i = j; continue; }
        if (c === '@') {
            const [name, j] = readName(css, i + 1);
            if (name.toLowerCase() === 'import') { i = endOfAtRule(css, j); continue; }
            out += css.slice(i, j);
            i = j;
            continue;
        }
        if (isNameChar(c) || escapeAt(css, i)) {
            const [name, j] = readName(css, i);
            const fn = name.toLowerCase();
            if (css[j] === '(' && fn === 'url') {
                const { value, end } = readUrl(css, j);
                const kept = cleanCssUrl(value);
                out += kept === null ? 'none' : kept === value ? css.slice(i, end) : `url("${kept}")`;
                i = end;
                continue;
            }
            if (css[j] === '(' && LOADS_A_STRING.has(fn)) { out += 'none'; i = endOfBlock(css, j); continue; }
            out += css.slice(i, j);
            i = j;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * The `data-*` attributes this CSS selects on (`[data-look]`, `[ data-\6c ook ]`,
 * `[svg|data-x]`) or reads (`attr(data-x)`, which Chromium reads into any
 * property), lowercased, added to `into`: taking one out would change how the
 * drawing looks. Strings and comments are skipped; names are read with their
 * escapes, as the engine reads them.
 */
function cssDataAttributes(css: string, into: Set<string>): void {
    const name = (at: number): number => {
        let j = at;
        while (isSpace(css[j])) j++;
        let [n, k] = readName(css, j);
        if (css[k] === '*' && !n) k++;
        if (css[k] === '|' && css[k + 1] !== '=') [n, k] = readName(css, k + 1); // a namespace prefix
        if (n.toLowerCase().startsWith('data-')) into.add(n.toLowerCase());
        return Math.max(k, at);
    };
    let i = 0;
    while (i < css.length) {
        const c = css[i];
        if (c === '/' && css[i + 1] === '*') { i = endOfComment(css, i); continue; }
        if (c === '"' || c === "'") { i = readString(css, i).end; continue; }
        if (c === '[') { i = name(i + 1); continue; }
        if (isNameChar(c) || escapeAt(css, i)) {
            const [fn, j] = readName(css, i);
            i = css[j] === '(' && fn.toLowerCase() === 'attr' ? name(j + 1) : Math.max(j, i + 1);
            continue;
        }
        i++;
    }
}

/**
 * The `data-*` attributes this drawing's own CSS selects on or reads
 * (cssDataAttributes): its `<style>`s, and the attributes SVG defines on its
 * elements (`style`, a presentation attribute), which are what is kept of it.
 */
function styledDataAttributes(root: Element): Set<string> {
    const found = new Set<string>();
    for (const el of [root, ...root.getElementsByTagNameNS(SVG_NS, '*')]) {
        if (el.localName.toLowerCase() === 'style') cssDataAttributes(el.textContent || '', found);
        for (const attr of el.attributes) {
            if (attr.namespaceURI === null && SVG_ATTRS.has(attr.localName.toLowerCase()) && /[[(]/.test(attr.value)) cssDataAttributes(attr.value, found);
        }
    }
    return found;
}

// ---------------------------------------------------------------- elements

function cleanHref(el: Element, value: string): string | null {
    const v = value.trim();
    if (v.startsWith('#')) return value;
    if (el.localName.toLowerCase() === 'a' && /^(https?:|mailto:)/i.test(v)) return value;
    if (/^data:/i.test(v)) return cleanDataImage(v);
    return null;
}

/** A namespace declaration this file still needs (the serializer writes any other it needs). */
const keptDeclaration = (value: string): boolean => value === SVG_NS || value === XLINK_NS || value === HTML_NS;

/** CSS in an attribute: any value that could hold a function or an at-rule is read as CSS. */
function cleanCssAttr(attr: Attr): void {
    if (!/[(@]/.test(attr.value)) return;
    const v = cleanCss(attr.value);
    if (v !== attr.value) attr.value = v;
}

/**
 * An SVG element's attributes cleaned: only the ones SVG defines (SVG_ATTRS,
 * `aria-*`), and a `data-*` one only when `styled` (the drawing's own CSS
 * selects on it or reads it), each cleaned of what loads.
 */
function cleanElement(el: Element, styled: ReadonlySet<string>): void {
    for (const attr of [...el.attributes]) {
        const name = attr.localName.toLowerCase();
        const ns = attr.namespaceURI;
        if (ns === XMLNS_NS) {
            if (!keptDeclaration(attr.value)) el.removeAttributeNode(attr);
            continue;
        }
        if (ns !== null && ns !== XLINK_NS && ns !== XML_NS) { el.removeAttributeNode(attr); continue; }
        if (ns === XML_NS && name === 'base') { el.removeAttributeNode(attr); continue; }
        if (name.startsWith('on')) { el.removeAttributeNode(attr); continue; }
        if (ns === null && !SVG_ATTRS.has(name) && !name.startsWith('aria-') && !(name.startsWith('data-') && styled.has(name))) {
            el.removeAttributeNode(attr);
            continue;
        }
        if (name === 'href') {
            const v = cleanHref(el, attr.value);
            if (v === null) el.removeAttributeNode(attr);
            else if (v !== attr.value) attr.value = v;
            continue;
        }
        cleanCssAttr(attr);
    }
}

/** An HTML element a foreignObject keeps (HTML_KEEP): only the attributes in HTML_ATTRS. */
function cleanHtmlElement(el: Element): void {
    const local = el.localName.toLowerCase();
    for (const attr of [...el.attributes]) {
        const name = attr.localName.toLowerCase();
        const ns = attr.namespaceURI;
        if (ns === XMLNS_NS) {
            if (!keptDeclaration(attr.value)) el.removeAttributeNode(attr);
            continue;
        }
        if (ns === XML_NS && (name === 'lang' || name === 'space')) continue;
        if (ns !== null) { el.removeAttributeNode(attr); continue; }
        if ((name === 'href' && local === 'a') || (name === 'src' && local === 'img')) {
            const v = name === 'src' ? (/^\s*data:/i.test(attr.value) ? cleanDataImage(attr.value) : null) : cleanHref(el, attr.value);
            if (v === null) el.removeAttributeNode(attr);
            else if (v !== attr.value) attr.value = v;
            continue;
        }
        if (!HTML_ATTRS.has(name) && !name.startsWith('aria-')) { el.removeAttributeNode(attr); continue; }
        if (name === 'style') cleanCssAttr(attr);
    }
}

/** Is this HTML element where a foreignObject's content is (its child, or inside HTML that is)? */
function inForeignObject(el: Element): boolean {
    const p = el.parentElement;
    if (!p) return false;
    return p.namespaceURI === HTML_NS || (p.namespaceURI === SVG_NS && p.localName.toLowerCase() === 'foreignobject');
}

/**
 * The SVG cleaned (see the top of this file), as UTF-8 bytes. Throws
 * ImageMetadataError for one that cannot be read.
 */
export function cleanSvg(bytes: Uint8Array): Uint8Array {
    return cleanSvgBytes(bytes, false)!;
}

/**
 * The work of cleanSvg. `embedded`: a drawing inside a drawing, where one
 * the engine would not draw (compressed, not well-formed, not an `<svg>`,
 * in an encoding it cannot read) is null, to be taken out, rather than a
 * refusal of the whole file; a damaged picture inside it still refuses the
 * file, as it would at the top.
 */
function cleanSvgBytes(bytes: Uint8Array, embedded: boolean): Uint8Array | null {
    if (isGzip(bytes)) return embedded ? null : fail('it is compressed (.svgz); save it as a plain .svg and send that');
    if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') fail('this device cannot read SVG here');
    let source: string;
    try { source = decode(bytes); } catch (e) { if (embedded && e instanceof ImageMetadataError) return null; throw e; }
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || doc.getElementsByTagName('parsererror').length > 0) return embedded ? null : fail('it is not well-formed');
    if (root.namespaceURI !== SVG_NS || root.localName !== 'svg') return embedded ? null : fail('its root is not an SVG drawing');

    // Read before anything is cleaned: which data-* attributes the drawing's CSS needs.
    const styled = styledDataAttributes(root);
    // Collect first, then remove: a live walk would skip the node after each one removed.
    const doomed: Node[] = [];
    const walker = doc.createTreeWalker(root, 0x1 | 0x80 | 0x40 | 0x8 /* elements, comments, PIs, CDATA in place */);
    for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
        if (n.nodeType === 8 || n.nodeType === 7) { doomed.push(n); continue; }
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        const local = el.localName.toLowerCase();
        if (el.namespaceURI === HTML_NS) {
            // A label in a foreignObject, as Mermaid and draw.io write them; anything that is not text and its layout goes.
            if (!inForeignObject(el) || !HTML_KEEP.has(local)) { doomed.push(el); continue; }
            cleanHtmlElement(el);
            continue;
        }
        if (el.namespaceURI !== SVG_NS || DROP.has(local)) { doomed.push(el); continue; }
        if (ANIMATIONS.has(local)) {
            const target = (el.getAttribute('attributeName') || '').trim().toLowerCase();
            const values = ['values', 'to', 'from', 'by'].map(a => el.getAttribute(a) || '').join(' ');
            if (/(^|:)(href|base)$/.test(target) || target.startsWith('on') || /javascript:/i.test(values)) { doomed.push(el); continue; }
        }
        cleanElement(el, styled);
        if (local === 'style') {
            const css = el.textContent || '';
            const clean = cleanCss(css);
            if (clean !== css) el.textContent = clean;
        }
    }
    // Children of a doomed element go with it; removing one already detached is harmless.
    for (const n of doomed) n.parentNode?.removeChild(n);
    // Comments and PIs outside the root (before or after it).
    for (const n of [...doc.childNodes]) if (n !== root && (n.nodeType === 8 || n.nodeType === 7)) doc.removeChild(n);

    const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root);
    return new TextEncoder().encode(text);
}
