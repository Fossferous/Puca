/**
 * "You pasted 12 lines — one item each?" The confirmation a multi-line paste
 * into an item field goes through before anything is created.
 *
 * It exists because removing items again is one tap at a time (and in Púca's
 * Tasks view there is no Undo for a delete at all), so a stray Ctrl+V of a
 * document that silently made forty items would be unrecoverable in any
 * reasonable number of taps. Asking first is the mitigation, not polish — so
 * the lines it is ABOUT to add are listed, and the dialog is the only way
 * past.
 *
 * A single-line paste never reaches here: readPastedItems (notes/model/
 * noteContent.ts) returns null for one line and the handler lets the browser
 * paste it normally.
 *
 * It TAKES THE FOCUS when it opens, or it stays in the field that was pasted
 * into, and Enter there submits that field's form behind the question. It
 * goes to the question itself, not to a button: the paste this guards
 * against is the one the person did not mean, and a reflexive Enter after it
 * must answer nothing — least of all "Add N items". Tab reaches the answers.
 * The keys typed there were typing a moment ago and stay the question's
 * (`ownsKeys`): no bare-key hotkey of Púca's, and no single-key shortcut or
 * Ctrl+A of Notes' behind it — every one of them stood aside for the input.
 *
 * SHARED: it was notes/components/PastedLinesDialog.tsx until Púca's own
 * Tasks view took pastes too. Its class names are unchanged (the Notes tests
 * name them) and its rules travel with it, because Púca never loads
 * notes/noteContent.css.
 */
import { useEffect, useRef } from 'react';
import { NotesDialog } from './NotesDialog';
import { addItemsLabel, headingLabel, isHeadingText } from '../api/taskHeading';
import './PastedLinesDialog.css';

/** Never render more rows than this; the rest are counted, not listed. */
export const PASTE_PREVIEW_LIMIT = 50;

interface PastedLinesDialogProps {
    lines: string[];
    /** How many the paste held, when `lines` was capped (readPastedItems'
     *  MAX_TAKEN_ITEMS): the rest are not added, and the dialog says so. */
    total?: number;
    /** What answering does besides adding items ("This makes a new list,
     *  …"), when it does more. */
    detail?: string | null;
    /** One item per line (a "## " line as a heading). */
    onAddSeparate: () => void;
    /** The whole paste as a single item. */
    onAddOne: () => void;
    onCancel: () => void;
}

export function PastedLinesDialog({ lines, total = lines.length, detail = null, onAddSeparate, onAddOne, onCancel }: PastedLinesDialogProps) {
    const shown = lines.slice(0, PASTE_PREVIEW_LIMIT);
    const hidden = lines.length - shown.length;
    const bodyRef = useRef<HTMLDivElement>(null);
    useEffect(() => { bodyRef.current?.focus({ preventScroll: true }); }, []);
    return (
        <NotesDialog title="Add these as items?" onClose={onCancel} ownsKeys>
            <div className="notes-paste-dialog" ref={bodyRef} tabIndex={-1}>
                <p className="notes-labels-hint">
                    You pasted {total} lines. Items are removed one at a time, so this asks first.
                </p>
                {total > lines.length && <p className="notes-labels-hint">Only the first {lines.length} are added.</p>}
                {detail && <p className="notes-labels-hint">{detail}</p>}
                <ul className="notes-paste-lines">
                    {/* A heading shows as the heading it will be: its label, bold. */}
                    {shown.map((l, i) => isHeadingText(l)
                        ? <li key={i} className="notes-paste-line heading">{headingLabel(l)}</li>
                        : <li key={i} className="notes-paste-line">{l}</li>)}
                </ul>
                {hidden > 0 && <p className="notes-labels-hint">…and {hidden} more.</p>}
                <div className="notes-paste-actions">
                    <button type="button" className="notes-textbtn" onClick={onCancel}>Cancel</button>
                    <button type="button" className="notes-textbtn" onClick={onAddOne}>Add as one item</button>
                    <button type="button" className="notes-textbtn primary" onClick={onAddSeparate}>
                        {addItemsLabel(lines)}
                    </button>
                </div>
            </div>
        </NotesDialog>
    );
}
