/** Pure copy/selection helpers behind the clip approval prompt (docs/CLIPS.md). */
import { describe, it, expect } from 'vitest';
import { endedAgoText, expiresInText, includesClause, pickShown } from '../api/clips/clipPromptLogic';
import type { ClipProposalState, IncomingProposal } from '../api/clips/clipProposals';

function inc(over: Partial<IncomingProposal>): IncomingProposal {
    return {
        clipId: 'c', proposer: { id: 1, username: 'ann' }, serverId: 's', voiceChannelId: 1, voiceChannelName: 'v',
        targetChannelId: 2, targetChannelName: 't', durationMs: 5000, endedAgoMs: 0, receivedAt: 0, approverCount: 1,
        expiresAt: 10_000, myVote: 'pending', you: { hadCamera: false, hadShare: false, stillInCall: true, inWindow: true }, resolution: null,
        ...over,
    };
}
const st = (incoming: IncomingProposal[]): ClipProposalState => ({ outgoing: null, incoming, notice: null });

describe('expiresInText', () => {
    it('is coarse and never a bar', () => {
        expect(expiresInText(1000, 0)).toBe('Expires in under a minute');
        expect(expiresInText(60_000, 0)).toBe('Expires in under a minute');
        expect(expiresInText(61_000, 0)).toBe('Expires in 2 min');
        expect(expiresInText(28 * 60_000, 0)).toBe('Expires in 28 min');
        expect(expiresInText(0, 0)).toBe('Expired');
        expect(expiresInText(-1, 0)).toBe('Expired');
    });
});

describe('endedAgoText keeps ticking from the received ended_ago', () => {
    it('renders just now / a minute / N minutes', () => {
        expect(endedAgoText({ endedAgoMs: 0, receivedAt: 0 }, 10_000)).toBe('ending just now');
        expect(endedAgoText({ endedAgoMs: 50_000, receivedAt: 0 }, 0)).toBe('ending a minute ago');
        expect(endedAgoText({ endedAgoMs: 60_000, receivedAt: 0 }, 60_000)).toBe('ending 2 minutes ago');
        // time moves on without a re-fetch
        expect(endedAgoText({ endedAgoMs: 120_000, receivedAt: 1000 }, 1000 + 180_000)).toBe('ending 5 minutes ago');
    });
});

describe('includesClause renders per the SERVER flags', () => {
    it('voice only / +camera / +share / all three', () => {
        expect(includesClause({ hadCamera: false, hadShare: false, stillInCall: true, inWindow: true })).toBe('your voice');
        expect(includesClause({ hadCamera: true, hadShare: false, stillInCall: true, inWindow: true })).toBe('your voice and your camera');
        expect(includesClause({ hadCamera: false, hadShare: true, stillInCall: true, inWindow: true })).toBe('your voice and the screen you were sharing');
        expect(includesClause({ hadCamera: true, hadShare: true, stillInCall: true, inWindow: true })).toBe('your voice, your camera, and the screen you were sharing');
    });
});

describe('pickShown', () => {
    it('shows the OLDEST unanswered (list is newest-first) and none when nothing is pending', () => {
        expect(pickShown(st([]), null)).toBeNull();
        const s = st([inc({ clipId: 'new' }), inc({ clipId: 'old' })]);
        expect(pickShown(s, null)?.clipId).toBe('old');
    });
    it('keeps the on-screen one while it is pending, and while it shows a resolution; skips answered ones', () => {
        const s = st([inc({ clipId: 'b' }), inc({ clipId: 'a', myVote: 'approved' })]);
        expect(pickShown(s, null)?.clipId).toBe('b');
        // 'a' resolved while it was on screen: still shown so its terminal copy renders
        const s2 = st([inc({ clipId: 'b' }), inc({ clipId: 'a', myVote: 'approved', resolution: 'approved' })]);
        expect(pickShown(s2, 'a')?.clipId).toBe('a');
        // but not if it was never on screen
        expect(pickShown(s2, null)?.clipId).toBe('b');
        // a declined-and-dropped one is simply absent
        expect(pickShown(st([inc({ clipId: 'b' })]), 'gone')?.clipId).toBe('b');
    });
});
