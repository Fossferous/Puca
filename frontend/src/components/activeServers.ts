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
import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { fetchVoiceUsers, listChannels, type Channel, type Server } from '../api/servers';
import { keys } from '../hooks/queries';
import { wsClient, type ServerMessage } from '../api/websocket';
import { globalVoiceUsers, type VoiceUserStatus } from './voiceState';

/** How often the other servers are re-read to heal anything the live events missed. */
export const OTHER_SERVERS_POLL_MS = 60_000;
/** How long a server's channel list, fetched only to name rooms, is trusted before it is read again. */
const CHANNEL_NAMES_STALE_MS = 120_000;

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
 * What the panel lists: each server, in the rail's order, that has a voice room with somebody in
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

/**
 * Keeps the shared roster right for every server but the open one, while the panel is on.
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
}): void {
    const queryClient = useQueryClient();
    // The rooms each server's snapshot has named so far: pruned when it stops naming them.
    const seeded = useRef(new Map<string, Set<string>>());
    const latest = useRef(opts);
    // After every render, so the reads below see the newest servers, callbacks and call.
    useEffect(() => { latest.current = opts; });
    const serversKey = opts.servers.map(s => s.id).join(',');

    useEffect(() => {
        if (!opts.enabled) return;
        let cancelled = false;
        let retry: number | undefined;
        const run = async (attempt = 0) => {
            if (document.visibilityState === 'hidden') return;
            let dropped = false;
            const { servers, currentServerId, eventSeq, onChange, callRoomId } = latest.current;
            let changed = false;
            await Promise.all(servers.filter(s => s.id !== currentServerId).map(async server => {
                const seqAtFetch = eventSeq();
                let snapshot: Awaited<ReturnType<typeof fetchVoiceUsers>>;
                try {
                    snapshot = await fetchVoiceUsers(server.id);
                } catch {
                    return; // no longer a member, or the server is unreachable: the next read tries again
                }
                if (cancelled) return;
                if (eventSeq() !== seqAtFetch) { dropped = true; return; }
                const before = seeded.current.get(server.id) ?? new Set<string>();
                // A server with somebody in voice, or one that had: its channel list names the rooms.
                const cached = queryClient.getQueryData<Channel[]>(keys.channels(server.id));
                let channels = cached;
                if (snapshot.voice_users.length > 0 || before.size > 0) {
                    try {
                        channels = await fetchChannelNames(queryClient, server.id);
                    } catch { /* keep any cached list */ }
                    if (cancelled) return;
                    if (eventSeq() !== seqAtFetch) { dropped = true; return; }
                    // The panel names a room by this list: a list it did not have, or a newer one, is a change
                    // even when nobody moved (a call heard of by its event before the server's list was here).
                    if (channels !== cached) changed = true;
                }
                const prune = new Set<string>([...before, ...voiceRoomIds(channels)]);
                if (callRoomId) prune.delete(callRoomId);
                const next = reconcileRoster(globalVoiceUsers, snapshot.voice_users.filter(v => v.room_id !== callRoomId), prune);
                const nowSeeded = new Set<string>();
                for (const [roomId, users] of next) {
                    const was = globalVoiceUsers.get(roomId);
                    if (users.size > 0) nowSeeded.add(roomId);
                    if (!sameRoster(was, users)) changed = true;
                    if (users.size > 0 || was) globalVoiceUsers.set(roomId, users);
                }
                seeded.current.set(server.id, nowSeeded);
            }));
            if (changed && !cancelled) onChange();
            // A roster event arrived while a snapshot was in flight, so the snapshot was dropped as
            // older than it: read again shortly, a few times at most.
            if (dropped && !cancelled && attempt < 3) retry = window.setTimeout(() => { void run(attempt + 1); }, 2_000);
        };
        void run();
        const timer = window.setInterval(() => { void run(); }, OTHER_SERVERS_POLL_MS);
        const onConnected = () => { void run(); };
        // A call began in a room no channel list here names yet (a server never opened, a new room):
        // the event carries no server, so read the snapshots to find which one it is.
        const onStarted = (msg: ServerMessage) => {
            const roomId = (msg.payload as { room_id?: string } | undefined)?.room_id;
            if (!roomId || !latest.current.servers.some(s => s.id !== latest.current.currentServerId)) return;
            const named = latest.current.servers.some(s => voiceRoomIds(queryClient.getQueryData<Channel[]>(keys.channels(s.id))).includes(roomId));
            if (!named) window.setTimeout(() => { if (!cancelled) void run(); }, 500);
        };
        window.addEventListener('wsConnected', onConnected);
        document.addEventListener('visibilitychange', onConnected);
        wsClient.on('StreamStarted', onStarted);
        return () => {
            cancelled = true;
            window.clearTimeout(retry);
            wsClient.off('StreamStarted', onStarted);
            window.clearInterval(timer);
            window.removeEventListener('wsConnected', onConnected);
            document.removeEventListener('visibilitychange', onConnected);
        };
    }, [opts.enabled, serversKey, opts.currentServerId, queryClient]);
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
