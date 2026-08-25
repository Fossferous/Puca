import { useEffect, useRef, useState } from 'react';
import {
    getVoiceUsersInRoom,
    globalCameraUsers,
    globalCameraStreams,
    isUserSpeaking,
    isUserStreaming,
    subscribeToVoiceUsers,
    subscribeToStreamState,
} from './voiceState';
import { SmartAvatar } from './SmartAvatar';
import { MicOffIcon, HeadphonesOffIcon, SpeakerIcon, UserAddIcon, PlayIcon, CameraIcon, LockOpenIcon, ClipIcon } from './Icons';
import { mediaE2eeExplanation } from '../api/rtc/e2eeStatus';
import './VoiceStage.css';
import { installBackgroundResumeAll } from './deviceStageResume';

interface VoiceStageProps {
    roomId: string;
    channelName: string;
    currentUserId: number;
    /** userId -> avatar_file_id, from the server member list (may miss users
     *  when the voice channel belongs to a server we're not looking at —
     *  tiles then fall back to initials, same as the sidebar). */
    memberAvatars: Map<number, string | null>;
    /** userId -> preferred display name */
    memberNames: Map<number, string>;
    onBackToChat: () => void;
    /** Start watching a participant's live screen share. */
    onWatchStream: (userId: number) => void;
    /** Open the server invite modal (absent when the voice channel's server
     *  isn't the one currently open). */
    onInvite?: () => void;
    /** Open the standard user context menu (volume, profile, …). */
    onUserMenu?: (user: { userId: number; username: string }, pos: { x: number; y: number }) => void;
}

/** Binds a live camera MediaStream to a <video> — srcObject can't be set
 *  declaratively. `muted` is load-bearing: the sender's mic audio already
 *  plays through the per-user <audio> elements, so an unmuted tile would
 *  double the mic and bypass deafen. Rendered per-user inside a keyed tile so
 *  re-renders never remount it (a reparented <video> pauses and paints black —
 *  see StreamStage's stable-geometry comment). */
function TileCameraVideo({ stream, mirrored }: { stream: MediaStream; mirrored: boolean }) {
    const ref = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (el && el.srcObject !== stream) {
            el.srcObject = stream;
            // autoplay is not reliable when srcObject lands after mount —
            // kick playback explicitly (muted video is always allowed).
            void el.play().catch(() => { /* transient; retried on next bind */ });
        }
    }, [stream]);
    // Android/iOS pause the tile when the app backgrounds and never un-pause
    // it; the bind effect only acts on stream identity. One listener per
    // tile, removed with it. Same fix as the stages (deviceStageResume.ts).
    useEffect(() => installBackgroundResumeAll(() => [ref.current]), []);
    return (
        <video
            ref={ref}
            className={`vs-camera-video${mirrored ? ' mirrored' : ''}`}
            autoPlay
            playsInline
            muted
        />
    );
}

/**
 * Voice view for the main content area: one tile per person in
 * the room. Shown when clicking the voice channel you're already connected to
 * (media pipes stay in VoicePanel — this is presentation only, so mounting or
 * leaving it never touches the call).
 */
export function VoiceStage({
    roomId,
    channelName,
    currentUserId,
    memberAvatars,
    memberNames,
    onBackToChat,
    onWatchStream,
    onInvite,
    onUserMenu,
}: VoiceStageProps) {
    // Presence/speaking/stream state lives in module-level maps; re-render on
    // change events plus a light poll (VAD speaking flips don't always emit).
    const [, force] = useState(0);
    useEffect(() => {
        const bump = () => force(n => n + 1);
        const unsubVoice = subscribeToVoiceUsers(bump);
        const unsubStream = subscribeToStreamState(bump);
        const interval = setInterval(bump, 300);
        return () => { unsubVoice(); unsubStream(); clearInterval(interval); };
    }, []);

    const users = getVoiceUsersInRoom(roomId);

    return (
        <div className="voice-stage">
            <div className="voice-stage-header">
                <div className="voice-stage-title">
                    <span className="voice-stage-icon"><SpeakerIcon /></span>
                    <span className="voice-stage-name">{channelName}</span>
                    <span className="voice-stage-count">
                        {users.length} {users.length === 1 ? 'person' : 'people'}
                    </span>
                </div>
                <div className="voice-stage-controls">
                    {onInvite && (
                        <button className="voice-stage-btn" onClick={onInvite} title="Invite people to this server">
                            <UserAddIcon /> Invite
                        </button>
                    )}
                    <button className="voice-stage-btn" onClick={onBackToChat}>
                        ← Back to Chat
                    </button>
                </div>
            </div>

            <div className="voice-stage-body">
                <div className="voice-stage-grid" data-count={Math.min(users.length, 6)}>
                    {users.map(user => {
                        const speaking = isUserSpeaking(user.id);
                        const streaming = isUserStreaming(user.id);
                        const cameraOn = globalCameraUsers.has(user.id);
                        const camStream = globalCameraStreams.get(user.id);
                        const avatarId = memberAvatars.get(user.id);
                        const name = memberNames.get(user.id) || user.username;
                        return (
                            <div
                                key={user.id}
                                className={`voice-stage-tile ${speaking ? 'speaking' : ''}`}
                                onClick={(e) => onUserMenu?.(
                                    { userId: user.id, username: user.username },
                                    { x: e.clientX, y: e.clientY },
                                )}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    onUserMenu?.(
                                        { userId: user.id, username: user.username },
                                        { x: e.clientX, y: e.clientY },
                                    );
                                }}
                            >
                                {/* Camera feed fills the tile when live; the
                                    avatar is the fallback. Rendered FIRST so
                                    the absolute overlays (badge/chip/button)
                                    stack above it by DOM order. */}
                                {camStream ? (
                                    <TileCameraVideo
                                        stream={camStream}
                                        mirrored={user.id === currentUserId}
                                    />
                                ) : (
                                    <div className={`vs-avatar ${speaking ? 'speaking' : ''}`}>
                                        <SmartAvatar
                                            userId={user.id}
                                            fileId={avatarId}
                                            fallback={<span>{name[0]?.toUpperCase()}</span>}
                                        />
                                    </div>
                                )}
                                {streaming && <span className="vs-live-badge">LIVE</span>}
                                {streaming && user.id !== currentUserId && (
                                    <button
                                        className="vs-watch-btn"
                                        onClick={(e) => { e.stopPropagation(); onWatchStream(user.id); }}
                                    >
                                        <PlayIcon /> Watch stream
                                    </button>
                                )}
                                <div className="vs-name-chip">
                                    {user.isBuffering && <span title="Clip buffer on" aria-label="Clip buffer on"><ClipIcon size={14} className="vs-chip-icon buffering" /></span>}
                                    {user.isMuted && <MicOffIcon size={14} className="vs-chip-icon muted" />}
                                    {user.isDeafened && <HeadphonesOffIcon size={14} className="vs-chip-icon muted" />}
                                    <span className="vs-chip-name">
                                        {name}{user.id === currentUserId ? ' (you)' : ''}
                                    </span>
                                    {/* Chip only while the feed hasn't arrived
                                        yet (subscription in flight) — once the
                                        video renders it says it all. */}
                                    {cameraOn && !camStream && <span className="vs-chip-cam" title="Camera on"><CameraIcon /></span>}
                                    {/* They're in the channel but their media
                                        isn't reachable yet — the join chime is
                                        being held for this too. */}
                                    {user.connecting && (
                                        <span className="vs-chip-connecting" title={mediaE2eeExplanation('negotiating', name) ?? ''}>
                                            <LockOpenIcon />
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>

                {users.length <= 1 && (
                    <div className="voice-stage-solo">
                        <p>It's quiet in here…</p>
                        {onInvite && (
                            <button className="voice-stage-btn solo-invite" onClick={onInvite}>
                                <UserAddIcon /> Invite to Voice
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
