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
 * TWO LANES, because input is two kinds of thing:
 *  - STATE (`sov-ctl-s`, reliable+ordered): clicks, keys, wheel, and
 *    RELATIVE moves. Rmove deltas are CUMULATIVE — dropping or reordering
 *    one loses aim distance forever, so they ride the reliable lane with the
 *    clicks whose position they determine.
 *  - MOTION (`sov-ctl-m`, unordered, maxRetransmits 2): ABSOLUTE moves only.
 *    A stale absolute position is worthless — the next one supersedes it —
 *    so retransmitting it is pure added latency.
 *
 * SEQUENCE NAMESPACES ARE PER TRANSPORT. The DC and the WS relay each carry
 * their own counter, and the receiver tracks them separately: merging them
 * re-creates the bug where a fast DC move bumped the sequence past a WS
 * click that was still in flight, and the host dropped the click.
 *
 * THE CAPABILITY GATE IS AN APP-LEVEL HELLO, never `dc.readyState`. An open
 * channel proves SCTP came up, not that the peer's app understands these
 * frames — str0m and every browser open a channel by label whatever the
 * other end does with it. Input rides the DC only after a sealed HELLO
 * arrives on it, which only a peer holding the session key can produce.
 */

export const CTL_STATE_LABEL = 'sov-ctl-s';
export const CTL_MOTION_LABEL = 'sov-ctl-m';
/** LiveKit data topic for the same frames over an SFU room (R3). */
export const CTL_SFU_TOPIC = 'sov-ctl';

/** Frame kinds. One byte, so a mis-shaped buffer is refused, not parsed. */
export const FRAME_HELLO = 0x01;
export const FRAME_SEALED_INPUT = 0x02;

/** How long to wait for the peer's HELLO before giving up on the DC for this
 *  session. Generous: the channels open with the pc, and the grant that
 *  starts input can arrive much later. */
export const HELLO_TIMEOUT_MS = 2_000;

export type CtlLane = 'state' | 'motion';

/** One peer's control channels, from whichever side created them. */
export interface CtlChannels {
    state: RTCDataChannel | null;
    motion: RTCDataChannel | null;
    /** The peer answered our HELLO (or sent theirs): frames may ride the DC. */
    helloSeen: boolean;
}

/** Which lane an event belongs on. Absolute moves are the ONLY unreliable
 *  traffic — see the header. */
export function laneFor(eventType: string): CtlLane {
    return eventType === 'move' ? 'motion' : 'state';
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
    lane: CtlLane,
    frame: { kind: number; payload: Uint8Array },
    /** true = a mesh data channel, false = the SFU room's data path. The
     *  hello must arm the pipe it ARRIVED on, not both. */
    viaMesh: boolean,
) => void;
let handler: FrameHandler | null = null;

/** remoteControl installs the single consumer of inbound frames. */
export function setControlFrameHandler(fn: FrameHandler | null): void {
    handler = fn;
}

function entry(peerId: number): CtlChannels {
    let e = byPeer.get(peerId);
    if (!e) {
        e = { state: null, motion: null, helloSeen: false };
        byPeer.set(peerId, e);
    }
    return e;
}

/** The manager registers each channel as it is created or arrives via
 *  `ondatachannel`. Both sides may create; whoever's label lands first wins
 *  the slot and the other is closed — one channel per lane per peer. */
export function registerControlChannel(peerId: number, lane: CtlLane, dc: RTCDataChannel): void {
    const e = entry(peerId);
    const existing = lane === 'state' ? e.state : e.motion;
    if (existing && existing !== dc && existing.readyState !== 'closed') {
        try { dc.close(); } catch { /* already gone */ }
        return;
    }
    if (lane === 'state') e.state = dc; else e.motion = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev: MessageEvent) => {
        const data = ev.data;
        if (!(data instanceof ArrayBuffer)) return; // text on a binary lane: ignore
        const frame = decodeFrame(data);
        if (!frame) return;
        handler?.(peerId, lane, frame, true);
    };
    dc.onclose = () => {
        const cur = byPeer.get(peerId);
        if (!cur) return;
        if (lane === 'state' && cur.state === dc) cur.state = null;
        if (lane === 'motion' && cur.motion === dc) cur.motion = null;
        // The STATE lane is the capability carrier: losing it drops the peer
        // back to the relay rather than leaving half a transport armed.
        if (lane === 'state') cur.helloSeen = false;
    };
}

export function forgetControlChannels(peerId: number): void {
    const e = byPeer.get(peerId);
    if (!e) return;
    for (const dc of [e.state, e.motion]) {
        if (dc) { try { dc.close(); } catch { /* already gone */ } }
    }
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
export function controlDcReady(peerId: number, lane: CtlLane = 'state'): boolean {
    const e = byPeer.get(peerId);
    if (!e || !e.helloSeen) return false;
    const dc = lane === 'motion' ? (e.motion ?? e.state) : e.state;
    return !!dc && dc.readyState === 'open';
}

/**
 * Send one frame; `false` means "not sent, use the relay". Never throws — a
 * closing channel raises on send, and an input path that throws would be a
 * dropped click.
 */
export function sendControlFrame(
    peerId: number, lane: CtlLane, kind: number, payload: Uint8Array,
): boolean {
    const e = byPeer.get(peerId);
    if (!e) return false;
    const dc = lane === 'motion' ? (e.motion ?? e.state) : e.state;
    if (!dc || dc.readyState !== 'open') return false;
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
    return sendControlFrame(peerId, 'state', FRAME_HELLO, sealed);
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
    sfuSend = fn;
    if (!fn) sfuHello.clear();
}

/** sfuManager hands every `sov-ctl` data packet here. */
export function deliverSfuControlFrame(peerId: number, payload: Uint8Array<ArrayBufferLike>): void {
    const frame = decodeFrame(payload);
    if (!frame) return;
    handler?.(peerId, 'state', frame, false);
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
 * The frame HANDLER is deliberately left installed — it belongs to
 * remoteControl (which installs it once, behind its own `wired` latch), not
 * to the channel registry, so clearing it here would silently disable
 * inbound frames for the rest of the process with no way to reinstall.
 */
export function resetControlChannels(): void {
    byPeer.clear();
    sfuSend = null;
    sfuHello.clear();
}
