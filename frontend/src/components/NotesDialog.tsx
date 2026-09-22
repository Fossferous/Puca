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
}

export function NotesDialog({ title, onClose, children }: NotesDialogProps) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            onClose();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [onClose]);
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

