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
 * unknown client frame with an Error, which the client shows as an error notice.
 * So nothing that sends either may run unless `supported` is true.
 *
 * Wire contract pinned by `tests/fixtures/ownVoiceState.json` (the server's
 * `own_voice_wire_tests` serializes against the same file).
 */
import { useSyncExternalStore } from 'react';
import { embedHost } from './embedHost';

export type DeviceKind = 'desktop' | 'mobile' | 'browser';

/**
 * What shape of `mobile` device: a TABLET is a touch screen whose short side
 * is 600 CSS px or more (Android's own phone/tablet line, sw600dp), "your
 * tablet"; anything else, or not said, is a phone, "your phone". Travels
 * beside the kind (`?form=tablet`, `device_form`, `by_form`), never as a kind
 * of its own: a client or server that predates it reads `mobile` and says
 * "your phone", as it always did.
 */
export type DeviceForm = 'tablet';

/** The short side, in CSS px, from which a touch screen is a tablet. */
export const TABLET_MIN_SHORT_SIDE = 600;

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
    /** 'tablet' when that `mobile` device said it is one; null for a phone,
     *  any other kind, or a server from before it. */
    deviceForm: DeviceForm | null;
    /** The member's own mute choice and deafen in that call, as the device
     *  in it last reported them (null: not reported yet, or a server from
     *  before 0.9.839). Move here starts the call with them. */
    selfMuted: boolean | null;
    deafened: boolean | null;
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
    const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
    return { roomId, channelId, serverId, channelName, serverName, here: p.here, device,
        deviceForm: formOf(device, p.device_form),
        selfMuted: flag(p.self_muted), deafened: flag(p.deafened) };
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
 * How a call that continues on THIS device should arrive: muted if the
 * member had muted (or deafened) it on the other device, deafened if it was.
 * For every way the account's call comes over here - Move here, tapping its
 * channel, or joining another channel while it is live elsewhere (voice is
 * one call per account, so that ends it there). Null - join as a join always
 * has - when the call is not on another device, or it has reported nothing
 * (just joined, or a server from before 0.9.839).
 */
export function carriedFromOtherDevice(snap: OwnVoiceSnapshot = snapshot): { muted: boolean; deafened: boolean } | null {
    const call = callOnOtherDevice(snap);
    if (!call || (call.selfMuted === null && call.deafened === null)) return null;
    return { muted: call.selfMuted === true || call.deafened === true, deafened: call.deafened === true };
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

/** The form a frame gives a device: 'tablet' only beside `mobile`, and only
 *  that exact word; anything else (absent, an older server, junk) is none. */
function formOf(kind: unknown, form: unknown): DeviceForm | null {
    return kind === 'mobile' && form === 'tablet' ? 'tablet' : null;
}

/** "on your PC" / "on your phone" / "on your tablet" / "in a browser" / "on another device". */
export function whereDevice(kind: DeviceKind | null | undefined, form?: unknown): string {
    switch (kind) {
        case 'desktop': return 'on your PC';
        case 'mobile': return formOf(kind, form) ? 'on your tablet' : 'on your phone';
        case 'browser': return 'in a browser';
        default: return 'on another device';
    }
}

/** "your PC" / "your phone" / "your tablet" / "a browser" / "another device". */
export function nameDevice(kind: unknown, form?: unknown): string {
    switch (kind) {
        case 'desktop': return 'your PC';
        case 'mobile': return formOf(kind, form) ? 'your tablet' : 'your phone';
        case 'browser': return 'a browser';
        default: return 'another device';
    }
}

export function ownVoiceBannerText(s: OwnVoiceState): string {
    return `You're in ${s.channelName ?? 'a voice channel'} ${whereDevice(s.device, s.deviceForm)}`;
}

/**
 * What the DISPLACED device says when its call was ended from another device
 * of the account, or by the server mode it belonged to (a RoomLeft carrying
 * `reason`). Null for every other RoomLeft — a hang-up, voice exclusivity, a
 * kick — which keep their old behaviour. `modeName`: the mode that just ended,
 * when this device saw it end; a device whose socket was down did not.
 */
export function roomLeftNotice(payload: unknown, modeName?: string | null): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as { reason?: unknown; by?: unknown; by_form?: unknown };
    if (p.reason === 'moved') return `You moved the call to ${nameDevice(p.by, p.by_form)}`;
    if (p.reason === 'left_elsewhere') return `You left voice from ${nameDevice(p.by, p.by_form)}`;
    if (p.reason === 'mode_ended') return `${modeName ?? 'The mode'} ended, so this call ended.`;
    return null;
}

/**
 * What kind of device THIS is, for the `?kind=` the server relays to the
 * account's other devices. A phone's browser is a phone to its owner, and a
 * tablet's (a touch screen whose short side is TABLET_MIN_SHORT_SIDE or more,
 * held either way) is `mobile` too, with the form saying tablet
 * (currentClientForm). A touch screen used to count only while its window was
 * at most 1024 px wide, so a tablet held sideways was "a browser".
 */
export function currentClientKind(isTauri: boolean, isNativeMobile: boolean): DeviceKind {
    if (isTauri) return 'desktop';
    if (isNativeMobile) return 'mobile';
    try {
        if (typeof window !== 'undefined') {
            if (window.matchMedia?.('(pointer: coarse) and (max-width: 1024px)').matches) return 'mobile';
            // Not inside an embedding host: Púca for Steam Deck's 1280x800
            // screen would pass for a tablet held sideways if Steam's browser
            // reports a coarse pointer, and a Deck is not a tablet. A host
            // keeps the rule it always had.
            if (!embedHost() && window.matchMedia?.('(pointer: coarse)').matches && screenShortSide() >= TABLET_MIN_SHORT_SIDE) return 'mobile';
        }
    } catch { /* no matchMedia: a browser */ }
    return 'browser';
}

/** The screen's short side in CSS px (the window's when there is no screen
 *  to ask); 0 when neither says. */
function screenShortSide(): number {
    if (typeof window === 'undefined') return 0;
    const scr = window.screen;
    const w = scr && scr.width > 0 ? scr.width : window.innerWidth;
    const h = scr && scr.height > 0 ? scr.height : window.innerHeight;
    return w > 0 && h > 0 ? Math.min(w, h) : 0;
}

/**
 * What shape of `mobile` device THIS is, for `?form=`: 'tablet' when the
 * screen's short side is TABLET_MIN_SHORT_SIDE CSS px or more, else null (a
 * phone, which sends no form). The SCREEN, not the window, so turning a
 * tablet, the soft keyboard or a split screen does not change what it is.
 * Null for every other kind, and inside an embedding host (a Steam Deck is
 * not a tablet).
 */
export function currentClientForm(kind: DeviceKind): DeviceForm | null {
    if (kind !== 'mobile' || embedHost()) return null;
    return screenShortSide() >= TABLET_MIN_SHORT_SIDE ? 'tablet' : null;
}

/**
 * What THIS device is as a picture (the own-voice banner's Move here): a
 * tablet by what it tells the server (socketUrl's `form=tablet`, so the
 * account's other devices call it "your tablet"), whichever layout it shows;
 * otherwise a phone in the phone layout (`phoneLayout`, Chat's) and a
 * computer in any other, as before.
 */
export function thisDeviceShape(phoneLayout: boolean, isTauri: boolean, isNativeMobile: boolean): 'computer' | 'phone' | 'tablet' {
    if (currentClientForm(currentClientKind(isTauri, isNativeMobile)) === 'tablet') return 'tablet';
    return phoneLayout ? 'phone' : 'computer';
}
