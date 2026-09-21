/**
 * "Uncheck all" and "Delete checked" — the pure part: which items each one
 * touches, in what order, and what has to be asked about first.
 *
 * There is no bulk route and there must not be one. Both actions are fan-outs
 * of the per-item writes that already exist (a `timing` PATCH per untick, a
 * delete per checked root), so the server sees exactly the requests it
 * already sees when a person ticks and deletes by hand, and nothing new is
 * stored or learned. What IS new is the burst: a run of unticks inside a
 * second is a recognisable "this list was reset", and its size says how many
 * items were done. That is why the fan-out is paced rather than parallel —
 * and docs/NOTES.md says so rather than claiming nothing changed.
 *
 * Three rules the server forces on us, each encoded in one function here:
 *
 *  - Deleting an item takes its whole subtree (task_handlers.rs). So a delete
 *    must name only the TOP of each completed branch; naming the children too
 *    races the cascade and reports failures for rows that are already gone.
 *  - Completing a parent sweeps its subtree, and un-completing one reopens its
 *    ancestors. So unticking goes parents-first, and the Undo re-ticks only
 *    the top of each completed branch.
 *  - A repeating to-do whose series has ENDED sits completed with a
 *    `doneThrough` past its last occurrence. Unticking it reopens a series
 *    with no next time — an undated open item nobody asked for. Nothing in
 *    taskCompletion.ts guards this: its readonly refusal and its
 *    subtreeCompletionBlock are both gated on `completed === true`, so
 *    un-ticking passes them untouched. Hence deadSeriesAmong.
 *
 * Pure: no React, no network. Unit-tested in src/tests/notesItemBulk.test.tsx.
 */
import { type Task, buildTaskTree, type TaskNode } from '../../api/tasks';
import { currentOccurrenceKey, parseSchedule } from '../../api/taskSchedule';

/** How many of these items are ticked. */
export function checkedCount(tasks: Task[]): number {
    return tasks.filter(t => t.is_completed).length;
}

/**
 * The top of each completed branch: a completed item whose parent is not
 * also completed (or has no parent). Deleting exactly these takes every
 * completed item, once, and lets the server's cascade do the rest.
 */
export function checkedRoots(tasks: Task[]): Task[] {
    const byId = new Map(tasks.map(t => [t.id, t]));
    return tasks.filter(t => {
        if (!t.is_completed) return false;
        const parent = t.parent_id === null ? undefined : byId.get(t.parent_id);
        return !parent?.is_completed;
    });
}

/** Every completed item, parents before children: the order unticking has to
 *  use so a child's untick is never undone by a parent's ancestor-reopen. */
export function uncheckOrder(tasks: Task[]): Task[] {
    const out: Task[] = [];
    const walk = (nodes: TaskNode[]) => {
        for (const n of nodes) {
            if (n.task.is_completed) out.push(n.task);
            walk(n.children);
        }
    };
    walk(buildTaskTree(tasks));
    return out;
}

/**
 * Ticked items that are repeating to-dos whose series has already finished.
 * Unticking one reopens a repeat with no next time, which is why it is worth
 * a question rather than a silent write.
 */
export function deadSeriesAmong(tasks: Task[]): Task[] {
    return tasks.filter(t => {
        if (!t.is_completed || !t.schedule) return false;
        const p = parseSchedule(t.schedule);
        if (p.state !== 'ok' || !p.schedule.rrule) return false;
        return currentOccurrenceKey(p.schedule) === null;
    });
}

/** The question "Uncheck all" asks before it runs, or null when there is
 *  nothing to warn about. Shaped like describeLosses (noteContent.ts). */
export function describeUncheckWarning(dead: Task[]): string | null {
    if (dead.length === 0) return null;
    if (dead.length === 1) {
        const d = dead[0].description;
        const name = d.length > 60 ? `${d.slice(0, 57)}…` : d;
        return `“${name}” repeats, and its last time has already passed. Unticking it reopens it with no next time. Untick everything anyway?`;
    }
    return `${dead.length} of these repeat, and their last times have already passed. Unticking them reopens them with no next time. Untick everything anyway?`;
}
