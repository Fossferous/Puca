/**
 * What the channel sidebar draws where, and two things that follow from it. No DOM.
 *
 * A collection can hold voice channels: Parent Collection and Nest Under both offer
 * it, and a mode reads it (ticking a collection takes its rooms along,
 * docs/SERVER_MODES.md). A voice channel is still drawn in one place only, the Voice
 * Channels section, where its row can join and show who is in it. A collection's own
 * list is for what you read.
 */
interface SidebarRow {
    id: number;
    name: string;
    channel_type: number;
    parent_id?: number | null;
    is_afk?: boolean;
}

/** Whether a collection's list draws this child. The feed goes further: text only. */
export function drawnUnderCollection(channel: { channel_type: number }): boolean {
    return channel.channel_type !== 1;
}

/**
 * Whether Hide Muted Channels keeps a top-level row. What is open never vanishes from
 * under the reader, a collection as much as a channel. Nor must a muted collection drag
 * its children out of the sidebar with it: the row and its subchannels render as one
 * fragment, and mute is per channel, so the row stays as the group header for whatever
 * is still drawn beneath it. A voice room is not: it is drawn in its own section.
 */
export function keptByHideMuted<C extends SidebarRow>(
    row: C,
    channels: readonly C[],
    isMuted: (channelId: number) => boolean,
    openId: number | null | undefined,
): boolean {
    if (!isMuted(row.id) || openId === row.id) return true;
    return channels.some(sub => sub.parent_id === row.id && drawnUnderCollection(sub)
        && (!isMuted(sub.id) || openId === sub.id));
}

/**
 * The ids to store after dragging one row onto another, in their new order, or null
 * if the drag moves nothing.
 *
 * The Voice Channels section is one flat list, whatever collection a room is under,
 * so it has one order. Numbering a room's collection-mates on their own used to
 * restart at 0, which threw them above every other room and tied their positions.
 * The AFK channel stays out of it: it is pinned last and does not move. Text rows and
 * collections reorder among the siblings they are drawn with.
 */
export function reorderedChannelIds<C extends SidebarRow>(
    channels: readonly C[],
    draggedId: number,
    targetId: number,
): number[] | null {
    const dragged = channels.find(c => c.id === draggedId);
    if (!dragged) return null;
    const list = dragged.channel_type === 1
        ? channels.filter(c => c.channel_type === 1 && !c.is_afk)
        : channels.filter(c => (c.parent_id ?? null) === (dragged.parent_id ?? null)
            && (c.channel_type === 0 || c.channel_type === 2));
    const from = list.findIndex(c => c.id === draggedId);
    const to = list.findIndex(c => c.id === targetId);
    if (from === -1 || to === -1 || from === to) return null;
    const ids = list.map(c => c.id);
    ids.splice(from, 1);
    ids.splice(to, 0, draggedId);
    return ids;
}

/**
 * Everything under a channel, at any depth, in list order. The foreign key cascades
 * through every level, and a collection can sit inside a collection: one made before
 * the create form stopped sending a parent for it, or through the API.
 */
function everythingUnder<C extends SidebarRow>(channels: readonly C[], channelId: number): C[] {
    const under = new Set<number>();
    const toVisit = [channelId];
    while (toVisit.length > 0) {
        const parent = toVisit.pop();
        for (const c of channels) {
            // A row has one parent, so a loop reachable from here runs through here.
            if (c.parent_id !== parent || c.id === channelId) continue;
            under.add(c.id);
            toVisit.push(c.id);
        }
    }
    return channels.filter(c => under.has(c.id));
}

/**
 * The question to ask before deleting a channel. Deleting a collection deletes
 * everything in it (the database cascades), and a voice room is not drawn under its
 * collection, so the question has to name what goes with it.
 */
export function deleteChannelQuestion<C extends SidebarRow>(channels: readonly C[], channelId: number): string {
    const inside = everythingUnder(channels, channelId);
    if (inside.length === 0) return 'Are you sure you want to delete this channel?';
    const name = channels.find(c => c.id === channelId)?.name ?? 'this collection';
    const names = inside.map(c => (c.channel_type === 0 ? `#${c.name}` : c.name)).join(', ');
    return `Delete ${name}? Everything in it is deleted too: ${names}.`;
}

/** The channel rows left after a delete: what the database's cascade took goes as well. */
export function withoutDeletedChannel<C extends SidebarRow>(channels: readonly C[], channelId: number): C[] {
    const gone = new Set(everythingUnder(channels, channelId).map(c => c.id)).add(channelId);
    return channels.filter(c => !gone.has(c.id));
}
