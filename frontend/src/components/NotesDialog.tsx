/**
 * A small centred dialog (shortcuts help, confirmations, the .ics import).
 * Portaled to body; Escape closes it and stops there, like Popover.
 *
 * SHARED: it was notes/components/NotesDialog.tsx until the .ics import
 * became one of Púca's own calendar actions. Its class names are unchanged —
 * the Notes walks name them — and its rules travel with it, because Púca
 * never loads notes.css.
 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './NotesDialog.css';
import { CloseIcon } from './Icons';

interface NotesDialogProps {
    title: string;
    onClose: () => void;
    children: ReactNode;
    /**
     * Something INSIDE the dialog wants this Escape — an open row, a picker.
     * The listener below is on document in the CAPTURE phase and is installed
     * by this child's effect, i.e. before the parent's, so nothing the parent
     * renders can beat it to the key: a synthetic onKeyDown runs later still.
     * The only way to let an inner Escape through is for the parent to say so
     * here and handle it itself (notes/components/LabelManager.tsx does).
     */
    escapeBlocked?: boolean;
}

export function NotesDialog({ title, onClose, children, escapeBlocked = false }: NotesDialogProps) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || escapeBlocked) return;
            e.preventDefault();
            e.stopPropagation();
            onClose();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [onClose, escapeBlocked]);
    return createPortal(
        <div className="notes-dialog-backdrop" onClick={onClose}>
            <div className="notes-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
                <div className="notes-dialog-head">
                    <h3>{title}</h3>
                    <button type="button" className="notes-iconbtn small" aria-label="Close" title="Close" onClick={onClose}>
                        <CloseIcon size={18} />
                    </button>
                </div>
                <div className="notes-dialog-body">{children}</div>
            </div>
        </div>,
        document.body,
    );
}

