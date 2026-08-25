//! Prove a path cannot be written by anyone but an administrator.
//!
//! WHY THIS EXISTS. The SCM stores a service's `ImagePath` verbatim and launches
//! whatever is at that path as LocalSystem, forever, from boot. If an
//! unprivileged user can replace that file — or replace any directory on the
//! way to it — then registering the service *is* the privilege escalation, and
//! it is a persistent one that survives reboots and looks entirely legitimate
//! in every tool that lists services.
//!
//! This is not hypothetical for this project. `%ProgramData%\Puca`, which
//! the deleted `handoff.rs` used and described in its own comment as
//! "SYSTEM-writable", actually grants `BUILTIN\Users:(WD,AD,WEA,WA)` and
//! `CREATOR OWNER:(F)` on this machine. Both candidate install locations were
//! checked and both were user-writable. The install path is therefore not
//! something to assume; it is something to verify, at install time, against the
//! ACL the OS will actually enforce.
//!
//! POSITIVE, NOT A DENYLIST. Every write-granting ACE must name a trustee from
//! a fixed allowed set. An unrecognised trustee is a refusal, an unrecognised
//! ACE type is a refusal, and an unreadable ACL is a refusal. The alternative —
//! looking for known-bad SIDs — cannot be complete, and this codebase already
//! has a scar from reaching for a prefix compare instead of an enumeration.
//!
//! SIDS ARE COMPARED AS SIDS. Never as strings. `CreateWellKnownSid` builds the
//! machine's actual SYSTEM and Administrators SIDs and `EqualSid` compares them;
//! string comparison invites a locale, a case, or a "starts with" bug into the
//! one decision that must not have one.

use std::path::{Path, PathBuf};

/// What an unprivileged trustee must not hold on the target itself.
///
/// Deliberately broad. `FILE_WRITE_DATA`/`FILE_APPEND_DATA` are the obvious
/// ones, but `WRITE_DAC` and `WRITE_OWNER` are worse: they do not modify the
/// file, they let the holder GRANT themselves everything else and then do it.
/// `DELETE` matters because replacing a binary is delete-then-create, and
/// `FILE_WRITE_ATTRIBUTES`/`FILE_WRITE_EA` are included because a check that
/// enumerates most of the write bits reads as complete while not being.
#[cfg(windows)]
const WRITE_RIGHTS: u32 = 0x0002      // FILE_WRITE_DATA / FILE_ADD_FILE
    | 0x0004                          // FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY
    | 0x0010                          // FILE_WRITE_EA
    | 0x0100                          // FILE_WRITE_ATTRIBUTES
    | 0x0040                          // FILE_DELETE_CHILD
    | 0x0001_0000                     // DELETE
    | 0x0004_0000                     // WRITE_DAC
    | 0x0008_0000                     // WRITE_OWNER
    | 0x1000_0000                     // GENERIC_ALL
    | 0x4000_0000; // GENERIC_WRITE

/// What an unprivileged trustee must not hold on an ANCESTOR directory.
///
/// Narrower than [`WRITE_RIGHTS`], and the difference is what makes this check
/// usable rather than merely strict. A default Windows `C:\` grants
/// `BUILTIN\Users` `FILE_ADD_SUBDIRECTORY` and carries an inherit-only
/// `CREATOR OWNER:(F)` — that is how `C:\some-new-folder` comes out
/// user-writable, and it is present on every Windows install in the world.
/// Demanding the full write set on every ancestor would refuse
/// `C:\Program Files\...` on a perfectly healthy machine, and a gate nobody can
/// pass is a gate nobody reads.
///
/// Being able to CREATE a sibling next to `Program Files` does not let you touch
/// `Program Files`. What does is the power to delete it, re-permission it, or
/// take it: those, and only those, are checked on the way up.
#[cfg(windows)]
const ANCESTOR_RIGHTS: u32 = 0x0040   // FILE_DELETE_CHILD
    | 0x0001_0000                     // DELETE
    | 0x0004_0000                     // WRITE_DAC
    | 0x0008_0000                     // WRITE_OWNER
    | 0x1000_0000; // GENERIC_ALL

/// `NT SERVICE\TrustedInstaller` — owns much of `%ProgramFiles%` on a modern
/// Windows and is a system component, not a user.
#[cfg(windows)]
const TRUSTED_INSTALLER: &str =
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

/// Verify that `path`, and every directory above it, can only be written by
/// SYSTEM, Administrators or TrustedInstaller.
///
/// Returns the offending path and SID in the error, because "the install path
/// is not safe" with no way to find out why is a message that gets worked
/// around rather than fixed.
#[cfg(windows)]
pub fn path_is_admin_only(path: &Path) -> Result<(), String> {
    // The target itself under the strict mask, then every ancestor under the
    // narrow one.
    check_one(path, WRITE_RIGHTS, false)?;
    ancestors_are_admin_only(path)
}

/// Verify only the directories ABOVE `path`, which need not exist yet.
///
/// Split out because the install has to ask this question before it creates
/// anything: there is no point building a correctly-permissioned directory
/// inside a parent that an unprivileged user can delete and replace, and by the
/// time the directory exists the answer has already stopped mattering.
///
/// It is also the only half that can be tested without administrator rights,
/// and it is the half that covers the real install path — see this module's
/// tests.
#[cfg(windows)]
pub fn ancestors_are_admin_only(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{} is not an absolute path", path.display()));
    }
    let mut cursor: Option<&Path> = path.parent();
    while let Some(dir) = cursor {
        check_one(dir, ANCESTOR_RIGHTS, true)?;
        cursor = dir.parent();
    }
    Ok(())
}

#[cfg(windows)]
fn check_one(path: &Path, mask: u32, is_ancestor: bool) -> Result<(), String> {
    if !exists(path)? {
        if !is_ancestor {
            return Err(format!("{} does not exist", path.display()));
        }
        // A directory that is not there yet cannot be attacked, and this one is
        // about to be created by the install. Skipping it is safe for a
        // specific reason rather than a general one: the walk continues upward
        // and the first ancestor that DOES exist must still pass, so the parent
        // this missing directory will be created inside has been proven
        // unwritable by anyone unprivileged. That is also what closes the
        // window between the check and the creation — an attacker cannot race
        // us to `C:\Program Files\Puca` without write access to
        // `C:\Program Files`, which we have just established they do not have.
        return Ok(());
    }
    if is_reparse_point(path)? {
        // A lexical check alone already let a directory junction escape a jail
        // in this codebase. Here the answer is simpler than resolving it: a
        // component of a system install path has no business being a link, so
        // refuse rather than follow.
        return Err(format!(
            "{} is a reparse point (junction or symlink); an install path must not contain one",
            path.display()
        ));
    }
    let sd = SecurityDescriptor::read(path)?;
    sd.owner_is_admin(path)?;
    sd.no_unprivileged_writer(path, mask, is_ancestor)
}

/// Whether the path exists, distinguishing "no" from "could not tell".
///
/// `Path::exists()` folds every error into `false`, including a permission
/// failure — which here would turn "this ACL is unreadable" into "nothing to
/// check", the exact inversion a security check must not make.
#[cfg(windows)]
fn exists(path: &Path) -> Result<bool, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetFileAttributesW;

    let wide = wide(path);
    if unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) } != u32::MAX {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
        // ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND.
        Some(2) | Some(3) => Ok(false),
        _ => Err(format!("cannot tell whether {} exists: {err}", path.display())),
    }
}

#[cfg(windows)]
fn is_reparse_point(path: &Path) -> Result<bool, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT};

    let wide = wide(path);
    let attrs = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
    if attrs == u32::MAX {
        return Err(format!(
            "cannot read attributes of {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0)
}

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// Owns the buffer `GetNamedSecurityInfoW` allocates, so it is freed on every
/// path out — including the error paths, which is where a hand-rolled
/// `LocalFree` gets forgotten.
#[cfg(windows)]
struct SecurityDescriptor {
    raw: windows::Win32::Security::PSECURITY_DESCRIPTOR,
    owner: windows::Win32::Security::PSID,
    dacl: *mut windows::Win32::Security::ACL,
}

#[cfg(windows)]
impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{HLOCAL, LocalFree};
        if !self.raw.0.is_null() {
            unsafe {
                let _ = LocalFree(HLOCAL(self.raw.0));
            }
        }
    }
}

#[cfg(windows)]
impl SecurityDescriptor {
    fn read(path: &Path) -> Result<Self, String> {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::ERROR_SUCCESS;
        use windows::Win32::Security::PSID;
        use windows::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
        use windows::Win32::Security::{
            ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        };

        let wide = wide(path);
        let mut owner = PSID::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut raw = PSECURITY_DESCRIPTOR::default();
        let rc = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(wide.as_ptr()),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                Some(&mut owner),
                None,
                Some(&mut dacl),
                None,
                &mut raw,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(format!(
                "cannot read the security descriptor of {} (error {})",
                path.display(),
                rc.0
            ));
        }
        Ok(Self { raw, owner, dacl })
    }

    fn owner_is_admin(&self, path: &Path) -> Result<(), String> {
        if is_privileged_sid(self.owner) {
            return Ok(());
        }
        Err(format!(
            "{} is owned by {}, which is not SYSTEM, Administrators or TrustedInstaller",
            path.display(),
            sid_string(self.owner)
        ))
    }

    fn no_unprivileged_writer(
        &self,
        path: &Path,
        mask: u32,
        is_ancestor: bool,
    ) -> Result<(), String> {
        use windows::Win32::Security::PSID;
        use windows::Win32::Security::{
            AclSizeInformation, GetAce, GetAclInformation, ACCESS_ALLOWED_ACE, ACE_HEADER,
            ACL_SIZE_INFORMATION, INHERIT_ONLY_ACE,
        };

        // A NULL DACL grants EVERYONE full control. It is the most permissive
        // state a securable object can be in, and it reads in most tools as
        // "no permissions set", which is the opposite of what it means.
        if self.dacl.is_null() {
            return Err(format!(
                "{} has a NULL DACL, which grants full control to everyone",
                path.display()
            ));
        }

        let mut info = ACL_SIZE_INFORMATION::default();
        let ok = unsafe {
            GetAclInformation(
                self.dacl,
                &mut info as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        };
        if ok.is_err() {
            return Err(format!("cannot enumerate the ACL of {}", path.display()));
        }

        for i in 0..info.AceCount {
            let mut ace: *mut std::ffi::c_void = std::ptr::null_mut();
            if unsafe { GetAce(self.dacl, i, &mut ace) }.is_err() || ace.is_null() {
                return Err(format!("cannot read ACE {i} of {}", path.display()));
            }
            let header = unsafe { *(ace as *const ACE_HEADER) };

            match header.AceType {
                // ACCESS_ALLOWED_ACE_TYPE: the only type on a file system that
                // grants rights in the layout below.
                0 => {}
                // Deny, audit, alarm, mandatory label, resource attribute and
                // scoped policy ACEs cannot grant access, so they are safely
                // ignored.
                1 | 2 | 3 | 6 | 7 | 8 | 10 | 12 | 13 | 17 | 18 | 19 => continue,
                // Anything else may grant through a layout this code does not
                // parse. Refusing is the only honest answer: silently skipping
                // an ACE type we cannot read would make the check report "safe"
                // precisely when it understood the least.
                other => {
                    return Err(format!(
                        "{} carries an ACE of type {other}, which this check cannot evaluate",
                        path.display()
                    ))
                }
            }

            let allowed = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
            if allowed.Mask & mask == 0 {
                continue;
            }

            // An inherit-only ACE grants nothing on the object carrying it, but
            // everything it describes to children created inside it.
            //
            // On an ancestor that is fine and must be tolerated: `C:\` ships
            // with an inherit-only `CREATOR OWNER:(F)` on every Windows
            // install, and it says nothing about who can touch `Program Files`,
            // which has its own protected ACL.
            //
            // On the install directory itself it is NOT fine — the binaries get
            // created inside it and would inherit exactly that grant, so a
            // user-writable file arrives looking like it was placed correctly.
            if is_ancestor && header.AceFlags as u32 & INHERIT_ONLY_ACE.0 != 0 {
                continue;
            }

            // `SidStart` is the first u32 of a SID laid out inline at the end of
            // the ACE; its address is the PSID.
            let sid = PSID(&allowed.SidStart as *const u32 as *mut std::ffi::c_void);
            if is_privileged_sid(sid) {
                continue;
            }
            return Err(format!(
                "{} grants write access (mask {:#x}) to {}, which is not SYSTEM, \
                 Administrators or TrustedInstaller",
                path.display(),
                allowed.Mask & mask,
                sid_string(sid)
            ));
        }
        Ok(())
    }
}

/// SYSTEM, Administrators or TrustedInstaller — compared as SIDs, never as text.
#[cfg(windows)]
fn is_privileged_sid(sid: windows::Win32::Security::PSID) -> bool {
    use windows::Win32::Security::PSID;
    use windows::Win32::Security::Authorization::ConvertStringSidToSidW;
    use windows::Win32::Security::{
        CreateWellKnownSid, EqualSid, IsValidSid, WinBuiltinAdministratorsSid, WinLocalSystemSid,
        WELL_KNOWN_SID_TYPE,
    };

    if sid.0.is_null() || unsafe { !IsValidSid(sid).as_bool() } {
        return false;
    }

    let well_known = |kind: WELL_KNOWN_SID_TYPE| -> bool {
        // SECURITY_MAX_SID_SIZE. A fixed buffer rather than the two-call
        // pattern: the size is a documented constant and every SID here is far
        // below it.
        let mut buf = [0u8; 68];
        let mut len = buf.len() as u32;
        let built = PSID(buf.as_mut_ptr() as *mut std::ffi::c_void);
        unsafe {
            CreateWellKnownSid(kind, PSID::default(), built, &mut len).is_ok()
                && EqualSid(sid, built).is_ok()
        }
    };

    if well_known(WinLocalSystemSid) || well_known(WinBuiltinAdministratorsSid) {
        return true;
    }

    // TrustedInstaller has no WELL_KNOWN_SID_TYPE, so it is built from its
    // fixed textual form ONCE and then compared as a SID like the others — the
    // string never takes part in the comparison itself.
    let wide: Vec<u16> = TRUSTED_INSTALLER.encode_utf16().chain(std::iter::once(0)).collect();
    let mut ti = PSID::default();
    unsafe {
        if ConvertStringSidToSidW(windows::core::PCWSTR(wide.as_ptr()), &mut ti).is_ok() {
            let equal = EqualSid(sid, ti).is_ok();
            let _ = windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(ti.0));
            return equal;
        }
    }
    false
}

/// A SID as `S-1-5-...`, for the refusal message only.
#[cfg(windows)]
fn sid_string(sid: windows::Win32::Security::PSID) -> String {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;

    let mut out = windows::core::PWSTR::null();
    unsafe {
        if ConvertSidToStringSidW(sid, &mut out).is_err() || out.is_null() {
            return "<unreadable SID>".into();
        }
        let s = out.to_string().unwrap_or_else(|_| "<unprintable SID>".into());
        let _ = LocalFree(HLOCAL(out.0 as *mut std::ffi::c_void));
        s
    }
}

#[cfg(not(windows))]
pub fn path_is_admin_only(_path: &Path) -> Result<(), String> {
    Err("install-path verification is implemented for Windows only".into())
}

/// Where the service and agent binaries are installed.
///
/// `%ProgramFiles%` from the environment rather than hardcoded `C:\Program
/// Files`, because it moves on non-English installs — and then verified by
/// [`path_is_admin_only`] anyway, so a hostile `ProgramFiles` variable buys
/// nothing: the check is on the resolved path's real ACL, not on its name.
pub fn install_dir() -> Result<PathBuf, String> {
    let base = std::env::var("ProgramFiles")
        .map_err(|_| "ProgramFiles is not set in the environment".to_string())?;
    Ok(Path::new(&base).join("Sovereign").join("service"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where the binaries actually go. Its ancestors exist on every Windows
    /// machine; the directory itself does not until an elevated install runs.
    #[cfg(windows)]
    fn target() -> PathBuf {
        install_dir().expect("ProgramFiles")
    }

    #[cfg(windows)]
    #[test]
    fn the_real_install_ancestry_passes() {
        // THE POSITIVE CONTROL, and the more important half of every pair here.
        // A check that refuses everything is trivially "secure" and completely
        // useless, and it would not be discovered until the install it blocks.
        //
        // This is the exact question the install asks before it creates
        // anything: are `C:\Program Files` and `C:\` safe to build inside?
        ancestors_are_admin_only(&target())
            .expect("%ProgramFiles% and the drive root must pass on a healthy Windows install");
    }

    #[cfg(windows)]
    #[test]
    fn the_drive_root_passes_despite_its_user_grants() {
        // Pinned separately because it is the case that makes ANCESTOR_RIGHTS
        // narrower than WRITE_RIGHTS, and someone will eventually be tempted to
        // "tighten" the two into one. A stock `C:\` grants BUILTIN\Users
        // FILE_ADD_SUBDIRECTORY and carries an inherit-only CREATOR OWNER full
        // control. Neither lets anyone touch `Program Files`, and demanding the
        // strict mask here would refuse every Windows install in existence.
        ancestors_are_admin_only(Path::new(r"C:\Program Files\Puca"))
            .expect("the drive root must not fail the ancestor check");
    }

    #[cfg(windows)]
    #[test]
    fn inherit_only_creator_owner_is_refused_on_the_target_itself() {
        // The other side of that split, and the reason it is a split rather
        // than a blanket loosening.
        //
        // `C:\Program Files` carries `CREATOR OWNER:(OI)(CI)(IO)(F)`. As an
        // ancestor that is ignored — it grants nothing on the directory itself.
        // As a TARGET it must be refused: binaries created inside would inherit
        // full control for whoever created them, so a file placed by a
        // non-administrator would arrive owned and writable by them while
        // looking correctly installed.
        //
        // This is also why the install must create its directory with a
        // PROTECTED DACL rather than letting it inherit one.
        let dir = std::env::var("ProgramFiles").expect("ProgramFiles");
        let err = path_is_admin_only(Path::new(&dir))
            .expect_err("an inheritable CREATOR OWNER grant must not pass the target check");
        assert!(
            err.contains("S-1-3-0"),
            "the refusal must name CREATOR OWNER as the offending trustee: {err}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_user_writable_directory_is_refused_as_a_target() {
        // The negative control, against a directory this test just created as
        // the current user — user-writable by construction rather than by
        // assumption about any particular machine.
        let dir = std::env::temp_dir().join("sovereign-path-guard-target");
        std::fs::create_dir_all(&dir).expect("create the test directory");
        let err = path_is_admin_only(&dir).expect_err("a user's temp dir must be refused");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            err.contains("grants write access") || err.contains("owned by"),
            "the refusal must name what is wrong: {err}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_user_writable_ancestor_is_refused() {
        // The case the ancestor walk exists for: the leaf could have a perfect
        // ACL and still be replaceable wholesale, because its parent is not.
        // The child deliberately does not exist — only the ancestry is read.
        let parent = std::env::temp_dir().join("sovereign-path-guard-parent");
        std::fs::create_dir_all(&parent).expect("create the test directory");
        let err = ancestors_are_admin_only(&parent.join("service"))
            .expect_err("a user-writable parent must be refused");
        let _ = std::fs::remove_dir_all(&parent);
        assert!(err.contains("sovereign-path-guard-parent"), "must name the offending path: {err}");
    }

    #[cfg(windows)]
    #[test]
    fn a_relative_path_is_refused_before_anything_else() {
        // Relative paths cannot be reasoned about: they resolve against a
        // working directory the caller controls.
        let err = ancestors_are_admin_only(Path::new(r"service\puca-service.exe"))
            .expect_err("a relative path must be refused");
        assert!(err.contains("absolute"), "{err}");
    }

    #[test]
    fn the_install_directory_is_under_program_files() {
        let dir = install_dir().expect("ProgramFiles is set on any Windows machine");
        assert!(
            dir.ends_with(r"Sovereign\service") || dir.ends_with("Sovereign/service"),
            "{dir:?}"
        );
    }
}
