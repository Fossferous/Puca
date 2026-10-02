
import { useQuery } from '@tanstack/react-query';
import * as api from '../api/servers';
import { ingestPresenceSnapshot } from '../api/presenceStore';

// --- Keys ---

export const keys = {
    servers: ['servers'] as const,
    server: (id: string) => [...keys.servers, id] as const,
    channels: (serverId: string) => [...keys.server(serverId), 'channels'] as const,
    members: (serverId: string) => [...keys.server(serverId), 'members'] as const,
    messages: (channelId: number) => ['channels', channelId, 'messages'] as const,
};

// --- Queries ---

export function useServers() {
    return useQuery({
        queryKey: keys.servers,
        queryFn: api.listServers,
    });
}

export function useChannels(serverId: string) {
    return useQuery({
        queryKey: keys.channels(serverId),
        queryFn: () => api.listChannels(serverId),
        enabled: !!serverId,
    });
}

/**
 * The member list, with its presence fed to the presence store — stamped with
 * the moment the request STARTED, so a status pushed while this poll was in
 * flight is not painted over by the older answer (api/presenceStore.ts).
 * Every fetch of `keys.members` goes through here.
 */
export async function fetchMembersWithPresence(serverId: string): Promise<api.MemberWithRoles[]> {
    const startedAt = Date.now();
    const rows = await api.listMembersWithRoles(serverId);
    ingestPresenceSnapshot(rows, startedAt);
    return rows;
}

export function useServerMembers(serverId: string) {
    return useQuery({
        queryKey: keys.members(serverId),
        queryFn: () => fetchMembersWithPresence(serverId),
        enabled: !!serverId,
        refetchInterval: 10000,
    });
}
