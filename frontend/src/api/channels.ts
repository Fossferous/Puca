import { apiClient } from './client';

// The Channel type lives in servers.ts alongside the rest of the channel
// CRUD; re-export it so channel-scoped modules have one import site.
export type { Channel } from './servers';

// --- Channel Permission Overwrites ---
//
// Per-channel allow/deny masks layered over a role's server-level permission
// bits (see api/permissionBits.ts). A bit in neither mask inherits from the
// role; allow and deny must never overlap (the backend rejects it with 400).

export interface ChannelOverwrite {
    role_id: number;
    allow: number;
    deny: number;
}

export function getChannelOverwrites(channelId: number): Promise<ChannelOverwrite[]> {
    return apiClient.get(`/channels/${channelId}/overwrites`);
}

export function putChannelOverwrite(channelId: number, roleId: number, allow: number, deny: number): Promise<void> {
    return apiClient.put(`/channels/${channelId}/overwrites/${roleId}`, { allow, deny });
}

export function deleteChannelOverwrite(channelId: number, roleId: number): Promise<void> {
    return apiClient.delete(`/channels/${channelId}/overwrites/${roleId}`);
}
