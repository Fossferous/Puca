/**
 * .ics import, in three steps: a PREVIEW (how many events, what cannot be
 * represented and how it will come in — nothing fails silently), the paced
 * import with a progress bar and Cancel, and the result with Resume when it
 * stopped early. Personal notes only (icsImport.ts says why).
 */
import { useMemo, useRef, useState } from 'react';
import { type IcsParseResult } from '../../api/ics';
import { type ImportIO, type ImportState, importSummary, runImport } from '../../api/icsImport';
import './IcsImport.css';
import { WarningIcon } from '../Icons';
import { NotesDialog } from '../NotesDialog';

export interface ImportTargetOption {
    listId: number;
    title: string;
    count: number;
    uids: ReadonlySet<string>;
    /** Its items have been read on this device. A note that has not been read
     *  cannot be imported into: there is nothing to dedupe against and no
     *  count to keep under the cap (icsImport.icsImportTargets). */
    loaded: boolean;
}

export function IcsImportDialog({ fileName, parsed, targets, io, onClose, onImported }: {
    fileName: string;
    parsed: IcsParseResult;
    targets: ImportTargetOption[];
    io: ImportIO;
    onClose: () => void;
    /** After any run (the caller refetches). */
    onImported: () => void;
}) {
    const [target, setTarget] = useState<string>('new');
    const [title, setTitle] = useState((parsed.calName ?? fileName.replace(/\.ics$/i, '')).slice(0, 100) || 'Imported calendar');
    const [running, setRunning] = useState(false);
    const [state, setState] = useState<ImportState | null>(null);
    const signal = useRef({ cancelled: false });
    const total = parsed.items.length;
    const counts = useMemo(() => ({
        events: parsed.items.filter(i => i.kind === 'event').length,
        todos: parsed.items.filter(i => i.kind === 'task').length,
        repeating: parsed.items.filter(i => !!i.schedule.rrule).length,
        withNotes: parsed.items.filter(i => i.notes.length > 0),
    }), [parsed]);

    // The chosen note, when it is an existing one (rather than "A new note…").
    const chosen = targets.find(x => String(x.listId) === target) ?? null;
    const waiting = !!chosen && !chosen.loaded;

    const start = async (resume?: ImportState) => {
        const t = targets.find(x => String(x.listId) === target);
        if (t && !t.loaded) return;
        signal.current = { cancelled: false };
        setRunning(true);
        const result = await runImport(parsed.items, {
            listId: t ? t.listId : (resume?.listIds[0] ?? null),
            title: t ? t.title : title.trim() || 'Imported calendar',
            existingCount: t ? t.count : 0,
            existingUids: t ? t.uids : new Set(),
        }, io, { nowMs: Date.now(), signal: signal.current, onProgress: s => setState(s), resume });
        setState(result);
        setRunning(false);
        onImported();
    };

    const done = state && !running;
    const canResume = done && state.next < total && (state.cancelled || !!state.stoppedBy);
    return (
        <NotesDialog title="Import a calendar (.ics)" onClose={() => { signal.current.cancelled = true; onClose(); }}>
            <div className="ics-import">
                <p><strong>{fileName}</strong>: {total} item{total === 1 ? '' : 's'} — {counts.events} event{counts.events === 1 ? '' : 's'}, {counts.todos} to-do{counts.todos === 1 ? '' : 's'}{counts.repeating ? `, ${counts.repeating} repeating` : ''}.</p>
                {(parsed.notes.length > 0 || counts.withNotes.length > 0) && (
                    <div className="ics-notes" role="note">
                        <p><WarningIcon /> Not everything maps exactly:</p>
                        <ul>
                            {parsed.notes.map((n, i) => <li key={`f${i}`}>{n}</li>)}
                            {counts.withNotes.slice(0, 20).map(it => <li key={it.uid}>“{it.summary.slice(0, 60)}”: {it.notes.join('; ')}</li>)}
                            {counts.withNotes.length > 20 && <li>…and {counts.withNotes.length - 20} more</li>}
                        </ul>
                    </div>
                )}
                {!state && total > 0 && (
                    <>
                        <label className="ics-row">
                            <span>Into</span>
                            <select value={target} onChange={e => setTarget(e.target.value)} aria-label="Import into">
                                <option value="new">A new note…</option>
                                {targets.map(t => (
                                    <option key={t.listId} value={String(t.listId)} disabled={!t.loaded}>
                                        {t.loaded ? t.title : `${t.title} — still loading…`}
                                    </option>
                                ))}
                            </select>
                        </label>
                        {target === 'new' && (
                            <label className="ics-row">
                                <span>Named</span>
                                <input type="text" value={title} maxLength={100} onChange={e => setTitle(e.target.value)} aria-label="New note name" />
                            </label>
                        )}
                        {waiting && <p className="notes-labels-hint">Still reading what that note already holds — a moment, or the import would bring everything in twice.</p>}
                        <p className="notes-labels-hint">Only into your own notes — an import into a shared checklist would notify every member for every item. Items already in the note (same event UID) are skipped, and a very large calendar is split across notes.</p>
                        <div className="ics-actions">
                            <button type="button" className="notes-textbtn" onClick={onClose}>Cancel</button>
                            <button type="button" className="notes-textbtn primary" disabled={waiting} onClick={() => void start()}>Import {total}</button>
                        </div>
                    </>
                )}
                {state && (
                    <div className="ics-progress">
                        <progress max={total} value={state.next} aria-label="Import progress" />
                        <p aria-live="polite">{running ? `Importing… ${state.next} of ${total}` : importSummary(state, total)}</p>
                        {state.failed.length > 0 && done && (
                            <ul className="ics-failed">{state.failed.slice(0, 10).map((f, i) => <li key={i}>“{f.summary.slice(0, 60)}”: {f.reason}</li>)}</ul>
                        )}
                        <div className="ics-actions">
                            {running && <button type="button" className="notes-textbtn" onClick={() => { signal.current.cancelled = true; }}>Cancel</button>}
                            {canResume && <button type="button" className="notes-textbtn primary" onClick={() => void start(state)}>Resume</button>}
                            {done && <button type="button" className="notes-textbtn" onClick={onClose}>Close</button>}
                        </div>
                    </div>
                )}
            </div>
        </NotesDialog>
    );
}
