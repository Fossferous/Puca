/**
 * Compile the NSIS installer hooks, with makensis, for real.
 *
 * WHY A SEPARATE GATE. `check-lite-identity.mjs` reads these files as TEXT —
 * it proves the BOM is there, the macro is defined and the include is
 * resolvable. None of that is a syntax check, and NSIS only syntax-checks a
 * macro BODY where it is INSERTED, so `!include` alone proves nothing either.
 * A typo inside `MigrateRenamedInstall` therefore survives every check in this
 * repo and surfaces as a failed `npm run tauri:build` twenty minutes into a
 * release — or, worse, as a macro whose argument count silently changed under
 * one of its three call sites.
 *
 * So this builds a minimal .nsi that defines what Tauri's generated installer
 * defines, includes each hook file, and INSERTS all four hooks, then compiles
 * it. Both variants, because they are different files with different call
 * sites.
 *
 * THE POSITIVE CONTROL is the part that makes this more than a smoke test:
 * the full hooks guard the legacy self-migration behind a compile-time
 * `!if "${PRODUCTNAME}" != "Sovereign"`, so a build that pins the old name must
 * produce FEWER install instructions than one that renames. If both numbers
 * came out equal, the compile would be "passing" without the conditional
 * having been evaluated at all.
 *
 * THE puca:// SCHEME (installer-url-scheme.nsh) is checked by what the
 * installer would DO, not by grepping the macro file: each variant's harness
 * goes through makensis's preprocessor (/PPO), which expands every
 * !insertmacro, !define and ${If}, and the INSTALL section must write
 * HKCU\Software\Classes\puca with a shell\open\command of
 * `"$INSTDIR\<exe>" "%1"`, while the UNINSTALL section must remove that key
 * only while it still names the same exe. <exe> is read from the configs the
 * bundler merges (tauri.conf.json, the untracked tauri.release.json when it
 * exists, then tauri.lite.conf.json for Lite): productName and mainBinaryName
 * are install identity, and a name typed into this script would prove nothing
 * about the installer that ships.
 *
 * Needs makensis. That is not optional and it does not skip: a gate that
 * quietly no-ops when its tool is missing reports success for a file nobody
 * compiled. The Tauri CLI downloads NSIS to %LOCALAPPDATA%\tauri\NSIS on the
 * first installer build, which is where this looks; set NSIS_MAKENSIS to point
 * it elsewhere.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const tauriDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');

function findMakensis() {
    const candidates = [
        process.env.NSIS_MAKENSIS,
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'makensis.exe'),
        'C:\\Program Files (x86)\\NSIS\\makensis.exe',
        'C:\\Program Files\\NSIS\\makensis.exe',
    ].filter(Boolean);
    for (const c of candidates) if (existsSync(c)) return c;
    console.error('check-installer-hooks: makensis not found. Looked at:');
    for (const c of candidates) console.error('  ' + c);
    console.error('\nRun an installer build once (npm run tauri:build) to let the Tauri CLI');
    console.error('download NSIS, or set NSIS_MAKENSIS to a makensis.exe.');
    process.exit(1);
}

/**
 * A stand-in for Tauri's generated installer.nsi: the defines the hooks read,
 * the includes they rely on, and every hook actually inserted. In the
 * template's ORDER: it includes the hook file BEFORE it defines PRODUCTNAME
 * and MAINBINARYNAME, so a hook that used either outside a macro body fails
 * here exactly as it would in the real build.
 */
function harness(hooksFile, productName, mainBinaryName) {
    return [
        'Unicode true',
        `Name "${productName}"`,
        'OutFile "harness.exe"',
        'InstallDir "$PROGRAMFILES64\\Harness"',
        'RequestExecutionLevel user',
        '!include LogicLib.nsh',
        '!include FileFunc.nsh',
        `!include "${join(tauriDir, hooksFile).replace(/\\/g, '\\\\')}"`,
        `!define PRODUCTNAME "${productName}"`,
        `!define MAINBINARYNAME "${mainBinaryName}"`,
        '',
        'Section "Install"',
        '  !insertmacro NSIS_HOOK_PREINSTALL',
        '  WriteUninstaller "$INSTDIR\\uninstall.exe"',
        '  !insertmacro NSIS_HOOK_POSTINSTALL',
        'SectionEnd',
        '',
        'Section "Uninstall"',
        '  !insertmacro NSIS_HOOK_PREUNINSTALL',
        '  !insertmacro NSIS_HOOK_POSTUNINSTALL',
        'SectionEnd',
        '',
    ].join('\r\n');
}

/** Compile one harness and return makensis's instruction count. */
function compile(makensis, dir, tag, hooksFile, productName, mainBinaryName) {
    const nsi = join(dir, `${tag}.nsi`);
    // BOM, for the same reason the hook files carry one: without it makensis
    // reads the file in the system ANSI codepage and mangles the non-ASCII
    // product names these hooks look up.
    writeFileSync(nsi, '\ufeff' + harness(hooksFile, productName, mainBinaryName), 'utf8');
    let out;
    try {
        out = execFileSync(makensis, ['/V3', nsi], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        console.error(`FAIL ${tag}: makensis rejected ${hooksFile} with PRODUCTNAME="${productName}"\n`);
        console.error((e.stdout || '') + (e.stderr || ''));
        process.exit(1);
    }
    const m = out.match(/Install:.*?(\d+)\s+instructions/);
    if (!m) {
        console.error(`FAIL ${tag}: could not read an instruction count out of makensis:\n${out}`);
        process.exit(1);
    }
    console.log(`  ok  ${tag}: ${hooksFile} compiles (PRODUCTNAME="${productName}") — ${m[1]} install instructions`);
    return Number(m[1]);
}

const makensis = findMakensis();
console.log(`check-installer-hooks: using ${makensis}`);
const dir = mkdtempSync(join(tmpdir(), 'puca-nsis-'));

const full = compile(makensis, dir, 'full', 'installer-hooks.nsh', 'Púca', 'Puca');
const pinned = compile(makensis, dir, 'full-pinned', 'installer-hooks.nsh', 'Sovereign', 'app');
compile(makensis, dir, 'lite', 'installer-hooks-lite.nsh', 'Púca Lite', 'Puca-Lite');

if (!(full > pinned)) {
    console.error(
        `FAIL: a renaming build produced ${full} install instructions and a build pinned to `
        + `"Sovereign" produced ${pinned}. The renaming build must produce MORE — the legacy `
        + 'self-migration is dropped at compile time by !if "${PRODUCTNAME}" != "Sovereign". '
        + 'Equal counts mean that conditional was never evaluated and this compile proved nothing.',
    );
    process.exit(1);
}
console.log(`  ok  positive control: renaming build ${full} > pinned build ${pinned} instructions`);

// ---------------------------------------------------------------------------
// The puca:// scheme: what each installer WRITES and what its uninstaller
// REMOVES, read out of the preprocessed script (every macro, define and
// ${If} expanded), for the exe name the bundler will actually use.

/**
 * productName and mainBinaryName as `tauri build` sees them: each config in
 * the order scripts/tauri-build.mjs passes it (the tracked base, the untracked
 * release overlay when it exists, then the lite config for Lite). Both are
 * top-level strings, so the JSON merge is simply "the last file that sets it".
 */
function bundlerIdentity(files) {
    const id = {};
    for (const f of files) {
        const path = join(tauriDir, f);
        if (!existsSync(path)) continue;
        const c = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof c.productName === 'string') id.productName = c.productName;
        if (typeof c.mainBinaryName === 'string') id.mainBinaryName = c.mainBinaryName;
    }
    if (!id.productName || !id.mainBinaryName) {
        console.error(`FAIL: ${files.join(' + ')} set no productName/mainBinaryName — the exe the scheme must name is unknown`);
        process.exit(1);
    }
    return id;
}

/** The harness through makensis's preprocessor only: nothing is compiled or run. */
function preprocess(tag, hooksFile, { productName, mainBinaryName }) {
    const nsi = join(dir, `${tag}-ppo.nsi`);
    writeFileSync(nsi, '﻿' + harness(hooksFile, productName, mainBinaryName), 'utf8');
    try {
        return execFileSync(makensis, ['/PPO', nsi], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        console.error(`FAIL ${tag}: makensis could not preprocess ${hooksFile}\n`);
        console.error((e.stdout || '') + (e.stderr || ''));
        process.exit(1);
    }
}

/** One section's lines, trimmed, from preprocessor output. */
function sectionLines(ppo, name) {
    const lines = ppo.split(/\r?\n/).map(l => l.trim());
    const start = lines.indexOf(`Section "${name}"`);
    const end = start < 0 ? -1 : lines.indexOf('SectionEnd', start);
    return start < 0 || end < 0 ? null : lines.slice(start + 1, end);
}

const KEY = 'Software\\Classes\\puca';
/**
 * Every way the scheme can be wrong, as a list of problems (empty = right):
 * written in the Install section, AFTER the other variant's uninstaller has
 * run (MigrateRenamedInstall's ExecWait), with `"$INSTDIR\<exe>" "%1"`; never
 * deleted there; and in the Uninstall section read back, compared with that
 * SAME command and only then deleted — never written.
 */
function schemeProblems(ppo, exe) {
    const problems = [];
    const install = sectionLines(ppo, 'Install');
    const uninstall = sectionLines(ppo, 'Uninstall');
    if (!install || !uninstall) return ['no Install/Uninstall section in the preprocessed script'];
    const command = `"$\\"$INSTDIR\\${exe}$\\" $\\"%1$\\""`;
    const writes = {
        protocol: `WriteRegStr HKCU "${KEY}" "URL Protocol" ""`,
        icon: `WriteRegStr HKCU "${KEY}\\DefaultIcon" "" "$\\"$INSTDIR\\${exe}$\\",0"`,
        command: `WriteRegStr HKCU "${KEY}\\shell\\open\\command" "" ${command}`,
    };
    for (const [what, line] of Object.entries(writes)) {
        if (!install.includes(line)) problems.push(`Install does not write the ${what}: ${line}`);
    }
    const lastUninstallerRun = install.reduce((at, l, i) => (/^ExecWait '\$R0 \/S _\?=\$R1'/.test(l) ? i : at), -1);
    if (lastUninstallerRun < 0) problems.push('Install runs no other install\'s uninstaller (MigrateRenamedInstall) — the ordering check below would be vacuous');
    if (install.indexOf(writes.command) <= lastUninstallerRun) {
        problems.push('Install writes the command BEFORE the other variant\'s uninstaller runs, which would then delete it');
    }
    if (install.some(l => l.startsWith(`DeleteRegKey HKCU "${KEY}"`))) problems.push('Install deletes the key');
    const read = uninstall.indexOf(`ReadRegStr $R7 HKCU "${KEY}\\shell\\open\\command" ""`);
    const compare = uninstall.findIndex(l => l.startsWith('StrCmp `$R7` `' + command.slice(1, -1) + '`'));
    const del = uninstall.indexOf(`DeleteRegKey HKCU "${KEY}"`);
    if (read < 0) problems.push('Uninstall does not read the registered command back');
    if (compare < 0) problems.push(`Uninstall does not compare it with ${command}`);
    if (del < 0) problems.push('Uninstall does not delete the key');
    if (read >= 0 && compare >= 0 && del >= 0 && !(read < compare && compare < del)) {
        problems.push('Uninstall deletes the key without first checking it names this install\'s exe');
    }
    if (uninstall.some(l => l.startsWith(`WriteRegStr HKCU "${KEY}`))) problems.push('Uninstall writes the key');
    return problems;
}

const fullId = bundlerIdentity(['tauri.conf.json', 'tauri.release.json']);
const liteId = bundlerIdentity(['tauri.conf.json', 'tauri.release.json', 'tauri.lite.conf.json']);
if (fullId.mainBinaryName === liteId.mainBinaryName) {
    console.error(`FAIL: full and Lite both name ${fullId.mainBinaryName}.exe — the scheme could not tell them apart`);
    process.exit(1);
}
const ppo = {
    full: preprocess('full', 'installer-hooks.nsh', fullId),
    lite: preprocess('lite', 'installer-hooks-lite.nsh', liteId),
};
for (const [tag, id] of [['full', fullId], ['lite', liteId]]) {
    const problems = schemeProblems(ppo[tag], `${id.mainBinaryName}.exe`);
    if (problems.length) {
        console.error(`FAIL ${tag}: the puca:// scheme for ${id.mainBinaryName}.exe (from the bundler's config):`);
        for (const p of problems) console.error('  - ' + p);
        process.exit(1);
    }
    console.log(`  ok  ${tag}: installs HKCU\\${KEY} -> "$INSTDIR\\${id.mainBinaryName}.exe" "%1", after the other install's uninstaller; uninstall removes it only while it names that exe`);
}
// Negative control: the same checks against the OTHER variant's exe must
// fail, or they would pass a hook that registered the wrong binary.
for (const [tag, other] of [['full', liteId], ['lite', fullId]]) {
    if (schemeProblems(ppo[tag], `${other.mainBinaryName}.exe`).length === 0) {
        console.error(`FAIL control: ${tag}'s preprocessed installer also passes for ${other.mainBinaryName}.exe — the scheme check proves nothing`);
        process.exit(1);
    }
}
console.log('  ok  control: each variant\'s scheme check FAILS for the other variant\'s exe');

// And the thing this gate was written for: every call site passes an OLD_BINARY.
const macro = readFileSync(join(tauriDir, 'installer-migrate.nsh'), 'utf8');
if (!/!macro\s+MigrateRenamedInstall\s+OLD_NAME\s+OLD_BINARY\b/.test(macro)) {
    console.error('FAIL: MigrateRenamedInstall no longer takes an explicit OLD_BINARY — the '
        + 'pre-install taskkill would go back to naming the INSTALLING build\'s binary, which is '
        + 'not the binary of the install being migrated over.');
    process.exit(1);
}
for (const f of ['installer-hooks.nsh', 'installer-hooks-lite.nsh']) {
    const body = readFileSync(join(tauriDir, f), 'utf8');
    for (const call of body.matchAll(/^\s*!insertmacro\s+MigrateRenamedInstall\s+(.*)$/gm)) {
        const args = call[1].match(/"[^"]*"/g) || [];
        if (args.length !== 2) {
            console.error(`FAIL: ${f}: MigrateRenamedInstall ${call[1].trim()} — expected two quoted `
                + 'arguments (old product name, old binary name).');
            process.exit(1);
        }
    }
}
console.log('  ok  every MigrateRenamedInstall call names the old install\'s binary');
// The 0.9.2 fix, pinned so it cannot quietly fall back out. The in-place rename
// keeps the install directory, so the pre-rename binary was left there
// LAUNCHABLE -- and a taskbar pin aimed at it starts a pre-0.9.0 client that
// this server now refuses, behind an error screen on which nothing helps.
// Repairing shortcuts is not enough while the binary they pointed at still runs.
for (const f of ['installer-hooks.nsh', 'installer-hooks-lite.nsh']) {
    const body = readFileSync(join(tauriDir, f), 'utf8');
    if (!/!insertmacro\s+StopOrphanedHelpers\b/.test(body)) {
        console.error('FAIL: ' + f + ': does not insert StopOrphanedHelpers. The NSIS updater kills '
            + 'the app rather than exiting it, so agent_stop() never runs, an orphaned helper holds '
            + 'its own file open, and the install cannot replace it.');
        process.exit(1);
    }
    const calls = [...body.matchAll(/^\s*!insertmacro\s+RemoveSupersededBinary\s+"([^"]*)"/gm)].map(m => m[1]);
    if (!calls.includes('app')) {
        console.error('FAIL: ' + f + ': does not insert RemoveSupersededBinary "app". That is '
            + 'the pre-rename executable of this product, which the in-place rename leaves behind, launchable.');
        process.exit(1);
    }
    for (const c of calls) {
        if (c === 'Puca' || c === 'Puca-Lite') {
            console.error('FAIL: ' + f + ': RemoveSupersededBinary "' + c + '" names a CURRENT binary. '
                + 'On the build whose mainBinaryName that is, it would delete the app it just installed.');
            process.exit(1);
        }
    }
}
console.log('  ok  both hooks stop orphaned helpers and remove the superseded binary');
console.log('check-installer-hooks: PASS');
