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
fn service_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join("puca-service.exe");
    candidate.exists().then_some(candidate)
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
fn run_elevated(args: &[&str]) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, WAIT_OBJECT_0};
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let exe = service_path().ok_or_else(|| {
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
    run_elevated(&["provision", &agent.to_string_lossy()])
}

/// Turn it off, removing the service and its files.
#[tauri::command]
pub fn service_disable() -> Result<(), String> {
    run_elevated(&["deprovision"])
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
    run_elevated(&["update", &agent.to_string_lossy()])
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
