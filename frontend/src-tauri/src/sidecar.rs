//! The agent sidecar beside the app: where it is, and whether THIS build is
//! supposed to have one.
//!
//! Three callers look for `puca-agent.exe` next to `Puca.exe` — the
//! remote-control pipe (agent_ipc), the elevated service installer
//! (service_cmd) and the clip capture (clip_capture) — and until 2026-09-16
//! each did the lookup itself, three copies of four lines that would drift the
//! first time one changed. This is the one lookup. It says nothing about the
//! agent's LIFETIME: each caller keeps its own, and the clip capture in
//! particular must never start, stop or restart an attended session.
//!
//! WHY "EXPECTED" IS A QUESTION AT ALL. A Full build bundles the agent
//! (`bundle.externalBin` in tauri.conf.json; Tauri hard-fails the build if a
//! listed binary is not staged). A Lite build (`--no-default-features`, no
//! `remote-control` feature) deliberately ships none — Lite's identity is
//! having no remote control, and the agent contains input injection and the
//! pipe server, so it is not a "capture-only helper" that could ride along.
//! A dev run (`tauri dev`) has nothing staged beside the debug binary either.
//! So "no agent here" is normal for Lite and for dev, and a real fault only in
//! a Full RELEASE build — where, until now, it was logged at INFO and the user
//! saw the in-process capture's DXGI error with no hint that a reinstall
//! would fix it.

use std::path::PathBuf;

/// `puca-agent.exe` (Windows) / `puca-agent` beside the running executable,
/// if it is there.
///
/// Consumers: the Windows-only clip capture, and the feature-gated
/// remote-control modules on every OS — so a Lite build on Linux has none,
/// and says so with an `allow` rather than a warning nobody reads.
#[cfg_attr(not(any(windows, feature = "remote-control")), allow(dead_code))]
pub fn agent_exe_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join(if cfg!(windows) { "puca-agent.exe" } else { "puca-agent" });
    candidate.exists().then_some(candidate)
}

/// Does this BUILD ship the agent? True only for a Full build compiled for
/// release: `remote-control` is the default feature, Lite builds with it off,
/// and `debug_assertions` marks a dev run (`tauri dev`, `cargo test`), which
/// never has a sidecar staged and must not be flagged.
#[cfg_attr(not(windows), allow(dead_code))] // read by the Windows-only clip capture
pub const fn agent_expected_in_this_build() -> bool {
    cfg!(feature = "remote-control") && !cfg!(debug_assertions)
}

/// The sentence a user sees when a build that ships the agent cannot find it.
/// The same words `agent_ipc::agent_diagnose` uses, so the remote-control
/// diagnostic and a failed clip say one thing.
#[cfg_attr(not(windows), allow(dead_code))] // read by the Windows-only clip capture
pub const MISSING_AGENT: &str =
    "No capture agent is installed next to the app. Reinstall Púca and restart it.";

/// Prefix a capture failure with the actionable cause when the agent is
/// missing from a build that ships it; otherwise hand the failure back
/// untouched. Pure, so the two shapes are pinned by tests rather than by a
/// release build with the binary deleted.
///
/// `expected` is `agent_expected_in_this_build()` at the call site; it is a
/// parameter so the release-build branch can be exercised from a test build.
#[cfg_attr(not(windows), allow(dead_code))] // read by the Windows-only clip capture
pub fn explain_missing_agent(error: String, expected: bool) -> String {
    if expected {
        format!("{MISSING_AGENT} Meanwhile the built-in capture failed: {error}")
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_release_build_names_the_missing_agent_and_keeps_the_original_error() {
        let out = explain_missing_agent("Failed to start screen capture: 0x887A0004".into(), true);
        assert!(out.starts_with(MISSING_AGENT), "{out}");
        assert!(out.contains("Reinstall Púca"), "{out}");
        assert!(out.ends_with("0x887A0004"), "the DXGI code must survive: {out}");
    }

    #[test]
    fn lite_and_dev_builds_pass_the_error_through_untouched() {
        // Lite has no sidecar by design and in-process is its only path; a
        // non-pinned Lite user must keep clips and must not be told to
        // reinstall for a component their build never had.
        let e = "Failed to start screen capture: 0x887A0004".to_string();
        assert_eq!(explain_missing_agent(e.clone(), false), e);
    }

    #[test]
    fn a_test_build_is_a_dev_build_and_is_never_flagged() {
        // debug_assertions is on under `cargo test`; if this ever reads true
        // here, dev runs would start telling developers to reinstall.
        assert!(!agent_expected_in_this_build());
    }

    #[test]
    fn the_wording_matches_the_remote_control_diagnostic() {
        // agent_ipc::agent_diagnose opens with the same two sentences; a user
        // who has seen one should recognise the other.
        assert!(MISSING_AGENT.starts_with("No capture agent is installed next to the app."));
    }
}
