//! Where the text caret is, in physical desktop pixels.
//!
//! WHY THIS EXISTS. A phone controlling a PC shows a whole 1920x1080 (or a
//! three-screen composite) desktop in 390 CSS pixels, and the soft keyboard
//! covers the bottom half of that. Typing is unreadable. The viewer can zoom to
//! the caret — but only if something tells it where the caret IS, and nothing in
//! this codebase has ever read one.
//!
//! WHAT IT DOES NOT LEAK. The caret is already in the pixels the viewer is
//! decoding: it blinks on screen, in the video, every 530ms. Reporting its
//! rectangle to a viewer that is watching the video is not new information — it
//! is the same information, in a form the camera can use. What IS new is the
//! capability: this reads other processes' accessibility trees. So it is
//! geometry only (never text, never a window title, never a class name), it runs
//! only while a viewer has said `track on`, and the agent refuses to arm it for a
//! session with no picture (`StreamMode::DataOnly`), where a caret rectangle
//! really would say something the viewer cannot already see.
//!
//! PHYSICAL PIXELS, ON A PER-MONITOR-AWARE THREAD, AND NOT ONE STEP FURTHER.
//! `GUITHREADINFO.rcCaret` is in the caret window's client space and MSAA's
//! `accLocation` in the caller's DPI space, so both threads here set
//! `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` as their first act and the rects
//! come back physical — which is what `DXGI_OUTPUT_DESC.DesktopCoordinates`
//! (the surface the fractions are of) is measured in. Do NOT make the PROCESS
//! DPI-aware to achieve the same thing: `list_monitors()` and
//! `GetSystemMetrics(SM_*VIRTUALSCREEN)` would start reporting physical rects
//! too, and every existing session's injected input is normalised over those —
//! it would silently re-aim the mouse on every scaled desktop, with no test
//! anywhere near it.
//!
//! NEVER JOINED, PROCESS-WIDE, REFCOUNTED. Tiers 2 and 3 are cross-process
//! calls into whatever application has focus, and a hung application can hold
//! one for as long as the OS allows. `StopStream` joins the stream thread, so a
//! sampler joined from there would park session teardown — and the agent pipe
//! behind it — on a Not Responding window. So: one sampler for the process,
//! claimed by `track()` and released when the returned `CaretTracker` drops; at
//! zero claims the threads PARK on a condvar rather than exit. Nothing is
//! spawned per session, nothing is leaked, and nothing is ever waited on.
//!
//! TWO THREADS, AND THE SPLIT IS LOAD-BEARING. `SetThreadDesktop` refuses a
//! thread that owns a window or a hook, and a COM apartment can quietly create
//! one. The thread that follows the input desktop — the only one that can see a
//! caret on the lock screen, the sign-in screen or a UAC prompt — therefore does
//! user32 and nothing else, forever. COM lives on a second thread that never
//! follows a desktop, and whose samples are ignored while the input desktop is
//! not `Default` (see `assist_is_trustworthy`): a sample from there describes a
//! window on a desktop NOBODY CAN SEE, and reporting it would fly the viewer's
//! camera to a caret that is not on screen. Not following makes this feature
//! actively wrong, not merely useless.

use std::time::{Duration, Instant};

/// How often the caret is sampled while a viewer is tracking. 10Hz: a caret
/// moves one character at a time and the viewer only re-aims when it leaves a
/// dead zone, so faster buys nothing and costs a cross-desktop poll.
pub const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// The most often the tier-1 thread will re-attach itself to the input desktop.
///
/// `desktop.rs`'s doctrine is "on failure, not on a timer" — but here the
/// failure ("no caret") is indistinguishable from "nothing is focused", so a
/// pure on-failure follow would call `OpenInputDesktop` ten times a second on an
/// idle desktop. Bounded to the same cadence the capture loop already settled
/// on, and only while nothing was found.
pub const REFOLLOW_EVERY: Duration = Duration::from_secs(2);

/// How long a caret is still reported after it stops being measurable.
///
/// A caret BLINKS. At 10Hz against the default 530ms blink, a sampler that
/// reported only what it could see this instant would publish
/// present/absent/present/absent five times a second and the viewer's camera
/// would flap. 1200ms is longer than two blink periods, so a blinking caret is
/// continuously present, while a caret that has genuinely gone (the window
/// closed, focus left) disappears about a second later.
pub const CARET_HOLD: Duration = Duration::from_millis(1200);

/// Consecutive tier-1 misses before the COM assist thread is started at all.
///
/// Tier 2/3 turn on Chromium's accessibility tree for the life of that process,
/// which is a real cost on a machine whose whole purpose is being screen-shared.
/// So they are not merely a fallback in code order — they are not reached until
/// tier 1 has actually failed, twice.
pub const ASSIST_AFTER_MISSES: u32 = 2;

/// How fresh an assist sample must be to be used. Longer than the poll interval
/// so a sample is not thrown away for arriving between two polls, short enough
/// that a wedged cross-process call cannot keep a stale rect alive.
pub const ASSIST_FRESH_FOR: Duration = Duration::from_millis(300);

/// UI Automation connection/transaction timeout. This is the whole reason a hung
/// provider does not become a hung sampler.
pub const UIA_TIMEOUT_MS: u32 = 200;

/// The slow clock tier 3 runs on. UIA `GetFocusedElement` costs tens of
/// milliseconds even when it works; 2Hz is enough to place a camera.
pub const UIA_EVERY: Duration = Duration::from_millis(500);

/// How long after a failed `CoCreateInstance(CUIAutomation…)` the next attempt
/// waits. Long enough not to hammer a COM server that is genuinely absent, short
/// enough that a transient failure (a session change, the service starting)
/// does not cost the rest of the process's life.
pub const UIA_CREATE_RETRY: Duration = Duration::from_secs(30);

/// How long "tier 1 answered for this window" is remembered.
///
/// While it holds, tiers 2 and 3 are never called for that window at all — the
/// cheapest possible answer to the Chromium accessibility-mode cost.
pub const TIER_CACHE_TTL: Duration = Duration::from_secs(60);

/// Taller than this is not a caret.
///
/// A text caret is a line, ~15-40px. A rect this tall is a text FIELD (or a
/// document body, or a whole window) — and aiming a camera at the centre of one
/// pans to the middle of a page. `CaretSource::Field` is exempt because it is
/// explicitly reporting a field and the viewer treats it differently.
pub const CARET_MAX_LINE_PX: i32 = 200;

/// Which API answered. On the wire so the viewer can treat a whole-field rect
/// differently from a real caret, and so a field report names its own weakness
/// rather than pretending to be a caret.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaretSource {
    /// `GetGUIThreadInfo` → `rcCaret`. The only tier that can see the secure
    /// desktop.
    Win32,
    /// MSAA `OBJID_CARET` → `accLocation`.
    Msaa,
    /// UI Automation `TextPattern2::GetCaretRange`.
    Uia,
    /// UI Automation, but only the focused ELEMENT's bounding rectangle — the
    /// text box, not the caret inside it.
    Field,
}

impl CaretSource {
    /// The wire spelling. Pinned as literals by test: the viewer switches on
    /// these strings and a rename here would silently change its behaviour.
    pub fn wire(self) -> &'static str {
        match self {
            Self::Win32 => "win32",
            Self::Msaa => "msaa",
            Self::Uia => "uia",
            Self::Field => "field",
        }
    }
}

/// A caret rectangle in PHYSICAL DESKTOP pixels — the same space
/// `puca_capture::OutputInfo` is in, so the mapping to fractions is a
/// subtraction and a divide with no scale factor anywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaretRect {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

/// One poll's answer. Published whether or not a caret was found: `at` is the
/// staleness clock, and it must keep advancing while the sampler is alive so the
/// stream loop can tell "no caret" from "the sampler stopped answering".
#[derive(Clone, Copy, Debug)]
pub struct CaretSample {
    pub rect: Option<CaretRect>,
    pub src: Option<CaretSource>,
    pub seq: u64,
    pub at: Instant,
}

/// A claim on the process-wide sampler.
///
/// Dropping it releases the claim; at zero claims the sampler threads park. Two
/// sessions typing at once share one sampler, because where the caret is is a
/// fact about the machine, not about a session.
pub struct CaretTracker {
    /// `false` = inert: a non-Windows build, or a Windows build whose sampler
    /// thread could not be started. `latest()` then answers `None` for ever,
    /// which makes the viewer fall back to its own pointer position — the honest
    /// outcome, not a failure to report.
    live: bool,
}

impl CaretTracker {
    fn inert() -> Self {
        Self { live: false }
    }

    /// The most recent poll, or `None` before the first one has completed.
    pub fn latest(&self) -> Option<CaretSample> {
        if !self.live {
            return None;
        }
        #[cfg(windows)]
        {
            imp::latest()
        }
        #[cfg(not(windows))]
        {
            None
        }
    }
}

impl Drop for CaretTracker {
    fn drop(&mut self) {
        if !self.live {
            return;
        }
        #[cfg(windows)]
        imp::release();
    }
}

/// Claim the sampler. Cheap and idempotent — the threads already exist after the
/// first ever call and are merely unparked.
#[cfg(windows)]
pub fn track() -> CaretTracker {
    imp::track()
}

/// X11 and Wayland expose no equivalent question, so the honest answer is a
/// tracker that never reports a caret rather than a failure. The viewer's own
/// fallback (place the camera where the finger last aimed) is what runs.
#[cfg(not(windows))]
pub fn track() -> CaretTracker {
    CaretTracker::inert()
}

/// May a sample from the COM assist thread be believed, given the desktop that
/// currently owns input?
///
/// The assist thread deliberately stays on the process's default desktop (see
/// the module header), so everything it can describe lives there. While
/// `Winlogon` owns input — the lock screen, the sign-in screen, a UAC prompt —
/// an assist sample describes a window on a desktop that is not on screen.
///
/// The name may carry the suffix `follow_input_desktop` appends when it had to
/// fall back to a reduced access mask (`desktop.rs:136`, e.g.
/// `"Default (read-only fallback)"`). Not stripping it would silently disable
/// tiers 2 and 3 on every user-flavour agent.
pub fn assist_is_trustworthy(input_desktop: &str) -> bool {
    let name = match input_desktop.split_once(" (") {
        Some((head, _)) => head,
        None => input_desktop,
    };
    // A fully qualified name arrives as `WinSta0\Default`.
    let leaf = name.rsplit('\\').next().unwrap_or(name);
    leaf.eq_ignore_ascii_case("Default")
}

/// Pick between the two threads' answers.
///
/// Tier 1 wins whenever it has one: it is the cheapest, it is the only tier that
/// can see the secure desktop, and it is the only one measured on the same
/// desktop the picture comes from.
pub fn merge(
    tier1: Option<(CaretRect, CaretSource)>,
    assist: Option<(CaretRect, CaretSource, Instant)>,
    now: Instant,
    assist_trusted: bool,
) -> Option<(CaretRect, CaretSource)> {
    if let Some(found) = tier1 {
        return Some(found);
    }
    if !assist_trusted {
        return None;
    }
    match assist {
        Some((rect, src, at)) if now.duration_since(at) < ASSIST_FRESH_FOR => Some((rect, src)),
        _ => None,
    }
}

/// The blink hysteresis: hold the last real rect for `hold` after it stops being
/// measurable.
///
/// `prev` is `(rect, when it was last MEASURED)` — never the time it was last
/// published, or a held rect would refresh its own deadline and never expire.
///
/// REVERT-TO-RED: set `hold` to zero and
/// `a_blinking_caret_is_reported_continuously` must fail. That test is the whole
/// reason this function exists.
pub fn fold_caret(
    prev: Option<(CaretRect, Instant)>,
    sample: Option<CaretRect>,
    now: Instant,
    hold: Duration,
) -> Option<CaretRect> {
    match (sample, prev) {
        (Some(fresh), _) => Some(fresh),
        (None, Some((held, measured_at))) if now.duration_since(measured_at) < hold => Some(held),
        _ => None,
    }
}

/// Validate a raw rectangle as a caret. `rc` is `(left, top, right, bottom)`.
///
/// THE ZERO-RECT TRAP this exists for: `GetGUIThreadInfo` leaves `rcCaret`
/// zeroed (or stale) when it fails or when there is no caret window, and a zero
/// rect maps to fraction `(0,0)` — a perfectly plausible caret at the remote
/// screen's top-left corner, which the camera will faithfully fly to.
///
/// A zero WIDTH is allowed and passed through: a one-pixel caret genuinely
/// measures 0 or 1 wide in some applications, and the viewer sizes its zoom from
/// the HEIGHT. A zero height is not: that is what a caret that is not there
/// looks like.
pub fn caret_from_rect(rc: (i32, i32, i32, i32), src: CaretSource) -> Option<CaretRect> {
    let (left, top, right, bottom) = rc;
    let width = right - left;
    let height = bottom - top;
    if height <= 0 || width < 0 {
        return None;
    }
    // A field is expected to be tall — it is the text box, not the caret.
    if src != CaretSource::Field && height > CARET_MAX_LINE_PX {
        return None;
    }
    Some(CaretRect { left, top, width, height })
}

/// Tier 1's validator: the same rules, plus the window handle must exist.
///
/// `hwnd_caret == 0` means "this thread has no caret window", and every field of
/// `rcCaret` is then meaningless rather than merely empty.
pub fn caret_from_gui(hwnd_caret: isize, rc: (i32, i32, i32, i32)) -> Option<CaretRect> {
    if hwnd_caret == 0 {
        return None;
    }
    caret_from_rect(rc, CaretSource::Win32)
}

#[cfg(windows)]
mod imp {
    use super::{
        assist_is_trustworthy, caret_from_gui, caret_from_rect, fold_caret, merge, CaretRect,
        CaretSample, CaretSource, CaretTracker, ASSIST_AFTER_MISSES, CARET_HOLD, POLL_INTERVAL,
        REFOLLOW_EVERY, TIER_CACHE_TTL, UIA_CREATE_RETRY, UIA_EVERY, UIA_TIMEOUT_MS,
    };
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use std::sync::{Condvar, Mutex, MutexGuard, Once, OnceLock};
    use std::time::{Duration, Instant};
    use windows::core::{s, w, Interface, GUID, HRESULT};
    use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, HANDLE, HWND, POINT};
    use windows::Win32::Graphics::Gdi::MapWindowPoints;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoCreateInstance, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, SAFEARRAY,
    };
    use windows::Win32::System::LibraryLoader::{
        GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    use windows::Win32::System::Ole::{
        SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElemsize,
        SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayUnaccessData,
    };
    use windows::Win32::UI::Accessibility::{
        IAccessible, IUIAutomation, IUIAutomation2, IUIAutomationTextPattern2,
        IUIAutomationTextRange, CUIAutomation, CUIAutomation8, TextUnit_Character,
        UIA_TextPattern2Id,
    };
    use windows::Win32::UI::HiDpi::{
        SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetGUIThreadInfo, IsWindow, GUITHREADINFO, OBJID_CARET,
    };

    /// Everything the two sampler threads and every claimant share.
    struct Sampler {
        /// How many `CaretTracker`s are alive. Zero = park.
        claims: Mutex<usize>,
        wake: Condvar,
        /// Tier 1's published answer — the only slot the agent reads.
        latest: Mutex<Option<CaretSample>>,
        /// Tiers 2/3's answer, with the time it was measured. Consumed by
        /// `merge`, which ignores it when stale or untrusted.
        assist: Mutex<Option<(CaretRect, CaretSource, Instant)>>,
        /// Focus windows tier 1 has answered for, and when. Tiers 2/3 are never
        /// called for a window in here.
        tier1_ok: Mutex<HashMap<isize, Instant>>,
        /// Consecutive tier-1 misses. The gate on the assist thread existing at
        /// all, and on it doing any work.
        misses: AtomicU32,
        /// Whether the input desktop is one the assist thread's samples could
        /// describe. Written by the following thread, read by the COM thread so
        /// it does no cross-process work at all while the machine is locked.
        input_trusted: AtomicBool,
        seq: AtomicU64,
    }

    static SAMPLER: OnceLock<Sampler> = OnceLock::new();
    static START: Once = Once::new();
    static ALIVE: AtomicBool = AtomicBool::new(false);
    static ASSIST_START: Once = Once::new();

    /// Lock helper that survives a poisoned mutex.
    ///
    /// A panic inside a poll must not permanently stop caret reporting for the
    /// process: the data behind each of these locks is a plain value that the
    /// next poll overwrites wholesale, so there is no invariant left broken.
    fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn sampler() -> &'static Sampler {
        let s = SAMPLER.get_or_init(|| Sampler {
            claims: Mutex::new(0),
            wake: Condvar::new(),
            latest: Mutex::new(None),
            assist: Mutex::new(None),
            tier1_ok: Mutex::new(HashMap::new()),
            misses: AtomicU32::new(0),
            input_trusted: AtomicBool::new(true),
            seq: AtomicU64::new(0),
        });
        START.call_once(|| {
            match std::thread::Builder::new()
                .name("sovereign-caret".to_string())
                .spawn(move || poll_loop(s))
            {
                Ok(_) => ALIVE.store(true, Ordering::Release),
                // Deliberately not fatal, and deliberately not retried: a
                // process that cannot spawn a thread has larger problems, and
                // the viewer degrades to its own pointer fallback.
                Err(e) => eprintln!("[caret] the sampler thread could not start: {e}"),
            }
        });
        s
    }

    pub fn track() -> CaretTracker {
        let s = sampler();
        if !ALIVE.load(Ordering::Acquire) {
            return CaretTracker::inert();
        }
        let mut claims = lock(&s.claims);
        *claims += 1;
        if *claims == 1 {
            // 0 -> 1: unpark. Both threads wait on this condvar.
            s.wake.notify_all();
        }
        CaretTracker { live: true }
    }

    pub fn release() {
        let Some(s) = SAMPLER.get() else { return };
        let mut claims = lock(&s.claims);
        *claims = claims.saturating_sub(1);
        if *claims == 0 {
            // Nothing waits for zero, but waking the pollers lets them park
            // immediately instead of finishing one more cross-process poll.
            s.wake.notify_all();
        }
    }

    pub fn latest() -> Option<CaretSample> {
        let s = SAMPLER.get()?;
        *lock(&s.latest)
    }

    /// Park until at least one claim exists. Returns true if we actually slept,
    /// which is the signal to re-follow the input desktop.
    fn park_until_claimed(s: &'static Sampler) -> bool {
        let mut claims = lock(&s.claims);
        let mut slept = false;
        while *claims == 0 {
            slept = true;
            claims = s.wake.wait(claims).unwrap_or_else(|e| e.into_inner());
        }
        slept
    }

    /// Sleep between polls on the same condvar, so a release parks us promptly
    /// rather than after a full interval.
    fn nap(s: &'static Sampler, how_long: Duration) {
        let claims = lock(&s.claims);
        let _ = s.wake.wait_timeout(claims, how_long);
    }

    // ---- thread A: user32 only, follows the input desktop, NO COM EVER ------

    fn poll_loop(s: &'static Sampler) {
        // FIRST, before anything reads a rectangle: the rects below must be
        // physical, and this is the only call that makes them so.
        unsafe {
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let mut desktop = String::from("Default");
        let mut followed_at: Option<Instant> = None;
        let mut prev: Option<(CaretRect, CaretSource, Instant)> = None;
        let mut denied_run: u32 = 0;
        // Two separate latches on purpose: one shared "have I logged something"
        // flag would make a follow refusal suppress the first-caret line (and
        // the other way round), which is precisely how a log stops being
        // evidence.
        let mut logged_caret_on: Option<String> = None;
        let mut logged_follow_refusal = false;
        let mut needs_follow = true;
        // Whether the LAST POLL measured a caret — not whether one is currently
        // being reported. Those differ by up to `CARET_HOLD`, and using the
        // reported state here was a ONE-WAY LATCH: `prev` is only cleared on an
        // unpark, so after the first caret of a session the periodic re-follow
        // would stop for ever and locking the machine mid-session would leave
        // this thread reading the OLD desktop's foreground window — the
        // plausible-but-wrong caret this whole module is arranged to avoid.
        let mut found_last_poll = false;
        // Whether this thread is on the desktop that owns input. `false` means
        // `OpenInputDesktop` was refused even with the reduced mask, which is
        // what a user-flavour agent sees while a secure desktop owns input — so
        // whatever `GetGUIThreadInfo` would say describes a desktop that is not
        // on screen. FAIL CLOSED there: report nothing.
        let mut following = false;

        loop {
            if park_until_claimed(s) {
                // A fresh claim: the desktop may have changed while we slept,
                // and prev is ancient.
                needs_follow = true;
                prev = None;
                found_last_poll = false;
            }
            let now = Instant::now();
            // FOLLOW WHILE NOTHING IS FOUND, not on every poll: one kernel call
            // per two seconds of an idle desktop, and none at all while a caret
            // is actually being measured.
            let due = followed_at.is_none_or(|t| now.duration_since(t) >= REFOLLOW_EVERY);
            if needs_follow || (!found_last_poll && due) {
                needs_follow = false;
                followed_at = Some(now);
                match crate::desktop::follow_input_desktop() {
                    Ok(name) => {
                        logged_follow_refusal = false;
                        following = true;
                        if name != desktop {
                            eprintln!("[caret] desktop='{name}'");
                            desktop = name;
                            logged_caret_on = None;
                            // The hysteresis is a memory of the OLD desktop's
                            // caret. Held across the switch it would keep
                            // reporting Notepad's caret for CARET_HOLD after
                            // the picture became the lock screen — a
                            // plausible rect on the wrong desktop, exactly
                            // what following exists to prevent.
                            prev = None;
                            found_last_poll = false;
                        }
                    }
                    // Says so once per RUN of refusals rather than ten times a
                    // second.
                    Err(e) => {
                        if following {
                            // Same reasoning as the desktop change above: what
                            // was measured no longer describes what is shown.
                            prev = None;
                            found_last_poll = false;
                        }
                        following = false;
                        if !logged_follow_refusal {
                            logged_follow_refusal = true;
                            eprintln!("[caret] cannot follow the input desktop: {e}");
                        }
                    }
                }
                s.input_trusted
                    .store(following && assist_is_trustworthy(&desktop), Ordering::Relaxed);
            }

            let (tier1, focus) = if !following {
                // Not on the input desktop: `GetGUIThreadInfo(0)` would answer
                // for a desktop nobody can see, so it is not even asked.
                (None, 0)
            } else {
                match tier1_caret() {
                Ok(found) => {
                    if denied_run > 0 {
                        eprintln!("[caret] the focused window can be read again");
                        denied_run = 0;
                    }
                    found
                }
                Err(denied) => {
                    if denied {
                        denied_run += 1;
                        // Once per RUN of refusals, then once per ~30s while it
                        // persists. A User-flavour agent facing an elevated
                        // window hits this on every poll.
                        if denied_run == 1 || denied_run % 300 == 0 {
                            eprintln!(
                                "[caret] the focused window belongs to a process this agent may \
                                 not read ({denied_run} refusals)"
                            );
                        }
                    }
                    (None, 0)
                }
                }
            };
            found_last_poll = tier1.is_some();

            // AFTER the poll, not before it: this is the staleness clock the
            // stream loop reads, and it must mean "when this answer was true".
            let sampled_at = Instant::now();
            if tier1.is_some() {
                s.misses.store(0, Ordering::Relaxed);
                if focus != 0 {
                    let mut cache = lock(&s.tier1_ok);
                    cache.retain(|_, at| sampled_at.duration_since(*at) < TIER_CACHE_TTL);
                    cache.insert(focus, sampled_at);
                }
            } else {
                let misses = s.misses.fetch_add(1, Ordering::Relaxed) + 1;
                if misses >= ASSIST_AFTER_MISSES {
                    ensure_assist(s);
                }
            }

            let assist = *lock(&s.assist);
            // Two conditions, both necessary: the input desktop must be one the
            // assist thread could describe, AND this thread must actually know
            // which desktop that is.
            let trusted = following && assist_is_trustworthy(&desktop);
            let merged = merge(tier1, assist, sampled_at, trusted);
            let folded = fold_caret(
                prev.map(|(r, _, at)| (r, at)),
                merged.map(|(r, _)| r),
                sampled_at,
                CARET_HOLD,
            );
            if let Some((rect, tier)) = merged {
                prev = Some((rect, tier, sampled_at));
            }
            // A HELD rect keeps the tier that measured it: it is the same
            // measurement, still being reported, not a new weaker one.
            let src = folded.and_then(|_| prev.map(|(_, tier, _)| tier));
            if let (Some(tier), true) = (src, logged_caret_on.as_deref() != Some(desktop.as_str())) {
                // A cargo example cannot run on the secure desktop, so for the
                // sign-in screen this line is the only evidence that will ever
                // exist. Once per desktop, never per poll.
                eprintln!("[caret] first caret on desktop '{desktop}' via {}", tier.wire());
                logged_caret_on = Some(desktop.clone());
            }
            publish(s, folded, src, sampled_at);
            nap(s, POLL_INTERVAL);
        }
    }

    fn publish(s: &Sampler, rect: Option<CaretRect>, src: Option<CaretSource>, at: Instant) {
        let seq = s.seq.fetch_add(1, Ordering::Relaxed) + 1;
        *lock(&s.latest) = Some(CaretSample { rect, src, seq, at });
    }

    /// Tier 1. `Err(true)` = the window belongs to a process we may not read;
    /// `Err(false)` = any other refusal. `Ok((rect, hwndFocus))`.
    fn tier1_caret() -> Result<(Option<(CaretRect, CaretSource)>, isize), bool> {
        let mut gti = GUITHREADINFO {
            // WITHOUT THIS THE CALL FAILS and leaves the struct zeroed — which
            // is the zero-rect trap `caret_from_gui` exists to catch.
            cbSize: core::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        // 0 = the foreground thread OF THIS THREAD'S DESKTOP. That is why the
        // follow above is a correctness requirement and not a nicety.
        if let Err(e) = unsafe { GetGUIThreadInfo(0, &mut gti) } {
            return Err(e.code() == HRESULT::from_win32(ERROR_ACCESS_DENIED.0));
        }
        let focus = gti.hwndFocus.0 as isize;
        let caret_hwnd = gti.hwndCaret;
        // NOT GATED ON GUI_CARETBLINKING: that flag is the caret's blink STATE
        // ("visible right now"), and a caret is forced solid while you type. As
        // an existence predicate it would report present/absent five times a
        // second. Existence is: there is a caret window, and its rect is a line.
        if caret_hwnd.is_invalid() || !unsafe { IsWindow(caret_hwnd) }.as_bool() {
            return Ok((None, focus));
        }
        let r = gti.rcCaret;
        // CLIENT coordinates of hwndCaret -> desktop. Both corners, because a
        // rect is two points and mapping only the origin loses the size on any
        // window whose client space is scaled.
        let mut pts = [
            POINT { x: r.left, y: r.top },
            POINT { x: r.right, y: r.bottom },
        ];
        // The return value is NOT a success flag: it packs the applied offset
        // (LOWORD dx, HIWORD dy) and is legitimately 0 for a client area whose
        // origin IS the desktop origin — a full-screen browser or terminal on
        // the primary monitor. Treating 0 as failure threw away every tier-1
        // caret in exactly that case. A window that died between IsWindow and
        // here maps to garbage or leaves the points untouched; either way the
        // rect check below (a line-sized, non-inverted rect) is the honest
        // gate, and the hold absorbs one bad poll.
        unsafe { MapWindowPoints(caret_hwnd, HWND::default(), &mut pts) };
        let rect = caret_from_gui(
            caret_hwnd.0 as isize,
            (pts[0].x, pts[0].y, pts[1].x, pts[1].y),
        );
        Ok((rect.map(|r| (r, CaretSource::Win32)), focus))
    }

    // ---- thread B: COM, tiers 2 and 3, NEVER follows a desktop --------------

    fn ensure_assist(s: &'static Sampler) {
        ASSIST_START.call_once(|| {
            if let Err(e) = std::thread::Builder::new()
                .name("sovereign-caret-uia".to_string())
                .spawn(move || assist_loop(s))
            {
                eprintln!("[caret] the accessibility assist thread could not start: {e}");
            }
        });
    }

    fn assist_loop(s: &'static Sampler) {
        unsafe {
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        // MTA, NOT STA, and this is the reason the split exists: an apartment
        // that owns a hidden OLE window makes `SetThreadDesktop` refuse, and an
        // STA client that never pumps messages deadlocks on UIA callbacks. This
        // thread only polls.
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if com.is_err() {
            // RPC_E_CHANGED_MODE and friends: tier 3 is unavailable for the life
            // of this thread. Tier 2 does not need an apartment.
            eprintln!("[caret] COM init failed ({com:?}); tier 3 is unavailable");
        }
        let mut uia: Option<IUIAutomation> = None;
        // Permanent ONLY for a dead apartment. A failed CoCreateInstance is not
        // that: the UIAutomationCore server can be momentarily unavailable
        // (session change, service start-up), and latching tier 3 off for the
        // life of the process on one such answer is the one-way latch this
        // codebase keeps re-learning. Retried on the slow clock below instead.
        let uia_dead = com.is_err();
        let mut uia_create_failed_at: Option<Instant> = None;
        let mut tier2_misses: u32 = 0;
        let mut last_uia: Option<Instant> = None;

        loop {
            park_until_claimed(s);
            // Only ever while tier 1 has actually failed, and never while the
            // input desktop is one this thread cannot describe.
            if s.misses.load(Ordering::Relaxed) < ASSIST_AFTER_MISSES
                || !s.input_trusted.load(Ordering::Relaxed)
            {
                *lock(&s.assist) = None;
                nap(s, POLL_INTERVAL);
                continue;
            }
            let focus = focused_window();
            let known = focus != 0 && {
                let now = Instant::now();
                lock(&s.tier1_ok)
                    .get(&focus)
                    .is_some_and(|at| now.duration_since(*at) < TIER_CACHE_TTL)
            };
            if focus == 0 || known {
                // Tier 1 owns this window. Touching its accessibility tree would
                // buy nothing and cost that process its accessibility mode for
                // the rest of its life.
                *lock(&s.assist) = None;
                nap(s, POLL_INTERVAL);
                continue;
            }

            let mut found = tier2_caret(focus).map(|r| (r, CaretSource::Msaa));
            if found.is_some() {
                tier2_misses = 0;
            } else {
                tier2_misses = tier2_misses.saturating_add(1);
                let now = Instant::now();
                let due = last_uia.is_none_or(|t| now.duration_since(t) >= UIA_EVERY);
                if !uia_dead && tier2_misses >= ASSIST_AFTER_MISSES && due {
                    last_uia = Some(now);
                    if uia.is_none()
                        && uia_create_failed_at
                            .is_none_or(|t| now.duration_since(t) >= UIA_CREATE_RETRY)
                    {
                        uia = create_uia();
                        uia_create_failed_at = if uia.is_none() { Some(now) } else { None };
                    }
                    if let Some(a) = uia.as_ref() {
                        found = tier3_caret(a);
                    }
                }
            }
            match found {
                Some((rect, src)) => *lock(&s.assist) = Some((rect, src, Instant::now())),
                None => *lock(&s.assist) = None,
            }
            nap(s, POLL_INTERVAL);
        }
    }

    /// The focused window ON THIS THREAD'S DESKTOP, which for this thread is
    /// always the process's default one. Asked here rather than passed over from
    /// thread A precisely because the two threads may be looking at different
    /// desktops.
    fn focused_window() -> isize {
        let mut gti = GUITHREADINFO {
            cbSize: core::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetGUIThreadInfo(0, &mut gti) }.is_err() {
            return 0;
        }
        gti.hwndFocus.0 as isize
    }

    type AccessibleObjectFromWindowFn = unsafe extern "system" fn(
        HWND,
        u32,
        *const GUID,
        *mut *mut core::ffi::c_void,
    ) -> HRESULT;

    /// `AccessibleObjectFromWindow`, resolved BY HAND from System32.
    ///
    /// NOT `windows::Win32::UI::Accessibility::AccessibleObjectFromWindow`, and
    /// this is not a style preference. windows-rs emits a raw-dylib import per
    /// referenced symbol, so naming that function adds a STATIC import of
    /// `oleacc.dll` — which is not a KnownDLL. The static import table is
    /// resolved before `main` runs, i.e. before `dll_search::harden()`
    /// (`SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)`, which only
    /// affects SUBSEQUENT loads) has had a chance to run, in a process that is
    /// often LocalSystem. A planted `oleacc.dll` beside the agent binary would
    /// then be loaded as SYSTEM: a privilege escalation introduced by an
    /// accessibility feature. Loading it here, by hand, from System32 only, is
    /// the fix — and `caret_probe` prints the module path it resolved to so a
    /// reviewer can see it.
    fn oleacc() -> Option<AccessibleObjectFromWindowFn> {
        static RESOLVED: OnceLock<Option<usize>> = OnceLock::new();
        let addr = *RESOLVED.get_or_init(|| unsafe {
            let module =
                LoadLibraryExW(w!("oleacc.dll"), HANDLE::default(), LOAD_LIBRARY_SEARCH_SYSTEM32)
                    .ok()?;
            let proc = GetProcAddress(module, s!("AccessibleObjectFromWindow"))?;
            Some(proc as usize)
        });
        addr.map(|a| unsafe { core::mem::transmute::<usize, AccessibleObjectFromWindowFn>(a) })
    }

    /// Tier 2: MSAA's caret object on the focused window. `accLocation` answers
    /// in SCREEN coordinates already, in this thread's DPI space — physical,
    /// because of the context set at thread start.
    fn tier2_caret(focus: isize) -> Option<CaretRect> {
        let from_window = oleacc()?;
        let mut raw: *mut core::ffi::c_void = core::ptr::null_mut();
        let hr = unsafe {
            from_window(
                HWND(focus as *mut core::ffi::c_void),
                OBJID_CARET.0 as u32,
                &IAccessible::IID,
                &mut raw,
            )
        };
        if hr.is_err() || raw.is_null() {
            return None;
        }
        let acc: IAccessible = unsafe { IAccessible::from_raw(raw) };
        let (mut l, mut t, mut w, mut h) = (0i32, 0i32, 0i32, 0i32);
        // VT_I4 zero is CHILDID_SELF — the caret itself, not a child of it.
        let child = windows::core::VARIANT::from(0i32);
        unsafe { acc.accLocation(&mut l, &mut t, &mut w, &mut h, &child) }.ok()?;
        caret_from_rect((l, t, l + w, t + h), CaretSource::Msaa)
    }

    fn create_uia() -> Option<IUIAutomation> {
        // CUIAutomation8, not CUIAutomation: only that class hands back
        // IUIAutomation2, and its timeouts are the only thing standing between a
        // hung provider and a wedged thread. Fall back to the older class rather
        // than losing tier 3 entirely on a machine that lacks it.
        let uia: IUIAutomation = unsafe {
            CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
        }
        .ok()?;
        if let Ok(u2) = uia.cast::<IUIAutomation2>() {
            unsafe {
                let _ = u2.SetConnectionTimeout(UIA_TIMEOUT_MS);
                let _ = u2.SetTransactionTimeout(UIA_TIMEOUT_MS);
            }
        }
        Some(uia)
    }

    /// Tier 3: the caret range from UI Automation, else the focused element's
    /// own rectangle reported honestly as a FIELD.
    fn tier3_caret(uia: &IUIAutomation) -> Option<(CaretRect, CaretSource)> {
        let element = unsafe { uia.GetFocusedElement() }.ok()?;
        let pattern = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id)
        };
        if let Ok(tp2) = pattern {
            let mut active = windows::Win32::Foundation::BOOL(0);
            if let Ok(range) = unsafe { tp2.GetCaretRange(&mut active) } {
                if let Some(rect) = range_rect(&range) {
                    return Some((rect, CaretSource::Uia));
                }
                // A collapsed range has no bounding rectangle at all. Widening
                // it by one character gives the caret's line its height back.
                if unsafe { range.ExpandToEnclosingUnit(TextUnit_Character) }.is_ok() {
                    if let Some(rect) = range_rect(&range) {
                        return Some((rect, CaretSource::Uia));
                    }
                }
            }
        }
        let r = unsafe { element.CurrentBoundingRectangle() }.ok()?;
        caret_from_rect((r.left, r.top, r.right, r.bottom), CaretSource::Field)
            .map(|rect| (rect, CaretSource::Field))
    }

    /// First rectangle out of a text range's `GetBoundingRectangles` SAFEARRAY.
    ///
    /// The array is a flat list of doubles in groups of four —
    /// left, top, width, height — and it MUST be destroyed: at 2Hz, a leaked
    /// SAFEARRAY per sample is a leak per half second for the life of the
    /// process.
    fn range_rect(range: &IUIAutomationTextRange) -> Option<CaretRect> {
        let sa: *mut SAFEARRAY = unsafe { range.GetBoundingRectangles() }.ok()?;
        if sa.is_null() {
            return None;
        }
        let out = unsafe { first_rect_in(sa) };
        unsafe {
            let _ = SafeArrayDestroy(sa);
        }
        out
    }

    unsafe fn first_rect_in(sa: *mut SAFEARRAY) -> Option<CaretRect> {
        // SHAPE FIRST. This array is built by whatever process owns the focused
        // window, and the code below reads raw f64s out of its buffer. A
        // one-dimensional array of 8-byte elements is what the interface
        // documents; anything else and the pointer arithmetic would be
        // interpreting someone else's bytes as coordinates.
        if SafeArrayGetDim(sa) != 1 || SafeArrayGetElemsize(sa) != 8 {
            return None;
        }
        let lower = SafeArrayGetLBound(sa, 1).ok()?;
        let upper = SafeArrayGetUBound(sa, 1).ok()?;
        let count = upper.checked_sub(lower)?.checked_add(1)?;
        if count < 4 {
            return None;
        }
        let mut data: *mut core::ffi::c_void = core::ptr::null_mut();
        SafeArrayAccessData(sa, &mut data).ok()?;
        let values = data as *const f64;
        let quad = [
            *values.offset(0),
            *values.offset(1),
            *values.offset(2),
            *values.offset(3),
        ];
        let _ = SafeArrayUnaccessData(sa);
        if quad.iter().any(|v| !v.is_finite()) {
            return None;
        }
        let (l, t, w, h) = (
            quad[0].round() as i32,
            quad[1].round() as i32,
            quad[2].round() as i32,
            quad[3].round() as i32,
        );
        caret_from_rect((l, t, l + w, t + h), CaretSource::Uia)
    }

    /// For the probe only: the file `oleacc.dll` was actually loaded from.
    ///
    /// Exists so a human can SEE that it came from System32 rather than trusting
    /// the flag that was passed.
    pub fn oleacc_module_path() -> Option<String> {
        use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
        // Resolve it first, so this reports the module the sampler will use.
        oleacc()?;
        let module = unsafe {
            LoadLibraryExW(w!("oleacc.dll"), HANDLE::default(), LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?
        };
        let mut buf = [0u16; 512];
        let n = unsafe { GetModuleFileNameW(module, &mut buf) } as usize;
        if n == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..n.min(buf.len())]))
    }

    /// For the probe only: one tier-1 sample on the CALLING thread.
    ///
    /// The probe must exercise the shipped code rather than a copy of it — a
    /// probe that proves something about its own duplicate proves nothing.
    pub fn probe_tier1() -> (Option<(CaretRect, CaretSource)>, isize, u32, Option<CaretRect>) {
        let mut gti = GUITHREADINFO {
            cbSize: core::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetGUIThreadInfo(0, &mut gti) }.is_err() {
            return (None, 0, 0, None);
        }
        let flags = gti.flags.0;
        let focus = gti.hwndFocus.0 as isize;
        let (rect, _) = tier1_caret().unwrap_or((None, 0));
        // The OTHER DPI candidate, side by side: for a DPI-unaware window on a
        // scaled monitor these two disagree, and which one is right is a
        // measurement, not a reading of MSDN.
        let alt = probe_logical_to_physical(&gti);
        (rect, focus, flags, alt)
    }

    fn probe_logical_to_physical(gti: &GUITHREADINFO) -> Option<CaretRect> {
        use windows::Win32::UI::HiDpi::LogicalToPhysicalPointForPerMonitorDPI;
        if gti.hwndCaret.is_invalid() {
            return None;
        }
        // rcCaret is client-relative, so it has to be mapped to the window's
        // screen space before this API means anything.
        let r = gti.rcCaret;
        let mut pts = [
            POINT { x: r.left, y: r.top },
            POINT { x: r.right, y: r.bottom },
        ];
        // Same as tier1_caret: the return value is the packed offset, and 0 is
        // a legitimate answer for a client area at the desktop origin.
        unsafe { MapWindowPoints(gti.hwndCaret, HWND::default(), &mut pts) };
        for p in pts.iter_mut() {
            unsafe {
                let _ = LogicalToPhysicalPointForPerMonitorDPI(gti.hwndCaret, p);
            }
        }
        caret_from_rect((pts[0].x, pts[0].y, pts[1].x, pts[1].y), CaretSource::Win32)
    }

    /// For the probe only: tier 2 against the currently focused window.
    pub fn probe_tier2() -> Option<CaretRect> {
        let focus = focused_window();
        if focus == 0 {
            return None;
        }
        tier2_caret(focus)
    }

    /// For the probe only: tier 3, creating its own UIA instance.
    pub fn probe_tier3() -> Option<(CaretRect, CaretSource)> {
        let uia = create_uia()?;
        tier3_caret(&uia)
    }

    /// For the probe only: does `SetThreadDesktop` still work after COM init?
    ///
    /// This is the measurement the two-thread split rests on. Run on a scratch
    /// thread, because it would otherwise change the calling thread's desktop.
    pub fn probe_set_thread_desktop_after_com() -> Result<String, String> {
        std::thread::spawn(|| {
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if hr.is_err() {
                return Err(format!("CoInitializeEx failed: {hr:?}"));
            }
            crate::desktop::follow_input_desktop()
        })
        .join()
        .unwrap_or_else(|_| Err("the scratch thread panicked".to_string()))
    }
}

#[cfg(windows)]
pub use imp::{
    oleacc_module_path, probe_set_thread_desktop_after_com, probe_tier1, probe_tier2, probe_tier3,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, width: i32, height: i32) -> CaretRect {
        CaretRect { left, top, width, height }
    }

    #[test]
    fn the_wire_names_are_the_ones_the_viewer_switches_on() {
        // Literals, not `format!`: the viewer compares against these exact
        // strings, so a rename must go red HERE rather than in a field report.
        assert_eq!(CaretSource::Win32.wire(), "win32");
        assert_eq!(CaretSource::Msaa.wire(), "msaa");
        assert_eq!(CaretSource::Uia.wire(), "uia");
        assert_eq!(CaretSource::Field.wire(), "field");
    }

    #[test]
    fn an_assist_sample_is_only_believed_on_the_desktop_it_can_see() {
        assert!(assist_is_trustworthy("Default"));
        assert!(!assist_is_trustworthy("Winlogon"));
        // The suffix follow_input_desktop appends on the reduced-rights path
        // (desktop.rs:136). Not stripping it disables tiers 2 and 3 on every
        // user-flavour agent, silently.
        assert!(assist_is_trustworthy("Default (read-only fallback)"));
        assert!(!assist_is_trustworthy("Winlogon (read-only fallback)"));
        assert!(assist_is_trustworthy("WinSta0\\Default"));
        assert!(!assist_is_trustworthy(""));
        assert!(!assist_is_trustworthy("Screen-saver"));
    }

    #[test]
    fn tier_one_wins_and_a_stale_or_untrusted_assist_does_not() {
        // Timestamps are built by ADDING to a base rather than subtracting from
        // `now`: on Windows an `Instant` is measured from boot, so
        // `Instant::now() - 301ms` can panic in a test run seconds after one.
        let measured = Instant::now();
        let one = rect(10, 20, 2, 22);
        let two = rect(500, 600, 2, 18);

        // Tier 1 beats an assist sample measured at the SAME instant: it is the
        // only tier measured on the desktop the picture comes from.
        let merged = merge(
            Some((one, CaretSource::Win32)),
            Some((two, CaretSource::Uia, measured)),
            measured,
            true,
        );
        assert_eq!(merged, Some((one, CaretSource::Win32)));

        // Freshness boundary, hand-derived from ASSIST_FRESH_FOR = 300ms.
        let now = measured + Duration::from_millis(299);
        assert_eq!(
            merge(None, Some((two, CaretSource::Msaa, measured)), now, true),
            Some((two, CaretSource::Msaa)),
        );
        let now = measured + Duration::from_millis(301);
        assert_eq!(merge(None, Some((two, CaretSource::Msaa, measured)), now, true), None);

        // Untrusted (the machine is locked, so the assist thread can only be
        // describing a window nobody can see) — with the POSITIVE CONTROL right
        // beside it, so "always None" cannot pass.
        let now = measured + Duration::from_millis(10);
        assert_eq!(merge(None, Some((two, CaretSource::Msaa, measured)), now, false), None);
        assert_eq!(
            merge(None, Some((two, CaretSource::Msaa, measured)), now, true),
            Some((two, CaretSource::Msaa)),
        );
        // ...and tier 1 is believed even there: it is the only tier that CAN see
        // the secure desktop, and it measured on it.
        assert_eq!(
            merge(Some((one, CaretSource::Win32)), None, now, false),
            Some((one, CaretSource::Win32)),
        );

        assert_eq!(merge(None, None, now, true), None);
    }

    /// A caret blinks. Sampled at 10Hz it is absent half the time, and a camera
    /// that followed that would flap five times a second.
    ///
    /// REVERT-TO-RED: change `CARET_HOLD` to zero and this test fails at the
    /// first `None` — that is the proof the hysteresis is doing the work, not
    /// the poll cadence.
    #[test]
    fn a_blinking_caret_is_reported_continuously() {
        let start = Instant::now();
        let a = rect(100, 200, 2, 20);
        let mut prev: Option<(CaretRect, Instant)> = None;

        for step in 0..12 {
            let now = start + Duration::from_millis(step * 100);
            // Alternating: measured, blinked off, measured, blinked off...
            let sample = if step % 2 == 0 { Some(a) } else { None };
            let folded = fold_caret(prev, sample, now, CARET_HOLD);
            assert_eq!(
                folded,
                Some(a),
                "the caret vanished at step {step} ({}ms in)",
                step * 100
            );
            if let Some(fresh) = sample {
                prev = Some((fresh, now));
            }
        }
    }

    /// POSITIVE CONTROL for the test above: the hold must EXPIRE, or a caret
    /// that has genuinely gone would be reported for ever.
    #[test]
    fn a_caret_that_is_really_gone_expires() {
        let start = Instant::now();
        let a = rect(100, 200, 2, 20);
        let prev = Some((a, start));

        // Hand-derived from CARET_HOLD = 1200ms.
        assert_eq!(fold_caret(prev, None, start + Duration::from_millis(1199), CARET_HOLD), Some(a));
        assert_eq!(fold_caret(prev, None, start + Duration::from_millis(1200), CARET_HOLD), None);
        assert_eq!(fold_caret(prev, None, start + Duration::from_millis(1300), CARET_HOLD), None);
        // And with nothing ever measured there is nothing to hold.
        assert_eq!(fold_caret(None, None, start, CARET_HOLD), None);
    }

    #[test]
    fn a_zero_or_impossible_rect_is_not_a_caret() {
        // hwndCaret == 0: the thread has no caret window and every field of
        // rcCaret is meaningless — including the zeroes, which would otherwise
        // map to a plausible caret at the screen's top-left corner.
        assert_eq!(caret_from_gui(0, (10, 20, 12, 42)), None);
        // The zero rect itself.
        assert_eq!(caret_from_gui(0x1234, (0, 0, 0, 0)), None);
        // Inverted vertically, and inverted horizontally.
        assert_eq!(caret_from_gui(0x1234, (10, 42, 12, 20)), None);
        assert_eq!(caret_from_gui(0x1234, (12, 20, 10, 42)), None);
        // Taller than any caret: a text field or a window, not a line.
        assert_eq!(caret_from_gui(0x1234, (10, 20, 12, 920)), None);

        // POSITIVE CONTROL. Without it every assertion above would pass on a
        // function that returned None unconditionally.
        assert_eq!(
            caret_from_gui(0x1234, (10, 20, 12, 42)),
            Some(rect(10, 20, 2, 22)),
        );
        // A one-pixel caret measuring ZERO wide is real and must survive: the
        // viewer sizes its zoom from the height.
        assert_eq!(
            caret_from_gui(0x1234, (10, 20, 10, 42)),
            Some(rect(10, 20, 0, 22)),
        );
        // Negative desktop coordinates are ordinary — a monitor left of the
        // primary.
        assert_eq!(
            caret_from_gui(0x1234, (-1400, -600, -1398, -578)),
            Some(rect(-1400, -600, 2, 22)),
        );
    }

    #[test]
    fn only_a_field_may_be_taller_than_a_line() {
        let tall = (10, 20, 300, 620);
        assert_eq!(caret_from_rect(tall, CaretSource::Uia), None);
        assert_eq!(caret_from_rect(tall, CaretSource::Msaa), None);
        // A field is EXPECTED to be tall — it is the text box. The agent decides
        // whether it is plausible as a whole (field_rect_is_plausible).
        assert_eq!(
            caret_from_rect(tall, CaretSource::Field),
            Some(rect(10, 20, 290, 600)),
        );
        // But not even a field may have no height.
        assert_eq!(caret_from_rect((10, 20, 300, 20), CaretSource::Field), None);
    }

    /// The published sample must be plain data.
    ///
    /// A COM interface pointer is NOT `Send`, so if anyone ever puts one in here
    /// to "let the agent ask for more detail", this stops compiling — which is
    /// the only enforcement that cannot be forgotten. The apartment rules make
    /// such a pointer valid on exactly one thread.
    #[test]
    fn a_published_sample_can_cross_a_thread() {
        fn assert_send<T: Send>() {}
        assert_send::<CaretSample>();
        assert_send::<CaretRect>();
        assert_send::<CaretSource>();
        assert_send::<CaretTracker>();
    }

    /// An inert tracker never reports a caret, and dropping it does nothing —
    /// which is what the whole non-Windows path is.
    #[test]
    fn an_inert_tracker_reports_nothing() {
        let t = CaretTracker::inert();
        assert!(t.latest().is_none());
        drop(t);
    }

    /// This file's REAL CODE: everything above the test module, with comment
    /// lines removed.
    ///
    /// Both halves matter. Splitting on `#[cfg(test)]` keeps the assertions
    /// below from finding their own search strings — the tautology that made an
    /// earlier `include_str!` test in this repo prove nothing. Dropping comments
    /// keeps a comment that NAMES the forbidden thing (this file has one, on
    /// purpose, explaining why it must not be called) from failing a scan for
    /// it.
    fn real_code() -> String {
        let src = include_str!("caret.rs");
        let (code, _) = src.split_once("#[cfg(test)]").expect("this file has a test module");
        code.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// THE ORDERING THE LOCK SCREEN DEPENDS ON, pinned as a source fact.
    ///
    /// `SetThreadDesktop` refuses a thread that owns a window, and a COM
    /// apartment may create one. The thread that follows the input desktop must
    /// therefore never initialise COM — and that is an invariant about which
    /// code is in which function, which no runtime assertion can express (the
    /// failure only appears on a real Winlogon desktop).
    ///
    /// Scanned over the source ABOVE the test module, so the literals in this
    /// test cannot satisfy their own assertions.
    #[test]
    fn the_following_thread_never_initialises_com() {
        let code = real_code();
        let code = code.as_str();

        let start = code.find("fn poll_loop").expect("the tier-1 loop exists");
        let body = &code[start..];
        let end = body[1..].find("\n    fn ").map(|i| i + 1).unwrap_or(body.len());
        let poll_loop = &body[..end];

        assert!(
            poll_loop.contains("follow_input_desktop"),
            "the tier-1 thread must follow the input desktop, or it can never see the lock screen",
        );
        assert!(
            !poll_loop.contains("CoInitializeEx"),
            "COM on the following thread can own a window, and SetThreadDesktop then refuses \
             for the life of the thread — the silent latched failure that kills lock-screen \
             support",
        );
        // POSITIVE CONTROL: the scan must be able to SEE a CoInitializeEx, or
        // the assertion above proves nothing about anything.
        assert!(
            code.contains("CoInitializeEx"),
            "the scan found no COM init anywhere — it is not reading real code",
        );
        // And the same for the other half of the split.
        assert!(code.contains("fn assist_loop"), "the COM thread exists");
    }

    /// The static import that must not exist.
    ///
    /// Naming `windows::...::AccessibleObjectFromWindow` anywhere adds a
    /// raw-dylib import of `oleacc.dll`, which is not a KnownDLL and is resolved
    /// before `dll_search::harden()` runs — a planted DLL loaded into a
    /// LocalSystem process. Tier 2 must go through `LoadLibraryExW` with
    /// `LOAD_LIBRARY_SEARCH_SYSTEM32`.
    #[test]
    fn oleacc_is_never_a_static_import() {
        let code = real_code();
        // The BARE symbol, not a path-qualified spelling: the way this file
        // actually imports that module is a brace list (`Accessibility::{ … }`),
        // so a regression added there never contains the text
        // `Accessibility::AccessibleObjectFromWindow` — the first version of
        // this test searched for exactly that and was blind to it. The only
        // legitimate appearances of the name are the local fn-pointer type
        // (`AccessibleObjectFromWindowFn`) and the `GetProcAddress` literal;
        // remove those and NOTHING may remain.
        let stripped = code
            .replace("AccessibleObjectFromWindowFn", "")
            .replace("s!(\"AccessibleObjectFromWindow\")", "");
        assert!(
            !stripped.contains("AccessibleObjectFromWindow"),
            "a static oleacc.dll import (any `use` of windows' AccessibleObjectFromWindow, or a \
             direct call) resolves before the DLL-search hardening — tier 2 must go through \
             LoadLibraryExW + GetProcAddress",
        );
        // POSITIVE CONTROLS: the search string is findable in the unstripped
        // code (so the negative above is not vacuous), and the dynamic route
        // really is there.
        assert!(code.contains("s!(\"AccessibleObjectFromWindow\")"));
        assert!(code.contains("LOAD_LIBRARY_SEARCH_SYSTEM32"));
        assert!(code.contains("GetProcAddress"));
    }

    /// The sampler threads must never be joinable.
    ///
    /// `StopStream` joins the stream thread; a sampler joined from anywhere
    /// reachable by that would park session teardown — and the agent pipe behind
    /// it — on a hung application's accessibility call, and `JoinHandle` has no
    /// timed join. Keeping the handle is the precondition for joining, so this
    /// asserts no handle is ever kept. (The one `join()` in this file is inside
    /// a probe helper's own scratch thread, which nothing in a session touches.)
    #[test]
    fn the_sampler_threads_are_never_joined() {
        let code = real_code();
        assert!(
            !code.contains("JoinHandle"),
            "keeping a sampler's JoinHandle is how a hung accessibility call becomes a hung \
             session teardown",
        );
        // POSITIVE CONTROL: threads really are spawned here, so the assertion
        // above is about this file's real behaviour.
        assert_eq!(
            code.matches("Builder::new()").count(),
            2,
            "the two sampler threads (tier 1, and the COM assist) are both spawned by name",
        );
    }
}
