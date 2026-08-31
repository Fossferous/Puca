//! Detect — and offer to remove — remote-control machinery left on this
//! machine by a previous FULL install.
//!
//! WHY THIS EXISTS, AND WHY IT IS IN THE LITE BUILD.
//!
//! The full build can install `SovereignRemote`, a LocalSystem Windows service
//! that provides unattended and sign-in-screen remote access. It lives in
//! `%ProgramFiles%\Sovereign\service`, which is OUTSIDE the app's install
//! directory, and it is registered with the Service Control Manager. Nothing
//! in the uninstall path touches it: the NSIS hooks only kill the app, run the
//! old uninstaller and delete the app's own install directory.
//!
//! So a user who had it enabled and then switches to Lite — the build whose
//! entire promise is that it contains no remote control — keeps a
//! SYSTEM-privileged remote-access service running, with this machine's
//! enrolment secrets and unattended-arming record still on disk. The service
//! re-arms itself from those secrets on every start.
//!
//! Removing remote control from the ARTIFACT does not remove it from the HOST.
//! This module closes that gap, and it is deliberately compiled into the lite
//! build: it is the only build that can be running when a user wants this gone.
//!
//! SCOPE. This is REMOVAL ONLY. It cannot start a session, grant access, arm
//! anything or talk to the service — it queries the SCM for presence, and it
//! shells an elevated command that stops and deletes the service and erases
//! its directory. It carries no capability the lite build did not already
//! lack, which is what keeps "no remote control" true.
//!
//! ELEVATION. The installers run unelevated (Tauri's NSIS default is
//! CurrentUser), and deleting a service requires administrator rights — so
//! this cannot happen silently during install. It is a deliberate user action
//! with a UAC prompt they can decline, which is also the honest design: a
//! background app should not be able to remove a system service without
//! saying so.

use serde::Serialize;

/// Frozen names, duplicated rather than imported.
///
/// The lite build does not depend on the `puca-service` crate — that is the
/// point of the variant — so these cannot come from `puca_service::`. They are
/// declared `const` in that crate precisely because they are FROZEN: an
/// installed service is found by the name it was registered under, and
/// changing either side orphans it forever. `crates/puca-service/src/lib.rs`
/// has a unit test pinning them, and so does this module.
const SERVICE_NAME: &str = "SovereignRemote";
const SERVICE_DIR_PARENT: &str = "Sovereign";
const SERVICE_DIR_LEAF: &str = "service";

// The machine-wide secure-attention policy the service sets, and its
// ownership marker — mirrored from crates/puca-service/src/sas.rs. Frozen for
// the same reason as the service name: the marker is how we know the policy is
// OURS to remove. `reg` uses backslash-separated subkeys under HKLM.
const SAS_POLICY_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
const SAS_POLICY_VALUE: &str = "SoftwareSASGeneration";
const SAS_MARKER_KEY: &str = r"SOFTWARE\Sovereign";
const SAS_MARKER_VALUE: &str = "SovereignSetSoftwareSAS";

/// What remote-control machinery is still on this machine.
#[derive(Serialize, Default)]
pub struct RcLeftovers {
    /// The SovereignRemote service is registered with the SCM.
    pub service_installed: bool,
    /// ...and is currently RUNNING, not merely registered.
    pub service_running: bool,
    /// `%ProgramFiles%\Sovereign\service` exists.
    pub install_dir_present: bool,
    /// Its `secrets` subdirectory exists — this machine's remote-access
    /// private key, account token, signing seed and the unattended-arming
    /// record. These survive even the full build's own `deprovision`, which
    /// preserves them deliberately so an off/on cycle does not re-enrol.
    pub secrets_present: bool,
    /// Absolute path, for showing the user exactly what would be removed.
    pub install_dir: String,
}

fn install_dir() -> Option<std::path::PathBuf> {
    // Mirrors crates/puca-service/src/path_guard.rs::install_dir().
    let base = std::env::var("ProgramFiles").ok()?;
    Some(std::path::Path::new(&base).join(SERVICE_DIR_PARENT).join(SERVICE_DIR_LEAF))
}

#[cfg(windows)]
fn query_service() -> (bool, bool) {
    use windows::core::HSTRING;
    use windows::Win32::System::Services::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus,
        SC_MANAGER_CONNECT, SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_STATUS,
    };

    // SC_MANAGER_CONNECT + SERVICE_QUERY_STATUS are READ-ONLY rights and need
    // no elevation, so the banner can appear for an ordinary user.
    unsafe {
        let scm = match OpenSCManagerW(None, None, SC_MANAGER_CONNECT) {
            Ok(h) if !h.is_invalid() => h,
            _ => return (false, false),
        };
        let name = HSTRING::from(SERVICE_NAME);
        let svc = match OpenServiceW(scm, &name, SERVICE_QUERY_STATUS) {
            Ok(h) if !h.is_invalid() => h,
            // Not installed (ERROR_SERVICE_DOES_NOT_EXIST) — the common case.
            _ => {
                let _ = CloseServiceHandle(scm);
                return (false, false);
            }
        };
        let mut status = SERVICE_STATUS::default();
        let running = QueryServiceStatus(svc, &mut status).is_ok()
            && status.dwCurrentState == SERVICE_RUNNING;
        let _ = CloseServiceHandle(svc);
        let _ = CloseServiceHandle(scm);
        (true, running)
    }
}

#[cfg(not(windows))]
fn query_service() -> (bool, bool) {
    // The service is Windows-only; there is nothing to find elsewhere.
    (false, false)
}

/// Read a REG_DWORD under HKLM. Reading these keys needs no elevation (only
/// writing does), so the ownership decision can be made before the UAC prompt.
#[cfg(windows)]
fn read_hklm_dword(subkey: &str, value: &str) -> Option<u32> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD,
    };

    unsafe {
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // RegGetValueW opens, queries and type-checks against a PREDEFINED key
        // in one call, so there is no handle to close on any path. A non-DWORD
        // value is rejected by RRF_RT_REG_DWORD, which is what we want: a
        // marker of the wrong type is not one we wrote.
        let rc = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &HSTRING::from(subkey),
            &HSTRING::from(value),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        );
        if rc == ERROR_SUCCESS {
            Some(data)
        } else {
            None
        }
    }
}

/// The SAS-policy portion of the elevated removal, mirroring the service's own
/// `remove_policy_if_ours` (crates/puca-service/src/sas.rs) EXACTLY:
///
///   - marker != 1                 -> not ours; touch nothing.
///   - marker == 1, policy absent  -> delete the (stale) marker only.
///   - marker == 1, policy != 1    -> changed since we set it, so it is theirs
///                                    now; delete the marker, leave the policy.
///   - marker == 1, policy == 1    -> delete the policy, and the marker ONLY IF
///                                    that succeeded (`&&`), so a refused delete
///                                    does not orphan the marker.
///
/// Returns the `cmd` fragment to append (empty when there is nothing to do).
#[cfg(windows)]
fn sas_removal_fragment() -> String {
    let marker = read_hklm_dword(SAS_MARKER_KEY, SAS_MARKER_VALUE);
    if marker != Some(1) {
        return String::new(); // NotOurs — never delete a policy we did not set.
    }
    let policy = read_hklm_dword(SAS_POLICY_KEY, SAS_POLICY_VALUE);
    let del_marker = format!(
        "reg delete \"HKLM\\{k}\" /v {v} /f >nul 2>&1",
        k = SAS_MARKER_KEY,
        v = SAS_MARKER_VALUE,
    );
    match policy {
        // Only when the value is still the 1 we wrote do we remove it, and the
        // marker follows only on success — same ordering as the service.
        Some(1) => format!(
            " & (reg delete \"HKLM\\{k}\" /v {v} /f >nul 2>&1 && {del_marker})",
            k = SAS_POLICY_KEY,
            v = SAS_POLICY_VALUE,
        ),
        // Absent, or changed by someone else: leave the policy, drop our marker.
        _ => format!(" & {del_marker}"),
    }
}

/// What is still installed. Cheap and read-only — safe to call on every launch.
#[tauri::command]
pub fn rc_leftovers_status() -> RcLeftovers {
    // In a build that CONTAINS remote control, the service is a MANAGED
    // component — Settings → Devices owns enrol/update/remove — and nothing
    // this module can see is ever a "leftover" there. 0.8.127 shipped without
    // this guard and with the banner mounted in the full build: every machine
    // with sign-in-screen access enrolled got a red security banner branding
    // its own service a stray and offering to delete its enrolment secrets,
    // and the banner (z 10001) sat exactly on top of ServiceUpdateBanner
    // (z 10000), hiding the release's genuine "service needs an update"
    // notice. `cfg!` rather than `#[cfg]` so the detection code below stays
    // compiled (and warning-free) in both variants.
    if cfg!(feature = "remote-control") {
        return RcLeftovers::default();
    }
    let dir = install_dir();
    let (service_installed, service_running) = query_service();
    RcLeftovers {
        service_installed,
        service_running,
        install_dir_present: dir.as_ref().is_some_and(|d| d.is_dir()),
        secrets_present: dir.as_ref().is_some_and(|d| d.join("secrets").is_dir()),
        install_dir: dir.map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

/// Stop and delete the service, then erase its directory INCLUDING secrets.
///
/// Runs elevated via ShellExecuteW's `runas` verb, which raises the UAC prompt.
/// Returns as soon as the user answers it — an `Ok` means the elevated process
/// was LAUNCHED, never that removal succeeded, so the caller must re-poll
/// `rc_leftovers_status()` rather than assume. Reporting success here would be
/// the same class of lie as an installer that reports a deploy it never made.
///
/// `secrets` is erased deliberately, and this is the one place that does.
/// `deprovision` in the full build preserves it so that turning the feature off
/// and on again does not re-enrol the machine — a reasonable trade there. A
/// user removing remote control from a Lite install is making a much stronger
/// statement, and leaving this machine's remote-access private key, account
/// token and arming record behind would not honour it.
#[tauri::command]
pub fn rc_leftovers_remove() -> Result<(), String> {
    // Same variant gate as rc_leftovers_status, and more load-bearing here:
    // in the full build this command would stop and delete the user's own
    // enrolled service AND erase its secrets. The full build's removal path
    // is Settings → Devices (deprovision), which deliberately PRESERVES the
    // secrets; this one deliberately does not, and that trade is only right
    // on a build that contains no remote control at all.
    if cfg!(feature = "remote-control") {
        return Err(
            "This build manages the service itself — use Settings → Devices to update or remove it."
                .into(),
        );
    }
    #[cfg(windows)]
    {
        use windows::core::{HSTRING, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

        let dir = install_dir().ok_or("ProgramFiles is not set in the environment")?;

        // The service also sets a MACHINE-WIDE policy — SoftwareSASGeneration,
        // which lets software generate the secure-attention sequence for the
        // sign-in screen — and drops a marker under HKLM\SOFTWARE\Sovereign
        // recording that IT was the one that set it. That policy survives
        // deleting the service and its directory, so it has to be cleared here
        // too, or a machine that switched to Lite keeps a lingering security
        // policy no code left on it can account for.
        //
        // The decision of WHETHER to clear it is made in sas_removal_fragment()
        // above, in Rust, reading the marker and the current value and applying
        // the SAME four-way rule as the service's remove_policy_if_ours —
        // including its carve-out that if an administrator or accessibility
        // product changed the value AFTER we set it, we leave the value alone
        // and only drop our own marker. Doing it in Rust rather than parsing
        // `reg query` output in a batch script is what lets us compare the
        // value, not merely test the marker's presence.
        //
        // One elevated cmd, so the user answers ONE UAC prompt rather than
        // several. `sc stop` is expected to fail when the service is registered
        // but not running, hence `&` (run regardless) rather than `&&`.
        //
        // Every path/key is a literal from ProgramFiles and frozen constants,
        // never user input or anything off the network.
        let args = format!(
            "/c sc stop \"{name}\" \
             & sc delete \"{name}\" \
             & rmdir /s /q \"{dir}\"{sas}",
            name = SERVICE_NAME,
            dir = dir.display(),
            sas = sas_removal_fragment(),
        );

        let rc = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(HSTRING::from("runas").as_ptr()),
                PCWSTR(HSTRING::from("cmd.exe").as_ptr()),
                PCWSTR(HSTRING::from(args.as_str()).as_ptr()),
                PCWSTR::null(),
                SW_HIDE,
            )
        };
        // ShellExecuteW returns >32 on success. 5 (ERROR_ACCESS_DENIED) is what
        // a declined UAC prompt gives, and that is a normal answer, not a bug —
        // say so plainly instead of surfacing a raw error code.
        let code = rc.0 as isize;
        if code == 5 {
            return Err("Removal needs administrator approval, and the prompt was declined.".into());
        }
        if code <= 32 {
            return Err(format!("Could not start the elevated removal (code {code})."));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("The remote-access service only exists on Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    /// These names are FROZEN. An installed service is found by the name it was
    /// registered under, so if `crates/puca-service` ever changes either of
    /// these, this build stops finding the very thing it exists to remove —
    /// silently, because "not installed" and "installed under another name"
    /// look identical from here. This test is the tripwire; it must be updated
    /// only together with that crate.
    #[test]
    fn frozen_names_match_the_service_crate() {
        assert_eq!(super::SERVICE_NAME, "SovereignRemote");
        assert_eq!(super::SERVICE_DIR_PARENT, "Sovereign");
        assert_eq!(super::SERVICE_DIR_LEAF, "service");
        // Mirrored from crates/puca-service/src/sas.rs — the marker is the
        // guard that keeps us from deleting a policy Puca did not set.
        assert_eq!(
            super::SAS_POLICY_KEY,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System",
        );
        assert_eq!(super::SAS_POLICY_VALUE, "SoftwareSASGeneration");
        assert_eq!(super::SAS_MARKER_KEY, r"SOFTWARE\Sovereign");
        assert_eq!(super::SAS_MARKER_VALUE, "SovereignSetSoftwareSAS");
    }

    /// A machine with nothing installed must report nothing — the banner has to
    /// stay invisible for the overwhelming majority of users, who never had the
    /// service. (On a developer machine that DOES have it, this asserts only the
    /// shape, not the values.)
    #[test]
    fn status_is_queryable_without_elevation() {
        let s = super::rc_leftovers_status();
        // Running state cannot be true unless it is installed.
        assert!(!s.service_running || s.service_installed);
        // secrets live inside the install dir.
        assert!(!s.secrets_present || s.install_dir_present);
    }

    /// THE 0.8.127 REGRESSION PIN. A build that contains remote control must
    /// report NO leftovers and refuse removal, whatever is on the machine —
    /// its service is a managed component, not a stray. This test runs under
    /// the default feature set (remote-control on), and on a machine with the
    /// service actually enrolled (the primary dev box is one) it goes red the
    /// moment the guard is removed — which is exactly how 0.8.127 shipped a
    /// red "Remove it" banner to every enrolled full install. On a machine
    /// without the service it cannot distinguish guard from absence; the
    /// enrolled dev box is the tripwire.
    #[test]
    #[cfg(feature = "remote-control")]
    fn full_build_reports_no_leftovers_and_refuses_removal() {
        let s = super::rc_leftovers_status();
        assert!(!s.service_installed && !s.service_running);
        assert!(!s.install_dir_present && !s.secrets_present);
        assert!(s.install_dir.is_empty());
        assert!(super::rc_leftovers_remove().is_err());
    }
}
