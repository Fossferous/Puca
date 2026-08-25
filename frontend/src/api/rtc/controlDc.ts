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
 */

export const CTL_STATE_LABEL = 'sov-ctl-s';
/** LiveKit data topic for the same frames over an SFU room (R3). */
export const CTL_SFU_TOPIC = 'sov-ctl';

/** Above this many unsent bytes on a control channel, frames take the RELAY
 *  instead of queueing behind a congested SCTP association. Matches the WS
 *  path's own high-water mark; without it the queue grows until the
 *  browser's send buffer throws, which is both a memory risk and the worst
 *  possible moment to discover the transport is unusable. */
export const CTL_HIGH_WATER_BYTES = 64 * 1024;

/** Frame kinds. One byte, so a mis-shaped buffer is refused, not parsed. */
export const FRAME_HELLO = 0x01;
export const FRAME_SEALED_INPUT = 0x02;

/** One peer's control channel, from whichever side created it. */
export interface CtlChannels {
    state: RTCDataChannel | null;
    /** The peer answered our HELLO (or sent theirs): frames may ride the DC. */
    helloSeen: boolean;
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
        e = { state: null, helloSeen: false };
        byPeer.set(peerId, e);
    }
    return e;
}

/** The manager registers each channel as it is created or arrives via
 *  `ondatachannel`. Both sides may create; whoever's label lands first wins
 *  the slot and the other is closed — one channel per lane per peer. */
export function registerControlChannel(peerId: number, dc: RTCDataChannel): void {
    const e = entry(peerId);
    if (e.state && e.state !== dc && e.state.readyState !== 'closed') {
        try { dc.close(); } catch { /* already gone */ }
        return;
    }
    e.state = dc;
    // A REBUILT channel starts unproved: the hello belonged to the
    // connection that carried it, and inheriting it would let input ride a
    // transport whose far end never answered on it.
    e.helloSeen = false;
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
        cur.helloSeen = false;
    };
}

export function forgetControlChannels(peerId: number): void {
    const e = byPeer.get(peerId);
    if (!e) return;
    if (e.state) { try { e.state.close(); } catch { /* already gone */ } }
    byPeer.delete(peerId);
}

export function controlChannels(peerId: number): CtlChannels | null {
    return byPeer.get(peerId) ?? null;
}

export function markHelloSeen(peerId: number): void {
    entry(peerId).helloSeen = true;
}

/** May input for this peer ride the DC right now? BOTH the app-level hello
 *  and an open state lane — see the header on why readyState alone is not a
 *  capability. */
export function controlDcReady(peerId: number): boolean {
    const e = byPeer.get(peerId);
    if (!e || !e.helloSeen || !e.state) return false;
    if (e.state.readyState !== 'open') return false;
    // CONGESTION IS NOT READINESS. Queueing behind a stalled association
    // would grow unboundedly until the browser's send buffer throws — the
    // relay has its own valve and is the better place to be while this one
    // drains.
    return e.state.bufferedAmount <= CTL_HIGH_WATER_BYTES;
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
    if (dc.bufferedAmount > CTL_HIGH_WATER_BYTES) return false;
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
const sfuHello = new Set<number>();

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
export function markSfuHelloSeen(peerId: number): void {
    sfuHello.add(peerId);
}

export function sfuControlReady(peerId: number): boolean {
    return sfuSend !== null && sfuHello.has(peerId);
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

export function forgetSfuControl(peerId: number): void {
    sfuHello.delete(peerId);
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
