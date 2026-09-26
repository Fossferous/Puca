/**
 * What the app may animate FOREVER.
 *
 * Measured 2026-09-26 (e2e/idle-call-cost.mjs, a 6-person call on a throwaway
 * stack, the client pinned to the integrated GPU like the desktop app): just
 * sitting in the call re-styled the page 165 times a second — every frame of a
 * 165 Hz monitor — and held the integrated GPU's 3D engine at ~18%. The
 * speaking rings, the LIVE badges and the "watch" buttons pulsed a
 * box-shadow in an infinite loop; a box-shadow cannot be animated on the
 * compositor, so each frame repainted and re-rastered them, for hours.
 *
 * The rules:
 *  1. An infinite animation may only touch `opacity` and `transform` (the two
 *     properties the compositor animates without repainting), except the few
 *     named below, which are never on screen during a call.
 *  2. The elements that are on screen for a whole call may not animate
 *     forever at all: even a compositor animation is a GPU frame every vsync.
 *     They pulse a few times when they appear, then hold still.
 *  3. A @keyframes name defined in more than one file must mean the same thing
 *     everywhere. Keyframes are global: `pulse` was defined in four files with
 *     four different bodies, and which one ran depended on load order.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');

function cssFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : cssFiles(p);
        return e.name.endsWith('.css') ? [p] : [];
    });
}

interface Rule { file: string; selector: string; body: string }
interface Frames { file: string; name: string; body: string; props: string[] }

/** A small brace-matching reader: top-level rules, rules inside @media and
 *  friends, and @keyframes blocks (kept whole). Comments are stripped. */
function parse(file: string): { rules: Rule[]; frames: Frames[] } {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules: Rule[] = [];
    const frames: Frames[] = [];
    const walk = (s: string) => {
        let i = 0;
        while (i < s.length) {
            const open = s.indexOf('{', i);
            if (open < 0) return;
            const head = s.slice(i, open).trim();
            let depth = 1, j = open + 1;
            while (j < s.length && depth > 0) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
            const body = s.slice(open + 1, j - 1);
            const kf = head.match(/@(?:-webkit-)?keyframes\s+([\w-]+)/);
            if (kf) {
                const props = [...new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]))].sort();
                frames.push({ file, name: kf[1], body: body.replace(/\s+/g, ' ').trim(), props });
            } else if (head.startsWith('@')) {
                walk(body);
            } else {
                rules.push({ file, selector: head, body });
            }
            i = j;
        }
    };
    walk(text);
    return { rules, frames };
}

const parsed = cssFiles(SRC).map(parse);
const rules = parsed.flatMap(p => p.rules);
const frames = parsed.flatMap(p => p.frames);
const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, '/');

/** name of the keyframes an `animation:` shorthand runs, if any. */
function animationName(value: string): string | null {
    const words = value.split(/[\s,]+/).filter(Boolean);
    const skip = /^(\d+(\.\d+)?m?s|infinite|\d+|linear|ease(-in|-out|-in-out)?|step-start|step-end|alternate(-reverse)?|reverse|normal|forwards|backwards|both|none|running|paused|cubic-bezier\(.*|steps\(.*)$/;
    return words.find(w => !skip.test(w)) ?? null;
}

const infinite = rules.flatMap(r => [...r.body.matchAll(/animation\s*:\s*([^;]+);?/g)]
    .filter(m => /\binfinite\b/.test(m[1]))
    .map(m => ({ ...r, name: animationName(m[1]) })));

/** Never on screen during a call, and transient where they are. */
const EXEMPT = new Set(['components/Login.css gradient', 'components/StreamStage.css progress-bar-stripes']);

describe('infinite animations', () => {
    it("touch only opacity and transform (the compositor's properties)", () => {
        expect(infinite.length).toBeGreaterThan(5); // POSITIVE CONTROL: the reader found them
        const bad = infinite.flatMap(a => {
            const defs = frames.filter(f => f.name === a.name);
            const props = [...new Set(defs.flatMap(d => d.props))];
            const off = props.filter(p => p !== 'opacity' && p !== 'transform');
            return off.length && !EXEMPT.has(`${rel(a.file)} ${a.name}`) ? [`${rel(a.file)} ${a.selector} → ${a.name}: ${off.join(', ')}`] : [];
        });
        expect(bad).toEqual([]);
    });

    it('are not used on what stays on screen for a whole call', () => {
        // Everything here is visible for as long as somebody talks or
        // streams; one pulse loop is a GPU frame every vsync for hours.
        const always = /\.voice-user-avatar-small\.speaking|\.voice-user-avatar\.speaking|\.voice-user\.speaking|\.voice-user-item\.speaking|\.live-badge-mini|\.live-badge\b|\.watch-streams-btn|\.watch-live-btn|\.live-dot\b|\.live-dot-mini|\.live-indicator-dot/;
        const hit = infinite.filter(a => always.test(a.selector)).map(a => `${rel(a.file)} ${a.selector}`);
        expect(hit).toEqual([]);
        // POSITIVE CONTROL: those selectors exist (a rename would make this vacuous).
        expect(rules.some(r => /\.live-badge-mini/.test(r.selector))).toBe(true);
        expect(rules.some(r => /\.voice-user-avatar\.speaking/.test(r.selector))).toBe(true);
    });
});

describe('@keyframes names', () => {
    it('mean the same thing in every file that defines them', () => {
        const byName = new Map<string, Frames[]>();
        for (const f of frames) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
        const clashes = [...byName.entries()]
            .filter(([, defs]) => new Set(defs.map(d => d.body)).size > 1)
            .map(([name, defs]) => `${name}: ${defs.map(d => rel(d.file)).join(', ')}`);
        expect(clashes).toEqual([]);
    });
});
