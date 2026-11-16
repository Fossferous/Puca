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
const WORDISH = /[\p{L}\p{N}]/u;
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
 * An address never ENDS in `*` or `~` here, so an address in `**` is a bold
 * link rather than a link whose last characters are `**` (urlAt, shared
 * with chat, keeps them; an address that really ends in one is vanishingly
 * rare, and the field the text is typed in still shows every character).
 */
function linkSpans(line: string): Array<{ from: number; to: number; href: string }> {
    const spans: Array<{ from: number; to: number; href: string }> = [];
    for (let i = 0; i < line.length; i++) {
        const boundary = i === 0 || !/[A-Za-z0-9]/.test(line[i - 1]);
        // Only http(s) addresses are links (urlAt): nothing else need be asked.
        if (!boundary || (line[i] !== 'h' && line[i] !== 'H')) continue;
        const found = urlAt(line.slice(i));
        const href = found?.replace(/[*~]+$/, '');
        if (href && urlAt(href) === href) {
            spans.push({ from: i, to: i + href.length, href });
            i += href.length - 1;
        }
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

/** An empty pair of `kind`'s marks around the caret, standing alone (the
 *  `*` of a `**` is not an italic pair). */
function emptyPairAt(line: string, at: number, open: string, close: string): boolean {
    if (line.slice(at - open.length, at) !== open || line.slice(at, at + close.length) !== close) return false;
    const ch = open[0];
    if (ch !== '*' && ch !== '~') return true;
    return line[at - open.length - 1] !== ch && line[at + close.length] !== ch;
}

function toggleOnLine(line: string, s: number, e: number, kind: FormatKind): { line: string; s: number; e: number } {
    const { open, close } = WRAP[kind];
    // Pressed twice with nothing typed between: the pair it put in comes out.
    if (s === e && emptyPairAt(line, s, open, close)) {
        return { line: line.slice(0, s - open.length) + line.slice(s + close.length), s: s - open.length, e: s - open.length };
    }
    // The selection's own edges are kept clear of spaces: `** x**` is not bold.
    while (s < e && SPACE.test(line[s])) s++;
    while (e > s && SPACE.test(line[e - 1])) e--;
    // A mark only counts at the edge of a word (readInline), so it goes
    // there: a selection that starts or ends inside a word takes the whole
    // word, and with nothing selected the caret's word is the one marked —
    // `ab**cd**ef` would read as typed, never as bold.
    const caret = s === e ? s : null;
    if (caret !== null) {
        if (isWordish(line[s - 1]) || isWordish(line[s])) {
            while (s > 0 && isWordish(line[s - 1])) s--;
            while (e < line.length && isWordish(line[e])) e++;
        }
    } else {
        while (s > 0 && isWordish(line[s - 1]) && isWordish(line[s])) s--;
        while (e < line.length && isWordish(line[e]) && isWordish(line[e - 1])) e++;
    }
    const keepCaret = (r: { line: string; s: number; e: number }, shift: number) =>
        (caret === null ? r : { line: r.line, s: caret + shift, e: caret + shift });
    // Already marked: the innermost pair of this kind that holds the
    // selection (or that the selection takes in whole) comes off — and only
    // a pair that really reads as one, so the `*` of a `**` is never taken
    // for an italic.
    const holding = spansOf(line)
        .filter(sp => sp.delim.adds.includes(kind))
        .filter(sp => {
            const innerFrom = sp.open + sp.delim.open.length;
            const innerTo = sp.close;
            const outerTo = sp.close + sp.delim.close.length;
            return (s >= innerFrom && e <= innerTo) || (s <= sp.open && e >= outerTo);
        })
        .sort((a, b) => (a.close - a.open) - (b.close - b.open))[0];
    if (holding) {
        const d = holding.delim;
        const keep = without(d, kind);
        const outerTo = holding.close + d.close.length;
        const inner = line.slice(holding.open + d.open.length, holding.close);
        const out = line.slice(0, holding.open) + keep.open + inner + keep.close + line.slice(outerTo);
        const shift = d.open.length - keep.open.length;
        const innerFrom = holding.open + d.open.length;
        const map = (x: number) => (x <= holding.open ? x
            : x <= innerFrom ? holding.open + keep.open.length
                : x <= holding.close ? x - shift
                    : x <= outerTo ? holding.open + keep.open.length + inner.length
                        : x - shift - (d.close.length - keep.close.length));
        return keepCaret({ line: out, s: map(s), e: map(e) }, caret === null ? 0 : map(caret) - caret);
    }
    if (s === e) {
        // Nothing selected: the marks go in around the caret, and what is
        // typed next is inside them.
        return { line: line.slice(0, s) + open + close + line.slice(s), s: s + open.length, e: s + open.length };
    }
    const out = line.slice(0, s) + open + line.slice(s, e) + close + line.slice(e);
    return keepCaret({ line: out, s: s + open.length, e: e + open.length }, open.length);
}

/**
 * Ctrl+B / I / U / T: put the mark around the selection, or take it off
 * when it is already there. A selection over several lines is marked line by
 * line (a mark never spans a line). The selection comes back around the same
 * words.
 */
export function toggleMark(text: string, selStart: number, selEnd: number, kind: FormatKind): TextEdit {
    const a = Math.max(0, Math.min(selStart, selEnd, text.length));
    const b = Math.min(text.length, Math.max(selStart, selEnd));
    const lines = text.split('\n');
    let from = 0;
    let newStart = a;
    let newEnd = b;
    let delta = 0;
    const out: string[] = [];
    for (const line of lines) {
        const to = from + line.length;
        const touches = a === b ? a >= from && a <= to : a < to + 1 && b > from;
        if (!touches || (a !== b && line.trim() === '')) {
            out.push(line);
        } else {
            const s = Math.max(a, from) - from;
            const e = Math.min(b, to) - from;
            const r = toggleOnLine(line, s, e, kind);
            if (a >= from && a <= to) newStart = from + delta + r.s;
            if (b >= from && b <= to) newEnd = from + delta + r.e;
            delta += r.line.length - line.length;
            out.push(r.line);
        }
        from = to + 1;
    }
    const next = out.join('\n');
    if (a !== b && newEnd < newStart) newEnd = newStart;
    return { text: next, selStart: Math.min(newStart, next.length), selEnd: Math.min(Math.max(newEnd, newStart), next.length) };
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
        if ((a <= to && b >= from) && line.trim() !== '') touched.push(i);
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
    let shiftStart = 0;
    let shiftEnd = 0;
    from = 0;
    const starts = lines.map(l => { const s = from; from += l.length + 1; return s; });
    for (const i of touched) {
        const line = lines[i];
        const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
        let change: number;
        if (all) {
            lines[i] = indent + line.slice(indent.length + 2);
            change = -2;
        } else if (BULLET_RE.test(line)) {
            continue;
        } else {
            lines[i] = `${indent}- ${line.slice(indent.length)}`;
            change = 2;
        }
        if (starts[i] < a) shiftStart += change;
        if (starts[i] < b || (starts[i] === b && a === b)) shiftEnd += change;
    }
    const next = lines.join('\n');
    const s = Math.max(0, Math.min(next.length, a + shiftStart));
    const e = Math.max(s, Math.min(next.length, b + shiftEnd));
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
