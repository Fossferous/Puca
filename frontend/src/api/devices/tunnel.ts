/**
 * Port forwarding over a device session — the JS half.
 *
 * Deliberately thin. JS owns the `'tunnel'` data channel because the channel
 * lives on the session `RTCPeerConnection`; Rust owns the sockets and the wire
 * format. So this module does exactly three things: create the channel, relay
 * opaque base64 frames in both directions, and apply backpressure.
 *
 * IT NEVER PARSES A FRAME. Frames are opaque here so there is only ONE
 * implementation of the format — Rust's, which is already tested against every
 * malformed shape a peer can send. A second parser in TypeScript would be free
 * to drift from it, and the failure mode of a drifting tunnel parser is
 * corrupted bytes in someone's RDP session.
 *
 * WHAT THIS IS, in the UI's words: forwarding lets the far end reach services on
 * the HOST's network. That is a lateral-movement primitive, so it is off unless
 * armed, scoped by the host's allowlist (default: loopback only), and shown in
 * the session banner while active. See `src-tauri/src/tunnel.rs`.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { HIGH_WATER, LOW_WATER } from '../fileTransfer';
import { isTauri } from '../platform';

/** A bound local port and where it forwards to. Mirrors `ListenerInfo`. */
export interface TunnelListener {
    local_port: number;
    target_host: string;
    target_port: number;
}

/** Mirrors `TunnelStatus` — what the session banner renders. */
export interface TunnelStatus {
    listeners: TunnelListener[];
    /** Connections open through OUR listeners (we are the controller). */
    active_streams: number;
    /** Connections WE are forwarding for a peer (we are the host). Non-zero
     *  means someone is reaching our network right now. */
    inbound_streams: number;
    host_armed: boolean;
}

/** One permitted destination. Mirrors `TargetRule`. */
export interface TargetRule {
    base: string;
    prefix: number;
    ports?: number[];
}

/** Mirrors `TunnelPolicy`. Everything defaults to refusing. */
export interface TunnelPolicy {
    enabled: boolean;
    allowed: TargetRule[];
    elevated_host?: boolean;
    armed_for_elevated?: boolean;
}

/** Loopback-only, the safe default the host uses if forwarding is turned on. */
export function loopbackOnlyPolicy(): TunnelPolicy {
    return {
        enabled: true,
        allowed: [
            { base: '127.0.0.0', prefix: 8, ports: [] },
            { base: '::1', prefix: 128, ports: [] },
        ],
    };
}

/** Whether this build can forward at all. Web devices have no Rust side and
 *  therefore no sockets, so the control is hidden rather than shown broken. */
export function tunnelSupported(): boolean {
    return isTauri();
}

/**
 * The locally stored forwarding policy.
 *
 * Read from Rust, never from localStorage: "this machine may be asked to forward
 * ports" is authority a webview must not be able to grant itself, so it lives on
 * disk beside the device key. A missing or unreadable file reads as DISABLED.
 */
export async function getTunnelPolicy(): Promise<TunnelPolicy> {
    if (!isTauri()) return { enabled: false, allowed: [] };
    return invoke<TunnelPolicy>('tunnel_policy_get');
}

/**
 * Turn local forwarding on or off. Returns an error message, or null on success
 * — the same shape as setAutostart, so the settings UI handles both alike.
 *
 * Only the on/off decision is exposed; the allowlist stays loopback-only. That
 * covers the motivating case without asking anyone to reason about CIDR blocks,
 * and widening it is exactly the choice that should not be one careless click
 * away.
 */
export async function setTunnelForwarding(enabled: boolean): Promise<string | null> {
    if (!isTauri()) return 'Port forwarding needs the desktop app.';
    try {
        await invoke('tunnel_policy_set', { enabled });
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

interface Wiring {
    channel: RTCDataChannel;
    unlisten: UnlistenFn;
}

const wirings = new Map<string, Wiring>();

/** Await room in the send buffer, so a fast forwarded stream cannot outrun the
 *  channel and buffer the transfer into memory. Same discipline and thresholds
 *  as file transfer — a tunnel can move just as much data. */
function drain(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount < HIGH_WATER) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const onLow = () => {
            channel.removeEventListener('bufferedamountlow', onLow);
            resolve();
        };
        if (channel.readyState !== 'open') {
            resolve(); // Closing is handled by the send path; do not hang here.
            return;
        }
        channel.bufferedAmountLowThreshold = LOW_WATER;
        channel.addEventListener('bufferedamountlow', onLow);
    });
}

/**
 * Wire a `'tunnel'` data channel to the Rust pumps for `sessionId`.
 *
 * Call with the channel the controller created, or the one the host received via
 * `ondatachannel`. Safe to call once per session; a second call replaces the
 * first (and detaches it) rather than leaving two relays racing.
 */
export async function attachTunnelChannel(
    sessionId: string,
    channel: RTCDataChannel,
): Promise<void> {
    detachTunnelChannel(sessionId);

    // Binary is what the pump produces; ArrayBuffer avoids a Blob round-trip on
    // every inbound frame.
    channel.binaryType = 'arraybuffer';

    // Rust -> peer. The event carries every session's frames, so filter by id:
    // two concurrent device sessions must not cross-feed each other.
    const unlisten = await listen<{ session_id: string; frame: string }>(
        'tunnel-frame',
        async (event) => {
            if (event.payload.session_id !== sessionId) return;
            if (channel.readyState !== 'open') return;
            await drain(channel);
            if (channel.readyState !== 'open') return;
            channel.send(base64ToBytes(event.payload.frame));
        },
    );

    // Peer -> Rust.
    channel.addEventListener('message', (ev: MessageEvent) => {
        const bytes =
            ev.data instanceof ArrayBuffer
                ? new Uint8Array(ev.data)
                : typeof ev.data === 'string'
                  ? new TextEncoder().encode(ev.data)
                  : null;
        if (!bytes) return;
        void invoke('tunnel_inbound', {
            sessionId,
            frame: bytesToBase64(bytes),
        }).catch(() => {
            // A rejected frame is already dropped on the Rust side; there is
            // nothing useful to do here and throwing would break the listener.
        });
    });

    // The channel dying takes the forwards with it — otherwise sockets would sit
    // open with no transport to carry their bytes. Guarded on IDENTITY: a
    // media restart replaces the channel under the same session id, and some
    // engines deliver the OLD channel's close only after the replacement is
    // attached — unguarded, that late event unlistened the new relay and tore
    // down the Rust-side session state the new channel was carrying, leaving
    // forwards that silently move nothing.
    channel.addEventListener('close', () => {
        if (wirings.get(sessionId)?.channel === channel) {
            void closeTunnels(sessionId);
        }
    });

    wirings.set(sessionId, { channel, unlisten });
}

/** Stop relaying for a session without tearing down its sockets. */
export function detachTunnelChannel(sessionId: string): void {
    const w = wirings.get(sessionId);
    if (!w) return;
    w.unlisten();
    wirings.delete(sessionId);
}

/**
 * Arm this machine to ACCEPT forward requests from the peer.
 *
 * Not called by default, and that is the point: a device session does not imply
 * permission to forward ports. The host arms it explicitly.
 *
 * Takes NO policy: the native side reads the policy stored on this machine
 * (`tunnel_policy_get`, set via the Tunnels setting) and ignores anything the
 * webview might claim. Passing one from here would let any script running in
 * the webview grant itself forwarding the user never enabled — the authority
 * this whole module is designed to keep out of JS. Use `getTunnelPolicy` to
 * SHOW the user what is in force, and `setTunnelPolicy` to change it.
 */
export async function armHost(sessionId: string): Promise<void> {
    await invoke('tunnel_arm_host', { sessionId });
}

/**
 * Open a local listener forwarding to `targetHost:targetPort` on the peer.
 * Returns the bound local port; pass 0 for an ephemeral one.
 */
export async function openTunnel(
    sessionId: string,
    targetHost: string,
    targetPort: number,
    localPort = 0,
): Promise<number> {
    return invoke<number>('tunnel_open_listener', {
        sessionId,
        localPort,
        targetHost,
        targetPort,
    });
}

/** What is forwarding right now, for the session banner. */
export async function tunnelStatus(sessionId: string): Promise<TunnelStatus> {
    return invoke<TunnelStatus>('tunnel_status', { sessionId });
}

/**
 * Tear down all forwarding for a session. MUST be called when the session ends —
 * in-flight sockets are closed rather than orphaned, or a revoked session keeps
 * forwarding.
 */
export async function closeTunnels(sessionId: string): Promise<void> {
    detachTunnelChannel(sessionId);
    await invoke('tunnel_close', { sessionId }).catch(() => {
        // Already gone is the desired end state.
    });
}

// --- base64 helpers -------------------------------------------------------
// Frames are binary; the Tauri command boundary is JSON. These are the only
// places the bytes are touched in JS, and neither interprets them.

export function bytesToBase64(bytes: Uint8Array): string {
    let s = '';
    // Chunked rather than one String.fromCharCode(...bytes) spread.
    //
    // MEASURED, not assumed: on V8 the naive spread handles the pump's 32 KiB
    // frames fine, so the unit tests pass either way and do NOT prove this
    // necessary. It stays because the spread-argument limit is ENGINE-specific
    // and lower elsewhere — notably WebKitGTK, which is what Tauri uses on
    // Linux, the platform this app already treats as its awkward one. Cheap
    // insurance against a limit we cannot test from here, not a fix for a bug
    // reproduced here.
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    // Backed by an explicit ArrayBuffer, not the default ArrayBufferLike:
    // RTCDataChannel.send accepts ArrayBufferView<ArrayBuffer> only, since a
    // SharedArrayBuffer cannot be transferred. `tsc --noEmit` lets the looser
    // type through; `npm run build` does not -- the reason CLAUDE.md says to run
    // both.
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
