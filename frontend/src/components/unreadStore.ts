/**
 * Cross-server unread totals for the SERVER RAIL bubbles.
 *
 * Lives outside Chat's component state because ServerList is a sibling, not a
 * child: Chat hydrates and bumps this store, ServerList renders it. Counts are
 * per-server totals, hydrated from GET /unread and nudged live by
 * MessageNotification — the poll remains authoritative (a live bump is an
 * increment, and increments drift; the next hydrate squares it).
 *
 * Alongside the totals the store keeps the PER-CHANNEL rows the aggregate
 * endpoint returns (0.8.58+ backends). Nothing renders them — they exist so
 * the reconnect catch-up can diff at channel granularity and honour
 * per-channel mutes the way the live path does.
 */

import { getAllUnreadCounts } from '../api/servers';

const counts = new Map<string, number>();
const channelCounts = new Map<number, number>();
const listeners = new Set<() => void>();

/** Truth flags for the snapshot API. `hydrated` distinguishes "no unread"
 *  from "never asked" — snapshotting an empty never-hydrated map as a gap
 *  baseline would make every standing unread look like gap growth.
 *  `channelRowsSeen` marks that the backend actually sends per-channel rows
 *  (an old backend omits them, and an empty channel map must then read as
 *  "unavailable", not "everything is read"). */
let hydrated = false;
let channelRowsSeen = false;

function emit(): void {
    for (const l of listeners) l();
}

export function subscribeServerUnread(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function serverUnreadCount(serverId: string): number {
    return counts.get(serverId) ?? 0;
}

/** Authoritative rehydrate from the aggregate endpoint. Guarded so a slow
 *  earlier request resolving after a newer one cannot apply its stale counts
 *  (mount + wsConnected + the poll can all be in flight together). */
let hydrateSeq = 0;
export async function hydrateServerUnread(): Promise<void> {
    const seq = ++hydrateSeq;
    try {
        const res = await getAllUnreadCounts();
        if (seq !== hydrateSeq) return; // a newer hydrate superseded this one
        counts.clear();
        channelCounts.clear();
        for (const s of res.servers) {
            counts.set(s.server_id, s.unread_count);
            if (s.channels) {
                channelRowsSeen = true;
                for (const c of s.channels) channelCounts.set(c.channel_id, c.unread_count);
            }
        }
        hydrated = true;
        emit();
    } catch (err) {
        console.warn('[unread] failed to hydrate server unread counts:', err);
    }
}

/** Point-in-time copy, taken by the reconnect catch-up when the socket dies:
 *  what the rail knew at that moment is the baseline "already seen" state the
 *  post-gap counts are diffed against. null until the first hydrate — an
 *  unhydrated map is not a baseline, it is ignorance. */
export function snapshotServerUnread(): Map<string, number> | null {
    return hydrated ? new Map(counts) : null;
}

/** The per-channel sibling. null until a hydrate that actually carried
 *  channel rows (0.8.58+ backend) — callers fall back to the server totals. */
export function snapshotChannelUnread(): Map<number, number> | null {
    return hydrated && channelRowsSeen ? new Map(channelCounts) : null;
}

/** Live nudge from a MessageNotification for a channel NOT on screen. The
 *  channel id keeps the catch-up's per-channel baseline current between
 *  hydrates; older call sites without one still bump the server total. */
export function bumpServerUnread(serverId: string, channelId?: number): void {
    counts.set(serverId, (counts.get(serverId) ?? 0) + 1);
    if (channelId !== undefined) {
        channelCounts.set(channelId, (channelCounts.get(channelId) ?? 0) + 1);
    }
    emit();
}

/** The whole server was marked read: zero it immediately. The channel rows
 *  for it go stale-HIGH until the next hydrate, which only mutes the diff
 *  (a too-high baseline can miss, never falsely ping). */
export function clearServerUnread(serverId: string): void {
    if (counts.delete(serverId)) emit();
}

/** A single channel was read. We cannot know how much of the server's total
 *  that channel accounted for, so rehydrate (trailing-debounced) rather than
 *  guess — a burst of mark-reads becomes one fetch. */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
export function refreshServerUnreadSoon(): void {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void hydrateServerUnread();
    }, 800);
}
