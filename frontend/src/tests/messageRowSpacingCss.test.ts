/**
 * Message rows in the chat list never overlap (components/Chat.css, the
 * `.message` rhythm block).
 *
 * The owner's report, 2026-10-04 ("Images stretch over text"): a grouped row
 * was pulled up by `margin-top: -7px`, meant to cancel the PREVIOUS row's
 * 0.5rem bottom padding. After a grouped row (1px bottom padding) it pulled
 * the next row ~5px INTO the line above, and a grouped image covered the end
 * of that line. Compact mode had the same shape (-3px), and its hover rule
 * reset the grouped rows' vertical padding, so every hover moved the rows
 * below by ~3px.
 *
 * jsdom has no layout, so the overlap itself is measured in a real browser by
 * e2e/message-overlap-live.mjs. This guards the two RULES that make overlap
 * impossible, on every vitest run:
 *   1. no CSS rule whose subject is a message row gives it a negative
 *      vertical margin (rows are separated by their own padding only);
 *   2. no rule for a HOVERED message row sets vertical padding or margin
 *      (hover may only stretch the background sideways).
 * A positive control runs both checks over the old rules, which they must
 * report — a scanner that matched nothing would otherwise pass for free.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Rule { file: string; selector: string; decls: Array<[string, string]> }

/** Plain-CSS rules (selector + declarations), including those inside @media. */
function cssRules(css: string, file: string): Rule[] {
    const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: Rule[] = [];
    let pos = 0;
    while (pos < s.length) {
        const open = s.indexOf('{', pos);
        const close = s.indexOf('}', pos);
        if (open === -1) break;
        if (close !== -1 && close < open) { pos = close + 1; continue; } // end of an @-block
        let prelude = s.slice(pos, open);
        prelude = prelude.slice(prelude.lastIndexOf(';') + 1).trim(); // drop a preceding @import
        if (prelude.startsWith('@')) { pos = open + 1; continue; }   // descend into @media / @supports
        const end = s.indexOf('}', open);
        const decls = s.slice(open + 1, end).split(';').map(d => d.trim()).filter(Boolean).map(d => {
            const i = d.indexOf(':');
            return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()] as [string, string];
        });
        out.push({ file, selector: prelude, decls });
        pos = end + 1;
    }
    return out;
}

/** The last compound of one selector (its subject), split outside parentheses. */
function subject(selector: string): string {
    let depth = 0, cur = '', last = '';
    for (const ch of selector) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (depth === 0 && /[\s>+~]/.test(ch)) { if (cur) last = cur; cur = ''; continue; }
        cur += ch;
    }
    return cur || last;
}

/** Split a selector list on commas outside parentheses. */
function selectors(list: string): string[] {
    let depth = 0, cur = '';
    const out: string[] = [];
    for (const ch of list) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

const withoutParens = (s: string) => s.replace(/\([^()]*(\([^()]*\)[^()]*)*\)/g, '()');
/** Is this selector's subject a message ROW (`.message`, not `.message-content`)? */
const isRow = (sel: string) => /\.message(?![\w-])/.test(withoutParens(subject(sel)));
const isHoveredRow = (sel: string) => isRow(sel) && /:hover/.test(withoutParens(subject(sel)));

/** The vertical components of a margin/padding shorthand (top, bottom). */
function verticalParts(value: string): string[] {
    const v = value.replace(/!important/, '').trim().split(/\s+(?![^()]*\))/);
    if (v.length === 1) return [v[0]];
    if (v.length === 2) return [v[0]];
    return [v[0], v[2]];
}
const VERTICAL_MARGIN = /^margin-(top|bottom|block|block-start|block-end)$/;
const VERTICAL_PADDING = /^padding-(top|bottom|block|block-start|block-end)$/;

/** A negative length: `-7px`, `-0.45rem`, `-.5em`, `calc(-…)` — not a signed zero. */
function isNegative(part: string): boolean {
    const m = /^-(\d*\.?\d+)/.exec(part);
    return (!!m && parseFloat(m[1]) > 0) || /^calc\(\s*-/.test(part);
}

function negativeRowMargins(rules: Rule[]): string[] {
    const out: string[] = [];
    for (const r of rules) {
        const rows = selectors(r.selector).filter(isRow);
        if (!rows.length) continue;
        for (const [prop, value] of r.decls) {
            const parts = prop === 'margin' ? verticalParts(value) : VERTICAL_MARGIN.test(prop) ? value.split(/\s+/) : [];
            if (parts.some(isNegative)) out.push(`${r.file}: ${rows.join(', ')} { ${prop}: ${value} }`);
        }
    }
    return out;
}

function verticalHoverChanges(rules: Rule[]): string[] {
    const out: string[] = [];
    for (const r of rules) {
        const hovered = selectors(r.selector).filter(isHoveredRow);
        if (!hovered.length) continue;
        for (const [prop, value] of r.decls) {
            if (prop === 'margin' || prop === 'padding' || VERTICAL_MARGIN.test(prop) || VERTICAL_PADDING.test(prop)) {
                out.push(`${r.file}: ${hovered.join(', ')} { ${prop}: ${value} }`);
            }
        }
    }
    return out;
}

function allRules(): Rule[] {
    const out: Rule[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.css')) out.push(...cssRules(fs.readFileSync(p, 'utf8'), path.relative(SRC, p).replace(/\\/g, '/')));
        }
    };
    walk(SRC);
    return out;
}

describe('message rows never overlap their neighbours', () => {
    const rules = allRules();
    const rowRules = rules.filter(r => selectors(r.selector).some(isRow));

    it('the scanner actually read the message-row rules', () => {
        // Without this, both checks below pass on an empty list.
        expect(rowRules.length).toBeGreaterThan(5);
        expect(rowRules.some(r => selectors(r.selector).includes('.message.grouped'))).toBe(true);
        expect(rowRules.some(r => selectors(r.selector).some(isHoveredRow))).toBe(true);
        // ...and did NOT mistake a child for the row.
        expect(isRow('.message:hover .message-actions')).toBe(false);
        expect(isRow('.message-content')).toBe(false);
        expect(isRow('.message:has(+ .message.grouped)')).toBe(true);
    });

    it('no message row is pulled into its neighbour by a negative vertical margin', () => {
        expect(negativeRowMargins(rules)).toEqual([]);
    });

    it('hovering a message row changes no vertical padding or margin', () => {
        expect(verticalHoverChanges(rules)).toEqual([]);
    });

    it('CONTROL: the rules that overlapped the rows are reported', () => {
        const old = cssRules(`
            .message:hover { background: x; margin: 0 -1.25rem; padding: 0.5rem 1.25rem; }
            .message.grouped { padding-top: 1px; padding-bottom: 1px; margin-top: -7px; }
            @media (pointer: coarse) { [data-compact="true"] .message:hover { padding: 0.15rem 1.25rem; } }
            [data-compact="true"] .message.grouped { margin-top: -3px; }
            .message:hover .message-actions { margin-top: -18px; padding: 4px; }
            .message-content { margin: -4px 0 0; }
            .message.grouped.later { margin-block-start: -0.45rem; }
            .message.mentioned { margin: 0 -1rem -.5em; }
            .message.zeroed { margin-top: -0; margin-bottom: -0.0px; margin: -0 -1rem; }
        `, 'control.css');
        expect(negativeRowMargins(old)).toEqual([
            'control.css: .message.grouped { margin-top: -7px }',
            'control.css: [data-compact="true"] .message.grouped { margin-top: -3px }',
            'control.css: .message.grouped.later { margin-block-start: -0.45rem }',
            'control.css: .message.mentioned { margin: 0 -1rem -.5em }',
        ]);
        expect(verticalHoverChanges(old)).toEqual([
            'control.css: .message:hover { margin: 0 -1.25rem }',
            'control.css: .message:hover { padding: 0.5rem 1.25rem }',
            'control.css: [data-compact="true"] .message:hover { padding: 0.15rem 1.25rem }',
        ]);
    });
});
