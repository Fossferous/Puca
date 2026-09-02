//! Capture sessions and request handling.
//!
//! Split from the transport so the whole command surface is testable without a
//! pipe — the alternative is that the only way to exercise "does an unauthorised
//! request get refused" is to stand up IPC, which means it never gets tested.

use crate::protocol::{Request, Response, PROTOCOL_VERSION};
use puca_capture::{CaptureError, ScreenCapture};
use crate::composite::{AnyCapture, VirtualCapture};
use crate::privacy;
use std::collections::HashMap;

/// Base64 without a dependency — the only thing encoded here is frame bytes.
fn b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Where an input event goes: the OS, or the SYSTEM service.
///
/// THE ROUTING ITSELF IS NOT BEHIND A TEST SEAM, deliberately. Both destinations
/// are stubbed below so `cargo test` never types on a real desktop or dials a
/// real pipe — but if the `match` that chooses between them were stubbed too,
/// the tests would be exercising a second implementation of the decision and
/// proving nothing about this one.
///
/// `Sas` is intercepted BEFORE `puca_input::inject` because that function
/// cannot carry it out and says so: the secure attention sequence is
/// unreachable from `SendInput` by design (see `ControlInput::Sas`). Letting it
/// fall through would produce a correct-but-useless refusal where a working
/// feature is available one process away.
/// The stream thread's entry to the SAME dispatch the pipe path uses (R4).
/// Public wrapper rather than making `dispatch_input` public: the Sas
/// interception and the test seam below must apply to both callers, and two
/// entry points into OS input is exactly how one of them ends up bypassing a
/// gate the other has.
pub fn dispatch_input_public(event: puca_input::ControlInput) -> Result<(), String> {
    dispatch_input(event)
}

fn dispatch_input(event: puca_input::ControlInput) -> Result<(), String> {
    match event {
        puca_input::ControlInput::Sas => dispatch_sas(),
        other => inject_seam(other),
    }
}

/// The one place `Request::Inject`/`InjectSealed` reach the OS.
///
/// Real `puca_input::inject` on Windows is genuine `SendInput` — it types
/// into and moves the cursor over whatever window has focus on the machine
/// running the process, not some sandboxed target. `cargo test` runs on a real
/// desktop, so every unit test that drives a request through to this point
/// used to do that for real: `the_plaintext_never_comes_back_out`'s canary
/// string was landing keystroke-by-keystroke in whatever app had focus on
/// every test run, and several other tests silently recentred the mouse.
/// `puca-input`'s own suite already refuses to exercise `inject` for
/// this exact reason (see its `text_batch` doc comment) — this closes the
/// same hole one layer up, where `Agent::handle` calls it directly.
#[cfg(not(test))]
fn inject_seam(event: puca_input::ControlInput) -> Result<(), String> {
    puca_input::inject(event)
}

/// The test stand-in still has a FAILURE path, or the tests that guard the
/// error path (`the_plaintext_never_comes_back_out` renders the error response
/// and asserts the frame is not in it) could no longer reach it — a stub that
/// only ever says Ok turns that guard into one that cannot fail. Text beginning
/// `FAIL-` is refused with a cause-only message, exactly the shape the real
/// `inject` produces.
///
/// It also COUNTS, so a test can assert that a `Sas` frame never arrived here.
/// "It went to the service" and "it went to the service AND to SendInput" are
/// very different, and only the count tells them apart.
#[cfg(test)]
fn inject_seam(event: puca_input::ControlInput) -> Result<(), String> {
    INJECT_SEAM_CALLS.with(|c| c.set(c.get() + 1));
    match event {
        puca_input::ControlInput::Text { ref text } if text.starts_with("FAIL-") => {
            Err("refused by the test stand-in".into())
        }
        // Reached only if the routing above is broken. Answering Err rather than
        // Ok means a regression shows up as a failed request rather than as a
        // test that quietly still passes.
        puca_input::ControlInput::Sas => {
            Err("the SAS reached the SendInput path, which cannot raise it".into())
        }
        _ => Ok(()),
    }
}

/// The one place a `Sas` request reaches the SYSTEM service.
///
/// Separate from the input seam because it is a different destination with a
/// different failure vocabulary: "the service is not installed" is the ordinary
/// answer on most machines and is not an error in this agent.
#[cfg(all(windows, not(test)))]
fn dispatch_sas() -> Result<(), String> {
    crate::sas_client::raise_sas()
}

/// There is no secure attention sequence to raise off Windows — see the Linux
/// arm of `puca_input::inject`, which says the same thing for the same
/// reason. Kept as its own arm so the cross-compile guard covers this file.
#[cfg(all(not(windows), not(test)))]
fn dispatch_sas() -> Result<(), String> {
    Err("the secure attention sequence is a Windows concept".to_string())
}

// What the SAS stand-in answers, and how many times each seam was reached.
//
// THREAD-LOCALS, not statics: `cargo test` runs tests in parallel on separate
// threads and a shared cell would make one test's expectation another test's
// flake. The SAS seam defaults to success so the routing test can assert the
// ordinary path end to end; the refusal test sets its own answer.
#[cfg(test)]
thread_local! {
    static SAS_SEAM: std::cell::RefCell<(usize, Result<(), String>)> =
        std::cell::RefCell::new((0, Ok(())));
    static INJECT_SEAM_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn dispatch_sas() -> Result<(), String> {
    SAS_SEAM.with(|c| {
        let mut c = c.borrow_mut();
        c.0 += 1;
        c.1.clone()
    })
}

/// The one place a `power` plan reaches the OS (crate::power::perform). A
/// unit test must never shut the developer's machine down, so the test build
/// records the plan and answers what the test set — same shape as SAS_SEAM.
#[cfg(not(test))]
fn dispatch_power(plan: crate::power::Plan) -> Result<(), String> {
    crate::power::perform(plan)
}

#[cfg(test)]
thread_local! {
    static POWER_SEAM: std::cell::RefCell<(Vec<crate::power::Plan>, Result<(), String>)> =
        std::cell::RefCell::new((Vec::new(), Ok(())));
}

#[cfg(test)]
fn dispatch_power(plan: crate::power::Plan) -> Result<(), String> {
    POWER_SEAM.with(|c| {
        let mut c = c.borrow_mut();
        c.0.push(plan);
        c.1.clone()
    })
}

/// Where injected input must land for a given CAPTURE index.
///
/// PURE, and separate from `aim_input_at`, so the mapping can be tested against
/// fabricated multi-monitor layouts — the bug it fixes only appears on hardware
/// where two enumerations disagree, which no test machine can be relied on to
/// have.
///
/// THE BUG THIS EXISTS TO PREVENT: the capture index counts DXGI outputs
/// (adapters, then their outputs) while `puca_input::list_monitors` counts
/// GDI monitors (`EnumDisplayMonitors`). Those orders are unrelated. Measured on
/// the reporter's 3-monitor desktop, DXGI 0/1/2 were GDI 2/1/0 — so aiming by
/// re-indexing the GDI list showed one screen and moved the cursor on another.
/// The fix is to take the geometry from the very output being captured, and to
/// join to the GDI entry by `hmonitor` rather than by position.
///
/// Returns None when the index resolves to nothing, and the caller must then
/// CLEAR the target: leaving the previous one behind aims this session's input
/// using the last session's screen.
pub(crate) fn resolve_target(
    monitor: usize,
    outputs: &[puca_capture::OutputInfo],
    list: &puca_input::MonitorList,
) -> Option<puca_input::TargetMonitor> {
    let virt = |left: i32, top: i32, width: i32, height: i32| puca_input::TargetMonitor {
        left,
        top,
        width,
        height,
        // Always the real virtual desktop: SendInput's absolute coordinates are
        // normalised over it, whatever sub-rectangle is being captured.
        virt_left: list.virt_left,
        virt_top: list.virt_top,
        virt_width: list.virt_width,
        virt_height: list.virt_height,
    };

    // "All Displays" is a sentinel, not an index. The composite surface is the
    // bounding box of every captured output, so input normalised over that
    // mosaic must map to the same box — computed from the SAME list the
    // compositor uses, rather than assumed equal to the virtual desktop.
    if monitor == crate::composite::ALL_DISPLAYS {
        let left = outputs.iter().map(|o| o.left).min()?;
        let top = outputs.iter().map(|o| o.top).min()?;
        let right = outputs.iter().map(|o| o.left + o.width).max()?;
        let bottom = outputs.iter().map(|o| o.top + o.height).max()?;
        // The DESKTOP EXTENT THE COMPOSITE ACTUALLY SHOWS, which is not quite
        // the union: the surface is rounded down to even and to a whole number
        // of steps, so the last row and column of the union can be cropped. The
        // viewer normalises over what they can SEE, so aiming over the full
        // union would put the pointer a little short of where they pointed —
        // small, but it is the same class of error as the bug this function
        // exists to fix.
        let (step, out_w, out_h) = crate::composite::composite_geometry(
            (right - left) as u32,
            (bottom - top) as u32,
        );
        return Some(virt(left, top, (out_w * step) as i32, (out_h * step) as i32));
    }

    // BY `index`, NOT BY POSITION. `outputs()` omits an output it could not
    // describe rather than renumbering the rest, so the vector can have gaps —
    // and closing them here would aim at the neighbouring screen, which is the
    // bug this function exists to fix.
    let out = outputs.iter().find(|o| o.index == monitor)?;
    // Prefer the GDI rectangle for the SAME physical display when one exists:
    // it is the coordinate space `virt_*` above was measured in, so the two
    // halves of the mapping come from one source. The DXGI rectangle is the
    // fallback, and agrees with it in every layout observed.
    let matched = list
        .monitors
        .iter()
        .find(|m| m.hmonitor != 0 && m.hmonitor == out.hmonitor);
    Some(match matched {
        Some(m) => virt(m.left, m.top, m.width, m.height),
        None => virt(out.left, out.top, out.width, out.height),
    })
}

/// What the CURRENT capture actually shows, in PHYSICAL desktop pixels.
///
/// Separate from `TargetMonitor`, and deliberately not built from it. Injection
/// aims through the GDI rectangle joined by `hmonitor` (see `resolve_target`
/// above) because `SendInput`'s absolute coordinates normalise over
/// `GetSystemMetrics(SM_*VIRTUALSCREEN)` — the same DPI-VIRTUALISED space, since
/// this process is deliberately DPI-unaware. The caret is the opposite case: it
/// is measured on a per-monitor-aware thread and is therefore PHYSICAL, and
/// `DXGI_OUTPUT_DESC.DesktopCoordinates` (what the capture shows) is physical
/// too. Mapping a physical caret through a virtualised GDI rect is wrong by
/// exactly the scale factor on any scaled monitor — 1707 vs 2560 at 150%.
///
/// So: this type is built from `puca_capture::OutputInfo` and never sees a
/// `MonitorList`. And do NOT make the process DPI-aware to "unify" the two: that
/// would change `list_monitors()` and `virt_*` under the injection mapping and
/// silently re-aim every existing session's input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CaptureSurface {
    /// One output. `ScreenCapture::next_frame` returns
    /// `rotate_to_desktop(raw, rotation)`, so the frame's width and height ARE
    /// this rect's width and height and no rotation term appears below — a
    /// portrait monitor is 1440x2560 here and arrives as 1440x2560.
    Single { left: i32, top: i32, width: i32, height: i32 },
    /// All Displays. The composite shows `out_w*step` x `out_h*step` desktop
    /// pixels starting at (min_left, min_top) — NOT the union, which is rounded
    /// down to a whole number of steps and to even dimensions, so the union's
    /// last rows and columns can be off the surface entirely.
    Composite { min_left: i32, min_top: i32, step: u32, out_w: u32, out_h: u32 },
}

impl CaptureSurface {
    /// The desktop rectangle actually on screen: (left, top, width, height).
    pub(crate) fn covers(self) -> (i32, i32, i32, i32) {
        match self {
            Self::Single { left, top, width, height } => (left, top, width, height),
            Self::Composite { min_left, min_top, step, out_w, out_h } => {
                (min_left, min_top, (out_w * step) as i32, (out_h * step) as i32)
            }
        }
    }
}

/// The surface for a CAPTURE index, from the same DXGI list the capture used.
///
/// Used for a single screen and by the probe/tests. The live composite's
/// geometry is read from the capture in hand instead (`AnyCapture::caret_surface`
/// -> `VirtualCapture::desktop_extent`), because its `min_left`/`step`/`out_*`
/// are frozen at build time and a monitor unplugged mid-session would make a
/// fresh enumeration here describe a surface that is not being produced.
pub(crate) fn capture_surface(
    monitor: usize,
    outputs: &[puca_capture::OutputInfo],
) -> Option<CaptureSurface> {
    if monitor == crate::composite::ALL_DISPLAYS {
        let (min_left, min_top, union_w, union_h) = crate::composite::union_box(outputs)?;
        let (step, out_w, out_h) = crate::composite::composite_geometry(union_w, union_h);
        return Some(CaptureSurface::Composite { min_left, min_top, step, out_w, out_h });
    }
    // BY `index`, NOT BY POSITION — `outputs()` can have gaps, and closing them
    // here would describe the neighbouring screen.
    let out = outputs.iter().find(|o| o.index == monitor)?;
    Some(CaptureSurface::Single {
        left: out.left,
        top: out.top,
        width: out.width,
        height: out.height,
    })
}

/// A caret rect in PHYSICAL desktop pixels -> fractions of the surface.
///
/// `caret` is (left, top, width, height). `None` means "the viewer cannot see
/// this caret", which the agent reports as `vis:false`: off the captured
/// surface, degenerate, or a surface with no area.
///
/// The intersection is reported rather than the caret, so nothing ever exceeds
/// 1.0 at an edge, and every subtraction happens in `i32` BEFORE the divide — an
/// `as u32` on a caret to the left of the surface would wrap to a huge positive
/// number and clamp to a plausible 1.0 instead of vanishing.
pub(crate) fn caret_fractions(
    caret: (i32, i32, i32, i32),
    surface: CaptureSurface,
) -> Option<crate::caret_wire::CaretFractions> {
    let (sl, st, sw, sh) = surface.covers();
    if sw <= 0 || sh <= 0 {
        return None;
    }
    let (cl, ct, cw, ch) = caret;
    // A hidden caret's rect is commonly zero-height. Zero WIDTH is legitimate
    // (a one-pixel caret measures 0 or 1 in some applications) and is passed
    // through: the viewer sizes its zoom from the height.
    if ch <= 0 || cw < 0 {
        return None;
    }
    let l = cl.max(sl);
    let t = ct.max(st);
    let r = (cl + cw).min(sl + sw);
    let b = (ct + ch).min(st + sh);
    if b <= t || r < l {
        return None;
    }
    Some(crate::caret_wire::CaretFractions {
        x: (l - sl) as f64 / sw as f64,
        y: (t - st) as f64 / sh as f64,
        w: (r - l) as f64 / sw as f64,
        h: (b - t) as f64 / sh as f64,
    })
}

/// Identity of one live stream: which session, and which generation of it.
///
/// Lives HERE, not in stream.rs, because stream.rs is `#[cfg(windows)]` and
/// this plain-data key is used by `release_reservations` — which is compiled
/// on every platform. Defining it inside the gated module broke the Linux
/// build outright (E0433) from 2026-08-03 (aa1989b) and turned CI's frontend
/// job permanently red.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StreamKey {
    pub session_id: String,
    pub generation: u64,
}

/// Which reservation keys a stream on `monitor` actually holds.
///
/// A single screen holds itself. ALL_DISPLAYS holds EVERY output plus the
/// sentinel — because it really is duplicating every one of them, and
/// reserving only the sentinel left the member screens looking free, so a
/// second session could be told it may have a screen the composite is already
/// capturing. DXGI would then refuse it, at a point where the refusal reads as
/// a random failure rather than as "something else has that screen".
///
/// Pure, so the multi-key bookkeeping is testable against fabricated output
/// lists — including the gapped ones `outputs()` really produces.
/// Drop every reservation held by exactly this stream.
///
/// Matches on the whole `StreamKey` (session AND generation), never on the
/// monitor index, so a stale stream tearing down late cannot take a NEWER
/// stream's reservation with it — the property
/// `test_stale_terminal_event_cannot_remove_newer_stream_or_reservation`
/// pins. Uniform over one key or many, which is what makes the ALL_DISPLAYS
/// case safe on all four release paths.
pub(crate) fn release_reservations(
    reservations: &mut HashMap<usize, StreamKey>,
    key: &StreamKey,
) {
    reservations.retain(|_, held| held != key);
}

pub(crate) fn reservation_keys(
    monitor: usize,
    outputs: &[puca_capture::OutputInfo],
) -> Vec<usize> {
    if monitor != crate::composite::ALL_DISPLAYS {
        return vec![monitor];
    }
    let mut keys: Vec<usize> = outputs.iter().map(|o| o.index).collect();
    keys.push(crate::composite::ALL_DISPLAYS);
    keys
}

/// Milliseconds since the epoch, for the UA gate's challenge expiry.
///
/// Wall clock rather than Instant because the gate compares issue times across
/// what may be a long-lived process, and a monotonic clock cannot be persisted
/// or compared with anything the controller knows.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A session whose control frames the agent opens itself.
struct SealedSession {
    key: [u8; 32],
    /// The highest `s` seen. Frames must strictly increase, which is what makes
    /// a captured frame unreplayable — the JS host enforces the same rule at
    /// session.ts:2690, and the two must agree or input stalls.
    recv_seq: i64,
    /// R4: may this session inject through the DIRECT input channel?
    ///
    /// Stated by the app at open time from the verified grant. The pipe's
    /// `InjectSealed` does NOT consult this — that path only exists because
    /// the app forwarded it, and the app applies the view-only rule itself
    /// — but the data channel bypasses the app entirely, so without this a
    /// view-only share could type. See input_wire::InputArm.
    input_arm: crate::input_wire::InputArm,
    /// Has this session answered the unattended-access challenge?
    ///
    /// Per session, not per gate: proving once must not authorise a DIFFERENT
    /// peer's session that happens to arrive later.
    ua_ok: bool,
    /// The highest `n` seen on an inbound SIGNALLING frame.
    ///
    /// SEPARATE FROM `recv_seq`, which counts input frames. The controller
    /// numbers the two streams independently (`sendSignal` has its own counter,
    /// session.ts:679), so sharing one here would make an offer and a keystroke
    /// compete for the same sequence and drop whichever arrived second.
    recv_sig_seq: i64,
    /// The next `n` to put on an OUTBOUND signalling frame.
    send_seq: i64,
    /// TURN/STUN for this session's stream, supplied when it was opened.
    ice_servers: Vec<crate::protocol::IceServer>,
    /// An offer that arrived before the passphrase was proved.
    ///
    /// HELD, NOT DROPPED — the same rule and the same wording as the JS host's
    /// own comment at session.ts:3787. The controller sends its offer the
    /// instant `DeviceConnectResponse` accepts, while the passphrase round trip
    /// runs concurrently and takes as long as a person takes to type: for an
    /// armed session this ordering is not an edge case, it is EVERY connection.
    /// The controller has no retry path — it sent its offer once and is
    /// waiting for an answer — so refusing outright here (which the first
    /// version of this file did) does not delay the connection, it kills it.
    pending_offer: Option<String>,
    /// ICE candidates that arrived before the stream existed to receive them.
    ///
    /// THE BUG THAT MADE EVERY FIRST CONNECTION FAIL. The controller trickles
    /// candidates within ~1-2s of sending its offer — entirely inside the
    /// window `pending_offer` holds open while the passphrase is typed. Before
    /// this field existed, every one of those candidates hit
    /// `AddRemoteCandidate` while `self.streams` had no entry for the session
    /// (the stream is only created by `StartStream`, which does not run until
    /// the offer is released) and came back "no such stream" — discarded by
    /// the caller's `let _ =`. The agent ended every held-offer session with
    /// ZERO remote candidates and zero TURN permissions (permissions are seeded
    /// only from candidates embedded in the offer SDP, which a browser's
    /// `createOffer()` never includes), so the controller's checks to the
    /// relay were silently dropped and ICE failed after the offer was
    /// eventually answered. The exact same bug was already found and fixed on
    /// the JS host path (session.ts:3843, `queueIce`); this is that fix ported.
    ///
    /// Capped at 128 — matching both the JS queue's cap and
    /// `Stream::remote_candidates`'s own cap — and the overflow is dropped
    /// rather than erroring: a real browser emits a handful of candidates, and
    /// the useful ones arrive first by ICE priority.
    pending_ice: Vec<String>,
}

pub struct Agent {
    /// Presented by the app at Hello. Generated per launch and passed on the
    /// agent's command line, so knowing the pipe name is not enough to drive
    /// it — a local process would also have to have seen the launch.
    token: String,
    authenticated: bool,
    /// Sessions whose control frames THIS process opens, by session id.
    ///
    /// Separate from `sessions` (which maps a session to a monitor) because a
    /// session can exist without being sealed — the desktop-app path never
    /// calls OpenSession, and must keep working exactly as it did.
    sealed: HashMap<String, SealedSession>,
    /// The unattended-access gate, shared across sessions.
    ///
    /// One gate rather than one per session: the passphrase is a property of
    /// the MACHINE, and re-arming it must invalidate every outstanding
    /// challenge everywhere, which a per-session gate could not do.
    ua: puca_ua::UaGate,
    /// When an injection failure was last written to the log.
    ///
    /// Injection failures used to be impossible to observe, so logging every
    /// one looked free. Now that `puca_input::inject` reports a refused
    /// SendInput, a secure desktop plus a moving mouse produces one line per
    /// pointer event — around a hundred a second, into a FILE. The response to
    /// the controller is unthrottled (it asked, it gets an answer); only the
    /// log is rationed.
    last_inject_error_log: Option<std::time::Instant>,
    /// What this agent will do, fixed at launch by who started it. Held on the
    /// Agent rather than read from argv at each call site so there is one
    /// answer per process and no request can be served against a different one.
    flavour: crate::flavour::Flavour,
    /// ONE capture per monitor, shared across sessions. DXGI duplication is
    /// exclusive per output, so opening a second is not a race to retry — it is
    /// a design error that presents as "capture randomly fails to start".
    captures: HashMap<usize, AnyCapture>,
    /// Which monitor each session is watching.
    sessions: HashMap<String, usize>,
    /// Live WebRTC streams, keyed by session id. Held here so StopStream — and
    /// dropping the Agent — actually stop the thread and release the capture.
    #[cfg(windows)]
    streams: HashMap<String, crate::stream::Stream>,
    #[cfg(windows)]
    monitor_reservations: HashMap<usize, StreamKey>,
    #[cfg(windows)]
    next_generation: u64,
    #[cfg(windows)]
    next_request_id: u64,
    #[cfg(windows)]
    stream_events: (
        std::sync::mpsc::Sender<crate::stream::StreamEvent>,
        std::sync::mpsc::Receiver<crate::stream::StreamEvent>,
    ),
    /// Session ids whose capture is currently blocked by a secure desktop this
    /// (user-flavour) agent cannot follow. Driven by StreamEvent::SecureDesktop
    /// and read by Request::SessionStatus, so the app can bring up the bridge.
    #[cfg(windows)]
    secure_desktop_up: std::collections::HashSet<String>,
}

/// Whether this Linux box can actually host: an X server we can reach, with
/// XTEST present.
///
/// Deliberately a live probe rather than `cfg!(target_os = "linux")`. The
/// difference between "compiled for Linux" and "can inject into this session"
/// is the entire Wayland problem, and answering the first when asked the second
/// is what produces a black screen nobody can explain.
#[cfg(target_os = "linux")]
fn linux_x11_ready() -> bool {
    puca_input::injection_availability().is_ok()
}

#[cfg(not(target_os = "linux"))]
fn linux_x11_ready() -> bool {
    false
}

impl Agent {
    pub fn new(token: String, flavour: crate::flavour::Flavour) -> Self {
        #[cfg(windows)]
        let (tx, rx) = std::sync::mpsc::channel();
        Self {
            token,
            authenticated: false,
            sealed: HashMap::new(),
            ua: puca_ua::UaGate::default(),
            last_inject_error_log: None,
            flavour,
            captures: HashMap::new(),
            sessions: HashMap::new(),
            #[cfg(windows)]
            streams: HashMap::new(),
            #[cfg(windows)]
            monitor_reservations: HashMap::new(),
            #[cfg(windows)]
            next_generation: 1,
            #[cfg(windows)]
            next_request_id: 1,
            #[cfg(windows)]
            stream_events: (tx, rx),
            #[cfg(windows)]
            secure_desktop_up: std::collections::HashSet::new(),
        }
    }

    #[cfg(test)]
    pub fn is_authenticated(&self) -> bool {
        self.authenticated
    }

    /// Point injected input at `monitor`.
    ///
    /// Normalised coordinates mean nothing without knowing which screen they are
    /// relative to, and puca_input falls back to the PRIMARY display when
    /// no target is set. Called wherever the captured output changes, so the
    /// mouse always lands where the viewer is looking.
    fn aim_input_at(monitor: usize) {
        let outputs = puca_capture::outputs();
        let list = puca_input::list_monitors();
        puca_input::set_target(resolve_target(monitor, &outputs, &list));
    }

    /// Refuse a request this flavour does not serve.
    ///
    /// Every capability in `flavour::Capability` is checked at its handler,
    /// including the ones no flavour currently restricts. That is deliberate:
    /// an enum whose variants force a decision in `allows` but are never asked
    /// at a call site records a decision nothing enforces, and the compiler
    /// says so — three of these four were dead until this existed.
    ///
    /// On the allowed path this is a match on two Copy enums and allocates
    /// nothing, which is what makes it safe to put in front of `Inject`.
    fn gate(&self, cap: crate::flavour::Capability) -> Option<Response> {
        self.flavour.refusal(cap).map(Response::error)
    }

    /// Arm the unattended gate from the machine-scope record the service wrote.
    ///
    /// READ PER CONNECTION, not once at startup, because `pipe::serve` builds a
    /// fresh Agent per client. That is what makes disarming take effect on the
    /// next session instead of at the next reboot — a revocation that waits for
    /// a restart is not a revocation.
    ///
    /// A missing or unreadable file leaves the gate UNARMED, which for
    /// `SystemInteractive` means every session is refused. That is the correct
    /// direction to fail: the alternative is a sign-in screen that accepts
    /// whoever asks because a file could not be read.
    pub fn arm_from_record_file(&mut self, path: &str) {
        let Ok(raw) = std::fs::read(path) else { return };
        let Ok(rec) = serde_json::from_slice::<puca_ua::UaRecord>(&raw) else { return };
        if rec.version != puca_ua::UaRecord::VERSION {
            return;
        }
        self.ua.arm(rec);
    }

    /// Negotiate a proven offer into a running stream and seal the answer.
    ///
    /// EXTRACTED so both call sites — an offer that arrives already proven, and
    /// one released after the passphrase catches up — go through exactly one
    /// negotiation path. A second copy is how the two would quietly drift.
    ///
    /// Reuses the REAL StartStream handler rather than a parallel negotiation
    /// path: it owns monitor selection, the encoder and the str0m setup.
    ///
    /// ICE is non-trickle here — the agent adds its own candidates before
    /// producing the answer (puca-rtc/src/lib.rs:116) — so a single sealed
    /// answer completes the negotiation and the agent never needs to push a
    /// frame the pipe has no way to send.
    fn answer_offer_now(&mut self, session_id: &str, sdp: String) -> Response {
        #[cfg(windows)]
        {
            let ice_servers = self
                .sealed
                .get(session_id)
                .map(|x| x.ice_servers.clone())
                .unwrap_or_default();
            let started = self.handle(Request::StartStream {
                session_id: session_id.to_string(),
                monitor: None,
                offer_sdp: sdp,
                fps: None,
                bitrate: None,
                ice_servers,
                // Never data-only: this session exists to show a sign-in
                // screen, and a data-only stream takes no monitor reservation
                // and shows nothing.
                data_only: false,
            });
            let Response::Streaming { answer_sdp, .. } = started else {
                // Pass the agent's own refusal through unchanged rather than
                // replacing it with a generic one: "that session is already
                // streaming" and "no monitor" send you to different places.
                return started;
            };

            // RELEASE WHATEVER ICE WAS HELD, now that the stream exists to
            // receive it. This is what makes the FIRST connection work: without
            // it every candidate the controller sent while the offer was held
            // stays lost, and the session has no TURN permission to receive on.
            let queued = self
                .sealed
                .get_mut(session_id)
                .map(|s| std::mem::take(&mut s.pending_ice))
                .unwrap_or_default();
            for candidate in queued {
                let _ = self.handle(Request::AddRemoteCandidate {
                    session_id: session_id.to_string(),
                    candidate,
                });
            }

            let Some(s) = self.sealed.get_mut(session_id) else {
                return Response::error("no sealed session with that id");
            };
            let frame = serde_json::json!({
                "kind": "answer",
                "sdp": answer_sdp,
                "sid": session_id,
                "n": s.send_seq,
            });
            let Some(sealed) = crate::control_key::seal(&s.key, &frame.to_string()) else {
                return Response::error("could not seal the answer");
            };
            s.send_seq += 1;
            Response::SealedSignals { payloads: vec![sealed] }
        }
        #[cfg(not(windows))]
        {
            let _ = (session_id, sdp);
            Response::error("capture is only implemented on Windows")
        }
    }

    /// Seal a `power-failed` frame for the controller — the same shape the
    /// attended host sends (session.ts), rendered there as "could not
    /// <lock|shut down> that device: <reason>". A sealed reply, NOT a
    /// `Response::Error`: see the power arm for why an Error would end the
    /// session instead of informing it.
    fn power_failed(&mut self, session_id: &str, action: &str, reason: &str) -> Response {
        let Some(s) = self.sealed.get_mut(session_id) else {
            return Response::error("no sealed session with that id");
        };
        let frame = serde_json::json!({
            "kind": "power-failed",
            "action": action,
            "reason": reason,
            "sid": session_id,
            "n": s.send_seq,
        });
        let Some(sealed) = crate::control_key::seal(&s.key, &frame.to_string()) else {
            return Response::error("could not seal the refusal");
        };
        s.send_seq += 1;
        Response::SealedSignals { payloads: vec![sealed] }
    }

    /// The success twin of `power_failed`, for actions the controller WAITS
    /// on (the display power set): without an ack it cannot distinguish "the
    /// panels went dark" from "an old host ignored an action it never heard
    /// of", and its 5s timeout would blame a healthy host. `detail` is the
    /// optional human line (per-monitor DDC honesty on the attended host;
    /// None here — broadcasts have nothing to itemise).
    fn power_ack(&mut self, session_id: &str, action: &str, detail: Option<&str>) -> Response {
        let Some(s) = self.sealed.get_mut(session_id) else {
            return Response::error("no sealed session with that id");
        };
        let mut obj = serde_json::json!({
            "kind": "power-ack",
            "action": action,
            "sid": session_id,
            "n": s.send_seq,
        });
        if let Some(d) = detail {
            obj["detail"] = serde_json::Value::String(d.to_string());
        }
        let Some(sealed) = crate::control_key::seal(&s.key, &obj.to_string()) else {
            return Response::error("could not seal the ack");
        };
        s.send_seq += 1;
        Response::SealedSignals { payloads: vec![sealed] }
    }

    pub fn handle(&mut self, req: Request) -> Response {
        // Drain ALL pending stream events, matching each — a `while let Ok(Term…)`
        // would stop at the first SecureDesktop event and leave the rest (and the
        // Terminated events behind them) unhandled.
        #[cfg(windows)]
        while let Ok(event) = self.stream_events.1.try_recv() {
            match event {
                crate::stream::StreamEvent::Terminated { session_id, generation, reason } => {
                    let should_reap = self.streams.get(&session_id).is_some_and(|s| s.generation == generation);
                    if should_reap {
                        let reap_result = self.streams.get_mut(&session_id).expect("checked above").reap_terminated(generation);
                        match reap_result {
                            Ok(()) | Err(crate::stream::ReapError::Panicked(_)) | Err(crate::stream::ReapError::AlreadyReaped) => {
                                let _ = self.streams.remove(&session_id);
                                let key = StreamKey { session_id: session_id.clone(), generation };
                                self.sessions.remove(&session_id);
                                self.secure_desktop_up.remove(&session_id);
                                release_reservations(&mut self.monitor_reservations, &key);
                                eprintln!("[agent] reaped terminated stream session={session_id} gen={generation} reason={reason}");
                            }
                            Err(crate::stream::ReapError::GenerationMismatch { .. }) => {}
                        }
                    }
                }
                crate::stream::StreamEvent::SecureDesktop { session_id, generation, up } => {
                    // AN ELEVATED AGENT NEVER RAISES THIS, whatever its stream
                    // thread saw. `follow_input_desktop()` failing is what the
                    // stream reports, and for a SYSTEM agent that is a TRANSIENT
                    // condition, not a verdict: the lock-curtain -> PIN-box
                    // transition switches the input desktop underneath the
                    // follow, so one refusal mid-switch is normal and the retry
                    // two seconds later succeeds. Treating it as "a security
                    // screen is unreachable" put a banner over the very PIN box
                    // this agent exists to show — measured live, 2026-08-18.
                    //
                    // The gate is the FLAVOUR, not the follow result, because
                    // the question the viewer needs answered is "can this agent
                    // ever reach that desktop", and only the flavour answers it.
                    if self.flavour.is_elevated() {
                        continue;
                    }
                    // Ignore a late event from a superseded generation — a stream
                    // reaped and restarted must not have a stale flag resurrected.
                    let current = self.streams.get(&session_id).is_some_and(|s| s.generation == generation);
                    if current {
                        if up {
                            self.secure_desktop_up.insert(session_id);
                        } else {
                            self.secure_desktop_up.remove(&session_id);
                        }
                    }
                }
            }
        }

        if !self.authenticated {
            return match req {
                Request::Hello { token, version } => {
                    if version != PROTOCOL_VERSION {
                        return Response::error(format!(
                            "protocol mismatch: agent speaks {PROTOCOL_VERSION}, caller speaks {version}"
                        ));
                    }
                    if token.len() != self.token.len()
                        || token
                            .bytes()
                            .zip(self.token.bytes())
                            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                            != 0
                    {
                        return Response::error("not authenticated");
                    }
                    self.authenticated = true;
                    // MUST be Response::Hello, not Response::Ok. The app gates
                    // on the literal `"ok":"hello"` (agent_ipc.rs connect()),
                    // and anything else is read as "the agent refused our
                    // token" -> agent_probe false -> silent fallback to the
                    // webview host -> the browser's screen picker. Returning
                    // Response::Ok here shipped exactly that regression once.
                    Response::Hello {
                        version: PROTOCOL_VERSION,
                        platform: std::env::consts::OS.to_string(),
                    }
                }
                _ => Response::error("not authenticated"),
            };
        }

        match req {
            Request::Hello { .. } => Response::error("already authenticated"),

            Request::Capabilities => Response::Capabilities {
                capture: cfg!(windows) || (cfg!(feature = "vp8") && linux_x11_ready()),
                unattended: cfg!(windows) || (cfg!(feature = "vp8") && linux_x11_ready()),
                input: cfg!(windows) || linux_x11_ready(),
                // A real answer at last. This was hardcoded false because it was
                // always false — nothing could get through UAC or the lock
                // screen. A system-flavour agent can, and the app hides its
                // "cannot reach those" note on the strength of this field.
                elevated: self.flavour.is_elevated(),
                monitors: ScreenCapture::monitor_count(),
            },

            Request::ListMonitors => {
                let outputs = puca_capture::outputs();
                let list = puca_input::list_monitors();
                Response::Monitors {
                    // The same count SetMonitor bounds-checks against, so the
                    // picker cannot offer a screen the switch would refuse.
                    count: ScreenCapture::monitor_count(),
                    monitors: outputs.iter().map(|o| crate::protocol::MonitorDesc {
                        index: o.index,
                        left: o.left,
                        top: o.top,
                        width: o.width,
                        height: o.height,
                        // Joined by handle, never by position: this list is in
                        // capture order and that one is in GDI order.
                        primary: list
                            .monitors
                            .iter()
                            .any(|m| m.hmonitor != 0 && m.hmonitor == o.hmonitor && m.primary),
                    }).collect(),
                }
            }

            Request::StartCapture { session_id, monitor } => {
                if let Some(r) = self.gate(crate::flavour::Capability::Capture) {
                    return r;
                }
                let monitor = monitor.unwrap_or(0);
                if let std::collections::hash_map::Entry::Vacant(e) = self.captures.entry(monitor) {
                    let new_cap = if monitor == crate::composite::ALL_DISPLAYS {
                        VirtualCapture::new().map(AnyCapture::Virtual)
                    } else {
                        ScreenCapture::new(monitor).map(AnyCapture::Single)
                    };
                    match new_cap {
                        Ok(c) => {
                            e.insert(c);
                        }
                        Err(e) => return Response::error(format!("could not start capture: {e}")),
                    }
                }
                self.sessions.insert(session_id.clone(), monitor);
                // Aim input here too, not only in StartStream. This path shares
                // the same global target, so without it a raw session injects
                // using whatever screen the PREVIOUS session left aimed — or,
                // on Linux, errors outright because no target is set at all.
                Self::aim_input_at(monitor);

                #[cfg(target_os = "linux")]
                match puca_input::clear_stuck_keys() {
                    Ok(0) => {}
                    Ok(n) => eprintln!("[agent] released {n} key(s) held by a previous session"),
                    Err(e) => eprintln!("[agent] could not check for stuck keys: {e}"),
                }

                match self.grab(monitor, 500) {
                    Ok((w, h, _, _)) => Response::Started { session_id, width: w, height: h },
                    Err(CaptureError::Timeout) => {
                        Response::Started { session_id, width: 0, height: 0 }
                    }
                    Err(e) => Response::error(format!("capture started but produced nothing: {e}")),
                }
            }

            Request::NextFrame { session_id, timeout_ms } => {
                let Some(&monitor) = self.sessions.get(&session_id) else {
                    return Response::error("no such capture session");
                };
                match self.grab(monitor, timeout_ms.unwrap_or(250)) {
                    Ok((width, height, stride, bgra)) => Response::Frame {
                        width,
                        height,
                        stride,
                        bgra: b64(&bgra),
                    },
                    Err(CaptureError::Timeout) => Response::NoChange,
                    Err(CaptureError::AccessLost) => Response::NoChange,
                    Err(e) => Response::error(format!("{e}")),
                }
            }

            Request::StopCapture { session_id } => {
                let monitor = self.sessions.remove(&session_id);
                if let Some(m) = monitor {
                    if !self.sessions.values().any(|&other| other == m) {
                        self.captures.remove(&m);
                    }
                }
                puca_input::release_all();
                Response::Ok
            }

            #[cfg(windows)]
            Request::StartStream { session_id, monitor, offer_sdp, fps, bitrate, ice_servers, data_only } => {
                if let Some(r) = self.gate(crate::flavour::Capability::Capture) {
                    return r;
                }
                if self.streams.contains_key(&session_id) {
                    return Response::error("that session is already streaming");
                }
                let target_monitor = monitor.unwrap_or(0);
                // EVERY screen this stream would hold, not just the index it
                // was asked for: All Displays duplicates them all.
                //
                // A data-only session duplicates NOTHING, so it reserves nothing
                // and collides with nothing. Reserving for it would make a file
                // browse fail because somebody is watching the screen, which is
                // exactly backwards — and would strand a reservation nothing
                // ever released.
                let keys: Vec<usize> = if data_only {
                    Vec::new()
                } else {
                    reservation_keys(target_monitor, &puca_capture::outputs())
                };
                if keys.iter().any(|k| self.monitor_reservations.contains_key(k)) {
                    return Response::error("that monitor is already reserved by another streaming session");
                }
                if keys.iter().any(|k| self.captures.contains_key(k)) {
                    return Response::error("that monitor is already being captured by a raw session");
                }
                if let Some(f) = fps {
                    if !crate::protocol::ALLOWED_FPS.contains(&f) {
                        return Response::error(format!("unsupported fps: {}", f));
                    }
                }
                if let Some(b) = bitrate {
                    if !crate::protocol::ALLOWED_BITRATE_BPS.contains(&b) {
                        return Response::error(format!("unsupported bitrate bps: {}", b));
                    }
                }

                let generation = self.next_generation;
                self.next_generation = self.next_generation.wrapping_add(1);

                let stream_key = StreamKey { session_id: session_id.clone(), generation };
                for k in &keys {
                    self.monitor_reservations.insert(*k, stream_key.clone());
                }

                // R4: hand the stream this session's key ONLY when the
                // agent actually holds one (a sealed session opened through
                // the service). An attended session's key lives in the app,
                // so its stream gets None and input keeps the pipe path —
                // the agent is deliberately not a second client.
                let flavour_allows_input =
                    self.flavour.refusal(crate::flavour::Capability::Input).is_none();
                let input_channel = self.sealed.get(&session_id).map(|s| {
                    std::sync::Arc::new(crate::input_wire::InputChannel::new(
                        session_id.clone(), s.key, s.input_arm, s.ua_ok, flavour_allows_input,
                    ))
                });
                match crate::stream::start(
                    &offer_sdp,
                    target_monitor,
                    fps.unwrap_or(30),
                    bitrate.unwrap_or(6_000_000),
                    if data_only {
                        crate::stream::StreamMode::DataOnly
                    } else {
                        crate::stream::StreamMode::Video
                    },
                    &ice_servers,
                    self.stream_events.0.clone(),
                    session_id.clone(),
                    generation,
                    input_channel,
                ) {
                    Ok(stream) => {
                        let answer_sdp = stream.answer_sdp.clone();
                        self.streams.insert(session_id.clone(), stream);
                        // Only a session WITH a screen is recorded in the session
                        // map or given the input aim. That map is what `Inject`
                        // and `SetPrivacyMode` consult, and a session with no
                        // picture must not be able to move a pointer on one or
                        // blank a screen it cannot see.
                        if !data_only {
                            self.sessions.insert(session_id.clone(), target_monitor);
                            Self::aim_input_at(target_monitor);
                        }
                        Response::Streaming { session_id, answer_sdp }
                    }
                    Err(e) => {
                        release_reservations(&mut self.monitor_reservations, &stream_key);
                        eprintln!("[session] start_stream failed: {}", e);
                        Response::error(e)
                    }
                }
            }

            #[cfg(windows)]
            Request::AddRemoteCandidate { session_id, candidate } => {
                if candidate.len() > 512 {
                    return Response::error("candidate too long");
                }
                match self.streams.get(&session_id) {
                    Some(stream) => {
                        stream.add_remote_candidate(candidate);
                        Response::Ok
                    }
                    None => Response::error("no such stream"),
                }
            }

            #[cfg(windows)]
            Request::StopStream { session_id } => {
                if let Some(mut stream) = self.streams.remove(&session_id) {
                    let generation = stream.generation;
                    stream.stop_and_join();
                    let key = StreamKey { session_id: session_id.clone(), generation };
                    self.sessions.remove(&session_id);
                    self.secure_desktop_up.remove(&session_id);
                    release_reservations(&mut self.monitor_reservations, &key);
                }
                puca_input::release_all();
                // Nothing else ever turns the blackout off, and the agent
                // outlives the session — a session that ended with privacy
                // mode on used to leave the screen blanked for good.
                let _ = privacy::set_enabled(false);
                Response::Ok
            }

            #[cfg(windows)]
            Request::SetMonitor { session_id, monitor: target_monitor } => {
                // Counted the same way the index is: `ScreenCapture::monitor_count()`
                // is the length of the capture enumeration. Bounds-checking a
                // capture index against the GDI monitor count refuses a valid
                // index whenever the two disagree — cloned displays collapse to
                // one HMONITOR in GDI while DXGI still exposes both outputs, so
                // screen 2 was accepted at StartStream and refused on switch.
                let count = ScreenCapture::monitor_count();
                // ALL_DISPLAYS is a sentinel, not an index. StartStream already
                // accepts it (stream.rs builds a VirtualCapture for it), so
                // bounds-checking it here rejected the mobile "All Displays"
                // button with "there is no screen 256" — accepted at start,
                // refused on switch, for the same value.
                if target_monitor != crate::composite::ALL_DISPLAYS && target_monitor >= count {
                    return Response::error(format!(
                        "this computer has {count} screen(s); there is no screen {}",
                        target_monitor + 1
                    ));
                }

                // Every screen the TARGET would hold, so switching to All
                // Displays is refused when another session holds any single
                // member of it — not just when it holds the sentinel.
                let wanted = reservation_keys(target_monitor, &puca_capture::outputs());
                if wanted.iter().any(|k| {
                    self.monitor_reservations
                        .get(k)
                        .is_some_and(|held| held.session_id != session_id)
                }) {
                    return Response::error("that monitor is already reserved by another streaming session");
                }

                let stream = match self.streams.get(&session_id) {
                    Some(s) => s,
                    None => return Response::error("no live stream for that session"),
                };
                let generation = stream.generation;
                let req_id = self.next_request_id;
                self.next_request_id = self.next_request_id.wrapping_add(1);

                match stream.switch_monitor_sync(target_monitor, req_id, std::time::Duration::from_secs(2)) {
                    Ok(()) => {
                        let stream_key = StreamKey { session_id: session_id.clone(), generation };
                        // Release everything this stream held, then take what it
                        // holds now. Removing only the OLD index would strand the
                        // member reservations of a composite being left behind.
                        release_reservations(&mut self.monitor_reservations, &stream_key);
                        for k in &wanted {
                            self.monitor_reservations.insert(*k, stream_key.clone());
                        }
                        self.sessions.insert(session_id.clone(), target_monitor);
                        Self::aim_input_at(target_monitor);
                        Response::Ok
                    }
                    Err(e) => Response::error(format!("failed to switch monitor: {}", e)),
                }
            }

            #[cfg(windows)]
            Request::UpdateStream { session_id, fps, bitrate } => {
                if let Some(f) = fps {
                    if !crate::protocol::ALLOWED_FPS.contains(&f) {
                        return Response::error(format!("unsupported fps: {}", f));
                    }
                }
                if let Some(b) = bitrate {
                    if !crate::protocol::ALLOWED_BITRATE_BPS.contains(&b) {
                        return Response::error(format!("unsupported bitrate bps: {}", b));
                    }
                }

                let stream = match self.streams.get(&session_id) {
                    Some(s) => s,
                    None => return Response::error("no live stream for that session"),
                };

                let req_id = self.next_request_id;
                self.next_request_id = self.next_request_id.wrapping_add(1);

                match stream.update_quality_sync(fps, bitrate, req_id, std::time::Duration::from_secs(1)) {
                    Ok((current_fps, current_bitrate_bps)) => Response::StreamQualityAck {
                        session_id,
                        fps: current_fps,
                        bitrate_kbps: current_bitrate_bps / 1000,
                        applied: true,
                    },
                    Err(e) => Response::error(format!("failed to apply quality: {}", e)),
                }
            }

            #[cfg(windows)]
            Request::QueryStreamQuality { session_id } => {
                match self.streams.get(&session_id) {
                    Some(stream) => {
                        let (current_fps, current_bitrate_bps) = stream.query_quality();
                        Response::StreamQualityAck {
                            session_id,
                            fps: current_fps,
                            bitrate_kbps: current_bitrate_bps / 1000,
                            applied: true,
                        }
                    }
                    None => Response::error("no live stream for that session"),
                }
            }

            #[cfg(windows)]
            Request::RequestKeyframe { session_id } => match self.streams.get(&session_id) {
                Some(stream) => {
                    stream.request_keyframe();
                    Response::Ok
                }
                None => Response::error("no live stream for that session"),
            },

            #[cfg(windows)]
            Request::SetDrawCursor { session_id, enabled } => {
                // The STREAM map, not `sessions`: this changes encoded pixels,
                // so it only means anything while something is streaming. A
                // raw capture session draws its own frames and has no pump to
                // notify.
                match self.streams.get(&session_id) {
                    Some(stream) => {
                        stream.set_draw_cursor(enabled);
                        Response::Ok
                    }
                    None => Response::error("no live stream for that session"),
                }
            }

            // Cross-platform: a read-only status poll. On a platform with no
            // secure desktop (Linux) the honest answer is simply `false`, not an
            // error — the app polls this and an error would read as a fault.
            Request::SessionStatus { session_id } => {
                #[cfg(windows)]
                let secure_desktop = self.secure_desktop_up.contains(&session_id);
                #[cfg(not(windows))]
                let secure_desktop = {
                    let _ = &session_id;
                    false
                };
                // Answered for THIS session's streamed monitor (`self.sessions`
                // is maintained at every aim site), never the process-global
                // input target — two concurrent sessions stream different
                // screens and the global only describes whichever aimed last.
                // Elevated gate mirrors secure_desktop's: a SYSTEM agent lives
                // on whatever desktop Windows is showing, its handler thread
                // never follows the interactive desktop, and a clip banner
                // over the PIN box would explain a conflict that does not
                // apply there. Live-read per poll, no cache: the caller is
                // already 1 Hz and the probe is two user32 reads.
                let cursor_clipped = !self.flavour.is_elevated()
                    && self
                        .sessions
                        .get(&session_id)
                        .and_then(|&mon| {
                            let outputs = puca_capture::outputs();
                            let list = puca_input::list_monitors();
                            resolve_target(mon, &outputs, &list)
                        })
                        .map(puca_input::cursor_clip_conflict_for)
                        .unwrap_or(false);
                Response::SessionState { secure_desktop, cursor_clipped }
            }

            #[cfg(not(windows))]
            Request::StartStream { .. }
            | Request::StopStream { .. }
            | Request::SetMonitor { .. }
            | Request::UpdateStream { .. }
            | Request::QueryStreamQuality { .. }
            | Request::RequestKeyframe { .. }
            | Request::SetDrawCursor { .. }
            | Request::DisplayTopologyChanged
            | Request::AddRemoteCandidate { .. } => {
                Response::error("streaming is only implemented on Windows")
            }

            // The desktop's topology changed under every live capture (the
            // shell detached or reattached displays). Rebuild each video
            // stream against a fresh enumeration, retargeting a vanished
            // index to output 0, then move the books — reservations, the
            // session's monitor record, the input aim — exactly as a switch
            // does. Sessions the shell hosts without a stream keep their
            // records; the input aim is re-derived even for an unchanged id
            // because the VIRTUAL DESKTOP rect (which absolute moves are
            // normalised over) changed with the topology.
            #[cfg(windows)]
            Request::DisplayTopologyChanged => {
                let count = ScreenCapture::monitor_count();
                let ids: Vec<String> = self.streams.keys().cloned().collect();
                let mut failures: Vec<String> = Vec::new();
                for session_id in ids {
                    let Some(&mon) = self.sessions.get(&session_id) else {
                        continue; // data-only: no capture, no aim
                    };
                    let target = if mon == crate::composite::ALL_DISPLAYS || mon < count {
                        mon
                    } else {
                        0
                    };
                    // The same cross-session refusal SetMonitor enforces —
                    // without it, two sessions remapped onto the one surviving
                    // output would fight over an exclusive duplication and the
                    // loser's rebuild could only fail. A skipped session keeps
                    // its books and its (dead) capture; the reattach's next
                    // topology poke revives it once its screen exists again.
                    let wanted = reservation_keys(target, &puca_capture::outputs());
                    if wanted.iter().any(|k| {
                        self.monitor_reservations
                            .get(k)
                            .is_some_and(|held| held.session_id != session_id)
                    }) {
                        eprintln!(
                            "[agent] topology change: session {session_id} not retargeted to \
                             monitor {target} — another session streams it"
                        );
                        continue;
                    }
                    let Some(stream) = self.streams.get(&session_id) else { continue };
                    let generation = stream.generation;
                    match stream.rebuild_capture_sync(target, std::time::Duration::from_secs(5)) {
                        Ok(()) => {
                            let stream_key = StreamKey { session_id: session_id.clone(), generation };
                            release_reservations(&mut self.monitor_reservations, &stream_key);
                            for k in reservation_keys(target, &puca_capture::outputs()) {
                                self.monitor_reservations.insert(k, stream_key.clone());
                            }
                            self.sessions.insert(session_id.clone(), target);
                            Self::aim_input_at(target);
                        }
                        Err(e) => failures.push(format!("{session_id}: {e}")),
                    }
                }
                if failures.is_empty() {
                    Response::Ok
                } else {
                    Response::error(format!("capture rebuild failed for {}", failures.join("; ")))
                }
            }

            Request::Inject { session_id, event } => {
                if let Some(r) = self.gate(crate::flavour::Capability::Input) {
                    return r;
                }
                if !self.sessions.contains_key(&session_id) {
                    return Response::error("no such capture session");
                }
                match serde_json::from_value(event) {
                    Ok(parsed) => match dispatch_input(parsed) {
                        Ok(()) => Response::Ok,
                        Err(e) => {
                            let now = std::time::Instant::now();
                            // Written as a match rather than `is_none_or`: that
                            // method landed in Rust 1.82 and this workspace
                            // declares 1.77.2, so it builds here and breaks a
                            // toolchain that honours the floor.
                            let due = match self.last_inject_error_log {
                                None => true,
                                Some(t) => now.duration_since(t) >= std::time::Duration::from_secs(1),
                            };
                            if due {
                                self.last_inject_error_log = Some(now);
                                eprintln!("[session] inject failed: {e}");
                            }
                            Response::error(e)
                        }
                    },
                    Err(e) => Response::error(format!("unrecognised input event: {e}")),
                }
            }

            Request::OpenSession {
                session_id, static_shared, peer_eph_pub, ice_servers, input_granted,
            } => {
                if let Some(r) = self.gate(crate::flavour::Capability::Input) {
                    return r;
                }
                use base64::Engine;
                let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(&static_shared)
                else {
                    return Response::error("static_shared is not base64");
                };
                let Ok(shared): Result<[u8; 32], _> = raw.try_into() else {
                    return Response::error("static_shared must be 32 bytes");
                };

                // A FRESH EPHEMERAL PER SESSION. Reusing one across sessions
                // would make two sessions share a key whenever the peer reused
                // theirs, so a frame captured in one would replay into the
                // other.
                let mut eph = [0u8; 32];
                if getrandom::getrandom(&mut eph).is_err() {
                    return Response::error("no system randomness");
                }
                let Some(key) = crate::control_key::derive(&shared, &eph, &peer_eph_pub) else {
                    return Response::error("could not derive the session key");
                };
                let eph_pub = crate::control_key::encode_public_key(
                    x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(eph))
                        .as_bytes(),
                );
                // FAIL CLOSED WHEN NOBODY CAN APPROVE IN PERSON.
                //
                // `!is_armed()` alone was the app's rule and is right there: an
                // unarmed machine means the session was approved by a human at
                // the keyboard, so demanding a passphrase as well would be
                // asking twice. But `SystemInteractive` is the flavour that ONLY
                // exists at the lock and sign-in screens, where there is nobody
                // to ask — `requestHostConsent` denies outright with no UI
                // handler registered, and a headless host never has one.
                //
                // So for that flavour an unarmed gate must mean REFUSED, not
                // waved through. Written the other way round this is a session
                // that types the owner's Windows password with no proof of who
                // asked for it.
                let ua_required = self.ua.is_armed()
                    || self.flavour == crate::flavour::Flavour::SystemInteractive;
                self.sealed.insert(
                    session_id,
                    SealedSession {
                        key,
                        recv_seq: -1,
                        input_arm: if input_granted {
                            crate::input_wire::InputArm::allowed()
                        } else {
                            crate::input_wire::InputArm::refused()
                        },
                        ua_ok: !ua_required,
                        recv_sig_seq: -1,
                        send_seq: 0,
                        ice_servers,
                        pending_offer: None,
                        pending_ice: Vec::new(),
                    },
                );
                Response::SessionOpened { eph_pub }
            }

            Request::UaChallenge { session_id } => {
                if !self.sealed.contains_key(&session_id) {
                    return Response::error("no sealed session with that id");
                }
                let Some(salt) = self.ua.salt() else {
                    return Response::error("unattended access is not armed on this computer");
                };
                match self.ua.issue_challenge(now_ms()) {
                    Ok(nonce) => Response::UaChallenge {
                        nonce: b64(&nonce),
                        salt: b64(&salt),
                    },
                    Err(e) => Response::error(format!("{e:?}")),
                }
            }

            Request::UaProve { session_id, nonce, sig } => {
                use base64::Engine;
                let b64d = |s: &str| base64::engine::general_purpose::STANDARD.decode(s).ok();
                let (Some(n), Some(g)) = (b64d(&nonce), b64d(&sig)) else {
                    return Response::error("nonce and sig must be base64");
                };
                let Ok(n): Result<[u8; 32], _> = n.try_into() else {
                    return Response::error("nonce must be 32 bytes");
                };
                // THE CONTEXT IS THE SESSION ID, matching what the shipping
                // controller signs (session.ts:3241 passes `s.id`). Binding the
                // proof to a session is what stops one captured response
                // authorising a different peer's session later.
                match self.ua.verify(&n, &session_id, &g, now_ms()) {
                    Ok(()) => match self.sealed.get_mut(&session_id) {
                        Some(s) => {
                            s.ua_ok = true;
                            Response::Ok
                        }
                        None => Response::error("no sealed session with that id"),
                    },
                    // The reason is deliberately not echoed: a wrong passphrase
                    // and an expired nonce must look the same from outside, or
                    // this becomes an oracle for which half was wrong.
                    Err(_) => Response::error("unattended access was refused"),
                }
            }

            Request::SealedChallenge { session_id } => {
                let Some(salt) = self.ua.salt() else {
                    // Unarmed. For SystemInteractive this is terminal — there is
                    // nobody at the machine to approve instead — and OpenSession
                    // has already refused the session by leaving ua_ok false.
                    return Response::error("unattended access is not armed on this computer");
                };
                if !self.sealed.contains_key(&session_id) {
                    return Response::error("no sealed session with that id");
                }
                let nonce = match self.ua.issue_challenge(now_ms()) {
                    Ok(n) => b64(&n),
                    Err(e) => return Response::error(format!("{e:?}")),
                };
                let Some(s) = self.sealed.get_mut(&session_id) else {
                    return Response::error("no sealed session with that id");
                };
                let frame = serde_json::json!({
                    "kind": "ua-challenge",
                    "nonce": nonce,
                    "salt": b64(&salt),
                    "sid": session_id,
                    "n": s.send_seq,
                });
                let Some(sealed) = crate::control_key::seal(&s.key, &frame.to_string()) else {
                    return Response::error("could not seal the challenge");
                };
                s.send_seq += 1;
                Response::SealedSignals { payloads: vec![sealed] }
            }

            Request::SealedSignal { session_id, payload } => {
                // OPENING IS NOT AUTHORISATION HERE, and unlike InjectSealed it
                // cannot be gated on ua_ok — the ua-response that SETS ua_ok
                // arrives inside one of these frames, so requiring it first
                // would deadlock. Opening is already gated on holding the
                // session key, which only the peer that completed the DH does.
                // What is gated is ACTING: the offer branch refuses until the
                // passphrase is proved.
                let Some(s) = self.sealed.get_mut(&session_id) else {
                    return Response::error("no sealed session with that id");
                };
                let Some(plain) = crate::control_key::open(&s.key, &payload) else {
                    return Response::error("that frame could not be opened");
                };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&plain) else {
                    return Response::error("that frame was not the expected shape");
                };

                // The session id is INSIDE the sealed frame as well as outside.
                // Checking it stops a frame captured from one session being
                // relayed into another that shares a key.
                if v.get("sid").and_then(|x| x.as_str()) != Some(session_id.as_str()) {
                    return Response::error("that frame belongs to another session");
                }
                let Some(n) = v.get("n").and_then(|x| x.as_i64()) else {
                    return Response::error("that frame was not the expected shape");
                };
                if n <= s.recv_sig_seq {
                    // Replayed or reordered. Accepted quietly rather than
                    // errored, matching InjectSealed: a controller resends on a
                    // flaky link and an error per duplicate reads as a fault.
                    return Response::SealedSignals { payloads: vec![] };
                }
                s.recv_sig_seq = n;

                match v.get("kind").and_then(|x| x.as_str()) {
                    Some("ua-response") => {
                        let (Some(nonce), Some(sig)) = (
                            v.get("nonce").and_then(|x| x.as_str()),
                            v.get("sig").and_then(|x| x.as_str()),
                        ) else {
                            return Response::error("that frame was not the expected shape");
                        };
                        // Decoded exactly as UaProve does: verify() takes the
                        // raw 32-byte nonce and raw signature bytes, and the
                        // CONTEXT is the session id — matching what the shipping
                        // controller signs (session.ts:3241 passes `s.id`).
                        use base64::Engine;
                        let b64d =
                            |x: &str| base64::engine::general_purpose::STANDARD.decode(x).ok();
                        let (Some(n), Some(g)) = (b64d(nonce), b64d(sig)) else {
                            return Response::error("nonce and sig must be base64");
                        };
                        let Ok(n): Result<[u8; 32], _> = n.try_into() else {
                            return Response::error("nonce must be 32 bytes");
                        };
                        match self.ua.verify(&n, &session_id, &g, now_ms()) {
                            Ok(()) => {
                                let held = self.sealed.get_mut(&session_id).and_then(|s| {
                                    s.ua_ok = true;
                                    s.pending_offer.take()
                                });
                                // RELEASE WHATEVER WAS HELD, so proving the
                                // passphrase resumes the session rather than
                                // leaving the controller on a black tile
                                // waiting for a renegotiation it has no reason
                                // to start — the same reasoning as
                                // session.ts:3259's "held" release.
                                match held {
                                    Some(sdp) => self.answer_offer_now(&session_id, sdp),
                                    None => Response::SealedSignals { payloads: vec![] },
                                }
                            }
                            // Not echoed: a wrong passphrase and an expired
                            // nonce must look identical from outside.
                            Err(_) => Response::error("unattended access was refused"),
                        }
                    }

                    Some("ice") => {
                        // The frame carries an RTCIceCandidateInit; the agent
                        // wants the SDP line, which is that object's own
                        // `candidate` field.
                        let line = v
                            .get("candidate")
                            .and_then(|c| c.get("candidate").or(Some(c)))
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_string();
                        if !line.is_empty() {
                            // `streams` is Windows-only (like every stream
                            // request); elsewhere no stream can exist yet, so
                            // every candidate takes the held path below —
                            // same shape as SessionStatus's cfg split.
                            #[cfg(windows)]
                            let stream_live = self.streams.contains_key(&session_id);
                            #[cfg(not(windows))]
                            let stream_live = false;
                            if stream_live {
                                // Deliberately swallowed. Chrome emits mDNS
                                // .local candidates the agent cannot parse, and
                                // ending the session over one would discard the
                                // srflx and relay candidates that actually
                                // connect (hostAgent.ts:213-215).
                                let _ = self.handle(Request::AddRemoteCandidate {
                                    session_id: session_id.clone(),
                                    candidate: line,
                                });
                            } else if let Some(s) = self.sealed.get_mut(&session_id) {
                                // HELD, same as the offer. The stream does not
                                // exist yet — StartStream has not run — so
                                // AddRemoteCandidate would answer "no such
                                // stream" and the caller would discard it. See
                                // SealedSession::pending_ice.
                                if s.pending_ice.len() < 128 {
                                    s.pending_ice.push(line);
                                }
                            }
                        }
                        Response::SealedSignals { payloads: vec![] }
                    }

                    Some("offer") => {
                        // A files-only session has no screen to show, and there
                        // is no file-access path at a sign-in screen anyway
                        // (Flavour::SystemInteractive denies Capability::FileAccess).
                        // Checked BEFORE the passphrase gate, matching the JS
                        // host's ordering (session.ts:3757): this refusal can
                        // never become true later, so there is nothing to hold.
                        if v.get("filesOnly").and_then(|x| x.as_bool()).unwrap_or(false) {
                            return Response::error(
                                "file transfer is not available at the sign-in screen",
                            );
                        }
                        let Some(sdp) = v.get("sdp").and_then(|x| x.as_str()).map(str::to_string)
                        else {
                            return Response::error("that frame was not the expected shape");
                        };

                        // THE GATE THE WHOLE CHALLENGE EXISTS FOR — but HELD,
                        // NOT REFUSED. The controller sends this offer the
                        // instant it is accepted, concurrently with the
                        // passphrase prompt, so for an armed session this
                        // branch running before ua_ok is true is the ORDINARY
                        // case, not a race to reject. See pending_offer.
                        let ua_ok = self.sealed.get(&session_id).map(|x| x.ua_ok).unwrap_or(false);
                        if !ua_ok {
                            if let Some(s) = self.sealed.get_mut(&session_id) {
                                s.pending_offer = Some(sdp);
                            }
                            return Response::SealedSignals { payloads: vec![] };
                        }
                        self.answer_offer_now(&session_id, sdp)
                    }

                    // POWER — lock (a no-op here: the console IS locked, that
                    // is why this flavour is running) or shut the machine down.
                    // Gated exactly like input: flavour capability + the
                    // proven passphrase.
                    //
                    // WHAT GOES BACK, AND WHY. A `Response::Error` from this
                    // arm is NOT "an error message for the controller": the
                    // service treats a signalling error as session-ending
                    // (link.rs turns it into a DeviceEnd carrying the message
                    // and closes the session). So:
                    //  - a refusal or a failure is sealed as `power-failed`,
                    //    the frame the controller already renders, and the
                    //    session lives on — a shutdown the OS refused must not
                    //    cost the operator their picture;
                    //  - an unproved passphrase is answered with SILENCE, as
                    //    the attended host does (nothing is owed to a peer that
                    //    has not proved itself, and an Error would end it);
                    //  - a shutdown that WAS accepted deliberately answers
                    //    `Error(SHUTDOWN_REASON)`: that is the one path to a
                    //    DeviceEnd with a reason, so the controller reads "the
                    //    device is shutting down" — the attended host's exact
                    //    words — instead of "connection lost" when the box goes.
                    Some("power") => {
                        if let Some(r) = self.gate(crate::flavour::Capability::Power) {
                            return r;
                        }
                        let ua_ok = self.sealed.get(&session_id).map(|x| x.ua_ok).unwrap_or(false);
                        if !ua_ok {
                            return Response::SealedSignals { payloads: vec![] };
                        }
                        let requested = v.get("action").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        let Some(action) = crate::power::PowerAction::parse(&requested) else {
                            return self.power_failed(&session_id, &requested, "that power action is not one this agent knows");
                        };
                        match dispatch_power(crate::power::plan(action)) {
                            Ok(()) if action == crate::power::PowerAction::Shutdown => {
                                Response::error(crate::power::SHUTDOWN_REASON)
                            }
                            // Display actions are ACKED: the controller arms a
                            // 5s wait for exactly these, and silence must keep
                            // meaning "old host" rather than "success".
                            Ok(()) if action == crate::power::PowerAction::DisplaysOff => {
                                // Honest caveat: SC_MONITORPOWER sleep ends on
                                // ANY input — including keys this very session
                                // injects to sign in. Off-until-you-type is
                                // still what the ask means at a lock screen,
                                // but the ack must not oversell it.
                                self.power_ack(
                                    &session_id,
                                    &requested,
                                    Some("Displays sleep until the next input — typing here wakes them"),
                                )
                            }
                            Ok(()) if action == crate::power::PowerAction::DisplaysOn => {
                                self.power_ack(&session_id, &requested, None)
                            }
                            Ok(()) => Response::SealedSignals { payloads: vec![] },
                            Err(e) => self.power_failed(&session_id, &requested, &e),
                        }
                    }

                    // Unknown kinds are ignored rather than errored: the
                    // controller may be newer than this agent, and a refusal
                    // would end a session over a frame that did not matter.
                    _ => Response::SealedSignals { payloads: vec![] },
                }
            }

            Request::InjectSealed { session_id, payload } => {
                if let Some(r) = self.gate(crate::flavour::Capability::Input) {
                    return r;
                }
                let Some(s) = self.sealed.get_mut(&session_id) else {
                    return Response::error("no sealed session with that id");
                };
                // AUTHORISATION BEFORE DECRYPTION. Opening first would mean a
                // peer who cannot prove the passphrase still gets the agent to
                // decrypt attacker-chosen bytes, and the timing difference
                // between "opened then refused" and "refused" is itself a
                // signal.
                if !s.ua_ok {
                    return Response::error("this session has not proved unattended access");
                }
                let Some(plain) = crate::control_key::open(&s.key, &payload) else {
                    return Response::error("that frame could not be opened");
                };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&plain) else {
                    return Response::error("that frame was not the expected shape");
                };
                // INPUT frames are {s, e} with a strictly increasing s. They
                // carry no sid and no n — those belong to SIGNALLING frames,
                // and requiring them here would drop every keystroke the
                // shipping controller sends.
                let Some(seq) = v.get("s").and_then(|x| x.as_i64()) else {
                    return Response::error("that frame was not the expected shape");
                };
                if seq <= s.recv_seq {
                    // Replayed or reordered. Silently accepted as OK rather
                    // than errored: the controller resends on a flaky link, and
                    // an error per duplicate would look like a broken session.
                    return Response::Ok;
                }
                s.recv_seq = seq;
                let Some(event) = v.get("e").cloned() else {
                    return Response::error("that frame was not the expected shape");
                };
                match serde_json::from_value(event) {
                    Ok(parsed) => match dispatch_input(parsed) {
                        Ok(()) => Response::Ok,
                        // The error names the CAUSE, never the event: a message
                        // echoing the frame would put the plaintext back above
                        // this process, which is the whole thing this path
                        // exists to prevent.
                        Err(e) => Response::error(e),
                    },
                    Err(_) => Response::error("unrecognised input event"),
                }
            }

            Request::SetPrivacyMode { session_id, enabled } => {
                if let Some(r) = self.gate(crate::flavour::Capability::PrivacyMode) {
                    return r;
                }
                // Scoped to a live session, the way Inject is: a privacy
                // overlay toggled by a session that has already ended leaves
                // the screen blanked with nothing left to un-blank it.
                // The SESSION map specifically, not "either map".
                //
                // It used to accept a match in `streams` too, which was harmless
                // while every stream also had a session — but a data-only stream
                // deliberately has no session, because it has no screen. Accepting
                // it here would let a peer who can never SEE this display blank
                // it, and then the un-blank is owned by a session that was never
                // watching. Every legitimate caller (a raw capture or a real
                // stream) is in `sessions`.
                if !self.sessions.contains_key(&session_id) {
                    return Response::error("no live session for that id");
                }
                match privacy::set_enabled(enabled) {
                    Ok(()) => Response::Ok,
                    Err(e) => Response::error(e),
                }
            }

            #[cfg(windows)]
            Request::SetFileAccess { session_id, root, policy } => {
                // BEFORE the session lookup, so the answer does not depend on
                // whether a stream happens to be live: a refusal that only
                // appears once you have a session reads as a transient error
                // and gets retried forever.
                if let Some(msg) = self.flavour.refusal(crate::flavour::Capability::FileAccess) {
                    return Response::error(msg);
                }
                let stream = match self.streams.get(&session_id) {
                    Some(s) => s,
                    None => return Response::error("no live stream for that session"),
                };
                // Both at once is a confused caller, and the two plausible ways
                // to resolve it are "take the folder" and "take the policy" —
                // the second of which silently WIDENS the grant. Refuse instead:
                // an ambiguous scope request must not be answered by guessing
                // the more permissive half of it.
                if policy && root.is_some() {
                    return Response::error(
                        "ambiguous file scope: a folder and the unattended policy were both requested",
                    );
                }
                // CANONICALISED AT THE GRANT, which is what `FileScope::Jailed`
                // has always claimed and this call site did not do. It was not
                // only a doc/code mismatch: `resolve` canonicalises the TARGET
                // and compares it against the root, so a folder reached through
                // a junction, a directory symlink, a `subst` drive or an 8.3
                // short name — all ordinary on Windows, e.g. a redirected
                // profile folder — resolved out from under a raw root and every
                // operation inside the folder the user had just picked was
                // refused with "path leaves the granted folder through a link".
                //
                // A root that cannot be resolved now fails the GRANT, loudly,
                // rather than becoming a jail that cannot be enforced.
                let scope = if policy {
                    Some(crate::file_transfer::FileScope::Policy)
                } else {
                    match root.as_deref() {
                        None => None,
                        Some(r) => match crate::file_transfer::FileScope::jailed(r) {
                            Ok(s) => Some(s),
                            Err(e) => return Response::error(e),
                        },
                    }
                };
                let described = match &scope {
                    None => "REVOKED".to_string(),
                    Some(crate::file_transfer::FileScope::Policy) => {
                        "POLICY (fixed drives minus system paths)".to_string()
                    }
                    Some(crate::file_transfer::FileScope::Jailed(p)) => p.display().to_string(),
                };
                match stream.set_file_scope(scope) {
                    Ok(()) => {
                        eprintln!("[session] file access for {session_id}: {described}");
                        Response::Ok
                    }
                    Err(e) => Response::error(e),
                }
            }
            #[cfg(not(windows))]
            Request::SetFileAccess { .. } => Response::error("file access is Windows-only for now"),

            Request::ReleaseInput => {
                puca_input::release_all();
                Response::Ok
            }
        }
    }

    fn grab(
        &mut self,
        monitor: usize,
        timeout_ms: u32,
    ) -> Result<(u32, u32, usize, Vec<u8>), CaptureError> {
        let cap = self
            .captures
            .get_mut(&monitor)
            .ok_or_else(|| CaptureError::Failed("capture not started".into()))?;
        let f = cap.next_frame(timeout_ms)?;
        Ok((f.width, f.height, f.stride, f.bgra))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> Agent {
        Agent::new("s3cret-token".to_string(), crate::flavour::Flavour::User)
    }

    fn hello(token: &str, version: u32) -> Request {
        Request::Hello { token: token.to_string(), version }
    }

    // --- monitor aiming ----------------------------------------------------
    //
    // The layout below is the REPORTER'S REAL DESKTOP, measured with DXGI and
    // GDI side by side on their machine:
    //
    //   dxgi[0] \\.\DISPLAY3  (0,0)..(2560,1440)     hmon 0x10d016f  (primary)
    //   dxgi[1] \\.\DISPLAY1  (2560,-685)..(4000,1875)  hmon 0x10079
    //   dxgi[2] \\.\DISPLAY2  (-1440,-692)..(0,1868)    hmon 0x20001
    //   gdi[0] = DISPLAY2, gdi[1] = DISPLAY1, gdi[2] = DISPLAY3
    //
    // Two of the three indexes differ between the enumerations, which is
    // exactly the shape that made the cursor move on a screen the viewer was
    // not watching.

    fn out(index: usize, left: i32, top: i32, width: i32, height: i32, hmonitor: isize)
        -> puca_capture::OutputInfo {
        puca_capture::OutputInfo {
            index, left, top, width, height, hmonitor,
            // Aiming works in DESKTOP coordinates, which already account for a
            // rotated panel — the rotation only affects how the captured
            // surface is turned, so it is not part of this mapping.
            rotation: puca_capture::Rotation::None,
        }
    }

    fn gdi(index: usize, left: i32, top: i32, width: i32, height: i32, hmonitor: isize, primary: bool)
        -> puca_input::MonitorInfo {
        puca_input::MonitorInfo {
            index, left, top, width, height, scale: 1.0, primary, hmonitor,
        }
    }

    /// DXGI order, as `puca_capture::outputs()` reports it.
    fn reporter_outputs() -> Vec<puca_capture::OutputInfo> {
        vec![
            out(0, 0, 0, 2560, 1440, 0x10d016f),
            out(1, 2560, -685, 1440, 2560, 0x10079),
            out(2, -1440, -692, 1440, 2560, 0x20001),
        ]
    }

    /// GDI order, as `puca_input::list_monitors()` reports it. DELIBERATELY
    /// a different order from the above.
    fn reporter_gdi() -> puca_input::MonitorList {
        puca_input::MonitorList {
            monitors: vec![
                gdi(0, -1440, -692, 1440, 2560, 0x20001, false),
                gdi(1, 2560, -685, 1440, 2560, 0x10079, false),
                gdi(2, 0, 0, 2560, 1440, 0x10d016f, true),
            ],
            virt_left: -1440,
            virt_top: -692,
            virt_width: 5440,
            virt_height: 2567,
        }
    }

    #[test]
    fn input_is_aimed_at_the_screen_that_is_being_captured() {
        let outputs = reporter_outputs();
        let list = reporter_gdi();
        for o in &outputs {
            let t = resolve_target(o.index, &outputs, &list)
                .unwrap_or_else(|| panic!("no target for capture index {}", o.index));
            assert_eq!(
                (t.left, t.top, t.width, t.height),
                (o.left, o.top, o.width, o.height),
                "capture index {} was aimed at a different screen than it captures",
                o.index,
            );
            // The virtual desktop is what absolute coordinates normalise over,
            // so it must be the whole desktop regardless of which screen is
            // targeted.
            assert_eq!((t.virt_left, t.virt_top), (-1440, -692));
            assert_eq!((t.virt_width, t.virt_height), (5440, 2567));
        }
    }

    /// POSITIVE CONTROL for the test above.
    ///
    /// Without this, `input_is_aimed_at_the_screen_that_is_being_captured`
    /// would still pass on a machine whose two enumerations happen to agree —
    /// and prove nothing. This asserts the fixture really does disagree, i.e.
    /// that the old positional lookup WOULD have aimed at the wrong screen for
    /// indexes 0 and 2.
    #[test]
    fn the_two_enumerations_really_do_disagree_in_this_fixture() {
        let outputs = reporter_outputs();
        let list = reporter_gdi();
        let mut wrong = 0;
        for o in &outputs {
            // The old behaviour: index the GDI list positionally.
            let old = &list.monitors[o.index];
            if (old.left, old.top) != (o.left, o.top) {
                wrong += 1;
            }
        }
        assert_eq!(
            wrong, 2,
            "the fixture must reproduce the mismatch, or the aiming test cannot fail",
        );
    }

    #[test]
    fn all_displays_is_aimed_at_the_whole_composited_surface() {
        let outputs = reporter_outputs();
        let t = resolve_target(crate::composite::ALL_DISPLAYS, &outputs, &reporter_gdi())
            .expect("All Displays must resolve to the composite surface");
        assert_eq!((t.left, t.top), (-1440, -692));
        // The extent the composite actually SHOWS, which is the union rounded
        // down to a whole number of steps and to even dimensions. The union
        // here is 5440x2567 and the surface is 2720x1282 at step 2, so three
        // rows of desktop are cropped — and the viewer, who normalises over
        // what is on screen, must be aimed at the 2564 they can see rather
        // than the 2567 that exists.
        let (step, w, h) = crate::composite::composite_geometry(5440, 2567);
        assert_eq!((step, w, h), (2, 2720, 1282));
        assert_eq!((t.width, t.height), (5440, 2564));
    }

    /// The crop must be VISIBLE to this test, or it is asserting a coincidence.
    #[test]
    fn a_union_that_does_not_divide_evenly_is_aimed_short_of_its_full_height() {
        // 4000x2161 -> step 2 -> 2000x1080 -> covered height 2160, i.e. one row
        // of desktop is not composited and must not be aimed at.
        let outputs = vec![out(0, 0, 0, 4000, 2161, 0x1)];
        let list = puca_input::MonitorList {
            monitors: vec![],
            virt_left: 0, virt_top: 0, virt_width: 4000, virt_height: 2161,
        };
        let t = resolve_target(crate::composite::ALL_DISPLAYS, &outputs, &list).expect("resolves");
        assert_eq!(t.height, 2160, "the uncomposited row must not be aimed at");
        assert_eq!(t.width, 4000);
    }

    #[test]
    fn an_index_with_no_output_clears_the_aim_instead_of_keeping_a_stale_one() {
        let outputs = reporter_outputs();
        let list = reporter_gdi();
        assert!(resolve_target(3, &outputs, &list).is_none());
        assert!(resolve_target(99, &outputs, &list).is_none());
        // And with nothing capturable at all, including the sentinel: silently
        // reusing the previous session's screen is how input lands on a display
        // this session never showed.
        assert!(resolve_target(0, &[], &list).is_none());
        assert!(resolve_target(crate::composite::ALL_DISPLAYS, &[], &list).is_none());
    }

    /// `outputs()` reports the WALK position and omits anything it could not
    /// describe, so the vector can have gaps. Resolving by vector position
    /// would then hand back the neighbouring screen — the same off-by-one-
    /// screen failure, reintroduced by the fix for it.
    #[test]
    fn a_gap_in_the_output_list_does_not_shift_the_aim_onto_the_next_screen() {
        // Output 1 could not be described and is absent; 0 and 2 remain, and 2
        // is still the third output as far as capture is concerned.
        let outputs = vec![
            out(0, 0, 0, 2560, 1440, 0x10d016f),
            out(2, -1440, -692, 1440, 2560, 0x20001),
        ];
        let list = reporter_gdi();

        let t = resolve_target(2, &outputs, &list).expect("index 2 is still capturable");
        assert_eq!(
            (t.left, t.top, t.width, t.height),
            (-1440, -692, 1440, 2560),
            "index 2 must resolve to output 2, not to the second entry in the list",
        );
        // And the missing one resolves to nothing rather than to a neighbour.
        assert!(resolve_target(1, &outputs, &list).is_none());
    }

    // --- the caret mapping -------------------------------------------------
    //
    // Every expected number below is hand-derived from the fixture and written
    // as the arithmetic that produces it, never as a decimal transcribed from a
    // test run — an assertion on this function's own output would pass whatever
    // it did.

    fn frac(caret: (i32, i32, i32, i32), surface: CaptureSurface) -> crate::caret_wire::CaretFractions {
        caret_fractions(caret, surface).expect("this caret is on this surface")
    }

    #[test]
    fn a_caret_maps_to_fractions_of_the_screen_being_captured() {
        let screen = CaptureSurface::Single { left: 0, top: 0, width: 2560, height: 1440 };
        // A 2px-wide, 19px-tall caret in the middle of a 1440p screen.
        let f = frac((1280, 700, 2, 19), screen);
        assert_eq!(f.x, 0.5);
        assert_eq!(f.y, 700.0 / 1440.0);
        assert_eq!(f.w, 2.0 / 2560.0);
        assert_eq!(f.h, 19.0 / 1440.0);

        // A PORTRAIT monitor with a negative origin. There is NO rotation term:
        // `OutputInfo` is already desktop-oriented and the frame is rotated to
        // match it, so a portrait screen is 1440x2560 on both sides of this.
        let portrait = CaptureSurface::Single { left: -1440, top: -692, width: 1440, height: 2560 };
        let f = frac((-720, 588, 2, 24), portrait);
        assert_eq!(f.x, 0.5, "720/1440");
        assert_eq!(f.y, 0.5, "1280/2560");
        assert_eq!(f.h, 24.0 / 2560.0);
    }

    #[test]
    fn a_caret_on_another_screen_is_reported_as_absent() {
        let primary = CaptureSurface::Single { left: 0, top: 0, width: 2560, height: 1440 };
        // 40px into the screen to the RIGHT of the primary.
        assert_eq!(caret_fractions((2600, 100, 2, 20), primary), None);

        // POSITIVE CONTROL: the same caret against the screen it is actually on.
        // Without this, a mapper that returned None unconditionally would pass.
        let right = CaptureSurface::Single { left: 2560, top: -685, width: 1440, height: 2560 };
        let f = frac((2600, 100, 2, 20), right);
        assert_eq!(f.x, 40.0 / 1440.0);
        assert_eq!(f.y, 785.0 / 2560.0);

        // A caret to the LEFT of the surface must vanish, not wrap. `as u32` on
        // (-2000 - 0) would be 4294965296 and divide to a plausible fraction.
        assert_eq!(caret_fractions((-2000, 100, 2, 20), primary), None);
        // And a degenerate caret is not a caret.
        assert_eq!(caret_fractions((100, 100, 2, 0), primary), None);
        assert_eq!(caret_fractions((100, 100, -4, 20), primary), None);
        // A zero-WIDTH caret is real: some applications measure one pixel as 0.
        assert_eq!(frac((100, 100, 0, 20), primary).w, 0.0);
    }

    #[test]
    fn the_composite_maps_from_its_own_origin_and_step() {
        let surface = capture_surface(crate::composite::ALL_DISPLAYS, &reporter_outputs())
            .expect("the composite resolves");
        assert_eq!(
            surface,
            CaptureSurface::Composite {
                min_left: -1440,
                min_top: -692,
                step: 2,
                out_w: 2720,
                out_h: 1282,
            },
        );
        // 2720*2 x 1282*2 — the union is 5440x2567, so three rows are cropped.
        assert_eq!(surface.covers(), (-1440, -692, 5440, 2564));

        // The primary's top-left corner, which on this desk is a long way into
        // the composite because a screen sits to its left and above it.
        let f = frac((0, 0, 2, 20), surface);
        assert_eq!(f.x, 1440.0 / 5440.0);
        assert_eq!(f.y, 692.0 / 2564.0);
        assert_eq!(f.h, 20.0 / 2564.0);
        // The fractions are of the desktop EXTENT, not of the stepped pixel
        // count — which is what makes them immune to `step` and to the encoder
        // downscaling the picture.
        assert_eq!(f.w, 2.0 / 5440.0);
    }

    /// The two copies of the composite arithmetic must not drift apart.
    ///
    /// `resolve_target` computes the aimed extent inline; `capture_surface` goes
    /// through `union_box` + `composite_geometry`. If they ever disagree, input
    /// would land somewhere the caret mapping says it is not — the exact class of
    /// bug `resolve_target` was written to fix.
    #[test]
    fn the_caret_mapping_and_the_input_aim_describe_the_same_composite() {
        let outputs = reporter_outputs();
        let aim = resolve_target(crate::composite::ALL_DISPLAYS, &outputs, &reporter_gdi())
            .expect("the composite resolves");
        let surface =
            capture_surface(crate::composite::ALL_DISPLAYS, &outputs).expect("and so does this");
        assert_eq!(surface.covers(), (aim.left, aim.top, aim.width, aim.height));
    }

    #[test]
    fn the_rows_the_composite_crops_are_not_reported() {
        let surface = capture_surface(crate::composite::ALL_DISPLAYS, &reporter_outputs())
            .expect("the composite resolves");
        // The composite covers desktop y in [-692, 1872): the last covered row
        // is 1871 even though the desktop extends to 1875.
        let f = frac((100, 1871, 2, 20), surface);
        assert_eq!(f.y, 2563.0 / 2564.0);
        assert_eq!(caret_fractions((100, 1872, 2, 20), surface), None);

        // POSITIVE CONTROL: that caret is not off the DESKTOP, only off the
        // composited surface — on its own screen it maps fine.
        let right = CaptureSurface::Single { left: 2560, top: -685, width: 1440, height: 2560 };
        let f = frac((3000, 1872, 2, 20), right);
        assert_eq!(f.y, 2557.0 / 2560.0);
    }

    /// THE DPI TRAP, fabricated because no test machine can be relied on to have
    /// a scaled monitor: at 150% GDI reports 1707x960 where DXGI reports
    /// 2560x1440.
    #[test]
    fn the_caret_uses_the_dxgi_rect_not_the_scaled_gdi_one() {
        let outputs = vec![out(0, 0, 0, 2560, 1440, 0xAA)];
        let surface = capture_surface(0, &outputs).expect("resolves");
        let f = frac((1280, 720, 2, 24), surface);
        assert_eq!(f.x, 0.5);
        assert_eq!(f.y, 0.5);

        // POSITIVE CONTROL that the fixture can tell the two apart at all: the
        // GDI rectangle would have put this caret three quarters of the way
        // across the screen. Without this the assertions above would pass on a
        // 100%-scale fixture and prove nothing.
        let gdi_x: f64 = 1280.0 / 1707.0;
        assert!(
            (gdi_x - 0.5).abs() > 0.2,
            "the fixture does not distinguish the two coordinate spaces",
        );
        // And the aim really does prefer the GDI rect — the asymmetry this test
        // exists to document, not a bug.
        let list = puca_input::MonitorList {
            monitors: vec![gdi(0, 0, 0, 1707, 960, 0xAA, true)],
            virt_left: 0,
            virt_top: 0,
            virt_width: 1707,
            virt_height: 960,
        };
        let aim = resolve_target(0, &outputs, &list).expect("resolves");
        assert_eq!((aim.width, aim.height), (1707, 960));
    }

    #[test]
    fn a_surface_with_no_area_or_no_output_reports_nothing() {
        assert_eq!(capture_surface(0, &[]), None);
        assert_eq!(capture_surface(crate::composite::ALL_DISPLAYS, &[]), None);
        // A gap: index 1 is absent, and must not resolve to its neighbour.
        let outputs = vec![out(0, 0, 0, 1920, 1080, 0x1), out(2, 1920, 0, 1920, 1080, 0x2)];
        assert_eq!(capture_surface(1, &outputs), None);
        assert_eq!(
            capture_surface(2, &outputs),
            Some(CaptureSurface::Single { left: 1920, top: 0, width: 1920, height: 1080 }),
        );
        // A zero-area surface divides by zero rather than reporting a caret.
        let empty = CaptureSurface::Single { left: 0, top: 0, width: 0, height: 0 };
        assert_eq!(caret_fractions((0, 0, 2, 20), empty), None);
    }

    /// LIVE, on whatever is plugged into this machine: does injected input land
    /// on the screen actually being captured?
    ///
    /// The tests above pin the mapping against a RECORDED layout. This one pins
    /// the whole chain against the real one — enumerate, aim exactly as
    /// `aim_input_at` does, inject an absolute move, and ask Windows where the
    /// pointer went. It is the only test here that could have caught the
    /// reported bug on the reporter's desk, because the bug needs two
    /// enumerations that disagree and no fixture can supply real hardware.
    ///
    /// IGNORED: it moves the mouse, so it must never run inside a plain
    /// `cargo test` on someone's desktop. It puts the pointer back afterwards,
    /// including on failure.
    ///
    ///   cargo test -p puca-agent -- --ignored --nocapture aim
    ///
    /// A single-monitor machine passes trivially, which is honest: the bug
    /// cannot exist there.
    #[cfg(windows)]
    #[test]
    #[ignore = "moves the mouse; run deliberately with --ignored"]
    fn live_aim_puts_the_cursor_on_the_screen_being_captured() {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

        fn cursor() -> (i32, i32) {
            let mut p = POINT::default();
            unsafe { GetCursorPos(&mut p).expect("GetCursorPos") };
            (p.x, p.y)
        }

        /// Put the pointer back whatever happens. Nobody asked for their cursor
        /// to be left on another monitor.
        struct Restore((i32, i32));
        impl Drop for Restore {
            fn drop(&mut self) {
                unsafe {
                    let _ = SetCursorPos(self.0 .0, self.0 .1);
                }
            }
        }

        let outputs = puca_capture::outputs();
        let list = puca_input::list_monitors();
        assert!(!outputs.is_empty(), "no capturable outputs on this machine");

        eprintln!("capture outputs (the order a monitor index means):");
        for o in &outputs {
            eprintln!(
                "  [{}] ({},{}) {}x{} hmon={:#x}",
                o.index, o.left, o.top, o.width, o.height, o.hmonitor,
            );
        }
        eprintln!("injection monitors (the order this used to be indexed by):");
        for m in &list.monitors {
            eprintln!(
                "  [{}] ({},{}) {}x{} primary={} hmon={:#x}",
                m.index, m.left, m.top, m.width, m.height, m.primary, m.hmonitor,
            );
        }
        let disagreements = outputs
            .iter()
            .filter(|o| {
                list.monitors
                    .get(o.index)
                    .is_some_and(|m| (m.left, m.top) != (o.left, o.top))
            })
            .count();
        eprintln!(
            "{disagreements}/{} indexes differ between them{}",
            outputs.len(),
            if disagreements == 0 {
                " — this machine cannot reproduce the reported bug"
            } else {
                " — the reported bug IS reproducible here"
            },
        );

        let _restore = Restore(cursor());

        // CAN THE POINTER EVEN GO THERE? Two things make a screen unreachable
        // while our aiming is entirely correct, and both look EXACTLY like the
        // bug this test exists to catch:
        //   - a fullscreen game holding ClipCursor, which confines the pointer
        //     to its own window (measured live: with a game running, even plain
        //     SetCursorPos to another monitor snapped back to the game's);
        //   - a display that is asleep or off, which Windows still reports as
        //     attached while clamping absolute moves onto a live one.
        // Checked with SetCursorPos, which involves none of our code, so a
        // failure below is OURS and a failure here is the desk's. This cost
        // real time once: the test declared the reported bug reproduced while a
        // game held the cursor.
        let mut unreachable = Vec::new();
        for o in &outputs {
            let (cx, cy) = (o.left + o.width / 2, o.top + o.height / 2);
            unsafe {
                let _ = SetCursorPos(cx, cy);
            }
            std::thread::sleep(std::time::Duration::from_millis(60));
            let (x, y) = cursor();
            if (x - cx).abs() > 2 || (y - cy).abs() > 2 {
                unreachable.push(o.index);
            }
        }
        assert!(
            unreachable.is_empty(),
            "the pointer cannot be placed on output(s) {unreachable:?} at all — a fullscreen game \
             is confining the cursor (ClipCursor), or those displays are asleep. Close the game / \
             wake every screen and run again; this run says nothing about aiming.",
        );

        for o in &outputs {
            let target = resolve_target(o.index, &outputs, &list)
                .unwrap_or_else(|| panic!("no injection target for capture index {}", o.index));
            puca_input::set_target(Some(target));

            // The middle of the shared picture. The centre of the WRONG screen
            // is still well inside it, so only the right rectangle can pass.
            puca_input::inject(puca_input::ControlInput::Move { x: 0.5, y: 0.5 })
                .expect("inject an absolute move");
            std::thread::sleep(std::time::Duration::from_millis(60));

            let (x, y) = cursor();
            eprintln!("  capturing index {} -> cursor ({x},{y})", o.index);
            assert!(
                x >= o.left - 2
                    && x <= o.left + o.width + 2
                    && y >= o.top - 2
                    && y <= o.top + o.height + 2,
                "capturing output {} at ({},{}) {}x{}, but the cursor landed at ({x},{y}) — \
                 a DIFFERENT SCREEN, which is the reported bug",
                o.index, o.left, o.top, o.width, o.height,
            );
            let (cx, cy) = (o.left + o.width / 2, o.top + o.height / 2);
            assert!(
                (x - cx).abs() <= o.width / 10 && (y - cy).abs() <= o.height / 10,
                "right screen, wrong place: expected about ({cx},{cy}), got ({x},{y})",
            );
        }

        if outputs.len() > 1 {
            let target = resolve_target(crate::composite::ALL_DISPLAYS, &outputs, &list)
                .expect("All Displays must resolve");
            puca_input::set_target(Some(target));
            puca_input::inject(puca_input::ControlInput::Move { x: 0.5, y: 0.5 })
                .expect("inject");
            std::thread::sleep(std::time::Duration::from_millis(60));
            let (x, y) = cursor();
            let left = outputs.iter().map(|o| o.left).min().unwrap();
            let top = outputs.iter().map(|o| o.top).min().unwrap();
            let right = outputs.iter().map(|o| o.left + o.width).max().unwrap();
            let bottom = outputs.iter().map(|o| o.top + o.height).max().unwrap();
            eprintln!("  All Displays -> cursor ({x},{y}) in ({left},{top})..({right},{bottom})");
            assert!(
                x >= left - 2 && x <= right + 2 && y >= top - 2 && y <= bottom + 2,
                "All Displays put the cursor outside the composited surface",
            );
        }

        puca_input::set_target(None);
    }

    #[test]
    fn geometry_falls_back_to_the_captured_output_when_no_gdi_entry_matches() {
        // A display that GDI does not report (or reports with no handle) must
        // still be aimed at using the rectangle DXGI gave for it, rather than
        // being silently skipped.
        let outputs = vec![out(0, 1920, 0, 2560, 1440, 0xABC)];
        let list = puca_input::MonitorList {
            monitors: vec![gdi(0, 0, 0, 1920, 1080, 0, true)],
            virt_left: 0, virt_top: 0, virt_width: 4480, virt_height: 1440,
        };
        let t = resolve_target(0, &outputs, &list).expect("must still resolve");
        assert_eq!((t.left, t.top, t.width, t.height), (1920, 0, 2560, 1440));
    }

    #[test]
    fn every_command_is_refused_before_authentication() {
        for req in [
            Request::Capabilities,
            Request::ListMonitors,
            Request::StartCapture { session_id: "s".into(), monitor: None },
            Request::NextFrame { session_id: "s".into(), timeout_ms: None },
            Request::StopCapture { session_id: "s".into() },
            Request::Inject { session_id: "s".into(), event: serde_json::json!({"t":"move","x":0.5,"y":0.5}) },
            Request::ReleaseInput,
        ] {
            let mut a = agent();
            match a.handle(req) {
                Response::Error { message } => assert_eq!(message, "not authenticated"),
                other => panic!("unauthenticated request was answered: {other:?}"),
            }
            assert!(!a.is_authenticated());
        }
    }

    #[test]
    fn a_wrong_token_does_not_authenticate() {
        let mut a = agent();
        assert!(matches!(a.handle(hello("wrong", PROTOCOL_VERSION)), Response::Error { .. }));
        assert!(!a.is_authenticated());
        assert!(matches!(a.handle(Request::Capabilities), Response::Error { .. }));
    }

    #[test]
    fn a_token_of_the_wrong_length_is_refused() {
        let mut a = agent();
        assert!(matches!(a.handle(hello("s3cret", PROTOCOL_VERSION)), Response::Error { .. }));
        assert!(!a.is_authenticated());
    }

    #[test]
    fn a_protocol_mismatch_is_refused_rather_than_guessed() {
        let mut a = agent();
        assert!(matches!(a.handle(hello("s3cret-token", 999)), Response::Error { .. }));
        assert!(!a.is_authenticated());
    }

    #[test]
    fn the_right_token_authenticates_once() {
        let mut a = agent();
        // Response::Hello EXACTLY, never Response::Ok: the app matches on the
        // serialised `"ok":"hello"` and falls back to the browser picker on
        // anything else. Accepting both is what let that regression ship.
        assert!(matches!(
            a.handle(hello("s3cret-token", PROTOCOL_VERSION)),
            Response::Hello { version: PROTOCOL_VERSION, .. }
        ));
        assert!(a.is_authenticated());
        assert!(matches!(a.handle(hello("s3cret-token", PROTOCOL_VERSION)), Response::Error { .. }));
    }

    #[test]
    fn injection_is_refused_for_an_unknown_session() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        match a.handle(Request::Inject {
            session_id: "never-started".into(),
            event: serde_json::json!({"t":"move","x":0.5,"y":0.5}),
        }) {
            Response::Error { message } => assert_eq!(message, "no such capture session"),
            other => panic!("expected refusal, got {other:?}"),
        }
    }

    #[test]
    fn frames_are_refused_for_an_unknown_session() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        assert!(matches!(
            a.handle(Request::NextFrame { session_id: "nope".into(), timeout_ms: None }),
            Response::Error { .. }
        ));
    }

    #[test]
    fn capabilities_do_not_overclaim_elevation() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        match a.handle(Request::Capabilities) {
            Response::Capabilities { elevated, unattended, .. } => {
                assert!(!elevated, "the user-flavour agent has never been elevated");
                assert_eq!(unattended, cfg!(windows), "unattended is the agent's reason to exist");
            }
            other => panic!("expected capabilities, got {other:?}"),
        }
    }

    fn system_agent() -> Agent {
        Agent::new("s3cret-token".to_string(), crate::flavour::Flavour::SystemInteractive)
    }

    #[test]
    fn the_system_agent_reports_its_elevation() {
        let mut a = system_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        match a.handle(Request::Capabilities) {
            Response::Capabilities { elevated, .. } => {
                assert!(elevated, "this flavour exists to reach UAC and the lock screen");
            }
            other => panic!("expected capabilities, got {other:?}"),
        }
    }

    // The guard proven through the real dispatch path, not just in flavour.rs.
    // A pure unit test of `allows` passes just as happily when nothing calls it.
    #[cfg(windows)]
    #[test]
    fn the_system_agent_refuses_to_open_a_file_scope() {
        let mut a = system_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        for req in [
            Request::SetFileAccess { session_id: "s".into(), root: Some("C:\\".into()), policy: false },
            Request::SetFileAccess { session_id: "s".into(), root: None, policy: true },
        ] {
            match a.handle(req) {
                Response::Error { message } => assert!(
                    message.contains("Sign in"),
                    "must be the flavour refusal, not an incidental error: {message}"
                ),
                other => panic!("expected a refusal, got {other:?}"),
            }
        }
    }

    // The positive control for the test above. Without it, a refusal that had
    // accidentally been wired to fire for EVERY flavour would look identical to
    // a correct one — and file transfer would be dead for every shipped
    // install, which is the exact regression this pair exists to catch.
    #[cfg(windows)]
    #[test]
    fn the_user_agent_gets_past_the_flavour_gate_to_the_session_lookup() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        match a.handle(Request::SetFileAccess {
            session_id: "s".into(),
            root: Some("C:\\".into()),
            policy: false,
        }) {
            // No stream exists in a unit test, so the furthest this can get is
            // the "no live stream" error — which is proof it got past the gate.
            Response::Error { message } => assert!(
                message.contains("no live stream"),
                "the user flavour must reach the session lookup, not a refusal: {message}"
            ),
            other => panic!("expected the session-lookup error, got {other:?}"),
        }
    }

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"foob"), "Zm9vYg==");
        assert_eq!(b64(&[0xff, 0xfe, 0xfd]), "//79");
    }

    #[cfg(windows)]
    #[test]
    fn test_stale_terminal_event_cannot_remove_newer_stream_or_reservation() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(|| ());
        let stream = crate::stream::Stream::create_for_test("s1".into(), 2, 0, handle, std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)), tx);
        let key = StreamKey { session_id: "s1".into(), generation: 2 };
        a.streams.insert("s1".into(), stream);
        a.sessions.insert("s1".into(), 0);
        a.monitor_reservations.insert(0, key.clone());

        a.stream_events.0.send(crate::stream::StreamEvent::Terminated {
            session_id: "s1".into(),
            generation: 1,
            reason: "stale exit".into(),
        }).unwrap();

        a.handle(Request::Capabilities);
        assert!(a.streams.contains_key("s1"));
        assert_eq!(a.monitor_reservations.get(&0), Some(&key));
        let _ = rx;
    }

    #[cfg(windows)]
    #[test]
    fn secure_desktop_event_drives_session_status_and_ignores_a_stale_generation() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(|| ());
        let stream = crate::stream::Stream::create_for_test(
            "s1".into(),
            5,
            0,
            handle,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tx,
        );
        a.streams.insert("s1".into(), stream);
        a.sessions.insert("s1".into(), 0);

        let status = |a: &mut Agent| match a.handle(Request::SessionStatus { session_id: "s1".into() }) {
            Response::SessionState { secure_desktop, .. } => secure_desktop,
            other => panic!("expected SessionState, got {other:?}"),
        };

        // Baseline: nothing is blocking.
        assert!(!status(&mut a), "a fresh session is not secure-desktop-blocked");

        // A secure desktop for the CURRENT generation raises the flag (drained at
        // the top of the next handle()).
        a.stream_events
            .0
            .send(crate::stream::StreamEvent::SecureDesktop {
                session_id: "s1".into(),
                generation: 5,
                up: true,
            })
            .unwrap();
        assert!(status(&mut a), "an up event for the live generation must raise the flag");

        // A clear for a STALE generation is ignored — a late event from a reaped
        // stream must not lower a flag the live stream raised.
        a.stream_events
            .0
            .send(crate::stream::StreamEvent::SecureDesktop {
                session_id: "s1".into(),
                generation: 4,
                up: false,
            })
            .unwrap();
        assert!(status(&mut a), "a stale-generation clear must be ignored");

        // The matching-generation clear lowers it — the positive control proving
        // the flag can go both ways, so the raise above was not a stuck true.
        a.stream_events
            .0
            .send(crate::stream::StreamEvent::SecureDesktop {
                session_id: "s1".into(),
                generation: 5,
                up: false,
            })
            .unwrap();
        assert!(!status(&mut a), "a live-generation clear must lower the flag");

        let _ = rx;
    }

    /// MEASURED LIVE, 2026-08-18: the banner this flag drives appeared over the
    /// lock screen's own PIN box. The SYSTEM agent's follow can be refused for
    /// one tick during the lock-curtain -> PIN-box switch, and treating that as
    /// "this screen is unreachable" contradicts the entire reason that agent is
    /// running — it is there precisely to show and drive that screen.
    #[cfg(windows)]
    #[test]
    fn an_elevated_agent_never_reports_a_secure_desktop_it_can_reach() {
        let mut a = system_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(|| ());
        let stream = crate::stream::Stream::create_for_test(
            "s1".into(), 7, 0, handle,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)), tx,
        );
        a.streams.insert("s1".into(), stream);

        a.stream_events.0.send(crate::stream::StreamEvent::SecureDesktop {
            session_id: "s1".into(), generation: 7, up: true,
        }).unwrap();

        match a.handle(Request::SessionStatus { session_id: "s1".into() }) {
            Response::SessionState { secure_desktop, cursor_clipped } => {
                assert!(
                    !secure_desktop,
                    "a SYSTEM agent can reach the secure desktop, so it must never                  tell the viewer the screen is out of reach — that banner lands                  on top of the PIN box it is supposed to be showing",
                );
                // Same gate, same reason: the SYSTEM agent lives on whatever
                // desktop Windows shows and its clip reading describes the
                // wrong one; a clip banner over the PIN box tells the person
                // to close an app that is not in their way.
                assert!(
                    !cursor_clipped,
                    "an elevated agent must never report a cursor clip",
                );
            }
            other => panic!("expected SessionState, got {other:?}"),
        }
        let _ = rx;
    }

    /// THE POSITIVE CONTROL for the test above. Without it, a gate accidentally
    /// wired to swallow EVERY flavour would look identical to a correct one, and
    /// the user-flavour case — the only one the notice exists for — would be
    /// silently dead.
    #[cfg(windows)]
    #[test]
    fn a_user_agent_still_reports_a_secure_desktop_it_cannot_reach() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(|| ());
        let stream = crate::stream::Stream::create_for_test(
            "s1".into(), 7, 0, handle,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)), tx,
        );
        a.streams.insert("s1".into(), stream);

        a.stream_events.0.send(crate::stream::StreamEvent::SecureDesktop {
            session_id: "s1".into(), generation: 7, up: true,
        }).unwrap();

        match a.handle(Request::SessionStatus { session_id: "s1".into() }) {
            Response::SessionState { secure_desktop, .. } => assert!(
                secure_desktop,
                "a user-flavour agent genuinely cannot cross to Winlogon, and                  saying so is the whole feature",
            ),
            other => panic!("expected SessionState, got {other:?}"),
        }
        let _ = rx;
    }

    #[cfg(windows)]
    #[test]
    fn test_explicit_stop_followed_by_late_terminal_event_is_harmless() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(|| ());
        let stream = crate::stream::Stream::create_for_test("s1".into(), 1, 0, handle, std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)), tx);
        a.streams.insert("s1".into(), stream);
        a.sessions.insert("s1".into(), 0);
        a.monitor_reservations.insert(0, StreamKey { session_id: "s1".into(), generation: 1 });

        a.handle(Request::StopStream { session_id: "s1".into() });
        assert!(!a.streams.contains_key("s1"));

        a.stream_events.0.send(crate::stream::StreamEvent::Terminated {
            session_id: "s1".into(),
            generation: 1,
            reason: "late exit".into(),
        }).unwrap();

        let resp = a.handle(Request::Capabilities);
        assert!(matches!(resp, Response::Capabilities { .. }));
        let _ = rx;
    }

    #[cfg(windows)]
    #[test]
    fn test_failed_start_releases_only_its_own_streamkey_reservation() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let existing_key = StreamKey { session_id: "other".into(), generation: 5 };
        a.monitor_reservations.insert(0, existing_key.clone());

        // Pre-reservation check blocks start if monitor in use
        let resp = a.handle(Request::StartStream {
            session_id: "s1".into(),
            monitor: Some(0),
            offer_sdp: "invalid".into(),
            fps: None,
            bitrate: None,
            ice_servers: vec![],
            data_only: false,
        });
        assert!(matches!(resp, Response::Error { .. }));
        assert_eq!(a.monitor_reservations.get(&0), Some(&existing_key));

        // Post-reservation rollback on a failed start, through the REAL
        // release. This used to re-type the release rule into the test body and
        // then assert on its own copy — it could not fail, whatever the
        // function did.
        let key_to_fail = StreamKey { session_id: "s2".into(), generation: 10 };
        a.monitor_reservations.insert(1, key_to_fail.clone());
        release_reservations(&mut a.monitor_reservations, &key_to_fail);
        assert_eq!(a.monitor_reservations.get(&1), None);
        // And it released only its own: the other session's is untouched.
        assert_eq!(a.monitor_reservations.get(&0), Some(&existing_key));
    }

    #[cfg(windows)]
    #[test]
    fn a_data_only_stream_neither_reserves_a_monitor_nor_is_blocked_by_one() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let held = StreamKey { session_id: "watcher".into(), generation: 5 };
        a.monitor_reservations.insert(0, held.clone());

        let start = |session: &str, data_only: bool| Request::StartStream {
            session_id: session.into(),
            monitor: Some(0),
            // Invalid on purpose: this test is about which check is reached, not
            // about starting a real stream. Both calls fail; what matters is WHY.
            offer_sdp: "invalid".into(),
            fps: None,
            bitrate: None,
            ice_servers: vec![],
            data_only,
        };

        // POSITIVE CONTROL: with a picture, the reservation really does block —
        // so the rig can see a reservation refusal, and the assertion below is
        // about data_only rather than about this test being unable to fail.
        match a.handle(start("s-video", false)) {
            Response::Error { message } => {
                assert!(message.contains("reserved"), "expected a reservation refusal, got {message}")
            }
            other => panic!("expected a refusal, got {other:?}"),
        }

        // A file-only session duplicates nothing, so somebody watching screen 0
        // must not stop it. It still fails on the bad offer — but not for this.
        match a.handle(start("s-files", true)) {
            Response::Error { message } => assert!(
                !message.contains("reserved"),
                "a data-only session must not be blocked by a monitor reservation: {message}"
            ),
            other => panic!("expected a refusal on the bad offer, got {other:?}"),
        }

        // And it took nothing for itself: the watcher's reservation is intact and
        // no new one appeared. A data-only session that reserved a screen would
        // strand it, because nothing ever releases what it never should have had.
        assert_eq!(a.monitor_reservations.get(&0), Some(&held));
        assert_eq!(a.monitor_reservations.len(), 1);
        // Nor is it in the session map, which is what Inject and SetPrivacyMode
        // consult — a session with no screen must not be able to drive one.
        assert!(!a.sessions.contains_key("s-files"));
    }

    #[cfg(windows)]
    #[test]
    fn test_monitor_switch_releases_only_old_matching_reservation() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let newer_key = StreamKey { session_id: "s1".into(), generation: 2 };
        a.sessions.insert("s1".into(), 0);
        a.monitor_reservations.insert(0, newer_key.clone());

        // A stale generation of the SAME session releasing must not take the
        // newer stream's reservation with it. Through the real function: the
        // inline copy this replaces asserted against its own re-typed rule.
        let gen1_key = StreamKey { session_id: "s1".into(), generation: 1 };
        release_reservations(&mut a.monitor_reservations, &gen1_key);
        assert_eq!(a.monitor_reservations.get(&0), Some(&newer_key));

        // POSITIVE CONTROL: the rig can see a release happen at all, so
        // "unchanged" above is a property of the key check and not of a
        // function that never removes anything.
        release_reservations(&mut a.monitor_reservations, &newer_key);
        assert_eq!(a.monitor_reservations.get(&0), None);
    }

    /// The multi-key bookkeeping the All Displays fix rests on.
    ///
    /// A composite really is duplicating every output, so reserving only the
    /// sentinel left the member screens looking free — and a second session
    /// would be promised a screen DXGI was about to refuse it.
    #[cfg(windows)]
    #[test]
    fn all_displays_reserves_every_output_and_a_single_screen_reserves_one() {
        // A GAPPED list, because `outputs()` omits what it cannot describe and
        // index is not position. An implementation using enumerate() would
        // produce 0,1,2 here and fail.
        let outputs = vec![
            out(0, 0, 0, 2560, 1440, 0xA),
            out(2, 2560, 0, 1440, 2560, 0xB),
            out(5, -1440, 0, 1440, 2560, 0xC),
        ];
        assert_eq!(
            reservation_keys(crate::composite::ALL_DISPLAYS, &outputs),
            vec![0, 2, 5, crate::composite::ALL_DISPLAYS],
        );
        assert_eq!(reservation_keys(2, &outputs), vec![2]);
        // A single screen must not claim the sentinel, or nothing could ever
        // switch to All Displays afterwards.
        assert!(!reservation_keys(2, &outputs).contains(&crate::composite::ALL_DISPLAYS));
    }

    #[cfg(windows)]
    #[test]
    fn test_agent_drains_panic_terminal_event_and_cleans_reservation() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let (tx, rx) = std::sync::mpsc::channel();
        let panic_handle = std::thread::spawn(|| { panic!("simulated panic"); });
        let stream = crate::stream::Stream::create_for_test("s1".into(), 1, 0, panic_handle, std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)), tx);
        a.streams.insert("s1".into(), stream);
        a.sessions.insert("s1".into(), 0);
        a.monitor_reservations.insert(0, StreamKey { session_id: "s1".into(), generation: 1 });

        a.stream_events.0.send(crate::stream::StreamEvent::Terminated {
            session_id: "s1".into(),
            generation: 1,
            reason: "panicked".into(),
        }).unwrap();

        a.handle(Request::Capabilities);
        assert!(!a.streams.contains_key("s1"));
        assert_eq!(a.monitor_reservations.get(&0), None);
        let _ = rx;
    }

    // --- sealed input, and the two gates in front of it --------------------

    /// Open a sealed session as the controller would, returning the key it and
    /// the agent now share.
    fn open_sealed(a: &mut Agent, id: &str) -> [u8; 32] {
        let shared = [7u8; 32];
        let ctl_priv = [3u8; 32];
        let ctl_pub = crate::control_key::encode_public_key(
            x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(ctl_priv)).as_bytes(),
        );
        let resp = a.handle(Request::OpenSession {
            ice_servers: vec![],
            session_id: id.into(),
            static_shared: b64(&shared),
            peer_eph_pub: ctl_pub,
            input_granted: true,
        });
        let agent_eph = match resp {
            Response::SessionOpened { eph_pub } => eph_pub,
            other => panic!("expected SessionOpened, got {other:?}"),
        };
        crate::control_key::derive(&shared, &ctl_priv, &agent_eph).expect("controller derives")
    }

    /// Seal a signalling frame the way the shipping controller does: `sid` and
    /// `n` inside the sealed body, never outside it.
    fn seal_signal(key: &[u8; 32], id: &str, n: i64, body: serde_json::Value) -> String {
        let mut frame = body;
        frame["sid"] = serde_json::json!(id);
        frame["n"] = serde_json::json!(n);
        crate::control_key::seal(key, &frame.to_string()).expect("seal")
    }

    /// An agent in the flavour the SERVICE launches — the one that only ever
    /// exists at a lock or sign-in screen.
    fn headless_agent() -> Agent {
        Agent::new("s3cret-token".into(), crate::flavour::Flavour::SystemInteractive)
    }

    #[test]
    fn the_headless_flavour_refuses_a_session_that_has_not_proved_the_passphrase() {
        // THE SECURITY FIX, and the reason it is not merely tidier. The rule
        // used to be `ua_ok: !is_armed()` — an unarmed machine meant a human at
        // the keyboard had already approved, so demanding a passphrase too
        // would be asking twice.
        //
        // SystemInteractive breaks that premise: it is the flavour that exists
        // ONLY where there is nobody to ask. Under the old rule an unarmed
        // machine at its sign-in screen accepted sealed input from anyone who
        // completed the DH — and sealed input is what types the owner's Windows
        // password.
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        assert!(!a.ua.is_armed(), "this is the unarmed case on purpose");

        let key = open_sealed(&mut a, "s1");
        let resp = a.handle(Request::InjectSealed {
            session_id: "s1".into(),
            payload: seal_input(&key, 0),
        });
        match resp {
            Response::Error { message } => assert!(
                message.contains("unattended access"),
                "refused for the wrong reason: {message}"
            ),
            other => panic!("an unproven headless session must be refused, got {other:?}"),
        }
    }

    #[test]
    fn an_ordinary_agent_still_does_not_ask_twice() {
        // THE OTHER HALF OF THE PAIR. If the fix above had been written as an
        // unconditional `ua_ok: false`, this would break: the desktop app's
        // sessions are approved by the person sitting there, and demanding a
        // passphrase as well would make ordinary remote control impossible.
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        assert!(!a.ua.is_armed());
        let key = open_sealed(&mut a, "s1");
        let resp = a.handle(Request::InjectSealed {
            session_id: "s1".into(),
            payload: seal_input(&key, 0),
        });
        assert!(
            !matches!(&resp, Response::Error { message } if message.contains("unattended")),
            "an unarmed ordinary agent must not demand a passphrase: {resp:?}"
        );
    }

    #[test]
    fn a_sealed_signal_for_another_session_is_refused() {
        // Two sessions can share a key whenever the peer reuses its ephemeral.
        // The session id inside the sealed body is what stops a frame captured
        // from one being relayed into the other.
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let key = open_sealed(&mut a, "s1");

        let wrong = seal_signal(&key, "s2", 0, serde_json::json!({ "kind": "ice" }));
        match a.handle(Request::SealedSignal { session_id: "s1".into(), payload: wrong }) {
            Response::Error { message } => {
                assert!(message.contains("another session"), "{message}")
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_replayed_sealed_signal_is_dropped_but_not_errored() {
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let key = open_sealed(&mut a, "s1");

        let first = seal_signal(&key, "s1", 5, serde_json::json!({ "kind": "ice" }));
        assert!(matches!(
            a.handle(Request::SealedSignal { session_id: "s1".into(), payload: first }),
            Response::SealedSignals { .. }
        ));

        // Same n again, and a lower one. Both are dropped quietly: a controller
        // resends on a flaky link, and an error per duplicate reads as a fault.
        for n in [5, 4, 0] {
            let dup = seal_signal(&key, "s1", n, serde_json::json!({ "kind": "ice" }));
            match a.handle(Request::SealedSignal { session_id: "s1".into(), payload: dup }) {
                Response::SealedSignals { payloads } => assert!(payloads.is_empty()),
                other => panic!("a replay must not error, got {other:?}"),
            }
        }
    }

    #[test]
    fn an_unproven_offer_is_held_not_refused() {
        // THE BUG THAT SHIPPED. This test used to assert the opposite — an
        // outright refusal — because that was believed to be the safe
        // behaviour. It was the shipping controller's own comment
        // (session.ts:3787, "HELD, NOT DROPPED") that named the mistake: the
        // controller sends its offer the INSTANT it is accepted, concurrently
        // with the passphrase prompt, so for an armed session an offer
        // arriving before ua_ok is the ORDINARY case, not a race. Refusing it
        // does not delay the connection — the controller has no retry path —
        // it permanently kills it. Reproduced against the real machine before
        // this was found: every single connection attempt failed exactly
        // this way.
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let key = open_sealed(&mut a, "s1");

        let offer = seal_signal(
            &key,
            "s1",
            0,
            serde_json::json!({ "kind": "offer", "sdp": "v=0\r\n" }),
        );
        match a.handle(Request::SealedSignal { session_id: "s1".into(), payload: offer }) {
            Response::SealedSignals { payloads } => {
                assert!(payloads.is_empty(), "held silently, nothing to send yet")
            }
            other => panic!("an unproven offer must be HELD, not answered or refused, got {other:?}"),
        }
        // Still gated: StartStream checks only Capability::Capture, so without
        // holding this offer an unproven peer would get a live picture of the
        // sign-in screen the moment it connects. (`streams` is Windows-only;
        // elsewhere the same guarantee holds vacuously — nothing can stream.)
        #[cfg(windows)]
        assert!(a.streams.is_empty(), "must not have started capturing yet");
    }

    #[test]
    fn proving_the_passphrase_releases_the_held_offer() {
        // THE FULL ROUND TRIP the fix depends on: an offer that arrived early
        // is answered the moment — and in the SAME call as — the passphrase
        // proof that unblocks it, mirroring session.ts:3259's "release
        // whatever was held".
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let seed = [5u8; 32];
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        a.ua.arm(puca_ua::UaRecord::new([1u8; 16], sk.verifying_key().to_bytes()));
        let key = open_sealed(&mut a, "s1");

        // The offer arrives first, as it always does, and is held.
        let offer = seal_signal(
            &key,
            "s1",
            0,
            serde_json::json!({ "kind": "offer", "sdp": "v=0\r\n" }),
        );
        assert!(matches!(
            a.handle(Request::SealedSignal { session_id: "s1".into(), payload: offer }),
            Response::SealedSignals { payloads } if payloads.is_empty()
        ));

        // The passphrase proof follows. Sign the SAME transcript
        // puca_ua::UaGate::verify checks: DOMAIN || len(context) ||
        // context || nonce, context = the session id.
        let nonce_b64 = match a.handle(Request::SealedChallenge { session_id: "s1".into() }) {
            Response::SealedSignals { payloads } => {
                let plain = crate::control_key::open(&key, &payloads[0]).expect("open");
                let v: serde_json::Value = serde_json::from_str(&plain).unwrap();
                v["nonce"].as_str().unwrap().to_string()
            }
            other => panic!("expected the challenge, got {other:?}"),
        };
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let nonce_raw: [u8; 32] = b64.decode(&nonce_b64).unwrap().try_into().unwrap();
        let msg = puca_ua::challenge_message("s1", &nonce_raw);
        let sig = ed25519_dalek::Signer::sign(&sk, &msg);

        let response = seal_signal(
            &key,
            "s1",
            1,
            serde_json::json!({
                "kind": "ua-response",
                "nonce": nonce_b64,
                "sig": b64.encode(sig.to_bytes()),
            }),
        );

        // THE RELEASE. One SealedSignal call, carrying the ua-response, must
        // reach FOR the held offer's answer — not the old "has not proved
        // unattended access" refusal, and not a silent no-op. Real SDP
        // negotiation needs a capture device this test does not have, so —
        // matching every other StartStream-reaching test in this file, which
        // all use a deliberately invalid SDP for the same reason — this
        // checks that the release fired and reached negotiation, not that
        // negotiation completed.
        // The handle call must run on EVERY platform — an earlier revision put
        // it inside the cfg(windows) match below, so off Windows the release
        // never fired and the final pending_offer assertion failed. Only the
        // response's SHAPE is platform-dependent.
        let released = a.handle(Request::SealedSignal { session_id: "s1".into(), payload: response });
        #[cfg(windows)]
        match released {
            Response::Error { message } => {
                assert!(
                    !message.contains("unattended access"),
                    "the release did not fire — still gated on the passphrase: {message}"
                );
                assert!(
                    message.contains("SDP"),
                    "expected to reach real SDP negotiation and fail there \
                     (this test's fixture SDP is deliberately minimal, matching \
                     every other StartStream-reaching test in this file), got: {message}"
                );
            }
            Response::SealedSignals { payloads } => {
                // A capture-capable test machine could conceivably succeed.
                assert_eq!(payloads.len(), 1, "the held offer's answer must come back here");
                let plain = crate::control_key::open(&key, &payloads[0]).expect("open");
                let v: serde_json::Value = serde_json::from_str(&plain).unwrap();
                assert_eq!(v["kind"], "answer");
                assert_eq!(v["sid"], "s1");
            }
            other => panic!("expected the held offer to be answered or fail on SDP, got {other:?}"),
        }
        // Off Windows the release fires all the same, but the stream start
        // behind it is Windows-only — the honest response is that refusal.
        #[cfg(not(windows))]
        match released {
            Response::Error { message } => assert!(
                message.contains("only implemented on Windows"),
                "expected the capture refusal, got: {message}"
            ),
            other => panic!("expected the capture refusal off Windows, got {other:?}"),
        }

        // Whatever happened, the offer is no longer sitting there un-held: a
        // second identical ua-response replay must not answer it AGAIN.
        assert!(a.sealed.get("s1").is_some_and(|s| s.pending_offer.is_none()));
    }

    #[test]
    fn ice_arriving_before_the_stream_exists_is_held_not_discarded() {
        // THE BUG THAT MADE THE FIRST CONNECTION ALWAYS FAIL. Before this
        // field existed, an `ice` frame arriving while the offer was still
        // held went straight to AddRemoteCandidate, which answered "no such
        // stream" (the stream is only created once the offer is released) —
        // and the caller threw that away with `let _ =`. Every candidate the
        // controller sent during the passphrase prompt was silently lost, so
        // the agent had zero remote candidates and zero TURN permissions by
        // the time it finally answered.
        //
        // Reproduced against the real machine: identical to
        // session.ts:3843-3856's own fix on the JS host path, ported here.
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let key = open_sealed(&mut a, "s1");

        // No stream exists yet — nothing has even sent an offer.
        for i in 0..3 {
            let ice = seal_signal(
                &key,
                "s1",
                i,
                serde_json::json!({ "kind": "ice", "candidate": { "candidate": format!("cand{i}") } }),
            );
            assert!(matches!(
                a.handle(Request::SealedSignal { session_id: "s1".into(), payload: ice }),
                Response::SealedSignals { payloads } if payloads.is_empty()
            ));
        }

        assert_eq!(
            a.sealed.get("s1").map(|s| s.pending_ice.clone()),
            Some(vec!["cand0".to_string(), "cand1".to_string(), "cand2".to_string()]),
            "candidates arriving before the stream exists must be held, in order"
        );
    }

    #[test]
    fn the_pending_ice_queue_is_capped_and_drops_overflow() {
        // Matches the JS host's own cap (session.ts:1872-1882) and the
        // agent's own Stream::remote_candidates cap. A real browser emits a
        // handful of candidates; the cap exists only to bound an
        // unauthenticated... no — this IS authenticated (sealed), but still:
        // nothing should let this grow without bound.
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let key = open_sealed(&mut a, "s1");

        for i in 0..140i64 {
            let ice = seal_signal(
                &key,
                "s1",
                i,
                serde_json::json!({ "kind": "ice", "candidate": { "candidate": format!("c{i}") } }),
            );
            a.handle(Request::SealedSignal { session_id: "s1".into(), payload: ice });
        }

        assert_eq!(a.sealed.get("s1").map(|s| s.pending_ice.len()), Some(128));
        // The useful candidates arrive first by ICE priority, so what is KEPT
        // must be the first 128, not the last 128.
        assert_eq!(a.sealed.get("s1").unwrap().pending_ice[0], "c0");
    }

    #[test]
    fn releasing_the_offer_drains_the_held_ice_into_add_remote_candidate() {
        // The other half of the fix: draining must actually happen, and it
        // must happen ONLY once the stream exists to receive it (draining
        // earlier would just reproduce "no such stream" on every candidate).
        //
        // This cannot exercise a real StartStream success without a capture
        // device (same boundary every other StartStream-reaching test in this
        // file accepts — see proving_the_passphrase_releases_the_held_offer).
        // What IS provable without one: the queue is still fully populated
        // right up until the release attempt, proving the drain is not
        // firing early or silently on the ice frames themselves.
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let seed = [5u8; 32];
        let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
        a.ua.arm(puca_ua::UaRecord::new([1u8; 16], sk.verifying_key().to_bytes()));
        let key = open_sealed(&mut a, "s1");

        let offer = seal_signal(&key, "s1", 0, serde_json::json!({ "kind": "offer", "sdp": "v=0\r\n" }));
        a.handle(Request::SealedSignal { session_id: "s1".into(), payload: offer });

        let ice = seal_signal(
            &key,
            "s1",
            1,
            serde_json::json!({ "kind": "ice", "candidate": { "candidate": "cand0" } }),
        );
        a.handle(Request::SealedSignal { session_id: "s1".into(), payload: ice });
        assert_eq!(a.sealed.get("s1").unwrap().pending_ice.len(), 1);

        #[cfg(windows)]
        {
            // Prove the passphrase; this attempts the release. The fixture SDP
            // is invalid, so StartStream fails and — correctly — the drain
            // must NOT have run: draining before a stream exists would just
            // reproduce the original bug via a different call site.
            let nonce_b64 = match a.handle(Request::SealedChallenge { session_id: "s1".into() }) {
                Response::SealedSignals { payloads } => {
                    let plain = crate::control_key::open(&key, &payloads[0]).expect("open");
                    let v: serde_json::Value = serde_json::from_str(&plain).unwrap();
                    v["nonce"].as_str().unwrap().to_string()
                }
                other => panic!("expected the challenge, got {other:?}"),
            };
            use base64::Engine as _;
            let b64 = base64::engine::general_purpose::STANDARD;
            let nonce_raw: [u8; 32] = b64.decode(&nonce_b64).unwrap().try_into().unwrap();
            let msg = puca_ua::challenge_message("s1", &nonce_raw);
            let sig = ed25519_dalek::Signer::sign(&sk, &msg);
            let response = seal_signal(
                &key,
                "s1",
                2,
                serde_json::json!({ "kind": "ua-response", "nonce": nonce_b64, "sig": b64.encode(sig.to_bytes()) }),
            );
            let result = a.handle(Request::SealedSignal { session_id: "s1".into(), payload: response });
            match &result {
                Response::Error { message } => assert!(
                    message.contains("SDP"),
                    "expected the fixture's invalid SDP to fail negotiation, got {result:?}"
                ),
                other => panic!("expected the fixture's invalid SDP to fail negotiation, got {other:?}"),
            }
            assert_eq!(
                a.sealed.get("s1").unwrap().pending_ice.len(), 1,
                "a failed StartStream must not have drained (and lost) the held candidate"
            );
        }
    }

    #[test]
    fn a_sealed_frame_the_key_cannot_open_is_refused_without_saying_why() {
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let _key = open_sealed(&mut a, "s1");

        let stranger = seal_signal(&[9u8; 32], "s1", 0, serde_json::json!({ "kind": "ice" }));
        match a.handle(Request::SealedSignal { session_id: "s1".into(), payload: stranger }) {
            Response::Error { message } => {
                assert!(message.contains("could not be opened"), "{message}");
                // No detail about WHICH part failed: distinguishing a bad tag
                // from a bad length is a decryption oracle.
                assert!(!message.contains("tag") && !message.contains("nonce"), "{message}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn the_agent_seals_its_own_outbound_signals_so_the_relay_stays_blind() {
        // THE WHOLE POINT OF THIS DESIGN. The SYSTEM service relaying these
        // frames also holds a public internet socket; it must never be able to
        // read one. The challenge it relays has to come back already sealed.
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        a.ua.arm(puca_ua::UaRecord::new(
            [1u8; 16],
            ed25519_dalek::SigningKey::from_bytes(&[5u8; 32]).verifying_key().to_bytes(),
        ));
        let key = open_sealed(&mut a, "s1");

        let payloads = match a.handle(Request::SealedChallenge { session_id: "s1".into() }) {
            Response::SealedSignals { payloads } => payloads,
            other => panic!("expected a sealed challenge, got {other:?}"),
        };
        assert_eq!(payloads.len(), 1);

        // Opaque to anyone without the key...
        assert!(crate::control_key::open(&[9u8; 32], &payloads[0]).is_none());
        // ...and the real thing to the controller.
        let plain = crate::control_key::open(&key, &payloads[0]).expect("controller opens it");
        let v: serde_json::Value = serde_json::from_str(&plain).unwrap();
        assert_eq!(v["kind"], "ua-challenge");
        assert_eq!(v["sid"], "s1");
        assert_eq!(v["n"], 0, "outbound frames must be numbered from zero");
        assert!(v["nonce"].as_str().is_some_and(|x| !x.is_empty()));
        assert!(v["salt"].as_str().is_some_and(|x| !x.is_empty()));

        // The plaintext must not have leaked into the response envelope.
        assert!(!payloads[0].contains("ua-challenge"));
    }

    // --- Ctrl+Alt+Del ------------------------------------------------------

    /// How many times the SAS stand-in was reached on this thread.
    fn sas_calls() -> usize {
        super::SAS_SEAM.with(|c| c.borrow().0)
    }

    /// How many times an event reached the `SendInput` stand-in on this thread.
    fn inject_calls() -> usize {
        super::INJECT_SEAM_CALLS.with(|c| c.get())
    }

    /// Make the SAS stand-in answer `outcome` for the rest of this test.
    fn sas_answers(outcome: Result<(), String>) {
        super::SAS_SEAM.with(|c| c.borrow_mut().1 = outcome);
    }

    /// A live capture session, so `Inject` gets past its session check.
    ///
    /// Inserted directly rather than via `StartCapture`, which would acquire a
    /// real DXGI duplication on whatever monitor this machine has.
    fn fake_session(a: &mut Agent, id: &str) {
        a.sessions.insert(id.to_string(), 0);
    }

    #[test]
    fn a_sas_request_goes_to_the_service_and_never_to_send_input() {
        // THE ROUTING, WHICH IS THE WHOLE FIX. `SendInput` cannot produce the
        // secure attention sequence — win32k discards injected events for it by
        // design — so an event that reached the injection path would be accepted
        // by Windows, reported as delivered, and do nothing. That is exactly
        // what shipped, as six ordinary key frames.
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        fake_session(&mut a, "s1");

        assert_eq!(inject_calls(), 0, "nothing has been injected yet");
        let resp = a.handle(Request::Inject {
            session_id: "s1".into(),
            event: serde_json::json!({ "t": "sas" }),
        });
        assert!(matches!(resp, Response::Ok), "a raised SAS must answer Ok, got {resp:?}");
        assert_eq!(sas_calls(), 1, "the request never reached the system service");
        assert_eq!(
            inject_calls(),
            0,
            "the SAS reached SendInput, which cannot raise it and would silently do nothing",
        );

        // POSITIVE CONTROL for the counter: an ordinary key DOES take the
        // injection path, so the assertion above is distinguishing something.
        let resp = a.handle(Request::Inject {
            session_id: "s1".into(),
            event: serde_json::json!({ "t": "key", "code": "KeyA", "down": true }),
        });
        assert!(matches!(resp, Response::Ok), "{resp:?}");
        assert_eq!(inject_calls(), 1, "an ordinary key must still go to SendInput");
        assert_eq!(sas_calls(), 1, "an ordinary key must not wake the system service");
    }

    #[test]
    fn a_service_refusal_becomes_an_error_response_and_never_ok() {
        // THE OTHER HALF OF "STOP LYING". Most machines have never enabled the
        // SYSTEM service, and on those this request cannot be carried out. The
        // controller has to be told, with the service's own words — the
        // alternative is the button people already have, which does nothing and
        // says nothing.
        sas_answers(Err(
            "the Puca system service is not running on this computer".to_string()
        ));
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        fake_session(&mut a, "s1");

        match a.handle(Request::Inject {
            session_id: "s1".into(),
            event: serde_json::json!({ "t": "sas" }),
        }) {
            Response::Error { message } => {
                assert!(message.contains("not running"), "the reason must survive: {message}")
            }
            other => panic!("a SAS that did not happen must not answer Ok, got {other:?}"),
        }
        assert_eq!(sas_calls(), 1);
        assert_eq!(inject_calls(), 0, "a refused SAS must not fall back to typing three keys");
    }

    #[test]
    fn a_sealed_sas_frame_takes_the_same_route() {
        // The shipping controller sends input SEALED — `InjectSealed`, not
        // `Inject` — so a fix that only covered the plaintext arm would be a fix
        // nobody could use. Both arms call `dispatch_input`, and this is what
        // proves it rather than assuming it.
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let key = open_sealed(&mut a, "s1");
        let frame = serde_json::json!({ "s": 1, "e": { "t": "sas" } });
        let sealed = crate::control_key::seal(&key, &frame.to_string()).expect("seal");

        let resp = a.handle(Request::InjectSealed { session_id: "s1".into(), payload: sealed });
        assert!(matches!(resp, Response::Ok), "{resp:?}");
        assert_eq!(sas_calls(), 1, "a sealed SAS never reached the system service");
        assert_eq!(inject_calls(), 0, "a sealed SAS reached SendInput");
    }

    #[test]
    fn a_sealed_sas_from_a_session_that_has_not_proved_the_passphrase_is_refused() {
        // The SAS is admitted by the SERVICE because the person at the keyboard
        // could press the keys themselves. That reasoning says nothing about a
        // REMOTE peer, so it must not become a way around the passphrase gate:
        // an armed machine still refuses this before it is even decrypted.
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        a.ua.arm(puca_ua::UaRecord::new(
            [1u8; 16],
            ed25519_dalek::SigningKey::from_bytes(&[5u8; 32]).verifying_key().to_bytes(),
        ));
        let key = open_sealed(&mut a, "s1");
        let frame = serde_json::json!({ "s": 1, "e": { "t": "sas" } });
        let sealed = crate::control_key::seal(&key, &frame.to_string()).expect("seal");

        match a.handle(Request::InjectSealed { session_id: "s1".into(), payload: sealed }) {
            Response::Error { message } => assert!(message.contains("unattended access"), "{message}"),
            other => panic!("an unproved session must not raise the secure desktop: {other:?}"),
        }
        assert_eq!(sas_calls(), 0, "the gate ran AFTER the sequence was raised");
    }

    fn seal_input(key: &[u8; 32], seq: i64) -> String {
        let frame = serde_json::json!({ "s": seq, "e": { "t": "move", "x": 0.5, "y": 0.5 } });
        crate::control_key::seal(key, &frame.to_string()).expect("seal")
    }

    // ---- power (lock / shut down) at the sign-in screen ----------------------

    fn power_plans() -> Vec<crate::power::Plan> {
        super::POWER_SEAM.with(|c| c.borrow().0.clone())
    }
    fn power_answers(outcome: Result<(), String>) {
        super::POWER_SEAM.with(|c| c.borrow_mut().1 = outcome);
    }
    fn power_signal(a: &mut Agent, key: &[u8; 32], n: i64, action: &str) -> Response {
        let sealed = seal_signal(key, "s1", n, serde_json::json!({ "kind": "power", "action": action }));
        a.handle(Request::SealedSignal { session_id: "s1".into(), payload: sealed })
    }
    /// A HEADLESS agent whose session "s1" has proved the passphrase — the
    /// sign-in-screen host always demands the proof, so every power test that
    /// expects an action to run must go through the real challenge first.
    fn proved_headless() -> (Agent, [u8; 32]) {
        use ed25519_dalek::{Signer, SigningKey};
        let sk = SigningKey::from_bytes(&[42u8; 32]);
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        a.ua.arm(puca_ua::UaRecord::new([1u8; 16], sk.verifying_key().to_bytes()));
        let key = open_sealed(&mut a, "s1");
        let (nonce, _salt) = match a.handle(Request::UaChallenge { session_id: "s1".into() }) {
            Response::UaChallenge { nonce, salt } => (nonce, salt),
            other => panic!("expected a challenge, got {other:?}"),
        };
        use base64::Engine as _;
        let raw: [u8; 32] = base64::engine::general_purpose::STANDARD
            .decode(&nonce).unwrap().try_into().unwrap();
        let sig = sk.sign(&puca_ua::challenge_message("s1", &raw)).to_bytes();
        assert!(matches!(
            a.handle(Request::UaProve { session_id: "s1".into(), nonce: nonce.clone(), sig: b64(&sig) }),
            Response::Ok
        ));
        (a, key)
    }

    /// Open the single sealed frame of a `SealedSignals` reply as the
    /// controller would, and return its JSON.
    fn only_sealed(r: &Response, key: &[u8; 32]) -> serde_json::Value {
        match r {
            Response::SealedSignals { payloads } if payloads.len() == 1 => {
                let plain = crate::control_key::open(key, &payloads[0]).expect("controller opens it");
                serde_json::from_str(&plain).expect("json")
            }
            other => panic!("expected exactly one sealed frame, got {other:?}"),
        }
    }

    #[test]
    fn shutdown_reaches_the_power_seam_and_lock_is_a_no_op_on_a_locked_console() {
        // The sign-in-screen host is by definition on a locked console, so
        // "lock" is honoured by doing nothing and answers with nothing to
        // send. "shutdown" is a real plan — and its answer is the ONE
        // deliberate Error in this arm: the service turns a signalling Error
        // into a DeviceEnd carrying the message, which is how the controller
        // gets to read the attended host's exact "the device is shutting
        // down" instead of "connection lost". Neither touches SendInput.
        let (mut a, key) = proved_headless();
        let r = power_signal(&mut a, &key, 1, "lock");
        assert!(matches!(&r, Response::SealedSignals { payloads } if payloads.is_empty()), "{r:?}");
        match power_signal(&mut a, &key, 2, "shutdown") {
            Response::Error { message } => assert_eq!(message, crate::power::SHUTDOWN_REASON),
            other => panic!("a shutdown must end the session WITH the reason: {other:?}"),
        }
        assert_eq!(power_plans(), vec![crate::power::Plan::NoOp, crate::power::Plan::Shutdown]);
        assert_eq!(inject_calls(), 0);
    }

    #[test]
    fn a_power_request_from_a_session_that_has_not_proved_the_passphrase_is_refused_silently() {
        // Shutting a machine down is at least as consequential as typing on
        // it: same gate as input, checked BEFORE the plan is made. Answered
        // with SILENCE, like the attended host: an Error here would make the
        // service end the session (a peer that has not proved itself is owed
        // nothing, and certainly not the power to end its own session with a
        // message of its choosing).
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        a.ua.arm(puca_ua::UaRecord::new(
            [1u8; 16],
            ed25519_dalek::SigningKey::from_bytes(&[5u8; 32]).verifying_key().to_bytes(),
        ));
        let key = open_sealed(&mut a, "s1");
        let r = power_signal(&mut a, &key, 1, "shutdown");
        assert!(matches!(&r, Response::SealedSignals { payloads } if payloads.is_empty()),
            "an unproved session must get silence, not an Error (session-ending) and not a plan: {r:?}");
        assert_eq!(power_plans(), vec![], "the gate ran AFTER the plan was carried out");
    }

    #[test]
    fn an_unknown_power_action_is_refused_as_power_failed_never_guessed_never_session_ending() {
        // The controller may be newer than this agent ("restart", one day).
        // The refusal rides back as the power-failed frame the controller
        // renders; a Response::Error would have the service END the session
        // over a frame that did not matter — the opposite of the unknown-kind
        // policy a few lines below the arm.
        let (mut a, key) = proved_headless();
        let r = power_signal(&mut a, &key, 1, "restart");
        let f = only_sealed(&r, &key);
        assert_eq!(f["kind"], "power-failed");
        assert_eq!(f["action"], "restart");
        assert!(f["reason"].as_str().unwrap_or("").contains("not one this agent knows"), "{f}");
        assert_eq!(power_plans(), vec![]);
    }

    #[test]
    fn a_failed_power_action_is_reported_as_power_failed_and_the_session_survives() {
        power_answers(Err("ExitWindowsEx failed: access denied".to_string()));
        let (mut a, key) = proved_headless();
        let r = power_signal(&mut a, &key, 1, "shutdown");
        assert!(!matches!(r, Response::Error { .. }), "an Error would END the session over a shutdown that did not happen: {r:?}");
        let f = only_sealed(&r, &key);
        assert_eq!(f["kind"], "power-failed");
        assert_eq!(f["action"], "shutdown");
        assert!(f["reason"].as_str().unwrap_or("").contains("access denied"), "{f}");
        // Still alive: the next frame on the same session is handled, not
        // refused with "no sealed session".
        power_answers(Ok(()));
        assert!(matches!(power_signal(&mut a, &key, 2, "lock"), Response::SealedSignals { .. }));
    }

    #[cfg(windows)]
    #[test]
    fn a_sealed_frame_is_opened_and_injected() {
        // THE POSITIVE CONTROL. Every refusal below is meaningless without it:
        // a gate that rejected everything would satisfy them all while making
        // remote control impossible.
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let key = open_sealed(&mut a, "s1");
        // Not armed, so UA is not required — matching the shipped behaviour
        // where an unarmed host asks the person sitting at it instead.
        match a.handle(Request::InjectSealed { session_id: "s1".into(), payload: seal_input(&key, 1) }) {
            Response::Ok => {}
            other => panic!("a valid sealed frame must be injected: {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_replayed_frame_does_not_inject_twice() {
        // Sequence numbers are the only replay defence on this path: the
        // transport is a relay the server can see and reorder. Accepting the
        // same frame twice would let a captured keystroke be re-delivered.
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let key = open_sealed(&mut a, "s1");
        let frame = seal_input(&key, 5);
        assert!(matches!(
            a.handle(Request::InjectSealed { session_id: "s1".into(), payload: frame.clone() }),
            Response::Ok
        ));
        // Replayed: answered Ok (a flaky link legitimately resends) but the
        // sequence must not advance, and nothing is injected.
        assert!(matches!(
            a.handle(Request::InjectSealed { session_id: "s1".into(), payload: frame }),
            Response::Ok
        ));
        // An OLDER frame is likewise refused silently.
        assert!(matches!(
            a.handle(Request::InjectSealed { session_id: "s1".into(), payload: seal_input(&key, 4) }),
            Response::Ok
        ));
        // ...but a NEWER one still works, or the session would wedge after one
        // duplicate.
        assert!(matches!(
            a.handle(Request::InjectSealed { session_id: "s1".into(), payload: seal_input(&key, 6) }),
            Response::Ok
        ));
    }

    #[test]
    fn a_frame_sealed_under_the_wrong_key_is_refused_without_saying_why() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let _ = open_sealed(&mut a, "s1");
        let wrong = [1u8; 32];
        match a.handle(Request::InjectSealed {
            session_id: "s1".into(),
            payload: seal_input(&wrong, 1),
        }) {
            Response::Error { message } => {
                // Must not leak whether the key, the padding or the shape was
                // wrong — that distinction is a decryption oracle.
                assert!(message.contains("could not be opened"), "{message}");
            }
            other => panic!("a forged frame must be refused: {other:?}"),
        }
    }

    #[test]
    fn an_unknown_session_cannot_inject() {
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        match a.handle(Request::InjectSealed { session_id: "nope".into(), payload: "x".into() }) {
            Response::Error { message } => assert!(message.contains("no sealed session"), "{message}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn the_plaintext_never_comes_back_out() {
        // The property the whole stage exists for. If a frame's contents can be
        // recovered from any response, moving the key into the agent bought
        // nothing — the caller could simply ask.
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let key = open_sealed(&mut a, "s1");
        // A CANARY, not a password-shaped string. The point is only that it is
        // distinctive enough to find in any output; making it look like a real
        // credential adds nothing to the test and makes every log line, diff and
        // transcript that quotes it read like a leak.
        //
        // `FAIL-` makes the test stand-in for `inject` REFUSE it, so this walks
        // the ERROR path — the one place a careless `format!("{e} for {frame}")`
        // could echo the plaintext. The Ok path renders `Response::Ok`, which
        // cannot leak anything and would make this assertion vacuous.
        let secret = "FAIL-LEAK-CANARY-9f3a-MUST-NOT-BE-ECHOED";
        let frame = serde_json::json!({ "s": 1, "e": { "t": "text", "text": secret } });
        let sealed = crate::control_key::seal(&key, &frame.to_string()).unwrap();
        let resp = a.handle(Request::InjectSealed { session_id: "s1".into(), payload: sealed });
        let rendered = format!("{resp:?}");
        // POSITIVE CONTROL: the error path really was taken (else the assertion
        // below is testing nothing).
        assert!(
            matches!(resp, Response::Error { .. }),
            "the stand-in must refuse a FAIL- text so the error path is exercised: {rendered}"
        );
        assert!(
            !rendered.contains(secret),
            "a response must never echo the frame it opened: {rendered}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn an_armed_machine_refuses_input_until_the_passphrase_is_proved() {
        // THE AUTHORISATION GATE. Sealing protects confidentiality and says
        // NOTHING about whether the peer may type here — and once a LocalSystem
        // process holds an internet socket, that is the property that matters.
        // Without this the cold-boot path would ship remote SYSTEM injection
        // into the sign-in screen gated only by an account credential.
        use ed25519_dalek::{Signer, SigningKey};

        let sk = SigningKey::from_bytes(&[42u8; 32]);
        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        a.ua.arm(puca_ua::UaRecord::new([1u8; 16], sk.verifying_key().to_bytes()));

        let key = open_sealed(&mut a, "s1");

        // Armed and unproved: refused, even though the frame is perfectly valid.
        match a.handle(Request::InjectSealed {
            session_id: "s1".into(),
            payload: seal_input(&key, 1),
        }) {
            Response::Error { message } => {
                assert!(message.contains("unattended access"), "{message}");
            }
            other => panic!("an armed host must not inject unproved input: {other:?}"),
        }

        // Take the challenge and answer it as the controller does.
        let (nonce, _salt) = match a.handle(Request::UaChallenge { session_id: "s1".into() }) {
            Response::UaChallenge { nonce, salt } => (nonce, salt),
            other => panic!("expected a challenge, got {other:?}"),
        };
        use base64::Engine as _;
        let raw: [u8; 32] = base64::engine::general_purpose::STANDARD
            .decode(&nonce)
            .unwrap()
            .try_into()
            .unwrap();
        // The context is the SESSION ID — the same thing the shipping
        // controller signs. A proof for one session must not authorise another.
        let sig = sk.sign(&puca_ua::challenge_message("s1", &raw)).to_bytes();

        assert!(matches!(
            a.handle(Request::UaProve {
                session_id: "s1".into(),
                nonce: nonce.clone(),
                sig: b64(&sig),
            }),
            Response::Ok
        ));

        // Now it injects. This is the positive control: without it, a gate that
        // refused for ever would pass the assertion above.
        assert!(matches!(
            a.handle(Request::InjectSealed { session_id: "s1".into(), payload: seal_input(&key, 2) }),
            Response::Ok
        ));
    }

    #[cfg(windows)]
    #[test]
    fn a_wrong_passphrase_is_refused_and_says_nothing_about_why() {
        use ed25519_dalek::{Signer, SigningKey};
        let real = SigningKey::from_bytes(&[42u8; 32]);
        let attacker = SigningKey::from_bytes(&[43u8; 32]);

        let mut a = agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        a.ua.arm(puca_ua::UaRecord::new([1u8; 16], real.verifying_key().to_bytes()));
        let key = open_sealed(&mut a, "s1");

        let nonce = match a.handle(Request::UaChallenge { session_id: "s1".into() }) {
            Response::UaChallenge { nonce, .. } => nonce,
            other => panic!("{other:?}"),
        };
        use base64::Engine as _;
        let raw: [u8; 32] = base64::engine::general_purpose::STANDARD
            .decode(&nonce).unwrap().try_into().unwrap();
        let bad = attacker.sign(&puca_ua::challenge_message("s1", &raw)).to_bytes();

        match a.handle(Request::UaProve { session_id: "s1".into(), nonce, sig: b64(&bad) }) {
            Response::Error { message } => {
                // One flat message. Distinguishing "wrong key" from "expired
                // nonce" from "unknown nonce" hands an attacker a search
                // procedure.
                assert_eq!(message, "unattended access was refused", "{message}");
            }
            other => panic!("a forged proof must be refused: {other:?}"),
        }

        // And input is STILL refused afterwards — a failed proof must not leave
        // the session half-authorised.
        assert!(matches!(
            a.handle(Request::InjectSealed { session_id: "s1".into(), payload: seal_input(&key, 1) }),
            Response::Error { .. }
        ));
    }

    #[test]
    fn a_fresh_agent_has_no_sealed_sessions() {
        // THE CONSTRAINT THAT MAKES CONNECTION-PER-EXCHANGE FATAL, stated here
        // because it is a property of THIS type and the code it breaks lives in
        // another crate.
        //
        // pipe::serve builds a fresh Agent for every client that connects. So a
        // caller that opens a new pipe connection per request stores its sealed
        // session in an object destroyed the moment that request ends, and every
        // following call answers "no sealed session with that id". The service's
        // relay was written that way and could not have worked; it now holds one
        // connection for the whole session.
        //
        // If a future change makes sessions outlive a connection, this test is
        // the thing that should be deleted deliberately rather than the bug
        // being reintroduced by accident.
        let mut a = headless_agent();
        a.handle(hello("s3cret-token", PROTOCOL_VERSION));
        let _key = open_sealed(&mut a, "s1");
        assert!(a.sealed.contains_key("s1"), "the session exists on THIS agent");

        // A second client gets a new Agent, exactly as pipe::serve builds one.
        let mut b = headless_agent();
        b.handle(hello("s3cret-token", PROTOCOL_VERSION));
        assert!(
            !b.sealed.contains_key("s1"),
            "sealed sessions do NOT survive a new connection — hold the connection"
        );
        match b.handle(Request::SealedChallenge { session_id: "s1".into() }) {
            Response::Error { .. } => {}
            other => panic!("a new agent must not know an old session, got {other:?}"),
        }
    }
}

