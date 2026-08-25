import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { getReactions, addReaction, removeReaction, listEmojis, onReactionChanged } from '../api/reactions';
import type { Reaction, CustomEmoji } from '../api/reactions';
import { wsClient, type ServerMessage } from '../api/websocket';
import { EmojiPicker } from './EmojiPicker';
import { PlusIcon } from './Icons';
import './MessageReactions.css';
import { AuthedImg } from './AuthedImg';

interface MessageReactionsProps {
    messageId: string;
    currentUserId: number;
    serverId?: string;
    /** Open the full picker from OUTSIDE this component — the long-press
     *  context menu's "Add Reaction" on touch, where the inline + button is
     *  hidden (MessageReactions.css). A fresh nonce opens the picker anchored
     *  at (x, y), the press point; the trigger button can't anchor it there
     *  because display:none rects measure 0x0. */
    openRequest?: { nonce: number; x: number; y: number };
}

export function MessageReactions({ messageId, currentUserId, serverId, openRequest }: MessageReactionsProps) {
    const [reactions, setReactions] = useState<Reaction[]>([]);
    const [showPicker, setShowPicker] = useState(false);
    const [loading, setLoading] = useState(true);
    const [customEmojis, setCustomEmojis] = useState<CustomEmoji[]>([]);
    const pickerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    // Viewport-fixed position for the picker. The picker is portaled to
    // <body> so it can never be clipped by the message list's overflow — that
    // clipping is what previously chopped the picker down to ~6 emojis when the
    // message sat high on screen (the search box + tabs + top rows fell above
    // the scroll viewport). Null until measured.
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    // Anchor override for context-menu opens: the press point stands in for
    // the (hidden) trigger button's rect. Cleared when the picker closes.
    const anchorRef = useRef<{ x: number; y: number } | null>(null);

    // Honour an outside open request exactly once per nonce. The ref starts at
    // the CURRENT nonce, not 0: a message row remounting with a stale request
    // in props must not pop the picker open again.
    const handledNonce = useRef(openRequest?.nonce ?? 0);
    useEffect(() => {
        if (openRequest && openRequest.nonce !== handledNonce.current) {
            handledNonce.current = openRequest.nonce;
            anchorRef.current = { x: openRequest.x, y: openRequest.y };
            setShowPicker(true);
        }
    }, [openRequest]);

    // Place the picker relative to the add-reaction trigger (or the long-press
    // anchor): prefer opening upward, flip below when there isn't room, and
    // clamp to the viewport so it's always fully visible.
    const positionPicker = useCallback(() => {
        const trigger = triggerRef.current;
        const pop = popoverRef.current;
        if (!pop) return;
        const anchor = anchorRef.current;
        if (!trigger && !anchor) return;
        const b = anchor
            ? { top: anchor.y, bottom: anchor.y, left: anchor.x }
            : trigger!.getBoundingClientRect();
        const pw = pop.offsetWidth || 370;
        const ph = pop.offsetHeight || 440;
        const margin = 8;
        let top = b.top - ph - 4; // above the trigger
        if (top < margin) {
            const below = b.bottom + 4;
            top = below + ph <= window.innerHeight - margin
                ? below
                : Math.max(margin, window.innerHeight - ph - margin);
        }
        let left = b.left;
        if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
        if (left < margin) left = margin;
        setPos({ top, left });
    }, []);

    // Measure + position on open (useLayoutEffect runs before paint, so the
    // picker never flashes at the wrong spot), and keep it anchored while the
    // page scrolls or resizes underneath it.
    //
    // `loading` is a REAL dependency, not noise: an openRequest can arrive
    // while the initial reactions fetch is still in flight, when this whole
    // component renders null — showPicker flips true but there is no popover
    // DOM to measure, so positionPicker() bails and `pos` stays null. The
    // popover then mounts on the loading→false render at -9999/hidden, and
    // without `loading` here nothing would ever measure it again: an
    // invisible, permanently "open" picker (review finding, 0811; pinned by
    // tests/messageReactionsOpenRequest.test.tsx).
    useLayoutEffect(() => {
        if (!showPicker) { setPos(null); anchorRef.current = null; return; }
        positionPicker();
        window.addEventListener('scroll', positionPicker, true);
        window.addEventListener('resize', positionPicker);
        return () => {
            window.removeEventListener('scroll', positionPicker, true);
            window.removeEventListener('resize', positionPicker);
        };
    }, [showPicker, positionPicker, loading]);

    // Close picker when clicking outside
    useEffect(() => {
        if (!showPicker) return;

        const handleClickOutside = (e: MouseEvent | TouchEvent) => {
            const target = e.target as Node;
            // The picker is portaled out of this subtree, so check it separately
            // from the trigger wrapper — otherwise clicks inside the picker read
            // as "outside" and close it before an emoji can be selected.
            if (pickerRef.current?.contains(target)) return;
            if (popoverRef.current?.contains(target)) return;
            setShowPicker(false);
        };

        // Use both mouse and touch for mobile
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('touchstart', handleClickOutside);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('touchstart', handleClickOutside);
        };
    }, [showPicker]);

    useEffect(() => {
        loadReactions();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messageId]);

    // Real-time: refetch when anyone adds/removes a reaction on this message.
    useEffect(() => {
        const handleReactionUpdate = (msg: ServerMessage) => {
            const payload = msg.payload as { message_id?: string } | undefined;
            if (payload?.message_id === messageId) {
                loadReactions();
            }
        };
        wsClient.on('ReactionUpdate', handleReactionUpdate);
        // Local nudge for views with no channel room joined (collection view),
        // where the WS echo never arrives — the hover toolbar fires this after
        // adding a reaction.
        const offLocal = onReactionChanged(id => { if (id === messageId) loadReactions(); });
        return () => {
            wsClient.off('ReactionUpdate', handleReactionUpdate);
            offLocal();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messageId]);

    useEffect(() => {
        if (showPicker && serverId) {
            loadCustomEmojis();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showPicker, serverId]);

    // If a custom-emoji reaction arrives (e.g. from another user) before this
    // client ever opened the picker, the name→image mapping isn't loaded yet
    // and the reaction would render as ":name:" text. Load it on demand.
    useEffect(() => {
        if (
            serverId &&
            customEmojis.length === 0 &&
            reactions.some(r => r.emoji.startsWith(':') && r.emoji.endsWith(':'))
        ) {
            loadCustomEmojis();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reactions, serverId]);

    const loadReactions = async () => {
        try {
            const data = await getReactions(messageId);
            setReactions(data);
        } catch {
            setReactions([]);
        }
        setLoading(false);
    };

    const loadCustomEmojis = async () => {
        if (!serverId) return;
        try {
            const emojis = await listEmojis(serverId);
            setCustomEmojis(emojis);
        } catch (err) {
            console.error('Failed to load custom emojis:', err);
        }
    };

    // Optimistically add the current user's reaction to local state for instant feedback.
    const optimisticAdd = (emoji: string) => {
        setReactions(prev => {
            const existing = prev.find(r => r.emoji === emoji);
            if (existing) {
                if (existing.users.some(u => u.id === currentUserId)) return prev;
                return prev.map(r => r.emoji === emoji
                    ? { ...r, count: r.count + 1, users: [...r.users, { id: currentUserId, username: 'You' }] }
                    : r);
            }
            return [...prev, { emoji, count: 1, users: [{ id: currentUserId, username: 'You' }] }];
        });
    };

    const optimisticRemove = (emoji: string) => {
        setReactions(prev => prev.flatMap(r => {
            if (r.emoji !== emoji) return [r];
            const users = r.users.filter(u => u.id !== currentUserId);
            return users.length ? [{ ...r, count: Math.max(0, r.count - 1), users }] : [];
        }));
    };

    const handleReactionClick = async (emoji: string) => {
        const existing = reactions.find(r => r.emoji === emoji);
        const userHasReacted = existing?.users.some(u => u.id === currentUserId) ?? false;

        // Update the UI immediately, then reconcile with the server.
        if (userHasReacted) optimisticRemove(emoji); else optimisticAdd(emoji);
        try {
            if (userHasReacted) {
                await removeReaction(messageId, emoji);
            } else {
                await addReaction(messageId, emoji);
            }
        } catch (err) {
            console.error('Failed to toggle reaction:', err);
        }
        await loadReactions();
    };

    const handleAddNewReaction = async (emoji: string, isCustom = false) => {
        optimisticAdd(emoji);
        setShowPicker(false);
        try {
            await addReaction(messageId, emoji, isCustom);
        } catch (err) {
            console.error('Failed to add reaction:', err);
        }
        await loadReactions();
    };

    if (loading) return null;

    // Check if a reaction is a custom emoji (starts with :)
    const isCustomEmojiReaction = (emoji: string) => emoji.startsWith(':') && emoji.endsWith(':');

    // Render custom emoji image or regular emoji
    const renderEmoji = (emoji: string) => {
        if (isCustomEmojiReaction(emoji)) {
            const name = emoji.slice(1, -1);
            const custom = customEmojis.find(e => e.name === name);
            if (custom) {
                return <AuthedImg fileId={custom.url.replace('/files/', '')} alt={name} className="custom-emoji-img" />;
            }
        }
        return emoji;
    };

    return (
        <div className={`message-reactions ${reactions.length === 0 ? 'empty' : ''}`}>
            {reactions.length > 0 && (
                <div className="reactions-list">
                    {reactions.map(reaction => {
                        const userHasReacted = reaction.users.some(u => u.id === currentUserId);
                        return (
                            <button
                                key={reaction.emoji}
                                className={`reaction-badge ${userHasReacted ? 'active' : ''}`}
                                onClick={() => handleReactionClick(reaction.emoji)}
                                title={reaction.users.map(u => u.username).join(', ')}
                            >
                                <span className="reaction-emoji">{renderEmoji(reaction.emoji)}</span>
                                <span className="reaction-count">{reaction.count}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            <div className="add-reaction-wrapper" ref={pickerRef}>
                <button
                    ref={triggerRef}
                    className="add-reaction-btn"
                    onClick={() => setShowPicker(!showPicker)}
                    title="Add Reaction"
                >
                    <PlusIcon />
                </button>
                {showPicker && createPortal(
                    <div
                        className="reaction-picker"
                        ref={popoverRef}
                        style={{
                            position: 'fixed',
                            top: pos?.top ?? -9999,
                            left: pos?.left ?? -9999,
                            bottom: 'auto',
                            margin: 0,
                            zIndex: 3000,
                            visibility: pos ? 'visible' : 'hidden',
                        }}
                    >
                        {/* Custom server emojis (shown above the standard picker) */}
                        {customEmojis.length > 0 && (
                            <div className="reaction-custom-row">
                                {customEmojis.map(emoji => (
                                    <button
                                        key={emoji.id}
                                        className="picker-emoji custom"
                                        onClick={() => handleAddNewReaction(`:${emoji.name}:`, true)}
                                        title={`:${emoji.name}:`}
                                    >
                                        <AuthedImg
                                            fileId={emoji.url.replace('/files/', '')}
                                            alt={emoji.name}
                                        />
                                    </button>
                                ))}
                            </div>
                        )}
                        {/* Full standard emoji picker (categories + search) */}
                        <EmojiPicker
                            onSelect={(emoji) => handleAddNewReaction(emoji)}
                            onClose={() => setShowPicker(false)}
                        />
                    </div>,
                    document.body
                )}
            </div>
        </div>
    );
}
