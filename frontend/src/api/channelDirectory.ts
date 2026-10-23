/**
 * Which server each channel is listed under, and the names people see for
 * both, learnt from the client's OWN lists: GET /servers and
 * GET /servers/:id/channels, the answers the rail and the sidebar render.
 *
 * channelKeys.ts holds a channel key's wrap set to the member list a person
 * can see for the channel's server (audit 2026-10, F-2), and is handed a
 * channel id and nothing else. Taking the server from the key endpoints'
 * own answers would let the server choose the list it is checked against;
 * this is where the channel actually appears. The names are for the notice
 * that names the channel.
 */
import { apiClient } from './client';

const channelServer = new Map<number, string>();
const channelNames = new Map<number, string>();
const serverNames = new Map<string, string>();
/** Channels some list of ours put under two different servers: no honest
 *  server does that, so their server is unknown rather than a guess. */
const conflicted = new Set<number>();
let walk: Promise<void> | null = null;
/** When a walk last failed to find a channel: not walked again for a minute,
 *  or every send in it would cost a request per server. */
const missedAt = new Map<number, number>();
const MISS_RETRY_MS = 60_000;

/** Record a server's channel list (servers.ts listChannels calls this). */
export function noteChannels(serverId: string, list: ReadonlyArray<{ id: number; name?: string }>): void {
    for (const c of list) {
        const prev = channelServer.get(c.id);
        if (prev !== undefined && prev !== serverId) conflicted.add(c.id);
        channelServer.set(c.id, serverId);
        if (c.name) channelNames.set(c.id, c.name);
    }
}

/** Record the user's server list (servers.ts listServers calls this). */
export function noteServers(list: ReadonlyArray<{ id: string; name?: string }>): void {
    for (const s of list) if (s.name) serverNames.set(s.id, s.name);
}

export function channelName(channelId: number): string | null {
    return channelNames.get(channelId) ?? null;
}

export function serverName(serverId: string): string | null {
    return serverNames.get(serverId) ?? null;
}

/**
 * The server `channelId` is listed under, or null when none of our lists
 * places it there unambiguously. A channel not seen yet (a voice channel
 * rejoined before its server's list was fetched) is looked for once, through
 * the user's own server list.
 */
export async function serverOfChannel(channelId: number): Promise<string | null> {
    const missed = missedAt.get(channelId);
    if (!channelServer.has(channelId) && (missed === undefined || Date.now() - missed > MISS_RETRY_MS)) {
        // One walk at a time, and a WHOLE one: callers waiting on it may be
        // looking for different channels.
        walk ??= (async () => {
            let servers: Array<{ id: string; name?: string }>;
            try {
                servers = await apiClient.get('/servers');
                if (!Array.isArray(servers)) return;
                noteServers(servers);
            } catch {
                return; // offline: unknown
            }
            for (const s of servers) {
                try {
                    noteChannels(s.id, await apiClient.get(`/servers/${s.id}/channels`));
                } catch {
                    // A server we can no longer read: the channel may be in
                    // the next one.
                }
            }
        })().finally(() => { walk = null; });
        await walk;
        if (!channelServer.has(channelId)) missedAt.set(channelId, Date.now());
    }
    if (conflicted.has(channelId)) return null;
    return channelServer.get(channelId) ?? null;
}

/** Forget everything (sign-out). */
export function clearChannelDirectory(): void {
    channelServer.clear();
    channelNames.clear();
    serverNames.clear();
    conflicted.clear();
    missedAt.clear();
}
