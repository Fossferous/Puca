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
 * each is): every other word of it is kept byte for byte.
 * Quote is the one that keeps them (`spoilers: 'keep'`): it copies into the
 * composer, where the bars are what makes the quote a spoiler too.
 *
 * Pure and React-free; components/MessagePreview.tsx renders the segments
 * with icons. Tests: tests/messagePreview.test.ts, tests/spoilerPreviews.test.ts.
 */
import { audioMimeFor, videoMimeFor } from './attachments';
import { decodeClipRef } from './clips/clipRef';
import { formatClock } from './clips/clipPresets';
import { parseMessage, spoilerSpan, type Node } from '../utils/messageParser';

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
 * name from inside a spoiler. The ref starts at ITS `[`, and what stands before it stays words.
 * `i` throughout: URL schemes are case-insensitive (isSafeUrl lowercases), and
 * a case-sensitive matcher once let `SOVEREIGN-ENC:` carry its key past a scrub.
 */
const REF_RE = /(\|\|)?(!?)\[([^[\]\n]*)\]\(\s*(sovereign-(?:enc|clip):[^)\s]*)\s*(?:\)(\|\|)?|$)|(sovereign-(?:enc|clip):[^\s)\]|]*)/gi;
/** A markdown link cut off before its scheme was even complete: `![a.png](sover`. */
const CUT_LINK_RE = /(\|\|)?(!?)\[([^[\]\n]*)\]\(\s*([a-z-]*)$/i;

interface RefMatch {
    start: number;
    end: number;
    /** The exact source text of the ref, spoiler bars included when consumed. */
    raw: string;
    segment: Exclude<PreviewSegment, { type: 'text' }>;
    /** Not cut off (closing paren present, or a bare ref) — only these are movable by Edit. */
    complete: boolean;
    /** `raw` starts with `||` but its closing bars were not its own: those
     *  opening bars begin a WIDER spoiler span that runs on past the ref. */
    opensWiderSpoiler: boolean;
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

/** Is the text before `index` inside an open `||spoiler||` span? */
function insideSpoiler(content: string, index: number): boolean {
    return ((content.slice(0, index).match(/\|\|/g) ?? []).length % 2) === 1;
}

function segmentFor(content: string, index: number, opened: boolean, bang: boolean, label: string | undefined, href: string): RefMatch['segment'] {
    if (/^sovereign-clip:/i.test(href)) return { type: 'clip', label: clipLabel(href) };
    const cleaned = (label ?? '').replace(/\s+/g, ' ').trim();
    const kind = kindOf(href, bang, cleaned);
    const name = cleaned || (kind === 'image' ? 'image' : label === undefined ? 'attachment' : kind);
    return { type: 'attachment', kind, name, spoiler: opened || insideSpoiler(content, index) };
}

function findRefs(content: string): RefMatch[] {
    const out: RefMatch[] = [];
    for (const m of content.matchAll(REF_RE)) {
        const start = m.index;
        let raw = m[0];
        if (m[6] !== undefined) {
            // A bare ref is whole by construction (it ends at whitespace), so
            // Edit moves it out of the box like any other: its key is a key.
            out.push({ start, end: start + raw.length, raw, segment: segmentFor(content, start, false, false, undefined, m[6]), complete: true, opensWiderSpoiler: false });
            continue;
        }
        const opened = m[1] !== undefined;
        const closedSpoiler = m[5] !== undefined;
        // A closing `||` with no opening one belongs to a wider spoiler span
        // that started in the text before: leave it to that text.
        if (closedSpoiler && !opened) raw = raw.slice(0, -2);
        const complete = /\)(\|\|)?$/.test(raw);
        out.push({
            start,
            end: start + raw.length,
            raw,
            segment: segmentFor(content, start, opened, m[2] === '!', m[3], m[4]),
            complete,
            opensWiderSpoiler: opened && !closedSpoiler,
        });
    }
    // Cut off before the scheme finished: `…![photo.png](sover`.
    const tailFrom = out.length ? out[out.length - 1].end : 0;
    const cut = CUT_LINK_RE.exec(content.slice(tailFrom));
    if (cut && cut[4].length > 0 && ('sovereign-enc:'.startsWith(cut[4].toLowerCase()) || 'sovereign-clip:'.startsWith(cut[4].toLowerCase()))) {
        const start = tailFrom + cut.index;
        out.push({
            start,
            end: content.length,
            raw: cut[0],
            segment: segmentFor(content, start, cut[1] !== undefined, cut[2] === '!', cut[3], 'sovereign-enc:'),
            complete: false,
            opensWiderSpoiler: false,
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
const ENC_OR_CLIP = /^\s*sovereign-(?:enc|clip):/i;

type Spoiler = Extract<Node, { type: 'spoiler' }>;

/**
 * A file's ref for the bars of its own it goes back inside. Its label is not read again for what
 * it says (a file in a spoiler is "Spoiler image", name hidden), only so the ref is found as one,
 * and the ref matcher takes no `[` in a label: the parser does (`||[a[](sovereign-enc:)||`, typed
 * by hand), and a label that did not match printed itself.
 */
function refOf(n: Extract<Node, { type: 'image' | 'link' }>): string {
    const label = (n.type === 'image' ? n.alt : n.label).replace(/\[/g, '_');
    return n.type === 'image' ? `![${label}](${n.href})` : `[${label}](${n.href})`;
}

/**
 * What stands for a spoiler: one cover for its words, whatever they are. A file in it
 * keeps its own chip ("Spoiler image", its name hidden), which is what a spoilered file
 * has always been here; its ref goes back inside bars of its own for that.
 */
function coverOf(children: Node[]): string {
    const refs: string[] = [];
    let words = false;
    const walk = (nodes: Node[]) => {
        for (const n of nodes) {
            if ((n.type === 'image' || n.type === 'link') && ENC_OR_CLIP.test(n.href)) refs.push(`||${refOf(n)}||`);
            else if ('children' in n) walk(n.children);
            else if (n.type !== 'text' || n.value.trim() !== '') words = true;
        }
    };
    walk(children);
    return (words || refs.length === 0 ? COVER : '') + (words && refs.length ? ' ' : '') + refs.join(' ');
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

/**
 * The message with each spoiler's words replaced by COVER, and nothing else touched: the parse
 * says which `||` make a spoiler and where it was typed (`spoilerSpan`), and only that part of
 * the message as typed is replaced. Writing the tree back out instead gave every other part
 * the parse's words for it, not the sender's: the `_` that made `my_file_name` an emphasis
 * came back as `*`, and search then could not find the message by its own words. Unchanged
 * where the message draws no spoiler (`||` in code, or one with no closer), as it is drawn.
 */
function coverSpoilers(content: string): string {
    const bars = content.indexOf('||');
    if (bars === -1 || content.indexOf('||', bars + 2) === -1) return content;
    const spoilers = spoilersIn(parseMessage(content));
    if (spoilers.length === 0) return content;
    let covered = '';
    let at = 0;
    for (const spoiler of spoilers) {
        const span = spoilerSpan(spoiler);
        // Every spoiler of a parse has one. If one did not, its words would go out: cover it all.
        if (!span) return COVER;
        if (span[0] > at) covered += content.slice(at, span[0]);
        covered += coverOf(spoiler.children);
        // Where every stretch between two `||` is a spoiler, one's closing bars open the next.
        at = Math.max(at, span[1]);
    }
    return covered + content.slice(at);
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
    const typed = content.includes(COVER) ? content.replaceAll(COVER, '\uFFFD') : content;
    const source = options.spoilers === 'keep' ? typed : coverSpoilers(typed);
    const refs = findRefs(source);
    const all: PreviewSegment[] = [];
    const pushText = (text: string) => {
        text.split(COVER).forEach((piece, i) => {
            if (i > 0) all.push({ type: 'spoiler' });
            if (piece) all.push({ type: 'text', text: piece });
        });
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

/** Where the message renders CODE (```fenced``` blocks and `inline` spans,
 *  as utils/messageParser reads them): a ref there is text, not a file. */
function codeRanges(content: string): Array<[number, number]> {
    return Array.from(content.matchAll(/```[\s\S]*?```|`[^`]+`/g), m => [m.index, m.index + m[0].length] as [number, number]);
}

/**
 * Split a message for Edit: the text a person may change, and the attachment
 * refs (verbatim — key, capability, spoiler bars and all) that must ride
 * along untouched. The edit box used to be prefilled with the raw markdown,
 * which showed the key and let one stray keystroke break the attachment.
 */
export function splitEditableContent(content: string): { text: string; refs: string[] } {
    // A ref inside a code span renders as code, not a file: it stays in the
    // box as the text it is, or saving would turn it into a live attachment.
    const code = codeRanges(content);
    const refs = findRefs(content)
        .filter(r => r.complete && !code.some(([a, b]) => r.start >= a && r.start < b))
        // Opening bars that begin a wider spoiler span stay with that span's
        // text (moving them out left "caption||" behind).
        .map(r => (r.opensWiderSpoiler ? { ...r, start: r.start + 2, raw: r.raw.slice(2) } : r));
    if (refs.length === 0) return { text: content, refs: [] };
    let text = '';
    let at = 0;
    const glue = (piece: string) => {
        if (!piece) return;
        if (!text) { text = piece; return; }
        const left = text.replace(/[ \t]+$/, '');
        const right = piece.replace(/^[ \t]+/, '');
        const joint = left.endsWith('\n') || right.startsWith('\n') || !left || !right ? '' : ' ';
        text = left + joint + right;
    };
    for (const r of refs) {
        glue(content.slice(at, r.start));
        at = r.end;
    }
    glue(content.slice(at));
    // A file that rendered hidden stays hidden: one whose spoiler was a wider
    // span (`||text <ref>||`) leaves that span when it leaves the text, so it
    // takes bars of its own. One with its own bars keeps them verbatim.
    const kept = refs.map(r => {
        const hidden = r.segment.type === 'attachment' && r.segment.spoiler;
        const own = /^\|\|[\s\S]*\|\|$/.test(r.raw);
        return hidden && !own ? `||${r.raw}||` : r.raw;
    });
    return { text: text.trim(), refs: kept };
}

/** Put an edited text back together with its refs, in the shape the composer
 *  sends (`text ref ref`, see buildOutgoingContent). */
export function joinEditedContent(text: string, refs: string[]): string {
    const t = text.trim();
    const atts = refs.join(' ');
    if (!atts) return t;
    return t ? `${t} ${atts}` : atts;
}
