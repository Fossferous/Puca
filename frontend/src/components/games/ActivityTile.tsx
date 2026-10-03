import type { GameKind } from '../../api/games/protocol';
import { GAME_NAMES } from '../../api/games/gameWords';
import { playingLabel } from '../../api/games/activities';
import { ActivityArt } from './ActivityArt';
import './Activities.css';

export interface ActivityTileProps {
    kind: GameKind;
    /** How many are seated. */
    playing: number;
    /** This person is seated at it. */
    seated: boolean;
    /** May take a seat (CONNECT + PLAY_GAMES here). */
    canJoin: boolean;
    /** Open the table view (the tile itself). */
    onOpen: () => void;
    onJoin: () => void;
    onWatch: () => void;
}

/**
 * The running activity as a tile in the call's grid (VoiceStage), beside the
 * people - Discord's activity tile. The tile opens the table; Join seats you,
 * Watch opens it as a spectator; a seated player gets Open.
 */
export function ActivityTile({ kind, playing, seated, canJoin, onOpen, onJoin, onWatch }: ActivityTileProps) {
    return (
        <div className="voice-stage-tile activity-tile" data-kind={kind}>
            <button type="button" className="activity-tile-body" onClick={onOpen} aria-label={`Open ${GAME_NAMES[kind]}`}>
                <ActivityArt kind={kind} />
                <span className="activity-tile-name">{GAME_NAMES[kind]}</span>
                <span className="activity-tile-count">{seated ? `${playingLabel(playing)}, you included` : playingLabel(playing)}</span>
            </button>
            <span className="activity-tile-actions">
                {seated ? (
                    <button type="button" className="activity-btn activity-btn-primary" onClick={onOpen}>Open</button>
                ) : (
                    <>
                        {canJoin && <button type="button" className="activity-btn activity-btn-primary" onClick={onJoin}>Join</button>}
                        <button type="button" className="activity-btn" onClick={onWatch}>Watch</button>
                    </>
                )}
            </span>
        </div>
    );
}
