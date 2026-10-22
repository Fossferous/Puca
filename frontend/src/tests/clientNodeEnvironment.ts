/**
 * The environment every *.test.ts runs in unless it asks for jsdom
 * (vitest.config.ts): node's globals with NO DOM, but the module graph built
 * exactly as it is for jsdom.
 *
 * vitest's own `node` environment would not do: it is an SSR environment —
 * `import.meta.env.SSR` true, `process.env.SSR` set, packages resolved with
 * node's export conditions instead of the browser's — so a library with a
 * browser build (the app's only real target) would quietly load its node one
 * and the test would exercise code the app never runs. `viteEnvironment:
 * 'client'` keeps the transform and the resolution jsdom gets; the only
 * difference left is the missing DOM, which src/tests/browserGlobalTrap.ts
 * polices.
 */
import type { Environment } from 'vitest/environments';

export default {
    name: 'client-node',
    viteEnvironment: 'client',
    setup() {
        return { teardown() {} };
    },
} satisfies Environment;
