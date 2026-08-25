/**
 * Receiver-side latency control for watched screen shares.
 *
 * A jitter buffer exists to turn irregular arrivals into smooth playback, and
 * the browser's default is tuned for WATCHING video — a hundred milliseconds
 * or two of deliberate delay is invisible in a film and exactly the wrong
 * trade when you are trying to point at something. The My Devices path has
 * zeroed these hints since the latency batch; this module brings the same
 * fix to IN-SERVER screen shares, but only WHILE the viewer is remote-
 * controlling that share — for plain watching the buffer is doing its job,
 * and on a bad link zero-buffer means stutter, so control ending must give
 * the default back.
 *
 * Both hints are HINTS, not commands: the browser clamps to what it can
 * sustain. Feature-detected because support varies — `playoutDelayHint` is in
 * seconds, `jitterBufferTarget` in milliseconds, which is an easy way to ask
 * for a thousand times too much.
 *
 * The registry exists because the RTCRtpReceiver is only in hand at the
 * moment a transport attaches the track (mesh ontrack / LiveKit
 * TrackSubscribed), while the decision to minimise is made later and
 * elsewhere (remoteControl.ts, when control is granted). Registration keeps
 * the LATEST receiver per user, and re-applies the minimised state to a
 * replacement receiver mid-control (a share restarted while being driven).
 */

type TunableReceiver = RTCRtpReceiver & {
    playoutDelayHint?: number;
    jitterBufferTarget?: number | null;
};

/** Zero the receive-side buffering hints. Shared with devices/session.ts. */
export function minimiseJitterBuffer(receiver: RTCRtpReceiver): void {
    try {
        const r = receiver as TunableReceiver;
        if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
        if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0;
    } catch {
        // A browser that exposes the property but refuses the value must not
        // take the stream down over it.
    }
}

/** Give the browser its defaults back (jitterBufferTarget is nullable by
 *  spec; an undefined playoutDelayHint means "no opinion"). */
export function restoreJitterBuffer(receiver: RTCRtpReceiver): void {
    try {
        const r = receiver as TunableReceiver;
        if ('playoutDelayHint' in r) r.playoutDelayHint = undefined;
        if ('jitterBufferTarget' in r) r.jitterBufferTarget = null;
    } catch {
        // As above.
    }
}

const screenReceivers = new Map<number, RTCRtpReceiver>();
const minimisedUsers = new Set<number>();

/**
 * A transport attached (or replaced) the VIDEO receiver for `userId`'s screen
 * share. If that user's share is being controlled right now, the new receiver
 * inherits the minimised state — otherwise a mid-control renegotiation would
 * silently bring the watching-tuned buffer back.
 */
export function registerScreenReceiver(userId: number, receiver: RTCRtpReceiver | undefined | null): void {
    if (!receiver) return;
    screenReceivers.set(userId, receiver);
    if (minimisedUsers.has(userId)) minimiseJitterBuffer(receiver);
}

/**
 * Enter/leave low-latency mode for one user's screen share. Idempotent, and
 * safe to call for a user with no registered receiver (the flag is remembered
 * and applied when one arrives).
 */
export function setScreenLatencyMinimised(userId: number, on: boolean): void {
    if (on) {
        minimisedUsers.add(userId);
    } else {
        minimisedUsers.delete(userId);
    }
    const receiver = screenReceivers.get(userId);
    if (!receiver) return;
    if (on) {
        minimiseJitterBuffer(receiver);
    } else {
        restoreJitterBuffer(receiver);
    }
}

/**
 * Restore EVERY minimised receiver and forget the lot. The reset paths call
 * this unconditionally: control-state teardown has several ways to null its
 * side without knowing whether it ever minimised (a deny landing on a second
 * tab, a fail-closed grant), and any one of them leaving an entry behind
 * strands a receiver at zero-buffer — re-applied to every replacement — for
 * the life of the tab.
 */
export function clearAllScreenLatency(): void {
    for (const userId of [...minimisedUsers]) {
        minimisedUsers.delete(userId);
        const receiver = screenReceivers.get(userId);
        if (receiver) restoreJitterBuffer(receiver);
    }
}

/** Test hook: what the module currently believes, without reaching into WebRTC. */
export function screenLatencyStateForTest(): { registered: number[]; minimised: number[] } {
    return { registered: [...screenReceivers.keys()], minimised: [...minimisedUsers] };
}
