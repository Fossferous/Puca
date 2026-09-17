/**
 * A small centred dialog (shortcuts help, confirmations). Portaled to body;
 * Escape closes it and stops there, like Popover.
 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../../components/Icons';

interface KeepDialogProps {
    title: string;
    onClose: () => void;
    children: ReactNode;
}

export function KeepDialog({ title, onClose, children }: KeepDialogProps) {
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
        <div className="keep-dialog-backdrop" onClick={onClose}>
            <div className="keep-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
                <div className="keep-dialog-head">
                    <h3>{title}</h3>
                    <button type="button" className="keep-iconbtn small" aria-label="Close" title="Close" onClick={onClose}>
                        <CloseIcon size={18} />
                    </button>
                </div>
                <div className="keep-dialog-body">{children}</div>
            </div>
        </div>,
        document.body,
    );
}

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
    return (
        <KeepDialog title="Keyboard shortcuts" onClose={onClose}>
            <div className="keep-kbd-grid">
                <kbd>/</kbd><span>Search notes</span>
                <kbd>c</kbd><span>New note</span>
                <kbd>r</kbd><span>Refresh from the server</span>
                <kbd>Esc</kbd><span>Close the note, a menu, or clear the search</span>
                <kbd>Enter</kbd><span>In a note: add the next item; while editing an item: save it</span>
                <kbd>?</kbd><span>This help</span>
            </div>
            <p className="keep-labels-hint">
                Inside a note, drag an item by its grip to reorder it, and drag it right or left to nest or un-nest —
                the same gestures as Púca's Tasks view.
            </p>
        </KeepDialog>
    );
}
