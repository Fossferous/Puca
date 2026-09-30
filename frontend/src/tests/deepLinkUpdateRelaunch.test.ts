/**
 * A cold-start `puca://` invite link survives an update installed AT LAUNCH.
 *
 * With "install updates automatically" on, UpdateGate can run the signed
 * installer before Chat ever mounts. The link the page took from the shell
 * (api/deepLink.ts, `deep_link_take`) dies with that process and its
 * sessionStorage — and it does not matter, because the Windows updater
 * relaunches the app with THIS PROCESS'S OWN ARGUMENTS:
 *
 *  - tauri-plugin-updater 2.x hands the updater the app's argv
 *    (`builder.current_exe_args(env.args_os)`, src/lib.rs) and, when
 *    `restart_after_install` holds (its default) and the install mode is not
 *    basicUi, runs the NSIS installer with `/P /UPDATE /R /ARGS "<argv[1..]>"`
 *    (src/updater.rs, `updater_parameters`);
 *  - Tauri's NSIS template, in `.onInstSuccess`, finds `/R` and runs
 *    `$INSTDIR\<exe>` with whatever followed `/ARGS`.
 *
 * So the relaunched app is started with the same `puca://invite/...` argument
 * and takes it again, once. Two settings of OURS decide that, and this pins
 * both: the updater's Windows install mode, in every config the bundler
 * merges, is not basicUi (no `/R`: the installer would not relaunch, and a
 * click on its finish page runs the app with no arguments); and
 * installUpdateInPlace never turns the relaunch off.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const h = vi.hoisted(() => ({ installArgs: [] as unknown[][], relaunches: 0 }));

vi.mock('@tauri-apps/plugin-updater', () => ({
    check: async () => ({
        version: '9.9.9',
        download: async (cb: (e: { event: string; data?: unknown }) => void) => {
            cb({ event: 'Started', data: { contentLength: 1 } });
            cb({ event: 'Progress', data: { chunkLength: 1 } });
            cb({ event: 'Finished' });
        },
        install: async (...args: unknown[]) => { h.installArgs.push(args); },
        close: async () => {},
    }),
}));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => { h.relaunches += 1; } }));

const { installUpdateInPlace } = await import('../api/appVersion');

const SRC_TAURI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src-tauri');
type Conf = { plugins?: { updater?: { windows?: { installMode?: unknown } } } };
const read = (name: string): Conf | null => {
    const p = join(SRC_TAURI, name);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Conf : null;
};
/** The mode the bundler ends up with: later configs override earlier ones;
 *  Tauri's own default is passive. */
const installModeOf = (...names: string[]) => {
    let mode: unknown = 'passive';
    for (const n of names) {
        const m = read(n)?.plugins?.updater?.windows?.installMode;
        if (m !== undefined) mode = m;
    }
    return mode;
};

describe('an update installed at launch relaunches with the launch\'s own arguments', () => {
    it('the updater\'s Windows install mode keeps the relaunch (/R) — full and Lite', () => {
        expect(read('tauri.conf.json'), 'the base config is where it was').not.toBeNull();
        // The release overlay is untracked; read when present, as the build does.
        const full = installModeOf('tauri.conf.json', 'tauri.windows.conf.json', 'tauri.release.json');
        const lite = installModeOf('tauri.conf.json', 'tauri.windows.conf.json', 'tauri.release.json', 'tauri.lite.conf.json');
        for (const mode of [full, lite]) {
            expect(['passive', 'quiet']).toContain(mode);
        }
    });

    it('installUpdateInPlace lets the installer relaunch the app (never restartAfterInstall: false)', async () => {
        await installUpdateInPlace(() => {});
        expect(h.installArgs).toHaveLength(1);
        const opts = h.installArgs[0][0] as { restartAfterInstall?: unknown } | undefined;
        expect(opts?.restartAfterInstall).not.toBe(false);
    });
});
