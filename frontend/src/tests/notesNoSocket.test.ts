/**
 * Púca Notes never opens the WebSocket. That rule was stated twice in prose —
 * docs/NOTES.md's *Sessions* paragraph and notes/model/notesQueries.ts's
 * header — and enforced by nothing, which made it exactly the kind of rule a
 * well-meaning change breaks: the obvious way to add "send this note as a DM"
 * is to copy ForwardModal, whose DM path is `wsClient.sendDirectMessage`.
 *
 * It matters because the socket is not just a transport here. Opening one
 * registers a presence session and an unattested device connection, and the
 * server sweeps PARKED peer-to-peer file offers to whichever connection
 * registers next — so a Notes socket would silently eat an offer meant for the
 * chat app, which is delivered exactly once.
 *
 * It walks the TRANSITIVE closure, not just src/notes. Scanning that directory
 * alone was a hole big enough to drive this very feature through: "Send to
 * Púca…" made noteText.ts import components/contextMenuUtils, and api/dms.ts
 * had already needed hand-adding to the scan. Notes is its own Vite entry, so
 * whatever it reaches for is IN its bundle — an import two modules away brings
 * the socket in just as surely as a direct one, with a directory scan still
 * green.
 *
 * Two positive controls: the checker must flag a synthetic offender, and the
 * walker must be shown actually leaving src/notes — a closure that quietly
 * stopped following imports would pass this file for the wrong reason.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTES_DIR = path.join(SRC, 'notes');

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...sourceFiles(p));
        else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
}

/** Static and dynamic module specifiers, in source order. */
export function importSpecifiers(text: string): string[] {
    const out: string[] = [];
    const re = /(?:import|export)[^;\n]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2]);
    return out;
}

/** A relative specifier as a file on disk, with TS's extension guesses.
 *  Bare specifiers are packages — not our source, and not our rule. */
function resolveRelative(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
}

/** Every source file the Notes entry pulls in, however deep. */
export function notesClosure(): string[] {
    const seen = new Set<string>(sourceFiles(NOTES_DIR));
    const queue = [...seen];
    while (queue.length) {
        const file = queue.pop()!;
        for (const spec of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
            const target = resolveRelative(file, spec);
            if (target && !seen.has(target)) { seen.add(target); queue.push(target); }
        }
    }
    return [...seen];
}

/** Lines that reach for the socket, ignoring comments (the headers and this
 *  test's own reasons name `wsClient` on purpose). */
export function socketOffences(text: string): string[] {
    return text
        .split('\n')
        .filter(line => {
            const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
            return /\bwsClient\b/.test(code) || /['"][^'"]*api\/websocket['"]/.test(code);
        })
        .map(l => l.trim());
}

describe('Púca Notes never opens a WebSocket', () => {
    it('nothing the Notes entry imports, at any depth, touches wsClient or api/websocket', () => {
        const offenders: string[] = [];
        for (const file of notesClosure()) {
            for (const line of socketOffences(fs.readFileSync(file, 'utf8'))) {
                offenders.push(`${path.relative(SRC, file)}: ${line}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('it actually scanned files (a checker over an empty set proves nothing)', () => {
        expect(sourceFiles(NOTES_DIR).length).toBeGreaterThan(40);
        expect(notesClosure().length).toBeGreaterThan(sourceFiles(NOTES_DIR).length);
    });

    it('positive control: the checker DOES flag the obvious offender', () => {
        expect(socketOffences("import { wsClient } from '../../api/websocket';")).toHaveLength(1);
        expect(socketOffences('    wsClient.sendDirectMessage(2, wire);')).toHaveLength(1);
        // ...and does not flag the rule being written down.
        expect(socketOffences(' * Notes never opens the socket, so wsClient is absent here.')).toHaveLength(0);
    });

    it('positive control: the walker really leaves src/notes and follows imports', () => {
        const closure = notesClosure().map(f => path.relative(SRC, f).replace(/\\/g, '/'));
        // api/dms.ts used to be special-cased by hand; contextMenuUtils.ts is
        // the module this feature added, two hops out. Both must be reached by
        // the walk itself, or the closure is not a closure.
        expect(closure).toContain('api/dms.ts');
        expect(closure).toContain('components/contextMenuUtils.ts');
    });

    it('positive control: a bare specifier is not mistaken for a file', () => {
        expect(importSpecifiers("import React from 'react';\nimport { x } from '../api/dms';"))
            .toEqual(['react', '../api/dms']);
        expect(resolveRelative(path.join(SRC, 'notes', 'x.ts'), 'react')).toBeNull();
        expect(resolveRelative(path.join(SRC, 'notes', 'x.ts'), '../api/dms')).toBe(path.join(SRC, 'api', 'dms.ts'));
    });
});
