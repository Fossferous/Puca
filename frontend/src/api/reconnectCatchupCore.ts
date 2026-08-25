/**
 * The pure diff logic behind reconnectCatchup.ts, in a module with no
 * imports so the tests exercise exactly what ships without dragging the
 * api-client/e2ee import graph into the rig.
 *
 * CLOCKS: every timestamp compared here is server-generated (Postgres
 * last_message_at vs the WS frame's server timestamp) — the client's clock
 * is never consulted, so device clock skew cannot mis-diff.
 */

/** WS DirectMessage timestamps are whole seconds; Postgres keeps micros.
 *  Anything inside this window of the baseline is the SAME message seen
 *  through the two representations, not a new arrival. */
export const DM_SLACK_MS = 1500;

export interface UnreadRow {
    server_id: string;
    unread_count: number;
    /** Per-channel rows (unread > 0 only); absent on pre-0.8.58 backends. */
    channels?: readonly { channel_id: number; unread_count: number }[];
}

/** Servers whose unread total GREW across the gap, quiet ones filtered out.
 *  A server absent from the baseline starts at 0 — growth from nothing is
 *  still growth. Own messages never inflate this: the backend excludes them
 *  from unread counts (m.user_id != $1). */
export function computeServerCatchup(
    gapSnap: ReadonlyMap<string, number>,
    fresh: readonly UnreadRow[],
    isQuiet: (serverId: string) => boolean,
): string[] {
    const grown: string[] = [];
    for (const s of fresh) {
        if (s.unread_count > (gapSnap.get(s.server_id) ?? 0) && !isQuiet(s.server_id)) {
            grown.push(s.server_id);
        }
    }
    return grown;
}

/** The channel-granular sibling of computeServerCatchup, used when both the
 *  backend sends per-channel rows AND a per-channel baseline exists. This is
 *  what lets the catch-up honour per-CHANNEL mutes the way the live path
 *  does — a server-total diff cannot tell growth in a muted channel from
 *  growth in a loud one, and "a muted channel should not find another way to
 *  speak" is this codebase's stated contract. Returns server ids with at
 *  least one grown, unmuted channel. */
export function computeChannelCatchup(
    gapChannelSnap: ReadonlyMap<number, number>,
    fresh: readonly UnreadRow[],
    isQuiet: (serverId: string) => boolean,
    isMutedChannel: (channelId: number) => boolean,
): string[] {
    const grown: string[] = [];
    for (const s of fresh) {
        if (isQuiet(s.server_id) || !s.channels) continue;
        const hit = s.channels.some(c =>
            c.unread_count > (gapChannelSnap.get(c.channel_id) ?? 0) && !isMutedChannel(c.channel_id));
        if (hit) grown.push(s.server_id);
    }
    return grown;
}

/** Conversations whose last message moved past the gap baseline, most recent
 *  first. A conversation absent from the baseline is new — include it. The
 *  caller still has to check the tail message's SENDER: last_message_at
 *  advances for your own messages sent from another device too. */
export function computeDmCandidates<T extends { id: string; last_message_at: string | null }>(
    gapSnap: ReadonlyMap<string, number>,
    convs: readonly T[],
): T[] {
    return convs
        .filter(c => {
            if (!c.last_message_at) return false;
            const at = Date.parse(c.last_message_at);
            if (Number.isNaN(at)) return false;
            const seen = gapSnap.get(c.id);
            return seen === undefined || at > seen + DM_SLACK_MS;
        })
        .sort((a, b) => Date.parse(b.last_message_at!) - Date.parse(a.last_message_at!));
}

/** The rolling "already seen" baseline: conversation id → server epoch ms. */
export function dmBaseline(
    convs: readonly { id: string; last_message_at: string | null }[],
): Map<string, number> {
    const m = new Map<string, number>();
    for (const c of convs) {
        if (!c.last_message_at) continue;
        const at = Date.parse(c.last_message_at);
        if (!Number.isNaN(at)) m.set(c.id, at);
    }
    return m;
}
