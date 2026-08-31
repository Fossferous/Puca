import { useState, useEffect, useRef } from 'react';
import {
    updateServerSettings, listChannels,
    listInvites, createInvite, deleteInvite,
    listBans, unbanMember, listReports, resolveReport, listAuditLog,
} from '../api/servers';
import { uploadFile, discardUpload } from '../api/uploads';
import type { Invite, Ban, Report, AuditLogEntry, Channel } from '../api/servers';
import { RoleSettingsModal } from './RoleSettingsModal';
import { EmojiSettings } from './EmojiSettings';
import { CheckIcon, ClipIcon, CloseIcon, GlobeIcon, LockIcon, MoonIcon, ShieldCheckIcon, SparkleIcon, TrashIcon, WarningIcon } from './Icons';
import { AFK_TIMEOUT_CHOICES_MIN } from '../utils/afkIdle';
import './ServerSettingsModal.css';
import { parseServerTimestamp } from '../utils/serverTime';
import { fetchFileUrl } from '../api/authedMedia';

/** Server timestamps arrive as RFC3339 UTC (older rows naive UTC) — render
 *  them in the viewer's locale instead of leaking the wire format. */
const fmtWhen = (s?: string | null) => {
    if (!s) return '';
    const t = parseServerTimestamp(s);
    return Number.isNaN(t) ? s : new Date(t).toLocaleString();
};

/** Offered clip lengths, in seconds. The server accepts anything in 60..=600,
 *  so a server already set to some other value keeps its own entry rather than
 *  rendering a blank picker (and being silently re-pointed on the next save). */
const CLIP_LENGTH_CHOICES = [60, 120, 180, 300, 600];
const clipLengthLabel = (secs: number) =>
    secs % 60 === 0 ? `${secs / 60} minute${secs === 60 ? '' : 's'}` : `${secs} seconds`;

interface ServerSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave?: () => void | Promise<void>;
    serverId: string;
    serverName: string;
    isOwner: boolean;
    initialIsPublic?: boolean;
    initialDescription?: string;
    initialIconFileId?: string | null;
    initialRequireMediaE2ee?: boolean;
    /** False = this server predates clips (none of the three fields came back).
     *  The group renders disabled with a note instead of pretending to work. */
    clipsSupported?: boolean;
    initialClipsEnabled?: boolean;
    initialClipMaxSeconds?: number;
    /** Pinned target text channel, or null = the clipper picks per clip. */
    initialClipChannelId?: number | null;
    /** AFK auto-move window, minutes (Discord's 1|5|15|30|60). undefined =
     *  the backend predates the setting: render disabled, don't send it. */
    initialAfkTimeoutMinutes?: number;
}

export function ServerSettingsModal({
    isOpen,
    onClose,
    onSave,
    serverId,
    serverName,
    isOwner,
    initialIsPublic = false,
    initialDescription = '',
    initialIconFileId = null,
    initialRequireMediaE2ee = false,
    clipsSupported = false,
    initialClipsEnabled = false,
    initialClipMaxSeconds = 120,
    initialClipChannelId = null,
    initialAfkTimeoutMinutes,
}: ServerSettingsModalProps) {
    const [activeTab, setActiveTab] = useState<'overview' | 'roles' | 'emoji' | 'invites' | 'moderation'>('overview');

    // Overview state
    const [name, setName] = useState(serverName);
    const [isPublic, setIsPublic] = useState(initialIsPublic);
    const [requireMediaE2ee, setRequireMediaE2ee] = useState(initialRequireMediaE2ee);
    const [description, setDescription] = useState(initialDescription);
    const [iconFileId, setIconFileId] = useState<string | null>(initialIconFileId);
    // The icon that is actually SAVED on the server. `iconFileId` starts equal
    // to it, so it cannot be used to tell "an unsaved pick I should throw away"
    // from "the live icon" — discarding on that basis would delete the server's
    // real icon out from under everyone.
    const [savedIconId, setSavedIconId] = useState<string | null>(initialIconFileId);
    const [iconPreview, setIconPreview] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isUploading, setIsUploading] = useState(false);

    // AFK auto-move window (Discord's option set — utils/afkIdle.ts).
    const afkSupported = typeof initialAfkTimeoutMinutes === 'number';
    const [afkTimeoutMinutes, setAfkTimeoutMinutes] = useState(initialAfkTimeoutMinutes ?? 15);

    // Clips policy (docs/CLIPS.md) — owner-only, per server.
    const [clipsEnabled, setClipsEnabled] = useState(initialClipsEnabled);
    const [clipMaxSeconds, setClipMaxSeconds] = useState(initialClipMaxSeconds);
    const [clipChannelId, setClipChannelId] = useState<number | null>(initialClipChannelId);
    const [textChannels, setTextChannels] = useState<Channel[]>([]);

    // Invites state
    const [invites, setInvites] = useState<Invite[]>([]);
    const [invitesLoading, setInvitesLoading] = useState(false);
    const [copiedCode, setCopiedCode] = useState<string | null>(null);

    // Moderation state
    const [modSection, setModSection] = useState<'bans' | 'reports' | 'audit'>('bans');
    const [bans, setBans] = useState<Ban[]>([]);
    const [reports, setReports] = useState<Report[]>([]);
    const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([]);
    const [modLoading, setModLoading] = useState(false);

    // General state
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Load the initial values on the OPEN transition only. The parent now
    // re-seats `currentServer` whenever the servers query refetches (a save,
    // a WS ServerUpdated, a reconnect), so these props can change while the
    // modal is open — and re-running this on every prop change would clobber
    // in-progress edits, yank the active tab back to Overview, and wipe the
    // "Settings saved!" confirmation the moment the save's own refetch landed.
    const wasOpenRef = useRef(false);
    useEffect(() => {
        const opening = isOpen && !wasOpenRef.current;
        wasOpenRef.current = isOpen;
        if (!opening) return;
        setActiveTab('overview');
        setName(serverName);
        setIsPublic(initialIsPublic);
        setRequireMediaE2ee(initialRequireMediaE2ee);
        setDescription(initialDescription);
        setIconFileId(initialIconFileId);
        setClipsEnabled(initialClipsEnabled);
        setClipMaxSeconds(initialClipMaxSeconds);
        setClipChannelId(initialClipChannelId);
        setAfkTimeoutMinutes(initialAfkTimeoutMinutes ?? 15);
        // Authenticated fetch -> object URL; null until it lands.
        setIconPreview(null);
        if (initialIconFileId) void fetchFileUrl(initialIconFileId).then(setIconPreview);
        setError(null);
        setSuccess(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on the open transition; the initial* props are read at that moment only
    }, [isOpen]);

    // Channels for the "Post clips to" picker. Fetched when the modal opens on
    // a clips-capable server — the reset above lands on Overview, which is the
    // only tab that shows it. `cancelled` keeps a late response from a previous
    // open (or another server) out of the list that is on screen now.
    useEffect(() => {
        if (!isOpen || !clipsSupported) return;
        let cancelled = false;
        listChannels(serverId)
            .then(chans => { if (!cancelled) setTextChannels(chans.filter(c => c.channel_type === 0)); })
            .catch(() => { if (!cancelled) setTextChannels([]); });
        return () => { cancelled = true; };
    }, [isOpen, serverId, clipsSupported]);

    // Load invites when tab changes
    useEffect(() => {
        if (isOpen && activeTab === 'invites') {
            loadInvites();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, activeTab, serverId]);

    // Load moderation data when the tab or section changes
    useEffect(() => {
        if (isOpen && activeTab === 'moderation') {
            loadModeration(modSection);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, activeTab, modSection, serverId]);

    const loadModeration = async (section: 'bans' | 'reports' | 'audit') => {
        setModLoading(true);
        setError(null);
        try {
            if (section === 'bans') setBans(await listBans(serverId));
            else if (section === 'reports') setReports(await listReports(serverId));
            else setAuditEntries(await listAuditLog(serverId));
        } catch {
            setError('Failed to load moderation data (missing permission?)');
        } finally {
            setModLoading(false);
        }
    };

    const handleUnban = async (userId: number) => {
        if (!confirm('Unban this user? They will be able to rejoin via invite.')) return;
        try {
            await unbanMember(serverId, userId);
            setBans(prev => prev.filter(b => b.user_id !== userId));
            setSuccess('User unbanned');
            setTimeout(() => setSuccess(null), 2000);
        } catch {
            setError('Failed to unban user');
        }
    };

    const handleResolveReport = async (reportId: number, status: 'resolved' | 'dismissed') => {
        try {
            await resolveReport(serverId, reportId, status);
            setReports(prev => prev.map(r => r.id === reportId ? { ...r, status } : r));
        } catch {
            setError('Failed to update report');
        }
    };

    const loadInvites = async () => {
        setInvitesLoading(true);
        try {
            const data = await listInvites(serverId);
            setInvites(data);
        } catch {
            setError('Failed to load invites');
        } finally {
            setInvitesLoading(false);
        }
    };

    const handleIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            setError('Please select an image file');
            return;
        }
        setIsUploading(true);
        setError(null);
        try {
            const uploaded = await uploadFile(file);
            // Picking a second icon before saving strands the first one: it is
            // uploaded, counts against the quota, and nothing will ever point
            // at it. Only discard a pick that was never saved.
            if (iconFileId && iconFileId !== savedIconId) discardUpload(iconFileId);
            setIconFileId(uploaded.id);
            setIconPreview(await fetchFileUrl(uploaded.id));
        } catch {
            setError('Failed to upload icon');
        } finally {
            setIsUploading(false);
        }
    };

    const handleSaveOverview = async () => {
        if (!isOwner) return;
        // Clips-on-without-a-channel is not a state worth CREATING: members
        // would see the feature enabled and hit "no clips channel yet" at the
        // composer. But a server that is ALREADY in that state (configured
        // under the old "let the clipper choose" default) must not have its
        // whole Overview save hostage to it — the owner renaming the server
        // would be told to configure clips they never touched. Block only
        // saves that would create the state anew; preserving the legacy
        // status quo saves fine, with the inline warning as the nudge.
        // (Today this client check is the only gate: the server-side 400 for
        // it ships with S1, the next backend release, alongside the 409 in
        // propose_clip — until then an old client against an unpinned server
        // can still post anywhere it can send.)
        const legacyUnpinned = initialClipsEnabled && initialClipChannelId === null;
        if (clipsSupported && clipsEnabled && clipChannelId === null && !legacyUnpinned) {
            setError('Choose a clips channel before turning clips on — members cannot post clips until you pick one.');
            return;
        }
        setIsSaving(true);
        setError(null);
        try {
            await updateServerSettings(serverId, {
                name: name.trim() !== serverName ? name.trim() : undefined,
                is_public: isPublic,
                require_media_e2ee: requireMediaE2ee,
                description: description.trim() || undefined,
                icon_file_id: iconFileId || undefined,
                // Only for a server that has the fields at all: sending them to
                // an older backend would be a write it silently drops. `0` is
                // how the server is told to CLEAR the pinned channel — omitting
                // the key would leave the old pin in place.
                ...(clipsSupported ? {
                    clips_enabled: clipsEnabled,
                    clip_max_seconds: clipMaxSeconds,
                    clip_channel_id: clipChannelId ?? 0,
                } : {}),
                // Same older-backend rule as clips: a server that never
                // returned the field would silently drop the write.
                ...(afkSupported ? { afk_timeout_minutes: afkTimeoutMinutes } : {}),
            });
            setSavedIconId(iconFileId);   // this pick is now the live icon
            setSuccess('Settings saved!');
            setTimeout(() => setSuccess(null), 2000);
            // The parent refreshes its server snapshot here. Await it and keep
            // its failure SEPARATE from a failed save: the PATCH already landed,
            // so "Failed to save" would be a lie — say what actually happened.
            if (onSave) {
                try { await onSave(); } catch {
                    setError('Saved — but the settings view could not refresh. Close and reopen to see the current values.');
                }
            }
        } catch {
            setError('Failed to save settings');
        } finally {
            setIsSaving(false);
        }
    };

    // Invite handlers
    const handleCreateInvite = async () => {
        try {
            const invite = await createInvite(serverId, { expires_in_hours: 24 });
            setInvites([invite, ...invites]);
            copyToClipboard(invite.code);
        } catch {
            setError('Failed to create invite');
        }
    };

    const handleDeleteInvite = async (code: string) => {
        try {
            await deleteInvite(serverId, code);
            setInvites(invites.filter(i => i.code !== code));
        } catch {
            setError('Failed to delete invite');
        }
    };

    const copyToClipboard = (code: string) => {
        const url = `${window.location.origin}/invite/${code}`;
        navigator.clipboard.writeText(url);
        setCopiedCode(code);
        setTimeout(() => setCopiedCode(null), 2000);
    };

    if (!isOpen) return null;

    const clipLengths = CLIP_LENGTH_CHOICES.includes(clipMaxSeconds)
        ? CLIP_LENGTH_CHOICES
        : [...CLIP_LENGTH_CHOICES, clipMaxSeconds].sort((a, b) => a - b);

    return (
        <div className="server-settings-overlay" onClick={onClose}>
            <div className="server-settings-container" onClick={e => e.stopPropagation()}>
                {/* Sidebar */}
                <div className="server-settings-sidebar">
                    <div className="sidebar-section-title">{serverName}</div>
                    <nav className="server-settings-nav">
                        <button className={`nav-item ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>
                            Overview
                        </button>
                        <button className={`nav-item ${activeTab === 'roles' ? 'active' : ''}`} onClick={() => setActiveTab('roles')}>
                            Roles
                        </button>
                        <button className={`nav-item ${activeTab === 'emoji' ? 'active' : ''}`} onClick={() => setActiveTab('emoji')}>
                            Emoji
                        </button>
                        <button className={`nav-item ${activeTab === 'invites' ? 'active' : ''}`} onClick={() => setActiveTab('invites')}>
                            Invites
                        </button>
                        {isOwner && (
                            <button className={`nav-item ${activeTab === 'moderation' ? 'active' : ''}`} onClick={() => setActiveTab('moderation')}>
                                Moderation
                            </button>
                        )}
                    </nav>
                </div>

                {/* Content */}
                <div className="server-settings-content">
                    <button className="close-btn" aria-label="Close" onClick={onClose}><CloseIcon size={18} /></button>

                    {error && <div className="notice error">{error}</div>}
                    {success && <div className="notice success">{success}</div>}

                    {/* Overview Tab */}
                    {activeTab === 'overview' && (
                        <div className="tab-content">
                            <h2>Server Overview</h2>

                            <div className="form-row">
                                <div className="server-icon-edit">
                                    <div className="icon-preview-lg">
                                        {iconPreview ? <img src={iconPreview} alt="" /> : <span>{name.charAt(0)}</span>}
                                    </div>
                                    {isOwner && (
                                        <label className="upload-btn-sm">
                                            {isUploading ? '...' : 'Change'}
                                            <input type="file" accept="image/*" onChange={handleIconUpload} disabled={isUploading} />
                                        </label>
                                    )}
                                </div>
                                <div className="form-group flex-1">
                                    <label>Server Name</label>
                                    <input type="text" value={name} onChange={e => setName(e.target.value)} disabled={!isOwner} />
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Description</label>
                                <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What's this server about?" maxLength={200} disabled={!isOwner} />
                                <span className="char-count">{description.length}/200</span>
                            </div>

                            <div className="form-group">
                                <label className="toggle-row">
                                    <span>{isPublic ? <><GlobeIcon /> Public Server</> : <><LockIcon /> Private Server</>}</span>
                                    <input type="checkbox" checked={isPublic} onChange={e => setIsPublic(e.target.checked)} disabled={!isOwner} />
                                    <span className="toggle-switch"></span>
                                </label>
                            </div>

                            <div className="form-group">
                                <label className="toggle-row">
                                    <span><ShieldCheckIcon /> Require encryption for calls</span>
                                    <input type="checkbox" checked={requireMediaE2ee} onChange={e => setRequireMediaE2ee(e.target.checked)} disabled={!isOwner} />
                                    <span className="toggle-switch"></span>
                                </label>
                                <span className="setting-help">
                                    Voice, video and screen share in this server are only exchanged between people
                                    whose media is end-to-end encrypted. Anyone who can’t be encrypted (Safari, iOS
                                    or Firefox) is muted rather than relayed through the server. The desktop app
                                    supports this.
                                </span>
                            </div>

                            {/* AFK auto-move (Discord's rules — utils/afkIdle.ts):
                                idle in voice for this window → moved to the AFK
                                channel. The window is the only knob; what counts
                                as idle is fixed by the rules. */}
                            <div className="form-group">
                                <label htmlFor="afk-timeout"><MoonIcon /> AFK timeout</label>
                                <select
                                    id="afk-timeout"
                                    value={afkTimeoutMinutes}
                                    onChange={e => setAfkTimeoutMinutes(Number(e.target.value))}
                                    disabled={!isOwner || !afkSupported}
                                >
                                    {AFK_TIMEOUT_CHOICES_MIN.map(mins => (
                                        <option key={mins} value={mins}>
                                            {mins === 60 ? '1 hour' : `${mins} minute${mins === 1 ? '' : 's'}`}
                                        </option>
                                    ))}
                                </select>
                                <span className="setting-help">
                                    Anyone in a voice channel who hasn’t spoken or touched their keyboard,
                                    mouse or screen for this long is moved to the AFK channel. Playing a
                                    game counts as activity; being muted does not.
                                </span>
                                {!afkSupported && (
                                    <span className="setting-help">This server runs an older version without this setting.</span>
                                )}
                            </div>

                            {/* Clips (docs/CLIPS.md). The owner decides whether this
                                server allows them at all; the consent gate in front
                                of every post is not optional and has no switch. */}
                            <div className="form-group">
                                <label className="toggle-row">
                                    <span><ClipIcon /> Allow clips</span>
                                    <input type="checkbox" checked={clipsEnabled} onChange={e => setClipsEnabled(e.target.checked)} disabled={!isOwner || !clipsSupported} />
                                    <span className="toggle-switch"></span>
                                </label>
                                <span className="setting-help">
                                    Members can save a replay clip of a voice call and post it here — but
                                    only after everyone who was in the call during that window approves.
                                    One decline and the clip is deleted from the clipper’s PC; nothing is
                                    uploaded before approval.
                                </span>
                                {!clipsSupported ? (
                                    <span className="setting-help">This server runs an older version without clips.</span>
                                ) : clipsEnabled && (
                                    <div className="clip-policy-fields">
                                        <div className="form-group">
                                            <label htmlFor="clip-max-seconds">Longest clip</label>
                                            <select
                                                id="clip-max-seconds"
                                                value={clipMaxSeconds}
                                                onChange={e => setClipMaxSeconds(Number(e.target.value))}
                                                disabled={!isOwner}
                                            >
                                                {clipLengths.map(secs => (
                                                    <option key={secs} value={secs}>{clipLengthLabel(secs)}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="form-group">
                                            <label htmlFor="clip-channel">Post clips to</label>
                                            {/* REQUIRED, no "let the clipper choose" any more: the
                                                approval prompt names where the clip will land, and a
                                                per-clip choice meant approvers were agreeing to a
                                                destination the clipper could still change. `0` is the
                                                unchosen state (and how the wire clears a pin). */}
                                            <select
                                                id="clip-channel"
                                                value={clipChannelId ?? 0}
                                                onChange={e => setClipChannelId(Number(e.target.value) || null)}
                                                disabled={!isOwner}
                                            >
                                                <option value={0}>Choose a channel…</option>
                                                {textChannels.map(chan => (
                                                    <option key={chan.id} value={chan.id}>#{chan.name}</option>
                                                ))}
                                            </select>
                                            {clipChannelId === null ? (
                                                <span className="setting-help">
                                                    <WarningIcon size={13} /> Clips need one channel they always post
                                                    to. Until you pick one, members cannot post clips.
                                                </span>
                                            ) : textChannels.length > 0 && !textChannels.some(c => c.id === clipChannelId) && (
                                                // The pin points at a channel the list no longer
                                                // has (deleted, most likely). The select paints
                                                // its placeholder for an unmatched value, so
                                                // without this line the owner sees "no channel
                                                // chosen" with no warning beside it — and every
                                                // save 400s with a generic error.
                                                <span className="setting-help">
                                                    <WarningIcon size={13} /> The chosen clips channel no longer
                                                    exists — pick another. Members cannot post clips until you do.
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {isOwner && (
                                <button className="primary-btn" onClick={handleSaveOverview} disabled={isSaving}>
                                    {isSaving ? 'Saving...' : 'Save Changes'}
                                </button>
                            )}
                        </div>
                    )}

                    {/* Roles Tab — the grouped/described editor with a custom
                        colour picker (RoleSettingsModal), embedded. Replaces a
                        cruder inline grid that duplicated the same endpoints;
                        RoleSettingsModal was rendered in Chat.tsx but nothing
                        ever opened it. */}
                    {activeTab === 'roles' && (
                        <div className="tab-content roles-tab">
                            <RoleSettingsModal
                                isOpen
                                embedded
                                onClose={() => { /* embedded: parent owns closing */ }}
                                serverId={serverId}
                                serverName={serverName}
                                isOwner={isOwner}
                            />
                        </div>
                    )}

                    {/* Emoji Tab — custom emoji upload/delete. The component
                        existed, complete, with no way to reach it. */}
                    {activeTab === 'emoji' && (
                        <div className="tab-content emoji-tab">
                            <h2>Emoji</h2>
                            <EmojiSettings
                                isOpen
                                embedded
                                onClose={() => { /* embedded: parent owns closing */ }}
                                serverId={serverId}
                                serverName={serverName}
                                isOwner={isOwner}
                            />
                        </div>
                    )}

                    {/* Invites Tab */}
                    {activeTab === 'invites' && (
                        <div className="tab-content">
                            <div className="invites-header">
                                <h2>Invites</h2>
                                <button className="primary-btn" onClick={handleCreateInvite}>+ Create Invite</button>
                            </div>

                            {invitesLoading ? (
                                <div className="loading">Loading invites...</div>
                            ) : invites.length === 0 ? (
                                <div className="empty-state">No active invites. Create one to invite friends!</div>
                            ) : (
                                <div className="invites-list">
                                    {invites.map(invite => (
                                        <div key={invite.code} className="invite-item">
                                            <div className="invite-info">
                                                <code>{invite.code}</code>
                                                <span className="invite-uses">{invite.uses}{invite.max_uses ? `/${invite.max_uses}` : ''} uses</span>
                                            </div>
                                            <div className="invite-actions">
                                                <button className={`copy-btn ${copiedCode === invite.code ? 'copied' : ''}`} onClick={() => copyToClipboard(invite.code)}>
                                                    {copiedCode === invite.code ? <><CheckIcon /> Copied</> : 'Copy'}
                                                </button>
                                                <button className="delete-btn" aria-label="Revoke invite" onClick={() => handleDeleteInvite(invite.code)}><TrashIcon /></button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Moderation Tab */}
                    {activeTab === 'moderation' && (
                        <div className="tab-content">
                            <h2>Moderation</h2>

                            <div className="mod-section-tabs">
                                <button className={`mod-tab ${modSection === 'bans' ? 'active' : ''}`} onClick={() => setModSection('bans')}>
                                    Bans{bans.length > 0 ? ` (${bans.length})` : ''}
                                </button>
                                <button className={`mod-tab ${modSection === 'reports' ? 'active' : ''}`} onClick={() => setModSection('reports')}>
                                    Reports{reports.filter(r => r.status === 'pending').length > 0 ? ` (${reports.filter(r => r.status === 'pending').length})` : ''}
                                </button>
                                <button className={`mod-tab ${modSection === 'audit' ? 'active' : ''}`} onClick={() => setModSection('audit')}>
                                    Audit Log
                                </button>
                            </div>

                            {modLoading ? (
                                <div className="loading">Loading...</div>
                            ) : modSection === 'bans' ? (
                                bans.length === 0 ? (
                                    <div className="empty-state">No banned users.</div>
                                ) : (
                                    <div className="mod-list">
                                        {bans.map(ban => (
                                            <div key={ban.user_id} className="mod-item">
                                                <div className="mod-item-main">
                                                    <span className="mod-item-title">{ban.username}</span>
                                                    <span className="mod-item-sub">
                                                        {ban.reason ? `"${ban.reason}"` : 'No reason given'} · {fmtWhen(ban.banned_at)}
                                                    </span>
                                                </div>
                                                <button className="danger-btn" onClick={() => handleUnban(ban.user_id)}>Unban</button>
                                            </div>
                                        ))}
                                    </div>
                                )
                            ) : modSection === 'reports' ? (
                                reports.length === 0 ? (
                                    <div className="empty-state">No reports. All quiet <SparkleIcon /></div>
                                ) : (
                                    <div className="mod-list">
                                        {reports.map(report => (
                                            <div key={report.id} className="mod-item">
                                                <div className="mod-item-main">
                                                    <span className="mod-item-title">
                                                        <span className={`report-badge ${report.report_type}`}>{report.report_type}</span>
                                                        {report.reported_username ? ` against ${report.reported_username}` : ''}
                                                        <span className={`report-status ${report.status}`}> · {report.status}</span>
                                                    </span>
                                                    <span className="mod-item-sub">
                                                        "{report.reason}" — reported by {report.reporter_username ?? `user ${report.reporter_id}`} · {fmtWhen(report.created_at)}
                                                    </span>
                                                </div>
                                                {report.status === 'pending' && (
                                                    <div className="mod-item-actions">
                                                        <button className="primary-btn" onClick={() => handleResolveReport(report.id, 'resolved')}>Resolve</button>
                                                        <button className="danger-btn" onClick={() => handleResolveReport(report.id, 'dismissed')}>Dismiss</button>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )
                            ) : (
                                auditEntries.length === 0 ? (
                                    <div className="empty-state">No moderation actions recorded yet.</div>
                                ) : (
                                    <div className="mod-list">
                                        {auditEntries.map(entry => (
                                            <div key={entry.id} className="mod-item">
                                                <div className="mod-item-main">
                                                    <span className="mod-item-title">
                                                        <span className={`audit-badge ${entry.action_type}`}>{entry.action_type}</span>
                                                        {' by '}{entry.actor_username ?? `user ${entry.actor_id}`}
                                                        {entry.target_id != null ? ` → ${entry.target_type ?? 'target'} ${entry.target_id}` : ''}
                                                    </span>
                                                    <span className="mod-item-sub">
                                                        {entry.details ? `"${entry.details}" · ` : ''}{fmtWhen(entry.created_at)}
                                                    </span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
