/**
 * Pause DeepFilter while nobody can hear this mic - the controller.
 *
 * decideDfPause (dfPauseDecision.ts) says WHETHER; this module gathers its
 * inputs from the live call, applies the answer to the call's noise graph
 * (noiseFilter.ts setDeepFilterPaused), and owns the timing:
 *
 *  - RESUME EAGERLY: the moment any input says someone may hear (they joined,
 *    undeafened, we unmuted or pressed push-to-talk, the socket dropped, the
 *    SFU started reconnecting), in the same event, before anything else.
 *  - PAUSE CONSERVATIVELY: only once "nobody can hear" has held for
 *    PAUSE_HOLD_MS, re-checked when the hold ends. A roster that flaps
 *    (a replay, a reconnect) or a push-to-talk user between sentences never
 *    pays a pause/resume cycle, which costs the resume's pre-roll in CPU.
 *
 * It is EVENT-DRIVEN, never polled: it re-evaluates when the roster changes
 * (voiceState's notify), when the mic gate changes (setAudioEnabled), when
 * the socket opens or closes, and when a media peer connects or goes. The
 * only timer is the hold. VoicePanel attaches it for the life of a call.
 *
 * WHOSE DEAFEN IT TRUSTS: a deafen status belongs to the media session it was
 * sent from, but the roster keeps one row per user and keeps its flags
 * across every replay. So it also watches each member's media SESSIONS (the
 * `sessions` wiring): a session it has not seen before, for someone it had
 * already seen one for, is a new device or a rejoin - "Move here", a reload
 * - and their deafen is unknown (they hear) until a status stamped AFTER it
 * arrives (voiceState applyVoiceStatus). Two sessions of one person at once
 * are unknown too: the one row cannot say which device is deafened. The
 * first session seen for someone is trusted, so joining a call where
 * everyone is deafened still pauses. A mesh connection rebuilt after a
 * network failure is a new session as well, so DeepFilter runs for that
 * member until their next status: it costs CPU, never what anyone hears.
 * Found in review on 2026-10-04: a deafened member who moved the call to
 * their phone kept DeepFilter paused while the phone heard everything,
 * until someone toggled something. (A joining client now also re-states its
 * own status - VoicePanel restateStatusSoon - but an older one does not.)
 *
 * What a pause does to the call is in dfWorklet.js (PAUSE): the RNNoise
 * bridge carries the mic, so whatever still reads it - the speaking ring, a
 * clip's mic leg - keeps working, at RNNoise quality. That is the one
 * caveat this accepts (see docs/CLIPS.md): a clip armed while you are alone
 * in a call records your voice through RNNoise instead of DeepFilter.
 */
import { decideDfPause, type DfPauseInputs, type DfPauseReason } from './dfPauseDecision';
import { globalVoiceUsers, subscribeToVoiceUsers } from '../components/voiceState';
import { setDeepFilterPaused, setDfPauseDiagnosticsSource } from './noiseFilter';

/** How long "nobody can hear" must hold before DeepFilter pauses. Resuming
 *  never waits. A pause/resume cycle costs the resume's pre-roll (16 hops,
 *  ~40 ms of inference) and puts ~50 ms of RNNoise on air, so pausing for
 *  less than a second or so is not worth it. */
export const PAUSE_HOLD_MS = 1500;

/** One input: its current value, and a way to hear that it changed. */
export interface Probe<T> {
    read(): T;
    subscribe(onChange: () => void): () => void;
}

export interface DfPauseWiring {
    roomId: string;
    selfId: number;
    /** The published track's gate (WebRTCManager.isAudioEnabled /
     *  onMicGateChange). */
    mic: Probe<boolean | null>;
    /** The signalling socket is up ('wsConnected' / 'wsClosed'). */
    socket: Probe<boolean>;
    /** Media peers: mesh peer connections and SFU participants; null when an
     *  SFU call's transport state is not known. */
    transport: Probe<ReadonlyArray<number> | null>;
    /** Every media connection's SESSION, as [user id, key]: a mesh peer
     *  connection's connId (new for every connection), an SFU participant's
     *  identity (`u<id>#<nonce>`, minted per join). Read with `transport`
     *  and announced by its subscribe. Optional: without it every deafen
     *  status is trusted, whichever session stated it. */
    sessions?: () => ReadonlyArray<readonly [number, string]>;
    /** Where the decision goes. Default: the call's noise graph. */
    apply?: (paused: boolean, reason: DfPauseReason | null) => void;
}

interface Watch {
    wiring: DfPauseWiring;
    apply: (paused: boolean, reason: DfPauseReason | null) => void;
    unsubs: Array<() => void>;
    holdTimer: ReturnType<typeof setTimeout> | null;
    /** What the graph was last told. */
    applied: boolean;
    appliedReason: DfPauseReason | null;
    detached: boolean;
    /** Every session key seen per member during this watch. */
    seenSessions: Map<number, Set<string>>;
    /** Members on a session newer than their last status: the statusSeq
     *  their row had when it began (undefined = none yet). */
    newSession: Map<number, number | undefined>;
}

let watch: Watch | null = null;
/** The cost of the conditions themselves, for __pucaVoiceDiag(). */
const stats = { evaluations: 0, evalMs: 0, pauses: 0, resumes: 0 };
let lastDecision: { paused: boolean; reasons: DfPauseReason[] } | null = null;

function gather(wt: Watch): DfPauseInputs {
    const w = wt.wiring;
    const room = globalVoiceUsers.get(w.roomId);
    const transportPeers = w.transport.read();
    return {
        micOpen: w.mic.read(),
        selfId: w.selfId,
        roster: room ? [...room.values()].map(u => ({ id: u.id, isDeafened: u.isDeafened === true })) : null,
        socketUp: w.socket.read(),
        transportPeers,
        // Only while the transport is known: an SFU room that is not
        // connected lists nobody, which is not "they left".
        deafenUnknown: transportPeers === null ? [] : deafenUnknownNow(wt),
    };
}

/** Who has a media session their last status did not come from (see the
 *  header), updating what this watch has seen. */
function deafenUnknownNow(wt: Watch): number[] {
    const read = wt.wiring.sessions;
    if (!read) return [];
    const room = globalVoiceUsers.get(wt.wiring.roomId);
    const seqOf = (id: number) => room?.get(id)?.statusSeq;
    const byUser = new Map<number, Set<string>>();
    for (const [id, key] of read()) {
        if (id === wt.wiring.selfId) continue; // our own other device already counts as hearing
        let keys = byUser.get(id);
        if (!keys) { keys = new Set(); byUser.set(id, keys); }
        keys.add(key);
    }
    const unknown: number[] = [];
    for (const [id, keys] of byUser) {
        const seen = wt.seenSessions.get(id);
        if (!seen) {
            wt.seenSessions.set(id, new Set(keys)); // the first we see is trusted
        } else {
            let fresh = false;
            for (const k of keys) if (!seen.has(k)) { seen.add(k); fresh = true; }
            if (fresh) wt.newSession.set(id, seqOf(id));
        }
        if (keys.size > 1) unknown.push(id);
    }
    for (const [id, seqAtStart] of wt.newSession) {
        const seq = seqOf(id);
        // Trusted again only on a status stamped after the session began. A
        // row that lost its stamp (rebuilt) is not one.
        if (seq !== undefined && (seqAtStart === undefined || seq > seqAtStart)) wt.newSession.delete(id);
        else if (!unknown.includes(id)) unknown.push(id);
    }
    return unknown;
}

function evaluate(wt: Watch): void {
    if (wt.detached) return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const d = decideDfPause(gather(wt));
    stats.evaluations++;
    stats.evalMs += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    lastDecision = d;
    if (!d.paused) {
        if (wt.holdTimer !== null) { clearTimeout(wt.holdTimer); wt.holdTimer = null; }
        if (wt.applied) {
            wt.applied = false;
            wt.appliedReason = null;
            stats.resumes++;
            wt.apply(false, null);
        }
        return;
    }
    const reason = d.reasons[0];
    if (wt.applied) {
        // Still paused, perhaps for another reason now (unmuted while alone).
        if (reason !== wt.appliedReason) { wt.appliedReason = reason; wt.apply(true, reason); }
        return;
    }
    if (wt.holdTimer !== null) return; // already holding
    wt.holdTimer = setTimeout(() => {
        wt.holdTimer = null;
        if (wt.detached) return;
        // Re-check at the end of the hold rather than trusting the start of
        // it: an event that should have cancelled it might have been missed.
        const now = decideDfPause(gather(wt));
        stats.evaluations++;
        lastDecision = now;
        if (!now.paused || wt.applied) return;
        wt.applied = true;
        wt.appliedReason = now.reasons[0];
        stats.pauses++;
        wt.apply(true, now.reasons[0]);
    }, PAUSE_HOLD_MS);
}

/**
 * Start deciding for this call. Returns the detach function (call it when
 * the call ends): it resumes DeepFilter and forgets everything. Attaching
 * again replaces the previous watch.
 */
export function attachDfPause(wiring: DfPauseWiring): () => void {
    if (watch) detachWatch(watch);
    const wt: Watch = {
        wiring,
        apply: wiring.apply ?? setDeepFilterPaused,
        unsubs: [],
        holdTimer: null,
        applied: false,
        appliedReason: null,
        detached: false,
        seenSessions: new Map(),
        newSession: new Map(),
    };
    watch = wt;
    const onChange = () => evaluate(wt);
    wt.unsubs.push(
        subscribeToVoiceUsers(onChange),
        wiring.mic.subscribe(onChange),
        wiring.socket.subscribe(onChange),
        wiring.transport.subscribe(onChange),
    );
    evaluate(wt);
    return () => {
        if (watch === wt) watch = null;
        detachWatch(wt);
    };
}

function detachWatch(wt: Watch): void {
    if (wt.detached) return;
    wt.detached = true;
    wt.unsubs.forEach(u => u());
    wt.unsubs = [];
    if (wt.holdTimer !== null) { clearTimeout(wt.holdTimer); wt.holdTimer = null; }
    // Always, not only when paused: the next call's graph must start running.
    if (wt.applied) stats.resumes++;
    wt.applied = false;
    wt.apply(false, null);
}

/** For __pucaVoiceDiag(): what the conditions say, and what they cost. */
export function dfPauseDiagnostics(): Record<string, unknown> {
    return {
        attached: watch !== null,
        decision: lastDecision,
        applied: watch?.applied ?? false,
        reason: watch?.appliedReason ?? null,
        holding: watch?.holdTimer != null,
        // Members on a media session newer than their last status: their
        // deafen does not count until they state it again.
        newSessions: watch ? [...watch.newSession.keys()] : [],
        evaluations: stats.evaluations,
        evalMsTotal: Math.round(stats.evalMs * 1000) / 1000,
        pauses: stats.pauses,
        resumes: stats.resumes,
    };
}

setDfPauseDiagnosticsSource(dfPauseDiagnostics);
