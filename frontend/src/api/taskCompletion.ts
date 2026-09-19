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
import { parseSchedule, planCompletion, serializeSchedule } from './taskSchedule';
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
