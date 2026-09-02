/**
 * Clip consent protocol — client side (docs/CLIPS.md; server: src/clip_handlers.rs).
 *
 * Owns ONLY the protocol and its state; the recorder/worker is another module
 * (replayBuffer.ts) and there is no import edge between them — the handoff is
 * a registered discard callback (the hostConsent.ts pattern), so a declined,
 * expired or cancelled proposal wipes the sealed clip exactly once.
 *
 * Module-level bus like api/remoteControl.ts (hand-rolled subscribe/emit, not
 * zustand): this state is driven by the wire, not by React.
 *
 * Wire facts this file relies on:
 *  - `ClipProposed` / `ClipPending` are DOORBELLS: the server is the authority,
 *    so every prompt is hydrated from `GET /clips/:id` before it renders. A
 *    parked frame drained an hour late names a clip that may be long gone.
 *  - Votes are anonymous. The proposer gets counts (`ClipVoteUpdate`) and the
 *    real outcome; every other approver only ever sees `approved` or `closed`.
 *  - Times are relative (`expires_in_ms`, `ended_ago_ms`); we convert to a
 *    local deadline on receipt.
 */
import { apiClient, ApiError, isNetworkError } from '../client';
import { wsClient, type ServerMessage } from '../websocket';
import { appIsForeground, isAndroidApp, isTauri } from '../platform';
import { postMobileNotification } from '../mobileApp';

export type ClipVote = 'pending' | 'approved' | 'declined';
export type ClipOutcome = 'approved' | 'declined' | 'expired' | 'cancelled' | 'closed';

/** Wire shape (snake_case). `in_window`: the server's OWN presence log saw
 *  them in the clip's window; `false` means they are on the list only because
 *  this client declared them. Absent from servers older than this field. */
export interface ClipApprover { id: number; username: string; online: boolean; in_window?: boolean }

/** A proposal I made. */
export interface OutgoingProposal {
    clipId: string;
    voiceChannelId: number;
    targetChannelId: number;
    targetChannelName: string;
    durationMs: number;
    /** WHO is required (shown); HOW MANY approved is a count — votes stay anonymous. */
    approvers: ClipApprover[];
    approvedCount: number;
    total: number;
    solo: boolean;
    /** Local wall-clock deadline (from expires_in_ms). */
    expiresAt: number;
    status: 'pending' | ClipOutcome;
}

/** A proposal I must answer. */
export interface IncomingProposal {
    clipId: string;
    proposer: { id: number; username: string };
    serverId: string;
    voiceChannelId: number;
    voiceChannelName: string;
    targetChannelId: number;
    targetChannelName: string;
    durationMs: number;
    endedAgoMs: number;
    /** Received-at, so "ending N minutes ago" keeps ticking without a re-fetch. */
    receivedAt: number;
    approverCount: number;
    expiresAt: number;
    myVote: ClipVote;
    /** `inWindow` false = the server's log did not see you in the call during
     *  the clip; the proposer's app listed you. Defaults to true for older servers. */
    you: { hadCamera: boolean; hadShare: boolean; stillInCall: boolean; inWindow: boolean };
    /** Set when the proposal resolved while the prompt was open. `expired` is
     *  the LOCAL clock's verdict (confirmed by a re-fetch); the server never
     *  tells an approver "expired" — it just stops listing it. */
    resolution: null | 'approved' | 'closed' | 'expired';
}

export interface ClipProposalState {
    outgoing: OutgoingProposal | null;
    /** Newest first; the prompt renders the OLDEST unanswered. */
    incoming: IncomingProposal[];
    notice: string | null;
}

let state: ClipProposalState = { outgoing: null, incoming: [], notice: null };
const listeners = new Set<(s: ClipProposalState) => void>();
function emit(): void {
    state = { ...state };
    for (const cb of listeners) { try { cb(state); } catch { /* listener bug must not break the protocol */ } }
}
export function subscribeClipProposals(cb: (s: ClipProposalState) => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}
export function getClipProposalState(): ClipProposalState { return state; }
export function clearClipNotice(): void { state.notice = null; emit(); }

// ---- the wiper handoff --------------------------------------------------------
type Discard = (clipId: string) => void;
let discardHandler: Discard | null = null;
const discarded = new Set<string>();
/** The sealed clip lives in a worker this module must not import. Register a
 *  wiper; every terminal state that is NOT 'approved' calls it exactly once. */
export function setClipDiscardHandler(fn: Discard | null): () => void {
    discardHandler = fn;
    return () => { if (discardHandler === fn) discardHandler = null; };
}
function discardOnce(clipId: string): void {
    if (discarded.has(clipId)) return;
    discarded.add(clipId);
    try { discardHandler?.(clipId); } catch { /* ignore */ }
}

// ---- server views ---------------------------------------------------------------
interface ServerClipView {
    clip_id: string;
    proposer: { id: number; username: string };
    server_id: string;
    voice_channel_id: number;
    voice_channel_name: string;
    target_channel_id: number;
    target_channel_name: string;
    duration_ms: number;
    ended_ago_ms: number;
    expires_in_ms: number;
    approver_count: number;
    approved_count: number;
    solo: boolean;
    resolved: boolean;
    approved: boolean;
    approvers?: ClipApprover[];
    my_vote?: ClipVote;
    you?: { had_camera: boolean; had_share: boolean; still_in_call: boolean; in_window?: boolean };
}
interface ProposeResponse {
    clip_id: string;
    expires_in_ms: number;
    approvers: ClipApprover[];
    solo: boolean;
    resolved: boolean;
    approved: boolean;
}

function toIncoming(v: ServerClipView, prev?: IncomingProposal): IncomingProposal {
    return {
        clipId: v.clip_id,
        proposer: v.proposer,
        serverId: v.server_id,
        voiceChannelId: v.voice_channel_id,
        voiceChannelName: v.voice_channel_name,
        targetChannelId: v.target_channel_id,
        targetChannelName: v.target_channel_name,
        durationMs: v.duration_ms,
        endedAgoMs: v.ended_ago_ms,
        receivedAt: Date.now(),
        approverCount: v.approver_count,
        expiresAt: Date.now() + Math.max(0, v.expires_in_ms),
        myVote: v.my_vote ?? prev?.myVote ?? 'pending',
        you: { hadCamera: !!v.you?.had_camera, hadShare: !!v.you?.had_share, stillInCall: !!v.you?.still_in_call, inWindow: v.you?.in_window !== false },
        resolution: prev?.resolution ?? null,
    };
}

function toOutgoing(v: ServerClipView, prev?: OutgoingProposal): OutgoingProposal {
    return {
        clipId: v.clip_id,
        voiceChannelId: v.voice_channel_id,
        targetChannelId: v.target_channel_id,
        targetChannelName: v.target_channel_name,
        durationMs: v.duration_ms,
        approvers: v.approvers ?? prev?.approvers ?? [],
        approvedCount: v.approved_count,
        total: v.approver_count,
        solo: v.solo,
        expiresAt: Date.now() + Math.max(0, v.expires_in_ms),
        status: v.approved ? 'approved' : (prev?.status ?? 'pending'),
    };
}

// ---- REST -----------------------------------------------------------------------

export interface ProposeArgs {
    targetChannelId: number;
    durationMs: number;
    endedAgoMs: number;
    declaredParticipants: number[];
}

/** Errors the composer wants to render specially. */
export class ClipProposeError extends Error {
    readonly status: number;
    readonly code: 'window_predates_log' | 'rate_limited' | 'other';
    readonly earliestMs?: number;
    readonly retryAfterMs?: number;
    constructor(message: string, status: number, code: ClipProposeError['code'], extra: { earliestMs?: number; retryAfterMs?: number } = {}) {
        super(message);
        this.name = 'ClipProposeError';
        this.status = status;
        this.code = code;
        this.earliestMs = extra.earliestMs;
        this.retryAfterMs = extra.retryAfterMs;
    }
}

export async function proposeClip(voiceChannelId: number, a: ProposeArgs): Promise<OutgoingProposal> {
    let r: ProposeResponse;
    try {
        r = await apiClient.post<ProposeResponse>(`/channels/${voiceChannelId}/clips`, {
            target_channel_id: a.targetChannelId,
            duration_ms: Math.max(0, Math.round(a.durationMs)),
            ended_ago_ms: Math.max(0, Math.round(a.endedAgoMs)),
            declared_participants: a.declaredParticipants,
        });
    } catch (e) {
        if (e instanceof ApiError) {
            let code: ClipProposeError['code'] = 'other';
            let extra: { earliestMs?: number; retryAfterMs?: number } = {};
            try {
                const j = JSON.parse(e.message) as { error?: string; earliest_ms?: number; retry_after_ms?: number };
                if (j.error === 'window_predates_log') { code = 'window_predates_log'; extra = { earliestMs: j.earliest_ms }; }
                if (j.error === 'rate_limited') { code = 'rate_limited'; extra = { retryAfterMs: j.retry_after_ms }; }
            } catch { /* plain-text refusal */ }
            throw new ClipProposeError(e.message, e.status, code, extra);
        }
        throw e;
    }
    const out: OutgoingProposal = {
        clipId: r.clip_id, voiceChannelId, targetChannelId: a.targetChannelId, targetChannelName: '',
        durationMs: a.durationMs, approvers: r.approvers, approvedCount: r.approved ? r.approvers.length : 0,
        total: r.approvers.length, solo: r.solo, expiresAt: Date.now() + Math.max(0, r.expires_in_ms),
        status: r.approved ? 'approved' : 'pending',
    };
    // DevTools only (never persisted): what we declared and where each
    // required approver came from, so a surprising name can be explained from
    // evidence rather than theory.
    console.log(`[clips] proposed ${r.clip_id}: window=${Math.round(a.durationMs / 1000)}s ended ${Math.round(a.endedAgoMs / 1000)}s ago, declared=[${a.declaredParticipants.join(',')}], approvers=[${r.approvers.map(x => `${x.id}${x.in_window === false ? ':declared-only' : ''}`).join(',')}]`);
    state.outgoing = out;
    emit();
    return out;
}

export async function voteOnClip(clipId: string, approve: boolean): Promise<void> {
    try {
        await apiClient.post(`/clips/${encodeURIComponent(clipId)}/vote`, { approve });
    } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
            // Gone (resolved elsewhere / expired) or already answered: drop the prompt.
            state.incoming = state.incoming.filter(p => p.clipId !== clipId);
            state.notice = e.status === 404 ? 'That clip request is no longer waiting.' : null;
            emit();
            return;
        }
        // Network error: keep the prompt, leave myVote pending — an approve that
        // never landed must not look landed.
        throw e;
    }
    const p = state.incoming.find(p => p.clipId === clipId);
    if (p) { p.myVote = approve ? 'approved' : 'declined'; }
    if (!approve) state.incoming = state.incoming.filter(p => p.clipId !== clipId);
    emit();
}

export async function cancelClip(clipId: string): Promise<void> {
    try { await apiClient.delete(`/clips/${encodeURIComponent(clipId)}`); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
    if (state.outgoing?.clipId === clipId) { state.outgoing = { ...state.outgoing, status: 'cancelled' }; discardOnce(clipId); }
    emit();
}

/** Reconcile in BOTH directions with the server (mandatory: the undelivered
 *  queue drops oldest at its cap, and a lost ClipResolved would leave a zombie). */
export async function refreshPendingClips(): Promise<void> {
    let list: { proposals: ServerClipView[] } | undefined;
    try { list = await apiClient.get<{ proposals: ServerClipView[] }>('/clips/pending'); } catch { return; }
    if (!list || !Array.isArray(list.proposals)) return; // never reconcile against a malformed answer
    const serverIds = new Set(list.proposals.map(p => p.clip_id));
    // Drop locals the server no longer knows — EXCEPT a card already showing
    // its terminal copy (resolution set): that stays until the user closes it,
    // or "This request expired" would flash and vanish one round-trip later.
    for (const local of state.incoming) {
        if (!serverIds.has(local.clipId) && local.resolution === null) state.incoming = state.incoming.filter(p => p.clipId !== local.clipId);
    }
    // My own pending proposal that the server no longer lists: it expired (or
    // was reaped) — THIS is the confirmation the local clock waits for.
    if (state.outgoing && !serverIds.has(state.outgoing.clipId) && state.outgoing.status === 'pending') {
        state.outgoing = { ...state.outgoing, status: 'expired' };
        discardOnce(state.outgoing.clipId);
    }
    for (const v of list.proposals) {
        if (state.outgoing?.clipId === v.clip_id || (v.approvers && !v.my_vote)) {
            state.outgoing = toOutgoing(v, state.outgoing ?? undefined);
        } else {
            const prev = state.incoming.find(p => p.clipId === v.clip_id);
            const next = toIncoming(v, prev);
            state.incoming = [next, ...state.incoming.filter(p => p.clipId !== v.clip_id)];
        }
    }
    emit();
}

/** Mirror of src/clip_handlers.rs CLIP_UPLOAD_GRACE — the window the server
 *  gives the clipper to review, trim and upload after the final approval.
 *  Used only as the immediate estimate until refreshOutgoingDeadline lands. */
export const CLIP_UPLOAD_GRACE_MS = 15 * 60_000;

/** Re-read the server's deadline for my own proposal (after the final
 *  approval it is the upload grace, not the original TTL). */
export async function refreshOutgoingDeadline(clipId: string): Promise<void> {
    let v: ServerClipView | undefined;
    try { v = await apiClient.get<ServerClipView>(`/clips/${encodeURIComponent(clipId)}`); } catch { return; }
    if (!v || typeof v.expires_in_ms !== 'number' || state.outgoing?.clipId !== clipId) return;
    state.outgoing = { ...state.outgoing, expiresAt: Date.now() + Math.max(0, v.expires_in_ms) };
    emit();
}

/** Bring a proposal to the front (notification tap). False if it is gone. */
export function focusClipProposal(clipId: string): boolean {
    const i = state.incoming.findIndex(p => p.clipId === clipId);
    if (i < 0) return false;
    const [p] = state.incoming.splice(i, 1);
    state.incoming = [p, ...state.incoming];
    emit();
    return true;
}

// ---- WS wiring --------------------------------------------------------------------
let wired = false;
let lastAttentionAt = 0;
const ATTENTION_COOLDOWN_MS = 10 * 60_000;

async function hydrateAndPrompt(clipId: string): Promise<void> {
    if (state.incoming.some(p => p.clipId === clipId)) return; // duplicate doorbell
    let v: ServerClipView;
    try { v = await apiClient.get<ServerClipView>(`/clips/${encodeURIComponent(clipId)}`); } catch { return; } // 404: dead clip — ignore
    if (v.expires_in_ms <= 0) return;                        // already dead
    if (v.my_vote && v.my_vote !== 'pending') return;         // answered on another device
    if (!v.my_vote) {
        // Not an approver: this is our own proposal echoed (proposer view).
        state.outgoing = toOutgoing(v, state.outgoing ?? undefined);
        emit();
        return;
    }
    const inc = toIncoming(v);
    // A locally blocked proposer STILL prompts: this is a consent request about
    // you, not a message from them.
    state.incoming = [inc, ...state.incoming.filter(p => p.clipId !== clipId)];
    emit();
    // Attention: flash (never 'surface' — that raise is reserved for a screen-control
    // request), rate-limited; Android background ⇒ a content-free shade notification.
    const now = Date.now();
    if (isTauri() && now - lastAttentionAt > ATTENTION_COOLDOWN_MS) {
        lastAttentionAt = now;
        void import('@tauri-apps/api/core').then(({ invoke }) => invoke('attention_main_window', { mode: 'flash' })).catch(() => { /* older build */ });
    }
    if (isAndroidApp() && !appIsForeground()) {
        // hygiene-lint:allow-product-spelling — pinned byte-for-byte with PushFrames.java by src/protocol.rs's doorbell test
        void postMobileNotification('clip:' + clipId, 'Approval needed', 'Open Puca to approve or decline', 'clip:' + clipId);
    }
}

export function wireClipProposals(): void {
    if (wired) return;
    wired = true;
    const doorbell = (msg: ServerMessage) => {
        const p = msg.payload as { clip_id?: string; expires_in_ms?: number };
        if (!p?.clip_id) return;
        if (typeof p.expires_in_ms === 'number' && p.expires_in_ms <= 0) return;
        void hydrateAndPrompt(p.clip_id);
    };
    wsClient.on('ClipProposed', doorbell);
    wsClient.on('ClipPending', doorbell);
    wsClient.on('ClipVoteUpdate', (msg: ServerMessage) => {
        const p = msg.payload as { clip_id: string; approved_count: number; total: number };
        if (state.outgoing?.clipId === p.clip_id) {
            state.outgoing = { ...state.outgoing, approvedCount: p.approved_count, total: p.total };
            emit();
        }
    });
    wsClient.on('ClipResolved', (msg: ServerMessage) => {
        const p = msg.payload as { clip_id: string; outcome: ClipOutcome };
        if (state.outgoing?.clipId === p.clip_id) {
            state.outgoing = { ...state.outgoing, status: p.outcome, approvedCount: p.outcome === 'approved' ? state.outgoing.total : state.outgoing.approvedCount };
            if (p.outcome !== 'approved') discardOnce(p.clip_id);
            else {
                // The final approval RESETS the server's deadline to the upload
                // grace (clip_handlers.rs CLIP_UPLOAD_GRACE); the frame does not
                // carry it. Set the mirror constant NOW (so a failed re-read
                // cannot leave the old 30-min deadline — Post enabled past the
                // point the server refuses, or disabled while it still accepts),
                // then refine from the server's own clock.
                state.outgoing = { ...state.outgoing, expiresAt: Date.now() + CLIP_UPLOAD_GRACE_MS };
                void refreshOutgoingDeadline(p.clip_id);
            }
        }
        const inc = state.incoming.find(x => x.clipId === p.clip_id);
        if (inc) {
            inc.resolution = p.outcome === 'approved' ? 'approved' : 'closed';
            state.incoming = [...state.incoming];
        }
        emit();
    });
    // Reconnect: the server is the authority; reconcile both directions.
    window.addEventListener('wsConnected', () => { void refreshPendingClips(); });
    // Local expiry. INCOMING: mark the card expired (the approver can do
    // nothing either way). OUTGOING: never decide alone — the sealed clip is
    // only wiped once the server confirms it no longer lists the proposal
    // (refreshPendingClips), because a lost ClipResolved{approved} would
    // otherwise be turned into a wiped clip and a false "still in memory".
    // While the deadline is past and the network is down, this keeps asking.
    setInterval(() => {
        const now = Date.now();
        let changed = false;
        for (const p of state.incoming) {
            if (p.expiresAt <= now && p.resolution === null) { p.resolution = 'expired'; changed = true; }
        }
        const outgoingPastDeadline = !!state.outgoing && state.outgoing.status === 'pending' && state.outgoing.expiresAt <= now;
        if (changed) emit();
        if (changed || outgoingPastDeadline) void refreshPendingClips();
    }, 5_000);
}

/** Drop a resolved incoming entry from the list (after the user closes the prompt). */
export function dismissClipProposal(clipId: string): void {
    state.incoming = state.incoming.filter(p => p.clipId !== clipId);
    emit();
}

/** Forget the outgoing proposal (after the composer closes). */
export function clearOutgoingClip(): void {
    state.outgoing = null;
    emit();
}

/** Server support: absent fields ⇒ pre-Clips server. `=== true`, never truthiness. */
export function clipsAvailable(server: { clips_enabled?: boolean; clip_max_seconds?: number } | null | undefined): boolean {
    return server?.clips_enabled === true && typeof server.clip_max_seconds === 'number';
}

export { isNetworkError };

/** Test hook. */
export function __resetClipProposalsForTests(): void {
    state = { outgoing: null, incoming: [], notice: null };
    listeners.clear();
    discardHandler = null;
    discarded.clear();
    wired = false;
    lastAttentionAt = 0;
}
