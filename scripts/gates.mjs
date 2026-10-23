#!/usr/bin/env node
/**
 * Run the self-contained release gates from CLAUDE.md, concurrently where
 * they do not share a lock, and skip a gate whose inputs have not changed
 * since it last PASSED here.
 *
 *   node scripts/gates.mjs              # run what changed; say loudly what was skipped
 *   node scripts/gates.mjs --all        # run everything, stamps ignored (still written)
 *   node scripts/gates.mjs --plan       # what would run and what would be skipped; runs nothing
 *   node scripts/gates.mjs --only vitest,lint   # just these (ids from --plan)
 *   node scripts/gates.mjs --jobs 2     # at most 2 gates at once (default 4)
 *
 * WHY. 0.9.842 re-ran the full 9.5-minute vitest on code identical to a run
 * that had passed an hour earlier, because the release commit changed only
 * the version carriers and CHANGELOG.md; and every gate ran one after another
 * although the frontend gates and cargo never share a lock.
 *
 * WHAT A SKIP MEANS. A gate is skipped only when a PASS stamp exists whose key
 * equals the key of the tree as it is now. The key is a sha256 over the git
 * blob id of every input file (tracked, modified and untracked-but-not-ignored
 * — the working tree, not HEAD) plus the toolchain and installed-dependency
 * fingerprints the gate depends on. A stamp is written only when the gate's
 * every step exited 0 AND its key is unchanged after it finished (a file
 * edited mid-run proves nothing about either version). A failure deletes the
 * gate's stamp, so a flaky failure is never hidden by an earlier pass. An
 * interrupted run writes nothing. Every skip is printed with the time and
 * commit of the run it relies on, and again in the summary.
 *
 * INPUTS. Most gates take the WHOLE tree: vitest reads docs/ and src-tauri/,
 * the Rust tests include_str! TypeScript, the Notes JUnit suite reads Púca's
 * Java. Only gates whose reads were audited are scoped, and the scoped Rust
 * gate re-audits itself every run (scopeAudit): an include_str!/include_bytes!/
 * CARGO_MANIFEST_DIR path that leaves its declared inputs widens it back to
 * the whole tree, loudly. For the TEST gates (`ignoreVersion`) the release
 * number is blanked out of the version carriers and CHANGELOG.md is left out:
 * nothing those suites run reads either (audited 2026-10-22; vitest's
 * __APP_VERSION__ uses compare the constant with itself), and a version bump
 * is otherwise the whole of a release commit. The build, lint, typecheck and
 * the fast checks keep every byte — the build bakes the version in, and lint
 * reads CHANGELOG.md.
 *
 * NOT RUN HERE, and listed in the summary every time so nobody mistakes this
 * for the full list: the suites that need a throwaway backend, a vite dev
 * server, or an emulator (CLAUDE.md, Gates). Run those by hand.
 *
 * Stamps and logs live in this checkout's git dir (`git rev-parse --git-path
 * puca-gates`): per worktree, never committed, never shared — another
 * checkout's node_modules is not this one's.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const FE = 'frontend';

// ---------------------------------------------------------------- the gates

const ALL = null; // inputs: the whole tree
// Bump when a change here means stamps written before it prove less than the
// script now assumes: every older stamp then stops matching.
const STAMP_FORMAT = 1;
const SELF = 'scripts/gates.mjs';

// The files a release bump edits (deploy/ops' bump, CLAUDE.md "Version").
// For ignoreVersion gates the current version string (and the Android
// versionCode derived from it) is blanked out of these; any OTHER change to
// them still changes the key.
const VERSION_CARRIERS = [
    'frontend/src-tauri/tauri.conf.json',
    'frontend/android/app/build.gradle',
    'deploy/download-site/index.html',
];
const CHANGELOG = 'CHANGELOG.md';

const javaHome = process.env.JAVA_HOME
    || (WIN ? 'C:\\Program Files\\Android\\Android Studio\\jbr' : undefined);
// A fresh worktree has no android/local.properties (gitignored); the Android
// Gradle plugin then reads ANDROID_HOME.
const androidHome = process.env.ANDROID_HOME
    || (WIN && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined);
// Explicitly relative: cmd.exe skips the current directory when
// NoDefaultCurrentDirectoryInExePath is set (it is, under some agent shells).
const gradlew = WIN ? '.\\gradlew.bat' : './gradlew';
const python = WIN ? 'python' : 'python3';

/**
 * A gate: { id, title, inputs, ignoreVersion?, fingerprint, after?, cpu?, steps }.
 * cpu: 'heavy' (a compile) never runs beside an 'exclusive' gate (vitest, the
 * real-browser scripts); anything else ('light', the default) runs beside either.
 * A step: { run, cwd?, lock?, env?, when?, nice?, check? } — `check(output, code)` returns an error string or null.
 */
const GATES = [
    {
        id: 'typecheck', title: 'tsc -b (app, vite configs, tests)',
        inputs: ALL, fingerprint: ['node', 'fe-deps'],
        steps: [{ run: 'npm run typecheck', cwd: FE }],
    },
    {
        id: 'vitest', title: 'vitest run',
        // Never beside a compile: its tests that wait in real time timed out
        // (8 of them, 2026-10-22) while cargo, sql-bind and gradle compiled
        // at below-normal priority on the same 16 threads.
        cpu: 'exclusive',
        inputs: ALL, ignoreVersion: true, fingerprint: ['node', 'fe-deps', 'fe-env'],
        steps: [{ run: 'npx vitest run', cwd: FE, check: vitestCheck }],
    },
    {
        id: 'lint', title: 'npm run lint (eslint + five checks), rules-of-hooks = 0',
        inputs: ALL, fingerprint: ['node', 'fe-deps'],
        steps: [{ run: 'npm run lint', cwd: FE, check: (out) => (/rules-of-hooks/.test(out) ? 'lint output mentions rules-of-hooks (CLAUDE.md: must be 0)' : null) }],
    },
    {
        id: 'build', cpu: 'heavy', title: 'npm run build (agent, tsc -b, vite x2, dist entries)',
        inputs: ALL, fingerprint: ['node', 'fe-deps', 'fe-env', 'rust'],
        steps: [{ run: 'npm run build', cwd: FE, lock: 'cargo-target', nice: true }],
    },
    {
        id: 'cargo-backend', cpu: 'heavy', title: 'cargo test (the backend package)',
        inputs: ALL, ignoreVersion: true, fingerprint: ['rust', 'test-db'],
        steps: [{ run: 'cargo test', lock: 'cargo-target', nice: true, check: cargoCheck }],
    },
    {
        id: 'cargo-workspace', cpu: 'heavy', title: 'cargo test --workspace --exclude puca (crates/*)',
        inputs: ALL, ignoreVersion: true, fingerprint: ['rust'],
        steps: [{ run: 'cargo test --workspace --exclude puca', lock: 'cargo-target', nice: true, check: cargoCheck }],
    },
    {
        id: 'cargo-src-tauri', cpu: 'heavy', title: 'cargo test in frontend/src-tauri (after build-agent)',
        // src-tauri, the crates it depends on by path, the TypeScript and
        // fixtures its tests include_str!, and what build-agent reads to
        // produce the sidecars tauri-build insists exist. scopeAudit checks
        // the include_str! half of this list on every run.
        // (puca-service's parity tests read two backend files.)
        inputs: ['frontend/src-tauri/', 'crates/', 'frontend/src/', 'frontend/scripts/build-agent.mjs', 'Cargo.toml', 'Cargo.lock', 'src/protocol.rs', 'src/ws.rs'],
        scopeAudit: { roots: ['frontend/src-tauri/', 'crates/'] },
        ignoreVersion: true, fingerprint: ['rust', 'node'],
        steps: [
            { run: 'node scripts/build-agent.mjs', cwd: FE, lock: 'cargo-target', nice: true },
            { run: 'cargo test', cwd: 'frontend/src-tauri', lock: 'cargo-src-tauri', nice: true, check: cargoCheck },
        ],
    },
    {
        id: 'sql-bind-types', cpu: 'heavy', title: 'scripts/check-sql-bind-types.py (own target dir)',
        inputs: ALL, ignoreVersion: true, fingerprint: ['rust', 'python'],
        steps: [{ run: `${python} scripts/check-sql-bind-types.py`, lock: 'cargo-sql-bind', nice: true }],
    },
    {
        id: 'junit-android', cpu: 'heavy', title: 'frontend/android testDebugUnitTest',
        // The pure-Java suite reads only its own classpath resources; the
        // Capacitor library it compiles against comes from node_modules.
        inputs: ['frontend/android/', 'frontend/package-lock.json'],
        ignoreVersion: true, fingerprint: ['java', 'fe-deps'],
        // `cap sync` copies dist/, so this waits for the build gate.
        after: ['build'],
        steps: [
            // Gradle reads capacitor-cordova-android-plugins/ (gitignored), which
            // only a cap sync writes: done when this checkout has never had one.
            {
                run: 'npx cap sync android', cwd: FE,
                when: () => !fs.existsSync(path.join(ROOT, 'frontend/android/capacitor-cordova-android-plugins')),
            },
            { run: `${gradlew} testDebugUnitTest`, cwd: 'frontend/android', env: { JAVA_HOME: javaHome, ANDROID_HOME: androidHome }, nice: true },
        ],
    },
    {
        id: 'junit-notes', cpu: 'heavy', title: 'frontend/notes-app/android testDebugUnitTest',
        // GeofenceParityTest reads Púca's Java; build.gradle reads tauri.conf.json.
        inputs: ['frontend/notes-app/', 'frontend/android/app/src/main/java/', 'frontend/src-tauri/tauri.conf.json'],
        ignoreVersion: true, fingerprint: ['java', 'notes-deps'],
        steps: [
            // The suite needs a cap sync first (CLAUDE.md). Done only when it
            // has never happened in this checkout: it builds the Notes web app.
            {
                run: 'npm install --no-audit --no-fund && cd .. && npm run notes:android', cwd: 'frontend/notes-app',
                when: () => !fs.existsSync(path.join(ROOT, 'frontend/notes-app/android/capacitor-cordova-android-plugins')),
                env: { JAVA_HOME: javaHome, ANDROID_HOME: androidHome },
            },
            { run: `${gradlew} testDebugUnitTest`, cwd: 'frontend/notes-app/android', env: { JAVA_HOME: javaHome, ANDROID_HOME: androidHome }, nice: true },
        ],
    },
    {
        id: 'decky-plugin', cpu: 'heavy', title: 'integrations/decky: typecheck, vitest, unittest, build',
        // Púca for Steam Deck builds and tests on its own (its own package.json
        // and node_modules) and reads nothing outside its folder.
        inputs: ['integrations/decky/'],
        fingerprint: ['node', 'decky-deps', 'python'],
        steps: [
            {
                run: 'npm ci --no-audit --no-fund', cwd: 'integrations/decky',
                when: () => !fs.existsSync(path.join(ROOT, 'integrations/decky/node_modules')),
            },
            { run: 'npm run typecheck', cwd: 'integrations/decky' },
            // Its vitest colours the summary despite FORCE_COLOR=0, and
            // vitestCheck reads that summary as plain text.
            { run: 'npx vitest run', cwd: 'integrations/decky', env: { NO_COLOR: '1' }, check: vitestCheck },
            { run: `${python} -m unittest discover -s tests -p "test_*.py"`, cwd: 'integrations/decky' },
            { run: 'npm run build', cwd: 'integrations/decky' },
        ],
    },
    {
        id: 'installer-hooks', title: 'npm run check:installer-hooks (needs makensis)',
        inputs: ALL, fingerprint: ['node'],
        steps: [{ run: 'npm run check:installer-hooks', cwd: FE }],
    },
    {
        id: 'third-party-notices', title: 'gen-third-party-notices.mjs, result committed',
        inputs: ALL, fingerprint: ['node', 'fe-deps'],
        steps: [
            { run: 'node scripts/gen-third-party-notices.mjs' },
            { run: 'git diff --exit-code --stat -- THIRD_PARTY_NOTICES.md', check: (out, code) => (code ? 'THIRD_PARTY_NOTICES.md changed: commit the regenerated file' : null) },
        ],
    },
    // Real-browser scripts that need no server: one at a time, after vitest,
    // and never beside a compile — most of them measure timing in a real
    // browser, and device-stage failed once (2 of its 15 checks, "533 desktop
    // px off") while cargo compiled alongside, passing in three runs without.
    ...[
        ['e2e-ice-url', 'ice-url-real-browser.mjs'],
        ['e2e-h264-profile', 'h264-profile-real-browser.mjs'],
        ['e2e-stream-stats', 'stream-stats-real-browser.mjs'],
        ['e2e-share-quality-live', 'share-quality-live-real-browser.mjs'],
        ['e2e-notes-dialog-escape', 'notes-dialog-escape-real-browser.mjs'],
        ['e2e-user-menu-move-to', 'user-menu-move-to-real-browser.mjs'],
        ['e2e-paste-html', 'paste-html-real-browser.mjs'],
        ['e2e-plaintext-disk', 'plaintext-disk-real-browser.mjs'],
        ['e2e-game-sounds-offline', 'game-sounds-offline-real-browser.mjs'],
        // These two default to frontend/e2e/e2e-artifacts/, which is NOT
        // ignored: new files there would change every whole-tree key mid-run
        // and no stamp would ever be written. frontend/e2e-artifacts/ is.
        ['e2e-device-stage', 'device-stage-real-browser.mjs e2e-artifacts/device-stage-shots'],
        ['e2e-no-screen-stage', 'no-screen-stage-real-browser.mjs e2e-artifacts/no-screen-stage-shots'],
        ['e2e-video-controls', 'video-controls-real-browser.mjs'],
        ['e2e-device-stage-desktop', 'device-stage-desktop-real-browser.mjs'],
    ].map(([id, file]) => ({
        id, title: `e2e/${file.split(' ')[0]} (real browser, no server)`,
        inputs: ALL, ignoreVersion: true, fingerprint: ['node', 'fe-deps'],
        after: ['vitest'],
        cpu: 'exclusive',
        steps: [{ run: `node e2e/${file}`, cwd: FE, lock: 'browser' }],
    })),
];

// Never run by this script; printed in every summary.
const NOT_RUN_HERE = [
    'connectedDebugAndroidTest (notes-app, headless emulator)',
    'e2e/feature-flows.mjs, games-live, games-walk, own-voice-2device, notes-walk, notes-desktop-embed, member-popup-scroll (throwaway backend)',
    'e2e/poker-table-real-browser.mjs, user-context-menu-reach.mjs (vite dev server)',
    'e2e-live-verify, batch7-permbits-live, the two-peer voice suites (throwaway stack)',
];

function vitestCheck(out) {
    const files = out.match(/Test Files\s+(?:\d+ failed \| )?(\d+) passed/);
    if (!files || Number(files[1]) === 0) return 'vitest reported no passing test files';
    return null;
}

function cargoCheck(out) {
    if (!/test result: ok\./.test(out)) return 'cargo printed no "test result: ok." line';
    return null;
}

function summarize(id, out) {
    if (id === 'vitest') {
        const t = out.match(/Tests\s+(\d+) passed(?: \| (\d+) skipped)?/);
        const f = out.match(/Test Files\s+(\d+) passed/);
        if (t) return `${f ? f[1] : '?'} files, ${t[1]} tests passed${t[2] ? `, ${t[2]} skipped` : ''}`;
    }
    if (id.startsWith('cargo-')) {
        let passed = 0, ignored = 0;
        for (const m of out.matchAll(/test result: ok\. (\d+) passed; \d+ failed; (\d+) ignored/g)) {
            passed += Number(m[1]); ignored += Number(m[2]);
        }
        // libtest captures a passing test's stdout, so the DB tests' own
        // "skipping: TEST_DATABASE_URL not set" lines never reach this output:
        // say it from the environment instead (CLAUDE.md: ~40 DB-backed tests
        // print that and PASS without running).
        const db = id === 'cargo-backend' && !process.env.TEST_DATABASE_URL
            ? '; TEST_DATABASE_URL unset, so the DB-backed tests passed WITHOUT RUNNING' : '';
        return `${passed} passed, ${ignored} ignored${db}`;
    }
    return '';
}

// ------------------------------------------------------------ fingerprints

function sh(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
    if (r.error) throw r.error;
    return r;
}

function git(args, opts) {
    const r = sh('git', args, opts);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
}

const fingerprintCache = new Map();
function fingerprint(kind) {
    if (fingerprintCache.has(kind)) return fingerprintCache.get(kind);
    const version = (cmd, args, opts) => {
        try {
            const r = sh(cmd, args, { shell: WIN, ...opts });
            return r.status === 0 ? (r.stdout + r.stderr).trim() : `<${cmd} unavailable>`;
        } catch { return `<${cmd} unavailable>`; }
    };
    const fileHash = (rel) => {
        try { return sha256(fs.readFileSync(path.join(ROOT, rel))); } catch { return '<missing>'; }
    };
    let v;
    switch (kind) {
        case 'node': v = `node ${process.version}`; break;
        // npm rewrites node_modules/.package-lock.json on every install: it is
        // what is INSTALLED, which package-lock.json (an input) is not.
        case 'fe-deps': v = `fe node_modules ${fileHash('frontend/node_modules/.package-lock.json')}`; break;
        case 'notes-deps': v = `notes node_modules ${fileHash('frontend/notes-app/node_modules/.package-lock.json')}`; break;
        case 'decky-deps': v = `decky node_modules ${fileHash('integrations/decky/node_modules/.package-lock.json')}`; break;
        case 'rust': v = `${version('rustc', ['-V'])} | ${version('cargo', ['-V'])}`; break;
        case 'java': v = version(path.join(javaHome || '', 'bin', 'java'), ['-version'], { shell: false }); break;
        case 'python': v = version(python, ['--version']); break;
        // vite reads frontend/.env* — the gitignored ones (.env.production
        // carries the API URL the build bakes in) are not in the tree — and
        // VITE_* / PUCA_* from the environment (PUCA_ALLOW_LOCAL_BUILD).
        case 'fe-env': {
            const dir = path.join(ROOT, FE);
            const files = fs.readdirSync(dir).filter((f) => f.startsWith('.env')).sort();
            const vars = Object.keys(process.env).filter((k) => /^(VITE_|PUCA_)/.test(k)).sort();
            v = `fe env ${sha256([...files.map((f) => `${f}:${fileHash(`${FE}/${f}`)}`), ...vars.map((k) => `${k}=${process.env[k]}`)].join('|'))}`;
            break;
        }
        // Whether the DB-backed tests can run is part of what a pass proves.
        case 'test-db': v = process.env.TEST_DATABASE_URL ? `TEST_DATABASE_URL ${sha256(process.env.TEST_DATABASE_URL).slice(0, 12)}` : 'TEST_DATABASE_URL unset'; break;
        default: throw new Error(`unknown fingerprint ${kind}`);
    }
    fingerprintCache.set(kind, v);
    return v;
}

function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

// ----------------------------------------------------- the working tree

/**
 * path -> git blob id for the working tree as it is on disk: the index's
 * entries, with modified and untracked-but-not-ignored files re-hashed
 * (hash-object without -w: nothing is written to the object store) and
 * deleted ones dropped. Line-ending filters apply exactly as `git add` would.
 */
function snapshotTree() {
    const tree = new Map();
    const z = (out) => out.split('\0').filter(Boolean);
    for (const line of z(git(['ls-files', '-s', '-z']))) {
        const [meta, p] = line.split('\t');
        const [mode, oid] = meta.split(' ');
        tree.set(p, mode === '160000' ? `commit ${oid}` : oid);
    }
    for (const p of z(git(['ls-files', '-d', '-z']))) tree.delete(p);
    const changed = [...new Set([...z(git(['ls-files', '-m', '-z'])), ...z(git(['ls-files', '-o', '--exclude-standard', '-z']))])]
        .filter((p) => fs.existsSync(path.join(ROOT, p)) && fs.statSync(path.join(ROOT, p)).isFile());
    if (changed.length) {
        const oids = git(['hash-object', '--stdin-paths'], { input: changed.join('\n') + '\n' }).trim().split('\n');
        changed.forEach((p, i) => tree.set(p, oids[i]));
    }
    return tree;
}

function currentVersion() {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/src-tauri/tauri.conf.json'), 'utf8')).version;
}

function versionBlanked(rel, version) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
    return 'blanked ' + sha256(text.split(version).join('<VERSION>').replace(/def baseVersionCode = \d+/, 'def baseVersionCode = <VERSION>'));
}

function inScope(p, inputs) {
    return inputs === ALL || inputs.some((i) => (i.endsWith('/') ? p.startsWith(i) : p === i));
}

/**
 * The scoped Rust gate's include_str!/include_bytes!/CARGO_MANIFEST_DIR paths,
 * resolved; any that lands outside the gate's inputs. Returns the offenders.
 */
function scopeAudit(gate, tree) {
    const offenders = [];
    const pattern = /(?:include_(?:str|bytes)!\(\s*"([^"]+)"|CARGO_MANIFEST_DIR"\)\s*,\s*"([^"]+)")/g;
    for (const p of tree.keys()) {
        if (!p.endsWith('.rs') || !gate.scopeAudit.roots.some((r) => p.startsWith(r))) continue;
        const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
        for (const m of src.matchAll(pattern)) {
            const raw = m[1] ?? m[2];
            // include_str! is relative to the file; CARGO_MANIFEST_DIR to the crate.
            let base = path.posix.dirname(p);
            if (m[2] !== undefined) {
                let dir = base;
                while (dir !== '.' && !tree.has(`${dir}/Cargo.toml`)) dir = path.posix.dirname(dir);
                base = dir;
            }
            const target = path.posix.normalize(path.posix.join(base, raw.replace(/^\//, '')));
            if (!inScope(target, gate.inputs)) offenders.push(`${p}: ${raw} -> ${target}`);
        }
    }
    return offenders;
}

function gateKey(gate, tree, version) {
    let inputs = gate.inputs;
    const notes = [];
    if (gate.scopeAudit) {
        const offenders = scopeAudit(gate, tree);
        if (offenders.length) {
            notes.push(`scope widened to the whole tree: ${offenders.length} compile-time read(s) outside its inputs, e.g. ${offenders[0]}`);
            inputs = ALL;
        }
    }
    const h = createHash('sha256');
    h.update(`format ${STAMP_FORMAT} gate ${gate.id}\n`);
    // The gate's own definition — commands, directories, env, checks — is
    // part of its key, so this script is not an input of every gate: editing
    // its summary does not re-run nine minutes of gates; editing what a gate
    // RUNS does.
    h.update(`steps ${JSON.stringify(gate.steps.map((s) => [s.run, s.cwd ?? '', s.lock ?? '', !!s.nice, s.env ?? {}, String(s.check ?? ''), String(s.when ?? '')]))}\n`);
    for (const f of gate.fingerprint) h.update(`fp ${f} ${fingerprint(f)}\n`);
    // ...except for lint, whose checks walk the repository's files.
    const paths = [...tree.keys()].filter((p) => inScope(p, inputs) && (p !== SELF || gate.id === 'lint')).sort();
    for (const p of paths) {
        if (gate.ignoreVersion && p === CHANGELOG) continue;
        const id = gate.ignoreVersion && VERSION_CARRIERS.includes(p) ? versionBlanked(p, version) : tree.get(p);
        h.update(`${p}\0${id}\n`);
    }
    return { key: h.digest('hex'), files: paths.length, notes };
}

// ---------------------------------------------------------------- stamps

const STATE_DIR = path.resolve(ROOT, git(['rev-parse', '--git-path', 'puca-gates']).trim());
const STAMPS = path.join(STATE_DIR, 'stamps.json');
const LOGS = path.join(STATE_DIR, 'logs');

function readStamps() {
    try { return JSON.parse(fs.readFileSync(STAMPS, 'utf8')); } catch { return {}; }
}

function writeStamps(stamps) {
    const tmp = `${STAMPS}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stamps, null, 2));
    fs.renameSync(tmp, STAMPS);
}

// ------------------------------------------------------------- the runner

/** Whole-machine CPU busy % over one second (os.loadavg() is always 0 on Windows). */
async function cpuBusyPercent() {
    const sample = () => os.cpus().reduce((a, c) => {
        const t = c.times;
        a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.irq + t.idle;
        return a;
    }, { idle: 0, total: 0 });
    const a = sample();
    await new Promise((r) => setTimeout(r, 1000));
    const b = sample();
    const total = b.total - a.total;
    return total > 0 ? Math.round(100 * (1 - (b.idle - a.idle) / total)) : 0;
}

function parseArgs(argv) {
    const o = { all: false, plan: false, only: null, jobs: 4 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--all') o.all = true;
        else if (a === '--plan') o.plan = true;
        else if (a === '--only') o.only = argv[++i].split(',');
        else if (a === '--jobs') o.jobs = Math.max(1, Number(argv[++i]) || 1);
        else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
        else { console.error(`unknown argument ${a} (try --help)`); process.exit(2); }
    }
    if (o.only) {
        const unknown = o.only.filter((id) => !GATES.some((g) => g.id === id));
        if (unknown.length) { console.error(`unknown gate(s): ${unknown.join(', ')}; ids: ${GATES.map((g) => g.id).join(', ')}`); process.exit(2); }
    }
    return o;
}

const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`;
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[gates ${stamp()}] ${msg}`);

const children = new Set();
let interrupted = false;
function killAll() {
    for (const c of children) {
        if (WIN) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
        else { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } }
    }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        interrupted = true;
        log(`${sig}: stopping every gate; no stamp from this run is written for anything still running`);
        killAll();
    });
}

// A `nice` step runs under this wrapper: it lowers its OWN priority (Windows
// gives children of a below-normal process the same class; POSIX inherits
// niceness), then runs the command and exits with ITS exit code. Compiles yield
// the CPU to vitest's tests that wait in real time instead of starving them.
// (`start /BELOWNORMAL /WAIT` was the obvious alternative and returns 0 for a
// command that failed.)
const NICE_WRAPPER = [
    "const os = require('node:os');",
    'os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);',
    "const r = require('node:child_process').spawnSync(process.argv[1], { shell: true, stdio: 'inherit' });",
    'process.exit(r.status === null ? 1 : r.status);',
].join(' ');

function runStep(step, logStream) {
    return new Promise((resolve) => {
        const [cmd, args, shell] = step.nice ? [process.execPath, ['-e', NICE_WRAPPER, step.run], false] : [step.run, [], true];
        const child = spawn(cmd, args, {
            cwd: path.join(ROOT, step.cwd ?? '.'), shell, detached: !WIN,
            env: { ...process.env, ...Object.fromEntries(Object.entries(step.env ?? {}).filter(([, v]) => v !== undefined)), FORCE_COLOR: '0' },
        });
        children.add(child);
        let out = '';
        const take = (d) => { const s = d.toString(); out += s; logStream.write(s); };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        child.on('close', (code) => { children.delete(child); resolve({ code: code ?? 1, out }); });
        child.on('error', (e) => { children.delete(child); resolve({ code: 1, out: out + String(e) }); });
    });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    fs.mkdirSync(LOGS, { recursive: true });
    const lockFile = path.join(STATE_DIR, 'run.lock');
    try {
        const pid = Number(fs.readFileSync(lockFile, 'utf8'));
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
        if (alive && !opts.plan) { console.error(`another gates run (pid ${pid}) is using this checkout; ${lockFile}`); process.exit(2); }
    } catch { /* no lock */ }
    if (!opts.plan) fs.writeFileSync(lockFile, String(process.pid));
    const releaseLock = () => { try { if (Number(fs.readFileSync(lockFile, 'utf8')) === process.pid) fs.unlinkSync(lockFile); } catch { /* fine */ } };
    process.on('exit', releaseLock);

    const head = git(['rev-parse', '--short', 'HEAD']).trim();
    const dirty = git(['status', '--porcelain']).trim() !== '';
    const version = currentVersion();
    const tree = snapshotTree();
    const stamps = readStamps();
    const selected = GATES.filter((g) => !opts.only || opts.only.includes(g.id));

    log(`HEAD ${head}${dirty ? ' + uncommitted changes' : ''}, version ${version}, ${tree.size} files in the tree; stamps: ${STAMPS}`);
    if (!opts.plan) {
        const busy = await cpuBusyPercent();
        if (busy >= 25) {
            log(`WARNING: the machine is ${busy}% busy before any gate started. vitest's tests that wait in real time `
                + '(deviceSessionLifecycle, deviceAudioHubController, authedMediaType, attachmentAutoload, …) slow down under load '
                + 'and can time out: a failure there on a busy desktop is load until shown otherwise — re-run it on a quieter machine, '
                + 'or with VITEST_MAX_WORKERS=3, and never by retrying until green.');
        }
    }
    const plan = selected.map((g) => {
        const k = gateKey(g, tree, version);
        const prev = stamps[g.id];
        const skip = !opts.all && prev && prev.key === k.key;
        return { gate: g, ...k, prev, skip };
    });
    for (const p of plan) {
        for (const n of p.notes) log(`NOTE ${p.gate.id}: ${n}`);
        if (p.skip) {
            log(`SKIPPED ${p.gate.id} — NOT RUN: its ${p.files} input files are identical to the run that PASSED at ${p.prev.passedAt} `
                + `(HEAD ${p.prev.head}${p.prev.dirty ? ' + uncommitted' : ''}, ${p.prev.version}, took ${fmt(p.prev.ms)}${p.prev.summary ? `; ${p.prev.summary}` : ''})`);
        }
    }
    if (opts.plan) {
        for (const p of plan.filter((x) => !x.skip)) log(`would run ${p.gate.id}: ${p.gate.title}${p.prev ? '' : ' (no pass stamp)'}`);
        return 0;
    }

    // Schedule: a gate starts when its `after` gates are settled and the lock
    // of its NEXT step is free; at most opts.jobs at once.
    const results = new Map(plan.filter((p) => p.skip).map((p) => [p.gate.id, { status: 'skipped', p }]));
    const pending = plan.filter((p) => !p.skip);
    const locks = new Set();
    let running = 0;
    const t0 = Date.now();

    await new Promise((resolve) => {
        let poll = null;
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            clearInterval(poll);
            resolve();
        };
        const tick = () => {
            if (!interrupted) {
                for (const p of [...pending]) {
                    if (running >= opts.jobs) break;
                    const waits = (p.gate.after ?? []).filter((id) => pending.some((q) => q.gate.id === id) || results.get(id)?.status === 'running');
                    if (waits.length) continue;
                    const firstLock = p.gate.steps[0].lock;
                    if (firstLock && locks.has(firstLock)) continue;
                    const busy = [...results.values()].filter((r) => r.status === 'running').map((r) => r.p.gate.cpu);
                    if (p.gate.cpu === 'exclusive' && busy.includes('heavy')) continue;
                    if (p.gate.cpu === 'heavy' && busy.includes('exclusive')) continue;
                    pending.splice(pending.indexOf(p), 1);
                    running++;
                    results.set(p.gate.id, { status: 'running', p });
                    runGate(p, locks).then((r) => {
                        running--;
                        results.set(p.gate.id, r);
                        tick();
                    });
                }
            }
            if (running === 0 && (pending.length === 0 || interrupted)) finish();
        };
        // Locks are released between a gate's steps; re-check what can start.
        poll = setInterval(tick, 500);
        tick();
    });

    // Write stamps for passes whose inputs did not move while they ran.
    const after = snapshotTree();
    const fresh = readStamps();
    for (const [id, r] of results) {
        if (r.status === 'passed') {
            const now = gateKey(r.p.gate, after, currentVersion());
            if (now.key === r.p.key) {
                fresh[id] = { key: r.p.key, passedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z', head, dirty, version, ms: r.ms, summary: r.summary };
            } else {
                r.status = 'passed-unstamped';
            }
        } else if (r.status === 'failed') {
            delete fresh[id];
        }
    }
    if (!interrupted) writeStamps(fresh);
    else log('interrupted: no stamps written');

    // Summary.
    console.log('\n================================ gates summary ================================');
    const order = { failed: 0, interrupted: 1, 'passed-unstamped': 2, passed: 3, skipped: 4 };
    const rows = [...results.values()].sort((a, b) => order[a.status] - order[b.status]);
    for (const r of rows) {
        const id = r.p.gate.id.padEnd(26);
        if (r.status === 'skipped') console.log(`  SKIPPED  ${id} not run: inputs unchanged since its pass at ${r.p.prev.passedAt} (${r.p.prev.head})`);
        else if (r.status === 'passed') console.log(`  PASS     ${id} ${fmt(r.ms).padStart(6)}  ${r.summary}`);
        else if (r.status === 'passed-unstamped') console.log(`  PASS*    ${id} ${fmt(r.ms).padStart(6)}  inputs changed while it ran: passed, but NOT stamped`);
        else if (r.status === 'interrupted') console.log(`  STOPPED  ${id} interrupted`);
        else console.log(`  FAIL     ${id} ${fmt(r.ms).padStart(6)}  ${r.reason}  (log: ${r.logPath})`);
    }
    for (const p of pending) console.log(`  STOPPED  ${p.gate.id.padEnd(26)} never started`);
    console.log('  ------------------------------------------------------------------------------');
    console.log('  NOT RUN by this script — run by hand when the change touches them (CLAUDE.md, Gates):');
    for (const n of NOT_RUN_HERE) console.log(`    - ${n}`);
    const skipped = rows.filter((r) => r.status === 'skipped').length;
    if (skipped) console.log(`  ${skipped} gate(s) SKIPPED on a matching pass stamp. --all runs them anyway.`);
    console.log(`  wall time ${fmt(Date.now() - t0)}`);
    const bad = rows.some((r) => r.status === 'failed' || r.status === 'interrupted') || pending.length > 0 || interrupted;
    console.log(bad ? '  RESULT: FAILED' : '  RESULT: every gate above passed or was skipped on a pass stamp');
    return bad ? 1 : 0;
}

async function runGate(p, locks) {
    const g = p.gate;
    const logPath = path.join(LOGS, `${g.id}.log`);
    const logStream = fs.createWriteStream(logPath);
    const t = Date.now();
    log(`START ${g.id}: ${g.title}`);
    let all = '';
    for (const step of g.steps) {
        if (step.when && !step.when()) continue;
        while (step.lock && locks.has(step.lock)) {
            if (interrupted) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        if (interrupted) { logStream.end(); return { status: 'interrupted', p, ms: Date.now() - t, logPath }; }
        if (step.lock) locks.add(step.lock);
        logStream.write(`\n$ (${step.cwd ?? '.'}) ${step.run}\n`);
        const { code, out } = await runStep(step, logStream);
        if (step.lock) locks.delete(step.lock);
        all += out;
        if (interrupted) { logStream.end(); return { status: 'interrupted', p, ms: Date.now() - t, logPath }; }
        const checkError = step.check ? step.check(out, code) : null;
        if (code !== 0 || checkError) {
            logStream.end();
            const reason = checkError ?? `\`${step.run}\` exited ${code}`;
            log(`FAIL ${g.id} after ${fmt(Date.now() - t)}: ${reason}\n${out.split('\n').slice(-40).join('\n')}`);
            return { status: 'failed', p, ms: Date.now() - t, reason, logPath };
        }
    }
    logStream.end();
    const summary = summarize(g.id, all);
    log(`PASS ${g.id} in ${fmt(Date.now() - t)}${summary ? ` — ${summary}` : ''}`);
    return { status: 'passed', p, ms: Date.now() - t, summary, logPath };
}

main().then((code) => process.exit(code), (e) => { console.error(e); killAll(); process.exit(1); });
