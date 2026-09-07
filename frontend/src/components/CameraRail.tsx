/**
 * Live cameras, shown BESIDE whatever screen shares are on the stage.
 *
 * Before this, a camera existed on exactly one surface: the voice stage, which
 * is a whole view mode. Watching a share and seeing a face at the same time was
 * therefore impossible — you chose one or the other — and the request that
 * produced this file was simply "let me see the webcam alongside the stream".
 *
 * WHY A RAIL BELOW THE GRID, AND NOT TILES INSIDE IT. The stream grid's own
 * comment is emphatic and correct: every watched stream is rendered in every
 * layout, and grid-versus-focus is expressed only as class names, because a
 * <video> that is remounted OR merely reparented pauses and paints a black
 * frame over live video. Adding cells to that grid would move its tiles between
 * parents, and wrapping the grid to put a rail beside it would reparent every
 * one of them. A sibling container after the grid touches neither.
 *
 * The stage is a flex column, so this lands as a strip along the bottom — the
 * same shape as the filmstrip in focus mode, and one that survives a phone
 * without a second layout.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { CameraVideo } from './CameraVideo';
import { FullscreenIcon } from './Icons';
import {
    getAllVoiceUsers,
    globalCameraStreams,
    subscribeToStreamState,
    subscribeToVoiceUsers,
} from './voiceState';
import { sfuManager } from '../api/rtc/sfuManager';
import './CameraRail.css';

/** The rung a camera is subscribed at while it fills the display.
 *
 *  Imported lazily through the manager rather than pulling livekit-client's
 *  enum into a presentational component: this file has no other reason to
 *  depend on the SFU library, and the test would then need it mocked. */
const HIGH = 2 as const;

export function CameraRail({ currentUserId }: { currentUserId: number }) {
    // Camera presence lives in module-level maps that mutate in place, so this
    // subscribes to the same change events the voice stage does. The light poll
    // is deliberate for the same reason it is there: not every camera flip
    // emits.
    const [, force] = useState(0);
    useEffect(() => {
        const bump = () => force(n => n + 1);
        const unsubVoice = subscribeToVoiceUsers(bump);
        const unsubStream = subscribeToStreamState(bump);
        const interval = setInterval(bump, 500);
        return () => { unsubVoice(); unsubStream(); clearInterval(interval); };
    }, []);

    const pinnedRef = useRef<number | null>(null);

    /** Release whatever rung the rail is holding, whoever holds it.
     *
     *  A ref rather than state: this runs from a DOM event and from unmount,
     *  and a stale closure here would leave a camera pinned to the high rung
     *  for the rest of the call — paid for by the publisher's uplink. */
    const release = useCallback(() => {
        const held = pinnedRef.current;
        if (held === null) return;
        pinnedRef.current = null;
        try { sfuManager.setCameraQuality(held, null); } catch { /* not in an SFU call */ }
    }, []);

    // Leaving fullscreen by ANY route — Escape, the OS chrome, another element
    // taking over — must release the pin. Only entering it is under our button.
    useEffect(() => {
        const onChange = () => { if (!document.fullscreenElement) release(); };
        document.addEventListener('fullscreenchange', onChange);
        return () => {
            document.removeEventListener('fullscreenchange', onChange);
            release();
        };
    }, [release]);

    const enlarge = useCallback((userId: number, tile: HTMLElement | null) => {
        if (!tile?.requestFullscreen) return;
        // Ask for the good picture BEFORE the element fills the screen, so the
        // switch has the round trip to land rather than resolving visibly.
        if (userId !== currentUserId) {
            pinnedRef.current = userId;
            try { sfuManager.setCameraQuality(userId, HIGH); } catch { /* mesh call, or not connected */ }
        }
        void tile.requestFullscreen().catch(() => { release(); });
    }, [currentUserId, release]);

    const cameras = [...globalCameraStreams.entries()];
    if (cameras.length === 0) return null;
    // Names come from the voice roster rather than a prop: the stage does not
    // carry a member map, and the roster is the same source the voice stage
    // labels its tiles from — one place to be wrong instead of two.
    const names = new Map(getAllVoiceUsers().map(u => [u.id, u.username]));

    return (
        <div className="camera-rail" aria-label="Cameras">
            {cameras.map(([userId, stream]) => {
                const name = names.get(userId) ?? `User ${userId}`;
                const isMe = userId === currentUserId;
                return (
                    <div className="camera-rail-tile" key={userId}>
                        <CameraVideo stream={stream} mirrored={isMe} className="camera-rail-video" />
                        <button
                            className="camera-rail-fullscreen"
                            title={`Fullscreen ${isMe ? 'your' : `${name}'s`} camera`}
                            aria-label={`Fullscreen ${isMe ? 'your' : `${name}'s`} camera`}
                            onClick={(e) => enlarge(userId, e.currentTarget.parentElement)}
                        >
                            <FullscreenIcon />
                        </button>
                        <span className="camera-rail-name">{isMe ? 'You' : name}</span>
                    </div>
                );
            })}
        </div>
    );
}
