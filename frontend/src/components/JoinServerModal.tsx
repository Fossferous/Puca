import { useState } from 'react';
import { getInviteInfo, joinViaInvite, listPublicServers, joinServer, type InviteInfo, type PublicServer, type Server } from '../api/servers';
import { CloseIcon } from './Icons';
import './JoinServerModal.css';

interface JoinServerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onServerJoined: (server: Server) => void;
}

type Tab = 'invite' | 'discover';

export function JoinServerModal({ isOpen, onClose, onServerJoined }: JoinServerModalProps) {
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

    const handleLookupInvite = async () => {
        if (!inviteCode.trim()) return;

        setIsLoading(true);
        setError(null);
        setInviteInfo(null);

        try {
            // Extract code from URL if pasted
            let code = inviteCode.trim();
            if (code.includes('/invite/')) {
                code = code.split('/invite/').pop() || code;
            }

            const info = await getInviteInfo(code);
            setInviteInfo(info);
        } catch {
            setError('Invalid or expired invite link');
        } finally {
            setIsLoading(false);
        }
    };

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
                                onKeyDown={e => e.key === 'Enter' && handleLookupInvite()}
                                placeholder="https://example.com/invite/aBc123Xy"
                                autoFocus
                            />
                        </div>

                        {!inviteInfo ? (
                            <button
                                className="join-btn lookup"
                                onClick={handleLookupInvite}
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
