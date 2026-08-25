//! Display power quick actions a controller can ask this host for:
//! `displays_off` (all panels dark), `displays_off_keep_primary` (everything
//! BUT the primary dark — the "I'm gaming on one screen, stop lighting the
//! others" ask), `displays_on`.
//!
//! Two different mechanisms because Windows has no one knob that does both:
//!
//! - `displays_off` broadcasts `SC_MONITORPOWER` — the OS-level display
//!   sleep. Any input wakes it, INCLUDING the input this very session
//!   injects, so while it is engaged a 2s KEEP-OFF TICKER re-asserts it;
//!   moving the remote mouse blanks back within a tick. There is no
//!   per-monitor variant of this message.
//! - `displays_off_keep_primary` uses DDC/CI (`SetVCPFeature`, VCP 0xD6
//!   "power mode") per NON-primary monitor. 0x04 = standby, deliberately not
//!   0x05 (off): standby keeps the DDC channel awake so `displays_on` can
//!   bring the panel back by software; 0x05 on many panels cannot be undone
//!   except by its physical button. DDC is honest-per-monitor: some panels
//!   simply do not answer, so the result names who did and who did not. No
//!   ticker — the OS keeps driving the signal, so injected input does not
//!   wake a DDC-standby panel.
//!
//! PERSISTENCE (user decision, 2026-08-25): "always stay as set". Session
//! teardown stops the ticker and sends NO relight — panels wake on the next
//! physical input (SC_MONITORPOWER) or the next `displays_on` (DDC). A
//! session ending must not surprise-light a machine its owner darkened on
//! purpose.
//!
//! The OS calls sit behind `backend`, swapped out under cfg(test) for a
//! recorder — a unit test must not blank the developer's monitors (the same
//! seam rule the input crate learned when `cargo test` typed a real
//! keystroke).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// Keep-off re-assert cadence. 2s: fast enough that a wiggled mouse shows at
/// most a blink of picture, slow enough to cost nothing.
pub const KEEPOFF_TICK_MS: u64 = 2_000;

#[cfg(test)]
static TEST_TICK_MS: AtomicU64 = AtomicU64::new(KEEPOFF_TICK_MS);

fn tick_ms() -> u64 {
    #[cfg(test)]
    {
        TEST_TICK_MS.load(Ordering::SeqCst)
    }
    #[cfg(not(test))]
    {
        KEEPOFF_TICK_MS
    }
}

#[derive(Default)]
pub struct DisplayPower {
    /// Bumped on EVERY state change. A ticker thread carries the generation
    /// it was born under and dies the moment it no longer matches — a stale
    /// ticker from a previous engage must never re-blank a machine whose
    /// displays were since turned back on (the one-way-latch class).
    generation: AtomicU64,
    keep_off: AtomicBool,
    /// Serializes the three public operations against each other now that
    /// the command runs on the blocking pool (two clicks can overlap). The
    /// ticker deliberately does NOT take it — it reads atomics only, so a
    /// slow DDC pass can never park the re-assert.
    op_lock: std::sync::Mutex<()>,
}

impl DisplayPower {
    /// The ticker's whole decision, pure of OS calls so it is testable: fire
    /// only while the keep-off is engaged AND this ticker is the current one.
    pub fn ticker_should_fire(&self, my_generation: u64) -> bool {
        self.keep_off.load(Ordering::SeqCst)
            && self.generation.load(Ordering::SeqCst) == my_generation
    }

    /// Stop keeping displays off, relighting nothing. Idempotent.
    pub fn disengage(&self) {
        self.keep_off.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn displays_off(self: &Arc<Self>) -> Result<(), String> {
        let _g = self.op_lock.lock().unwrap_or_else(|e| e.into_inner());
        backend::monitor_power_off()?;
        let my_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.keep_off.store(true, Ordering::SeqCst);
        let me = Arc::clone(self);
        std::thread::Builder::new()
            .name("display-keepoff".into())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(tick_ms()));
                if !me.ticker_should_fire(my_gen) {
                    break;
                }
                let _ = backend::monitor_power_off();
            })
            // Honest about what actually happened: the panels ARE off — only
            // the re-assert is missing, so injected input will wake them.
            .map_err(|e| {
                format!(
                    "displays turned off, but the keep-off ticker could not start ({e}) —                      remote input will wake them"
                )
            })?;
        Ok(())
    }

    /// Returns the honest per-monitor detail ("Turned off 2 of 3; DELL U2720Q
    /// did not respond"), or Err when nothing could be turned off.
    pub fn displays_off_keep_primary(&self) -> Result<String, String> {
        let _g = self.op_lock.lock().unwrap_or_else(|e| e.into_inner());
        // A prior ALL-off leaves the OS-level sleep in force on every panel —
        // stopping the ticker alone left the PRIMARY dark while the ack said
        // "keeping it" (review W4-N1). Wake the OS sleep first, then DDC the
        // others down; on a machine that was never all-off the wake is a
        // no-op broadcast.
        let was_all_off = self.keep_off.load(Ordering::SeqCst);
        self.disengage();
        if was_all_off {
            let _ = backend::monitor_power_on();
        }
        let (off, failed, total) = backend::ddc_standby_non_primary()?;
        if total == 0 {
            return Ok("This machine has only one display — nothing to turn off.".into());
        }
        if off == 0 {
            return Err(format!(
                "None of the {total} other display(s) responded to the power command — \
                 they may not support DDC/CI, or it is disabled in their menu"
            ));
        }
        let mut detail = format!("Turned off {off} of {total} other display(s)");
        if !failed.is_empty() {
            detail.push_str(&format!("; {} did not respond", failed.join(", ")));
        }
        Ok(detail)
    }

    pub fn displays_on(&self) -> Result<(), String> {
        let _g = self.op_lock.lock().unwrap_or_else(|e| e.into_inner());
        self.disengage();
        // DDC wake first (panels in 0xD6 standby ignore the broadcast), then
        // the OS-level wake, then a 1px input nudge — the same belt and
        // braces a stream start uses, because a machine that LOOKS dead after
        // "displays on" reads as a worse failure than either knob alone.
        backend::ddc_wake_all();
        backend::monitor_power_on()?;
        backend::input_nudge();
        Ok(())
    }

    /// Session teardown: STAY AS SET. The ticker stops (so the next physical
    /// input at the machine wakes SC_MONITORPOWER-slept panels), nothing is
    /// relit — see the module header.
    pub fn on_session_end(&self) {
        self.disengage();
    }
}

#[cfg(all(windows, not(test)))]
mod backend {
    use windows::Win32::Devices::Display::{
        DestroyPhysicalMonitors, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, SetVCPFeature, PHYSICAL_MONITOR,
    };
    use windows::Win32::Foundation::{BOOL, LPARAM, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_MOVE, MOUSEINPUT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, MONITORINFOF_PRIMARY, SC_MONITORPOWER,
        SMTO_ABORTIFHUNG, WM_SYSCOMMAND,
    };

    /// VCP 0xD6 "power mode": 0x01 on, 0x04 standby (NOT 0x05 — see header).
    const VCP_POWER_MODE: u8 = 0xD6;
    const VCP_POWER_ON: u32 = 0x01;
    const VCP_POWER_STANDBY: u32 = 0x04;

    fn monitor_power(level: isize) -> Result<(), String> {
        unsafe {
            // Broadcast — the message is handled desktop-wide; a per-window
            // send does nothing. TIMED, unlike the plain SendMessageW the
            // privacy screen uses: HWND_BROADCAST blocks until every
            // top-level window pumps, and one hung window would park this
            // thread — including the 2s keep-off ticker — forever
            // (review W4-N2). ABORTIFHUNG skips the hung ones; the reply is
            // still not a success flag, so delivered-or-timed-out is all
            // that can be known.
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SYSCOMMAND,
                WPARAM(SC_MONITORPOWER as usize),
                LPARAM(level),
                SMTO_ABORTIFHUNG,
                2_000,
                None,
            );
        }
        Ok(())
    }
    pub fn monitor_power_off() -> Result<(), String> {
        monitor_power(2)
    }
    pub fn monitor_power_on() -> Result<(), String> {
        monitor_power(-1)
    }

    struct MonitorEntry {
        hmonitor: HMONITOR,
        primary: bool,
    }

    fn list_monitors() -> Vec<MonitorEntry> {
        unsafe extern "system" fn cb(
            hmon: HMONITOR,
            _hdc: HDC,
            _rect: *mut RECT,
            lparam: LPARAM,
        ) -> BOOL {
            let list = &mut *(lparam.0 as *mut Vec<MonitorEntry>);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            let primary = GetMonitorInfoW(hmon, &mut info).as_bool()
                && (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
            list.push(MonitorEntry { hmonitor: hmon, primary });
            BOOL(1)
        }
        let mut list: Vec<MonitorEntry> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(cb),
                LPARAM(&mut list as *mut _ as isize),
            );
        }
        list
    }

    /// Set VCP power on every physical monitor behind `hmon`; returns the
    /// per-panel (description, ok) results.
    fn set_vcp_power(hmon: HMONITOR, value: u32) -> Vec<(String, bool)> {
        let mut out = Vec::new();
        unsafe {
            let mut n: u32 = 0;
            if GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut n).is_err() || n == 0 {
                return out;
            }
            let mut phys: Vec<PHYSICAL_MONITOR> = vec![Default::default(); n as usize];
            if GetPhysicalMonitorsFromHMONITOR(hmon, &mut phys).is_err() {
                return out;
            }
            for p in &phys {
                // PHYSICAL_MONITOR is repr(packed): copy the array out before
                // touching it — a reference into it is UB (E0793).
                let desc = { p.szPhysicalMonitorDescription };
                let name = String::from_utf16_lossy(
                    &desc[..desc.iter().position(|&c| c == 0).unwrap_or(desc.len())],
                );
                let name = if name.trim().is_empty() { "display".to_string() } else { name.trim().to_string() };
                let ok = SetVCPFeature(p.hPhysicalMonitor, VCP_POWER_MODE, value) != 0;
                out.push((name, ok));
            }
            let _ = DestroyPhysicalMonitors(&phys);
        }
        out
    }

    /// DDC-standby every non-primary panel. (turned off, failed names, total).
    pub fn ddc_standby_non_primary() -> Result<(usize, Vec<String>, usize), String> {
        let monitors = list_monitors();
        if monitors.is_empty() {
            return Err("could not enumerate displays".into());
        }
        let mut off = 0usize;
        let mut failed = Vec::new();
        let mut total = 0usize;
        for m in monitors.iter().filter(|m| !m.primary) {
            let results = set_vcp_power(m.hmonitor, VCP_POWER_STANDBY);
            if results.is_empty() {
                total += 1;
                failed.push("display (no DDC handle)".to_string());
                continue;
            }
            for (name, ok) in results {
                total += 1;
                if ok {
                    off += 1;
                } else {
                    failed.push(name);
                }
            }
        }
        Ok((off, failed, total))
    }

    /// Best-effort DDC wake of EVERY panel (primary included — harmless when
    /// already on, and `displays_on` must undo `keep_primary` too).
    pub fn ddc_wake_all() {
        for m in list_monitors() {
            let _ = set_vcp_power(m.hmonitor, VCP_POWER_ON);
        }
    }

    /// One relative 1px wiggle. What tells Windows "someone is here" after
    /// MONITOR_ON — some panels only rescan on activity, not on the message.
    pub fn input_nudge() {
        let mk = |dx: i32| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_MOVE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe {
            let _ = SendInput(&[mk(1), mk(-1)], std::mem::size_of::<INPUT>() as i32);
        }
    }
}

#[cfg(all(not(windows), not(test)))]
mod backend {
    //! Hard errors, not silent no-ops: an acked "Displays turned off" over
    //! panels that never dimmed is actively misleading — the privacy
    //! screen's documented rule, applied here (review W4-N4).
    pub fn monitor_power_off() -> Result<(), String> {
        Err("display power is only implemented on Windows".into())
    }
    pub fn monitor_power_on() -> Result<(), String> {
        Err("display power is only implemented on Windows".into())
    }
    pub fn ddc_standby_non_primary() -> Result<(usize, Vec<String>, usize), String> {
        Err("display power is only implemented on Windows".into())
    }
    pub fn ddc_wake_all() {}
    pub fn input_nudge() {}
}

#[cfg(test)]
pub(crate) mod backend {
    //! Recorder. A test must never blank the developer's monitors — the
    //! input-crate canary rule.
    use std::sync::Mutex;
    pub static CALLS: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    fn rec(c: &'static str) {
        CALLS.lock().unwrap().push(c);
    }
    pub fn take() -> Vec<&'static str> {
        std::mem::take(&mut *CALLS.lock().unwrap())
    }
    pub fn monitor_power_off() -> Result<(), String> {
        rec("off");
        Ok(())
    }
    pub fn monitor_power_on() -> Result<(), String> {
        rec("on");
        Ok(())
    }
    pub fn ddc_standby_non_primary() -> Result<(usize, Vec<String>, usize), String> {
        rec("ddc-standby");
        Ok((1, vec!["Fake HDMI".into()], 2))
    }
    pub fn ddc_wake_all() {
        rec("ddc-wake");
    }
    pub fn input_nudge() {
        rec("nudge");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize the whole suite's use of the recorder: `backend::CALLS` is
    /// process-global and these tests read it.
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn the_ticker_dies_with_its_generation_and_never_relights_a_later_state() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dp = Arc::new(DisplayPower::default());
        // Engage: the ticker born here fires while nothing changed…
        dp.displays_off().unwrap();
        let born = dp.generation.load(Ordering::SeqCst);
        assert!(dp.ticker_should_fire(born), "fresh engage keeps its ticker alive");
        // …and dies on disengage — even though a NEW engage later re-arms the
        // flag, the OLD generation stays dead. This is the stale-ticker
        // re-blank (one-way-latch class) the generation exists to prevent.
        dp.disengage();
        assert!(!dp.ticker_should_fire(born), "disengage kills the old ticker");
        dp.displays_off().unwrap();
        assert!(!dp.ticker_should_fire(born), "a NEW engage must not resurrect an OLD ticker");
        let current = dp.generation.load(Ordering::SeqCst);
        assert!(dp.ticker_should_fire(current), "the new engage's own ticker lives");
        dp.on_session_end();
        assert!(!dp.ticker_should_fire(current), "teardown stops the ticker (stay-as-set)");
        let _ = backend::take();
    }

    #[test]
    fn the_ticker_actually_rebroadcasts_until_disengaged() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        TEST_TICK_MS.store(10, Ordering::SeqCst);
        let dp = Arc::new(DisplayPower::default());
        let _ = backend::take();
        dp.displays_off().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(60));
        dp.disengage();
        std::thread::sleep(std::time::Duration::from_millis(40));
        let calls = backend::take();
        let offs = calls.iter().filter(|c| **c == "off").count();
        assert!(offs >= 3, "expected the immediate off plus re-asserts, saw {calls:?}");
        // Nothing fired after disengage: allow one in-flight tick of slack.
        std::thread::sleep(std::time::Duration::from_millis(40));
        assert!(
            backend::take().iter().filter(|c| **c == "off").count() <= 1,
            "the ticker kept firing after disengage"
        );
        TEST_TICK_MS.store(KEEPOFF_TICK_MS, Ordering::SeqCst);
    }

    #[test]
    fn displays_on_wakes_ddc_then_os_then_nudges_and_kills_the_ticker() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dp = Arc::new(DisplayPower::default());
        dp.displays_off().unwrap();
        let _ = backend::take();
        dp.displays_on().unwrap();
        let calls = backend::take();
        assert_eq!(calls, vec!["ddc-wake", "on", "nudge"], "wake order is load-bearing");
        assert!(!dp.keep_off.load(Ordering::SeqCst));
    }

    #[test]
    fn keep_primary_reports_honestly_and_replaces_a_running_ticker() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dp = Arc::new(DisplayPower::default());
        dp.displays_off().unwrap();
        let born = dp.generation.load(Ordering::SeqCst);
        let _ = backend::take();
        let detail = dp.displays_off_keep_primary().unwrap();
        // The recorder answers "1 of 2, Fake HDMI failed".
        assert!(detail.contains("1 of 2"), "{detail}");
        assert!(detail.contains("Fake HDMI"), "{detail}");
        assert!(!dp.ticker_should_fire(born), "the all-off ticker must not fight keep-primary");
        // THE PRIMARY MUST COME BACK: keep-primary after all-off inherits the
        // OS-level sleep, and stopping the ticker alone left every panel dark
        // while the ack said otherwise (review W4-N1).
        let calls = backend::take();
        assert!(
            calls.contains(&"on"),
            "keep-primary after all-off must wake the OS sleep first: {calls:?}"
        );
    }
}
