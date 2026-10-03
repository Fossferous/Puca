import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { GameKind } from '../../api/games/protocol';
import { GAME_NAMES } from '../../api/games/gameWords';
import { ACTIVITY_BLURB, ACTIVITY_KINDS, playingLabel } from '../../api/games/activities';
import { CloseIcon, RocketIcon } from '../Icons';
import { ActivityArt } from './ActivityArt';
import './Activities.css';

interface ActivityPickerProps {
    /** A bottom sheet on a phone, a centred panel on a desktop. */
    isPhone: boolean;
    channelName: string;
    /** The call's running activity, if any (one per call). */
    running: { kind: GameKind; playing: number } | null;
    /** May take a seat (CONNECT + PLAY_GAMES here). */
    canJoin: boolean;
    /** Already seated at the running one. */
    seated: boolean;
    onStart: (kind: GameKind) => void;
    onJoin: () => void;
    onWatch: () => void;
    onClose: () => void;
}

/**
 * The Activities picker (docs/GAMES.md, *Activities*): what the launcher in
 * the call's controls opens. Poker and Blackjack as cards; picking one starts
 * it for everyone in the call. One activity per call, so while one runs its
 * card offers Join (or Open, or Watch) and the other says why it waits.
 * Portaled to <body> in the modal band (z 1100, DESIGN_PHILOSOPHY §1).
 *
 * A real modal for the keyboard too (it says aria-modal): focus moves to the
 * first card it can act on when it opens, Tab and Shift+Tab stay inside, and
 * focus goes back to whatever opened it (the launcher) when it closes.
 */
export function ActivityPicker({ isPhone, channelName, running, canJoin, seated, onStart, onJoin, onWatch, onClose }: ActivityPickerProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    // Focus in on open, back out on close (mount / unmount only).
    useEffect(() => {
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const first = dialogRef.current?.querySelector<HTMLElement>('.activity-card:not(:disabled)')
            ?? focusablesIn(dialogRef.current)[0];
        first?.focus();
        return () => { if (opener && opener.isConnected) opener.focus(); };
    }, []);
    const trapTab = (e: ReactKeyboardEvent) => {
        if (e.key !== 'Tab') return;
        const els = focusablesIn(dialogRef.current);
        if (els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        const at = document.activeElement;
        if (e.shiftKey ? (at === first || !dialogRef.current?.contains(at)) : (at === last || !dialogRef.current?.contains(at))) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
        }
    };

    return createPortal(
        <div className="activity-scrim" onClick={onClose}>
            <div
                ref={dialogRef}
                className={`activity-picker${isPhone ? ' activity-sheet' : ''}`}
                role="dialog"
                aria-modal="true"
                aria-label="Activities"
                onClick={e => e.stopPropagation()}
                onKeyDown={trapTab}
            >
                <div className="activity-picker-head">
                    <span className="activity-picker-icon"><RocketIcon /></span>
                    <div className="activity-picker-titles">
                        <h3 className="activity-picker-title">Activities</h3>
                        <span className="activity-picker-sub">Play together in {channelName}</span>
                    </div>
                    <button type="button" className="activity-icon-btn" aria-label="Close" onClick={onClose}>
                        <CloseIcon />
                    </button>
                </div>
                <div className="activity-cards">
                    {ACTIVITY_KINDS.map(kind => {
                        const isRunning = running?.kind === kind;
                        const blocked = running !== null && !isRunning;
                        return (
                            <div key={kind} className={`activity-card-wrap${isRunning ? ' activity-running' : ''}`}>
                                <button
                                    type="button"
                                    className="activity-card"
                                    data-kind={kind}
                                    disabled={blocked}
                                    onClick={() => {
                                        if (isRunning) {
                                            if (seated) onWatch();
                                            else if (canJoin) onJoin();
                                            else onWatch();
                                        } else onStart(kind);
                                    }}
                                >
                                    <ActivityArt kind={kind} />
                                    <span className="activity-card-text">
                                        <strong className="activity-card-name">{GAME_NAMES[kind]}</strong>
                                        <span className="activity-card-blurb">
                                            {isRunning ? `Running · ${playingLabel(running.playing)}` : ACTIVITY_BLURB[kind]}
                                        </span>
                                    </span>
                                    {!isRunning && !blocked && <span className="activity-card-go">Start</span>}
                                </button>
                                {isRunning && (
                                    <div className="activity-card-actions">
                                        {seated ? (
                                            <button type="button" className="activity-btn activity-btn-primary" onClick={onWatch}>Open</button>
                                        ) : (
                                            <>
                                                {canJoin && <button type="button" className="activity-btn activity-btn-primary" onClick={onJoin}>Join</button>}
                                                <button type="button" className="activity-btn" onClick={onWatch}>Watch</button>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                {running && (
                    <p className="activity-picker-note">
                        {GAME_NAMES[running.kind]} is running in this call. One activity at a time.
                    </p>
                )}
                <p className="activity-picker-fine">Chips are free and worth nothing. This server deals the cards.</p>
            </div>
        </div>,
        document.body,
    );
}

/** The controls Tab can reach inside `root`, in document order. */
function focusablesIn(root: HTMLElement | null): HTMLElement[] {
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])')];
}
