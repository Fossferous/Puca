/**
 * Which tab the Tasks view should open on when something else opens it — a
 * due-item notification asks for Reminders.
 *
 * A one-slot handover rather than an event, because the view is usually not
 * mounted yet when the request is made (opening Tasks is what mounts it), and
 * an event dispatched before a listener exists is simply lost. TasksView reads
 * this as its initial tab and clears it; its own 'sovereign:open-reminders'
 * listener covers the case where it was already on screen.
 *
 * Nothing here carries item text: a target name only (the notification body is
 * content-free too — docs/NOTES.md).
 */
export type TasksViewTab = 'reminders';

let pending: TasksViewTab | null = null;

export function requestTasksTab(tab: TasksViewTab): void {
    pending = tab;
}

export function consumeTasksTab(): TasksViewTab | null {
    const t = pending;
    pending = null;
    return t;
}
