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
import { applyAdvances, openReminderFeed, planAdvances, planEntries, toReminderEntries } from './reminderFeed';

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

/** Pure scheduling decision over plain rows (no timing opened) — the same
 *  rule the loop runs, via the shared entries in reminderFeed.ts, so there is
 *  one implementation. Kept for callers that hold bare feed rows. */
export function planReminders(
    reminders: TaskReminder[],
    fired: Record<string, string>,
    now: number,
): ReminderPlan {
    const plan = planEntries(toReminderEntries(reminders), fired, now);
    const byId = new Map(reminders.map(r => [r.id, r]));
    return {
        toFire: plan.toFire.map(e => byId.get(e.id)).filter((r): r is TaskReminder => r !== undefined),
        nextDueAt: plan.nextAt,
        prunedFired: plan.prunedFired,
    };
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
export function startTaskReminders(): () => void {
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
        // Snoozes and schedules ride the feed sealed (reminderFeed.ts): the
        // plan runs over the shared {id, at, mark} entries, and a fired
        // event's due_at moves on to its next alert once the grace is over.
        const opened = await openReminderFeed(reminders);
        if (stopped) return;
        const now = Date.now();
        const plan = planEntries(toReminderEntries(opened, now), loadFired(), now);
        saveFired(plan.prunedFired);
        if (plan.toFire.length > 0) notifyTasksDue(plan.toFire.length);
        const { advances, nextCheckAt } = planAdvances(opened, now);
        if (advances.length > 0) void applyAdvances(advances);
        if (dueTimer !== null) window.clearTimeout(dueTimer);
        const nextAt = [plan.nextAt, nextCheckAt].filter((t): t is number => t !== null);
        if (nextAt.length > 0) {
            const wait = Math.min(Math.max(Math.min(...nextAt) - Date.now(), 0) + 500, MAX_TIMEOUT_MS);
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
