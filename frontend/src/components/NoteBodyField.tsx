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
 * While this field is mounted it OWNS the note's text: anything else that
 * wants to add to it (a voice note's transcript) goes through the
 * `appendText` handle below rather than writing to the note behind it.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { isUndecryptable } from '../api/decryptMarkers';
import { BODY_SAVE_DELAY_MS, MAX_BODY_BYTES, bodyBytes, registerBodyFlush } from '../api/listContent';
import { appendTranscript } from '../notes/model/audioNote';
import { LockIcon } from './Icons';
import './NoteImages.css';

/** What `appendText` did. `too-long` = it would not fit and NOTHING was
 *  changed; the user's own words are never clipped to make room. */
export type BodyAppendResult = 'ok' | 'too-long' | 'failed';

export interface NoteBodyHandle {
    /**
     * Add `text` below what is in the field RIGHT NOW — the unsaved draft
     * included — and save it.
     *
     * Writing to the note behind this field instead would be silently undone:
     * a draft the user is still typing wins over an external body change (see
     * `seen` below), and this field's own autosave then writes that draft
     * over whatever landed. That is how a voice note's transcript went
     * missing when the user typed while the phone was transcribing.
     */
    appendText: (text: string) => Promise<BodyAppendResult>;
}

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

export const NoteBodyField = forwardRef<NoteBodyHandle, NoteBodyFieldProps>(function NoteBodyField(
    { value, onSave, readOnly = false, placeholder = 'Note', autoFocus = false, listId }: NoteBodyFieldProps,
    handle,
) {
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
    const inFlight = useRef<Promise<boolean> | null>(null);

    /** True once what is in the field is on the server (or was already). */
    const flush = useCallback(async (): Promise<boolean> => {
        if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
        const { draft: text, current: saved, onSave: save } = latest.current;
        if (!dirty.current || text === saved) { markDirty(false); return true; }
        if (bodyBytes(text) > MAX_BODY_BYTES) { setState('too-long'); return false; }
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
        return ok;
    }, [markDirty]);

    useImperativeHandle(handle, (): NoteBodyHandle => ({
        appendText: async (text: string) => {
            const next = appendTranscript(latest.current.draft, text, MAX_BODY_BYTES, bodyBytes);
            if (next === null) return text.trim() === '' ? 'ok' : 'too-long';
            // `latest` is refreshed by an effect AFTER the next render, and
            // flush() reads it: without this line the save that follows would
            // go out with the pre-append draft.
            latest.current = { ...latest.current, draft: next };
            markDirty(true);
            setDraft(next);
            setState('idle');
            return await flush() ? 'ok' : 'failed';
        },
    }), [flush, markDirty]);

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
        </div>
    );
});
