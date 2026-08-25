//! The streaming loop: capture -> encode -> WebRTC.

use puca_capture::{CaptureError, ScreenCapture};
use crate::composite::{AnyCapture, VirtualCapture};
use puca_encode::{EncodeError, EncodedFrame};

enum Encoder {
    #[cfg(windows)]
    H264(puca_encode::H264Encoder),
    #[cfg(all(unix, feature = "vp8"))]
    Vp8(puca_encode::Vp8Encoder),
}

impl Encoder {
    fn new(
        w: u32,
        h: u32,
        fps: u32,
        bitrate: u32,
        profile: puca_encode::H264Profile,
    ) -> Result<Self, EncodeError> {
        #[cfg(windows)]
        {
            return puca_encode::H264Encoder::new_with_profile(w, h, fps, bitrate, profile)
                .map(Encoder::H264);
        }
        #[cfg(all(unix, feature = "vp8"))]
        {
            let _ = profile; // VP8 has no profiles in this sense.
            return puca_encode::Vp8Encoder::new(w, h, fps, bitrate).map(Encoder::Vp8);
        }
        #[allow(unreachable_code)]
        {
            let _ = (w, h, fps, bitrate, profile);
            Err(EncodeError::Failed(
                "this build has no video encoder: Windows uses Media Foundation, Linux needs --features vp8 with libvpx <= 1.13.0"
                    .into(),
            ))
        }
    }

    fn encode_bgra(
        &mut self,
        bgra: &[u8],
        stride: usize,
        force_key: bool,
    ) -> Result<EncodedFrame, EncodeError> {
        match self {
            #[cfg(windows)]
            Encoder::H264(e) => e.encode_bgra(bgra, stride, force_key),
            #[cfg(all(unix, feature = "vp8"))]
            Encoder::Vp8(e) => e.encode_bgra(bgra, stride, force_key),
        }
    }

    /// Change rates on the RUNNING encoder. False means "rebuild me" — VP8 has
    /// no live path, and H.264 refuses fps ABOVE what its media types were
    /// negotiated at (pacing below is always safe; see update_rate).
    fn update_rate(&mut self, bitrate: Option<u32>, fps: Option<u32>) -> bool {
        match self {
            #[cfg(windows)]
            Encoder::H264(e) => e.update_rate(bitrate, fps),
            #[cfg(all(unix, feature = "vp8"))]
            Encoder::Vp8(_) => {
                let _ = (bitrate, fps);
                false
            }
        }
    }

    /// The frame size the encoder is negotiated at right now.
    fn dims(&self) -> (u32, u32) {
        match self {
            #[cfg(windows)]
            Encoder::H264(e) => e.dims(),
            #[cfg(all(unix, feature = "vp8"))]
            Encoder::Vp8(e) => e.dims(),
        }
    }

    /// Reconfigure the RUNNING encoder for a new frame size. False means
    /// "rebuild me" — VP8 has no live path, and an H.264 transform may refuse
    /// (the caller then pays the full rebuild, exactly as before).
    fn update_size(&mut self, width: u32, height: u32) -> bool {
        match self {
            #[cfg(windows)]
            Encoder::H264(e) => e.update_size(width, height),
            #[cfg(all(unix, feature = "vp8"))]
            Encoder::Vp8(_) => {
                let _ = (width, height);
                false
            }
        }
    }
}

use puca_rtc::VideoSender;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use str0m::net::{Protocol, Receive};
use str0m::{Input, Output};

// StreamKey moved to session.rs: it is plain data used by code compiled on
// every platform, and this module is #[cfg(windows)]. Call sites here name
// it as crate::session::StreamKey (a re-export was flagged unused — nothing
// references the old path any more).

#[derive(Debug)]
pub enum StreamEvent {
    Terminated {
        session_id: String,
        generation: u64,
        reason: String,
    },
    /// A Windows secure desktop (UAC prompt / lock / sign-in) took the display
    /// away from this session's capture, and this agent could NOT follow it
    /// there — i.e. a `Flavour::User` agent whose `follow_input_desktop()` was
    /// refused. Edge-triggered: `up: true` once when the block begins, `up:
    /// false` once when capture resumes. The app polls `SessionStatus` off the
    /// flag this drives, and uses it to bring up the SYSTEM secure-desktop
    /// bridge. A SYSTEM agent that CAN follow never emits this — it just crosses
    /// over and keeps capturing.
    SecureDesktop {
        session_id: String,
        generation: u64,
        up: bool,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum StreamCommandError {
    GenerationMismatch { expected: u64, actual: u64 },
    Cancelled,
    DeadlineExpired,
    ConstructionFailed(String),
    /// The caller gave up, but the switch had already SUCCEEDED and was
    /// committed — the picture really is on the new monitor.
    ///
    /// A distinct answer because the agent must still do its half of the
    /// switch: move the reservations, record the session's monitor, and re-aim
    /// injected input. Reported as a plain failure, all three were skipped, so
    /// the stream encoded one screen while the agent aimed the pointer at
    /// another — the exact class of bug this release exists to fix.
    CommittedLate,
}

#[allow(dead_code)]
pub enum StreamCommand {
    SetMonitor {
        generation: u64,
        request_id: u64,
        deadline: Instant,
        cancelled: Arc<AtomicBool>,
        monitor: usize,
        reply_tx: std::sync::mpsc::Sender<Result<(), StreamCommandError>>,
    },
    UpdateQuality {
        generation: u64,
        request_id: u64,
        deadline: Instant,
        cancelled: Arc<AtomicBool>,
        fps: Option<u32>,
        bitrate_bps: Option<u32>,
        reply_tx: std::sync::mpsc::Sender<Result<(u32, u32), StreamCommandError>>,
    },
    /// Force the next encoded frame to be an IDR. Fire-and-forget: no
    /// generation, deadline or reply — unlike a monitor switch, running late
    /// or twice is harmless (one redundant I-frame), and the caller's proof
    /// of success is frames decoding again, not an ack.
    RequestKeyframe,
    /// Stop (or resume) blending the host's pointer into captured frames,
    /// because the controller now draws its own. Fire-and-forget for the same
    /// reason as RequestKeyframe — running late costs one frame with the old
    /// cursor state, and running twice is idempotent. The ack the controller
    /// waits on is produced a layer up, once this command has been accepted.
    SetDrawCursor(bool),
}

#[allow(dead_code)]
#[derive(Debug, PartialEq, Eq)]
pub enum ReapError {
    GenerationMismatch { expected: u64, actual: u64 },
    AlreadyReaped,
    Panicked(String),
}

#[allow(dead_code)]
pub struct Stream {
    pub remote_candidates: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
    pub answer_sdp: String,
    pub local_addr: SocketAddr,
    pub generation: u64,
    command_tx: std::sync::mpsc::Sender<StreamCommand>,
    current_fps: Arc<AtomicU32>,
    current_bitrate_bps: Arc<AtomicU32>,
    /// What the peer may reach on disk, or None for "not granted" — the default
    /// and the state every stream starts in. Shared with the stream thread,
    /// which is where the `files` data channel is served.
    ///
    /// An `Option` rather than a `FileScope::None` variant so that revocation is
    /// the same "set it back to None" it has always been.
    file_scope: Arc<Mutex<Option<crate::file_transfer::FileScope>>>,
}

/// Whether this stream carries a picture.
///
/// `DataOnly` exists so files can be browsed without opening the host's screen.
/// It is the same transport — same str0m loop, same data channels, same ICE —
/// with capture never acquired and the encoder never built. That is the whole
/// difference: the `files` channel is served from the socket arm of the loop and
/// has never had anything to do with the picture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamMode {
    Video,
    DataOnly,
}

impl Stream {
    pub fn add_remote_candidate(&self, candidate: String) {
        if let Ok(mut q) = self.remote_candidates.lock() {
            if q.len() < 128 {
                q.push(candidate);
            }
        }
    }

    pub fn switch_monitor_sync(&self, monitor: usize, request_id: u64, timeout: Duration) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + timeout;
        self.command_tx.send(StreamCommand::SetMonitor {
            generation: self.generation,
            request_id,
            deadline,
            cancelled: cancelled.clone(),
            monitor,
            reply_tx: tx,
        }).map_err(|_| "stream dead")?;

        match rx.recv_timeout(timeout) {
            // A late commit is a SUCCESS for the caller's purposes: the picture
            // moved, so the agent must move its reservations, its session
            // record and the input aim with it.
            Ok(Err(StreamCommandError::CommittedLate)) => Ok(()),
            Ok(res) => res.map_err(|e| format!("{e:?}")),
            Err(_) => {
                cancelled.store(true, Ordering::Relaxed);
                // The run loop may still be mid-build. If it commits after
                // this, it replies CommittedLate into a channel nobody is
                // reading — so give the reply a moment to arrive rather than
                // reporting a failure for a switch that succeeded.
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(Err(StreamCommandError::CommittedLate)) | Ok(Ok(())) => Ok(()),
                    _ => Err("timeout".to_string()),
                }
            }
        }
    }

    pub fn update_quality_sync(&self, fps: Option<u32>, bitrate_bps: Option<u32>, request_id: u64, timeout: Duration) -> Result<(u32, u32), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + timeout;
        self.command_tx.send(StreamCommand::UpdateQuality {
            generation: self.generation,
            request_id,
            deadline,
            cancelled: cancelled.clone(),
            fps,
            bitrate_bps,
            reply_tx: tx,
        }).map_err(|_| "stream dead")?;

        match rx.recv_timeout(timeout) {
            Ok(res) => {
                if let Ok((f, b)) = res {
                    self.current_fps.store(f, Ordering::Relaxed);
                    self.current_bitrate_bps.store(b, Ordering::Relaxed);
                    Ok((f, b))
                } else {
                    res.map_err(|e| format!("{e:?}"))
                }
            }
            Err(_) => {
                cancelled.store(true, Ordering::Relaxed);
                Err("timeout".to_string())
            }
        }
    }

    /// Ask the encoder for an IDR on the next frame. Fire-and-forget by
    /// design (see StreamCommand::RequestKeyframe): success is the peer's
    /// decoder recovering, not an ack, and a request landing after the
    /// stream died has nothing useful to report anyway.
    pub fn request_keyframe(&self) {
        let _ = self.command_tx.send(StreamCommand::RequestKeyframe);
    }

    /// Hand the cursor to the controller (or take it back).
    ///
    /// Fire-and-forget like request_keyframe: the command cannot fail in a way
    /// the caller could act on, and the controller's ack is issued once this
    /// has been accepted rather than once pixels change.
    pub fn set_draw_cursor(&self, on: bool) {
        let _ = self.command_tx.send(StreamCommand::SetDrawCursor(on));
    }

    /// Grant the peer a folder to browse, grant the unattended policy scope, or
    /// revoke with None.
    ///
    /// A granted folder is canonicalised HERE, once, so the jail in
    /// file_transfer compares against a resolved path — a root reached through a
    /// symlink would otherwise never match the paths derived from it.
    ///
    /// `Policy` takes no path: it means "fixed drives minus the system and
    /// secret-bearing locations", and the list is resolved inside file_transfer
    /// rather than being handed over the wire. That is deliberate — a scope the
    /// caller could describe path-by-path would be a scope the caller could
    /// widen, and the app is the only thing between this and a remote peer.
    pub fn set_file_scope(
        &self,
        scope: Option<crate::file_transfer::FileScope>,
    ) -> Result<(), String> {
        let resolved = match scope {
            None => None,
            Some(crate::file_transfer::FileScope::Policy) => {
                Some(crate::file_transfer::FileScope::Policy)
            }
            Some(crate::file_transfer::FileScope::Jailed(r)) => {
                let c = r
                    .canonicalize()
                    .map_err(|e| format!("cannot grant access to {}: {e}", r.display()))?;
                if !c.is_dir() {
                    return Err(format!("{} is not a folder", r.display()));
                }
                Some(crate::file_transfer::FileScope::Jailed(c))
            }
        };
        *self
            .file_scope
            .lock()
            .map_err(|_| "file access lock poisoned".to_string())? = resolved;
        Ok(())
    }

    pub fn query_quality(&self) -> (u32, u32) {
        (self.current_fps.load(Ordering::Relaxed), self.current_bitrate_bps.load(Ordering::Relaxed))
    }

    pub fn reap_terminated(&mut self, expected_generation: u64) -> Result<(), ReapError> {
        if self.generation != expected_generation {
            return Err(ReapError::GenerationMismatch { expected: expected_generation, actual: self.generation });
        }
        let handle = self.handle.take().ok_or(ReapError::AlreadyReaped)?;
        match handle.join() {
            Ok(()) => Ok(()),
            Err(panic_payload) => {
                let msg = if let Some(s) = panic_payload.downcast_ref::<&str>() { s.to_string() }
                else if let Some(s) = panic_payload.downcast_ref::<String>() { s.clone() }
                else { "unknown panic payload".to_string() };
                eprintln!("[stream] thread panicked: {msg}");
                Err(ReapError::Panicked(msg))
            }
        }
    }

    pub fn stop_and_join(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.reap_terminated(self.generation);
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.handle.take().map(|h| h.join());
    }
}

/// Ceiling on queued file replies awaiting channel budget. With 16 KiB chunks
/// each framed reply is ~22 KB, so this bounds the queue near 5–6 MB. The
/// serialised client keeps at most a couple in flight; hitting this means the
/// peer stopped ACKing entirely, and the drop is LOGGED, never silent.
const MAX_PENDING_FS_REPLIES: usize = 256;

/// One file reply as wire bytes, with the request's `id` echoed onto it when
/// the request carried one. Through `serde_json::Value` because `FsResponse`
/// does not model ids — they belong to the transport matching, not to the
/// filesystem answer — and an id-less request (an older app) must get an
/// id-less reply, matched by order exactly as before ids existed.
fn encode_fs_reply(resp: &crate::file_transfer::FsResponse, req_id: Option<u64>) -> Option<Vec<u8>> {
    let mut v = serde_json::to_value(resp).ok()?;
    if let (Some(id), Some(obj)) = (req_id, v.as_object_mut()) {
        obj.insert("id".to_string(), serde_json::Value::from(id));
    }
    serde_json::to_vec(&v).ok()
}

/// The file-request worker: answers `FsRequest`s OFF the stream thread.
///
/// A directory listing is `read_dir` plus a stat per entry plus one big JSON
/// serialisation, and it used to run INLINE in the stream loop — a large
/// folder froze video, ICE and every command for as long as that took ("it
/// takes very long to load" while the picture stands still). One worker,
/// FIFO in and FIFO out, so the id-less order contract holds by
/// construction; completions are `None` when a reply could not even be
/// encoded, so the loop's in-flight accounting never drifts.
///
/// The scope is re-read PER REQUEST in here, exactly as the inline code did —
/// that is what keeps revocation instant: a `Write` dequeued before the
/// revocation still completes (same as before), the next request refuses.
fn run_fs_worker<C: Copy + Send + 'static>(
    rx: std::sync::mpsc::Receiver<(C, crate::file_transfer::FsRequest, Option<u64>)>,
    file_scope: Arc<Mutex<Option<crate::file_transfer::FileScope>>>,
    audit: Option<crate::file_log::FileAudit>,
    tx: std::sync::mpsc::Sender<(C, Option<Vec<u8>>)>,
) {
    while let Ok((cid, req, req_id)) = rx.recv() {
        let granted = file_scope.lock().ok().and_then(|g| g.clone());
        let resp = match granted {
            Some(scope) => crate::file_transfer::handle_request(req, &scope, audit.as_ref()),
            None => crate::file_transfer::FsResponse::error(
                "file access has not been allowed on that computer",
            ),
        };
        if tx.send((cid, encode_fs_reply(&resp, req_id))).is_err() {
            return; // the stream loop is gone; so is anyone to answer
        }
    }
}

/// The gate every stream command passes before any work happens. Order
/// matters: a command from a stale generation is refused first, so it can
/// never be mistaken for one that was merely cancelled or late; then caller
/// cancellation; then the deadline. The run loop and the tests call this
/// exact function.
fn command_gate(
    expected_generation: u64,
    gen: u64,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<(), StreamCommandError> {
    if gen != expected_generation {
        return Err(StreamCommandError::GenerationMismatch { expected: expected_generation, actual: gen });
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err(StreamCommandError::Cancelled);
    }
    if Instant::now() > deadline {
        return Err(StreamCommandError::DeadlineExpired);
    }
    Ok(())
}

/// The outcome of a SetMonitor transition: either the new capture to commit,
/// or the ORIGINAL capture handed back untouched.
///
/// Nothing here may ever drop a capture on the floor. The old shape returned
/// `Option<C>` and dropped the built capture when a late cancellation lost the
/// re-check — safe while every build opened a FRESH duplication, and fatal now
/// that a build can ADOPT the live one: dropping it would release the
/// duplication of the screen currently being streamed and kill the session
/// this path exists to protect.
pub(crate) enum Transition<C> {
    /// Install this capture. `replied` is true when a refusal has ALREADY been
    /// sent (a caller that gave up mid-build) — the committer must not then
    /// also send Ok, or the channel carries two answers to one request.
    Commit { capture: C, replied: bool },
    /// Nothing changed; this is the capture that was already streaming.
    Keep(C),
}

/// The SetMonitor arm minus the hardware: gate the command, build the
/// replacement capture via `build`, then re-check cancellation and deadline
/// before handing the capture back for commit. `build` RECEIVES the current
/// capture and must return it inside its `Err` if it cannot use it — that is
/// what preserves "a switch that fails leaves the current screen streaming".
/// Sends every refusal on `reply_tx` itself; the caller sends Ok(()) only
/// after it has actually committed the switch, so success is never
/// acknowledged before it is true.
fn set_monitor_transition<C>(
    expected_generation: u64,
    gen: u64,
    cancelled: &AtomicBool,
    deadline: Instant,
    target_monitor: usize,
    reply_tx: &std::sync::mpsc::Sender<Result<(), StreamCommandError>>,
    current: C,
    build: impl FnOnce(usize, C) -> Result<C, (C, String)>,
) -> Transition<C> {
    if let Err(e) = command_gate(expected_generation, gen, cancelled, deadline) {
        let _ = reply_tx.send(Err(e));
        return Transition::Keep(current);
    }
    let built = build(target_monitor, current);
    match built {
        Err((restored, e)) => {
            // The build could not use the capture and gave it back. Whether the
            // caller also gave up is irrelevant — this is a refusal either way,
            // and the original keeps streaming.
            let _ = reply_tx.send(Err(StreamCommandError::ConstructionFailed(format!(
                "cannot switch to monitor {target_monitor}: {e}"
            ))));
            Transition::Keep(restored)
        }
        Ok(next) => {
            // A SUCCESSFUL build is COMMITTED even if the caller has since
            // given up, and this is a deliberate change from the original
            // "drop the provisional capture" behaviour.
            //
            // That behaviour was correct while every build opened a FRESH
            // duplication alongside the live one: dropping it released the
            // spare and left the old screen streaming. It is impossible now.
            // `build` CONSUMES the current capture — All Displays adopts it
            // rather than opening a second duplication of a screen DXGI only
            // allows one of — so on a late cancellation there is no old
            // capture left to go back to. Dropping what we hold would leave
            // the stream with no capture at all; keeping it while pretending
            // `current_monitor` is unchanged would make the loop encode one
            // screen while believing it is showing another.
            //
            // So the state stays consistent and the caller is still told the
            // truth about its own request: it timed out. It has already
            // returned that to the controller, which will show the switch as
            // failed until the next one. Reaching here at all requires a
            // capture build slower than the caller's 2s deadline.
            let replied = if cancelled.load(Ordering::Relaxed) || Instant::now() > deadline {
                // CommittedLate, not Cancelled: the difference is that this
                // switch HAPPENED, and the caller has bookkeeping to finish.
                let _ = reply_tx.send(Err(StreamCommandError::CommittedLate));
                true
            } else {
                false
            };
            Transition::Commit { capture: next, replied }
        }
    }
}

/// The UpdateQuality arm's decision: gate, then mutate only the requested
/// fields. State is touched only when the gate passes — the property the
/// tests pin down.
#[allow(clippy::too_many_arguments)]
fn apply_quality_update(
    expected_generation: u64,
    gen: u64,
    cancelled: &AtomicBool,
    deadline: Instant,
    want_fps: Option<u32>,
    want_bitrate: Option<u32>,
    current_fps: &mut u32,
    current_bitrate: &mut u32,
) -> Result<(u32, u32), StreamCommandError> {
    command_gate(expected_generation, gen, cancelled, deadline)?;
    if let Some(f) = want_fps {
        *current_fps = f;
    }
    if let Some(b) = want_bitrate {
        *current_bitrate = b;
    }
    Ok((*current_fps, *current_bitrate))
}

#[allow(clippy::too_many_arguments)]
pub fn start(
    offer_sdp: &str,
    monitor: usize,
    fps: u32,
    bitrate: u32,
    mode: StreamMode,
    ice_servers: &[crate::protocol::IceServer],
    stream_events_tx: std::sync::mpsc::Sender<StreamEvent>,
    session_id: String,
    generation: u64,
    // R4: the sealed session's key + grant, when the caller has one. Some =
    // this stream may serve the direct `input` channel; None = it cannot
    // (an attended session, whose key lives in the APP — the agent is
    // deliberately not a second client) and input keeps its existing path.
    input_channel: Option<std::sync::Arc<crate::input_wire::InputChannel>>,
) -> Result<Stream, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("could not bind a socket: {e}"))?;
    let local_addr = socket
        .local_addr()
        .map_err(|e| format!("could not read the local address: {e}"))?;

    let mut sender = VideoSender::new();
    let mut count = 0;
    let interfaces = local_interfaces(local_addr.port());
    for addr in &interfaces {
        if sender.add_local_candidate(*addr).is_ok() {
            count += 1;
        }
    }
    if count == 0 {
        return Err("no usable local network interface to advertise".to_string());
    }

    let base = interfaces
        .iter()
        .find(|a| !a.ip().is_loopback())
        .copied()
        .unwrap_or(local_addr);
    let gathered = crate::ice::gather(&socket, ice_servers, base, Duration::from_millis(1_500));
    let mut srflx_count = 0;
    for (mapped, base) in &gathered.srflx {
        match sender.add_server_reflexive_candidate(*mapped, *base) {
            Ok(()) => srflx_count += 1,
            Err(e) => eprintln!("[stream] reflexive candidate {mapped} refused: {e}"),
        }
    }
    let ice_summary = gathered.describe();
    let mut relay = gathered.relay;
    let mut relayed_addr = None;
    if let Some(alloc) = &relay {
        match sender.add_relayed_candidate(alloc.relayed, base) {
            Ok(()) => relayed_addr = Some(alloc.relayed),
            Err(e) => eprintln!("[stream] relay candidate {} refused: {e}", alloc.relayed),
        }
    }

    if let (Some(alloc), true) = (relay.as_mut(), relayed_addr.is_some()) {
        for peer in remote_candidate_addrs(offer_sdp) {
            if let Err(e) = alloc.create_permission(&socket, peer) {
                eprintln!("[stream] permission for {peer}: {e}");
            }
        }
    }

    eprintln!(
        "[stream] ice: {count} host, {srflx_count} reflexive - {}",
        ice_summary
    );

    let answer_sdp = sender
        .accept_offer(offer_sdp)
        .map_err(|e| format!("could not answer the offer: {e}"))?;

    let remote_candidates: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let remote_thread = Arc::clone(&remote_candidates);

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);

    let (command_tx, command_rx) = std::sync::mpsc::channel();

    socket
        .set_read_timeout(Some(Duration::from_millis(20)))
        .map_err(|e| format!("could not set a socket timeout: {e}"))?;

    let advertised = interfaces;
    let session_id_clone = session_id.clone();
    let stream_events_tx_clone = stream_events_tx.clone();
    // A SECOND pair, for run() to emit mid-session SecureDesktop events. The
    // clones above are moved into the TerminatedGuard (which only fires on Drop);
    // run() needs its own handle to signal while it is still going.
    let session_id_run = session_id.clone();
    let stream_events_run = stream_events_tx.clone();

    let current_fps = Arc::new(AtomicU32::new(fps));
    let current_bitrate_bps = Arc::new(AtomicU32::new(bitrate));

    // Starts ungranted. The stream thread refuses every file request until the
    // app sets a scope — which it does either after a local human approves a
    // folder, or (Policy) after an armed host's controller proved the
    // unattended passphrase.
    let file_scope: Arc<Mutex<Option<crate::file_transfer::FileScope>>> =
        Arc::new(Mutex::new(None));
    let file_scope_thread = Arc::clone(&file_scope);

    // The audit trail replaces the consent dialog as the local evidence that
    // files were touched, so a stream that cannot open its log still runs —
    // None just means no trail, which is what every stream had before this.
    let audit = crate::file_log::agent_data_dir()
        .map(|dir| crate::file_log::FileAudit::new(dir, session_id.clone()));

    let handle = std::thread::Builder::new()
        .name(format!("sovereign-stream-{monitor}"))
        .spawn(move || {
            // The guard's Drop is what reports Terminated, so the REASON has
            // to travel through shared state: a run() that returns Err has
            // already lost its chance to tell the guard anything by value.
            // "exited" is what a clean stop still says; an error names itself
            // in the agent log's reap line, which is the only place a dead
            // TURN relay or a 20s ICE loss ever becomes legible post-hoc.
            let reason_cell = Arc::new(Mutex::new(String::from("exited")));
            let _guard = TerminatedGuard {
                session_id: session_id_clone,
                generation,
                stream_events_tx: stream_events_tx_clone,
                reason: Arc::clone(&reason_cell),
            };
            if let Err(e) = run(sender, socket, advertised, relay, relayed_addr, remote_thread, monitor, fps, bitrate, mode, stop_thread, command_rx, generation, file_scope_thread, audit, stream_events_run, session_id_run, input_channel) {
                eprintln!("[stream] ended: {e}");
                if let Ok(mut r) = reason_cell.lock() {
                    *r = e;
                }
            }
            puca_input::release_all();
        })
        .map_err(|e| format!("could not start the stream thread: {e}"))?;

    Ok(Stream {
        remote_candidates,
        stop,
        handle: Some(handle),
        answer_sdp,
        local_addr,
        generation,
        command_tx,
        current_fps,
        current_bitrate_bps,
        file_scope,
    })
}

struct TerminatedGuard {
    session_id: String,
    generation: u64,
    stream_events_tx: std::sync::mpsc::Sender<StreamEvent>,
    /// Written by the thread body when run() errors; "exited" otherwise.
    reason: Arc<Mutex<String>>,
}

impl Drop for TerminatedGuard {
    fn drop(&mut self) {
        let reason = self
            .reason
            .lock()
            .map(|r| r.clone())
            .unwrap_or_else(|_| "exited".to_string());
        let _ = self.stream_events_tx.send(StreamEvent::Terminated {
            session_id: self.session_id.clone(),
            generation: self.generation,
            reason,
        });
    }
}

fn local_interfaces(port: u16) -> Vec<SocketAddr> {
    let mut out = Vec::new();
    if let Ok(probe) = UdpSocket::bind("0.0.0.0:0") {
        if probe.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = probe.local_addr() {
                out.push(SocketAddr::new(addr.ip(), port));
            }
        }
    }
    out.push(SocketAddr::from(([127, 0, 0, 1], port)));
    out
}

fn remote_candidate_addrs(offer_sdp: &str) -> Vec<SocketAddr> {
    let mut out: Vec<SocketAddr> = Vec::new();
    for line in offer_sdp.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("a=candidate:").or_else(|| line.strip_prefix("candidate:")) else {
            continue;
        };
        let f: Vec<&str> = rest.split_whitespace().collect();
        if f.len() < 6 {
            continue;
        }
        let Ok(ip) = f[4].parse::<std::net::IpAddr>() else { continue };
        let Ok(port) = f[5].parse::<u16>() else { continue };
        if ip.is_unspecified() || port == 0 {
            continue;
        }
        let addr = SocketAddr::new(ip, port);
        if !out.contains(&addr) {
            out.push(addr);
        }
    }
    out
}

fn candidate_addr(line: &str) -> Option<SocketAddr> {
    let rest = line.trim().strip_prefix("candidate:").unwrap_or(line.trim());
    let f: Vec<&str> = rest.split_whitespace().collect();
    if f.len() < 6 {
        return None;
    }
    let ip = f[4].parse::<std::net::IpAddr>().ok()?;
    let port = f[5].parse::<u16>().ok()?;
    if ip.is_unspecified() || port == 0 {
        return None;
    }
    Some(SocketAddr::new(ip, port))
}

fn destination_for(source: SocketAddr, advertised: &[SocketAddr]) -> SocketAddr {
    let want_loopback = source.ip().is_loopback();
    advertised
        .iter()
        .find(|a| a.ip().is_loopback() == want_loopback)
        .copied()
        .or_else(|| advertised.first().copied())
        .unwrap_or(source)
}

/// Raises this thread's scheduling odds and the system timer resolution for
/// the life of one stream, and puts BOTH back on drop.
///
/// Why it matters here: the run loop paces frames with socket read timeouts,
/// and both inherit the system timer's granularity — ~15.6ms by default,
/// which is HALF A FRAME at 30fps of pure scheduling slop. The encode crate
/// already documents the same hazard for its own waits (it yields instead of
/// sleeping); this closes it for the loop itself. Above-normal priority, not
/// time-critical: this thread shares the machine with the very apps being
/// streamed, and starving them is its own latency.
#[cfg(windows)]
struct StreamTimingGuard;

#[cfg(windows)]
impl StreamTimingGuard {
    fn acquire() -> Self {
        unsafe {
            let _ = windows::Win32::Media::timeBeginPeriod(1);
            let _ = windows::Win32::System::Threading::SetThreadPriority(
                windows::Win32::System::Threading::GetCurrentThread(),
                windows::Win32::System::Threading::THREAD_PRIORITY_ABOVE_NORMAL,
            );
        }
        Self
    }
}

#[cfg(windows)]
impl Drop for StreamTimingGuard {
    fn drop(&mut self) {
        // Balance timeBeginPeriod — the resolution request is refcounted
        // machine-wide, and leaking one keeps every core ticking at 1ms.
        unsafe {
            let _ = windows::Win32::Media::timeEndPeriod(1);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run(
    mut sender: VideoSender,
    socket: UdpSocket,
    advertised: Vec<SocketAddr>,
    mut relay: Option<crate::turn::Allocation>,
    relayed_addr: Option<SocketAddr>,
    remote_candidates: Arc<Mutex<Vec<String>>>,
    initial_monitor: usize,
    initial_fps: u32,
    initial_bitrate: u32,
    mode: StreamMode,
    stop: Arc<AtomicBool>,
    command_rx: std::sync::mpsc::Receiver<StreamCommand>,
    generation: u64,
    file_scope: Arc<Mutex<Option<crate::file_transfer::FileScope>>>,
    audit: Option<crate::file_log::FileAudit>,
    events_tx: std::sync::mpsc::Sender<StreamEvent>,
    session_id: String,
    // R4: Some = this stream may serve the direct input channel (see start()).
    input_channel: Option<std::sync::Arc<crate::input_wire::InputChannel>>,
) -> Result<(), String> {
    // VIDEO ONLY. The justification — frame pacing rides socket read timeouts,
    // which tick at the ~15.6ms default — does not apply to a DataOnly session:
    // it never acquires a capture, never pumps a frame, and its wait is not
    // folded against a frame deadline. Raising the machine-wide timer
    // resolution (and this thread's priority) to browse files would be a real
    // power cost on a laptop for no latency any user can perceive.
    #[cfg(windows)]
    let _timing = match mode {
        StreamMode::Video => Some(StreamTimingGuard::acquire()),
        StreamMode::DataOnly => None,
    };

    // Which channel id is the `files` channel. Learned from ChannelOpen, so a
    // request arriving on the tunnel channel (or any channel the peer opens
    // itself) is never fed to the filesystem handler.
    let mut files_channel: Option<str0m::channel::ChannelId> = None;
    // The caret channel, learned the same way and for the same reason: bytes on
    // it must never reach the filesystem handler, and file bytes must never
    // start a sampler.
    let mut caret_channel: Option<str0m::channel::ChannelId> = None;
    // R4: the controller's direct input channel, learned from ChannelOpen.
    let mut input_channel_id: Option<str0m::channel::ChannelId> = None;
    // `Some` = a viewer has asked for caret reports. Dropping the tracker
    // releases this session's claim on the process-wide sampler; it is a local
    // in `run()`, so a returning stream releases it with no teardown step.
    let mut caret_tracker: Option<puca_input::caret::CaretTracker> = None;
    let mut caret_surface: Option<crate::session::CaptureSurface> = None;
    // The last report SCTP actually accepted — never the last one computed. See
    // the `Ok(false)` arm in the drain below.
    let mut caret_last_sent: Option<crate::caret_wire::CaretReport> = None;
    let mut caret_seq: u64 = 0;
    let mut caret_surf: u64 = 0;
    let mut caret_geometry_checked: Option<Instant> = None;
    let mut caret_refusal_logged = false;
    let mut caret_budget_logged = false;
    let mut current_monitor = initial_monitor;
    let mut current_fps = initial_fps;
    let mut current_bitrate = initial_bitrate;
    // Displays wake before the capture opens and stay awake for the session.
    // A panel in DPMS-off presents nothing to DXGI — creation "succeeds" and
    // then no frame ever arrives (the black-stage-forever field report), and
    // on some topologies the output detaches and creation fails outright.
    // The hold is per-thread RAII: released when this thread exits, which IS
    // session end. DataOnly sessions skip both — a file browse should not
    // light anyone's screen.
    #[cfg(windows)]
    let _awake = match mode {
        StreamMode::Video => {
            crate::display_wake::nudge();
            Some(crate::display_wake::DisplayAwake::acquire())
        }
        StreamMode::DataOnly => None,
    };

    // Option, so the SetMonitor arm can MOVE the live capture into the build
    // that adopts it. There is always exactly one capture in here between
    // commands; `take()` is only ever paired with an immediate put-back.
    // DataOnly never acquires the duplication at all. That is what makes a
    // file-only session cheap and invisible to the picture: no reservation on
    // the monitor, no encoder, no frames. Every other use of `capture` below is
    // guarded on it being present rather than assuming it.
    let mut capture: Option<AnyCapture> = match mode {
        StreamMode::DataOnly => None,
        StreamMode::Video => Some({
            // Bounded retry: a display that was just nudged awake can take a
            // few seconds to re-attach its output, and the old single-shot
            // `?` killed the whole session on the first attempt — silently,
            // since a spawned thread has no reply channel. Re-nudge once
            // mid-window; give up with a message that names the real cause.
            let retry_start = Instant::now();
            let deadline = retry_start + Duration::from_secs(8);
            let mut renudged = false;
            loop {
                // StopStream joins this thread, so the retry MUST honour the
                // stop flag — without this check a cancel during the wake
                // window parked the entire agent pipe (and every other
                // session's commands) behind an 8s sleep loop.
                if stop.load(Ordering::Relaxed) {
                    return Ok(());
                }
                let attempt = if current_monitor == crate::composite::ALL_DISPLAYS {
                    VirtualCapture::new().map(AnyCapture::Virtual)
                } else {
                    ScreenCapture::new(current_monitor).map(AnyCapture::Single)
                };
                match attempt {
                    Ok(c) => break c,
                    Err(e) => {
                        // A session can START against the credential UI (a
                        // controller connecting straight to a machine already
                        // showing its PIN box): creation then fails AccessLost
                        // until this thread attaches to the secure desktop.
                        // The pump loop's follow can never help here — it only
                        // runs once a capture exists. Same call, same cheap
                        // failure for a user-flavour agent, bounded by this
                        // loop's own 8s deadline and 250ms cadence.
                        if matches!(e, CaptureError::AccessLost) {
                            match puca_input::desktop::follow_input_desktop() {
                                Ok(name) => eprintln!(
                                    "[stream] capture open blocked; followed the input desktop to '{name}'"
                                ),
                                Err(err) => eprintln!("[stream] capture open blocked and {err}"),
                            }
                        }
                        if Instant::now() >= deadline {
                            // TWO CAUSES, TWO ANSWERS. This blamed sleeping
                            // monitors for everything, including the case that
                            // is not about monitors at all: `AccessLost` here
                            // is DuplicateOutput returning E_ACCESSDENIED
                            // because a secure desktop owns the display — the
                            // lock screen, the sign-in screen, or a UAC prompt.
                            // display_wake::nudge() cannot help with that, and
                            // telling someone their screens did not wake sends
                            // them to check a monitor while the machine sits
                            // there perfectly awake showing a password box.
                            let hint = match e {
                                CaptureError::AccessLost =>
                                    "that computer is showing a Windows security screen \
                                     (the lock screen, the sign-in screen, or an administrator \
                                     prompt), which Puca cannot capture yet",
                                _ => "the screens on that computer may be asleep and did not wake",
                            };
                            return Err(format!("capture: {e} ({hint})"));
                        }
                        if !renudged && retry_start.elapsed() >= Duration::from_secs(2) {
                            renudged = true;
                            #[cfg(windows)]
                            crate::display_wake::nudge();
                        }
                        std::thread::sleep(Duration::from_millis(250));
                    }
                }
            }
        }),
    };
    let mut encoder: Option<Encoder> = None;
    let mut buf = vec![0u8; 65535];

    let mut frame_interval = Duration::from_secs_f64(1.0 / current_fps.max(1) as f64);
    let mut next_frame = Instant::now();
    let mut want_keyframe = true;
    let mut rx_count: u64 = 0;
    let mut tx_count: u64 = 0;
    let mut frames_sent: u64 = 0;
    let mut skipped: u64 = 0;
    // When a secure desktop first took the display, and whether we have already
    // said so. Reset the moment a real frame arrives, so a second prompt later
    // in the same session is reported again rather than swallowed by a latch
    // that only ever burns once.
    let mut blocked_since: Option<Instant> = None;
    let mut blocked_reported = false;
    // Whether we have told the app (via a StreamEvent::SecureDesktop) that a
    // secure desktop is blocking THIS blockage run and we cannot follow it.
    // Edge-triggered: raised once when a follow is refused, lowered once when a
    // real frame arrives. A SYSTEM agent that follows successfully never sets it.
    let mut secure_desktop_signaled = false;
    // The desktop-follow and rebuild clocks for the CURRENT blockage run.
    // Both reset when a real frame arrives, like `blocked_since`.
    //
    // The follow used to run ONCE per blockage (`if blocked_since.is_none()`),
    // and that one shot is exactly wrong at the moment it matters most: the
    // lock-curtain → credential-UI transition. The curtain lives on the
    // Default desktop (capture works unattached), pressing Enter switches the
    // input desktop to Winlogon, capture dies with AccessLost — and the single
    // follow fires DURING the switch, when OpenInputDesktop can still answer
    // with the outgoing desktop. Latched, wrong, and never retried: the
    // controller held the last curtain frame while the PIN box sat invisible
    // until the user reconnected by hand (field report, 2026-08-17). A retry
    // two seconds later lands on the settled input desktop every time. Third
    // appearance of this repo's one-shot-latch trap.
    let mut last_follow: Option<Instant> = None;
    let mut last_rebuild: Option<Instant> = None;
    // One extra wake attempt while waiting for the FIRST frame — see the
    // NoChange arm. Separate from the open-retry's nudge: creation can
    // succeed against a sleeping panel and starve afterwards.
    let mut cold_start_renudged = false;
    let mut pump_stats = PumpStats::default();
    let started_at = Instant::now();
    // The last picture captured from a single screen, kept so a still desktop
    // can still feed a freshly rebuilt encoder.
    let mut last_frame: Option<puca_capture::Frame> = None;
    // When str0m's ICE went Disconnected and has not come back. Until
    // 2026-08-13 that event was LOGGED AND IGNORED: str0m never clears its
    // nominated address and `is_alive()` is never set false by ICE failure,
    // so a session whose viewer changed networks kept capturing and encoding
    // into a void forever — the host half of the field-reported "still image
    // with working mouse". Bounded now: see ICE_DEAD_AFTER at the loop tail.
    let mut ice_down_since: Option<Instant> = None;
    // The death clock only ever ARMS after ICE has succeeded once: the `is`
    // crate declares Disconnected straight out of Checking when the first
    // candidate batch exhausts ("no possible pairs"), which is a normal stop
    // on the way to a relay candidate that has not trickled in yet — the
    // cold-start deadlines (the controller's 30s media clock, the server's
    // pending TTL) own that phase.
    let mut ice_ever_connected = false;
    // The last time a Transmit actually left via the TURN relay — what makes
    // a dead allocation FATAL rather than merely logged. A session nominated
    // onto a direct pair does not die with a relay it stopped using.
    let mut last_relay_tx: Option<Instant> = None;
    // Whether the HOST draws its own pointer into the frames. True until a
    // controller takes ownership; survives capture rebuilds (monitor
    // switches) so ownership cannot be silently revoked by a picker click.
    let mut draw_host_cursor = true;
    // File replies the channel refused for want of send budget, retried each
    // pass. FIFO — order is the matching rule for id-less clients.
    let mut pending_fs_replies: std::collections::VecDeque<(str0m::channel::ChannelId, Vec<u8>)> =
        std::collections::VecDeque::new();

    // File requests answered OFF this thread — see run_fs_worker. `audit`
    // moves in with the worker; the Fs arm below was its only user.
    let (fs_req_tx, fs_req_rx) = std::sync::mpsc::channel::<(
        str0m::channel::ChannelId,
        crate::file_transfer::FsRequest,
        Option<u64>,
    )>();
    let (fs_done_tx, fs_done_rx) =
        std::sync::mpsc::channel::<(str0m::channel::ChannelId, Option<Vec<u8>>)>();
    let mut fs_inflight: usize = 0;

    // When a monitor switch was committed, for the [switch] first-frame log —
    // the number that says whether the encoder-reuse path actually shortened
    // the freeze in the field.
    let mut switch_started: Option<Instant> = None;
    {
        let scope_for_worker = Arc::clone(&file_scope);
        if let Err(e) = std::thread::Builder::new()
            .name("fs-worker".into())
            .spawn(move || run_fs_worker(fs_req_rx, scope_for_worker, audit, fs_done_tx))
        {
            // The session goes on without file transfer; every file request
            // gets an explicit refusal below (the send fails), and THIS line
            // is the only place the cause is ever recorded.
            eprintln!("[stream] could not start the fs worker: {e}");
        }
    }

    while !stop.load(Ordering::Relaxed) {
        // Harvest finished file replies into the FIFO the flush below owns.
        // A `None` body could not be encoded; it still retires its in-flight
        // slot so the accounting never drifts.
        while let Ok((cid, bytes)) = fs_done_rx.try_recv() {
            fs_inflight = fs_inflight.saturating_sub(1);
            if let Some(bytes) = bytes {
                if pending_fs_replies.len() >= MAX_PENDING_FS_REPLIES {
                    eprintln!(
                        "[stream] fs reply queue full ({MAX_PENDING_FS_REPLIES}); dropping a reply"
                    );
                } else {
                    pending_fs_replies.push_back((cid, bytes));
                }
            }
        }
        // Flush queued file replies BEFORE the poll_output drain, so anything
        // accepted here is packetised and transmitted in the same pass. The
        // budget these were refused against frees on the peer's SACK, and a
        // SACK arriving is a socket wake — so the retry cadence is the loop's
        // own, with no timer needed.
        while let Some((cid, bytes)) = pending_fs_replies.front() {
            let Some(mut c) = sender.rtc_mut().channel(*cid) else {
                // The channel is gone; there is nobody to deliver to.
                pending_fs_replies.pop_front();
                continue;
            };
            match c.write(false, bytes) {
                Ok(true) => {
                    pending_fs_replies.pop_front();
                }
                Ok(false) => break, // still no room; next pass
                Err(e) => {
                    eprintln!("[stream] fs reply failed: {e}");
                    pending_fs_replies.pop_front();
                }
            }
        }
        while let Ok(cmd) = command_rx.try_recv() {
            match cmd {
                StreamCommand::SetMonitor { generation: gen, request_id: _, deadline, cancelled, monitor: target_monitor, reply_tx } => {
                    // A file-only session has no picture, so there is no screen
                    // to move. Refuse before the take() below, which would
                    // otherwise panic the stream thread on its `expect`.
                    if capture.is_none() {
                        let _ = reply_tx.send(Err(StreamCommandError::ConstructionFailed(
                            "this session has no screen to switch".to_string(),
                        )));
                        continue;
                    }
                    // Already there: succeed without touching the capture.
                    //
                    // The new capture is deliberately built BEFORE the old one
                    // is dropped, so a switch that fails leaves the current
                    // screen streaming rather than killing the session. But
                    // DXGI duplication is exclusive per output, so asking for
                    // the monitor we are ALREADY on made that build collide
                    // with our own live capture and fail every time — picking
                    // the current screen in the monitor list reported an error.
                    // The gate still runs first: a stale generation must be
                    // refused even when the request is a no-op.
                    if target_monitor == current_monitor {
                        match command_gate(generation, gen, &cancelled, deadline) {
                            Ok(()) => { let _ = reply_tx.send(Ok(())); }
                            Err(e) => { let _ = reply_tx.send(Err(e)); }
                        }
                        continue;
                    }
                    // The build RECEIVES the live capture, because DXGI
                    // duplication is exclusive per output and both directions
                    // of an All Displays switch overlap the screen already
                    // being streamed. Opening a second duplication of it is
                    // the collision that made this feature fail every time.
                    let from_monitor = current_monitor;
                    let outcome = set_monitor_transition(
                        generation, gen, &cancelled, deadline, target_monitor, &reply_tx,
                        capture.take().expect("the stream always holds a capture"),
                        |m, cur| match (m, cur) {
                            // To the composite: hand it the screen we hold.
                            (crate::composite::ALL_DISPLAYS, AnyCapture::Single(sc)) => {
                                VirtualCapture::adopt(from_monitor, sc)
                                    .map(AnyCapture::Virtual)
                                    .map_err(|(sc, e)| (AnyCapture::Single(sc), e.to_string()))
                            }
                            // Out of the composite: take the screen back out of
                            // it rather than re-opening one it still holds.
                            (m, AnyCapture::Virtual(mut vc)) => match vc.take(m) {
                                Some(sc) => Ok(AnyCapture::Single(sc)),
                                None => Err((
                                    AnyCapture::Virtual(vc),
                                    format!("screen {m} is not part of the composite"),
                                )),
                            },
                            // Screen to screen: unchanged — open the new one
                            // first, and only release the old once it worked.
                            (m, AnyCapture::Single(sc)) => match ScreenCapture::new(m) {
                                Ok(next) => Ok(AnyCapture::Single(next)),
                                Err(e) => Err((AnyCapture::Single(sc), e.to_string())),
                            },
                        },
                    );
                    match outcome {
                        Transition::Commit { capture: next, replied } => {
                            capture = Some(next);
                            // Cursor ownership is a property of the SESSION,
                            // not of the capture — and every capture is born
                            // drawing the pointer. Without re-applying here, a
                            // monitor switch silently handed the cursor back
                            // while the controller was still drawing its own,
                            // putting two on screen: the exact state this
                            // feature exists to prevent, reachable by pressing
                            // a button in the picker.
                            if let Some(c) = capture.as_mut() {
                                c.set_draw_cursor(draw_host_cursor);
                            }
                            // The encoder is KEPT: pump_frame reconfigures it
                            // in place when the new capture's size differs
                            // (Encoder::update_size) — the full MFT rebuild
                            // was the largest chunk of the "zoom to read text
                            // is slow" switch freeze. A transform that
                            // refuses falls back to exactly the old
                            // drop-and-rebuild inside the pump; a same-size
                            // switch (cloned monitors) now costs only an IDR.
                            want_keyframe = true;
                            switch_started = Some(Instant::now());
                            eprintln!("[switch] capture committed -> monitor {target_monitor}");
                            current_monitor = target_monitor;
                            // The SAME caret is a different fraction of a
                            // different screen. The generation is bumped
                            // unconditionally rather than only when the
                            // rectangle differs: two cloned outputs share a
                            // desktop rect, and the viewer still has to be told
                            // which `mon` it is now looking at. The surface
                            // itself is only re-derived while somebody is
                            // tracking, because deriving it enumerates DXGI
                            // outputs and arming recomputes it anyway.
                            caret_surf += 1;
                            if caret_tracker.is_some() {
                                caret_surface = capture
                                    .as_ref()
                                    .and_then(|c| c.caret_surface(current_monitor));
                                caret_geometry_checked = Some(Instant::now());
                                caret_last_sent = None;
                            }
                            if !replied {
                                let _ = reply_tx.send(Ok(()));
                            }
                        }
                        Transition::Keep(same) => {
                            capture = Some(same);
                        }
                    }
                }
                StreamCommand::UpdateQuality { generation: gen, request_id: _, deadline, cancelled, fps: w_fps, bitrate_bps: w_bitrate, reply_tx } => {
                    match apply_quality_update(generation, gen, &cancelled, deadline, w_fps, w_bitrate, &mut current_fps, &mut current_bitrate) {
                        Ok((f, b)) => {
                            // LIVE FIRST. The old path tore the encoder down for
                            // every change — a GPU encode-session re-acquisition
                            // (drivers cap those machine-wide) plus a forced IDR
                            // the viewer pays for as a quality dip. Bitrate is a
                            // documented dynamic property on every MFT tested,
                            // and pacing DOWN needs no encoder change at all;
                            // only pacing above the built rate still rebuilds.
                            let live = match encoder.as_mut() {
                                Some(e) => e.update_rate(
                                    w_bitrate.and(Some(b)),
                                    w_fps.and(Some(f)),
                                ),
                                // No encoder yet (still screen, or DataOnly):
                                // the next pump builds at the new rates anyway.
                                None => true,
                            };
                            if !live {
                                encoder = None;
                                want_keyframe = true;
                                eprintln!("[stream] quality -> {f}fps {}kbps (encoder rebuilt)", b / 1000);
                            } else {
                                eprintln!("[stream] quality -> {f}fps {}kbps (applied live)", b / 1000);
                            }
                            frame_interval = Duration::from_secs_f64(1.0 / current_fps.max(1) as f64);
                            let _ = reply_tx.send(Ok((f, b)));
                        }
                        Err(e) => {
                            let _ = reply_tx.send(Err(e));
                        }
                    }
                }
                StreamCommand::SetDrawCursor(on) => {
                    eprintln!("[stream] host cursor compositing -> {}", if on { "on" } else { "off (controller owns it)" });
                    // Remembered for the life of the stream: a later monitor
                    // switch builds a fresh capture that would otherwise
                    // resume drawing.
                    draw_host_cursor = on;
                    if let Some(c) = capture.as_mut() {
                        c.set_draw_cursor(on);
                    }
                    // The retained still-frame holds the OLD cursor baked into
                    // its pixels, and a motionless desktop re-encodes exactly
                    // that frame — so without dropping it the pointer would
                    // sit frozen on screen until something else moved. The
                    // keyframe makes the correction land on a decodable frame
                    // rather than a delta against a picture the controller no
                    // longer has.
                    last_frame = None;
                    want_keyframe = true;
                }
                StreamCommand::RequestKeyframe => {
                    // Same lever the peer's PLI pulls (see Event::KeyframeRequest
                    // below): the pump re-sends the last picture while this is
                    // outstanding, so a perfectly still desktop still gets its
                    // IDR — the exact case a resumed Android controller needs.
                    eprintln!("[stream] keyframe requested by controller");
                    want_keyframe = true;
                }
            }
        }

        let fresh: Vec<String> = match remote_candidates.lock() {
            Ok(mut q) => q.drain(..).collect(),
            Err(_) => Vec::new(),
        };
        for cand in fresh {
            match sender.add_remote_candidate(&cand) {
                Ok(()) => {
                    eprintln!("[stream] remote candidate: {cand}");
                    if let (Some(alloc), Some(_)) = (relay.as_mut(), relayed_addr) {
                        if let Some(addr) = candidate_addr(&cand) {
                            if alloc.needs_permission(addr) {
                                alloc.request_permission(&socket, addr);
                            }
                        }
                    }
                }
                Err(e) => eprintln!("[stream] ignoring remote candidate ({e}): {cand}"),
            }
        }

        let timeout = loop {
            match sender.rtc_mut().poll_output().map_err(|e| format!("poll: {e}"))? {
                Output::Transmit(t) => {
                    tx_count += 1;
                    if tx_count <= 3 {
                        eprintln!("[stream] tx #{tx_count} {}B to {}", t.contents.len(), t.destination);
                    }
                    match (relayed_addr, relay.as_mut()) {
                        (Some(r), Some(alloc)) if t.source == r => {
                            if alloc.needs_permission(t.destination) {
                                alloc.request_permission(&socket, t.destination);
                            }
                            let wrapped = alloc.wrap_send(t.destination, &t.contents);
                            let _ = socket.send_to(&wrapped, alloc.server);
                            // Only traffic that can be MEDIA marks the relay
                            // as in use. ICE binding chatter (~100 bytes)
                            // runs on every valid pair every few seconds
                            // whatever pair is nominated — counting it kept
                            // this stamp permanently fresh, and a dead-but-
                            // UNUSED relay then reaped sessions whose media
                            // flowed fine on a direct pair. RTP video and
                            // DTLS records run well past this size; STUN
                            // checks never do.
                            if t.contents.len() > 200 {
                                last_relay_tx = Some(Instant::now());
                            }
                        }
                        _ => {
                            let _ = socket.send_to(&t.contents, t.destination);
                        }
                    }
                }
                Output::Event(ev) => match &ev {
                    str0m::Event::IceConnectionStateChange(st) => {
                        eprintln!("[stream] ice state -> {st:?}");
                        // Tracked, not just logged. Consent keepalives on the
                        // nominated pair are str0m's ground truth for "the
                        // viewer can still hear us"; Disconnected past a grace
                        // is a dead session wearing a live loop.
                        match st {
                            str0m::IceConnectionState::Disconnected => {
                                if ice_ever_connected && ice_down_since.is_none() {
                                    ice_down_since = Some(Instant::now());
                                }
                            }
                            str0m::IceConnectionState::Connected
                            | str0m::IceConnectionState::Completed => {
                                ice_ever_connected = true;
                                ice_down_since = None;
                            }
                            // Checking/New after a Disconnected means fresh
                            // candidates arrived and ICE is trying again —
                            // recovery in progress, not deeper death. A clock
                            // that kept counting through it killed sessions
                            // seconds from (re)connecting.
                            _ => {
                                ice_down_since = None;
                            }
                        }
                    }
                    str0m::Event::KeyframeRequest(_) => {
                        eprintln!("[stream] keyframe requested by peer");
                        want_keyframe = true;
                    }
                    str0m::Event::ChannelOpen(cid, name) => {
                        eprintln!("[stream] channel opened: {} (id: {:?})", name, cid);
                        if name == "files" {
                            files_channel = Some(*cid);
                        } else if name == crate::caret_wire::CHANNEL_NAME {
                            caret_channel = Some(*cid);
                        } else if name == crate::input_wire::CHANNEL_NAME {
                            // Recorded whether or not this stream can serve
                            // it: an unarmed stream logs the refusal once
                            // rather than silently ignoring the label, which
                            // is the failure mode caret_wire warns about.
                            input_channel_id = Some(*cid);
                            // AND TELL THE CONTROLLER, which is the half that
                            // was missing. Opening the channel proves nothing
                            // — str0m opens any label — so a controller that
                            // switched to it on `onopen` alone lost every
                            // event against exactly the sessions the else-arm
                            // below logs. The hello is sealed under the
                            // session key and sent ONLY when every
                            // authorisation gate is already satisfied, so
                            // "proved" and "will actually inject" are one
                            // statement rather than two that can drift.
                            let serving = input_channel
                                .as_ref()
                                .filter(|ch| ch.serves())
                                .and_then(|ch| {
                                    crate::control_key::seal(
                                        &ch.key,
                                        crate::input_wire::HELLO_PLAINTEXT,
                                    )
                                    .map(|sealed| crate::input_wire::InputHello {
                                        sid: ch.session_id.clone(),
                                        hello: sealed,
                                    })
                                });
                            match serving {
                                Some(hello) => {
                                    let bytes =
                                        serde_json::to_vec(&hello).unwrap_or_default();
                                    match sender.rtc_mut().channel(*cid) {
                                        Some(mut c) => match c.write(false, &bytes) {
                                            Ok(_) => eprintln!(
                                                "[stream] input channel armed for session {}",
                                                hello.sid
                                            ),
                                            Err(e) => eprintln!(
                                                "[stream] input hello failed to send ({e}); the controller stays on the relay"
                                            ),
                                        },
                                        None => eprintln!(
                                            "[stream] the input channel vanished before its hello"
                                        ),
                                    }
                                }
                                None => eprintln!(
                                    "[stream] input channel opened but this session cannot serve it — no hello sent, so the controller keeps input on its existing path"
                                ),
                            }
                        }
                    }
                    str0m::Event::ChannelClose(cid) => {
                        if Some(*cid) == caret_channel {
                            // Stop sampling the moment nobody is listening: the
                            // accessibility calls are not free, and this is the
                            // only notification a viewer that navigated away
                            // ever sends.
                            eprintln!("[caret] the caret channel closed; tracking off");
                            caret_channel = None;
                            caret_tracker = None;
                            caret_last_sent = None;
                            caret_surface = None;
                        }
                    }
                    str0m::Event::ChannelData(data) => {
                        // ONLY the `files` channel reaches the filesystem, and
                        // only once a root has been granted. This arm used to
                        // deserialise any bytes on ANY channel into an
                        // FsRequest and run it unjailed, which turned "share my
                        // screen" into "read and write my whole disk". The peer
                        // opens the tunnel channel too, so matching the channel
                        // id is load-bearing, not tidiness.
                        //
                        // THE INVARIANT IS NOW A TWO-WAY MATCH, and both
                        // decisions are pure functions with tests: caret bytes
                        // can never reach `file_transfer`, and file bytes can
                        // never start a sampler. An unknown channel still falls
                        // through to nothing at all.
                        let (req, req_id) = match route_channel_data(
                            classify_channel(data.id, files_channel, caret_channel, input_channel_id),
                            &data.data,
                        ) {
                            Route::Track(on) => {
                                if !on {
                                    if caret_tracker.take().is_some() {
                                        eprintln!("[caret] tracking off");
                                    }
                                    caret_last_sent = None;
                                } else if !caret_sampling_allowed(mode, capture.is_some(), true) {
                                    // No picture means no surface for a fraction
                                    // to be OF — and a caret rectangle with no
                                    // video really would tell the viewer
                                    // something it cannot already see.
                                    if !caret_refusal_logged {
                                        caret_refusal_logged = true;
                                        eprintln!(
                                            "[caret] tracking refused: this session has no screen"
                                        );
                                    }
                                } else if caret_tracker.is_none() {
                                    caret_tracker =
                                        Some(puca_input::caret::track());
                                    caret_surface = capture
                                        .as_ref()
                                        .and_then(|c| c.caret_surface(current_monitor));
                                    caret_geometry_checked = Some(Instant::now());
                                    // Forces the immediate vis:false ACK below,
                                    // which is what lets the viewer tell "no
                                    // caret here" from "an agent that has never
                                    // heard of this channel".
                                    caret_last_sent = None;
                                    caret_budget_logged = false;
                                    eprintln!(
                                        "[caret] tracking on (mon={current_monitor} surf={caret_surf} surface={caret_surface:?})"
                                    );
                                }
                                continue;
                            }
                            Route::Input(frame) => {
                                // R4: opened and injected HERE — no webview,
                                // no Tauri IPC, no named pipe. The arm is the
                                // authorisation: view-only sessions are
                                // refused before anything is decrypted.
                                //
                                // A STREAM WITHOUT A KEY REACHES THIS ARM, and
                                // the `None` branch below is not defensive
                                // padding — it is the ORDINARY case for every
                                // attended session, whose key lives in the app
                                // (see session.rs's `sealed`). `classify_channel`
                                // keys purely off the channel id recorded at
                                // ChannelOpen, which is set whether or not this
                                // stream can serve it, so classification says
                                // nothing about capability.
                                //
                                // This comment previously claimed the opposite
                                // — "a stream without one never reaches this
                                // arm because the channel is not classified" —
                                // three lines above the branch that proves it
                                // wrong. That claim is why the controller was
                                // allowed to switch to this channel on
                                // `readyState` alone, and it cost every
                                // attended session ALL of its input in 0.8.121.
                                // The controller now waits for the sealed hello
                                // this stream only sends when it can serve.
                                match input_channel.as_ref() {
                                    None => eprintln!(
                                        "[stream] input frame on a session with no agent-held key \
                                         — dropped; the controller should still be on the relay"
                                    ),
                                    Some(ch) => match crate::input_wire::accept_frame(
                                        ch, &frame,
                                        |k, p| crate::control_key::open(k, p),
                                    ) {
                                        Ok(event_json) => {
                                            match serde_json::from_str::<puca_input::ControlInput>(
                                                &event_json,
                                            ) {
                                                Ok(ev) => {
                                                    if let Err(e) = crate::session::dispatch_input_public(ev) {
                                                        eprintln!("[stream] input inject failed: {e}");
                                                    }
                                                }
                                                Err(_) => eprintln!(
                                                    "[stream] input frame refused: {}",
                                                    crate::input_wire::InputReject::NotAnEvent.describe()
                                                ),
                                            }
                                        }
                                        Err(why) => eprintln!(
                                            "[stream] input frame refused: {}", why.describe()
                                        ),
                                    },
                                }
                                continue;
                            }
                            Route::Ignore(why) => {
                                if why != IgnoreReason::NotOurChannel {
                                    eprintln!("[stream] {}", why.describe());
                                }
                                continue;
                            }
                            // `id` is the request's, which the enum does not
                            // model. The client uses it to discard a straggler
                            // reply from a request that already timed out;
                            // without it one late reply shifted every later
                            // answer off by one and downloads truncated
                            // SILENTLY. A request with no id (an older app) gets
                            // a reply with no id, matched by order exactly as
                            // before.
                            Route::Fs { req, id } => (req, id),
                        };
                        // Answered OFF this thread (run_fs_worker) — the
                        // scope re-read lives there, so revocation is as
                        // instant as it ever was. The reply lands in
                        // `pending_fs_replies` via the harvest at the top of
                        // the loop and is written under the same budget and
                        // FIFO rules as before; the single worker preserves
                        // completion order, so id-less clients still match by
                        // order. Bound the in-flight window like the reply
                        // queue: the serialised client keeps at most a couple
                        // outstanding, so hitting the cap means a hostile or
                        // broken peer — logged, never silent.
                        if fs_inflight >= MAX_PENDING_FS_REPLIES {
                            eprintln!(
                                "[stream] fs request queue full ({MAX_PENDING_FS_REPLIES}); dropping a request"
                            );
                        } else if fs_req_tx.send((data.id, req, req_id)).is_ok() {
                            fs_inflight += 1;
                        } else {
                            // The worker never started (or died). ANSWER, not
                            // drop: a dropped request is a 15s client timeout
                            // per click with nothing anywhere saying why.
                            eprintln!("[stream] the fs worker is gone; refusing a file request");
                            if let Some(bytes) = encode_fs_reply(
                                &crate::file_transfer::FsResponse::error(
                                    "file transfer is unavailable on that computer",
                                ),
                                req_id,
                            ) {
                                if pending_fs_replies.len() < MAX_PENDING_FS_REPLIES {
                                    pending_fs_replies.push_back((data.id, bytes));
                                }
                            }
                        }
                    }
                    _ => {}
                },
                Output::Timeout(t) => break t,
            }
        };

        let now = Instant::now();

        // --- the caret report -------------------------------------------------
        //
        // Before the frame tick, because it is two comparisons and a ~90 byte
        // write and the frame tick can take milliseconds.
        if let (Some(cid), Some(tracker)) = (caret_channel, caret_tracker.as_ref()) {
            // Geometry re-derived on a SLOW CLOCK rather than pushed. A display
            // mode change, a rotation or a hot-plug moves the surface under the
            // mapping and NOTHING notifies this loop — the encoder is sized from
            // the first frame and never re-checked. One enumeration per two
            // seconds, only while a viewer is actually tracking, is the same
            // cadence the desktop re-follow already pays.
            if should_recheck_caret_geometry(caret_geometry_checked, now) {
                caret_geometry_checked = Some(now);
                let fresh = capture.as_ref().and_then(|c| c.caret_surface(current_monitor));
                if fresh != caret_surface {
                    eprintln!("[caret] surface changed: {caret_surface:?} -> {fresh:?}");
                    // A SIZE change is the case nothing else in this loop
                    // detects: the encoder was sized from the first frame and
                    // a grown display silently crops to it (both length and
                    // stride checks in encode_bgra still pass), so the picture
                    // the viewer decodes would be a corner of the surface these
                    // fractions describe. No explicit drop any more: the
                    // frame's size changes with the surface, and pump_frame's
                    // dim check reconfigures (or, on refusal, rebuilds) the
                    // encoder on the very next frame — same healing, without
                    // paying a full MFT rebuild when the transform can take
                    // the new size live. An origin-only change (a monitor
                    // moved in the layout) leaves the picture alone.
                    let size_of = |s: Option<crate::session::CaptureSurface>| {
                        s.map(|s| { let (_, _, w, h) = s.covers(); (w, h) })
                    };
                    if size_of(fresh) != size_of(caret_surface) {
                        eprintln!("[caret] surface size changed; the encoder follows on the next frame");
                        want_keyframe = true;
                    }
                    caret_surface = fresh;
                    // A generation the viewer can see: the same caret is a
                    // different fraction now, and a frame from before this is
                    // recognisably stale on arrival.
                    caret_surf += 1;
                    caret_last_sent = None;
                }
            }

            let sample = tracker.latest();
            let report =
                caret_report_for(sample, caret_surface, now, current_monitor, caret_surf, caret_seq + 1);
            if crate::caret_wire::caret_changed(caret_last_sent.as_ref(), &report) {
                if crate::caret_wire::caret_log_worthy(caret_last_sent.as_ref(), &report) {
                    eprintln!(
                        "[caret] {report:?} from rect {:?} on {caret_surface:?}",
                        sample.and_then(|s| s.rect),
                    );
                }
                if let (Some(bytes), Some(mut c)) =
                    (report.to_bytes(), sender.rtc_mut().channel(cid))
                {
                    // `false` = UTF-8 text, like the fs replies: sent as binary
                    // the browser hands the client a Blob and JSON.parse throws.
                    match c.write(false, &bytes) {
                        // Ok(false) = the SCTP send budget is full until the
                        // peer's SACK. DROPPED, NOT QUEUED — the opposite of
                        // the fs replies twenty lines above, and for a stated
                        // reason: a file reply is a transaction the client is
                        // blocked on, while a caret is STATE that the next
                        // sample supersedes. A queued caret delivered after the
                        // SACK would pan the camera to where the caret was
                        // 100ms ago. `commit_caret_send` leaves the dedupe key
                        // alone on a refusal, so the very next pass retries
                        // with the CURRENT value — and that rule is what its
                        // test pins.
                        Ok(accepted) => {
                            commit_caret_send(accepted, &mut caret_seq, &mut caret_last_sent, report);
                            if accepted {
                                caret_budget_logged = false;
                            } else if !caret_budget_logged {
                                caret_budget_logged = true;
                                eprintln!("[caret] send budget full, dropped");
                            }
                        }
                        Err(e) => eprintln!("[caret] write failed: {e}"),
                    }
                }
            }
        }

        let mut flushed_frame = false;
        // `capture.is_some()` is the guard, not `mode`: the SetMonitor
        // transition briefly takes the capture out, and the invariant that
        // matters here is "there is one to pump", not "this session wants one".
        if capture.is_some() && now >= next_frame {
            next_frame += frame_interval;
            if now > next_frame + frame_interval {
                next_frame = now;
            }
            match pump_frame(capture.as_mut().expect("checked is_some above"), &mut encoder, &mut sender, current_bitrate, current_fps, &mut want_keyframe, now, &mut pump_stats, &mut last_frame, frames_sent == 0) {
                Ok(sent) => {
                    frames_sent += u64::from(sent);
                    flushed_frame = sent;
                    if sent {
                        if let Some(t0) = switch_started.take() {
                            eprintln!(
                                "[switch] first frame sent {} ms after commit",
                                t0.elapsed().as_millis()
                            );
                        }
                    }
                    skipped = 0;
                    if blocked_since.take().is_some() {
                        if blocked_reported {
                            eprintln!("[stream] the secure desktop is gone; capture resumed");
                        }
                        blocked_reported = false;
                        // Tell the app the secure desktop closed, so it can tear
                        // down the bridge and return to this agent's own capture.
                        if secure_desktop_signaled {
                            secure_desktop_signaled = false;
                            let _ = events_tx.send(StreamEvent::SecureDesktop {
                                session_id: session_id.clone(),
                                generation,
                                up: false,
                            });
                        }
                        // Fresh clocks for the NEXT blockage — a latch that
                        // only burns once per session is the bug this fixes.
                        last_follow = None;
                        last_rebuild = None;
                    }
                    if frames_sent <= 3 || frames_sent.is_multiple_of(60) {
                        eprintln!("[stream] frames sent: {frames_sent}");
                        // On the SAME cadence, so the log volume does not
                        // change: where each frame's time actually went.
                        eprintln!("{}", pump_stats.report_and_reset(started_at.elapsed()));
                    }
                    if !sent {
                        eprintln!("[stream] encoded a frame but the writer refused it");
                    }
                }
                Err(PumpError::NoChange) => {
                    skipped += 1;
                    if skipped == 30 || skipped == 150 {
                        eprintln!("[stream] {skipped} consecutive skips (still screen)");
                    }
                    // NO FIRST FRAME EVER is not a still screen — a still
                    // screen was captured once and is re-sent on demand; this
                    // is a duplication that has never presented anything,
                    // which is what a sleeping panel looks like when creation
                    // "succeeded". Escalate: one more wake at ~2s, and at
                    // ~12s stop pretending and end with the real cause (the
                    // controller's media deadline then reports something
                    // true instead of guessing at version skew).
                    if frames_sent == 0 && mode == StreamMode::Video {
                        let waited = started_at.elapsed();
                        if !cold_start_renudged && waited >= Duration::from_secs(2) {
                            cold_start_renudged = true;
                            #[cfg(windows)]
                            crate::display_wake::nudge();
                            want_keyframe = true;
                        }
                        if waited >= Duration::from_secs(12) {
                            return Err(
                                "no frame ever arrived from the display — the screens on that computer appear to be asleep and did not wake".to_string(),
                            );
                        }
                    }
                }
                Err(PumpError::SecureDesktop) => {
                    // FOLLOW IT — AND KEEP FOLLOWING. AccessLost from
                    // DuplicateOutput on the secure desktop is a
                    // DESKTOP-PERMISSION answer, not a DXGI limit: measured
                    // 2026-08-15, a SYSTEM thread attached via
                    // SetThreadDesktop duplicates Winlogon at full resolution.
                    //
                    // PERIODIC, not once. The single-shot version fired at the
                    // first AccessLost of a blockage — which, on the
                    // lock-curtain → PIN-box transition, is the exact instant
                    // the input desktop is still switching, so the follow
                    // could attach to the OUTGOING desktop and the latch never
                    // gave it a second chance. Every 2s is one kernel call per
                    // two seconds of blockage (not per frame), lands after the
                    // switch settles, and a user-flavour agent that can never
                    // follow just fails quietly at the same low rate.
                    skipped += 1;
                    let start = *blocked_since.get_or_insert(now);
                    if should_follow_again(last_follow, now) {
                        last_follow = Some(now);
                        match puca_input::desktop::follow_input_desktop() {
                            Ok(name) => eprintln!(
                                "[stream] capture blocked; followed the input desktop to '{name}'"
                            ),
                            Err(e) => {
                                eprintln!("[stream] capture blocked and {e}");
                                // We cannot reach the secure desktop (user-token
                                // agent). Tell the app ONCE per blockage so it can
                                // bring up the SYSTEM bridge; the flag resets on
                                // recovery. A SYSTEM agent lands in the Ok arm and
                                // never signals — it just crosses and keeps going.
                                if !secure_desktop_signaled {
                                    secure_desktop_signaled = true;
                                    let _ = events_tx.send(StreamEvent::SecureDesktop {
                                        session_id: session_id.clone(),
                                        generation,
                                        up: true,
                                    });
                                }
                            }
                        }
                    }
                    // ESCALATE to a full rebuild when following alone has not
                    // recovered it. Rebuilding drops the whole capture —
                    // D3D device included, which the per-tick duplication
                    // rebuild inside next_frame can never do (a lost device
                    // makes DuplicateOutput fail forever on the old handle).
                    // Created fresh on THIS thread, which the follow above has
                    // been re-attaching to the current input desktop.
                    if should_rebuild_capture(start, last_rebuild, now) {
                        last_rebuild = Some(now);
                        let attempt = if current_monitor == crate::composite::ALL_DISPLAYS {
                            VirtualCapture::new().map(AnyCapture::Virtual)
                        } else {
                            ScreenCapture::new(current_monitor).map(AnyCapture::Single)
                        };
                        match attempt {
                            Ok(fresh) => {
                                eprintln!(
                                    "[stream] capture blocked {:?} — rebuilt the capture from scratch",
                                    now.duration_since(start)
                                );
                                capture = Some(fresh);
                                // A fresh capture is born drawing the host
                                // pointer (and seeded with its shape). If a
                                // controller OWNS the cursor, the rebuild
                                // would silently put a second pointer on
                                // screen — re-apply ownership exactly as the
                                // monitor switch does.
                                if let Some(c) = capture.as_mut() {
                                    c.set_draw_cursor(draw_host_cursor);
                                }
                                // The encoder goes with it — same pattern as a
                                // monitor switch. It was sized from the first
                                // frame and never re-checked, and a blockage
                                // this long can span a display-mode change; a
                                // fresh capture feeding a stale-sized encoder
                                // is a Fatal that ends the session the rebuild
                                // just saved. The replacement sizes itself from
                                // the next frame and opens with an IDR.
                                encoder = None;
                                // And repaint the controller whole either way:
                                // after a blockage this long the reference
                                // chain is stale history to what is on screen.
                                want_keyframe = true;
                                // A blockage this long can span a display-mode
                                // change — the same reason the encoder is
                                // dropped above — so the caret's surface is
                                // re-derived from the capture that replaced the
                                // old one rather than carried over.
                                caret_surf += 1;
                                if caret_tracker.is_some() {
                                    caret_surface = capture
                                        .as_ref()
                                        .and_then(|c| c.caret_surface(current_monitor));
                                    caret_geometry_checked = Some(now);
                                    caret_last_sent = None;
                                }
                            }
                            Err(e) => eprintln!(
                                "[stream] capture blocked {:?} and a rebuild failed too: {e}",
                                now.duration_since(start)
                            ),
                        }
                    }
                    if should_report_secure_desktop(Some(start), blocked_reported, now) {
                        blocked_reported = true;
                        eprintln!(
                            "[stream] a Windows security screen owns the display (lock screen,                              sign-in screen, or an administrator prompt) — capture is blocked                              until it closes; the viewer is holding the last frame"
                        );
                    }
                }
                Err(PumpError::EncoderFilling) => {
                    // Counted SEPARATELY from a still screen. Lumping the two
                    // together under one message is what hid half a second of
                    // encoder buffering: both look like "no frame came out",
                    // and only one of them is free.
                    skipped += 1;
                    if skipped == 30 || skipped == 150 {
                        eprintln!("[stream] {skipped} consecutive skips (encoder filling)");
                    }
                }
                Err(PumpError::Fatal(e)) => return Err(e),
            }
        }

        // A frame written by `pump_frame` sits in str0m's payload queue until
        // the next poll_output drain — `writer.write()` queues, it does not
        // transmit. Sleeping in recv first (the old order) parked every encoded
        // frame for up to a whole frame interval (~30ms at 30fps) before its
        // RTP packets reached the socket, and the delay was invisible in
        // receiver stats because the RTP timestamp is stamped at send. Go
        // straight back to the drain instead. Guarded on being ahead of
        // schedule so a machine whose pump takes longer than the frame
        // interval still reaches recv_from (its 1ms clamp below) and cannot
        // starve ICE.
        if flushed_frame && Instant::now() < next_frame {
            continue;
        }

        let wait = timeout.saturating_duration_since(Instant::now());
        // Only fold in the frame cadence when there IS a capture. With none,
        // `next_frame` is set once at startup and never advances (the pump block
        // that would advance it is skipped), so `wait_for_frame` would be zero
        // forever — pinning the loop to a 1ms socket timeout and burning a core
        // to serve a session that sends no pixels.
        let wait = match capture {
            Some(_) => wait.min(next_frame.saturating_duration_since(Instant::now())),
            None => wait,
        };
        // A file answer in flight must not be parked behind a long idle wait:
        // a FILES-ONLY session has no frame cadence, so its str0m timeout can
        // be seconds — and a listing the worker finished instantly would sit
        // unharvested for all of them. 10ms keeps the harvest prompt without
        // busy-spinning while nothing is pending.
        let wait = if fs_inflight > 0 { wait.min(Duration::from_millis(10)) } else { wait };
        let wait = wait.max(Duration::from_millis(1));
        let _ = socket.set_read_timeout(Some(wait));

        match socket.recv_from(&mut buf) {
            Ok((n, source)) => {
                rx_count += 1;
                if rx_count <= 3 || rx_count.is_multiple_of(100) {
                    eprintln!("[stream] rx #{rx_count} {n}B from {source}");
                }
                let mut relayed_payload = None;
                if let (Some(alloc), Some(r)) = (relay.as_mut(), relayed_addr) {
                    if source == alloc.server {
                        if let Some((peer, data)) = crate::turn::parse_data_indication(&buf[..n]) {
                            relayed_payload = Some((peer, r, data));
                        } else if alloc.handle_server_message(&buf[..n]) {
                            continue;
                        }
                    }
                }

                let (source, dest, payload): (SocketAddr, SocketAddr, &[u8]) =
                    match &relayed_payload {
                        Some((peer, r, data)) => (*peer, *r, data.as_slice()),
                        None => (source, destination_for(source, &advertised), &buf[..n]),
                    };
                if let Ok(recv) = Receive::new(Protocol::Udp, source, dest, payload) {
                    sender
                        .rtc_mut()
                        .handle_input(Input::Receive(Instant::now(), recv))
                        .map_err(|e| format!("receive: {e}"))?;
                }
            }
            Err(_) => {
                sender
                    .rtc_mut()
                    .handle_input(Input::Timeout(Instant::now()))
                    .map_err(|e| format!("timeout: {e}"))?;
            }
        }

        if let Some(alloc) = relay.as_mut() {
            alloc.maybe_refresh(&socket);
            // A dead allocation is only fatal for a session that was USING the
            // relay: media is still leaving through it while the server has
            // nothing to forward it with, which is a blackhole no keyframe
            // request can fix. `looks_dead` is definitive, not a guess — the
            // lifetime can only be extended by a REFRESH_SUCCESS that never
            // came (see turn.rs). Sessions nominated onto a direct pair keep
            // running; their relay dying costs them nothing.
            if alloc.looks_dead()
                && last_relay_tx.is_some_and(|t| t.elapsed() < Duration::from_secs(15))
            {
                return Err(
                    "the TURN relay allocation expired and could not be renewed; \
                     media was blackholed"
                        .to_string(),
                );
            }
        }

        // ICE Disconnected past the grace = the viewer is unreachable and
        // str0m will neither recover it (no restart machinery) nor set
        // is_alive() false for it. Exiting is what turns an invisible
        // forever-freeze into a reaped stream: the encoder stops burning a
        // core, DXGI is released, and the next request from the app answers
        // "no such capture session" — which the host now RELAYS to the
        // controller as stream-died, so the viewer gets a restart or an
        // honest error instead of a still image.
        //
        // 90 seconds, NOT a snappy 20: this clock must OUTLAST every
        // reconnect grace the rest of the stack honours. A backgrounded
        // phone stops answering consent within seconds, and both the client
        // transport grace and the server's detach grace hold the session for
        // 60s so exactly that phone can come back to a live picture — an
        // agent that reaped the stream at 20s defeated both. This bound is a
        // backstop against encoding into a void FOREVER, not a fast-failure
        // path; the controller-side liveness ladder owns fast recovery.
        const ICE_DEAD_AFTER: Duration = Duration::from_secs(90);
        if let Some(since) = ice_down_since {
            if since.elapsed() > ICE_DEAD_AFTER {
                return Err(format!(
                    "the media connection to the viewer was lost (ICE disconnected for {}s)",
                    since.elapsed().as_secs()
                ));
            }
        }

        if !sender.rtc_mut().is_alive() {
            return Ok(());
        }
    }
    Ok(())
}

enum PumpError {
    /// The screen did not change. Free, and the normal state of a still
    /// desktop.
    NoChange,
    /// The encoder is holding frames and has not emitted one yet. NOT free —
    /// this is pipeline depth, i.e. latency, and it used to be counted
    /// identically to NoChange under one "still screen, or encoder filling"
    /// message that could not tell the two apart. That ambiguity is why the
    /// encoder's half-second buffer went unnoticed for so long.
    EncoderFilling,
    /// A secure desktop owns the display, so there is nothing to capture at
    /// all. Visually identical to NoChange — the last frame stays up — which
    /// is precisely why it needed its own variant: collapsed into NoChange, a
    /// UAC prompt was indistinguishable from a desktop nobody was touching,
    /// and the viewer sat on a frozen picture with no error for as long as the
    /// prompt was open.
    SecureDesktop,
    Fatal(String),
}

/// Where a frame's time goes, accumulated between reports.
///
/// The whole point is attribution: "the stream is laggy" is not actionable,
/// and "capture 1ms / encode 34ms / send 0ms" says exactly where to look.
#[derive(Default)]
struct PumpStats {
    samples: u32,
    capture: SpanStats,
    encode: SpanStats,
    send: SpanStats,
    /// Frames the encoder swallowed without emitting, since the last report.
    filling: u32,
}

#[derive(Default)]
struct SpanStats {
    min_us: u64,
    max_us: u64,
    total_us: u64,
}

impl SpanStats {
    fn add(&mut self, d: Duration) {
        let us = d.as_micros() as u64;
        if self.min_us == 0 || us < self.min_us {
            self.min_us = us;
        }
        if us > self.max_us {
            self.max_us = us;
        }
        self.total_us += us;
    }

    fn report(&self, n: u32) -> String {
        if n == 0 {
            return "-".to_string();
        }
        format!(
            "{:.1}/{:.1}/{:.1}ms",
            self.min_us as f64 / 1000.0,
            self.total_us as f64 / n as f64 / 1000.0,
            self.max_us as f64 / 1000.0,
        )
    }
}

impl PumpStats {
    fn report_and_reset(&mut self, elapsed: Duration) -> String {
        let n = self.samples;
        let line = format!(
            "[stream] +{:.1}s timing over {n} frame(s): capture {} encode {} send {} (encoder held {})",
            elapsed.as_secs_f64(),
            self.capture.report(n),
            self.encode.report(n),
            self.send.report(n),
            self.filling,
        );
        *self = PumpStats::default();
        line
    }
}

/// On a tick where the screen did not change, is there any reason to send?
///
/// Only when something is WAITING for a picture — a rebuilt encoder after a
/// monitor switch or quality change, or a peer that asked for a keyframe — and
/// only if we actually hold a picture to re-send. Otherwise a still desktop
/// should cost nothing, which is the whole point of change-driven capture.
fn should_resend_still(want_keyframe: bool, have_last_frame: bool) -> bool {
    want_keyframe && have_last_frame
}

/// How long the picture may sit frozen on a secure desktop before we say so.
///
/// `Timeout` and `AccessLost` produce the same visible result — the last frame
/// stays on screen — and the code treated them as the same thing. They are not.
/// A `Timeout` means the desktop is genuinely still and repeating the frame is
/// exactly right. An `AccessLost` means a UAC prompt, the lock screen or the
/// sign-in screen has taken the display and we are capturing NOTHING, which
/// looks identical to the viewer: a frozen picture, a cursor that still moves
/// because the controller draws it locally, and no error anywhere.
///
/// That is a second, previously unattributed cause of the field-reported "still
/// image but the mouse works", which the code blames on ICE alone.
///
/// One second, because DuplicateOutput is retried on every pump tick and a real
/// desktop switch resolves in well under that — this must not fire for the
/// ordinary flicker of alt-tabbing into a fullscreen game.
const SECURE_DESKTOP_NOTICE_AFTER: std::time::Duration = std::time::Duration::from_secs(1);

/// How often to re-attach the capture thread to the input desktop while
/// blocked. Two seconds: comfortably after any desktop switch has settled,
/// and one kernel call per two seconds of blockage rather than per frame.
const REFOLLOW_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

/// How long a blockage may persist before the whole capture (D3D device
/// included) is rebuilt, and how often to retry that. The per-tick duplication
/// rebuild inside `next_frame` reuses the old device, which a device-level
/// loss makes permanently useless; only a from-scratch rebuild recovers those.
const REBUILD_AFTER: std::time::Duration = std::time::Duration::from_secs(5);

/// Is a(nother) input-desktop follow due?
///
/// Pure for the same reason as `should_report_secure_desktop`: the rule that
/// replaced the one-shot latch must be testable without producing a real
/// desktop switch. `None` = no follow yet this blockage — always due.
fn should_follow_again(
    last_follow: Option<std::time::Instant>,
    now: std::time::Instant,
) -> bool {
    match last_follow {
        None => true,
        Some(t) => now.duration_since(t) >= REFOLLOW_EVERY,
    }
}

/// How often the caret's surface is re-derived while a viewer is tracking.
///
/// The same two seconds the desktop re-follow uses, and for a related reason:
/// this is the only detector anywhere in this codebase of a display-mode change
/// that does not rebuild the capture. A growing mode change silently crops to the
/// old size (both the length and stride checks in `encode_bgra` still pass), and
/// the caret fractions would then be of a surface larger than what is encoded —
/// the camera drifting toward the top-left the further right the caret moves.
const CARET_GEOMETRY_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

/// Is a caret-surface re-derivation due? `None` = never checked, always due.
fn should_recheck_caret_geometry(
    last: Option<std::time::Instant>,
    now: std::time::Instant,
) -> bool {
    match last {
        None => true,
        Some(t) => now.duration_since(t) >= CARET_GEOMETRY_EVERY,
    }
}

/// May this session sample the caret at all?
///
/// Pure and exhaustive because it is a privacy gate, not an optimisation. While
/// video is flowing the caret is already in the pixels the viewer decodes, so
/// reporting its rectangle adds nothing — but a `DataOnly` session (file browsing
/// with no picture) has no pixels, and there a caret rectangle would reveal what
/// the person at the keyboard is typing into and where.
fn caret_sampling_allowed(mode: StreamMode, has_capture: bool, track_on: bool) -> bool {
    track_on && has_capture && matches!(mode, StreamMode::Video)
}

/// Which of this session's channels some bytes arrived on.
#[derive(PartialEq, Eq, Debug, Clone, Copy)]
enum ChannelRole {
    Files,
    Caret,
    /// R4: the controller's direct sealed-input channel.
    Input,
    Other,
}

/// Classify a channel id.
///
/// GENERIC over the id type only because `str0m::channel::ChannelId` is
/// deliberately not constructible outside str0m ("Deliberately not Deref or From
/// to avoid this Id being created outside of this module", channel.rs:17), so a
/// test cannot fabricate one. The call site pins the real type; the tests use
/// plain integers.
///
/// FILES IS CHECKED FIRST, so if the two ids were ever somehow equal the bytes go
/// to the handler with the jail and the grant check rather than to the sampler.
fn classify_channel<T: PartialEq + Copy>(
    id: T,
    files: Option<T>,
    caret: Option<T>,
    input: Option<T>,
) -> ChannelRole {
    if files == Some(id) {
        return ChannelRole::Files;
    }
    if caret == Some(id) {
        return ChannelRole::Caret;
    }
    if input == Some(id) {
        return ChannelRole::Input;
    }
    ChannelRole::Other
}

/// Why some bytes were dropped. A value rather than a string so the tests can
/// assert on it, and so no allocation happens on the ordinary
/// bytes-on-a-channel-we-do-not-serve path.
#[derive(PartialEq, Eq, Debug, Clone, Copy)]
enum IgnoreReason {
    NotOurChannel,
    UnparseableFs,
    UnparseableCaret,
    UnparseableInput,
}

impl IgnoreReason {
    fn describe(self) -> &'static str {
        match self {
            Self::NotOurChannel => "data on a channel this agent does not serve",
            Self::UnparseableFs => "unparseable fs request",
            Self::UnparseableCaret => "unparseable caret request",
            Self::UnparseableInput => "unparseable input frame",
        }
    }
}

/// What to DO with some bytes. Extracted from the `ChannelData` arm so the
/// routing can be tested with real serde against real byte strings — the arm
/// itself needs a live peer connection and cannot be.
#[derive(Debug)]
enum Route {
    Fs { req: crate::file_transfer::FsRequest, id: Option<u64> },
    Track(bool),
    /// R4: a sealed input frame for the direct channel.
    Input(crate::input_wire::InputFrame),
    Ignore(IgnoreReason),
}

fn route_channel_data(role: ChannelRole, bytes: &[u8]) -> Route {
    match role {
        ChannelRole::Other => Route::Ignore(IgnoreReason::NotOurChannel),
        ChannelRole::Input => match crate::input_wire::parse_frame(bytes) {
            Some(f) => Route::Input(f),
            None => Route::Ignore(IgnoreReason::UnparseableInput),
        },
        ChannelRole::Caret => match serde_json::from_slice::<crate::caret_wire::CaretRequest>(bytes)
        {
            Ok(crate::caret_wire::CaretRequest::Track { on }) => Route::Track(on),
            Err(_) => Route::Ignore(IgnoreReason::UnparseableCaret),
        },
        ChannelRole::Files => {
            // Value first, so the request's `id` can be echoed on the reply.
            let Ok(val) = serde_json::from_slice::<serde_json::Value>(bytes) else {
                return Route::Ignore(IgnoreReason::UnparseableFs);
            };
            let id = val.get("id").and_then(|v| v.as_u64());
            match serde_json::from_value::<crate::file_transfer::FsRequest>(val) {
                Ok(req) => Route::Fs { req, id },
                Err(_) => Route::Ignore(IgnoreReason::UnparseableFs),
            }
        }
    }
}

/// Turn one sample into the frame the viewer gets.
///
/// Pure, so the staleness rule, the off-surface rule and the field-plausibility
/// rule are all testable without a sampler, a capture or a peer.
fn caret_report_for(
    sample: Option<puca_input::caret::CaretSample>,
    surface: Option<crate::session::CaptureSurface>,
    now: std::time::Instant,
    mon: usize,
    surf: u64,
    seq: u64,
) -> crate::caret_wire::CaretReport {
    use crate::caret_wire::{caret_is_stale, field_rect_is_plausible, CaretReport};
    use puca_input::caret::CaretSource;

    let hidden = CaretReport::hidden(mon, surf, seq);
    // No sample yet (the sampler has only just been armed) is the same report as
    // "no caret": vis:false. Which is also the ACK.
    let (Some(sample), Some(surface)) = (sample, surface) else { return hidden };
    // A sampler wedged inside a cross-process call stops publishing; following a
    // caret that moved a second ago is worse than not following.
    if caret_is_stale(sample.at, now) {
        return hidden;
    }
    let (Some(rect), Some(src)) = (sample.rect, sample.src) else { return hidden };
    let Some(f) = crate::session::caret_fractions(
        (rect.left, rect.top, rect.width, rect.height),
        surface,
    ) else {
        return hidden;
    };
    // A whole-field rect is only useful while it is actually the size of a text
    // box. A document body reported as one would pan the camera to the middle of
    // a page.
    if src == CaretSource::Field && !field_rect_is_plausible(&f) {
        return hidden;
    }
    CaretReport::at(f, src, mon, surf, seq)
}

/// What a caret write's outcome does to the dedupe key.
///
/// `accepted` is `channel.write`'s Ok(bool): true = on the wire, false = the SCTP
/// send budget is full until the peer's SACK. Only an ACCEPTED report becomes
/// `last_sent`; a refused one leaves it untouched, so the next pass computes the
/// current state again and `caret_changed` says "send" again — the retry is
/// automatic and there is deliberately no queue for a stale caret to sit in.
/// Pure and separate so the rule is testable: the write itself needs a live
/// peer.
fn commit_caret_send(
    accepted: bool,
    seq: &mut u64,
    last_sent: &mut Option<crate::caret_wire::CaretReport>,
    report: crate::caret_wire::CaretReport,
) {
    if accepted {
        *seq += 1;
        *last_sent = Some(report);
    }
}

/// Is a from-scratch capture rebuild due? Only once the blockage has outlived
/// `REBUILD_AFTER` (following alone usually recovers well before this), and
/// then at most once per `REBUILD_AFTER` thereafter.
fn should_rebuild_capture(
    blocked_start: std::time::Instant,
    last_rebuild: Option<std::time::Instant>,
    now: std::time::Instant,
) -> bool {
    if now.duration_since(blocked_start) < REBUILD_AFTER {
        return false;
    }
    match last_rebuild {
        None => true,
        Some(t) => now.duration_since(t) >= REBUILD_AFTER,
    }
}

/// Decide whether a run of `AccessLost` has gone on long enough to report.
///
/// Pure so the timing rule is testable without a display, a desktop switch or a
/// UAC prompt — none of which a unit test can produce.
fn should_report_secure_desktop(
    blocked_since: Option<std::time::Instant>,
    already_reported: bool,
    now: std::time::Instant,
) -> bool {
    match blocked_since {
        Some(t) if !already_reported => now.duration_since(t) >= SECURE_DESKTOP_NOTICE_AFTER,
        _ => false,
    }
}

#[allow(clippy::too_many_arguments)]
fn pump_frame(
    capture: &mut AnyCapture,
    encoder: &mut Option<Encoder>,
    sender: &mut VideoSender,
    bitrate: u32,
    fps: u32,
    want_keyframe: &mut bool,
    now: Instant,
    stats: &mut PumpStats,
    last_frame: &mut Option<puca_capture::Frame>,
    session_cold: bool,
) -> Result<bool, PumpError> {
    let t_capture = Instant::now();
    // BORROWED, not owned. The composite path used to hand back a cloned
    // canvas every tick — 56 MB per frame on a three-screen desktop, competing
    // for memory bandwidth with the encoder that is about to read it.
    let owned;
    let (fw, fh, fstride, fbytes): (u32, u32, usize, &[u8]) = match capture {
        AnyCapture::Virtual(v) => {
            // What counts as "holding a picture" depends on session
            // temperature. WARM (frames have been sent): the retained canvas
            // is always a real picture — the constant-true that fixed
            // "All Displays never appears after a switch", including the
            // single-monitor adopt case where the adopted tile's duplication
            // delivers nothing until the screen changes. COLD (no frame has
            // ever been sent): the canvas may still be its birth zero-fill,
            // and "re-sending" that encoded a BLACK keyframe which counted
            // as delivery and disabled the sleeping-display wake escalation
            // exactly when it was needed. Cold demands real tile content.
            let holding = if session_cold { v.has_content() } else { true };
            match v.refresh(5) {
                Ok(()) => {}
                // STILL SCREEN — see the long note on the Single arm below.
                // Same rule, same function: an inline copy of this condition
                // meant the test covered one arm of two.
                Err(CaptureError::AccessLost) if !should_resend_still(*want_keyframe, holding) => {
                    return Err(PumpError::SecureDesktop)
                }
                Err(CaptureError::Timeout) if !should_resend_still(*want_keyframe, holding) => {
                    return Err(PumpError::NoChange)
                }
                Err(CaptureError::Timeout) | Err(CaptureError::AccessLost) => {}
                Err(e) => return Err(PumpError::Fatal(format!("capture: {e}"))),
            }
            let (w, h, s, b) = v.surface();
            (w, h, s, b)
        }
        AnyCapture::Single(c) => {
            match c.next_frame(5) {
                Ok(f) => {
                    *last_frame = Some(f);
                }
                Err(ref err @ (CaptureError::Timeout | CaptureError::AccessLost)) => {
                    let secure = matches!(err, CaptureError::AccessLost);
                    // A STILL SCREEN PRODUCES NOTHING, and that used to mean
                    // the stream produced nothing either — which is fine while
                    // a picture is already on the wire and disastrous straight
                    // after the encoder is rebuilt. A monitor switch or a
                    // quality change drops the encoder, and the replacement
                    // needs frames before it emits anything; if the destination
                    // screen happens to be static, the only frames it can ever
                    // get are the ones the user creates by moving something on
                    // it. That is the ten-second monitor switch, the composite
                    // that never appears, and every unanswered keyframe
                    // request: the agent was waiting for the desktop, and the
                    // desktop was waiting for the user.
                    //
                    // So while a keyframe is outstanding, re-send the last
                    // picture we captured. It is the same image, which is
                    // exactly what a still screen means.
                    if !should_resend_still(*want_keyframe, last_frame.is_some()) {
                        return Err(if secure {
                            PumpError::SecureDesktop
                        } else {
                            PumpError::NoChange
                        });
                    }
                }
                Err(e) => return Err(PumpError::Fatal(format!("capture: {e}"))),
            }
            owned = last_frame.as_ref().expect("set or returned above");
            (owned.width, owned.height, owned.stride, &owned.bgra)
        }
    };

    let capture_took = t_capture.elapsed();

    let (w, h) = (fw & !1, fh & !1);
    // The capture under a LIVE encoder can change size — a monitor switch, a
    // display-mode change under a blocked-capture rebuild, a grown caret
    // surface. Reconfigure the running transform when it can take the new
    // size (update_size) — the full MFT rebuild was the largest chunk of the
    // switch freeze — and fall back to exactly the old drop-and-rebuild when
    // it refuses.
    if let Some(e) = encoder.as_mut() {
        if e.dims() != (w, h) {
            let t0 = Instant::now();
            if e.update_size(w, h) {
                eprintln!(
                    "[switch] encoder reconfigured to {w}x{h} in {} ms",
                    t0.elapsed().as_millis()
                );
                *want_keyframe = true;
            } else {
                eprintln!("[switch] encoder refused {w}x{h} live; rebuilding");
                *encoder = None;
            }
        }
    }

    let enc = match encoder {
        Some(e) => e,
        None => {
            // Build for the profile the PEER negotiated (Chromium offers
            // High, which is a straight quality win at the same bitrate);
            // Baseline stays the floor for anything that offered less. Read
            // from the same ranked selection send_frame uses, so the encoder
            // and the payload type cannot disagree.
            let profile = match sender.negotiated_h264_profile_idc() {
                Some(0x64) => puca_encode::H264Profile::High,
                Some(0x4D) => puca_encode::H264Profile::Main,
                _ => puca_encode::H264Profile::Baseline,
            };
            let t0 = Instant::now();
            let created = Encoder::new(w, h, fps, bitrate, profile)
                .map_err(|e| PumpError::Fatal(format!("encoder: {e}")))?;
            // (The backend names itself in its own [encode] line.)
            eprintln!("[switch] encoder built {w}x{h} in {} ms", t0.elapsed().as_millis());
            *encoder = Some(created);
            encoder.as_mut().expect("just set")
        }
    };

    let t_encode = Instant::now();
    match enc.encode_bgra(fbytes, fstride, *want_keyframe) {
        Ok(encoded) => {
            let encode_took = t_encode.elapsed();
            if encoded.keyframe {
                *want_keyframe = false;
            }
            let t_send = Instant::now();
            let sent = sender
                .send_frame(&encoded, now)
                .map_err(|e| PumpError::Fatal(format!("send: {e}")))?;
            stats.samples += 1;
            stats.capture.add(capture_took);
            stats.encode.add(encode_took);
            stats.send.add(t_send.elapsed());
            Ok(sent)
        }
        Err(EncodeError::NeedMoreInput) => {
            stats.filling += 1;
            Err(PumpError::EncoderFilling)
        }
        Err(e) => Err(PumpError::Fatal(format!("encode: {e}"))),
    }
}

#[cfg(test)]
impl Stream {
    pub fn create_for_test(
        _session_id: String,
        generation: u64,
        _monitor: usize,
        handle: std::thread::JoinHandle<()>,
        stop_flag: Arc<AtomicBool>,
        command_tx: std::sync::mpsc::Sender<StreamCommand>,
    ) -> Self {
        Self {
            remote_candidates: Arc::new(Mutex::new(Vec::new())),
            stop: stop_flag,
            handle: Some(handle),
            answer_sdp: "v=0".into(),
            local_addr: "127.0.0.1:0".parse().unwrap(),
            generation,
            command_tx,
            current_fps: Arc::new(AtomicU32::new(30)),
            current_bitrate_bps: Arc::new(AtomicU32::new(6_000_000)),
            // Ungranted, matching a real stream's initial state.
            file_scope: Arc::new(Mutex::new(None)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The id rides the reply when the request carried one, and never appears
    /// when it did not — an id-less client matches replies by order, and a
    /// surprise field is exactly the kind of thing a strict parser rejects.
    #[test]
    fn a_reply_echoes_the_request_id_and_only_then() {
        let resp = crate::file_transfer::FsResponse::error("nope");

        let with = encode_fs_reply(&resp, Some(42)).expect("encodes");
        let v: serde_json::Value = serde_json::from_slice(&with).unwrap();
        assert_eq!(v.get("id").and_then(|x| x.as_u64()), Some(42));
        assert_eq!(v.get("ok").and_then(|x| x.as_str()), Some("error"));

        let without = encode_fs_reply(&resp, None).expect("encodes");
        let v: serde_json::Value = serde_json::from_slice(&without).unwrap();
        assert!(v.get("id").is_none(), "an id-less request gets an id-less reply");
    }

    /// The request parser must tolerate the extra `id` field — serde ignores
    /// unknown fields on this enum, and this pins that, because adding
    /// `deny_unknown_fields` later would break every new client against this
    /// agent in a way nothing else would catch.
    #[test]
    fn a_request_carrying_an_id_still_parses() {
        let raw = br#"{"cmd":"read","path":"a.txt","offset":0,"len":16,"id":7}"#;
        let v: serde_json::Value = serde_json::from_slice(raw).unwrap();
        assert_eq!(v.get("id").and_then(|x| x.as_u64()), Some(7));
        let req = serde_json::from_value::<crate::file_transfer::FsRequest>(v);
        assert!(req.is_ok(), "{:?}", req.err());
    }

    // --- caret channel routing --------------------------------------------
    //
    // The `ChannelData` arm itself cannot be tested (it needs a live peer
    // connection; `Stream::create_for_test` builds no `Rtc`), so the two
    // DECISIONS inside it are pure functions and these are their tests. Real
    // `serde_json` against real byte strings throughout — no source scanning, and
    // no mocked parser that could accept something the shipped one rejects.

    const TRACK_ON: &[u8] = br#"{"t":"track","on":true}"#;
    const TRACK_OFF: &[u8] = br#"{"t":"track","on":false}"#;
    const FS_LIST: &[u8] = br#"{"cmd":"list","path":"C:\\","id":9}"#;

    /// The `files`-channel invariant, now a two-way match, with the fail-closed
    /// case spelled out.
    #[test]
    fn a_channel_is_classified_by_id_and_files_wins_a_tie() {
        assert_eq!(classify_channel(7u32, Some(7), Some(8), None), ChannelRole::Files);
        assert_eq!(classify_channel(8u32, Some(7), Some(8), None), ChannelRole::Caret);
        assert_eq!(classify_channel(9u32, Some(7), Some(8), None), ChannelRole::Other);
        // Nothing learned yet: every byte is on a channel we do not serve.
        assert_eq!(classify_channel(7u32, None, None, None), ChannelRole::Other);
        assert_eq!(classify_channel(7u32, None, Some(8), None), ChannelRole::Other);
        // FAIL CLOSED. If the two ids were ever equal, the bytes must go to the
        // handler that has a jail and a grant check — not to the one that starts
        // reading other processes' accessibility trees.
        assert_eq!(classify_channel(7u32, Some(7), Some(7), None), ChannelRole::Files);
    }

    #[test]
    fn a_track_frame_on_the_files_channel_is_refused() {
        assert!(matches!(
            route_channel_data(ChannelRole::Files, TRACK_ON),
            Route::Ignore(IgnoreReason::UnparseableFs),
        ));
    }

    #[test]
    fn an_fs_request_on_the_caret_channel_is_refused() {
        // REVERT-TO-RED: make the Caret arm fall through to the fs handler and
        // this is the test that goes red.
        assert!(matches!(
            route_channel_data(ChannelRole::Caret, FS_LIST),
            Route::Ignore(IgnoreReason::UnparseableCaret),
        ));
    }

    /// The `:1237` invariant: bytes on a channel this agent never labelled do
    /// nothing at all, whatever they say.
    #[test]
    fn data_on_an_unknown_channel_is_refused() {
        assert!(matches!(
            route_channel_data(ChannelRole::Other, FS_LIST),
            Route::Ignore(IgnoreReason::NotOurChannel),
        ));
        assert!(matches!(
            route_channel_data(ChannelRole::Other, TRACK_ON),
            Route::Ignore(IgnoreReason::NotOurChannel),
        ));
    }

    /// POSITIVE CONTROLS for the three refusals above. Without these, a router
    /// that ignored everything would pass all of them.
    #[test]
    fn each_channel_still_accepts_its_own_vocabulary() {
        match route_channel_data(ChannelRole::Files, FS_LIST) {
            Route::Fs { req, id } => {
                assert!(matches!(req, crate::file_transfer::FsRequest::List { .. }));
                assert_eq!(id, Some(9), "the reply must be able to echo the request id");
            }
            other => panic!("an fs request on the files channel was refused: {other:?}"),
        }
        assert!(matches!(route_channel_data(ChannelRole::Caret, TRACK_ON), Route::Track(true)));
        assert!(matches!(route_channel_data(ChannelRole::Caret, TRACK_OFF), Route::Track(false)));
    }

    /// The invariant underneath the router, pinned directly: the two vocabularies
    /// are tag-disjoint (`cmd` vs `t`), so neither parser can ever accept the
    /// other's frames even if the routing were removed.
    #[test]
    fn the_two_channel_vocabularies_cannot_be_confused() {
        assert!(serde_json::from_slice::<crate::file_transfer::FsRequest>(TRACK_ON).is_err());
        assert!(serde_json::from_slice::<crate::caret_wire::CaretRequest>(FS_LIST).is_err());
        // POSITIVE CONTROLS: each parses its own.
        assert!(serde_json::from_slice::<crate::file_transfer::FsRequest>(FS_LIST).is_ok());
        assert!(serde_json::from_slice::<crate::caret_wire::CaretRequest>(TRACK_ON).is_ok());
    }

    /// A caret needs a picture. All eight rows, because this is a privacy gate.
    #[test]
    fn a_session_with_no_screen_may_not_sample_the_caret() {
        for (mode, has_capture, track_on, expect) in [
            (StreamMode::Video, true, true, true),
            (StreamMode::Video, true, false, false),
            (StreamMode::Video, false, true, false),
            (StreamMode::Video, false, false, false),
            (StreamMode::DataOnly, true, true, false),
            (StreamMode::DataOnly, true, false, false),
            (StreamMode::DataOnly, false, true, false),
            (StreamMode::DataOnly, false, false, false),
        ] {
            assert_eq!(
                caret_sampling_allowed(mode, has_capture, track_on),
                expect,
                "mode={mode:?} capture={has_capture} track={track_on}",
            );
        }
    }

    #[test]
    fn the_caret_surface_is_rechecked_on_a_slow_clock() {
        let t = Instant::now();
        // Never checked: always due.
        assert!(should_recheck_caret_geometry(None, t));
        assert!(!should_recheck_caret_geometry(Some(t), t + Duration::from_millis(1900)));
        assert!(should_recheck_caret_geometry(Some(t), t + Duration::from_millis(2000)));
    }

    fn sample(
        rect: Option<puca_input::caret::CaretRect>,
        src: Option<puca_input::caret::CaretSource>,
        at: Instant,
    ) -> puca_input::caret::CaretSample {
        puca_input::caret::CaretSample { rect, src, seq: 1, at }
    }

    fn caret_rect(left: i32, top: i32, width: i32, height: i32) -> puca_input::caret::CaretRect {
        puca_input::caret::CaretRect { left, top, width, height }
    }

    fn vis_of(report: &crate::caret_wire::CaretReport) -> bool {
        let v = serde_json::to_value(report).expect("serialises");
        v["vis"].as_bool().expect("vis is always present")
    }

    #[test]
    fn a_report_is_hidden_unless_a_fresh_caret_is_really_on_the_surface() {
        let screen = crate::session::CaptureSurface::Single {
            left: 0,
            top: 0,
            width: 2560,
            height: 1440,
        };
        let at = Instant::now();
        let here = caret_rect(1280, 700, 2, 19);
        let win32 = puca_input::caret::CaretSource::Win32;

        // POSITIVE CONTROL first, so every `hidden` assertion below means
        // something.
        let visible = caret_report_for(
            Some(sample(Some(here), Some(win32), at)),
            Some(screen),
            at,
            0,
            1,
            1,
        );
        assert!(vis_of(&visible));
        let v = serde_json::to_value(&visible).unwrap();
        assert_eq!(v["x"], 0.5);
        assert_eq!(v["src"], "win32");

        // Nothing sampled yet — the ACK on arming.
        assert!(!vis_of(&caret_report_for(None, Some(screen), at, 0, 1, 1)));
        // A sampler that has stopped publishing (hand-derived: stale at 500ms).
        assert!(!vis_of(&caret_report_for(
            Some(sample(Some(here), Some(win32), at)),
            Some(screen),
            at + Duration::from_millis(501),
            0,
            1,
            1,
        )));
        // ...and still visible just under the bound.
        assert!(vis_of(&caret_report_for(
            Some(sample(Some(here), Some(win32), at)),
            Some(screen),
            at + Duration::from_millis(499),
            0,
            1,
            1,
        )));
        // No caret found this poll.
        assert!(!vis_of(&caret_report_for(
            Some(sample(None, None, at)),
            Some(screen),
            at,
            0,
            1,
            1,
        )));
        // The caret is on a screen this session is not showing.
        assert!(!vis_of(&caret_report_for(
            Some(sample(Some(caret_rect(3000, 700, 2, 19)), Some(win32), at)),
            Some(screen),
            at,
            0,
            1,
            1,
        )));
        // The surface is not known yet (between a rebuild and the recheck).
        assert!(!vis_of(&caret_report_for(
            Some(sample(Some(here), Some(win32), at)),
            None,
            at,
            0,
            1,
            1,
        )));
    }

    /// A `field` rect is only reported while it is the size of a text box.
    #[test]
    fn a_document_sized_field_is_reported_as_no_caret() {
        let screen = crate::session::CaptureSurface::Single {
            left: 0,
            top: 0,
            width: 2560,
            height: 1440,
        };
        let at = Instant::now();
        let field = puca_input::caret::CaretSource::Field;

        // The whole window: h = 1.0, refused.
        assert!(!vis_of(&caret_report_for(
            Some(sample(Some(caret_rect(0, 0, 2560, 1440)), Some(field), at)),
            Some(screen),
            at,
            0,
            1,
            1,
        )));
        // POSITIVE CONTROL: an ordinary single-line box (h = 40/1440 = 0.0278)
        // is reported, as a field.
        let ok = caret_report_for(
            Some(sample(Some(caret_rect(100, 200, 400, 40)), Some(field), at)),
            Some(screen),
            at,
            0,
            1,
            1,
        );
        assert!(vis_of(&ok));
        assert_eq!(serde_json::to_value(&ok).unwrap()["src"], "field");
    }

    /// The dedupe key follows what SCTP accepted, not what was computed.
    ///
    /// `Ok(false)` from `channel.write` means the send budget is full until the
    /// peer's SACK — the trap that "killed every real download" twenty lines
    /// above this in the fs path. There the answer is a queue; here it must be a
    /// DROP, because a caret is state and a queued one arrives describing the
    /// past. Leaving `caret_last_sent` untouched is what makes the retry
    /// automatic, and there is deliberately no `pending_caret` collection for it
    /// to sit in.
    #[test]
    fn a_refused_caret_write_is_retried_not_queued() {
        use crate::caret_wire::caret_changed;
        let screen = crate::session::CaptureSurface::Single {
            left: 0,
            top: 0,
            width: 2560,
            height: 1440,
        };
        let at = Instant::now();
        let s = Some(sample(
            Some(caret_rect(1280, 700, 2, 19)),
            Some(puca_input::caret::CaretSource::Win32),
            at,
        ));
        let mut last_sent = None;
        let mut seq = 0u64;

        // Pass 1: the state is new, so it is sent — but SCTP refuses it
        // (Ok(false)). The dedupe key must NOT move.
        let first = caret_report_for(s, Some(screen), at, 0, 1, seq + 1);
        assert!(caret_changed(last_sent.as_ref(), &first));
        commit_caret_send(false, &mut seq, &mut last_sent, first);
        assert!(last_sent.is_none(), "a refused write must not become the dedupe key");
        assert_eq!(seq, 0, "a refused write does not consume a sequence number");
        // Pass 2: the SAME state is computed again and must still read as
        // "send" — that is the retry. REVERT-TO-RED: make commit_caret_send
        // store the report on `accepted == false` and this fails.
        let retry = caret_report_for(s, Some(screen), at, 0, 1, seq + 1);
        assert!(
            caret_changed(last_sent.as_ref(), &retry),
            "a refused write must be retried on the next pass",
        );
        // Pass 2 is accepted.
        commit_caret_send(true, &mut seq, &mut last_sent, retry);
        assert_eq!(seq, 1);
        assert!(last_sent.is_some());
        // POSITIVE CONTROL: now the identical state is suppressed.
        let again = caret_report_for(s, Some(screen), at, 0, 1, seq + 1);
        assert!(!caret_changed(last_sent.as_ref(), &again));
    }

    #[test]
    fn local_interfaces_always_offers_something() {
        let addrs = local_interfaces(45678);
        assert!(!addrs.is_empty());
        assert!(addrs.iter().all(|a| a.port() == 45678), "every candidate uses the bound port");
        assert!(
            addrs.iter().any(|a| a.ip().is_loopback()),
            "loopback must be offered so a same-machine peer works with no network"
        );
    }

    #[test]
    fn the_receive_destination_is_a_real_candidate_never_the_wildcard() {
        let lan: SocketAddr = "192.168.0.10:5000".parse().unwrap();
        let loopback: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let advertised = vec![lan, loopback];

        let from_loopback: SocketAddr = "127.0.0.1:44444".parse().unwrap();
        assert_eq!(destination_for(from_loopback, &advertised), loopback,
            "a packet from loopback arrived on loopback");

        let from_lan: SocketAddr = "192.168.0.55:44444".parse().unwrap();
        assert_eq!(destination_for(from_lan, &advertised), lan,
            "a packet from the network arrived on the routable address");

        for a in [destination_for(from_lan, &advertised), destination_for(from_loopback, &advertised)] {
            assert!(!a.ip().is_unspecified(), "0.0.0.0 would be silently dropped by str0m");
        }
    }

    #[test]
    fn destination_falls_back_rather_than_panicking() {
        let lan: SocketAddr = "192.168.0.10:5000".parse().unwrap();
        assert_eq!(destination_for("127.0.0.1:1".parse().unwrap(), &[lan]), lan);
        let src: SocketAddr = "10.0.0.1:9".parse().unwrap();
        assert_eq!(destination_for(src, &[]), src);
    }

    #[test]
    fn a_malformed_offer_does_not_start_a_thread() {
        let (tx, _rx) = std::sync::mpsc::channel();
        assert!(start("not an sdp", 0, 30, 2_000_000, StreamMode::Video, &[], tx, "s".into(), 1, None).is_err());
    }

    struct DropTrackedResource {
        counter: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl Drop for DropTrackedResource {
        fn drop(&mut self) {
            self.counter.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// A late cancellation refuses the CALLER without losing the capture.
    ///
    /// This replaces `test_true_late_cancellation_discards_provisional_resource`,
    /// which asserted the built capture was DROPPED. That was right while every
    /// build opened a fresh duplication alongside the live one — dropping the
    /// spare left the old screen streaming. It became impossible once the build
    /// started CONSUMING the current capture (All Displays adopts it, because
    /// DXGI will not hand out a second duplication of a screen we already
    /// hold): there is no old capture to fall back to, so dropping what we have
    /// would leave the stream with nothing to encode.
    ///
    /// The invariant that actually matters, and what this now pins: the stream
    /// always ends up holding exactly one capture, and it is never dropped on
    /// the floor.
    #[test]
    fn a_late_cancellation_commits_and_says_so_distinctly() {
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cancelled = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_secs(5);
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();

        let flip = cancelled.clone();
        let built_counter = counter.clone();
        let outcome = set_monitor_transition(
            1, 1, &cancelled, deadline, 0, &reply_tx,
            DropTrackedResource { counter: counter.clone() },
            move |_, old| {
                // The caller times out mid-build; the build still succeeds and
                // consumes the capture it was given.
                flip.store(true, Ordering::SeqCst);
                drop(old);
                Ok(DropTrackedResource { counter: built_counter })
            },
        );

        match outcome {
            Transition::Commit { capture, replied } => {
                assert!(replied, "the caller must be told its request was cancelled");
                // Exactly the original was consumed by the build; the new one
                // is still alive in our hands.
                assert_eq!(counter.load(Ordering::SeqCst), 1, "only the superseded capture is released");
                drop(capture);
                assert_eq!(counter.load(Ordering::SeqCst), 2);
            }
            Transition::Keep(_) => panic!("a successful build must not be thrown away"),
        }
        // CommittedLate, not Cancelled. The agent reads this to decide whether
        // to move its reservations, its session record and the input aim —
        // reported as a plain cancellation it skipped all three, and then
        // aimed the pointer at a screen it was no longer showing.
        assert_eq!(reply_rx.recv().unwrap(), Err(StreamCommandError::CommittedLate));
    }

    /// A STILL SCREEN MUST STILL FEED A FRESHLY BUILT ENCODER.
    ///
    /// This is the decision behind the ten-second monitor switch. DXGI reports
    /// nothing when nothing moves, and the pump used to send nothing in
    /// response — fine while a picture is already flowing, disastrous straight
    /// after `encoder = None`, because the new encoder needs frames before it
    /// emits anything and a static destination screen never supplies one. The
    /// agent waited for the desktop; the desktop waited for the user.
    ///
    /// Pure decision function so the rule can be tested without a display: is a
    /// no-change tick a reason to send nothing, or to re-send what we have?
    #[test]
    fn a_still_screen_is_re_sent_only_while_a_keyframe_is_outstanding() {
        // want_keyframe, have_last_frame -> should re-send
        assert!(!should_resend_still(false, true), "a settled stream stays quiet");
        assert!(!should_resend_still(false, false), "nothing to send and nobody waiting");
        assert!(!should_resend_still(true, false), "cannot re-send a frame we never captured");
        assert!(
            should_resend_still(true, true),
            "somebody is waiting for a keyframe and we are holding the picture",
        );
    }

    /// A build that FAILS hands the live capture back, and the caller keeps
    /// streaming the screen it was already on. This is the property the
    /// adopt path most depends on: `VirtualCapture::adopt` returns the
    /// capture inside its `Err`, and losing it here would kill the session.
    #[test]
    fn a_failed_build_returns_the_live_capture_rather_than_dropping_it() {
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cancelled = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_secs(5);
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();

        let outcome = set_monitor_transition(
            1, 1, &cancelled, deadline, 7, &reply_tx,
            DropTrackedResource { counter: counter.clone() },
            |_, old| Err((old, "no such screen".to_string())),
        );

        match outcome {
            Transition::Keep(capture) => {
                assert_eq!(counter.load(Ordering::SeqCst), 0, "the live capture must survive a refused switch");
                drop(capture);
                assert_eq!(counter.load(Ordering::SeqCst), 1);
            }
            Transition::Commit { .. } => panic!("a failed build must not be committed"),
        }
        assert!(matches!(
            reply_rx.recv().unwrap(),
            Err(StreamCommandError::ConstructionFailed(_))
        ));
    }

    #[test]
    fn test_cancelled_quality_update_preserves_prior_encoder_state() {
        // Cancelled after send: the gate refuses, and the fps/bitrate the
        // encoder is running with stay exactly as they were.
        let cancelled = Arc::new(AtomicBool::new(true));
        let deadline = Instant::now() + Duration::from_secs(5);
        let (mut fps, mut bitrate) = (30u32, 6_000_000u32);
        assert_eq!(
            apply_quality_update(1, 1, &cancelled, deadline, Some(15), Some(1_000_000), &mut fps, &mut bitrate),
            Err(StreamCommandError::Cancelled)
        );
        assert_eq!((fps, bitrate), (30, 6_000_000));

        // Same for a command that arrives after its deadline.
        let calm = Arc::new(AtomicBool::new(false));
        let expired = Instant::now() - Duration::from_secs(1);
        assert_eq!(
            apply_quality_update(1, 1, &calm, expired, Some(15), Some(1_000_000), &mut fps, &mut bitrate),
            Err(StreamCommandError::DeadlineExpired)
        );
        assert_eq!((fps, bitrate), (30, 6_000_000));

        // Positive control: prove this rig CAN see a mutation when the gate
        // passes — otherwise "state unchanged" would also pass on a rig that
        // never reaches the mutation at all.
        assert_eq!(
            apply_quality_update(1, 1, &calm, deadline, Some(15), Some(1_000_000), &mut fps, &mut bitrate),
            Ok((15, 1_000_000))
        );
        assert_eq!((fps, bitrate), (15, 1_000_000));
    }

    #[test]
    fn test_invalid_generation_command_returns_generation_mismatch() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_secs(5);

        let (mut fps, mut bitrate) = (30u32, 2_000_000u32);
        assert_eq!(
            apply_quality_update(1, 99, &cancelled, deadline, Some(60), Some(6_000_000), &mut fps, &mut bitrate),
            Err(StreamCommandError::GenerationMismatch { expected: 1, actual: 99 })
        );
        assert_eq!((fps, bitrate), (30, 2_000_000), "a refused command must not touch encoder state");

        // The monitor path refuses the same way, without ever running the
        // build — a stale command must not so much as touch the capture API.
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let outcome = set_monitor_transition(1, 99, &cancelled, deadline, 1, &reply_tx, (), |_, _| {
            panic!("build must not run for a stale command")
        });
        assert!(matches!(outcome, Transition::Keep(())), "a stale command changes nothing");
        assert_eq!(
            reply_rx.recv().unwrap(),
            Err(StreamCommandError::GenerationMismatch { expected: 1, actual: 99 })
        );
    }

    #[test]
    fn a_stale_generation_is_refused_before_cancellation_or_deadline() {
        // Stale wins even when the command is also cancelled and past its
        // deadline: a command from a dead stream must never be reported as
        // merely late.
        let cancelled = Arc::new(AtomicBool::new(true));
        let expired = Instant::now() - Duration::from_secs(1);
        assert_eq!(
            command_gate(1, 99, &cancelled, expired),
            Err(StreamCommandError::GenerationMismatch { expected: 1, actual: 99 })
        );
    }

    #[test]
    fn test_reap_terminated_handles_thread_panic() {
        let (tx, _rx) = std::sync::mpsc::channel();
        let panic_handle = std::thread::spawn(|| {
            panic!("simulated stream worker crash");
        });
        let mut stream = Stream::create_for_test("s1".into(), 1, 0, panic_handle, Arc::new(AtomicBool::new(false)), tx);
        let res = stream.reap_terminated(1);
        match res {
            Err(ReapError::Panicked(msg)) => assert!(msg.contains("simulated stream worker crash")),
            other => panic!("expected Panicked error, got {other:?}"),
        }
    }

    #[test]
    fn a_secure_desktop_is_reported_once_after_a_second_not_every_tick() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();

        // Not blocked at all: a still desktop must never produce this notice,
        // or every motionless screen would claim a security prompt.
        assert!(!should_report_secure_desktop(None, false, t0 + Duration::from_secs(10)));

        // Blocked, but only briefly — alt-tabbing into a fullscreen game
        // raises AccessLost too and resolves in milliseconds.
        assert!(!should_report_secure_desktop(Some(t0), false, t0 + Duration::from_millis(300)));

        // Blocked for a second: say so.
        assert!(should_report_secure_desktop(Some(t0), false, t0 + Duration::from_millis(1000)));
        assert!(should_report_secure_desktop(Some(t0), false, t0 + Duration::from_secs(30)));

        // ONCE. The pump runs at frame rate, so without this the notice would
        // fire ~60 times a second for as long as the prompt is up.
        assert!(!should_report_secure_desktop(Some(t0), true, t0 + Duration::from_secs(30)));
    }

    #[test]
    fn the_desktop_follow_retries_instead_of_latching_once() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();

        // The 2026-08-17 invisible-PIN bug, as a rule: the first follow of a
        // blockage fires DURING the desktop switch and can attach to the
        // outgoing desktop; a follow that never retries then holds a dead
        // capture for the rest of the session. So: due immediately…
        assert!(should_follow_again(None, t0));
        // …not due again the very next frame (the pump ticks at frame rate,
        // and OpenInputDesktop per tick is a kernel call per frame)…
        assert!(!should_follow_again(Some(t0), t0 + Duration::from_millis(16)));
        assert!(!should_follow_again(Some(t0), t0 + Duration::from_millis(1_900)));
        // …but due again once the switch has had time to settle — this retry
        // is the line between "PIN box appears" and "reconnect by hand".
        assert!(should_follow_again(Some(t0), t0 + Duration::from_secs(2)));
        assert!(should_follow_again(Some(t0), t0 + Duration::from_secs(60)));
    }

    #[test]
    fn a_stuck_blockage_escalates_to_a_full_rebuild_on_its_own_clock() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();

        // Following alone gets the first five seconds — most blockages end in
        // well under that (a UAC prompt closing, a desktop switch settling),
        // and rebuilding a capture that is about to recover wastes a device.
        assert!(!should_rebuild_capture(t0, None, t0 + Duration::from_secs(4)));
        // Past that, rebuild…
        assert!(should_rebuild_capture(t0, None, t0 + Duration::from_secs(5)));
        // …but not again immediately (device creation is not free)…
        assert!(!should_rebuild_capture(
            t0,
            Some(t0 + Duration::from_secs(5)),
            t0 + Duration::from_secs(7),
        ));
        // …and again on the same cadence while the blockage persists.
        assert!(should_rebuild_capture(
            t0,
            Some(t0 + Duration::from_secs(5)),
            t0 + Duration::from_secs(10),
        ));
    }

    #[test]
    fn the_fs_worker_answers_in_request_order_with_ids_echoed() {
        // Order IS the protocol for id-less clients, so the worker being a
        // single thread is load-bearing — this pins that N requests come back
        // as N completions, in order, with each carried id echoed.
        let dir = std::env::temp_dir().join(format!("puca-fsworker-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"hello").unwrap();

        let scope = Arc::new(Mutex::new(Some(crate::file_transfer::FileScope::Jailed(
            dir.clone(),
        ))));
        let (req_tx, req_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<(u32, Option<Vec<u8>>)>();
        let worker = std::thread::spawn({
            let scope = Arc::clone(&scope);
            move || run_fs_worker(req_rx, scope, None, done_tx)
        });

        for (i, req) in [
            crate::file_transfer::FsRequest::ListRoots,
            crate::file_transfer::FsRequest::List { path: dir.to_string_lossy().into_owned() },
            crate::file_transfer::FsRequest::ListRoots,
        ]
        .into_iter()
        .enumerate()
        {
            req_tx.send((7u32, req, Some(100 + i as u64))).unwrap();
        }
        let mut got = Vec::new();
        for _ in 0..3 {
            let (cid, bytes) = done_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            assert_eq!(cid, 7);
            let v: serde_json::Value =
                serde_json::from_slice(&bytes.expect("every reply must encode")).unwrap();
            got.push(v["id"].as_u64().unwrap());
            assert_ne!(v["ok"], "error", "a granted request must not refuse: {v}");
        }
        assert_eq!(got, vec![100, 101, 102], "completions must keep request order");

        drop(req_tx);
        worker.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_fs_worker_reads_the_scope_per_request_so_revocation_is_instant() {
        let dir = std::env::temp_dir().join(format!("puca-fsworker-rev-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let scope = Arc::new(Mutex::new(Some(crate::file_transfer::FileScope::Jailed(
            dir.clone(),
        ))));
        let (req_tx, req_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<(u32, Option<Vec<u8>>)>();
        let worker = std::thread::spawn({
            let scope = Arc::clone(&scope);
            move || run_fs_worker(req_rx, scope, None, done_tx)
        });

        // POSITIVE CONTROL first: with the grant in place the request works.
        req_tx.send((1u32, crate::file_transfer::FsRequest::ListRoots, None)).unwrap();
        let (_, bytes) = done_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes.unwrap()).unwrap();
        assert_ne!(v["ok"], "error", "the rig must be able to see a grant work: {v}");

        // Revoke — the NEXT request must refuse, no reconnect needed.
        *scope.lock().unwrap() = None;
        req_tx.send((1u32, crate::file_transfer::FsRequest::ListRoots, None)).unwrap();
        let (_, bytes) = done_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes.unwrap()).unwrap();
        assert_eq!(v["ok"], "error");
        assert!(
            v["message"].as_str().unwrap_or("").contains("not been allowed"),
            "the refusal must be the grant refusal: {v}"
        );

        drop(req_tx);
        worker.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_blocked_capture_rebuild_reapplies_cursor_ownership() {
        // A rebuilt capture is born drawing the host pointer (and seeded with
        // its shape). On a session where the CONTROLLER owns the cursor, a
        // rebuild without re-applying ownership silently paints a second
        // pointer — the monitor-switch arm learned this already; this pins
        // that the rebuild arm keeps the same re-apply. Scoped to the arm's
        // own text so this test's source cannot satisfy the assertion.
        let src = include_str!("stream.rs");
        let arm = src
            .split("should_rebuild_capture(start, last_rebuild, now)")
            .nth(1)
            .expect("the rebuild arm exists");
        let arm = arm.split("Err(e) => eprintln!").next().unwrap();
        assert!(
            arm.contains("set_draw_cursor(draw_host_cursor)"),
            "the rebuild arm must re-apply cursor ownership to the fresh capture"
        );
    }

    #[test]
    fn a_still_screen_and_a_secure_desktop_are_not_the_same_thing() {
        // The regression this pair exists to catch. `should_resend_still`
        // governs a genuinely motionless desktop and must keep its exact
        // behaviour; the secure-desktop notice is a SEPARATE axis, and
        // collapsing the two is what made a UAC prompt indistinguishable from
        // a screen nobody was touching.
        assert!(!should_resend_still(false, true), "no keyframe wanted: stay free");
        assert!(should_resend_still(true, true), "keyframe outstanding: re-send");
        assert!(!should_resend_still(true, false), "nothing held to re-send");
    }
}
