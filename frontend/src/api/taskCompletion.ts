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
import { type StampClock, type Task, type TaskTimingPatch, applyToggle, collectSubtreeIds, ownWriteUnconfirmed, patchTaskTiming } from './tasks';
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
    /** With a stamp only: the clock it was read from, which decides WHICH
     *  of those edits outdate it — on `schedule` only a schedule, a tick or
     *  a new parent does, so a queued text edit leaves the stamp in place. */
    stampClock?: StampClock;
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

/** A stamp this device can send, and the server clock it was read from. */
interface Stamp { raw: string; clock: StampClock }

/**
 * How current this device's view of `ids` is: the newest server stamp for
 * any of them, returned VERBATIM (the server compares it to its own clock; a
 * device clock never enters into it).
 *
 * The clock is migration 071's `schedule_changed_at` when the server sent it
 * on every one of these rows, which only a new row, a schedule, a tick or a
 * new parent moves — exactly what the server compares. Otherwise (a server
 * older than 071) it is `updated_at`, which that server compares instead.
 *
 * undefined — send no stamp, and the server does not check — when this
 * device cannot vouch for one of them: a row not created on the server yet,
 * a row from a server without stamps, or a row this device changed since the
 * server last sent it in a way that moved that clock — optimistically in a
 * plan (`localEdit`: a tick or an advance) or by a write through
 * api/tasks.ts (ownWriteUnconfirmed). On the `schedule` clock only a write of
 * a schedule, a tick or a parent counts there; a text, attachment, due-time
 * or snooze edit does not move it, so the stamp stays and the tick after it
 * is still checked. On `updated_at` every write counts.
 *
 * WHICH rows vouch for how fresh the view is: the ones a READ produced. A
 * row from a create's answer (`fromCreate` — the views append it to what
 * they read and do not re-read) carries the server's stamp from the moment
 * of the create, which is NEWER than the read. Were it the maximum, the stamp
 * would claim a view of every other row as of that moment, and a repeat
 * another device gave one of them between the read and the create would be
 * swept unchecked. So the stamp is the newest READ row's, and a created row
 * can only lower it: the stamp must never exceed what this device knew of
 * ANY row, and of a created row it knows exactly its own stamp, no later.
 * That is `min(newest read, oldest created)` — in practice the newest read
 * (a create comes after the read it is appended to), and for a subtree made
 * entirely on this device, with nothing read to go by, its oldest create
 * (not its newest: another device may have dated the first item while this
 * one was still adding the rest).
 *
 * One exception, the device's own dated creates. The server's check counts
 * every open, dated row newer than the stamp, and it cannot tell this
 * device's create from another device's change: a stamp below an open,
 * dated row made HERE would be refused, as "changed on another device", for
 * the user's own item (an Undo that recreates a dated subtask, then a tick of
 * its parent). So the stamp is raised to the newest such row — which gives
 * back exactly the window it covers and nothing more; everything after it
 * is still checked. Dropping the stamp instead would check nothing at all.
 */
function stampOver(tasks: Task[], ids: Iterable<number>): Stamp | undefined {
    const byId = new Map(tasks.map(t => [t.id, t]));
    const rows: Task[] = [];
    for (const id of ids) {
        const t = byId.get(id);
        if (!t || t.id < 0) return undefined;
        rows.push(t);
    }
    const clock: StampClock = rows.length > 0 && rows.every(t => t.schedule_changed_at !== undefined) ? 'schedule' : 'content';
    type Key = { key: string; raw: string };
    let newestRead: Key | null = null;
    let oldestCreated: Key | null = null;
    let newestDatedCreated: Key | null = null;
    for (const t of rows) {
        if (t.localEdit || ownWriteUnconfirmed(t, clock)) return undefined;
        const raw = clock === 'schedule' ? t.schedule_changed_at : t.updated_at;
        const key = stampKey(raw);
        if (key === null || raw === undefined) return undefined;
        if (!t.fromCreate) {
            if (!newestRead || key > newestRead.key) newestRead = { key, raw };
            continue;
        }
        if (!oldestCreated || key < oldestCreated.key) oldestCreated = { key, raw };
        if (!t.is_completed && t.schedule && (!newestDatedCreated || key > newestDatedCreated.key)) newestDatedCreated = { key, raw };
    }
    let best = newestRead && oldestCreated
        ? (oldestCreated.key < newestRead.key ? oldestCreated : newestRead)
        : newestRead ?? oldestCreated;
    if (best && newestDatedCreated && newestDatedCreated.key > best.key) best = newestDatedCreated;
    return best ? { raw: best.raw, clock } : undefined;
}

/** The stamp over `ids` (stampOver), as it is sent. */
export function schedulesStamp(tasks: Task[], ids: Iterable<number>): string | undefined {
    return stampOver(tasks, ids)?.raw;
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

/** Did this device write a row in `scope`, in a way that moves `clock`, that
 *  the server has not sent back since? The server's own side effects reach
 *  past the written row — a completion sweeps down, an untick reopens every
 *  ancestor — so a write anywhere above or below the item can have moved a
 *  stamp under it. */
function ownWriteInScope(tasks: Task[], scope: number[], clock: StampClock): boolean {
    const byId = new Map(tasks.map(t => [t.id, t]));
    return scope.some(id => {
        const t = byId.get(id);
        return t !== undefined && ownWriteUnconfirmed(t, clock);
    });
}

/** A completion's patch fields for `task`: the stamp over what its sweep
 *  reaches, the scope that outdates it and the clock that says which edits
 *  of that scope do. Empty when there is no stamp. */
export function completionStamp(tasks: Task[], task: Task): { stamp?: string; scope?: number[]; stampClock?: StampClock } {
    const s = stampOver(tasks, collectSubtreeIds(tasks, task.id));
    if (s === undefined) return {};
    const scope = stampScope(tasks, task.id);
    return ownWriteInScope(tasks, scope, s.clock) ? {} : { stamp: s.raw, scope, stampClock: s.clock };
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
        const { stamp, scope, stampClock } = completed ? completionStamp(tasks, task) : {};
        const patch: TaskTimingPatch = { is_completed: completed, ...(stamp ? { expect_schedules_as_of: stamp } : {}) };
        return {
            next: markLocal(tasks, applyToggle(tasks, task, completed)),
            advanced: false,
            patch,
            ...(scope ? { scope, stampClock } : {}),
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
    const ownScope = stampScope(tasks, task.id);
    const own = stampOver(tasks, [task.id]);
    const stamp = own && !ownWriteInScope(tasks, ownScope, own.clock) ? own.raw : undefined;
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
        ...(stamp && own ? { scope: ownScope, stampClock: own.clock } : {}),
        send: async () => {
            await patchTaskTiming(task, patch);
            pokeTaskReminders();
        },
    };
}
