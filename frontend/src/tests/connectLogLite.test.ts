/**
 * The lite stand-in for devices/connectLog must export what the modules a
 * lite build keeps import from the real one, with the same kinds —
 * vite.shared.ts swaps it in for lite builds, and a missing binding there is
 * a load-time failure in a bundle nothing else type-checks against. The names
 * are DERIVED from the importer's import clause, so a new import shows up
 * here the day it is written.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as real from '../api/devices/connectLog';
import * as lite from '../api/rcConnectLog.lite';

const SRC = join(__dirname, '..');
// Every module kept in a lite build that imports the log. session.ts and
// DevicesView.tsx import it too, but neither is in a lite build.
const IMPORTERS = ['api/diagnosticsReport.ts'];

function importedNames(rel: string): string[] {
    const text = readFileSync(join(SRC, rel), 'utf8');
    const re = /import\s*\{([^}]*)\}\s*from\s*'\.\/devices\/connectLog'/g;
    const names: string[] = [];
    for (const m of text.matchAll(re)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
            if (name) names.push(name);
        }
    }
    return names;
}

describe('rcConnectLog.lite (the lite devices/connectLog)', () => {
    const used = [...new Set(IMPORTERS.flatMap(importedNames))];

    it('the importer really does import from the log (the derivation is not vacuous)', () => {
        expect(used).toContain('recentRcConnectLines');
    });

    it('exports every imported name, with the same kind as the real module', () => {
        for (const name of used) {
            expect(typeof (lite as Record<string, unknown>)[name], name).toBe(typeof (real as Record<string, unknown>)[name]);
        }
    });

    it('logs nothing and reports nothing', () => {
        lite.logRcConnect('anything');
        expect(lite.recentRcConnectLines()).toEqual([]);
    });
});
