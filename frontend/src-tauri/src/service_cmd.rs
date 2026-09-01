//! Turning lock-screen access on and off — the opt-in, and nothing else.
//!
//! THIS FEATURE IS ABSENT UNTIL SOMEBODY ASKS FOR IT. Installing Puca does
//! not register a service, does not create anything under `%ProgramFiles%`, and
//! does not raise a UAC prompt. A machine has this only because its owner turned
//! it on deliberately and approved an elevation prompt that says what it is for.
//! That is a product requirement, not an implementation detail: a LocalSystem
//! service that arrives with an ordinary app update is exactly the thing people
//! are right to be suspicious of.
//!
//! WHY IT SHELLS OUT INSTEAD OF DOING THE WORK. Registering a service and
//! writing to `%ProgramFiles%` need administrator rights, and the app must stay
//! unelevated — it renders web content and runs a WebView. So the privileged
//! half lives in `puca-service.exe`, which is run once, elevated, via the
//! `runas` verb, and exits. Nothing long-lived is elevated, and the app never
//! holds rights it does not need.
//!
//! WHAT THE USER SEES: one Windows UAC prompt naming Puca, and afterwards a
//! service in `services.msc` they can inspect, stop, or remove — including
//! without this app, with `puca-service.exe deprovision`.

#![cfg(windows)]

use std::path::PathBuf;

/// What the UI needs to draw an honest toggle.
#[derive(serde::Serialize)]
pub struct ServiceState {
    /// Is the service registered at all?
    pub installed: bool,
    /// Is it registered AND currently running?
    pub running: bool,
    /// Can this build even offer the feature? False when the sidecar is missing,
    /// which is what a dev build or a broken install looks like.
    pub available: bool,
    /// Present when something is wrong, so the card can say what rather than
    /// showing a toggle that silently does nothing.
    pub problem: Option<String>,
}

/// The service binary, shipped beside the app exactly as the agent is.
///
/// NOTE THIS LIVES IN A USER-WRITABLE DIRECTORY. The app installs per-user into
/// `%LOCALAPPDATA%`, so anything running as this user can replace this file.
/// See `elevation_source` for why that matters and when we avoid it.
fn service_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join("puca-service.exe");
    candidate.exists().then_some(candidate)
}

/// The installed copy under `%ProgramFiles%`, which only administrators can
/// write. `None` until the service has been provisioned at least once.
fn installed_service_path() -> Option<PathBuf> {
    let dir = std::env::var_os("ProgramFiles").map(PathBuf::from)?;
    let candidate = dir.join("Sovereign").join("service").join("puca-service.exe");
    candidate.exists().then_some(candidate)
}

/// WHICH binary to hand to `runas` — the security-relevant choice on this path.
///
/// THE PROBLEM. The bundled copy sits in `%LOCALAPPDATA%`, which this user can
/// write. Any process already running as the user can replace it and then
/// simply wait: the next time the user accepts a UAC prompt believing they are
/// elevating Puca's helper, the substituted binary runs with full rights and
/// goes on to register a LocalSystem service. That converts "code running as
/// you" into "persistent SYSTEM", riding a consent the user was going to give
/// anyway. No tight race is needed, because the file can be swapped and left.
///
/// It is not a signature problem we can check our way out of: these binaries
/// are deliberately not code-signed (a documented, accepted trade-off — see
/// docs/SECURITY_MODEL.md), so there is nothing to verify against, and an
/// attacker who can swap the service binary can equally swap the app doing the
/// verifying. An integrity check performed by the untrusted side proves
/// nothing.
///
/// WHAT ACTUALLY HELPS. Once the service has been provisioned once, an
/// admin-only copy exists under `%ProgramFiles%`, and `install.rs` already
/// refuses to register a service whose image is not admin-only. Elevating THAT
/// copy for every subsequent operation removes the swap entirely from update,
/// disable and deprovision — which is most of the exposure, since those recur
/// for the life of the install while the first provision happens once.
///
/// The first provision is irreducible without either code-signing or an
/// administrator-run installer: there is no admin-only copy yet, and putting
/// one there is the very thing that needs elevating. That residual is
/// deliberate and documented rather than hidden.
///
/// WHICH COPY IS CORRECT DEPENDS ON THE OPERATION, and getting it wrong is
/// silent. `provision` and `update` work by copying the RUNNING binary into
/// the install directory ("the copy source is always the newest build" —
/// `main.rs`), so elevating the installed copy for those would reinstall the
/// OLD version: an update that reports success and changes nothing. Only
/// operations that purely REMOVE can safely prefer the installed copy.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ElevationSource {
    /// The build shipped with this app. Required wherever the elevated process
    /// installs itself.
    Bundled,
    /// The admin-only installed copy when one exists, else the bundled one.
    /// A same-user attacker cannot swap this.
    PreferInstalled,
}

/// Split out as a pure function so the choice is unit-testable; `run_elevated`
/// itself cannot be, as it raises a real UAC prompt.
fn elevation_source(
    which: ElevationSource,
    installed: Option<PathBuf>,
    bundled: Option<PathBuf>,
) -> Option<PathBuf> {
    match which {
        ElevationSource::Bundled => bundled,
        ElevationSource::PreferInstalled => installed.or(bundled),
    }
}

fn agent_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join("puca-agent.exe");
    candidate.exists().then_some(candidate)
}

/// Run `puca-service.exe <args>` ELEVATED and wait for it to finish.
///
/// `runas` is what raises the UAC prompt. Waiting matters: without it the app
/// would report success the instant the prompt appeared, before the user had
/// decided anything, and the toggle would lie for as long as it took them to
/// read it.
///
/// A cancelled prompt returns ERROR_CANCELLED (1223), which is reported as the
/// user's own choice rather than as a failure — declining a UAC prompt is a
/// valid answer, not an error condition.
fn run_elevated(args: &[&str], which: ElevationSource) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, WAIT_OBJECT_0};
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let exe = elevation_source(which, installed_service_path(), service_path()).ok_or_else(|| {
        "This build does not include the system service component.".to_string()
    })?;
    let params = args
        .iter()
        .map(|a| if a.contains(' ') { format!("\"{a}\"") } else { (*a).to_string() })
        .collect::<Vec<_>>()
        .join(" ");

    let verb = HSTRING::from("runas");
    let file = HSTRING::from(exe.as_os_str());
    let par = HSTRING::from(params.as_str());

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: windows::core::PCWSTR(verb.as_ptr()),
        lpFile: windows::core::PCWSTR(file.as_ptr()),
        lpParameters: windows::core::PCWSTR(par.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };

    unsafe {
        ShellExecuteExW(&mut info).map_err(|e| {
            if e.code().0 as u32 & 0xFFFF == ERROR_CANCELLED.0 {
                "You declined the Windows permission prompt, so nothing was changed.".to_string()
            } else {
                format!("Could not start the elevated helper: {e}")
            }
        })?;

        if info.hProcess.is_invalid() {
            return Err("The elevated helper did not start.".into());
        }
        let wait = windows::Win32::System::Threading::WaitForSingleObject(
            info.hProcess,
            60_000,
        );
        let mut code = 0u32;
        let _ = windows::Win32::System::Threading::GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);

        if wait != WAIT_OBJECT_0 {
            return Err("The elevated helper did not finish in time.".into());
        }
        if code != 0 {
            // The helper prints the real reason to its own stderr, which is
            // hidden here. Rather than invent one, point at the state the UI can
            // re-read: `service_state` will show it is still off.
            return Err(format!(
                "The helper reported an error (exit code {code}). Nothing was changed."
            ));
        }
    }
    Ok(())
}

/// Is lock-screen access turned on for this machine?
#[tauri::command]
pub fn service_state() -> ServiceState {
    let available = service_path().is_some() && agent_path().is_some();
    let (installed, running, problem) = match puca_service::install::status() {
        Ok(Some(state)) => (
            true,
            format!("{state:?}").contains("Running"),
            None,
        ),
        Ok(None) => (false, false, None),
        // Reading service state needs no privilege, so a failure here is a real
        // fault worth showing rather than swallowing into "off".
        Err(e) => (false, false, Some(e)),
    };
    ServiceState {
        installed,
        running,
        available,
        problem: problem.or_else(|| {
            (!available).then(|| {
                "This build does not include the system service component.".to_string()
            })
        }),
    }
}

/// Turn it on. Raises one UAC prompt.
#[tauri::command]
pub fn service_enable() -> Result<(), String> {
    let agent = agent_path()
        .ok_or_else(|| "The agent component is missing from this install.".to_string())?;
    run_elevated(&["provision", &agent.to_string_lossy()], ElevationSource::Bundled)
}

/// Turn it off, removing the service and its binaries.
///
/// KEEPS this machine's enrolment — the device private key, signing seed and
/// arming record under `secrets/` — so that turning the feature back on does
/// not mean enrolling the machine again. The UI now says so in as many words;
/// `service_disable_and_forget` is the version for someone who wants that gone
/// as well.
#[tauri::command]
pub fn service_disable() -> Result<(), String> {
    run_elevated(&["deprovision"], ElevationSource::PreferInstalled)
}

/// Turn it off AND erase this machine's enrolment.
///
/// ONE elevated call rather than a disable followed by a separate forget: two
/// consecutive UAC prompts for what the user experiences as a single decision
/// is how people end up stopping half way through it, which here would mean
/// believing the key is gone when it is not.
#[tauri::command]
pub fn service_disable_and_forget() -> Result<(), String> {
    run_elevated(&["deprovision-forget"], ElevationSource::PreferInstalled)
}

/// Replace the installed service binaries with this build's. One UAC prompt;
/// registration, enrolment and the arming record all survive.
///
/// WHY THIS EXISTS: the app auto-updates, the installed service does not —
/// nothing but `provision`/`update` ever touches it. Without this, every app
/// update leaves the machine running new app + old service, and any
/// control-pipe field the app has grown to rely on silently never arrives
/// (found in the field with 0.8.82's `device_id`: the "one card per PC" merge
/// just never engaged, with nothing anywhere saying why).
#[tauri::command]
pub fn service_update() -> Result<(), String> {
    let agent = agent_path()
        .ok_or_else(|| "The agent component is missing from this install.".to_string())?;
    run_elevated(&["update", &agent.to_string_lossy()], ElevationSource::Bundled)
}

/// Fingerprint of the service+agent pair BUNDLED with this app — the "what I
/// ship" half of the update check. The "what is installed" half arrives from
/// the running service itself (`lock_screen_state().bins_hash`); comparing the
/// two is the UI's job.
///
/// TWO DIFFERENT KINDS OF "NOTHING TO REPORT", kept apart on purpose:
///   - `Ok(None)` — this build genuinely has no sidecars (a dev build). Normal,
///     silent, no update can be offered anyway.
///   - `Err(reason)` — the sidecars are SUPPOSED to be there (a real install)
///     but reading or hashing them failed. This must not collapse into the
///     same silent `None` the first case gets: on a shipped build this is a
///     real problem, and "the update card never says why it never appears" is
///     the exact failure this function exists to end. `unwrap_err_or(None)`
///     via `.ok()` was tried first and rejected for precisely that reason — it
///     is indistinguishable from the dev-build case from the caller's side.
#[tauri::command]
pub fn service_bundled_fingerprint() -> Result<Option<String>, String> {
    let Some(service) = service_path() else { return Ok(None) };
    let Some(agent) = agent_path() else { return Ok(None) };
    puca_service::install::pair_fingerprint(&service, &agent).map(Some)
}

#[cfg(test)]
mod elevation_source_tests {
    use super::{elevation_source, ElevationSource};
    use std::path::PathBuf;

    fn installed() -> Option<PathBuf> {
        Some(PathBuf::from(r"C:\Program Files\Sovereign\service\puca-service.exe"))
    }
    fn bundled() -> Option<PathBuf> {
        Some(PathBuf::from(r"C:\Users\someone\AppData\Local\Puca\puca-service.exe"))
    }

    /// The security half: an operation that only REMOVES prefers the admin-only
    /// copy, so a same-user attacker who swapped the bundled binary cannot have
    /// it elevated.
    #[test]
    fn removal_operations_elevate_the_admin_only_copy() {
        assert_eq!(
            elevation_source(ElevationSource::PreferInstalled, installed(), bundled()),
            installed(),
        );
    }

    /// The correctness half, and the reason this is an enum rather than a bool
    /// defaulting to "safest". `provision` and `update` copy the RUNNING binary
    /// into the install directory, so elevating the installed copy would
    /// reinstall the OLD build — an update that reports success and changes
    /// nothing, which is invisible until someone wonders why a fixed service
    /// bug persists. Pinned so that "harden it further" cannot quietly become
    /// "break updates".
    #[test]
    fn self_installing_operations_must_elevate_the_bundled_build() {
        assert_eq!(
            elevation_source(ElevationSource::Bundled, installed(), bundled()),
            bundled(),
            "update/provision must run the NEW binary, never the installed one",
        );
    }

    /// First provision: no admin-only copy exists yet, so the bundled one is
    /// all there is. This residual is the documented, irreducible part.
    #[test]
    fn falls_back_to_bundled_before_the_first_provision() {
        assert_eq!(
            elevation_source(ElevationSource::PreferInstalled, None, bundled()),
            bundled(),
        );
    }

    /// A build with no service component at all (Lite, or a broken install)
    /// must yield nothing rather than a path that does not exist.
    #[test]
    fn no_service_component_yields_nothing() {
        assert_eq!(elevation_source(ElevationSource::PreferInstalled, None, None), None);
        assert_eq!(elevation_source(ElevationSource::Bundled, installed(), None), None);
    }
}
