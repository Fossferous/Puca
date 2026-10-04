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
 * Pure and React-free; components/MessagePreview.tsx renders the segments
 * with icons. Tests: tests/messagePreview.test.ts.
 */
import { audioMimeFor, videoMimeFor } from './attachments';
import { decodeClipRef } from './clips/clipRef';
import { formatClock } from './clips/clipPresets';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';
export type PreviewSegment =
    | { type: 'text'; text: string }
    | { type: 'attachment'; kind: AttachmentKind; name: string; spoiler: boolean }
    | { type: 'clip'; label: string };

/**
 * One attachment or clip reference, in any of the shapes a message can hold:
 *   1-5  `||`? `!`? `[label](` scheme-href ( `)` `||`? | END-OF-TEXT )
 *        — the markdown form, spoiler-wrapped or not, complete or cut off;
 *   6    a bare `sovereign-enc:` / `sovereign-clip:` href someone typed.
 * `i` throughout: URL schemes are case-insensitive (isSafeUrl lowercases), and
 * a case-sensitive matcher once let `SOVEREIGN-ENC:` carry its key past a scrub.
 */
const REF_RE = /(\|\|)?(!?)\[([^\]\n]*)\]\(\s*(sovereign-(?:enc|clip):[^)\s]*)\s*(?:\)(\|\|)?|$)|(sovereign-(?:enc|clip):[^\s)\]|]*)/gi;
/** A markdown link cut off before its scheme was even complete: `![a.png](sover`. */
const CUT_LINK_RE = /(\|\|)?(!?)\[([^\]\n]*)\]\(\s*([a-z-]*)$/i;

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

/** The words a non-text segment stands for, where only text can go (Quote,
 *  search matching, an accessible name). A spoiler names its kind, not its file. */
export function segmentLabel(seg: Exclude<PreviewSegment, { type: 'text' }>): string {
    if (seg.type === 'clip') return seg.label;
    return seg.spoiler ? `Spoiler ${seg.kind}` : `${capitalize(seg.kind)}: ${seg.name}`;
}

/** What the visual chip prints next to its icon (the icon says the kind). */
export function segmentDisplayName(seg: Exclude<PreviewSegment, { type: 'text' }>): string {
    if (seg.type === 'clip') return seg.label;
    return seg.spoiler ? `Spoiler ${seg.kind}` : seg.name;
}

/**
 * The message as preview segments, optionally capped at `max` characters (a
 * label counts as its displayed name; a label is never cut in half — a cut
 * ends with `…`). Text is returned verbatim, newlines included, so Quote can
 * keep a multi-line message's lines.
 */
export function messagePreviewSegments(content: string, max?: number): PreviewSegment[] {
    const refs = findRefs(content);
    const all: PreviewSegment[] = [];
    let at = 0;
    for (const r of refs) {
        if (r.start > at) all.push({ type: 'text', text: content.slice(at, r.start) });
        all.push(r.segment);
        at = r.end;
    }
    if (at < content.length) all.push({ type: 'text', text: content.slice(at) });
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

/** The preview as plain text: what Quote inserts. */
export function messagePreviewText(content: string, max?: number): string {
    return messagePreviewSegments(content, max)
        .map(s => (s.type === 'text' ? s.text : segmentLabel(s)))
        .join('');
}

/**
 * What search matches: the text plus each attachment's file NAME. Not the
 * labels the preview generates ("Image: ", "File: ", "Spoiler image", "Clip ·
 * 0:30") — matching those made "image" or "file" hit every attachment — and
 * not a spoilered file's name, which the spoiler exists to hide.
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
