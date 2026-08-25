/** Pure helpers for the clip composer (tested without React). */
import { MIN_CLIP_SECONDS } from './clipsGate';
import { hasPerm, PERM } from '../permissionBits';
import type { Channel } from '../servers';
import type { OutgoingProposal } from './clipProposals';

export const CHIP_SECONDS = [30, 60, 120, 300];

/** Which duration chips to offer: standard steps under the cap, plus the cap
 *  itself when it is not one of them (a "max" chip). The cap is the smaller of
 *  the server policy and what is actually buffered — a chip the server would
 *  400 on must never render. */
export function durationChips(maxSeconds: number, bufferedSeconds: number): number[] {
    const cap = Math.floor(Math.min(maxSeconds, bufferedSeconds));
    if (cap < MIN_CLIP_SECONDS) return [];
    const chips = CHIP_SECONDS.filter(c => c <= cap);
    if (!chips.includes(cap)) chips.push(cap);
    return chips;
}

/** Text channels of the voice server this user can post in (VIEW + SEND). A
 *  channel without `my_permissions` (older list shape) is offered; the server
 *  is the authority and answers 403 if it disagrees. */
export function postableChannels(all: Channel[], serverId: string | null): Channel[] {
    return all.filter(c => c.channel_type === 0 && (serverId === null || c.server_id === serverId)
        && (c.my_permissions === undefined || (hasPerm(c.my_permissions, PERM.VIEW_CHANNEL) && hasPerm(c.my_permissions, PERM.SEND_MESSAGES))));
}

/** Where a clip may be posted on this server — and when nowhere, exactly WHY.
 *
 *  There is deliberately no channel picker any more: a server that enables
 *  clips pins ONE channel for them (the owner chooses it in Server Settings),
 *  so every participant approving a clip knows where it will land. The old
 *  fallback chain (pin → remembered choice → server default → first postable)
 *  meant the approval screen and the actual destination could disagree.
 *
 *  Four answers, each with its own UI, because collapsing them was the bug:
 *  the old composer rendered a silent empty select while channels loaded and
 *  fell back to a 403 at post time when the pin was unpostable. */
export type ClipTargetResolution =
    | { kind: 'ok'; channel: Channel }
    | { kind: 'loading' }
    | { kind: 'pin-missing' }
    | { kind: 'pin-unpostable' };

export function resolveClipTarget(
    policy: { serverId: string | null; pinnedChannelId: number | null },
    channels: Channel[] | null,
): ClipTargetResolution {
    if (channels === null) return { kind: 'loading' };
    if (policy.pinnedChannelId === null) return { kind: 'pin-missing' };
    const pinned = postableChannels(channels, policy.serverId)
        .find(c => c.id === policy.pinnedChannelId);
    if (!pinned) return { kind: 'pin-unpostable' };
    return { kind: 'ok', channel: pinned };
}

/** The copy for a proposal that ended without an upload. `closed` cannot reach
 *  a proposer (they get the real outcome) but is handled so a future frame
 *  shape cannot render a blank. */
export function outcomeCopy(status: OutgoingProposal['status']): string | null {
    switch (status) {
        case 'declined': return 'Someone declined. The clip has been deleted from memory. Nothing was uploaded.';
        case 'expired': return 'The request expired before everyone answered. The clip has been deleted from memory. Nothing was uploaded.';
        case 'cancelled': return 'Request cancelled. The clip has been deleted from memory. Nothing was uploaded.';
        case 'closed': return 'The request was closed. Nothing was uploaded.';
        default: return null;
    }
}
