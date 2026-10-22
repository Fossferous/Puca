/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';

// MUST mirror vite.config.ts. Both read tauri.conf.json — the one place the
// version lives — so they cannot drift; a test running against a different
// constant than the build injects would prove nothing about the shipped code.
const APP_VERSION = JSON.parse(
    readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
).version;

// https://vitejs.dev/config/
export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(APP_VERSION),
        // Tests always run against the FULL feature set, whatever the ambient
        // VITE_ENABLE_RC says. That is deliberate: the remote-control suites
        // are the regression cover for code a lite build merely omits, and
        // they must keep running and passing in this one source tree. This
        // config also carries no `resolve.alias` for the RC stand-ins, so the
        // tests resolve the real modules rather than the lite ones.
        __RC_ENABLED__: 'true',
    },
    plugins: [react()],
    test: {
        globals: true,
        // vitest's default is os.availableParallelism() - 1, and on the
        // owner's 16-thread machine availableParallelism() answers 4 in some
        // processes and 16 in others (measured 2026-10-22: 4 inside vitest on
        // every probe), so the default was THREE workers, which start about
        // one file a second — the 0.9.842 run's rate (582 files, 568 s). The
        // logical CPU count does not move. 3/8 of it (6 there), because more
        // does not pay: the full suite took 389 s on 6 workers, 353 s on 8,
        // 387 s on 10 and 413 s on 15, and the tests that wait in real time
        // slow down as workers are added — authedMediaType's size-bound case
        // took 1.7 s on 3 and on 6 workers, 2.2 s on 8, 3.9 s on 10 and timed
        // out (5 s) on 15 and on 8 with a game running. 6 keeps them at their
        // 3-worker speed on a desktop that is also being used. Override with
        // VITEST_MAX_WORKERS.
        maxWorkers: Math.max(1, Math.round((cpus().length * 3) / 8)),
        setupFiles: ['./src/tests/setup.ts'],
        // Two environments, chosen by extension so a new file lands in the
        // right one without anyone remembering to choose:
        //  - *.test.tsx renders React and runs in jsdom;
        //  - *.test.ts runs with node's globals and no DOM to build — jsdom
        //    was most of what a test file cost (environment setup: 648 s of
        //    the 0.9.842 run's cumulative time) — but with the SAME client
        //    transform and module resolution as jsdom
        //    (src/tests/clientNodeEnvironment.ts), unless its first line says
        //    `// @vitest-environment jsdom`.
        // A .ts file that needs the DOM and forgets the pragma does not pass
        // quietly on node's branches: src/tests/browserGlobalTrap.ts fails the
        // file, naming each browser global the code read.
        projects: [
            { extends: true, test: { name: 'tsx', environment: 'jsdom', include: ['src/**/*.{test,spec}.tsx'] } },
            { extends: true, test: { name: 'ts', environment: './src/tests/clientNodeEnvironment.ts', include: ['src/**/*.{test,spec}.ts'] } },
        ],
        coverage: {
            reporter: ['text', 'json', 'html'],
            exclude: ['node_modules/', 'src/tests/'],
        },
    },
});
