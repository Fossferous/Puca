import type { GameKind } from '../../api/games/protocol';
import { GAME_NAMES } from '../../api/games/gameWords';
import { CloseIcon } from '../Icons';
import { ActivityArt } from './ActivityArt';
import './Activities.css';

interface ActivityNoticeProps {
    /** Who started it (a member's name), or a stand-in the caller chose. */
    name: string;
    kind: GameKind;
    /** May take a seat here; without it the notice offers Watch only. */
    canJoin: boolean;
    onJoin: () => void;
    onWatch: () => void;
    onDismiss: () => void;
}

/**
 * "<name> started Poker - Join / Watch" (docs/GAMES.md, *Activities*): shown
 * to everyone in the call when an activity starts. A polite status line, not
 * a dialog: it takes no focus, plays no sound and blocks nothing, and it goes
 * when dismissed, acted on, or when the table ends.
 */
export function ActivityNotice({ name, kind, canJoin, onJoin, onWatch, onDismiss }: ActivityNoticeProps) {
    return (
        <div className="activity-notice" role="status" aria-live="polite">
            <ActivityArt kind={kind} />
            <span className="activity-notice-text">
                <strong>{name}</strong> started {GAME_NAMES[kind]}
            </span>
            <span className="activity-notice-actions">
                {canJoin && <button type="button" className="activity-btn activity-btn-primary" onClick={onJoin}>Join</button>}
                <button type="button" className="activity-btn" onClick={onWatch}>Watch</button>
                <button type="button" className="activity-icon-btn" aria-label="Dismiss" onClick={onDismiss}>
                    <CloseIcon />
                </button>
            </span>
        </div>
    );
}
