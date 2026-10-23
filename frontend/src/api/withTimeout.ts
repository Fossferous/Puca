/** Each WebCodecs question, the clipboard write, and any other step that is
 *  only ever a moment's work. */
export const QUICK_TIMEOUT_MS = 3000;

/** Rejects if `p` has not settled within `ms`. A step that never answers must
 *  cost the report that step, never the whole report: on 2026-09-25 a
 *  clipboard permission prompt nobody could see held `writeText` open, and
 *  the menu said "Measuring for a few seconds…" for good. Lives apart from
 *  diagnosticsReport so the send path can bound its steps without loading the
 *  RTC managers that module reads. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} gave no answer within ${Math.round(ms / 1000)} s`)), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}
