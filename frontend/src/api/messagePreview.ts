/**
 * Message text -> preview. The ONE rule for every surface that re-shows a
 * message somewhere other than the message list: the reply snapshot and the
 * "Replying to" bar, the pinned list, search (results, and — through
 * messageSearchText — matching), Quote, the collection feed — plus the split
 * Edit uses.
 *
 * Why it exists: an attachment is stored inside the (E2EE) message as
 * markdown, `![photo.png](sovereign-enc:<id>?k=<file key>&m=<mime>&c=<fetch
 * capability>)`. The message list renders that as the picture, but each
 * preview surface printed the text verbatim — the owner's "when sending an
 * image it shows [string of text]" — and the pinned list and Edit put the
 * file's decryption key and fetch capability on screen. Here each ref becomes
 * a segment carrying only what a person should see: what kind of file, and
 * its name (the WIRE label — serializeAttachments has already replaced
 * `[]()` and newlines; receivers never had the sender's true filename).
 *
 * Robust to TRUNCATED input on purpose: history reply snapshots used to be
 * `content.slice(0, 100)`, which cuts a ref mid-key with no closing `)`. The
 * snapshot now keeps the whole text, but a parser that only knew the complete
 * form would put a dangling `![photo.png](sovereign-enc:…?k=…` back on screen
 * the next time anything cuts one.
 *
 * A `||spoiler||` is just as much a thing a preview must not print. Its words
 * become a `spoiler` segment (a chip like the one a spoilered file gets),
 * whatever they are: text, code, a link, a mention, a file's name. That is
 * read off the SAME parse the message list draws (utils/messageParser), never
 * off a pattern of its own: which `||` pair up is the parser's to say, and a
 * preview that paired them differently would print what the message hides. Only
 * the spoilers are replaced, in the message as it was typed (the parse says where
 * each is): every other word of it is kept byte for byte. A file the list hides is
 * a spoilered chip for the same reason, whichever bars hide it.
 * Quote is the one that keeps them (`spoilers: 'keep'`): it copies into the
 * composer, where the bars are what makes the quote a spoiler too.
 *
 * Edit reads the same parse: the files it takes out of the box are the ones the
 * list draws, never what a pattern of its own takes for code, and it puts them
 * back where each is drawn again, hidden if it was.
 *
 * Pure and React-free; components/MessagePreview.tsx renders the segments
 * with icons. Tests: tests/messagePreview.test.ts, tests/spoilerPreviews.test.ts.
 */
import { audioMimeFor, videoMimeFor } from './attachments';
import { decodeClipRef } from './clips/clipRef';
import { formatClock } from './clips/clipPresets';
import { parseMessage, spoilerSpan, typedSpan, type Node } from '../utils/messageParser';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';
export type PreviewSegment =
    | { type: 'text'; text: string }
    | { type: 'attachment'; kind: AttachmentKind; name: string; spoiler: boolean }
    | { type: 'clip'; label: string }
    /** The words of a `||spoiler||`, which a preview never prints. */
    | { type: 'spoiler' };

/**
 * One attachment or clip reference, in any of the shapes a message can hold:
 *   1-5  `||`? `!`? `[label](` scheme-href ( `)` `||`? | END-OF-TEXT )
 *        — the markdown form, spoiler-wrapped or not, complete or cut off;
 *   6    a bare `sovereign-enc:` / `sovereign-clip:` href someone typed.
 * A label holds no `[`: one left open before the ref (`:[`) would otherwise run the label from it through
 * everything between, the cover of a spoiler and its bars included, to the real `](`, and print the file's
 * name from inside a spoiler. The ref starts at ITS `[`, and what stands before it stays words. No part of
 * one holds what stands for a spoiler (COVER, HIDDEN_FILE): a ref run on through one would take its chip.
 * `i` throughout: URL schemes are case-insensitive (isSafeUrl lowercases), and
 * a case-sensitive matcher once let `SOVEREIGN-ENC:` carry its key past a scrub.
 */
const REF_RE = /(\|\|)?(!?)\[([^[\]\n]*)\]\(\s*(sovereign-(?:enc|clip):[^)\s]*)\s*(?:\)(\|\|)?|$)|(sovereign-(?:enc|clip):[^\s)\]|]*)/gi;
/** A markdown link cut off before its scheme was even complete: `![a.png](sover`. */
const CUT_LINK_RE = /(\|\|)?(!?)\[([^[\]\n]*)\]\(\s*([a-z-]*)$/i;

interface RefMatch {
    start: number;
    end: number;
    /** The exact source text of the ref, spoiler bars included when consumed. */
    raw: string;
    segment: Exclude<PreviewSegment, { type: 'text' }>;
}

function safeDecode(s: string): string {
    try { return decodeURIComponent(s); } catch { return s; }
}

function kindOf(href: string, bang: boolean, name: string): AttachmentKind {
    const m = /[?&]m=([^&]*)/i.exec(href);
    const mime = m ? safeDecode(m[1]).toLowerCase() : '';
    if (mime.startsWith('image/')) return 'image';
    if (videoMimeFor(name, mime)) return 'video';
    // The message list's own rule, in its order (MessageContent asks
    // videoMimeFor, then audioMimeFor): an `.mp3` whose ref says octet-stream
    // plays there as audio, so it is audio here too; a playlist type or an
    // .amr gets the download chip there, so it is a file here.
    if (audioMimeFor(name, mime)) return 'audio';
    if (bang && (!mime || mime === 'application/octet-stream')) return 'image';
    return 'file';
}

function clipLabel(href: string): string {
    if (!/\?/.test(href)) return 'Clip (removed)';
    const manifest = decodeClipRef(href);
    return manifest ? `Clip · ${formatClock(manifest.durationMs / 1000)}` : 'Clip';
}

type Span = readonly [number, number];

const inside = (spans: readonly Span[], index: number) => spans.some(([from, to]) => index >= from && index < to);

/** Where each `||` is that no spoiler of the list's takes: one it draws as words. */
function strayBars(content: string, spoilers: readonly Span[]): number[] {
    const out: number[] = [];
    for (let bars = content.indexOf('||'); bars !== -1; bars = content.indexOf('||', bars + 2)) {
        if (!inside(spoilers, bars)) out.push(bars);
    }
    return out;
}

/**
 * Whether a file typed at `index` is hidden: in a spoiler the message draws (`spoilers`, where the
 * parse says each was typed), or after a `||` it leaves open (`strays`, from `strayBars`). The parse
 * is what pairs the bars, as it is for the message list: counting them was a pairing of its own, and
 * printed the name of a file the list hides (`_||[_](…)||[w4](…)||` is drawn as `_` and `||[` in
 * italics, words, and a spoiler holding w4, and two `||` before it said it was in none). A `||` the
 * list draws as words, before a file and not closed by the time it comes, still hides it here: what a
 * preview is shown may be cut (a reply snapshot was once the first 100 characters), and the message it
 * was cut from hid it. So does a `||` right before it (`opener`, or -1), unless that is a spoiler's of
 * the list's own.
 */
function hiddenAt(index: number, opener: number, spoilers: readonly Span[], strays: readonly number[]): boolean {
    if (inside(spoilers, index) || (opener !== -1 && !inside(spoilers, opener))) return true;
    // How many come before it: the first at or after it, found by halves.
    let low = 0;
    let high = strays.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (strays[mid] < index) low = mid + 1;
        else high = mid;
    }
    return low % 2 === 1;
}

function segmentFor(hidden: boolean, bang: boolean, label: string | undefined, href: string): RefMatch['segment'] {
    if (/^sovereign-clip:/i.test(href)) return { type: 'clip', label: clipLabel(href) };
    // A label is the name the list draws, but one holding an address would print its key here.
    const cleaned = (label ?? '').replace(/sovereign-(?:enc|clip):\S*/gi, '').replace(/\s+/g, ' ').trim();
    const kind = kindOf(href, bang, cleaned);
    const name = cleaned || (kind === 'image' ? 'image' : label === undefined ? 'attachment' : kind);
    return { type: 'attachment', kind, name, spoiler: hidden };
}

/** Every ref in `content`, in any shape, each hidden where `spoilers` (the parse's) or a `||` left open says. */
function findRefs(content: string, spoilers: readonly Span[] = []): RefMatch[] {
    const out: RefMatch[] = [];
    const strays = strayBars(content, spoilers);
    for (const m of content.matchAll(REF_RE)) {
        let start = m.index;
        let raw = m[0];
        if (m[6] !== undefined) {
            out.push({ start, end: start + raw.length, raw, segment: segmentFor(hiddenAt(start, -1, spoilers, strays), false, undefined, m[6]) });
            continue;
        }
        let opened = m[1] !== undefined;
        // Bars of a spoiler of the list's are that spoiler's, not those of a file glued to them, unless
        // the spoiler is the file's alone. Taken as the file's, Quote copied `||the twist||![a](…)` as
        // `||the twist` and a chip, and `||![a](…) the butler did it||` as a chip and the words, open.
        const own = start + m[0].length;
        if (opened && spoilers.some(([from, to]) => to === start + 2 || (from === start && to !== own))) {
            opened = false;
            start += 2;
            raw = raw.slice(2);
        }
        // A closing `||` with no opening one belongs to a wider spoiler span
        // that started in the text before: leave it to that text.
        if (m[5] !== undefined && !opened) raw = raw.slice(0, -2);
        out.push({
            start,
            end: start + raw.length,
            raw,
            segment: segmentFor(hiddenAt(start + (opened ? 2 : 0), opened ? start : -1, spoilers, strays), m[2] === '!', m[3], m[4]),
        });
    }
    // Cut off before the scheme finished: `…![photo.png](sover`.
    const tailFrom = out.length ? out[out.length - 1].end : 0;
    const cut = CUT_LINK_RE.exec(content.slice(tailFrom));
    if (cut && cut[4].length > 0 && ('sovereign-enc:'.startsWith(cut[4].toLowerCase()) || 'sovereign-clip:'.startsWith(cut[4].toLowerCase()))) {
        const start = tailFrom + cut.index;
        const opened = cut[1] !== undefined;
        out.push({
            start,
            end: content.length,
            raw: cut[0],
            segment: segmentFor(hiddenAt(start + (opened ? 2 : 0), opened ? start : -1, spoilers, strays), cut[2] === '!', cut[3], 'sovereign-enc:'),
        });
    }
    return out;
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What a preview says where a spoiler's words would be. A spoilered file's own is "Spoiler image". */
export const SPOILER_LABEL = 'Spoiler';

/** The words a non-text segment stands for, where only text can go (Quote,
 *  search matching, an accessible name). A spoiler names its kind, not its file. */
export function segmentLabel(seg: Exclude<PreviewSegment, { type: 'text' }>): string {
    if (seg.type === 'spoiler') return SPOILER_LABEL;
    if (seg.type === 'clip') return seg.label;
    return seg.spoiler ? `Spoiler ${seg.kind}` : `${capitalize(seg.kind)}: ${seg.name}`;
}

/** What the visual chip prints next to its icon (the icon says the kind). */
export function segmentDisplayName(seg: Exclude<PreviewSegment, { type: 'text' }>): string {
    if (seg.type === 'spoiler') return SPOILER_LABEL;
    if (seg.type === 'clip') return seg.label;
    return seg.spoiler ? `Spoiler ${seg.kind}` : seg.name;
}

export interface PreviewOptions {
    /** `hide` (the default) puts a `spoiler` segment where a spoiler's words are. `keep`
     *  leaves them, bars and all, for the one place that copies a message as it is. */
    spoilers?: 'hide' | 'keep';
}

/** Stands for a spoiler's words while the rest is read: a private-use character that no one
 *  types, and any that is typed is replaced first. */
const COVER = '\uE000';
/** Stands for a file in a spoiler, in the same way: one for each, in the order typed, whose chip
 *  is made from what the parse drew (`Covered.files`), not read again out of the text. */
const HIDDEN_FILE = '\uE001';
/** An href the message list draws as a file or a clip, never as a link (components/MessageContent). */
const ENC_OR_CLIP = /^\s*sovereign-(?:enc|clip):/i;

type Spoiler = Extract<Node, { type: 'spoiler' }>;
type FileNode = Extract<Node, { type: 'image' | 'link' }>;

const isFile = (n: Node): n is FileNode => (n.type === 'image' || n.type === 'link') && ENC_OR_CLIP.test(n.href);

/** The chip for a file the parse drew, hidden or not. */
function fileSegment(n: FileNode, hidden: boolean): RefMatch['segment'] {
    return segmentFor(hidden, n.type === 'image', n.type === 'image' ? n.alt : n.label, n.href);
}

/**
 * What stands for a spoiler: one cover for its words, whatever they are. A file in it
 * keeps its own chip ("Spoiler image", its name hidden), which is what a spoilered file
 * has always been here: a HIDDEN_FILE for it, and its chip in `files`.
 */
function coverOf(children: Node[], files: PreviewSegment[]): string {
    let hidden = '';
    let words = false;
    const walk = (nodes: Node[]) => {
        for (const n of nodes) {
            if (isFile(n)) { hidden += (hidden ? ' ' : '') + HIDDEN_FILE; files.push(fileSegment(n, true)); }
            else if ('children' in n) walk(n.children);
            else if (n.type !== 'text' || n.value.trim() !== '') words = true;
        }
    };
    walk(children);
    return (words || !hidden ? COVER : '') + (words && hidden ? ' ' : '') + hidden;
}

/** The spoilers the message list would draw out of these nodes, in the order typed. One in
 *  another is covered with the one it is in. */
function spoilersIn(nodes: Node[], found: Spoiler[] = []): Spoiler[] {
    for (const n of nodes) {
        if (n.type === 'spoiler') found.push(n);
        else if ('children' in n) spoilersIn(n.children, found);
    }
    return found;
}

/** Whether two `||` are in the text: with fewer, nothing is a spoiler and nothing need be parsed for one. */
function mayHoldSpoiler(content: string): boolean {
    const bars = content.indexOf('||');
    return bars !== -1 && content.indexOf('||', bars + 2) !== -1;
}

/** Where each spoiler the message list draws was typed, the ones in others included. */
function spoilerSpansOf(content: string): Span[] {
    if (!mayHoldSpoiler(content)) return [];
    return spoilersIn(parseMessage(content)).map(s => spoilerSpan(s)).filter((s): s is Span => s !== undefined);
}

interface Covered {
    text: string;
    /** The chip for each HIDDEN_FILE in `text`, in order. */
    files: PreviewSegment[];
}

/**
 * The message with each spoiler's words replaced by COVER and each file in it by HIDDEN_FILE,
 * and nothing else touched: the parse says which `||` make a spoiler and where it was typed
 * (`spoilerSpan`), and only that part of the message as typed is replaced. Writing the tree back
 * out instead gave every other part the parse's words for it, not the sender's: the `_` that made
 * `my_file_name` an emphasis came back as `*`, and search then could not find the message by its
 * own words. Writing a file back out inside bars of its own for the ref matcher to find again let
 * that matcher pair the bars: `_||[_](…)||[w4](…)||` gave the bars of the spoiler around w4 to the
 * words before it, and the preview printed w4. Unchanged where the message draws no spoiler (`||`
 * in code, or one with no closer), as it is drawn.
 */
function coverSpoilers(content: string, typed: string): Covered {
    const files: PreviewSegment[] = [];
    if (!mayHoldSpoiler(content)) return { text: typed, files };
    const spoilers = spoilersIn(parseMessage(content));
    if (spoilers.length === 0) return { text: typed, files };
    let covered = '';
    let at = 0;
    for (const spoiler of spoilers) {
        const span = spoilerSpan(spoiler);
        // Every spoiler of a parse has one. If one did not, its words would go out: cover it all.
        if (!span) return { text: COVER, files: [] };
        // One in another is covered with the one it is in.
        if (span[1] <= at) continue;
        if (span[0] > at) covered += typed.slice(at, span[0]);
        covered += coverOf(spoiler.children, files);
        // Where every stretch between two `||` is a spoiler, one's closing bars open the next.
        at = Math.max(at, span[1]);
    }
    return { text: covered + typed.slice(at), files };
}

/**
 * The message as preview segments, optionally capped at `max` characters (a
 * label counts as its displayed name; a label is never cut in half — a cut
 * ends with `…`). Text is returned verbatim, newlines included, so Quote can
 * keep a multi-line message's lines. A spoiler's words are a `spoiler` segment
 * unless `spoilers: 'keep'`, and are covered before the cut, so a cut can never
 * land inside one.
 */
export function messagePreviewSegments(content: string, max?: number, options: PreviewOptions = {}): PreviewSegment[] {
    // What stands for a spoiler cannot be typed: one typed is another character, one for one, so where
    // each spoiler is stays where it is. Which they are is read off the message as the list reads it:
    // read off the copy, two words joined by what replaced them read otherwise.
    const typed = /[\uE000\uE001]/.test(content) ? content.replace(/[\uE000\uE001]/g, '\uFFFD') : content;
    // Quote keeps the bars and the words in them, so it reads the refs in the message as typed, each
    // hidden where the list hides it. Everywhere else a spoiler is covered first, the files in it with it.
    const keep = options.spoilers === 'keep';
    const covered: Covered = keep ? { text: typed, files: [] } : coverSpoilers(content, typed);
    const source = covered.text;
    const refs = findRefs(source, keep ? spoilerSpansOf(content) : []);
    const all: PreviewSegment[] = [];
    let hiddenFiles = 0;
    const pushText = (text: string) => {
        for (const piece of text.split(/([\uE000\uE001])/)) {
            if (piece === COVER) all.push({ type: 'spoiler' });
            else if (piece === HIDDEN_FILE) all.push(covered.files[hiddenFiles++] ?? { type: 'spoiler' });
            else if (piece) all.push({ type: 'text', text: piece });
        }
    };
    let at = 0;
    for (const r of refs) {
        if (r.start > at) pushText(source.slice(at, r.start));
        all.push(r.segment);
        at = r.end;
    }
    if (at < source.length) pushText(source.slice(at));
    if (max === undefined) return all;

    const out: PreviewSegment[] = [];
    let budget = max;
    for (const seg of all) {
        if (seg.type === 'text') {
            if (seg.text.length > budget) {
                out.push({ type: 'text', text: `${seg.text.slice(0, budget)}…` });
                return out;
            }
            out.push(seg);
            budget -= seg.text.length;
        } else {
            if (budget <= 0) {
                out.push({ type: 'text', text: '…' });
                return out;
            }
            out.push(seg);
            budget -= segmentDisplayName(seg).length;
        }
    }
    return out;
}

/** The preview as plain text: what Quote inserts, and what a notification toast says. */
export function messagePreviewText(content: string, max?: number, options: PreviewOptions = {}): string {
    return messagePreviewSegments(content, max, options)
        .map(s => (s.type === 'text' ? s.text : segmentLabel(s)))
        .join('');
}

/**
 * What search matches: the text plus each attachment's file NAME. Not the
 * labels the preview generates ("Image: ", "File: ", "Spoiler image", "Spoiler",
 * "Clip · 0:30") — matching those made "image" or "file" hit every attachment —
 * and not what a spoiler hides, a file's name or its words: a result that came
 * up for a word it then does not show would give that word away.
 */
export function messageSearchText(content: string): string {
    return messagePreviewSegments(content)
        .map(s => (s.type === 'text' ? s.text : s.type === 'attachment' && !s.spoiler ? ` ${s.name} ` : ' '))
        .join('');
}

/** A ref that leaves the edit box: what was typed from `start` to `end`, and whether the message hides it. */
interface Taken { start: number; end: number; hidden: boolean }

/** Every `sovereign-enc:` or `sovereign-clip:` address as typed, wherever it is, up to what ends one. */
const ADDRESS_RE = /sovereign-(?:enc|clip):[^\s)\]|\uE000\uE001]*/gi;

/**
 * The refs Edit takes out of the box, read off the parse the message list draws, and the spoilers
 * it draws that are in no other (`outer`): every file it draws, and every address it draws as words.
 * Not a pattern of its own: a ref it draws as code or as an address stays in the box as the text it
 * is, or saving would turn it into a live file; and one it draws as a file comes out, or its key is
 * in the box. `` `[g](sovereign-enc:…)``` `` is a backtick, a FILE and a fence never closed: a code
 * range read with a regex of its own saw a span of code and left the file, key and all, in the box.
 *
 * An address it draws as words (a bare `sovereign-enc:…` someone typed, or one in what looks like a
 * file and is drawn as words: `[](…)`, `[a](… )`, a label) comes out, its key is a key, as far as its
 * run of the words goes where something the list draws starts there; where markup does, it stays
 * whole, as it is drawn. A pattern of what an address holds took a backtick after it, and the code
 * that backtick opened was gone from the box (`` sovereign-enc:…`||` ||[f](…)|| `` saved its file in
 * the clear), or the `[docs` of a link; and a `_` in a key can close an emphasis, which taken out
 * pairs the bars after it otherwise.
 */
function refsToTake(content: string): { taken: Taken[]; outer: Span[] } {
    const spoilers: Span[] = [];
    const outer: Span[] = [];
    const drawn: Span[] = [];
    const words: Span[] = [];
    const taken: Taken[] = [];
    const walk = (nodes: Node[], hidden: boolean) => {
        for (const n of nodes) {
            if (n.type === 'spoiler') {
                const span = spoilerSpan(n);
                if (span) {
                    spoilers.push(span);
                    if (!hidden) outer.push(span);
                }
                walk(n.children, true);
            } else if ('children' in n) {
                walk(n.children, hidden);
            } else {
                const span = typedSpan(n);
                if (!span) continue;
                (n.type === 'text' ? words : drawn).push(span);
                if (isFile(n)) taken.push({ start: span[0], end: span[1], hidden });
            }
        }
    };
    walk(parseMessage(content), false);
    for (const m of content.matchAll(ADDRESS_RE)) {
        const start = m.index;
        const run = words.find(([from, to]) => start >= from && start < to);
        if (!run) continue;
        // Past the words, it runs on into what the list draws next (code, a link) or into markup.
        // Up to the next drawn thing is words, and goes; markup is not, and it all stays.
        let end = start + m[0].length;
        if (end > run[1]) {
            if (!drawn.some(([from]) => from === run[1])) continue;
            end = run[1];
        }
        taken.push({ start, end, hidden: inside(spoilers, start) });
    }
    return { taken: taken.sort((a, b) => a.start - b.start), outer };
}

/**
 * Text put together from pieces of the message, where some pieces had a ref cut out from between
 * them: across a cut the spaces either side become one, as the composer has them (`text ref ref`),
 * and a line break stays, and so does the space of a quote's `> `. Where two pieces meet that were
 * not beside each other (a cut, or a spoiler given bars of its own: `made`), a `|` against another
 * would make bars that pair otherwise, so a space keeps them apart. Pieces that were beside each
 * other are put back as typed.
 */
function joiner() {
    let text = '';
    let cut = false;
    let seam = false;
    return {
        add(piece: string, made = false) {
            if (!piece) return;
            if ((seam || made) && text.endsWith('|') && piece.startsWith('|')) piece = ` ${piece}`;
            if (cut && text) {
                const trimmed = text.replace(/[ \t]+$/, '');
                // The space after a quote's `>` is the quote's: `>||` begins no quote.
                const left = trimmed !== text && /(^|\n)>$/.test(trimmed) ? `${trimmed} ` : trimmed;
                const right = piece.replace(/^[ \t]+/, '');
                text = left + (left.endsWith('\n') || left.endsWith(' ') || right.startsWith('\n') || !left || !right ? '' : ' ') + right;
            } else {
                text += piece;
            }
            cut = false;
            seam = made;
        },
        cut() { cut = true; seam = true; },
        get text() { return text; },
    };
}

/**
 * Split a message for Edit: the text a person may change, and the attachment
 * refs (verbatim — key, capability, spoiler bars and all) that must ride
 * along untouched. The edit box used to be prefilled with the raw markdown,
 * which showed the key and let one stray keystroke break the attachment.
 *
 * Each spoiler the list draws keeps what is left of its words between bars of its own, and one left
 * with none goes, bars and all. Where every stretch between two `||` is a spoiler, one's closing bars
 * open the next: `my_file ||a.png|| b.png ||c.png||` left `my_file || || || ||` in the box when its
 * files went, the bars paired among themselves on a save, and the next stretch's words printed. A
 * `|` that would touch a spoiler's bars is kept apart.
 */
export function splitEditableContent(content: string): { text: string; refs: string[] } {
    const found = /sovereign-(?:enc|clip):/i.test(content) ? refsToTake(content) : null;
    if (!found || found.taken.length === 0) return { text: content, refs: [] };
    const { taken, outer } = found;
    const piecesOf = (into: ReturnType<typeof joiner>, from: number, to: number) => {
        let at = from;
        for (const r of taken) {
            if (r.start < from || r.start >= to) continue;
            into.add(content.slice(at, r.start));
            into.cut();
            at = r.end;
        }
        into.add(content.slice(at, to));
    };
    const text = joiner();
    let at = 0;
    for (const [from, to] of outer) {
        if (from > at) piecesOf(text, at, from);
        const start = Math.max(from + 2, at);
        // One nothing leaves is as it was typed, bars and all: where it shares its first with the one
        // before, as every stretch between two `||` does, each has bars of its own now.
        if (!taken.some(r => r.start >= from && r.start < to)) {
            text.add(content.slice(from, to));
            at = to;
            continue;
        }
        const words = joiner();
        piecesOf(words, start, to - 2);
        // Its words begin at its bars: a `||` with a space either side never holds a quote or a fence
        // after it (utils/messageParser chunkEnd), and the space the bars it shared left would be one.
        // A `|` they begin with is read as theirs (`|||x||` holds `|x`); one they end with would be
        // read as the bars', so a space keeps it off them, where no rule asks about a space.
        const said = words.text.replace(/^[ \t]+/, '');
        if (said.trim()) text.add(`||${said}${said.endsWith('|') ? ' ' : ''}||`, true);
        else text.cut();
        at = Math.max(at, to);
    }
    piecesOf(text, at, content.length);
    // A file that rendered hidden stays hidden: it leaves its spoiler when it leaves the text, so it
    // takes bars of its own. One that had a spoiler to itself has the same bars it had.
    const refs = taken.map(r => {
        const raw = content.slice(r.start, r.end);
        return r.hidden ? `||${raw}||` : raw;
    });
    return { text: text.text.trim(), refs };
}

/** The files the message list draws in `tree`, each with whether a spoiler hides it. */
function drawnFiles(tree: Node[]): Array<{ href: string; hidden: boolean }> {
    const out: Array<{ href: string; hidden: boolean }> = [];
    const walk = (nodes: Node[], hidden: boolean) => {
        for (const n of nodes) {
            if (isFile(n)) out.push({ href: n.href, hidden });
            else if ('children' in n) walk(n.children, hidden || n.type === 'spoiler');
        }
    };
    walk(tree, false);
    return out;
}

/**
 * Put an edited text back together with its refs, in the shape the composer
 * sends (`text ref ref`, see buildOutgoingContent), where that draws every file
 * again, and each that was hidden hidden. A `||` the words leave open takes the
 * first bars after it as its pair: `||![p0](…)||||` keeps the words `||`, and
 * with the file's bars after them p0 was drawn in the clear (6% of 23,000 random
 * messages with a file, tests/messagePreview.test.ts). There the files go first,
 * on a line of their own before they go on the same line: a quote begins at the
 * start of a line, and the files before it on that line made
 * `> recap||⏎> Snape dies|| ||` no quote, and printed the words its spoiler hid.
 */
export function joinEditedContent(text: string, refs: string[]): string {
    const t = text.trim();
    const atts = refs.join(' ');
    if (!atts) return t;
    if (!t) return atts;
    const files = refs.flatMap(ref => drawnFiles(parseMessage(ref)));
    const keeps = (joined: string) => {
        const drawn = drawnFiles(parseMessage(joined));
        return files.every(f => {
            const same = drawn.filter(d => d.href === f.href);
            return same.length > 0 && (!f.hidden || same.every(d => d.hidden));
        });
    };
    const shapes = [`${t} ${atts}`, `${atts}\n${t}`, `${atts} ${t}`, `${t}\n${atts}`];
    return shapes.find(keeps) ?? shapes[0];
}
