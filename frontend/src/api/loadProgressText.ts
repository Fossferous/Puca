/**
 * The words a long wait shows — a clip's Play and Download, an encrypted
 * attachment's placeholder. PURE (tested in loadProgress.test.tsx).
 *
 * What these waits are made of is bytes on the wire (2026-10-04: ~88% of a
 * clip's time to first frame was network, decryption a few tens of ms), so
 * every readout counts bytes, and none of them says "Decrypting".
 */
import type { ClipDownloadProgress, ClipLoadProgress } from './clips/clipPlayback';

const MIB = 1024 * 1024;

/** "3.2 MB" under 10 MB, "24 MB" above — MiB, the unit the clip chips use. */
export function formatLoadedMB(bytes: number): string {
    const mb = Math.max(0, bytes) / MIB;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** "3.2 / 24 MB", or "3.2 MB" when the total is unknown. */
export function bytesOfText(received: number, total: number | null): string {
    if (!total) return formatLoadedMB(received);
    return `${formatLoadedMB(received).replace(/ MB$/, '')} / ${formatLoadedMB(Math.max(total, received))}`;
}

/** What the clip plate says while a Play loads: "Loading 1.4 MB" until the
 *  player knows what it is waiting for (needed null), "Loading 1.4 / 13 MB"
 *  after. */
export function playLoadText(p: ClipLoadProgress | null): string {
    if (!p || p.loaded <= 0) return 'Loading…';
    return `Loading ${bytesOfText(p.loaded, p.needed)}`;
}

/** Whole percent of what a Play waits for that has arrived, or null while
 *  there is no total to be a percent of (an indeterminate bar). */
export function playLoadPercent(p: ClipLoadProgress | null): number | null {
    if (!p || p.needed === null) return null;
    if (p.loaded <= 0) return 0;
    return Math.min(100, Math.floor((100 * p.loaded) / Math.max(1, p.needed, p.loaded)));
}

/** Whole percent of the clip's bytes received, held below 100 until the save
 *  itself is done. */
export function downloadPercent(p: ClipDownloadProgress | null): number {
    if (!p || p.totalBytes <= 0) return 0;
    return Math.max(0, Math.min(99, Math.floor((100 * p.bytesDone) / p.totalBytes)));
}

/** Every byte is in and the save is still going: the phone writing the last
 *  part, or the desktop assembling the file and handing it to its save. */
export function downloadSaving(p: ClipDownloadProgress | null): boolean {
    return !!p && p.totalBytes > 0 && p.bytesDone >= p.totalBytes;
}
