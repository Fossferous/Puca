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
 */
import { type Task, applyToggle, collectSubtreeIds, patchTaskTiming } from './tasks';
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
        return {
            next: applyToggle(tasks, task, completed),
            advanced: false,
            send: async () => {
                await patchTaskTiming(task, { is_completed: completed });
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
        if (t.id === task.id) return { ...t, is_completed: false, due_at: plan.dueAt, schedule: scheduleText, snooze: null };
        if (reopen.has(t.id)) return { ...t, is_completed: false };
        return t;
    });
    return {
        next,
        advanced: true,
        send: async () => {
            await patchTaskTiming(task, {
                schedule: scheduleText,
                due_at: plan.dueAt,
                // Against the due_at this device showed: a tick racing an
                // advance from another device loses cleanly (409 → refetch).
                expect_due_at: task.due_at,
                ...(task.snooze ? { snooze: null } : {}),
                reopen_subtree: true,
            });
            pokeTaskReminders();
        },
    };
}
