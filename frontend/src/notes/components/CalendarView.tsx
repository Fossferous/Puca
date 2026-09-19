/**
 * Notes' /calendar: the shared Calendar component (components/calendar) fed
 * from the notes Notes already holds, with every gesture going through the
 * same NoteActions the grid and the editor use.
 *
 * The view and date ride the hash query (?v=month&d=2026-10-05) — ids and
 * dates only; a title or a place never enters the URL (NotesShell's rule).
 * Shared notes refresh every 30 s while they are on the calendar: other
 * members edit those, and Notes has no socket.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Calendar, type CalView, type CalendarAction } from '../../components/calendar/Calendar';
import { effectiveWeekStart, setCalendarPrefs, useCalendarPrefs } from '../../components/calendar/calendarPrefs';
import { useCoarseCalendar } from '../../components/calendar/calendarGate';
import { ScheduleEditor } from '../../components/schedule/ScheduleEditor';
import { type CalendarEntry, type CalendarSource } from '../../api/taskCalendar';
import { newItemTiming, planMove, planSkip } from '../../api/calendarActions';
import { parseSchedule, snoozeUntil } from '../../api/taskSchedule';
import { buildIcs, parseIcs, type IcsItem, type IcsParseResult } from '../../api/ics';
import { currentIcsUid } from '../../api/icsUid';
import { addToPhoneCalendar, canAddToPhoneCalendar, deliverIcs, phoneCalendarArgs } from '../../api/icsDelivery';
import { canCompleteTasks, canEditTask, createListTask, createTaskList } from '../../api/tasks';
import { currentUserIdFromToken } from '../../api/auth';
import { useTaskFeature } from '../../api/taskFeatures';
import { localDayKey, parseWall } from '../../utils/calendarMath';
import { formatDateKey } from '../../api/scheduleFormat';
import { pushMessageToast } from '../../components/messageToastBus';
import { PlusIcon } from '../../components/Icons';
import { type NoteCard, type NoteRef, parseNoteKey } from '../model/notesModel';
import { type NoteActions, SHARED_NOTE_POLL_MS, notesKeys } from '../model/notesQueries';
import { CalendarAddSheet, type AddSheetResult } from '../../components/calendar/CalendarAddSheet';
import { IcsImportDialog } from './IcsImportDialog';
import { fileStamp } from '../model/noteText';
import '../timing.css';

const VIEWS: CalView[] = ['month', 'week', 'day', 'agenda'];

interface CalendarViewProps {
    cards: NoteCard[];
    actions: NoteActions;
    now: number;
    onOpenNote: (key: string) => void;
    /** No dialog/editor above the calendar: its single-key shortcuts may run. */
    shortcutsEnabled: boolean;
}

export function CalendarView({ cards, actions, now, onOpenNote, shortcutsEnabled }: CalendarViewProps) {
    // The ONE phone/desktop gate both calendar hosts use (calendarGate.ts):
    // the native shell or the coarse-pointer query — not the Notes shell's
    // own media-query-only check, which a native phone could fall through.
    const [params, setParams] = useSearchParams();
    const qc = useQueryClient();
    const prefs = useCalendarPrefs();
    const coarse = useCoarseCalendar();
    const scheduleOn = useTaskFeature('schedule') === true;
    const snoozeOn = useTaskFeature('snooze') === true;
    const today = localDayKey(now);
    const v = params.get('v');
    const view: CalView = VIEWS.includes(v as CalView) ? (v as CalView) : 'month';
    const d = params.get('d');
    const date = d && parseWall(d)?.dateOnly ? d : today;
    const me = currentUserIdFromToken() ?? undefined;

    const [adding, setAdding] = useState<{ dayKey: string; time?: string } | null>(null);
    const [editing, setEditing] = useState<{ note: NoteRef; taskId: number } | null>(null);
    const [importing, setImporting] = useState<{ name: string; parsed: IcsParseResult } | null>(null);
    const [phoneCal, setPhoneCal] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let alive = true;
        void canAddToPhoneCalendar().then(ok => { if (alive) setPhoneCal(ok); });
        return () => { alive = false; };
    }, []);

    const navigate = useCallback((nv: CalView, nd: string) => {
        setParams(p => { p.set('v', nv); p.set('d', nd); return p; }, { replace: true });
    }, [setParams]);

    // Every item of every note (archived too — archiving does not cancel a
    // date, as Reminders already treats it).
    const sources: CalendarSource[] = useMemo(() => cards.flatMap(c => (c.tasks ?? []).map(t => ({
        task: t,
        noteKey: c.key,
        noteTitle: c.title,
        serverName: c.serverName,
        canEdit: c.ref.kind === 'list' || canEditTask(t, me, c.myPerms),
        canComplete: c.ref.kind === 'list' || canCompleteTasks(c.myPerms),
    }))), [cards, me]);

    // Shared notes on the calendar: poll, as an open shared note does.
    const sharedKeys = useMemo(() => cards.filter(c => c.ref.kind === 'channel').map(c => c.ref), [cards]);
    useEffect(() => {
        if (sharedKeys.length === 0) return;
        const id = window.setInterval(() => {
            for (const ref of sharedKeys) void qc.invalidateQueries({ queryKey: notesKeys.tasks(ref) });
        }, SHARED_NOTE_POLL_MS);
        return () => window.clearInterval(id);
    }, [sharedKeys, qc]);

    const noteOf = (e: CalendarEntry): NoteRef | null => parseNoteKey(e.source.noteKey);

    const onMove = (e: CalendarEntry, dayKey: string) => {
        const note = noteOf(e);
        const plan = planMove(e, dayKey, Date.now());
        if (!note || !plan) return;
        if (plan.kind === 'due') void actions.setDue(note, e.source.task, plan.dueAt);
        else void actions.setSchedule(note, e.source.task, plan.schedule, plan.dueAt);
        if (plan.adjusted) pushMessageToast({ title: 'That time does not exist on the new day (the clocks go forward) — it moved to just after the change' });
    };

    const onSkip = (e: CalendarEntry) => {
        const note = noteOf(e);
        const plan = planSkip(e, Date.now());
        if (note && plan) void actions.setSchedule(note, e.source.task, plan.schedule, plan.dueAt);
    };

    const onToggleDone = (e: CalendarEntry) => {
        const note = noteOf(e);
        if (note) void actions.toggleTask(note, e.source.task, !e.source.task.is_completed);
    };

    const onSnooze = (e: CalendarEntry, preset: 'tomorrow' | '10m' | '1h') => {
        const note = noteOf(e);
        if (note) void actions.snoozeTask(note, e.source.task, snoozeUntil(preset, Date.now()));
    };

    // --- Tap-to-add ------------------------------------------------------------------
    const personal = cards.filter(c => c.ref.kind === 'list');
    const addTargets = [...personal, ...cards.filter(c => c.ref.kind === 'channel')].map(c => ({ key: c.key, title: c.title, serverName: c.serverName }));
    const submitAdd = async (r: AddSheetResult): Promise<boolean> => {
        const timing = newItemTiming({ dayKey: r.dayKey, time: r.time, allDay: r.allDay, kind: r.kind }, scheduleOn, Date.now());
        if (r.target === 'new') {
            const ref = await actions.createNote(`Calendar ${fileStamp(Date.now())}`, [r.title], undefined, [timing]);
            if (!ref) { pushMessageToast({ title: 'Couldn’t add it — check your connection' }); return false; }
            setCalendarPrefs({ lastNote: `${ref.kind}:${ref.id}` });
            return true;
        }
        const ref = parseNoteKey(r.target);
        if (!ref) return false;
        const created = await actions.addTask(ref, r.title, undefined, timing);
        if (!created) { pushMessageToast({ title: 'Couldn’t add it — check your connection' }); return false; }
        setCalendarPrefs({ lastNote: r.target });
        return true;
    };

    // --- Export / import ----------------------------------------------------------------
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
        const text = buildIcs(items, { nowMs: Date.now(), calName: 'Púca Notes' });
        try {
            const r = await deliverIcs(`puca-notes-${fileStamp(Date.now())}.ics`, text);
            if (r.how !== 'cancelled') pushMessageToast({ title: `Exported ${items.length} item${items.length === 1 ? '' : 's'}${r.where ? ` — ${r.where}` : ''}` });
        } catch (err) {
            pushMessageToast({ title: err instanceof Error ? err.message : 'Export failed' });
        }
    };

    const pickImport = () => fileRef.current?.click();
    const onFile = async (f: File | undefined) => {
        if (!f) return;
        if (f.size > 5 * 1024 * 1024) { pushMessageToast({ title: 'That file is over 5 MB — too big to import here' }); return; }
        const text = await f.text();
        setImporting({ name: f.name, parsed: parseIcs(text) });
    };
    const importTargets = personal.map(c => ({
        listId: c.ref.id,
        title: c.title,
        count: c.tasks?.length ?? c.total,
        uids: new Set((c.tasks ?? []).map(t => parseSchedule(t.schedule)).flatMap(p => (p.state === 'ok' ? [p.schedule.uid] : []))),
    }));

    const headerActions: CalendarAction[] = [
        { id: 'export', label: 'Export .ics…', onClick: () => { void exportIcs(); } },
        ...(scheduleOn ? [{ id: 'import', label: 'Import .ics…', onClick: pickImport }] : []),
    ];

    const entryActions = (e: CalendarEntry): CalendarAction[] => {
        if (!phoneCal) return [];
        return [{
            id: 'phone-cal',
            label: 'Add to phone calendar',
            onClick: () => {
                if (!prefs.phoneCalendarNoticeSeen) {
                    const ok = window.confirm('Your phone’s calendar app may sync this item’s title and time to its provider (Google, Samsung…). It is a one-way copy: later changes in Púca do not follow. Continue?');
                    if (!ok) return;
                    setCalendarPrefs({ phoneCalendarNoticeSeen: true });
                }
                void addToPhoneCalendar(phoneCalendarArgs({ ...e, title: e.source.task.description }))
                    .catch(err => pushMessageToast({ title: err instanceof Error ? err.message : 'Could not open the phone calendar' }));
            },
        }];
    };

    const editingTask = editing ? cards.find(c => c.ref.kind === editing.note.kind && c.ref.id === editing.note.id)?.tasks?.find(t => t.id === editing.taskId) ?? null : null;
    const sharedNote = sharedKeys.length > 0;

    return (
        <div className="notes-calendar">
            <Calendar
                sources={sources}
                view={view}
                date={date}
                onNavigate={navigate}
                showCompleted={prefs.showCompleted}
                showPlain={prefs.showPlain}
                onToggleCompleted={() => setCalendarPrefs({ showCompleted: !prefs.showCompleted })}
                onTogglePlain={() => setCalendarPrefs({ showPlain: !prefs.showPlain })}
                weekStart={effectiveWeekStart(prefs)}
                now={now}
                coarse={coarse}
                onOpen={e => onOpenNote(e.source.noteKey)}
                onMove={onMove}
                onAdd={(dayKey, time) => setAdding({ dayKey, time })}
                onToggleDone={onToggleDone}
                onSnooze={snoozeOn ? onSnooze : undefined}
                onSkip={scheduleOn ? onSkip : undefined}
                onEditSchedule={scheduleOn ? (e => { const n = noteOf(e); if (n) setEditing({ note: n, taskId: e.source.task.id }); }) : undefined}
                headerActions={headerActions}
                entryActions={entryActions}
                shortcutsEnabled={shortcutsEnabled && !adding && !editing && !importing}
                footnote={sharedNote ? 'Shared notes refresh every 30 seconds here.' : undefined}
            />
            <div className="cal-weekstart">
                <label>
                    Week starts
                    <select value={String(prefs.weekStart)} onChange={e => setCalendarPrefs({ weekStart: e.target.value === 'auto' ? 'auto' : Number(e.target.value) as 0 | 1 | 6 })} aria-label="Week starts on">
                        <option value="auto">Automatic</option>
                        <option value="1">Monday</option>
                        <option value="0">Sunday</option>
                        <option value="6">Saturday</option>
                    </select>
                </label>
            </div>
            <button type="button" className="notes-fab" aria-label={`Add on ${formatDateKey(date, undefined, { month: 'short', day: 'numeric' })}`}
                title="Add to the calendar" onClick={() => setAdding({ dayKey: date })}>
                <PlusIcon />
            </button>
            <input ref={fileRef} type="file" accept=".ics,text/calendar" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; void onFile(f); }} />
            {adding && (
                <CalendarAddSheet
                    dayKey={adding.dayKey}
                    time={adding.time}
                    targets={addTargets}
                    defaultTarget={prefs.lastNote}
                    scheduleSupported={scheduleOn}
                    onSubmit={submitAdd}
                    onClose={() => setAdding(null)}
                />
            )}
            {editing && editingTask && (
                <ScheduleEditor
                    task={editingTask}
                    onClose={() => setEditing(null)}
                    onSave={(schedule, dueAt) => { void actions.setSchedule(editing.note, editingTask, schedule, dueAt); setEditing(null); }}
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
                    onImported={() => { void actions.refreshAll(); }}
                />
            )}
        </div>
    );
}
