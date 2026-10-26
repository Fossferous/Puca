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
/// A stream PINNED to its screen (StartStream `steer_on_lid` off) whose
/// screen is no longer the one at its index: gone, renumbered, or another
/// screen in its place (a capture rebuilds by index). It ends rather than
/// show that screen, and no restart answers it: restarted by index, it could
/// land on a screen nobody shared (session.rs `stream_end_code`).
pub const NO_SCREEN_CHANGED: &str = "no-screen:changed";

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
///
/// `lid_dark`: the only screens are built-in panels behind a CLOSED lid. That
/// is not a sleeping monitor, and nothing wakes it, so the wake grace and the
/// wake window are skipped: the virtual screen is asked for at once, and
/// without one the answer is "off" at once.
pub fn decide(p: &Prep, now: Instant, outputs_present: bool, lid_dark: bool) -> (ScreenState, Action) {
    if outputs_present {
        return (ScreenState::Ready, Action::None);
    }
    let waited = now.saturating_duration_since(p.since);
    match &p.asked {
        None if lid_dark => (ScreenState::Starting, Action::AskForVirtual),
        None if !p.nudged => (ScreenState::Waking, Action::Nudge),
        None if waited < WAKE_GRACE => (ScreenState::Waking, Action::None),
        None => (ScreenState::Starting, Action::AskForVirtual),
        // No virtual screen: still give a sleeping panel the whole window it
        // always had before saying "off". A closed lid gets no window.
        Some((_, HoldOutcome::Unavailable { reason, .. })) => {
            if waited < WAKE_WINDOW && !lid_dark {
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

/// How long a preparation nobody has asked about is kept. Every caller polls
/// well inside this (the host every 500 ms, the sign-in path every 250 ms, a
/// live stream every 500 ms), so a gap this long means the preparation ended
/// without an answer that removes it: the session moved on a lit screen of
/// its own, the lid opened, or the session ended. Reused later, it would
/// answer for a screen asked for long ago.
pub const PREP_FORGOTTEN_AFTER: Duration = Duration::from_secs(5);

/// Every session's preparation, across polls: what `prepare` keeps. Pure.
///
/// A preparation USED TO LIVE until `prepare` answered `ready` or `off`, and
/// a live stream asking mid-session seldom hears either: it sees the virtual
/// screen lit at its own next look and moves there, and asks no more. The
/// preparation stayed, with the virtual screen asked for, and the NEXT time
/// the lid shut in that session (after the holder had let the screen go when
/// the lid opened), `decide` read the old ask: past `VIRTUAL_START_WINDOW`,
/// "the virtual screen did not start", without asking the service at all.
/// So a preparation is begun ANEW when a caller starts asking afresh (a live
/// stream's first request for a screen after the lid changed), and forgotten
/// when nobody has asked about it for `PREP_FORGOTTEN_AFTER`.
#[derive(Debug, Default)]
pub struct Preps {
    by_session: std::collections::HashMap<String, (Prep, Instant)>,
}

impl Preps {
    /// The session's preparation for a poll at `now`, and whether it was begun
    /// just now: `anew`, none kept, or the one kept is stale.
    pub fn begin(&mut self, session_id: &str, now: Instant, anew: bool) -> (Prep, bool) {
        let stale = self
            .by_session
            .get(session_id)
            .is_none_or(|(_, at)| now.saturating_duration_since(*at) >= PREP_FORGOTTEN_AFTER);
        let fresh = anew || stale;
        if fresh {
            self.by_session.insert(session_id.to_string(), (Prep::new(now), now));
        }
        let entry = self.by_session.get_mut(session_id).expect("begun above");
        entry.1 = now;
        (entry.0.clone(), fresh)
    }

    pub fn nudged(&mut self, session_id: &str) {
        if let Some((p, _)) = self.by_session.get_mut(session_id) {
            p.nudged = true;
        }
    }

    /// The service answered an ask made at `asked_at`; `now` is when the
    /// answer came, which can be a while later (it counts as being asked about).
    pub fn asked(&mut self, session_id: &str, asked_at: Instant, outcome: HoldOutcome, now: Instant) {
        if let Some((p, at)) = self.by_session.get_mut(session_id) {
            p.asked = Some((asked_at, outcome));
            *at = now;
        }
    }

    /// The answer that ends a preparation (`ready`, `off`) removes it.
    pub fn settle(&mut self, session_id: &str, state: ScreenState) {
        if matches!(state, ScreenState::Ready | ScreenState::Off(_)) {
            self.by_session.remove(session_id);
        }
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.by_session.contains_key(session_id)
    }
}

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

// ------------------------------------------------------------ the dark panel
//
// THE SECOND WAY A LAPTOP HAS NO SCREEN, found in the field on 0.9.842
// (2026-10-22). This file first assumed a shut lid leaves NO active output.
// On the owner's laptop it does not: with the lid shut, the built-in panel
// stays in the desktop as an active DXGI output (Device Manager: "Generic PnP
// Monitor", OK; WMI VideoOutputTechnology 11, embedded DisplayPort), and
// Windows simply never presents a frame to it. So `prepare_screen` saw "a
// screen", answered `ready`, and the stream ended twelve seconds later with
// "no frame ever arrived". Neither a wake nudge nor a provoked repaint helps.
// A panel behind a closed lid is not asleep; it is off by design.
//
// The fix asks Windows the two things that decide it: is the lid closed (the
// lid switch's power-setting notification, `lid.rs`), and which active
// displays are BUILT IN (the path's output technology). A built-in panel
// behind a closed lid is DARK, and a PC whose only outputs are dark has no
// screen: the virtual screen, or the named reason, exactly as when it has no
// output at all.

/// One active display path, as far as these decisions need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayPath {
    /// The GDI source name (`\\.\DISPLAY1`): what joins a path to a DXGI output.
    pub gdi_name: String,
    /// The target adapter's interface path: what tells the virtual screen's
    /// own output apart (`adapter_is_instance`).
    pub adapter_path: String,
    /// The target is a built-in panel (`is_builtin_technology`).
    pub builtin: bool,
}

/// Is a `DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY` a panel built into the machine?
/// Embedded DisplayPort (11) is what current laptops report, the owner's
/// included. LVDS (6) is older laptops'. UDI embedded (13), and INTERNAL
/// (0x80000000), are what a driver reports when it cannot name the link.
/// Everything else (HDMI, external DisplayPort, the indirect virtual screen)
/// is not built in.
pub fn is_builtin_technology(tech: i32) -> bool {
    matches!(tech, 6 | 11 | 13 | i32::MIN)
}

/// Which DXGI outputs are dark: built-in panels while the lid is closed.
/// `outputs` pairs each DXGI index with its GDI device name. `lid_closed` is
/// `None` when the lid's state is unknown (a desktop PC, or the notification
/// never arrived). Then nothing is dark, which is exactly the behaviour before
/// this existed. An output no path names is never called dark.
pub fn dark_outputs(outputs: &[(usize, String)], paths: &[DisplayPath], lid_closed: Option<bool>) -> Vec<usize> {
    if lid_closed != Some(true) {
        return Vec::new();
    }
    outputs
        .iter()
        .filter(|(_, gdi)| paths.iter().any(|p| p.builtin && p.gdi_name.eq_ignore_ascii_case(gdi)))
        .map(|(i, _)| *i)
        .collect()
}

/// Is there anything to show: an output that is not dark?
pub fn any_lit(outputs: &[usize], dark: &[usize]) -> bool {
    outputs.iter().any(|o| !dark.contains(o))
}

/// Where a stream should capture, given the target it was asked for. A single
/// dark screen moves to the first lit one. All Displays with exactly ONE lit
/// screen becomes that screen: a composite of a lit tile beside a black one
/// whose windows nobody can see is not worth a picture twice the size. Anything
/// else stays as asked. `all` is the All-Displays sentinel.
pub fn steer_monitor(target: usize, outputs: &[usize], dark: &[usize], all: usize) -> usize {
    if dark.is_empty() {
        return target;
    }
    let lit: Vec<usize> = outputs.iter().copied().filter(|o| !dark.contains(o)).collect();
    let Some(&first) = lit.first() else { return target };
    if target == all {
        return if lit.len() == 1 { first } else { target };
    }
    if dark.contains(&target) {
        first
    } else {
        target
    }
}

/// Is a REAL screen active again, besides the virtual one?
///
/// Real means not the virtual screen, and not dark: a built-in panel behind a
/// closed lid stays an active path the whole time the virtual screen is on
/// (that is the case this file was fixed for), and counting it as "real" would
/// release the virtual screen the moment it appeared. Opening the lid is what
/// makes the panel real again.
///
/// `None` when this cannot be told, which is when none of the active paths is
/// the virtual screen's. While it is held and switched on, it should be one of
/// them; if the matcher cannot find it, it is not to be trusted to say that the
/// others are real. Without this positive control a matcher that never matches
/// would call the virtual screen itself "real", release it the moment it
/// appeared, and flap for the whole session.
pub fn real_screen_present(paths: &[DisplayPath], instance_id: &str, lid_closed: Option<bool>) -> Option<bool> {
    let ours = paths.iter().filter(|p| adapter_is_instance(&p.adapter_path, instance_id)).count();
    if ours == 0 {
        return None;
    }
    Some(paths.iter().any(|p| {
        !adapter_is_instance(&p.adapter_path, instance_id) && !(p.builtin && lid_closed == Some(true))
    }))
}

// ------------------------------------------------------------ mid-session
//
// THE LID SHUT DURING A SESSION, found in the field on 2026-10-26. Everything
// above runs when a session STARTS. A session streaming the built-in panel
// at 60 fps had its lid shut 193 s in: the agent logged `[lid] the lid is
// now closed`, and then only still-screen skips and keyframe requests until
// the session ended, a frozen picture. The virtual screen was installed and
// working on that machine (an earlier session streamed 79 minutes from it
// with the lid shut); nothing asked for it.
//
// So a live stream watches the lid too (stream.rs, `LidWatch`), and decides
// with the SAME rules a start does: off a dark panel onto a lit screen, and
// with nothing lit (a dark panel, or no output at all), a screen through the
// same `prepare` a start polls, or the same named end without one.

/// How long the lid must have said one thing before a live stream acts on
/// it. The switch bounces: the field log has it closed and open again within
/// one line of each other, more than once. Acting on a bounce would move the
/// picture, or end the session, for nothing.
pub const LID_SETTLE: Duration = Duration::from_secs(1);

/// How often a live stream that is waiting on something (a screen to appear)
/// looks again, and how often it looks while it shows the virtual screen,
/// which the holder lets go soon after a real screen is lit.
pub const LID_POLL: Duration = Duration::from_millis(500);

/// How often a live stream looks again while the lid stays closed and
/// nothing needs doing: whatever else moves its capture (a topology rebuild,
/// a switch the viewer asked for) can land it on the dark panel.
pub const LID_RECHECK: Duration = Duration::from_secs(2);

/// How long after the lid changes, or after the stream acted on it, a
/// capture that FAILS is taken as Windows still re-arranging the screens
/// rather than a reason to end the stream: the panel leaves and the virtual
/// screen arrives (or the reverse), outputs come and go, and an index can be
/// missing for a moment. The capture retries itself every tick and the lid
/// watch rebuilds it. Past this, a capture still lost ends the stream
/// (`LidWatch::capture_lost_too_long`). Longer than the virtual screen's own
/// start (`VIRTUAL_START_WINDOW`).
pub const LID_TRANSITION_GRACE: Duration = Duration::from_secs(20);

/// How many moves in a row may fail before the stream stops trying: with the
/// lid shut it then ends with the named reason; with it open it stays where
/// it is. Each failed move waits twice as long as the last before the next.
pub const LID_MOVE_ATTEMPTS: u32 = 4;

/// How long a screen that refused a move is passed over.
pub const LID_AVOID_FOR: Duration = Duration::from_secs(30);

/// How long a move or a request for a screen may be out before it is taken as
/// lost. A move is one rebuild on the stream's own thread (its deadline is
/// 5 s); a request for a screen polls `prepare`, whose service exchange has
/// no timeout of its own, so a hung service must not hold the stream for ever.
pub const LID_MOVE_LIMIT: Duration = Duration::from_secs(10);
pub const LID_PREPARE_LIMIT: Duration = Duration::from_secs(PREPARE_CEILING.as_secs() + 5);

/// The displays as a live stream finds them when it looks: every output by
/// capture index, and which are dark (built-in panels behind a closed lid),
/// built in, and the virtual screen. `outputs_and_dark`'s answer, plus the
/// facts a stream needs to find a screen by IDENTITY rather than by index:
/// what kind each is, and each output's handle (HMONITOR) from the same
/// enumeration.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Displays {
    pub outputs: Vec<usize>,
    pub dark: Vec<usize>,
    pub builtin: Vec<usize>,
    pub virtual_screen: Vec<usize>,
    pub handles: Vec<(usize, isize)>,
}

impl Displays {
    /// Where the screen with this handle is now, if it is still there.
    pub fn index_of(&self, handle: isize) -> Option<usize> {
        self.handles.iter().find(|(_, h)| *h == handle).map(|(i, _)| *i)
    }

    /// The handle of the screen at index `i`.
    pub fn handle_of(&self, i: usize) -> Option<isize> {
        self.handles.iter().find(|(at, _)| *at == i).map(|(_, h)| *h)
    }

    /// Present and not dark: a screen Windows presents to.
    pub fn lit(&self, i: usize) -> bool {
        self.outputs.contains(&i) && !self.dark.contains(&i)
    }

    pub fn is_virtual(&self, i: usize) -> bool {
        self.virtual_screen.contains(&i)
    }

    fn lit_count(&self) -> usize {
        self.outputs.iter().filter(|&&i| self.lit(i)).count()
    }

    /// The lit screen a move should go to, never one in `avoid`: a REAL one
    /// first, since the holder lets the virtual screen go once a real screen
    /// is lit, and the virtual screen only when nothing real is.
    fn best_lit(&self, avoid: &[usize]) -> Option<usize> {
        let usable = |i: usize| self.lit(i) && !avoid.contains(&i);
        let real = self.outputs.iter().copied().find(|&i| usable(i) && !self.is_virtual(i));
        real.or_else(|| self.outputs.iter().copied().find(|&i| usable(i)))
    }

    fn best_real(&self, avoid: &[usize]) -> Option<usize> {
        self.outputs.iter().copied().find(|&i| self.lit(i) && !self.is_virtual(i) && !avoid.contains(&i))
    }
}

/// What a stream was asked to show, while the lid has it showing something
/// else. Only a lid move, or StartStream steering off a dark panel, ever sets
/// it: the screens the lid takes away are built-in panels, so going back is
/// "to the built-in panel", found again by what it IS (a panel re-enabled
/// after the lid opens can come back at another index), or to All Displays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Asked {
    AllDisplays,
    /// The built-in panel, at the index it had when it was asked for.
    Panel(usize),
}

impl Asked {
    /// What a stream asked for `from` remembers when the lid moves it.
    pub fn of(from: usize, all: usize) -> Self {
        if from == all {
            Asked::AllDisplays
        } else {
            Asked::Panel(from)
        }
    }

    /// Is a stream showing `at` back on what it asked for? On a built-in
    /// panel, whatever its index now; by index only when the displays carry
    /// no path facts at all (the query failed), the one thing left to go by.
    pub fn reached(self, at: usize, d: &Displays, all: usize) -> bool {
        match self {
            Asked::AllDisplays => at == all,
            Asked::Panel(i) if d.builtin.is_empty() && d.virtual_screen.is_empty() => at == i,
            Asked::Panel(_) => d.builtin.contains(&at),
        }
    }

    /// Where to go back to, once it is there.
    fn target(self, d: &Displays, avoid: &[usize], all: usize) -> Option<usize> {
        match self {
            Asked::AllDisplays => all_usable(d, avoid, all).then_some(all),
            Asked::Panel(i) => {
                let usable = |b: usize| d.lit(b) && !avoid.contains(&b);
                if d.builtin.contains(&i) && usable(i) {
                    Some(i)
                } else {
                    d.builtin.iter().copied().find(|&b| usable(b))
                }
            }
        }
    }
}

/// All Displays opens every output, so it is usable only while no output is
/// one a move must avoid (another session's stream holds it, or All Displays
/// itself refused a move just now).
fn all_usable(d: &Displays, avoid: &[usize], all: usize) -> bool {
    !avoid.contains(&all) && !d.outputs.iter().any(|o| avoid.contains(o))
}

/// What the stream is asked for once a LID move `from` -> `to` lands, decided
/// with the displays `d` the move was decided on: whatever it was asked for
/// already, kept across any number of moves and gone once it is back on it.
///
/// A move begins an ask only when the lid closed and the stream LEAVES what
/// the lid took from it: a dark panel, a screen that is gone (what a lid
/// takes out of the desktop is the panel), or All Displays. Never for a
/// rebuild of the screen it shows (`same_screen`, `from == to`), nor for the
/// move off the virtual screen to a real one: neither was asked for by the
/// lid, and an external monitor recorded as "the panel" would be left for
/// the panel when the lid opens.
pub fn after_lid_move(
    asked: Option<Asked>,
    from: usize,
    to: usize,
    d: &Displays,
    lid_closed: bool,
    same_screen: bool,
    all: usize,
) -> Option<Asked> {
    let leaving = from == all || !d.lit(from);
    let begun = lid_closed && leaving && from != to && !same_screen;
    asked.or_else(|| begun.then_some(Asked::of(from, all))).filter(|a| !a.reached(to, d, all))
}

/// After ANY OTHER rebuild (a topology remap, the agent's own retarget, a
/// switch the viewer chose is `None` outright): it sets nothing (a desktop
/// whose screen was remapped has nothing the lid asked for), and a stream
/// that lands back on what it asked for has it again.
pub fn after_other_rebuild(asked: Option<Asked>, to: usize, d: &Displays, all: usize) -> Option<Asked> {
    asked.filter(|a| !a.reached(to, d, all))
}

/// What a LIVE stream does about the lid, decided from what is true now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LidStep {
    /// Nothing to do.
    Stay,
    /// Move the picture to this screen (or rebuild the capture there, when it
    /// is the screen the stream already shows and its capture is lost).
    MoveTo(usize),
    /// Nothing lit to move to: get a screen the way a session start does
    /// (`prepare`: wake, then the virtual screen), and move once one is lit.
    NeedScreen,
}

/// THE DECISION, pure. `current` is what the stream captures, `capture_ok`
/// whether it still has a working capture of it, `avoid` the screens a move
/// must not take (another session's stream holds them, or they refused a move
/// just now). `all` is the All-Displays sentinel.
///
/// Lid closed: a stream showing a lit screen stays (or rebuilds it, capture
/// lost); one showing a dark panel, or a screen that is gone, moves to the
/// best lit screen, or needs a screen when none is lit, no output at all
/// included. All Displays follows the start's rule: one lit screen left is
/// that screen. On the virtual screen with a real screen lit (a monitor
/// plugged in with the lid still shut), it moves to the real one before the
/// holder lets the virtual screen go.
///
/// Lid open: a stream the lid moved goes back to what it was asked for, the
/// built-in panel found by what it is, as soon as that is lit; and one on the
/// virtual screen leaves it for a real screen.
///
/// NO LID (a desktop, `lid_closed == None`): nothing ever moves. Nothing the
/// lid asked for can exist there, and a stream on a desktop has no virtual
/// screen to leave.
pub fn lid_step(
    asked: Option<Asked>,
    current: usize,
    d: &Displays,
    lid_closed: Option<bool>,
    capture_ok: bool,
    avoid: &[usize],
    all: usize,
) -> LidStep {
    let Some(closed) = lid_closed else { return LidStep::Stay };
    let one_lit = || match d.best_lit(avoid) {
        Some(one) => LidStep::MoveTo(one),
        None => LidStep::NeedScreen,
    };
    if closed {
        if current == all {
            return match d.lit_count() {
                0 => LidStep::NeedScreen,
                1 => one_lit(),
                _ if capture_ok => LidStep::Stay,
                _ if all_usable(d, avoid, all) => LidStep::MoveTo(all),
                _ => one_lit(),
            };
        }
        if d.lit(current) {
            if d.is_virtual(current) {
                if let Some(real) = d.best_real(avoid) {
                    return LidStep::MoveTo(real);
                }
            }
            return if capture_ok { LidStep::Stay } else { LidStep::MoveTo(current) };
        }
        return one_lit();
    }
    if let Some(asked) = asked {
        if let Some(t) = asked.target(d, avoid, all) {
            if t != current {
                return LidStep::MoveTo(t);
            }
        }
    }
    if d.is_virtual(current) {
        if let Some(real) = d.best_real(avoid) {
            return LidStep::MoveTo(real);
        }
    }
    let rebuildable = if current == all { all_usable(d, avoid, all) } else { d.lit(current) };
    if !capture_ok && rebuildable {
        return LidStep::MoveTo(current);
    }
    LidStep::Stay
}

/// What a stream PINNED to its screen does about the lid: StartStream's
/// `steer_on_lid` off, which is the default.
///
/// WHY. In an attended session the person at the host may share ONE screen,
/// say the built-in display. `lid_step` moves a stream off a dark panel to
/// the first lit screen, an external monitor included: shutting the lid
/// handed the viewer a screen that person never shared, to see and to
/// control, and a host app reacts a second or two later at best (an old one
/// never does). So unless the host app says it can follow a move and check
/// consent for it (`steer_on_lid`), a stream never goes to another screen:
/// not a lit one, not the virtual screen, not back to the panel when the lid
/// opens, and not its own screen at a new index. Its screen dark behind the
/// closed lid, or not at its index any more, ends it: with the lid's code,
/// as a start with no screen does, or `NO_SCREEN_CHANGED`. The stream also
/// checks the screen of every picture it sends (stream.rs `screen_pin`), lid
/// or no lid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinnedStep {
    Stay,
    /// Rebuild the capture on the stream's OWN screen, at its own index.
    Rebuild(usize),
    /// Nothing of its own to show: end the stream.
    End,
}

/// THE PINNED DECISION, pure. The stream keeps the screen it showed: the one
/// whose handle (`current_handle`, read from the stream's own capture) is at
/// its index NOW. Dark behind the closed lid, gone, moved to another index,
/// replaced at this one, or with no handle known at all, it ends the stream.
/// It is not followed to a new index either: the host app's consent is by
/// index, so a stream that followed its screen there would report a screen
/// the host never agreed to, and be ended as one. All Displays stays All
/// Displays (rebuilt when its capture is lost) and ends when nothing at all
/// is lit. No lid, nothing ever happens here.
pub fn pinned_step(
    current: usize,
    current_handle: Option<isize>,
    d: &Displays,
    lid_closed: Option<bool>,
    capture_ok: bool,
    all: usize,
) -> PinnedStep {
    let Some(closed) = lid_closed else { return PinnedStep::Stay };
    if current == all {
        return if closed && d.lit_count() == 0 {
            PinnedStep::End
        } else if capture_ok {
            PinnedStep::Stay
        } else {
            PinnedStep::Rebuild(all)
        };
    }
    let own = current_handle.is_some() && d.handle_of(current) == current_handle;
    if !own || !d.lit(current) {
        PinnedStep::End
    } else if capture_ok {
        PinnedStep::Stay
    } else {
        PinnedStep::Rebuild(current)
    }
}

/// Is the stream's own screen the built-in panel dark behind the closed lid?
/// The other reason its end names the lid (stream.rs `changed_end`): its own
/// screen, by handle at its own index, and dark. All Displays left with no
/// screen lit counts: what is left of it is behind the lid.
pub fn own_screen_dark(current: usize, current_handle: Option<isize>, d: &Displays, all: usize) -> bool {
    if current == all {
        return d.lit_count() == 0;
    }
    current_handle.is_some() && d.handle_of(current) == current_handle && d.dark.contains(&current)
}

/// What a live stream does about the lid: the one decision its loop acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LidAction {
    Stay,
    /// Rebuild the capture on this screen: another one (steering), or the
    /// stream's own at the index it has now.
    MoveTo(usize),
    /// Get a screen the way a session start does (steering only).
    NeedScreen,
    /// Nothing it may show: end the stream with the lid's code.
    End,
}

/// `lid_step` for a stream the host app lets steer (`steer_on_lid`), and
/// `pinned_step` for every other one: which of the two is THE choice that
/// keeps a screen nobody shared off the viewer's stage.
#[allow(clippy::too_many_arguments)]
pub fn lid_action(
    steer_on_lid: bool,
    asked: Option<Asked>,
    current: usize,
    current_handle: Option<isize>,
    d: &Displays,
    lid_closed: Option<bool>,
    capture_ok: bool,
    avoid: &[usize],
    all: usize,
) -> LidAction {
    if steer_on_lid {
        match lid_step(asked, current, d, lid_closed, capture_ok, avoid, all) {
            LidStep::Stay => LidAction::Stay,
            LidStep::MoveTo(t) => LidAction::MoveTo(t),
            LidStep::NeedScreen => LidAction::NeedScreen,
        }
    } else {
        match pinned_step(current, current_handle, d, lid_closed, capture_ok, all) {
            PinnedStep::Stay => LidAction::Stay,
            PinnedStep::Rebuild(i) => LidAction::MoveTo(i),
            PinnedStep::End => LidAction::End,
        }
    }
}

/// What a move or a request for a screen in flight is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flight {
    Move,
    Prepare,
}

/// One live stream's watch on the lid: what it last saw, when to look again,
/// what it has in flight, and how its moves have gone. Pure: the stream
/// supplies the clock and the facts, and does what the watch says.
#[derive(Debug, Clone)]
pub struct LidWatch {
    /// The lid as last observed, and since when.
    seen: Option<bool>,
    seen_since: Instant,
    /// The last time the lid changed, or the stream acted on it.
    stirred_at: Option<Instant>,
    /// The last time the LID changed, and only the lid (`lid_changed_recently`).
    lid_changed_at: Option<Instant>,
    /// When to look next.
    next_look: Instant,
    /// A move or a request for a screen, and since when.
    flight: Option<(Flight, Instant)>,
    /// What the stream was asked for, while the lid has it elsewhere.
    pub asked: Option<Asked>,
    /// Whether the stream showed the virtual screen when it last looked.
    pub on_virtual: bool,
    /// Moves that failed in a row, and the screens that refused one.
    failures: u32,
    refused: Vec<(usize, Instant)>,
    /// Gave up with the lid open (`give_up`): no more looks until it changes.
    resting: bool,
    /// When the capture was lost during a lid transition, if it still is.
    capture_lost_since: Option<Instant>,
}

impl LidWatch {
    /// A stream starting now, with the lid as it is and, when StartStream
    /// steered it off a dark panel, what it was asked for. The first look
    /// comes once the lid has been seen settled, from now.
    pub fn new(now: Instant, lid: Option<bool>, asked: Option<Asked>) -> Self {
        Self {
            seen: lid,
            seen_since: now,
            stirred_at: None,
            lid_changed_at: None,
            next_look: now + LID_SETTLE,
            flight: None,
            asked,
            on_virtual: false,
            failures: 0,
            refused: Vec::new(),
            resting: false,
            capture_lost_since: None,
        }
    }

    /// Note the lid as read now. True when it changed: the next look then
    /// waits for it to settle, and the moves that failed before are forgiven
    /// (it is a new situation).
    pub fn observe(&mut self, lid: Option<bool>, now: Instant) -> bool {
        if lid == self.seen {
            return false;
        }
        self.seen = lid;
        self.seen_since = now;
        self.stirred_at = Some(now);
        self.lid_changed_at = Some(now);
        self.next_look = now + LID_SETTLE;
        self.failures = 0;
        self.refused.clear();
        self.resting = false;
        true
    }

    /// Is a look due? Only for a lid that has settled, only with nothing in
    /// flight, only when the lid has something to say (it is closed, the
    /// stream is somewhere the lid put it, it shows the virtual screen, or its
    /// capture was lost while the lid changed the displays), and not after
    /// giving up with the lid open.
    pub fn due(&self, now: Instant) -> bool {
        self.flight.is_none()
            && !self.resting
            && self.seen.is_some()
            && now >= self.next_look
            && now.saturating_duration_since(self.seen_since) >= LID_SETTLE
            && (self.seen == Some(true) || self.asked.is_some() || self.on_virtual || self.capture_lost_since.is_some())
    }

    /// A look found nothing to do: look again on the slow clock, or soon
    /// while the stream shows the virtual screen.
    pub fn idle(&mut self, now: Instant) {
        self.next_look = now + if self.on_virtual { LID_POLL } else { LID_RECHECK };
    }

    /// The stream sent a move, or started asking for a screen.
    pub fn acted(&mut self, now: Instant, what: Flight) {
        self.flight = Some((what, now));
        self.stirred_at = Some(now);
    }

    /// What was in flight has answered; look again after `again`.
    pub fn landed(&mut self, now: Instant, again: Duration) {
        self.flight = None;
        self.next_look = now + again;
    }

    /// A move landed: whatever failed before is forgiven.
    pub fn moved(&mut self, now: Instant) {
        self.failures = 0;
        self.refused.clear();
        self.stirred_at = Some(now);
        self.landed(now, LID_RECHECK);
    }

    /// A move to `target` failed. Passes `target` over for `LID_AVOID_FOR`
    /// and waits twice as long as the last time before the next look (1 s,
    /// 2 s, 4 s...). True when that was the last attempt.
    pub fn move_failed(&mut self, target: usize, now: Instant) -> bool {
        self.failures += 1;
        self.refused.push((target, now));
        let backoff = LID_POLL * 2u32.saturating_pow(self.failures.min(4));
        self.landed(now, backoff);
        self.failures >= LID_MOVE_ATTEMPTS
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// The moves kept failing with the lid OPEN, where the picture still
    /// works where it is: what was asked for is forgotten, and the watch
    /// rests until the lid changes. (With the lid shut there is no such
    /// rest: the stream ends with the named reason.)
    pub fn give_up(&mut self) {
        self.asked = None;
        self.resting = true;
    }

    /// A request for a screen answered that one is on its way (waking the
    /// displays, the virtual screen starting): a capture lost meanwhile is
    /// waiting for it, so its clock starts again. `prepare`'s own windows
    /// bound how long this can go on (it answers `off` past them), and
    /// `LID_PREPARE_LIMIT` bounds a request that never answers.
    pub fn screen_coming(&mut self, now: Instant) {
        if self.capture_lost_since.is_some() {
            self.capture_lost_since = Some(now);
        }
    }

    /// Screens that refused a move just now.
    pub fn refused(&self, now: Instant) -> Vec<usize> {
        self.refused
            .iter()
            .filter(|(_, at)| now.saturating_duration_since(*at) < LID_AVOID_FOR)
            .map(|(i, _)| *i)
            .collect()
    }

    /// What is in flight past its limit, if anything: lost, and to be given up.
    pub fn flight_expired(&self, now: Instant) -> Option<Flight> {
        let (what, since) = self.flight?;
        let limit = match what {
            Flight::Move => LID_MOVE_LIMIT,
            Flight::Prepare => LID_PREPARE_LIMIT,
        };
        (now.saturating_duration_since(since) >= limit).then_some(what)
    }

    pub fn in_flight(&self) -> bool {
        self.flight.is_some()
    }

    /// Did the LID change within the grace? One reason a pinned stream's end
    /// names the lid (`no-screen:lid`, stream.rs `changed_end`). Not merely
    /// being closed: a laptop docked with its lid shut all session, whose
    /// screens a monitor plugged in renumbered, did not lose its screen to
    /// the lid, and "connect again with the lid open" is the wrong advice
    /// there. Nor the stream's own acts (`acted`), which a docked stream
    /// rebuilding its own screen also does. It guards nothing: a pinned
    /// stream checks the screen of every picture, always (`screen_pin`).
    pub fn lid_changed_recently(&self, now: Instant) -> bool {
        self.lid_changed_at.is_some_and(|t| now.saturating_duration_since(t) < LID_TRANSITION_GRACE)
    }

    /// May a capture that fails now be ridden out? Within the grace of the
    /// lid changing or the stream acting on it, or while something it sent is
    /// still within its limit. Never on a desktop that has no lid.
    pub fn rides_out_capture_loss(&self, now: Instant) -> bool {
        let flying = self.flight.is_some() && self.flight_expired(now).is_none();
        flying || self.stirred_at.is_some_and(|t| now.saturating_duration_since(t) < LID_TRANSITION_GRACE)
    }

    /// The stream's capture, as of now: a capture lost while the lid is
    /// changing the displays starts the clock `capture_lost_too_long` reads;
    /// a working one stops it.
    pub fn note_capture(&mut self, ok: bool, now: Instant) {
        if ok {
            self.capture_lost_since = None;
        } else if self.capture_lost_since.is_none() && self.rides_out_capture_loss(now) {
            self.capture_lost_since = Some(now);
        }
    }

    /// The capture has been lost for the whole grace and nothing in flight
    /// can bring it back: end the stream rather than hold a frozen picture.
    pub fn capture_lost_too_long(&self, now: Instant) -> bool {
        self.flight.is_none()
            && self.capture_lost_since.is_some_and(|t| now.saturating_duration_since(t) >= LID_TRANSITION_GRACE)
    }
}

/// The named end for a stream that can show nothing with the lid shut: its
/// moves kept failing, what it asked for never answered, or its capture
/// stayed lost. The virtual screen's own failure when it was in it (asked
/// for, or the screen a failing move went to), else the lid's: the codes a
/// session start ends with, which the viewer turns into its sentence.
pub fn lid_end(virtual_screen_in_it: bool) -> OffReason {
    if virtual_screen_in_it {
        OffReason::VirtualFailed
    } else {
        OffReason::NoVirtualScreen
    }
}

/// Does the holder let the virtual screen go? When nobody holds it, or once a
/// real screen has been back for two of its ticks in a row: the second tick
/// is the streams' time to move off it first (each looks every `LID_POLL`
/// while it shows the virtual screen), so none is left on a screen that has
/// just been switched off.
pub fn holder_lets_go(empty: bool, real_back_ticks: u32) -> bool {
    empty || real_back_ticks >= 2
}

/// The displays from the facts the system gives: the capture outputs, each
/// output's GDI name, the active display paths, the lid, and the virtual
/// screen's instance while it is held. Pure, so the joins are tested.
pub fn displays_from(
    outputs: &[usize],
    named: &[(usize, String)],
    paths: &[DisplayPath],
    lid_closed: Option<bool>,
    instance: Option<&str>,
) -> Displays {
    let by_path = |want: &dyn Fn(&DisplayPath) -> bool| -> Vec<usize> {
        named
            .iter()
            .filter(|(_, gdi)| paths.iter().any(|p| want(p) && p.gdi_name.eq_ignore_ascii_case(gdi)))
            .map(|(i, _)| *i)
            .collect()
    };
    Displays {
        outputs: outputs.to_vec(),
        dark: dark_outputs(named, paths, lid_closed),
        builtin: by_path(&|p| p.builtin),
        virtual_screen: instance.map(|inst| by_path(&|p| adapter_is_instance(&p.adapter_path, inst))).unwrap_or_default(),
        handles: Vec::new(),
    }
}

/// The lid switch's notification payload (`GUID_LIDSWITCH_STATE_CHANGE`): a
/// DWORD, 0 = closed, 1 = open. Anything else is not a lid state.
pub fn decode_lid(data: &[u8]) -> Option<bool> {
    let bytes: [u8; 4] = data.get(..4)?.try_into().ok()?;
    match u32::from_le_bytes(bytes) {
        0 => Some(true),
        1 => Some(false),
        _ => None,
    }
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

/// The line `prepare` writes when a session finds the virtual screen
/// already on (held for an earlier session, or this one's earlier stream)
/// and joins the hold, or None when this session holds it already: the host
/// polls twice a second while it waits, and joining is one fact.
pub fn shared_hold_line(session_id: &str, instance: Option<&str>, present: bool, already: bool) -> Option<String> {
    if already {
        return None;
    }
    Some(format!(
        "[virtual-screen] {session_id}: the virtual screen ({}) is already on; holding it for this session too ({})",
        instance.unwrap_or("instance unknown"),
        if present { "a screen is showing: ready" } else { "no screen is showing yet" },
    ))
}

// ------------------------------------------------------------ Windows

#[cfg(windows)]
pub use windows_impl::{displays, prepare, prepare_anew, stream_ended, stream_started};
// StartStream's steer (session.rs `steer_target`), which a test build swaps
// for a seam.
#[cfg(windows)]
#[cfg_attr(test, allow(unused_imports))]
pub use windows_impl::outputs_and_dark;

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    struct Runtime {
        preps: Preps,
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
                preps: Preps::default(),
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

    /// The held screen's instance ID, for `displays()`, kept apart from the
    /// runtime's lock: the holder keeps that lock through one service
    /// exchange (its release), the exchange has no timeout of its own, and a
    /// live stream's look must never wait on the service.
    fn held_now() -> std::sync::MutexGuard<'static, Option<String>> {
        static HELD: OnceLock<Mutex<Option<String>>> = OnceLock::new();
        HELD.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|p| p.into_inner())
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
        prepare_for(session_id, false)
    }

    /// `prepare` for a caller that starts asking AFRESH: a live stream's
    /// first request for a screen after the lid changed. Whatever an earlier
    /// request in this session left (the virtual screen asked for, then let
    /// go) is not this request's answer (`Preps`).
    pub fn prepare_anew(session_id: &str) -> ScreenState {
        prepare_for(session_id, true)
    }

    fn prepare_for(session_id: &str, anew: bool) -> ScreenState {
        // "A screen" means one Windows will actually present to: a built-in
        // panel behind a closed lid is an active output that never shows a
        // frame (the 0.9.842 field case), so it does not count.
        let (outputs, dark) = outputs_and_dark();
        let present = any_lit(&outputs, &dark);
        let lid_dark = !present && !dark.is_empty();
        let now = Instant::now();
        let mut r = lock();
        // A virtual screen this process already holds (another session's)
        // is held for this session too, so the first session ending does not
        // take the screen away from this one.
        if let Some(instance) = r.held.clone() {
            // SAID, once per session: this branch answers without a word
            // otherwise, and on 2026-10-26 a reconnect that reused the hold
            // of the session before it left no line to say so.
            if let Some(line) = shared_hold_line(session_id, instance.as_deref(), present, r.holds.contains(session_id)) {
                eprintln!("{line}");
            }
            r.holds.add(session_id, now);
            if present {
                r.preps.settle(session_id, ScreenState::Ready);
                return ScreenState::Ready;
            }
        }
        let (prep, fresh) = r.preps.begin(session_id, now, anew);
        if fresh && lid_dark {
            eprintln!(
                "[virtual-screen] {session_id}: the lid is closed and the only screen is the built-in \
                 panel {dark:?}, which shows nothing"
            );
        }
        let (state, action) = decide(&prep, now, present, lid_dark);
        match action {
            Action::None => {}
            Action::Nudge => {
                r.preps.nudged(session_id);
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
                    *held_now() = instance_id.clone();
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
                // Answered now, which can be a while after `now`: it counts as
                // being asked about, so a slow service does not age the
                // preparation into being forgotten.
                r.preps.asked(session_id, now, outcome, Instant::now());
                return state;
            }
        }
        r.preps.settle(session_id, state);
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
    /// go once a real screen has been back for two ticks (`holder_lets_go`:
    /// the second is the streams' time to move off it). Exits when nothing is
    /// held.
    fn holder() {
        let mut last_renew = Instant::now();
        let mut logged_paths = false;
        // Ticks in a row a real screen has been back (`holder_lets_go`).
        let mut real_back_ticks = 0u32;
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

            let paths = display_paths();
            let lid = crate::lid::closed();
            if !logged_paths {
                // The field check for `adapter_is_instance`: what Windows
                // calls the active displays, beside the instance the service
                // reported. Once per hold, so the log says it.
                eprintln!("[virtual-screen] holding {instance:?}; lid closed: {lid:?}; active displays: {paths:?}");
                logged_paths = !paths.is_empty();
            }
            let real_back = instance
                .as_deref()
                .and_then(|i| real_screen_present(&paths, i, lid))
                .unwrap_or(false);
            real_back_ticks = if real_back { real_back_ticks + 1 } else { 0 };
            if real_back_ticks == 1 {
                eprintln!("[virtual-screen] a real screen is back; letting the virtual screen go at the next tick");
            }

            if holder_lets_go(empty, real_back_ticks) {
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
                *held_now() = None;
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

    /// The DXGI outputs (by index) and which of them are dark right now. The
    /// one place the lid, the display paths and the capture enumeration meet,
    /// shared by `prepare` and by StartStream's steering (session.rs).
    pub fn outputs_and_dark() -> (Vec<usize>, Vec<usize>) {
        let outs = puca_capture::outputs();
        let indices: Vec<usize> = outs.iter().map(|o| o.index).collect();
        let lid = crate::lid::closed();
        if lid != Some(true) {
            return (indices, Vec::new());
        }
        let named: Vec<(usize, String)> =
            outs.iter().filter_map(|o| gdi_name(o.hmonitor).map(|n| (o.index, n))).collect();
        let dark = dark_outputs(&named, &display_paths(), lid);
        (indices, dark)
    }

    /// The displays as a live stream needs them (`Displays`): which outputs
    /// are dark, built in, and the virtual screen. The path queries are
    /// skipped where neither can matter, a desktop with no lid holding no
    /// virtual screen: its outputs are all there is to know. Never waits on
    /// the service (`held_now`).
    pub fn displays() -> Displays {
        let outs = puca_capture::outputs();
        let indices: Vec<usize> = outs.iter().map(|o| o.index).collect();
        let lid = crate::lid::closed();
        let instance = held_now().clone();
        let handles: Vec<(usize, isize)> =
            outs.iter().filter(|o| o.hmonitor != 0).map(|o| (o.index, o.hmonitor)).collect();
        if lid.is_none() && instance.is_none() {
            return Displays { outputs: indices, handles, ..Displays::default() };
        }
        let named: Vec<(usize, String)> =
            outs.iter().filter_map(|o| gdi_name(o.hmonitor).map(|n| (o.index, n))).collect();
        Displays { handles, ..displays_from(&indices, &named, &display_paths(), lid, instance.as_deref()) }
    }

    /// `\\.\DISPLAYn` for an HMONITOR: the name that joins a DXGI output to
    /// its display path.
    fn gdi_name(hmonitor: isize) -> Option<String> {
        use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO, MONITORINFOEXW};
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        let ok = unsafe {
            GetMonitorInfoW(HMONITOR(hmonitor as *mut _), &mut info as *mut MONITORINFOEXW as *mut MONITORINFO)
        };
        if !ok.as_bool() {
            return None;
        }
        let n = info.szDevice.iter().position(|c| *c == 0).unwrap_or(info.szDevice.len());
        Some(String::from_utf16_lossy(&info.szDevice[..n]))
    }

    /// Every ACTIVE display path: its GDI source name, its target adapter's
    /// interface path, and whether the target is a built-in panel.
    fn display_paths() -> Vec<DisplayPath> {
        use windows::Win32::Devices::Display::{
            DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
            DISPLAYCONFIG_ADAPTER_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_ADAPTER_NAME,
            DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_HEADER,
            DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
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
            let text = |w: &[u16]| {
                let n = w.iter().position(|c| *c == 0).unwrap_or(w.len());
                String::from_utf16_lossy(&w[..n])
            };
            for p in &paths {
                let mut adapter = DISPLAYCONFIG_ADAPTER_NAME {
                    header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                        r#type: DISPLAYCONFIG_DEVICE_INFO_GET_ADAPTER_NAME,
                        size: std::mem::size_of::<DISPLAYCONFIG_ADAPTER_NAME>() as u32,
                        adapterId: p.targetInfo.adapterId,
                        id: 0,
                    },
                    ..Default::default()
                };
                let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                    header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                        r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                        size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                        adapterId: p.sourceInfo.adapterId,
                        id: p.sourceInfo.id,
                    },
                    ..Default::default()
                };
                let adapter_path = if DisplayConfigGetDeviceInfo(&mut adapter.header) == ERROR_SUCCESS.0 as i32 {
                    text(&adapter.adapterDevicePath)
                } else {
                    String::new()
                };
                let gdi_name = if DisplayConfigGetDeviceInfo(&mut source.header) == ERROR_SUCCESS.0 as i32 {
                    text(&source.viewGdiDeviceName)
                } else {
                    String::new()
                };
                out.push(DisplayPath {
                    gdi_name,
                    adapter_path,
                    builtin: is_builtin_technology(p.targetInfo.outputTechnology.0),
                });
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
        assert_eq!(decide(&Prep::new(now), now, true, false), (ScreenState::Ready, Action::None));
    }

    #[test]
    fn no_screen_first_wakes_the_displays_then_waits_the_grace() {
        let now = t0();
        let mut p = Prep::new(now);
        assert_eq!(decide(&p, now, false, false), (ScreenState::Waking, Action::Nudge));
        p.nudged = true;
        assert_eq!(decide(&p, now + Duration::from_secs(1), false, false), (ScreenState::Waking, Action::None));
        // A panel that wakes inside the grace is simply ready.
        assert_eq!(decide(&p, now + Duration::from_secs(2), true, false).0, ScreenState::Ready);
    }

    #[test]
    fn still_no_screen_after_the_grace_asks_for_the_virtual_screen_once() {
        let now = t0();
        let mut p = Prep::new(now);
        p.nudged = true;
        assert_eq!(decide(&p, now + WAKE_GRACE, false, false), (ScreenState::Starting, Action::AskForVirtual));
        p.asked = Some((now + WAKE_GRACE, on()));
        // Asked once: from here only the clock moves it.
        assert_eq!(decide(&p, now + WAKE_GRACE + Duration::from_secs(1), false, false), (ScreenState::Starting, Action::None));
        // The virtual screen appearing is "ready".
        assert_eq!(decide(&p, now + WAKE_GRACE + Duration::from_secs(4), true, false).0, ScreenState::Ready);
    }

    #[test]
    fn a_virtual_screen_that_never_appears_is_a_named_failure_not_a_wait_for_ever() {
        let now = t0();
        let mut p = Prep::new(now);
        p.nudged = true;
        p.asked = Some((now, on()));
        assert_eq!(decide(&p, now + VIRTUAL_START_WINDOW - Duration::from_millis(1), false, false).0, ScreenState::Starting);
        assert_eq!(
            decide(&p, now + VIRTUAL_START_WINDOW, false, false).0,
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
        assert_eq!(decide(&p, now + WAKE_WINDOW - Duration::from_millis(1), false, false).0, ScreenState::Waking);
        assert_eq!(decide(&p, now + WAKE_WINDOW, false, false).0, ScreenState::Off(OffReason::NoVirtualScreen));
        // ...and a panel waking at the last moment still wins.
        assert_eq!(decide(&p, now + WAKE_WINDOW, true, false).0, ScreenState::Ready);
    }

    #[test]
    fn a_closed_lid_asks_for_the_virtual_screen_at_once_and_says_off_at_once_without_one() {
        // THE 0.9.842 CASE. The panel behind the lid will not wake, so neither
        // the wake grace nor the wake window is waited out.
        let now = t0();
        let p = Prep::new(now);
        assert_eq!(decide(&p, now, false, true), (ScreenState::Starting, Action::AskForVirtual));
        let mut asked = Prep::new(now);
        asked.asked = Some((now, service_absent()));
        assert_eq!(decide(&asked, now, false, true).0, ScreenState::Off(OffReason::NoVirtualScreen));
        // Negative control: the same moment for a SLEEPING monitor (not the
        // lid) still waits, nudges first, and keeps its wake window.
        assert_eq!(decide(&p, now, false, false), (ScreenState::Waking, Action::Nudge));
        assert_eq!(decide(&asked, now, false, false).0, ScreenState::Waking);
        // And the virtual screen appearing is ready either way.
        assert_eq!(decide(&asked, now, true, true).0, ScreenState::Ready);
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
        for code in [NO_SCREEN_LID, NO_SCREEN_VIRTUAL_FAILED, NO_SCREEN_CHANGED] {
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

    fn path(gdi: &str, adapter: &str, builtin: bool) -> DisplayPath {
        DisplayPath { gdi_name: gdi.into(), adapter_path: adapter.into(), builtin }
    }

    fn virt() -> DisplayPath {
        path(r"\\.\DISPLAY2", r"\\?\ROOT#DISPLAY#0001#{g}", false)
    }

    fn panel() -> DisplayPath {
        path(r"\\.\DISPLAY1", r"\\?\PCI#VEN_10DE&DEV_1C20#4&1#{g}", true)
    }

    #[test]
    fn a_real_screen_is_only_reported_when_the_virtual_one_is_recognised_too() {
        let id = r"ROOT\DISPLAY\0001";
        // No panel at all, virtual screen on: no real screen.
        assert_eq!(real_screen_present(&[virt()], id, Some(true)), Some(false));
        // An external monitor beside it is real whatever the lid says.
        let hdmi = path(r"\\.\DISPLAY3", r"\\?\PCI#VEN_10DE#4&1#{g}", false);
        assert_eq!(real_screen_present(&[hdmi, virt()], id, Some(true)), Some(true));
        // THE POSITIVE CONTROL: the virtual screen is not among the active
        // paths (not up yet, or the matcher is wrong for this machine). Then
        // nothing is claimed, so the hold is not dropped on a guess.
        assert_eq!(real_screen_present(&[panel()], id, Some(false)), None);
        assert_eq!(real_screen_present(&[], id, Some(false)), None);
    }

    #[test]
    fn the_dark_panel_beside_the_virtual_screen_is_not_a_real_screen_until_the_lid_opens() {
        // THE 0.9.842 FIELD CASE: lid shut, the built-in panel still an active
        // path. Counting it as real would let the virtual screen go the moment
        // it appeared.
        let id = r"ROOT\DISPLAY\0001";
        assert_eq!(real_screen_present(&[panel(), virt()], id, Some(true)), Some(false));
        // The lid opening is what makes the panel real again.
        assert_eq!(real_screen_present(&[panel(), virt()], id, Some(false)), Some(true));
        // An unknown lid is not "closed": the panel counts, as it always did.
        assert_eq!(real_screen_present(&[panel(), virt()], id, None), Some(true));
    }

    #[test]
    fn a_built_in_panel_behind_a_closed_lid_is_dark_and_nothing_else_is() {
        let outputs = vec![(0, r"\\.\DISPLAY1".to_string()), (1, r"\\.\DISPLAY3".to_string())];
        let hdmi = path(r"\\.\DISPLAY3", r"\\?\PCI#VEN_10DE#4&1#{g}", false);
        let paths = vec![panel(), hdmi];
        assert_eq!(dark_outputs(&outputs, &paths, Some(true)), vec![0]);
        // Negative controls: lid open, lid unknown.
        assert!(dark_outputs(&outputs, &paths, Some(false)).is_empty());
        assert!(dark_outputs(&outputs, &paths, None).is_empty());
        // GDI names compare case-insensitively, as Windows treats them.
        let lower = vec![(0, r"\\.\display1".to_string())];
        assert_eq!(dark_outputs(&lower, &paths, Some(true)), vec![0]);
        // An output no path names is never called dark.
        let unnamed = vec![(5, r"\\.\DISPLAY9".to_string())];
        assert!(dark_outputs(&unnamed, &paths, Some(true)).is_empty());
    }

    #[test]
    fn only_built_in_link_types_count_as_built_in() {
        // eDP (the owner's laptop reports 11), LVDS, UDI embedded, INTERNAL.
        for t in [11, 6, 13, i32::MIN] {
            assert!(is_builtin_technology(t), "{t}");
        }
        // HDMI, external DisplayPort, DVI, the indirect (virtual) kinds, other.
        for t in [5, 10, 4, 16, 17, -1, 0] {
            assert!(!is_builtin_technology(t), "{t}");
        }
    }

    #[test]
    fn a_pc_whose_only_screen_is_dark_has_no_screen() {
        assert!(!any_lit(&[0], &[0]), "the 0.9.842 case: one output, and it is the dark panel");
        assert!(any_lit(&[0, 1], &[0]), "the virtual screen (or a monitor) beside it is lit");
        assert!(any_lit(&[0], &[]), "lid open: the panel is lit");
        assert!(!any_lit(&[], &[]), "no outputs at all is still no screen");
    }

    #[test]
    fn capture_moves_off_the_dark_panel_only_when_something_else_is_lit() {
        const ALL: usize = 255;
        // The panel (0) dark, the virtual screen (1) lit.
        assert_eq!(steer_monitor(0, &[0, 1], &[0], ALL), 1);
        assert_eq!(steer_monitor(ALL, &[0, 1], &[0], ALL), 1, "a composite with one lit tile is that tile");
        assert_eq!(steer_monitor(1, &[0, 1], &[0], ALL), 1, "already on a lit screen");
        // Two lit screens beside the dark one: All Displays stays All Displays.
        assert_eq!(steer_monitor(ALL, &[0, 1, 2], &[0], ALL), ALL);
        // Negative controls: nothing dark, or nothing lit to move to.
        assert_eq!(steer_monitor(0, &[0, 1], &[], ALL), 0);
        assert_eq!(steer_monitor(0, &[0], &[0], ALL), 0);
    }

    // ---- the lid shut mid-session ------------------------------------------

    const ALL: usize = 255;
    const MS: Duration = Duration::from_millis(1);

    /// Displays for the tests: outputs, dark, built in, virtual screen.
    fn ds(outputs: &[usize], dark: &[usize], builtin: &[usize], virt: &[usize]) -> Displays {
        Displays {
            outputs: outputs.to_vec(),
            dark: dark.to_vec(),
            builtin: builtin.to_vec(),
            virtual_screen: virt.to_vec(),
            handles: Vec::new(),
        }
    }

    /// The same, with each output's handle: output i has handle `h[i]`.
    fn dsh(outputs: &[usize], dark: &[usize], builtin: &[usize], virt: &[usize], h: &[isize]) -> Displays {
        Displays { handles: outputs.iter().copied().zip(h.iter().copied()).collect(), ..ds(outputs, dark, builtin, virt) }
    }

    /// THE 2026-10-26 FIELD CASE. Streaming the built-in panel (0), the lid
    /// shuts: with nothing else lit the stream needs a screen, as a start
    /// would; once the virtual screen (1) is lit it moves there.
    #[test]
    fn a_lid_shut_on_the_panel_a_stream_shows_gets_it_a_screen_and_moves_there() {
        assert_eq!(lid_step(None, 0, &ds(&[0], &[0], &[0], &[]), Some(true), true, &[], ALL), LidStep::NeedScreen);
        assert_eq!(lid_step(None, 0, &ds(&[0, 1], &[0], &[0], &[1]), Some(true), true, &[], ALL), LidStep::MoveTo(1));
        // An external monitor lit beside the panel is moved to at once, the
        // rule a start applies.
        assert_eq!(lid_step(None, 0, &ds(&[0, 2], &[0], &[0], &[]), Some(true), true, &[], ALL), LidStep::MoveTo(2));
    }

    /// REVIEW FINDING 2. A lid that takes the panel out of the desktop, with
    /// nothing else on, leaves NO output at all: the case this file's header
    /// began with. Nothing is lit, so the stream needs a screen, as a start
    /// would (wake, then the virtual screen). It used to stay, and once the
    /// topology rebuild had failed it held a frozen picture for ever.
    #[test]
    fn a_lid_shut_that_leaves_no_output_at_all_needs_a_screen() {
        let none = ds(&[], &[], &[], &[]);
        assert_eq!(lid_step(None, 0, &none, Some(true), false, &[], ALL), LidStep::NeedScreen);
        assert_eq!(lid_step(None, ALL, &none, Some(true), false, &[], ALL), LidStep::NeedScreen);
        // The screen it showed is gone and another is lit: there.
        assert_eq!(lid_step(None, 0, &ds(&[1], &[], &[], &[1]), Some(true), false, &[], ALL), LidStep::MoveTo(1));
        // The virtual screen came up at the panel's index while the capture
        // was lost: rebuild the capture there.
        let virt_at_0 = ds(&[0], &[], &[], &[0]);
        assert_eq!(lid_step(None, 0, &virt_at_0, Some(true), false, &[], ALL), LidStep::MoveTo(0));
        // CONTROL: the same with a working capture is nothing to do.
        assert_eq!(lid_step(None, 0, &virt_at_0, Some(true), true, &[], ALL), LidStep::Stay);
    }

    /// NEGATIVE CONTROLS: the lid changes nothing for a stream it does not
    /// darken, whether or not it moved the stream before.
    #[test]
    fn a_lid_shut_while_an_external_monitor_is_shown_changes_nothing() {
        let shut = ds(&[0, 1], &[0], &[0], &[]);
        // The panel (0) is dark, the stream shows the external monitor (1).
        assert_eq!(lid_step(None, 1, &shut, Some(true), true, &[], ALL), LidStep::Stay);
        assert_eq!(lid_step(Some(Asked::Panel(0)), 1, &shut, Some(true), true, &[], ALL), LidStep::Stay);
        assert_eq!(lid_step(Some(Asked::AllDisplays), 1, &shut, Some(true), true, &[], ALL), LidStep::Stay);
        // The virtual screen took the panel's index (the panel left the
        // desktop): nothing is dark, nothing to do.
        let virt_at_0 = ds(&[0], &[], &[], &[0]);
        assert_eq!(lid_step(None, 0, &virt_at_0, Some(true), true, &[], ALL), LidStep::Stay);
        assert_eq!(lid_step(Some(Asked::Panel(0)), 0, &virt_at_0, Some(true), true, &[], ALL), LidStep::Stay);
        // The lid open, and nothing was moved for it.
        assert_eq!(lid_step(None, 0, &ds(&[0, 1], &[], &[0], &[]), Some(false), true, &[], ALL), LidStep::Stay);
    }

    /// REVIEW FINDING 3. On a DESKTOP, a stream the agent retargeted after a
    /// monitor detached (1 -> 0) moved itself back to 1 once the monitor
    /// returned, logging "the lid is open again" and contradicting the screen
    /// the host had announced. A rebuild the lid did not make remembers
    /// nothing, a stream with no lid never moves, and its watch never looks.
    #[test]
    fn a_desktop_never_moves_the_picture_on_its_own() {
        assert_eq!(after_other_rebuild(None, 0, &ds(&[0], &[], &[], &[]), ALL), None);
        for asked in [None, Some(Asked::Panel(1)), Some(Asked::AllDisplays)] {
            for capture_ok in [true, false] {
                assert_eq!(
                    lid_step(asked, 0, &ds(&[0, 1], &[], &[], &[]), None, capture_ok, &[], ALL),
                    LidStep::Stay,
                    "{asked:?}, capture {capture_ok}",
                );
            }
        }
        let t = t0();
        let mut desk = LidWatch::new(t, None, None);
        desk.asked = Some(Asked::Panel(1));
        desk.on_virtual = true;
        desk.note_capture(false, t);
        assert!(!desk.due(t + Duration::from_secs(60)), "a desktop's watch never looks");
        // CONTROL: the same on a laptop with its lid open does look, to go back.
        let mut lap = LidWatch::new(t, Some(false), None);
        lap.asked = Some(Asked::Panel(1));
        assert!(lap.due(t + Duration::from_secs(60)));
    }

    /// All Displays follows the start's rule too: one lit screen left
    /// becomes that screen; two lit stay All Displays; none lit needs a
    /// screen.
    #[test]
    fn all_displays_with_the_panel_dark_follows_the_start_rule() {
        assert_eq!(lid_step(None, ALL, &ds(&[0, 1], &[0], &[0], &[]), Some(true), true, &[], ALL), LidStep::MoveTo(1));
        assert_eq!(lid_step(None, ALL, &ds(&[0, 1, 2], &[0], &[0], &[]), Some(true), true, &[], ALL), LidStep::Stay);
        assert_eq!(lid_step(None, ALL, &ds(&[0], &[0], &[0], &[]), Some(true), true, &[], ALL), LidStep::NeedScreen);
    }

    /// REVIEW FINDING 3, the return. The lid opens: back to the built-in
    /// panel, found by WHAT IT IS. By index, a panel that came back at
    /// another index was missed, or another screen at the old index was taken.
    #[test]
    fn the_lid_opening_takes_the_picture_back_to_the_panel_wherever_it_is() {
        let asked = Some(Asked::Panel(0));
        // The panel was 0; it came back at 2, beside the virtual screen (1).
        let back = ds(&[1, 2], &[], &[2], &[1]);
        assert_eq!(lid_step(asked, 1, &back, Some(false), true, &[], ALL), LidStep::MoveTo(2));
        // Index 0 is an external monitor now: not the panel, not the target.
        let shuffled = ds(&[0, 1, 2], &[], &[2], &[1]);
        assert_eq!(lid_step(asked, 1, &shuffled, Some(false), true, &[], ALL), LidStep::MoveTo(2));
        // At its old index: there.
        assert_eq!(lid_step(asked, 1, &ds(&[0, 1], &[], &[0], &[1]), Some(false), true, &[], ALL), LidStep::MoveTo(0));
        // Not back yet, and nothing real lit: wait.
        assert_eq!(lid_step(asked, 1, &ds(&[1], &[], &[], &[1]), Some(false), true, &[], ALL), LidStep::Stay);
        // Already on it: nothing to do, and it is what was asked for.
        assert_eq!(lid_step(asked, 2, &back, Some(false), true, &[], ALL), LidStep::Stay);
        assert!(Asked::Panel(0).reached(2, &back, ALL));
        // All Displays can always be rebuilt.
        let open = ds(&[0, 1], &[], &[0], &[1]);
        assert_eq!(lid_step(Some(Asked::AllDisplays), 1, &open, Some(false), true, &[], ALL), LidStep::MoveTo(ALL));
        // CONTROL: the lid still closed, the moved stream stays where it is lit.
        assert_eq!(lid_step(asked, 1, &ds(&[0, 1], &[0], &[0], &[1]), Some(true), true, &[], ALL), LidStep::Stay);
    }

    /// REVIEW POINT 7 (the external monitor). With the lid still shut, a
    /// monitor plugged in makes the holder let the virtual screen go, and a
    /// stream on it was left on a screen being switched off. It moves to the
    /// real screen first. With the lid open, a stream on the virtual screen
    /// that the lid never moved (it took the panel's index) leaves it too.
    #[test]
    fn a_stream_on_the_virtual_screen_leaves_it_for_a_real_screen() {
        let plugged = ds(&[0, 1, 2], &[0], &[0], &[1]);
        assert_eq!(lid_step(Some(Asked::Panel(0)), 1, &plugged, Some(true), true, &[], ALL), LidStep::MoveTo(2));
        assert_eq!(lid_step(None, 0, &ds(&[0, 1], &[], &[1], &[0]), Some(false), true, &[], ALL), LidStep::MoveTo(1));
        // CONTROL: nothing real lit, it stays on the virtual screen.
        assert_eq!(lid_step(Some(Asked::Panel(0)), 1, &ds(&[0, 1], &[0], &[0], &[1]), Some(true), true, &[], ALL), LidStep::Stay);
    }

    /// REVIEW FINDING 4. A move took the first lit screen without asking
    /// whether another session's stream held it, or whether it had just
    /// refused a move. Those are passed over: another lit screen, or none.
    #[test]
    fn a_move_never_takes_a_screen_it_must_avoid() {
        let d = ds(&[0, 1, 2], &[0], &[0], &[]);
        assert_eq!(lid_step(None, 0, &d, Some(true), true, &[1], ALL), LidStep::MoveTo(2));
        assert_eq!(lid_step(None, 0, &d, Some(true), true, &[1, 2], ALL), LidStep::NeedScreen);
        // The way back avoids it too.
        assert_eq!(lid_step(Some(Asked::Panel(0)), 1, &ds(&[0, 1], &[], &[0], &[1]), Some(false), true, &[0], ALL), LidStep::Stay);
        // CONTROL: nothing to avoid, the first lit.
        assert_eq!(lid_step(None, 0, &d, Some(true), true, &[], ALL), LidStep::MoveTo(1));
    }

    #[test]
    fn what_the_lid_asked_for_survives_its_moves_until_the_stream_is_back_on_it() {
        let shut = ds(&[0, 1, 2], &[0], &[0], &[1]);
        assert_eq!(after_lid_move(None, 0, 1, &shut, true, false, ALL), Some(Asked::Panel(0)));
        assert_eq!(after_lid_move(Some(Asked::Panel(0)), 1, 2, &shut, true, false, ALL), Some(Asked::Panel(0)));
        // Back on a built-in panel, whatever its index: forgotten.
        let open = ds(&[1, 3], &[], &[3], &[1]);
        assert_eq!(after_lid_move(Some(Asked::Panel(0)), 1, 3, &open, false, false, ALL), None);
        assert_eq!(after_lid_move(None, ALL, 1, &shut, true, false, ALL), Some(Asked::AllDisplays));
        assert_eq!(after_lid_move(Some(Asked::AllDisplays), 1, ALL, &open, false, false, ALL), None);
        // The panel the stream showed is gone (the lid took it out of the
        // desktop): leaving it is leaving the panel.
        let gone = ds(&[1], &[], &[], &[1]);
        assert_eq!(after_lid_move(None, 0, 1, &gone, true, false, ALL), Some(Asked::Panel(0)));
        // Any other rebuild keeps it, unless it lands back on it.
        assert_eq!(after_other_rebuild(Some(Asked::Panel(0)), 2, &shut, ALL), Some(Asked::Panel(0)));
        assert_eq!(after_other_rebuild(Some(Asked::Panel(0)), 3, &open, ALL), None);
        // With no path facts at all, the index is the one thing to go by.
        assert!(Asked::Panel(0).reached(0, &ds(&[0], &[], &[], &[]), ALL));
        assert!(!Asked::Panel(0).reached(1, &ds(&[0, 1], &[], &[], &[]), ALL));
    }

    /// A lid move begins an ask only when it leaves what the lid took. An
    /// external monitor whose capture was rebuilt during the lid's change,
    /// recorded as "the panel", was left for the panel when the lid opened.
    #[test]
    fn only_leaving_what_the_lid_took_is_remembered() {
        let shut = ds(&[0, 1, 2], &[0], &[0], &[1]);
        // The external monitor (2), rebuilt where it is, or found again at a
        // new index (the same screen): nothing to go back to.
        assert_eq!(after_lid_move(None, 2, 2, &shut, true, false, ALL), None);
        assert_eq!(after_lid_move(None, 3, 2, &shut, true, true, ALL), None);
        // Off the virtual screen onto a real one: the lid asked for nothing.
        assert_eq!(after_lid_move(None, 1, 2, &shut, true, false, ALL), None);
        // With the lid open nothing new is asked for.
        assert_eq!(after_lid_move(None, 1, 2, &ds(&[0, 1, 2], &[], &[0], &[1]), false, false, ALL), None);
        // CONTROL: off the dark panel it is.
        assert_eq!(after_lid_move(None, 0, 2, &shut, true, false, ALL), Some(Asked::Panel(0)));
    }

    /// All Displays opens every output: never rebuilt, or gone back to, while
    /// one is another session's or refused a move.
    #[test]
    fn all_displays_is_not_rebuilt_over_a_screen_it_must_avoid() {
        let open = ds(&[0, 1], &[], &[0], &[]);
        assert_eq!(lid_step(Some(Asked::AllDisplays), 1, &open, Some(false), true, &[0], ALL), LidStep::Stay);
        assert_eq!(lid_step(Some(Asked::AllDisplays), 1, &open, Some(false), true, &[ALL], ALL), LidStep::Stay);
        let lit2 = ds(&[0, 1, 2], &[0], &[0], &[]);
        assert_eq!(lid_step(None, ALL, &lit2, Some(true), false, &[2], ALL), LidStep::MoveTo(1));
        assert_eq!(lid_step(None, ALL, &lit2, Some(true), false, &[1, 2], ALL), LidStep::NeedScreen);
        // CONTROLS: nothing to avoid, it is.
        assert_eq!(lid_step(Some(Asked::AllDisplays), 1, &open, Some(false), true, &[], ALL), LidStep::MoveTo(ALL));
        assert_eq!(lid_step(None, ALL, &lit2, Some(true), false, &[], ALL), LidStep::MoveTo(ALL));
        assert_eq!(lid_step(None, ALL, &open, Some(false), false, &[], ALL), LidStep::MoveTo(ALL));
    }

    /// Giving up with the lid open forgets what was asked for and rests the
    /// watch until the lid changes: a stream left on the virtual screen used
    /// to be looked at, and moved, every half second for ever.
    #[test]
    fn giving_up_with_the_lid_open_rests_until_the_lid_changes() {
        let t = t0();
        let mut w = LidWatch::new(t, Some(false), Some(Asked::Panel(0)));
        w.on_virtual = true;
        assert!(w.due(t + LID_SETTLE));
        w.give_up();
        assert_eq!(w.asked, None);
        assert!(!w.due(t + Duration::from_secs(60)));
        w.observe(Some(true), t + Duration::from_secs(61));
        assert!(w.due(t + Duration::from_secs(61) + LID_SETTLE), "a new situation");
    }

    /// A screen on its way restarts the capture-loss clock: the virtual
    /// screen's start, after the displays' wake, can take longer than the
    /// grace from the moment the capture was lost.
    #[test]
    fn a_screen_on_its_way_holds_the_capture_loss_clock() {
        let t = t0();
        let mut w = LidWatch::new(t, Some(false), None);
        w.observe(Some(true), t);
        w.note_capture(false, t);
        w.screen_coming(t + Duration::from_secs(15));
        assert!(!w.capture_lost_too_long(t + LID_TRANSITION_GRACE));
        assert!(w.capture_lost_too_long(t + Duration::from_secs(15) + LID_TRANSITION_GRACE));
        // CONTROL: with no capture lost there is no clock to start.
        let mut calm = LidWatch::new(t, Some(true), None);
        calm.screen_coming(t);
        assert!(!calm.capture_lost_too_long(t + Duration::from_secs(600)));
    }

    /// The watch looks only once the lid has settled, so a bounce moves
    /// nothing; looks again on its slow clock while the lid stays shut, and
    /// soon while it shows the virtual screen; and waits while something is
    /// in flight.
    #[test]
    fn the_watch_looks_once_the_lid_settles_and_not_while_waiting() {
        let t = t0();
        let mut w = LidWatch::new(t, Some(false), None);
        assert!(!w.due(t + Duration::from_secs(5)), "open, and nothing moved: never a look");
        // A bounce: closed, open again 300 ms later.
        assert!(w.observe(Some(true), t + Duration::from_secs(10)));
        assert!(!w.observe(Some(true), t + Duration::from_millis(10_100)), "no change, no news");
        assert!(w.observe(Some(false), t + Duration::from_millis(10_300)));
        assert!(!w.due(t + Duration::from_secs(12)), "the bounce settled open: nothing to look at");
        // Shut for real.
        let shut = t + Duration::from_secs(20);
        w.observe(Some(true), shut);
        assert!(!w.due(shut + LID_SETTLE - MS), "not before it settles");
        assert!(w.due(shut + LID_SETTLE));
        // Something sent: no new look until it lands.
        w.acted(shut + LID_SETTLE, Flight::Move);
        assert!(!w.due(shut + Duration::from_secs(5)));
        w.landed(shut + Duration::from_secs(5), LID_POLL);
        assert!(!w.due(shut + Duration::from_secs(5)));
        assert!(w.due(shut + Duration::from_secs(5) + LID_POLL));
        // Nothing to do: the slow clock, or the quick one on the virtual screen.
        w.idle(shut + Duration::from_secs(11));
        assert!(!w.due(shut + Duration::from_secs(12)));
        assert!(w.due(shut + Duration::from_secs(11) + LID_RECHECK));
        w.on_virtual = true;
        w.idle(shut + Duration::from_secs(14));
        assert!(w.due(shut + Duration::from_secs(14) + LID_POLL));
        w.on_virtual = false;
        // Open again with the stream moved: a look, to go back.
        w.asked = Some(Asked::Panel(0));
        let open = shut + Duration::from_secs(30);
        w.observe(Some(false), open);
        assert!(w.due(open + LID_SETTLE));
        // Something that lands right after a change and asks for a look at
        // once (a screen became ready) still waits for the lid to settle.
        w.acted(open + LID_SETTLE, Flight::Prepare);
        let again = open + Duration::from_secs(5);
        w.observe(Some(true), again);
        w.landed(again + Duration::from_millis(100), Duration::ZERO);
        assert!(!w.due(again + Duration::from_millis(100)), "not on an unsettled lid");
        assert!(w.due(again + LID_SETTLE));
    }

    /// REVIEW FINDING 4, the retries. A move that kept failing retried every
    /// half second for ever, each try three builds and a 250 ms sleep on the
    /// stream thread. It now waits 1 s, 2 s, 4 s between tries, passes the
    /// refusing screen over for `LID_AVOID_FOR`, and says when to give up.
    #[test]
    fn a_failing_move_backs_off_passes_the_screen_over_and_gives_up() {
        let t = t0();
        let mut w = LidWatch::new(t, Some(true), None);
        let mut at = t + LID_SETTLE;
        for n in 1..=LID_MOVE_ATTEMPTS {
            assert!(w.due(at), "try {n} is due");
            w.acted(at, Flight::Move);
            let last = w.move_failed(1, at);
            assert_eq!(last, n == LID_MOVE_ATTEMPTS, "try {n}");
            assert!(w.refused(at).contains(&1));
            let wait = LID_POLL * 2u32.pow(n);
            assert!(!w.due(at + wait - MS), "try {n}: waits {wait:?}");
            at += wait;
        }
        assert!(w.refused(at + LID_AVOID_FOR).is_empty(), "passed over for a while, not for ever");
        // A move that lands, or the lid changing, forgives.
        w.moved(at);
        assert_eq!(w.failures(), 0);
        assert!(w.refused(at).is_empty());
        w.move_failed(2, at);
        w.observe(Some(false), at + Duration::from_secs(1));
        assert_eq!(w.failures(), 0);
    }

    /// REVIEW POINT 7 (the bound). The ride-out was unbounded while a request
    /// for a screen was in flight, and the service exchange behind it has no
    /// timeout. Past its limit, what is in flight is lost: no ride-out, and
    /// the stream gives it up.
    #[test]
    fn what_is_in_flight_is_given_up_past_its_limit() {
        let t = t0();
        let mut w = LidWatch::new(t, Some(true), None);
        w.acted(t, Flight::Prepare);
        assert_eq!(w.flight_expired(t + LID_PREPARE_LIMIT - MS), None);
        assert!(w.rides_out_capture_loss(t + LID_PREPARE_LIMIT - MS));
        let late = t + LID_PREPARE_LIMIT + LID_TRANSITION_GRACE;
        assert_eq!(w.flight_expired(late), Some(Flight::Prepare));
        assert!(!w.rides_out_capture_loss(late), "a hung request holds nothing for ever");
        let mut m = LidWatch::new(t, Some(true), None);
        m.acted(t, Flight::Move);
        assert_eq!(m.flight_expired(t + LID_MOVE_LIMIT), Some(Flight::Move));
    }

    /// REVIEW FINDING 2, the bound. A capture lost while the lid changed the
    /// displays, with nothing to bring it back, held a frozen picture for
    /// ever once the topology rebuild had failed: no capture, no pump, no
    /// bound. It ends after the grace.
    #[test]
    fn a_capture_lost_while_the_lid_changed_ends_after_the_grace() {
        let t = t0();
        let mut w = LidWatch::new(t, Some(false), None);
        w.observe(Some(true), t);
        let lost = t + Duration::from_secs(1);
        w.note_capture(false, lost);
        assert!(!w.capture_lost_too_long(lost + LID_TRANSITION_GRACE - MS));
        assert!(w.capture_lost_too_long(lost + LID_TRANSITION_GRACE));
        // Not while something is in flight that can bring it back.
        w.acted(lost + LID_TRANSITION_GRACE, Flight::Prepare);
        assert!(!w.capture_lost_too_long(lost + LID_TRANSITION_GRACE));
        // A working capture stops the clock.
        w.landed(lost + LID_TRANSITION_GRACE, LID_POLL);
        w.note_capture(true, lost + LID_TRANSITION_GRACE);
        assert!(!w.capture_lost_too_long(lost + Duration::from_secs(600)));
        // CONTROL: a capture lost with the lid nowhere near (a monitor asleep)
        // starts no clock: the stream waits for the screen, as it always has.
        let mut calm = LidWatch::new(t, Some(false), None);
        calm.note_capture(false, t + Duration::from_secs(60));
        assert!(!calm.capture_lost_too_long(t + Duration::from_secs(600)));
    }

    /// A capture that fails is ridden out only around the lid: within the
    /// grace of its change or of the stream acting on it, or while something
    /// sent is within its limit. NEGATIVE CONTROL: with the lid nowhere
    /// near, a failed capture ends the stream exactly as before.
    #[test]
    fn a_failed_capture_is_ridden_out_only_around_the_lid() {
        let t = t0();
        let mut w = LidWatch::new(t, Some(false), None);
        assert!(!w.rides_out_capture_loss(t + Duration::from_secs(1)), "no lid change: not ridden out");
        w.observe(Some(true), t + Duration::from_secs(5));
        assert!(w.rides_out_capture_loss(t + Duration::from_secs(6)));
        assert!(!w.rides_out_capture_loss(t + Duration::from_secs(5) + LID_TRANSITION_GRACE));
        w.acted(t + Duration::from_secs(40), Flight::Move);
        assert!(w.rides_out_capture_loss(t + Duration::from_secs(40) + LID_MOVE_LIMIT - MS), "in flight");
        w.landed(t + Duration::from_secs(45), LID_POLL);
        assert!(!w.rides_out_capture_loss(t + Duration::from_secs(40) + LID_TRANSITION_GRACE));
    }

    // ---- a stream pinned to its screen (`steer_on_lid` off) -------------------

    const PANEL: isize = 0x10;
    const EXTERNAL: isize = 0x20;
    const VIRTUAL: isize = 0x30;

    /// THE PRIVACY CASE (review of the frontend branch). The person at the
    /// host shares only the built-in display; the lid shuts with an external
    /// monitor lit. Unless the host app lets the stream steer, it ends with
    /// the lid's code and is NEVER rebuilt onto the external monitor, which
    /// nobody shared. Allowed to steer, it moves there, as before.
    #[test]
    fn a_stream_the_host_did_not_let_steer_ends_rather_than_show_another_screen() {
        // The panel stays an active output, dark behind the lid.
        let dark = dsh(&[0, 1], &[0], &[0], &[], &[PANEL, EXTERNAL]);
        let pinned = lid_action(false, None, 0, Some(PANEL), &dark, Some(true), true, &[], ALL);
        assert_eq!(pinned, LidAction::End);
        assert_eq!(lid_end(false).code(), NO_SCREEN_LID);
        // The panel leaves the desktop and the external monitor is renumbered
        // into its index: still not the stream's screen.
        let left = dsh(&[0], &[], &[], &[], &[EXTERNAL]);
        for capture_ok in [true, false] {
            assert_eq!(lid_action(false, None, 0, Some(PANEL), &left, Some(true), capture_ok, &[], ALL), LidAction::End);
        }
        // No virtual screen either: nothing lit is still the end, not a request.
        let none = dsh(&[0], &[0], &[0], &[], &[PANEL]);
        assert_eq!(lid_action(false, None, 0, Some(PANEL), &none, Some(true), true, &[], ALL), LidAction::End);
        // CONTROL: a host app that follows moves lets it steer.
        assert_eq!(lid_action(true, None, 0, Some(PANEL), &dark, Some(true), true, &[], ALL), LidAction::MoveTo(1));
        assert_eq!(lid_action(true, None, 0, Some(PANEL), &none, Some(true), true, &[], ALL), LidAction::NeedScreen);
    }

    /// REVIEW, ROUND 3. Pinned, a stream keeps ITS screen at ITS index, and
    /// nothing else: not its own screen renumbered to another index (the host
    /// app's consent is by index, and a stream that followed it there was
    /// ended as a screen nobody shared), not a screen that took its index, not
    /// one whose handle is not known. It is rebuilt in place when its capture
    /// is lost, and a renumbering that leaves its screen where it was (a dock)
    /// changes nothing.
    #[test]
    fn a_pinned_stream_keeps_its_own_screen_at_its_own_index_or_ends() {
        // Showing the external monitor (1) when the lid shuts: nothing to do.
        let dark = dsh(&[0, 1], &[0], &[0], &[], &[PANEL, EXTERNAL]);
        assert_eq!(pinned_step(1, Some(EXTERNAL), &dark, Some(true), true, ALL), PinnedStep::Stay);
        // Its capture lost: rebuilt where it is.
        assert_eq!(pinned_step(1, Some(EXTERNAL), &dark, Some(true), false, ALL), PinnedStep::Rebuild(1));
        // DOCKED: a screen added after it renumbers nothing it shows.
        let added = dsh(&[0, 1, 2], &[0], &[0], &[], &[PANEL, EXTERNAL, 0x40]);
        assert_eq!(pinned_step(1, Some(EXTERNAL), &added, Some(true), true, ALL), PinnedStep::Stay);
        // The panel left and the external monitor is index 0 now: NOT
        // followed there, and nothing at index 1 is the stream's.
        let left = dsh(&[0], &[], &[], &[], &[EXTERNAL]);
        for capture_ok in [true, false] {
            assert_eq!(pinned_step(1, Some(EXTERNAL), &left, Some(true), capture_ok, ALL), PinnedStep::End);
        }
        // The lid opens and the panel comes back at 0, the external at 1:
        // index 0 is the panel now.
        let back = dsh(&[0, 1], &[], &[0], &[], &[PANEL, EXTERNAL]);
        assert_eq!(pinned_step(0, Some(EXTERNAL), &back, Some(false), true, ALL), PinnedStep::End);
        // Started on the virtual screen; the lid opens and the screen goes:
        // the stream does not take the panel.
        assert_eq!(pinned_step(1, Some(VIRTUAL), &dsh(&[0], &[], &[0], &[], &[PANEL]), Some(false), false, ALL), PinnedStep::End);
        // No handle known: nothing to prove the screen by.
        assert_eq!(pinned_step(1, None, &dark, Some(true), true, ALL), PinnedStep::End);
        // All Displays stays All Displays, and ends with nothing lit.
        assert_eq!(pinned_step(ALL, None, &dark, Some(true), true, ALL), PinnedStep::Stay);
        assert_eq!(pinned_step(ALL, None, &dark, Some(true), false, ALL), PinnedStep::Rebuild(ALL));
        assert_eq!(pinned_step(ALL, None, &dsh(&[0], &[0], &[0], &[], &[PANEL]), Some(true), true, ALL), PinnedStep::End);
        // No lid: nothing, ever.
        assert_eq!(pinned_step(0, Some(PANEL), &left, None, false, ALL), PinnedStep::Stay);
    }

    /// One reason a pinned stream's end names the lid: the LID changed
    /// within the grace. Being shut all session is not it (a laptop docked
    /// with its lid closed), nor are the stream's own acts (a docked stream
    /// rebuilding its own screen).
    #[test]
    fn the_lid_changed_recently_only_when_the_lid_changed() {
        let t = t0();
        // Docked: shut from before the stream began, and never changing.
        let mut docked = LidWatch::new(t, Some(true), None);
        assert!(!docked.lid_changed_recently(t + Duration::from_secs(5)));
        docked.acted(t + Duration::from_secs(60), Flight::Move);
        assert!(!docked.lid_changed_recently(t + Duration::from_secs(61)), "its own rebuild is not the lid");
        // A lid that shuts during the session, for the grace after it.
        let mut w = LidWatch::new(t, Some(false), None);
        assert!(!w.lid_changed_recently(t), "open, and nothing changed");
        let shut = t + Duration::from_secs(1);
        w.observe(Some(true), shut);
        assert!(w.lid_changed_recently(shut + LID_TRANSITION_GRACE - MS));
        assert!(!w.lid_changed_recently(shut + LID_TRANSITION_GRACE), "shut long enough, it is a dock");
        // A desktop never is.
        assert!(!LidWatch::new(t, None, None).lid_changed_recently(t));
    }

    /// The other reason: the stream's own screen, at its own index, is the
    /// panel dark behind the lid.
    #[test]
    fn the_own_screen_is_dark_only_when_it_is_the_panel_behind_the_lid() {
        let dark = dsh(&[0, 1], &[0], &[0], &[], &[PANEL, EXTERNAL]);
        assert!(own_screen_dark(0, Some(PANEL), &dark, ALL));
        assert!(!own_screen_dark(1, Some(EXTERNAL), &dark, ALL), "the external monitor is lit");
        let left = dsh(&[0], &[], &[], &[], &[EXTERNAL]);
        assert!(!own_screen_dark(1, Some(EXTERNAL), &left, ALL), "gone is not dark");
        assert!(!own_screen_dark(0, Some(PANEL), &left, ALL), "another screen at its index is not dark");
        assert!(!own_screen_dark(0, None, &dark, ALL), "nothing to prove it by");
        assert!(own_screen_dark(ALL, None, &dsh(&[0], &[0], &[0], &[], &[PANEL]), ALL), "All Displays left with none lit");
        assert!(!own_screen_dark(ALL, None, &dark, ALL));
    }

    // ---- the preparation, across a session -----------------------------------

    /// REVIEW FINDING 1 (HIGH). The lid shut: the virtual screen was asked
    /// for, the stream moved there at its next look, and `prepare` was never
    /// asked again, so the preparation stayed with that ask in it. The lid
    /// opened (back to the panel; the holder let the screen go), and shut
    /// again a minute on: `decide` read the old ask, past its start window,
    /// and said "the virtual screen did not start" without asking anyone.
    #[test]
    fn a_second_lid_close_in_a_session_asks_for_the_virtual_screen_again() {
        let t = t0();
        let mut preps = Preps::default();
        let (p, fresh) = preps.begin("s1", t, true);
        assert!(fresh);
        assert_eq!(decide(&p, t, false, true), (ScreenState::Starting, Action::AskForVirtual));
        preps.asked("s1", t, on(), t);
        let again = t + Duration::from_secs(60);
        let (p, fresh) = preps.begin("s1", again, true);
        assert!(fresh, "a new request is a new preparation");
        assert_eq!(decide(&p, again, false, true), (ScreenState::Starting, Action::AskForVirtual));
        // CONTROL: the preparation as it was left is the false failure.
        let mut left = Prep::new(t);
        left.asked = Some((t, on()));
        assert_eq!(decide(&left, again, false, true).0, ScreenState::Off(OffReason::VirtualFailed));
    }

    /// The same inside the forgetting window: closed, open a second later
    /// (the holder lets the screen go), closed again two seconds after that.
    /// The new request asks again; the old preparation would have waited out
    /// its start window for a screen nobody was starting, then failed.
    #[test]
    fn a_quick_second_close_after_the_screen_was_let_go_asks_again() {
        let t = t0();
        let mut preps = Preps::default();
        preps.begin("s1", t, true);
        preps.asked("s1", t, on(), t);
        let reclose = t + Duration::from_secs(3);
        let (p, fresh) = preps.begin("s1", reclose, true);
        assert!(fresh);
        assert_eq!(decide(&p, reclose, false, true), (ScreenState::Starting, Action::AskForVirtual));
        // CONTROL: the same poll without starting afresh keeps the old ask.
        let mut kept = Preps::default();
        kept.begin("s1", t, true);
        kept.asked("s1", t, on(), t);
        let (p, fresh) = kept.begin("s1", reclose, false);
        assert!(!fresh);
        assert_eq!(decide(&p, reclose, false, true), (ScreenState::Starting, Action::None));
    }

    /// A preparation nobody asks about is forgotten: what a media restart's
    /// `prepare_screen` finds for a session whose stream asked mid-session
    /// and ended without an answer. One asked about all along is kept, and
    /// a slow answer counts as being asked about.
    #[test]
    fn a_preparation_nobody_asks_about_is_forgotten() {
        let t = t0();
        let mut preps = Preps::default();
        preps.begin("s1", t, false);
        preps.asked("s1", t, on(), t + Duration::from_secs(4));
        let (_, fresh) = preps.begin("s1", t + Duration::from_secs(8), false);
        assert!(!fresh, "the answer, four seconds in, was being asked about");
        let (_, fresh) = preps.begin("s1", t + Duration::from_secs(8) + PREP_FORGOTTEN_AFTER, false);
        assert!(fresh, "nobody asked for five seconds");
        // `ready` and `off` end a preparation.
        preps.settle("s1", ScreenState::Starting);
        assert!(preps.contains("s1"));
        preps.settle("s1", ScreenState::Ready);
        assert!(!preps.contains("s1"));
    }

    #[test]
    fn the_holder_waits_a_tick_before_letting_the_virtual_screen_go() {
        assert!(holder_lets_go(true, 0), "nobody holds it: at once");
        assert!(!holder_lets_go(false, 1), "a real screen just back: a tick for the streams to move off it");
        assert!(holder_lets_go(false, 2));
        assert!(!holder_lets_go(false, 0));
    }

    #[test]
    fn the_displays_are_joined_to_their_paths_by_gdi_name() {
        let hdmi = path(r"\\.\DISPLAY3", r"\\?\PCI#VEN_10DE#4&1#{g}", false);
        let paths = vec![panel(), virt(), hdmi];
        let named = vec![
            (0, r"\\.\DISPLAY1".to_string()),
            (1, r"\\.\display2".to_string()),
            (2, r"\\.\DISPLAY3".to_string()),
        ];
        let id = Some(r"ROOT\DISPLAY\0001");
        assert_eq!(displays_from(&[0, 1, 2], &named, &paths, Some(true), id), ds(&[0, 1, 2], &[0], &[0], &[1]));
        assert_eq!(displays_from(&[0, 1, 2], &named, &paths, Some(false), id), ds(&[0, 1, 2], &[], &[0], &[1]));
        // No virtual screen held: none is the virtual screen.
        assert_eq!(displays_from(&[0, 1, 2], &named, &paths, Some(true), None), ds(&[0, 1, 2], &[0], &[0], &[]));
    }

    #[test]
    fn joining_the_virtual_screen_another_stream_holds_is_said_once() {
        let line = shared_hold_line("ds1", Some(r"ROOT\DISPLAY\0000"), true, false).expect("said when joining");
        assert!(line.contains("ds1") && line.contains(r"ROOT\DISPLAY\0000") && line.contains("ready"), "{line}");
        assert!(shared_hold_line("ds1", None, false, false).unwrap().contains("no screen is showing yet"));
        // NEGATIVE CONTROL: a session that holds it already says nothing more.
        assert_eq!(shared_hold_line("ds1", Some(r"ROOT\DISPLAY\0000"), true, true), None);
    }

    #[test]
    fn the_lid_payload_is_a_dword_zero_closed_one_open() {
        assert_eq!(decode_lid(&0u32.to_le_bytes()), Some(true));
        assert_eq!(decode_lid(&1u32.to_le_bytes()), Some(false));
        assert_eq!(decode_lid(&2u32.to_le_bytes()), None);
        assert_eq!(decode_lid(&[0, 0]), None, "too short is not a lid state");
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
