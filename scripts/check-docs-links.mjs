#!/usr/bin/env node
/**
 * Fail when a tracked Markdown file points at something that is not there.
 *
 * WHY. `docs/GETTING_STARTED.md` told every new self-hoster to "check
 * `.agent/HANDOFF.md` for technical details and API documentation" — an
 * internal working directory that was scrubbed for the public repo, leaving the
 * pointer behind. It sat under "Need Help?", so it was the last thing that
 * reader saw. `README.md` promised `docs/AUDIT_2026-08-20.md` in the same
 * paragraph where it contrasts itself with "a link that quietly goes nowhere".
 * Neither is the kind of thing anyone notices by rereading; both are trivial to
 * catch mechanically.
 *
 * WHAT IT CHECKS
 *   1. Relative Markdown links — [text](path) — resolve to a real file or
 *      directory. Anchors are stripped; an anchor-only link (#section) is
 *      skipped. http(s):, mailto:, and protocol-relative links are not this
 *      script's business (they need the network to check, which would make it
 *      flaky and slow).
 *   2. Backticked strings that LOOK like repo paths — `docs/X.md`,
 *      `src/main.rs`, `deploy/ops/dual-ship.sh` — exist. This is the check that
 *      catches the two above, because both were backticks, not links.
 *
 * Deliberately conservative about (2): a backticked token is only treated as a
 * repo path when it starts with a directory that actually exists in the tree
 * and it carries a file extension. Prose like `set -e`, `image/png` or
 * `Cargo.toml` therefore does not trip it, and neither does a path with a
 * <placeholder> or a glob in it — those are not claims about a specific file.
 *
 * Run: node scripts/check-docs-links.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Roots a backticked path may be written relative to. Docs are written from
 * whichever tree the reader is standing in — `src/api/config.ts` in a doc about
 * the client means `frontend/src/api/config.ts`, and every such path in
 * docs/AUTO_UPDATER.md is written that way. Demanding repo-root-relative
 * everywhere would mean rewriting a dozen correct docs to satisfy a script.
 */
const SEARCH_ROOTS = ['', 'frontend'];

/** Tracked markdown only: a stray .md in an ignored build dir is not ours. */
function trackedMarkdown() {
    const out = execFileSync('git', ['ls-files', '*.md', '**/*.md'], { cwd: ROOT, encoding: 'utf8' });
    return [...new Set(out.split('\n').filter(Boolean))];
}

/** Top-level directories a backticked path may plausibly start with. */
const TOP_DIRS = new Set(
    fs.readdirSync(ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'node_modules')
        .map((e) => e.name),
);

const MD_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const BACKTICKED = /`([^`\n]+)`/g;

/**
 * The escape hatch, for prose that names a path ON PURPOSE because it is NOT
 * there — describing what was removed, or an anti-pattern nobody should
 * recreate. Put it in an HTML comment on the line above (invisible when the
 * Markdown is rendered), with a reason, which is REQUIRED:
 *
 *     <!-- docs-lint:allow-missing — this is the reference that was removed -->
 *
 * A bare allowance is rejected, so the next reader can tell a deliberate
 * mention from a broken promise.
 */
const ALLOW_MISSING = /docs-lint:allow-missing\s*(?:[—–-]\s*(.+?))?\s*$/;
const ALLOW_LOOKBACK = 2;

/**
 * An allowance carrying a reason, covering the 0-based line `i`.
 *
 * The `-->` is stripped BEFORE matching, not tolerated inside the pattern. The
 * first version let the optional reason group absorb the `->` of the comment
 * terminator, so a bare `<!-- docs-lint:allow-missing -->` read as an allowance
 * with the reason "->" and was accepted — a rejection that never rejected.
 * Caught by running the positive control.
 */
function allowedMissing(lines, i) {
    for (let j = i; j >= Math.max(0, i - ALLOW_LOOKBACK); j--) {
        const line = (lines[j] ?? '').replace(/-->\s*$/, '');
        const m = ALLOW_MISSING.exec(line);
        if (m) return Boolean((m[1] || '').trim());
    }
    return false;
}

const problems = [];

function exists(p) {
    try {
        fs.statSync(path.join(ROOT, p));
        return true;
    } catch {
        return false;
    }
}

/**
 * Paths that are absent ON PURPOSE. `deploy/ops/hosts.conf` and
 * `frontend/src-tauri/tauri.release.json` are gitignored operator-only files
 * the docs MUST name — telling the reader to create one is the whole point.
 * Asking git rather than keeping a list here means the exemption cannot drift
 * from the ignore rules.
 *
 * A gitignored `.md` is NOT exempt, deliberately. Several internal documents
 * are withheld from the published tree on purpose (`.gitignore` lists them, and
 * says "Nothing in the tree links to any of them"). A public doc pointing at
 * one is precisely the dangling reference this script exists to catch — it
 * reads to a stranger as a file somebody forgot to push. Found exactly that
 * with this rule in place: docs/REMOTE_CONTROL.md pointed at
 * docs/DEVICES_HANDOFF.md.
 */
const ignoredCache = new Map();
function isDeliberatelyAbsent(p) {
    if (p.endsWith('.md')) return false;
    if (ignoredCache.has(p)) return ignoredCache.get(p);
    let ignored;
    try {
        execFileSync('git', ['check-ignore', '-q', '--', p], { cwd: ROOT });
        ignored = true;
    } catch {
        ignored = false;   // exit 1 = not ignored
    }
    ignoredCache.set(p, ignored);
    return ignored;
}

/** Does this path resolve under any of the roots a doc may be written from? */
function resolvesAnywhere(p, fileDir) {
    for (const root of [...SEARCH_ROOTS, fileDir]) {
        if (exists(path.join(root, p))) return true;
    }
    return isDeliberatelyAbsent(p);
}

/** Is this backticked token a claim that a specific file exists? */
function looksLikeRepoPath(tok) {
    if (!tok.includes('/')) return false;                 // bare filenames are ambiguous prose
    if (/[\s<>*?|"'$(){}]/.test(tok)) return false;       // a command, a glob, or a placeholder
    if (/^[a-z][a-z0-9+.-]*:/i.test(tok)) return false;   // a URL or a scheme
    if (tok.startsWith('/') || tok.startsWith('~')) return false;   // an absolute/deploy path, not in-tree
    if (!/\.[A-Za-z0-9]{1,8}$/.test(tok)) return false;   // no extension: probably a directory in prose
    const top = tok.split('/')[0];
    // A dot-directory counts even when it is absent from the tree — that is the
    // whole point. `.agent/HANDOFF.md` was the reference this script was written
    // for, and keying only on directories that EXIST would have skipped it, since
    // the directory is exactly what was removed. (Measured: the first version of
    // this script did skip it.)
    return TOP_DIRS.has(top) || top.startsWith('.');
}

for (const file of trackedMarkdown()) {
    const dir = path.dirname(file);
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const lines = text.split(/\r?\n/);
    const lineOf = (index) => text.slice(0, index).split('\n').length;

    for (const m of text.matchAll(MD_LINK)) {
        const href = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;  // http:, mailto:, …
        if (href.startsWith('//')) continue;              // protocol-relative
        if (href.startsWith('#')) continue;               // in-page anchor
        const target = href.split('#')[0];
        if (!target) continue;
        const resolved = path.normalize(path.join(dir, decodeURIComponent(target)));
        const line = lineOf(m.index);
        if (!exists(resolved) && !isDeliberatelyAbsent(resolved) && !allowedMissing(lines, line - 1)) {
            problems.push({ file, line, what: `link -> ${href}`, resolved });
        }
    }

    for (const m of text.matchAll(BACKTICKED)) {
        const tok = m[1];
        if (!looksLikeRepoPath(tok)) continue;
        if (resolvesAnywhere(tok, dir)) continue;
        const line = lineOf(m.index);
        if (allowedMissing(lines, line - 1)) continue;
        problems.push({ file, line, what: `\`${tok}\``, resolved: tok });
    }
}

if (problems.length) {
    console.error(`\ndocs links: ${problems.length} dangling reference${problems.length === 1 ? '' : 's'}\n`);
    for (const p of problems) {
        console.error(`  ${p.file}:${p.line}`);
        console.error(`    ${p.what}  ->  ${p.resolved} does not exist\n`);
    }
    console.error('Fix the path, or delete the promise. A pointer to something that is not');
    console.error('there is worse than no pointer: it reads as a file someone forgot to push.');
    process.exit(1);
}

console.log('docs links: clean (every relative link and backticked repo path resolves)');
