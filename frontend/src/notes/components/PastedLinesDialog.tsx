/**
 * "You pasted 12 lines — one item each?" The confirmation a multi-line paste
 * into an item field goes through before anything is created.
 *
 * It exists because removing items again is one tap at a time: the editor's
 * per-row delete has no Undo (NoteEditor.tsx wires onDelete straight to
 * deleteTaskFrom), so a stray Ctrl+V of a document that silently made forty
 * items would be unrecoverable in any reasonable number of taps. Asking first
 * is the mitigation, not polish — so the lines it is ABOUT to add are listed,
 * and the dialog is the only way past.
 *
 * A single-line paste never reaches here: linesFromPaste returns one line and
 * the handler lets the browser paste it normally.
 */
import { NotesDialog } from './NotesDialog';

/** Never render more rows than this; the rest are counted, not listed. */
export const PASTE_PREVIEW_LIMIT = 50;

interface PastedLinesDialogProps {
    lines: string[];
    /** One item per line. */
    onAddSeparate: () => void;
    /** The whole paste as a single item. */
    onAddOne: () => void;
    onCancel: () => void;
}

export function PastedLinesDialog({ lines, onAddSeparate, onAddOne, onCancel }: PastedLinesDialogProps) {
    const shown = lines.slice(0, PASTE_PREVIEW_LIMIT);
    const hidden = lines.length - shown.length;
    return (
        <NotesDialog title="Add these as items?" onClose={onCancel}>
            <div className="notes-paste-dialog">
                <p className="notes-labels-hint">
                    You pasted {lines.length} lines. Items are removed one at a time, so this asks first.
                </p>
                <ul className="notes-paste-lines">
                    {shown.map((l, i) => <li key={i} className="notes-paste-line">{l}</li>)}
                </ul>
                {hidden > 0 && <p className="notes-labels-hint">…and {hidden} more.</p>}
                <div className="notes-paste-actions">
                    <button type="button" className="notes-textbtn" onClick={onCancel}>Cancel</button>
                    <button type="button" className="notes-textbtn" onClick={onAddOne}>Add as one item</button>
                    <button type="button" className="notes-textbtn primary" onClick={onAddSeparate}>
                        Add {lines.length} items
                    </button>
                </div>
            </div>
        </NotesDialog>
    );
}
