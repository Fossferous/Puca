// Voice / screen-share / camera presence + stream-viewing state.
// Extracted from VoicePanel so that component file only exports a component
// (keeps React Fast Refresh working).

import { useStreamStore } from '../stores/streamStore';

export interface VoiceUser {
    id: number;
    username: string;
    isSpeaking?: boolean;
    isConnected?: boolean;
    isMuted?: boolean;
    isDeafened?: boolean;
    avatarFileId?: string | null;
}


// Global map to track who is in voice with their status
export interface VoiceUserStatus {
    id: number;
    username: string;
    isMuted: boolean;
    isDeafened: boolean;
    /** They have a clip replay buffer ARMED: the last few minutes of this call
     *  are being held (encrypted, in memory) on their machine. Rides the same
     *  one-shot __VOICE_STATUS__ ping as mute/deafen, so it MUST be preserved
     *  across a StreamStarted replay for the same reason isDeafened is.
     *  Advisory: a cooperating client asserts it; the approval gate is the
     *  real guarantee (docs/CLIPS.md). */
    isBuffering?: boolean;
    avatarFileId?: string | null;
    /** Roster entry exists but their media is not yet decryptable by us — the
     *  join chime is being held until it is (or until the timeout). Written
     *  only by the in-call VoicePanel; observers outside the call have no
     *  transport state to judge this by, so they never set it. */
    connecting?: boolean;
}
export const globalVoiceUsers = new Map<string, Map<number, VoiceUserStatus>>(); // roomId -> Map of userId -> status

/**
 * Add-or-refresh a roster entry WITHOUT losing what we already know about it.
 *
 * StreamStarted is a REPLAY, not an edge: the server re-asserts it for every
 * existing member whenever anyone joins the room, whenever a socket reconnects
 * (ours or a bystander's) and after the idle reap. Mute/deafen, meanwhile,
 * ride a one-shot __VOICE_STATUS__ message that is only sent on the toggle —
 * so rebuilding the entry from scratch here (`isDeafened: false`) silently
 * un-deafened people in everyone's roster the moment a fourth person walked
 * in. Same for the `connecting` chip and the avatar. This is the one place
 * that writes a roster entry from a presence event; every StreamStarted /
 * UserJoined handler goes through it. It does NOT notify — every caller has
 * its own refresh/trigger and firing here would double-render them.
 *
 * `fallback` seeds the flags only when there is no prior entry (a peer whose
 * status we have never heard); it never overrides what a status message told us.
 */
export function upsertVoiceUser(
    roomId: string,
    user: { id: number; username: string; avatarFileId?: string | null },
    fallback?: { isMuted?: boolean; isDeafened?: boolean; isBuffering?: boolean },
): VoiceUserStatus {
    let roomUsers = globalVoiceUsers.get(roomId);
    if (!roomUsers) {
        roomUsers = new Map();
        globalVoiceUsers.set(roomId, roomUsers);
    }
    const prev = roomUsers.get(user.id);
    const next: VoiceUserStatus = {
        id: user.id,
        username: user.username,
        isMuted: prev?.isMuted ?? fallback?.isMuted ?? false,
        isDeafened: prev?.isDeafened ?? fallback?.isDeafened ?? false,
        isBuffering: prev?.isBuffering ?? fallback?.isBuffering ?? false,
        avatarFileId: user.avatarFileId ?? prev?.avatarFileId,
        connecting: prev?.connecting,
    };
    roomUsers.set(user.id, next);
    return next;
}

// Global state for screen sharers (userId -> username) - accessible from sidebar
export const globalScreenSharers = new Map<number, string>(); // userId -> username

// Global state for camera users (userId -> username) - accessible from sidebar
export const globalCameraUsers = new Map<number, string>(); // userId -> username

// Live camera MediaStreams (userId -> stream, LOCAL user included) so the
// voice-stage tiles can render actual video, not just a camera chip. Written by
// VoicePanel (the media-pipe owner) on camera start/stop/peer-loss/leave;
// change notifications ride the existing notifyStreamStateChange bus.
// Deliberately NOT cleared by clearAllStreams(): that runs when a user stops
// their own screen share, and other people's cameras must survive it.
export const globalCameraStreams = new Map<number, MediaStream>();

// Global state for speaking users - accessible from sidebar
export const globalSpeakingUsers = new Set<number>(); // Set of userIds currently speaking

// Helper function to get voice users in a specific room
export function getVoiceUsersInRoom(roomId: string): VoiceUserStatus[] {
    const roomUsers = globalVoiceUsers.get(roomId);
    if (!roomUsers) return [];
    return Array.from(roomUsers.values());
}

/** Every user currently in ANY voice room (deduped) — for pick-a-user menus
 *  like "Give Control" on the host's own stream tile. */
export function getAllVoiceUsers(): VoiceUserStatus[] {
    const seen = new Map<number, VoiceUserStatus>();
    for (const room of globalVoiceUsers.values()) {
        for (const u of room.values()) {
            if (!seen.has(u.id)) seen.set(u.id, u);
        }
    }
    return [...seen.values()];
}

// Whether THIS user is currently in a voice call. Written only by VoicePanel
// (the call owner); read by chrome that should stay out of a live call's way —
// e.g. UpdateBanner hides while in voice, because an update relaunches the app
// and drops the call.
let selfInVoice = false;
type SelfInVoiceCallback = (inVoice: boolean) => void;
const selfInVoiceListeners: Set<SelfInVoiceCallback> = new Set();

export function setSelfInVoice(inVoice: boolean) {
    if (selfInVoice === inVoice) return;
    selfInVoice = inVoice;
    selfInVoiceListeners.forEach(cb => cb(inVoice));
}

export function isSelfInVoice(): boolean {
    return selfInVoice;
}

export function subscribeSelfInVoice(callback: SelfInVoiceCallback): () => void {
    selfInVoiceListeners.add(callback);
    return () => selfInVoiceListeners.delete(callback);
}

// Voice user state change callbacks - for Chat.tsx sidebar to subscribe
type VoiceUserCallback = () => void;
const voiceUserListeners: Set<VoiceUserCallback> = new Set();

export function subscribeToVoiceUsers(callback: VoiceUserCallback): () => void {
    voiceUserListeners.add(callback);
    return () => voiceUserListeners.delete(callback);
}

export function notifyVoiceUsersChange() {
    voiceUserListeners.forEach(cb => cb());
}

// Helper to check if user is streaming
export function isUserStreaming(userId: number): boolean {
    return globalScreenSharers.has(userId);
}

// Helper to check if user is speaking
export function isUserSpeaking(userId: number): boolean {
    return globalSpeakingUsers.has(userId);
}

// Global callback for stopping own screen share - set by VoicePanel
let stopOwnScreenShareCallback: (() => void) | null = null;

export function registerStopScreenShareCallback(callback: () => void) {
    stopOwnScreenShareCallback = callback;
}

export function stopOwnScreenShare() {
    if (stopOwnScreenShareCallback) {
        stopOwnScreenShareCallback();
    }
    // Ending your share must also end anyone controlling it.
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('voiceControlReset'));
    }
}

// Check if current user is streaming (to show "Stop Sharing" vs "Stop Watching")
let currentStreamingUserId: number | null = null;

export function setCurrentStreamingUser(userId: number | null) {
    currentStreamingUserId = userId;
}

export function getCurrentStreamingUserId(): number | null {
    return currentStreamingUserId;
}

// (There used to be a module-level "local deafen" mirror here that StreamStage /
// StreamPip read to silence screen-share audio while deafened. Deafen now
// means "stop hearing people's VOICE" and leaves stream audio alone — you can
// deafen the chatter and still hear the game — so the mirror is gone.)

// Global stream viewing state - accessible from Chat.tsx for main area rendering
export const globalSelectedStreams = new Set<number>(); // Which streams are being watched
export const globalStreamData = new Map<number, { username: string; stream: MediaStream | null }>(); // userId -> stream data

// Stream viewing state change callbacks
type StreamStateCallback = () => void;
const streamStateListeners: Set<StreamStateCallback> = new Set();

export function subscribeToStreamState(callback: StreamStateCallback): () => void {
    streamStateListeners.add(callback);
    return () => streamStateListeners.delete(callback);
}

export function notifyStreamStateChange() {
    streamStateListeners.forEach(cb => cb());
}

export function selectStream(userId: number) {
    globalSelectedStreams.add(userId);
    notifyStreamStateChange();
}

export function deselectStream(userId: number) {
    globalSelectedStreams.delete(userId);
    notifyStreamStateChange();
}

export function getSelectedStreams(): number[] {
    return Array.from(globalSelectedStreams);
}

export function getStreamData(userId: number): { username: string; stream: MediaStream | null } | undefined {
    return globalStreamData.get(userId);
}

export function getAllStreamers(): Array<{ userId: number; username: string; stream: MediaStream | null }> {
    return Array.from(globalStreamData.entries()).map(([userId, data]) => ({ userId, ...data }));
}

// Clear all stream state (called when leaving voice or stopping all streams)
export function clearAllStreams() {
    globalSelectedStreams.clear();
    globalStreamData.clear();
    globalScreenSharers.clear();
    notifyStreamStateChange();
    useStreamStore.getState().clearAllStreams();
    // End any remote-control session tied to the streams we just dropped
    // (decoupled via a window event to avoid importing remoteControl here).
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('voiceControlReset'));
    }
}
