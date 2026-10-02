/**
 * Stream popout diagnostics that reach puca.log on the desktop.
 *
 * Whether the desktop shell's WebView2 implements Document Picture-in-Picture
 * (one always-on-top window holding several streams) is documented nowhere,
 * and the code was built to let the field answer it with a `[doc-pip]` line.
 * That line only ever went to the WebView console, which a release build does
 * not keep — the log file gets nothing but invoke('log_stream_diag') (lib.rs),
 * so the answer never arrived. Each popout outcome now goes both ways:
 * console everywhere, puca.log through the shell where there is one.
 *
 * One line per startup and per attempt — never per frame.
 */
import { isTauri } from './platform';

export function logPipDiag(line: string): void {
    console.info(`[stream-diag] ${line}`);
    if (!isTauri()) return;
    void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('log_stream_diag', { line }))
        .catch(() => { /* best effort — a missing line is not worth an error */ });
}

/** `Name: message` for a DOMException/Error, the value itself otherwise —
 *  the NAME is the useful part (NotAllowedError = no user activation left,
 *  NotSupportedError = disabled by policy or unimplemented). */
export function describePipError(err: unknown): string {
    if (err && typeof err === 'object' && 'name' in err) {
        const e = err as { name?: unknown; message?: unknown };
        const msg = typeof e.message === 'string' && e.message ? `: ${e.message}` : '';
        return `${String(e.name)}${msg}`.slice(0, 300);
    }
    return String(err).slice(0, 300);
}
