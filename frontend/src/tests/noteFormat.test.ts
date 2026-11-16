/**
 * The note text's formatting (notes/model/noteFormat.ts): what reads as
 * bold, italic, underline, strikethrough and a bullet, what NEVER does, and
 * the Ctrl+B / I / U / T / Shift+L edits that write the marks.
 */
import { describe, expect, it } from 'vitest';
import {
    continueBullet, hasNoteFormatting, marksAt, plainNoteText, readNoteFormat, toggleBullets, toggleMark,
    type FmtRun,
} from '../notes/model/noteFormat';

/** One line's runs as `text[bius]` tokens, for compact expectations. */
function runs(line: string): string[] {
    return readNoteFormat(line)[0].runs.map((r: FmtRun) => {
        const m = r.marks;
        const tag = `${m.bold ? 'b' : ''}${m.italic ? 'i' : ''}${m.underline ? 'u' : ''}${m.strike ? 's' : ''}`;
        return r.kind === 'link' ? `<${r.href}>${tag}` : `${r.text}${tag ? `[${tag}]` : ''}`;
    });
}

describe('reading marks', () => {
    it('reads the four marks and their nesting', () => {
        expect(runs('a **bold** b')).toEqual(['a ', 'bold[b]', ' b']);
        expect(runs('an *italic* word')).toEqual(['an ', 'italic[i]', ' word']);
        expect(runs('<u>under</u> it')).toEqual(['under[u]', ' it']);
        expect(runs('~~gone~~.')).toEqual(['gone[s]', '.']);
        expect(runs('***both***')).toEqual(['both[bi]']);
        expect(runs('**bold *and italic* too**')).toEqual(['bold [b]', 'and italic[bi]', ' too[b]']);
        expect(runs('<u>**x**</u>')).toEqual(['x[bu]']);
    });

    it('leaves ordinary writing exactly as typed', () => {
        for (const literal of [
            '2*3*4', 'a**b**c', 'snake_case and __init__ and __file__', 'C++ and C#', 'a * not italic *',
            'price: 5 * 3 = 15', '**', '****', '** spaced **', 'x ~~ y ~~ z', '<u></u>', 'a <b>tag</b>',
            '~/notes', 'email@example.com', '||spoiler||', '`code`',
        ]) {
            const lines = readNoteFormat(literal);
            expect(lines[0].runs.every(r => !r.marks.bold && !r.marks.italic && !r.marks.underline && !r.marks.strike), literal).toBe(true);
            expect(plainNoteText(literal), literal).toBe(literal);
            expect(hasNoteFormatting(literal), literal).toBe(false);
        }
    });

    it('never reads a mark inside a web address', () => {
        expect(runs('see https://example.com/a*b*c now')).toEqual(['see ', '<https://example.com/a*b*c>', ' now']);
        expect(runs('**https://example.com/x**')).toEqual(['<https://example.com/x>b']);
        // A closer that only exists inside the address closes nothing.
        expect(runs('*see https://e.com/x* no')).toEqual(['see [i]', '<https://e.com/x>i', ' no']);
    });

    it('keeps every run at its place in the text, so a caret and a search can find it', () => {
        const text = 'one **two** <u>three</u>\n- four *five*';
        for (const line of readNoteFormat(text)) {
            for (const r of line.runs) expect(text.slice(r.from, r.from + r.text.length)).toBe(r.text);
        }
        const [, second] = readNoteFormat(text);
        expect(second.bullet).toEqual({ at: 25, indent: '' });
        expect(second.runs.map(r => r.text)).toEqual(['four ', 'five']);
    });

    it('reads bullets, and only real ones', () => {
        expect(readNoteFormat('- milk')[0].bullet).not.toBeNull();
        expect(readNoteFormat('* eggs')[0].bullet).not.toBeNull();
        expect(readNoteFormat('• bread')[0].bullet).not.toBeNull();
        expect(readNoteFormat('  - indented')[0].bullet).toEqual({ at: 2, indent: '  ' });
        for (const no of ['-milk', '- ', '-', '-- x', 'a - b']) expect(readNoteFormat(no)[0].bullet, no).toBeNull();
        expect(plainNoteText('- milk\n- **eggs**')).toBe('• milk\n• eggs');
        expect(hasNoteFormatting('- milk')).toBe(true);
    });

    it('a long line of marks that never close is read in linear time', () => {
        const line = '*a '.repeat(20000);
        const t = performance.now();
        expect(hasNoteFormatting(line)).toBe(false);
        const took = performance.now() - t;
        // Quadratic was tens of seconds here; linear is a few milliseconds.
        expect(took).toBeLessThan(1500);
    });

    it('marks do not cross lines', () => {
        expect(readNoteFormat('**a\nb**').every(l => l.runs.every(r => !r.marks.bold))).toBe(true);
    });

    it('says which marks the caret sits in', () => {
        const text = 'a **bold** b';
        expect(marksAt(text, 5).bold).toBe(true);
        expect(marksAt(text, 1).bold).toBe(false);
    });
});

describe('Ctrl+B / I / U / T', () => {
    it('wraps a selection, and the selection stays on the same words', () => {
        const r = toggleMark('buy milk now', 4, 8, 'bold');
        expect(r).toEqual({ text: 'buy **milk** now', selStart: 6, selEnd: 10 });
        expect(toggleMark('buy milk now', 4, 8, 'underline').text).toBe('buy <u>milk</u> now');
        expect(toggleMark('buy milk now', 4, 8, 'strike').text).toBe('buy ~~milk~~ now');
        expect(toggleMark('buy milk now', 4, 8, 'italic').text).toBe('buy *milk* now');
    });

    it('takes the mark off again, from inside it or around it', () => {
        expect(toggleMark('buy **milk** now', 6, 10, 'bold')).toEqual({ text: 'buy milk now', selStart: 4, selEnd: 8 });
        expect(toggleMark('buy **milk** now', 4, 12, 'bold')).toEqual({ text: 'buy milk now', selStart: 4, selEnd: 8 });
        // Round trip for every mark.
        for (const k of ['bold', 'italic', 'underline', 'strike'] as const) {
            const on = toggleMark('a word b', 2, 6, k);
            expect(toggleMark(on.text, on.selStart, on.selEnd, k).text).toBe('a word b');
        }
    });

    it('keeps spaces outside the marks, so what it writes is read back as marked', () => {
        const r = toggleMark('buy milk now', 3, 9, 'bold');
        expect(r.text).toBe('buy **milk** now');
        expect(runs(r.text)).toContain('milk[b]');
    });

    it('bold then italic on the same words is both, and reads as both', () => {
        const b = toggleMark('x word y', 2, 6, 'bold');
        const bi = toggleMark(b.text, b.selStart, b.selEnd, 'italic');
        expect(bi.text).toBe('x ***word*** y');
        expect(runs(bi.text)).toContain('word[bi]');
    });

    it('with nothing selected, marks the word the caret is on, the caret kept on its letter', () => {
        expect(toggleMark('ab', 1, 1, 'bold')).toEqual({ text: '**ab**', selStart: 3, selEnd: 3 });
        expect(toggleMark('one two', 7, 7, 'italic')).toEqual({ text: 'one *two*', selStart: 8, selEnd: 8 });
        // …and off again from inside it.
        expect(toggleMark('**ab**', 3, 3, 'bold')).toEqual({ text: 'ab', selStart: 1, selEnd: 1 });
    });

    it('off a word, puts an empty pair in for what is typed next — and a second press takes it out', () => {
        const on = toggleMark('a ', 2, 2, 'bold');
        expect(on).toEqual({ text: 'a ****', selStart: 4, selEnd: 4 });
        expect(toggleMark(on.text, on.selStart, on.selEnd, 'bold')).toEqual({ text: 'a ', selStart: 2, selEnd: 2 });
        const u = toggleMark('', 0, 0, 'underline');
        expect(toggleMark(u.text, u.selStart, u.selEnd, 'underline').text).toBe('');
        // An italic pressed inside an empty BOLD pair is not that pair.
        expect(toggleMark('x ****', 4, 4, 'italic').text).toBe('x ******');
    });

    it('a selection inside a word takes the whole word: what it writes always reads back marked', () => {
        const r = toggleMark('abcdef', 2, 4, 'bold');
        expect(r.text).toBe('**abcdef**');
        expect(runs(r.text)).toEqual(['abcdef[b]']);
        for (const [text, s, e] of [['ab cd', 1, 4], ['x yz', 4, 4], ['snake_case', 6, 8], ['héllo wörld', 2, 9]] as const) {
            for (const k of ['bold', 'italic', 'underline', 'strike'] as const) {
                const out = toggleMark(text, s, e, k);
                const marked = readNoteFormat(out.text)[0].runs.filter(x => x.marks[k]);
                expect(marked.length, `${k} on ${text} [${s},${e}] → ${out.text}`).toBeGreaterThan(0);
            }
        }
    });

    it('marks a selection over several lines line by line', () => {
        const r = toggleMark('one\n\ntwo', 0, 8, 'bold');
        expect(r.text).toBe('**one**\n\n**two**');
        expect(readNoteFormat(r.text).filter(l => l.runs.some(x => x.marks.bold))).toHaveLength(2);
    });
});

describe('Ctrl+Shift+L and Enter on a bullet', () => {
    it('makes the touched lines bullets, and takes them off again', () => {
        const on = toggleBullets('milk\neggs\n\nbread', 0, 9);
        expect(on.text).toBe('- milk\n- eggs\n\nbread');
        const off = toggleBullets(on.text, on.selStart, on.selEnd);
        expect(off.text).toBe('milk\neggs\n\nbread');
    });

    it('a bullet on the caret line only, the caret kept on its word', () => {
        const r = toggleBullets('a\nmilk', 4, 4);
        expect(r.text).toBe('a\n- milk');
        expect(r.selStart).toBe(6);
    });

    it('starts a bullet on a blank line', () => {
        expect(toggleBullets('', 0, 0)).toEqual({ text: '- ', selStart: 2, selEnd: 2 });
    });

    it('Enter on a bullet continues it, and on an empty bullet ends the list', () => {
        expect(continueBullet('- milk', 6, 6)).toEqual({ text: '- milk\n- ', selStart: 9, selEnd: 9 });
        expect(continueBullet('  * a', 5, 5)?.text).toBe('  * a\n  * ');
        expect(continueBullet('- milk\n- ', 9, 9)).toEqual({ text: '- milk\n', selStart: 7, selEnd: 7 });
        expect(continueBullet('plain', 5, 5)).toBeNull();
        expect(continueBullet('- milk', 1, 1)).toBeNull();
        expect(continueBullet('- milk', 2, 4)).toBeNull();
    });
});
