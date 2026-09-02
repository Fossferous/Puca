import { useState, useEffect, useCallback } from 'react';
import {
    listFriends,
    listIncomingRequests,
    listOutgoingRequests,
    acceptFriendRequest,
    rejectFriendRequest,
    removeFriend,
    sendFriendRequest,
} from '../api/friends';
import type { Friend, FriendRequest, OutgoingRequest } from '../api/friends';
import { startDMConversation, listDMConversations, searchUsers } from '../api/dms';
import { isNetworkError, statusOf } from '../api/client';
import type { DMConversation, SearchUserResult } from '../api/dms';
import { TasksView } from './TasksView';
import { HomeSidebar } from './HomeSidebar';
import { TasksIcon, MembersIcon, MessageIcon, CheckIcon, CloseIcon, SettingsIcon, UserRemoveIcon } from './Icons';
import './FriendsPanel.css';

interface FriendsPanelProps {
    onStartDM: (conversation: DMConversation) => void;
    onClose: () => void;
    /** Open with this tab preselected (the rail's Tasks button uses 'tasks'). */
    initialTab?: 'online' | 'tasks';
    /** Reports Friends↔Tasks switches so the rail buttons can highlight right. */
    onTabChange?: (tab: 'online' | 'tasks') => void;
    /** Open app Settings. This dashboard is a fixed overlay that covers the
     *  sidebar (and with it the only settings cog), so it carries its own. */
    onOpenSettings?: () => void;
}

export function FriendsPanel({ onStartDM, onClose, initialTab = 'online', onTabChange, onOpenSettings }: FriendsPanelProps) {
    const [activeTab, setActiveTab] = useState<'online' | 'all' | 'pending' | 'add' | 'tasks'>(initialTab);

    // Follow later preselects while already open (e.g. rail Tasks button
    // pressed while the Friends view is showing).
    useEffect(() => {
        setActiveTab(initialTab);
    }, [initialTab]);
    const [friends, setFriends] = useState<Friend[]>([]);
    const [incoming, setIncoming] = useState<FriendRequest[]>([]);
    const [outgoing, setOutgoing] = useState<OutgoingRequest[]>([]);
    const [dmConversations, setDmConversations] = useState<DMConversation[]>([]);
    const [loading, setLoading] = useState(true);
    const [addFriendUsername, setAddFriendUsername] = useState('');
    const [addFriendStatus, setAddFriendStatus] = useState<{ success?: string; error?: string } | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [pendingQuery, setPendingQuery] = useState('');
    // Outcome of the last Accept / Decline / Remove / Message, rendered above
    // the list. These used to fail into console.error only: a tap that did
    // nothing, and 15 s later the row came back with no explanation.
    const [panelStatus, setPanelStatus] = useState<string | null>(null);

    const explainFailure = (what: string, err: unknown): string =>
        isNetworkError(err)
            ? `${what} — you appear to be offline. Check your connection and try again.`
            : statusOf(err) === 404
                ? `${what} — that request no longer exists. It may have been withdrawn.`
                : `${what} — the server refused. Try again in a moment.`;

    const loadData = useCallback(async (background = false) => {
        if (!background) setLoading(true);
        try {
            const [friendsList, incomingList, outgoingList, dmList] = await Promise.all([
                listFriends(),
                listIncomingRequests(),
                listOutgoingRequests(),
                listDMConversations(),
            ]);
            setFriends(friendsList);
            setIncoming(incomingList);
            setOutgoing(outgoingList);
            setDmConversations(dmList);
        } catch (error) {
            console.error('Failed to load friends data:', error);
        }
        if (!background) setLoading(false);
    }, []);

    useEffect(() => {
        loadData();
        // Keep requests/friends fresh while the panel is open — incoming friend
        // requests have no WS push, so without this they only appear on reopen.
        // Background flag keeps the refresh from flashing the loading state.
        const interval = setInterval(() => loadData(true), 15000);
        return () => clearInterval(interval);
    }, [loadData]);

    // Start DM with a search result user (search itself lives in HomeSidebar)
    const handleStartDMWithUser = async (user: SearchUserResult) => {
        try {
            const conversation = await startDMConversation(user.id);
            setSearchQuery(''); // Clear search
            onStartDM(conversation);
            onClose();
        } catch (error) {
            console.error('Failed to start DM:', error);
            setPanelStatus(explainFailure(`Couldn't open a conversation with ${user.username}`, error));
        }
    };

    const handleAccept = async (requestId: number) => {
        setPanelStatus(null);
        try {
            await acceptFriendRequest(requestId);
            await loadData();
        } catch (error) {
            console.error('Failed to accept request:', error);
            setPanelStatus(explainFailure("Couldn't accept the request", error));
        }
    };

    const handleReject = async (requestId: number) => {
        setPanelStatus(null);
        try {
            await rejectFriendRequest(requestId);
            setIncoming(prev => prev.filter(r => r.id !== requestId));
        } catch (error) {
            console.error('Failed to reject request:', error);
            setPanelStatus(explainFailure("Couldn't decline the request", error));
        }
    };

    const handleRemoveFriend = async (userId: number) => {
        if (!confirm('Remove this friend?')) return;
        setPanelStatus(null);
        try {
            await removeFriend(userId);
            setFriends(prev => prev.filter(f => f.id !== userId));
        } catch (error) {
            console.error('Failed to remove friend:', error);
            setPanelStatus(explainFailure("Couldn't remove this friend", error));
        }
    };

    const handleMessage = async (friend: Friend) => {
        try {
            const conversation = await startDMConversation(friend.id);
            onStartDM(conversation);
            onClose();
        } catch (error) {
            console.error('Failed to start DM:', error);
            setPanelStatus(explainFailure(`Couldn't open a conversation with ${friend.username}`, error));
        }
    };

    const handleDMClick = (conv: DMConversation) => {
        onStartDM(conv);
        onClose();
    };

    const handleAddFriend = async (e: React.FormEvent) => {
        e.preventDefault();
        const name = addFriendUsername.trim();
        if (!name) return;
        setAddFriendStatus(null);
        try {
            // Resolve the username to a user id, then send the request.
            const results = await searchUsers(name);
            const match = results.find(u => u.username.toLowerCase() === name.toLowerCase());
            if (!match) {
                setAddFriendStatus({ error: `No user named "${name}" found.` });
                return;
            }
            await sendFriendRequest(match.id);
            setAddFriendStatus({ success: `Friend request sent to ${match.username}.` });
            setAddFriendUsername('');
            loadData();
        } catch (err: unknown) {
            // ApiError carries a flat `.status`; the axios-shaped
            // `.response.status` this read before was never set, so the
            // 409 branch was dead and every duplicate showed the generic line.
            const status = statusOf(err);
            setAddFriendStatus({
                error: status === 409 ? `You're already friends with ${name}, or a request is already pending.`
                    : isNetworkError(err) ? 'You appear to be offline — check your connection and try again.'
                    : 'Failed to send friend request.',
            });
        }
    };

    const onlineFriends = friends.filter(f => f.is_online);
    const pendingCount = incoming.length + outgoing.length;

    const filteredFriends = activeTab === 'online'
        ? onlineFriends
        : friends.filter(f =>
            searchQuery === '' ||
            f.username.toLowerCase().includes(searchQuery.toLowerCase())
        );
    // The Pending tab's search box used to be an inert uncontrolled input —
    // a visible control that ignored every keystroke. Same rule as the
    // friends filter, over both directions.
    const pq = pendingQuery.trim().toLowerCase();
    const filteredIncoming = pq ? incoming.filter(r => r.sender_username.toLowerCase().includes(pq)) : incoming;
    const filteredOutgoing = pq ? outgoing.filter(r => r.receiver_username.toLowerCase().includes(pq)) : outgoing;

    return (
        <div className={`friends-dashboard ${activeTab === 'tasks' ? 'tasks-active' : ''}`}>
            {/* Left Sidebar - DMs and Navigation (shared with the open-DM
                view in Chat so both look identical). In Tasks mode the DM
                search + conversation list are irrelevant, so mobile collapses
                this down to just the Friends/Tasks switcher (see .tasks-active
                rules) instead of eating 35% of the screen for nothing. */}
            <HomeSidebar
                dmConversations={dmConversations}
                friendsActive={activeTab !== 'add' && activeTab !== 'tasks'}
                tasksActive={activeTab === 'tasks'}
                pendingBadge={pendingCount}
                activeDMId={null}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                onNavFriends={() => { setActiveTab('online'); onTabChange?.('online'); }}
                onNavTasks={() => { setActiveTab('tasks'); onTabChange?.('tasks'); }}
                onSelectDM={handleDMClick}
                onStartUserDM={handleStartDMWithUser}
            />

            {/* Main Content - Friends List / Tasks */}
            <div className="friends-main">
                {activeTab === 'tasks' ? (
                    <>
                        <div className="friends-header-bar">
                            <div className="header-left">
                                <span className="header-icon"><TasksIcon /></span>
                                <span className="header-title">Tasks</span>
                            </div>
                            <div className="header-actions">
                                {onOpenSettings && (
                                    <button className="close-btn header-cog" onClick={onOpenSettings} aria-label="Open settings" title="Settings">
                                        <SettingsIcon size={18} />
                                    </button>
                                )}
                                <button className="close-btn" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
                            </div>
                        </div>
                        <TasksView />
                    </>
                ) : (
                <>
                <div className="friends-header-bar">
                    <div className="header-left">
                        <span className="header-icon"><MembersIcon /></span>
                        <span className="header-title">Friends</span>
                        <div className="header-divider"></div>
                        <button
                            className={`header-tab ${activeTab === 'online' ? 'active' : ''}`}
                            onClick={() => setActiveTab('online')}
                        >
                            Online
                        </button>
                        <button
                            className={`header-tab ${activeTab === 'all' ? 'active' : ''}`}
                            onClick={() => setActiveTab('all')}
                        >
                            All
                        </button>
                        <button
                            className={`header-tab ${activeTab === 'pending' ? 'active' : ''}`}
                            onClick={() => setActiveTab('pending')}
                        >
                            Pending
                            {pendingCount > 0 && <span className="tab-badge">{pendingCount}</span>}
                        </button>
                        <button
                            className={`header-tab add-friend-btn ${activeTab === 'add' ? 'active' : ''}`}
                            onClick={() => setActiveTab('add')}
                        >
                            Add Friend
                        </button>
                    </div>
                    <div className="header-actions">
                        {onOpenSettings && (
                            <button className="close-btn header-cog" onClick={onOpenSettings} aria-label="Open settings" title="Settings">
                                <SettingsIcon size={18} />
                            </button>
                        )}
                        <button className="close-btn" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
                    </div>
                </div>

                <div className="friends-content">
                    {panelStatus && (
                        <div className="add-status error friends-panel-status" role="alert">
                            {panelStatus}
                            <button className="friends-panel-status-dismiss" onClick={() => setPanelStatus(null)} aria-label="Dismiss">
                                <CloseIcon size={14} />
                            </button>
                        </div>
                    )}
                    {loading ? (
                        <div className="loading">Loading...</div>
                    ) : activeTab === 'add' ? (
                        <div className="add-friend-section">
                            <h3>Add Friend</h3>
                            <p className="add-friend-desc">You can add friends with their username.</p>
                            <form onSubmit={handleAddFriend} className="add-friend-form">
                                <input
                                    type="text"
                                    placeholder="Enter a username"
                                    value={addFriendUsername}
                                    onChange={e => setAddFriendUsername(e.target.value)}
                                />
                                <button type="submit" disabled={!addFriendUsername.trim()}>
                                    Send Friend Request
                                </button>
                            </form>
                            {addFriendStatus?.success && (
                                <div className="add-status success">{addFriendStatus.success}</div>
                            )}
                            {addFriendStatus?.error && (
                                <div className="add-status error">{addFriendStatus.error}</div>
                            )}
                        </div>
                    ) : activeTab === 'pending' ? (
                        <div className="pending-section">
                            <div className="search-bar">
                                <input
                                    type="text"
                                    placeholder="Search"
                                    value={pendingQuery}
                                    onChange={e => setPendingQuery(e.target.value)}
                                />
                            </div>

                            {filteredIncoming.length > 0 && (
                                <>
                                    <div className="section-header">Incoming — {filteredIncoming.length}</div>
                                    {filteredIncoming.map(request => (
                                        <div key={request.id} className="friend-row">
                                            <div className="friend-avatar">
                                                {request.sender_username.charAt(0).toUpperCase()}
                                            </div>
                                            <div className="friend-info">
                                                <span className="friend-name">{request.sender_username}</span>
                                                <span className="friend-status">Incoming Friend Request</span>
                                            </div>
                                            <div className="friend-actions">
                                                <button className="action-accept" onClick={() => handleAccept(request.id)} aria-label="Accept friend request"><CheckIcon /></button>
                                                <button className="action-reject" onClick={() => handleReject(request.id)} aria-label="Decline friend request"><CloseIcon /></button>
                                            </div>
                                        </div>
                                    ))}
                                </>
                            )}

                            {filteredOutgoing.length > 0 && (
                                <>
                                    <div className="section-header">Outgoing — {filteredOutgoing.length}</div>
                                    {filteredOutgoing.map(request => (
                                        <div key={request.id} className="friend-row outgoing">
                                            <div className="friend-avatar">
                                                {request.receiver_username.charAt(0).toUpperCase()}
                                            </div>
                                            <div className="friend-info">
                                                <span className="friend-name">{request.receiver_username}</span>
                                                <span className="friend-status">Outgoing Friend Request</span>
                                            </div>
                                            <div className="friend-actions">
                                                <span className="pending-label">Pending</span>
                                            </div>
                                        </div>
                                    ))}
                                </>
                            )}

                            {filteredIncoming.length === 0 && filteredOutgoing.length === 0 && (
                                <div className="empty-state">
                                    {pq && (incoming.length > 0 || outgoing.length > 0) ? 'No pending requests match' : 'No pending requests'}
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="friends-list-section">
                            <div className="search-bar">
                                <input
                                    type="text"
                                    placeholder="Search"
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                />
                            </div>
                            <div className="section-header">
                                {activeTab === 'online' ? `Online — ${onlineFriends.length}` : `All Friends — ${friends.length}`}
                            </div>

                            {filteredFriends.length === 0 ? (
                                <div className="empty-state">
                                    {activeTab === 'online' ? 'No friends online' : 'No friends yet'}
                                </div>
                            ) : (
                                filteredFriends.map(friend => (
                                    <div key={friend.id} className="friend-row">
                                        <div className={`friend-avatar ${friend.is_online ? 'online' : ''}`}>
                                            {friend.username.charAt(0).toUpperCase()}
                                            {friend.is_online && <span className="status-dot"></span>}
                                        </div>
                                        <div className="friend-info">
                                            <span className="friend-name">{friend.username}</span>
                                            <span className="friend-status">
                                                {friend.is_online ? 'Online' : 'Offline'}
                                            </span>
                                        </div>
                                        <div className="friend-actions">
                                            <button
                                                className="action-msg"
                                                onClick={() => handleMessage(friend)}
                                                title="Message"
                                            >
                                                <MessageIcon />
                                            </button>
                                            {/* Titled "More" with an overflow glyph before the icon
                                                migration, but it has only ever called
                                                handleRemoveFriend — straight to a "Remove this
                                                friend?" confirm. An overflow icon promises a menu
                                                that does not exist, so it names the action. */}
                                            <button
                                                className="action-more"
                                                onClick={() => handleRemoveFriend(friend.id)}
                                                title="Remove friend"
                                            >
                                                <UserRemoveIcon />
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </div>
                </>
                )}
            </div>

            {/* Right Sidebar - Active Now (hidden on Tasks for room) */}
            {activeTab !== 'tasks' && (
            <div className="active-now-sidebar">
                <h3>Active Now</h3>
                <div className="active-list">
                    {onlineFriends.length > 0 ? (
                        onlineFriends.slice(0, 5).map(friend => (
                            <div key={friend.id} className="active-user" onClick={() => handleMessage(friend)}>
                                <div className="active-avatar">
                                    {friend.username.charAt(0).toUpperCase()}
                                    <span className="status-indicator online"></span>
                                </div>
                                <div className="active-info">
                                    <span className="active-name">{friend.username}</span>
                                    <span className="active-status">Online</span>
                                </div>
                            </div>
                        ))
                    ) : (
                        <div className="active-empty">
                            <p>It's quiet for now...</p>
                            <p className="hint">When friends are active, they'll show up here.</p>
                        </div>
                    )}
                </div>
            </div>
            )}
        </div>
    );
}
