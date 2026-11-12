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

/// The forced power-off's wire spelling (session.ts `FORCE_POWER_OFF_ACTION`):
/// the one action the `power` arm holds until the passphrase is proved.
pub const FORCE_POWER_OFF_WIRE: &str = "force_power_off";

/// The controller's spelling on the wire (`{kind:'power', action}`) — the
/// same strings the Tauri host and the TS controller use. A drift here is
/// caught by the tests below, not by a silent "unknown action".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerAction {
    Lock,
    Shutdown,
    /// The device card's Power off (docs/REMOTE_CONTROL.md, *Power off from
    /// the device list*): `shutdown /s /f /t 0`, apps closed without being
    /// asked to save. See `force_power_off`.
    ForcePowerOff,
    /// W4 display power. The sign-in agent only ever broadcasts — no ticker
    /// (nothing injects a stream of input into a locked console) and no
    /// DDC/CI (keep-primary is a signed-in convenience; see `plan`).
    DisplaysOff,
    DisplaysOffKeepPrimary,
    DisplaysOn,
    /// Topology detach/reattach — refused before sign-in (see `plan`):
    /// re-arranging the desktop layout of a machine nobody has signed into
    /// is the keep-primary reasoning with higher stakes.
    DisplaysDetachOthers,
    DisplaysReattach,
}

impl PowerAction {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "lock" => Some(Self::Lock),
            "shutdown" => Some(Self::Shutdown),
            "force_power_off" => Some(Self::ForcePowerOff),
            "displays_off" => Some(Self::DisplaysOff),
            "displays_off_keep_primary" => Some(Self::DisplaysOffKeepPrimary),
            "displays_on" => Some(Self::DisplaysOn),
            "displays_detach_others" => Some(Self::DisplaysDetachOthers),
            "displays_reattach" => Some(Self::DisplaysReattach),
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
    /// Enable SeShutdownPrivilege and InitiateShutdownW with the forcing
    /// flags (`force_power_off`): nothing on the machine is asked first.
    ForcePowerOff,
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

/// Same shape for the topology pair.
pub const TOPOLOGY_REFUSAL: &str =
    "changing the display layout is not available before sign-in";

/// Pure: the sign-in-screen host is by definition on a locked console.
pub fn plan(action: PowerAction) -> Plan {
    match action {
        PowerAction::Lock => Plan::NoOp,
        PowerAction::Shutdown => Plan::Shutdown,
        // A locked console can still have somebody's signed-in session behind
        // it (Lock hands the machine to this flavour), so the force matters
        // here too: their unsaved work is what the card's question warned of.
        PowerAction::ForcePowerOff => Plan::ForcePowerOff,
        PowerAction::DisplaysOff => Plan::DisplaysOff,
        PowerAction::DisplaysOn => Plan::DisplaysOn,
        // DDC/CI at the sign-in screen would be a SYSTEM process poking
        // monitor firmware for a machine nobody has signed into — the
        // narrow value does not carry the surface. Honest refusal instead.
        PowerAction::DisplaysOffKeepPrimary => Plan::Refuse(KEEP_PRIMARY_REFUSAL),
        // Re-arranging the desktop of a machine nobody has signed into is
        // that reasoning with higher stakes — and there is no signed-in
        // shell to restore it on session end.
        PowerAction::DisplaysDetachOthers | PowerAction::DisplaysReattach =>
            Plan::Refuse(TOPOLOGY_REFUSAL),
    }
}

/// Carry a plan out. Errors are the OS's words, for the controller.
pub fn perform(p: Plan) -> Result<(), String> {
    match p {
        Plan::NoOp => Ok(()),
        Plan::Shutdown => imp::shutdown(),
        Plan::ForcePowerOff => force_power_off(&mut imp::Os),
        Plan::DisplaysOff => imp::monitor_power(true),
        Plan::DisplaysOn => imp::monitor_power(false),
        Plan::Refuse(reason) => Err(reason.to_string()),
    }
}

// ---- the FORCED power-off ----------------------------------------------------
//
// What `shutdown /s /f /t 0` does, and why it is InitiateShutdownW and not the
// ExitWindowsEx the gentle Shutdown above uses (Microsoft Learn, both pages):
//  - ExitWindowsEx's EWX_FORCE "has no effect if terminal services is
//    enabled", and the Remote Desktop Services service runs on every current
//    Windows, so that flag forces nothing there;
//  - InitiateShutdownW's SHUTDOWN_FORCE_SELF logs the caller's own session off
//    forcefully ("if this flag is not set ... a shutdown is not guaranteed even
//    if the function returns successfully"), SHUTDOWN_FORCE_OTHERS does the
//    same to every other signed-in session (without it the call fails with
//    ERROR_SHUTDOWN_USERS_LOGGED_ON), SHUTDOWN_POWEROFF turns the power off,
//    and SHUTDOWN_GRACE_OVERRIDE plus a grace period of 0 means now, even over
//    a shutdown somebody has scheduled;
//  - no SHUTDOWN_HYBRID: "InitiateShutdown always initiate[s] a full system
//    shutdown if the SHUTDOWN_HYBRID flag is absent". The Devices page tells
//    people to turn Fast Startup off because a hybrid shutdown usually cannot
//    be woken, so a full one is what Wake & connect can bring back;
//  - no SHUTDOWN_INSTALL_UPDATES: a forced power-off is not the moment for a
//    half-hour update nobody is there to watch.
// It needs SeShutdownPrivilege ENABLED, which LocalSystem holds.
//
// The OS sits behind `ShutdownOs` so a test can check exactly what is asked
// without the machine running the test going down; `imp::Os` is the only real
// implementation and refuses to run in a test build at all.

/// SHUTDOWN_FORCE_OTHERS | SHUTDOWN_FORCE_SELF | SHUTDOWN_POWEROFF |
/// SHUTDOWN_GRACE_OVERRIDE. Literals so the pure logic builds everywhere; a
/// Windows test checks each against the `windows` crate's constant.
pub const FORCE_POWER_OFF_FLAGS: u32 = 0x1 | 0x2 | 0x8 | 0x20;
/// Seconds of warning before it goes: none.
pub const FORCE_POWER_OFF_GRACE_SECS: u32 = 0;
/// SHTDN_REASON_MAJOR_OTHER | SHTDN_REASON_MINOR_OTHER |
/// SHTDN_REASON_FLAG_PLANNED (0 | 0 | 0x8000_0000) — the gentle Shutdown's
/// reason. Never 0: that logs an UNPLANNED shutdown, which can make Windows
/// write a system-state file first and slow the power-off down.
pub const POWER_OFF_REASON: u32 = 0x8000_0000;
/// ERROR_NOT_READY: InitiateShutdown's documented answer when fast user
/// switching is on and nobody is signed in — the one case where this flavour
/// falls back to the call the gentle Shutdown has always made here.
pub const ERROR_NOT_READY: u32 = 21;
/// EWX_SHUTDOWN | EWX_POWEROFF | EWX_FORCE for that fallback. With nobody
/// signed in there is no unsaved work for EWX_FORCE to fail to discard.
pub const NOBODY_SIGNED_IN_EXIT_FLAGS: u32 = 0x1 | 0x8 | 0x4;

/// The OS calls a forced power-off makes, as a seam.
pub trait ShutdownOs {
    /// AdjustTokenPrivileges(SeShutdownPrivilege, enabled).
    fn enable_shutdown_privilege(&mut self) -> Result<(), String>;
    /// InitiateShutdownW(local machine, no message, grace, flags, reason);
    /// its return value (0 = ERROR_SUCCESS).
    fn initiate_shutdown(&mut self, grace_secs: u32, flags: u32, reason: u32) -> u32;
    /// ExitWindowsEx(flags, reason).
    fn exit_windows(&mut self, flags: u32, reason: u32) -> Result<(), String>;
}

/// Power the machine off now, closing everything without asking it to save.
/// Ok means Windows accepted the request (it then proceeds asynchronously);
/// Err carries a reason the controller shows as it is.
pub fn force_power_off(os: &mut impl ShutdownOs) -> Result<(), String> {
    os.enable_shutdown_privilege()?;
    match os.initiate_shutdown(FORCE_POWER_OFF_GRACE_SECS, FORCE_POWER_OFF_FLAGS, POWER_OFF_REASON) {
        0 => Ok(()),
        ERROR_NOT_READY => os.exit_windows(NOBODY_SIGNED_IN_EXIT_FLAGS, POWER_OFF_REASON),
        code => Err(force_power_off_refusal(code)),
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

    /// The real OS behind `super::force_power_off`. A TEST BUILD PANICS
    /// before any call: no test may power the machine running it off
    /// (session.rs's POWER_SEAM keeps the session tests away from here; this
    /// is the second wall).
    pub struct Os;

    impl super::ShutdownOs for Os {
        fn enable_shutdown_privilege(&mut self) -> Result<(), String> {
            if cfg!(test) {
                panic!("a test reached the real SeShutdownPrivilege call");
            }
            enable_privilege("SeShutdownPrivilege")
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
    pub fn shutdown() -> Result<(), String> {
        Err("power actions are only implemented on Windows".to_string())
    }
    /// Not Windows: the forced power-off is refused at its first step, with
    /// the same words as every other power action here.
    pub struct Os;
    impl super::ShutdownOs for Os {
        fn enable_shutdown_privilege(&mut self) -> Result<(), String> {
            Err("power actions are only implemented on Windows".to_string())
        }
        fn initiate_shutdown(&mut self, _grace_secs: u32, _flags: u32, _reason: u32) -> u32 {
            50 // ERROR_NOT_SUPPORTED
        }
        fn exit_windows(&mut self, _flags: u32, _reason: u32) -> Result<(), String> {
            Err("power actions are only implemented on Windows".to_string())
        }
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
        // session.ts FORCE_POWER_OFF_ACTION and the Tauri host's serde
        // spelling; pinned on all three sides.
        assert_eq!(PowerAction::parse("force_power_off"), Some(PowerAction::ForcePowerOff));
        assert_eq!(PowerAction::parse("forcepoweroff"), None);
        assert_eq!(PowerAction::parse("power_off"), None);
        assert_eq!(PowerAction::parse("displays_off"), Some(PowerAction::DisplaysOff));
        assert_eq!(
            PowerAction::parse("displays_off_keep_primary"),
            Some(PowerAction::DisplaysOffKeepPrimary)
        );
        assert_eq!(PowerAction::parse("displays_on"), Some(PowerAction::DisplaysOn));
        assert_eq!(
            PowerAction::parse("displays_detach_others"),
            Some(PowerAction::DisplaysDetachOthers)
        );
        assert_eq!(PowerAction::parse("displays_reattach"), Some(PowerAction::DisplaysReattach));
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
        // The topology pair is refused before sign-in the same way, wording
        // pinned so the controller-facing copy cannot drift.
        assert_eq!(plan(PowerAction::DisplaysDetachOthers), Plan::Refuse(TOPOLOGY_REFUSAL));
        assert_eq!(plan(PowerAction::DisplaysReattach), Plan::Refuse(TOPOLOGY_REFUSAL));
        assert_eq!(
            TOPOLOGY_REFUSAL,
            "changing the display layout is not available before sign-in"
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
        assert_eq!(plan(PowerAction::ForcePowerOff), Plan::ForcePowerOff);
        // NoOp must be carried out without touching the OS (this runs on the
        // developer's machine).
        assert_eq!(perform(Plan::NoOp), Ok(()));
    }

    // ---- the forced power-off, against a recording stand-in for Windows ----
    //
    // NOTHING here reaches the OS: `force_power_off` is handed `FakeOs`, and
    // the real `imp::Os` panics in a test build before any call.

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
        // The privilege FIRST (Windows refuses the call without it enabled),
        // then ONE InitiateShutdownW: grace 0, the four forcing flags, the
        // planned reason. Never ExitWindowsEx on the ordinary path.
        assert_eq!(
            os.calls,
            vec!["privilege".to_string(), "initiate grace=0 flags=0x2b reason=0x80000000".to_string()]
        );
        // Flag by flag, so a change reads as what it changes.
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
        assert_eq!(POWER_OFF_REASON, 0x8000_0000, "planned, never 0 (an unplanned shutdown can dump state first)");
    }

    #[test]
    fn without_the_privilege_nothing_is_asked_of_windows() {
        let mut os = FakeOs::answering(0);
        os.privilege = Err("this account does not hold SeShutdownPrivilege".into());
        assert_eq!(force_power_off(&mut os), Err("this account does not hold SeShutdownPrivilege".into()));
        assert_eq!(os.calls, vec!["privilege".to_string()]);
    }

    #[test]
    fn nobody_signed_in_falls_back_to_the_call_the_gentle_shutdown_makes_here_with_force() {
        let mut os = FakeOs::answering(ERROR_NOT_READY);
        assert_eq!(force_power_off(&mut os), Ok(()));
        assert_eq!(
            os.calls,
            vec![
                "privilege".to_string(),
                "initiate grace=0 flags=0x2b reason=0x80000000".to_string(),
                // EWX_SHUTDOWN | EWX_FORCE | EWX_POWEROFF
                "exit flags=0xd reason=0x80000000".to_string(),
            ]
        );
        os = FakeOs::answering(ERROR_NOT_READY);
        os.exit = Err("ExitWindowsEx failed: x".into());
        assert_eq!(force_power_off(&mut os), Err("ExitWindowsEx failed: x".into()));
    }

    #[test]
    fn a_refusal_is_said_in_words_and_tries_nothing_else() {
        for (code, words) in [
            (5u32, "may not shut it down"),
            (1115, "already under way"),
            (1190, "error 1190"),
        ] {
            let mut os = FakeOs::answering(code);
            let err = force_power_off(&mut os).expect_err("a refused call is an error");
            assert!(err.contains(words), "{code}: {err}");
            assert_eq!(os.calls.len(), 2, "{code}: no fallback after a real refusal: {:?}", os.calls);
        }
    }

    /// The literals above are the SDK's values (checked where the SDK is).
    #[cfg(windows)]
    #[test]
    fn the_literal_flags_are_the_windows_sdk_constants() {
        use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_NOT_READY as SDK_NOT_READY, ERROR_SHUTDOWN_IN_PROGRESS};
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
        assert_eq!(5, ERROR_ACCESS_DENIED.0);
        assert_eq!(1115, ERROR_SHUTDOWN_IN_PROGRESS.0);
    }

    // Deliberately NO test hands `force_power_off` the real `imp::Os`, not
    // even to watch its test-build panic: a test like that would power this
    // machine off the day somebody removed the guard to see the test go red.
    // The guard is reviewed by reading.
}
