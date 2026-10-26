/**
 * Where the host updater lives, pinned: mounted with the other always-on
 * remote-control globals (RcGlobals), NOT in the lite stand-in, and named in
 * the lite build's exclusion guard — so a Lite build, which has no remote
 * control and is never a host, can neither mount it nor carry it.
 *
 * The guard is exercised, not grepped: RC_MODULE_PATTERNS is the list the
 * lite build fails on, and a path it does not match would ship. vite.shared.ts
 * is build-time code (it imports vite and reads files beside itself), so it
 * runs under node itself, as notesNativeMin.test.ts runs it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const FRONTEND = join(SRC, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** Which of these module ids the lite build's guard refuses. */
function refused(ids: string[]): boolean[] {
    const script = "const m = await import('./vite.shared.ts');"
        + ` const ids = ${JSON.stringify(ids)};`
        + ' process.stdout.write(JSON.stringify(ids.map(id => m.RC_MODULE_PATTERNS.some(re => re.test(id)))));';
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { cwd: FRONTEND, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as boolean[];
}

describe('the host updater is a remote-control global', () => {
    it('RcGlobals imports it and renders it', () => {
        const text = read('components/RcGlobals.tsx');
        expect(text).toMatch(/import \{ HostAutoUpdate \} from '\.\/HostAutoUpdate';/);
        expect(text).toContain('<HostAutoUpdate />');
    });

    it('the lite stand-in does not', () => {
        expect(read('components/RcGlobals.lite.tsx')).not.toMatch(/HostAutoUpdate/);
    });

    it('the lite build refuses it, and its decision module, if anything else ever imports them', () => {
        const [component, decision, banner] = refused([
            join(SRC, 'components', 'HostAutoUpdate.tsx'),
            join(SRC, 'api', 'devices', 'hostUpdate.ts'),
            // CONTROL: the guard is not refusing every component.
            join(SRC, 'components', 'UpdateBanner.tsx'),
        ]);
        expect(component).toBe(true);
        expect(decision).toBe(true);
        expect(banner).toBe(false);
    }, 30_000);
});
