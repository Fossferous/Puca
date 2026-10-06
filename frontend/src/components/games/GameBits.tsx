import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useCountdown } from './useCountdown';
import { MinusIcon, PlusIcon } from '../Icons';
import { SmartAvatar } from '../SmartAvatar';

/** The 30 s turn clock: a bar and the seconds left. */
export function TurnClock({ ms, receivedAt, totalSecs, compact = false }: {
    ms: number | null;
    receivedAt: number;
    totalSecs: number;
    compact?: boolean;
}) {
    const left = useCountdown(ms, receivedAt);
    if (left === null) return null;
    const secs = Math.ceil(left / 1000);
    const frac = Math.max(0, Math.min(1, left / Math.max(1, totalSecs * 1000)));
    return (
        <span
            className={`gclock${compact ? ' gclock-compact' : ''}${secs <= 5 ? ' gclock-low' : ''}`}
            role="timer"
            aria-label={`${secs} seconds left`}
        >
            <span className="gclock-bar"><span className="gclock-fill" style={{ width: `${frac * 100}%` }} /></span>
            {!compact && <span className="gclock-secs">{secs}s</span>}
        </span>
    );
}

/** A seat's avatar: the member's picture (SmartAvatar: authenticated, frozen
 *  unless they speak, hidden if the viewer hid it), else their initial. */
export function SeatAvatar({ name, userId, fileId }: { name: string; userId?: number; fileId?: string | null }) {
    const letter = (name.trim()[0] ?? '?').toUpperCase();
    return (
        <span className="gseat-avatar" aria-hidden="true">
            {userId !== undefined && fileId
                ? <SmartAvatar userId={userId} fileId={fileId} className="gseat-avatar-img" fallback={letter} />
                : letter}
        </span>
    );
}

/** A − amount + stepper. The amount itself is a control the caller supplies
 *  (an inline input on desktop, a button that opens the sheet on a phone). */
export function Stepper({ onDown, onUp, downDisabled, upDisabled, label, children }: {
    onDown: () => void;
    onUp: () => void;
    downDisabled: boolean;
    upDisabled: boolean;
    /** What is being stepped, for the buttons' names ("raise", "bet"). */
    label: string;
    children: ReactNode;
}) {
    return (
        <span className="gstepper">
            <button type="button" className="games-btn gstep" onClick={onDown} disabled={downDisabled} aria-label={`Lower the ${label}`}>
                <MinusIcon />
            </button>
            {children}
            <button type="button" className="games-btn gstep" onClick={onUp} disabled={upDisabled} aria-label={`Raise the ${label}`}>
                <PlusIcon />
            </button>
        </span>
    );
}

/**
 * The phone's amount sheet. The numeric field opens the soft keyboard, which
 * shrinks the visual viewport over the action bar, so the sheet is pinned to
 * the bottom of the VISUAL viewport (window.visualViewport): it rides up with
 * the keyboard and the field and its confirm stay in view (GAMES.md, *Phone*).
 * Portaled to <body> (DESIGN_PHILOSOPHY §6: a fixed element inside a
 * transformed panel is trapped in the panel's box).
 */
export function AmountSheet({ title, value, min, max, step, presets, confirmLabel, onConfirm, onClose }: {
    title: string;
    value: number;
    min: number;
    max: number;
    step: number;
    presets: { label: string; amount: number }[];
    confirmLabel: (amount: number) => string;
    onConfirm: (amount: number) => void;
    onClose: () => void;
}) {
    const [text, setText] = useState(String(value));
    const [bottom, setBottom] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    useLayoutEffect(() => {
        const vv = window.visualViewport;
        if (!vv) return;
        const place = () => {
            // The strip of the layout viewport the keyboard covers.
            setBottom(Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)));
        };
        place();
        vv.addEventListener('resize', place);
        vv.addEventListener('scroll', place);
        return () => {
            vv.removeEventListener('resize', place);
            vv.removeEventListener('scroll', place);
        };
    }, []);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const parsed = Math.floor(Number(text));
    const amount = Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : min;
    const set = (n: number) => setText(String(Math.max(min, Math.min(max, n))));

    return createPortal(
        <div className="games-sheet-scrim" onClick={onClose}>
            <div
                className="games-sheet"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                style={{ bottom }}
                onClick={e => e.stopPropagation()}
            >
                <div className="games-sheet-title">{title}</div>
                <div className="games-sheet-presets">
                    {presets.map(p => (
                        <button key={p.label} type="button" className="games-btn games-btn-ghost" onClick={() => set(p.amount)}>
                            {p.label}
                        </button>
                    ))}
                </div>
                <Stepper
                    label={title.toLowerCase()}
                    onDown={() => set(amount - step)}
                    onUp={() => set(amount + step)}
                    downDisabled={amount <= min}
                    upDisabled={amount >= max}
                >
                    <input
                        ref={inputRef}
                        className="games-amount-input"
                        type="number"
                        inputMode="numeric"
                        min={min}
                        max={max}
                        step={step}
                        value={text}
                        aria-label={title}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') onConfirm(amount); }}
                    />
                </Stepper>
                <div className="games-sheet-actions">
                    <button type="button" className="games-btn games-btn-ghost" onClick={onClose}>Cancel</button>
                    <button type="button" className="games-btn games-btn-primary" onClick={() => onConfirm(amount)}>
                        {confirmLabel(amount)}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
