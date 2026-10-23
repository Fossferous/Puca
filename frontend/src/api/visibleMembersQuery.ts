/**
 * The app's answer to channelKeys.ts's "who can the person see as members of
 * this server?" (audit 2026-10, F-2): THE query the member sidebar renders
 * (hooks/queries.ts keys.members), so the check and the screen read one
 * answer. main.tsx installs it with setVisibleMembersSource.
 *
 * `fresh` is the read past the cache that comes before anyone is refused, so
 * it has to be a request made NOW. fetchQuery alone does not promise that:
 * while a fetch of the same query is in flight (the sidebar's poll, say) it
 * hands back THAT fetch's answer, and that fetch's query may have run before
 * the member being asked about joined (second review, finding 3). The member
 * was then refused and reported, and the epoch minted without them satisfied
 * the member generation, so they stayed locked out until the next join or
 * leave. A fresh read therefore cancels any fetch in flight first: cancelling
 * reverts the query to its last settled data, our fetch replaces that, and the
 * sidebar's poll simply comes round again.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { VisibleMembersSource } from './channelKeys';

export function visibleMembersFromQueries<T extends { id: number }>(
    queryClient: QueryClient,
    queryKey: (serverId: string) => readonly unknown[],
    fetchMembers: (serverId: string) => Promise<T[]>,
): VisibleMembersSource {
    return async (serverId, fresh) => {
        const key = queryKey(serverId);
        if (fresh) await queryClient.cancelQueries({ queryKey: key, exact: true });
        return queryClient.fetchQuery({
            queryKey: key,
            queryFn: () => fetchMembers(serverId),
            staleTime: fresh ? 0 : 10_000,
        });
    };
}
