/**
 * A note's text (a personal list's sealed `body` — api/listContent.ts), as
 * an auto-growing field that saves itself: a short pause after typing, on
 * blur, and when it unmounts (closing the note). Shared by Púca Notes'
 * editor and Púca's Tasks view.
 *
 * A failed save keeps the typed text in the field and says so, with a retry;
 * the cached note reverts (the data layer's rollback), so what the grid shows
 * is always what the server holds. Text that does not decrypt renders as a
 * locked line and cannot be edited — a marker must never be sealed back over
 * the ciphertext it stands in for.
 *
 * Given `listId`, it registers how to finish its save (api/listContent.ts,
 * `flushBodySave`), so moving the note to the trash waits for the last words
 * typed instead of racing them — also after the field has unmounted.
 *
 * UNDO AND REDO are the field's own (textHistory.ts), not the browser's: a
 * textarea's native stack is wiped by the sync branch below writing the value
 * programmatically, and a phone has no Ctrl key. Ctrl/Cmd+Z and
 * Ctrl/Cmd+Shift+Z (or Ctrl+Y) drive it, and a pair of buttons appears once
 * there is anything to go back to. The history holds DECRYPTED note text and
 * lives in React state only — it is never written to the offline cache and
 * goes when the note closes.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isUndecryptable } from '../api/decryptMarkers';
import { BODY_SAVE_DELAY_MS, MAX_BODY_BYTES, bodyBytes, registerBodyFlush } from '../api/listContent';
import { LockIcon, RedoIcon, UndoIcon } from './Icons';
import {
    type TextHistory, canRedoText, canUndoText, newTextHistory, pushText, redoText, undoText,
} from './textHistory';
import './NoteImages.css';

interface NoteBodyFieldProps {
    /** The OPENED body (null = none). */
    value: string | null | undefined;
    /** Resolves true once saved. */
    onSave: (text: string) => Promise<boolean>;
    readOnly?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
    /** The list this is the text of: a trash of it waits for this field's
     *  pending save (see the header). */
    listId?: number;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'too-long';

export function NoteBodyField({ value, onSave, readOnly = false, placeholder = 'Note', autoFocus = false, listId }: NoteBodyFieldProps) {
    const current = value ?? '';
    const [draft, setDraft] = useState(current);
    const [state, setState] = useState<SaveState>('idle');
    // `dirty` for the async save path, `isDirty` for render; set together.
    const dirty = useRef(false);
    const [isDirty, setIsDirty] = useState(false);
    const markDirty = useCallback((v: boolean) => { dirty.current = v; setIsDirty(v); }, []);
    const timer = useRef<number | null>(null);
    const areaRef = useRef<HTMLTextAreaElement>(null);
    // A body that changed elsewhere (another device, a refetch) replaces the
    // draft — unless the user is mid-edit here, whose text wins until saved.
    const [seen, setSeen] = useState(current);
    const [history, setHistory] = useState<TextHistory>(() => newTextHistory(current));
    if (seen !== current) {
        setSeen(current);
        // A body that landed from elsewhere RESETS the history rather than
        // becoming a step in it: Undo must not be able to put this device's
        // older text back over another device's newer save.
        if (!isDirty) { setDraft(current); setHistory(newTextHistory(current)); }
    }

    const latest = useRef({ draft, current, onSave });
    useEffect(() => { latest.current = { draft, current, onSave }; });
    // The save on its way to the server, if any (the cached value already
    // shows it, so "nothing to save" is not "nothing in flight").
    const inFlight = useRef<Promise<boolean> | null>(null);

    const flush = useCallback(async () => {
        if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
        const { draft: text, current: saved, onSave: save } = latest.current;
        if (!dirty.current || text === saved) { markDirty(false); return; }
        if (bodyBytes(text) > MAX_BODY_BYTES) { setState('too-long'); return; }
        setState('saving');
        const request = save(text);
        inFlight.current = request;
        const ok = await request;
        if (inFlight.current === request) inFlight.current = null;
        if (ok) {
            // Only clean if nothing was typed while the request was out.
            if (latest.current.draft === text) markDirty(false);
            setState('saved');
        } else {
            setState('failed');
        }
    }, [markDirty]);

    // Everything typed, saved: the pending pause cut short, and whatever is
    // already on its way awaited.
    const settle = useCallback(async () => {
        await flush();
        while (inFlight.current) await inFlight.current;
    }, [flush]);

    // Closing the note saves what was typed — and a trash of this list, which
    // is usually what closed it, can still find that save and wait for it.
    useEffect(() => {
        const unregister = listId === undefined ? null : registerBodyFlush(listId, settle);
        return () => {
            const last = settle();
            if (listId === undefined || !unregister) return;
            unregister();
            const drop = registerBodyFlush(listId, () => last);
            void last.then(drop, drop);
        };
    }, [settle, listId]);

    useLayoutEffect(() => {
        const el = areaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [draft]);

    /** Queue the save a pause from now, as typing does. */
    const scheduleSave = useCallback(() => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => { void flush(); }, BODY_SAVE_DELAY_MS);
    }, [flush]);

    /** Step through the history: the text it lands on is a real edit, so it
     *  is dirty and saves itself like any other. */
    const step = useCallback((next: TextHistory) => {
        if (next === history) return;
        setHistory(next);
        setDraft(next.stack[next.index]);
        markDirty(true);
        setState('idle');
        scheduleSave();
        areaRef.current?.focus();
    }, [history, markDirty, scheduleSave]);

    if (isUndecryptable(current)) {
        return <div className="nb-locked"><LockIcon /> This note’s text can’t be read yet: {current}</div>;
    }

    return (
        <div className="note-body-field">
            <textarea
                ref={areaRef}
                className="nb-text"
                value={draft}
                placeholder={placeholder}
                readOnly={readOnly}
                autoFocus={autoFocus}
                aria-label="Note text"
                rows={2}
                onChange={e => {
                    const next = e.target.value;
                    markDirty(true);
                    setDraft(next);
                    setHistory(h => pushText(h, next, Date.now()));
                    setState('idle');
                    scheduleSave();
                }}
                onKeyDown={e => {
                    // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (Ctrl+Y as well). Taken
                    // from the browser on purpose: its own stack is gone the
                    // moment a sync writes the value.
                    if (readOnly || e.altKey || !(e.ctrlKey || e.metaKey)) return;
                    const key = e.key.toLowerCase();
                    if (key === 'z' && !e.shiftKey) { e.preventDefault(); step(undoText(history)); }
                    else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); step(redoText(history)); }
                }}
                onBlur={() => { void flush(); }}
            />
            {!readOnly && (canUndoText(history) || canRedoText(history)) && (
                <div className="nb-actions">
                    <button
                        type="button"
                        className="nb-histbtn"
                        aria-label="Undo"
                        title="Undo (Ctrl+Z)"
                        disabled={!canUndoText(history)}
                        onClick={() => step(undoText(history))}
                    >
                        <UndoIcon />
                    </button>
                    <button
                        type="button"
                        className="nb-histbtn"
                        aria-label="Redo"
                        title="Redo (Ctrl+Shift+Z)"
                        disabled={!canRedoText(history)}
                        onClick={() => step(redoText(history))}
                    >
                        <RedoIcon />
                    </button>
                </div>
            )}
            {state === 'failed' && (
                <div className="nb-status failed" role="alert">
                    Not saved.{' '}
                    <button type="button" className="nb-retry" onClick={() => { markDirty(true); void flush(); }}>Try again</button>
                </div>
            )}
            {state === 'too-long' && (
                <div className="nb-status failed" role="alert">Too long to save — a note holds about 48,000 characters of text.</div>
            )}
            {state === 'saving' && <div className="nb-status" role="status">Saving…</div>}
        </div>
    );
}
