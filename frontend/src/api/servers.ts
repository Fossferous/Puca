import { apiClient } from './client';

// --- Types ---

export interface Server {
    id: string;
    name: string;
    owner_id: number;
    created_at: string;
    icon_file_id?: string | null;
    is_public?: boolean;
    description?: string | null;
    /** Server-admin policy: clients require media E2EE for calls in this server. */
    require_media_e2ee?: boolean;
    /** Clips (docs/CLIPS.md). ALL THREE absent ⇒ a pre-Clips server: the client
     *  treats clips as unavailable there (clipsAvailable() checks `=== true`). */
    clips_enabled?: boolean;
    /** Longest clip in seconds (60..600). */
    clip_max_seconds?: number;
    /** Pinned target text channel, or null = the clipper picks. */
    clip_channel_id?: number | null;
    /** Minutes of inactivity before a voice member is moved to the AFK
     *  channel — Discord's option set (1|5|15|30|60). Absent ⇒ the backend
     *  predates the setting; clients fall back to the old fixed 15. */
    afk_timeout_minutes?: number;
}

export interface Channel {
    id: number;
    name: string;
    channel_type: number; // 0 = Text, 1 = Voice
    server_id: string | null;
    description?: string | null;
    parent_id?: number | null;
    slowmode_seconds?: number;
    /** AFK voice channel: members can't transmit; idle users get moved here. */
    is_afk?: boolean;
    /** Checklist channel: a text channel whose main view is a Keep-style checklist. */
    has_checklist?: boolean;
    /** Tier-2 SFU voice channel: joins use LiveKit instead of the P2P mesh. */
    sfu_mode?: boolean;
    /** Resolved effective permission bits for the requesting user (see api/permissionBits.ts). */
    my_permissions?: number;
}

export interface FeedMessage {
    id: string;
    channel_id: number;
    user_id: number;
    username: string;
    display_name?: string | null;
    content: string;
    created_at: string;
}

interface ChannelFeedChild {
    id: number;
    name: string;
    messages: FeedMessage[];
}

export interface ChannelFeedResponse {
    id: number;
    children: ChannelFeedChild[];
}

export interface Message {
    id: string;
    channel_id: number;
    user_id: number;
    username: string;
    display_name?: string | null;
    content: string;
    created_at: string;
    reply_to_id?: string; // For message threading
    reply_to?: Message; // Populated for display
    // Task message fields
    is_task?: boolean;
    is_completed?: boolean;
    parent_message_id?: string;
    key_epoch?: number | null; // E2EE channel-key epoch (null/undefined = plaintext)
    /** How this message's content relates to E2EE, set by decryptChannelMessages.
     *  `legacy` (plaintext passthrough) is the one the UI must flag — see H-1. */
    encState?: MessageEncState;
    /** Server-stamped consent record on a CLIP post (docs/CLIPS.md): a count and
     *  the uploaded part ids, never identities. Absent on every other message. */
    clip_consent?: ClipConsent | null;
}

/** `messages.clip_consent` as the server stamps it (message_handlers.rs). */
export interface ClipConsent {
    proposal_id: string;
    approver_count: number;
    part_file_ids: string[];
    solo: boolean;
}

// --- Server API ---

export function createServer(name: string): Promise<{ id: string; name: string }> {
    return apiClient.post('/servers', { name });
}

export function listServers(): Promise<Server[]> {
    return apiClient.get('/servers');
}

export function joinServer(serverId: string): Promise<void> {
    return apiClient.post(`/servers/${serverId}/join`);
}

export function leaveServer(serverId: string): Promise<void> {
    return apiClient.post(`/servers/${serverId}/leave`);
}

export function deleteServer(serverId: string): Promise<void> {
    return apiClient.delete(`/servers/${serverId}`);
}

// --- Channel API ---

export function listChannels(serverId: string): Promise<Channel[]> {
    return apiClient.get(`/servers/${serverId}/channels`);
}

export function createChannel(serverId: string, name: string, channelType: number = 0, parentId?: number, isAfk?: boolean, hasChecklist?: boolean): Promise<Channel> {
    return apiClient.post(`/servers/${serverId}/channels`, { name, channel_type: channelType, parent_id: parentId, is_afk: isAfk, has_checklist: hasChecklist });
}

export function deleteChannel(channelId: number): Promise<void> {
    return apiClient.delete(`/channels/${channelId}`);
}

export function updateChannel(channelId: number, updates: { name?: string; description?: string; parent_id?: number | null; slowmode_seconds?: number; is_afk?: boolean; has_checklist?: boolean; sfu_mode?: boolean }): Promise<void> {
    return apiClient.patch(`/channels/${channelId}`, updates);
}

/** Persist the caller's personal server-rail order (per-user, cross-device). */
export function reorderServers(serverIds: string[]): Promise<void> {
    return apiClient.patch('/servers/reorder', { server_ids: serverIds });
}

export function reorderChannels(serverId: string, channelIds: number[]): Promise<void> {
    return apiClient.post(`/servers/${serverId}/channels/reorder`, { channel_ids: channelIds });
}

export function getChannelFeed(channelId: number): Promise<ChannelFeedResponse> {
    return apiClient.get(`/channels/${channelId}/feed`);
}

// --- Message API ---

export function getMessages(channelId: number, limit: number = 50, before?: string): Promise<Message[]> {
    const beforeParam = before ? `&before=${encodeURIComponent(before)}` : '';
    return apiClient.get(`/channels/${channelId}/messages?limit=${limit}${beforeParam}`);
}

function sendMessage(channelId: number, content: string, replyToId?: string, isTask: boolean = false, keyEpoch?: number | null, clipId?: string): Promise<{ id: string; clip_consent?: ClipConsent }> {
    // `clip_id` is only ever present on a clip post — every other send stays
    // byte-identical to what a pre-Clips client sends.
    return apiClient.post(`/channels/${channelId}/messages`, { content, reply_to_id: replyToId, is_task: isTask, key_epoch: keyEpoch ?? null, ...(clipId ? { clip_id: clipId } : {}) });
}

export function toggleTaskCompletion(channelId: number, messageId: string): Promise<{ id: string; is_completed: boolean }> {
    return apiClient.post(`/channels/${channelId}/messages/${messageId}/toggle-task`, {});
}

export function editMessage(channelId: number, messageId: string, content: string): Promise<void> {
    return apiClient.patch(`/channels/${channelId}/messages/${messageId}`, { content });
}

export function deleteMessage(channelId: number, messageId: string): Promise<void> {
    return apiClient.delete(`/channels/${channelId}/messages/${messageId}`);
}

// --- Invite System Types ---

export interface Invite {
    code: string;
    server_id: string;
    server_name: string;
    uses: number;
    max_uses: number | null;
    expires_at: string | null;
    created_at: string;
}

export interface InviteInfo {
    code: string;
    server_id: string;
    server_name: string;
    member_count: number;
}

export interface PublicServer {
    id: string;
    name: string;
    description: string | null;
    member_count: number;
}

// --- Invite API ---

export function createInvite(
    serverId: string,
    options: { max_uses?: number; expires_in_hours?: number } = {}
): Promise<Invite> {
    return apiClient.post(`/servers/${serverId}/invites`, options);
}

export function getInviteInfo(code: string): Promise<InviteInfo> {
    // Note: This endpoint is public, but apiClient handles auth token optionally. 
    // It's safe to use apiClient even if unauthenticated, headers will just lack Authorization.
    // However, explicit content-type is good.
    return apiClient.get(`/invites/${code}`);
}

export function joinViaInvite(code: string): Promise<Server> {
    return apiClient.post(`/invites/${code}/join`);
}

export function listInvites(serverId: string): Promise<Invite[]> {
    return apiClient.get(`/servers/${serverId}/invites`);
}

export function deleteInvite(serverId: string, code: string): Promise<void> {
    return apiClient.delete(`/servers/${serverId}/invites/${code}`);
}

// --- Discovery API ---

export function listPublicServers(): Promise<PublicServer[]> {
    return apiClient.get('/discover');
}

export function updateServerSettings(
    serverId: string,
    settings: { name?: string; is_public?: boolean; description?: string; icon_file_id?: string; require_media_e2ee?: boolean; clips_enabled?: boolean; clip_max_seconds?: number; clip_channel_id?: number; afk_timeout_minutes?: number }
): Promise<void> {
    return apiClient.patch(`/servers/${serverId}/settings`, settings);
}

// --- Role System ---

export interface Role {
    id: number;
    server_id: string;
    name: string;
    color: string;
    permissions: number;
    position: number;
    is_default: boolean;
}

export interface MemberWithRoles {
    id: number;
    username: string;
    display_name?: string | null;
    server_nickname?: string | null;
    is_online: boolean;
    roles: Role[];
    top_role_color: string;
    is_owner: boolean;
    avatar_file_id?: string | null;
    /** Custom join/leave clips — already NULLED server-side when the member's
     *  custom sounds are disabled, so consumers can use them blindly. */
    join_sound_file_id?: string | null;
    leave_sound_file_id?: string | null;
    /** Moderation state (visible to everyone; only MUTE_MEMBERS can change it). */
    custom_sounds_disabled: boolean;
}

/** Admin toggle: silence (or restore) one member's custom join/leave clips
 *  for everyone in this server. Requires MUTE_MEMBERS. */
export function setMemberCustomSoundsDisabled(
    serverId: string,
    userId: number,
    disabled: boolean
): Promise<void> {
    return apiClient.put(`/servers/${serverId}/custom-sounds/${userId}`, { disabled });
}

export function listRoles(serverId: string): Promise<Role[]> {
    return apiClient.get(`/servers/${serverId}/roles`);
}

export function createRole(
    serverId: string,
    role: { name: string; color?: string; permissions?: number }
): Promise<Role> {
    return apiClient.post(`/servers/${serverId}/roles`, role);
}

export function updateRole(
    serverId: string,
    roleId: number,
    updates: { name?: string; color?: string; permissions?: number; position?: number }
): Promise<void> {
    return apiClient.patch(`/servers/${serverId}/roles/${roleId}`, updates);
}

export function deleteRole(serverId: string, roleId: number): Promise<void> {
    return apiClient.delete(`/servers/${serverId}/roles/${roleId}`);
}

export function assignRole(serverId: string, userId: number, roleId: number): Promise<void> {
    return apiClient.put(`/servers/${serverId}/members/${userId}/roles/${roleId}`);
}

export function removeRole(serverId: string, userId: number, roleId: number): Promise<void> {
    return apiClient.delete(`/servers/${serverId}/members/${userId}/roles/${roleId}`);
}

export function listMembersWithRoles(serverId: string): Promise<MemberWithRoles[]> {
    return apiClient.get(`/servers/${serverId}/members-with-roles`);
}

/**
 * Set or clear server nickname (for /nick command)
 */
export function setServerNickname(serverId: string, nickname: string | null): Promise<{ nickname: string | null }> {
    return apiClient.post(`/servers/${serverId}/nickname`, { nickname });
}

// --- Kick/Ban API ---

export function kickMember(serverId: string, userId: number, reason?: string): Promise<void> {
    return apiClient.post(`/servers/${serverId}/kick/${userId}`, { reason });
}

export function banMember(serverId: string, userId: number, reason?: string): Promise<void> {
    return apiClient.post(`/servers/${serverId}/bans/${userId}`, { reason });
}

/**
 * Move a member into another voice channel, or — with `channelId: null` —
 * disconnect them from voice.
 *
 * Requires MOVE_MEMBERS. Writes no rows: the member keeps their server
 * membership and can rejoin immediately, which is what separates this from
 * `kickMember`.
 */
export function moveMemberVoice(serverId: string, userId: number, channelId: number | null): Promise<void> {
    return apiClient.post(`/servers/${serverId}/voice-move/${userId}`, { channel_id: channelId });
}

export function unbanMember(serverId: string, userId: number): Promise<void> {
    return apiClient.delete(`/servers/${serverId}/bans/${userId}`);
}

export interface Ban {
    user_id: number;
    username: string;
    reason: string | null;
    banned_at: string;
}

export function listBans(serverId: string): Promise<Ban[]> {
    return apiClient.get(`/servers/${serverId}/bans`);
}

// --- Message Pinning ---

export interface PinnedMessage {
    id: string;
    channel_id: number;
    user_id: number;
    username: string;
    display_name?: string | null;
    content: string;
    created_at: string;
    pinned_at: string;
}

export function pinMessage(channelId: number, messageId: string): Promise<void> {
    return apiClient.post(`/channels/${channelId}/messages/${messageId}/pin`);
}

export function unpinMessage(channelId: number, messageId: string): Promise<void> {
    return apiClient.delete(`/channels/${channelId}/messages/${messageId}/pin`);
}

export function listPinnedMessages(channelId: number): Promise<PinnedMessage[]> {
    return apiClient.get(`/channels/${channelId}/pins`);
}

// --- E2EE Channel Message Support (group keys) ---

import {
    serializeEnvelope,
    encryptChannelMessage,
    decryptChannelMessage as decryptWithChannelKey,
    parseEnvelopeEx,
    SecureSendError,
    messageEncState,
    type MessageEncState,
} from './e2ee';
import { ensureChannelKey, getChannelKeyForEpoch } from './channelKeys';
import { ENC_KEY_UNAVAILABLE, ENC_CANNOT_DECRYPT, ENC_CONTEXT_MISMATCH, ENC_UNSUPPORTED_VERSION } from './decryptMarkers';
import { currentUserIdFromToken } from './auth';

/**
 * Encrypt and send a channel message under the channel's group key.
 *
 * FAIL CLOSED (audit H4): if no channel key is available (no identity, or we're
 * a new member nobody has wrapped the current key for yet), we THROW a
 * SecureSendError instead of sending plaintext — the E2EE promise is never
 * silently downgraded. Callers surface the message and block the send.
 *
 * Returns the wire envelope that was sent so the caller can broadcast the
 * identical bytes over WebSocket for realtime delivery.
 */
export async function sendChannelMessageEncrypted(
    channelId: number,
    content: string,
    replyToId?: string,
    isTask: boolean = false,
    /** Approved clip proposal id (docs/CLIPS.md): the server verifies it and
     *  stamps `clip_consent`; the caller renders the badge from the response. */
    clipId?: string
): Promise<{ id: string; wireContent: string; keyEpoch: number; clipConsent?: ClipConsent }> {
    console.debug(`[e2ee] send(${channelId}): ensuring channel key`);
    const keyInfo = await ensureChannelKey(channelId);
    if (!keyInfo) {
        throw new SecureSendError("Can't send securely — this channel's encryption key isn't available yet. Try again in a moment.");
    }
    console.debug(`[e2ee] send(${channelId}): encrypting under epoch ${keyInfo.epoch}`);
    // The context the reader will recompute: this channel, the CURRENT epoch
    // (the same value that goes into the envelope — never the row's stale
    // key_epoch on an edit), and me as the author.
    const me = currentUserIdFromToken();
    if (me === null) throw new SecureSendError("Can't send securely — you appear to be signed out. Sign in again.");
    const env = await encryptChannelMessage(keyInfo.key, keyInfo.epoch, content, { kind: 'chan-msg', channelId, senderId: me });
    const wireContent = serializeEnvelope(env);
    const res = await sendMessage(channelId, wireContent, replyToId, isTask, keyInfo.epoch, clipId);
    return { id: res.id, wireContent, keyEpoch: keyInfo.epoch, clipConsent: res.clip_consent };
}

/**
 * Encrypt and PATCH an edit to a channel message under the CURRENT channel-key
 * epoch — the same path a fresh send uses (audit H3). Without this, edits went
 * out as cleartext, defeating E2EE for any edited message. The epoch travels
 * INSIDE the envelope, so readers decrypt with the right key even though the
 * edit endpoint only persists `content` (a backend change to also store
 * `key_epoch` on edit would be nice-to-have, not required for correctness).
 *
 * FAIL CLOSED like the send path: throws SecureSendError if no key is available.
 */
export async function editChannelMessageEncrypted(
    channelId: number,
    messageId: string,
    content: string
): Promise<{ wireContent: string; keyEpoch: number }> {
    const keyInfo = await ensureChannelKey(channelId);
    if (!keyInfo) {
        throw new SecureSendError("Can't save the edit securely — this channel's encryption key isn't available. Try again in a moment.");
    }
    // The context the reader will recompute: this channel, the CURRENT epoch
    // (the same value that goes into the envelope — never the row's stale
    // key_epoch on an edit), and me as the author.
    const me = currentUserIdFromToken();
    if (me === null) throw new SecureSendError("Can't send securely — you appear to be signed out. Sign in again.");
    const env = await encryptChannelMessage(keyInfo.key, keyInfo.epoch, content, { kind: 'chan-msg', channelId, senderId: me });
    const wireContent = serializeEnvelope(env);
    await editMessage(channelId, messageId, wireContent);
    return { wireContent, keyEpoch: keyInfo.epoch };
}

/**
 * Decrypt a single channel message's content. Plaintext (non-envelope) content
 * is returned unchanged so legacy messages still render.
 */
export async function decryptChannelContent(channelId: number, content: string, senderId: number): Promise<string> {
    const parsed = parseEnvelopeEx(content);
    if (parsed.kind === 'unsupported-version') return ENC_UNSUPPORTED_VERSION;
    if (parsed.kind !== 'envelope' || parsed.env.t !== 'ch') return content;
    const env = parsed.env;
    const epoch = env.epoch ?? 0;
    const key = await getChannelKeyForEpoch(channelId, epoch);
    if (!key) return ENC_KEY_UNAVAILABLE;
    const plain = await decryptWithChannelKey(key, env, { kind: 'chan-msg', channelId, senderId });
    if (plain !== null) return plain;
    // Right key, tag fails. For v3 that is the binding doing its job: the
    // row's channel / sender / epoch is not what the author sealed under. No
    // retry under other context — that would make the tag an oracle.
    return env.v === 3 ? ENC_CONTEXT_MISMATCH : ENC_CANNOT_DECRYPT;
}

/** Decrypt an array of channel messages in place, tagging each with its E2EE
 *  state (secure / legacy-plaintext / failed) so the UI can flag passthrough. */
export async function decryptChannelMessages(channelId: number, messages: Message[]): Promise<Message[]> {
    return Promise.all(
        messages.map(async (msg) => {
            const wire = msg.content;
            const text = await decryptChannelContent(channelId, wire, msg.user_id);
            return { ...msg, content: text, encState: messageEncState(wire, text) };
        })
    );
}

// --- Unread Counts ---

export interface ChannelUnreadCount {
    channel_id: number;
    unread_count: number;
}

export interface ServerUnreadCounts {
    channels: ChannelUnreadCount[];
}

/**
 * Mark a channel as read
 */
export function markChannelRead(channelId: number): Promise<void> {
    return apiClient.post(`/channels/${channelId}/read`);
}

/**
 * Mark every channel in a server as read.
 */
export function markServerRead(serverId: string): Promise<void> {
    return apiClient.post(`/servers/${serverId}/read`);
}

/**
 * Get unread counts for all channels in a server
 */
export function getUnreadCounts(serverId: string): Promise<ServerUnreadCounts> {
    return apiClient.get(`/servers/${serverId}/unread`);
}

export interface ServerAggregateUnread {
    server_id: string;
    unread_count: number;
    /** VIEW-permitted per-channel rows behind the total (unread > 0 only).
     *  Absent on pre-0.8.58 backends — consumers must fall back to the
     *  server-level total when missing. */
    channels?: ChannelUnreadCount[];
}

/**
 * Cross-server unread totals (one row per server with anything unread) — the
 * data behind the rail bubbles. Servers with nothing unread are omitted.
 */
export function getAllUnreadCounts(): Promise<{ servers: ServerAggregateUnread[] }> {
    return apiClient.get('/unread');
}

// --- Voice Users State ---

interface VoiceUserInfo {
    room_id: string;
    user_id: number;
    username: string;
}

export interface VoiceUsersResponse {
    voice_users: VoiceUserInfo[];
}

/**
 * Fetch active voice users in a server
 * Called on app load to populate the sidebar with existing voice channel participants
 */
export function fetchVoiceUsers(serverId: string): Promise<VoiceUsersResponse> {
    return apiClient.get(`/servers/${serverId}/voice-users`);
}

// --- Report System ---

export interface Report {
    id: number;
    reporter_id: number;
    reporter_username?: string;
    reported_user_id?: number;
    reported_username?: string;
    reported_message_id?: string;
    report_type: string;
    reason: string;
    status: string;
    resolved_by?: number;
    resolution_notes?: string;
    created_at: string;
    resolved_at?: string;
}

export function listReports(serverId: string, status?: string): Promise<Report[]> {
    const params = status ? `?status=${status}` : '';
    return apiClient.get(`/servers/${serverId}/reports${params}`);
}

export function resolveReport(serverId: string, reportId: number, status: 'resolved' | 'dismissed', notes?: string): Promise<void> {
    return apiClient.patch(`/servers/${serverId}/reports/${reportId}`, { status, notes });
}

// --- Audit Log ---

export interface AuditLogEntry {
    id: number;
    action_type: string;
    actor_id: number;
    actor_username?: string;
    target_id?: number;
    target_type?: string;
    details?: string;
    created_at: string;
}

export function listAuditLog(serverId: string, actionType?: string, limit = 50): Promise<AuditLogEntry[]> {
    const params = new URLSearchParams();
    if (actionType) params.set('action_type', actionType);
    params.set('limit', String(limit));
    return apiClient.get(`/servers/${serverId}/audit-log?${params}`);
}
