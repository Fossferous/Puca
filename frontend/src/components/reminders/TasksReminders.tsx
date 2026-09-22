/**
 * Púca's pinned "Reminders" tab in the Tasks view: the SAME list Púca Notes
 * renders, over every personal list and checklist channel the Tasks bar shows.
 * Content inside .chat-main (DESIGN_PHILOSOPHY §1, option 1), so no
 * panel-system work — the Calendar tab's pattern exactly, and it shares that
 * tab's read (components/taskSources.ts), so switching between the two costs
 * no extra requests.
 *
 * Why not GET /task-reminders: that feed is deliberately content-free — ids
 * and times only (src/task_handlers.rs) — so a view built on it would render
 * rows that say nothing. The loop keeps polling it to FIRE reminders; what is
 * drawn here comes from the ordinary per-list/per-channel reads and is
 * decrypted on this device.
 */
import { useEffect, useState } from 'react';
import { patchTaskTiming } from '../../api/tasks';
import { type DueRow, groupReminderSources } from '../../api/reminderGroups';
import { snoozePatch } from '../../api/taskSchedule';
import { planToggle } from '../../api/taskCompletion';
import { pokeTaskReminders } from '../../api/taskReminders';
import { useTaskFeature } from '../../api/taskFeatures';
import { toastRefusal } from '../../api/refusalToast';
import { type TaskScopeKind, type TasksScopeChannel, useTaskSources } from '../taskSources';
import { type TaskList } from '../../api/tasks';
import { RemindersEmpty, RemindersList } from './RemindersList';

// Shared 30-second clock (TaskTree's pattern, as the calendar uses).
function useHalfMinute(): number {
    const [now, setNow] = useState(() => Math.floor(Date.now() / 30_000) * 30_000);
    useEffect(() => {
        const id = window.setInterval(() => setNow(Math.floor(Date.now() / 30_000) * 30_000), 30_000);
        return () => window.clearInterval(id);
    }, []);
    return now;
}

function scopeOf(row: DueRow): { kind: TaskScopeKind; id: number } {
    const [kind, id] = row.source.noteKey.split(':');
    return { kind: kind as TaskScopeKind, id: Number(id) };
}

export function TasksReminders({ lists, channels, currentUserId, onOpen, flashTaskId = null }: {
    lists: TaskList[];
    channels: TasksScopeChannel[];
    currentUserId?: number;
    onOpen: (kind: TaskScopeKind, id: number) => void;
    /** The one item a due notification named, scrolled to and flashed. */
    flashTaskId?: number | null;
}) {
    const now = useHalfMinute();
    const snoozeOn = useTaskFeature('snooze') === true;
    const { sources, tasksIn, refetch } = useTaskSources(lists, channels, currentUserId);
    const groups = groupReminderSources(sources, now);

    const run = async (row: DueRow, fn: () => Promise<void>) => {
        const s = scopeOf(row);
        try {
            await fn();
            pokeTaskReminders();
        } catch (err) {
            console.error('[tasks-reminders]', err);
            // Every refusal says why (a 403 used to vanish silently here).
            toastRefusal(err);
        }
        await refetch(s.kind, s.id);
    };

    const onToggle = (row: DueRow) => {
        const s = scopeOf(row);
        const task = row.source.task;
        const plan = planToggle(tasksIn(s.kind, s.id) ?? [task], task, true, { canEdit: row.source.canEdit });
        void run(row, plan.send);
    };
    const onSnooze = (row: DueRow, until: number | null) => {
        const task = row.source.task;
        // Moves the plaintext due_at too when this user may edit its time
        // (taskSchedule.snoozePatch): the server sees the next reminder.
        const patch = snoozePatch(task, until, row.source.canEdit);
        if (patch) void run(row, () => patchTaskTiming(task, patch));
    };

    return (
        <div className="tasks-reminders">
            <RemindersList
                groups={groups}
                now={now}
                currentUserId={currentUserId}
                flashTaskId={flashTaskId}
                onOpen={row => { const s = scopeOf(row); onOpen(s.kind, s.id); }}
                onToggle={onToggle}
                onSnooze={snoozeOn ? onSnooze : undefined}
                empty={<RemindersEmpty>Nothing is due. Give any item a date from its clock button and it shows up here.</RemindersEmpty>}
            />
        </div>
    );
}
