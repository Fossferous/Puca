//! Install / uninstall the service. The only code here that CHANGES the machine.
//!
//! Registering a SYSTEM auto-start service needs administrator rights, so this
//! is never run by the everyday app — the plan's "Enable unattended access"
//! button shells out to an elevated `puca-service.exe install`, which keeps
//! the default install non-admin and makes SYSTEM opt-in per machine.
//!
//! Built on the windows-service `ServiceManager` rather than raw
//! `CreateServiceW`/`DeleteService`, for the same reason as the service binary:
//! the SCM handle lifecycle is easy to leak or misorder and there is nothing to
//! unit-test until it actually runs elevated.
//!
//! HONEST BOUNDARY: `install` registers and starts a real SYSTEM service. It is
//! the checkpoint step — nothing above it in the crate touches the machine.

use std::ffi::OsString;
use std::path::Path;
use std::time::{Duration, Instant};

use windows_service::service::{
    ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState, ServiceType,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use crate::{SERVICE_DISPLAY_NAME, SERVICE_NAME};

fn manager(access: ServiceManagerAccess) -> Result<ServiceManager, String> {
    ServiceManager::local_computer(None::<&str>, access)
        .map_err(|e| format!("cannot open the Service Control Manager (are you elevated?): {e}"))
}

/// Register the service as LocalSystem auto-start and start it.
///
/// `exe` is the absolute path to this service binary as it will live after
/// install — the SCM records it verbatim, so it must be the FINAL location, not
/// a build-tree path that could be cleaned away.
pub fn install(exe: &Path) -> Result<(), String> {
    if !exe.is_absolute() {
        return Err(format!("service path must be absolute, got {}", exe.display()));
    }

    // VERIFIED HERE, INDEPENDENTLY, whatever the caller believes it did.
    //
    // The SCM stores this path verbatim and launches whatever is at it as
    // LocalSystem on every boot. If an unprivileged user can replace that file,
    // or any directory on the way to it, then this function is the privilege
    // escalation — a persistent one that survives reboots and looks entirely
    // legitimate in every tool that lists services.
    //
    // This check does not trust the install flow to have prepared the directory
    // correctly, because the whole point of a boundary is that it holds when the
    // code above it is wrong. It previously checked only `is_absolute()`, which
    // is a statement about the string and not about who can write to it.
    crate::path_guard::path_is_admin_only(exe).map_err(|e| {
        format!(
            "refusing to register a SYSTEM service at an unsafe path: {e}\n\
             The service binary and every directory above it must be writable only by \
             SYSTEM, Administrators or TrustedInstaller."
        )
    })?;

    let manager = manager(ServiceManagerAccess::CREATE_SERVICE)?;

    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        // Auto-start: unattended access must survive a reboot, which is the whole
        // point — a manual-start service would not be there after the machine
        // you want to reach restarts.
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe.to_path_buf(),
        // SCM launches it with no extra args, so the binary falls through to the
        // service-dispatcher path (see main.rs).
        launch_arguments: vec![],
        dependencies: vec![],
        // None => LocalSystem. This is the privileged part; it is what lets the
        // agent reach the secure desktop, and what makes arming a deliberate,
        // admin-gated act.
        account_name: None,
        account_password: None,
    };

    let service = manager
        .create_service(&info, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START)
        .map_err(|e| format!("CreateService failed: {e}"))?;

    // Best-effort description; a failure here does not undo a good install.
    let _ = service.set_description(
        "Keeps a Puca agent available for unattended remote access. Runs as SYSTEM. \
         Remove with `puca-service uninstall`.",
    );

    service
        .start::<OsString>(&[])
        .map_err(|e| format!("service created but StartService failed: {e}"))?;
    Ok(())
}

/// Stop (if running) and delete the service. Idempotent enough to be safe to run
/// when the service is already gone.
pub fn uninstall() -> Result<(), String> {
    // BEFORE the SCM work, and unconditionally — including when the service is
    // already gone. Turning this feature off must leave nothing behind, and a
    // machine policy left set is the most invisible kind of leftover: nothing
    // in services.msc or Programs and Features mentions it.
    //
    // It only removes a value THIS code wrote, which the marker records. An
    // administrator, a kiosk image or an accessibility product may have set the
    // same policy for their own reasons, and deleting theirs on the way out
    // would break something else silently — the exact failure mode this whole
    // change exists to stop producing.
    crate::log::line(&format!("[sas] {}", crate::sas::remove_policy_if_ours()));

    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let service = match manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) {
        Ok(s) => s,
        // Not installed is a SUCCESS for uninstall — the desired end state holds.
        Err(_) => return Ok(()),
    };

    // Stop first if it is running; deleting a running service only marks it for
    // deletion on next stop, which surprises a user expecting it gone now.
    if let Ok(status) = service.query_status() {
        if status.current_state != ServiceState::Stopped {
            let _ = service.stop();
            // Give it a moment to actually stop before deleting.
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                match service.query_status() {
                    Ok(s) if s.current_state == ServiceState::Stopped => break,
                    _ => std::thread::sleep(Duration::from_millis(200)),
                }
            }
        }
    }

    service.delete().map_err(|e| format!("DeleteService failed: {e}"))?;
    Ok(())
}

/// Stop the service and wait for it to actually reach Stopped.
///
/// Split out of `uninstall` because updating the binaries needs exactly this
/// half: the files cannot be copied over while the SCM holds them open, and
/// "stop, replace, start" must not deregister anything.
pub fn stop() -> Result<(), String> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP)
        .map_err(|e| format!("the service is not installed: {e}"))?;

    if let Ok(status) = service.query_status() {
        if status.current_state == ServiceState::Stopped {
            return Ok(());
        }
    }
    let _ = service.stop();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        match service.query_status() {
            Ok(s) if s.current_state == ServiceState::Stopped => return Ok(()),
            _ => std::thread::sleep(Duration::from_millis(200)),
        }
    }
    Err("the service did not stop within 10 seconds".into())
}

/// Start the already-registered service.
pub fn start() -> Result<(), String> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::START)
        .map_err(|e| format!("the service is not installed: {e}"))?;
    service
        .start::<OsString>(&[])
        .map_err(|e| format!("StartService failed: {e}"))
}

/// One fingerprint over the service+agent pair, in that fixed order.
///
/// A single opaque value rather than two fields because the question the app
/// asks is singular — "is what is installed the same as what I ship?" — and
/// the two binaries only ever ship together.
///
/// Public because BOTH ends of the update check need the same digest: the
/// running service fingerprints its installed pair, and the app fingerprints
/// the pair it bundles. Two implementations would eventually disagree about
/// exactly the bytes being hashed, and a disagreement here does not fail — it
/// shows a permanent "update available" or a permanent "up to date".
pub fn pair_fingerprint(service_exe: &Path, agent_exe: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for p in [service_exe, agent_exe] {
        let bytes = std::fs::read(p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
        h.update(&bytes);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// The service's current state, or `None` if it is not installed.
pub fn status() -> Result<Option<ServiceState>, String> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    match manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
        Ok(service) => {
            let s = service.query_status().map_err(|e| format!("QueryServiceStatus failed: {e}"))?;
            Ok(Some(s.current_state))
        }
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn an_unsafe_path_is_refused_before_the_scm_is_touched() {
        // Ordering is the whole point of this test, not just the refusal.
        //
        // `manager()` fails without elevation, so if the path check ran second
        // an unsafe path would come back as "cannot open the Service Control
        // Manager (are you elevated?)" — a message that reads like an
        // environment problem and would send someone off to re-run the install
        // as administrator, at which point the guard is the only thing left and
        // it had better be in front. Asserting on WHICH error comes back is
        // what pins the order.
        //
        // This runs unelevated in CI and must stay that way: a test that needs
        // administrator rights is a test that gets skipped.
        let exe = std::env::temp_dir().join("sovereign-install-order-test.exe");
        std::fs::write(&exe, b"not a real binary").expect("write the decoy");
        let err = install(&exe).expect_err("a user-writable path must not be registered");
        let _ = std::fs::remove_file(&exe);
        assert!(
            err.contains("unsafe path"),
            "the path guard must run before the SCM is opened; got: {err}"
        );
    }

    #[test]
    fn a_relative_path_is_refused() {
        let err = install(Path::new("puca-service.exe"))
            .expect_err("a relative path must be refused");
        assert!(err.contains("absolute"), "{err}");
    }
}
