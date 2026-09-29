/**
 * A small centred dialog (shortcuts help, confirmations, the .ics import).
 * Portaled to body; Escape closes it and stops there, like Popover.
 *
 * SHARED: it was notes/components/NotesDialog.tsx until the .ics import
 * became one of Púca's own calendar actions. Its class names are unchanged —
 * the Notes walks name them — and its rules travel with it, because Púca
 * never loads notes.css.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLayerOnScreen, usePortalTarget } from './portalTarget';
import './NotesDialog.css';
import { CloseIcon } from './Icons';

/**
 * The dialogs listening for Escape, by the order they opened. Stacked — the
 * shortcuts help over a paste question — each listens on the document in the
 * capture phase, and stopPropagation never stops another listener on the
 * same node, so one Escape closed both. It is the newest one's.
 */
let opened = 0;
const listening = new Set<number>();
/**
 * Which dialog each Escape is for, taken by the first of them to hear it,
 * before any has closed. A real key press ends every listener in a microtask
 * checkpoint, where React commits the top one's onClose — its cleanup
 * leaving `listening` too — before the next listener runs; asked again
 * there, the one below would find itself on top and close as well.
 */
const escapeFor = new WeakMap<Event, number>();

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
    /**
     * A request this dialog started is in flight: every way OUT is inert —
     * Escape, the backdrop and the X — and Escape still does not reach the
     * layer underneath. A confirm step mid-request must not be dismissable:
     * closing does not cancel the request, so reopening and confirming again
     * would do the thing twice, and "the thing" can be posting a chat
     * message, which cannot be unsent.
     */
    busy?: boolean;
    /**
     * Keys typed anywhere in it are its own, never a command behind it
     * (hotkeys.ts's isEditableTarget): for a dialog that took the focus off
     * a field, where those keys were typing (PastedLinesDialog).
     */
    ownsKeys?: boolean;
}

export function NotesDialog({ title, onClose, children, escapeBlocked = false, busy = false, ownsKeys = false }: NotesDialogProps) {
    const portalTarget = usePortalTarget();
    const onScreen = useLayerOnScreen();
    // Taken once, as it opens: the listener below re-binds with its props,
    // and re-joining then would lift an older dialog over a newer one.
    const order = useRef(0);
    useEffect(() => { order.current = ++opened; }, []);
    useEffect(() => {
        // Hidden with Notes in the desktop app: not our key (portalTarget.ts).
        if (!onScreen) return;
        const me = order.current;
        listening.add(me);
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            let top = escapeFor.get(e);
            if (top === undefined) {
                top = Math.max(...listening);
                escapeFor.set(e, top);
            }
            if (me !== top || escapeBlocked) return;
            if (busy) { e.preventDefault(); e.stopPropagation(); return; }
            e.preventDefault();
            e.stopPropagation();
            onClose();
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
            listening.delete(me);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [onClose, escapeBlocked, busy, onScreen]);
    return createPortal(
        <div className="notes-dialog-backdrop" onClick={busy ? undefined : onClose}>
            <div
                className="notes-dialog" role="dialog" aria-modal="true" aria-label={title} data-owns-keys={ownsKeys ? '' : undefined}
                onClick={e => e.stopPropagation()}
            >
                <div className="notes-dialog-head">
                    <h3>{title}</h3>
                    <button type="button" className="notes-iconbtn small" aria-label="Close" title="Close" disabled={busy} onClick={onClose}>
                        <CloseIcon size={18} />
                    </button>
                </div>
                <div className="notes-dialog-body">{children}</div>
            </div>
        </div>,
        portalTarget,
    );
}

