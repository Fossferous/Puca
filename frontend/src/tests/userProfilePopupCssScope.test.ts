/**
 * The member profile popup's stylesheet and every other component stylesheet
 * must not style each other.
 *
 * All component CSS is global once imported, and Chat.tsx imports both
 * UserProfilePopup.css and UserProfileSettings.css. Both used the generic
 * `.profile-section`, so the settings card look (bg-tertiary, 8px radius,
 * 16px padding, `.profile-section + .profile-section { margin-top: 16px }`)
 * landed on every popup section — about 40px the popup never asked for, and
 * part of why its Manage Roles list was squeezed to a 38px strip — while the
 * popup's own unscoped rules leaked a border into Settings. FriendsPanel's
 * `.status-indicator` (an absolutely positioned 14px dot) and the context
 * menu's / role modal's `.role-checkbox` / `.role-name` collided the same way.
 *
 * Two rules keep it from coming back, both checked over the real files:
 *  1. every rule in UserProfilePopup.css is scoped under `.user-profile-popup`
 *     (nothing leaks OUT);
 *  2. no class the popup renders is a class another stylesheet styles
 *     (nothing leaks IN) — including the modifiers a className switches in,
 *     `upp-sheet` (the whole phone box) above all, which an earlier version
 *     of this scan dropped with the rest of every `${...}`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const POPUP_CSS = path.join(SRC, 'components', 'UserProfilePopup.css');
const POPUP_TSX = path.join(SRC, 'components', 'UserProfilePopup.tsx');

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.css')) out.push(p);
    }
    return out;
}

/** Top-level selectors of a stylesheet, with @keyframes bodies skipped and
 *  @media/@supports blocks descended into. Comments stripped. */
function selectors(css: string): string[] {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: string[] = [];
    const readBlock = (start: number): number => {
        // returns index just past the matching '}' for the '{' at start
        let depth = 0;
        for (let j = start; j < text.length; j++) {
            if (text[j] === '{') depth++;
            else if (text[j] === '}') { depth--; if (depth === 0) return j + 1; }
        }
        return text.length;
    };
    const scan = (from: number, to: number) => {
        let k = from;
        while (k < to) {
            const open = text.indexOf('{', k);
            if (open === -1 || open >= to) break;
            const prelude = text.slice(k, open).trim();
            const end = readBlock(open);
            if (/^@(media|supports|container|layer)\b/.test(prelude)) {
                scan(open + 1, end - 1);
            } else if (!prelude.startsWith('@')) {
                for (const s of prelude.split(',')) if (s.trim()) out.push(s.trim());
            }
            k = end;
        }
    };
    scan(0, text.length);
    return out;
}

const CLASS_TOKEN = /^[a-z][a-z0-9-]*$/;

/** Class tokens the popup renders, from every className="..." /
 *  className={`...`}: `statics` are the literal parts; `modifiers` are the
 *  string literals a ${...} switches in (`cond ? ' upp-sheet' : ''`, `a ? 'online'
 *  : 'offline'`). Only literals that are a branch of `?` / `:` / `&&` count — a
 *  comparison operand such as `presentation === 'sheet'` is not a class. */
function popupClassTokens(tsx: string): { statics: string[]; modifiers: string[] } {
    const statics = new Set<string>();
    const modifiers = new Set<string>();
    for (const m of tsx.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const text = m[1] ?? m[2] ?? '';
        for (const t of text.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (CLASS_TOKEN.test(t)) statics.add(t);
        for (const expr of text.matchAll(/\$\{([^}]*)\}/g)) {
            for (const lit of expr[1].matchAll(/(?:\?|:|&&)\s*(['"])([^'"]*)\1/g)) {
                for (const t of lit[2].split(/\s+/)) if (CLASS_TOKEN.test(t)) modifiers.add(t);
            }
        }
    }
    for (const t of statics) modifiers.delete(t);
    return { statics: [...statics], modifiers: [...modifiers] };
}

/** The static class tokens (checked strictly: no other stylesheet may name them at all). */
function popupClasses(tsx: string): string[] {
    return popupClassTokens(tsx).statics;
}

/** Does `selector` style a popup element through one of its modifiers? A
 *  modifier is a generic word (`online`, `pending`), so it only reaches the
 *  popup through a compound whose every class is one the popup renders —
 *  `.upp-sheet` alone or `.upp-status.online` does; `.member-item.online`
 *  cannot. */
function modifierLeak(selector: string, modifiers: string[], popupAll: string[]): boolean {
    for (const compound of selector.split(/\s*[\s>+~]\s*/)) {
        const classes = [...compound.matchAll(/\.([\w-]+)/g)].map(c => c[1]);
        if (classes.some(c => modifiers.includes(c)) && classes.every(c => popupAll.includes(c))) return true;
    }
    return false;
}

const hasClass = (selector: string, cls: string) =>
    new RegExp(`\\.${cls.replace(/-/g, '\\-')}(?![\\w-])`).test(selector);

describe('UserProfilePopup CSS scope', () => {
    it('finds the popup classes and selectors it is checking (the scan is not vacuous)', () => {
        const classes = popupClasses(fs.readFileSync(POPUP_TSX, 'utf8'));
        expect(classes).toContain('user-profile-popup');
        expect(classes.length).toBeGreaterThan(15);
        expect(selectors(fs.readFileSync(POPUP_CSS, 'utf8')).length).toBeGreaterThan(30);
        // Positive control for the leak-in check: a stylesheet that certainly
        // shares a class with another component is caught by the same matcher.
        expect(selectors('.a .x-btn:hover, .y { color: red }').some(s => hasClass(s, 'x-btn'))).toBe(true);
        expect(selectors('.x-btn-wide { color: red }').some(s => hasClass(s, 'x-btn'))).toBe(false);
    });

    it('also checks the class-name modifiers the popup switches on, upp-sheet (the phone box) above all', () => {
        const { modifiers } = popupClassTokens(fs.readFileSync(POPUP_TSX, 'utf8'));
        expect(modifiers).toContain('upp-sheet');
        // A comparison operand inside ${...} is not a class.
        expect(modifiers).not.toContain('sheet');
        const all = [...popupClasses(fs.readFileSync(POPUP_TSX, 'utf8')), ...modifiers];
        // Positive controls: a modifier on its own, or compounded only with
        // popup classes, styles the popup; compounded with some other
        // component's class it cannot.
        expect(modifierLeak('.upp-sheet', modifiers, all)).toBe(true);
        expect(modifierLeak('.app .upp-sheet:hover', modifiers, all)).toBe(true);
        expect(modifierLeak('.upp-status.online', modifiers, all)).toBe(true);
        expect(modifierLeak('.member-item.online', modifiers, all)).toBe(false);
        expect(modifierLeak('.online-count', modifiers, all)).toBe(false);
    });

    it('every rule in UserProfilePopup.css is scoped under .user-profile-popup (nothing leaks out)', () => {
        const unscoped = selectors(fs.readFileSync(POPUP_CSS, 'utf8'))
            .filter(s => !/^\.user-profile-popup(?![\w-])/.test(s));
        expect(unscoped).toEqual([]);
    });

    it('no class the popup renders is styled by another stylesheet (nothing leaks in)', () => {
        const { statics: classes, modifiers } = popupClassTokens(fs.readFileSync(POPUP_TSX, 'utf8'));
        const all = [...classes, ...modifiers];
        const collisions: string[] = [];
        for (const file of walk(SRC)) {
            if (path.resolve(file) === path.resolve(POPUP_CSS)) continue;
            for (const sel of selectors(fs.readFileSync(file, 'utf8'))) {
                for (const cls of classes) {
                    if (hasClass(sel, cls)) collisions.push(`${path.relative(SRC, file)}: ${sel}  (.${cls})`);
                }
                if (modifierLeak(sel, modifiers, all)) collisions.push(`${path.relative(SRC, file)}: ${sel}  (modifier)`);
            }
        }
        expect(collisions).toEqual([]);
    });
});
