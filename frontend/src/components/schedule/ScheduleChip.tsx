/**
 * The row chip for an item with a schedule, and the snooze chip — both in
 * the VIEWER's zone. Rendered by TaskTree in place of the plain "Due" chip:
 * for a scheduled item due_at is the next REMINDER (an event's alert fires
 * before it starts), so showing it as "due" would be wrong by the alert.
 */
import { type Task } from '../../api/tasks';
import { activeSnooze, currentOccurrenceKey, occurrenceOf, parseSchedule } from '../../api/taskSchedule';
import { describeSchedule, formatDayShort, formatTime } from '../../api/scheduleFormat';
import { localDayKey } from '../../utils/calendarMath';
import { CalendarIcon, EyeOffIcon, LockIcon, MapPinIcon, RepeatIcon, SnoozeIcon } from '../Icons';

/** A NOTE's own reminder has no completion, so the chip takes only what it
 *  reads (migration 068; components/schedule/NoteReminderControl.tsx). */
export function ScheduleChip({ task, now }: { task: Pick<Task, 'schedule' | 'is_completed'>; now: number }) {
    const parsed = parseSchedule(task.schedule);
    if (parsed.state === 'none') return null;
    if (parsed.state === 'readonly') {
        return (
            <span className="tt-due tt-sched locked" title={parsed.reason}>
                <LockIcon /><span className="tt-due-label">Schedule locked</span>
            </span>
        );
    }
    const s = parsed.schedule;
    const d = describeSchedule(s, now);
    // A to-do whose current occurrence has passed is overdue, like a due chip.
    let overdue = false;
    if (s.kind === 'task' && !task.is_completed) {
        const key = currentOccurrenceKey(s);
        const cur = key ? occurrenceOf(s, key) : null;
        overdue = !!cur && (cur.allDay ? cur.endMs <= now : cur.startMs <= now);
    }
    const title = [
        s.kind === 'event' ? 'Event' : 'To-do',
        d.when,
        d.repeat ? `repeats ${d.repeat}` : null,
        s.location ? `at ${s.location}` : null,
        s.privateTiming ? 'time kept private from the server' : null,
    ].filter(Boolean).join(' · ');
    return (
        <span className={`tt-due tt-sched ${overdue ? 'overdue' : ''} ${d.ended ? 'ended' : ''}`} title={title}>
            {s.rrule ? <RepeatIcon /> : <CalendarIcon />}
            <span className="tt-due-label">
                {d.when}{d.repeat ? ` · ${d.repeat}` : ''}
            </span>
            {s.location && <MapPinIcon aria-label={`at ${s.location}`} />}
            {s.privateTiming && <EyeOffIcon aria-label="time kept private from the server" />}
        </span>
    );
}

export function SnoozeChip({ task, now }: { task: Task; now: number }) {
    const s = activeSnooze(task.due_at, task.snooze);
    if (!s || task.is_completed) return null;
    const until = Date.parse(s.until);
    if (!Number.isFinite(until) || until <= now) return null;
    const label = localDayKey(until) === localDayKey(now) ? formatTime(until) : `${formatDayShort(until)} ${formatTime(until)}`;
    return (
        <span className="tt-due tt-snoozed" title={`Snoozed until ${new Date(until).toLocaleString()}`}>
            <SnoozeIcon /><span className="tt-due-label">{label}</span>
        </span>
    );
}
