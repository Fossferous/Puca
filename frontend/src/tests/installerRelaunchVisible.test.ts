/**
 * An update brings the app back with its window ("puca doesnt currently reopen
 * when update is complete", 2026-11-06).
 *
 * The chain, one link per assertion below:
 *  1. Windows starts the app at sign-in as `Puca.exe --hidden` (the autostart
 *     plugin, lib.rs) and lib.rs hides the window on `--hidden`.
 *  2. tauri-plugin-updater runs the installer as `/P /UPDATE /R /ARGS <the
 *     running app's own arguments>`, so `--hidden` rides along, and Tauri's NSIS
 *     template starts the new exe with it: the update installs, the app runs,
 *     and nothing is on the screen. The new process has `--hidden` too, so
 *     the next update does the same.
 *  3. src-tauri/installer-relaunch.nsh takes `--hidden` off that command line
 *     after a PASSIVE install, and both hook files insert it in
 *     NSIS_HOOK_POSTINSTALL. A SILENT install (`/S`, a PC updating itself while
 *     nobody is there: host_update.rs) keeps it.
 *
 * This is the text-level pin, so `npx vitest run` notices a revert on a machine
 * with no NSIS. What the macro DOES to a command line is proved by RUNNING it:
 * `npm run check:installer-hooks` (scripts/check-installer-hooks.mjs, its last
 * section) builds a test installer from the template's own relaunch lines and
 * feeds it the updater's command lines, with the template alone as the control.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC_TAURI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src-tauri');
const read = (...p: string[]) => readFileSync(join(SRC_TAURI, ...p), 'utf8');

/** The body of one NSIS macro: from its `!macro NAME` line to its `!macroend`. */
function macroBody(source: string, name: string): string {
    const start = source.search(new RegExp(`^!macro\\s+${name}\\b`, 'm'));
    expect(start, `!macro ${name} is defined`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('!macroend', start);
    expect(end, `!macro ${name} is closed`).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe('an update comes back with its window, not in the tray', () => {
    it('the app is started by Windows with --hidden, and --hidden hides its window', () => {
        const lib = read('src', 'lib.rs');
        expect(lib).toMatch(/tauri_plugin_autostart::init\([\s\S]*?Some\(vec!\["--hidden"\]\)/);
        const deepLink = read('src', 'deep_link.rs');
        expect(deepLink).toMatch(/pub fn starts_hidden[\s\S]*?a\.as_ref\(\) == "--hidden"/);
    });

    it('the installer macro only edits a passive install, and only takes out --hidden', () => {
        const relaunch = read('installer-relaunch.nsh');
        const body = macroBody(relaunch, 'RelaunchVisibleAfterPassiveUpdate');
        expect(body).toMatch(/\$\{If\} \$PassiveMode = 1/);
        // A PC updating itself runs `/P /UPDATE /R /ARGS <args> /S` (passive
        // AND silent), so $PassiveMode alone would edit it too.
        expect(body).toMatch(/\$\{AndIfNot\} \$\{Silent\}/);
        expect(body).toMatch(/\$CMDLINE/);
        expect(body).toContain('--hidden');
        // It is a command-line edit and nothing more: the stand-alone test
        // installer in check-installer-hooks.mjs RUNS this file, which is only
        // safe while it cannot reach the registry, a process or a file.
        for (const forbidden of ['WriteReg', 'DeleteReg', 'nsExec', 'ExecWait', 'Exec ', 'Delete ', 'RMDir', 'File ', 'taskkill']) {
            expect(relaunch, `installer-relaunch.nsh must not contain ${forbidden}`).not.toContain(forbidden);
        }
    });

    it.each(['installer-hooks.nsh', 'installer-hooks-lite.nsh'])('%s includes it and inserts it in NSIS_HOOK_POSTINSTALL', (file) => {
        const hooks = read(file);
        expect(hooks).toMatch(/^!include "\$\{__FILEDIR__\}\\installer-relaunch\.nsh"/m);
        expect(macroBody(hooks, 'NSIS_HOOK_POSTINSTALL')).toMatch(/^\s*!insertmacro RelaunchVisibleAfterPassiveUpdate\s*$/m);
        // Not in the other hooks: a pre-install or an uninstall has no
        // relaunch to change.
        for (const other of ['NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_PREUNINSTALL', 'NSIS_HOOK_POSTUNINSTALL']) {
            expect(macroBody(hooks, other)).not.toContain('RelaunchVisibleAfterPassiveUpdate');
        }
    });

    it('a PC updating itself runs the installer passive AND silent, which the macro leaves alone', () => {
        const hostUpdate = read('src', 'host_update.rs');
        // /S is appended by the host's own updater, after the plugin's
        // /P /UPDATE /R /ARGS <args> (the config's install mode supplies /P).
        expect(hostUpdate).toMatch(/pub const QUIET_INSTALLER_ARGS: \[&str; 1\] = \["\/S"\];/);
        expect(hostUpdate).toContain('.installer_args(QUIET_INSTALLER_ARGS)');
        expect(JSON.parse(read('tauri.conf.json')).plugins.updater.windows.installMode).toBe('passive');
    });
});
