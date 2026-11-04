/**
 * What a device says when a server goes from under it and no moderator did it:
 * RemovedFromServer's `reason` (src/protocol.rs, ServerGoneReason). A kick or a ban
 * carries no reason and has nothing to say here, as it always has.
 *
 * Never for the device that pressed Leave or Disband (Chat.tsx, ownDeparturesRef): it
 * knows what it just did. So a leave heard here happened on another device, and so does a
 * disband of a server this account owns.
 */
export function serverGoneNotice(
    reason: unknown,
    server: { name: string; owner_id: number },
    me: number,
    callEnded: boolean,
): string | null {
    let happened: string;
    if (reason === 'left') happened = `You left ${server.name} on another device`;
    else if (reason !== 'disbanded') return null;
    else if (server.owner_id === me) happened = `You disbanded ${server.name} on another device`;
    else happened = `${server.name} was disbanded by its owner`;
    return callEnded ? `${happened}, so this call ended.` : `${happened}.`;
}
