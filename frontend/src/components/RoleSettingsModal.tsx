import { useState, useEffect } from 'react';
import { listRoles, createRole, updateRole, deleteRole, listMembersWithRoles, type Role } from '../api/servers';
import { PERMISSIONS } from '../api/permissionBits';
import { getToken, decodeJwtPayload } from '../api/auth';
import { CloseIcon, CrownIcon } from './Icons';
import './RoleSettingsModal.css';

interface RoleSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    serverId: string;
    serverName: string;
    isOwner: boolean;
    /** Render just the list+editor panels (no overlay/header) so this can sit
     *  inside another surface — ServerSettingsModal's Roles tab uses this. */
    embedded?: boolean;
}

// A checkbox here is a PROMISE that toggling it changes what a member can do.
// Three bits are absent from this list because the features they claimed to
// govern do not exist anywhere in this codebase (audited 2026-08-10, each
// verified independently):
//
//   USE_EXTERNAL_EMOJIS — there is no cross-server emoji feature at all; the
//                         picker is a static unicode set and list_emojis is
//                         membership-scoped to the current server.
//   DEAFEN_MEMBERS      — "deafen" is SELF-deafen only (a local audio toggle
//                         announced as an opaque status ping); nothing can
//                         force-deafen another user.
//   PRIORITY_SPEAKER    — no priority/ducking-by-role feature exists.
//   EMBED_LINKS         — link previews are generated LOCALLY by each viewer
//                         (api/linkPreview.ts) from the message text; the
//                         sender's bit cannot govern what a viewer renders.
//   USE_VOICE_ACTIVITY  — push-to-talk vs voice activity is a local capture
//                         decision the server never observes (audited
//                         2026-09-02; both bits stay defined, see below).
//
// The bits stay DEFINED in src/permissions.rs (removing them would let the
// numbers be reused and silently re-interpret stored role rows) — they are just
// no longer offered as settings that do nothing.
//
// MOVE_MEMBERS was on that list until voice moderation shipped. It now gates
// POST /servers/:id/voice-move/:user (moderation_handlers::move_member_voice) —
// dragging someone between voice channels and disconnecting them from voice —
// so it is a real setting again and belongs back in the editor.
const PERMISSION_CATEGORIES = [
    {
        name: 'General Permissions',
        permissions: [
            { key: 'VIEW_CHANNEL', label: 'View Channels', desc: 'See channels and read messages' },
            // Honoured at the upload door (the client names the channel it is
            // attaching to; content is E2EE so that is the only place it can be).
            { key: 'ATTACH_FILES', label: 'Attach Files', desc: 'Upload images and files to messages and checklists' },
            { key: 'ADD_REACTIONS', label: 'Add Reactions', desc: 'React to messages with emoji' },
        ],
    },
    {
        name: 'Text Permissions',
        permissions: [
            { key: 'SEND_MESSAGES', label: 'Send Messages', desc: 'Send messages in text channels' },
            { key: 'READ_MESSAGE_HISTORY', label: 'Read Message History', desc: 'View past messages' },
            { key: 'MANAGE_MESSAGES', label: 'Manage Messages', desc: 'Delete and pin messages' },
        ],
    },
    {
        name: 'Tasks Permissions',
        permissions: [
            { key: 'CREATE_TASKS', label: 'Add Tasks', desc: 'Add new tasks in checklist channels' },
            { key: 'COMPLETE_TASKS', label: 'Complete Tasks', desc: 'Check tasks off' },
            { key: 'MANAGE_TASKS', label: 'Manage Tasks', desc: 'Edit, move, delete and check off anyone’s tasks' },
        ],
    },
    {
        name: 'Voice Permissions',
        permissions: [
            { key: 'CONNECT', label: 'Connect', desc: 'Join voice channels' },
            { key: 'SPEAK', label: 'Speak', desc: 'Talk in voice channels' },
            { key: 'VIDEO', label: 'Video', desc: 'Share video in voice channels' },
            { key: 'STREAM', label: 'Stream', desc: 'Screen share and stream' },
            { key: 'MUTE_MEMBERS', label: 'Mute Members', desc: 'Silence a member’s custom join/leave sounds' },
            { key: 'MOVE_MEMBERS', label: 'Move Members', desc: 'Drag members between voice channels and disconnect them from voice' },
            { key: 'CREATE_CLIPS', label: 'Create Clips', desc: 'Record a replay clip of a voice call — every participant must approve before it posts' },
        ],
    },
    {
        name: 'Management Permissions',
        permissions: [
            { key: 'MANAGE_CHANNELS', label: 'Manage Channels', desc: 'Create, edit, and delete channels' },
            { key: 'MANAGE_ROLES', label: 'Manage Roles', desc: 'Create and edit roles below their highest role' },
            { key: 'MANAGE_SERVER', label: 'Manage Server', desc: 'Change server name and settings' },
            { key: 'KICK_MEMBERS', label: 'Kick Members', desc: 'Remove members from the server' },
            { key: 'BAN_MEMBERS', label: 'Ban Members', desc: 'Permanently ban members' },
            { key: 'ADMINISTRATOR', label: 'Administrator', desc: 'Full access to all permissions' },
        ],
    },
];

const DEFAULT_COLORS = [
    '#99AAB5', // Default gray
    '#1ABC9C', // Teal
    '#2ECC71', // Green
    '#3498DB', // Blue
    '#9B59B6', // Purple
    '#E91E63', // Pink
    '#F1C40F', // Yellow
    '#E67E22', // Orange
    '#E74C3C', // Red
    '#95A5A6', // Gray
];

export function RoleSettingsModal({
    isOpen,
    onClose,
    serverId,
    serverName,
    isOwner,
    embedded = false,
}: RoleSettingsModalProps) {
    const [roles, setRoles] = useState<Role[]>([]);
    const [selectedRole, setSelectedRole] = useState<Role | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    // Whether the signed-in user may edit roles here. The server accepts
    // create/update/delete/assign from any MANAGE_ROLES holder (with hierarchy
    // masking) — gating every control on ownership made a permission the
    // server honors unusable from the only roles UI in the app. Owners skip
    // the lookup; everyone else is checked against their own roles.
    const [canManage, setCanManage] = useState(isOwner);

    // Editable fields for selected role
    const [editName, setEditName] = useState('');
    const [editColor, setEditColor] = useState('#99AAB5');
    const [editPermissions, setEditPermissions] = useState(0);

    // Fetch roles on open
    useEffect(() => {
        if (!isOpen) return;

        async function fetchRoles() {
            setIsLoading(true);
            setError(null);
            try {
                console.log('[RoleSettingsModal] Fetching roles for server:', serverId);
                const roleList = await listRoles(serverId);
                console.log('[RoleSettingsModal] Got roles:', roleList);
                // Sort by position (higher = more important, shown first)
                const sorted = roleList.sort((a, b) => b.position - a.position);
                setRoles(sorted);

                // Auto-select the first non-default role, or the first role
                const firstEditable = sorted.find(r => !r.is_default && r.name !== 'Owner');
                setSelectedRole(firstEditable || sorted[0] || null);
            } catch (err) {
                console.error('[RoleSettingsModal] Failed to load roles:', err);
                setError('Failed to load roles');
            } finally {
                setIsLoading(false);
            }
        }
        fetchRoles();
    }, [isOpen, serverId]);

    // Resolve MANAGE_ROLES for non-owners from their own roles in this server.
    useEffect(() => {
        setCanManage(isOwner);
        if (!isOpen || isOwner) return;
        let cancelled = false;
        (async () => {
            try {
                const token = getToken();
                const sub = token ? decodeJwtPayload(token)?.sub : null;
                if (typeof sub !== 'number') return;
                // The backend's user_has_permission ORs the @everyone role's
                // bits into everyone's permissions, but members-with-roles only
                // lists ASSIGNED roles — a member whose MANAGE_ROLES comes from
                // @everyone is server-accepted, so the UI must count it too.
                const [members, roleList] = await Promise.all([
                    listMembersWithRoles(serverId),
                    listRoles(serverId),
                ]);
                const mine = members.find(m => m.id === sub);
                const everyoneBits = roleList
                    .filter(r => r.is_default)
                    .reduce((acc, r) => acc | r.permissions, 0);
                const bits = (mine?.roles ?? []).reduce((acc, r) => acc | r.permissions, everyoneBits);
                if (!cancelled && (bits & (PERMISSIONS.MANAGE_ROLES | PERMISSIONS.ADMINISTRATOR)) !== 0) {
                    setCanManage(true);
                }
            } catch (err) {
                console.error('[RoleSettingsModal] MANAGE_ROLES lookup failed:', err);
            }
        })();
        return () => { cancelled = true; };
    }, [isOpen, serverId, isOwner]);

    // Update edit fields when selected role changes
    useEffect(() => {
        if (selectedRole) {
            setEditName(selectedRole.name);
            setEditColor(selectedRole.color);
            setEditPermissions(selectedRole.permissions);
        }
    }, [selectedRole]);

    const handleCreateRole = async () => {
        try {
            const newRole = await createRole(serverId, {
                name: 'New Role',
                color: '#99AAB5',
                permissions: PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.READ_MESSAGE_HISTORY,
            });
            setRoles(prev => [...prev, newRole].sort((a, b) => b.position - a.position));
            setSelectedRole(newRole);
        } catch {
            setError('Failed to create role');
        }
    };

    const handleSaveRole = async () => {
        if (!selectedRole) return;

        // Don't allow editing Owner or @everyone name
        const isProtected = selectedRole.name === 'Owner' || selectedRole.is_default;

        setIsSaving(true);
        setError(null);
        try {
            await updateRole(serverId, selectedRole.id, {
                name: isProtected ? undefined : editName,
                color: editColor,
                permissions: editPermissions,
            });

            // Update local state
            setRoles(prev =>
                prev.map(r =>
                    r.id === selectedRole.id
                        ? { ...r, name: isProtected ? r.name : editName, color: editColor, permissions: editPermissions }
                        : r
                )
            );
            setSelectedRole(prev =>
                prev ? { ...prev, name: isProtected ? prev.name : editName, color: editColor, permissions: editPermissions } : null
            );
        } catch {
            setError('Failed to save role');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDeleteRole = async () => {
        if (!selectedRole) return;

        try {
            await deleteRole(serverId, selectedRole.id);
            setRoles(prev => prev.filter(r => r.id !== selectedRole.id));
            setSelectedRole(roles.find(r => r.id !== selectedRole.id) || null);
            setShowDeleteConfirm(false);
        } catch {
            setError('Failed to delete role');
        }
    };

    const togglePermission = (permKey: string) => {
        const bit = PERMISSIONS[permKey as keyof typeof PERMISSIONS];
        if (editPermissions & bit) {
            setEditPermissions(editPermissions & ~bit);
        } else {
            setEditPermissions(editPermissions | bit);
        }
    };

    const hasPermission = (permKey: string) => {
        const bit = PERMISSIONS[permKey as keyof typeof PERMISSIONS];
        return (editPermissions & bit) !== 0;
    };

    // Check if role is protected (can't change name or delete)
    const isProtectedRole = selectedRole?.name === 'Owner' || selectedRole?.is_default;

    if (!isOpen) return null;

    const body = (
        <>
            {error && <div className="role-error">{error}</div>}

            <div className="role-modal-content">
                    {/* Left Sidebar - Role List */}
                    <div className="role-list-panel">
                        <div className="role-list-header">
                            <span>Roles — {roles.length}</span>
                        </div>

                        {isLoading ? (
                            <div className="role-loading">Loading...</div>
                        ) : (
                            <ul className="role-list">
                                {roles.map(role => (
                                    <li
                                        key={role.id}
                                        className={`role-item ${selectedRole?.id === role.id ? 'selected' : ''}`}
                                        onClick={() => setSelectedRole(role)}
                                        style={{ '--role-color': role.color } as React.CSSProperties}
                                    >
                                        <span className="role-color-dot" style={{ backgroundColor: role.color }} />
                                        <span className="role-name">{role.name}</span>
                                        {role.is_default && <span className="role-badge">Default</span>}
                                        {role.name === 'Owner' && <span className="role-badge owner"><CrownIcon /></span>}
                                    </li>
                                ))}
                            </ul>
                        )}

                        {canManage && (
                            <button className="create-role-btn" onClick={handleCreateRole}>
                                + Create Role
                            </button>
                        )}
                    </div>

                    {/* Right Panel - Role Editor */}
                    <div className="role-editor-panel">
                        {selectedRole ? (
                            <>
                                <div className="role-editor-section">
                                    <h3>Role Name</h3>
                                    <input
                                        type="text"
                                        value={editName}
                                        onChange={e => setEditName(e.target.value)}
                                        disabled={isProtectedRole || !canManage}
                                        className="role-name-input"
                                    />
                                    {isProtectedRole && (
                                        <p className="role-hint">This role's name cannot be changed.</p>
                                    )}
                                </div>

                                <div className="role-editor-section">
                                    <h3>Role Color</h3>
                                    <div className="color-picker">
                                        {DEFAULT_COLORS.map(color => (
                                            <button
                                                key={color}
                                                className={`color-swatch ${editColor === color ? 'selected' : ''}`}
                                                style={{ backgroundColor: color }}
                                                onClick={() => setEditColor(color)}
                                                disabled={!canManage}
                                            />
                                        ))}
                                        <input
                                            type="color"
                                            value={editColor}
                                            onChange={e => setEditColor(e.target.value)}
                                            className="color-custom"
                                            disabled={!canManage}
                                            title="Custom color"
                                        />
                                    </div>
                                </div>

                                <div className="role-editor-section permissions-section">
                                    <h3>Permissions</h3>

                                    {PERMISSION_CATEGORIES.map(category => (
                                        <div key={category.name} className="permission-category">
                                            <h4>{category.name}</h4>
                                            <div className="permission-list">
                                                {category.permissions.map(perm => (
                                                    <label key={perm.key} className="permission-item">
                                                        <input
                                                            type="checkbox"
                                                            checked={hasPermission(perm.key)}
                                                            onChange={() => togglePermission(perm.key)}
                                                            disabled={!canManage}
                                                        />
                                                        <div className="permission-info">
                                                            <span className="permission-label">{perm.label}</span>
                                                            <span className="permission-desc">{perm.desc}</span>
                                                        </div>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {canManage && (
                                    <div className="role-editor-actions">
                                        <button
                                            className="save-role-btn"
                                            onClick={handleSaveRole}
                                            disabled={isSaving}
                                        >
                                            {isSaving ? 'Saving...' : 'Save Changes'}
                                        </button>

                                        {!isProtectedRole && (
                                            <button
                                                className="delete-role-btn"
                                                onClick={() => setShowDeleteConfirm(true)}
                                            >
                                                Delete Role
                                            </button>
                                        )}
                                    </div>
                                )}

                                {/* Delete Confirmation */}
                                {showDeleteConfirm && (
                                    <div className="delete-confirm">
                                        <p>Are you sure you want to delete <strong>{selectedRole.name}</strong>?</p>
                                        <div className="delete-confirm-actions">
                                            <button className="cancel-btn" onClick={() => setShowDeleteConfirm(false)}>
                                                Cancel
                                            </button>
                                            <button className="confirm-delete-btn" onClick={handleDeleteRole}>
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="no-role-selected">
                                <p>Select a role to edit or create a new one.</p>
                            </div>
                        )}
                    </div>
            </div>
        </>
    );

    if (embedded) {
        return <div className="role-editor-embedded">{body}</div>;
    }

    return (
        <div className="role-modal-overlay" onClick={onClose}>
            <div className="role-modal" onClick={e => e.stopPropagation()}>
                <button className="role-modal-close" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
                <div className="role-modal-header">
                    <h2>{serverName} - Roles</h2>
                </div>
                {body}
            </div>
        </div>
    );
}
