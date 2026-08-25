#!/usr/bin/env node
/**
 * Reports where one meaning maps to more than one icon.
 *
 * Deliberately NOT chained into `npm run lint`: it is regex heuristics over JSX,
 * so a future refactor could make it cry wolf, and a required gate that cries
 * wolf is a gate people learn to ignore. Run it when you add or change icons.
 *
 *   node scripts/check-icon-cohesion.mjs
 *
 * It found three real ones after the emoji migration: "Delete" was a cross in
 * Emoji Settings and a bin everywhere else, "Revoke invite" was a cross in
 * Server Settings and a bin in the invite modal, and a button titled "More"
 * rendered an overflow icon while going straight to a remove-friend confirm.
 */
// The point of an icon language is that one meaning maps to one icon. This
// finds places where it does not: the same title=/aria-label/menu label
// rendering a different icon in a different file. That is exactly the drift
// that made "muted" a speaker in Chat and a mic in VoiceStage.
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = [];
(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'tests') walk(p); }
        else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) files.push(p);
    }
})(SRC);

const byMeaning = new Map();          // meaning -> Map(icon -> [sites])
const add = (meaning, icon, site) => {
    const key = meaning.trim().toLowerCase().replace(/[.…:]+$/, '');
    if (!key || key.length < 3) return;
    if (!byMeaning.has(key)) byMeaning.set(key, new Map());
    const m = byMeaning.get(key);
    if (!m.has(icon)) m.set(icon, []);
    m.get(icon).push(site);
};

for (const f of files) {
    const rel = path.relative(SRC, f).replace(/\\/g, '/');
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split(/\r?\n/);

    // 1. An element carrying title=/aria-label= that contains an icon.
    //    Only the FIRST icon within the element's own tag+children is its icon —
    //    scanning a fixed line window swallowed the NEXT button's icon and
    //    reported every accept/reject pair as an inconsistency.
    lines.forEach((line, i) => {
        const label = /(?:title|aria-label)=["']([^"']{3,40})["']/.exec(line);
        if (!label) return;
        let window_ = line;
        for (let k = 1; k <= 3 && !/<[A-Z]\w*Icon/.test(window_); k++) {
            const next = lines[i + k] ?? '';
            // stop at the start of a sibling element
            if (/<(?:button|div|span|a)\b/.test(next)) break;
            window_ += ' ' + next;
        }
        const m = /<([A-Z]\w*Icon)\s*(?:size=\{\d+\}\s*)?\/>/.exec(window_);
        if (m) add(label[1], m[1], `${rel}:${i + 1}`);
    });

    // 2. Data-driven entries: { label: 'X', ... icon: 'y' }. The pair must live
    //    in ONE object literal — a span that crosses `}` belongs to two entries.
    const sameObject = (between) => !/[{}]/.test(between);
    for (const m of src.matchAll(/label:\s*['"]([^'"]{3,40})['"]([\s\S]{0,140}?)icon:\s*['"]([a-z0-9-]+)['"]/g)) {
        if (!sameObject(m[2])) continue;
        add(m[1], m[3], `${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
    for (const m of src.matchAll(/icon:\s*['"]([a-z0-9-]+)['"]([\s\S]{0,140}?)label:\s*['"]([^'"]{3,40})['"]/g)) {
        if (!sameObject(m[2])) continue;
        add(m[3], m[1], `${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
}

const norm = (s) => s.replace(/Icon$/, '').replace(/-/g, '').toLowerCase();

let found = 0;
for (const [meaning, icons] of [...byMeaning].sort()) {
    const distinct = [...new Set([...icons.keys()].map(norm))];
    if (distinct.length < 2) continue;
    found++;
    console.log(`\n"${meaning}" renders ${distinct.length} different icons:`);
    for (const [icon, sites] of icons) {
        console.log(`    ${icon.padEnd(22)} ${sites.join(', ')}`);
    }
}

console.log(found ? `\n${found} inconsistent meaning(s).` : '\nNo meaning maps to more than one icon.');
