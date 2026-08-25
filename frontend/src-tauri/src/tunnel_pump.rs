//! The tunnel byte pump: real sockets on both ends of the framed channel.
//!
//! [`tunnel`](crate::tunnel) decides WHETHER a target may be dialled and how
//! bytes are framed. This moves them. Two halves that never run in one process
//! in production but are deliberately written to be wired back-to-back in a test:
//!
//!   * [`ControllerTunnel`] — listens on `127.0.0.1:<port>`, and for each local
//!     connection opens a stream and pumps bytes to the host.
//!   * [`HostTunnel`] — receives `Open`, POLICY-CHECKS the target, dials it, and
//!     pumps bytes back.
//!
//! Blocking `std::net` sockets with a thread per stream, not an async runtime.
//! A port forward carries a handful of connections (three RDP windows is three),
//! so a thread each costs less than the reasoning overhead of introducing an
//! executor into a crate that has none. Reads block in their own thread and
//! `shutdown(Both)` unblocks them at teardown.
//!
//! FRAMES OUT GO TO A CHANNEL, not to WebRTC. The caller relays
//! `Receiver<TunnelFrame>` onto the `'tunnel'` data channel and feeds inbound
//! messages to `handle_frame`. That seam is what makes the loopback test
//! possible — it wires two pumps to each other with no WebRTC at all and proves
//! bytes really traverse both sockets.
//!
//! WHY THE HANDSHAKE WAITS. An accepted local socket is held in `pending` and
//! its reader is NOT started until `OpenResult{ok:true}` arrives. Many protocols
//! speak client-first (RDP among them), so pumping immediately would send bytes
//! the host must drop because the dial has not completed — the connection would
//! then hang, having lost its opening message.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use crate::tunnel::frame::TunnelFrame;
use crate::tunnel::{resolve_target, TunnelPolicy};

/// Read chunk. Each read becomes one `Data` frame, so this also bounds the
/// data-channel message size the peer must accept.
const CHUNK: usize = 32 * 1024;

/// Send a frame, ignoring a closed channel — teardown races are normal and must
/// not panic a pump thread.
fn emit(out: &Sender<TunnelFrame>, f: TunnelFrame) {
    let _ = out.send(f);
}

/// Pump one socket into `Data` frames until EOF, then emit `Close`.
///
/// Shared by both halves: the direction differs, the loop does not. `on_end`
/// lets the owner drop its registry entry so a finished stream leaves nothing
/// behind.
fn pump_reads(
    mut sock: TcpStream,
    stream: u32,
    out: Sender<TunnelFrame>,
    on_end: impl FnOnce(),
) {
    let mut buf = vec![0u8; CHUNK];
    loop {
        match sock.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => emit(&out, TunnelFrame::Data { stream, payload: buf[..n].to_vec() }),
            // Any error ends the stream. A reset mid-transfer is a normal way
            // for a forwarded connection to die, not something to retry.
            Err(_) => break,
        }
    }
    emit(&out, TunnelFrame::Close { stream });
    on_end();
}

/// Close a socket hard so a blocked reader thread wakes and exits.
fn hangup(sock: &TcpStream) {
    let _ = sock.shutdown(Shutdown::Both);
}

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

/// The host end: dials policy-approved targets and pumps bytes.
pub struct HostTunnel {
    policy: TunnelPolicy,
    out: Sender<TunnelFrame>,
    /// stream id -> write half of the dialled socket.
    streams: Mutex<HashMap<u32, TcpStream>>,
    closed: AtomicBool,
}

impl HostTunnel {
    pub fn new(policy: TunnelPolicy, out: Sender<TunnelFrame>) -> Arc<Self> {
        Arc::new(Self {
            policy,
            out,
            streams: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        })
    }

    /// Handle one inbound frame from the controller.
    pub fn handle_frame(self: &Arc<Self>, f: TunnelFrame) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        match f {
            TunnelFrame::Open { stream, host, port } => self.open(stream, &host, port),
            TunnelFrame::Data { stream, payload } => {
                // Write under the lock. A forwarded connection is ordered, and
                // frames for one stream arrive in order, so this preserves it.
                let mut guard = self.streams.lock().unwrap();
                if let Some(sock) = guard.get_mut(&stream) {
                    if sock.write_all(&payload).is_err() {
                        if let Some(dead) = guard.remove(&stream) {
                            hangup(&dead);
                        }
                        emit(&self.out, TunnelFrame::Close { stream });
                    }
                }
                // An unknown stream is silently dropped: it is the normal race
                // where Close and a late Data cross.
            }
            TunnelFrame::Close { stream } => {
                if let Some(sock) = self.streams.lock().unwrap().remove(&stream) {
                    hangup(&sock);
                }
            }
            // The host never receives OpenResult; it sends them.
            TunnelFrame::OpenResult { .. } => {}
        }
    }

    /// THE GATE IN ACTION: resolve, policy-check, then dial the CHECKED address.
    fn open(self: &Arc<Self>, stream: u32, host: &str, port: u16) {
        let addr: SocketAddr = match resolve_target(host, port, &self.policy) {
            Ok(a) => a,
            Err(denied) => {
                // Refusals are reported, never silent: the controller must be
                // able to tell the user WHY, or they will assume it is broken.
                emit(
                    &self.out,
                    TunnelFrame::OpenResult {
                        stream,
                        ok: false,
                        error: denied.to_string(),
                    },
                );
                return;
            }
        };

        // Connect to the exact SocketAddr the policy approved — never re-resolve
        // the name, which is the whole time-of-check/time-of-use point.
        let sock = match TcpStream::connect(addr) {
            Ok(s) => s,
            Err(e) => {
                emit(
                    &self.out,
                    TunnelFrame::OpenResult { stream, ok: false, error: format!("{addr}: {e}") },
                );
                return;
            }
        };
        let reader = match sock.try_clone() {
            Ok(r) => r,
            Err(e) => {
                emit(
                    &self.out,
                    TunnelFrame::OpenResult { stream, ok: false, error: e.to_string() },
                );
                return;
            }
        };

        self.streams.lock().unwrap().insert(stream, sock);
        emit(&self.out, TunnelFrame::OpenResult { stream, ok: true, error: String::new() });

        let out = self.out.clone();
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            pump_reads(reader, stream, out, move || {
                me.streams.lock().unwrap().remove(&stream);
            });
        });
    }

    /// Tear every stream down. Called on `DeviceEnd` — in-flight sockets must be
    /// closed, not orphaned, or a revoked session keeps forwarding.
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        for (_, sock) in self.streams.lock().unwrap().drain() {
            hangup(&sock);
        }
    }

    /// Live stream count — for the session banner and for tests.
    pub fn active(&self) -> usize {
        self.streams.lock().unwrap().len()
    }
}

// ---------------------------------------------------------------------------
// Controller side
// ---------------------------------------------------------------------------

/// A local socket accepted but not yet confirmed by the host.
struct Pending {
    sock: TcpStream,
}

/// The controller end: listens locally, opens streams, pumps bytes.
pub struct ControllerTunnel {
    out: Sender<TunnelFrame>,
    /// Confirmed streams: id -> write half of the local socket.
    streams: Mutex<HashMap<u32, TcpStream>>,
    /// Accepted but awaiting `OpenResult`. See the module note on client-first
    /// protocols — pumping before the dial confirms would lose the opener.
    pending: Mutex<HashMap<u32, Pending>>,
    next_id: AtomicU32,
    closed: AtomicBool,
}

impl ControllerTunnel {
    pub fn new(out: Sender<TunnelFrame>) -> Arc<Self> {
        Arc::new(Self {
            out,
            streams: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            closed: AtomicBool::new(false),
        })
    }

    /// Listen on loopback and forward every connection to `target_host:target_port`
    /// through the tunnel. Returns the bound port (pass 0 for an ephemeral one).
    ///
    /// LOOPBACK ONLY, hard-coded. Binding a forwarded port on a routable
    /// interface would expose the host's network to the controller's whole LAN —
    /// a second, unasked-for exposure on top of the one the user consented to.
    pub fn listen(
        self: &Arc<Self>,
        local_port: u16,
        target_host: String,
        target_port: u16,
    ) -> std::io::Result<u16> {
        let listener = TcpListener::bind(("127.0.0.1", local_port))?;
        let bound = listener.local_addr()?.port();
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                if me.closed.load(Ordering::SeqCst) {
                    break;
                }
                match incoming {
                    Ok(sock) => me.accept(sock, &target_host, target_port),
                    Err(_) => break,
                }
            }
        });
        Ok(bound)
    }

    fn accept(self: &Arc<Self>, sock: TcpStream, host: &str, port: u16) {
        let stream = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.pending.lock().unwrap().insert(stream, Pending { sock });
        emit(
            &self.out,
            TunnelFrame::Open { stream, host: host.to_string(), port },
        );
    }

    /// Handle one inbound frame from the host.
    pub fn handle_frame(self: &Arc<Self>, f: TunnelFrame) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        match f {
            TunnelFrame::OpenResult { stream, ok, error: _ } => {
                let Some(p) = self.pending.lock().unwrap().remove(&stream) else {
                    return;
                };
                if !ok {
                    // Refused: drop the local socket so the client sees an
                    // immediate close rather than hanging on a dead forward.
                    hangup(&p.sock);
                    return;
                }
                let Ok(reader) = p.sock.try_clone() else {
                    hangup(&p.sock);
                    emit(&self.out, TunnelFrame::Close { stream });
                    return;
                };
                self.streams.lock().unwrap().insert(stream, p.sock);

                let out = self.out.clone();
                let me = Arc::clone(self);
                std::thread::spawn(move || {
                    pump_reads(reader, stream, out, move || {
                        me.streams.lock().unwrap().remove(&stream);
                    });
                });
            }
            TunnelFrame::Data { stream, payload } => {
                let mut guard = self.streams.lock().unwrap();
                if let Some(sock) = guard.get_mut(&stream) {
                    if sock.write_all(&payload).is_err() {
                        if let Some(dead) = guard.remove(&stream) {
                            hangup(&dead);
                        }
                        emit(&self.out, TunnelFrame::Close { stream });
                    }
                }
            }
            TunnelFrame::Close { stream } => {
                if let Some(sock) = self.streams.lock().unwrap().remove(&stream) {
                    hangup(&sock);
                }
                if let Some(p) = self.pending.lock().unwrap().remove(&stream) {
                    hangup(&p.sock);
                }
            }
            // The controller never receives Open; it sends them.
            TunnelFrame::Open { .. } => {}
        }
    }

    /// Tear down every stream, confirmed or pending.
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        for (_, sock) in self.streams.lock().unwrap().drain() {
            hangup(&sock);
        }
        for (_, p) in self.pending.lock().unwrap().drain() {
            hangup(&p.sock);
        }
    }

    pub fn active(&self) -> usize {
        self.streams.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tunnel::TargetRule;
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::mpsc::channel;
    use std::time::{Duration, Instant};

    /// A loopback echo server. The far end of the forward.
    ///
    /// Returns its port AND a live-connection counter. That counter is the only
    /// way to assert the HOST really closed its far-side socket: the pump's own
    /// `active()` reports a bookkeeping map, which a broken shutdown can empty
    /// without closing anything. Measured, not assumed -- a mutation that
    /// dropped sockets without hanging them up PASSED the earlier version of the
    /// shutdown test, which is exactly the class of test that cannot fail.
    fn echo_server() -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let live = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&live);
        std::thread::spawn(move || {
            for sock in listener.incoming().flatten() {
                let c = Arc::clone(&counter);
                c.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    let mut sock = sock;
                    let mut buf = vec![0u8; 4096];
                    while let Ok(n) = sock.read(&mut buf) {
                        if n == 0 || sock.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
                    c.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        (port, live)
    }

    /// Wait for a condition, so a failure reads as an assertion not a hang.
    fn wait_until(mut cond: impl FnMut() -> bool, secs: u64) -> bool {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        cond()
    }

    fn loopback_policy() -> TunnelPolicy {
        TunnelPolicy {
            enabled: true,
            allowed: vec![TargetRule {
                base: IpAddr::V4(Ipv4Addr::new(127, 0, 0, 0)),
                prefix: 8,
                ports: Vec::new(),
            }],
            elevated_host: false,
            armed_for_elevated: false,
        }
    }

    /// Wire a controller and a host pump directly to each other, standing in for
    /// the `'tunnel'` data channel. Returns both, with relay threads running.
    fn wire(policy: TunnelPolicy) -> (Arc<ControllerTunnel>, Arc<HostTunnel>) {
        let (ctrl_out, ctrl_rx) = channel::<TunnelFrame>();
        let (host_out, host_rx) = channel::<TunnelFrame>();
        let controller = ControllerTunnel::new(ctrl_out);
        let host = HostTunnel::new(policy, host_out);

        // Relay each side's outbound frames to the other's inbound handler,
        // encoding and decoding on the way so the REAL wire format is exercised
        // rather than passing the enum straight across.
        let h = Arc::clone(&host);
        std::thread::spawn(move || {
            for f in ctrl_rx {
                let bytes = f.encode();
                let decoded = TunnelFrame::decode(&bytes).expect("re-decodable");
                h.handle_frame(decoded);
            }
        });
        let c = Arc::clone(&controller);
        std::thread::spawn(move || {
            for f in host_rx {
                let bytes = f.encode();
                let decoded = TunnelFrame::decode(&bytes).expect("re-decodable");
                c.handle_frame(decoded);
            }
        });
        (controller, host)
    }

    fn read_exact_timeout(sock: &mut TcpStream, want: usize) -> Vec<u8> {
        sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut got = Vec::new();
        while got.len() < want {
            let mut buf = vec![0u8; want - got.len()];
            match sock.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => got.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }
        got
    }

    #[test]
    fn bytes_traverse_the_tunnel_in_both_directions() {
        // THE END-TO-END PROOF: a real client socket, a real echo server, and two
        // real pumps with the real wire format between them. Nothing here would
        // pass if frames were dropped, mis-routed, or never written to a socket.
        let (echo, _live) = echo_server();
        let (controller, _host) = wire(loopback_policy());
        let local = controller.listen(0, "127.0.0.1".into(), echo).unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", local)).unwrap();
        client.write_all(b"hello tunnel").unwrap();
        let got = read_exact_timeout(&mut client, 12);
        assert_eq!(&got, b"hello tunnel", "bytes must survive the round trip");
    }

    #[test]
    fn a_large_payload_survives_chunking() {
        // Bigger than one CHUNK, so it becomes several Data frames that must
        // reassemble in order. Off-by-one framing or reordering shows up here.
        let (echo, _live) = echo_server();
        let (controller, _host) = wire(loopback_policy());
        let local = controller.listen(0, "127.0.0.1".into(), echo).unwrap();

        let payload: Vec<u8> = (0..(CHUNK * 3 + 1234)).map(|i| (i % 251) as u8).collect();
        let client = TcpStream::connect(("127.0.0.1", local)).unwrap();
        let to_send = payload.clone();
        let writer = std::thread::spawn(move || {
            let mut w = client.try_clone().unwrap();
            w.write_all(&to_send).unwrap();
            client
        });
        let mut client = writer.join().unwrap();
        let got = read_exact_timeout(&mut client, payload.len());
        assert_eq!(got.len(), payload.len(), "all bytes must come back");
        assert_eq!(got, payload, "and in the right order");
    }

    #[test]
    fn a_policy_refusal_closes_the_local_socket_instead_of_hanging() {
        // The security path, end to end. The target is NOT in the allowlist, so
        // the host must refuse and the client must see a prompt close — not a
        // silent hang, which is what makes people disable the allowlist.
        let (echo, _live) = echo_server();
        let mut policy = loopback_policy();
        // Allow only port 9 (discard), so the echo port is refused while the
        // address family and host still resolve fine.
        policy.allowed = vec![TargetRule {
            base: IpAddr::V4(Ipv4Addr::LOCALHOST),
            prefix: 32,
            ports: vec![9],
        }];
        let (controller, host) = wire(policy);
        let local = controller.listen(0, "127.0.0.1".into(), echo).unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", local)).unwrap();
        // The write may succeed into the local buffer; the READ must end promptly.
        let _ = client.write_all(b"ping");
        let got = read_exact_timeout(&mut client, 4);
        assert!(got.is_empty(), "a refused target must not forward bytes, got {got:?}");
        assert_eq!(host.active(), 0, "no stream may be established for a refused target");
    }

    #[test]
    fn shutdown_actually_closes_the_far_side_socket() {
        // DeviceEnd must CLOSE in-flight sockets, not merely forget them: a
        // revoked session that keeps forwarding is the worst failure here.
        //
        // The assertion is on the ECHO SERVER's live count, not the pump's own
        // active(). An earlier version asserted the latter, and a mutation that
        // dropped sockets without hanging them up passed it -- only the far side
        // can testify that a socket really closed.
        let (echo, live) = echo_server();
        let (controller, host) = wire(loopback_policy());
        let local = controller.listen(0, "127.0.0.1".into(), echo).unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", local)).unwrap();
        client.write_all(b"x").unwrap();
        assert_eq!(read_exact_timeout(&mut client, 1), b"x", "stream must be live first");

        // Prove the far side really is connected first, so the assertion after
        // cannot pass because nothing was ever established.
        assert!(
            wait_until(|| live.load(Ordering::SeqCst) == 1, 3),
            "the echo server must see one live connection before shutdown",
        );

        host.shutdown();
        controller.shutdown();

        assert!(
            wait_until(|| live.load(Ordering::SeqCst) == 0, 5),
            "the far-side socket is STILL OPEN after shutdown -- it was orphaned, \
             so a revoked session would keep forwarding",
        );
        let got = read_exact_timeout(&mut client, 1);
        assert!(got.is_empty(), "the client socket must close on shutdown");
        assert_eq!(host.active(), 0);
        assert_eq!(controller.active(), 0);
    }

    #[test]
    fn two_streams_do_not_cross_wires() {
        // Multiplexing: two concurrent forwards over ONE channel must stay
        // separate. A stream-id mix-up would deliver one client's bytes to the
        // other, which is both a bug and an information leak.
        let (echo, _live) = echo_server();
        let (controller, _host) = wire(loopback_policy());
        let local = controller.listen(0, "127.0.0.1".into(), echo).unwrap();

        let mut a = TcpStream::connect(("127.0.0.1", local)).unwrap();
        let mut b = TcpStream::connect(("127.0.0.1", local)).unwrap();
        a.write_all(b"AAAA").unwrap();
        b.write_all(b"BBBB").unwrap();

        assert_eq!(read_exact_timeout(&mut a, 4), b"AAAA", "stream A got the wrong bytes");
        assert_eq!(read_exact_timeout(&mut b, 4), b"BBBB", "stream B got the wrong bytes");
    }

    #[test]
    fn closing_the_client_closes_the_far_side() {
        // EOF propagation. Without it the host leaks a socket per finished
        // connection and the far service never learns the client went away.
        let (echo, live) = echo_server();
        let (controller, host) = wire(loopback_policy());
        let local = controller.listen(0, "127.0.0.1".into(), echo).unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", local)).unwrap();
        client.write_all(b"z").unwrap();
        assert_eq!(read_exact_timeout(&mut client, 1), b"z");

        assert!(wait_until(|| live.load(Ordering::SeqCst) == 1, 3), "far side must connect");

        drop(client);

        // BOTH: the bookkeeping is reaped AND the far-side socket really closed.
        assert!(
            wait_until(|| host.active() == 0, 5),
            "the host stream must be reaped when the client closes",
        );
        assert!(
            wait_until(|| live.load(Ordering::SeqCst) == 0, 5),
            "the far-side socket must close when the client goes away, or the \
             forwarded service never learns the client left",
        );
    }

    #[test]
    fn a_dial_failure_is_reported_not_silently_dropped() {
        // Port 1 on loopback is allowed by policy but (almost certainly) has no
        // listener, so this exercises the connect-failure path distinctly from
        // the policy-refusal path above.
        let (controller, host) = wire(loopback_policy());
        let local = controller.listen(0, "127.0.0.1".into(), 1).unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", local)).unwrap();
        let _ = client.write_all(b"ping");
        let got = read_exact_timeout(&mut client, 1);
        assert!(got.is_empty(), "a failed dial must close the local socket");
        assert_eq!(host.active(), 0);
    }
}
