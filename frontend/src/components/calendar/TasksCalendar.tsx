/**
 * Púca's pinned "Calendar" tab in the Tasks view: the SAME Calendar component
 * Notes renders, over every personal list and checklist channel the Tasks bar
 * shows. Content inside .chat-main (DESIGN_PHILOSOPHY §1, option 1), so no
 * panel-system work. Channel checklists stay live through the socket's
 * ChecklistUpdate, like their tabs.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Calendar, type CalendarAction, type CalView } from './Calendar';
import { IcsImportDialog } from './IcsImportDialog';
import { CalendarAddSheet, type AddSheetResult } from './CalendarAddSheet';
import { effectiveWeekStart, setCalendarPrefs, useCalendarPrefs } from './calendarPrefs';
import { useCoarseCalendar } from './calendarGate';
import { ScheduleEditor } from '../schedule/ScheduleEditor';
import { type TaskList, createListTask, createTask, createTaskList, patchTaskTiming } from '../../api/tasks';
import { type CalendarEntry } from '../../api/taskCalendar';
import { taskScopeKey, type TasksScopeChannel, useTaskSources } from '../taskSources';
import { newItemTiming, planMove, planSkip } from '../../api/calendarActions';
import { parseSchedule, snoozePatch, snoozeUntil } from '../../api/taskSchedule';
import { icsImportTargets, icsPickRefusal } from '../../api/icsImport';
import { planToggle } from '../../api/taskCompletion';
import { pokeTaskReminders } from '../../api/taskReminders';
import { useTaskFeature } from '../../api/taskFeatures';
import { buildIcs, parseIcs, type IcsItem, type IcsParseResult } from '../../api/ics';
import { currentIcsUid } from '../../api/icsUid';
import { deliverIcs } from '../../api/icsDelivery';
import { toastRefusal } from '../../api/refusalToast';
import { pushMessageToast } from '../messageToastBus';
import { heldOpKey } from '../../api/opKey';
import { localDayKey } from '../../utils/calendarMath';

/** The Calendar tab's channels — the shape every dated view takes. */
export type TasksCalendarChannel = TasksScopeChannel;

const key = taskScopeKey;

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
    const [importing, setImporting] = useState<{ name: string; parsed: IcsParseResult } | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    // One create key per intent, held across a retry by hand (api/opKey.ts).
    const addKey = useRef(heldOpKey());

    // The same read the Reminders tab makes, under the same keys.
    const { sources, tasksIn, refetch: refetchScope } = useTaskSources(lists, channels, currentUserId);

    const scopeOf = (e: CalendarEntry): { kind: 'list' | 'channel'; id: number } => {
        const [kind, id] = e.source.noteKey.split(':');
        return { kind: kind as 'list' | 'channel', id: Number(id) };
    };
    const refetch = (e: { kind: 'list' | 'channel'; id: number }) => refetchScope(e.kind, e.id);
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
        const all = tasksIn(s.kind, s.id);
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
            // Held across a retry by hand: the add sheet keeps the typed
            // title when a create fails (api/opKey.ts).
            const opKey = addKey.current.keyFor(`${r.target}\u0000${r.title}`);
            if (kind === 'list') await createListTask(Number(id), r.title, undefined, timing, opKey);
            else await createTask(Number(id), r.title, undefined, timing, opKey);
            addKey.current.landed();
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

    // .ics import. Into a PERSONAL list only — an import into a shared
    // checklist would notify every member for every item — which the target
    // list below enforces by construction: `channels` are never offered.
    const pickImport = () => fileRef.current?.click();
    const onFile = async (f: File | undefined) => {
        if (!f) return;
        const refusal = icsPickRefusal(f.size);
        if (refusal) { pushMessageToast({ title: refusal }); return; }
        setImporting({ name: f.name, parsed: parseIcs(await f.text()) });
    };
    const importTargets = icsImportTargets(lists, id => tasksIn('list', id));

    const editingTask = editing ? tasksIn(editing.kind, editing.scope)?.find(t => t.id === editing.taskId) ?? null : null;

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
                headerActions={[
                    { id: 'export', label: 'Export .ics…', onClick: () => { void exportIcs(); } },
                    ...(scheduleOn ? [{ id: 'import', label: 'Import .ics…', onClick: pickImport }] : []),
                ] as CalendarAction[]}
                shortcutsEnabled={false}
            />
            <input ref={fileRef} type="file" accept=".ics,text/calendar" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; void onFile(f); }} />
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
            {importing && (
                <IcsImportDialog
                    fileName={importing.name}
                    parsed={importing.parsed}
                    targets={importTargets}
                    io={{
                        createList: title => createTaskList(title),
                        createTask: (listId, text, parentId, timing) => createListTask(listId, text, parentId, timing),
                        sleep: ms => new Promise(r => setTimeout(r, ms)),
                    }}
                    onClose={() => setImporting(null)}
                    onImported={() => { for (const l of lists) void refetchScope('list', l.id); }}
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
