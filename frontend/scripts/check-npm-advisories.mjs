#!/usr/bin/env node
/**
 * The JavaScript advisory gate: `npm audit` against the written triage.
 *
 * WHY A GATE AND NOT `|| true`. The frontend job ran `npm audit
 * --audit-level=high || true` — deliberately non-blocking, because the registry's
 * answer changes daily and a merge should not fail for a reason no commit
 * caused. The triage lived in docs/NPM_ADVISORIES.md and the log was meant to
 * make drift visible. Measured 2026-09-16: the log had drifted from the file
 * for two weeks (a dozen new identifiers on one package, a fixed package still
 * listed) and nobody had looked, because a step that cannot fail is a step
 * nobody reads. The Rust side has the opposite discipline (`.cargo/audit.toml`:
 * fixed, or listed with a reason) and it caught a real rustls advisory the same
 * week.
 *
 * WHAT BLOCKS, exactly: a HIGH or CRITICAL advisory against a package that has
 * NO row in the triage file. That is the case that must never pass quietly — a
 * newly vulnerable package nobody has reasoned about. What does NOT block, but
 * is printed loudly: new identifiers against an already-triaged package (the
 * row's reachability argument is about the dependency PATH and usually still
 * holds, but the row should be refreshed), and rows for packages the audit no
 * longer reports (stale; delete them). A registry that cannot be reached is a
 * warning, not a failure — that is the one "reason no commit caused" the old
 * step was right about, and it is visible in the log rather than silent.
 *
 * Run from frontend/: `node scripts/check-npm-advisories.mjs`. The decision is
 * a pure function (`triage`) so it is tested without the network.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const BLOCKING = new Set(['high', 'critical']);
const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/g;

/** Identifiers an audit entry's `via` chain names (GHSA from the advisory URL). */
function idsOf(entry) {
    const ids = new Set();
    for (const v of entry.via ?? []) {
        if (typeof v !== 'object' || v === null) continue;
        const url = typeof v.url === 'string' ? v.url : '';
        for (const m of url.match(GHSA) ?? []) ids.add(m);
    }
    return [...ids].sort();
}

/** The triage table: package -> the identifiers its row names. Rows are the
 *  lines of the markdown table whose first cell carries an advisory. */
export function parseTriage(docText) {
    const rows = new Map();
    for (const line of docText.split('\n')) {
        if (!line.startsWith('|')) continue;
        const cells = line.split('|').map(c => c.trim());
        // cells[0] is the empty string before the first pipe.
        const advisoryCell = cells[1] ?? '';
        const packageCell = cells[2] ?? '';
        const ids = advisoryCell.match(GHSA);
        if (!ids) continue;
        const pkg = /`([^`]+)`/.exec(packageCell)?.[1];
        if (!pkg) continue;
        const have = rows.get(pkg) ?? new Set();
        for (const id of ids) have.add(id);
        rows.set(pkg, have);
    }
    return rows;
}

/**
 * The decision. `audit` is the parsed `npm audit --json`; `docText` is
 * docs/NPM_ADVISORIES.md. Returns what blocks and what merely warns.
 */
export function triage(audit, docText) {
    const failures = [];
    const warnings = [];
    if (!audit || typeof audit !== 'object' || !audit.vulnerabilities) {
        const why = audit?.error?.summary ?? audit?.error?.code ?? 'no vulnerability report in the output';
        warnings.push(`npm audit did not produce a report (${why}); nothing was checked — rerun when the registry answers`);
        return { failures, warnings, reported: new Map() };
    }
    const triaged = parseTriage(docText);
    const reported = new Map();
    for (const [pkg, entry] of Object.entries(audit.vulnerabilities)) {
        if (!BLOCKING.has(entry.severity)) continue;
        const ids = idsOf(entry);
        reported.set(pkg, ids);
        const row = triaged.get(pkg);
        if (!row) {
            failures.push(
                `${pkg} (${entry.severity}${entry.isDirect ? ', DIRECT dependency' : ''}) has no row in docs/NPM_ADVISORIES.md`
                + (ids.length ? ` — ${ids.join(', ')}` : ''),
            );
            continue;
        }
        const fresh = ids.filter(id => !row.has(id));
        if (fresh.length) {
            warnings.push(`${pkg}: ${fresh.length} identifier(s) not in its row — refresh it: ${fresh.join(', ')}`);
        }
    }
    for (const pkg of triaged.keys()) {
        if (!reported.has(pkg)) {
            warnings.push(`${pkg} is triaged but no longer reported at high/critical — delete its row`);
        }
    }
    return { failures, warnings, reported };
}

function runAudit() {
    // One fixed command string through the shell: `npm` is a .cmd shim on
    // Windows, which Node will not spawn directly, and a string (no separate
    // args to concatenate) is the form the shell option is safe with.
    const r = spawnSync('npm audit --json', {
        encoding: 'utf8',
        shell: true,
        maxBuffer: 64 * 1024 * 1024,
    });
    // npm exits non-zero whenever anything is found; the JSON is the answer.
    const text = (r.stdout ?? '').trim();
    try {
        return JSON.parse(text);
    } catch {
        return { error: { summary: `unparseable npm audit output (${text.slice(0, 120) || r.stderr?.slice(0, 120) || 'empty'})` } };
    }
}

function main() {
    const here = dirname(fileURLToPath(import.meta.url));
    const docPath = resolve(here, '..', '..', 'docs', 'NPM_ADVISORIES.md');
    const docText = readFileSync(docPath, 'utf8');
    const { failures, warnings, reported } = triage(runAudit(), docText);

    for (const w of warnings) console.warn(`WARN  ${w}`);
    for (const f of failures) console.error(`FAIL  ${f}`);
    const n = reported.size;
    if (failures.length) {
        console.error(`\nnpm advisories: ${failures.length} untriaged high/critical package(s). Fix it, or add a row to docs/NPM_ADVISORIES.md with the reachability reasoning.`);
        process.exit(1);
    }
    console.log(`npm advisories: clean (${n} high/critical package(s) reported, every one triaged; ${warnings.length} warning(s))`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main();
}
