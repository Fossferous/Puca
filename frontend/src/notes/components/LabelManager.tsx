/**
 * "Edit labels" — rename, merge and delete a label across EVERY note.
 *
 * The per-note pickers (LabelPicker, the selection bar's BulkLabelPicker) can
 * only reach notes the grid is showing, and a label view hides archived notes
 * (notesModel.filterNotes), so a label left on an archived note was previously
 * impossible to rename or clear from anywhere. This dialog works on the whole
 * sealed label map instead, which is why its counts include archived notes.
 *
 * Each of the three operations is ONE renameLabel() call — one localStorage
 * write, one notify(), one debounced compare-and-swap push of the sealed
 * `notes-prefs` blob (notesPrefsSync.ts). Never a per-note loop: N writes can
 * interleave with a 409 replay and a half-applied rename would be merged as if
 * it had been meant.
 *
 * Nothing new reaches the server. Label names live inside the same sealed
 * document they already lived in; the server sees a revision bump, never a
 * name.
 */
import { useState } from 'react';
import { CheckIcon, CloseIcon, PencilIcon, TagIcon, TrashIcon } from '../../components/Icons';
import { MAX_LABEL_LENGTH, normalizeLabel } from '../model/notesModel';
import { getNotesPrefs, renameLabel } from '../model/notesPrefs';
import { NotesDialog } from './NotesDialog';

/** What the dialog is about to do, once the user has confirmed it. */
type Confirming =
    | { kind: 'merge'; from: string; to: string }
    | { kind: 'delete'; from: string };

export interface LabelManagerProps {
    /** Every label in use, in rail order (notesModel.allLabels). */
    labels: string[];
    /** Lower-cased label → how many notes carry it, ARCHIVED INCLUDED. */
    counts: ReadonlyMap<string, number>;
    onClose: () => void;
    /**
     * A change landed. `to` is null for a delete. `before` is the whole label
     * map as it was, for the Undo bar the owner shows.
     */
    onChanged: (from: string, to: string | null, before: Record<string, string[]>) => void;
}

const lower = (s: string) => s.toLocaleLowerCase();

export function LabelManager({ labels, counts, onClose, onChanged }: LabelManagerProps) {
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [confirming, setConfirming] = useState<Confirming | null>(null);

    const countOf = (l: string) => counts.get(lower(l)) ?? 0;

    const startEdit = (l: string) => {
        setConfirming(null);
        setEditing(l);
        setDraft(l);
    };
    const cancelRow = () => {
        setEditing(null);
        setConfirming(null);
    };

    /** The one write path: snapshot, rename, tell the owner. */
    const commit = (from: string, to: string | null) => {
        const before = getNotesPrefs().labels;
        renameLabel(from, to ?? '');
        cancelRow();
        onChanged(from, to, before);
    };

    const submitRename = (from: string) => {
        const next = normalizeLabel(draft);
        if (!next) return;                       // the trash button is how you delete
        if (next === from) { cancelRow(); return; }
        // Landing on a name already in use is a MERGE. Adopt that label's own
        // spelling as the target, so the two do not survive as "House" and
        // "house" — allLabels() would fold them into one rail row anyway and
        // the second spelling could never be selected again.
        const existing = labels.find(l => lower(l) === lower(next) && lower(l) !== lower(from));
        if (existing) { setConfirming({ kind: 'merge', from, to: existing }); return; }
        commit(from, next);
    };

    return (
        <NotesDialog title="Edit labels" onClose={onClose}>
            {labels.length === 0 ? (
                <div className="notes-labels-hint">No labels yet — add one from a note’s Labels button.</div>
            ) : (
                <div className="notes-labelmgr-list">
                    {labels.map(l => {
                        const n = countOf(l);
                        const noteCount = `${n} note${n === 1 ? '' : 's'}`;
                        if (confirming && lower(confirming.from) === lower(l)) {
                            return (
                                <div key={l} className="notes-labelmgr-row confirm">
                                    <span className="notes-labelmgr-ask">
                                        {confirming.kind === 'merge'
                                            ? `Merge into “${confirming.to}”? ${noteCount} labelled “${l}” will be labelled “${confirming.to}” instead.`
                                            : `Remove “${l}” from ${noteCount}?`}
                                    </span>
                                    <button
                                        type="button"
                                        className="notes-textbtn"
                                        onClick={cancelRow}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        className={`notes-textbtn ${confirming.kind === 'delete' ? 'danger' : 'primary'}`}
                                        onClick={() => commit(confirming.from, confirming.kind === 'merge' ? confirming.to : null)}
                                    >
                                        {confirming.kind === 'merge' ? 'Merge' : 'Remove'}
                                    </button>
                                </div>
                            );
                        }
                        if (editing === l) {
                            return (
                                <form
                                    key={l}
                                    className="notes-labelmgr-row editing"
                                    onSubmit={e => { e.preventDefault(); submitRename(l); }}
                                >
                                    <TagIcon />
                                    <input
                                        value={draft}
                                        maxLength={MAX_LABEL_LENGTH}
                                        aria-label={`New name for ${l}`}
                                        autoFocus
                                        onChange={e => setDraft(e.target.value)}
                                        onKeyDown={e => {
                                            // Escape cancels THIS row, not the dialog.
                                            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRow(); }
                                        }}
                                    />
                                    <button
                                        type="submit"
                                        className="notes-iconbtn small"
                                        aria-label={`Save ${l}`}
                                        title="Save"
                                        disabled={!normalizeLabel(draft)}
                                    >
                                        <CheckIcon />
                                    </button>
                                    <button type="button" className="notes-iconbtn small" aria-label="Cancel rename" title="Cancel" onClick={cancelRow}>
                                        <CloseIcon />
                                    </button>
                                </form>
                            );
                        }
                        return (
                            <div key={l} className="notes-labelmgr-row">
                                <TagIcon />
                                <span className="notes-labelmgr-name">{l}</span>
                                <span className="notes-labelmgr-count">{noteCount}</span>
                                <button
                                    type="button"
                                    className="notes-iconbtn small"
                                    aria-label={`Rename ${l}`}
                                    title="Rename"
                                    onClick={() => startEdit(l)}
                                >
                                    <PencilIcon />
                                </button>
                                <button
                                    type="button"
                                    className="notes-iconbtn small danger"
                                    aria-label={`Delete ${l}`}
                                    title="Delete everywhere"
                                    onClick={() => { setEditing(null); setConfirming({ kind: 'delete', from: l }); }}
                                >
                                    <TrashIcon />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
            <div className="notes-labels-hint">
                Counts include archived notes. Renaming onto a label you already have merges the two.
                Labels are encrypted on this device — a change here is one write of your sealed list.
            </div>
        </NotesDialog>
    );
}
