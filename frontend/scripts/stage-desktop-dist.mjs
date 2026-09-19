#!/usr/bin/env node
/**
 * Stage the desktop installer's web assets: frontend/dist → frontend/dist-desktop,
 * WITHOUT Púca Notes (dist/notes/).
 *
 * The desktop shell only ever loads index.html, and nothing in it links to
 * /notes/ (TasksView's "Open in Púca Notes" is web-only), so an installer that
 * embedded dist/notes/ carried a second, unreachable HTML document for
 * nothing. It cannot be stripped from dist/ itself: dist/ is also the webapp
 * tarball, where Notes IS served and dual-ship.sh checks its entry chunk. So
 * the installer gets its own copy — tauri.conf.json's frontendDist is
 * ../dist-desktop — and dist/ is never touched.
 *
 * Runs after the frontend build: from tauri.conf.json's beforeBuildCommand for
 * the full installer, and at the end of scripts/build-lite.mjs for Lite (whose
 * beforeBuildCommand must stay "" — check-lite-identity.mjs). The copy is wiped
 * first, so a Lite build can never inherit a stale Full dist-desktop.
 *
 *   node scripts/stage-desktop-dist.mjs
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, '..');

/**
 * Copy `dist` to `out` minus its top-level notes/ directory, then PROVE it:
 * the desktop entry exists and no notes/ survived. Returns the problems found
 * (empty = staged). Exported for the tests; the CLI below uses the real dirs.
 */
export function stageDesktopDist(dist, out) {
    if (!existsSync(join(dist, 'index.html'))) {
        return [`${dist}${sep}index.html is missing — run the frontend build first (npm run build)`];
    }
    rmSync(out, { recursive: true, force: true });
    const notes = join(dist, 'notes');
    cpSync(dist, out, {
        recursive: true,
        // Only the TOP-LEVEL notes/ is Púca Notes; a nested directory that
        // happens to be called notes (an asset folder) is not.
        filter: (src) => {
            const rel = relative(notes, src);
            return !(rel === '' || (!rel.startsWith('..') && !rel.includes(':')));
        },
    });
    const problems = [];
    if (!existsSync(join(out, 'index.html'))) problems.push(`${out}${sep}index.html is missing after the copy`);
    if (existsSync(join(out, 'notes'))) problems.push(`${out}${sep}notes is STILL present after staging`);
    return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const dist = join(frontend, 'dist');
    const out = join(frontend, 'dist-desktop');
    const problems = stageDesktopDist(dist, out);
    if (problems.length) {
        for (const p of problems) console.error(`[stage-desktop-dist] ${p}`);
        process.exit(1);
    }
    console.log(`[stage-desktop-dist] staged ${out} from ${dist} without notes/ — the installer embeds this copy`);
}
