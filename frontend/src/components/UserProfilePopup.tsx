import { useState, useEffect, useRef } from 'react';
import { listRoles, assignRole, removeRole, kickMember, banMember, type Role, type MemberWithRoles } from '../api/servers';
import { startDMConversation, type DMConversation } from '../api/dms';
import { getFriendshipStatus, sendFriendRequest, removeFriend, acceptFriendRequest, type FriendshipStatus } from '../api/friends';
import { getCachedPublicKey } from '../api/dms';
import { getVerificationState, type VerificationState } from '../api/keyVerification';
import { SafetyNumberModal } from './SafetyNumberModal';
import {
    CrownIcon, MessageIcon, ShieldCheckIcon, WarningIcon,
    UserAddIcon, UserRemoveIcon, UserCheckIcon, PendingIcon, GavelIcon,
} from './Icons';
import './UserProfilePopup.css';

interface UserProfilePopupProps {
    member: MemberWithRoles;
    serverId: string;
    isOwner: boolean;
    currentUserId: number;
    position: { x: number; y: number };
    onClose: () => void;
    onRolesUpdated: () => void;
    onStartDM: (conversation: DMConversation) => void;
}

export function UserProfilePopup({
    member,
    serverId,
    isOwner,
    currentUserId,
    position,
    onClose,
    onRolesUpdated,
    onStartDM,
}: UserProfilePopupProps) {
    const [allRoles, setAllRoles] = useState<Role[]>([]);
    const [memberRoleIds, setMemberRoleIds] = useState<Set<number>>(new Set());
    const [isLoading, setIsLoading] = useState(true);
    const [isUpdating, setIsUpdating] = useState<number | null>(null);
    const [isStartingDM, setIsStartingDM] = useState(false);
    const [friendStatus, setFriendStatus] = useState<FriendshipStatus | null>(null);
    const [isFriendActionPending, setIsFriendActionPending] = useState(false);
    const [showVerify, setShowVerify] = useState(false);
    const [verifyState, setVerifyState] = useState<VerificationState>('unverified');
    const popupRef = useRef<HTMLDivElement>(null);

    // Close on click outside
    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
                onClose();
            }
        }

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    // Load all roles
    useEffect(() => {
        async function loadRoles() {
            setIsLoading(true);
            try {
                const roles = await listRoles(serverId);
                // Sort by position (higher first)
                setAllRoles(roles.sort((a, b) => b.position - a.position));

                // Set current member's roles
                const currentIds = new Set(member.roles.map(r => r.id));
                setMemberRoleIds(currentIds);
            } catch (err) {
                console.error('Failed to load roles:', err);
            } finally {
                setIsLoading(false);
            }
        }
        loadRoles();
    }, [serverId, member]);

    // Load friendship status
    useEffect(() => {
        if (member.id !== currentUserId) {
            getFriendshipStatus(member.id)
                .then(setFriendStatus)
                .catch(err => console.error('Failed to get friendship status:', err));
        }
    }, [member.id, currentUserId]);

    // Load encryption-key verification state (re-checks after the modal closes).
    useEffect(() => {
        if (member.id === currentUserId) return;
        let cancelled = false;
        getCachedPublicKey(member.id)
            .then((key) => { if (!cancelled) setVerifyState(getVerificationState(member.id, key)); })
            .catch(() => { /* leave as unverified */ });
        return () => { cancelled = true; };
    }, [member.id, currentUserId, showVerify]);

    const handleToggleRole = async (role: Role) => {
        if (!isOwner || role.name === 'Owner' || role.is_default) return;

        // Optimistic: flip the checkbox immediately, revert if the server rejects.
        const hadRole = memberRoleIds.has(role.id);
        setMemberRoleIds(prev => {
            const newSet = new Set(prev);
            if (hadRole) newSet.delete(role.id); else newSet.add(role.id);
            return newSet;
        });

        setIsUpdating(role.id);
        try {
            if (hadRole) {
                await removeRole(serverId, member.id, role.id);
            } else {
                await assignRole(serverId, member.id, role.id);
            }
            onRolesUpdated();
        } catch (err) {
            console.error('Failed to update role:', err);
            // Revert the optimistic flip.
            setMemberRoleIds(prev => {
                const newSet = new Set(prev);
                if (hadRole) newSet.add(role.id); else newSet.delete(role.id);
                return newSet;
            });
        } finally {
            setIsUpdating(null);
        }
    };

    // Calculate popup position to stay within viewport.
    // Open to the LEFT of the click point: the member sidebar sits on the right,
    // so opening rightward would cover it and intercept clicks on other members.
    const calculatePosition = () => {
        const popupWidth = 320;
        const popupHeight = 400;
        const margin = 16;

        // Prefer just to the left of the click; if that runs off the left edge,
        // fall back to just right of the click (clamped into the viewport).
        let x = position.x - popupWidth - 12;
        if (x < margin) {
            x = Math.min(position.x + 12, window.innerWidth - popupWidth - margin);
            if (x < margin) x = margin;
        }

        let y = position.y;
        if (y + popupHeight > window.innerHeight - margin) {
            y = window.innerHeight - popupHeight - margin;
        }
        if (y < margin) {
            y = margin;
        }

        return { left: x, top: y };
    };

    const popupPosition = calculatePosition();

    return (
        <div
            ref={popupRef}
            className="user-profile-popup"
            style={popupPosition}
        >
            {/* User Header */}
            <div className="profile-header" style={{ borderColor: member.top_role_color }}>
                <div className="profile-avatar" style={{ borderColor: member.top_role_color }}>
                    {(member.display_name || member.username)[0]?.toUpperCase()}
                </div>
                <div className="profile-info">
                    <h3 style={{ color: member.top_role_color }}>
                        {member.is_owner && <span className="owner-badge"><CrownIcon /></span>}
                        {member.display_name || member.username}
                    </h3>
                    {member.display_name && (
                        <span className="profile-username">@{member.username}</span>
                    )}
                    <span className={`status-indicator ${member.is_online ? 'online' : 'offline'}`}>
                        {member.is_online ? 'Online' : 'Offline'}
                    </span>
                </div>
            </div>

            {/* Action Buttons (not for self) */}
            {member.id !== currentUserId && (
                <div className="profile-section profile-actions">
                    <button
                        className="send-dm-btn"
                        onClick={async () => {
                            setIsStartingDM(true);
                            try {
                                const conversation = await startDMConversation(member.id);
                                onStartDM(conversation);
                                onClose();
                            } catch (err) {
                                console.error('Failed to start DM:', err);
                            } finally {
                                setIsStartingDM(false);
                            }
                        }}
                        disabled={isStartingDM}
                    >
                        {isStartingDM ? 'Opening...' : <><MessageIcon /> Message</>}
                    </button>

                    {/* Verify encryption keys (out-of-band safety number) */}
                    <button
                        className={`verify-btn ${verifyState}`}
                        onClick={() => setShowVerify(true)}
                        title="Compare a safety number to confirm no one is intercepting your encryption"
                    >
                        {verifyState === 'verified' ? <><ShieldCheckIcon /> Verified</>
                            : verifyState === 'changed' ? <><WarningIcon /> Key changed — re-verify</>
                            : <><ShieldCheckIcon /> Verify encryption</>}
                    </button>

                    {/* Friend Button */}
                    {friendStatus && (
                        <button
                            className={`friend-btn ${friendStatus.is_friend ? 'remove' : friendStatus.request_sent ? 'pending' : friendStatus.request_received ? 'accept' : 'add'}`}
                            onClick={async () => {
                                setIsFriendActionPending(true);
                                try {
                                    if (friendStatus.is_friend) {
                                        await removeFriend(member.id);
                                        setFriendStatus({ ...friendStatus, is_friend: false });
                                    } else if (friendStatus.request_received && friendStatus.request_id) {
                                        await acceptFriendRequest(friendStatus.request_id);
                                        setFriendStatus({ ...friendStatus, is_friend: true, request_received: false });
                                    } else if (!friendStatus.request_sent) {
                                        await sendFriendRequest(member.id);
                                        setFriendStatus({ ...friendStatus, request_sent: true });
                                    }
                                } catch (err) {
                                    console.error('Friend action failed:', err);
                                } finally {
                                    setIsFriendActionPending(false);
                                }
                            }}
                            disabled={isFriendActionPending || friendStatus.request_sent}
                        >
                            {isFriendActionPending ? '...' :
                                friendStatus.is_friend ? <><UserRemoveIcon /> Remove Friend</> :
                                    friendStatus.request_sent ? <><PendingIcon /> Request Sent</> :
                                        friendStatus.request_received ? <><UserCheckIcon /> Accept Request</> :
                                            <><UserAddIcon /> Add Friend</>}
                        </button>
                    )}

                    {/* Kick/Ban Buttons (for owners, not on owner) */}
                    {isOwner && !member.is_owner && (
                        <>
                            <button
                                className="kick-btn"
                                onClick={async () => {
                                    if (!confirm(`Kick ${member.username} from the server?`)) return;
                                    try {
                                        await kickMember(serverId, member.id);
                                        onRolesUpdated(); // Refresh member list
                                        onClose();
                                    } catch (err) {
                                        alert(`Failed to kick: ${err instanceof Error ? err.message : 'Unknown error'}`);
                                    }
                                }}
                            >
                                <UserRemoveIcon /> Kick
                            </button>
                            <button
                                className="ban-btn"
                                onClick={async () => {
                                    const reason = prompt(`Ban ${member.username}? Enter reason (optional):`);
                                    if (reason === null) return; // Cancelled
                                    try {
                                        await banMember(serverId, member.id, reason || undefined);
                                        onRolesUpdated(); // Refresh member list
                                        onClose();
                                    } catch (err) {
                                        alert(`Failed to ban: ${err instanceof Error ? err.message : 'Unknown error'}`);
                                    }
                                }}
                            >
                                <GavelIcon /> Ban
                            </button>
                        </>
                    )}
                </div>
            )}

            {/* Current Roles */}
            <div className="profile-section">
                <h4>Roles</h4>
                <div className="current-roles">
                    {member.roles.length > 0 ? (
                        member.roles.map(role => (
                            <span
                                key={role.id}
                                className="role-tag"
                                style={{ backgroundColor: role.color + '30', color: role.color, borderColor: role.color }}
                            >
                                <span className="role-dot" style={{ backgroundColor: role.color }} />
                                {role.name}
                            </span>
                        ))
                    ) : (
                        <span className="no-roles">No roles</span>
                    )}
                </div>
            </div>

            {/* Role Assignment (for owners) */}
            {isOwner && !member.is_owner && (
                <div className="profile-section role-management">
                    <h4>Manage Roles</h4>
                    {isLoading ? (
                        <div className="loading-roles">Loading...</div>
                    ) : (
                        <div className="assignable-roles">
                            {allRoles
                                .filter(r => r.name !== 'Owner' && !r.is_default)
                                .map(role => (
                                    <label
                                        key={role.id}
                                        className={`role-checkbox ${isUpdating === role.id ? 'updating' : ''}`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={memberRoleIds.has(role.id)}
                                            onChange={() => handleToggleRole(role)}
                                            disabled={isUpdating !== null}
                                        />
                                        <span className="role-dot" style={{ backgroundColor: role.color }} />
                                        <span className="role-name">{role.name}</span>
                                        {isUpdating === role.id && <span className="updating-spinner" />}
                                    </label>
                                ))}
                            {allRoles.filter(r => r.name !== 'Owner' && !r.is_default).length === 0 && (
                                <p className="no-assignable-roles">No assignable roles. Create roles first.</p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Owner info */}
            {member.is_owner && (
                <div className="profile-section owner-notice">
                    <p><CrownIcon /> This is the server owner. Their roles cannot be modified.</p>
                </div>
            )}

            {showVerify && (
                <SafetyNumberModal
                    userId={member.id}
                    username={member.display_name || member.username}
                    onClose={() => setShowVerify(false)}
                />
            )}
        </div>
    );
}
