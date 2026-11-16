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

const KINDS: FormatKind[] = ['bold', 'italic', 'underline', 'strike'];

/** Each character of a one-line text as it reads, with its marks and
 *  whether it is part of an address. */
function reading(line: string): Array<{ ch: string; m: Marks; link: boolean }> {
    const [l] = readNoteFormat(line);
    const prefix = l.bullet ? `${l.bullet.indent}• ` : '';
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
