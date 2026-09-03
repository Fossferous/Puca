/**
 * The agent build must take its binary path from CARGO, never compute one.
 *
 * WHY THIS TEST EXISTS. `crates/*` used to be standalone packages, each with
 * its own `crates/<name>/target/`. They are workspace members now, so cargo
 * writes to the workspace root's `target/` instead — but the old directories
 * still exist on every machine that built before the move, holding the last
 * binary produced there.
 *
 * A hard-coded old path would therefore have found a REAL FILE. It would have
 * passed the existsSync check, passed the size floor, and passed the version-
 * resource check (that binary was stamped 0.9.1 too), staging a stale agent
 * into the installer on every release from then on. Nothing would have failed.
 *
 * AND THE OBVIOUS GUARD IS WRONG, which is the other half of this test. The
 * first fix compared the binary's mtime against the moment the build started
 * and rejected anything older. That broke the very next build: cargo does not
 * rewrite a binary that is already up to date, so "older than this build" is
 * the normal state of an incremental rebuild. Do not reintroduce it — read the
 * executable path out of cargo's own artifact records instead, which is right
 * whether or not anything was recompiled.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, '..', '..', 'scripts', 'build-agent.mjs'), 'utf8');

describe('build-agent.mjs locates its output honestly', () => {
    it('reads the executable path out of cargo, not out of arithmetic', () => {
        expect(script).toContain('--message-format=json-render-diagnostics');
        expect(script).toContain('compiler-artifact');
        expect(script).toMatch(/msg\.executable/);
    });

    it('never hard-codes a per-crate target directory', () => {
        // The exact shape that broke: join(repo, 'crates', <name>, 'target', …).
        expect(script, 'the output path must not be assumed').not.toMatch(
            /['"]crates['"]\s*,\s*['"]puca-[a-z]+['"]\s*,\s*['"]target['"]/,
        );
        expect(script).not.toMatch(/crates[/\\]puca-[a-z]+[/\\]target/);
    });

    it('refuses to guess when cargo reports no executable', () => {
        expect(script).toMatch(/no executable for/);
        expect(script).toMatch(/do not fall back to a guessed path/);
    });

    it('does not compare build timestamps — that broke incremental builds', () => {
        expect(script).not.toContain('assertFreshlyBuilt');
        expect(script, 'an mtime comparison false-fails whenever cargo skips a relink')
            .not.toMatch(/mtimeMs\s*<|<\s*startedAt/);
    });

    it('positive control: these assertions are reading the real build script', () => {
        expect(script).toContain('building puca-agent for');
        expect(script).toContain('puca-service');
        expect(script.length).toBeGreaterThan(2000);
    });
});
