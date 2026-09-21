/**
 * Undo and redo for a text field, as a bounded list of what the text WAS.
 *
 * A browser gives a textarea its own undo stack, but it is destroyed the
 * moment anything writes the value programmatically — which the note text
 * does on every sync from another device and on every remount — and there is
 * no way to offer it on a phone, where there is no Ctrl key. This is the
 * field's own history instead: pure, bounded, and held in React state, so it
 * never reaches disk (a note's text is end-to-end encrypted, and the offline
 * cache seals what it keeps — see notes/model/notesCache.ts).
 *
 * A burst of typing is ONE step. Extending the current entry while single
 * characters keep arriving means Undo goes back a word or a sentence, not a
 * letter; a paste, a cut, or a pause starts a new step, so the one thing
 * people reach for Undo after — a paste over a whole note — is always a
 * single Undo away.
 */

export interface TextHistory {
    /** What the text has been, oldest first; `stack[index]` is what it is now. */
    stack: string[];
    index: number;
    /** When `stack[index]` was last extended (ms), for the coalescing above. */
    at: number;
}

/** Steps kept. Beyond this the oldest goes: a history is a convenience, not
 *  a store, and every entry is a full copy of the note's text. */
export const TEXT_HISTORY_LIMIT = 100;
/** Edits closer together than this, of one character, are one step. */
export const TEXT_HISTORY_COALESCE_MS = 700;

export function newTextHistory(text: string): TextHistory {
    return { stack: [text], index: 0, at: 0 };
}

/** Record `text` as the current value. Returns the SAME object when nothing
 *  changed, so a caller can skip the re-render. */
export function pushText(h: TextHistory, text: string, now: number): TextHistory {
    const cur = h.stack[h.index];
    if (text === cur) return h;
    // Never extend the first entry: that is the text as it arrived, and the
    // user must always be able to get back to it.
    const extend = h.index > 0
        && Math.abs(text.length - cur.length) <= 1
        && now - h.at < TEXT_HISTORY_COALESCE_MS;
    if (extend) return { stack: [...h.stack.slice(0, h.index), text], index: h.index, at: now };
    // Typing after an undo drops what was undone, as every editor does.
    const stack = [...h.stack.slice(0, h.index + 1), text];
    const over = Math.max(0, stack.length - TEXT_HISTORY_LIMIT);
    return { stack: stack.slice(over), index: stack.length - 1 - over, at: now };
}

export const canUndoText = (h: TextHistory): boolean => h.index > 0;
export const canRedoText = (h: TextHistory): boolean => h.index < h.stack.length - 1;

/** One step back (the same object at the start of the history). `at: 0`
 *  ends the coalescing run, so typing after an undo is its own step. */
export function undoText(h: TextHistory): TextHistory {
    return canUndoText(h) ? { stack: h.stack, index: h.index - 1, at: 0 } : h;
}

export function redoText(h: TextHistory): TextHistory {
    return canRedoText(h) ? { stack: h.stack, index: h.index + 1, at: 0 } : h;
}
