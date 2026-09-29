/**
 * Where the time goes between pressing Share and being live, as ONE line in
 * puca.log per go-live.
 *
 * WHY. The owner reported ~5 s from clicking Share in the picker to going
 * live (2026-09-29). Measured on his PC and ruled out: the process scan
 * (25 ms), Deadlock's WASAPI loopback start (7 ms first, <1 ms after), and
 * everything after the audio starts (the announce, the ack and the SFU
 * publish land inside one second in his log). What is left is the picker's
 * own capture start and the steps around it, which only a timestamp per step
 * can separate. So each step marks itself, and the line says which one ate
 * the seconds.
 *
 * `window-focus` is when this window got focus back after the picker opened,
 * i.e. about when the picker closed: everything before it is the person
 * choosing, everything after it is the app.
 */

type Mark = [name: string, atMs: number];

let run: { start: number; marks: Mark[]; unfocus: (() => void) | null } | null = null;

const now = () => performance.now();

/** The picker is about to open. Starts a fresh run (dropping an unfinished one). */
export function goLiveBegin(): void {
    run?.unfocus?.();
    const r: NonNullable<typeof run> = { start: now(), marks: [], unfocus: null };
    // Every focus is kept; formatGoLive reads the FIRST, the picker closing.
    const onFocus = () => { r.marks.push(['window-focus', now()]); };
    try {
        window.addEventListener('focus', onFocus);
        r.unfocus = () => window.removeEventListener('focus', onFocus);
    } catch { /* non-DOM env */ }
    run = r;
}

/** A step finished. A no-op when no run is open. */
export function goLiveMark(name: string): void {
    run?.marks.push([name, now()]);
}

/**
 * `go-live live: picker 3120ms (window-focus +2890) | window-owner +14 | audio +9 | ack +80 | published +310 | total after picker 413ms`
 * Each step is its own duration (since the previous mark), so the slow one
 * stands out without arithmetic; `window-focus` is shown from the start, since
 * it happens inside the picker step.
 */
export function formatGoLive(outcome: string, start: number, marks: Mark[], end: number): string {
    const focus = marks.find(([n]) => n === 'window-focus');
    const steps = marks.filter(([n]) => n !== 'window-focus');
    const parts: string[] = [];
    let prev = start;
    for (const [name, at] of steps) {
        const d = Math.round(at - prev);
        parts.push(name === 'picker'
            ? `picker ${d}ms${focus ? ` (window-focus +${Math.round(focus[1] - start)})` : ''}`
            : `${name} +${d}`);
        prev = at;
    }
    const picker = steps.find(([n]) => n === 'picker');
    const tail = picker ? ` | total after picker ${Math.round(end - picker[1])}ms` : '';
    const afterFocus = focus ? ` | after window-focus ${Math.round(end - focus[1])}ms` : '';
    return `go-live ${outcome}: ${parts.join(' | ') || '(no steps)'}${tail}${afterFocus}`;
}

/** Close the run and write its line. `outcome`: live, cancelled, failed, refused. */
export function goLiveEnd(outcome: string): void {
    const r = run;
    if (!r) return;
    run = null;
    r.unfocus?.();
    const line = formatGoLive(outcome, r.start, r.marks, now());
    console.info(`[stream-diag] ${line}`);
    void import('./platform').then(async ({ isTauri }) => {
        if (!isTauri()) return;
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('log_stream_diag', { line });
    }).catch(() => { /* best effort */ });
}
