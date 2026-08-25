import type { QueryClient } from '@tanstack/react-query';
import { listChannels, type Channel } from '../api/servers';
import { keys } from '../hooks/queries';

/**
 * Resolve where the voice idle timer should move a user: the AFK channel of
 * the server the VOICE channel belongs to. That server is not necessarily the
 * one being viewed — sitting in voice on server A while browsing server B is
 * normal — so this must never be answered from the viewed server's channel
 * list. Reads the shared query cache and fetches that server's channels on a
 * miss (or when stale, per the client's staleTime).
 *
 * Returns null when no move should happen: the channel isn't in a server, is
 * already the AFK channel, or its server has no AFK channel.
 */
export async function resolveAfkTarget(
    queryClient: QueryClient,
    voiceChannel: Channel,
): Promise<Channel | null> {
    const serverId = voiceChannel.server_id;
    if (!serverId || voiceChannel.is_afk) return null;
    const siblings = await queryClient.fetchQuery({
        queryKey: keys.channels(serverId),
        queryFn: () => listChannels(serverId),
    });
    const afk = siblings.find(c => c.channel_type === 1 && c.is_afk);
    return afk && afk.id !== voiceChannel.id ? afk : null;
}
