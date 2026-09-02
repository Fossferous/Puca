import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { Server } from '../api/servers';
import { markServerRead, reorderServers } from '../api/servers';
import { useServers } from '../hooks/queries';
import { getServerNotifyLevel, isServerMuted, setServerNotifyLevel, toggleServerMute, type ServerNotifyLevel } from './mutedServersStore';
import { isHideMutedChannels, toggleHideMutedChannels } from './mutedChannelsStore';
import { serverUnreadCount, subscribeServerUnread } from './unreadStore';
import './ServerList.css';
import { AuthedImg } from './AuthedImg';
import {
    BellIcon, BellOffIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CompassIcon,
    CopyIcon, DisbandIcon, EyeIcon, LogoutIcon, MailOpenIcon, MessageIcon, MonitorIcon,
    NoteIcon, SettingsIcon, UserAddIcon, UserIcon,
} from './Icons';

interface ServerListProps {
    // servers prop removed
    currentServerId: string | null;
    onSelectServer: (server: Server) => void;
    onCreateServer: () => void;
    onJoinServer: () => void;
    /** Open the Tasks & notes dashboard (the Friends panel's Tasks view). */
    onOpenNotes?: () => void;
    /** Open the Devices view. */
    onOpenDevices?: () => void;
    /** Highlight the Devices rail button while the view is showing. */
    devicesActive?: boolean;
    /** Highlight the Notes rail button while the Tasks view is showing. */
    notesActive?: boolean;
    showingFriends?: boolean;
    onShowFriends?: () => void;
    onInviteToServer?: (server: Server) => void;
    /** Whether the signed-in user may create invites on the CURRENT server.
     *  Undefined = unknown (another server's icon, channels not loaded, a
     *  pre-permissions backend): the item stays, and the server remains the
     *  authority. false hides it — offering an action that will 403 is not
     *  a menu, it is a trap. */
    canInviteCurrent?: boolean;
    onServerSettings?: (server: Server) => void;
    onLeaveServer?: (server: Server) => void;
    onDisbandServer?: (server: Server) => void;
    /** Called after a server is marked read so the parent can clear its
     *  unread badges (only the current server has live badge state). */
    onMarkedRead?: (serverId: string) => void;
    /** Open the per-server profile editor (nickname on this server). */
    onEditServerProfile?: (server: Server) => void;
    currentUserId?: number;
}

interface ContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    server: Server | null;
}

const NOTIFY_LEVEL_LABELS: Record<ServerNotifyLevel, string> = {
    all: 'All Messages',
    mentions: 'Mentions Only',
    nothing: 'Nothing',
};

export function ServerList({
    // servers prop removed
    currentServerId,
    onSelectServer,
    onCreateServer,
    onJoinServer,
    onOpenNotes,
    onOpenDevices,
    devicesActive = false,
    notesActive = false,
    showingFriends = false,
    onShowFriends,
    onInviteToServer,
    canInviteCurrent,
    onServerSettings,
    onLeaveServer,
    onDisbandServer,
    onMarkedRead,
    onEditServerProfile,
    currentUserId,
}: ServerListProps) {
    const { data: servers = [] } = useServers();
    const [draggingServerId, setDraggingServerId] = useState<string | null>(null);
    // Re-render when the cross-server unread totals change (unreadStore is
    // hydrated and bumped by Chat; this component only renders it).
    const [, setUnreadRev] = useState(0);
    useEffect(() => subscribeServerUnread(() => setUnreadRev(r => r + 1)), []);
    const [localOrder, setLocalOrder] = useState<string[]>(() => {
        try {
            const saved = localStorage.getItem('sovereign_server_order');
            return saved ? JSON.parse(saved) : [];
        } catch {
            return [];
        }
    });

    // Compute ordered servers based on localOrder + any new servers not yet in order
    const orderedServers = useMemo(() => {
        if (!servers.length) return [];
        const serverMap = new Map(servers.map(s => [s.id, s]));
        const ordered: Server[] = [];

        // Add existing servers in order
        localOrder.forEach(id => {
            const s = serverMap.get(id);
            if (s) {
                ordered.push(s);
                serverMap.delete(id);
            }
        });

        // Append any remaining servers in the order the backend sent them —
        // that's the user's saved per-member position (migration 036), so a
        // fresh device shows the same rail without any localStorage.
        return [...ordered, ...Array.from(serverMap.values())];
    }, [servers, localOrder]);

    // --- Rail drag-to-reorder ------------------------------------------------
    // Pointer-events based, NOT HTML5 drag-and-drop: WebView2 (the desktop app)
    // never fires dragover/drop for webview content while Tauri's native
    // drag-drop handler is active (same reason Chat.tsx's file-drop uses mouse
    // events), so `draggable` silently did nothing there. Pointer events work
    // on every surface. Mouse-only for now — the mobile rail scrolls by touch.
    const railRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ id: string; startY: number; moved: boolean } | null>(null);
    const suppressClickRef = useRef(false);

    const handlePointerDown = (e: React.PointerEvent, serverId: string) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        dragRef.current = { id: serverId, startY: e.clientY, moved: false };
    };

    // The React Compiler can't preserve this callback's memoization because it
    // mutates dragRef.current (line below) — a deliberate imperative-drag pattern,
    // safe at runtime (refs are stable, deps are correct). Suppress the
    // compiler-optimization lint rather than restructure the working drag logic.
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    const finishDrag = useCallback((commit: boolean) => {
        const drag = dragRef.current;
        dragRef.current = null;
        setDraggingServerId(null);
        if (!drag?.moved) return;
        // A drag must not count as a click on the icon underneath.
        suppressClickRef.current = true;
        setTimeout(() => { suppressClickRef.current = false; }, 0);
        if (!commit) return;
        setLocalOrder(current => {
            localStorage.setItem('sovereign_server_order', JSON.stringify(current));
            // Persist per-user order server-side so every device agrees.
            reorderServers(current).catch(err => console.error('Failed to save server order:', err));
            return current;
        });
    }, []);

    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag) return;
            if (!drag.moved && Math.abs(e.clientY - drag.startY) < 6) return;
            if (!drag.moved) {
                drag.moved = true;
                setDraggingServerId(drag.id);
                // From here on the full rail order is authoritative local state.
                setLocalOrder(orderedServers.map(s => s.id));
            }
            const rail = railRef.current;
            if (!rail) return;
            // Live-reorder: find which icon the pointer is over and move the
            // dragged id to that slot (immediate live-reorder feedback).
            const icons = [...rail.querySelectorAll<HTMLElement>('.server-icon')];
            const overIndex = icons.findIndex(el => {
                const r = el.getBoundingClientRect();
                return e.clientY >= r.top && e.clientY <= r.bottom;
            });
            if (overIndex === -1) return;
            setLocalOrder(current => {
                const fromIndex = current.indexOf(drag.id);
                if (fromIndex === -1 || fromIndex === overIndex) return current;
                const next = [...current];
                next.splice(fromIndex, 1);
                next.splice(Math.min(overIndex, next.length), 0, drag.id);
                return next;
            });
        };
        const onUp = () => { if (dragRef.current) finishDrag(true); };
        const onCancel = () => { if (dragRef.current) finishDrag(false); };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onCancel);
        };
    }, [orderedServers, finishDrag]);

    const [contextMenu, setContextMenu] = useState<ContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
        server: null,
    });
    const menuRef = useRef<HTMLDivElement>(null);
    // Notification-level submenu open state; reset when the menu (re)opens.
    const [showNotifySubmenu, setShowNotifySubmenu] = useState(false);
    // Bump to re-render after writing a store the menu reads at render time
    // (notify level, hide-muted) without closing the menu.
    const [, setMenuTick] = useState(0);

    // Re-render when a server's mute state flips (the greyed icon + menu label
    // read isServerMuted() at render time).
    const [, setMuteRev] = useState(0);
    useEffect(() => {
        const bump = () => setMuteRev(r => r + 1);
        window.addEventListener('serverMuteChanged', bump);
        return () => window.removeEventListener('serverMuteChanged', bump);
    }, []);

    // Close context menu when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setContextMenu(prev => ({ ...prev, visible: false }));
            }
        };

        if (contextMenu.visible) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [contextMenu.visible]);

    const handleContextMenu = (e: React.MouseEvent, server: Server) => {
        e.preventDefault();
        e.stopPropagation();

        // Position menu near click, but ensure it stays on screen
        const x = Math.min(e.clientX, window.innerWidth - 220);
        const y = Math.min(e.clientY, window.innerHeight - 350);

        setShowNotifySubmenu(false);
        setContextMenu({
            visible: true,
            x,
            y,
            server,
        });
    };

    const closeMenu = () => {
        setShowNotifySubmenu(false);
        setContextMenu(prev => ({ ...prev, visible: false }));
    };

    const handleCopyServerId = () => {
        if (contextMenu.server) {
            navigator.clipboard.writeText(contextMenu.server.id.toString());
        }
        closeMenu();
    };

    const handleMarkAsRead = () => {
        const serverId = contextMenu.server?.id;
        closeMenu();
        if (!serverId) return;
        markServerRead(serverId)
            .then(() => onMarkedRead?.(serverId))
            .catch(err => console.error('Failed to mark server read:', err));
    };

    const handleInvite = () => {
        if (contextMenu.server && onInviteToServer) {
            onInviteToServer(contextMenu.server);
        }
        closeMenu();
    };

    const handleSettings = () => {
        if (contextMenu.server && onServerSettings) {
            onServerSettings(contextMenu.server);
        }
        closeMenu();
    };

    const handleLeave = () => {
        if (contextMenu.server && onLeaveServer) {
            if (confirm(`Are you sure you want to leave "${contextMenu.server.name}"?`)) {
                onLeaveServer(contextMenu.server);
            }
        }
        closeMenu();
    };

    const handleDisband = () => {
        if (contextMenu.server && onDisbandServer) {
            if (confirm(`Are you sure you want to PERMANENTLY DELETE "${contextMenu.server.name}"? This cannot be undone!`)) {
                onDisbandServer(contextMenu.server);
            }
        }
        closeMenu();
    };

    const isOwner = contextMenu.server?.owner_id === currentUserId;

    return (
        <div className="server-list">
            {/* Home/Direct Messages Button - Always pinned at the top of the rail */}
            <div
                className={`server-icon home-button ${showingFriends ? 'active' : ''}`}
                onClick={onShowFriends}
                title="Direct Messages"
            >
                <div className="server-icon-inner home"><MessageIcon size={26} /></div>
            </div>

            <div className="server-separator"></div>

            {/* Server Icons */}
            <div className="server-icons" ref={railRef}>
                {orderedServers.map(server => (
                    <div
                        key={server.id}
                        className={`server-icon ${currentServerId === server.id && !showingFriends ? 'active' : ''} ${draggingServerId === server.id ? 'dragging' : ''} ${isServerMuted(server.id) ? 'muted' : ''}`}
                        onClick={() => { if (!suppressClickRef.current) onSelectServer(server); }}
                        onContextMenu={(e) => handleContextMenu(e, server)}
                        title={server.name}
                        onPointerDown={(e) => handlePointerDown(e, server.id)}
                    >
                        <div className="server-icon-inner">
                            {server.icon_file_id ? (
                                <AuthedImg
                                    fileId={server.icon_file_id}
                                    alt={server.name}
                                    className="server-icon-image"
                                    // Native image-drag would pointercancel the
                                    // rail's pointer-based reorder drag.
                                    draggable={false}
                                />
                            ) : (
                                server.name.charAt(0).toUpperCase()
                            )}
                        </div>
                        {/* Unread bubble: suppressed for muted servers and for
                            the server on screen (its channel badges carry the
                            detail there). */}
                        {!isServerMuted(server.id)
                            && !(currentServerId === server.id && !showingFriends)
                            && serverUnreadCount(server.id) > 0 && (
                            <div className="server-unread-bubble">
                                {serverUnreadCount(server.id) > 99 ? '99+' : serverUnreadCount(server.id)}
                            </div>
                        )}
                        {currentServerId === server.id && !showingFriends && (
                            <div className="server-indicator"></div>
                        )}
                    </div>
                ))}
            </div>

            {/* Action Buttons */}
            <div className="server-add-wrapper">
                {/* Devices — first-class view, highlighted like Tasks while open */}
                {onOpenDevices && (
                    <div
                        className={`server-icon devices-button ${devicesActive ? 'active' : ''}`}
                        onClick={onOpenDevices}
                        title="Devices — control and browse your machines"
                    >
                        <div className="server-icon-inner devices"><MonitorIcon size={26} /></div>
                        {devicesActive && <div className="server-indicator"></div>}
                    </div>
                )}

                {/* Tasks & notes — the personal + cross-server task dashboard */}
                {onOpenNotes && (
                    <div
                        className={`server-icon notes-self ${notesActive ? 'active' : ''}`}
                        onClick={onOpenNotes}
                        title="Tasks & notes — your lists and every server's checklists"
                    >
                        <div className="server-icon-inner notes"><NoteIcon size={26} /></div>
                        {notesActive && <div className="server-indicator"></div>}
                    </div>
                )}

                {/* Discover/Join Server Button */}
                <div
                    className="server-icon discover-server"
                    onClick={onJoinServer}
                    title="Join a Server"
                >
                    <div className="server-icon-inner discover"><CompassIcon size={26} /></div>
                </div>

                {/* Create Server Button */}
                <div
                    className="server-icon add-server"
                    onClick={onCreateServer}
                    title="Create a Server"
                >
                    <div className="server-icon-inner add">+</div>
                </div>
            </div>

            {/* Server Context Menu */}
            {contextMenu.visible && contextMenu.server && (
                <div
                    ref={menuRef}
                    className="server-context-menu"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                    <div className="context-menu-item" onClick={handleMarkAsRead}>
                        <span className="menu-icon"><MailOpenIcon /></span>
                        Mark as Read
                    </div>

                    {!(contextMenu.server.id === currentServerId && canInviteCurrent === false) && (
                        <>
                            <div className="context-menu-separator" />

                            <div className="context-menu-item" onClick={handleInvite}>
                                <span className="menu-icon"><UserAddIcon /></span>
                                Invite People
                            </div>
                        </>
                    )}

                    <div className="context-menu-separator" />

                    <div
                        className="context-menu-item"
                        onClick={() => {
                            if (contextMenu.server) toggleServerMute(contextMenu.server.id);
                            closeMenu();
                        }}
                    >
                        {/* A bell, not a speaker: this mutes NOTIFICATIONS, and the
                            speaker means literal audio elsewhere (mute a person, mute a
                            stream). It also flips with the label the way Mute Channel
                            does — the icon shows what the click will do. This row used a
                            muted-speaker emoji before the migration, which is how the
                            two mute rows drifted apart. */}
                        <span className="menu-icon">
                            {contextMenu.server && isServerMuted(contextMenu.server.id)
                                ? <BellIcon /> : <BellOffIcon />}
                        </span>
                        {contextMenu.server && isServerMuted(contextMenu.server.id) ? 'Unmute Server' : 'Mute Server'}
                    </div>

                    <div
                        className="context-menu-item has-submenu"
                        onClick={() => setShowNotifySubmenu(v => !v)}
                    >
                        <span className="menu-icon"><BellIcon /></span>
                        <div className="menu-text">
                            <span>Notification Settings</span>
                            <span className="menu-subtitle">
                                {NOTIFY_LEVEL_LABELS[getServerNotifyLevel(contextMenu.server.id)]}
                            </span>
                        </div>
                        <span className="submenu-arrow">{showNotifySubmenu ? <ChevronDownIcon /> : <ChevronRightIcon />}</span>
                    </div>
                    {showNotifySubmenu && (
                        <div className="context-submenu">
                            {(Object.keys(NOTIFY_LEVEL_LABELS) as ServerNotifyLevel[]).map(level => (
                                <div
                                    key={level}
                                    className="context-menu-item"
                                    onClick={() => {
                                        if (contextMenu.server) setServerNotifyLevel(contextMenu.server.id, level);
                                        setMenuTick(t => t + 1);
                                        setShowNotifySubmenu(false);
                                    }}
                                >
                                    <span className="menu-icon">
                                        {contextMenu.server && getServerNotifyLevel(contextMenu.server.id) === level ? <CheckIcon /> : null}
                                    </span>
                                    <div className="menu-text">
                                        <span>{NOTIFY_LEVEL_LABELS[level]}</span>
                                        {level === 'mentions' && (
                                            <span className="menu-subtitle">Mentions ping in the channel you're viewing</span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <div
                        className="context-menu-item has-toggle"
                        onClick={() => {
                            if (contextMenu.server) toggleHideMutedChannels(contextMenu.server.id);
                            setMenuTick(t => t + 1);
                        }}
                    >
                        <span className="menu-icon"><EyeIcon /></span>
                        Hide Muted Channels
                        <span className={`toggle-switch ${isHideMutedChannels(contextMenu.server.id) ? 'active' : ''}`}></span>
                    </div>

                    <div className="context-menu-separator" />

                    {(isOwner || contextMenu.server.owner_id === currentUserId) && (
                        <div className="context-menu-item" onClick={handleSettings}>
                            <span className="menu-icon"><SettingsIcon /></span>
                            Server Settings
                        </div>
                    )}

                    <div
                        className="context-menu-item"
                        onClick={() => {
                            if (contextMenu.server) onEditServerProfile?.(contextMenu.server);
                            closeMenu();
                        }}
                    >
                        <span className="menu-icon"><UserIcon /></span>
                        Edit Server Profile
                    </div>

                    <div className="context-menu-separator" />

                    {isOwner ? (
                        <div className="context-menu-item danger" onClick={handleDisband}>
                            <span className="menu-icon"><DisbandIcon /></span>
                            Disband Server
                        </div>
                    ) : (
                        <div className="context-menu-item danger" onClick={handleLeave}>
                            <span className="menu-icon"><LogoutIcon /></span>
                            Leave Server
                        </div>
                    )}

                    <div className="context-menu-item" onClick={handleCopyServerId}>
                        <span className="menu-icon"><CopyIcon /></span>
                        Copy Server ID
                        <span className="menu-badge">ID</span>
                    </div>
                </div>
            )}
        </div>
    );
}
