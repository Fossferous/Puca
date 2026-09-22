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
 * TWO DEVICES, ONE NOTE. While nothing is being typed here, text that changed
 * elsewhere simply replaces the field — that is a refresh, not a clash. But a
 * save made ON TOP of a change from somewhere else is REFUSED by the server
 * (migration 069; api/listConflict.ts), and then this field keeps the words
 * that were typed, shows the other copy, and asks which to keep. Nothing is
 * thrown away before the user chooses. Before this, whichever save landed
 * last silently won and the other text was gone with no record of it.
 *
 * AND THE QUESTION IS ANSWERED BY THE USER, NOT BY LEAVING. While it is on
 * screen this field saves nothing at all: no blur, no close, no trash of the
 * note commits the words being asked about. That guard is not a nicety. The
 * field must stay dirty while the question is open (the words really are
 * unsaved) and the cache by then holds the copy that WON, so every ordinary
 * flush — the textarea's own onBlur, the unmount that closing the note runs,
 * the trash's registered flush — saw "dirty, and different from what is
 * stored", re-sent the typed text against the winning revision, and the
 * server took it. The other device's words were gone with nobody ever
 * choosing. Worse, the banner's buttons are siblings of the textarea, so
 * pressing "Use theirs" blurred the field first and fired that very save on
 * its way in. Only three things answer the question: "Keep mine", "Use
 * theirs", and typing on over the banner (a deliberate keep-mine).
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
 *
 * While this field is mounted it OWNS the note's text: anything else that
 * wants to add to it (a voice note's transcript) goes through the
 * `appendText` handle below rather than writing to the note behind it.
 * Text holding a WEB ADDRESS swaps to a read view when it is not being
 * edited, so the address can be tapped (NoteLinkText). Text with no address
 * never leaves the textarea — the swap buys nothing there, and this component
 * owns the debounced save, the blur flush, the unmount flush and the
 * trash-waits-for-the-last-keystroke registration, so the less of it a new
 * mount/unmount sits in the middle of, the better. On blur the flush is
 * kicked BEFORE the swap, so the last words typed are saved, not lost.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { isUndecryptable } from '../api/decryptMarkers';
import { BODY_SAVE_DELAY_MS, MAX_BODY_BYTES, bodyBytes, registerBodyFlush } from '../api/listContent';
import { appendTranscript } from '../notes/model/audioNote';
import { LockIcon, WarningIcon } from './Icons';
import { NoteLinkText } from './NoteLinkText';
import { hasLink } from '../utils/linkSegments';
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

/** What `onSave` answers: `true` (or `{ rev }`, naming the note's new
 *  revision) saved, `false` did not — and the caller has already said so —
 *  and a `conflict` means the text was changed somewhere else first and
 *  NOTHING was written. Plain `boolean` is still accepted, so a caller with
 *  no revision to name needs no change. */
export type BodySaveOutcome = SaveResult | { rev: number | null } | { conflict: Conflict };

interface NoteBodyFieldProps {
    /** The OPENED body (null = none). */
    value: string | null | undefined;
    /** `value`'s revision (TaskList.content_rev). The save names the one the
     *  typing started from — see the header. Absent against a server that
     *  has none, which means "no check". */
    contentRev?: number;
    /** Resolves once the save has been decided. `baseRev` is the revision the
     *  text being saved was written on top of; `queued` = kept on this
     *  device; `failed` = refused, keep the text. */
    onSave: (text: string, baseRev?: number) => Promise<BodySaveOutcome>;
    readOnly?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
    /** The list this is the text of: a trash of it waits for this field's
     *  pending save (see the header). */
    listId?: number;
}

/** What a caller's save did. A plain boolean is still accepted so callers
 *  with neither an offline queue nor revisions (components/
 *  ListContentBlock.tsx) stay as they are; `{ rev }` names the note's new
 *  revision, 'queued' means it is kept on this device until the connection
 *  is back, and `{ conflict }` means the text changed somewhere else first
 *  and NOTHING was written. */
export type SaveResult = boolean | 'saved' | 'queued' | 'failed';

type SaveState = 'idle' | 'saving' | 'saved' | 'queued' | 'failed' | 'too-long' | 'conflict';

/** The save refused because the note's text changed elsewhere first, with
 *  the copy that won (null = the other device cleared it) and the revision
 *  to try again against. */
interface Conflict {
    theirs: string | null;
    rev?: number;
}

/** The character offset in `root`'s text under (x, y), or null when this
 *  browser cannot say (older WebViews) — the caller then keeps the caret at
 *  the end. The rendered view's text content IS the draft, so a walk of its
 *  text nodes maps a DOM position straight onto a string offset. */
function caretOffsetAt(root: HTMLElement | null, x: number, y: number): number | null {
    if (!root) return null;
    const doc = root.ownerDocument;
    const api = doc as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (typeof api.caretRangeFromPoint === 'function') {
        const r = api.caretRangeFromPoint(x, y);
        if (r) { node = r.startContainer; offset = r.startOffset; }
    } else if (typeof api.caretPositionFromPoint === 'function') {
        const p = api.caretPositionFromPoint(x, y);
        if (p) { node = p.offsetNode; offset = p.offset; }
    }
    if (!node || !root.contains(node)) return null;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    while (walker.nextNode()) {
        if (walker.currentNode === node) return total + offset;
        total += walker.currentNode.textContent?.length ?? 0;
    }
    return null;
}

export const NoteBodyField = forwardRef<NoteBodyHandle, NoteBodyFieldProps>(function NoteBodyField(
    { value, contentRev, onSave, readOnly = false, placeholder = 'Note', autoFocus = false, listId }: NoteBodyFieldProps,
    handle,
) {
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
    const readRef = useRef<HTMLDivElement>(null);
    // The read/edit swap: `editing` wins, and text with no link never swaps.
    const [editing, setEditing] = useState(autoFocus);
    // Where the click that started this edit landed, so the caret goes there
    // rather than to the end of the note.
    const pendingCaret = useRef<number | null>(null);
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
    // A refusal is on screen and the user has not answered it yet. Every
    // save is held until they do — see the header. Cleared by the three
    // things that ARE an answer, and by nothing else; in particular not by
    // the clean-replace branch above, which cannot run while a question is
    // open (an open question keeps the field dirty).
    const awaitingChoice = useRef(false);

    /** True once what is in the field is on the server (or was already). */
    const flush = useCallback(async (): Promise<boolean> => {
        // The user is being asked which copy to keep: saving now would answer
        // for them, and the answer would always be "mine" (see the header).
        // Not saved, so the caller (a trash, an appendText) hears "no".
        if (awaitingChoice.current) return false;
        if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
        const { draft: text, current: saved, onSave: save } = latest.current;
        if (!dirty.current || text === saved) { markDirty(false); return true; }
        if (bodyBytes(text) > MAX_BODY_BYTES) { setState('too-long'); return false; }
        setState('saving');
        const request = save(text, baseRev.current);
        inFlight.current = request;
        const result = await request;
        if (inFlight.current === request) inFlight.current = null;
        const clash = typeof result === 'object' && result !== null && 'conflict' in result ? result.conflict : null;
        const savedRev = typeof result === 'object' && result !== null && 'rev' in result ? result.rev : null;
        // Three plain answers ('saved' | 'queued' | 'failed'), a boolean, or
        // one of the two objects above. A queued save IS saved as far as this
        // field is concerned — the words are safe on the device — it just
        // says so differently.
        const outcome: SaveState = clash ? 'conflict'
            : result === false || result === 'failed' ? 'failed'
                : result === 'queued' ? 'queued' : 'saved';
        if (outcome === 'failed') {
            setState('failed');
            return false;
        }
        if (outcome === 'conflict' && clash) {
            // Refused: the text changed somewhere else first. Keep every word
            // that was typed (the field is untouched), and show the other copy
            // so nothing is chosen blind. The next attempt is judged against
            // the revision that won, so "Keep mine" can win in its turn.
            if (clash.rev !== undefined) baseRev.current = clash.rev;
            awaitingChoice.current = true;
            setConflict(clash);
            setState('conflict');
            return false;
        }
        // Words typed while the request was out are now written on top of
        // what it saved, so that is their base.
        if (savedRev !== null) baseRev.current = savedRev;
        // Only clean if nothing was typed while the request was out.
        if (latest.current.draft === text) markDirty(false);
        setConflict(null);
        setState(outcome);
        return true;
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

    // Clicking the read view puts the textarea back with the caret where the
    // click landed (end of text when the browser cannot say).
    useLayoutEffect(() => {
        if (!editing) return;
        const el = areaRef.current;
        if (!el || document.activeElement === el) return;
        el.focus();
        const at = pendingCaret.current;
        pendingCaret.current = null;
        if (at !== null) el.setSelectionRange(at, at);
    }, [editing]);

    // Computed HERE, above the effects, because the auto-height below has to
    // depend on it: the swap remounts the textarea without changing `draft`.
    const showRead = !editing && hasLink(draft);

    // The field is as tall as its text. `showRead` is a dependency, not
    // decoration: the read/edit swap mounts a FRESH textarea at its rows={2}
    // size while `draft` is unchanged, so an effect keyed on the text alone
    // never fires for it — and `.nb-text` is `overflow: hidden`, so the rest
    // of the note would simply be clipped until the next keystroke.
    useLayoutEffect(() => {
        if (showRead) return;
        const el = areaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [draft, showRead]);

    // Take the other device's copy: it becomes the field, and the save that
    // follows is based on it, so it can no longer clash.
    const useTheirs = () => {
        awaitingChoice.current = false;
        setDraft(conflict?.theirs ?? '');
        markDirty(false);
        setConflict(null);
        setState('idle');
    };
    // Keep what was typed: save it again, now against the revision the cache
    // took from the refusal, so this time it wins.
    const keepMine = () => {
        awaitingChoice.current = false;
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
            {showRead ? (
                <div
                    ref={readRef}
                    className="nb-text nb-rendered"
                    role="textbox"
                    tabIndex={readOnly ? -1 : 0}
                    aria-label="Note text"
                    aria-readonly={readOnly}
                    onFocus={e => {
                        if (readOnly) return;
                        // Guarded exactly like the click below, and for the
                        // same reason — but this one is what actually decides
                        // whether a link can be tapped at all. Chromium
                        // focuses an anchor on MOUSEDOWN and React wires
                        // `onFocus` to `focusin`, which BUBBLES, so this runs
                        // before the anchor's own click. Opening the editor
                        // here unmounts the anchor between mousedown and
                        // mouseup and the click never happens.
                        if ((e.target as Element).closest('a')) return;
                        setEditing(true);
                    }}
                    onClick={e => {
                        if (readOnly) return;
                        // A tap on a link belongs to the link (NoteLinkText
                        // already stopped it), not to the editor.
                        if ((e.target as Element).closest('a')) return;
                        pendingCaret.current = caretOffsetAt(readRef.current, e.clientX, e.clientY);
                        setEditing(true);
                    }}
                >
                    <NoteLinkText text={draft} />
                </div>
            ) : (
            <textarea
                ref={areaRef}
                className="nb-text"
                value={draft}
                placeholder={placeholder}
                readOnly={readOnly}
                autoFocus={autoFocus}
                aria-label="Note text"
                rows={2}
                onFocus={() => setEditing(true)}
                onChange={e => {
                    // Writing more over the banner is a deliberate "keep
                    // mine": the other copy has been read and the user has
                    // carried on. It dismisses the banner, so it has to
                    // release the hold too, or the field would never save
                    // again.
                    awaitingChoice.current = false;
                    // Typing a URL must not swap the field out from under the
                    // caret: while this field is being used, it stays a field.
                    setEditing(true);
                    markDirty(true);
                    setDraft(e.target.value);
                    setState('idle');
                    if (timer.current !== null) window.clearTimeout(timer.current);
                    timer.current = window.setTimeout(() => { void flush(); }, BODY_SAVE_DELAY_MS);
                }}
                onBlur={() => {
                    // Kick the save FIRST: it reads the live draft, and only
                    // then may the field be replaced by the read view.
                    void flush();
                    setEditing(false);
                }}
            />
            )}
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
            {state === 'queued' && <div className="nb-status queued" role="status">Kept on this device — it will sync.</div>}
        </div>
    );
});
