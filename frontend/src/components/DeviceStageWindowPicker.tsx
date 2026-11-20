/**
 * THE WINDOW PICKER on the remote-control stage: choose ONE of the PC's open
 * windows, and the stage shows and drives just that window, sized to it, with
 * Whole screen one press away (the owner's ask, 2026-11-20; windowPick.ts and
 * the agent's window_pick.rs have the mechanism, docs/REMOTE_CONTROL.md *One
 * window* the account).
 *
 * One component for both shapes. On a desktop it is a dialog over the stage,
 * keyboard first: the search field has the focus, typing filters, the arrows
 * move through the list (a combobox over a listbox, so the focus never leaves
 * the field), Enter shows the highlighted window, Escape closes. On a phone it
 * is a sheet with 44 px rows, and the field does not take the focus by itself
 * (it would raise the soft keyboard over the list).
 *
 * SELECTION COMES FROM THE HOST, never from the press, as in the screen
 * picker: a choice is sent, and the picker closes once the host CONFIRMS it
 * (`activeWindow`), or stays open saying why it was refused.
 *
 * The stage forwards no keys while it is open (DeviceStage's key gate).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    chooseWindow, requestWindowList, type DeviceControlSession,
} from '../api/devices/session';
import { matchWindows, windowId, type RemoteWindow } from '../api/devices/windowPick';
import { CheckIcon, CloseIcon, MonitorIcon, PopOutIcon, RefreshIcon, SearchIcon } from './Icons';
import { useBackClose } from '../hooks/useBackClose';
import './DeviceStageWindowPicker.css';

/** Below this many windows the list needs no search on a phone: it fits. */
const PHONE_SEARCH_FROM = 7;

type Pending = { id: string } | { whole: true } | null;

function WindowIcon({ src }: { src: string | undefined }) {
    return (
        <span className="dswp-icon" aria-hidden="true">
            {src ? <img src={src} alt="" width={24} height={24} draggable={false} /> : <PopOutIcon />}
        </span>
    );
}

export function DeviceStageWindowPicker({ session, touch, onClose }: {
    session: DeviceControlSession;
    /** A coarse pointer: the phone sheet. */
    touch: boolean;
    onClose: () => void;
}) {
    useBackClose(onClose);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const [pending, setPending] = useState<Pending>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const pc = session.peerName?.trim() || 'that computer';
    const sid = session.id;

    // A fresh list every time the picker opens: windows come and go.
    useEffect(() => { requestWindowList(sid); }, [sid]);

    useEffect(() => {
        if (touch) dialogRef.current?.focus();
        else inputRef.current?.focus();
    }, [touch]);

    // ESCAPE CLOSES IT WHEREVER THE FOCUS IS (the pinned-keys editor's rule:
    // a press that disables what it landed on drops the focus to the page).
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.type !== 'keydown') return;
            e.preventDefault();
            e.stopPropagation();
            onCloseRef.current();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    const list = session.windowList;
    const windows = useMemo(() => list?.windows ?? [], [list]);
    const shown = useMemo(() => matchWindows(windows, query), [windows, query]);
    const current = session.activeWindow ? windowId(session.activeWindow) : null;
    // The rows, in order: Whole screen first (index 0), then the windows.
    const rowCount = shown.length + 1;
    const activeRow = Math.min(active, rowCount - 1);

    // CLOSE ONCE THE HOST HAS DONE IT. Refused, the host's reason arrives as
    // `windowNotice` and the picker stays open with nothing pending.
    useEffect(() => {
        if (!pending) return;
        if ('whole' in pending ? current === null : current === pending.id) onCloseRef.current();
    }, [pending, current]);
    const notice = session.windowNotice;
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- a refusal ends the wait it answers
        if (notice) setPending(null);
    }, [notice]);

    const pickWhole = () => {
        if (current === null) { onClose(); return; }
        setPending({ whole: true });
        chooseWindow(sid, null);
    };
    const pickWindow = (w: RemoteWindow) => {
        const id = windowId(w);
        if (id === current) { onClose(); return; }
        setPending({ id });
        chooseWindow(sid, { hwnd: w.hwnd, pid: w.pid });
    };
    const pickRow = (row: number) => {
        if (row === 0) pickWhole();
        else if (shown[row - 1]) pickWindow(shown[row - 1]);
    };

    // Keep the highlighted row in view as the arrows move it.
    useEffect(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeRow}"]`);
        el?.scrollIntoView?.({ block: 'nearest' });
    }, [activeRow]);

    const onFieldKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeRow + 1, rowCount - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeRow - 1, 0)); }
        else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setActive(0); }
        else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setActive(rowCount - 1); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (!e.repeat) pickRow(activeRow);
        }
    };

    const busyId = pending && 'id' in pending ? pending.id : null;
    const loading = !!list?.loading;
    const showSearch = !touch || windows.length >= PHONE_SEARCH_FROM || query !== '';
    const rowId = (row: number) => `dswp-row-${row}`;

    const statusLine = (() => {
        if (pending) return 'whole' in pending ? 'Showing the whole screen…' : 'Showing that window…';
        if (list?.error) return list.error;
        if (loading && windows.length === 0) return `Asking ${pc} for its windows…`;
        if (!loading && windows.length === 0) return `No windows are open on ${pc}.`;
        if (shown.length === 0) return `No window matches “${query.trim()}”.`;
        return null;
    })();

    return (
        <div
            className={`device-stage-typetext-backdrop dswp-backdrop${touch ? ' dswp-touch' : ''}`}
            onPointerDown={e => {
                e.stopPropagation();
                if (e.target === e.currentTarget) { e.preventDefault(); onClose(); }
            }}
            onPointerUp={e => e.stopPropagation()}
            onPointerMove={e => e.stopPropagation()}
            onWheel={e => e.stopPropagation()}
        >
            <div
                ref={dialogRef}
                className="device-stage-typetext dswp-picker"
                role="dialog"
                aria-modal="true"
                aria-labelledby="dswp-title"
                data-owns-keys=""
                data-testid="window-picker"
                tabIndex={-1}
            >
                <div className="dswp-head">
                    <strong id="dswp-title">Show one window</strong>
                    <button
                        type="button"
                        className="device-stage-btn dswp-head-btn"
                        aria-label="Refresh the list"
                        title="Refresh the list"
                        disabled={loading}
                        onClick={() => requestWindowList(sid)}
                    >
                        <RefreshIcon />
                    </button>
                    <button type="button" className="device-stage-btn dswp-head-btn" aria-label="Close" onClick={onClose}>
                        <CloseIcon />
                    </button>
                </div>

                {showSearch && (
                    <label className="dswp-search">
                        <SearchIcon />
                        <input
                            ref={inputRef}
                            type="search"
                            role="combobox"
                            aria-label="Find a window"
                            aria-expanded="true"
                            aria-controls="dswp-list"
                            aria-activedescendant={rowId(activeRow)}
                            aria-autocomplete="list"
                            placeholder="Find a window"
                            autoComplete="off"
                            spellCheck={false}
                            value={query}
                            onChange={e => { setQuery(e.target.value); setActive(e.target.value ? 1 : 0); }}
                            onKeyDown={onFieldKey}
                        />
                    </label>
                )}

                <ul
                    ref={listRef}
                    id="dswp-list"
                    className="dswp-list"
                    role="listbox"
                    aria-label={`Windows on ${pc}`}
                    aria-busy={loading || undefined}
                >
                    <li
                        id={rowId(0)}
                        data-row={0}
                        role="option"
                        aria-selected={current === null}
                        className={`dswp-row dswp-whole${activeRow === 0 ? ' active' : ''}`}
                        onPointerEnter={e => { if (e.pointerType === 'mouse') setActive(0); }}
                        onClick={pickWhole}
                    >
                        <span className="dswp-icon" aria-hidden="true"><MonitorIcon /></span>
                        <span className="dswp-text">
                            <span className="dswp-title">Whole screen</span>
                            <span className="dswp-app">Everything on the screen, as before</span>
                        </span>
                        {current === null && <span className="dswp-mark" aria-hidden="true"><CheckIcon /></span>}
                    </li>
                    {shown.map((w, i) => {
                        const row = i + 1;
                        const id = windowId(w);
                        const notes = [w.app];
                        if (w.minimized) notes.push('minimised');
                        return (
                            <li
                                key={id}
                                id={rowId(row)}
                                data-row={row}
                                data-window={id}
                                role="option"
                                aria-selected={current === id}
                                aria-disabled={busyId !== null && busyId !== id ? true : undefined}
                                className={`dswp-row${activeRow === row ? ' active' : ''}${busyId === id ? ' busy' : ''}`}
                                onPointerEnter={e => { if (e.pointerType === 'mouse') setActive(row); }}
                                onClick={() => pickWindow(w)}
                            >
                                <WindowIcon src={w.icon ? list?.icons[w.icon] : undefined} />
                                <span className="dswp-text">
                                    <span className="dswp-title">{w.title}</span>
                                    <span className="dswp-app">{notes.join(' · ')}</span>
                                    {w.elevated && (
                                        <span className="dswp-warn">
                                            Runs as administrator: you can watch it, but Windows will not let your clicks and keys reach it.
                                        </span>
                                    )}
                                </span>
                                {current === id && <span className="dswp-mark" aria-hidden="true"><CheckIcon /></span>}
                            </li>
                        );
                    })}
                </ul>

                {/* Two lines, never one hiding the other: the host's word
                    about the window (a refusal, or why the picture went back
                    to the whole screen), and the list's own state. */}
                {notice && !pending && (
                    <span className="dswp-status dswp-status-error" role="status" data-testid="window-picker-notice">{notice}</span>
                )}
                {statusLine && (
                    <span className={`dswp-status${list?.error && !pending ? ' dswp-status-error' : ''}`} role="status" data-testid="window-picker-status">
                        {statusLine}
                    </span>
                )}
                <span className="device-stage-typetext-help">
                    The picture shows just that window, sized to it, and your clicks go to it. Anything covering it on {pc} is
                    shown too, and a menu that opens outside it is cut off: choose Whole screen to see it.
                </span>
            </div>
        </div>
    );
}
