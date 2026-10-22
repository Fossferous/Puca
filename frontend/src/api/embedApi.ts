/**
 * `window.pucaEmbed`: what an embedding host calls, and the state it is sent
 * (docs/EMBEDDING.md is the contract; embedHost.ts says who hosts and how a
 * host opts in). Installed by main.tsx only when a host declared itself;
 * Chat and VoicePanel register what only they know, and every registration
 * here is a no-op without a host, so a browser tab, the desktop app and the
 * phone app run exactly as before.
 *
 * Commands go through the same code as the app's own controls: joining is
 * the channel click's path, mute and deafen are the buttons' presses,
 * push-to-talk is the registered hold action. Nothing here decides anything
 * the app would decide differently.
 */
import { EMBED_API_VERSION, activateHostNotification, embedHost } from './embedHost';
import { holdFromHost } from './hotkeys';
import {
    globalVoiceUsers, isUserSpeaking, subscribeSelfInVoice, subscribeToSpeaking, subscribeToVoiceUsers,
} from '../components/voiceState';
import { loadSettings, saveSettings } from '../components/settingsStore';

export type EmbedInputMode = 'open' | 'pushToTalk' | 'pushToMute';

export interface EmbedMember {
    id: number;
    username: string;
    speaking: boolean;
    muted: boolean;
    deafened: boolean;
    /** In the call with no microphone at all. */
    noMicrophone: boolean;
    /** This is the signed-in account (on this device or another). */
    self: boolean;
}

export interface EmbedCall {
    /** Null only for a channel the server sent without one. */
    serverId: string | null;
    channelId: number;
    channelName: string;
    /** In the call. False while joining, and when a warning held the join
     *  back (the full app says why). */
    connected: boolean;
    connecting: boolean;
    /** The mute in force: the member's own, or one the call imposes. */
    muted: boolean;
    deafened: boolean;
    /** In the call without a microphone: none could be opened, no SPEAK
     *  here, or joined without one on purpose. */
    noMicrophone: boolean;
    inputMode: EmbedInputMode;
    /** Push-to-talk (or push-to-mute) is held right now. */
    holdDown: boolean;
    members: EmbedMember[];
}

export interface EmbedState {
    apiVersion: number;
    appVersion: string;
    signedIn: boolean;
    user: { id: number; username: string } | null;
    servers: { id: string; name: string }[];
    /** The server open in the full app: a default for a host's picker. */
    currentServerId: string | null;
    call: EmbedCall | null;
}

export interface EmbedVoiceChannel {
    id: number;
    name: string;
    /** May join (CONNECT); a channel without it is listed but refused. */
    canConnect: boolean;
    members: { id: number; username: string }[];
}

export type EmbedResult = { ok: true } | { ok: false; error: string };

/** What Chat knows: the account, its servers, which voice channel is open. */
export interface EmbedSession {
    user(): { id: number; username: string } | null;
    servers(): { id: string; name: string }[];
    currentServerId(): string | null;
    voiceChannel(): { id: number; serverId: string | null; name: string } | null;
    listVoiceChannels(serverId: string): Promise<EmbedVoiceChannel[]>;
    joinVoice(serverId: string, channelId: number): Promise<EmbedResult>;
}

/** What only the voice panel knows, read live from its refs. */
export interface EmbedCallControls {
    roomId: string;
    state(): Omit<EmbedCall, 'serverId' | 'channelId' | 'channelName' | 'members'>;
    setMuted(muted: boolean): boolean;
    setDeafened(deafened: boolean): boolean;
    leave(): void;
}

let session: EmbedSession | null = null;
let call: EmbedCallControls | null = null;

/** Chat registers on mount and passes null on unmount (sign-out). */
export function registerEmbedSession(s: EmbedSession | null): () => void {
    if (!embedHost()) return () => {};
    session = s;
    notifyEmbedChanged();
    return () => {
        if (session === s) {
            session = null;
            notifyEmbedChanged();
        }
    };
}

/** VoicePanel registers for the life of its channel. */
export function registerEmbedCall(c: EmbedCallControls): () => void {
    if (!embedHost()) return () => {};
    call = c;
    notifyEmbedChanged();
    return () => {
        if (call === c) {
            call = null;
            notifyEmbedChanged();
        }
    };
}

// ---- The state, and telling the host it changed ----------------------------

function readMembers(roomId: string, selfId: number | null): EmbedMember[] {
    const room = globalVoiceUsers.get(roomId);
    if (!room) return [];
    return [...room.values()].map(u => ({
        id: u.id,
        username: u.username,
        speaking: isUserSpeaking(u.id),
        muted: u.isMuted,
        deafened: u.isDeafened,
        noMicrophone: u.noMic === true,
        self: u.id === selfId,
    }));
}

/** The snapshot a host is sent. Safe to call at any time. */
export function getEmbedState(): EmbedState {
    const user = session?.user() ?? null;
    let callState: EmbedCall | null = null;
    const channel = session?.voiceChannel() ?? null;
    if (channel) {
        const roomId = `voice_${channel.id}`;
        const live = call && call.roomId === roomId ? call.state() : null;
        callState = {
            serverId: channel.serverId,
            channelId: channel.id,
            channelName: channel.name,
            connected: live?.connected ?? false,
            connecting: live?.connecting ?? true,
            muted: live?.muted ?? false,
            deafened: live?.deafened ?? false,
            noMicrophone: live?.noMicrophone ?? false,
            inputMode: live?.inputMode ?? loadSettings().voiceInputMode ?? 'open',
            holdDown: live?.holdDown ?? false,
            members: readMembers(roomId, user?.id ?? null),
        };
    }
    return {
        apiVersion: EMBED_API_VERSION,
        appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '',
        signedIn: !!session && !!user,
        user,
        servers: session?.servers() ?? [],
        currentServerId: session?.currentServerId() ?? null,
        call: callState,
    };
}

/** Coalesce a burst (speaking flips several times a second per talker) into
 *  one snapshot, sent only when something in it changed. */
const PUSH_DELAY_MS = 60;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let lastSent = '';

export function notifyEmbedChanged(): void {
    if (!embedHost()?.onStateChange || pushTimer) return;
    pushTimer = setTimeout(() => {
        pushTimer = null;
        const host = embedHost();
        if (!host?.onStateChange) return;
        const state = getEmbedState();
        const json = JSON.stringify(state);
        if (json === lastSent) return;
        lastSent = json;
        try {
            host.onStateChange(state);
        } catch (err) {
            console.warn('[embed] the host refused a state update:', err);
        }
    }, PUSH_DELAY_MS);
}

// ---- Push-to-talk from the host's own button --------------------------------

/** A host hold lasts this long unless renewed: a host that dies (or loses its
 *  connection to the page) mid-press must not leave the microphone open. */
export const HOLD_LEASE_MS = 1500;
let holdLease: ReturnType<typeof setTimeout> | null = null;
let holdAction: string | null = null;

/** The hold action the current input mode registers (VoicePanel). */
function holdActionId(): string | null {
    const mode = call?.state().inputMode ?? loadSettings().voiceInputMode ?? 'open';
    if (mode === 'pushToTalk') return 'voice.ptt';
    if (mode === 'pushToMute') return 'voice.ptm';
    return null;
}

function releaseHold(): void {
    if (holdLease) { clearTimeout(holdLease); holdLease = null; }
    if (holdAction) { holdFromHost(holdAction, false); holdAction = null; }
}

/**
 * The host's push-to-talk button. `held` true holds the current mode's hold
 * action (push-to-talk opens the microphone, push-to-mute shuts it) for
 * HOLD_LEASE_MS; a host keeps a press alive by sending true again before
 * then, and ends it with false. Returns whether there was an action to hold:
 * none outside a call, in voice-activity mode, or without a microphone.
 */
export function holdFromEmbedHost(held: boolean): boolean {
    if (!held) {
        const had = holdAction !== null;
        releaseHold();
        notifyEmbedChanged();
        return had;
    }
    const id = holdActionId();
    if (holdAction && holdAction !== id) releaseHold();
    if (!id || !holdFromHost(id, true)) {
        releaseHold();
        return false;
    }
    holdAction = id;
    if (holdLease) clearTimeout(holdLease);
    holdLease = setTimeout(() => {
        holdLease = null;
        console.warn('[embed] push-to-talk lease ran out without a release: letting go');
        releaseHold();
        notifyEmbedChanged();
    }, HOLD_LEASE_MS);
    notifyEmbedChanged();
    return true;
}

// ---- window.pucaEmbed --------------------------------------------------------

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isServerId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;

export interface PucaEmbedApi {
    readonly apiVersion: number;
    getState(): EmbedState;
    listVoiceChannels(serverId: string): Promise<EmbedVoiceChannel[]>;
    joinVoice(serverId: string, channelId: number): Promise<EmbedResult>;
    leaveVoice(): boolean;
    setMuted(muted: boolean): boolean;
    setDeafened(deafened: boolean): boolean;
    setInputMode(mode: EmbedInputMode): boolean;
    holdPushToTalk(held: boolean): boolean;
    activateNotification(id: string): boolean;
}

export function createEmbedApi(): PucaEmbedApi {
    return Object.freeze({
        apiVersion: EMBED_API_VERSION,
        getState: () => getEmbedState(),
        listVoiceChannels: async (serverId: string) => {
            if (!session || !isServerId(serverId)) return [];
            return session.listVoiceChannels(serverId);
        },
        joinVoice: async (serverId: string, channelId: number): Promise<EmbedResult> => {
            if (!session) return { ok: false, error: 'not signed in' };
            if (!isServerId(serverId) || !isId(channelId)) return { ok: false, error: 'no such voice channel' };
            return session.joinVoice(serverId, channelId);
        },
        leaveVoice: () => {
            if (!call) return false;
            releaseHold();
            call.leave();
            return true;
        },
        setMuted: (muted: boolean) => (typeof muted === 'boolean' && call ? call.setMuted(muted) : false),
        setDeafened: (deafened: boolean) => (typeof deafened === 'boolean' && call ? call.setDeafened(deafened) : false),
        setInputMode: (mode: EmbedInputMode) => {
            if (mode !== 'open' && mode !== 'pushToTalk' && mode !== 'pushToMute') return false;
            releaseHold();
            // The same stored setting Settings > Voice & Video writes; the
            // panel picks it up from the settingsChanged event it dispatches.
            const s = loadSettings();
            if (s.voiceInputMode !== mode) saveSettings({ ...s, voiceInputMode: mode });
            notifyEmbedChanged();
            return true;
        },
        holdPushToTalk: (held: boolean) => holdFromEmbedHost(held === true),
        activateNotification: (id: string) => (typeof id === 'string' ? activateHostNotification(id) : false),
    });
}

let installed = false;

/** main.tsx, at startup: install window.pucaEmbed when a host declared itself. */
export function installEmbedApi(): boolean {
    if (installed || typeof window === 'undefined' || !embedHost()) return installed;
    installed = true;
    Object.defineProperty(window, 'pucaEmbed', { value: createEmbedApi(), configurable: false, writable: false, enumerable: false });
    subscribeToSpeaking(notifyEmbedChanged);
    subscribeToVoiceUsers(notifyEmbedChanged);
    subscribeSelfInVoice(() => notifyEmbedChanged());
    window.addEventListener('settingsChanged', notifyEmbedChanged);
    notifyEmbedChanged();
    return true;
}

/** Tests only. */
export function resetEmbedApiForTest(): void {
    session = null;
    call = null;
    releaseHold();
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
    lastSent = '';
}
