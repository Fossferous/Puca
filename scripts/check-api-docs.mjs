#!/usr/bin/env node
/**
 * Fail when docs/API_REFERENCE.md documents a route the backend does not
 * register.
 *
 * WHY. The reference claimed `GET /dm/channels`, `POST /friends/accept/:id`
 * and `GET /servers/default` — none of which exist (the real routes are
 * `/dms`, `/friends/requests/:id/accept`, and nothing). A third-party
 * integrator writing against the page gets a 404 from a server that is
 * behaving correctly, and nothing in the tree could notice: the doc is prose
 * and the router is Rust. So the two are diffed here, path by path.
 *
 * WHAT IT CHECKS. Every path in a backticked table cell of API_REFERENCE.md
 * whose row starts with an HTTP method must match a `.route("...")` literal
 * in src/main.rs or src/update_routes.rs (path parameters compared by
 * position, not by name, so `:id` in the doc matches `:server_id` in code).
 * The direction is deliberate: UNDOCUMENTED routes are allowed (the page says
 * it is a subset); WRONG ones are not.
 *
 * Positive control, run when this was written: a fabricated `/servers/none`
 * row is reported; adding a route to main.rs without documenting it is not.
 *
 * Run: node scripts/check-api-docs.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'docs/API_REFERENCE.md';
const SOURCES = ['src/main.rs', 'src/update_routes.rs'];

/** `/servers/:server_id/roles/{role_id}` -> `/servers/:_/roles/:_` */
function normalise(p) {
    return p
        .replace(/\?.*$/, '')
        .replace(/\{[^}]+\}/g, ':_')
        .replace(/:[A-Za-z0-9_]+/g, ':_')
        .replace(/\/+$/, '') || '/';
}

const registered = new Set();
for (const src of SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, src), 'utf8');
    for (const m of text.matchAll(/\.route\(\s*"([^"]+)"/g)) registered.add(normalise(m[1]));
    for (const m of text.matchAll(/\.nest(?:_service)?\(\s*"([^"]+)"/g)) registered.add(normalise(m[1]) + '/*');
}

const METHOD = /^\|\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\|\s*`([^`]+)`/;
const problems = [];
const lines = fs.readFileSync(path.join(ROOT, DOC), 'utf8').split(/\r?\n/);
let documented = 0;
lines.forEach((line, i) => {
    const m = METHOD.exec(line);
    if (!m) return;
    documented++;
    const raw = m[2].trim();
    const p = normalise(raw);
    if (registered.has(p)) return;
    // a documented path under a nested service (e.g. /releases/...) is fine
    const nested = [...registered].some((r) => r.endsWith('/*') && p.startsWith(r.slice(0, -2)));
    if (nested) return;
    problems.push({ line: i + 1, method: m[1], raw });
});

if (documented === 0) {
    console.error(`api docs: found no route rows in ${DOC} — the table format changed and this check is matching nothing`);
    process.exit(1);
}

if (problems.length) {
    console.error(`\napi docs: ${problems.length} documented route${problems.length === 1 ? '' : 's'} not registered by the backend\n`);
    for (const p of problems) console.error(`  ${DOC}:${p.line}  ${p.method} ${p.raw}`);
    console.error('\nThe route table in src/main.rs is the truth; fix the row or delete it.');
    process.exit(1);
}

console.log(`api docs: clean (${documented} documented routes all registered; ${registered.size} routes in the backend)`);
