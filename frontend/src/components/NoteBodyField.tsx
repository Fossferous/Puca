/**
 * A note's text (a personal list's sealed `body` — api/listContent.ts), as
 * an auto-growing field that saves itself: a short pause after typing, on
 * blur, and when it unmounts (closing the note). Shared by Púca Notes'
 * editor and Púca's Tasks view.
 *
 * A save has three ends. It reached the server; or it was KEPT ON THIS
 * DEVICE and will be sent when the connection is back (Púca Notes' offline
 * queue — notes/model/notesOutbox.ts), which the field says rather than
 * claiming "Saved"; or it was refused, which keeps the typed text in the
 * field and offers a retry while the cached note reverts (the data layer's
 * rollback), so what the grid shows is always what the server holds.
 * Púca's Tasks view has no queue and simply never returns `queued`. Text that does not decrypt renders as a
 * locked line and cannot be edited — a marker must never be sealed back over
 * the ciphertext it stands in for.
 *
 * Given `listId`, it registers how to finish its save (api/listContent.ts,
 * `flushBodySave`), so moving the note to the trash waits for the last words
 * typed instead of racing them — also after the field has unmounted.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isUndecryptable } from '../api/decryptMarkers';
import { BODY_SAVE_DELAY_MS, MAX_BODY_BYTES, bodyBytes, registerBodyFlush } from '../api/listContent';
import { LockIcon } from './Icons';
import './NoteImages.css';

interface NoteBodyFieldProps {
    /** The OPENED body (null = none). */
    value: string | null | undefined;
    /** `queued` = kept on this device; `failed` = refused, keep the text. */
    onSave: (text: string) => Promise<SaveResult>;
    readOnly?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
    /** The list this is the text of: a trash of it waits for this field's
     *  pending save (see the header). */
    listId?: number;
}

/** What a caller's save did. A plain boolean is still accepted so callers
 *  with no offline queue (components/ListContentBlock.tsx) stay as they are. */
export type SaveResult = boolean | 'saved' | 'queued' | 'failed';

type SaveState = 'idle' | 'saving' | 'saved' | 'queued' | 'failed' | 'too-long';

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
    if (seen !== current) {
        setSeen(current);
        if (!isDirty) setDraft(current);
    }

    const latest = useRef({ draft, current, onSave });
    useEffect(() => { latest.current = { draft, current, onSave }; });
    // The save on its way to the server, if any (the cached value already
    // shows it, so "nothing to save" is not "nothing in flight").
    const inFlight = useRef<Promise<SaveResult> | null>(null);

    const flush = useCallback(async () => {
        if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
        const { draft: text, current: saved, onSave: save } = latest.current;
        if (!dirty.current || text === saved) { markDirty(false); return; }
        if (bodyBytes(text) > MAX_BODY_BYTES) { setState('too-long'); return; }
        setState('saving');
        const request = save(text);
        inFlight.current = request;
        const result = await request;
        if (inFlight.current === request) inFlight.current = null;
        const outcome = result === true ? 'saved' : result === false ? 'failed' : result;
        if (outcome === 'failed') {
            setState('failed');
            return;
        }
        // Only clean if nothing was typed while the request was out.
        if (latest.current.draft === text) markDirty(false);
        setState(outcome);
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
                    markDirty(true);
                    setDraft(e.target.value);
                    setState('idle');
                    if (timer.current !== null) window.clearTimeout(timer.current);
                    timer.current = window.setTimeout(() => { void flush(); }, BODY_SAVE_DELAY_MS);
                }}
                onBlur={() => { void flush(); }}
            />
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
            {state === 'queued' && <div className="nb-status queued" role="status">Kept on this device — it will sync.</div>}
        </div>
    );
}
