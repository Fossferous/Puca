//! Power actions the SIGN-IN-SCREEN host performs on a controller's request.
//!
//! The attended host (the Tauri app, running as the signed-in user) has its
//! own copy of this in `frontend/src-tauri/src/power.rs`; the two are
//! deliberately not shared — the shell does not depend on this crate, and
//! thirty lines is not worth a crate boundary. Keep them in step.
//!
//! At the sign-in screen this agent runs as LocalSystem in the console
//! session (crates/puca-service/src/launch.rs), which HOLDS
//! `SeShutdownPrivilege` but, like every token, must ENABLE it before the
//! call. `Lock` is a no-op here on purpose: the console is already locked —
//! that is the only reason this flavour is running.
//!
//! The dispatch that decides WHICH action runs is `run(action)`; the OS calls
//! sit behind `perform`, which tests never reach (a unit test must not shut
//! the developer's machine down — the same reasoning as the input crate's
//! cfg(test) seam).

/// The DeviceEnd reason a successful shutdown ends the session with — the
/// SAME literal the attended host uses (frontend/src/api/devices/session.ts,
/// `SHUTDOWN_REASON`), so the controller reads one explanation whichever
/// flavour of host it was on. Pinned by a test below.
pub const SHUTDOWN_REASON: &str = "the device is shutting down";

/// The controller's spelling on the wire (`{kind:'power', action}`) — the
/// same strings the Tauri host and the TS controller use. A drift here is
/// caught by the tests below, not by a silent "unknown action".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerAction {
    Lock,
    Shutdown,
    /// W4 display power. The sign-in agent only ever broadcasts — no ticker
    /// (nothing injects a stream of input into a locked console) and no
    /// DDC/CI (keep-primary is a signed-in convenience; see `plan`).
    DisplaysOff,
    DisplaysOffKeepPrimary,
    DisplaysOn,
}

impl PowerAction {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "lock" => Some(Self::Lock),
            "shutdown" => Some(Self::Shutdown),
            "displays_off" => Some(Self::DisplaysOff),
            "displays_off_keep_primary" => Some(Self::DisplaysOffKeepPrimary),
            "displays_on" => Some(Self::DisplaysOn),
            _ => None,
        }
    }
}

/// What the arm should do for an action, decided without touching the OS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Already in the requested state; answer ok and do nothing.
    NoOp,
    /// Enable SeShutdownPrivilege and ExitWindowsEx(shutdown|poweroff).
    Shutdown,
    /// SC_MONITORPOWER broadcast, off. No keep-off ticker at the sign-in
    /// screen: the controller watching a lock screen is not streaming input,
    /// and physical input waking the panels is what someone at the machine
    /// would want anyway.
    DisplaysOff,
    /// SC_MONITORPOWER broadcast, on.
    DisplaysOn,
    /// Answered as a power-failed with this pinned reason, never attempted.
    Refuse(&'static str),
}

/// The refusal wording for keep-primary before sign-in — pinned by a test so
/// the controller-facing copy cannot drift silently.
pub const KEEP_PRIMARY_REFUSAL: &str =
    "turning off only some displays is not available before sign-in";

/// Pure: the sign-in-screen host is by definition on a locked console.
pub fn plan(action: PowerAction) -> Plan {
    match action {
        PowerAction::Lock => Plan::NoOp,
        PowerAction::Shutdown => Plan::Shutdown,
        PowerAction::DisplaysOff => Plan::DisplaysOff,
        PowerAction::DisplaysOn => Plan::DisplaysOn,
        // DDC/CI at the sign-in screen would be a SYSTEM process poking
        // monitor firmware for a machine nobody has signed into — the
        // narrow value does not carry the surface. Honest refusal instead.
        PowerAction::DisplaysOffKeepPrimary => Plan::Refuse(KEEP_PRIMARY_REFUSAL),
    }
}

/// Carry a plan out. Errors are the OS's words, for the controller.
pub fn perform(p: Plan) -> Result<(), String> {
    match p {
        Plan::NoOp => Ok(()),
        Plan::Shutdown => imp::shutdown(),
        Plan::DisplaysOff => imp::monitor_power(true),
        Plan::DisplaysOn => imp::monitor_power(false),
        Plan::Refuse(reason) => Err(reason.to_string()),
    }
}

#[cfg(windows)]
mod imp {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID};
    use windows::Win32::Security::{
        AdjustTokenPrivileges, LookupPrivilegeValueW, SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES,
        TOKEN_PRIVILEGES, TOKEN_QUERY,
    };
    use windows::Win32::System::Shutdown::{
        ExitWindowsEx, EWX_FORCEIFHUNG, EWX_POWEROFF, EWX_SHUTDOWN, SHTDN_REASON_FLAG_PLANNED,
        SHTDN_REASON_MAJOR_OTHER, SHTDN_REASON_MINOR_OTHER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    fn enable_privilege(name: &str) -> Result<(), String> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token)
                .map_err(|e| format!("OpenProcessToken failed: {e}"))?;
            let result = (|| {
                let mut luid = LUID::default();
                LookupPrivilegeValueW(PCWSTR::null(), PCWSTR(wide.as_ptr()), &mut luid)
                    .map_err(|e| format!("LookupPrivilegeValue({name}) failed: {e}"))?;
                let mut tp = TOKEN_PRIVILEGES::default();
                tp.PrivilegeCount = 1;
                tp.Privileges[0].Luid = luid;
                tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
                AdjustTokenPrivileges(token, false, Some(&tp), 0, None, None)
                    .map_err(|e| format!("AdjustTokenPrivileges({name}) failed: {e}"))?;
                // ERROR_NOT_ALL_ASSIGNED (1300) rides on a SUCCESS return.
                let last = windows::core::Error::from_win32();
                if last.code().0 as u32 & 0xFFFF == 1300 {
                    return Err(format!("this account does not hold {name}"));
                }
                Ok(())
            })();
            let _ = CloseHandle(token);
            result
        }
    }

    pub fn monitor_power(off: bool) -> Result<(), String> {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            SendMessageW, HWND_BROADCAST, SC_MONITORPOWER, WM_SYSCOMMAND,
        };
        unsafe {
            // Broadcast, desktop-wide; the return is the target's reply, not
            // a success flag — same as the attended shell's copy.
            SendMessageW(
                HWND_BROADCAST,
                WM_SYSCOMMAND,
                WPARAM(SC_MONITORPOWER as usize),
                LPARAM(if off { 2 } else { -1 }),
            );
        }
        Ok(())
    }

    pub fn shutdown() -> Result<(), String> {
        enable_privilege("SeShutdownPrivilege")?;
        unsafe {
            ExitWindowsEx(
                EWX_SHUTDOWN | EWX_POWEROFF | EWX_FORCEIFHUNG,
                SHTDN_REASON_MAJOR_OTHER | SHTDN_REASON_MINOR_OTHER | SHTDN_REASON_FLAG_PLANNED,
            )
            .map_err(|e| format!("ExitWindowsEx failed: {e}"))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn shutdown() -> Result<(), String> {
        Err("power actions are only implemented on Windows".to_string())
    }
    pub fn monitor_power(_off: bool) -> Result<(), String> {
        Err("power actions are only implemented on Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_spelling_matches_the_controller_and_the_tauri_host() {
        // session.ts sends `action: 'lock' | 'shutdown'`; frontend/src-tauri/src/power.rs
        // deserialises the same lowercase strings. Anything else is refused,
        // never guessed.
        assert_eq!(PowerAction::parse("lock"), Some(PowerAction::Lock));
        assert_eq!(PowerAction::parse("shutdown"), Some(PowerAction::Shutdown));
        assert_eq!(PowerAction::parse("displays_off"), Some(PowerAction::DisplaysOff));
        assert_eq!(
            PowerAction::parse("displays_off_keep_primary"),
            Some(PowerAction::DisplaysOffKeepPrimary)
        );
        assert_eq!(PowerAction::parse("displays_on"), Some(PowerAction::DisplaysOn));
        assert_eq!(PowerAction::parse("Lock"), None);
        assert_eq!(PowerAction::parse("restart"), None);
        assert_eq!(PowerAction::parse("displaysoff"), None);
        assert_eq!(PowerAction::parse(""), None);
    }

    #[test]
    fn display_plans_broadcast_or_refuse_and_the_refusal_wording_is_pinned() {
        assert_eq!(plan(PowerAction::DisplaysOff), Plan::DisplaysOff);
        assert_eq!(plan(PowerAction::DisplaysOn), Plan::DisplaysOn);
        assert_eq!(
            plan(PowerAction::DisplaysOffKeepPrimary),
            Plan::Refuse(KEEP_PRIMARY_REFUSAL)
        );
        // The refusal never touches the OS and carries the pinned copy.
        assert_eq!(
            perform(Plan::Refuse(KEEP_PRIMARY_REFUSAL)),
            Err(KEEP_PRIMARY_REFUSAL.to_string())
        );
        assert_eq!(
            KEEP_PRIMARY_REFUSAL,
            "turning off only some displays is not available before sign-in"
        );
    }

    #[test]
    fn the_shutdown_reason_is_the_attended_hosts_literal() {
        // session.ts: `export const SHUTDOWN_REASON = 'the device is shutting down';`
        // and deviceSessionAuth.test.ts pins the same string on that side.
        assert_eq!(SHUTDOWN_REASON, "the device is shutting down");
    }

    #[test]
    fn lock_at_the_sign_in_screen_is_a_no_op_and_shutdown_is_not() {
        assert_eq!(plan(PowerAction::Lock), Plan::NoOp);
        assert_eq!(plan(PowerAction::Shutdown), Plan::Shutdown);
        // NoOp must be carried out without touching the OS (this runs on the
        // developer's machine).
        assert_eq!(perform(Plan::NoOp), Ok(()));
    }
}
