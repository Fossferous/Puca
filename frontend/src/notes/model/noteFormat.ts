/**
 * Formatting in a note's text: bold, italic, underline, strikethrough and
 * bulleted lines — what Windows Sticky Notes' Ctrl+B, Ctrl+I, Ctrl+U,
 * Ctrl+T and Ctrl+Shift+L do (docs/STICKY_NOTES.md).
 *
 * STORED AS MARKS IN THE TEXT, not beside it. The note's text stays the one
 * sealed string it always was (api/listContent.ts), so nothing changes on the
 * server, search and export read the same words, and an older Púca or Notes
 * shows the marks as typed characters rather than losing anything. The marks
 * are a subset of GitHub-flavoured Markdown, so a note exported as Markdown
 * renders the same in any Markdown viewer:
 *
 *   **bold**   *italic*   <u>underline</u>   ~~strikethrough~~   - a bullet
 *
 * NOT CHAT'S MARKDOWN. utils/linkSegments.ts records why a note's text is not
 * run through the chat parser: `__file__` would become underline and
 * `||x||` a spoiler, which is not what was typed. Underline is therefore
 * `<u>…</u>` here, never `__…__`, and a mark only counts where it cannot be
 * part of ordinary writing: it opens at the start of a word and closes at the
 * end of one, on one line, around something that does not start or end with
 * a space. So `2*3*4`, `a**b`, `snake_case`, `__init__`, `C++` and a `* item`
 * list stay exactly as typed. Web addresses are found first (linkSegments'
 * own rule) and nothing inside one is ever read as a mark.
 *
 * Pure: no React, no DOM. Tested in src/tests/noteFormat.test.ts.
 */
import { urlAt } from '../../utils/messageParser';
import { linkSegments } from '../../utils/linkSegments';

export interface Marks {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
}

export type FmtRun =
    | { kind: 'text'; text: string; from: number; marks: Marks }
    | { kind: 'link'; text: string; href: string; from: number; marks: Marks };

export interface FmtLine {
    /** Where the line starts in the text. */
    from: number;
    /** `- `, `* ` or `• ` at the start (after any indent). */
    bullet: { at: number; indent: string } | null;
    runs: FmtRun[];
}

const NONE: Marks = { bold: false, italic: false, underline: false, strike: false };

type MarkKind = keyof Marks;

interface Delim {
    open: string;
    close: string;
    adds: MarkKind[];
    /** `<u>` is unambiguous on its own; the others need word edges. */
    flanked: boolean;
}

// Longest first, so `***` wins over `**` and `**` over `*`.
const DELIMS: Delim[] = [
    { open: '***', close: '***', adds: ['bold', 'italic'], flanked: true },
    { open: '**', close: '**', adds: ['bold'], flanked: true },
    { open: '~~', close: '~~', adds: ['strike'], flanked: true },
    { open: '<u>', close: '</u>', adds: ['underline'], flanked: false },
    { open: '*', close: '*', adds: ['italic'], flanked: true },
];

const MAX_DEPTH = 6;
const BULLET_RE = /^([ \t]*)([-*•]) (?=\S)/;
// Letters, numbers and the marks that combine with them (an accent typed
// as its own character, a Devanagari vowel sign): one word, never two.
// A variation selector is not one: it belongs to the emoji before it (a
// heart, then U+FE0F), so a mark may open straight after an emoji.
const WORDISH = /(?![\uFE00-\uFE0F\u20D0-\u20FF])[\p{L}\p{N}\p{M}]/u;
/** What makes a character before it an emoji (a variation selector, a
 *  keycap, a joiner): it goes with that character, never apart from it. */
const EMOJI_TAIL = /[\uFE0E\uFE0F\u20D0-\u20FF\u200D]/;
const SPACE = /\s/;

function isWordish(ch: string | undefined): boolean {
    return ch !== undefined && WORDISH.test(ch);
}

/** A run of the same mark character continues past `at` (`***` is not `**`+`*`). */
function sameRun(line: string, at: number, d: Delim): boolean {
    const ch = d.open[0];
    return d.flanked && (line[at - 1] === ch || line[at + d.open.length] === ch);
}

function canOpen(line: string, at: number, d: Delim): boolean {
    if (!line.startsWith(d.open, at)) return false;
    const next = line[at + d.open.length];
    if (next === undefined || SPACE.test(next)) return false;
    if (!d.flanked) return true;
    if (sameRun(line, at, d)) return false;
    return !isWordish(line[at - 1]);
}

function canClose(line: string, at: number, d: Delim, openEnd: number): boolean {
    if (at <= openEnd || !line.startsWith(d.close, at)) return false;
    const prev = line[at - 1];
    if (prev === undefined || SPACE.test(prev)) return false;
    if (!d.flanked) return true;
    if (sameRun(line, at, d)) return false;
    return !isWordish(line[at + d.close.length]);
}

/**
 * Where every web address on the line starts and ends: no mark inside one.
 * The addresses are linkSegments' own (utils/linkSegments.ts, what Notes'
 * plain link text and `hasLink` use), so the formatted view links exactly
 * what the plain one does — with one difference: an address never ENDS in
 * `*` or `~` here, so an address in `**` is a bold link rather than a link
 * whose last characters are `**`. What is left once those are off its end is
 * read again, so the punctuation that ended a marked sentence comes off
 * with them (urlAt, shared with chat).
 */
function linkSpans(line: string): Array<{ from: number; to: number; href: string }> {
    const spans: Array<{ from: number; to: number; href: string }> = [];
    let at = 0;
    for (const seg of linkSegments(line)) {
        if (seg.kind === 'text') { at += seg.value.length; continue; }
        const stripped = seg.href.replace(/[*~]+$/, '');
        const href = stripped === seg.href ? seg.href : urlAt(stripped);
        if (href) spans.push({ from: at, to: at + href.length, href });
        at += seg.text.length;
    }
    return spans;
}

function inLink(spans: ReadonlyArray<{ from: number; to: number }>, at: number): { from: number; to: number } | undefined {
    return spans.find(s => at >= s.from && at < s.to);
}

/** The closer for an opener at `at`, or -1. Never inside an address. */
function findClose(line: string, d: Delim, at: number, end: number, links: ReadonlyArray<{ from: number; to: number }>): number {
    const openEnd = at + d.open.length;
    for (let j = openEnd + 1; j + d.close.length <= end; j++) {
        const l = inLink(links, j);
        if (l) { j = l.to - 1; continue; }
        if (canClose(line, j, d, openEnd)) return j;
    }
    return -1;
}

/** A pair of marks as written: where each sits on its line. */
interface MarkSpan {
    delim: Delim;
    open: number;
    close: number;
}

function readInline(
    line: string, start: number, end: number, base: number, marks: Marks,
    links: ReadonlyArray<{ from: number; to: number; href: string }>, depth: number, out: FmtRun[],
    spans?: MarkSpan[],
): void {
    // A kind of mark that found no closer from some opener finds none from a
    // later one either (a closer's rules do not depend on where its opener
    // was), so it is not looked for again in this stretch. Without this a
    // long line of unclosed `*` was quadratic — and this runs per keystroke.
    const noCloser = new Map<Delim, number>();
    let text = '';
    let textFrom = start;
    const flush = (at: number) => {
        if (text) out.push({ kind: 'text', text, from: base + textFrom, marks });
        text = '';
        textFrom = at;
    };
    let i = start;
    while (i < end) {
        const link = links.find(s => s.from === i && s.to <= end);
        if (link) {
            flush(i);
            out.push({ kind: 'link', text: line.slice(link.from, link.to), href: link.href, from: base + link.from, marks });
            i = link.to;
            textFrom = i;
            continue;
        }
        let matched = false;
        if (depth < MAX_DEPTH) {
            for (const d of DELIMS) {
                if (!canOpen(line, i, d)) continue;
                const failedFrom = noCloser.get(d);
                if (failedFrom !== undefined && i >= failedFrom) continue;
                const close = findClose(line, d, i, end, links);
                if (close < 0) { noCloser.set(d, i); continue; }
                flush(i);
                const inner: Marks = { ...marks };
                for (const k of d.adds) inner[k] = true;
                spans?.push({ delim: d, open: i, close });
                readInline(line, i + d.open.length, close, base, inner, links, depth + 1, out, spans);
                i = close + d.close.length;
                textFrom = i;
                matched = true;
                break;
            }
        }
        if (matched) continue;
        text += line[i];
        i++;
    }
    flush(end);
}

/** The text, line by line, as runs of words with their marks. */
export function readNoteFormat(text: string): FmtLine[] {
    const lines: FmtLine[] = [];
    let from = 0;
    for (const line of text.split('\n')) {
        const m = BULLET_RE.exec(line);
        const bullet = m ? { at: from + m[1].length, indent: m[1] } : null;
        const bodyStart = m ? m[0].length : 0;
        const runs: FmtRun[] = [];
        readInline(line, bodyStart, line.length, from, NONE, linkSpans(line), 0, runs);
        lines.push({ from, bullet, runs });
        from += line.length + 1;
    }
    return lines;
}

/** True when the text has anything a plain field would show differently. */
export function hasNoteFormatting(text: string): boolean {
    if (!text) return false;
    // Cheap reject: none of the characters a mark or a bullet needs.
    if (!/[*~<•-]/.test(text)) return false;
    return readNoteFormat(text).some(l => l.bullet !== null
        || l.runs.some(r => r.marks.bold || r.marks.italic || r.marks.underline || r.marks.strike));
}

/** The words with every mark taken off: what a reader of the note sees. */
export function plainNoteText(text: string): string {
    return readNoteFormat(text).map(l => (l.bullet ? `${l.bullet.indent}• ` : '') + l.runs.map(r => r.text).join('')).join('\n');
}

// --- Editing --------------------------------------------------------------------

export type FormatKind = MarkKind;

export interface TextEdit {
    text: string;
    selStart: number;
    selEnd: number;
}

const WRAP: Record<FormatKind, { open: string; close: string }> = {
    bold: { open: '**', close: '**' },
    italic: { open: '*', close: '*' },
    underline: { open: '<u>', close: '</u>' },
    strike: { open: '~~', close: '~~' },
};

/** Which marks the run at offset `at` carries (the caret's, for a toolbar). */
export function marksAt(text: string, at: number): Marks {
    for (const line of readNoteFormat(text)) {
        for (const r of line.runs) {
            if (at >= r.from && at <= r.from + r.text.length && r.text.length > 0) return r.marks;
        }
    }
    return NONE;
}

/** Every pair of marks on one line, as written. */
function spansOf(line: string): MarkSpan[] {
    const m = BULLET_RE.exec(line);
    const spans: MarkSpan[] = [];
    readInline(line, m ? m[0].length : 0, line.length, 0, NONE, linkSpans(line), 0, [], spans);
    return spans;
}

/** What is left of a pair once `kind` is taken out of it (`***` less italic is `**`). */
function without(d: Delim, kind: FormatKind): { open: string; close: string } {
    if (d.open === '***') return kind === 'bold' ? { open: '*', close: '*' } : { open: '**', close: '**' };
    return { open: '', close: '' };
}

/** A character of a line as it reads: where it is typed, its marks, and
 *  which address it belongs to (-1: none). The marks themselves are not
 *  characters here. */
interface PlainChar {
    ch: string;
    src: number;
    marks: Marks;
    link: number;
}

interface LineModel {
    /** The bullet as typed (`- `, `  * `), or ''. */
    prefix: string;
    chars: PlainChar[];
}

function lineModel(line: string): LineModel {
    const [l] = readNoteFormat(line);
    const m = l.bullet ? BULLET_RE.exec(line) : null;
    const chars: PlainChar[] = [];
    let link = 0;
    for (const r of l.runs) {
        const id = r.kind === 'link' ? link++ : -1;
        for (let k = 0; k < r.text.length; k++) chars.push({ ch: r.text[k], src: r.from + k, marks: r.marks, link: id });
    }
    return { prefix: m ? m[0] : '', chars };
}

const sameMarks = (a: Marks, b: Marks) =>
    a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike;
const anyMark = (m: Marks) => m.bold || m.italic || m.underline || m.strike;

/**
 * The line written out from its characters, every run of equal marks in one
 * canonical form: strikethrough outermost, then underline, then bold and
 * italic (`***` for both), with spaces at a run's ends left outside its marks
 * so every pair sits at word edges.
 */
function serialize(prefix: string, chars: ReadonlyArray<{ ch: string; marks: Marks; link: number }>): string {
    let out = prefix;
    let i = 0;
    while (i < chars.length) {
        let j = i + 1;
        while (j < chars.length && sameMarks(chars[j].marks, chars[i].marks)) j++;
        const seg = chars.slice(i, j).map(c => c.ch).join('');
        const m = chars[i].marks;
        const lead = /^\s*/.exec(seg)![0];
        const core = seg.slice(lead.length).replace(/\s+$/, '');
        if (!anyMark(m) || !core) {
            out += seg;
        } else {
            const trail = seg.slice(lead.length + core.length);
            const bi = m.bold && m.italic ? '***' : m.bold ? '**' : m.italic ? '*' : '';
            const open = (m.strike ? '~~' : '') + (m.underline ? '<u>' : '') + bi;
            const close = bi + (m.underline ? '</u>' : '') + (m.strike ? '~~' : '');
            out += lead + open + core + close + trail;
        }
        i = j;
    }
    return out;
}

/** `line` reads as exactly `prefix` and `want`: the same characters, each
 *  with the marks it should have (a space's marks do not matter). */
function readsAs(line: string, prefix: string, want: ReadonlyArray<{ ch: string; marks: Marks; link: number }>): boolean {
    const got = lineModel(line);
    if (got.prefix !== prefix || got.chars.length !== want.length) return false;
    // The same characters, each with its marks — and each still in an
    // address, or still not: a mark that unlinks an address is not formatting.
    return got.chars.every((c, i) => c.ch === want[i].ch && (c.link >= 0) === (want[i].link >= 0)
        && (SPACE.test(c.ch) || sameMarks(c.marks, want[i].marks)));
}

/** A line as one string of characters: a bullet's marker (no marks, no
 *  address) and then its words. A bare `- ` that turns into a bullet once
 *  something follows it reads the same either way. */
function lineChars(line: string): PlainChar[] {
    const m = lineModel(line);
    const pre: PlainChar[] = m.prefix.split('').map((ch, i) => ({ ch, src: i, marks: NONE, link: -1 }));
    return [...pre, ...m.chars];
}

/** A mark character read one way from `at` — leftward (`back`) or onward —
 *  and how long it is: `*`, `~`, `<u>` (before the caret) or `</u>` (after
 *  it); 0 for none. */
function markToken(line: string, at: number, back: boolean): string {
    if (back) {
        const ch = line[at - 1];
        if (ch === '*' || ch === '~') return ch;
        return line.slice(at - 3, at) === '<u>' ? '<u>' : '';
    }
    const ch = line[at];
    if (ch === '*' || ch === '~') return ch;
    return line.startsWith('</u>', at) ? '</u>' : '';
}

/**
 * [from, to): the empty pairs around `at`, as far as they mirror each other
 * — a `*` before the caret with a `*` after it, a `<u>` with a `</u>` — so
 * the marks a key put in, nested or not (`**<u>|</u>**`), and nothing a
 * person typed: of a line of stars only as many as stand on both sides of the
 * caret count, and the rest are characters like any other.
 */
function markRun(line: string, at: number): [number, number] {
    let a = at;
    let b = at;
    let outL = '';
    let outR = '';
    for (;;) {
        const l = markToken(line, a, true);
        const r = markToken(line, b, false);
        if (!l || !r || (l === '<u>' ? r !== '</u>' : r !== l)) break;
        a -= l.length;
        b += r.length;
        outL = l;
        outR = r;
    }
    // The same mark character still beside them that READS as a character
    // (a line of stars somebody typed) means these are that run's, not pairs
    // a key put in: none of it counts then. A real mark beside them (the
    // closer of the bold word the caret is at the end of) is no such thing,
    // and nor is a typed character of another kind (`*<u>|</u>~`).
    const left = markToken(line, a, true);
    const right = markToken(line, b, false);
    if ((left && left === outL) || (right && right === outR)) {
        const read = new Set(lineModel(line).chars.map(c => c.src));
        if ((left === outL && read.has(a - 1)) || (right === outR && read.has(b))) return [at, at];
    }
    return [a, b];
}

/**
 * Typing a letter at `at` in `base`, between `open` and `close`, gives a
 * letter whose `kind` is `want`; the empty pairs around it are all used up as
 * marks, none left showing as characters; and every character of `orig`
 * outside the empty pairs around its caret (`origAt`) still reads as it does.
 */
function typingReads(orig: string, origAt: number, base: string, at: number, open: string, close: string, kind: FormatKind, want: boolean): boolean {
    const sim = base.slice(0, at) + open + 'x' + close + base.slice(at);
    const xAt = at + open.length;
    const [oa, ob] = markRun(orig, origAt);
    const before = lineChars(orig).filter(c => c.src < oa || c.src >= ob);
    const after = lineChars(sim);
    const x = after.find(c => c.src === xAt);
    if (!x || x.ch !== 'x' || x.marks[kind] !== want) return false;
    // The pairs around the letter, mirrored: [sa, xAt) and (xAt, sb).
    const simNoX = sim.slice(0, xAt) + sim.slice(xAt + 1);
    const [ra, rb] = markRun(simNoX, xAt);
    const sa = ra;
    const sb = rb + 1;
    // Nothing in them reads as a character but the letter.
    if (after.some(c => c.src >= sa && c.src < sb && c.src !== xAt)) return false;
    const rest = after.filter(c => c.src < sa || c.src >= sb);
    return rest.length === before.length && rest.every((c, i) => c.ch === before[i].ch
        && (c.link >= 0) === (before[i].link >= 0) && (SPACE.test(c.ch) || sameMarks(c.marks, before[i].marks)));
}

/** Word characters for the keys' edges: the reader's own (a variation
 *  selector is none, so a mark never splits it from its emoji). */
function wordChar(ch: string | undefined): boolean {
    return isWordish(ch);
}

const isHigh = (ch: string | undefined) => ch !== undefined && ch >= '\uD800' && ch <= '\uDBFF';
const isLow = (ch: string | undefined) => ch !== undefined && ch >= '\uDC00' && ch <= '\uDFFF';

/** `at` moved forward off the inside of a character: the second half of a
 *  surrogate pair, or the selector, keycap or joiner of an emoji. A mark put
 *  there would split what reads as one character. */
function snapForward(line: string, at: number): number {
    for (;;) {
        if (at < line.length && (isLow(line[at]) || EMOJI_TAIL.test(line[at]))) { at++; continue; }
        // Just after a joiner: the character it joins on is part of the same.
        if (at > 0 && at < line.length && line[at - 1] === '\u200D') { at += isHigh(line[at]) ? 2 : 1; continue; }
        return at;
    }
}

/** Plain index of source offset `at`: the characters typed before it. */
function plainAt(chars: readonly PlainChar[], at: number): number {
    let n = 0;
    while (n < chars.length && chars[n].src < at) n++;
    return n;
}

/** Widen [p0, p1) to word edges and whole addresses (a mark never goes
 *  inside a word, where it would not read, nor inside an address, where it
 *  would change where the link goes). */
function widen(chars: readonly PlainChar[], p0: number, p1: number): [number, number] {
    // Whole characters: never half of a surrogate pair, never an emoji apart
    // from its selector, keycap or joined partner — until nothing moves.
    for (let moved = true; moved;) {
        moved = false;
        if (p0 > 0 && (isLow(chars[p0]?.ch) || EMOJI_TAIL.test(chars[p0]?.ch ?? '') || chars[p0 - 1].ch === '\u200D')) { p0--; moved = true; }
        if (p1 < chars.length && (isHigh(chars[p1 - 1]?.ch) || EMOJI_TAIL.test(chars[p1].ch) || chars[p1 - 1]?.ch === '\u200D')) { p1++; moved = true; }
    }
    while (p0 > 0 && wordChar(chars[p0 - 1].ch) && wordChar(chars[p0]?.ch)) p0--;
    while (p1 < chars.length && wordChar(chars[p1].ch) && wordChar(chars[p1 - 1]?.ch)) p1++;
    // Never between an emoji and its selector or keycap.
    while (p1 < chars.length && EMOJI_TAIL.test(chars[p1].ch)) p1++;
    while (p0 > 0 && EMOJI_TAIL.test(chars[p0].ch)) p0--;
    for (let changed = true; changed;) {
        changed = false;
        if (p0 > 0 && chars[p0].link >= 0 && chars[p0 - 1].link === chars[p0].link) { p0--; changed = true; }
        if (p1 < chars.length && p1 > 0 && chars[p1 - 1].link >= 0 && chars[p1].link === chars[p1 - 1].link) { p1++; changed = true; }
    }
    return [p0, p1];
}

/** What one line of a Ctrl+B / I / U / T asks for: the characters to mark,
 *  or an empty pair at the caret (`pair`), or nothing. */
type LinePlan =
    | { kind: 'range'; model: LineModel; p0: number; p1: number; caret: number | null }
    | { kind: 'pair'; at: number }
    | { kind: 'none' };

function planLine(line: string, s: number, e: number, caretMode: boolean): LinePlan {
    if (caretMode) { s = snapForward(line, s); e = s; }
    const model = lineModel(line);
    const chars = model.chars;
    if (caretMode) {
        // The word the caret is on, or touches — a marked one included,
        // whose marks are not characters (`**hello**|` is at "hello").
        const p = plainAt(chars, s);
        let p0 = p;
        let p1 = p;
        if (wordChar(chars[p - 1]?.ch) || wordChar(chars[p]?.ch)) {
            while (p0 > 0 && wordChar(chars[p0 - 1].ch)) p0--;
            while (p1 < chars.length && wordChar(chars[p1].ch)) p1++;
            // `1` then a selector and a keycap is the keycap emoji, whole.
            while (p1 < chars.length && EMOJI_TAIL.test(chars[p1].ch)) p1++;
        } else if ((chars[p]?.link ?? -1) >= 0 || (chars[p - 1]?.link ?? -1) >= 0) {
            p0 = p1 = (chars[p]?.link ?? -1) >= 0 ? p : p - 1;
            p1++;
        }
        if (p0 === p1) return { kind: 'pair', at: s };
        [p0, p1] = widen(chars, p0, p1);
        return { kind: 'range', model, p0, p1, caret: p };
    }
    let p0 = plainAt(chars, s);
    let p1 = plainAt(chars, e);
    while (p0 < p1 && SPACE.test(chars[p0].ch)) p0++;
    while (p1 > p0 && SPACE.test(chars[p1 - 1].ch)) p1--;
    if (p0 === p1) return { kind: 'none' };
    [p0, p1] = widen(chars, p0, p1);
    return { kind: 'range', model, p0, p1, caret: null };
}

/** Does every character the plan covers (spaces aside) carry `kind`? */
function planHas(plan: LinePlan, kind: FormatKind): boolean {
    if (plan.kind !== 'range') return true;
    return plan.model.chars.slice(plan.p0, plan.p1).every(c => SPACE.test(c.ch) || c.marks[kind]);
}

/** The line with the plan applied, `add`ing or taking off `kind`, and where
 *  the selection goes; the line unchanged when no edit reads back right. */
function applyLine(line: string, plan: LinePlan, kind: FormatKind, add: boolean, s: number, e: number): { line: string; s: number; e: number } {
    const { open, close } = WRAP[kind];
    if (plan.kind === 'none') return { line, s, e };
    if (plan.kind === 'pair') {
        // Off any word, with nothing selected. An empty pair reads as typed
        // characters until something is typed between its halves, so it is
        // judged by what typing there WOULD give: a letter that has the mark
        // (put in) or has not (taken out), and every other character of the
        // line reading as it does now.
        const at = plan.at;
        // Pressed again with nothing typed between: the pair comes out —
        // also one held around another kind's pair (`**<u>|</u>**` and
        // Ctrl+B leaves `<u>|</u>`). The nearest such pair to the caret that
        // typing then reads right with.
        const [ra, rb] = markRun(line, at);
        const pairs: Array<[number, number]> = [];
        for (let i = at - open.length; i >= Math.max(ra, at - 16); i--) {
            if (!line.startsWith(open, i)) continue;
            for (let j = at; j + close.length <= Math.min(rb, at + 16); j++) {
                if (line.startsWith(close, j)) pairs.push([i, j]);
            }
        }
        pairs.sort((x, y) => (at - x[0]) + (x[1] - at) - ((at - y[0]) + (y[1] - at)));
        for (const [i, j] of pairs) {
            const out = line.slice(0, i) + line.slice(i + open.length, j) + line.slice(j + close.length);
            const caretOut = at - open.length;
            if (typingReads(line, at, out, caretOut, '', '', kind, false)) return { line: out, s: caretOut, e: caretOut };
        }
        // Put in, after a bullet's marker and never in front of it.
        const into = Math.max(at, lineModel(line).prefix.length);
        if (typingReads(line, at, line, into, open, close, kind, true)) {
            const out = line.slice(0, into) + open + close + line.slice(into);
            return { line: out, s: into + open.length, e: into + open.length };
        }
        return { line, s, e };
    }
    const { model, p0, p1, caret } = plan;
    const want = model.chars.map((c, i) => (i >= p0 && i < p1 && !SPACE.test(c.ch) ? { ...c, marks: { ...c.marks, [kind]: add } } : c));
    const tries: string[] = [];
    // The smallest edit first: the pair put around the words, or the pair
    // they are in taken off. Kept only if it reads exactly as wanted.
    if (add) {
        const from = model.chars[p0].src;
        const to = model.chars[p1 - 1].src + 1;
        tries.push(line.slice(0, from) + open + line.slice(from, to) + close + line.slice(to));
    } else {
        const a = model.chars[p0].src;
        const b = model.chars[p1 - 1].src + 1;
        const holding = spansOf(line)
            .filter(sp => sp.delim.adds.includes(kind) && a >= sp.open && b <= sp.close + sp.delim.close.length)
            .sort((x, y) => (x.close - x.open) - (y.close - y.open))[0];
        if (holding) {
            const d = holding.delim;
            const keep = without(d, kind);
            tries.push(line.slice(0, holding.open) + keep.open + line.slice(holding.open + d.open.length, holding.close) + keep.close
                + line.slice(holding.close + d.close.length));
        }
    }
    // Otherwise the line written out afresh from what each character should
    // carry: a word in a bold phrase made italic splits the phrase rather
    // than gluing `*` to `**`, which would read as nothing at all.
    tries.push(serialize(model.prefix, want));
    const out = tries.find(t => readsAs(t, model.prefix, want));
    // Nothing that reads right: leave the words as they are rather than
    // write marks that would show as stray characters.
    if (out === undefined) return { line, s, e };
    const after = lineModel(out).chars;
    const startOf = (i: number) => (i < after.length ? after[i].src : out.length);
    const endOf = (i: number) => (i > 0 ? after[i - 1].src + 1 : startOf(0));
    if (caret !== null) {
        // The caret stays on its letter; at the end of the word, inside its
        // marks, so what is typed next carries on the word as it now is.
        const at = caret === p1 ? endOf(caret) : startOf(caret);
        return { line: out, s: at, e: at };
    }
    return { line: out, s: startOf(p0), e: endOf(p1) };
}

/**
 * Ctrl+B / I / U / T: put the mark on the selected words, or take it off
 * when they all have it already (decided once, across every line the
 * selection holds words of). A mark only counts at word edges, so the edit
 * goes there: a selection inside a word takes the whole word, an address is
 * taken whole, and with nothing selected it is the word the caret is on.
 * Off any word, an empty pair goes in for what is typed next, and a second
 * press takes it out.
 *
 * Every edit is checked by READING it back (readNoteFormat): the smallest
 * one that reads as intended, else the line written out afresh in one
 * canonical form, else no change at all — never marks that show as stray
 * characters. A mark never spans a line. The selection comes back around
 * the same words.
 */
export function toggleMark(text: string, selStart: number, selEnd: number, kind: FormatKind): TextEdit {
    const a = Math.max(0, Math.min(selStart, selEnd, text.length));
    const b = Math.min(text.length, Math.max(selStart, selEnd));
    const lines = text.split('\n');
    const caretMode = a === b;
    const starts: number[] = [];
    let from = 0;
    for (const line of lines) { starts.push(from); from += line.length + 1; }
    const plans = lines.map((line, i) => {
        const lf = starts[i];
        const to = lf + line.length;
        const s = Math.max(a, lf) - lf;
        const e = Math.min(b, to) - lf;
        // A line is touched when the selection holds some of its words: not
        // the line a selection merely starts at the end of, or ends at the
        // start of.
        const touches = caretMode ? a >= lf && a <= to : s < e && line.slice(s, e).trim() !== '';
        return touches ? { plan: planLine(line, s, e, caretMode), s, e } : null;
    });
    const add = !plans.every(p => p === null || planHas(p.plan, kind));
    let newStart = a;
    let newEnd = b;
    let delta = 0;
    const out = lines.map((line, i) => {
        const lf = starts[i];
        const to = lf + line.length;
        const p = plans[i];
        if (!p) {
            if (a >= lf && a <= to) newStart = lf + delta + (a - lf);
            if (b >= lf && b <= to) newEnd = lf + delta + (b - lf);
            return line;
        }
        const r = applyLine(line, p.plan, kind, add, p.s, p.e);
        if (a >= lf && a <= to) newStart = lf + delta + r.s;
        if (b >= lf && b <= to) newEnd = lf + delta + r.e;
        delta += r.line.length - line.length;
        return r.line;
    });
    const next = out.join('\n');
    if (newEnd < newStart) newEnd = newStart;
    return { text: next, selStart: Math.min(newStart, next.length), selEnd: Math.min(newEnd, next.length) };
}

/**
 * Ctrl+Shift+L: the lines the selection touches become bullets, or stop
 * being bullets when every one of them already is. Blank lines are left
 * alone.
 */
export function toggleBullets(text: string, selStart: number, selEnd: number): TextEdit {
    const a = Math.min(selStart, selEnd);
    const b = Math.max(selStart, selEnd);
    const lines = text.split('\n');
    const touched: number[] = [];
    let from = 0;
    lines.forEach((line, i) => {
        const to = from + line.length;
        // The caret's line; or the lines a selection holds something of, not
        // the next line a selection ends at the very start of.
        const hit = a === b ? a >= from && a <= to : Math.max(a, from) < Math.min(b, to);
        if (hit && line.trim() !== '') touched.push(i);
        from = to + 1;
    });
    if (touched.length === 0) {
        // The caret on a blank line: start a bullet there.
        let at = 0;
        let idx = 0;
        from = 0;
        lines.forEach((line, i) => { if (a >= from && a <= from + line.length) { idx = i; at = from; } from += line.length + 1; });
        lines[idx] = `- ${lines[idx]}`;
        return { text: lines.join('\n'), selStart: at + 2, selEnd: at + 2 };
    }
    const all = touched.every(i => BULLET_RE.test(lines[i]) || /^[ \t]*[-*•] $/.test(lines[i]));
    from = 0;
    const starts = lines.map(l => { const s = from; from += l.length + 1; return s; });
    // Each change, as where on its line it happens and how much it moves what
    // follows: a marker put in moves a caret at the line's start past it; one
    // taken out pulls a caret that was on it back to where it stood.
    const changes: Array<{ at: number; delta: number }> = [];
    for (const i of touched) {
        const line = lines[i];
        const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
        if (all) {
            lines[i] = indent + line.slice(indent.length + 2);
            changes.push({ at: starts[i] + indent.length, delta: -2 });
        } else if (!BULLET_RE.test(line)) {
            lines[i] = `${indent}- ${line.slice(indent.length)}`;
            changes.push({ at: starts[i] + indent.length, delta: 2 });
        }
    }
    const move = (pos: number) => {
        let out = pos;
        for (const c of changes) {
            if (c.delta > 0) { if (pos >= c.at) out += c.delta; }
            else if (pos >= c.at - c.delta) out += c.delta;
            else if (pos > c.at) out -= pos - c.at;
        }
        return out;
    };
    const next = lines.join('\n');
    const s = Math.max(0, Math.min(next.length, move(a)));
    const e = Math.max(s, Math.min(next.length, move(b)));
    return { text: next, selStart: s, selEnd: e };
}

/**
 * Enter on a bulleted line: the next line is a bullet too — and Enter on a
 * bullet with nothing after it ends the list instead. Null when the caret is
 * not at the end of... anything a bullet decides (the caller lets the field
 * insert the newline itself).
 */
export function continueBullet(text: string, selStart: number, selEnd: number): TextEdit | null {
    if (selStart !== selEnd) return null;
    const lineStart = text.lastIndexOf('\n', selStart - 1) + 1;
    const lineEndRaw = text.indexOf('\n', selStart);
    const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
    const line = text.slice(lineStart, lineEnd);
    const m = /^([ \t]*)([-*•]) /.exec(line);
    if (!m) return null;
    // The caret before the bullet's own marker: an ordinary newline.
    if (selStart < lineStart + m[0].length) return null;
    if (line.slice(m[0].length).trim() === '' && selStart === lineEnd) {
        // An empty bullet: Enter ends the list.
        const next = text.slice(0, lineStart) + m[1] + text.slice(lineEnd);
        const at = lineStart + m[1].length;
        return { text: next, selStart: at, selEnd: at };
    }
    const insert = `\n${m[1]}${m[2]} `;
    const next = text.slice(0, selStart) + insert + text.slice(selStart);
    const at = selStart + insert.length;
    return { text: next, selStart: at, selEnd: at };
}
