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

export function requestTasksTab(tab: TasksViewTab): void {
    pending = tab;
}

/** What was asked for, WITHOUT spending it — safe to call while rendering. */
export function peekTasksTab(): TasksViewTab | null {
    return pending;
}

export function consumeTasksTab(): TasksViewTab | null {
    const t = pending;
    pending = null;
    return t;
}
