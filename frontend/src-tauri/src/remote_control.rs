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

// --- Ordered off-thread injection ------------------------------------------
//
// One worker thread, one FIFO. `inject_input` used to run SendInput on the
// webview main thread per event, so any main-thread work (renegotiation, the
// capture-bar sweep) head-of-line blocked live input. A threadpool would fix
// the blocking but lose the ORDER — the frontend fires events without
// awaiting, and a `down` overtaking its positioning move clicks the wrong
// thing. A single consumer keeps arrival order by construction.

enum InjectJob {
    Event(ControlInput),
    /// Release everything held, ordered AFTER every event queued before it.
    /// The ack lets teardown wait: returning before the release actually ran
    /// would let a still-queued `down` re-stick the key the caller believes
    /// it just released.
    ReleaseAll(std::sync::mpsc::Sender<()>),
}

static INJECT_TX: std::sync::OnceLock<std::sync::Mutex<std::sync::mpsc::Sender<InjectJob>>> =
    std::sync::OnceLock::new();

fn inject_tx() -> &'static std::sync::Mutex<std::sync::mpsc::Sender<InjectJob>> {
    INJECT_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<InjectJob>();
        let _ = std::thread::Builder::new()
            .name("input-inject".into())
            .spawn(move || {
                // Microseconds of work per event; what this thread must never
                // do is wait behind a game's threads for a CPU slice, because
                // that wait is pointer lag on the far end. HIGHEST within our
                // class (ABOVE_NORMAL while a share is boosted). Not
                // TIME_CRITICAL: that is the hook thread's budget, which has
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
                let mut refusals = RefusalThrottle::new();
                for job in rx {
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
                }
            });
        std::sync::Mutex::new(tx)
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
/// as the fire-and-forget frontend treated them before.
pub fn inject_queued(event: ControlInput) -> Result<(), String> {
    let guard = inject_tx()
        .lock()
        .map_err(|_| "inject queue poisoned".to_string())?;
    guard
        .send(InjectJob::Event(event))
        .map_err(|_| "inject worker is gone".to_string())
}

/// Release held keys/buttons AFTER everything already queued has injected.
/// Falls back to an inline release if the worker is unavailable or slow —
/// a possibly-misordered release beats no release.
pub fn release_all_ordered() {
    let (ack_tx, ack_rx) = std::sync::mpsc::channel();
    let sent = inject_tx()
        .lock()
        .ok()
        .map(|g| g.send(InjectJob::ReleaseAll(ack_tx)).is_ok())
        .unwrap_or(false);
    if !sent || ack_rx.recv_timeout(std::time::Duration::from_millis(500)).is_err() {
        release_all();
    }
}

// --- Physical-input kill switch -------------------------------------------
//
// While a viewer is controlling, the host runs a low-level mouse+keyboard hook.
// Real host input (the OS does NOT flag it injected) fires a one-shot
// "host-input-detected" event, and the frontend revokes control — so the moment
// the host touches their own mouse/keyboard, the remote controller is dropped.
// Our own SendInput events are injected (flagged), so they never trip it.
//
// Best-effort and fail-safe: if the hook can't install, the manual Stop button
// in the banner still ends the session.

#[cfg(windows)]
mod guard {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        HHOOK, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT,
        WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN,
    };

    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static FIRED: AtomicBool = AtomicBool::new(false);
    static THREAD_ID: AtomicU32 = AtomicU32::new(0);
    static APP: OnceLock<AppHandle> = OnceLock::new();

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

    /// Fire a one-shot revoke via the given event (deduped by FIRED).
    fn fire(event: &'static str) {
        if ACTIVE.load(Ordering::SeqCst) && !FIRED.swap(true, Ordering::SeqCst) {
            if let Some(app) = APP.get() {
                let _ = app.emit(event, ());
            }
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

    fn hook_thread() {
        unsafe {
            let hmod = GetModuleHandleW(None).unwrap_or_default();
            let hinst = HINSTANCE(hmod.0);
            let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hinst, 0);
            let kbd_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), hinst, 0);
            THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);

            // Pump messages until PostThreadMessage(WM_QUIT) from stop().
            let mut msg = MSG::default();
            loop {
                let r = GetMessageW(&mut msg, None, 0, 0).0;
                if r == 0 || r == -1 {
                    break; // WM_QUIT (0) or error (-1)
                }
            }

            if let Ok(h) = mouse_hook {
                let _ = UnhookWindowsHookEx(h);
            }
            if let Ok(h) = kbd_hook {
                let _ = UnhookWindowsHookEx(h);
            }
            let _ = HHOOK::default();
            THREAD_ID.store(0, Ordering::SeqCst);
        }
    }

    pub fn start(app: AppHandle, any_input: bool, kill_vk: u32, kill_mods: u32) {
        let _ = APP.set(app);
        FIRED.store(false, Ordering::SeqCst);
        ANY_INPUT.store(any_input, Ordering::SeqCst);
        KILL_VK.store(kill_vk, Ordering::SeqCst);
        KILL_MODS.store(kill_mods, Ordering::SeqCst);
        // Already running? Just re-arm (config above already applied).
        if ACTIVE.swap(true, Ordering::SeqCst) && THREAD_ID.load(Ordering::SeqCst) != 0 {
            return;
        }
        std::thread::spawn(hook_thread);
    }

    pub fn stop() {
        ACTIVE.store(false, Ordering::SeqCst);
        let tid = THREAD_ID.swap(0, Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
}

/// Start the host-side kill switch (Windows only). `any_input` = revoke on any
/// physical host input (opt-in); `kill_vk`/`kill_mods` = the always-on custom
/// kill-switch hotkey (virtual key + modifier bitmask 1=Ctrl 2=Alt 4=Shift;
/// vk 0 disables the hotkey).
#[cfg(windows)]
pub fn start_guard(app: tauri::AppHandle, any_input: bool, kill_vk: u32, kill_mods: u32) {
    guard::start(app, any_input, kill_vk, kill_mods);
}

/// Stop the physical-input kill switch (and release any held input, so ending a
/// session can never leave a key/button stuck down).
#[cfg(windows)]
pub fn stop_guard() {
    guard::stop();
    release_all_ordered();
}

#[cfg(not(windows))]
pub fn start_guard(_app: tauri::AppHandle, _any_input: bool, _kill_vk: u32, _kill_mods: u32) {}

#[cfg(not(windows))]
pub fn stop_guard() {}
