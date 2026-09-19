/**
 * Bringing a parsed .ics (ics.ts) in as tasks — PERSONAL notes only. A bulk
 * import into a shared note would broadcast a refetch to every member for
 * every item; a personal list has no one else to tell.
 *
 * Paced under the API limiter (a burst of 100, then about one request per
 * 20 ms per IP): one create every PACE_MS, and a 429 waits (backing off) and
 * retries the SAME item, so a long import slows down instead of failing
 * partway. Cancel stops after the current request; the returned `next`
 * index resumes exactly there. Items whose UID the target already holds are
 * skipped (a re-import updates nothing and duplicates nothing), and the
 * import moves on to a fresh "<title> (2)" note before a list reaches the
 * server's 2000-task cap.
 */
import { ApiError } from './client';
import { type IcsImportItem } from './ics';
import { deriveDueAt, serializeSchedule } from './taskSchedule';
import { type NewTaskTiming } from './tasks';

export const PACE_MS = 50;
/** Leave headroom under the server's MAX_TASKS_PER_CHECKLIST (2000). */
export const MAX_PER_LIST = 1900;
const MAX_RETRIES = 6;

export interface ImportIO {
    createList: (title: string) => Promise<{ id: number }>;
    createTask: (listId: number, text: string, parentId?: number, timing?: NewTaskTiming) => Promise<{ id: number }>;
    sleep: (ms: number) => Promise<void>;
}

export interface ImportTarget {
    /** An existing personal list, or null to make a new one titled `title`. */
    listId: number | null;
    title: string;
    /** Tasks already in the target list (counts toward the cap). */
    existingCount: number;
    /** UIDs already in the target (from its schedules). */
    existingUids: ReadonlySet<string>;
}

export interface ImportState {
    next: number;
    created: number;
    skipped: number;
    failed: { summary: string; reason: string }[];
    /** Every list written to (the first, then any overflow lists). */
    listIds: number[];
    cancelled: boolean;
    /** Why it stopped early, when it did (rate limit that would not clear). */
    stoppedBy?: string;
}

export async function runImport(
    items: IcsImportItem[], target: ImportTarget, io: ImportIO,
    opts: { nowMs: number; signal: { cancelled: boolean }; onProgress?: (s: ImportState) => void; resume?: ImportState },
): Promise<ImportState> {
    const state: ImportState = opts.resume
        ? { ...opts.resume, cancelled: false, stoppedBy: undefined, failed: [...opts.resume.failed], listIds: [...opts.resume.listIds] }
        : { next: 0, created: 0, skipped: 0, failed: [], listIds: target.listId !== null ? [target.listId] : [], cancelled: false };
    const seen = new Set(target.existingUids);
    let listCount = state.listIds.length <= 1 ? target.existingCount + state.created : 0;

    const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
        let wait = 2000;
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn();
            } catch (err) {
                if (err instanceof ApiError && err.status === 429 && attempt < MAX_RETRIES) {
                    await io.sleep(wait);
                    wait = Math.min(wait * 2, 30_000);
                    continue;
                }
                throw err;
            }
        }
    };

    const currentList = async (need: number): Promise<number> => {
        if (state.listIds.length === 0 || listCount + need > MAX_PER_LIST) {
            const n = state.listIds.length;
            const title = n === 0 ? target.title : `${target.title} (${n + 1})`;
            const l = await withRetry(() => io.createList(title));
            state.listIds.push(l.id);
            listCount = 0;
            await io.sleep(PACE_MS);
        }
        return state.listIds[state.listIds.length - 1];
    };

    // Items already imported in an earlier run are seen too.
    for (let i = 0; i < state.next; i++) seen.add(items[i].uid);

    for (; state.next < items.length; state.next++) {
        if (opts.signal.cancelled) { state.cancelled = true; break; }
        const it = items[state.next];
        if (seen.has(it.uid)) { state.skipped++; opts.onProgress?.({ ...state }); continue; }
        seen.add(it.uid);
        const need = it.description ? 2 : 1;
        try {
            const listId = await currentList(need);
            const schedule = serializeSchedule(it.schedule);
            const created = await withRetry(() => io.createTask(listId, it.summary, undefined, { schedule, dueAt: deriveDueAt(it.schedule, opts.nowMs) }));
            listCount++;
            await io.sleep(PACE_MS);
            if (it.description) {
                await withRetry(() => io.createTask(listId, it.description!, created.id));
                listCount++;
                await io.sleep(PACE_MS);
            }
            state.created++;
        } catch (err) {
            if (err instanceof ApiError && err.status === 429) {
                state.stoppedBy = 'The server is busy — try Resume in a minute';
                break;
            }
            state.failed.push({ summary: it.summary, reason: err instanceof Error ? err.message : String(err) });
        }
        opts.onProgress?.({ ...state, next: state.next + 1 });
    }
    return state;
}

/** The dialog's one-line result. */
export function importSummary(s: ImportState, total: number): string {
    const parts = [`${s.created} imported`];
    if (s.skipped) parts.push(`${s.skipped} already there`);
    if (s.failed.length) parts.push(`${s.failed.length} failed`);
    if (s.listIds.length > 1) parts.push(`split across ${s.listIds.length} notes`);
    const left = total - s.next;
    if (s.cancelled && left > 0) parts.push(`${left} not imported (cancelled)`);
    if (s.stoppedBy) parts.push(s.stoppedBy);
    return parts.join(' · ');
}
