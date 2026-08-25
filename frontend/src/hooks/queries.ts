
import { useQuery } from '@tanstack/react-query';
import * as api from '../api/servers';

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

export function useServerMembers(serverId: string) {
    return useQuery({
        queryKey: keys.members(serverId),
        queryFn: () => api.listMembersWithRoles(serverId),
        enabled: !!serverId,
        refetchInterval: 10000,
    });
}
