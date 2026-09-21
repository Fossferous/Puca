/**
 * The onSetSchedule and onSnooze handlers Púca's own task owners (TasksView,
 * ChecklistBody) share: optimistic, one PATCH carrying the sealed field and
 * its derived due_at together, rollback on failure, the server's refusal
 * explained in its own words.
 */
import { useCallback, useEffect, useRef } from 'react';
import { type Task, patchTaskTiming } from '../../api/tasks';
import { snoozePatch } from '../../api/taskSchedule';
import { pokeTaskReminders } from '../../api/taskReminders';
import { ApiError } from '../../api/client';
import { toastRefusal } from '../../api/refusalToast';
import { pushMessageToast } from '../messageToastBus';

export function useScheduleSetter(
    tasks: Task[], setTasks: (fn: (prev: Task[]) => Task[]) => void,
): (task: Task, schedule: string | null, dueAt: string | null) => Promise<void> {
    const tasksRef = useRef(tasks);
    useEffect(() => { tasksRef.current = tasks; }, [tasks]);
    return useCallback(async (task: Task, schedule: string | null, dueAt: string | null) => {
        const before = tasksRef.current.find(t => t.id === task.id);
        setTasks(prev => prev.map(t => (t.id === task.id ? { ...t, schedule, due_at: dueAt } : t)));
        try {
            await patchTaskTiming(task, { schedule, due_at: dueAt });
            pokeTaskReminders();
        } catch (err) {
            console.error('Failed to set the date & repeat:', err);
            if (err instanceof ApiError && err.status === 409) pushMessageToast({ title: err.message });
            if (before) setTasks(prev => prev.map(t => (t.id === task.id ? { ...t, schedule: before.schedule, due_at: before.due_at } : t)));
        }
    }, [setTasks]);
}

/**
 * The onSnooze handler for an item row. The snooze record is sealed on the
 * device, and where this user may edit the item's time the plaintext due_at
 * moves with it (taskSchedule.snoozePatch), so a phone reminding with the app
 * closed goes off at the snoozed time.
 *
 * `canEditTime` is the same question the row asked before offering the
 * control; it is asked again here because the handler is what sends.
 */
export function useSnoozeSetter(
    tasks: Task[],
    setTasks: (fn: (prev: Task[]) => Task[]) => void,
    canEditTime: (task: Task) => boolean,
): (task: Task, until: number | null) => Promise<void> {
    const tasksRef = useRef(tasks);
    useEffect(() => { tasksRef.current = tasks; }, [tasks]);
    return useCallback(async (task: Task, until: number | null) => {
        const patch = snoozePatch(task, until, canEditTime(task));
        // No patch: nothing to push back (no reminder time on the server), or
        // an editor's moved snooze this user may not change.
        if (!patch) return;
        const before = tasksRef.current.find(t => t.id === task.id);
        setTasks(prev => prev.map(t => (t.id === task.id
            ? { ...t, snooze: patch.snooze, ...(patch.due_at !== undefined ? { due_at: patch.due_at } : {}) }
            : t)));
        try {
            await patchTaskTiming(task, patch);
            pokeTaskReminders();
        } catch (err) {
            console.error('Failed to snooze:', err);
            // Every refusal says why, in the server's words.
            toastRefusal(err);
            if (before) setTasks(prev => prev.map(t => (t.id === task.id ? { ...t, snooze: before.snooze, due_at: before.due_at } : t)));
        }
    }, [setTasks, canEditTime]);
}
