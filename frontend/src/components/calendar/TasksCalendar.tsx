/**
 * Púca's pinned "Calendar" tab in the Tasks view: the SAME Calendar component
 * Notes renders, over every personal list and checklist channel the Tasks bar
 * shows. Content inside .chat-main (DESIGN_PHILOSOPHY §1, option 1), so no
 * panel-system work. Channel checklists stay live through the socket's
 * ChecklistUpdate, like their tabs.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Calendar, type CalView } from './Calendar';
import { CalendarAddSheet, type AddSheetResult } from './CalendarAddSheet';
import { effectiveWeekStart, setCalendarPrefs, useCalendarPrefs } from './calendarPrefs';
import { useCoarseCalendar } from './calendarGate';
import { ScheduleEditor } from '../schedule/ScheduleEditor';
import {
    type Task, type TaskList, canCompleteTasks, canEditTask, createListTask, createTask, listListTasks, listTasks, patchTaskTiming,
} from '../../api/tasks';
import { type CalendarEntry, type CalendarSource } from '../../api/taskCalendar';
import { newItemTiming, planMove, planSkip } from '../../api/calendarActions';
import { parseSchedule, snoozePatch, snoozeUntil } from '../../api/taskSchedule';
import { planToggle } from '../../api/taskCompletion';
import { pokeTaskReminders } from '../../api/taskReminders';
import { useTaskFeature } from '../../api/taskFeatures';
import { buildIcs, type IcsItem } from '../../api/ics';
import { currentIcsUid } from '../../api/icsUid';
import { deliverIcs } from '../../api/icsDelivery';
import { wsClient, type ServerMessage } from '../../api/websocket';
import { toastRefusal } from '../../api/refusalToast';
import { pushMessageToast } from '../messageToastBus';
import { localDayKey } from '../../utils/calendarMath';

export interface TasksCalendarChannel {
    id: number;
    label: string;
    serverName?: string;
    myPerms?: number;
}

const key = (kind: 'list' | 'channel', id: number) => ['tasks-calendar', kind, id] as const;

// Shared 30-second clock (TaskTree's pattern).
function useHalfMinute(): number {
    const [now, setNow] = useState(() => Math.floor(Date.now() / 30_000) * 30_000);
    useEffect(() => {
        const id = window.setInterval(() => setNow(Math.floor(Date.now() / 30_000) * 30_000), 30_000);
        return () => window.clearInterval(id);
    }, []);
    return now;
}

export function TasksCalendar({ lists, channels, currentUserId, onOpen }: {
    lists: TaskList[];
    channels: TasksCalendarChannel[];
    currentUserId?: number;
    onOpen: (kind: 'list' | 'channel', id: number) => void;
}) {
    const qc = useQueryClient();
    const prefs = useCalendarPrefs();
    const coarse = useCoarseCalendar();
    const now = useHalfMinute();
    const scheduleOn = useTaskFeature('schedule') === true;
    const snoozeOn = useTaskFeature('snooze') === true;
    const [view, setView] = useState<CalView>('month');
    const [date, setDate] = useState(() => localDayKey(Date.now()));
    const [adding, setAdding] = useState<{ dayKey: string; time?: string } | null>(null);
    const [editing, setEditing] = useState<{ kind: 'list' | 'channel'; scope: number; taskId: number } | null>(null);

    const listQ = useQueries({ queries: lists.map(l => ({ queryKey: key('list', l.id), queryFn: () => listListTasks(l.id), staleTime: 30_000 })) });
    const chanQ = useQueries({ queries: channels.map(c => ({ queryKey: key('channel', c.id), queryFn: () => listTasks(c.id), staleTime: 30_000 })) });

    // Live: another member changed a checklist → refetch it.
    useEffect(() => {
        const handler = (msg: ServerMessage) => {
            const cid = (msg.payload as { channel_id?: number } | undefined)?.channel_id;
            if (typeof cid === 'number') void qc.invalidateQueries({ queryKey: key('channel', cid) });
        };
        wsClient.on('ChecklistUpdate', handler);
        return () => wsClient.off('ChecklistUpdate', handler);
    }, [qc]);

    const listData = listQ.map(q => q.data);
    const chanData = chanQ.map(q => q.data);
    const sources: CalendarSource[] = useMemo(() => [
        ...lists.flatMap((l, i) => ((listData[i] as Task[] | undefined) ?? []).map(t => ({ task: t, noteKey: `list:${l.id}`, noteTitle: l.title, canEdit: true }))),
        ...channels.flatMap((c, i) => ((chanData[i] as Task[] | undefined) ?? []).map(t => ({
            task: t, noteKey: `channel:${c.id}`, noteTitle: `#${c.label}`, serverName: c.serverName, canEdit: canEditTask(t, currentUserId, c.myPerms),
            canComplete: canCompleteTasks(c.myPerms),
        }))),
        // The query result arrays are new every render; their data is what matters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    ], [lists, channels, currentUserId, ...listData, ...chanData]);

    const scopeOf = (e: CalendarEntry): { kind: 'list' | 'channel'; id: number } => {
        const [kind, id] = e.source.noteKey.split(':');
        return { kind: kind as 'list' | 'channel', id: Number(id) };
    };
    const refetch = (e: { kind: 'list' | 'channel'; id: number }) => qc.invalidateQueries({ queryKey: key(e.kind, e.id) });
    const run = async (e: CalendarEntry, fn: () => Promise<void>) => {
        try {
            await fn();
            pokeTaskReminders();
        } catch (err) {
            console.error('[tasks-calendar]', err);
            // Every refusal says why (a 403 used to vanish silently here).
            toastRefusal(err);
        }
        await refetch(scopeOf(e));
    };

    const onMove = (e: CalendarEntry, dayKey: string) => {
        const plan = planMove(e, dayKey, Date.now());
        if (!plan) return;
        void run(e, () => patchTaskTiming(e.source.task, plan.kind === 'due' ? { due_at: plan.dueAt } : { schedule: plan.schedule, due_at: plan.dueAt }));
        if (plan.adjusted) pushMessageToast({ title: 'That time does not exist on the new day (the clocks go forward) — it moved to just after the change' });
    };
    const onSkip = (e: CalendarEntry) => {
        const plan = planSkip(e, Date.now());
        if (plan) void run(e, () => patchTaskTiming(e.source.task, { schedule: plan.schedule, due_at: plan.dueAt }));
    };
    const onToggleDone = (e: CalendarEntry) => {
        const s = scopeOf(e);
        const all = (s.kind === 'list' ? listData[lists.findIndex(l => l.id === s.id)] : chanData[channels.findIndex(c => c.id === s.id)]) as Task[] | undefined;
        const plan = planToggle(all ?? [e.source.task], e.source.task, !e.source.task.is_completed, { canEdit: e.source.canEdit });
        void run(e, plan.send);
    };
    const onSnooze = (e: CalendarEntry, preset: 'tomorrow' | '10m' | '1h') => {
        const t = e.source.task;
        // Moves the plaintext due_at too when this user may edit its time
        // (taskSchedule.snoozePatch): the server sees the next reminder.
        const patch = snoozePatch(t, snoozeUntil(preset, Date.now()), e.source.canEdit);
        if (patch) void run(e, () => patchTaskTiming(t, patch));
    };

    const targets = [
        ...lists.map(l => ({ key: `list:${l.id}`, title: l.title })),
        ...channels.map(c => ({ key: `channel:${c.id}`, title: `#${c.label}`, serverName: c.serverName })),
    ];
    const submitAdd = async (r: AddSheetResult): Promise<boolean> => {
        const timing = newItemTiming({ dayKey: r.dayKey, time: r.time, allDay: r.allDay, kind: r.kind }, scheduleOn, Date.now());
        try {
            if (!r.target) return false;
            const [kind, id] = r.target.split(':');
            if (kind === 'list') await createListTask(Number(id), r.title, undefined, timing);
            else await createTask(Number(id), r.title, undefined, timing);
            setCalendarPrefs({ lastNote: r.target });
            pokeTaskReminders();
            await qc.invalidateQueries({ queryKey: key(kind as 'list' | 'channel', Number(id)) });
            return true;
        } catch (err) {
            console.error('[tasks-calendar] add failed:', err);
            pushMessageToast({ title: 'Couldn’t add it — check your connection' });
            return false;
        }
    };

    const exportIcs = async () => {
        if (!window.confirm('The .ics file is NOT encrypted: titles, times and places are in it as plain text. Export?')) return;
        let uidFor: (id: number) => string;
        try { uidFor = currentIcsUid(); } catch (err) { pushMessageToast({ title: err instanceof Error ? err.message : String(err) }); return; }
        const items: IcsItem[] = [];
        for (const s of sources) {
            const t = s.task;
            if (t.is_completed && !prefs.showCompleted) continue;
            const p = parseSchedule(t.schedule);
            if (p.state === 'ok') items.push({ uid: p.schedule.uid, summary: t.description, schedule: p.schedule });
            else if (p.state === 'none' && t.due_at && prefs.showPlain) items.push({ uid: uidFor(t.id), summary: t.description, at: Date.parse(t.due_at) });
        }
        if (items.length === 0) { pushMessageToast({ title: 'Nothing dated to export' }); return; }
        try {
            const r = await deliverIcs(`puca-tasks-${localDayKey(Date.now())}.ics`, buildIcs(items, { nowMs: Date.now(), calName: 'Púca tasks' }));
            if (r.how !== 'cancelled') pushMessageToast({ title: `Exported ${items.length} item${items.length === 1 ? '' : 's'}${r.where ? ` — ${r.where}` : ''}` });
        } catch (err) {
            pushMessageToast({ title: err instanceof Error ? err.message : 'Export failed' });
        }
    };

    const editingTask = editing
        ? ((editing.kind === 'list' ? listData[lists.findIndex(l => l.id === editing.scope)] : chanData[channels.findIndex(c => c.id === editing.scope)]) as Task[] | undefined)?.find(t => t.id === editing.taskId) ?? null
        : null;

    return (
        <div className="tasks-calendar">
            <Calendar
                sources={sources}
                view={view}
                date={date}
                onNavigate={(v, d) => { setView(v); setDate(d); }}
                showCompleted={prefs.showCompleted}
                showPlain={prefs.showPlain}
                onToggleCompleted={() => setCalendarPrefs({ showCompleted: !prefs.showCompleted })}
                onTogglePlain={() => setCalendarPrefs({ showPlain: !prefs.showPlain })}
                weekStart={effectiveWeekStart(prefs)}
                now={now}
                coarse={coarse}
                onOpen={e => { const s = scopeOf(e); onOpen(s.kind, s.id); }}
                onMove={onMove}
                onAdd={(dayKey, time) => setAdding({ dayKey, time })}
                onToggleDone={onToggleDone}
                onSnooze={snoozeOn ? onSnooze : undefined}
                onSkip={scheduleOn ? onSkip : undefined}
                onEditSchedule={scheduleOn ? (e => { const s = scopeOf(e); setEditing({ kind: s.kind, scope: s.id, taskId: e.source.task.id }); }) : undefined}
                headerActions={[{ id: 'export', label: 'Export .ics…', onClick: () => { void exportIcs(); } }]}
                shortcutsEnabled={false}
            />
            {adding && (
                <CalendarAddSheet
                    dayKey={adding.dayKey}
                    time={adding.time}
                    targets={targets}
                    defaultTarget={prefs.lastNote}
                    scheduleSupported={scheduleOn}
                    onSubmit={submitAdd}
                    onClose={() => setAdding(null)}
                    allowNew={false}
                />
            )}
            {editing && editingTask && (
                <ScheduleEditor
                    task={editingTask}
                    onClose={() => setEditing(null)}
                    onSave={(schedule, dueAt) => {
                        const t = editingTask;
                        setEditing(null);
                        void (async () => {
                            try { await patchTaskTiming(t, { schedule, due_at: dueAt }); pokeTaskReminders(); } catch (err) {
                                toastRefusal(err);
                            }
                            await qc.invalidateQueries({ queryKey: key(editing.kind, editing.scope) });
                        })();
                    }}
                />
            )}
        </div>
    );
}
