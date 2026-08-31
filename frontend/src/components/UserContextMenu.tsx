import { useState, useEffect, useRef } from 'react';
import { sendFriendRequest } from '../api/friends';
import { startDMConversation, type DMConversation } from '../api/dms';
import './UserContextMenu.css';
import { getLocalUserVolumes, getLocalUserMutes, setLocalUserVolume, setLocalUserMute } from './userVolumeStore';
import { isAvatarHidden, setAvatarHidden } from './avatarPrefs';
import { getCurrentStreamingUserId } from './voiceState';
import { offerControl } from '../api/remoteControl';
import { isTauri, RC_ENABLED } from '../api/platform';
import { isDeveloperMode } from './settingsStore';
import { blockUser, unblockUser } from '../api/blocking';
import { isBlocked as isUserBlocked, setBlockedLocal } from './blockStore';
import {
    SpeakerIcon,
    SpeakerOffIcon,
    GamepadIcon,
    UserIcon,
    MessageIcon,
    ImageIcon,
    UserAddIcon,
    UserCheckIcon,
    BanIcon,
    UserRemoveIcon,
    GavelIcon,
    MusicIcon,
    TagIcon,
    ChevronRightIcon,
    CopyIcon,
    DisconnectIcon,
    ForwardIcon,
    MoonIcon,
} from './Icons';

export interface UserContextMenuProps {
    userId: number;
    username: string;
    isInVoice: boolean;
    position: { x: number; y: number };
    currentUserId: number;
    canModerate?: boolean;
    availableRoles?: Array<{ id: number; name: string; color?: string }>;
    userRoleIds?: number[];
    /** Moderation: this member's uploaded join/leave clips are muted server-wide. */
    customSoundsDisabled?: boolean;
    /** Caller holds MOVE_MEMBERS: may disconnect this member from voice and
     *  move them between voice channels. Independent of `canModerate`, which
     *  gates the far heavier kick/ban. */
    canMoveMembers?: boolean;
    /** Voice channels this member could be moved INTO, already filtered by the
     *  caller (destinations they can join, excluding the one they're in). Empty
     *  hides the submenu — including the case that matters most, a member
     *  sitting in AFK, who may be disconnected but never dragged out. */
    voiceMoveTargets?: Array<{ id: number; name: string; isAfk?: boolean }>;
    onClose: () => void;
    onOpenProfile?: () => void;
    onStartDM?: (conversation: DMConversation) => void;
    onKick?: () => void;
    onBan?: () => void;
    /** Drop them out of the voice channel. No timeout, no membership change —
     *  they can rejoin at once. */
    onVoiceDisconnect?: () => void;
    onVoiceMove?: (channelId: number) => void;
    onRoleToggle?: (roleId: number, add: boolean) => void;
    onToggleCustomSounds?: (disable: boolean) => void;
}

export function UserContextMenu({
    userId,
    username,
    isInVoice,
    position,
    currentUserId,
    canModerate = false,
    availableRoles = [],
    userRoleIds = [],
    customSoundsDisabled = false,
    canMoveMembers = false,
    voiceMoveTargets = [],
    onClose,
    onOpenProfile,
    onStartDM,
    onKick,
    onBan,
    onVoiceDisconnect,
    onVoiceMove,
    onRoleToggle,
    onToggleCustomSounds,
}: UserContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [volume, setVolume] = useState(() => getLocalUserVolumes()[userId] ?? 100);
    const [isMuted, setIsMuted] = useState(() => getLocalUserMutes()[userId] ?? false);
    const [avatarHidden, setAvatarHiddenState] = useState(() => isAvatarHidden(userId));
    const [showRolesSubmenu, setShowRolesSubmenu] = useState(false);
    const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
    const [friendRequestStatus, setFriendRequestStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
    const [blockStatus, setBlockStatus] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
    const [blocked, setBlocked] = useState(() => isUserBlocked(userId));

    // Developer mode, from the typed settings field (with legacy-key fallback).
    const devMode = isDeveloperMode();

    // Adjust menu position to stay on screen
    const [adjustedPosition, setAdjustedPosition] = useState(position);

    useEffect(() => {
        if (menuRef.current) {
            const rect = menuRef.current.getBoundingClientRect();
            let x = position.x;
            let y = position.y;

            if (x + rect.width > window.innerWidth) {
                x = window.innerWidth - rect.width - 10;
            }
            if (y + rect.height > window.innerHeight) {
                y = window.innerHeight - rect.height - 10;
            }

            // eslint-disable-next-line react-hooks/set-state-in-effect -- reposition after measuring the rendered menu
            setAdjustedPosition({ x, y });
        }
    }, [position]);

    // Close on click outside
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };

        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [onClose]);

    const handleVolumeChange = (newVolume: number) => {
        setVolume(newVolume);
        setLocalUserVolume(userId, newVolume);
    };

    const handleMuteToggle = () => {
        const newMuted = !isMuted;
        setIsMuted(newMuted);
        setLocalUserMute(userId, newMuted);
    };

    const handleAddFriend = async () => {
        setFriendRequestStatus('sending');
        try {
            await sendFriendRequest(userId);
            setFriendRequestStatus('sent');
        } catch {
            setFriendRequestStatus('error');
        }
    };

    const handleMessage = async () => {
        try {
            const conversation = await startDMConversation(userId);
            onStartDM?.(conversation);
            onClose();
        } catch (err) {
            console.error('Failed to start DM:', err);
        }
    };

    const handleCopyId = () => {
        navigator.clipboard.writeText(userId.toString());
        onClose();
    };

    const handleBlock = async () => {
        // Blocking cuts DMs both ways, hides their messages, and mutes their
        // voice on this device. Reversible right here (or in Settings →
        // Privacy & Safety), but confirm — a misclick silently breaks
        // messaging with that person.
        if (!window.confirm(`Block ${username}? They won't be able to message you, `
            + `their messages will be hidden and their voice muted. `
            + `You can unblock them from this menu or Settings → Privacy & Safety.`)) return;
        setBlockStatus('working');
        try {
            await blockUser(userId);
            setBlockedLocal(userId, true); // also mutes their voice locally
            setBlocked(true);
            setBlockStatus('done');
            setTimeout(onClose, 600);
        } catch (err) {
            console.error('Failed to block user:', err);
            setBlockStatus('error');
        }
    };

    const handleUnblock = async () => {
        setBlockStatus('working');
        try {
            await unblockUser(userId);
            setBlockedLocal(userId, false); // also lifts the local voice mute
            setBlocked(false);
            setBlockStatus('done');
            setTimeout(onClose, 600);
        } catch (err) {
            console.error('Failed to unblock user:', err);
            setBlockStatus('error');
        }
    };

    const isSelf = userId === currentUserId;

    return (
        <div
            ref={menuRef}
            className="user-context-menu"
            style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
        >
            {/* Voice Controls - only if user is in voice and not self */}
            {isInVoice && !isSelf && (
                <div className="context-section">
                    <div className="context-section-header">Voice</div>
                    <div className="volume-control">
                        <label>User Volume</label>
                        <div className="volume-slider-row">
                            <input
                                type="range"
                                min="0"
                                max="200"
                                value={volume}
                                onChange={(e) => handleVolumeChange(parseInt(e.target.value))}
                            />
                            <span className="volume-value">{volume}%</span>
                        </div>
                    </div>
                    <button
                        className={`context-item ${isMuted ? 'active' : ''}`}
                        onClick={handleMuteToggle}
                    >
                        <span className="context-icon">{isMuted ? <SpeakerOffIcon /> : <SpeakerIcon />}</span>
                        {isMuted ? 'Unmute' : 'Mute'}
                    </button>
                    {/* Offer control of my screen — only while I'm sharing on desktop,
                        and only in a build that HAS remote control. */}
                    {RC_ENABLED && isTauri() && getCurrentStreamingUserId() === currentUserId && (
                        <button
                            className="context-item"
                            onClick={() => { offerControl(userId, username); onClose(); }}
                        >
                            <span className="context-icon"><GamepadIcon /></span>
                            Give screen control
                        </button>
                    )}

                    {/* Voice moderation (MOVE_MEMBERS). Lives HERE, in the Voice
                        section, rather than under Moderation: these act on the
                        call, change nothing about their membership, and must not
                        be read as a relative of Kick/Ban one section down.

                        This is also the only path to either action on a phone —
                        the sidebar drag is pointer-driven. */}
                    {canMoveMembers && (
                        <>
                            {voiceMoveTargets.length > 0 && (
                                <div className="context-submenu-wrapper">
                                    <button
                                        className="context-item has-submenu"
                                        onClick={() => setShowMoveSubmenu(!showMoveSubmenu)}
                                    >
                                        <span className="context-icon"><ForwardIcon /></span>
                                        Move to
                                        <span className="submenu-arrow"><ChevronRightIcon /></span>
                                    </button>
                                    {showMoveSubmenu && (
                                        <div className="context-submenu">
                                            {voiceMoveTargets.map(ch => (
                                                <button
                                                    key={ch.id}
                                                    className="context-item"
                                                    onClick={() => { onVoiceMove?.(ch.id); onClose(); }}
                                                >
                                                    <span className="context-icon">
                                                        {ch.isAfk ? <MoonIcon /> : <SpeakerIcon />}
                                                    </span>
                                                    {ch.name}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                            <button
                                className="context-item danger"
                                title="Drops them out of the call. No timeout — they can rejoin straight away."
                                onClick={() => { onVoiceDisconnect?.(); onClose(); }}
                            >
                                <span className="context-icon"><DisconnectIcon /></span>
                                Disconnect from voice
                            </button>
                        </>
                    )}
                </div>
            )}

            {/* General Actions */}
            <div className="context-section">
                {!isSelf && (
                    <>
                        <button className="context-item" onClick={() => { onOpenProfile?.(); onClose(); }}>
                            <span className="context-icon"><UserIcon /></span>
                            Profile
                        </button>
                        <button className="context-item" onClick={handleMessage}>
                            <span className="context-icon"><MessageIcon /></span>
                            Message
                        </button>
                        <button
                            className="context-item"
                            title="Local only — replaces their picture with initials on this device"
                            onClick={() => { setAvatarHidden(userId, !avatarHidden); setAvatarHiddenState(!avatarHidden); }}
                        >
                            <span className="context-icon"><ImageIcon /></span>
                            {avatarHidden ? 'Show Profile Picture' : 'Hide Profile Picture'}
                        </button>
                        <button
                            className={`context-item ${friendRequestStatus === 'sent' ? 'success' : ''}`}
                            onClick={handleAddFriend}
                            disabled={friendRequestStatus === 'sending' || friendRequestStatus === 'sent'}
                        >
                            <span className="context-icon"><UserAddIcon /></span>
                            {friendRequestStatus === 'sent' ? 'Request Sent!' :
                                friendRequestStatus === 'sending' ? 'Sending...' :
                                    friendRequestStatus === 'error' ? 'Failed' : 'Add Friend'}
                        </button>
                        {blocked ? (
                            <button
                                className="context-item"
                                onClick={handleUnblock}
                                disabled={blockStatus === 'working' || blockStatus === 'done'}
                            >
                                <span className="context-icon"><UserCheckIcon /></span>
                                {blockStatus === 'done' ? 'Unblocked' :
                                    blockStatus === 'working' ? 'Unblocking…' :
                                        blockStatus === 'error' ? 'Unblock failed — retry' : `Unblock ${username}`}
                            </button>
                        ) : (
                            <button
                                className="context-item danger"
                                onClick={handleBlock}
                                disabled={blockStatus === 'working' || blockStatus === 'done'}
                            >
                                <span className="context-icon"><BanIcon /></span>
                                {blockStatus === 'done' ? 'Blocked' :
                                    blockStatus === 'working' ? 'Blocking…' :
                                        blockStatus === 'error' ? 'Block failed — retry' : `Block ${username}`}
                            </button>
                        )}
                    </>
                )}
            </div>

            {/* Moderation - only if user can moderate and not self */}
            {canModerate && !isSelf && (
                <div className="context-section">
                    <div className="context-section-header">Moderation</div>
                    {/* "from server", explicitly. Opened from the voice list this
                        button sits inches below "Disconnect from voice", and a
                        bare "Kick" there reads as the voice action — which is
                        what it was mistaken for: it removes their membership. */}
                    <button className="context-item danger" onClick={() => { onKick?.(); onClose(); }}>
                        <span className="context-icon"><UserRemoveIcon /></span>
                        Kick {username} from server
                    </button>
                    <button className="context-item danger" onClick={() => { onBan?.(); onClose(); }}>
                        <span className="context-icon"><GavelIcon /></span>
                        Ban {username}
                    </button>
                    {onToggleCustomSounds && (
                        <button
                            className="context-item"
                            title="Server-wide: everyone hears the default chime for this member instead of their uploaded clips"
                            onClick={() => { onToggleCustomSounds(!customSoundsDisabled); onClose(); }}
                        >
                            <span className="context-icon"><MusicIcon /></span>
                            {customSoundsDisabled ? 'Enable custom sounds' : 'Disable custom sounds'}
                        </button>
                    )}

                    {/* Roles Submenu */}
                    {availableRoles.length > 0 && (
                        <div className="context-submenu-wrapper">
                            <button
                                className="context-item has-submenu"
                                onClick={() => setShowRolesSubmenu(!showRolesSubmenu)}
                            >
                                <span className="context-icon"><TagIcon /></span>
                                Roles
                                <span className="submenu-arrow"><ChevronRightIcon /></span>
                            </button>
                            {showRolesSubmenu && (
                                <div className="context-submenu">
                                    {availableRoles.map(role => (
                                        <label key={role.id} className="role-checkbox">
                                            <input
                                                type="checkbox"
                                                checked={userRoleIds.includes(role.id)}
                                                onChange={(e) => onRoleToggle?.(role.id, e.target.checked)}
                                            />
                                            <span
                                                className="role-name"
                                                style={{ color: role.color || '#cdd6f4' }}
                                            >
                                                {role.name}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Developer - only in dev mode */}
            {devMode && (
                <div className="context-section">
                    <button className="context-item" onClick={handleCopyId}>
                        <span className="context-icon"><CopyIcon /></span>
                        Copy ID
                    </button>
                </div>
            )}
        </div>
    );
}
