/**
 * Where THIS ACCOUNT's voice call is — "You're in Lounge on your PC".
 *
 * The server pushes `OwnVoiceState` to every device of the account that
 * announced it can read it (`?caps=own_voice` on the WebSocket URL, see
 * websocket.ts): once on connect, and again whenever the account's voice
 * membership changes. Each device therefore knows, on every screen, whether
 * the call is on another device — the phone opened while the PC is in a call
 * can offer Leave and Move here.
 *
 * THE CAPABILITY GATE. `supported` is true only after THIS socket received the
 * frame, and is reset whenever the socket goes away (websocket.ts). The frame
 * comes only from a server that also understands `LeaveOwnVoice` and
 * `JoinRoom { take_over }` — an older server (a rollback host, say) answers an
 * unknown client frame with an Error, which the client shows as an alert(). So
 * nothing that sends either may run unless `supported` is true.
 *
 * Wire contract pinned by `tests/fixtures/ownVoiceState.json` (the server's
 * `own_voice_wire_tests` serializes against the same file).
 */
import { useSyncExternalStore } from 'react';

export type DeviceKind = 'desktop' | 'mobile' | 'browser';

export interface OwnVoiceState {
    /** `voice_<channelId>`, or null when the account is in no voice call. */
    roomId: string | null;
    channelId: number | null;
    serverId: string | null;
    channelName: string | null;
    serverName: string | null;
    /** THIS connection is in the call. */
    here: boolean;
    /** The kind of device holding the call, as it reported itself. */
    device: DeviceKind | null;
}

export interface OwnVoiceSnapshot {
    /** This socket's server understands the feature (it sent the frame). */
    supported: boolean;
    state: OwnVoiceState | null;
}

const DEVICE_KINDS: readonly DeviceKind[] = ['desktop', 'mobile', 'browser'];

const EMPTY: OwnVoiceSnapshot = { supported: false, state: null };
let snapshot: OwnVoiceSnapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(next: OwnVoiceSnapshot) {
    snapshot = next;
    listeners.forEach(fn => fn());
}

const strOrNull = (v: unknown): string | null | undefined =>
    v === null || v === undefined ? null : typeof v === 'string' ? v : undefined;

/** Parse a frame's payload; null for anything that is not one. */
export function parseOwnVoiceState(payload: unknown): OwnVoiceState | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    const roomId = strOrNull(p.room_id);
    const serverId = strOrNull(p.server_id);
    const channelName = strOrNull(p.channel_name);
    const serverName = strOrNull(p.server_name);
    if (roomId === undefined || serverId === undefined || channelName === undefined || serverName === undefined) return null;
    if (typeof p.here !== 'boolean') return null;
    const channelId = typeof p.channel_id === 'number' && Number.isFinite(p.channel_id) ? p.channel_id : null;
    if (roomId !== null && channelId === null) return null;
    const device = DEVICE_KINDS.includes(p.device as DeviceKind) ? (p.device as DeviceKind) : null;
    return { roomId, channelId, serverId, channelName, serverName, here: p.here, device };
}

/** An OwnVoiceState frame arrived on the live socket (websocket.ts). */
export function applyOwnVoiceFrame(payload: unknown): void {
    const state = parseOwnVoiceState(payload);
    if (!state) return;
    publish({ supported: true, state });
}

/** The socket this knowledge came from is gone (or being replaced). */
export function resetOwnVoice(): void {
    if (snapshot === EMPTY) return;
    publish(EMPTY);
}

export function getOwnVoiceSnapshot(): OwnVoiceSnapshot {
    return snapshot;
}

export function ownVoiceSupported(): boolean {
    return snapshot.supported;
}

export function subscribeOwnVoice(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** React: the live snapshot. */
export function useOwnVoice(): OwnVoiceSnapshot {
    return useSyncExternalStore(subscribeOwnVoice, getOwnVoiceSnapshot, getOwnVoiceSnapshot);
}

/** The account's call when it is on ANOTHER device (and this server can act
 *  on it); null otherwise. */
export function callOnOtherDevice(snap: OwnVoiceSnapshot): OwnVoiceState | null {
    const s = snap.state;
    return snap.supported && s && s.roomId && !s.here ? s : null;
}

/**
 * Whether joining `roomId` should carry `take_over` — "Move here". True when
 * the account is in THAT room on another device and the server understands the
 * flag: tapping the same channel on the phone moves the call rather than
 * leaving both devices connected. A different room needs nothing (voice
 * exclusivity already ends the other device's call).
 */
export function shouldTakeOver(roomId: string, snap: OwnVoiceSnapshot = snapshot): boolean {
    const call = callOnOtherDevice(snap);
    return !!call && call.roomId === roomId;
}

/** "on your PC" / "on your phone" / "in a browser" / "on another device". */
export function whereDevice(kind: DeviceKind | null | undefined): string {
    switch (kind) {
        case 'desktop': return 'on your PC';
        case 'mobile': return 'on your phone';
        case 'browser': return 'in a browser';
        default: return 'on another device';
    }
}

/** "your PC" / "your phone" / "a browser" / "another device". */
export function nameDevice(kind: unknown): string {
    switch (kind) {
        case 'desktop': return 'your PC';
        case 'mobile': return 'your phone';
        case 'browser': return 'a browser';
        default: return 'another device';
    }
}

export function ownVoiceBannerText(s: OwnVoiceState): string {
    return `You're in ${s.channelName ?? 'a voice channel'} ${whereDevice(s.device)}`;
}

/**
 * What the DISPLACED device says when its call was ended from another device
 * of the account (a RoomLeft carrying `reason`). Null for every other RoomLeft
 * — a hang-up, voice exclusivity, a kick — which keep their old behaviour.
 */
export function roomLeftNotice(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as { reason?: unknown; by?: unknown };
    if (p.reason === 'moved') return `You moved the call to ${nameDevice(p.by)}`;
    if (p.reason === 'left_elsewhere') return `You left voice from ${nameDevice(p.by)}`;
    return null;
}

/**
 * What kind of device THIS is, for the `?kind=` the server relays to the
 * account's other devices. A phone browser is a phone to its owner.
 */
export function currentClientKind(isTauri: boolean, isNativeMobile: boolean): DeviceKind {
    if (isTauri) return 'desktop';
    if (isNativeMobile) return 'mobile';
    try {
        if (typeof window !== 'undefined'
            && window.matchMedia?.('(pointer: coarse) and (max-width: 1024px)').matches) return 'mobile';
    } catch { /* no matchMedia: a browser */ }
    return 'browser';
}
