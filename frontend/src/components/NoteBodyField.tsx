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
 * Text holding a WEB ADDRESS swaps to a read view when it is not being
 * edited, so the address can be tapped (NoteLinkText). Text with no address
 * never leaves the textarea — the swap buys nothing there, and this component
 * owns the debounced save, the blur flush, the unmount flush and the
 * trash-waits-for-the-last-keystroke registration, so the less of it a new
 * mount/unmount sits in the middle of, the better. On blur the flush is
 * kicked BEFORE the swap, so the last words typed are saved, not lost.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isUndecryptable } from '../api/decryptMarkers';
import { BODY_SAVE_DELAY_MS, MAX_BODY_BYTES, bodyBytes, registerBodyFlush } from '../api/listContent';
import { LockIcon } from './Icons';
import { NoteLinkText } from './NoteLinkText';
import { hasLink } from '../utils/linkSegments';
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
    const readRef = useRef<HTMLDivElement>(null);
    // The read/edit swap: `editing` wins, and text with no link never swaps.
    const [editing, setEditing] = useState(autoFocus);
    // Where the click that started this edit landed, so the caret goes there
    // rather than to the end of the note.
    const pendingCaret = useRef<number | null>(null);
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
