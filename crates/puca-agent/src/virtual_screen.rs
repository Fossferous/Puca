//! Getting a screen to capture when the machine has none switched on.
//!
//! A laptop with its lid shut and nothing plugged in has NO active display.
//! There is nothing to duplicate, and before this the failure was invisible
//! from the phone. `stream::start` answers the offer before the capture opens;
//! the capture then failed eight seconds later on the stream thread, which had
//! not yet serviced a single ICE check. The phone ran ICE against a socket
//! nobody answered and reported "could not connect to the device" (field
//! report 2026-10-21, the owner's own laptop; confirmed by opening the lid).
//!
//! So the HOST asks first, with `prepare_screen`, before it hands the agent an
//! offer. This module answers it:
//!
//!  * a screen exists                → `ready`, and the offer goes ahead as always;
//!  * none yet, just woken           → `waking`. A sleeping panel usually comes
//!                                     back within [`WAKE_GRACE`];
//!  * still none                     → ask Púca's service for the virtual screen
//!                                     (`puca-service/src/virtual_screen.rs`):
//!                                     `starting` while it comes up;
//!  * none, and no virtual screen    → `off`, with a named reason the phone turns
//!                                     into "<PC>'s screen is off — is its lid
//!                                     closed?…" instead of a generic failure.
//!
//! The virtual screen is HELD per session, renewed while that session streams,
//! and released when it stops, or as soon as a real screen comes back (the lid
//! opened). The service switches it off when nobody holds it, and also on its
//! own if this process dies and the renewals stop.
//!
//! The decisions are pure and tested here. The service conversation and the
//! display query are Windows-only and reached by no test: a test must never
//! switch a display device on the machine running it.

#![allow(dead_code)] // the Windows half is the only non-test caller

use std::time::{Duration, Instant};

/// How long a machine with no screen gets to produce one by WAKING before the
/// virtual screen is asked for. A DPMS-sleeping monitor that detached its
/// output usually reattaches within a second or two of `display_wake::nudge`.
/// A shut lid never does, and every second here is a second the phone waits.
pub const WAKE_GRACE: Duration = Duration::from_secs(3);

/// The whole wake window, matching the stream thread's own capture-open retry
/// (`stream.rs`, 8 s). Without a virtual screen, "off" is only said once a
/// sleeping panel has had as long to come back as it always had.
pub const WAKE_WINDOW: Duration = Duration::from_secs(8);

/// How long a virtual screen that the service switched on gets to appear as an
/// output. The driver's UMDF host has to start and Windows has to add the
/// display; seconds, not tens of seconds. The phone's own wait-for-video clock
/// (30 s, session.ts MEDIA_DEADLINE_MS) is re-armed when it hears "starting",
/// so this must stay well inside it.
pub const VIRTUAL_START_WINDOW: Duration = Duration::from_secs(15);

/// How long a hold outlives the last moment its session had a live stream (or
/// was created). Covers the gap between `prepare_screen` saying `ready` and the
/// stream starting, and a media RESTART's stop→start gap. Without it a tick
/// landing in that gap would switch the screen off under a session about to
/// use it.
pub const HOLD_LINGER: Duration = Duration::from_secs(20);

/// How often the holder renews with the service. Must stay well inside the
/// service's lease (puca-service virtual_screen::LEASE_TTL, 30 s); its test
/// pins the same relation on that side.
pub const RENEW_EVERY: Duration = Duration::from_secs(10);

/// How often the holder checks for a real screen coming back, and for holds
/// whose sessions have ended.
pub const TICK: Duration = Duration::from_secs(2);

/// Why there is no screen to show. Both reach the phone as a DeviceEnd reason
/// that `frontend/src/api/devices/session.ts` matches LITERALLY (its
/// `NO_SCREEN_*` constants pin the same strings): a reason is shown in place
/// of the generic "could not connect to the device".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffReason {
    /// No screen, and this PC has no virtual screen to switch on: the option
    /// is off, never installed, or remote access itself is not set up.
    NoVirtualScreen,
    /// The virtual screen is installed but did not come up: the service
    /// refused, its device is missing, or no output appeared in time.
    VirtualFailed,
}

pub const NO_SCREEN_LID: &str = "no-screen:lid";
pub const NO_SCREEN_VIRTUAL_FAILED: &str = "no-screen:virtual-failed";

impl OffReason {
    pub fn code(self) -> &'static str {
        match self {
            OffReason::NoVirtualScreen => NO_SCREEN_LID,
            OffReason::VirtualFailed => NO_SCREEN_VIRTUAL_FAILED,
        }
    }
}

/// The answer to `prepare_screen`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenState {
    Ready,
    Waking,
    Starting,
    Off(OffReason),
}

impl ScreenState {
    pub fn wire(self) -> &'static str {
        match self {
            ScreenState::Ready => "ready",
            ScreenState::Waking => "waking",
            ScreenState::Starting => "starting",
            ScreenState::Off(_) => "off",
        }
    }
}

/// What the service said when asked to hold the virtual screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HoldOutcome {
    /// It is (being) switched on. `instance_id` is the device's, for telling
    /// its output from a real one.
    On { instance_id: Option<String> },
    /// It cannot be: why, as a phone-facing reason, and the service's own
    /// detail for the log.
    Unavailable { reason: OffReason, detail: String },
}

/// What to do as a result of a decision, besides answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    None,
    /// Nudge the displays awake (once, at the start).
    Nudge,
    /// Ask the service for the virtual screen (once).
    AskForVirtual,
}

/// One session's preparation, across polls.
#[derive(Debug, Clone)]
pub struct Prep {
    pub since: Instant,
    pub nudged: bool,
    pub asked: Option<(Instant, HoldOutcome)>,
}

impl Prep {
    pub fn new(now: Instant) -> Self {
        Self { since: now, nudged: false, asked: None }
    }
}

/// THE DECISION, given what is true now. Pure.
///
/// A screen being present always wins, whatever was decided before: a panel
/// that woke late, or the virtual screen arriving, both read as `ready`.
pub fn decide(p: &Prep, now: Instant, outputs_present: bool) -> (ScreenState, Action) {
    if outputs_present {
        return (ScreenState::Ready, Action::None);
    }
    let waited = now.saturating_duration_since(p.since);
    match &p.asked {
        None if !p.nudged => (ScreenState::Waking, Action::Nudge),
        None if waited < WAKE_GRACE => (ScreenState::Waking, Action::None),
        None => (ScreenState::Starting, Action::AskForVirtual),
        // No virtual screen: still give a sleeping panel the whole window it
        // always had before saying "off".
        Some((_, HoldOutcome::Unavailable { reason, .. })) => {
            if waited < WAKE_WINDOW {
                (ScreenState::Waking, Action::None)
            } else {
                (ScreenState::Off(*reason), Action::None)
            }
        }
        Some((asked_at, HoldOutcome::On { .. })) => {
            if now.saturating_duration_since(*asked_at) < VIRTUAL_START_WINDOW {
                (ScreenState::Starting, Action::None)
            } else {
                (ScreenState::Off(OffReason::VirtualFailed), Action::None)
            }
        }
    }
}

/// The longest a host can sensibly poll before every path above has answered.
/// The sealed (sign-in-screen) path waits this long at most.
pub const PREPARE_CEILING: Duration =
    Duration::from_secs(WAKE_GRACE.as_secs() + VIRTUAL_START_WINDOW.as_secs() + 2);

// ------------------------------------------------------------ the service wire

/// The lines sent to the service's control pipe. `puca-service`'s
/// `the_virtual_screen_wire_matches_what_the_agent_speaks` pins the same
/// strings against its real types; the two crates are compiled apart, so these
/// pairs are what couples them (as for `sas_client::SAS_REQUEST_LINE`).
pub const HOLD_LINE: &str = r#"{"t":"virtual_screen_hold"}"#;
pub const RELEASE_LINE: &str = r#"{"t":"virtual_screen_release"}"#;

/// Read the service's answer to a hold. Anything but an explicit report that
/// says `installed` and carries no `unavailable` is NOT "on": a reply this
/// build does not understand must not leave the phone waiting for a screen
/// that was never switched on.
pub fn interpret_hold(line: &str) -> HoldOutcome {
    let unavailable = |reason, detail: &str| HoldOutcome::Unavailable { reason, detail: detail.to_string() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return unavailable(OffReason::VirtualFailed, "unreadable answer from the service");
    };
    match v.get("t").and_then(|t| t.as_str()) {
        Some("virtual_screen") => {
            let installed = v.get("installed").and_then(|x| x.as_bool()) == Some(true);
            match v.get("unavailable").and_then(|x| x.as_str()) {
                // Never installed: the option is off. The phone says how to
                // turn it on.
                Some("not_installed") => unavailable(OffReason::NoVirtualScreen, "not_installed"),
                Some(other) => unavailable(OffReason::VirtualFailed, other),
                None if installed => HoldOutcome::On {
                    instance_id: v.get("instance_id").and_then(|x| x.as_str()).map(str::to_string),
                },
                None => unavailable(OffReason::NoVirtualScreen, "not_installed"),
            }
        }
        Some("refused") => unavailable(
            OffReason::VirtualFailed,
            v.get("reason").and_then(|x| x.as_str()).unwrap_or("refused"),
        ),
        _ => unavailable(OffReason::VirtualFailed, "unexpected answer from the service"),
    }
}

/// No service pipe at all (`ERROR_FILE_NOT_FOUND`): remote access was never set
/// up on this PC, so there is no virtual screen to have. That is the option
/// being off, not a failure.
pub fn service_absent() -> HoldOutcome {
    HoldOutcome::Unavailable { reason: OffReason::NoVirtualScreen, detail: "no_service".into() }
}

// ------------------------------------------------------------ real or virtual

/// Does the interface path of a display adapter belong to the device instance
/// `instance_id`? Interface paths spell the instance ID with `#` for `\`
/// (`\\?\ROOT#DISPLAY#0001#{guid}`), case-insensitively.
pub fn adapter_is_instance(adapter_path: &str, instance_id: &str) -> bool {
    let want = format!("#{}#", instance_id.replace('\\', "#")).to_ascii_lowercase();
    let path = adapter_path.to_ascii_lowercase();
    // `\\?\` + the instance + `#{`: anchor on the prefix so ROOT#DISPLAY#0001
    // does not match ROOT#DISPLAY#00011.
    path.strip_prefix(r"\\?\")
        .map(|rest| format!("#{rest}").starts_with(&want))
        .unwrap_or(false)
}

/// Is a REAL screen active again, given the adapter paths of every active
/// display path?
///
/// `None` when this cannot be told, which is when none of the active paths is
/// the virtual screen's. While it is held and switched on, it should be one of
/// them; if the matcher cannot find it, it is not to be trusted to say that the
/// others are real. Without this positive control a matcher that never matches
/// would call the virtual screen itself "real", release it the moment it
/// appeared, and flap for the whole session.
pub fn real_screen_present(adapter_paths: &[String], instance_id: &str) -> Option<bool> {
    let ours = adapter_paths.iter().filter(|p| adapter_is_instance(p, instance_id)).count();
    if ours == 0 {
        return None;
    }
    Some(adapter_paths.len() > ours)
}

// ------------------------------------------------------------ the holds

/// Per-session holds, and the bookkeeping that keeps them honest. Pure: the
/// caller supplies the clock and the facts.
#[derive(Debug, Default)]
pub struct Holds {
    /// session id → when it last had a live stream (or was created).
    sessions: std::collections::HashMap<String, Instant>,
}

impl Holds {
    pub fn add(&mut self, session_id: &str, now: Instant) {
        self.sessions.insert(session_id.to_string(), now);
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    pub fn remove(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub fn clear(&mut self) {
        self.sessions.clear();
    }

    /// The tick: a session with a live stream refreshes its hold; one without
    /// for longer than [`HOLD_LINGER`] loses it. Returns whether anything was
    /// dropped.
    pub fn refresh(&mut self, now: Instant, is_live: impl Fn(&str) -> bool) -> bool {
        let before = self.sessions.len();
        for (id, last) in self.sessions.iter_mut() {
            if is_live(id) {
                *last = now;
            }
        }
        self.sessions.retain(|_, last| now.saturating_duration_since(*last) < HOLD_LINGER);
        self.sessions.len() != before
    }
}

// ------------------------------------------------------------ Windows

#[cfg(windows)]
pub use windows_impl::{prepare, stream_ended, stream_started};

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    struct Runtime {
        preps: HashMap<String, Prep>,
        holds: Holds,
        /// The virtual screen's instance ID while this process holds it.
        held: Option<Option<String>>,
        /// Live streams per session id (a restart overlaps start and end).
        live: HashMap<String, usize>,
        holder_running: bool,
    }

    fn rt() -> &'static Mutex<Runtime> {
        static RT: OnceLock<Mutex<Runtime>> = OnceLock::new();
        RT.get_or_init(|| {
            Mutex::new(Runtime {
                preps: HashMap::new(),
                holds: Holds::default(),
                held: None,
                live: HashMap::new(),
                holder_running: false,
            })
        })
    }

    fn lock() -> std::sync::MutexGuard<'static, Runtime> {
        rt().lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The stream thread for `session_id` started. Called by `stream::start`.
    pub fn stream_started(session_id: &str) {
        *lock().live.entry(session_id.to_string()).or_insert(0) += 1;
    }

    /// The stream thread for `session_id` exited (TerminatedGuard).
    pub fn stream_ended(session_id: &str) {
        let mut r = lock();
        if let Some(n) = r.live.get_mut(session_id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                r.live.remove(session_id);
            }
        }
    }

    /// Answer `prepare_screen` for `session_id`.
    pub fn prepare(session_id: &str) -> ScreenState {
        let present = !puca_capture::outputs().is_empty();
        let now = Instant::now();
        let mut r = lock();
        // A virtual screen this process already holds (another session's)
        // is held for this session too, so the first session ending does not
        // take the screen away from this one.
        if r.held.is_some() {
            r.holds.add(session_id, now);
            if present {
                r.preps.remove(session_id);
                return ScreenState::Ready;
            }
        }
        let prep = r.preps.entry(session_id.to_string()).or_insert_with(|| Prep::new(now)).clone();
        let (state, action) = decide(&prep, now, present);
        match action {
            Action::None => {}
            Action::Nudge => {
                if let Some(p) = r.preps.get_mut(session_id) {
                    p.nudged = true;
                }
                drop(r);
                crate::display_wake::nudge();
                eprintln!("[virtual-screen] {session_id}: no screen is on; woke the displays");
                return state;
            }
            Action::AskForVirtual => {
                // The hold is RESERVED before the lock drops for the request,
                // so a holder deciding in that gap that nobody holds the
                // screen cannot release it just as this session asks for it.
                // Withdrawn below if the answer is no.
                r.holds.add(session_id, now);
                drop(r);
                let outcome = ask(HOLD_LINE);
                eprintln!("[virtual-screen] {session_id}: still no screen; asked for the virtual screen: {outcome:?}");
                let mut r = lock();
                if !matches!(outcome, HoldOutcome::On { .. }) && r.held.is_none() {
                    r.holds.remove(session_id);
                }
                if let HoldOutcome::On { instance_id } = &outcome {
                    r.held = Some(instance_id.clone());
                    if !r.holder_running {
                        // Without the holder nothing renews, and the service
                        // switches the screen off after its lease: the session
                        // would lose its picture half a minute in. Said so.
                        r.holder_running = std::thread::Builder::new()
                            .name("virtual-screen".into())
                            .spawn(holder)
                            .map_err(|e| eprintln!("[virtual-screen] could not start the holder: {e}"))
                            .is_ok();
                    }
                }
                if let Some(p) = r.preps.get_mut(session_id) {
                    p.asked = Some((now, outcome));
                }
                return state;
            }
        }
        if matches!(state, ScreenState::Ready | ScreenState::Off(_)) {
            r.preps.remove(session_id);
        }
        if let ScreenState::Off(reason) = state {
            eprintln!("[virtual-screen] {session_id}: no screen to show ({})", reason.code());
        }
        state
    }

    /// One exchange with the service. Never under `cfg(test)`: a test must not
    /// switch a display device on the machine running it.
    #[cfg(not(test))]
    fn ask(line: &str) -> HoldOutcome {
        match crate::sas_client::exchange(line) {
            Ok(reply) => interpret_hold(reply.trim()),
            Err(crate::sas_client::ExchangeError::Open(e)) if e.raw_os_error() == Some(2) => service_absent(),
            Err(e) => HoldOutcome::Unavailable {
                reason: OffReason::VirtualFailed,
                detail: e.to_string(),
            },
        }
    }

    #[cfg(test)]
    fn ask(_line: &str) -> HoldOutcome {
        service_absent()
    }

    /// The holder: renews the service lease while any session holds the
    /// virtual screen, drops holds whose sessions stopped streaming, and lets
    /// go as soon as a real screen is back. Exits when nothing is held.
    fn holder() {
        let mut last_renew = Instant::now();
        let mut logged_paths = false;
        loop {
            std::thread::sleep(TICK);
            let now = Instant::now();
            let (empty, instance) = {
                let mut r = lock();
                let live: Vec<String> = r.live.keys().cloned().collect();
                if r.holds.refresh(now, |id| live.iter().any(|l| l == id)) {
                    eprintln!("[virtual-screen] a session that held the virtual screen has ended");
                }
                (r.holds.is_empty(), r.held.clone().flatten())
            };

            let paths = active_adapter_paths();
            if !logged_paths {
                // The field check for `adapter_is_instance`: what Windows
                // calls the active displays' adapters, beside the instance
                // the service reported. Once per hold, so the log says it.
                eprintln!("[virtual-screen] holding {instance:?}; active display adapters: {paths:?}");
                logged_paths = !paths.is_empty();
            }
            let real_back = instance
                .as_deref()
                .and_then(|i| real_screen_present(&paths, i))
                .unwrap_or(false);

            if empty || real_back {
                let mut r = lock();
                // Re-read under the lock: a session that prepared while this
                // tick was reading the displays has added a hold, and an
                // "empty" decided before it must not take its screen away.
                if !real_back && !r.holds.is_empty() {
                    continue;
                }
                if real_back {
                    eprintln!("[virtual-screen] a real screen is back; letting the virtual screen go");
                }
                r.holds.clear();
                r.held = None;
                r.holder_running = false;
                // RELEASED UNDER THE LOCK. The service files holds by this
                // process's id, so a release that lands AFTER a new session's
                // hold (prepared the moment the lock dropped) would cancel
                // that hold and switch its screen off under it. Holding the
                // lock for one short pipe exchange makes the new hold wait
                // its turn and arrive second.
                let _ = ask(RELEASE_LINE);
                drop(r);
                return;
            }
            if now.saturating_duration_since(last_renew) >= RENEW_EVERY {
                last_renew = now;
                if let HoldOutcome::Unavailable { detail, .. } = ask(HOLD_LINE) {
                    eprintln!("[virtual-screen] renewing the hold failed: {detail}");
                }
            }
        }
    }

    /// The adapter interface path of every ACTIVE display path's target.
    fn active_adapter_paths() -> Vec<String> {
        use windows::Win32::Devices::Display::{
            DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
            DISPLAYCONFIG_ADAPTER_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_ADAPTER_NAME,
            DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
            QDC_ONLY_ACTIVE_PATHS,
        };
        use windows::Win32::Foundation::ERROR_SUCCESS;
        let mut out = Vec::new();
        unsafe {
            let (mut n_paths, mut n_modes) = (0u32, 0u32);
            if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut n_paths, &mut n_modes) != ERROR_SUCCESS {
                return out;
            }
            let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); n_paths as usize];
            let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); n_modes as usize];
            if QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut n_paths,
                paths.as_mut_ptr(),
                &mut n_modes,
                modes.as_mut_ptr(),
                None,
            ) != ERROR_SUCCESS
            {
                return out;
            }
            paths.truncate(n_paths as usize);
            for p in &paths {
                let mut name = DISPLAYCONFIG_ADAPTER_NAME {
                    header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                        r#type: DISPLAYCONFIG_DEVICE_INFO_GET_ADAPTER_NAME,
                        size: std::mem::size_of::<DISPLAYCONFIG_ADAPTER_NAME>() as u32,
                        adapterId: p.targetInfo.adapterId,
                        id: 0,
                    },
                    ..Default::default()
                };
                if DisplayConfigGetDeviceInfo(&mut name.header) == ERROR_SUCCESS.0 as i32 {
                    let w = &name.adapterDevicePath;
                    let n = w.iter().position(|c| *c == 0).unwrap_or(w.len());
                    out.push(String::from_utf16_lossy(&w[..n]));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    fn on() -> HoldOutcome {
        HoldOutcome::On { instance_id: Some(r"ROOT\DISPLAY\0001".into()) }
    }

    #[test]
    fn a_machine_with_a_screen_is_ready_at_once_and_nothing_is_asked() {
        let now = t0();
        assert_eq!(decide(&Prep::new(now), now, true), (ScreenState::Ready, Action::None));
    }

    #[test]
    fn no_screen_first_wakes_the_displays_then_waits_the_grace() {
        let now = t0();
        let mut p = Prep::new(now);
        assert_eq!(decide(&p, now, false), (ScreenState::Waking, Action::Nudge));
        p.nudged = true;
        assert_eq!(decide(&p, now + Duration::from_secs(1), false), (ScreenState::Waking, Action::None));
        // A panel that wakes inside the grace is simply ready.
        assert_eq!(decide(&p, now + Duration::from_secs(2), true).0, ScreenState::Ready);
    }

    #[test]
    fn still_no_screen_after_the_grace_asks_for_the_virtual_screen_once() {
        let now = t0();
        let mut p = Prep::new(now);
        p.nudged = true;
        assert_eq!(decide(&p, now + WAKE_GRACE, false), (ScreenState::Starting, Action::AskForVirtual));
        p.asked = Some((now + WAKE_GRACE, on()));
        // Asked once: from here only the clock moves it.
        assert_eq!(decide(&p, now + WAKE_GRACE + Duration::from_secs(1), false), (ScreenState::Starting, Action::None));
        // The virtual screen appearing is "ready".
        assert_eq!(decide(&p, now + WAKE_GRACE + Duration::from_secs(4), true).0, ScreenState::Ready);
    }

    #[test]
    fn a_virtual_screen_that_never_appears_is_a_named_failure_not_a_wait_for_ever() {
        let now = t0();
        let mut p = Prep::new(now);
        p.nudged = true;
        p.asked = Some((now, on()));
        assert_eq!(decide(&p, now + VIRTUAL_START_WINDOW - Duration::from_millis(1), false).0, ScreenState::Starting);
        assert_eq!(
            decide(&p, now + VIRTUAL_START_WINDOW, false).0,
            ScreenState::Off(OffReason::VirtualFailed)
        );
    }

    #[test]
    fn without_a_virtual_screen_the_answer_is_off_with_the_lid_reason_after_the_full_wake_window() {
        let now = t0();
        let mut p = Prep::new(now);
        p.nudged = true;
        p.asked = Some((now + WAKE_GRACE, service_absent()));
        // Negative control: inside the old wake window a sleeping panel still
        // gets its chance, as it did before this existed.
        assert_eq!(decide(&p, now + WAKE_WINDOW - Duration::from_millis(1), false).0, ScreenState::Waking);
        assert_eq!(decide(&p, now + WAKE_WINDOW, false).0, ScreenState::Off(OffReason::NoVirtualScreen));
        // ...and a panel waking at the last moment still wins.
        assert_eq!(decide(&p, now + WAKE_WINDOW, true).0, ScreenState::Ready);
    }

    #[test]
    fn the_windows_fit_inside_the_phones_wait_for_video() {
        // session.ts re-arms its 30 s media deadline on "starting"; the agent
        // must have answered by then.
        assert!(PREPARE_CEILING < Duration::from_secs(30));
        assert!(WAKE_GRACE < WAKE_WINDOW);
        assert!(RENEW_EVERY * 2 < Duration::from_secs(30), "two missed renewals must fit in the service's lease");
    }

    #[test]
    fn the_reasons_have_the_spellings_the_phone_matches() {
        // session.ts NO_SCREEN_LID_REASON / NO_SCREEN_VIRTUAL_FAILED_REASON
        // pin the same literals on the other side.
        assert_eq!(OffReason::NoVirtualScreen.code(), "no-screen:lid");
        assert_eq!(OffReason::VirtualFailed.code(), "no-screen:virtual-failed");
        assert_eq!(ScreenState::Off(OffReason::NoVirtualScreen).wire(), "off");
        assert_eq!(ScreenState::Starting.wire(), "starting");
    }

    /// The other half of the codes, in another language: the phone matches
    /// these literally (noScreen.ts), and a mismatch fails nowhere at runtime;
    /// the phone would just say "could not connect" again. A DIFFERENT file,
    /// so this scan cannot find the strings in its own assertions.
    #[test]
    fn the_phone_recognises_the_exact_codes_this_agent_sends() {
        let client = include_str!("../../../frontend/src/api/devices/noScreen.ts");
        for code in [NO_SCREEN_LID, NO_SCREEN_VIRTUAL_FAILED] {
            assert!(
                client.contains(&format!("'{code}'")),
                "noScreen.ts must define the code {code} this agent ends a session with"
            );
        }
    }

    #[test]
    fn the_service_lines_are_the_frames_it_parses() {
        assert_eq!(HOLD_LINE, r#"{"t":"virtual_screen_hold"}"#);
        assert_eq!(RELEASE_LINE, r#"{"t":"virtual_screen_release"}"#);
    }

    #[test]
    fn only_an_installed_report_with_no_complaint_counts_as_on() {
        assert_eq!(
            interpret_hold(r#"{"t":"virtual_screen","installed":true,"on":true,"instance_id":"ROOT\\DISPLAY\\0001"}"#),
            on()
        );
        // The option is off: the lid reason, which tells the phone how to fix it.
        assert!(matches!(
            interpret_hold(r#"{"t":"virtual_screen","installed":false,"on":false,"unavailable":"not_installed"}"#),
            HoldOutcome::Unavailable { reason: OffReason::NoVirtualScreen, .. }
        ));
        // Installed but broken: a different message.
        for tag in ["device_missing", "enable_failed", "something_new"] {
            let line = format!(r#"{{"t":"virtual_screen","installed":true,"on":false,"unavailable":"{tag}"}}"#);
            assert!(matches!(
                interpret_hold(&line),
                HoldOutcome::Unavailable { reason: OffReason::VirtualFailed, .. }
            ), "{tag}");
        }
        // Negative controls: nothing else is "on".
        for junk in ["", "{}", r#"{"t":"ok"}"#, r#"{"t":"refused","reason":"no"}"#, "null"] {
            assert!(matches!(interpret_hold(junk), HoldOutcome::Unavailable { .. }), "{junk:?}");
        }
        // An old service: the pipe is there but does not know the verb.
        assert!(matches!(
            interpret_hold(r#"{"t":"refused","reason":"unrecognised request"}"#),
            HoldOutcome::Unavailable { reason: OffReason::VirtualFailed, .. }
        ));
    }

    #[test]
    fn the_adapter_matcher_finds_exactly_its_own_instance() {
        let ours = r"\\?\ROOT#DISPLAY#0001#{5b45201d-f2f2-4f3b-85bb-30ff1f953599}";
        assert!(adapter_is_instance(ours, r"ROOT\DISPLAY\0001"));
        assert!(adapter_is_instance(&ours.to_ascii_lowercase(), r"ROOT\DISPLAY\0001"));
        // Not a neighbour that shares a prefix, not a PCI GPU.
        assert!(!adapter_is_instance(r"\\?\ROOT#DISPLAY#00011#{x}", r"ROOT\DISPLAY\0001"));
        assert!(!adapter_is_instance(r"\\?\ROOT#DISPLAY#0000#{x}", r"ROOT\DISPLAY\0001"));
        assert!(!adapter_is_instance(
            r"\\?\PCI#VEN_8086&DEV_46A6&SUBSYS_0B6E1028&REV_0C#3&11583659&0&10#{5b45201d}",
            r"ROOT\DISPLAY\0001"
        ));
        assert!(!adapter_is_instance("", r"ROOT\DISPLAY\0001"));
    }

    #[test]
    fn a_real_screen_is_only_reported_when_the_virtual_one_is_recognised_too() {
        let virt = r"\\?\ROOT#DISPLAY#0001#{g}".to_string();
        let panel = r"\\?\PCI#VEN_8086&DEV_46A6#3&1#{g}".to_string();
        let id = r"ROOT\DISPLAY\0001";
        // Lid closed, virtual screen on: no real screen.
        assert_eq!(real_screen_present(&[virt.clone()], id), Some(false));
        // Lid opened: the panel is back beside it.
        assert_eq!(real_screen_present(&[panel.clone(), virt.clone()], id), Some(true));
        // THE POSITIVE CONTROL: the virtual screen is not among the active
        // paths (not up yet, or the matcher is wrong for this machine). Then
        // nothing is claimed, so the hold is not dropped on a guess.
        assert_eq!(real_screen_present(&[panel], id), None);
        assert_eq!(real_screen_present(&[], id), None);
    }

    #[test]
    fn a_hold_lasts_while_its_session_streams_and_lingers_only_briefly_after() {
        let now = t0();
        let mut h = Holds::default();
        h.add("s1", now);
        // Not live yet (the offer is still on its way): kept within the linger.
        assert!(!h.refresh(now + HOLD_LINGER - Duration::from_secs(1), |_| false));
        assert!(h.contains("s1"));
        // Live: refreshed, survives well past the linger.
        h.refresh(now + Duration::from_secs(10), |_| true);
        h.refresh(now + Duration::from_secs(60), |_| true);
        assert!(h.contains("s1"));
        // A media restart's stop→start gap is shorter than the linger.
        assert!(!h.refresh(now + Duration::from_secs(65), |_| false));
        assert!(h.contains("s1"));
        // Ended for good: gone after the linger.
        assert!(h.refresh(now + Duration::from_secs(60) + HOLD_LINGER, |_| false));
        assert!(h.is_empty());
    }

    #[test]
    fn one_session_ending_does_not_take_the_screen_from_another() {
        let now = t0();
        let mut h = Holds::default();
        h.add("s1", now);
        h.add("s2", now);
        h.refresh(now + HOLD_LINGER + Duration::from_secs(1), |id| id == "s2");
        assert!(!h.contains("s1"));
        assert!(h.contains("s2"));
        assert!(!h.is_empty(), "s2 still streams, so the screen stays");
    }
}
