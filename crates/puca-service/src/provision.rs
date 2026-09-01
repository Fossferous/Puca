//! Put the binaries somewhere a SYSTEM service may safely be pointed at.
//!
//! WHY THIS EXISTS RATHER THAN "just copy the files". `install()` refuses any
//! path a non-administrator can write, and it is right to: the SCM stores that
//! path and launches it as LocalSystem on every boot, so a user-writable
//! ImagePath makes registering the service a permanent privilege escalation.
//! Every location this app already occupies — its own build tree, `%LOCALAPPDATA%`,
//! `%ProgramData%` — fails that test. Somewhere new has to be made, correctly,
//! before there is anything safe to install.
//!
//! THE DACL IS PROTECTED, which is the load-bearing word. Without
//! `PROTECTED_DACL_SECURITY_INFORMATION` the directory keeps inheriting from its
//! parent, and `%ProgramFiles%` carries an inheritable `CREATE OWNER: full
//! control`. A directory created under it therefore grants full control to
//! whoever created it — and if that is ever anything but an administrator, the
//! guard downstream refuses and the install fails with a confusing message about
//! ACLs. Protecting the DACL severs that inheritance and states the permissions
//! outright.
//!
//! IT RE-APPLIES ON EVERY RUN, including when the directory already exists. A
//! pre-created directory is the exact shape of the `%ProgramData%` bug this
//! project already shipped once: an attacker who makes the folder first owns it,
//! and a "create if missing" step then walks straight past the problem.

#![cfg(windows)]

use std::path::{Path, PathBuf};

/// `SYSTEM` and `Administrators` get full control; `Users` may read and execute
/// and nothing else.
///
/// `D:P` is the protected marker. `OICI` propagates to files and subdirectories
/// so the copied binaries inherit exactly this and not something wider.
/// `0x1200a9` is `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE` — enough to run the
/// service and read its files, and specifically NOT enough to replace them,
/// which is the whole point.
const INSTALL_DIR_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)";

/// Where the service and agent live once installed.
pub fn install_dir() -> Result<PathBuf, String> {
    crate::path_guard::install_dir()
}

/// Create or repair `dir` with the install DACL.
pub fn secure_directory(dir: &Path) -> Result<(), String> {
    apply_sddl(dir, INSTALL_DIR_SDDL)
}

/// Create or repair `dir` with an explicit SDDL.
///
/// Generalised so the secrets directory can reuse the same protected-DACL
/// mechanism with a STRICTER trustee list, rather than growing a second
/// implementation of SetNamedSecurityInfoW that could drift from this one.
pub fn apply_sddl(dir: &Path, sddl: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    };

    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

    let mut sd = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &HSTRING::from(sddl),
            SDDL_REVISION_1,
            &mut sd,
            None,
        )
        .map_err(|e| format!("the install DACL is malformed: {e}"))?;
    }
    // Freed on every path out, including the errors below.
    struct Local(PSECURITY_DESCRIPTOR);
    impl Drop for Local {
        fn drop(&mut self) {
            use windows::Win32::Foundation::{HLOCAL, LocalFree};
            if !self.0 .0.is_null() {
                unsafe {
                    let _ = LocalFree(HLOCAL(self.0 .0));
                }
            }
        }
    }
    let _owned = Local(sd);

    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut present = windows::Win32::Foundation::BOOL(0);
    let mut defaulted = windows::Win32::Foundation::BOOL(0);
    unsafe {
        GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted)
            .map_err(|e| format!("cannot read the install DACL: {e}"))?;
    }
    if !present.as_bool() || dacl.is_null() {
        return Err("the install DACL came back empty".into());
    }

    let wide: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let rc = unsafe {
        SetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            // PROTECTED is what severs inheritance from %ProgramFiles%, whose
            // inheritable CREATOR OWNER entry would otherwise grant the creator
            // full control over the very binaries this is protecting.
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(dacl),
            None,
        )
    };
    if rc != windows::Win32::Foundation::ERROR_SUCCESS {
        return Err(format!(
            "cannot set permissions on {} (error {}). Administrator rights are required.",
            dir.display(),
            rc.0
        ));
    }
    Ok(())
}

use std::os::windows::ffi::OsStrExt;

/// Copy the service and agent into a protected directory and register the
/// service from there.
///
/// Ordered so that nothing is ever registered from a path that has not already
/// been proven safe: secure the directory, copy in, verify with the same guard
/// `install()` uses, then install. Verifying AFTER the copy rather than before
/// is deliberate — the copy is what creates the files whose permissions matter.
pub fn provision_and_install(service_exe: &Path, agent_exe: &Path) -> Result<PathBuf, String> {
    let dir = install_dir()?;
    secure_directory(&dir)?;

    let dest_service = dir.join(crate::INSTALLED_SERVICE_EXE);
    let dest_agent = dir.join(crate::INSTALLED_AGENT_EXE);

    // The service launches the agent FROM ITS OWN DIRECTORY, so the
    // agent has to be beside it and under the same protection. Copying it
    // anywhere else, or leaving it out, gives a service that starts and then
    // cannot launch anything.
    std::fs::copy(service_exe, &dest_service)
        .map_err(|e| format!("cannot copy the service to {}: {e}", dest_service.display()))?;
    std::fs::copy(agent_exe, &dest_agent)
        .map_err(|e| format!("cannot copy the agent to {}: {e}", dest_agent.display()))?;

    // The same check `install()` will make, run here so a failure names the
    // provisioning step rather than surfacing as a mysterious refusal later.
    crate::path_guard::path_is_admin_only(&dest_service)?;
    crate::path_guard::path_is_admin_only(&dest_agent)?;

    crate::install::install(&dest_service)?;
    Ok(dest_service)
}

/// Replace the installed binaries with new ones, keeping the registration.
///
/// WHY THIS EXISTS. The app auto-updates itself, but nothing updated the
/// RUNNING service: it is only touched by `provision`, and `provision` cannot
/// run over a live install (`CreateService` refuses an existing name, and the
/// copy hits files the SCM holds open). So every app update left the machine
/// running new app + old service, and any new control-pipe field the app
/// depended on simply never arrived — found in the field when the 0.8.82
/// `device_id` field silently never appeared and one PC kept listing as two
/// devices. Stop, replace, start: registration, enrolment and arming all stay.
///
/// One elevated invocation, so the user sees ONE consent prompt, not the two
/// that a disable/enable cycle would cost.
pub fn update_binaries(service_exe: &Path, agent_exe: &Path) -> Result<String, String> {
    if crate::install::status()?.is_none() {
        return Err("the service is not installed — use provision instead".into());
    }

    crate::install::stop()?;

    let dir = install_dir()?;
    // Re-applied on every update for the same reason provisioning re-applies
    // it on every run: a directory whose ACL has drifted must be repaired, not
    // trusted.
    secure_directory(&dir)?;

    let dest_service = dir.join(crate::INSTALLED_SERVICE_EXE);
    let dest_agent = dir.join(crate::INSTALLED_AGENT_EXE);
    std::fs::copy(service_exe, &dest_service)
        .map_err(|e| format!("cannot copy the service to {}: {e}", dest_service.display()))?;
    std::fs::copy(agent_exe, &dest_agent)
        .map_err(|e| format!("cannot copy the agent to {}: {e}", dest_agent.display()))?;

    crate::path_guard::path_is_admin_only(&dest_service)?;
    crate::path_guard::path_is_admin_only(&dest_agent)?;

    crate::install::start()?;
    Ok(format!("updated the service binaries at {}", dir.display()))
}

/// Remove the service and the binaries provisioning put on the machine.
///
/// LEAVES `secrets/` ALONE, and that is the point of this function existing
/// separately from `enrol::forget`. This used to `remove_dir_all` the whole
/// install directory, which is also where enrolment and arming live —
/// device keys, the passphrase record, the link config — so toggling the
/// service off and back on to pick up an update silently forgot the
/// machine's identity, its connection to the account, and its passphrase in
/// one shot. That was found the hard way: three off/on cycles, three
/// re-enrolments, before the pattern was obvious.
///
/// "Forget this machine's identity" and "this machine's service program is
/// not installed" are different questions and must stay answerable
/// independently — the same reasoning `arming.rs` already applies between
/// enrolling and arming. `enrol::forget` is the tool for the first
/// question; this is only ever the second.
///
/// Best-effort on the files: the service must be gone first, and if a file is
/// locked by a process that has not exited yet, having removed the service is
/// still the outcome that matters. Reporting a partial success honestly beats
/// refusing to uninstall because a log file was busy.
pub fn deprovision() -> Result<String, String> {
    crate::install::uninstall()?;
    purge_except_secrets(&install_dir()?)
}

/// Deprovision AND erase this machine's enrolment — the device private key,
/// the signing seed, the link config and the arming record, all of which live
/// under `secrets/` and which `deprovision` deliberately preserves.
///
/// WHY THIS HAS TO EXIST. Preserving `secrets/` across a routine off/on is
/// correct and hard-won (see `purge_except_secrets`: the all-or-nothing purge
/// that used to be here forgot the machine's identity three times before the
/// pattern was spotted). But `enrol::forget` — the documented tool for "forget
/// this machine's identity" — was reachable from NOWHERE: not this crate's
/// CLI, not the app. So the only honest answer to "how do I remove the key
/// this machine holds?" was to delete a folder under Program Files by hand,
/// as an administrator, which is not an answer. The switch keeps enrolment,
/// the UI now says so, and this is the explicit way to decline that.
///
pub fn deprovision_and_forget() -> Result<String, String> {
    crate::install::uninstall()?;
    purge_including_secrets(&install_dir()?)
}

/// `purge_except_secrets`, and then `secrets/` as well.
///
/// SEPARATED FROM `deprovision_and_forget` for exactly the reason its sibling
/// is separated from `deprovision`: the SCM call cannot run in a unit test, and
/// the untested version of that pair is the one that wiped enrolment by
/// accident. This half is the half that destroys data, so it is the half that
/// has to be testable against a throwaway directory.
///
/// Removes the DIRECTORY rather than the filenames `enrol::forget` knows about.
/// Naming files would mean a secret added to `secrets/` later silently
/// surviving a call whose entire purpose is that nothing does.
fn purge_including_secrets(dir: &std::path::Path) -> Result<String, String> {
    let base = purge_except_secrets(dir)?;
    let secrets = dir.join("secrets");
    if !secrets.exists() {
        return Ok(format!("{base}; there was no enrolment stored"));
    }
    // Best-effort, and reported as success either way: the service and the
    // binaries are already gone by this point, so failing the whole operation
    // would send the caller back through an elevation prompt while leaving
    // them no better off. Say plainly what is left instead.
    match std::fs::remove_dir_all(&secrets) {
        Ok(()) => Ok(format!("{base}; erased this machine's enrolment")),
        Err(e) => Ok(format!(
            "{base}; but this machine's enrolment could NOT be removed from {} \
             ({e}). Delete that folder by hand to finish.",
            secrets.display()
        )),
    }
}

/// Remove everything directly inside `dir` except a `secrets` subdirectory.
///
/// SEPARATED FROM `deprovision` so it is testable against a real, throwaway
/// directory without going through the SCM — `deprovision`'s own
/// `install::uninstall()` call needs a real registered service and cannot run
/// in a unit test, which is exactly why the original all-or-nothing
/// `remove_dir_all` version of this went untested and then wiped enrolment.
fn purge_except_secrets(dir: &std::path::Path) -> Result<String, String> {
    let secrets = dir.join("secrets");

    let mut removed_count = 0usize;
    let mut first_error: Option<String> = None;
    let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path == secrets {
            continue;
        }
        let result = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        match result {
            Ok(()) => removed_count += 1,
            Err(e) if first_error.is_none() => {
                first_error = Some(format!("{}: {e}", path.display()));
            }
            Err(_) => {}
        }
    }

    match first_error {
        None => Ok(format!(
            "removed the service and {removed_count} file(s) from {} (kept secrets/)",
            dir.display()
        )),
        Some(e) => Ok(format!(
            "removed the service and {removed_count} file(s); one could not be deleted \
             ({e}) and can be removed by hand"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_install_dacl_is_protected_and_gives_users_no_write() {
        // Read as a STRING first, because the shape of this one line decides
        // whether the whole feature is a privilege escalation.
        assert!(INSTALL_DIR_SDDL.starts_with("D:P"), "must sever inheritance");
        assert!(INSTALL_DIR_SDDL.contains("(A;OICI;FA;;;SY)"), "SYSTEM full");
        assert!(INSTALL_DIR_SDDL.contains("(A;OICI;FA;;;BA)"), "Administrators full");
        // Users get read+execute ONLY. FA (full) or FW (write) for BU here would
        // hand every account on the machine the ability to replace a binary that
        // LocalSystem runs at boot.
        assert!(INSTALL_DIR_SDDL.contains("(A;OICI;0x1200a9;;;BU)"), "Users read+execute");
        assert!(!INSTALL_DIR_SDDL.contains("FA;;;BU"), "Users must never get full control");
        assert!(!INSTALL_DIR_SDDL.contains(";;;WD)"), "Everyone must never appear");
        assert!(!INSTALL_DIR_SDDL.contains(";;;AU)"), "Authenticated Users is too broad");
        assert!(!INSTALL_DIR_SDDL.contains(";;;CO)"), "CREATOR OWNER is the bug this avoids");
    }

    #[test]
    fn windows_accepts_the_install_dacl() {
        // A malformed SDDL fails when Windows parses it — inside an elevated
        // install, on someone else's machine. Parse it here instead.
        use windows::core::HSTRING;
        use windows::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        use windows::Win32::Security::PSECURITY_DESCRIPTOR;
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &HSTRING::from(INSTALL_DIR_SDDL),
                SDDL_REVISION_1,
                &mut sd,
                None,
            )
        };
        assert!(ok.is_ok(), "Windows rejected the install DACL: {ok:?}");
        if !sd.0.is_null() {
            unsafe {
                let _ = windows::Win32::Foundation::LocalFree(
                    windows::Win32::Foundation::HLOCAL(sd.0),
                );
            }
        }
    }

    #[test]
    fn the_agent_lands_beside_the_service() {
        // The service resolves the agent relative to its own
        // directory and nowhere else. If these two ever diverge the service
        // installs cleanly and then cannot launch anything, which presents as
        // "the feature does nothing" rather than as an install error.
        let dir = install_dir().expect("ProgramFiles");
        assert_eq!(
            dir.join(crate::INSTALLED_SERVICE_EXE).parent(),
            dir.join(crate::INSTALLED_AGENT_EXE).parent()
        );
    }

    /// A scratch directory under the real temp dir, shaped like a real install
    /// directory: two "binaries" and a "secrets" subdirectory with a file in it.
    /// Torn down on drop so a failed assertion cannot leave one behind to
    /// confuse the next run.
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("sovereign-provision-test-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("secrets")).expect("scratch dir");
            std::fs::write(dir.join(crate::INSTALLED_SERVICE_EXE), b"binary").expect("write");
            std::fs::write(dir.join(crate::INSTALLED_AGENT_EXE), b"binary").expect("write");
            std::fs::write(dir.join("secrets").join("link.json"), b"config").expect("write");
            std::fs::write(dir.join("secrets").join("device.key"), b"key").expect("write");
            Self(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn deprovisioning_removes_binaries_but_keeps_secrets() {
        // THE BUG THAT COST THREE RE-ENROLMENTS. deprovision() used to
        // `remove_dir_all` the whole install directory, and enrolment's device
        // keys, the arming passphrase record, and the link config all lived
        // one level inside it — so toggling the service off to pick up an
        // updated binary silently forgot the machine's identity, its
        // connection to the account, and its passphrase, every single time.
        let scratch = Scratch::new("keeps-secrets");

        assert!(scratch.0.join(crate::INSTALLED_SERVICE_EXE).exists());
        assert!(scratch.0.join("secrets/link.json").exists());
        assert!(scratch.0.join("secrets/device.key").exists());

        let result = purge_except_secrets(&scratch.0).expect("purge");
        assert!(result.contains("kept secrets/"), "{result}");

        // The binaries are gone...
        assert!(!scratch.0.join(crate::INSTALLED_SERVICE_EXE).exists());
        assert!(!scratch.0.join(crate::INSTALLED_AGENT_EXE).exists());
        // ...and secrets/ and everything inside it survived untouched.
        assert!(scratch.0.join("secrets").exists());
        assert!(scratch.0.join("secrets/link.json").exists());
        assert!(scratch.0.join("secrets/device.key").exists());
    }

    #[test]
    fn forgetting_this_machine_takes_the_secrets_too() {
        // The other half of the pair, and the one that destroys data. Its
        // sibling above is its POSITIVE CONTROL: both run the same fixture,
        // and that one asserts the secrets SURVIVE. If this rig could not tell
        // the two apart — a fixture that never wrote secrets, say — that test
        // would fail rather than let this one pass for the wrong reason.
        let scratch = Scratch::new("forget-secrets");

        assert!(scratch.0.join("secrets/device.key").exists());

        let result = purge_including_secrets(&scratch.0).expect("purge");
        assert!(result.contains("erased this machine's enrolment"), "{result}");

        assert!(!scratch.0.join(crate::INSTALLED_SERVICE_EXE).exists());
        // The whole directory, not merely the files enrol::forget names: a
        // secret added to secrets/ later must not outlive this call.
        assert!(!scratch.0.join("secrets").exists(), "secrets/ survived a forget");
        assert!(!scratch.0.join("secrets/device.key").exists());
        assert!(!scratch.0.join("secrets/link.json").exists());
    }

    #[test]
    fn forgetting_says_so_plainly_when_there_was_no_enrolment() {
        // Turning the feature off, then choosing "erase" afterwards, is the
        // exact sequence the UI now offers — and by then secrets/ may already
        // be absent. That must read as a completed request, not an error, or
        // the user is left unsure whether the key is gone.
        let scratch = Scratch::new("forget-nothing");
        std::fs::remove_dir_all(scratch.0.join("secrets")).expect("clear secrets");

        let result = purge_including_secrets(&scratch.0).expect("purge");
        assert!(result.contains("there was no enrolment stored"), "{result}");
    }

    #[test]
    fn a_second_deprovision_on_an_already_clean_directory_still_keeps_secrets() {
        // Idempotency: toggling off twice in a row (or off, on, off) must not
        // eventually reach the secrets directory once the binaries are already
        // gone — there is nothing in the walk that special-cases "only on the
        // first pass".
        let scratch = Scratch::new("idempotent");
        purge_except_secrets(&scratch.0).expect("first purge");
        let second = purge_except_secrets(&scratch.0).expect("second purge");
        assert!(second.contains("kept secrets/"), "{second}");
        assert!(scratch.0.join("secrets/link.json").exists());
    }
}
