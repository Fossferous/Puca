/**
 * Púca Notes — WHERE a search matched, not just whether it did.
 *
 * `noteMatches` (notesModel.ts) stays the cheap boolean filter over every
 * card; this module is run only on the cards that survived it, and turns the
 * same rules into character ranges the UI can mark up. Both read the same
 * decrypted strings the client already holds: nothing about a query, a match
 * or a snippet is ever sent, stored or cached (notesCache.ts seals what it is
 * given, so hits are derived at render and never hung off a NoteCard).
 *
 * THE OFFSET PROBLEM, which is what most of this file is about.
 * `normalizeForSearch` changes the string's LENGTH three ways — NFD plus
 * combining-mark stripping ("café" → "cafe"), locale lowercasing, and
 * collapsing whitespace runs ("a   b" → "a b") — so `normalized.indexOf(term)`
 * is NOT an index into the original text. Highlighting from it shifts one
 * character per accent and several per whitespace run. `normalizeWithMap`
 * therefore folds the text one code point at a time and records, for every
 * character it emits, the start and end of the ORIGINAL characters it came
 * from; a match's range is then map[start] .. endMap[end - 1].
 *
 * Decrypt-failure markers are handled by the caller exactly as `noteMatches`
 * handles them: an unreadable field is blanked before it is searched, so
 * "encrypted" never matches — and never highlights — a note you cannot read.
 */
import { normalizeForSearch } from './notesModel';

/** Half-open [start, end) in the ORIGINAL string's UTF-16 coordinates. */
export interface Range {
    start: number;
    end: number;
}

interface Mapped {
    /** Exactly what normalizeForSearch(input) returns. */
    norm: string;
    /** For each character of `norm`: where its source began in `input`. */
    map: number[];
    /** ...and where its source ended. */
    endMap: number[];
}

const COMBINING = /[̀-ͯ]/g;
const WHITESPACE = /\s/;

/**
 * normalizeForSearch, plus the index map back to the original. Kept beside
 * that function deliberately: `normalizeWithMap(s).norm === normalizeForSearch(s)`
 * is a tested invariant, and if it ever broke, search would highlight text it
 * had not matched (or match text it could not point at).
 */
export function normalizeWithMap(input: string): Mapped {
    const out: string[] = [];
    const map: number[] = [];
    const endMap: number[] = [];
    let runStart = -1;      // start of the whitespace run waiting to be emitted
    let started = false;    // anything non-space emitted yet (the leading trim)
    let i = 0;
    for (const ch of input) {
        const at = i;
        i += ch.length;
        if (WHITESPACE.test(ch)) {
            // A trailing run is simply never emitted — that is the trim.
            if (started && runStart < 0) runStart = at;
            continue;
        }
        if (runStart >= 0) {
            // The whole run collapses to one space, and owns the run's span,
            // so a match across it highlights the real gap and no more.
            out.push(' ');
            map.push(runStart);
            endMap.push(at);
            runStart = -1;
        }
        const folded = ch.normalize('NFD').replace(COMBINING, '').toLocaleLowerCase();
        // By UTF-16 UNIT, not by code point: `norm.indexOf` works in units, so
        // one map entry per unit is what keeps the two in step. An emoji folds
        // to a surrogate PAIR, and pushing it as one entry left the map one
        // short of `norm` for every note containing one.
        for (let k = 0; k < folded.length; k++) {
            out.push(folded[k]);
            map.push(at);
            endMap.push(at + ch.length);
        }
        started = true;
    }
    return { norm: out.join(''), map, endMap };
}

/** The query as the terms every field is tested against (boolean AND). */
export function searchTerms(query: string): string[] {
    return normalizeForSearch(query).split(' ').filter(Boolean);
}

/** Sorted, non-overlapping; touching ranges are joined so two terms next to
 *  each other render as one mark rather than two with a seam. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
    if (ranges.length === 0) return [];
    const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
    const out: Range[] = [{ ...sorted[0] }];
    for (const r of sorted.slice(1)) {
        const last = out[out.length - 1];
        if (r.start <= last.end) last.end = Math.max(last.end, r.end);
        else out.push({ ...r });
    }
    return out;
}

/**
 * EVERY occurrence of every term in `text`, in the original's coordinates.
 * Not just the first: a word the user searched for appears more than once in
 * a note far more often than not.
 */
export function findRanges(text: string, terms: readonly string[]): Range[] {
    if (!text || terms.length === 0) return [];
    // The cheap normaliser first: it allocates one string, while the mapped
    // one allocates two arrays per character. Most fields of most cards do NOT
    // contain the term — the title matched, or one item did — so the map is
    // built only where there is something to point at. Both produce the same
    // string (a tested invariant), so the indices agree.
    const norm = normalizeForSearch(text);
    if (norm === '') return [];
    const found: { at: number; len: number }[] = [];
    for (const term of terms) {
        if (term === '') continue;
        let from = 0;
        for (;;) {
            const at = norm.indexOf(term, from);
            if (at < 0) break;
            found.push({ at, len: term.length });
            from = at + 1;   // overlapping occurrences are still occurrences
        }
    }
    if (found.length === 0) return [];
    const { map, endMap } = normalizeWithMap(text);
    return mergeRanges(found.map(f => ({ start: map[f.at], end: endMap[f.at + f.len - 1] })));
}

export interface Snippet {
    text: string;
    ranges: Range[];
    /** Text was dropped from the front (the caller may want to say so). */
    clipped: boolean;
}

/**
 * A window of `text` around its FIRST match, for a card whose body is clamped
 * to its first few lines. A note can hold 48 KB; a hit at character 30,000
 * was rendered nowhere at all, so the card looked as though it had matched
 * nothing. When the first hit is already near the top, the text is returned
 * untouched — moving it would be churn.
 */
export function snippetAround(text: string, ranges: readonly Range[], radius = 140): Snippet {
    if (ranges.length === 0 || ranges[0].start <= radius) {
        return { text, ranges: [...ranges], clipped: false };
    }
    let start = Math.max(0, ranges[0].start - radius);
    // Start at a word boundary where one is close, so the snippet does not
    // open mid-word.
    const space = text.indexOf(' ', start);
    // ...but never past the match itself: a 140-character run with no space in
    // it would otherwise push the window's start into the word being marked.
    if (space >= 0 && space - start < 24 && space + 1 <= ranges[0].start) start = space + 1;
    const end = Math.min(text.length, ranges[0].end + radius * 2);
    const prefix = '…';
    const body = text.slice(start, end);
    const shift = prefix.length - start;
    const moved: Range[] = [];
    for (const r of ranges) {
        if (r.end <= start || r.start >= end) continue;
        moved.push({ start: Math.max(prefix.length, r.start + shift), end: Math.min(prefix.length + body.length, r.end + shift) });
    }
    return { text: prefix + body + (end < text.length ? '…' : ''), ranges: moved, clipped: true };
}
