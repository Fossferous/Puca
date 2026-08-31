//! Tauri commands: the bridge between the JS device session and the byte pump.
//!
//! JS owns the `'tunnel'` data channel (it lives on the session
//! `RTCPeerConnection`); Rust owns the sockets. So the split is:
//!
//!   Rust -> JS   a `tunnel-frame` event carrying one base64 frame to send.
//!   JS -> Rust   [`tunnel_inbound`] with one base64 frame that arrived.
//!
//! Frames are opaque base64 on this boundary ON PURPOSE. JS never parses them,
//! so there is exactly ONE implementation of the wire format (Rust's, already
//! fuzz-tested against malformed input) rather than a second one in TypeScript
//! that could drift from it — the same reasoning that put the media-frame format
//! behind a cross-language KAT.
//!
//! WHICH HALF RUNS WHERE. A device session has a controller and a host, and the
//! same binary is both depending on the direction, so this holds either kind
//! keyed by session id. The controller half is created by
//! [`tunnel_open_listener`]; the host half by [`tunnel_arm_host`], which the
//! session setup calls when a peer is permitted to request forwards at all.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::Serialize;
use tauri::Emitter;

use crate::tunnel::frame::TunnelFrame;
use crate::tunnel::TunnelPolicy;
use crate::tunnel_pump::{ControllerTunnel, HostTunnel};

/// One frame on its way out to the peer, tagged with the session it belongs to.
#[derive(Clone, Serialize)]
pub struct OutboundFrame {
    pub session_id: String,
    /// base64 of the encoded frame.
    pub frame: String,
}

/// Where the local forwarding decision is persisted.
///
/// DEVICE-LOCAL, NOT SERVER-STORED, and that is a security decision rather than
/// a convenience one. "This machine may be asked to forward ports" has to be
/// decided AT the machine: a server-held flag could be flipped by anyone who
/// compromises the account, silently turning every armed device into a pivot.
/// Beside the device key, for the same reason it lives there — the authority a
/// webview must not be able to grant itself.
fn policy_path() -> Result<std::path::PathBuf, String> {
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is not set".to_string())?;
    #[cfg(not(windows))]
    let base = std::env::var("HOME")
        .map(|h| format!("{h}/.local/share"))
        .map_err(|_| "HOME is not set".to_string())?;
    let dir = std::path::Path::new(&base).join(env!("PUCA_IDENTIFIER")).join("device");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    Ok(dir.join("tunnel-policy.json"))
}

/// The stored forwarding policy, or the safe default if none/unreadable.
///
/// A corrupt or unreadable file yields the DEFAULT (disabled), never an error
/// that a caller might paper over: failing open here would arm forwarding
/// because a file was truncated.
#[tauri::command]
pub fn tunnel_policy_get() -> TunnelPolicy {
    let Ok(path) = policy_path() else {
        return TunnelPolicy::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<TunnelPolicy>(&raw).ok())
        .unwrap_or_default()
}

/// Turn local forwarding on or off.
///
/// v1 exposes only the ON/OFF decision; the allowlist stays the loopback-only
/// default. That covers the motivating case (forward 3389 and RDP into this
/// machine) without asking a user to reason about CIDR blocks to get it — and
/// widening the allowlist is exactly the choice that should NOT be one careless
/// click away. Custom subnets are a deliberate later refinement.
#[tauri::command]
pub fn tunnel_policy_set(enabled: bool) -> Result<(), String> {
    let mut policy = TunnelPolicy::default();
    policy.enabled = enabled;
    let path = policy_path()?;
    let json = serde_json::to_string_pretty(&policy)
        .map_err(|e| format!("could not serialise the policy: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("could not write {path:?}: {e}"))?;
    Ok(())
}

/// A live forwarding session: whichever halves this side is playing.
#[derive(Default)]
struct Session {
    controller: Option<Arc<ControllerTunnel>>,
    host: Option<Arc<HostTunnel>>,
    /// Local ports we bound for this session, for the UI banner.
    listeners: Vec<ListenerInfo>,
}

/// A bound local port and where it forwards to. Surfaced so the session banner
/// can say "tunnels: 1 active -> 192.168.1.10:3389" rather than leaving a
/// lateral-movement primitive running invisibly.
#[derive(Clone, Serialize)]
pub struct ListenerInfo {
    pub local_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

#[derive(Default)]
pub struct Tunnels(Mutex<HashMap<String, Session>>);

/// Relay a pump's outbound frames to JS until the pump is dropped.
///
/// One thread per session half. It ends when the pump's `Sender` is dropped,
/// which happens on `tunnel_close`, so nothing has to signal it explicitly.
fn spawn_relay(app: tauri::AppHandle, session_id: String, rx: Receiver<TunnelFrame>) {
    std::thread::spawn(move || {
        for f in rx {
            let encoded = base64::engine::general_purpose::STANDARD.encode(f.encode());
            let _ = app.emit(
                "tunnel-frame",
                OutboundFrame { session_id: session_id.clone(), frame: encoded },
            );
        }
    });
}

/// Arm the HOST half: this machine may be asked to dial, subject to the policy
/// STORED ON THIS MACHINE.
///
/// Called at session setup. Without it, an `Open` from the peer finds no host
/// half and is ignored — which is the correct default: a device session does NOT
/// imply permission to forward ports.
///
/// The policy is read from disk here and is deliberately NOT a parameter. It
/// used to be passed in from JS, which contradicted the rule this module is
/// built on (see `policy_path`): "this machine may be asked to forward ports"
/// has to be decided AT the machine, because it is the authority a webview must
/// not be able to grant itself. Taking it as an argument meant anything running
/// in the webview could arm forwarding with `enabled: true` and a wide
/// allowlist regardless of what the user had actually stored — turning the
/// device session into a lateral-movement pivot the user never consented to.
///
/// `tunnel_policy_get` fails CLOSED to the disabled default on a missing or
/// corrupt file, so an unreadable policy arms nothing.
#[tauri::command]
pub fn tunnel_arm_host(
    app: tauri::AppHandle,
    tunnels: tauri::State<'_, Tunnels>,
    session_id: String,
) -> Result<(), String> {
    let policy = tunnel_policy_get();
    let (tx, rx) = channel::<TunnelFrame>();
    let host = HostTunnel::new(policy, tx);
    let mut guard = tunnels.0.lock().map_err(|_| "tunnel state poisoned")?;
    let entry = guard.entry(session_id.clone()).or_default();
    // Replacing an armed host tears the old one down, so re-arming with a
    // narrower policy cannot leave the previous one forwarding.
    if let Some(old) = entry.host.replace(host) {
        old.shutdown();
    }
    drop(guard);
    spawn_relay(app, session_id, rx);
    Ok(())
}

/// Open a local listener that forwards to `target_host:target_port` on the peer.
///
/// Returns the bound local port. Pass 0 for an ephemeral one — which is the
/// better default, since a fixed port can collide and the caller learns the real
/// one from the return value anyway.
#[tauri::command]
pub fn tunnel_open_listener(
    app: tauri::AppHandle,
    tunnels: tauri::State<'_, Tunnels>,
    session_id: String,
    local_port: u16,
    target_host: String,
    target_port: u16,
) -> Result<u16, String> {
    let mut guard = tunnels.0.lock().map_err(|_| "tunnel state poisoned")?;
    let entry = guard.entry(session_id.clone()).or_default();

    // Create the controller half on first use; later listeners share it so every
    // forward for one session multiplexes over the one data channel.
    let (controller, fresh_rx) = match entry.controller.clone() {
        Some(c) => (c, None),
        None => {
            let (tx, rx) = channel::<TunnelFrame>();
            let c = ControllerTunnel::new(tx);
            entry.controller = Some(Arc::clone(&c));
            (c, Some(rx))
        }
    };

    let bound = controller
        .listen(local_port, target_host.clone(), target_port)
        .map_err(|e| format!("could not bind 127.0.0.1:{local_port}: {e}"))?;
    entry.listeners.push(ListenerInfo {
        local_port: bound,
        target_host,
        target_port,
    });
    drop(guard);

    if let Some(rx) = fresh_rx {
        spawn_relay(app, session_id, rx);
    }
    Ok(bound)
}

/// Feed one frame that arrived on the data channel (base64) into the pumps.
#[tauri::command]
pub fn tunnel_inbound(
    tunnels: tauri::State<'_, Tunnels>,
    session_id: String,
    frame: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(frame.as_bytes())
        .map_err(|e| format!("frame is not valid base64: {e}"))?;
    // A malformed frame is DROPPED, not propagated as an error: these bytes come
    // from a remote peer, and letting it drive error paths in the caller is a
    // needless lever. The decoder already rejects every malformed shape.
    let Ok(parsed) = TunnelFrame::decode(&bytes) else {
        return Ok(());
    };

    // Clone the Arcs out from under the lock: handle_frame can block on a socket
    // write, and holding the registry lock across that would stall every other
    // session.
    let (controller, host) = {
        let guard = tunnels.0.lock().map_err(|_| "tunnel state poisoned")?;
        match guard.get(&session_id) {
            Some(s) => (s.controller.clone(), s.host.clone()),
            None => (None, None),
        }
    };

    // Route by frame kind rather than broadcasting to both halves: Open belongs
    // to the host, OpenResult to the controller, and Data/Close to whichever
    // half owns that stream id (each ignores ids it does not know).
    match &parsed {
        TunnelFrame::Open { .. } => {
            if let Some(h) = host {
                h.handle_frame(parsed);
            }
        }
        TunnelFrame::OpenResult { .. } => {
            if let Some(c) = controller {
                c.handle_frame(parsed);
            }
        }
        TunnelFrame::Data { .. } | TunnelFrame::Close { .. } => {
            if let Some(c) = controller {
                c.handle_frame(parsed.clone());
            }
            if let Some(h) = host {
                h.handle_frame(parsed);
            }
        }
    }
    Ok(())
}

/// What is currently forwarding, for the session banner.
#[derive(Clone, Serialize, Default)]
pub struct TunnelStatus {
    /// Bound local ports and where each forwards to.
    pub listeners: Vec<ListenerInfo>,
    /// Connections currently open THROUGH those listeners (controller side).
    pub active_streams: usize,
    /// Connections this machine is currently forwarding FOR a peer (host side).
    /// Non-zero here means someone else is reaching our network right now, which
    /// is the number the banner most needs to show.
    pub inbound_streams: usize,
    /// Whether this machine is armed to accept forward requests at all.
    pub host_armed: bool,
}

#[tauri::command]
pub fn tunnel_status(
    tunnels: tauri::State<'_, Tunnels>,
    session_id: String,
) -> Result<TunnelStatus, String> {
    let guard = tunnels.0.lock().map_err(|_| "tunnel state poisoned")?;
    let Some(s) = guard.get(&session_id) else {
        return Ok(TunnelStatus::default());
    };
    Ok(TunnelStatus {
        listeners: s.listeners.clone(),
        active_streams: s.controller.as_ref().map(|c| c.active()).unwrap_or(0),
        inbound_streams: s.host.as_ref().map(|h| h.active()).unwrap_or(0),
        host_armed: s.host.is_some(),
    })
}

/// Tear a session's tunnelling down entirely. MUST be called on `DeviceEnd`:
/// in-flight sockets are closed rather than orphaned, or a revoked session keeps
/// forwarding.
#[tauri::command]
pub fn tunnel_close(
    tunnels: tauri::State<'_, Tunnels>,
    session_id: String,
) -> Result<(), String> {
    let removed = {
        let mut guard = tunnels.0.lock().map_err(|_| "tunnel state poisoned")?;
        guard.remove(&session_id)
    };
    if let Some(s) = removed {
        if let Some(c) = s.controller {
            c.shutdown();
        }
        if let Some(h) = s.host {
            h.shutdown();
        }
    }
    Ok(())
}

/// Close every session. Called when the app exits or all device sessions end.
pub fn close_all(tunnels: &Tunnels) {
    let sessions: Vec<Session> = match tunnels.0.lock() {
        Ok(mut g) => g.drain().map(|(_, s)| s).collect(),
        Err(_) => return,
    };
    for s in sessions {
        if let Some(c) = s.controller {
            c.shutdown();
        }
        if let Some(h) = s.host {
            h.shutdown();
        }
    }
}
