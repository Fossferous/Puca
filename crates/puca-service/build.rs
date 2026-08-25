//! Stamp Windows VERSIONINFO onto `puca-service.exe`.
//!
//! The sibling of `crates/puca-agent/build.rs`; read that file's header for
//! the full reasoning. The short version: measured 2026-08-17, this binary
//! shipped with an entirely empty version resource, and Defender's ML classifier
//! flagged the 0.8.82 build as `Trojan:Win32/Bearfoos.B!ml`.
//!
//! It matters MORE here than for the agent. This binary is the one that registers
//! a LocalSystem auto-start service (`src/install.rs`), so its name is what a user
//! sees in services.msc, in Task Manager's Details tab, and in every autoruns-style
//! tool — for ever, on every boot. An anonymous SYSTEM service with a blank
//! publisher and no description is indistinguishable from a persistence implant at
//! a glance, and "looks entirely legitimate in every tool that lists services" is
//! precisely the property `install.rs` already warns about in its own comments.
//! Naming it honestly is the difference between a user finding a service they can
//! identify and one they cannot.
//!
//! Note the crate's own version is 0.1.0, an even more misleading fossil than the
//! agent's — see the VERSION TRAP note in the agent's build.rs. The live version
//! arrives via `PUCA_VERSION` from frontend/scripts/build-agent.mjs.

fn main() {
    println!("cargo:rerun-if-env-changed=PUCA_VERSION");

    #[cfg(windows)]
    stamp();
}

/// `cfg(windows)` is the HOST, matching the build-dependency gate in Cargo.toml.
/// The TARGET is checked separately: this crate deliberately still builds on
/// non-Windows (the supervisor state machine is pure and portable, and its tests
/// run there), so a cross build must not try to embed a Windows resource.
#[cfg(windows)]
fn stamp() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let version = resolve_version();
    let packed = pack_version(&version);

    let mut res = tauri_winres::WindowsResource::new();
    res.set("ProductName", "Puca")
        .set("CompanyName", "Puca")
        // This string is what shows up beside the service in Task Manager. It
        // should let someone who found it while hunting for malware decide
        // correctly, which means naming the privilege rather than hiding it.
        .set(
            "FileDescription",
            "Puca unattended access service (opt-in remote device control)",
        )
        .set("LegalCopyright", "Copyright (c) 2026 Fossferous. Licensed AGPL-3.0-or-later.")
        .set("InternalName", "puca-service")
        .set("OriginalFilename", "puca-service.exe")
        .set("FileVersion", &version)
        .set("ProductVersion", &version);

    res.set_version_info(tauri_winres::VersionInfo::FILEVERSION, packed);
    res.set_version_info(tauri_winres::VersionInfo::PRODUCTVERSION, packed);

    if let Err(e) = res.compile() {
        panic!("failed to embed Windows VERSIONINFO into puca-service: {e}");
    }
}

/// The real version, or a NOISY fallback — see the agent's build.rs.
#[cfg(windows)]
fn resolve_version() -> String {
    match std::env::var("PUCA_VERSION") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => {
            let fossil = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());
            println!(
                "cargo:warning=PUCA_VERSION not set; stamping the FOSSIL crate version \
                 {fossil} into puca-service.exe. Release builds must go through \
                 frontend/scripts/build-agent.mjs, which reads tauri.conf.json."
            );
            fossil
        }
    }
}

/// Pack `major.minor.patch` into tauri-winres' u64 layout. See the agent's
/// build.rs for why unparseable components degrade to 0 rather than panicking.
#[cfg(windows)]
fn pack_version(version: &str) -> u64 {
    let mut parts = version
        .split(['.', '-', '+'])
        .map(|p| p.parse::<u64>().unwrap_or(0));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    (major << 48) | (minor << 32) | (patch << 16)
}
