#!/usr/bin/env node
/**
 * Refuse to build a shippable client against a server nobody can reach.
 *
 * `frontend/src/api/platform.ts` falls back to http://localhost:3000 when
 * VITE_API_URL is unset. That is a development convenience and a shipping
 * hazard: on 2026-08-03 a release was built without `.env.production`, took
 * the fallback silently, and stranded every updated client — login broke,
 * and the update check used the same dead base, so no client could reach the
 * fixed release either (api/updateCheckBases.ts exists because of it).
 * Nothing in the build failed. This does.
 *
 * Resolution order mirrors Vite's: the shell environment, then
 * `.env.production` (the file Vite loads for `vite build`). A missing or
 * empty value, or one pointing at localhost / 127.0.0.1, fails the build.
 *
 * Escape hatches, both explicit:
 *   PUCA_ALLOW_LOCAL_BUILD=1  — a deliberate local-only build (on-device dev).
 *   CI                        — hosted CI builds are test builds, never shipped;
 *                               the workflows set no server URL on purpose.
 *
 * Run: node scripts/check-api-url.mjs   (first step of every build script)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(HERE, '..', '.env.production');

/** Minimal dotenv: KEY=VALUE lines, `#` comments, optional surrounding quotes. */
export function readDotenvValue(text, key) {
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        if (line.slice(0, eq).trim() !== key) continue;
        let v = line.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        return v;
    }
    return undefined;
}

/** null = acceptable; otherwise the reason it is not. */
export function verdict(value, { allowLocal = false } = {}) {
    const v = (value ?? '').trim();
    if (!v) return 'VITE_API_URL is not set — the build would bake in http://localhost:3000';
    if (!/^https?:\/\//i.test(v)) return `VITE_API_URL must be an absolute http(s) URL, got "${v}"`;
    if (!allowLocal && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(v)) {
        return `VITE_API_URL points at this machine (${v}) — no installed client could reach it`;
    }
    return null;
}

function main() {
    let source = 'environment';
    let value = process.env.VITE_API_URL;
    if (value === undefined || value === '') {
        source = path.relative(process.cwd(), ENV_FILE);
        try {
            value = readDotenvValue(fs.readFileSync(ENV_FILE, 'utf8'), 'VITE_API_URL');
        } catch {
            value = undefined;
            source = `${source} (missing)`;
        }
    }
    const allowLocal = process.env.PUCA_ALLOW_LOCAL_BUILD === '1';
    const why = verdict(value, { allowLocal });
    if (why === null) {
        console.log(`api-url: building against ${value.trim()}  (from ${source})`);
        return 0;
    }
    if (process.env.CI) {
        console.warn(`api-url: ${why}\n         allowed because CI is set — hosted builds are never shipped`);
        return 0;
    }
    console.error(`\napi-url: ${why}`);
    console.error('         Copy .env.production.example to .env.production and set VITE_API_URL to your');
    console.error('         server\'s public URL, or set PUCA_ALLOW_LOCAL_BUILD=1 for a deliberate local-only build.\n');
    return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main());
}
