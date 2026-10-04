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
}

let watch: Watch | null = null;
/** The cost of the conditions themselves, for __pucaVoiceDiag(). */
const stats = { evaluations: 0, evalMs: 0, pauses: 0, resumes: 0 };
let lastDecision: { paused: boolean; reasons: DfPauseReason[] } | null = null;

function gather(w: DfPauseWiring): DfPauseInputs {
    const room = globalVoiceUsers.get(w.roomId);
    return {
        micOpen: w.mic.read(),
        selfId: w.selfId,
        roster: room ? [...room.values()].map(u => ({ id: u.id, isDeafened: u.isDeafened === true })) : null,
        socketUp: w.socket.read(),
        transportPeers: w.transport.read(),
    };
}

function evaluate(wt: Watch): void {
    if (wt.detached) return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const d = decideDfPause(gather(wt.wiring));
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
        const now = decideDfPause(gather(wt.wiring));
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
        evaluations: stats.evaluations,
        evalMsTotal: Math.round(stats.evalMs * 1000) / 1000,
        pauses: stats.pauses,
        resumes: stats.resumes,
    };
}

setDfPauseDiagnosticsSource(dfPauseDiagnostics);
