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
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isUndecryptable } from '../api/decryptMarkers';
import { BODY_SAVE_DELAY_MS, MAX_BODY_BYTES, bodyBytes } from '../api/listContent';
import { LockIcon } from './Icons';
import './NoteImages.css';

interface NoteBodyFieldProps {
    /** The OPENED body (null = none). */
    value: string | null | undefined;
    /** Resolves true once saved. */
    onSave: (text: string) => Promise<boolean>;
    readOnly?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'too-long';

export function NoteBodyField({ value, onSave, readOnly = false, placeholder = 'Note', autoFocus = false }: NoteBodyFieldProps) {
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

    const flush = useCallback(async () => {
        if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
        const { draft: text, current: saved, onSave: save } = latest.current;
        if (!dirty.current || text === saved) { markDirty(false); return; }
        if (bodyBytes(text) > MAX_BODY_BYTES) { setState('too-long'); return; }
        setState('saving');
        const ok = await save(text);
        if (ok) {
            // Only clean if nothing was typed while the request was out.
            if (latest.current.draft === text) markDirty(false);
            setState('saved');
        } else {
            setState('failed');
        }
    }, [markDirty]);

    // Closing the note saves what was typed.
    useEffect(() => () => { void flush(); }, [flush]);

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
}
