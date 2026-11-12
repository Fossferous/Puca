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
    /// The device card's Power off: `shutdown /s /f /t 0`. Apps are closed
    /// without being asked to save — `force_power_off` below says exactly how
    /// and why it is InitiateShutdownW. The controller asks before sending it,
    /// naming the PC and the unsaved work.
    ForcePowerOff,
    /// All panels dark + the keep-off ticker (display_power.rs).
    DisplaysOff,
    /// Every panel BUT the primary dark, via DDC/CI. Honest per-monitor.
    DisplaysOffKeepPrimary,
    /// Ticker off, DDC wake, OS wake, input nudge.
    DisplaysOn,
    /// TEMPORARILY remove the non-primary displays from the desktop topology
    /// (display_topology.rs) — windows re-arrange onto the primary and the
    /// pointer cannot leave it. Restored on reattach, session end, or the
    /// next app start (crash marker); never written to the CCD database.
    DisplaysDetachOthers,
    /// Put the detached displays back.
    DisplaysReattach,
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
            // Routed to display_power / display_topology by the command layer
            // before this is ever called; reaching here is a routing bug, not
            // an OS state.
            PowerAction::DisplaysOff
            | PowerAction::DisplaysOffKeepPrimary
            | PowerAction::DisplaysOn
            | PowerAction::DisplaysDetachOthers
            | PowerAction::DisplaysReattach => Err(PowerError::Failed(
                "display actions are routed to display_power, not perform()".into(),
            )),
            PowerAction::ForcePowerOff => Err(PowerError::Failed(
                "the forced power-off is routed to force_power_off, not perform()".into(),
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

    /// The real OS behind `super::force_power_off`. A TEST BUILD PANICS
    /// before any call: no test may power the machine running it off.
    pub struct Os;

    impl super::ShutdownOs for Os {
        fn enable_shutdown_privilege(&mut self) -> Result<(), String> {
            if cfg!(test) {
                panic!("a test reached the real SeShutdownPrivilege call");
            }
            enable_privilege("SeShutdownPrivilege").map_err(|e| e.to_string())
        }

        fn initiate_shutdown(&mut self, grace_secs: u32, flags: u32, reason: u32) -> u32 {
            if cfg!(test) {
                panic!("a test reached the real InitiateShutdownW");
            }
            use windows::Win32::System::Shutdown::{InitiateShutdownW, SHUTDOWN_FLAGS, SHUTDOWN_REASON};
            // NULL machine = this one; NULL message = no dialog text.
            unsafe {
                InitiateShutdownW(
                    PCWSTR::null(),
                    PCWSTR::null(),
                    grace_secs,
                    SHUTDOWN_FLAGS(flags),
                    SHUTDOWN_REASON(reason),
                )
            }
        }

        fn exit_windows(&mut self, flags: u32, reason: u32) -> Result<(), String> {
            if cfg!(test) {
                panic!("a test reached the real ExitWindowsEx");
            }
            use windows::Win32::System::Shutdown::{EXIT_WINDOWS_FLAGS, SHUTDOWN_REASON};
            unsafe {
                ExitWindowsEx(EXIT_WINDOWS_FLAGS(flags), SHUTDOWN_REASON(reason))
                    .map_err(|e| format!("ExitWindowsEx failed: {e}"))
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
    /// Not Windows (a Linux desktop host): refused at the first step, with the
    /// same words as Lock and Shut down there. The controller shows them.
    pub struct Os;
    impl super::ShutdownOs for Os {
        fn enable_shutdown_privilege(&mut self) -> Result<(), String> {
            Err(PowerError::Unsupported.to_string())
        }
        fn initiate_shutdown(&mut self, _grace_secs: u32, _flags: u32, _reason: u32) -> u32 {
            50 // ERROR_NOT_SUPPORTED
        }
        fn exit_windows(&mut self, _flags: u32, _reason: u32) -> Result<(), String> {
            Err(PowerError::Unsupported.to_string())
        }
    }
}

// ---- the FORCED power-off ----------------------------------------------------
//
// KEEP IN STEP with crates/puca-agent/src/power.rs, which carries the same
// thirty lines for the sign-in-screen host (the two are deliberately not
// shared — see that file's header). Both are pinned by the same tests.
//
// What `shutdown /s /f /t 0` does, and why it is InitiateShutdownW and not the
// ExitWindowsEx the gentle Shutdown uses (Microsoft Learn, both pages):
//  - ExitWindowsEx's EWX_FORCE "has no effect if terminal services is
//    enabled", and the Remote Desktop Services service runs on every current
//    Windows, so that flag forces nothing there;
//  - SHUTDOWN_FORCE_SELF logs this session off forcefully ("if this flag is
//    not set ... a shutdown is not guaranteed even if the function returns
//    successfully"), SHUTDOWN_FORCE_OTHERS does the same to every other
//    signed-in session (without it the call fails with
//    ERROR_SHUTDOWN_USERS_LOGGED_ON), SHUTDOWN_POWEROFF turns the power off,
//    and SHUTDOWN_GRACE_OVERRIDE with a grace period of 0 means now, even
//    over a shutdown somebody has scheduled;
//  - no SHUTDOWN_HYBRID: without it InitiateShutdown "always initiate[s] a
//    full system shutdown". The Devices page tells people to turn Fast
//    Startup off because a hybrid shutdown usually cannot be woken, so a full
//    one is what Wake & connect can bring back;
//  - no SHUTDOWN_INSTALL_UPDATES: not the moment for a long update nobody is
//    there to watch.
// It needs SeShutdownPrivilege ENABLED: every interactive user holds it.

/// SHUTDOWN_FORCE_OTHERS | SHUTDOWN_FORCE_SELF | SHUTDOWN_POWEROFF |
/// SHUTDOWN_GRACE_OVERRIDE; a Windows test checks it against the SDK.
pub const FORCE_POWER_OFF_FLAGS: u32 = 0x1 | 0x2 | 0x8 | 0x20;
/// Seconds of warning before it goes: none.
pub const FORCE_POWER_OFF_GRACE_SECS: u32 = 0;
/// SHTDN_REASON_MAJOR_OTHER | SHTDN_REASON_MINOR_OTHER |
/// SHTDN_REASON_FLAG_PLANNED — the gentle Shutdown's reason. Never 0, which
/// logs an UNPLANNED shutdown that can make Windows dump state first.
pub const POWER_OFF_REASON: u32 = 0x8000_0000;
/// ERROR_NOT_READY: InitiateShutdown's documented answer when fast user
/// switching is on and nobody is signed in. Cannot happen from the signed-in
/// shell; handled the same way as the agent so the two stay one design.
pub const ERROR_NOT_READY: u32 = 21;
/// EWX_SHUTDOWN | EWX_POWEROFF | EWX_FORCE for that fallback.
pub const NOBODY_SIGNED_IN_EXIT_FLAGS: u32 = 0x1 | 0x8 | 0x4;

/// The OS calls a forced power-off makes, as a seam.
pub trait ShutdownOs {
    /// AdjustTokenPrivileges(SeShutdownPrivilege, enabled).
    fn enable_shutdown_privilege(&mut self) -> Result<(), String>;
    /// InitiateShutdownW(this machine, no message, grace, flags, reason);
    /// its return value (0 = ERROR_SUCCESS).
    fn initiate_shutdown(&mut self, grace_secs: u32, flags: u32, reason: u32) -> u32;
    /// ExitWindowsEx(flags, reason).
    fn exit_windows(&mut self, flags: u32, reason: u32) -> Result<(), String>;
}

/// Power this machine off now, closing everything without asking it to save.
/// Ok means Windows accepted the request (it then proceeds asynchronously).
pub fn force_power_off(os: &mut impl ShutdownOs) -> Result<(), PowerError> {
    os.enable_shutdown_privilege().map_err(PowerError::Failed)?;
    match os.initiate_shutdown(FORCE_POWER_OFF_GRACE_SECS, FORCE_POWER_OFF_FLAGS, POWER_OFF_REASON) {
        0 => Ok(()),
        ERROR_NOT_READY => os
            .exit_windows(NOBODY_SIGNED_IN_EXIT_FLAGS, POWER_OFF_REASON)
            .map_err(PowerError::Failed),
        code => Err(PowerError::Failed(force_power_off_refusal(code))),
    }
}

/// What a refused InitiateShutdownW means, in words for the person who asked.
pub fn force_power_off_refusal(code: u32) -> String {
    match code {
        // ERROR_ACCESS_DENIED
        5 => "Windows refused: the account Púca runs as there may not shut it down".to_string(),
        // ERROR_SHUTDOWN_IN_PROGRESS: Windows takes no second shutdown while
        // one is going, and a gentle one can be held by an app with unsaved
        // work until somebody at the machine answers it.
        1115 => "a shutdown is already under way there (an app may be holding it, \
                 waiting for somebody at that PC to save), and Windows will not force \
                 a second one"
            .to_string(),
        code => format!("Windows refused to power it off (error {code})"),
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
    topology: tauri::State<'_, std::sync::Arc<crate::display_topology::DisplayTopology>>,
    action: PowerAction,
) -> Result<Option<String>, String> {
    let dp = state.inner().clone();
    let dt = topology.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match action {
        PowerAction::Lock | PowerAction::Shutdown => {
            imp::perform(action).map_err(|e| e.to_string()).map(|()| None)
        }
        PowerAction::ForcePowerOff => {
            force_power_off(&mut imp::Os).map_err(|e| e.to_string()).map(|()| None)
        }
        PowerAction::DisplaysOff => dp.displays_off().map(|()| None),
        PowerAction::DisplaysOffKeepPrimary => dp.displays_off_keep_primary().map(Some),
        PowerAction::DisplaysOn => dp.displays_on().map(|()| None),
        PowerAction::DisplaysDetachOthers => {
            // A detach makes any keep-off ticker moot — and a ticker still
            // broadcasting SC_MONITORPOWER over the one remaining display
            // would keep the screen being streamed dark.
            dp.disengage();
            dt.detach_others().map(Some)
        }
        PowerAction::DisplaysReattach => dt.reattach().map(|()| None),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Session teardown hook. Display POWER stays as set (the user decision
/// display_power.rs documents: stop the keep-off ticker, relight nothing);
/// display TOPOLOGY restores when the caller says this was the LAST live
/// host session (display_topology.rs's header: a detached topology is not
/// self-healing and must not outlive the sessions that asked for it — but
/// one viewer dropping must not re-extend the desktop under another that is
/// still working on it). `restore_topology` defaults TRUE so an older webapp
/// that passes nothing keeps the safe behaviour. The restore is a blocking
/// SetDisplayConfig, so it leaves the webview thread (same W4-N2 rule as
/// power_action).
#[tauri::command]
pub fn display_power_session_end(
    state: tauri::State<'_, std::sync::Arc<crate::display_power::DisplayPower>>,
    topology: tauri::State<'_, std::sync::Arc<crate::display_topology::DisplayTopology>>,
    restore_topology: Option<bool>,
) {
    state.inner().on_session_end();
    if restore_topology == Some(false) {
        return;
    }
    let dt = topology.inner().clone();
    std::thread::Builder::new()
        .name("display-topology-restore".into())
        .spawn(move || dt.on_session_end())
        .map(|_| ())
        .unwrap_or_else(|e| {
            eprintln!("[display-topology] could not spawn the restore thread ({e}); restoring inline");
            topology.inner().on_session_end();
        });
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
        assert_eq!(
            serde_json::from_str::<PowerAction>("\"displays_detach_others\"").unwrap(),
            PowerAction::DisplaysDetachOthers
        );
        assert_eq!(
            serde_json::from_str::<PowerAction>("\"displays_reattach\"").unwrap(),
            PowerAction::DisplaysReattach
        );
        assert!(serde_json::from_str::<PowerAction>("\"restart\"").is_err());
        assert!(serde_json::from_str::<PowerAction>("\"Lock\"").is_err());
        assert!(serde_json::from_str::<PowerAction>("\"displaysoff\"").is_err());
        // The device card's Power off: session.ts FORCE_POWER_OFF_ACTION and
        // the agent's parse spell it the same.
        assert_eq!(
            serde_json::from_str::<PowerAction>("\"force_power_off\"").unwrap(),
            PowerAction::ForcePowerOff
        );
        assert!(serde_json::from_str::<PowerAction>("\"forcepoweroff\"").is_err());
        assert!(serde_json::from_str::<PowerAction>("\"power_off\"").is_err());
    }

    // ---- the forced power-off, against a recording stand-in for Windows ----
    //
    // NOTHING here reaches the OS: `force_power_off` is handed `FakeOs`. No
    // test hands it the real `imp::Os` — not even to watch its test-build
    // panic, because that test would power this machine off the day someone
    // removed the guard to see it go red. The guard is reviewed by reading.

    use super::{
        force_power_off, PowerError, ShutdownOs, ERROR_NOT_READY, FORCE_POWER_OFF_FLAGS,
        FORCE_POWER_OFF_GRACE_SECS, NOBODY_SIGNED_IN_EXIT_FLAGS, POWER_OFF_REASON,
    };

    struct FakeOs {
        calls: Vec<String>,
        privilege: Result<(), String>,
        initiate: u32,
        exit: Result<(), String>,
    }

    impl FakeOs {
        fn answering(initiate: u32) -> Self {
            FakeOs { calls: Vec::new(), privilege: Ok(()), initiate, exit: Ok(()) }
        }
    }

    impl ShutdownOs for FakeOs {
        fn enable_shutdown_privilege(&mut self) -> Result<(), String> {
            self.calls.push("privilege".into());
            self.privilege.clone()
        }
        fn initiate_shutdown(&mut self, grace_secs: u32, flags: u32, reason: u32) -> u32 {
            self.calls.push(format!("initiate grace={grace_secs} flags={flags:#x} reason={reason:#x}"));
            self.initiate
        }
        fn exit_windows(&mut self, flags: u32, reason: u32) -> Result<(), String> {
            self.calls.push(format!("exit flags={flags:#x} reason={reason:#x}"));
            self.exit.clone()
        }
    }

    #[test]
    fn force_power_off_asks_windows_for_exactly_a_forced_full_power_off_with_no_grace() {
        let mut os = FakeOs::answering(0);
        assert_eq!(force_power_off(&mut os), Ok(()));
        assert_eq!(
            os.calls,
            vec!["privilege".to_string(), "initiate grace=0 flags=0x2b reason=0x80000000".to_string()]
        );
        let f = FORCE_POWER_OFF_FLAGS;
        assert_ne!(f & 0x1, 0, "SHUTDOWN_FORCE_OTHERS: other signed-in sessions are closed too");
        assert_ne!(f & 0x2, 0, "SHUTDOWN_FORCE_SELF: this session's apps are not asked to save");
        assert_ne!(f & 0x8, 0, "SHUTDOWN_POWEROFF: the power goes off");
        assert_ne!(f & 0x20, 0, "SHUTDOWN_GRACE_OVERRIDE: now, even over a scheduled shutdown");
        assert_eq!(f & 0x4, 0, "never SHUTDOWN_RESTART");
        assert_eq!(f & 0x10, 0, "never SHUTDOWN_NOREBOOT (that leaves the power on)");
        assert_eq!(f & 0x40, 0, "never SHUTDOWN_INSTALL_UPDATES");
        assert_eq!(f & 0x80, 0, "never SHUTDOWN_RESTARTAPPS");
        assert_eq!(f & 0x200, 0, "never SHUTDOWN_HYBRID: a hybrid shutdown usually cannot be woken");
        assert_eq!(FORCE_POWER_OFF_GRACE_SECS, 0);
        assert_eq!(POWER_OFF_REASON, 0x8000_0000);
    }

    #[test]
    fn without_the_privilege_nothing_is_asked_of_windows() {
        let mut os = FakeOs::answering(0);
        os.privilege = Err("this account does not hold SeShutdownPrivilege".into());
        assert_eq!(
            force_power_off(&mut os),
            Err(PowerError::Failed("this account does not hold SeShutdownPrivilege".into()))
        );
        assert_eq!(os.calls, vec!["privilege".to_string()]);
    }

    #[test]
    fn nobody_signed_in_falls_back_to_exit_windows_with_force() {
        let mut os = FakeOs::answering(ERROR_NOT_READY);
        assert_eq!(force_power_off(&mut os), Ok(()));
        assert_eq!(os.calls[2], "exit flags=0xd reason=0x80000000");
        assert_eq!(NOBODY_SIGNED_IN_EXIT_FLAGS, 0xd);
    }

    #[test]
    fn a_refusal_is_said_in_words_and_tries_nothing_else() {
        for (code, words) in [(5u32, "may not shut it down"), (1115, "already under way"), (1190, "error 1190")] {
            let mut os = FakeOs::answering(code);
            match force_power_off(&mut os) {
                Err(PowerError::Failed(e)) => assert!(e.contains(words), "{code}: {e}"),
                other => panic!("{code}: {other:?}"),
            }
            assert_eq!(os.calls.len(), 2, "{code}: {:?}", os.calls);
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_literal_flags_are_the_windows_sdk_constants() {
        use windows::Win32::Foundation::ERROR_NOT_READY as SDK_NOT_READY;
        use windows::Win32::System::Shutdown::*;
        assert_eq!(
            FORCE_POWER_OFF_FLAGS,
            (SHUTDOWN_FORCE_OTHERS | SHUTDOWN_FORCE_SELF | SHUTDOWN_POWEROFF | SHUTDOWN_GRACE_OVERRIDE).0
        );
        assert_eq!(
            POWER_OFF_REASON,
            (SHTDN_REASON_MAJOR_OTHER | SHTDN_REASON_MINOR_OTHER | SHTDN_REASON_FLAG_PLANNED).0
        );
        assert_eq!(NOBODY_SIGNED_IN_EXIT_FLAGS, (EWX_SHUTDOWN | EWX_POWEROFF | EWX_FORCE).0);
        assert_eq!(ERROR_NOT_READY, SDK_NOT_READY.0);
    }

    /// The agent's copy (crates/puca-agent/src/power.rs) must ask Windows for
    /// the same thing. Read from its source, since this crate cannot depend on
    /// that one: a change to either side's flags fails here until both agree.
    #[test]
    fn the_sign_in_screen_agent_asks_for_the_same_power_off() {
        let agent = include_str!("../../../crates/puca-agent/src/power.rs");
        for line in [
            "pub const FORCE_POWER_OFF_FLAGS: u32 = 0x1 | 0x2 | 0x8 | 0x20;",
            "pub const FORCE_POWER_OFF_GRACE_SECS: u32 = 0;",
            "pub const POWER_OFF_REASON: u32 = 0x8000_0000;",
            "pub const NOBODY_SIGNED_IN_EXIT_FLAGS: u32 = 0x1 | 0x8 | 0x4;",
            "\"force_power_off\" => Some(Self::ForcePowerOff),",
        ] {
            assert!(agent.contains(line), "the agent's power.rs no longer has: {line}");
        }
        let here = include_str!("power.rs");
        for line in [
            "pub const FORCE_POWER_OFF_FLAGS: u32 = 0x1 | 0x2 | 0x8 | 0x20;",
            "pub const FORCE_POWER_OFF_GRACE_SECS: u32 = 0;",
            "pub const POWER_OFF_REASON: u32 = 0x8000_0000;",
            "pub const NOBODY_SIGNED_IN_EXIT_FLAGS: u32 = 0x1 | 0x8 | 0x4;",
        ] {
            assert!(here.contains(line), "this power.rs no longer has: {line}");
        }
    }
}
