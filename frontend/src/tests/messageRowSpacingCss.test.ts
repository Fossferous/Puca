/**
 * Static tripwire for the chat list's row spacing (components/Chat.css, the
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
 * jsdom has no layout, so whether anything overlaps is MEASURED in a real
 * browser by e2e/message-overlap-live.mjs — that walk is the proof. This file
 * only catches, on every vitest run, the CSS shapes that caused it and their
 * nearest relatives:
 *   1. a negative vertical margin on a message ROW (`.message`,
 *      `.blocked-message-stub`), or on anything inside one — a selector that
 *      names a row or a `message-*` part above its subject, or whose subject
 *      is a `message-*` part (`.message-content`, `.message-image`, ...);
 *   2. a row moved off its place in the flow: `top`/`bottom`/`inset`,
 *      `position` other than static/relative, `transform`/`translate`/
 *      `scale`/`rotate`/`zoom`;
 *   3. a HOVERED row that sets vertical padding or margin (hover may only
 *      stretch the background sideways).
 * Exempt: the hover toolbar (`.message-actions`), which is absolutely
 * positioned and floats over the row above on purpose; and `message-form` /
 * `message-toast*`, which are not in the list.
 *
 * It CANNOT see — only the walk can, and only for what its fixture renders: a
 * negative margin on a part whose class is not `message-*` and whose selector
 * names no row (say `.reaction-badge`); `top`/`transform` on anything inside
 * a row; an absolutely positioned part; an animation's keyframes; an inline
 * `style=` in the TSX; anything set from script. So a green run here does not
 * mean "no overlap" — run the walk after any change to the list's layout.
 *
 * A positive control runs every check over rules that break it, which they
 * must report — a scanner that matched nothing would otherwise pass for free.
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

/** The compounds of one selector, in order (the last is its subject), split
 *  on combinators outside parentheses. */
function compounds(selector: string): string[] {
    let depth = 0, cur = '';
    const out: string[] = [];
    for (const ch of selector) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (depth === 0 && /[\s>+~]/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

/** The last compound of one selector (its subject). */
const subject = (selector: string) => compounds(selector).pop() || '';

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
/** The classes a compound itself requires (not those inside :has()/:not()). */
const classesOf = (compound: string) => [...withoutParens(compound).matchAll(/\.([\w-]+)/g)].map(m => m[1]);

/** Classes that only ever sit ON a message row element (Chat.tsx). */
const ROW_CLASSES = new Set(['message', 'blocked-message-stub']);
const isRowCompound = (c: string) => classesOf(c).some(k => ROW_CLASSES.has(k));
/** A part inside a row: `message-*`, except the composer and the toasts. */
const isRowPartCompound = (c: string) => classesOf(c).some(k => k.startsWith('message-') && !/^message-(form|toasts?)(-|$)/.test(k));
/** The hover toolbar: position:absolute, floats over the row above on purpose
 *  (the walk excludes it too). Everything inside it is out of the flow. */
const isOutOfFlowCompound = (c: string) => classesOf(c).includes('message-actions');

/** Is this selector's subject a message ROW (`.message`, not `.message-content`)? */
const isRow = (sel: string) => isRowCompound(subject(sel));
const isHoveredRow = (sel: string) => isRow(sel) && /:hover/.test(withoutParens(subject(sel)));
/** Is this selector's subject INSIDE a message row, in the flow? */
function isInRow(sel: string): boolean {
    const cs = compounds(sel);
    if (!cs.length || isRow(sel) || cs.some(isOutOfFlowCompound)) return false;
    return cs.slice(0, -1).some(c => isRowCompound(c) || isRowPartCompound(c)) || isRowPartCompound(cs[cs.length - 1]);
}

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

/** Negative vertical margins on a row, or on anything in the flow inside one. */
function negativeRowMargins(rules: Rule[]): string[] {
    const out: string[] = [];
    for (const r of rules) {
        const hit = selectors(r.selector).filter(s => isRow(s) || isInRow(s));
        if (!hit.length) continue;
        for (const [prop, value] of r.decls) {
            const parts = prop === 'margin' ? verticalParts(value) : VERTICAL_MARGIN.test(prop) ? value.split(/\s+/) : [];
            if (parts.some(isNegative)) out.push(`${r.file}: ${hit.join(', ')} { ${prop}: ${value} }`);
        }
    }
    return out;
}

const isZeroOrAuto = (v: string) => v.replace(/!important/, '').trim().split(/\s+/).every(p => p === 'auto' || /^[+-]?0*\.?0*(px|rem|em|%|vh)?$/.test(p));
const OFFSET = /^(top|bottom|inset|inset-block|inset-block-start|inset-block-end)$/;
const TRANSFORM = /^(transform|translate|scale|rotate|zoom)$/;

/** Anything that moves a row off its place in the flow. */
function rowOffsets(rules: Rule[]): string[] {
    const out: string[] = [];
    for (const r of rules) {
        const rows = selectors(r.selector).filter(isRow);
        if (!rows.length) continue;
        for (const [prop, value] of r.decls) {
            const v = value.replace(/!important/, '').trim();
            const moves = (OFFSET.test(prop) && !isZeroOrAuto(v))
                || (prop === 'position' && !/^(static|relative)$/.test(v))
                || (TRANSFORM.test(prop) && !/^(none|normal|1)$/.test(v));
            if (moves) out.push(`${r.file}: ${rows.join(', ')} { ${prop}: ${value} }`);
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

describe('message rows never overlap their neighbours (static rules)', () => {
    const rules = allRules();
    const rowRules = rules.filter(r => selectors(r.selector).some(isRow));
    const inRowRules = rules.filter(r => selectors(r.selector).some(isInRow));

    it('the scanner actually read the message-row rules', () => {
        // Without this, every check below passes on an empty list.
        expect(rowRules.length).toBeGreaterThan(5);
        expect(rowRules.some(r => selectors(r.selector).includes('.message.grouped'))).toBe(true);
        expect(rowRules.some(r => selectors(r.selector).some(isHoveredRow))).toBe(true);
        expect(rowRules.some(r => selectors(r.selector).includes('.blocked-message-stub'))).toBe(true);
        expect(inRowRules.some(r => selectors(r.selector).includes('.message.grouped .message-content'))).toBe(true);
        expect(inRowRules.length).toBeGreaterThan(10);
        // ...and told a row, a part in the flow, and everything else apart.
        expect(isRow('.message:has(+ .message.grouped)')).toBe(true);
        expect(isRow('[data-compact="true"] .blocked-message-stub')).toBe(true);
        expect(isRow('.message:hover .message-actions')).toBe(false);
        expect(isRow('.message-content')).toBe(false);
        expect(isInRow('.message-content')).toBe(true);
        expect(isInRow('.message.grouped .message-content')).toBe(true);
        expect(isInRow('.spoiler:not(.revealed) .message-image img')).toBe(true);
        expect(isInRow('.message:hover .message-actions')).toBe(false);
        expect(isInRow('.message-actions .msg-action-btn')).toBe(false);
        expect(isInRow('.message-form textarea')).toBe(false);
        expect(isInRow('.message-toast-title')).toBe(false);
        expect(isInRow('.spoiler:has(.message-image, .message-video)')).toBe(false);
    });

    it('no message row, nor anything in the flow inside one, has a negative vertical margin', () => {
        expect(negativeRowMargins(rules)).toEqual([]);
    });

    it('no message row is moved off its place in the flow', () => {
        expect(rowOffsets(rules)).toEqual([]);
    });

    it('hovering a message row changes no vertical padding or margin', () => {
        expect(verticalHoverChanges(rules)).toEqual([]);
    });

    it('CONTROL: rules that overlap the rows are reported', () => {
        const bad = cssRules(`
            .message:hover { background: x; margin: 0 -1.25rem; padding: 0.5rem 1.25rem; }
            .message.grouped { padding-top: 1px; padding-bottom: 1px; margin-top: -7px; }
            @media (pointer: coarse) { [data-compact="true"] .message:hover { padding: 0.15rem 1.25rem; } }
            [data-compact="true"] .message.grouped { margin-top: -3px; }
            .message.grouped.later { margin-block-start: -0.45rem; }
            .message.mentioned { margin: 0 -1rem -.5em; }
            .message.zeroed { margin-top: -0; margin-bottom: -0.0px; margin: -0 -1rem; }
            .message.grouped .message-content { margin-top: -6px; }
            .message-content { margin: -4px 0 0; }
            .spoiler .message-image img { margin-bottom: calc(-1 * 4px); }
            .message.grouped { position: relative; top: -6px; }
            .message.highlight { transform: translateY(-4px); }
            .message.sticky { position: sticky; inset: 2px auto auto; }
            .blocked-message-stub:hover { padding: 8px 20px; }
            .message { position: relative; top: 0; bottom: auto; transform: none; }
            .message:hover .message-actions { margin-top: -18px; top: -18px; padding: 4px; }
            .message-form textarea { margin-top: -2px; }
            .message-toast { margin-bottom: -8px; }
        `, 'control.css');
        expect(negativeRowMargins(bad)).toEqual([
            'control.css: .message.grouped { margin-top: -7px }',
            'control.css: [data-compact="true"] .message.grouped { margin-top: -3px }',
            'control.css: .message.grouped.later { margin-block-start: -0.45rem }',
            'control.css: .message.mentioned { margin: 0 -1rem -.5em }',
            'control.css: .message.grouped .message-content { margin-top: -6px }',
            'control.css: .message-content { margin: -4px 0 0 }',
            'control.css: .spoiler .message-image img { margin-bottom: calc(-1 * 4px) }',
        ]);
        expect(rowOffsets(bad)).toEqual([
            'control.css: .message.grouped { top: -6px }',
            'control.css: .message.highlight { transform: translateY(-4px) }',
            'control.css: .message.sticky { position: sticky }',
            'control.css: .message.sticky { inset: 2px auto auto }',
        ]);
        expect(verticalHoverChanges(bad)).toEqual([
            'control.css: .message:hover { margin: 0 -1.25rem }',
            'control.css: .message:hover { padding: 0.5rem 1.25rem }',
            'control.css: [data-compact="true"] .message:hover { padding: 0.15rem 1.25rem }',
            'control.css: .blocked-message-stub:hover { padding: 8px 20px }',
        ]);
    });
});
