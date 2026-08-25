//! The per-launch token and pipe name the service gives its agent.
//!
//! WHAT THIS REPLACED, AND WHY THAT MATTERS. This was `handoff.rs`, which did
//! the same two things and then PUBLISHED the result: it wrote the token, in
//! cleartext, to `%ProgramData%\Sovereign\agent-session-N.json` so the desktop
//! app could read it and connect to a service-launched agent.
//!
//! Two things were wrong with that, and only one of them was the directory.
//!
//! The directory was the smaller problem, though it was real: `%ProgramData%\
//! Puca` grants `BUILTIN\Users:(WD,AD,WEA,WA)` and `CREATOR OWNER:(F)` on
//! this machine — checked, not assumed. `WD` on a directory is FILE_ADD_FILE.
//! So every local user could read the token that authorises driving an agent,
//! and the old module's own comment asserted the opposite ("SYSTEM-writable"),
//! which is how a wrong belief survives review.
//!
//! The larger problem is that publishing had no purpose. It existed to hand a
//! USER-flavour agent to the app, and there is no longer a user flavour: the
//! service runs an agent only when nobody is signed in or the machine is
//! locked, and that agent is SYSTEM, whose pipe the app cannot open by design.
//! The token was being written to disk for a reader that could never use it.
//!
//! So the token is still generated per launch and still required by the agent
//! — it costs nothing and means knowing a pipe name is not sufficient — but it
//! now exists only in the service's memory and on the child's command line,
//! and is gone when that process is.

/// 32 bytes of OS randomness, hex-encoded.
///
/// From the OS RNG rather than anything derived: two agents started in the
/// same millisecond (a fast-user-switch) must not share a secret.
const TOKEN_BYTES: usize = 32;

pub fn generate_token() -> Result<String, String> {
    let mut buf = [0u8; TOKEN_BYTES];
    getrandom::getrandom(&mut buf).map_err(|e| format!("system RNG unavailable: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// The pipe name for a session's agent.
///
/// Per-session rather than fixed: a fast-user-switch can have an outgoing agent
/// still shutting down while its replacement starts, and two agents on one pipe
/// name is a race whose loser silently fails to accept connections.
pub fn pipe_name(session: u32) -> String {
    format!(r"\\.\pipe\sovereign-agent-{session}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_long_and_never_repeat() {
        let a = generate_token().expect("RNG");
        let b = generate_token().expect("RNG");
        assert_eq!(a.len(), TOKEN_BYTES * 2, "hex of 32 bytes");
        assert_ne!(a, b, "two launches must not share a secret");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn pipe_names_are_per_session() {
        // A fast-user-switch overlaps an outgoing agent with its replacement;
        // one name for both is a race whose loser never accepts a connection.
        assert_ne!(pipe_name(1), pipe_name(2));
        assert!(pipe_name(1).starts_with(r"\\.\pipe\"));
    }
}
