/**
 * P2P INPUT (W5/R2): remote-control frames over the mesh peer connection's
 * own data channels instead of the WebSocket relay.
 *
 * WHY. Every keystroke and mouse move currently rides the relay: client →
 * server → client, two internet legs and a server hop, while the VIDEO the
 * user is aiming with already flows peer-to-peer. On a mesh call the two
 * ends have a direct path; using it removes the server from the input loop
 * entirely (latency AND a trust surface).
 *
 * WHAT DOES NOT CHANGE. The relay stays the permanent fallback and is still
 * the only path that always exists (an SFU room, a peer with no DC, an old
 * client). Every frame is sealed under the SAME per-session control key with
 * the SAME monotonic sequence rules — this is a transport swap, not a
 * security change, and a host that cannot verify a frame drops it exactly as
 * it does today.
 *
 * ONE LANE, RELIABLE AND ORDERED (`sov-ctl-s`). The first cut had a second
 * unreliable lane for absolute moves — a stale position is worthless, so
 * retransmitting it looked like pure added latency. Review killed it, and
 * the reasoning is worth keeping because it is not obvious:
 *
 *  - Two SCTP streams have NO relative ordering. A `down` retransmitting on
 *    the reliable lane while a `move` sails through the unreliable one
 *    arrives SECOND, and a single receive counter then drops the click —
 *    exactly the ordering bug the per-transport namespaces exist to prevent,
 *    recreated one level down.
 *  - Worse, `sendControlEvent` flushes pending motion BEFORE a click
 *    precisely so the click lands where the pointer was last seen. Put that
 *    positioning move on a lossy lane and it can be dropped for good while
 *    the click is delivered reliably: a click at the previous position,
 *    which is the disaster that whole ordering block exists to prevent.
 *
 * A retransmit on a direct peer link costs about one RTT. A click landing
 * somewhere the user never pointed costs trust. Same call R4 makes for the
 * agent channel, for the same reason.
 *
 * SEQUENCE NAMESPACES ARE PER TRANSPORT. The DC and the WS relay each carry
 * their own counter, and the receiver tracks them separately: merging them
 * re-creates the bug where a fast DC move bumped the sequence past a WS
 * click that was still in flight, and the host dropped the click. What a
 * frame must NEVER do is carry one namespace's number onto the other
 * transport — see the caller's fallback path.
 *
 * THE CAPABILITY GATE IS AN APP-LEVEL HELLO, never `dc.readyState`. An open
 * channel proves SCTP came up, not that the peer's app understands these
 * frames — str0m and every browser open a channel by label whatever the
 * other end does with it. Input rides the DC only after a sealed HELLO
 * arrives on it, which only a peer holding the session key can produce.
 *
 * THE CHANNEL IS NEGOTIATED (`CTL_STREAM_ID`), created once per peer
 * connection and kept for the connection's life; a control session ending
 * disarms the capability (`disarmControlChannels`), it does not close the
 * pipe. Both halves were learned from measuring the first cut, which never
 * carried a frame — see the constant's comment.
 */

export const CTL_STATE_LABEL = 'sov-ctl-s';
/** LiveKit data topic for the same frames over an SFU room (R3). */
export const CTL_SFU_TOPIC = 'sov-ctl';
/**
 * The SCTP stream the mesh lane lives on. Both ends create the channel with
 * this id and `negotiated: true`, so there is exactly ONE channel per peer
 * connection and no in-band announcement.
 *
 * The first cut created the channel in-band on BOTH ends and let this
 * registry "close the loser" when the peer's copy arrived. That annihilated
 * the lane: an arrived channel IS the peer's own channel, so closing it
 * closed the peer's slot, and the peer did the same to ours — both ends lost
 * their channel a moment after it opened and every session fell back to the
 * relay, silently, with `[p2p-input] ... ready` never once logged. Measured
 * 2026-09-06 with two live Chromium peers on loopback: both locals CLOSED
 * within the first second. The lane had never carried a frame in production.
 *
 * 32 sits well above the 0/1 that in-band allocation hands out, so an older
 * peer's announced channel can never collide with it.
 */
export const CTL_STREAM_ID = 32;

/**
 * Above this many unsent bytes on the control channel the SENDER HOLDS
 * MOTION — superseding positions, summing deltas, never dropping — until the
 * channel drains (remoteControl's `uplinkClear`). State events still go.
 *
 * Sized in TIME, not memory. A sealed control frame is ~100-120 bytes and
 * sustained motion emits 60-125 of them a second, so 4 KiB is three to six
 * hundred milliseconds of motion: the most staleness a stalled link can bank
 * before the valve engages. The first cut used 64 KiB (the WebSocket path's
 * figure at the time) — five to ten SECONDS of motion replayed late once the
 * link recovered — and treated congestion as "not ready", rerouting frames
 * to the relay: two transports carrying one input stream mid-session is the
 * ordering hazard the header describes (an `up` overtaking its `down`).
 * Matches UPLINK_HIGH_WATER_BYTES in remoteControl.ts.
 */
export const CTL_HIGH_WATER_BYTES = 4 * 1024;

/** Frame kinds. One byte, so a mis-shaped buffer is refused, not parsed. */
export const FRAME_HELLO = 0x01;
export const FRAME_SEALED_INPUT = 0x02;

/**
 * Which side of a control session THIS end is, for one peer. Capability is
 * tracked per (peer, role), not per peer: one user can be host to a peer
 * while viewing another — or host and viewer to the SAME peer at once — and
 * those are separate sessions with separate keys. The first cut kept one
 * flag per peer, so ending the host session disarmed the still-live viewer
 * session's lane (and vice versa) for the rest of the call, silently.
 */
export type CtlRole = 'host' | 'viewer';

/** One peer's control channel, from whichever side created it. */
export interface CtlChannels {
    state: RTCDataChannel | null;
    /** The peer's HELLO opened under the session key of this role of OURS:
     *  frames of that session may ride the DC. */
    helloSeen: { host: boolean; viewer: boolean };
}

/** `kind` byte + raw payload bytes → one frame. Raw, not base64: the DC is
 *  binary and base64 would cost 33% of every mouse move. */
export function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(payload.length + 1);
    out[0] = kind;
    out.set(payload, 1);
    return out;
}

export function decodeFrame(
    buf: ArrayBuffer | Uint8Array<ArrayBufferLike>,
): { kind: number; payload: Uint8Array } | null {
    // Copy through Uint8Array.from so a SHARED buffer (LiveKit types its
    // payload as ArrayBufferLike) becomes a plain one the rest can hold.
    const bytes = buf instanceof Uint8Array ? Uint8Array.from(buf) : new Uint8Array(buf);
    if (bytes.length < 1) return null;
    return { kind: bytes[0], payload: bytes.subarray(1) };
}

// --- registry ------------------------------------------------------------
//
// The manager owns the peer connections and creates the channels;
// remoteControl owns the session key and the input. Neither should import
// the other (the manager must not depend on control, and control must not
// reach into pc internals), so they meet here.

const byPeer = new Map<number, CtlChannels>();
type FrameHandler = (
    peerId: number,
    frame: { kind: number; payload: Uint8Array },
    /** true = a mesh data channel, false = the SFU room's data path. The
     *  hello must arm the pipe it ARRIVED on, not both. */
    viaMesh: boolean,
) => void;
let handler: FrameHandler | null = null;

/** Asked for a sealed HELLO, when a pipe becomes usable. A peer id names the
 *  channel that just opened; `null` means "announce on every session you
 *  hold" — the SFU case, where ONE connection serves every peer and this
 *  module cannot know which of them there is a control session with.
 *  remoteControl installs it (only it holds the session keys). */
type HelloProvider = (peerId: number | null) => void;
let helloProvider: HelloProvider | null = null;

/** remoteControl installs the single consumer of inbound frames. */
export function setControlFrameHandler(fn: FrameHandler | null): void {
    handler = fn;
}

/**
 * Install the hello sender. Called whenever a control channel OPENS, not
 * just when a session key first appears: the hello used to be sent once per
 * key, so any legitimate mid-session channel loss (a renegotiation glare, an
 * ICE-failure rebuild, an SFU reconnect) was a ONE-WAY DOOR back to the
 * relay for the rest of the session — the feature silently stopped working
 * and nothing said so.
 */
export function setControlHelloProvider(fn: HelloProvider | null): void {
    helloProvider = fn;
}

function entry(peerId: number): CtlChannels {
    let e = byPeer.get(peerId);
    if (!e) {
        e = { state: null, helloSeen: { host: false, viewer: false } };
        byPeer.set(peerId, e);
    }
    return e;
}

/** The manager registers the negotiated channel it creates, and anything
 *  that still arrives via `ondatachannel` — which can only be an OLDER peer's
 *  in-band channel (a negotiated one is never announced). One channel per
 *  peer: the slot holds whichever channel BOTH ends hold.
 *
 *  When an in-band channel arrives while we hold the negotiated lane, the
 *  peer does not know the negotiated id and will only ever read its own
 *  channel — so its channel is the one input can ride, and we ADOPT it. The
 *  previous rule ("close the loser") is exactly what killed the lane between
 *  two current clients: the loser was the peer's own channel. It survives
 *  only for the residual case of two in-band channels, which no current
 *  client produces. */
export function registerControlChannel(peerId: number, dc: RTCDataChannel): void {
    const e = entry(peerId);
    if (e.state && e.state !== dc && e.state.readyState !== 'closed') {
        if (e.state.negotiated && !dc.negotiated) {
            const ours = e.state;
            e.state = null; // so ours.onclose (async) finds a different holder and stands down
            try { ours.close(); } catch { /* already gone */ }
        } else {
            try { dc.close(); } catch { /* already gone */ }
            return;
        }
    }
    e.state = dc;
    // A REBUILT channel starts unproved: the hello belonged to the
    // connection that carried it, and inheriting it would let input ride a
    // transport whose far end never answered on it.
    e.helloSeen = { host: false, viewer: false };
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev: MessageEvent) => {
        const data = ev.data;
        if (!(data instanceof ArrayBuffer)) return; // text on a binary channel: ignore
        const frame = decodeFrame(data);
        if (!frame) return;
        handler?.(peerId, frame, true);
    };
    const announce = () => helloProvider?.(peerId);
    if (dc.readyState === 'open') announce();
    else dc.onopen = announce;
    dc.onclose = () => {
        const cur = byPeer.get(peerId);
        if (!cur || cur.state !== dc) return;
        cur.state = null;
        // Losing the channel drops the peer back to the relay rather than
        // leaving a capability armed against a transport that is gone.
        cur.helloSeen = { host: false, viewer: false };
    };
}

/** The peer connection is going away: close the lane and drop the entry.
 *  Only the mesh manager calls this — a control session ending must NOT,
 *  see `disarmControlChannels`. */
export function forgetControlChannels(peerId: number): void {
    const e = byPeer.get(peerId);
    if (!e) return;
    if (e.state) { try { e.state.close(); } catch { /* already gone */ } }
    byPeer.delete(peerId);
}

/**
 * A control session with this peer ended (or a send on the lane failed and
 * the session is staying on the relay): drop the CAPABILITY, keep the pipe.
 *
 * Capability is per session — a hello from the last session must not arm
 * the next — and that is all this needs to drop: the next session's key
 * derivation sends a fresh hello on both ends, sealed under the new key, and
 * a stale one fails to open. The channel itself belongs to the peer
 * connection, and closing it here (which the first cut did, via
 * forgetControlChannels) closed it for the REST OF THE CALL on both ends: a
 * closed SCTP stream never reopens, and nothing re-creates the channel until
 * the pc is rebuilt. So the second control session of a call — and every
 * one after it — silently rode the relay.
 */
export function disarmControlChannels(peerId: number, role: CtlRole): void {
    const e = byPeer.get(peerId);
    if (e) e.helloSeen[role] = false;
}

export function controlChannels(peerId: number): CtlChannels | null {
    return byPeer.get(peerId) ?? null;
}

/** The peer's hello opened under the key of OUR `role`'s session with it. */
export function markHelloSeen(peerId: number, role: CtlRole): void {
    entry(peerId).helloSeen[role] = true;
}

/** May input for this peer ride the DC right now? BOTH the app-level hello
 *  and an open state lane — see the header on why readyState alone is not a
 *  capability. Congestion is NOT part of the answer: a backed-up lane is
 *  still the lane (see `controlDcCongested`); rerouting to the relay while
 *  it drains put a `down` and its `up` on two transports with no relative
 *  order. */
export function controlDcReady(peerId: number, role: CtlRole): boolean {
    const e = byPeer.get(peerId);
    if (!e || !e.helloSeen[role] || !e.state) return false;
    return e.state.readyState === 'open';
}

/** Is the lane backed up past the high-water mark? The sender holds MOTION
 *  while this is true and keeps state events on the lane — the valve is at
 *  the sender, the transport does not change. See CTL_HIGH_WATER_BYTES. */
export function controlDcCongested(peerId: number): boolean {
    const e = byPeer.get(peerId);
    if (!e || !e.state || e.state.readyState !== 'open') return false;
    return e.state.bufferedAmount > CTL_HIGH_WATER_BYTES;
}

/**
 * Send one frame; `false` means "not sent, use the relay". Never throws — a
 * closing channel raises on send, and an input path that throws would be a
 * dropped click.
 */
export function sendControlFrame(
    peerId: number, kind: number, payload: Uint8Array,
): boolean {
    const e = byPeer.get(peerId);
    if (!e) return false;
    const dc = e.state;
    if (!dc || dc.readyState !== 'open') return false;
    // No congestion refusal here: what reaches this while the lane is backed
    // up is a state event the sender chose to send past its valve, and it
    // must ride THIS ordered pipe behind the motion already queued on it.
    try {
        // Send the BUFFER: TS narrows Uint8Array to ArrayBufferLike, and
        // the DC overload wants a concrete ArrayBuffer.
        const frame = encodeFrame(kind, payload);
        dc.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
        return true;
    } catch {
        return false;
    }
}

/** Announce this end's capability on the state lane. Sealed by the caller
 *  (only it holds the session key), so a HELLO cannot be forged by the
 *  server or a bystander peer. */
export function sendHello(peerId: number, sealed: Uint8Array): boolean {
    return sendControlFrame(peerId, FRAME_HELLO, sealed);
}

// --- SFU transport (R3) ---------------------------------------------------
//
// The mesh registry above tracks per-peer DATA CHANNELS. An SFU room has
// none: one connection to the server carries everything, addressed per
// participant. Same frames, same hello gate, same handler — so this is a
// second SENDER plugged in beside the channels, not a second protocol.

type SfuSender = (userId: number, frame: Uint8Array) => boolean;
let sfuSend: SfuSender | null = null;
/** `${peerId}:${role}` — per (peer, role), see CtlRole. */
const sfuHello = new Set<string>();
const sfuKey = (peerId: number, role: CtlRole) => `${peerId}:${role}`;

/** sfuManager installs its publisher (null when it leaves the room). */
export function setSfuControlSender(fn: SfuSender | null): void {
    const wasNull = sfuSend === null;
    sfuSend = fn;
    if (!fn) { sfuHello.clear(); return; }
    // A room that just (re)connected has no capability yet, and nothing else
    // would ever announce one — the hello used to be sent once per session
    // key, which made an SFU reconnect a one-way door to the relay.
    //
    // `null` = "every session you hold". The first attempt at this iterated
    // `sfuHello`, which the line above had just emptied — an announce that
    // could never fire, describing itself as the fix for exactly the bug it
    // still had.
    if (wasNull) helloProvider?.(null);
}

/** sfuManager hands every `sov-ctl` data packet here. */
export function deliverSfuControlFrame(peerId: number, payload: Uint8Array<ArrayBufferLike>): void {
    const frame = decodeFrame(payload);
    if (!frame) return;
    handler?.(peerId, frame, false);
}

/** The SFU's own capability flag — the same sealed hello, a different pipe. */
export function markSfuHelloSeen(peerId: number, role: CtlRole): void {
    sfuHello.add(sfuKey(peerId, role));
}

export function sfuControlReady(peerId: number, role: CtlRole): boolean {
    return sfuSend !== null && sfuHello.has(sfuKey(peerId, role));
}

/** Publish one frame through the SFU; false = fall back to the relay. */
export function sendSfuControlFrame(peerId: number, kind: number, payload: Uint8Array): boolean {
    if (!sfuSend) return false;
    try {
        return sfuSend(peerId, encodeFrame(kind, payload));
    } catch {
        return false;
    }
}

export function forgetSfuControl(peerId: number, role: CtlRole): void {
    sfuHello.delete(sfuKey(peerId, role));
}

/**
 * Test seam: drop every registration and both capability sets.
 *
 * The frame HANDLER and the hello PROVIDER are deliberately left installed —
 * they belong to remoteControl (which installs both once, behind its own
 * `wired` latch), not to the channel registry, so clearing them here would
 * silently disable inbound frames for the rest of the process with no way to
 * reinstall. A test that genuinely wants them gone passes null to their own
 * setters; there is no separate reset for that, because a second way to do
 * one thing is a second thing to keep in step.
 */
export function resetControlChannels(): void {
    byPeer.clear();
    sfuSend = null;
    sfuHello.clear();
}
