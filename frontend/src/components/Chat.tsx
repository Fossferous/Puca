import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { wsClient, type ServerMessage } from '../api/websocket';
import { VoicePanel } from './VoicePanel';
import { getVoiceUsersInRoom, globalVoiceUsers, globalCameraUsers, isUserStreaming, isUserSpeaking, subscribeToStreamState, subscribeToVoiceUsers, getSelectedStreams, getAllStreamers, selectStream, upsertVoiceUser } from './voiceState';
import { useStreamStore } from '../stores/streamStore';
import type { VoiceUserStatus } from './voiceState';
import './FileUpload.css';
import { StreamStage } from './StreamStage';
import { VoiceStage } from './VoiceStage';
import { ServerList } from './ServerList';
import { ServerCreateWizard } from './ServerCreateWizard';
import { JoinServerModal } from './JoinServerModal';
import { InviteModal } from './InviteModal';
import { ServerSettingsModal } from './ServerSettingsModal';
import { DevicesView } from './DevicesView';
import { UserProfilePopup } from './UserProfilePopup';
import { ContextMenu } from './ContextMenu';
import { useContextMenu, menuItems, imageMenuItems, formatQuote, stripAttachmentKeys, replyPreviewText } from './contextMenuUtils';
import { clipsAvailable, focusClipProposal, refreshPendingClips } from '../api/clips/clipProposals';
import { hasClipRef } from '../api/clips/clipRef';
import { Toast } from './Toast';
import { MessageToasts } from './MessageToasts';
import { pushMessageToast } from './messageToastBus';
import { hideMessage, isMessageHidden, unhideMessage } from './hiddenMessagesStore';
import {
    bumpServerUnread, clearServerUnread, hydrateServerUnread, refreshServerUnreadSoon,
} from './unreadStore';
import { addReaction, notifyReactionChanged } from '../api/reactions';
import { ForwardModal } from './ForwardModal';
import { getToken } from '../api/auth';
import { appIsForeground, isMobile as isNativeMobile } from '../api/platform';
import {
    // getOrCreateDefaultServer removed - no auto-join default server
    listServers,
    createChannel,
    deleteChannel,
    createServer,
    leaveServer,
    deleteServer,
    getMessages,
    sendChannelMessageEncrypted,
    editChannelMessageEncrypted,
    decryptChannelMessages,
    decryptChannelContent,
    deleteMessage as deleteMessageApi,
    pinMessage,
    unpinMessage,
    listPinnedMessages,
    type PinnedMessage,
    getUnreadCounts,
    markChannelRead,
    toggleTaskCompletion,
    reorderChannels,
    setServerNickname,
    listMembersWithRoles,
    kickMember,
    banMember,
    moveMemberVoice,
    listChannels,
    setMemberCustomSoundsDisabled,
    fetchVoiceUsers,
    type Server,
    type Channel,
    type Message as ApiMessage,
    type ClipConsent,
    type MemberWithRoles,
    type ChannelUnreadCount,
} from '../api/servers';
import {
    getDMMessages,
    listDMConversations,
    startDMConversation,
    encryptDMContent,
    decryptDMContent,
    decryptDMMessages,
    type DMConversation,
    type DMMessage,
    type SearchUserResult,
} from '../api/dms';
import { SecureSendError, messageEncState, type MessageEncState } from '../api/e2ee';
import { HomeSidebar } from './HomeSidebar';
import { encryptAndUploadRef, parseEncAttachment } from '../api/attachments';
import { FileTooLargeError, MAX_UPLOAD_BYTES, discardUpload } from '../api/uploads';
import {
    buildOutgoingContent,
    canSendComposer,
    markFailed,
    markReady,
    markUploading,
    pendingAttachment,
    removeAttachment,
    toggleSpoiler as toggleChipSpoiler,
    type PendingAttachment,
} from '../api/composerAttachments';
import { ComposerAttachments } from './ComposerAttachments';
import { ApiError, isNetworkError } from '../api/client';
import { decodeJwtPayload } from '../api/auth';
import { fileTransferManager, p2pTransfersEnabled } from '../api/fileTransferManager';
import { FileTransfers } from './FileTransfers';
import { prepareSink } from '../api/transferSinks';
import { MessageContent } from './MessageContent';
import { messageMentionsUser } from '../utils/messageMentions';
import { FriendsPanel } from './FriendsPanel';
import { MessageReactions } from './MessageReactions';
import { UserProfileSettings } from './UserProfileSettings';
import { SettingsModal } from './SettingsModal';
import { UserContextMenu } from './UserContextMenu';
import { LinkPreview } from './LinkPreview';
import { EmojiPicker } from './EmojiPicker';
import { WelcomePopup } from './WelcomePopup';
import { EditChannelModal } from './EditChannelModal';
import { ChecklistPanel } from './ChecklistPanel';
import { ChecklistBody } from './ChecklistBody';
import { AllChecklistsView } from './AllChecklistsView';
import { StreamPip } from './StreamPip';
import { StreamPopout } from './StreamPopout';
import { StreamDocPipWindow } from './StreamDocPipWindow';
import { docPipSupported, popoutMode, togglePopped } from './streamDocPip';
import { primePipSupport } from './streamPopout.utils';
import {
    HomeIcon, ChannelsIcon, ChatIcon, MembersIcon, TasksIcon, MonitorIcon,
    HashIcon, ChecklistIcon, FolderIcon, NoteIcon, MessageIcon, CrownIcon,
    SpeakerIcon, MicOffIcon, HeadphonesOffIcon, MoonIcon, ClipIcon,
    CameraIcon, ScreenShareIcon, LiveDotIcon,
    SmileIcon, ReplyIcon, ForwardIcon, PencilIcon, PinIcon, TrashIcon,
    PaperclipIcon, LockIcon, LockOpenIcon, BanIcon, EyeOffIcon, SendIcon,
    CloseIcon, PendingIcon, SettingsIcon, ChevronDownIcon,
    CheckboxIcon, CheckboxCheckedIcon, WarningIcon,
} from './Icons';
import { mediaE2eeExplanation } from '../api/rtc/e2eeStatus';
import { ChannelDashboard } from './ChannelDashboard';
/* StreamViewer removed - now using StreamStage */
import './Chat.css';
import { parseServerTimestampSecs } from '../utils/serverTime';
import { resolveAfkTarget } from '../utils/afkMove';
import { canMoveVoiceMember, voiceMoveTargets } from '../utils/voiceMove';
import { useVoiceMemberDrag } from '../hooks/useVoiceMemberDrag';
import {
    useServers,
    useChannels,
    useServerMembers,
    keys
} from '../hooks/queries';
import { PERM, hasPerm } from '../api/permissionBits';
import { useSwipe } from '../hooks/useSwipe';
import { isServerMuted, isServerQuiet } from './mutedServersStore';
import { isChannelMuted, toggleChannelMute, isHideMutedChannels } from './mutedChannelsStore';
import { playMessageSound, playMentionSound } from '../utils/audioFeedback';
import { registerPress, unregisterPress } from '../api/hotkeys';
import { loadSettings } from './settingsStore';
import { notifyNewMessage } from '../api/desktopNotify';
import { startTaskReminders } from '../api/taskReminders';
import {
    clearMobileNotifications, consumePendingNav, deferNav, mobileAppAvailable,
    syncConversationShortcuts, reportConversationShortcutUsed, initialsIconPng,
} from '../api/mobileApp';
import { setUnreadBadge } from '../api/unreadBadge';
import { SmartAvatar } from './SmartAvatar';
import { isBlocked, loadBlockedUsers, useBlockedUsers } from './blockStore';
import { searchChannel, searchDM, type SearchOutcome } from '../api/searchMessages';


/**
 * The socket was not OPEN at send time. Distinct from SecureSendError so the
 * composer can say "reconnecting, try again" rather than blaming encryption —
 * the two failures need different advice.
 */
class OfflineSendError extends Error {
    constructor() { super('not connected'); this.name = 'OfflineSendError'; }
}

// Read user info from the JWT (no verification needed client-side). Uses the
// shared decoder: a plain `atob` mangles any non-ASCII name, which is why
// "Brónach" showed as "BrÃ³nach" on the profile while messages — decoded from
// the API as real UTF-8 — looked right.
function decodeJwt(token: string): { sub: number; username: string } | null {
    const decoded = decodeJwtPayload(token);
    if (!decoded) return null;
    return { sub: decoded.sub as number, username: decoded.username as string };
}

interface DisplayMessage {
    id: string;
    sender: { id: number; username: string; display_name?: string | null };
    content: string;
    timestamp: number;
    /** The server's created_at string VERBATIM (history-loaded messages).
     *  Echoed as the pagination cursor: reconstructing it from the parsed
     *  seconds float truncates Postgres microseconds to JS milliseconds, and
     *  the strict `<` cursor predicate then skips same-millisecond rows at a
     *  page boundary. */
    created_at?: string;
    edited?: boolean;
    reply_to_id?: string;
    reply_to?: { id: string; username: string; display_name?: string | null; content: string };
    // For collection view - track which channel the message is from
    channelId?: number;
    channelName?: string;
    // Task message fields
    is_task?: boolean;
    is_completed?: boolean;
    parent_message_id?: string;
    /** E2EE state of `content`. `legacy` (server sent plaintext) is flagged in
     *  the bubble so an injected cleartext message can't pose as a decrypted
     *  one (audit H-1). Undefined on optimistic bubbles = treated as secure. */
    encState?: MessageEncState;
    /** Server-stamped consent record on a clip post (docs/CLIPS.md). */
    clip_consent?: ClipConsent | null;
}

interface User {
    id: number;
    username: string;
    display_name?: string | null;
}

/**
 * Small inline badge shown on a message whose content was NOT end-to-end
 * encrypted — i.e. the server delivered plaintext that passed through the
 * decrypt path verbatim (encState 'legacy'). Every other message in this app is
 * E2EE, so without this affordance an injected or legacy cleartext message is
 * indistinguishable from a decrypted one (audit H-1). Rendered only for
 * 'legacy'; 'failed' already shows its own marker text, and 'secure' (the norm)
 * gets no chrome. Mirrors the `.edited-tag` placement next to MessageContent.
 */
function NotEncryptedBadge({ encState }: { encState?: MessageEncState }) {
    if (encState !== 'legacy') return null;
    return (
        <span
            className="not-encrypted-tag"
            title="Not encrypted — this message was sent as plaintext, not end-to-end encrypted."
        >
            <WarningIcon />
            <span>Not encrypted</span>
        </span>
    );
}


// Helper to get member avatar URL from members list
function getMemberAvatar(members: MemberWithRoles[], userId: number): string | null {
    const member = members.find(m => m.id === userId);
    return member?.avatar_file_id || null;
}

// First usable initial from a preference-ordered list of names. Trims each
// candidate so a whitespace-only nickname can't produce a blank avatar.
function avatarInitial(...names: Array<string | null | undefined>): string {
    for (const name of names) {
        const trimmed = name?.trim();
        if (trimmed) return trimmed[0].toUpperCase();
    }
    return '?';
}

// Unified per-message hover toolbar rendered on every message row (server
// channels and DMs alike). Optional handlers control which actions appear —
// DM rows omit Reply/Edit/Pin/Delete because the DM message API has no
// reply_to_id, edit, pin or delete endpoints (only get/send). The React
// button opens a portaled, viewport-clamped quick picker (same technique as
// MessageReactions' full picker, so tall media rows can't push it off-screen)
// and calls addReaction directly: the backend's ReactionUpdate broadcast makes
// the <MessageReactions> strip under the message refresh itself.
interface MessageToolbarProps {
    messageId: string;
    /** Omitted for a clip post — its body carries the clip key (docs/CLIPS.md). */
    onForward?: () => void;
    /** Omitted where there's no composer to quote into (collection view). */
    onQuote?: () => void;
    onReply?: () => void;
    onEdit?: () => void;
    onPin?: () => void;
    /** Delete for EVERYONE (author or Manage Messages). */
    onDelete?: () => void;
    /** Delete for ME — local hide, available on any persisted message. */
    onHide?: () => void;
}

function MessageToolbar({ messageId, onQuote, onForward, onReply, onEdit, onPin, onDelete, onHide }: MessageToolbarProps) {
    // Optimistic local_ ids don't exist server-side yet: every action needing
    // the real id stays disabled until handleSend swaps in the server id.
    // Quote/Forward only need the content, so they stay live.
    const isLocal = messageId.startsWith('local_');
    const [showPicker, setShowPicker] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    // Viewport-fixed picker position; null until measured.
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

    // Prefer opening above the trigger, flip below when there isn't room, and
    // clamp to the viewport so the picker is always fully visible.
    const positionPicker = useCallback(() => {
        const trigger = triggerRef.current;
        const pop = popoverRef.current;
        if (!trigger || !pop) return;
        const b = trigger.getBoundingClientRect();
        const pw = pop.offsetWidth || 280;
        const ph = pop.offsetHeight || 140;
        const margin = 8;
        let top = b.top - ph - 4;
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

    // Position before paint on open; keep anchored under scroll/resize. On close
    // we don't reset `pos` (that synchronous setState-in-effect is unnecessary):
    // the portal isn't rendered while closed, and on reopen positionPicker()
    // re-measures inside this layout effect before the browser paints, so a stale
    // position never shows.
    useLayoutEffect(() => {
        if (!showPicker) return;
        // Measuring the portal's rect and setting its position before paint is the
        // canonical valid use of useLayoutEffect + setState (a one-shot
        // measure-and-place, not a cascading render loop), so the rule's caveat
        // doesn't apply here.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        positionPicker();
        window.addEventListener('scroll', positionPicker, true);
        window.addEventListener('resize', positionPicker);
        return () => {
            window.removeEventListener('scroll', positionPicker, true);
            window.removeEventListener('resize', positionPicker);
        };
    }, [showPicker, positionPicker]);

    // Close on outside click/tap. The picker is portaled out of this subtree,
    // so check it separately from the trigger.
    useEffect(() => {
        if (!showPicker) return;
        const handleClickOutside = (e: MouseEvent | TouchEvent) => {
            const target = e.target as Node;
            if (triggerRef.current?.contains(target)) return;
            if (popoverRef.current?.contains(target)) return;
            setShowPicker(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('touchstart', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('touchstart', handleClickOutside);
        };
    }, [showPicker]);

    const handleReact = async (emoji: string) => {
        try {
            // Quick-row emojis are always standard unicode, never :custom:.
            await addReaction(messageId, emoji, false);
            // Nudge the <MessageReactions> strip to refetch. In collection view
            // no channel room is joined, so the WS ReactionUpdate echo never
            // arrives and the strip would otherwise never show the new reaction.
            notifyReactionChanged(messageId);
        } catch (err) {
            console.error('Failed to add reaction:', err);
            alert('Could not add that reaction. Please try again.');
        }
    };

    return (
        <div className="message-actions">
            <button
                ref={triggerRef}
                className="msg-action-btn"
                disabled={isLocal}
                onClick={() => setShowPicker(v => !v)}
                title={isLocal ? 'Sending…' : 'Add Reaction'}
            >
                <SmileIcon />
            </button>
            {onReply && (
                <button className="msg-action-btn" disabled={isLocal} onClick={onReply} title={isLocal ? 'Sending…' : 'Reply'}>
                    <ReplyIcon />
                </button>
            )}
            {onQuote && (
                <button className="msg-action-btn" onClick={onQuote} title="Quote">
                    <NoteIcon />
                </button>
            )}
            {onForward && (
                <button className="msg-action-btn" onClick={onForward} title="Forward">
                    <ForwardIcon />
                </button>
            )}
            {onEdit && (
                <button className="msg-action-btn" disabled={isLocal} onClick={onEdit} title={isLocal ? 'Sending…' : 'Edit'}>
                    <PencilIcon />
                </button>
            )}
            {onPin && (
                <button className="msg-action-btn" disabled={isLocal} onClick={onPin} title={isLocal ? 'Sending…' : 'Pin Message'}>
                    <PinIcon />
                </button>
            )}
            {onHide && (
                <button className="msg-action-btn" disabled={isLocal} onClick={onHide} title={isLocal ? 'Sending…' : 'Delete for me (hides it only for you)'}>
                    <EyeOffIcon />
                </button>
            )}
            {onDelete && (
                <button className="msg-action-btn delete" disabled={isLocal} onClick={onDelete} title={isLocal ? 'Sending…' : 'Delete for everyone'}>
                    <TrashIcon />
                </button>
            )}
            {showPicker && createPortal(
                <div
                    className="toolbar-react-picker"
                    ref={popoverRef}
                    style={{
                        position: 'fixed',
                        top: pos?.top ?? -9999,
                        left: pos?.left ?? -9999,
                        zIndex: 3000,
                        visibility: pos ? 'visible' : 'hidden',
                    }}
                >
                    <EmojiPicker
                        quickMode
                        onSelect={handleReact}
                        onClose={() => setShowPicker(false)}
                    />
                </div>,
                document.body
            )}
        </div>
    );
}

interface ChatProps {
    onLogout?: () => void;
}

export function Chat({ onLogout }: ChatProps) {
    const queryClient = useQueryClient();

    // Data Queries
    const { data: servers = [], isLoading: isServersLoading } = useServers();

    // Selection state
    const [currentServer, setCurrentServer] = useState<Server | null>(null);

    // Dependent queries
    const { data: channels = [], isFetched: channelsFetched } = useChannels(currentServer?.id || '');
    const { data: allMembers = [] } = useServerMembers(currentServer?.id || '');
    // Always-fresh view of the member list for WS handlers. The ChatMessage
    // handler lives in an effect keyed on the channel/server ids, so its
    // closure kept whatever `allMembers` was when the channel opened — on app
    // start that's [] (the members query resolves after the channel list), and
    // the @mention ping then never fired in the landing channel: the handler
    // couldn't see your nickname even while the render path highlighted it.
    const allMembersRef = useRef(allMembers);
    allMembersRef.current = allMembers;

    // Who the current user has blocked — drives message collapsing and
    // notification suppression. Loaded once after login; the block/unblock
    // call sites keep it current from then on.
    const blockedUserIds = useBlockedUsers();
    useEffect(() => { void loadBlockedUsers(); }, []);
    /** Blocked members' usernames. `reply_to` carries a username but no id, so
     *  a reply preview can only be matched by name — without this, a blocked
     *  user's text was quoted verbatim inside someone else's reply, defeating
     *  the collapse of their own message. */
    const blockedUsernames = useMemo(
        () => new Set(allMembers.filter(m => blockedUserIds.has(m.id)).map(m => m.username)),
        [allMembers, blockedUserIds]
    );

    // Task attribution: member id → display name, same fallback chain as the
    // voice stage / typing indicators. Departed members resolve to undefined
    // (TaskTree degrades to "user #<id>").
    const memberNames = new Map(allMembers.map(m => [m.id, m.display_name || m.server_nickname || m.username]));
    const resolveMemberName = (id: number) => memberNames.get(id);

    const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
    const [currentCollection, setCurrentCollection] = useState<Channel | null>(null); // For collection unified view
    const [messages, setMessages] = useState<DisplayMessage[]>([]);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [showPins, setShowPins] = useState(false);
    const [pinnedMessages, setPinnedMessages] = useState<PinnedMessage[]>([]);
    // allMembers state replaced by hook
    const [input, setInput] = useState('');
    // Composer autocomplete (@members / #channels) — token being typed before the cursor.
    const [autocomplete, setAutocomplete] = useState<{ type: 'user' | 'channel'; query: string; start: number; index: number } | null>(null);
    const [isTaskMode, setIsTaskMode] = useState(false); // Toggle for creating task messages
    const [isLoading, setIsLoading] = useState(true);

    // --- Sticky auto-scroll (the familiar chat-app pattern) ---------------
    // Stay pinned to the newest message, but NEVER yank the viewport while the
    // user is reading further up. Refs (not state) because WS-driven effects
    // read these without wanting a re-render per scroll tick.
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const atBottomRef = useRef(true);
    const lastTailIdRef = useRef<string>('');
    const lastLenRef = useRef(0);
    // Restores the reading position after older messages are prepended.
    const pendingRestoreRef = useRef<number | null>(null);
    // Armed on every conversation switch; the tail effect's first non-empty
    // render consumes it by scrolling to the latest message.
    const needsAnchorRef = useRef(true);
    // Live view of the open channel id, for async handlers (loadOlderMessages)
    // that must notice a switch happening across their awaits.
    const currentChannelIdRef = useRef<number | null>(null);
    const [showJumpLatest, setShowJumpLatest] = useState(false);
    const [missedCount, setMissedCount] = useState(0);
    const AT_BOTTOM_SLOP = 120; // px of slack that still counts as "at the bottom"
    // Mirror of showingMessageList for the scroll handler: the .messages-container
    // scroller is SHARED with the voice/stream/checklist/dashboard views, and a
    // scroll there must not rewrite the message list's at-bottom state. A ref,
    // because the handler is a one-shot useCallback and showingMessageList is
    // computed further down the component.
    const showingMessageListRef = useRef(true);
    // True while a programmatic scroll-to-bottom is in flight. A smooth scroll
    // fires intermediate scroll events that would read as "the user scrolled
    // up", flipping atBottomRef back off and re-showing the pill mid-animation.
    const pinningRef = useRef(false);
    const pinningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const scrollToLatest = useCallback((behavior: ScrollBehavior = 'auto') => {
        const el = messagesContainerRef.current;
        if (!el) return;
        pinningRef.current = true;
        if (pinningTimerRef.current !== null) clearTimeout(pinningTimerRef.current);
        // Safety valve: if the scroll never lands (content grew mid-flight and
        // the animation stopped short, or scrollTo produced no event because
        // we were already at the bottom), stop swallowing scrolls after a beat
        // — and RECONCILE the state with where the viewport actually is,
        // because the events that would have corrected it were swallowed.
        pinningTimerRef.current = setTimeout(() => {
            pinningRef.current = false;
            pinningTimerRef.current = null;
            const c = messagesContainerRef.current;
            if (!c || !showingMessageListRef.current) return;
            const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight <= AT_BOTTOM_SLOP;
            if (atBottom !== atBottomRef.current) {
                atBottomRef.current = atBottom;
                if (atBottom) { setShowJumpLatest(false); setMissedCount(0); }
                else setShowJumpLatest(true);
            }
        }, 800);
        el.scrollTo({ top: el.scrollHeight, behavior });
        atBottomRef.current = true;
        setShowJumpLatest(false);
        setMissedCount(0);
    }, []);

    // Explicit user input during a pinning animation means the user took the
    // wheel back: stop swallowing scroll events immediately, or their scroll
    // up would be discarded and the next message would yank them down.
    const cancelPinning = useCallback(() => {
        if (!pinningRef.current) return;
        pinningRef.current = false;
        if (pinningTimerRef.current !== null) { clearTimeout(pinningTimerRef.current); pinningTimerRef.current = null; }
    }, []);

    const handleMessagesScroll = useCallback(() => {
        const el = messagesContainerRef.current;
        if (!el) return;
        // A checklist/voice/stream/dashboard view scrolling the shared
        // container must not poison the message list's state (every READER of
        // atBottomRef already gates on showingMessageList; this makes the
        // writer agree with them).
        if (!showingMessageListRef.current) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLOP;
        if (pinningRef.current) {
            // Intermediate events of our own scroll animation. Only the
            // arrival at the bottom is meaningful; ignore the rest.
            if (atBottom) {
                pinningRef.current = false;
                if (pinningTimerRef.current !== null) { clearTimeout(pinningTimerRef.current); pinningTimerRef.current = null; }
            }
            return;
        }
        // Only act on a TRANSITION — setState on every wheel tick would
        // re-render this whole component and visibly stutter the list.
        if (atBottom === atBottomRef.current) return;
        atBottomRef.current = atBottom;
        if (atBottom) { setShowJumpLatest(false); setMissedCount(0); }
        else setShowJumpLatest(true);
    }, []);

    // Get current user from JWT
    const token = getToken();
    const currentUser = token ? decodeJwt(token) : null;
    const currentUserId = currentUser?.sub ?? 0;


    const [initError] = useState<string | null>(null);

    // Channel creation modal state
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newChannelName, setNewChannelName] = useState('');
    const [newChannelType, setNewChannelType] = useState<0 | 1 | 2>(0); // 0 = Text, 1 = Voice, 2 = Collection
    const [newChannelHasChecklist, setNewChannelHasChecklist] = useState(false); // text channel rendered as a checklist
    const [newChannelParentId, setNewChannelParentId] = useState<number | null>(null);


    // Server wizard state
    const [showServerModal, setShowServerModal] = useState(false);
    const [showJoinModal, setShowJoinModal] = useState(false);
    const [showInviteModal, setShowInviteModal] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    // Devices is a first-class view (the FriendsPanel pattern), not a modal.
    const [showDevicesView, setShowDevicesView] = useState(false);

    // User profile popup state
    const [selectedMember, setSelectedMember] = useState<MemberWithRoles | null>(null);
    const [popupPosition, setPopupPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

    // Voice channel state
    const [currentVoiceChannel, setCurrentVoiceChannel] = useState<Channel | null>(null);
    // Mirror for handlers that must read it SYNCHRONOUSLY, before an await can
    // let something else change it. See handleVoiceMoved.
    const currentVoiceChannelRef = useRef<Channel | null>(null);
    useEffect(() => { currentVoiceChannelRef.current = currentVoiceChannel; }, [currentVoiceChannel]);

    // Members of the server the VOICE CHANNEL belongs to — which is not always
    // the server on screen, because voice deliberately persists while you
    // browse elsewhere. Custom join/leave sounds must be resolved from THIS
    // roster: `custom_sounds_disabled` is per (server, member) and the server
    // nulls the sound ids of a silenced member, so reading the ids off another
    // shared server's roster would play a clip that this server's moderators
    // had muted. Same query key as useServerMembers when the ids match, so
    // viewing the voice server costs no extra request.
    const { data: voiceServerMembers = [] } = useServerMembers(currentVoiceChannel?.server_id || '');
    /** Sound ids keyed by user id, empty until the right roster is in hand —
     *  absent entries degrade to the default chime, which is the safe way to
     *  be wrong. */
    const voiceMemberSounds = useMemo(
        () => new Map(voiceServerMembers.map(m => [m.id, {
            join: m.join_sound_file_id ?? null,
            leave: m.leave_sound_file_id ?? null,
        }])),
        [voiceServerMembers]
    );

    // DM state
    const [dmConversations, setDmConversations] = useState<DMConversation[]>([]);
    /** True once the DM list has genuinely loaded — gates the launcher
     *  shortcuts sync, which would otherwise wipe persisted shortcuts with
     *  the initial [] on every launch (permanently, if the fetch fails). */
    const [dmsLoaded, setDmsLoaded] = useState(false);
    // Search box in the home/DM sidebar ("Find or start a conversation").
    const [homeSearchQuery, setHomeSearchQuery] = useState('');

    // "Edit Server Profile" (per-server nickname) — opened from the server
    // rail's context menu. window.prompt is unreliable in WebView2, so this is
    // a real (tiny) modal.
    const [nickEditServer, setNickEditServer] = useState<Server | null>(null);
    const [nickEditValue, setNickEditValue] = useState('');
    const [nickSaving, setNickSaving] = useState(false);
    // Fetching the existing nickname for a server that isn't the current one.
    // Saving is blocked while true — a blank field the user hasn't seen yet
    // must never be written back as "clear my nickname".
    const [nickLoading, setNickLoading] = useState(false);
    // Which server the in-flight nickname fetch is for: a stale response must
    // not populate a dialog that has since been reopened for another server.
    const nickFetchServerRef = useRef<string | null>(null);

    // Re-render when per-server "hide muted channels" (or a channel mute)
    // changes — the channel list filters read the stores at render time.
    const [, setChannelVisRev] = useState(0);
    useEffect(() => {
        const bump = () => setChannelVisRev(r => r + 1);
        window.addEventListener('hideMutedChanged', bump);
        window.addEventListener('channelMuteChanged', bump);
        return () => {
            window.removeEventListener('hideMutedChanged', bump);
            window.removeEventListener('channelMuteChanged', bump);
        };
    }, []);

    // Server-side rejections of a WS send (ServerMessage::Error) had NO handler
    // at all: the socket layer dispatches strictly by type, so a rejected DM —
    // the friends-only privacy flag, or a block — left the optimistic bubble on
    // screen forever and told the sender nothing. DMs persist only through the
    // WS path, so this was silent data loss on the private path.
    useEffect(() => {
        const onServerError = (msg: ServerMessage) => {
            const text = (msg.payload as { message?: string } | undefined)?.message
                ?? 'The server rejected that action.';
            console.warn('[WS] server error:', text);
            // Drop any optimistic DM bubbles that can no longer land. They are
            // the only fire-and-forget sends (channel messages go over REST and
            // surface their own errors), and they are identifiable by prefix.
            setDmMessages(prev => prev.filter(m => !String(m.id).startsWith('local_')));
            alert(text);
        };
        wsClient.on('Error', onServerError);
        return () => wsClient.off('Error', onServerError);
    }, []);

    // App shortcuts (Keybinds tab): open settings, focus message search.
    // Bindings are read per keypress, so a rebind applies live.
    useEffect(() => {
        registerPress('app.openSettings', () => loadSettings().openSettingsBinding,
            () => setShowSettings(true));
        registerPress('app.search', () => loadSettings().searchBinding, () => {
            const el = document.querySelector<HTMLInputElement>('.search-bar input');
            el?.focus();
            el?.select();
        });
        return () => {
            unregisterPress('app.openSettings');
            unregisterPress('app.search');
        };
    }, []);
    const [currentDM, setCurrentDM] = useState<DMConversation | null>(null);
    // Conversation id of the most recent DM-history fetch (staleness guard).
    const openDMFetchRef = useRef<string | null>(null);
    // Which top-level Friends-panel view is showing — the rail's Tasks (notes)
    // button opens 'tasks', the DM home button opens 'online'.
    const [friendsTab, setFriendsTab] = useState<'online' | 'tasks'>('online');
    const [dmMessages, setDmMessages] = useState<DMMessage[]>([]);

    // SEND_MESSAGES gate for the open channel. hasPerm's undefined fallback
    // keeps old backends (no my_permissions yet) fully permissive; DMs have no
    // channel bits and are never blocked here.
    const canSendHere = currentDM != null || currentChannel == null ||
        hasPerm(currentChannel.my_permissions, PERM.SEND_MESSAGES);

    // Trigger to force re-render when voice users change
    const [_voiceRefreshTrigger, setVoiceRefreshTrigger] = useState(0);
    const triggerVoiceRefresh = () => setVoiceRefreshTrigger(prev => prev + 1);

    // Pending composer attachments — chips above the input, markdown built
    // only at send time (api/composerAttachments). This replaced both the
    // raw-markdown-in-the-textarea flow and the paste-preview modal.
    const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
    /** Mirror for side-effectful handlers (revoke/discard), so no setState
     *  updater carries side effects (StrictMode double-invokes them). */
    const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
    useEffect(() => { pendingAttachmentsRef.current = pendingAttachments; }, [pendingAttachments]);
    /** The original File per chip, kept for retry. A ref: files aren't render data. */
    const pendingFilesRef = useRef(new Map<string, File>());
    /** Chips abandoned WHILE their upload was still in flight (X mid-spinner,
     *  conversation switch, unmount). The upload cannot be cancelled — when it
     *  lands, its .then consults this set and discards the ciphertext instead
     *  of marking a chip that no longer exists. Without this, every cancelled
     *  in-progress attachment leaked its quota forever: the href (the only
     *  copy of the file id) was dropped in a no-op markReady. A ref (not the
     *  state mirror): it must be readable after unmount, when no effect runs. */
    const abandonedUploadsRef = useRef(new Set<string>());

    /**
     * One failure message for every way a file can be sent — picker,
     * drag-and-drop, paste. Shown on the failed chip (tooltip + retry), not an
     * alert. A rejected size is worth stating exactly, since the fix is
     * entirely in the user's hands.
     */
    const describeUploadFailure = useCallback((err: unknown, file: File): string => {
        console.error('Failed to upload file:', file.name, err);
        return err instanceof FileTooLargeError
            ? err.message
            // 507 is the storage quota, and it is PERMANENT until the user frees
            // space — "Please try again" invited an infinite retry that could
            // never succeed. Say what is actually wrong and what fixes it.
            : err instanceof ApiError && err.status === 507
                ? `Your upload storage is full, so "${file.name}" couldn't be sent. Delete some older attachments, emojis or images to free space.`
                : `Couldn't upload "${file.name}". Please try again.`;
    }, []);

    /** Shared tail of enqueue/retry: mark ready — unless the chip was
     *  abandoned while the upload flew, in which case the freshly stored
     *  ciphertext is discarded on arrival (see abandonedUploadsRef). */
    const settleUpload = useCallback((localId: string, file: File) => {
        void encryptAndUploadRef(file)
            .then(ref => {
                if (abandonedUploadsRef.current.delete(localId)) {
                    const fileId = parseEncAttachment(ref.href)?.id;
                    if (fileId) discardUpload(fileId);
                    return;
                }
                setPendingAttachments(prev => markReady(prev, localId, ref.href));
            })
            .catch((err: unknown) => {
                if (abandonedUploadsRef.current.delete(localId)) return; // nothing stored, nothing shown
                setPendingAttachments(prev => markFailed(prev, localId, describeUploadFailure(err, file)));
            });
    }, [describeUploadFailure]);

    /** Every insertion path (picker, drop, paste) funnels here: chip first,
     *  E2EE upload in the background, ready/failed reflected on the chip.
     *  Only image/* gets a thumbnail object URL — the chip renders it in an
     *  <img>, and a video blob in an <img> paints an empty square (worse than
     *  the file icon it would otherwise get). */
    const enqueueUpload = useCallback((file: File, opts?: { spoiler?: boolean }) => {
        const chip = pendingAttachment(file, file.type.startsWith('image/') ? URL.createObjectURL(file) : null, opts?.spoiler ?? false);
        pendingFilesRef.current.set(chip.localId, file);
        setPendingAttachments(prev => [...prev, chip]);
        settleUpload(chip.localId, file);
    }, [settleUpload]);

    const retryUpload = useCallback((localId: string) => {
        const file = pendingFilesRef.current.get(localId);
        if (!file) return;
        setPendingAttachments(prev => markUploading(prev, localId));
        settleUpload(localId, file);
    }, [settleUpload]);

    const removePendingAttachment = useCallback((localId: string) => {
        const chip = pendingAttachmentsRef.current.find(a => a.localId === localId);
        if (chip?.previewUrl) URL.revokeObjectURL(chip.previewUrl);
        // A ready chip's ciphertext already sits on the server against the
        // quota — removing the chip means it will never be referenced. One
        // still UPLOADING has no href yet; flag it so settleUpload discards
        // the ciphertext the moment the upload lands.
        if (chip?.status === 'uploading') abandonedUploadsRef.current.add(localId);
        const fileId = chip?.href ? parseEncAttachment(chip.href)?.id : null;
        if (fileId) discardUpload(fileId);
        pendingFilesRef.current.delete(localId);
        setPendingAttachments(prev => removeAttachment(prev, localId));
    }, []);

    /** Drop every chip. `discardUploads` distinguishes "the message took
     *  them" (false — they are referenced now) from "abandoned" (true —
     *  reclaim the quota, including uploads still in flight via
     *  abandonedUploadsRef). */
    const clearComposerAttachments = useCallback((opts: { discardUploads: boolean }) => {
        for (const chip of pendingAttachmentsRef.current) {
            if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl);
            if (opts.discardUploads) {
                if (chip.status === 'uploading') abandonedUploadsRef.current.add(chip.localId);
                if (chip.href) {
                    const fileId = parseEncAttachment(chip.href)?.id;
                    if (fileId) discardUpload(fileId);
                }
            }
        }
        pendingFilesRef.current.clear();
        setPendingAttachments([]);
    }, []);

    /** The send-time clear: the message took the READY chips; FAILED chips
     *  stay in the strip with their warning and Retry — clearing them too
     *  silently dropped a file the user attached ("here you go" went out
     *  without it, and the retry affordance vanished with it). */
    const takeSentAttachments = useCallback(() => {
        for (const chip of pendingAttachmentsRef.current) {
            if (chip.status !== 'failed') {
                if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl);
                pendingFilesRef.current.delete(chip.localId);
            }
        }
        setPendingAttachments(prev => prev.filter(a => a.status === 'failed'));
    }, []);

    // Abandoned on unmount (logout/navigation): reclaim like any abandonment.
    useEffect(() => () => clearComposerAttachments({ discardUploads: true }), [clearComposerAttachments]);

    // Advanced editor mode (Enter doesn't send)

    // Context menu for text formatting
    const [formatMenu, setFormatMenu] = useState<{ x: number; y: number } | null>(null);
    const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

    // Friends panel
    const [showFriendsPanel, setShowFriendsPanel] = useState(false);

    // Welcome popup for new users
    const [showWelcomePopup, setShowWelcomePopup] = useState(false);

    // User profile settings (quick profile edit)
    const [showUserSettings, setShowUserSettings] = useState(false);

    // Full settings modal
    const [showSettings, setShowSettings] = useState(false);

    // Emoji settings
    const [draggingChannelId, setDraggingChannelId] = useState<number | null>(null);
    const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
    const [showChecklist, setShowChecklist] = useState(false);
    // Server-wide "All checklists" board (aggregates every checklist channel).
    const [showAllChecklists, setShowAllChecklists] = useState(false);

    // Emoji picker in chat input
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);

    // View mode: 'chat' shows messages, 'stream' shows StreamStage,
    // 'voice' shows the VoiceStage (participant tiles for the connected room)
    const [viewMode, setViewMode] = useState<'chat' | 'stream' | 'voice'>('chat');

    /** Is the shared `.messages-container` scroller currently showing the
     *  MESSAGE LIST? It's also the scroller for StreamStage, VoiceStage,
     *  ChannelDashboard, ChecklistBody and AllChecklistsView — none of which
     *  want message auto-scroll or a "jump to latest" pill. Mirrors the render
     *  branches below. */
    const showingMessageList = viewMode === 'chat'
        && !showAllChecklists
        && currentChannel?.channel_type !== 2
        && !currentChannel?.has_checklist;
    // Keep the scroll handler's mirror in sync BEFORE the browser can deliver
    // a scroll event for the newly shown view.
    useLayoutEffect(() => {
        showingMessageListRef.current = showingMessageList;
    }, [showingMessageList]);

    // PiP (Picture-in-Picture) mode: shows chat with stream overlay
    const [showPip, setShowPip] = useState(false);
    // OS-level picture-in-picture: which stream (if any) is popped out into
    // the system PiP window (StreamPopout). Pinned to the tile that was
    // clicked; toggling the same tile brings it back, another tile switches.
    // W4: a LIST — the Doc-PiP grid holds any number of popped streams in one
    // OS window; the legacy single-video engines keep exactly one (the newest
    // pick replaces). `docPipFailed` latches when requestWindow rejects, so
    // the rest of the session uses the engine that actually works.
    const [poppedStreams, setPoppedStreams] = useState<number[]>([]);
    const [docPipFailed, setDocPipFailed] = useState(false);
    const usingDocPip = !docPipFailed && popoutMode() === 'docpip';
    const togglePopout = useCallback((userId: number) => {
        setPoppedStreams(prev => togglePopped(prev, userId, !docPipFailed && popoutMode() === 'docpip'));
    }, [docPipFailed]);
    // The Android APP's PiP is native and only knowable by asking the plugin;
    // ask once, here, so pipSupported() can answer at render time by the time
    // any stream tile exists. A no-op on every other platform. The [doc-pip]
    // line is the W4 spike's field answer: whether THIS embedder (WebView2 /
    // a browser) implements documentPictureInPicture is not documented
    // anywhere — the log on the real machine is the measurement.
    useEffect(() => {
        void primePipSupport();
        console.info(`[doc-pip] documentPictureInPicture is ${docPipSupported() ? 'AVAILABLE' : 'absent'} in this runtime`);
    }, []);

    // Mobile panel navigation state: 'chat' | 'servers' | 'channels' | 'members'
    type MobilePanel = 'chat' | 'servers' | 'channels' | 'members';
    const [mobilePanel, setMobilePanel] = useState<MobilePanel>('chat');

    // Detect mobile device. MUST match mobile.css's media gate
    // `(pointer: coarse) and (max-width: 1024px)` exactly — if JS renders the
    // mobile chrome while the CSS doesn't style it (or vice versa) the layout
    // is half-hijacked. isNativeMobile() checks Capacitor.isNativePlatform(),
    // true only inside the shipped phone app — unlike `'Capacitor' in window`
    // (always true: @capacitor/core sets that global unconditionally on every
    // platform, including desktop), so a narrow desktop window never is.
    const isMobile = typeof window !== 'undefined' && (
        isNativeMobile() ||
        window.matchMedia('(pointer: coarse) and (max-width: 1024px)').matches
    );

    // Swipe between the mobile panels (servers ↔ channels ↔ chat ↔ members),
    // reusing the existing panel state + CSS slide transitions. Guarded so it
    // can't switch panels behind an open overlay, and disabled while the
    // Friends/Tasks panel is up (that view has its own swipe for list tabs).
    /** Leaving the Devices view. With NO server selected, a server-scoped
     *  panel has nothing to show for the tap anyway — and worse, dropping
     *  showDevicesView while the friends panel is closed re-arms the
     *  auto-select effect below, which would pick servers[0] and jump to
     *  'channels' OVER the user's navigation. The home dashboard is where the
     *  user came from, so that is where leaving Devices lands serverless. */
    const leaveDevicesView = (next: MobilePanel) => {
        setShowDevicesView(false);
        if (!currentServer) {
            setShowFriendsPanel(true);
            setMobilePanel('chat');
            return;
        }
        setMobilePanel(next);
    };
    const stepPanel = (delta: 1 | -1) => {
        if (document.querySelector('.modal-overlay, .settings-modal, .paste-preview-modal, .welcome-popup, .user-context-menu, .format-menu, .stream-settings-modal')) return;
        // Devices is a virtual fifth stop after 'members', mirroring its
        // bottom-nav position. It is an overlay FLAG rather than a panel
        // value, so entering and leaving it are side effects here: while it
        // is open the underlying panel stays 'servers' (DevicesView anchors
        // beside the rail and its sidebar-eviction CSS keys on that), which
        // is why the current position is derived instead of read straight
        // from mobilePanel.
        const order = ['servers', 'channels', 'chat', 'members', 'devices'] as const;
        const current: (typeof order)[number] = showDevicesView ? 'devices' : mobilePanel;
        const i = order.indexOf(current);
        if (i < 0) return;
        const next = order[Math.min(order.length - 1, Math.max(0, i + delta))];
        if (next === current) return;
        if (next === 'devices') {
            setShowDevicesView(true);
            setShowFriendsPanel(false);
            setShowChecklist(false);
            setMobilePanel('servers');
            return;
        }
        if (current === 'devices') {
            leaveDevicesView(next);
            return;
        }
        setMobilePanel(next);
    };
    const panelSwipe = useSwipe({
        // Disabled under the Friends/Tasks overlay (it has its own swipe for
        // its list tabs). Devices no longer disables it: the view is a stop
        // on the run itself now, so a horizontal swipe over a device card
        // moves the Devices view away — the thing the user is looking at is
        // what changes, which is the guarantee the old guard existed to
        // protect when Devices sat outside the run.
        enabled: isMobile && !showFriendsPanel,
        threshold: 70,
        onSwipeLeft: () => stepPanel(1),
        onSwipeRight: () => stepPanel(-1),
    });

    // Trigger re-renders when globalVoiceUsers changes (updated by global stream listeners)
    const [, setVoiceUpdateTrigger] = useState(0);

    // Subscribe to stream state changes - switch to stream view when watching
    // BUT don't switch if PiP mode is enabled (user chose to stay in chat)
    useEffect(() => {
        const update = () => {
            const streams = getSelectedStreams();
            const hasStreams = streams.length > 0;
            console.debug('[Chat] Stream state update - hasStreams:', hasStreams, 'currentViewMode:', viewMode, 'showPip:', showPip);
            // Only auto-switch to stream if NOT in PiP mode
            if (hasStreams && (viewMode === 'chat' || viewMode === 'voice') && !showPip) {
                setViewMode('stream');
            } else if (!hasStreams && viewMode === 'stream') {
                // Last stream ended — fall back to the voice tiles if we're
                // still connected to voice, else to chat.
                setViewMode(currentVoiceChannel ? 'voice' : 'chat');
                setShowPip(false); // Also close PiP if no streams
            } else if (!hasStreams && showPip) {
                setShowPip(false); // Close PiP if no streams
            }
        };
        update(); // Check initial state
        return subscribeToStreamState(update);
    }, [viewMode, showPip, currentVoiceChannel]);

    // Leaving voice (hang-up, kicked, moved) while the voice tiles are up —
    // fall back to chat so the main area never shows a stage for a dead room.
    useEffect(() => {
        if (viewMode === 'voice' && !currentVoiceChannel) setViewMode('chat');
    }, [viewMode, currentVoiceChannel]);

    // Increments on genuine ROSTER mutations only (users added/removed from a
    // voice room). The REST snapshot rebuild below only applies when no such
    // event landed while its fetch was in flight — a snapshot taken BEFORE a
    // join/eviction but resolving AFTER the events would resurrect the vacated
    // room's entry (the sticky "AFK + voice channel at once" duplicate).
    // Deliberately NOT bumped from the subscribeToVoiceUsers callback: that
    // fires for every speaking/mute tick, and counting those would starve the
    // reconnect catch-up snapshot forever in any active call.
    const voiceEventSeqRef = useRef(0);

    // Subscribe to voice user changes - force sidebar re-render when users join/leave voice
    useEffect(() => {
        return subscribeToVoiceUsers(() => {
            setVoiceUpdateTrigger(prev => prev + 1);
        });
    }, []);

    // Typing indicators
    const [typingUsers, setTypingUsers] = useState<Map<number, { username: string; expiry: number }>>(new Map());
    const lastTypingSent = useRef<number>(0);

    // Search state
    const [searchQuery, setSearchQuery] = useState('');
    const [searchOutcome, setSearchOutcome] = useState<SearchOutcome | null>(null);
    /** Shown when a hit is outside the loaded history — better than a dead click. */
    const [jumpNotice, setJumpNotice] = useState<string | null>(null);
    /**
     * Transient failure message, e.g. an image the clipboard would not take.
     *
     * Carries a sequence number because the message alone is not enough: the
     * text comes from a small enum of failure reasons, so a second failure of
     * the SAME kind sets state to an identical string, React bails out on
     * Object.is, nothing re-renders, and the user gets no feedback at all
     * while the first toast quietly expires on its original timer.
     */
    const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);
    const showToast = useCallback((text: string) => {
        setToast(prev => ({ text, seq: (prev?.seq ?? 0) + 1 }));
    }, []);
    const [isSearching, setIsSearching] = useState(false);
    /** Cancels an in-flight search when the query changes or the view closes. */
    const searchAbortRef = useRef<{ aborted: boolean } | null>(null);
    const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Reply state
    const [replyingTo, setReplyingTo] = useState<DisplayMessage | null>(null);

    // A reply target belongs to ONE conversation: clear it whenever the active
    // channel / DM / collection changes, so a reply drafted in A can't be sent
    // into B (the backend doesn't validate that reply_to belongs to the target
    // channel). (audit M16) Pending attachment chips are conversation-scoped
    // for the same reason — and abandoned ones reclaim their quota.
    useEffect(() => {
        setReplyingTo(null);
        clearComposerAttachments({ discardUploads: true });
    }, [currentChannel?.id, currentDM?.id, currentCollection?.id, clearComposerAttachments]);

    // Forward state — the decrypted content being forwarded (null = closed).
    // Content is all a forward needs: it's re-encrypted by the target's own
    // send path, and attachment markdown carries its own key.
    const [forwardingContent, setForwardingContent] = useState<string | null>(null);

    // "Add Reaction" from the message context menu: tells that message's
    // <MessageReactions> to open its full picker (custom emojis included),
    // anchored at the press point. The nonce makes every request distinct so
    // the same message can be long-pressed twice; rows compare messageId
    // before passing it down.
    const [reactRequest, setReactRequest] = useState<{ messageId: string; nonce: number; x: number; y: number } | null>(null);

    // Opening a channel from a clicked notification. Held in a ref because the
    // WS handler below is registered once: closing over `channels` and
    // `handleChannelClick` directly would capture whichever versions existed
    // when the handler was registered, and a click could then jump to a channel
    // list from minutes ago.
    const openChannelRef = useRef<(channelId: number) => void>(() => { });
    useEffect(() => {
        openChannelRef.current = (channelId: number) => {
            const ch = channels.find(c => c.id === channelId);
            if (ch) handleChannelClick(ch);
        };
    });

    // Experimental peer-to-peer transfers, read reactively so toggling the
    // setting takes effect without a restart.
    const [p2pOn, setP2pOn] = useState(p2pTransfersEnabled);
    useEffect(() => {
        const sync = () => setP2pOn(p2pTransfersEnabled());
        window.addEventListener('settingsChanged', sync);
        return () => window.removeEventListener('settingsChanged', sync);
    }, []);

    // Peer-to-peer transfers must be listening app-wide, not only while a DM is
    // on screen: an offer that arrives while you are reading a channel would
    // otherwise be dropped on the floor with nothing to show for it. The cards
    // render per-conversation; the LISTENING is global.
    //
    // And UNCONDITIONAL — never behind the p2p opt-in. The flag is per-device
    // (localStorage), so gating RECEIVING on it meant a phone whose user had
    // only enabled it on the desktop silently discarded every incoming offer:
    // the WS frame arrived, found no handler, and vanished — while the sender
    // sat on "Waiting for your other device to accept…" until the server's
    // 120s offer TTL reaped it. A receiver has already been CHOSEN by a sender
    // who deliberately opted in; the opt-in belongs on the send path alone.
    // wire() is idempotent and the manager is inert until an offer arrives,
    // so always-on costs nothing when the feature is unused.
    useEffect(() => {
        fileTransferManager.wire();
        fileTransferManager.setSinkFactory(prepareSink);
    }, []);

    /**
     * Announce an INCOMING offer the same way a message is announced.
     *
     * A direct transfer needs both people present and expires in about two
     * minutes, so it is the one thing in the app that genuinely cannot wait
     * for you to notice it. Rendering the tray is not enough on its own: with
     * the window behind a game, nothing on screen is visible at all.
     *
     * Announced once per transfer id — the subscription fires on every
     * progress tick, so without the seen-set this would ping continuously for
     * the whole transfer.
     */
    const announcedOffersRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        // Not behind p2pOn either — see the wire() effect above: an offer can
        // arrive on a device that never opted in, and it must still ping.
        return fileTransferManager.subscribe(list => {
            for (const t of list) {
                if (t.direction !== 'receive' || t.state !== 'offered') continue;
                if (announcedOffersRef.current.has(t.id)) continue;
                announcedOffersRef.current.add(t.id);
                notifyNewMessage({
                    title: `${t.peerName} wants to send you ${t.name}`,
                    isOwn: false,
                    isMuted: false,   // an expiring offer is never "quiet"
                    // One notification per offer (never collapsed with a
                    // message from the same person), and a tap lands on the
                    // conversation list where the offer card is waiting.
                    notifyKey: `file:${t.id}`,
                    nav: 'dms',
                });
                playMessageSound();
            }
            // Forget ids that are gone, so the set cannot grow for the life of
            // the app (and a re-offer of the same file announces again).
            if (announcedOffersRef.current.size > list.length) {
                const live = new Set(list.map(t => t.id));
                for (const id of announcedOffersRef.current) {
                    if (!live.has(id)) announcedOffersRef.current.delete(id);
                }
            }
        });
    }, []);


    // Unread counts state - Map of channel_id to unread count
    const [unreadCounts, setUnreadCounts] = useState<Map<number, number>>(new Map());

    // Advance the server-side read cursor and zero the local badge in one
    // step. The cursor used to move ONLY when the selected channel id changed,
    // so replying to (or reading) live messages in the open channel left them
    // "unread" server-side and the 30s poll re-lit the badge on the channel
    // being stared at — the reported "doesn't go away unless I switch away
    // and back".
    const markReadNow = useCallback((channelId: number) => {
        setUnreadCounts(prev => {
            const next = new Map(prev);
            next.set(channelId, 0);
            return next;
        });
        markChannelRead(channelId).catch(err => console.error('Failed to mark channel read:', err));
        // The rail bubble can't know how much of its server total this
        // channel accounted for — rehydrate the aggregate instead of guessing.
        refreshServerUnreadSoon();
    }, []);

    // Debounced mark-read for live arrivals into the OPEN channel: a burst of
    // messages becomes one POST, and the re-check at fire time drops the write
    // if the user has since switched away or unfocused the window.
    const readDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scheduleMarkRead = useCallback((channelId: number) => {
        if (readDebounceRef.current !== null) clearTimeout(readDebounceRef.current);
        readDebounceRef.current = setTimeout(() => {
            readDebounceRef.current = null;
            if (currentChannelIdRef.current !== channelId) return;
            if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
            // The voice/stream/checklist views keep currentChannel pointing at
            // the last text channel while COVERING it — messages arriving then
            // were never seen, so they must not be marked read.
            if (!showingMessageListRef.current) return;
            markReadNow(channelId);
        }, 1500);
    }, [markReadNow]);
    useEffect(() => () => {
        if (readDebounceRef.current !== null) clearTimeout(readDebounceRef.current);
    }, []);

    // Rail bubbles: hydrate the cross-server unread totals on mount, on every
    // WS (re)connect (events missed while the socket was down are invisible
    // otherwise), and on a slow poll as the drift backstop.
    useEffect(() => {
        void hydrateServerUnread();
        const onConnected = () => void hydrateServerUnread();
        window.addEventListener('wsConnected', onConnected);
        const interval = setInterval(() => void hydrateServerUnread(), 60_000);
        return () => {
            window.removeEventListener('wsConnected', onConnected);
            clearInterval(interval);
        };
    }, []);

    // Muted server (per-device, mutedServersStore): suppress its unread badges.
    // The counts keep polling untouched, so unmuting instantly restores them.
    const [, setMuteRev] = useState(0);
    useEffect(() => {
        const bump = () => setMuteRev(r => r + 1);
        window.addEventListener('serverMuteChanged', bump);
        return () => window.removeEventListener('serverMuteChanged', bump);
    }, []);
    const currentServerMuted = currentServer ? isServerMuted(currentServer.id) : false;
    // "Hide Muted Channels" for the server being viewed (per-device toggle in
    // the server rail's context menu).
    const hideMutedHere = currentServer ? isHideMutedChannels(currentServer.id) : false;

    // Context menu for channels, messages, users
    const { contextMenu, showContextMenu, hideContextMenu } = useContextMenu();

    // User context menu state (for voice users and member list)
    const [userContextMenuTarget, setUserContextMenuTarget] = useState<{
        userId: number;
        username: string;
        isInVoice: boolean;
        position: { x: number; y: number };
    } | null>(null);

    // Handle channel deletion
    const handleDeleteChannel = async (channelId: number) => {
        if (!currentServer) return;
        if (!confirm('Are you sure you want to delete this channel?')) return;

        try {
            await deleteChannel(channelId);
            // Update cache
            queryClient.setQueryData(keys.channels(currentServer.id), (old: Channel[] | undefined) => {
                return (old || []).filter(c => c.id !== channelId);
            });

            // If we deleted the current channel, switch to another
            if (currentChannel?.id === channelId) {
                // accessing channels from cache would be ideal, but we can look at local state 'channels'
                const remaining = channels.filter(c => c.id !== channelId && c.channel_type === 0);
                setCurrentChannel(remaining[0] || null);
            }
        } catch (error) {
            console.error('Failed to delete channel:', error);
            alert('Could not delete the channel. You may not have permission.');
        }
    };

    // Handle input change with typing indicator
    const handleInputChange = (value: string) => {
        setInput(value);
        // Send typing indicator (throttled to every 3 seconds)
        if (currentChannel && value.length > 0) {
            const now = Date.now();
            if (now - lastTypingSent.current > 3000) {
                wsClient.sendTyping(`channel_${currentChannel.id}`);
                lastTypingSent.current = now;
            }
        }
    };

    // Detect an @user / #channel token immediately before the cursor.
    const detectAutocomplete = (value: string, cursor: number) => {
        const before = value.slice(0, cursor);
        const m = before.match(/(?:^|\s)([@#])([\p{L}\p{N}_.-]*)$/u);
        if (!m) { setAutocomplete(null); return; }
        setAutocomplete({
            type: m[1] === '@' ? 'user' : 'channel',
            query: m[2],
            start: before.length - m[2].length - 1,
            index: 0,
        });
    };

    // Replace the active token with the chosen member/channel.
    const applyAutocomplete = (item: { username?: string; name?: string }) => {
        if (!autocomplete) return;
        const insert = autocomplete.type === 'user' ? '@' + item.username : '#' + item.name;
        const end = autocomplete.start + 1 + autocomplete.query.length;
        const newValue = input.slice(0, autocomplete.start) + insert + ' ' + input.slice(end);
        setInput(newValue);
        setAutocomplete(null);
        requestAnimationFrame(() => {
            const el = inputRef.current as HTMLTextAreaElement | null;
            if (el) { el.focus(); const p = autocomplete.start + insert.length + 1; el.setSelectionRange(p, p); }
        });
    };

    // Suggestions for the current token (members or text channels).
    const autocompleteItems: MemberWithRoles[] | Channel[] = !autocomplete ? [] :
        autocomplete.type === 'user'
            ? allMembers.filter(mm => {
                const q = autocomplete.query.toLowerCase();
                return mm.username.toLowerCase().includes(q) ||
                    (mm.display_name || '').toLowerCase().includes(q) ||
                    (mm.server_nickname || '').toLowerCase().includes(q);
            }).slice(0, 8)
            : channels.filter(c => c.channel_type === 0 && c.name.toLowerCase().includes(autocomplete.query.toLowerCase())).slice(0, 8);

    /**
     * Search the OPEN conversation (channel or DM).
     *
     * Debounced and minimum-length gated: this used to run on every keystroke
     * with no floor, so typing one word meant five history fetches and several
     * hundred AES-GCM decrypts. There is no server-side search to fall back on
     * — content is E2EE, so the database only holds ciphertext.
     */
    const MIN_SEARCH_CHARS = 2;
    const SEARCH_DEBOUNCE_MS = 200;

    const runSearch = useCallback(async (query: string) => {
        const q = query.trim();
        if (q.length < MIN_SEARCH_CHARS) { setSearchOutcome(null); setIsSearching(false); return; }

        // Supersede any in-flight walk; a long channel scan must not land
        // after a newer query and overwrite its results.
        if (searchAbortRef.current) searchAbortRef.current.aborted = true;
        const signal = { aborted: false };
        searchAbortRef.current = signal;

        setIsSearching(true);
        try {
            const blocked = (id: number) => isBlocked(id);
            let outcome: SearchOutcome;
            if (currentDM) {
                outcome = await searchDM(currentDM.id, currentDM.other_user_id, q, blocked);
            } else if (currentChannel) {
                outcome = await searchChannel(currentChannel.id, q, blocked, signal);
            } else {
                setIsSearching(false);
                return;
            }
            if (!signal.aborted) setSearchOutcome(outcome);
        } catch (err) {
            console.error('Search failed:', err);
            if (!signal.aborted) setSearchOutcome({ hits: [], searched: 0, undecryptable: 0, truncated: false });
        } finally {
            if (!signal.aborted) setIsSearching(false);
        }
    }, [currentDM, currentChannel]);

    /**
     * Drop the search entirely: cancel any in-flight walk, cancel a pending
     * debounce, and clear the results. Without the two cancellations, closing
     * the panel left a channel scan running that then re-opened the dropdown
     * seconds later with results the user had dismissed.
     */
    const clearSearch = useCallback(() => {
        if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
        if (searchAbortRef.current) searchAbortRef.current.aborted = true;
        searchAbortRef.current = null;
        setSearchQuery('');
        setSearchOutcome(null);
        setJumpNotice(null);
        setIsSearching(false);
    }, []);

    // A search belongs to the conversation it was run in. Switching away must
    // discard it — results from the previous channel presented under the new
    // one's header are worse than no results, and an in-flight walk would
    // otherwise land after the switch and populate the wrong conversation.
    useEffect(() => {
        clearSearch();
    }, [currentChannel?.id, currentDM?.id, currentCollection?.id, clearSearch]);

    const handleSearch = (query: string) => {
        setSearchQuery(query);
        if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
        if (query.trim().length < MIN_SEARCH_CHARS) {
            setSearchOutcome(null);
            return;
        }
        searchDebounceRef.current = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    };

    /** Jump to a hit that is already rendered. Deliberately does NOT replace
     *  the message list to reach one that is not: that would rewrite the very
     *  scroll/pagination path the channel-open regression test pins, and a
     *  chat that opens on the wrong message is a worse failure than a search
     *  result you have to scroll to yourself. */
    const jumpToHit = (id: string) => {
        const el = document.getElementById(`msg-${id}`);
        if (!el) { setJumpNotice('That message is further back than the loaded history — scroll up to load it.'); return; }
        setJumpNotice(null);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('highlight');
        setTimeout(() => el.classList.remove('highlight'), 2000);
    };

    // Wrap selected text with formatting
    const wrapSelection = (prefix: string, suffix: string) => {
        const el = inputRef.current;
        if (!el) return;
        const start = el.selectionStart || 0;
        const end = el.selectionEnd || 0;
        const text = input;
        const selected = text.substring(start, end);
        const newText = text.substring(0, start) + prefix + selected + suffix + text.substring(end);
        setInput(newText);
        setFormatMenu(null);
        // Restore focus
        setTimeout(() => {
            el.focus();
            el.setSelectionRange(start + prefix.length, end + prefix.length);
        }, 0);
    };

    // fetchMembers function removed - handled by useServerMembers hook

    // Keep the currentServer snapshot in step with the servers query: a refetch
    // (save, WS ServerUpdated, reconnect) that changes the server's row must
    // reach everything reading `currentServer` — the settings modal's initial
    // values and the header name. Compared by identity: react-query's
    // structural sharing hands back the SAME object for an unchanged row, so
    // this is a no-op until the row actually changes.
    useEffect(() => {
        if (!currentServer) return;
        const fresh = servers.find(s => s.id === currentServer.id);
        if (fresh && fresh !== currentServer) setCurrentServer(fresh);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- currentServer is only READ to find its row; re-running on it would loop
    }, [servers]);

    // If the current server vanishes from our list (kicked/banned/deleted),
    // drop it — otherwise the auto-select below can resurrect a stale copy.
    useEffect(() => {
        if (currentServer && !isServersLoading && !servers.some(s => s.id === currentServer.id)) {
            setCurrentServer(null);
            setCurrentChannel(null);
            setMessages([]);
            setShowFriendsPanel(true);
            setShowDevicesView(false);
            if (isMobile) setMobilePanel('chat');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [servers, isServersLoading]);

    // Initialize server selection
    useEffect(() => {
        // Only auto-select a server when the user isn't intentionally in the
        // home/DM view — opening a DM clears currentServer on purpose, and
        // this effect would otherwise immediately resurrect the last server
        // (leaving the DM stuck behind a server's channel sidebar).
        // !showDevicesView for the same reason as !showFriendsPanel: opening
        // Devices from the home/DM view clears showFriendsPanel, which is a
        // dependency here — so this effect re-ran and, on mobile, immediately
        // set the panel to 'channels', sliding the view the user had just
        // opened off-screen. Every full-slot overlay has to be listed.
        if (!currentServer && servers.length > 0 && !currentDM && !showFriendsPanel && !showDevicesView) {
            setCurrentServer(servers[0]);
            // On mobile, start on the channels panel so users see the channel list
            setMobilePanel('channels');
        } else if (servers.length === 0 && !isServersLoading && !currentDM && !showDevicesView) {
            // !currentDM: a zero-server user reading a DM (e.g. Notes to self)
            // must not have the dashboard force-reopened over the conversation
            // the instant they open it — this effect refires on every
            // showFriendsPanel/currentDM change.
            // No servers — show the Friends panel. The full-screen welcome popup
            // is first-run onboarding only: without the guard it re-appeared
            // (blocking the whole UI) any time the server count hit zero, e.g.
            // right after being kicked from your last server.
            setShowFriendsPanel(true);
            if (!localStorage.getItem('welcome_seen')) {
                setShowWelcomePopup(true);
            }
            // The Friends dashboard renders in the "chat" panel slot on mobile
            // (mobile.css tracks its transform off .chat-main) — 'servers' would
            // slide it off-screen behind the empty server rail.
            setMobilePanel('chat');
        }
    }, [servers, currentServer, isServersLoading, currentDM, showFriendsPanel, showDevicesView]);

    // Load the DM conversation list that backs the home/DM sidebar menu.
    // Refreshes when a DM is opened so a freshly-created conversation (incl.
    // the "Notes to self" self-DM) shows up in the list.
    useEffect(() => {
        listDMConversations().then(cs => {
            setDmConversations(cs);
            // Only a SUCCESSFUL fetch may declare the list known — the
            // launcher-shortcuts sync below must not mistake "not loaded
            // yet" (or a failed fetch) for "the user has no conversations".
            setDmsLoaded(true);
        }).catch(() => {});
    }, [currentDM]);


    // Initialize channel selection (but not if viewing a collection)
    useEffect(() => {
        if (currentServer && channels.length > 0 && !currentChannel && !currentCollection) {
            const textChannel = channels.find(c => c.channel_type === 0) || channels[0];
            setCurrentChannel(textChannel);
        }
    }, [currentServer, channels, currentChannel, currentCollection]);

    // DM loading handled by hooks, skipping specific DM init for now or relying on defaults

    // We can remove the manual isLoading state and rely on isServersLoading
    useEffect(() => {
        if (!isServersLoading) {
            setIsLoading(false);
        }
    }, [isServersLoading]);

    // Debug: Document-level drag event listener to test WebView2
    useEffect(() => {
        const handleDocDragOver = (e: DragEvent) => {
            console.log('[DRAG] DOCUMENT dragover fired! target:', (e.target as HTMLElement)?.className);
        };
        const handleDocDrop = (_e: DragEvent) => {
            console.log('[DRAG] DOCUMENT drop fired!');
        };
        document.addEventListener('dragover', handleDocDragOver, { capture: true });
        document.addEventListener('drop', handleDocDrop, { capture: true });
        return () => {
            document.removeEventListener('dragover', handleDocDragOver, { capture: true });
            document.removeEventListener('drop', handleDocDrop, { capture: true });
        };
    }, []);

    // Member polling handled by useServerMembers hook (refetchInterval)

    // Fetch unread counts when server changes
    useEffect(() => {
        if (!currentServer) return;

        const fetchUnreadCounts = async () => {
            try {
                const result = await getUnreadCounts(currentServer.id);
                const countsMap = new Map<number, number>();
                result.channels.forEach((c: ChannelUnreadCount) => {
                    countsMap.set(c.channel_id, c.unread_count);
                });
                // Never re-light the badge on the channel the user is
                // CAUGHT UP on: a poll in flight when a mark-read POST lands
                // would otherwise overwrite the zero with a stale count. The
                // suppression matches the mark-read conditions exactly — a
                // scrolled-up reader or a covered chat keeps a real badge.
                // Via refs so this effect stays keyed on the server id alone.
                const activeId = currentChannelIdRef.current;
                if (activeId !== null && appIsForeground()
                    && showingMessageListRef.current && atBottomRef.current) {
                    countsMap.set(activeId, 0);
                }
                setUnreadCounts(countsMap);
            } catch (error) {
                console.error('[Chat] Failed to fetch unread counts:', error);
            }
        };

        fetchUnreadCounts();

        // Refresh unread counts every 30 seconds
        const interval = setInterval(fetchUnreadCounts, 30000);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the selection id, not the object identity
    }, [currentServer?.id]);

    // Fetch active voice users when the server changes AND on every WS
    // (re)connect: presence is otherwise event-driven, so a device whose
    // socket was down (phone waking up, network blip) missed the events for
    // good and showed an empty/stale voice sidebar until changing servers.
    //
    // Keyed on a VALUE-stable string of voice-channel ids, not the channels
    // array: react-query's `= []` default is a fresh identity every render
    // while the query is unresolved, and this effect's own success setState
    // re-renders — an array dep made that a self-sustaining refetch loop.
    const voiceRoomKey = channels.filter(c => c.channel_type === 1).map(c => c.id).join(',');
    useEffect(() => {
        if (!currentServer) return;

        const loadVoiceUsers = async () => {
            try {
                const seqAtFetch = voiceEventSeqRef.current;
                const voiceResponse = await fetchVoiceUsers(currentServer.id);
                if (voiceEventSeqRef.current !== seqAtFetch) {
                    // Stale: WS events already advanced the roster past this
                    // snapshot. The next wsConnected/server switch refetches.
                    return;
                }
                // AUTHORITATIVE merge for this server's voice rooms: rebuild
                // each room from the snapshot, pruning users the server no
                // longer lists (the old add-only merge kept ghosts forever)
                // while preserving the local mute/deafen statuses of retained
                // users (the snapshot doesn't carry status).
                const byRoom = new Map<string, typeof voiceResponse.voice_users>();
                for (const vu of voiceResponse.voice_users) {
                    if (!byRoom.has(vu.room_id)) byRoom.set(vu.room_id, []);
                    byRoom.get(vu.room_id)!.push(vu);
                }
                const serverRoomIds = new Set(
                    channels.filter(c => c.channel_type === 1).map(c => `voice_${c.id}`)
                );
                for (const roomId of serverRoomIds) {
                    const snapshot = byRoom.get(roomId) ?? [];
                    const existing = globalVoiceUsers.get(roomId) ?? new Map();
                    const rebuilt = new Map<number, VoiceUserStatus>();
                    for (const vu of snapshot) {
                        rebuilt.set(vu.user_id, existing.get(vu.user_id) ?? {
                            id: vu.user_id,
                            username: vu.username,
                            isMuted: false,
                            isDeafened: false,
                        });
                    }
                    globalVoiceUsers.set(roomId, rebuilt);
                }
                // Notify sidebar to re-render
                setVoiceUpdateTrigger(prev => prev + 1);
            } catch (error) {
                console.warn('[Chat] Failed to fetch voice users:', error);
            }
        };

        loadVoiceUsers();
        window.addEventListener('wsConnected', loadVoiceUsers);
        return () => window.removeEventListener('wsConnected', loadVoiceUsers);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on selection id + value-stable room key, not object identity
    }, [currentServer?.id, voiceRoomKey]);

    // Listen for voice events to refresh the voice users display
    useEffect(() => {
        const handleStreamStarted = (msg: ServerMessage) => {
            const payload = msg.payload as {
                room_id: string;
                streamer: { id: number; username: string }
            };

            // Directly update global voice users for instant sync — status-
            // preserving: StreamStarted is replayed for existing members on
            // every join/reconnect and must not reset their mute/deafen.
            upsertVoiceUser(payload.room_id, { id: payload.streamer.id, username: payload.streamer.username });

            // Trigger re-render
            triggerVoiceRefresh();
        };

        const handleStreamStopped = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string; streamer_id: number };

            // Directly remove from global voice users
            globalVoiceUsers.get(payload.room_id)?.delete(payload.streamer_id);

            // Trigger re-render
            triggerVoiceRefresh();
        };

        wsClient.on('StreamStarted', handleStreamStarted);
        wsClient.on('StreamStopped', handleStreamStopped);

        return () => {
            wsClient.off('StreamStarted', handleStreamStarted);
            wsClient.off('StreamStopped', handleStreamStopped);
        };
    }, []);

    // Listen for real-time channel creation from other users
    useEffect(() => {
        const handleChannelCreated = (msg: ServerMessage) => {
            const payload = msg.payload as { server_id: string; channel: Channel };
            // Refetch rather than cache-append: the broadcast ChannelInfo has no
            // my_permissions, and hasPerm's undefined-fallback is allow — an
            // appended row would enable the composer/add-task UI for recipients
            // whose roles lack the bits until the next natural refetch.
            if (currentServer && payload.server_id === currentServer.id) {
                queryClient.invalidateQueries({ queryKey: keys.channels(currentServer.id) });
            }
        };

        wsClient.on('ChannelCreated', handleChannelCreated);
        return () => {
            wsClient.off('ChannelCreated', handleChannelCreated);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the selection id, not the object identity
    }, [currentServer?.id]);

    // Live permission changes: someone edited channel overwrites / role bits /
    // member roles in a server → refetch that server's channel list (channels
    // may appear, vanish, or carry different my_permissions). The effect below
    // deselects the open channel if it vanished from the refreshed list.
    useEffect(() => {
        const handleChannelPermsChanged = (msg: ServerMessage) => {
            const payload = msg.payload as { server_id: string };
            queryClient.invalidateQueries({ queryKey: keys.channels(payload.server_id) });
        };
        wsClient.on('ChannelPermsChanged', handleChannelPermsChanged);
        return () => {
            wsClient.off('ChannelPermsChanged', handleChannelPermsChanged);
        };
    }, [queryClient]);

    // If the open channel disappears from the refreshed list (VIEW_CHANNEL
    // revoked, or deleted while we looked away), deselect it — mirroring the
    // kicked-from-server fallback: steer the mobile panel back to the channel
    // list and close overlays covering the now-gone channel. The channel
    // auto-select effect above then picks the first channel we can still see.
    useEffect(() => {
        if (!currentServer || !channelsFetched) return;
        if (currentChannel) {
            const fresh = channels.find(c => c.id === currentChannel.id);
            if (!fresh) {
                setCurrentChannel(null);
                setMessages([]);
                setShowChecklist(false);
                setShowPins(false);
                if (isMobile) setMobilePanel('channels');
            } else if (fresh !== currentChannel) {
                // Same channel, refreshed row — adopt it so my_permissions (the
                // composer/checklist gates) can't go stale after a perms change.
                setCurrentChannel(fresh);
            }
        }
        if (currentCollection && !channels.some(c => c.id === currentCollection.id)) {
            setCurrentCollection(null);
            setMessages([]);
            if (isMobile) setMobilePanel('channels');
        }
        // A voice channel we can no longer see — but only if it belongs to THIS
        // server: voice persists while browsing other servers, and their
        // channel lists must not disconnect it.
        if (currentVoiceChannel && currentVoiceChannel.server_id === currentServer.id &&
            !channels.some(c => c.id === currentVoiceChannel.id)) {
            setCurrentVoiceChannel(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the refreshed channel list
    }, [channels, channelsFetched, currentServer?.id]);

    // Listen for real-time direct messages
    useEffect(() => {
        const handleDirectMessage = async (msg: ServerMessage) => {
            const payload = msg.payload as {
                message_id: string;
                conversation_id: string;
                sender: { id: number; username: string; display_name?: string | null };
                content: string;
                timestamp: number;
            };

            // Blocked sender: the server refuses their sends, so this only
            // fires for frames already in flight when the block landed — but a
            // blocked user must never ping you, so belt and braces.
            if (isBlocked(payload.sender.id)) return;

            // Ping for an incoming DM from someone else that isn't the
            // conversation already on screen. (self-gates on the `message` setting.)
            if (payload.sender.id !== currentUserId) {
                // Same rule as channels: notify on FOCUS, ping on what is open.
                notifyNewMessage({
                    title: `${payload.sender.display_name || payload.sender.username} sent you a message`,
                    isOwn: false,
                    isMuted: false,     // DMs have no per-conversation mute yet
                    // Android: one notification per conversation, tap lands in it.
                    notifyKey: `dm:${payload.conversation_id}`,
                    nav: `dm:${payload.conversation_id}`,
                });
                if (!(currentDM && payload.conversation_id === currentDM.id)) {
                    playMessageSound();
                    // In-app shade, WITH the decrypted body — a DM's plaintext
                    // is available here (pairwise key = the sender), unlike
                    // the content-free channel notification.
                    if (appIsForeground() && loadSettings().messageToasts) {
                        const from = payload.sender.display_name || payload.sender.username;
                        decryptDMContent(payload.content, payload.sender.id)
                            .then(body => pushMessageToast({
                                title: from,
                                body: body.length > 120 ? `${body.slice(0, 120)}…` : body,
                            }))
                            .catch(() => pushMessageToast({ title: `${from} sent you a message` }));
                    }
                }
            }

            // Only add if we're in DM mode and it's for this conversation
            if (currentDM && payload.conversation_id === currentDM.id) {
                // Decrypt with the conversation partner's key (works for both
                // incoming messages and the server's echo of our own).
                const displayContent = await decryptDMContent(payload.content, currentDM.other_user_id);
                const newDMMessage = {
                    id: payload.message_id,
                    conversation_id: payload.conversation_id,
                    sender_id: payload.sender.id,
                    sender_username: payload.sender.username,
                    sender_display_name: payload.sender.display_name || null,
                    content: displayContent,
                    created_at: new Date(payload.timestamp * 1000).toISOString(),
                    encState: messageEncState(payload.content, displayContent),
                };

                setDmMessages(prev => {
                    // Avoid duplicates
                    if (prev.some(m => m.id === payload.message_id)) return prev;
                    // Remove the optimistic bubble for our own just-sent message
                    // (matched on decrypted content, since the wire form differs).
                    const filtered = prev.filter(m =>
                        !(m.id.startsWith('local_') && m.sender_id === payload.sender.id && m.content === displayContent)
                    );
                    return [...filtered, newDMMessage];
                });
            }
        };

        wsClient.on('DirectMessage', handleDirectMessage);
        return () => {
            wsClient.off('DirectMessage', handleDirectMessage);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the selection id, not the object identity
    }, [currentDM?.id]);

    // Load message history when channel changes
    useEffect(() => {
        if (!currentChannel) return;

        // Guard against a slow fetch for a previous channel resolving after the
        // user has already switched away — without this, channel A's history can
        // land in (and overwrite) channel B's view.
        let cancelled = false;

        async function loadMessages() {
            try {
                console.debug('[Chat] Loading messages for channel:', currentChannel!.id);
                const raw = await getMessages(currentChannel!.id, 50);
                const history = await decryptChannelMessages(currentChannel!.id, raw);
                if (cancelled) return;
                console.debug('[Chat] Loaded messages count:', history.length);
                // First pass: Convert API messages to display format
                const displayMessages: DisplayMessage[] = history.map((msg: ApiMessage) => ({
                    id: msg.id,
                    sender: { id: msg.user_id, username: msg.username },
                    content: msg.content,
                    timestamp: parseServerTimestampSecs(msg.created_at),
                    created_at: msg.created_at,
                    reply_to_id: msg.reply_to_id,
                    is_task: msg.is_task,
                    is_completed: msg.is_completed,
                    parent_message_id: msg.parent_message_id,
                    encState: msg.encState,
                    clip_consent: msg.clip_consent ?? undefined,
                }));

                // Second pass: Populate reply_to references
                const messagesById = new Map(displayMessages.map(m => [m.id, m]));
                displayMessages.forEach(msg => {
                    if (msg.reply_to_id) {
                        const parentMsg = messagesById.get(msg.reply_to_id);
                        if (parentMsg) {
                            msg.reply_to = {
                                id: parentMsg.id,
                                username: parentMsg.sender.username,
                                content: parentMsg.content.slice(0, 100),
                            };
                        }
                    }
                });

                if (cancelled) return;
                console.debug('[Chat] Setting messages:', displayMessages.length);
                setMessages(displayMessages);

                // Mark channel as read and clear unread count
                markReadNow(currentChannel!.id);
            } catch (error) {
                console.error('Failed to load messages:', error);
            }
        }
        loadMessages();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the selection id, not the object identity
    }, [currentChannel?.id]);

    // Load messages from all subchannels when collection is selected
    useEffect(() => {
        if (!currentCollection) return;

        // Same stale-response guard as the single-channel loader above.
        let cancelled = false;

        async function loadCollectionMessages() {
            try {
                // Get all subchannels of this collection
                const subchannels = channels.filter(c => c.parent_id === currentCollection!.id && c.channel_type === 0);
                console.debug('[Chat] Loading collection messages for', subchannels.length, 'subchannels');

                if (subchannels.length === 0) {
                    if (!cancelled) setMessages([]);
                    return;
                }

                // Load messages from all subchannels in parallel
                const allMessagePromises = subchannels.map(async (subchannel) => {
                    try {
                        const rawSub = await getMessages(subchannel.id, 50);
                        const history = await decryptChannelMessages(subchannel.id, rawSub);
                        return history.map((msg: ApiMessage) => ({
                            id: msg.id,
                            sender: { id: msg.user_id, username: msg.username },
                            content: msg.content,
                            timestamp: parseServerTimestampSecs(msg.created_at),
                    created_at: msg.created_at,
                            reply_to_id: msg.reply_to_id,
                            channelId: subchannel.id,
                            channelName: subchannel.name,
                            encState: msg.encState,
                            clip_consent: msg.clip_consent ?? undefined,
                        }));
                    } catch (err) {
                        console.error(`Failed to load messages for ${subchannel.name}:`, err);
                        return [];
                    }
                });

                const allMessagesArrays = await Promise.all(allMessagePromises);

                // Flatten and sort chronologically
                const allMessages: DisplayMessage[] = allMessagesArrays
                    .flat()
                    .sort((a, b) => a.timestamp - b.timestamp);

                if (cancelled) return;
                console.debug('[Chat] Loaded collection messages total:', allMessages.length);
                setMessages(allMessages);
            } catch (error) {
                console.error('Failed to load collection messages:', error);
            }
        }
        loadCollectionMessages();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the selection id, not the object identity
    }, [currentCollection?.id, channels]);

    // Global presence listener
    useEffect(() => {
        if (!currentServer) return;

        const handleUserOnline = (msg: ServerMessage) => {
            const payload = msg.payload as { user: { id: number; username: string } };
            queryClient.setQueryData(keys.members(currentServer.id), (old: MemberWithRoles[] | undefined) => {
                return (old || []).map(m =>
                    m.id === payload.user.id ? { ...m, is_online: true } : m
                );
            });
        };

        const handleUserOffline = (msg: ServerMessage) => {
            const payload = msg.payload as { user_id: number };
            queryClient.setQueryData(keys.members(currentServer.id), (old: MemberWithRoles[] | undefined) => {
                return (old || []).map(m =>
                    m.id === payload.user_id ? { ...m, is_online: false } : m
                );
            });
        };

        wsClient.on('UserOnline', handleUserOnline);
        wsClient.on('UserOffline', handleUserOffline);

        return () => {
            wsClient.off('UserOnline', handleUserOnline);
            wsClient.off('UserOffline', handleUserOffline);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the selection id, not the object identity
    }, [currentServer?.id, queryClient]);

    // Real-time removal: if we get kicked/banned from a server, drop it
    // immediately instead of showing a stale server until the next reload.
    useEffect(() => {
        const handleRemovedFromServer = (msg: ServerMessage) => {
            const payload = msg.payload as { server_id: string };
            queryClient.invalidateQueries({ queryKey: keys.servers });
            if (currentServer?.id === payload.server_id) {
                setCurrentServer(null);
                setCurrentChannel(null);
                setCurrentVoiceChannel(null);
                setMessages([]);
                setShowFriendsPanel(true);
                setShowDevicesView(false);
                if (isMobile) setMobilePanel('chat');
            }
        };
        wsClient.on('RemovedFromServer', handleRemovedFromServer);
        return () => wsClient.off('RemovedFromServer', handleRemovedFromServer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentServer?.id]);

    // WebSocket for real-time updates (channel-specific)
    useEffect(() => {
        if (!currentChannel) return;

        // Use unique channel ID as room ID
        const roomId = `channel_${currentChannel.id}`;
        wsClient.joinRoom(roomId);

        const handleRoomJoined = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string; members: User[] };
            if (payload.room_id === roomId && currentServer) {
                queryClient.invalidateQueries({ queryKey: keys.members(currentServer.id) });
            }
        };

        const handleUserJoined = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string; user: User };
            if (payload.room_id === roomId && currentServer) {
                queryClient.invalidateQueries({ queryKey: keys.members(currentServer.id) });
            }
        };

        const handleUserLeft = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string; user_id: number };
            if (payload.room_id === roomId && currentServer) {
                queryClient.invalidateQueries({ queryKey: keys.members(currentServer.id) });
            }
        };

        const handleChatMessage = async (msg: ServerMessage) => {
            const payload = msg.payload as {
                room_id: string;
                sender: User;
                content: string;
                timestamp: number;
                message_id?: string;
                clip_consent?: ClipConsent | null;
            };

            if (payload.content.startsWith('__VOICE_STATUS__')) return;
            // Own-sender frames are NOT dropped: the server includes the sender
            // in the broadcast on purpose (multi-device sync — see
            // message_handlers.rs), and the reconcile below adopts the echo
            // into the optimistic bubble. A blanket drop here meant a phone
            // whose REST response was lost (or another device of this account)
            // never saw its own message until the channel reloaded.
            const ownEcho = payload.sender.id === currentUserId;

            if (payload.room_id === roomId && currentChannel) {
                const displayContent = await decryptChannelContent(currentChannel.id, payload.content);
                // @mention ping. This can only exist HERE: messages are E2EE, so
                // the cross-channel MessageNotification carries no content — the
                // open channel is the one place decrypted text is in hand. (When
                // this channel isn't on screen the generic message blip may fire
                // too; the pair ~100ms apart reads as emphasis, not a bug.)
                // Members via the REF: this closure outlives the members query,
                // and the render path already reads the fresh list — a mention
                // must not highlight without pinging.
                const self = allMembersRef.current.find(m => m.id === currentUserId);
                if (!ownEcho && currentUser && messageMentionsUser(displayContent, {
                    username: currentUser.username,
                    display_name: self?.display_name,
                    server_nickname: self?.server_nickname,
                }) && !(currentChannel.server_id && isServerMuted(currentChannel.server_id))
                    && !isChannelMuted(currentChannel.id)
                    // A blocked member @mentioning you must not ping. The
                    // message still enters state — the render path collapses
                    // it, and unblocking reveals it without a refetch.
                    && !isBlocked(payload.sender.id)) {
                    playMentionSound();
                }
                // Prefer the persisted DB id (REST-created messages) so
                // reactions/edits/pins key to the real message; fall back to a
                // synthetic-but-unique id for legacy WS-only relays (timestamp is
                // per-second, so two rapid messages from one sender would collide).
                const id = payload.message_id
                    ?? `ws-${payload.timestamp}-${payload.sender.id}-${Math.random().toString(36).slice(2, 8)}`;
                setMessages(prev => {
                    // Dedup: a re-broadcast (e.g. after a room re-join) must not
                    // append the same message twice. Mirrors the DM handler.
                    if (payload.message_id && prev.some(m => m.id === payload.message_id)) return prev;
                    // Our own echo: ADOPT the persisted id into the optimistic
                    // bubble rather than replacing it — the WS frame carries no
                    // reply_to/is_task, so a replace would strip the reply
                    // banner/task checkbox off our own message until reload.
                    // Matching by content mirrors the DM handler's shape.
                    if (ownEcho) {
                        const i = prev.findIndex(m =>
                            String(m.id).startsWith('local_')
                            && m.sender.id === payload.sender.id
                            && m.content === displayContent);
                        if (i !== -1) {
                            const next = [...prev];
                            next[i] = { ...next[i], id, ...(payload.clip_consent ? { clip_consent: payload.clip_consent } : {}) };
                            return next;
                        }
                    }
                    return [...prev, {
                        id,
                        sender: payload.sender,
                        content: displayContent,
                        timestamp: payload.timestamp,
                        encState: messageEncState(payload.content, displayContent),
                        clip_consent: payload.clip_consent ?? undefined,
                    }];
                });
                // The user just read this on screen — advance the read cursor,
                // or the 30s poll re-lights the badge on the open channel.
                // Gated on focus + the message list actually being on screen
                // (not covered by the voice/stream/checklist views) + pinned
                // at the bottom, so nothing unseen is ever marked read.
                if (document.visibilityState === 'visible' && document.hasFocus()
                    && showingMessageListRef.current && atBottomRef.current) {
                    scheduleMarkRead(currentChannel.id);
                }
            }
        };

        const handleUserTyping = (msg: { payload?: Record<string, unknown> }) => {
            const payload = msg.payload as {
                room_id: string;
                user: { id: number; username: string };
            };
            const channelRoomId = `channel_${currentChannel?.id}`;
            if (payload.room_id !== channelRoomId) return;
            if (payload.user.id === currentUserId) return;
            // "X is typing…" names a blocked user in the UI and telegraphs a
            // message you have chosen not to see.
            if (isBlocked(payload.user.id)) return;

            const expiry = Date.now() + 5000;
            setTypingUsers(prev => {
                const newMap = new Map(prev);
                newMap.set(payload.user.id, { username: payload.user.username, expiry });
                return newMap;
            });
        };

        wsClient.on('RoomJoined', handleRoomJoined);
        wsClient.on('UserJoined', handleUserJoined);
        wsClient.on('UserLeft', handleUserLeft);
        wsClient.on('ChatMessage', handleChatMessage);
        wsClient.on('UserTyping', handleUserTyping);

        const typingCleanupInterval = setInterval(() => {
            const now = Date.now();
            setTypingUsers(prev => {
                const newMap = new Map(prev);
                for (const [userId, data] of newMap) {
                    if (data.expiry < now) newMap.delete(userId);
                }
                return newMap;
            });
        }, 1000);

        return () => {
            wsClient.off('RoomJoined', handleRoomJoined);
            wsClient.off('UserJoined', handleUserJoined);
            wsClient.off('UserLeft', handleUserLeft);
            wsClient.off('ChatMessage', handleChatMessage);
            wsClient.off('UserTyping', handleUserTyping);
            wsClient.leaveRoom(roomId);
            clearInterval(typingCleanupInterval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the selection id, not the object identity
    }, [currentChannel?.id, currentUserId, currentServer?.id, queryClient]);

    // Global voice listener
    useEffect(() => {
        const handleGlobalStreamStarted = (msg: ServerMessage) => {
            const payload = msg.payload as {
                room_id: string;
                streamer: { id: number; username: string }
            };
            // Status-preserving (see upsertVoiceUser): a replay must not
            // un-deafen people.
            upsertVoiceUser(payload.room_id, { id: payload.streamer.id, username: payload.streamer.username });
            voiceEventSeqRef.current += 1;
            setVoiceUpdateTrigger(prev => prev + 1);
        };

        const handleGlobalStreamStopped = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string; streamer_id: number };
            globalVoiceUsers.get(payload.room_id)?.delete(payload.streamer_id);
            voiceEventSeqRef.current += 1;
            setVoiceUpdateTrigger(prev => prev + 1);
        };

        // Belt-and-braces for multi-device voice: when the server evicts us from
        // a voice room (joining voice elsewhere, or losing access), drop our own
        // entry immediately on EVERY device instead of waiting for a snapshot
        // refetch — otherwise we linger in the old channel's roster and appear
        // to be in two places at once. No-op for text rooms.
        const handleGlobalRoomLeft = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string };
            if (globalVoiceUsers.get(payload.room_id)?.delete(currentUserId)) {
                voiceEventSeqRef.current += 1;
                setVoiceUpdateTrigger(prev => prev + 1);
            }
        };

        // The remove-side mirror of UserJoined for VOICE rooms only: the
        // voice-exclusivity eviction announces the vacated room with UserLeft,
        // and without this handler nothing ever retracted ANOTHER user's entry
        // on that event — the "shows as AFK and in the voice channel at once"
        // duplicate. Text rooms keep their members-query invalidation in the
        // channel-scoped listener; this touches only the voice roster.
        const handleGlobalUserLeft = (msg: ServerMessage) => {
            const payload = msg.payload as { room_id: string; user_id: number };
            if (!payload.room_id?.startsWith('voice_')) return;
            if (globalVoiceUsers.get(payload.room_id)?.delete(payload.user_id)) {
                voiceEventSeqRef.current += 1;
                setVoiceUpdateTrigger(prev => prev + 1);
            }
        };

        // A moderator moved US to another voice channel. The server has already
        // removed us from the old room and cut our media there, so this is a
        // directive, not a request: ignoring it would leave us out of voice.
        //
        // It arrives WITHOUT a RoomLeft, deliberately — see ws::SelfNotice. The
        // RoomLeft handler above calls onDisconnect, which nulls
        // currentVoiceChannel, and that would land in the same dispatch tick as
        // the switch below and race it.
        //
        // The roster delete below is belt-and-braces: the eviction also sends us
        // a StreamStopped, which handleGlobalStreamStopped already acts on. Kept
        // because it is the one retraction whose subject is US, and it must not
        // depend on the order two messages happen to arrive in.
        const handleVoiceMoved = (msg: ServerMessage) => {
            const payload = msg.payload as {
                server_id: string;
                channel_id: number;
                from_channel_id: number;
                moved_by: string;
            };
            if (globalVoiceUsers.get(`voice_${payload.from_channel_id}`)?.delete(currentUserId)) {
                voiceEventSeqRef.current += 1;
                setVoiceUpdateTrigger(prev => prev + 1);
            }
            // Were we actually in the room this directive is about? Sampled
            // SYNCHRONOUSLY, because by the time the resolve below settles the
            // answer can already have been erased:
            //
            // on an SFU channel the server's forced LiveKit removal reaches the
            // browser over LiveKit's OWN socket and fires VoicePanel's
            // onDisconnected -> onDisconnect -> setCurrentVoiceChannel(null),
            // with no network hop to wait for. Judging the move on `prev` alone
            // therefore saw null and dropped it: every move on an SFU channel
            // silently became a disconnect, under a toast that said otherwise.
            const wasInSource = currentVoiceChannelRef.current?.id === payload.from_channel_id;
            if (!wasInSource) return; // stale, duplicated, or for another device
            /** Destination unreachable: say so and leave voice, rather than
             *  rendering a call the server has already taken us out of. */
            const stranded = (what: string) => {
                setCurrentVoiceChannel(prev =>
                    (prev === null || prev.id === payload.from_channel_id) ? null : prev
                );
                showToast(`${payload.moved_by} ${what}.`);
            };
            // Resolve the destination from the query cache of ITS OWN server —
            // being moved while browsing a different server is ordinary, so the
            // viewed server's channel list is the wrong place to look. Ids only
            // ride the wire because ChannelInfo carries no sfu_mode, and mounting
            // the voice panel without it negotiates a mesh into an SFU channel.
            //
            // staleTime: 0 — the destination is very often a channel the mover
            // just created, and this cache entry is NOT invalidated for a server
            // we are not currently viewing, so the default 5-minute staleness
            // would answer from a list that predates the channel.
            queryClient.fetchQuery({
                queryKey: keys.channels(payload.server_id),
                queryFn: () => listChannels(payload.server_id),
                staleTime: 0,
            }).then((list: Channel[]) => {
                const target = list.find(c => c.id === payload.channel_id);
                if (!target) {
                    // The server has ALREADY removed us from the old room, so
                    // "do nothing" would leave a panel rendering a call that
                    // exists nowhere, mic still open. Land on the truth instead.
                    stranded('moved you out of the channel');
                    return;
                }
                setCurrentVoiceChannel(prev =>
                    // `prev === null` is accepted only because wasInSource was
                    // true: that is the SFU teardown above having beaten us to
                    // it. The cost is a narrow window in which someone who hangs
                    // up between the directive and this resolve is placed in the
                    // destination anyway — which is what the moderator asked for,
                    // and they can hang up again.
                    (prev === null || prev.id === payload.from_channel_id) ? target : prev
                );
                showToast(`${payload.moved_by} moved you to ${target.name}`);
            }).catch((err: unknown) => {
                console.error('VoiceMoved: failed to resolve destination channel:', err);
                stranded('moved you out of the channel');
            });
        };

        wsClient.on('StreamStarted', handleGlobalStreamStarted);
        wsClient.on('StreamStopped', handleGlobalStreamStopped);
        wsClient.on('RoomLeft', handleGlobalRoomLeft);
        wsClient.on('UserLeft', handleGlobalUserLeft);
        wsClient.on('VoiceMoved', handleVoiceMoved);

        return () => {
            wsClient.off('StreamStarted', handleGlobalStreamStarted);
            wsClient.off('StreamStopped', handleGlobalStreamStopped);
            wsClient.off('RoomLeft', handleGlobalRoomLeft);
            wsClient.off('UserLeft', handleGlobalUserLeft);
            wsClient.off('VoiceMoved', handleVoiceMoved);
        };
        // queryClient and showToast are both stable identities (useQueryClient,
        // and a useCallback with no deps), so listing them re-registers nothing.
    }, [currentUserId, queryClient, showToast]);

    // Cross-channel message ping: the backend notifies every online server
    // member (except the author) on each new channel message. Sound it unless
    // the server or channel is muted, or it's the channel already on screen
    // (you're looking at it). playMessageSound self-gates on the `message`
    // setting. Re-registers on channel switch so the "active channel" check
    // uses the current selection.
    useEffect(() => {
        const handleMessageNotification = (msg: ServerMessage) => {
            const p = msg.payload as {
                server_id: string; channel_id: number;
                message_id: string; author: { id: number; username: string };
            };
            if (p.author.id === currentUserId) return;
            // No toast/blip for people you blocked.
            if (isBlocked(p.author.id)) return;
            // "You're looking at it" requires the CHAT to actually be on screen.
            // currentChannel keeps pointing at the last text channel while the
            // voice or stream view owns the main area, so in a call every
            // message to that channel was silently swallowed — the reported
            // "text messages in voice make no noise". The friends dashboard and
            // the checklists board cover the chat for the same reason.
            const chatOnScreen = viewMode === 'chat' && !showFriendsPanel && !showAllChecklists;
            // isServerQuiet: 'nothing' AND 'mentions only' both silence the
            // GENERIC blip/toast — under mentions-only, the mention sound (the
            // open-channel ChatMessage path) is what still pings.
            const muted = isServerQuiet(p.server_id) || isChannelMuted(p.channel_id);
            // A desktop notification is for when you are NOT here at all, so it
            // is judged on window focus rather than on which channel is open —
            // and it is content-free, because messages are E2EE and a toast is
            // rendered by the OS on a lock screen.
            notifyNewMessage({
                title: `${p.author.username} sent a message`,
                isOwn: false,           // already returned above if it were ours
                isMuted: muted,
                // Android: collapse per server, tap lands on that server.
                notifyKey: `chan:${p.server_id}`,
                nav: `server:${p.server_id}`,
                onActivate: () => openChannelRef.current(p.channel_id),
            });
            if (chatOnScreen && currentChannel?.id === p.channel_id) return;
            // Rail bubble: live nudge for anything not on screen. Deliberately
            // NOT behind the mute gate — the render suppresses muted servers,
            // so unmuting shows the truth without a refetch.
            bumpServerUnread(p.server_id, p.channel_id);
            if (muted) return;
            playMessageSound();
            // In-app shade — the OS notification's complement (it fires only
            // UNfocused). Content-free by design: messages are E2EE and this
            // cross-channel frame carries none.
            if (appIsForeground() && loadSettings().messageToasts) {
                pushMessageToast({
                    title: `${p.author.username} sent a message`,
                    onClick: () => openChannelRef.current(p.channel_id),
                });
            }
        };
        wsClient.on('MessageNotification', handleMessageNotification);
        return () => wsClient.off('MessageNotification', handleMessageNotification);
    }, [currentChannel?.id, currentUserId, viewMode, showFriendsPanel, showAllChecklists]);

    // Somebody joined a server you are in.
    //
    // Quieter than a message by design: it is news, not something waiting for
    // you, so it never plays the message sound and never raises an in-app
    // toast — an OS notification while you are away, and nothing more. The
    // server's own mute silences it, on the principle that a server you have
    // muted should not find another way to speak.
    useEffect(() => {
        const handleMemberJoined = (msg: ServerMessage) => {
            const p = msg.payload as { server_id: string; user: { id: number; username: string } };
            if (p.user.id === currentUserId) return;   // the server excludes us; belt and braces
            if (isBlocked(p.user.id)) return;
            const serverName = servers.find(s => s.id === p.server_id)?.name;
            notifyNewMessage({
                title: serverName
                    ? `${p.user.username} joined ${serverName}`
                    : `${p.user.username} joined a server`,
                isOwn: false,
                isMuted: isServerQuiet(p.server_id),
                notifyKey: `join:${p.server_id}`,
                nav: `server:${p.server_id}`,
            });
        };
        wsClient.on('MemberJoined', handleMemberJoined);
        return () => wsClient.off('MemberJoined', handleMemberJoined);
    }, [currentUserId, servers]);

    // Clear the taskbar/tray unread badge the moment the user comes back —
    // matching the "focused messages don't notify" philosophy, the badge is a
    // latch for "something arrived while you were away". Also cleared on
    // unmount (logout) so a signed-out app never keeps a stale badge.
    //
    // Coming back to a text channel pinned at the bottom also advances that
    // channel's read cursor: whatever arrived while away is on screen now.
    // Scrolled-up readers keep their badge (they haven't seen the tail). The
    // channel comes via the ref so this effect keeps its one-shot [] deps.
    useEffect(() => {
        const clear = () => {
            setUnreadBadge(false);
            // Android: the tray of message notifications is the badge's
            // sibling latch — you are looking at the app now.
            void clearMobileNotifications();
            const activeId = currentChannelIdRef.current;
            // Message list on screen AND pinned at the bottom: what arrived
            // while away is visible now. A covered chat (voice view etc.) or
            // a scrolled-up reader keeps their unread state.
            if (activeId !== null && showingMessageListRef.current && atBottomRef.current) {
                markReadNow(activeId);
            }
        };
        const onVisibility = () => {
            if (document.visibilityState === 'visible' && document.hasFocus()) clear();
        };
        window.addEventListener('focus', clear);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.removeEventListener('focus', clear);
            document.removeEventListener('visibilitychange', onVisibility);
            setUnreadBadge(false);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- markReadNow is stable; refs carry the live channel
    }, []);

    // Conversation switch: forget the previous tail so the first page lands
    // pinned to the bottom, and drop a stale pill. MUST be declared above the
    // tail effect — layout effects run in declaration order, and inverting
    // them makes a channel switch re-scroll using the old conversation's
    // counters.
    useLayoutEffect(() => {
        lastTailIdRef.current = '';
        lastLenRef.current = 0;
        atBottomRef.current = true;
        // Explicit channel-open anchor (consumed by the tail effect): the old
        // prevLen===0 heuristic was a consumable one-shot — a WS message
        // landing between this reset and the history replace consumed it, the
        // replace then matched tailId===prevTail ("older page prepended") and
        // the view stayed parked at the TOP of the page. This is the "opens
        // on prior messages instead of the latest" bug.
        needsAnchorRef.current = true;
        // A restore captured for the PREVIOUS conversation must never scroll
        // this one (loadOlderMessages racing a switch).
        pendingRestoreRef.current = null;
        currentChannelIdRef.current = currentChannel?.id ?? null;
        setShowJumpLatest(false);
        setMissedCount(0);
    }, [currentChannel?.id, currentDM?.id, currentCollection?.id]);

    // Sticky auto-scroll. Reacts ONLY to a genuinely new tail message:
    //   length unchanged -> in-place edit / task toggle / optimistic-id swap
    //   length shrank    -> a delete
    //   same tail id     -> an older page prepended by loadOlderMessages
    // None of those may move the viewport. The old effect scrolled on EVERY
    // mutation of `messages`, which is why "Load older messages" threw you
    // straight back to the newest one and scrolling up was impossible to hold.
    useLayoutEffect(() => {
        const isDM = !!currentDM;
        const len = isDM ? dmMessages.length : messages.length;
        if (len === 0) { lastLenRef.current = 0; lastTailIdRef.current = ''; return; }
        const tailId = isDM ? dmMessages[len - 1].id : messages[len - 1].id;
        const prevLen = lastLenRef.current;
        const prevTail = lastTailIdRef.current;
        lastLenRef.current = len;
        lastTailIdRef.current = tailId;
        // Channel-open anchor: fires on the FIRST non-empty render after a
        // conversation switch, no matter how the transition interleaved (WS
        // appends during the fetch+decrypt window defeat the prevLen===0
        // heuristic below).
        if (needsAnchorRef.current) {
            needsAnchorRef.current = false;
            scrollToLatest('auto');
            return;
        }
        if (len <= prevLen) return;      // edit / delete / optimistic-id swap
        if (tailId === prevTail) return; // older page prepended
        if (prevLen === 0) { scrollToLatest('auto'); return; } // first page
        const mine = isDM
            ? dmMessages[len - 1].sender_id === currentUserId
            : messages[len - 1].sender.id === currentUserId;
        // Your own message always pulls you down; someone else's only if you
        // were already at the bottom.
        if (mine || atBottomRef.current) { scrollToLatest('auto'); return; }
        setShowJumpLatest(true);
        setMissedCount(n => n + (len - prevLen));
    }, [messages, dmMessages, currentDM, currentUserId, scrollToLatest]);

    // Older-page prepend: keep the reading position exactly where it was.
    useLayoutEffect(() => {
        const el = messagesContainerRef.current;
        if (!el || pendingRestoreRef.current == null) return;
        el.scrollTop = el.scrollHeight - pendingRestoreRef.current;
        pendingRestoreRef.current = null;
    }, [messages]);

    // Returning to the message list from a view that shared this container
    // (voice stage, stream, checklist, dashboard — all of which clamp
    // scrollTop to 0) re-renders the SAME conversation, so neither the switch
    // reset nor the tail effect fires — re-anchor here. Unconditionally on the
    // false→true transition: those views keep the scroller at 0, so there is
    // no reading position to preserve, and gating on atBottomRef meant a ref
    // poisoned by a scroll in the other view could never recover (the old
    // "clicking a text channel doesn't bring me to the latest message").
    const prevShowingListRef = useRef(showingMessageList);
    useLayoutEffect(() => {
        const was = prevShowingListRef.current;
        prevShowingListRef.current = showingMessageList;
        if (showingMessageList && !was) {
            atBottomRef.current = true;
            // Deliberately NOT arming needsAnchorRef here: `messages` does not
            // change on this transition, so nothing would consume the flag now
            // — it would sit armed until an unrelated later mutation (a new
            // message, an older-page prepend) and force-scroll the user to the
            // bottom mid-read. scrollToLatest alone does the anchoring.
            scrollToLatest('auto');
        }
    }, [showingMessageList, scrollToLatest]);

    // Late-loading media (lazy <img> in MessageContent, LinkPreview cards)
    // grows the list AFTER the effects above ran and would strand the view
    // short of the bottom. `load` does not bubble — listen in CAPTURE phase.
    // Content that grows WITHOUT a load event (text-only link-preview cards,
    // decrypted-attachment swaps) is covered by a ResizeObserver over the
    // container's children. Depends on isLoading because the component
    // early-returns before the container exists, so a [] dep would bind to a
    // null ref forever.
    useEffect(() => {
        const el = messagesContainerRef.current;
        if (!el || !showingMessageList) return;
        const repin = () => { if (atBottomRef.current) el.scrollTop = el.scrollHeight; };
        el.addEventListener('load', repin, true);
        el.addEventListener('error', repin, true);
        const ro = new ResizeObserver(repin);
        for (const child of el.children) ro.observe(child);
        const mo = new MutationObserver((muts) => {
            for (const m of muts) {
                m.addedNodes.forEach((n) => { if (n instanceof Element) ro.observe(n); });
            }
            repin();
        });
        // subtree: an <img> inserted DEEP inside an existing row (AuthedImg
        // renders null until its authed fetch resolves) must also repin —
        // childList alone only sees direct children of the scroller.
        mo.observe(el, { childList: true, subtree: true });
        return () => {
            el.removeEventListener('load', repin, true);
            el.removeEventListener('error', repin, true);
            ro.disconnect();
            mo.disconnect();
        };
        // Gated on the view: this container is SHARED with the checklist and
        // dashboard views, whose task thumbnails decrypt asynchronously — each
        // one fired `load` and slammed those lists to the bottom while the user
        // was reading the top. The observers keep the same gate (plus the
        // atBottomRef check inside repin) for exactly that reason.
    }, [isLoading, showingMessageList]);

    // Open/close the pinned-messages panel, decrypting each pin's content.
    const togglePins = async () => {
        if (showPins) { setShowPins(false); return; }
        if (!currentChannel) return;
        try {
            const pins = await listPinnedMessages(currentChannel.id);
            const decrypted = await Promise.all(
                pins.map(async (p) => ({ ...p, content: await decryptChannelContent(currentChannel.id, p.content) }))
            );
            setPinnedMessages(decrypted);
            setShowPins(true);
        } catch (err) {
            console.error('Failed to load pinned messages:', err);
            alert('Could not load pinned messages. Check your connection and try again.');
        }
    };

    const handleUnpin = async (messageId: string) => {
        if (!currentChannel) return;
        try {
            await unpinMessage(currentChannel.id, messageId);
            setPinnedMessages(prev => prev.filter(p => p.id !== messageId));
        } catch (err) {
            console.error('Failed to unpin:', err);
            alert('Could not unpin that message. Please try again.');
        }
    };

    // Load an older page of messages (pagination) and prepend them.
    const loadOlderMessages = async () => {
        if (!currentChannel || loadingOlder || messages.length === 0) return;
        setLoadingOlder(true);
        // A switch during the fetch/decrypt awaits must abandon this page:
        // prepending channel A's history into channel B (and the stale
        // pendingRestore scroll that followed) was one of the "opens on prior
        // messages" paths.
        const chanId = currentChannel.id;
        try {
            const oldest = messages[0];
            // Echo the server's cursor string verbatim when we have it —
            // rebuilding from the seconds float loses microsecond precision
            // and the strict `<` predicate then skips same-ms boundary rows.
            const before = oldest.created_at ?? new Date(oldest.timestamp * 1000).toISOString();
            const raw = await getMessages(chanId, 50, before);
            const older = await decryptChannelMessages(chanId, raw);
            if (currentChannelIdRef.current !== chanId) return;
            if (older.length === 0) return;
            const olderDisplay: DisplayMessage[] = older.map((m: ApiMessage) => ({
                id: m.id,
                sender: { id: m.user_id, username: m.username },
                content: m.content,
                timestamp: parseServerTimestampSecs(m.created_at),
                created_at: m.created_at,
                reply_to_id: m.reply_to_id,
                is_task: m.is_task,
                is_completed: m.is_completed,
                parent_message_id: m.parent_message_id,
                encState: m.encState,
                clip_consent: m.clip_consent ?? undefined,
            }));
            // Anchor the reading position: record the distance from the
            // bottom now, and restore it after the prepend commits (see the
            // layout effect) so the page you were reading doesn't jump.
            const scroller = messagesContainerRef.current;
            if (scroller) pendingRestoreRef.current = scroller.scrollHeight - scroller.scrollTop;
            setMessages(prev => {
                const existing = new Set(prev.map(m => m.id));
                const deduped = olderDisplay.filter(m => !existing.has(m.id));
                return [...deduped, ...prev];
            });
        } catch (err) {
            console.error('Failed to load older messages:', err);
            alert('Could not load older messages. Check your connection and try again.');
        } finally {
            setLoadingOlder(false);
        }
    };

    const handleSend = async (e: FormEvent) => {
        e.preventDefault();
        if (!currentUser) return;
        // Never mid-upload — sending then would ship without the file just
        // attached. SAY SO: the Enter path has no other feedback, and a
        // silently swallowed keypress reads as "send is broken".
        if (pendingAttachments.some(a => a.status === 'uploading')) {
            showToast('Waiting for the upload to finish — your message will keep its attachment.');
            return;
        }
        // Nonempty text or a ready attachment.
        if (!canSendComposer(input, pendingAttachments)) return;
        if (!canSendHere) return; // SEND_MESSAGES denied on this channel

        const text = input.trim();
        const timestamp = Date.now() / 1000;
        const replyToMessage = replyingTo;

        // Handle /nick command (typed text only; chips stay put)
        if (text.startsWith('/nick ') && currentServer) {
            const nickname = text.slice(6).trim();
            setInput('');
            try {
                await setServerNickname(currentServer.id, nickname || null);
                await queryClient.invalidateQueries({ queryKey: keys.members(currentServer.id) });
            } catch (err) {
                console.error('Failed to set nickname:', err);
                // The command already cleared the input, so silence here loses
                // what the user typed AND tells them nothing.
                alert('Could not set your nickname. You may not have permission on this server.');
            }
            return;
        }

        if (text === '/nick' && currentServer) {
            setInput('');
            try {
                await setServerNickname(currentServer.id, null);
                await queryClient.invalidateQueries({ queryKey: keys.members(currentServer.id) });
            } catch (err) {
                console.error('Failed to clear nickname:', err);
                alert('Could not clear your nickname. Please try again.');
            }
            return;
        }

        // Typed text + the ready chips' markdown, built ONLY now — the
        // sovereign-enc hrefs (which carry file keys) never touch the textarea.
        const content = buildOutgoingContent(input, pendingAttachments);

        setInput('');
        setReplyingTo(null); // Clear reply state
        // The message took the ready uploads; failed chips stay for retry.
        takeSentAttachments();

        // Handle DM messages
        if (currentDM) {
            const optimisticDMMessage = {
                id: `local_${timestamp}_${currentUserId}`,
                conversation_id: currentDM.id,
                sender_id: currentUserId,
                sender_username: currentUser.username,
                sender_display_name: null, // JWT doesn't include display_name
                content: content,
                created_at: new Date().toISOString(),
            };
            setDmMessages(prev => [...prev, optimisticDMMessage]);

            // Encrypt for the recipient, then send via WebSocket for realtime
            // delivery. The optimistic bubble above already shows our plaintext.
            // encryptDMContent fails CLOSED (audit H4): if the recipient's key is
            // unavailable / changed it throws instead of sending plaintext, so
            // drop the optimistic bubble and surface why the send was blocked.
            try {
                // DMs persist ONLY through the WS path (no REST fallback), and
                // wsClient.send() silently NO-OPS when the socket isn't OPEN —
                // it cannot throw. Without these guards a DM typed during a
                // reconnect window (laptop wake, wifi blip, a deploy; the
                // backoff grows to 30s) was encrypted, handed to a no-op and
                // lost, while the optimistic bubble stayed on screen with no
                // error. Silent data loss on the primary private path.
                //
                // Checked twice because the socket can drop DURING encryption.
                // Same guard ForwardModal.tsx already uses for the same reason;
                // this composer never got it.
                if (!wsClient.isConnected) throw new OfflineSendError();
                const wire = await encryptDMContent(content, currentDM.other_user_id);
                if (!wsClient.isConnected) throw new OfflineSendError();
                wsClient.sendDirectMessage(currentDM.other_user_id, wire);
            } catch (err) {
                console.error('Failed to send DM:', err);
                setDmMessages(prev => prev.filter(m => m.id !== optimisticDMMessage.id));
                alert(
                    err instanceof OfflineSendError
                        ? 'Not connected — reconnecting. Try again in a moment.'
                        : err instanceof SecureSendError
                            ? err.message
                            : 'Message failed to send. Check your connection and try again.'
                );
            }
            return;
        }

        // Handle server channel messages
        if (!currentChannel) return;

        // Optimistic update - add message to local state immediately
        const optimisticMessage: DisplayMessage = {
            id: `local_${timestamp}_${currentUserId}`,
            sender: { id: currentUserId, username: currentUser.username },
            content: content,
            timestamp: timestamp,
            reply_to_id: replyToMessage?.id,
            reply_to: replyToMessage ? {
                id: replyToMessage.id,
                username: replyToMessage.sender.username,
                content: replyPreviewText(replyToMessage.content, 100),
            } : undefined,
            is_task: isTaskMode,
            is_completed: false,
        };
        setMessages(prev => [...prev, optimisticMessage]);

        // Save to database via REST API (encrypted under the channel group key).
        // The backend broadcasts the stored wire content to the channel room, so
        // peers receive it in real time without a duplicate client-side WS send
        // (which would double-deliver) — and a REST failure never leaks a
        // plaintext fallback over the socket.
        try {
            const sent = await sendChannelMessageEncrypted(currentChannel.id, content, replyToMessage?.id, isTaskMode);
            // The WS echo can land BEFORE this response (the server broadcasts
            // before serializing the reply) and may have already adopted
            // sent.id into the bubble — in that case drop the stale optimistic
            // row instead of minting a duplicate id.
            setMessages(prev => prev.some(m => m.id === sent.id)
                ? prev.filter(m => m.id !== optimisticMessage.id)
                : prev.map(m => m.id === optimisticMessage.id ? { ...m, id: sent.id } : m));
            if (isTaskMode) setIsTaskMode(false); // Reset task mode after sending
            // Replying is unambiguous proof of presence: advance the read
            // cursor so the badge for this channel clears instead of
            // re-lighting on the next unread poll.
            markReadNow(currentChannel.id);
        } catch (error) {
            console.error('Failed to save message:', error);
            // A lost RESPONSE is not a rejected write: on a network-level
            // failure the server may well have persisted the message (common
            // on mobile right after a large upload saturated the uplink), and
            // the WS echo will adopt the bubble when it arrives. Only a
            // definitive server refusal deletes it immediately — but silence
            // is not an option either: if NOTHING confirms the bubble within
            // a grace window (echo lost too, genuinely offline), take it down
            // and say so, or the user walks away believing it sent.
            if (isNetworkError(error)) {
                setTimeout(() => {
                    let stillUnconfirmed = false;
                    setMessages(prev => {
                        stillUnconfirmed = prev.some(m => m.id === optimisticMessage.id);
                        return stillUnconfirmed
                            ? prev.filter(m => m.id !== optimisticMessage.id)
                            : prev;
                    });
                    setTimeout(() => {
                        if (stillUnconfirmed) {
                            alert('Message failed to send. Check your connection and try again.');
                        }
                    }, 0);
                }, 10_000);
                return;
            }
            // Surface the failure instead of silently keeping a phantom message.
            // A SecureSendError (fail-closed E2EE, audit H4) carries a specific,
            // actionable reason — show it verbatim.
            setMessages(prev => prev.filter(m => m.id !== optimisticMessage.id));
            alert(error instanceof SecureSendError ? error.message : 'Message failed to send. Check your connection and try again.');
        }
    };

    // Quote a message into the composer (a "> " markdown blockquote).
    // No-op in collection view: the composer is unmounted there, so the text
    // would silently persist and later leak into another channel's composer.
    const handleQuote = (content: string) => {
        if (currentCollection) return;
        // Strip attachment keys before they land in the composer as plaintext. (audit LOW)
        const quoted = formatQuote(stripAttachmentKeys(content));
        setInput(prev => prev && !prev.endsWith('\n') ? `${prev}\n${quoted}` : prev + quoted);
        inputRef.current?.focus();
    };

    // Channel id a message's own-message actions should target — collection
    // view rows carry their own channelId, the single-channel view falls back
    // to the open channel. Null/undefined = no channel context (e.g. DMs).
    const messageChannelId = (msg: DisplayMessage) => msg.channelId ?? currentChannel?.id;

    // Own-message actions shared by the hover toolbar and the context menu so
    // the two entry points can't drift apart.
    const editOwnMessage = async (msg: DisplayMessage) => {
        const channelId = messageChannelId(msg);
        if (!channelId) return;
        const newContent = prompt('Edit message:', msg.content);
        if (newContent && newContent !== msg.content) {
            try {
                // Encrypt the edit under the current channel-key epoch, exactly like
                // a fresh send — a raw-plaintext PATCH would defeat E2EE for the
                // edited message. (audit H3)
                await editChannelMessageEncrypted(channelId, msg.id, newContent);
                // encState must be re-set, not inherited: editing a message
                // that arrived as LEGACY plaintext re-sends it ENCRYPTED (the
                // call above always seals), so carrying the old 'legacy' state
                // through the spread would leave a now-false "Not encrypted"
                // badge on a message that is, at this point, encrypted.
                setMessages(prev => prev.map(m =>
                    m.id === msg.id ? { ...m, content: newContent, edited: true, encState: 'secure' as const } : m
                ));
            } catch (err) {
                console.error('Failed to edit:', err);
                alert(err instanceof SecureSendError ? err.message : 'Failed to edit message. Please try again.');
            }
        }
    };

    // "Delete for Me": purely local, works on ANY persisted message (channel
    // or DM, yours or not). No confirm — the toast IS the undo affordance,
    // scoped to the toast's own 6s lifetime; after that the hide is permanent
    // for this account+device (the message still exists for everyone else).
    const hideMessageForMe = (messageId: string) => {
        hideMessage(messageId);
        pushMessageToast({
            title: 'Message hidden for you',
            body: 'It still exists for everyone else. Click to undo.',
            onClick: () => unhideMessage(messageId),
        });
    };

    // Re-render when the hidden set changes (this account, any tab).
    const [, setHiddenRev] = useState(0);
    useEffect(() => {
        const bump = () => setHiddenRev(r => r + 1);
        window.addEventListener('hiddenMessagesChanged', bump);
        return () => window.removeEventListener('hiddenMessagesChanged', bump);
    }, []);

    // Filtered BEFORE grouping/date-divider logic, so hiding a run's first
    // message regroups its neighbours instead of leaving orphaned headers.
    const visibleMessages = messages.filter(m => !isMessageHidden(m.id));
    const visibleDmMessages = dmMessages.filter(m => !isMessageHidden(m.id));

    // Someone deleted a message — drop it from every surface still rendering
    // it. ALWAYS registered (not inside the channel-scoped effect): message
    // ids are globally unique, so pruning needs no channel gate, and gating on
    // currentChannel silently excluded the collection view, which renders rows
    // from several channels with currentChannel null. (Collection view still
    // only receives events for rooms this client joined — the same refresh-on-
    // reopen limitation live ChatMessage delivery has there.)
    useEffect(() => {
        const handleMessageDeleted = (msg: ServerMessage) => {
            const payload = msg.payload as { channel_id: number; message_id: string };
            setMessages(prev => prev.filter(m => m.id !== payload.message_id));
            setPinnedMessages(prev => prev.filter(p => p.id !== payload.message_id));
            setSearchOutcome(prev => prev === null ? prev : {
                ...prev,
                hits: prev.hits.filter(h => h.id !== payload.message_id),
            });
        };
        wsClient.on('MessageDeleted', handleMessageDeleted);
        return () => wsClient.off('MessageDeleted', handleMessageDeleted);
    }, []);

    // Deletes for EVERYONE. Allowed for the author, and — matching the server
    // rule that has always existed — for a Manage Messages holder in this
    // channel; the confirm names the author on the moderator path so nobody
    // moderates a message they misread as their own.
    const deleteMessageForEveryone = async (msg: DisplayMessage) => {
        const channelId = messageChannelId(msg);
        if (!channelId) return;
        const own = msg.sender.id === currentUserId;
        const ask = own
            ? 'Delete this message for everyone?'
            : `Delete this message by ${msg.sender.username} for everyone?`;
        if (!confirm(ask)) return;
        try {
            await deleteMessageApi(channelId, msg.id);
            setMessages(prev => prev.filter(m => m.id !== msg.id));
        } catch (err) {
            console.error('Failed to delete:', err);
            alert('Could not delete that message. Please try again.');
        }
    };

    const pinOwnMessage = async (msg: DisplayMessage) => {
        const channelId = messageChannelId(msg);
        if (!channelId) return;
        try {
            await pinMessage(channelId, msg.id);
            alert('Message pinned!');
        } catch (err) {
            console.error('Failed to pin:', err);
            // Success already alerts; staying silent only on FAILURE was the
            // worst of both — the user learns nothing went wrong.
            alert('Could not pin that message. You may not have permission.');
        }
    };

    // Open the Friends dashboard on its Tasks view — the rail's Notes button.
    // Personal lists (including "Notes to self") and the cross-server board
    // all live there now.
    const openTasksView = () => {
        setFriendsTab('tasks');
        setShowFriendsPanel(true);
        setShowDevicesView(false);
        setShowAllChecklists(false);
        setShowChecklist(false); // channel drawer would otherwise keep covering
        if (isMobile) setMobilePanel('chat');
    };

    // Due-time task reminders: the loop lives for the whole session (Chat is
    // the app shell), and a clicked reminder toast lands on the Tasks view.
    // The handler goes through a ref so the mount-only effect never holds a
    // stale closure. See api/taskReminders.ts for why reminders are
    // client-side (no push transport; content is E2EE).
    const openTasksViewRef = useRef(openTasksView);
    useEffect(() => { openTasksViewRef.current = openTasksView; });
    useEffect(() => {
        const stopReminders = startTaskReminders();
        const onOpenTasks = () => openTasksViewRef.current();
        window.addEventListener('sovereign:open-tasks', onOpenTasks);
        return () => {
            stopReminders();
            window.removeEventListener('sovereign:open-tasks', onOpenTasks);
        };
    }, []);

    // Open a DM conversation. DMs live in the home/DM view, never inside a
    // server — the sidebar keeps the Friends/Tasks nav + DM list (HomeSidebar)
    // so only the main content swaps to the conversation. Every DM entry
    // point (Friends panel, member popup, context menu, home sidebar) goes
    // through here so they can't drift apart again.
    const openDMConversation = (conversation: DMConversation) => {
        // Launcher ranking for this conversation's long-press shortcut
        // (Android only; a no-op everywhere else).
        reportConversationShortcutUsed(`dm:${conversation.id}`);
        setCurrentServer(null);
        setCurrentDM(conversation);
        setCurrentChannel(null);
        setCurrentCollection(null); // the composer is gated on !currentCollection
        setDmMessages([]); // clear the previous conversation while this one loads
        setShowFriendsPanel(false);
        setShowDevicesView(false);
        setShowAllChecklists(false); // board would otherwise cover the DM
        // Keep a live stream visible as a movable PiP rather than a full stage.
        if (getSelectedStreams().length > 0) setShowPip(true);
        setViewMode('chat'); // leave stream view if it was up
        if (isMobile) setMobilePanel('chat');
        // Staleness guard: on a fast A→B switch, A's slower fetch must not
        // land its messages under B's header.
        openDMFetchRef.current = conversation.id;
        getDMMessages(conversation.id)
            .then(msgs => decryptDMMessages(msgs, conversation.other_user_id))
            .then(msgs => {
                if (openDMFetchRef.current === conversation.id) setDmMessages(msgs);
            })
            .catch(err => console.error('Failed to load DM messages:', err));
    };

    // "Find or start a conversation" in the home sidebar picked a user.
    const startDMWithUser = (user: SearchUserResult) => {
        startDMConversation(user.id)
            .then(conv => {
                setHomeSearchQuery(''); // only clear once it worked
                openDMConversation(conv);
            })
            .catch(err => {
                console.error('Failed to start DM:', err);
                alert('Could not start that conversation. They may have blocked you, or you may be offline.');
            });
    };

    const handleChannelClick = (channel: Channel) => {
        setShowAllChecklists(false); // selecting a channel exits the All-checklists board
        setShowFriendsPanel(false); // the Friends dashboard otherwise keeps covering the channel
        setShowDevicesView(false); // same reason — it shares the dashboard slot
        if (channel.channel_type === 0) { // Text channel
            // If watching streams, switch to PiP mode instead of fully switching away
            const hasStreams = getSelectedStreams().length > 0;
            if (hasStreams && viewMode === 'stream') {
                setShowPip(true);
            }
            setViewMode('chat');
            setCurrentChannel(channel);
            setCurrentCollection(null); // Clear collection view
            // Leave any open DM — otherwise handleSend keeps routing messages to
            // the DM even though the user is now looking at a channel.
            setCurrentDM(null);
            // Clear only when actually CHANGING channel: the history loader is
            // keyed on currentChannel.id, so clicking the already-open channel
            // used to clear and never refetch — a blank list until you switched
            // away and back. (The setters above must still run: re-clicking the
            // channel while a DM/collection is displayed re-routes the view.)
            if (currentChannel?.id !== channel.id) {
                setMessages([]); // Clear messages while loading new channel
            }
            if (isMobile) setMobilePanel('chat');
        } else if (channel.channel_type === 1) { // Voice channel
            if (currentVoiceChannel?.id === channel.id) {
                // Already connected — open the persistent voice view in the
                // main area (leaving is only via the hang-up button, clicking
                // the channel again must never disconnect).
                setViewMode('voice');
                if (isMobile) setMobilePanel('chat');
            } else {
                // Seamless switch: directly set the new channel
                // VoicePanel will handle cleanup of old room and joining new room on remount
                setCurrentVoiceChannel(channel);
            }
        } else if (channel.channel_type === 2) { // Collection (category)
            // Show unified view of all subchannels
            const hasStreams = getSelectedStreams().length > 0;
            if (hasStreams && viewMode === 'stream') {
                setShowPip(true);
            }
            setViewMode('chat');
            setCurrentCollection(channel);
            setCurrentChannel(null); // Clear single channel selection
            setCurrentDM(null); // Leave any open DM (sends would route there)
            // Same-id guard as the text branch: the collection loader is keyed
            // on currentCollection.id, so re-clicking the open collection would
            // clear and never refetch.
            if (currentCollection?.id !== channel.id) {
                setMessages([]); // Clear messages while loading collection
            }
            if (isMobile) setMobilePanel('chat');
        }
    };

    const handleCreateChannel = async (e: FormEvent) => {
        e.preventDefault();
        console.log('[CREATE CHANNEL] Form submitted! Name:', newChannelName, 'Type:', newChannelType);
        if (!newChannelName.trim() || !currentServer) return;

        try {
            // If parent ID is empty string or "null", use undefined
            const parentId = newChannelParentId ?? undefined;
            const newChannel = await createChannel(currentServer.id, newChannelName.trim(), newChannelType, parentId, false, newChannelHasChecklist);

            // Update cache
            queryClient.setQueryData(keys.channels(currentServer.id), (old: Channel[] | undefined) => {
                return [...(old || []), newChannel];
            });

            setShowCreateModal(false);
            setNewChannelName('');
            setNewChannelType(0);
            setNewChannelHasChecklist(false);
            setNewChannelParentId(null);

            // The server broadcasts ChannelCreated to this server's members
            // authoritatively (see create_channel); no client-side WS emit — that
            // path let any client inject a fake channel to everyone.

            // Auto-select the new channel if it's a text channel
            if (newChannelType === 0) {
                setCurrentChannel(newChannel);
                setShowFriendsPanel(false);
                setShowDevicesView(false);
                if (isMobile) setMobilePanel('chat');
            }
        } catch (error) {
            console.error('Failed to create channel:', error);
            // The modal deliberately stays open so the typed name isn't lost.
            alert('Could not create the channel. You may not have permission, or the name may be taken.');
        }
    };


    // --- Mouse-based Channel Drag and Drop (WebView2 compatible) ---
    // WebView2 doesn't fire dragover/drop events, so we use mouse events instead

    const [dragOverChannelId, setDragOverChannelId] = useState<number | null>(null);

    const handleChannelMouseDown = (e: React.MouseEvent, channel: Channel) => {
        // Only allow if user has permission (owner for now)
        if (currentServer?.owner_id !== currentUserId) return;

        // Only start drag on left click
        if (e.button !== 0) return;

        // Prevent text selection during drag
        e.preventDefault();

        console.log('[MOUSE DRAG] Starting drag for channel:', channel.id, channel.name);
        setDraggingChannelId(channel.id);
    };

    const handleChannelMouseEnter = (channel: Channel) => {
        // Only track hover target if we're actively dragging
        if (draggingChannelId && draggingChannelId !== channel.id) {
            console.log('[MOUSE DRAG] Hovering over:', channel.id, channel.name);
            setDragOverChannelId(channel.id);
        }
    };

    const handleChannelMouseLeave = () => {
        setDragOverChannelId(null);
    };

    // Global mouseup handler to complete drag
    useEffect(() => {
        if (!draggingChannelId) return;

        const handleMouseUp = async () => {
            console.log('[MOUSE DRAG] Mouse up - dragging:', draggingChannelId, 'over:', dragOverChannelId);

            if (draggingChannelId && dragOverChannelId && currentServer) {
                const draggedChannel = channels.find(c => c.id === draggingChannelId);
                const targetChannel = channels.find(c => c.id === dragOverChannelId);

                if (draggedChannel && targetChannel && draggedChannel.parent_id === targetChannel.parent_id) {
                    // Reorder siblings of the same kind: voice channels only move
                    // among voice channels (AFK stays pinned and never moves),
                    // text/collections among text/collections.
                    const isVoiceDrag = draggedChannel.channel_type === 1;
                    const siblings = channels.filter(c =>
                        c.parent_id === draggedChannel.parent_id &&
                        (isVoiceDrag
                            ? c.channel_type === 1 && !c.is_afk
                            : (c.channel_type === 0 || c.channel_type === 2)));
                    const oldIndex = siblings.findIndex(c => c.id === draggedChannel.id);
                    const newIndex = siblings.findIndex(c => c.id === targetChannel.id);

                    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
                        // Reorder array
                        const reordered = [...siblings];
                        reordered.splice(oldIndex, 1);
                        reordered.splice(newIndex, 0, draggedChannel);
                        const newOrder = reordered.map(c => c.id);

                        console.log('[MOUSE DRAG] Reordering to:', newOrder);

                        // Call API
                        try {
                            await reorderChannels(currentServer.id, newOrder);
                            queryClient.invalidateQueries({ queryKey: keys.channels(currentServer.id) });
                        } catch (err) {
                            console.error('Failed to reorder channels:', err);
                            // Refetch so the sidebar shows the server's real
                            // order rather than the optimistic one that failed.
                            queryClient.invalidateQueries({ queryKey: keys.channels(currentServer.id) });
                            alert('Could not save the new channel order. You may not have permission.');
                        }
                    }
                }
            }

            setDraggingChannelId(null);
            setDragOverChannelId(null);
        };

        document.addEventListener('mouseup', handleMouseUp);
        return () => document.removeEventListener('mouseup', handleMouseUp);
    }, [draggingChannelId, dragOverChannelId, channels, currentServer, queryClient]);

    // --- Moderator drag: move a MEMBER between voice channels ---------------
    //
    // Separate from the channel-reorder drag above in every respect: it moves a
    // person rather than a channel, and it is pointer-based rather than
    // mouse-based, because `onMouseEnter` — how the reorder drag finds its drop
    // target — is never synthesised while a finger slides, so that pattern is
    // silently dead on touch.

    /** Does the viewer hold MOVE_MEMBERS on this server? */
    const canMoveVoiceMembers = useMemo(() => {
        if (!currentServer) return false;
        if (currentServer.owner_id === currentUserId) return true;
        // Deliberately NOT hasPerm's fail-open behaviour on a missing bitset.
        // Failing open is right for hiding content on an older server; for a
        // moderation gesture it would offer every member a drag the API then
        // refuses. The API check is server-scoped (matching kick/ban), so a
        // per-channel MOVE_MEMBERS overwrite is the one case where this and the
        // server can disagree — the 403 surfaces as the alert in commitVoiceMove.
        // `some`, not "the first voice channel with known bits": these are
        // CHANNEL-effective bits, so a deny overwrite on whichever channel
        // happened to come first would hide the affordance from a moderator who
        // genuinely holds MOVE_MEMBERS server-wide — the API check is
        // server-scoped and would have allowed it.
        return channels.some(c =>
            c.channel_type === 1
            && c.my_permissions !== undefined
            && hasPerm(c.my_permissions, PERM.MOVE_MEMBERS));
    }, [currentServer, currentUserId, channels]);

    const commitVoiceMove = useCallback(async (
        subject: { userId: number; username: string; fromChannelId: number },
        toChannelId: number,
    ) => {
        if (!currentServer) return;
        const from = channels.find(c => c.id === subject.fromChannelId);
        const to = channels.find(c => c.id === toChannelId);
        if (!from || !to) return;
        const verdict = canMoveVoiceMember(from, to);
        if (!verdict.ok) { showToast(verdict.message); return; }
        try {
            await moveMemberVoice(currentServer.id, subject.userId, toChannelId);
        } catch (err) {
            console.error('Failed to move member between voice channels:', err);
            showToast(`Could not move ${subject.username} to ${to.name}. You may not have permission, or they may not be able to join that channel.`);
        }
    }, [currentServer, channels, showToast]);

    const {
        setContainer: setVoiceDragContainer,
        state: voiceDragState,
        onPointerDown: onVoiceDragPointerDown,
    } = useVoiceMemberDrag({
        enabled: canMoveVoiceMembers,
        canDropOn: (subject, toChannelId) => {
            const from = channels.find(c => c.id === subject.fromChannelId);
            const to = channels.find(c => c.id === toChannelId);
            return !!from && !!to && canMoveVoiceMember(from, to).ok;
        },
        onDrop: (subject, toChannelId) => { void commitVoiceMove(subject, toChannelId); },
    });

    /** Disconnect a member from voice (context menu). No timeout, no membership
     *  change — they can rejoin immediately. */
    const disconnectVoiceMember = useCallback(async (userId: number, username: string) => {
        if (!currentServer) return;
        try {
            await moveMemberVoice(currentServer.id, userId, null);
        } catch (err) {
            console.error('Failed to disconnect member from voice:', err);
            showToast(`Could not disconnect ${username} from voice. You may not have permission.`);
        }
    }, [currentServer, showToast]);

    // The voice channel the context-menu target is currently sitting in. Both
    // voice-moderation actions target THAT channel, never the one being viewed.
    // A plain const rather than a memo on purpose: the correct dependency is the
    // voice roster, which lives in a module-global Map that no dependency array
    // can observe — memoising it would serve a stale channel after someone moves.
    const userContextMenuVoiceChannel = userContextMenuTarget?.isInVoice
        ? channels.find(c =>
            c.channel_type === 1
            && getVoiceUsersInRoom(`voice_${c.id}`).some(u => u.id === userContextMenuTarget.userId))
            ?? null
        : null;

    // Switch to a different server
    const switchServer = (server: Server) => {
        if (server.id === currentServer?.id) return;

        // Keep the voice connection + any live stream running across servers —
        // the VoicePanel is keyed on currentVoiceChannel, independent of the
        // viewed server (persistent voice, independent of navigation). If a stream is up,
        // minimize it to a movable PiP so the new server's chat is visible,
        // instead of a full stage that (with voice previously torn down) went
        // black. NOTE: leaving a voice channel is done explicitly via the voice
        // controls / kick-ban / leave-server paths, not by browsing servers.
        if (getSelectedStreams().length > 0) {
            setShowPip(true);
        }
        setViewMode('chat');

        setCurrentServer(server);
        setMessages([]);
        setCurrentChannel(null); // Will be auto-selected by useEffect when channels load
        setCurrentDM(null); // Leaving the DM/home view for a server
        setDmMessages([]);
    };

    // --- Android navigation intents (widget buttons, notification taps) ---
    // The target rides an activity intent; mobileApp.ts holds it (Chat mounts
    // seconds after launch, behind the OTA gate and the connect screen) and
    // announces late arrivals as 'sovereign-navigate'. A target whose DATA has
    // not loaded yet — a DM before the conversation list, a server before the
    // servers query — is put back with deferNav and retried when the deps
    // change. Applying a target sets the same guard states the auto-select
    // effect checks, so the user cannot be yanked to servers[0] afterwards.
    //
    // The applier lives in a ref refreshed every render, exactly like
    // openChannelRef above and for the same reason: the event listener
    // otherwise captures switchServer/currentServer from whichever render
    // last re-ran the effect, and a 'server:' tap made after the user had
    // manually switched servers early-returned against the STALE
    // currentServer — a notification tap that silently did nothing.
    const applyPendingNavRef = useRef<() => void>(() => { });
    // One refetch per missing DM target: a first message from a new contact
    // creates a conversation the cached list has never seen, so one miss
    // means "refresh the list", while a second means it is genuinely gone.
    const dmNavRefetchedRef = useRef<string | null>(null);
    const clipNavRetriedRef = useRef<string | null>(null);
    useEffect(() => {
        applyPendingNavRef.current = () => {
            const target = consumePendingNav();
            if (!target) return;
            if (target === 'friends') {
                setFriendsTab('online');
                setShowFriendsPanel(true);
                setShowDevicesView(false);
                setShowChecklist(false);
                setShowAllChecklists(false);
                if (isMobile) setMobilePanel('chat');
            } else if (target === 'tasks' || target === 'notes') {
                // 'notes' is the launcher shortcut's name for the same view.
                openTasksView();
            } else if (target === 'dms') {
                // The launcher's "Messages" shortcut: the home view, where the
                // sidebar is the DM list (HomeSidebar renders only with no
                // current server).
                setCurrentServer(null);
                setCurrentChannel(null);
                setFriendsTab('online');
                setShowFriendsPanel(true);   // home content on desktop
                setShowDevicesView(false);
                setShowChecklist(false);
                setShowAllChecklists(false);
                // 'chat', same as the 'friends' branch: on mobile the home
                // dashboard renders in the chat slot and carries the DM list.
                // 'channels' here showed an EMPTY column — with the friends
                // panel up, HomeSidebar is not mounted and the dashboard is
                // translated off-screen in that slot.
                if (isMobile) setMobilePanel('chat');
            } else if (target === 'devices') {
                setShowFriendsPanel(false);
                setShowChecklist(false);
                setShowAllChecklists(false);
                setShowDevicesView(true);
                // 'servers', not 'chat': the Devices view keeps the rail
                // visible on mobile (same choice as the rail's own button).
                if (isMobile) setMobilePanel('servers');
            } else if (target === 'settings') {
                setShowSettings(true);
            } else if (target.startsWith('dm:')) {
                const conv = dmConversations.find(c => c.id === target.slice(3));
                if (conv) {
                    dmNavRefetchedRef.current = null;
                    openDMConversation(conv);
                } else if (dmNavRefetchedRef.current !== target) {
                    dmNavRefetchedRef.current = target;
                    deferNav(target);
                    listDMConversations()
                        .then(setDmConversations) // state change re-runs apply
                        .catch(() => { /* the deferred target waits for the next attempt */ });
                }
                // else: refetched and still absent — genuinely gone; stay put.
            } else if (target.startsWith('server:')) {
                const server = servers.find(sv => sv.id === target.slice(7));
                if (server) {
                    setShowFriendsPanel(false);
                    setShowDevicesView(false);
                    switchServer(server);
                    if (isMobile) setMobilePanel('channels');
                } else if (isServersLoading || servers.length === 0) {
                    deferNav(target);
                }
                // else: left or deleted since the notification; stay put.
            } else if (target.startsWith('clip:')) {
                // A clip-approval doorbell tap (docs/CLIPS.md). The prompt is
                // global (App.tsx), so "navigating" means bringing that request
                // to the front; the store may still be hydrating it after a
                // cold start, so try again once the socket has reconciled.
                if (!focusClipProposal(target.slice(5))) {
                    if (clipNavRetriedRef.current !== target) {
                        clipNavRetriedRef.current = target;
                        deferNav(target);
                        // The proposal store is a module bus, not React state, so
                        // re-run apply ourselves once the server has been asked.
                        void refreshPendingClips().then(() => applyPendingNavRef.current());
                    } else {
                        clipNavRetriedRef.current = null;
                        showToast('That clip request is no longer waiting for you.');
                    }
                }
                if (isMobile) setMobilePanel('chat');
            }
        };
    });
    useEffect(() => {
        const apply = () => applyPendingNavRef.current();
        apply();
        window.addEventListener('sovereign-navigate', apply);
        return () => window.removeEventListener('sovereign-navigate', apply);
        // The deps are the DATA a deferred target waits for; the applier
        // itself is always render-fresh through the ref.
    }, [servers, dmConversations, isServersLoading]);

    // Publish the most recent DMs as launcher long-press shortcuts (Android
    // only — a no-op elsewhere). Re-synced when the conversation list changes
    // and when the setting flips; OFF pushes an empty list, which CLEARS what
    // the launcher already shows, so the OFF path must not short-circuit.
    useEffect(() => {
        const sync = () => {
            if (!mobileAppAvailable()) return;
            const on = loadSettings().launcherConversationShortcuts;
            // With the setting ON, an empty push is only ever a CLEAR — and
            // before the list has loaded, [] means "unknown", not "none".
            // Pushing it wiped the launcher's persisted shortcuts on every
            // cold start, permanently when the fetch failed.
            if (on && !dmsLoaded) return;
            const items = on
                ? [...dmConversations]
                    .sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''))
                    .slice(0, 4)
                    .map(c => {
                        const label = c.other_display_name || c.other_username;
                        return { id: `dm:${c.id}`, label, nav: `dm:${c.id}`, icon: initialsIconPng(label) };
                    })
                : [];
            void syncConversationShortcuts(items);
        };
        sync();
        window.addEventListener('settingsChanged', sync);
        return () => window.removeEventListener('settingsChanged', sync);
    }, [dmConversations, dmsLoaded]);

    // Handle server creation from wizard
    const handleWizardComplete = async (serverName: string, _template: string, _audience: string) => {
        try {
            const newServer = await createServer(serverName) as Server;
            queryClient.setQueryData(keys.servers, (old: Server[] | undefined) => [...(old || []), newServer]);
            setShowServerModal(false);

            // Switch to the new server. Close the Friends dashboard too — the
            // wizard is reachable from the Friends home (always, for a fresh
            // account's first server), and the overlay would otherwise keep
            // covering the server you just created. The join path already
            // does this (onServerJoined).
            setShowFriendsPanel(false);
            setShowDevicesView(false);
            await switchServer(newServer);
            if (isMobile) setMobilePanel('channels');
        } catch (error) {
            console.error('Failed to create server:', error);
            alert('Could not create the server. Check your connection and try again.');
        }
    };

    // Open server creation wizard
    const openServerWizard = () => {
        setShowServerModal(true);
    };

    const formatTime = (ts: number) =>
        new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Familiar "Today at HH:MM" / "Yesterday at HH:MM" / date + time format.
    const formatFullTimestamp = (ts: number) => {
        const d = new Date(ts * 1000);
        const now = new Date();
        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
        if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
        if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
        return `${d.toLocaleDateString()} ${time}`;
    };

    // Label for the divider between days of messages.
    const formatDateDivider = (ts: number) => {
        const d = new Date(ts * 1000);
        const now = new Date();
        const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
        if (d.toDateString() === now.toDateString()) return 'Today';
        if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    };

    // Two messages group when same author, close in time, no reply/task/channel break.
    /**
     * The search box, defined once and rendered in BOTH the channel and DM
     * headers. It used to live only inside the channel branch, so there was no
     * search in DMs at all and the Ctrl+K hotkey — which does
     * querySelector('.search-bar input') — was a silent no-op there.
     */
    const searchBar = (
        <div className="search-bar">
            <input
                type="text"
                placeholder="Search this conversation..."
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
            />
            {isSearching && <span className="search-spinner"><PendingIcon /></span>}
            {searchOutcome && (() => {
                // ONE filtered list drives the count, the empty state and the
                // rows — a header claiming "1 result" above zero rows (the hit
                // was hidden) reads as a broken search.
                const visibleHits = searchOutcome.hits.filter(h => !isMessageHidden(h.id));
                return (
                <div className="search-results">
                    <div className="search-results-header">
                        {visibleHits.length} result{visibleHits.length !== 1 ? 's' : ''}
                        <button onClick={clearSearch} aria-label="Clear search"><CloseIcon /></button>
                    </div>
                    {visibleHits.length === 0 && (
                        <div className="search-no-results">No messages found</div>
                    )}
                    {visibleHits.slice(0, 20).map(hit => (
                        <div
                            key={hit.id}
                            className="search-result-item"
                            onClick={() => jumpToHit(hit.id)}
                            title="Jump to this message"
                        >
                            <strong>{hit.senderName}:</strong>
                            <span>{hit.content.length > 60 ? hit.content.slice(0, 60) + '…' : hit.content}</span>
                        </div>
                    ))}
                    {jumpNotice && <div className="search-jump-notice">{jumpNotice}</div>}
                    {/* State the REAL numbers. "No results" means something
                        different over 40 messages than over 4000, and content
                        that could not be decrypted was never searched at all. */}
                    <div className="search-footer">
                        Searched {searchOutcome.searched} message{searchOutcome.searched !== 1 ? 's' : ''}
                        {searchOutcome.undecryptable > 0 && ` · ${searchOutcome.undecryptable} could not be decrypted`}
                        {searchOutcome.truncated && ' · older history not searched'}
                    </div>
                </div>
                );
            })()}
        </div>
    );

    const GROUP_WINDOW_SECONDS = 7 * 60;

    if (isLoading) {
        return <div className="chat-loading">Loading...</div>;
    }

    if (initError) {
        return (
            <div className="chat-error">
                <h3>Failed to initialize</h3>
                <p>{initError}</p>
                <button onClick={() => window.location.reload()}>Retry</button>
            </div>
        );
    }

    // NOTE: Don't return early if no channels/DM - we still need to show ServerList so users can create/join servers
    // The "no channels" message will be shown in the main content area instead

    // Split members into online and offline
    const onlineMembers = allMembers.filter(m => m.is_online);
    const offlineMembers = allMembers.filter(m => !m.is_online);

    return (
        <div className="chat-container" data-mobile-panel={isMobile ? mobilePanel : undefined} {...panelSwipe}>
            {/* App-wide transfer tray. Deliberately at the root and outside
                every view condition: an incoming offer must be answerable no
                matter which channel, DM or panel is on screen. Desktop docks it
                bottom-right; mobile makes it a full-width sheet above the nav
                (see FileTransfers.css) — 390px has no room for a floating card.
                And NOT behind p2pOn — that gate was the same class of bug this
                comment warns about, moved from the view to a per-device flag:
                a phone that never opted in received offers it could not answer.
                The tray renders null while there are no transfers. */}
            <FileTransfers />

            {/* Create Channel Modal */}
            {showCreateModal && (
                <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <h3>Create Channel</h3>
                        <form onSubmit={handleCreateChannel}>
                            <div className="form-group">
                                <label>Channel Type</label>
                                <div className="channel-type-selector">
                                    <button
                                        type="button"
                                        className={`type-btn ${newChannelType === 0 && !newChannelHasChecklist ? 'active' : ''}`}
                                        onClick={() => { setNewChannelType(0); setNewChannelHasChecklist(false); }}
                                    >
                                        <span className="icon">#</span>
                                        Text
                                    </button>
                                    <button
                                        type="button"
                                        className={`type-btn ${newChannelType === 0 && newChannelHasChecklist ? 'active' : ''}`}
                                        onClick={() => { setNewChannelType(0); setNewChannelHasChecklist(true); }}
                                    >
                                        <span className="icon"><ChecklistIcon /></span>
                                        Checklist
                                    </button>
                                    <button
                                        type="button"
                                        className={`type-btn ${newChannelType === 2 ? 'active' : ''}`}
                                        onClick={() => { setNewChannelType(2); setNewChannelHasChecklist(false); }}
                                    >
                                        <span className="icon"><FolderIcon /></span>
                                        Collection
                                    </button>
                                    <button
                                        type="button"
                                        className={`type-btn ${newChannelType === 1 ? 'active' : ''}`}
                                        onClick={() => { setNewChannelType(1); setNewChannelHasChecklist(false); }}
                                    >
                                        <span className="icon"><SpeakerIcon /></span>
                                        Voice
                                    </button>
                                </div>
                            </div>

                            {/* Parent Channel Selection - Only for Text/Voice channels */}
                            {(newChannelType === 0 || newChannelType === 1) && (
                                <div className="form-group">
                                    <label>Nest Under (Optional)</label>
                                    <select
                                        className="parent-channel-select"
                                        value={newChannelParentId ?? ''}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            setNewChannelParentId(val ? parseInt(val) : null);
                                        }}
                                    >
                                        <option value="">(No Parent - Top Level)</option>
                                        {channels
                                            .filter(c => c.channel_type === 2) // Only show collections
                                            .map(c => (
                                                <option key={c.id} value={c.id}>
                                                    {c.name}
                                                </option>
                                            ))}
                                    </select>
                                </div>
                            )}

                            <div className="form-group">
                                <label>Channel Name</label>
                                <input
                                    type="text"
                                    value={newChannelName}
                                    onChange={e => setNewChannelName(e.target.value)}
                                    placeholder={newChannelType === 0 ? 'new-text-channel' : 'General Voice'}
                                    autoFocus
                                />
                            </div>
                            <div className="modal-buttons">
                                <button type="button" className="cancel-btn" onClick={() => setShowCreateModal(false)}>
                                    Cancel
                                </button>
                                <button type="submit" className="create-btn" disabled={!newChannelName.trim()}>
                                    Create Channel
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Server Creation Wizard */}
            <ServerCreateWizard
                isOpen={showServerModal}
                onClose={() => setShowServerModal(false)}
                onComplete={handleWizardComplete}
                onJoinInstead={() => { setShowServerModal(false); setShowJoinModal(true); }}
            />

            {/* Join Server Modal */}
            <JoinServerModal
                isOpen={showJoinModal}
                onClose={() => setShowJoinModal(false)}
                onServerJoined={(server) => {
                    queryClient.setQueryData(keys.servers, (old: Server[] | undefined) => [...(old || []), server]);
                    setShowFriendsPanel(false);
                    setShowDevicesView(false);
                    switchServer(server);
                }}
            />

            {/* Invite Modal */}
            {currentServer && (
                <InviteModal
                    isOpen={showInviteModal}
                    onClose={() => setShowInviteModal(false)}
                    serverId={currentServer.id}
                    serverName={currentServer.name}
                />
            )}

            {/* Server Settings Modal */}
            {currentServer && (
                <ServerSettingsModal
                    // Keyed on the server: a server switch while the modal is open
                    // (an Android notification tap can do that) must remount it with
                    // the NEW server's values — the reset effect inside only runs on
                    // the open transition, so without this key a stale form for A
                    // could be saved onto B.
                    key={currentServer.id}
                    isOpen={showSettingsModal}
                    onClose={() => setShowSettingsModal(false)}
                    onSave={async () => {
                        // `currentServer` is a useState SNAPSHOT taken at switch time and
                        // the rail reads the react-query cache, so a save must refresh the
                        // query (the old code fetched the fresh list and then dispatched a
                        // 'refreshServers' event nothing listened to — every setting looked
                        // reverted on reopen). fetchQuery goes THROUGH the query, so the
                        // cache gets the structurally-shared row and the sync effect above
                        // re-seats currentServer from it; a blind setQueryData of a
                        // pre-fetched list could resurrect a server a concurrent
                        // RemovedFromServer had just dropped. Throws if the GET fails, so
                        // the modal can say "saved, but couldn't refresh" instead of lying.
                        await queryClient.fetchQuery({ queryKey: keys.servers, queryFn: listServers, staleTime: 0 });
                    }}
                    serverId={currentServer.id}
                    serverName={currentServer.name}
                    isOwner={currentServer.owner_id === currentUser?.sub}
                    initialIsPublic={currentServer.is_public ?? false}
                    initialRequireMediaE2ee={currentServer.require_media_e2ee ?? false}
                    initialDescription={currentServer.description ?? ''}
                    initialIconFileId={currentServer.icon_file_id}
                    // Clips policy (docs/CLIPS.md). `clipsSupported` false = a
                    // pre-Clips server: the block renders disabled with a note.
                    clipsSupported={typeof currentServer.clip_max_seconds === 'number'}
                    initialClipsEnabled={currentServer.clips_enabled === true}
                    initialClipMaxSeconds={currentServer.clip_max_seconds ?? 120}
                    initialClipChannelId={currentServer.clip_channel_id ?? null}
                />
            )}

            {/* Edit Server Profile — per-server nickname */}
            {nickEditServer && (
                <div className="settings-modal-overlay" onClick={() => setNickEditServer(null)}>
                    <div className="nick-edit-modal" onClick={e => e.stopPropagation()}>
                        <h3>Your profile on {nickEditServer.name}</h3>
                        <p className="settings-hint">
                            A nickname shows instead of your display name, on this server only.
                            Leave it empty to clear.
                        </p>
                        <input
                            type="text"
                            value={nickEditValue}
                            maxLength={32}
                            placeholder={nickLoading ? 'Loading…' : 'Nickname'}
                            autoFocus
                            disabled={nickLoading}
                            onChange={e => setNickEditValue(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Escape') setNickEditServer(null); }}
                        />
                        <div className="nick-edit-actions">
                            <button className="secondary-btn" onClick={() => setNickEditServer(null)}>
                                Cancel
                            </button>
                            <button
                                className="save-btn"
                                disabled={nickSaving || nickLoading}
                                onClick={async () => {
                                    if (!nickEditServer) return;
                                    setNickSaving(true);
                                    try {
                                        await setServerNickname(nickEditServer.id, nickEditValue.trim() || null);
                                        queryClient.invalidateQueries({ queryKey: keys.members(nickEditServer.id) });
                                        setNickEditServer(null);
                                    } catch (err) {
                                        console.error('Failed to set nickname:', err);
                                        alert('Could not set your nickname. You may not have permission on this server.');
                                    } finally {
                                        setNickSaving(false);
                                    }
                                }}
                            >
                                {nickSaving ? 'Saving…' : 'Save'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Friends Dashboard */}
            {showFriendsPanel && (
                <FriendsPanel
                    onStartDM={openDMConversation}
                    onClose={() => setShowFriendsPanel(false)}
                    initialTab={friendsTab}
                    onTabChange={setFriendsTab}
                    onOpenSettings={() => setShowSettings(true)}
                />
            )}

            {/* User Profile Settings */}
            <UserProfileSettings
                isOpen={showUserSettings}
                onClose={() => setShowUserSettings(false)}
            />

            {/* Full Settings Modal */}
            <SettingsModal
                isOpen={showSettings}
                onClose={() => setShowSettings(false)}
                onLogout={onLogout}
            />

            {/* Devices — first-class view. Rendered after FriendsPanel so it
                paints above the dashboard at the shared z-band while open. */}
            {showDevicesView && (
                <DevicesView
                    onClose={() => leaveDevicesView('servers')}
                    onOpenSettings={() => setShowSettings(true)}
                />
            )}

            {/* User Context Menu */}
            {userContextMenuTarget && (
                <UserContextMenu
                    userId={userContextMenuTarget.userId}
                    username={userContextMenuTarget.username}
                    isInVoice={userContextMenuTarget.isInVoice}
                    position={userContextMenuTarget.position}
                    currentUserId={currentUserId}
                    canModerate={currentServer?.owner_id === currentUser?.sub}
                    customSoundsDisabled={allMembers.find(m => m.id === userContextMenuTarget.userId)?.custom_sounds_disabled ?? false}
                    // Voice moderation. Offered only when the menu was opened
                    // from the voice list AND we can locate the channel they are
                    // actually in — the target of both actions is that channel,
                    // not the one being viewed.
                    canMoveMembers={canMoveVoiceMembers && userContextMenuTarget.isInVoice && !!userContextMenuVoiceChannel}
                    voiceMoveTargets={
                        userContextMenuVoiceChannel
                            ? voiceMoveTargets(
                                channels.filter(c => c.channel_type === 1),
                                userContextMenuVoiceChannel,
                            ).map(c => ({ id: c.id, name: c.name, isAfk: c.is_afk }))
                            : []
                    }
                    onVoiceMove={(channelId) => {
                        if (!userContextMenuVoiceChannel) return;
                        void commitVoiceMove({
                            userId: userContextMenuTarget.userId,
                            username: userContextMenuTarget.username,
                            fromChannelId: userContextMenuVoiceChannel.id,
                        }, channelId);
                    }}
                    onVoiceDisconnect={() => {
                        const { userId, username } = userContextMenuTarget;
                        void disconnectVoiceMember(userId, username);
                    }}
                    onToggleCustomSounds={async (disable) => {
                        if (!currentServer) return;
                        try {
                            await setMemberCustomSoundsDisabled(currentServer.id, userContextMenuTarget.userId, disable);
                            queryClient.invalidateQueries({ queryKey: keys.members(currentServer.id) });
                        } catch (err) {
                            console.error('Failed to toggle custom sounds:', err);
                            alert('Failed to update custom sounds. You may not have permission.');
                        }
                    }}
                    onClose={() => setUserContextMenuTarget(null)}
                    onOpenProfile={() => {
                        const member = allMembers.find(m => m.id === userContextMenuTarget.userId);
                        if (member) {
                            setPopupPosition(userContextMenuTarget.position);
                            setSelectedMember(member);
                        }
                    }}
                    onStartDM={openDMConversation}
                    onKick={async () => {
                        if (!currentServer) return;
                        const { userId, username } = userContextMenuTarget;
                        if (!confirm(`Kick ${username} from ${currentServer.name}? They can rejoin with a new invite.`)) return;
                        try {
                            await kickMember(currentServer.id, userId);
                            queryClient.invalidateQueries({ queryKey: keys.members(currentServer.id) });
                        } catch (err) {
                            console.error('Failed to kick member:', err);
                            alert('Failed to kick member. You may not have permission.');
                        }
                    }}
                    onBan={async () => {
                        if (!currentServer) return;
                        const { userId, username } = userContextMenuTarget;
                        if (!confirm(`Ban ${username} from ${currentServer.name}? They cannot rejoin unless unbanned.`)) return;
                        try {
                            await banMember(currentServer.id, userId);
                            queryClient.invalidateQueries({ queryKey: keys.members(currentServer.id) });
                        } catch (err) {
                            console.error('Failed to ban member:', err);
                            alert('Failed to ban member. You may not have permission.');
                        }
                    }}
                />
            )}

            {/* User Profile Popup */}
            {selectedMember && currentServer && (
                <UserProfilePopup
                    member={selectedMember}
                    serverId={currentServer.id}
                    isOwner={currentServer.owner_id === currentUser?.sub}
                    currentUserId={currentUserId}
                    position={popupPosition}
                    onClose={() => setSelectedMember(null)}
                    onRolesUpdated={() => queryClient.invalidateQueries({ queryKey: keys.members(currentServer.id) })}
                    onStartDM={openDMConversation}
                />
            )}

            {/* Server List - Far Left */}
            <ServerList
                currentServerId={currentServer?.id || null}
                onSelectServer={(server) => {
                    setShowFriendsPanel(false);
                    setShowDevicesView(false);
                    switchServer(server);
                    if (isMobile) setMobilePanel('channels');
                }}
                onCreateServer={openServerWizard}
                onJoinServer={() => setShowJoinModal(true)}
                onOpenDevices={() => {
                    // Toggle, like the Friends/Tasks rail buttons: pressing the
                    // active button again returns to wherever you were.
                    if (showDevicesView) {
                        leaveDevicesView('servers');
                        return;
                    }
                    setShowDevicesView(true);
                    setShowFriendsPanel(false);
                    setShowChecklist(false); // drawer would cover the view
                    // THE SERVERS SLOT, not the chat slot — so the rail stays on
                    // screen beside the view (DevicesView.css anchors it at
                    // left: 72px there). Devices is the only destination whose
                    // ONLY entry point is the rail: Tasks has a bottom-nav
                    // button, Friends has the home icon. Sending it to the chat
                    // slot slid the rail away and left no visible way back
                    // except a non-obvious "Servers" tap — reported as "clicking
                    // devices doesn't show the rail".
                    if (isMobile) setMobilePanel('servers');
                }}
                devicesActive={showDevicesView}
                onMarkedRead={(serverId) => {
                    // Only the current server has live per-channel badge state;
                    // clear it optimistically (server-side is already updated).
                    if (serverId === currentServer?.id) setUnreadCounts(new Map());
                    clearServerUnread(serverId);
                }}
                onEditServerProfile={(server) => {
                    setNickEditServer(server);
                    if (server.id === currentServer?.id) {
                        nickFetchServerRef.current = null;
                        setNickLoading(false);
                        setNickEditValue(allMembers.find(m => m.id === currentUserId)?.server_nickname ?? '');
                        return;
                    }
                    // Any OTHER server: its member list isn't loaded, so fetch it
                    // before showing the field. Starting blank was silent data
                    // loss — the empty box read as "no nickname set", and Save
                    // sends `trim() || null`, so dismissing the dialog with the
                    // button deleted a nickname the user never saw.
                    setNickEditValue('');
                    setNickLoading(true);
                    nickFetchServerRef.current = server.id;
                    queryClient
                        .fetchQuery({
                            queryKey: keys.members(server.id),
                            queryFn: () => listMembersWithRoles(server.id),
                        })
                        .then((members: MemberWithRoles[]) => {
                            if (nickFetchServerRef.current !== server.id) return; // dialog moved on
                            setNickEditValue(members.find(m => m.id === currentUserId)?.server_nickname ?? '');
                        })
                        .catch(err => {
                            console.error('Failed to load nickname for server:', err);
                            // Re-enabling Save over a field that never populated
                            // recreates the exact data loss this fetch prevents:
                            // Save sends `trim() || null`, deleting a nickname
                            // the user never saw. Close the dialog instead.
                            if (nickFetchServerRef.current === server.id) {
                                nickFetchServerRef.current = null;
                                setNickEditServer(null);
                                alert('Could not load your current nickname for that server. Try again.');
                            }
                        })
                        .finally(() => {
                            if (nickFetchServerRef.current === server.id) setNickLoading(false);
                        });
                }}
                // These two existed as menu items but the callbacks were never
                // passed — "Server Settings" and "Invite People" in the rail's
                // context menu silently did nothing. Both modals read
                // currentServer, so switch first when invoked from another
                // server's icon.
                onServerSettings={(server) => {
                    if (server.id !== currentServer?.id) switchServer(server);
                    setShowSettingsModal(true);
                }}
                onInviteToServer={(server) => {
                    if (server.id !== currentServer?.id) switchServer(server);
                    setShowInviteModal(true);
                }}
                onOpenNotes={openTasksView}
                notesActive={showFriendsPanel && friendsTab === 'tasks'}
                showingFriends={showFriendsPanel && friendsTab !== 'tasks'}
                onShowFriends={() => {
                    setFriendsTab('online');
                    setShowFriendsPanel(true);
                    setShowDevicesView(false);
                    setShowChecklist(false); // drawer would cover the dashboard
                    if (isMobile) setMobilePanel('chat');
                }}
                currentUserId={currentUserId}
                onLeaveServer={async (server) => {
                    try {
                        await leaveServer(server.id);
                        // Remove from local list
                        queryClient.setQueryData(keys.servers, (old: Server[] | undefined) => (old || []).filter(s => s.id !== server.id));

                        if (currentServer?.id === server.id) {
                            const remaining = servers.filter(s => s.id !== server.id);
                            if (remaining.length > 0) {
                                switchServer(remaining[0]);
                            } else {
                                setCurrentServer(null);
                                // Channels/Messages cleaned up by hooks/state
                                setCurrentChannel(null);
                            }
                        }
                    } catch (error) {
                        console.error('Failed to leave server:', error);
                        alert('Failed to leave server');
                    }
                }}
                onDisbandServer={async (server) => {
                    try {
                        await deleteServer(server.id);
                        // Remove from local list
                        queryClient.setQueryData(keys.servers, (old: Server[] | undefined) => (old || []).filter(s => s.id !== server.id));

                        if (currentServer?.id === server.id) {
                            const remaining = servers.filter(s => s.id !== server.id);
                            if (remaining.length > 0) {
                                switchServer(remaining[0]);
                            } else {
                                setCurrentServer(null);
                                // Channels cleaned up by hooks
                                setCurrentChannel(null);
                            }
                        }
                    } catch (error) {
                        console.error('Failed to delete server:', error);
                        alert('Failed to delete server');
                    }
                }}
            />

            {/* Left Sidebar - Channels and Voice */}
            <aside className="sidebar">
                {/* Server Header with Settings — only when a server is selected
                    (after a kick/ban or with no servers there is nothing to head). */}
                {currentServer && (
                    <div className="server-header">
                        <h2 className="server-name">{currentServer.name}</h2>
                        <button
                            className="server-settings-btn"
                            onClick={() => setShowSettingsModal(true)}
                            title="Server Settings"
                        >
                            <SettingsIcon />
                        </button>
                    </div>
                )}

                {/* Scrollable middle: channel/DM sections. Scrolls on its own so
                    the voice panel + profile bar below stay pinned and visible
                    at any window height. */}
                <div className="sidebar-scroll">

                {/* Server channel sections — only in a server. In the home/DM
                    view (currentServer null) the sidebar collapses to just the
                    DM list below, so we don't show empty channel headers. */}
                {currentServer && (<>
                {/* Text Channels Section */}
                <div className="sidebar-section">
                    <div className="sidebar-header">
                        <h3>Text Channels</h3>
                        <button
                            className="add-channel-btn"
                            onClick={() => { setNewChannelType(0); setShowCreateModal(true); }}
                            title="Create Text Channel"
                        >
                            +
                        </button>
                    </div>
                    <ul
                        className="channel-list"
                        onDragOver={(e) => {
                            console.log('[DRAG] UL DragOver fired!');
                            e.preventDefault();
                        }}
                        onDrop={(e) => {
                            console.log('[DRAG] UL Drop fired!');
                            e.preventDefault();
                        }}
                    >

                        {/* Server-wide "All checklists" board — only when the server
                            has at least one checklist channel. */}
                        {channels.some(c => c.has_checklist) && (
                            <li
                                className={`channel ${showAllChecklists ? 'active' : ''}`}
                                onClick={() => {
                                    setShowAllChecklists(true);
                                    setCurrentChannel(null);
                                    setCurrentCollection(null);
                                    setCurrentDM(null);
                                    setShowFriendsPanel(false);
                                    setShowDevicesView(false);
                                    if (isMobile) setMobilePanel('chat');
                                }}
                                title="View every checklist in this server"
                            >
                                <span className="hash"><ChecklistIcon /></span>
                                <span className="channel-name">All Checklists</span>
                            </li>
                        )}

                        {/* Parent Channels (Collections) and Top-level Text Channels.
                            "Hide Muted Channels" (server context menu) filters muted
                            ones out — except the channel currently open, which must
                            never vanish from under the reader. */}
                        {channels
                            .filter(c => (c.channel_type === 0 || c.channel_type === 2) && !c.parent_id)
                            .filter(c => {
                                if (!hideMutedHere || !isChannelMuted(c.id) || currentChannel?.id === c.id) return true;
                                // A muted COLLECTION must not drag its children out of
                                // the sidebar with it: the row and its subchannels render
                                // as one fragment, so hiding the parent used to hide an
                                // unmuted subchannel (unread badge and all), and could
                                // hide the very channel being read — breaking the
                                // never-hide-the-open-channel rule this feature promises.
                                // Mute is per channel; the parent stays as the group
                                // header for whatever is still visible beneath it.
                                return channels.some(sub => sub.parent_id === c.id
                                    && (!isChannelMuted(sub.id) || currentChannel?.id === sub.id));
                            })
                            .map(channel => {
                                const unreadCount = currentServerMuted ? 0 : (unreadCounts.get(channel.id) || 0);
                                const isCollection = channel.channel_type === 2;
                                const subchannels = channels.filter(sub => sub.parent_id === channel.id)
                                    .filter(sub => !hideMutedHere || !isChannelMuted(sub.id) || currentChannel?.id === sub.id);

                                return (
                                    <React.Fragment key={channel.id}>
                                        <li
                                            className={`channel ${currentChannel?.id === channel.id ? 'active' : ''} ${unreadCount > 0 ? 'has-unread' : ''} ${draggingChannelId === channel.id ? 'dragging' : ''} ${dragOverChannelId === channel.id ? 'drag-over' : ''} ${isCollection ? 'collection-parent' : ''}`}
                                            onClick={() => handleChannelClick(channel)}
                                            onContextMenu={(e) => showContextMenu(e, [
                                                ...(isCollection ? [{
                                                    id: 'create-subchannel',
                                                    label: 'Create Subchannel',
                                                    // `as const`: this literal sits inside a spread, which
                                                    // does NOT inherit the array's ContextMenuItem context,
                                                    // so a bare 'plus' widens to string and fails IconName.
                                                    icon: 'plus' as const,
                                                    onClick: () => {
                                                        setNewChannelParentId(channel.id);
                                                        setNewChannelType(0);
                                                        setShowCreateModal(true);
                                                    }
                                                }] : []),
                                                {
                                                    id: 'mute-channel',
                                                    label: isChannelMuted(channel.id) ? 'Unmute Channel' : 'Mute Channel',
                                                    icon: isChannelMuted(channel.id) ? 'bell' : 'bell-off',
                                                    onClick: () => { toggleChannelMute(channel.id); setVoiceUpdateTrigger(p => p + 1); },
                                                },
                                                menuItems.channel.edit(() => setEditingChannel(channel)),
                                                menuItems.channel.delete(() => handleDeleteChannel(channel.id)),
                                                menuItems.separator(),
                                                menuItems.channel.copyId(channel.id),
                                            ])}
                                            onMouseDown={(e) => handleChannelMouseDown(e, channel)}
                                            onMouseEnter={() => handleChannelMouseEnter(channel)}
                                            onMouseLeave={handleChannelMouseLeave}
                                            style={{ cursor: draggingChannelId ? 'grabbing' : (currentServer?.owner_id === currentUserId ? 'grab' : 'pointer') }}
                                        >
                                            <span className="hash">{channel.has_checklist ? <ChecklistIcon /> : isCollection ? <FolderIcon /> : <HashIcon />}</span>
                                            <span className="channel-name">{channel.name}</span>
                                            {unreadCount > 0 && (
                                                <span className="unread-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
                                            )}
                                        </li>
                                        {/* Render Subchannels if Collection */}
                                        {isCollection && subchannels.map(sub => {
                                            const subUnread = currentServerMuted ? 0 : (unreadCounts.get(sub.id) || 0);
                                            return (
                                                <li
                                                    key={sub.id}
                                                    className={`channel subchannel ${currentChannel?.id === sub.id ? 'active' : ''} ${subUnread > 0 ? 'has-unread' : ''} ${draggingChannelId === sub.id ? 'dragging' : ''} ${dragOverChannelId === sub.id ? 'drag-over' : ''}`}
                                                    onClick={() => handleChannelClick(sub)}
                                                    onContextMenu={(e) => showContextMenu(e, [
                                                        {
                                                            id: 'mute-channel',
                                                            label: isChannelMuted(sub.id) ? 'Unmute Channel' : 'Mute Channel',
                                                            icon: isChannelMuted(sub.id) ? 'bell' : 'bell-off',
                                                            onClick: () => { toggleChannelMute(sub.id); setVoiceUpdateTrigger(p => p + 1); },
                                                        },
                                                        menuItems.channel.edit(() => setEditingChannel(sub)),
                                                        menuItems.channel.delete(() => handleDeleteChannel(sub.id)),
                                                        menuItems.separator(),
                                                        menuItems.channel.copyId(sub.id),
                                                    ])}
                                                    onMouseDown={(e) => handleChannelMouseDown(e, sub)}
                                                    onMouseEnter={() => handleChannelMouseEnter(sub)}
                                                    onMouseLeave={handleChannelMouseLeave}
                                                    style={{ cursor: draggingChannelId ? 'grabbing' : (currentServer?.owner_id === currentUserId ? 'grab' : 'pointer') }}
                                                >
                                                    <span className="sub-icon">↳</span>
                                                    <span className="hash">{sub.has_checklist ? <ChecklistIcon /> : <HashIcon />}</span>
                                                    <span className="channel-name">{sub.name}</span>
                                                    {subUnread > 0 && (
                                                        <span className="unread-badge">{subUnread > 99 ? '99+' : subUnread}</span>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </React.Fragment>
                                );
                            })}
                    </ul>
                </div>

                {/* Voice Channels Section */}
                <div className="sidebar-section">
                    <div className="sidebar-header">
                        <h3>Voice Channels</h3>
                        <button
                            className="add-channel-btn"
                            onClick={() => { setNewChannelType(1); setShowCreateModal(true); }}
                            title="Create Voice Channel"
                        >
                            +
                        </button>
                    </div>
                    <ul
                        className="channel-list voice-channel-list"
                        ref={setVoiceDragContainer}
                        onPointerDown={onVoiceDragPointerDown}
                    >
                        {channels
                            .filter(c => c.channel_type === 1)
                            // AFK is always pinned last; the rest keep server order.
                            .sort((a, b) => (a.is_afk ? 1 : 0) - (b.is_afk ? 1 : 0))
                            .map(channel => {
                            const voiceUsers = getVoiceUsersInRoom(`voice_${channel.id}`);
                            return (
                                // The drop target is the WHOLE block, not just
                                // the name row: when you drag someone into a
                                // channel you aim at the people already in it,
                                // and the occupant list is a sibling of that
                                // row. Targeting the row alone meant dropping
                                // onto the obvious place hit nothing at all.
                                <li
                                    key={channel.id}
                                    className={`voice-channel-container ${voiceDragState.overChannelId === channel.id ? 'voice-drop-target' : ''}`}
                                    data-voice-drop={channel.id}
                                >
                                    <div
                                        className={`channel voice-channel ${channel.is_afk ? 'afk' : ''} ${currentVoiceChannel?.id === channel.id ? 'active' : ''} ${draggingChannelId === channel.id ? 'dragging' : ''} ${dragOverChannelId === channel.id ? 'drag-over' : ''}`}
                                        onClick={() => handleChannelClick(channel)}
                                        onContextMenu={(e) => showContextMenu(e, [
                                            menuItems.channel.edit(() => setEditingChannel(channel)),
                                            menuItems.channel.delete(() => handleDeleteChannel(channel.id)),
                                            menuItems.separator(),
                                            menuItems.channel.copyId(channel.id),
                                        ])}
                                        onMouseDown={(e) => { if (!channel.is_afk) handleChannelMouseDown(e, channel); }}
                                        onMouseEnter={() => { if (!channel.is_afk) handleChannelMouseEnter(channel); }}
                                        onMouseLeave={handleChannelMouseLeave}
                                        style={{ cursor: draggingChannelId ? 'grabbing' : (!channel.is_afk && currentServer?.owner_id === currentUserId ? 'grab' : 'pointer') }}
                                    >
                                        <span className="voice-icon">{channel.is_afk ? <MoonIcon /> : <SpeakerIcon />}</span>
                                        {channel.name}
                                    </div>
                                    {/* Show users in this voice channel */}
                                    {voiceUsers.length > 0 && (
                                        <ul className="voice-users-list">
                                            {voiceUsers.map(user => {
                                                const member = allMembers.find(m => m.id === user.id);
                                                const avatarId = member?.avatar_file_id;
                                                const isSpeaking = isUserSpeaking(user.id);
                                                const isStreaming = isUserStreaming(user.id);
                                                const isDraggableVoiceRow = canMoveVoiceMembers
                                                    && !channel.is_afk
                                                    && user.id !== currentUserId;
                                                return (
                                                    <li
                                                        key={user.id}
                                                        className={`voice-user-item ${user.isMuted ? 'muted' : ''} ${isSpeaking ? 'speaking' : ''} ${user.connecting ? 'connecting' : ''} ${voiceDragState.dragging?.userId === user.id ? 'voice-dragging' : ''}`}
                                                        // Drag source. The attributes are what the hook
                                                        // picks rows up by, so a row that must not move
                                                        // simply does not carry them:
                                                        //  - AFK, because nobody is dragged OUT of it.
                                                        //    Leaving it draggable meant a drag that
                                                        //    highlighted nothing and did nothing on
                                                        //    release — indistinguishable from broken.
                                                        //    Mirrors the channel-reorder drag, which
                                                        //    also excludes AFK.
                                                        //  - yourself, which the API refuses outright
                                                        //    ("use the channel list"); offering the
                                                        //    gesture would only ever produce an error.
                                                        // The context menu carries the same rules, so
                                                        // neither surface promises what the other denies.
                                                        {...(isDraggableVoiceRow ? {
                                                            'data-voice-user': user.id,
                                                            'data-voice-username': member?.display_name || user.username,
                                                            'data-voice-from': channel.id,
                                                            title: 'Drag onto another voice channel to move them',
                                                            style: { cursor: voiceDragState.dragging ? 'grabbing' : 'grab' },
                                                        } : {})}
                                                        onClick={(e) => {
                                                            if (isStreaming) {
                                                                selectStream(user.id);
                                                                useStreamStore.getState().setFocusedStream(user.id);
                                                                setViewMode('stream');
                                                            } else {
                                                                setUserContextMenuTarget({
                                                                    userId: user.id,
                                                                    username: user.username,
                                                                    isInVoice: true,
                                                                    position: { x: e.clientX, y: e.clientY }
                                                                });
                                                            }
                                                        }}
                                                        onContextMenu={(e) => {
                                                            e.preventDefault();
                                                            setUserContextMenuTarget({
                                                                userId: user.id,
                                                                username: user.username,
                                                                isInVoice: true,
                                                                position: { x: e.clientX, y: e.clientY }
                                                            });
                                                        }}
                                                    >
                                                        <div className={`voice-user-avatar-small ${isSpeaking ? 'speaking' : ''}`}>
                                                            <SmartAvatar
                                                                userId={user.id}
                                                                fileId={avatarId}
                                                                fallback={<span>{user.username[0]?.toUpperCase()}</span>}
                                                            />
                                                        </div>
                                                        <span className="voice-user-name">
                                                            {member?.display_name || user.username}
                                                            {globalCameraUsers.has(user.id) && <span className="camera-badge-mini" title="Camera On"><CameraIcon /></span>}
                                                            {isStreaming && <span className="live-badge-mini">LIVE</span>}
                                                        </span>
                                                        <div className="voice-user-indicators">
                                                            {/* Clip replay buffer armed on their machine: the last few
                                                                minutes of this call are being kept (advisory — a
                                                                cooperating client asserts it; docs/CLIPS.md). */}
                                                            {user.isBuffering && <span className="voice-status-icon buffering" title="Clip buffer on — the last few minutes of this call are being kept on their PC" aria-label="Clip buffer on"><ClipIcon /></span>}
                                                            {/* In the channel, media not yet reachable — the join
                                                                chime is being held (set only by the in-call panel). */}
                                                            {user.connecting && <span className="voice-status-icon connecting" title={mediaE2eeExplanation('negotiating', member?.display_name || user.username) ?? ''}><LockOpenIcon /></span>}
                                                            {/* Mic, not speaker: "muted" here is the user's own mic, and
                                                                VoiceStage renders the same isMuted flag as MicOffIcon. */}
                                                            {user.isMuted && <span className="voice-status-icon muted" title="Muted"><MicOffIcon /></span>}
                                                            {user.isDeafened && <span className="voice-status-icon deafened" title="Deafened"><HeadphonesOffIcon /></span>}
                                                        </div>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
                </>)}

                {/* Home/DM view — the same left column the Friends dashboard
                    shows (search + Friends/Tasks nav + DM list), so opening a
                    DM only swaps the main content instead of dumping the user
                    on a bare stand-alone screen. NEVER rendered inside a
                    server: a server's sidebar is channels only. Skipped while
                    the dashboard overlay is up — it has its own copy, and two
                    mounted instances just duplicate DOM behind the overlay. */}
                {!currentServer && !showFriendsPanel && (
                    <HomeSidebar
                        dmConversations={dmConversations}
                        friendsActive={false}
                        tasksActive={false}
                        activeDMId={currentDM?.id ?? null}
                        searchQuery={homeSearchQuery}
                        onSearchQueryChange={setHomeSearchQuery}
                        onNavFriends={() => {
                            setFriendsTab('online');
                            setShowFriendsPanel(true);
                            setShowDevicesView(false);
                            setShowChecklist(false); // drawer would cover the dashboard
                            if (isMobile) setMobilePanel('chat');
                        }}
                        onNavTasks={openTasksView}
                        onSelectDM={openDMConversation}
                        onStartUserDM={startDMWithUser}
                    />
                )}

                {/* Spacer to push user profile to bottom. Server context only —
                    in the home/DM view the HomeSidebar is itself flex:1, and a
                    flex:1 spacer beside it would steal half the column. */}
                {currentServer && <div className="sidebar-spacer"></div>}

                </div>{/* /sidebar-scroll */}

                {/* Voice Control Panel */}
                {currentVoiceChannel && (() => {
                    const panel = (
                        <VoicePanel
                            key={currentVoiceChannel.id}
                            roomId={`voice_${currentVoiceChannel.id}`}
                            channelName={currentVoiceChannel.name}
                            currentUserId={currentUserId}
                            currentUsername={currentUser?.username || 'Unknown'}
                            memberAvatars={new Map(allMembers.map(m => [m.id, m.avatar_file_id || null]))}
                            memberSounds={voiceMemberSounds}
                            onDisconnect={() => setCurrentVoiceChannel(null)}
                            // The voice channel may belong to a different server than the
                            // one currently viewed — resolve its own server's policy.
                            serverRequireMediaE2ee={
                                (servers.find(s => s.id === currentVoiceChannel.server_id) ?? currentServer)
                                    ?.require_media_e2ee ?? false
                            }
                            isAfkChannel={!!currentVoiceChannel.is_afk}
                            sfuMode={!!currentVoiceChannel.sfu_mode}
                            // Clips policy of the VOICE channel's server (docs/CLIPS.md) —
                            // not the viewed one; the default post target is the viewed
                            // channel only when it belongs to that server.
                            clipPolicy={(() => {
                                const vs = servers.find(s => s.id === currentVoiceChannel.server_id) ?? currentServer ?? null;
                                return {
                                    available: clipsAvailable(vs),
                                    serverClipsEnabled: vs && typeof vs.clip_max_seconds === 'number' ? vs.clips_enabled === true : undefined,
                                    serverId: vs?.id ?? null,
                                    maxSeconds: vs?.clip_max_seconds ?? 120,
                                    pinnedChannelId: vs?.clip_channel_id ?? null,
                                    defaultTargetChannelId: currentChannel && vs && currentChannel.server_id === vs.id && currentChannel.channel_type === 0 ? currentChannel.id : null,
                                    voiceChannelPerms: currentVoiceChannel.my_permissions ?? null,
                                };
                            })()}
                            onInactive={() => {
                                // Move an idle user to the AFK channel of the server the
                                // VOICE channel belongs to. `channels` is the VIEWED
                                // server's list — browsing server B while in voice on
                                // server A would look up B's AFK channel — so resolve
                                // against the voice channel's own server instead.
                                resolveAfkTarget(queryClient, currentVoiceChannel)
                                    .then(afk => {
                                        if (!afk) return;
                                        // The resolve may have hit the network: the user
                                        // can have left voice or switched channels while
                                        // it ran, and moving them now would drag them
                                        // back into a call they already exited.
                                        setCurrentVoiceChannel(prev =>
                                            prev && prev.id === currentVoiceChannel.id && !prev.is_afk ? afk : prev
                                        );
                                    })
                                    .catch(err => console.error('AFK move: failed to resolve target channel:', err));
                            }}
                        />
                    );
                    // On mobile, .sidebar always carries a CSS `transform` (mobile.css
                    // slides panels in/out with it) — any non-`none` transform on an
                    // ancestor makes it a containing block for position:fixed
                    // descendants, trapping the voice panel inside the sidebar's box
                    // and hiding it (along with the sidebar) whenever you're actually
                    // looking at chat instead of the channel list. Portal it to <body>
                    // so its fixed positioning is relative to the real viewport,
                    // matching mobile.css's intent of a persistent mini-bar above the
                    // bottom nav regardless of which panel is active.
                    return isMobile ? createPortal(panel, document.body) : panel;
                })()}

                {/* User Profile Bar at Bottom */}
                <div className="user-profile-bar">
                    <div
                        className="user-profile-info"
                        onClick={() => setShowUserSettings(true)}
                        title="Edit Profile"
                    >
                        <div className="user-avatar">
                            {(() => {
                                const member = allMembers.find(m => m.id === currentUserId);
                                return (
                                    <SmartAvatar
                                        userId={currentUserId}
                                        fileId={member?.avatar_file_id}
                                        fallback={currentUser?.username?.[0]?.toUpperCase() || '?'}
                                    />
                                );
                            })()}
                        </div>
                        <div className="user-details">
                            <span className="user-username">{currentUser?.username || 'Unknown'}</span>
                            <span className="user-status">Online</span>
                        </div>
                    </div>
                    <div className="user-actions">
                        <button
                            className="user-action-btn"
                            onClick={() => setShowSettings(true)}
                            title="Settings"
                        >
                            <SettingsIcon />
                        </button>
                    </div>
                </div>
            </aside>

            {/* Main Chat Area */}
            <main className="chat-main">
                <header className="chat-header">
                    {currentDM ? (
                        <>
                            <span className="dm-icon">{currentDM.other_user_id === currentUserId ? <NoteIcon /> : <MessageIcon />}</span>
                            <h2>{currentDM.other_username}</h2>
                            <button
                                className="back-to-server-btn"
                                onClick={() => {
                                    // DMs live in the home/DM view now — closing one
                                    // returns to the Friends/DM home, not a server.
                                    setCurrentDM(null);
                                    setDmMessages([]);
                                    setFriendsTab('online');
                                    setShowFriendsPanel(true);
                                    setShowDevicesView(false);
                                    if (isMobile) setMobilePanel('chat');
                                }}
                                title="Back to messages"
                            >
                                Back
                            </button>
                            {/* DMs get the same search box as channels — it used
                                to exist only in the channel branch. */}
                            {searchBar}
                        </>
                    ) : (
                        <>
                            <span className="hash">
                                {currentCollection ? <FolderIcon /> : currentChannel?.has_checklist ? <ChecklistIcon /> : currentChannel?.channel_type === 2 ? <FolderIcon /> : currentChannel?.channel_type === 1 ? <SpeakerIcon /> : <HashIcon />}
                            </span>
                            <h2>{currentCollection?.name || currentChannel?.name || 'No channel selected'}</h2>
                            {(currentCollection?.description || currentChannel?.description) && (
                                <span className="channel-description">{currentCollection?.description || currentChannel?.description}</span>
                            )}
                            {/* Watch Streams button - shows when streams are active and user is in chat mode */}
                            {viewMode === 'chat' && getSelectedStreams().length > 0 && (
                                <button
                                    className="watch-streams-btn"
                                    onClick={() => setViewMode('stream')}
                                    title="Watch live streams"
                                >
                                    <LiveDotIcon /> Watch Streams ({getSelectedStreams().length})
                                </button>
                            )}
                            <button
                                className="checklist-toggle-btn"
                                onClick={() => setShowChecklist(!showChecklist)}
                                title={showChecklist ? "Hide Checklist" : "Show Checklist"}
                            >
                                <ChecklistIcon />
                            </button>
                            {currentChannel && (
                                <div className="pins-wrapper">
                                    <button
                                        className="pins-toggle-btn"
                                        onClick={togglePins}
                                        title="Pinned messages"
                                    >
                                        <PinIcon />
                                    </button>
                                    {showPins && (() => {
                                        // One filtered list drives the empty state AND the
                                        // rows, or hiding every pin leaves a blank panel
                                        // with no explanation.
                                        const visiblePins = pinnedMessages.filter(p => !isMessageHidden(p.id));
                                        return (
                                        <div className="pins-panel">
                                            <div className="pins-panel-header">
                                                <span>Pinned Messages</span>
                                                <button onClick={() => setShowPins(false)} title="Close"><CloseIcon /></button>
                                            </div>
                                            {visiblePins.length === 0 ? (
                                                <div className="pins-empty">No pinned messages yet.</div>
                                            ) : (
                                                visiblePins.map(p => (
                                                    <div key={p.id} className="pin-item">
                                                        <div className="pin-item-body">
                                                            <strong>{p.display_name || p.username}</strong>
                                                            <span>{p.content.length > 120 ? p.content.slice(0, 120) + '…' : p.content}</span>
                                                        </div>
                                                        <button
                                                            className="pin-unpin-btn"
                                                            onClick={() => handleUnpin(p.id)}
                                                            title="Unpin"
                                                        >
                                                            <CloseIcon />
                                                        </button>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                        );
                                    })()}
                                </div>
                            )}
                            {searchBar}
                        </>
                    )}
                    {/* Settings, from the chat itself. The only other cog
                        lives at the bottom of the channel sidebar, which the
                        overlay views cover on desktop and mobile keeps
                        off-canvas — this one is the always-reachable way in. */}
                    <button
                        className="chat-header-cog"
                        onClick={() => setShowSettings(true)}
                        title="Settings"
                        aria-label="Open settings"
                    >
                        <SettingsIcon />
                    </button>
                </header>

                <div
                    ref={messagesContainerRef}
                    onScroll={handleMessagesScroll}
                    onWheel={cancelPinning}
                    onTouchStart={cancelPinning}
                    className="messages-container"
                    // Drag-and-drop attachments: any file dropped on the chat
                    // area goes through the same E2EE encrypt-and-upload path
                    // as the attach picker (dropping used to be a silent no-op).
                    onDragOver={(e) => {
                        if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
                    }}
                    onDrop={(e) => {
                        const files = Array.from(e.dataTransfer?.files ?? []);
                        if (files.length === 0) return;
                        e.preventDefault();
                        for (const file of files) enqueueUpload(file);
                    }}
                >
                    {/* Stream Stage - takes over main area when viewing streams */}
                    {showAllChecklists ? (
                        /* Server-wide "All checklists" board */
                        <AllChecklistsView
                            serverName={currentServer?.name || 'Server'}
                            channels={channels}
                            onOpenChannel={(ch) => { setShowAllChecklists(false); handleChannelClick(ch); }}
                            currentUserId={currentUserId}
                            resolveUserName={resolveMemberName}
                        />
                    ) : viewMode === 'stream' ? (
                        <StreamStage
                            onBackToChat={() => setViewMode('chat')}
                            poppedStreams={poppedStreams}
                            onTogglePopout={togglePopout}
                        />
                    ) : viewMode === 'voice' && currentVoiceChannel ? (
                        /* Persistent voice view — clicking the connected
                           voice channel lands here instead of disconnecting */
                        <VoiceStage
                            roomId={`voice_${currentVoiceChannel.id}`}
                            channelName={currentVoiceChannel.name}
                            currentUserId={currentUserId}
                            memberAvatars={new Map(allMembers.map(m => [m.id, m.avatar_file_id || null]))}
                            memberNames={new Map(allMembers.map(m => [m.id, m.display_name || m.server_nickname || m.username]))}
                            onBackToChat={() => setViewMode('chat')}
                            onWatchStream={(userId) => {
                                selectStream(userId);
                                setShowPip(false);
                                setViewMode('stream');
                            }}
                            onInvite={currentServer && currentServer.id === currentVoiceChannel.server_id
                                ? () => setShowInviteModal(true)
                                : undefined}
                            onUserMenu={(user, pos) => setUserContextMenuTarget({
                                userId: user.userId,
                                username: user.username,
                                isInVoice: true,
                                position: pos,
                            })}
                        />
                    ) : currentChannel?.channel_type === 2 ? (
                        /* Channel Collection Dashboard */
                        <ChannelDashboard channel={currentChannel} />
                    ) : currentChannel?.has_checklist ? (
                        /* Checklist channel — the Keep-style list IS the main content */
                        <ChecklistBody
                            channelId={currentChannel.id}
                            myPerms={currentChannel.my_permissions}
                            currentUserId={currentUserId}
                            resolveUserName={resolveMemberName}
                        />
                    ) : (
                        /* Messages - show when in chat mode */
                        currentDM ? (
                            // DM messages — same grouped layout + date dividers as
                            // server channels so the conversation reads cleanly.
                            visibleDmMessages.map((msg, idx) => {
                                const prevMsg = idx > 0 ? visibleDmMessages[idx - 1] : null;
                                const ts = parseServerTimestampSecs(msg.created_at);
                                const prevTs = prevMsg ? parseServerTimestampSecs(prevMsg.created_at) : 0;
                                const showDateDivider = idx === 0 || (prevMsg !== null &&
                                    new Date(prevTs * 1000).toDateString() !== new Date(ts * 1000).toDateString());
                                const grouped = !!prevMsg && !showDateDivider &&
                                    prevMsg.sender_id === msg.sender_id &&
                                    (ts - prevTs) < GROUP_WINDOW_SECONDS;
                                return (
                                    <React.Fragment key={msg.id}>
                                        {showDateDivider && (
                                            <div className="date-divider"><span>{formatDateDivider(ts)}</span></div>
                                        )}
                                        <div
                                            // Search results jump by element id. Without this only
                                            // CHANNEL rows had one, so every DM hit was a dead click
                                            // that then blamed "further back than loaded history".
                                            id={`msg-${msg.id}`}
                                            className={`message ${grouped ? 'grouped' : ''}`}
                                            onContextMenu={(e) => {
                                                const pressX = e.clientX, pressY = e.clientY;
                                                showContextMenu(e, [
                                                    // Right-clicking an image inside the message gets image
                                                    // actions first. The row handler calls preventDefault, so
                                                    // the WebView's own "Copy image" never appears — without
                                                    // these there is no way to copy a picture at all.
                                                    ...imageMenuItems(e.target, showToast),
                                                    // Reactions work in DMs (see the strip below); local_
                                                    // ids don't exist server-side yet.
                                                    ...(!msg.id.startsWith('local_')
                                                        ? [menuItems.message.react(() => setReactRequest(r => ({
                                                            messageId: msg.id,
                                                            nonce: (r?.nonce ?? 0) + 1,
                                                            x: pressX,
                                                            y: pressY,
                                                        })))]
                                                        : []),
                                                    menuItems.message.quote(() => handleQuote(msg.content)),
                                                    // A clip post is never forwarded: it carries the clip KEY, and a
                                                    // forwarded copy would play in rooms nobody consented to, with no stamp.
                                                    ...(hasClipRef(msg.content) ? [] : [menuItems.message.forward(() => setForwardingContent(msg.content))]),
                                                    menuItems.message.copy(msg.content),
                                                    // DMs have no server-side delete — "for me" is the
                                                    // one deletion a DM offers, and it works on both
                                                    // sides' messages because it deletes nothing.
                                                    ...(!msg.id.startsWith('local_')
                                                        ? [menuItems.message.hide(() => hideMessageForMe(msg.id))]
                                                        : []),
                                                    menuItems.separator(),
                                                    menuItems.message.copyId(msg.id),
                                                ]);
                                            }}
                                        >
                                            {grouped ? (
                                                <span className="message-gutter-time">{formatTime(ts)}</span>
                                            ) : (
                                                <div className="message-avatar">{avatarInitial(msg.sender_display_name, msg.sender_username)}</div>
                                            )}
                                            <div className="message-body">
                                                {!grouped && (
                                                    <div className="message-header">
                                                        <span className="message-author">{msg.sender_display_name || msg.sender_username}</span>
                                                        <span className="message-time">{formatTime(ts)}</span>
                                                    </div>
                                                )}
                                                <div className="message-content"><MessageContent content={msg.content} members={allMembers} channels={channels} onChannelClick={handleChannelClick} /><NotEncryptedBadge encState={msg.encState} /></div>
                                                {/* Reactions work on DM messages too (no serverId — custom
                                                    server emojis don't apply in DMs). Skip optimistic local_
                                                    bubbles: their ids don't exist server-side yet. */}
                                                {!msg.id.startsWith('local_') && (
                                                    <MessageReactions
                                                        messageId={msg.id}
                                                        currentUserId={currentUserId}
                                                        openRequest={reactRequest?.messageId === msg.id ? reactRequest : undefined}
                                                    />
                                                )}
                                            </div>
                                            {/* Same unified toolbar as channel rows. Reply/Edit/Pin/
                                                Delete-for-everyone are omitted: the DM API has only
                                                get/send (no reply_to_id, edit, pin or delete
                                                endpoints). Hide (delete for me) is local, so it works
                                                here. React works — reactions key on the message id and
                                                the backend broadcasts DM ReactionUpdate to both
                                                participants. */}
                                            <MessageToolbar
                                                messageId={msg.id}
                                                onQuote={() => handleQuote(msg.content)}
                                                onForward={hasClipRef(msg.content) ? undefined : () => setForwardingContent(msg.content)}
                                                onHide={() => hideMessageForMe(msg.id)}
                                            />
                                        </div>
                                    </React.Fragment>
                                );
                            })
                        ) : (
                            // Server channel messages (with collection headers if in collection view)
                            <>
                            {/* Under one page of history means we're looking at the very
                                start of the channel, so anchor it with the welcome block
                                instead of leaving unexplained empty space. */}
                            {messages.length < 50 && currentChannel && !currentCollection && (
                                <div className="channel-welcome">
                                    <div className="channel-welcome-icon">#</div>
                                    <h2>Welcome to #{currentChannel.name}!</h2>
                                    <p>This is the start of the #{currentChannel.name} channel.</p>
                                </div>
                            )}
                            {messages.length >= 50 && (
                                <button className="load-older-btn" onClick={loadOlderMessages} disabled={loadingOlder}>
                                    {loadingOlder ? 'Loading…' : 'Load older messages'}
                                </button>
                            )}
                            {visibleMessages.map((msg, idx) => {
                                // Show channel header when channel changes (collection view)
                                const prevMsg = idx > 0 ? visibleMessages[idx - 1] : null;
                                const showChannelHeader = currentCollection && msg.channelName &&
                                    (idx === 0 || prevMsg?.channelId !== msg.channelId);

                                // Date divider when the calendar day changes.
                                const showDateDivider = idx === 0 || (prevMsg &&
                                    new Date(prevMsg.timestamp * 1000).toDateString() !== new Date(msg.timestamp * 1000).toDateString());

                                // Blocked sender: collapse to a stub instead of removing —
                                // silently missing messages make replies from others read
                                // as non-sequiturs. One stub per run of consecutive
                                // blocked messages; unblocking reveals them in place.
                                if (blockedUserIds.has(msg.sender.id)) {
                                    const prevAlsoBlocked = !!prevMsg && !showDateDivider && !showChannelHeader &&
                                        blockedUserIds.has(prevMsg.sender.id);
                                    if (prevAlsoBlocked) return null;
                                    return (
                                        <React.Fragment key={msg.id}>
                                            {showDateDivider && (
                                                <div className="date-divider"><span>{formatDateDivider(msg.timestamp)}</span></div>
                                            )}
                                            {/* The channel header must survive too. In the collection
                                                view it marks where one channel's run begins; dropping it
                                                because that run happens to START with a blocked message
                                                files every following message under the PREVIOUS channel's
                                                heading. */}
                                            {showChannelHeader && (
                                                <div className="collection-channel-header">
                                                    <span className="hash"><HashIcon /></span>
                                                    <span className="channel-name">{msg.channelName}</span>
                                                </div>
                                            )}
                                            <div className="message blocked-message-stub" title="Message hidden because you blocked this user">
                                                <BanIcon /> Blocked message
                                            </div>
                                        </React.Fragment>
                                    );
                                }

                                // Group with the previous message (compact, no avatar/header).
                                const grouped = !!prevMsg && !showDateDivider && !showChannelHeader &&
                                    prevMsg.sender.id === msg.sender.id &&
                                    (msg.timestamp - prevMsg.timestamp) < GROUP_WINDOW_SECONDS &&
                                    !msg.reply_to && !msg.is_task;

                                // Highlight messages that @mention the current user (not your own).
                                const mentionsMe = msg.sender.id !== currentUserId && currentUser != null &&
                                    messageMentionsUser(msg.content, {
                                        username: currentUser.username,
                                        server_nickname: allMembers.find(m => m.id === currentUserId)?.server_nickname,
                                        display_name: allMembers.find(m => m.id === currentUserId)?.display_name,
                                    });

                                return (
                                    <React.Fragment key={msg.id}>
                                        {showDateDivider && (
                                            <div className="date-divider"><span>{formatDateDivider(msg.timestamp)}</span></div>
                                        )}
                                        {showChannelHeader && (
                                            <div className="collection-channel-header">
                                                <span className="hash"><HashIcon /></span>
                                                <span className="channel-name">{msg.channelName}</span>
                                            </div>
                                        )}
                                        <div
                                            key={msg.id}
                                            id={`msg-${msg.id}`}
                                            className={`message ${grouped ? 'grouped' : ''} ${mentionsMe ? 'mentioned' : ''}`}
                                            onContextMenu={(e) => {
                                                // Optimistic local_ ids: only content-based actions
                                                // (quote/forward/copy) work before the server id lands.
                                                const isLocal = msg.id.startsWith('local_');
                                                const pressX = e.clientX, pressY = e.clientY;
                                                const items = [
                                                    // Image actions first when the click landed on a picture;
                                                    // empty otherwise. See the channel-view handler above.
                                                    ...imageMenuItems(e.target, showToast),
                                                    // On touch this is the only reaction entry point — the
                                                    // inline + button is hidden there (MessageReactions.css).
                                                    ...(!isLocal
                                                        ? [menuItems.message.react(() => setReactRequest(r => ({
                                                            messageId: msg.id,
                                                            nonce: (r?.nonce ?? 0) + 1,
                                                            x: pressX,
                                                            y: pressY,
                                                        })))]
                                                        : []),
                                                    // Reply, like Quote, needs the composer — collection view
                                                    // hides it, so a reply there would strand a dead banner.
                                                    ...(!isLocal && !currentCollection ? [menuItems.message.reply(() => setReplyingTo(msg))] : []),
                                                    // Quote needs the composer, which collection view hides.
                                                    ...(!currentCollection ? [menuItems.message.quote(() => handleQuote(msg.content))] : []),
                                                    // Never for a clip post (docs/CLIPS.md): the body carries the clip key.
                                                    ...(hasClipRef(msg.content) ? [] : [menuItems.message.forward(() => setForwardingContent(msg.content))]),
                                                    menuItems.message.copy(msg.content),
                                                    // Local hide, any persisted message — deletes nothing.
                                                    ...(!isLocal ? [menuItems.message.hide(() => hideMessageForMe(msg.id))] : []),
                                                    menuItems.separator(),
                                                ];
                                                // Edit is author-only (matches the server); pin and
                                                // delete follow the server's actual rule — author OR
                                                // Manage Messages in this channel. The perm branch
                                                // requires my_permissions to be PRESENT: hasPerm
                                                // fails open on undefined for pre-migration servers,
                                                // and "fail open" must not mean "offer moderation
                                                // buttons that will 403".
                                                const canModerate = currentChannel?.my_permissions != null
                                                    && hasPerm(currentChannel.my_permissions, PERM.MANAGE_MESSAGES);
                                                const isOwnMsg = msg.sender.id === currentUserId;
                                                if (!isLocal && messageChannelId(msg) && (isOwnMsg || canModerate)) {
                                                    items.push(
                                                        // A clip post cannot be edited (the body IS the clip; the server refuses with 400).
                                                        ...(isOwnMsg && !msg.clip_consent ? [menuItems.message.edit(() => editOwnMessage(msg))] : []),
                                                        // Pin is MANAGE_MESSAGES-only server-side —
                                                        // authors without it got a button that 403'd.
                                                        ...(canModerate ? [menuItems.message.pin(() => pinOwnMessage(msg))] : []),
                                                        menuItems.message.delete(() => deleteMessageForEveryone(msg)),
                                                        menuItems.separator(),
                                                    );
                                                }
                                                items.push(menuItems.message.copyId(msg.id));
                                                showContextMenu(e, items);
                                            }}
                                        >
                                            {grouped ? (
                                                <span className="message-gutter-time">{formatTime(msg.timestamp)}</span>
                                            ) : (
                                                <div className="message-avatar">
                                                    <SmartAvatar
                                                        userId={msg.sender.id}
                                                        fileId={getMemberAvatar(allMembers, msg.sender.id)}
                                                        fallback={msg.sender.username[0]?.toUpperCase()}
                                                    />
                                                </div>
                                            )}
                                            <div className="message-body">
                                                {/* Reply reference */}
                                                {msg.reply_to && (
                                                    <div
                                                        className="message-reply-ref"
                                                        onClick={() => {
                                                            // Scroll to the referenced message
                                                            const el = document.getElementById(`msg-${msg.reply_to_id}`);
                                                            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                                            el?.classList.add('highlight');
                                                            setTimeout(() => el?.classList.remove('highlight'), 2000);
                                                        }}
                                                    >
                                                        <span className="reply-icon"><ReplyIcon /></span>
                                                        {blockedUsernames.has(msg.reply_to.username) ? (
                                                            // Quoting is a second delivery path for the text the
                                                            // stub hides — redact it here too, or blocking someone
                                                            // just means other people relay them to you.
                                                            <span className="reply-preview"><BanIcon /> blocked message</span>
                                                        ) : isMessageHidden(msg.reply_to.id) ? (
                                                            // Same rule for "Delete for Me": the reply snapshot
                                                            // must not keep re-delivering content the user hid.
                                                            <span className="reply-preview"><EyeOffIcon /> hidden message</span>
                                                        ) : (
                                                            <>
                                                                <span className="reply-author">@{msg.reply_to.username}</span>
                                                                <span className="reply-preview">{replyPreviewText(msg.reply_to.content, 50)}</span>
                                                            </>
                                                        )}
                                                    </div>
                                                )}
                                                {!grouped && (
                                                    <div className="message-header">
                                                        <span
                                                            className="message-author"
                                                            style={{ color: allMembers.find(m => m.id === msg.sender.id)?.top_role_color || undefined }}
                                                        >
                                                            {msg.sender.display_name || msg.sender.username}
                                                        </span>
                                                        <span className="message-time">{formatFullTimestamp(msg.timestamp)}</span>
                                                    </div>
                                                )}
                                                {/* Task checkbox — same completion rule as checklists:
                                                    COMPLETE_TASKS (or MANAGE_TASKS) on that channel */}
                                                {msg.is_task && (() => {
                                                    const taskChannelId = msg.channelId || currentChannel?.id;
                                                    const taskChanPerms = channels.find(c => c.id === taskChannelId)?.my_permissions;
                                                    const canToggle = hasPerm(taskChanPerms, PERM.COMPLETE_TASKS) || hasPerm(taskChanPerms, PERM.MANAGE_TASKS);
                                                    return (
                                                        <div
                                                            className={`task-checkbox ${msg.is_completed ? 'completed' : ''} ${canToggle ? '' : 'no-perm'}`}
                                                            title={canToggle ? undefined : 'No permission to complete tasks'}
                                                            onClick={async (e) => {
                                                                e.stopPropagation();
                                                                if (!taskChannelId || !canToggle) return;
                                                                try {
                                                                    const result = await toggleTaskCompletion(taskChannelId, msg.id);
                                                                    setMessages(prev => prev.map(m =>
                                                                        m.id === msg.id ? { ...m, is_completed: result.is_completed } : m
                                                                    ));
                                                                } catch (err) {
                                                                    console.error('Failed to toggle task:', err);
                                                                    alert('Could not update that task. You may not have permission.');
                                                                }
                                                            }}
                                                        >
                                                            {msg.is_completed ? <CheckboxCheckedIcon /> : <CheckboxIcon />}
                                                            {/* The old checkbox glyphs were TEXT, so a screen reader
                                                                read the completion state out. An icon is aria-hidden,
                                                                and an aria-label on this div would be dropped — a
                                                                div's implicit role is `generic`, which ARIA forbids
                                                                from having an accessible name. A visually-hidden
                                                                span restores exactly what the glyph used to say. */}
                                                            <span className="sr-only">
                                                                {msg.is_completed ? 'Task complete' : 'Task not complete'}
                                                            </span>
                                                        </div>
                                                    );
                                                })()}
                                                <div className={`message-content ${msg.is_task && msg.is_completed ? 'task-completed' : ''}`}>
                                                    <MessageContent content={msg.content} members={allMembers} channels={channels} onChannelClick={handleChannelClick} clipConsent={msg.clip_consent} />
                                                    {msg.edited && <span className="edited-tag" title="Edited">(edited)</span>}
                                                    <NotEncryptedBadge encState={msg.encState} />
                                                </div>
                                                <LinkPreview content={msg.content} />
                                                {!msg.id.startsWith('local_') && (
                                                    <MessageReactions
                                                        messageId={msg.id}
                                                        currentUserId={currentUserId}
                                                        serverId={currentServer?.id}
                                                        openRequest={reactRequest?.messageId === msg.id ? reactRequest : undefined}
                                                    />
                                                )}
                                            </div>
                                            {/* Unified hover toolbar: React/Reply/Quote/Forward + own
                                                Edit/Pin/Delete. The toolbar's React button is safe to
                                                bring back (unlike the old removed one): it goes through
                                                addReaction, whose ReactionUpdate broadcast refreshes the
                                                <MessageReactions> strip above. */}
                                            {(() => {
                                                const inChannel = messageChannelId(msg) != null;
                                                const isOwn = msg.sender.id === currentUserId && inChannel;
                                                // Same rule as the context menu: pin/delete for the
                                                // author OR a Manage Messages holder (perms must be
                                                // PRESENT — hasPerm fails open on undefined).
                                                const canModerate = inChannel
                                                    && currentChannel?.my_permissions != null
                                                    && hasPerm(currentChannel.my_permissions, PERM.MANAGE_MESSAGES);
                                                return (
                                                    <MessageToolbar
                                                        messageId={msg.id}
                                                        onReply={currentCollection ? undefined : () => setReplyingTo(msg)}
                                                        onQuote={currentCollection ? undefined : () => handleQuote(msg.content)}
                                                        onForward={hasClipRef(msg.content) ? undefined : () => setForwardingContent(msg.content)}
                                                        onEdit={isOwn && !msg.clip_consent ? () => editOwnMessage(msg) : undefined}
                                                        onPin={canModerate ? () => pinOwnMessage(msg) : undefined}
                                                        onDelete={isOwn || canModerate ? () => deleteMessageForEveryone(msg) : undefined}
                                                        onHide={() => hideMessageForMe(msg.id)}
                                                    />
                                                );
                                            })()}
                                        </div>
                                    </React.Fragment>
                                );
                            })}
                            </>
                        )
                    )}
                    {/* Jump-to-latest pill. Sits INSIDE the scroller on a
                        zero-height sticky anchor, so showing it never reflows
                        the message list. Gated to chat view — this container
                        is shared with the stream/voice/checklist views. */}
                    {showJumpLatest && showingMessageList && (
                        <div className="jump-latest-anchor">
                            <button className="jump-latest-pill" onClick={() => scrollToLatest('smooth')}>
                                {missedCount > 0
                                    ? `${missedCount} new message${missedCount === 1 ? '' : 's'}`
                                    : 'Jump to latest'}
                                <span className="jump-latest-arrow"><ChevronDownIcon /></span>
                            </button>
                        </div>
                    )}
                </div>

                {/* Typing Indicator */}
                {
                    typingUsers.size > 0 && (
                        <div className="typing-indicator">
                            <span className="typing-dots">•••</span>
                            {Array.from(typingUsers.values()).map(u => u.username).join(', ')}
                            {typingUsers.size === 1 ? ' is typing...' : ' are typing...'}
                        </div>
                    )
                }

                {/* Reply Preview Banner */}
                {
                    replyingTo && (
                        <div className="reply-preview-banner">
                            <span className="reply-icon"><ReplyIcon /></span>
                            <span className="replying-to">Replying to <strong>@{replyingTo.sender.username}</strong></span>
                            <span className="reply-content-preview">{replyPreviewText(replyingTo.content, 60)}</span>
                            <button
                                className="cancel-reply-btn"
                                onClick={() => setReplyingTo(null)}
                                title="Cancel reply"
                            >
                                <CloseIcon />
                            </button>
                        </div>
                    )
                }

                {/* Message input — hidden in collection view (read-only) and on
                    checklist channels / the All-checklists board (they have their
                    own add-item input, so a chat composer would be dead weight). */}
                {/* Live peer-to-peer transfers with THIS person. Kept out of the
                    message list on purpose: a transfer is a live handshake, not
                    something stored in history. DMs only — a channel-wide send
                    would be N uploads from one uplink (plan §6). */}
                {/* Transfers are NOT rendered here any more. They live in the
                    app-wide tray near the root of this component: mounting them
                    inside the open DM meant an incoming offer had no Accept
                    button anywhere else in the app, so a recipient who was not
                    already looking at that exact conversation was never told.
                    One surface, so a transfer can never appear twice. */}

                {!currentCollection && !showAllChecklists && !currentChannel?.has_checklist && (
                    <>
                    <ComposerAttachments
                        attachments={pendingAttachments}
                        onRemove={removePendingAttachment}
                        onToggleSpoiler={(id) => setPendingAttachments(prev => toggleChipSpoiler(prev, id))}
                        onRetry={retryUpload}
                    />
                    <form className={`message-form ${canSendHere ? '' : 'composer-disabled'}`} onSubmit={handleSend}>
                        <label className="file-upload-btn" title="Attach file">
                            <PaperclipIcon />
                            <input
                                type="file"
                                style={{ display: 'none' }}
                                disabled={!canSendHere}
                                onChange={async (e) => {
                                    const file = e.target.files?.[0];
                                    if (!file) return;
                                    // THE HYBRID (plan §1). Small files take the
                                    // server path: stored, collectable later,
                                    // works everywhere. Anything over the upload
                                    // cap goes peer-to-peer instead of simply
                                    // being refused — uncapped, but it needs the
                                    // other person online right now.
                                    // Your OWN conversation is included on
                                    // purpose: PC -> phone is the main reason to
                                    // move something large peer-to-peer. The
                                    // server routes that by CONNECTION, so the
                                    // offer lands on your other device rather
                                    // than echoing back here; it refuses with a
                                    // clear reason if nothing else is signed in.
                                    if (p2pOn
                                        && currentDM
                                        && file.size > MAX_UPLOAD_BYTES) {
                                        e.target.value = '';
                                        const toSelf = currentDM.other_user_id === currentUserId;
                                        void fileTransferManager.offerFile(
                                            currentDM.other_user_id,
                                            toSelf ? 'your other device' : (currentDM.other_username || 'them'),
                                            file,
                                        );
                                        return;
                                    }
                                    // E2EE: encrypt the bytes client-side; the key rides inside the
                                    // (encrypted) message, so the server only stores ciphertext.
                                    // Chip-first: the upload runs in the background.
                                    enqueueUpload(file);
                                    e.target.value = ''; // Reset input
                                }}
                            />
                        </label>
                        {/* Task mode toggle button */}
                        <button
                            type="button"
                            className={`task-mode-btn ${isTaskMode ? 'active' : ''}`}
                            onClick={() => setIsTaskMode(prev => !prev)}
                            title={isTaskMode ? 'Task mode ON - click to disable' : 'Click to create a task'}
                            disabled={!canSendHere}
                        >
                            <CheckboxCheckedIcon />
                        </button>
                        <div className="input-wrapper">
                            <textarea
                                ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                                className="message-textarea"
                                disabled={!canSendHere}
                                value={input}
                                onChange={(e) => {
                                    handleInputChange(e.target.value);
                                    detectAutocomplete(e.target.value, e.target.selectionStart);
                                    // Auto-grow up to a max height.
                                    const el = e.target;
                                    el.style.height = 'auto';
                                    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
                                }}
                                onKeyUp={(e) => detectAutocomplete(e.currentTarget.value, e.currentTarget.selectionStart)}
                                onClick={(e) => detectAutocomplete(e.currentTarget.value, e.currentTarget.selectionStart)}
                                onKeyDown={(e) => {
                                    // Autocomplete navigation takes priority over send.
                                    if (autocomplete && autocompleteItems.length > 0) {
                                        if (e.key === 'ArrowDown') { e.preventDefault(); setAutocomplete(a => a && { ...a, index: (a.index + 1) % autocompleteItems.length }); return; }
                                        if (e.key === 'ArrowUp') { e.preventDefault(); setAutocomplete(a => a && { ...a, index: (a.index - 1 + autocompleteItems.length) % autocompleteItems.length }); return; }
                                        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyAutocomplete(autocompleteItems[autocomplete.index]); return; }
                                        if (e.key === 'Escape') { e.preventDefault(); setAutocomplete(null); return; }
                                    }
                                    // Enter sends; Shift+Enter inserts a newline (the familiar chat-app convention).
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        handleSend(e as unknown as FormEvent);
                                        // reset height after send
                                        const el = e.currentTarget;
                                        requestAnimationFrame(() => { el.style.height = 'auto'; });
                                    }
                                }}
                                placeholder={!canSendHere
                                    ? 'Read-only channel'
                                    : currentDM
                                        ? `Message @${currentDM.other_username}`
                                        : `Message #${currentChannel?.name || ''}`}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    setFormatMenu({ x: e.clientX, y: e.clientY });
                                }}
                                onPaste={(e) => {
                                    const items = e.clipboardData?.items;
                                    if (!items) return;
                                    // A pasted image becomes a chip directly —
                                    // its thumbnail IS the preview, and the
                                    // spoiler toggle lives on the chip. (This
                                    // replaced the paste-preview modal.)
                                    for (const item of items) {
                                        if (item.type.startsWith('image/')) {
                                            e.preventDefault();
                                            const file = item.getAsFile();
                                            if (file) enqueueUpload(file);
                                            break;
                                        }
                                    }
                                    // Non-image FILES pasted from the OS used to be
                                    // silently ignored — same chip path as the picker.
                                    const pastedFiles = Array.from(e.clipboardData?.files ?? [])
                                        .filter(f => !f.type.startsWith('image/'));
                                    if (pastedFiles.length > 0) {
                                        e.preventDefault();
                                        for (const file of pastedFiles) enqueueUpload(file);
                                    }
                                }}
                                rows={1}
                            />
                            {autocomplete && autocompleteItems.length > 0 && (
                                <div className="composer-autocomplete">
                                    <div className="autocomplete-header">
                                        {autocomplete.type === 'user' ? 'MEMBERS' : 'CHANNELS'}
                                    </div>
                                    {(autocompleteItems as Array<{ id: number; username?: string; display_name?: string; server_nickname?: string; top_role_color?: string; name?: string }>).map((item, i) => (
                                        <div
                                            key={autocomplete.type === 'user' ? item.id : item.id}
                                            className={`autocomplete-item ${i === autocomplete.index ? 'active' : ''}`}
                                            onMouseEnter={() => setAutocomplete(a => a && { ...a, index: i })}
                                            onMouseDown={(e) => { e.preventDefault(); applyAutocomplete(item); }}
                                        >
                                            {autocomplete.type === 'user' ? (
                                                <>
                                                    <span className="ac-avatar" style={{ background: item.top_role_color || undefined }}>
                                                        {(item.server_nickname || item.display_name || item.username || '')[0]?.toUpperCase()}
                                                    </span>
                                                    <span className="ac-name">{item.server_nickname || item.display_name || item.username}</span>
                                                    <span className="ac-sub">@{item.username}</span>
                                                </>
                                            ) : (
                                                <>
                                                    <span className="ac-hash">#</span>
                                                    <span className="ac-name">{item.name}</span>
                                                </>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="emoji-picker-wrapper" style={{ position: 'relative' }}>
                            <button
                                type="button"
                                className="emoji-toggle"
                                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                                title="Insert emoji"
                                disabled={!canSendHere}
                            >
                                <SmileIcon />
                            </button>
                            {showEmojiPicker && (
                                <div className="emoji-picker-anchor">
                                    <EmojiPicker
                                        onSelect={(emoji) => {
                                            setInput(prev => prev + emoji);
                                            setShowEmojiPicker(false);
                                            inputRef.current?.focus();
                                        }}
                                        onClose={() => setShowEmojiPicker(false)}
                                    />
                                </div>
                            )}
                        </div>
                        {/* aria-label because mobile hides the text label and
                            shows only the icon (mobile.css). Disabled while an
                            attachment uploads — sending then would drop it
                            (handleSend guards the Enter path the same way). */}
                        <button
                            type="submit"
                            disabled={!canSendHere || pendingAttachments.some(a => a.status === 'uploading')}
                            title={pendingAttachments.some(a => a.status === 'uploading') ? 'Waiting for the upload to finish' : undefined}
                            aria-label="Send message"
                        >
                            <SendIcon className="send-icon" />
                            <span className="send-label">Send</span>
                        </button>
                    </form>
                    </>
                )}

                {/* Format Context Menu */}
                {
                    formatMenu && (
                        <div
                            className="format-menu"
                            style={(() => {
                                // The composer sits at the bottom, so a menu
                                // anchored by its top gets clipped. Open it
                                // UPWARD when there isn't room below, and clamp
                                // to the viewport so it's never cut off.
                                const MARGIN = 8;
                                const W = 180, H = 220; // generous menu bounds
                                const left = Math.max(MARGIN, Math.min(formatMenu.x, window.innerWidth - W - MARGIN));
                                return formatMenu.y + H > window.innerHeight
                                    ? { left, bottom: window.innerHeight - formatMenu.y }
                                    : { left, top: formatMenu.y };
                            })()}
                            onClick={() => setFormatMenu(null)}
                        >
                            <button onClick={() => wrapSelection('**', '**')}>
                                <b>B</b> Bold
                            </button>
                            <button onClick={() => wrapSelection('*', '*')}>
                                <i>I</i> Italic
                            </button>
                            <button onClick={() => wrapSelection('~~', '~~')}>
                                <s>S</s> Strikethrough
                            </button>
                            <button onClick={() => wrapSelection('||', '||')}>
                                <LockIcon /> Spoiler
                            </button>
                            <button onClick={() => wrapSelection('`', '`')}>
                                &lt;&gt; Code
                            </button>
                        </div>
                    )
                }

            </main>

            {/* Right Sidebar - Member List. Hidden while the checklist panel is
                open (side by side they crush the chat column), and in the
                home/DM view (currentServer null → no members to list). */}
            {!showChecklist && currentServer && (
            <aside className="member-sidebar">
                {/* Online Members */}
                <div className="member-section">
                    <h4 className="member-section-title">Online — {onlineMembers.length}</h4>
                    <ul className="member-list">
                        {onlineMembers.map(member => {
                            // Check if member is in current voice channel
                            const isInVoice = currentVoiceChannel
                                ? getVoiceUsersInRoom(`voice_${currentVoiceChannel.id}`).some(u => u.id === member.id)
                                : false;
                            return (
                                <li
                                    key={member.id}
                                    className="member-item online clickable"
                                    onClick={(e) => {
                                        setPopupPosition({ x: e.clientX, y: e.clientY });
                                        setSelectedMember(member);
                                    }}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        setUserContextMenuTarget({
                                            userId: member.id,
                                            username: member.username,
                                            isInVoice,
                                            position: { x: e.clientX, y: e.clientY }
                                        });
                                    }}
                                >
                                    <div className="member-avatar" style={{ borderColor: member.top_role_color }}>
                                        <span>{avatarInitial(member.server_nickname, member.display_name, member.username)}</span>
                                        {/* Sits on top of the initial; broken/hidden falls back to it. */}
                                        <SmartAvatar
                                            userId={member.id}
                                            fileId={member.avatar_file_id}
                                            fallback={null}
                                        />
                                        <div className="status-dot online"></div>
                                    </div>
                                    <span className="member-name" style={{ color: member.top_role_color }}>
                                        {member.is_owner && <span className="owner-crown" title="Server Owner"><CrownIcon /></span>}
                                        {member.server_nickname || member.display_name || member.username}
                                    </span>
                                    {/* The crown already marks the owner; an "Owner" role chip
                                        next to it is redundant (visible since migration 042
                                        backfilled the bootstrap Owner role as their top role). */}
                                    {member.roles.length > 0 && !member.roles[0]?.is_default
                                        && !(member.is_owner && member.roles[0]?.name === 'Owner') && (
                                        <span className="member-role-badge" style={{ backgroundColor: member.top_role_color }}>
                                            {member.roles[0]?.name}
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>

                {/* Offline Members */}
                {offlineMembers.length > 0 && (
                    <div className="member-section">
                        <h4 className="member-section-title">Offline — {offlineMembers.length}</h4>
                        <ul className="member-list">
                            {offlineMembers.map(member => (
                                <li
                                    key={member.id}
                                    className="member-item offline clickable"
                                    onClick={(e) => {
                                        setPopupPosition({ x: e.clientX, y: e.clientY });
                                        setSelectedMember(member);
                                    }}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        setUserContextMenuTarget({
                                            userId: member.id,
                                            username: member.username,
                                            isInVoice: false, // Offline users are never in voice
                                            position: { x: e.clientX, y: e.clientY }
                                        });
                                    }}
                                >
                                    <div className="member-avatar">
                                        <span>{avatarInitial(member.server_nickname, member.display_name, member.username)}</span>
                                        <div className="status-dot offline"></div>
                                    </div>
                                    <span className="member-name">
                                        {member.is_owner && <span className="owner-crown" title="Server Owner"><CrownIcon /></span>}
                                        {member.username}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </aside>
            )}

            {/* Context Menu */}
            {contextMenu && (
                <ContextMenu
                    items={contextMenu.items}
                    position={contextMenu.position}
                    onClose={hideContextMenu}
                />
            )}

            {/* Portaled to <body>, so its position here doesn't matter.
                Keyed on seq so a repeat of the same message remounts and
                restarts the countdown instead of silently doing nothing. */}
            {toast && (
                <Toast key={toast.seq} message={toast.text} onDismiss={() => setToast(null)} />
            )}

            {/* In-app message shade stack (also portaled). Always mounted so
                pushMessageToast from the WS handlers has a sink. */}
            <MessageToasts />

            {/* Forward Message Modal */}
            {forwardingContent !== null && (
                <ForwardModal
                    content={forwardingContent}
                    servers={servers}
                    dmConversations={dmConversations}
                    onClose={() => setForwardingContent(null)}
                    onSentToChannel={(channelId, messageId, text) => {
                        // The ChatMessage handler now consumes our own echoes
                        // (deduped by message id), but this append still covers
                        // the collection view, whose subchannels are not the
                        // handler's roomId. On screen means the open single
                        // channel OR — in collection view — any subchannel of
                        // the open collection (stamp channelId/channelName so
                        // the collection header groups it). Other targets
                        // render on switch.
                        if (!currentUser) return;
                        const inCollection = currentCollection != null &&
                            channels.some(c => c.id === channelId && c.parent_id === currentCollection.id);
                        if (currentChannel?.id !== channelId && !inCollection) return;
                        const targetName = channels.find(c => c.id === channelId)?.name;
                        setMessages(prev => prev.some(m => m.id === messageId) ? prev : [...prev, {
                            id: messageId,
                            sender: { id: currentUserId, username: currentUser.username },
                            content: text,
                            timestamp: Date.now() / 1000,
                            ...(inCollection ? { channelId, channelName: targetName } : {}),
                        }]);
                    }}
                />
            )}

            {/* Edit Channel Modal */}
            {editingChannel && (
                <EditChannelModal
                    isOpen={!!editingChannel}
                    onClose={() => setEditingChannel(null)}
                    channel={editingChannel}
                    collections={channels.filter(c => c.channel_type === 2)}
                    onChannelUpdated={(updated) => {
                        // Optimistic update
                        queryClient.setQueryData(keys.channels(currentServer?.id || ''), (old: Channel[] | undefined) => {
                            if (!old) return old;
                            return old.map(c => c.id === updated.id ? updated : c);
                        });
                    }}
                />
            )}

            {/* Channel Checklist Panel */}
            {currentChannel && (
                <ChecklistPanel
                    channelId={currentChannel.id}
                    isOpen={showChecklist}
                    onClose={() => setShowChecklist(false)}
                    myPerms={currentChannel.my_permissions}
                    currentUserId={currentUserId}
                    resolveUserName={resolveMemberName}
                />
            )}

            {/* Welcome Popup for New Users (first run only — see welcome_seen) */}
            {showWelcomePopup && (
                <WelcomePopup
                    onCreateServer={() => {
                        localStorage.setItem('welcome_seen', '1');
                        setShowWelcomePopup(false);
                        setShowServerModal(true);
                    }}
                    onJoinServer={() => {
                        localStorage.setItem('welcome_seen', '1');
                        setShowWelcomePopup(false);
                        setShowJoinModal(true);
                    }}
                    onDismiss={() => {
                        localStorage.setItem('welcome_seen', '1');
                        setShowWelcomePopup(false);
                    }}
                />
            )}

            {/* PiP Stream overlay - shows when viewing chat but streams are active */}
            {showPip && viewMode === 'chat' && (
                <StreamPip
                    onExpand={() => {
                        setShowPip(false);
                        setViewMode('stream');
                    }}
                    onClose={() => setShowPip(false)}
                    poppedStreams={poppedStreams}
                    onTogglePopout={togglePopout}
                    // While the Doc-PiP grid is up the in-app float would be a
                    // redundant SECOND copy of the same streams — but its
                    // <video> is the chat-view AUDIO PATH, so it stays MOUNTED
                    // and merely invisible. Unmounting it silences every
                    // stream the moment the grid opens.
                    hidden={usingDocPip && poppedStreams.length > 0}
                />
            )}

            {/* OS-level picture-in-picture host. Deliberately a SIBLING of the
                block above and NOT behind any viewMode gate: StreamStage and
                StreamPip both destroy their <video> on navigation and Chromium
                closes the PiP window when its element leaves the document —
                this host is what lets the popped-out stream survive chat ↔
                stream ↔ DM navigation. Moving it inside a viewMode condition
                would kill the window on every click. */}
            {poppedStreams.length > 0 && (usingDocPip ? (
                <StreamDocPipWindow
                    userIds={poppedStreams}
                    onCloseOne={id => setPoppedStreams(l => l.filter(x => x !== id))}
                    onCloseAll={() => setPoppedStreams([])}
                    onFallback={() => {
                        // requestWindow rejected: latch to the legacy engine
                        // and keep the FIRST pick (the one the user asked for
                        // before anything could have failed).
                        setDocPipFailed(true);
                        setPoppedStreams(l => l.slice(0, 1));
                    }}
                />
            ) : (
                <StreamPopout
                    key={poppedStreams[0]}
                    userId={poppedStreams[0]}
                    onClose={() => setPoppedStreams([])}
                />
            ))}

            {/* Floating 'Watch Live' button - shows when there are streamers but user isn't watching */}
            {(() => {
                const streamers = getAllStreamers();
                const selectedCount = getSelectedStreams().length;
                const hasUnwatchedStreams = streamers.length > 0 && selectedCount === 0 && viewMode === 'chat';
                if (!hasUnwatchedStreams) return null;

                return (
                    <div className="watch-live-floating">
                        <button
                            className="watch-live-btn"
                            onClick={() => {
                                // Select all available streams
                                streamers.forEach(s => selectStream(s.userId));
                                setViewMode('stream');
                            }}
                        >
                            <span className="live-indicator-dot"></span>
                            <ScreenShareIcon /> {streamers.length} Live Stream{streamers.length > 1 ? 's' : ''} — Click to Watch
                        </button>
                    </div>
                );
            })()}
            {/* Mobile Bottom Navigation */}
            {isMobile && (
                <nav className="mobile-bottom-nav">
                    <button
                        className={`mobile-nav-btn ${mobilePanel === 'servers' && !showDevicesView ? 'active' : ''}`}
                        onClick={() => {
                            // The checklist drawer is a persistent overlay (fixed, above
                            // every panel) so it stays reachable regardless of which panel
                            // is active — but that means it lingers on top of whatever the
                            // user navigates to next unless explicitly closed here.
                            setShowChecklist(false);
                            // Devices holds mobilePanel at 'servers' while open, so this
                            // tab must also CLOSE it or the tap looks like a no-op.
                            if (showDevicesView) { leaveDevicesView('servers'); return; }
                            setMobilePanel('servers');
                        }}
                    >
                        <span className="nav-icon"><HomeIcon size={20} /></span>
                        <span className="nav-label">Servers</span>
                    </button>
                    <button
                        className={`mobile-nav-btn ${mobilePanel === 'channels' ? 'active' : ''}`}
                        onClick={() => {
                            setShowChecklist(false);
                            if (showDevicesView) { leaveDevicesView('channels'); return; }
                            setMobilePanel('channels');
                        }}
                    >
                        <span className="nav-icon"><ChannelsIcon size={20} /></span>
                        <span className="nav-label">Channels</span>
                    </button>
                    <button
                        className={`mobile-nav-btn ${mobilePanel === 'chat' && !showFriendsPanel && !showDevicesView ? 'active' : ''}`}
                        onClick={() => {
                            // Also LEAVE the Devices view: it renders in this
                            // slot, so without closing it "Chat" highlights
                            // itself and shows the device grid.
                            if (showDevicesView) { leaveDevicesView('chat'); return; }
                            setMobilePanel('chat');
                        }}
                    >
                        <span className="nav-icon"><ChatIcon size={20} /></span>
                        <span className="nav-label">Chat</span>
                    </button>
                    <button
                        className={`mobile-nav-btn ${mobilePanel === 'members' ? 'active' : ''}`}
                        onClick={() => {
                            setShowChecklist(false);
                            if (showDevicesView) { leaveDevicesView('members'); return; }
                            setMobilePanel('members');
                        }}
                    >
                        <span className="nav-icon"><MembersIcon size={20} /></span>
                        <span className="nav-label">Members</span>
                    </button>
                    {/* Tasks sits BETWEEN the panel tabs and Devices (field
                        request 2026-08-11: Devices takes the far-right slot).
                        It opens an overlay view, not a panel in the swipe run
                        (servers↔channels↔chat↔members↔devices) — button order
                        here is presentation only and doesn't affect swipes. */}
                    <button
                        className={`mobile-nav-btn ${showFriendsPanel && friendsTab === 'tasks' ? 'active' : ''}`}
                        onClick={() => { setShowChecklist(false); openTasksView(); }}
                    >
                        <span className="nav-icon"><TasksIcon size={20} /></span>
                        <span className="nav-label">Tasks</span>
                    </button>
                    <button
                        className={`mobile-nav-btn ${showDevicesView ? 'active' : ''}`}
                        onClick={() => {
                            setShowChecklist(false);
                            setShowFriendsPanel(false);
                            setShowDevicesView(true);
                            // THE SERVERS SLOT, matching the rail's onOpenDevices:
                            // DevicesView anchors at left:72px beside the rail and
                            // its sidebar-eviction CSS keys on 'servers'.
                            setMobilePanel('servers');
                        }}
                    >
                        <span className="nav-icon"><MonitorIcon size={20} /></span>
                        <span className="nav-label">Devices</span>
                    </button>
                </nav>
            )}

            {/* Mobile Panel Overlay - tap to close panel */}
            {isMobile && mobilePanel !== 'chat' && (
                <div
                    className="mobile-panel-overlay"
                    onClick={() => setMobilePanel('chat')}
                />
            )}

            {/* Camera is now handled in VoicePanel - these old components have been removed */}
        </div>
    );
}
