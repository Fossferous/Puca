/**
 * Clip consent protocol — client module (docs/CLIPS.md, api/clips/clipProposals.ts).
 *
 * The wire is mocked at apiClient/wsClient; the module's job is to keep local
 * state honest against a server that is the authority:
 *  - a doorbell is NOT a prompt: the prompt exists only after GET /clips/:id
 *    succeeded (a 404 doorbell prompts nothing);
 *  - a duplicate doorbell does not double-prompt;
 *  - a non-approved outcome fires the discard handoff exactly once;
 *  - reconciliation drops what the server no longer knows and adds what it does;
 *  - a vote that never reached the server leaves myVote pending;
 *  - `clipsAvailable` is a strict `=== true` on real fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Handler = (msg: { type: string; payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();
const get = vi.fn();
const post = vi.fn();
const del = vi.fn();

vi.mock('../api/client', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/client')>();
    return {
        ...real,
        apiClient: {
            get: (...a: unknown[]) => get(...a),
            post: (...a: unknown[]) => post(...a),
            delete: (...a: unknown[]) => del(...a),
        },
    };
});
vi.mock('../api/websocket', () => ({
    wsClient: {
        on: (type: string, h: Handler) => { handlers.set(type, [...(handlers.get(type) ?? []), h]); },
        off: () => {},
    },
}));
vi.mock('../api/platform', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/platform')>()), isTauri: () => false, isAndroidApp: () => false, appIsForeground: () => true }));
vi.mock('../api/mobileApp', () => ({ postMobileNotification: vi.fn(async () => {}) }));

const { ApiError } = await import('../api/client');
const mod = await import('../api/clips/clipProposals');

const fire = (type: string, payload: unknown) => { for (const h of handlers.get(type) ?? []) h({ type, payload }); };
const flush = () => new Promise(r => setTimeout(r, 0));

function view(over: Record<string, unknown> = {}) {
    return {
        clip_id: 'c1', proposer: { id: 7, username: 'ann' }, server_id: 's', voice_channel_id: 5, voice_channel_name: 'General Voice',
        target_channel_id: 9, target_channel_name: 'clips', duration_ms: 64_000, ended_ago_ms: 120_000, expires_in_ms: 1_800_000,
        approver_count: 3, approved_count: 0, solo: false, resolved: false, approved: false,
        my_vote: 'pending', you: { had_camera: false, had_share: true, still_in_call: true },
        ...over,
    };
}

beforeEach(() => {
    handlers.clear();
    get.mockReset(); post.mockReset(); del.mockReset();
    mod.__resetClipProposalsForTests();
    mod.wireClipProposals();
});

describe('doorbell → hydrate → prompt', () => {
    it('a ClipProposed whose GET is 404 prompts NOTHING (dead clip, stale parked frame)', async () => {
        get.mockRejectedValueOnce(new ApiError('No such clip request', 404));
        fire('ClipProposed', { clip_id: 'gone', expires_in_ms: 1000 });
        await flush();
        expect(mod.getClipProposalState().incoming).toEqual([]);
    });

    it('a live doorbell prompts once, from the GET body — and a duplicate doorbell does not double-prompt', async () => {
        get.mockResolvedValue(view());
        fire('ClipProposed', { clip_id: 'c1', expires_in_ms: 1_800_000 });
        await flush();
        fire('ClipPending', { clip_id: 'c1' });
        await flush();
        const inc = mod.getClipProposalState().incoming;
        expect(inc).toHaveLength(1);
        expect(inc[0]).toMatchObject({ clipId: 'c1', proposer: { username: 'ann' }, durationMs: 64_000, you: { hadShare: true, hadCamera: false, stillInCall: true }, myVote: 'pending', resolution: null });
        expect(get).toHaveBeenCalledTimes(1); // the duplicate was dropped before any fetch
    });

    it('a doorbell already answered on another device (my_vote=approved) prompts nothing', async () => {
        get.mockResolvedValue(view({ my_vote: 'approved' }));
        fire('ClipProposed', { clip_id: 'c1', expires_in_ms: 1_800_000 });
        await flush();
        expect(mod.getClipProposalState().incoming).toEqual([]);
    });

    it('a locally-blocked proposer still prompts — the module has no block list to consult (consent is about YOU)', async () => {
        // Positive control that nothing here consults a block store: the source
        // does not import one. (A future "helpful" import goes red here.)
        const src = readFileSync(resolve(process.cwd(), 'src/api/clips/clipProposals.ts'), 'utf8').split('__resetClipProposalsForTests')[0];
        expect(src).not.toMatch(/blockList|isBlocked|blockedUsers/);
        get.mockResolvedValue(view({ proposer: { id: 666, username: 'blocked-guy' } }));
        fire('ClipProposed', { clip_id: 'c1', expires_in_ms: 1_800_000 });
        await flush();
        expect(mod.getClipProposalState().incoming).toHaveLength(1);
    });
});

describe('outgoing lifecycle', () => {
    it('proposeClip records the outgoing proposal; ClipVoteUpdate updates counts; ClipResolved{declined} fires the discard handoff exactly once', async () => {
        const discard = vi.fn();
        mod.setClipDiscardHandler(discard);
        post.mockResolvedValueOnce({ clip_id: 'p1', expires_in_ms: 1_800_000, approvers: [{ id: 2, username: 'b', online: true }, { id: 3, username: 'c', online: false }], solo: false, resolved: false, approved: false });
        const out = await mod.proposeClip(5, { targetChannelId: 9, durationMs: 30_000, endedAgoMs: 100, declaredParticipants: [2] });
        expect(out).toMatchObject({ clipId: 'p1', total: 2, approvedCount: 0, status: 'pending' });
        expect(post).toHaveBeenCalledWith('/channels/5/clips', { target_channel_id: 9, duration_ms: 30_000, ended_ago_ms: 100, declared_participants: [2] });

        fire('ClipVoteUpdate', { clip_id: 'p1', approved_count: 1, total: 2 });
        expect(mod.getClipProposalState().outgoing).toMatchObject({ approvedCount: 1, total: 2, status: 'pending' });

        fire('ClipResolved', { clip_id: 'p1', outcome: 'declined' });
        expect(mod.getClipProposalState().outgoing?.status).toBe('declined');
        expect(discard).toHaveBeenCalledTimes(1);
        expect(discard).toHaveBeenCalledWith('p1');
        // A second terminal signal for the same clip (e.g. local expiry tick, reconcile) must not wipe twice.
        fire('ClipResolved', { clip_id: 'p1', outcome: 'expired' });
        expect(discard).toHaveBeenCalledTimes(1);
    });

    it('ClipResolved{approved} does NOT discard and marks every approver counted', async () => {
        const discard = vi.fn();
        mod.setClipDiscardHandler(discard);
        post.mockResolvedValueOnce({ clip_id: 'p2', expires_in_ms: 1000, approvers: [{ id: 2, username: 'b', online: true }], solo: false, resolved: false, approved: false });
        await mod.proposeClip(5, { targetChannelId: 9, durationMs: 30_000, endedAgoMs: 0, declaredParticipants: [] });
        fire('ClipResolved', { clip_id: 'p2', outcome: 'approved' });
        expect(mod.getClipProposalState().outgoing).toMatchObject({ status: 'approved', approvedCount: 1 });
        expect(discard).not.toHaveBeenCalled();
    });

    it('a solo proposal comes back already approved', async () => {
        post.mockResolvedValueOnce({ clip_id: 'p3', expires_in_ms: 1000, approvers: [], solo: true, resolved: true, approved: true });
        const out = await mod.proposeClip(5, { targetChannelId: 9, durationMs: 30_000, endedAgoMs: 0, declaredParticipants: [] });
        expect(out).toMatchObject({ solo: true, status: 'approved', total: 0 });
    });

    it('proposeClip maps the server refusals the composer renders specially', async () => {
        post.mockRejectedValueOnce(new ApiError(JSON.stringify({ error: 'window_predates_log', earliest_ms: 123 }), 409));
        await expect(mod.proposeClip(5, { targetChannelId: 9, durationMs: 30_000, endedAgoMs: 0, declaredParticipants: [] }))
            .rejects.toMatchObject({ name: 'ClipProposeError', code: 'window_predates_log', earliestMs: 123, status: 409 });
        post.mockRejectedValueOnce(new ApiError(JSON.stringify({ error: 'rate_limited', retry_after_ms: 5000 }), 429));
        await expect(mod.proposeClip(5, { targetChannelId: 9, durationMs: 30_000, endedAgoMs: 0, declaredParticipants: [] }))
            .rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 5000 });
        post.mockRejectedValueOnce(new ApiError('Clips are turned off in this server', 409));
        await expect(mod.proposeClip(5, { targetChannelId: 9, durationMs: 30_000, endedAgoMs: 0, declaredParticipants: [] }))
            .rejects.toMatchObject({ code: 'other', message: 'Clips are turned off in this server' });
    });

    it('cancelClip marks cancelled and discards once, even when the server already forgot it (404)', async () => {
        const discard = vi.fn();
        mod.setClipDiscardHandler(discard);
        post.mockResolvedValueOnce({ clip_id: 'p4', expires_in_ms: 1000, approvers: [{ id: 2, username: 'b', online: true }], solo: false, resolved: false, approved: false });
        await mod.proposeClip(5, { targetChannelId: 9, durationMs: 30_000, endedAgoMs: 0, declaredParticipants: [] });
        del.mockRejectedValueOnce(new ApiError('No such clip request', 404));
        await mod.cancelClip('p4');
        expect(mod.getClipProposalState().outgoing?.status).toBe('cancelled');
        expect(discard).toHaveBeenCalledTimes(1);
    });
});

describe('voting', () => {
    it('a network failure leaves myVote PENDING and the prompt in place; a 404 drops the prompt', async () => {
        get.mockResolvedValue(view());
        fire('ClipProposed', { clip_id: 'c1', expires_in_ms: 1_800_000 });
        await flush();
        post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(mod.voteOnClip('c1', true)).rejects.toBeInstanceOf(TypeError);
        expect(mod.getClipProposalState().incoming[0]).toMatchObject({ clipId: 'c1', myVote: 'pending' });
        post.mockRejectedValueOnce(new ApiError('No such clip request', 404));
        await mod.voteOnClip('c1', true);
        expect(mod.getClipProposalState().incoming).toEqual([]);
        expect(mod.getClipProposalState().notice).toMatch(/no longer/);
    });

    it('approve keeps the entry (myVote=approved) so a later resolution does not re-prompt; decline drops it', async () => {
        get.mockResolvedValue(view());
        fire('ClipProposed', { clip_id: 'c1', expires_in_ms: 1_800_000 });
        await flush();
        post.mockResolvedValueOnce({ clip_id: 'c1', state: 'pending', approved_count: 1, total: 3 });
        await mod.voteOnClip('c1', true);
        expect(mod.getClipProposalState().incoming[0]).toMatchObject({ myVote: 'approved' });
        expect(post).toHaveBeenLastCalledWith('/clips/c1/vote', { approve: true });
        fire('ClipResolved', { clip_id: 'c1', outcome: 'approved' });
        expect(mod.getClipProposalState().incoming[0]).toMatchObject({ resolution: 'approved' });

        get.mockResolvedValue(view({ clip_id: 'c2' }));
        fire('ClipProposed', { clip_id: 'c2', expires_in_ms: 1_800_000 });
        await flush();
        post.mockResolvedValueOnce({ clip_id: 'c2', state: 'declined', approved_count: 0, total: 3 });
        await mod.voteOnClip('c2', false);
        expect(mod.getClipProposalState().incoming.some(p => p.clipId === 'c2')).toBe(false);
    });
});

describe('reconciliation (GET /clips/pending)', () => {
    it('drops locals the server no longer knows, adds what it does, and expires a pending outgoing that vanished (discard once)', async () => {
        const discard = vi.fn();
        mod.setClipDiscardHandler(discard);
        get.mockResolvedValue(view({ clip_id: 'stale' }));
        fire('ClipProposed', { clip_id: 'stale', expires_in_ms: 1_800_000 });
        await flush();
        post.mockResolvedValueOnce({ clip_id: 'mine', expires_in_ms: 1_800_000, approvers: [{ id: 2, username: 'b', online: true }], solo: false, resolved: false, approved: false });
        await mod.proposeClip(5, { targetChannelId: 9, durationMs: 30_000, endedAgoMs: 0, declaredParticipants: [] });

        // The server knows a NEW incoming one and NOT 'stale' nor 'mine'.
        get.mockResolvedValueOnce({ proposals: [view({ clip_id: 'fresh' })] });
        await mod.refreshPendingClips();
        const s = mod.getClipProposalState();
        expect(s.incoming.map(p => p.clipId)).toEqual(['fresh']);
        expect(s.outgoing?.status).toBe('expired');
        expect(discard).toHaveBeenCalledTimes(1);

        // A pending list that includes MY proposal (proposer view: approvers array, no my_vote) refreshes outgoing, not incoming.
        post.mockResolvedValueOnce({ clip_id: 'mine2', expires_in_ms: 1_800_000, approvers: [{ id: 2, username: 'b', online: true }], solo: false, resolved: false, approved: false });
        await mod.proposeClip(5, { targetChannelId: 9, durationMs: 30_000, endedAgoMs: 0, declaredParticipants: [] });
        get.mockResolvedValueOnce({ proposals: [view({ clip_id: 'mine2', my_vote: undefined, approvers: [{ id: 2, username: 'b', online: true }], approved_count: 1, approver_count: 1, approved: true, resolved: true }), view({ clip_id: 'fresh' })] });
        await mod.refreshPendingClips();
        expect(mod.getClipProposalState().outgoing).toMatchObject({ clipId: 'mine2', status: 'approved', approvedCount: 1 });
        expect(mod.getClipProposalState().incoming.map(p => p.clipId)).toEqual(['fresh']);
    });

    it('a wsConnected event triggers a reconcile', async () => {
        get.mockResolvedValueOnce({ proposals: [] });
        window.dispatchEvent(new Event('wsConnected'));
        await flush();
        expect(get).toHaveBeenCalledWith('/clips/pending');
    });
});

describe('local expiry never wipes the sealed clip alone (review #3)', () => {
    it('a pending outgoing past its deadline is only expired+discarded once the server confirms it is gone; a server that says approved wins', async () => {
        const discard = vi.fn();
        mod.setClipDiscardHandler(discard);
        // Proposal that "expires" immediately.
        post.mockResolvedValueOnce({ clip_id: 'late', expires_in_ms: 1, approvers: [{ id: 2, username: 'b', online: true }], solo: false, resolved: false, approved: false });
        await mod.proposeClip(5, { targetChannelId: 9, durationMs: 30_000, endedAgoMs: 0, declaredParticipants: [] });
        // Network down: the confirming refresh fails → status stays pending, nothing discarded.
        get.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await new Promise(r => setTimeout(r, 5_200));
        expect(mod.getClipProposalState().outgoing?.status).toBe('pending');
        expect(discard).not.toHaveBeenCalled();
        // The lost ClipResolved{approved} case: the server lists it as approved → approved, no discard.
        get.mockResolvedValueOnce({ proposals: [view({ clip_id: 'late', my_vote: undefined, approvers: [{ id: 2, username: 'b', online: true }], approved: true, resolved: true, approved_count: 1, approver_count: 1 })] });
        await mod.refreshPendingClips();
        expect(mod.getClipProposalState().outgoing).toMatchObject({ status: 'approved' });
        expect(discard).not.toHaveBeenCalled();
    }, 10_000);

    it('...and when the server no longer lists it, THAT expires it and discards once', async () => {
        const discard = vi.fn();
        mod.setClipDiscardHandler(discard);
        post.mockResolvedValueOnce({ clip_id: 'late2', expires_in_ms: 1, approvers: [{ id: 2, username: 'b', online: true }], solo: false, resolved: false, approved: false });
        await mod.proposeClip(5, { targetChannelId: 9, durationMs: 30_000, endedAgoMs: 0, declaredParticipants: [] });
        get.mockResolvedValue({ proposals: [] });
        await new Promise(r => setTimeout(r, 5_200));
        expect(mod.getClipProposalState().outgoing?.status).toBe('expired');
        expect(discard).toHaveBeenCalledTimes(1);
    }, 10_000);

    it('an incoming card that already shows a terminal state survives a reconcile that no longer lists it (review #5)', async () => {
        get.mockResolvedValueOnce(view({ clip_id: 'card', expires_in_ms: 1 }));
        fire('ClipProposed', { clip_id: 'card', expires_in_ms: 1 });
        await flush();
        get.mockResolvedValue({ proposals: [] });
        await new Promise(r => setTimeout(r, 5_200));
        const card = mod.getClipProposalState().incoming.find(p => p.clipId === 'card');
        expect(card?.resolution).toBe('expired');
        // ...until dismissed.
        mod.dismissClipProposal('card');
        expect(mod.getClipProposalState().incoming.some(p => p.clipId === 'card')).toBe(false);
    }, 10_000);
});

describe('clipsAvailable', () => {
    it('is a strict === true on a real max', () => {
        expect(mod.clipsAvailable({ clips_enabled: true, clip_max_seconds: 120 })).toBe(true);
        expect(mod.clipsAvailable({ clips_enabled: false, clip_max_seconds: 120 })).toBe(false);
        expect(mod.clipsAvailable({ clips_enabled: true })).toBe(false);          // pre-Clips server: no max
        expect(mod.clipsAvailable({})).toBe(false);
        expect(mod.clipsAvailable(null)).toBe(false);
        expect(mod.clipsAvailable(undefined)).toBe(false);
        expect(mod.clipsAvailable({ clips_enabled: 1 as unknown as boolean, clip_max_seconds: 120 })).toBe(false); // truthiness is not enough
    });
});
