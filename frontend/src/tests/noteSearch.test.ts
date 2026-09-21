/**
 * WHERE a search matched — the offset arithmetic behind the highlighting.
 *
 * `normalizeForSearch` changes the string's LENGTH three ways (NFD plus
 * combining-mark stripping, locale lowercasing, collapsing whitespace runs),
 * so `normalized.indexOf(term)` is NOT an index into the original text. Every
 * test here exists because highlighting from that index is off by one
 * character per accent and several per whitespace run — the single most
 * likely defect in the feature.
 *
 * The invariant that ties the two together is asserted directly: the mapped
 * normaliser must produce EXACTLY what the search's own normaliser produces.
 * If it ever stopped doing so, search would mark up text it had not matched.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    findRanges, mergeRanges, normalizeWithMap, searchTerms, snippetAround,
} from '../notes/model/noteSearch';
import { buildNoteCards, noteMatches, normalizeForSearch, type NoteSource } from '../notes/model/notesModel';
import { EMPTY_KEEP_PREFS } from '../notes/model/notesPrefs';
import { TASK_DECRYPT_FAILED } from '../api/decryptMarkers';
import { type Task } from '../api/tasks';

const CORPUS = [
    '', ' ', '   ', 'plain text', 'Plain Text', 'CAFÉ au lait', 'café', 'café',   // composed and decomposed
    'a   b', '  leading and trailing  ', 'line\nbreak\there', 'ÀÉÎÕÜ àéîõü', 'Straße',
    'ID İstanbul', 'emoji 🎉 stays', 'ünïcödé wörds', 'tabs\t\tand\nnewlines\n\n', 'x'.repeat(200),
    // ORPHAN combining marks - a paste from a broken source. They are the one
    // thing the stripper removes on its own, so they fold to NOTHING, and a
    // fold that emits nothing must not end a whitespace run either: emitting
    // the run around one gave "a  b" where the search sees "a b", and every
    // highlight after it in that field was off by one.
    'a ́ b', '́ abc', 'abc ́', '́', ' ́ ', 'onétwo',
];

describe('normalizeWithMap', () => {
    it('produces EXACTLY what normalizeForSearch produces', () => {
        for (const s of CORPUS) {
            expect([s, normalizeWithMap(s).norm]).toEqual([s, normalizeForSearch(s)]);
        }
    });

    it('keeps one map entry per normalised character, always inside the original', () => {
        for (const s of CORPUS) {
            const { norm, map, endMap } = normalizeWithMap(s);
            expect(map.length).toBe(norm.length);
            expect(endMap.length).toBe(norm.length);
            for (let i = 0; i < norm.length; i++) {
                expect(map[i]).toBeGreaterThanOrEqual(0);
                expect(endMap[i]).toBeGreaterThan(map[i]);
                expect(endMap[i]).toBeLessThanOrEqual(s.length);
            }
        }
    });
});

describe('findRanges', () => {
    /** The text a range actually covers, which is what gets a <mark>. */
    const marked = (text: string, terms: string[]) => findRanges(text, terms).map(r => text.slice(r.start, r.end));

    it('an accent-insensitive match covers the ORIGINAL characters', () => {
        // The bug this pins: 'café' NFDs to five characters, so an unmapped
        // indexOf would highlight "café" as "caf" (or run past the end).
        expect(marked('I love café au lait', ['cafe'])).toEqual(['café']);
        expect(marked('CAFÉ', ['cafe'])).toEqual(['CAFÉ']);
        expect(marked('Crème brûlée today', ['creme', 'brulee'])).toEqual(['Crème', 'brûlée']);
        // DECOMPOSED input is where the offsets really diverge: "cafe" + a
        // combining acute is 5 UTF-16 units that normalise to 4, so every
        // match AFTER it sits one character later in the original than in the
        // normalised string. This is the case an unmapped indexOf gets wrong.
        const decomposed = 'café then bread';
        expect(marked(decomposed, ['bread'])).toEqual(['bread']);
        expect(marked(decomposed, ['cafe then'])).toEqual(['café then']);
    });

    it('a match across a collapsed whitespace run covers the real gap, and no more', () => {
        expect(marked('a   b', ['a b'])).toEqual(['a   b']);
        expect(marked('x a   b y', ['a b'])).toEqual(['a   b']);
        expect(marked('one\n\ntwo three', ['one two'])).toEqual(['one\n\ntwo']);
    });

    it('finds EVERY occurrence, not just the first', () => {
        expect(marked('bread, more bread, and bread', ['bread'])).toEqual(['bread', 'bread', 'bread']);
    });

    it('merges overlapping and touching hits into one mark, sorted', () => {
        // 'ab' and 'bc' overlap inside 'abc'; 'ab' and 'cd' in 'abcd' touch.
        expect(marked('abc', ['ab', 'bc'])).toEqual(['abc']);
        expect(marked('abcd', ['cd', 'ab'])).toEqual(['abcd']);
        expect(mergeRanges([{ start: 5, end: 7 }, { start: 0, end: 2 }])).toEqual([{ start: 0, end: 2 }, { start: 5, end: 7 }]);
    });

    it('is empty for no terms, no text, or no hit', () => {
        expect(findRanges('anything', [])).toEqual([]);
        expect(findRanges('', ['a'])).toEqual([]);
        expect(findRanges('anything', ['zzz'])).toEqual([]);
    });

    it('POSITIVE CONTROL for the whole mapping: every marked slice really contains the term', () => {
        const text = 'Crème  brûlée   and   CAFÉ, café, cafe — plus bread   and bread again';
        for (const term of ['cafe', 'creme', 'bread', 'brulee and', 'cafe cafe']) {
            for (const r of findRanges(text, [term])) {
                expect(normalizeForSearch(text.slice(r.start, r.end))).toContain(term);
            }
        }
    });
});

describe('searchTerms and noteMatches cannot drift apart', () => {
    const task = (id: number, o: Partial<Task> = {}): Task => ({
        id, channel_id: null, list_id: 1, parent_id: null, description: `item ${id}`, is_completed: false,
        position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null, ...o,
    });
    const source: NoteSource = {
        ref: { kind: 'list', id: 7 }, title: 'Café trip', body: 'Bring the crème and   some bread',
        serverName: 'Home server',
    };
    const tasks = [task(1, { description: 'Buy brûlée' }), task(2, { description: TASK_DECRYPT_FAILED })];
    const card = buildNoteCards([source], new Map([['list:7', tasks]]), [], EMPTY_KEEP_PREFS)[0];
    const fields = () => [card.title, card.body ?? '', card.serverName ?? '', ...card.labels, 'Buy brûlée'];

    it.each([
        'cafe', 'CAFE', 'creme', 'brulee', 'bread', 'crème and some', 'café trip', 'home server',
        'zzz', 'cafe zzz', '', '   ',
    ])('“%s”: a boolean match means at least one field can point at every term', q => {
        const terms = searchTerms(q);
        const hit = terms.length === 0
            ? true
            : terms.every(t => fields().some(f => findRanges(f, [t]).length > 0));
        expect([q, hit]).toEqual([q, noteMatches(card, q)]);
    });

    it('a decrypt-failure marker is never searched and never marked', () => {
        expect(noteMatches(card, 'decrypt')).toBe(false);
        // ...and the positive control: readable text with the same word IS.
        const readable = buildNoteCards(
            [{ ref: { kind: 'list', id: 8 }, title: 'Keys', body: 'unable to decrypt the old backup' }],
            new Map([['list:8', []]]), [], EMPTY_KEEP_PREFS,
        )[0];
        expect(noteMatches(readable, 'decrypt')).toBe(true);
        expect(findRanges(readable.body!, ['decrypt']).length).toBe(1);
    });
});

describe('snippetAround', () => {
    const long = 'a'.repeat(30_000) + ' the needle sits here ' + 'b'.repeat(5_000);

    it('moves the window to a match deep in a long note', () => {
        const ranges = findRanges(long, ['needle']);
        expect(ranges.length).toBe(1);
        const s = snippetAround(long, ranges);
        expect(s.clipped).toBe(true);
        expect(s.text.length).toBeLessThan(1_000);
        expect(s.text).toContain('needle');
        // The shifted ranges must still point AT the needle in the new string.
        expect(s.ranges.length).toBe(1);
        expect(s.text.slice(s.ranges[0].start, s.ranges[0].end)).toBe('needle');
    });

    it('leaves a match near the top exactly where it was', () => {
        const text = 'the needle is right here at the front of a fairly ordinary note';
        const ranges = findRanges(text, ['needle']);
        const s = snippetAround(text, ranges);
        expect(s.clipped).toBe(false);
        expect(s.text).toBe(text);
        expect(s.ranges).toEqual(ranges);
    });

    it('with no ranges it hands the text back untouched', () => {
        const s = snippetAround(long, []);
        expect(s.text).toBe(long);
        expect(s.clipped).toBe(false);
    });
});

describe('cost', () => {
    const body = ('lorem ipsum dolor sit amet '.repeat(1_500)).slice(0, 40_000);

    /** Every String.prototype.normalize call made while `fn` runs.
     *  normalizeForSearch normalises the WHOLE string once; normalizeWithMap
     *  normalises one character at a time. One call per field therefore means
     *  the cheap pass ran and the map was never built - a STRUCTURAL bound,
     *  where a wall-clock one is the flake this repo has already been bitten by.
     */
    const normalizeCalls = (fn: () => void): number => {
        const spy = vi.spyOn(String.prototype, 'normalize');
        try {
            fn();
            return spy.mock.calls.length;
        } finally {
            spy.mockRestore();
        }
    };

    it('does NOT build the index map for a field that cannot match', () => {
        // The common case by far: a grid of matching cards, most of whose
        // FIELDS do not contain the term (the title matched, or one item did).
        // 40 KB is the body cap (MAX_BODY_BYTES is 48,000). Building the two
        // index arrays for one of them costs ~20ms and one normalize call per
        // character; this is the guard against dropping the cheap first pass.
        const terms = searchTerms('zzzznothing');
        let total = 0;
        const calls = normalizeCalls(() => {
            for (let i = 0; i < 200; i++) total += findRanges(body, terms).length;
        });
        expect(total).toBe(0);
        expect(calls).toBe(200);          // one per field, not one per character
    });

    it('POSITIVE CONTROL: a field that DOES match pays for the map, and only then', () => {
        const terms = searchTerms('ipsum');
        let total = 0;
        const calls = normalizeCalls(() => { total += findRanges(body, terms).length; });
        expect(total).toBeGreaterThan(0);
        // The cheap pass, plus exactly one call per NON-SPACE character of the
        // mapped pass (a whitespace run is collapsed before anything is
        // folded). Thirty thousand against the other test's 200: the count
        // that proves it is measuring the right thing.
        expect(calls).toBe(body.replace(/\s/g, '').length + 1);
    });
});
