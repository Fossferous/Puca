//! Privacy screen, Tier 1: blank the HOST's physical monitor while it is driven.
//!
//! WHAT THIS ACTUALLY IS, stated up front because the name oversells it. This
//! powers the physical panel off and (optionally) locks the session. It is
//! "don't let someone standing at the machine watch me work" — NOT the
//! "Privacy Mode" that shows the remote operator a private virtual display while
//! the physical one is dark. That is Tier 2: an Indirect Display Driver, which
//! needs a signed driver and is a separate, much larger piece of work.
//!
//! THREE HONEST LIMITS the UI must state rather than let people discover:
//!
//!   1. ANY physical input wakes the panel straight back up. Windows has no
//!      supported way to hold a display off against a keypress. What we CAN do
//!      is notice — the existing `mod guard` LL-hook already watches for physical
//!      input, so this pairs naturally with the any-input kill switch: if someone
//!      touches the machine, the session should end anyway.
//!   2. `SetWindowDisplayAffinity(WDA_MONITOR)` does not apply. That excludes ONE
//!      WINDOW from capture; here the whole desktop is being captured, so there
//!      is nothing to exclude it from.
//!   3. If the session is locked, the controller sees the LOCK SCREEN unless the
//!      Phase 8 SYSTEM service is running — a user-token agent cannot capture the
//!      secure desktop. So "lock while I drive" is only useful WITH the service;
//!      without it, locking ends your own view. The caller decides, and the UI
//!      must say so.
//!
//! Monitor power is a MACHINE-WIDE side effect, so every entry point here is an
//! explicit command — nothing switches the display off as a side effect of
//! starting a session.

/// What a privacy-screen request should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrivacyMode {
    /// Power the panel off. Any physical input wakes it.
    Blank,
    /// Power the panel off AND lock the session. Only sensible when the SYSTEM
    /// service is running, or the controller loses their own view.
    BlankAndLock,
}

/// Why a privacy-screen request could not be honoured.
#[derive(Debug, PartialEq, Eq)]
pub enum PrivacyError {
    /// Constructed only on non-Windows builds; dead on Windows, which is a cfg
    /// artifact rather than unused code.
    #[allow(dead_code)]
    Unsupported(&'static str),
    Failed(String),
}

impl std::fmt::Display for PrivacyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PrivacyError::Unsupported(why) => write!(f, "{why}"),
            PrivacyError::Failed(e) => write!(f, "{e}"),
        }
    }
}

/// Whether locking is safe to offer: it is only useful if the controller can
/// still see the machine afterwards, which needs a SYSTEM-level host.
///
/// Pure, so the decision is testable and the UI can grey the option out with a
/// real reason rather than letting someone lock themselves out of their own
/// session.
#[tauri::command]
pub fn privacy_screen_lock_would_blind(system_service_running: bool) -> bool {
    !system_service_running
}

#[cfg(windows)]
mod imp {
    use super::{PrivacyError, PrivacyMode};
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::Shutdown::LockWorkStation;
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageW, HWND_BROADCAST, SC_MONITORPOWER, WM_SYSCOMMAND,
    };

    /// `SC_MONITORPOWER` levels. 2 = off; -1 = on. There is no "stay off".
    const MONITOR_OFF: isize = 2;
    const MONITOR_ON: isize = -1;

    fn set_monitor_power(level: isize) -> Result<(), PrivacyError> {
        unsafe {
            // Broadcast, not to our own window: the message is handled by the
            // shell/DWM for the whole desktop, and a per-window send does nothing.
            SendMessageW(
                HWND_BROADCAST,
                WM_SYSCOMMAND,
                WPARAM(SC_MONITORPOWER as usize),
                LPARAM(level),
            );
        }
        // SendMessage's return is the target's reply, not a success flag, so
        // there is nothing meaningful to check. Reporting Ok here is honest:
        // the request was delivered. Whether a given panel obeys is between
        // Windows and the display.
        Ok(())
    }

    pub fn engage(mode: PrivacyMode) -> Result<(), PrivacyError> {
        set_monitor_power(MONITOR_OFF)?;
        if mode == PrivacyMode::BlankAndLock {
            unsafe {
                LockWorkStation()
                    .map_err(|e| PrivacyError::Failed(format!("LockWorkStation failed: {e}")))?;
            }
        }
        Ok(())
    }

    pub fn release() -> Result<(), PrivacyError> {
        // Turning the panel back on is best-effort and often unnecessary — any
        // input has usually already woken it — but leaving a machine dark after
        // a session ends would be alarming.
        set_monitor_power(MONITOR_ON)
    }

    /// Suppress an unused-import warning on the HWND type alias in some
    /// windows-rs versions.
    #[allow(dead_code)]
    fn _hwnd_used(_: HWND) {}
}

#[cfg(not(windows))]
mod imp {
    use super::{PrivacyError, PrivacyMode};

    pub fn engage(_mode: PrivacyMode) -> Result<(), PrivacyError> {
        // X11 has DPMS and Wayland has per-compositor protocols; neither is
        // wired yet. A hard error, not a silent no-op: a controller told
        // "privacy screen on" while the panel stays lit is actively misled about
        // who can see them.
        Err(PrivacyError::Unsupported(
            "the privacy screen is only implemented on Windows",
        ))
    }

    pub fn release() -> Result<(), PrivacyError> {
        Err(PrivacyError::Unsupported(
            "the privacy screen is only implemented on Windows",
        ))
    }
}

/// Blank the host's panel (and optionally lock). Machine-wide side effect.
#[tauri::command]
pub fn privacy_screen_engage(mode: PrivacyMode) -> Result<(), String> {
    imp::engage(mode).map_err(|e| e.to_string())
}

/// Wake the panel back up. Called when the session ends.
#[tauri::command]
pub fn privacy_screen_release() -> Result<(), String> {
    imp::release().map_err(|e| e.to_string())
}

/// Whether this platform can blank at all, so the UI hides the control instead
/// of offering a button that always errors.
#[tauri::command]
pub fn privacy_screen_supported() -> bool {
    cfg!(windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locking_without_the_system_service_would_blind_the_controller() {
        // The trap this guard exists for: locking is the one privacy option that
        // can end your own view of the machine. Without a SYSTEM-level host the
        // controller cannot capture the lock screen, so the UI must warn or
        // disable rather than let someone lock themselves out remotely.
        assert!(privacy_screen_lock_would_blind(false));
        assert!(!privacy_screen_lock_would_blind(true));
    }

    #[test]
    fn the_mode_deserializes_from_the_wire_names() {
        // The UI sends these strings; a rename that broke them would surface as
        // "privacy screen does nothing" with no error.
        let blank: PrivacyMode = serde_json::from_str("\"blank\"").unwrap();
        assert_eq!(blank, PrivacyMode::Blank);
        let lock: PrivacyMode = serde_json::from_str("\"blankandlock\"").unwrap();
        assert_eq!(lock, PrivacyMode::BlankAndLock);
        assert!(serde_json::from_str::<PrivacyMode>("\"off\"").is_err());
    }

    #[test]
    fn support_is_reported_per_platform_not_assumed() {
        // Non-Windows must report false, so the UI hides the control rather than
        // offering a button that always errors.
        assert_eq!(privacy_screen_supported(), cfg!(windows));
    }

    #[cfg(not(windows))]
    #[test]
    fn an_unsupported_platform_errors_rather_than_silently_doing_nothing() {
        // A controller told "privacy screen on" while the panel stays lit is
        // misled about who can see them — the one outcome worse than no feature.
        assert!(privacy_screen_engage(PrivacyMode::Blank).is_err());
    }
}
