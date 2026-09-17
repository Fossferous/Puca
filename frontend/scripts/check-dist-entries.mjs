#!/usr/bin/env node
/**
 * Assert, after a build, the two things the release scripts silently depend
 * on — for BOTH pages in dist/.
 *
 * 1. Each page's entry chunk is named `assets/index-<hash>.js`. That literal
 *    is what deploy/ops/dual-ship.sh (cmd_webapp) and deploy/ops/check-versions.sh
 *    grep for; a Vite change that renamed it (an object-form
 *    `rollupOptions.input` does exactly that) would only be found on ship day,
 *    when dual-ship refuses the bundle. This turns that into a build failure.
 *
 * 2. The JavaScript each page loads names the production API host. The host
 *    is baked from VITE_API_URL at build time and a build without
 *    frontend/.env.production silently falls back to localhost:3000 — which
 *    shipped once (2026-08-03) and stranded every client. check-api-url.mjs
 *    refuses to START such a build; this checks the OUTPUT, page by page, so
 *    a second page built from a different env dir cannot slip through.
 *
 *    Looks at every script the page's HTML references — the `<script src>`
 *    entry AND the `<link rel="modulepreload">` chunks Vite emits — because
 *    Rollup is free to hoist a shared module out of the entry chunk. Skipped
 *    (with a note) under the same escape hatches as check-api-url.mjs: `CI`
 *    (hosted builds are never shipped) and PUCA_ALLOW_LOCAL_BUILD=1.
 *
 * Run: node scripts/check-dist-entries.mjs   (last step of `npm run build`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDotenvValue } from './check-api-url.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(HERE, '..');
const DIST = path.join(FRONTEND, 'dist');

/** The pages a web deploy serves. `base` is the URL prefix Vite wrote asset
 *  paths under, which is how a chunk path in the HTML maps back to disk. */
const PAGES = [
    { html: 'index.html', base: '/' },
    { html: path.join('notes', 'index.html'), base: '/notes/' },
];

const ENTRY = /assets\/index-[A-Za-z0-9_-]+\.js/;
const SCRIPT_REFS = /<(?:script[^>]+src|link[^>]+rel="modulepreload"[^>]+href)="([^"]+\.js)"/g;

function apiHost() {
    let url = process.env.VITE_API_URL;
    if (!url) {
        try {
            url = readDotenvValue(fs.readFileSync(path.join(FRONTEND, '.env.production'), 'utf8'), 'VITE_API_URL');
        } catch { /* no env file */ }
    }
    if (!url) return null;
    try {
        return new URL(url).host;
    } catch {
        return null;
    }
}

const skipHostCheck = !!process.env.CI || process.env.PUCA_ALLOW_LOCAL_BUILD === '1';
const host = skipHostCheck ? null : apiHost();
const problems = [];

for (const page of PAGES) {
    const htmlPath = path.join(DIST, page.html);
    let html;
    try {
        html = fs.readFileSync(htmlPath, 'utf8');
    } catch {
        problems.push(`${page.html}: missing — was this page's build run?`);
        continue;
    }
    if (!ENTRY.test(html)) {
        problems.push(`${page.html}: no assets/index-<hash>.js entry chunk (dual-ship.sh and check-versions.sh grep that exact name)`);
        continue;
    }
    if (skipHostCheck) continue;
    if (!host) {
        problems.push(`${page.html}: cannot determine the API host (VITE_API_URL unset and no .env.production) — set PUCA_ALLOW_LOCAL_BUILD=1 for a deliberate local build`);
        continue;
    }
    const refs = [...html.matchAll(SCRIPT_REFS)].map(m => m[1]);
    const found = refs.some(ref => {
        const rel = ref.startsWith(page.base) ? ref.slice(page.base.length) : ref.replace(/^\.?\//, '');
        try {
            return fs.readFileSync(path.join(DIST, page.base.replace(/^\//, ''), rel), 'utf8').includes(host);
        } catch {
            return false;
        }
    });
    if (!found) {
        problems.push(`${page.html}: none of its ${refs.length} script(s) names the API host ${host} — built without .env.production?`);
    }
}

if (problems.length) {
    console.error('\ndist entries: ' + problems.length + ' problem(s)\n');
    for (const p of problems) console.error('  ' + p);
    console.error('');
    process.exit(1);
}
console.log(`dist entries: clean (${PAGES.length} pages name assets/index-*.js${skipHostCheck ? '; API-host check skipped (CI / local build)' : `; both load the API host ${host}`})`);
