import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Message notifications (src-tauri/src/toasts.rs) are in BOTH desktop
 * variants, and the Lite one is built with `--no-default-features`, so
 * without the `remote-control` feature. toasts.rs first shipped on
 * `crate::ordered_worker`, which lib.rs compiled only WITH that feature:
 * `cargo check --no-default-features` failed with E0433, and no gate or CI
 * job builds the shell that way on Windows, so the Lite installer would have
 * failed at release time. These read the source the compiler reads.
 */

const lib = readFileSync(resolve(__dirname, '../../src-tauri/src/lib.rs'), 'utf8').replace(/\r\n/g, '\n');
const toasts = readFileSync(resolve(__dirname, '../../src-tauri/src/toasts.rs'), 'utf8').replace(/\r\n/g, '\n');

/** Each `mod x;` in lib.rs and the cfg attributes right above it. */
function modules(): Map<string, string[]> {
    const lines = lib.split('\n');
    const out = new Map<string, string[]>();
    lines.forEach((line, i) => {
        const m = line.match(/^(?:pub(?:\([^)]*\))? )?mod (\w+);/);
        if (!m) return;
        const attrs: string[] = [];
        for (let j = i - 1; j >= 0; j--) {
            const above = lines[j].trim();
            if (above.startsWith('#[')) attrs.push(above);
            else if (above.startsWith('//')) continue;
            else break;
        }
        out.set(m[1], attrs);
    });
    return out;
}

const needsRemoteControl = (attrs: string[]) => attrs.some(a => /feature\s*=\s*"remote-control"/.test(a));

describe('message notifications build without remote control (the Lite app)', () => {
    const mods = modules();

    it('control: the reader sees a module that IS gated', () => {
        expect(mods.get('lan')).toBeDefined();
        expect(needsRemoteControl(mods.get('lan')!)).toBe(true);
    });

    it('toasts itself is compiled into both variants', () => {
        expect(mods.has('toasts')).toBe(true);
        expect(needsRemoteControl(mods.get('toasts')!)).toBe(false);
    });

    it('so is every module of this crate it uses', () => {
        const used = [...new Set([...toasts.matchAll(/crate::(\w+)::/g)].map(m => m[1]))].filter(name => mods.has(name));
        expect(used, 'control: toasts.rs does use modules of this crate').toContain('ordered_worker');
        for (const name of used) {
            expect(needsRemoteControl(mods.get(name)!), `crate::${name} is only in the full build`).toBe(false);
        }
    });

    it('and its commands are registered in both', () => {
        const handler = lib.slice(lib.indexOf('invoke_handler'));
        for (const cmd of ['toasts::toast_show', 'toasts::toast_clear', 'toasts::toast_clear_all']) {
            const at = handler.indexOf(`${cmd},`);
            expect(at, cmd).toBeGreaterThan(-1);
            const lineAbove = handler.slice(0, at).trimEnd().split('\n').pop()!.trim();
            expect(lineAbove.startsWith('#[cfg'), `${cmd} is registered behind ${lineAbove}`).toBe(false);
        }
    });
});
