/**
 * The onSetSchedule handler Púca's own task owners (TasksView, ChecklistBody)
 * share: optimistic, one PATCH carrying the sealed schedule and its derived
 * due_at together, rollback on failure, the server's 409 explained.
 */
import { useCallback, useEffect, useRef } from 'react';
import { type Task, patchTaskTiming } from '../../api/tasks';
import { pokeTaskReminders } from '../../api/taskReminders';
import { ApiError } from '../../api/client';
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
