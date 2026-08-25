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
}

impl PowerAction {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "lock" => Some(Self::Lock),
            "shutdown" => Some(Self::Shutdown),
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
}

/// Pure: the sign-in-screen host is by definition on a locked console.
pub fn plan(action: PowerAction) -> Plan {
    match action {
        PowerAction::Lock => Plan::NoOp,
        PowerAction::Shutdown => Plan::Shutdown,
    }
}

/// Carry a plan out. Errors are the OS's words, for the controller.
pub fn perform(p: Plan) -> Result<(), String> {
    match p {
        Plan::NoOp => Ok(()),
        Plan::Shutdown => imp::shutdown(),
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
        assert_eq!(PowerAction::parse("Lock"), None);
        assert_eq!(PowerAction::parse("restart"), None);
        assert_eq!(PowerAction::parse(""), None);
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
