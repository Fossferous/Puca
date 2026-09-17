/**
 * "Note deleted — UNDO": the snackbar that makes destructive actions
 * reversible for a few seconds. Portaled to body (fixed, above the drawer's
 * transform). The OWNER decides what expiry means: for a delete, that is
 * when the DELETE actually goes to the server.
 *
 * The timer is armed once per `token` and reads the LATEST onExpire through a
 * ref, so the owner may pass a fresh closure every render without the
 * countdown restarting.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export const UNDO_WINDOW_MS = 6_000;

interface UndoBarProps {
    message: string;
    onUndo: () => void;
    onExpire: () => void;
    /** Changes when a new action replaces the pending one (restarts the timer). */
    token: number;
}

export function UndoBar({ message, onUndo, onExpire, token }: UndoBarProps) {
    const expireRef = useRef(onExpire);
    useEffect(() => { expireRef.current = onExpire; });
    useEffect(() => {
        const id = window.setTimeout(() => expireRef.current(), UNDO_WINDOW_MS);
        return () => window.clearTimeout(id);
    }, [token]);
    return createPortal(
        <div className="keep-undo" role="status" aria-live="polite">
            <span className="keep-undo-text">{message}</span>
            <button type="button" className="keep-textbtn" onClick={onUndo}>Undo</button>
        </div>,
        document.body,
    );
}
