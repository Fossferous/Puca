/**
 * Ticking an item — the ONE completion path for every view (Púca's Tasks
 * view, a channel checklist, Púca Notes). Before schedules it was three
 * copies of "applyToggle + PATCH is_completed"; a repeating task makes that
 * wrong, because ticking it must move it to its next occurrence (and reopen
 * its subtasks) rather than end the series. All three views call
 * planToggle and apply what it returns.
 *
 * Every PATCH from here says `recurrence_aware`: this client knows what a
 * schedule is, so the server's guard (task_timing.rs) lets it complete a
 * scheduled item or a parent of one.
 *
 * Taking that decision over is only right on a CURRENT view of the
 * schedules. A tick queued offline, or planned on a cache that missed an
 * update, could complete an item another device has since made repeating,
 * or sweep a child that became one. So a completion or an advance also says
 * when its view is from (`expect_schedules_as_of`, see schedulesStamp), and
 * the server refuses it (409) if a dated row it depended on changed since.
 */
import { type Task, type TaskTimingPatch, applyToggle, collectSubtreeIds, patchTaskTiming } from './tasks';
import { currentOccurrenceKey, parseSchedule, planCompletion, serializeSchedule } from './taskSchedule';
import { ApiError } from './client';
import { pokeTaskReminders } from './taskReminders';

export interface TogglePlan {
    /** The optimistic task list to show at once. */
    next: Task[];
    /** Send it; rejects like any task write (the caller rolls back). */
    send: () => Promise<void>;
    /** Advanced a repeating task (the item stays open). */
    advanced: boolean;
    /** The PATCH `send` makes, for a caller that sends it another way (Púca
     *  Notes queues it while offline — notesOutbox.ts). Absent when the plan
     *  is a refusal: `send` rejects without touching the network then. */
    patch?: TaskTimingPatch;
    /** With a stamp only: the rows whose edits by THIS device would outdate
     *  it — the item, everything under it, everything above it (an untick
     *  below reopens it, a sweep or advance above reaches it). A queue that
     *  already holds an edit of one of these drops the stamp (notesOutbox.ts
     *  enqueue): the server cannot tell that edit from another device's. */
    scope?: number[];
}

/** A server stamp as a string that sorts in time order to the MICROSECOND:
 *  the server renders `YYYY-MM-DDTHH:MM:SS[.ffffff]Z` with trailing zeros
 *  dropped, and Date.parse keeps only milliseconds — two rows stamped within
 *  one millisecond would compare equal and the older could be sent, which
 *  the server would read as "this device missed the newer one". null = not a
 *  stamp this device can vouch for. */
function stampKey(s: string | undefined): string | null {
    const m = s ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(s) : null;
    return m ? `${m[1]}.${(m[2] ?? '').padEnd(6, '0')}` : null;
}

/**
 * How current this device's view of `ids` is: the newest `updated_at` the
 * server sent for any of them, returned VERBATIM (the server compares it to
 * its own clock; a device clock never enters into it). undefined — send no
 * stamp, and the server does not check — when this device cannot vouch for
 * one of them: a row not created on the server yet, a row from a server
 * without stamps, or a row this device changed optimistically since the
 * server last sent it (`localEdit`), whose own write will move its stamp.
 */
export function schedulesStamp(tasks: Task[], ids: Iterable<number>): string | undefined {
    const byId = new Map(tasks.map(t => [t.id, t]));
    let best: { key: string; raw: string } | null = null;
    for (const id of ids) {
        const t = byId.get(id);
        if (!t || t.id < 0 || t.localEdit) return undefined;
        const key = stampKey(t.updated_at);
        if (key === null || t.updated_at === undefined) return undefined;
        if (!best || key > best.key) best = { key, raw: t.updated_at };
    }
    return best?.raw;
}

/** The item, everything under it and everything above it. */
function stampScope(tasks: Task[], id: number): number[] {
    const ids = collectSubtreeIds(tasks, id);
    const byId = new Map(tasks.map(t => [t.id, t]));
    let cur = byId.get(id)?.parent_id ?? null;
    while (cur !== null && !ids.has(cur)) {
        ids.add(cur);
        cur = byId.get(cur)?.parent_id ?? null;
    }
    return [...ids];
}

/** A completion's patch fields for `task`: the stamp over what its sweep
 *  reaches, and the scope that outdates it. Empty when there is no stamp. */
export function completionStamp(tasks: Task[], task: Task): { stamp?: string; scope?: number[] } {
    const stamp = schedulesStamp(tasks, collectSubtreeIds(tasks, task.id));
    return stamp === undefined ? {} : { stamp, scope: stampScope(tasks, task.id) };
}

/** `next` with every row the plan changed marked as this device's edit. */
function markLocal(before: Task[], next: Task[]): Task[] {
    return next.map((t, i) => (t === before[i] ? t : { ...t, localEdit: true }));
}

/** A refusal shaped like the server's 409s, so every caller's existing
 *  "toast the 409" path explains it. */
function refuse(message: string): () => Promise<void> {
    return () => Promise.reject(new ApiError(message, 409));
}

/**
 * Would completing `rootId` end a series underneath it? Completing an item
 * sweeps its whole subtree on the server (task_handlers.rs), and a repeating
 * item that gets swept is not advanced — its series simply ends, and the
 * server cannot tell (the rule is sealed; its guard only stops clients that
 * do not know what a schedule is). So THIS client refuses: an open
 * descendant that still repeats, or whose schedule it cannot read (it may
 * repeat), blocks the tick with a message that says what to do. The item's
 * own schedule is planCompletion's business, not this check's.
 */
export function subtreeCompletionBlock(tasks: Task[], rootId: number): string | null {
    const byId = new Map(tasks.map(t => [t.id, t]));
    for (const id of collectSubtreeIds(tasks, rootId)) {
        if (id === rootId) continue;
        const d = byId.get(id);
        if (!d || d.is_completed || !d.schedule) continue;
        const p = parseSchedule(d.schedule);
        if (p.state === 'readonly') {
            return 'Something under this item has a date this device can’t read (it may repeat), so ticking this here could end it. Tick the items under it one by one.';
        }
        if (p.state === 'ok' && p.schedule.rrule && currentOccurrenceKey(p.schedule) !== null) {
            const name = d.description.length > 60 ? `${d.description.slice(0, 57)}…` : d.description;
            return `“${name}” under this item repeats — ticking this would end its series. Tick it on its own (it moves to its next time), or remove its repeat first.`;
        }
    }
    return null;
}

export function planToggle(
    tasks: Task[], task: Task, completed: boolean,
    opts: { canEdit: boolean; now?: number },
): TogglePlan {
    const now = opts.now ?? Date.now();
    const parsed = parseSchedule(task.schedule);
    if (completed && parsed.state === 'readonly') {
        return {
            next: tasks, advanced: false,
            send: refuse('This item’s schedule can’t be read on this device, so it can’t be ticked here (it may repeat)'),
        };
    }
    const plan = planCompletion(parsed.state === 'ok' ? parsed.schedule : null, completed, now);
    if (completed && plan.kind !== 'advance') {
        // A completion sweeps the subtree: never let it end a series below.
        const block = subtreeCompletionBlock(tasks, task.id);
        if (block) return { next: tasks, advanced: false, send: refuse(block) };
    }
    if (plan.kind !== 'advance') {
        // Only a completion ends anything; an untick needs no stamp.
        const { stamp, scope } = completed ? completionStamp(tasks, task) : {};
        const patch: TaskTimingPatch = { is_completed: completed, ...(stamp ? { expect_schedules_as_of: stamp } : {}) };
        return {
            next: markLocal(tasks, applyToggle(tasks, task, completed)),
            advanced: false,
            patch,
            ...(scope ? { scope } : {}),
            send: async () => {
                await patchTaskTiming(task, patch);
                pokeTaskReminders();
            },
        };
    }
    if (!opts.canEdit) {
        return {
            next: tasks, advanced: false,
            send: refuse('Only its creator or a task manager can tick off a repeating item'),
        };
    }
    const scheduleText = serializeSchedule(plan.schedule, parsed.state === 'ok' ? parsed.raw : {});
    const reopen = collectSubtreeIds(tasks, task.id);
    const next = tasks.map(t => {
        if (t.id === task.id) return { ...t, is_completed: false, due_at: plan.dueAt, schedule: scheduleText, snooze: null, localEdit: true };
        if (reopen.has(t.id)) return { ...t, is_completed: false, localEdit: true };
        return t;
    });
    // The advance rewrites the item's whole sealed rule from THIS device's
    // copy: the due_at swap below cannot see a rule edited elsewhere that
    // left due_at where it was, so the item's own stamp rides along too.
    const stamp = schedulesStamp(tasks, [task.id]);
    const patch: TaskTimingPatch = {
        schedule: scheduleText,
        due_at: plan.dueAt,
        // Against the due_at this device showed: a tick racing an
        // advance from another device loses cleanly (409 → refetch).
        expect_due_at: task.due_at,
        ...(stamp ? { expect_schedules_as_of: stamp } : {}),
        ...(task.snooze ? { snooze: null } : {}),
        reopen_subtree: true,
    };
    return {
        next,
        advanced: true,
        patch,
        ...(stamp ? { scope: stampScope(tasks, task.id) } : {}),
        send: async () => {
            await patchTaskTiming(task, patch);
            pokeTaskReminders();
        },
    };
}
