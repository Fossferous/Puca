//! Power / session actions a CONTROLLER can ask this (attended) host to do:
//! lock the console, or shut the machine down.
//!
//! Runs in the Tauri process, i.e. as the signed-in interactive user — which
//! is exactly the process that may do both: `LockWorkStation` needs no
//! privilege at all, and shutdown needs `SeShutdownPrivilege`, which every
//! interactive user HOLDS but must ENABLE on its token first (the classic
//! `AdjustTokenPrivileges` dance). The sign-in-screen host is a different
//! process (the SYSTEM agent, crates/puca-agent) and carries its own arm.
//!
//! Both are machine-wide side effects, so neither happens as a side effect of
//! anything: each is an explicit command behind an explicit sealed signal
//! from the controller, and shutdown is additionally behind a confirmation on
//! the controller's side. The session's `DeviceEnd` reason is sent BEFORE the
//! action so the controller can say why it lost the machine.

/// What the controller asked for.
///
/// `snake_case`, NOT the old `lowercase`: identical bytes for the two
/// original single-word variants ("lock"/"shutdown" — the pin test proves
/// it), and the wire spelling the display actions were specified with
/// ("displays_off" …). W4 adds the three display variants; the receiving
/// ends (this file, the agent's parse, session.ts) all spell them the same,
/// pinned on each side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PowerAction {
    /// `LockWorkStation`: the console locks; the user-flavour host can no
    /// longer capture (secure desktop), so the controller follows the machine
    /// to its sign-in-screen row if one is enrolled.
    Lock,
    /// `ExitWindowsEx(EWX_SHUTDOWN | EWX_POWEROFF | EWX_FORCEIFHUNG, <reason>)`
    /// — all three in `uFlags`, the `SHTDN_REASON_*` code in `dwReason`. Apps
    /// get their WM_QUERYENDSESSION and only HUNG ones are forced — the safer
    /// of the two force flags (plain EWX_FORCE discards unsaved work outright).
    Shutdown,
    /// All panels dark + the keep-off ticker (display_power.rs).
    DisplaysOff,
    /// Every panel BUT the primary dark, via DDC/CI. Honest per-monitor.
    DisplaysOffKeepPrimary,
    /// Ticker off, DDC wake, OS wake, input nudge.
    DisplaysOn,
}

/// Why a power action could not be performed.
#[derive(Debug, PartialEq, Eq)]
pub enum PowerError {
    Failed(String),
    /// Constructed only on non-Windows builds (cfg artifact, not dead code).
    #[allow(dead_code)]
    Unsupported,
}

impl std::fmt::Display for PowerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PowerError::Failed(e) => write!(f, "{e}"),
            PowerError::Unsupported => write!(f, "power actions are only implemented on Windows"),
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{PowerAction, PowerError};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID};
    use windows::Win32::Security::{
        AdjustTokenPrivileges, LookupPrivilegeValueW, SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES,
        TOKEN_PRIVILEGES, TOKEN_QUERY,
    };
    use windows::Win32::System::Shutdown::{
        ExitWindowsEx, LockWorkStation, EWX_FORCEIFHUNG, EWX_POWEROFF, EWX_SHUTDOWN,
        SHTDN_REASON_FLAG_PLANNED, SHTDN_REASON_MAJOR_OTHER, SHTDN_REASON_MINOR_OTHER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// Enable a privilege on our own token. Holding a privilege is not enough
    /// on Windows — it must be enabled before the call that needs it, and
    /// `AdjustTokenPrivileges` reports the "you don't hold it" case through
    /// `ERROR_NOT_ALL_ASSIGNED` on a SUCCESS return, so both are checked.
    fn enable_privilege(name: &str) -> Result<(), PowerError> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token)
                .map_err(|e| PowerError::Failed(format!("OpenProcessToken failed: {e}")))?;
            let result = (|| {
                let mut luid = LUID::default();
                LookupPrivilegeValueW(PCWSTR::null(), PCWSTR(wide.as_ptr()), &mut luid)
                    .map_err(|e| PowerError::Failed(format!("LookupPrivilegeValue({name}) failed: {e}")))?;
                let mut tp = TOKEN_PRIVILEGES::default();
                tp.PrivilegeCount = 1;
                tp.Privileges[0].Luid = luid;
                tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
                AdjustTokenPrivileges(token, false, Some(&tp), 0, None, None)
                    .map_err(|e| PowerError::Failed(format!("AdjustTokenPrivileges({name}) failed: {e}")))?;
                // ERROR_NOT_ALL_ASSIGNED (1300) arrives as a last-error on success.
                let last = windows::core::Error::from_win32();
                if last.code().0 as u32 & 0xFFFF == 1300 {
                    return Err(PowerError::Failed(format!("this account does not hold {name}")));
                }
                Ok(())
            })();
            let _ = CloseHandle(token);
            result
        }
    }

    pub fn perform(action: PowerAction) -> Result<(), PowerError> {
        match action {
            // Routed to display_power by the command layer before this is
            // ever called; reaching here is a routing bug, not an OS state.
            PowerAction::DisplaysOff
            | PowerAction::DisplaysOffKeepPrimary
            | PowerAction::DisplaysOn => Err(PowerError::Failed(
                "display actions are routed to display_power, not perform()".into(),
            )),
            PowerAction::Lock => unsafe {
                LockWorkStation().map_err(|e| PowerError::Failed(format!("LockWorkStation failed: {e}")))
            },
            PowerAction::Shutdown => {
                enable_privilege("SeShutdownPrivilege")?;
                unsafe {
                    ExitWindowsEx(
                        EWX_SHUTDOWN | EWX_POWEROFF | EWX_FORCEIFHUNG,
                        SHTDN_REASON_MAJOR_OTHER | SHTDN_REASON_MINOR_OTHER | SHTDN_REASON_FLAG_PLANNED,
                    )
                    .map_err(|e| PowerError::Failed(format!("ExitWindowsEx failed: {e}")))
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{PowerAction, PowerError};
    pub fn perform(_action: PowerAction) -> Result<(), PowerError> {
        Err(PowerError::Unsupported)
    }
}

/// Lock the console, shut the machine down, or change display power. Called
/// by the device-session host handler after the controller's sealed `power`
/// signal has passed the same unattended-access gate as input.
///
/// Resolves with an optional human DETAIL line (today only keep_primary's
/// per-monitor honesty; None for everything else) that the host relays in
/// its power-ack.
/// ASYNC + spawn_blocking, the same rule as every other blocking command in
/// this file's neighbours (lib.rs): the display arms do DDC/CI I²C round
/// trips per monitor and an HWND_BROADCAST, and a sync command would run
/// them on the webview main thread — parking the whole window while a slow
/// panel thinks (review W4-N2).
#[tauri::command]
pub async fn power_action(
    state: tauri::State<'_, std::sync::Arc<crate::display_power::DisplayPower>>,
    action: PowerAction,
) -> Result<Option<String>, String> {
    let dp = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match action {
        PowerAction::Lock | PowerAction::Shutdown => {
            imp::perform(action).map_err(|e| e.to_string()).map(|()| None)
        }
        PowerAction::DisplaysOff => dp.displays_off().map(|()| None),
        PowerAction::DisplaysOffKeepPrimary => dp.displays_off_keep_primary().map(Some),
        PowerAction::DisplaysOn => dp.displays_on().map(|()| None),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Session teardown hook: stay-as-set (stop the keep-off ticker, relight
/// nothing) — the user decision display_power.rs documents.
#[tauri::command]
pub fn display_power_session_end(
    state: tauri::State<'_, std::sync::Arc<crate::display_power::DisplayPower>>,
) {
    state.inner().on_session_end();
}

// There is deliberately NO `power_supported` probe. The controller cannot ask
// the host's shell anything before it acts — the only channel is the sealed
// session — so a probe here would have no caller, and the first version
// shipped exactly that: a registered command nothing invoked, documented as
// the reason the controls were hidden while they were offered unconditionally.
// A host that cannot do it (a non-Windows shell) answers the action itself with
// the OS's reason, which the session relays as power-failed.

#[cfg(test)]
mod tests {
    use super::PowerAction;

    /// The wire spelling the controller sends (`{kind:'power', action:'lock'|'shutdown'}`,
    /// session.ts `PowerAction`). This pins what THIS side accepts; it cannot
    /// see the TypeScript, so a rename over there is caught by the vitest
    /// power tests (deviceSessionAuth.test.ts spells the same literals), and a
    /// rename here by this. Note `cargo test` at the repo root does not reach
    /// this crate — run it in frontend/src-tauri (CLAUDE.md, gates).
    #[test]
    fn actions_deserialize_from_the_controller_spelling() {
        // THE ORIGINAL TWO MUST SURVIVE the rename_all switch byte-for-byte —
        // every deployed controller spells them exactly this way.
        assert_eq!(serde_json::from_str::<PowerAction>("\"lock\"").unwrap(), PowerAction::Lock);
        assert_eq!(serde_json::from_str::<PowerAction>("\"shutdown\"").unwrap(), PowerAction::Shutdown);
        assert_eq!(
            serde_json::from_str::<PowerAction>("\"displays_off\"").unwrap(),
            PowerAction::DisplaysOff
        );
        assert_eq!(
            serde_json::from_str::<PowerAction>("\"displays_off_keep_primary\"").unwrap(),
            PowerAction::DisplaysOffKeepPrimary
        );
        assert_eq!(
            serde_json::from_str::<PowerAction>("\"displays_on\"").unwrap(),
            PowerAction::DisplaysOn
        );
        assert!(serde_json::from_str::<PowerAction>("\"restart\"").is_err());
        assert!(serde_json::from_str::<PowerAction>("\"Lock\"").is_err());
        assert!(serde_json::from_str::<PowerAction>("\"displaysoff\"").is_err());
    }
}
