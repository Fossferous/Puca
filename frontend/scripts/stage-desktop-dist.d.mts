/** Types for scripts/stage-desktop-dist.mjs (imported by src/tests/notesOtaIdentity.test.ts). */

/** Copy `dist` to `out` minus its top-level notes/; the problems found (empty = staged). */
export function stageDesktopDist(dist: string, out: string): string[];
