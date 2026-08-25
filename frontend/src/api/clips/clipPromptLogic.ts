/** Pure helpers for the clip approval prompt (tested without React). */
import type { ClipProposalState, IncomingProposal } from './clipProposals';

/** Coarse, honest expiry copy: never a racing bar. */
export function expiresInText(expiresAt: number, now: number): string {
    const ms = expiresAt - now;
    if (ms <= 0) return 'Expired';
    const min = Math.ceil(ms / 60_000);
    if (min <= 1) return 'Expires in under a minute';
    return `Expires in ${min} min`;
}

/** "ending 2 minutes ago" — from the RECEIVED ended_ago, kept ticking locally. */
export function endedAgoText(p: Pick<IncomingProposal, 'endedAgoMs' | 'receivedAt'>, now: number): string {
    const ms = p.endedAgoMs + Math.max(0, now - p.receivedAt);
    const s = Math.round(ms / 1000);
    if (s < 45) return 'ending just now';
    const m = Math.round(s / 60);
    if (m <= 1) return 'ending a minute ago';
    return `ending ${m} minutes ago`;
}

/** The clause list rendered from the server's flags for THIS approver. */
export function includesClause(you: IncomingProposal['you']): string {
    const parts = ['your voice'];
    if (you.hadCamera) parts.push('your camera');
    if (you.hadShare) parts.push('the screen you were sharing');
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/** The oldest UNANSWERED request (the list is newest-first), or the one that
 *  resolved while it was on screen (so its terminal copy can be shown). */
export function pickShown(s: ClipProposalState, shownId: string | null): IncomingProposal | null {
    if (shownId) {
        const cur = s.incoming.find(p => p.clipId === shownId);
        if (cur && (cur.myVote === 'pending' || cur.resolution !== null)) return cur;
    }
    const pending = s.incoming.filter(p => p.myVote === 'pending' && p.resolution === null);
    return pending.length ? pending[pending.length - 1] : null;
}
