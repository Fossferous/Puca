/**
 * An anchored popover: portaled to document.body (so no transformed
 * ancestor — the mobile drawer — can trap it), positioned under its anchor
 * and clamped to the viewport on desktop; keep.css pins it to the bottom of
 * the screen under a coarse pointer. Escape closes it and STOPS there
 * (capture phase), so the note editor's own Escape never fires for a
 * keypress meant for the popover above it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
    anchor: HTMLElement | null;
    onClose: () => void;
    label: string;
    children: ReactNode;
}

const MARGIN = 8;

export function Popover({ anchor, onClose, label, children }: PopoverProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ left: number; top: number }>({ left: MARGIN, top: MARGIN });

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const r = anchor?.getBoundingClientRect();
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = r ? r.left : (vw - w) / 2;
        let top = r ? r.bottom + 6 : (vh - h) / 2;
        // Clamp: a picker opened from a right-edge card must not hang off it.
        if (left + w > vw - MARGIN) left = Math.max(MARGIN, vw - MARGIN - w);
        if (top + h > vh - MARGIN) top = Math.max(MARGIN, (r ? r.top - h - 6 : vh - MARGIN - h));
        // eslint-disable-next-line react-hooks/set-state-in-effect -- positioning from a DOM measurement the popover cannot know before it is laid out
        setPos({ left: Math.max(MARGIN, left), top: Math.max(MARGIN, top) });
    }, [anchor]);

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
        <>
            <div className="keep-popover-backdrop" onClick={onClose} />
            <div
                ref={ref}
                className="keep-popover"
                role="dialog"
                aria-label={label}
                style={{ left: pos.left, top: pos.top }}
            >
                {children}
            </div>
        </>,
        document.body,
    );
}
