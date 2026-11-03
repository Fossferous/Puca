import { CloseIcon, SlidersIcon } from '../Icons';
import type { ServerModes } from '../../api/serverModes';
import { offersCallBack } from './modeMenu';
import './Modes.css';

interface ModeSelectorProps {
    data: ServerModes | undefined;
    /** The server row's value: pushed live, so it beats a fetch in flight. */
    activeModeId: number | null;
    /** The active mode's main voice channel when Call everyone back can reach it. */
    homeName: string | null;
    /** Open the menu at this place, just under the selector, which it gives the focus back to. */
    onOpen: (at: { x: number; y: number }, opener: HTMLElement) => void;
}

/**
 * The line under the server's name that says which mode is on. For someone the
 * menu has anything for it is a button that opens it; for everyone else it is a
 * plain label while a mode is on, and nothing when none is.
 */
export function ModeSelector({ data, activeModeId, homeName, onOpen }: ModeSelectorProps) {
    if (!data || data.modes.length === 0) return null;
    const active = data.modes.find(m => m.id === activeModeId) ?? null;
    const canUseMenu = data.can_switch || data.can_edit || offersCallBack(data, activeModeId, homeName);
    if (!active && !canUseMenu) return null;
    const label = (
        <>
            <span className="mode-selector-icon" aria-hidden="true"><SlidersIcon /></span>
            <span className="mode-selector-text">
                <span className="mode-selector-kicker">Mode</span>
                <span className="mode-selector-name">{active ? active.name : 'Off'}</span>
            </span>
        </>
    );
    if (!canUseMenu) {
        return <div className="mode-selector mode-selector-label" data-testid="mode-label">{label}</div>;
    }
    return (
        <button
            type="button"
            className={`mode-selector ${active ? 'mode-selector-on' : ''}`}
            data-testid="mode-selector"
            aria-haspopup="menu"
            onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                onOpen({ x: box.left, y: box.bottom + 4 }, e.currentTarget);
            }}
        >
            {label}
        </button>
    );
}

interface ModeNoticeProps {
    modeName: string;
    /** Set when this notice is about a server not on screen. */
    otherServerName: string | null;
    /** The main voice channel, when Join can go there. */
    joinName: string | null;
    onJoin: () => void;
    onOpenServer: () => void;
    onDismiss: () => void;
}

/**
 * "<mode> is on - Join <channel>": shown when a mode starts. A polite status
 * line, the activity notice's shape: it takes no focus, plays no sound and blocks
 * nothing, and it goes when dismissed, acted on, or when the mode ends.
 */
export function ModeNotice({ modeName, otherServerName, joinName, onJoin, onOpenServer, onDismiss }: ModeNoticeProps) {
    return (
        <div className="mode-notice" role="status" aria-live="polite" data-testid="mode-notice">
            <span className="mode-notice-icon" aria-hidden="true"><SlidersIcon /></span>
            <span className="mode-notice-text">
                <strong>{modeName}</strong> is on{otherServerName ? ` in ${otherServerName}` : ''}
            </span>
            <span className="mode-notice-actions">
                {otherServerName !== null ? (
                    <button type="button" className="mode-notice-btn mode-notice-primary" onClick={onOpenServer}>Open</button>
                ) : joinName !== null && (
                    <button type="button" className="mode-notice-btn mode-notice-primary" onClick={onJoin}>Join {joinName}</button>
                )}
                <button type="button" className="mode-notice-close" aria-label="Dismiss" onClick={onDismiss}>
                    <CloseIcon />
                </button>
            </span>
        </div>
    );
}
