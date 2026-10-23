/**
 * What crosses between the Púca page and this plugin.
 *
 * The page half is Púca's embedding API (docs/EMBEDDING.md), whose state
 * types are mirrored below. The plugin's shim (shim/pageShim.ts) runs in the
 * page and reports through a DevTools binding that the backend (main.py)
 * forwards here as "puca_page" events. Everything arriving that way is parsed
 * strictly: the page is a web page, and what it says is shown on the Deck's
 * own UI.
 */

export interface EmbedMember {
    id: number;
    username: string;
    speaking: boolean;
    muted: boolean;
    deafened: boolean;
    noMicrophone: boolean;
    self: boolean;
}

export interface EmbedCall {
    serverId: string | null;
    channelId: number;
    channelName: string;
    connected: boolean;
    connecting: boolean;
    muted: boolean;
    deafened: boolean;
    noMicrophone: boolean;
    inputMode: 'open' | 'pushToTalk' | 'pushToMute';
    holdDown: boolean;
    /** This device is sharing its screen into the call. False from a page
     *  that predates it. */
    sharing: boolean;
    members: EmbedMember[];
}

export interface EmbedState {
    apiVersion: number;
    appVersion: string;
    /** The optional calls the page has (docs/EMBEDDING.md): e.g. 'signIn'.
     *  Empty on a page that predates the list. */
    features: string[];
    signedIn: boolean;
    /** The account's encryption keys did not come back on this Deck
     *  (docs/EMBEDDING.md, keys): 'refused' or 'unavailable'. Null when they
     *  are in use, while signed out, and from a page that predates it. */
    keys: 'refused' | 'unavailable' | null;
    user: { id: number; username: string } | null;
    servers: { id: string; name: string }[];
    currentServerId: string | null;
    call: EmbedCall | null;
}

export interface EmbedVoiceChannel {
    id: number;
    name: string;
    canConnect: boolean;
    members: { id: number; username: string }[];
}

/** A voice channel with people in it, on any of the person's servers. */
export interface LiveChannel {
    serverId: string;
    serverName: string;
    channel: EmbedVoiceChannel;
}

/** The channels with people in them, busiest first, then by server and
 *  channel name: the panel's "Live now". */
export function liveChannels(servers: { id: string; name: string }[], channels: Map<string, EmbedVoiceChannel[]>): LiveChannel[] {
    return servers
        .flatMap(s => (channels.get(s.id) ?? [])
            .filter(c => c.members.length > 0)
            .map(c => ({ serverId: s.id, serverName: s.name, channel: c })))
        .sort((a, b) => b.channel.members.length - a.channel.members.length
            || a.serverName.localeCompare(b.serverName)
            || a.channel.name.localeCompare(b.channel.name));
}

export interface MicConstraints {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
}

export interface PageNotification {
    id: string;
    title: string;
    body: string;
    key: string;
    kind: 'message' | 'tasks' | 'test' | 'clip';
}

export type PageMessage =
    /** The shim is in place on the Púca page; `apiVersion` null = this server's Púca has no embedding API. */
    | { type: 'ready'; apiVersion: number | null; appVersion: string }
    | { type: 'state'; state: EmbedState }
    | { type: 'notify'; notification: PageNotification }
    /** The page wants the microphone: answer the offer with the Deck's mic. */
    | { type: 'mic-request'; id: string; constraints: MicConstraints; offer: { type: 'offer'; sdp: string } }
    | { type: 'mic-release'; id: string }
    /** The page wants the screen for a share (its getDisplayMedia): allowed
     *  only after a press in the panel (share.ts). */
    | { type: 'share-request'; id: string }
    /** The page let go of that share, or gave up waiting for it. */
    | { type: 'share-release'; id: string };

const MAX_TEXT = 200;
const MAX_SDP = 64 * 1024;

const str = (v: unknown, max = MAX_TEXT): string | null =>
    (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v: unknown): number | null =>
    (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
const bool = (v: unknown): boolean => v === true;
const obj = (v: unknown): Record<string, unknown> | null =>
    (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const isRequestId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

function readMember(v: unknown): EmbedMember | null {
    const o = obj(v);
    const id = int(o?.id);
    const username = str(o?.username);
    if (!o || id === null || username === null) return null;
    return {
        id, username,
        speaking: bool(o.speaking), muted: bool(o.muted), deafened: bool(o.deafened),
        noMicrophone: bool(o.noMicrophone), self: bool(o.self),
    };
}

function readCall(v: unknown): EmbedCall | null {
    const o = obj(v);
    const channelId = int(o?.channelId);
    if (!o || channelId === null) return null;
    const mode = o.inputMode === 'pushToTalk' || o.inputMode === 'pushToMute' ? o.inputMode : 'open';
    return {
        serverId: str(o.serverId, 64),
        channelId,
        channelName: str(o.channelName) ?? '',
        connected: bool(o.connected),
        connecting: bool(o.connecting),
        muted: bool(o.muted),
        deafened: bool(o.deafened),
        noMicrophone: bool(o.noMicrophone),
        inputMode: mode,
        holdDown: bool(o.holdDown),
        sharing: bool(o.sharing),
        members: (Array.isArray(o.members) ? o.members.slice(0, 200) : [])
            .map(readMember).filter((m): m is EmbedMember => m !== null),
    };
}

export function readState(v: unknown): EmbedState | null {
    const o = obj(v);
    const apiVersion = int(o?.apiVersion);
    if (!o || apiVersion === null) return null;
    const u = obj(o.user);
    const userId = int(u?.id);
    const username = str(u?.username);
    return {
        apiVersion,
        appVersion: str(o.appVersion, 40) ?? '',
        features: (Array.isArray(o.features) ? o.features.slice(0, 50) : []).flatMap(f => {
            const name = str(f, 40);
            return name ? [name] : [];
        }),
        signedIn: bool(o.signedIn),
        keys: o.keys === 'refused' || o.keys === 'unavailable' ? o.keys : null,
        user: userId !== null && username !== null ? { id: userId, username } : null,
        servers: (Array.isArray(o.servers) ? o.servers.slice(0, 500) : []).flatMap(s => {
            const so = obj(s);
            const id = str(so?.id, 64);
            const name = str(so?.name);
            return id && name !== null ? [{ id, name }] : [];
        }),
        currentServerId: str(o.currentServerId, 64),
        call: o.call === null || o.call === undefined ? null : readCall(o.call),
    };
}

export function readVoiceChannels(v: unknown): EmbedVoiceChannel[] {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 500).flatMap(c => {
        const o = obj(c);
        const id = int(o?.id);
        const name = str(o?.name);
        if (!o || id === null || name === null) return [];
        const members = (Array.isArray(o.members) ? o.members.slice(0, 200) : []).flatMap(m => {
            const mo = obj(m);
            const mid = int(mo?.id);
            const mname = str(mo?.username);
            return mid !== null && mname !== null ? [{ id: mid, username: mname }] : [];
        });
        return [{ id, name, canConnect: bool(o.canConnect), members }];
    });
}

function readConstraints(v: unknown): MicConstraints {
    // Púca passes MediaTrackConstraints: a boolean, or { ideal | exact: boolean }.
    const o = obj(v) ?? {};
    const flag = (x: unknown): boolean | undefined => {
        if (typeof x === 'boolean') return x;
        const xo = obj(x);
        if (xo && typeof xo.exact === 'boolean') return xo.exact;
        if (xo && typeof xo.ideal === 'boolean') return xo.ideal;
        return undefined;
    };
    return {
        echoCancellation: flag(o.echoCancellation),
        noiseSuppression: flag(o.noiseSuppression),
        autoGainControl: flag(o.autoGainControl),
    };
}

/** One message from the page, or null for anything malformed. */
export function readPageMessage(raw: unknown): PageMessage | null {
    const o = obj(raw);
    if (!o) return null;
    switch (o.type) {
        case 'ready':
            return { type: 'ready', apiVersion: int(o.apiVersion), appVersion: str(o.appVersion, 40) ?? '' };
        case 'state': {
            const state = readState(o.state);
            return state ? { type: 'state', state } : null;
        }
        case 'notify': {
            const n = obj(o.notification);
            const id = str(n?.id, 40);
            const title = str(n?.title);
            if (!n || !id || title === null) return null;
            const kind = n.kind === 'tasks' || n.kind === 'test' || n.kind === 'clip' ? n.kind : 'message';
            return { type: 'notify', notification: { id, title, body: str(n.body) ?? '', key: str(n.key, 120) ?? '', kind } };
        }
        case 'mic-request': {
            const offer = obj(o.offer);
            // Whole or not at all: a cut SDP is a broken one.
            const sdp = typeof offer?.sdp === 'string' && offer.sdp.length <= MAX_SDP ? offer.sdp : null;
            if (!isRequestId(o.id) || !offer || offer.type !== 'offer' || !sdp) return null;
            return { type: 'mic-request', id: o.id, constraints: readConstraints(o.constraints), offer: { type: 'offer', sdp } };
        }
        case 'mic-release':
            return isRequestId(o.id) ? { type: 'mic-release', id: o.id } : null;
        case 'share-request':
        case 'share-release':
            return isRequestId(o.id) ? { type: o.type, id: o.id } : null;
        default:
            return null;
    }
}
