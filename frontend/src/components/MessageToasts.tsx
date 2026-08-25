/**
 * In-app message "shade": a stack of transient cards for messages arriving
 * while the window IS focused but the conversation is not on screen. The
 * complement of the OS notification, which fires only when the window is NOT
 * focused (desktopNotify's hasFocus gate) — the two never double up.
 *
 * A separate component from Toast: that one is a single slot keyed by seq
 * (a burst overwrites), takes only a string, and exists for copy-image
 * failures. Messages need a stack, a click target, and an optional body (DMs
 * only — channel notifications are content-free by design, E2EE).
 *
 * Portaled for the same reason Toast is: `overflow: hidden` containers and
 * the mobile sidebar's transform trap `position: fixed` children.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { setMessageToastSink, type MessageToastInput } from './messageToastBus';
import { CloseIcon } from './Icons';
import './Toast.css';

interface MessageToastItem extends MessageToastInput {
    id: number;
}

let seq = 0;

const TOAST_LIFETIME_MS = 6_000;
const MAX_STACK = 4;

export function MessageToasts() {
    const [items, setItems] = useState<MessageToastItem[]>([]);

    useEffect(() => {
        setMessageToastSink((t) => {
            const id = ++seq;
            setItems(prev => [...prev.slice(-(MAX_STACK - 1)), { ...t, id }]);
            // Timer armed at push, not at render: the stack re-renders as
            // siblings come and go and must not reset lifetimes (see Toast's
            // dismissRef note for the failure mode this avoids).
            setTimeout(() => setItems(prev => prev.filter(i => i.id !== id)), TOAST_LIFETIME_MS);
        });
        return () => setMessageToastSink(null);
    }, []);

    const drop = (id: number) => setItems(prev => prev.filter(i => i.id !== id));

    if (items.length === 0) return null;
    return createPortal(
        <div className="message-toasts">
            {items.map(i => (
                <div
                    key={i.id}
                    className="message-toast"
                    role="status"
                    aria-live="polite"
                    onClick={() => { i.onClick?.(); drop(i.id); }}
                >
                    <div className="message-toast-text">
                        <span className="message-toast-title">{i.title}</span>
                        {i.body && <span className="message-toast-body">{i.body}</span>}
                    </div>
                    <button
                        className="app-toast-close"
                        aria-label="Dismiss"
                        onClick={(e) => { e.stopPropagation(); drop(i.id); }}
                    >
                        <CloseIcon />
                    </button>
                </div>
            ))}
        </div>,
        document.body,
    );
}
