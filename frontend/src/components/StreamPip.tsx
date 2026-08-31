import { useState, useEffect, useRef } from 'react';
import {
    subscribeToStreamState,
    getSelectedStreams,
    getStreamData,
    getCurrentStreamingUserId,
} from './voiceState';
import {
    getStreamVolumes,
    getStreamMutes,
    DEFAULT_STREAM_VOLUME,
} from './streamVolumeStore';
import {
    requestControl,
    stopControlling,
    subscribeControl,
    getControlState,
    type ControlState,
} from '../api/remoteControl';
import {
    CloseIcon, FullscreenIcon, GamepadIcon, LiveDotIcon, PendingIcon, PopOutIcon, StopIcon,
} from './Icons';
import './StreamPip.css';
import { installBackgroundResumeAll } from './deviceStageResume';
import { pipSupported } from './streamPopout.utils';
import { docPipSupported } from './streamDocPip';

interface StreamPipProps {
    onExpand: () => void;
    onClose: () => void;
    /** Mobile: render as a DOCKED strip (an in-flow flex child of .chat-main,
     *  pinned under the chat header) instead of a floating draggable box. The
     *  floating box is a desktop paradigm — its drag/resize are mouse-only and
     *  its spawn position assumes a desktop-sized window — so on a phone it
     *  sat immovably on top of the composer and voice bar. Docked, the video
     *  reserves its own row and messages + composer lay out BELOW it. */
    docked?: boolean;
    /** Docked close = stop watching (deselect every stream). The floating
     *  close's setShowPip(false) is wrong there: with streams still selected
     *  the auto-switch effect in Chat.tsx immediately reopens the FULL stage —
     *  on a phone that's "the close button fullscreens the thing I tried to
     *  dismiss". */
    onStopWatching?: () => void;
    /** Which streams are popped out (Doc-PiP grid: several; legacy engines:
     *  at most one), and the toggle. Optional: absent → no control. */
    poppedStreams?: number[];
    onTogglePopout?: (userId: number) => void;
    /** Keep the element (it is the chat-view AUDIO path) but show nothing —
     *  the Doc-PiP grid is on screen and a second visible copy is noise.
     *  visibility, not display: a display:none <video> can pause playback. */
    hidden?: boolean;
}

export function StreamPip({ onExpand, onClose, docked = false, onStopWatching, poppedStreams = [], onTogglePopout, hidden = false }: StreamPipProps) {
    const [selectedStreams, setSelectedStreams] = useState<number[]>([]);
    const [position, setPosition] = useState({ x: window.innerWidth - 420, y: window.innerHeight - 280 });
    const [size, setSize] = useState({ width: 400, height: 250 });
    const [isDragging, setIsDragging] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [control, setControl] = useState<ControlState>(getControlState);
    const videoRef = useRef<HTMLVideoElement>(null);
    const pipRef = useRef<HTMLDivElement>(null);

    useEffect(() => subscribeControl(setControl), []);

    // Subscribe to stream state
    useEffect(() => {
        const update = () => {
            const streams = getSelectedStreams();
            setSelectedStreams(streams);

            // If no streams, close PiP
            if (streams.length === 0) {
                onClose();
            }
        };
        update();
        return subscribeToStreamState(update);
    }, [onClose]);

    // Attach stream to video
    useEffect(() => {
        if (selectedStreams.length > 0 && videoRef.current) {
            const userId = selectedStreams[0]; // Show first selected stream
            const data = getStreamData(userId);
            if (data?.stream && videoRef.current.srcObject !== data.stream) {
                videoRef.current.srcObject = data.stream;
                videoRef.current.play().catch(err => console.warn('PiP video play failed:', err));
            }
        }
    }, [selectedStreams]);

    // Android/iOS pause the <video> when the app backgrounds and never
    // un-pause it; the bind effect above only acts on stream identity, so a
    // returned PiP froze on its last frame. Same fix as the stages.
    useEffect(() => installBackgroundResumeAll(() => [videoRef.current]), []);

    // PiP owns stream-audio playback while it's up: StreamStage (the Web Audio
    // gain graph) is UNMOUNTED in chat view — before this, PiP viewers had NO
    // audio path at all (video hard-muted + no graph = silent game audio every
    // time you tabbed back to chat). StreamStage and PiP never render
    // simultaneously (viewMode), so this can't double up. Element audio only —
    // volume caps at 100% here; boost/attenuation live in the full stream view.
    // Deafen does not reach here on purpose (see StreamStage's graph comment):
    // per-stream mute is the way to silence a stream.
    useEffect(() => {
        const video = videoRef.current;
        if (!video || selectedStreams.length === 0) return;
        const userId = selectedStreams[0];
        const own = userId === getCurrentStreamingUserId();
        const muted = own || !!getStreamMutes()[userId];
        video.muted = muted;
        video.volume = Math.min(Math.max((getStreamVolumes()[userId] ?? DEFAULT_STREAM_VOLUME) / 100, 0), 1);
    }, [selectedStreams]);

    // Handle dragging
    const handleMouseDown = (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('.pip-resize-handle')) return;
        setIsDragging(true);
        setDragOffset({
            x: e.clientX - position.x,
            y: e.clientY - position.y,
        });
    };

    // Handle resizing
    const handleResizeMouseDown = (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsResizing(true);
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isDragging) {
                const newX = Math.max(0, Math.min(e.clientX - dragOffset.x, window.innerWidth - size.width));
                const newY = Math.max(0, Math.min(e.clientY - dragOffset.y, window.innerHeight - size.height));
                setPosition({ x: newX, y: newY });
            } else if (isResizing && pipRef.current) {
                const newWidth = Math.max(200, Math.min(800, e.clientX - position.x));
                const newHeight = Math.max(120, Math.min(600, e.clientY - position.y));
                setSize({ width: newWidth, height: newHeight });
            }
        };

        const handleMouseUp = () => {
            setIsDragging(false);
            setIsResizing(false);
        };

        if (isDragging || isResizing) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            return () => {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };
        }
    }, [isDragging, isResizing, dragOffset, position, size]);

    if (selectedStreams.length === 0) return null;

    const primaryUserId = selectedStreams[0];
    const primaryData = getStreamData(primaryUserId);

    return (
        <div
            ref={pipRef}
            className={`stream-pip${docked ? ' docked' : ''}`}
            // Docked: no inline geometry at all — StreamPip.css's .docked rules
            // size it (in-flow, aspect-ratio). Inline left/top/width/height
            // would win over any stylesheet and drag the desktop float's stale
            // coordinates onto the phone layout.
            style={docked
                ? (hidden ? { visibility: 'hidden' as const } : undefined)
                : {
                    left: position.x,
                    top: position.y,
                    width: size.width,
                    height: size.height,
                    ...(hidden ? { visibility: 'hidden' as const } : {}),
                }}
            onMouseDown={docked ? undefined : handleMouseDown}
        >
            {/* Header with controls */}
            <div className="pip-header">
                <span className="pip-live"><LiveDotIcon /> LIVE</span>
                <span className="pip-streamer">{primaryData?.username || 'Stream'}</span>
                <div className="pip-controls">
                    {/* Remote control from PiP: requesting expands to the full
                        stream view (the input-capture overlay lives there). */}
                    {primaryUserId !== getCurrentStreamingUserId() && (() => {
                        const mine = control.controlling?.userId === primaryUserId ? control.controlling : null;
                        if (mine?.status === 'active') {
                            return (
                                <button className="pip-btn" onClick={stopControlling} title="Stop controlling this screen">
                                    <StopIcon />
                                </button>
                            );
                        }
                        if (mine?.status === 'requesting') {
                            return (
                                <button className="pip-btn" disabled title="Waiting for approval…">
                                    <PendingIcon />
                                </button>
                            );
                        }
                        return (
                            <button
                                className="pip-btn"
                                disabled={!!control.controlling}
                                onClick={() => {
                                    requestControl(primaryUserId, primaryData?.username ?? `User ${primaryUserId}`);
                                    onExpand();
                                }}
                                title="Request control of this screen"
                            >
                                <GamepadIcon />
                            </button>
                        );
                    })()}
                    {/* OS-level picture-in-picture: stays on top when
                        Puca is tabbed out. Only where the API exists. */}
                    {onTogglePopout && (pipSupported() || docPipSupported()) && (
                        <button
                            className={`pip-btn ${poppedStreams.includes(primaryUserId) ? 'active' : ''}`}
                            onClick={() => onTogglePopout(primaryUserId)}
                            title={poppedStreams.includes(primaryUserId)
                                ? 'Bring back from picture-in-picture'
                                : 'Pop out (stays on top when Puca is tabbed out)'}
                        >
                            <PopOutIcon />
                        </button>
                    )}
                    <button className="pip-btn" onClick={onExpand} title="Expand" aria-label="Expand to full view">
                        <FullscreenIcon />
                    </button>
                    <button
                        className="pip-btn close"
                        onClick={docked ? (onStopWatching ?? onClose) : onClose}
                        title={docked ? 'Stop watching' : 'Close'}
                        aria-label={docked ? 'Stop watching' : 'Close'}
                    >
                        <CloseIcon />
                    </button>
                </div>
            </div>

            {/* Video — NOT hard-muted: PiP is the only audio path while the full
                stream view is closed (muted/volume driven by the effect above).
                Docked, the video itself is the big tap target for "expand". */}
            <video
                ref={videoRef}
                autoPlay
                playsInline
                className="pip-video"
                onClick={docked ? onExpand : undefined}
            />

            {/* Resize handle — floating mode only (mouse-driven) */}
            {!docked && (
                <div
                    className="pip-resize-handle"
                    onMouseDown={handleResizeMouseDown}
                />
            )}

            {/* Stream count badge */}
            {selectedStreams.length > 1 && (
                <div className="pip-stream-count">
                    +{selectedStreams.length - 1} more
                </div>
            )}
        </div>
    );
}
