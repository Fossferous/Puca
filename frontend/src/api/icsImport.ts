/**
 * Bringing a parsed .ics (ics.ts) in as tasks — PERSONAL notes only. A bulk
 * import into a shared note would broadcast a refetch to every member for
 * every item; a personal list has no one else to tell.
 *
 * Paced under the API limiter (a burst of 100, then about one request per
 * 20 ms per IP): one create every PACE_MS, and a 429 waits (as long as the
 * server's Retry-After says, or a doubling backoff when it says nothing) and
 * retries the SAME request, so a long import slows down instead of failing
 * partway. Cancel stops after the current request; the returned `next`
 * index resumes exactly there. Items whose UID the target already holds are
 * skipped (a re-import updates nothing and duplicates nothing), and the
 * import moves on to a fresh "<title> (2)" note before a list reaches the
 * server's 2000-task cap.
 */
import { ApiError } from './client';
import { type IcsImportItem } from './ics';
import { deriveDueAt, parseSchedule, serializeSchedule } from './taskSchedule';
import { type NewTaskTiming, type Task } from './tasks';

export const PACE_MS = 50;
/** An .ics bigger than this is refused before it is parsed. */
export const MAX_ICS_BYTES = 5 * 1024 * 1024;
/** Leave headroom under the server's MAX_TASKS_PER_CHECKLIST (2000). */
export const MAX_PER_LIST = 1900;
const MAX_RETRIES = 6;
/** Never wait longer than this on one Retry-After (a bogus header must not
 *  park the import for an hour). */
export const MAX_RETRY_WAIT_MS = 60_000;

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
    /** Tasks in each of listIds, parallel to it — what the cap is checked
     *  against, so a resume never trusts a recount (which may or may not
     *  include this import's own rows) and never overruns a list. */
    listCounts: number[];
    /** Item `next` is half-imported: its task exists, its description
     *  subtask does not (the run stopped between the two). A resume adds only
     *  that subtask; it never re-creates the item. */
    pendingDescription?: { parentId: number; listId: number };
    cancelled: boolean;
    /** Why it stopped early, when it did (rate limit that would not clear). */
    stoppedBy?: string;
}

export async function runImport(
    items: IcsImportItem[], target: ImportTarget, io: ImportIO,
    opts: { nowMs: number; signal: { cancelled: boolean }; onProgress?: (s: ImportState) => void; resume?: ImportState },
): Promise<ImportState> {
    const r = opts.resume;
    const state: ImportState = r
        ? {
            ...r, cancelled: false, stoppedBy: undefined, failed: [...r.failed], listIds: [...r.listIds],
            listCounts: [...r.listCounts],
            pendingDescription: r.pendingDescription ? { ...r.pendingDescription } : undefined,
        }
        : {
            next: 0, created: 0, skipped: 0, failed: [],
            listIds: target.listId !== null ? [target.listId] : [],
            listCounts: target.listId !== null ? [target.existingCount] : [],
            cancelled: false,
        };
    const seen = new Set(target.existingUids);

    const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
        let backoff = 2000;
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn();
            } catch (err) {
                if (err instanceof ApiError && err.status === 429 && attempt < MAX_RETRIES) {
                    // The server's own answer first (Retry-After); our backoff
                    // only when it did not say.
                    const asked = err.retryAfterMs;
                    await io.sleep(asked !== undefined ? Math.min(Math.max(asked, PACE_MS), MAX_RETRY_WAIT_MS) : backoff);
                    backoff = Math.min(backoff * 2, 30_000);
                    continue;
                }
                throw err;
            }
        }
    };

    const bump = (listId: number) => {
        const i = state.listIds.lastIndexOf(listId);
        if (i >= 0) state.listCounts[i] = (state.listCounts[i] ?? 0) + 1;
    };

    const currentList = async (need: number): Promise<number> => {
        const last = state.listIds.length - 1;
        if (last < 0 || (state.listCounts[last] ?? 0) + need > MAX_PER_LIST) {
            const n = state.listIds.length;
            const title = n === 0 ? target.title : `${target.title} (${n + 1})`;
            const l = await withRetry(() => io.createList(title));
            state.listIds.push(l.id);
            state.listCounts.push(0);
            await io.sleep(PACE_MS);
        }
        return state.listIds[state.listIds.length - 1];
    };

    const addDescription = async (it: IcsImportItem, pending: { parentId: number; listId: number }) => {
        await withRetry(() => io.createTask(pending.listId, it.description!, pending.parentId));
        bump(pending.listId);
        state.pendingDescription = undefined;
        await io.sleep(PACE_MS);
    };

    // Items already imported in an earlier run are seen too.
    for (let i = 0; i < state.next; i++) seen.add(items[i].uid);

    for (; state.next < items.length; state.next++) {
        if (opts.signal.cancelled) { state.cancelled = true; break; }
        const it = items[state.next];
        try {
            if (state.pendingDescription) {
                // Resume a half-imported item: its task exists (and its UID is
                // in the target by now), so only the subtask is missing.
                seen.add(it.uid);
                await addDescription(it, state.pendingDescription);
                state.created++;
                opts.onProgress?.({ ...state, next: state.next + 1 });
                continue;
            }
            if (seen.has(it.uid)) { state.skipped++; opts.onProgress?.({ ...state }); continue; }
            seen.add(it.uid);
            const need = it.description ? 2 : 1;
            const listId = await currentList(need);
            const schedule = serializeSchedule(it.schedule);
            const created = await withRetry(() => io.createTask(listId, it.summary, undefined, { schedule, dueAt: deriveDueAt(it.schedule, opts.nowMs) }));
            bump(listId);
            await io.sleep(PACE_MS);
            if (it.description) {
                state.pendingDescription = { parentId: created.id, listId };
                await addDescription(it, state.pendingDescription);
            }
            state.created++;
        } catch (err) {
            if (err instanceof ApiError && err.status === 429) {
                // Stop HERE: `next` still names this item, and a half-done one
                // keeps its pendingDescription, so Resume picks up exactly.
                state.stoppedBy = 'The server is busy — try Resume in a minute';
                break;
            }
            if (state.pendingDescription) {
                // The item is in; only its notes subtask failed for good.
                state.pendingDescription = undefined;
                state.created++;
                state.failed.push({ summary: it.summary, reason: `its notes were not added: ${err instanceof Error ? err.message : String(err)}` });
            } else {
                state.failed.push({ summary: it.summary, reason: err instanceof Error ? err.message : String(err) });
            }
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


/**
 * The notes an import may go into, for the dialog's picker. It takes PERSONAL
 * lists and nothing else: that is the personal-only rule, made structural at
 * the one place both calendars build the list, rather than a check each host
 * remembers to make.
 *
 * The UID set is what makes a second import of the same file a no-op — it
 * comes from the schedules already in the note, read on this device.
 */
export function icsImportTargets(
    lists: { id: number; title: string }[], tasksIn: (listId: number) => Task[] | undefined,
): { listId: number; title: string; count: number; uids: ReadonlySet<string> }[] {
    return lists.map(l => {
        const items = tasksIn(l.id) ?? [];
        return {
            listId: l.id,
            title: l.title,
            count: items.length,
            uids: new Set(items.map(t => parseSchedule(t.schedule)).flatMap(p => (p.state === 'ok' ? [p.schedule.uid] : []))),
        };
    });
}
