/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

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
        environment: 'jsdom',
        setupFiles: ['./src/tests/setup.ts'],
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        coverage: {
            reporter: ['text', 'json', 'html'],
            exclude: ['node_modules/', 'src/tests/'],
        },
    },
});
