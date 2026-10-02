/**
 * The presence store: the ONE place every status render reads from — the
 * member list (and its Online/Offline split), the friends panel and its
 * Active Now list, the profile popup, the DM search results and your own
 * profile bar.
 *
 * Before it, each surface kept its own copy. The member list patched one
 * react-query cache from UserOnline/UserOffline, the friends list had no live
 * presence at all (a 15 s poll), and nothing could show idle or away.
 *
 * Two kinds of evidence land here, with one precedence rule between them:
 *  - PUSHED frames (UserOnline, UserOffline, UserStatus), stamped on arrival;
 *  - polled REST SNAPSHOTS (member lists, friends), stamped with the moment
 *    the request STARTED. A snapshot only replaces what it is newer than, so a
 *    10 s member poll already in flight cannot paint over a status pushed
 *    while it travelled.
 * A reconnect marks everything stale (frames may have been missed in the
 * gap), so the next snapshot wins outright.
 *
 * A status this client does not know reads as online, never as offline: a
 * newer server may grow states, and an online person must not vanish.
 */
import { useSyncExternalStore } from 'react';
import { wsClient, type ServerMessage } from './websocket';

export type PresenceStatus = 'online' | 'idle' | 'away' | 'offline';

interface Entry {
    status: PresenceStatus;
    /** Date.now() of the evidence: frame arrival, or snapshot request start. */
    at: number;
}

const entries = new Map<number, Entry>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
    version++;
    listeners.forEach(l => l());
}

/** An online user's status from a wire value; unknown values read as online. */
export function normalizeStatus(isOnline: boolean, status: unknown): PresenceStatus {
    if (!isOnline) return 'offline';
    return status === 'idle' || status === 'away' ? status : 'online';
}

function put(userId: number, status: PresenceStatus, at: number): boolean {
    const prev = entries.get(userId);
    if (prev && prev.at > at) return false; // older evidence never wins
    entries.set(userId, { status, at });
    return !prev || prev.status !== status;
}

/** Feed one WebSocket frame. Ignores anything that is not presence. */
export function applyPresenceFrame(msg: ServerMessage): void {
    const p = msg.payload as Record<string, unknown> | undefined;
    const now = Date.now();
    let changed = false;
    if (msg.type === 'UserOnline') {
        const id = (p?.user as { id?: unknown } | undefined)?.id;
        // UserOnline carries no status: plain online until a UserStatus says otherwise.
        if (typeof id === 'number') changed = put(id, 'online', now);
    } else if (msg.type === 'UserOffline') {
        const id = p?.user_id;
        if (typeof id === 'number') changed = put(id, 'offline', now);
    } else if (msg.type === 'UserStatus') {
        const id = p?.user_id;
        // A UserStatus is only ever sent about someone who is online.
        if (typeof id === 'number') changed = put(id, normalizeStatus(true, p?.status), now);
    }
    if (changed) emit();
}

/** Feed a REST listing fetched by a request that started at `startedAtMs`. */
export function ingestPresenceSnapshot(
    rows: ReadonlyArray<{ id: number; is_online: boolean; status?: unknown }>,
    startedAtMs: number,
): void {
    let changed = false;
    for (const r of rows) {
        if (typeof r?.id !== 'number') continue;
        if (put(r.id, normalizeStatus(!!r.is_online, r.status), startedAtMs)) changed = true;
    }
    if (changed) emit();
}

/**
 * A user's presence: the store's answer when it has one, else the REST row
 * the caller is holding (`restIsOnline` / `restStatus`), else offline.
 */
export function presenceOf(userId: number, restIsOnline?: boolean, restStatus?: unknown): PresenceStatus {
    const e = entries.get(userId);
    if (e) return e.status;
    return normalizeStatus(!!restIsOnline, restStatus);
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

/** One user's presence; re-renders the caller only when it changes. */
export function usePresence(userId: number, restIsOnline?: boolean, restStatus?: unknown): PresenceStatus {
    return useSyncExternalStore(
        subscribe,
        () => presenceOf(userId, restIsOnline, restStatus),
        () => normalizeStatus(!!restIsOnline, restStatus),
    );
}

/**
 * Re-render on ANY presence change, for a list that reads `presenceOf` for
 * many users at once (filtering into Online / Offline sections).
 */
export function usePresenceVersion(): number {
    return useSyncExternalStore(subscribe, () => version, () => 0);
}

/** Everything known may be stale after a socket gap: let the next snapshot win. */
function markStale(): void {
    for (const e of entries.values()) e.at = 0;
}

/** The words for a status, for tooltips, aria-labels and status lines. */
export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
    online: 'Online',
    idle: 'Idle',
    away: 'Away',
    offline: 'Offline',
};

// Wired once, at import: the store must hear every frame whichever surface
// happens to be mounted (the friends panel used to hear none).
for (const type of ['UserOnline', 'UserOffline', 'UserStatus']) {
    wsClient.on(type, applyPresenceFrame);
}
if (typeof window !== 'undefined') {
    window.addEventListener('wsConnected', markStale);
    // A deliberate close is a sign-out: the next account must not inherit
    // what this one knew about anybody.
    window.addEventListener('wsClosed', (e) => {
        if ((e as CustomEvent<{ deliberate?: boolean } | undefined>).detail?.deliberate) {
            entries.clear();
            emit();
        }
    });
}

export function __resetPresenceForTests(): void {
    entries.clear();
    emit();
}
