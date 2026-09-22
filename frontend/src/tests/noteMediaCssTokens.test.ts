/**
 * The picture/file/parked chrome is themed by TOKENS, not by colours
 * (components/NoteImages.css, notes/notes.css).
 *
 * Two rules, and both have cost real time here:
 *
 *  - `var(--made-up)` with NO fallback is invalid at computed-value time.
 *    For an inherited property that silently means `inherit`; for a
 *    shorthand like `border: 1px solid var(--border-color)` the WHOLE
 *    declaration resets, so `border-style` becomes `none` and the control
 *    loses its outline on every theme. Nothing goes red, nothing logs — the
 *    button just looks wrong. So every custom property these files name
 *    without a fallback must actually be defined by some stylesheet.
 *
 *  - a LITERAL COLOUR as the fallback (`var(--success, #4caf50)`) is the
 *    same class of problem CLAUDE.md states for emoji: a fixed colour that
 *    ignores all eight themes and [data-contrast="high"]. A fallback is for
 *    a value the page sets from JS (`--depth`, `--font-mono`), never for a
 *    colour.
 *
 * Positive control below: the same two checks, run over a string that breaks
 * both, must report them — otherwise a scanner that found nothing would pass
 * these files for free.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(SRC, '..');

/** Every custom property any stylesheet in the app defines. */
function definedProperties(): Set<string> {
    const out = new Set<string>();
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.css')) {
                for (const m of fs.readFileSync(p, 'utf8').matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) out.add(m[1]);
            }
        }
    };
    walk(SRC);
    for (const html of ['index.html', 'notes.html']) {
        const p = path.join(FRONTEND, html);
        if (fs.existsSync(p)) for (const m of fs.readFileSync(p, 'utf8').matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) out.add(m[1]);
    }
    return out;
}

/** `var(--x)` and `var(--x, fallback)`, with the fallback text as written. */
function varUses(css: string): Array<{ name: string; fallback: string | null }> {
    const out: Array<{ name: string; fallback: string | null }> = [];
    for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*(,([^()]*(?:\([^()]*\))?[^()]*))?\)/g)) {
        out.push({ name: m[1], fallback: m[3] === undefined ? null : m[3].trim() });
    }
    return out;
}

// `transparent` is the ABSENCE of a colour, which is what a JS-set tint
// (`var(--tint, transparent)`) should fall back to; it fights no theme.
const COLOUR = /^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|black|white|red|green|blue|gray|grey|silver)/;

function undefinedTokens(css: string, defined: ReadonlySet<string>): string[] {
    return [...new Set(varUses(css).filter(u => u.fallback === null && !defined.has(u.name)).map(u => u.name))].sort();
}
function colourFallbacks(css: string): string[] {
    return varUses(css).filter(u => u.fallback !== null && COLOUR.test(u.fallback)).map(u => `${u.name} -> ${u.fallback}`).sort();
}

const FILES = ['components/NoteImages.css', 'notes/notes.css'];

describe('a note’s pictures and files are themed by tokens', () => {
    const defined = definedProperties();

    it('the theme vocabulary was actually read', () => {
        // Without this the two checks below pass for free on an empty set.
        expect(defined.size).toBeGreaterThan(50);
        for (const t of ['--text-normal', '--text-muted', '--text-danger', '--border-subtle', '--bg-secondary']) {
            expect(defined.has(t)).toBe(true);
        }
        // And the vocabulary the round-one diff reached for is NOT in it.
        for (const t of ['--text-secondary', '--text-primary', '--border-color', '--success', '--danger', '--bg-elevated']) {
            expect(defined.has(t)).toBe(false);
        }
    });

    for (const rel of FILES) {
        it(`${rel} names no custom property that nothing defines`, () => {
            const css = fs.readFileSync(path.join(SRC, rel), 'utf8');
            expect(varUses(css).length).toBeGreaterThan(20);   // the scan found the file
            expect(undefinedTokens(css, defined)).toEqual([]);
        });

        it(`${rel} never falls back to a fixed colour`, () => {
            const css = fs.readFileSync(path.join(SRC, rel), 'utf8');
            expect(colourFallbacks(css)).toEqual([]);
        });
    }

    it('the checks themselves can fail (positive control)', () => {
        const bad = [
            '.x { border: 1px solid var(--border-color); }',
            '.y { color: var(--success, #4caf50); }',
            '.z { background: var(--bg-elevated, rgba(0, 0, 0, 0.72)); }',
            '.ok { color: var(--text-muted); font-family: var(--font-mono, ui-monospace, monospace); }',
        ].join('\n');
        expect(undefinedTokens(bad, defined)).toEqual(['--border-color']);
        expect(colourFallbacks(bad)).toEqual(['--bg-elevated -> rgba(0, 0, 0, 0.72)', '--success -> #4caf50']);
    });
});
