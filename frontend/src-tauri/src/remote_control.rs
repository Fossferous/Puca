//! Remote control of a shared screen (Windows only).
//!
//! The injection layer itself now lives in `crates/puca-input`, shared with
//! the native host agent — see that crate for the scan-code and monitor-mapping
//! rationale. This module re-exports it and keeps the one piece that cannot be
//! shared: the physical-input kill switch, which emits Tauri events.

pub use puca_input::{
    detect_anticheat, inject, list_monitors, release_all, set_target,
    ControlInput, MonitorList, TargetMonitor,
};

use crate::ordered_worker::OrderedWorker;

// --- Ordered off-thread injection ------------------------------------------
//
// One worker thread, one FIFO. `inject_input` used to run SendInput on the
// webview main thread per event, so any main-thread work (renegotiation, the
// capture-bar sweep) head-of-line blocked live input. A threadpool would fix
// the blocking but lose the ORDER — the frontend fires events without
// awaiting, and a `down` overtaking its positioning move clicks the wrong
// thing. A single consumer keeps arrival order by construction.
//
// The queue is an `OrderedWorker`: the command thread only appends to an
// unbounded channel (no lock, no wait), so `inject_input` stays a SYNC command
// — the sync dispatch on the main thread is what fixes the arrival order, and
// an `async` command would lose it to the task pool.

enum InjectJob {
    Event(ControlInput),
    /// Release everything held, ordered AFTER every event queued before it.
    /// The ack lets teardown wait: returning before the release actually ran
    /// would let a still-queued `down` re-stick the key the caller believes
    /// it just released.
    ReleaseAll(std::sync::mpsc::Sender<()>),
}

static INJECT: std::sync::OnceLock<OrderedWorker<InjectJob>> = std::sync::OnceLock::new();

fn inject_worker() -> &'static OrderedWorker<InjectJob> {
    INJECT.get_or_init(|| {
        let mut refusals = RefusalThrottle::new();
        let mut prioritised = false;
        OrderedWorker::spawn("input-inject", move |job| {
            if !prioritised {
                prioritised = true;
                // Microseconds of work per event; what this thread must never
                // do is wait behind a game's threads for a CPU slice, because
                // that wait is pointer lag on the far end. HIGHEST within our
                // class (ABOVE_NORMAL while a share is boosted). Not
                // TIME_CRITICAL: that is the hook threads' budget, which has
                // an OS deadline this does not.
                #[cfg(windows)]
                // SAFETY: plain Win32 calls on the current thread's own
                // pseudo-handle; failure is logged and the thread runs at the
                // default priority, exactly as before.
                unsafe {
                    use windows::Win32::System::Threading::{
                        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST,
                    };
                    if let Err(e) = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST) {
                        log::warn!("[inject] could not raise worker thread priority: {e:?}");
                    }
                }
            }
            match job {
                InjectJob::Event(ev) => {
                    // log, not eprintln: the release build is
                    // windows_subsystem = "windows", so stderr goes
                    // nowhere and a refused injection was invisible.
                    //
                    // Throttled: while SendInput is refused (a lock
                    // screen, a UAC prompt, an admin window) EVERY
                    // event fails, at 60-125 a second, with a ~300
                    // character reason each — that filled the log
                    // file (rotated at a few MB) in minutes and buried
                    // the sampler lines it exists for. The first
                    // refusal is logged in full; after that a compact
                    // count, and one line when injection works again.
                    match inject(ev) {
                        Err(e) => match refusals.refused(std::time::Instant::now()) {
                            RefusalVerdict::First => log::warn!("[inject] {e}"),
                            RefusalVerdict::Summary(n) => {
                                log::warn!("[inject] still refused: {n} events since the first")
                            }
                            RefusalVerdict::Silent => {}
                        },
                        Ok(()) => {
                            if let Some(n) = refusals.succeeded() {
                                log::info!("[inject] injecting again after {n} refused events");
                            }
                        }
                    }
                }
                InjectJob::ReleaseAll(ack) => {
                    release_all();
                    let _ = ack.send(());
                }
            }
        })
    })
}

// --- Refusal log throttle ---------------------------------------------------
//
// The pure "log this one?" decision for the worker above, kept free of any
// I/O so it can be tested with a fake clock. Refusals come in runs (nothing
// injects until the lock screen / UAC prompt / admin window goes away), so
// the useful record is the first reason, how long the run lasted, and when
// it ended — not one line per event.

/// What the worker should do with one more refused injection.
#[derive(Debug, PartialEq, Eq)]
enum RefusalVerdict {
    /// First refusal since injection last worked: log the reason in full.
    First,
    /// Still refused; log a compact count of events since the first one.
    Summary(u64),
    /// Say nothing.
    Silent,
}

struct RefusalThrottle {
    /// Refusals since injection last succeeded (0 = injecting fine).
    refused: u64,
    /// The next `events since the first` count that earns a summary line:
    /// 10, 100, 1000, ... — so a long run costs O(log n) lines by count.
    next_mark: u64,
    /// When something was last logged for this run (bounds the silence in
    /// time as well: a run that never reaches the next mark still reports).
    last_log: Option<std::time::Instant>,
}

impl RefusalThrottle {
    /// Longest silence between two lines of one refused run.
    const SUMMARY_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

    fn new() -> Self {
        Self { refused: 0, next_mark: 10, last_log: None }
    }

    /// One more event was refused at `now`.
    fn refused(&mut self, now: std::time::Instant) -> RefusalVerdict {
        self.refused = self.refused.saturating_add(1);
        if self.refused == 1 {
            self.next_mark = 10;
            self.last_log = Some(now);
            return RefusalVerdict::First;
        }
        let since_first = self.refused - 1;
        let due_by_count = since_first >= self.next_mark;
        let due_by_time = self
            .last_log
            .map_or(true, |t| now.saturating_duration_since(t) >= Self::SUMMARY_EVERY);
        if !(due_by_count || due_by_time) {
            return RefusalVerdict::Silent;
        }
        while self.next_mark <= since_first {
            self.next_mark = self.next_mark.saturating_mul(10);
        }
        self.last_log = Some(now);
        RefusalVerdict::Summary(since_first)
    }

    /// An event injected fine. `Some(n)` exactly once when that ends a run
    /// of `n` refusals; `None` while injection was already working.
    fn succeeded(&mut self) -> Option<u64> {
        if self.refused == 0 {
            return None;
        }
        let n = self.refused;
        self.refused = 0;
        self.last_log = None;
        Some(n)
    }
}

#[cfg(test)]
mod refusal_throttle_tests {
    use super::{RefusalThrottle, RefusalVerdict};
    use std::time::{Duration, Instant};

    #[test]
    fn first_refusal_logs_in_full_then_goes_quiet() {
        let t0 = Instant::now();
        let mut th = RefusalThrottle::new();
        assert_eq!(th.refused(t0), RefusalVerdict::First);
        for _ in 0..8 {
            assert_eq!(th.refused(t0), RefusalVerdict::Silent);
        }
    }

    #[test]
    fn summaries_land_at_powers_of_ten_since_the_first() {
        let t0 = Instant::now();
        let mut th = RefusalThrottle::new();
        let mut logged = Vec::new();
        for i in 1..=2000u64 {
            match th.refused(t0) {
                RefusalVerdict::First => assert_eq!(i, 1),
                RefusalVerdict::Summary(n) => logged.push(n),
                RefusalVerdict::Silent => {}
            }
        }
        // 2000 refusals within the same instant: exactly the count marks.
        assert_eq!(logged, vec![10, 100, 1000]);
    }

    #[test]
    fn a_slow_run_still_reports_every_five_seconds() {
        let t0 = Instant::now();
        let mut th = RefusalThrottle::new();
        assert_eq!(th.refused(t0), RefusalVerdict::First);
        assert_eq!(th.refused(t0 + Duration::from_secs(4)), RefusalVerdict::Silent);
        assert_eq!(th.refused(t0 + Duration::from_secs(5)), RefusalVerdict::Summary(2));
        // The clock restarts from the summary, not from the first refusal.
        assert_eq!(th.refused(t0 + Duration::from_secs(9)), RefusalVerdict::Silent);
        assert_eq!(th.refused(t0 + Duration::from_secs(10)), RefusalVerdict::Summary(4));
    }

    #[test]
    fn a_time_summary_does_not_double_up_with_the_count_mark() {
        let t0 = Instant::now();
        let mut th = RefusalThrottle::new();
        assert_eq!(th.refused(t0), RefusalVerdict::First);
        for _ in 0..9 {
            assert_eq!(th.refused(t0), RefusalVerdict::Silent);
        }
        // since_first == 10 exactly at the mark; a 5 s gap at the same event
        // must yield ONE line and advance the mark past 10.
        assert_eq!(th.refused(t0 + Duration::from_secs(6)), RefusalVerdict::Summary(10));
        assert_eq!(th.refused(t0 + Duration::from_secs(6)), RefusalVerdict::Silent);
    }

    #[test]
    fn success_reports_once_and_resets_the_run() {
        let t0 = Instant::now();
        let mut th = RefusalThrottle::new();
        // Positive control: nothing to report while injection works.
        assert_eq!(th.succeeded(), None);
        assert_eq!(th.refused(t0), RefusalVerdict::First);
        assert_eq!(th.refused(t0), RefusalVerdict::Silent);
        assert_eq!(th.refused(t0), RefusalVerdict::Silent);
        assert_eq!(th.succeeded(), Some(3));
        assert_eq!(th.succeeded(), None);
        // The next run starts over: full reason again, marks from 10.
        assert_eq!(th.refused(t0 + Duration::from_secs(60)), RefusalVerdict::First);
        let mut summaries = 0;
        for _ in 0..10 {
            if let RefusalVerdict::Summary(n) = th.refused(t0 + Duration::from_secs(60)) {
                assert_eq!(n, 10);
                summaries += 1;
            }
        }
        assert_eq!(summaries, 1);
    }
}

/// Enqueue one event for the injection worker. Errors surface only for a
/// dead queue — per-event inject failures are logged on the worker, exactly
/// as the fire-and-forget frontend treated them before. Never waits.
pub fn inject_queued(event: ControlInput) -> Result<(), String> {
    inject_worker()
        .send(InjectJob::Event(event))
        .map_err(|_| "inject worker is gone".to_string())
}

/// Queue a release of everything held BEHIND every event already queued, and
/// return at once. The receiver is acked once the release has run; `None` =
/// the worker is gone and nothing was queued.
fn queue_release_all() -> Option<std::sync::mpsc::Receiver<()>> {
    let (ack_tx, ack_rx) = std::sync::mpsc::channel();
    inject_worker().send(InjectJob::ReleaseAll(ack_tx)).ok().map(|_| ack_rx)
}

/// Wait (bounded) for a release queued by `queue_release_all`, and release
/// inline if it never ran — a possibly-misordered release beats no release.
fn finish_release_all(ack: Option<std::sync::mpsc::Receiver<()>>) {
    let ran = ack.is_some_and(|rx| rx.recv_timeout(std::time::Duration::from_millis(500)).is_ok());
    if !ran {
        release_all();
    }
}

/// Release held keys/buttons AFTER everything already queued has injected.
/// Falls back to an inline release if the worker is unavailable or slow —
/// a possibly-misordered release beats no release. WAITS up to 500 ms: keep
/// it off the UI thread unless the wait is the point (app exit).
pub fn release_all_ordered() {
    finish_release_all(queue_release_all());
}

// --- Physical-input kill switch -------------------------------------------
//
// While a viewer is controlling, the host runs a low-level keyboard hook (and
// a mouse hook too, but only while the opt-in any-input kill is on). Real host
// input (the OS does NOT flag it injected) fires a one-shot
// "host-input-detected" event, and the frontend revokes control — so the
// moment the host touches their own mouse/keyboard, the remote controller is
// dropped. Our own SendInput events are injected (flagged), so they never
// trip it. The custom kill-switch key fires "host-killswitch-hotkey".
//
// Best-effort and fail-safe: if the hook can't install, the manual Stop button
// in the banner still ends the session.

/// Who owns the guard's hook thread — the state machine, kept free of Win32
/// so every start/stop/unwind interleaving can be tested.
///
/// It replaces `ACTIVE` + `THREAD_ID`, which lost ownership three ways (all
/// the same races hotkeys.rs had already fixed for its own hook thread):
/// - two starts before the first thread had published its id each spawned a
///   thread — the second set of system-wide hooks was never reachable again;
/// - a stop before the thread published its id posted nothing, and the
///   thread then pumped forever with live hooks;
/// - an old thread finishing its unwind zeroed its SUCCESSOR's id, so no
///   later stop could reach the successor and every start stacked another.
///
/// One atomic state word carries the whole truth:
/// `IDLE` no thread · `WANTED` a thread is (or is about to be) pumping and
/// should · `STOPPING` it has been asked to leave · `EXITING` it is unwinding.
/// Exactly one thread can exist (spawning needs IDLE→WANTED), a start that
/// lands while the thread has merely been ASKED to leave takes it back
/// (STOPPING→WANTED) instead of spawning beside it, and the thread's own
/// decision to leave is a STOPPING→EXITING swap that such a start cannot slip
/// between. The id slot is only ever cleared by the thread that owns it.
#[cfg(any(windows, test))]
pub(crate) struct GuardLifecycle {
    state: std::sync::atomic::AtomicU8,
    tid: std::sync::atomic::AtomicU32,
}

#[cfg(any(windows, test))]
const GUARD_IDLE: u8 = 0;
#[cfg(any(windows, test))]
const GUARD_WANTED: u8 = 1;
#[cfg(any(windows, test))]
const GUARD_STOPPING: u8 = 2;
#[cfg(any(windows, test))]
const GUARD_EXITING: u8 = 3;

/// What `start` must do.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartPlan {
    /// No thread: spawn one (ownership is already claimed).
    Spawn,
    /// A thread exists and is wanted: tell it the configuration changed
    /// (0 = it has not published its id yet; it will read the new
    /// configuration itself).
    Reconfigure(u32),
    /// The previous thread is unwinding: wait for it, then ask again.
    WaitForUnwind,
}

#[cfg(any(windows, test))]
impl GuardLifecycle {
    pub const fn new() -> Self {
        Self {
            state: std::sync::atomic::AtomicU8::new(GUARD_IDLE),
            tid: std::sync::atomic::AtomicU32::new(0),
        }
    }

    fn cas(&self, from: u8, to: u8) -> bool {
        use std::sync::atomic::Ordering::SeqCst;
        self.state.compare_exchange(from, to, SeqCst, SeqCst).is_ok()
    }

    pub fn begin_start(&self) -> StartPlan {
        use std::sync::atomic::Ordering::SeqCst;
        loop {
            match self.state.load(SeqCst) {
                GUARD_IDLE => {
                    if self.cas(GUARD_IDLE, GUARD_WANTED) {
                        return StartPlan::Spawn;
                    }
                }
                GUARD_WANTED => return StartPlan::Reconfigure(self.tid.load(SeqCst)),
                GUARD_STOPPING => {
                    if self.cas(GUARD_STOPPING, GUARD_WANTED) {
                        return StartPlan::Reconfigure(self.tid.load(SeqCst));
                    }
                }
                _ => return StartPlan::WaitForUnwind,
            }
        }
    }

    /// The thread id to post a stop request to, if there is a thread that has
    /// published one. A thread that has not published yet needs no message:
    /// it checks the state before it ever pumps.
    pub fn begin_stop(&self) -> Option<u32> {
        use std::sync::atomic::Ordering::SeqCst;
        if self.cas(GUARD_WANTED, GUARD_STOPPING) {
            let tid = self.tid.load(SeqCst);
            return (tid != 0).then_some(tid);
        }
        None
    }

    /// Read by the hook procs: is a revoke wanted right now?
    pub fn is_wanted(&self) -> bool {
        self.state.load(std::sync::atomic::Ordering::SeqCst) == GUARD_WANTED
    }

    /// No thread exists (stop's bounded wait ends here).
    pub fn is_idle(&self) -> bool {
        self.state.load(std::sync::atomic::Ordering::SeqCst) == GUARD_IDLE
    }

    /// Thread side, FIRST act: make the thread reachable. Its message queue
    /// must already exist (PostThreadMessageW fails without one).
    pub fn thread_publish(&self, tid: u32) {
        self.tid.store(tid, std::sync::atomic::Ordering::SeqCst);
    }

    /// Thread side, after installing its hooks: start pumping, or leave
    /// because a stop arrived before the thread was reachable.
    pub fn thread_may_pump(&self) -> bool {
        self.thread_keep_running()
    }

    /// Thread side, on a stop request: `true` = leave now. A start that
    /// arrived after the stop has taken the thread back, and it stays.
    pub fn thread_on_stop_request(&self) -> bool {
        !self.thread_keep_running()
    }

    fn thread_keep_running(&self) -> bool {
        use std::sync::atomic::Ordering::SeqCst;
        loop {
            match self.state.load(SeqCst) {
                GUARD_WANTED => return true,
                GUARD_STOPPING => {
                    if self.cas(GUARD_STOPPING, GUARD_EXITING) {
                        return false;
                    }
                }
                _ => return false,
            }
        }
    }

    /// Thread side, LAST act, after its hooks are removed: release the id
    /// slot, then ownership. The compare-exchange is belt-and-braces, not
    /// load-bearing (a mutation check confirms the tests cannot tell it from
    /// a plain store): no successor can exist before the IDLE store below,
    /// so the slot is always still ours. It keeps that true if the state
    /// machine ever stops guaranteeing it — the unconditional store it
    /// replaces is exactly how a successor used to become unreachable.
    pub fn thread_exited(&self, tid: u32) {
        use std::sync::atomic::Ordering::SeqCst;
        let _ = self.tid.compare_exchange(tid, 0, SeqCst, SeqCst);
        self.state.store(GUARD_IDLE, SeqCst);
    }
}

/// The guard's mouse hook exists only for the opt-in any-input kill; the
/// kill-switch KEY needs the keyboard hook alone. In the default
/// configuration the mouse hook did nothing but put every mouse event on the
/// machine through this process for the whole session.
#[cfg(any(windows, test))]
fn guard_wants_mouse_hook(any_input: bool) -> bool {
    any_input
}

#[cfg(any(windows, test))]
fn arm_guard<O: crate::ll_hook::HookOps>(set: &mut crate::ll_hook::HookSet<O::Hook>, ops: &mut O, any_input: bool) {
    set.arm(ops, guard_wants_mouse_hook(any_input));
}

/// The any-input setting changed mid-session: add or remove the mouse hook in
/// place, on the hook thread, without touching the keyboard hook.
#[cfg(any(windows, test))]
fn on_guard_reconfig<O: crate::ll_hook::HookOps>(
    set: &mut crate::ll_hook::HookSet<O::Hook>,
    ops: &mut O,
    any_input: bool,
) -> crate::ll_hook::HookStep {
    set.sync_mouse(ops, guard_wants_mouse_hook(any_input))
}

#[cfg(windows)]
mod guard {
    use super::{arm_guard, on_guard_reconfig, GuardLifecycle, StartPlan};
    use crate::ll_hook::{HookSet, HookStep, Win32LowLevelHooks};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::{
        GetCurrentThread, GetCurrentThreadId, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, KBDLLHOOKSTRUCT,
        LLKHF_INJECTED, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, WM_APP, WM_KEYDOWN,
        WM_SYSKEYDOWN, WM_USER,
    };

    static LIFE: GuardLifecycle = GuardLifecycle::new();
    static FIRED: AtomicBool = AtomicBool::new(false);
    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// Serialises start/stop. Held only by the guard's lifecycle worker,
    /// never by the hook thread or its procs.
    static LIFECYCLE: Mutex<()> = Mutex::new(());

    /// Leave now (unless a later start took the thread back).
    const WM_GUARD_STOP: u32 = WM_APP + 0x51;
    /// The configuration changed: re-read whether the mouse hook is wanted.
    const WM_GUARD_RECONFIG: u32 = WM_APP + 0x52;

    // Config (set by start(), read on the hook thread):
    // ANY_INPUT — revoke on ANY physical host input (opt-in).
    // KILL_VK   — the always-on custom kill-switch virtual key (0 = none).
    // KILL_MODS — required modifier bitmask for the kill key: 1=Ctrl 2=Alt 4=Shift.
    static ANY_INPUT: AtomicBool = AtomicBool::new(false);
    static KILL_VK: AtomicU32 = AtomicU32::new(0);
    static KILL_MODS: AtomicU32 = AtomicU32::new(0);

    const MOD_CTRL: u32 = 1;
    const MOD_ALT: u32 = 2;
    const MOD_SHIFT: u32 = 4;

    /// What the hook thread and the procs hand to the emitter thread.
    enum GuardOut {
        Emit(&'static str),
        Warn(&'static str, i32),
    }

    /// `app.emit` used to run INSIDE the hook procs. It serialises a payload
    /// and walks the runtime's listener plumbing — latency that is not ours to
    /// bound, inside a callback Windows times (LowLevelHooksTimeout) and holds
    /// every input event on the machine for. hotkeys.rs moved its emit out for
    /// exactly that reason; the guard now does the same: procs and the hook
    /// thread only append to this channel (never blocking), and a
    /// process-lifetime thread does the slow part. Created by `start()`, on
    /// the lifecycle worker — never lazily from a proc.
    static OUT: OnceLock<std::sync::mpsc::Sender<GuardOut>> = OnceLock::new();

    fn ensure_emitter() {
        OUT.get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::channel::<GuardOut>();
            let _ = std::thread::Builder::new().name("control-guard-emit".into()).spawn(move || {
                for out in rx {
                    match out {
                        GuardOut::Emit(event) => {
                            if let Some(app) = APP.get() {
                                let _ = app.emit(event, ());
                            }
                        }
                        GuardOut::Warn(what, code) => {
                            log::warn!("[control-guard] {what} (0x{:08X})", code as u32);
                        }
                    }
                }
            });
            tx
        });
    }

    fn out(o: GuardOut) {
        if let Some(tx) = OUT.get() {
            let _ = tx.send(o);
        }
    }

    /// Fire a one-shot revoke via the given event (deduped by FIRED). Runs in
    /// the hook procs: atomics and a channel append only.
    fn fire(event: &'static str) {
        if LIFE.is_wanted() && !FIRED.swap(true, Ordering::SeqCst) {
            out(GuardOut::Emit(event));
        }
    }

    /// True if the live modifier state matches the configured KILL_MODS exactly
    /// (so Ctrl+Shift+K doesn't fire a plain-K binding, and vice versa).
    unsafe fn modifiers_match() -> bool {
        let want = KILL_MODS.load(Ordering::SeqCst);
        let down = |vk| (GetAsyncKeyState(vk) as u16 & 0x8000) != 0;
        let have = (if down(VK_CONTROL.0 as i32) { MOD_CTRL } else { 0 })
            | (if down(VK_MENU.0 as i32) { MOD_ALT } else { 0 })
            | (if down(VK_SHIFT.0 as i32) { MOD_SHIFT } else { 0 });
        have == want
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && ANY_INPUT.load(Ordering::SeqCst) {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            if info.flags & LLMHF_INJECTED == 0 {
                fire("host-input-detected");
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    unsafe extern "system" fn kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let injected = info.flags.0 & LLKHF_INJECTED.0 != 0;
            if !injected {
                let msg = wparam.0 as u32;
                let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                let kill_vk = KILL_VK.load(Ordering::SeqCst);
                if is_down && kill_vk != 0 && info.vkCode == kill_vk && modifiers_match() {
                    // The custom kill-switch hotkey always works, even when a
                    // controlled game has focus.
                    fire("host-killswitch-hotkey");
                } else if ANY_INPUT.load(Ordering::SeqCst) {
                    fire("host-input-detected");
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    /// The hook thread. Nothing here logs or emits directly once a hook is
    /// installed: this thread services the hooks, so any wait on it is a wait
    /// on every input event on the machine.
    fn hook_thread() {
        unsafe {
            let my_tid = GetCurrentThreadId();
            // Create this thread's message queue BEFORE publishing the id:
            // PostThreadMessageW to a thread that has no queue yet fails, and
            // a stop request lost that way is exactly the orphan this
            // ordering exists to prevent.
            let mut msg = MSG::default();
            let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
            LIFE.thread_publish(my_tid);

            // Same reasoning as the hotkey hook thread: the callback's
            // latency budget is wall time, including waiting to be scheduled
            // behind a game and the encoder. Microseconds of work per event.
            if let Err(e) = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL) {
                out(GuardOut::Warn("could not raise the hook thread's priority", e.code().0));
            }

            let mut ops = Win32LowLevelHooks::new(Some(kbd_proc), Some(mouse_proc));
            let mut hooks = HookSet::new();
            arm_guard(&mut hooks, &mut ops, ANY_INPUT.load(Ordering::SeqCst));
            if hooks.keyboard.is_none() {
                out(GuardOut::Warn(
                    "keyboard hook refused: the kill-switch key is inactive (the Stop button still works)",
                    ops.keyboard_error.unwrap_or(0),
                ));
            }
            if ANY_INPUT.load(Ordering::SeqCst) && hooks.mouse.is_none() {
                out(GuardOut::Warn("mouse hook refused: mouse input will not revoke control", ops.mouse_error.unwrap_or(0)));
            }

            if LIFE.thread_may_pump() {
                loop {
                    let r = GetMessageW(&mut msg, None, 0, 0).0;
                    if r == 0 || r == -1 {
                        break; // WM_QUIT (0) or error (-1)
                    }
                    match msg.message {
                        WM_GUARD_STOP => {
                            if LIFE.thread_on_stop_request() {
                                break;
                            }
                        }
                        WM_GUARD_RECONFIG => {
                            let want = ANY_INPUT.load(Ordering::SeqCst);
                            if on_guard_reconfig(&mut hooks, &mut ops, want) == HookStep::Install
                                && hooks.mouse.is_none()
                            {
                                out(GuardOut::Warn(
                                    "mouse hook refused: mouse input will not revoke control",
                                    ops.mouse_error.unwrap_or(0),
                                ));
                            }
                        }
                        _ => {}
                    }
                }
            }

            hooks.disarm(&mut ops);
            LIFE.thread_exited(my_tid);
        }
    }

    fn post(tid: u32, message: u32) {
        // SAFETY: posting a plain message to a thread id; a dead or queueless
        // thread just makes the call fail, which the state machine tolerates
        // (a thread that is not reachable yet checks the state before pumping).
        unsafe {
            let _ = PostThreadMessageW(tid, message, WPARAM(0), LPARAM(0));
        }
    }

    /// Runs on the guard's lifecycle worker (see `start_guard`), never on the
    /// UI thread: it may wait for a predecessor to unwind.
    pub fn start(app: AppHandle, any_input: bool, kill_vk: u32, kill_mods: u32) {
        let _lifecycle = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
        let _ = APP.set(app);
        ensure_emitter();
        FIRED.store(false, Ordering::SeqCst);
        ANY_INPUT.store(any_input, Ordering::SeqCst);
        KILL_VK.store(kill_vk, Ordering::SeqCst);
        KILL_MODS.store(kill_mods, Ordering::SeqCst);
        // ~1 s for a predecessor's unwind (two UnhookWindowsHookEx calls;
        // normally microseconds). Bounded so a wedged thread cannot hold the
        // worker, and every later start/stop behind it, forever.
        for _ in 0..500 {
            match LIFE.begin_start() {
                StartPlan::Spawn => {
                    let spawned = std::thread::Builder::new()
                        .name("control-guard-hooks".into())
                        .spawn(hook_thread);
                    if let Err(e) = spawned {
                        log::error!("[control-guard] could not start the hook thread: {e} (the Stop button still works)");
                        LIFE.thread_exited(0);
                    }
                    return;
                }
                StartPlan::Reconfigure(tid) => {
                    // Already running: the config above is live for the procs;
                    // the thread re-checks whether it needs the mouse hook. A
                    // thread that has not published its id reads it itself.
                    if tid != 0 {
                        post(tid, WM_GUARD_RECONFIG);
                    }
                    return;
                }
                StartPlan::WaitForUnwind => std::thread::sleep(std::time::Duration::from_millis(2)),
            }
        }
        log::error!("[control-guard] previous hook thread never finished unwinding: guard NOT started (the Stop button still works)");
    }

    /// Runs on the guard's lifecycle worker. Returns once the hook thread has
    /// unwound (bounded), so no system-wide hook outlives the session.
    pub fn stop() {
        let _lifecycle = LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tid) = LIFE.begin_stop() {
            post(tid, WM_GUARD_STOP);
        }
        for _ in 0..500 {
            if LIFE.is_idle() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        log::warn!("[control-guard] stop: hook thread did not exit within 1 s");
    }
}

/// Work for the guard's lifecycle worker. The guard commands are SYNC so the
/// order they arrive in is the order they run in (a `stop` must never
/// overtake the `start` in front of it); all they do on the UI thread is
/// append here.
#[cfg(windows)]
enum GuardJob {
    Start { app: tauri::AppHandle, any_input: bool, kill_vk: u32, kill_mods: u32 },
    Stop { release_ack: Option<std::sync::mpsc::Receiver<()>> },
}

#[cfg(windows)]
static GUARD_JOBS: std::sync::OnceLock<OrderedWorker<GuardJob>> = std::sync::OnceLock::new();

#[cfg(windows)]
fn guard_jobs() -> &'static OrderedWorker<GuardJob> {
    GUARD_JOBS.get_or_init(|| {
        OrderedWorker::spawn("control-guard", |job| match job {
            GuardJob::Start { app, any_input, kill_vk, kill_mods } => {
                guard::start(app, any_input, kill_vk, kill_mods)
            }
            GuardJob::Stop { release_ack } => {
                guard::stop();
                finish_release_all(release_ack);
            }
        })
    })
}

/// Start the host-side kill switch (Windows only). `any_input` = revoke on any
/// physical host input (opt-in); `kill_vk`/`kill_mods` = the always-on custom
/// kill-switch hotkey (virtual key + modifier bitmask 1=Ctrl 2=Alt 4=Shift;
/// vk 0 disables the hotkey). Called again while running, it just updates the
/// live configuration. Never waits: the work runs on the guard's own worker.
#[cfg(windows)]
pub fn start_guard(app: tauri::AppHandle, any_input: bool, kill_vk: u32, kill_mods: u32) {
    if guard_jobs().send(GuardJob::Start { app, any_input, kill_vk, kill_mods }).is_err() {
        log::error!("[control-guard] worker gone: guard not started (the Stop button still works)");
    }
}

/// Stop the physical-input kill switch (and release any held input, so ending a
/// session can never leave a key/button stuck down). Never waits.
///
/// The release is QUEUED HERE, on the calling thread, so it lands in the
/// injection FIFO exactly where it always did — behind every event that
/// arrived before this stop. Only the waiting (the hook thread's unwind, the
/// release's acknowledgement and its inline fallback) moves to the worker.
#[cfg(windows)]
pub fn stop_guard() {
    let release_ack = queue_release_all();
    if let Err(GuardJob::Stop { release_ack }) = guard_jobs().send(GuardJob::Stop { release_ack }) {
        // No worker: do it here rather than not at all.
        finish_release_all(release_ack);
    }
}

#[cfg(not(windows))]
pub fn start_guard(_app: tauri::AppHandle, _any_input: bool, _kill_vk: u32, _kill_mods: u32) {}

#[cfg(not(windows))]
pub fn stop_guard() {}

#[cfg(test)]
mod guard_tests {
    use super::{arm_guard, on_guard_reconfig, GuardLifecycle, StartPlan};
    use crate::ll_hook::fake::{Call, FakeHooks, Kind};
    use crate::ll_hook::{HookSet, HookStep};
    use std::collections::VecDeque;

    // --- The mouse hook follows the any-input setting ----------------------

    #[test]
    fn the_default_guard_installs_no_mouse_hook() {
        // remoteControlAnyInputKill is off by default: only the kill KEY is
        // armed, and a key needs only the keyboard hook.
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        arm_guard(&mut set, &mut ops, false);
        assert_eq!(ops.mouse_installs(), 0, "a mouse hook nobody reads delays every mouse event on the machine");
        assert!(set.keyboard.is_some(), "the kill-switch key needs the keyboard hook");
    }

    #[test]
    fn positive_control_the_any_input_kill_does_install_it() {
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        arm_guard(&mut set, &mut ops, true);
        assert_eq!(ops.mouse_installs(), 1);
        assert!(set.mouse.is_some());
    }

    #[test]
    fn turning_the_any_input_kill_on_mid_session_adds_the_mouse_hook_in_place() {
        let mut ops = FakeHooks::default();
        let mut set = HookSet::new();
        arm_guard(&mut set, &mut ops, false);
        ops.calls.clear();
        assert_eq!(on_guard_reconfig(&mut set, &mut ops, true), HookStep::Install);
        assert_eq!(ops.calls, vec![Call::Install(Kind::Mouse)], "the keyboard hook must not be touched");
        assert_eq!(on_guard_reconfig(&mut set, &mut ops, false), HookStep::Remove);
        assert!(set.mouse.is_none());
        assert!(set.keyboard.is_some());
    }

    // --- Ownership: every interleaving leaves the right number of owners ---
    //
    // A deterministic simulation of the real start()/stop()/hook_thread()
    // sequence, driving the SAME GuardLifecycle methods they call, with the
    // hook thread reduced to its lifecycle steps and PostThreadMessageW to a
    // mailbox. Each test either scripts one schedule or explores every
    // interleaving of the given operations with the threads' steps.

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Msg {
        Stop,
        Reconfig,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Pc {
        /// Spawned; has not published its id (no queue yet either).
        Spawned,
        /// Published and hooked; about to decide whether to pump.
        Published,
        Pumping,
        /// Decided to leave; removing its hooks. Still alive: a start that
        /// lands here must wait for it rather than spawn beside it.
        Unwinding,
        Exited,
    }

    #[derive(Clone, Debug)]
    struct SimThread {
        tid: u32,
        pc: Pc,
        mailbox: VecDeque<Msg>,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Op {
        Start,
        Stop,
    }

    struct World {
        life: GuardLifecycle,
        threads: Vec<SimThread>,
        next_tid: u32,
        max_alive: usize,
    }

    impl Clone for World {
        fn clone(&self) -> Self {
            use std::sync::atomic::Ordering::SeqCst;
            let life = GuardLifecycle::new();
            life.state.store(self.life.state.load(SeqCst), SeqCst);
            life.tid.store(self.life.tid.load(SeqCst), SeqCst);
            Self { life, threads: self.threads.clone(), next_tid: self.next_tid, max_alive: self.max_alive }
        }
    }

    impl World {
        fn new() -> Self {
            Self { life: GuardLifecycle::new(), threads: Vec::new(), next_tid: 100, max_alive: 0 }
        }

        fn alive(&self) -> Vec<&SimThread> {
            self.threads.iter().filter(|t| t.pc != Pc::Exited).collect()
        }

        fn note(&mut self) {
            self.max_alive = self.max_alive.max(self.alive().len());
        }

        fn post(&mut self, tid: u32, m: Msg) {
            // PostThreadMessageW reaches a live thread that has a queue.
            if let Some(t) = self
                .threads
                .iter_mut()
                .find(|t| t.tid == tid && matches!(t.pc, Pc::Published | Pc::Pumping | Pc::Unwinding))
            {
                t.mailbox.push_back(m);
            }
        }

        /// What guard::start() does. `false` = it would have to wait.
        fn op_start(&mut self) -> bool {
            match self.life.begin_start() {
                StartPlan::Spawn => {
                    let tid = self.next_tid;
                    self.next_tid += 1;
                    self.threads.push(SimThread { tid, pc: Pc::Spawned, mailbox: VecDeque::new() });
                }
                StartPlan::Reconfigure(tid) => {
                    if tid != 0 {
                        self.post(tid, Msg::Reconfig);
                    }
                }
                StartPlan::WaitForUnwind => return false,
            }
            self.note();
            true
        }

        /// What guard::stop() does (its bounded wait only delays the next op,
        /// which the exploration covers by trying every order anyway).
        fn op_stop(&mut self) {
            if let Some(tid) = self.life.begin_stop() {
                self.post(tid, Msg::Stop);
            }
            self.note();
        }

        fn can_step(&self, i: usize) -> bool {
            let t = &self.threads[i];
            match t.pc {
                Pc::Spawned | Pc::Published | Pc::Unwinding => true,
                Pc::Pumping => !t.mailbox.is_empty(),
                Pc::Exited => false,
            }
        }

        /// One step of hook_thread().
        fn step(&mut self, i: usize) {
            let tid = self.threads[i].tid;
            match self.threads[i].pc {
                Pc::Spawned => {
                    self.life.thread_publish(tid);
                    self.threads[i].pc = Pc::Published;
                }
                Pc::Published => {
                    self.threads[i].pc = if self.life.thread_may_pump() { Pc::Pumping } else { Pc::Unwinding };
                }
                Pc::Pumping => match self.threads[i].mailbox.pop_front() {
                    Some(Msg::Stop) => {
                        if self.life.thread_on_stop_request() {
                            self.threads[i].pc = Pc::Unwinding;
                        }
                    }
                    Some(Msg::Reconfig) | None => {}
                },
                Pc::Unwinding => {
                    self.life.thread_exited(tid);
                    self.threads[i].pc = Pc::Exited;
                }
                Pc::Exited => {}
            }
            self.note();
        }

        fn run_threads(&mut self) {
            while let Some(i) = (0..self.threads.len()).find(|&i| self.can_step(i)) {
                self.step(i);
            }
        }

        /// The invariant after the LAST op has settled.
        fn check_settled(&self, last: Op) -> Result<(), String> {
            use std::sync::atomic::Ordering::SeqCst;
            if self.max_alive > 1 {
                return Err(format!("{} hook threads alive at once (a second set of system-wide hooks)", self.max_alive));
            }
            let alive = self.alive();
            match last {
                Op::Start => {
                    if alive.len() != 1 || alive[0].pc != Pc::Pumping {
                        return Err(format!("after a start: expected one pumping hook thread, got {alive:?}"));
                    }
                    let published = self.life.tid.load(SeqCst);
                    if published != alive[0].tid {
                        return Err(format!(
                            "the live hook thread {} is UNREACHABLE: stop() would post to {published}",
                            alive[0].tid
                        ));
                    }
                    if !self.life.is_wanted() {
                        return Err("the live hook thread's procs are disarmed".into());
                    }
                }
                Op::Stop => {
                    if !alive.is_empty() {
                        return Err(format!("after a stop: a hook thread is still alive: {alive:?}"));
                    }
                }
            }
            Ok(())
        }
    }

    /// Every interleaving of `ops` (in order) with the hook threads' steps.
    fn explore(world: World, ops: &[Op], last: Op, seen: &mut usize) -> Result<(), String> {
        if world.max_alive > 1 {
            return Err(format!("{} hook threads alive at once", world.max_alive));
        }
        let mut moved = false;
        if let Some((&op, rest)) = ops.split_first() {
            let mut w = world.clone();
            let progressed = match op {
                Op::Start => w.op_start(),
                Op::Stop => {
                    w.op_stop();
                    true
                }
            };
            if progressed {
                moved = true;
                explore(w, rest, last, seen)?;
            }
        }
        for i in 0..world.threads.len() {
            if world.can_step(i) {
                moved = true;
                let mut w = world.clone();
                w.step(i);
                explore(w, ops, last, seen)?;
            }
        }
        if !moved {
            *seen += 1;
            if !ops.is_empty() {
                return Err(format!("stuck: {ops:?} can never proceed (a start waiting on a thread that never unwinds)"));
            }
            return world.check_settled(last);
        }
        Ok(())
    }

    fn explore_all(ops: &[Op]) -> Result<usize, String> {
        let mut seen = 0;
        explore(World::new(), ops, *ops.last().unwrap(), &mut seen)?;
        Ok(seen)
    }

    #[test]
    fn positive_control_one_start_is_one_reachable_owner() {
        let mut w = World::new();
        assert!(w.op_start());
        w.run_threads();
        w.check_settled(Op::Start).unwrap();
    }

    #[test]
    fn a_second_start_before_the_first_thread_publishes_spawns_nothing() {
        let mut w = World::new();
        assert!(w.op_start());
        // The first thread has not run a single instruction yet.
        assert!(w.op_start());
        assert_eq!(w.threads.len(), 1, "two starts in the install window spawned two hook threads");
        w.run_threads();
        w.check_settled(Op::Start).unwrap();
    }

    #[test]
    fn a_stop_before_the_thread_publishes_still_ends_it() {
        let mut w = World::new();
        assert!(w.op_start());
        w.op_stop(); // no id to post to yet
        w.run_threads();
        w.check_settled(Op::Stop).unwrap();
    }

    #[test]
    fn stop_then_start_while_the_old_thread_unwinds_leaves_one_reachable_owner() {
        // The skeptic's sequence: stop() posts to T1, start() runs before T1
        // has handled it, then T1 handles it.
        let mut w = World::new();
        assert!(w.op_start());
        w.run_threads(); // T1 published and pumping
        w.op_stop();
        while !w.op_start() {
            w.run_threads();
        }
        w.run_threads();
        w.check_settled(Op::Start).unwrap();
    }

    #[test]
    fn every_interleaving_of_start_start_ends_with_one_reachable_owner() {
        explore_all(&[Op::Start, Op::Start]).unwrap();
    }

    #[test]
    fn every_interleaving_of_start_stop_ends_with_no_hook_thread() {
        explore_all(&[Op::Start, Op::Stop]).unwrap();
    }

    #[test]
    fn every_interleaving_of_start_stop_start_ends_with_one_reachable_owner() {
        let n = explore_all(&[Op::Start, Op::Stop, Op::Start]).unwrap();
        // Lower bound: the stop and the second start can each land before
        // the first thread publishes, before it decides to pump, or while it
        // pumps — six ordered placements, each its own schedule (7 today).
        assert!(n >= 6, "the exploration must actually branch (saw {n} schedules)");
    }

    #[test]
    fn every_interleaving_of_start_stop_start_stop_ends_with_no_hook_thread() {
        explore_all(&[Op::Start, Op::Stop, Op::Start, Op::Stop]).unwrap();
    }

    #[test]
    fn every_interleaving_of_a_settings_restart_mid_session_keeps_one_owner() {
        // settingsChanged re-invokes start while armed, around a session end.
        explore_all(&[Op::Start, Op::Start, Op::Stop, Op::Start]).unwrap();
    }
}
