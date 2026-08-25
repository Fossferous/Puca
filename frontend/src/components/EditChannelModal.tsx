import { useState, useEffect } from 'react';
import { type Channel, updateChannel, listRoles, type Role } from '../api/servers';
import { getChannelOverwrites, putChannelOverwrite, deleteChannelOverwrite } from '../api/channels';
import { PERM, hasPerm } from '../api/permissionBits';
import { CheckIcon, CloseIcon } from './Icons';
import './Modal.css';
import './EditChannelModal.css';

interface EditChannelModalProps {
    isOpen: boolean;
    onClose: () => void;
    channel: Channel;
    onChannelUpdated: (channel: Channel) => void;
    collections?: Channel[]; // Available collections for parent selection
}

// The channel-scoped permissions editable as per-role overwrites.
const CHANNEL_PERMS: { bit: number; label: string }[] = [
    { bit: PERM.VIEW_CHANNEL, label: 'View Channel' },
    { bit: PERM.SEND_MESSAGES, label: 'Send Messages' },
    { bit: PERM.CREATE_TASKS, label: 'Add Tasks' },
    { bit: PERM.COMPLETE_TASKS, label: 'Complete Tasks' },
    { bit: PERM.MANAGE_TASKS, label: 'Manage Tasks' },
    { bit: PERM.MANAGE_MESSAGES, label: 'Manage Messages' },
    // Deny per voice channel to make it a no-clips room (docs/CLIPS.md).
    { bit: PERM.CREATE_CLIPS, label: 'Create Clips' },
];

type TriState = 'inherit' | 'allow' | 'deny';
type OverwriteMap = Record<number, { allow: number; deny: number }>;

export function EditChannelModal({ isOpen, onClose, channel, onChannelUpdated, collections = [] }: EditChannelModalProps) {
    const [activeTab, setActiveTab] = useState<'general' | 'permissions'>('general');
    const [name, setName] = useState(channel.name);
    const [description, setDescription] = useState(channel.description || '');
    const [parentId, setParentId] = useState<number | null>(channel.parent_id || null);
    const [slowmode, setSlowmode] = useState<number>(channel.slowmode_seconds || 0);
    const [isAfk, setIsAfk] = useState<boolean>(!!channel.is_afk);
    const [isChecklist, setIsChecklist] = useState<boolean>(!!channel.has_checklist);
    const [isSfu, setIsSfu] = useState<boolean>(!!channel.sfu_mode);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Permissions tab state
    const [permRoles, setPermRoles] = useState<Role[]>([]);
    const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
    const [overwrites, setOverwrites] = useState<OverwriteMap>({});
    const [savedOverwrites, setSavedOverwrites] = useState<OverwriteMap>({});
    const [permsLoaded, setPermsLoaded] = useState(false);
    const [permsLoading, setPermsLoading] = useState(false);
    const [permsSaving, setPermsSaving] = useState(false);

    // Only server channels have role overwrites, and only channel managers may
    // edit them (hasPerm falls back open when the server doesn't send bits yet).
    const canManagePerms = !!channel.server_id && hasPerm(channel.my_permissions, PERM.MANAGE_CHANNELS);

    useEffect(() => {
        if (isOpen) {
            setActiveTab('general');
            setName(channel.name);
            setDescription(channel.description || '');
            setParentId(channel.parent_id || null);
            setSlowmode(channel.slowmode_seconds || 0);
            setIsAfk(!!channel.is_afk);
            setIsChecklist(!!channel.has_checklist);
            setIsSfu(!!channel.sfu_mode);
            setError(null);
            setPermRoles([]);
            setSelectedRoleId(null);
            setOverwrites({});
            setSavedOverwrites({});
            setPermsLoaded(false);
        }
    }, [isOpen, channel]);

    // Lazy-load roles + existing overwrites the first time the tab is opened.
    useEffect(() => {
        const serverId = channel.server_id;
        if (!isOpen || activeTab !== 'permissions' || permsLoaded || !serverId) return;
        let cancelled = false;
        (async () => {
            setPermsLoading(true);
            setError(null);
            try {
                const [roleList, rows] = await Promise.all([
                    listRoles(serverId),
                    getChannelOverwrites(channel.id),
                ]);
                if (cancelled) return;
                const sorted = [...roleList].sort((a, b) => b.position - a.position);
                const map: OverwriteMap = {};
                for (const row of rows) map[row.role_id] = { allow: row.allow, deny: row.deny };
                setPermRoles(sorted);
                setOverwrites(map);
                setSavedOverwrites(map);
                setSelectedRoleId(prev => prev ?? sorted[0]?.id ?? null);
                setPermsLoaded(true);
            } catch (err) {
                console.error('Failed to load channel permissions:', err);
                if (!cancelled) setError('Failed to load channel permissions');
            } finally {
                if (!cancelled) setPermsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [isOpen, activeTab, permsLoaded, channel.id, channel.server_id]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;

        setIsLoading(true);
        setError(null);

        try {
            // AFK/SFU only apply to voice channels; checklist only to text channels.
            const nextAfk = channel.channel_type === 1 ? isAfk : false;
            const nextChecklist = channel.channel_type === 0 ? isChecklist : false;
            const nextSfu = channel.channel_type === 1 ? isSfu : false;
            await updateChannel(channel.id, {
                name: name.trim(),
                description: description.trim() || undefined,
                parent_id: parentId,
                slowmode_seconds: slowmode,
                is_afk: nextAfk,
                has_checklist: nextChecklist,
                sfu_mode: nextSfu,
            });
            onChannelUpdated({ ...channel, name: name.trim(), description: description.trim() || null, parent_id: parentId, slowmode_seconds: slowmode, is_afk: nextAfk, has_checklist: nextChecklist, sfu_mode: nextSfu });
            onClose();
        } catch (err) {
            console.error('Failed to update channel:', err);
            setError('Failed to update channel');
        } finally {
            setIsLoading(false);
        }
    };

    // --- Tri-state overwrite helpers ---

    const triFor = (roleId: number, bit: number): TriState => {
        const ov = overwrites[roleId];
        if (ov && (ov.allow & bit) !== 0) return 'allow';
        if (ov && (ov.deny & bit) !== 0) return 'deny';
        return 'inherit';
    };

    // Only touch this permission's bit — bits set by other clients (or future
    // permissions) pass through untouched, and allow/deny can never overlap.
    const setTri = (roleId: number, bit: number, state: TriState) => {
        setOverwrites(prev => {
            const cur = prev[roleId] ?? { allow: 0, deny: 0 };
            return {
                ...prev,
                [roleId]: {
                    allow: state === 'allow' ? (cur.allow | bit) : (cur.allow & ~bit),
                    deny: state === 'deny' ? (cur.deny | bit) : (cur.deny & ~bit),
                },
            };
        });
    };

    const permsDirty = permRoles.some(role => {
        const cur = overwrites[role.id] ?? { allow: 0, deny: 0 };
        const orig = savedOverwrites[role.id] ?? { allow: 0, deny: 0 };
        return cur.allow !== orig.allow || cur.deny !== orig.deny;
    });

    // Save per-role diffs: all-inherit rows are DELETEd, everything else PUT.
    const handleSavePermissions = async () => {
        setPermsSaving(true);
        setError(null);
        try {
            for (const role of permRoles) {
                const cur = overwrites[role.id] ?? { allow: 0, deny: 0 };
                const orig = savedOverwrites[role.id];
                const curEmpty = cur.allow === 0 && cur.deny === 0;
                if (curEmpty) {
                    if (orig) await deleteChannelOverwrite(channel.id, role.id);
                } else if (!orig || orig.allow !== cur.allow || orig.deny !== cur.deny) {
                    await putChannelOverwrite(channel.id, role.id, cur.allow, cur.deny);
                }
            }
            const next: OverwriteMap = {};
            for (const role of permRoles) {
                const cur = overwrites[role.id];
                if (cur && (cur.allow !== 0 || cur.deny !== 0)) next[role.id] = cur;
            }
            setOverwrites(next);
            setSavedOverwrites(next);
        } catch (err) {
            console.error('Failed to save channel permissions:', err);
            setError('Failed to save channel permissions');
        } finally {
            setPermsSaving(false);
        }
    };

    if (!isOpen) return null;

    const selectedRole = permRoles.find(r => r.id === selectedRoleId) || null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content edit-channel-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Edit Channel</h2>
                    <button className="close-button" aria-label="Close" onClick={onClose}><CloseIcon size={18} /></button>
                </div>

                {canManagePerms && (
                    <div className="edit-channel-tabs">
                        <button
                            type="button"
                            className={`edit-channel-tab ${activeTab === 'general' ? 'active' : ''}`}
                            onClick={() => setActiveTab('general')}
                        >
                            General
                        </button>
                        <button
                            type="button"
                            className={`edit-channel-tab ${activeTab === 'permissions' ? 'active' : ''}`}
                            onClick={() => setActiveTab('permissions')}
                        >
                            Permissions
                        </button>
                    </div>
                )}

                {error && <div className="error-message">{error}</div>}

                {activeTab === 'general' ? (
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="channel-name">Channel Name</label>
                        <input
                            type="text"
                            id="channel-name"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="new-channel-name"
                            maxLength={100}
                            required
                            autoFocus
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="channel-topic">Channel Topic</label>
                        <textarea
                            id="channel-topic"
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            placeholder="What is this channel about?"
                            maxLength={1024}
                            rows={3}
                        />
                    </div>

                    {/* Parent Collection Dropdown - only show for text/voice channels, not collections */}
                    {channel.channel_type !== 2 && collections.length > 0 && (
                        <div className="form-group">
                            <label htmlFor="channel-parent">Parent Collection</label>
                            <select
                                id="channel-parent"
                                value={parentId ?? ''}
                                onChange={e => setParentId(e.target.value ? Number(e.target.value) : null)}
                            >
                                <option value="">No parent (top level)</option>
                                {collections.map(c => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {/* AFK toggle - voice channels only. When on, members can't
                        transmit audio and idle users are auto-moved here. */}
                    {channel.channel_type === 1 && (
                        <div className="form-group">
                            <label className="checkbox-label">
                                <input
                                    type="checkbox"
                                    checked={isAfk}
                                    onChange={e => setIsAfk(e.target.checked)}
                                />
                                {' '}AFK channel (mic disabled; idle members are moved here)
                            </label>
                        </div>
                    )}

                    {/* SFU toggle - voice channels only. When on, calls in this channel
                        route media through the self-hosted SFU (concurrent multi-
                        streaming for bigger rooms) instead of the P2P mesh. Read at
                        join time — people already in a live call keep their current
                        transport until they rejoin. */}
                    {channel.channel_type === 1 && (
                        <div className="form-group">
                            <label className="checkbox-label">
                                <input
                                    type="checkbox"
                                    checked={isSfu}
                                    onChange={e => setIsSfu(e.target.checked)}
                                />
                                {' '}SFU mode (server-routed streams for 5+ person calls)
                            </label>
                        </div>
                    )}

                    {/* Checklist toggle - text channels only. When on, the channel's
                        main view is a Keep-style checklist instead of a message stream. */}
                    {channel.channel_type === 0 && (
                        <div className="form-group">
                            <label className="checkbox-label">
                                <input
                                    type="checkbox"
                                    checked={isChecklist}
                                    onChange={e => setIsChecklist(e.target.checked)}
                                />
                                {' '}Checklist channel (Keep-style to-do list instead of chat)
                            </label>
                        </div>
                    )}

                    {/* Slowmode - text channels only */}
                    {channel.channel_type === 0 && (
                        <div className="form-group">
                            <label htmlFor="channel-slowmode">Slowmode</label>
                            <select
                                id="channel-slowmode"
                                value={slowmode}
                                onChange={e => setSlowmode(Number(e.target.value))}
                            >
                                <option value={0}>Off</option>
                                <option value={5}>5 seconds</option>
                                <option value={10}>10 seconds</option>
                                <option value={30}>30 seconds</option>
                                <option value={60}>1 minute</option>
                                <option value={300}>5 minutes</option>
                                <option value={900}>15 minutes</option>
                                <option value={3600}>1 hour</option>
                            </select>
                        </div>
                    )}

                    <div className="modal-actions">
                        <button type="button" className="secondary-button" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="primary-button" disabled={isLoading || !name.trim()}>
                            {isLoading ? 'Saving...' : 'Save Changes'}
                        </button>
                    </div>
                </form>
                ) : (
                <div className="channel-perms-tab">
                    {permsLoading ? (
                        <div className="channel-perms-loading">Loading permissions...</div>
                    ) : (
                        <div className="channel-perms">
                            <div className="channel-perms-roles">
                                {permRoles.map(role => {
                                    const ov = overwrites[role.id];
                                    const hasOv = !!ov && (ov.allow !== 0 || ov.deny !== 0);
                                    return (
                                        <button
                                            key={role.id}
                                            type="button"
                                            className={`channel-perms-role ${selectedRoleId === role.id ? 'active' : ''}`}
                                            onClick={() => setSelectedRoleId(role.id)}
                                        >
                                            <span className="channel-perms-role-dot" style={{ backgroundColor: role.color }} />
                                            <span className="channel-perms-role-name">{role.name}</span>
                                            {hasOv && <span className="channel-perms-role-flag" title="Has overwrites">•</span>}
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="channel-perms-editor">
                                {selectedRole ? (
                                    <>
                                        <p className="channel-perms-hint">
                                            — inherit falls back to the role's server-level permissions.
                                            The tick allows and the cross denies the permission in this
                                            channel only.
                                        </p>
                                        {CHANNEL_PERMS.map(perm => {
                                            const state = triFor(selectedRole.id, perm.bit);
                                            return (
                                                <div key={perm.bit} className="channel-perm-row">
                                                    <span className="channel-perm-label">{perm.label}</span>
                                                    <div className="tri-state">
                                                        <button
                                                            type="button"
                                                            className={`tri-btn tri-inherit ${state === 'inherit' ? 'active' : ''}`}
                                                            title="Inherit"
                                                            aria-label={`${perm.label}: inherit`}
                                                            onClick={() => setTri(selectedRole.id, perm.bit, 'inherit')}
                                                        >
                                                            —
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className={`tri-btn tri-allow ${state === 'allow' ? 'active' : ''}`}
                                                            title="Allow"
                                                            aria-label={`${perm.label}: allow`}
                                                            onClick={() => setTri(selectedRole.id, perm.bit, 'allow')}
                                                        >
                                                            <CheckIcon />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className={`tri-btn tri-deny ${state === 'deny' ? 'active' : ''}`}
                                                            title="Deny"
                                                            aria-label={`${perm.label}: deny`}
                                                            onClick={() => setTri(selectedRole.id, perm.bit, 'deny')}
                                                        >
                                                            <CloseIcon />
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </>
                                ) : (
                                    <p className="channel-perms-hint">Select a role to edit its channel overwrites.</p>
                                )}
                            </div>
                        </div>
                    )}

                    <div className="modal-actions">
                        <button type="button" className="secondary-button" onClick={onClose}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="primary-button"
                            onClick={handleSavePermissions}
                            disabled={permsSaving || permsLoading || !permsDirty}
                        >
                            {permsSaving ? 'Saving...' : 'Save Permissions'}
                        </button>
                    </div>
                </div>
                )}
            </div>
        </div>
    );
}
