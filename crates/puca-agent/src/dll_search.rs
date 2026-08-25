//! Take the application directory out of the DLL search path.
//!
//! The reasoning is written out in full in `puca-service/src/dll_search.rs`
//! and is not repeated here. The short version: Windows searches the .exe's own
//! directory before System32, so a DLL dropped beside this binary runs inside
//! this process — and when the service starts this binary, this process is
//! LocalSystem.
//!
//! This crate carries its own copy rather than importing one because the agent
//! and the service share no dependency and adding an edge between them to move
//! five lines would be the larger change. The one line that matters is the flag
//! below; it must stay `SYSTEM32`-only, and widening it is the whole regression.
//!
//! The agent needs this more than the service does: the service loads almost
//! nothing after start, while the agent lazily pulls in Media Foundation, D3D11,
//! DXGI and the encoder's codec DLLs on the first capture — all of them by bare
//! name, all of them after `main`.

/// Returns false if the OS refused, which is reportable but not fatal.
#[cfg(windows)]
pub fn harden() -> bool {
    use windows::Win32::System::LibraryLoader::{
        SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32).is_ok() }
}

#[cfg(not(windows))]
pub fn harden() -> bool {
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn hardening_succeeds_on_the_machines_we_ship_to() {
        // Present since Windows 8: a refusal means something is wrong with the
        // process, not the OS. Asserting the result is what stops this becoming
        // a call nobody notices has stopped working.
        assert!(super::harden());
    }
}
