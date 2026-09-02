import { useEffect, useState } from 'react';
import { getInviteInfo, joinViaInvite, listPublicServers, joinServer, type InviteInfo, type PublicServer, type Server } from '../api/servers';
import { parseInviteCode } from '../api/pendingInvite';
import { CloseIcon } from './Icons';
import './JoinServerModal.css';

interface JoinServerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onServerJoined: (server: Server) => void;
    /** A code that arrived on an invite link (/invite/:code): prefilled and
     *  looked up as soon as the modal opens, so the visitor lands on the
     *  server's name and a Join button rather than an empty field. */
    initialCode?: string;
}

/**
 * The SHAPE of an invite link, not a host anyone can reach: a real domain
 * here would be one deployment's server baked into every fork's UI.
 * hygiene-lint:allow-placeholder-domain — illustrative input placeholder
 */
const INVITE_PLACEHOLDER = 'https://example.com/invite/aBc123Xy';

type Tab = 'invite' | 'discover';

export function JoinServerModal({ isOpen, onClose, onServerJoined, initialCode }: JoinServerModalProps) {
    const [activeTab, setActiveTab] = useState<Tab>('invite');
    const [inviteCode, setInviteCode] = useState('');
    const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
    const [publicServers, setPublicServers] = useState<PublicServer[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingServers, setIsLoadingServers] = useState(false);

    const handleClose = () => {
        setInviteCode('');
        setInviteInfo(null);
        setError(null);
        onClose();
    };

    const handleTabChange = async (tab: Tab) => {
        setActiveTab(tab);
        setError(null);

        if (tab === 'discover' && publicServers.length === 0) {
            setIsLoadingServers(true);
            try {
                const servers = await listPublicServers();
                setPublicServers(servers);
            } catch {
                setError('Failed to load public servers');
            } finally {
                setIsLoadingServers(false);
            }
        }
    };

    const handleLookupInvite = async (raw: string = inviteCode) => {
        // A full link (any host — pre-0.9.2 desktops copied tauri.localhost
        // links, and those must keep working) or a bare code.
        const code = parseInviteCode(raw);
        if (!code) {
            if (raw.trim()) setError('That does not look like an invite link or code');
            return;
        }

        setIsLoading(true);
        setError(null);
        setInviteInfo(null);

        try {
            const info = await getInviteInfo(code);
            setInviteInfo(info);
        } catch {
            setError('Invalid or expired invite link');
        } finally {
            setIsLoading(false);
        }
    };

    // An invite that arrived on a link: fill the field and look it up at once.
    useEffect(() => {
        if (!isOpen || !initialCode) return;
        setActiveTab('invite');
        setInviteCode(initialCode);
        void handleLookupInvite(initialCode);
        // handleLookupInvite is a plain closure over state setters; re-running
        // on its identity would loop the lookup.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, initialCode]);

    const handleJoinViaInvite = async () => {
        if (!inviteInfo) return;

        setIsLoading(true);
        setError(null);

        try {
            const server = await joinViaInvite(inviteInfo.code);
            onServerJoined(server);
            handleClose();
        } catch {
            setError('Failed to join server');
        } finally {
            setIsLoading(false);
        }
    };

    const handleJoinPublicServer = async (serverId: string) => {
        setIsLoading(true);
        setError(null);

        try {
            await joinServer(serverId);
            // Fetch server info after joining
            const server: Server = {
                id: serverId,
                name: publicServers.find(s => s.id === serverId)?.name || 'Server',
                owner_id: 0,
                created_at: new Date().toISOString()
            };
            onServerJoined(server);
            handleClose();
        } catch {
            setError('Failed to join server');
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="join-modal-overlay" onClick={handleClose}>
            <div className="join-modal" onClick={e => e.stopPropagation()}>
                <button className="join-modal-close" onClick={handleClose} aria-label="Close"><CloseIcon size={18} /></button>

                <h2>Join a Server</h2>
                <p className="join-subtitle">Enter an invite link below or browse public servers.</p>

                {/* Tabs */}
                <div className="join-tabs">
                    <button
                        className={`join-tab ${activeTab === 'invite' ? 'active' : ''}`}
                        onClick={() => handleTabChange('invite')}
                    >
                        Have an Invite
                    </button>
                    <button
                        className={`join-tab ${activeTab === 'discover' ? 'active' : ''}`}
                        onClick={() => handleTabChange('discover')}
                    >
                        Discover
                    </button>
                </div>

                {error && <div className="join-error">{error}</div>}

                {/* Invite Tab */}
                {activeTab === 'invite' && (
                    <div className="join-invite-tab">
                        <div className="invite-input-group">
                            <label>INVITE LINK</label>
                            <input
                                type="text"
                                value={inviteCode}
                                onChange={e => {
                                    setInviteCode(e.target.value);
                                    setInviteInfo(null);
                                }}
                                onKeyDown={e => { if (e.key === 'Enter') void handleLookupInvite(); }}
                                placeholder={INVITE_PLACEHOLDER}
                                autoFocus
                            />
                        </div>

                        {!inviteInfo ? (
                            <button
                                className="join-btn lookup"
                                onClick={() => void handleLookupInvite()}
                                disabled={!inviteCode.trim() || isLoading}
                            >
                                {isLoading ? 'Looking up...' : 'Look Up Invite'}
                            </button>
                        ) : (
                            <div className="invite-preview">
                                <div className="invite-preview-icon">
                                    {inviteInfo.server_name.charAt(0).toUpperCase()}
                                </div>
                                <div className="invite-preview-info">
                                    <h3>{inviteInfo.server_name}</h3>
                                    <p>{inviteInfo.member_count} members</p>
                                </div>
                                <button
                                    className="join-btn primary"
                                    onClick={handleJoinViaInvite}
                                    disabled={isLoading}
                                >
                                    {isLoading ? 'Joining...' : 'Join Server'}
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* Discover Tab */}
                {activeTab === 'discover' && (
                    <div className="join-discover-tab">
                        {isLoadingServers ? (
                            <div className="discover-loading">Loading public servers...</div>
                        ) : publicServers.length === 0 ? (
                            <div className="discover-empty">
                                <p>No public servers available right now.</p>
                                <p className="discover-empty-hint">Be the first to make your server public!</p>
                            </div>
                        ) : (
                            <div className="discover-list">
                                {publicServers.map(server => (
                                    <div key={server.id} className="discover-card">
                                        <div className="discover-card-icon">
                                            {server.name.charAt(0).toUpperCase()}
                                        </div>
                                        <div className="discover-card-info">
                                            <h3>{server.name}</h3>
                                            <p>{server.description || 'No description'}</p>
                                            <span className="discover-member-count">
                                                {server.member_count} members
                                            </span>
                                        </div>
                                        <button
                                            className="discover-join-btn"
                                            onClick={() => handleJoinPublicServer(server.id)}
                                            disabled={isLoading}
                                        >
                                            Join
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
