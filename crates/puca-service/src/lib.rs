//! The Puca unattended-access service — decision logic and launch layer.
//!
//! This crate is the Phase 8 SYSTEM service. It is split so the parts that can
//! be reasoned about and tested WITHOUT installing anything are separate from
//! the Windows integration that can only be exercised once installed:
//!
//!   * [`supervisor`] — pure agent-lifecycle state machine (no OS calls).
//!   * `launch` (Windows only) — the token dance that starts an agent as SYSTEM
//!     in the interactive session, or as the logged-in user. Factored from the
//!     S5 spike, which proved it live.
//!
//! The service binary (`service.rs`) and the install helper are added on top;
//! they are the only pieces that touch the Service Control Manager and thus the
//! only ones that require an elevated install to run.

pub mod control;
pub mod launch_id;
pub mod dll_search;
pub mod path_guard;
#[cfg(windows)]
pub mod caller;
#[cfg(windows)]
pub mod provision;
#[cfg(windows)]
pub mod secrets;
#[cfg(windows)]
pub mod agent_client;
#[cfg(windows)]
pub mod relay;
#[cfg(windows)]
pub mod arming;
#[cfg(windows)]
pub mod enrol;
#[cfg(windows)]
pub mod peer_keys;
#[cfg(windows)]
pub mod link;
/// Raising Ctrl+Alt+Del, which only a LocalSystem process can do.
#[cfg(windows)]
pub mod sas;
/// Portable: no cfg(windows), so the cross-compile guard still covers it.
pub mod log;
pub mod lan;
pub mod wol;
pub mod restart;
pub mod supervisor;

#[cfg(windows)]
pub mod control_pipe;

#[cfg(windows)]
pub mod launch;

#[cfg(windows)]
pub mod wts;

#[cfg(windows)]
pub mod install;

/// The service key name. Shared by the SCM registration, the control handler,
/// and the install/uninstall helper so the three cannot disagree.
///
/// FROZEN. This is the key an already-installed service is registered under;
/// changing it does not rename anything, it just stops finding the service that
/// is there.
pub const SERVICE_NAME: &str = "SovereignRemote";

/// Human-readable name shown in services.msc. Cosmetic — safe to change.
pub const SERVICE_DISPLAY_NAME: &str = "Puca Remote Access";

/// Filenames of the binaries INSIDE the install directory.
///
/// FROZEN, for the same reason as [`SERVICE_NAME`] and the install directory
/// (`%ProgramFiles%\Sovereign\service`, see `path_guard::install_dir`): they are
/// persisted identity, not branding. Nobody sees them.
///
/// What breaks if they change: an existing installation is registered with the
/// SCM under an ImagePath naming the file on disk. `update_binaries` would
/// write the new binaries under the NEW name, leave the old ones in place, and
/// restart the service — which the SCM launches from the OLD path. The machine
/// then runs a new app against a stale service permanently, with every step
/// reporting success. That is precisely the failure `update_binaries` was
/// written to fix, and it is invisible: the update says it worked, the service
/// is running, and only a field that never arrives reveals it.
///
/// The service also resolves the agent as its own sibling by this name, so the
/// same stale-pair problem applies to remote control as a whole.
///
/// These are the DESTINATION names. The sidecars shipped inside the app bundle
/// are named after the current product (`binaries/puca-agent` in
/// tauri.conf.json) and are free to change — they are fresh files from the
/// installer that nothing has persisted a reference to.
pub const INSTALLED_SERVICE_EXE: &str = "sovereign-service.exe";
/// See [`INSTALLED_SERVICE_EXE`].
pub const INSTALLED_AGENT_EXE: &str = "sovereign-agent.exe";

/// The environment variable a launcher hands the agent's launch token in.
///
/// NOT THE COMMAND LINE, which is where it used to go. Full command lines are
/// captured by Sysmon/EDR process-create events and by Windows 4688 auditing
/// wherever that is enabled, and those records travel off the box — so the
/// secret that authorises driving this machine's input and screen was being
/// copied into a log the machine's owner does not control. An environment
/// block is not recorded by process-create auditing by default.
///
/// Be honest about what this does NOT buy: an administrator who can open the
/// process can still read its environment. That party can generally already
/// open the agent's pipe, which is the thing the token protects, so the
/// exposure this removes is the LOGGING one specifically.
///
/// TWO OTHER PLACES SPELL THIS STRING. `frontend/src-tauri/src/agent_ipc.rs`
/// uses this constant directly; `crates/puca-agent/src/main.rs` cannot (it does
/// not depend on this crate) and carries its own copy, pinned by a test there
/// that names this one. A mismatch is loud rather than silent — the agent finds
/// no token, says `--token` is required and exits 2, and the service's restart
/// policy logs the give-up — but it is still a mismatch, so change both.
pub const AGENT_TOKEN_ENV: &str = "PUCA_AGENT_TOKEN";

#[cfg(test)]
mod frozen_identity {
    /// Change-detector. These three strings are what an already-installed
    /// machine is addressed by; editing one orphans every existing install,
    /// so it must be a deliberate act with a migration behind it, not a
    /// side effect of a rename sweep.
    #[test]
    fn installed_identity_is_unchanged() {
        assert_eq!(super::SERVICE_NAME, "SovereignRemote");
        assert_eq!(super::INSTALLED_SERVICE_EXE, "sovereign-service.exe");
        assert_eq!(super::INSTALLED_AGENT_EXE, "sovereign-agent.exe");
    }

    /// The launch-token env var name, pinned on this side of the handoff.
    ///
    /// `crates/puca-agent/src/main.rs` carries the same literal and pins it
    /// with the mirror of this test, because the agent does not depend on this
    /// crate and cannot share the constant. Neither test can see the other's
    /// copy — what they buy is that a rename sweep has to change two things it
    /// was told about rather than one it was not.
    #[test]
    fn the_launch_token_env_name_is_unchanged() {
        assert_eq!(super::AGENT_TOKEN_ENV, "PUCA_AGENT_TOKEN");
    }
}

pub use restart::{RestartDecision, RestartPolicy};
pub use supervisor::{Action, AgentFlavour, SessionEvent, Supervisor};
