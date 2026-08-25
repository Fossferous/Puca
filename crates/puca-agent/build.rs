//! Stamp Windows VERSIONINFO onto `puca-agent.exe`.
//!
//! WHY THIS EXISTS. Measured 2026-08-17: the shipped `puca-agent.exe` and
//! `puca-service.exe` carried NO version resource at all — no ProductName,
//! no CompanyName, no FileDescription, not even a FileVersion. `app.exe` beside
//! them has all four, because tauri-build stamps it.
//!
//! That matters because this binary does the most alarming things in the bundle:
//! DXGI capture with no on-screen indicator, SendInput, and autonomous WebRTC
//! egress. Defender's ML classifier flagged the 0.8.82 build as
//! `Trojan:Win32/Bearfoos.B!ml` on a user's machine. An unsigned binary that also
//! refuses to say what it is scores worse than an unsigned one that does; a
//! nameless process in Task Manager is exactly what a user hunting for malware is
//! taught to be suspicious of, and they would be right to be.
//!
//! This does NOT make the binary trusted — only a code-signing certificate does
//! that, and that was deliberately declined (see docs/DEVICES_HANDOFF.md). It
//! removes one gratuitous reason to distrust it, and it costs nothing at runtime:
//! VERSIONINFO is inert data in the PE resource section that is never executed.
//!
//! THE VERSION TRAP. `WindowsResource::new()` defaults FileVersion and
//! ProductVersion to `CARGO_PKG_VERSION`, which for this crate is the FOSSIL
//! 0.8.21 — the frozen number in the root Cargo.toml that nothing reads. The one
//! live version lives in `frontend/src-tauri/tauri.conf.json`. Stamping the fossil
//! would create exactly the second-version-reader problem that has bitten this
//! repo before (android/app/build.gradle), and it would be worse than no version
//! at all: a confident wrong answer. So `frontend/scripts/build-agent.mjs` reads
//! tauri.conf.json and passes the real version in `PUCA_VERSION`, and both
//! the string properties AND the packed numeric FILEVERSION are overridden from
//! it. Overriding only the strings leaves the numeric field disagreeing with
//! them, which different tools surface differently.

fn main() {
    println!("cargo:rerun-if-env-changed=PUCA_VERSION");

    #[cfg(windows)]
    stamp();
}

/// `cfg(windows)` here is the HOST, which is what gates the build-dependency in
/// Cargo.toml too, so the two agree. The TARGET is checked separately below —
/// non-Windows builds of this crate exist as the cross-compile guard and must
/// keep working.
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
        // Say plainly what it does. A vague description would be the same
        // evasion the honest version is meant to avoid, and anyone reading this
        // field is entitled to a straight answer.
        .set(
            "FileDescription",
            "Puca remote access host agent (screen capture and input)",
        )
        .set("LegalCopyright", "Copyright (c) 2026 Fossferous. Licensed AGPL-3.0-or-later.")
        .set("InternalName", "puca-agent")
        .set("OriginalFilename", "puca-agent.exe")
        .set("FileVersion", &version)
        .set("ProductVersion", &version);

    res.set_version_info(tauri_winres::VersionInfo::FILEVERSION, packed);
    res.set_version_info(tauri_winres::VersionInfo::PRODUCTVERSION, packed);

    if let Err(e) = res.compile() {
        // Fail loudly. A silently unstamped binary is the state this file exists
        // to end, and it would ship looking identical to a stamped one.
        panic!("failed to embed Windows VERSIONINFO into puca-agent: {e}");
    }
}

/// The real version, or a NOISY fallback.
///
/// The fallback keeps a bare `cargo build` working for development, but it warns,
/// because a release that reached here without `PUCA_VERSION` would stamp
/// the fossil 0.8.21 onto a shipped binary and nothing downstream would notice.
#[cfg(windows)]
fn resolve_version() -> String {
    match std::env::var("PUCA_VERSION") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => {
            let fossil = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());
            println!(
                "cargo:warning=PUCA_VERSION not set; stamping the FOSSIL crate version \
                 {fossil} into puca-agent.exe. Release builds must go through \
                 frontend/scripts/build-agent.mjs, which reads tauri.conf.json."
            );
            fossil
        }
    }
}

/// Pack `major.minor.patch` into the u64 layout tauri-winres expects
/// (major << 48 | minor << 32 | patch << 16).
///
/// Unparseable components become 0 rather than failing the build: a wrong-looking
/// version is a cosmetic problem, while a release that cannot compile because
/// somebody wrote a pre-release suffix is not.
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
