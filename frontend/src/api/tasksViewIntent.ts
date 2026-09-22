/**
 * Which tab the Tasks view should open on when something else opens it — a
 * due-item notification asks for Reminders.
 *
 * A one-slot handover rather than an event, because the view is usually not
 * mounted yet when the request is made (opening Tasks is what mounts it), and
 * an event dispatched before a listener exists is simply lost. TasksView PEEKS
 * at this for its initial tab and spends it once it is mounted; its own
 * 'sovereign:open-reminders' listener covers the case where it was already on
 * screen.
 *
 * Peek and consume are separate on purpose. One mount can render more than
 * once — StrictMode deliberately double-invokes the render, and with it every
 * useState initializer, in development — so the read that decides the initial
 * tab must not be the read that spends the slot, or the second render would
 * find it empty and open the board instead.
 *
 * Nothing here carries item text: a target name only (the notification body is
 * content-free too — docs/NOTES.md).
 */
export type TasksViewTab = 'reminders';

let pending: TasksViewTab | null = null;
/** The due ids that came with the request, for the row to flash. Ids only —
 *  never item text, which is E2EE and is decrypted in the view. */
let pendingIds: number[] = [];

export function requestTasksTab(tab: TasksViewTab, ids: number[] = []): void {
    pending = tab;
    pendingIds = ids;
}

/** The ONE item a due notification named, or null for none/several — the
 *  same rule Púca Notes applies (notes/native/useNativeReminders). Exported
 *  so both the event path and the cold-open path decide it identically. */
export function soleDueId(ids: unknown): number | null {
    const one = Array.isArray(ids) && ids.length === 1 ? Number(ids[0]) : NaN;
    return Number.isFinite(one) && one > 0 ? one : null;
}

/** The ids asked for, WITHOUT spending them — safe to call while rendering. */
export function peekTasksIds(): number[] {
    return pendingIds;
}

/** What was asked for, WITHOUT spending it — safe to call while rendering. */
export function peekTasksTab(): TasksViewTab | null {
    return pending;
}

export function consumeTasksTab(): TasksViewTab | null {
    const t = pending;
    pending = null;
    pendingIds = [];
    return t;
}
