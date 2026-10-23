/**
 * How long the diagnostics report may take, worked out from the caps of the
 * steps it is made of, in a module of its own so the send path
 * (supportReport.ts) can read it without loading the RTC managers that
 * diagnosticsReport.ts imports.
 *
 * WHY ONE PLACE. buildDiagnosticsReport runs its sections one after another,
 * each under its own cap, so the whole is the SUM of the caps, not the largest.
 * Send diagnostics once bounded the whole measurement at one section's cap
 * (12 s): an SFU call spends 4 s in its stats window and 4 s more in the mesh
 * window before any encoder question is asked, so on a slow machine the outer
 * timer fired first and discarded a measurement every section had answered in
 * time, in exactly the situation the report exists for. The caps and the
 * budget are derived here from the same constants, and diagnosticsReport.test.ts
 * runs the worst case (every step hanging until its cap) to prove the report
 * ends inside REPORT_BUDGET_MS.
 */
import { QUICK_TIMEOUT_MS } from './withTimeout';

/** Milliseconds of measurement. Rates and delays are meaningless as
 *  point-in-time counters, so the diagnostics take two samples this far apart —
 *  long enough to be stable, short enough that nobody gives up waiting. */
export const WINDOW_MS = 4000;

/** How long any one step may take before the report gives up on it and says
 *  so. The windowed stats sections need WINDOW_MS plus the getStats calls on
 *  either side; nothing else should take more than a moment. */
export const STEP_TIMEOUT_MS = WINDOW_MS + 8000;

/** The WebCodecs questions "video encoding this machine can offer" asks:
 *  every codec at every size, each under QUICK_TIMEOUT_MS. */
export const ENCODER_CODECS: ReadonlyArray<readonly [label: string, codec: string]> = [
    ['H.264 High', 'avc1.640028'],
    ['H.264 Base', 'avc1.42E01F'],
    ['VP8', 'vp8'],
    ['VP9', 'vp09.00.10.08'],
    ['AV1', 'av01.0.04M.08'],
];
export const ENCODER_SIZES: ReadonlyArray<readonly [width: number, height: number]> = [[1920, 1080], [2560, 1440]];

/** Sections that run under STEP_TIMEOUT_MS: version, SFU stats, mesh stats. */
export const STEP_SECTIONS = 3;

/** Room for the work between the steps (building strings, the shell's answer
 *  to one that is just slow). */
export const REPORT_SLACK_MS = 9000;

/** The longest buildDiagnosticsReport can take when every step runs to its cap. */
export const REPORT_WORST_CASE_MS =
    STEP_SECTIONS * STEP_TIMEOUT_MS + ENCODER_CODECS.length * ENCODER_SIZES.length * QUICK_TIMEOUT_MS;

/** What a caller waiting for the whole report should allow. */
export const REPORT_BUDGET_MS = REPORT_WORST_CASE_MS + REPORT_SLACK_MS;
