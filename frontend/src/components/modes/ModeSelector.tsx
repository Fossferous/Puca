import type { ContextMenuItem } from '../ContextMenu';
import { CloseIcon, SlidersIcon } from '../Icons';
import type { ServerMode, ServerModes } from '../../api/serverModes';
import './Modes.css';

interface ModeSelectorProps {
    data: ServerModes | undefined;
    /** The server row's value: pushed live, so it beats a fetch in flight. */
    activeModeId: number | null;
    /** Open the menu at this place, just under the selector. */
    onOpen: (at: { x: number; y: number }) => void;
}

/**
 * The line under the server's name that says which mode is on. For someone who
 * may switch it is a button that opens the menu; for everyone else it is a plain
 * label while a mode is on, and nothing when none is.
 */
export function ModeSelector({ data, activeModeId, onOpen }: ModeSelectorProps) {
    if (!data || data.modes.length === 0) return null;
    const active = data.modes.find(m => m.id === activeModeId) ?? null;
    const canUseMenu = data.can_switch || data.can_edit;
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
                onOpen({ x: box.left, y: box.bottom + 4 });
            }}
        >
            {label}
        </button>
    );
}

interface ModeMenuOptions {
    data: ServerModes;
    activeModeId: number | null;
    /** The active mode's main voice channel when Call everyone back can reach it. */
    homeName: string | null;
    onSwitch: (modeId: number | null) => void;
    onCallBack: () => void;
    onManage: () => void;
}

/** What the selector's menu offers this reader. */
export function modeMenuItems({ data, activeModeId, homeName, onSwitch, onCallBack, onManage }: ModeMenuOptions): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    if (data.can_switch) {
        items.push({
            id: 'mode-off',
            label: 'Off',
            icon: activeModeId === null ? 'check' : undefined,
            onClick: () => onSwitch(null),
        });
        for (const mode of data.modes) {
            items.push({
                id: `mode-${mode.id}`,
                label: mode.name,
                icon: activeModeId === mode.id ? 'check' : undefined,
                onClick: () => onSwitch(mode.id),
            });
        }
    }
    const callBack = activeModeId !== null && data.can_call_back && homeName !== null;
    if (callBack || data.can_edit) {
        if (items.length > 0) items.push({ id: 'mode-separator', label: '', separator: true });
    }
    if (callBack) {
        items.push({ id: 'mode-call-back', label: `Call everyone to ${homeName}`, icon: 'megaphone', onClick: onCallBack });
    }
    if (data.can_edit) {
        items.push({ id: 'mode-manage', label: 'Manage modes', icon: 'settings', onClick: onManage });
    }
    return items;
}

/** The sentence a switch's warning says, or null when nobody would be cut off. */
export function endedCallsWarning(mode: ServerMode | null | undefined, people: number): string | null {
    if (people <= 0) return null;
    const who = people === 1 ? '1 person' : `${people} people`;
    const verb = people === 1 ? 'is' : 'are';
    return `${who} ${verb} in the voice channels of ${mode?.name ?? 'this mode'}. They will be disconnected.`;
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
