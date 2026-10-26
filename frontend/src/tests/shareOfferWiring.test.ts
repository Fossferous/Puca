/**
 * How VoicePanel.tsx builds and takes the share's step-down offers, pinned in
 * the source text the way embedAfkWiring.test.ts pins its wiring.
 * liveShareQuality.test.tsx proves `liveShareOffer` steps down from the share
 * as it runs; what it cannot see is whether the panel still CALLS it. Built
 * from the remembered quality instead, a CPU offer after a step for this
 * share alone put a starved share back up to 60 fps and saved it, and a third
 * frames step sent the capture back up from 720p to 1080p (the review of
 * 2026-10-26, with the real functions).
 *
 * Every pin is checked against the real source AND against mutated copies
 * (applied to a string here, never to the file), so a pin that could not fail
 * fails its own mutation case. Comments are stripped first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const VP = stripComments(readFileSync(join(here, '..', 'components/VoicePanel.tsx'), 'utf8'));

const PINS: { name: string; holds: (c: string) => boolean; mutants: [string, (c: string) => string][] }[] = [
    {
        name: 'every offer the share watch makes is built from the share as it runs',
        holds: (c) => /const offer = liveShareOffer\(why, rememberedQuality\(loadSettings\(\)\), shareCaptureSize\(\)\);/.test(c)
            && !/shareLoadOffer\(/.test(c),
        mutants: [
            ['built from the remembered quality', (c) => c.replace('const offer = liveShareOffer(why,', 'const offer = shareLoadOffer(why,')],
        ],
    },
    {
        name: 'Lower it saves the step only when it is to be remembered (the CPU one), and says what it changed from the running share',
        holds: (c) => /const from = liveShareQuality\(rememberedQuality\(loadSettings\(\)\)\);/.test(c)
            && /if \(remember\) saveSettings\(\{ \.\.\.loadSettings\(\), shareResolution: to\.resolution, shareFps: to\.fps \}\);/.test(c)
            && /void applyShareQuality\(to, \{ remember \}\)/.test(c),
        mutants: [
            ['every step saved again', (c) => c.replace('if (remember) saveSettings(', 'saveSettings(')],
            ['the change told from the remembered quality', (c) => c.replace('const from = liveShareQuality(rememberedQuality(loadSettings()));', 'const from = rememberedQuality(loadSettings());')],
            ['the step applied as if remembered', (c) => c.replace('void applyShareQuality(to, { remember })', 'void applyShareQuality(to)')],
        ],
    },
];

describe('VoicePanel builds and takes the share\'s step-down offers from the running share', () => {
    for (const pin of PINS) {
        it(pin.name, () => {
            expect(pin.holds(VP)).toBe(true);
        });
        for (const [what, mutate] of pin.mutants) {
            it(`  …and would catch: ${what}`, () => {
                const mutated = mutate(VP);
                expect(mutated).not.toBe(VP);
                expect(pin.holds(mutated)).toBe(false);
            });
        }
    }
});
