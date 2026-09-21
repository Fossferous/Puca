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
 * TWO DEVICES, ONE NOTE. While nothing is being typed here, text that changed
 * elsewhere simply replaces the field — that is a refresh, not a clash. But a
 * save made ON TOP of a change from somewhere else is REFUSED by the server
 * (migration 069; api/listConflict.ts), and then this field keeps the words
 * that were typed, shows the other copy, and asks which to keep. Nothing is
 * thrown away before the user chooses. Before this, whichever save landed
 * last silently won and the other text was gone with no record of it.
 *
 * THE BASE IS TAKEN WHEN TYPING STARTS, not when the save fires. A live event
 * for this note arrives while the user is mid-sentence, and the cached
 * revision moves to the other device's — so a save that read the revision at
 * send time would name THEIRS and win, destroying their words with the guard
 * looking straight at it. `contentRev` is captured the moment the field goes
 * dirty and held until it is clean again; the refusal then hands back the
 * revision to retry against.
 *
 * Given `listId`, it registers how to finish its save (api/listContent.ts,
 * `flushBodySave`), so moving the note to the trash waits for the last words
 * typed instead of racing them — also after the field has unmounted.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isUndecryptable } from '../api/decryptMarkers';
import { BODY_SAVE_DELAY_MS, MAX_BODY_BYTES, bodyBytes, registerBodyFlush } from '../api/listContent';
import { LockIcon, WarningIcon } from './Icons';
import './NoteImages.css';

/** What `onSave` answers: `true` (or `{ rev }`, naming the note's new
 *  revision) saved, `false` did not — and the caller has already said so —
 *  and a `conflict` means the text was changed somewhere else first and
 *  NOTHING was written. Plain `boolean` is still accepted, so a caller with
 *  no revision to name needs no change. */
export type BodySaveOutcome = boolean | { rev: number | null } | { conflict: Conflict };

interface NoteBodyFieldProps {
    /** The OPENED body (null = none). */
    value: string | null | undefined;
    /** `value`'s revision (TaskList.content_rev). The save names the one the
     *  typing started from — see the header. Absent against a server that
     *  has none, which means "no check". */
    contentRev?: number;
    /** Resolves true once saved. `baseRev` is the revision the text being
     *  saved was written on top of. */
    onSave: (text: string, baseRev?: number) => Promise<BodySaveOutcome>;
    readOnly?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
    /** The list this is the text of: a trash of it waits for this field's
     *  pending save (see the header). */
    listId?: number;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'too-long' | 'conflict';

/** The save refused because the note's text changed elsewhere first, with
 *  the copy that won (null = the other device cleared it) and the revision
 *  to try again against. */
interface Conflict {
    theirs: string | null;
    rev?: number;
}

export function NoteBodyField({ value, contentRev, onSave, readOnly = false, placeholder = 'Note', autoFocus = false, listId }: NoteBodyFieldProps) {
    const current = value ?? '';
    const [draft, setDraft] = useState(current);
    const [state, setState] = useState<SaveState>('idle');
    const [conflict, setConflict] = useState<Conflict | null>(null);
    // `dirty` for the async save path, `isDirty` for render; set together.
    const dirty = useRef(false);
    const [isDirty, setIsDirty] = useState(false);
    // The revision the draft was written on top of (see the header). Taken
    // the moment the field goes dirty, from the last COMMITTED render's prop
    // (`latest`, below — a ref must not be written during render), and held
    // while it stays dirty. A save that lands replaces it with the revision
    // it made, so words typed while that save was out are not then judged
    // against a base this field itself has already moved past. A refusal
    // replaces it with the one it hands back, so "Keep mine" retries against
    // the copy that won.
    const baseRev = useRef<number | undefined>(contentRev);
    // What the last COMMITTED render saw, for the async paths (a ref must not
    // be written during render, and `markDirty` below reads this one, so it
    // has to be declared before it).
    const latest = useRef({ draft, current, onSave, contentRev });
    useEffect(() => { latest.current = { draft, current, onSave, contentRev }; });
    const markDirty = useCallback((v: boolean) => {
        if (v && !dirty.current) baseRev.current = latest.current.contentRev;
        dirty.current = v;
        setIsDirty(v);
    }, []);
    const timer = useRef<number | null>(null);
    const areaRef = useRef<HTMLTextAreaElement>(null);
    // A body that changed elsewhere (another device, a refetch) replaces the
    // draft while nothing is being typed here. Mid-edit, the typed text stays
    // — and is no longer the end of the story: the save that follows names
    // the revision it was based on, so the server refuses it rather than
    // letting it land over the newer copy, and the choice below appears.
    const [seen, setSeen] = useState(current);
    if (seen !== current) {
        setSeen(current);
        if (!isDirty) { setDraft(current); setConflict(null); }
    }

    // The save on its way to the server, if any (the cached value already
    // shows it, so "nothing to save" is not "nothing in flight").
    const inFlight = useRef<Promise<BodySaveOutcome> | null>(null);

    const flush = useCallback(async () => {
        if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
        const { draft: text, current: saved, onSave: save } = latest.current;
        if (!dirty.current || text === saved) { markDirty(false); return; }
        if (bodyBytes(text) > MAX_BODY_BYTES) { setState('too-long'); return; }
        setState('saving');
        const request = save(text, baseRev.current);
        inFlight.current = request;
        const outcome = await request;
        if (inFlight.current === request) inFlight.current = null;
        const clash = typeof outcome === 'object' && outcome !== null && 'conflict' in outcome ? outcome.conflict : null;
        const savedRev = typeof outcome === 'object' && outcome !== null && 'rev' in outcome ? outcome.rev : null;
        if (outcome !== false && !clash) {
            // Words typed while the request was out are now written on top of
            // what it saved, so that is their base.
            if (savedRev !== null) baseRev.current = savedRev;
            // Only clean if nothing was typed while the request was out.
            if (latest.current.draft === text) markDirty(false);
            setConflict(null);
            setState('saved');
        } else if (outcome === false) {
            setState('failed');
        } else if (clash) {
            // Refused: the text changed somewhere else first. Keep every word
            // that was typed (the field is untouched), and show the other copy
            // so nothing is chosen blind. The next attempt is judged against
            // the revision that won, so "Keep mine" can win in its turn.
            if (clash.rev !== undefined) baseRev.current = clash.rev;
            setConflict(clash);
            setState('conflict');
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

    // Take the other device's copy: it becomes the field, and the save that
    // follows is based on it, so it can no longer clash.
    const useTheirs = () => {
        setDraft(conflict?.theirs ?? '');
        markDirty(false);
        setConflict(null);
        setState('idle');
    };
    // Keep what was typed: save it again, now against the revision the cache
    // took from the refusal, so this time it wins.
    const keepMine = () => {
        setConflict(null);
        markDirty(true);
        void flush();
    };
    // Their copy cannot be read on this device: offering "use theirs" would
    // seal the words of the decryption error back over real ciphertext, which
    // is the one thing this file exists to prevent.
    const theirsReadable = conflict !== null && conflict.theirs !== null && !isUndecryptable(conflict.theirs);

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
            {state === 'conflict' && conflict && (
                <div className="nb-status failed nb-conflict" role="alert" data-conflict="stale">
                    <span className="nb-conflict-text">
                        <WarningIcon /> This note’s text was changed somewhere else while you were writing, so nothing was saved yet.
                        {conflict.theirs === null
                            ? ' The other copy has no text at all.'
                            : theirsReadable
                                ? ' The other copy says:'
                                : ' The other copy can’t be read on this device.'}
                        {theirsReadable && <span className="nb-theirs" data-theirs>{conflict.theirs}</span>}
                    </span>
                    <span className="nb-conflict-actions">
                        <button type="button" data-action="keep-mine" onClick={keepMine}>Keep mine</button>
                        {theirsReadable && <button type="button" data-action="use-theirs" onClick={useTheirs}>Use theirs</button>}
                    </span>
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
