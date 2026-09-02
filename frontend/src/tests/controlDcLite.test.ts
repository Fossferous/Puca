/**
 * The lite stand-in for rtc/controlDc must export exactly what the voice code
 * imports from the real module, with the same kinds — vite.config.ts swaps it
 * in for lite builds, and a missing binding there is a load-time failure in a
 * bundle nothing else type-checks against. The list of names is DERIVED from
 * the importers' import clauses, so a new import shows up here the day it is
 * written, not the day a lite build fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as real from '../api/rtc/controlDc';
import * as lite from '../api/rtc/controlDc.lite';

const SRC = join(__dirname, '..');
// Every module kept in a lite build that imports the registry. api/remoteControl.ts
// imports it too, but that file is itself swapped for its lite twin.
const IMPORTERS = ['api/rtc/manager.ts', 'api/rtc/sfuManager.ts', 'components/VoicePanel.tsx'];

function importedNames(rel: string): string[] {
    const text = readFileSync(join(SRC, rel), 'utf8');
    const re = /import\s*\{([^}]*)\}\s*from\s*'(?:\.\/controlDc|(?:\.\.\/)+api\/rtc\/controlDc)'/g;
    const names: string[] = [];
    for (const m of text.matchAll(re)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
            if (name) names.push(name);
        }
    }
    return names;
}

describe('rtc/controlDc.lite', () => {
    const used = [...new Set(IMPORTERS.flatMap(importedNames))];

    it('the importers really do import from the registry (the derivation is not vacuous)', () => {
        expect(used.length).toBeGreaterThanOrEqual(6);
        expect(used).toEqual(expect.arrayContaining(['registerControlChannel', 'deliverSfuControlFrame', 'setSfuControlSender']));
    });

    it('exports every symbol the voice code imports, of the same kind, with the same constants', () => {
        for (const name of used) {
            expect(name in lite, `${name} missing from controlDc.lite.ts`).toBe(true);
            expect(typeof (lite as Record<string, unknown>)[name], name).toBe(typeof (real as Record<string, unknown>)[name]);
        }
        expect(lite.CTL_STATE_LABEL).toBe(real.CTL_STATE_LABEL);
        expect(lite.CTL_SFU_TOPIC).toBe(real.CTL_SFU_TOPIC);
    });

    it('is inert: registering, delivering and forgetting do nothing and throw nothing', () => {
        expect(() => lite.registerControlChannel(1, {} as RTCDataChannel)).not.toThrow();
        expect(() => lite.deliverSfuControlFrame(1, new Uint8Array([1, 2, 3]))).not.toThrow();
        expect(() => lite.setSfuControlSender(() => true)).not.toThrow();
        expect(() => lite.forgetControlChannels(1)).not.toThrow();
    });
});
