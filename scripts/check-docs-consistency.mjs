#!/usr/bin/env node
/**
 * Pin the operator/user documentation to the code it describes.
 *
 * WHY. Every check below corresponds to a documented claim that was found
 * false against the tree at launch review: the deploy guide said TURN was
 * optional with a public-relay fallback the code had removed, a 24 h
 * credential the code minted for 4 h, and a PBKDF2 password wrap the client
 * had replaced with Argon2id; .env.example shipped a 5-connection pool the
 * code's own comment calls a stall vector and documented a variable nothing
 * reads; a retired guide told operators to edit a constant that does not
 * exist. None of that is visible to a type checker or a test. The rules here
 * are cheap greps, each named for the drift it stops, with a message that
 * says what to change.
 *
 * Run: node scripts/check-docs-consistency.mjs   (chained into `npm run lint`)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
/** The docs use U+2011 (non-breaking hyphen) in places; compare on ASCII. */
const ascii = (s) => s.replace(/‑/g, '-');

const problems = [];
const fail = (where, what) => problems.push({ where, what });

function tracked(patterns) {
    const out = execFileSync('git', ['ls-files', '--', ...patterns], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
}

// ---------------------------------------------------------------------------
// 1. Retired claims must not come back. Each token names something the tree
//    no longer has (or never had), spelled the way the stale docs spelled it.
const STALE = [
    ['OpenRelay', 'the third-party relay fallback was removed from get_ice_config; TURN is the only relay'],
    ['CURRENT_VERSION', 'no such constant; versions come from tauri.conf.json and the operator-pushed JSON files'],
    ['get_platform_info', 'no such function; latest.json is written by deploy/ops/dual-ship.sh'],
    ['sovereign.exe', 'the binary is `puca` (Cargo.toml name)'],
    ['/api/updates/', 'no such route; the updater reads a static latest.json and /app-version'],
    ['location /api', 'proxy the WHOLE origin; the API lives at the root'],
    ['PUBLIC_BASE_URL', 'nothing reads it; the variable is APP_URL (src/email.rs)'],
    ['Porkbun', 'one registrar\'s name is not a self-hoster\'s instruction'],
    ['TestFlight', 'iOS is outside the launch scope; no ship subcommand produces an iOS artifact'],
    ['signatures are empty', 'installers are signed (createUpdaterArtifacts + dual-ship.sh <sig-file>)'],
    ['a table that no migration creates', 'channel_read_state is created by migrations/001_init.sql'],
    ['~/.claude/', 'a path on one maintainer\'s workstation is not documentation'],
    ['Not Tested', 'an internal QA audit is not product documentation'],
    ['Immediate Fixes Needed', 'an internal fix list is not product documentation'],
    ['Last Audit:', 'a dated QA audit is not product documentation'],
];
const docFiles = tracked(['docs/*.md', 'deploy/**', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', '.env.example'])
    .filter((f) => /\.(md|html|conf|snippet|example|service|cron|py|sh|json)$|Caddyfile/.test(f));
for (const f of docFiles) {
    if (f === 'scripts/check-docs-consistency.mjs') continue;
    const text = read(f);
    for (const [token, why] of STALE) {
        const at = text.indexOf(token);
        if (at === -1) continue;
        const line = text.slice(0, at).split('\n').length;
        fail(`${f}:${line}`, `stale claim "${token}" — ${why}`);
    }
}

// ---------------------------------------------------------------------------
// 2. TURN credential lifetime: the docs must say what the code does.
{
    const code = read('src/server_handlers.rs');
    const m = /now_secs \+ (\d+);\s*\/\/\s*(\d+)h/.exec(code);
    if (!m) fail('src/server_handlers.rs', 'could not find the TURN credential TTL (`now_secs + N; // Nh`) — update this check');
    else {
        const hours = Number(m[1]) / 3600;
        for (const f of ['deploy/README.md', 'deploy/turn/README.md', 'docs/FEATURES_AND_TECHNOLOGY.md']) {
            const text = ascii(read(f));
            const re = new RegExp(`\\b${hours}[ -]?(h|hour|hours)\\b`);
            if (!re.test(text)) fail(f, `must state the TURN credential lifetime the code mints (${hours} h)`);
            const wrong = text.split('\n').findIndex((l) => /TURN|credential/i.test(l) && /\b(12|24)[ -]?(h|hour|hours)\b/.test(l));
            if (wrong !== -1) fail(`${f}:${wrong + 1}`, 'names a 12 h / 24 h TURN credential; the code mints 4 h');
        }
    }
}

// ---------------------------------------------------------------------------
// 3. Password wrap KDF: FEATURES_AND_TECHNOLOGY and README name the one the client uses.
{
    const e2ee = read('frontend/src/api/e2ee.ts');
    if (!/PW_KDF_ARGON2: PwKdf = 'argon2id'/.test(e2ee)) {
        fail('frontend/src/api/e2ee.ts', 'the password-wrap KDF constant moved; update this check');
    } else {
        const feat = ascii(read('docs/FEATURES_AND_TECHNOLOGY.md'));
        const row = feat.split('\n').find((l) => /Password .* key wrap/.test(l));
        if (!row) fail('docs/FEATURES_AND_TECHNOLOGY.md', 'the "Password -> key wrap" crypto-table row is gone');
        else if (!/Argon2id/.test(row)) fail('docs/FEATURES_AND_TECHNOLOGY.md', 'the password-wrap row must say Argon2id (e2ee.ts uses argon2id; PBKDF2 is the legacy branch)');
        if (!/Argon2id/.test(read('README.md'))) fail('README.md', 'must name Argon2id as the password wrap');
    }
}

// ---------------------------------------------------------------------------
// 4. The recovery code the app forces users to save is in the user docs.
for (const f of ['docs/GETTING_STARTED.md', 'docs/USER_GUIDE.md']) {
    if (!/recovery code/i.test(read(f))) fail(f, 'must tell a new user about the 12-word recovery code shown once at sign-up');
}
if (!exists('docs/LOST_RECOVERY_CODE.md')) fail('docs/LOST_RECOVERY_CODE.md', 'missing — the "lost recovery code" page');
else if (!read('README.md').includes('docs/LOST_RECOVERY_CODE.md')) fail('README.md', 'must link docs/LOST_RECOVERY_CODE.md');
if (!exists('docs/PRIVACY.md')) fail('docs/PRIVACY.md', 'missing — the privacy statement');
else if (!read('README.md').includes('docs/PRIVACY.md')) fail('README.md', 'must link docs/PRIVACY.md');
if (!exists('SECURITY.md')) fail('SECURITY.md', 'missing — the disclosure policy');

// ---------------------------------------------------------------------------
// 5. Every ops script is described in deploy/ops/README.md, and the deploy
//    guide reaches every part of deploy/.
{
    const opsReadme = read('deploy/ops/README.md');
    for (const f of fs.readdirSync(path.join(ROOT, 'deploy/ops'))) {
        if (!/\.(sh|py|cron|example)$/.test(f) || /\.test\.sh$/.test(f)) continue;
        if (!opsReadme.includes(f)) fail('deploy/ops/README.md', `does not mention deploy/ops/${f}`);
    }
    const guide = read('deploy/README.md');
    for (const ref of ['ops/README.md', 'webapp/README.md', 'livekit/README.md', 'turn/README.md', 'mobile/README.md',
        'download-site/', 'migrate/provision.sh', 'ops/backup.sh', 'ops/backup-keys.sh', 'ops/hosts.conf.example',
        'cloudflare/README.md', 'REGISTRATION_INVITE_CODE', 'TAURI_SIGNING_PRIVATE_KEY', 'CHANGELOG.md']) {
        if (!guide.includes(ref)) fail('deploy/README.md', `must reference ${ref}`);
    }
}

// ---------------------------------------------------------------------------
// 6. Every environment variable the backend reads is documented in .env.example.
{
    const names = new Set();
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.rs')) {
                for (const m of read(p).matchAll(/env::var(?:_os)?\("([A-Z][A-Z0-9_]+)"\)/g)) names.add(m[1]);
            }
        }
    };
    walk('src');
    /** Read only by tests; a server operator never sets it. */
    const TEST_ONLY = new Set(['TEST_DATABASE_URL']);
    const env = read('.env.example');
    for (const n of [...names].sort()) {
        if (TEST_ONLY.has(n)) continue;
        if (!new RegExp(`^#?\\s*${n}=`, 'm').test(env)) fail('.env.example', `does not document ${n}, which src/ reads`);
    }
}

// ---------------------------------------------------------------------------
// 7. The pool size has one source of truth: the code default.
{
    const main = read('src/main.rs');
    const m = /DATABASE_MAX_CONNECTIONS"\)\s*\.unwrap_or_else\(\|_\| "(\d+)"/.exec(main);
    if (!m) fail('src/main.rs', 'could not find the DATABASE_MAX_CONNECTIONS default — update this check');
    else {
        const def = m[1];
        const envLine = /^#?\s*DATABASE_MAX_CONNECTIONS=(\d+)/m.exec(read('.env.example'));
        if (!envLine) fail('.env.example', 'must document DATABASE_MAX_CONNECTIONS');
        else if (envLine[1] !== def) fail('.env.example', `DATABASE_MAX_CONNECTIONS=${envLine[1]} disagrees with the code default ${def}`);
        if (/echo "DATABASE_MAX_CONNECTIONS=/.test(read('deploy/migrate/provision.sh'))) {
            fail('deploy/migrate/provision.sh', 'must not pin DATABASE_MAX_CONNECTIONS (the code default is the one truth)');
        }
    }
}

// ---------------------------------------------------------------------------
// 8. Any doc that shows an ExecStart shows the shipped unit's.
{
    const unit = /^ExecStart=(.+)$/m.exec(read('deploy/puca.service'));
    if (!unit) fail('deploy/puca.service', 'no ExecStart= line');
    else for (const f of tracked(['docs/*.md', 'deploy/**/*.md', 'README.md'])) {
        for (const m of read(f).matchAll(/^\s*ExecStart=(.+)$/gm)) {
            if (m[1].trim() !== unit[1].trim()) fail(f, `ExecStart=${m[1].trim()} diverges from deploy/puca.service (${unit[1].trim()})`);
        }
    }
}

// ---------------------------------------------------------------------------
// 9. An nginx sample that proxies the backend must carry the body-size limit —
//    checked per fenced code block, since prose elsewhere in the same file
//    mentioning the directive proves nothing about the block a reader copies.
for (const f of tracked(['docs/*.md', 'deploy/**/*.md', 'README.md'])) {
    const text = read(f);
    for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
        const block = m[1];
        if (/proxy_pass http:\/\//.test(block) && !/client_max_body_size/.test(block)) {
            const line = text.slice(0, m.index).split('\n').length;
            fail(`${f}:${line}`, 'nginx sample without client_max_body_size — nginx\'s 1 MB default rejects every attachment over 1 MB with a 413');
        }
    }
}

// ---------------------------------------------------------------------------
// 10. Applied migrations stay frozen bytes: git must not normalise them.
{
    const out = execFileSync('git', ['check-attr', 'text', '--', 'migrations/001_init.sql', 'migrations/008_case_insensitive_login.sql'], { cwd: ROOT, encoding: 'utf8' });
    for (const line of out.trim().split('\n')) {
        if (!/: text: unset$/.test(line)) fail('.gitattributes', `${line} — migrations/*.sql must be "-text" (frozen bytes; see migrations/README.md)`);
    }
}

// ---------------------------------------------------------------------------
// 11. Retired documents stay retired.
for (const f of ['docs/FEATURES.md', 'docs/AUTO_UPDATER_GUIDE.md']) {
    if (tracked([f]).length) fail(f, 'retired document is tracked again (see .gitignore for why it was removed)');
}

if (problems.length) {
    console.error(`\ndocs consistency: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
    for (const p of problems) console.error(`  ${p.where}\n    ${p.what}\n`);
    process.exit(1);
}
console.log('docs consistency: clean (stale claims, TURN TTL, KDF, recovery docs, ops listing, env coverage, pool default, ExecStart, nginx body size, migration attrs)');
