/**
 * The calendar — Month, Week, Day and Agenda over task entries. DATA-AGNOSTIC:
 * it knows CalendarSource/CalendarEntry (api/taskCalendar.ts) and callbacks,
 * nothing about Notes or Púca, so Notes' /calendar and Púca's pinned Calendar
 * tab render the same component.
 *
 * One gate (calendarGate.ts) decides phone vs desktop in JS and CSS alike:
 * the week time grid exists only off it; on a phone the month shows dots and
 * the selected day's list, and a day is an hour list.
 *
 * Every drag has a tap alternative (the item menu's "Move to date…") and a
 * keyboard one ([ and ] on a focused item move it a day; arrows, Home/End,
 * PageUp/PageDown move around the month grid; Enter opens a day; c adds).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { type CalendarEntry, type CalendarSource, entriesInRange, groupByDay, layoutDay } from '../../api/taskCalendar';
import { type SnoozePreset, activeSnooze } from '../../api/taskSchedule';
import { formatDateKey, formatTime } from '../../api/scheduleFormat';
import {
    type WeekStart, addDaysToKey, localDayKey, monthMatrix, parseWall, viewerZone, weekOf,
} from '../../utils/calendarMath';
import { isEditableTarget } from '../../api/hotkeys';
import { useDropOnTarget } from '../../hooks/useDropOnTarget';
import {
    CalendarIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, EyeOffIcon, MapPinIcon, MoreVerticalIcon, PlusIcon,
    RepeatIcon, SnoozeIcon,
} from '../Icons';
import './Calendar.css';

export type CalView = 'month' | 'week' | 'day' | 'agenda';

export interface CalendarAction {
    id: string;
    label: string;
    onClick: () => void;
}

export interface CalendarProps {
    sources: CalendarSource[];
    view: CalView;
    /** The selected day (viewer zone). */
    date: string;
    onNavigate: (view: CalView, date: string) => void;
    showCompleted: boolean;
    showPlain: boolean;
    onToggleCompleted: () => void;
    onTogglePlain: () => void;
    weekStart: WeekStart;
    now: number;
    coarse: boolean;
    locale?: string;
    onOpen: (entry: CalendarEntry) => void;
    onMove: (entry: CalendarEntry, dayKey: string) => void;
    onAdd: (dayKey: string, time?: string) => void;
    onToggleDone: (entry: CalendarEntry) => void;
    /** Snooze an entry's reminder (only offered when it has a due time). */
    onSnooze?: (entry: CalendarEntry, preset: SnoozePreset) => void;
    /** Skip one occurrence of a series (adds an EXDATE). */
    onSkip?: (entry: CalendarEntry) => void;
    /** Open the date & repeat editor for the item. */
    onEditSchedule?: (entry: CalendarEntry) => void;
    /** Header overflow (export / import …). */
    headerActions?: CalendarAction[];
    /** Extra per-item actions (e.g. "Add to phone calendar"). */
    entryActions?: (entry: CalendarEntry) => CalendarAction[];
    /** Single-key shortcuts (t, j/k, n/p, m/w/d/a, c) while this is true. */
    shortcutsEnabled?: boolean;
    /** A note under the header (e.g. "shared notes refresh every 30 s"). */
    footnote?: ReactNode;
}

const HOUR_PX = 48;

function titleOf(e: CalendarEntry): string {
    return e.source.task.description;
}

function whenLabel(e: CalendarEntry, dayKey: string | null, locale?: string): string {
    if (e.allDay) {
        if (e.dayKeys.length > 1 && dayKey) return `all day (${e.dayKeys.indexOf(dayKey) + 1}/${e.dayKeys.length})`;
        return 'all day';
    }
    const start = formatTime(e.startMs, locale);
    if (e.endMs > e.startMs) return `${start}–${formatTime(e.endMs, locale)}`;
    return start;
}

function Marks({ e }: { e: CalendarEntry }) {
    return (
        <>
            {e.repeats && <RepeatIcon aria-label="repeats" />}
            {e.privateTiming && <EyeOffIcon aria-label="time kept private from the server" />}
            {e.location && <MapPinIcon aria-label={`at ${e.location}`} />}
        </>
    );
}

function monthTitle(date: string, locale?: string): string {
    return formatDateKey(date, locale, { month: 'long', year: 'numeric' });
}

export function Calendar(props: CalendarProps) {
    const {
        sources, view: requestedView, date, onNavigate, showCompleted, showPlain, onToggleCompleted, onTogglePlain,
        weekStart, now, coarse, locale, onOpen, onMove, onAdd, onToggleDone, onSnooze, onSkip, onEditSchedule,
        headerActions = [], entryActions, shortcutsEnabled = false, footnote,
    } = props;
    // The week grid does not exist under the phone gate.
    const view: CalView = coarse && requestedView === 'week' ? 'day' : requestedView;
    const tz = viewerZone();
    const today = localDayKey(now, tz);
    const [menuFor, setMenuFor] = useState<{ entry: CalendarEntry; dayKey: string | null } | null>(null);
    const [agendaDays, setAgendaDays] = useState(30);
    const [focusDay, setFocusDay] = useState(date);
    // The focused day follows navigation (adjust-while-rendering, not an effect).
    const [seenDate, setSeenDate] = useState(date);
    if (seenDate !== date) { setSeenDate(date); setFocusDay(date); }
    const gridRef = useRef<HTMLDivElement>(null);

    // The range this view needs.
    const p = parseWall(date)?.wall ?? parseWall(today)!.wall;
    const matrix = useMemo(() => monthMatrix(p.y, p.m, weekStart), [p.y, p.m, weekStart]);
    const week = useMemo(() => weekOf(date, weekStart), [date, weekStart]);
    const [from, to] = view === 'month' ? [matrix[0][0], addDaysToKey(matrix[5][6], 1)]
        : view === 'week' ? [week[0], addDaysToKey(week[6], 1)]
            : view === 'day' ? [date, addDaysToKey(date, 1)]
                : [date, addDaysToKey(date, agendaDays)];
    const entries = useMemo(
        () => entriesInRange(sources, from, to, { showCompleted, showPlain, tz }),
        [sources, from, to, showCompleted, showPlain, tz],
    );
    const byDay = useMemo(() => groupByDay(entries), [entries]);
    const byId = useMemo(() => new Map(entries.map(e => [e.id, e])), [entries]);

    const { state: drag, onPointerDown } = useDropOnTarget({
        enabled: true,
        canDrag: id => byId.get(id)?.movable ?? false,
        onDrop: (id, target) => {
            const e = byId.get(id);
            const day = target.slice(0, 10);
            if (e && !e.dayKeys.includes(day)) onMove(e, day);
        },
    });

    const step = (dir: 1 | -1) => {
        const pw = parseWall(date)!.wall;
        if (view === 'month') {
            const idx = pw.y * 12 + (pw.m - 1) + dir;
            const y = Math.floor(idx / 12), m = (idx % 12) + 1;
            onNavigate(view, `${y}-${String(m).padStart(2, '0')}-01`);
        } else if (view === 'week') onNavigate(view, addDaysToKey(date, 7 * dir));
        else if (view === 'day') onNavigate(view, addDaysToKey(date, dir));
        else onNavigate(view, addDaysToKey(date, 30 * dir));
    };

    // Shortcuts. Capture phase, so a page-level handler for the same key
    // (Notes' `c` = new note) sees defaultPrevented and stands aside.
    const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
    useEffect(() => {
        keyRef.current = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target) || menuFor) return;
            const go = (v: CalView) => { e.preventDefault(); onNavigate(v, date); };
            switch (e.key) {
                case 't': e.preventDefault(); onNavigate(view, today); break;
                case 'j': case 'n': e.preventDefault(); step(1); break;
                case 'k': case 'p': e.preventDefault(); step(-1); break;
                case 'm': go('month'); break;
                case 'w': if (!coarse) go('week'); break;
                case 'd': go('day'); break;
                case 'a': go('agenda'); break;
                case 'c': e.preventDefault(); onAdd(view === 'month' ? focusDay : date); break;
                default: break;
            }
        };
    });
    useEffect(() => {
        if (!shortcutsEnabled) return;
        const h = (e: KeyboardEvent) => keyRef.current(e);
        window.addEventListener('keydown', h, true);
        return () => window.removeEventListener('keydown', h, true);
    }, [shortcutsEnabled]);

    // Month grid keyboard: roving focus over the day cells.
    const onGridKey = (e: React.KeyboardEvent) => {
        const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        let next: string | null = null;
        if (e.key in moves) next = addDaysToKey(focusDay, moves[e.key]);
        else if (e.key === 'Home') next = weekOf(focusDay, weekStart)[0];
        else if (e.key === 'End') next = weekOf(focusDay, weekStart)[6];
        else if (e.key === 'PageUp' || e.key === 'PageDown') {
            const fw = parseWall(focusDay)!.wall;
            const idx = fw.y * 12 + (fw.m - 1) + (e.key === 'PageDown' ? 1 : -1);
            const y = Math.floor(idx / 12), m = (idx % 12) + 1;
            const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
            next = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(fw.d, dim)).padStart(2, '0')}`;
        } else if (e.key === 'Enter' || e.key === ' ') {
            if ((e.target as HTMLElement).dataset.calDay) { e.preventDefault(); onNavigate('month', focusDay); }
            return;
        } else return;
        e.preventDefault();
        setFocusDay(next);
        const outside = !matrix.flat().includes(next);
        if (outside) onNavigate('month', next);
        requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-cal-day="${next}"]`)?.focus());
    };

    // An entry chip's keys: Enter opens its menu, [ and ] move it a day.
    const onEntryKey = (e: React.KeyboardEvent, entry: CalendarEntry, dayKey: string | null) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setMenuFor({ entry, dayKey }); return; }
        if ((e.key === '[' || e.key === ']') && entry.movable) {
            e.preventDefault();
            e.stopPropagation();
            onMove(entry, addDaysToKey(entry.dayKeys[0], e.key === ']' ? 1 : -1));
        }
    };

    const chip = (e: CalendarEntry, dayKey: string | null, compact: boolean) => (
        <button
            key={`${e.id}@${dayKey ?? ''}`}
            type="button"
            className={`cal-chip kind-${e.kind} ${e.completed ? 'done' : ''} ${e.movable ? 'movable' : ''} ${drag.dragging === e.id ? 'dragging' : ''}`}
            data-drag-id={e.movable ? e.id : undefined}
            data-cal-entry={e.id}
            title={`${titleOf(e)} — ${whenLabel(e, dayKey, locale)} · ${e.source.noteTitle}${e.source.serverName ? ` (${e.source.serverName})` : ''}`}
            onClick={() => setMenuFor({ entry: e, dayKey })}
            onKeyDown={ev => onEntryKey(ev, e, dayKey)}
        >
            {!compact && <span className="cal-chip-time">{e.allDay ? '' : formatTime(e.startMs, locale)}</span>}
            <span className="cal-chip-title">{titleOf(e)}</span>
            {e.allDay && e.dayKeys.length > 1 && dayKey && <span className="cal-chip-span">{e.dayKeys.indexOf(dayKey) + 1}/{e.dayKeys.length}</span>}
            <Marks e={e} />
        </button>
    );

    const dayList = (dayKey: string) => {
        const list = byDay.get(dayKey) ?? [];
        return (
            <section className="cal-daylist" aria-label={`Items on ${formatDateKey(dayKey, locale, { weekday: 'long', month: 'long', day: 'numeric' })}`}>
                <div className="cal-daylist-head">
                    <h3>{dayKey === today ? 'Today · ' : ''}{formatDateKey(dayKey, locale, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
                    <button type="button" className="cal-btn" onClick={() => onAdd(dayKey)}><PlusIcon /> Add</button>
                </div>
                {list.length === 0 ? <p className="cal-empty">Nothing on this day.</p> : (
                    <ul className="cal-rows">
                        {list.map(e => (
                            <li key={e.id} className={`cal-row kind-${e.kind} ${e.completed ? 'done' : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={e.completed}
                                    disabled={e.kind === 'task' && e.repeats && e.completed}
                                    aria-label={`${e.completed ? 'Reopen' : 'Complete'}: ${titleOf(e)}`}
                                    onChange={() => onToggleDone(e)}
                                />
                                <span className="cal-row-when">{whenLabel(e, dayKey, locale)}</span>
                                <button type="button" className="cal-row-title" onClick={() => onOpen(e)} title="Open its note">
                                    {titleOf(e)} <Marks e={e} />
                                </button>
                                <span className="cal-row-note">{e.source.noteTitle}{e.source.serverName ? ` · ${e.source.serverName}` : ''}</span>
                                <button type="button" className="cal-iconbtn" aria-label={`More for ${titleOf(e)}`} title="More" onClick={() => setMenuFor({ entry: e, dayKey })}>
                                    <MoreVerticalIcon />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        );
    };

    const timeGrid = (days: string[]) => {
        const hours = Array.from({ length: 24 }, (_, h) => h);
        return (
            <div className={`cal-timegrid cols-${days.length}`}>
                <div className="cal-tg-head">
                    <div className="cal-tg-gutter" />
                    {days.map(k => (
                        <button key={k} type="button" className={`cal-tg-dayhead ${k === today ? 'today' : ''}`} onClick={() => onNavigate('day', k)}>
                            {formatDateKey(k, locale, { weekday: 'short', day: 'numeric' })}
                        </button>
                    ))}
                </div>
                <div className="cal-tg-allday">
                    <div className="cal-tg-gutter">all day</div>
                    {days.map(k => (
                        <div key={k} className={`cal-tg-allday-cell ${drag.over === k ? 'drop' : ''}`} data-drop-target={k}>
                            {(byDay.get(k) ?? []).filter(e => e.allDay).map(e => chip(e, k, true))}
                        </div>
                    ))}
                </div>
                <div className="cal-tg-body">
                    <div className="cal-tg-gutter">
                        {hours.map(h => <div key={h} className="cal-tg-hour" style={{ height: HOUR_PX }}>{formatTime(Date.UTC(2026, 0, 1, h), locale, 'UTC')}</div>)}
                    </div>
                    {days.map(k => (
                        <div key={k} className="cal-tg-col" style={{ height: HOUR_PX * 24 }}>
                            {hours.map(h => {
                                const slot = `${k}T${String(h).padStart(2, '0')}:00`;
                                return (
                                    <button
                                        key={h}
                                        type="button"
                                        className={`cal-tg-slot ${drag.over === slot ? 'drop' : ''}`}
                                        style={{ top: h * HOUR_PX, height: HOUR_PX }}
                                        data-drop-target={slot}
                                        aria-label={`Add at ${formatTime(Date.UTC(2026, 0, 1, h), locale, 'UTC')} on ${formatDateKey(k, locale)}`}
                                        onClick={() => onAdd(k, `${String(h).padStart(2, '0')}:00`)}
                                    />
                                );
                            })}
                            {layoutDay(byDay.get(k) ?? [], k, tz).map(pl => (
                                <div
                                    key={pl.entry.id}
                                    className="cal-tg-item"
                                    style={{
                                        top: (pl.top / 60) * HOUR_PX,
                                        height: Math.max(18, (pl.height / 60) * HOUR_PX - 2),
                                        left: `calc(${(pl.col / pl.cols) * 100}% + 2px)`,
                                        width: `calc(${100 / pl.cols}% - 4px)`,
                                    }}
                                >
                                    {chip(pl.entry, k, false)}
                                </div>
                            ))}
                            {k === today && (() => {
                                const w = new Date(now);
                                const mins = w.getHours() * 60 + w.getMinutes();
                                return <div className="cal-tg-now" style={{ top: (mins / 60) * HOUR_PX }} aria-hidden="true" />;
                            })()}
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    const header = (
        <div className="cal-head">
            <div className="cal-nav">
                <button type="button" className="cal-iconbtn" aria-label="Previous" title="Previous (k)" onClick={() => step(-1)}><ChevronLeftIcon /></button>
                <button type="button" className="cal-btn" onClick={() => onNavigate(view, today)} title="Today (t)">Today</button>
                <button type="button" className="cal-iconbtn" aria-label="Next" title="Next (j)" onClick={() => step(1)}><ChevronRightIcon /></button>
                <h2 className="cal-title">
                    {view === 'month' ? monthTitle(date, locale)
                        : view === 'week' ? `${formatDateKey(week[0], locale, { month: 'short', day: 'numeric' })} – ${formatDateKey(week[6], locale, { month: 'short', day: 'numeric', year: 'numeric' })}`
                            : view === 'day' ? formatDateKey(date, locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
                                : `From ${formatDateKey(date, locale, { month: 'long', day: 'numeric' })}`}
                </h2>
            </div>
            <div className="cal-views" role="tablist" aria-label="Calendar view">
                {(['month', 'week', 'day', 'agenda'] as CalView[]).map(v => (
                    <button key={v} type="button" role="tab" aria-selected={view === v}
                        className={`cal-viewbtn view-${v} ${view === v ? 'on' : ''}`}
                        onClick={() => onNavigate(v, date)}>
                        {v[0].toUpperCase() + v.slice(1)}
                    </button>
                ))}
            </div>
            <div className="cal-toggles">
                <label><input type="checkbox" checked={showCompleted} onChange={onToggleCompleted} /> Show completed</label>
                <label><input type="checkbox" checked={showPlain} onChange={onTogglePlain} /> Show plain reminders</label>
                {headerActions.map(a => <button key={a.id} type="button" className="cal-btn" onClick={a.onClick}>{a.label}</button>)}
            </div>
            {footnote && <div className="cal-foot">{footnote}</div>}
        </div>
    );

    let body: ReactNode;
    if (view === 'month') {
        const month = p.m;
        body = (
            <>
                <div className="cal-month" role="grid" aria-label={monthTitle(date, locale)} ref={gridRef} onKeyDown={onGridKey}>
                    <div className="cal-month-dow" role="row">
                        {matrix[0].map(k => <div key={k} role="columnheader" className="cal-dow">{formatDateKey(k, locale, { weekday: coarse ? 'narrow' : 'short' })}</div>)}
                    </div>
                    {matrix.map((row, ri) => (
                        <div key={ri} className="cal-month-row" role="row">
                            {row.map(k => {
                                const list = byDay.get(k) ?? [];
                                const kw = parseWall(k)!.wall;
                                const label = `${formatDateKey(k, locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}, ${list.length} item${list.length === 1 ? '' : 's'}`;
                                return (
                                    <div
                                        key={k}
                                        role="gridcell"
                                        aria-selected={k === date}
                                        className={`cal-cell ${kw.m !== month ? 'other' : ''} ${k === today ? 'today' : ''} ${k === date ? 'selected' : ''} ${drag.over === k ? 'drop' : ''}`}
                                        data-drop-target={k}
                                    >
                                        <button
                                            type="button"
                                            className="cal-daynum"
                                            data-cal-day={k}
                                            tabIndex={k === focusDay ? 0 : -1}
                                            aria-label={label}
                                            onFocus={() => setFocusDay(k)}
                                            onClick={() => onNavigate('month', k)}
                                        >
                                            {kw.d}
                                        </button>
                                        <div className="cal-cell-chips">
                                            {list.slice(0, 3).map(e => chip(e, k, false))}
                                            {list.length > 3 && (
                                                <button type="button" className="cal-more" onClick={() => onNavigate('month', k)}>+{list.length - 3} more</button>
                                            )}
                                        </div>
                                        {list.length > 0 && (
                                            <div className="cal-dots" aria-hidden="true">
                                                {list.slice(0, 3).map(e => <span key={e.id} className={`cal-dot kind-${e.kind}`} />)}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
                {dayList(date)}
            </>
        );
    } else if (view === 'week') {
        body = timeGrid(week);
    } else if (view === 'day') {
        body = coarse ? (
            <>
                {dayList(date)}
                {timeGrid([date])}
            </>
        ) : timeGrid([date]);
    } else {
        const days: string[] = [];
        for (let i = 0; i < agendaDays; i++) days.push(addDaysToKey(date, i));
        const withItems = days.filter(k => (byDay.get(k) ?? []).length > 0);
        body = (
            <div className="cal-agenda">
                {withItems.length === 0 && <p className="cal-empty">Nothing in the next {agendaDays} days.</p>}
                {withItems.map(k => <div key={k}>{dayList(k)}</div>)}
                <button type="button" className="cal-btn cal-agenda-more" onClick={() => setAgendaDays(n => n + 30)}>Show 30 more days</button>
            </div>
        );
    }

    return (
        <div className={`cal ${coarse ? 'coarse' : 'fine'} view-${view} ${drag.dragging ? 'dragging' : ''}`} onPointerDown={onPointerDown}>
            {header}
            {body}
            {menuFor && (
                <EntryMenu
                    entry={menuFor.entry}
                    dayKey={menuFor.dayKey}
                    locale={locale}
                    now={now}
                    onClose={() => setMenuFor(null)}
                    onOpen={onOpen}
                    onMove={onMove}
                    onToggleDone={onToggleDone}
                    onSnooze={onSnooze}
                    onSkip={onSkip}
                    onEditSchedule={onEditSchedule}
                    extra={entryActions?.(menuFor.entry) ?? []}
                />
            )}
        </div>
    );
}

function EntryMenu({
    entry, dayKey, locale, now, onClose, onOpen, onMove, onToggleDone, onSnooze, onSkip, onEditSchedule, extra,
}: {
    entry: CalendarEntry; dayKey: string | null; locale?: string; now: number; onClose: () => void;
    onOpen: CalendarProps['onOpen']; onMove: CalendarProps['onMove']; onToggleDone: CalendarProps['onToggleDone'];
    onSnooze?: CalendarProps['onSnooze']; onSkip?: CalendarProps['onSkip']; onEditSchedule?: CalendarProps['onEditSchedule'];
    extra: CalendarAction[];
}) {
    const [moveTo, setMoveTo] = useState(entry.dayKeys[0]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            onClose();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [onClose]);
    const t = entry.source.task;
    const canSnooze = !!onSnooze && !!t.due_at && !entry.completed;
    const snoozed = activeSnooze(t.due_at, t.snooze);
    const act = (fn: () => void) => () => { onClose(); fn(); };
    return createPortal(
        <div className="cal-menu-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="cal-menu" role="dialog" aria-modal="true" aria-label={`${t.description} — actions`}>
                <div className="cal-menu-head">
                    {entry.repeats ? <RepeatIcon /> : <CalendarIcon />}
                    <div className="cal-menu-title">
                        <strong>{t.description}</strong>
                        <span>
                            {formatDateKey(dayKey ?? entry.dayKeys[0], locale, { weekday: 'short', month: 'short', day: 'numeric' })} · {whenLabel(entry, dayKey, locale)}
                            {entry.location ? ` · ${entry.location}` : ''}
                        </span>
                        <span className="cal-menu-note">{entry.source.noteTitle}{entry.source.serverName ? ` · shared in ${entry.source.serverName}` : ''}</span>
                        {snoozed && Date.parse(snoozed.until) > now && <span className="cal-menu-note"><SnoozeIcon /> Snoozed until {new Date(snoozed.until).toLocaleString(locale)}</span>}
                    </div>
                    <button type="button" className="cal-iconbtn" aria-label="Close" title="Close" onClick={onClose}><CloseIcon size={18} /></button>
                </div>
                <div className="cal-menu-body">
                    <button type="button" className="cal-menu-item" onClick={act(() => onOpen(entry))}>Open its note</button>
                    {!(entry.kind === 'task' && entry.repeats && entry.completed) && (
                        <button type="button" className="cal-menu-item" onClick={act(() => onToggleDone(entry))}>
                            <CheckIcon /> {entry.completed ? 'Mark not done' : entry.kind === 'task' && entry.repeats ? 'Done — move to the next time' : 'Mark done'}
                        </button>
                    )}
                    {entry.movable && (
                        <div className="cal-menu-move">
                            <label>
                                <span>Move to date…</span>
                                <input type="date" value={moveTo} onChange={e => setMoveTo(e.target.value)} aria-label="Move to date" />
                            </label>
                            <button type="button" className="cal-btn" disabled={!moveTo || entry.dayKeys.includes(moveTo)}
                                onClick={act(() => onMove(entry, moveTo))}>Move</button>
                        </div>
                    )}
                    {entry.repeats && onSkip && entry.source.canEdit && !entry.completed && (
                        <button type="button" className="cal-menu-item" onClick={act(() => onSkip(entry))}>Skip this time</button>
                    )}
                    {onEditSchedule && entry.source.canEdit && (
                        <button type="button" className="cal-menu-item" onClick={act(() => onEditSchedule(entry))}>
                            {entry.repeats ? 'Edit the series (date & repeat)…' : 'Date & repeat…'}
                        </button>
                    )}
                    {canSnooze && (
                        <div className="cal-menu-snooze" role="group" aria-label="Snooze">
                            <span><SnoozeIcon /> Snooze</span>
                            <button type="button" className="cal-btn" onClick={act(() => onSnooze!(entry, '10m'))}>10 min</button>
                            <button type="button" className="cal-btn" onClick={act(() => onSnooze!(entry, '1h'))}>1 hour</button>
                            <button type="button" className="cal-btn" onClick={act(() => onSnooze!(entry, 'tomorrow'))}>Tomorrow</button>
                        </div>
                    )}
                    {extra.map(a => <button key={a.id} type="button" className="cal-menu-item" onClick={act(a.onClick)}>{a.label}</button>)}
                </div>
            </div>
        </div>,
        document.body,
    );
}
