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
 * This walks the real source, and carries a positive control: the checker must
 * flag a synthetic offender, or a checker that always passed would pass here.
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
    it('no file under src/notes imports api/websocket or touches wsClient', () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(NOTES_DIR)) {
            for (const line of socketOffences(fs.readFileSync(file, 'utf8'))) {
                offenders.push(`${path.relative(SRC, file)}: ${line}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('it actually scanned files (a checker over an empty set proves nothing)', () => {
        expect(sourceFiles(NOTES_DIR).length).toBeGreaterThan(40);
    });

    it('positive control: the checker DOES flag the obvious offender', () => {
        expect(socketOffences("import { wsClient } from '../../api/websocket';")).toHaveLength(1);
        expect(socketOffences('    wsClient.sendDirectMessage(2, wire);')).toHaveLength(1);
        // ...and does not flag the rule being written down.
        expect(socketOffences(' * Notes never opens the socket, so wsClient is absent here.')).toHaveLength(0);
    });

    it('api/dms.ts — the module Notes DOES pull in — never imports the socket either', () => {
        const text = fs.readFileSync(path.join(SRC, 'api', 'dms.ts'), 'utf8');
        expect(socketOffences(text)).toEqual([]);
    });
});
