// "Active in your servers": the voice channels with somebody in them, across EVERY server the
// signed-in account belongs to, not only the one open. Under the member list (Chat.tsx).
//
// Nothing here is new to the server. The roster events (StreamStarted / StreamStopped) already
// reach every member who can VIEW the room's channel, whichever server they are looking at
// (ws.rs voice_roster_audience), and GET /servers/:id/voice-users answers only a member of that
// server and only for the channels they can view. What was missing was the SNAPSHOT for the
// servers that are not open: Chat reads one for the open server alone, so a call that began while
// the socket was down, or before this client started, was never known for any other server. This
// reads it for the rest, and `reconcileRoster` keeps the shared roster (voiceState's
// globalVoiceUsers) right, exactly as Chat does for the open server.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { fetchVoiceUsers, listChannels, type Channel, type Server } from '../api/servers';
import { keys } from '../hooks/queries';
import { wsClient, type ServerMessage } from '../api/websocket';
import { globalVoiceUsers, type VoiceUserStatus } from './voiceState';

/** How often the other servers are re-read to heal anything the live events missed. */
export const OTHER_SERVERS_POLL_MS = 60_000;
/** How long a server's channel list, fetched only to name rooms, is trusted before it is read again. */
const CHANNEL_NAMES_STALE_MS = 120_000;
/** How many servers' snapshots are asked for at once. It was every one at the same moment: an
 *  account in sixty servers sent sixty reads, and a channel list for each with a call, in one burst
 *  each minute and on every reconnect. The server allows an address a burst of 100 requests
 *  (middleware/rate_limit.rs), so past it the app's own requests beside them were refused too. */
export const ACTIVE_READ_CONCURRENCY = 4;

/** `fn` over `items`, at most `limit` at a time, in order; settles when every one has, or once
 *  `stop` says so (what is already asked for finishes; nothing more starts). */
export async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>, stop: () => boolean = () => false): Promise<void> {
    let next = 0;
    const lane = async () => {
        while (next < items.length && !stop()) {
            const item = items[next++];
            await fn(item);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}

export interface ActiveUser {
    id: number;
    username: string;
}

export interface ActiveRoom {
    channelId: number;
    name: string;
    users: ActiveUser[];
}

export interface ActiveServer {
    serverId: string;
    serverName: string;
    isCurrent: boolean;
    rooms: ActiveRoom[];
}

/**
 * What the panel lists: each server, in the order the server list comes in, that has a voice room with somebody in
 * it. A room is named by its channel list, so one whose list is not here yet is left out rather
 * than shown under a guess. The AFK room is a holding pen, not activity, and is left out.
 */
export function activeServersView(args: {
    servers: readonly Pick<Server, 'id' | 'name'>[];
    currentServerId: string | null | undefined;
    channelsOf: (serverId: string) => readonly Pick<Channel, 'id' | 'name' | 'channel_type' | 'is_afk'>[] | undefined;
    rosterOf: (roomId: string) => readonly ActiveUser[];
}): ActiveServer[] {
    const out: ActiveServer[] = [];
    for (const server of args.servers) {
        const channels = args.channelsOf(server.id);
        if (!channels) continue;
        const rooms: ActiveRoom[] = [];
        for (const c of channels) {
            if (c.channel_type !== 1 || c.is_afk) continue;
            const users = args.rosterOf(`voice_${c.id}`);
            if (users.length > 0) rooms.push({ channelId: c.id, name: c.name, users: users.map(u => ({ id: u.id, username: u.username })) });
        }
        if (rooms.length > 0) out.push({ serverId: server.id, serverName: server.name, isCurrent: server.id === args.currentServerId, rooms });
    }
    return out;
}

/** How many people are in the panel, counting each room's occupants (one person in two servers is two). */
export function activePeople(view: readonly ActiveServer[]): number {
    return view.reduce((n, s) => n + s.rooms.reduce((m, r) => m + r.users.length, 0), 0);
}

/**
 * The rooms to write into the shared roster after reading a server's snapshot: every room named
 * in `prune` or in the snapshot, rebuilt from the snapshot, keeping what is already known of a
 * person who stays (their mute and deafen: the snapshot does not carry them), and dropping a
 * person it no longer lists. A room in `prune` that the snapshot does not mention comes back
 * empty, which is how someone who left while this device was not listening stops showing.
 */
export function reconcileRoster(
    existing: ReadonlyMap<string, ReadonlyMap<number, VoiceUserStatus>>,
    snapshot: readonly { room_id: string; user_id: number; username: string }[],
    prune: Iterable<string>,
): Map<string, Map<number, VoiceUserStatus>> {
    const byRoom = new Map<string, { user_id: number; username: string }[]>();
    for (const vu of snapshot) {
        if (!byRoom.has(vu.room_id)) byRoom.set(vu.room_id, []);
        byRoom.get(vu.room_id)!.push(vu);
    }
    const rooms = new Set<string>([...prune, ...byRoom.keys()]);
    const out = new Map<string, Map<number, VoiceUserStatus>>();
    for (const roomId of rooms) {
        const kept = existing.get(roomId);
        const rebuilt = new Map<number, VoiceUserStatus>();
        for (const vu of byRoom.get(roomId) ?? []) {
            rebuilt.set(vu.user_id, kept?.get(vu.user_id) ?? { id: vu.user_id, username: vu.username, isMuted: false, isDeafened: false });
        }
        out.set(roomId, rebuilt);
    }
    return out;
}

/** The voice rooms a cached channel list names. */
function voiceRoomIds(channels: readonly Pick<Channel, 'id' | 'channel_type'>[] | undefined): string[] {
    return (channels ?? []).filter(c => c.channel_type === 1).map(c => `voice_${c.id}`);
}

/** Whether the reading of the other servers has happened, and whether all of it did. */
export type ActiveReadStatus = 'loading' | 'ok' | 'partial';

/**
 * Keeps the shared roster right for every server but the open one, while the panel is on, and says
 * whether that has been read yet and all of it (so the panel never says "nobody" about what it has not
 * been able to see). One read runs at a time: a trigger that comes while one is running makes it run
 * once more afterwards, not alongside.
 * `eventSeq` is Chat's counter of roster events: a snapshot read while one arrived is dropped (the
 * next read heals it), as Chat does for the open server, because the event is newer than it.
 * `onChange` is called when something here changed what the panel would draw.
 */
export function useActiveInServers(opts: {
    enabled: boolean;
    servers: readonly Pick<Server, 'id'>[];
    currentServerId: string | null | undefined;
    eventSeq: () => number;
    /** The room this client is in a call in, if any: its roster belongs to the call's own panel, which writes
     *  people it has not heard the server announce yet, so this leaves that one room alone. */
    callRoomId?: string | null;
    onChange: () => void;
}): ActiveReadStatus {
    const queryClient = useQueryClient();
    const [status, setStatus] = useState<ActiveReadStatus>('loading');
    // The rooms each server's snapshot has named so far: pruned when it stops naming them.
    const seeded = useRef(new Map<string, Set<string>>());
    const latest = useRef(opts);
    // After every render, so the reads below see the newest servers, callbacks and call.
    useEffect(() => { latest.current = opts; });
    const serversKey = opts.servers.map(s => s.id).join(',');

    useEffect(() => {
        if (!opts.enabled) return;
        let cancelled = false;
        let running = false;
        let again = false;
        // The one timer that asks for a read later: a retry, or a call heard of in a room not yet named.
        let laterTimer: number | undefined;
        const later = (ms: number) => {
            window.clearTimeout(laterTimer);
            laterTimer = window.setTimeout(() => { void run(); }, ms);
        };
        const run = async (attempt = 0): Promise<void> => {
            if (cancelled || document.visibilityState === 'hidden') return;
            if (running) { again = true; return; }
            running = true;
            let dropped = false;
            let failed = false;
            let changed = false;
            const { servers, currentServerId, eventSeq, onChange } = latest.current;
            try {
                await eachLimited(servers.filter(s => s.id !== currentServerId), ACTIVE_READ_CONCURRENCY, async server => {
                    const seqAtFetch = eventSeq();
                    let occupants: Awaited<ReturnType<typeof fetchVoiceUsers>>['voice_users'];
                    try {
                        // An answer that is not the list it should be is the same as none: nothing is changed by it.
                        const answer = await fetchVoiceUsers(server.id);
                        if (!Array.isArray(answer?.voice_users)) { failed = true; return; }
                        occupants = answer.voice_users;
                    } catch {
                        failed = true; // no longer a member, or the server is unreachable: the next read tries again
                        return;
                    }
                    if (cancelled) return;
                    if (eventSeq() !== seqAtFetch) { dropped = true; return; }
                    const before = seeded.current.get(server.id) ?? new Set<string>();
                    // A server with somebody in voice, or one that had: its channel list names the rooms.
                    const cached = queryClient.getQueryData<Channel[]>(keys.channels(server.id));
                    let channels = cached;
                    if (occupants.length > 0 || before.size > 0) {
                        try {
                            channels = await fetchChannelNames(queryClient, server.id);
                        } catch {
                            if (!cached) failed = true; // rooms it cannot name are rooms the panel cannot show
                        }
                        if (cancelled) return;
                        if (eventSeq() !== seqAtFetch) { dropped = true; return; }
                        // The panel names a room by this list: a list it did not have, or a newer one, is a change
                        // even when nobody moved (a call heard of by its event before the server's list was here).
                        if (channels !== cached) changed = true;
                    }
                    // Read now, not when the read began: a call joined meanwhile is the call's own to write.
                    const callRoomId = latest.current.callRoomId;
                    const prune = new Set<string>([...before, ...voiceRoomIds(channels)]);
                    if (callRoomId) prune.delete(callRoomId);
                    const next = reconcileRoster(globalVoiceUsers, occupants.filter(v => v.room_id !== callRoomId), prune);
                    const nowSeeded = new Set<string>();
                    for (const [roomId, users] of next) {
                        const was = globalVoiceUsers.get(roomId);
                        if (users.size > 0) nowSeeded.add(roomId);
                        if (!sameRoster(was, users)) changed = true;
                        if (users.size > 0 || was) globalVoiceUsers.set(roomId, users);
                    }
                    seeded.current.set(server.id, nowSeeded);
                    // A read nobody waits for any more (another server opened, the panel gone, a
                    // sign-out) asks for nothing more: its lanes went on through every server.
                }, () => cancelled);
            } finally {
                running = false;
            }
            if (cancelled) return;
            setStatus(failed || dropped ? 'partial' : 'ok');
            if (changed) onChange();
            // A roster event arrived while a snapshot was in flight, so the snapshot was dropped as
            // older than it: read again shortly, a few times at most. Else a trigger that came while
            // this ran is answered once, now.
            if (dropped && attempt < 3) later(2_000);
            else if (again) { again = false; void run(); }
        };
        void run();
        const timer = window.setInterval(() => { void run(); }, OTHER_SERVERS_POLL_MS);
        const onConnected = () => { void run(); };
        // A call began in a room no channel list here names yet (a server never opened, a new room):
        // the event carries no server, so read the snapshots to find which one it is. A burst of these
        // is one read, a moment after the last.
        const onStarted = (msg: ServerMessage) => {
            const roomId = (msg.payload as { room_id?: string } | undefined)?.room_id;
            if (!roomId || !latest.current.servers.some(s => s.id !== latest.current.currentServerId)) return;
            const named = latest.current.servers.some(s => voiceRoomIds(queryClient.getQueryData<Channel[]>(keys.channels(s.id))).includes(roomId));
            if (!named) later(500);
        };
        window.addEventListener('wsConnected', onConnected);
        document.addEventListener('visibilitychange', onConnected);
        wsClient.on('StreamStarted', onStarted);
        return () => {
            cancelled = true;
            window.clearTimeout(laterTimer);
            wsClient.off('StreamStarted', onStarted);
            window.clearInterval(timer);
            window.removeEventListener('wsConnected', onConnected);
            document.removeEventListener('visibilitychange', onConnected);
        };
    }, [opts.enabled, serversKey, opts.currentServerId, queryClient]);
    return status;
}

async function fetchChannelNames(queryClient: QueryClient, serverId: string): Promise<Channel[]> {
    return queryClient.fetchQuery({
        queryKey: keys.channels(serverId),
        queryFn: () => listChannels(serverId),
        staleTime: CHANNEL_NAMES_STALE_MS,
    });
}

function sameRoster(a: ReadonlyMap<number, VoiceUserStatus> | undefined, b: ReadonlyMap<number, VoiceUserStatus>): boolean {
    const size = a?.size ?? 0;
    if (size !== b.size) return false;
    if (!a) return true;
    for (const id of b.keys()) if (!a.has(id)) return false;
    return true;
}
