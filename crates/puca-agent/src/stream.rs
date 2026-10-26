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

/// Why a video stream ends when its display never produced a first frame.
///
/// A named constant, not an inline string, because the session layer matches
/// on it: the reap path (session.rs) remembers a stream that ended THIS way so
/// `SessionStatus` can tell the app not to restart it — a restart cannot wake
/// a sleeping panel, and it would replace the viewer's own "screens may be
/// asleep" deadline message with a generic "could not be re-established".
pub const NO_FRAME_EVER_REASON: &str =
    "no frame ever arrived from the display — the screens on that computer appear to be asleep and did not wake";

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
    /// The stream's capture now shows `monitor`: EVERY change it commits, in
    /// commit order. A switch the agent asked for, a rebuild, or a move the
    /// stream made itself: off a built-in panel behind a lid that closed
    /// mid-session (and back once it opened), or a topology rebuild's remap,
    /// for which it has already re-aimed input. The agent's books follow
    /// (session.rs `follow_stream`), and the app reads them back through
    /// `SessionStatus.monitor`, so the viewer can be told.
    Moved {
        session_id: String,
        generation: u64,
        monitor: usize,
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
    /// Rebuild the capture from scratch against a FRESH output enumeration,
    /// on `monitor` (which the caller has already remapped if the old index
    /// vanished). The display-topology lever: a detach/reattach re-numbers
    /// outputs and usually kills the live duplication, and neither the
    /// per-tick rebuild (same index) nor the blockage escalation (a composite
    /// with one live tile is not blocked) covers that.
    RebuildCapture {
        generation: u64,
        deadline: Instant,
        cancelled: Arc<AtomicBool>,
        monitor: usize,
        reply_tx: std::sync::mpsc::Sender<Result<(), StreamCommandError>>,
        /// Who asked, which decides how the rebuild is done and who aims
        /// input at the new screen. Either way the commit is reported
        /// (`StreamEvent::Moved`), and the agent's books follow it.
        why: RebuildFor,
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
    /// The viewer's stage, in its device pixels, or 0x0 for native. Fire-and-
    /// forget like SetDrawCursor: late costs one frame at the old size, twice
    /// is idempotent, and the step is re-derived per frame from the picture
    /// the capture actually produced (a monitor switch changes it).
    SetViewSize { width: u32, height: u32 },
}

/// A move the lid watch sent (`RebuildFor::Lid`), until its reply lands.
struct LidMove {
    target: usize,
    /// The target is the virtual screen: a move there that keeps failing
    /// ends the stream naming it.
    to_virtual: bool,
    /// What the stream is asked for once the move lands (`after_lid_move`),
    /// decided with the displays the move was decided on.
    asked: Option<crate::virtual_screen::Asked>,
    /// The viewer's switches when it was decided: one made since wins.
    switches: u64,
    reply: std::sync::mpsc::Receiver<Result<(), StreamCommandError>>,
}

/// Who asked for a capture rebuild (`StreamCommand::RebuildCapture`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RebuildFor {
    /// The agent (`rebuild_capture_sync`, a display-topology poke): its
    /// handler aims input and moves its books after the reply.
    App,
    /// The stream's own topology self-heal: the stream aims input.
    SelfHeal,
    /// The stream's lid watch, decided when the viewer's switches numbered
    /// `switches`. A switch the viewer made since wins: the rebuild is
    /// dropped (`Cancelled`), since it was decided on a screen the viewer has
    /// left. Quick, on the stream's own thread: one build, the current
    /// capture released first only when it holds the screen the build needs,
    /// and no wait; the lid watch backs off and tries again itself.
    Lid { switches: u64 },
}

/// The screens the agent's books give to OTHER captures, as a stream thread
/// reads them: each reserved monitor with the session whose stream holds it,
/// and None for a raw capture. The agent publishes them after every request
/// (session.rs `publish_held`); a stream moving itself for the lid never takes
/// one, as StartStream would refuse to. Capture duplication is exclusive per
/// output, so taking one would fail anyway, after dropping the stream's own.
#[derive(Clone, Default)]
pub struct HeldScreens(Arc<Mutex<Vec<(usize, Option<String>)>>>);

impl HeldScreens {
    pub fn set(&self, held: Vec<(usize, Option<String>)>) {
        if let Ok(mut h) = self.0.lock() {
            *h = held;
        }
    }

    /// The screens held by anything but `session_id`'s own stream.
    pub fn others(&self, session_id: &str) -> Vec<usize> {
        self.0
            .lock()
            .map(|h| {
                h.iter()
                    .filter(|(_, by)| by.as_deref() != Some(session_id))
                    .map(|(m, _)| *m)
                    .collect()
            })
            .unwrap_or_default()
    }
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

    /// Rebuild this stream's capture for a display-topology change (see
    /// StreamCommand::RebuildCapture). `monitor` must already be valid
    /// against the NEW enumeration — the caller does the remap.
    pub fn rebuild_capture_sync(&self, monitor: usize, timeout: Duration) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + timeout;
        self.command_tx.send(StreamCommand::RebuildCapture {
            generation: self.generation,
            deadline,
            cancelled: cancelled.clone(),
            monitor,
            reply_tx: tx,
            why: RebuildFor::App,
        }).map_err(|_| "stream dead")?;
        match rx.recv_timeout(timeout) {
            Ok(res) => res.map_err(|e| format!("{e:?}")),
            Err(_) => {
                cancelled.store(true, Ordering::Relaxed);
                // The loop may be mid-build; a commit that lands a beat late
                // must still move the caller's books (reservations, session
                // record, input aim) — switch_monitor_sync's rule, for the
                // same drift reason.
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(res) => res.map_err(|e| format!("{e:?}")),
                    Err(_) => Err("timeout".to_string()),
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

    /// Tell the stream how large the viewer is showing it (device pixels;
    /// 0x0 = native). Fire-and-forget for the reasons on the command.
    pub fn set_view_size(&self, width: u32, height: u32) {
        let _ = self.command_tx.send(StreamCommand::SetViewSize { width, height });
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
///
/// Never longer than [`SCTP_SEND_BUDGET`]: see [`admit_fs_reply`].
fn encode_fs_reply(resp: &crate::file_transfer::FsResponse, req_id: Option<u64>) -> Option<Vec<u8>> {
    encode_fs_reply_unchecked(resp, req_id).map(admit_fs_reply)
}

fn encode_fs_reply_unchecked(
    resp: &crate::file_transfer::FsResponse,
    req_id: Option<u64>,
) -> Option<Vec<u8>> {
    let mut v = serde_json::to_value(resp).ok()?;
    if let (Some(id), Some(obj)) = (req_id, v.as_object_mut()) {
        obj.insert("id".to_string(), serde_json::Value::from(id));
    }
    serde_json::to_vec(&v).ok()
}

/// The longest data-channel message str0m will EVER accept: its send budget
/// shared across all streams (`MAX_BUFFERED_ACROSS_STREAMS`, 128 KiB in
/// 0.23). `Channel::write` answers `Ok(false)` — "no room yet" — for anything
/// longer on every attempt, forever; it does not fragment.
const SCTP_SEND_BUDGET: usize = 128 * 1024;

/// A file reply that can NEVER be sent becomes one that can: an error
/// carrying the same id. Everything else passes through untouched.
///
/// THE WEDGE THIS PREVENTS. The flush below treats `Ok(false)` as "retry next
/// pass" and never pops the head, so a reply longer than the send budget sat
/// at the head of the FIFO forever and every later file reply in the session
/// queued behind it — a big folder listing (230–380 KB at the old 5,000-entry
/// cap) broke Up, Refresh, downloads and uploads until the session died, with
/// the controller seeing only 15 s timeouts. The List arm now stays under
/// `LIST_REPLY_BUDGET`, so this should never fire; it is here so that no
/// future reply shape can wedge the queue again, and it says so in the log
/// when it does.
///
/// The id is read back out of the bytes rather than passed in, so the flush
/// can apply the same rule to whatever is at the head of its queue.
fn admit_fs_reply(bytes: Vec<u8>) -> Vec<u8> {
    if bytes.len() <= SCTP_SEND_BUDGET {
        return bytes;
    }
    let id = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.get("id").and_then(|i| i.as_u64()));
    eprintln!(
        "[stream] a {}-byte file reply can never fit one data-channel write ({SCTP_SEND_BUDGET} max); \
         answering {} with an error instead",
        bytes.len(),
        id.map_or_else(|| "an id-less request".to_string(), |i| format!("request {i}")),
    );
    encode_fs_reply_unchecked(
        &crate::file_transfer::FsResponse::error(
            "that answer was too large to send over the connection",
        ),
        id,
    )
    // Serialising a short error cannot fail; if it somehow did, an empty
    // frame still unblocks the queue, which is the point.
    .unwrap_or_default()
}

/// Drain queued file replies head-first through `write`, which answers like
/// str0m's `Channel::write`: `Some(Ok(true))` sent, `Some(Ok(false))` no room
/// yet, `Some(Err(_))` failed, and `None` when the channel is gone. Stops at
/// the first "no room": the queue is FIFO, and order is the matching rule for
/// id-less clients.
///
/// "No room" means "retry next pass" — which, for a reply longer than str0m's
/// whole send budget, is FOREVER, with every later reply stuck behind it. No
/// producer should enqueue one (both go through `encode_fs_reply`), but the
/// head is where a wedge would happen, so the head is passed through
/// [`admit_fs_reply`] here too. Pure over the writer so that rule is tested
/// against a stand-in that refuses exactly what str0m refuses.
fn flush_fs_replies<C: Copy>(
    queue: &mut std::collections::VecDeque<(C, Vec<u8>)>,
    mut write: impl FnMut(C, &[u8]) -> Option<Result<bool, String>>,
) {
    while let Some((cid, bytes)) = queue.front_mut() {
        if bytes.len() > SCTP_SEND_BUDGET {
            *bytes = admit_fs_reply(std::mem::take(bytes));
        }
        match write(*cid, bytes) {
            None | Some(Ok(true)) => {
                queue.pop_front();
            }
            Some(Ok(false)) => break, // still no room; next pass
            Some(Err(e)) => {
                eprintln!("[stream] fs reply failed: {e}");
                queue.pop_front();
            }
        }
    }
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
    // The screen asked for, when StartStream steered off a dark panel onto
    // `monitor` (virtual_screen::steer_monitor); None when it did not.
    steered_from: Option<usize>,
    fps: u32,
    bitrate: u32,
    // The viewer's stage in its device pixels, or (0, 0) for native. See
    // protocol::StartStream — carried so a media restart keeps the fit.
    view: (u32, u32),
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
    // The host app can follow a move to another screen, and asks the person
    // at the host about it: the stream may steer for the lid. Off (the
    // default, and every older host app), it never leaves its screen
    // (virtual_screen.rs `pinned_step`).
    steer_on_lid: bool,
    // The screens other captures hold, for a move the stream makes itself.
    held: HeldScreens,
) -> Result<Stream, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("could not bind a socket: {e}"))?;
    let local_addr = socket
        .local_addr()
        .map_err(|e| format!("could not read the local address: {e}"))?;

    let mut sender = VideoSender::new();
    let mut count = 0;
    // The peer's own candidates decide which local addresses are worth
    // advertising — see local_interfaces. The offer is already in hand here
    // (this side always answers), so no extra round trip is needed.
    let peer_addrs = remote_candidate_addrs(offer_sdp);
    let interfaces = local_interfaces(local_addr.port(), &peer_addrs);
    for addr in &interfaces {
        if sender.add_local_candidate(*addr).is_ok() {
            count += 1;
        }
    }
    if count == 0 {
        return Err("no usable local network interface to advertise".to_string());
    }

    // The base for reflexive/relayed candidates is the address those packets
    // really leave from — the DEFAULT route — not whichever host candidate
    // happens to lead the list now that a peer-routed LAN address can.
    let base = default_route_addr()
        .map(|ip| SocketAddr::new(ip, local_addr.port()))
        .or_else(|| interfaces.iter().find(|a| !a.ip().is_loopback()).copied())
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

    // NAME the host candidates. "2 host" hid the whole defect above for weeks:
    // the count was right and both addresses were useless to the peer.
    eprintln!(
        "[stream] ice: {count} host [{}], {srflx_count} reflexive (base {}) - {}",
        interfaces
            .iter()
            .map(|a| a.ip().to_string())
            .collect::<Vec<_>>()
            .join(", "),
        base.ip(),
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
    // The loop's own sender, for the display-topology self-heal to re-enter
    // the RebuildCapture path. Cloned before the spawn takes command_rx; the
    // original command_tx still goes to the Stream handle below.
    let self_tx = command_tx.clone();

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
            // Counted live for the virtual screen's holder, which keeps a
            // session's hold only while it streams. The guard below uncounts
            // it, on every way out of this thread.
            crate::virtual_screen::stream_started(&session_id_clone);
            let _guard = TerminatedGuard {
                session_id: session_id_clone,
                generation,
                stream_events_tx: stream_events_tx_clone,
                reason: Arc::clone(&reason_cell),
            };
            if let Err(e) = run(sender, socket, advertised, relay, relayed_addr, remote_thread, monitor, steered_from, fps, bitrate, view, mode, stop_thread, command_rx, self_tx, generation, file_scope_thread, audit, stream_events_run, session_id_run, input_channel, steer_on_lid, held) {
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
        crate::virtual_screen::stream_ended(&self.session_id);
    }
}

/// The local address the OS would send from to reach `dest`, if any.
///
/// A connected UDP socket performs no I/O — `connect` on a datagram socket only
/// fixes the peer and runs the routing table — so this is a pure route lookup
/// with no packet and no dependency.
fn source_addr_for(dest: SocketAddr) -> Option<std::net::IpAddr> {
    if !dest.is_ipv4() {
        // The stream socket is bound to 0.0.0.0, so a v6 candidate could never
        // be sent from it; advertising one would only waste connectivity checks.
        return None;
    }
    let probe = UdpSocket::bind("0.0.0.0:0").ok()?;
    probe.connect(dest).ok()?;
    let ip = probe.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}

/// Every local address worth advertising as an ICE host candidate, given the
/// addresses the PEER offered.
///
/// `peers` is what makes this correct on a multi-homed machine. This used to be
/// one probe — the route to 8.8.8.8 — plus loopback, which silently assumed the
/// default route leaves by the same interface the peer is on. **A VPN breaks
/// that assumption completely.** With a tunnel holding the default route the
/// probe returns the tunnel's own address (measured on the developer's machine:
/// 10.169.229.126 while the phone on the same LAN was reachable only via
/// 192.168.0.22), so the agent advertised a host candidate no peer on Earth
/// could reach, plus loopback. The LAN pair — the highest-priority pair there
/// is, and a 2 ms round trip — could then never form, and the session fell back
/// to the peer's TURN relay: every frame of a remote-control session between two
/// devices in the same room went out to the relay and back, measured at 99 ms
/// RTT with 3% loss against 2-7 ms direct.
///
/// Asking the routing table "what would I send from, to reach THIS peer" answers
/// it exactly, for a VPN, a second NIC, a virtual adapter or a plain LAN, without
/// enumerating interfaces (which needs a platform API per target) and without
/// guessing at private ranges. The socket is bound to 0.0.0.0, so every address
/// returned here really can send: the OS picks the source per destination.
fn local_interfaces(port: u16, peers: &[SocketAddr]) -> Vec<SocketAddr> {
    collect_candidates(port, peers, source_addr_for, default_route_addr)
}

/// The candidate list itself, with the routing table injected.
///
/// Split from `local_interfaces` so the defect above is testable: the real
/// probe answers whatever THIS machine's routes say, so a test written against
/// it asserts nothing (the first attempt passed just as happily with the peer
/// probe deleted, because loopback is appended unconditionally). With `route`
/// supplied, the VPN case is reproducible anywhere.
fn collect_candidates(
    port: u16,
    peers: &[SocketAddr],
    route: impl Fn(SocketAddr) -> Option<std::net::IpAddr>,
    default_route: impl Fn() -> Option<std::net::IpAddr>,
) -> Vec<SocketAddr> {
    let mut out: Vec<SocketAddr> = Vec::new();
    let mut push = |ip: std::net::IpAddr, out: &mut Vec<SocketAddr>| {
        let addr = SocketAddr::new(ip, port);
        if !out.contains(&addr) {
            out.push(addr);
        }
    };

    // The route to each address the peer offered. First, so a LAN address leads
    // the candidate list when the peer is local.
    for peer in peers {
        if let Some(ip) = route(*peer) {
            if !ip.is_loopback() && !ip.is_unspecified() {
                push(ip, &mut out);
            }
        }
    }
    // The default route as well: the peer may be somewhere none of its offered
    // candidates reach directly, and this is the address a relay or a reflexive
    // candidate is based on.
    if let Some(ip) = default_route() {
        if !ip.is_unspecified() {
            push(ip, &mut out);
        }
    }
    push(std::net::IpAddr::from([127, 0, 0, 1]), &mut out);
    out
}

/// The host candidate a newly-arrived PEER address argues for, if any.
///
/// `None` when the peer is unroutable, when the route is loopback or the
/// wildcard, or when that address is already advertised. Pure so the trickle
/// path is testable: the run loop it lives in needs a live session.
fn peer_routed_candidate(
    peer: SocketAddr,
    advertised: &[SocketAddr],
    port: u16,
    route: impl Fn(SocketAddr) -> Option<std::net::IpAddr>,
) -> Option<SocketAddr> {
    let ip = route(peer)?;
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    let local = SocketAddr::new(ip, port);
    (!advertised.contains(&local)).then_some(local)
}

/// The address the OS uses for the general internet. This is the base a
/// server-reflexive or relayed candidate is really sent from, so it stays the
/// base even when a peer-routed LAN address leads the host-candidate list.
fn default_route_addr() -> Option<std::net::IpAddr> {
    source_addr_for(SocketAddr::from(([8, 8, 8, 8], 80)))
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
    // Grows during the session: a host candidate is added for each peer address
    // that turns out to be reachable from an interface not already offered.
    mut advertised: Vec<SocketAddr>,
    mut relay: Option<crate::turn::Allocation>,
    relayed_addr: Option<SocketAddr>,
    remote_candidates: Arc<Mutex<Vec<String>>>,
    initial_monitor: usize,
    // The screen StartStream was asked for, when it steered the stream off a
    // built-in panel behind a closed lid onto `initial_monitor`: what to go
    // back to once the lid opens (`LidWatch::asked`).
    steered_from: Option<usize>,
    initial_fps: u32,
    initial_bitrate: u32,
    initial_view: (u32, u32),
    mode: StreamMode,
    stop: Arc<AtomicBool>,
    command_rx: std::sync::mpsc::Receiver<StreamCommand>,
    // A clone of the loop's OWN command sender, so the display-topology
    // self-heal can drive the existing RebuildCapture path rather than carry a
    // second copy of the rebuild. Only ever used to send to this same loop.
    self_tx: std::sync::mpsc::Sender<StreamCommand>,
    generation: u64,
    file_scope: Arc<Mutex<Option<crate::file_transfer::FileScope>>>,
    audit: Option<crate::file_log::FileAudit>,
    events_tx: std::sync::mpsc::Sender<StreamEvent>,
    session_id: String,
    // R4: Some = this stream may serve the direct input channel (see start()).
    input_channel: Option<std::sync::Arc<crate::input_wire::InputChannel>>,
    // May the stream move to another screen for the lid (see start()).
    steer_on_lid: bool,
    // The screens other captures hold, which a lid move passes over.
    held_screens: HeldScreens,
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
    // What that channel delivered, by kind, logged about once a second while
    // it flows ("[input-rx] lane=channel ..."): the only host-side record of
    // input that ARRIVED and was accepted, rather than refused.
    let mut input_tally = crate::input_tally::InputTally::new("channel");
    // A refused frame or injection on this channel is logged at most once a
    // second, the first always, and an injection's without its kind
    // (`session::inject_failure_line`): one line per refused keystroke
    // counted a PIN on the sign-in screen.
    let mut inject_error_log = puca_input::log_privacy::LineGate::per_second();
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
    // The viewer's stage in its device pixels, or None for native. Seeded from
    // StartStream (a media restart carries it forward), moved by SetViewSize.
    let mut view_size: Option<(u32, u32)> = match initial_view {
        (0, _) | (_, 0) => None,
        v => Some(v),
    };
    // The fit across frames: the step in force, its hysteresis, the reused
    // buffer and the cost guard. See composite::FitState.
    let mut fit = crate::composite::FitState::new();
    // Displays wake before the capture opens and stay awake for the session.
    // A panel in DPMS-off presents nothing to DXGI — creation "succeeds" and
    // then no frame ever arrives (the black-stage-forever field report), and
    // on some topologies the output detaches and creation fails outright.
    // The hold is per-thread RAII: released when this thread exits, which IS
    // The port every host candidate carries: one wildcard-bound socket serves
    // them all, so a candidate added mid-session reuses it.
    let bound_port = socket.local_addr().map(|a| a.port()).unwrap_or(0);

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
    // Catching an input's change (latency.rs): until when to watch for it,
    // when the last frame was ENCODED (the floor under any early frame: the
    // encoder's per-frame budget is what it protects), and the latency probe
    // waiting for its frame.
    let mut watching_until: Option<Instant> = None;
    let mut last_frame_at: Option<Instant> = None;
    let mut probe: Option<crate::latency::Probe> = None;
    // When the viewer was last told that a typed-text frame was refused.
    let mut last_refusal_report: Option<Instant> = None;
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
    // Baseline for the display-topology self-heal: the output enumeration the
    // capture above was built against. The pump loop compares the live
    // enumeration to this on a slow clock and self-rebuilds when they diverge
    // (a monitor detaching after an idle sleep, a GPU re-adding outputs on
    // wake). Refreshed after every (re)build/switch so it only ever fires on a
    // genuine change.
    let built_outs = puca_capture::outputs();
    let mut built_output_sig: crate::topology::OutputSig =
        crate::topology::outputs_signature(&built_outs);
    // Which physical screen current_monitor is (its HMONITOR), because the
    // index alone is a position that another screen can shift into. Kept in
    // step with current_monitor by adopt_new_capture, and read from the
    // CAPTURE (`screen`), never from an enumeration: the two can already
    // disagree, and a pinned stream checks every picture against this.
    let mut current_output: Option<isize> = capture.as_ref().and_then(|c| c.screen());
    let mut topology_checked: Option<Instant> = None;
    let mut pump_stats = PumpStats::default();
    let started_at = Instant::now();
    // The last picture captured from a single screen, kept so a still desktop
    // can still feed a freshly rebuilt encoder, and so a switch into All
    // Displays can bring it along as that screen's tile.
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
    // While the viewer draws the pointer itself (draw_host_cursor off), which
    // SHAPE the host is showing, said on the caret channel when it changes
    // (pointer_shape.rs).
    let mut shape_reporter = crate::pointer_shape::ShapeReporter::default();
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
    // A switch whose destination screen stands still gets its picture from a
    // provoked repaint (repaint.rs); how many this switch has asked for, and
    // when the last one was.
    let mut stranded_repaints: u8 = 0;
    let mut stranded_repainted_at: Option<Instant> = None;
    // THE LID, MID-SESSION (virtual_screen.rs, "mid-session"): what this
    // stream last saw of the lid and when to look again (`LidWatch`), a move
    // it asked for until its reply lands, a `prepare` running on its own
    // thread (it may ask the service for the virtual screen, which can take a
    // second) until it answers, and the last thing each said, so the log says
    // each once.
    let mut lid_watch = crate::virtual_screen::LidWatch::new(
        Instant::now(),
        crate::lid::closed(),
        // A pinned stream never goes back to it either: that is a move too.
        steered_from
            .filter(|_| steer_on_lid)
            .map(|m| crate::virtual_screen::Asked::of(m, crate::composite::ALL_DISPLAYS)),
    );
    let mut lid_move: Option<LidMove> = None;
    let mut lid_prepare: Option<std::sync::mpsc::Receiver<crate::virtual_screen::ScreenState>> = None;
    let mut lid_prepare_said: Option<crate::virtual_screen::ScreenState> = None;
    // Whether this lid episode (from a lid change until a move lands) has
    // asked for a screen yet, and whether that brought the virtual screen
    // into it: the first ask starts afresh (`prepare_anew`), and a move that
    // keeps failing then names the virtual screen in the end it gives.
    let mut lid_asking = false;
    let mut lid_virtual_asked = false;
    // The viewer's switches so far. A lid move decided before the latest one
    // was decided on a screen the viewer has left, and is dropped
    // (`RebuildFor::Lid`).
    let mut switch_count: u64 = 0;
    // A capture lost while the lid moved the desktop, said once per loss.
    let mut capture_loss_said = false;
    // The topology self-heal held back from another screen (`heal_target`),
    // said once until it rebuilds again.
    let mut heal_held_back_said = false;
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
        flush_fs_replies(&mut pending_fs_replies, |cid, bytes| {
            // `None` = the channel is gone; there is nobody to deliver to.
            let mut c = sender.rtc_mut().channel(cid)?;
            Some(c.write(false, bytes).map_err(|e| e.to_string()))
        });
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
                            Ok(()) => {
                                // Still the viewer's choice (see the commit).
                                lid_watch.asked = None;
                                switch_count += 1;
                                let _ = reply_tx.send(Ok(()));
                            }
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
                            // To the composite: hand it the screen we hold,
                            // AND the last picture that screen delivered. Its
                            // duplication has already handed that picture
                            // over, so on a still screen it has nothing new
                            // for the composite, whose tile would be black
                            // until the screen repainted. MOVED in (the very
                            // buffer its pointer is drawn on, `adopt`), so
                            // adopt_new_capture below finds nothing held; a
                            // refused switch hands it back with the capture,
                            // and keeps streaming with both.
                            (crate::composite::ALL_DISPLAYS, AnyCapture::Single(sc)) => {
                                VirtualCapture::adopt(from_monitor, sc, last_frame.take())
                                    .map(AnyCapture::Virtual)
                                    .map_err(|(sc, held, e)| {
                                        last_frame = held;
                                        (AnyCapture::Single(sc), e.to_string())
                                    })
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
                            //
                            // This also moves current_monitor onto the target,
                            // and current_output onto the screen the new
                            // capture itself reports.
                            let outs = puca_capture::outputs();
                            adopt_new_capture(
                                &mut current_monitor,
                                &mut current_output,
                                target_monitor,
                                capture.as_ref().and_then(|c| c.screen()),
                                &mut last_frame,
                                &mut want_keyframe,
                                &mut switch_started,
                                &mut stranded_repaints,
                                &mut stranded_repainted_at,
                                Instant::now(),
                            );
                            // The viewer chose this screen: it is the one the
                            // stream is asked for now, whatever the lid had
                            // moved it off before, and a lid move decided
                            // before this choice is dropped when it comes up
                            // (`RebuildFor::Lid`): the viewer's choice wins.
                            lid_watch.asked = None;
                            switch_count += 1;
                            eprintln!("[switch] capture committed -> monitor {target_monitor}");
                            // In commit order with any move the stream made
                            // itself, so the agent's books end on this one.
                            let _ = events_tx.send(StreamEvent::Moved {
                                session_id: session_id.clone(),
                                generation,
                                monitor: target_monitor,
                            });
                            // OUT OF THE COMPOSITE the taken tile's duplication
                            // has long delivered its pictures, and a still
                            // destination screen presents nothing more, so the
                            // stream holds nothing to re-send: on 2026-09-21
                            // two phone sessions sat at "150 consecutive
                            // skips" from this line until they were torn down,
                            // every click landing on a frozen picture. A
                            // provoked repaint makes the compositor present
                            // (repaint.rs); the net below repeats it if the
                            // first one is missed.
                            #[cfg(windows)]
                            if from_monitor == crate::composite::ALL_DISPLAYS {
                                crate::repaint::provoke_present(target_monitor);
                            }
                            // A switch re-enumerates DXGI too; refresh the
                            // self-heal baseline so it is not tripped by the
                            // switch we just performed.
                            built_output_sig = crate::topology::outputs_signature(&outs);
                            topology_checked = Some(Instant::now());
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
                StreamCommand::RebuildCapture { generation: gen, deadline, cancelled, monitor: target_monitor, reply_tx, why } => {
                    // Gated on the MODE, not on holding a capture: a VIDEO
                    // stream whose previous rebuild failed sits at capture ==
                    // None, and this command is exactly its way back (the
                    // reattach fires another topology poke). Only a data-only
                    // session genuinely has no screen to rebuild.
                    if matches!(mode, StreamMode::DataOnly) {
                        let _ = reply_tx.send(Err(StreamCommandError::ConstructionFailed(
                            "this session has no screen to rebuild".to_string(),
                        )));
                        continue;
                    }
                    if let Err(e) = command_gate(generation, gen, &cancelled, deadline) {
                        let _ = reply_tx.send(Err(e));
                        continue;
                    }
                    // THE VIEWER'S CHOICE WINS. A lid move queued just before
                    // a switch the viewer asked for was decided on the screen
                    // the viewer has since left; carried out after it, it took
                    // the picture off the screen the viewer had just chosen.
                    if !rebuild_still_wanted(why, switch_count) {
                        let _ = reply_tx.send(Err(StreamCommandError::Cancelled));
                        continue;
                    }
                    // PINNED: never to another index, whoever asks. The agent's
                    // own remap after a topology change (`App`) goes by index,
                    // and the host app's consent is by index too.
                    let pinned = is_pinned(steer_on_lid, current_monitor);
                    if pinned && target_monitor != current_monitor {
                        eprintln!(
                            "[stream] not rebuilding {} as {}: it shows no screen but its own (steer_on_lid)",
                            screen_name(current_monitor),
                            screen_name(target_monitor)
                        );
                        let _ = reply_tx.send(Err(StreamCommandError::ConstructionFailed(
                            "this stream shows no screen but its own".to_string(),
                        )));
                        continue;
                    }
                    let build = |m: usize| -> Result<AnyCapture, String> {
                        if m == crate::composite::ALL_DISPLAYS {
                            VirtualCapture::new().map(AnyCapture::Virtual).map_err(|e| e.to_string())
                        } else {
                            ScreenCapture::new(m).map(AnyCapture::Single).map_err(|e| e.to_string())
                        }
                    };
                    let fresh = match why {
                        // QUICK, for the lid: one build, with no wait. The
                        // capture held is let go first only when the build
                        // needs a screen it duplicates; otherwise a build that
                        // fails leaves the stream as it was. The lid watch
                        // backs off, passes the screen over and gives up into
                        // a named end by itself: this used to be up to three
                        // builds and a 250 ms sleep on this thread, every half
                        // second, for as long as the screen refused.
                        RebuildFor::Lid { .. } => {
                            let held = capture.as_ref().map(|c| matches!(c, AnyCapture::Virtual(_)));
                            let target_output = screen_identity(&puca_capture::outputs(), target_monitor);
                            if lid_rebuild_releases_first(target_monitor, target_output, held, current_output) {
                                capture = None;
                            }
                            build(target_monitor)
                        }
                        // Build fresh FIRST: after a topology change the old
                        // duplication is normally dead, so there is no
                        // exclusivity collision. If it IS still healthy (a
                        // reattach that left this output alone), the fresh
                        // build fails on exclusivity — release ours and try
                        // once more. No silent retarget on failure: the session
                        // layer chose `monitor` and keeps its records against
                        // it, and a stream that quietly lands on a different
                        // screen than the agent's books is the exact drift
                        // class SetMonitor's CommittedLate exists to prevent.
                        RebuildFor::App | RebuildFor::SelfHeal => build(target_monitor).or_else(|first| {
                            capture = None;
                            build(target_monitor)
                                .map_err(|second| format!("{first}; after releasing the old capture: {second}"))
                        }).or_else(|both| {
                            // Right after SetDisplayConfig the desktop is still
                            // recomposing and DXGI can answer with exactly the
                            // transient states the capture layer documents
                            // (is_transient_display_state); one short beat is
                            // usually all they need, and this thread has
                            // nothing to pump while its capture is gone anyway.
                            std::thread::sleep(Duration::from_millis(250));
                            build(target_monitor).map_err(|third| format!("{both}; after 250ms: {third}"))
                        }),
                    };
                    match fresh {
                        // BUILT BY INDEX, CHECKED BY HANDLE. The outputs can be
                        // renumbered between deciding a rebuild and building it,
                        // so for a PINNED stream the capture's own answer
                        // (`screen`) decides: another screen at its index ends
                        // the stream, and is never adopted.
                        Ok(next)
                            if !rebuilt_capture_accepted(
                                pinned,
                                current_monitor,
                                current_output,
                                target_monitor,
                                next.screen(),
                            ) =>
                        {
                            drop(next);
                            let _ = reply_tx.send(Err(StreamCommandError::ConstructionFailed(
                                "the rebuilt capture shows another screen".to_string(),
                            )));
                            let code = changed_end(lid_watch.lid_changed_recently(Instant::now()), false);
                            eprintln!(
                                "[stream] the capture rebuilt for {} shows another screen (the outputs were \
                                 renumbered); not adopted, and the stream ends ({code}) (steer_on_lid)",
                                screen_name(current_monitor)
                            );
                            return Err(code.to_string());
                        }
                        Ok(next) => {
                            capture = Some(next);
                            // A fresh capture is born drawing the host pointer;
                            // re-apply ownership exactly as a switch does.
                            if let Some(c) = capture.as_mut() {
                                c.set_draw_cursor(draw_host_cursor);
                            }
                            // The encoder goes with it — the surface's size
                            // has usually just changed, and the replacement
                            // sizes itself from the next frame.
                            encoder = None;
                            // A remap onto another screen is a switch (drop
                            // the held picture, arm the stranded-switch net),
                            // a rebuild of the same screen keeps its picture.
                            // "Another screen" includes one that shifted into
                            // the same index because the streamed output
                            // detached (is_same_screen). This also moves
                            // current_monitor onto the target.
                            let outs = puca_capture::outputs();
                            adopt_new_capture(
                                &mut current_monitor,
                                &mut current_output,
                                target_monitor,
                                capture.as_ref().and_then(|c| c.screen()),
                                &mut last_frame,
                                &mut want_keyframe,
                                &mut switch_started,
                                &mut stranded_repaints,
                                &mut stranded_repainted_at,
                                Instant::now(),
                            );
                            // What the lid asked for. A lid move's is settled
                            // by the lid watch when this reply lands, from the
                            // displays the move was decided on. Any other
                            // rebuild asks for nothing, and one that lands
                            // back on what the lid asked for has it again: a
                            // desktop whose screen was remapped (no lid) used
                            // to move itself back by index once the screen
                            // returned, as if a lid had opened.
                            if !matches!(why, RebuildFor::Lid { .. }) && lid_watch.asked.is_some() {
                                lid_watch.asked = crate::virtual_screen::after_other_rebuild(
                                    lid_watch.asked,
                                    target_monitor,
                                    &crate::virtual_screen::displays(),
                                    crate::composite::ALL_DISPLAYS,
                                );
                            }
                            // Rebuilt against the current enumeration: reset the
                            // self-heal baseline so it does not immediately fire
                            // again on the change that prompted this rebuild.
                            built_output_sig = crate::topology::outputs_signature(&outs);
                            topology_checked = Some(Instant::now());
                            match why {
                                RebuildFor::Lid { .. } => eprintln!("[lid] capture rebuilt -> monitor {target_monitor}"),
                                _ => eprintln!("[stream] capture rebuilt for a display-topology change -> monitor {target_monitor}"),
                            }
                            // A rebuild the STREAM chose (the lid, the
                            // self-heal) has nobody else to aim input: it is
                            // aimed here at once, so the very next click lands
                            // on the screen the viewer now sees. The agent's
                            // books follow every change this loop commits
                            // (session.rs `follow_stream`), and the app reads
                            // them back (SessionStatus `monitor`).
                            if why != RebuildFor::App {
                                crate::session::Agent::aim_input_at(&session_id, target_monitor);
                            }
                            let _ = events_tx.send(StreamEvent::Moved {
                                session_id: session_id.clone(),
                                generation,
                                monitor: target_monitor,
                            });
                            // The SAME caret is a different fraction of a
                            // different surface — same bookkeeping as a switch.
                            caret_surf += 1;
                            if caret_tracker.is_some() {
                                caret_surface = capture
                                    .as_ref()
                                    .and_then(|c| c.caret_surface(current_monitor));
                                caret_geometry_checked = Some(Instant::now());
                                caret_last_sent = None;
                            }
                            let _ = reply_tx.send(Ok(()));
                        }
                        Err(e) => {
                            // The old capture may be gone (released for the
                            // retry) and the pump skips while it is None — but
                            // NOT permanently: the mode-based guard above lets
                            // the next RebuildCapture (the reattach's topology
                            // poke fires one) revive this stream. Loud, not
                            // silent, in the meantime. A lid move's failure is
                            // the lid watch's to say, once (it retries).
                            if !matches!(why, RebuildFor::Lid { .. }) {
                                eprintln!("[stream] topology rebuild FAILED, the picture is frozen until the next rebuild: {e}");
                            }
                            let _ = reply_tx.send(Err(StreamCommandError::ConstructionFailed(e)));
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
                StreamCommand::SetViewSize { width, height } => {
                    let next = if width == 0 || height == 0 { None } else { Some((width, height)) };
                    if next != view_size {
                        match next {
                            Some((w, h)) => eprintln!("[stream] viewer stage -> {w}x{h} device px"),
                            None => eprintln!("[stream] viewer stage -> native (no fit)"),
                        }
                        // The fit is decided on a pumped picture, and a still
                        // screen pumps none: zooming in over a static desktop
                        // never sharpened until something on it repainted.
                        // Ask the pump to re-send the held picture instead.
                        fit.stage_changed();
                    }
                    view_size = next;
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
                    // A viewer that has just taken the pointer needs its shape
                    // at once, not at the next change.
                    shape_reporter.reset();
                    // The retained still-frame holds the OLD cursor baked into
                    // its pixels, and a motionless desktop re-encodes exactly
                    // that frame. It used to be DROPPED here, which on a still
                    // screen left nothing to re-send at all (a pointer-only
                    // update is not a picture), so the stream froze until the
                    // desktop repainted by itself. The capture can repaint the
                    // pointer on a repeated frame since 0.9.816, so the frame
                    // is kept and corrected. A switch or a rebuild onto
                    // another screen (another HMONITOR, not merely another
                    // index) drops the held frame (adopt_new_capture), so it
                    // is of the screen this stream last adopted. The
                    // keyframe makes the correction land on a decodable frame
                    // rather than a delta against a picture the controller no
                    // longer has. All Displays corrects each screen's last
                    // picture the same way and re-pastes it: marking its tiles
                    // dirty alone re-pasted the pictures with the old pointer
                    // still baked in, and only once some screen presented.
                    match (last_frame.as_mut(), capture.as_mut()) {
                        (Some(f), Some(AnyCapture::Single(c))) => {
                            c.redraw_cursor(f);
                        }
                        (_, Some(AnyCapture::Virtual(v))) => {
                            v.redraw_cursors();
                        }
                        _ => {}
                    }
                    want_keyframe = true;
                }
                StreamCommand::RequestKeyframe => {
                    // Same lever the peer's PLI pulls (see Event::KeyframeRequest
                    // below): the pump re-sends the last picture while this is
                    // outstanding, so a perfectly still desktop still gets its
                    // IDR — the exact case a resumed Android controller needs.
                    eprintln!("[stream] keyframe requested by controller");
                    on_keyframe_request(
                        &mut want_keyframe,
                        switch_started.is_some(),
                        holds_whole_picture(capture.as_ref(), last_frame.is_some()),
                        &mut stranded_repaints,
                    );
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
                    if let Some(addr) = candidate_addr(&cand) {
                        // THE PEER-ROUTED HOST CANDIDATE, on the trickle path.
                        //
                        // The controller sends its offer the instant
                        // setLocalDescription resolves and trickles every
                        // candidate afterwards, so at gather time the offer
                        // usually names NOBODY — which is why doing this only
                        // at startup fixed nothing in the field. Each arriving
                        // peer address is asked the one question that matters:
                        // what would this machine send FROM to reach it? On a
                        // VPN'd host that is the LAN address, which the default
                        // route never yields, and without it the highest-priority
                        // pair there is — host to host, across the room — cannot
                        // exist and the session settles on the peer's relay.
                        //
                        // str0m accepts a local candidate at any point, and the
                        // socket is wildcard-bound, so a candidate added now is
                        // immediately usable. Adding one re-pairs it against
                        // every remote candidate already known.
                        if let Some(local) =
                            peer_routed_candidate(addr, &advertised, bound_port, source_addr_for)
                        {
                            match sender.add_local_candidate(local) {
                                Ok(()) => {
                                    advertised.push(local);
                                    eprintln!(
                                        "[stream] host candidate {} added — it is what reaches {}",
                                        local.ip(),
                                        addr.ip()
                                    );
                                }
                                Err(e) => {
                                    eprintln!("[stream] host candidate {} refused: {e}", local.ip())
                                }
                            }
                        }
                        if let (Some(alloc), Some(_)) = (relay.as_mut(), relayed_addr) {
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
                        on_keyframe_request(
                            &mut want_keyframe,
                            switch_started.is_some(),
                            holds_whole_picture(capture.as_ref(), last_frame.is_some()),
                            &mut stranded_repaints,
                        );
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
                            let serving = crate::input_wire::hello_for(
                                input_channel.as_deref(),
                                |k, p| crate::control_key::seal(k, p),
                            );
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
                                //
                                // Every refusal on this channel, before or after
                                // decryption, shares ONE gate: a line per refused
                                // frame is a count of the keystrokes in them.
                                match input_channel.as_ref() {
                                    None => {
                                        if inject_error_log.admit(std::time::Instant::now()) {
                                            eprintln!(
                                                "[stream] input frame on a session with no agent-held key \
                                                 — dropped; the controller should still be on the relay"
                                            );
                                        }
                                    }
                                    Some(ch) => match crate::input_wire::accept_frame(
                                        ch, &frame,
                                        |k, p| crate::control_key::open(k, p),
                                    ) {
                                        Ok(event_json) => {
                                            // THE LATENCY PROBE (latency.rs): nothing
                                            // to inject — capture as an input would
                                            // make it, send the next frame even on a
                                            // still screen, answer with its RTP time.
                                            // Only a video stream can answer one.
                                            if let Some(id) = crate::latency::parse_probe(&event_json) {
                                                if mode == StreamMode::Video {
                                                    let arrived = Instant::now();
                                                    probe = Some(crate::latency::Probe { id, arrived });
                                                    if !crate::latency::wants_classic(&event_json) {
                                                        next_frame = next_frame.min(crate::latency::probe_capture_at(
                                                            arrived, last_frame_at, frame_interval,
                                                        ));
                                                    }
                                                }
                                                continue;
                                            }
                                            // WATCH FOR WHAT IT CHANGES (latency.rs):
                                            // taken the moment it is on screen, not at
                                            // the clock's next tick.
                                            if mode == StreamMode::Video && !crate::latency::wants_classic(&event_json) {
                                                watching_until = Some(Instant::now() + crate::latency::WATCH_FOR);
                                            }
                                            match serde_json::from_str::<puca_input::ControlInput>(
                                                &event_json,
                                            ) {
                                                Ok(ev) => {
                                                    let is_text = matches!(ev, puca_input::ControlInput::Text { .. });
                                                    if let Err(e) = crate::session::dispatch_input_counted(
                                                        &mut input_tally, ev,
                                                    ) {
                                                        // A REFUSED TEXT FRAME is a run of typed characters
                                                        // that vanished while the viewer's note said they
                                                        // were typed: say so on the caret channel, this
                                                        // agent's one way back (at most twice a second).
                                                        if is_text && refusal_report_due(&mut last_refusal_report, Instant::now()) {
                                                            if let Some(mut c) = caret_channel.and_then(|cid| sender.rtc_mut().channel(cid)) {
                                                                let _ = c.write(false, &refused_text_line(&e));
                                                            }
                                                        }
                                                        if let Some(line) = crate::session::inject_failure_line(
                                                            &mut inject_error_log,
                                                            "[stream] input inject failed:",
                                                            &e,
                                                            std::time::Instant::now(),
                                                        ) {
                                                            eprintln!("{line}");
                                                        }
                                                    }
                                                }
                                                Err(_) => {
                                                    if inject_error_log.admit(std::time::Instant::now()) {
                                                        eprintln!(
                                                            "[stream] input frame refused: {}",
                                                            crate::input_wire::InputReject::NotAnEvent.describe()
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                        Err(why) => {
                                            if inject_error_log.admit(std::time::Instant::now()) {
                                                eprintln!("[stream] input frame refused: {}", why.describe());
                                            }
                                        }
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

        // --- the pointer's shape, for a viewer that draws the pointer ---------
        //
        // The viewer owns the pointer (draw_host_cursor off): its browser draws
        // your real mouse pointer over the picture with no delay, and needs the
        // host's SHAPE — I-beam, hand, resize, busy, hidden (pointer_shape.rs).
        // Looked at every 30 ms, said only when it changes; a write SCTP refuses
        // is said again on the next look rather than queued behind newer ones.
        if !draw_host_cursor && mode == StreamMode::Video && shape_reporter.due(now) {
            if let Some(cid) = caret_channel {
                let css = crate::pointer_shape::current_css();
                if let Some(css) = shape_reporter.observe(now, css) {
                    if let Some(mut c) = sender.rtc_mut().channel(cid) {
                        if let Ok(true) = c.write(false, &crate::pointer_shape::cursor_line(css)) {
                            shape_reporter.sent(css);
                        }
                    }
                }
            }
        }

        // --- display-topology self-heal --------------------------------------
        //
        // Windows re-shapes the desktop under a live capture with no signal to
        // this loop: a monitor DPMS-sleeps and detaches after the user walks
        // away, or a GPU drops and re-adds outputs on wake. The old duplication
        // then serves a stale or black surface, and until now the only way back
        // was the controller poking `display_topology_changed` — i.e. a human
        // rejigging monitors by hand after every idle reconnect (field report
        // 2026-09-07). Notice it here on the slow clock and drive the SAME
        // rebuild the poke does by self-sending the command, so there is one
        // rebuild path, not two. Gated to Video: a DataOnly session has no
        // capture to rebuild. Runs even with a capture of None — a previous
        // rebuild that failed is revived by exactly this.
        if mode == StreamMode::Video && crate::topology::should_recheck_topology(topology_checked, now) {
            topology_checked = Some(now);
            let outs = puca_capture::outputs();
            let sig = crate::topology::outputs_signature(&outs);
            // PINNED (StartStream `steer_on_lid` off): only the stream's own
            // screen at its own index, never what took that index, and never
            // its own screen at a new one (`heal_plan`).
            let pinned = is_pinned(steer_on_lid, current_monitor);
            let differs = crate::topology::topology_differs(&built_output_sig, &sig);
            match heal_plan(current_monitor, current_output, &outs, pinned) {
                _ if !differs => {}
                // Its screen is not at its index, and nothing is rebuilt: by
                // index it would be another screen. A capture still in hand
                // goes on until it shows anything else, which ends the stream
                // (`screen_pin`), or fails (`capture_failed_end`). With none
                // in hand nothing else would ever end it, so it ends here.
                Heal::End if capture.is_none() => {
                    let code = changed_end(lid_watch.lid_changed_recently(now), false);
                    eprintln!(
                        "[stream] display topology changed and {}, the screen this stream shows, is not at its \
                         index any more; with no capture left, the stream ends ({code}) (steer_on_lid)",
                        screen_name(current_monitor)
                    );
                    return Err(code.to_string());
                }
                Heal::End => {
                    if !heal_held_back_said {
                        heal_held_back_said = true;
                        eprintln!(
                            "[stream] display topology changed under the capture and {}, the screen this stream \
                             shows, is not at its index any more; not rebuilding it onto another screen (steer_on_lid)",
                            screen_name(current_monitor)
                        );
                    }
                }
                Heal::Rebuild(target) => {
                    heal_held_back_said = false;
                    eprintln!(
                        "[stream] display topology changed under the capture ({} -> {} outputs); self-rebuilding for monitor {target}",
                        built_output_sig.len(),
                        sig.len()
                    );
                    // The baseline is deliberately NOT advanced here: only a
                    // SUCCESSFUL rebuild (its arm below) refreshes it. So if the
                    // rebuild fails — the desktop still recomposing, the target
                    // briefly unavailable — the next 2 s check sees the same
                    // mismatch and tries again, instead of one shot then a frozen
                    // picture until the human intervenes (the whole bug). The 2 s
                    // clock bounds this to one attempt per interval, never a storm.
                    let (reply_tx, _reply_rx) = std::sync::mpsc::channel();
                    if self_tx
                        .send(StreamCommand::RebuildCapture {
                            generation,
                            deadline: now + Duration::from_secs(5),
                            cancelled: Arc::new(AtomicBool::new(false)),
                            monitor: target,
                            reply_tx,
                            why: RebuildFor::SelfHeal,
                        })
                        .is_err()
                    {
                        eprintln!("[stream] topology self-heal could not enqueue a rebuild (loop is shutting down)");
                    }
                }
            }
        }

        // --- the lid, mid-session --------------------------------------------
        //
        // A session start steers off a built-in panel behind a closed lid and
        // asks for the virtual screen when nothing else is lit
        // (virtual_screen.rs). A lid shut DURING the session got none of
        // that: the panel stays an active output Windows never presents to,
        // and the picture froze for the rest of the session (2026-10-26, 193 s
        // into a 60 fps session). So the stream watches the lid itself, with
        // the same rules (`lid_step`) and the same `prepare` a start polls,
        // and moves through the one rebuild path there is (RebuildCapture,
        // which it already self-sends for the topology self-heal).
        //
        // The lid's state is one atomic load per pass; the displays are
        // enumerated only when a look is due: after the lid has settled, and
        // then every couple of seconds while it stays closed. Everything it
        // sends is bounded: a move that keeps failing backs off and gives up,
        // a request for a screen that never answers is given up, and a
        // capture that stays lost ends the stream (`LidWatch`).
        if mode == StreamMode::Video {
            use crate::virtual_screen::{Flight, LidAction, ScreenState};
            let all = crate::composite::ALL_DISPLAYS;
            let lid = crate::lid::closed();
            if lid_watch.observe(lid, now) {
                // A new situation: the next request for a screen starts afresh.
                lid_asking = false;
                lid_virtual_asked = false;
            }
            let capture_ok = capture.is_some() && !capture_loss_said;
            lid_watch.note_capture(capture_ok, now);

            // The move it sent: its RebuildCapture ran in this pass's command
            // drain above, so the reply is normally already here.
            if let Some(m) = &lid_move {
                let answer = match m.reply.try_recv() {
                    Ok(answer) => Some(answer),
                    Err(std::sync::mpsc::TryRecvError::Empty) => (lid_watch.flight_expired(now) == Some(Flight::Move))
                        .then(|| Err(StreamCommandError::ConstructionFailed("no answer".to_string()))),
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        Some(Err(StreamCommandError::ConstructionFailed("the move was dropped".to_string())))
                    }
                };
                if let Some(answer) = answer {
                    let m = lid_move.take().expect("matched above");
                    match answer {
                        Ok(()) => {
                            eprintln!("[lid] the picture is on screen {} now", m.target);
                            // What it is asked for now, unless the viewer
                            // chose a screen since: that choice stands.
                            if m.switches == switch_count {
                                lid_watch.asked = m.asked;
                            }
                            lid_watch.moved(now);
                            lid_asking = false;
                        }
                        // THE VIEWER'S CHOICE WINS: a switch it made after this
                        // move was decided (RebuildCapture's arm).
                        Err(StreamCommandError::Cancelled) => {
                            eprintln!(
                                "[lid] not moving the picture to screen {}: the viewer chose a screen since",
                                m.target
                            );
                            lid_watch.landed(now, Duration::ZERO);
                        }
                        Err(e) => {
                            let last = lid_watch.move_failed(m.target, now);
                            if lid_watch.failures() == 1 {
                                eprintln!(
                                    "[lid] could not move the picture to screen {} ({e:?}); trying again, less often \
                                     each time, and not on that screen for {} s",
                                    m.target,
                                    crate::virtual_screen::LID_AVOID_FOR.as_secs()
                                );
                            }
                            if last && lid == Some(true) && is_pinned(steer_on_lid, current_monitor) {
                                // PINNED: its move is a rebuild of its own lit screen
                                // in place, and a lid shut all session (a dock) is not
                                // why it failed. Restartable while that screen is still
                                // at its index, else the end names the lid only when the
                                // lid is the reason (`capture_failed_end`).
                                let end = capture_failed_end(
                                    true,
                                    current_monitor,
                                    current_output,
                                    &puca_capture::outputs(),
                                    lid_watch.lid_changed_recently(now),
                                    &format!("could not rebuild the capture in {} tries", lid_watch.failures()),
                                );
                                eprintln!(
                                    "[lid] could not rebuild the capture of {} in {} tries; ending the stream ({end})",
                                    screen_name(current_monitor),
                                    lid_watch.failures()
                                );
                                return Err(end);
                            }
                            if last && lid == Some(true) {
                                // NOTHING TO SHOW WITH THE LID SHUT: end with the
                                // code a start gives, never hold a frozen picture.
                                let reason = crate::virtual_screen::lid_end(m.to_virtual || lid_virtual_asked);
                                eprintln!(
                                    "[lid] could not move the picture in {} tries with the lid closed; ending the \
                                     stream ({})",
                                    lid_watch.failures(),
                                    reason.code()
                                );
                                return Err(reason.code().to_string());
                            }
                            if last {
                                // The lid is open and the picture still works
                                // where it is: it stays there.
                                eprintln!(
                                    "[lid] could not move the picture in {} tries; it stays on screen \
                                     {current_monitor} until the lid changes",
                                    lid_watch.failures()
                                );
                                lid_watch.give_up();
                            }
                        }
                    }
                }
            }

            // The `prepare` it started: the same answer a session start polls.
            if let Some(rx) = &lid_prepare {
                let answer = match rx.try_recv() {
                    Ok(state) => Some(Some(state)),
                    Err(std::sync::mpsc::TryRecvError::Empty) => None,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => Some(None),
                };
                match answer {
                    Some(Some(state)) => {
                        lid_prepare = None;
                        if lid_prepare_said != Some(state) {
                            eprintln!("[lid] asked for a screen: {}", state.wire());
                            lid_prepare_said = Some(state);
                        }
                        match state {
                            // NO SCREEN, AND NONE COMING: end with the named
                            // reason a start gives, which the viewer turns into
                            // "<PC>'s screen is off — is its lid closed?…"
                            // (noScreen.ts). The agent reports it as this
                            // session's `stream_end` (session.rs).
                            ScreenState::Off(reason) if lid == Some(true) => {
                                eprintln!(
                                    "[lid] no screen to show with the lid closed ({}); ending the stream",
                                    reason.code()
                                );
                                return Err(reason.code().to_string());
                            }
                            // Off, for a lid that has opened since: look again.
                            ScreenState::Off(_) => lid_watch.landed(now, Duration::ZERO),
                            // A screen is lit: look again at once and move to it.
                            ScreenState::Ready => lid_watch.landed(now, Duration::ZERO),
                            ScreenState::Waking | ScreenState::Starting => {
                                lid_virtual_asked |= state == ScreenState::Starting;
                                lid_watch.screen_coming(now);
                                lid_watch.landed(now, crate::virtual_screen::LID_POLL);
                            }
                        }
                    }
                    Some(None) => {
                        lid_prepare = None;
                        lid_watch.landed(now, crate::virtual_screen::LID_POLL);
                    }
                    // NEVER ANSWERED: the service exchange behind `prepare` has
                    // no timeout of its own, and a stream must not wait on it
                    // for ever. With the lid shut that is no screen.
                    None if lid_watch.flight_expired(now) == Some(Flight::Prepare) => {
                        lid_prepare = None;
                        let limit = crate::virtual_screen::LID_PREPARE_LIMIT.as_secs();
                        if lid == Some(true) {
                            let reason = crate::virtual_screen::lid_end(true);
                            eprintln!(
                                "[lid] asked for a screen and nothing answered in {limit} s; ending the stream ({})",
                                reason.code()
                            );
                            return Err(reason.code().to_string());
                        }
                        eprintln!("[lid] asked for a screen and nothing answered in {limit} s; the lid is open again");
                        lid_watch.landed(now, crate::virtual_screen::LID_POLL);
                    }
                    None => {}
                }
            }

            // A CAPTURE THAT STAYS LOST after the lid changed the displays, with
            // nothing in flight to bring it back: the picture would stay frozen
            // for the rest of the session (a rebuild that failed leaves no
            // capture, and nothing then pumps or fails). End it instead.
            if lid_watch.capture_lost_too_long(now) {
                let grace = crate::virtual_screen::LID_TRANSITION_GRACE.as_secs();
                // A STEERING stream with the lid shut has nothing left to show:
                // the lid's code. A pinned one ends below, by its own screen.
                if lid == Some(true) && !is_pinned(steer_on_lid, current_monitor) {
                    let reason = crate::virtual_screen::lid_end(lid_virtual_asked);
                    eprintln!(
                        "[lid] the capture has had no screen for {grace} s with the lid closed; ending the stream ({})",
                        reason.code()
                    );
                    return Err(reason.code().to_string());
                }
                eprintln!("[lid] the capture has had no screen for {grace} s since the lid changed the displays; ending the stream");
                // Restartable, unless the stream is PINNED and its screen is
                // not at its index any more (`capture_failed_end`).
                return Err(capture_failed_end(
                    is_pinned(steer_on_lid, current_monitor),
                    current_monitor,
                    current_output,
                    &puca_capture::outputs(),
                    lid_watch.lid_changed_recently(now),
                    &format!("no screen for {grace} s after the lid changed the displays"),
                ));
            }

            if lid_watch.due(now) {
                let d = crate::virtual_screen::displays();
                lid_watch.on_virtual = d.is_virtual(current_monitor);
                // Never a screen another session's stream (or a raw capture)
                // holds, nor one that refused a move just now.
                let mut avoid = held_screens.others(&session_id);
                avoid.extend(lid_watch.refused(now));
                // STEERING OR PINNED: the host app says whether it can follow a
                // move to another screen and ask the person at the host about
                // it (StartStream `steer_on_lid`). Not, and the stream keeps
                // its own screen or ends (`pinned_step`).
                match crate::virtual_screen::lid_action(
                    steer_on_lid,
                    lid_watch.asked,
                    current_monitor,
                    current_output,
                    &d,
                    lid,
                    capture_ok,
                    &avoid,
                    all,
                ) {
                    LidAction::Stay => {
                        lid_watch.idle(now);
                        lid_prepare_said = None;
                        lid_watch.asked = crate::virtual_screen::after_other_rebuild(lid_watch.asked, current_monitor, &d, all);
                    }
                    LidAction::MoveTo(target) => {
                        // The same screen at another index (its handle) is not
                        // a screen the lid took: nothing to go back to.
                        let same_screen = target != all && current_output.is_some() && d.handle_of(target) == current_output;
                        // Said once per move, not once per try (see the reply).
                        if lid_watch.failures() == 0 {
                            eprintln!("[lid] {}", lid_move_line(current_monitor, target, &d, lid == Some(true), same_screen));
                        }
                        if let Some(reply) = send_lid_move(&self_tx, generation, target, switch_count, now) {
                            lid_move = Some(LidMove {
                                target,
                                to_virtual: d.is_virtual(target),
                                asked: crate::virtual_screen::after_lid_move(
                                    lid_watch.asked,
                                    current_monitor,
                                    target,
                                    &d,
                                    lid == Some(true),
                                    same_screen,
                                    all,
                                ),
                                switches: switch_count,
                                reply,
                            });
                            lid_watch.acted(now, Flight::Move);
                        } else {
                            lid_watch.idle(now);
                        }
                        lid_prepare_said = None;
                    }
                    LidAction::NeedScreen => {
                        // The first request of this lid episode starts afresh:
                        // whatever an earlier one left (the virtual screen
                        // asked for, then let go when the lid opened) is not
                        // its answer (virtual_screen.rs `Preps`).
                        let anew = !lid_asking;
                        if anew {
                            eprintln!(
                                "[lid] the lid is closed and no screen is lit (the picture is on screen \
                                 {current_monitor}; outputs {:?}, dark {:?}); asking for one as a session start does",
                                d.outputs, d.dark
                            );
                        }
                        let (tx, rx) = std::sync::mpsc::channel();
                        let sid = session_id.clone();
                        let spawned = std::thread::Builder::new()
                            .name("lid-prepare".into())
                            .spawn(move || {
                                let state = if anew {
                                    crate::virtual_screen::prepare_anew(&sid)
                                } else {
                                    crate::virtual_screen::prepare(&sid)
                                };
                                let _ = tx.send(state);
                            });
                        match spawned {
                            Ok(_) => {
                                lid_prepare = Some(rx);
                                lid_asking = true;
                                lid_watch.acted(now, Flight::Prepare);
                            }
                            Err(e) => {
                                eprintln!("[lid] could not ask for a screen ({e}); trying again shortly");
                                lid_watch.landed(now, crate::virtual_screen::LID_POLL);
                            }
                        }
                    }
                    // PINNED, AND ITS SCREEN IS DARK OR GONE: no other screen
                    // is the viewer's to see. The lid's code when it is shut,
                    // the one a start with no screen gives; a restartable end
                    // otherwise, which a restart answers through a start the
                    // host app checks.
                    LidAction::End => {
                        let what = if current_monitor == all {
                            "left with no screen lit"
                        } else if current_output.is_some_and(|h| d.handle_of(current_monitor) == Some(h)) {
                            "dark behind the lid"
                        } else if current_output.and_then(|h| d.index_of(h)).is_some() {
                            "at another index now"
                        } else {
                            "gone, or replaced at its index"
                        };
                        // Never restarted: by index, a restart could land on a
                        // screen nobody shared (`changed_end`). The lid's code
                        // only when the lid is why: it just changed, or the
                        // stream's own screen is the panel dark behind it.
                        let code = changed_end(
                            lid_watch.lid_changed_recently(now),
                            crate::virtual_screen::own_screen_dark(current_monitor, current_output, &d, all),
                        );
                        eprintln!(
                            "[lid] {}, the screen this stream shows, is {what}; ending the stream ({code}): the host \
                             app did not let it show another screen (steer_on_lid)",
                            screen_name(current_monitor)
                        );
                        return Err(code.to_string());
                    }
                }
            }
        }

        let mut flushed_frame = false;
        // `capture.is_some()` is the guard, not `mode`: the SetMonitor
        // transition briefly takes the capture out, and the invariant that
        // matters here is "there is one to pump", not "this session wants one".
        //
        // Two ways in: the clock's tick, or an EARLY LOOK for an input's
        // change (latency.rs) — a new picture or nothing, never the held one
        // re-sent, and the clock is touched only if it found one.
        let due = now >= next_frame;
        // Not while a capture that lost its screen is being ridden out (the
        // lid, above): like a blocked one, every look would ask DXGI to
        // rebuild it, hundreds of times a second while input arrives.
        let early = !due
            && !capture_loss_said
            && early_look_allowed(now, watching_until, next_frame, last_frame_at, frame_interval, blocked_since);
        if capture.is_some() && (due || early) {
            if due {
                next_frame += frame_interval;
                if now > next_frame + frame_interval {
                    next_frame = now;
                }
            }
            // A probe nobody could answer in a second is stale (a capture
            // that is not producing anything); the viewer has given up on it.
            if probe.is_some_and(|p| now.duration_since(p.arrived) > Duration::from_secs(1)) {
                probe = None;
            }
            // A probe asks for a picture even of a still screen — but not of a
            // BLOCKED capture (a security screen up): re-sending the held
            // picture once a second ended the blockage on every probe, so the
            // 5 s rebuild never came and the viewer's picture looked alive.
            let why = if early {
                PumpFor::Look
            } else if probe.is_some() && blocked_since.is_none() {
                PumpFor::Probe
            } else {
                PumpFor::Tick
            };
            // A stream pinned to its screen never sends a picture of another
            // one, whatever renumbered the outputs (`screen_pin`).
            let pin = screen_pin(steer_on_lid, current_monitor, current_output);
            match pump_frame(capture.as_mut().expect("checked is_some above"), &mut encoder, &mut sender, current_bitrate, current_fps, &mut want_keyframe, now, &mut pump_stats, &mut last_frame, frames_sent == 0, switch_awaits_whole_picture(switch_started, now), view_size, &mut fit, why, draw_host_cursor, pin) {
                Ok(pumped) => {
                    let sent = pumped.sent;
                    last_frame_at = Some(now);
                    if capture_loss_said {
                        capture_loss_said = false;
                        eprintln!("[lid] the capture has its screen again");
                    }
                    if early {
                        // Caught as it appeared: the clock carries on from
                        // this frame, and the watch is over.
                        next_frame = now + frame_interval;
                        watching_until = None;
                    }
                    frames_sent += u64::from(sent);
                    flushed_frame = sent;
                    // THE PROBE'S FRAME is this one: answer with its RTP time
                    // on the caret channel, the agent's one way to the viewer.
                    if sent {
                        if let (Some(p), Some(ts), Some(cid)) = (probe, sender.last_rtp_timestamp(), caret_channel) {
                            probe = None;
                            let line = crate::latency::probe_reply(p.id, ts, Instant::now().duration_since(p.arrived));
                            if let Some(mut c) = sender.rtc_mut().channel(cid) {
                                // Dropped, not queued, when SCTP is full: the
                                // viewer times the probe out and sends another.
                                let _ = c.write(false, &line);
                            }
                        }
                    }
                    if sent {
                        // Only a WHOLE picture ends a switch (on_frame_sent).
                        // An All Displays frame can go out with a screen still
                        // black, because the screens that did present are
                        // worth showing; that switch stays pending, and its
                        // net runs from here as well as from the still tick
                        // below, since another screen that never stops
                        // changing (a video) never lets the pump fall still.
                        let whole = holds_whole_picture(capture.as_ref(), last_frame.is_some());
                        if let Some(t0) = on_frame_sent(whole, &mut switch_started, &mut stranded_repainted_at) {
                            eprintln!(
                                "[switch] first frame sent {} ms after commit",
                                t0.elapsed().as_millis()
                            );
                        }
                        if let Some(t0) = switch_started {
                            stranded_net_tick(
                                capture.as_ref(), current_monitor, last_frame.is_some(), t0, now,
                                &mut stranded_repaints, &mut stranded_repainted_at, &mut want_keyframe,
                            );
                        }
                    }
                    skipped = 0;
                    if pumped_ends_blockage(pumped.still_blocked, &mut blocked_since, now) {
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
                // An early look that found nothing new: the clock keeps its
                // schedule, and the still-screen and security-screen
                // bookkeeping below is the tick's business.
                Err(PumpError::NoChange) if early => {}
                // A look that finds the capture BLOCKED records it at once, so
                // no further look comes before the tick takes it from here.
                Err(PumpError::SecureDesktop) if early => {
                    blocked_since.get_or_insert(now);
                }
                Err(PumpError::NoChange) => {
                    // The capture answered: whatever it lost, it has again.
                    if capture_loss_said {
                        capture_loss_said = false;
                        eprintln!("[lid] the capture has its screen again");
                    }
                    skipped += 1;
                    if skipped == 30 || skipped == 150 {
                        eprintln!("[stream] {skipped} consecutive skips (still screen)");
                    }
                    // A SWITCH THAT NEVER GETS ITS FIRST PICTURE: the
                    // destination screen stands still and the capture holds
                    // nothing to re-send, so every keyframe request, zoom and
                    // click stays invisible until the desktop repaints by
                    // itself. Two reasons a screen presents nothing, and the
                    // net answers both: the PANEL IS ASLEEP (the wake at
                    // session start is the only one, and a sleeping panel
                    // presents nothing whatever the scene does: measured
                    // 2026-09-22, every probe against a sleeping panel came
                    // back empty), so the same nudge as the cold start; and
                    // the screen is awake but STILL, so the scene is changed
                    // invisibly to make the compositor present (repaint.rs:
                    // a pointer-only update and a re-opened duplication do
                    // not). The commit out of the composite provokes once at
                    // once; this is the net under it and under any other
                    // switch that landed on such a screen: three tries,
                    // three quarters of a second apart, each in the log, and
                    // a fresh round for a keyframe request that arrives
                    // after them (on_keyframe_request). A switch INTO All
                    // Displays is covered too: its screens are fetched tile
                    // by tile, and the net provokes each one still missing
                    // (AnyCapture::awaited_screens). It used to be skipped
                    // for the composite, whose picture it had no way to ask
                    // about.
                    if let Some(t0) = switch_started {
                        stranded_net_tick(
                            capture.as_ref(), current_monitor, last_frame.is_some(), t0, now,
                            &mut stranded_repaints, &mut stranded_repainted_at, &mut want_keyframe,
                        );
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
                            return Err(NO_FRAME_EVER_REASON.to_string());
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
                        if lid_watch.rides_out_capture_loss(now) {
                            // The same AccessLost, for another reason: the lid
                            // just changed the displays under the capture.
                            eprintln!(
                                "[stream] the capture is blocked while the lid changes the displays; \
                                 the viewer is holding the last frame"
                            );
                        } else {
                            eprintln!(
                                "[stream] a Windows security screen owns the display (lock screen, \
                                sign-in screen, or an administrator prompt) — capture is blocked \
                                until it closes; the viewer is holding the last frame"
                            );
                        }
                    }
                }
                Err(PumpError::EncoderFilling) => {
                    // The encoder took a picture and is still filling: a
                    // frame for the floor, and for an early look a caught
                    // change like any other.
                    last_frame_at = Some(now);
                    if early {
                        next_frame = now + frame_interval;
                        watching_until = None;
                    }
                    // Counted SEPARATELY from a still screen. Lumping the two
                    // together under one message is what hid half a second of
                    // encoder buffering: both look like "no frame came out",
                    // and only one of them is free.
                    skipped += 1;
                    if skipped == 30 || skipped == 150 {
                        eprintln!("[stream] {skipped} consecutive skips (encoder filling)");
                    }
                }
                // THE SCREENS ARE BEING RE-ARRANGED FOR THE LID: the panel
                // leaving, the virtual screen arriving or going, and for a
                // moment the index this capture names can be missing, which
                // the capture reports as a failure. It retries itself on every
                // tick and the topology rebuild remaps it, so the last
                // picture is held instead of ending the session, for a
                // bounded window (LID_TRANSITION_GRACE). Past it, or with the
                // lid nowhere near, this ends the stream exactly as before.
                Err(PumpError::CaptureFailed(e)) if lid_watch.rides_out_capture_loss(now) => {
                    skipped += 1;
                    if !capture_loss_said {
                        capture_loss_said = true;
                        eprintln!(
                            "[lid] the capture lost its screen while the lid changed the displays ({e}); \
                             holding the last picture while Windows re-arranges them"
                        );
                    }
                }
                // NOTHING OF ANOTHER SCREEN: the pinned stream's capture now
                // shows a screen other than its own, and nothing of it went
                // out. Ended with a code no restart answers (`changed_end`).
                Err(PumpError::ScreenChanged) => {
                    let code = changed_end(lid_watch.lid_changed_recently(now), false);
                    eprintln!(
                        "[stream] the capture of {} is showing another screen now (the outputs were renumbered); \
                         nothing of it was sent, and the stream ends ({code}): it shows no screen but its own \
                         (steer_on_lid)",
                        screen_name(current_monitor)
                    );
                    return Err(code.to_string());
                }
                Err(PumpError::CaptureFailed(e)) => {
                    return Err(capture_failed_end(
                        is_pinned(steer_on_lid, current_monitor),
                        current_monitor,
                        current_output,
                        &puca_capture::outputs(),
                        lid_watch.lid_changed_recently(now),
                        &e,
                    ))
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
        // WATCHING for an input's change (latency.rs): look again in a couple
        // of milliseconds rather than at the next tick — once the floor under
        // early frames has passed; before that a look would only be refused.
        let wait = match (capture.as_ref(), watching_until) {
            (Some(_), Some(_))
                if !capture_loss_said && watching_for_change(Instant::now(), watching_until, blocked_since) =>
            {
                let floor_ends = last_frame_at.map_or_else(Instant::now, |t| t + frame_interval);
                wait.min(floor_ends.saturating_duration_since(Instant::now()).max(crate::latency::WATCH_POLL))
            }
            _ => wait,
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
            // The VIEWER closed the connection (a Disconnect or Reconnect on
            // the controller): a clean end, which used to leave no line here.
            eprintln!("[stream] {}", clean_end_line(CleanEnd::ViewerClosed, started_at.elapsed(), frames_sent));
            return Ok(());
        }
    }
    // The stop flag: the HOST stopped this stream (StopStream from the app,
    // or the agent dropped with the app's connection, session.rs and pipe.rs
    // say which). A clean end, which used to leave no line at all.
    eprintln!("[stream] {}", clean_end_line(CleanEnd::Stopped, started_at.elapsed(), frames_sent));
    Ok(())
}

/// Why a stream ended cleanly (run() returning Ok).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CleanEnd {
    /// Its stop flag: the host stopped it.
    Stopped,
    /// The peer connection is no longer alive: the viewer closed it.
    ViewerClosed,
}

/// The line a clean end writes, with how long the stream ran and how much
/// it sent: the two numbers that tell a session that never showed anything
/// from one that ran for an hour. Nothing about the viewer or its network.
fn clean_end_line(why: CleanEnd, ran: Duration, frames_sent: u64) -> String {
    let what = match why {
        CleanEnd::Stopped => "stopped by the host",
        CleanEnd::ViewerClosed => "ended: the viewer closed the connection",
    };
    format!("{what} after {:.1}s, {frames_sent} frame(s) sent", ran.as_secs_f64())
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
    /// The capture itself failed (`CaptureError::Failed`): ends the stream
    /// as `Fatal` does, as "capture: …", except while the lid is moving the
    /// desktop under it (`LidWatch::rides_out_capture_loss`).
    CaptureFailed(String),
    /// A PINNED stream's capture shows another screen than the stream's own,
    /// or one it cannot name (`screen_pin`): nothing of it went out, and the
    /// stream ends with a code no restart answers (`changed_end`).
    ScreenChanged,
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
    /// The viewer fit (composite::downscale_into); zero when the picture is
    /// native. Reported so the cost of sending fewer pixels is visible next to
    /// what it saves.
    fit: SpanStats,
    encode: SpanStats,
    send: SpanStats,
    /// Frames the encoder swallowed without emitting, since the last report.
    filling: u32,
    /// Frames sent because only the host-drawn pointer moved over a still
    /// screen (`still_tick`), since the last report: what a moving mouse
    /// costs on a desktop that is otherwise not changing.
    pointer: u32,
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
        let mut line = format!(
            "[stream] +{:.1}s timing over {n} frame(s): capture {} fit {} encode {} send {} (encoder held {})",
            elapsed.as_secs_f64(),
            self.capture.report(n),
            self.fit.report(n),
            self.encode.report(n),
            self.send.report(n),
            self.filling,
        );
        // Only when there were any, so every line from a stream that never
        // redrew the pointer reads exactly as it did.
        if self.pointer > 0 {
            line.push_str(&format!(" pointer-only {}", self.pointer));
        }
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

/// What a still tick (the capture said Timeout: nothing was presented) does
/// with the picture the stream holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StillTick {
    /// Nothing to send. Free.
    NoChange,
    /// Send the held picture again. `pointer`: the HOST draws the pointer,
    /// it moved or changed shape, and the capture has just drawn it into the
    /// held picture where it is now, so this is a new picture.
    Resend { pointer: bool },
}

/// THE STILL TICK, decided. `redraw` is the capture bringing the pointer up
/// to date on the held picture (`ScreenCapture::redraw_cursor`, or
/// `VirtualCapture::redraw_cursors` for All Displays): true when that
/// changed its pixels.
///
/// WHY. DXGI reports a moved pointer as no new picture (puca-capture
/// windows_impl.rs, `LastPresentTime == 0`), and this tick used to answer it
/// with nothing, so while the host draws the pointer — Game mode, paused
/// control, touch mode, "Draw the pointer here" off, and every agent older
/// than the shape report — the pointer in the picture stood still for as
/// long as the screen did. Measured on 2026-10-26: about 25 s of 80 to 120
/// moves a second, with clicks and the wheel, against 150 consecutive still
/// skips and no frame sent.
///
/// The pointer is asked about only when the host draws it (`host_draws`)
/// and a picture is held. Drawing off, nothing is asked and nothing changes
/// (the viewer draws its own pointer); an unchanged pointer changes nothing
/// either, so an idle mouse costs no encode at all. A moving one costs at
/// most one encode per frame interval, because this runs only on the
/// clock's tick and on the early look, which `latency::may_capture_early`
/// keeps a whole interval after the last frame sent.
fn still_tick(
    need_picture: bool,
    holding: bool,
    host_draws: bool,
    redraw: impl FnOnce() -> bool,
) -> StillTick {
    let pointer = host_draws && holding && redraw();
    if should_resend_still(need_picture || pointer, holding) {
        StillTick::Resend { pointer }
    } else {
        StillTick::NoChange
    }
}

/// The bookkeeping for a stream that has just been handed a NEW capture of
/// `to_monitor`: a committed monitor switch, or a capture rebuilt after a
/// display-topology change. Moves `current_monitor`/`current_output` onto the
/// new capture ITSELF, after reading them, so a caller cannot hand it the
/// destination as the origin by updating them first.
///
/// ONTO ANOTHER SCREEN, the held still-frame is a picture of the screen being
/// LEFT, so it is dropped. Kept, the pump answered the new keyframe on a still
/// destination with the old screen's picture, counted that as the switch's
/// first frame, and so disarmed the stranded-switch net (which fires only
/// while nothing is held): the viewer kept looking at the old screen while
/// every click landed on the new one. Dropped, a still destination sends
/// nothing until it presents, and the net armed here provokes that present
/// at 750 ms (repaint.rs). A switch INTO All Displays is the one place the
/// picture is still of use, as the tile of the screen being left, and the
/// composite has taken its own copy (VirtualCapture::adopt) before this runs.
///
/// ONTO THE SAME SCREEN (a rebuild after a display-mode change; a switch to
/// the screen already shown never gets this far), the held frame IS the right
/// picture and the only thing a still screen can feed the rebuilt encoder, so
/// it is kept and no switch is armed. "The same screen" is decided by
/// `is_same_screen`, not by the index alone: see there.
///
/// Generic over the held frame so the rule can be tested without a display;
/// the loop's own variables are passed in, so nothing else about them moves.
#[allow(clippy::too_many_arguments)]
fn adopt_new_capture<F>(
    current_monitor: &mut usize,
    current_output: &mut Option<isize>,
    to_monitor: usize,
    to_output: Option<isize>,
    last_frame: &mut Option<F>,
    want_keyframe: &mut bool,
    switch_started: &mut Option<Instant>,
    stranded_repaints: &mut u8,
    stranded_repainted_at: &mut Option<Instant>,
    now: Instant,
) {
    *want_keyframe = true;
    if !is_same_screen(*current_monitor, *current_output, to_monitor, to_output) {
        *last_frame = None;
        *switch_started = Some(now);
        *stranded_repaints = 0;
        *stranded_repainted_at = None;
    }
    *current_monitor = to_monitor;
    *current_output = to_output;
}

/// Which physical screen output `monitor` of this enumeration is: its HMONITOR,
/// or None for the composite, an index not in the list, or an unknown handle.
fn screen_identity(outs: &[puca_capture::OutputInfo], monitor: usize) -> Option<isize> {
    outs.iter()
        .find(|o| o.index == monitor)
        .map(|o| o.hmonitor)
        .filter(|&h| h != 0)
}

/// Does a new capture of `to` show the same screen the stream was showing as
/// `from`?
///
/// NOT JUST THE INDEX. A monitor index is a position in the DXGI walk, so when
/// the streamed output detaches (a panel sleeping after the user walks away),
/// the next output shifts into its index and the topology remap keeps the
/// index: the "same" index is now a different screen, and its held picture is
/// of one that no longer exists. So a single screen is the same only when its
/// HMONITOR also matches. When that cannot be shown (an unknown handle, or a
/// handle Windows re-issued for the same screen) the answer is "different":
/// the cost of that is a dropped still and the stranded-switch net's provoked
/// present, bounded at 750 ms; the cost of the opposite is a vanished screen's
/// picture on the viewer while every click lands on another one.
///
/// The composite has no single screen to compare, and never holds a still.
fn is_same_screen(from: usize, from_output: Option<isize>, to: usize, to_output: Option<isize>) -> bool {
    from == to
        && (from == crate::composite::ALL_DISPLAYS
            || (from_output.is_some() && from_output == to_output))
}

/// The lid watch's move to `target`, sent to this stream's own loop
/// (`RebuildFor::Lid`): its reply, or None when the loop is going away.
fn send_lid_move(
    self_tx: &std::sync::mpsc::Sender<StreamCommand>,
    generation: u64,
    target: usize,
    switches: u64,
    now: Instant,
) -> Option<std::sync::mpsc::Receiver<Result<(), StreamCommandError>>> {
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    self_tx
        .send(StreamCommand::RebuildCapture {
            generation,
            deadline: now + Duration::from_secs(5),
            cancelled: Arc::new(AtomicBool::new(false)),
            monitor: target,
            reply_tx,
            why: RebuildFor::Lid { switches },
        })
        .ok()?;
    Some(reply_rx)
}

/// "screen 2", or "All Displays" for the composite.
fn screen_name(i: usize) -> String {
    if i == crate::composite::ALL_DISPLAYS {
        "All Displays".to_string()
    } else {
        format!("screen {i}")
    }
}

/// What the lid watch says when it moves the picture, once per move.
fn lid_move_line(
    current: usize,
    target: usize,
    d: &crate::virtual_screen::Displays,
    lid_closed: bool,
    same_screen: bool,
) -> String {
    let (from, to) = (screen_name(current), screen_name(target));
    if target == current {
        format!("the capture lost {from} while the lid changed the displays; building it again")
    } else if same_screen {
        format!("{from} is {to} now (the lid changed the displays); following it there")
    } else if lid_closed && current == crate::composite::ALL_DISPLAYS {
        format!("the lid is closed and {to} is the only screen lit; showing it instead of All Displays")
    } else if lid_closed && d.dark.contains(&current) {
        format!(
            "the lid is closed and {from} is a built-in panel behind it (dark: {:?}); moving the picture to {to}",
            d.dark
        )
    } else if lid_closed && !d.outputs.contains(&current) {
        format!("the lid is closed and {from} is gone; moving the picture to {to}")
    } else if d.is_virtual(current) {
        format!("a real screen is lit; moving the picture off the virtual screen to {to} before it is let go")
    } else {
        format!("the lid is open again; moving the picture back to {to}, the one asked for")
    }
}

//// Is this stream PINNED to the screen it shows? A single screen, and a host
/// app that has not said it can follow a move and ask about it (StartStream
/// `steer_on_lid` off, the default). All Displays shows every screen, so it
/// has none to keep.
fn is_pinned(steer_on_lid: bool, current: usize) -> bool {
    !steer_on_lid && current != crate::composite::ALL_DISPLAYS
}

/// The screen every picture of a PINNED stream must be of: its own, by the
/// handle its capture reported (`refresh_picture`). Checked always, lid or no
/// lid: the lid's state arrives on its own clock (a panel can leave the
/// desktop first) or not at all, and a capture can sit on another screen long
/// after the lid stopped moving. A handle that is not known pins to 0, which
/// no capture reports, so nothing goes out. None, any picture, for a stream
/// that may steer, and for All Displays.
fn screen_pin(steer_on_lid: bool, current: usize, current_output: Option<isize>) -> Option<isize> {
    is_pinned(steer_on_lid, current).then(|| current_output.unwrap_or(0))
}

/// What the topology self-heal does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Heal {
    /// Rebuild the capture at this index.
    Rebuild(usize),
    /// The pinned stream's screen is not at its index any more: end it.
    End,
}

/// The topology self-heal's plan. By index, as ever (`remap_monitor_for`),
/// unless the stream is PINNED: then only its own screen, at its own index,
/// with the handle it had. A screen that is gone, renumbered to another
/// index, or replaced at this one ends the stream: by index, a panel that
/// left the desktop as the lid shut put an external monitor in its place and
/// the self-heal rebuilt onto it, and following its own screen to a new index
/// reports an index the host app never agreed to. A renumbering that leaves
/// the stream's screen where it was (a dock adding a monitor after it)
/// rebuilds it in place.
fn heal_plan(current: usize, current_output: Option<isize>, outs: &[puca_capture::OutputInfo], pinned: bool) -> Heal {
    if !pinned {
        let present: Vec<usize> = outs.iter().map(|o| o.index).collect();
        return Heal::Rebuild(crate::topology::remap_monitor_for(current, &present));
    }
    let own = current_output.is_some_and(|h| outs.iter().any(|o| o.index == current && o.hmonitor == h));
    if own {
        Heal::Rebuild(current)
    } else {
        Heal::End
    }
}

/// May a PINNED stream adopt the capture a rebuild just built? Only of its
/// own screen at its own index: the build goes by index, and the outputs can
/// be renumbered between the decision and the build, so the capture's own
/// answer (`screen`) is what decides, never a fresh enumeration. A stream
/// that may steer adopts what it built, as before.
fn rebuilt_capture_accepted(
    pinned: bool,
    current: usize,
    current_output: Option<isize>,
    target: usize,
    built_screen: Option<isize>,
) -> bool {
    !pinned || (target == current && current_output.is_some() && built_screen == current_output)
}

/// The end of a PINNED stream with nothing of its own left to show. Neither
/// code is answered with a restart (session.rs `stream_end_code`):
/// restarted by index, the stream could land on a screen nobody shared.
///
/// `no-screen:lid` only when the lid is why: it changed within the grace
/// (`LidWatch::lid_changed_recently`), or the stream's own screen is the
/// built-in panel dark behind it (`own_screen_dark`). Otherwise
/// `no-screen:changed`. Being shut was enough until now, so a laptop DOCKED
/// with its lid closed all session, whose screens a monitor plugged in
/// renumbered, was told to connect again with the lid open: wrong advice,
/// since the lid had nothing to do with it.
fn changed_end(lid_changed_recently: bool, own_screen_dark: bool) -> &'static str {
    if lid_changed_recently || own_screen_dark {
        crate::virtual_screen::NO_SCREEN_LID
    } else {
        crate::virtual_screen::NO_SCREEN_CHANGED
    }
}

/// How a stream ends when its capture fails for good: "capture: …", which
/// the host app answers with a restart, unless the stream is PINNED and its
/// screen is no longer the one at its index (gone, moved, or replaced), when
/// a restart by index could land on another screen (`changed_end`).
fn capture_failed_end(
    pinned: bool,
    current: usize,
    current_output: Option<isize>,
    outs: &[puca_capture::OutputInfo],
    lid_changed_recently: bool,
    error: &str,
) -> String {
    let still_there = current_output.is_some_and(|h| outs.iter().any(|o| o.index == current && o.hmonitor == h));
    if pinned && !still_there {
        changed_end(lid_changed_recently, false).to_string()
    } else {
        format!("capture: {error}")
    }
}

/// Is a rebuild still wanted when its turn comes? Every one is, but a lid
/// move decided before the viewer's latest switch (`RebuildFor::Lid`): the
/// viewer's choice wins over a move decided on the screen it has left.
fn rebuild_still_wanted(why: RebuildFor, switches_now: u64) -> bool {
    match why {
        RebuildFor::Lid { switches } => switches == switches_now,
        RebuildFor::App | RebuildFor::SelfHeal => true,
    }
}

/// Must a lid rebuild onto `target` let go of the capture the stream holds
/// before it builds? Capture duplication is exclusive per output, so yes
/// whenever the build may need a screen the held capture duplicates: All
/// Displays (it opens every output), a held composite (it holds every
/// output), the same screen (by HMONITOR), or a screen whose identity is
/// unknown on either side. Any other build goes first, and the capture held
/// is let go only once it worked, so one that fails changes nothing. `held`
/// is None when the stream holds no capture, else whether it is the composite.
fn lid_rebuild_releases_first(
    target: usize,
    target_output: Option<isize>,
    held: Option<bool>,
    current_output: Option<isize>,
) -> bool {
    match held {
        None => false,
        Some(true) => true,
        Some(false) => {
            target == crate::composite::ALL_DISPLAYS
                || target_output.is_none()
                || current_output.is_none()
                || target_output == current_output
        }
    }
}

/// A keyframe was asked for: by the peer's PLI, or by the controller
/// (`RequestKeyframe`, e.g. an Android controller resumed with a reset
/// decoder).
///
/// Normally that is only `want_keyframe`: the pump answers it with the next
/// present or the held still. A switch still waiting for its first picture
/// holds NO still (adopt_new_capture dropped the old screen's), so once the
/// stranded-switch net has spent its three tries such a request could not be
/// answered at all until the screen repainted by itself. It starts a fresh
/// round then, paced as before (750 ms after the last try), so each round is
/// bounded by a request actually arriving. A round still running is not
/// extended. `have_picture` is `holds_whole_picture`: for All Displays, a
/// picture of every screen.
fn on_keyframe_request(
    want_keyframe: &mut bool,
    switch_pending: bool,
    have_picture: bool,
    stranded_repaints: &mut u8,
) {
    *want_keyframe = true;
    if switch_pending && !have_picture && *stranded_repaints >= 3 {
        *stranded_repaints = 0;
    }
}

/// Is the stranded-switch net (see `stranded_net_tick`) due to wake the
/// panel and provoke a present on this tick? `t0` is when the switch was
/// committed. It fires only while the stream holds no WHOLE picture to
/// re-send (`holds_whole_picture`): holding one means the pump already
/// answered the keyframe with it.
fn stranded_net_due(
    t0: Instant,
    stranded_repainted_at: Option<Instant>,
    stranded_repaints: u8,
    have_picture: bool,
    now: Instant,
) -> bool {
    let due = stranded_repainted_at.unwrap_or(t0) + Duration::from_millis(750);
    !have_picture && stranded_repaints < 3 && now >= due
}

/// Does the stream hold a WHOLE picture of what it now shows? The capture
/// answers (`AnyCapture::holds_whole_picture`: the held still of a single
/// screen, a picture on every tile of All Displays); with no capture in hand
/// (a failed rebuild left none) only a held still counts.
fn holds_whole_picture<C: crate::composite::ScreenSource>(
    capture: Option<&AnyCapture<C>>,
    have_last_frame: bool,
) -> bool {
    capture.map_or(have_last_frame, |c| c.holds_whole_picture(have_last_frame))
}

/// A frame went out. Is it the switch's first picture? Only when it is a
/// WHOLE picture of what the stream now shows (`holds_whole_picture`): then
/// the switch is over, the net stands down, and the switch's start comes back
/// for the `[switch] first frame` log.
///
/// An All Displays frame with a tile still black is not that picture. Taking
/// it as one is how switching into All Displays on a still screen stayed black
/// where the screen just left should be: the send ended the switch, and the
/// net, which runs only while a switch is pending, never provoked that screen
/// to present. Such a frame still goes out (the screens that did present are
/// worth showing), but the switch stays pending, so the net keeps fetching
/// the rest and a keyframe request can still re-arm it.
fn on_frame_sent(
    whole_picture: bool,
    switch_started: &mut Option<Instant>,
    stranded_repainted_at: &mut Option<Instant>,
) -> Option<Instant> {
    if !whole_picture {
        return None;
    }
    *stranded_repainted_at = None;
    switch_started.take()
}

/// How long a switch INTO All Displays holds out for a picture of every
/// screen before the pump re-sends the canvas it has (`canvas_is_a_picture`):
/// the stranded-switch net's three tries, 750 ms apart, and one more interval
/// for the last one's present to land. Past it, a screen that has still not
/// presented is shown black beside the others, rather than keeping All
/// Displays off the viewer until some screen happens to repaint.
const WHOLE_PICTURE_WAIT: Duration = Duration::from_millis(4 * 750);

/// Is a switch still holding out for its whole first picture? Asked only of
/// the composite, whose canvas can be partly painted; a single screen's
/// picture is whole or absent.
fn switch_awaits_whole_picture(switch_started: Option<Instant>, now: Instant) -> bool {
    switch_started.is_some_and(|t0| now.duration_since(t0) < WHOLE_PICTURE_WAIT)
}

/// The stranded-switch net, looked at from the event loop (the still tick,
/// and after a frame that went out without being the switch's whole
/// picture). When `stranded_net_due`, it wakes the panels and provokes a
/// present (repaint.rs) on every screen the switch is still waiting for
/// (`AnyCapture::awaited_screens`): the one screen of a single-screen switch,
/// or each All Displays tile still owing its first picture. Each try is
/// counted, paced and logged.
#[allow(clippy::too_many_arguments)]
fn stranded_net_tick(
    capture: Option<&AnyCapture>,
    current_monitor: usize,
    have_last_frame: bool,
    t0: Instant,
    now: Instant,
    stranded_repaints: &mut u8,
    stranded_repainted_at: &mut Option<Instant>,
    want_keyframe: &mut bool,
) {
    let Some(capture) = capture else { return };
    let have_picture = capture.holds_whole_picture(have_last_frame);
    if !stranded_net_due(t0, *stranded_repainted_at, *stranded_repaints, have_picture, now) {
        return;
    }
    let screens = capture.awaited_screens(current_monitor, have_last_frame);
    if screens.is_empty() {
        return;
    }
    *stranded_repaints += 1;
    *stranded_repainted_at = Some(now);
    *want_keyframe = true;
    #[cfg(windows)]
    crate::display_wake::nudge();
    // One provoked present per screen still missing. Each holds this thread
    // for repaint.rs's DWELL, and only on a try: at most three a round.
    let refused = screens.iter().filter(|&&m| !crate::repaint::provoke_present(m)).count();
    let tries = *stranded_repaints;
    match capture {
        AnyCapture::Single(_) => eprintln!(
            "[switch] no picture {} ms after commit: woke the panel and provoked a present ({tries}/3{})",
            t0.elapsed().as_millis(),
            if refused == 0 { "" } else { ", the nudge window was refused" }
        ),
        AnyCapture::Virtual(_) => eprintln!(
            "[switch] All Displays has no picture of screen(s) {screens:?} {} ms after commit: woke the panels and provoked a present on each ({tries}/3{})",
            t0.elapsed().as_millis(),
            if refused == 0 { String::new() } else { format!(", {refused} nudge window(s) refused") }
        ),
    }
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

/// The caret-channel line that tells the viewer a typed-text frame was
/// refused: `{"k":"refused","t":"text","why":"..."}`, the reason cut to 160
/// characters. JSON-escaped by serde, so a reason can never break the line.
fn refused_text_line(why: &str) -> Vec<u8> {
    let why: String = why.chars().take(160).collect();
    serde_json::json!({ "k": "refused", "t": "text", "why": why }).to_string().into_bytes()
}

/// At most one refusal report every half second: a long paste refused frame
/// after frame is one fact for the viewer, not fifty lines.
fn refusal_report_due(last: &mut Option<Instant>, now: Instant) -> bool {
    if last.is_some_and(|t| now.duration_since(t) < Duration::from_millis(500)) {
        return false;
    }
    *last = Some(now);
    true
}

/// What a pump is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PumpFor {
    /// The clock's tick: a new picture, or the held one re-sent for something
    /// waiting on a picture (a keyframe, the viewer fit).
    Tick,
    /// The clock's tick with a latency probe waiting (latency.rs): send a
    /// picture even of a still screen, and do not sit out the acquire wait
    /// for a change that is not coming — that wait would be in the reading.
    Probe,
    /// An early look for an input's change (latency.rs): a NEW picture or
    /// nothing, and no wait — the loop looks again in a couple of ms.
    Look,
}

impl PumpFor {
    /// How long the capture may wait for a new picture: the tick its usual
    /// 5 ms, a probe 1 ms (the wait would be in the reading), a look none.
    fn acquire_ms(self) -> u32 {
        match self {
            PumpFor::Tick => 5,
            PumpFor::Probe => 1,
            PumpFor::Look => 0,
        }
    }
}

/// Is something waiting for a picture, so that a still screen's HELD one is
/// re-sent? On the clock's tick: a keyframe, the viewer fit, or a probe.
/// Never for an early look, which takes a new picture or nothing.
fn needs_picture(why: PumpFor, want_keyframe: bool, fit_needs: bool) -> bool {
    why != PumpFor::Look && (want_keyframe || fit_needs || why == PumpFor::Probe)
}

/// A frame went out: does it end a blockage (a security screen owning the
/// display)? A real picture does. The HELD picture re-sent while the capture
/// still answers AccessLost — for a keyframe request, the fit or a probe —
/// does not: the blockage starts there if it had not, and its clock keeps
/// running toward the rebuild. Reading a re-send as the end of it reset that
/// clock on every probe (once a second), so the 5 s rebuild — the only
/// recovery for a lost D3D device — never came, and the secure-desktop notice
/// flipped off and on. True when this frame ends one.
/// Is the loop watching for an input's change (latency.rs) right now? Never
/// while a security screen blocks the capture: there is nothing to catch, and
/// every look asks DXGI to rebuild the lost duplication — two factories, an
/// adapter and output walk and a DuplicateOutput, per screen of a composite —
/// which input re-arming the watch made some 500 times a second, the loop
/// waking every 2 ms to do it. The same answer gates the look and the wake.
fn watching_for_change(now: Instant, watching_until: Option<Instant>, blocked_since: Option<Instant>) -> bool {
    blocked_since.is_none() && watching_until.is_some_and(|w| now < w)
}

/// May the loop take an early look now? Watching (above), and the floor and
/// clock rules of `latency::may_capture_early`.
fn early_look_allowed(
    now: Instant,
    watching_until: Option<Instant>,
    next_frame: Instant,
    last_frame_at: Option<Instant>,
    frame_interval: Duration,
    blocked_since: Option<Instant>,
) -> bool {
    watching_for_change(now, watching_until, blocked_since)
        && crate::latency::may_capture_early(now, watching_until, next_frame, last_frame_at, frame_interval)
}

fn pumped_ends_blockage(still_blocked: bool, blocked_since: &mut Option<Instant>, now: Instant) -> bool {
    if still_blocked {
        blocked_since.get_or_insert(now);
        false
    } else {
        blocked_since.take().is_some()
    }
}

/// A pump that put a frame through the encoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pumped {
    /// The writer took it.
    sent: bool,
    /// The capture is blocked (AccessLost) and the frame was the HELD picture,
    /// re-sent for something waiting on one: the security screen is still up.
    still_blocked: bool,
}

/// What the capture half of a pump found: there is a picture to encode, and
/// which kind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Picture {
    /// The capture is blocked (AccessLost) and the held picture goes out
    /// anyway, for something waiting on one.
    still_blocked: bool,
    /// Nothing was presented, and the held picture goes out because the
    /// pointer the HOST draws into it moved (`still_tick`).
    pointer_only: bool,
}

/// THE CAPTURE HALF OF A PUMP: bring the picture up to date, or say why
/// there is nothing to send. On `Ok` the picture to encode is the composite's
/// surface or, for a single screen, `last_frame`.
///
/// Generic over the screen (`ScreenSource`) and separate from `pump_frame`,
/// whose other half needs a real encoder and a peer connection, so every
/// decision in here is exercised with scripted screens.
fn refresh_picture<C: crate::composite::ScreenSource>(
    capture: &mut AnyCapture<C>,
    last_frame: &mut Option<puca_capture::Frame>,
    // Something WAITING for a picture (`needs_picture`).
    need_picture: bool,
    // The host draws the pointer into the picture (no controller owns it).
    host_draws: bool,
    acquire_ms: u32,
    session_cold: bool,
    // A switch is still holding out for its whole first picture
    // (switch_awaits_whole_picture). Only the composite's rule reads it.
    switch_waiting: bool,
    // The screen a single-screen picture must be of, by handle, or None for
    // any (`screen_pin`).
    pin: Option<isize>,
) -> Result<Picture, PumpError> {
    let blocked = Picture { still_blocked: true, pointer_only: false };
    match capture {
        AnyCapture::Virtual(v) => {
            // What counts as "holding a picture": `canvas_is_a_picture`,
            // which asks which tiles have one. Never a canvas no tile has
            // painted: COLD, re-sending that birth zero-fill encoded a BLACK
            // keyframe that counted as delivery and disabled the
            // sleeping-display wake escalation exactly when it was needed;
            // WARM, it used to be sent anyway (a constant `true`), and a
            // switch into All Displays on a still screen showed black where
            // the screen just left should be. That screen now brings its
            // held picture into the composite (VirtualCapture::adopt), and
            // while a switch waits for the whole picture a partly painted
            // canvas is not re-sent either; the stranded-switch net fetches
            // the screens still missing.
            let holding = v.holds_picture(session_cold, switch_waiting);
            match v.refresh(acquire_ms) {
                Ok(()) => {
                    // Some screen presented. The pointer may be over one that
                    // did not, whose tile `refresh` left as it was.
                    if host_draws {
                        v.redraw_cursors();
                    }
                    Ok(Picture::default())
                }
                // NO SCREEN PRESENTED, AND ONE IS LOST: a security screen
                // over all of them, or ONE screen in exclusive fullscreen or
                // showing protected content beside screens that are merely
                // still. The pointer over a still one still moves (its capture
                // folds the pointer-only update in), and it used to stand
                // frozen there, since only a Timeout brought it up to date.
                // A moved pointer re-sends the canvas still marked blocked, so
                // the blockage's clock keeps running. Behind a security screen
                // nothing moves (no duplication reports a pointer), and this
                // is the blockage it always was.
                Err(CaptureError::AccessLost) => {
                    let pointer = host_draws && holding && v.redraw_cursors();
                    if should_resend_still(need_picture || pointer, holding) {
                        Ok(Picture { still_blocked: true, pointer_only: pointer })
                    } else {
                        Err(PumpError::SecureDesktop)
                    }
                }
                // STILL SCREEN — see the long note on the Single arm below.
                // Same rules, same functions: an inline copy of a condition
                // meant the test covered one arm of two.
                Err(CaptureError::Timeout) => {
                    match still_tick(need_picture, holding, host_draws, || v.redraw_cursors()) {
                        StillTick::NoChange => Err(PumpError::NoChange),
                        StillTick::Resend { pointer } => Ok(Picture { still_blocked: false, pointer_only: pointer }),
                    }
                }
                Err(e) => Err(PumpError::CaptureFailed(e.to_string())),
            }
        }
        AnyCapture::Single(c) => {
            let got = c.next_frame(acquire_ms);
            // ANOTHER SCREEN, IN THE CAPTURE THIS STREAM HOLDS: it rebuilds a lost
            // duplication by index, and anything that renumbers the outputs (a
            // panel leaving the desktop as its lid shuts, a monitor unplugged)
            // can put another screen at that index (`ScreenCapture::screen`). For
            // a stream PINNED to its screen that ends it, before anything of it
            // goes out: not its picture, not the held one re-sent, not a pointer
            // it moved. Asked after every poll, whatever it answered, because the
            // duplication is rebuilt inside the poll; and always, not only around
            // the lid, whose state arrives on its own clock or not at all.
            if pin.is_some_and(|want| c.screen() != Some(want)) {
                return Err(PumpError::ScreenChanged);
            }
            match got {
                Ok(f) => {
                    *last_frame = Some(f);
                    Ok(Picture::default())
                }
                // A STILL SCREEN PRODUCES NOTHING, and that used to mean the
                // stream produced nothing either — which is fine while a picture
                // is already on the wire and disastrous straight after the
                // encoder is rebuilt. A monitor switch or a quality change drops
                // the encoder, and the replacement needs frames before it emits
                // anything; if the destination screen happens to be static, the
                // only frames it can ever get are the ones the user creates by
                // moving something on it. That is the ten-second monitor switch,
                // the composite that never appears, and every unanswered keyframe
                // request: the agent was waiting for the desktop, and the desktop
                // was waiting for the user.
                //
                // So while a keyframe is outstanding, re-send the last picture we
                // captured. It is the same image, which is exactly what a still
                // screen means. And while the host draws the pointer, a pointer
                // that moved over it makes it a new picture (`still_tick`).
                Err(CaptureError::AccessLost) if should_resend_still(need_picture, last_frame.is_some()) => {
                    Ok(blocked)
                }
                Err(CaptureError::AccessLost) => Err(PumpError::SecureDesktop),
                Err(CaptureError::Timeout) => {
                    let holding = last_frame.is_some();
                    let redraw = || last_frame.as_mut().is_some_and(|f| c.redraw_cursor(f));
                    match still_tick(need_picture, holding, host_draws, redraw) {
                        StillTick::NoChange => Err(PumpError::NoChange),
                        StillTick::Resend { pointer } => Ok(Picture { still_blocked: false, pointer_only: pointer }),
                    }
                }
                Err(e) => Err(PumpError::CaptureFailed(e.to_string())),
            }
        }
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
    // A switch is still holding out for its whole first picture
    // (switch_awaits_whole_picture). Only the composite's rule reads it.
    switch_waiting: bool,
    // The viewer's stage (device px) or None, and the fit's state across
    // frames (composite::FitState).
    view: Option<(u32, u32)>,
    fit: &mut crate::composite::FitState,
    // What this pump is for: the clock's tick, the tick a latency probe is
    // waiting on, or an early look for an input's change (PumpFor).
    why: PumpFor,
    // The host draws the pointer into the picture: no controller owns it.
    host_draws: bool,
    // The screen a single-screen picture must be of (`screen_pin`).
    pin: Option<isize>,
) -> Result<Pumped, PumpError> {
    let t_capture = Instant::now();
    // Something WAITING for a picture: a keyframe (a rebuilt encoder, a peer's
    // request), the viewer fit (a stage change, a step settling) or a latency
    // probe. Each is a reason to re-send the held picture of a still screen —
    // on the clock's tick. An early look takes a NEW picture or nothing (and
    // a pointer the host draws, moved, is a new picture).
    let need_picture = needs_picture(why, *want_keyframe, fit.needs_frame());
    let picture = refresh_picture(
        capture, last_frame, need_picture, host_draws, why.acquire_ms(), session_cold, switch_waiting, pin,
    )?;
    let still_blocked = picture.still_blocked;
    // BORROWED, not owned. The composite path used to hand back a cloned
    // canvas every tick — 56 MB per frame on a three-screen desktop, competing
    // for memory bandwidth with the encoder that is about to read it.
    let owned;
    let (fw, fh, fstride, fbytes): (u32, u32, usize, &[u8]) = match capture {
        AnyCapture::Virtual(v) => v.surface(),
        AnyCapture::Single(_) => {
            owned = last_frame.as_ref().expect("refresh_picture holds a picture whenever it answers Ok");
            (owned.width, owned.height, owned.stride, &owned.bgra)
        }
    };

    let capture_took = t_capture.elapsed();

    // FIT TO THE VIEWER. Applied to BOTH arms — a single screen and the
    // composite canvas alike — after the picture is in hand, so one rule
    // covers every capture and a monitor switch re-derives it from the new
    // size on the next frame. Input, the caret and the cursor are all
    // normalised over the captured rectangle, so a smaller picture changes
    // nothing they compute (bar the trailing partial block, see paste_tile).
    // The decision, its hysteresis and its cost guard live in FitState so
    // they are tested without a capture.
    let t_fit = Instant::now();
    let fitted_now = fit.apply(view, fw, fh, fstride, fbytes, now);
    let (fw, fh, fstride) = (fitted_now.w, fitted_now.h, fitted_now.stride);
    let fbytes: &[u8] = if fitted_now.from_buffer { &fit.buf[..] } else { fbytes };
    let fit_took = t_fit.elapsed();

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
            stats.pointer += u32::from(picture.pointer_only);
            stats.capture.add(capture_took);
            stats.fit.add(fit_took);
            if fitted_now.step > 1 {
                fit.note_cost(fit_took, fps);
            }
            stats.encode.add(encode_took);
            stats.send.add(t_send.elapsed());
            Ok(Pumped { sent, still_blocked })
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
    #[test]
    fn a_resend_during_a_blockage_does_not_end_it() {
        use super::{pumped_ends_blockage, should_rebuild_capture};
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let mut blocked = None;
        // The first blocked tick re-sent the held picture (a keyframe wanted).
        assert!(!pumped_ends_blockage(true, &mut blocked, t0));
        assert_eq!(blocked, Some(t0), "the blockage starts there");
        // A probe a second for six seconds, each answered with the held picture.
        for s in 1..=6 {
            assert!(!pumped_ends_blockage(true, &mut blocked, t0 + Duration::from_secs(s)));
        }
        assert_eq!(blocked, Some(t0), "its clock never restarted");
        assert!(should_rebuild_capture(t0, None, t0 + Duration::from_secs(6)), "so the rebuild comes");
        // A real picture ends it, once.
        assert!(pumped_ends_blockage(false, &mut blocked, t0 + Duration::from_secs(7)));
        assert_eq!(blocked, None);
        assert!(!pumped_ends_blockage(false, &mut blocked, t0 + Duration::from_secs(8)));
    }

    #[test]
    fn a_refused_text_frame_is_reported_on_the_caret_channel_at_most_twice_a_second() {
        use super::{refusal_report_due, refused_text_line};
        use std::time::{Duration, Instant};
        let line = String::from_utf8(refused_text_line("text contains the control character '\u{85}'")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).expect("one JSON line");
        assert_eq!(v["k"], "refused");
        assert_eq!(v["t"], "text");
        assert!(v["why"].as_str().unwrap().contains("control character"));
        let long = "x".repeat(1000);
        let v: serde_json::Value = serde_json::from_slice(&refused_text_line(&long)).unwrap();
        assert_eq!(v["why"].as_str().unwrap().chars().count(), 160, "cut short");
        let t0 = Instant::now();
        let mut last = None;
        assert!(refusal_report_due(&mut last, t0));
        assert!(!refusal_report_due(&mut last, t0 + Duration::from_millis(100)));
        assert!(!refusal_report_due(&mut last, t0 + Duration::from_millis(499)));
        assert!(refusal_report_due(&mut last, t0 + Duration::from_millis(500)));
    }

    #[test]
    fn a_blocked_capture_is_looked_at_once_not_hundreds_of_times_a_second() {
        // The loop's own decisions over a simulated second: input every 8 ms
        // re-arms the watch, and the capture answers AccessLost (a security
        // screen is up). The first early look meets the blockage and records
        // it, as the loop's SecureDesktop arm for a look does; the tick's arm
        // keeps it; after that nothing but the tick touches the capture.
        use super::{early_look_allowed, watching_for_change};
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let interval = Duration::from_millis(33);
        let mut next_frame = t0 + interval;
        let mut watching: Option<Instant> = None;
        let mut blocked: Option<Instant> = None;
        let last_frame_at = t0.checked_sub(Duration::from_secs(5));
        let (mut looks, mut wakes) = (0, 0);
        for ms in 0..1000u64 {
            let now = t0 + Duration::from_millis(ms);
            if ms % 8 == 0 {
                watching = Some(now + crate::latency::WATCH_FOR);
            }
            if now >= next_frame {
                next_frame += interval;
                blocked.get_or_insert(now);
                continue;
            }
            if watching_for_change(now, watching, blocked) {
                wakes += 1;
            }
            if early_look_allowed(now, watching, next_frame, last_frame_at, interval, blocked) {
                looks += 1;
                blocked.get_or_insert(now);
            }
        }
        assert!(looks <= 1, "{looks} looks at a blocked capture");
        assert!(wakes <= 1, "the loop kept waking to look: {wakes}");
        // CONTROL: unblocked, the same input does keep the watch (and its looks) going.
        let watching = Some(t0 + crate::latency::WATCH_FOR);
        assert!(watching_for_change(t0, watching, None));
        assert!(early_look_allowed(t0, watching, t0 + interval, last_frame_at, interval, None));
    }

    #[test]
    fn an_early_look_takes_a_new_picture_or_nothing() {
        use super::{needs_picture, PumpFor};
        assert!(!needs_picture(PumpFor::Look, true, true), "never the held picture re-sent");
        assert_eq!(PumpFor::Look.acquire_ms(), 0, "and no wait: the loop looks again soon");
        assert!(needs_picture(PumpFor::Probe, false, false), "a probe gets a picture of a still screen");
        assert_eq!(PumpFor::Probe.acquire_ms(), 1);
        assert!(needs_picture(PumpFor::Tick, true, false));
        assert!(needs_picture(PumpFor::Tick, false, true));
        assert!(!needs_picture(PumpFor::Tick, false, false));
        assert_eq!(PumpFor::Tick.acquire_ms(), 5);
    }

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

    /// str0m 0.23's `MAX_BUFFERED_ACROSS_STREAMS`: a data-channel write longer
    /// than this is refused (`Ok(false)`) on every attempt, forever. Spelled
    /// out here so the tests pin str0m's fact, not the product's constant.
    const STR0M_SEND_BUDGET: usize = 128 * 1024;

    /// THE WEDGE. A reply longer than str0m's send budget was queued like any
    /// other, refused on every flush, and never popped — so it sat at the
    /// head of the FIFO and every later file reply in that session queued
    /// behind it until the session died. Whatever produced it, a reply that
    /// can never be sent must become an ANSWER: an error carrying the same id,
    /// so the client stops waiting and the queue keeps moving.
    #[test]
    fn a_reply_that_can_never_be_sent_becomes_an_error_with_the_same_id() {
        let huge = crate::file_transfer::FsResponse::Data { data: "A".repeat(200_000) };

        let with = encode_fs_reply(&huge, Some(42)).expect("encodes");
        assert!(
            with.len() <= STR0M_SEND_BUDGET,
            "a {}-byte reply would wedge the file queue forever",
            with.len()
        );
        let v: serde_json::Value = serde_json::from_slice(&with).unwrap();
        assert_eq!(v.get("ok").and_then(|x| x.as_str()), Some("error"));
        assert_eq!(v.get("id").and_then(|x| x.as_u64()), Some(42), "the SAME id, or the client keeps waiting");

        // An id-less (older) client matches by order: still an answer, still id-less.
        let without = encode_fs_reply(&huge, None).expect("encodes");
        assert!(without.len() <= STR0M_SEND_BUDGET);
        let v: serde_json::Value = serde_json::from_slice(&without).unwrap();
        assert_eq!(v.get("ok").and_then(|x| x.as_str()), Some("error"));
        assert!(v.get("id").is_none());
    }

    /// Positive control: the replacement is about SIZE. A big reply that DOES
    /// fit (a full 64 KiB read is ~87 KB framed) goes out byte-for-byte.
    #[test]
    fn a_reply_that_fits_is_sent_unchanged() {
        let big = crate::file_transfer::FsResponse::Data { data: "A".repeat(100_000) };
        let bytes = encode_fs_reply(&big, Some(7)).expect("encodes");
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v.get("ok").and_then(|x| x.as_str()), Some("data"));
        assert_eq!(v.get("data").and_then(|x| x.as_str()).map(str::len), Some(100_000));
        assert_eq!(v.get("id").and_then(|x| x.as_u64()), Some(7));
    }

    /// The rule the flush applies to its queue head (`admit_fs_reply` on raw
    /// bytes): an unsendable reply is replaced by an error carrying the id
    /// read back out of it, and a sendable one is left byte-for-byte alone.
    /// The flush loop itself is driven by the `flush_*` tests below.
    #[test]
    fn the_queue_head_rule_reads_the_id_back_out_of_the_bytes() {
        let raw = encode_fs_reply_unchecked(
            &crate::file_transfer::FsResponse::Data { data: "B".repeat(STR0M_SEND_BUDGET) },
            Some(u64::MAX),
        )
        .unwrap();
        assert!(raw.len() > STR0M_SEND_BUDGET, "fixture: the head must be unsendable");
        let fixed = admit_fs_reply(raw);
        assert!(fixed.len() <= STR0M_SEND_BUDGET);
        let v: serde_json::Value = serde_json::from_slice(&fixed).unwrap();
        assert_eq!(v.get("ok").and_then(|x| x.as_str()), Some("error"));
        assert_eq!(v.get("id").and_then(|x| x.as_u64()), Some(u64::MAX));

        // Exactly at the budget is sendable (str0m refuses only LONGER).
        let mut at = encode_fs_reply_unchecked(
            &crate::file_transfer::FsResponse::Data { data: String::new() },
            Some(1),
        )
        .unwrap();
        let pad = STR0M_SEND_BUDGET - at.len();
        at = encode_fs_reply_unchecked(
            &crate::file_transfer::FsResponse::Data { data: "C".repeat(pad) },
            Some(1),
        )
        .unwrap();
        assert_eq!(at.len(), STR0M_SEND_BUDGET);
        assert_eq!(admit_fs_reply(at.clone()), at, "a reply at the limit goes out unchanged");
    }

    /// A stand-in for str0m's `Channel::write`: refuses (`Ok(false)`) anything
    /// longer than its send budget, every time, and records what it sent.
    fn str0m_like_writer(sent: &mut Vec<(u8, Vec<u8>)>) -> impl FnMut(u8, &[u8]) -> Option<Result<bool, String>> + '_ {
        move |cid, bytes| {
            if bytes.len() > STR0M_SEND_BUDGET {
                return Some(Ok(false));
            }
            sent.push((cid, bytes.to_vec()));
            Some(Ok(true))
        }
    }

    /// THE WEDGE, through the flush loop itself: an unsendable reply at the
    /// head of the queue (however it got there) is answered with an error for
    /// its own id, and the reply queued behind it still goes out, in order.
    #[test]
    fn flush_an_unsendable_head_does_not_wedge_the_replies_behind_it() {
        let huge = encode_fs_reply_unchecked(
            &crate::file_transfer::FsResponse::Data { data: "D".repeat(STR0M_SEND_BUDGET) },
            Some(7),
        )
        .unwrap();
        assert!(huge.len() > STR0M_SEND_BUDGET, "fixture: the head must be unsendable");
        let small = encode_fs_reply(&crate::file_transfer::FsResponse::error("x"), Some(8)).unwrap();
        let mut queue = std::collections::VecDeque::from([(1u8, huge), (1u8, small.clone())]);

        let mut sent = Vec::new();
        flush_fs_replies(&mut queue, str0m_like_writer(&mut sent));

        assert!(queue.is_empty(), "{} replies still stuck in the queue", queue.len());
        assert_eq!(sent.len(), 2);
        let first: serde_json::Value = serde_json::from_slice(&sent[0].1).unwrap();
        assert_eq!(first.get("ok").and_then(|x| x.as_str()), Some("error"));
        assert_eq!(first.get("id").and_then(|x| x.as_u64()), Some(7), "the unsendable request is ANSWERED");
        assert_eq!(sent[1].1, small, "and the next reply goes out unchanged, after it");
    }

    /// Positive control for the loop's other arms: a head with no room yet
    /// stays queued (and blocks those behind it — FIFO is the id-less match
    /// rule); a gone channel or a failed write drops just that reply.
    #[test]
    fn flush_waits_on_no_room_and_drops_gone_or_failed_replies() {
        let a = encode_fs_reply(&crate::file_transfer::FsResponse::error("a"), Some(1)).unwrap();
        let b = encode_fs_reply(&crate::file_transfer::FsResponse::error("b"), Some(2)).unwrap();

        let mut queue = std::collections::VecDeque::from([(1u8, a.clone()), (1u8, b.clone())]);
        let mut calls = 0;
        flush_fs_replies(&mut queue, |_, _| {
            calls += 1;
            Some(Ok(false))
        });
        assert_eq!(calls, 1, "stops at the first reply with no room");
        assert_eq!(queue.len(), 2, "and keeps both, in order");
        assert_eq!(queue[0].1, a, "a sendable head is never rewritten");

        let mut seen = Vec::new();
        flush_fs_replies(&mut queue, |cid, bytes| {
            seen.push(bytes.to_vec());
            if seen.len() == 1 { None } else { Some(Err(format!("channel {cid} closed"))) }
        });
        assert!(queue.is_empty());
        assert_eq!(seen, vec![a, b]);
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
        let addrs = local_interfaces(45678, &[]);
        assert!(!addrs.is_empty());
        assert!(addrs.iter().all(|a| a.port() == 45678), "every candidate uses the bound port");
        assert!(
            addrs.iter().any(|a| a.ip().is_loopback()),
            "loopback must be offered so a same-machine peer works with no network"
        );
    }

    /// The routing table measured on the machine that produced the bug report:
    /// Mullvad holds the default route, so the internet leaves by the tunnel,
    /// while the phone on the same LAN is reached from the Ethernet address.
    fn vpn_routes(dest: SocketAddr) -> Option<std::net::IpAddr> {
        match dest.ip().to_string().as_str() {
            // The phone, and anything else on the LAN.
            ip if ip.starts_with("192.168.0.") => Some([192, 168, 0, 22].into()),
            // Everything else goes down the tunnel.
            _ => Some([10, 169, 229, 126].into()),
        }
    }
    fn vpn_default_route() -> Option<std::net::IpAddr> {
        Some([10, 169, 229, 126].into())
    }

    /// THE DEFECT, reproduced. The host candidates must include the address
    /// that reaches the PEER, not only the one that reaches the internet. With
    /// a VPN holding the default route those differ, and advertising only the
    /// latter left a phone on the same LAN no direct pair to use: the session
    /// fell back to the phone's TURN relay at 99 ms RTT and 3% loss, against
    /// 2-7 ms on the LAN.
    #[test]
    fn the_lan_address_is_advertised_even_when_a_vpn_holds_the_default_route() {
        let phone: SocketAddr = "192.168.0.155:42767".parse().unwrap();
        let addrs = collect_candidates(45678, &[phone], vpn_routes, vpn_default_route);
        assert!(
            addrs.iter().any(|a| a.ip() == std::net::IpAddr::from([192, 168, 0, 22])),
            "the LAN address that reaches the phone must be advertised, got {addrs:?}"
        );
        // And the tunnel address stays: a peer that is genuinely remote is
        // reached through it, and it is the base for reflexive/relayed candidates.
        assert!(
            addrs.iter().any(|a| a.ip() == std::net::IpAddr::from([10, 169, 229, 126])),
            "the default route is still offered, got {addrs:?}"
        );
        assert!(addrs.iter().all(|a| a.port() == 45678));
    }

    /// The LAN address must come FIRST, so it leads the candidate list rather
    /// than trailing the tunnel address it exists to beat.
    #[test]
    fn the_peer_routed_address_leads_the_list() {
        let phone: SocketAddr = "192.168.0.155:42767".parse().unwrap();
        let addrs = collect_candidates(45678, &[phone], vpn_routes, vpn_default_route);
        assert_eq!(addrs.first().map(|a| a.ip()), Some([192, 168, 0, 22].into()));
    }

    /// A peer this machine cannot route to must add nothing, and must not stop
    /// the ordinary candidates being offered.
    #[test]
    fn an_unroutable_peer_adds_nothing_and_breaks_nothing() {
        let addrs = collect_candidates(
            45678,
            &["203.0.113.9:9".parse().unwrap()],
            |_| None,
            vpn_default_route,
        );
        assert!(!addrs.is_empty(), "the default route and loopback still stand");
        assert!(addrs.iter().any(|a| a.ip().is_loopback()));
        assert!(addrs.iter().all(|a| !a.ip().is_unspecified()));
    }

    /// A route that answers with the wildcard is not an address.
    #[test]
    fn an_unspecified_route_is_never_advertised() {
        let addrs = collect_candidates(
            45678,
            &["192.168.0.155:9".parse().unwrap()],
            |_| Some([0, 0, 0, 0].into()),
            || Some([0, 0, 0, 0].into()),
        );
        assert!(
            addrs.iter().all(|a| !a.ip().is_unspecified()),
            "got {addrs:?}"
        );
        assert!(addrs.iter().any(|a| a.ip().is_loopback()), "loopback still offered");
    }

    /// Loopback is appended unconditionally, so a loopback ROUTE must not add a
    /// second copy — and must not be what makes the peer probe look wired up.
    #[test]
    fn a_loopback_route_does_not_duplicate_the_loopback_candidate() {
        let addrs = collect_candidates(
            45678,
            &["127.0.0.1:9".parse().unwrap()],
            |_| Some([127, 0, 0, 1].into()),
            || None,
        );
        assert_eq!(
            addrs.iter().filter(|a| a.ip().is_loopback()).count(),
            1,
            "one loopback candidate, got {addrs:?}"
        );
    }

    /// Several peer candidates usually share one route; the same address twice
    /// is two pointless streams of connectivity checks.
    #[test]
    fn the_same_route_is_advertised_once() {
        let peers: Vec<SocketAddr> = vec![
            "192.168.0.155:42767".parse().unwrap(),
            "192.168.0.155:53312".parse().unwrap(),
        ];
        let addrs = collect_candidates(45678, &peers, vpn_routes, vpn_default_route);
        assert_eq!(
            addrs.iter().filter(|a| a.ip() == std::net::IpAddr::from([192, 168, 0, 22])).count(),
            1,
            "one LAN candidate, got {addrs:?}"
        );
    }

    /// THE TRICKLE PATH, which is the one that actually fires in the field.
    ///
    /// The controller sends its offer the moment setLocalDescription resolves
    /// and trickles candidates afterwards, so at gather time the offer names
    /// nobody: fixing only the startup probe fixed nothing. When the phone's
    /// address finally arrives, the LAN route it implies must be advertised.
    #[test]
    fn a_trickled_peer_address_adds_the_host_candidate_that_reaches_it() {
        let phone: SocketAddr = "192.168.0.155:42767".parse().unwrap();
        // What the VPN'd host offered at gather time: tunnel + loopback only.
        let advertised: Vec<SocketAddr> =
            vec!["10.169.229.126:45678".parse().unwrap(), "127.0.0.1:45678".parse().unwrap()];
        assert_eq!(
            peer_routed_candidate(phone, &advertised, 45678, vpn_routes),
            Some("192.168.0.22:45678".parse().unwrap()),
            "the LAN address must be added when the peer's candidate arrives"
        );
    }

    /// The peer's SECOND candidate shares the route, and re-adding an address
    /// str0m already holds would re-pair it against every remote candidate for
    /// nothing.
    #[test]
    fn a_route_already_advertised_is_not_added_twice() {
        let phone: SocketAddr = "192.168.0.155:53312".parse().unwrap();
        let advertised: Vec<SocketAddr> = vec!["192.168.0.22:45678".parse().unwrap()];
        assert_eq!(peer_routed_candidate(phone, &advertised, 45678, vpn_routes), None);
    }

    /// A peer reached over the default route adds nothing: that address was
    /// offered at gather time, so a genuinely remote controller costs no
    /// extra candidate and no extra connectivity checks.
    #[test]
    fn a_remote_peer_over_the_default_route_adds_nothing() {
        let far: SocketAddr = "203.0.113.7:3478".parse().unwrap();
        let advertised: Vec<SocketAddr> = vec!["10.169.229.126:45678".parse().unwrap()];
        assert_eq!(peer_routed_candidate(far, &advertised, 45678, vpn_routes), None);
    }

    /// An unroutable or loopback-routed peer must never become a candidate.
    #[test]
    fn an_unroutable_or_loopback_peer_adds_no_candidate() {
        let p: SocketAddr = "192.168.0.155:1".parse().unwrap();
        assert_eq!(peer_routed_candidate(p, &[], 45678, |_| None), None);
        assert_eq!(
            peer_routed_candidate(p, &[], 45678, |_| Some([127, 0, 0, 1].into())),
            None
        );
        assert_eq!(
            peer_routed_candidate(p, &[], 45678, |_| Some([0, 0, 0, 0].into())),
            None
        );
    }

    /// A v6 peer cannot be answered from the v4 socket this stream binds, so it
    /// must not produce a candidate that could only ever fail its checks. This
    /// one exercises the REAL probe, which is where that rule lives.
    #[test]
    fn a_v6_peer_is_not_advertised_from_the_v4_socket() {
        assert_eq!(source_addr_for("[::1]:9".parse().unwrap()), None);
    }

    /// The real probe, against the one destination whose route every machine
    /// has: it must answer with loopback, proving the probe is wired to the OS
    /// at all (the injected tests above cannot show that).
    #[test]
    fn the_real_probe_resolves_a_route() {
        assert_eq!(
            source_addr_for("127.0.0.1:9".parse().unwrap()),
            Some(std::net::IpAddr::from([127, 0, 0, 1]))
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
        assert!(start("not an sdp", 0, None, 30, 2_000_000, (0, 0), StreamMode::Video, &[], tx, "s".into(), 1, None, false, HeldScreens::default()).is_err());
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

    /// A SWITCH MUST NOT SEND THE SCREEN IT LEFT.
    ///
    /// The held still-frame is a picture of the capture it came from. Kept
    /// across a committed switch, the pump answered the switch's keyframe on a
    /// still destination screen with the OLD screen's picture (A), counted it
    /// as the switch's first frame, and so disarmed the stranded-switch net —
    /// which only fires while nothing is held. The viewer looked at A while
    /// every click was aimed at B, until B repainted by itself.
    ///
    /// Walked here with the loop's own decision functions: the pump's still-
    /// screen rule (`should_resend_still`) and the net (`stranded_net_due`).
    #[test]
    fn a_committed_switch_does_not_resend_the_previous_screens_still() {
        let t = Instant::now();
        // A settled stream on screen 0 holding its picture, with a previous
        // switch's net long finished.
        let mut current_monitor = 0usize;
        let mut current_output = Some(0x10001isize);
        let mut last_frame = Some("screen 0's picture");
        let mut want_keyframe = false;
        let mut switch_started = None;
        let mut stranded_repaints = 3u8;
        let mut stranded_repainted_at = Some(t);

        adopt_new_capture(
            &mut current_monitor, &mut current_output, 1, Some(0x10003),
            &mut last_frame, &mut want_keyframe, &mut switch_started,
            &mut stranded_repaints, &mut stranded_repainted_at, t,
        );

        assert_eq!((current_monitor, current_output), (1, Some(0x10003)), "the stream is on screen 1 now");
        assert!(want_keyframe, "the new screen needs a keyframe");
        // The pump's still-screen tick on screen 1 (next_frame -> Timeout).
        assert!(
            !should_resend_still(want_keyframe, last_frame.is_some()),
            "a still screen 1 must not be answered with screen 0's picture (held: {last_frame:?})",
        );
        // So the tick is NoChange, and the net is what gets screen 1 a picture.
        let t0 = switch_started.expect("the switch arms the net");
        assert!(
            !stranded_net_due(t0, stranded_repainted_at, stranded_repaints, last_frame.is_some(), t),
            "the net waits its 750 ms before the first try",
        );
        assert!(
            stranded_net_due(
                t0, stranded_repainted_at, stranded_repaints, last_frame.is_some(),
                t + Duration::from_millis(750),
            ),
            "a still screen 1 must get the net's provoked present at 750 ms \
             (held: {last_frame:?}, tries so far: {stranded_repaints})",
        );
    }

    /// A REBUILD OF THE SAME SCREEN KEEPS ITS PICTURE; A REBUILD ONTO ANOTHER
    /// SCREEN IS A SWITCH.
    ///
    /// RebuildCapture drops the encoder and is mostly a same-screen rebuild
    /// after a display-mode change. There the held frame IS the right picture
    /// and the only thing that can feed the new encoder on a still screen —
    /// dropping it would bring back the ten-second freeze, with no net armed
    /// to rescue it. When the topology remap lands on a different screen, the
    /// held frame is the wrong screen's, exactly as in a switch.
    #[test]
    fn a_rebuild_keeps_its_still_only_for_the_same_screen() {
        let t = Instant::now();

        // Same screen (same index, same HMONITOR): keep the picture, re-send
        // it, no switch.
        let mut current_monitor = 2usize;
        let mut current_output = Some(0x10005isize);
        let mut last_frame = Some("screen 2's picture");
        let mut want_keyframe = false;
        let mut switch_started = None;
        let mut stranded_repaints = 0u8;
        let mut stranded_repainted_at = None;
        adopt_new_capture(
            &mut current_monitor, &mut current_output, 2, Some(0x10005),
            &mut last_frame, &mut want_keyframe, &mut switch_started,
            &mut stranded_repaints, &mut stranded_repainted_at, t,
        );
        assert!(
            should_resend_still(want_keyframe, last_frame.is_some()),
            "a same-screen rebuild must re-send the held picture to the new encoder",
        );
        assert_eq!(switch_started, None, "a same-screen rebuild is not a switch");

        // Another screen: exactly the switch rule.
        let mut last_frame = Some("screen 2's picture");
        let mut want_keyframe = false;
        let mut switch_started = None;
        adopt_new_capture(
            &mut current_monitor, &mut current_output, 0, Some(0x10001),
            &mut last_frame, &mut want_keyframe, &mut switch_started,
            &mut stranded_repaints, &mut stranded_repainted_at, t,
        );
        assert_eq!(current_monitor, 0, "the rebuild moved the stream onto screen 0");
        assert!(
            !should_resend_still(want_keyframe, last_frame.is_some()),
            "a rebuild onto screen 0 must not send screen 2's picture",
        );
        let t0 = switch_started.expect("a rebuild onto another screen arms the net");
        assert!(stranded_net_due(
            t0, stranded_repainted_at, stranded_repaints, last_frame.is_some(),
            t + Duration::from_millis(750),
        ));
    }

    /// THE SAME INDEX IS NOT THE SAME SCREEN.
    ///
    /// A monitor index is a position in the DXGI walk. Two screens, the
    /// session streaming index 0; index 0 detaches (a panel sleeping after the
    /// user walks away), so the other screen becomes index 0. The self-heal
    /// remaps 0 -> 0 because index 0 is still present, and an index-only
    /// comparison called that a same-screen rebuild: the VANISHED screen's
    /// picture was kept and re-sent as the rebuilt encoder's IDR while input
    /// went to the remaining screen, with no net armed. Walked with the
    /// loop's own functions, from the two enumerations.
    #[test]
    fn a_rebuild_onto_a_screen_that_shifted_into_the_index_is_a_switch() {
        let out = |index: usize, left: i32, hmonitor: isize| puca_capture::OutputInfo {
            index,
            left,
            top: 0,
            width: 1920,
            height: 1080,
            hmonitor,
            rotation: puca_capture::Rotation::None,
        };
        let before = [out(0, 0, 0x10001), out(1, 1920, 0x10003)];
        // Output 0 detached; the old output 1 is now the only one, at index 0
        // (and, as Windows re-lays out the desktop, at the origin): the same
        // index and the same rectangle, but not the same screen.
        let after = [out(0, 0, 0x10003)];

        let t = Instant::now();
        let mut current_monitor = 0usize;
        let mut current_output = screen_identity(&before, 0);
        let mut last_frame = Some("the detached screen's picture");
        let mut want_keyframe = false;
        let mut switch_started = None;
        let mut stranded_repaints = 0u8;
        let mut stranded_repainted_at = None;

        let present: Vec<usize> = after.iter().map(|o| o.index).collect();
        let target = crate::topology::remap_monitor_for(current_monitor, &present);
        assert_eq!(target, 0, "the remap keeps the index, which is the trap");
        adopt_new_capture(
            &mut current_monitor, &mut current_output, target, screen_identity(&after, target),
            &mut last_frame, &mut want_keyframe, &mut switch_started,
            &mut stranded_repaints, &mut stranded_repainted_at, t,
        );

        assert!(
            !should_resend_still(want_keyframe, last_frame.is_some()),
            "the rebuilt encoder must not be fed a screen that is gone (held: {last_frame:?})",
        );
        let t0 = switch_started.expect("landing on another screen arms the stranded-switch net");
        assert!(stranded_net_due(
            t0, stranded_repainted_at, stranded_repaints, last_frame.is_some(),
            t + Duration::from_millis(750),
        ));
        assert_eq!(current_output, Some(0x10003), "the stream now knows it shows the other screen");
    }

    /// Which screens count as the same: index AND HMONITOR for a single
    /// screen; an unknown handle is never proof of sameness; the composite is
    /// itself.
    #[test]
    fn same_screen_needs_the_same_index_and_the_same_monitor() {
        use crate::composite::ALL_DISPLAYS;
        assert!(is_same_screen(1, Some(7), 1, Some(7)));
        assert!(!is_same_screen(1, Some(7), 1, Some(9)), "another monitor shifted into the index");
        assert!(!is_same_screen(1, Some(7), 2, Some(7)), "another index");
        assert!(!is_same_screen(1, None, 1, Some(7)), "unknown before");
        assert!(!is_same_screen(1, Some(7), 1, None), "unknown after");
        assert!(!is_same_screen(1, None, 1, None), "unknown both: not proof");
        assert!(is_same_screen(ALL_DISPLAYS, None, ALL_DISPLAYS, None));
        assert!(!is_same_screen(ALL_DISPLAYS, None, 0, Some(7)));

        let o = |index: usize, hmonitor: isize| puca_capture::OutputInfo {
            index,
            left: 0,
            top: 0,
            width: 1,
            height: 1,
            hmonitor,
            rotation: puca_capture::Rotation::None,
        };
        let outs = [o(0, 7), o(2, 0)];
        assert_eq!(screen_identity(&outs, 0), Some(7));
        assert_eq!(screen_identity(&outs, 1), None, "an index missing from the walk");
        assert_eq!(screen_identity(&outs, 2), None, "a zero handle is unknown");
        assert_eq!(screen_identity(&outs, ALL_DISPLAYS), None);
    }

    /// A KEYFRAME REQUEST AFTER THE NET GAVE UP GETS ANOTHER ROUND.
    ///
    /// A switch onto a still screen holds no picture, so a keyframe request
    /// can only be answered by the screen presenting. If all three of the
    /// net's tries failed (the nudge window refused, a panel switched off by
    /// hand), a later request — a resumed Android controller whose decoder
    /// was reset — found nothing to re-send and nothing to provoke a present:
    /// no picture until the screen repainted by itself. Before the switch
    /// fix it would at least have got the old screen's (wrong) picture.
    #[test]
    fn a_keyframe_request_rearms_an_exhausted_stranded_switch_net() {
        let t0 = Instant::now();
        let last_try = t0 + Duration::from_millis(2250);
        let later = t0 + Duration::from_secs(30);
        let last_frame: Option<&str> = None;
        let mut want_keyframe = false;
        let mut stranded_repaints = 3u8;
        let stranded_repainted_at = Some(last_try);
        assert!(
            !stranded_net_due(t0, stranded_repainted_at, stranded_repaints, last_frame.is_some(), later),
            "precondition: the net has spent its three tries",
        );

        on_keyframe_request(&mut want_keyframe, true, last_frame.is_some(), &mut stranded_repaints);

        assert!(want_keyframe);
        assert!(
            stranded_net_due(t0, stranded_repainted_at, stranded_repaints, last_frame.is_some(), later),
            "a keyframe request with nothing to re-send must provoke a present again \
             (tries so far: {stranded_repaints})",
        );
        // Paced like the net: never sooner than 750 ms after the last try.
        assert!(!stranded_net_due(
            t0, stranded_repainted_at, stranded_repaints, last_frame.is_some(),
            last_try + Duration::from_millis(749),
        ));

        // A round still running is not extended by a request.
        let mut running = 1u8;
        on_keyframe_request(&mut want_keyframe, true, false, &mut running);
        assert_eq!(running, 1, "a request mid-round does not restart the count");

        // Holding a picture, the pump answers the request itself: no net.
        let mut held = 3u8;
        on_keyframe_request(&mut want_keyframe, true, true, &mut held);
        assert_eq!(held, 3);
        // No switch pending: a still screen that was captured once; the net
        // is not this request's business.
        let mut settled = 3u8;
        on_keyframe_request(&mut want_keyframe, false, false, &mut settled);
        assert_eq!(settled, 3);
    }

    /// A SWITCH INTO ALL DISPLAYS ON A STILL SCREEN IS ANSWERED WITH THE
    /// PICTURE THAT SCREEN BROUGHT.
    ///
    /// The adopted duplication has already handed its picture to the
    /// single-screen stream and has nothing new for the composite. Its tile
    /// used to start black, the warm pump re-sent that canvas as the switch's
    /// keyframe (its holding rule was a constant `true`), and the send ended
    /// the switch. Walked with the loop's own functions over a scripted
    /// one-screen composite, in the loop's order: the build takes the held
    /// frame in, and adopt_new_capture finds nothing left to drop.
    #[test]
    fn a_switch_into_all_displays_on_a_still_screen_is_answered_with_its_held_picture() {
        use crate::composite::testing::{composite, output, picture, Scripted};
        use crate::composite::ALL_DISPLAYS;
        let t = Instant::now();
        let mut current_monitor = 0usize;
        let mut current_output = Some(0x10001isize);
        let mut last_frame = Some(picture(4, 2, 0x80));
        let mut want_keyframe = false;
        let mut switch_started = None;
        let mut stranded_repaints = 0u8;
        let mut stranded_repainted_at = None;

        let mut capture = AnyCapture::Virtual(composite(
            vec![(output(0, 0, 0, 4, 2), Scripted::still())],
            last_frame.take().map(|f| (current_monitor, f)),
        ));
        adopt_new_capture(
            &mut current_monitor, &mut current_output, ALL_DISPLAYS, None,
            &mut last_frame, &mut want_keyframe, &mut switch_started,
            &mut stranded_repaints, &mut stranded_repainted_at, t,
        );
        assert!(last_frame.is_none(), "the stream's own still goes, as on any switch");
        let t0 = switch_started.expect("a switch into All Displays arms the net");

        // The pump's still tick: nothing presents, so it is the holding rule.
        let AnyCapture::Virtual(v) = &mut capture else { unreachable!() };
        assert!(matches!(v.refresh(5), Err(CaptureError::Timeout)), "precondition: a still screen");
        let holding = v.holds_picture(false, switch_awaits_whole_picture(switch_started, t));
        assert!(
            should_resend_still(want_keyframe, holding),
            "the switch's keyframe must be answered with the picture the screen brought",
        );
        // That frame goes out, and it is the whole picture: the switch ends.
        let whole = holds_whole_picture(Some(&capture), last_frame.is_some());
        assert!(whole);
        assert_eq!(on_frame_sent(whole, &mut switch_started, &mut stranded_repainted_at), Some(t0));
        assert_eq!(switch_started, None);
    }

    /// A FRAME OF ALL DISPLAYS WITH A SCREEN MISSING DOES NOT END THE SWITCH.
    ///
    /// When there was no held picture to bring (none kept, or one from before
    /// a display-mode change), the adopted screen's tile starts empty. The
    /// other screens' first frames still go out, but that send used to end
    /// the switch, and the stranded-switch net, which runs only while one is
    /// pending and only ever asked a single screen, never provoked the one
    /// missing: black until it repainted by itself. Walked with the loop's
    /// own functions over a scripted two-screen composite: screen 1 presents
    /// at once, the adopted screen 0 only when provoked.
    #[test]
    fn a_composite_frame_with_a_screen_missing_does_not_end_the_switch() {
        use crate::composite::testing::{composite, output, picture, Scripted};
        use crate::composite::ALL_DISPLAYS;
        let t = Instant::now();
        let mut current_monitor = 0usize;
        let mut current_output = Some(0x10001isize);
        let mut last_frame: Option<puca_capture::Frame> = None;
        let mut want_keyframe = false;
        let mut switch_started = None;
        let mut stranded_repaints = 3u8; // a previous switch's net, long spent
        let mut stranded_repainted_at = Some(t);

        let mut capture = AnyCapture::Virtual(composite(
            vec![
                (output(0, 0, 0, 4, 2), Scripted::polls(vec![None, Some(picture(4, 2, 0x80))])),
                (output(1, 4, 0, 4, 2), Scripted::polls(vec![Some(picture(4, 2, 0x20))])),
            ],
            last_frame.take().map(|f| (current_monitor, f)),
        ));
        adopt_new_capture(
            &mut current_monitor, &mut current_output, ALL_DISPLAYS, None,
            &mut last_frame, &mut want_keyframe, &mut switch_started,
            &mut stranded_repaints, &mut stranded_repainted_at, t,
        );
        let t0 = switch_started.expect("a switch into All Displays arms the net");

        // Screen 1 presents; the canvas goes out with screen 0 still black.
        let AnyCapture::Virtual(v) = &mut capture else { unreachable!() };
        v.refresh(5).expect("screen 1 presented");
        let whole = holds_whole_picture(Some(&capture), last_frame.is_some());
        assert!(!whole, "screen 0 is still the canvas's zero-fill");
        assert_eq!(on_frame_sent(whole, &mut switch_started, &mut stranded_repainted_at), None);
        assert_eq!(switch_started, Some(t0), "a frame with a screen missing must not end the switch");

        // So the net still works for it, paced as ever, aimed at screen 0.
        assert!(!stranded_net_due(t0, stranded_repainted_at, stranded_repaints, whole, t + Duration::from_millis(749)));
        assert!(
            stranded_net_due(t0, stranded_repainted_at, stranded_repaints, whole, t + Duration::from_millis(750)),
            "the missing screen must get the net's provoked present at 750 ms",
        );
        assert_eq!(capture.awaited_screens(current_monitor, last_frame.is_some()), vec![0]);
        // And a keyframe request after a spent round re-arms it, as for a
        // single screen.
        let mut spent = 3u8;
        on_keyframe_request(&mut want_keyframe, switch_started.is_some(), whole, &mut spent);
        assert_eq!(spent, 0, "a request with a screen still missing starts a fresh round");

        // Screen 0 presents (the provoked present): the next frame sent is the
        // whole picture, and it ends the switch.
        let AnyCapture::Virtual(v) = &mut capture else { unreachable!() };
        v.refresh(5).expect("screen 0 presented");
        let whole = holds_whole_picture(Some(&capture), last_frame.is_some());
        assert!(whole);
        assert_eq!(on_frame_sent(whole, &mut switch_started, &mut stranded_repainted_at), Some(t0));
        assert_eq!(switch_started, None, "the switch is over");
        assert!(!stranded_net_due(t0, stranded_repainted_at, stranded_repaints, whole, t + Duration::from_secs(10)));
    }

    /// A WARM PUMP DOES NOT RE-SEND ALL DISPLAYS WITH A SCREEN MISSING while
    /// a switch waits for it, and it waits only as long as the net works: a
    /// panel that never presents must not keep All Displays off the viewer.
    #[test]
    fn the_warm_pump_waits_for_a_missing_screen_only_as_long_as_the_net_does() {
        use crate::composite::testing::{composite, output, picture, Scripted};
        let t0 = Instant::now();
        let held = picture(4, 2, 0x80);
        let v = composite(
            vec![(output(0, 0, 0, 4, 2), Scripted::still()), (output(1, 4, 0, 4, 2), Scripted::still())],
            Some((1, held.clone())),
        );
        let waiting = switch_awaits_whole_picture(Some(t0), t0);
        assert!(waiting);
        assert!(
            !should_resend_still(true, v.holds_picture(false, waiting)),
            "warm, mid-switch, screen 0 missing: not a picture to re-send",
        );
        // The net's third try is at 2250 ms; the wait covers its landing.
        assert!(switch_awaits_whole_picture(Some(t0), t0 + Duration::from_millis(2999)));
        let waiting = switch_awaits_whole_picture(Some(t0), t0 + WHOLE_PICTURE_WAIT);
        assert!(!waiting);
        assert!(
            should_resend_still(true, v.holds_picture(false, waiting)),
            "past the wait, the screens that did present are shown",
        );
        assert!(!switch_awaits_whole_picture(None, t0), "no switch, nothing to wait for");
        // And a canvas no screen has painted is never a picture, warm or not.
        let bare = composite(vec![(output(0, 0, 0, 4, 2), Scripted::still())], None);
        assert!(!should_resend_still(true, bare.holds_picture(false, false)));
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

    /// The fs worker under test, shut down and JOINED when it drops — also
    /// while a failed assertion unwinds.
    ///
    /// Dropping a `JoinHandle` detaches the thread; it does not join it. A
    /// detached worker can still be inside a `List` request, holding the jail
    /// root open WITHOUT FILE_SHARE_DELETE (that is the point of that handle),
    /// at the moment the fixture tries to remove itself — and the fixture only
    /// prints when the thread is already panicking, so the folder stayed behind
    /// in the profile. Drop order cannot help: it orders locals on THIS thread,
    /// and the handle lives on the other one. The rig owns the sender because
    /// the join only returns once the channel is closed. Declare it AFTER the
    /// fixture, so it goes first.
    struct FsWorkerRig {
        tx: Option<std::sync::mpsc::Sender<(u32, crate::file_transfer::FsRequest, Option<u64>)>>,
        done: std::sync::mpsc::Receiver<(u32, Option<Vec<u8>>)>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl FsWorkerRig {
        fn start(scope: &Arc<Mutex<Option<crate::file_transfer::FileScope>>>) -> Self {
            let (tx, req_rx) = std::sync::mpsc::channel();
            let (done_tx, done) = std::sync::mpsc::channel::<(u32, Option<Vec<u8>>)>();
            let scope = Arc::clone(scope);
            let worker = std::thread::spawn(move || run_fs_worker(req_rx, scope, None, done_tx));
            FsWorkerRig { tx: Some(tx), done, worker: Some(worker) }
        }

        fn send(&self, cid: u32, req: crate::file_transfer::FsRequest, id: Option<u64>) {
            self.tx.as_ref().expect("the worker is up").send((cid, req, id)).unwrap();
        }

        fn reply(&self) -> (u32, Option<Vec<u8>>) {
            self.done.recv_timeout(std::time::Duration::from_secs(5)).unwrap()
        }

        /// The happy path's ending: close the channel, join, and let a panic
        /// inside the worker fail the test.
        fn finish(mut self) {
            self.tx.take();
            self.worker.take().expect("joined once").join().unwrap();
        }
    }

    impl Drop for FsWorkerRig {
        fn drop(&mut self) {
            // Channel first, or the join waits forever on a worker parked in recv().
            self.tx.take();
            if let Some(w) = self.worker.take() {
                let _ = w.join();
            }
        }
    }

    #[test]
    fn the_fs_worker_answers_in_request_order_with_ids_echoed() {
        // Order IS the protocol for id-less clients, so the worker being a
        // single thread is load-bearing — this pins that N requests come back
        // as N completions, in order, with each carried id echoed.
        //
        // Under the profile, not temp_dir(): a jail rooted in AppData is refused
        // for where it starts. The fixture removes itself, on failure too.
        let dir = crate::file_transfer::test_fixture::tempdir("fsworker");
        std::fs::write(dir.join("a.txt"), b"hello").unwrap();

        let scope = Arc::new(Mutex::new(Some(crate::file_transfer::FileScope::Jailed(
            dir.to_path_buf(),
        ))));
        let rig = FsWorkerRig::start(&scope);

        for (i, req) in [
            crate::file_transfer::FsRequest::ListRoots,
            crate::file_transfer::FsRequest::List { path: dir.to_string_lossy().into_owned(), cursor: None },
            crate::file_transfer::FsRequest::ListRoots,
        ]
        .into_iter()
        .enumerate()
        {
            rig.send(7, req, Some(100 + i as u64));
        }
        let mut got = Vec::new();
        for _ in 0..3 {
            let (cid, bytes) = rig.reply();
            assert_eq!(cid, 7);
            let v: serde_json::Value =
                serde_json::from_slice(&bytes.expect("every reply must encode")).unwrap();
            got.push(v["id"].as_u64().unwrap());
            assert_ne!(v["ok"], "error", "a granted request must not refuse: {v}");
        }
        assert_eq!(got, vec![100, 101, 102], "completions must keep request order");

        rig.finish();
    }

    #[test]
    fn the_fs_worker_reads_the_scope_per_request_so_revocation_is_instant() {
        let dir = crate::file_transfer::test_fixture::tempdir("fsworker-rev");
        let scope = Arc::new(Mutex::new(Some(crate::file_transfer::FileScope::Jailed(
            dir.to_path_buf(),
        ))));
        let rig = FsWorkerRig::start(&scope);

        // POSITIVE CONTROL first: with the grant in place the request works.
        rig.send(1, crate::file_transfer::FsRequest::ListRoots, None);
        let (_, bytes) = rig.reply();
        let v: serde_json::Value = serde_json::from_slice(&bytes.unwrap()).unwrap();
        assert_ne!(v["ok"], "error", "the rig must be able to see a grant work: {v}");

        // Revoke — the NEXT request must refuse, no reconnect needed.
        *scope.lock().unwrap() = None;
        rig.send(1, crate::file_transfer::FsRequest::ListRoots, None);
        let (_, bytes) = rig.reply();
        let v: serde_json::Value = serde_json::from_slice(&bytes.unwrap()).unwrap();
        assert_eq!(v["ok"], "error");
        assert!(
            v["message"].as_str().unwrap_or("").contains("not been allowed"),
            "the refusal must be the grant refusal: {v}"
        );

        rig.finish();
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

    // ---- the host-drawn pointer over a still screen -----------------------

    /// THE 2026-10-26 FIELD CASE, decided. The host draws the pointer, the
    /// screen presents nothing, the mouse moves: the held picture, with the
    /// pointer redrawn where it is now, goes out.
    #[test]
    fn a_pointer_the_host_draws_moving_over_a_still_screen_is_a_new_picture() {
        let mut asked = 0;
        let mut moved = || {
            asked += 1;
            true
        };
        assert_eq!(still_tick(false, true, true, &mut moved), StillTick::Resend { pointer: true });
        assert_eq!(asked, 1);
    }

    /// NEGATIVE CONTROLS: what must still cost nothing.
    #[test]
    fn a_still_tick_sends_nothing_for_a_pointer_it_does_not_draw_or_that_did_not_move() {
        // Drawing off (the viewer draws its own pointer): the capture is not
        // even asked, and the tick is free.
        let mut asked = 0;
        assert_eq!(still_tick(false, true, false, || { asked += 1; true }), StillTick::NoChange);
        assert_eq!(asked, 0, "drawing off: the pointer is not asked about");
        // Drawing on, the pointer did not move: free.
        assert_eq!(still_tick(false, true, true, || false), StillTick::NoChange);
        // Nothing held to draw it on: not asked, nothing sent.
        assert_eq!(still_tick(false, false, true, || { asked += 1; true }), StillTick::NoChange);
        assert_eq!(asked, 0, "no picture held: the pointer is not asked about");
        // The old reasons still re-send, the pointer unmoved or not drawn.
        assert_eq!(still_tick(true, true, true, || false), StillTick::Resend { pointer: false });
        assert_eq!(still_tick(true, true, false, || true), StillTick::Resend { pointer: false });
        assert_eq!(still_tick(true, false, true, || true), StillTick::NoChange, "never with nothing held");
    }

    /// The capture half of the pump, on ONE scripted screen: the screen
    /// presents once, then stands still while the pointer the host draws
    /// moves, stops, and moves again.
    #[test]
    fn a_still_screen_sends_its_held_picture_exactly_when_the_host_pointer_moves() {
        use crate::composite::testing::{picture, Scripted};
        let screen = Scripted::polls(vec![Some(picture(4, 2, 0x40))]).pointer(vec![Some(0xEE), None, Some(0xEF)]);
        let mut capture = AnyCapture::Single(screen);
        let mut held = None;
        let pump = |c: &mut AnyCapture<Scripted>, held: &mut Option<puca_capture::Frame>, draws: bool| {
            refresh_picture(c, held, false, draws, 5, false, false, None)
        };
        assert_eq!(pump(&mut capture, &mut held, true).ok(), Some(Picture::default()), "the present");
        // Moved: a pointer-only picture, drawn into the held frame.
        assert_eq!(
            pump(&mut capture, &mut held, true).ok(),
            Some(Picture { still_blocked: false, pointer_only: true }),
        );
        assert_eq!(held.as_ref().unwrap().bgra[..3], [0xEE; 3], "the held picture carries the moved pointer");
        // NEGATIVE CONTROL: it stood still: nothing to send.
        assert!(matches!(pump(&mut capture, &mut held, true), Err(PumpError::NoChange)));
        // NEGATIVE CONTROL: drawing handed to the viewer: nothing asked,
        // nothing sent, though the script has a move left.
        assert!(matches!(pump(&mut capture, &mut held, false), Err(PumpError::NoChange)));
        let AnyCapture::Single(s) = &capture else { unreachable!() };
        assert_eq!(s.redraws, 2, "drawing off asked nothing");
        // Back to the host: the move that was waiting is drawn.
        assert_eq!(
            pump(&mut capture, &mut held, true).ok(),
            Some(Picture { still_blocked: false, pointer_only: true }),
        );
        assert_eq!(held.as_ref().unwrap().bgra[..3], [0xEF; 3]);
    }

    /// The same on All Displays, both ways round: nothing presents and the
    /// pointer moves on a screen; and a screen presents while the pointer
    /// moves on ANOTHER one, which `refresh` alone would leave as it was.
    #[test]
    fn all_displays_sends_the_host_pointer_moving_over_a_still_screen() {
        use crate::composite::testing::{composite, output, picture, Scripted};
        let (screen0, screen1) = (output(0, 0, 0, 4, 2), output(1, 4, 0, 4, 2));
        // Screen 0's script, poll by poll: the first pump's pass presents;
        // the second pump's pass and its blocking wait, and the third pump's
        // pass, find nothing (its wait goes to screen 1); the fourth pump's
        // pass presents again. Screen 1 presents once. Its pointer, redraw by
        // redraw: unmoved (pump 1, after the presents), unmoved (pump 2),
        // moved (pump 3), moved again (pump 4), then unmoved.
        let mut capture = AnyCapture::Virtual(composite(
            vec![
                (
                    screen0,
                    Scripted::polls(vec![Some(picture(4, 2, 0x20)), None, None, None, Some(picture(4, 2, 0x21))]),
                ),
                (
                    screen1,
                    Scripted::polls(vec![Some(picture(4, 2, 0x40))]).pointer(vec![None, None, Some(0xEE), Some(0xEF)]),
                ),
            ],
            None,
        ));
        let mut held = None;
        let pump = |c: &mut AnyCapture<Scripted>, held: &mut Option<puca_capture::Frame>| {
            refresh_picture(c, held, false, true, 5, false, false, None)
        };
        // Screen 1's first pixel, and screen 0's: an 8x2 canvas of 4-byte
        // pixels, screen 1 from x = 4.
        let px = |c: &AnyCapture<Scripted>, x: usize| match c {
            AnyCapture::Virtual(v) => {
                let b = v.surface().3;
                [b[x * 4], b[x * 4 + 1], b[x * 4 + 2]]
            }
            AnyCapture::Single(_) => unreachable!(),
        };
        assert_eq!(pump(&mut capture, &mut held).ok(), Some(Picture::default()), "both present");
        // NEGATIVE CONTROL: still, and the pointer did not move: free.
        assert!(matches!(pump(&mut capture, &mut held), Err(PumpError::NoChange)));
        // Still, and it moved on screen 1: the canvas is a new picture.
        assert_eq!(
            pump(&mut capture, &mut held).ok(),
            Some(Picture { still_blocked: false, pointer_only: true }),
        );
        assert_eq!(px(&capture, 4), [0xEE; 3]);
        // Screen 0 presents while the pointer moves on still screen 1: the
        // frame that goes out has both.
        assert_eq!(pump(&mut capture, &mut held).ok(), Some(Picture::default()));
        assert_eq!(px(&capture, 0), [0x21; 3], "screen 0's new picture");
        assert_eq!(px(&capture, 4), [0xEF; 3], "and screen 1's pointer where it is now");
        assert!(matches!(pump(&mut capture, &mut held), Err(PumpError::NoChange)), "then still again");
        assert!(held.is_none(), "All Displays keeps its pictures in the composite, not in the stream's still");
    }

    /// AT MOST ONE ENCODE PER FRAME INTERVAL, and none for an idle mouse.
    /// One simulated second at 60 fps, the loop's own pacing (the clock's
    /// tick and the early look after an input, `early_look_allowed`), input
    /// every 8 ms, and a screen that never presents. The pointer moving on
    /// every look is the worst case a mouse can make.
    #[test]
    fn a_moving_host_pointer_costs_at_most_the_frame_rate_and_an_idle_one_nothing() {
        let run = |moving: bool| {
            let t0 = Instant::now();
            let interval = Duration::from_micros(16_667);
            let mut next_frame = t0;
            let mut last_frame_at: Option<Instant> = None;
            let mut watching: Option<Instant> = None;
            let mut sent = 0u32;
            for ms in 0..1000u64 {
                let now = t0 + Duration::from_millis(ms);
                if ms % 8 == 0 {
                    watching = Some(now + crate::latency::WATCH_FOR);
                }
                let due = now >= next_frame;
                let early = !due && early_look_allowed(now, watching, next_frame, last_frame_at, interval, None);
                if !(due || early) {
                    continue;
                }
                if due {
                    next_frame += interval;
                }
                if let StillTick::Resend { .. } = still_tick(false, true, true, || moving) {
                    sent += 1;
                    last_frame_at = Some(now);
                    if early {
                        next_frame = now + interval;
                        watching = None;
                    }
                }
            }
            sent
        };
        let moving = run(true);
        assert!(moving <= 61, "{moving} pointer frames in a second at 60 fps");
        assert!(moving >= 55, "a moving pointer must be shown at the frame rate: {moving}");
        assert_eq!(run(false), 0, "an idle pointer costs nothing");
    }

    /// A stream the HOST stops, or the viewer closes, says so, with how long
    /// it ran and what it sent: on 2026-10-26 those ends left no line on
    /// either side, and the timeline had to be pieced together without them.
    /// Pinned at both of run()'s clean ways out as well.
    #[test]
    fn a_clean_end_says_who_ended_it_how_long_it_ran_and_what_it_sent() {
        assert_eq!(
            clean_end_line(CleanEnd::Stopped, Duration::from_millis(263_440), 11_340),
            "stopped by the host after 263.4s, 11340 frame(s) sent",
        );
        assert_eq!(
            clean_end_line(CleanEnd::ViewerClosed, Duration::from_secs(5), 0),
            "ended: the viewer closed the connection after 5.0s, 0 frame(s) sent",
        );
        let src = include_str!("stream.rs").replace('\r', "");
        let run = src.split("\nfn run(").nth(1).unwrap().split("\n}\n").next().unwrap();
        assert!(run.contains("clean_end_line(CleanEnd::ViewerClosed, started_at.elapsed(), frames_sent)"));
        let tail = run.rsplit_once("clean_end_line(CleanEnd::Stopped, started_at.elapsed(), frames_sent)");
        assert!(tail.is_some_and(|(_, after)| after.trim() == ");\n    Ok(())".trim()), "the stop flag's way out says so");
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
        // The pump's first argument is `want_keyframe || fit.needs_frame()`
        // since the 2026-09-21 report: a stage change over a still screen is
        // a reason to re-send too, or the zoom never sharpens.
        let mut fit = crate::composite::FitState::new();
        fit.stage_changed();
        assert!(should_resend_still(false || fit.needs_frame(), true), "a changed stage re-sends the held picture");
    }

    /// REVIEW FINDING 5 (one screen lost). All Displays with one screen in
    /// exclusive fullscreen (AccessLost) beside a still one: `refresh` answers
    /// AccessLost, and the pointer the host draws over the still screen used
    /// to stand frozen, since only a Timeout brought it up to date. It moves,
    /// re-sent still marked blocked so the blockage's clock runs on.
    #[test]
    fn all_displays_moves_the_host_pointer_while_another_screen_is_lost() {
        use crate::composite::testing::{composite, output, picture, Scripted};
        let (screen0, screen1) = (output(0, 0, 0, 4, 2), output(1, 4, 0, 4, 2));
        let mut capture = AnyCapture::Virtual(composite(
            vec![
                (screen0, Scripted::still().lost()),
                (screen1, Scripted::polls(vec![Some(picture(4, 2, 0x40))]).pointer(vec![None, Some(0xEE), None])),
            ],
            None,
        ));
        let mut held = None;
        let pump = |c: &mut AnyCapture<Scripted>, held: &mut Option<puca_capture::Frame>, draws: bool| {
            refresh_picture(c, held, false, draws, 5, false, false, None)
        };
        assert_eq!(pump(&mut capture, &mut held, true).ok(), Some(Picture::default()), "screen 1 presents");
        assert_eq!(
            pump(&mut capture, &mut held, true).ok(),
            Some(Picture { still_blocked: true, pointer_only: true }),
            "the pointer moved over the still screen while the other is lost",
        );
        let AnyCapture::Virtual(v) = &capture else { unreachable!() };
        assert_eq!(v.surface().3[16..19], [0xEE; 3], "and it is on the canvas");
        // NEGATIVE CONTROLS: unmoved, or drawn by the viewer, it is the
        // blockage it always was.
        assert!(matches!(pump(&mut capture, &mut held, true), Err(PumpError::SecureDesktop)));
        assert!(matches!(pump(&mut capture, &mut held, false), Err(PumpError::SecureDesktop)));
    }

    // ---- a stream pinned to its screen (StartStream `steer_on_lid` off) -------

    const PANEL: isize = 0x10;
    const EXTERNAL: isize = 0x20;

    /// Outputs by index, each with its handle.
    fn outs(handles: &[isize]) -> Vec<puca_capture::OutputInfo> {
        use crate::composite::testing::output;
        handles
            .iter()
            .enumerate()
            .map(|(i, &h)| puca_capture::OutputInfo { hmonitor: h, ..output(i, i as i32 * 4, 0, 4, 2) })
            .collect()
    }

    /// REVIEW, ROUND 3 (a). The panel leaves the desktop BEFORE the lid's
    /// state arrives (the power callback has its own clock, and may never
    /// come), and the capture, rebuilt by index, now delivers the external
    /// monitor. The check was armed only around the lid, so that first
    /// picture went out. Now every picture of a pinned stream is checked:
    /// nothing of the external monitor is sent or kept, and the stream ends
    /// `no-screen:changed`.
    #[test]
    fn a_screen_renumbered_before_the_lid_says_anything_sends_nothing_and_ends_changed() {
        use crate::composite::testing::{picture, Scripted};
        // No lid state at all: the pin does not ask for one.
        let pin = screen_pin(false, 0, Some(PANEL));
        assert_eq!(pin, Some(PANEL));
        let mut capture = AnyCapture::Single(Scripted::polls(vec![Some(picture(4, 2, 0x40))]).on_screen(EXTERNAL));
        let mut held = None;
        assert!(matches!(
            refresh_picture(&mut capture, &mut held, true, true, 5, false, false, pin),
            Err(PumpError::ScreenChanged),
        ));
        assert!(held.is_none(), "nothing of it is kept");
        assert_eq!(changed_end(false, false), crate::virtual_screen::NO_SCREEN_CHANGED);
        assert_eq!(changed_end(true, false), crate::virtual_screen::NO_SCREEN_LID, "with the lid just changed, its code");
        // CONTROL: its own screen goes out.
        let mut own = AnyCapture::Single(Scripted::polls(vec![Some(picture(4, 2, 0x40))]).on_screen(PANEL));
        assert!(refresh_picture(&mut own, &mut held, true, true, 5, false, false, pin).is_ok());
    }

    /// REVIEW, ROUND 3 (b). Twenty seconds after the lid changed, the check
    /// lapsed while the capture still sat on another screen: a still screen
    /// answered NoChange, which read as a working capture, and its next
    /// picture went out. Now nothing is sent once the capture shows another
    /// screen, however long after the lid: not its picture, not the held
    /// picture re-sent, not a pointer moved over it.
    #[test]
    fn a_capture_left_on_another_screen_sends_nothing_however_long_after_the_lid() {
        use crate::composite::testing::{picture, Scripted};
        let t = Instant::now();
        let mut watch = crate::virtual_screen::LidWatch::new(t, Some(false), None);
        watch.observe(Some(true), t);
        watch.observe(Some(false), t + Duration::from_secs(1));
        let late = t + Duration::from_secs(60);
        assert!(!watch.lid_changed_recently(late), "precondition: long past the lid's window");
        let pin = screen_pin(false, 0, Some(PANEL));
        // A still screen, a picture of the panel held, a keyframe wanted, the
        // pointer moving: every way a picture could go out.
        let mut still = AnyCapture::Single(Scripted::still().pointer(vec![Some(0xEE)]).on_screen(EXTERNAL));
        let mut held = Some(picture(4, 2, 0x30));
        assert!(matches!(
            refresh_picture(&mut still, &mut held, true, true, 5, false, false, pin),
            Err(PumpError::ScreenChanged),
        ));
        assert_eq!(held.as_ref().unwrap().bgra[..3], [0x30; 3], "the held picture is not touched");
        let mut presenting = AnyCapture::Single(Scripted::polls(vec![Some(picture(4, 2, 0x40))]).on_screen(EXTERNAL));
        assert!(matches!(
            refresh_picture(&mut presenting, &mut held, false, true, 5, false, false, pin),
            Err(PumpError::ScreenChanged),
        ));
        // A screen that cannot be named is not the stream's either.
        let mut nameless = AnyCapture::Single(Scripted::polls(vec![Some(picture(4, 2, 0x40))]));
        assert!(matches!(
            refresh_picture(&mut nameless, &mut held, false, true, 5, false, false, pin),
            Err(PumpError::ScreenChanged),
        ));
        assert_eq!(screen_pin(false, 0, None), Some(0), "no handle known pins to none");
    }

    /// REVIEW, ROUND 3 (c). A rebuild decided by handle is BUILT by index one
    /// pass later, and the stream used to take the new capture's identity
    /// from a fresh enumeration: renumbered in between, it adopted the other
    /// screen, and its check from then on protected THAT screen. The capture's
    /// own answer decides now, and another screen is never adopted; nor is
    /// the stream's own screen at another index.
    #[test]
    fn a_renumbering_between_deciding_a_rebuild_and_building_it_is_rejected() {
        // Decided on screen 1, the external monitor; built, it is the panel.
        assert!(!rebuilt_capture_accepted(true, 1, Some(EXTERNAL), 1, Some(PANEL)));
        assert!(!rebuilt_capture_accepted(true, 1, Some(EXTERNAL), 1, None), "or no screen it can name");
        assert!(!rebuilt_capture_accepted(true, 1, Some(EXTERNAL), 0, Some(EXTERNAL)), "never to another index");
        assert!(!rebuilt_capture_accepted(true, 1, None, 1, Some(EXTERNAL)), "nothing to prove it by");
        // CONTROLS: its own screen at its own index; and a steering stream
        // adopts what it built, as before.
        assert!(rebuilt_capture_accepted(true, 1, Some(EXTERNAL), 1, Some(EXTERNAL)));
        assert!(rebuilt_capture_accepted(false, 1, Some(EXTERNAL), 0, Some(PANEL)));
    }

    /// REVIEW, ROUND 3 (the dock). With the lid shut all session, a monitor
    /// added or removed AFTER the stream's screen renumbers nothing it shows:
    /// same handle, same index. The stream keeps going: the self-heal rebuilds
    /// it in place, the rebuilt capture is adopted, and its pictures go out.
    /// What it does not do any more is follow its screen to a NEW index
    /// (the host app's consent is by index): that ends it.
    #[test]
    fn a_renumbering_that_leaves_the_pinned_screen_in_place_keeps_the_stream() {
        use crate::composite::testing::{picture, Scripted};
        let docked = outs(&[PANEL, EXTERNAL, 0x30]);
        assert_eq!(heal_plan(1, Some(EXTERNAL), &docked, true), Heal::Rebuild(1));
        assert!(rebuilt_capture_accepted(true, 1, Some(EXTERNAL), 1, Some(EXTERNAL)));
        let mut capture = AnyCapture::Single(Scripted::polls(vec![Some(picture(4, 2, 0x40))]).on_screen(EXTERNAL));
        let mut held = None;
        assert!(refresh_picture(&mut capture, &mut held, true, true, 5, false, false, screen_pin(false, 1, Some(EXTERNAL))).is_ok());
        assert!(capture_failed_end(true, 1, Some(EXTERNAL), &docked, true, "x").starts_with("capture: "), "a failure there restarts");
        // Its screen moved to index 0 (the panel left): not followed.
        let left = outs(&[EXTERNAL]);
        assert_eq!(heal_plan(1, Some(EXTERNAL), &left, true), Heal::End);
        // Another screen at its index: not rebuilt onto.
        assert_eq!(heal_plan(0, Some(PANEL), &left, true), Heal::End);
        assert_eq!(capture_failed_end(true, 0, Some(PANEL), &left, false, "x"), crate::virtual_screen::NO_SCREEN_CHANGED);
        assert_eq!(capture_failed_end(true, 0, Some(PANEL), &left, true, "x"), crate::virtual_screen::NO_SCREEN_LID);
    }

    /// REVIEW (after round 3, LOW). A laptop DOCKED with its lid shut all
    /// session: plugging a monitor in renumbers the outputs and takes the
    /// pinned screen's place. That end was labelled the lid's, since being
    /// shut counted, and the host app told the user to connect again with the
    /// lid open: wrong advice for a docked laptop. It is `no-screen:changed`;
    /// the stream's own rebuilds do not make it the lid's either. CONTROL: the
    /// panel the stream shows going dark at a lid close is the lid's.
    #[test]
    fn a_docked_laptops_end_is_not_the_lids() {
        use crate::virtual_screen::{own_screen_dark, Displays, Flight, LidWatch, NO_SCREEN_CHANGED, NO_SCREEN_LID};
        const ALL: usize = crate::composite::ALL_DISPLAYS;
        let t = Instant::now();
        // Shut before the stream began; an hour on, a monitor plugged in has
        // taken index 1, where the external monitor the stream shows was.
        let mut docked = LidWatch::new(t, Some(true), None);
        let later = t + Duration::from_secs(3600);
        docked.acted(later, Flight::Move);
        let renumbered = Displays {
            outputs: vec![0, 1],
            dark: vec![0],
            builtin: vec![0],
            virtual_screen: vec![],
            handles: vec![(0, PANEL), (1, 0x30)],
        };
        let own_dark = own_screen_dark(1, Some(EXTERNAL), &renumbered, ALL);
        assert_eq!(changed_end(docked.lid_changed_recently(later), own_dark), NO_SCREEN_CHANGED);
        let lid_recent = docked.lid_changed_recently(later);
        assert_eq!(capture_failed_end(true, 1, Some(EXTERNAL), &outs(&[PANEL, 0x30]), lid_recent, "x"), NO_SCREEN_CHANGED);
        // CONTROL: the lid shuts during the session, and the panel the stream
        // shows goes dark behind it.
        let mut session = LidWatch::new(t, Some(false), None);
        session.observe(Some(true), later);
        let behind = Displays {
            outputs: vec![0],
            dark: vec![0],
            builtin: vec![0],
            virtual_screen: vec![],
            handles: vec![(0, PANEL)],
        };
        let at_close = later + Duration::from_secs(2);
        let own_dark = own_screen_dark(0, Some(PANEL), &behind, ALL);
        assert_eq!(changed_end(session.lid_changed_recently(at_close), own_dark), NO_SCREEN_LID);
        // A panel dark behind a lid shut all session is the lid's too.
        assert_eq!(changed_end(docked.lid_changed_recently(later), own_dark), NO_SCREEN_LID);
    }

    /// The run loop uses the checks above as they are: the pin of every
    /// picture gated on nothing else (around the lid only, it missed (a) and
    /// (b)), every rebuild judged by the capture's own answer, and every
    /// identity the stream adopts read from the capture itself, never from an
    /// enumeration (which is how (c) adopted the other screen).
    #[test]
    fn the_loop_checks_every_picture_and_every_rebuild_by_the_capture() {
        let src = include_str!("stream.rs").replace('\r', "");
        let run = src.split("\nfn run(").nth(1).unwrap().split("\n}\n").next().unwrap();
        assert!(run.contains("let pin = screen_pin(steer_on_lid, current_monitor, current_output);\n"));
        assert!(run.contains("if !rebuilt_capture_accepted("));
        assert!(run.contains("let mut current_output: Option<isize> = capture.as_ref().and_then(|c| c.screen());"));
        assert_eq!(run.matches("capture.as_ref().and_then(|c| c.screen()),").count(), 2, "a switch and a rebuild");
        assert!(!run.contains("screen_identity(&outs, target_monitor),"), "never an enumeration's answer");
        // A pinned end names the lid only when the lid is why (docked is not):
        // the lid watch's end asks about the stream's own screen, and the two
        // ends that name the lid outright are a steering stream's only.
        assert!(run.contains("crate::virtual_screen::own_screen_dark(current_monitor, current_output, &d, all)"));
        assert!(run.contains("if last && lid == Some(true) && is_pinned(steer_on_lid, current_monitor) {"));
        assert!(run.contains("if lid == Some(true) && !is_pinned(steer_on_lid, current_monitor) {"));
    }

    /// THE CONTROL. A stream the host app lets steer keeps today's
    /// behaviour: no screen check on its pictures, the self-heal by index,
    /// and a capture that fails ends it restartably.
    #[test]
    fn a_steering_stream_still_restarts_normally() {
        use crate::composite::testing::{picture, Scripted};
        const ALL: usize = crate::composite::ALL_DISPLAYS;
        assert_eq!(screen_pin(true, 0, Some(PANEL)), None);
        assert_eq!(screen_pin(false, ALL, None), None, "All Displays shows every screen");
        let mut other = AnyCapture::Single(Scripted::polls(vec![Some(picture(4, 2, 0x40))]).on_screen(EXTERNAL));
        let mut held = None;
        assert!(refresh_picture(&mut other, &mut held, true, true, 5, false, false, screen_pin(true, 0, Some(PANEL))).is_ok());
        let left = outs(&[EXTERNAL]);
        assert_eq!(heal_plan(0, Some(PANEL), &left, false), Heal::Rebuild(0), "by index, as ever");
        assert_eq!(heal_plan(3, Some(PANEL), &left, false), Heal::Rebuild(0));
        assert_eq!(
            capture_failed_end(false, 0, Some(PANEL), &left, false, "no monitor at index 0"),
            "capture: no monitor at index 0",
        );
    }

    /// REVIEW POINT 7 (the viewer wins). A lid move queued just before the
    /// viewer's switch was decided on the screen the viewer then left; it is
    /// dropped when its turn comes. Every other rebuild still runs.
    #[test]
    fn a_lid_move_decided_before_the_viewers_switch_is_dropped() {
        assert!(rebuild_still_wanted(RebuildFor::Lid { switches: 3 }, 3));
        assert!(!rebuild_still_wanted(RebuildFor::Lid { switches: 3 }, 4));
        assert!(rebuild_still_wanted(RebuildFor::App, 9));
        assert!(rebuild_still_wanted(RebuildFor::SelfHeal, 9));
    }

    /// REVIEW FINDING 4 (the cost). A lid move releases the capture it holds
    /// only when the build needs a screen that capture duplicates, so a move
    /// that fails leaves the stream as it was.
    #[test]
    fn a_lid_rebuild_lets_go_first_only_of_a_capture_in_its_way() {
        const ALL: usize = crate::composite::ALL_DISPLAYS;
        // Another screen: built first, the old capture kept until it worked.
        assert!(!lid_rebuild_releases_first(1, Some(0x20), Some(false), Some(0x10)));
        // In its way: the same screen, All Displays, a held composite, and a
        // screen whose identity is not known on either side.
        assert!(lid_rebuild_releases_first(1, Some(0x10), Some(false), Some(0x10)));
        assert!(lid_rebuild_releases_first(ALL, None, Some(false), Some(0x10)));
        assert!(lid_rebuild_releases_first(1, Some(0x20), Some(true), None));
        assert!(lid_rebuild_releases_first(1, None, Some(false), Some(0x10)));
        assert!(lid_rebuild_releases_first(1, Some(0x20), Some(false), None));
        // Nothing held, nothing to let go.
        assert!(!lid_rebuild_releases_first(1, Some(0x10), None, Some(0x10)));
    }

    /// The screens other captures hold, as a stream reads them: everything
    /// but its own session's.
    #[test]
    fn a_stream_passes_over_the_screens_others_hold() {
        let held = HeldScreens::default();
        assert!(held.others("s1").is_empty());
        held.set(vec![(0, Some("s1".to_string())), (1, Some("s2".to_string())), (2, None)]);
        assert_eq!(held.others("s1"), vec![1, 2]);
        assert_eq!(held.others("s2"), vec![0, 2]);
    }
}
