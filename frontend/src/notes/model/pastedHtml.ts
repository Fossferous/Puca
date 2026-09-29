/**
 * The clipboard's HTML, read back as the Markdown it was rendered from.
 *
 * A checklist copied as RENDERED text (an assistant's answer selected on the
 * page rather than taken with its Copy button, a list off a web page) has
 * lost its marks in `text/plain`: no "#", no "- [ ]", only lines. So
 * readChecklist (noteContent.ts) rightly says it is not one, and the title
 * and every heading would paste as one more item each. The `text/html` the
 * browser puts beside it still has the <h1>/<h2>, the <li> and the checkbox.
 * This turns that back into the Markdown readChecklist already reads:
 *
 * - <h1>..<h6>, and role="heading" at its aria-level, as "#".."######"
 *   (inside a list item, only its text — unless the item is nothing but
 *   that heading, which is how Púca's own checklists render one);
 * - <li> as "- " or "1. ", a nested list indented under its item, and a
 *   second paragraph or a <br> in an item indented so it joins that item;
 * - a checkbox (<input type=checkbox>, or role="checkbox") as "[ ]", or
 *   "[x]" when checked;
 * - <pre> as a fenced code block;
 * - a link as "text (url)", the way plainInline writes one; every other
 *   inline mark (<strong>, <em>, <code>, <del>…) dropped, its text kept; an
 *   image as its alt text;
 * - table cells as "a | b", one row a line.
 *
 * It is used only when it reads as a checklist AND the plain text beside it
 * lost structure it still has (noteContent.ts readBestChecklist: Markdown
 * with headings of its own wins); otherwise the plain text is read, exactly
 * as before.
 *
 * INERT by construction. The markup is someone else's: a web page's, an
 * app's, whatever wrote the clipboard. DOMParser parses it into a DETACHED
 * document that has no browsing context and scripting disabled, so no
 * <script> runs, no on* handler is compiled, and no <img>, stylesheet or
 * frame is fetched. That document is only READ: nothing from it is inserted
 * into the page, adopted or cloned. <head>, <style>, <script>, comments,
 * hidden elements and form controls are ignored.
 *
 * And CHEAP, whatever it is handed. Above MAX_PASTE_HTML of markup it is not
 * parsed at all. Below it, a browser's parser still has shapes it is slow
 * on, far out of proportion to their size: in Chromium, 250 KB of nested
 * <div>s took 4.5 s, 680 KB of misnested <b><i><u><s> 59 s, and 50 KB of
 * nested <template>s crashed the renderer, which in the app is the whole
 * window. So the markup is scanned first (tooCostlyToParse, linear in its
 * length, and it refuses all three shapes; see there), and what it refuses
 * is not parsed either. Both fall back to the plain text.
 * (e2e/paste-html-real-browser.mjs proves all of this in a real Chromium;
 * jsdom fetches no image whatever the code does, and its parser is not the
 * one that is slow.)
 */

/** The most markup a paste is read for: 1 MB. A checklist is a few KB; a
 *  bigger clipboard is a whole page or a document, and its plain text is
 *  read instead, as before. */
export const MAX_PASTE_HTML = 1_000_000;

// --- The scan: what would this cost to parse, without parsing it --------------------
//
// A cut-down HTML tokenizer (tags, attributes, comments, raw text) that
// refuses the three shapes a browser's parser is slow on, each measured in
// Chromium (scratch rig, 2026-09-29):
//
// 1. DEEP NESTING. Every start tag of many kinds walks the parser's stack of
//    open elements, so the cost grows with the square of the depth: 50k
//    nested <div>s took 4.5 s, 30k <a><div>x</a> 15 s, 40k misnested
//    <b><i><u><s> 59 s, and 5k nested <template>s CRASHED the renderer. The
//    scan keeps a stack of tag names and pops it ONLY where the parser
//    certainly pops (an end tag of the element on top; a block's end tag
//    through the <p>, <li>… the parser closes on its way; the <li> a new <li>
//    closes, in plain HTML), ignoring every end tag it cannot match. Where
//    the two disagree the scan holds MORE open than the parser, never fewer.
//    It never treats "/>" as closing a non-void element (a browser's
//    serializer never writes one), and skips the text of <script>, <style>,
//    <textarea>… only where the parser surely does: not inside <svg>,
//    <math>, <select> or <frameset>, where it may be markup.
// 2. COMMENTS AT THE TOP. A comment before any content, or after </html>,
//    goes into the document itself (or its root), and each costs more than
//    the last: 40k took 2.7 s. The same comments inside the body cost 4 ms.
// 3. A REPEATED <html> or <body> WITH ATTRIBUTES, which the parser merges
//    into the one it has, one by one: 40k took 1.6 s.

/** The most elements the markup may hold open at once. A copied selection
 *  is a few levels deep, a whole page a few dozen. */
export const MAX_OPEN = 128;
/** The most comments the markup may put at the top of the document (a
 *  clipboard's markup has two: its fragment markers). */
const MAX_TOP_COMMENTS = 1000;

const VOID = new Set([
    'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input',
    'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
/** Elements whose content is text, up to their own end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);
/** Where a <script> or a <plaintext> may be markup after all, and a new
 *  <option> need not close the last. */
const UNSURE = new Set(['svg', 'math', 'select', 'frameset']);
/** What the parser closes on its way to a block's end tag (implied end tags). */
const IMPLIED = new Set(['dd', 'dt', 'li', 'optgroup', 'option', 'p', 'rb', 'rp', 'rt', 'rtc']);
/** End tags that close their element through IMPLIED ones. */
const BLOCK_END = new Set([
    'address', 'article', 'aside', 'blockquote', 'button', 'center', 'details', 'dialog', 'dir', 'div', 'dl',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'listing', 'main', 'menu', 'nav',
    'ol', 'pre', 'search', 'section', 'summary', 'ul', 'li', 'p', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'applet', 'marquee', 'object',
]);
/** Start tags that close a <p> left open on top (not <table>: in the quirks
 *  mode a clipboard's markup parses in, it does not). */
const CLOSES_P = new Set([
    'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
    'figcaption', 'figure', 'footer', 'header', 'hgroup', 'main', 'menu', 'nav', 'ol', 'p', 'search', 'section',
    'summary', 'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'listing', 'form', 'li', 'dd', 'dt', 'xmp',
]);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const CELLS = new Set(['td', 'th']);
const SECTIONS = new Set(['tbody', 'thead', 'tfoot']);

/** What `end`'s end tag closes on its way to its own element. */
function closesThrough(end: string, above: string): boolean {
    if (end === 'table') return CELLS.has(above) || SECTIONS.has(above) || above === 'tr' || above === 'caption' || above === 'colgroup' || IMPLIED.has(above);
    if (SECTIONS.has(end)) return CELLS.has(above) || above === 'tr' || IMPLIED.has(above);
    if (end === 'tr') return CELLS.has(above) || IMPLIED.has(above);
    if (CELLS.has(end) || BLOCK_END.has(end)) return IMPLIED.has(above);
    if (end === 'select') return above === 'option' || above === 'optgroup';
    return false;
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** A tag name ends at white space, "/" or ">". */
const endsName = (c: number) => isSpace(c) || c === 47 || c === 62;

/** Where the tag whose name ends at `i` ends: the index of its ">", past its
 *  attributes the way the tokenizer reads them (a quote opens a value only
 *  right after "="), or -1 when the markup ends first. */
function tagEnd(s: string, i: number): number {
    const n = s.length;
    while (i < n) {
        const c = s.charCodeAt(i);
        if (c === 62) return i;                                    // >
        if (isSpace(c) || c === 47) { i++; continue; }             // white space, /
        // An attribute name: its first character whatever it is (even "="),
        // then up to white space, "/", ">" or "=".
        i++;
        while (i < n && !endsName(s.charCodeAt(i)) && s.charCodeAt(i) !== 61) i++;
        while (i < n && isSpace(s.charCodeAt(i))) i++;
        if (s.charCodeAt(i) !== 61) continue;                      // no value
        i++;
        while (i < n && isSpace(s.charCodeAt(i))) i++;
        const q = s.charCodeAt(i);
        if (q === 34 || q === 39) {                                // "…" or '…'
            const close = s.indexOf(q === 34 ? '"' : "'", i + 1);
            if (close < 0) return -1;
            i = close + 1;
        } else {
            while (i < n && !isSpace(s.charCodeAt(i)) && s.charCodeAt(i) !== 62) i++;
        }
    }
    return -1;
}

/** Anything but white space in s[from, to)? */
function hasText(s: string, from: number, to: number): boolean {
    for (let k = from; k < to; k++) if (!isSpace(s.charCodeAt(k))) return true;
    return false;
}

/** Anything but white space and "/" in s[from, to): a tag's attributes. */
function hasAttributes(s: string, from: number, to: number): boolean {
    for (let k = from; k < to; k++) {
        const c = s.charCodeAt(k);
        if (!isSpace(c) && c !== 47) return true;
    }
    return false;
}

/**
 * True when parsing `html` would be slow (see above): it holds more than
 * MAX_OPEN elements open at once, puts more than MAX_TOP_COMMENTS comments
 * at the top of the document, or repeats <html> or <body> with attributes.
 * A scan of its tags, not a parse, and linear in its length: every step
 * moves forward, and the stack it walks is at most MAX_OPEN deep.
 */
export function tooCostlyToParse(html: string): boolean {
    const lower = html.toLowerCase();
    const n = html.length;
    const stack: string[] = [];
    let unsure = 0;
    const top = () => stack[stack.length - 1];
    const pop = () => { if (UNSURE.has(stack.pop() ?? '')) unsure--; };
    /** Before any content, or after </html>: a comment goes in the document. */
    let atTop = true;
    let topComments = 0;
    const comment = () => atTop && ++topComments > MAX_TOP_COMMENTS;
    let roots = 0;
    /** Where the last token ended: what lies between it and the next is text. */
    let prev = 0;
    let i = 0;
    while (i < n) {
        const lt = html.indexOf('<', i);
        if (lt < 0) break;
        if (atTop && hasText(html, prev, lt)) atTop = false;
        i = lt + 1;
        if (html.startsWith('!--', i)) {
            if (comment()) return true;
            const body = i + 3;
            if (html.startsWith('>', body)) { i = prev = body + 1; continue; }         // <!-->
            if (html.startsWith('->', body)) { i = prev = body + 2; continue; }        // <!--->
            // It ends at the first "-->" or "--!>": one search forward, never
            // one per ending (which would read the rest of the markup per comment).
            let dash = html.indexOf('--', body);
            while (dash >= 0 && !html.startsWith('>', dash + 2) && !html.startsWith('!>', dash + 2)) dash = html.indexOf('--', dash + 1);
            if (dash < 0) break;                                                      // the rest is a comment
            i = prev = dash + (html.startsWith('>', dash + 2) ? 3 : 4);
            continue;
        }
        const c = html.charCodeAt(i);
        if (c === 33 || c === 63) {                                                   // <!DOCTYPE…>, <?…>, <![CDATA[…
            if (comment()) return true;
            const gt = html.indexOf('>', i);
            if (gt < 0) break;
            i = prev = gt + 1;
            continue;
        }
        const isEnd = c === 47;
        if (isEnd) i++;
        if (!isLetter(html.charCodeAt(i))) {
            if (isEnd) {                                                              // "</>", or a bogus comment
                if (html.charCodeAt(i) !== 62 && comment()) return true;
                const gt = html.indexOf('>', i);
                if (gt < 0) break;
                i = prev = gt + 1;
            } else {
                atTop = false;                                                        // a "<" in the text
                prev = i;
            }
            continue;
        }
        let j = i;
        while (j < n && !endsName(html.charCodeAt(j))) j++;
        const name = lower.slice(i, j);
        const gt = tagEnd(html, j);
        if (gt < 0) break;                                                            // cut off inside a tag
        i = prev = gt + 1;
        if (isEnd) {
            // </html> puts what follows at the top again; </body> and </br>
            // make the body, as content does.
            if (name === 'html') atTop = true;
            else if (name === 'body' || name === 'br') atTop = false;
            if (name === 'html' || name === 'head' || name === 'body') continue;
            for (let k = stack.length - 1; k >= 0; k--) {
                if (stack[k] === name) { while (stack.length > k) pop(); break; }
                if (!closesThrough(name, stack[k])) break;                           // not certain: left open
            }
            continue;
        }
        if (name !== 'html') atTop = false;
        if (name === 'html' || name === 'body') {
            // Opened once; a second one's attributes are merged into the first.
            if (roots++ > 1 && hasAttributes(html, j, gt)) return true;
            continue;
        }
        if (name === 'head' || VOID.has(name)) continue;
        if (unsure === 0 && name === 'plaintext') break;                             // the rest is text
        if (unsure === 0 && RAW_TEXT.has(name)) {
            // Its text ends at "</name" and white space, "/" or ">"; the end
            // tag itself is read next, and closes nothing.
            let at = i;
            for (;;) {
                const e = lower.indexOf(`</${name}`, at);
                if (e < 0) { at = -1; break; }
                const after = e + 2 + name.length;
                if (after < n && endsName(html.charCodeAt(after))) { at = e; break; }
                at = e + 2;
            }
            if (at < 0) break;                                                        // the rest is its text
            i = prev = at;
            continue;
        }
        // What the parser closes as this one opens, where it is certain: in
        // plain HTML (inside <svg> or <math> an <option> is foreign and nests;
        // inside <select> most start tags are not even read).
        if (unsure === 0) {
            if (CLOSES_P.has(name) && top() === 'p') pop();
            if (name === 'li' && top() === 'li') pop();
            if ((name === 'dd' || name === 'dt') && (top() === 'dd' || top() === 'dt')) pop();
            if (HEADING_TAGS.has(name) && HEADING_TAGS.has(top())) pop();
            if ((name === 'option' || name === 'optgroup') && top() === 'option') pop();
            if (CELLS.has(name) && CELLS.has(top())) pop();
            if (name === 'tr') { while (CELLS.has(top())) pop(); if (top() === 'tr') pop(); }
            if (SECTIONS.has(name)) { while (CELLS.has(top()) || top() === 'tr') pop(); if (SECTIONS.has(top())) pop(); }
        }
        stack.push(name);
        if (UNSURE.has(name)) unsure++;
        if (stack.length > MAX_OPEN) return true;
    }
    return false;
}

/** Elements none of whose content is text that was copied. */
const SKIP = new Set([
    'head', 'title', 'meta', 'link', 'base', 'style', 'script', 'noscript', 'template',
    'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'canvas', 'svg', 'math',
    'audio', 'video', 'source', 'track', 'map', 'area', 'dialog',
    'button', 'select', 'option', 'optgroup', 'datalist', 'textarea', 'output', 'progress', 'meter',
]);

/** Elements that begin and end a line. */
const BLOCK = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'div',
    'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'html',
    'legend', 'main', 'nav', 'p', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr',
]);

const LISTS = new Set(['ul', 'ol', 'menu', 'dir']);

/** A code line that is itself a fence would end readChecklist's fence early. */
const FENCE_LINE = /^\s*(?:```|~~~)/;

interface Ctx {
    /** What a line of loose text starts with here: nothing at the top; inside
     *  a list item, the item's indent, so readChecklist joins it to that item. */
    cont: string;
    /** Inside a list item, where a heading is only text. */
    inItem: boolean;
    /** white-space: pre, pre-wrap or pre-line: a newline in the text is a line. */
    keepLines: boolean;
}

const ELEMENT = 1;
const TEXT = 3;

function isElement(n: Node): n is Element {
    return n.nodeType === ELEMENT;
}

/** Hidden in the page: not what was seen, so not what was meant. */
function isHidden(el: Element): boolean {
    if (el.hasAttribute('hidden')) return true;
    return /(?:^|;)\s*display\s*:\s*none\b/i.test(el.getAttribute('style') ?? '');
}

/** A heading's level: <h1>..<h6>, or role="heading" with its aria-level
 *  (2 when it names none, as ARIA says) — how Púca's own checklists mark
 *  one (components/TaskTree.tsx, NoteCard.tsx). Null for anything else. */
function headingLevel(el: Element): number | null {
    const tag = el.localName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return Number(tag[1]);
    if ((el.getAttribute('role') ?? '').toLowerCase() !== 'heading') return null;
    const level = Number.parseInt(el.getAttribute('aria-level') ?? '', 10);
    return Number.isFinite(level) ? Math.min(6, Math.max(1, level)) : 2;
}

/** The text a reader would see in `node`, white space collapsed: hidden
 *  elements and what SKIP leaves out do not count. */
function seenText(node: Node): string {
    let s = '';
    for (const c of Array.from(node.childNodes)) {
        if (c.nodeType === TEXT) s += (c as Text).data;
        else if (isElement(c) && !isHidden(c) && !SKIP.has(c.localName.toLowerCase())) {
            s += c.localName.toLowerCase() === 'img' ? ` ${c.getAttribute('alt') ?? ''} ` : ` ${seenText(c)} `;
        }
    }
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * The heading a list item is NOTHING BUT, or null: an <li> whose only text
 * is one heading's (a copied row of Púca's own list, <li><span
 * role="heading">Before you start</span>…buttons</li>, or <li><h2>…</h2>
 * </li>). An item with more text than its heading (<li><h3>Step</h3><p>
 * more</p></li>) is an item titled by it, and one with a box is an item.
 */
function headingOnly(li: Element): Element | null {
    if ((li.getAttribute('role') ?? '').toLowerCase() === 'checkbox') return null;
    // Not `let found: Element | null = null`: TypeScript would hold it null
    // past the walk, which is what assigns it.
    let found = null as Element | null;
    let boxes = 0;
    const walk = (el: Element) => {
        for (const c of Array.from(el.children)) {
            if (isHidden(c)) continue;
            const tag = c.localName.toLowerCase();
            const role = (c.getAttribute('role') ?? '').toLowerCase();
            if ((tag === 'input' && (c.getAttribute('type') ?? '').toLowerCase() === 'checkbox') || role === 'checkbox') boxes++;
            if (SKIP.has(tag)) continue;
            // The first heading; a second one's text is more than its own.
            if (headingLevel(c) !== null) found ??= c;
            else walk(c);
        }
    };
    walk(li);
    if (!found || boxes > 0) return null;
    const own = seenText(found);
    return own !== '' && own === seenText(li) ? found : null;
}

/** The white-space an element's own style sets, if it sets one. */
function keepsLines(el: Element, inherited: boolean): boolean {
    const m = /(?:^|;)\s*white-space(?:-collapse)?\s*:\s*([a-z-]+)/i.exec(el.getAttribute('style') ?? '');
    if (!m) return inherited;
    return /^(?:pre|pre-wrap|pre-line|break-spaces|preserve|preserve-breaks)$/i.test(m[1]);
}

/** A link's address, when it is one worth keeping beside its text: an
 *  absolute web or mail address (a browser resolves them in what it copies),
 *  with the "/" it adds to a bare host dropped again — "http://192.168.1.1",
 *  as it was written. */
function linkTarget(el: Element): string | null {
    const href = (el.getAttribute('href') ?? '').trim();
    if (!/^(?:https?:\/\/|mailto:)\S+$/i.test(href)) return null;
    return href.replace(/^(https?:\/\/[^/?#]+)\/$/i, '$1');
}

/** An address is the same address with or without its scheme and a closing
 *  "/", for the purpose of not saying it twice. */
const bareAddress = (s: string) => s.replace(/^(?:https?:\/\/|mailto:)/i, '').replace(/\/+$/, '').toLowerCase();

/** A <pre>'s text, its line breaks kept (a <br> or a block inside it is one). */
function preText(node: Node): string {
    let s = '';
    for (const c of Array.from(node.childNodes)) {
        if (c.nodeType === TEXT) { s += (c as Text).data; continue; }
        if (!isElement(c)) continue;
        const tag = c.localName.toLowerCase();
        if (SKIP.has(tag) || isHidden(c)) continue;
        if (tag === 'br') { s += '\n'; continue; }
        const inner = preText(c);
        s += inner;
        if ((BLOCK.has(tag) || tag === 'li') && inner && !inner.endsWith('\n')) s += '\n';
    }
    return s;
}

/** Writes Markdown lines. A line is `lead` (a list marker, a box, a
 *  heading's hashes, an item's indent) and then its text; a line with no
 *  text is not written. */
class Writer {
    readonly lines: string[] = [];
    private cur = '';
    private lead = '';
    /** `lead` is a marker still waiting for its text, so a block that opens
     *  before any text keeps it: <li><p>text</p></li> is "- text". */
    private held = false;
    /** Counts every time `cur` starts again, so a link knows its text is
     *  still the end of `cur`. */
    private starts = 0;

    /** End the line; the next starts with `next`, unless nothing was written
     *  after a held marker. */
    private brk(next: string) {
        const t = this.cur.replace(/\s+/g, ' ').trim();
        this.cur = '';
        this.starts++;
        if (t) { this.lines.push(this.lead + t); this.lead = next; this.held = false; }
        else if (!this.held) this.lead = next;
    }

    /** Start a line with a marker of its own: an item's, a heading's. */
    private start(lead: string) {
        this.brk('');
        this.lead = lead;
        this.held = true;
    }

    /** End that line, whatever was written on it. */
    private end(next: string) {
        this.brk(next);
        this.lead = next;
        this.held = false;
    }

    private box(checked: boolean, ctx: Ctx) {
        if (this.cur.trim()) this.brk(ctx.cont);     // a box mid-line starts the next item
        this.cur = '';
        this.starts++;
        if (!this.held) this.lead = ctx.cont;
        this.lead = this.lead.replace(/\[[ x]\] $/, '') + (checked ? '[x] ' : '[ ] ');
        this.held = true;
    }

    private text(s: string, ctx: Ctx) {
        if (!ctx.keepLines) { this.cur += s; return; }
        s.split(/\r\n?|\n/).forEach((part, i) => {
            if (i > 0) this.brk(ctx.cont);
            this.cur += part;
        });
    }

    children(node: Node, ctx: Ctx) {
        for (const c of Array.from(node.childNodes)) {
            if (c.nodeType === TEXT) this.text((c as Text).data, ctx);
            else if (isElement(c)) this.element(c, ctx);
            // Comments, processing instructions: not text.
        }
    }

    private element(el: Element, ctx: Ctx) {
        const tag = el.localName.toLowerCase();
        const role = (el.getAttribute('role') ?? '').toLowerCase();
        if (isHidden(el)) return;
        if (tag === 'input') {
            if ((el.getAttribute('type') ?? '').toLowerCase() === 'checkbox') this.box(el.hasAttribute('checked'), ctx);
            return;
        }
        if (SKIP.has(tag) && role !== 'checkbox') return;
        const inner: Ctx = { ...ctx, keepLines: keepsLines(el, ctx.keepLines) };

        const level = headingLevel(el);
        if (level !== null && !ctx.inItem) {
            this.start('#'.repeat(level) + ' ');
            this.children(el, inner);
            this.end(ctx.cont);
            return;
        }
        if (LISTS.has(tag)) {
            this.list(el, inner);
            return;
        }
        if (tag === 'li') {
            // One outside any list: an item all the same.
            this.item(el, '- ', inner);
            return;
        }
        if (tag === 'pre') {
            this.pre(el, ctx);
            return;
        }
        if (tag === 'br' || tag === 'hr') { this.brk(ctx.cont); return; }
        if (tag === 'img') { this.cur += el.getAttribute('alt') ?? ''; return; }

        const block = BLOCK.has(tag) || /^h[1-6]$/.test(tag);
        if (block) this.brk(ctx.cont);
        if (role === 'checkbox') this.box(el.getAttribute('aria-checked') === 'true', ctx);
        if (tag === 'td' || tag === 'th') {
            if (this.cur.trim()) this.cur += ' | ';
            this.children(el, inner);
        } else if (tag === 'a') {
            this.link(el, inner);
        } else {
            this.children(el, inner);
        }
        if (block) this.brk(ctx.cont);
    }

    private list(el: Element, ctx: Ctx) {
        const ordered = el.localName.toLowerCase() === 'ol';
        let n = ordered ? Number.parseInt(el.getAttribute('start') ?? '', 10) : 0;
        if (!Number.isFinite(n)) n = 1;
        this.brk(ctx.cont);
        for (const c of Array.from(el.childNodes)) {
            if (isElement(c) && c.localName.toLowerCase() === 'li') {
                if (isHidden(c)) continue;
                this.item(c, ordered ? `${n++}. ` : '- ', { ...ctx, keepLines: keepsLines(c, ctx.keepLines) });
            } else if (c.nodeType === TEXT) {
                this.text((c as Text).data, ctx);
            } else if (isElement(c)) {
                this.element(c, ctx);
            }
        }
        this.brk(ctx.cont);
    }

    /** A list item at `ctx.cont`'s indent: its marker, then its text; what
     *  it holds on later lines is indented under it. */
    private item(el: Element, marker: string, ctx: Ctx) {
        // A top-level item that is nothing but a heading is that heading:
        // Púca's own checklists render one as a row of the list.
        const heading = ctx.cont === '' ? headingOnly(el) : null;
        if (heading) {
            this.start('#'.repeat(headingLevel(heading) ?? 2) + ' ');
            this.children(heading, { ...ctx, inItem: true });
            this.end(ctx.cont);
            return;
        }
        this.start(ctx.cont + marker);
        if ((el.getAttribute('role') ?? '').toLowerCase() === 'checkbox') {
            this.box(el.getAttribute('aria-checked') === 'true', ctx);
        }
        this.children(el, { cont: ctx.cont + ' '.repeat(marker.length), inItem: true, keepLines: ctx.keepLines });
        this.end(ctx.cont);
    }

    private pre(el: Element, ctx: Ctx) {
        this.brk(ctx.cont);
        // A step that is nothing but code has no text of its own to keep.
        if (this.held) { this.lead = ctx.cont; this.held = false; }
        const code = preText(el).replace(/\s+$/, '');
        if (!code.trim()) return;
        this.lines.push(`${ctx.cont}\`\`\``);
        for (const line of code.split(/\r\n?|\n/)) {
            if (!FENCE_LINE.test(line)) this.lines.push(ctx.cont + line.trimEnd());
        }
        this.lines.push(`${ctx.cont}\`\`\``);
    }

    private link(el: Element, ctx: Ctx) {
        const starts = this.starts;
        const from = this.cur.length;
        this.children(el, ctx);
        const href = linkTarget(el);
        if (!href || this.starts !== starts) return;         // its text is not all on this line
        const label = this.cur.slice(from).replace(/\s+/g, ' ').trim();
        if (label && bareAddress(label) !== bareAddress(href)) this.cur += ` (${href})`;
    }

    finish(): string {
        this.brk('');
        return this.lines.join('\n');
    }
}

/**
 * `html` (a clipboard's `text/html`) as Markdown lines, or null when it is
 * not read: empty, over MAX_PASTE_HTML, too costly to parse
 * (tooCostlyToParse), or in a place with no DOMParser. Pure but for the
 * detached parse; see the header. The walk recurses as deep as the markup
 * nests, which the scan has already bounded; were it ever to run out of
 * stack, the catch reads that as "not read" too.
 */
export function htmlToMarkdown(html: string | null | undefined): string | null {
    if (!html || html.length > MAX_PASTE_HTML || typeof DOMParser !== 'function') return null;
    if (tooCostlyToParse(html)) return null;
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        if (!doc.body) return null;
        const out = new Writer();
        out.children(doc.body, { cont: '', inItem: false, keepLines: keepsLines(doc.body, false) });
        return out.finish();
    } catch {
        return null;
    }
}
