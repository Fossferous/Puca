/**
 * The formatting keys' edits (notes/model/noteFormat.ts toggleMark /
 * toggleBullets) checked by READING THEM BACK, the way the note will be
 * read. Three review rounds each found another case where the marks a key
 * wrote showed as stray characters; the edit now verifies itself, and this
 * file pins that from the outside: on lines with bullets, nested marks,
 * addresses and scripts, for every selection and every mark, an edit either
 * changes nothing or reads as exactly the words it was asked to mark, with
 * every other word as it was.
 */
import { describe, expect, it } from 'vitest';
import { readNoteFormat, toggleBullets, toggleMark, type FormatKind, type Marks } from '../notes/model/noteFormat';
import { linkSegments } from '../utils/linkSegments';

const KINDS: FormatKind[] = ['bold', 'italic', 'underline', 'strike'];

/** Each character of a one-line text as it reads, with its marks and
 *  whether it is part of an address. */
function reading(line: string): Array<{ ch: string; m: Marks; link: boolean }> {
    const [l] = readNoteFormat(line);
    // The bullet's marker as typed: a bare `- ` that becomes a bullet once
    // something follows it reads the same characters either way.
    const prefix = l.bullet ? line.slice(0, l.bullet.at + 2) : '';
    return [...prefix].map(ch => ({ ch, m: { bold: false, italic: false, underline: false, strike: false }, link: false }))
        .concat(l.runs.flatMap(r => [...r.text].map(ch => ({ ch, m: r.marks, link: r.kind === 'link' }))));
}

const same = (a: Marks, b: Marks) => a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike;

const LINES = [
    'buy milk now',
    '**x y**',
    '**big deal** today',
    '*one two* three',
    '- milk',
    '* eggs and *ham*',
    'see https://example.org/x now',
    'see https://example.org/path.',
    'call (https://example.org/x)',
    '1\uFE0F\u20E3 eggs',
    '- \u{1F389} party',
    '<u>under</u> and ~~gone~~',
    '***both*** words',
    'नमस्ते दुनिया',
    'I ❤️ you',
    '2*3*4 and a_b',
    'end.',
];

describe('every edit reads back as asked, or changes nothing', () => {
    it('on tricky lines, for every selection and every mark', () => {
        let checked = 0;
        for (const line of LINES) {
            const before = reading(line);
            for (let s = 0; s <= line.length; s++) {
                for (let e = s + 1; e <= line.length; e++) {
                    for (const kind of KINDS) {
                        const r = toggleMark(line, s, e, kind);
                        if (r.text === line) continue;
                        const after = reading(r.text);
                        // The same words, nothing gained or lost.
                        expect(after.map(c => c.ch).join(''), `${line} [${s},${e}) ${kind} → ${r.text}`).toBe(before.map(c => c.ch).join(''));
                        // Every address still an address, and nothing else one.
                        expect(after.map(c => c.link), `${line} [${s},${e}) ${kind} → ${r.text}: links`).toEqual(before.map(c => c.link));
                        // Every word either gained or lost exactly this mark, or kept its marks.
                        const changed = after.map((c, i) => !same(c.m, before[i].m));
                        after.forEach((c, i) => {
                            if (!changed[i] || /\s/.test(c.ch)) return;
                            const want = { ...before[i].m, [kind]: !before[i].m[kind] };
                            expect(same(c.m, want), `${line} [${s},${e}) ${kind} → ${r.text}: "${c.ch}" at ${i}`).toBe(true);
                        });
                        // And the selection is still inside the text.
                        expect(r.selStart >= 0 && r.selEnd <= r.text.length && r.selStart <= r.selEnd).toBe(true);
                        checked++;
                    }
                }
            }
        }
        expect(checked).toBeGreaterThan(1000);
    });
});

/** Is the caret at `at` off any word and any address? (On a word, a key
 *  marks that word; off one, it puts in a pair for what is typed next.) */
function offWord(line: string, at: number): boolean {
    const r = reading(line);
    const [l] = readNoteFormat(line);
    const prefixLen = l.bullet ? `${l.bullet.indent}• `.length : 0;
    // Where `at` falls among the characters that read: the ones typed before it.
    const runs = l.runs.flatMap(x => [...x.text].map((ch, k) => ({ ch, src: x.from + k, link: x.kind === 'link' })));
    const p = runs.filter(c => c.src < at).length;
    const word = (c?: { ch: string; link: boolean }) => !!c && (c.link || /[\p{L}\p{N}]/u.test(c.ch));
    void r;
    void prefixLen;
    return !word(runs[p - 1]) && !word(runs[p]);
}

describe('keys pressed with nothing selected, then a letter typed', () => {
    const BASES = [
        'hello ',
        '',
        '- ',
        '- item and ',
        'a \u{1F389} ',
        'see https://example.org/x ',
        '**Note:** ',
        '**********',
        'a ****** b',
        '~~~~~~',
        'use <u> here',
        '*one* and ',
        'a *~ b',
        'a ~* b',
        'x *<u> y',
        'x ~</u> y',
        'x = 2**3',
        'a~~~~b',
        'see note**.',
        'rated 5**',
        '***Note: read this***',
        '*(,**!*',
    ];
    const SEQS: FormatKind[][] = [];
    for (const a of KINDS) {
        SEQS.push([a]);
        for (const b of KINDS) {
            SEQS.push([a, b]);
            for (const c of KINDS) SEQS.push([a, b, c]);
        }
    }

    it('each key either changes nothing, or flips its own mark on the letter typed next and nothing else on the line', () => {
        const letter = (text: string, caret: number) => {
            const typed = text.slice(0, caret) + 'Q' + text.slice(caret);
            const now = reading(typed);
            const qi = now.findIndex(c => c.ch === 'Q');
            return { typed, q: now[qi].m, rest: now.filter((_, i) => i !== qi) };
        };
        let checked = 0;
        for (const base of BASES) {
            const was = reading(base);
            for (let at = 0; at <= base.length; at++) {
                if (!offWord(base, at)) continue;
                for (const seq of SEQS) {
                    let text = base;
                    let caret = at;
                    for (const k of seq) {
                        const before = letter(text, caret);
                        const r = toggleMark(text, caret, caret, k);
                        const label = `${JSON.stringify(base)} @${at} ${seq.join('+')}: ${k} on ${JSON.stringify(text)} → ${JSON.stringify(r.text)}`;
                        if (r.text !== text) {
                            const after = letter(r.text, r.selStart);
                            // Its own mark flipped, every other kept.
                            for (const m of KINDS) {
                                expect(after.q[m], `${label}: ${m}`).toBe(m === k ? !before.q[m] : before.q[m]);
                            }
                        }
                        text = r.text;
                        caret = r.selStart;
                    }
                    // And the line around the letter reads as it did: no
                    // character lost, none gained (no stray mark showing), no
                    // word's marks changed. Where the caret already stood in a
                    // mark (between a closer's two stars), typing there breaks
                    // the line whatever is pressed: then no worse than that.
                    const end = letter(text, caret);
                    const plain = letter(base, at).rest;
                    const label = `${JSON.stringify(base)} @${at} ${seq.join('+')} → ${JSON.stringify(end.typed)}`;
                    const reads = (got: typeof plain, want: typeof plain) => got.length === want.length
                        && got.every((c, i) => c.ch === want[i].ch && (/\s/.test(c.ch) || same(c.m, want[i].m)));
                    const clean = reads(plain, was);
                    expect(reads(end.rest, was) || (!clean && reads(end.rest, plain)), `${label}: ${JSON.stringify(end.rest.map(c => c.ch).join(''))}`).toBe(true);
                    checked++;
                }
            }
        }
        expect(checked).toBeGreaterThan(3000);
    });

    it('in the ordinary places every sequence takes effect', () => {
        for (const base of ['hello ', '', '- ', 'a \u{1F389} ', '**Note:** ']) {
            const at = base.length;
            for (const seq of SEQS) {
                let text = base;
                let caret = at;
                for (const k of seq) {
                    const r = toggleMark(text, caret, caret, k);
                    text = r.text;
                    caret = r.selStart;
                }
                const typed = text.slice(0, caret) + 'Q' + text.slice(caret);
                const x = reading(typed).find(c => c.ch === 'Q')!.m;
                for (const k of KINDS) {
                    expect(x[k], `${JSON.stringify(base)} ${seq.join('+')} → ${JSON.stringify(typed)}: ${k}`).toBe(seq.filter(q => q === k).length % 2 === 1);
                }
            }
        }
    });

    it('mark characters a person typed are never taken out as a key\'s pair (review 7)', () => {
        for (const [line, at, k] of [
            ['x = 2**3', 6, 'italic'], ['a**b', 2, 'italic'], ['rated 5**', 8, 'italic'],
            ['see note**.', 9, 'italic'], ['a~~~~b', 3, 'strike'], ['*(,**!*', 4, 'italic'],
            // Nor folded into a pair a key puts in, where they would stop
            // reading as characters.
            ['*(,**!*', 4, 'bold'], ['*(,**!*', 4, 'underline'],
        ] as const) {
            expect(toggleMark(line, at, at, k).text, `${line} @${at} ${k}`).toBe(line);
        }
    });

    it('inside a run that has the mark already, no pair goes in that would do nothing (review 7)', () => {
        const line = '***Note: read this***';
        for (const k of ['bold', 'italic'] as const) {
            let text = line;
            let caret = 8;
            for (let n = 0; n < 3; n++) {
                const r = toggleMark(text, caret, caret, k);
                text = r.text;
                caret = r.selStart;
            }
            expect(text, k).toBe(line);
        }
    });

    it('a bare bullet marker is never marked, whatever is selected (review 7)', () => {
        const text = '- milk\n- ';
        expect(toggleMark(text, 0, text.length, 'bold').text).toBe('- **milk**\n- ');
        for (const k of KINDS) {
            expect(toggleMark(text, 7, 9, k).text, k).toBe(text);
            expect(toggleMark('- ', 0, 2, k).text, k).toBe('- ');
        }
        // With nothing selected, the pair goes after the marker, and typing
        // into it reads as a bullet with the mark.
        const r = toggleMark('- ', 0, 0, 'bold');
        expect(r.text).toBe('- ****');
        const typed = r.text.slice(0, r.selStart) + 'x' + r.text.slice(r.selStart);
        expect(readNoteFormat(typed)[0].bullet).not.toBeNull();
        expect(readNoteFormat(typed)[0].runs.find(x => x.text === 'x')?.marks.bold).toBe(true);
    });

    it('a pair put in between two typed mark characters of other kinds comes out again', () => {
        for (const [line, at] of [['a *~ b', 3], ['a ~* b', 3]] as const) {
            for (const k of KINDS) {
                const on = toggleMark(line, at, at, k);
                if (on.text === line) continue;
                const off = toggleMark(on.text, on.selStart, on.selEnd, k);
                expect(off.text, `${line} ${k}: ${JSON.stringify(on.text)}`).toBe(line);
            }
        }
        // And underline is one that goes in there.
        expect(toggleMark('a *~ b', 3, 3, 'underline').text).toBe('a *<u></u>~ b');
    });

    it('a line of stars or tildes keeps every character', () => {
        for (const [line, at, k] of [['**********', 4, 'bold'], ['~~~~~~', 3, 'strike'], ['a ****** b', 4, 'bold'], ['**********', 5, 'italic']] as const) {
            expect(toggleMark(line, at, at, k).text, `${line} @${at} ${k}`).toBe(line);
        }
    });

    it('a caret just after an emoji joiner does not split the family', () => {
        const family = 'a \u{1F468}\u200D\u{1F469} b';
        for (let at = 0; at <= family.length; at++) {
            const r = toggleMark(family, at, at, 'bold');
            expect(r.text.includes('\u{1F468}\u200D\u{1F469}'), `@${at} → ${JSON.stringify(r.text)}`).toBe(true);
        }
    });
});

describe('the cases the reviews found', () => {
    it('at the edge of a marked word the caret stays on the word, so typing carries it on', () => {
        const end = toggleMark('**hello**', 9, 9, 'italic');
        expect(end.text).toBe('***hello***');
        const typedEnd = end.text.slice(0, end.selStart) + 'X' + end.text.slice(end.selStart);
        expect(reading(typedEnd).every(c => c.m.bold && c.m.italic)).toBe(true);
        const start = toggleMark('**hello**', 0, 0, 'italic');
        const typedStart = start.text.slice(0, start.selStart) + 'X' + start.text.slice(start.selStart);
        expect(reading(typedStart).every(c => c.m.bold && c.m.italic)).toBe(true);
    });

    it('a word of a bold phrase made italic splits the phrase rather than breaking it', () => {
        const r = toggleMark('**x y**', 4, 5, 'italic');
        const rd = reading(r.text).filter(c => c.ch.trim());
        expect(rd.map(c => [c.ch, c.m.bold, c.m.italic])).toEqual([['x', true, false], ['y', true, true]]);
        const caret = toggleMark('**big deal**', 10, 10, 'italic');
        const words = reading(caret.text).filter(c => c.ch.trim());
        expect(words.every(c => c.m.bold)).toBe(true);
        expect(words.filter(c => c.m.italic).map(c => c.ch).join('')).toBe('deal');
        const inItalic = toggleMark('*x y*', 1, 2, 'bold');
        const bi = reading(inItalic.text).filter(c => c.ch.trim());
        expect(bi.map(c => [c.ch, c.m.bold, c.m.italic])).toEqual([['x', true, true], ['y', false, true]]);
    });

    it('a bullet stays a bullet: its marker is never marked', () => {
        const all = toggleMark('- milk\n- eggs', 0, 13, 'bold');
        expect(all.text).toBe('- **milk**\n- **eggs**');
        expect(readNoteFormat(all.text).every(l => l.bullet !== null)).toBe(true);
        expect(toggleMark('- milk', 0, 0, 'bold').text).toBe('- **milk**');
        const star = toggleMark('* milk', 0, 6, 'italic');
        expect(readNoteFormat(star.text)[0].bullet).not.toBeNull();
        expect(reading(star.text).filter(c => /[a-z]/.test(c.ch)).every(c => c.m.italic)).toBe(true);
    });

    it('an address is marked whole, never inside', () => {
        const r = toggleMark('see https://example.org/x now', 12, 12, 'bold');
        expect(r.text).toBe('see **https://example.org/x** now');
        expect(readNoteFormat(r.text)[0].runs.find(x => x.kind === 'link')?.href).toBe('https://example.org/x');
    });

    it('an address that ends a sentence stays a link when the sentence is marked', () => {
        for (const kind of KINDS) {
            const r = toggleMark('see https://example.org/path.', 0, 29, kind);
            const link = readNoteFormat(r.text)[0].runs.find(x => x.kind === 'link');
            expect(link?.href, `${kind}: ${r.text}`).toBe('https://example.org/path');
            expect(link?.marks[kind]).toBe(true);
        }
        // Typed by hand, too.
        expect(readNoteFormat('**Read https://example.org/a.**')[0].runs.find(x => x.kind === 'link')?.href).toBe('https://example.org/a');
    });

    it('the caret between the two stars of a bold mark never takes the bold away', () => {
        for (const [line, at] of [['**hello**', 1], ['**hello** world', 8], ['a **b** c', 3]] as const) {
            const r = toggleMark(line, at, at, 'italic');
            const bolded = reading(r.text).filter(c => c.m.bold).map(c => c.ch).join('');
            expect(bolded, `${line} @${at} → ${r.text}`).toBe(reading(line).filter(c => c.m.bold).map(c => c.ch).join(''));
        }
    });

    it('a keycap emoji is never split by a mark', () => {
        const key = '1\uFE0F\u20E3';
        for (const at of [0, 1, 2, 3]) {
            const r = toggleMark(`${key} eggs`, at, at, 'bold');
            expect(r.text.includes(key), `@${at} → ${r.text}`).toBe(true);
        }
    });

    it('an empty pair goes after a bullet, and never where it would change how the line reads', () => {
        const party = toggleMark('- \u{1F389}', 0, 0, 'bold');
        expect(readNoteFormat(party.text)[0].bullet).not.toBeNull();
        const line = '2 * 3 = 6 and *word*';
        const u = toggleMark(line, 3, 3, 'underline');
        expect(reading(u.text).filter(c => c.m.italic).map(c => c.ch).join('')).toBe('word');
    });

    it('with nothing selected, a new empty bullet line takes the mark, and typing reads as a bullet with it', () => {
        for (const [text, at] of [['- item\n- ', 9], ['- ', 2], ['* ', 2], ['  - ', 4]] as const) {
            const r = toggleMark(text, at, at, 'bold');
            expect(r.text, `${text}`).not.toBe(text);
            const typed = r.text.slice(0, r.selStart) + 'x' + r.text.slice(r.selStart);
            const last = readNoteFormat(typed).at(-1)!;
            expect(last.bullet, typed).not.toBeNull();
            expect(last.runs.find(x => x.text === 'x')?.marks.bold, typed).toBe(true);
        }
    });

    it('two different marks pressed with nothing selected both apply, and either comes off again', () => {
        for (const k1 of KINDS) {
            for (const k2 of KINDS) {
                if (k1 === k2) continue;
                const one = toggleMark('hello ', 6, 6, k1);
                const two = toggleMark(one.text, one.selStart, one.selEnd, k2);
                const typed = two.text.slice(0, two.selStart) + 'x' + two.text.slice(two.selStart);
                const x = reading(typed).find(c => c.ch === 'x')!;
                expect([x.m[k1], x.m[k2]], `${k1}+${k2}: ${typed}`).toEqual([true, true]);
                // The second key again: off, the first kept.
                const off = toggleMark(two.text, two.selStart, two.selEnd, k2);
                const typedOff = off.text.slice(0, off.selStart) + 'x' + off.text.slice(off.selStart);
                const y = reading(typedOff).find(c => c.ch === 'x')!;
                expect([y.m[k1], y.m[k2]], `${k1}+${k2}+${k2}: ${typedOff}`).toEqual([true, false]);
            }
        }
    });

    it('a formatted line links exactly what the plain view links', () => {
        for (const line of ['Link:https://example.org/a', 'word:https://example.org/b', 'see https://example.org/c and http://x.example.net/d.', 'xhttps://example.org']) {
            const plain = linkSegments(line).filter(seg => seg.kind === 'link').map(seg => (seg.kind === 'link' ? seg.href : ''));
            const formatted = readNoteFormat(line)[0].runs.filter(r => r.kind === 'link').map(r => (r.kind === 'link' ? r.href : ''));
            expect(formatted, line).toEqual(plain);
        }
    });

    it('a selection or caret inside one visible character never splits it', () => {
        const flag = 'go \u{1F3F3}\uFE0F now';
        const family = 'a \u{1F468}\u200D\u{1F469} b';
        for (const line of [flag, family]) {
            for (let s = 0; s <= line.length; s++) {
                for (let e = s; e <= line.length; e++) {
                    for (const kind of KINDS) {
                        const r = toggleMark(line, s, e, kind);
                        // No lone surrogate anywhere.
                        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r.text), `${line} [${s},${e}) ${kind} → ${JSON.stringify(r.text)}`).toBe(false);
                    }
                }
            }
        }
    });

    it('an emoji keeps its variation selector', () => {
        const caret = toggleMark('I ❤️ you', 4, 4, 'bold');
        expect(caret.text.includes('❤️')).toBe(true);
        const love = toggleMark('❤️love', 2, 6, 'bold');
        expect(love.text).toBe('❤️**love**');
    });

    it('Ctrl+Shift+L with the caret at the start of a line puts it after the new marker, selecting nothing', () => {
        expect(toggleBullets('milk', 0, 0)).toEqual({ text: '- milk', selStart: 2, selEnd: 2 });
        expect(toggleBullets('- milk', 1, 1)).toEqual({ text: 'milk', selStart: 0, selEnd: 0 });
        expect(toggleBullets('a\n- milk', 6, 6)).toEqual({ text: 'a\nmilk', selStart: 4, selEnd: 4 });
    });
});
