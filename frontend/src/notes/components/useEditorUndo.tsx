/**
 * The open note's one Undo snackbar, and the rule that a new Undo COMMITS the
 * one it replaces.
 *
 * Two things in the editor offer Undo — the text/checklist conversions
 * (NoteContentSection) and an item delete (NoteEditor) — and `.notes-undo` is
 * fixed to the bottom of the viewport, so two bars would sit on top of each
 * other. NoteEditor owns one of these and hands `push` down; a
 * NoteContentSection rendered on its own (the tests) falls back to its own.
 *
 * THE BUFFER HOLDS DECRYPTED CONTENT — item text, the opened attachments
 * sidecar (whose `sovereign-enc:` hrefs carry per-file keys), the opened
 * schedule and snooze. It lives in React state and refs and NOWHERE else: it
 * must never be sealed into the offline cache (model/notesCache.ts
 * safeToPersist) or any other store. Making the Undo "survive a reload"
 * would put plaintext note content on disk outside the sealed cache, so
 * don't.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { UndoBar } from './UndoBar';

/** `commit` runs when the Undo can no longer happen: the window expired, a
 *  newer Undo replaced this one, or the note closed. That is when a delete
 *  becomes final — e.g. when the files nothing names any more are deleted. */
export interface EditorUndo {
    message: string;
    run: () => Promise<void>;
    commit?: () => void;
}

/** A pending Undo carries a token nothing else reuses: UndoBar re-arms its
 *  countdown per token, so replacing one Undo with another restarts it. */
type Pending = EditorUndo & { token: number };
let undoSeq = 0;

export interface EditorUndoApi {
    /** Offer this Undo, committing whatever it replaces. */
    push: (undo: EditorUndo) => void;
    /** The bar, or null when nothing is pending. Render it once. */
    bar: ReactNode;
}

export function useEditorUndo(): EditorUndoApi {
    const [undo, setUndoState] = useState<Pending | null>(null);
    const undoRef = useRef<Pending | null>(null);
    const set = useCallback((next: Pending | null, committed = true) => {
        const prev = undoRef.current;
        undoRef.current = next;
        setUndoState(next);
        if (prev && prev !== next && committed) prev.commit?.();
    }, []);
    // Closing the note ends the Undo too.
    useEffect(() => () => { undoRef.current?.commit?.(); undoRef.current = null; }, []);
    const push = useCallback((next: EditorUndo) => set({ ...next, token: ++undoSeq }), [set]);
    const bar = undo
        ? (
            <UndoBar
                token={undo.token}
                message={undo.message}
                onUndo={() => { const u = undo; set(null, false); void u.run(); }}
                onExpire={() => set(null)}
            />
        )
        : null;
    return { push, bar };
}
