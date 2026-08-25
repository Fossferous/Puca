/**
 * Reconnect catch-up (Android): turn "missed while the socket was down" from
 * permanently lost into merely late.
 *
 * Delivery here is the app's own WebSocket — there is no push relay — and the
 * backend's fan-out is fire-and-forget with no queue or replay: a
 * MessageNotification/DirectMessage sent while this device had no live session
 * is gone. Every background failure mode (Doze pausing the network, a carrier
 * NAT dropping the TCP, wifi→cell handover) therefore ended as total silence:
 * by the time the socket came back nothing re-delivered what was missed.
 *
 * This module closes that seam client-side. When the socket dies it snapshots
 * what this device had already seen (the live-maintained server unread state,
 * and each DM conversation's last-message time). When the socket comes back
 * WHILE THE APP IS STILL HIDDEN, it fetches the post-gap state and posts
 * content-free notifications for the difference — through the exact same
 * notifyNewMessage gates and notifyKeys as live delivery, so a catch-up
 * replaces the live notification it stands in for rather than stacking.
 *
 * Reconnecting while the app is VISIBLE posts nothing: the user is looking at
 * the in-app unread state, which is this feature's desktop-parity behaviour.
 *
 * A DELIBERATE close (logout, session expiry — wsClosed with
 * detail.deliberate, same convention as the device-session layer) is the end
 * of a session, not a gap: every baseline belongs to the account that just
 * left and is dropped, or the next sign-in would diff a different account's
 * world against it and announce days-old, long-read messages.
 *
 * A gap whose catch-up FETCH fails needs no special recovery: nothing local
 * advances while disconnected or on a failed fetch, so the next close
 * re-freezes the same pre-gap baselines and the eventual successful
 * reconnect diffs across the union of the gaps. Only a transient REST error
 * on a healthy socket can drop a diff, and the next real gap self-corrects.
 *
 * CLOCK note: see reconnectCatchupCore.ts — all compared timestamps are
 * server-generated; the client clock is never consulted.
 */
import { isAndroidApp } from './platform';
import { getAllUnreadCounts } from './servers';
import { listDMConversations, getDMMessages } from './dms';
import { getToken, decodeJwtPayload } from './auth';
import { notifyNewMessage } from './desktopNotify';
import { wsClient, type ServerMessage } from './websocket';
import { snapshotChannelUnread, snapshotServerUnread } from '../components/unreadStore';
import { isServerQuiet } from '../components/mutedServersStore';
import { isChannelMuted } from '../components/mutedChannelsStore';
import { isBlocked } from '../components/blockStore';
import { computeChannelCatchup, computeDmCandidates, computeServerCatchup, dmBaseline } from './reconnectCatchupCore';

/** At most this many "which sender?" lookups per reconnect. */
const MAX_DM_LOOKUPS = 3;
/** Per-server notifications beyond this collapse into one summary. */
const MAX_SERVER_NOTIFICATIONS = 4;
/** Refreshing the DM baseline on every app-switch would be chatty. */
const HIDDEN_REFRESH_MIN_MS = 30_000;

// --- module state ----------------------------------------------------------

/** Rolling "already seen" baseline per DM conversation (server epoch ms). */
let dmSnap: Map<string, number> | null = null;
/** Gap state, frozen at the FIRST close of the current gap. `gapActive` is
 *  the flag — the baselines themselves may legitimately be null (nothing
 *  hydrated yet), and null-as-flag would re-freeze on every retry close. */
let gapActive = false;
let gapDmSnap: Map<string, number> | null = null;
let gapServerSnap: Map<string, number> | null = null;
let gapChannelSnap: Map<number, number> | null = null;
let lastDmRefresh = 0;
/** Supersession guard for overlapping runs (a network flap can start a second
 *  runCatchup while the first is mid-await); mirrors unreadStore.hydrateSeq. */
let catchupSeq = 0;

function resetBaselines(): void {
    dmSnap = null;
    gapActive = false;
    gapDmSnap = null;
    gapServerSnap = null;
    gapChannelSnap = null;
    lastDmRefresh = 0;
    catchupSeq++;   // orphan any in-flight run's writes
}

/** Logout hook (App.tsx) — the baselines are per-account state, same contract
 *  as clearing the block store. The deliberate-close handler below already
 *  covers every current logout path; this export is the belt to its braces. */
export function resetReconnectCatchup(): void {
    resetBaselines();
}

function myUserId(): number | null {
    const t = getToken();
    if (!t) return null;
    const p = decodeJwtPayload(t);
    return typeof p?.sub === 'number' ? p.sub : null;
}

/** Fold live advances (DirectMessage frames seen during our awaits) into a
 *  freshly-fetched baseline: keep whichever timestamp is newer. Without this
 *  the assignment below rolls the baseline back past messages the live path
 *  already delivered, and the NEXT gap re-announces them. */
function mergeNewer(fresh: Map<string, number>, prev: Map<string, number> | null): Map<string, number> {
    if (prev) {
        for (const [id, at] of prev) {
            const f = fresh.get(id);
            if (f === undefined || at > f) fresh.set(id, at);
        }
    }
    return fresh;
}

async function runCatchup(
    serverGap: Map<string, number> | null,
    channelGap: Map<number, number> | null,
    dmGap: Map<string, number> | null,
): Promise<void> {
    const seq = ++catchupSeq;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';

    // SERVER half — deliberately independent of the DM fetch below, so a
    // failing /dms cannot cancel it (nor vice versa).
    if (hidden && serverGap) {
        try {
            const fresh = (await getAllUnreadCounts()).servers;
            if (seq === catchupSeq) {
                // Channel-granular when both sides can (0.8.58+ backend rows
                // and a baseline that saw them) — that is what honours
                // per-channel mutes. Otherwise the server-total fallback.
                const grown = channelGap && fresh.every(s => Array.isArray(s.channels))
                    ? computeChannelCatchup(channelGap, fresh, isServerQuiet, isChannelMuted)
                    : computeServerCatchup(serverGap, fresh, isServerQuiet);
                if (grown.length > MAX_SERVER_NOTIFICATIONS) {
                    notifyNewMessage({
                        title: 'New messages arrived while you were away',
                        isOwn: false, isMuted: false, notifyKey: 'catchup:servers',
                    });
                } else {
                    for (const serverId of grown) {
                        // Same key and nav as the live cross-channel path, so
                        // this replaces the notification the live path would
                        // have posted.
                        notifyNewMessage({
                            title: 'New messages arrived',
                            isOwn: false, isMuted: false,
                            notifyKey: `chan:${serverId}`,
                            nav: `server:${serverId}`,
                        });
                    }
                }
            }
        } catch {
            // Offline again, or a transient REST error — see the module
            // comment: the next gap diffs across the union.
        }
    }

    // DM half. The baseline refresh happens on EVERY successful connect —
    // it is the "seen" state the next gap will diff against.
    try {
        const convs = await listDMConversations();
        const freshDmSnap = dmBaseline(convs);

        if (hidden && dmGap && seq === catchupSeq) {
            const me = myUserId();
            const candidates = computeDmCandidates(dmGap, convs);
            let extras = Math.max(0, candidates.length - MAX_DM_LOOKUPS);
            for (const conv of candidates.slice(0, MAX_DM_LOOKUPS)) {
                if (seq !== catchupSeq) return;   // superseded mid-lookup
                try {
                    // The list has no sender — fetch the tail message to avoid
                    // pinging you about a DM you sent from the desktop.
                    const [last] = await getDMMessages(conv.id, 1);
                    if (!last || (me !== null && last.sender_id === me)) continue;
                    // The live path never pings for blocked senders; the
                    // catch-up must not become their way around that.
                    if (isBlocked(last.sender_id)) continue;
                    notifyNewMessage({
                        title: `${conv.other_display_name || conv.other_username} sent you a message`,
                        isOwn: false, isMuted: false,
                        notifyKey: `dm:${conv.id}`,
                        nav: `dm:${conv.id}`,
                    });
                } catch {
                    // Can't attribute it; count it into the summary instead of
                    // guessing (a wrong per-person ping is worse than a generic
                    // one).
                    extras++;
                }
            }
            if (extras > 0) {
                notifyNewMessage({
                    title: 'New messages arrived while you were away',
                    // Distinct from the server summary key — they must stack,
                    // not silently replace each other.
                    isOwn: false, isMuted: false, notifyKey: 'catchup:dms', nav: 'dms',
                });
            }
        }

        if (seq === catchupSeq) {
            dmSnap = mergeNewer(freshDmSnap, dmSnap);
            lastDmRefresh = Date.now();
        }
    } catch {
        // Keep the previous baseline; see the module comment.
    }
}

/**
 * Boot-time install (main.tsx, Android only). Listens on the window events the
 * WS client already emits — no coupling into its lifecycle.
 */
export function installReconnectCatchup(): void {
    if (!isAndroidApp() || typeof window === 'undefined') return;

    window.addEventListener('wsClosed', (e: Event) => {
        // Logout / session expiry: end of THIS account's world, not a gap.
        if ((e as CustomEvent<{ deliberate?: boolean }>).detail?.deliberate === true) {
            resetBaselines();
            return;
        }
        // First close of a gap freezes the baselines; retry closes keep them.
        if (!gapActive) {
            gapActive = true;
            gapServerSnap = snapshotServerUnread();     // null until first hydrate
            gapChannelSnap = snapshotChannelUnread();   // null on old backends too
            gapDmSnap = dmSnap === null ? null : new Map(dmSnap);
        }
    });

    window.addEventListener('wsConnected', () => {
        const serverGap = gapActive ? gapServerSnap : null;
        const channelGap = gapActive ? gapChannelSnap : null;
        const dmGap = gapActive ? gapDmSnap : null;
        gapActive = false;
        gapServerSnap = null;
        gapChannelSnap = null;
        gapDmSnap = null;
        void runCatchup(serverGap, channelGap, dmGap);
    });

    // Keep the per-conversation baseline live while connected, from the same
    // server-stamped frames Chat renders. Without this, a DM read in the app
    // and then a later gap would re-announce the already-seen message.
    wsClient.on('DirectMessage', (msg: ServerMessage) => {
        const p = msg.payload as { conversation_id?: string; timestamp?: number } | undefined;
        if (dmSnap && p?.conversation_id && typeof p.timestamp === 'number') {
            dmSnap.set(p.conversation_id, p.timestamp * 1000);
        }
    });

    // Backgrounding is the moment before most gaps: refresh the DM baseline
    // so the diff measures the gap, not the whole session. Debounced — an
    // app-switch flurry must not turn into a fetch storm.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') return;
        if (!getToken()) return;
        if (Date.now() - lastDmRefresh < HIDDEN_REFRESH_MIN_MS) return;
        lastDmRefresh = Date.now();
        const seq = catchupSeq;
        void listDMConversations()
            .then(cs => {
                // Same supersession + merge discipline as runCatchup: never
                // roll the baseline back past a live advance.
                if (seq === catchupSeq) dmSnap = mergeNewer(dmBaseline(cs), dmSnap);
            })
            .catch(() => { /* keep the previous baseline */ });
    });
}
