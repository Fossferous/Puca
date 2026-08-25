import { useState, useEffect, useCallback } from 'react';
import { createInvite, listInvites, deleteInvite, type Invite } from '../api/servers';
import { CheckIcon, CloseIcon, TrashIcon } from './Icons';
import './InviteModal.css';
import { parseServerTimestamp } from '../utils/serverTime';

interface InviteModalProps {
    isOpen: boolean;
    onClose: () => void;
    serverId: string;
    serverName: string;
}

export function InviteModal({ isOpen, onClose, serverId, serverName }: InviteModalProps) {
    const [invites, setInvites] = useState<Invite[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    // Invite options
    const [maxUses, setMaxUses] = useState<number | undefined>(undefined);
    const [expiresIn, setExpiresIn] = useState<number | undefined>(24); // hours

    const loadInvites = useCallback(async () => {
        setIsLoading(true);
        try {
            const list = await listInvites(serverId);
            setInvites(list);
        } catch {
            setError('Failed to load invites');
        } finally {
            setIsLoading(false);
        }
    }, [serverId]);

    useEffect(() => {
        if (isOpen && serverId) {
            loadInvites();
        }
    }, [isOpen, serverId, loadInvites]);

    const handleCreateInvite = async () => {
        setIsCreating(true);
        setError(null);
        try {
            const invite = await createInvite(serverId, {
                max_uses: maxUses,
                expires_in_hours: expiresIn,
            });
            setInvites(prev => [invite, ...prev]);
            // Auto-copy the new invite
            copyToClipboard(invite.code);
        } catch {
            setError('Failed to create invite');
        } finally {
            setIsCreating(false);
        }
    };

    const handleDeleteInvite = async (code: string) => {
        try {
            await deleteInvite(serverId, code);
            setInvites(prev => prev.filter(i => i.code !== code));
        } catch {
            setError('Failed to delete invite');
        }
    };

    const copyToClipboard = async (code: string) => {
        const inviteUrl = `${window.location.origin}/invite/${code}`;
        try {
            await navigator.clipboard.writeText(inviteUrl);
            setCopied(code);
            setTimeout(() => setCopied(null), 2000);
        } catch {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = inviteUrl;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            setCopied(code);
            setTimeout(() => setCopied(null), 2000);
        }
    };

    const formatExpiry = (expiresAt: string | null) => {
        if (!expiresAt) return 'Never';
        const expiry = new Date(parseServerTimestamp(expiresAt));
        const now = new Date();
        const diff = expiry.getTime() - now.getTime();
        if (diff < 0) return 'Expired';
        const hours = Math.floor(diff / (1000 * 60 * 60));
        if (hours < 24) return `${hours}h remaining`;
        const days = Math.floor(hours / 24);
        return `${days}d remaining`;
    };

    if (!isOpen) return null;

    return (
        <div className="invite-modal-overlay" onClick={onClose}>
            <div className="invite-modal" onClick={e => e.stopPropagation()}>
                <button className="invite-modal-close" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>

                <h2>Invite to {serverName}</h2>
                <p className="invite-subtitle">Share this link with others to grant access to your server</p>

                {error && <div className="invite-error">{error}</div>}

                {/* Create New Invite Section */}
                <div className="invite-create-section">
                    <h3>Create New Invite</h3>

                    <div className="invite-options">
                        <div className="invite-option">
                            <label>Expire After</label>
                            <select
                                value={expiresIn ?? 'never'}
                                onChange={e => setExpiresIn(e.target.value === 'never' ? undefined : Number(e.target.value))}
                            >
                                <option value="1">1 hour</option>
                                <option value="6">6 hours</option>
                                <option value="12">12 hours</option>
                                <option value="24">1 day</option>
                                <option value="168">7 days</option>
                                <option value="never">Never</option>
                            </select>
                        </div>

                        <div className="invite-option">
                            <label>Max Uses</label>
                            <select
                                value={maxUses ?? 'unlimited'}
                                onChange={e => setMaxUses(e.target.value === 'unlimited' ? undefined : Number(e.target.value))}
                            >
                                <option value="1">1 use</option>
                                <option value="5">5 uses</option>
                                <option value="10">10 uses</option>
                                <option value="25">25 uses</option>
                                <option value="50">50 uses</option>
                                <option value="100">100 uses</option>
                                <option value="unlimited">No limit</option>
                            </select>
                        </div>
                    </div>

                    <button
                        className="invite-create-btn"
                        onClick={handleCreateInvite}
                        disabled={isCreating}
                    >
                        {isCreating ? 'Creating...' : 'Generate Invite Link'}
                    </button>
                </div>

                {/* Existing Invites List */}
                <div className="invite-list-section">
                    <h3>Active Invites</h3>

                    {isLoading ? (
                        <div className="invite-loading">Loading invites...</div>
                    ) : invites.length === 0 ? (
                        <div className="invite-empty">No active invites. Create one above!</div>
                    ) : (
                        <div className="invite-list">
                            {invites.map(invite => (
                                <div key={invite.code} className="invite-item">
                                    <div className="invite-item-info">
                                        <span className="invite-code">{invite.code}</span>
                                        <div className="invite-meta">
                                            <span>{invite.uses}{invite.max_uses ? `/${invite.max_uses}` : ''} uses</span>
                                            <span>•</span>
                                            <span>{formatExpiry(invite.expires_at)}</span>
                                        </div>
                                    </div>
                                    <div className="invite-item-actions">
                                        <button
                                            className={`invite-copy-btn ${copied === invite.code ? 'copied' : ''}`}
                                            onClick={() => copyToClipboard(invite.code)}
                                        >
                                            {copied === invite.code ? <><CheckIcon /> Copied!</> : 'Copy'}
                                        </button>
                                        <button
                                            className="invite-delete-btn"
                                            onClick={() => handleDeleteInvite(invite.code)}
                                            title="Revoke invite"
                                        >
                                            <TrashIcon />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
