//! Take the application directory out of the DLL search path.
//!
//! Windows resolves a `LoadLibrary` of a bare name by looking in the directory
//! the .exe was loaded from before it looks in System32. For a process running
//! as the signed-in user that is unremarkable — anyone who can write next to
//! the binary is that user already. For a process running as LocalSystem it is
//! a local privilege escalation with no exploit in it: drop `dxgi.dll` beside
//! `puca-agent.exe`, wait for the service to start the agent, and the
//! code in that file runs as SYSTEM.
//!
//! That is not hypothetical here. Both candidate install locations were checked
//! on this machine and both are writable by `BUILTIN\Users`, which is what
//! makes the install-to-ProgramFiles step of this work load-bearing rather than
//! tidy. This call is the second half of that: the directory stops being
//! writable AND stops being searched, so neither fix alone has to be perfect.
//!
//! `LOAD_LIBRARY_SEARCH_SYSTEM32` narrows the default path for every subsequent
//! `LoadLibrary` to System32 only. It cannot affect the statically-linked
//! imports resolved before `main`. That sentence used to continue "those come
//! from KnownDLLs and are not redirectable", which is false for this binary:
//! six of its twelve static imports (bcrypt, bcryptprimitives, crypt32,
//! secur32, iphlpapi, wtsapi32) are not KnownDLLs. That window is closed by
//! `/DEPENDENTLOADFLAG:0x800` in build.rs, which applies the same System32-only
//! rule to the loader's resolution of the import table, pinned by
//! tests/dependent_load_flags.rs. This call covers everything loaded after it.
//!
//! Call it as the FIRST statement of `main`. Anything above it gets the old
//! search order, and "first" is the only version of that rule which survives
//! someone adding a line later.

/// Returns false if the OS refused, which is reportable but not fatal: the
/// process is no worse off than every build before this one.
#[cfg(windows)]
pub fn harden() -> bool {
    use windows::Win32::System::LibraryLoader::{
        SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32).is_ok() }
}

#[cfg(not(windows))]
pub fn harden() -> bool {
    // Nothing to do: this is a Windows DLL-search-order problem and other
    // platforms do not have the application directory on the library path.
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn hardening_succeeds_on_the_machines_we_ship_to() {
        // SetDefaultDllDirectories has been present since Windows 8, so a
        // refusal here means something is wrong with the process, not with the
        // OS version. Asserting it rather than ignoring the result is what
        // stops this becoming a call nobody notices has stopped working.
        assert!(super::harden());
    }
}
