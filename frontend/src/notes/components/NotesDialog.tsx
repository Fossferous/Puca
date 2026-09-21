/**
 * A small centred dialog (shortcuts help, confirmations). Portaled to body;
 * Escape closes it and stops there, like Popover.
 *
 * `busy` makes every way OUT inert — Escape, the backdrop and the X — without
 * letting Escape reach the layer underneath. A dialog whose confirm step is
 * mid-request must not be dismissable: the request is not cancelled by
 * closing, so reopening and confirming again would do the thing twice, and
 * "the thing" here is posting a chat message, which cannot be unsent.
 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../../components/Icons';

interface NotesDialogProps {
    title: string;
    onClose: () => void;
    /** A request this dialog started is in flight: it cannot be dismissed. */
    busy?: boolean;
    children: ReactNode;
}

export function NotesDialog({ title, onClose, busy = false, children }: NotesDialogProps) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            // Swallowed either way: while busy this dialog still owns Escape,
            // it just does not act on it. Letting it through would close the
            // note behind the dialog instead.
            e.preventDefault();
            e.stopPropagation();
            if (!busy) onClose();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [onClose, busy]);
    return createPortal(
        <div className="notes-dialog-backdrop" onClick={() => { if (!busy) onClose(); }}>
            <div className="notes-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
                <div className="notes-dialog-head">
                    <h3>{title}</h3>
                    <button type="button" className="notes-iconbtn small" aria-label="Close" title="Close" disabled={busy} onClick={onClose}>
                        <CloseIcon size={18} />
                    </button>
                </div>
                <div className="notes-dialog-body">{children}</div>
            </div>
        </div>,
        document.body,
    );
}

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
    return (
        <NotesDialog title="Keyboard shortcuts" onClose={onClose}>
            <div className="notes-kbd-grid">
                <kbd>/</kbd><span>Search notes</span>
                <kbd>c</kbd><span>New note</span>
                <kbd>r</kbd><span>Refresh from the server</span>
                <kbd>Esc</kbd><span>Close the note, a menu, or clear the search</span>
                <kbd>Enter</kbd><span>In a note: add the next item; while editing an item: save it</span>
                <kbd>?</kbd><span>This help</span>
            </div>
            <p className="notes-labels-hint">In the Calendar:</p>
            <div className="notes-kbd-grid">
                <kbd>t</kbd><span>Today</span>
                <kbd>j</kbd><span>Next month / week / day (also <kbd>n</kbd>)</span>
                <kbd>k</kbd><span>Previous (also <kbd>p</kbd>)</span>
                <kbd>m</kbd><span>Month · <kbd>w</kbd> week · <kbd>d</kbd> day · <kbd>a</kbd> agenda</span>
                <kbd>c</kbd><span>Add on the selected day (instead of a new note)</span>
                <kbd>Arrows</kbd><span>Home/End and PageUp/PageDown too: move around the month; Enter picks the day</span>
                <kbd>[</kbd><span>On a focused item: move it a day earlier (<kbd>]</kbd> later)</span>
            </div>
            <p className="notes-labels-hint">
                Inside a note, drag an item by its grip to reorder it, and drag it right or left to nest or un-nest —
                the same gestures as Púca's Tasks view.
            </p>
        </NotesDialog>
    );
}
