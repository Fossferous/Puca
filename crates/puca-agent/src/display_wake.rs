//! Waking a powered-down display, and holding it awake for a session.
//!
//! A remote-control session against a machine whose panels are in DPMS-off is
//! the canonical unattended use ("control my desktop from my phone") — and
//! DXGI duplication of a powered-down output presents NOTHING: creation
//! usually succeeds, `AcquireNextFrame` times out forever, and because the
//! encoder is built lazily after the first frame, the controller gets a black
//! stage with no error. A sleeping panel also breaks absolute cursor
//! placement (`SetCursorPos` clamps onto a live monitor — see the session
//! module's input-aim notes), so waking fixes input as well as the picture.
//!
//! Two distinct mechanisms, deliberately:
//!
//! - `nudge()` WAKES: synthetic input is what the power manager treats as
//!   user presence, and it is what turns a panel back on (the approach every
//!   remote-desktop host uses). Two opposite 1px relative moves net to zero
//!   so the pointer does not visibly move. The legacy `SC_MONITORPOWER = -1`
//!   broadcast is fired as a best-effort second attempt — some drivers honour
//!   one and not the other.
//! - `DisplayAwake` HOLDS: `SetThreadExecutionState(ES_DISPLAY_REQUIRED)`
//!   resets the idle timer and prevents the display sleeping mid-session,
//!   but does NOT power an already-off panel back on — it is the guard that
//!   makes the nudge stick, not a substitute for it. The state is per-thread
//!   and cleared on drop (and implicitly when the stream thread exits), so
//!   session end releases it with no extra lifecycle.
//!
//! Side effect worth naming: a wake lights the panel for anyone physically at
//! the machine and dismisses the screensaver. That is inherent to waking a
//! display and exactly what a user asking "why is my stream black" wants. If
//! the workstation is LOCKED, the wake lights the lock screen but capture
//! still cannot cross to the secure desktop — a different limitation with a
//! different fix (the SYSTEM service), not this module's problem.

#![cfg(windows)]

use windows::Win32::System::Power::{
    SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
};
use windows::Win32::UI::WindowsAndMessaging::{
    SendNotifyMessageW, HWND_BROADCAST, SC_MONITORPOWER, WM_SYSCOMMAND,
};

/// Synthetic user presence: wake the panels. Best-effort on every layer —
/// a wake that fails leaves us exactly where we started.
pub fn nudge() {
    use puca_input::ControlInput;
    // Two opposite 1px relative moves: user presence with zero net cursor
    // travel. A zero-delta move would be filtered out before reaching the OS.
    if let Err(e) = puca_input::inject(ControlInput::Rmove { dx: 1.0, dy: 0.0 }) {
        eprintln!("[display-wake] nudge inject failed: {e}");
    }
    let _ = puca_input::inject(ControlInput::Rmove { dx: -1.0, dy: 0.0 });
    // Legacy path, second attempt: -1 = "power on" to every top-level window.
    // SendNotifyMessageW, not SendMessageW — a hung window must not hang us.
    unsafe {
        let _ = SendNotifyMessageW(
            HWND_BROADCAST,
            WM_SYSCOMMAND,
            windows::Win32::Foundation::WPARAM(SC_MONITORPOWER as usize),
            windows::Win32::Foundation::LPARAM(-1),
        );
    }
    eprintln!("[display-wake] nudge sent (synthetic input + SC_MONITORPOWER on)");
}

/// RAII: displays (and the system) may not idle-sleep while this lives.
/// MUST be acquired on the stream thread — the execution state is per-thread.
pub struct DisplayAwake;

impl DisplayAwake {
    pub fn acquire() -> Self {
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
        }
        Self
    }
}

impl Drop for DisplayAwake {
    fn drop(&mut self) {
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}
