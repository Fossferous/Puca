#!/usr/bin/env node
/**
 * Four launch-hygiene rules that a green test suite cannot catch, because the
 * failures are *correct code with wrong words in it*.
 *
 * 1. NO PLACEHOLDER DOMAINS IN SHIPPED CLIENT SOURCE.
 *    `frontend/src/components/DevicesView.tsx` told a user, in the diagnostic
 *    that fires exactly when they need actionable instructions, to "install the
 *    latest APK from download.example.com" — an IANA-reserved placeholder in
 *    product copy. The standard was already written down in
 *    `frontend/src/api/updateCheckBases.ts`: baking one deployment's domain into
 *    a public repo points every fork at somebody else's server, and leaving a
 *    placeholder in is worse, because it looks configured while resolving
 *    nowhere. Per-deployment values come from the server (`/app-version`) or
 *    from build-time env, never from a literal.
 *
 * 2. NO UNOWNED TODO/FIXME/XXX/HACK MARKERS.
 *    A marker with no owner is indistinguishable from unfinished behaviour, and
 *    in a public repo it is read as exactly that — `platform.ts` carried a
 *    "TODO: Replace with your production server URL" directly above the line
 *    that already did it, on the most security-relevant configuration point in
 *    the client. A marker naming a real, still-open job is fine and must say so
 *    with a parenthesised tag: `TODO(orphan-gc): …`.
 *
 * 3. NO AXIOS-SHAPED STATUS READS.
 *    `err.response?.status` is how axios reports a status. This client throws
 *    ApiError with a flat `.status`, so a branch keyed on the axios shape can
 *    never run — and two did (the channel-key epoch race, "already friends"),
 *    each shipping as a dead code path behind a generic failure. Use
 *    `statusOf(err)` from api/client.ts.
 *
 * 4. THE PRODUCT IS SPELLED "Púca" IN PROSE.
 *    productName, the window title, the installed app and the README all say
 *    Púca; 66 user-facing strings said Puca, so the app told people to look
 *    for a name it did not consistently call itself. In JSX text and string
 *    literals the standalone word carries the fada. Identifiers are exempt by
 *    shape, not by list: anything adjacent to `/`, `\`, `-`, `:` or a word
 *    character (header names, paths, URLs, wake-lock tags, package ids) is
 *    left alone, and comments are not checked. A string the SERVER pins
 *    byte-for-byte across languages (the clip doorbell body) may keep the
 *    old spelling with `hygiene-lint:allow-product-spelling — reason`.
 *
 * Rules 1, 2 and 4 take an inline escape hatch, spelled like the icon lint's:
 *
 *     // hygiene-lint:allow-placeholder-domain — this is illustrative prose
 *
 * on the offending line or within the four lines above it, and the reason is
 * REQUIRED — a bare allowance is rejected, so the next reader can tell an
 * example from a leak. There is no escape hatch for an unowned marker: give it
 * an owner.
 *
 * Run: node scripts/check-source-hygiene.mjs   (chained into `npm run lint`)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = path.join(HERE, '..', 'src');
const RUST_SRC = path.join(HERE, '..', '..', 'src');

const WEB_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html']);
const RUST_EXT = new Set(['.rs']);

/** Tests assert on literal hosts and on markers; they ship to nobody. */
const SKIP_DIRS = new Set(['tests', 'node_modules', 'target', '__snapshots__']);
const isTestFile = (f) => /\.test\.[cm]?[jt]sx?$/.test(f) || /\.spec\.[cm]?[jt]sx?$/.test(f);

const PLACEHOLDER_DOMAIN = /\b(?:[a-z0-9-]+\.)*example\.(?:com|org|net)\b/i;
/** Uppercase, word-bounded. `TODO(owner)` is the one accepted form. */
const MARKER = /\b(TODO|FIXME|XXX|HACK)\b(\s*\()?/;
const ALLOW = /hygiene-lint:allow-placeholder-domain\s*(?:[—–-]\s*(.+?))?\s*(?:\*\/)?\s*$/;
const ALLOW_SPELLING = /hygiene-lint:allow-product-spelling\s*(?:[—–-]\s*(.+?))?\s*(?:\*\/)?\s*$/;

function walk(dir, ext, out = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;   // the tree may not have this directory (lite builds, CI slices)
    }
    for (const e of entries) {
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            walk(path.join(dir, e.name), ext, out);
        } else if (ext.has(path.extname(e.name)) && !isTestFile(e.name)) {
            out.push(path.join(dir, e.name));
        }
    }
    return out;
}

/**
 * An allowance covering line `i`, with its stated reason.
 *
 * Looks back a few lines rather than one: the reason is the point of the
 * marker, and a reason worth reading rarely fits on the same line as the URL it
 * is about. LOOKBACK is small on purpose — an allowance a screenful away from
 * what it excuses is not documentation, it is a hole.
 */
const LOOKBACK = 4;
function allowance(lines, i, pattern = ALLOW) {
    for (let j = i; j >= Math.max(0, i - LOOKBACK); j--) {
        const m = pattern.exec(lines[j] ?? '');
        if (m) return { reason: (m[1] || '').trim() };
    }
    return null;
}

const problems = [];

for (const file of walk(FRONTEND_SRC, WEB_EXT)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        if (!PLACEHOLDER_DOMAIN.test(line)) return;
        const allowed = allowance(lines, i);
        if (allowed && allowed.reason) return;
        problems.push({
            file, line: i + 1, text: line.trim(),
            why: allowed
                ? 'hygiene-lint:allow-placeholder-domain with no reason — say why this domain is illustrative'
                : 'placeholder domain in shipped client source — take it from /app-version or build-time env',
        });
    });
}

for (const file of [...walk(FRONTEND_SRC, WEB_EXT), ...walk(RUST_SRC, RUST_EXT)]) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        const m = MARKER.exec(line);
        if (!m) return;
        if (m[2]) return;   // TODO(owner): names a real, still-open job
        problems.push({
            file, line: i + 1, text: line.trim(),
            why: `unowned ${m[1]} marker — delete it, or give it an owner tag like TODO(orphan-gc)`,
        });
    });
}

// --- 3. axios-shaped status reads --------------------------------------------
const AXIOS_STATUS = /\.response\s*\??\.\s*status\b/;
for (const file of walk(FRONTEND_SRC, WEB_EXT)) {
    // Comments may DESCRIBE the shape (the fix's own comment does); code may not use it.
    const lines = stripComments(fs.readFileSync(file, 'utf8').split(/\r?\n/));
    lines.forEach((line, i) => {
        if (!AXIOS_STATUS.test(line)) return;
        problems.push({
            file, line: i + 1, text: line.trim(),
            why: 'axios-shaped status read — this client throws ApiError with a flat .status; use statusOf(err) from api/client.ts',
        });
    });
}

// --- 4. "Púca" in prose -------------------------------------------------------
/**
 * The standalone word, outside comments. Exemptions are by SHAPE: a `Puca`
 * touching `/` `\\` `-` `:` or a word character is an identifier (X-Puca-*
 * headers, <Downloads>/Puca, github.com/Fossferous/Puca, Puca:control).
 */
export const UNACCENTED_PRODUCT = /(?<![\w/\\-])Puca(?![\w:/\\-])/;
/** Strip comments line by line, tracking block comments across lines. */
export function stripComments(lines) {
    const out = [];
    let inBlock = false;
    for (let line of lines) {
        let result = '';
        let i = 0;
        while (i < line.length) {
            if (inBlock) {
                const close = line.indexOf('*/', i);
                if (close < 0) { i = line.length; break; }
                inBlock = false;
                i = close + 2;
                continue;
            }
            const open = line.indexOf('/*', i);
            // `//` only at line start or after whitespace: `https://` is a URL.
            const lineComment = line.slice(i).search(/(^|\s)\/\//);
            const lc = lineComment < 0 ? -1 : i + lineComment;
            if (open >= 0 && (lc < 0 || open < lc)) {
                result += line.slice(i, open);
                inBlock = true;
                i = open + 2;
                continue;
            }
            if (lc >= 0) { result += line.slice(i, lc); i = line.length; break; }
            result += line.slice(i);
            i = line.length;
        }
        out.push(result);
        void line;
    }
    return out;
}
for (const file of walk(FRONTEND_SRC, WEB_EXT)) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue;
    const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const code = stripComments(raw);
    code.forEach((line, i) => {
        if (!UNACCENTED_PRODUCT.test(line)) return;
        const allowed = allowance(raw, i, ALLOW_SPELLING);   // the allowance lives in a comment
        if (allowed && allowed.reason) return;
        problems.push({
            file, line: i + 1, text: line.trim(),
            why: allowed
                ? 'hygiene-lint:allow-product-spelling with no reason — say what pins the old spelling'
                : 'the product is "Púca" in user-facing text (matches productName and the window title) — add the fada',
        });
    });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && problems.length) {
    console.error(`\nsource hygiene: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
    for (const p of problems) {
        console.error(`  ${path.relative(path.join(HERE, '..', '..'), p.file)}:${p.line}`);
        console.error(`    ${p.text}`);
        console.error(`    ${p.why}\n`);
    }
    process.exit(1);
}

if (isMain) console.log('source hygiene: clean (no placeholder domains, no unowned markers, no axios-shaped status reads, Púca spelled with its fada)');
