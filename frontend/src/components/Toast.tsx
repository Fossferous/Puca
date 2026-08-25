/**
 * A transient message, portaled to <body>.
 *
 * There was no toast anywhere in the app, and the existing transient notice
 * (`.search-jump-notice`) renders INSIDE the search dropdown, so it can only be
 * seen while that dropdown is open. Copy-image failures happen from a context
 * menu that has already closed, with nothing on screen to attach a message to.
 *
 * Portaled for the same reason ImageLightbox is: messages render inside
 * containers that are `overflow: hidden`, and the mobile sidebar carries a CSS
 * transform, which traps `position: fixed` children inside it.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './Icons';
import './Toast.css';

interface ToastProps {
    message: string;
    onDismiss: () => void;
    /** Milliseconds before it clears itself. */
    duration?: number;
}

export function Toast({ message, onDismiss, duration = 5000 }: ToastProps) {
    // The callback is held in a ref and kept OUT of the effect deps.
    //
    // Callers pass an inline arrow (`onDismiss={() => setToast(null)}`), so its
    // identity changes on every parent render. With it in the deps, the effect
    // tore down and re-armed the timer on each one — and Chat re-renders once a
    // second regardless of traffic, because its typing-cleanup interval calls
    // `setTypingUsers(prev => new Map(prev))`, always a new Map, so React never
    // bails out. The result was a "transient" notice that never expired: the
    // 5s timer was reset every 1s, forever.
    const dismissRef = useRef(onDismiss);
    useEffect(() => { dismissRef.current = onDismiss; });

    useEffect(() => {
        const t = setTimeout(() => dismissRef.current(), duration);
        return () => clearTimeout(t);
    }, [message, duration]);

    return createPortal(
        <div className="app-toast" role="status" aria-live="polite">
            <span className="app-toast-text">{message}</span>
            <button className="app-toast-close" onClick={onDismiss} aria-label="Dismiss"><CloseIcon /></button>
        </div>,
        document.body,
    );
}
