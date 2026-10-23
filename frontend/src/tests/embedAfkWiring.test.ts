/**
 * The AFK move's embedding-host branch in VoicePanel.tsx (docs/EMBEDDING.md,
 * `idleSeconds`), pinned in the source text the way streamOnlyWiring.test.ts
 * pins its wiring. afkIdle.test.ts proves the rule and embedHost.test.ts the
 * host's answer; what neither can see is whether the panel still ASKS: on a
 * Steam Deck the hidden page never sees the player's input, and without this
 * branch a listening player is moved to the AFK channel mid-game.
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

/** The idle check's timer body: from armInactivity to its setTimeout's end. */
function armBody(code: string): string {
    const start = code.indexOf('const armInactivity = useCallback(');
    const end = code.indexOf('const resetInactivity = useCallback(', start);
    return start >= 0 && end > start ? code.slice(start, end) : '';
}

const PINS: { name: string; holds: (c: string) => boolean; mutants: [string, (c: string) => string][] }[] = [
    {
        name: 'without the desktop probe, the AFK check asks the embedding host',
        holds: (c) => /\}\s*else if \(hostReportsIdle\(\)\) \{[\s\S]*?osIdleSecs = combineHostIdle\(await hostIdleSeconds\(\), lastAppInputRef\.current, Date\.now\(\)\);/.test(armBody(c)),
        mutants: [
            ['the host branch is gone', (c) => c.replace('} else if (hostReportsIdle()) {', '} else if (false) {')],
            ['page input no longer counts beside the host', (c) => c.replace('combineHostIdle(await hostIdleSeconds(), lastAppInputRef.current, Date.now())', 'combineHostIdle(await hostIdleSeconds(), null, Date.now())')],
        ],
    },
    {
        name: 'a host that fails is treated like a failed desktop probe: a whole window again, never a move',
        holds: (c) => /osIdleSecs = combineHostIdle\([^;]*\);\s*\} catch \{ arm\(timeoutMs\); return; \}/.test(armBody(c)),
        mutants: [
            ['the failure falls through to the decision', (c) => c.replace(/(osIdleSecs = combineHostIdle\([^;]*\);\s*\} catch \{) arm\(timeoutMs\); return; \}/, '$1 }')],
        ],
    },
    {
        name: 'the host is asked only where there is no desktop probe',
        holds: (c) => /if \(isTauri\(\)\) \{[\s\S]*?get_idle_seconds[\s\S]*?\} else if \(hostReportsIdle\(\)\)/.test(armBody(c)),
        mutants: [
            ['the host outranks the desktop probe', (c) => c.replace('if (isTauri()) {', 'if (!hostReportsIdle() && isTauri()) {').replace('} else if (hostReportsIdle()) {', '} if (hostReportsIdle()) {')],
        ],
    },
];

describe('VoicePanel asks an embedding host for the person\'s idle time (the AFK move)', () => {
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
