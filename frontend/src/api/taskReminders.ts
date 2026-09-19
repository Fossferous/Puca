/**
 * Client-side due-time reminders for checklist tasks.
 *
 * There is deliberately no push transport in Púca (see CLAUDE.md
 * "Known-unbuilt"), and task content is E2EE, so a server-side scheduler
 * could neither push nor say anything useful. Instead the RUNNING client
 * fires local notifications — which is exactly what keeps every other
 * notification alive here too: the tray keeps desktop running, and Android's
 * KeepAliveService keeps the webview alive.
 *
 * Mechanics: poll GET /task-reminders (ids + due times only), fire a
 * content-free toast for anything newly overdue, and sleep until the next
 * due time. A fired-marker map in localStorage keys on (task id → due_at) so
 * a task never re-fires for the same deadline across restarts, but DOES fire
 * again if its due time is edited to a new one. Markers for tasks that
 * disappear from the feed (completed, deleted, list gone) are pruned.
 */
import { listTaskReminders, type TaskReminder } from './tasks';
import { notifyTasksDue } from './desktopNotify';
import { parseServerTimestamp } from '../utils/serverTime';

const FIRED_KEY = 'sovereignTaskRemindersFired';
/** Re-fetch cadence: catches due times added/edited on other devices. */
const POLL_MS = 5 * 60_000;
/** setTimeout clamps to a signed 32-bit ms value; longer waits rely on the
 *  poll cycle re-arming a fresh (shorter) timer as the deadline nears. */
const MAX_TIMEOUT_MS = 0x7fffffff;

export interface ReminderPlan {
    /** Reminders newly past due (not yet fired for this exact due_at). */
    toFire: TaskReminder[];
    /** Epoch ms of the next FUTURE due time, or null when none. */
    nextDueAt: number | null;
    /** Replacement fired-marker map: every current reminder that has been
     *  (or is now being) fired, keyed by task id — vanished tasks pruned. */
    prunedFired: Record<string, string>;
}

/** Pure scheduling decision — everything testable lives here. */
export function planReminders(
    reminders: TaskReminder[],
    fired: Record<string, string>,
    now: number,
): ReminderPlan {
    const toFire: TaskReminder[] = [];
    const prunedFired: Record<string, string> = {};
    let nextDueAt: number | null = null;
    for (const r of reminders) {
        const t = parseServerTimestamp(r.due_at);
        if (!Number.isFinite(t)) continue;
        const key = String(r.id);
        if (t <= now) {
            // Fired markers match on the exact due_at: an edited deadline
            // that passes again is a new reminder, not a duplicate.
            if (fired[key] !== r.due_at) toFire.push(r);
            prunedFired[key] = r.due_at;
        } else if (nextDueAt === null || t < nextDueAt) {
            nextDueAt = t;
        }
    }
    return { toFire, nextDueAt, prunedFired };
}

/**
 * One reminder as a native alarm engine sees it — the contract Púca Notes'
 * Android app (NotesNative.syncReminders) and the task-timing work share:
 * `at` is the EFFECTIVE fire time in epoch ms (snooze included once it
 * exists), `mark` changes whenever the item must fire again, and `due` is the
 * server's raw due_at, so a background refresh can tell "unchanged" from
 * "moved on another device". Ids and times only — never content.
 */
export interface ReminderEntry {
    id: number;
    at: number;
    mark: string;
    due?: string;
}

/** The feed as ReminderEntry[]; rows with an unreadable time are dropped. */
export function reminderEntries(reminders: TaskReminder[]): ReminderEntry[] {
    const out: ReminderEntry[] = [];
    for (const r of reminders) {
        const at = parseServerTimestamp(r.due_at);
        if (!Number.isFinite(at)) continue;
        out.push({ id: r.id, at, mark: r.due_at, due: r.due_at });
    }
    return out;
}

/** Options for a caller that fires reminders some other way (Púca Notes'
 *  native alarms). Omitted, the loop behaves exactly as it always has. */
export interface TaskReminderOptions {
    /** false: never post a notification from here (and keep no fired
     *  markers) — something else owns firing. Default true. */
    notify?: boolean;
    /** Every successful fetch, as entries. Errors thrown here are swallowed. */
    onFeed?: (entries: ReminderEntry[]) => void;
}

function loadFired(): Record<string, string> {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(FIRED_KEY) ?? '{}');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        return Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>)
                .filter((e): e is [string, string] => typeof e[1] === 'string'),
        );
    } catch {
        return {};
    }
}

function saveFired(map: Record<string, string>): void {
    try {
        localStorage.setItem(FIRED_KEY, JSON.stringify(map));
    } catch { /* storage full/blocked — worst case a duplicate toast later */ }
}

let running = false;
let pokeFn: (() => void) | null = null;

/** Re-plan immediately — call after editing a due time on THIS device, so a
 *  deadline minutes away doesn't wait out the 5-minute poll to get a timer. */
export function pokeTaskReminders(): void {
    pokeFn?.();
}

/**
 * Start the reminder loop (idempotent). Returns a stop function for the
 * owning effect's cleanup. Failures (old backend without the endpoint,
 * offline) are silent — reminders simply don't fire until it works.
 */
export function startTaskReminders(opts: TaskReminderOptions = {}): () => void {
    if (running) return () => {};
    running = true;
    let stopped = false;
    let dueTimer: number | null = null;

    const tick = async () => {
        if (stopped) return;
        let reminders: TaskReminder[];
        try {
            reminders = await listTaskReminders();
        } catch {
            return; // old backend / offline — the poll will try again
        }
        if (stopped) return;
        if (opts.onFeed) {
            try { opts.onFeed(reminderEntries(reminders)); } catch { /* the loop must outlive a bad consumer */ }
        }
        const notify = opts.notify !== false;
        const plan = planReminders(reminders, notify ? loadFired() : {}, Date.now());
        if (notify) {
            saveFired(plan.prunedFired);
            if (plan.toFire.length > 0) notifyTasksDue(plan.toFire.length);
        }
        if (dueTimer !== null) window.clearTimeout(dueTimer);
        if (plan.nextDueAt !== null) {
            const wait = Math.min(Math.max(plan.nextDueAt - Date.now(), 0) + 500, MAX_TIMEOUT_MS);
            dueTimer = window.setTimeout(() => { void tick(); }, wait);
        }
    };

    void tick();
    const poll = window.setInterval(() => { void tick(); }, POLL_MS);
    pokeFn = () => { void tick(); };
    return () => {
        stopped = true;
        running = false;
        pokeFn = null;
        window.clearInterval(poll);
        if (dueTimer !== null) window.clearTimeout(dueTimer);
    };
}
