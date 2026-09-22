/**
 * Púca Notes — colour, labels and archive for several notes at once. Each is
 * ONE write of the note state, so it is one sealed-blob push
 * (notesPrefsSync.ts), not one per note.
 */
import { type NoteColor, type NotesNoteState } from './notesModel';
import { dedupeLabels, getNotesPrefs, replaceNoteState } from './notesPrefs';

const lower = (s: string) => s.toLocaleLowerCase();

export function withColor(s: NotesNoteState, keys: readonly string[], color: NoteColor): NotesNoteState {
    const colors = { ...s.colors };
    for (const k of keys) {
        if (color === 'default') delete colors[k]; else colors[k] = color;
    }
    return { ...s, colors };
}

export function withLabel(s: NotesNoteState, keys: readonly string[], label: string, on: boolean): NotesNoteState {
    const labels = { ...s.labels };
    for (const k of keys) {
        const cur = labels[k] ?? [];
        const next = on
            ? dedupeLabels([...cur, label])
            : cur.filter(l => lower(l) !== lower(label));
        if (next.length > 0) labels[k] = next; else delete labels[k];
    }
    return { ...s, labels };
}

export function withArchived(s: NotesNoteState, keys: readonly string[], archived: boolean): NotesNoteState {
    const next = { ...s.archived };
    for (const k of keys) {
        if (archived) next[k] = true; else delete next[k];
    }
    return { ...s, archived: next };
}

/** For each label: do all, some or none of these notes carry it? */
export function labelCoverage(s: NotesNoteState, keys: readonly string[], labels: readonly string[]): Map<string, 'all' | 'some' | 'none'> {
    const out = new Map<string, 'all' | 'some' | 'none'>();
    for (const l of labels) {
        const n = keys.filter(k => (s.labels[k] ?? []).some(x => lower(x) === lower(l))).length;
        out.set(l, n === 0 ? 'none' : n === keys.length ? 'all' : 'some');
    }
    return out;
}

const apply = (fn: (s: NotesNoteState) => NotesNoteState) => {
    const p = getNotesPrefs();
    replaceNoteState(fn({ colors: p.colors, labels: p.labels, archived: p.archived }));
};

export const setColorOf = (keys: readonly string[], color: NoteColor) => apply(s => withColor(s, keys, color));
export const setLabelOn = (keys: readonly string[], label: string, on: boolean) => apply(s => withLabel(s, keys, label, on));
export const setArchivedOf = (keys: readonly string[], archived: boolean) => apply(s => withArchived(s, keys, archived));
/** Put the WHOLE label map back — the Undo of a rename, merge or delete made
 *  from the label manager. One write, one push, like every other bulk op. A
 *  whole snapshot is right here (and wrong for lists, see reinsertList): a
 *  rename touches every note at once, so there is no per-note rollback. */
export const restoreLabels = (labels: Record<string, string[]>) => apply(s => ({ ...s, labels }));

/** Put back exactly these notes' archive flags (Undo). */
export const restoreArchived = (flags: Record<string, boolean>) => apply(s => {
    const next = { ...s.archived };
    for (const [k, v] of Object.entries(flags)) { if (v) next[k] = true; else delete next[k]; }
    return { ...s, archived: next };
});

/**
 * Put ONE list back into the list set as it is NOW, at (about) the place it
 * was taken from — the rollback of a failed delete. Never a whole snapshot:
 * a bulk delete runs several at once, and restoring one call's snapshot
 * would bring back notes the others had already deleted on the server.
 */
export function reinsertList<T extends { id: number }>(current: T[] | undefined, item: T, index: number): T[] | undefined {
    if (!current) return current;
    if (current.some(l => l.id === item.id)) return current;
    const at = Math.max(0, Math.min(index, current.length));
    return [...current.slice(0, at), item, ...current.slice(at)];
}
