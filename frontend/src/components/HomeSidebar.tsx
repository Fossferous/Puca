import { useState, useEffect, useRef } from 'react';
import { searchUsers } from '../api/dms';
import type { DMConversation, SearchUserResult } from '../api/dms';
import { MembersIcon, TasksIcon } from './Icons';
// Owns the .friends-sidebar / .dm-* styles this component renders — imported
// here so the styling doesn't silently depend on FriendsPanel being mounted.
import './FriendsPanel.css';

interface HomeSidebarProps {
    dmConversations: DMConversation[];
    /** Highlight state for the Friends / Tasks nav rows. */
    friendsActive: boolean;
    tasksActive: boolean;
    /** Pending friend-request count shown as a badge on the Friends row. */
    pendingBadge?: number;
    /** The open conversation, for row highlighting (null when browsing). */
    activeDMId?: string | null;
    searchQuery: string;
    onSearchQueryChange: (q: string) => void;
    onNavFriends: () => void;
    onNavTasks: () => void;
    onSelectDM: (conv: DMConversation) => void;
    onStartUserDM: (user: SearchUserResult) => void;
}

/**
 * The home/DM left column — search, Friends/Tasks nav, and the Direct
 * Messages list. Shared between the Friends dashboard (FriendsPanel) and the
 * open-DM view (Chat's sidebar when no server is selected) so the two look
 * and behave identically: clicking a DM swaps only the main content, never
 * the left column.
 */
export function HomeSidebar({
    dmConversations,
    friendsActive,
    tasksActive,
    pendingBadge = 0,
    activeDMId = null,
    searchQuery,
    onSearchQueryChange,
    onNavFriends,
    onNavTasks,
    onSelectDM,
    onStartUserDM,
}: HomeSidebarProps) {
    const [searchResults, setSearchResults] = useState<SearchUserResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    // Debounced user search for "find or start a conversation".
    useEffect(() => {
        if (searchQuery.length < 1) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- clear results when query emptied
            setSearchResults([]);
            return;
        }
        const timer = setTimeout(async () => {
            setIsSearching(true);
            try {
                const results = await searchUsers(searchQuery);
                setSearchResults(results);
            } catch (err) {
                console.error('Search failed:', err);
            }
            setIsSearching(false);
        }, 300);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    // Conversations keep the server's most-recent-first order. ("Notes to
    // self" used to pin to the top; the Tasks feature replaced it.)
    const sortedConversations = dmConversations;

    return (
        <div className="friends-sidebar">
            <div className="sidebar-search">
                <input
                    ref={searchInputRef}
                    type="text"
                    placeholder="Find or start a conversation"
                    value={searchQuery}
                    onChange={e => onSearchQueryChange(e.target.value)}
                />
            </div>

            <div className="sidebar-nav">
                <div
                    className={`nav-item ${friendsActive ? 'active' : ''}`}
                    onClick={onNavFriends}
                >
                    <span className="nav-icon"><MembersIcon /></span>
                    <span>Friends</span>
                    {pendingBadge > 0 && <span className="nav-badge">{pendingBadge}</span>}
                </div>
                <div
                    className={`nav-item ${tasksActive ? 'active' : ''}`}
                    onClick={onNavTasks}
                >
                    <span className="nav-icon"><TasksIcon /></span>
                    <span>Tasks</span>
                </div>
            </div>

            <div className="dm-section">
                <div className="dm-header">
                    <span>Direct Messages</span>
                    {/* DMs start from user search — point the + at it. */}
                    <button
                        className="dm-add-btn"
                        title="Create DM"
                        onClick={() => searchInputRef.current?.focus()}
                    >
                        +
                    </button>
                </div>
                <div className="dm-list">
                    {/* Show search results when searching */}
                    {searchQuery.length > 0 && (
                        <>
                            <div className="search-results-header">Users</div>
                            {isSearching ? (
                                <div className="dm-empty">Searching...</div>
                            ) : searchResults.length > 0 ? (
                                searchResults.map(user => (
                                    <div
                                        key={user.id}
                                        className="dm-item search-result"
                                        onClick={() => onStartUserDM(user)}
                                    >
                                        <div className={`dm-avatar ${user.is_online ? 'online' : ''}`}>
                                            {user.username.charAt(0).toUpperCase()}
                                        </div>
                                        <span className="dm-username">{user.username}</span>
                                        {user.is_online && <span className="online-indicator">●</span>}
                                    </div>
                                ))
                            ) : (
                                <div className="dm-empty">No users found</div>
                            )}
                        </>
                    )}

                    {/* Show existing conversations when not searching */}
                    {searchQuery.length === 0 && sortedConversations.map(conv => (
                        <div
                            key={conv.id}
                            className={`dm-item ${activeDMId === conv.id ? 'active' : ''}`}
                            onClick={() => onSelectDM(conv)}
                        >
                            <div className="dm-avatar">
                                {conv.other_username.charAt(0).toUpperCase()}
                            </div>
                            <span className="dm-username">
                                {conv.other_username}
                            </span>
                        </div>
                    ))}
                    {searchQuery.length === 0 && dmConversations.length === 0 && (
                        <div className="dm-empty">No conversations yet</div>
                    )}
                </div>
            </div>
        </div>
    );
}
