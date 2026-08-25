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

interface StreamPipProps {
    onExpand: () => void;
    onClose: () => void;
    /** Which stream (if any) is popped out into the OS picture-in-picture
     *  window, and the toggle for it. Optional: absent → no control. */
    poppedStream?: number | null;
    onTogglePopout?: (userId: number) => void;
}

export function StreamPip({ onExpand, onClose, poppedStream = null, onTogglePopout }: StreamPipProps) {
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
            className="stream-pip"
            style={{
                left: position.x,
                top: position.y,
                width: size.width,
                height: size.height,
            }}
            onMouseDown={handleMouseDown}
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
                    {onTogglePopout && pipSupported() && (
                        <button
                            className={`pip-btn ${poppedStream === primaryUserId ? 'active' : ''}`}
                            onClick={() => onTogglePopout(primaryUserId)}
                            title={poppedStream === primaryUserId
                                ? 'Bring back from picture-in-picture'
                                : 'Pop out (stays on top when Puca is tabbed out)'}
                        >
                            <PopOutIcon />
                        </button>
                    )}
                    <button className="pip-btn" onClick={onExpand} title="Expand">
                        <FullscreenIcon />
                    </button>
                    <button className="pip-btn close" onClick={onClose} title="Close">
                        <CloseIcon />
                    </button>
                </div>
            </div>

            {/* Video — NOT hard-muted: PiP is the only audio path while the full
                stream view is closed (muted/volume driven by the effect above). */}
            <video
                ref={videoRef}
                autoPlay
                playsInline
                className="pip-video"
            />

            {/* Resize handle */}
            <div
                className="pip-resize-handle"
                onMouseDown={handleResizeMouseDown}
            />

            {/* Stream count badge */}
            {selectedStreams.length > 1 && (
                <div className="pip-stream-count">
                    +{selectedStreams.length - 1} more
                </div>
            )}
        </div>
    );
}
